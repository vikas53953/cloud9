// WHAT ACTUALLY STOPS AN AGENT WRITING SOMEWHERE (gap C, measured 2026-08-05).
//
// THE MEASUREMENT. Probes against the INSTALLED Claude CLI (2.1.222) in `-p`
// mode, each writing to a folder that was neither the working directory nor
// named in any `--add-dir`:
//
//   --permission-mode dontAsk     + --add-dir A       → WRITE SUCCEEDED, 0 denials
//   --permission-mode acceptEdits + --add-dir A       → WRITE SUCCEEDED, 0 denials
//   --permission-mode manual      + --add-dir A       → WRITE SUCCEEDED, 0 denials
//   --permission-mode dontAsk, NO --add-dir at all    → WRITE SUCCEEDED, 0 denials
//   --settings permissions.deny naming that very file → WRITE SUCCEEDED, 0 denials
//   the same deny rule aimed INSIDE the workspace     → WRITE SUCCEEDED, 0 denials
//
// `claude --help` at 2.1.222 offers no sandbox flag at all. A Codex agent, by
// contrast, gets `-s workspace-write`, which is a genuine OS sandbox.
//
// SO THE FIX IS HONESTY, NOT A HALF-FENCE. These tests hold every owner-facing
// sentence to the truth: nothing Cloud9 shows may promise a wall around a folder
// on the Claude side, the real boundary (which tools exist) must still be stated
// and must still be real, and the Codex side must still say it has a fence.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentDef } from "@cloud9/shared";
import {
  CAPABILITIES, FILE_FENCE_WORDS, REACH_LEVELS, claudeToolsFor, codexSandboxFor,
  deniedClaudeTools, fileFenceFor, renderCapabilities,
} from "./abilities.js";
import { reachLineInRoom, wholeComputerRootsFor, wholeComputerWords } from "./wholecomputer.js";

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: {
    webSearch: true, files: true, helpers: true, schedules: true,
    background: true, wholeComputer: true, commands: true,
  },
  wholeComputerRoots: ["C:/work"],
  createdAt: 0, ...over,
});

const there = (): boolean => true;

/** Every sentence a person can read about an agent's reach to a folder. */
function ownerFacingSentences(a: AgentDef): string[] {
  const roots = wholeComputerRootsFor(a, there);
  const said: string[] = [];
  for (const state of ["off", "none", "gone", "partly", "ready"] as const) {
    const words = wholeComputerWords({ ...roots, state }, a.name);
    said.push(`${words.headline} ${words.detail}`);
  }
  /* THE ROOM'S LINE IS A SENTENCE HE READS TOO (2026-08-06). It went in the day
     the room stopped being able to go silent about reach, and it is swept here so
     it can never start promising the wall the rest of these sentences may not. */
  for (const folders of [undefined, [], ["C:/work"], ["C:/work", "D:/other"]]) {
    said.push(reachLineInRoom({ ...a, wholeComputerRoots: folders }, a.name).words);
    said.push(reachLineInRoom({
      ...a, abilities: { ...a.abilities, wholeComputer: false }, wholeComputerRoots: folders,
    }, a.name).words);
  }
  said.push(...REACH_LEVELS.map(l => l.plainWords));
  said.push(renderCapabilities(a, { wholeComputerRoots: ["C:/work"] }));
  said.push(renderCapabilities({ ...a, abilities: { ...a.abilities, wholeComputer: false } }));
  return said;
}

/** Claims a fence exists around a folder. Every one of these was measured false. */
const CLAIMS_A_WALL = [
  /and only these/i,
  /the rest of this computer is still closed/i,
  /cannot read or change anything else on this computer/i,
  /can only touch its own folder/i,
  /nothing on your pc changes/i,
  /still only its own folder/i,
  /CANNOT reach anything outside/i,
];

test("nothing the owner reads promises a wall around a folder on the Claude side", () => {
  // FAILS BEFORE THE CHANGE: the "ready" state said "and only these — the rest
  // of this computer is still closed to it", the "none" state said "it still
  // cannot read or change anything else on this computer", and two rungs of the
  // ladder said "Nothing on your PC changes" / "Still only its own folder".
  for (const said of ownerFacingSentences(agent())) {
    for (const claim of CLAIMS_A_WALL) {
      assert.doesNotMatch(said, claim,
        `a screen still promises a boundary the CLI does not have: ${said.slice(0, 140)}`);
    }
  }
});

test("the folder wording says plainly which kind of boundary this really is", () => {
  const claude = wholeComputerRootsFor(agent(), there);
  assert.equal(claude.fence, "tools-only");
  const ready = wholeComputerWords(claude, "Scout");
  assert.match(ready.detail, /pointed at these folders/i);
  assert.match(ready.detail, /not a lock|not a wall/i);
  // and it names the thing that IS enforced, so it does not read as "no limits"
  assert.match(ready.detail, /which tools it holds/i);
  // and the way to get a real fence, since there is one
  assert.match(ready.detail, /Codex/);
});

test("a Codex agent is told it HAS a fence, because it really does", () => {
  const codex = agent({ provider: "codex" });
  assert.equal(fileFenceFor(codex), "os-sandbox");
  // the fence is not a sentence — it is the flag the command line carries
  assert.equal(codexSandboxFor(codex), "workspace-write");
  const words = wholeComputerWords(wholeComputerRootsFor(codex, there), "Scout");
  assert.match(words.detail, /refused by its own program/i);
});

test("an agent whose file tools are off gets a fence Cloud9 really can hold", () => {
  // THE ONE BOUNDARY THAT IS REAL ON THE CLAUDE SIDE, and it must stay real:
  // the tool simply does not exist, and everything else is spelled out as denied.
  const noFiles = agent({
    abilities: {
      webSearch: true, files: false, helpers: false, schedules: false,
      background: false, wholeComputer: false, commands: false,
    },
  });
  const granted = claudeToolsFor(noFiles);
  for (const tool of ["Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep", "Bash", "PowerShell"]) {
    assert.ok(!granted.includes(tool), `${tool} was handed to an agent with no file switch`);
    assert.ok(deniedClaudeTools(noFiles).includes(tool), `${tool} was not spelled out as denied`);
  }
});

test("the words are read from ONE table, so no screen can invent its own version", () => {
  // the fault this whole change exists for was a screen writing its own sentence
  // about a boundary nobody had measured
  const roots = wholeComputerRootsFor(agent(), there);
  const words = FILE_FENCE_WORDS[roots.fence];
  const ready = wholeComputerWords(roots, "Scout");
  assert.ok(ready.detail.includes(words.headline), "the folder screen wrote its own headline");
  assert.ok(ready.detail.includes(words.detail), "the folder screen wrote its own explanation");
  // both kinds of fence are described, and they say different things
  assert.notEqual(FILE_FENCE_WORDS["os-sandbox"].detail, FILE_FENCE_WORDS["tools-only"].detail);
});

test("the agent is still given a hard RULE about folders, not a shrug", () => {
  // Honesty must not have cost the guard. The prompt still tells the agent, in
  // the strongest words, where it may work — it simply no longer claims the
  // computer will stop it.
  const row = CAPABILITIES.find(c => c.ability === "wholeComputer")!;
  for (const sentence of [row.can, row.cannot, row.onButNothingSupplied!]) {
    assert.match(sentence, /must (not )?(work|touch|NOT)/i,
      `a folder rule stopped being a rule: ${sentence.slice(0, 80)}`);
  }
  assert.match(row.cannot, /hard rule/i);
  // and the refusal still names the door — the 2026-08-05 law
  assert.ok(row.fixItInApp.length > 0);
});

test("the approval gate did not move: reaching outside a folder still always asks", () => {
  const row = CAPABILITIES.find(c => c.ability === "wholeComputer")!;
  assert.equal(row.alwaysAsk, true, "the always-ask guard was traded for honest wording");
  assert.equal(row.needsSupply, "wholeComputerRoots");
});
