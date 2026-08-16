import test from "node:test";
import assert from "node:assert/strict";
import { AgentDef, Message, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "🤖", persona: "You handle delegated work",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
};

async function stand(name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const general = welcome.state.channels.find(c => c.name === "general")!;
  return { relay, owner, general };
}

async function createAgent(owner: TestClient, over: Partial<AgentDef> = {}): Promise<AgentDef> {
  const draft = { ...BASE_AGENT, ...over };
  owner.frames.length = 0;
  owner.send({ type: "createAgent", agent: draft as never });
  return (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === draft.name)).agent;
}

async function addAgent(owner: TestClient, channelId: string, agentId: string): Promise<void> {
  owner.send({ type: "addMembers", channelId, memberIds: [agentId] });
  await owner.wait(f => f.type === "channel" && f.channel.id === channelId
    && f.channel.memberIds.includes(agentId));
}

async function say(owner: TestClient, channelId: string, text: string, replyTo?: string): Promise<Message> {
  owner.send({ type: "send", channelId, text, ...(replyTo ? { replyTo } : {}) });
  return (await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.text === text)).message;
}

test("Hand this to… persists the source thread and correlates replay/conflict", async () => {
  const { relay, owner, general } = await stand("delegation-replay.db");
  const agent = await createAgent(owner, { name: "Researcher", respondTo: "anyone" });
  await addAgent(owner, general.id, agent.id);
  const root = await say(owner, general.id, "Please check this brief");
  const reply = await say(owner, general.id, "Keep the context", root.id);

  const request = {
    type: "createTask" as const, agentId: agent.id, channelId: general.id,
    title: reply.text, sourceMessageId: reply.id, sourceThreadId: root.id,
    requestId: "handoff-replay-1",
  };
  owner.frames.length = 0;
  owner.send(request);
  const first = await owner.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.requestId === request.requestId);
  assert.equal(first.task.sourceMessageId, reply.id);
  assert.equal(first.task.sourceThreadId, root.id);
  assert.equal(relay.store.tasks().length, 1);

  owner.send(request);
  const replay = await owner.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.requestId === request.requestId);
  assert.equal(replay.task.id, first.task.id, "a retry returns the durable task, not a duplicate");
  assert.equal(relay.store.tasks().length, 1);

  owner.send({ ...request, title: "different work" });
  const conflict = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === request.requestId);
  assert.match(conflict.error, /already used for different work/);
  assert.equal(relay.store.tasks().length, 1);
  owner.close(); await relay.close();
});

test("delegation rejects a non-member or paused room agent before minting work", async () => {
  const { relay, owner, general } = await stand("delegation-gates.db");
  const outside = await createAgent(owner, { name: "Outside", respondTo: "anyone" });
  const source = await say(owner, general.id, "A source message");
  owner.send({ type: "createTask", agentId: outside.id, channelId: general.id,
    title: source.text, sourceMessageId: source.id, requestId: "non-member" });
  const nonMember = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "non-member");
  assert.match(nonMember.error, /not in this conversation/);
  assert.equal(relay.store.tasks().length, 0);

  const paused = await createAgent(owner, { name: "Paused", lifecycle: "paused", respondTo: "anyone" });
  await addAgent(owner, general.id, paused.id);
  owner.send({ type: "createTask", agentId: paused.id, channelId: general.id,
    title: source.text, sourceMessageId: source.id, requestId: "paused-agent" });
  const pausedFrame = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "paused-agent");
  assert.match(pausedFrame.error, /paused by its owner/);
  assert.equal(relay.store.tasks().length, 0);
  owner.close(); await relay.close();
});

test("delegation approvals use the existing pending → accepted task lifecycle", async () => {
  const { relay, owner, general } = await stand("delegation-approval.db");
  const agent = await createAgent(owner, {
    name: "Gatekeeper", respondTo: "anyone", approvals: { background: true, schedules: false },
  });
  await addAgent(owner, general.id, agent.id);
  const source = await say(owner, general.id, "Run only after I approve");
  owner.send({ type: "createTask", agentId: agent.id, channelId: general.id,
    title: source.text, sourceMessageId: source.id, requestId: "approval-1" });
  const pending = await owner.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.requestId === "approval-1");
  assert.equal(pending.task.status, "waiting_approval");
  assert.ok(pending.task.approvalId);
  const card = await owner.wait<Extract<ServerFrame, { type: "approval" }>>(
    f => f.type === "approval" && f.approval.taskId === pending.task.id);
  owner.send({
    type: "decideApproval", approvalId: card.approval.id, decision: "approved",
    expectedRevision: card.approval.revision ?? 0,
    approvalEpoch: card.approval.approvalEpoch,
    requestId: "delegation-approve",
  });
  const accepted = await owner.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.id === pending.task.id && f.task.status === "not_started");
  assert.equal(accepted.task.status, "not_started");
  assert.equal(relay.store.approval(card.approval.id)?.status, "approved");
  owner.close(); await relay.close();
});

test("ordinary handoffs stay private and receipt replay reauthorizes after leaving", async t => {
  const relay = new Relay({ dbPath: tmp("delegation-audience.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const clients: TestClient[] = [owner];
  t.after(async () => { clients.forEach(client => client.close()); await relay.close(); });
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const general = welcome.state.channels.find(c => c.name === "general")!;
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const guest = new TestClient(url, `invite:${invite.code}:Guest`);
  clients.push(guest);
  const guestWelcome = await guest.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [guestWelcome.state.me.id] });
  await owner.wait(f => f.type === "channel" && f.channel.id === general.id
    && f.channel.memberIds.includes(guestWelcome.state.me.id));
  owner.send({ type: "createInvite" });
  const outsiderInvite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(
    f => f.type === "invite" && f.code !== invite.code);
  const outsider = new TestClient(url, `invite:${outsiderInvite.code}:Outsider`);
  clients.push(outsider);
  await outsider.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "createChannel", name: "handoff-room", kind: "channel",
    memberIds: [guestWelcome.state.me.id] });
  const room = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "handoff-room")).channel;
  const agent = await createAgent(owner, { name: "RoomAgent", respondTo: "anyone" });
  await addAgent(owner, room.id, agent.id);
  const source = await say(guest, room.id, "Guest handoff source");
  const request = { type: "createTask" as const, agentId: agent.id, channelId: room.id,
    title: source.text, sourceMessageId: source.id, requestId: "leave-replay-1" };
  owner.frames.length = 0; guest.frames.length = 0; outsider.frames.length = 0;
  guest.send(request);
  const created = await guest.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.requestId === request.requestId);
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(owner.frames.some(f => f.type === "task" && f.task.id === created.task.id), true);
  assert.equal(outsider.frames.some(f => f.type === "task" && f.task.id === created.task.id), false,
    "an outsider never receives a non-workflow task projection");
  guest.send({ type: "leaveChannel", channelId: room.id });
  await guest.wait(f => f.type === "channelLeft" && f.channelId === room.id);
  guest.frames.length = 0;
  guest.send(request);
  const replayRefused = await guest.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === request.requestId);
  assert.match(replayRefused.error, /no such channel|not in this conversation/i);
  assert.equal(relay.store.tasks().length, 1);
});

test("task request ids reject control characters and oversized values", async () => {
  const { relay, owner, general } = await stand("delegation-request-id.db");
  const agent = await createAgent(owner, { name: "IdGuard", respondTo: "anyone" });
  await addAgent(owner, general.id, agent.id);
  const source = await say(owner, general.id, "Request id guard");
  for (const requestId of ["bad\nrequest", "x".repeat(65)]) {
    owner.frames.length = 0;
    owner.send({ type: "createTask", agentId: agent.id, channelId: general.id,
      title: source.text, sourceMessageId: source.id, requestId });
    const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
      f => f.type === "error" && /request id is not usable/.test(f.error));
    assert.match(refused.error, /request id is not usable/);
  }
  assert.equal(relay.store.tasks().length, 0);
  owner.close(); await relay.close();
});
