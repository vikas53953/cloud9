import test from "node:test";
import assert from "node:assert/strict";
import { ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

async function stand(name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const owner = new TestClient(`ws://127.0.0.1:${port}`, "tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const channel = welcome.state.channels.find(c => c.name === "general")!;
  return { relay, owner, channel, port };
}

async function guestFor(owner: TestClient, channelId: string, port: number): Promise<TestClient> {
  const oldCodes = new Set(owner.frames.filter(frame => frame.type === "invite").map(frame => frame.code));
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite" && !oldCodes.has(f.code));
  const guest = new TestClient(`ws://127.0.0.1:${port}`, `invite:${invite.code}:Priya`);
  const welcome = await guest.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "addMembers", channelId, memberIds: [welcome.state.me.id] });
  await owner.wait(f => f.type === "channel" && f.channel.id === channelId && f.channel.memberIds.includes(welcome.state.me.id));
  return guest;
}

async function inviteOnly(owner: TestClient, port: number): Promise<TestClient> {
  const oldCodes = new Set(owner.frames.filter(frame => frame.type === "invite").map(frame => frame.code));
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite" && !oldCodes.has(f.code));
  const outsider = new TestClient(`ws://127.0.0.1:${port}`, `invite:${invite.code}:Outsider`);
  await outsider.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return outsider;
}

test("turning a message into a task preserves source thread/deadline and replays one request", async () => {
  const { relay, owner, channel, port } = await stand("message-task-create.db");
  owner.send({ type: "createAgent", agent: {
    name: "Scout", emoji: "🔭", persona: "researches", respondTo: "anyone",
    abilities: { webSearch: true, files: false, schedules: false, background: true },
  }});
  const agentFrame = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Scout");
  owner.send({ type: "addMembers", channelId: channel.id, memberIds: [agentFrame.agent.id] });
  await owner.wait(f => f.type === "channel" && f.channel.id === channel.id && f.channel.memberIds.includes(agentFrame.agent.id));

  owner.send({ type: "send", channelId: channel.id, text: "Please research this" });
  const source = await owner.wait<Extract<ServerFrame, { type: "message" }>>(f => f.type === "message" && f.message.text === "Please research this");
  const requestId = "task-create-1";
  const deadlineAt = Date.now() + 60_000;
  const create = { type: "createTask" as const, requestId, agentId: agentFrame.agent.id, channelId: channel.id,
    title: "Research this request", sourceMessageId: source.message.id, sourceThreadId: source.message.id, deadlineAt };
  const outsider = await inviteOnly(owner, port);
  owner.send(create);
  const first = await owner.wait<Extract<ServerFrame, { type: "task" }>>(f => f.type === "task" && f.requestId === requestId);
  assert.equal(first.task.sourceMessageId, source.message.id);
  assert.equal(first.task.sourceThreadId, source.message.id);
  assert.equal(first.task.ownerId, owner.frames.find(f => f.type === "welcome")?.state.me.id);
  assert.equal(first.task.deadlineAt, deadlineAt);
  assert.equal(outsider.frames.some(frame => frame.type === "approval"), false, "private task approval must not leak");
  const id = first.task.id;

  owner.send(create);
  const replay = await owner.wait<Extract<ServerFrame, { type: "task" }>>(f => f.type === "task" && f.requestId === requestId && f.task.id === id);
  assert.equal(replay.task.id, id);
  assert.equal(relay.store.tasks(100).filter(task => task.createRequestId === requestId).length, 1);

  // A reconnect retry has a fresh transport id but the same immutable source
  // payload. The source itself is the idempotency boundary, so it replays the
  // canonical task instead of minting a second row.
  owner.send({ ...create, requestId: "task-create-retry" });
  const sourceReplay = await owner.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.requestId === "task-create-retry",
  );
  assert.equal(sourceReplay.task.id, id);
  assert.equal(relay.store.tasks(100).filter(task => task.sourceMessageId === source.message.id).length, 1);
  owner.send({ ...create, requestId: "task-create-conflict", title: "Different source payload" });
  const sourceConflict = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "task-create-conflict",
  );
  assert.match(sourceConflict.error, /source message already has a task/);

  // Do not silently coerce an explicitly supplied empty id into an
  // uncorrelated create. Runtime websocket frames are untrusted.
  owner.send({ ...create, requestId: "" } as never);
  const emptyId = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && /request id/.test(f.error),
  );
  assert.match(emptyId.error, /request id/);
  assert.equal(relay.store.tasks(100).filter(task => task.sourceMessageId === source.message.id).length, 1);

  // A human window can choose only an agent that is actually in its current
  // room; the relay still attributes the task to that human, not the agent owner.
  const guest = await guestFor(owner, channel.id, port);
  guest.send({ type: "send", channelId: channel.id, text: "Guest request" });
  const guestSource = await guest.wait<Extract<ServerFrame, { type: "message" }>>(f => f.type === "message" && f.message.text === "Guest request");
  guest.send({ type: "createTask", requestId: "guest-task", agentId: agentFrame.agent.id, channelId: channel.id,
    title: "Guest task", sourceMessageId: guestSource.message.id, sourceThreadId: guestSource.message.id });
  const guestTask = await guest.wait<Extract<ServerFrame, { type: "task" }>>(f => f.type === "task" && f.requestId === "guest-task");
  assert.equal(guestTask.task.ownerId, guestSource.message.authorId);
  guest.close(); outsider.close();

  owner.send({ ...create, title: "A conflicting task" });
  const conflict = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === requestId && /different/.test(f.error));
  assert.match(conflict.error, /different/);
  assert.equal(relay.store.tasks(100).filter(task => task.createRequestId === requestId).length, 1);
  owner.close(); relay.close();
});

test("source and deadline claims are validated at create time", async () => {
  const { relay, owner, channel } = await stand("message-task-validation.db");
  owner.send({ type: "createAgent", agent: {
    name: "Scout", emoji: "🔭", persona: "researches", abilities: { webSearch: true, files: false, schedules: false, background: true },
  }});
  const agent = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Scout");
  owner.send({ type: "addMembers", channelId: channel.id, memberIds: [agent.agent.id] });
  await owner.wait(f => f.type === "channel" && f.channel.id === channel.id && f.channel.memberIds.includes(agent.agent.id));
  owner.send({ type: "send", channelId: channel.id, text: "Source" });
  const source = await owner.wait<Extract<ServerFrame, { type: "message" }>>(f => f.type === "message" && f.message.text === "Source");

  owner.send({ type: "createTask", requestId: "bad-thread", agentId: agent.agent.id, channelId: channel.id,
    title: "Task", sourceMessageId: source.message.id, sourceThreadId: "wrong-thread", deadlineAt: Date.now() + 10_000 });
  const wrongThread = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "bad-thread");
  assert.match(wrongThread.error, /source thread/);

  owner.send({ type: "createTask", requestId: "bad-deadline", agentId: agent.agent.id, channelId: channel.id,
    title: "Task", sourceMessageId: source.message.id, deadlineAt: Date.now() - 1 });
  const past = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "bad-deadline");
  assert.match(past.error, /deadline/);
  assert.equal(relay.store.tasks(100).some(task => task.createRequestId === "bad-thread" || task.createRequestId === "bad-deadline"), false);

  owner.send({ type: "createTask", requestId: "x".repeat(65), agentId: agent.agent.id, channelId: channel.id, title: "Task" });
  const badRequestId = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && /request id/.test(f.error));
  assert.match(badRequestId.error, /request id/);

  owner.send({ type: "archiveChannel", channelId: channel.id, archived: true });
  await owner.wait(f => f.type === "channel" && f.channel.id === channel.id && !!f.channel.archivedAt);
  owner.send({ type: "createTask", requestId: "archived-task", agentId: agent.agent.id, channelId: channel.id, title: "Archived task" });
  const archived = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "archived-task");
  assert.match(archived.error, /archived/);
  owner.close(); relay.close();
});

test("legacy engine createTask receives its uncorrelated task push", async () => {
  const { relay, owner, channel, port } = await stand("message-task-engine.db");
  owner.send({ type: "createAgent", agent: {
    name: "Scout", emoji: "🔭", persona: "researches", abilities: { webSearch: false, files: false, schedules: false, background: true },
  }});
  const agent = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Scout");
  owner.send({ type: "addMembers", channelId: channel.id, memberIds: [agent.agent.id] });
  await owner.wait(f => f.type === "channel" && f.channel.id === channel.id && f.channel.memberIds.includes(agent.agent.id));
  const engine = new TestClient(`ws://127.0.0.1:${port}`, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  engine.send({ type: "createTask", agentId: agent.agent.id, channelId: channel.id, title: "Legacy engine task" });
  const task = await engine.wait<Extract<ServerFrame, { type: "task" }>>(f => f.type === "task" && f.task.title === "Legacy engine task");
  assert.equal(task.requestId, undefined);
  engine.close(); owner.close(); relay.close();
});
