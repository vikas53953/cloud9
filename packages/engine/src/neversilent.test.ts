// NEVER A DEAD END — the class law, held here (2026-08-06).
//
// THE REPORT, FOR THE THIRD TIME AND IN ANGER: "cloud9 is not able to access my
// pc… it is always saying I am not able to access this folder", "cloud9 agents
// still saying what I can't do", "make the agent fully agentic and don't give me
// any excuse about this". He had been told twice that it was fixed.
//
// WHAT WAS ACTUALLY STILL BROKEN, and it is two silences, not one:
//
//   1. THE ROOM. The line beside an agent's name spoke in two of the five reach
//      states and returned NOTHING in the other three — including the state
//      every new agent is now in (folders chosen). So the room he was standing
//      in said nothing at all about reach and offered no way to change it.
//
//   2. THE AGENT'S OWN WORDS. Every refusal carried a door since 2026-08-05 —
//      except the one an agent reads when the switch is ON. That is now the
//      common case (a new agent starts with the home folder), so the refusal he
//      meets today is "that folder is not on my list", and it was the single
//      sentence in the whole table with no way out written beside it.
//
// THE LAW, AND IT IS TESTED AS A CLASS, NOT AS A CASE: there is no state of any
// switch, and no shape of any stored agent, in which Cloud9 says "no" without
// saying how the owner changes it. Both halves are walked below in full — every
// provider, every switch, every folder list, every row of the table — so a new
// capability or a new state cannot regress into silence without failing here.
import assert from "node:assert/strict";
import test from "node:test";
import { AgentDef } from "@cloud9/shared";
import { CAPABILITIES, renderCapabilities } from "./abilities.js";
import { reachLineInRoom } from "./wholecomputer.js";

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", name: "Nova", persona: "tester", ownerId: "u1", createdAt: 1,
  ...over,
} as AgentDef);

/* ------------------------- half one: the room says something, always ------ */

/** Every shape the app can really store, spelled out rather than described. */
const PROVIDERS = [undefined, "claude", "codex"] as const;
const SWITCHES = [
  undefined,
  {},
  { wholeComputer: false },
  { wholeComputer: true },
  { wholeComputer: true, files: true, commands: true },
] as const;
const FOLDERS = [
  undefined,
  [],
  ["   "],
  ["C:\\Users\\vikasmit"],
  ["C:\\Users\\vikasmit", "D:\\work"],
] as const;

test("the room is never silent about reach, whatever is stored", () => {
  for (const provider of PROVIDERS) {
    for (const abilities of SWITCHES) {
      for (const wholeComputerRoots of FOLDERS) {
        const line = reachLineInRoom(agent({
          provider: provider as AgentDef["provider"],
          abilities: abilities as AgentDef["abilities"],
          wholeComputerRoots: wholeComputerRoots as string[] | undefined,
        }), "Nova");
        const where = `provider=${provider} abilities=${JSON.stringify(abilities)} `
          + `folders=${JSON.stringify(wholeComputerRoots)}`;
        assert.ok(line, `no line at all for ${where}`);
        assert.ok(["off", "none", "chosen"].includes(line.state), `odd state for ${where}`);
        // a whole sentence, not a word, and it names the agent he is looking at
        assert.ok(line.words.trim().length > 20, `no sentence for ${where}`);
        assert.ok(line.words.includes("Nova"), `the sentence does not name the agent: ${where}`);
        // and a door — a refusal with no way to change it is the fault itself
        assert.ok(line.fix.trim().length > 0, `no way to change it for ${where}`);
      }
    }
  }
});

test("the three states are told apart by what is really stored", () => {
  const off = reachLineInRoom(agent({ abilities: { wholeComputer: false } as AgentDef["abilities"] }), "Nova");
  assert.equal(off.state, "off");
  assert.match(off.words, /own folder/i);

  const none = reachLineInRoom(agent({ abilities: { wholeComputer: true } as AgentDef["abilities"] }), "Nova");
  assert.equal(none.state, "none");
  assert.match(none.words, /no folder has been chosen/i);

  const chosen = reachLineInRoom(agent({
    abilities: { wholeComputer: true } as AgentDef["abilities"],
    wholeComputerRoots: ["C:\\Users\\vikasmit"],
  }), "Nova");
  assert.equal(chosen.state, "chosen");
  assert.match(chosen.words, /1 folder/);
});

test("a blank folder list is the same answer as no folder list", () => {
  const blank = reachLineInRoom(agent({
    abilities: { wholeComputer: true } as AgentDef["abilities"],
    wholeComputerRoots: ["  ", ""],
  }), "Nova");
  assert.equal(blank.state, "none");
});

test("two folders are counted as two, so the line cannot overstate its reach", () => {
  const two = reachLineInRoom(agent({
    abilities: { wholeComputer: true } as AgentDef["abilities"],
    wholeComputerRoots: ["C:\\a", "C:\\b"],
  }), "Nova");
  assert.match(two.words, /2 folders/);
});

/* ------------- half two: the agent's own words always name the door ------- */

/** The one route into the app any refusal is allowed to name. */
const THE_DOOR = /in my editor|on my card in the crew list/i;

/** Everything on the table, switched on, so a "supplied" row reads as supplied. */
const ALL_ON = Object.fromEntries(
  CAPABILITIES.map(c => [c.ability, true])) as unknown as AgentDef["abilities"];

test("a row that needs something supplied also says how to widen it", () => {
  // the 2026-08-06 hole: this was the only state of any switch with no door
  for (const cap of CAPABILITIES.filter(c => c.needsSupply)) {
    assert.ok(cap.widenItInApp && cap.widenItInApp.trim().length > 0,
      `"${cap.label}" is bounded by something the owner supplies and never says how to widen it`);
    assert.match(cap.widenItInApp, THE_DOOR,
      `"${cap.label}" says how to widen it without naming where: ${cap.widenItInApp}`);
  }
});

test("every switch, in every state, tells the agent how the owner opens the door", () => {
  const supplied = { wholeComputerRoots: ["C:\\work"], mcpConfigPath: "C:\\work\\mcp.json" };
  for (const provider of ["claude", "codex"] as const) {
    const states = [
      // nothing switched on at all — every row reads as a refusal
      { what: "all off", a: agent({ provider, abilities: {} as AgentDef["abilities"] }), granted: {} },
      // switched on with nothing handed over — the half-state that burned him
      { what: "on, nothing supplied", a: agent({ provider, abilities: ALL_ON }), granted: {} },
      // switched on WITH folders and a connections file — today's common case
      { what: "on and supplied", a: agent({ provider, abilities: ALL_ON }), granted: supplied },
    ];
    for (const state of states) {
      /* ONLY THE SWITCH BULLETS. The block after "True for every agent" is about
         what every agent in Cloud9 is (no memory of past conversations, no tools
         beyond the list) — facts no owner can switch, so a door there would be a
         lie, not a kindness. */
      const said = renderCapabilities(state.a, state.granted,
        provider === "codex" ? "codex" : "declared")
        .split("True for every agent in Cloud9")[0];
      for (const line of said.split("\n").filter(l => l.startsWith("•"))) {
        /* A LINE THAT SAYS "NO" MUST SAY "HERE IS HOW". A line that grants
           something without any boundary the owner can widen needs no door. */
        const refuses = /CANNOT|must NOT|must not|not on that list|no service is connected/i.test(line);
        const bounded = /only inside|opened up for you|set up for you specifically/i.test(line);
        if (!refuses && !bounded) continue;
        assert.match(line, THE_DOOR,
          `${provider}, ${state.what}: an agent is told "no" with no way out — ${line.slice(0, 180)}`);
      }
    }
  }
});

test("the folder row names the door in the state he is actually in today", () => {
  // a new agent: switch on, home folder already chosen. He asks for a folder
  // that is not on the list — the agent must not stop at "I must not".
  const said = renderCapabilities(
    agent({ provider: "claude", abilities: ALL_ON }),
    { wholeComputerRoots: ["C:\\Users\\vikasmit"] });
  const folderLine = said.split("\n").find(l => /outside your own folder|opened up for you/i.test(l));
  assert.ok(folderLine, "the folder rule vanished from what the agent is told");
  assert.match(folderLine, THE_DOOR);
  assert.match(folderLine, /open that up for me/i);
});
