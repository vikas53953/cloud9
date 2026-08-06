// THE TWO CLOCKS A TURN RUNS UNDER (gap A, 2026-08-05).
//
// WHAT WAS WRONG, measured on the INSTALLED app rather than reasoned about:
// chat turns that really pick up a tool took 70–205 seconds on this machine, and
// the chat leash was 3 minutes. One `git rev-parse` turn was killed at 180
// seconds and the owner was told "this was taking too long for a chat reply".
// It was not taking too long — it was working, on a slow computer, and the app
// stopped it and blamed it.
//
// THE FIX IS TWO CLOCKS, NOT A BIGGER ONE. The total ceiling says how long real
// work may take (chat 10 minutes now, not 3). The SILENCE clock says how long
// nothing at all may happen (chat 3 minutes). A turn that is still printing
// steps is working; one that has printed nothing for that long is stuck. Neither
// is unlimited, and whichever fires first stops the turn.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef } from "@cloud9/shared";
import { ClaudeCliProvider } from "./claude-cli.js";
import { CodexProvider } from "./codex.js";
import { sanitizeForChat, type PromptTurnKind } from "./provider.js";
import {
  MAX_TURN_QUIET_BUDGET_MS, MAX_TURN_TIME_BUDGET_MS, TURN_QUIET_BUDGET_MS, TURN_TIME_BUDGET_MS,
  TurnTimedOutError, timedOutSentence, turnLeash, turnQuietBudgetMs, turnTimeBudgetMs,
} from "./timebudget.js";
import { RunOptions, RunResult, run } from "./run.js";

const MINUTE = 60_000;
const KINDS: PromptTurnKind[] = ["chat", "task", "schedule", "repo"];
const CLAUDE_MODELS = ["claude-sonnet-5"];

const claudeAgent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
  model: "claude-sonnet-5", createdAt: 0, ...over,
});

const codexAgent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
  provider: "codex", createdAt: 0, ...over,
});

/** A fake `run` that records BOTH clocks it was handed. */
function spy(result: Partial<RunResult> = {}) {
  const calls: { opts: RunOptions }[] = [];
  const runner = async (_c: string, _a: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ opts });
    return {
      code: 0, stdout: `{"type":"result","subtype":"success","is_error":false,"result":"ok"}`,
      stderr: "", timedOut: false, notFound: false, ...result,
    };
  };
  return { calls, runner };
}

// -------------------------------------------------- the number that was wrong

/**
 * THE MEASUREMENT THIS WHOLE CHANGE EXISTS FOR. These are real turns off the
 * installed app, in seconds, all of which were genuinely doing tool work.
 * The longest one was KILLED by the old 3-minute leash.
 */
const MEASURED_REAL_CHAT_TURN_SECONDS = [70, 91, 95, 180, 205];

test("a chat turn that is really doing tool work is not killed on this machine", () => {
  // FAILS ON THE OLD TABLE: chat was 3 minutes = 180_000ms, and the longest
  // measured working turn was 205 seconds. This is the whole bug in one line.
  const longestReal = Math.max(...MEASURED_REAL_CHAT_TURN_SECONDS) * 1000;
  assert.ok(turnTimeBudgetMs("chat") > longestReal,
    `a chat reply gets ${turnTimeBudgetMs("chat")}ms, but turns that WORKED took up to ` +
    `${longestReal}ms — the leash is shorter than the work`);
  // and with real headroom, not by a second: a slow day must not be a coin flip
  assert.ok(turnTimeBudgetMs("chat") >= longestReal * 2, "no headroom over the measured worst case");
});

test("nothing became unlimited: every clock still has a real ceiling", () => {
  for (const kind of KINDS) {
    assert.ok(Number.isFinite(turnTimeBudgetMs(kind)), `${kind} total is not finite`);
    assert.ok(Number.isFinite(turnQuietBudgetMs(kind)), `${kind} silence is not finite`);
    assert.ok(turnTimeBudgetMs(kind) <= MAX_TURN_TIME_BUDGET_MS, `${kind} total is past the ceiling`);
    assert.ok(turnQuietBudgetMs(kind) <= MAX_TURN_QUIET_BUDGET_MS, `${kind} silence is past the ceiling`);
  }
  // a chat reply is still much shorter than a delegated job — raising it must
  // not have quietly collapsed the difference the table exists to draw
  for (const kind of ["task", "schedule", "repo"] as PromptTurnKind[]) {
    assert.ok(turnTimeBudgetMs(kind) >= turnTimeBudgetMs("chat") * 2,
      `${kind} is no longer meaningfully longer than a chat reply`);
  }
});

test("the silence clock exists for every kind of turn and can always fire before the total", () => {
  for (const kind of KINDS) {
    assert.equal(typeof TURN_QUIET_BUDGET_MS[kind], "number", `${kind} has no silence budget`);
    assert.ok(turnQuietBudgetMs(kind) > 0, `${kind} got a useless silence budget`);
    // a silence leash that is not SHORTER than the total can never fire, which
    // would make the second clock decoration
    assert.ok(turnQuietBudgetMs(kind) < turnTimeBudgetMs(kind),
      `${kind}: the silence clock cannot fire before the total one`);
  }
  // and a person waiting on a chat reply waits the least for nothing to happen
  for (const kind of ["task", "schedule", "repo"] as PromptTurnKind[]) {
    assert.ok(turnQuietBudgetMs(kind) > turnQuietBudgetMs("chat"),
      `${kind} is no more patient than a reply somebody is sitting in front of`);
  }
  assert.deepEqual(turnLeash("chat"), { timeoutMs: TURN_TIME_BUDGET_MS.chat, quietMs: TURN_QUIET_BUDGET_MS.chat });
});

// ------------------------------------ both clocks where the provider really is

test("the Claude path hands the runner BOTH clocks, per kind of turn", async () => {
  for (const kind of ["chat", "task"] as const) {
    const { calls, runner } = spy();
    await new ClaudeCliProvider({
      agentDataDir: () => process.cwd(), runner, models: () => CLAUDE_MODELS,
    }).respond({ agent: claudeAgent(), context: "", trigger: "go", triggerAuthor: "V", kind });
    assert.equal(calls[0]?.opts.timeoutMs, TURN_TIME_BUDGET_MS[kind], `${kind}: wrong total`);
    assert.equal(calls[0]?.opts.quietMs, TURN_QUIET_BUDGET_MS[kind], `${kind}: no silence clock`);
  }
});

test("Codex reads the same two clocks", async () => {
  const { calls, runner } = spy();
  await new CodexProvider({ agentDataDir: () => process.cwd(), runner })
    .respond({ agent: codexAgent(), context: "", trigger: "go", triggerAuthor: "V", kind: "chat" });
  assert.equal(calls[0]?.opts.timeoutMs, TURN_TIME_BUDGET_MS.chat);
  assert.equal(calls[0]?.opts.quietMs, TURN_QUIET_BUDGET_MS.chat);
});

test("a pinned leash pins BOTH clocks, so a test cannot be killed by the one it did not set", async () => {
  const { calls, runner } = spy();
  await new ClaudeCliProvider({
    agentDataDir: () => process.cwd(), runner, models: () => CLAUDE_MODELS, timeoutMs: 5_000,
  }).respond({ agent: claudeAgent(), context: "", trigger: "go", triggerAuthor: "V", kind: "task" });
  assert.equal(calls[0]?.opts.timeoutMs, 5_000);
  assert.equal(calls[0]?.opts.quietMs, 5_000);
});

// ------------------------------------------------- the clock against a REAL process

/**
 * RUN A PROBE UNTIL THE CHILD ACTUALLY STARTS.
 *
 * NOT a retry of a failed assertion — a retry of a probe that never happened.
 * On this machine a brand-new `.js` in the temp folder is read by the virus
 * scanner before Node will run it, and with the suite running several test files
 * at once that cold start can itself outlast a silence budget. When it does, the
 * child produces NO output at all, which means there was nothing to observe: the
 * clock was right, and the probe simply did not get to run. Retrying a probe
 * that produced nothing is honest; retrying one that produced the wrong answer
 * would not be, and this never does that — a run with output is returned
 * whatever it says.
 */
async function probe(
  file: string, opts: { timeoutMs: number; quietMs: number },
): Promise<RunResult> {
  let last = await run(process.execPath, [file], opts);
  for (let go = 0; go < 3 && last.stdout.trim() === ""; go++) {
    last = await run(process.execPath, [file], opts);
  }
  assert.notEqual(last.stdout.trim(), "",
    "the child never started at all, so nothing about the clock could be observed");
  return last;
}

/** Write a throwaway script and give back a path `run()` will accept. */
function script(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-leash-"));
  const file = path.join(dir, "probe.js");
  fs.writeFileSync(file, body);
  return file;
}

test("a run that keeps talking is NOT killed, however long it runs past the silence budget", async () => {
  // The whole point of measuring silence instead of duration: this child runs
  // for well over its silence budget and is never quiet, so it must finish.
  const file = script(
    `let n = 0;
     const t = setInterval(() => {
       console.log("step " + (++n));
       if (n === 60) { clearInterval(t); process.exit(0); }
     }, 250);`);
  // 15s of chatter against a 12-second silence budget. The budget is
  // generous on purpose: on Windows every `run()` goes through a shell, Node's
  // own cold start is silence too, the virus scanner reads a brand-new file in
  // the temp folder before it will run, and the suite runs these files in
  // parallel. All four are real silence and the clock is right to count them;
  // the budget here just has to be bigger than the worst of them.
  const ran = await probe(file, { timeoutMs: 60_000, quietMs: 12_000 });
  assert.equal(ran.timedOut, false, "a child that was talking the whole time was killed anyway");
  assert.equal(ran.wentQuiet, undefined);
  assert.equal(ran.code, 0);
  // it really did outlive its silence budget: 60 steps at 250ms is 15 seconds
  assert.ok(ran.stdout.split("\n").length > 50, "the run did not actually outlive its silence budget");
  assert.match(ran.stdout, /step 60/);
});

test("a run that goes silent IS killed, and says which clock it was", async () => {
  const file = script(
    `console.log("started");
     setTimeout(() => { console.log("too late"); }, 30000);`);
  const ran = await probe(file, { timeoutMs: 90_000, quietMs: 12_000 });
  assert.equal(ran.timedOut, true, "a child that said nothing for ages was left running");
  assert.equal(ran.wentQuiet, true, "the silence kill did not say it was a silence kill");
  // what it HAD said is still kept — a stuck turn's transcript is still evidence
  assert.match(ran.stdout, /started/);
  assert.doesNotMatch(ran.stdout, /too late/);
});

test("the total ceiling still fires for a run that never stops talking", async () => {
  const file = script(`setInterval(() => console.log("busy"), 50);`);
  const ran = await run(process.execPath, [file], { timeoutMs: 2_500, quietMs: 40_000 });
  assert.equal(ran.timedOut, true, "a chatty runaway was never stopped");
  assert.notEqual(ran.wentQuiet, true, "a total timeout was reported as a freeze");
});

test("a run with no silence budget behaves exactly as it always did", async () => {
  // every other caller of `run()` — gh, codex login, version checks — prints
  // nothing until it is done, and must not have grown a new way to be killed.
  const file = script(`setTimeout(() => { console.log("done"); process.exit(0); }, 900);`);
  const ran = await run(process.execPath, [file], { timeoutMs: 20_000 });
  assert.equal(ran.timedOut, false);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /done/);
});

// --------------------------------------------- what the person is actually told

test("a frozen turn is told as a freeze, not as 'you asked for too much'", async () => {
  const { runner } = spy({ timedOut: true, wentQuiet: true, code: null, stdout: "" });
  await assert.rejects(
    () => new ClaudeCliProvider({
      agentDataDir: () => process.cwd(), runner, models: () => CLAUDE_MODELS,
    }).respond({ agent: claudeAgent(), context: "", trigger: "go", triggerAuthor: "V", kind: "chat" }),
    (err: unknown) => {
      assert.ok(err instanceof TurnTimedOutError);
      assert.equal(err.wentQuiet, true);
      // the number quoted is the SILENCE budget, not the total — quoting ten
      // minutes for a three-minute freeze would be a fresh small lie
      assert.equal(err.budgetMs, TURN_QUIET_BUDGET_MS.chat);
      assert.match(err.message, /stopped moving|stuck/);
      assert.doesNotMatch(err.message, /ran out of time/);
      // it must NOT send him off to break up a job that was never too big
      assert.doesNotMatch(err.message, /smaller piece/);
      return true;
    },
  );
});

test("Codex says the same thing about a freeze, with its own kind's number", async () => {
  const { runner } = spy({ timedOut: true, wentQuiet: true, code: null, stdout: "" });
  await assert.rejects(
    () => new CodexProvider({ agentDataDir: () => process.cwd(), runner })
      .respond({ agent: codexAgent(), context: "", trigger: "go", triggerAuthor: "V", kind: "task" }),
    (err: unknown) => {
      assert.ok(err instanceof TurnTimedOutError);
      assert.equal(err.budgetMs, TURN_QUIET_BUDGET_MS.task);
      assert.match(err.message, /stopped moving/);
      return true;
    },
  );
});

test("a turn that used up its whole time still says so, and still names the way out", async () => {
  const { runner } = spy({ timedOut: true, code: null, stdout: "" });
  await assert.rejects(
    () => new ClaudeCliProvider({
      agentDataDir: () => process.cwd(), runner, models: () => CLAUDE_MODELS,
    }).respond({ agent: claudeAgent(), context: "", trigger: "go", triggerAuthor: "V", kind: "chat" }),
    (err: unknown) => {
      assert.ok(err instanceof TurnTimedOutError);
      assert.equal(err.wentQuiet, false);
      assert.equal(err.budgetMs, TURN_TIME_BUDGET_MS.chat);
      assert.match(err.message, /10 minutes/);
      assert.match(err.message, /!bg/);
      // and it no longer blames the turn for being slow — it WAS working
      assert.doesNotMatch(err.message, /taking too long/);
      return true;
    },
  );
});

test("the owner is still TOLD, whichever clock stopped it — no 'something went wrong'", () => {
  for (const quiet of [false, true]) {
    const said = sanitizeForChat(
      new TurnTimedOutError("claude", "chat", quiet ? 3 * MINUTE : 10 * MINUTE, quiet),
      "a turn was stopped");
    assert.doesNotMatch(said, /something went wrong/, `quiet=${quiet}: the reason was swallowed`);
    assert.match(said, /minutes/);
  }
});

test("neither sentence leaks a path, a flag or jargon", () => {
  for (const kind of KINDS) {
    for (const quiet of [false, true]) {
      const said = timedOutSentence(kind, quiet ? turnQuietBudgetMs(kind) : turnTimeBudgetMs(kind), quiet);
      assert.doesNotMatch(said, /[A-Za-z]:\\|\/(?:home|Users|tmp)\//, `${kind}/${quiet}: a path got in`);
      assert.doesNotMatch(said, /--[a-z]/, `${kind}/${quiet}: a command-line flag got in`);
      assert.doesNotMatch(said, /timeout|SIGKILL|exit code|stderr|stdout|ms\b/i, `${kind}/${quiet}: jargon got in`);
      assert.doesNotMatch(said, /\b\d{4,}\b/, `${kind}/${quiet}: a raw millisecond number got in`);
      // and it always says the machine is not still chewing on it
      assert.match(said, /Nothing was left running|Ask me again|ask me again/,
        `${kind}/${quiet}: it does not say what happens next`);
    }
  }
});
