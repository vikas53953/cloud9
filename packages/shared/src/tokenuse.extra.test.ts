// THE THREE THINGS REVIEW FOUND THAT WERE NOT ABOUT THE TOKEN COUNT.
//
// Each was an app saying something to the owner that it could not back up, and
// each is here rather than in `tokenuse.test.ts` because each names a specific
// sentence that used to reach him and now cannot.
import test from "node:test";
import assert from "node:assert/strict";
import { CountableRun, findWaste, rollUpTokenUse } from "./tokenuse.js";

const NOW = Date.UTC(2026, 7, 7, 12, 0, 0);
const AUG = Date.UTC(2026, 7, 3, 12, 0, 0);

function run(over: Partial<CountableRun> = {}): CountableRun {
  return { startedAt: AUG, provider: "claude", outcome: "ok", ...over };
}

test("a suggested ceiling is never below what the month has REALLY cost", () => {
  // The roll-up can only see runs still on disk. `spentInMonth` also counts
  // money carried forward from runs since pruned — and that is the figure
  // `decideSpend` will actually judge the ceiling by. A limit built on the
  // smaller number is a limit that fires the same afternoon, on a card that
  // promised him the opposite.
  const use = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: Array.from({ length: 5 }, () => run({ usage: { costUsd: 1 } })),
  });
  assert.equal(use.costUsd, 5, "five dollars is all the roll-up can see");

  const blind = findWaste({ use, agent: {} }).find(f => f.id === "noSpendingLimit")!;
  assert.deepEqual(blind.change, { what: "setMonthlyLimit", perMonthUsd: 10 });

  // …but $40 of this month is already gone with runs that have been pruned
  const knowing = findWaste({ use, agent: {}, spentThisMonthUsd: 40 })
    .find(f => f.id === "noSpendingLimit")!;
  const cap = knowing.change as { what: "setMonthlyLimit"; perMonthUsd: number };
  assert.ok(cap.perMonthUsd > 40,
    `suggested $${cap.perMonthUsd} against $40 already spent — it would stop the agent at once`);
  assert.match(knowing.evidence[0]!, /\$40/, "and the evidence quotes the figure it used");
});

test("the app no longer accuses an agent of something it cannot tell apart", () => {
  // `nothingReused` said "paying full price for the same material every turn"
  // whenever the cache-read figure came out at zero — which is ALSO exactly
  // what an agent writing the cache looks like, and what every record predating
  // `cacheWriteTokens` looks like regardless of what really happened. It was
  // deleted rather than re-tuned: the fix for an accusation the app cannot
  // support is silence, not a better threshold.
  const use = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: Array.from({ length: 8 }, () => run({
      usage: { inputTokens: 30_000, outputTokens: 200, cachedInputTokens: 0 },
    })),
  });
  const said = findWaste({ use, agent: {} })
    .flatMap(f => [f.headline, ...f.evidence]).join(" ");
  assert.doesNotMatch(said, /paying full price/,
    "an accusation the app cannot support must not be made at all");
});

test("the owner-setup finding obeys the same 'enough turns' guard as every other", () => {
  // It did not, and the screenshot taken to prove the feature working is what
  // caught it: the finding was raised on 1 of 1 turn, which had no reported
  // cost at all, while quoting a hard-coded 318x figure measured on a different
  // agent as its evidence.
  const one = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: [run({ ownerSetup: true })],
  });
  assert.ok(!findWaste({ use: one, agent: { useOwnerSetup: true } })
    .some(f => f.id === "ownerSetupOnEveryTurn"),
    "one turn is not a habit");

  const enough = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", now: NOW,
    runs: Array.from({ length: 4 }, () => run({
      ownerSetup: true,
      usage: { inputTokens: 4, cachedInputTokens: 80_000, outputTokens: 150, costUsd: 1.6 },
    })),
  });
  const f = findWaste({ use: enough, agent: { useOwnerSetup: true } })
    .find(x => x.id === "ownerSetupOnEveryTurn")!;
  assert.ok(f, "four turns of the same habit is a habit");
  // and the borrowed number is out of `evidence` and attributed where it lands
  assert.ok(f.evidence.every(e => !/318/.test(e)));
  assert.match(String(f.reference), /measured on another agent, not on this one/);
  assert.match(f.evidence.join(" "), /pages of material per turn/,
    "what it says about THIS agent is measured on this agent");
});
