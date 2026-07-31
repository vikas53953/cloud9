// "@AgentB, take this" — THE EDGES. The companion suite to
// `agent-handoff.test.ts`: the task measured before it is trimmed, the note
// at its cap to the character, the branch name at 120 characters, and the
// places where the builder's compile-time contract meets runtime garbage.
// Nothing in `agent-handoff.ts` was edited to make these pass; each BREAK
// line names the rule that was broken on purpose to watch the test fail.
import test from "node:test";
import assert from "node:assert/strict";
import { ArtifactRef, isSafeStoredId } from "@cloud9/shared";
import {
  HANDOFF_NOTE_LIMIT, HANDOFF_TASK_LIMIT, HandoffError,
  buildHandoff, newHandoffId, validateHandoff,
} from "./agent-handoff.js";

const artifact = (id = "art-001", version?: number): ArtifactRef =>
  version === undefined ? { artifactId: id } : { artifactId: id, version };

const baseInput = (over: Partial<Parameters<typeof buildHandoff>[0]> = {}) => ({
  fromAgentId: "a1",
  toAgentId: "a2",
  task: "continue the build fix from where I left it",
  contextPointer: { kind: "run" as const, ref: "r-000000001-aaaa" },
  ...over,
});

const throwsHandoff = (fn: () => unknown, words: RegExp) =>
  assert.throws(fn,
    (err: Error) => err instanceof HandoffError && words.test(err.detail));

// --------------------------------------------------------------- the constants

test("the limit numbers are THE numbers — a drive-by change is loud here", () => {
  assert.equal(HANDOFF_TASK_LIMIT, 500);
  assert.equal(HANDOFF_NOTE_LIMIT, 1_000);
});

// --------------------------------------------------------------- the limits, exactly

test("a task at the EXACT cap is accepted; one past is refused", () => {
  const at = buildHandoff(baseInput({ task: "x".repeat(HANDOFF_TASK_LIMIT) }));
  assert.equal(at.task.length, HANDOFF_TASK_LIMIT);
  throwsHandoff(() => buildHandoff(baseInput({ task: "x".repeat(HANDOFF_TASK_LIMIT + 1) })),
    /longer than 500 characters/);
  // BREAK: change `>` to `>=` on the task limit and the 500-character task is refused. Watched.
});

test("the task cap is measured on what was TYPED, before trimming", () => {
  // 499 characters of task plus a trailing space is 500 typed: accepted, stored trimmed
  const padded = buildHandoff(baseInput({ task: `${"x".repeat(499)} ` }));
  assert.equal(padded.task.length, 499, "the stored task is the trimmed one");
  // 500 characters of task plus a trailing space is 501 typed: refused, even
  // though what would survive trimming is exactly at the cap
  throwsHandoff(() => buildHandoff(baseInput({ task: `${"x".repeat(500)} ` })),
    /longer than 500/);
});

test("a note at the EXACT cap is accepted; one past is refused — measured raw, stored trimmed", () => {
  const at = buildHandoff(baseInput({ note: "n".repeat(HANDOFF_NOTE_LIMIT) }));
  assert.equal(at.note!.length, HANDOFF_NOTE_LIMIT);
  throwsHandoff(() => buildHandoff(baseInput({ note: "n".repeat(HANDOFF_NOTE_LIMIT + 1) })),
    /note is longer than/);
  // 998 of note plus two spaces is 1,000 typed: accepted, stored as 998
  const padded = buildHandoff(baseInput({ note: `${"n".repeat(998)}  ` }));
  assert.equal(padded.note!.length, 998);
  // 999 of note plus two spaces is 1,001 typed: refused, though trimmed it would fit
  throwsHandoff(() => buildHandoff(baseInput({ note: `${"n".repeat(999)}  ` })),
    /note is longer than/);
  // and a note that is only whitespace never lands at all
  assert.equal(buildHandoff(baseInput({ note: "\n\t  \n" })).note, undefined);
});

test("the branch rule at its own edges — 120 characters is the most, and the alphabet is small", () => {
  assert.equal(buildHandoff(baseInput({ branch: `cloud9/${"a".repeat(113)}` })).branch!.length, 120,
    "exactly 120 characters carries");
  for (const branch of [
    `cloud9/${"a".repeat(114)}`,  // 121 — one too many
    "cloud9/",                     // a prefix is not a branch
    "Cloud9/scout-abc",            // the prefix is lowercase
    "cloud9/Feature-Branch",       // and so is the rest of the name
    "cloud9/a..b",                 // git's own ref rules
    "cloud9//b",
    "cloud9/b.lock",
    "cloud9/b.",
    "",                            // empty is undefined's cousin, not a branch
  ]) {
    throwsHandoff(() => buildHandoff(baseInput({ branch })),
      /Cloud9 will carry/);
  }
});

// --------------------------------------------------------------- missing and oversized fields

test("a missing context pointer is refused in the same words as a bad kind", () => {
  throwsHandoff(() => buildHandoff(baseInput({ contextPointer: undefined as never })),
    /memory, a run, a channel or an artifact/);
  throwsHandoff(() => buildHandoff(baseInput({ contextPointer: null as never })),
    /memory, a run, a channel or an artifact/);
  throwsHandoff(() => buildHandoff(baseInput({ contextPointer: { ref: "r-1" } as never })),
    /memory, a run, a channel or an artifact/);
});

test("every kind of context pointer is accepted, on the builder and on the wire", () => {
  for (const kind of ["memory", "run", "channel", "artifact"] as const) {
    const h = buildHandoff(baseInput({ contextPointer: { kind, ref: "r-000000001-aaaa" } }));
    assert.equal(h.contextPointer.kind, kind);
    assert.equal(validateHandoff(h), null);
  }
});

test("a context pointer carrying extra keys keeps them — the shape can grow", () => {
  const ptr = { kind: "run" as const, ref: "r-000000001-aaaa", priority: "soon" };
  const h = buildHandoff(baseInput({ contextPointer: ptr }));
  assert.equal((h.contextPointer as unknown as Record<string, unknown>).priority, "soon");
  assert.equal(validateHandoff(JSON.parse(JSON.stringify(h))), null);
});

test("the artifact rule at its edges — version is a positive whole number or absent", () => {
  assert.deepEqual(buildHandoff(baseInput({ artifact: artifact("art-1", 1) })).artifact,
    { artifactId: "art-1", version: 1 }, "version 1 is a version");
  for (const version of [0, -1, 1.5, Number.NaN, "3" as never]) {
    throwsHandoff(() => buildHandoff(baseInput({ artifact: { artifactId: "art-1", version: version as never } })),
      /positive whole number/);
  }
  throwsHandoff(() => buildHandoff(baseInput({ artifact: {} as never })),
    /needs a safe artifact id/);
  // an explicit undefined version is no version — and JSON agrees
  const h = buildHandoff(baseInput({ artifact: { artifactId: "art-1", version: undefined } }));
  assert.equal(validateHandoff(JSON.parse(JSON.stringify(h))), null);
});

test("a null artifact is no artifact to the builder — and a CRASH to the wire validator", () => {
  // builder: `input.artifact` is falsy, so a null artifact is treated as absent
  const h = buildHandoff(baseInput({ artifact: null as never }));
  assert.equal(h.artifact, undefined);
  // wire: `typeof null === "object"` passes the first check and the property
  // read throws — validateHandoff's own doc says it never throws, so this pins
  // the gap between the sentence and the code, loudly and on purpose
  assert.throws(() => validateHandoff({ ...h, artifact: null }), TypeError);
  // BREAK: guard the null in validateHandoff and this test fails — which is the
  // point of pinning it. Watched as a TypeError today.
});

test("fields of the wrong TYPE crash the builder, but are fenced on the wire", () => {
  // the builder's input contract is compile-time; runtime garbage gets a
  // TypeError from the property access, not a HandoffError from the rule
  assert.throws(() => buildHandoff(baseInput({ note: 42 as never })),
    (err: Error) => err instanceof TypeError && !(err instanceof HandoffError));
  assert.throws(() => buildHandoff(baseInput({ branch: 42 as never })),
    (err: Error) => err instanceof TypeError && !(err instanceof HandoffError));
  // the same garbage arriving over the wire gets a sentence, never a crash —
  // the validator checks typeof BEFORE touching anything
  const good = buildHandoff(baseInput());
  assert.match(validateHandoff({ ...good, note: 42 })!, /a handoff note is text/);
  assert.match(validateHandoff({ ...good, branch: 42 })!, /Cloud9 will carry/);
});

test("a time that is not a number is caught by the whole-object recheck", () => {
  // `at` is not in the field checks — NaN, Infinity and strings sail through to
  // the built object, and the FINAL validateHandoff pass is what refuses them
  for (const at of [Number.NaN, Infinity, "soon" as never]) {
    throwsHandoff(() => buildHandoff(baseInput({ at: at as never })), /time isn't a number/);
  }
  // and the times that look like jokes are still times
  assert.equal(buildHandoff(baseInput({ at: 0 })).createdAt, 0);
  assert.equal(buildHandoff(baseInput({ at: -5 })).createdAt, -5);
});

test("an empty run link is refused, not dropped", () => {
  // `...(input.runId ? ...)` would silently drop an empty string — the field
  // check fires first, so the caller hears about it instead
  throwsHandoff(() => buildHandoff(baseInput({ runId: "" })), /run link must be a safe id/);
});

test("the self-handoff check is EXACT string equality — a trailing space is another agent", () => {
  // ids come from the engine, not from a keyboard, so "a1 " is a different id
  // and the rule does not pretend otherwise
  const h = buildHandoff(baseInput({ fromAgentId: "a1", toAgentId: "a1 " }));
  assert.equal(h.toAgentId, "a1 ");
  assert.equal(validateHandoff(h), null);
  throwsHandoff(() => buildHandoff(baseInput({ fromAgentId: "a1", toAgentId: "a1" })),
    /cannot hand off to itself/);
});

// --------------------------------------------------------------- the error itself

test("a HandoffError is shaped for a log line — name, bare detail, full sentence", () => {
  try {
    buildHandoff(baseInput({ task: "" }));
    assert.fail("an empty task must throw");
  } catch (err) {
    const he = err as HandoffError;
    assert.equal(he.name, "HandoffError");
    assert.equal(he.detail, "a handoff says what to do", "the detail is the bare sentence");
    assert.equal(he.message, `handoff is not valid: ${he.detail}`, "the message carries it");
    assert.ok(he instanceof Error);
  }
});

// --------------------------------------------------------------- the id, at its ends

test("newHandoffId at the ends of its range is safe, padded, prefixed and sortable", () => {
  assert.equal(newHandoffId(0, () => 0), "h-000000000-0000");
  assert.equal(newHandoffId(0, () => 0.999999999), "h-000000000-zzzz");
  const shape = /^h-[0-9a-z]{9}-[0-9a-z]{4}$/;
  const ids = [0, 1, 1_000, Date.now()].map(t => newHandoffId(t, () => 0.5));
  for (const id of ids) {
    assert.match(id, shape);
    assert.ok(isSafeStoredId(id));
  }
  assert.deepEqual([...ids].sort(), ids, "lexicographic order IS time order");
});

// --------------------------------------------------------------- the wire, at its edges

test("validateHandoff at the exact edges of every bounded field", () => {
  const good = buildHandoff(baseInput({ at: 1_000_000 }));
  assert.equal(validateHandoff(good), null);
  // ids: 64 characters is the most the safe-id rule allows
  assert.equal(validateHandoff({ ...good, id: "a".repeat(64) }), null);
  assert.match(validateHandoff({ ...good, id: "a".repeat(65) })!, /needs a safe id/);
  // task and note at their caps, on the wire exactly as at the builder
  assert.equal(validateHandoff({ ...good, task: "x".repeat(HANDOFF_TASK_LIMIT) }), null);
  assert.match(validateHandoff({ ...good, task: "x".repeat(HANDOFF_TASK_LIMIT + 1) })!, /longer than/);
  assert.equal(validateHandoff({ ...good, note: "n".repeat(HANDOFF_NOTE_LIMIT) }), null);
  assert.match(validateHandoff({ ...good, note: "n".repeat(HANDOFF_NOTE_LIMIT + 1) })!, /note is longer/);
  // a context pointer that is a list is not a pointer
  assert.match(validateHandoff({ ...good, contextPointer: [] })!, /points at where the context lives/);
  // time as a string is not a time
  assert.match(validateHandoff({ ...good, createdAt: "1000" })!, /time isn't a number/);
  // and a handoff carrying fields nobody taught the validator about is still a handoff
  assert.equal(validateHandoff({ ...good, priority: "soon", attempts: 2 }), null,
    "extra keys pass — the wire shape can grow without the validator refusing it");
});
