import test from "node:test";
import assert from "node:assert/strict";
import {
  RESPONSE_STREAM_LIMITS,
  type AgentResponseStreamEvent,
  type ServerFrame,
} from "@cloud9/shared";
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
  return { relay, url, owner, me: welcome.state.me };
}

async function guestOf(url: string, owner: TestClient, name: string) {
  owner.frames = owner.frames.filter(f => f.type !== "invite");
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const guest = new TestClient(url, `invite:${inv.code}:${name}`);
  const w = await guest.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { guest, me: w.state.me.id };
}

async function makeAgent(client: TestClient, name: string) {
  client.send({ type: "createAgent", agent: { ...BASE_AGENT, name } });
  const f = await client.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === name);
  return f.agent;
}

async function room(name: string) {
  const { relay, url, owner, me } = await stand(name);
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  const { guest: neha } = await guestOf(url, owner, "Neha");
  const agent = await makeAgent(owner, "Scout");
  owner.send({ type: "createChannel", name: "board", memberIds: [rajId, agent.id], kind: "channel" });
  const board = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "board")).channel;
  owner.send({ type: "send", channelId: board.id, text: "read the note and tell me what it says" });
  const posted = await owner.wait<Extract<ServerFrame, { type: "message" }>>(f => f.type === "message");
  const engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  const close = () => { owner.close(); raj.close(); neha.close(); engine.close(); relay.close(); };
  return { relay, url, owner, raj, rajId, neha, engine, agent, board, message: posted.message, me, close };
}

const frame = (base: Pick<AgentResponseStreamEvent, "channelId" | "triggerMessageId" | "agentId" | "turnId">,
  kind: AgentResponseStreamEvent["kind"], seq: number, text?: string): AgentResponseStreamEvent => ({
  ...base, kind, seq, at: 0, ...(text === undefined ? {} : { text }),
});

const responses = (client: TestClient) =>
  client.frames.filter((f): f is Extract<ServerFrame, { type: "agentResponse" }> => f.type === "agentResponse");

test("response previews are owned, private, ephemeral and safely reorderable", async () => {
  const { relay, url, owner, raj, neha, engine, agent, board, message, close } = await room("response-audience.db");
  try {
    owner.frames.length = 0; raj.frames.length = 0; neha.frames.length = 0;
    const base = { channelId: board.id, triggerMessageId: message.id, agentId: agent.id, turnId: "r-preview-1" };
    engine.send({ type: "agentResponse", event: frame(base, "response-start", 0) });
    await owner.wait(f => f.type === "agentResponse" && f.stream.kind === "response-start");
    // The hub relays both sequence ids; the desktop cache, not the hub, orders them.
    engine.send({ type: "agentResponse", event: frame(base, "response-delta", 2, "!") });
    engine.send({ type: "agentResponse", event: frame(base, "response-delta", 1, "hello") });
    engine.send({ type: "agentResponse", event: frame(base, "response-delta", 1, "duplicate") });
    await owner.wait(f => f.type === "agentResponse" && f.stream.seq === 1);
    engine.send({ type: "agentResponse", event: frame(base, "response-final", 3) });
    await owner.wait(f => f.type === "agentResponse" && f.stream.kind === "response-final");
    await raj.wait(f => f.type === "agentResponse" && f.stream.kind === "response-final");
    assert.deepEqual(responses(owner).map(f => [f.stream.kind, f.stream.seq, f.stream.text]), [
      ["response-start", 0, undefined], ["response-delta", 2, "!"], ["response-delta", 1, "hello"],
      ["response-final", 3, undefined],
    ]);
    assert.equal(responses(raj).length, 4, "room members see the current preview");
    assert.equal(responses(neha).length, 0, "non-members cannot learn the trigger or its text");
    assert.ok(responses(owner).every(f => f.stream.at > 0), "relay stamps the hub time");

    // Nothing partial is durable or replayed after a fresh connection.
    const store = (relay as unknown as { store: {
      history: (id: string, cursor: Record<string, never>, limit: number) => { items: unknown[] };
      runsForAgent?: (id: string, limit: number) => unknown[];
    } }).store;
    assert.equal(store.history(board.id, {}, 200).items.some(x => JSON.stringify(x).includes("hello")), false);
    const late = new TestClient(url, "tok-owner");
    await late.wait(f => f.type === "welcome");
    assert.equal(responses(late).length, 0);
    late.close();
  } finally { close(); }
});

test("response previews reject wrong owner, agent, channel and malformed size", async () => {
  const { owner, raj, engine, agent, board, message, close } = await room("response-auth.db");
  try {
    const base = { channelId: board.id, triggerMessageId: message.id, agentId: agent.id, turnId: "r-preview-auth" };
    const refuse = async (client: TestClient, event: AgentResponseStreamEvent, contains: string) => {
      client.frames.length = 0;
      client.send({ type: "agentResponse", event });
      const err = await client.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
      assert.match(err.error, new RegExp(contains, "i"));
      assert.equal(responses(owner).length, 0);
    };
    await refuse(raj, frame(base, "response-start", 0), "engine");
    await refuse(engine, frame({ ...base, agentId: "a-not-yours" }, "response-start", 0), "agent");
    await refuse(engine, frame({ ...base, channelId: "channel-nope" }, "response-start", 0), "message");
    await refuse(engine, frame(base, "response-delta", 1, "x".repeat(RESPONSE_STREAM_LIMITS.deltaChars + 1)), "too large");
  } finally { close(); }
});

test("removing the agent revokes an active preview before the next engine frame", async () => {
  const { owner, engine, agent, board, message, close } = await room("response-membership-revoke.db");
  try {
    const base = { channelId: board.id, triggerMessageId: message.id, agentId: agent.id, turnId: "r-preview-revoke" };
    engine.send({ type: "agentResponse", event: frame(base, "response-start", 0) });
    await owner.wait(f => f.type === "agentResponse" && f.stream.kind === "response-start");
    owner.frames.length = 0;
    engine.frames.length = 0;

    owner.send({ type: "removeMember", channelId: board.id, memberId: agent.id });
    await owner.wait(f => f.type === "channel" && f.channel.id === board.id
      && !f.channel.memberIds.includes(agent.id));

    engine.send({ type: "agentResponse", event: frame(base, "response-delta", 1, "after revoke") });
    const err = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
    assert.match(err.error, /not in this conversation/i);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(responses(owner).filter(f => f.stream.kind === "response-cancel").length, 1,
      "revoked access sends one terminal clear to the authorized window");
  } finally { close(); }
});

test("access-revocation cancel reaches only the post-removal audience", async () => {
  const { owner, raj, rajId, engine, agent, board, message, close } = await room("response-audience-revoke.db");
  try {
    const base = { channelId: board.id, triggerMessageId: message.id, agentId: agent.id, turnId: "r-preview-audience-revoke" };
    engine.send({ type: "agentResponse", event: frame(base, "response-start", 0) });
    await owner.wait(f => f.type === "agentResponse" && f.stream.kind === "response-start");
    owner.frames.length = 0;
    raj.frames.length = 0;
    owner.send({ type: "removeMember", channelId: board.id, memberId: rajId });
    await owner.wait(f => f.type === "channel" && f.channel.id === board.id && !f.channel.memberIds.includes(rajId));
    engine.send({ type: "agentResponse", event: frame(base, "response-delta", 1, "still for owner") });
    await owner.wait(f => f.type === "agentResponse" && f.stream.kind === "response-delta");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(responses(raj).filter(f => f.stream.kind === "response-cancel").length, 0,
      "the removed member cannot learn the access-revocation terminal metadata");
  } finally { close(); }
});

test("archiving a channel closes previews and refuses a new engine frame", async () => {
  const { owner, engine, agent, board, message, close } = await room("response-archive-revoke.db");
  try {
    const base = { channelId: board.id, triggerMessageId: message.id, agentId: agent.id, turnId: "r-preview-archive" };
    engine.send({ type: "agentResponse", event: frame(base, "response-start", 0) });
    await owner.wait(f => f.type === "agentResponse" && f.stream.kind === "response-start");
    owner.frames.length = 0;
    owner.send({ type: "archiveChannel", channelId: board.id, archived: true });
    await owner.wait(f => f.type === "channel" && f.channel.id === board.id && !!f.channel.archivedAt);
    assert.equal(responses(owner).filter(f => f.stream.kind === "response-cancel").length, 1,
      "archiving sends one terminal clear to the authorized window");

    engine.send({ type: "agentResponse", event: frame(base, "response-delta", 1, "after archive") });
    const err = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
    assert.match(err.error, /archived/i);
  } finally { close(); }
});

test("durable agent messages retain the exact trigger marker for concurrent turns", async () => {
  const { owner, engine, agent, board, message, close } = await room("response-correlation.db");
  try {
    const first = { channelId: board.id, triggerMessageId: message.id, agentId: agent.id, turnId: "r-preview-first" };
    owner.send({ type: "send", channelId: board.id, text: "a second request" });
    const secondMessage = await owner.wait<Extract<ServerFrame, { type: "message" }>>(
      f => f.type === "message" && f.message.authorKind === "human" && f.message.id !== message.id);
    const second = { ...first, triggerMessageId: secondMessage.message.id, turnId: "r-preview-second" };
    engine.send({ type: "agentResponse", event: frame(first, "response-start", 0) });
    engine.send({ type: "agentResponse", event: frame(second, "response-start", 0) });
    await owner.wait(f => f.type === "agentResponse" && f.stream.turnId === second.turnId);
    engine.send({ type: "agentSend", agentId: agent.id, channelId: board.id,
      text: "first durable answer", responseTriggerMessageId: first.triggerMessageId });
    const durable = await owner.wait<Extract<ServerFrame, { type: "message" }>>(
      f => f.type === "message" && f.message.authorKind === "agent" && f.message.text === "first durable answer");
    assert.equal(durable.message.responseTriggerMessageId, first.triggerMessageId);
    assert.notEqual(durable.message.responseTriggerMessageId, second.triggerMessageId,
      "a durable answer cannot cross-clear a concurrent preview");
  } finally { close(); }
});

test("closing the source engine ends only its preview even when a second host remains", async () => {
  const { owner, engine, url, agent, board, message, close } = await room("response-engine-source.db");
  const secondEngine = new TestClient(url, "tok-owner", "engine");
  try {
    await secondEngine.wait(f => f.type === "welcome");
    const base = { channelId: board.id, triggerMessageId: message.id, agentId: agent.id, turnId: "r-preview-source" };
    engine.send({ type: "agentResponse", event: frame(base, "response-start", 0) });
    await owner.wait(f => f.type === "agentResponse" && f.stream.kind === "response-start");
    secondEngine.frames.length = 0;
    secondEngine.send({ type: "agentResponse", event: frame(base, "response-delta", 1, "forged source") });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(responses(owner).filter(f => f.stream.turnId === base.turnId && f.stream.kind === "response-delta").length, 0,
      "a second engine cannot inject into the source socket's preview");
    secondEngine.send({ type: "agentResponse", event: frame(base, "response-delta", 2,
      "x".repeat(RESPONSE_STREAM_LIMITS.deltaChars + 1)) });
    await secondEngine.wait(f => f.type === "error");
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(responses(owner).filter(f => f.stream.turnId === base.turnId && f.stream.kind === "response-fail").length, 0,
      "a second engine cannot force-fail the source socket's preview");
    engine.close();
    const ended = await owner.wait<Extract<ServerFrame, { type: "agentResponse" }>>(
      f => f.type === "agentResponse" && f.stream.turnId === base.turnId && f.stream.kind === "response-cancel");
    assert.match(ended.stream.reason ?? "", /access changed/i);
    // The second host is still connected, but it cannot continue a stream that
    // belonged to the socket that just closed.
    secondEngine.send({ type: "agentResponse", event: frame(base, "response-delta", 1, "late") });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(responses(owner).filter(f => f.stream.turnId === base.turnId && f.stream.kind === "response-delta").length, 0);
    secondEngine.send({ type: "agentResponse", event: frame(base, "response-start", 0) });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(responses(owner).filter(f => f.stream.turnId === base.turnId && f.stream.kind === "response-start").length, 1,
      "an ended source turn id cannot be resurrected by another engine");
  } finally { secondEngine.close(); close(); }
});

test("terminal cancel/fail and total-size cap close one turn without leaking into the next", async () => {
  const { owner, engine, agent, board, message, close } = await room("response-terminal.db");
  try {
    const base = { channelId: board.id, triggerMessageId: message.id, agentId: agent.id, turnId: "r-preview-terminal" };
    engine.send({ type: "agentResponse", event: frame(base, "response-start", 0) });
    engine.send({ type: "agentResponse", event: frame(base, "response-delta", 1, "part") });
    engine.send({ type: "agentResponse", event: frame(base, "response-cancel", 2) });
    await owner.wait(f => f.type === "agentResponse" && f.stream.kind === "response-cancel");
    engine.send({ type: "agentResponse", event: frame(base, "response-start", 0) });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(responses(owner).filter(f => f.stream.turnId === base.turnId && f.stream.kind === "response-start").length, 1,
      "a terminal turn id cannot resurrect its preview");

    const second = { ...base, turnId: "r-preview-fail" };
    engine.send({ type: "agentResponse", event: frame(second, "response-start", 0) });
    engine.send({ type: "agentResponse", event: frame(second, "response-delta", 1, "part") });
    engine.send({ type: "agentResponse", event: frame(second, "response-fail", 2) });
    await owner.wait(f => f.type === "agentResponse" && f.stream.kind === "response-fail");

    const capped = { ...base, turnId: "r-preview-cap" };
    engine.send({ type: "agentResponse", event: frame(capped, "response-start", 0) });
    const chunk = "x".repeat(RESPONSE_STREAM_LIMITS.deltaChars);
    for (let seq = 1; seq <= Math.ceil(RESPONSE_STREAM_LIMITS.totalChars / chunk.length) + 1; seq++) {
      engine.send({ type: "agentResponse", event: frame(capped, "response-delta", seq, chunk) });
    }
    await owner.wait(f => f.type === "agentResponse" && f.stream.turnId === capped.turnId && f.stream.kind === "response-fail");
    const got = responses(owner).filter(f => f.stream.turnId === capped.turnId && f.stream.kind === "response-delta");
    assert.equal(got.length, 48, "the first delta beyond the total ceiling is dropped");
    assert.match(responses(owner).find(f => f.stream.turnId === capped.turnId && f.stream.kind === "response-fail")!.stream.reason ?? "", /size limit/i);
  } finally { close(); }
});
