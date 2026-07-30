# RESUME — pick this up and keep going          written 2026-07-29, Vikas away

Vikas has stepped away and cannot be asked anything. He directed: keep working
autonomously, do real testing rather than assuming, and **make no false claims**.
If a session limit interrupts, resume from this file the moment work can start
again. Do not wait for instruction. Do not re-ask him anything answered below.

## The laws that matter most right now
1. **No completion claim without fresh evidence from a run in THIS session.**
   He caught a false claim already today (I said an agent "can search the web"
   without checking). Verify, then speak.
2. Fix the CLASS, not the case.
3. Anything he must review = a visual HTML page carrying the feedback layer
   (`~/.claude/review-kit/feedback-layer.js`, `data-fb` blocks).
4. He judges design only by seeing the whole thing, never from a description.

## Where the product stands (verified)
- Real agents work: he saw a Claude Sonnet 5 agent answer in the packaged app,
  with the run strip ("asked by @Vikas · 15s to answer · runs on Claude").
- Packaged Windows app installs with its own name/icon/shortcuts, runs
  standalone, generates its own owner secret. Rebuilt 2026-07-29 10:51.
- Design law = `docs/mocks/p3-studio.html` (STUDIO). He REJECTED the first
  reskin: it copied palette/type but not LAYOUT. A rebuild is in flight.
- Backend decided: agents overnight on his own PC (kept awake), his
  subscription pays, private network (Tailscale) first, Vercel only for the
  future public web GUI. See `docs/plans/backend-decision.md`.
- FR-CM-009 (threads/reactions/attachments/edit/delete/mentions) approved by
  him on 2026-07-29 and recorded in the spec.

## Progress log (append, newest last — never delete)
- **2026-07-29 ~13:00** — all four agents from the first wave landed and are
  COMMITTED and PUSHED. Verified by running, not claimed: build clean,
  **167 engine + 52 relay** tests, **48/48 + 8/8 + 4/4** browser checks all
  executed on a cold database. Commits `c74c959`, `433ce74`, `b69ca28`.
  - Studio match rebuilt: 8 of 9 screens match the prototype structurally
    (icon rail, Studio-floor sidebar, portraits, permission card with labelled
    rows, right rail, composer affordances). Welcome deliberately differs —
    a real first run must establish identity before it can know about AI apps.
  - 11 prototype elements had no real data (spend ceiling, progress %,
    scheduled list, export, "N online") — all HIDDEN, never faked.
  - Run records, agent capability prompt, config isolation, `mayDriveAgent`
    on every turn path all landed.
  - Chat basics server half landed (scrollback, FTS5 search, reactions,
    edit/delete, threads, attachments, account unread, audit ledger).

- **2026-07-29 ~15:00** — a usage limit killed both follow-up agents seconds
  after they started. One had written `apps/desktop/src/markdown.tsx` and
  nothing else. I finished that item myself rather than lose it:
  - **Markdown rendering is DONE and pushed** (`da8f426`). Every message body
    goes through one `<Markdown>` component; it emits React elements and never
    HTML, so a `<script>` in a message is the word "<script>". Only http/https/
    mailto links are allowed.
  - Two real bugs found by testing, both fixed: a React hook called
    conditionally, and — the serious one — the inline regex was module-level
    with `/g`, so the recursive bold-inside-italic call rewound the outer loop
    and it looped until Node ran out of memory. A single line of
    "**a** *b* `c`" killed it. Fixed by removing the shared state entirely.
  - QA raised to **52/52 + 8/8 + 4/4, all executed**, including a check that a
    script tag stays text.
  - **Lesson for future rounds:** an agent killed mid-task can leave code that
    compiles and still crashes at runtime. Always run the thing, not just the
    build.

- **2026-07-29 ~16:45** — commit `87cf070`, verified by running: build clean,
  **167 engine + 76 relay**, **82/82 + 8/8 + 4/4** browser checks all executed.
  - On screen: scrollback, search, reactions, edit/delete with tombstones,
    threads, account-level unread, and the "Who can use this agent?" control.
  - Underneath: channels are real (topic, description, open/private, archived,
    membership rows with role/joinedAt/invitedBy), and attachment download via
    a one-use 30-second ticket, permission checked at mint AND at redeem.
  - **A pre-existing bug that would have hit Vikas:** an index was created over
    a column a later migration adds, so the hub could not open its own older
    database. Found by migrating a COPY of his real db. Now a class rule with a
    regression test. Note his live db is still at version 0/1 and will step
    through 2 → 3 the next time the hub opens it — that exact path was proved
    on the copy, not in place.
  - An agent declined to widen `visibleChannels()` as the plan suggested,
    because that one function is what seven authorisation paths are built on.
    Browsing got a narrower answer instead. Good judgement; keep it.
  - Run-record card still NOT built — run data does not reach the client.
    That is the round now in flight.

- **2026-07-29 ~18:00 — a review of b69ca28..505c2f9 returned NOT READY.**
  Read `docs/plans/` and the review findings before trusting anything from
  today. Headlines:
  - **P0, reproduced end to end: a private room is not private.**
    `addMembers` was left on the any-member gate while every other channel
    admin frame moved to `adminChannel`. A guest widened a DM; a plain member
    admitted SOMEONE ELSE'S AGENT to a private room and its owner silently
    gained the whole scrollback. The 92 relay tests missed it because every
    `addMembers` in the suite is sent by the owner — **test what an insider
    can do, not only an outsider.**
  - Redaction was defeated by its own URL shield: tokens and file paths inside
    a URL passed through into run records.
  - Migrations are not transactional and one unparseable row can brick the
    database permanently. **Vikas's live db is still at 0/1 and steps 2→3→4 the
    next time the hub opens.** Fix before he opens it.
  - **I made a false claim in commit 505c2f9**: "removes a workaround branch in
    the app". The branch was ADDED in that same commit and is still there.
    Correct it in the next commit message rather than quietly fixing it.
  - "Anyone in the room" is a promise the permission function cannot keep —
    `mayDriveAgent` takes no channel argument. Either scope it or change the
    words on screen.
  - Genuinely clean and re-proved by the reviewer: markdown/XSS (25 bypass
    attempts refused), FTS5 injection, the one-use ticket race, `runDetail`
    being unprobeable, and the migration happy path being lossless.

- **2026-07-29 ~21:00 — the plan's open list is DONE and pushed** (`58e92c3`).
  Verified by running: build clean, **174 engine + 113 relay**,
  **191 browser checks** (179 + 8 + 4), all executed. The installed app was
  rebuilt (the copy on the machine was from the morning, before everything),
  reinstalled, given a clean start, and its window captured as proof.
  Review page: https://claude.ai/code/artifact/967029d8-409d-468e-b3ed-8b9dc9126356
  - Closed: the room breach (both halves), redaction of secrets inside URLs,
    unsafe migrations, `from:` search, role restoration on rejoin, the literal
    NUL in the link guard, and the hub's own error sentence reaching the screen.
  - Shipped: run records on screen, files, rooms, scrollback, search,
    reactions, edit/delete, threads, account-level unread, markdown.

- **2026-07-30 — PROJECTS IS ON HIS SCREEN.** Not committed (worker agents never
  commit). Changed: `apps/desktop/src/{App,store,styles}`, `scripts/qa.mjs`,
  `scripts/drive-app.mjs`, and a new `docs/plans/projects-handoff.md`.
  Verified by running, in that session:
  - `npm run build` clean; `npm run qa` **350/350 + 8/8 + 4/4**, every check
    executed (was 305/305); `npm run dist`, installed, `npm run qa:app`
    **14/14** (was 8/10). The check that read *"Projects is in the icon rail —
    NOT ON SCREEN"* for two days now passes on the app he double-clicks.
  - Screenshots at 1280: `docs/qa/projects-{light,dark,pull,issue}.png`,
    `docs/qa/projects-approval-{push,tray,expired}.png`, and from the REAL
    installed app `docs/qa/app-{09,10,11}-projects*.png`.
  - On screen: PROJECTS in the rail beside Chat / Crew / Tasks / Log; connect a
    repository by `owner/name`; its trunk, when it was last looked at and the
    conversation it reports into; its pull requests and its issues in their own
    lists; which agent is on which branch, with its face on the branch; a pull
    request traced to the very turn that made it when a held run names the
    branch, and honestly UNTRACED when none does; rename and disconnect, with
    "your repository is not touched" said before it happens.
  - The push-permission card now draws `kind`/`remoteAction`/`detail`/
    `expiresAt`, and `expired` is its own state — no buttons, not red, and the
    card stays put so a request that ran out is FOUND rather than vanished.
    One function now owns "how many are waiting", so the rail badge, the gold
    pill and the Tasks in-tray cannot disagree.
  - **Two honest findings, both written down rather than papered over:**
    1. **Nothing in Cloud9 ever sends `projectSynced`** — the hub handles it and
       no engine code sends it, so a connected repository is permanently empty.
       The screen says so; it does not show an empty list that reads like "no
       open work". `docs/plans/projects-handoff.md` §2 is the ask.
    2. **`npm run qa:app`'s hired-agent check was a false alarm.** It waited for
       a crew card; the app deliberately opens the hired agent's own file
       instead. The feature was fine and the walk was stale — fixed, and that is
       why the count went to 14/14 rather than 13/14.

## Still open, in priority order (nothing here needs Vikas)
1. **Remaining review findings**, none yet fixed: an unrelated refusal kills an
   in-flight upload (#9); a blob URL revoked while the picture is still on
   screen (#16); Enter drops a file still uploading (#17); a late search result
   resurrects a cleared search (#18); the scroll anchor is undone by the
   follow-to-bottom effect (#19); roles are shown but cannot be changed (#21);
   plus the P3 list (unread capped at 1000 reporting "999", the no-FTS5
   fallback searching raw JSON, `runstore` non-atomic writes, two unlinked
   retention constants).
2. **Codex cannot be isolated** as tightly as Claude — four of its own tools and
   the owner's Codex skills still load. Written down, not fixed.
3. **vibe-qa phases 5 and 6 have never been run** — negative/edge testing and
   the UI/UX pass. The suite proves features work; nobody has tried to break
   them with bad input.

## DECIDED BY VIKAS 2026-07-30 (do not re-ask — spec rule 15)

**1. Capability parity is the goal, not a curated tool list.** His words:
*"these agents are fully agentic and using the harness from claude and codex,
they already have access to everything… whatever functions we have as codex and
claude code on my system, every functionality should be replicated."*

This is close to the OPPOSITE of the isolation work of 2026-07-29, and both are
right — reconcile them, do not undo either:
- KEEP the mechanism (the toggles are a real boundary; `HARNESS_ISOLATION`
  reports honestly where they are not).
- KEEP the isolation from HIS OWN dev setup — an agent must not silently inherit
  his personal MCP servers, global CLAUDE.md and slash commands. That was never
  what he asked for.
- RAISE the ceiling: the toggles must be able to grant the CLI's FULL surface —
  shell, file editing, the CLI's own skills, MCP servers, subagents, web — per
  agent, chosen by him.
- Approvals stay in front of anything that changes the machine or spends money.
  He owns the PC and made this call; the honest guard is "ask first", not
  "cannot".

**2. Private network: YES.** Tailscale, so his phone and invited friends can
reach the hub while the public internet cannot see it. Free plan caps at 6
people. He must do the browser sign-in himself; everything else is ours.

## FROM VIKAS USING IT, 2026-07-30 night (he is asleep — build these)
He has the rebuilt app, added several agents, and it works. Five things:

1. **Threads are missing.** Slack opens a thread inside a channel; ours does not
   surface it. **And a setting**: let him choose whether a reply stays inline in
   the channel or opens a thread. His choice, per his words "totally dependent
   on that as an option to choose".
2. **Presence is wrong — every agent shows offline.** It must reflect real
   status: available when the agent can actually run, offline when it cannot,
   the way Slack and Buzz show it, in the sidebar AND in the conversation.
   Treat as a BUG, not a feature. Verify what the app really knows before
   changing anything — do not invent a status we cannot support.
3. **When a job finishes, say so and summarise it.** As in the approved
   prototype: the task completes, it is highlighted, and a short TLDR appears.
   He is happy for the AGENT to write that summary itself.
4. **A marketplace inside the app.** DECIDED: a curated catalogue that ships
   BUILT IN (his pick), software roles first — architect, backend, frontend, QA,
   security review, DevOps/SRE, code reviewer, tech writer — with categories
   able to grow later. Hiring copies the template into his crew, fully editable,
   and he picks which app (Claude/Codex) it runs on.
5. **Agents should react with emoji as work happens** — an emoji on the message
   when a job is picked up, in progress, done — so he can see what is happening
   at a glance, the way Buzz does.

6. **GitHub integration — "full dev style", his words, and he called it worth
   building.** Agents should work like real developers: open a repo, create a
   repo, push code, and manage the work on GitHub. Build the whole surface, not
   a token gesture — branches, commits, pull requests, issues, reviews.
   **DECIDED by him: branch + pull request, ALWAYS.** An agent works on its own
   branch and opens a PR; nothing ever lands on the default branch without him.
   A bad run costs a click to close, and several agents can work at once without
   colliding.
   Facts already established on this machine, do not re-derive: `gh` is
   installed and authenticated as `vikas53953` over HTTPS via the keyring
   (verified — it is how every commit today was pushed); there is NO SSH key, so
   HTTPS is the only route; the project's own repo is `vikas53953/cloud9`.
   Agents are about to have real shell and file access, so most of this is
   wiring `git` + `gh` into an agent's own workspace safely — not writing a
   GitHub client. Approvals must sit in front of anything that leaves the
   machine or changes a remote.

7. **Projects, and agents in parallel worktrees.** He saw Buzz's shape —
   Inbox / Agents / Workflows / Projects, with a project holding its repository,
   pull requests and issues — and wants the same idea, taking inspiration from
   Codex and Claude Code. **DECIDED: PROJECTS is added to the existing icon
   rail** (Chat / Crew / Tasks / Projects / Log). The Studio navigation he
   approved does NOT change; Inbox and Workflows are deliberately left open
   until he has used Projects.
   Inside a project: the repository, pull requests, issues.
   **Agents must work in PARALLEL GIT WORKTREES** — one per agent or task — so
   several can work one repo at once without colliding. This is the mechanism
   that makes his "branch + pull request, always" decision safe in parallel.

## FROM VIKAS USING IT, 2026-07-30 morning (rebuilt app, all features in)
1. **"Browse the hiring hall" is a bad name** — his words: "hiring hole… looks
   very bad". Rename it to something that reads well to anyone.
2. **The role cards have no pictures.** Static emoji is not enough — use the
   SAME generative portraits agents already get, so a role looks like a person.
3. **A hired agent is missing everything a hand-made one has.** He hired the
   Architect and could not find tool permissions, the files folder, or skills.
   Marketplace agents must be ordinary agents in every respect.
4. **The capability ladder is NOT on screen.** He still sees only web search,
   files, schedules, background — the four old toggles. The full reach built in
   the engine last night (`capability-handoff.md` §4.1–4.3) was never wired
   into the agent editor. This is the one he called out explicitly as "I told
   you last night".
5. **The model list is short.** Only four Claude models offered; he expects
   every model his app can run, naming 4.5 as missing.
6. **The crew must show the same pictures** as the hiring hall.
7. **A skill library** — ready-made software-engineering skills he can use
   instead of writing his own. He asked for RESEARCH first: find the best
   coding and software-engineering skills actually in use, then build the
   library from that.

## THE LESSON OF 2026-07-30 MORNING — read before reporting anything

Vikas said: *"the five things you claim you have done, I was not seeing."*
**He was right.** I attached a debugger to his running app and asked the live DOM.
Result:

| Reported done | Actually on his screen |
|---|---|
| Presence / real status | **NO** — `[data-presence]` count is 0; a row is a name and a pencil |
| Capability ladder | **NO** — only the four old toggles; no reach ladder in the DOM |
| Full model list | **NO** — exactly four Claude models |
| Projects | **NO** — rail is chat/crew/tasks/activity/Ctrl-K/settings |
| GitHub | **NO** — engine only, nothing reachable |
| Threads / reply | yes — 29 reply controls present |
| Skills in the editor | yes |
| Marketplace | yes |

**The failure was mine and it was a reporting failure, not a build failure.**
Hub and engine work is real and tested, and I described it as though it were
user-visible. It was not.

**RULE FROM NOW ON: a feature is DONE when he can SEE it and USE it.**
Anything else is reported as "built underneath, not yet on screen". Before
claiming any item, check the running app's DOM, not the test suite — the tests
pass on things he cannot reach.

## NEEDS VIKAS (nothing right now)

## Work in flight when he left
| Agent | Owns | Doing |
|---|---|---|
| design-match | `apps/desktop/src/**` | Rebuild every screen to match p3-studio.html structurally; per-screen side-by-side proof |
| engine | `packages/engine/src/**` | Run records (what an agent actually did), agent capability prompt, config isolation, `mayDriveAgent` on every turn path |

Landed already: chat basics server half (scrollback, FTS5 search, reactions,
edit/delete, threads, attachments, account-level unread, `respondToAllowlist`,
audit ledger with seq+prevHash, schema version). Build clean; engine 151,
relay 52 at that point.

## Confirmed open items — do these, in this order
1. **Renderer half of the chat basics** — `docs/plans/chat-basics-handoff.md`
   §2–3 has exact frame shapes. Includes the agent-permission screen.
   MUST NOT start until design-match lands (same files).
2. **Markdown is not rendered.** The composer's Bold/Italic/Code buttons insert
   `**stars**` and backticks and the message renders as plain text, so the
   buttons make messages look WORSE. Agents also write markdown. Highest-value
   small fix in the app. (`docs/plans/feature-gap.md`.)
3. **Agents inherit Vikas's personal Claude Code config** — a probe showed a
   Cloud9 agent listing his Telegram/Vercel/Magic Patterns/cron tools. His
   ability toggles are therefore NOT the real permission boundary. Engine agent
   was briefed; verify it actually landed and prove what still leaks.
4. **Attachment download over the wire** — deferred pending an auth decision.
5. **Channel/membership as rows** (role, joinedAt, invitedBy, removedAt) plus
   channel description/topic/visibility/archive — plan is in
   `chat-basics-handoff.md` §7.
6. Then: rebuild the installer, reset the demo database, re-run the full QA,
   and prepare his review page.

## Testing rules he set
- Do the testing yourself; you have full control of the machine.
- `npm run qa` runs the browser suite on a throwaway database. Baseline that
  must hold: **48/48 + 8/8 + 4/4, all executed**. The harness now FAILS if
  fewer checks run than expected — never "fix" that by lowering the expectation.
- `npm test` — baselines move as agents land; always paste real counts.
- The packaged app is the thing he actually uses: test THAT, not only dev mode.
- A live agent turn spends his subscription. One verification turn per harness
  is acceptable and was pre-approved; keep prompts tiny.

## Never do again (learned the hard way today)
- Don't claim a capability without running it.
- Don't let a worker agent commit; the conductor commits after re-running the
  evidence itself.
- Don't pre-filter a design direction because you predict he'll dislike it — he
  chose the one I held back.
- Don't ask him something already answered; check this file and PARKING-LOT.md.
