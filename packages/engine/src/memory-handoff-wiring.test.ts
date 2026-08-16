// THE WIRING between the pure memory/handoff modules and a live turn.
//
// The modules themselves (agent-memory.ts, agent-handoff.ts) are tested next
// door. This file tests the three things the engine promises on top of them,
// and nothing the modules already prove:
//
//   (a) an agent's turn is SEEDED from its own saved notes;
//   (b) a note it is told to keep is WRITTEN and SURVIVES the engine closing;
//   (c) a handoff REACHES the receiving agent — its next turn carries the task.
//
// Each is driven through the real `Engine`, with a stub provider that records
// exactly what it was asked, and a fake socket that records every frame the
// engine sends.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef, ClientFrame, Message, WorldState } from "@cloud9/shared";
import { Engine } from "./engine.js";
import { engineActions } from "./hookwiring.js";
import { ClaudeProvider, RespondInput } from "./provider.js";
import { MemoryStore, newMemoryId } from "./agent-memory.js";
import { tempDir } from "./tmp-for-tests.js";

const OWNER = "u-vikas";

const tmp = (): string => tempDir("cloud9-memwire-");

class StubProvider implements ClaudeProvider {
  calls: RespondInput[] = [];
  async respond(input: RespondInput): Promise<string> {
    this.calls.push(input);
    return "stub reply";
  }
}

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: OWNER, name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
  createdAt: 0, ...over,
});

const trigger: Message = {
  id: "m1", channelId: "c1", authorId: OWNER, authorName: "Vikas",
  authorKind: "human", text: "find villas", ts: 0,
};

/**
 * A live engine with a stub provider and a fake socket that records every frame.
 * `state` is set so `myAgents` and the target lookup have something to read.
 */
function makeEngine(agents: AgentDef[] = [agent()]) {
  const provider = new StubProvider();
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(), provider,
  });
  const frames: ClientFrame[] = [];
  // sendFrame only writes to an OPEN socket (readyState === 1); this fake one
  // captures every frame the engine would have put on the wire.
  (engine as unknown as { ws: unknown }).ws = {
    readyState: 1,
    send: (raw: string) => frames.push(JSON.parse(raw) as ClientFrame),
  };
  engine.state = {
    me: { id: OWNER, name: "Vikas" },
    users: [{ id: OWNER, name: "Vikas" }],
    agents,
    channels: [{ id: "c1", name: "ops", kind: "channel", memberIds: [OWNER, ...agents.map(a => a.id)], createdAt: 0 }],
    messages: [], agentStatus: {}, tasks: [], approvals: [],
  } as unknown as WorldState;
  return { engine, provider, frames };
}

const agentSends = (frames: ClientFrame[]): string[] =>
  frames.filter((f): f is Extract<ClientFrame, { type: "agentSend" }> => f.type === "agentSend")
    .map(f => f.text);

// ------------------------------------------- (a) a turn is seeded from memory

test("a turn is seeded from the agent's own saved notes", async () => {
  const { engine, provider } = makeEngine();
  // a note the agent kept in some earlier conversation
  engine.memory.save({
    id: newMemoryId(), agentId: "a1", kind: "preference",
    text: "Vikas always wants villa prices in GBP and links to the listing",
    createdAt: Date.now(), source: "owner",
  });

  await engine.takeTurn(agent(), "c1", trigger);

  assert.equal(provider.calls.length, 1);
  const seeded = provider.calls[0].memory ?? "";
  assert.match(seeded, /prices in GBP/, "the saved note was seeded into the turn");
});

test("a channel turn never seeds a different channel's scoped note", async () => {
  const { engine, provider } = makeEngine();
  engine.state!.channels.push({
    id: "c2", name: "ops-2", kind: "channel", memberIds: [OWNER, "a1"], createdAt: 0,
  });
  engine.memory.save({
    id: newMemoryId(), agentId: "a1", kind: "fact",
    text: "C1 private plan", channelId: "c1", createdAt: Date.now(), source: "owner",
  });
  engine.memory.save({
    id: newMemoryId(), agentId: "a1", kind: "fact",
    text: "C2 private plan", channelId: "c2", createdAt: Date.now(), source: "owner",
  });

  await engine.takeTurn(agent(), "c2", { ...trigger, channelId: "c2" });

  const seeded = provider.calls[0].memory ?? "";
  assert.doesNotMatch(seeded, /C1 private plan/);
  assert.match(seeded, /C2 private plan/);
});

test("a No retention DM still seeds global memory but never its scoped notes", async () => {
  const { engine, provider } = makeEngine();
  engine.state!.channels = [{
    id: "dm-1", name: "direct", kind: "dm", memberIds: [OWNER, "a1"], createdAt: 0,
  }];
  engine.memory.save({
    id: newMemoryId(), agentId: "a1", kind: "fact",
    text: "Vikas prefers concise weekly reports", createdAt: Date.now(), source: "owner",
  });
  engine.memory.save({
    id: newMemoryId(), agentId: "a1", kind: "fact", channelId: "dm-1",
    text: "DM-only detail must not be seeded", createdAt: Date.now(), source: "owner",
  });

  await engine.takeTurn(agent(), "dm-1", { ...trigger, channelId: "dm-1" });

  const seeded = provider.calls[0].memory ?? "";
  assert.match(seeded, /concise weekly reports/);
  assert.doesNotMatch(seeded, /DM-only detail/);
});

test("memory reports keep global notes in a No retention DM and filter scoped notes", () => {
  const { engine, frames } = makeEngine();
  engine.state!.channels = [{
    id: "dm-1", name: "direct", kind: "dm", memberIds: [OWNER, "a1"], createdAt: 0,
  }];
  engine.memory.save({
    id: newMemoryId(), agentId: "a1", kind: "fact",
    text: "global report note", createdAt: Date.now(), source: "owner",
  });
  engine.memory.save({
    id: newMemoryId(), agentId: "a1", kind: "fact", channelId: "dm-1",
    text: "private DM report note", createdAt: Date.now(), source: "owner",
  });

  engine.reportMemory("a1");

  const report = frames.find((frame): frame is Extract<ClientFrame, { type: "memoryChanged" }> =>
    frame.type === "memoryChanged");
  assert.ok(report);
  assert.deepEqual(report.notes.map(note => note.text), ["global report note"]);
});

test("channel-scoped memory refuses unknown and non-member channels before saving", async () => {
  const { engine } = makeEngine();
  engine.state!.channels.push({
    id: "not-a-member", name: "closed", kind: "channel", memberIds: [OWNER], createdAt: 0,
  });

  const agentRefusal = await engine.rememberFromAgent(
    "a1", "this must not land in an unknown room", "fact", "missing-channel");
  assert.equal(agentRefusal.saved, false);
  assert.equal(engine.saveOwnerMemoryNote("a1", "missing-channel", "owner note"), false);
  assert.equal(engine.saveOwnerMemoryNote("a1", "not-a-member", "owner note"), false);
  await engine.rememberFromRoom(agent(), "missing-channel", "room note");
  assert.equal(engine.memory.list("a1").length, 0);

  assert.throws(() => engineActions(engine).note({
    agentId: "a1", channelId: "not-a-member", text: "hook note",
  }), /policy refused/i);
  assert.equal(engine.memory.list("a1").length, 0);
});

test("an agent with no memory is seeded with nothing, not an empty heading", async () => {
  const { engine, provider } = makeEngine();
  await engine.takeTurn(agent(), "c1", trigger);
  assert.equal(provider.calls[0].memory, "", "no notes means no memory string");
});

// ------------------------------------- (b) a note is written and it survives

test("a '!remember' note is written and survives the engine closing", async () => {
  const dataDir = tmp();
  const provider = new StubProvider();
  const engine = new Engine({ relayUrl: "ws://127.0.0.1:1", token: "t", dataDir, provider });
  engine.state = {
    me: { id: OWNER, name: "Vikas" }, users: [{ id: OWNER, name: "Vikas" }],
    agents: [agent()], channels: [], messages: [], agentStatus: {}, tasks: [], approvals: [],
  } as unknown as WorldState;
  engine.state.channels.push({
    id: "c1", name: "ops", kind: "channel", memberIds: [OWNER, "a1"], createdAt: 0,
  });
  const frames: ClientFrame[] = [];
  (engine as unknown as { ws: unknown }).ws = {
    readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw) as ClientFrame),
  };

  await engine.rememberFromRoom(agent(), "c1", "Vikas ships subscription-tracker on Fridays");

  // it landed in this engine's store
  const now = engine.memory.list("a1");
  assert.equal(now.length, 1);
  assert.match(now[0].text, /ships subscription-tracker on Fridays/);
  assert.equal(now[0].source, "owner");

  // it was confirmed in the room, and the fresh list was pushed to the screen
  assert.ok(agentSends(frames).some(t => /Saved to memory/i.test(t)), "the agent confirmed the save");
  assert.ok(frames.some(f => f.type === "memoryChanged"), "the new list was pushed to the owner's screens");

  // AND IT SURVIVES: a brand-new store reading the same folder sees the note,
  // which is the whole point of memory — it outlives the app closing.
  const reopened = new MemoryStore({ agentDataDir: (id: string) => path.join(dataDir, "agents", id) });
  const survived = reopened.list("a1");
  assert.equal(survived.length, 1);
  assert.match(survived[0].text, /ships subscription-tracker on Fridays/);
});

test("'!remember' refuses noise out loud and saves nothing", async () => {
  const { engine, frames } = makeEngine();
  await engine.rememberFromRoom(agent(), "c1", "thanks");
  assert.equal(engine.memory.list("a1").length, 0, "a pleasantry is not saved");
  assert.ok(agentSends(frames).some(t => /didn't save/i.test(t)), "and it said why");
});

// ------------------------------------------ (c) a handoff reaches the receiver

const scout = agent({ id: "a1", name: "Scout" });
const terra = agent({ id: "a2", name: "Terra" });

test("handing off in the room announces it and sends the handoff for delivery", async () => {
  const { engine, frames } = makeEngine([scout, terra]);

  await engine.handOffInRoom(scout, "c1", "Terra", "finish the deployment notes", "Vikas");

  // the plain-words line on screen, from a real handoff, in the sender's voice
  assert.ok(
    agentSends(frames).some(t => /Passed to @Terra/.test(t) && /finish the deployment notes/.test(t)),
    "a 'passed to @Terra' line appears in the room");

  // and the structured handoff is on its way to be delivered
  const handoffFrame = frames.find(
    (f): f is Extract<ClientFrame, { type: "sendHandoff" }> => f.type === "sendHandoff");
  assert.ok(handoffFrame, "a handoff was sent for delivery");
  assert.equal(handoffFrame!.handoff.fromAgentId, "a1");
  assert.equal(handoffFrame!.handoff.toAgentId, "a2");
  assert.equal(handoffFrame!.handoff.task, "finish the deployment notes");
  assert.equal(handoffFrame!.handoff.contextPointer.kind, "channel");
  assert.equal(handoffFrame!.handoff.contextPointer.ref, "c1");
});

test("a handoff a peer sends reaches the receiving agent's next turn", async () => {
  // the receiving engine owns Terra
  const { engine, provider, frames } = makeEngine([scout, terra]);

  await engine.receiveHandoff({
    id: "h-test-0001", fromAgentId: "a1", toAgentId: "a2",
    task: "finish the deployment notes",
    contextPointer: { kind: "channel", ref: "c1" },
    createdAt: Date.now(),
  });

  // Terra actually took a turn, and its instruction carried the handoff task
  assert.equal(provider.calls.length, 1, "the receiving agent took exactly one turn");
  const brief = provider.calls[0];
  assert.match(brief.trigger, /finish the deployment notes/, "the task reached the receiver");
  assert.match(brief.trigger, /@Scout has handed this piece of work to you/, "and it knows who from");
  // and it spoke back in the room the handoff pointed at, as Terra
  assert.ok(
    frames.some(f => f.type === "agentSend" && f.agentId === "a2" && f.channelId === "c1"),
    "the receiver answered in the conversation the handoff pointed at");
});

test("a handoff for an agent this engine does not own is ignored", async () => {
  // this engine owns only Scout; the handoff is TO Terra, who is not here
  const { engine, provider } = makeEngine([scout]);
  await engine.receiveHandoff({
    id: "h-test-0002", fromAgentId: "a9", toAgentId: "a2",
    task: "do a thing", contextPointer: { kind: "channel", ref: "c1" }, createdAt: Date.now(),
  });
  assert.equal(provider.calls.length, 0, "no turn is run for an agent we do not own");
});
