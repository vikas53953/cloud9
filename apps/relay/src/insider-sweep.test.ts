// ROUND 2 — insider sweep.
//
// Existing `insider.test.ts` covers private-room invite, DM third-person,
// agent-smuggle, and the admin gate list. This file sweeps the REST of the
// mutating / access-controlled frames with three senders: plain member,
// non-member, and (where relevant) stranger to an agent.
//
// FINDING F1 (docs/qa/insider-audit.md): every refusal currently arrives as
// "Error: …" because server.ts does String(err). That file is forbidden, so
// the prefix-law assertions are `.todo`. Semantic refusals below still assert.
import test from "node:test";
import assert from "node:assert/strict";
import { RunRecord, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
};

async function stand(name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const general = welcome.state.channels.find(c => c.name === "general")!;
  return { relay, url, owner, general, me: welcome.state.me };
}

async function guestOf(url: string, owner: TestClient, name: string) {
  owner.frames = owner.frames.filter(f => f.type !== "invite");
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const guest = new TestClient(url, `invite:${inv.code}:${name}`);
  const w = await guest.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { guest, me: w.state.me.id };
}

async function refuses(
  client: TestClient,
  frame: Parameters<TestClient["send"]>[0],
  contains: string | RegExp,
): Promise<string> {
  client.frames.length = 0;
  client.send(frame);
  const err = await client.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  if (typeof contains === "string") {
    assert.ok(err.error.includes(contains), `expected "${contains}", got "${err.error}"`);
  } else {
    assert.match(err.error, contains);
  }
  return err.error;
}

function plainRefusal(sentence: string): void {
  assert.ok(!sentence.startsWith("Error:"),
    `refusal law (F1): no Error: prefix — got ${JSON.stringify(sentence)}`);
  assert.ok(!/[A-Za-z]:\\/.test(sentence) && !sentence.includes("/Users/"),
    `refusal law: no file path — got ${JSON.stringify(sentence)}`);
}

async function makeAgent(client: TestClient, name: string) {
  client.send({ type: "createAgent", agent: { ...BASE_AGENT, name } });
  const f = await client.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === name);
  return f.agent;
}

async function privateBoard(owner: TestClient, memberIds: string[]) {
  owner.send({ type: "createChannel", name: `board-${Date.now()}`, memberIds, kind: "channel" });
  return (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name.startsWith("board-"))).channel;
}

// ---------------------------------------------------------------------------
// Refusal law (blocked by F1 until server.ts is allowed to change)
// ---------------------------------------------------------------------------

test("F1: a refusal sentence has no Error: prefix and no file path", {
  todo: "F1: wire sends String(err) so answers are 'Error: …' — see docs/qa/insider-audit.md; server.ts forbidden",
});

// unused helper kept so a future fix can assert the law in one place
void plainRefusal;

// ---------------------------------------------------------------------------
// Channel admin — non-member
// ---------------------------------------------------------------------------

test("a hub member who is NOT in a room cannot administer it", async () => {
  const { relay, url, owner } = await stand("sweep-admin-out.db");
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  const { guest: neha } = await guestOf(url, owner, "Neha");
  const board = await privateBoard(owner, [rajId]);

  const frames: Parameters<TestClient["send"]>[0][] = [
    { type: "setChannelInfo", channelId: board.id, topic: "stolen" },
    { type: "setChannelVisibility", channelId: board.id, visibility: "open" },
    { type: "archiveChannel", channelId: board.id, archived: true },
    { type: "addMembers", channelId: board.id, memberIds: [relay.ownerId] },
    { type: "removeMember", channelId: board.id, memberId: rajId },
    { type: "setMemberRole", channelId: board.id, memberId: rajId, role: "admin" },
    { type: "channelMembers", channelId: board.id },
  ];
  for (const frame of frames) {
    await refuses(neha, frame, /no such channel|don't run|only the person/);
  }
  assert.equal(relay.store.channel(board.id)!.topic, undefined);
  owner.close(); raj.close(); neha.close(); relay.close();
});

// ---------------------------------------------------------------------------
// Edit / delete someone else's message
// ---------------------------------------------------------------------------

test("a plain member cannot edit or delete someone else's message", async () => {
  const { relay, url, owner } = await stand("sweep-msg.db");
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  const board = await privateBoard(owner, [rajId]);
  owner.send({ type: "send", channelId: board.id, text: "the offer is private" });
  const msg = (await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.text.includes("offer"))).message;

  await refuses(raj, { type: "editMessage", messageId: msg.id, text: "rewritten" },
    "your own messages");
  await refuses(raj, { type: "deleteMessage", messageId: msg.id },
    "your own messages");
  assert.equal(relay.store.message(msg.id)!.text, "the offer is private");
  assert.equal(relay.store.message(msg.id)!.deletedAt, undefined);

  owner.close(); raj.close(); relay.close();
});

test("a stranger cannot edit a message in a room they are not in", async () => {
  const { relay, url, owner } = await stand("sweep-msg-out.db");
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  const { guest: neha } = await guestOf(url, owner, "Neha");
  const board = await privateBoard(owner, [rajId]);
  owner.send({ type: "send", channelId: board.id, text: "secret line" });
  const msg = (await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.text === "secret line")).message;

  await refuses(neha, { type: "editMessage", messageId: msg.id, text: "x" }, /no such/);
  await refuses(neha, { type: "deleteMessage", messageId: msg.id }, /no such/);
  await refuses(neha, { type: "react", messageId: msg.id, emoji: "👍", on: true }, /no such/);

  owner.close(); raj.close(); neha.close(); relay.close();
});

// ---------------------------------------------------------------------------
// History / search / unread across boundaries
// ---------------------------------------------------------------------------

test("scrollback and search refuse rooms you are not in", async () => {
  const { relay, url, owner } = await stand("sweep-read.db");
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  const { guest: neha } = await guestOf(url, owner, "Neha");
  const board = await privateBoard(owner, [rajId]);
  owner.send({ type: "send", channelId: board.id, text: "unique-token-board-zzz" });
  await owner.wait(f => f.type === "message");

  await refuses(neha, { type: "history", channelId: board.id }, "no such channel");
  await refuses(neha, { type: "markRead", channelId: board.id, ts: Date.now() }, "no such channel");

  neha.frames.length = 0;
  neha.send({ type: "search", query: "unique-token-board-zzz" });
  const results = await neha.wait<Extract<ServerFrame, { type: "searchResults" }>>(
    f => f.type === "searchResults");
  assert.equal(results.results.length, 0, "search must not leak a private room's text");

  owner.close(); raj.close(); neha.close(); relay.close();
});

// ---------------------------------------------------------------------------
// Attachments
// ---------------------------------------------------------------------------

test("an attachment ticket for another room's file is refused as no such file", async () => {
  const { relay, url, owner } = await stand("sweep-att.db");
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  const { guest: neha } = await guestOf(url, owner, "Neha");
  const board = await privateBoard(owner, [rajId]);

  const bytes = Buffer.from("private-bytes");
  owner.send({
    type: "uploadAttachment", channelId: board.id, name: "plan.pdf",
    dataBase64: bytes.toString("base64"),
  });
  const att = (await owner.wait<Extract<ServerFrame, { type: "attachment" }>>(
    f => f.type === "attachment")).attachment;
  owner.send({
    type: "send", channelId: board.id, text: "see file", attachmentIds: [att.id],
  });
  await owner.wait(f => f.type === "message");

  await refuses(neha, { type: "attachmentTicket", attachmentId: att.id }, "no such file");
  await refuses(neha, {
    type: "uploadAttachment", channelId: board.id, name: "sneak.pdf",
    dataBase64: Buffer.from("x").toString("base64"),
  }, "no such channel");

  owner.close(); raj.close(); neha.close(); relay.close();
});

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

test("artifact frames across a room boundary do not leak", async () => {
  const { relay, url, owner } = await stand("sweep-art.db");
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  const { guest: neha } = await guestOf(url, owner, "Neha");
  const board = await privateBoard(owner, [rajId]);

  await refuses(neha, { type: "artifacts", channelId: board.id }, "no such channel");
  await refuses(neha, { type: "artifact", artifactId: "ar_invented" }, /no such/);
  await refuses(neha, { type: "artifactTicket", artifactId: "ar_invented", version: 1 }, /no such/);

  owner.close(); raj.close(); neha.close(); relay.close();
});

// ---------------------------------------------------------------------------
// Runs — agent you do not own
// ---------------------------------------------------------------------------

test("runDetail of an agent you do not own is no such run", async () => {
  const { relay, url, owner } = await stand("sweep-run.db");
  const { guest: raj } = await guestOf(url, owner, "Raj");
  const { guest: neha } = await guestOf(url, owner, "Neha");
  const agent = await makeAgent(owner, "OwnerScout");

  const record = {
    id: "r-1700000000000-abcd", kind: "chat", agentId: agent.id, agentName: agent.name,
    provider: "codex", ask: "private ask", startedAt: 1, finishedAt: 2, durationMs: 1,
    outcome: "ok", steps: [], reply: "done",
  } as unknown as RunRecord;
  relay.store.saveRun({
    record, agentId: agent.id, ownerId: relay.ownerId,
  });

  await refuses(neha, { type: "runDetail", runId: record.id }, "no such run");
  await refuses(raj, { type: "runDetail", runId: record.id }, "no such run");
  await refuses(neha, { type: "runList", agentId: agent.id }, "not your agent");

  owner.close(); raj.close(); neha.close(); relay.close();
});

// ---------------------------------------------------------------------------
// Approvals — non-approver
// ---------------------------------------------------------------------------

test("a non-owner cannot decide an approval for someone else's agent", async () => {
  const { relay, url, owner } = await stand("sweep-appr.db");
  const { guest: neha } = await guestOf(url, owner, "Neha");
  const agent = await makeAgent(owner, "GateKeeper");

  const approval = {
    id: "ap_test1",
    agentId: agent.id,
    ownerId: relay.ownerId,
    action: "run a command",
    status: "pending" as const,
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    kind: "action" as const,
    revision: 0,
    approvalEpoch: "sweep-approval-epoch",
  };
  relay.store.saveApproval(approval);

  await refuses(neha, {
    type: "decideApproval", approvalId: approval.id, decision: "approved",
    expectedRevision: approval.revision, approvalEpoch: approval.approvalEpoch,
    requestId: "sweep-outsider-approval",
  },
    "only the agent's owner");
  assert.equal(relay.store.approval(approval.id)!.status, "pending");

  owner.close(); neha.close(); relay.close();
});

// ---------------------------------------------------------------------------
// Projects — stranger
// ---------------------------------------------------------------------------

test("project frames for a project you do not own are refused", async () => {
  const { relay, url, owner } = await stand("sweep-proj.db");
  const { guest: neha } = await guestOf(url, owner, "Neha");

  // Plant directly — connectProject also asks the engine to look, which is
  // unrelated to the ownership gate this test is about.
  const project = {
    id: "pr_sweep1", ownerId: relay.ownerId, repo: "vikas53953/cloud9",
    name: "cloud9", createdAt: Date.now(),
  };
  relay.store.saveProject(project as never);

  await refuses(neha, { type: "updateProject", projectId: project.id, description: "mine" }, "no such project");
  await refuses(neha, { type: "forgetProject", projectId: project.id }, "no such project");
  await refuses(neha, { type: "syncProject", projectId: project.id }, "no such project");
  await refuses(neha, { type: "projectItems", projectId: project.id }, "no such project");

  owner.close(); neha.close(); relay.close();
});

// ---------------------------------------------------------------------------
// Skills / agents — stranger
// ---------------------------------------------------------------------------

test("a stranger cannot update or delete someone else's agent or its skills", async () => {
  const { relay, url, owner } = await stand("sweep-agent.db");
  const { guest: neha } = await guestOf(url, owner, "Neha");
  const agent = await makeAgent(owner, "MineOnly");

  await refuses(neha, {
    type: "updateAgent",
    agent: {
      ...agent,
      name: "Stolen",
      skills: [{ id: "sk1", name: "leak", description: "x", instructions: "do it" }],
    },
  }, "not your agent");
  await refuses(neha, { type: "deleteAgent", agentId: agent.id }, "not your agent");
  assert.ok(relay.store.agents().some(a => a.id === agent.id && a.name === "MineOnly"));

  owner.close(); neha.close(); relay.close();
});
