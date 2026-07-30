# Cloud9 — hand this to the next session

**Read this first, then `RESUME.md`.** This file says what Cloud9 is, where it
got to, and what to do next. `RESUME.md` holds the running plan, the laws, and
the day-by-day log.

Written 2026-07-30. Repo: `github.com/vikas53953/cloud9`. Owner: **Vikas** — a
network engineer, a visual thinker, **not a developer**. Everything below is
written so he could read it.

---

## 1. What this is

A desktop chat app where Vikas creates **AI agents that work like hired
colleagues**. They sit in channels beside him and his friends, take jobs, do
real work, and stop to ask before they change anything.

The idea that makes it different, in his words: instead of *find an app, learn
it, operate it*, you **describe the outcome and give it to an expert who does
the work**.

**The one thing that must never be lost:** the agents run on the **Claude Code
and Codex apps already installed on his PC**, using his own subscriptions.
Cloud9 spawns those programs; it never holds a credential, never calls
Anthropic or OpenAI itself, and never asks for an API key. This is the whole
reason the product exists to him. (This matches what Buzz does — see
`docs/plans/buzz-teardown.md`.)

---

## 2. Where it runs

Everything is on his machine. Nothing is hosted.

| Part | Plain words | Where |
|---|---|---|
| The hub | The post office. Holds messages, agents, jobs; every client talks to it. | `apps/relay` — WebSocket + SQLite, loopback only |
| The engine | Runs an agent's turn by spawning the Claude/Codex CLI. | `packages/engine` — deliberately free of Electron so it can move to a server |
| The screen | What he looks at. | `apps/desktop` — React + Vite inside Electron |
| Shared | The dictionary both sides speak. | `packages/shared` |

**The installed app is the product.** `npm run dist` builds the Windows
installer; it carries its own hub and engine, needs no dev server, and makes its
own private key on first run.

---

## 3. THE LAWS — break these and you will waste his day

1. **A feature is DONE when he can SEE it and USE it.** Not when tests pass.
   This was the single biggest failure of the project: hub and engine work was
   reported as done while being unreachable on his screen. He noticed before we
   did.
2. **Never claim anything you have not just run.** He has caught unverified
   claims more than once and it costs trust every time.
3. **Verify by clicking the installed app**: `npm run qa:app` launches the real
   Windows app, attaches a debugger and walks it. Anything not visible is
   reported "NOT ON SCREEN", never skipped.
4. **Fix the class, not the case.** One owner per rule, in one file.
5. **Anything he reviews is a visual HTML page**, never a wall of text, and it
   carries the feedback layer (`~/.claude/review-kit/feedback-layer.js`) so he
   can annotate it.
6. **One question at a time, always with a recommendation.**
7. **Worker agents never commit.** The conductor commits after re-running the
   evidence itself.
8. **Absent means absent.** Never render a zero, an estimate, or a green dot for
   something nobody has checked.

---

## 4. What is DONE — and visible on his screen

Verified by clicking the installed app (`npm run qa:app`, 8/10 at last run):

- **Sign in with Claude and Codex** through the apps already on his PC. No API
  key. Proven with real answers from both.
- **Agents**: create, edit, pause, per-agent app **and** model, skills, and
  "who may use this agent" (owner-only by default).
- **The reach ladder** — four rungs from "just talk" up to everything the app
  can do on this computer, with the eight powers listed individually, and an
  honest per-app report of where the switches are truly the boundary (Claude:
  yes; Codex: no, and it says what still loads).
- **13 Claude models**, discovered by asking the CLI, not hard-coded.
- **The casting room** — 8 built-in software roles with real briefs and
  generated portraits; hiring copies one into his crew, fully editable.
- **Real presence** — ready / working / paused / offline with the reason.
- **Chat**: scrollback, search, reactions, edit, delete, threads (plus a setting
  for inline-vs-thread replies), attachments, account-level unread, markdown.
- **Rooms**: browse, join, leave, archive, roles, and — importantly — an agent
  names its owner wherever it appears, because admitting an agent admits a
  person.
- **Jobs**: delegate, approve/reject, a record of what the agent actually did,
  its own written summary, and emoji as work happens.
- **A real Windows app**: own installer, icon, Start-menu entry, no terminal.

## 5. What is DONE UNDERNEATH but NOT on his screen

Say this plainly to him; do not let it read as finished.

- **GitHub / git worktrees.** Agents can prepare their own worktree and branch
  and commit — proven against his real repo. **Push and pull-request are built
  but gated**, and there is no Projects screen, so none of it is reachable.
- **Projects storage** — entities and frames exist in the hub; nothing to click.
- **Skill library** — 15 researched software skills exist in shared code; no
  screen yet (`docs/plans/skills-library-handoff.md` has the contract).

## 6. What is NOT done at all

- **Projects in the rail** — decided with him: it is ADDED to the existing icon
  rail (Chat / Crew / Tasks / Projects / Log). The Studio navigation does not
  change. Inside: repository, pull requests, issues.
- **Friends cannot connect.** The hub is loopback-only. Decided: **Tailscale**,
  free, about an evening; he must do the browser sign-in himself.
- **Agents cannot hand work to each other**, and they remember nothing between
  conversations.
- No web GUI; the phone app is a scaffold that has never run.
- `wholeComputer` and `connections` are wired but inert — no folder picker, no
  per-agent MCP file. The screen says so rather than pretending.

---

## 7. Decisions he has already made — do NOT ask again

| Decision | His answer |
|---|---|
| Design | **Studio** — `docs/mocks/p3-studio.html` is the law. He rejected three others. He judges only by seeing the whole thing, never a description. |
| Agent capability | **Everything Claude Code and Codex can do on his PC.** Keep the isolation from HIS personal config; raise the ceiling. |
| Code to GitHub | **Branch + pull request, ALWAYS.** Nothing lands on the default branch without him. |
| Agents in parallel | **Git worktrees**, one per agent/task. |
| Marketplace | **Built into the app**, no server, software roles first. |
| Reach of the app | **Private network (Tailscale) first**; public website later on his Vercel Pro. |
| Backend shape | Agents overnight on **his own PC**, kept awake; his subscriptions pay. |
| Where the hub should eventually live | Hybrid — hub hosted, agents local. See `docs/plans/backend-decision.md`. |

---

## 8. How to work on it

```
npm install
npm run build          # all packages + renderer typecheck
npm test               # engine + relay
npm run qa             # browser suite against a throwaway stack
npm run qa:app         # THE IMPORTANT ONE — clicks the installed Windows app
npm run dist           # build the installer
"Start Cloud9.cmd"     # dev stack + window (workbench mode)
```

Current green baselines — re-run, do not trust: **279 engine, 159 relay,
305/305 + 8/8 + 4/4 browser, 8/10 on the installed app.**

Rules the test suites learned the hard way: a run that executes fewer checks
than expected is a FAILURE, never a pass; wait on observable conditions, never
sleeps; and prove a new check by putting the bug back and watching it fail.

---

## 8b. IN FLIGHT right now (2026-07-30, late)

**Projects in the rail is being built.** An agent is working in
`apps/desktop/src/**` and `scripts/qa.mjs`. If that work is half-finished when
you pick this up:

- `git status` will show uncommitted changes in those two places and nowhere
  else. Everything up to and including commit `a1a7d31` is pushed and green.
- Its brief: PROJECTS added to the icon rail beside Chat / Crew / Tasks / Log;
  inside it the repository, pull requests and issues; which agent is in which
  worktree on which branch; and the push-approval card drawing the new
  `kind: "action"` / `remoteAction` / `expiresAt` / `expired` fields the hub
  already sends and the screen currently ignores.
- The hub frames it needs already exist and are currently handled as named
  no-ops in `apps/desktop/src/store.ts` with a comment saying this screen would
  claim them.
- It was told: **do not report done until `npm run qa:app` shows Projects on
  screen in the INSTALLED app** — that check is one of the two currently
  failing.

To judge it: `npm run build`, `npm test`, `npm run qa`, then `npm run dist`,
install, and `npm run qa:app`. If it is half-done and not building, the safe
move is `git checkout -- apps/desktop/src scripts/qa.mjs` and start that item
fresh from the brief above.

## 9. What I would do next, in order

1. **Projects in the rail** — repository, pull requests, issues. This unlocks
   everything already built underneath and is the biggest visible gap.
2. **Finish the mid-run approval** so an agent can actually push and open a pull
   request (an agent was mid-flight on this; check `docs/plans/approval-handoff.md`).
3. **The skill library screen.**
4. **Tailscale**, so his phone and friends can reach it.
5. Agent-to-agent handoff, and memory between conversations.

---

## 10. Where the detail lives

| File | What |
|---|---|
| `RESUME.md` | The running plan, the laws, the day-by-day log, and his verbatim feedback |
| `docs/plans/spec.md` | His original product specification — still the north star |
| `docs/plans/spec-coverage-2026-07-29.md` | Honest requirement-by-requirement scoring |
| `docs/plans/backend-assessment.md` / `backend-decision.md` | Where the backend is and where it should go |
| `docs/plans/buzz-teardown.md` | Study of Buzz (Block Inc., open source) — what to copy and what not to |
| `docs/plans/capability-handoff.md` | The reach ladder contract |
| `docs/plans/*-handoff.md` | Contracts written between agents; read before touching that area |
| `docs/qa/journeys.md` | The 16 acceptance journeys, written from his spec |
| `docs/qa/app-*.png` | Screenshots of the real installed app from the last click-through |
