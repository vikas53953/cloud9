// GAP A (2026-08-05) — AN AGENT CAN NOW REMEMBER SOMETHING BY ITSELF.
//
// Cloud9 already had the store, the per-turn seeding and the memory panel. The
// only way a note could ever be written was the owner typing "!remember …", so
// an agent could be corrected ten times and start the eleventh conversation
// knowing nothing. What was missing was a TOOL, and this file is its boundary.
//
// The law, and the whole of it:
//
//     AN AGENT MAY WRITE ONLY INTO ITS OWN MEMORY.
//
// These tests attack that from every side a model could reach: an agent named
// in the arguments, a turn that belongs to somebody else's agent, a doorway
// that was never opened, and a turn that tries to write all day.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef, ClientFrame, WorldState } from "@cloud9/shared";
import { Engine } from "./engine.js";
import { ClaudeProvider, RespondInput } from "./provider.js";
import {
  answerCloud9Rpc, callCloud9Tool, CLOUD9_TOOLS, Cloud9RememberAnswer, Cloud9ToolTurn,
  cloud9TextOf, renderCloud9Tools,
} from "./cloud9tools.js";
import { MEMORY_NOTES_PER_TURN, MEMORY_NOTE_LIMIT } from "./agent-memory.js";
import { tempDir } from "./tmp-for-tests.js";

const OWNER = "u-vikas";
const tmp = (): string => tempDir("cloud9-agentmem-");

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

function makeEngine(agents: AgentDef[] = [agent()]) {
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(), provider: new StubProvider(),
  });
  const frames: ClientFrame[] = [];
  (engine as unknown as { ws: unknown }).ws = {
    readyState: 1,
    send: (raw: string) => frames.push(JSON.parse(raw) as ClientFrame),
  };
  engine.state = {
    me: { id: OWNER, name: "Vikas" },
    users: [{ id: OWNER, name: "Vikas" }],
    agents,
    channels: [{
      id: "c1", name: "ops", kind: "channel",
      memberIds: [OWNER, ...agents.map(a => a.id)], createdAt: 0,
    }],
    messages: [], agentStatus: {}, tasks: [], approvals: [],
  } as unknown as WorldState;
  return { engine, frames };
}

/** The tool row, read off the one table so a rename cannot leave these behind. */
const REMEMBER = CLOUD9_TOOLS.find(t => t.name === "remember_this")!;

/** A stand-in Cloud9 that records which agent each write actually reached. */
function stand() {
  const wrote: { text: string; kind: string }[] = [];
  const turn: Cloud9ToolTurn = {
    channelId: "c1",
    search: async () => ({ hits: [], hasMore: false }),
    openAttachment: async () => ({ found: false, why: "no" }),
    remember: async (text: string, kind: string): Promise<Cloud9RememberAnswer> => {
      wrote.push({ text, kind });
      return { saved: true, text };
    },
  };
  return { turn, wrote };
}

// A tool result stopped being "one text block" the day a picture could be in
// one, so the words are read through the engine's own owner of that question
// rather than a second copy here.
const said = cloud9TextOf;

// ------------------------------------------------ the tool exists and is told

test("the agent is TOLD it can remember things, from the same table the harness is handed", () => {
  assert.ok(REMEMBER, "there is a remember_this row");
  const paragraph = renderCloud9Tools();
  assert.ok(paragraph.includes("remember_this"),
    "a tool the harness gets and the agent is never told about is a capability nobody uses");
  assert.ok(REMEMBER.toolName.endsWith("__remember_this"));
});

test("tools/list offers remember_this with no way to name another agent", async () => {
  const { turn } = stand();
  const answer = await answerCloud9Rpc({ id: 1, method: "tools/list" }, turn);
  const tools = (answer!.result as { tools: { name: string; inputSchema: Record<string, unknown> }[] }).tools;
  const row = tools.find(t => t.name === "remember_this")!;
  assert.ok(row, "remember_this is on the wire, not just in the prompt");
  const props = Object.keys((row.inputSchema as { properties: Record<string, unknown> }).properties);
  assert.deepEqual(props.sort(), ["kind", "text"],
    "two properties, and neither of them names an agent, an owner or an id");
});

// ------------------------------------------------------------- the boundary

test("an agent named in the arguments is REFUSED, not ignored", async () => {
  const { turn, wrote } = stand();
  const out = await callCloud9Tool(
    REMEMBER, { text: "the deploy key lives in the vault", agentId: "a2" }, turn);
  assert.equal(out.isError, true);
  assert.match(said(out), /only write into your own memory/i);
  assert.equal(wrote.length, 0, "nothing was written when the arguments tried to widen the scope");
});

test("a turn with no memory doorway says so plainly and writes nothing", async () => {
  const turn: Cloud9ToolTurn = {
    channelId: "c1",
    search: async () => ({ hits: [], hasMore: false }),
    openAttachment: async () => ({ found: false, why: "no" }),
    // no `remember` — an older caller, or a turn opened without an agent
  };
  const out = await callCloud9Tool(REMEMBER, { text: "something worth keeping here" }, turn);
  assert.equal(out.isError, true);
  assert.match(said(out), /cannot save anything to your memory/i);
});

test("a refusal from underneath is handed back as words, never as an error from the engine", async () => {
  const turn: Cloud9ToolTurn = {
    channelId: "c1",
    search: async () => ({ hits: [], hasMore: false }),
    openAttachment: async () => ({ found: false, why: "no" }),
    remember: async () => { throw new Error("C:\\Users\\vikasmit\\secret\\path exploded"); },
  };
  const out = await callCloud9Tool(REMEMBER, { text: "something worth keeping here" }, turn);
  assert.equal(out.isError, true);
  assert.ok(!said(out).includes("vikasmit"), "no path, no argv, no error from underneath");
});

test("an empty note is refused before it reaches the store", async () => {
  const { turn, wrote } = stand();
  const out = await callCloud9Tool(REMEMBER, { text: "   " }, turn);
  assert.equal(out.isError, true);
  assert.equal(wrote.length, 0);
});

test("the kind rides along, and defaults to a fact when it is not given", async () => {
  const { turn, wrote } = stand();
  await callCloud9Tool(REMEMBER, { text: "the owner deploys on Tuesdays", kind: "correction" }, turn);
  await callCloud9Tool(REMEMBER, { text: "the owner deploys on Tuesdays" }, turn);
  assert.deepEqual(wrote.map(w => w.kind), ["correction", "fact"]);
});

// --------------------------------------------- the engine half: what lands

test("what an agent remembers is stored as ITS OWN, stamped as written by the agent", async () => {
  const { engine, frames } = makeEngine();
  const answer = await engine.rememberFromAgent(
    "a1", "Vikas wants villa prices in GBP, always", "preference");
  assert.equal(answer.saved, true);

  const notes = engine.memory.list("a1");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].text, "Vikas wants villa prices in GBP, always");
  assert.equal(notes[0].kind, "preference");
  assert.equal(notes[0].source, "agent",
    "the owner must be able to tell the agent's own notes from his — this is that field");

  // AND THE OWNER'S SCREEN IS TOLD AT ONCE. Visibility is the whole reason this
  // needs no confirmation prompt, so it must not wait for him to reopen a panel.
  const pushed = frames.filter(f => f.type === "memoryChanged");
  assert.equal(pushed.length, 1, "the memory panel is pushed the new list the moment a note lands");
});

test("an agent cannot write into another owner's agent's memory", async () => {
  const { engine } = makeEngine([agent()]);
  const answer = await engine.rememberFromAgent(
    "a-somebody-elses", "I should not be here at all", "fact");
  assert.equal(answer.saved, false);
  assert.match(answer.saved === false ? answer.why : "", /does not belong to you/i);
  assert.equal(engine.memory.list("a-somebody-elses").length, 0, "and nothing was written");
});

test("the agent's own notes go through the SAME rule as the owner's", async () => {
  const { engine } = makeEngine();
  const tooLong = await engine.rememberFromAgent("a1", "x".repeat(MEMORY_NOTE_LIMIT + 1), "fact");
  assert.equal(tooLong.saved, false, "a note over the cap is refused, never truncated");
  const question = await engine.rememberFromAgent("a1", "what does the owner want?", "fact");
  assert.equal(question.saved, false, "a question is not a memory");
  const pleasantry = await engine.rememberFromAgent("a1", "thanks", "fact");
  assert.equal(pleasantry.saved, false);
  assert.equal(engine.memory.list("a1").length, 0, "none of them reached the disk");
});

test("a kind nobody has heard of is kept as a fact, not refused and not stored raw", async () => {
  const { engine } = makeEngine();
  await engine.rememberFromAgent("a1", "the office wifi drops at 6pm", "vibes");
  assert.equal(engine.memory.list("a1")[0].kind, "fact");
});

test("what an agent remembers today seeds its turn tomorrow", async () => {
  const { engine } = makeEngine();
  await engine.rememberFromAgent("a1", "the staging database is the one on port 5433", "fact");
  const seeded = (engine as unknown as { rememberedFor(id: string): string }).rememberedFor("a1");
  assert.match(seeded, /staging database/);
  assert.match(seeded, /from self/, "and it reads back knowing the note was its own");
});

// ------------------------------------------------------- the per-turn ceiling

test("one turn may keep only a few notes, and is told plainly when it has had its share", async () => {
  const { engine } = makeEngine();
  await engine.tools.start();
  try {
    const open = engine.openToolTurn({ channelId: "c1", agentId: "a1" })!;
    assert.ok(open, "the doorway opened");
    const turn = (engine.tools as unknown as { turns: Map<string, Cloud9ToolTurn> })
      .turns.get(open.secret)!;
    const answers: Cloud9RememberAnswer[] = [];
    for (let i = 0; i < MEMORY_NOTES_PER_TURN + 2; i++) {
      answers.push(await turn.remember!(`the owner's rule number ${i} is a real one`, "fact"));
    }
    const saved = answers.filter(a => a.saved).length;
    assert.equal(saved, MEMORY_NOTES_PER_TURN, "the ceiling is the ceiling");
    const refused = answers.find(a => !a.saved);
    assert.match(refused && !refused.saved ? refused.why : "", /already saved/i);
    assert.equal(engine.memory.list("a1").length, MEMORY_NOTES_PER_TURN,
      "and the store agrees with the answers");

    // A SECOND TURN STARTS WITH ITS ALLOWANCE BACK — the counter belongs to the
    // turn, not to the agent.
    const next = engine.openToolTurn({ channelId: "c1", agentId: "a1" })!;
    const nextTurn = (engine.tools as unknown as { turns: Map<string, Cloud9ToolTurn> })
      .turns.get(next.secret)!;
    assert.equal((await nextTurn.remember!("tomorrow is a fresh allowance", "fact")).saved, true);
    open.close();
    next.close();
  } finally {
    engine.tools.stop();
  }
});

test("a turn opened without an agent has NO memory doorway at all", async () => {
  const { engine } = makeEngine();
  await engine.tools.start();
  try {
    const open = engine.openToolTurn({ channelId: "c1" })!;
    const turn = (engine.tools as unknown as { turns: Map<string, Cloud9ToolTurn> })
      .turns.get(open.secret)!;
    assert.equal(turn.remember, undefined,
      "no agent means no memory — never somebody else's memory");
    open.close();
  } finally {
    engine.tools.stop();
  }
});
