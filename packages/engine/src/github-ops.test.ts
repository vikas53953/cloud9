import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCheckoutOrUpdatePullRequestBranch,
  buildComment,
  buildListReviewComments,
  buildOpenIssue,
  buildReadCiStatus,
  buildReadReviewComment,
  buildRequestReview,
  buildResolveReviewThread,
  GitHubOperation,
  GitHubOperationApprovalError,
} from "./github-ops.js";
import { commandLine, UnsafeArgumentError } from "./run.js";

const repo = "vikas53953/cloud9";

function builtOperations(): GitHubOperation[] {
  return [
    buildOpenIssue({ repo, title: "A title", body: "A body", approved: true }),
    buildComment({
      repo, target: "issue", number: 12, body: "Please fix this.", approved: true,
    }),
    buildRequestReview({
      repo, pullRequest: 31, reviewers: ["alice", "bob"], teamReviewers: ["platform"],
      approved: true,
    }),
    buildListReviewComments({ repo, pullRequest: 31 }),
    buildReadReviewComment({ repo, commentId: 998 }),
    buildCheckoutOrUpdatePullRequestBranch({ repo, pullRequest: 31, approved: true }),
    buildResolveReviewThread({ threadId: "PRRT_kwDOABCD1234=", approved: true }),
    buildReadCiStatus({ repo, pullRequest: 31 }),
  ];
}

test("open issue builds the exact API argv and keeps prose on stdin", () => {
  const op = buildOpenIssue({
    repo, title: "Crash when `$PATH` contains spaces", body: "Steps: run x && y",
    approved: true,
  });

  assert.equal(op.tool, "gh");
  assert.deepEqual(op.argv, [
    "api", "repos/vikas53953/cloud9/issues", "--method", "POST", "--input", "-",
  ]);
  assert.equal(op.stdin, JSON.stringify({
    title: "Crash when `$PATH` contains spaces",
    body: "Steps: run x && y",
  }));
  assert.equal(op.description, "Open 1 issue in vikas53953/cloud9.");
  assert.equal(op.needsApproval, true);
  assert.deepEqual(op.facts, { issues: 1 });
});

test("issue and pull request comments use the shared comments endpoint exactly", () => {
  const issue = buildComment({
    repo, target: "issue", number: 12, body: "issue note", approved: true,
  });
  const pull = buildComment({
    repo, target: "pullRequest", number: 31, body: "PR note", approved: true,
  });

  assert.deepEqual(issue.argv, [
    "api", "repos/vikas53953/cloud9/issues/12/comments", "--method", "POST", "--input", "-",
  ]);
  assert.deepEqual(pull.argv, [
    "api", "repos/vikas53953/cloud9/issues/31/comments", "--method", "POST", "--input", "-",
  ]);
  assert.equal(issue.stdin, '{"body":"issue note"}');
  assert.equal(pull.stdin, '{"body":"PR note"}');
  assert.equal(issue.description, "Post 1 comment on issue #12 in vikas53953/cloud9.");
  assert.equal(pull.description, "Post 1 comment on pull request #31 in vikas53953/cloud9.");
  assert.deepEqual(issue.facts, { issues: 1, comments: 1 });
  assert.deepEqual(pull.facts, { pullRequests: 1, comments: 1 });
});

test("request review builds exact argv and counts people and teams", () => {
  const op = buildRequestReview({
    repo, pullRequest: 31, reviewers: ["alice", "bob"], teamReviewers: ["platform"],
    approved: true,
  });

  assert.deepEqual(op.argv, [
    "api", "repos/vikas53953/cloud9/pulls/31/requested_reviewers",
    "--method", "POST", "--input", "-",
  ]);
  assert.equal(op.stdin, JSON.stringify({
    reviewers: ["alice", "bob"],
    team_reviewers: ["platform"],
  }));
  assert.equal(op.description, "Request 3 reviewers for pull request #31 in vikas53953/cloud9.");
  assert.deepEqual(op.facts, { pullRequests: 1, reviewers: 3 });
});

test("list and read review comments build exact read-only API argv", () => {
  const list = buildListReviewComments({ repo, pullRequest: 31 });
  const read = buildReadReviewComment({ repo, commentId: 998 });

  assert.deepEqual(list.argv, [
    "api", "repos/vikas53953/cloud9/pulls/31/comments",
    "--method", "GET", "--paginate", "--slurp",
  ]);
  assert.deepEqual(read.argv, [
    "api", "repos/vikas53953/cloud9/pulls/comments/998", "--method", "GET",
  ]);
  assert.equal(list.needsApproval, false);
  assert.equal(read.needsApproval, false);
  assert.deepEqual(list.facts, { pullRequests: 1 });
  assert.deepEqual(read.facts, { comments: 1 });
});

test("checkout or update an existing PR branch builds exact gh argv", () => {
  const op = buildCheckoutOrUpdatePullRequestBranch({
    repo, pullRequest: 31, approved: true,
  });

  assert.deepEqual(op.argv, [
    "pr", "checkout", "31", "--repo", "vikas53953/cloud9",
  ]);
  assert.equal(
    op.description,
    "Check out or update 1 existing pull request branch for #31 in vikas53953/cloud9.",
  );
  assert.deepEqual(op.facts, { pullRequests: 1, branches: 1 });
});

test("resolve review thread builds exact GraphQL argv with the thread id on stdin", () => {
  const op = buildResolveReviewThread({
    threadId: "PRRT_kwDOABCD1234=", approved: true,
  });

  assert.deepEqual(op.argv, ["api", "graphql", "--method", "POST", "--input", "-"]);
  assert.equal(op.stdin, JSON.stringify({
    query: "mutation ResolveReviewThread($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } } }",
    variables: { threadId: "PRRT_kwDOABCD1234=" },
  }));
  assert.equal(op.description, "Resolve 1 pull request review thread.");
  assert.deepEqual(op.facts, { reviewThreads: 1 });
});

test("read CI status builds exact repeated-json argv without a comma", () => {
  const op = buildReadCiStatus({ repo, pullRequest: 31 });

  assert.deepEqual(op.argv, [
    "pr", "checks", "31", "--repo", "vikas53953/cloud9",
    "--json", "bucket", "--json", "name", "--json", "state", "--json", "workflow",
  ]);
  assert.equal(op.needsApproval, false);
  assert.equal(op.description, "Read CI status for 1 pull request (#31) in vikas53953/cloud9.");
  assert.deepEqual(op.facts, { pullRequests: 1 });
});

test("every operation records the exact guarded command line it built", () => {
  for (const op of builtOperations()) {
    assert.equal(op.line, commandLine(op.tool, op.argv), op.description);
  }
});

test("every builder rejects command-line injection in its repository argument", () => {
  const badRepo = "vikas53953/cloud9;calc";
  const builders = [
    () => buildOpenIssue({ repo: badRepo, title: "x", approved: true }),
    () => buildComment({
      repo: badRepo, target: "issue" as const, number: 1, body: "x", approved: true,
    }),
    () => buildRequestReview({
      repo: badRepo, pullRequest: 1, reviewers: ["alice"], approved: true,
    }),
    () => buildListReviewComments({ repo: badRepo, pullRequest: 1 }),
    () => buildReadReviewComment({ repo: badRepo, commentId: 1 }),
    () => buildCheckoutOrUpdatePullRequestBranch({
      repo: badRepo, pullRequest: 1, approved: true,
    }),
    () => buildReadCiStatus({ repo: badRepo, pullRequest: 1 }),
  ];

  for (const build of builders) {
    assert.throws(build, UnsafeArgumentError);
  }
});

test("untrusted prose never becomes a command-line argument", () => {
  const nasty = 'hello && calc.exe; $(whoami) "quoted"';
  const issue = buildOpenIssue({ repo, title: nasty, body: nasty, approved: true });
  const comment = buildComment({
    repo, target: "pullRequest", number: 31, body: nasty, approved: true,
  });
  const thread = buildResolveReviewThread({ threadId: nasty, approved: true });

  assert.deepEqual(JSON.parse(issue.stdin ?? ""), { title: nasty, body: nasty });
  assert.deepEqual(JSON.parse(comment.stdin ?? ""), { body: nasty });
  assert.equal(JSON.parse(thread.stdin ?? "").variables.threadId, nasty);
  for (const op of [issue, comment, thread]) {
    assert.ok(!op.argv.some(arg => arg.includes(nasty)));
  }
});

test("every write throws before building unless approval is explicit", () => {
  const writes = [
    () => buildOpenIssue({ repo, title: "x" }),
    () => buildComment({ repo, target: "issue" as const, number: 1, body: "x" }),
    () => buildRequestReview({ repo, pullRequest: 1, reviewers: ["alice"] }),
    () => buildCheckoutOrUpdatePullRequestBranch({ repo, pullRequest: 1 }),
    () => buildResolveReviewThread({ threadId: "PRRT_1" }),
  ];

  for (const write of writes) {
    assert.throws(write, GitHubOperationApprovalError);
  }
});
