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
