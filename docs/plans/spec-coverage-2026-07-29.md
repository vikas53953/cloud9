# Spec → Code coverage audit — 2026-07-29

**Source of truth:** `docs/plans/spec.md` (Agent Workforce Platform).
**What this is:** an honest check of every requirement in spec §10 and every
acceptance criterion in spec §24 against the code that actually exists today.
**Read-only audit.** No code was changed.

**Important caveat about timing.** Two builders were editing `packages/**` and
`apps/desktop/src/**` while this audit ran. Files changed underneath the audit
mid-read. Anything below marked **IN PROGRESS** is being worked on right now and
should not be read as either done or missing. Snapshot taken at
commit `984e86c` plus 11 uncommitted files.

---

## 0. The one-paragraph answer

Cloud9 is a real, working group-chat app with agents in it. Talking to agents,
shared channels, handing over jobs, approving them, and seeing who did what —
all of that exists and is wired end to end. What does **not** exist yet is the
part of the spec that makes an agent an *expert worker* rather than a chat
personality: agents cannot use any outside tool, nothing records what an agent
actually did during a job, agents cannot hand work to each other, agents
remember nothing between conversations, and there is no workspace/roles layer.
The previous coverage map (`traceability.md`) says **15 of 16** acceptance
criteria are met. The honest number is **12 of 16**. Details in §4 and §6.

---

## 1. Headline numbers

| | Done | Partial | In progress | Not built | Total |
|---|---:|---:|---:|---:|---:|
| **P0 requirements** | **30** | 11 | 2 | 2 | **45** |
| **P1 requirements** | **6** | 5 | 0 | 8 | **19** |

- **P0: 30 of 45 done** (67%).
- **P1: 6 of 19 done** (32%).
- **Spec §24 acceptance: 12 of 16 met.** Unmet: #2 (web GUI), #6 (agent
  connected to a provider — in flight and unproven live), #11 (only authorised
  context and tools), #12 (controlled actions require approval).
- Requirements the spec itself blocks (`TBD` priority) are excluded from the
  counts above: 26 of them. They are listed in §5 with the exact question each
  one needs answered.

**Build state right now:** `npm run build` **fails**. Nine TypeScript errors,
all in test files (`packages/engine/src/harness.test.ts`, `host.test.ts`,
`apps/relay/src/integration.test.ts`), because the `HarnessInfo` shape gained
required fields and two functions (`extractSetupToken`, `onClaudeToken`) were
deleted by the in-flight auth rewrite. The tests were not updated with them.
This means **`npm test` cannot run at all today**, so the "64 tests green"
claim in `PIPELINE.md` and `traceability.md` describes commit `082767b`, not
the code on disk. This is a normal mid-change state, not a shipped breakage —
but it must be fixed before anyone says "done" again.

---

## 2. Requirement-by-requirement — spec §10

Status key: **DONE** (built and tested) · **PARTIAL** (some of it) ·
**IN PROGRESS** (a builder is on it now) · **NOT BUILT** ·
**BLOCKED-TBD** (spec forbids guessing; needs Vikas's words).

### 10.1 User and workspace

| ID | Pri | Status | Evidence | What's missing |
|---|---|---|---|---|
| FR-UW-001 authenticated account | P0 | PARTIAL | `apps/relay/src/store.ts:ensureOwner/userByToken/redeemInvite`; join screen `apps/desktop/src/App.tsx:JoinScreen` | It is a shared secret string, not an account — no password, no email, no sign-out, and a fresh checkout ships with a token everyone knows (`DEFAULT_OWNER_TOKEN` in `apps/relay/src/server.ts:33`). |
| FR-UW-002 access a workspace | P0 | PARTIAL | one relay process = one implicit space | There is no Workspace object in the code at all; you get exactly one space and cannot make another. |
| FR-UW-003 workspace holds humans and agents | P0 | DONE | `apps/relay/src/server.ts` (users, agents, channels); `apps/relay/src/integration.test.ts` "cloud9 end-to-end" | — |
| FR-UW-004/005/006 membership, roles, personal-vs-org | TBD | BLOCKED-TBD | — | Needs the workspace decision (see §5, Q6). |

### 10.2 Provider connections

| ID | Pri | Status | Evidence | What's missing |
|---|---|---|---|---|
| FR-PC-001 connectable architecture | P0 | DONE | `packages/engine/src/provider.ts:ClaudeProvider` — one interface, four implementations (`MockProvider`, `SdkProvider`, `ClaudeCliProvider`, `CodexProvider`) | — |
| FR-PC-002 Claude as a provider | P0 | **IN PROGRESS** | `packages/engine/src/claude-cli.ts:ClaudeCliProvider` (new, uncommitted); detection `packages/engine/src/harness.ts:detectClaude` | The whole Claude sign-in path is being replaced this minute (CLI-login-first). The new provider file has **no tests yet**, and no real Claude answer has ever been produced in Cloud9 on this machine. |
| FR-PC-003 Codex as a provider | P0 | **IN PROGRESS** | `packages/engine/src/codex.ts:CodexProvider`; `codex.test.ts` (11 tests, fixture transcripts) | The adapter itself is solid and tested. Its auth reporting is being rewired alongside Claude's. Also never proven live. |
| FR-PC-004 no unverified subscription claims | P0 | DONE | disclosure text in `apps/desktop/src/App.tsx:SettingsModal` (both HarnessCards); verdict recorded in `implementation-notes.md` | — |
| FR-PC-005 credentials not exposed | P0 | DONE | `apps/desktop/electron/main.cjs:saveSecret/loadSecret` (per-harness, OS-encrypted); `packages/engine/src/claude-cli.ts:envWithoutCredentials`; relay carries status booleans only (`server.ts:harnessState`) | — |
| FR-PC-006 more providers later | P1 | DONE | same interface; four implementations prove the seam | — |
| FR-PC-007/008 ownership, metering | TBD | BLOCKED-TBD | — | Nobody can see what a turn cost. See §5, Q8. |

### 10.3 Agent creation and management

| ID | Pri | Status | Evidence | What's missing |
|---|---|---|---|---|
| FR-AG-001..004 create / identity / role / instructions | P0 | DONE | `apps/desktop/src/App.tsx:AgentModal`; `apps/relay/src/server.ts` case `createAgent`; QA screenshot `docs/qa/02-create-agent.png` | — |
| FR-AG-005 associated with a provider | P0 | DONE | `AgentDef.provider` + `AgentDef.model` in `packages/shared/src/index.ts`; routing `packages/engine/src/engine.ts:providerFor`; `routing.test.ts` | — |
| FR-AG-006 explicit permission scope | P0 | PARTIAL | four on/off toggles (`AgentAbilities`) → tool names in `claude-cli.ts:claudeArgs` / sandbox flag in `codex.ts:codexArgs`; Bash refused on every path; `run.test.ts` | Four coarse switches is not a permission scope. There is no per-tool grant, no per-action grant, and no way to say "read only this folder". |
| FR-AG-007 enable / pause / disable | P0 | DONE | `AgentDef.lifecycle`; enforced in `chatter.ts:shouldReply`, `engine.ts:maybeRunTask/fireSchedule`; `chatter.test.ts` | — |
| FR-AG-008 edit after creation | P1 | DONE | `App.tsx:AgentEditModal` | — |
| FR-AG-009 duplicate an agent | P1 | NOT BUILT | — | No copy button, no template. |
| FR-AG-010..012 templates, marketplace, versioning | TBD | BLOCKED-TBD | — | — |

### 10.4 Communication

| ID | Pri | Status | Evidence | What's missing |
|---|---|---|---|---|
| FR-CM-001..005 send, reply, shared conversations, @addressing, agent identity | P0 | DONE | `server.ts:postMessage`; `engine.ts:considerReplies`; `chatter.ts:shouldReply`; `extractMentions` in `packages/shared`; `chatter.test.ts` (10 tests) + integration test | — |
| FR-CM-006 history available | P0 | DONE | SQLite `messages` table + `history` frame (`store.ts:history`) | Storage is done; the retention *policy* itself is a spec TBD. |
| FR-CM-007 agent hands work to another agent | P1 | PARTIAL | mention-driven agent-to-agent replies (`chatter.ts`) with a runaway brake | Agents can *talk* to each other. There is no handover of *work* — no object, no result coming back, no trace. |
| FR-CM-008 see working / waiting / blocked | P1 | DONE | `agentStatus` frames; status lamps in `App.tsx:agentStatusLine` | — |
| FR-CM-009/010 threads, reactions, attachments, voice | TBD | BLOCKED-TBD | — | — |

### 10.5 Task delegation and execution

| ID | Pri | Status | Evidence | What's missing |
|---|---|---|---|---|
| FR-TS-001 request an outcome | P0 | DONE | `!bg` / `!task` in chat → `engine.ts:considerReplies` → `createTask` | — |
| FR-TS-002..004 traceable record, status, result | P0 | DONE | `Task` + the eight §20 states in `packages/shared/src/index.ts`; relay handlers + `tasks` table; integration test "v2: task lifecycle" | — |
| FR-TS-005 stop or cancel | P0 | DONE | `cancelTask` frame; `engine.ts:runTask` discards a cancelled task's result; relay refuses to un-cancel | — |
| FR-TS-006 no tool outside scope | P0 | PARTIAL | `claudeArgs` passes `--allowed-tools` / `--disallowed-tools Bash`; `codexArgs` sets the sandbox | We *ask* the outside CLI to behave. Nothing checks or records that it did — if a tool ran outside scope, Cloud9 would not know. |
| FR-TS-007 more than one agent per task | P1 | NOT BUILT | `Task.agentId` is a single id | — |
| FR-TS-008 task keeps its context | P1 | PARTIAL | task stores `channelId`; the agent gets the last 20 messages (`engine.ts:renderContext`) | The task keeps a pointer to a channel, not the work's own context. Nothing about the run is stored. |
| FR-TS-009/010 scheduling, long-running model | TBD | PARTIAL / BLOCKED-TBD | `scheduler.ts` + chat commands work | The formal model is a TBD; also everything stops when the desktop app closes. |

### 10.6 Agent-to-agent collaboration

| ID | Pri | Status | Evidence | What's missing |
|---|---|---|---|---|
| FR-AA-001 agent requests work from another | P1 | NOT BUILT | — | Mentions produce a chat reply, not a work request. |
| FR-AA-002 delegated work stays traceable to the person | P1 | NOT BUILT | — | Nothing to trace yet. |
| FR-AA-003 delegation must not expand permissions | P1 | NOT BUILT | — | The spec's one hard invariant (§19) is not enforced anywhere in code. |
| FR-AA-004 inspect handoffs | P1 | NOT BUILT | — | — |
| FR-AA-005/006 manager agents, conflict resolution | TBD | BLOCKED-TBD | — | — |

### 10.7 Tools and external systems

| ID | Pri | Status | Evidence | What's missing |
|---|---|---|---|---|
| FR-TL-001 architecture supports giving agents tools | P0 | PARTIAL | abilities → the harness CLI's own built-in tools (web search, read/write files) | There is **no tool adapter layer at all** (spec §18). An agent cannot touch a calendar, an inbox, a spreadsheet, or any outside system. |
| FR-TL-002 tool access explicitly granted | P0 | PARTIAL | four toggles per agent | Grant is coarse and covers only the built-ins. |
| FR-TL-003 tool calls tied to the acting agent and task | P0 | **NOT BUILT** | — | No tool-call is recorded anywhere. Audit stops at "this agent posted a message" / "this task finished". |
| FR-TL-004 sensitive tool actions can need approval | P0 | PARTIAL | `AgentApprovals` covers two things: starting background work, and creating a schedule (`server.ts` case `createTask`) | **No tool action can require approval.** `traceability.md` marks this DONE; that is overstated — what exists is approval for *handing over a job*, not for *what the agent does during it*. |
| FR-TL-005 failures in understandable language | P1 | PARTIAL | `provider.ts:sanitizeForChat`, `HARNESS_DISCONNECTED_REPLY` | Plain-words messages exist for harness failures, but they deliberately hide all detail ("details are in the app's log") and there are no tool failures to report yet. |
| FR-TL-006 different tool protocols / connector types | P1 | NOT BUILT | — | — |
| FR-TL-007..009 first tools, user connectors, marketplace | TBD | BLOCKED-TBD | — | See §5, Q3. |

### 10.8 Context and memory

| ID | Pri | Status | Evidence | What's missing |
|---|---|---|---|---|
| FR-ME-001 enough authorised context | P0 | PARTIAL | last 20 channel messages (`engine.ts:renderContext`); per-agent folder (`engine.ts:agentDataDir`); skills text injected (`provider.ts:renderSkills`) | An agent starts every conversation blank apart from the last 20 lines. It cannot remember a past job, a decision, or a person. |
| FR-ME-002 context respects boundaries | P0 | PARTIAL | the engine only sees its owner's channels; an agent is fed only the channel it is in | Never tested as a boundary; no code that would *stop* a leak, just a shape that avoids one. |
| FR-ME-003 user can see what an agent may use | P0 | **NOT BUILT** | — | There is no screen anywhere that shows what an agent knows or keeps. |
| FR-ME-004 user can remove or update it | P1 | NOT BUILT | — | — |
| FR-ME-005/006 memory model, shared memory | TBD | BLOCKED-TBD | — | See §5, Q5. |

### 10.9 Approvals and control

| ID | Pri | Status | Evidence | What's missing |
|---|---|---|---|---|
| FR-AP-001 request approval before configured actions | P0 | DONE | `Approval` entity; `server.ts` case `createTask` with `needsApproval` | Done for the two categories that exist. |
| FR-AP-002 request identifies agent, task, action | P0 | DONE | `Approval.agentId/taskId/action`; shown in `App.tsx:TasksModal` | — |
| FR-AP-003 approve or reject | P0 | DONE | `decideApproval` frame; Approve/Reject buttons | — |
| FR-AP-004 rejected actions do not run | P0 | DONE | rejected → task `cancelled`; a decided approval cannot be re-decided (`server.ts:328-350`); integration test | — |
| FR-AP-005 decisions recorded | P1 | DONE | `approval_decided` activity record with the decider's name | — |
| FR-AP-006 expiry, delegation, multi-approver | TBD | BLOCKED-TBD | — | — |

### 10.10 Cross-client access

| ID | Pri | Status | Evidence | What's missing |
|---|---|---|---|---|
| FR-CL-001 web GUI | P0 | **PARTIAL** | the same React renderer runs in a browser via Vite; all Playwright QA runs this way | This is the desktop app's screen opened in a browser against a hub on your own PC. There is nothing hosted, nothing reachable when your PC is off, no web sign-in, and saving a key silently does not work in a browser. `traceability.md` calls this DONE; it is not what spec §13.1 describes. |
| FR-CL-002 desktop chat application | P0 | DONE | `apps/desktop/electron/main.cjs`; smoke-tested; `Start Cloud9.cmd` launcher | — |
| FR-CL-003/004 state consistent, continue from another client | P0 | DONE | relay is the single source of truth; QA check 12 | — |
| FR-CL-005 monitor status from another client | P1 | DONE | `agentStatus` broadcast to every client | — |
| FR-CL-006 native mobile | TBD | NOT BUILT | `apps/mobile/App.js` — a 1-file Expo scaffold, never run on a device | `traceability.md` calls this PARTIAL; for product purposes it is not built. Spec marks it TBD anyway. |
| FR-CL-007/008 responsive web, offline | TBD | BLOCKED-TBD | — | — |

### 10.11 Notifications

| ID | Pri | Status | Evidence | What's missing |
|---|---|---|---|---|
| FR-NT-001 notify when approval is needed | P1 | PARTIAL / **IN PROGRESS** | desktop pop-ups for new messages + quiet hours just landed (`App.tsx:357-363`, `inQuietHours`) | Nothing fires specifically when an approval is waiting — you find out only because the agent also posted a chat line. |
| FR-NT-002 notify on completion / failure / blocked | P1 | PARTIAL | finished background jobs post a `proactive` message, which does raise a pop-up | Failure and blocked states raise nothing distinct; mobile push is logged to a table and never delivered (`store.ts:logPush`). |
| FR-NT-003/004 channels, quiet hours, escalation | TBD | PARTIAL | quiet hours exist in the UI | Preferences are per-browser (`localStorage`), not per-account. |

### 10.12 History and auditability

| ID | Pri | Status | Evidence | What's missing |
|---|---|---|---|---|
| FR-AU-001 agent actions attributable | P0 | DONE | `activity` table + `logActivity`; `App.tsx:ActivityModal` | — |
| FR-AU-002 approvals attributable to a person | P0 | DONE | `approval_decided` with `decidedBy` | — |
| FR-AU-003 enough history to explain what occurred | P0 | **PARTIAL** | activity records cover messages, task transitions, approvals, agent/channel/invite events | You can see that a job started and finished. You cannot see **what the agent did** — no steps, no tool uses, no reasoning trail. For a product whose promise is delegating work, this is the weakest "DONE" in the old map. |
| FR-AU-004 inspect task history | P1 | DONE | Tasks panel + Activity panel | — |
| FR-AU-005 export, retention, immutability, search | TBD | BLOCKED-TBD | — | See §5, Q7. |

---

## 3. What is IN PROGRESS right now (do not count either way)

All of this is uncommitted work by the two active builders. Verified present on
disk today:

| Item | Where it stands |
|---|---|
| CLI-login-first provider auth | `harness.ts` rewritten (visible-terminal fallback, 5-minute hard cap, `authKind`), `claude-cli.ts` is new. **Its old tests still reference deleted functions, so the suite does not compile.** |
| Per-agent model selection | `AgentDef.model` is user-visible; `models.ts` is new; `App.tsx:RunsOn` / `DefaultModelPick` exist. **Not yet enforced at the relay** — `server.ts` calls `validateAgentInput` with no model list, so only the shape is checked there. The engine does check against the live list (`engine.ts:respondAs`). |
| Agent "skills" | Type + validation in `packages/shared`, injected into the prompt (`provider.ts:renderSkills`), files written safely (`engine.ts:writeSkillFiles`), editor built (`App.tsx:SkillsEditor`). **No tests.** |
| Design overhaul | Landed broadly — `App.tsx` is now 2,085 lines with a details rail, composer, empty states, presence, a real Settings with six sections. |
| Electron menu | Half-wired: `preload.cjs` exposes `onMenu`, but `main.cjs` **never builds a Menu**, so nothing can ever fire it. Also `App.tsx` calls `desktop().agentFolder` / `openAgentFolder`, which **do not exist in preload** — those Settings buttons are permanently disabled. |
| DM / duplicate people | `store.ts:redeemInvite` now de-duplicates, `dmBetween` and `removeUser` exist and are wired into `server.ts`. **No tests for any of it.** |

---

## 4. Spec §24 acceptance scorecard — **12 of 16**

| # | Criterion | Met? | Why |
|---|---|---|---|
| 1 | A human can access the platform | ✅ | Join screen + token/invite. |
| 2 | The platform provides a web GUI | ❌ | Only the desktop screen opened in a browser against your own PC. Nothing hosted; features degrade. |
| 3 | The platform provides a desktop chat application | ✅ | Electron app, launcher, smoke-tested. |
| 4 | A human can create a specialised agent | ✅ | Create modal → relay → engine. |
| 5 | The agent has an identifiable role | ✅ | Name, emoji, persona, and now skills. |
| 6 | The agent is connected to a supported provider or runtime | ⚠️ **In progress** | Two adapters exist behind one interface, but the auth path is being rebuilt today and **no agent has ever produced a real answer from a real provider in Cloud9**. Cannot be claimed until Vikas sees one. |
| 7 | The human can communicate with the agent | ✅ | DMs, channels, quick chat. |
| 8 | Humans and agents share a conversation | ✅ | Shared channels with @mentions. |
| 9 | A human can delegate an outcome | ✅ | `!bg` / `!task`. |
| 10 | Work is represented as a traceable task | ✅ | Task entity, 8 states, persisted, tested. |
| 11 | The agent uses only authorised context and tools | ❌ | Four coarse toggles are passed to an outside CLI as a request. Nothing verifies or records what was actually used. |
| 12 | Controlled actions can require human approval | ❌ | Approval exists for *starting a job* and *creating a schedule* — not for any action the agent takes while working. |
| 13 | Agent activity can be attributed and reviewed | ✅ | Activity log with actor, kind, time. (Thin — see FR-AU-003 — but the criterion is met.) |
| 14 | State continues across supported clients | ✅ | Relay is the single source of truth. |
| 15 | Claude and Codex accommodated without coupling | ✅ | One `ClaudeProvider` interface, four implementations. |
| 16 | Moves the user from operating apps to delegating to agents | ✅ | Directionally yes: you describe an outcome in chat and a named expert takes it. |

### Blunt corrections to `docs/plans/traceability.md`

That file was written before the current round and is now wrong in several
places. In order of how much it matters:

1. **"15 of 16 acceptance criteria" is not true.** The honest count is 12 of 16.
2. **FR-TL-004 is marked DONE. It is not.** No tool action can require
   approval. What was built is approval for delegating a job.
3. **FR-CL-001 (web GUI) is marked DONE. It is PARTIAL.** Running the desktop
   renderer in a browser is not the web GUI spec §13.1 asks for.
4. **FR-PC-002 (Claude) is marked DONE on the strength of `claude setup-token`.**
   Feedback round 1 proved that flow hangs forever; it is being replaced right
   now. The claim is stale.
5. **FR-AU-001..004 are marked DONE across the board.** FR-AU-003 ("enough
   history to explain what occurred") is not met — nothing records what an
   agent did inside a job.
6. **"64 tests green" is stale.** The working tree does not compile today.
7. **FR-CL-006 mobile is marked PARTIAL.** A never-run scaffold is not partial
   delivery.
8. **Whole spec areas are absent from the map entirely:** tool adapters (§18),
   governance (§22.6), the memory model (§10.8 beyond a folder), notifications
   (§10.11), and workspaces (§9.2).

---

## 5. What we have missed

### (a) Genuinely missing, nothing blocking it — ranked by how much it hurts

1. **Nothing records what an agent did during a job.** (FR-TL-003, FR-AU-003,
   FR-TS-008, criteria #11 and #13.) Both CLIs already emit a structured
   event stream — `codex exec --json` gives one JSON line per step, `claude -p
   --output-format json` gives a result envelope — and Cloud9 throws all of it
   away except the final sentence (`codex.ts:parseCodexJsonl`,
   `claude-cli.ts:parseClaudeJson`). This is the single biggest gap between
   what the product claims and what it can show.
2. **The permission model is four checkboxes.** (FR-AG-006, FR-TS-006,
   criterion #11.) Spec §19 describes seven layers. Nothing enforces the one
   hard invariant in the spec — that delegation must not increase permissions.
3. **The test suite does not compile, and the newest code has no tests.**
   `claude-cli.ts`, `models.ts`, skills, DM de-duplication and `removeUser` are
   all untested. Fixing this is a prerequisite for saying "done" about anything.
4. **The Electron menu is half-wired and two Settings buttons are dead.**
   `preload.cjs` exposes `onMenu` with no menu behind it; `agentFolder` /
   `openAgentFolder` are called by the renderer and do not exist.
5. **Agents cannot hand work to each other.** (FR-AA-001..004, FR-CM-007,
   FR-TS-007.) They can only chat at each other with a runaway brake.
6. **Agents remember nothing.** (FR-ME-001, FR-ME-003, FR-ME-004.) Every
   conversation starts blank apart from the last 20 lines. There is no screen
   showing what an agent keeps.
7. **Approvals and failures raise no notification of their own.**
   (FR-NT-001/002.) You find out by reading the chat.
8. **No duplicate-agent button** (FR-AG-009) — small, but it is the cheapest
   route to "reusable agent roles" (§22.3).

### (b) Blocked on a spec TBD — the exact question to ask Vikas

The spec forbids guessing these (rules 4–6). One question each, in his words:

| # | Ask him | Unblocks |
|---|---|---|
| Q1 | "Do you still have the four outcomes and four target users you picked in the original intake tool? I need the exact wording — the spec won't let me invent them." | spec §6, §7; all acceptance criteria for v2 (PARKING-LOT D1) |
| Q2 | "What's the first *outside* thing you want an agent to actually touch — your calendar, your email, a spreadsheet, a website, your files? Pick one." | FR-TL-007, §18, and everything in chunk 3 below |
| Q3 | "Beyond 'start this job' and 'make a schedule', what should an agent have to ask your permission for before doing it?" | FR-AP-006, FR-TL-004, criterion #12 |
| Q4 | "What should an agent remember about you between conversations — and what should it definitely forget?" | FR-ME-005/006, §25.7 |
| Q5 | "Should your agents keep working when the desktop app is closed?" | §25.4, FR-TS-010, and whether the engine moves to an always-on machine (PARKING-LOT B7) |
| Q6 | "Is Cloud9 one shared space for you and your friends forever, or do you want separate spaces with different people and different rules in each?" | FR-UW-004/005/006, §9.2, §22.6 governance |
| Q7 | "How long should the activity log be kept, and do you ever need to export it?" | FR-AU-005, PARKING-LOT D5 |
| Q8 | "When you use Cloud9 in a browser, is it fine that it only works while your own PC is on — or do you want a real website you can open from anywhere?" | FR-CL-001, criterion #2 — this is the biggest scoping question in the list |
| Q9 | "For v2, what's the smallest thing that would make you say this is finished?" | §23 / PARKING-LOT D6 — orders everything else |

### (c) Things the spec requires that nobody has started

- **Web GUI as a first-class client** — spec §13.1, FR-CL-001, criterion #2.
- **Tool adapter contract** — spec §18, all thirteen bullets. Zero code.
- **Workspaces, roles, governance** — spec §9.2, §22.6, FR-UW-004/005/006. No
  Workspace object exists.
- **Memory model** — spec §10.8 beyond "a folder per agent".
- **Notifications as a system** — spec §10.11 beyond desktop pop-ups; mobile
  push is logged and never delivered.
- **Mobile** — spec §10.10 FR-CL-006. A scaffold, never run.
- **Cost control and usage visibility** — spec §15.8, FR-PC-008. Nothing shows
  what a turn cost or stops a runaway (only the chatter brake, which counts
  messages, not money).
- **Non-functional targets** — spec §15 as a whole: no performance targets, no
  accessibility standard, no observability beyond `console.log`.

---

## 6. How we proceed — six chunks, in value order

Ordered by the product's core thesis (*delegate outcomes to expert agents*),
not by what's easy.

### Chunk 1 — Land the round that's in flight, and get to green
**Delivers:** the sign-in that actually works, a model picker per agent, skills,
the real app menu, one person appearing once. Plus a test suite that runs again.
**Closes:** FR-PC-002, FR-PC-003, FR-AG-005 properly; criterion #6.
**Size:** small-to-medium — most of it is written; this is finishing and proving.
**Must include:** rewrite `harness.test.ts` / `host.test.ts` /
`integration.test.ts` to the new `HarnessInfo` shape; first tests for
`claude-cli.ts`, `models.ts`, skills, DM de-duplication and `removeUser`;
build the actual Electron `Menu` in `main.cjs`; add the missing `agentFolder` /
`openAgentFolder` IPC; make the relay validate the model against the live
harness list, not just its shape.
**Decide first:** nothing. This is already directed work.
**Ends when:** Vikas clicks Sign in, asks a Claude agent something, gets a real
answer, and does the same for a Codex agent. No agent can prove this for him.

### Chunk 2 — Show the work: a job you can open and read
**Delivers:** every handed-over job gets its own page showing the steps the
agent took, which tools it used, what it read or wrote, how long it took, and
what it produced — in plain words. Plus a pop-up when a job needs your approval
or fails.
**Closes:** FR-TL-003, FR-AU-003, FR-TS-008, FR-NT-001, FR-NT-002; strengthens
criteria #11 and #13.
**Size:** medium-large. The raw material already arrives — both CLIs stream
structured events we currently discard.
**Decide first:** nothing blocking. (Q7 on retention improves it but is not
required to start.)
**Why second:** this is what turns "an agent said it did it" into "here is what
it did". Every later chunk — tools, delegation, governance — needs this record
to exist first.

### Chunk 3 — One real outside tool, behind a proper adapter
**Delivers:** an agent can genuinely do a thing in the outside world (the one
Vikas names in Q2), through a connector that declares what it can do, which
parts are read-only, and which need his OK before they run.
**Closes:** FR-TL-001, FR-TL-002, FR-TL-004, FR-TL-006; FR-AG-006 and FR-TS-006
properly; criteria #11 and #12; spec §18 and §19.
**Size:** large. This is the biggest single build left.
**Decide first:** **Q2** (which tool) and **Q3** (which actions need approval).
Cannot start without both — spec rules 4–6 forbid guessing either.
**Why third:** this is the thesis. Until an agent can act outside the chat
window, "delegate outcomes" is still "have a conversation".

### Chunk 4 — Memory the owner can see and edit
**Delivers:** agents remember what matters between conversations, and there is
one screen showing exactly what each agent keeps — with a delete button.
**Closes:** FR-ME-001, FR-ME-003, FR-ME-004; strengthens FR-ME-002.
**Size:** medium.
**Decide first:** **Q4** (what should be remembered, what forgotten).
**Why fourth:** an expert worker who forgets you every morning is not an expert
worker. But it is worth less than tools, so it follows them.

### Chunk 5 — Agents handing work to agents, safely
**Delivers:** one agent can ask another to do part of a job; the handover is a
real record you can open; the second agent can never do more than the first was
allowed to.
**Closes:** FR-AA-001..004, FR-CM-007, FR-TS-007; spec §19's hard invariant;
spec §22.2.
**Size:** medium-large.
**Decide first:** nothing new — but it **depends on chunks 2 and 3**. A handoff
needs a work record to live in and a permission model it cannot escape.
**Why fifth:** this is "a digital company" rather than "a set of assistants" —
high value, but it is unsafe to build before permissions are real.

### Chunk 6 — Workspaces, people and rules
**Delivers:** more than one space, with named people, roles, and rules about who
may create agents, connect apps, attach tools, approve actions, or see activity.
**Closes:** FR-UW-002, FR-UW-004, FR-UW-005, FR-UW-006; spec §22.6.
**Size:** large — it touches every table and every screen.
**Decide first:** **Q6** (one shared space or many) and **Q9** (v2 finish line).
**Why last:** it is the right shape for a product with many users. Today there
is one user and a few friends, and building it earlier would slow every other
chunk down.

### Sitting outside the sequence — one decision to make early

**The web GUI (Q8).** It is a P0 requirement and acceptance criterion #2, and it
is currently the weakest "done" in the old map. If Vikas wants a real website he
can open from anywhere, that is its own large chunk and it changes where the
engine lives (see Q5) — so it should be asked **now**, before chunk 3 sets the
shape of the tool layer. If "it works in a browser while my PC is on" is
genuinely enough for him, then the spec should be updated to say so rather than
the code being marked done against a requirement it does not meet.

---

## 7. Files worth knowing (plain-words roles)

| File | What it is |
|---|---|
| `docs/plans/spec.md` | The product bible. Nothing may be guessed around it. |
| `docs/plans/traceability.md` | The previous coverage map. **Now out of date — superseded by this file.** |
| `packages/shared/src/index.ts` | The shared dictionary: what an agent, a task, an approval, a message is. |
| `apps/relay/src/server.ts` | The hub every screen and every agent talks to. |
| `apps/relay/src/store.ts` | The filing cabinet (SQLite). |
| `packages/engine/src/engine.ts` | The part that decides when an agent speaks and runs its turn. |
| `packages/engine/src/provider.ts` | The seam that keeps Cloud9 from being welded to one AI company. |
| `packages/engine/src/claude-cli.ts` | New: runs a turn on the Claude app already on this PC. |
| `packages/engine/src/codex.ts` | Runs a turn on the Codex app already on this PC. |
| `packages/engine/src/harness.ts` | Finds those two apps and handles signing in. |
| `apps/desktop/src/App.tsx` | The whole screen. |
| `apps/desktop/electron/main.cjs` | The desktop window, the ⌘K popup, and the locked box where keys are kept. |
