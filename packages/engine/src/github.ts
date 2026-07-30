// The half of an agent's git work that other people can see: pushing a branch
// and opening a pull request (his items 6 and 7).
//
// HIS DECISION, NOT RE-LITIGATED: branch + pull request, ALWAYS. There is no
// method in this file that puts anything on the default branch, and there is no
// flag that turns one on. A bad run costs him a click to close.
//
// ESTABLISHED BY RUNNING gh 2.92.0 ON THIS MACHINE, not remembered:
//  • `gh auth status` → "Logged in to github.com account vikas53953 (keyring)",
//    "Git operations protocol: https", scopes gist, read:org, repo, workflow.
//    So HTTPS through the keyring is the only route, exactly as recorded — and
//    the `repo` scope is what lets a pull request be opened at all.
//  • `gh repo view --json defaultBranchRef` → this repository's default branch
//    is **master**, not `main`. Nothing here assumes either.
//  • `gh pr create` accepts `--fill` (title and body from the commits),
//    `--body-file` (with `-` meaning standard input), `--head` and `--base`
//    together — checked by running the four of them at once and watching gh get
//    all the way to the GitHub API before failing on a deliberately
//    non-existent repository.
//  • `--head` is documented to "explicitly skip any forking or pushing
//    behavior", so gh never pushes behind our back: the push is ours, it is
//    separate, and it is approved separately.
//  • `gh pr create` prints the new pull request's URL on success.
//
// THE APPROVAL LAW. Every method here changes something outside this computer,
// so every one of them asks first. The gate is CLOSED BY DEFAULT: a
// `GitHubClient` built without an approver refuses everything. There is no
// "just this once" path, and a refusal is an error the agent has to report, not
// a silent no-op.
//
// THE QUOTING LAW is not relaxed either. A pull request's title and body are
// written by an agent, so neither ever becomes an argument: the title rides in
// on the commit subject via `--fill`, and the body goes in on standard input
// via `--body-file -`.
import {
  PROJECT_LIMITS, ProjectItem, REMOTE_ACTIONS, RemoteAction, RemoteActionFacts,
  describeRemoteAction, isBranchName, validateProjectItem, validateRepo,
} from "@cloud9/shared";
import { run, Runner } from "./run.js";
import { GitError, Worktree } from "./worktree.js";

/**
 * The things an agent can do that are visible from outside this machine.
 *
 * ONE TABLE, AND IT IS NOT THIS FILE'S. It moved to `@cloud9/shared` on
 * 2026-07-30 because three programs have to agree about it: the engine does the
 * thing, the hub writes the sentence the owner reads, and the screen draws the
 * card. This is a re-export, and `github.test.ts` asserts object IDENTITY with
 * shared's — two lists that happen to agree today are exactly the drift that
 * check exists to prevent.
 */
export { REMOTE_ACTIONS };
export type { RemoteAction, RemoteActionFacts };

/** The owner has not said yes, so nothing left the machine. */
export class ApprovalRequiredError extends Error {
  constructor(public readonly action: RemoteAction, public readonly detail: string) {
    super(`${REMOTE_ACTIONS[action]} needs your approval first — ${detail}`);
    this.name = "ApprovalRequiredError";
  }
}

/**
 * Asked before ANYTHING leaves this computer.
 *
 * Returning false is a normal answer, not an error condition — the caller turns
 * it into `ApprovalRequiredError` and the agent says so in the conversation.
 *
 * `facts` is the structured version of the same request — the branch, the
 * repository, the number of commits — and it is what a real approver forwards
 * to the hub. The two string arguments are kept because they are what a LOCAL
 * approver (a test, a script, a host with its own prompt) actually needs, and
 * because dropping them would have been a breaking change for no gain.
 */
export type RemoteApprover = (
  action: RemoteAction, detail: string, facts: RemoteActionFacts,
) => Promise<boolean> | boolean;

export interface GitHubOptions {
  runner?: Runner;
  /** the `gh` command — tests point this at a shim */
  command?: string;
  timeoutMs?: number;
  /**
   * Absent means NOTHING may leave this machine. That is the safe default and
   * it is deliberate: a caller that forgets to wire the approval path gets a
   * refusal, not an unattended push.
   */
  approve?: RemoteApprover;
  log?: (message: string) => void;
}

export interface PullRequest {
  url: string;
  branch: string;
  base: string;
}

/**
 * What one look at a repository found — or, honestly, why it found nothing.
 *
 * `items` carries no `projectId`: the engine does not decide which project a
 * pull request belongs to. The hub stamps the project it verified, exactly as
 * it already does for anything else arriving on a frame.
 */
export interface RepositoryLook {
  /** the trunk GitHub reports, only when it is a name we may repeat */
  defaultBranch?: string;
  /** open pull requests and open issues. Absent means we never got a list. */
  items?: Array<Omit<ProjectItem, "projectId">>;
  /** why the look did not work, in words a non-developer can act on */
  problem?: string;
}

/**
 * EVERY `gh` COMMAND THIS FILE'S READ PATH IS ALLOWED TO RUN.
 *
 * A list, not a habit. "Reading a repository can never change it" is a promise
 * that is only worth anything if something enforces it, so `readOnly` refuses
 * anything not on here — `pr create`, `issue close`, `repo delete` cannot be
 * reached from a look even by a future edit that forgets why.
 */
const READ_ONLY_GH: ReadonlySet<string> = new Set([
  "repo view", "pr list", "issue list", "auth status",
]);

/** The columns we ask GitHub for, ONE PER FLAG. */
const PULL_FIELDS = [
  "number", "title", "url", "state", "headRefName", "author", "createdAt", "updatedAt", "isDraft",
] as const;
const ISSUE_FIELDS = [
  "number", "title", "url", "state", "author", "createdAt", "updatedAt",
] as const;

/**
 * `--json a --json b`, never `--json a,b`.
 *
 * THE COMMA IS THE WHOLE POINT. `run.ts` refuses one, on purpose — its
 * allowlist is what stops an agent's text ever reaching a command line — and
 * the last code that wanted several JSON fields wrote `--json number,url` and
 * threw `UnsafeArgumentError` against the real tool for a day, because only a
 * fake runner had ever called it. gh accepts the flag repeated (checked by
 * running gh 2.92.0 on this machine, 2026-07-30), so nothing has to be widened.
 */
function jsonFields(fields: readonly string[]): string[] {
  return fields.flatMap(f => ["--json", f]);
}

/** What `gh auth status` says, in plain words. Never a token, never a scope value. */
export interface GitHubAccount {
  signedIn: boolean;
  /** the login gh reports, e.g. "vikas53953" */
  login?: string;
  /** "https" or "ssh" — this machine has no SSH key, so it is https */
  protocol?: string;
  /** one sentence for a screen */
  detail: string;
}

export class GitHubClient {
  private runner: Runner;
  private command: string;
  private timeoutMs: number;
  private log: (message: string) => void;

  constructor(private opts: GitHubOptions = {}) {
    this.runner = opts.runner ?? run;
    this.command = opts.command ?? "gh";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.log = opts.log ?? ((m: string) => console.log(`[github] ${m}`));
  }

  /**
   * The gate. Every remote method starts here and there is no way past it.
   *
   * It is a method rather than a check copied into each caller so that "did we
   * ask?" has exactly one answer — the same reason `mayDriveAgent` and
   * `mustAskBeforeActing` each live in one place.
   */
  private async mayI(
    action: RemoteAction, gather: () => Promise<RemoteActionFacts>,
  ): Promise<void> {
    const approver = this.opts.approve;
    // FIRST, AND BEFORE ANY COMMAND AT ALL. A client with nobody to ask does
    // not even look at the repository — it refuses. That is what keeps the
    // original promise of this file literally true: with no approver wired,
    // not one command runs.
    if (!approver) throw new ApprovalRequiredError(action, "nobody is set up to approve it");
    // Only now, and only with read-only commands, do we find out WHAT we would
    // be asking about. "Push a branch" cannot be judged; "push 3 commits to a
    // new branch cloud9/architect-1 on vikas53953/cloud9" can.
    const facts = await gather();
    // THE SENTENCE IS COMPOSED, NOT WRITTEN — by shared's `describeRemoteAction`,
    // the same function the hub uses to fill the card. One spelling of "push 3
    // commits to a new branch …", so the log line, the refusal message and the
    // thing he actually reads on screen cannot drift apart.
    const detail = describeRemoteAction(facts);
    let allowed = false;
    try {
      allowed = await approver(action, detail, facts);
    } catch {
      allowed = false;
    }
    if (!allowed) throw new ApprovalRequiredError(action, detail);
    this.log(`approved: ${REMOTE_ACTIONS[action]} — ${detail}`);
  }

  /**
   * WHAT THIS REPOSITORY IS CALLED ON GITHUB. Read only, so it is not gated —
   * and it is asked BEFORE the gate on purpose, because "push a branch" and
   * "push a branch to vikas53953/cloud9" are two very different questions and
   * only the second one can actually be judged.
   *
   * A repository gh cannot name is reported as absent rather than guessed at.
   * The sentence then reads "push 3 commits to a new branch …" with no
   * repository in it, which is honest; inventing one would not be.
   */
  async repoName(wt: Worktree): Promise<string | undefined> {
    const r = await this.runner(this.command, [
      "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner",
    ], { cwd: wt.path, timeoutMs: 60_000 });
    if (r.notFound || r.code !== 0) return undefined;
    const name = r.stdout.trim().split(/\r?\n/)[0]?.trim();
    return name && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(name) ? name : undefined;
  }

  /** How many commits this branch has that its base does not. Read only. */
  async commitsAhead(wt: Worktree): Promise<number | undefined> {
    const r = await this.runner("git", ["rev-list", "--count", `${wt.base}..HEAD`], {
      cwd: wt.path, timeoutMs: 60_000,
    });
    if (r.notFound || r.code !== 0) return undefined;
    const n = Number(r.stdout.trim());
    return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
  }

  /**
   * The facts an approval card is built from, gathered from git and gh rather
   * than from anything an agent said. Nothing here changes anything.
   */
  async factsFor(action: RemoteAction, wt: Worktree): Promise<RemoteActionFacts> {
    const [repo, commits] = await Promise.all([this.repoName(wt), this.commitsAhead(wt)]);
    return {
      action, branch: wt.branch, base: wt.base,
      ...(repo ? { repo } : {}),
      ...(commits !== undefined ? { commits } : {}),
    };
  }

  /**
   * Who this computer is on GitHub. READ ONLY — it asks nothing of GitHub and
   * changes nothing, so it is not behind the gate.
   *
   * gh prints this to stderr, which is why both streams are read (the same
   * lesson `codex login status` taught this project).
   */
  async account(): Promise<GitHubAccount> {
    const r = await this.runner(this.command, ["auth", "status"], { timeoutMs: 30_000 });
    if (r.notFound) {
      return { signedIn: false, detail: "the GitHub command line isn't installed on this computer" };
    }
    const text = `${r.stdout}\n${r.stderr}`;
    if (r.code !== 0) {
      return { signedIn: false, detail: "you're not signed in to GitHub on this computer" };
    }
    const login = /Logged in to \S+ account (\S+)/i.exec(text)?.[1];
    const protocol = /Git operations protocol:\s*(\S+)/i.exec(text)?.[1];
    return {
      signedIn: true,
      ...(login ? { login } : {}),
      ...(protocol ? { protocol } : {}),
      detail: login ? `Signed in to GitHub as ${login}` : "Signed in to GitHub",
    };
  }

  /**
   * Send the agent's branch to GitHub.
   *
   * `-u` sets the upstream so the branch has somewhere to belong; the branch
   * name is one WE generated, so it is allowlist-clean by construction. The
   * folder goes in `cwd`, never in argv.
   */
  async pushBranch(wt: Worktree, extra: { files?: number } = {}): Promise<void> {
    await this.mayI("push", async () => ({
      ...await this.factsFor("push", wt),
      ...(extra.files ? { files: extra.files } : {}),
    }));
    const r = await this.runner("git", ["push", "-u", "origin", wt.branch], {
      cwd: wt.path, timeoutMs: this.timeoutMs,
    });
    if (r.notFound) throw new GitError("push", "git is not installed on this computer");
    if (r.code !== 0) {
      throw new GitError("push", firstLine(r.stderr || r.stdout));
    }
    this.log(`pushed ${wt.branch}`);
  }

  /**
   * Open the pull request. Branch → base, always; there is no other shape.
   *
   * The TITLE comes from the commit subject (`--fill`), because a title an
   * agent wrote must never become a command-line argument. The BODY goes in on
   * standard input. If the caller has no body to add, `--fill` supplies the
   * commit's own body and nothing is written to stdin at all.
   */
  async openPullRequest(wt: Worktree, opts: { body?: string; draft?: boolean } = {}): Promise<PullRequest> {
    await this.mayI("pullRequest", () => this.factsFor("pullRequest", wt));
    const args = ["pr", "create", "--head", wt.branch, "--base", wt.base, "--fill"];
    if (opts.draft) args.push("--draft");
    const body = (opts.body ?? "").trim();
    if (body) args.push("--body-file", "-");

    const r = await this.runner(this.command, args, {
      cwd: wt.path,
      timeoutMs: this.timeoutMs,
      ...(body ? { stdin: body } : {}),
    });
    if (r.notFound) {
      throw new GitError("pr create", "the GitHub command line isn't installed on this computer");
    }
    if (r.code !== 0) {
      throw new GitError("pr create", firstLine(r.stderr || r.stdout));
    }
    const url = findPullRequestUrl(r.stdout) ?? findPullRequestUrl(r.stderr);
    if (!url) throw new GitError("pr create", "GitHub did not say where the pull request is");
    this.log(`opened ${url}`);
    return { url, branch: wt.branch, base: wt.base };
  }

  /**
   * The pull request already open for this branch, if there is one. Read only.
   *
   * FOUND BY RUNNING IT, 2026-07-30: this used to ask for `--json number,url`,
   * and `run.ts` REFUSES a comma — its allowlist is `[A-Za-z0-9._:\/=+@-]`. So
   * against the real runner this method never reached gh at all; it threw
   * `UnsafeArgumentError` every single time, and only a fake runner had ever
   * called it. The fix is not to widen the allowlist — that guard is why an
   * agent's text can never reach a command line — but to stop needing a comma:
   * ask for the URL alone and read the number off it, with the same shape check
   * `findPullRequestUrl` already applies everywhere else.
   */
  async pullRequestFor(wt: Worktree): Promise<{ number: number; url: string } | undefined> {
    const r = await this.runner(this.command, [
      "pr", "list", "--head", wt.branch, "--state", "open", "--json", "url",
    ], { cwd: wt.path, timeoutMs: 60_000 });
    if (r.notFound || r.code !== 0) return undefined;
    const url = findPullRequestUrl(r.stdout);
    if (!url) return undefined;
    const number = Number(/\/pull\/(\d+)$/.exec(url)?.[1]);
    return Number.isSafeInteger(number) ? { number, url } : undefined;
  }

  /**
   * WHAT IS OPEN IN THIS REPOSITORY — the ONE owner of "how we ask GitHub
   * about a repository". The Projects screen, any schedule we ever add, and any
   * agent that wants the same answer all come through here, so there is one
   * spelling of the question and one set of words for every way it can fail.
   *
   * READ ONLY, AND ENFORCED. Three commands, all on `READ_ONLY_GH`, all with
   * `--repo` so nothing depends on which folder we happen to be in. Nothing
   * leaves this machine and nothing on GitHub changes, which is why this method
   * is not behind `mayI` — the approval gate exists for the things that DO
   * change something, and putting a list-reading call behind it would teach
   * everyone that approval cards are noise.
   *
   * IT NEVER THROWS AND IT NEVER RETURNS A STACK TRACE. Every failure comes
   * back as `problem`, in a sentence Vikas can act on, because the screen
   * prints it word for word.
   */
  async lookAtRepository(repo: string): Promise<RepositoryLook> {
    try {
      const badName = validateRepo(repo);
      if (badName) return { problem: badName };

      // Is there a GitHub sign-in on this computer at all? `account()` already
      // owns the sentences for "gh isn't installed" and "you're not signed in",
      // so they are not written a second time here.
      const who = await this.account();
      if (!who.signedIn) {
        return { problem: `${who.detail} — sign in to GitHub on this computer, then look again.` };
      }

      const trunk = await this.readOnly(
        ["repo", "view", repo, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"], repo);
      if ("problem" in trunk) return trunk;
      const branch = firstLine(trunk.stdout);
      // a trunk we could not repeat safely is simply not reported: the hub
      // refuses a name that is not a branch name, and a refused frame would
      // take the pull requests down with it
      const defaultBranch = isBranchName(branch) ? branch : undefined;
      const found = defaultBranch ? { defaultBranch } : {};

      const pulls = await this.readOnly([
        "pr", "list", "--repo", repo, "--state", "open",
        "--limit", String(PROJECT_LIMITS.lookItems), ...jsonFields(PULL_FIELDS),
      ], repo);
      if ("problem" in pulls) return { ...found, problem: pulls.problem };

      const issues = await this.readOnly([
        "issue", "list", "--repo", repo, "--state", "open",
        "--limit", String(PROJECT_LIMITS.lookItems), ...jsonFields(ISSUE_FIELDS),
      ], repo);
      if ("problem" in issues) return { ...found, problem: issues.problem };

      const asPulls = readItems("pull", pulls.stdout);
      if ("problem" in asPulls) return { ...found, problem: asPulls.problem };
      const asIssues = readItems("issue", issues.stdout);
      if ("problem" in asIssues) return { ...found, problem: asIssues.problem };

      return { ...found, items: [...asPulls.items, ...asIssues.items] };
    } catch (err) {
      // belt and braces: a look must never be the reason anything falls over,
      // and the owner must never be shown the inside of a program
      this.log(`could not look at ${repo}: ${err instanceof Error ? err.message : String(err)}`);
      return { problem: "Cloud9 could not ask GitHub about this repository. Try again in a moment." };
    }
  }

  /**
   * Run one gh command that CANNOT change anything, and turn every way it can
   * fail into a sentence.
   *
   * The allowlist is checked here rather than trusted from the caller, so
   * "reading a repository never writes to it" is a property of this method and
   * not of everyone remembering.
   */
  private async readOnly(args: string[], repo: string): Promise<{ stdout: string } | { problem: string }> {
    const verb = `${args[0]} ${args[1]}`;
    if (!READ_ONLY_GH.has(verb)) {
      // not a sentence for the owner — this is a programming mistake, and it is
      // the only path in here that is allowed to be loud
      throw new Error(`refusing to run "gh ${verb}" while looking at a repository: it is not read-only`);
    }
    const r = await this.runner(this.command, args, { timeoutMs: 60_000 });
    if (r.notFound) {
      return { problem: "the GitHub command line (gh) isn't installed on this computer, so nothing can look at GitHub." };
    }
    if (r.timedOut) {
      return { problem: "GitHub did not answer in time. It may be busy, or this computer's connection may be down." };
    }
    if (r.code !== 0) return { problem: whyGitHubSaidNo(`${r.stderr}\n${r.stdout}`, repo) };
    return { stdout: r.stdout };
  }
}

/**
 * ONE PLACE THAT TURNS GH'S COMPLAINT INTO A SENTENCE VIKAS CAN ACT ON.
 *
 * Every one of these was a real failure mode named in the round's brief: not
 * signed in, no such repository (or somebody else's private one), the network
 * down, GitHub rate limiting us. A stack trace or a raw `gh` line is never the
 * answer — the screen prints this verbatim.
 */
export function whyGitHubSaidNo(text: string, repo: string): string {
  const said = String(text ?? "");
  if (/rate limit|secondary rate|abuse detection|429/i.test(said)) {
    return "GitHub is asking us to slow down for a while (it calls this a rate limit). Try again in a few minutes.";
  }
  if (/could not resolve to a (repository|user)|404|not found|does not exist/i.test(said)) {
    return `GitHub has no repository called ${repo} that this computer's sign-in can see. Check the name — and if it is private, the GitHub account signed in here needs to be given access.`;
  }
  if (/gh auth login|not logged (in)?to|authentication|bad credentials|401|403/i.test(said)) {
    return "this computer's GitHub sign-in was refused. Sign in to GitHub again, then look once more.";
  }
  if (/dial tcp|no such host|getaddrinfo|connection refused|network is unreachable|i\/o timeout|TLS handshake|EOF|proxy/i.test(said)) {
    return "this computer could not reach github.com. The network looks down — check the connection and try again.";
  }
  const line = firstLine(said);
  const sentence = line === "no detail given"
    ? "GitHub refused the request and did not say why."
    : `GitHub refused the request: ${line}`;
  // it has to FIT where the hub keeps it, or the hub trims it mid-word and the
  // sentence he reads stops making sense
  return sentence.length <= PROJECT_LIMITS.problem
    ? sentence
    : `${sentence.slice(0, PROJECT_LIMITS.problem - 1).trimEnd()}…`;
}

/**
 * Turn what `gh ... --json` printed into pull requests and issues.
 *
 * IT ARRIVED FROM OUTSIDE, so every row is checked with the hub's OWN
 * `validateProjectItem` before it is kept. A row that does not pass is dropped
 * rather than repaired: one unusable row must never cost the whole list, which
 * is exactly what would happen if the hub refused the frame.
 */
export function readItems(
  kind: "pull" | "issue", stdout: string,
): { items: Array<Omit<ProjectItem, "projectId">> } | { problem: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim() || "[]");
  } catch {
    return { problem: "GitHub's answer could not be read. Try looking again." };
  }
  if (!Array.isArray(raw)) return { problem: "GitHub's answer could not be read. Try looking again." };
  const items: Array<Omit<ProjectItem, "projectId">> = [];
  for (const row of raw as Array<Record<string, unknown>>) {
    const item = readItem(kind, row);
    // the hub's own rule, run here so a bad row costs itself and nothing else
    if (item && !validateProjectItem({ ...item, projectId: "check" })) items.push(item);
  }
  return { items };
}

function readItem(
  kind: "pull" | "issue", row: Record<string, unknown>,
): Omit<ProjectItem, "projectId"> | undefined {
  if (!row || typeof row !== "object") return undefined;
  const number = typeof row.number === "number" ? row.number : NaN;
  const title = typeof row.title === "string" ? row.title.slice(0, PROJECT_LIMITS.itemTitle) : "";
  const url = typeof row.url === "string" ? row.url : "";
  const author = (row.author as { login?: unknown } | undefined)?.login;
  const branch = typeof row.headRefName === "string" ? row.headRefName : undefined;
  const state = readState(kind, row);
  const createdAt = when(row.createdAt);
  const updatedAt = when(row.updatedAt);
  if (!Number.isInteger(number) || !title || !url || createdAt === undefined || updatedAt === undefined) {
    return undefined;
  }
  return {
    kind, number, title, state, url, createdAt, updatedAt,
    ...(typeof author === "string" && author ? { author: author.slice(0, 80) } : {}),
    // a branch name we could not repeat safely is left off rather than shown:
    // the same rule the hub applies to a trunk, for the same reason
    ...(kind === "pull" && isBranchName(branch) ? { branch } : {}),
  };
}

/**
 * MERGED AND CLOSED ARE OPPOSITE OUTCOMES and the screen says so in words, so
 * this must not flatten them. gh shouts its states (`OPEN`, `MERGED`); a draft
 * is an open pull request wearing `isDraft`, and it is drawn as its own thing
 * because a draft is not asking to be reviewed yet.
 */
function readState(kind: "pull" | "issue", row: Record<string, unknown>): ProjectItem["state"] {
  const said = String(row.state ?? "").toLowerCase();
  if (said === "merged") return "merged";
  if (said === "closed") return "closed";
  if (kind === "pull" && row.isDraft === true) return "draft";
  return "open";
}

function when(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/**
 * gh prints the URL of what it made. Pulled out with a pattern rather than "the
 * last line", because gh also prints notices, and a URL is the one thing in
 * that output whose shape we can actually check.
 */
export function findPullRequestUrl(text: string): string | undefined {
  const m = /https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/\d+/.exec(text ?? "");
  return m?.[0];
}

function firstLine(text: string): string {
  return (text.split(/\r?\n/).find(l => l.trim()) ?? "").trim().slice(0, 200) || "no detail given";
}
