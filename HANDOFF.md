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

Verified by clicking the installed app (`npm run qa:app`, **14/14** at last run,
2026-07-30):

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
- **PROJECTS in the icon rail** (2026-07-30). Added beside Chat / Crew / Tasks /
  Log; the approved Studio navigation is otherwise unchanged. He can connect a
  repository by name (`owner/name`), see its pull requests and its issues, read
  which of his agents is on which branch, and open any of them on GitHub.
  Verified on the INSTALLED app: `npm run qa:app` **14/14**, including
  "Projects is in the icon rail", which had been failing.
- **The permission card for pushing.** An agent stopping mid-job to ask before
  anything leaves this computer now draws the whole thing: what it will do, to
  which repository and branch, how many commits, how many files, and when the
  request runs out. `expired` is drawn as its own state — nobody answered is not
  the same as he said no, and it is never painted as an error.

## 5. What is DONE UNDERNEATH but NOT on his screen

Say this plainly to him; do not let it read as finished.

- **Nothing ever asks GitHub for a repository's lists.** The Projects screen
  draws pull requests and issues perfectly, and no code path in Cloud9 puts one
  there: `projectSynced` is handled by the hub and sent by nobody. So a
  repository he connects stays empty, and the screen SAYS so rather than showing
  an empty list that reads like "no open work". **This is the next thing to
  build** — `docs/plans/projects-handoff.md` §2 has the two pieces needed.
- **Which agent is in which worktree.** The branch travels and is on screen with
  the agent's face on it; the worktree does not cross the wire at all
  (`Worktree` is engine-local). The screen says that in words rather than
  drawing a path it invented. See `projects-handoff.md` §3.
- **No agent turn calls `githubFor` yet**, so an agent cannot decide by itself
  that it wants to push. The round trip is proved end to end with the engine
  driving it (`docs/plans/approval-handoff.md` §6).
- **Skill library** — 15 researched software skills exist in shared code; no
  screen yet (`docs/plans/skills-library-handoff.md` has the contract).

## 6. What is NOT done at all

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
350/350 + 8/8 + 4/4 browser, 14/14 on the installed app.** (The browser suite
went 305 → 350 and the installed-app walk 10 → 14 when Projects landed on
2026-07-30; every one of those ran.)

Rules the test suites learned the hard way: a run that executes fewer checks
than expected is a FAILURE, never a pass; wait on observable conditions, never
sleeps; and prove a new check by putting the bug back and watching it fail.

---

## 8b. Projects LANDED — 2026-07-30

The round that built PROJECTS is **finished, on his screen, and pushed** —
commit `d273984` on `master` at `github.com/vikas53953/cloud9`. Evidence, all
re-run by the conductor before that commit:

| What | Result |
|---|---|
| `npm run build` | clean |
| `npm run qa` | **350/350 + 8/8 + 4/4**, all executed |
| `npm run dist`, installed, `npm run qa:app` | **14/14** — "Projects is in the icon rail" now passes |
| Screenshots at 1280 | `docs/qa/projects-*.png`, and `docs/qa/app-09..11-projects*.png` from the real app |

Two things worth knowing before you touch it:

- **`npm run qa:app` went 8/10 → 14/14 and one of those was a harness fault, not
  a fix.** "A hired agent's editor offers exactly what a hand-made one's does"
  had been failing because the harness waited for a crew card, and the app
  deliberately drops him straight into the hired agent's own file. The feature
  was working; the walk was out of date. It now follows the app.
- **Nothing ever sends `projectSynced`,** so a connected repository is
  permanently empty until the engine half is built. The screen says so instead
  of pretending. `docs/plans/projects-handoff.md` is the request to whoever owns
  `packages/**` and `apps/relay/**`; §2 is the next thing to build.

## 9. What I would do next, in order

1. **Make the Projects lists real** — `docs/plans/projects-handoff.md` §2. The
   screen is built and honest; nothing asks GitHub for a repository's pull
   requests and issues, so it is always empty. Needs a `syncProject` client
   frame and an engine path that runs `gh` and answers `projectSynced`.
2. **Let an agent decide to push by itself** — no agent turn calls `githubFor`
   yet, so the permission card only appears when the engine is driven directly.
   `docs/plans/approval-handoff.md` §7.
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
