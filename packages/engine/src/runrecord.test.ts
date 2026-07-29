// The run record: what an agent actually did, read out of the two CLIs' own
// streams.
//
// Both fixtures below are REAL. They were captured on this machine on
// 2026-07-29 by running the two CLIs with exactly the flags Cloud9 uses
// (`claude 2.1.220`, `codex-cli 0.146.0`), against a folder holding one file,
// with the prompt "Read note.txt and reply with its contents in 5 words."
// Nothing in them is invented, which is the point: a fixture we made up would
// only prove our parser matches our imagination.
import test from "node:test";
import assert from "node:assert/strict";
import { traceClaude } from "./claude-cli.js";
import { traceCodex } from "./codex.js";
import { redactForSharing } from "./provider.js";
import {
  buildRunRecord, countSteps, humanDuration, humanMoney, newRunId, RUN_LIMITS,
  RunSeed, RunUsage, shareableRun, summarizeRun, traceFromStream,
} from "./runrecord.js";

// ---------------------------------------------------------------- fixtures

/** Real `claude -p --output-format stream-json --verbose` output, 2026-07-29. */
const CLAUDE_STREAM = [
  `{"type":"system","subtype":"init","cwd":"C:\\\\Users\\\\vikasmit\\\\probe","session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f","tools":["Read","Glob"],"model":"claude-fable-5"}`,
  `{"type":"assistant","message":{"model":"claude-fable-5","id":"msg_011CdVqvDGnmMsZGkP847Td2","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01EsAbcbYXg49fHS6Q4krR89","name":"Read","input":{"file_path":"C:\\\\Users\\\\vikasmit\\\\AppData\\\\Local\\\\Temp\\\\probe\\\\note.txt"}}],"usage":{"input_tokens":2,"output_tokens":158}},"session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f"}`,
  `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour"},"session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f"}`,
  `{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01EsAbcbYXg49fHS6Q4krR89","type":"tool_result","content":"1\\thello from cloud9 probe\\n","is_error":false}]},"session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f"}`,
  `{"type":"system","subtype":"thinking_tokens","estimated_tokens":50,"session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f"}`,
  `{"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"thinking","thinking":"the file holds one short line","signature":"CAISugQKiAEIEBgCKkDf"}]},"session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f"}`,
  `{"type":"assistant","message":{"model":"claude-fable-5","content":[{"type":"text","text":"Contents: hello from cloud9 probe"}],"usage":{"input_tokens":2,"output_tokens":5}},"session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f"}`,
  `{"is_error":false,"duration_api_ms":8792,"num_turns":2,"stop_reason":"end_turn","session_id":"54d21fe2-e4fe-46fc-b3ad-c163d96ce47f","total_cost_usd":0.7581169999999999,"usage":{"input_tokens":4,"cache_creation_input_tokens":35418,"cache_read_input_tokens":35267,"output_tokens":289,"service_tier":"standard"},"permission_denials":[],"subtype":"success","result":"Contents: hello from cloud9 probe","type":"result","duration_ms":45345}`,
].join("\n");

/** Real `codex exec --json` output, 2026-07-29, same folder and same prompt. */
const CODEX_STREAM = [
  `{"type":"thread.started","thread_id":"019fac7b-8e8b-7332-9a2a-a2102ebc9d4b"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Skill descriptions were shortened to fit the 2% skills context budget."}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"I'll read the file and condense it to exactly five words."}}`,
  `{"type":"item.started","item":{"id":"item_2","type":"command_execution","command":"\\"C:\\\\\\\\WINDOWS\\\\\\\\System32\\\\\\\\WindowsPowerShell\\\\\\\\v1.0\\\\\\\\powershell.exe\\" -Command \\"Get-Content -Raw -LiteralPath .\\\\\\\\note.txt\\"","aggregated_output":"","exit_code":null,"status":"in_progress"}}`,
  `{"type":"item.completed","item":{"id":"item_2","type":"command_execution","command":"\\"C:\\\\\\\\WINDOWS\\\\\\\\System32\\\\\\\\WindowsPowerShell\\\\\\\\v1.0\\\\\\\\powershell.exe\\" -Command \\"Get-Content -Raw -LiteralPath .\\\\\\\\note.txt\\"","aggregated_output":"hello from cloud9 probe\\n","exit_code":0,"status":"completed"}}`,
  `{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"hello from cloud9 probe confirmed"}}`,
  `{"type":"turn.completed","usage":{"input_tokens":50710,"cached_input_tokens":24320,"cache_write_input_tokens":0,"output_tokens":249,"reasoning_output_tokens":125}}`,
].join("\n");

const seed = (over: Partial<RunSeed> = {}): RunSeed => ({
  kind: "chat", agentId: "a1", agentName: "Scout", provider: "codex",
  requestedBy: "Vikas", requestedByKind: "human", ask: "read the note",
  startedAt: 1_000_000, ...over,
});

// ------------------------------------------------------ what Claude tells us

test("a real Claude transcript becomes the steps the agent took", () => {
  const t = traceClaude(CLAUDE_STREAM);
  assert.equal(t.text, "Contents: hello from cloud9 probe");
  assert.deepEqual(t.steps.map(s => [s.kind, s.label]), [
    ["read", "Read note.txt"],
    ["thinking", "Thought it through"],
    ["message", "Said something"],
  ]);
  // the tool_result said is_error:false, so we know the read worked
  assert.equal(t.steps[0].ok, true);
  assert.equal(t.sessionId, "54d21fe2-e4fe-46fc-b3ad-c163d96ce47f");
  assert.equal(t.model, "claude-fable-5");
  assert.equal(t.cliDurationMs, 45345);
  assert.equal(t.numTurns, 2);
  assert.equal(t.error, undefined);
});

test("Claude's own token and money figures are carried through untouched", () => {
  const usage: RunUsage | undefined = traceClaude(CLAUDE_STREAM).usage;
  // Claude does not report reasoning tokens in this envelope. Absent, not zero.
  assert.equal(usage?.reasoningTokens, undefined);
  assert.deepEqual(usage, {
    inputTokens: 4, outputTokens: 289, cachedInputTokens: 35267,
    costUsd: 0.7581169999999999,
  });
});

test("a tool call and its result are ONE step, not two", () => {
  const t = traceClaude(CLAUDE_STREAM);
  assert.equal(t.steps.filter(s => s.kind === "read").length, 1);
});

test("a refused tool is recorded — the one place Cloud9 can prove a limit held", () => {
  const denied = `{"type":"result","subtype":"success","is_error":false,"result":"I can't run commands.",` +
    `"permission_denials":[{"tool_name":"Bash","message":"Bash is not allowed for this agent"}]}`;
  const t = traceClaude(denied);
  assert.deepEqual(t.steps.map(s => [s.kind, s.label, s.ok]), [
    ["note", "Refused to use Bash", false],
  ]);
});

test("a failed Claude turn is read from the envelope, not from what it said", () => {
  const t = traceClaude(`{"type":"result","subtype":"success","is_error":true,"result":"rate limited"}`);
  assert.equal(t.error, "rate limited");
});

// ------------------------------------------------------- what Codex tells us

test("a real Codex transcript becomes the steps the agent took", () => {
  const t = traceCodex(CODEX_STREAM);
  assert.equal(t.text, "hello from cloud9 probe confirmed");
  assert.deepEqual(t.steps.map(s => [s.kind, s.label]), [
    ["note", "Codex reported"],
    ["message", "Said something"],
    ["command", "Ran a command"],
    ["message", "Said something"],
  ]);
  assert.equal(t.sessionId, "019fac7b-8e8b-7332-9a2a-a2102ebc9d4b");
});

test("a command announced and then finished is ONE step, with its exit code", () => {
  const t = traceCodex(CODEX_STREAM);
  const commands = t.steps.filter(s => s.kind === "command");
  assert.equal(commands.length, 1, "item.started and item.completed describe one command");
  assert.equal(commands[0].ok, true, "exit_code 0 is the CLI's own verdict");
  assert.match(commands[0].detail ?? "", /Get-Content/);
});

test("an item-level Codex error is a note, not a failed turn", () => {
  const t = traceCodex(CODEX_STREAM);
  assert.equal(t.error, undefined, "a shortened-skills warning did not fail the turn");
  assert.equal(t.steps[0].kind, "note");
  // turn.failed, on the other hand, really does
  assert.equal(traceCodex(`{"type":"turn.failed","message":"model refused"}`).error, "model refused");
});

test("Codex's token figures are carried through, and no cost is invented", () => {
  const t = traceCodex(CODEX_STREAM);
  const usage: RunUsage | undefined = t.usage;
  assert.equal(usage?.costUsd, undefined, "Codex reports no money figure — we must not make one up");
  assert.deepEqual(usage, {
    inputTokens: 50710, outputTokens: 249, cachedInputTokens: 24320, reasoningTokens: 125,
  });
  assert.equal(t.cliDurationMs, undefined, "Codex reports no duration either");
  assert.equal(t.model, undefined, "Codex never names the model it used");
});

test("a Codex item type we have never seen still shows up as a real step", () => {
  const t = traceCodex(`{"type":"item.completed","item":{"id":"i9","type":"canvas_paint","what":"?"}}`);
  assert.deepEqual(t.steps.map(s => [s.kind, s.label]), [["tool", "Used canvas paint"]]);
});

// --------------------------------------------------------- one seam, not two

test("both providers produce the same shape, so one summary reads both", () => {
  const claude = traceClaude(CLAUDE_STREAM);
  const codex = traceCodex(CODEX_STREAM);
  for (const t of [claude, codex]) {
    assert.ok(Array.isArray(t.steps));
    for (const s of t.steps) {
      assert.equal(typeof s.seq, "number");
      assert.ok(s.label.length > 0);
      assert.ok(s.label.length <= RUN_LIMITS.label);
    }
    assert.deepEqual(t.steps.map(s => s.seq), t.steps.map((_s, i) => i + 1));
  }
});

test("the walker survives rubbish without losing the lines around it", () => {
  const t = traceFromStream(
    ["warming up…", "not json {", `{"type":"a"}`, "", `{"type":"b"}`].join("\r\n"),
    "test",
    (ev, b) => {
      if (ev.type === "a") throw new Error("this mapper is broken for a");
      b.add({ kind: "tool", label: `saw ${String(ev.type)}` });
    },
  );
  assert.equal(t.events, 2, "both JSON lines were counted");
  assert.deepEqual(t.steps.map(s => s.label), ["saw b"], "the throwing event cost only itself");
});

test("a runaway agent cannot write an unbounded record", () => {
  const many = Array.from({ length: RUN_LIMITS.steps + 40 },
    (_v, i) => `{"type":"item.completed","item":{"id":"i${i}","type":"agent_message","text":"line ${i}"}}`);
  const t = traceCodex(many.join("\n"));
  assert.equal(t.steps.length, RUN_LIMITS.steps);
  assert.equal(t.truncated, true, "the record says it was cut, so nobody reads it as a short run");
});

test("an absurdly long single line is skipped rather than parsed", () => {
  const huge = `{"type":"item.completed","item":{"type":"agent_message","text":"${"x".repeat(RUN_LIMITS.line)}"}}`;
  const t = traceCodex([huge, `{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}`].join("\n"));
  assert.equal(t.text, "ok");
  assert.equal(t.events, 1);
});

// ------------------------------------------------------------- plain words

test("the summary of a real Codex run reads like a person wrote it", () => {
  const record = buildRunRecord(
    seed({ startedAt: 0 }),
    { finishedAt: 41_000, outcome: "ok", trace: traceCodex(CODEX_STREAM), reply: "done" },
  );
  assert.equal(summarizeRun(record), "Ran 1 command, took 41 seconds.");
});

test("the summary of a real Claude run names the file work and the money", () => {
  const record = buildRunRecord(
    seed({ provider: "claude", startedAt: 0 }),
    { finishedAt: 45_345, outcome: "ok", trace: traceClaude(CLAUDE_STREAM), reply: "hi" },
  );
  assert.equal(summarizeRun(record), "Read 1 file, took 45 seconds, cost 76 cents.");
});

test("every clause in a summary has a step behind it", () => {
  const record = buildRunRecord(seed(), { finishedAt: 1_004_000, outcome: "ok", reply: "hi" });
  assert.equal(summarizeRun(record),
    "Answered straight from what it knew — no tools used, took 4 seconds.");
  assert.deepEqual(countSteps([]), {
    command: 0, read: 0, write: 0, search: 0, web: 0, tool: 0, message: 0,
  });
});

test("a run that failed says so, and says why in plain words", () => {
  const record = buildRunRecord(seed(), {
    finishedAt: 1_002_000, outcome: "failed",
    error: "my engine isn't connected", trace: traceCodex(CODEX_STREAM),
  });
  assert.match(summarizeRun(record), /^Didn't finish\. Got as far as ran 1 command, took 2 seconds\./);
  assert.match(summarizeRun(record), /my engine isn't connected$/);
});

test("time and money read the way the owner would say them", () => {
  assert.equal(humanDuration(400), "under a second");
  assert.equal(humanDuration(1_000), "1 second");
  assert.equal(humanDuration(41_000), "41 seconds");
  assert.equal(humanDuration(60_000), "1 minute");
  assert.equal(humanDuration(125_000), "2 minutes 5 seconds");
  assert.equal(humanMoney(0.004), "less than a cent");
  assert.equal(humanMoney(0.758), "76 cents");
  assert.equal(humanMoney(4.2), "$4.20");
});

test("a run record always knows how long it took, even when the CLI does not", () => {
  const record = buildRunRecord(seed({ startedAt: 500 }), {
    finishedAt: 3_500, outcome: "ok", trace: traceCodex(CODEX_STREAM), reply: "x",
  });
  assert.equal(record.durationMs, 3_000, "measured by Cloud9");
  assert.equal(record.cliDurationMs, undefined, "and not claimed on the CLI's behalf");
  assert.equal(record.replyChars, 1, "the reply text is not copied into the record");
});

test("run ids sort by time and are usable as file names", () => {
  const early = newRunId(1_000_000_000, () => 0.1);
  const late = newRunId(2_000_000_000, () => 0.1);
  assert.ok(early < late, `${early} should sort before ${late}`);
  assert.match(early, /^r-[0-9a-z]+-[0-9a-z]{4}$/);
  assert.ok(!early.includes("_"), "underscores are not allowed by the shared file-name rule");
});

// ----------------------------------------------------------- safe to share

test("nothing shareable carries a Windows path, a username or an argv", () => {
  const record = buildRunRecord(
    seed({ provider: "claude", ask: "read C:\\Users\\vikasmit\\secrets\\plan.md" }),
    { finishedAt: 1_041_000, outcome: "ok", trace: traceClaude(CLAUDE_STREAM), reply: "hi" },
  );
  const shared = JSON.stringify(shareableRun(record));
  assert.ok(!/[A-Za-z]:\\\\/.test(shared), "no drive-letter path survives");
  assert.ok(!shared.includes("vikasmit"), "no account name survives");
  assert.ok(!shared.includes("AppData"), "no home-folder internals survive");
  // and the useful part is still there
  assert.ok(shared.includes("note.txt"), "the file the agent read is still named");
  assert.ok(shared.includes("plan.md"), "the file the owner asked about is still named");
});

test("the redaction rule keeps what a person needs and drops what they don't", () => {
  assert.equal(redactForSharing("Read C:\\Users\\vikasmit\\notes\\plan.md"), "Read plan.md");
  assert.equal(redactForSharing("opened /home/vik/projects/app.ts"), "opened app.ts");
  assert.equal(redactForSharing("copied \\\\fileserver\\share\\report.xlsx"), "copied report.xlsx");
  assert.equal(redactForSharing("checked https://example.com/a/b?q=1"),
    "checked https://example.com/a/b?q=1", "a web address is the thing you most want to see");
  assert.equal(redactForSharing("ran with ANTHROPIC_API_KEY=sk-ant-abc123456789"),
    "ran with ANTHROPIC_API_KEY=***");
  assert.equal(redactForSharing("token sk-ant-api03-abcdefghijkl"), "token ***");
  assert.equal(redactForSharing("approval_policy=never"), "approval_policy=never",
    "an ordinary setting is not a secret");
  assert.equal(redactForSharing("checked 4 sites and wrote 1 file"), "checked 4 sites and wrote 1 file");
});

test("redaction never throws, whatever it is handed", () => {
  for (const nasty of ["", "\u0000\u0000", "=".repeat(500), "C:\\", "//", "sk-"]) {
    assert.doesNotThrow(() => redactForSharing(nasty));
  }
});
