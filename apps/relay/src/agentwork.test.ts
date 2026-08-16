// A FINISHED JOB SAYS WHAT HAPPENED, AND AN AGENT REACTS WHILE IT WORKS.
// (his items 3 and 5.)
//
// Both fail without this round's changes: there was no `summary` on a task and
// no way at all for an agent to put an emoji on a message — `react` records the
// PERSON holding the socket, so an engine reacting on an agent's behalf came out
// as the owner reacting, which is a different fact.
//
// The theme is the same one that runs through the run-record file: nothing here
// invented a new authorisation path. A summary rides the gate `updateTask`
// already had (your agent's job, or nothing), and a reaction rides the gate
// `agentSend` already had (your agent, read from stored state, never the frame).
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { ServerFrame, TASK_LIMITS, WORK_REACTIONS, isWorkReaction } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
};

async function stand(t: TestContext, name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const clients: TestClient[] = [];
  t.after(() => { for (const c of clients) c.close(); relay.close(); });
  const open = (token: string, kind: "desktop" | "engine" = "desktop") => {
    const c = new TestClient(url, token, kind);
    clients.push(c);
    return c;
  };
  const owner = open("tok-owner");
  await owner.wait(f => f.type === "welcome");
  const engine = open("tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  return { relay, owner, engine, open };
}

async function makeAgent(client: TestClient, name: string) {
  client.send({ type: "createAgent", agent: { ...BASE_AGENT, name } });
  const frame = await client.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === name);
  return frame.agent;
}

async function say(client: TestClient, channelId: string, text: string) {
  client.send({ type: "send", channelId, text });
  const m = await client.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.text === text);
  return m.message;
}

async function task(owner: TestClient, engine: TestClient, agentId: string, channelId: string) {
  owner.send({ type: "addMembers", channelId, memberIds: [agentId] });
  await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.id === channelId && f.channel.memberIds.includes(agentId));
  owner.send({ type: "createTask", agentId, channelId, title: "find three villas in Goa" });
  const t = await owner.wait<Extract<ServerFrame, { type: "task" }>>(f => f.type === "task");
  return t.task;
}

// ---------------------------------------------------------------------------
// His item 3 — the job finished, and here is what it did
// ---------------------------------------------------------------------------

test("the agent writes the TLDR, and the hub stores and broadcasts it", async t => {
  const { relay, owner, engine, open } = await stand(t, "summary-happy.db");
  const agent = await makeAgent(owner, "Scout");
  const channel = relay.store.channels()[0];
  const job = await task(owner, engine, agent.id, channel.id);

  engine.send({
    type: "updateTask", taskId: job.id, status: "completed",
    summary: "Found three villas under ₹8,000 a night and put them in the thread.",
  });

  const done = await owner.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.status === "completed");
  assert.equal(done.task.summary,
    "Found three villas under ₹8,000 a night and put them in the thread.");
  // stored, not just broadcast — a reload must still show it
  assert.equal(relay.store.task(job.id)?.summary, done.task.summary);

  // and it reaches a client that arrives afterwards, in the opening frame
  const later = open("tok-owner");
  const hello = await later.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  assert.equal(hello.state.tasks.find(x => x.id === job.id)?.summary, done.task.summary);
});

test("a job with nothing honest to say keeps no summary — no filler sentence", async t => {
  const { relay, owner, engine } = await stand(t, "summary-absent.db");
  const agent = await makeAgent(owner, "Scout");
  const channel = relay.store.channels()[0];
  const job = await task(owner, engine, agent.id, channel.id);

  engine.send({ type: "updateTask", taskId: job.id, status: "failed", error: "the CLI stopped" });
  const failed = await owner.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.status === "failed");
  assert.equal(failed.task.summary, undefined);
  assert.equal("summary" in (relay.store.task(job.id) ?? {}), false);
});

test("absent leaves a summary alone; an empty one clears it", async t => {
  // Two different sentences, treated differently — the same rule setChannelInfo
  // and keepSkillFiles follow.
  const { relay, owner, engine } = await stand(t, "summary-absent-vs-empty.db");
  const agent = await makeAgent(owner, "Scout");
  const channel = relay.store.channels()[0];
  const job = await task(owner, engine, agent.id, channel.id);

  engine.send({ type: "updateTask", taskId: job.id, status: "working", summary: "half way" });
  await owner.wait(f => f.type === "task" && f.task.summary === "half way");

  // says nothing about the summary → it survives
  engine.send({ type: "updateTask", taskId: job.id, status: "completed" });
  await owner.wait(f => f.type === "task" && f.task.status === "completed");
  assert.equal(relay.store.task(job.id)?.summary, "half way");

  // says "" → it goes
  engine.send({ type: "updateTask", taskId: job.id, status: "completed", summary: "" });
  await owner.wait(f => f.type === "task" && f.task.summary === undefined && f.task.status === "completed");
  assert.equal(relay.store.task(job.id)?.summary, undefined);
});

test("a summary goes through the gate that was already there, and is bounded", async t => {
  const { relay, owner, open } = await stand(t, "summary-gate.db");
  const agent = await makeAgent(owner, "Scout");
  const channel = relay.store.channels()[0];
  const job = await task(owner, owner, agent.id, channel.id);

  // a friend — in this Cloud9, not this agent's owner — cannot write its story
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${inv.code}:Priya`);
  await friend.wait(f => f.type === "welcome");
  friend.send({ type: "updateTask", taskId: job.id, status: "completed", summary: "I did it" });
  const denied = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /not your agent's task/);
  assert.equal(relay.store.task(job.id)?.summary, undefined);

  // and an unbounded blob cannot arrive through this new field
  owner.send({
    type: "updateTask", taskId: job.id, status: "completed",
    summary: "x".repeat(TASK_LIMITS.summary + 1),
  });
  const tooBig = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(tooBig.error, /too long/);
  assert.equal(relay.store.task(job.id)?.summary, undefined);
});

// ---------------------------------------------------------------------------
// His item 5 — the agent reacts to the message that asked for the work
// ---------------------------------------------------------------------------

test("the work emoji are one fixed set, defined once", () => {
  // "stopped" (🛑) JOINED THEM ON 2026-08-06 and this line is why the test is
  // worth keeping: there were two ticks for three endings, so a job the owner
  // stopped wore the same ✅ as one that ran to the end — he pressed Stop and
  // his own message told him the work had finished normally. A fixed list that
  // has to be edited on purpose is exactly what caught the fifth one arriving.
  assert.deepEqual(Object.keys(WORK_REACTIONS),
    ["picked", "working", "done", "failed", "stopped"]);
  for (const emoji of Object.values(WORK_REACTIONS)) assert.equal(isWorkReaction(emoji), true);
  assert.equal(isWorkReaction("🍕"), false);
});

test("an agent reacts as ITSELF, through the reactions that already exist", async t => {
  const { relay, owner, engine } = await stand(t, "react-agent.db");
  const agent = await makeAgent(owner, "Scout");
  const channel = relay.store.channels()[0];
  const asked = await say(owner, channel.id, "@Scout find me three villas");

  engine.send({
    type: "agentReact", agentId: agent.id, messageId: asked.id, emoji: WORK_REACTIONS.picked,
  });
  const picked = await owner.wait<Extract<ServerFrame, { type: "reaction" }>>(
    f => f.type === "reaction" && f.emoji === WORK_REACTIONS.picked);
  // the AGENT's id, not its owner's — that is the whole point
  assert.deepEqual(picked.userIds, [agent.id]);
  assert.equal(picked.messageId, asked.id);

  // …and it comes back out of the same place a person's reaction does
  owner.send({ type: "history", channelId: channel.id });
  const history = await owner.wait<Extract<ServerFrame, { type: "history" }>>(f => f.type === "history");
  const stored = history.messages.find(m => m.id === asked.id);
  assert.deepEqual(stored?.reactions, [{ emoji: WORK_REACTIONS.picked, userIds: [agent.id] }]);

  // taking it back is the same soft delete a person's is
  engine.send({
    type: "agentReact", agentId: agent.id, messageId: asked.id,
    emoji: WORK_REACTIONS.picked, on: false,
  });
  const gone = await owner.wait<Extract<ServerFrame, { type: "reaction" }>>(
    f => f.type === "reaction" && f.emoji === WORK_REACTIONS.picked && f.userIds.length === 0);
  assert.deepEqual(gone.userIds, []);
});

test("the four work emoji sit side by side on one message", async t => {
  const { relay, owner, engine } = await stand(t, "react-progress.db");
  const agent = await makeAgent(owner, "Scout");
  const channel = relay.store.channels()[0];
  const asked = await say(owner, channel.id, "@Scout do the thing");

  for (const emoji of [WORK_REACTIONS.picked, WORK_REACTIONS.working, WORK_REACTIONS.done]) {
    engine.send({ type: "agentReact", agentId: agent.id, messageId: asked.id, emoji });
    await owner.wait(f => f.type === "reaction" && f.emoji === emoji && f.userIds.includes(agent.id));
  }
  owner.send({ type: "history", channelId: channel.id });
  const history = await owner.wait<Extract<ServerFrame, { type: "history" }>>(f => f.type === "history");
  const stored = history.messages.find(m => m.id === asked.id);
  assert.deepEqual(stored?.reactions?.map(r => r.emoji).sort(),
    [WORK_REACTIONS.picked, WORK_REACTIONS.working, WORK_REACTIONS.done].sort());
});

test("an engine cannot react as an agent it does not own", async t => {
  // The same hole `agentSend` was closed against, on the new path: ownership is
  // read from stored state, never from the frame.
  const { relay, owner, open } = await stand(t, "react-notyours.db");
  const scout = await makeAgent(owner, "Scout");
  const channel = relay.store.channels()[0];
  const asked = await say(owner, channel.id, "hello");

  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friendEngine = open(`invite:${inv.code}:Priya`, "engine");
  await friendEngine.wait(f => f.type === "welcome");

  friendEngine.send({
    type: "agentReact", agentId: scout.id, messageId: asked.id, emoji: WORK_REACTIONS.done,
  });
  const denied = await friendEngine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /not your agent/);
  assert.equal(relay.store.reactionsFor([asked.id]).size, 0);
});

test("an agent reaction obeys every rule a person's reaction obeys", async t => {
  const { relay, owner, engine } = await stand(t, "react-rules.db");
  const agent = await makeAgent(owner, "Scout");
  const channel = relay.store.channels()[0];
  const asked = await say(owner, channel.id, "hello");

  // not an emoji — the same refusal, not a trim into shape
  engine.send({ type: "agentReact", agentId: agent.id, messageId: asked.id, emoji: "a\nb" });
  const bad = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(bad.error, /not an emoji/);

  // a message in a conversation this connection isn't in
  engine.send({ type: "agentReact", agentId: agent.id, messageId: "m_nope", emoji: WORK_REACTIONS.done });
  const nope = await engine.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && /no such message/.test(f.error));
  assert.match(nope.error, /no such message/);

  // a tombstone has nothing left to react to
  owner.send({ type: "deleteMessage", messageId: asked.id });
  await owner.wait(f => f.type === "messageUpdated" && f.message.id === asked.id && !!f.message.deletedAt);
  engine.send({ type: "agentReact", agentId: agent.id, messageId: asked.id, emoji: WORK_REACTIONS.done });
  const dead = await engine.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && /was deleted/.test(f.error));
  assert.match(dead.error, /was deleted/);
  assert.equal(relay.store.reactionsFor([asked.id]).size, 0);
});
