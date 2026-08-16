// THE TWO LISTS CAN NEVER DRIFT APART IN SILENCE.
//
// The engine decides what a typed command IS: the regular expressions in
// `packages/engine/src/engine.ts` are the only thing that ever reads a "!word"
// out of a message. The app's actions menu (`ROOM_COMMANDS` in
// `apps/desktop/src/App.tsx`) is what puts those commands on the screen.
//
// Those are two lists of the same thing, in two files, in two packages — the
// exact shape that goes stale. It cannot be collapsed into one today: the
// engine's parser is regular expressions inside its own control flow, and the
// engine is a Node package (`node:fs`, `node:child_process`) the browser bundle
// must never import. So the drift is caught HERE instead of hoped against.
//
// A command added to the engine and not to the menu is invisible — which is the
// whole bug the menu exists to fix. A row in the menu with no command behind it
// writes a line into his box that the engine will treat as ordinary chat. Both
// are failures, and both fail this test.
//
// Run it:  node --test apps/desktop/electron/roomcommands.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..", "..", "..");
const ENGINE = path.join(REPO, "packages", "engine", "src", "engine.ts");
const SHARED_COMMANDS = path.join(REPO, "packages", "shared", "src", "composer-commands.ts");
const APP = path.join(REPO, "apps", "desktop", "src", "App.tsx");

/**
 * Every command the ENGINE really parses, read out of its regular expressions
 * rather than out of a comment — a comment can be right while the code is not.
 *
 * Two shapes exist in that file and only two:
 *   "/^!word…"        — anchored at the start of the bare message
 *                       (`!issue`, `!code`, `!(bg|task)`, `!schedules`, …)
 *   "…\s+!word…"      — read out of the RAW text, where the command follows a
 *                       mention (`@From !handoff @To …`)
 * Anything else in that file that starts with "!" is JavaScript's "not", and is
 * deliberately not matched.
 */
function commandsTheEngineParses() {
  const src = fs.readFileSync(ENGINE, "utf8");
  const found = new Set();
  for (const m of src.matchAll(/\^!\(?([a-z|]+)\)?/g)) {
    for (const word of m[1].split("|")) found.add(`!${word}`);
  }
  for (const m of src.matchAll(/\\s\+!([a-z]+)/g)) found.add(`!${m[1]}`);
  // Cloud9-owned slash commands live in shared and are imported by the engine.
  const shared = fs.readFileSync(SHARED_COMMANDS, "utf8");
  for (const name of ["summarize", "plan", "review", "ship", "assign"]) {
    if (shared.includes(`\"${name}\"`)) found.add(`/${name}`);
  }
  return found;
}

/** Every command the MENU offers, including the alternative spellings. */
function commandsTheMenuOffers() {
  const src = fs.readFileSync(APP, "utf8");
  const from = src.indexOf("const ROOM_COMMANDS: RoomCommand[] = [");
  assert.notEqual(from, -1, "ROOM_COMMANDS has been renamed or removed from App.tsx");
  const to = src.indexOf("\n];", from);
  assert.notEqual(to, -1, "could not find the end of the ROOM_COMMANDS table");
  const table = src.slice(from, to);
  const found = new Set();
  for (const m of table.matchAll(/\bcmd:\s*"([!/][a-z]+)"/g)) found.add(m[1]);
  for (const m of table.matchAll(/\baliases:\s*\[([^\]]*)\]/g)) {
    for (const q of m[1].matchAll(/"([!/][a-z]+)"/g)) found.add(q[1]);
  }
  return found;
}

test("the engine's own regular expressions really do yield a list of commands", () => {
  const engine = commandsTheEngineParses();
  // A guard on the READER, not on the feature: if engine.ts is rewritten in a
  // way this extraction cannot follow, it must fail loudly here rather than
  // quietly agree with an empty set and pass for ever after.
  assert.ok(engine.size >= 8,
    `only found ${engine.size} commands in engine.ts — the extraction has stopped working`);
  for (const expected of ["!issue", "!comment", "!review", "!code", "!remember", "!handoff"]) {
    assert.ok(engine.has(expected), `expected the engine to parse ${expected}`);
  }
});

test("every command the engine parses has a row in the actions menu", () => {
  const engine = [...commandsTheEngineParses()].sort();
  const menu = commandsTheMenuOffers();
  const missing = engine.filter(c => !menu.has(c));
  assert.deepEqual(missing, [],
    `the engine parses ${missing.join(", ")}, and nothing on screen offers it — ` +
    "add a row to ROOM_COMMANDS in apps/desktop/src/App.tsx");
});

test("every row in the actions menu is a command the engine really parses", () => {
  const engine = commandsTheEngineParses();
  const menu = [...commandsTheMenuOffers()].sort();
  const invented = menu.filter(c => !engine.has(c));
  assert.deepEqual(invented, [],
    `the menu offers ${invented.join(", ")}, which the engine does not parse — ` +
    "that row would write a line into his box that is treated as ordinary chat");
});

test("no command is offered twice, and every row explains itself", () => {
  const src = fs.readFileSync(APP, "utf8");
  const from = src.indexOf("const ROOM_COMMANDS: RoomCommand[] = [");
  const table = src.slice(from, src.indexOf("\n];", from));
  const cmds = [...table.matchAll(/\bcmd:\s*"([!/][a-z]+)"/g)].map(m => m[1]);
  assert.equal(new Set(cmds).size, cmds.length, "the same command is listed twice");
  const labels = [...table.matchAll(/\blabel:\s*"/g)].length;
  const says = [...table.matchAll(/\bsay:\s*"/g)].length;
  assert.equal(labels, cmds.length, "a row is missing its plain-words label");
  assert.equal(says, cmds.length, "a row is missing the one line saying what will happen");
});
