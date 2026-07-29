# Contract for the 2026-07-30 night round

Three agents run at once. Vikas is asleep; nothing may be asked of him. His
five-plus-two requests are in `RESUME.md` under "FROM VIKAS USING IT". This file
is the seam between the agents so they cannot collide or invent two versions of
one fact.

## Who owns what
| Agent | Owns | Must not touch |
|---|---|---|
| **Screens** (already running) | `apps/desktop/src/**`, `scripts/qa.mjs` | `packages/**`, `apps/relay/**` |
| **Protocol & hub** | `packages/shared/src/**`, `apps/relay/src/**` | `apps/desktop/src/**`, `packages/engine/**`, `scripts/**` |
| **Engine** | `packages/engine/src/**` | everything else |

Engine needs new shared types: it must NOT add them itself. It writes the exact
shape it needs into `docs/plans/engine-needs.md`; Protocol & hub adds them.
Until they exist, Engine may define a local type of the same shape and swap
later — the swap is the point, so name it in the handoff.

## The three facts both halves must agree on

### 1. Presence — his item 2 (a BUG: everything shows offline)
The screen must show what is TRUE, never a guess. The engine is the only thing
that knows, because it holds the harness state and runs the turns.

```ts
type AgentPresence =
  | "ready"      // its harness is installed, signed in, and the engine is up
  | "working"    // mid-turn right now
  | "paused"     // the owner paused it (lifecycle)
  | "offline";   // the engine is not running, or its harness is not signed in
```
Rules, so nobody invents a fourth answer:
- `offline` is the honest default when the engine is not connected — the hub
  must NOT report `ready` for an agent nobody can run.
- `paused` beats `ready`; `working` beats both.
- The reason must travel with it (`"Codex is not signed in"`) so the screen can
  say why rather than showing a grey dot with no explanation.
- Existing `agentStatus` already carries idle/working/braked. EXTEND that path
  rather than adding a second one — one source, one frame.

### 2. A finished job says what happened — his item 3
When a delegated job finishes, the agent writes a short TLDR itself (he
explicitly agreed the agent should write it). It rides on the existing `Task`,
not a new entity: `Task.summary?: string`.
- The engine writes it when the job completes, from the run record it already
  has. Absent when the job failed with nothing to say — never a filler sentence.
- The hub stores and broadcasts it like any other task field, authorised
  through the gates that already exist.
- The screen highlights the finished job and shows the summary. Screens agent
  owns that; Protocol must broadcast it.

### 3. Agents react with emoji as work happens — his item 5
Reactions already exist (`react` frame, `Reaction` with `removedAt`). Agents use
the SAME mechanism — do not build a second one.
- The engine reacts to the message that asked for the work: picked up, working,
  done, failed. A small fixed set, defined ONCE in shared, never per call site.
- The hub must accept a reaction from an engine connection on behalf of an
  agent, authorised exactly as `agentSend` already is.

## Standing rules for this round
- Class over case: one owner per rule, in one file.
- Every change needs a test that fails before it. Prove it by putting the bug
  back if there is any doubt — that is how the approval hole was confirmed real.
- Do not weaken: the injection guards, credential stripping, `mayDriveAgent`,
  `mustAskBeforeActing`, the personal-config isolation, or any existing test.
- Baselines verified by the conductor before this round: build clean apart from
  the screens agent's in-flight edits, **203 engine, 117 relay**.
- No commits, no pushes. The conductor commits after re-running the evidence.
- If a usage limit stops you, say exactly where you stopped. Half-applied
  protocol changes are the worst thing to hand over.
