import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

test("owner hook CRUD is durable, correlated, validated, and idempotent", async t => {
  const relay = new Relay({ dbPath: tmp("hooks-ui.db"), ownerToken: "owner", ownerName: "Owner" });
  const port = await relay.listen(0); const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "owner"); await owner.wait(f => f.type === "welcome");
  const engine = new TestClient(url, "owner", "engine"); await engine.wait(f => f.type === "hooksUpdated");
  t.after(() => { owner.close(); engine.close(); relay.close(); });
  owner.send({ type: "createAgent", agent: { name: "Hook bot", emoji: "🤖", persona: "Does hook work", abilities: { webSearch: false, files: false, schedules: false, background: false } } as never });
  const agent = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Hook bot");
  owner.send({ type: "hooks", requestId: "list-1" });
  const listed = await owner.wait<Extract<ServerFrame, { type: "hooks" }>>(f => f.type === "hooks" && f.requestId === "list-1");
  assert.deepEqual(listed.hooks, []);
  const hook = { name: "Finished note", event: "turn.finished" as const, enabled: true, action: { do: "note" as const, agentId: agent.agent.id, text: "Review the result" } };
  owner.send({ type: "createHook", hook, requestId: "create-1" });
  const created = await owner.wait<Extract<ServerFrame, { type: "hook" }>>(f => f.type === "hook" && f.requestId === "create-1");
  const synced = await engine.wait<Extract<ServerFrame, { type: "hooksUpdated" }>>(f => f.type === "hooksUpdated" && f.hooks.some(h => h.id === created.hook.id));
  assert.equal(synced.hooks[0]?.id, created.hook.id);
  owner.send({ type: "createHook", hook, requestId: "create-1" });
  const replay = await owner.wait<Extract<ServerFrame, { type: "hook" }>>(f => f.type === "hook" && f.requestId === "create-1");
  assert.equal(replay.hook.id, created.hook.id);
  owner.send({ type: "setHookEnabled", hookId: created.hook.id, enabled: false, requestId: "disable-1" });
  const disabled = await owner.wait<Extract<ServerFrame, { type: "hook" }>>(f => f.type === "hook" && f.requestId === "disable-1" && f.hook.id === created.hook.id && !f.hook.enabled);
  assert.equal(disabled.requestId, "disable-1");
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
  owner.send({ type: "deleteHook", hookId: created.hook.id, requestId: "delete-1" });
  const gone = await owner.wait<Extract<ServerFrame, { type: "hooks" }>>(f => f.type === "hooks" && f.requestId === "delete-1");
  assert.deepEqual(gone.hooks, []);
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
});
