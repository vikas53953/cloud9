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
import { run, Runner } from "./run.js";
import { GitError, Worktree } from "./worktree.js";

/**
 * The things an agent can do that are visible from outside this machine.
 *
 * ONE TABLE, so a new remote action cannot be added without appearing in front
 * of the approval gate. Anything not on this list does not leave the computer.
 */
export const REMOTE_ACTIONS = {
  push: "push a branch to GitHub",
  pullRequest: "open a pull request on GitHub",
  createRepo: "create a new repository on GitHub",
} as const;

export type RemoteAction = keyof typeof REMOTE_ACTIONS;

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
 */
export type RemoteApprover = (action: RemoteAction, detail: string) => Promise<boolean> | boolean;

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
  private async mayI(action: RemoteAction, detail: string): Promise<void> {
    const approver = this.opts.approve;
    if (!approver) throw new ApprovalRequiredError(action, "nobody is set up to approve it");
    let allowed = false;
    try {
      allowed = await approver(action, detail);
    } catch {
      allowed = false;
    }
    if (!allowed) throw new ApprovalRequiredError(action, detail);
    this.log(`approved: ${REMOTE_ACTIONS[action]} — ${detail}`);
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
  async pushBranch(wt: Worktree): Promise<void> {
    await this.mayI("push", `branch ${wt.branch}`);
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
    await this.mayI("pullRequest", `${wt.branch} → ${wt.base}`);
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

  /** The pull request already open for this branch, if there is one. Read only. */
  async pullRequestFor(wt: Worktree): Promise<{ number: number; url: string } | undefined> {
    const r = await this.runner(this.command, [
      "pr", "list", "--head", wt.branch, "--state", "open", "--json", "number,url",
    ], { cwd: wt.path, timeoutMs: 60_000 });
    if (r.notFound || r.code !== 0) return undefined;
    try {
      const rows = JSON.parse(r.stdout.trim() || "[]") as { number: number; url: string }[];
      return rows[0];
    } catch {
      return undefined;
    }
  }
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
