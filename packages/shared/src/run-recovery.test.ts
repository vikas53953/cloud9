import test from "node:test";
import assert from "node:assert/strict";
import {
  buildRunCheckpoint, compareRecoveryRequest, compareRuns, recoveryDecision,
  recoveryRequestFingerprint, sanitizeRecoveryAsk, validateRunCheckpoint,
  type RecoveryReceipt, type RecoveryRequest, type RunRecord,
} from "./index.js";

function run(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r-1", kind: "chat", agentId: "a-1", agentName: "Scout", provider: "codex",
    requestedBy: "Vikas", requestedByKind: "human", ask: "inspect files", startedAt: 1,
    finishedAt: 20, durationMs: 19, outcome: "failed", steps: [
      { seq: 1, kind: "read", label: "Read README", ok: true },
      { seq: 2, kind: "write", label: "Write secret-looking path C:\\Users\\me", ok: false },
    ], replyChars: 0, events: 2, ...over,
  };
}

test("checkpoint keeps public completed facts and provider resume is fail closed", () => {
  const cp = buildRunCheckpoint(run(), {
    files: ["README.md", "C:\\Users\\me\\secret.txt"], branch: "feature/a", commit: "abc123",
    providerSession: { provider: "codex", sessionId: "11111111-1111-4111-8111-111111111111", canResume: false, actionSemantics: "unknown", reason: "no provider recovery adapter is available" },
  });
  assert.equal(cp.completedStepSeq, 1);
  assert.equal(cp.completedSteps.length, 1);
  const decision = recoveryDecision(run(), cp);
  assert.equal(decision.actions.find(a => a.mode === "resume")?.available, false);
  assert.equal(recoveryDecision(run()).actions.find(a => a.mode === "resume")?.available, false);
});

test("checkpoint step labels scrub paths and credential-shaped values", () => {
  const cp = buildRunCheckpoint(run({
    steps: [{ seq: 1, kind: "read", label: "Read C:\\Users\\me\\notes sk-ant-api03-secret-value", ok: true }],
  }), { branch: "C:\\Users\\me\\sk-ant-api03-secret-value", commit: "sk-ant-api03-secret-value" });
  assert.doesNotMatch(cp.completedSteps[0].label, /C:\\Users|sk-ant/i);
  assert.match(cp.completedSteps[0].label, /Read/);
  assert.doesNotMatch(cp.branch ?? "", /C:\\Users|sk-ant/i);
  assert.doesNotMatch(cp.commit ?? "", /sk-ant/i);
});

test("recovery ask is bounded public text before persistence or engine routing", () => {
  const ask = sanitizeRecoveryAsk("inspect C:\\Users\\me\\notes sk-ant-api03-secret-value");
  assert.doesNotMatch(ask, /C:\\Users|sk-ant/i);
  assert.match(ask, /inspect/);
  assert.ok(sanitizeRecoveryAsk("x".repeat(800)).length <= 240);
});

test("recovery request replay is exact and conflicts do not replay", () => {
  const request: RecoveryRequest = {
    requestId: "req-1", requesterId: "u-1", agentId: "a-1", runId: "r-1",
    payload: { mode: "retry", ask: "inspect files", approvalEpoch: "fresh-1" },
  };
  const receipt: RecoveryReceipt = {
    request, payloadFingerprint: recoveryRequestFingerprint(request), status: "accepted", createdAt: 1,
  };
  assert.equal(compareRecoveryRequest(receipt, request), "replay");
  assert.equal(compareRecoveryRequest(receipt, { ...request, payload: { ...request.payload, approvalEpoch: "another-server-token" } }), "replay");
  assert.equal(compareRecoveryRequest(receipt, { ...request, payload: { ...request.payload, mode: "restart" } }), "conflict");
});

test("run comparison redacts inaccessible runs and never chooses a winner", () => {
  const left = run({ id: "r-left", outcome: "ok", usage: undefined });
  const right = run({ id: "r-right", outcome: "failed", provider: "claude" });
  const comparison = compareRuns(left, right, r => r.id === "r-left");
  assert.equal(comparison.left.accessible, true);
  assert.equal(comparison.right.accessible, false);
  assert.equal("winner" in comparison, false);
});

test("run comparison redacts every legacy/free-text field before projection", () => {
  const hostile = run({
    ask: "inspect C:\\Users\\vikas\\notes API_KEY=sk-ant-api03-secret-value",
    agentName: "Scout PASSWORD=hunter2", provider: "codex TOKEN=ghp_1234567890",
    model: "model sk-ant-api03-secret-value", effort: "C:\\Users\\vikas\\effort",
    branch: "C:\\Users\\vikas\\feature sk-ant-api03-secret-value",
    commit: "API_KEY=sk-ant-api03-secret-value", files: ["C:\\Users\\vikas\\secret.txt"],
    pullRequest: "https://example.test/API_KEY=sk-ant-api03-secret-value",
    steps: [{ seq: 1, kind: "read", label: "Read C:\\Users\\vikas\\notes API_KEY=sk-ant-api03-secret-value", ok: true }],
    artifacts: [{ id: "sk-ant-api03-secret-value", name: "C:\\Users\\vikas\\secret.txt" }],
  });
  const projection = compareRuns(hostile, hostile).left;
  assert.equal(projection.accessible, true);
  assert.doesNotMatch(JSON.stringify(projection), /C:\\Users|sk-ant|API_KEY=sk-ant|ghp_/i);
});

test("checkpoint validation rejects unsupported step kinds and overlarge bounds", () => {
  const cp = buildRunCheckpoint(run());
  const badKind = validateRunCheckpoint({ ...cp, completedSteps: [{ seq: 1, kind: "forged", label: "x", ok: true }] });
  const badBound = validateRunCheckpoint({ ...cp, completedStepSeq: 999 });
  assert.ok(badKind); assert.match(badKind, /unusable steps/);
  assert.ok(badBound); assert.match(badBound, /step is not usable/);
});
