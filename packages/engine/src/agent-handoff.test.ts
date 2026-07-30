// "@AgentB, take this" — the builder and the validator. Pure data: nothing
// runs, nothing is sent. The same one-rule promise as `runrecord` and
// `agent-memory`: a handoff off the wire and a handoff off the disk are asked
// the same question by the same function.
import test from "node:test";
import assert from "node:assert/strict";
import { ArtifactRef, isSafeStoredId } from "@cloud9/shared";
import {
  AgentHandoff, HANDOFF_NOTE_LIMIT, HANDOFF_TASK_LIMIT, HandoffError,
  buildHandoff, newHandoffId, validateHandoff,
} from "./agent-handoff.js";

const artifact = (id = "art-001", version?: number): ArtifactRef =>
  version === undefined ? { artifactId: id } : { artifactId: id, version };

const baseInput = (over: Partial<Parameters<typeof buildHandoff>[0]> = {}) => ({
  fromAgentId: "a1",
  toAgentId: "a2",
  task: "continue the build fix from where I left it",
  contextPointer: { kind: "run" as const, ref: "r-000000000001-aaaa" },
  ...over,
});

// --------------------------------------------------------------- the builder

test("a handoff is built from a few facts and carries them unchanged", () => {
  const h = buildHandoff(baseInput({
    artifact: artifact("art-001", 3),
    branch: "cloud9/scout-abc",
    note: "the test file is in packages/engine",
    runId: "r-000000000001-aaaa",
    at: 1_000_000,
  }));
  assert.ok(isSafeStoredId(h.id), "the id is a safe stored id");
  assert.equal(h.fromAgentId, "a1");
  assert.equal(h.toAgentId, "a2");
  assert.equal(h.task, "continue the build fix from where I left it");
  assert.equal(h.contextPointer.kind, "run");
  assert.deepEqual(h.artifact, { artifactId: "art-001", version: 3 });
  assert.equal(h.branch, "cloud9/scout-abc");
  assert.equal(h.note, "the test file is in packages/engine");
  assert.equal(h.createdAt, 1_000_000);
  assert.equal(h.runId, "r-000000000001-aaaa");
});

test("a handoff without optional fields omits them, not as undefineds", () => {
  const h = buildHandoff(baseInput({ at: 1_000_000 }));
  assert.equal(h.artifact, undefined);
  assert.equal(h.branch, undefined);
  assert.equal(h.note, undefined);
  assert.equal(h.runId, undefined);
  // the object has exactly the required keys
  assert.deepEqual(Object.keys(h).sort(),
    ["createdAt", "contextPointer", "fromAgentId", "id", "task", "toAgentId"].sort());
});

test("a blank note is dropped, not stored as empty text", () => {
  const h = buildHandoff(baseInput({ note: "   " }));
  assert.equal(h.note, undefined);
});

test("the ids we generate all pass the same safe-id rule", () => {
  for (let i = 0; i < 50; i++) {
    const id = newHandoffId(Date.now() + i * 997, Math.random);
    assert.ok(isSafeStoredId(id), `refused an id we generated: ${id}`);
    assert.ok(id.startsWith("h-"), "and it carries the handoff prefix");
  }
});

// --------------------------------------------------------------- the rule

test("a handoff to itself is refused — an agent cannot hand off to itself", () => {
  assert.throws(
    () => buildHandoff(baseInput({ fromAgentId: "a1", toAgentId: "a1" })),
    (err: Error) => err instanceof HandoffError && /cannot hand off to itself/.test(err.detail),
  );
});

test("a handoff with an empty task is refused, in plain words", () => {
  for (const task of ["", "   ", ""]) {
    assert.throws(
      () => buildHandoff(baseInput({ task })),
      (err: Error) => err instanceof HandoffError && /says what to do/.test(err.detail),
    );
  }
});

test("a handoff with a task over the cap is refused, not truncated", () => {
  const too = "x".repeat(HANDOFF_TASK_LIMIT + 1);
  assert.throws(
    () => buildHandoff(baseInput({ task: too })),
    (err: Error) => err instanceof HandoffError && /longer than/.test(err.detail),
  );
});

test("a handoff with a bad context pointer kind is refused", () => {
  assert.throws(
    () => buildHandoff(baseInput({
      contextPointer: { kind: "whatever" as never, ref: "x" },
    })),
    (err: Error) => err instanceof HandoffError && /memory, a run, a channel or an artifact/.test(err.detail),
  );
});

test("a handoff with a context pointer that names nothing is refused", () => {
  assert.throws(
    () => buildHandoff(baseInput({ contextPointer: { kind: "run", ref: "" } })),
    (err: Error) => err instanceof HandoffError && /names what it points at/.test(err.detail),
  );
});

test("a handoff with an unsafe branch is refused by the one owner of that rule", () => {
  assert.throws(
    () => buildHandoff(baseInput({ branch: "main" })),
    (err: Error) => err instanceof HandoffError && /Cloud9 will carry/.test(err.detail),
  );
});

test("a handoff with a note over the cap is refused", () => {
  const too = "x".repeat(HANDOFF_NOTE_LIMIT + 1);
  assert.throws(
    () => buildHandoff(baseInput({ note: too })),
    (err: Error) => err instanceof HandoffError && /note is longer than/.test(err.detail),
  );
});

test("a handoff with a bad run link is refused", () => {
  assert.throws(
    () => buildHandoff(baseInput({ runId: "../../escape" })),
    (err: Error) => err instanceof HandoffError && /run link must be a safe id/.test(err.detail),
  );
});

test("a handoff with an unsafe overridden id is refused", () => {
  assert.throws(
    () => buildHandoff(baseInput({ id: "../../escape" })),
    (err: Error) => err instanceof HandoffError && /id is not a safe id/.test(err.detail),
  );
});

// --------------------------------------------------------------- the validator

test("validateHandoff accepts a handoff the builder made", () => {
  const h = buildHandoff(baseInput());
  assert.equal(validateHandoff(h), null);
});

test("validateHandoff refuses a nonsense object with every key present, in plain words", () => {
  const poisoned: [string, Record<string, unknown>, string][] = [
    ["aa", { id: 42 }, "needs a safe id"],
    ["bb", { fromAgentId: "" }, "says who it is from"],
    ["cc", { toAgentId: "" }, "says who it is to"],
    ["dd", { fromAgentId: "a1", toAgentId: "a1" }, "cannot hand off to itself"],
    ["ee", { task: "" }, "says what to do"],
    ["ff", { contextPointer: "nope" }, "points at where the context lives"],
    ["gg", { createdAt: "soup" }, "time isn't a number"],
  ];
  for (const [tag, breakage, words] of poisoned) {
    const good = buildHandoff(baseInput());
    const obj: Record<string, unknown> = { ...good, ...breakage };
    const problem = validateHandoff(obj);
    assert.ok(problem && problem.includes(words),
      `${tag}: expected refusal containing ${JSON.stringify(words)}, got ${JSON.stringify(problem)}`);
  }
});

test("validateHandoff refuses a non-object, not as a thrown error", () => {
  for (const bad of [null, undefined, 42, "hello", []]) {
    const problem = validateHandoff(bad);
    assert.ok(problem && /an object/.test(problem), `accepted a non-object: ${JSON.stringify(bad)}`);
  }
});

test("validateHandoff never throws — it returns a sentence or null", () => {
  assert.doesNotThrow(() => validateHandoff(null));
  assert.doesNotThrow(() => validateHandoff({}));
  assert.doesNotThrow(() => validateHandoff({ id: "x" }));
});

// --------------------------------------------------------------- the promise

test("a built handoff round-trips through JSON and back through the validator", () => {
  const h = buildHandoff(baseInput({
    artifact: artifact("art-002", 1),
    branch: "cloud9/scout-abc",
    note: "pick up where I stopped",
    runId: "r-000000000001-aaaa",
  }));
  const text = JSON.stringify(h);
  const back = JSON.parse(text);
  assert.equal(validateHandoff(back), null, "a handoff off the wire is the same as one off the builder");
  assert.equal((back as AgentHandoff).id, h.id);
});
