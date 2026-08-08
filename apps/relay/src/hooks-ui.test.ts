import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

test("owner hook CRUD is durable, correlated, validated, and idempotent", async t => {
  const relay = new Relay({ dbPath: tmp("hooks-ui.db"), ownerToken: "owner", ownerName: "Owner" });
  const port = await relay.listen(0); const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "owner"); await owner.wait(f => f.type === "welcome");
  const otherWindow = new TestClient(url, "owner"); await otherWindow.wait(f => f.type === "welcome");
  const engine = new TestClient(url, "owner", "engine"); await engine.wait(f => f.type === "hooksUpdated");
  t.after(() => { owner.close(); otherWindow.close(); engine.close(); relay.close(); });
  owner.send({ type: "createAgent", agent: { name: "Hook bot", emoji: "🤖", persona: "Does hook work", abilities: { webSearch: false, files: false, schedules: false, background: false } } as never });
  const agent = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Hook bot");
  owner.send({ type: "hooks", requestId: "list-1" });
  const listed = await owner.wait<Extract<ServerFrame, { type: "hooks" }>>(f => f.type === "hooks" && f.requestId === "list-1");
  assert.deepEqual(listed.hooks, []);
  const hook = { name: "Finished note", event: "turn.finished" as const, enabled: true, action: { do: "note" as const, agentId: agent.agent.id, text: "Review the result" } };
  owner.send({ type: "createHook", hook, requestId: "create-1" });
  const created = await owner.wait<Extract<ServerFrame, { type: "hook" }>>(f => f.type === "hook" && f.requestId === "create-1");
  const mirroredCreate = await otherWindow.wait<Extract<ServerFrame, { type: "hook" }>>(f => f.type === "hook" && !f.requestId && f.hook.id === created.hook.id);
  assert.equal(mirroredCreate.hook.id, created.hook.id);
  const synced = await engine.wait<Extract<ServerFrame, { type: "hooksUpdated" }>>(f => f.type === "hooksUpdated" && f.hooks.some(h => h.id === created.hook.id));
  assert.equal(synced.hooks[0]?.id, created.hook.id);
  owner.send({ type: "createHook", hook, requestId: "create-1" });
  const replay = await owner.wait<Extract<ServerFrame, { type: "hook" }>>(f => f.type === "hook" && f.requestId === "create-1");
  assert.equal(replay.hook.id, created.hook.id);
  owner.send({ type: "setHookEnabled", hookId: created.hook.id, enabled: false, requestId: "disable-1" });
  const disabled = await owner.wait<Extract<ServerFrame, { type: "hook" }>>(f => f.type === "hook" && f.requestId === "disable-1" && f.hook.id === created.hook.id && !f.hook.enabled);
  assert.equal(disabled.requestId, "disable-1");
  const mirroredDisable = await otherWindow.wait<Extract<ServerFrame, { type: "hook" }>>(f => f.type === "hook" && !f.requestId && f.hook.id === created.hook.id && !f.hook.enabled);
  assert.equal(mirroredDisable.hook.enabled, false);
  owner.send({ type: "setHookEnabled", hookId: created.hook.id, enabled: false, requestId: "disable-1" });
  await owner.wait(f => f.type === "hook" && f.requestId === "disable-1" && !f.hook.enabled);
  owner.send({ type: "testHook", hookId: created.hook.id, requestId: "test-1" });
  const refused = await owner.wait<Extract<ServerFrame, { type: "hookTest" }>>(f => f.type === "hookTest" && f.requestId === "test-1");
  assert.equal(refused.ok, false);
  owner.send({ type: "testHook", hookId: created.hook.id, requestId: "test-1" });
  await owner.wait(f => f.type === "hookTest" && f.requestId === "test-1" && !f.ok);
  owner.send({ type: "updateHook", hookId: created.hook.id, hook: { ownerId: "someone-else" } as never, requestId: "bad-update" });
  const badUpdate = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "bad-update");
  assert.match(badUpdate.error, /unsupported field/);
  owner.send({ type: "createHook", hook: { ...hook, action: { do: "command", agentId: agent.agent.id, command: "whoami" } } as never, requestId: "bad-action" });
  const badAction = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "bad-action");
  assert.match(badAction.error, /unsupported|not supported/);
  owner.send({ type: "createHook", hook: { ...hook, when: { agentId: "not-owned" } }, requestId: "bad-when" });
  const badWhen = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "bad-when");
  assert.match(badWhen.error, /agent/);
  engine.send({ type: "hookFired", hookId: created.hook.id, event: "turn.finished", ok: false, said: "disabled", at: Date.now(), firingId: "hookfiring_test-1" });
  await new Promise(resolve => setTimeout(resolve, 50));
  const audit = relay.store.hookAuditOf(relay.ownerId);
  assert.ok(audit.some(row => row.action === "refused" && row.client === "engine" && row.hookId === created.hook.id));
  const auditCount = audit.length;
  // The same engine report may be retried after a reconnect, but it is one
  // firing and therefore one audit row.
  engine.send({ type: "hookFired", hookId: created.hook.id, event: "turn.finished", ok: false, said: "disabled", at: Date.now(), firingId: "hookfiring_test-1" });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(relay.store.hookAuditOf(relay.ownerId).length, auditCount);
  engine.send({ type: "hookFired", hookId: created.hook.id, event: "job.finished", ok: true, said: "wrong event", at: Date.now(), firingId: "hookfiring_test-2" });
  const wrongEvent = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(wrongEvent.error, /does not match/);
  engine.send({ type: "hookFired", hookId: created.hook.id, event: "turn.finished", ok: true, said: "queued to relay", at: Date.now(), firingId: "hookfiring_test-3" });
  await new Promise(resolve => setTimeout(resolve, 50));
  const dispatched = relay.store.hookAuditOf(relay.ownerId).find(row => row.requestId === "hookfiring_test-3");
  assert.deepEqual(dispatched && { action: dispatched.action, ok: dispatched.ok }, { action: "dispatched", ok: false });
  owner.send({ type: "hooksAudit", requestId: "audit-1" });
  const auditFrame = await owner.wait<Extract<ServerFrame, { type: "hookAudit" }>>(f => f.type === "hookAudit" && f.requestId === "audit-1");
  assert.ok(auditFrame.entries.some(row => row.requestId === "hookfiring_test-3" && row.said === "queued to relay"));
  // A CRUD request id may equal a firing id without suppressing the distinct
  // firing namespace; dedupe is bound to the firing target, not id alone.
  owner.send({ type: "updateHook", hookId: created.hook.id, hook: { name: "Collision" }, requestId: "same-id" });
  await owner.wait(f => f.type === "hook" && f.requestId === "same-id");
  const beforeCollision = relay.store.hookAuditOf(relay.ownerId).length;
  engine.send({ type: "hookFired", hookId: created.hook.id, event: "turn.finished", ok: false, said: "collision fire", at: Date.now(), firingId: "same-id" });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(relay.store.hookAuditOf(relay.ownerId).length, beforeCollision + 1);
  owner.send({ type: "deleteHook", hookId: created.hook.id, requestId: "delete-1" });
  const gone = await owner.wait<Extract<ServerFrame, { type: "hooks" }>>(f => f.type === "hooks" && f.requestId === "delete-1");
  assert.deepEqual(gone.hooks, []);
  const mirroredDelete = await otherWindow.wait<Extract<ServerFrame, { type: "hooks" }>>(f => f.type === "hooks" && !f.requestId && f.hooks.length === 0);
  assert.deepEqual(mirroredDelete.hooks, []);
  owner.send({ type: "deleteHook", hookId: created.hook.id, requestId: "delete-1" });
  const replayDelete = await owner.wait<Extract<ServerFrame, { type: "hooks" }>>(f => f.type === "hooks" && f.requestId === "delete-1");
  assert.deepEqual(replayDelete.hooks, []);
});

test("relay enforces the fifty-hook owner limit", async t => {
  const relay = new Relay({ dbPath: tmp("hooks-limit.db"), ownerToken: "owner", ownerName: "Owner" });
  const port = await relay.listen(0); const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "owner"); await owner.wait(f => f.type === "welcome");
  t.after(() => { owner.close(); relay.close(); });
  owner.send({ type: "createAgent", agent: { name: "Limit bot", emoji: "🤖", persona: "Does hook work", abilities: { webSearch: false, files: false, schedules: false, background: false } } as never });
  const agent = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Limit bot");
  for (let i = 0; i < 50; i++) {
    const requestId = `limit-${i}`;
    owner.send({
      type: "createHook", requestId,
      hook: { name: `Hook ${i}`, event: "turn.finished", enabled: true,
        action: { do: "note", agentId: agent.agent.id, text: "ok" } },
    });
    await owner.wait(f => f.type === "hook" && f.requestId === requestId);
  }
  owner.send({
    type: "createHook", requestId: "limit-51",
    hook: { name: "Hook 51", event: "turn.finished", enabled: true,
      action: { do: "note", agentId: agent.agent.id, text: "no" } },
  });
  const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "limit-51");
  assert.match(refused.error, /at most 50/);
  // Cap enforcement must not break idempotent replay of an already-accepted
  // request once the owner is full.
  owner.send({
    type: "createHook", requestId: "limit-49",
    hook: { name: "Hook 49", event: "turn.finished", enabled: true,
      action: { do: "note", agentId: agent.agent.id, text: "ok" } },
  });
  const replay = await owner.wait<Extract<ServerFrame, { type: "hook" }>>(f => f.type === "hook" && f.requestId === "limit-49");
  assert.equal(replay.hook.name, "Hook 49");
});

test("hook action replacement drops fields from the previous action kind", async t => {
  const relay = new Relay({ dbPath: tmp("hooks-action-replace.db"), ownerToken: "owner", ownerName: "Owner" });
  const port = await relay.listen(0); const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "owner"); await owner.wait(f => f.type === "welcome");
  t.after(() => { owner.close(); relay.close(); });
  owner.send({ type: "createAgent", agent: { name: "Action bot", emoji: "🤖", persona: "Does hook work", abilities: { webSearch: false, files: false, schedules: false, background: false } } as never });
  const agent = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Action bot");
  owner.send({ type: "createChannel", name: "action-room", memberIds: [agent.agent.id] });
  const channel = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(f => f.type === "channel" && f.channel.name === "action-room");
  owner.send({ type: "createHook", requestId: "replace-create", hook: { name: "Replace me", event: "turn.finished", enabled: true, action: { do: "note", agentId: agent.agent.id, text: "old note" } } });
  const created = await owner.wait<Extract<ServerFrame, { type: "hook" }>>(f => f.type === "hook" && f.requestId === "replace-create");
  owner.send({ type: "updateHook", hookId: created.hook.id, requestId: "replace-update", hook: { action: { do: "job", agentId: agent.agent.id, channelId: channel.channel.id, title: "new job" } } });
  const updated = await owner.wait<Extract<ServerFrame, { type: "hook" }>>(f => f.type === "hook" && f.requestId === "replace-update");
  assert.deepEqual(updated.hook.action, { do: "job", agentId: agent.agent.id, channelId: channel.channel.id, title: "new job" });
});

test("replaying a test receipt after hook deletion answers with a refusal", async t => {
  const relay = new Relay({ dbPath: tmp("hooks-test-replay.db"), ownerToken: "owner", ownerName: "Owner" });
  const port = await relay.listen(0); const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "owner"); await owner.wait(f => f.type === "welcome");
  t.after(() => { owner.close(); relay.close(); });
  owner.send({ type: "createAgent", agent: { name: "Replay bot", emoji: "🤖", persona: "Does hook work", abilities: { webSearch: false, files: false, schedules: false, background: false } } as never });
  const agent = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Replay bot");
  owner.send({ type: "createHook", requestId: "replay-create", hook: { name: "Replay", event: "turn.finished", enabled: true, action: { do: "note", agentId: agent.agent.id, text: "note" } } });
  const created = await owner.wait<Extract<ServerFrame, { type: "hook" }>>(f => f.type === "hook" && f.requestId === "replay-create");
  owner.send({ type: "testHook", hookId: created.hook.id, requestId: "replay-test" });
  await owner.wait(f => f.type === "hookTest" && f.requestId === "replay-test");
  owner.send({ type: "deleteHook", hookId: created.hook.id, requestId: "replay-delete" });
  await owner.wait(f => f.type === "hooks" && f.requestId === "replay-delete");
  owner.send({ type: "testHook", hookId: created.hook.id, requestId: "replay-test" });
  const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "replay-test");
  assert.match(refused.error, /no longer exists/);
});

test("hook request and audit ledgers stay bounded", async t => {
  const relay = new Relay({ dbPath: tmp("hooks-retention.db"), ownerToken: "owner", ownerName: "Owner" });
  t.after(() => relay.store.db.close());
  for (let i = 0; i < 520; i++) {
    relay.store.saveHookRequest(relay.ownerId, `request-${i}`, `hook-${i}`, "test", `hook-${i}`, "{}");
    relay.store.logHookAudit(relay.ownerId, `hook-${i}`, "tested", true, "ok", Date.now(), relay.ownerId, "desktop", `audit-${i}`, `hook-${i}`);
  }
  const requestCount = (relay.store.db.prepare("SELECT COUNT(*) AS n FROM hook_requests WHERE ownerId=?").get(relay.ownerId) as { n: number }).n;
  const auditCount = (relay.store.db.prepare("SELECT COUNT(*) AS n FROM hook_audit WHERE ownerId=?").get(relay.ownerId) as { n: number }).n;
  assert.equal(requestCount, 512);
  assert.equal(auditCount, 512);
  assert.equal(relay.store.hookAuditOf(relay.ownerId).length, 512);
});
