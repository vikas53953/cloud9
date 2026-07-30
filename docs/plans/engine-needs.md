# What the engine needs from `@cloud9/shared`

Written by the ENGINE agent in the 2026-07-30 night round. Per
`round-contract-2026-07-30.md` the engine may not add shared types itself, so
this file is the request queue. Protocol & hub owns `packages/shared/src/**`.

Status of each item is one of:

- **LANDED** — Protocol added it and the engine now imports it. Nothing to do.
- **STILL NEEDED** — the engine works around it today; the workaround is named.

---

## 1. Presence — LANDED

Asked for: the four-word presence set, a reason that travels with it, and one
function that decides which is true.

Landed as `AgentPresence`, `AgentPresenceState`, `PresenceFacts`,
`agentPresence()`, `harnessLabel()`, `PRESENCE_LIMITS`, `isAgentPresence()`, and
the widened `agentStatus` server frame (`status` + `presence` + `reason`).

The engine imports `agentPresence` in its tests to pin what the hub will make of
the facts it sends. **No local copy of the presence rule was ever written**, and
none should be: the engine's job is the facts, the hub's job is the verdict.

## 2. `Task.summary` — LANDED

Asked for: somewhere on the existing `Task` for the agent's own TLDR, plus a way
to send it.

Landed as `Task.summary?: string`, `updateTask.summary?: string`,
`TASK_LIMITS.summary` (500) and `validateTaskSummary()`. The engine sends it on
the same `updateTask` frame that already reports the status, and checks it with
`validateTaskSummary` before sending so an unusable sentence is dropped here
rather than bouncing off the hub mid-job.

## 3. Work reactions — LANDED

Asked for: the fixed set of work emoji defined ONCE, and a frame letting an
engine react on behalf of an agent it owns.

Landed as `WORK_REACTIONS` (`picked` 👀, `working` ⚙️, `done` ✅, `failed` ❌),
`WorkReaction`, `WORK_REACTION_EMOJI`, `isWorkReaction()` and the `agentReact`
client frame.

`packages/engine/src/reactions.ts` **re-exports** `WORK_REACTIONS` rather than
restating it, and `reactions.test.ts` asserts object IDENTITY with shared's — two
lists that happen to agree today are exactly the drift that check exists to
prevent.

## 4. "Must ask before acting" — LANDED, and the engine's copy is now gone

`mustAskBeforeActing` in shared is the single owner. `needsApprovalToRun` in
`packages/engine/src/abilities.ts` used to decide it a second time from the
engine's own capability table; it now simply calls shared's function.
`abilities.test.ts` holds the engine's `alwaysAskAbilities()` and shared's
`ALWAYS_ASK_ABILITIES` to each other, so a new always-ask switch added to one and
not the other fails a test instead of quietly disagreeing.

---

## STILL NEEDED

### 5. `PresenceFacts.canRun?: boolean` — demo mode reads as offline

The hub infers "can this agent take a turn" from `HarnessInfo.installed` and
`signedIn`. That is right in every case but one: **demo mode**. With demo mode
on, the engine answers with `MockProvider` whether or not either app is
installed, so every agent is genuinely usable while the hub reports `offline`.

The engine is the only thing that knows, and it already knows exactly — it is
`providerFor(agent) !== undefined`.

```ts
export interface PresenceFacts {
  engineConnected: boolean;
  harness?: Pick<HarnessInfo, "installed" | "signedIn">;
  status?: AgentStatus;
  /**
   * The engine's own answer to "could this agent take a turn right now?" —
   * it holds the providers, so it is the only thing that can say. When present
   * it OUTRANKS the harness booleans, because a demo-mode engine really will
   * answer and a signed-in app whose model list came back empty really will not.
   */
  canRun?: boolean;
}
```

`HarnessState.demo` already travels, so the hub could also read demo mode off
that; `canRun` is preferred because it covers the second case too (an agent whose
model is not on its harness's real list is refused at the last gate and would
otherwise still show `ready`).

**Workaround today:** none. Demo mode shows agents as offline while they answer.
It is a visible wrong lamp rather than a silent one, and demo mode is always
banner-stamped on screen, so it is honest-ish — but it is wrong.

### 6. `HarnessInfo.checked?: boolean` — so "we haven't looked" needn't be inferred

The engine's half of his presence bug was that detection PUBLISHES A PLACEHOLDER
before it runs (both apps `installed: false`, detail "not checked yet") for the
local settings spinner, and that placeholder was being forwarded to the hub as
though it were a finding. Every agent then goes grey on a machine where both apps
are signed in.

Fixed engine-side by not sending it: `Engine.reportHarness(state, looked)` drops
the frame until `HarnessManager.hasDetected` is true, which leaves
`PresenceFacts.harness` ABSENT — a state shared already documents and says out
loud ("its engine is running — Claude hasn't reported in yet").

A `checked` boolean on `HarnessInfo` would let the placeholder travel WITH its own
caveat instead of being withheld, which is slightly better: the settings card
could then show its spinner from the hub's copy of the state too.

**Workaround today:** the frame is withheld. Cost: for the first few seconds
after the engine connects, a client reading harness state through the hub has
nothing to draw. Covered by `presence.test.ts`.

### 7. `Task.askMessageId?: ID` — so a tick cannot land on the wrong message

An agent's work emoji go on the message that ASKED for the job. The engine sends
`createTask`, the hub mints the id, so for a moment the engine knows the message
but not the job. `packages/engine/src/reactions.ts` bridges that gap by
remembering the ask (agent + channel + exact title) and matching the task back to
it when it arrives — oldest match first, capped at 50, no match meaning no ticks.

It works and is tested, but it is a correlation rather than a fact. Carrying the
message id on `createTask` and storing it on the `Task` would make it a fact:

```ts
| { type: "createTask"; agentId: ID; channelId: ID; title: string;
    requesterId?: ID; needsApproval?: boolean; action?: string;
    /** the message that asked for this job, so its ticks land on the right one */
    askMessageId?: ID }
```

with `Task.askMessageId?: ID` alongside. The hub should still check the message
is in that channel — it is a claim, not a permission, exactly like `requesterId`.

**Workaround today:** the local correlation described above. It is only wrong if
two identical asks in one room are answered out of order, and it fails SAFE (no
ticks) rather than ticking somebody else's message.

### 8. Git, worktrees and pull requests — nothing shared yet, and that is correct for now

`worktree.ts` and `github.ts` are entirely engine-local, with local shapes
(`Worktree`, `CommitResult`, `PullRequest`, `RemoteAction`, `GitHubAccount`).
None of them need to be shared **yet**, because no screen draws them and the hub
does not store them.

That changes the moment PROJECTS gets a screen (his item 7: a project holds its
repository, its pull requests and its issues). At that point these become wire
types and must move to shared in one go, the way `RunRecord` did. Do not let the
screen define a second shape for a pull request.

The one shared thing that WILL be needed first:

### 9. A mid-run approval round trip

Anything that leaves this machine goes through `GitHubClient`, whose gate is
CLOSED BY DEFAULT: built without an approver it refuses everything, and there is
no bypass. Today the only approval that exists is job-shaped — `createTask` with
`needsApproval`, decided before the job starts — which is exactly right for "may
this agent run an unattended job at all" and is already forced on for any agent
that can run programs (`mustAskBeforeActing`).

What does not exist is asking him at the MOMENT of the push, when the branch is
real and the diff can be described:

```ts
// client → hub, engine only
| { type: "askApproval"; agentId: ID; channelId: ID; taskId?: ID;
    action: string;   // "push branch cloud9/a1-x to GitHub"
    detail?: string } // "3 files changed, 41 lines"
// hub → client
| { type: "approvalDecided"; approvalId: ID; decision: "approved" | "rejected" }
```

**Workaround today:** the engine wires no approver by default, so **no agent can
push or open a pull request until a host explicitly supplies one.** That is a
refusal, not a hole — but it also means the worktree flow currently stops at
"committed on its own branch, locally". Naming that plainly: **the push and
pull-request halves are built, tested against a fake gh, and NOT reachable from
a real agent turn yet.**
