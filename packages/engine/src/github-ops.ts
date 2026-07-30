// GitHub work as data, not side effects. Every function in this file only
// builds an argv, a guarded command line and the words/facts an approval card
// needs. Nothing here executes gh or git.
//
// Untrusted prose is carried on stdin as JSON. It never becomes an argument.
// Every argv is passed through run.ts's real commandLine() guard before it is
// returned, so a fake runner cannot hide an unsafe command from tests.
import { commandLine, safeArg } from "./run.js";

export type GitHubOperationTool = "gh" | "git";

/** Numeric facts a person can judge; no agent-written risk claims belong here. */
export interface GitHubOperationFacts {
  issues?: number;
  pullRequests?: number;
  comments?: number;
  reviewers?: number;
  branches?: number;
  reviewThreads?: number;
}

/** A fully-built command. It is still only data and has not been executed. */
export interface GitHubOperation {
  tool: GitHubOperationTool;
  argv: string[];
  /** The exact shell-safe rendering produced by run.ts's shared guard. */
  line: string;
  /** Content for standard input; never append this to argv. */
  stdin?: string;
  /** One plain sentence suitable for an approval card or activity row. */
  description: string;
  /** True for every operation that changes GitHub or the local checkout. */
  needsApproval: boolean;
  facts: Readonly<GitHubOperationFacts>;
}

/** A write builder was called before the owner explicitly approved it. */
export class GitHubOperationApprovalError extends Error {
  constructor() {
    super("this GitHub operation needs approval before its command can be built");
    this.name = "GitHubOperationApprovalError";
  }
}

interface ApprovalInput {
  /** Must be literally true. Missing, false and truthy-looking values are not approval. */
  approved?: boolean;
}

interface RepoInput {
  /** GitHub's owner/name form. */
  repo: string;
}

export function buildOpenIssue(
  input: RepoInput & ApprovalInput & { title: string; body?: string },
): GitHubOperation {
  requireApproval(input.approved);
  const repo = checkedRepo(input.repo);
  const title = requiredText(input.title, "issue title");
  const body = optionalText(input.body);
  return build({
    tool: "gh",
    argv: ["api", `repos/${repo}/issues`, "--method", "POST", "--input", "-"],
    stdin: JSON.stringify({ title, ...(body === undefined ? {} : { body }) }),
    description: `Open 1 issue in ${repo}.`,
    needsApproval: true,
    facts: { issues: 1 },
  });
}

export function buildComment(
  input: RepoInput & ApprovalInput & {
    target: "issue" | "pullRequest";
    number: number;
    body: string;
  },
): GitHubOperation {
  requireApproval(input.approved);
  const repo = checkedRepo(input.repo);
  const number = positiveInteger(input.number, "issue or pull request number");
  const body = requiredText(input.body, "comment");
  const targetWords = input.target === "issue" ? "issue" : "pull request";
  const targetFacts = input.target === "issue" ? { issues: 1 } : { pullRequests: 1 };
  return build({
    tool: "gh",
    // GitHub stores both issue and pull-request conversation comments here.
    argv: ["api", `repos/${repo}/issues/${number}/comments`, "--method", "POST", "--input", "-"],
    stdin: JSON.stringify({ body }),
    description: `Post 1 comment on ${targetWords} #${number} in ${repo}.`,
    needsApproval: true,
    facts: { ...targetFacts, comments: 1 },
  });
}

export function buildRequestReview(
  input: RepoInput & ApprovalInput & {
    pullRequest: number;
    reviewers: string[];
    teamReviewers?: string[];
  },
): GitHubOperation {
  requireApproval(input.approved);
  const repo = checkedRepo(input.repo);
  const pullRequest = positiveInteger(input.pullRequest, "pull request number");
  const reviewers = uniqueNames(input.reviewers, "reviewer");
  const teamReviewers = uniqueNames(input.teamReviewers ?? [], "team reviewer");
  const count = reviewers.length + teamReviewers.length;
  if (count === 0) throw new Error("at least 1 reviewer or team reviewer is required");
  return build({
    tool: "gh",
    argv: [
      "api", `repos/${repo}/pulls/${pullRequest}/requested_reviewers`,
      "--method", "POST", "--input", "-",
    ],
    stdin: JSON.stringify({
      reviewers,
      ...(teamReviewers.length === 0 ? {} : { team_reviewers: teamReviewers }),
    }),
    description:
      `Request ${count} ${count === 1 ? "reviewer" : "reviewers"} ` +
      `for pull request #${pullRequest} in ${repo}.`,
    needsApproval: true,
    facts: { pullRequests: 1, reviewers: count },
  });
}

export function buildListReviewComments(
  input: RepoInput & { pullRequest: number },
): GitHubOperation {
  const repo = checkedRepo(input.repo);
  const pullRequest = positiveInteger(input.pullRequest, "pull request number");
  return build({
    tool: "gh",
    argv: [
      "api", `repos/${repo}/pulls/${pullRequest}/comments`,
      "--method", "GET", "--paginate", "--slurp",
    ],
    description: `List review comments on 1 pull request (#${pullRequest}) in ${repo}.`,
    needsApproval: false,
    facts: { pullRequests: 1 },
  });
}

export function buildReadReviewComment(
  input: RepoInput & { commentId: number },
): GitHubOperation {
  const repo = checkedRepo(input.repo);
  const commentId = positiveInteger(input.commentId, "review comment id");
  return build({
    tool: "gh",
    argv: [
      "api", `repos/${repo}/pulls/comments/${commentId}`, "--method", "GET",
    ],
    description: `Read 1 pull request review comment (${commentId}) in ${repo}.`,
    needsApproval: false,
    facts: { comments: 1 },
  });
}

/**
 * gh's checkout command creates the local PR branch when absent and checks out
 * and updates the existing branch when present. No force/reset flag is added.
 */
export function buildCheckoutOrUpdatePullRequestBranch(
  input: RepoInput & ApprovalInput & { pullRequest: number },
): GitHubOperation {
  requireApproval(input.approved);
  const repo = checkedRepo(input.repo);
  const pullRequest = positiveInteger(input.pullRequest, "pull request number");
  return build({
    tool: "gh",
    argv: ["pr", "checkout", String(pullRequest), "--repo", repo],
    description:
      `Check out or update 1 existing pull request branch for #${pullRequest} in ${repo}.`,
    needsApproval: true,
    facts: { pullRequests: 1, branches: 1 },
  });
}

export function buildResolveReviewThread(
  input: ApprovalInput & { threadId: string },
): GitHubOperation {
  requireApproval(input.approved);
  const threadId = requiredText(input.threadId, "review thread id");
  return build({
    tool: "gh",
    argv: ["api", "graphql", "--method", "POST", "--input", "-"],
    stdin: JSON.stringify({
      query:
        "mutation ResolveReviewThread($threadId: ID!) { " +
        "resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } } }",
      variables: { threadId },
    }),
    description: "Resolve 1 pull request review thread.",
    needsApproval: true,
    facts: { reviewThreads: 1 },
  });
}

export function buildReadCiStatus(
  input: RepoInput & { pullRequest: number },
): GitHubOperation {
  const repo = checkedRepo(input.repo);
  const pullRequest = positiveInteger(input.pullRequest, "pull request number");
  return build({
    tool: "gh",
    // Repeated --json flags keep commas out of argv, as github.ts already does.
    argv: [
      "pr", "checks", String(pullRequest), "--repo", repo,
      "--json", "bucket", "--json", "name", "--json", "state", "--json", "workflow",
    ],
    description: `Read CI status for 1 pull request (#${pullRequest}) in ${repo}.`,
    needsApproval: false,
    facts: { pullRequests: 1 },
  });
}

function build(input: Omit<GitHubOperation, "line">): GitHubOperation {
  const argv = [...input.argv];
  return { ...input, argv, line: commandLine(input.tool, argv) };
}

function requireApproval(approved: boolean | undefined): void {
  if (approved !== true) throw new GitHubOperationApprovalError();
}

function checkedRepo(value: string): string {
  // First use the shared injection guard, so metacharacters fail with the same
  // UnsafeArgumentError as every real command path in the engine.
  safeArg(value);
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error("repository must be in GitHub owner/name form");
  }
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requiredText(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return value;
}

function optionalText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, "issue body");
}

function uniqueNames(values: string[], label: string): string[] {
  if (!Array.isArray(values)) throw new Error(`${label} list must be an array`);
  const names = [...new Set(values)];
  for (const name of names) {
    if (
      typeof name !== "string" ||
      name.length > 100 ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(name)
    ) {
      throw new Error(`${label} must be a GitHub login or team slug`);
    }
  }
  return names;
}
