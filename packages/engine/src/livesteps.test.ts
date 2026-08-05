// WATCHING AN AGENT WORK — the streaming half of the run record.
//
// Everything here is about one promise: showing the work AS IT HAPPENS must not
// change, delay, or endanger the record that is written when it is DONE. So the
// tests come in pairs — "the live view saw it" is always followed by "and the
// buffered result / the record / the leash is exactly what it was".
//
// The transcripts below are the SAME real fixtures `runrecord.test.ts` pins the
// stored record against (captured on this machine, 2026-07-29, claude 2.1.220
// and codex-cli 0.146.0). Deliberately: a live view proved against an invented
// stream would only prove our parser matches our imagination, and worse, could
// drift from the record without a single test going red.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentDef, ClientFrame, Message, RunStep, ServerFrame, WorldState,
} from "@cloud9/shared";
import { run, RunOptions, RunResult } from "./run.js";
import { ProviderTrace, traceFromStream, traceWalker } from "./runrecord.js";
import { claudeMapper, ClaudeCliProvider, traceClaude } from "./claude-cli.js";
import { codexMapper, CodexProvider, traceCodex } from "./codex.js";
import { liveStepWatcher } from "./livesteps.js";
import { TurnTimedOutError } from "./timebudget.js";
import { Engine } from "./engine.js";

/** Real `claude -p --output-format stream-json --verbose` output, 2026-07-29. */
const CLAUDE_LINES = [
  `{"type":"system","subtype":"init","cwd":"C:\\\\Users\\\\vikasmit\\\\probe","session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f","tools":["Read","Glob"],"model":"claude-fable-5"}`,
  `{"type":"assistant","message":{"model":"claude-fable-5","id":"msg_011CdVqvDGnmMsZGkP847Td2","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01EsAbcbYXg49fHS6Q4krR89","name":"Read","input":{"file_path":"C:\\\\Users\\\\vikasmit\\\\AppData\\\\Local\\\\Temp\\\\probe\\\\note.txt"}}],"usage":{"input_tokens":2,"output_tokens":158}},"session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f"}`,
  `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour"},"session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f"}`,
  `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01EsAbcbYXg49fHS6Q4krR89","type":"tool_result","content":"1\\thello from cloud9 probe\\n","is_error":false}]},"session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f"}`,
  `{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f"}`,
  `{"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"thinking","thinking":"the file holds one short line","signature":"CAISugQKiAEIEBgCKkDf"}]},"session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f"}`,
  `{"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"text","text":"Contents: hello from cloud9 probe"}],"usage":{"input_tokens":2,"output_tokens":5}},"session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f"}`,
  `{"is_error":false,"duration_api_ms":8792,"num_turns":2,"stop_reason":"end_turn","session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f","total_cost_usd":0.7581169999999999,"usage":{"input_tokens":4,"cache_creation_input_tokens":35418,"cache_read_input_tokens":35267,"output_tokens":289,"service_tier":"standard"},"permission_denials":[],"subtype":"success","result":"Contents: hello from cloud9 probe","type":"result","duration_ms":45345}`,
];

/** Real `codex exec --json` output, 2026-07-29, same folder and same prompt. */
const CODEX_LINES = [
  `{"type":"thread.started","thread_id":"019fac7b-8e8b-7332-9a2a-a2102ebc9d4b"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"I'll read the file and condense it to exactly five words."}}`,
  `{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"powershell -Command Get-Content note.txt","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"powershell -Command Get-Content note.txt","aggregated_output":"hello from cloud9 probe\\n","exit_code":0,"status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"hello from cloud9 probe confirmed"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":50710,"cached_input_tokens":24320,"cache_write_input_tokens":0,"output_tokens":249,"reasoning_output_tokens":125}}`,
];

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
  model: "claude-sonnet-5", createdAt: 0, ...over,
});

const aTurn = () => ({
  agent: agent(), context: "", trigger: "read the note", triggerAuthor: "Vikas",
  kind: "chat" as const,
});

// ===========================================================================
// 1. THE SEAM — one walker, fed a line at a time or a buffer at once
// ===========================================================================

test("the same walker, fed line by line, reaches the same trace as the whole buffer", () => {
  // If these two ever disagree, the live view and the record are telling the
  // owner different stories about the same turn. That is the failure this whole
  // design exists to make impossible, so it is asserted first.
  const buffered = traceClaude(CLAUDE_LINES.join("\n"));
  const walker = traceWalker("claude", claudeMapper());
  for (const line of CLAUDE_LINES) walker.feed(line);
  assert.deepEqual(walker.done(), buffered);

  const bufferedCodex = traceCodex(CODEX_LINES.join("\n"));
  const codexWalker = traceWalker("codex", codexMapper());
  for (const line of CODEX_LINES) codexWalker.feed(line);
  assert.deepEqual(codexWalker.done(), bufferedCodex);
});

test("steps arrive one line at a time, in the order the CLI reported them", () => {
  const seen: RunStep[][] = [];
  const watch = liveStepWatcher("claude", claudeMapper(), s => seen.push(s));
  assert.ok(watch, "a caller that is watching gets a watcher");
  for (const line of CLAUDE_LINES) watch(line);

  // ONE BATCH PER LINE THAT SAID SOMETHING — and the lines that said nothing
  // about a step (init, the rate-limit notice, the thinking-token notice)
  // produced no batch at all rather than an empty one.
  const flat = seen.flat();
  assert.deepEqual(flat.map(s => [s.seq, s.kind, s.label]), [
    [1, "read", "Read note.txt"],        // the tool_use line
    [1, "read", "Read note.txt"],        // the tool_result line, finishing it
    [2, "thinking", "Thought it through"],
    [3, "message", "Said something"],
  ]);
  // the SECOND report of step 1 is the same step with its outcome filled in —
  // that is why a client merges by `seq` instead of appending
  assert.equal(flat[0].ok, undefined, "nothing is claimed before the CLI said it");
  assert.equal(flat[1].ok, true, "the tool_result is what makes it a tick");
  // and every seq only ever moves forward
  const seqs = flat.map(s => s.seq);
  assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, "steps stream in order");
});

test("a Codex command is shown when it starts and finished when it ends", () => {
  const seen: RunStep[][] = [];
  const watch = liveStepWatcher("codex", codexMapper(), s => seen.push(s));
  for (const line of CODEX_LINES) watch!(line);
  const flat = seen.flat();
  const commands = flat.filter(s => s.kind === "command");
  assert.ok(commands.length >= 2, "announced, then finished — two events, one step");
  assert.equal(commands[0].seq, commands[1].seq, "and it is ONE step, not two");
  assert.equal(commands[commands.length - 1].ok, true);
});

test("a half-written line does not crash the turn and is not shown", () => {
  const seen: RunStep[][] = [];
  const watch = liveStepWatcher("claude", claudeMapper(), s => seen.push(s))!;
  // every shape of nonsense a real stream produces mid-flight
  for (const junk of [
    "",                                   // a blank line
    "   ",
    `{"type":"assistant","message":{"con`, // a chunk boundary landed mid-JSON
    `Loaded 4 skills.`,                    // a CLI logging in plain English
    `}`,                                   // the tail of a line whose head we lost
    `{}`,                                  // valid JSON, means nothing
    `{"type":"assistant"}`,                // the right type, no content
  ]) {
    assert.doesNotThrow(() => watch(junk), `threw on: ${junk}`);
  }
  assert.equal(seen.length, 0, "nothing understood means nothing shown — no guesses");

  // and the watcher still works afterwards: one bad line costs that line only
  watch(CLAUDE_LINES[1]);
  assert.equal(seen.flat().length, 1);
  assert.equal(seen.flat()[0].label, "Read note.txt");
});

test("a mapper that throws costs one line, never the run", () => {
  const seen: RunStep[][] = [];
  const watch = liveStepWatcher("claude", (ev, t) => {
    if (String(ev.type) === "assistant") throw new Error("boom");
    t.add({ kind: "note", label: "still here" });
  }, s => seen.push(s))!;
  assert.doesNotThrow(() => { for (const line of CLAUDE_LINES) watch(line); });
  assert.ok(seen.flat().length > 0, "the lines the mapper could read still landed");
});

test("a watcher whose screen falls over does not fail the turn", () => {
  const watch = liveStepWatcher("claude", claudeMapper(), () => { throw new Error("render blew up"); })!;
  for (const line of CLAUDE_LINES) assert.doesNotThrow(() => watch(line));
});

test("nobody watching means no watcher at all — the silent fallback", () => {
  // This is what keeps an unwatched turn byte-for-byte what it was: `run()`
  // skips its line splitting entirely when there is no callback.
  assert.equal(liveStepWatcher("claude", claudeMapper(), undefined), undefined);
});

// ===========================================================================
// 2. THE RUNNER — per line, without touching the buffered result or the leash
// ===========================================================================

/** A tiny program that prints given lines, so the test drives the REAL spawn. */
function printer(lines: string[], opts: { trailingNewline?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-live-"));
  const script = path.join(dir, "printer.js");
  const body = lines.join("\n") + (opts.trailingNewline === false ? "" : "\n");
  fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(body)});`);
  return script;
}

test("run() reports each COMPLETE line as it arrives, and the buffered result is unchanged", async () => {
  const script = printer(CLAUDE_LINES);
  const lines: string[] = [];
  const result = await run(process.execPath, [script], {
    timeoutMs: 30_000,
    onStdoutLine: l => lines.push(l),
  });

  assert.equal(result.code, 0);
  assert.deepEqual(lines, CLAUDE_LINES, "one call per line, in order, nothing split or joined");

  // AND THE OLD BEHAVIOUR IS EXACTLY THE OLD BEHAVIOUR. The same program run
  // without a watcher must produce the same stdout, byte for byte.
  const plain = await run(process.execPath, [script], { timeoutMs: 30_000 });
  assert.equal(plain.stdout, result.stdout, "watching changed what was captured");
  assert.equal(result.stdout, CLAUDE_LINES.join("\n") + "\n");
});

test("a last line with no newline is still reported, once, when the process ends", async () => {
  const script = printer(["{\"type\":\"turn.started\"}", "{\"type\":\"turn.completed\"}"],
    { trailingNewline: false });
  const lines: string[] = [];
  await run(process.execPath, [script], { timeoutMs: 30_000, onStdoutLine: l => lines.push(l) });
  assert.deepEqual(lines, [`{"type":"turn.started"}`, `{"type":"turn.completed"}`]);
});

test("a watcher that throws cannot take down a run", async () => {
  const script = printer(CLAUDE_LINES);
  const result = await run(process.execPath, [script], {
    timeoutMs: 30_000,
    onStdoutLine: () => { throw new Error("watcher exploded"); },
  });
  assert.equal(result.code, 0, "the run finished normally");
  assert.ok(result.stdout.length > 0, "and still captured everything");
});

test("THE LEASH IS UNTOUCHED: a watched turn that overruns is still killed and still reported", async () => {
  // The kill/timeout guard is the one thing in `run()` that a streaming bug
  // could quietly disable — a watcher holding the stream open, or a flush
  // racing the kill. So a genuinely CHATTY process is leashed here, and the
  // test proves both halves: the timeout is reported, and the process really
  // stopped. (The process-TREE kill has its own long-running test in
  // `run.test.ts`; this one is deliberately quick, because a slow test here
  // steals the machine from the timing-sensitive tests running beside it.)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-live-kill-"));
  const beat = path.join(dir, "beat.txt");
  const script = path.join(dir, "chatty.js");
  fs.writeFileSync(script,
    `const fs=require('fs');`
    // it TALKS, so the watcher is genuinely live when the leash fires…
    + `setInterval(()=>process.stdout.write('{"type":"turn.started"}\\n'),80);`
    // …and it leaves a trace on disk, so "did it really stop?" is a fact
    + `setInterval(()=>fs.writeFileSync(${JSON.stringify(beat)},String(Date.now())),80);`
    + `setTimeout(()=>{},60000);`);

  const lines: string[] = [];
  const result = await run(process.execPath, [script], {
    timeoutMs: 3_000,
    onStdoutLine: l => lines.push(l),
  });
  assert.equal(result.timedOut, true, "the leash still fires on a watched run");
  assert.ok(lines.length > 0, "and the watcher really was live while it ran");
  assert.ok(fs.existsSync(beat), "the child really was running");

  // the kill is asynchronous and best-effort, so WAIT for it to go quiet rather
  // than assuming a fixed delay is enough on a loaded machine
  const budget = Date.now() + 15_000;
  let wentQuiet = false;
  while (Date.now() < budget) {
    const first = fs.readFileSync(beat, "utf8");
    await new Promise(r => setTimeout(r, 800));
    if (fs.readFileSync(beat, "utf8") === first) { wentQuiet = true; break; }
  }
  assert.ok(wentQuiet, "a watched run that timed out did NOT kill its process");
});

// ===========================================================================
// 3. THE PROVIDERS — streaming is offered, and its absence changes nothing
// ===========================================================================

/** A fake runner that plays a transcript back one line at a time. */
function playback(lines: string[]) {
  const calls: { opts: RunOptions }[] = [];
  const runner = async (_cmd: string, _args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ opts });
    for (const line of lines) opts.onStdoutLine?.(line);
    return { code: 0, stdout: lines.join("\n"), stderr: "", timedOut: false, notFound: false };
  };
  return { calls, runner };
}

test("Claude streams its steps live AND still hands back the same finished record", async () => {
  const { calls, runner } = playback(CLAUDE_LINES);
  const provider = new ClaudeCliProvider({
    agentDataDir: () => process.cwd(), runner, models: () => ["claude-sonnet-5"],
  });
  const live: RunStep[] = [];
  let recorded: ProviderTrace | undefined;
  const text = await provider.respond({
    ...aTurn(),
    onStep: steps => live.push(...steps),
    onTrace: t => { recorded = t; },
  });

  assert.ok(calls[0].opts.onStdoutLine, "the provider asked the runner to watch");
  assert.ok(live.length > 0, "steps really did arrive during the turn");
  assert.equal(text, "Contents: hello from cloud9 probe");
  // THE RECORD IS THE RECORD. Not assembled from the live batches, not touched
  // by them — parsed from the full buffered output exactly as it always was.
  //
  // `resumed` is the ONE field the provider adds that the transcript cannot
  // carry: whether this turn continued the harness's own session or started
  // cold is a fact about how the turn was LAUNCHED, not about what the CLI
  // said. It is spelled out here rather than loosened away, so that any OTHER
  // difference between the streamed record and the parsed transcript still
  // fails this test.
  assert.deepEqual(recorded, { ...traceClaude(CLAUDE_LINES.join("\n")), resumed: false });
  // and the live view never showed a step the record does not contain
  const recordedSeqs = new Set(recorded!.steps.map(s => s.seq));
  for (const s of live) assert.ok(recordedSeqs.has(s.seq), `live step ${s.seq} is not in the record`);
});

test("Codex streams its steps live AND still hands back the same finished record", async () => {
  const { calls, runner } = playback(CODEX_LINES);
  const provider = new CodexProvider({
    agentDataDir: () => process.cwd(), runner, models: () => ["gpt-5.6-sol"],
  });
  const live: RunStep[] = [];
  let recorded: ProviderTrace | undefined;
  await provider.respond({
    ...aTurn(),
    agent: agent({ provider: "codex", model: "gpt-5.6-sol" }),
    onStep: steps => live.push(...steps),
    onTrace: t => { recorded = t; },
  });
  assert.ok(calls[0].opts.onStdoutLine);
  assert.ok(live.length > 0);
  assert.deepEqual(recorded, traceCodex(CODEX_LINES.join("\n")));
});

test("NO STREAMING, NO LIVE BOX: a turn nobody watches is exactly the turn it was", async () => {
  // The honesty rule, at the seam: if nothing is watching — or a runner does
  // not support watching — the provider must ask for nothing and the record
  // must still be complete. An empty live view that never fills is the failure
  // this asserts against.
  const { calls, runner } = playback(CLAUDE_LINES);
  const provider = new ClaudeCliProvider({
    agentDataDir: () => process.cwd(), runner, models: () => ["claude-sonnet-5"],
  });
  let recorded: ProviderTrace | undefined;
  const text = await provider.respond({ ...aTurn(), onTrace: t => { recorded = t; } });
  assert.equal(calls[0].opts.onStdoutLine, undefined, "nothing was asked of the runner");
  assert.equal(text, "Contents: hello from cloud9 probe");
  // `resumed: false` is the provider saying which way it launched this turn —
  // see the note on the streamed case above.
  assert.deepEqual(recorded, { ...traceClaude(CLAUDE_LINES.join("\n")), resumed: false },
    "the record is untouched");
});

test("an old-style runner that ignores the option costs nothing but the live view", async () => {
  // Every fake runner in this repo, and any runner written before this feature,
  // simply never calls `onStdoutLine`. The turn must still work.
  const runner = async (): Promise<RunResult> => ({
    code: 0, stdout: CLAUDE_LINES.join("\n"), stderr: "", timedOut: false, notFound: false,
  });
  const provider = new ClaudeCliProvider({
    agentDataDir: () => process.cwd(), runner, models: () => ["claude-sonnet-5"],
  });
  const live: RunStep[] = [];
  const text = await provider.respond({ ...aTurn(), onStep: s => live.push(...s) });
  assert.equal(live.length, 0, "no live steps — and that is the honest outcome");
  assert.equal(text, "Contents: hello from cloud9 probe", "the answer still arrived");
});

test("a timed-out WATCHED turn still reports the clock, not a live-view failure", async () => {
  const runner = async (_c: string, _a: string[], opts: RunOptions = {}): Promise<RunResult> => {
    opts.onStdoutLine?.(CLAUDE_LINES[1]); // it got as far as one tool call
    return { code: null, stdout: "", stderr: "", timedOut: true, notFound: false };
  };
  const provider = new ClaudeCliProvider({
    agentDataDir: () => process.cwd(), runner, models: () => ["claude-sonnet-5"], timeoutMs: 1000,
  });
  const live: RunStep[] = [];
  await assert.rejects(
    () => provider.respond({ ...aTurn(), onStep: s => live.push(...s) }),
    (err: unknown) => err instanceof TurnTimedOutError,
  );
  assert.equal(live.length, 1, "what it did get done was still shown");
});

// ===========================================================================
// 4. THE ENGINE — what actually goes on the wire, and when it does not
// ===========================================================================

const AGENT: AgentDef = {
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You fix builds",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
  approvals: { background: false, schedules: false },
  createdAt: 0,
};

function world(): WorldState {
  return {
    me: { id: "u1", name: "Vikas", createdAt: 0 } as WorldState["me"],
    users: [{ id: "u1", name: "Vikas", createdAt: 0 } as WorldState["users"][number]],
    agents: [AGENT],
    channels: [{ id: "c1", name: "ops", kind: "channel", memberIds: ["u1", "a1"], createdAt: 0 }],
    messages: [], agentStatus: {}, tasks: [], approvals: [],
  };
}

const ASKED: Message = {
  id: "m9", channelId: "c1", authorId: "u1", authorName: "Vikas",
  authorKind: "human", text: "@Scout read the note", ts: 1, mentions: ["a1"],
};

/** An engine whose harness reports `steps` while it works, then answers. */
function engineOver(t: TestContext, steps: RunStep[][], reply = "Done.") {
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-live-e-")),
    provider: {
      async respond(input): Promise<string> {
        for (const batch of steps) input.onStep?.(batch);
        return reply;
      },
    },
  });
  const frames: ClientFrame[] = [];
  (engine as unknown as { sendFrame: (f: ClientFrame) => void }).sendFrame = f => { frames.push(f); };
  (engine as unknown as { onFrame: (f: ServerFrame) => void }).onFrame({ type: "welcome", state: world() });
  t.after(() => { engine.stop(); });
  return { engine, frames };
}

type StepFrame = Extract<ClientFrame, { type: "agentSteps" }>;
const stepFrames = (frames: ClientFrame[]): StepFrame[] =>
  frames.filter((f): f is StepFrame => f.type === "agentSteps");

test("a triggered turn streams its steps to the room, then closes the preview", async t => {
  const { engine, frames } = engineOver(t, [
    [{ seq: 1, kind: "read", label: "Read note.txt", detail: "note.txt" }],
    [{ seq: 2, kind: "command", label: "Ran a command" }],
  ]);
  await engine.takeTurn(AGENT, "c1", ASKED);

  const sent = stepFrames(frames);
  assert.deepEqual(sent.map(f => f.steps?.map(s => s.seq) ?? "end"), [[1], [2], "end"]);
  for (const f of sent) {
    assert.equal(f.messageId, "m9", "drawn on the message that ASKED, never another");
    assert.equal(f.channelId, "c1");
    assert.equal(f.agentId, "a1");
  }
  assert.equal(sent[2].done, true, "the ending is explicit, not left to a timer");
  // AND THE RECORD STILL WENT ITS OWN WAY. The preview is not the record, and
  // the record is still sent, once, as `runRecorded`.
  assert.equal(frames.filter(f => f.type === "runRecorded").length, 1);
});

test("a turn that FELL OVER still closes its preview", async t => {
  // Otherwise a crash leaves a list of steps sitting under his message,
  // implying an agent that is still working. The `finally` is what stops that.
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-live-e-")),
    provider: {
      async respond(input): Promise<string> {
        input.onStep?.([{ seq: 1, kind: "read", label: "Read note.txt" }]);
        throw new Error("the harness fell over");
      },
    },
  });
  const frames: ClientFrame[] = [];
  (engine as unknown as { sendFrame: (f: ClientFrame) => void }).sendFrame = f => { frames.push(f); };
  (engine as unknown as { onFrame: (f: ServerFrame) => void }).onFrame({ type: "welcome", state: world() });
  t.after(() => { engine.stop(); });

  await engine.takeTurn(AGENT, "c1", ASKED);
  const sent = stepFrames(frames);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].done, true, "a turn that died must not leave a preview running");
});

test("a harness that cannot stream sends NOTHING — not even an ending", async t => {
  // The honesty rule on the wire: no live frames at all, rather than an empty
  // box and a "finished" for a box nobody ever saw.
  const { engine, frames } = engineOver(t, []);
  await engine.takeTurn(AGENT, "c1", ASKED);
  assert.equal(stepFrames(frames).length, 0);
  assert.ok(frames.some(f => f.type === "agentSend"), "the answer still arrived");
  assert.equal(frames.filter(f => f.type === "runRecorded").length, 1, "and so did the record");
});

test("a turn nobody asked for streams nothing, however busy it is", async t => {
  // No triggering message means nowhere honest to draw. Same gate as a receipt,
  // and it is the same one answer — a schedule must never paint its work onto
  // somebody else's message.
  const { engine, frames } = engineOver(t, [[{ seq: 1, kind: "read", label: "Read note.txt" }]]);
  await engine.respondAs(AGENT, {
    context: "", trigger: "morning check-in", triggerAuthor: "Vikas", kind: "schedule",
    channelId: "c1",
  });
  assert.equal(stepFrames(frames).length, 0, "no message to draw on means no live view");
});

test("a live step is redacted before it leaves the engine", async t => {
  const { engine, frames } = engineOver(t, [[{
    seq: 1, kind: "command", label: "Ran a command",
    detail: "curl -H 'Authorization: Bearer sk-ant-super-secret-token'",
  }]]);
  await engine.takeTurn(AGENT, "c1", ASKED);
  const detail = stepFrames(frames)[0].steps?.[0].detail ?? "";
  assert.ok(!detail.includes("sk-ant-super-secret-token"),
    "a live step is scrubbed by the same rule a stored one is");
});

// ===========================================================================
// 5. THE STORED RECORD IS UNCHANGED
// ===========================================================================

test("traceFromStream still reads a whole transcript exactly as it always did", () => {
  // `traceFromStream` is now a loop over the walker. This pins that the
  // refactor did not move a single field — the record's own tests cover the
  // detail; this covers the fact that the buffered path still exists at all.
  const t = traceFromStream(CLAUDE_LINES.join("\r\n"), "claude", claudeMapper());
  assert.equal(t.text, "Contents: hello from cloud9 probe");
  assert.equal(t.events, 8, "CRLF line endings are still handled");
  assert.deepEqual(t.steps.map(s => s.kind), ["read", "thinking", "message"]);
});
