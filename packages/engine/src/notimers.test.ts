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

/** Is this process still running? `kill(pid, 0)` asks without sending anything. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
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

test("STOP really kills the whole TREE, with NO clock underneath it", async () => {
  // THE BLOCKER TEST, and it now tests its own name. Review caught that this
  // used to launch a `setInterval` — a leaf with no children — so it proved a
  // process died and said nothing whatever about a TREE. That matters more than
  // any other single property here: a harness spawns its own children (a build,
  // a test run, a git command), the child Cloud9 sees is a shell, and killing
  // the shell alone leaves the real work running and billing. `killTree` is the
  // one owner of "make it stop" and Stop is now the ONLY early ending there is.
  //
  // So the child below starts a GRANDCHILD, writes its pid down, and the test
  // checks that pid is gone afterwards. The run has no leash at all, so a pass
  // cannot be a timeout in disguise.
  const dir = tempDir("cloud9-tree-");
  const pidFile = path.join(dir, "grandchild.pid").split(path.sep).join("/");
  const file = script(
    `const { spawn } = require("node:child_process");
     const fs = require("node:fs");
     const kid = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
       { stdio: "ignore" });
     fs.writeFileSync(${JSON.stringify(pidFile)}, String(kid.pid));
     setInterval(() => {}, 1000);`);
  const scope = newStopScope();
  const started = Date.now();
  const running = withStopScope(scope, () =>
    run(process.execPath, [file], { timeoutMs: NO_TIME_LIMIT }));
  // wait for the GRANDCHILD to really exist before pulling the plug
  const stopWaiting = Date.now() + 30_000;
  while (!fs.existsSync(pidFile) && Date.now() < stopWaiting) {
    await new Promise(r => setTimeout(r, 50));
  }
  assert.ok(fs.existsSync(pidFile), "the child never started a grandchild, so no tree was tested");
  const grandchild = Number(fs.readFileSync(pidFile, "utf8"));
  assert.ok(grandchild > 0, "no grandchild pid was written");
  assert.equal(alive(grandchild), true, "the grandchild was never running in the first place");

  scope.stop();
  const result = await running;

  assert.equal(result.stopped, true, "the record does not say the owner stopped it");
  assert.equal(result.timedOut, false, "a stop is not a timeout, and there is no clock to be one");
  assert.equal(result.notFound, false, "a stop was read as 'the app isn't installed'");
  assert.ok(Date.now() - started < 60_000, "the child outlived the stop");

  // THE POINT OF THE TEST: the grandchild is gone too.
  const gone = Date.now() + 20_000;
  while (alive(grandchild) && Date.now() < gone) await new Promise(r => setTimeout(r, 50));
  assert.equal(alive(grandchild), false,
    "Stop killed the process Cloud9 could see and left its children running — which is a " +
    "harness still working, and still billing, after he was told it had stopped");
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
