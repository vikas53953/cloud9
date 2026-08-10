import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildRunCheckpoint, recoveryRequestFingerprint, type RecoveryReceipt, type RecoveryRequest, type RunRecord } from "@cloud9/shared";
import { Store } from "./store.js";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r-recovery-1", kind: "chat", agentId: "agent-1", agentName: "Scout", provider: "claude",
    requestedBy: "Vikas", requestedByKind: "human", ask: "inspect", startedAt: 1, finishedAt: 2,
    durationMs: 1, outcome: "failed", steps: [{ seq: 1, kind: "read", label: "Read README", ok: true }],
    replyChars: 0, events: 1, ...over,
  };
}

test("restart settles a recovery approval even when its receipt was never written", () => {
  const db = tmp("run-recovery-restart-missing-receipt.db");
  const seeded = new Store(db, { ownerToken: "tok-restart" });
  const owner = seeded.ensureOwner("Vikas", "tok-restart");
  seeded.saveApproval({
    id: "ap-recovery-restart", agentId: "agent-1", ownerId: owner.id,
    action: "Retry Scout's run", status: "pending", createdAt: 1, kind: "action",
    recoveryRequestId: "recover-missing",
  });
  seeded.close();

  const relay = new Relay({ dbPath: db, ownerToken: "tok-restart", ownerName: "Vikas" });
  const settled = relay.store.approval("ap-recovery-restart");
  assert.equal(settled?.status, "expired");
  assert.match(settled?.detail ?? "", /reconstructed/i);
  relay.close();
  fs.rmSync(path.dirname(db), { recursive: true, force: true });
});

test("checkpoint and recovery receipts survive reopen and stay bounded", () => {
  const db = tmp("run-recovery.db");
  const store = new Store(db);
  const row = { record: record(), agentId: "agent-1", ownerId: "owner-1" };
  store.saveRun(row);
  const cp = buildRunCheckpoint(record(), { providerSession: {
    provider: "claude", sessionId: "11111111-1111-4111-8111-111111111111", canResume: false,
    reason: "not reported", actionSemantics: "unknown",
  } });
  store.saveCheckpoint(cp);
  const request: RecoveryRequest = {
    requestId: "recover-1", requesterId: "owner-1", agentId: "agent-1", runId: record().id,
    payload: { mode: "retry", ask: "inspect", approvalEpoch: "epoch-1" },
  };
  const receipt: RecoveryReceipt = { request, payloadFingerprint: recoveryRequestFingerprint(request), status: "accepted", createdAt: 100 };
  store.saveRecoveryReceipt(receipt);
  assert.equal(store.checkpoint(cp.id)?.runId, record().id);
  assert.equal(store.recoveryReceipt("owner-1", "recover-1")?.status, "accepted");
  const reopened = new Store(db);
  assert.equal(reopened.schemaVersion(), 16);
  assert.equal(reopened.checkpointsForRun(record().id).length, 1);
  assert.equal(reopened.recoveryReceipt("owner-1", "recover-1")?.request.runId, record().id);
  store.close(); reopened.close();
  fs.rmSync(path.dirname(db), { recursive: true, force: true });
});

test("recovery receipts keep only the latest 512 per owner", () => {
  const db = tmp("run-recovery-cap.db");
  const store = new Store(db);
  const row = { record: record(), agentId: "agent-1", ownerId: "owner-1" };
  store.saveRun(row);
  for (let i = 0; i < 520; i++) {
    const request: RecoveryRequest = {
      requestId: `recover-cap-${i}`, requesterId: "owner-1", agentId: "agent-1", runId: record().id,
      payload: { mode: "retry", ask: "inspect", approvalEpoch: `epoch-${i}` },
    };
    store.saveRecoveryReceipt({
      request, payloadFingerprint: recoveryRequestFingerprint(request), status: "accepted", createdAt: 100 + i,
    });
  }
  assert.equal(store.recoveryReceipt("owner-1", "recover-cap-0"), undefined);
  assert.ok(store.recoveryReceipt("owner-1", "recover-cap-519"));
  store.close();
  fs.rmSync(path.dirname(db), { recursive: true, force: true });
});

test("checkpoint lookup rejects a corrupted owner or agent binding", () => {
  const dbPath = tmp("run-recovery-binding.db");
  const store = new Store(dbPath);
  const row = { record: record(), agentId: "agent-1", ownerId: "owner-1" };
  store.saveRun(row);
  const cp = buildRunCheckpoint(record());
  store.saveCheckpoint(cp);
  const db = (store as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } } }).db;
  db.prepare("UPDATE run_checkpoints SET ownerId=? WHERE id=?").run("other-owner", cp.id);
  assert.equal(store.checkpointForRun(record().id, "agent-1", "owner-1"), undefined);
  db.prepare("UPDATE run_checkpoints SET ownerId=? WHERE id=?").run("owner-1", cp.id);
  const wrongRun = buildRunCheckpoint(record({ id: "r-other" }));
  db.prepare("UPDATE run_checkpoints SET runId=?, json=? WHERE id=?")
    .run(record().id, JSON.stringify(wrongRun), cp.id);
  assert.equal(store.checkpointForRun(record().id, "agent-1", "owner-1"), undefined);
  store.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test("forged recovery authorization is refused; a server challenge gates one fresh retry", async () => {
  const db = tmp("run-recovery-auth.db");
  const relay = new Relay({ dbPath: db, ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const engine = new TestClient(url, "tok-owner", "engine");
  const welcome = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const ownerId = welcome.state.me.id;
  await engine.wait(f => f.type === "welcome");
  owner.send({ type: "createAgent", agent: {
    name: "Scout", emoji: "S", persona: "inspect", abilities: { webSearch: true, files: true, commands: true, schedules: false, background: false },
  } });
  const agent = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Scout");
  const channel = relay.store.channels()[0];
  engine.send({ type: "runRecorded", record: record({
    id: "r-auth-1", agentId: agent.agent.id, channelId: channel.id, outcome: "failed",
    ask: "inspect C:\\Users\\me sk-ant-api03-secret-value", error: "provider failed",
  }) });
  const pushed = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "run" }>>(f => f.type === "run" && f.record.id === "r-auth-1");
  assert.doesNotMatch(pushed.record.ask, /C:\\Users|sk-ant/i);
  owner.send({ type: "runRecovery", runId: pushed.record.id, mode: "retry", approvalEpoch: "forged", requestId: "forged-1" });
  const refused = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "forged-1");
  assert.match(refused.error, /authorization/i);
  assert.equal(engine.frames.some(f => f.type === "runRecoveryRequested"), false);
  assert.equal(relay.store.recoveryReceipt(ownerId, "forged-1"), undefined);

  owner.send({ type: "runRecovery", runId: pushed.record.id, mode: "retry", approvalEpoch: "", requestId: "real-1" });
  const challenge = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "runRecovery" }>>(
    f => f.type === "runRecovery" && f.requestId === "real-1" && !!f.decision.authorizationToken);
  owner.send({ type: "runRecovery", runId: pushed.record.id, mode: "restart", approvalEpoch: "", requestId: "real-1" });
  const challengeConflict = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "real-1");
  assert.match(challengeConflict.error, /already used/i);
  owner.send({ type: "runRecovery", runId: pushed.record.id, mode: "retry", approvalEpoch: challenge.decision.authorizationToken!, requestId: "real-1" });
  const approval = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "approval" }>>(
    f => f.type === "approval" && f.approval.recoveryRequestId === "real-1");
  assert.equal(engine.frames.some(f => f.type === "runRecoveryRequested"), false);
  owner.send({ type: "decideApproval", approvalId: approval.approval.id, decision: "approved" });
  await engine.wait(f => f.type === "runRecoveryRequested");
  const acceptedReceipt = relay.store.recoveryReceipt(ownerId, "real-1");
  assert.equal(acceptedReceipt?.status, "accepted");
  assert.doesNotMatch(JSON.stringify(acceptedReceipt), new RegExp(challenge.decision.authorizationToken!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  owner.send({ type: "runRecovery", runId: pushed.record.id, mode: "retry", approvalEpoch: challenge.decision.authorizationToken!, requestId: "real-1" });
  await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "runRecovery" }>>(
    f => f.type === "runRecovery" && f.requestId === "real-1" && !f.decision.authorizationToken);
  assert.equal(engine.frames.filter(f => f.type === "runRecoveryRequested").length, 1);
  owner.send({ type: "runRecovery", runId: pushed.record.id, mode: "restart", approvalEpoch: challenge.decision.authorizationToken!, requestId: "real-1" });
  const conflict = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "real-1");
  assert.match(conflict.error, /already used/i);
  owner.close(); engine.close();
  relay.close();
  fs.rmSync(path.dirname(db), { recursive: true, force: true });
});
