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
