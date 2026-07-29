# Cloud9 — Phase 3 (wire-up) + Phase 7 (AI-code hygiene) audit

**Run:** 2026-07-29 · **Scope:** code-level only. **AUDIT ONLY — nothing was fixed.**
Measured against the 16 journeys in `docs/qa/journeys.md`, the spec
(`docs/plans/spec.md`), the owner's 15 complaints (`docs/plans/feedback-round-1.md`)
and the security round (`docs/plans/security-fixes-2026-07-29.md`).

## How to read the tags

| Tag | Means |
|---|---|
| **CONFIRMED** | Proved by reading the code. The break is unambiguous — a missing `case`, a frame nobody sends, a menu action with no handler — and the report gives the user-visible symptom plus the manual repro Vikas can run. |
| **UNVERIFIED** | Depends on something only a live run can settle (a real CLI answer, a second computer, actual timing). Written as a question, never as a verdict. |

The app was **not launched** in this session (this was a reading pass, and
`App.tsx`/`styles.css` were being rewritten by another agent while I read).
Nothing below is tagged from a browser observation. See **Not tested**.

`apps/desktop/src/App.tsx` line numbers are as of the file at 2156 lines — it is
under active rewrite, so line numbers may have moved; the symbol names have not.

---

# Part 1 — Wire-up table (journey → path → status)

| # | Journey | Click → frame → storage | Status |
|---|---|---|---|
| **J1** | First run | `preload.cjs:11` `sendSync("cloud9:ownerToken")` → writes `localStorage["cloud9.token"]` before app code → `App.tsx:App` sees a token → `client.connect` → `hello` → `welcome`. Dev shows `JoinScreen` pre-filled with `dev-owner-token`. No API key asked for anywhere. | **WIRED** |
| **J2** | Connect my AI apps | Settings mount → `refreshHarness`+`harnessStatus` → `server.ts:460` `assertHarnessAllowed` → `toEngines` → `host.ts:161` → `harness.refresh()` → `detectClaude`/`detectCodex` → `engine.reportHarness` → `server.ts:506` → `toUser` → `world.harness` → `HarnessCard`. **Cancel is fully wired now:** `App.tsx:1899` `harnessCancel` → `shared/index.ts:253` → `server.ts:490` (clears `signInFlight`+`signInAt`) → `host.ts:164` → `harness.ts:317` `cancelSignIn` → poll loop ends, no `problem` left on the card. | **WIRED**, one gap → **M1** |
| **J3** | Hire an agent | `AgentModal.create` → `createAgent` (name, persona, provider, model, abilities, approvals, skills) → `server.ts:291` `validateAgentInput` w/ the harness's real model list → `store.saveAgent` (SQLite `agents.json`) → `broadcast agent` → rail row shows `Claude · Sonnet 5`. | **WIRED**, two gaps → **M1, M2** |
| **J4** | Give it a skill | `SkillsEditor` → `skills[]` on `createAgent`/`updateAgent` → `validateSkills` (`shared:386`) → stored inside the agent JSON → reopening the modal reads `full.skills`. Add / edit / delete / upload all reach the DB. Engine puts them in the prompt: `provider.ts:55 renderSkills` → `buildAgentPrompt` → used by **all three** providers. **Skills really do reach the prompt.** | **WIRED**, one data-loss trap → **M3** |
| **J5** | Talk to an agent, real answer | `Composer.sendNow` → `send` → `server.ts:235` `channelFor` → `postMessage` → SQLite → engine `considerReplies` → `chatter.ts:47` (DM ⇒ always reply) → `takeTurn` → `respondAs` (re-validates model against the live list) → `ClaudeCliProvider` → `claude -p --output-format json` on stdin → `agentSend` → back to the room. | **WIRED**, demo-mode risk → **B2** |
| **J6** | Agents + people in one room | `ChannelModal` → `createChannel`; `AddToChannel` → `addMembers`; `@Name` → `extractMentions` → `message.mentions` → `shouldReply` → agent replies; agent rows render with `authorKind === "agent"` → **"Agent"** badge (`App.tsx` `MessageRow`). | **WIRED** |
| **J7** | Hand over a job | `@Agent !bg …` → engine `engine.ts:187` → `createTask` → `server.ts:353` (`myAgent` + `channelFor`, approval decided server-side) → SQLite `tasks` → `task` broadcast → `TasksModal` + details rail. Cancel = the **Stop** button → `cancelTask` → `server.ts:409`. | **WIRED**, wrong attribution → **M4** |
| **J8** | Approve or refuse | approval → dock strip in `ChatView` + `TasksModal` → `decideApproval` → `server.ts:426` → rejected ⇒ `task.status = "cancelled"`, `error = "rejected by owner"` → engine `maybeRunTask` only claims `not_started`, so **Reject really stops it**. | **WIRED** |
| **J9** | See who did what | `activity` frame on open → `store.activity` → `ActivityModal`, human vs agent split by `actorKind`. | **WIRED**, attribution drift → **M4**; menu route dead → **M5** |
| **J10** | Invite a friend | Owner: `createInvite` → `server.ts:320` (owner-gated) → `secureId("inv")` → `invites` table → `InviteModal`. Guest: `JoinScreen` → `hello "invite:<code>:<name>"` → `store.redeemInvite` (single-use, fresh account always) → durable token → `welcome`. | **BREAKS** → **B1, M6, M7** |
| **J11** | Ctrl+K anywhere | Renderer: `Workspace` keydown → `setQuick(true)`. Packaged Electron **also** registers `globalShortcut CommandOrControl+K` (`main.cjs:520`) which opens a separate frameless window instead. | **BREAK / conflict** → **M8** |
| **J12** | Click a person or agent | `openDm` → `findDm` (local) → else `createChannel kind:"dm"` → `server.ts:265` `dmBetween` **found-or-created** → `channel` frame → `world.lastChannel` → `setActiveId`. Never a dead click. | **WIRED**, dedupe caveat → **m2** |
| **J13** | Change how it behaves | Theme → `applyTheme`; default app+model → `prefs` → seeds `AgentModal`; quiet hours → `inQuietHours` gates the `Notification`; agent folder → `cloud9:openAgentFolder` IPC → `shell.openPath`. All real. | **WIRED**, persistence note → **m5** |
| **J14** | Use the menus | `main.cjs:402 toRenderer` → `preload.cjs:37 onMenu` → `App.tsx:307` `run(action)`. Handles only `new-agent`, `new-channel`, `settings`, `quick-chat`, `toggle-theme`. | **BREAK — 4 dead items** → **M5** |
| **J15** | It is a real app | `app.setName`, `setAppUserModelId(com.vikas.cloud9)`, `icon.ico`, NSIS Start-menu + desktop shortcuts, single-instance lock, `will-quit`/`window-all-closed` stop the engine **and** the hub. | **WIRED** (not re-run this session) |
| **J16** | It survives being closed | SQLite: users, tokens, invites, agents (with skills+model), channels, messages, tasks, approvals, activity. Schedules → `schedules.json`. Prefs/unreads → `localStorage`. | **WIRED**, two gaps → **m3, m6** |

## The owner's four re-checks, answered

| His complaint | Answer |
|---|---|
| **Is the model picker really persisted per agent?** | **Yes.** `RunsOn` → `model` state → `createAgent`/`updateAgent` → `validateAgentInput` → `store.saveAgent` writes the whole agent as JSON, model included → reloaded on `welcome`. It survives a restart. **But** a *legacy* agent with no stored model is still *displayed* with one — see **M2**. |
| **Do skills really reach the prompt?** | **Yes.** `provider.ts:55 renderSkills` is called by `buildAgentPrompt` (`provider.ts:74`), which is the prompt used by `ClaudeCliProvider`, `CodexProvider` and `SdkProvider` alike. Nothing in the chain is stubbed. |
| **Does "Remove a person" really remove them from every list?** | **No. The review's finding is still true.** `apps/desktop/src/store.ts` has **no `case "userRemoved"`** — grep over the whole of `apps/desktop/src` returns nothing. The relay broadcasts it (`server.ts:346`); the renderer drops it on the floor at the `default:` branch (`store.ts:186`). The person stays in the sidebar, in @-autocomplete and in the "Remove a person" dropdown until a reload. → **B3** |
| **Does the sign-in "Cancel" really cancel now?** | **Yes, end to end.** The renderer sends it, the frame exists in `ClientFrame`, the relay handles it and releases the six-minute lock, the engine host routes `"cancel"` explicitly, and `HarnessManager.cancelSignIn` ends the poll on its next tick leaving no failure on the card. The only leftover is cosmetic: the send is still behind a `as unknown as` cast (`App.tsx:1899`) → **m1**. |

## What is written to the database vs held only in memory / localStorage

| Data | Lives in | Survives restart? |
|---|---|---|
| Users, tokens, invites (`usedAt`, `revoked`) | SQLite `cloud9-relay.db` | Yes |
| Agents — incl. `model`, `provider`, `skills`, `approvals`, `lifecycle` | SQLite (whole agent as JSON) | Yes |
| Channels, messages, tasks, approvals, activity, push log | SQLite | Yes |
| Schedules | `<dataDir>/schedules.json` | Yes |
| Skill files on disk | `<dataDir>/agents/<id>/skills/` | Yes — but **nothing ever writes there**, see **M3** |
| **Agent status lamps** (`Relay.agentStatus`) | **relay memory only** | **No** |
| **Harness state** (`Relay.harness`) | **relay memory only** | **No** |
| **Sign-in locks** (`signInAt`, `signInFlight`) | **relay memory only** | No (fine) |
| **Every setting** — theme, default app+model, quiet hours, notifications, compact, collapsed sections | **`localStorage["cloud9.prefs"]`** | Yes on this computer; **does not follow the user to another client** |
| **Unread markers** (`cloud9.lastRead`) | `localStorage` | Same |
| Relay session token | `localStorage["cloud9.token"]` | Yes |
| Claude/Codex credentials | OS keychain via `safeStorage`, main process only | Yes — **never in the renderer** |

---

# Part 2 — Findings, ranked

## Blockers — the user cannot proceed

### B1 — A guest with a spent or wrong invite code sees the app silently fail · CONFIRMED
`server.ts:153-166` sends `{ type:"error", error:"that invite has already been used — ask for a new one" }` and closes the socket. The renderer stores that in `world.lastError` (`store.ts:184`), but the only thing that renders `lastError` is `Toast()`, which is mounted **inside `Workspace`** (`App.tsx:607`) — a screen the guest never reaches. `JoinScreen` (`App.tsx:224`) renders no error at all. The socket then retries on an empty token, gets `"bad token"`, and the guest lands back on the join screen with **no explanation**.
*This is the handoff item "the join screen must show why an invite was refused", still open.*
**Repro:** owner makes an invite → a second window redeems it → a third window redeems the same code. Expect: a plain sentence next to the code box. Actual: the app just fails to connect.

### B2 — The dev launcher runs agents in demo mode, so a signed-out harness produces fake answers · CONFIRMED (code) / UNVERIFIED (live)
`Start Cloud9.cmd:38` launches the engine host with `set CLOUD9_DEMO=1`. In `host.ts:74-109` demo mode is the **third** fallback, so it only fires when no credential is held *and* the CLI is not detected as signed in — but when it fires, `MockProvider` (`provider.ts:87`) answers with a canned, persona-flavoured line that reads exactly like a real reply. J5 says the answer must be "not a canned demo line". The engine's own doc-comment states the law: *"a signed-out harness must never quietly turn into fake answers that look real"* — and the launcher opts straight into breaking it.
**Repro:** rename/shadow `claude` and `codex` on PATH, run `Start Cloud9.cmd`, DM an agent. Expect: "my engine isn't connected — open Settings and sign in." Actual (predicted): a confident fake answer.

### B3 — Removing a person does not remove them from any list until a reload · CONFIRMED
`apps/desktop/src/store.ts` `onFrame` has cases for `welcome`, `token`, `message`, `channel`, `agent`, `agentDeleted`, `agentStatus`, `invite`, `task`, `approval`, `activity`, `harness`, `history`, `userJoined`, `error` — and **no `userRemoved`**. Grep for `userRemoved` across `apps/desktop/src`: **0 hits.** The relay does broadcast it (`server.ts:346`). Their agents *do* vanish (`agentDeleted` is handled); the person does not.
**Repro:** Settings → Danger zone → Remove a person. Actual: toast says "asked to remove…", the name stays in the People list, in the @-autocomplete and in that very dropdown. Restart the app and they are gone.

## Majors — works wrong, unwired, or promises what the backend won't do

### M1 — The app never asks for harness state until Settings is opened · CONFIRMED
`WorldState` (`shared:259`) carries no harness field, and the relay only replies with its cached `harness` in answer to an explicit `harnessStatus`/`refreshHarness` (`server.ts:460`). The only place the renderer sends either is `SettingsModal`'s mount effect (`App.tsx:1612`). Consequence: open Cloud9, go straight to **Hire an agent**, and the model dropdown is the shipped fallback list with the hint *"This is the list Cloud9 ships with"* — even when the engine reported the real list before this window connected.

### M2 — An agent with no stored model is still shown running one · CONFIRMED
Four display sites default the model for the screen — `App.tsx:707` (rail), `:910` (message run-strip), `:1120` (details rail), plus the crew chip — all `a.model ?? MODEL_DEFAULT[provider]`. The run does **not** default it: `claude-cli.ts:74` is `if (agent.model) { args.push("--model", …) }`, and `codex.ts:129` the same. So a pre-round-2 agent is labelled **"Claude · Sonnet 5"** while the turn actually runs on whatever the CLI's own default is. The UI states a fact the run does not honour. (New agents are always given a model, and editing one fixes it — the blast radius is agents created before this round.)

### M3 — Skill file upload never becomes a file, and editing a skill would delete its files · CONFIRMED
`SkillsEditor.upload` (`App.tsx`) reads a `.md`/`.txt` and puts the whole body into `instructions` — it never populates `AgentSkill.files`. So the entire disk path is unreachable from the UI: `shared:36 AgentSkillFile`, `shared:441 isSafeSkillFileName`, `engine.ts:250 writeSkillFiles`, and the *"Files in your folder: …"* line in `renderSkills` are all dead in practice. Worse, the renderer's **local** `AgentSkill` interface (`App.tsx:27`) omits `files`, and `save()` rebuilds a `clean` object from `id`/`name`/`description`/`instructions` only — so if a skill ever *did* carry files, editing it would silently drop them. Latent today; a data-loss bug the moment the field is used.

### M4 — Delegated jobs are attributed to the owner, never to the person who asked · CONFIRMED
`server.ts:360`: `const requester = this.store.users().find(u => u.id === conn.userId)!` — but `createTask` always arrives on the **engine's** connection (`engine.ts:191`), whose user is the owner. So a friend typing `@Scout !bg book the villa` produces a task reading **"asked by Vikas"** in the Tasks panel, and an activity row attributed to Vikas. J9 requires "human and agent actions attributed correctly"; FR-AA-002 requires delegated work stay traceable to the initiating user. Same root cause makes `task_created` activity rows read as human-Vikas rather than agent-Scout (`audit()` only takes `asAgent` on the `updateTask` path).

### M5 — Four menu items are dead clicks · CONFIRMED
`main.cjs` sends nine actions; `App.tsx:307-311` handles five. Dead: **File → Invite someone…** (`invite`, has an accelerator `Ctrl+Shift+I`), **Edit → Find in conversation…** (`search`, `Ctrl+F`), **View → Activity** (`activity`), **View → Tasks** (`tasks`). Each is a visible, enabled, keyboard-shortcut-bearing menu item that does nothing. J14 says "nothing is a dead click."
**Repro:** in the packaged app press `Ctrl+Shift+I`, or click View → Tasks. Nothing happens.

### M6 — "Invite a friend" is offered to guests, who can only ever get an error · CONFIRMED
`createInvite` became owner-only in this security round (`server.ts:324`). The renderer shows the invite affordance unconditionally — the People section head's `＋` (`App.tsx:522`) and the "Only you so far · Invite a friend" empty state (`:548`). A guest clicking either gets `"Error: only the owner of this Cloud9 can invite someone"` in a toast. `WorldState` still has no `ownerId`, so the renderer literally cannot tell. (Same shape: Danger zone's "Remove a person" is shown to everyone and gated only server-side.)

### M7 — An invited friend on another computer cannot connect at all · CONFIRMED (structural)
The relay binds loopback only, and in the packaged app that is **hardcoded**: `main.cjs:291` `bind: "127.0.0.1"`, with no setting or UI to change it. `RelayOptions.bind` exists but nothing packaged passes anything else. There is no tunnel, no LAN mode, no relay-server option. So J10 ("have someone join with it, exchange messages") can only ever be exercised as a second window on Vikas's own PC. The invite feature is real; the transport under it is not.

### M8 — Ctrl+K is registered system-wide and takes over the whole computer · CONFIRMED
`main.cjs:520` `globalShortcut.register("CommandOrControl+K", toggleQuickWindow)`. A global shortcut is captured OS-wide, so while Cloud9 is running **every other application loses Ctrl+K** (VS Code's chord prefix, Slack's link dialog, browsers' search bar). It also means the in-app handler in `Workspace` never fires in the packaged app — J11 is served by the separate frameless window instead, which is a different experience from the in-place overlay the journey describes ("without losing my place").

### M9 — `npm audit`: 1 critical, 29 high, 1 moderate · CONFIRMED
Real output, this session:

```
npm audit --json → metadata.vulnerabilities
{ "info": 0, "low": 0, "moderate": 1, "high": 29, "critical": 1, "total": 31 }
  dependencies: { "prod": 15, "dev": 525, "optional": 98, "peer": 8, "total": 556 }
```
Head of the report:
```
app-builder-lib  *   Severity: high
  electron-updater: Uncontrolled search path elements within AppImage built by app-builder-lib
  → GHSA-7g7r-gx96-252g
  fix available via `npm audit fix --force`  (installs electron-builder@26.15.3, breaking)
brace-expansion  <=5.0.7   Severity: high
  DoS via unbounded expansion length causing an out-of-memory process crash
  → GHSA-mh99-v99m-4gvg
```
**Triage:** every advisory sits in the `electron-builder` **dev** tree (`app-builder-lib`, `dmg-builder`, `@electron/asar`, `@electron/universal`, `config-file-ts`, `ejs`, `tar`, `archiver`, `brace-expansion`/`minimatch`). Prod dependencies are 15 and none are flagged. Nothing here ships to a user; the exposure is the build machine and the integrity of the installer it produces. The fix is a major-version bump of `electron-builder` (25 → 26) and needs a re-pack + re-verify, not a blind `--force`.

## Minors

| # | Finding | Where | Tag |
|---|---|---|---|
| **m1** | Six `as unknown as Parameters<typeof client.send>[0]` casts remain, disabling the exact type check that would have caught the missing `harnessCancel` frame. The handoff asked for all of them to go. | `App.tsx:1462, 1612, 1820, 1899, 1903, 2096` | CONFIRMED |
| **m2** | `onePerPerson` dedupes by id **and then by lower-cased name** — so a genuine second person who happens to share a first name is silently hidden from the sidebar, @-autocomplete, channel modal and Danger zone. A renderer band-aid over a relay bug the relay has since fixed. | `App.tsx:184-196` | CONFIRMED |
| **m3** | Agent status lamps and harness state are relay-memory only. After a hub restart every agent shows its default line until its engine speaks again. | `server.ts:43, 49` | CONFIRMED |
| **m4** | Relay errors reach the user as raw `String(err)`, so the toast reads `"Error: only the owner of this Cloud9 can invite someone"`. Visible — but the `Error:` prefix is exactly the jargon the house style forbids. | `server.ts:116` | CONFIRMED |
| **m5** | Every setting lives in `localStorage`, not the database. Fine for one computer; means J13's choices do **not** follow Vikas to the web client, which FR-CL-004 implies they should. | `App.tsx:285` `makeStore("cloud9.prefs")` | CONFIRMED |
| **m6** | `prefs.set` swallows a failed `localStorage.setItem` with `catch { /* ignore */ }` — a settings change that could not be saved reports success. | `App.tsx:263` | CONFIRMED |
| **m7** | The composer's `!bg` and `@` buttons **append** to the end of the text. Type "book the villa" then click `!bg` and you get `book the villa !bg `, which fails the engine's `/^!(bg\|task)\s+/` and becomes an ordinary chat message instead of a tracked job. | `App.tsx` `Composer.insert` / `engine.ts:187` | CONFIRMED |
| **m8** | `bridge?.onMenu?.(run)` returns an unsubscribe function that is never called; the effect's cleanup only removes the `window` listener. Leaks one IPC listener per mount. | `App.tsx:~322` | CONFIRMED |
| **m9** | `findDm`'s third fallback matches **any** ≤2-member channel, not just a `dm` — clicking a person could open an unrelated small channel. | `App.tsx` `findDm` | CONFIRMED |
| **m10** | `asar: false` in the packaging config, so the whole app source sits in plain files under Program Files. No secrets are in the source, so this is tamper-surface, not disclosure. | `apps/desktop/package.json` | CONFIRMED |

## Secrets — clean

- `git grep` for `sk-`, `sk-ant-`, `ghp_`, `AKIA…`, `xox…`, `BEGIN … PRIVATE KEY`, JWT prefixes across all tracked files: **the only hits are test fixtures and a README example** (`sk-ant-should-not-be-here`, `sk-user-test0123…`, `CLOUD9_CRED=sk-ant-…` in the README). All deliberately fake.
- `git log --all -p` scanned for the same real-key patterns: **zero hits**. No secret has ever been committed.
- `git ls-files` for `*.db`, `*.env`, `credential`, `token`: **zero**. `.gitignore` covers `*.db`, `*.db-*`, `cloud9-engine-data/`, `release/`.
- The renderer holds **no** credential by design: `store.ts:46 purgeLegacySecrets` actively deletes the v1 `cloud9.claudeCred`/`cloud9.claudeCredKind` keys on every start, and `HarnessCard` only ever *sends* a key to the main process (`cloud9:setApiKey`), never reads one back. `credentialStatus` returns booleans only.
- Credentials live in `safeStorage`-encrypted files under `userData`, one per harness. `main.cjs` logs **lengths**, never values (`main.cjs:71, 150`). `env.ts` strips credential-shaped variables from every spawned CLI.

**Verdict: no secret anywhere in the renderer, the repo, or git history.**

## Dependencies

All declared packages are real and used. `@anthropic-ai/claude-agent-sdk` (used by `SdkProvider`), `ws` (relay + engine), `react`/`react-dom`, `electron`, `electron-builder`, `vite`, `playwright`, `typescript` — no hallucinated names, no unused entries. `apps/mobile` is **not** in the root `workspaces` array, so its Expo deps are never installed — it is a scaffold, consistent with the journeys doc. `npm audit` is **M9**.

## Silent failures

43 `catch` sites across `apps/` + `packages/` (tests excluded). Only 11 are empty, and every one carries a comment explaining why swallowing is correct (unreadable storage, a file that was never there, a process already dead, `rmdir` on a non-empty folder). The one that matters is **m6**. The user-facing error path is genuinely wired: relay refusals arrive as `{type:"error"}` → `world.lastError` → `Toast` — except that `Toast` is unreachable on the join screen (**B1**).

## Dead code and drift

| Item | Detail |
|---|---|
| `Engine.backgroundTask` | `engine.ts:335`, private, **zero call sites** (grep confirms only the declaration + its `.d.ts`). Superseded by the Task machine. |
| `history` frame | Defined in `ClientFrame`, fully implemented in the relay (`server.ts:517`) and the store (`store.ts:170`) — and **the renderer never sends it**. Frame census: the renderer sends 15 of the 16 client frames; `history` is the one it doesn't. Practical effect: only the last 50 messages per channel are ever reachable, with no way to scroll further back. |
| `AgentSkillFile` disk path | `writeSkillFiles`, `isSafeSkillFileName`'s engine call site, and the "Files in your folder" prompt line are all unreachable from the UI — see **M3**. |
| `createTask.needsApproval` / `.action` | Still sent by the engine (`engine.ts:192-193`, `:403`) and **deliberately ignored** by the relay since the security round (`server.ts:366`). Harmless, but the protocol now lies about who decides. |
| `WorldState.ownerId` | Documented as needed in the security handoff, never added — the root cause of **M6**. |
| Test coverage claim | `security-fixes-2026-07-29.md` claims "96 engine, 23 relay (119 total)". **Verified this session — exactly right** (see below). But there are **zero** renderer tests and **zero** Playwright specs; every finding above sits in code no automated test touches. |

---

# Part 3 — Scale unknowns (n=1 assumptions, not bugs)

| Item | Where | State |
|---|---|---|
| **Loopback-only hub, hardcoded** | `main.cjs:291`, `server.ts:65` default `127.0.0.1` | **AT-RISK** — this is why **M7** exists. One computer is the whole product today. |
| **Port 8787 hardcoded in five places** | `store.ts:36`, `server.ts:679`, `main.cjs:34/296`, `Start Cloud9.cmd`, `wait-for-port.mjs` | AT-RISK — the packaged app does fall back to a free port, but the renderer's own default and the dev launcher do not. |
| **One owner per hub** | `Relay.ownerId` = whoever holds `ownerToken` | UNKNOWN — every harness power, every invite and every removal is that single account. |
| **All agents bill one subscription** | `host.ts` — one engine host, the owner's Claude/Codex login | **AT-RISK** — a friend's `!bg` job spends the owner's quota, and (per **M4**) is not even recorded as theirs. |
| **In-memory relay state** | `agentStatus`, `harness`, `signInAt`, `signInFlight` (`server.ts:43-59`) | AT-RISK — single-instance only; a second relay process would disagree with the first. |
| **Unpaginated / capped reads** | `tasks(200)`, `approvals(200)` (then `.slice(-200)` in JS, i.e. the whole table is parsed first), `recentMessages(perChannel=50)`, `activity(limit 100)` | AT-RISK — every `welcome` parses and ships up to 400 JSON blobs plus 50 messages × every visible channel. No UI paging anywhere (see the `history` gap). |
| **Whole-table JSON parsing** | `store.agents()`, `store.channels()` parse **every** row on every call — and `visibleChannels` calls both, from `channelFor`, on **every** `send`/`history`/`addMembers` frame | AT-RISK — fine at 3 channels, quadratic-feeling at 300. |
| **Broadcast-to-everyone** | tasks and approvals still go to every connected client (`broadcast`), acknowledged as unfixed in the security round | **AT-RISK** — a visibility leak, not an escalation. |
| **Turn concurrency = 2, context = 20 messages, history cap = 300/channel** | `engine.ts:210, 368, 149` | UNKNOWN at any real volume. |
| **Single WAL SQLite file** | `cloud9-relay.db` (the working copy already carries a **4.1 MB WAL** against a 311 KB db) | UNKNOWN — no checkpointing or vacuum story. |
| **`localStorage` as the settings store** | `App.tsx:285` | VERIFIED as per-machine by design; blocks cross-client settings (**m5**). |

---

# Part 4 — Not tested (an omission left unlisted is a claim it passed)

- **The app was never launched.** No smoke test, no click sweep, no browser or Electron session. Every finding above is code-level; the ones marked CONFIRMED are unambiguous in code but **none has been watched happening**.
- **Phase 4 (Playwright E2E) does not exist.** `find . -name "*.spec.ts"` outside `node_modules` returns **nothing**. There is no suite, so §4.0 harness pre-flight was not run. The `scripts/qa*.mjs` scripts were read but **not executed**.
- **Phases 1, 2, 5, 6, 8** — out of scope for this pass and not attempted.
- **The packaged app** (`%LOCALAPPDATA%\Programs\Cloud9\Cloud9.exe`) was not installed or opened. J15 is assessed from `main.cjs` + `package.json` only.
- **`apps/desktop/src/App.tsx` and `styles.css` are being rewritten right now** by another agent. Everything renderer-side is a snapshot of a moving file (2156 lines at read time). `styles.css` was not audited at all.
- **Real CLI behaviour** — `claude -p`, `claude auth status`, `codex exec`, `codex debug models` were never invoked. So: whether the Codex model list the CLI returns matches the renderer's shipped fallback (`gpt-5.6-sol` …) is **UNVERIFIED**, and so is whether an agent pointed at a fallback id actually runs.
- **The Claude `setup-token` visible-terminal fallback** — cannot be exercised without signing Vikas's CLI out (already listed as known-not-tested in `journeys.md`).
- **A second physical machine / any network beyond this PC** — not attempted. **M7** is derived from the code, not from a failed connection.
- **Mobile** (`apps/mobile`) — scaffold, not in the workspace, never run.
- **UI/UX, accessibility, mobile width, keyboard traversal** — Phase 6 work, not attempted.

---

# Part 5 — Test-count honesty

*Isolation only — not proof the app works.* Real output from this session:

```
npm test -w @cloud9/engine   → ℹ tests 96  ℹ pass 96  ℹ fail 0  ℹ skipped 0
npm test -w @cloud9/relay    → ℹ tests 23  ℹ pass 23  ℹ fail 0  ℹ skipped 0  (duration_ms 3742.8)
                               total 119 executed, 0 skipped, 0 failed
```
Executed > 0 and nothing skipped, so the counts are honest as counts. But **119 of 119 tests are engine and relay**: `find apps/desktop -name "*.test.*"` returns nothing, and there are no Playwright specs. **Every Blocker and Major in this report lives in code no test in this repo executes** — B1, B3, M1, M2, M3, M5, M6, M8 are all renderer or Electron-shell, and M4/M7 are relay behaviours no test asserts. That is why the suite is green while the four items above are broken.

---

# Part 6 — What actually works well

- **The security round holds up.** Invite redemption, the owner gate, `myAgent`/`channelFor`, server-side approval decisions, secure id/token minting, credential stripping — all read as genuinely fixed at the class level, with tests that name the bug they killed.
- **Skills reach the prompt.** One `buildAgentPrompt`, three providers, no divergence — and the skill text is explicitly fenced against prompt injection from the conversation.
- **The model is really persisted per agent** and re-validated at three separate gates (relay, engine, argv builder).
- **Cancel is genuinely fixed** across all four layers.
- **No secrets anywhere**, and an active purge of the v1 mistake from existing installs.
- **Error text does reach the user** through a real toast — the plumbing exists, it is just missing on one screen.
- **Deep-module discipline**: `channelFor`, `myAgent`, `isSafeSkillFileName`, `secureId`/`newId`, `envWithoutCredentials` are each one owner for one rule, which is why the drift in this report is at the edges rather than in the core.

# Part 7 — Top five fixes, by user impact

1. **B3 — add `case "userRemoved"` to `apps/desktop/src/store.ts`.** ~6 lines. It is Vikas's own complaint #15, was written out verbatim in the handoff, and is still not done.
2. **B1 — render `world.lastError` on `JoinScreen`.** Without it, every friend Vikas invites who reuses a link sees a dead app.
3. **M5 + M6 — finish the menu (`invite`, `search`, `activity`, `tasks`) and gate the invite affordance on ownership.** Four dead clicks plus a button that can only produce an error is exactly the "reads as a mock" complaint.
4. **B2 — take `CLOUD9_DEMO=1` out of `Start Cloud9.cmd`.** One line. It is the only thing standing between Vikas and a fake answer he believes.
5. **M2 + M1 — stop displaying a model the run will not use, and ask for harness state on connect** (or put it in `welcome`). Both are the "which app and model is this agent on" question he asked twice.
