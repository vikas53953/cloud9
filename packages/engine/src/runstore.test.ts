// Where run records live, and the promise that keeping them can never cost the
// owner an answer.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef, Message } from "@cloud9/shared";
import { Engine } from "./engine.js";
import { ClaudeProvider, RespondInput } from "./provider.js";
import { buildRunRecord, RunRecord, RunSeed, newRunId } from "./runrecord.js";
import { RunStore } from "./runstore.js";
import { traceCodex } from "./codex.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-runs-"));

/** Real Codex output, captured on this machine 2026-07-29 (see runrecord.test.ts). */
const CODEX_STREAM = [
  `{"type":"thread.started","thread_id":"019fac7b-8e8b-7332-9a2a-a2102ebc9d4b"}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"reading it now"}}`,
  `{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"Get-Content note.txt","exit_code":0,"status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"hello from cloud9 probe confirmed"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":50710,"cached_input_tokens":24320,"output_tokens":249,"reasoning_output_tokens":125}}`,
].join("\n");

const seed = (over: Partial<RunSeed> = {}): RunSeed => ({
  kind: "task", agentId: "a1", agentName: "Scout", provider: "codex",
  requestedBy: "Vikas", requestedByKind: "human", ask: "read the note",
  startedAt: 1_000_000, ...over,
});

function record(over: Partial<RunSeed> = {}, at = 1_041_000): RunRecord {
  return buildRunRecord(seed(over), {
    finishedAt: at, outcome: "ok", trace: traceCodex(CODEX_STREAM), reply: "done",
  });
}

function storeIn(dir: string, over: Partial<ConstructorParameters<typeof RunStore>[0]> = {}) {
  return new RunStore({
    agentDataDir: (agentId: string) => {
      const target = path.join(dir, "agents", agentId);
      fs.mkdirSync(target, { recursive: true });
      return target;
    },
    log: () => { /* quiet in tests */ },
    ...over,
  });
}

// ------------------------------------------------------------------ storage

test("a run is written into the agent's own folder and can be read back later", () => {
  const dir = tmp();
  const store = storeIn(dir);
  const saved = record();
  const at = store.save(saved);

  assert.ok(at, "the record was written");
  assert.equal(path.basename(path.dirname(at!)), "runs");
  assert.ok(at!.includes(path.join("agents", "a1")), "inside the agent's own folder");

  // read back from DISK, not from memory — this is the whole promise
  const fresh = storeIn(dir).read("a1", saved.id);
  assert.equal(fresh?.id, saved.id);
  assert.equal(fresh?.steps.length, 3);
  assert.equal(fresh?.steps.find(s => s.kind === "command")?.ok, true);
  assert.equal(fresh?.usage?.inputTokens, 50710);
});

test("a list of runs comes back newest first, each with its plain-words line", () => {
  const dir = tmp();
  const store = storeIn(dir);
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r = { ...record(), id: newRunId(1_700_000_000_000 + i * 1000, () => i / 10) };
    ids.push(r.id);
    store.save(r);
  }
  const listed = store.list("a1");
  assert.deepEqual(listed.map(l => l.id), [...ids].reverse());
  assert.equal(listed[0].summary, "Ran 1 command, took 41 seconds.");
  assert.equal(listed[0].ask, "read the note");
});

test("an agent keeps its most recent runs and no more", () => {
  const dir = tmp();
  const store = storeIn(dir, { keepPerAgent: 5 });
  for (let i = 0; i < 12; i++) {
    store.save({ ...record(), id: newRunId(1_700_000_000_000 + i * 1000, () => 0.5) });
  }
  const kept = fs.readdirSync(path.join(dir, "agents", "a1", "runs"));
  assert.equal(kept.length, 5, "the oldest were pruned as new ones landed");
  assert.equal(store.list("a1").length, 5);
});

test("a record too big for the cap is trimmed and says so", () => {
  const dir = tmp();
  const store = storeIn(dir, { maxBytes: 1_200 });
  const many = Array.from({ length: 60 },
    (_v, i) => `{"type":"item.completed","item":{"id":"i${i}","type":"command_execution","command":"a command number ${i}","exit_code":0,"status":"completed"}}`);
  const big = buildRunRecord(seed(), {
    finishedAt: 1_041_000, outcome: "ok", trace: traceCodex(many.join("\n")), reply: "x",
  });
  assert.ok(big.steps.length > 30);

  const at = store.save(big);
  assert.ok(at);
  const onDisk = fs.readFileSync(at!, "utf8");
  assert.ok(onDisk.length <= 1_200, `record is ${onDisk.length} bytes`);
  const read = store.read("a1", big.id);
  assert.equal(read?.truncated, true, "a trimmed run must never read as a short one");
  assert.ok((read?.steps.length ?? 0) < big.steps.length);
});

test("forgetting an agent removes every run it ever had", () => {
  const dir = tmp();
  const store = storeIn(dir);
  store.save(record());
  assert.equal(store.list("a1").length, 1);
  store.forget("a1");
  assert.equal(store.list("a1").length, 0);
});

// ------------------------------------------------------------- safe paths

test("a run id that could point outside the agent's folder is refused, never rewritten", () => {
  const dir = tmp();
  const store = storeIn(dir);
  for (const id of ["../../escape", "..\\..\\escape", "CON", "sub/dir", "sub\\dir", "trailing.", ""]) {
    const bad = { ...record(), id };
    assert.equal(store.save(bad), undefined, `accepted a bad id: ${JSON.stringify(id)}`);
    assert.equal(store.read("a1", id), undefined);
  }
  // nothing at all was created outside the runs folder
  assert.ok(!fs.existsSync(path.join(dir, "agents", "escape")));
  assert.ok(!fs.existsSync(path.join(dir, "escape")));
});

test("the ids we generate all pass the same rule", () => {
  const dir = tmp();
  const store = storeIn(dir);
  for (let i = 0; i < 50; i++) {
    const r = { ...record(), id: newRunId(Date.now() + i * 997, Math.random) };
    assert.ok(store.save(r), `refused an id we generated: ${r.id}`);
  }
});

// -------------------------------------------------------------- fail safe

test("a store that cannot write anything never throws at its caller", () => {
  const store = new RunStore({
    agentDataDir: () => { throw new Error("this disk is gone"); },
    log: () => { /* quiet */ },
  });
  assert.doesNotThrow(() => store.save(record()));
  assert.equal(store.save(record()), undefined);
  assert.deepEqual(store.list("a1"), []);
  assert.equal(store.read("a1", "r-abc-0000"), undefined);
  assert.equal(store.prune("a1"), 0);
  assert.doesNotThrow(() => store.forget("a1"));
});

// ------------------------------------------------- the engine writes them

class StubProvider implements ClaudeProvider {
  constructor(private stream?: string, private fail?: string) {}
  async respond(input: RespondInput): Promise<string> {
    if (this.stream) input.onTrace?.(traceCodex(this.stream));
    if (this.fail) throw new Error(this.fail);
    return "hello from cloud9 probe confirmed";
  }
}

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
  provider: "codex", createdAt: 0, ...over,
});

const trigger: Message = {
  id: "m1", channelId: "c1", authorId: "u1", authorName: "Vikas",
  authorKind: "human", text: "read the note please", ts: 0,
};

function makeEngine(provider: ClaudeProvider) {
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(), codexProvider: provider,
  });
  const sent: string[] = [];
  engine.agentSend = (_agentId, _channelId, text) => { sent.push(text); };
  return { engine, sent };
}

test("an ordinary chat turn leaves a record of what the agent did", async () => {
  const { engine, sent } = makeEngine(new StubProvider(CODEX_STREAM));
  await engine.takeTurn(agent(), "c1", trigger);

  assert.deepEqual(sent, ["hello from cloud9 probe confirmed"]);
  const run = engine.lastRun;
  assert.ok(run, "a record was written");
  assert.equal(run!.kind, "chat");
  assert.equal(run!.agentName, "Scout");
  assert.equal(run!.provider, "codex");
  assert.equal(run!.requestedBy, "Vikas");
  assert.equal(run!.requestedByKind, "human");
  assert.equal(run!.ask, "read the note please");
  assert.equal(run!.outcome, "ok");
  assert.equal(run!.steps.filter(s => s.kind === "command").length, 1);
  assert.equal(run!.channelId, "c1");
  // and it is on disk, not only in memory
  assert.equal(engine.runs.read("a1", run!.id)?.id, run!.id);
});

test("a turn that failed leaves a record saying so, in plain words", async () => {
  const { engine } = makeEngine(new StubProvider(undefined, "Codex exited with 1: C:\\Users\\vikasmit\\x"));
  await engine.takeTurn(agent(), "c1", trigger);

  const run = engine.lastRun;
  assert.equal(run?.outcome, "failed");
  assert.ok(run?.error, "the record says why");
  assert.ok(!run!.error!.includes("vikasmit"), "and says it without naming the person or the path");
});

test("a harness that isn't connected still leaves a record — 'it did nothing, here's why'", async () => {
  const engine = new Engine({ relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp() });
  engine.agentSend = () => { /* ignore */ };
  await engine.takeTurn(agent(), "c1", trigger);
  assert.equal(engine.lastRun?.outcome, "failed");
  assert.match(engine.lastRun?.error ?? "", /not connected/);
});

test("a broken recorder costs a log line, never the owner's answer", async () => {
  const { engine, sent } = makeEngine(new StubProvider(CODEX_STREAM));
  // every way the paperwork can fall over, at once
  engine.runs.save = () => { throw new Error("the disk is on fire"); };
  engine.onRunRecorded = () => { throw new Error("and so is the listener"); };

  await engine.takeTurn(agent(), "c1", trigger);
  assert.deepEqual(sent, ["hello from cloud9 probe confirmed"], "the answer still landed");
});

test("a provider whose tracing throws still answers", async () => {
  class Rude implements ClaudeProvider {
    async respond(input: RespondInput): Promise<string> {
      try { input.onTrace?.(null as never); } catch { /* the provider's own guard */ }
      return "answered anyway";
    }
  }
  const { engine, sent } = makeEngine(new Rude());
  await engine.takeTurn(agent(), "c1", trigger);
  assert.deepEqual(sent, ["answered anyway"]);
});

test("a scheduled check-in and a delegated job are recorded as what they are", async () => {
  const { engine } = makeEngine(new StubProvider(CODEX_STREAM));
  await engine.respondAs(agent(), {
    context: "", trigger: "Scheduled task fired: check the log", triggerAuthor: "schedule",
    kind: "schedule", channelId: "c1", requesterKind: "schedule",
  });
  assert.equal(engine.lastRun?.kind, "schedule");
  assert.equal(engine.lastRun?.requestedByKind, "schedule");

  await engine.respondAs(agent(), {
    context: "", trigger: "Background task: tidy the notes", triggerAuthor: "Vikas",
    kind: "task", channelId: "c1", taskId: "t7",
  });
  assert.equal(engine.lastRun?.kind, "task");
  assert.equal(engine.lastRun?.taskId, "t7");
});

// ------------------------------------------------ torn writes and retention
//
// Findings from the 2026-07-29 review, fixed as a CLASS:
//  - a record was written with a plain `writeFileSync`, so a turn interrupted
//    mid-write left half a file that still occupied a retention slot for ever;
//  - `RUN_STORE_DEFAULTS.keepPerAgent` and `RUN_RETENTION.perAgent` were two
//    unlinked 50s in two packages;
//  - a negative keep made `prune` delete everything.

test("a record becomes visible only whole: the write lands under a temporary name first", () => {
  const dir = tmp();
  const seen: string[] = [];
  const store = storeIn(dir);
  const saved = record();

  // watch the folder through the write by hooking the module's own fs use:
  // whatever name the bytes are first written under, it must NOT be the name
  // `list` and `read` look at.
  const realWrite = fs.writeFileSync;
  (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync =
    ((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, o?: unknown) => {
      if (typeof p === "string") seen.push(path.basename(p));
      return realWrite(p as string, data as string, o as never);
    }) as typeof fs.writeFileSync;
  try {
    store.save(saved);
  } finally {
    (fs as unknown as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = realWrite;
  }

  assert.equal(seen.length, 1, "the record was written exactly once");
  assert.notEqual(seen[0], `${saved.id}.json`,
    "bytes went straight to the final name — an interrupted write would be a torn record");
  assert.ok(seen[0].startsWith(`${saved.id}.json.`), "and the temporary name is derived from it");
  // and after the call the final name is there, whole
  assert.deepEqual(store.read("a1", saved.id)?.id, saved.id);
});

test("a torn file left by an older version is recovered, not kept for ever", () => {
  const dir = tmp();
  const store = storeIn(dir);
  const good = record();
  store.save(good);

  // exactly what an interrupted writeFileSync used to leave behind
  const runs = path.join(dir, "agents", "a1", "runs");
  const tornId = "r-000000000000-torn";
  fs.writeFileSync(path.join(runs, `${tornId}.json`), '{"id":"r-000000000000-torn","step', "utf8");
  assert.equal(fs.readdirSync(runs).length, 2);

  const rows = store.list("a1");
  assert.deepEqual(rows.map(r => r.id), [good.id], "the torn file is not offered as a run");
  assert.equal(fs.readdirSync(runs).length, 1,
    "and it no longer occupies a retention slot — it carried nothing to keep");
});

test("a leftover temporary file is swept and never counted as a run", () => {
  const dir = tmp();
  const store = storeIn(dir);
  const good = record();
  store.save(good);
  const runs = path.join(dir, "agents", "a1", "runs");
  fs.writeFileSync(path.join(runs, `r-000000000000-half.json.tmp-1-2`), "{", "utf8");

  assert.deepEqual(store.list("a1").map(r => r.id), [good.id]);
  store.prune("a1");
  assert.deepEqual(fs.readdirSync(runs), [`${good.id}.json`], "the half-written file is gone");
});

// Acceptance (Cursor quality round): a torn write leaves litter beside an
// intact real file, and a failed write is reported rather than swallowed.
test("a simulated torn write leaves temp litter while the real record stays intact", () => {
  const dir = tmp();
  const store = storeIn(dir);
  const good = record();
  const at = store.save(good);
  assert.ok(at);

  const runs = path.join(dir, "agents", "a1", "runs");
  // Exactly what an interrupted write-then-rename leaves: the old final file
  // untouched, and a half-filled temporary name next to it.
  const litter = `${good.id}.json.tmp-${process.pid}-${Date.now()}-1`;
  fs.writeFileSync(path.join(runs, litter), '{"id":"half', "utf8");

  assert.ok(fs.readdirSync(runs).includes(litter), "the temporary litter is still there");
  assert.ok(fs.readdirSync(runs).includes(`${good.id}.json`), "and so is the real file");
  assert.equal(store.read("a1", good.id)?.id, good.id,
    "the real record must still be readable while litter sits beside it");
  assert.deepEqual(JSON.parse(fs.readFileSync(at!, "utf8")).id, good.id,
    "the final name must hold the whole record, not the torn bytes");
});

test("a failed write is reported to the log, not swallowed as a quiet success", () => {
  const dir = tmp();
  const said: string[] = [];
  const store = storeIn(dir, { log: (m: string) => said.push(m) });
  const saved = record();

  // Force the rename step to fail the way a full disk does — writeWholeFile
  // returns false and the store must surface that, not pretend it saved.
  const realRename = fs.renameSync;
  (fs as { renameSync: typeof fs.renameSync }).renameSync = (() => {
    const err = new Error("ENOSPC") as NodeJS.ErrnoException;
    err.code = "ENOSPC";
    throw err;
  }) as typeof fs.renameSync;
  let at: string | undefined;
  try {
    at = store.save(saved);
  } finally {
    (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename;
  }

  assert.equal(at, undefined, "a failed write must not claim a path");
  assert.ok(said.some(m => m.includes(saved.id) && /could not store/i.test(m)),
    `the failure must be said out loud — got ${JSON.stringify(said)}`);
  assert.equal(store.read("a1", saved.id), undefined,
    "and nothing readable may appear under the final name");
});

test("how many runs are kept is ONE number, shared with the hub", async () => {
  const { RUN_RETENTION } = await import("@cloud9/shared");
  const { RUN_STORE_DEFAULTS } = await import("./runstore.js");
  assert.equal(RUN_STORE_DEFAULTS.keepPerAgent, RUN_RETENTION.perAgent,
    "the engine's keep and the hub's keep must be the same fact, not two copies of 50");

  // Equal today is not enough — two 50s in two packages ARE equal today, and
  // that is exactly how they drift apart tomorrow. The number must be DERIVED,
  // so this asserts the source says so rather than that the values happen to
  // match.
  //
  // The path is resolved from THIS FILE, never from the working directory: the
  // compiled test lives in dist/ and can be run from the package root (npm
  // test) or from the repo root (node --test packages/engine/dist/*.test.js).
  // Resolving against cwd passed one way and failed the other, which is a test
  // that reports on where you stood rather than on the code.
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const source = fs.readFileSync(path.resolve(here, "..", "src", "runstore.ts"), "utf8");
  const line = source.split(String.fromCharCode(10)).find(l => l.includes("keepPerAgent:")) ?? "";
  assert.ok(line.includes("RUN_RETENTION.perAgent"),
    `keepPerAgent must be derived from RUN_RETENTION.perAgent, not written out again: ${line.trim()}`);
});

test("how BIG a stored run may be is ONE number too, shared with the hub", async () => {
  const { RUN_RETENTION } = await import("@cloud9/shared");
  const { RUN_STORE_DEFAULTS } = await import("./runstore.js");
  assert.equal(RUN_STORE_DEFAULTS.maxBytes, RUN_RETENTION.bytes,
    "the engine's size cap and the hub's must be the same fact, not two copies of 64 * 1024");

  // The SECOND half of the same finding, and the one that was left behind:
  // `keepPerAgent` was derived, `maxBytes` was still its own `64 * 1024`. Equal
  // today is exactly how two numbers drift tomorrow — raise the hub's cap and
  // the engine keeps trimming to the old one, so the same run has its steps on
  // one screen and missing on another. Assert the SOURCE derives it.
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const source = fs.readFileSync(path.resolve(here, "..", "src", "runstore.ts"), "utf8");
  const line = source.split(String.fromCharCode(10)).find(l => l.trimStart().startsWith("maxBytes:")) ?? "";
  assert.ok(line.includes("RUN_RETENTION.bytes"),
    `maxBytes must be derived from RUN_RETENTION.bytes, not written out again: ${line.trim()}`);
});

// -------------------------------------------- a damaged record is REFUSED,
// in plain words, and never half-believed.

test("a record damaged by a power cut is refused out loud, not half-read", () => {
  // The tag is deliberately meaningless — it becomes part of the file name, and
  // a tag like "empty" would appear in the log line by accident and make the
  // "did it say what was wrong?" assertion pass for the wrong reason.
  const cases: [string, string, string][] = [
    // [what is on disk, the file's own name, the words the log must carry]
    ["", "aa", "empty"],
    ['{"id":"x","agentId":"a1","start', "bb", "stops part-way"],
    ['"just a string"', "cc", "does not hold a run"],
    // an id and nothing else. The words come from `validateRunRecord` now —
    // the SAME refusal the hub gives a record arriving over the wire — rather
    // than from a key-counting rule this file kept for itself.
    ['{"id":"r-000000000001-dd"}', "dd", "a run is a chat reply, a job or a scheduled check-in"],
  ];
  for (const [bytes, tag, words] of cases) {
    const dir = tmp();
    const said: string[] = [];
    const store = storeIn(dir, { log: (m: string) => said.push(m) });
    const good = record();
    store.save(good);

    const runs = path.join(dir, "agents", "a1", "runs");
    const bad = `r-000000000001-${tag}`;
    fs.writeFileSync(path.join(runs, `${bad}.json`), bytes, "utf8");

    assert.equal(store.read("a1", bad), undefined,
      `${tag}: a damaged file was handed back as if it were a run`);
    assert.ok(said.some(m => m.includes(words)),
      `${tag}: the refusal must say what is wrong in plain words — got ${JSON.stringify(said)}`);
    assert.ok(said.some(m => m.includes(bad)), `${tag}: the refusal must name the run`);

    // and the good one beside it is untouched and still readable
    assert.deepEqual(store.list("a1").map(r => r.id), [good.id]);
    assert.equal(store.read("a1", good.id)?.id, good.id);
  }
});

// FINDING 2 OF THE DURABILITY REVIEW. Checking that the KEYS are there is not
// checking that the record means anything: `{"id":42,"outcome":"banana"}` has
// every key the old rule counted, so it was cast to a RunRecord and drawn on
// the screen. The reader now asks `validateRunRecord` — the very function the
// hub already applies to a record arriving over the wire — so there is ONE
// rule about what a run record is, not two that can drift apart.
test("a run with every field present and nonsense in them is refused, by the hub's own rule", () => {
  const whole = record();
  const poisoned: [string, Partial<Record<string, unknown>>, string][] = [
    // [tag, what to break, the plain words the refusal must carry]
    ["aa", { outcome: "banana" }, "a run either worked, failed or was stopped"],
    ["bb", { agentId: {} }, "a run belongs to an agent"],
    ["cc", { startedAt: "soup" }, "that start time isn't a number"],
    ["dd", { kind: "whenever" }, "a run is a chat reply, a job or a scheduled check-in"],
    ["ee", { steps: "three of them" }, "a run record needs a list of steps"],
  ];

  for (const [tag, breakage, words] of poisoned) {
    const dir = tmp();
    const said: string[] = [];
    const store = storeIn(dir, { log: (m: string) => said.push(m) });
    const good = record();
    store.save(good);

    const runs = path.join(dir, "agents", "a1", "runs");
    const bad = `r-000000000002-${tag}`;
    const object = { ...whole, id: bad, ...breakage } as Record<string, unknown>;

    // this is WHY the old rule let it through: every key it counted is present
    for (const key of ["id", "agentId", "startedAt", "outcome"]) {
      assert.notEqual(object[key], undefined,
        `${tag}: this case only proves something if the key-counting rule would have passed it`);
    }
    fs.writeFileSync(path.join(runs, `${bad}.json`), JSON.stringify(object, null, 2), "utf8");

    assert.equal(store.read("a1", bad), undefined,
      `${tag}: a nonsense record was handed back as if it were a run`);
    assert.ok(said.some(m => m.includes(words)),
      `${tag}: the refusal must say what is actually wrong — got ${JSON.stringify(said)}`);
    assert.ok(said.some(m => m.includes(bad)), `${tag}: the refusal must name the run`);

    // and it is not offered in the list, nor allowed to hold a retention slot
    assert.deepEqual(store.list("a1").map(r => r.id), [good.id],
      `${tag}: the nonsense record was listed as a run`);
    assert.deepEqual(fs.readdirSync(runs), [`${good.id}.json`],
      `${tag}: the nonsense record is still occupying a slot`);
  }
});

test("a file we merely could not read is left alone — that is not damage", () => {
  const dir = tmp();
  const store = storeIn(dir);
  const good = record();
  store.save(good);
  const runs = path.join(dir, "agents", "a1", "runs");

  const realRead = fs.readFileSync;
  (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = ((p: fs.PathOrFileDescriptor, o?: unknown) => {
    if (typeof p === "string" && p.endsWith(`${good.id}.json`)) throw new Error("EBUSY");
    return realRead(p as string, o as never);
  }) as typeof fs.readFileSync;
  try {
    assert.deepEqual(store.list("a1"), [], "a file we cannot open right now offers nothing");
  } finally {
    (fs as { readFileSync: typeof fs.readFileSync }).readFileSync = realRead;
  }
  assert.deepEqual(fs.readdirSync(runs), [`${good.id}.json`],
    "…but deleting it would have thrown away a perfectly good run");
  assert.equal(store.read("a1", good.id)?.id, good.id);
});

test("an absurd keep can never empty an agent's history", () => {
  for (const keep of [-5, 0, Number.NaN, -0.5]) {
    const dir = tmp();
    const store = storeIn(dir, { keepPerAgent: keep as number });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = { ...record(), id: newRunId(1_000_000 + i * 1000) };
      ids.push(r.id);
      store.save(r);
    }
    const runs = path.join(dir, "agents", "a1", "runs");
    assert.ok(fs.readdirSync(runs).length >= 1,
      `keep=${String(keep)} deleted every run an agent had`);
    assert.ok(store.list("a1").length >= 1, `keep=${String(keep)} left nothing to list`);
    assert.ok(store.list("a1", keep as number).length >= 1, `list(keep=${String(keep)}) returned nothing`);
    assert.ok(ids.length === 4);
  }
});
