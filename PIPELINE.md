# PIPELINE — Cloud9            updated: 2026-07-27 (overnight autonomous run)

Idea: Desktop + iPhone chat app "Cloud9". Vikas connects his Claude
subscription, creates agents (like Slack coworkers) with personalities,
abilities and proactive background powers, and chats with them — and with
invited friends — from anywhere in the app.

MODE: Vikas is asleep and directed "go build it, no questions until morning."
Gates 2–4 are converted from blocking to morning-review: I take the
recommended option, log it, and present everything for reaction in the
morning review page. He can redirect anything then.

| # | Stage         | Status                          | Artifact |
|---|---------------|---------------------------------|----------|
| 0 | Intake        | done                            | this file |
| 1 | Unknowns      | done (2026-07-27)               | answers below |
| 2 | Requirements  | APPROVED by Vikas (2026-07-27)  | docs/plans/agent-chat-prd.md + docs/gates/gate1-review.html |
| 3 | UX mock       | built — morning review (3 directions; building on A) | docs/mocks/directions.html |
| 4 | Architecture  | decided (overnight, logged)     | docs/plans/architecture.md |
| 5 | Build         | done (overnight) — incl. chat-based schedules + Electron smoke | packages/, apps/ |
| 6 | Code review   | plan-vs-built audit done        | docs/gates/morning-review.html |
| 7 | Browser QA    | 14/14 green + screenshots       | docs/qa/ |
| 8 | Ship          | local commits; GitHub push = morning decision | git log |
| 9 | Learn         | logged                          | implementation-notes.md |

## Stage-1 answers (locked, 2026-07-27)
1. Core UX: global hotkey quick-chat popup + shared channels with @mentions + cross-device sync — all three.
2. V1 scope: desktop AND iPhone together, synced, from day one.
3. Agents: personality + toggleable abilities + proactive workers (Hermes/OpenClaw-style).
4. Audience: Vikas + a few friends/testers (TestFlight/direct install); each connects their own Claude subscription.
5. Agent runtime: desktop-hosted in v1, engine designed to lift onto a server later.
6. Phone: iPhone first, Android later.

## Gate-1 decisions (Vikas, 2026-07-27)
- Workspaces: SHARED — friends and agents mingle in channels (human-to-human chat in scope).
- Agent chatter: FREE agent-to-agent conversation (mechanical runaway brake logged in PRD).
- Name: **Cloud9**.

## v2 — Agent Workforce Platform (spec adopted 2026-07-28)
Vikas adopted docs/plans/spec.md as the v2 north star. Coverage map:
docs/plans/traceability.md (11/16 acceptance criteria already met by v1).
v2 progress (autonomous, per Vikas's directive 2026-07-28): C1 Tasks, C2
Approvals, C3 Audit BUILT — 15 unit/integration tests + 14/14 v1 regression +
8/8 v2 browser QA green. C4 Codex BUILT 2026-07-28 — "Sign in with Claude" +
"Sign in with Codex" per docs/plans/harness-signin.md (D2 resolved by Vikas):
per-agent provider picker, CodexProvider, harness detection/sign-in in the
engine host, and the secrets class fix (safeStorage replaces all localStorage
credential code). 64 tests green (57 engine + 7 relay) + browser QA 19/19,
after a code review returned NOT READY and was fully addressed (3 P0s —
command injection, per-harness credentials, relay authorization — plus 4 P1s
and the named P2/P3 items; see implementation-notes.md).
Left for Vikas: click both sign-in buttons for real (an agent must not authorise
in his browser). C5 workspaces still blocked on TBD D6 (PARKING-LOT). GitHub
push blocked by session security (see A3).

Open questions: none. Subscription-auth verdict: third-party claude.ai login NOT permitted; shipping API-key + setup-token options (see implementation-notes).
Deviations: see implementation-notes.md
