import test from "node:test";
import assert from "node:assert/strict";
import { AgentDef, Channel } from "@cloud9/shared";
import { CHANNEL_MEMORY_POLICY_SCHEMA_VERSION, SCHEMA_VERSION, Store } from "./store.js";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const agent = (id: string, ownerId: string): AgentDef => ({
  id, ownerId, name: id, emoji: "A", persona: "research",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
  createdAt: 1,
});

test("channel memory policy migration is sequential and survives reopen", () => {
  const dbPath = tmp("channel-memory-policy-migration.db");
  const first = new Store(dbPath, { ownerToken: "tok-owner" });
  const owner = first.ensureOwner("Vikas", "tok-owner");
  const channel: Channel = {
    id: "channel-policy", name: "policy", kind: "channel",
    memberIds: [owner.id, "agent-policy"], createdAt: 1,
  };
  first.saveAgent(agent("agent-policy", owner.id));
  first.createChannel(channel, owner.id);
  const saved = first.setChannelMemoryPolicy({
    ownerId: owner.id, actorId: owner.id, channelId: channel.id,
    agentId: "agent-policy", mode: "summary", requestId: "policy-1",
  });
  assert.equal(saved.policy.revision, 1);
  assert.equal(first.schemaVersion(), CHANNEL_MEMORY_POLICY_SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, CHANNEL_MEMORY_POLICY_SCHEMA_VERSION);
  first.db.close();

  const reopened = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(reopened.schemaVersion(), SCHEMA_VERSION);
  assert.equal(reopened.channelMemoryPolicy(channel.id, "agent-policy")?.mode, "summary");
  assert.equal(reopened.channelMemoryPolicyAudit(channel.id, "agent-policy").length, 1);
  const replay = reopened.setChannelMemoryPolicy({
    ownerId: owner.id, actorId: owner.id, channelId: channel.id,
    agentId: "agent-policy", mode: "summary", requestId: "policy-1",
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.policy.revision, 1);
  assert.throws(() => reopened.setChannelMemoryPolicy({
    ownerId: owner.id, actorId: owner.id, channelId: channel.id,
    agentId: "agent-policy", mode: "explicit", requestId: "policy-1",
  }), /different change/i, "a receipt cannot be replayed with a different payload");
  assert.equal(reopened.channelMemoryPolicy("missing-channel", "agent-policy"), undefined);
  assert.equal(reopened.channelMemoryPolicy(channel.id, "not-a-member"), undefined);
  assert.throws(() => reopened.setChannelMemoryPolicy({
    ownerId: owner.id, actorId: owner.id, channelId: "missing-channel",
    agentId: "agent-policy", mode: "summary", requestId: "unknown-channel",
  }), /not in this channel/i);
  reopened.db.close();
});

test("channel policy deletion removes policy, audit, and receipt rows", () => {
  const store = new Store(tmp("channel-memory-policy-cleanup.db"), { ownerToken: "tok-owner" });
  const owner = store.ensureOwner("Vikas", "tok-owner");
  const channel: Channel = {
    id: "channel-cleanup", name: "cleanup", kind: "channel",
    memberIds: [owner.id, "agent-cleanup"], createdAt: 1,
  };
  store.saveAgent(agent("agent-cleanup", owner.id));
  store.createChannel(channel, owner.id);
  store.setChannelMemoryPolicy({ ownerId: owner.id, actorId: owner.id,
    channelId: channel.id, agentId: "agent-cleanup", mode: "explicit", requestId: "cleanup-1" });
  store.deleteAgent("agent-cleanup");
  const count = (table: string): number => Number((store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE agentId=?`).get("agent-cleanup") as { n: number }).n);
  assert.equal(count("channel_memory_policies"), 0);
  assert.equal(count("channel_memory_policy_audit"), 0);
  assert.equal(count("channel_memory_policy_receipts"), 0);
  store.db.close();
});

test("a replay never fabricates the effective default when its persisted policy row is gone", () => {
  const store = new Store(tmp("channel-memory-policy-replay-row-missing.db"), { ownerToken: "tok-owner" });
  const owner = store.ensureOwner("Vikas", "tok-owner");
  const channel: Channel = {
    id: "channel-replay-row-missing", name: "replay-row-missing", kind: "channel",
    memberIds: [owner.id, "agent-replay-row-missing"], createdAt: 1,
  };
  store.saveAgent(agent("agent-replay-row-missing", owner.id));
  store.createChannel(channel, owner.id);
  const first = store.setChannelMemoryPolicy({
    ownerId: owner.id, actorId: owner.id, channelId: channel.id,
    agentId: "agent-replay-row-missing", mode: "summary", requestId: "replay-missing-1",
  });
  assert.equal(first.policy.revision, 1);
  store.db.prepare(
    "DELETE FROM channel_memory_policies WHERE channelId=? AND agentId=?",
  ).run(channel.id, "agent-replay-row-missing");

  // The receipt still exists, but there is no persisted authoritative row.
  // Replaying must discard that receipt and take the ordinary mutation path;
  // returning the effective room default here would falsely look like rev1.
  const replay = store.setChannelMemoryPolicy({
    ownerId: owner.id, actorId: owner.id, channelId: channel.id,
    agentId: "agent-replay-row-missing", mode: "summary", requestId: "replay-missing-1",
  });
  assert.equal(replay.replayed, false);
  assert.equal(replay.policy.mode, "summary");
  assert.equal(replay.policy.revision, 1);
  assert.equal(store.db.prepare(
    "SELECT COUNT(*) AS n FROM channel_memory_policy_receipts WHERE ownerId=? AND requestId=?",
  ).get(owner.id, "replay-missing-1")?.n, 1);
  store.db.close();
});

test("relay exposes policy to members, gates owner/admin writes, and mirrors without request ids", async () => {
  const relay = new Relay({ dbPath: tmp("channel-memory-policy-relay.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  let guest: TestClient | undefined;
  let mirror: TestClient | undefined;
  try {
    const welcome = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
    const ownerAgentInput = agent("agent-owner", welcome.state.me.id);
    owner.send({ type: "createAgent", agent: ownerAgentInput });
    const ownerAgent = (await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "agent" }>>(
      f => f.type === "agent" && f.agent.name === ownerAgentInput.name)).agent;

    owner.send({ type: "createInvite" });
    const invite = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "invite" }>>(f => f.type === "invite");
    guest = new TestClient(url, `invite:${invite.code}:Raj`);
    const guestWelcome = await guest.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
    const guestAgentInput = agent("agent-guest", guestWelcome.state.me.id);
    guest.send({ type: "createAgent", agent: guestAgentInput });
    const guestAgent = (await guest.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "agent" }>>(
      f => f.type === "agent" && f.agent.name === guestAgentInput.name)).agent;

    owner.send({ type: "createChannel", name: "memory-policy-room", kind: "channel", memberIds: [guestWelcome.state.me.id, ownerAgent.id, guestAgent.id] });
    const room = (await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "channel" }>>(f => f.type === "channel" && f.channel.name === "memory-policy-room")).channel;
    mirror = new TestClient(url, "tok-owner");
    await mirror.wait(f => f.type === "welcome");
    owner.frames.length = 0; mirror.frames.length = 0; guest.frames.length = 0;

  owner.send({ type: "setChannelMemoryPolicy", channelId: room.id, agentId: ownerAgent.id, mode: "summary", requestId: "policy-set-1" });
  const direct = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "channelMemoryPolicy" }>>(
    f => f.type === "channelMemoryPolicy" && f.requestId === "policy-set-1");
  assert.equal(direct.policy.mode, "summary");
  const mirrored = await mirror.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "channelMemoryPolicy" }>>(
    f => f.type === "channelMemoryPolicy" && f.requestId === undefined && f.policy.agentId === ownerAgent.id);
  assert.equal(mirrored.policy.revision, 1);

  // A second window advances the same policy before the first window retries
  // its original request. The replay must project the current rev2 to both
  // windows; sending the receipt's old resultJson would regress the mirror to
  // rev1.
  owner.frames.length = 0;
  mirror.frames.length = 0;
  owner.send({ type: "setChannelMemoryPolicy", channelId: room.id, agentId: ownerAgent.id,
    mode: "explicit", expectedRevision: 1, requestId: "policy-set-2" });
  const rev2 = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "channelMemoryPolicy" }>>(
    f => f.type === "channelMemoryPolicy" && f.requestId === "policy-set-2");
  assert.equal(rev2.policy.revision, 2);
  await mirror.wait(f => f.type === "channelMemoryPolicy" && f.requestId === undefined && f.policy.revision === 2);

  owner.frames.length = 0;
  mirror.frames.length = 0;
  owner.send({ type: "setChannelMemoryPolicy", channelId: room.id, agentId: ownerAgent.id,
    mode: "summary", requestId: "policy-set-1" });
  const replay = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "channelMemoryPolicy" }>>(
    f => f.type === "channelMemoryPolicy" && f.requestId === "policy-set-1");
  assert.equal(replay.policy.revision, 2);
  assert.equal(replay.policy.mode, "explicit");
  const replayMirror = await mirror.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "channelMemoryPolicy" }>>(
    f => f.type === "channelMemoryPolicy" && f.requestId === undefined);
  assert.equal(replayMirror.policy.revision, 2);
  assert.equal(replayMirror.policy.mode, "explicit");

  guest.send({ type: "setChannelMemoryPolicy", channelId: room.id, agentId: guestAgent.id, mode: "summary", requestId: "member-denied" });
  const denied = await guest.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "member-denied");
  assert.match(denied.error, /run this conversation/);
  owner.send({ type: "setChannelMemoryPolicy", channelId: room.id, agentId: guestAgent.id, mode: "summary", requestId: "foreign-denied" });
  const foreign = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "foreign-denied");
  assert.match(foreign.error, /own agent/);

  owner.send({ type: "setMemberRole", channelId: room.id, memberId: guestWelcome.state.me.id, role: "admin" });
  await guest.wait(f => f.type === "channelMembers" && f.members.some(m => m.memberId === guestWelcome.state.me.id && m.role === "admin"));
  guest.send({ type: "setChannelMemoryPolicy", channelId: room.id, agentId: guestAgent.id, mode: "summary", requestId: "admin-policy" });
  const admin = await guest.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "channelMemoryPolicy" }>>(f => f.type === "channelMemoryPolicy" && f.requestId === "admin-policy");
  assert.equal(admin.policy.mode, "summary");

  owner.send({ type: "createChannel", name: "dm-with-agent", kind: "dm", memberIds: [ownerAgent.id] });
  const dm = (await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "channel" }>>(f => f.type === "channel" && f.channel.name === "dm-with-agent")).channel;
  owner.send({ type: "channelMemoryPolicies", channelId: dm.id, requestId: "dm-list" });
  const dmPolicy = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "channelMemoryPolicies" }>>(f => f.type === "channelMemoryPolicies" && f.requestId === "dm-list");
  assert.equal(dmPolicy.policies[0]?.mode, "none");
  owner.send({ type: "setChannelMemoryPolicy", channelId: dm.id, agentId: ownerAgent.id, mode: "explicit", requestId: "dm-write" });
  const dmDenied = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "dm-write");
  assert.match(dmDenied.error, /direct conversation/);

  } finally {
    owner.close(); mirror?.close(); guest?.close(); relay.close();
  }
});

test("channel policy receipts keep only the latest 512 per owner inside the 30-day window", () => {
  const store = new Store(tmp("channel-memory-policy-receipt-cap.db"), { ownerToken: "tok-owner" });
  const owner = store.ensureOwner("Vikas", "tok-owner");
  const channel: Channel = {
    id: "channel-receipt-cap", name: "receipt-cap", kind: "channel",
    memberIds: [owner.id, "agent-receipt-cap"], createdAt: 1,
  };
  store.saveAgent(agent("agent-receipt-cap", owner.id));
  store.createChannel(channel, owner.id);
  for (let i = 0; i < 513; i++) {
    store.setChannelMemoryPolicy({
      ownerId: owner.id, actorId: owner.id, channelId: channel.id,
      agentId: "agent-receipt-cap", mode: i % 2 === 0 ? "summary" : "explicit",
      requestId: `receipt-${i}`,
    });
  }
  const count = Number((store.db.prepare(
    "SELECT COUNT(*) AS n FROM channel_memory_policy_receipts WHERE ownerId=?",
  ).get(owner.id) as { n: number }).n);
  assert.equal(count, 512);
  assert.equal(store.db.prepare(
    "SELECT 1 AS found FROM channel_memory_policy_receipts WHERE ownerId=? AND requestId=?",
  ).get(owner.id, "receipt-512")?.found, 1);
  store.db.prepare(
    "UPDATE channel_memory_policy_receipts SET createdAt=? WHERE ownerId=? AND requestId=?",
  ).run(Date.now() - 31 * 24 * 60 * 60 * 1000, owner.id, "receipt-512");
  const expired = store.setChannelMemoryPolicy({
    ownerId: owner.id, actorId: owner.id, channelId: channel.id,
    agentId: "agent-receipt-cap", mode: "summary", requestId: "receipt-512",
  });
  assert.equal(expired.replayed, false, "a receipt older than 30 days is no longer an idempotent replay");
  assert.equal(expired.policy.revision, 514);
  store.db.close();
});
