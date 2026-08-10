const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
const shared = fs.readFileSync(path.join(__dirname, "..", "..", "..", "packages", "shared", "src", "index.ts"), "utf8");
const relay = fs.readFileSync(path.join(__dirname, "..", "..", "relay", "src", "server.ts"), "utf8");

test("approval cards expose accessible inline checkpoint actions and bounded forms", () => {
  const card = app.slice(app.indexOf("function ApprovalCheckpointControls"), app.indexOf("/** The moment an agent stops"));
  assert.match(card, /Approve/);
  assert.match(card, /Reject/);
  assert.match(card, /Edit instructions/);
  assert.match(card, /Ask a question/);
  assert.match(card, /aria-expanded/);
  assert.match(card, /Revised instructions/);
  assert.match(card, /Question for the approval thread/);
  assert.match(card, /maxLength=\{4000\}/);
  assert.match(card, /maxLength=\{1000\}/);
  assert.match(card, /disabled=\{!connected\}/);
  assert.match(card, /expectedRevision: revision/);
  assert.match(card, /approvalEpoch/);
  assert.match(card, /canReviseInstructions/);
  assert.match(card, /approval\.kind === undefined \|\| approval\.kind === "task"/);
  assert.match(card, /legacyPending/);
  assert.match(card, /older Cloud9 session/);
  assert.match(card, /Refresh Cloud9/);
  assert.match(card, /const canAsk = canDecide/);
  assert.doesNotMatch(card, /onOpenTasks=\{\(\) => undefined\}/);
  assert.match(css, /\.approval-checkpoint/);
  assert.match(css, /\.approval-edit textarea/);
});

test("checkpoint edits/questions use the same current-access, epoch-gated relay path", () => {
  assert.match(shared, /type ApprovalCheckpointDecision = "approved" \| "rejected" \| "edit" \| "question"/);
  assert.match(shared, /type: "editApproval"/);
  assert.match(shared, /type: "askApprovalQuestion"/);
  assert.match(shared, /revision\?: number/);
  assert.match(shared, /approvalEpoch\?: string/);
  assert.match(shared, /actorId: ID/);
  assert.match(shared, /validateApprovalCheckpointRequestId/);
  assert.match(relay, /this\.channelFor\(conn\.userId, approval\.channelId\)/);
  assert.match(relay, /this\.store\.agents\(\)\.find\(a => a\.id === approval\.agentId/);
  assert.match(relay, /Number\.isSafeInteger\(frame\.expectedRevision\)/);
  assert.match(relay, /frame\.approvalEpoch !== epoch/);
  assert.match(relay, /const prior = approval\.checkpointReceipts/);
  assert.match(relay, /actorId: conn\.userId/);
  assert.match(relay, /prior\.actorId !== conn\.userId/);
  assert.match(relay, /validateApprovalCheckpointRequestId/);
  assert.match(relay, /this approval kind cannot safely revise its instructions/);
  assert.match(relay, /const audience = new Set<ID>\(\)/);
  assert.match(relay, /approval\.requesterId === userId/);
  assert.match(relay, /approval changed; refresh it/);
  assert.match(relay, /approval_checkpoint/);
  assert.match(relay, /approval\.status !== "pending"/);
});
