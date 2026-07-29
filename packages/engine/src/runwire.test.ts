// The run record as a WIRE type — one definition, shared by engine and relay.
//
// Every test in this file failed before the move: the shapes and the redaction
// rule lived inside `packages/engine`, so the relay could not reach them and
// the only way to give them to it would have been a second copy.
import test from "node:test";
import assert from "node:assert/strict";
import * as shared from "@cloud9/shared";
import {
  RUN_LIMITS, buildRunRecord, shareableRun, summarizeRun, redactForSharing,
} from "./runrecord.js";
import { CREDENTIAL_ENV_VARS, isCredentialVar } from "./env.js";

/** A real record, built by the engine's own builder, with fields overridden. */
function record(over: Partial<shared.RunRecord> = {}): shared.RunRecord {
  const built = buildRunRecord(
    {
      kind: "chat", agentId: "a1", agentName: "Scout", provider: "claude",
      requestedBy: "Vikas", requestedByKind: "human", ask: "find me a villa",
      startedAt: 1000,
    },
    { finishedAt: 42_000, outcome: "ok", reply: "here you go" },
    "r-000000abc-0001",
  );
  return { ...built, ...over };
}

// ---------------------------------------------------------------------------
// 1. ONE definition, not two copies that agree today
// ---------------------------------------------------------------------------

test("the engine and the wire share the SAME run-record vocabulary, not a copy", () => {
  // identity, not deep-equality: two object literals that happen to match are
  // exactly the drift this move exists to make impossible
  assert.equal(RUN_LIMITS, shared.RUN_LIMITS);
  assert.equal(shareableRun, shared.shareableRun);
  assert.equal(summarizeRun, shared.summarizeRun);
  assert.equal(redactForSharing, shared.redactForSharing);
  assert.equal(isCredentialVar, shared.isCredentialVar);
  assert.equal(CREDENTIAL_ENV_VARS, shared.CREDENTIAL_ENV_VARS);

  // and a record the engine builds IS a wire record — this line is the type
  // check, and it is what stops the two shapes parting company
  const built: shared.RunRecord = record();
  assert.equal(built.kind, "chat");
  assert.equal(built.durationMs, 41_000);
});

// ---------------------------------------------------------------------------
// 2. The redaction rule reaches the relay, and still redacts
// ---------------------------------------------------------------------------

test("the shared redactor keeps this computer's folders and account to itself", () => {
  shared.setMachineNames(["C:\\Users\\vikasmit", "vikasmit", "VIKAS-PC"]);
  try {
    const out = shared.redactForSharing(
      "Read C:\\Users\\vikasmit\\Documents\\notes\\villa.md for vikasmit");
    assert.match(out, /villa\.md/, "the file's own name is the point of the feature");
    assert.doesNotMatch(out, /vikasmit/i, "the account name must not travel");
    assert.doesNotMatch(out, /Documents/, "nor the folder layout");
    assert.doesNotMatch(out, /C:\\/, "nor the drive");
  } finally {
    shared.setMachineNames([]);
  }
});

test("a web address survives redaction — it says nothing about this computer", () => {
  const out = shared.redactForSharing("Fetched https://example.com/villas?page=2");
  assert.match(out, /https:\/\/example\.com\/villas\?page=2/);
});

test("a secret's value is blanked even when the whole record is shared", () => {
  shared.setMachineNames([]);
  const shared_ = shareableRun(record({
    ask: "run it with ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnop",
    steps: [{
      seq: 1, kind: "command", label: "Ran a command",
      detail: "node app.js --token sk-ant-verysecretvalue123",
    }],
  }));
  assert.doesNotMatch(shared_.ask, /sk-ant-abcdefghijklmnop/);
  assert.doesNotMatch(shared_.steps[0].detail ?? "", /verysecretvalue/);
});

// ---------------------------------------------------------------------------
// 3. A record that arrived from somewhere else is checked, not trusted
// ---------------------------------------------------------------------------

test("a run record from the wire is validated like any other untrusted input", () => {
  assert.equal(shared.validateRunRecord(record()), null);
  assert.ok(shared.validateRunRecord(undefined));
  assert.ok(shared.validateRunRecord({}));
  // an id becomes a file name in the engine's own folder — same rule, one owner
  assert.ok(shared.validateRunRecord(record({ id: "../../etc/passwd" })));
  assert.ok(shared.validateRunRecord(record({ id: "CON" })));
  assert.ok(shared.validateRunRecord(record({ kind: "whatever" as shared.RunKind })));
  assert.ok(shared.validateRunRecord(record({ outcome: "maybe" as shared.RunOutcome })));
  assert.ok(shared.validateRunRecord(record({ durationMs: Number.NaN })));
  assert.ok(shared.validateRunRecord(record({ ask: "x".repeat(RUN_LIMITS.ask + 1) })));
  assert.ok(shared.validateRunRecord(record({
    steps: Array.from({ length: RUN_LIMITS.steps + 1 }, (_, i) => ({
      seq: i + 1, kind: "read" as const, label: "Read a file",
    })),
  })));
  assert.ok(shared.validateRunRecord(record({
    steps: [{ seq: 1, kind: "read", label: "x".repeat(RUN_LIMITS.label + 1) }],
  })));
});

test("a record too big to store loses steps from the middle and SAYS so", () => {
  const big = record({
    steps: Array.from({ length: 100 }, (_, i) => ({
      seq: i + 1, kind: "read" as const, label: `Read file ${i}`,
      detail: "x".repeat(200),
    })),
  });
  const fitted = shared.fitRunRecord(big, 4000);
  assert.ok(JSON.stringify(fitted).length <= 4000, "the cap is a cap");
  assert.equal(fitted.truncated, true, "a trimmed run must never read as a short one");
  assert.ok(fitted.steps.length < big.steps.length);
  // the ends are what a person reads — the first step survives
  assert.equal(fitted.steps[0].label, "Read file 0");
});

test("a list row says the same words the card says", () => {
  const r = record();
  assert.deepEqual(shared.runListEntry(r), {
    id: r.id, kind: r.kind, outcome: r.outcome,
    startedAt: r.startedAt, durationMs: r.durationMs, ask: r.ask,
    summary: summarizeRun(r),
  });
});
