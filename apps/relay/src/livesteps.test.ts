// LIVE STEPS AT THE HUB — the same two promises receipts make, and for the
// same reasons (`receipts.test.ts` is this file's twin; read it first).
//
//  1. IT FORWARDS TO THE ROOM AND NOBODY ELSE. These steps name files, commands
//     and searches on the owner's computer, drawn against one message. Somebody
//     outside the room must not learn that the message exists, let alone what an
//     agent is doing about it. It reuses the ONE visibility owner every other
//     broadcast uses (`audienceFor`, via `toChannel`).
//  2. IT STORES NOTHING. Not a message, not an activity row, and — the one that
//     matters most here — NOT A RUN RECORD. The record is written once, at the
//     end of the turn, by the path that already writes it. A live preview that
//     quietly became a second copy would be the same facts kept twice, and two
//     copies of a fact is one copy that can be wrong.
import test from "node:test";
import assert from "node:assert/strict";
import { RunStep, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
};

const STEP = (over: Partial<RunStep> = {}): RunStep => ({
  seq: 1, kind: "read", label: "Read note.txt", detail: "note.txt", ...over,
});

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

  owner.send({ type: "send", channelId: board.id, text: "read the note and tell me what it says" });
  const posted = await owner.wait<Extract<ServerFrame, { type: "message" }>>(f => f.type === "message");

  const engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");

  const close = () => { owner.close(); raj.close(); neha.close(); engine.close(); relay.close(); };
  return { relay, url, owner, raj, neha, engine, agent, board, message: posted.message, me, close };
}

const live = (c: TestClient) =>
  c.frames.filter((f): f is Extract<ServerFrame, { type: "liveSteps" }> => f.type === "liveSteps");

// ---------------------------------------------------------------------------
// 1. who hears it
// ---------------------------------------------------------------------------

test("live steps reach everyone in the room — and nobody outside it", async () => {
  const { owner, raj, neha, engine, agent, board, message, close } = await room("live-audience.db");
  try {
    owner.frames.length = 0; raj.frames.length = 0; neha.frames.length = 0;

    engine.send({
      type: "agentSteps", agentId: agent.id, channelId: board.id,
      messageId: message.id, steps: [STEP()],
    });
    await owner.wait(f => f.type === "liveSteps");
    await raj.wait(f => f.type === "liveSteps");
    await settle();

    assert.equal(live(owner).length, 1);
    assert.equal(live(raj).length, 1, "a member of the room sees it");
    assert.equal(live(neha).length, 0,
      "Neha is not in that room and must not learn the message even exists");

    const seen = live(raj)[0].live;
    assert.equal(seen.agentId, agent.id);
    assert.equal(seen.messageId, message.id);
    assert.equal(seen.channelId, board.id);
    assert.deepEqual(seen.steps.map(s => [s.seq, s.kind, s.label]), [[1, "read", "Read note.txt"]]);
    assert.equal(seen.done, undefined, "an ordinary batch is not an ending");
    assert.ok(seen.at > 0, "the hub stamps the time, not the engine");
  } finally { close(); }
});

test("steps arrive in the order they were sent, and an ending closes the preview", async () => {
  const { owner, engine, agent, board, message, close } = await room("live-order.db");
  try {
    owner.frames.length = 0;
    const send = (steps?: RunStep[], done?: boolean) => engine.send({
      type: "agentSteps", agentId: agent.id, channelId: board.id, messageId: message.id,
      ...(steps ? { steps } : {}), ...(done ? { done } : {}),
    });
    send([STEP({ seq: 1, kind: "search", label: "Searched for “villa”" })]);
    send([STEP({ seq: 2, kind: "read", label: "Read note.txt" })]);
    // the SAME step again, now with its outcome — this is why clients merge by
    // `seq` rather than appending
    send([STEP({ seq: 2, kind: "read", label: "Read note.txt", ok: true })]);
    send(undefined, true);

    await owner.wait(f => f.type === "liveSteps" && !!f.live.done);
    const got = live(owner);
    assert.deepEqual(got.map(f => f.live.steps.map(s => s.seq)), [[1], [2], [2], []]);
    assert.equal(got[2].live.steps[0].ok, true);
    assert.equal(got[3].live.done, true, "the ending carries no steps, by design");
  } finally { close(); }
});

test("a stranger cannot show work as somebody else's agent", async () => {
  const { raj, agent, board, message, close } = await room("live-owner.db");
  try {
    raj.frames.length = 0;
    raj.send({
      type: "agentSteps", agentId: agent.id, channelId: board.id,
      messageId: message.id, steps: [STEP()],
    });
    const err = await raj.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
    assert.ok(/agent/i.test(err.error), `expected an ownership refusal, got "${err.error}"`);
    assert.equal(live(raj).length, 0);
  } finally { close(); }
});

test("a half-said live update is refused rather than guessed at", async () => {
  const { engine, agent, board, message, close } = await room("live-shape.db");
  try {
    const refuse = async (frame: Parameters<TestClient["send"]>[0], contains: string) => {
      engine.frames.length = 0;
      engine.send(frame);
      const err = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
      assert.ok(err.error.includes(contains), `expected "${contains}", got "${err.error}"`);
    };
    const base = { type: "agentSteps" as const, agentId: agent.id, channelId: board.id, messageId: message.id };
    // neither steps nor an ending — it says nothing at all
    await refuse({ ...base }, "steps or an ending");
    // a frame trying to be a whole record instead of a signal
    await refuse({ ...base, steps: Array.from({ length: 40 }, (_v, i) => STEP({ seq: i + 1 })) },
      "too many steps");
    // a step with no place in the run — a client could not merge it
    await refuse({ ...base, steps: [{ kind: "read", label: "Read note.txt" }] } as never, "place in the run");
    // an oversized label, refused by the SAME limit a stored record lives under
    await refuse({ ...base, steps: [STEP({ label: "x".repeat(500) })] }, "too long");
    // aimed at the wrong room
    await refuse({ ...base, channelId: "ch_nope", steps: [STEP()] }, "no such message");
  } finally { close(); }
});

test("a live step is redacted on the way out, exactly as a stored one is", async () => {
  const { owner, engine, agent, board, message, close } = await room("live-redact.db");
  try {
    owner.frames.length = 0;
    engine.send({
      type: "agentSteps", agentId: agent.id, channelId: board.id, messageId: message.id,
      steps: [STEP({ kind: "command", label: "Ran a command", detail: "export TOKEN=sk-ant-secret-value-here" })],
    });
    const seen = (await owner.wait<Extract<ServerFrame, { type: "liveSteps" }>>(
      f => f.type === "liveSteps")).live;
    assert.ok(!(seen.steps[0].detail ?? "").includes("sk-ant-secret-value-here"),
      "a live step does not get to leak what a stored one would not");
  } finally { close(); }
});

// ---------------------------------------------------------------------------
// 2. nothing is kept
// ---------------------------------------------------------------------------

test("live steps are STORED NOWHERE — not history, not search, not unread, NOT A RUN", async () => {
  const { relay, url, owner, raj, engine, agent, board, message, me, close } =
    await room("live-nostore.db");
  try {
    const store = (relay as unknown as { store: {
      history: (id: string, cursor: Record<string, never>, limit: number) => { items: unknown[] };
      unreadFor: (u: string, c: string, s: Set<string>) => { unread: number };
      runsForAgent?: (a: string, limit: number) => unknown[];
    } }).store;
    const before = store.history(board.id, {}, 200).items.length;
    const unreadBefore = store.unreadFor(me.id, board.id, new Set([me.id])).unread;

    for (const seq of [1, 2, 3]) {
      engine.send({
        type: "agentSteps", agentId: agent.id, channelId: board.id, messageId: message.id,
        steps: [STEP({ seq, label: `Read secret-plan-${seq}.txt` })],
      });
    }
    engine.send({
      type: "agentSteps", agentId: agent.id, channelId: board.id, messageId: message.id, done: true,
    });
    await raj.wait(f => f.type === "liveSteps" && !!f.live.done);
    await settle();
    assert.equal(live(raj).length, 4,
      `all four really did go out — this is not a no-op test. engine said: ${
        JSON.stringify(engine.frames.filter(f => f.type === "error"))}`);

    // ...and the hub is exactly where it was
    assert.equal(store.history(board.id, {}, 200).items.length, before,
      "no live step became a message");
    assert.equal(store.unreadFor(me.id, board.id, new Set([me.id])).unread, unreadBefore,
      "a machine signal is not something anybody has to catch up on");

    // THE ONE THIS FILE EXISTS FOR: no run record was invented from the preview.
    // The record is written once, at the end of the turn, by `runRecorded`.
    owner.frames.length = 0;
    owner.send({ type: "runList", agentId: agent.id, limit: 20 });
    const listed = await owner.wait<Extract<ServerFrame, { type: "runs" }>>(f => f.type === "runs");
    assert.equal(listed.runs.length, 0, "a live preview must never become a stored run");

    // and search cannot find any of it
    owner.frames.length = 0;
    owner.send({ type: "search", query: "secret-plan" });
    const hits = await owner.wait<Extract<ServerFrame, { type: "searchResults" }>>(
      f => f.type === "searchResults");
    assert.equal(hits.results.length, 0, "nothing was written, so there is nothing to find");

    // a fresh window sees a clean room. Live steps do NOT come back on reload,
    // and that is the honest behaviour, not a bug — the RECORD is what comes
    // back, by its own path, when the turn ends.
    const late = new TestClient(url, "tok-owner");
    const w = await late.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
    assert.equal(live(late).length, 0, "a reconnecting client has simply missed them");
    assert.ok(!JSON.stringify(w.state).includes("liveSteps"),
      "live steps are not part of the world");
    late.close();
  } finally { close(); }
});
