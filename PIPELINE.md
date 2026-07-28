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
Build queue + blocking TBDs: PARKING-LOT.md (sections C and D). No v2 code
until the relevant TBDs are resolved and a green light is given — per the
spec's own rules.

Open questions: none. Subscription-auth verdict: third-party claude.ai login NOT permitted; shipping API-key + setup-token options (see implementation-notes).
Deviations: see implementation-notes.md
