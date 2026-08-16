import test from "node:test";
import assert from "node:assert/strict";
import {
  RUN_LIMITS, RunRecord, shareableRun, testFactsFromSteps, validateRunRecord,
} from "./index.js";

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "r-000000001-0001", kind: "chat", agentId: "a1", agentName: "Scout",
  provider: "claude", requestedBy: "Vikas", requestedByKind: "human", ask: "inspect",
  startedAt: 1, finishedAt: 2, durationMs: 1, outcome: "ok", steps: [], replyChars: 0,
  events: 1, ...over,
});

test("test receipts classify only provider-reported test commands", () => {
  assert.deepEqual(testFactsFromSteps([
    { seq: 1, kind: "command", label: "Ran a command", detail: "npm test", ok: true },
    { seq: 2, kind: "command", label: "Ran a command", detail: "git commit -m 'add tests'", ok: true },
    { seq: 3, kind: "thinking", label: "private reasoning", detail: "npm test" },
    { seq: 4, kind: "command", label: "Ran a command", detail: "npm test", ok: false },
    { seq: 5, kind: "command", label: "npm test", ok: true },
  ]), [{ command: "npm test", ok: true }],
    "a repeated command and a commit message must not create a fake test result");
});

test("test receipts require a real runner token, not shell prose", () => {
  assert.deepEqual(testFactsFromSteps([
    { seq: 1, kind: "command", label: "Ran a command", detail: "echo npm test" },
    { seq: 2, kind: "command", label: "Ran a command", detail: "printf \"pytest\"" },
    { seq: 3, kind: "command", label: "Ran a command", detail: "# npm test" },
    { seq: 4, kind: "command", label: "Ran a command", detail: "git commit -m 'npm test'" },
    { seq: 5, kind: "command", label: "Ran a command", detail: "npm test # suite" },
    { seq: 6, kind: "command", label: "Ran a command", detail: "node --test test/run.mjs" },
    { seq: 7, kind: "command", label: "Ran a command", detail: "pytest -q" },
  ]), [
    { command: "npm test # suite" },
    { command: "node --test test/run.mjs" },
    { command: "pytest -q" },
  ]);
});

test("test receipts are bounded, validated and redacted at the sharing boundary", () => {
  const raw = record({ tests: [{ command: "run C:\\Users\\vikasmit\\secrets\\suite", ok: true }] });
  assert.equal(validateRunRecord(raw), null);
  const shared = shareableRun(raw);
  assert.doesNotMatch(shared.tests?.[0].command ?? "", /vikasmit|secrets/i);
  assert.ok(validateRunRecord(record({ tests: Array.from({ length: RUN_LIMITS.tests + 1 }, () => ({ command: "npm test" })) })));
  assert.ok(validateRunRecord(record({ tests: [{ command: "x".repeat(RUN_LIMITS.test + 1) }] })));
  assert.ok(validateRunRecord(record({ tests: [{ command: "npm test", ok: "yes" as never }] })));
});

test("the public receipt projection drops forged top-level and nested metadata", () => {
  const forged = record({
    privateOutput: "provider transcript /Users/vikasmit/private.txt",
    steps: [{
      seq: 1, kind: "command", label: "npm test", detail: "C:\\Users\\vikasmit\\repo",
      ok: true, output: "private command output", path: "C:\\Users\\vikasmit\\secret.log",
    } as never],
    tests: [{ command: "npm test", ok: true, output: "private test output", path: "/Users/vikasmit/test.log" } as never],
    artifacts: [{ id: "artifact-1", name: "report.md", version: 1, available: true,
      output: "private artifact output", path: "/Users/vikasmit/report.md" } as never],
    usage: { inputTokens: 4, privateOutput: "provider metadata" } as never,
  } as unknown as Partial<RunRecord>) as unknown as RunRecord;

  assert.match(validateRunRecord(forged) ?? "", /unknown|usable/);
  const shared = shareableRun(forged) as unknown as Record<string, unknown>;
  assert.equal(shared.privateOutput, undefined);
  assert.deepEqual(shared.steps, [{
    seq: 1, kind: "command", label: "npm test", detail: "repo", ok: true,
  }]);
  assert.deepEqual(shared.tests, [{ command: "npm test", ok: true }]);
  assert.deepEqual(shared.artifacts, [{ id: "artifact-1", name: "report.md", version: 1, available: true }]);
  assert.deepEqual(shared.usage, { inputTokens: 4 });
  assert.doesNotMatch(JSON.stringify(shared), /privateOutput|private command output|private test output|private artifact output|vikasmit/i);
});
