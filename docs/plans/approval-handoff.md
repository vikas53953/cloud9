# Asking mid-run — handoff to the screen

**Written by:** the protocol/hub/engine agent, 2026-07-30.
**Owns:** `packages/shared/src/**`, `packages/engine/src/**`, `apps/relay/src/**`.
**This document is the request to whoever owns `apps/desktop/src/**`.**

---

## 1. What was broken, in one paragraph

An agent could already prepare its own git worktree, work in it and commit —
proven against Vikas's real repository. **Pushing and opening a pull request
were permanently closed**, because the only approval Cloud9 had was job-shaped:
`createTask` with `needsApproval`, decided *before* a background job starts.
Nothing could ask *mid-run* "may I push this?". `GitHubClient` is closed by
default, nobody was ever wired in to be asked, so the worktree flow ended at
"committed locally" and his GitHub feature could not work.

**It works now, end to end, against `vikas53953/cloud9`.** See §6.

---

## 2. The frames, and what authorises each one

Everything below is in `packages/shared/src/index.ts` and is what the relay
really speaks.

### Out (client → hub) — ENGINE ONLY

```ts
| { type: "askApproval"; askId: string; agentId: ID; channelId: ID;
    taskId?: ID; facts: RemoteActionFacts }
```

**The screen never sends this.** It is refused from a desktop connection, and
that refusal is a test: a client able to mint approval cards could manufacture a
harmless-looking one and then approve it with its own second frame.

`decideApproval` is unchanged and is **the only way to answer** — the same frame
the screen already sends for a job-shaped approval.

### In (hub → client)

```ts
| { type: "approval"; approval: Approval }        // already handled — see §3
| { type: "approvalAsked"; askId: string; approvalId: ID }   // engine only
```

`approvalAsked` is the hub's receipt to the ENGINE, so an engine with several
agents waiting knows which decision belongs to which. `apps/desktop/src/store.ts`
drops it in the same named-and-ignored block the four `project*` frames use —
**one line, already added, with a comment saying why.** That is the only change
made to a file this agent does not own.

### What decides what

| Question | Answered by | Where |
|---|---|---|
| May this connection ask at all? | `conn.client === "engine"` | `askApproval` |
| Whose agent is this? | `myAgent` (stored state) | `askApproval` |
| Which room is it in? | `channelFor` (stored state) | `askApproval` |
| Must this be asked about? | `mustAskBeforeActing(agent, { remoteAction })` | shared — engine AND hub |
| What words does he read? | `describeRemoteAction(facts)` | hub, from facts |
| Is the job it names really this agent's? | `store.task().agentId === agent.id` | `askApproval` (dropped, not obeyed) |
| Who may decide? | `approval.ownerId === conn.userId` | `decideApproval` (unchanged) |
| Who may SEE it? | `sendApproval` — an `action` card goes to its owner alone | hub |
| When does it die? | `expiresAt` + `scheduleExpiry` + `sweepExpiredApprovals` | hub |

---

## 3. What CHANGED on `Approval` — read this before drawing anything

```ts
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalKind = "task" | "action";

interface Approval {
  id: ID;
  taskId?: ID;              // ← NOW OPTIONAL
  agentId: ID; ownerId: ID;
  action: string;           // the sentence he reads
  status: ApprovalStatus;
  decidedBy?: ID; decidedAt?: number; createdAt: number;
  kind?: ApprovalKind;      // ← ABSENT MEANS "task"
  remoteAction?: RemoteAction;  // "push" | "pullRequest" | "createRepo"
  channelId?: ID;
  detail?: string;          // the smaller line — "2 files changed"
  expiresAt?: number;       // only on an `action` card
}
```

**Four things that will bite you:**

1. **`taskId` is optional now.** An agent can be asked to push in ordinary
   conversation with no job at all. `ApprovalMoment` already does
   `task?.title ?? approval.action`, so it degrades correctly today — but do not
   add anything that assumes a task exists.
2. **`expired` is a fourth status and it is NOT a quiet `rejected`.** He said no
   versus he never saw it are different events. Draw it differently, and never
   as a red error: nothing happened, which is the safe outcome.
3. **`kind === "action"` cards are OWNER-ONLY.** They name a branch, a
   repository and a diff size. The hub already narrows the audience; the screen
   does not need to filter, but must not assume a guest ever sees one.
4. **`detail` is absent when we do not know.** Same rule as run records: a row
   whose value is absent is not rendered at all. No "0 files".

---

## 4. What a person sees — the ask (§4.1)

This is what the hub really produced on the real end-to-end run:

```
┌ 🔒 Architect wants to do something outside this computer
│ push 1 commit to a new branch cloud9/architect-1 on vikas53953/cloud9
│ 1 file changed
│
│ ASKED         09:26 today
│ AGENT         Architect
│ EXPIRES       in 10 minutes
│
│ [ Approve ]   [ Not now ]
└
```

- `approval.action` is the bold line, **verbatim**. Do not reword it, do not
  shorten the branch name, do not turn the repository into a link that could
  point somewhere else. Every noun in it came from `git` and `gh`, not from the
  agent, and that is the whole reason it can be trusted.
- `approval.detail` is the smaller line. Omit the line when absent.
- The EXPIRES row is `approval.expiresAt`. When it passes, an `approval` frame
  arrives **unasked** with `status: "expired"` — the hub sets a timer, so this
  happens whether or not anyone is looking. Replace the buttons with "nobody
  answered — it didn't happen".
- The mock's `.callout` with `dl.kv` rows and an `.actions` row is already the
  right shape; `App.tsx` line ~2344 `ApprovalMoment` is already the component.
  It needs the `kind`/`remoteAction`/`detail`/`expiresAt` fields drawn and the
  `expired` status handled — nothing structural.

### Where it should appear

`approval.channelId` says which conversation the agent was working in. The card
belongs there, and in the Tasks panel beside the job-shaped ones. It is the one
kind of approval that is genuinely urgent — an agent is standing still waiting
for it — so the existing gold "N approvals waiting" pill should count it.

### What it must NOT say

- Never "the agent is pushing…" while the card is pending. Nothing has happened.
- Never show a card for someone else's agent. `ownerId` is the only person who
  can answer, and the hub only sends it to them.

---

## 5. The engine side, so the screen does not re-do it

- `ApprovalDesk` (`packages/engine/src/approvaldesk.ts`) holds every waiting
  agent. A wait is a promise with one unref'd timer — **no loop, no poll, no
  blocked socket.** Other agents keep taking turns while one waits.
- `Engine.githubFor(agent, { channelId, taskId? })` returns a `GitHubClient`
  wired to that desk. That single function is what turned "closed by default"
  into "answerable".
- **Silence is never a yes.** The deadline passing, the hub disconnecting, the
  engine stopping and a malformed answer are all NO, each with its own
  plain-words reason the agent can say out loud.
- The engine's own leash and the hub's `expiresAt` are independent on purpose.
  Whichever fires first refuses; neither can produce a yes.

---

## 6. Proof, run for real on 2026-07-30

Not a fake runner. Real relay, real engine, real agent, real worktree off this
repository, real `git`, real `gh`, real GitHub.

| Scenario | Result |
|---|---|
| He says **no** | `push a branch to GitHub needs your approval first — push 1 commit to a new branch cloud9/throwaway-approval-proof-no-… on vikas53953/cloud9`. `git ls-remote` confirmed GitHub never got the branch. |
| He says **yes** | Branch `cloud9/throwaway-approval-proof-ms719pem` pushed; **pull request #2 opened** into `master`; confirmed by `gh pr view 2` reading `{"state":"OPEN","baseRefName":"master",…}`. |
| **Nobody answers** | After 22 seconds: refused, `git ls-remote` confirmed nothing reached GitHub. |
| Trail | 7 `approval_requested` / `approval_decided` rows in the activity ledger. |

**Cleaned up in the same run:** PR #2 closed (`gh pr view 2` → `CLOSED`), remote
branch deleted (`ls-remote` empty), worktrees removed, local `cloud9/*` branches
gone. An earlier partial run created **PR #1**, closed and cleaned the same way.
Nothing was ever pushed to `master`.

---

## 7. Still open, and honest about it

- **No agent turn calls `githubFor` yet.** The round trip is proved with the
  engine driving it directly. Wiring it into an agent's own turn — "the agent
  decides it wants to push" — is the next round, and it needs the PROJECTS
  screen to say which repository an agent is working in.
- **`Worktree`, `PullRequest` and `GitHubAccount` are still engine-local.**
  `REMOTE_ACTIONS` and `RemoteActionFacts` moved to shared this round because
  three programs needed them. The rest move when Projects gets a screen — see
  `engine-needs.md` §8. **Do not let the screen define a second pull-request
  shape.**
- **A found bug, fixed:** `GitHubClient.pullRequestFor` asked gh for
  `--json number,url`, and `run.ts` refuses a comma. Against the real runner it
  threw every time and only a fake runner had ever called it. Fixed by asking
  for the URL alone; there is now a test that drives every argument this file
  builds through the real `safeArg`, so the next one fails in the suite instead
  of in front of him.
