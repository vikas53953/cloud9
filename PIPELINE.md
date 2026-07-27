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
| 3 | UX mock       | in progress (overnight)         | docs/mocks/directions.html |
| 4 | Architecture  | not started                     | — |
| 5 | Build         | not started                     | — |
| 6 | Code review   | not started                     | — |
| 7 | Browser QA    | not started                     | — |
| 8 | Ship          | not started (local commits only — no git remote) | — |
| 9 | Learn         | not started                     | — |

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

Open questions: none blocking — subscription-auth feasibility being verified at Stage 4.
Deviations: see implementation-notes.md
