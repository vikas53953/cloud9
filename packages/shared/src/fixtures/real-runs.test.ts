// THE TESTS THAT WOULD HAVE CAUGHT IT ON DAY ONE.
//
// `tokenuse.test.ts` is hand-written from end to end, and every hand-written
// fixture in it agreed with a token count that was wrong by two to three orders
// of magnitude — because nobody hand-writes a Claude usage shape with a cache
// in it. `{ inputTokens: 30_000, outputTokens: 500 }` reads as obviously
// correct; the real shape is `{ inputTokens: 2, cachedInputTokens: 13_899 }`.
// The tests agreed with the code because both were written by somebody holding
// the same wrong idea about what `inputTokens` means.
//
// So this file asks a different question. Not "does the arithmetic do what I
// meant" but "does it produce TRUE STATEMENTS about runs that really happened",
// against 185 records the owner's own agents produced on this machine.
import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentTokenUse, findWaste, handedToItOf, rollUpTokenUse, sentVsWrote,
} from "../tokenuse.js";
import { REAL_RUNS } from "./real-runs.js";

/** His agents, rolled up over everything kept, exactly as a screen would. */
function realUse(agentName: string): AgentTokenUse {
  const runs = REAL_RUNS.filter(r => r.agentName === agentName);
  assert.ok(runs.length > 0, `no real runs for ${agentName}`);
  return rollUpTokenUse({
    agentId: agentName, agentName, provider: runs[0]!.provider,
    period: "everythingKept", runs,
  });
}

function rawTotal(agentName: string, field: "inputTokens" | "cachedInputTokens"): number {
  return REAL_RUNS.filter(r => r.agentName === agentName)
    .reduce((n, r) => n + (r.usage?.[field] ?? 0), 0);
}

test("THE INVERSION: his dearest agent is 99% material handed to it, not 0%", () => {
  // The bug, stated as the number it produced. Fable5's `inputTokens` across 23
  // real turns total 84 — while 1,120,105 tokens of material really went up the
  // wire as cache reads. Summing `inputTokens` drew that as "0% handed to it,
  // 100% written back", the exact opposite of the truth, and left
  // `mostlyWhatItIsSent` unable to fire on any Claude agent that has ever run.
  const fable = realUse("Fable5");
  assert.equal(fable.runs, 23);
  assert.ok(Math.abs((fable.costUsd ?? 0) - 7.79) < 0.01, "his dearest agent, at $7.79");
  assert.equal(rawTotal("Fable5", "inputTokens"), 84,
    "84 is what the old code thought this agent had been handed, in total, ever");

  const split = sentVsWrote(fable)!;
  assert.ok(split.sentShare > 0.95,
    `handed-to-it share came out at ${(split.sentShare * 100).toFixed(0)}% — it must be `
    + "over 95%. 0% is the bug this test exists for.");
  assert.ok(fable.sentToIt! > 1_000_000,
    `only ${fable.sentToIt} counted as handed over, against 1,120,105 real tokens`);
  assert.ok(findWaste({ use: fable, agent: {} }).some(f => f.id === "mostlyWhatItIsSent"),
    "the flagship waste finding never once fired on a Claude agent before this");
});

test("every one of his Claude agents is mostly material handed to it", () => {
  for (const [name, atLeast] of [["Opus", 0.9], ["sonnet", 0.95], ["Architect", 0.85]] as const) {
    const use = realUse(name);
    const split = sentVsWrote(use)!;
    assert.ok(split.sentShare >= atLeast,
      `${name} drew as ${(split.sentShare * 100).toFixed(0)}% handed over`);
  }
});

test("Codex is NOT double-counted — its input figure already includes its cache", () => {
  // THE MIRROR IMAGE OF THE CLAUDE BUG, and the whole reason this figure is
  // computed inside each provider's own mapper rather than once in shared.
  // Codex counts the way OpenAI does: `input_tokens` is the TOTAL and
  // `cached_input_tokens` is a part of it. Adding the two — the fix that works
  // for Claude — would inflate Sol by its 148,992 cached tokens.
  const sol = realUse("Sol");
  assert.ok(rawTotal("Sol", "cachedInputTokens") > 100_000,
    "Sol really does carry a large cache figure that could be double-counted");
  assert.equal(sol.sentToIt, rawTotal("Sol", "inputTokens"),
    "Codex's own total, once — never its total plus its cache again");
});

test("his real records all have to be REBUILT, and the roll-up says how many", () => {
  // Every stored run predates `handedToIt`, which is what makes this fixture a
  // test of the rebuilding path as a side effect of existing. The count is what
  // lets a screen say so, instead of implying every figure was reported at the
  // time it happened.
  const fable = realUse("Fable5");
  assert.equal(fable.runsWithRebuiltSize, fable.runsWithSize);
  assert.ok(REAL_RUNS.every(r => r.usage?.handedToIt === undefined),
    "if this fails the fixture has been regenerated and no longer proves the rebuild");
});

test("a provider that DID write the figure down is believed, never recomputed", () => {
  // Both mappers record it going forward. A stored figure must win outright:
  // rebuilding over the top of a reported one would put a derivation back where
  // there was a fact.
  assert.deepEqual(
    handedToItOf({
      inputTokens: 4, cachedInputTokens: 35_267, cacheWriteTokens: 35_418, handedToIt: 70_689,
    }, "claude"),
    { tokens: 70_689, how: "reported" });
  assert.deepEqual(
    handedToItOf({ inputTokens: 4, cachedInputTokens: 35_267, cacheWriteTokens: 35_418 }, "claude"),
    { tokens: 70_689, how: "rebuilt" },
    "and the rebuild agrees exactly with what the mapper would have written");
});

test("nothing is claimed where there is nothing to claim", () => {
  assert.equal(handedToItOf(undefined, "claude"), undefined);
  assert.equal(handedToItOf({}, "claude"), undefined);
  assert.equal(handedToItOf({ costUsd: 5 }, "claude"), undefined, "money is not a size");
  assert.equal(handedToItOf({ inputTokens: -5 }, "codex"), undefined, "nonsense is not zero");
});

test("no card contradicts itself: 'loads your whole setup' over 'less than a page'", () => {
  // THE SENTENCE THAT WAS ON HIS SCREEN. The owner-setup finding printed "loads
  // your whole Claude Code setup on every turn" directly above "less than a
  // page handed to it per turn" — a card arguing with itself, which is worse
  // than a card that says nothing.
  const use = rollUpTokenUse({
    agentId: "a1", agentName: "Fable5", provider: "claude", period: "everythingKept",
    runs: REAL_RUNS.filter(r => r.agentName === "Fable5").map(r => ({ ...r, ownerSetup: true })),
  });
  const f = findWaste({ use, agent: { useOwnerSetup: true } })
    .find(x => x.id === "ownerSetupOnEveryTurn")!;
  const said = f.evidence.join(" ");
  assert.match(said, /handed/);
  assert.doesNotMatch(said, /less than a page/,
    "an agent handed a million tokens a turn must never be described as handed a page");
  assert.ok(f.evidence.every(e => !/318/.test(e)),
    "a measurement of another agent does not belong among counted facts about this one");
  if (f.reference) assert.match(f.reference, /not on this one/);
});
