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
in his browser). C5 workspaces still blocked on TBD D6 (PARKING-LOT).
GitHub push: UNBLOCKED 2026-07-28 — repo github.com/vikas53953/cloud9 exists and
the local checkout pushes over HTTPS via the gh keyring login (no SSH key on
this machine). Everything through 3d68926 is pushed.

## v2.1 — harness sign-in + Workbench reskin (2026-07-28, Vikas directed)
Approved order delivered: (1) Sign in with Claude, (2) Sign in with Codex,
(3) Workbench design round. Spec/plan: docs/plans/harness-signin.md.
- Sign-in: both harnesses detected live on Vikas's machine; security review
  found 14 issues (3 P0) — ALL fixed at class level and re-verified.
  64 tests green (was 43), 19/19 browser QA (was 14). Commit 082767b.
- Design: Vikas picked WORKBENCH from a 3-direction round
  (docs/mocks/v2-workbench.html) — now the design law for every screen.
  Reskin shipped, 64 tests + 19/19 QA still green. Commit 9bf0439.
- Pending Vikas's own hands (cannot be agent-verified): the live click of both
  sign-in buttons, and the first real Codex agent answer.
- Next up per Vikas: "then we will pick up the other things" — remaining
  spec items (C5 workspaces/roles/governance, D1 outcome wording, mobile).

House rule for delegated builds (added 2026-07-28): worker agents are told NOT
to commit. The conductor commits after it re-runs the evidence itself. If a
worker sees commits it did not make, that is the conductor doing its job — not
an intrusion. Nothing needs rolling back.

Starting the app: double-click `Start Cloud9.cmd` in the repo root. It starts
the hub, the agents and the screen in order (waiting on each), opens the
desktop window, and shuts the background parts down when the window closes.
Dev flags CLOUD9_DEV=1 / CLOUD9_DEMO=1 are set by the script; they exist
because of the P0#3 (no default-token access) and P1#7 (no implicit fake
answers) security fixes.

Open questions: none. Subscription-auth verdict: third-party claude.ai login NOT permitted; shipping API-key + setup-token options (see implementation-notes).
Deviations: see implementation-notes.md

## Sol feature queue — active 2026-08-02

Current owner: Sol. Active plan: `HANDOFF-SOL.md`. Vikas authorised fully autonomous execution through the queue; product defaults are chosen and recorded as “I chose X — Vikas may overrule,” never left silent.

| Feature | Status | Evidence / artifact |
|---|---|---|
| 1. Shared Files workspace | IN PROGRESS | `docs/plans/sol-feature1-brief.md`; decision page `docs/gates/sol-feature1-permissions.html`; status in `SOL-REPORT.md` |
| 2. GitHub round 2 | WAITING FOR FEEDBACK; skip if none | `SOL-REPORT.md` |
| 3. Search everywhere | NOT STARTED | `HANDOFF-SOL.md` |
| 4. Turn coordination | NOT STARTED | `HANDOFF-SOL.md` |
| 5. Notifications, integrations, mobile groundwork | NOT STARTED | `HANDOFF-SOL.md` |

Fresh baseline at `e738083`: build clean; 1,002 passed, 0 failed; QA 494/494 + 8/8 + 4/4. Full logs: `docs/qa/sol-baseline-*.log`.
