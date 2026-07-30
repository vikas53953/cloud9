// AN AGENT DECIDING, BY ITSELF, THAT IT WANTS TO PUSH.
//
// WHAT WAS MISSING. Everything under this was already built and proved: an
// agent can be given its own git worktree (`worktree.ts`), commit in it, and
// `Engine.githubFor` can wire a `GitHubClient` to the approval desk so the push
// asks Vikas first. But NOTHING EVER CALLED IT. `githubFor` had no caller in
// any agent turn, so the whole round trip only happened when a test drove the
// engine directly, and he could never see it. This file is the caller.
//
// HIS DECISION, NOT RE-LITIGATED: branch + pull request, ALWAYS. There is no
// path here that pushes the branch it started from and no flag that adds one.
//
// THE FOUR LAWS THIS FILE EXISTS TO KEEP
//
//  1. THE FACTS ARE OBSERVED, NEVER CLAIMED. What goes on the permission card —
//     the repository, the branch, how many commits, how many files — is read
//     from `git` and `gh` by `github.ts`, from the worktree we made. The agent's
//     own words never become a fact. An agent that writes "just a tiny typo fix"
//     while changing forty files still gets a card that says forty files,
//     because the number is counted, not quoted. The only thing the agent's text
//     decides is WHETHER TO ASK — and asking is the safe direction.
//
//  2. AN AGENT THAT CHANGED NOTHING CANNOT ASK. The ask is gated on real
//     changes in the worktree, so a reply full of `!publish` and no work at all
//     produces no card. A card he cannot act on teaches him to ignore cards.
//
//  3. REFUSAL AND SILENCE ARE DIFFERENT, AND BOTH LEAVE THE MACHINE UNTOUCHED.
//     "He said no" and "nobody answered" come back as different sentences from
//     `ApprovalDesk`, and this file carries whichever it got into the message
//     the agent posts. What it never does is treat one as the other, and it
//     never treats either as "it probably went fine".
//
//  4. NOT ASKING IS A NORMAL ENDING. An agent that works and does not ask keeps
//     its commit on its own branch, on this computer. That is not a failure and
//     is not reported as one; it is the default, and it is what happens unless
//     the agent explicitly says it wants the work published.
//
// PARALLEL WORK IS GIT'S GUARANTEE, NOT OURS. Every turn gets a fresh worktree
// from the ONE `GitWorkspace` that already exists — a new folder and a new
// generated branch per agent per job — so several agents work one repository at
// once and git itself refuses a second checkout of the same branch. No second
// worktree implementation was written for this.
import { AgentDef, ID } from "@cloud9/shared";
import { ApprovalRequiredError, GitHubClient } from "./github.js";
import { GitError, GitWorkspace, Worktree } from "./worktree.js";

/**
 * HOW AN AGENT ASKS. One line, on its own, in the message it writes.
 *
 * A marker rather than "did it sound like it wanted to?" because the difference
 * between working locally and putting code on GitHub must not depend on a mood
 * read out of prose. It is matched at the start of a line and case-insensitively
 * so an agent that shouts it, or puts it last, is still understood.
 */
const PUBLISH_MARKER = /^[ \t>*_-]*!publish\b.*$/gim;

/** Did the agent ask for its branch to go to GitHub? */
export function wantsToPublish(reply: string): boolean {
  PUBLISH_MARKER.lastIndex = 0;
  return PUBLISH_MARKER.test(String(reply ?? ""));
}

/**
 * The reply with the marker taken out, because `!publish` is an instruction to
 * Cloud9, not something the people in the room need to read. Everything else
 * the agent wrote is kept exactly as written.
 *
 * `replace` on a fresh regex: the module-level one carries `lastIndex` between
 * calls, and this project has already lost a night to a shared `/g` regex.
 */
export function withoutPublishMarker(reply: string): string {
  return String(reply ?? "").replace(new RegExp(PUBLISH_MARKER.source, "gim"), "").trim();
}

/** What the turn is told about where it is standing and what it may ask for. */
export function repoBriefing(input: { branch: string; base: string; repo?: string }): string {
  const where = input.repo ? ` of ${input.repo}` : "";
  return (
    `\n\nYou are working inside a git worktree${where} — your own private copy, ` +
    `on your own branch \`${input.branch}\`, branched from \`${input.base}\`. ` +
    `Edit files here freely; nobody else's work can be touched from it.\n` +
    `When your turn ends, Cloud9 commits whatever you changed to your branch, on ` +
    `this computer only.\n` +
    `YOU CANNOT PUSH ANYTHING YOURSELF. If — and only if — you want your work sent ` +
    `to GitHub as a pull request, write !publish on a line of its own in your reply. ` +
    `Cloud9 will then ask your owner for permission, showing what you really ` +
    `changed (the repository, the branch, and how many commits and files — counted ` +
    `from git, not from anything you say). If the owner says no, or nobody answers, ` +
    `nothing leaves this computer and your work stays on your branch.`
  );
}

/** How a repository turn ended. One value; every one of them is a true sentence. */
export type RepoOutcome =
  /** the agent changed nothing, so there was nothing to commit and nothing to ask */
  | "nothing-changed"
  /** it worked and committed, and did not ask to publish. Nothing left the machine. */
  | "kept-local"
  /** it asked, he said yes, and there is a pull request */
  | "published"
  /** it asked, and nothing left the machine: he said no, or nobody answered */
  | "not-allowed"
  /** git or gh fell over. Nothing left the machine. */
  | "failed";

export interface RepoTurnResult {
  outcome: RepoOutcome;
  /** the branch it worked on — always one Cloud9 generated */
  branch: string;
  /** its own worktree, on this computer. Never sent anywhere. */
  path: string;
  /** what the agent wrote, with the marker taken out */
  reply: string;
  /** did it ask to publish? */
  asked: boolean;
  /** did anything get committed? */
  committed: boolean;
  /** how many files the commit touched — counted by git */
  files: number;
  /** the pull request, only when one really opened */
  pullRequest?: { url: string; base: string };
  /** why nothing left the machine, in the words the approval desk used */
  refusal?: string;
  /** something broke; the words are already safe to show */
  problem?: string;
}

export interface RepoTurnDeps {
  /** the one worktree implementation. Not a second one. */
  git: GitWorkspace;
  /**
   * Run the agent's turn with its working folder set to the worktree, and the
   * briefing appended to what it was asked to do. Returns what it wrote.
   */
  respond: (input: { workdir: string; briefing: string }) => Promise<string>;
  /**
   * A GitHub client wired to the approval desk for THIS agent, in THIS
   * conversation — `Engine.githubFor`. `lastRefusal` is how "it did not happen"
   * becomes a true sentence instead of a boolean.
   */
  github: () => { client: GitHubClient; lastRefusal: () => string | undefined };
  log?: (message: string) => void;
}

export interface RepoTurnInput {
  agent: AgentDef;
  /** the checkout on this computer that worktrees are carved out of */
  repoDir: string;
  channelId: ID;
  taskId?: ID;
  /** what it was asked to do, used as the commit subject when it commits */
  ask: string;
}

/**
 * ONE TURN, IN A REPOSITORY, WITH THE GATE IN FRONT OF THE ONLY PART THAT IS
 * VISIBLE FROM OUTSIDE THIS COMPUTER.
 *
 * The order is the whole design: prepare → work → observe → commit → (only if
 * it asked) push → pull request. Observation happens BEFORE the ask and comes
 * from git; that is what makes the card trustworthy.
 *
 * It does not throw. Every way this can go wrong is an outcome with words on
 * it, because the caller's job is to say something true in a chat room.
 */
export async function repoTurn(input: RepoTurnInput, deps: RepoTurnDeps): Promise<RepoTurnResult> {
  const log = deps.log ?? ((m: string) => console.log(`[repowork] ${m}`));
  let wt: Worktree | undefined;
  try {
    wt = await deps.git.prepare({
      repoDir: input.repoDir,
      agentId: input.agent.id,
      ...(input.taskId ? { taskId: input.taskId } : {}),
    });
  } catch (err) {
    return {
      outcome: "failed", branch: "", path: "", reply: "", asked: false,
      committed: false, files: 0,
      problem: err instanceof GitError
        ? `I could not open a workspace for this repository: ${err.detail}`
        : "I could not open a workspace for this repository on this computer.",
    };
  }

  const { client, lastRefusal } = deps.github();
  // asked BEFORE the work, so the briefing can name the repository the agent is
  // actually standing in. Read-only, and it is allowed to come back empty.
  const repo = await safely(() => client.repoName(wt!));
  let reply = "";
  try {
    reply = await deps.respond({
      workdir: wt.path,
      briefing: repoBriefing({
        branch: wt.branch, base: wt.base, ...(repo ? { repo } : {}),
      }),
    });
  } catch (err) {
    await putAway(deps.git, wt, log);
    throw err; // the caller already owns "the turn itself fell over"
  }

  const asked = wantsToPublish(reply);
  const said = withoutPublishMarker(reply);

  // WHAT IT REALLY DID, from git. Everything after this point is built on this
  // and never on `reply`.
  let committed = false;
  let files = 0;
  try {
    const state = await deps.git.status(wt);
    if (!state.clean) {
      const result = await deps.git.commitAll(wt, {
        title: input.ask,
        body: `Written by ${input.agent.name} in Cloud9.`,
      });
      committed = result.committed;
      files = result.files;
    }
  } catch (err) {
    await putAway(deps.git, wt, log);
    return {
      outcome: "failed", branch: wt.branch, path: wt.path, reply: said, asked,
      committed: false, files: 0,
      problem: err instanceof GitError
        ? `I changed some files but could not commit them: ${err.detail}`
        : "I changed some files but could not commit them.",
    };
  }

  if (!committed) {
    // LAW 2. No work, no card — whatever the agent wrote about itself.
    await putAway(deps.git, wt, log);
    return {
      outcome: "nothing-changed", branch: wt.branch, path: wt.path, reply: said,
      asked, committed: false, files: 0,
    };
  }

  if (!asked) {
    // LAW 4. A perfectly ordinary ending: the work is committed, on its own
    // branch, on this computer, and nobody was interrupted to approve anything.
    // The worktree STAYS so the branch's work can still be looked at.
    return {
      outcome: "kept-local", branch: wt.branch, path: wt.path, reply: said,
      asked: false, committed: true, files,
    };
  }

  // ---- the only part that is visible from outside this computer ----
  try {
    // `pushBranch` gathers its own facts (repository, branch, commit count) and
    // the file count is the one git just counted. The gate is inside it.
    await client.pushBranch(wt, { files });
    const pr = await client.openPullRequest(wt, {
      body: `Opened by ${input.agent.name} in Cloud9.\n\nAsked for: ${input.ask}`,
    });
    log(`published ${wt.branch} → ${pr.url}`);
    // pushed and proposed: the branch lives on GitHub now, so the folder can go.
    // The branch itself survives `worktree remove` — verified in worktree.ts.
    await putAway(deps.git, wt, log);
    return {
      outcome: "published", branch: wt.branch, path: wt.path, reply: said,
      asked: true, committed: true, files,
      pullRequest: { url: pr.url, base: pr.base },
    };
  } catch (err) {
    if (err instanceof ApprovalRequiredError) {
      // LAW 3. Which no it was, in the desk's own words. The worktree stays:
      // the work is real and he may yet want it.
      return {
        outcome: "not-allowed", branch: wt.branch, path: wt.path, reply: said,
        asked: true, committed: true, files,
        refusal: lastRefusal() ?? "nothing left this computer",
      };
    }
    log(`could not publish ${wt.branch}: ${err instanceof Error ? err.message : String(err)}`);
    return {
      outcome: "failed", branch: wt.branch, path: wt.path, reply: said,
      asked: true, committed: true, files,
      problem: err instanceof GitError
        ? `I committed the work but GitHub would not take it: ${err.detail}`
        : "I committed the work but could not send it to GitHub.",
    };
  }
}

/**
 * THE ONE SENTENCE THE ROOM READS, and it always says where the work is.
 *
 * Written here rather than at each call site so that "he said no" and "nobody
 * answered" cannot be collapsed into "it didn't work" by whoever writes the
 * next caller.
 */
export function describeRepoTurn(result: RepoTurnResult): string {
  const branch = `\`${result.branch}\``;
  switch (result.outcome) {
    case "nothing-changed":
      return "I did not change any files, so there is nothing to commit and nothing to publish.";
    case "kept-local":
      return `Committed ${filesSaid(result.files)} to my own branch ${branch} on this computer. ` +
        "I did not ask to publish it, so nothing has left this machine.";
    case "published":
      return `Approved — I pushed ${branch} and opened a pull request into ` +
        `\`${result.pullRequest?.base ?? "the trunk"}\`: ${result.pullRequest?.url ?? ""}`.trim();
    case "not-allowed":
      return `I asked to publish ${branch} and ${result.refusal ?? "nothing left this computer"}. ` +
        `The work is committed on that branch on this computer — ${filesSaid(result.files)}.`;
    case "failed":
      return result.problem ?? "Something went wrong and nothing left this computer.";
  }
}

function filesSaid(n: number): string {
  return `${n} file${n === 1 ? "" : "s"}`;
}

/** Put the workspace away, and never let tidying up be the reason a turn fails. */
async function putAway(git: GitWorkspace, wt: Worktree, log: (m: string) => void): Promise<void> {
  try {
    const { removed, reason } = await git.cleanup(wt);
    if (!removed && reason) log(`left ${wt.branch} in place: ${reason}`);
  } catch (err) {
    log(`could not tidy up ${wt.branch}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function safely<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try { return await fn(); } catch { return undefined; }
}
