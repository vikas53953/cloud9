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
