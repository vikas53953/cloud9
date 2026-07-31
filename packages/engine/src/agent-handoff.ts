// "@AgentB, take this" — a structured handoff from one agent to another.
//
// WHAT THIS IS. When Agent A has done part of a job and wants Agent B to
// continue, it writes a `AgentHandoff`: the task to do, a pointer to the
// context B will need, and the artifact or branch B should pick up. This is
// the BUILDER and the VALIDATOR for that object — nothing more. It does not
// run anything, it does not send anything, it does not decide who is allowed
// to receive it. It turns a few facts into a checked shape, the same way
// `commitMessage` turns a title and a body into a commit message without
// running `git commit`.
//
// WHY PURE. The engine that wires this up lives in `engine.ts`, `host.ts`
// and `provider.ts`, and those are not this file's to touch. A handoff that
// also executed would have to choose a runner, a channel and an approval
// policy, and each of those is somebody else's decision. Keeping the builder
// pure means the wiring can be written against a shape that does not change,
// and tested without a running engine.
//
// THE RULES ARE REUSED, NOT REIMAGINED. An id is checked with
// `isSafeStoredId` (the same rule the relay, `RunStore` and `MemoryStore`
// use), a branch with `isSafeBranchName` (the one owner of "is this a branch
// we will carry", in `worktree.ts`), and an artifact reference with
// `parseArtifactRef` from `@cloud9/shared`. A second, subtly different rule
// for any of these is how a hole gets opened, so there isn't one.
import { isSafeStoredId, ArtifactRef, ContextPointer, AgentHandoff } from "@cloud9/shared";
import { isSafeBranchName } from "./worktree.js";

// --------------------------------------------------------------- the shape
//
// `ContextPointer` and `AgentHandoff` are defined once, in `@cloud9/shared`,
// because a handoff built by one agent's engine is delivered over the wire to
// another's — the same move `RunRecord` made. They are re-exported here so
// `@cloud9/engine` keeps its published surface; the BUILDER and the VALIDATOR
// below are still the engine's and still live here.
//
// `ContextPointer.kind`: `memory` — the sender's own memory store, `ref` is the
//   agent id to seed from; `run` — a finished run, `ref` is the run id;
//   `channel` — a conversation to catch up on, `ref` is the channel id;
//   `artifact` — a file to pick up, `ref` is the artifact id.
export type { ContextPointer, AgentHandoff } from "@cloud9/shared";

// --------------------------------------------------------------- the limits

/** The most characters a handoff task may carry. A task is one sentence. */
export const HANDOFF_TASK_LIMIT = 500;

/** The most characters a handoff note may carry. A note is a short aside. */
export const HANDOFF_NOTE_LIMIT = 1_000;

// --------------------------------------------------------------- the id

/**
 * A handoff id that is also a safe file name and sorts by time. The same
 * shape as `newRunId` and `newMemoryId`, with an `h-` prefix so a handoff,
 * a run and a memory can share a folder without confusion.
 */
export function newHandoffId(now = Date.now(), rand = Math.random): string {
  const time = now.toString(36).padStart(9, "0");
  const noise = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0");
  return `h-${time}-${noise}`;
}

// --------------------------------------------------------------- the builder

/** What a caller hands to `buildHandoff`. Everything required is required. */
export interface HandoffInput {
  fromAgentId: string;
  toAgentId: string;
  task: string;
  contextPointer: ContextPointer;
  artifact?: ArtifactRef;
  branch?: string;
  note?: string;
  at?: number;
  runId?: string;
  /** override the generated id — for tests or for adopting an existing id */
  id?: string;
}

/**
 * Turn a few facts into a checked `AgentHandoff`.
 *
 * THROWS ON BAD INPUT, unlike `MemoryStore.save`. The difference is
 * deliberate: a store that cannot write must not cost the owner an answer
 * (so it swallows), but a builder that cannot build has nothing to hand on
 * and the caller has a bug. A malformed handoff thrown here is a bug caught
 * at the seam, not a job lost mid-flight. The validator (`validateHandoff`)
 * is the same rule applied to an object that arrived over the wire or off
 * the disk, where throwing would be the wrong answer.
 */
export function buildHandoff(input: HandoffInput): AgentHandoff {
  const problem = validateHandoffFields(input);
  if (problem) throw new HandoffError(problem);
  const id = input.id ?? newHandoffId(input.at);
  // re-check the overridden id, if one was supplied
  if (!isSafeStoredId(id)) throw new HandoffError(`the id is not a safe id: ${id}`);
  const handoff: AgentHandoff = {
    id,
    fromAgentId: input.fromAgentId,
    toAgentId: input.toAgentId,
    task: input.task.trim(),
    contextPointer: input.contextPointer,
    createdAt: input.at ?? Date.now(),
    ...(input.artifact ? { artifact: input.artifact } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.note !== undefined && input.note.trim().length > 0 ? { note: input.note.trim() } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
  };
  // a final whole-object check, so the builder and the wire share one rule
  const recheck = validateHandoff(handoff);
  if (recheck) throw new HandoffError(recheck);
  return handoff;
}

/** A bad handoff, caught at the build seam. */
export class HandoffError extends Error {
  constructor(public readonly detail: string) {
    super(`handoff is not valid: ${detail}`);
    this.name = "HandoffError";
  }
}

// --------------------------------------------------------------- the validator

/**
 * Is this object a `AgentHandoff`? Returns `null` when it is, or a plain-words
 * sentence when it is not — the same shape as `validateRunRecord` and
 * `validateNote`, so a file coming off the disk and a frame arriving over
 * the wire are asked the same question by the same rule.
 *
 * This is the function the relay should call on a handoff arriving over the
 * wire, and the function `MemoryStore`-style stores should call on one
 * coming off the disk. It never throws.
 */
export function validateHandoff(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "a handoff is an object, not whatever that was";
  }
  const h = value as Record<string, unknown>;
  if (typeof h.id !== "string" || !isSafeStoredId(h.id)) {
    return "a handoff needs a safe id";
  }
  if (typeof h.fromAgentId !== "string" || h.fromAgentId.length === 0) {
    return "a handoff says who it is from";
  }
  if (typeof h.toAgentId !== "string" || h.toAgentId.length === 0) {
    return "a handoff says who it is to";
  }
  if (typeof h.fromAgentId === "string" && h.fromAgentId === h.toAgentId) {
    return "an agent cannot hand off to itself";
  }
  if (typeof h.task !== "string" || h.task.trim().length === 0) {
    return "a handoff says what to do";
  }
  if (h.task.length > HANDOFF_TASK_LIMIT) {
    return `a handoff task is longer than ${HANDOFF_TASK_LIMIT} characters`;
  }
  const ptr = h.contextPointer;
  if (!ptr || typeof ptr !== "object" || Array.isArray(ptr)) {
    return "a handoff points at where the context lives";
  }
  const p = ptr as Record<string, unknown>;
  if (p.kind !== "memory" && p.kind !== "run" && p.kind !== "channel" && p.kind !== "artifact") {
    return "a context pointer is to memory, a run, a channel or an artifact";
  }
  if (typeof p.ref !== "string" || p.ref.length === 0) {
    return "a context pointer names what it points at";
  }
  if (h.artifact !== undefined) {
    if (typeof h.artifact !== "object" || Array.isArray(h.artifact)) {
      return "an artifact reference is an object";
    }
    const a = h.artifact as Record<string, unknown>;
    if (typeof a.artifactId !== "string" || !isSafeStoredId(a.artifactId)) {
      return "an artifact reference needs a safe artifact id";
    }
    if (a.version !== undefined &&
      (typeof a.version !== "number" || !Number.isInteger(a.version) || a.version < 1)) {
      return "an artifact version is a positive whole number";
    }
  }
  if (h.branch !== undefined && (typeof h.branch !== "string" || !isSafeBranchName(h.branch))) {
    return "a branch is one Cloud9 will carry — checked by the one owner of that rule";
  }
  if (h.note !== undefined) {
    if (typeof h.note !== "string") return "a handoff note is text";
    if (h.note.length > HANDOFF_NOTE_LIMIT) {
      return `a handoff note is longer than ${HANDOFF_NOTE_LIMIT} characters`;
    }
  }
  if (typeof h.createdAt !== "number" || !Number.isFinite(h.createdAt)) {
    return "the handoff's time isn't a number";
  }
  if (h.runId !== undefined && (typeof h.runId !== "string" || !isSafeStoredId(h.runId))) {
    return "a run link must be a safe id";
  }
  return null;
}

/**
 * Validate the INPUT to `buildHandoff` (before an id is generated). The same
 * rule as `validateHandoff`, minus the fields the builder itself supplies.
 */
function validateHandoffFields(input: HandoffInput): string | null {
  if (typeof input.fromAgentId !== "string" || input.fromAgentId.length === 0) {
    return "a handoff says who it is from";
  }
  if (typeof input.toAgentId !== "string" || input.toAgentId.length === 0) {
    return "a handoff says who it is to";
  }
  if (input.fromAgentId === input.toAgentId) {
    return "an agent cannot hand off to itself";
  }
  if (typeof input.task !== "string" || input.task.trim().length === 0) {
    return "a handoff says what to do";
  }
  if (input.task.length > HANDOFF_TASK_LIMIT) {
    return `a handoff task is longer than ${HANDOFF_TASK_LIMIT} characters`;
  }
  const p = input.contextPointer;
  if (!p || !["memory", "run", "channel", "artifact"].includes(p.kind)) {
    return "a context pointer is to memory, a run, a channel or an artifact";
  }
  if (typeof p.ref !== "string" || p.ref.length === 0) {
    return "a context pointer names what it points at";
  }
  if (input.artifact) {
    const a = input.artifact;
    if (typeof a.artifactId !== "string" || !isSafeStoredId(a.artifactId)) {
      return "an artifact reference needs a safe artifact id";
    }
    if (a.version !== undefined &&
      (typeof a.version !== "number" || !Number.isInteger(a.version) || a.version < 1)) {
      return "an artifact version is a positive whole number";
    }
  }
  if (input.branch !== undefined && !isSafeBranchName(input.branch)) {
    return "a branch is one Cloud9 will carry — checked by the one owner of that rule";
  }
  if (input.note !== undefined && input.note.length > HANDOFF_NOTE_LIMIT) {
    return `a handoff note is longer than ${HANDOFF_NOTE_LIMIT} characters`;
  }
  if (input.runId !== undefined && !isSafeStoredId(input.runId)) {
    return "a run link must be a safe id";
  }
  return null;
}
