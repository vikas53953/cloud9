// PERFORMING a GitHub operation — the one caller that turns github-ops.ts's
// data into a real `gh` run, and only ever after a yes.
//
// github-ops.ts builds argv, stdin, counted facts and a plain sentence, and
// EXECUTES NOTHING. This file is the executor. It keeps the write path honest:
//
//  1. THE CARD IS DRAWN FROM COUNTED FACTS, NOT FROM AN ARGV. A write request is
//     structured (repo, number, reviewers, a thread id) and `writeFactsFor`
//     turns it into the same `RemoteActionFacts` the git push already uses. The
//     hub writes the sentence; nothing an agent typed reaches the card.
//  2. NOTHING IS BUILT, LET ALONE RUN, UNTIL THE OWNER SAYS YES. `runGitHubWrite`
//     asks FIRST and returns before it ever touches the runner if the answer is
//     no, expired or a dropped hub. The github-ops builders REFUSE to build a
//     write without `approved: true`, so the lock is doubled: a bug that skipped
//     the ask would still throw rather than run.
//  3. THE BUILDER'S argv/stdin ARE EXECUTED VERBATIM. The executor never
//     rebuilds a command line — it runs `op.tool`, `op.argv` and `op.stdin`
//     exactly as returned, so the allowlist guard `commandLine()` that ran while
//     the argv was built is the same one that ran it. Prose stays on stdin.
//  4. READS NEVER ASK, AND NEVER FORWARD RAW gh JSON. A read runs straight away
//     and its answer is parsed into the capped, validated shared views before it
//     leaves here — an unusable row costs itself, never the whole answer.
import {
  RemoteActionFacts, describeRemoteAction,
  GitHubReadResult, GitHubReviewCommentView, GitHubCiCheckView, GitHubCheckBucket,
  GITHUB_READ_LIMITS, validateReviewCommentView, validateCiCheckView,
} from "@cloud9/shared";
import {
  GitHubOperation,
  buildOpenIssue, buildComment, buildRequestReview,
  buildCheckoutOrUpdatePullRequestBranch, buildResolveReviewThread,
  buildListReviewComments, buildReadReviewComment, buildReadCiStatus,
} from "./github-ops.js";
import { run, Runner, RunResult } from "./run.js";

/**
 * A GitHub WRITE an agent (or an owner's command) asked to make, as structure
 * rather than as a command. Titles and bodies live in here and only ever reach
 * `gh` on standard input, never as an argument.
 */
export type GitHubWriteRequest =
  | { kind: "openIssue"; repo: string; title: string; body?: string }
  | { kind: "comment"; repo: string; target: "issue" | "pullRequest"; number: number; body: string }
  | { kind: "requestReview"; repo: string; pullRequest: number; reviewers: string[]; teamReviewers?: string[] }
  | { kind: "checkoutPullRequest"; repo: string; pullRequest: number }
  | { kind: "resolveReviewThread"; repo?: string; pullRequest?: number; threadId: string };

/**
 * A write request with the repository left off, as a room command starts life:
 * distributive so each arm of the union keeps its own fields (a plain
 * `Omit<GitHubWriteRequest, "repo">` collapses a union to its common keys).
 */
export type GitHubWriteRequestWithoutRepo =
  GitHubWriteRequest extends infer T ? (T extends { repo?: unknown } ? Omit<T, "repo"> : T) : never;

/** A GitHub READ. It changes nothing, so it carries no approval. */
export type GitHubReadRequest =
  | { kind: "listReviewComments"; repo: string; pullRequest: number }
  | { kind: "readReviewComment"; repo: string; commentId: number }
  | { kind: "readCiStatus"; repo: string; pullRequest: number };

/**
 * The COUNTED facts a write's approval card is built from. No argv, no title,
 * no body — just the numbers and the public target a person can judge.
 */
export function writeFactsFor(req: GitHubWriteRequest): RemoteActionFacts {
  switch (req.kind) {
    case "openIssue":
      return { action: "openIssue", repo: req.repo, issues: 1 };
    case "comment":
      return {
        action: "comment", repo: req.repo, target: req.target, number: req.number,
        ...(req.target === "issue" ? { issues: 1 } : { pullRequests: 1 }), comments: 1,
      };
    case "requestReview": {
      const reviewers = countReviewers(req.reviewers, req.teamReviewers);
      return {
        action: "requestReview", repo: req.repo, target: "pullRequest",
        number: req.pullRequest, pullRequests: 1, reviewers,
      };
    }
    case "checkoutPullRequest":
      return {
        action: "checkoutPullRequest", repo: req.repo, target: "pullRequest",
        number: req.pullRequest, pullRequests: 1, branches: 1,
      };
    case "resolveReviewThread":
      return {
        action: "resolveReviewThread",
        ...(req.repo ? { repo: req.repo } : {}),
        ...(req.pullRequest ? { target: "pullRequest" as const, number: req.pullRequest } : {}),
        reviewThreads: 1,
      };
  }
}

/**
 * Build the guarded `gh` operation for a write. Only ever called AFTER a yes,
 * with `approved: true` — and the github-ops builders throw if it is anything
 * else, so this function cannot be the hole through which an unapproved write
 * gets a command line.
 */
export function buildGitHubWrite(req: GitHubWriteRequest): GitHubOperation {
  switch (req.kind) {
    case "openIssue":
      return buildOpenIssue({ repo: req.repo, title: req.title, ...(req.body !== undefined ? { body: req.body } : {}), approved: true });
    case "comment":
      return buildComment({ repo: req.repo, target: req.target, number: req.number, body: req.body, approved: true });
    case "requestReview":
      return buildRequestReview({
        repo: req.repo, pullRequest: req.pullRequest, reviewers: req.reviewers,
        ...(req.teamReviewers ? { teamReviewers: req.teamReviewers } : {}), approved: true,
      });
    case "checkoutPullRequest":
      return buildCheckoutOrUpdatePullRequestBranch({ repo: req.repo, pullRequest: req.pullRequest, approved: true });
    case "resolveReviewThread":
      return buildResolveReviewThread({ threadId: req.threadId, approved: true });
  }
}

/** How a write ended. Every field is a true sentence about what really happened. */
export interface GitHubWriteOutcome {
  /** did the `gh` command actually run? False on every no-path. */
  ran: boolean;
  /** did the owner say yes? */
  approved: boolean;
  /** the desk's own words for a no, or "approved" */
  reason: string;
  /** the one sentence the room reads, from the counted facts */
  description: string;
  /** the raw run result, only when it ran */
  result?: RunResult;
  /** something went wrong once it ran, in words already safe to show */
  problem?: string;
}

/** What the executor needs to ask the owner. Returns the desk's plain outcome. */
export type AskForApproval = (facts: RemoteActionFacts) => Promise<{ approved: boolean; reason: string }>;

/**
 * PERFORM A WRITE, BUT ONLY AFTER A YES.
 *
 * The order is the whole safety story: gather facts → ask → (only on approved)
 * build → run. There is no path to `run` that does not pass through an
 * `approved === true`, and the builder is a second lock behind that.
 */
export async function runGitHubWrite(input: {
  request: GitHubWriteRequest;
  ask: AskForApproval;
  run?: Runner;
  timeoutMs?: number;
}): Promise<GitHubWriteOutcome> {
  const facts = writeFactsFor(input.request);
  const description = describeRemoteAction(facts);
  const outcome = await input.ask(facts);
  if (!outcome.approved) {
    // NO / EXPIRED / HUB GONE — nothing is built and nothing is run.
    return { ran: false, approved: false, reason: outcome.reason, description };
  }
  const op = buildGitHubWrite(input.request);
  const runner = input.run ?? run;
  const r = await runner(op.tool, op.argv, {
    ...(op.stdin !== undefined ? { stdin: op.stdin } : {}),
    timeoutMs: input.timeoutMs ?? 120_000,
  });
  const problem = r.notFound
    ? "the GitHub command line isn't installed on this computer"
    : r.timedOut
      ? "GitHub did not answer in time"
      : r.code !== 0
        ? firstLine(r.stderr || r.stdout)
        : undefined;
  return { ran: true, approved: true, reason: "approved", description, result: r, ...(problem ? { problem } : {}) };
}

/**
 * PERFORM A READ. No approval, and its answer is parsed into the capped shared
 * views before it is returned — raw `gh` JSON never leaves this function.
 */
export async function runGitHubRead(input: {
  request: GitHubReadRequest;
  run?: Runner;
  timeoutMs?: number;
}): Promise<{ result?: GitHubReadResult; problem?: string }> {
  const op = readOperation(input.request);
  const runner = input.run ?? run;
  const r = await runner(op.tool, op.argv, { timeoutMs: input.timeoutMs ?? 60_000 });
  if (r.notFound) return { problem: "the GitHub command line (gh) isn't installed on this computer." };
  if (r.timedOut) return { problem: "GitHub did not answer in time. Try again in a moment." };
  if (r.code !== 0) return { problem: firstLine(r.stderr || r.stdout) };
  return parseRead(input.request, r.stdout);
}

function readOperation(req: GitHubReadRequest): GitHubOperation {
  switch (req.kind) {
    case "listReviewComments": return buildListReviewComments({ repo: req.repo, pullRequest: req.pullRequest });
    case "readReviewComment": return buildReadReviewComment({ repo: req.repo, commentId: req.commentId });
    case "readCiStatus": return buildReadCiStatus({ repo: req.repo, pullRequest: req.pullRequest });
  }
}

/**
 * Turn `gh`'s JSON into the validated, capped shared views. A row that does not
 * pass its shared validator is DROPPED, never repaired — one bad row must never
 * cost the whole answer.
 */
export function parseRead(req: GitHubReadRequest, stdout: string): { result?: GitHubReadResult; problem?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(stdout.trim() || (req.kind === "readReviewComment" ? "null" : "[]"));
  } catch {
    return { problem: "GitHub's answer could not be read." };
  }
  if (req.kind === "listReviewComments") {
    const rows = flattenPages(raw);
    const all = rows.map(reviewCommentView).filter((c): c is GitHubReviewCommentView => !!c);
    const comments = all.slice(0, GITHUB_READ_LIMITS.comments);
    return { result: { kind: "reviewComments", comments, more: all.length - comments.length } };
  }
  if (req.kind === "readReviewComment") {
    const comment = reviewCommentView(raw);
    if (!comment) return { problem: "GitHub's answer could not be read." };
    // Reply ancestry needs a second call we do not make here; an empty ancestry
    // is the honest answer rather than a guessed one.
    return { result: { kind: "reviewComment", comment, ancestry: [] } };
  }
  // readCiStatus
  if (!Array.isArray(raw)) return { problem: "GitHub's answer could not be read." };
  const all = raw.map(ciCheckView).filter((c): c is GitHubCiCheckView => !!c);
  const checks = all.slice(0, GITHUB_READ_LIMITS.checks);
  return { result: { kind: "ciStatus", checks, more: all.length - checks.length } };
}

/**
 * `gh api --paginate --slurp` wraps each page's array into an outer array, so a
 * list endpoint comes back as an array OF arrays. Flatten either shape.
 */
function flattenPages(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const out: unknown[] = [];
  for (const page of raw) {
    if (Array.isArray(page)) out.push(...page);
    else out.push(page);
  }
  return out;
}

function reviewCommentView(row: unknown): GitHubReviewCommentView | undefined {
  if (!row || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const id = typeof r.id === "number" ? r.id : NaN;
  const url = typeof r.html_url === "string" ? r.html_url : (typeof r.url === "string" ? r.url : "");
  const body = trim(typeof r.body === "string" ? r.body : "", GITHUB_READ_LIMITS.body);
  const author = (r.user as { login?: unknown } | undefined)?.login;
  const line = typeof r.line === "number" ? r.line : (typeof r.original_line === "number" ? r.original_line : undefined);
  const side = r.side === "LEFT" || r.side === "RIGHT" ? r.side : undefined;
  const inReplyToId = typeof r.in_reply_to_id === "number" ? r.in_reply_to_id : undefined;
  const view: GitHubReviewCommentView = {
    id, body, url,
    ...(typeof author === "string" && author ? { author: trim(author, GITHUB_READ_LIMITS.label) } : {}),
    ...(typeof r.path === "string" && r.path ? { path: trim(r.path, GITHUB_READ_LIMITS.label) } : {}),
    ...(line !== undefined ? { line } : {}),
    ...(side ? { side } : {}),
    ...(inReplyToId !== undefined ? { inReplyToId } : {}),
  };
  // the shared rule, run here so a bad row costs itself and nothing else
  return validateReviewCommentView(view) ? undefined : view;
}

function ciCheckView(row: unknown): GitHubCiCheckView | undefined {
  if (!row || typeof row !== "object") return undefined;
  const r = row as Record<string, unknown>;
  const bucket = r.bucket;
  const known: GitHubCheckBucket[] = ["pass", "fail", "pending", "skipping", "cancel"];
  if (!known.includes(bucket as GitHubCheckBucket)) return undefined;
  const view: GitHubCiCheckView = {
    name: trim(typeof r.name === "string" ? r.name : "", GITHUB_READ_LIMITS.label),
    state: trim(typeof r.state === "string" ? r.state : "", GITHUB_READ_LIMITS.label),
    bucket: bucket as GitHubCheckBucket,
    ...(typeof r.workflow === "string" && r.workflow ? { workflow: trim(r.workflow, GITHUB_READ_LIMITS.label) } : {}),
  };
  return validateCiCheckView(view) ? undefined : view;
}

function countReviewers(reviewers: string[], teamReviewers?: string[]): number {
  const a = new Set(Array.isArray(reviewers) ? reviewers : []);
  const b = new Set(Array.isArray(teamReviewers) ? teamReviewers : []);
  return a.size + b.size;
}

function trim(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

function firstLine(text: string): string {
  return (String(text ?? "").split(/\r?\n/).find(l => l.trim()) ?? "").trim().slice(0, 200)
    || "GitHub refused the request and did not say why.";
}
