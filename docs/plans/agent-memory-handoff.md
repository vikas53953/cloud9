# Agent memory + agent-to-agent handoff — contract for engine wiring

**Written by:** Cursor Lane M (the engine-memory builder), 2026-07-31.
**Owns:** four new files in `packages/engine/src/` only — `agent-memory.ts`,
`agent-memory.test.ts`, `agent-handoff.ts`, `agent-handoff.test.ts`. Nothing
in `context.ts`, `engine.ts`, `host.ts`, `provider.ts`, `packages/shared`,
`apps/relay` or `apps/desktop` was touched — this document is the request.
**Branch:** `cursor/agent-memory`.

---

## 1. What this is, in one paragraph

Two new doors into the engine. **Memory** is what an agent *remembers between
conversations*: per-agent, durable, append-only notes with a character budget,
a worth-remembering rule that refuses noise before it lands, and a retrieval
function that seeds a later turn. **Handoff** is what one agent says to
another when it wants it to take over: a structured `@AgentB take this` object
carrying a task, a context pointer, and an optional artifact or branch — a
pure builder and validator, no execution. Both are STORES and RULES only; the
decision of *when* to remember and *when* to hand off is the engine's, and
`engine.ts` / `host.ts` / `provider.ts` are not this file's to edit.

---

## 2. What the engine now exports

All from `@cloud9/engine`, in the two new files. The engine's `index.ts` does
not re-export these yet — that is a one-line change for whoever wires them
up, and is left undone on purpose so the published surface does not widen
before there is a caller.

### Memory — `agent-memory.ts`

| Export | Plain-words role |
|---|---|
| `MEMORY_BUDGET` | The named character-and-note budget for seeding a turn (8,000 chars, 200 notes). |
| `MemoryBudget` | The shape of that budget. |
| `MEMORY_NOTE_LIMIT` | The most characters one note may carry (500). |
| `MEMORY_STORE_KEEP` | The most notes kept on disk per agent before the oldest are pruned (1,000). |
| `MEMORY_STORE_DEFAULTS` | `{ keepPerAgent }` derived from `MEMORY_STORE_KEEP`. |
| `MemoryKind` | `fact` \| `preference` \| `decision` \| `outcome` \| `correction`. |
| `MemoryNote` | One durable note: id, agentId, kind, text, createdAt, runId?, source. |
| `RememberInput` | What a caller hands to `save` (kind/source/at optional). |
| `MemoryStore` | Where notes live on disk; `save` / `list` / `read` / `prune` / `forget`. |
| `MemoryStoreOptions` | `{ agentDataDir, keepPerAgent?, log? }`. |
| `worthRemembering(text)` | The rule: `{ keep, reason? }`. Refuses noise in plain words. |
| `newMemoryId(now?, rand?)` | `m-<time>-<noise>`, safe as a file name, sorts by time. |
| `retrieveMemory(notes, budget?)` | The string an agent is seeded with per turn. |
| `validateNote(value)` | The one rule about what a note is; `null` or a plain-words sentence. |

### Handoff — `agent-handoff.ts`

| Export | Plain-words role |
|---|---|
| `AgentHandoff` | One agent handing work to another. Pure data. |
| `ContextPointer` | `{ kind, ref }` — where the receiver looks for context. |
| `HandoffInput` | What a caller hands to `buildHandoff`. |
| `HANDOFF_TASK_LIMIT` | The most characters a task may carry (500). |
| `HANDOFF_NOTE_LIMIT` | The most characters a note may carry (1,000). |
| `newHandoffId(now?, rand?)` | `h-<time>-<noise>`, safe as a file name, sorts by time. |
| `buildHandoff(input)` | The builder. THROWS `HandoffError` on bad input — caught at the seam. |
| `HandoffError` | The error a bad build throws, with a `detail` field. |
| `validateHandoff(value)` | The validator. Returns `null` or a plain-words sentence; never throws. |

---

## 3. The shapes

```ts
type MemoryKind = "fact" | "preference" | "decision" | "outcome" | "correction";

interface MemoryNote {
  id: string;            // "m-<time>-<noise>", sorts by time, safe as a file name
  agentId: string;
  kind: MemoryKind;
  text: string;          // ≤ MEMORY_NOTE_LIMIT (500)
  createdAt: number;
  runId?: string;        // the run that produced this note, if any
  source: "agent" | "owner" | "system";
}

interface ContextPointer {
  kind: "memory" | "run" | "channel" | "artifact";
  ref: string;           // agentId | runId | channelId | artifactId
}

interface AgentHandoff {
  id: string;            // "h-<time>-<noise>"
  fromAgentId: string;
  toAgentId: string;     // must differ from fromAgentId
  task: string;          // ≤ HANDOFF_TASK_LIMIT (500)
  contextPointer: ContextPointer;
  artifact?: ArtifactRef;  // { artifactId, version? } — version is a positive int
  branch?: string;        // must pass isSafeBranchName (cloud9/… prefix)
  note?: string;          // ≤ HANDOFF_NOTE_LIMIT (1000)
  createdAt: number;
  runId?: string;
}
```

---

## 4. The two budgets, and why they are separate

`context.ts` introduced a NAMED CHARACTER BUDGET for *conversation*
(`CONVERSATION_BUDGET`, 24,000 chars / 200 messages). Memory reuses the
**shape** of that idea — a named constant, a character-and-count budget, a
single rendering function — without reusing the **number**. The two are
separate facts:

- `CONVERSATION_BUDGET` (24,000 chars) — the foreground. What was just said.
- `MEMORY_BUDGET` (8,000 chars) — the background. What was said before this
  conversation started. Smaller on purpose: memory is background and the
  conversation is foreground, and seeding memory costs about 1% of the
  smallest model window.

`context.ts` was not edited. A test does not assert the two are linked,
because they are not — they are deliberately independent numbers.

---

## 5. The worth-remembering rule

`worthRemembering(text)` returns `{ keep: boolean; reason?: string }`. A
candidate is refused, in plain words, when it is:

1. **empty** — whitespace only;
2. **a pleasantry** — "thanks", "ok", "done", "got it", "sounds good", …
   (checked *before* the length rules, so "thanks" is refused as a pleasantry
   and not as "too short" — the more specific reason is the one a person
   reads);
3. **too short** — under 8 characters after trim;
4. **too long** — over `MEMORY_NOTE_LIMIT` (500). Refused, not truncated: a
   memory silently cut in half is a memory that says something its author
   did not mean;
5. **a question** — ends with `?` and no other terminal. Questions are not
   memories, they are the opposite of memories.

The `reason` is returned so the caller can LOG a refusal (the same way
`RunStore` logs a damaged record) rather than swallow it. A refusal that
nobody heard is how an agent ends up remembering nothing and nobody knows
why.

---

## 6. The retrieval rule — oldest kept, newest dropped

`retrieveMemory(notes, budget)` spends the budget from the **oldest** end
forwards, the **opposite** of `renderConversation` (which spends newest-first
and always keeps the newest). The reason is the reason the whole module
exists: memory is what the conversation has *forgotten*. The newest memory
is also the most likely to still be in the conversation window, so dropping
it costs the least; the oldest memory is the foundation, and a foundation
that disappears between one turn and the next is an agent that has forgotten
who its owner is.

A single note longer than the whole budget is still included — truncated,
and it says so — because dropping it would leave the agent without the one
note that wanted to be heard.

---

## 7. The durability promises (same as `RunStore`)

`MemoryStore` writes one file per note, inside the agent's OWN folder:

```
<dataDir>/agents/<agentId>/memory/m-<time>-<noise>.json
```

- **Safe paths have one owner.** `isSafeStoredId` is the same rule the relay,
  `RunStore` and `Engine.writeSkillFiles` use, asked of BOTH the id and the
  name it turns into. The finished path is then checked with the same
  `path.relative` backstop. A second, subtly different rule is how a hole
  gets opened, so there isn't one.
- **Write-then-rename.** Through the one owner of that rule, `wholefile.ts`,
  so a power cut between "empty the file" and "fill it" can never leave half
  a note under a name `list` trusts.
- **Torn, not lost.** Bytes that are not a note carry nothing and hold a
  slot, so they go, AND IT IS SAID OUT LOUD — the log names the file and the
  reason. A file we merely could not *read* (busy, locked) is left exactly
  where it is; deleting it would be the bug.
- **Fail safe.** Nothing in `MemoryStore` throws at its caller. If the disk
  is full, the folder is read-only, or the JSON is corrupt, the next turn
  still gets whatever memory it could read and the failure goes to the log.
- **One rule for what a note is.** `validateNote` type-checks every field
  (the way `validateRunRecord` checks a run), so `{"id":42,"text":"soup"}`
  is refused, not half-believed.

---

## 8. The handoff contract — pure builder, no execution

`buildHandoff(input)` turns a few facts into a checked `AgentHandoff`. It
**throws `HandoffError`** on bad input — unlike `MemoryStore.save`, which
swallows. The difference is deliberate: a store that cannot write must not
cost the owner an answer, but a builder that cannot build has nothing to
hand on and the caller has a bug. A malformed handoff thrown here is a bug
caught at the seam, not a job lost mid-flight.

`validateHandoff(value)` is the same rule applied to an object that arrived
over the wire or off the disk, where throwing would be the wrong answer. It
returns `null` or a plain-words sentence, and never throws — the same shape
as `validateRunRecord` and `validateNote`.

### What is reused, not reimplemented

- **ids** — `isSafeStoredId` (the relay / `RunStore` / `MemoryStore` rule).
- **branches** — `isSafeBranchName` from `worktree.ts` (the one owner of
  "is this a branch Cloud9 will carry"). A handoff branch must start with
  `cloud9/`.
- **artifacts** — `ArtifactRef` from `@cloud9/shared`; the `artifactId` is
  checked with `isSafeStoredId`, the `version` (if present) must be a
  positive integer.

### What is refused

- an agent handing off to itself (`fromAgentId === toAgentId`);
- an empty or blank task, or a task over `HANDOFF_TASK_LIMIT`;
- a context pointer whose `kind` is not one of the four, or whose `ref` is
  empty;
- an unsafe branch, an unsafe run link, an unsafe overridden id;
- a note over `HANDOFF_NOTE_LIMIT`.

---

## 9. Engine wiring — what the engine builder does next

This is the contract the wiring is written against. None of it is built
here, because `engine.ts`, `host.ts` and `provider.ts` are not this file's to
touch.

### 9.1 Memory

1. **Construct one `MemoryStore` per engine**, the same way one `RunStore`
   is constructed, sharing the engine's existing `dataDir` / `agentDataDir`
   decision.
2. **Seed each turn** by calling `retrieveMemory(store.list(agentId))` and
   prepending it to the prompt (or to the `context` field of `RespondInput`).
   The string is already budgeted.
3. **Remember after a turn** by calling `worthRemembering` on whatever the
   agent or the owner said that the engine decides is worth keeping, then
   `store.save` with a fresh `newMemoryId()` and `runId` set to the run that
   produced it. Refusals are logged, not swallowed.
4. **Forget on agent removal** by calling `store.forget(agentId)`, the same
   place `RunStore.forget` is called.

### 9.2 Handoff

1. **Build a handoff** with `buildHandoff` when an agent's reply contains a
   recognised "@AgentB take this" intent. The builder throws on bad input;
   catch `HandoffError` at the seam and log it.
2. **Validate on the wire** with `validateHandoff` in the relay (the same way
   `validateRunRecord` is used). A handoff that does not check out is
   dropped, not obeyed.
3. **Do not execute from inside the builder.** Choosing a runner, a channel
   and an approval policy is the engine's job. The builder produces a shape;
   the engine turns the shape into a `Task` (or whatever the wire type for
   "do this" becomes) and sends it through the existing approval gate.

---

## 10. Test counts

- `agent-memory.test.ts` — **17 tests**, all passing. Covers the
  worth-remembering rule (kept + each kind of noise), the store (write, read,
  list oldest-first, prune, forget), safe paths, fail-safe, damaged-note
  refusal, nonsense-note refusal, the derived store cap, and retrieval
  (oldest kept, empty, kind/source rendering, single-too-long).
- `agent-handoff.test.ts` — **18 tests**, all passing. Covers the builder
  (required + optional fields, blank note dropped, generated ids), the rule
  (self-handoff, empty/long task, bad pointer kind, empty pointer ref,
  unsafe branch, long note, bad run link, unsafe overridden id), the
  validator (accepts a built handoff, refuses nonsense with every key
  present, refuses non-objects, never throws), and a JSON round-trip.

Both suites were made to **fail once first** (a pleasantry rule that fired
after the short-check; a retrieval test that asserted on ids the renderer
does not emit), then fixed — the "prove fail once" requirement.

---

## 11. Order to wire this in

1. Re-export the new symbols from `packages/engine/src/index.ts` (one line
   each) once there is a caller. The published surface should not widen
   before then.
2. Wire `MemoryStore` into `Engine` alongside `RunStore` (§9.1).
3. Wire handoff intent detection into the agent-reply path and `validateHandoff`
   into the relay (§9.2).
4. Add wire types to `packages/shared` when the relay needs to carry a
   handoff — the same shape as `AgentHandoff`, moved verbatim, the way
   `RunRecord` was moved. A test should assert *identity* of the validator,
   not equality, so a second copy cannot quietly reappear.
