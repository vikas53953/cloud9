# Implementation notes — Agent Chat

Running log of deviations and lessons. One line each, newest last.

- 2026-07-27: The `ce-*` pipeline owner skills (ce-brainstorm, ce-plan, ce-work,
  ce-code-review, ce-test-browser, ce-commit-push-pr, ce-compound) are not
  installed in this environment; the conductor performs those stages directly,
  keeping the same gates and artifact formats.
- 2026-07-27: Stage-1 interview run in plan mode via AskUserQuestion instead of
  free chat; answers recorded in PIPELINE.md and the approved plan file.
- 2026-07-27 (night): Vikas picked the name **Cloud9**, then went to sleep with
  the directive "go build it, no questions until morning." Gates 2-4 switch
  from blocking to morning-review: recommended option taken + logged at each,
  full review dashboard prepared for morning.
- 2026-07-27 (night): No git remote configured and no gh CLI — shipping stage
  will be local commits only; pushing to GitHub is a morning follow-up.
- 2026-07-27 (night): FEASIBILITY VERDICT on subscription auth: Anthropic docs
  (code.claude.com/docs/en/authentication) state third-party apps may NOT offer
  claude.ai subscription login without prior approval. Cloud9 therefore ships
  two auth options per user: (a) own Anthropic API key (sanctioned), (b) paste
  a `claude setup-token` OAuth token the user generates themselves (works with
  Pro/Max; policy gray zone flagged in-app and in morning review). Engine uses
  Claude Agent SDK which honors both via env vars.
- 2026-07-27 (night): Stage 3 mocks built directly (3 directions, variant
  switcher); frontend-design-thinking skill workflow skipped for overnight
  context budget — can rerun as redesign if morning review demands.
- 2026-07-27 (night): Gate 2 converted to morning review per Vikas's overnight
  directive; building against Direction A (Slack Classic + ⌘K overlay, the
  recommended default). UI is componentized so a different morning pick is a
  reskin, not a rebuild.
- 2026-07-28 (early): Stage-9 lessons: (1) Playwright `text=` is substring +
  case-insensitive — cost ~40 min on a phantom overlay bug; always scope
  selectors. (2) node:sqlite removed the native-build risk entirely. (3) The
  channel-kind-by-member-count inference was a real design bug QA caught —
  clients now state intent explicitly. (4) Mock provider made full-stack QA
  possible with zero credentials; keep it forever as demo mode.
- 2026-07-28 (early): Schedules have engine support + tests but no creation UI
  yet — first build item for the next session.
- 2026-07-28: Vikas adopted the external Agent Workforce Platform spec
  (docs/plans/spec.md) as the v2 direction. Produced traceability.md per its
  §26.4 and PARKING-LOT.md holding morning decisions (A), deferred work (B),
  v2 queue (C), and blocking TBDs (D). Spec rules honored: no TBD guessed,
  no v2 implementation started.
- 2026-07-28 (v2 build): Vikas directed autonomous work on the adopted spec.
  Built C1 Tasks + C2 Approvals + C3 Audit end-to-end (shared types, relay
  storage/handlers, engine task runner, UI Tasks/Activity panels). Provisional
  TBD resolutions logged in PARKING-LOT.md section D. C4 Codex NOT built —
  spec rule 3/FR-PC-004 forbids guessing provider auth; needs D2 answered.
- 2026-07-28: GitHub push attempted; session token is repo-scoped with no
  configured repo → cannot create/reach any repo. Unblock steps in A3.
- 2026-07-28: Lesson: engine test hangs came from a leaked reconnect timer +
  scheduler interval after an assertion failure; fixed with stopped-flag +
  timer cleanup — always make async loops cancellable before testing them.
- 2026-07-28 (v2 cont.): FR-AG-007 lifecycle (enabled/paused/disabled) +
  FR-AG-008 edit UI built and QA'd (3/3 lifecycle checks). Remaining spec work
  is all BLOCKED-TBD or needs Vikas — clean autonomous stopping point.
- 2026-07-28 (C4 harness sign-in): Shipped "Sign in with Claude" + "Sign in
  with Codex" per docs/plans/harness-signin.md. Shared protocol gained
  `AgentDef.provider` and the harnessStatus/harnessSignIn/harnessState frames
  plus a `harness` broadcast; engine gained CodexProvider (`codex exec --json`,
  JSONL parse, prompt on stdin, `--ephemeral`, 120s kill leash, files ability →
  `-s workspace-write` else `-s read-only`) and per-agent provider routing with
  a plain-words "my engine isn't connected" reply; the engine host gained a
  harness detection + sign-in module (setup-token capture for Claude, detached
  `codex login` + 10s polling for Codex). Secrets class fix done: ALL
  localStorage credential code removed and the Electron main process now stores
  the captured token / fallback key with safeStorage under userData (old
  plain-text settings.json credentials are migrated then wiped); the renderer
  only ever sees status. Settings redesigned into two provider cards; create and
  edit modals got a provider picker. Evidence: build clean, 43 tests green
  (39 engine + 4 relay), browser QA 18/18 (was 14/14).
  Deviations logged: (1) `codex doctor --json` is NOT used for detection — it
  took over 2 minutes on this machine and would stall the engine host;
  `codex login status` (exit code, plus its line which the CLI writes to STDERR,
  not stdout) is the sole signal — conservative because it avoids a hang.
  (2) An extra engine→relay client frame `harnessState` was needed to carry the
  detection result up before it can be broadcast — the note named only the two
  client frames. (3) Detection/sign-in live in `packages/engine/src/harness.ts`
  (used by the dev host and Electron via `startEngineHost`) rather than inside
  scripts/engine-host.mjs, so both hosts behave identically and it is testable.
  (4) On Windows the CLIs are npm shims, so every spawn goes through
  `shell: true` with paths quoted — verified by running the real commands.
- 2026-07-28 (C4 code-review fixes): Review came back NOT READY; fixed all 3 P0s
  and 4 P1s plus the named P2/P3 items, each as a class fix rather than a patch.
  (P0-1) Command injection: `shellQuote` used to escape, which is a losing game
  under `shell: true` — it now REFUSES any argument outside a strict allowlist
  (`safeArg`/`shellQuote` throw `UnsafeArgumentError`), and agent fields are
  validated at BOTH boundaries by one shared function `validateAgentInput`
  (relay rejects on create/update, engine re-checks before building a command
  line). Model ids must match ^[A-Za-z0-9._-]{1,64}$; name/emoji/persona capped.
  (P0-2) Credentials are now PER HARNESS end to end — one encrypted file per
  app, harness-aware IPC, separate provider slots — so the Codex key can no
  longer overwrite the Claude one; a Codex key is injected as CODEX_API_KEY and
  never as an ANTHROPIC_* variable; both cards gained a "Remove saved key".
  (P0-3) The relay now binds 127.0.0.1 by default (CLOUD9_BIND to opt out),
  refuses harness frames unless the caller is the workspace owner AND the owner
  token isn't the shipped default (CLOUD9_DEV=1 for dev/QA), and rate-limits
  sign-in to one in flight plus one per 30s per user.
  (P1-4) Timeouts kill the whole process tree (taskkill /T /F on Windows) —
  killing the shell alone left the real CLI running; proven by a test with a
  live grandchild process. (P1-5) The old plain-text credential is deleted only
  after the encrypted write is confirmed. (P1-6) `purgeLegacySecrets()` runs on
  every renderer start, so existing installs lose their localStorage copy.
  (P1-7) Harness gating is uniform: a signed-out Claude no longer silently
  produces MockProvider answers that look real — demo mode must be asked for
  (CLOUD9_DEMO=1 / `demoMode`), otherwise the agent says it isn't connected.
  Also: detached-spawn error handler attached before returning; signed-out
  detection reads the CLI's stderr and exit code only, never the model
  transcript; one `sanitizeForChat()` choke point keeps raw error text (paths,
  argv) out of chat while the console keeps the detail; sign-in failure reasons
  survive the following refresh; refresh() has an in-flight guard and the UI
  disables Re-check while it runs; stop() settles a sleeping poll; streams are
  decoded as utf8 and capped at 2MB; the relay drops cached harness status when
  the engine host disconnects. NOTE for running the dev stack after this change:
  relay needs CLOUD9_DEV=1 while the default owner token is in use, and the dev
  engine host needs CLOUD9_DEMO=1 to keep canned replies. Evidence: build clean,
  64 tests green (57 engine + 7 relay), browser QA 19/19.

## 2026-08-01 — Vikas bug reports (tracked, in progress)
- BUG-1 (fixing now): Codex agents refuse to start — HarnessAbilityBoundaryError for agents saved before the fail-closed rule. Class fix: editor shows Codex-unremovable switches as locked-on "always on with Codex"; saved agents read the same way; runtime gate stays as backstop.
- BUG-2 (next): GitHub integration invisible — !issue/!comment/!review are typed-only, no on-screen control. Class fix: visible actions control at the message box covering ALL typed commands (incl. !code).
- BUG-3 (found by conductor 2026-08-01, fixed): 3 engine tests (litter sweep) failed by luck of PID assignment — they fabricated killed-write litter stamped pid 999 with a fresh timestamp; whenever pid 999 is a live process the sweeper rightly leaves the file. Class fix: one helper (packages/engine/src/litter-for-tests.ts) plants litter backdated past the grace window; all three suites use it. Fail-then-pass proven (3 fail without backdating, 545/545 with).
- BUG-4 (found by conductor 2026-08-01, fixed): qa:app silently walked YESTERDAY'S installed app — npm run dist builds an installer but nothing installs it, so a walk could "verify" fixes against old software. Class fix: drive-app.mjs now refuses to run when the installed web bundle differs byte-for-byte from release/win-unpacked (guard proven: it refused the stale install, passed after a silent /S install).
- BUG-1 and BUG-2: DONE, proven on the freshly installed app — 18/18 walk including the two new permanent checks (Codex locks 4 switches on with the reason, and Claude releases them; Actions menu offers 10 commands, blocked rows explain themselves, choosing one fills the composer).

- BUG-5 (his report 2026-08-01, fixing now): no screen shows the GitHub connection — gh IS signed in as vikas53953 but nothing displays it or offers sign-in. Class fix: GitHub card in Settings beside the harness cards, facts from really running gh, sign-in button for the not-signed-in case.

- BUG-5: DONE — GitHub card live in Settings, proven on installed app ("Signed in as vikas53953", dated). Walk now 19 checks. Evidence: 962 tests 0 fail, 479/479+8/8+4/4 QA (green twice consecutively), 19/19 installed walk.
- NOTE (2026-08-01): one qa.mjs run in the middle failed once and did not reproduce in two follow-up full runs; my pipeline (grep/tail) discarded which check it was — conductor error, cannot name the flake. If qa.mjs fails again, save the FULL output before anything else.

- FEATURE-6 (his ask 2026-08-02, building now): Buzz/Slack-style GitHub: (a) rename gear "Setup"->"Settings"; (b) connect panel lists YOUR repositories from gh to click-connect (typed owner/name stays as fallback); (c) close the repoDir gap - a project links to a folder on this computer so agents really work on it (approval-handoff.md section 8).

- FEATURE-6: DONE, proven on installed app 21/21 — gear renamed Settings; picker listed his 46 real repositories and click-connected cloud9; project folder row with honest none-state + Choose folder (native dialog); engine resolves repo dir per project (repoDirFor), launch-time repoDir kept as fallback. Evidence: 1002 tests 0 fail, 494/494+8/8+4/4.
- FLAKE ROOT-CAUSED AND FIXED: the intermittent qa.mjs failure (seen 3x since 2026-08-01) was the look-at-GitHub "settles" check SAMPLING at the instant items render while the button settles a frame later. Check now waits bounded for the settled state. If qa flakes again it is a NEW problem.

- FEATURE Q1 (Sol, closed by conductor 2026-08-02): shared Files workspace DONE-PROVEN — attribution, immutable versions, typed same-room links, room-visible permissions with manager restriction. Built by Sol (GPT-5.6) across 2 sessions with multi-agent review rounds (real finds: privacy leak in shared frames, Windows byte-race root-caused to engine-owned Buffer snapshots, relay durability/nonce ownership). Evidence re-run fresh by conductor: 1,072 tests 0 fail, 501/501+8/8+4/4 QA, installed app walked 28/28. One-time sidecar launch flake on first walk did not reproduce. Follow-up parked: walk-script sidecar hardening nits.

- FEATURE Q3 (search) 2026-08-03: Sol blocked by provider 429 (credentials cooling); the Claude conductor is building the small-first slice itself overnight under the cost caps. Branch sol/search.

- FEATURE Q3 (search everywhere) DONE-PROVEN 2026-08-03 by the Claude conductor (Sol blocked all night by provider 429). One search over messages, thread replies, file names and words inside files incl. retained old versions; extends the relay FTS (search_docs), never a second engine; permission gate mirrors the Files owner (visibleArtifactRows) in SQL before LIMIT; five scope doors in the existing search panel; results open the real thing. Single review round found 4 real defects (Files-screen hijack by fileOpenAt, stale answer under switched pill, untested no-FTS5 fallback gate, 2 of 3 permission arms untested) - all fixed. Walk-check class fix: never compare live rendered text (agent presence flipped Ready->Working mid-check); compare stable names/ids. Evidence: build clean, 1,083 tests 0 fail, qa 508/508+8/8+4/4, installed app 29/29.
- Follow-ups logged (not blockers): global recency limit can starve kinds on a busy hub; no-FTS5 fallback cannot search inside file versions (stated gap); non-numeric limit gives a generic refusal (class exists in old search too); hasMore computed pre-hydration.

- FEATURE Q4 (turn coordination) started 2026-08-03 by conductor. Small-first: one owner per answer (today both mentioned agents reply - engine.ts:407 loop + chatter.ts:70), plus blocked/failed states with plain-words reasons (Task status "blocked" exists in shared+UI, nothing sets it).
- FEATURE Q5 scoped 2026-08-03 after scout: "notifications r2 + integrations + mobile" is 3 unequal things.
  DO (small-first, real value): (a) OS-level desktop notifications — TODAY there are NONE, only in-app toasts (App.tsx:2124-2131 says so honestly), so nothing reaches Vikas when the window is minimised; (b) per-room notification rules — the decision owner decideNotification (shared/notify.ts:166-192) already receives channelId but ignores it, and NotifyPrefs (notify.ts:24-33) has no per-room field; (c) CHEAPEST REAL WIN: the MCP/connections file picker — engine plumbing is complete end-to-end (claude-cli.ts:47/311/414, abilities.ts:153/169), only a settings-screen picker is missing.
  DEFER with reasons: outgoing webhooks/Slack = a NEW subsystem (zero outbound HTTP client anywhere in repo; needs retry/backoff/secret storage); mobile = apps/mobile is an orphan Expo scaffold NOT in root workspaces (package.json:6-9), never built or tested, and spec marks native mobile TBD/not greenlit (spec.md:670, 484-486). Claiming mobile progress without Vikas greenlighting the spec item would be inventing scope.

- FEATURE Q4 slice A (one owner per answer) BUILT 2026-08-03, UNVERIFIED until the conductor re-runs the chain. RULE: FIRST MENTIONED WINS — "@Scout @Architect look at this" is answered by Scout only; the others stay silent rather than half-answering. Chosen because (a) a person can predict it (the order you type names is the order you meant them) and (b) it needs NO coordination between machines: it reads only facts every engine already holds identical copies of (the message text, the message's mentions list, and the whole agent roster the relay broadcasts in worldFor). Two people's engines therefore pick the same single winner without talking to each other — proven by a test. Implemented inside the ONE decision owner `shouldReply` (packages/engine/src/chatter.ts) via new `mentionOwner()`; engine.ts's per-agent loop is untouched, no per-call-site patches. A paused/disabled agent cannot swallow a turn — the next name takes it. DMs unchanged; un-mentioned free chatter (single best-matching agent) unchanged; a single mention behaves exactly as before. Also exported `passedOverByMention()` — the list of agents that were named but stayed quiet — unused by the engine, ready for the screen slice. LEFT FOR SLICE B (screen): the room does not yet SAY "Architect was asked too" — presence reasons are computed from a fixed set (shared/index.ts:2206) and messages have no note field, so saying it honestly needs real screen work, not a cheap reuse. Tests: new packages/engine/src/turnowner.test.ts, 10 tests, all green; engine package 604 -> 614 tests. Fail-then-pass proved by replacing the owner check with `return true` (the old behaviour): 4 of the 10 failed, restored, green again. Build clean. NOTE for the conductor: repowork.test.ts and the Claude sign-in wait tests time out on this loaded machine — they fail the same way on a CLEAN checkout with these changes stashed, so they are environmental, not this slice.
- CLASS LESSON 2026-08-03 (parallel agents + git): slice A ran `git stash -u` to verify a test failure on a clean tree and swept up slice B's in-flight uncommitted work; it noticed and restored it, and left stash@{0} as a safety copy. Nothing was lost (verified by the conductor: slice B's App.tsx/styles.css/qa.mjs edits present and newer than the stash). THE RULE: agents get their own FILES, but git state is GLOBAL — no worker may run stash/checkout/reset/clean while another worker is live. A worker needing a clean-tree comparison must ask the conductor, who owns git, or use a worktree. Added to the worker prompt template.
- CLASS LESSON 2026-08-03 (parallel agents + the walk's freshness guard): qa:app compares the CURRENT repo build against the packaged+installed app, so ANY agent running `npm run build` instantly blocks qa:app for every other agent even though the install is self-consistent. It reads exactly like a harness failure. RULE: only the conductor runs build/dist/install while workers are live, and the walk runs after workers have stopped. Added to the worker prompt template.
- Root cause of the recurring "the visible invite did not create a distinct member" flake: HARNESS, not the product. Invites are race-free (store.ts:1044-1057 is one synchronous block; server.ts sends `token` before `welcome`). The app optimistically renders the whole Workspace (App.tsx:1556) as soon as a stored token exists, so `.rail` appears BEFORE the hub says hello; the walk read `.rail` as "signed in". Fixed as a class: waitForEstablishedIdentity() waits on window.cloud9Wire.me(), used at all 5 window->person boundaries. Teardown also fixed: close the client before the server (inside-out), and a forced shutdown that PROVED OS exit is a pass with an observation, not a failure.
- FEATURE Q4 (turn coordination) DONE-PROVEN 2026-08-03. One owner per answer (first-mentioned wins, deterministic across engines - chatter.ts mentionOwner); "blocked" made REAL for the one true case (a job parked at an unanswered approval card, cleared on every exit incl. expiry); failed/blocked show plain-words reasons with an honest "no reason was recorded"; stuck jobs grouped apart from running; presence rows say when their job is in trouble. Found and fixed underneath: a !code BACKGROUND JOB never ran the repository work (reached the CLI as prose). Evidence run by the conductor twice: 1,104 tests 0 fail, qa 520/520+8/8+4/4, installed app walked 33/33 TWICE.
- INVITE SAFETY (real product bug, found while root-causing a flaky walk): pasting a spent/mistyped invite while already signed in WIPED the working credential before attempting redemption - an invited friend was locked out permanently. Class fix: one owner (RelayClient.adoptCredential, store.ts:738) writes the credential only on `welcome`; setToken is private; a refused join keeps the old credential, dials back in, and says so. Proven by reintroducing the bug and watching the lockout reproduce.
- MACHINE LESSON: killed QA runs leave orphans (engine hosts, vite/serve, a relay holding port 8799) that starve later runs and look like code failures. Conductor sweeps processes and the port before judging a slow/failed chain.
- FEATURE Q5 (notifications r2 + connections) DONE-PROVEN 2026-08-03. (a) REAL Windows notifications: Cloud9 had NONE before - in-app toasts only, so nothing reached Vikas with the window minimised. chooseDelivery() (notify.ts:327) is a pure rule: focused->toast, unfocused+bridge->OS notification, unfocused+no bridge/refused->toast with fellBack+reason. Never dropped. Clicking lands on the thing via the existing navigation owners. Caught while wiring: the quick-chat window would have double-notified (App.tsx:1610 now mounts the notifier in the main window only). (b) Per-room mute inside the one gate decideNotification (notify.ts:230, reason "room_muted"), positioned before quiet hours; a muted room still lets a DIRECT MENTION through; mute can only silence. (c) Connections file picker - the switch was permanently inert because nothing supplied mcpConfigPath; one owner packages/engine/src/connections.ts resolves 4 honest states (none/gone/ready/cannot-check), wired at host.ts:126 (the only production construction of ClaudeCliProviderOptions), owner-only (relay refuses an engine naming a file), ALWAYS_ASK approval untouched.
- HUB DATA-INTEGRITY BUG found by a QA agent and fixed: updateAgent/createAgent spread the CLIENT frame into the stored record, so a partial {id,name,ownerId} message was accepted and DESTROYED the agent definition, then crashed the screen (App.tsx:1744 persona.trim()). Class fix: build the record first, validate the RECORD not the frame (validateAgentDefinition, shared/index.ts:3413); id/ownerId/createdAt are hub-owned; abilities+skills inherited when unmentioned; refusal in plain words. Audited every other stored entity (channels/projects/tasks/approvals/messages/runs) - none spread a client object, so the class does not exist there. Logged not fixed: provider.ts:331 reads agent.abilities unguarded (a pre-abilities legacy agent would trip it).
- Evidence: 1,143 tests 0 fail (110+635+383+15); qa 529/529+8/8+4/4; installed app walked 34/34 TWICE.
- CHAT SMOOTHNESS root causes (scouted 2026-08-04, for the round after threads). Provable in code, ranked:
  1. NO selector/memo layer over the store. store.ts:549-552 emit() replaces the whole world object on EVERY frame, so useSyncExternalStore's Object.is always says "changed" for all ~40 subscribers. MessageRow itself subscribes (App.tsx:4680) and there is ZERO React.memo in the file, so one message (or a presence tick in another room) re-renders every visible message bubble. ARCHITECTURAL.
  2. unreadFor (App.tsx:2257-2297) is called inline per room/DM row (2977/3011/3045) and scans that room's whole message array - so any unrelated re-render re-scans every room. NOTE: the threads slice just ADDED an inThreads pass here, making it heavier; fix must cover both.
  3. No virtualization and no history cap: App.tsx:3729/3889 render every loaded message as real DOM; store.ts only ever prepends/appends, never trims. A long scrolled-back session accumulates hundreds of live-subscribed rows.
  4. ChatView derivations (App.tsx:3566-3571, 3729) filter/map the full array unmemoized on every render.
  CHECKED AND CLEARED (not causes): composer keeps typed text in local state; useFollowToBottom does not thrash layout; CSS transitions are hover-only; the wire sends one message per message (no snapshot per keystroke).
