// AN AGENT IS NOT ON A TIMER. Removed 2026-08-07 — this file is the guard.
//
// WHAT HE SAID, and it is the whole argument:
//
//   "just remove the timing… when i do use the claude code or codex there is
//    nothing like that. my agent keeps on working and you can see it. you keep
//    on working over the whole night and now i am coming back in the morning.
//    there is nothing like a timing… what is the meaning of agents? agents are
//    employees so i don't want to implement a timing foundation."
//
// WHAT WAS THERE, and every one of these tests fails against it:
//   · a TOTAL clock on every turn — 3 minutes, then 10, then 45;
//   · a SILENCE clock on every turn — 3 minutes for a reply, 10 for a job;
//   · a TEN-MINUTE DEADLINE on a permission card, after which his own question
//     was thrown away and the agent told "nobody answered in time".
//
// Three rounds were spent tuning those numbers. Each round moved the number and
// kept the mistake, and the mistake was the number: `claude` and `codex` put no
// deadline on a turn and no deadline on a permission prompt, and Cloud9 is a
// front end for them.
//
// WHAT MUST STILL BE TRUE, and it is the whole reason this file is not just
// deletions — REMOVING A CLOCK MUST NOT REMOVE THE WAY OUT:
//   · STOP still ends anything, and still ends it as HIS doing rather than as a
//     failure. It is now the only early ending there is, so it carries all the
//     weight. (`stopping-a-turn.test.ts` holds the rest of that; the test here
//     is specifically that it still works with NO clock underneath it.)
//   · A dead or stopped child is still reaped — no leaked process, no held slot.
//   · Ordinary short commands (git, gh, a version probe) KEEP their few seconds.
//     Those are mechanical one-shot things, not an agent's work.
//   · Nothing tells him a clock ran out, because no clock can.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AgentDef } from "@cloud9/shared";
import { ClaudeCliProvider } from "./claude-cli.js";
import { CodexProvider } from "./codex.js";
import { NO_TIME_LIMIT, newStopScope, run, RunOptions, RunResult, withStopScope } from "./run.js";
import * as timebudget from "./timebudget.js";
import { tempDir } from "./tmp-for-tests.js";

const CLAUDE_MODELS = ["claude-sonnet-5"];

const claudeAgent = (): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
  model: "claude-sonnet-5", createdAt: 0,
});

const codexAgent = (): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
  provider: "codex", createdAt: 0,
});

/** A fake `run` that records every option it was handed. */
function spy() {
  const calls: { opts: RunOptions }[] = [];
  const runner = async (_c: string, _a: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ opts });
    return {
      code: 0, stdout: `{"type":"result","subtype":"success","is_error":false,"result":"ok"}`,
      stderr: "", timedOut: false, notFound: false,
    };
  };
  return { calls, runner };
}

/** Write a throwaway script and give back a path `run()` will accept. */
function script(body: string): string {
  const file = path.join(tempDir("cloud9-notimer-"), "probe.js");
  fs.writeFileSync(file, body);
  return file;
}

// =========================================== 1. no number ever reaches the harness

test("a turn is handed NO clock at all — neither a total nor a silence one", async () => {
  // THE CLASS ASSERTION. Not "the number is bigger" — there is no number. A
  // budget that merely grew would be the same bug waiting for a slower machine
  // or a longer job, which is exactly what the last three rounds proved.
  // `repo` is not a RunKind a caller passes — it is DERIVED inside the provider
  // from a turn standing in a worktree, so it is covered by the same code path.
  const kinds = ["chat", "task", "schedule"] as const;
  for (const kind of kinds) {
    const claude = spy();
    await new ClaudeCliProvider({
      agentDataDir: () => process.cwd(), runner: claude.runner, models: () => CLAUDE_MODELS,
    }).respond({ agent: claudeAgent(), context: "", trigger: "go", triggerAuthor: "V", kind });
    const claudeOpts = claude.calls[0]?.opts ?? {};
    assert.equal(Number.isFinite(claudeOpts.timeoutMs), false,
      `claude/${kind}: a turn was given ${String(claudeOpts.timeoutMs)}ms to finish in`);
    assert.equal((claudeOpts as Record<string, unknown>).quietMs, undefined,
      `claude/${kind}: a silence clock came back`);

    const codex = spy();
    await new CodexProvider({ agentDataDir: () => process.cwd(), runner: codex.runner })
      .respond({ agent: codexAgent(), context: "", trigger: "go", triggerAuthor: "V", kind });
    const codexOpts = codex.calls[0]?.opts ?? {};
    assert.equal(Number.isFinite(codexOpts.timeoutMs), false,
      `codex/${kind}: a turn was given ${String(codexOpts.timeoutMs)}ms to finish in`);
    assert.equal((codexOpts as Record<string, unknown>).quietMs, undefined,
      `codex/${kind}: a silence clock came back`);
  }
});

test("there is no budget table left to read, and nothing exports one", () => {
  // `timebudget.ts` is now nothing but the note explaining why the clocks went.
  // If anything appears in it again, this fails and the note gets read.
  assert.deepEqual(Object.keys(timebudget), [],
    "something is exporting a turn budget again — read timebudget.ts before adding one");
});

// ================================== 2. a turn that says nothing for ages is fine

test("a run with no clock is never killed, however long it says nothing", async () => {
  // The silence clock used to end a chat turn that printed nothing for three
  // minutes — which is what an agent waiting on his approval does, and what a
  // long build or install does. Under `NO_TIME_LIMIT` there is nothing to fire.
  const file = script(
    `console.log("started");
     setTimeout(() => { console.log("finished"); process.exit(0); }, 2500);`);
  const ran = await run(process.execPath, [file], { timeoutMs: NO_TIME_LIMIT });
  assert.equal(ran.timedOut, false, "a run with no clock was somehow stopped by one");
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /finished/, "it was cut off before it said its piece");
});

test("an ordinary command KEEPS its few seconds — this is not a licence to hang", async () => {
  // git, gh, a `--version` probe, a hook. Single mechanical things where a hang
  // leaves a person staring at an empty screen, and where nothing is thinking.
  const file = script(`setInterval(() => {}, 1000);`);   // never exits, never speaks
  const ran = await run(process.execPath, [file], { timeoutMs: 1_500 });
  assert.equal(ran.timedOut, true, "an ordinary command with a leash ran past it");
});

// ================================ 3. Stop still works, and is now the only way

test("STOP still kills a real process tree with NO clock underneath it", async () => {
  // THE BLOCKER TEST. Stop was already the honest ending; it is now the ONLY
  // early one, so if removing the clocks weakened it in any way, this is where
  // it shows. Note the run has no leash at all: nothing but the stop can end it,
  // so a pass here cannot be a timeout in disguise.
  const scope = newStopScope();
  const file = script(`setInterval(() => {}, 1000);`);
  const started = Date.now();
  const running = withStopScope(scope, () =>
    run(process.execPath, [file], { timeoutMs: NO_TIME_LIMIT }));
  await new Promise(r => setTimeout(r, 400));
  scope.stop();
  const result = await running;

  assert.equal(result.stopped, true, "the record does not say the owner stopped it");
  assert.equal(result.timedOut, false, "a stop is not a timeout, and there is no clock to be one");
  assert.equal(result.notFound, false, "a stop was read as 'the app isn't installed'");
  assert.ok(Date.now() - started < 30_000, "the child outlived the stop");
});

test("a child that ends on its own is still reaped, with no clock to notice it", async () => {
  // Removing a deadline must not leak a process or hold a slot: the promise has
  // to settle off the child's own `close`, which is where it always came from.
  const file = script(`console.log("bye"); process.exit(3);`);
  const ran = await run(process.execPath, [file], { timeoutMs: NO_TIME_LIMIT });
  assert.equal(ran.code, 3, "the run never settled on the child's own ending");
  assert.equal(ran.timedOut, false);
  assert.match(ran.stdout, /bye/);
});

test("a command that cannot start at all still comes back, with no clock to rescue it", async () => {
  const ran = await run("this-command-does-not-exist-cloud9", [], { timeoutMs: NO_TIME_LIMIT });
  assert.equal(ran.notFound, true, "a missing command hung for ever instead of saying so");
  assert.equal(ran.timedOut, false);
});
