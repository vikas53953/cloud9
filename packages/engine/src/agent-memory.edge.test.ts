// WHAT AN AGENT REMEMBERS — THE EDGES. The companion suite to
// `agent-memory.test.ts`: where that suite shows the rule working, this one
// stands exactly on the rule's boundary — the note that fits the character
// budget to the character, the keep cap that falls back instead of zeroing,
// the id at the ends of its own range. Nothing in `agent-memory.ts` was
// edited to make these pass; each BREAK line names the rule that was broken
// on purpose to watch the test fail.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MEMORY_BUDGET, MEMORY_NOTE_LIMIT, MEMORY_STORE_KEEP, MEMORY_STORE_DEFAULTS,
  MemoryStore, MemoryNote, newMemoryId, retrieveMemory, validateNote,
  worthRemembering,
} from "./agent-memory.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-mem-edge-"));

function note(over: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: "m-000000001-0000",
    agentId: "a1", kind: "fact", text: "the owner prefers plain words",
    createdAt: 1_000_000, source: "owner", ...over,
  };
}

function storeIn(dir: string, over: Partial<ConstructorParameters<typeof MemoryStore>[0]> = {}) {
  return new MemoryStore({
    agentDataDir: (agentId: string) => {
      const target = path.join(dir, "agents", agentId);
      fs.mkdirSync(target, { recursive: true });
      return target;
    },
    log: () => { /* quiet in tests */ },
    ...over,
  });
}

/** The exact line one note renders to, measured through the one renderer. */
const lineOf = (n: MemoryNote): string =>
  retrieveMemory([n], { characters: 1_000_000, notes: 1 });

// --------------------------------------------------------------- the constants

test("the budget numbers are THE numbers — a drive-by change is loud here", () => {
  assert.deepEqual(MEMORY_BUDGET, { characters: 8_000, notes: 200 });
  assert.equal(MEMORY_NOTE_LIMIT, 500);
  assert.equal(MEMORY_STORE_KEEP, 1_000);
  assert.equal(MEMORY_STORE_DEFAULTS.keepPerAgent, MEMORY_STORE_KEEP);
});

// --------------------------------------------------------------- the rule, at its edges

test("a note at the EXACT length edges of the rule is kept; one past is refused", () => {
  // 7 is too short, 8 is a fact — the boundary is BETWEEN them
  assert.equal(worthRemembering("x".repeat(7)).keep, false);
  assert.deepEqual(worthRemembering("x".repeat(8)), { keep: true });
  // the cap itself still fits; the cap plus one does not
  assert.deepEqual(worthRemembering("x".repeat(MEMORY_NOTE_LIMIT)), { keep: true });
  const over = worthRemembering("x".repeat(MEMORY_NOTE_LIMIT + 1));
  assert.equal(over.keep, false);
  assert.equal(over.reason, `the note was longer than ${MEMORY_NOTE_LIMIT} characters`);
  // BREAK: change `>` to `>=` on the note limit and the 500-character note is refused.
});

test("a pleasantry is refused however it is cased or punctuated — a near-pleasantry is kept", () => {
  for (const text of ["Thanks!", "THANK YOU", "Got it!!", "okay...", "Yes", "NOPE"]) {
    const got = worthRemembering(text);
    assert.equal(got.keep, false, `kept a pleasantry: ${JSON.stringify(text)}`);
    assert.equal(got.reason, "a pleasantry is not a memory");
  }
  // a trailing comma is NOT stripped — "ok," falls through to the length rule,
  // and the reason a person reads is the length one
  assert.deepEqual(worthRemembering("ok,"),
    { keep: false, reason: "the note was too short to be a fact" });
  // a sentence that merely STARTS with a pleasantry is a memory
  assert.deepEqual(worthRemembering("thanks a lot for the careful review"), { keep: true });
  assert.deepEqual(worthRemembering("yes — the migration ran clean overnight"), { keep: true });
});

test("only a note that IS one question is refused as a question", () => {
  assert.deepEqual(worthRemembering("what time is it?"),
    { keep: false, reason: "a question is not a memory" });
  // two questions in a row is still nothing but questions
  assert.equal(worthRemembering("Really? Truly?").keep, false);
  // a question with an answer inside it is a memory: the "." or ":" before the
  // final "?" is what saves it
  assert.deepEqual(worthRemembering("I asked: what time is it?"), { keep: true });
  assert.deepEqual(worthRemembering("It broke. Why did it break?"), { keep: true });
  // ending in "!" is not ending in "?"
  assert.deepEqual(worthRemembering("what time is it?!"), { keep: true });
});

// --------------------------------------------------------------- the id, at its ends

test("newMemoryId at the ends of its range is still safe, padded and sortable", () => {
  assert.equal(newMemoryId(0, () => 0), "m-000000000-0000",
    "time zero and noise zero pad out to full width");
  assert.equal(newMemoryId(0, () => 0.999999999), "m-000000000-zzzz",
    "the largest noise the random source can ask for still fits its four characters");
  const shape = /^m-[0-9a-z]{9}-[0-9a-z]{4}$/;
  const ids = [0, 1, 1_000, 1_000_000_000, Date.now()].map(t => newMemoryId(t, () => 0.5));
  for (const id of ids) assert.match(id, shape);
  const sorted = [...ids].sort();
  assert.deepEqual(ids, sorted, "lexicographic order IS time order — the store's sort depends on it");
});

// --------------------------------------------------------------- retrieval, exactly at budget

// GAP B (2026-08-05): the budget is now spent from the NEWEST end backwards, so
// every "which one goes?" test below asks about the OLDEST end. What survives is
// still rendered oldest-first — that half did not change and is pinned too.

test("the character budget keeps the note that fits EXACTLY, and drops the one before it", () => {
  const n0 = note({ id: "m-000000001-0000", text: "this one never fits" });
  const n1 = note({ id: "m-000000002-0000", text: "the owner prefers plain words" });
  const n2 = note({
    id: "m-000000003-0000", kind: "decision", source: "agent",
    text: "the deploy key lives in the vault",
  });
  const line1 = lineOf(n1);
  const line2 = lineOf(n2);
  // the budget that covers the two NEWEST lines and the newline between them
  const exact = line1.length + line2.length + 2;
  const rendered = retrieveMemory([n0, n1, n2], { characters: exact, notes: 200 });
  assert.equal(rendered, `${line1}\n${line2}`,
    "both newest notes kept — the second fit with zero characters to spare, and they read in order");
  // BREAK: change `spent + line.length + 1 > budget` to `>=` and the exact fit is
  // dropped — memory silently one note poorer. Watched.
});

test("one character short of the budget drops the OLDER note entirely", () => {
  const n0 = note({ id: "m-000000001-0000" });
  const n1 = note({ id: "m-000000002-0000", text: "the deploy key lives in the vault" });
  const line0 = lineOf(n0);
  const line1 = lineOf(n1);
  const oneShort = line0.length + line1.length + 1;
  const rendered = retrieveMemory([n0, n1], { characters: oneShort, notes: 200 });
  assert.equal(rendered, line1, "the older note needed one more character than there was");
});

test("the note-count budget keeps exactly the N newest and drops the one before them", () => {
  const notes = [1, 2, 3, 4].map(i =>
    note({ id: `m-00000000${i}-0000`, text: `note number ${i}` }));
  const three = retrieveMemory(notes, { characters: 1_000_000, notes: 3 }).split("\n");
  assert.equal(three.length, 3);
  assert.ok(three[0].includes("note number 2"), "the kept notes still read oldest-first");
  assert.ok(three[2].includes("note number 4"));
  assert.ok(!three.some(l => l.includes("note number 1")), "the oldest is the first to go");
  const one = retrieveMemory(notes, { characters: 1_000_000, notes: 1 });
  assert.ok(one.includes("note number 4"));
  assert.ok(!one.includes("note number 3"), "a budget of one note is the one newest note");
});

test("the newest note alone may exceed the budget — truncated, saying so, to the character", () => {
  const n0 = note({ id: "m-000000001-0000", text: "w".repeat(600) });
  const line = lineOf(n0);
  const marker = " …(this note was too long to show in full)";
  // exactly AT the budget: kept whole, no marker
  const at = retrieveMemory([n0], { characters: line.length, notes: 200 });
  assert.equal(at, line);
  // ONE over: exactly `characters` of the line, then the marker — nothing else
  const over = retrieveMemory([n0], { characters: line.length - 1, notes: 200 });
  assert.equal(over, line.slice(0, line.length - 1) + marker);
  assert.equal(over.length, line.length - 1 + marker.length,
    "the overshoot is exactly the marker's length, never more");
});

test("only the NEWEST note is ever truncated — an overlong older note is dropped, not cut", () => {
  const huge = note({ id: "m-000000001-0000", text: "y".repeat(600) });
  const n1 = note({ id: "m-000000002-0000" });
  const line1 = lineOf(n1);
  const rendered = retrieveMemory([huge, n1], { characters: line1.length + 10, notes: 200 });
  assert.equal(rendered, line1,
    "the spent>0 check fires before the truncation branch — truncation is the newest note's privilege");
  assert.ok(!rendered.includes("too long"), "and no marker for a note that was dropped whole");
});

test("retrieveMemory trusts the caller's order — it does not sort", () => {
  // `notes` are ASSUMED oldest-first (the order `list` returns). Hand the
  // function the opposite and it renders what it was given — the promise
  // lives with the caller, and this pins where.
  const older = note({ id: "m-000000001-0000", text: "the oldest thing" });
  const newer = note({ id: "m-000000009-0000", text: "the newest thing" });
  const rendered = retrieveMemory([newer, older]);
  assert.ok(rendered.indexOf("newest") < rendered.indexOf("oldest"),
    "given order out, whatever it was — sorting here would hide a caller bug");
});

// --------------------------------------------------------------- the store, at its caps

test("when the keep cap bites, the OLDEST notes survive on disk — the foundation stays", () => {
  const dir = tmp();
  const store = storeIn(dir, { keepPerAgent: 2 });
  const ids = ["m-000000001-0000", "m-000000002-0000", "m-000000003-0000"];
  for (const id of ids) store.save(note({ id, text: `note ${id}` }));
  const kept = store.list("a1").map(n => n.id);
  assert.deepEqual(kept, ids.slice(0, 2),
    "the two oldest are kept; the NEWEST is pruned — same foundation-first rule as retrieval");
  const mem = path.join(dir, "agents", "a1", "memory");
  assert.ok(!fs.existsSync(path.join(mem, `${ids[2]}.json`)), "the newest file is gone from disk");
  // NOTE: the module header and the older suite's title ("keeps its most recent
  // notes") read the other way; the CODE keeps the oldest. This pins the code.
});

test("a keep of zero, NaN or a fraction can never mean zero", () => {
  for (const keepPerAgent of [0, Number.NaN]) {
    const dir = tmp();
    const store = storeIn(dir, { keepPerAgent });
    for (let i = 1; i <= 3; i++) store.save(note({ id: `m-00000000${i}-0000` }));
    assert.equal(store.list("a1").length, 3,
      `keepPerAgent ${String(keepPerAgent)} fell back to the store default, not to zero`);
  }
  const dir = tmp();
  const store = storeIn(dir, { keepPerAgent: 2.9 });
  for (let i = 1; i <= 4; i++) store.save(note({ id: `m-00000000${i}-0000` }));
  assert.equal(store.list("a1").length, 2, "a fractional keep is floored, not rounded");
});

test("list's own limit has the same floor: one means one, zero means the keep", () => {
  const dir = tmp();
  const store = storeIn(dir);
  const ids = ["m-000000001-0000", "m-000000002-0000", "m-000000003-0000"];
  for (const id of ids) store.save(note({ id }));
  assert.deepEqual(store.list("a1", 1).map(n => n.id), ids.slice(0, 1), "the limit takes the OLDEST");
  assert.deepEqual(store.list("a1", 2).map(n => n.id), ids.slice(0, 2));
  assert.equal(store.list("a1", 0).length, 3,
    "a limit of zero falls back to the keep — it can never mean 'read nothing'");
  assert.equal(store.list("a1", Number.NaN).length, 3);
});

test("an interrupted write's litter is swept by prune and never listed", () => {
  const dir = tmp();
  const store = storeIn(dir);
  store.save(note());
  const mem = path.join(dir, "agents", "a1", "memory");
  const litter = "m-000000002-0000.json.tmp-123-456-7";
  fs.writeFileSync(path.join(mem, litter), '{"id":"m-000000002-0000","text', "utf8");
  assert.equal(store.list("a1").length, 1, "litter is not a note");
  const swept = store.prune("a1");
  assert.ok(swept >= 1, "prune counted the litter it removed");
  assert.ok(!fs.existsSync(path.join(mem, litter)), "and the litter is gone");
  assert.equal(store.list("a1").length, 1, "the whole note beside it is untouched");
});

test("an empty file is junk holding a slot — listed out loud, then gone", () => {
  const dir = tmp();
  const said: string[] = [];
  const store = storeIn(dir, { log: (m: string) => said.push(m) });
  store.save(note());
  const mem = path.join(dir, "agents", "a1", "memory");
  const empty = "m-000000000-0000";
  fs.writeFileSync(path.join(mem, `${empty}.json`), "", "utf8");
  assert.equal(store.read("a1", empty), undefined);
  assert.deepEqual(store.list("a1").map(n => n.id), ["m-000000001-0000"],
    "the empty file held a slot and lost it");
  assert.ok(said.some(m => m.includes(empty) && /empty/.test(m)),
    `the refusal names the file and says it is empty — got ${JSON.stringify(said)}`);
  assert.ok(!fs.existsSync(path.join(mem, `${empty}.json`)), "junk is removed, not left to rot");
});

test("a .json file whose NAME breaks the id rule is skipped by everything, silently", () => {
  const dir = tmp();
  const store = storeIn(dir);
  store.save(note());
  const mem = path.join(dir, "agents", "a1", "memory");
  // "trailing." + ".json": the id inside fails isSafeStoredId, so fileFor refuses
  // it for read AND for prune — the sweeper can only touch names that pass the
  // same rule, so this file is left for a human. Pinned so that stays visible.
  fs.writeFileSync(path.join(mem, "trailing..json"), "{}", "utf8");
  assert.equal(store.list("a1").length, 1, "never listed");
  assert.equal(store.read("a1", "trailing."), undefined, "never read");
  assert.equal(store.prune("a1"), 0, "never swept");
  assert.ok(fs.existsSync(path.join(mem, "trailing..json")), "and still on disk");
  // a file that is not .json at all is beneath notice
  fs.writeFileSync(path.join(mem, "readme.txt"), "hello", "utf8");
  assert.equal(store.list("a1").length, 1);
});

test("saving the same id twice overwrites — one slot, the newest bytes", () => {
  const dir = tmp();
  const store = storeIn(dir);
  const id = "m-000000001-0000";
  store.save(note({ id, text: "the first wording" }));
  store.save(note({ id, text: "the corrected wording", kind: "correction" }));
  const listed = store.list("a1");
  assert.equal(listed.length, 1, "an id is one slot, not two");
  assert.equal(listed[0].text, "the corrected wording");
  assert.equal(listed[0].kind, "correction");
});

test("the store trusts agentDataDir for the AGENT id — the trust boundary, pinned", () => {
  // Nothing in MemoryStore re-checks the agent id: `dirFor` only asks that the
  // memory folder sits directly under whatever agentDataDir returned. An agent
  // id of "../x" therefore writes OUTSIDE the agents folder. The engine owns
  // the agent-id rule ("the engine already owns this decision") — this pins
  // where the fence is, so hardening it later changes this test on purpose.
  const dir = tmp();
  const store = storeIn(dir);
  const at = store.save(note({ agentId: "../x" }));
  assert.ok(at, "the save was allowed");
  assert.ok(!at!.startsWith(path.join(dir, "agents") + path.sep),
    "and it landed outside the agents folder — the fence is agentDataDir, not the store");
  assert.equal(store.list("../x").length, 1);
});

// --------------------------------------------------------------- validateNote, at its edges

test("validateNote at the exact edges of every field", () => {
  const ok = note();
  assert.equal(validateNote(ok), null);
  // ids: 64 characters is the most the safe-id rule allows
  assert.equal(validateNote({ ...ok, id: "a".repeat(64) }), null);
  assert.match(validateNote({ ...ok, id: "a".repeat(65) })!, /safe id/);
  // time: finite is the whole rule — zero and negative are times too
  assert.equal(validateNote({ ...ok, createdAt: 0 }), null);
  assert.equal(validateNote({ ...ok, createdAt: -5_000 }), null);
  for (const t of [Number.NaN, Infinity, -Infinity]) {
    assert.match(validateNote({ ...ok, createdAt: t })!, /time isn't a number/);
  }
  // run link: absent is fine, empty is not
  assert.equal(validateNote({ ...ok, runId: "r-000000001-aaaa" }), null);
  assert.match(validateNote({ ...ok, runId: "" })!, /run link must be a safe id/);
  assert.match(validateNote({ ...ok, runId: 42 })!, /run link must be a safe id/);
  // kind and source are closed lists, case included
  assert.match(validateNote({ ...ok, kind: "Fact" })!, /a fact, a preference, a decision/);
  assert.match(validateNote({ ...ok, source: "OWNER" })!, /says who wrote it/);
  // and a note carrying fields nobody taught the validator about is still a note
  assert.equal(validateNote({ ...ok, future: "field", weight: 3 }), null,
    "extra keys pass — the wire shape can grow without the validator refusing it");
});
