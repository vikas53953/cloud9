// THE FOLDERS OUTSIDE ITS OWN — proving the LAST inert switch is no longer a
// promise with nothing behind it, and that it never claims more than it has.
//
// The `wholeComputer` switch has been wired at the command line since 2026-07-30
// (`claudeArgs` passes `--add-dir`, `grantedSupply` gates it) and NOTHING on any
// screen ever chose a folder, so it was permanently inert: allowed, approved,
// and handing the agent nothing at all. `wholecomputer.ts` is the one owner that
// closes that — stored folders become a real supply, or an honest reason why not.
//
// These tests pin the answers the owner has to be able to trust:
//   folders chosen        → the engine really gets them, and so does the argv;
//   none chosen           → the engine gets nothing and the screen says so;
//   a folder that is GONE → reported in plain words, and never used anyway;
//   the switch off        → nothing supplied, and the disk is never touched;
//   a path we refuse      → refused without a disk lookup at all.
import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentAbilities, AgentDef, validateWholeComputerRoot, validateWholeComputerRoots,
  WHOLE_COMPUTER_LIMITS,
} from "@cloud9/shared";
import { addDirRootsFor, wholeComputerRootsFor, wholeComputerWords } from "./wholecomputer.js";
import { grantedSupply, renderCapabilities } from "./abilities.js";
import { claudeArgs } from "./claude-cli.js";

const ALL_OFF: AgentAbilities = {
  webSearch: false, files: false, schedules: false, background: false,
};

const agent = (abilities: Partial<AgentAbilities> = {}, over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { ...ALL_OFF, ...abilities }, createdAt: 0, ...over,
});

const NOTES = "C:\\Users\\Vikas\\Documents\\notes";
const SHOOT = "C:\\Users\\Vikas\\Pictures\\shoot";

/** a disk where exactly these folders exist, remembering what was asked */
const diskWith = (...there: string[]) => {
  const asked: string[] = [];
  const onDisk = (p: string): boolean => { asked.push(p); return there.includes(p); };
  return { onDisk, asked };
};

/** every `--add-dir` really on the command line, in order */
const addDirs = (args: string[]): string[] =>
  args.flatMap((a, i) => (a === "--add-dir" ? [args[i + 1]] : []));

// -------------------------------------------- an agent WITH folders gets them

test("an agent with folders: the engine is handed those exact folders", () => {
  const scout = agent({ wholeComputer: true }, { wholeComputerRoots: [NOTES, SHOOT] });
  const disk = diskWith(NOTES, SHOOT);

  const state = wholeComputerRootsFor(scout, disk.onDisk);
  assert.equal(state.state, "ready");
  assert.deepEqual(state.chosen, [NOTES, SHOOT]);
  assert.deepEqual(state.missing, []);
  assert.deepEqual(state.supply, [NOTES, SHOOT]);

  // what the engine host actually reads
  assert.deepEqual(addDirRootsFor(scout, disk.onDisk), [NOTES, SHOOT],
    "the one owner of folder resolution must hand the launcher the owner's folders");
  assert.ok(disk.asked.includes(NOTES) && disk.asked.includes(SHOOT),
    "and it must ask the disk, not assume");

  // and they survive every gate between here and the command line
  const supplied = grantedSupply(scout, { wholeComputerRoots: addDirRootsFor(scout, disk.onDisk) });
  assert.deepEqual(supplied.wholeComputerRoots, [NOTES, SHOOT]);
  const args = claudeArgs(scout, [], { wholeComputerRoots: addDirRootsFor(scout, disk.onDisk) });
  assert.deepEqual(addDirs(args), [NOTES, SHOOT],
    "the whole point: the folders the owner chose reach the real argv");
});

test("with folders really there, the agent is told it CAN reach outside its own folder", () => {
  const scout = agent({ wholeComputer: true }, { wholeComputerRoots: [NOTES] });
  const disk = diskWith(NOTES);
  const prompt = renderCapabilities(
    scout, grantedSupply(scout, { wholeComputerRoots: addDirRootsFor(scout, disk.onDisk) }));
  // GAP C (2026-08-05): a rule the agent must keep, not a wall it cannot climb.
  assert.match(prompt, /must work ONLY inside your own folder and the places your owner/);
});

test("the same folder twice is one folder, on the screen and on the command line", () => {
  const scout = agent({ wholeComputer: true },
    { wholeComputerRoots: [NOTES, ` ${NOTES} `, NOTES] });
  const disk = diskWith(NOTES);
  const state = wholeComputerRootsFor(scout, disk.onDisk);
  assert.deepEqual(state.chosen, [NOTES], "a duplicate would read as more reach than he gave");
  assert.deepEqual(addDirs(claudeArgs(scout, [], {
    wholeComputerRoots: addDirRootsFor(scout, disk.onDisk),
  })), [NOTES]);
});

// ------------------------------------------ an agent WITHOUT any gets nothing

test("no folder chosen: the engine gets nothing and the screen says there is none", () => {
  const scout = agent({ wholeComputer: true });
  const disk = diskWith(NOTES);

  const state = wholeComputerRootsFor(scout, disk.onDisk);
  assert.equal(state.state, "none");
  assert.deepEqual(state.chosen, []);
  assert.deepEqual(state.supply, []);
  assert.deepEqual(addDirRootsFor(scout, disk.onDisk), []);
  assert.equal(disk.asked.length, 0, "there is nothing to check, so nothing is checked");

  // the words the owner reads
  const words = wholeComputerWords(state, "Scout");
  assert.match(words.headline, /No folders chosen yet/);
  // GAP C: "it has none — it still cannot read or change anything else on this
  // computer" was measured false. What is true is that it was sent nowhere.
  assert.match(words.detail, /it has been sent nowhere, so it stays in its own folder/);
  assert.doesNotMatch(words.headline + words.detail, /\bin use\b/i,
    "a switch with nothing behind it must never read as working");

  // nothing on the command line, and the agent is told the truth about it
  assert.deepEqual(addDirs(claudeArgs(scout)), []);
  assert.match(
    renderCapabilities(scout, grantedSupply(scout, {})),
    /must NOT touch anything outside your own folder right now/);
});

test("blank and whitespace mean the same as absent — there is no second way to say none", () => {
  const disk = diskWith(NOTES);
  for (const stored of [[], ["", "   ", "\t"]]) {
    const state = wholeComputerRootsFor(
      agent({ wholeComputer: true }, { wholeComputerRoots: stored }), disk.onDisk);
    assert.equal(state.state, "none", `stored ${JSON.stringify(stored)} must read as none`);
    assert.deepEqual(state.supply, []);
  }
  assert.equal(disk.asked.length, 0);
});

// ------------------------------------------- a folder that has GONE is said

test("the folder was moved or deleted: reported plainly, and NOT used", () => {
  const scout = agent({ wholeComputer: true }, { wholeComputerRoots: [NOTES] });
  const disk = diskWith(/* nothing on this disk */);

  const state = wholeComputerRootsFor(scout, disk.onDisk);
  assert.equal(state.state, "gone");
  assert.deepEqual(state.chosen, [NOTES], "he is still shown WHICH folder, so he can find it again");
  assert.deepEqual(state.missing, [NOTES]);
  assert.deepEqual(state.supply, [], "a missing folder must never reach a command line");
  assert.deepEqual(addDirRootsFor(scout, disk.onDisk), []);
  assert.deepEqual(addDirs(claudeArgs(scout, [], {
    wholeComputerRoots: addDirRootsFor(scout, disk.onDisk),
  })), []);

  const words = wholeComputerWords(state, "Scout");
  assert.match(words.headline, /That folder is gone/);
  assert.match(words.detail, /none is being used/);

  // and the agent is told it has none, rather than being told it can
  assert.match(
    renderCapabilities(scout, grantedSupply(scout, {
      wholeComputerRoots: addDirRootsFor(scout, disk.onDisk),
    })),
    /must NOT touch anything outside your own folder right now/);
});

test("one there and one gone: the one that is there is used, the other is named", () => {
  const scout = agent({ wholeComputer: true }, { wholeComputerRoots: [NOTES, SHOOT] });
  const disk = diskWith(NOTES);

  const state = wholeComputerRootsFor(scout, disk.onDisk);
  assert.equal(state.state, "partly", "a list that quietly shrinks is the lie this prevents");
  assert.deepEqual(state.missing, [SHOOT]);
  assert.deepEqual(state.supply, [NOTES]);
  assert.deepEqual(addDirs(claudeArgs(scout, [], {
    wholeComputerRoots: addDirRootsFor(scout, disk.onDisk),
  })), [NOTES], "only the folder that is really there reaches the argv");

  const words = wholeComputerWords(state, "Scout");
  assert.match(words.headline, /Some of those folders are gone/);
  assert.doesNotMatch(words.headline, /^In use\./);
});

test("a check that throws is a 'no', never an exception into a turn", () => {
  const scout = agent({ wholeComputer: true }, { wholeComputerRoots: [NOTES] });
  const state = wholeComputerRootsFor(scout, () => { throw new Error("drive not ready"); });
  assert.equal(state.state, "gone");
  assert.deepEqual(state.supply, []);
});

// ----------------------------------------------------- the switch still rules

test("the switch has the last word: stored folders grant nothing while it is off", () => {
  const off = agent({}, { wholeComputerRoots: [NOTES] });
  const disk = diskWith(NOTES);
  const state = wholeComputerRootsFor(off, disk.onDisk);
  assert.equal(state.state, "off");
  assert.deepEqual(state.chosen, [NOTES],
    "the choice is remembered, so switching back on is not re-picking");
  assert.deepEqual(state.supply, []);
  assert.deepEqual(addDirRootsFor(off, disk.onDisk), []);
  assert.equal(disk.asked.length, 0, "an off switch is answered without touching the disk at all");
  assert.match(wholeComputerWords(state, "Scout").headline, /switched off/);
  assert.deepEqual(addDirs(claudeArgs(off, [], { wholeComputerRoots: [NOTES] })), [],
    "and a caller cannot widen an agent by handing it a path");
});

test("a path that is not a whole folder on this computer is refused, not tried", () => {
  const disk = diskWith("notes", "..\\notes", "C:\\a\\b\nrm");
  for (const bad of ["notes", "..\\up\\notes", "C:\\a\\b\nrm"]) {
    const state = wholeComputerRootsFor(
      agent({ wholeComputer: true }, { wholeComputerRoots: [bad] }), disk.onDisk);
    assert.equal(state.state, "gone", `${JSON.stringify(bad)} must never be used`);
    assert.deepEqual(state.supply, []);
    assert.ok(validateWholeComputerRoot(bad), "and the shared rule refuses it at the hub too");
  }
  assert.equal(disk.asked.length, 0, "a path we already refuse is never even looked for");
});

test("the hub's list rule: absent and empty are fine, a long list and a bad entry are not", () => {
  assert.equal(validateWholeComputerRoots(undefined), null);
  assert.equal(validateWholeComputerRoots([]), null);
  assert.equal(validateWholeComputerRoots([NOTES, SHOOT]), null);
  assert.ok(validateWholeComputerRoots("C:\\one"), "a bare string is not a list of folders");
  assert.ok(validateWholeComputerRoots([NOTES, "notes"]), "one bad entry refuses the list");
  assert.ok(validateWholeComputerRoots(
    Array.from({ length: WHOLE_COMPUTER_LIMITS.roots + 1 }, (_, i) => `C:\\f${i}`)),
  "more folders than one agent may hold is refused, not silently trimmed");
});

test("an agent this computer has never heard of supplies nothing", () => {
  // exactly what `engine.agentById()` returns for an unknown id, straight into
  // the one owner — it must be an honest nothing, not a crash mid-turn.
  assert.deepEqual(addDirRootsFor(undefined, () => true), []);
});

test("every state says something different, and only one of them says it works", () => {
  const disk = diskWith(NOTES);
  const said = [
    wholeComputerRootsFor(agent({}, { wholeComputerRoots: [NOTES] }), disk.onDisk),
    wholeComputerRootsFor(agent({ wholeComputer: true }), disk.onDisk),
    wholeComputerRootsFor(agent({ wholeComputer: true }, { wholeComputerRoots: [SHOOT] }), disk.onDisk),
    wholeComputerRootsFor(agent({ wholeComputer: true }, { wholeComputerRoots: [NOTES, SHOOT] }), disk.onDisk),
    wholeComputerRootsFor(agent({ wholeComputer: true }, { wholeComputerRoots: [NOTES] }), disk.onDisk),
  ].map(s => wholeComputerWords(s, "Scout"));
  const headlines = new Set(said.map(w => w.headline));
  assert.equal(headlines.size, 5, "five states, five answers — no state borrows another's words");
  assert.equal(said.filter(w => /^in use/i.test(w.headline)).length, 1,
    "exactly one state may read as working, and it is the one with every folder really there");
});
