// HOW LONG A TURN MAY TAKE. The bug this covers: both providers held ONE
// hard-coded leash (3 minutes for Claude, 2 for Codex) set in their
// constructors, and the host builds each provider exactly once — so a `!bg`
// job, a `!code` turn and a 6:30am check-in were all killed on a chat reply's
// clock, and the failure did not even say a clock had run out.
//
// Every budget assertion here is made WHERE THE PROVIDER IS REALLY CALLED —
// against the `timeoutMs` the runner was handed — not against the table alone.
// A table nobody reads would pass a table-only test.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AgentDef } from "@cloud9/shared";
import { ClaudeCliProvider } from "./claude-cli.js";
import { CodexProvider } from "./codex.js";
import { promptTurnKind, sanitizeForChat, type PromptTurnKind } from "./provider.js";
import {
  MAX_TURN_TIME_BUDGET_MS, TURN_TIME_BUDGET_MS, TurnTimedOutError,
  describeBudget, timedOutSentence, turnTimeBudgetMs,
} from "./timebudget.js";
import { RunOptions, RunResult } from "./run.js";

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

/** A fake `run` that records the leash it was handed. */
function spy(result: Partial<RunResult> = {}) {
  const calls: { args: string[]; opts: RunOptions }[] = [];
  const runner = async (_cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ args, opts });
    return {
      code: 0, stdout: `{"type":"result","subtype":"success","is_error":false,"result":"ok"}`,
      stderr: "", timedOut: false, notFound: false, ...result,
    };
  };
  return { calls, runner };
}

const MINUTE = 60_000;

// ---------------------------------------------------------------- the table

test("the budget table gives every kind of turn a number, and it is the one documented", () => {
  assert.deepEqual(TURN_TIME_BUDGET_MS, {
    // ONE NUMBER, FOUR ROWS (2026-08-07). This clock stopped being a deadline on
    // the work — it is a backstop against a program that never stops printing,
    // and that job is the same whoever asked. See the note on the table, and
    // `turnleash.test.ts` for the report that forced it.
    chat: 45 * MINUTE,
    task: 45 * MINUTE,
    schedule: 45 * MINUTE,
    repo: 45 * MINUTE,
  });
  // every kind `promptTurnKind` can return has a row — a new kind cannot
  // silently fall through to somebody else's clock
  const kinds: PromptTurnKind[] = ["chat", "task", "schedule", "repo"];
  for (const kind of kinds) {
    assert.equal(typeof TURN_TIME_BUDGET_MS[kind], "number", `${kind} has no budget`);
    assert.ok(turnTimeBudgetMs(kind) > 0, `${kind} got a useless budget`);
  }
});

test("no kind of work is judged more harshly than another — and there is still a real ceiling", () => {
  // WHAT THIS USED TO ASSERT, and why it was wrong: it demanded that delegated
  // work get a LONGER total than a chat reply, on the reasoning that nobody is
  // waiting for it. That reasoning belongs to the silence clock (checked in
  // `turnleash.test.ts`); applied to the total it meant a chat turn was cut off
  // sooner for no reason connected to whether it was working — the exact bug the
  // owner hit on 2026-08-07.
  const chat = turnTimeBudgetMs("chat");
  for (const kind of ["task", "schedule", "repo"] as PromptTurnKind[]) {
    assert.equal(turnTimeBudgetMs(kind), chat,
      `${kind} is judged by a different clock than a chat reply, for no reason it could explain`);
  }
  // NOTHING is unlimited. The leash exists to stop a runaway CLI holding a slot
  // on this computer forever, and that reason does not go away for a long job.
  for (const kind of ["chat", "task", "schedule", "repo"] as PromptTurnKind[]) {
    assert.ok(Number.isFinite(turnTimeBudgetMs(kind)), `${kind} has no ceiling at all`);
    assert.ok(turnTimeBudgetMs(kind) <= MAX_TURN_TIME_BUDGET_MS, `${kind} is past the ceiling`);
  }
});

// ------------------------------------------- the budget where it is really used

test("a chat turn reaches the Claude CLI on the backstop budget", async () => {
  const { calls, runner } = spy();
  await new ClaudeCliProvider({
    agentDataDir: () => process.cwd(), runner, models: () => CLAUDE_MODELS,
  }).respond({ agent: claudeAgent(), context: "", trigger: "hi", triggerAuthor: "V", kind: "chat" });
  assert.equal(calls[0]?.opts.timeoutMs, 45 * MINUTE);
});

test("a delegated turn reaches the Claude CLI on the same backstop", async () => {
  for (const kind of ["task", "schedule"] as const) {
    const { calls, runner } = spy();
    await new ClaudeCliProvider({
      agentDataDir: () => process.cwd(), runner, models: () => CLAUDE_MODELS,
    }).respond({ agent: claudeAgent(), context: "", trigger: "do the work", triggerAuthor: "V", kind });
    assert.equal(calls[0]?.opts.timeoutMs, 45 * MINUTE, `a ${kind} turn was cut short`);
  }
});

test("work inside a repository is on the same backstop as the chat message it came from", async () => {
  // `!code` in the room is recorded as kind "chat" and given a worktree
  // (engine.ts, workInRepository). The worktree is the one thing only repository
  // work has, so the budget follows the SAME derivation the prompt does.
  const { calls, runner } = spy();
  await new ClaudeCliProvider({
    agentDataDir: () => process.cwd(), runner, models: () => CLAUDE_MODELS,
  }).respond({
    agent: claudeAgent(), context: "", trigger: "fix the build", triggerAuthor: "V",
    kind: "chat", workdir: process.cwd(),
  });
  assert.equal(promptTurnKind({ context: "", trigger: "x", triggerAuthor: "V", kind: "chat", workdir: "/w" }), "repo");
  assert.equal(calls[0]?.opts.timeoutMs, 45 * MINUTE);
});

test("Codex reads the same table, and reads the same number for both kinds", async () => {
  const chat = spy();
  await new CodexProvider({ agentDataDir: () => process.cwd(), runner: chat.runner })
    .respond({ agent: codexAgent(), context: "", trigger: "hi", triggerAuthor: "V", kind: "chat" });
  assert.equal(chat.calls[0]?.opts.timeoutMs, 45 * MINUTE);

  const job = spy();
  await new CodexProvider({ agentDataDir: () => process.cwd(), runner: job.runner })
    .respond({ agent: codexAgent(), context: "", trigger: "do it", triggerAuthor: "V", kind: "task" });
  assert.equal(job.calls[0]?.opts.timeoutMs, 45 * MINUTE);
});

test("a pinned leash still overrides the table, for every kind", async () => {
  const { calls, runner } = spy();
  await new ClaudeCliProvider({
    agentDataDir: () => process.cwd(), runner, models: () => CLAUDE_MODELS, timeoutMs: 5_000,
  }).respond({ agent: claudeAgent(), context: "", trigger: "do it", triggerAuthor: "V", kind: "task" });
  assert.equal(calls[0]?.opts.timeoutMs, 5_000);
});

// --------------------------------------------- what the person is actually told

test("a turn stopped by the backstop SAYS what happened, in minutes", async () => {
  const { runner } = spy({ timedOut: true, code: null, stdout: "" });
  await assert.rejects(
    () => new ClaudeCliProvider({
      agentDataDir: () => process.cwd(), runner, models: () => CLAUDE_MODELS,
    }).respond({ agent: claudeAgent(), context: "", trigger: "do it", triggerAuthor: "V", kind: "task" }),
    (err: unknown) => {
      assert.ok(err instanceof TurnTimedOutError, "not recognisable as a timeout");
      assert.equal(err.budgetMs, 45 * MINUTE);
      // it says what it saw — it kept going and never got to an answer — and it
      // does NOT claim the work was fine and killed anyway (2026-08-07)
      assert.match(err.message, /never arrived at an answer/);
      assert.match(err.message, /45 minutes/);
      assert.doesNotMatch(err.message, /working the whole time/);
      return true;
    },
  );
});

test("Codex says the same thing about a chat turn, and names the next move", async () => {
  const { runner } = spy({ timedOut: true, code: null, stdout: "" });
  await assert.rejects(
    () => new CodexProvider({ agentDataDir: () => process.cwd(), runner })
      .respond({ agent: codexAgent(), context: "", trigger: "hi", triggerAuthor: "V", kind: "chat" }),
    (err: unknown) => {
      assert.ok(err instanceof TurnTimedOutError);
      assert.equal(err.budgetMs, 45 * MINUTE);
      // THE SENTENCE HE WAS HANDED ON 2026-08-07 IS GONE. It told him the app
      // had stopped work it could see was working, and offered `!bg` as the way
      // round its own clock. There is no longer a clock to get round: the
      // backstop is the same for every kind of turn, so pointing him at `!bg`
      // would be selling him a longer run that does not exist.
      assert.match(err.message, /never arrived at an answer/);
      assert.match(err.message, /45 minutes/);
      assert.doesNotMatch(err.message, /as long as I let a reply run/);
      assert.doesNotMatch(err.message, /!bg/);
      assert.match(err.message, /ask me again/);
      return true;
    },
  );
});

test("the timeout sentence survives the chat sanitiser instead of becoming 'something went wrong'", () => {
  const said = sanitizeForChat(new TurnTimedOutError("claude", "task", 45 * MINUTE), "a job timed out");
  assert.match(said, /never arrived at an answer/);
  assert.match(said, /45 minutes/);
  assert.doesNotMatch(said, /something went wrong/);
});

test("the timeout sentence leaks no path, no argv, no jargon", () => {
  const kinds: PromptTurnKind[] = ["chat", "task", "schedule", "repo"];
  for (const kind of kinds) {
    const said = timedOutSentence(kind, TURN_TIME_BUDGET_MS[kind]);
    assert.doesNotMatch(said, /[A-Za-z]:\\|\/(?:home|Users|tmp)\//, `${kind}: a path got in`);
    assert.doesNotMatch(said, /--[a-z]/, `${kind}: a command-line flag got in`);
    assert.doesNotMatch(said, /timeout|timeoutMs|SIGKILL|exit code|stderr|ms\b/i, `${kind}: jargon got in`);
    // a person reads minutes, never milliseconds
    assert.doesNotMatch(said, /\b\d{4,}\b/, `${kind}: a raw millisecond number got in`);
  }
});

test("a length of time is said the way a person says it", () => {
  assert.equal(describeBudget(3 * MINUTE), "3 minutes");
  assert.equal(describeBudget(MINUTE), "1 minute");
  assert.equal(describeBudget(30 * MINUTE), "30 minutes");
  assert.equal(describeBudget(45_000), "45 seconds");
  assert.equal(describeBudget(1_000), "1 second");
});

// ------------------------------------------------------- nothing left running

test("a timed-out turn still shuts its doorway and leaves no config file behind", async () => {
  // The guard must not have been traded away for a longer leash: the one-turn
  // MCP config and the tool ticket are cleaned up in a `finally`, so a turn that
  // was KILLED cleans up exactly like one that finished.
  const { runner } = spy({ timedOut: true, code: null, stdout: "" });
  let closed = false;
  const dir = process.cwd();
  await assert.rejects(
    () => new ClaudeCliProvider({
      agentDataDir: () => dir, runner, models: () => CLAUDE_MODELS,
      cloud9Tools: () => ({ url: "http://127.0.0.1:1/x", secret: "s", id: "turn1", close: () => { closed = true; } }),
    }).respond({
      agent: claudeAgent(), context: "", trigger: "do it", triggerAuthor: "V",
      kind: "task", channelId: "c1",
    }),
    (err: unknown) => err instanceof TurnTimedOutError,
  );
  assert.ok(closed, "the tool doorway was left open after the turn was killed");
  // named for THIS turn (see `OpenTurn.id`) — two turns for one agent must not
  // share a filename, so the check is for this turn's own file
  assert.ok(!fs.existsSync(path.join(dir, ".cloud9-mcp-turn1.json")),
    "the one-turn config file was left on disk after the turn was killed");
});
