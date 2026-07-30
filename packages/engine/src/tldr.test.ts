// HIS ITEM 3: "when a job finishes, say so and summarise it", and he agreed the
// AGENT should write the summary.
//
// The two rules these tests exist to hold:
//  • the words are the agent's own, taken from what it reported back;
//  • no number appears that the run record did not measure, and when there is
//    nothing honest to say there is NO summary rather than a filler sentence.
import test from "node:test";
import assert from "node:assert/strict";
import { RunRecord, TASK_LIMITS } from "@cloud9/shared";
import { buildRunRecord } from "./runrecord.js";
import { headlineOf, taskTldr } from "./tldr.js";

/** A real record from the engine's own builder — not a hand-written literal. */
function record(over: Partial<RunRecord> = {}): RunRecord {
  const built = buildRunRecord(
    {
      kind: "task", agentId: "a1", agentName: "Scout", provider: "claude",
      taskId: "t1", requestedBy: "Vikas", requestedByKind: "human",
      ask: "check the villa listings", startedAt: 1_000,
    },
    { finishedAt: 42_000, outcome: "ok", reply: "done" },
    "r-000000abc-0001",
  );
  return { ...built, ...over };
}

const steps = (...kinds: RunRecord["steps"][number]["kind"][]): RunRecord["steps"] =>
  kinds.map((kind, i) => ({ seq: i + 1, kind, label: `did ${kind}` }));

// ---------------------------------------------------------------- the words

test("the summary opens with the agent's OWN first sentence", () => {
  const out = taskTldr(record({ steps: steps("web", "write") }),
    "I found three villas under your budget. The cheapest is in Assagao, and it is free in March.");
  assert.ok(out);
  assert.match(out, /^I found three villas under your budget\./);
});

test("markdown is stepped over, not quoted back at him", () => {
  assert.equal(headlineOf("## Result\n\n- **All 12 tests pass** now."), "All 12 tests pass now.");
  assert.equal(headlineOf("```\nnpm test\n```\nThe suite is green."), "The suite is green.");
  assert.equal(headlineOf("1. Fixed the crash."), "Fixed the crash.");
});

test("nothing but code or whitespace leaves no headline at all", () => {
  assert.equal(headlineOf("```\nnpm test\n```"), undefined);
  assert.equal(headlineOf("   \n\n  "), undefined);
  assert.equal(headlineOf(undefined), undefined);
});

// ------------------------------------------------------------- the evidence

test("what it DID comes from counted steps, never from the words", () => {
  const out = taskTldr(record({ steps: steps("read", "read", "write", "command") }), "All done.");
  assert.ok(out);
  assert.match(out, /read 2 files/i);
  assert.match(out, /wrote 1 file/);
  assert.match(out, /ran 1 command/);
  assert.match(out, /took 41 seconds/, "the clock is the one figure Cloud9 measures itself");
});

test("a figure the CLI never reported does not appear", () => {
  const out = taskTldr(record({ steps: steps("read") }), "Read it.");
  assert.ok(out);
  assert.doesNotMatch(out, /cost/, "Codex reports no cost, so no cost may be shown");
  // and when the CLI DID report one, it shows
  const paid = taskTldr(record({ steps: steps("read"), usage: { costUsd: 0.42 } }), "Read it.");
  assert.match(paid ?? "", /cost 42 cents/);
});

// --------------------------------------------------------------- absence

test("a job with no words and nothing recorded gets NO summary", () => {
  assert.equal(taskTldr(record({ steps: [] }), ""), undefined,
    "silence is the honest answer — never a sentence that means nothing");
  assert.equal(taskTldr(record({ steps: [] }), undefined), undefined);
});

test("a cancelled job gets no summary — its status already says it", () => {
  assert.equal(
    taskTldr(record({ outcome: "cancelled", steps: steps("read") }), "I was part way through."),
    undefined);
});

test("a failed job says what went wrong, using the reason already redacted", () => {
  const out = taskTldr(record({
    outcome: "failed", error: "the Claude app isn't signed in", steps: [],
  }), undefined);
  assert.ok(out);
  assert.match(out, /Didn't finish/);
  assert.match(out, /the Claude app isn't signed in/);
});

// ----------------------------------------------------------------- the cap

test("the summary always fits what the hub will accept", () => {
  const out = taskTldr(record({ steps: steps("read") }), `${"a very long sentence ".repeat(80)}.`);
  assert.ok(out);
  assert.ok(out.length <= TASK_LIMITS.summary, `${out.length} must fit ${TASK_LIMITS.summary}`);
});
