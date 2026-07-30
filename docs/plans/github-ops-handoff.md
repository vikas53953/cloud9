# GitHub operations — conductor handoff

**Lane G owns:** pure operation builders in `packages/engine/src/github-ops.ts`.
They build guarded `gh` argv, optional stdin, counted facts and one plain
description. They do not execute, send frames or change GitHub.

## Contract the engine now provides

Every builder returns:

```ts
interface GitHubOperation {
  tool: "gh" | "git";
  argv: string[];
  line: string;              // produced by run.ts commandLine()
  stdin?: string;            // titles, bodies and GraphQL variables live here
  description: string;       // plain words, derived from structured input
  needsApproval: boolean;
  facts: {
    issues?: number;
    pullRequests?: number;
    comments?: number;
    reviewers?: number;
    branches?: number;
    reviewThreads?: number;
  };
}
```

Writes refuse to build unless `approved === true`. Reads build without an
approval. The executor must still check `needsApproval`; the boolean is kept in
the returned record so audit and UI code cannot mistake an approved write for a
read.

| Operation | Changes something | Counted facts |
|---|---:|---|
| Open issue | yes | `issues: 1` |
| Comment on issue | yes | `issues: 1, comments: 1` |
| Comment on pull request | yes | `pullRequests: 1, comments: 1` |
| Request review | yes | `pullRequests: 1, reviewers: N` |
| List PR review comments | no | `pullRequests: 1` |
| Read one PR review comment | no | `comments: 1` |
| Check out/update PR branch | yes, local checkout | `pullRequests: 1, branches: 1` |
| Resolve review thread | yes | `reviewThreads: 1` |
| Read CI status | no | `pullRequests: 1` |

## Frames the hub and screen need

Do not send `argv`, `line`, `stdin`, issue titles, comment bodies or review
thread IDs to the approval screen. The approval card needs only facts the
engine counted plus the repository and public issue/PR number.

Extend the existing engine-only `askApproval` path rather than creating a
second approval system:

```ts
type GitHubWriteKind =
  | "openIssue"
  | "comment"
  | "requestReview"
  | "checkoutPullRequest"
  | "resolveReviewThread";

interface GitHubOperationApprovalFacts {
  action: GitHubWriteKind;
  repo?: string;
  target?: "issue" | "pullRequest";
  number?: number;
  issues?: number;
  pullRequests?: number;
  comments?: number;
  reviewers?: number;
  branches?: number;
  reviewThreads?: number;
}

// engine -> hub; same ownership checks and receipt as today's remote actions
{ type: "askApproval"; askId; agentId; channelId; taskId?; facts }

// hub -> screen; today's Approval frame, with the union extended
{ type: "approval"; approval: {
    kind: "action";
    remoteAction: GitHubWriteKind;
    action: string;          // hub derives this from facts
    detail?: string;         // counted facts only
    // existing Approval fields remain unchanged
} }

// screen -> hub; unchanged
{ type: "decideApproval"; approvalId; approved }

// hub -> engine; unchanged receipt/decision path
{ type: "approvalAsked"; askId; approvalId }
```

The hub, not the agent and not the screen, must turn structured facts into the
approval sentence. Example:

```text
Request 3 reviewers for pull request #31 in vikas53953/cloud9
```

Reads need no approval card. If their results are to be shown live, add one
request/result pair with a correlation ID rather than a frame per operation:

```ts
// screen -> hub -> engine
{ type: "githubRead"; requestId; agentId; channelId; request:
    | { kind: "listReviewComments"; repo; pullRequest }
    | { kind: "readReviewComment"; repo; commentId }
    | { kind: "readCiStatus"; repo; pullRequest } }

// engine -> hub -> requesting screen
{ type: "githubReadResult"; requestId; result?: unknown; problem?: string }
```

`result` needs a validated shared type before wiring. Do not forward raw `gh`
JSON to the desktop.

## Screen frames

The existing approval card can render these writes if it receives:

- the operation name in owner words;
- repository and issue/PR number when present;
- each non-zero counted fact;
- pending/approved/rejected/expired state;
- the existing owner-only audience and expiry.

The screen must never render pending work as already happening. For local
checkout/update, say “wants to check out or update”; for the other writes, say
“wants to open/post/request/resolve”.

Read results need three views:

1. Review comment list: author, path, line/side, body, URL and resolved state
   when the API supplies it.
2. Review comment detail: the same fields plus reply ancestry.
3. CI status: check name, workflow, state and bucket, with an honest empty and
   error state.

## Conductor wiring list — not done in this lane

1. Export `github-ops.ts` from `packages/engine/src/index.ts`.
2. Add the write kinds and counted fact fields to the shared remote-action
   contract; keep `describeRemoteAction` as the one sentence builder.
3. Extend hub validation for the new facts. Require positive integers and
   refuse client-originated `askApproval` exactly as today.
4. Add an engine executor that calls `run` only after the existing
   `ApprovalDesk` returns yes. Pass `stdin` separately.
5. Never rebuild argv in the executor. Execute the builder's `tool`, `argv` and
   `stdin` as returned.
6. Add validated shared result types for review comments, review threads and CI
   checks before introducing `githubReadResult`.
7. Route read requests only to the requesting owner/channel; cap list sizes and
   returned body lengths.
8. Extend the existing desktop approval card and Tasks count. Do not create a
   second GitHub approval component.
9. Add end-to-end tests for yes, no, expiry, malformed frames and disconnect.
   Every no-path must prove the executor was never called.
10. Confirm the installed `gh` accepts repeated `--json` for `pr checks`; if it
    does not, replace that read builder with a REST/GraphQL stdin query without
    weakening `commandLine()` or allowing commas.

## Safety invariants to preserve

- No function in `github-ops.ts` executes.
- No untrusted prose enters argv.
- Every argv passes through `commandLine()` while it is built.
- No write command is returned without literal approval.
- Read operations never ask for approval.
- Approval words come from structured, counted facts.
- A denied, expired or disconnected approval runs nothing.
