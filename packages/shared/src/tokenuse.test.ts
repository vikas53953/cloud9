// WHAT THIS FILE IS DEFENDING, in the order it matters.
//
// The whole feature is a claim that Cloud9 will tell the owner the truth about
// his own money. Every test below is a way that claim could quietly become
// false, written down before it does:
//
//  1. A ZERO THAT NOBODY REPORTED. Codex reports no cost at all. If a Codex
//     agent ever shows "$0.00" he will read it as "this one is free" and move
//     all his work onto it. That is the single most expensive lie this feature
//     could tell, so it is the first test in the file.
//  2. A TOTAL THAT LOOKS COMPLETE AND IS NOT. Half the runs reporting a figure
//     and half not must never add up to a confident-looking number with no
//     count beside it.
//  3. A SUGGESTION THAT COULD WIDEN SOMETHING. `SavingChange` is a closed list
//     of two, and the argument for letting agents propose changes at all rests
//     entirely on it staying closed. Anything else is refused.
//  4. A FINDING WITH NO WORKING SHOWN. Every finding has to carry the counted
//     facts it came from, or he is being told to change something on trust.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentDef, APPROVAL_LIMITS, SPEND_CAP_LIMITS } from "./index.js";
import {
  CountableRun, ENOUGH_RUNS_TO_JUDGE, SAVING_LIMITS, applySaving, dearestFirst,
  describeChangeForAgent, findWaste, humanTextSize, moneyWords, narrowingOnly,
  renderTokenUseReport, rollUpTokenUse, savingDetail, savingHeadline, sentVsWrote,
  suggestedMonthlyLimit, tidySaving, validateSavingProposal,
} from "./tokenuse.js";

// ------------------------------------------------------------------ fixtures

const AUG = Date.UTC(2026, 7, 3, 12, 0, 0);   // 3 August 2026
const JUL = Date.UTC(2026, 6, 3, 12, 0, 0);   // 3 July 2026 — the month before
const NOW = Date.UTC(2026, 7, 7, 12, 0, 0);

function run(over: Partial<CountableRun> = {}): CountableRun {
  return { startedAt: AUG, provider: "claude", outcome: "ok", ...over };
}

function claudeAgent(over: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "a1", ownerId: "u1", name: "Scout", provider: "claude",
    persona: "helps", createdAt: 0, ...over,
  } as AgentDef;
}

// ===========================================================================
// 1. THE ZERO THAT NOBODY REPORTED
// ===========================================================================

test("a Codex agent NEVER shows $0.00 — it says nobody reported a cost", () => {
  const use = rollUpTokenUse({
    agentId: "a2", agentName: "Codey", provider: "codex", now: NOW,
    runs: [run({ provider: "codex" }), run({ provider: "codex" }), run({ provider: "codex" })],
  });
  assert.equal(use.reportsCost, false);
  assert.equal(use.costUsd, undefined,
    "absent is absent — a Codex total must never exist, not even as 0");
  assert.equal(use.runs, 3, "its turns are still counted; it is the MONEY that is unknown");
  const words = moneyWords(use);
  assert.match(words, /Codex doesn't report/);
  assert.doesNotMatch(words, /\$0/, "showing $0 would read as 'this one is free'");
});

test("and the report says so out loud, with the reason", () => {
  const use = rollUpTokenUse({
    agentId: "a2", agentName: "Codey", provider: "codex", now: NOW,
    runs: [run({ provider: "codex" }), run({ provider: "codex" })],
  });
  const findings = findWaste({ use, agent: { } });
  const honest = findings.find(f => f.id === "noCostReported");
  assert.ok(honest, "an agent whose app reports nothing must SAY that, not go quiet");
  assert.ok(honest.evidence.some(e => e.includes("$0.00")),
    "it explains why no zero is shown, which is the whole point of the row");
  assert.equal(honest.change, undefined, "there is nothing to propose about it");
});

test("a Claude agent that simply has not been costed yet is a THIRD answer", () => {
  const use = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: [run({ usage: {} })],
  });
  assert.equal(use.reportsCost, true, "the app CAN report; it just did not this time");
  assert.equal(use.costUsd, undefined);
  assert.match(moneyWords(use), /no turn reported a cost/);
});

// ===========================================================================
// 2. A TOTAL THAT LOOKS COMPLETE AND IS NOT
// ===========================================================================

test("a total always arrives with the count it was summed from", () => {
  const use = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: [
      run({ usage: { costUsd: 1.5 } }),
      run({ usage: { costUsd: 0.5 } }),
      run({ usage: {} }),               // this one told us nothing
      run(),                            // and neither did this one
    ],
  });
  assert.equal(use.runs, 4);
  assert.equal(use.runsWithCost, 2);
  assert.equal(use.costUsd, 2);
  assert.match(moneyWords(use), /2 of 4 turns \(the rest reported nothing\)/,
    "the shortfall has to be on the screen, not only in the object");
});

test("nonsense figures are dropped, never folded in as zero", () => {
  const use = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: [
      run({ usage: { costUsd: 2 } }),
      run({ usage: { costUsd: -5 } }),
      run({ usage: { costUsd: Number.NaN } }),
      run({ usage: { costUsd: Number.POSITIVE_INFINITY } }),
    ],
  });
  assert.equal(use.costUsd, 2, "one usable figure, and only one counted");
  assert.equal(use.runsWithCost, 1, "and the count admits the other three said nothing usable");
});

test("last month's turns are not in this month's total", () => {
  const use = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: [run({ usage: { costUsd: 1 } }), run({ startedAt: JUL, usage: { costUsd: 99 } })],
  });
  assert.equal(use.costUsd, 1);
  assert.equal(use.runs, 1);

  const all = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    period: "everythingKept",
    runs: [run({ usage: { costUsd: 1 } }), run({ startedAt: JUL, usage: { costUsd: 99 } })],
  });
  assert.equal(all.costUsd, 100, "the other window really does widen it");
});

test("the two halves of a bill are told apart, and only when both were reported", () => {
  const use = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: [
      run({ usage: { inputTokens: 30_000, outputTokens: 500 } }),
      run({ usage: { inputTokens: 30_000, outputTokens: 500 } }),
    ],
  });
  const split = sentVsWrote(use)!;
  assert.ok(split.sentShare > 0.98, "this is the shape the whole feature exists to show");

  const blind = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: [run({ usage: { costUsd: 1 } })],
  });
  assert.equal(sentVsWrote(blind), undefined, "no sizes reported, so no split is drawn at all");
});

test("what he is sent is said in pages, never in the app's own word for it", () => {
  assert.equal(humanTextSize(0), "nothing");
  assert.match(humanTextSize(30_213), /about 42 pages/);
  assert.match(humanTextSize(100), /less than a page/);
  for (const size of [0, 100, 7_111, 30_213, 1_000_000]) {
    assert.doesNotMatch(humanTextSize(size), /token/i,
      "'token' is not a word on his screen");
  }
});

test("agents that report nothing sort BELOW every real figure, never as cheapest", () => {
  const rows = [
    rollUpTokenUse({ agentId: "c", agentName: "Codey", provider: "codex", now: NOW, runs: [run({ provider: "codex" })] }),
    rollUpTokenUse({ agentId: "a", agentName: "Scout", provider: "claude", now: NOW, runs: [run({ usage: { costUsd: 5 } })] }),
    rollUpTokenUse({ agentId: "b", agentName: "Pip", provider: "claude", now: NOW, runs: [run({ usage: { costUsd: 0.01 } })] }),
  ];
  assert.deepEqual(dearestFirst(rows).map(r => r.agentName), ["Scout", "Pip", "Codey"],
    "an unknown cost must not be able to look like the cheap one");
});

// ===========================================================================
// 3. A SUGGESTION THAT COULD WIDEN SOMETHING
// ===========================================================================

test("the list of changes an agent may propose is CLOSED — everything else is refused", () => {
  assert.ok(narrowingOnly({ what: "stopUsingOwnerSetup" }));
  assert.ok(narrowingOnly({ what: "setMonthlyLimit", perMonthUsd: 25 }));

  for (const attempt of [
    { what: "startUsingOwnerSetup" },
    { what: "setTrust", trust: "anything" },
    { what: "stopUsingOwnerSetup", andAlso: { abilities: ["wholeComputer"] } },
    { what: "setMonthlyLimit", perMonthUsd: 0 },
    { what: "setMonthlyLimit", perMonthUsd: -10 },
    { what: "setMonthlyLimit", perMonthUsd: "lots" },
    { what: "setMonthlyLimit" },
    { what: "setMonthlyLimit", perMonthUsd: 5, alsoTrust: "full" },
    "stopUsingOwnerSetup", null, undefined, [], 42,
  ]) {
    assert.equal(narrowingOnly(attempt), false,
      `this must never be accepted: ${JSON.stringify(attempt)}`);
  }
});

test("applying a change touches exactly one setting and can only narrow", () => {
  const agent = claudeAgent({
    useOwnerSetup: true,
    abilities: { webSearch: true, files: true, schedules: false, background: false },
    trust: "askEveryTime",
    spendCap: { perJobUsd: 3 },
  });

  const off = applySaving(agent, { what: "stopUsingOwnerSetup" })!;
  assert.equal(off.useOwnerSetup, false);
  assert.deepEqual(off.abilities, agent.abilities, "abilities are untouched");
  assert.equal(off.trust, agent.trust, "trust is untouched");
  assert.deepEqual(off.spendCap, agent.spendCap, "the spending limit is untouched");

  const capped = applySaving(agent, { what: "setMonthlyLimit", perMonthUsd: 20 })!;
  assert.deepEqual(capped.spendCap, { perJobUsd: 3, perMonthUsd: 20 },
    "the per-job ceiling he already set survives; only the monthly one is added");
  assert.equal(capped.useOwnerSetup, true, "and the setup switch is untouched");
});

test("a change the closed list does not recognise cannot be applied at all", () => {
  const agent = claudeAgent({ useOwnerSetup: true });
  // deliberately cast: this is the shape that would arrive if something got past
  // the wire check, and it still has to be refused HERE
  assert.equal(applySaving(agent, { what: "grantEverything" } as never), undefined);
});

test("a proposal with no reason is refused — a change with no why is not approvable", () => {
  const base = { about: "a1", aboutName: "Scout", change: { what: "stopUsingOwnerSetup" } };
  assert.equal(validateSavingProposal({ ...base, because: "it costs 300x what it needs to" }), null);
  assert.match(String(validateSavingProposal({ ...base, because: "   " })), /doesn't say why/);
  assert.match(String(validateSavingProposal({ ...base, about: "" })), /which agent/);
  assert.match(String(validateSavingProposal({ ...base, aboutName: "" })), /name the agent/);
  assert.match(
    String(validateSavingProposal({ ...base, change: { what: "setTrust" }, because: "x" })),
    /isn't a change Cloud9 knows how to make/);
  assert.ok(validateSavingProposal("just some text"));
});

test("the agent's own words are stripped and bounded before they reach a card", () => {
  assert.equal(tidySaving("  it   is\n\nexpensive  "), "it is expensive");
  assert.equal(tidySaving("a b​c"), "abc", "control and zero-width marks go");
  assert.equal(tidySaving(42), "", "not a string is not a reason");
  const long = tidySaving("x".repeat(SAVING_LIMITS.because + 500));
  assert.equal(long.length, SAVING_LIMITS.because);
  assert.ok(long.endsWith("…"));
});

test("the card's words name the agent and say what he loses, in plain words", () => {
  const off = savingHeadline({ about: "a1", aboutName: "Scout", because: "x", change: { what: "stopUsingOwnerSetup" } });
  assert.match(off, /Scout/);
  const detail = savingDetail({ about: "a1", aboutName: "Scout", because: "x", change: { what: "stopUsingOwnerSetup" } });
  assert.match(detail, /switch it back on any time/, "a change he cannot undo is not a suggestion");
  for (const words of [off, detail]) {
    assert.doesNotMatch(words, /token|context window|prompt cache|useOwnerSetup|spendCap/i,
      "no jargon and no field names on his card");
  }
  const cap = savingHeadline({ about: "a1", aboutName: "Scout", because: "x", change: { what: "setMonthlyLimit", perMonthUsd: 20 } });
  assert.match(cap, /\$20/, "the amount he is being asked to agree to is IN the question");
});

test("the card's words FIT ON THE CARD — the undo sentence must never be cut off", () => {
  // CAUGHT BY THE END-TO-END TEST, NOT BY A UNIT TEST. The hub trims `detail`
  // to `APPROVAL_LIMITS.detail`, the first draft ran past it, and the sentence
  // that got cut was "you can switch it back on any time" — the one sentence
  // that makes a change safe to say yes to. This is the class fix: every
  // headline and every detail, for every change, checked against the real caps.
  for (const change of [
    { what: "stopUsingOwnerSetup" },
    { what: "setMonthlyLimit", perMonthUsd: 25 },
    { what: "setMonthlyLimit", perMonthUsd: SPEND_CAP_LIMITS.maxUsd },
  ] as const) {
    const p = { about: "a1", aboutName: "Scout", because: "x", change };
    const detail = savingDetail(p);
    assert.ok(detail.length <= APPROVAL_LIMITS.detail,
      `the detail for ${change.what} is ${detail.length} — the card only carries `
      + `${APPROVAL_LIMITS.detail}, so the end of it would be cut off`);
    assert.match(detail, /any time/, "how to undo it must survive the cap");
    assert.ok(savingHeadline(p).length <= APPROVAL_LIMITS.action,
      `the headline for ${change.what} would be cut off`);
  }
});

test("a suggested limit has real room in it — it must not fire the same afternoon", () => {
  assert.equal(suggestedMonthlyLimit(12.34), 25);
  assert.equal(suggestedMonthlyLimit(0.01), 1, "never below a dollar");
  assert.equal(suggestedMonthlyLimit(0), 1);
  assert.ok(suggestedMonthlyLimit(50) > 50, "a limit at what he already spent is a limit that has already fired");
});

// ===========================================================================
// 4. A FINDING WITH NO WORKING SHOWN
// ===========================================================================

test("every finding carries the counted facts it came from", () => {
  const use = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: [
      run({ ownerSetup: true, usage: { costUsd: 1.75, inputTokens: 87_498, outputTokens: 120 } }),
      run({ ownerSetup: true, usage: { costUsd: 1.60, inputTokens: 80_000, outputTokens: 90 } }),
      run({ ownerSetup: true, usage: { costUsd: 1.80, inputTokens: 90_000, outputTokens: 140 } }),
    ],
  });
  const findings = findWaste({ use, agent: { useOwnerSetup: true } });
  assert.ok(findings.length > 0);
  for (const f of findings) {
    assert.ok(f.evidence.length > 0, `${f.id} tells him to act with nothing to back it`);
    assert.ok(f.headline.includes("Scout"), `${f.id} does not say which agent it is about`);
    assert.doesNotMatch(f.headline + f.evidence.join(" "), /token|context window|prompt cache/i);
  }
});

test("the 318x switch is named as the problem, not merely measured", () => {
  // THIS TEST USED TO ENCODE THE BUG IT WAS MEANT TO CATCH. It handed the
  // finding ONE run and asserted it fired — so it was the reason nobody noticed
  // that this finding alone skipped `ENOUGH_RUNS_TO_JUDGE`, and it went green
  // while the app told the owner to change a setting on the strength of a
  // single turn. It now uses enough turns to be a habit, which is what the
  // sentence it is checking actually claims.
  const use = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: Array.from({ length: ENOUGH_RUNS_TO_JUDGE }, () => run({
      ownerSetup: true,
      usage: { costUsd: 1.75, inputTokens: 4, cachedInputTokens: 87_000, outputTokens: 120 },
    })),
  });
  const f = findWaste({ use, agent: { useOwnerSetup: true } })
    .find(x => x.id === "ownerSetupOnEveryTurn")!;
  assert.ok(f, "the single most expensive setting on this machine has to be findable");
  assert.deepEqual(f.change, { what: "stopUsingOwnerSetup" });
  // WHAT IT SAYS ABOUT HIS AGENT IS MEASURED ON HIS AGENT. The 318x came off a
  // different agent on a different day, so it is no longer allowed to sit among
  // counted facts about this one — it goes in `reference`, attributed.
  assert.ok(f.evidence.every(e => !/318/.test(e)));
  assert.match(String(f.reference), /318 times/);
  assert.match(String(f.reference), /measured on another agent, not on this one/);
  assert.match(f.evidence.join(" "), /handed .* of material per turn/,
    "and the fact about THIS agent is how much it is really handed");
});

test("when the agent has run BOTH ways, its own figures win over the general ones", () => {
  const use = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: [
      run({ ownerSetup: true, usage: { costUsd: 2.00 } }),
      run({ ownerSetup: true, usage: { costUsd: 2.00 } }),
      run({ ownerSetup: false, usage: { costUsd: 0.10 } }),
    ],
  });
  const f = findWaste({ use, agent: { useOwnerSetup: true } })
    .find(x => x.id === "ownerSetupOnEveryTurn")!;
  const said = f.evidence.join(" ");
  assert.match(said, /20 times cheaper/, "measured on HIS agent, on HIS work");
  assert.doesNotMatch(said, /318/, "a real local comparison replaces the borrowed one");
  assert.match(String(f.worth), /\$3\.8/, "and it says what the change would have been worth");
});

test("nothing is suggested about a setting that is already the way it should be", () => {
  const use = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: [run({ ownerSetup: false, usage: { costUsd: 0.10 } })],
  });
  const ids = findWaste({ use, agent: { useOwnerSetup: false } }).map(f => f.id);
  assert.ok(!ids.includes("ownerSetupOnEveryTurn"), "it is already off");
});

test("a spending limit is only suggested where one can actually be set", () => {
  const codex = rollUpTokenUse({
    agentId: "a2", agentName: "Codey", provider: "codex", now: NOW,
    runs: Array.from({ length: 10 }, () => run({ provider: "codex" })),
  });
  const ids = findWaste({ use: codex, agent: {} }).map(f => f.id);
  assert.ok(!ids.includes("noSpendingLimit"),
    "offering a Codex agent a ceiling would be offering a box that does nothing");

  const already = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: Array.from({ length: 5 }, () => run({ usage: { costUsd: 1 } })),
  });
  assert.ok(!findWaste({ use: already, agent: { spendCap: { perMonthUsd: 50 } } })
    .some(f => f.id === "noSpendingLimit"), "he already set one");
});

test("one expensive turn is not a habit — a pattern needs enough turns to be one", () => {
  const thin = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: [run({ usage: { costUsd: 9, inputTokens: 99_000, outputTokens: 10 } })],
  });
  assert.ok(ENOUGH_RUNS_TO_JUDGE > 1);
  const ids = findWaste({ use: thin, agent: {} }).map(f => f.id);
  assert.ok(!ids.includes("mostlyWhatItIsSent"));
  assert.ok(!ids.includes("noSpendingLimit"));
  assert.ok(!ids.includes("ownerSetupOnEveryTurn"),
    "this one skipped the guard and fired on a single turn — the screenshot taken to "
    + "prove the feature working is what caught it");
});

// ===========================================================================
// WHAT AN AGENT IS TOLD — the same sentences, never a private version
// ===========================================================================

test("the agent's report says it cannot change anything itself", () => {
  const use = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: [run({ ownerSetup: true, usage: { costUsd: 1.75, inputTokens: 87_000, outputTokens: 100 } })],
  });
  const text = renderTokenUseReport(
    [{ use, findings: findWaste({ use, agent: { useOwnerSetup: true } }) }], "thisMonth");
  assert.match(text, /Scout/);
  assert.match(text, /cannot change any of these settings yourself/,
    "an agent that thinks it can edit another agent will try");
  assert.match(text, /propose_saving/, "and it is told the one thing it CAN do");
  assert.match(text, /not estimates/);
});

test("no runs at all is a real answer, and it says so rather than inventing one", () => {
  assert.match(renderTokenUseReport([], "thisMonth"), /nothing to say about spending yet/);
});

test("the report offers the exact argument the tool takes, so a suggestion is actionable", () => {
  assert.equal(describeChangeForAgent({ what: "stopUsingOwnerSetup" }), `"stopUsingOwnerSetup"`);
  assert.match(describeChangeForAgent({ what: "setMonthlyLimit", perMonthUsd: 25 }), /perMonthUsd 25/);
});
