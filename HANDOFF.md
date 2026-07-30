# Cloud9 — hand this to the next session

**Read this first, then `RESUME.md`.** This file says what Cloud9 is, where it
got to, and what to do next. `RESUME.md` holds the running plan, the laws, and
the day-by-day log.

Rewritten **2026-07-30, 18:40**, at the end of a long autonomous day.
Repo: `github.com/vikas53953/cloud9`, branch `master`, last commit `39d0a46`.
Owner: **Vikas** — a network engineer, a visual thinker, **not a developer**.
Everything below is written so he could read it.

---

## 0. FIRST THING TO DO — there is work in flight

**One agent was still running when this was written.** It owns
`apps/desktop/src/**` and `scripts/qa.mjs`, and its job is:

1. **The Major from the UI pass** — in the agent editor, switching on individual
   abilities leaves the ladder's dot on *"Just talk — No tools at all"*, which is
   the opposite of the truth. Told to fix it as a class: make one of the two
   views the truth and derive the other, so no combination of switches can
   produce a contradicting rung.
2. Escape closing every overlay, not just the Ctrl-K palette (one owner).
3. `"1 CATEGORIES"` — a plural label on a count of one.
4. The six older review findings never fixed: #9 upload killed by an unrelated
   refusal, #16 blob URL revoked while the picture is on screen, #17 Enter drops
   a still-uploading file, #18 a late search result resurrects a cleared search,
   #19 the scroll anchor undone by follow-to-bottom, #21 roles shown but not
   changeable. It was told to check whether any are already closed and to say so
   rather than claim credit.

**If the tree is dirty in `apps/desktop/src/**` or `scripts/qa.mjs`, that is its
work.** Do not commit it without re-running the evidence yourself (§8). If it
never reported, treat everything as unverified.

---

## 1. What this is

A desktop chat app where Vikas creates **AI agents that work like hired
colleagues**. They sit in channels beside him and his friends, take jobs, do
real work, and stop to ask before they change anything.

In his words: instead of *find an app, learn it, operate it*, you **describe the
outcome and give it to an expert who does the work**.

**The one thing that must never be lost:** the agents run on the **Claude Code
and Codex apps already installed on his PC**, using his own subscriptions.
Cloud9 spawns those programs; it never holds a credential, never calls Anthropic
or OpenAI itself, and never asks for an API key. This is the whole reason the
product exists to him. (See `docs/plans/buzz-teardown.md`.)

---

## 2. Where it runs

Everything is on his machine. Nothing is hosted.

| Part | Plain words | Where |
|---|---|---|
| The hub | The post office. Holds messages, agents, jobs; every client talks to it. | `apps/relay` — WebSocket + SQLite, **loopback only** |
| The engine | Runs an agent's turn by spawning the Claude/Codex CLI. | `packages/engine` — deliberately free of Electron |
| The screen | What he looks at. | `apps/desktop` — React + Vite inside Electron |
| Shared | The dictionary both sides speak. | `packages/shared` |

**The installed app is the product.** `npm run dist` builds the Windows
installer; it carries its own hub and engine and needs no dev server.
His real database is at `%APPDATA%\cloud9\cloud9-relay.db`. The
`cloud9-relay.db` at the repo root is a **development** database — do not
confuse them (see §7, the mistake).

---

## 3. THE LAWS — break these and you will waste his day

1. **A feature is DONE when he can SEE it and USE it.** Not when tests pass.
   This was the single biggest failure of the project.
2. **Never claim anything you have not just run.** Paste real counts.
3. **Verify by clicking the installed app**: `npm run qa:app` launches the real
   Windows app, attaches a debugger and walks it. Anything not visible is
   reported "NOT ON SCREEN", never skipped.
4. **Fix the class, not the case.** One owner per rule, in one file.
5. **Anything he reviews is a visual HTML page** carrying the feedback layer
   (`~/.claude/review-kit/feedback-layer.js`, `data-fb` blocks) so he can
   annotate it and copy his notes back in one action.
6. **One question at a time, always with a recommendation.**
7. **Worker agents never commit.** The conductor commits after re-running the
   evidence itself.
8. **Absent means absent.** Never render a zero, an estimate, or a green tick
   for something nobody has checked.
9. **A check that cannot fail is not a check.** Put the bug back, watch it fail,
   restore it. Say so in the report.
10. **Give each parallel agent its own files and its own ports.** Two agents in
    one file, or two QA runs on one port, have both cost a day already.

---

## 4. Green baselines — re-run, do not trust

All of these were run by the conductor on 2026-07-30 evening, on the merged tree:

| Command | Result |
|---|---|
| `npm run build` | clean |
| `npm test` (engine + hub + desktop) | **353 + 188 + 11 = 552 pass, 0 fail** |
| `npm run qa` | **381/381 + 8/8 + 4/4**, all executed |
| `npm run qa:app` | **16/16** on the installed Windows app |

`npm test` includes the desktop suite as of `cce09ac` — before that the
owner-token proof was runnable only by hand.

Rules the suites learned the hard way: a run that executes fewer checks than
expected is a FAILURE, never a pass; wait on observable conditions, never
sleeps; and a QA run is **no longer fully offline** — connecting a repository
makes real `gh` calls.

---

## 5. What is DONE and on his screen

Verified by clicking the installed app (16/16):

- **Sign in with Claude and Codex** through the apps already on his PC. No API
  key.
- **Agents**: create, edit, pause, per-agent app and model, skills, and who may
  use each one (owner-only by default).
- **The reach ladder** — four rungs from "just talk" to everything the app can
  do on this computer, with eight powers listed individually and an honest
  per-app report of where the switches truly are the boundary. *(But see §0.1 —
  the ladder can currently contradict its own switches.)*
- **13 Claude models**, discovered by asking the CLI, and the model list now
  prints its own provenance: *"the list Cloud9 last proved by running it, not
  checked just now"*. Codex draws no such sentence, because the engine writes
  none — inventing one would be a lie.
- **The casting room** — 8 built-in software roles with real briefs and drawn
  portraits; hiring copies one into his crew, fully editable.
- **The skill library** (new) — 15 researched skills on 5 shelves, reachable
  from any agent's own file. Each card says when it helps, shows the whole
  procedure, and names **where it came from**. A library skill is the same row
  as one he typed: same pencil, same bin, no badge. Closed by construction, and
  a check compares the two rows and fails if they differ.
- **Real presence** — ready / working / paused / offline with the reason.
- **Chat**: scrollback, search, reactions, edit, delete, threads (with a setting
  for inline-vs-thread), attachments, account-level unread, markdown.
- **Rooms**: browse, join, leave, archive, roles — and an agent names its owner
  wherever it appears, because admitting an agent admits a person.
- **Jobs**: delegate, approve/reject, a record of what the agent did, its own
  written summary, and emoji as work happens.
- **PROJECTS in the icon rail** — connect a repository, see its pull requests
  and issues, which agent is on which branch, and **"Look at GitHub now"**,
  which really asks GitHub. A mistyped repository says so when he connects it.
- **The permission card for pushing** — what will happen, to which repository
  and branch, how many commits and files, and a countdown. `expired` is its own
  state: nobody answered is not the same as he said no.
- **An agent can decide to push by itself** — `@Agent !code <what to do>` works
  in its own git worktree, commits to its own branch, and asks before anything
  leaves the machine. The card's facts are **counted** by git/gh, never quoted
  from the agent.

## 6. What is DONE UNDERNEATH but NOT on his screen

- **`!code` is a typed command, not a control.** The card it produces is fully on
  screen; the way in is not.
- **Nothing links a Cloud9 project to a folder on this computer.** A project is
  `owner/name`; `!code` uses `EngineOptions.repoDir`, set once at launch. With no
  folder the agent says so plainly rather than inventing one.
  (`docs/plans/approval-handoff.md` §8.)
- **Per-role ordering in the skill library only works in the second after
  hiring** — nothing records which template an agent came from, so after a save
  the role is genuinely unknown and the library falls back to natural order. The
  fix is a field on `AgentDef`; a renderer guess was refused.

## 7. What is NOT done at all

- **Friends still cannot connect**, and the reason is bigger than Tailscale.
  Read `docs/plans/tailscale-setup.md`. The hub already refuses to listen on
  every network and the plumbing for a private-network bind exists — but
  **nothing on any screen calls it**, and worse, the packaged app **always
  starts its own hub and always talks to it**. There is no "join someone else's
  Cloud9" mode. That is the real missing feature. Tailscale itself is not
  installed. His browser sign-in is the one step nobody can do for him.
- **Agents cannot hand work to each other**, and they remember nothing between
  conversations.
- No web GUI; the phone app is a scaffold that has never run.
- `wholeComputer` and `connections` are wired but inert — no folder picker, no
  per-agent MCP file. The screen says so rather than pretending.
- **Narrow widths are untested.** The UI pass could only test 1280 — the tool it
  used to resize the window reported success while never resizing. It caught
  that itself and reported it rather than inventing results.

---

## 8. Two findings reports worth reading before touching anything

- **`docs/qa/phase5-negative.md`** — the first time anybody attacked the app.
  ~90 hostile inputs: **0 crashes, 0 blockers, 7 Majors, 11 Minors, and no way
  in for an attacker anywhere.** Script tags, SQL injection and FTS5 operators
  all held. The seven Majors are FIXED (see `bf64cc3`). It also caught and
  discarded three false findings of its own, one of which would have reported
  three blockers that do not exist.
- **`docs/qa/phase6-ui.md`** — the UI pass. **0 blockers, 1 Major, 2 Minors.**
  All three are what the in-flight agent is fixing (§0). Four of his five
  2026-07-30-morning complaints are confirmed fixed on screen.
- **`docs/reviews/durability-review.md`** — a Fable review of the atomic-write
  work. Verdict SOUND WITH GAPS; every gap it found is now closed.

## 9. The mistake of 2026-07-30 evening — do not repeat it

A worker reported that his database held "23 agents all called Scout" and that
the new naming rule protected them. I repeated that to Vikas. **It was wrong.**
Those 23 (now 35) Scouts are in the **development** database at the repo root.
His real database at `%APPDATA%\cloud9` holds five agents with distinct names:
Opus, Sol, terra, Architect, sonnet.

The protection is genuinely proved — 5/5 against the database that really holds
duplicates, and 4/5 against his own, the single failure being that script's own
assertion that duplicates exist there. But **check which database a claim is
about before repeating it**, and correct a false claim to him in plain words the
moment you find it. `scripts/qa-his-db.mjs <path-to-a-COPY>` is the tool; it
refuses the original by path.

---

## 10. Decisions he has already made — do NOT ask again

| Decision | His answer |
|---|---|
| Design | **Studio** — `docs/mocks/p3-studio.html` is the law. He rejected three others and judges only by seeing the whole thing. |
| Agent capability | **Everything Claude Code and Codex can do on his PC.** Keep the isolation from HIS personal config; raise the ceiling. |
| Code to GitHub | **Branch + pull request, ALWAYS.** Nothing lands on the default branch without him. |
| Agents in parallel | **Git worktrees**, one per agent/task. |
| Marketplace | **Built into the app**, no server, software roles first. |
| Reach of the app | **Private network (Tailscale) first**; public website later on his Vercel Pro. |
| Backend shape | Agents overnight on **his own PC**, his subscriptions pay. |
| Where the hub should eventually live | Hybrid — hub hosted, agents local. `docs/plans/backend-decision.md`. |

---

## 11. What I would do next, in order

1. **Finish and verify the in-flight round** (§0), especially the ladder.
2. **Make friends possible** — `docs/plans/tailscale-setup.md` §3. Three pieces:
   a Settings panel using the IPC that already exists, a **"join a remote hub"**
   mode which is the genuinely missing feature, and an honest refusal message.
   His browser sign-in is his part.
3. **Record which template an agent was hired from** (`AgentDef`), so per-role
   skill ordering survives a save.
4. **Give `!code` a control on screen**, and link a project to a folder on this
   computer.
5. **Test narrow widths properly** — nobody has, and the last attempt's tooling
   lied about resizing.
6. **A Codex provenance sentence** in `packages/engine/src/harness.ts`, so his
   Codex card is as honest as his Claude one.
7. Agent-to-agent handoff, and memory between conversations.

---

## 12. Where the detail lives

| File | What |
|---|---|
| `RESUME.md` | The running plan, the laws, the day-by-day log, his verbatim feedback |
| `docs/plans/spec.md` | His original product specification — still the north star |
| `docs/plans/tailscale-setup.md` | His steps, our steps, and the honest risks |
| `docs/plans/wholefile-handoff.md` | Written when four unsafe writes remained; all four are now closed |
| `docs/plans/approval-handoff.md` | The permission round trip; §8 is the open ask |
| `docs/plans/skills-library-handoff.md` | The skill-library contract |
| `docs/plans/capability-handoff.md` | The reach-ladder contract |
| `docs/qa/journeys.md` | The 16 acceptance journeys, written from his spec |
| `docs/qa/app-*.png` | Screenshots of the real installed app from the last walk |
