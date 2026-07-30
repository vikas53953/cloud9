// WHAT AN AGENT REMEMBERS BETWEEN CONVERSATIONS — the store, the rule, and
// the retrieval. The same durability promises as `runstore.test.ts`, asked
// again here so a memory that costs the owner an answer can never come back.
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

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-mem-"));

function note(over: Partial<MemoryNote> = {}): MemoryNote {
  return {
    id: newMemoryId(1_000_000, () => 0),
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

// --------------------------------------------------------------- the rule

test("a fact worth keeping is kept", () => {
  assert.deepEqual(worthRemembering("the owner prefers plain words"), { keep: true });
});

test("noise is refused, each kind in plain words", () => {
  const cases: [string, string][] = [
    ["", "the note was empty"],
    ["   ", "the note was empty"],
    ["short", "the note was too short to be a fact"],
    ["?", "the note was too short to be a fact"],
    ["what time is it?", "a question is not a memory"],
    ["thanks", "a pleasantry is not a memory"],
    ["ok", "a pleasantry is not a memory"],
    ["Sounds good.", "a pleasantry is not a memory"],
  ];
  for (const [text, reason] of cases) {
    const got = worthRemembering(text);
    assert.equal(got.keep, false, `kept noise: ${JSON.stringify(text)}`);
    assert.equal(got.reason, reason, `wrong reason for ${JSON.stringify(text)}`);
  }
});

test("a note over the cap is refused, not truncated", () => {
  const too = "x".repeat(MEMORY_NOTE_LIMIT + 1);
  const got = worthRemembering(too);
  assert.equal(got.keep, false);
  assert.match(got.reason ?? "", /longer than/);
});

// --------------------------------------------------------------- the store

test("a note is written into the agent's own folder and can be read back later", () => {
  const dir = tmp();
  const store = storeIn(dir);
  const saved = note();
  const at = store.save(saved);

  assert.ok(at, "the note was written");
  assert.equal(path.basename(path.dirname(at!)), "memory");
  assert.ok(at!.includes(path.join("agents", "a1")), "inside the agent's own folder");

  // read back from DISK, not from memory — this is the whole promise
  const fresh = storeIn(dir).read("a1", saved.id);
  assert.equal(fresh?.id, saved.id);
  assert.equal(fresh?.text, "the owner prefers plain words");
  assert.equal(fresh?.source, "owner");
});

test("a list of notes comes back oldest first", () => {
  const dir = tmp();
  const store = storeIn(dir);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const n = note({ id: newMemoryId(1_000_000 + i * 1000, () => i / 10) });
    ids.push(n.id);
    store.save(n);
  }
  const listed = store.list("a1");
  assert.deepEqual(listed.map(l => l.id), ids, "oldest first — the foundation is at the top");
});

test("an agent keeps its most recent notes and no more", () => {
  const dir = tmp();
  const store = storeIn(dir, { keepPerAgent: 5 });
  for (let i = 0; i < 12; i++) {
    store.save(note({ id: newMemoryId(1_000_000 + i * 1000, () => 0.5) }));
  }
  const kept = fs.readdirSync(path.join(dir, "agents", "a1", "memory"));
  assert.equal(kept.length, 5, "the oldest were pruned as new ones landed");
  assert.equal(store.list("a1").length, 5);
});

test("forgetting an agent removes every note it ever had", () => {
  const dir = tmp();
  const store = storeIn(dir);
  store.save(note());
  assert.equal(store.list("a1").length, 1);
  store.forget("a1");
  assert.equal(store.list("a1").length, 0);
});

// ------------------------------------------------------------- safe paths

test("a note id that could point outside the agent's folder is refused, never rewritten", () => {
  const dir = tmp();
  const store = storeIn(dir);
  for (const id of ["../../escape", "..\\..\\escape", "CON", "sub/dir", "sub\\dir", "trailing.", ""]) {
    const bad = note({ id });
    assert.equal(store.save(bad), undefined, `accepted a bad id: ${JSON.stringify(id)}`);
    assert.equal(store.read("a1", id), undefined);
  }
  assert.ok(!fs.existsSync(path.join(dir, "agents", "escape")));
  assert.ok(!fs.existsSync(path.join(dir, "escape")));
});

test("the ids we generate all pass the same rule", () => {
  const dir = tmp();
  const store = storeIn(dir);
  for (let i = 0; i < 50; i++) {
    const n = note({ id: newMemoryId(Date.now() + i * 997, Math.random) });
    assert.ok(store.save(n), `refused an id we generated: ${n.id}`);
  }
});

// ------------------------------------------------------------- fail safe

test("a store that cannot write anything never throws at its caller", () => {
  const store = new MemoryStore({
    agentDataDir: () => { throw new Error("this disk is gone"); },
    log: () => { /* quiet */ },
  });
  assert.doesNotThrow(() => store.save(note()));
  assert.equal(store.save(note()), undefined);
  assert.deepEqual(store.list("a1"), []);
  assert.equal(store.read("a1", "m-abc-0000"), undefined);
  assert.equal(store.prune("a1"), 0);
  assert.doesNotThrow(() => store.forget("a1"));
});

test("a damaged note is refused out loud, not half-read", () => {
  const dir = tmp();
  const said: string[] = [];
  const store = storeIn(dir, { log: (m: string) => said.push(m) });
  const good = note();
  store.save(good);

  const mem = path.join(dir, "agents", "a1", "memory");
  const bad = "m-000000000000-bad";
  fs.writeFileSync(path.join(mem, `${bad}.json`), '{"id":"m-000000000000-bad","text', "utf8");

  assert.equal(store.read("a1", bad), undefined, "a damaged file was handed back as if it were a note");
  assert.ok(said.some(m => m.includes(bad)), "the refusal must name the note");
  assert.ok(said.some(m => /stops part-way|not a whole memory note/.test(m)),
    `the refusal must say what is wrong — got ${JSON.stringify(said)}`);

  // and the good one beside it is untouched and still readable
  assert.deepEqual(store.list("a1").map(n => n.id), [good.id]);
  assert.equal(store.read("a1", good.id)?.id, good.id);
});

test("a nonsense note with every key present is refused, by validateNote", () => {
  const poisoned: [string, Partial<Record<string, unknown>>, string][] = [
    ["aa", { kind: "whenever" }, "a fact, a preference, a decision"],
    ["bb", { agentId: {} }, "belongs to an agent"],
    ["cc", { createdAt: "soup" }, "time isn't a number"],
    ["dd", { source: "anybody" }, "says who wrote it"],
    ["ee", { text: "" }, "needs text"],
  ];
  for (const [tag, breakage, words] of poisoned) {
    const obj = { ...note(), id: `m-00000000000${tag.slice(0, 1)}-aaaa`, ...breakage } as Record<string, unknown>;
    assert.match(validateNote(obj) ?? "", new RegExp(words),
      `${tag}: a nonsense note was accepted by validateNote`);
  }
});

test("how many notes are kept on disk is ONE number, derived from the constant", async () => {
  assert.equal(MEMORY_STORE_DEFAULTS.keepPerAgent, MEMORY_STORE_KEEP,
    "the store default and the store cap must be the same fact, not two copies");
});

// ------------------------------------------------------------- retrieval

test("retrieveMemory keeps the oldest within budget and drops the newest", () => {
  const dir = tmp();
  const store = storeIn(dir);
  // 10 notes, each 100 chars — total 1,000 chars, well under the 8,000 cap
  for (let i = 0; i < 10; i++) {
    store.save(note({
      id: newMemoryId(1_000_000 + i * 1000, () => 0.1),
      text: `note number ${i} `.padEnd(100, "."),
    }));
  }
  const rendered = retrieveMemory(store.list("a1"), { characters: 300, notes: 200 });
  // each rendered line is ~120 chars; 300 chars fits 2 lines, the rest dropped
  const lines = rendered.split("\n");
  assert.ok(lines.length >= 1 && lines.length <= 3, `expected 1-3 lines, got ${lines.length}`);
  assert.ok(lines[0].includes("note number 0"), "the oldest note is the first line — the foundation survives");
  assert.ok(!rendered.includes("note number 9"), "the newest note is dropped first");
  assert.ok(!rendered.includes("note number 8"), "and the second-newest is dropped too");
});

test("retrieveMemory of an empty memory is empty", () => {
  assert.equal(retrieveMemory([]), "");
});

test("retrieveMemory names the kind and the source so an agent can tell its own notes from its owner's", () => {
  const notes = [
    note({ kind: "preference", text: "no emoji", source: "owner" }),
    note({ kind: "decision", text: "use the worktree", source: "agent" }),
  ];
  const rendered = retrieveMemory(notes);
  assert.match(rendered, /\(preference, from owner\) no emoji/);
  assert.match(rendered, /\(decision, from self\) use the worktree/);
});

test("a single note longer than the whole budget is still included, truncated and saying so", () => {
  const big = note({ text: "x".repeat(MEMORY_BUDGET.characters + 100) });
  const rendered = retrieveMemory([big], { characters: 50, notes: 200 });
  assert.ok(rendered.includes("too long to show in full"), "a too-long note must say it was truncated");
  assert.ok(rendered.length <= 50 + 60, "and not exceed the budget by more than the truncation marker");
});
