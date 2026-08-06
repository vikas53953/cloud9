// THREE MEASURED GAPS, CLOSED — and each test here fails without its fix.
//
//   GAP A — a spending limit the owner sets in plain words. Cost per run was
//           already recorded and never limited.
//   GAP B — "show me the plan first". Cloud9 hardcoded `--permission-mode
//           dontAsk`, so an agent could only ever be stopped AFTER it worked.
//   GAP C — a stand-in model. An overloaded model was a failed turn the owner
//           could do nothing about, and a swapped model was invisible.
//
// EVERY CLI FACT BELOW WAS MEASURED, not read off a blog. Claude Code 2.1.222 on
// this machine, 2026-08-05:
//
//   --max-budget-usd 0.0001  →  exit 1, and a result envelope carrying
//     {"is_error":true,"subtype":"error_max_budget_usd",
//      "terminal_reason":"budget_exhausted",
//      "errors":["Reached maximum budget ($0.0001)"],
//      "total_cost_usd":0.000596}
//     — note the spend can be a little OVER the ceiling: the check happens
//     between API calls, not inside one. Cloud9 says "reached its limit",
//     never "spent exactly".
//
//   --permission-mode plan  →  accepted under `-p`. With `Write` among the
//     declared tools it wrote its plan into the OWNER'S `~/.claude/plans`
//     folder. With a read-only tool set it wrote nothing anywhere and returned
//     the plan as its reply. That measurement is why `planOnly` narrows the
//     tools as well as setting the mode.
//
//   --fallback-model a,b  →  accepted under `-p`; the CLI reports what it
//     really used as `message.model` on each assistant event.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentDef, Message, decideSpend, fellBackTo, spendCapOf, spendMonthKey, validateSpendCap,
} from "@cloud9/shared";
import { ClientFrame } from "@cloud9/shared";
import { ApprovalDesk } from "./approvaldesk.js";
import { Engine } from "./engine.js";
import { ClaudeProvider, RespondInput, SpendCapReachedError } from "./provider.js";
import { buildRunRecord, RunRecord, RunSeed } from "./runrecord.js";
import { RunStore } from "./runstore.js";
import { claudeArgs, traceClaude } from "./claude-cli.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-cap-"));

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: true, commands: true },
  provider: "claude", model: "claude-sonnet-5", createdAt: 0, ...over,
} as AgentDef);

const trigger: Message = {
  id: "m1", channelId: "c1", authorId: "u1", authorName: "Vikas",
  authorKind: "human", text: "read the note please", ts: 0,
};

const seed = (over: Partial<RunSeed> = {}): RunSeed => ({
  kind: "chat", agentId: "a1", agentName: "Scout", provider: "claude",
  requestedBy: "Vikas", requestedByKind: "human", ask: "read the note",
  startedAt: Date.now(), ...over,
});

/** A provider that records what the engine handed it, and answers whatever it is told to. */
class SpyProvider implements ClaudeProvider {
  seen: RespondInput[] = [];
  constructor(private opts: { reply?: string; trace?: string; plans?: boolean } = {}) {}
  canPlan(): boolean { return this.opts.plans !== false; }
  async respond(input: RespondInput): Promise<string> {
    this.seen.push(input);
    if (this.opts.trace) input.onTrace?.(traceClaude(this.opts.trace));
    return this.opts.reply ?? "done";
  }
}

function makeEngine(provider: ClaudeProvider, dataDir = tmp()) {
  const engine = new Engine({ relayUrl: "ws://127.0.0.1:1", token: "t", dataDir, provider });
  const sent: string[] = [];
  const frames: unknown[] = [];
  engine.agentSend = (_a, _c, text) => { sent.push(text); };
  // the same cast every other engine test uses to watch the wire
  (engine as unknown as { sendFrame: (f: unknown) => void }).sendFrame =
    f => { frames.push(f); };
  return { engine, sent, frames, dataDir };
}

// =====================================================================
// GAP A — the spending limit
// =====================================================================

test("GAP A: the rule itself — a month already spent refuses, and the words name the limit", () => {
  const cap = { perMonthUsd: 5 };
  const over = decideSpend(cap, 5);
  assert.equal(over.allowed, false, "spending the whole allowance must stop the next turn");
  assert.equal(over.which, "perMonth");
  assert.equal(over.capUsd, 5);
  assert.match(over.reason ?? "", /\$5\.00/, "the sentence has to name the limit — a stop with no number is a bug report");
  assert.doesNotMatch(over.reason ?? "", /undefined|NaN|Error|stack/i);

  // BREAK: change `spent >= cap.perMonthUsd` to `>` in decideSpend and this line
  // fails — spending exactly the allowance would let one more turn through.
  const under = decideSpend(cap, 4.99);
  assert.equal(under.allowed, true);
});

test("GAP A: one number goes to the harness, and it is the SMALLER of the two limits", () => {
  // $2 a job, $5 a month, $4 already spent → only $1 is really left.
  const v = decideSpend({ perJobUsd: 2, perMonthUsd: 5 }, 4);
  assert.equal(v.allowed, true);
  assert.equal(v.turnCapUsd, 1,
    "a job limit that is bigger than what is left of the month is not the ceiling");

  // BREAK: hand the harness `cap.perJobUsd` instead of the minimum and this
  // fails — a turn could spend $2 against a month with $1 left in it.
  assert.equal(decideSpend({ perJobUsd: 2, perMonthUsd: 5 }, 0).turnCapUsd, 2);
  assert.equal(decideSpend({ perJobUsd: 9 }, 0).turnCapUsd, 9);
  assert.equal(decideSpend({}, 0).turnCapUsd, undefined, "no limit set means no ceiling at all");
});

test("GAP A: defaults do not change anything for an agent he already has", () => {
  // An agent from before this existed carries no spendCap at all.
  assert.deepEqual(spendCapOf({}), {}, "absent means no ceiling, never a default one");
  assert.equal(decideSpend(spendCapOf({}), 999_999).allowed, true,
    "an agent with no limit is never stopped, whatever it has spent");
  // And a garbled stored value reads as "he never set one" rather than stopping a crew.
  assert.deepEqual(spendCapOf({ spendCap: { perMonthUsd: Number.NaN } } as never), {});
  assert.deepEqual(spendCapOf({ spendCap: "5" } as never), {});
});

test("GAP A: the running total is a QUERY over the runs already on disk", () => {
  const dir = tmp();
  const store = new RunStore({ agentDataDir: () => path.join(dir, "a1") });
  const now = Date.now();
  const lastMonth = new Date(now); lastMonth.setMonth(lastMonth.getMonth() - 1);

  store.save(buildRunRecord(seed({ startedAt: now }),
    { finishedAt: now, outcome: "ok", trace: { provider: "claude", text: "", steps: [], events: 1, usage: { costUsd: 1.25 } } }, "r-aaa-0001"));
  store.save(buildRunRecord(seed({ startedAt: now }),
    { finishedAt: now, outcome: "ok", trace: { provider: "claude", text: "", steps: [], events: 1, usage: { costUsd: 0.75 } } }, "r-aaa-0002"));
  // a run from LAST month must not count against THIS month's allowance
  store.save(buildRunRecord(seed({ startedAt: lastMonth.getTime() }),
    { finishedAt: lastMonth.getTime(), outcome: "ok", trace: { provider: "claude", text: "", steps: [], events: 1, usage: { costUsd: 40 } } }, "r-aaa-0003"));
  // a Codex run reports no money and must contribute nothing rather than a zero-ish guess
  store.save(buildRunRecord(seed({ startedAt: now, provider: "codex" }),
    { finishedAt: now, outcome: "ok", trace: { provider: "codex", text: "", steps: [], events: 1 } }, "r-aaa-0004"));

  assert.equal(Math.round(store.spentInMonth("a1", now) * 100) / 100, 2,
    "this month is $1.25 + 75c — last month's $40 is a different month");

  // BREAK: drop the month comparison in `costInMonth` and this becomes 42.
});

test("GAP A: a run that is PRUNED still counts against the month it happened in", () => {
  const dir = tmp();
  // keep only 1 run, so saving a second prunes the first
  const store = new RunStore({ agentDataDir: () => path.join(dir, "a1"), keepPerAgent: 1 });
  const now = Date.now();
  store.save(buildRunRecord(seed({ startedAt: now }),
    { finishedAt: now, outcome: "ok", trace: { provider: "claude", text: "", steps: [], events: 1, usage: { costUsd: 3 } } }, "r-aaa-0001"));
  store.save(buildRunRecord(seed({ startedAt: now }),
    { finishedAt: now, outcome: "ok", trace: { provider: "claude", text: "", steps: [], events: 1, usage: { costUsd: 4 } } }, "r-aaa-0002"));

  assert.equal(store.list("a1").length, 1, "retention really did delete the older run");
  assert.equal(store.spentInMonth("a1", now), 7,
    "the deleted run's $3 is carried forward — otherwise a limit would drift UPWARDS "
    + "the harder an agent worked, which is exactly backwards");

  // BREAK: remove the `carryForward` call from `prune` and this reads 4.
  // And nothing is double-counted: asking twice gives the same answer.
  assert.equal(store.spentInMonth("a1", now), 7);
});

test("GAP A: if the carried total cannot be written, the run is KEPT rather than its cost lost", () => {
  const dir = tmp();
  const store = new RunStore({
    agentDataDir: () => path.join(dir, "a1"), keepPerAgent: 1, log: () => { /* quiet */ },
  });
  const now = Date.now();
  const money = (id: string, cost: number): void => {
    store.save(buildRunRecord(seed({ startedAt: now }), {
      finishedAt: now, outcome: "ok",
      trace: { provider: "claude", text: "", steps: [], events: 1, usage: { costUsd: cost } },
    }, id));
  };
  money("r-aaa-0001", 3);

  // THE WRITE FAILS. Injected at the seam rather than by breaking the disk:
  // a full disk, a locked file and a read-only folder all arrive here as the
  // same `false`, and that boolean is the thing under test. (A first attempt
  // put a folder where the ledger goes; Windows quietly renamed over it, which
  // proved only that the injection was unreliable.)
  const store2 = store as unknown as { carryForward: (a: string, r: readonly RunRecord[]) => boolean };
  const real = store2.carryForward.bind(store);
  store2.carryForward = () => false;

  money("r-aaa-0002", 4);

  // The older run is STILL THERE — retention gave way rather than let $3 vanish
  // out of the month's total. A limit that quietly gets looser the harder an
  // agent works is not a limit, and that is the only failure this guard exists
  // to prevent.
  // `list` defaults its limit to the RETENTION count, which is 1 here — so the
  // limit is given explicitly, or the test would be asking the wrong question.
  assert.equal(store.list("a1", 10).length, 2,
    "nothing is deleted until what it cost is safely written down");
  assert.equal(store.spentInMonth("a1", now), 7, "and the month's total is still whole");

  // AND IT HEALS ITSELF. Once the write works again, the next prune tidies up —
  // the guard is a delay, never a leak, and nothing is counted twice.
  store2.carryForward = real;
  store.prune("a1");
  assert.equal(store.list("a1", 10).length, 1, "retention catches up on the next attempt");
  assert.equal(store.spentInMonth("a1", now), 7, "with the total still whole, and not doubled");

  // BREAK: change `prune` back to `this.carryForward(...)` as a bare statement —
  // the first assertion drops to 1 run and the month's total falls to 4, which is
  // a spending limit quietly getting looser the harder the agent works.
});

test("GAP A: the guard RELEASES rather than piling up runs for ever", () => {
  // A GUARD THAT CAN NEVER LET GO IS ITSELF A LEAK. If the total stays
  // unwritable while records keep saving fine — one file locked by a scanner,
  // say — retention would stop for good and his folder would fill up. Past a
  // hard ceiling the runs go anyway, and the log says the month now reads LOWER
  // than it really is. An announced undercount beats a silent one AND beats a
  // folder that grows without end.
  const dir = tmp();
  const said: string[] = [];
  const store = new RunStore({
    agentDataDir: () => path.join(dir, "a1"), keepPerAgent: 1, log: m => said.push(m),
  });
  const store2 = store as unknown as { carryForward: () => boolean };
  store2.carryForward = () => false;

  const now = Date.now();
  for (let i = 1; i <= 9; i++) {
    store.save(buildRunRecord(seed({ startedAt: now }), {
      finishedAt: now, outcome: "ok",
      trace: { provider: "claude", text: "", steps: [], events: 1, usage: { costUsd: 1 } },
    }, `r-aaa-000${i}`));
  }

  // keep=1, so the ceiling is 4 — the pile is cut back once it passes it
  assert.ok(store.list("a1", 50).length <= 4,
    "the pile is bounded even though the total could never be written");
  assert.ok(said.some(m => /reads LOWER than it really is/.test(m)),
    "and it is SAID, in plain words — an undercount nobody is told about is the "
    + "silent failure this whole guard exists to prevent");

  // BREAK: drop `&& !this.tooManyToKeep(dir)` from `prune` and all nine runs
  // stay for ever, with nothing ever saying why.
});

test("GAP A: and the carry really does report failure when it cannot open the ledger", () => {
  // The other half of the same law: `prune` acting on the answer is only worth
  // anything if the answer is honest. An agent id that cannot become a folder
  // has nowhere to write the total, and that must read as false, not as "done".
  // A FILE where the agent's folder should be: `mkdirSync` cannot make a folder
  // inside it, so there is genuinely nowhere to write the total. (An earlier
  // attempt used "", which resolves to the working directory and cheerfully
  // succeeded — writing a stray ledger into the package. The injection has to
  // be somewhere that really cannot be written.)
  const blocked = path.join(tmp(), "not-a-folder");
  fs.writeFileSync(blocked, "this is a file");
  const store = new RunStore({ agentDataDir: () => blocked, log: () => { /* quiet */ } });
  const failed = (store as unknown as {
    carryForward: (a: string, r: readonly RunRecord[]) => boolean;
  }).carryForward("a1", [buildRunRecord(seed(), {
    finishedAt: Date.now(), outcome: "ok",
    trace: { provider: "claude", text: "", steps: [], events: 1, usage: { costUsd: 2 } },
  }, "r-aaa-0001")]);
  assert.equal(failed, false, "no ledger to write to is a failure, never a silent success");

  // …and a run that cost nothing is always safe to delete, because deleting it
  // takes nothing out of the total. Codex runs are all of these.
  const nothingToCarry = (store as unknown as {
    carryForward: (a: string, r: readonly RunRecord[]) => boolean;
  }).carryForward("a1", [buildRunRecord(seed({ provider: "codex" }), {
    finishedAt: Date.now(), outcome: "ok",
    trace: { provider: "codex", text: "", steps: [], events: 1 },
  }, "r-aaa-0002")]);
  assert.equal(nothingToCarry, true,
    "a run with no money on it must not be able to jam retention for ever");
});

test("GAP A: the harness is really handed --max-budget-usd, and only when there is a limit", () => {
  const withCap = claudeArgs(agent(), ["claude-sonnet-5"], { maxBudgetUsd: 1.5 });
  const i = withCap.indexOf("--max-budget-usd");
  assert.ok(i >= 0, "the measured CLI flag has to be on the line");
  assert.equal(withCap[i + 1], "1.5");

  // THE DEFAULT IS THE COMMAND LINE HE ALREADY HAD.
  const without = claudeArgs(agent(), ["claude-sonnet-5"]);
  assert.ok(!without.includes("--max-budget-usd"),
    "an agent with no limit must produce exactly yesterday's command line");
  // and a nonsense ceiling drops the flag rather than putting NaN on a command line
  assert.ok(!claudeArgs(agent(), ["claude-sonnet-5"], { maxBudgetUsd: Number.NaN })
    .includes("--max-budget-usd"));
});

test("GAP A: the engine stops the turn when the month is spent, in words, with no stack trace", async () => {
  const spy = new SpyProvider();
  const { engine, sent } = makeEngine(spy);
  const capped = agent({ spendCap: { perMonthUsd: 1 } });
  // put $1.20 of history on this agent's disk
  const now = Date.now();
  engine.runs.save(buildRunRecord(seed({ startedAt: now }), {
    finishedAt: now, outcome: "ok",
    trace: { provider: "claude", text: "", steps: [], events: 1, usage: { costUsd: 1.2 } },
  }, "r-aaa-0001"));

  await engine.takeTurn(capped, "c1", trigger);

  assert.equal(spy.seen.length, 0, "IT NEVER HALF-RUNS: the harness was not started at all");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /limit for this month/i, "he is told which limit stopped it");
  assert.match(sent[0]!, /\$1\.00/, "…and how much it is");
  assert.doesNotMatch(sent[0]!, /Error|stack|undefined|at Object|\.ts:/,
    "never a stack trace — this is the sentence the whole feature exists to produce");
  assert.equal(engine.lastRun?.outcome, "failed");
  assert.deepEqual(engine.lastRun?.capStop, { which: "perMonth", capUsd: 1 },
    "the record carries the FACT beside the sentence, so a screen can mark it "
    + "without reading English");

  // BREAK: delete the `if (!spendVerdict.allowed) throw` in `respondAs` and the
  // provider is called, the reply is "done", and there is no capStop at all.
});

test("GAP A: an agent with no limit is untouched — the harness gets no ceiling", async () => {
  const spy = new SpyProvider();
  const { engine, sent } = makeEngine(spy);
  await engine.takeTurn(agent(), "c1", trigger);
  assert.deepEqual(sent, ["done"]);
  assert.equal(spy.seen[0]?.maxBudgetUsd, undefined,
    "no limit set means no ceiling reaches the harness");
});

test("GAP A: the harness stopping ITSELF on the ceiling is never reported as a finished job", async () => {
  // The measured envelope, verbatim in shape, from CLI 2.1.222 on 2026-08-05.
  const BUDGET_STOP = [
    `{"type":"assistant","message":{"model":"claude-sonnet-5","content":[{"type":"text","text":"I read the first file and started on the second"}]}}`,
    `{"is_error":true,"subtype":"error_max_budget_usd","terminal_reason":"budget_exhausted",`
      + `"errors":["Reached maximum budget ($0.50)"],"total_cost_usd":0.503,"num_turns":1,`
      + `"duration_ms":2024,"type":"result"}`,
  ].join("\n");
  const spy = new SpyProvider({ trace: BUDGET_STOP, reply: "I read the first file and started on the second" });
  const { engine, sent } = makeEngine(spy);

  await engine.takeTurn(agent({ spendCap: { perJobUsd: 0.5 } }), "c1", trigger);

  assert.equal(spy.seen[0]?.maxBudgetUsd, 0.5, "the job limit reached the harness");
  assert.equal(sent.length, 1);
  assert.match(sent[0]!, /spending limit/i);
  assert.match(sent[0]!, /50 cents/, "the limit is named in the owner's own money words");
  assert.ok(!sent[0]!.includes("I read the first file"),
    "HALF A JOB IS NOT AN ANSWER: the partial reply must not be posted as though the "
    + "work were done — that is the silent half-run this gap was about");
  assert.equal(engine.lastRun?.outcome, "failed");
  assert.equal(engine.lastRun?.capStop?.which, "perJob");

  // BREAK: remove the `error_max_budget_usd` branch from `claudeMapper` and the
  // turn comes back as a clean "ok" whose reply is half a job.
});

test("GAP A: the app is honest that a Codex agent cannot be capped", async () => {
  const spy = new SpyProvider();
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(), codexProvider: spy,
  });
  engine.agentSend = () => { /* ignore */ };
  (engine as unknown as { sendFrame: (f: unknown) => void }).sendFrame = () => { /* ignore */ };
  const codexAgent = agent({ provider: "codex", model: undefined, spendCap: { perMonthUsd: 0.01 } });
  const now = Date.now();
  engine.runs.save(buildRunRecord(seed({ startedAt: now, provider: "codex" }), {
    finishedAt: now, outcome: "ok",
    trace: { provider: "codex", text: "", steps: [], events: 1, usage: { costUsd: 99 } },
  }, "r-aaa-0001"));

  await engine.takeTurn(codexAgent, "c1", trigger);
  assert.equal(engine.lastRun?.outcome, "ok",
    "Codex reports no money, so a ceiling it cannot measure must not silently stop it — "
    + "the editor greys the boxes out and says why instead");
  assert.equal(spy.seen[0]?.maxBudgetUsd, undefined);
});

test("GAP A: the amounts a person may type are checked in plain words", () => {
  assert.equal(validateSpendCap(undefined), null, "no limit is always fine");
  assert.equal(validateSpendCap({ perJobUsd: 5, perMonthUsd: 50 }), null);
  assert.match(validateSpendCap({ perJobUsd: 0.001 }) ?? "", /one cent/);
  assert.match(validateSpendCap({ perMonthUsd: 99_999_999 }) ?? "", /too big/);
  assert.match(validateSpendCap({ perJobUsd: "lots" }) ?? "", /isn't an amount of money/);
  for (const words of [validateSpendCap({ perJobUsd: 0.001 }), validateSpendCap({ perJobUsd: "x" })]) {
    assert.doesNotMatch(words ?? "", /perJobUsd|spendCap|number|undefined|NaN/,
      "he never chose a field name — a program did");
  }
});

test("GAP A: a calendar month is the owner's own month, and two months never blur", () => {
  const jan31 = new Date(2026, 0, 31, 23, 59).getTime();
  const feb1 = new Date(2026, 1, 1, 0, 1).getTime();
  assert.equal(spendMonthKey(jan31), "2026-01");
  assert.equal(spendMonthKey(feb1), "2026-02");
  assert.notEqual(spendMonthKey(jan31), spendMonthKey(feb1));
});

// =====================================================================
// GAP B — show me the plan first
// =====================================================================

test("GAP B: a plan turn asks the CLI for plan mode and STRIPS the writing tools", () => {
  const full = agent();                       // files + commands + webSearch
  const ordinary = claudeArgs(full, ["claude-sonnet-5"]);
  const planning = claudeArgs(full, ["claude-sonnet-5"], { planOnly: true });

  assert.equal(ordinary[ordinary.indexOf("--permission-mode") + 1], "dontAsk",
    "an ordinary turn is exactly the command line it always was");
  assert.equal(planning[planning.indexOf("--permission-mode") + 1], "plan");

  const toolsOf = (args: string[]): string[] => {
    const at = args.indexOf("--tools");
    const out: string[] = [];
    for (let i = at + 1; i < args.length && !args[i]!.startsWith("--"); i++) out.push(args[i]!);
    return out;
  };
  const planTools = toolsOf(planning);
  // MEASURED REASON (2.1.222, 2026-08-05): in plan mode WITH `Write` declared,
  // the CLI wrote its plan into the owner's own ~/.claude/plans folder. With a
  // read-only set it wrote nothing and returned the plan as its reply.
  for (const forbidden of ["Write", "Edit", "NotebookEdit", "Bash", "PowerShell"]) {
    assert.ok(!planTools.includes(forbidden),
      `a plan turn must not hold ${forbidden} — a plan that writes a file is not a plan`);
    assert.ok(planning.includes(forbidden),
      `${forbidden} must be spelled out under --disallowed-tools, not merely left off`);
  }
  assert.ok(planTools.includes("Read"), "it still has to be able to read, or the plan is a guess");
  // IT CAN ONLY EVER NARROW: every plan tool is one this agent already had.
  for (const t of planTools) assert.ok(toolsOf(ordinary).includes(t));

  // BREAK: drop the `extras.planOnly` filter on `built` and Write/Edit/Bash
  // reappear in a turn whose whole promise is that nothing happens.
});

test("GAP B: a narrower agent's plan turn is narrower still — never widened", () => {
  const talker = agent({ abilities: { webSearch: true } } as never);
  const planning = claudeArgs(talker, ["claude-sonnet-5"], { planOnly: true });
  const at = planning.indexOf("--tools");
  const tools: string[] = [];
  for (let i = at + 1; i < planning.length && !planning[i]!.startsWith("--"); i++) tools.push(planning[i]!);
  assert.ok(!tools.includes("Read"), "an agent without the files switch does not gain Read in plan mode");
  assert.deepEqual(tools.sort(), ["WebFetch", "WebSearch"]);
});

test("GAP B: the plan goes on the ORDINARY approval card, and nothing runs until he answers", async () => {
  const spy = new SpyProvider({ reply: "1. Read note.txt\n2. Add a line saying hello" });
  const { engine, sent, frames } = makeEngine(spy);

  const turn = engine.takeTurn(agent({ planFirst: true }), "c1", trigger);
  await new Promise(r => setTimeout(r, 20));

  // ONE turn so far, and it was the read-only one.
  assert.equal(spy.seen.length, 1, "the work has NOT started");
  assert.equal(spy.seen[0]?.planOnly, true);

  const ask = frames.find((f): f is { type: string; plan: string; askId: string } =>
    !!f && typeof f === "object" && (f as { type?: string }).type === "askPlan");
  assert.ok(ask, "a plan card was asked for");
  assert.match(ask!.plan, /Read note\.txt/, "the card carries what the agent said it intends to do");
  assert.match(sent.join("\n"), /nothing has happened yet/i,
    "and he is told in the room, in his own words, that nothing has been done");
  assert.equal(engine.lastRun?.planOnly, true, "the plan turn is recorded AS a plan, not as the job");

  // NOW HE SAYS YES — through the same `decideApproval` path an action card uses.
  engine.approvals.onAsked(ask!.askId, "ap1");
  engine.approvals.onApproval({
    id: "ap1", agentId: "a1", ownerId: "u1", action: "the plan", status: "approved",
    createdAt: Date.now(), kind: "plan",
  });
  await turn;

  assert.equal(spy.seen.length, 2, "only now does the real turn run");
  assert.equal(spy.seen[1]?.planOnly, undefined);
  assert.match(spy.seen[1]!.trigger, /Carry out EXACTLY this plan/,
    "THE PLAN HE APPROVED IS WHAT GETS DONE — not the original ask on its own");
  assert.match(spy.seen[1]!.trigger, /Read note\.txt/);

  // BREAK: remove the `showsPlanFirst(agent)` branch from `takeTurn` and the
  // very first call is the real turn, with no card and no chance to say no.
});

test("GAP B: SAYING NO REALLY STOPS IT — and so does saying nothing at all", async () => {
  for (const answer of ["rejected", "silence"] as const) {
    const spy = new SpyProvider({ reply: "1. Delete everything" });
    const { engine, sent, frames } = makeEngine(spy);
    // a very short deadline so "nobody answered" is testable
    // a very short deadline, through the SAME desk class the engine uses
    engine.approvals = new ApprovalDesk({
      send: (f: ClientFrame) => { frames.push(f); }, waitMs: 30, log: () => { /* quiet */ },
    });

    const turn = engine.takeTurn(agent({ planFirst: true }), "c1", trigger);
    await new Promise(r => setTimeout(r, 20));
    const ask = frames.find((f): f is { type: string; askId: string } =>
      !!f && typeof f === "object" && (f as { type?: string }).type === "askPlan");
    assert.ok(ask, `a card was asked for (${answer})`);

    if (answer === "rejected") {
      engine.approvals.onAsked(ask!.askId, "ap1");
      engine.approvals.onApproval({
        id: "ap1", agentId: "a1", ownerId: "u1", action: "the plan", status: "rejected",
        createdAt: Date.now(), kind: "plan",
      });
    }
    await turn;

    assert.equal(spy.seen.length, 1,
      `SILENCE IS NEVER A YES: only the read-only plan turn ever ran (${answer})`);
    assert.match(sent.join("\n"), /haven't done any of it/i);
  }
});

test("GAP B: '!plan <task>' is the same one gate, asked for a single message", async () => {
  const spy = new SpyProvider({ reply: "1. Look at the build" });
  const { engine } = makeEngine(spy);
  // the agent has NO standing plan setting — this one message asks for it
  void engine.takeTurn(agent(), "c1", { ...trigger, text: "fix the build" }, { planFirst: true });
  await new Promise(r => setTimeout(r, 20));
  assert.equal(spy.seen[0]?.planOnly, true,
    "the bang command and the setting share ONE implementation, so there is one plan gate");
});

test("GAP B: an app with no plan mode refuses out loud rather than quietly doing the work", async () => {
  const spy = new SpyProvider({ plans: false });
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(), codexProvider: spy,
  });
  const sent: string[] = [];
  engine.agentSend = (_a, _c, text) => { sent.push(text); };
  (engine as unknown as { sendFrame: (f: unknown) => void }).sendFrame = () => { /* ignore */ };

  await engine.takeTurn(
    agent({ provider: "codex", model: undefined, planFirst: true }), "c1", trigger);

  assert.equal(spy.seen.length, 0,
    "REFUSED AT THE GATE: an app with no plan mode never even starts the turn, so it "
    + "can never quietly do the work instead");
  assert.match(sent.join("\n"), /cannot show you a plan/i,
    "THE ONE THING THIS MUST NEVER DO is quietly do the work when he asked to see the plan");
  assert.doesNotMatch(sent.join("\n"), /Error|stack|\.ts:/);
});

// =====================================================================
// GAP C — the stand-in model
// =====================================================================

test("GAP C: the CLI is really told about the stand-in, and only when there is one", () => {
  const withFallback = claudeArgs(
    agent({ fallbackModels: ["claude-haiku-4-5"] }), ["claude-sonnet-5", "claude-haiku-4-5"]);
  const i = withFallback.indexOf("--fallback-model");
  assert.ok(i >= 0, "the measured CLI flag has to be on the line");
  assert.equal(withFallback[i + 1], "claude-haiku-4-5");

  // NOTHING COMMA-JOINED EVER REACHES A COMMAND LINE, and that is a MEASURED
  // constraint rather than a preference. The CLI's own flag takes a
  // comma-separated list, but `safeArg` in `run.ts` — the one owner of what may
  // go on a command line — refuses commas, exactly as it refuses quotes and
  // shell characters. Weakening that boundary to fit a second-choice model
  // would be a bad trade, so an agent gets ONE stand-in and a save asking for
  // two is refused in words. Caught by this very test on its first run,
  // 2026-08-05, when the comma-joined form threw `UnsafeArgumentError`.
  assert.throws(
    () => claudeArgs(
      agent({ fallbackModels: ["claude-haiku-4-5", "claude-opus-5"] }),
      ["claude-sonnet-5", "claude-haiku-4-5", "claude-opus-5"]),
    /one stand-in model/,
    "two stand-ins is refused in plain words, not silently truncated");
  assert.ok(!withFallback.some(a => a.includes(",")),
    "no argument on this line may contain a comma");

  // THE DEFAULT IS YESTERDAY'S COMMAND LINE.
  assert.ok(!claudeArgs(agent(), ["claude-sonnet-5"]).includes("--fallback-model"));
  // A STAND-IN EQUAL TO THE CHOSEN MODEL IS REFUSED IN WORDS, not quietly
  // dropped: it would put a flag on the line that can never do anything, and a
  // setting that silently does nothing is worse than no setting — the same law
  // `--effort` already follows a few lines above it.
  assert.throws(
    () => claudeArgs(agent({ fallbackModels: ["claude-sonnet-5"] }), ["claude-sonnet-5"]),
    /different from the model the agent already uses/);
});

test("GAP C: a swap is only ever CLAIMED when it can be proved", () => {
  // it really did fall back to a model he named
  assert.equal(fellBackTo("claude-sonnet-5", "claude-haiku-4-5", ["claude-haiku-4-5"]),
    "claude-haiku-4-5");
  // it got what it asked for
  assert.equal(fellBackTo("claude-sonnet-5", "claude-sonnet-5", ["claude-haiku-4-5"]), undefined);
  // NO FALSE ALARM. Measured on 2.1.222: asking for `claude-opus-4-1-20250805`
  // came back reported as `claude-opus-5` with no fallback involved — the app
  // resolved an alias. "Different from what we asked" is therefore NOT the test;
  // "is one he named as a stand-in" is.
  assert.equal(fellBackTo("claude-opus-4-1-20250805", "claude-opus-5", ["claude-haiku-4-5"]),
    undefined, "an alias the app resolved is not a fallback and must never be claimed as one");
  // and with no stand-ins configured there is nothing to claim
  assert.equal(fellBackTo("claude-sonnet-5", "claude-haiku-4-5", []), undefined);
});

test("GAP C: a stand-in that ran is RECORDED and SAID — never a silent swap", async () => {
  const FELL_BACK = [
    `{"type":"assistant","message":{"model":"claude-haiku-4-5","content":[{"type":"text","text":"here you go"}]}}`,
    `{"is_error":false,"subtype":"success","result":"here you go","total_cost_usd":0.01,"type":"result"}`,
  ].join("\n");
  const spy = new SpyProvider({ trace: FELL_BACK, reply: "here you go" });
  const { engine, sent } = makeEngine(spy);

  await engine.takeTurn(
    agent({ model: "claude-sonnet-5", fallbackModels: ["claude-haiku-4-5"] }), "c1", trigger);

  assert.equal(engine.lastRun?.outcome, "ok", "falling back is a turn that WORKED, not one that failed");
  assert.equal(engine.lastRun?.actualModel, "claude-haiku-4-5");
  assert.equal(engine.lastRun?.fellBackTo, "claude-haiku-4-5",
    "the record says the difference was a fallback, not merely that two ids differ");
  assert.ok(sent.some(t => /was busy/i.test(t) && /Haiku/i.test(t)),
    "HE IS TOLD IN THE ROOM. A swap he can only find by reading a run record is a silent swap.");

  // BREAK: delete the `stoodIn` block in `respondAs` and the reply arrives with
  // no mention that he did not get the model he chose.
});

test("GAP C: getting the model you asked for says nothing at all", async () => {
  const NORMAL = [
    `{"type":"assistant","message":{"model":"claude-sonnet-5","content":[{"type":"text","text":"here you go"}]}}`,
    `{"is_error":false,"subtype":"success","result":"here you go","total_cost_usd":0.01,"type":"result"}`,
  ].join("\n");
  const spy = new SpyProvider({ trace: NORMAL, reply: "here you go" });
  const { engine, sent } = makeEngine(spy);
  await engine.takeTurn(
    agent({ model: "claude-sonnet-5", fallbackModels: ["claude-haiku-4-5"] }), "c1", trigger);
  assert.deepEqual(sent, ["here you go"], "no extra line when nothing happened");
  assert.equal(engine.lastRun?.fellBackTo, undefined);
});

// =====================================================================
// ALL THREE — the promise that binds them
// =====================================================================

test("nothing here changes an agent he already has", async () => {
  const spy = new SpyProvider({ reply: "the answer" });
  const { engine, sent } = makeEngine(spy);
  // exactly the shape of an agent saved before any of this existed
  const old: AgentDef = {
    id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "p",
    abilities: { webSearch: true }, createdAt: 0,
  } as AgentDef;

  await engine.takeTurn(old, "c1", trigger);

  assert.deepEqual(sent, ["the answer"], "one turn, one answer, no card, no extra sentence");
  assert.equal(spy.seen.length, 1);
  assert.equal(spy.seen[0]?.planOnly, undefined);
  assert.equal(spy.seen[0]?.maxBudgetUsd, undefined);
  assert.equal(engine.lastRun?.outcome, "ok");
  assert.equal(engine.lastRun?.capStop, undefined);
  assert.equal(engine.lastRun?.fellBackTo, undefined);
  assert.equal(engine.lastRun?.planOnly, undefined);

  const args = claudeArgs(old, []);
  assert.ok(!args.includes("--max-budget-usd"));
  assert.ok(!args.includes("--fallback-model"));
  assert.equal(args[args.indexOf("--permission-mode") + 1], "dontAsk");
});

test("a run record still survives the round trip with the new facts on it", () => {
  const record: RunRecord = buildRunRecord(seed(), {
    finishedAt: Date.now() + 10, outcome: "failed", error: "reached its limit",
    capStop: { which: "perJob", capUsd: 0.5 }, fellBackTo: "claude-haiku-4-5", planOnly: true,
  });
  const dir = tmp();
  const store = new RunStore({ agentDataDir: () => path.join(dir, "a1") });
  assert.ok(store.save(record));
  const back = store.read("a1", record.id);
  assert.deepEqual(back?.capStop, { which: "perJob", capUsd: 0.5 });
  assert.equal(back?.fellBackTo, "claude-haiku-4-5");
  assert.equal(back?.planOnly, true);
});

test("the spend error carries plain words all the way to what an agent would say", () => {
  const err = new SpendCapReachedError("perMonth", 5, "this agent reached its $5.00 limit");
  assert.equal(err.which, "perMonth");
  assert.equal(err.capUsd, 5);
  assert.match(err.message, /\$5\.00/);
});
