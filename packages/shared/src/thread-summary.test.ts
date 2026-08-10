import test from "node:test";
import assert from "node:assert/strict";
import { validateThreadSummaryRequest, validateThreadSummaryResult, type ThreadSummaryResult } from "./index.js";

const request = {
  requestId: "rq-summary-1", channelId: "c1", threadId: "m-root", sourceMessageId: "m-root",
  agentId: "a1", requesterId: "u1",
};

const ready: ThreadSummaryResult = {
  ...request, status: "ready", updatedAt: 1,
  decisions: ["Ship after the review"], openQuestions: ["Who owns the follow-up?"],
  nextActions: ["Open the release checklist"], sources: [{ messageId: "m-root", label: "Vikas: ship after review" }],
  runId: "r-1",
};

test("thread summary contracts accept bounded provider facts", () => {
  assert.equal(validateThreadSummaryRequest(request), null);
  assert.equal(validateThreadSummaryResult(ready), null);
});

test("thread summary validation rejects unbounded or fabricated lifecycle payloads", () => {
  assert.match(validateThreadSummaryRequest({ ...request, extra: true })!, /unknown fields/);
  assert.match(validateThreadSummaryResult({ ...ready, status: "refused", decisions: ["not allowed"] })!, /non-ready/);
  assert.match(validateThreadSummaryResult({ ...ready, sources: Array.from({ length: 25 }, (_, i) => ({ messageId: `m-${i}`, label: "x" })) })!, /too many sources/);
  assert.match(validateThreadSummaryResult({ ...ready, decisions: ["x".repeat(321)] })!, /unusable decisions/);
  assert.match(validateThreadSummaryResult({ ...ready, secret: "private reasoning" })!, /unknown fields/);
});
