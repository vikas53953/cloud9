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
