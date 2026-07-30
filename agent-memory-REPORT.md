# Agent Memory + Agent-to-Agent Handoff — Lane M Report

**Branch:** `cursor/agent-memory`
**Date:** 2026-07-31
**Lane:** M (engine memory + handoff)

## Summary

Two new doors into the engine, **stores and rules only** — no `engine.ts`,
`host.ts`, `provider.ts`, or `context.ts` edits. Memory is what an agent
remembers between conversations; handoff is what one agent says to another
when it wants it to take over.

## Files (exclusive — 5 source/doc + this report)

| File | Role |
|---|---|
| `packages/engine/src/agent-memory.ts` | Memory store, budget, worth-remembering rule, retrieval |
| `packages/engine/src/agent-memory.test.ts` | 17 tests |
| `packages/engine/src/agent-handoff.ts` | Handoff builder + validator (pure, no execution) |
| `packages/engine/src/agent-handoff.test.ts` | 18 tests |
| `docs/plans/agent-memory-handoff.md` | Contract doc for engine wiring |
| `agent-memory-REPORT.md` | This report |

Nothing else was touched. `dist/` is gitignored (build artifacts, not
committed). The source commit is `8e42ac7`; this report is a follow-on
commit on the same branch.

## Test counts

| Suite | Tests | Pass | Fail |
|---|---|---|---|
| `agent-memory.test.ts` | 17 | 17 | 0 |
| `agent-handoff.test.ts` | 18 | 18 | 0 |
| **new total** | **35** | **35** | **0** |
| full engine suite (`npm test -w @cloud9/engine`) | 442 | 442 | 0 |
| repo build (`npm run build`) | — | clean | — |

Both new suites were **made to fail once first, then fixed** (the "prove fail
once" requirement):

- *Memory:* the pleasantries rule fired *after* the short-check, so "thanks"
  was refused as "too short" instead of "a pleasantry" — the wrong, less
  specific reason. Fixed by ordering the pleasantry check before the length
  checks. A retrieval test also asserted on note *ids* the renderer does not
  emit; fixed by asserting on text content.
- *Handoff:* the artifact-field validator round-tripped through
  `parseArtifactRef` without the `cloud9://artifact/` scheme prefix, so every
  artifact was refused as "needs a safe artifact id". Fixed by checking the
  `artifactId` directly with `isSafeStoredId`.

## What was built

### 1. Memory (`agent-memory.ts`)

- **Per-agent, durable, append-only notes.** One file per note, inside the
  agent's own folder: `<dataDir>/agents/<agentId>/memory/m-<time>-<noise>.json`.
- **Size budget, reusing the *idea* from `context.ts` without editing it.**
  `MEMORY_BUDGET` (8,000 chars / 200 notes) is a named, justified constant —
  the same shape as `CONVERSATION_BUDGET` (24,000 chars / 200 messages) but a
  *separate* number: conversation is foreground, memory is background, so
  memory seeds a turn for ~1% of the smallest model window vs. ~3% for
  conversation. `MEMORY_NOTE_LIMIT` (500) caps a single note; `MEMORY_STORE_KEEP`
  (1,000) caps on-disk retention.
- **Worth-remembering rule.** `worthRemembering(text)` returns
  `{ keep, reason? }`, refusing noise in plain words: empty, pleasantries
  ("thanks", "ok", "done", …), too-short (<8), too-long (>500, refused not
  truncated), and questions. The `reason` is for the log — a refusal nobody
  heard is how an agent ends up remembering nothing and nobody knows why.
- **`MemoryStore`** with the same durability promises as `RunStore`: safe
  paths (one owner: `isSafeStoredId`), write-then-rename (`wholefile.ts`),
  torn-not-lost (junk is removed and named in the log; busy files are left
  alone), fail-safe (never throws at the caller), and `validateNote` as the
  one rule about what a note is (type-checks every field, the way
  `validateRunRecord` checks a run).
- **`retrieveMemory(notes, budget?)`** seeds a turn oldest-first, newest
  dropped when over budget — the *opposite* of `renderConversation`, because
  memory is what the conversation has *forgotten* (the newest memory is most
  likely still in the conversation window; the oldest is the foundation). A
  single too-long note is included truncated and says so.

### 2. Handoff (`agent-handoff.ts`)

- **Structured `@AgentB take this` object:** `AgentHandoff` with `fromAgentId`,
  `toAgentId`, `task`, `contextPointer` (`{ kind, ref }` — memory/run/channel/
  artifact), optional `artifact` (`ArtifactRef`), optional `branch`, optional
  `note`, `createdAt`, optional `runId`.
- **Pure builder + validation, no execution.** `buildHandoff(input)` throws
  `HandoffError` at the seam on bad input (a builder that cannot build has
  nothing to hand on — the caller has a bug); `validateHandoff(value)` never
  throws and returns `null` or a plain-words sentence (the wire/disk path).
  The builder re-checks via `validateHandoff` so both paths share one rule.
- **Rules reused, not reimplemented.** ids → `isSafeStoredId`; branches →
  `isSafeBranchName` from `worktree.ts` (must start with `cloud9/`);
  artifacts → `ArtifactRef` from `@cloud9/shared` with `isSafeStoredId` on the
  id and a positive-integer version.
- **Refuses:** self-handoff (`from === to`), empty/blank/over-cap task, bad
  context-pointer kind, empty pointer ref, unsafe branch, unsafe run link,
  unsafe overridden id, over-cap note.

## What was NOT done (by design)

- **No `index.ts` re-export.** The engine's published surface does not widen
  until there is a caller. The contract doc (§9) is the wiring spec.
- **No `engine.ts` / `host.ts` / `provider.ts` / `context.ts` edits.** Those
  are not this lane's files.
- **No wire types in `packages/shared`.** When the relay needs to carry a
  handoff, `AgentHandoff` moves verbatim the way `RunRecord` did, with a test
  asserting *identity* of the validator (§11 of the contract doc).
- **No execution from inside the builder.** Choosing a runner, channel and
  approval policy is the engine's job.

## Branch hygiene note

The source commit (`8e42ac7`) was initially made on `cursor/join-hub` because
a parallel lane's automation switched the checked-out branch mid-task. Both
`cursor/join-hub` and `cursor/agent-memory` had been freshly branched from
`origin/master` at the same base (`1f18320`), so the commit was moved to
`cursor/agent-memory` (`git branch -f cursor/agent-memory 8e42ac7`) and
`cursor/join-hub` was reset to `1f18320` (its original empty state). The
parallel lane's uncommitted work was already in their own stash before the
branch-pointer move, so nothing of theirs was touched. The report commit was
similarly re-homed after the automation switched branches again.

## How to wire it (next lane)

See `docs/plans/agent-memory-handoff.md` §9. In short:
1. Re-export the new symbols from `packages/engine/src/index.ts` (one line
   each) once there is a caller.
2. Construct one `MemoryStore` per engine alongside `RunStore`; seed each
   turn with `retrieveMemory(store.list(agentId))`; remember after a turn
   via `worthRemembering` → `store.save`; forget on agent removal.
3. Detect "@AgentB take this" intent in agent replies → `buildHandoff`;
   `validateHandoff` on the wire in the relay; the engine turns the shape
   into a `Task` through the existing approval gate.
