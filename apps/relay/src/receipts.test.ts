// SEMANTIC RECEIPTS AT THE HUB (his §2) — two promises, and both of them are
// about what the hub must NOT do.
//
//  1. IT FORWARDS TO THE ROOM AND NOBODY ELSE. A receipt names a message; a
//     person outside the room must not learn that the message exists, that an
//     agent is reading it, or what the agent concluded. It reuses the ONE
//     visibility owner every other broadcast uses (`audienceFor`, via
//     `toChannel`) — a second rule about who may see a room is a leak waiting
//     to be written.
//  2. IT STORES NOTHING. Not a message, not a reaction, not an activity row.
//     After a receipt goes past, history is unchanged, search finds nothing,
//     and the unread count has not moved. That is what "ephemeral" has to mean
//     if it is going to be honest — a signal that quietly became a row would
//     be a machine cluttering his history under a different name.
import test from "node:test";
import assert from "node:assert/strict";
import { ServerFrame } from "@cloud9/shared";
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

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 120));

/** The hub, an agent, a PRIVATE room the owner and Raj are in, and one message. */
async function room(name: string) {
  const { relay, url, owner, me } = await stand(name);
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  const { guest: neha } = await guestOf(url, owner, "Neha"); // never in the room
  const agent = await makeAgent(owner, "Scout");

  owner.send({ type: "createChannel", name: "board", memberIds: [rajId, agent.id], kind: "channel" });
  const board = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "board")).channel;

  owner.send({ type: "send", channelId: board.id, text: "does the offer still stand?" });
  const posted = await owner.wait<Extract<ServerFrame, { type: "message" }>>(f => f.type === "message");

  // the engine host — the connection allowed to speak for the owner's agents
  const engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");

  const close = () => { owner.close(); raj.close(); neha.close(); engine.close(); relay.close(); };
  return { relay, url, owner, raj, neha, engine, agent, board, message: posted.message, me, close };
}

const receipts = (c: TestClient) =>
  c.frames.filter((f): f is Extract<ServerFrame, { type: "receipt" }> => f.type === "receipt");

// ---------------------------------------------------------------------------
// 1. who hears it
// ---------------------------------------------------------------------------

test("a receipt reaches everyone in the room — and nobody outside it", async () => {
  const { owner, raj, neha, engine, agent, board, message, close } = await room("rcpt-audience.db");
  try {
    owner.frames.length = 0; raj.frames.length = 0; neha.frames.length = 0;

    engine.send({
      type: "agentReceipt", agentId: agent.id, channelId: board.id,
      messageId: message.id, stage: "reading",
    });
    await owner.wait(f => f.type === "receipt");
    await raj.wait(f => f.type === "receipt");
    await settle();

    assert.equal(receipts(owner).length, 1);
    assert.equal(receipts(raj).length, 1, "a member of the room sees it");
    assert.equal(receipts(neha).length, 0,
      "Neha is not in that room and must not learn the message even exists");

    const seen = receipts(raj)[0].receipt;
    assert.equal(seen.agentId, agent.id);
    assert.equal(seen.messageId, message.id);
    assert.equal(seen.channelId, board.id);
    assert.equal(seen.stage, "reading");
    assert.equal(seen.verdict, undefined, "a reading receipt carries no verdict");
    assert.ok(seen.at > 0, "the hub stamps the time, not the engine");
  } finally { close(); }
});

test("a committed verdict travels with which one it is", async () => {
  const { owner, engine, agent, board, message, close } = await room("rcpt-verdict.db");
  try {
    owner.frames.length = 0;
    engine.send({
      type: "agentReceipt", agentId: agent.id, channelId: board.id,
      messageId: message.id, stage: "verdict", verdict: "needsInput",
    });
    await owner.wait(f => f.type === "receipt");
    assert.equal(receipts(owner)[0].receipt.verdict, "needsInput");
  } finally { close(); }
});

test("a half-said receipt is refused rather than guessed at", async () => {
  const { owner, engine, agent, board, message, close } = await room("rcpt-shape.db");
  try {
    const refuse = async (frame: Parameters<TestClient["send"]>[0], contains: string) => {
      engine.frames.length = 0;
      engine.send(frame);
      const err = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
      assert.ok(err.error.includes(contains), `expected "${contains}", got "${err.error}"`);
    };
    // a verdict with nothing in it
    await refuse({
      type: "agentReceipt", agentId: agent.id, channelId: board.id,
      messageId: message.id, stage: "verdict",
    }, "verdict");
    // a "reading" carrying a ✅ — the exact shape that would let a machine
    // announce a decision while claiming to be doing nothing
    await refuse({
      type: "agentReceipt", agentId: agent.id, channelId: board.id,
      messageId: message.id, stage: "reading", verdict: "agreed",
    } as never, "only a committed receipt carries a verdict");
    // a message aimed at the wrong room
    await refuse({
      type: "agentReceipt", agentId: agent.id, channelId: "ch_nope",
      messageId: message.id, stage: "reading",
    }, "no such message");
  } finally { close(); }
});

test("a stranger cannot signal as somebody else's agent", async () => {
  const { raj, engine, agent, board, message, close } = await room("rcpt-owner.db");
  try {
    raj.frames.length = 0;
    raj.send({
      type: "agentReceipt", agentId: agent.id, channelId: board.id,
      messageId: message.id, stage: "verdict", verdict: "agreed",
    });
    const err = await raj.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
    assert.ok(/agent/i.test(err.error), `expected an ownership refusal, got "${err.error}"`);
    assert.equal(receipts(raj).length, 0);
    engine.frames.length = 0;
  } finally { close(); }
});

// ---------------------------------------------------------------------------
// 2. nothing is kept
// ---------------------------------------------------------------------------

test("receipts are STORED NOWHERE — not in history, not in search, not in unread", async () => {
  const { relay, url, owner, raj, engine, agent, board, message, me, close } = await room("rcpt-nostore.db");
  try {
    // where the room stood before any receipt went past
    const store = (relay as unknown as { store: {
      history: (id: string, cursor: Record<string, never>, limit: number) => { items: unknown[] };
      reactionsFor: (ids: string[]) => Map<string, unknown[]>;
      unreadFor: (u: string, c: string, s: Set<string>) => { unread: number };
    } }).store;
    const before = store.history(board.id, {}, 200).items.length;
    const unreadBefore = store.unreadFor(me.id, board.id, new Set([me.id])).unread;

    for (const stage of ["reading", "thinking"] as const) {
      engine.send({
        type: "agentReceipt", agentId: agent.id, channelId: board.id,
        messageId: message.id, stage,
      });
    }
    engine.send({
      type: "agentReceipt", agentId: agent.id, channelId: board.id,
      messageId: message.id, stage: "verdict", verdict: "investigating",
    });
    await settle();
    assert.equal(receipts(raj).length, 3, "all three really did go out — this is not a no-op test");

    // ...and the hub is exactly where it was
    assert.equal(store.history(board.id, {}, 200).items.length, before,
      "no receipt became a message");
    assert.equal(
      store.unreadFor(me.id, board.id, new Set([me.id])).unread, unreadBefore,
      "a machine signal is not something anybody has to catch up on");

    // no reaction row was created for the message either
    const forMessage = store.reactionsFor([message.id]).get(message.id);
    assert.ok(!forMessage || forMessage.length === 0,
      "a receipt is not a reaction and must never land in the reactions table");

    // and search cannot find any of it
    owner.frames.length = 0;
    owner.send({ type: "search", query: "investigating" });
    const hits = await owner.wait<Extract<ServerFrame, { type: "searchResults" }>>(
      f => f.type === "searchResults");
    assert.equal(hits.results.length, 0, "nothing was written, so there is nothing to find");

    // a fresh window sees a clean room: receipts do NOT come back on reconnect,
    // and that is the honest behaviour, not a bug
    const late = new TestClient(url, "tok-owner");
    const w = await late.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
    assert.equal(receipts(late).length, 0, "a reconnecting client has simply missed them");
    assert.ok(!JSON.stringify(w.state).includes("\"receipt\""),
      "receipts are not part of the world");
    late.close();
  } finally { close(); }
});
