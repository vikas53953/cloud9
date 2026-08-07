// CAN A READER TELL A REBUILT FIGURE FROM A REPORTED ONE — AND WHAT HAPPENS
// WHEN THE CONVENTION WE ASSUMED IS WRONG?
//
// Both halves matter, and the second is the sharper one. `handedToItOf` rebuilds
// older records from each app's documented accounting, and the whole rebuild
// rests on ONE fact taken off the record: `provider`. If that fact is wrong the
// answer is wrong by the size of an entire cache — silently, with nothing on
// screen to hint at it.
//
// A reconstructed number presented with the confidence of a measured one is
// precisely the class of failure this feature was built to catch. It does not
// stop being that when it is Cloud9 doing it to itself, so it is tested as
// hostilely as anything else here.
import test from "node:test";
import assert from "node:assert/strict";
import {
  findWaste, handedToItOf, renderTokenUseReport, rollUpTokenUse,
} from "./tokenuse.js";
import { REAL_RUNS } from "./fixtures/real-runs.js";

test("every figure says which of the two it is — there is no third, quiet answer", () => {
  assert.equal(handedToItOf({ handedToIt: 500 }, "claude")?.how, "reported");
  assert.equal(handedToItOf({ inputTokens: 4, cachedInputTokens: 90 }, "claude")?.how, "rebuilt");
  assert.equal(handedToItOf({ inputTokens: 90, cachedInputTokens: 4 }, "codex")?.how, "rebuilt");
  // and a figure that cannot be had at all is absent, never a confident zero
  assert.equal(handedToItOf({ outputTokens: 10 }, "claude"), undefined);
});

test("a wrong provider cannot silently inflate a Codex agent — the rebuild refuses", () => {
  // THE FAILURE THIS GUARD IS FOR. Under Codex's accounting the cache is a PART
  // of the total, so `cached > input` is not unlikely — it is arithmetically
  // impossible. A record reaching the Codex branch with those figures is either
  // not a Codex run or is corrupt, and both mean the same thing: we do not know.
  assert.equal(handedToItOf({ inputTokens: 2, cachedInputTokens: 13_899 }, "codex"), undefined,
    "this is a Claude shape. Read as Codex it would report 2 tokens and be believed.");
  // the honest case still answers
  assert.deepEqual(handedToItOf({ inputTokens: 50_710, cachedInputTokens: 24_320 }, "codex"),
    { tokens: 50_710, how: "rebuilt" });
  // and a Codex run with no cache figure at all is fine — nothing to contradict
  assert.deepEqual(handedToItOf({ inputTokens: 50_710 }, "codex"),
    { tokens: 50_710, how: "rebuilt" });
});

test("the guard really separates the two, measured on his own 185 records", () => {
  // A rule that never fires is not a safeguard, it is decoration. On his real
  // history every Codex run satisfies it and most Claude runs violate it, so it
  // is a genuine discriminator rather than a formality.
  let codexHolds = 0, claudeWouldViolate = 0;
  for (const r of REAL_RUNS) {
    const i = r.usage?.inputTokens, c = r.usage?.cachedInputTokens;
    if (i === undefined || c === undefined) continue;
    if (r.provider === "codex") { assert.ok(c <= i, "a real Codex run broke its own convention"); codexHolds++; }
    else if (c > i) claudeWouldViolate++;
  }
  assert.equal(codexHolds, 69);
  assert.equal(claudeWouldViolate, 84,
    "84 real Claude runs would be caught if ever mislabelled as Codex");
});

test("the roll-up counts rebuilt turns so a screen can say so", () => {
  const mixed = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", period: "everythingKept",
    runs: [
      { startedAt: 1, provider: "claude", outcome: "ok", usage: { handedToIt: 100, outputTokens: 5 } },
      { startedAt: 2, provider: "claude", outcome: "ok", usage: { inputTokens: 4, cachedInputTokens: 96, outputTokens: 5 } },
    ],
  });
  assert.equal(mixed.runsWithSize, 2);
  assert.equal(mixed.runsWithRebuiltSize, 1, "one of the two had to be worked out");
  assert.equal(mixed.sentToIt, 200, "and both still count towards the total");
});

test("an AGENT is told which figures were rebuilt, not just the screen", () => {
  // An agent handed reconstructed numbers with no flag will repeat them to the
  // owner as measured — the same overclaim a screen would be making, except he
  // has no way at all to check a sentence an agent said.
  const use = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", period: "everythingKept",
    runs: REAL_RUNS.filter(r => r.agentName === "Fable5"),
  });
  assert.ok(use.runsWithRebuiltSize > 0);
  const text = renderTokenUseReport([{ use, findings: findWaste({ use, agent: {} }) }], "thisMonth");
  assert.match(text, /predate Cloud9 recording this figure directly/);
  assert.match(text, /Say so if you quote them/);
});

test("when nothing had to be rebuilt, nothing is said about rebuilding", () => {
  // The disclosure has to be absent when it does not apply, or it becomes noise
  // and stops being read on the runs where it matters.
  const use = rollUpTokenUse({
    agentId: "a1", agentName: "Scout", provider: "claude", period: "everythingKept",
    runs: Array.from({ length: 4 }, (_, i) => ({
      startedAt: i + 1, provider: "claude", outcome: "ok" as const,
      usage: { handedToIt: 90_000, outputTokens: 300, costUsd: 1 },
    })),
  });
  assert.equal(use.runsWithRebuiltSize, 0);
  const text = renderTokenUseReport([{ use, findings: findWaste({ use, agent: {} }) }], "thisMonth");
  assert.doesNotMatch(text, /predate Cloud9/);
});
