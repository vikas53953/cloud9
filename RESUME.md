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

- **2026-07-30 — PROJECTS IS ON HIS SCREEN, COMMITTED AND PUSHED** (`d273984`,
  with `dd857d4` correcting the handoff). Changed: `apps/desktop/src/{App,store,
  styles}`, `scripts/qa.mjs`, `scripts/drive-app.mjs`, and a new
  `docs/plans/projects-handoff.md`. Verified by running, in that session:
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

- **2026-07-30 afternoon — CLOUD9 CAN ACTUALLY ASK GITHUB** (`abbf06a`, pushed).
  The Projects hole is closed: `lookAtRepository` is the one owner of "how we
  ask GitHub about a repository", `commandLine()` the one owner of "how a
  command line is built", `isBranchName()` moved to shared as the one owner of
  its question. On screen: "Look at GitHub now" with a busy state the HUB owns
  (so it always ends), a three-state last-looked-at chip, and the refusal
  printed beside the button.
  - Read-only by construction: a four-command allowlist, and the client is built
    with no approver so every writing method throws. Both asserted in tests, so
    nothing here needs the approval path.
  - Eight failure sentences a person can act on. None is a stack trace; none is
    a silent empty list.
  - The comma trap is pinned: every command line a look builds is run through
    the REAL guard in a test. The guard was NOT widened — the need for the comma
    was removed.
  - **Verified by the conductor, not the worker:** build clean; **302 engine**
    (was 279); **166 hub** (was 159 — the worker never ran its own 7, I did);
    **350/350 + 8/8 + 4/4** browser, all executed; and a live read through the
    real `gh` — `cli/cli` returned **161 open items** with its trunk read as
    `trunk` (never guessed as `main`), `vikas53953/cloud9` returned 0 because it
    truthfully has none, a non-existent repository returned the plain sentence,
    and the writing path refused with `ApprovalRequiredError`.
  - **NOT claimed:** the button has never been clicked in the INSTALLED app and
    no browser check covers it. By the law above it is not DONE until it is.

- **2026-07-30 late afternoon — AN AGENT CAN DECIDE TO PUSH BY ITSELF**
  (`2050572`), and **PHASE 5 NEGATIVE TESTING RAN FOR THE FIRST TIME**
  (`89ec976`), and the installed-app walk now presses the Look button
  (`360c8c2`). All pushed.
  - `@Agent !code <what to do>` in a room: the agent works in its OWN git
    worktree, commits to its own branch, and only if it writes `!publish` does
    it ask — through the existing approval path, drawing the existing card.
    The card's facts are COUNTED by git/gh, never quoted from the agent, so an
    agent that calls two files "a one-line comment, straight onto main" still
    produces a card reading 2 files / 1 commit / its own branch / base master.
    An agent that changed nothing produces no card at all.
    Proved three ways on the real repository — refused, ignored, approved (PR #3
    into master) — then cleaned up, and the CLEANUP was re-checked by the
    conductor against real GitHub: 0 open PRs, 0 remote `cloud9/*`, one
    worktree, `* master` alone.
  - **Phase 5: ~90 hostile inputs, 0 crashes, 0 blockers, 7 Majors, 11 Minors,
    and no way in for an attacker anywhere** — script tags, SQL injection and
    FTS5 operators all held. Full report: `docs/qa/phase5-negative.md`. It also
    caught and discarded THREE false findings of its own, one of which would
    have reported three blockers that do not exist. Review page:
    https://claude.ai/code/artifact/3a662b7c-d50f-47a4-be30-e20b45efa769
  - **Verified by the conductor:** build clean; **315 engine**; **166 hub**;
    **354/354 + 8/8 + 4/4** browser, all executed; **15/15 on the INSTALLED
    app** — the fifteenth check is new and it PRESSES the Look button. It was
    proved real by breaking it on purpose (14/15, "NOT ON SCREEN") and restoring.
  - Two honest gaps: `!code` is a typed command with no control on his screen,
    and nothing links a Cloud9 project to a folder on this computer
    (`approval-handoff.md` §8).

- **2026-07-30 evening — ONE RULE FOR NAMES, ONE RULE FOR SAVING** (`bf64cc3`,
  proof from the installed app `86fe446`). Both pushed.
  - `validateName` in shared is the only thing that answers "is this a name" —
    length, is-this-actually-a-name, no control characters, and
    you-already-have-one-of-these folded on case/spacing/Unicode. Enforced at the
    HUB across channels, agents and projects, and it caught a fifth namer nobody
    had listed: skill names. Six spaces are REFUSED IN WORDS, never rewritten.
    The duplicate question is only asked when a name actually CHANGES, so names
    already in his database stay editable — a rule that locked him out of his own
    data would be the worse bug.
  - `client.refused` / `client.submit` own "what happens to what he typed when a
    form is refused": nothing is cleared until the hub has accepted it. Composer,
    quick chat, new channel, agent editor, connect-a-repository.
  - `isSafeFileName` is one list where each rule carries its own test AND its own
    words, and the sentence is those words joined — the check and the explanation
    are now the same object, which is the real fix for the drift. `report(1).pdf`
    and `café-menu.txt` land; separators, `..`, device names still refused.
  - Connecting a repository now really asks GitHub, so a typo says so at once —
    and "could not ask" stays a different sentence from "does not exist".
  - **A regression WE introduced this afternoon, caught by the Fable review and
    fixed:** making writes atomic had made them silent, so the app said
    "⏰ Scheduled!" when the save failed, and the approved-job path marked tasks
    COMPLETED the same way. `writeoutcome.test.ts` now reads this package's own
    source and fails unless every write uses its result or carries a written
    justification — future callers are covered without anyone remembering.
  - **Verified by the conductor:** build clean; **engine 348** (was 329);
    **hub 180** (was 166); **363/363 + 8/8 + 4/4** browser, all executed;
    **15/15 on the INSTALLED app**; twelve bug-backs between the rounds.
  - **A false claim of mine, corrected in the same session:** I repeated a
    worker's line that "his 23 Scouts stay editable". Those 23 Scouts are in the
    DEV database at the repo root (35 of them now); his real database at
    `%APPDATA%\cloud9` holds five agents with distinct names — Opus, Sol, terra,
    Architect, sonnet. The protection is proved 5/5 against the dev database and
    4/5 against his own, the one failure being that file's own assertion that
    duplicates exist there.
  - Also landed: `docs/plans/tailscale-setup.md` and
    `docs/plans/wholefile-handoff.md`.

- **2026-07-30 ~19:45 — THE LADDER ROUND IS VERIFIED AND MERGED** (`b9bac74`,
  pushed; `wip/ladder-round` deleted after merging). A new Fable session took
  over from the Opus conductor at Vikas's word and ran all four proof commands
  itself: build clean, **552 tests** (353 engine + 188 hub + 11 desktop),
  **397/397 + 8/8 + 4/4** browser (expectation raised 381 → 397), **16/16 on
  the installed app**, all executed.
  - Landed from the round: the ladder is DERIVED from the switches by exact
    match (a hand-picked mix says "Your own mixture" and no rung claims to be
    his choice); Escape closes every overlay through one owner (stack checked,
    newest-first); the "1 CATEGORIES" plural fixed at its one owner.
  - **The round's own banner said "2 abilitys"** — caught by its own new check
    on my re-run. Fixed as a class: `plural()` in App.tsx now knows
    consonant-y → "-ies", so every caller is covered (`547038d`).
  - **NOT reached by the round, still open:** the six older renderer findings
    (#9, #16, #17, #18, #19, #21) — verified by diff, no claim of credit.
  - **Honest label:** the installed app on this machine is the PRE-round build;
    16/16 proves no regression there, but the ladder fix is not on the app he
    double-clicks until the installer is rebuilt. Fold `npm run dist` +
    reinstall into the next round's proof.

- **2026-07-30 evening — VIKAS'S DIRECTION (from his agents' gap analysis run
  inside Cloud9 by Opus/Sol/sonnet):** spawn agents on every feedback item,
  but LIST FIRST AND ASK before implementing. The list, as put to him:
  1. Shared artifact store with attribution (the #1 gap — no more pasted file
     paths; acceptance test = re-run the same workflow, friction gone).
  2. Verify the "absent" claims before building — the analysis calls search and
     threads absent, but both are on screen; either their agents can't reach
     them (a real, different bug) or the analysis ran on an old build.
  3. Turn discipline — he repeated "the file's on disk" four times.
  4. Visible agent state + errors in words (no "check the app's log").
  5. Parked: zero-install onboarding (the Buzz risk), notifications,
     integrations, export, mobile; re-verify Slack pricing + Buzz README before
     the analysis doc is published anywhere.
  Awaiting his go on the order at the review page (artifact 67419530).

- **2026-07-30 ~21:40 — ROUND 1 OF THE FEEDBACK BATCH IS ON HIS MACHINE.**
  Commits `bfc2b9b` (gap audit), `70514f8` (artifact store server half),
  `0f4e3e7` (chat follow), all pushed. Verified by the conductor on the
  combined tree: build clean, **582 tests** (369 engine + 202 hub + 11
  desktop), **410/410 + 8/8 + 4/4** browser, all executed. Installer rebuilt
  (`Cloud9-Setup-0.1.0.exe`, exe stamped 21:30), silently installed, and the
  fresh install walked: **16/16**.
  - Chat: `useFollowToBottom` is the one owner of when a list follows its
    bottom (room + thread panel, four named reasons, never steals from a
    reader scrolled back); `scrollBehavior()` owns may-this-machine-animate;
    the composer grows; Send-by-click keeps the cursor. 13 new checks, each
    proved by putting the bug back.
  - Findings #9 #16 #17 #18 #21 were proved ALREADY FIXED by `fd36680` —
    "Still open" item is corrected below.
  - Artifact store server half: identity (conversation, name), per-version
    attribution, hub computes every fact, one-use ticket reuse, publishes via
    `respondAs`. NOT on screen yet — `artifact-store-handoff.md` is the
    contract for the screen half.
  - THE GAP AUDIT (`docs/qa/gap-audit.md`): agents live in a 20-message
    keyhole; the `trigger` never reaches any real provider (scheduled/job
    turns get a chat prompt); agents have no doorway back into Cloud9 (their
    "no search" claim was true of THEIR world); the top rung's prompt promises
    reach `host.ts` never grants; the agent editor discards typed work
    silently (MAJOR); six error-legibility spots named.
  - New known rough edges from the chat agent's sweep: the emoji tray ignores
    Escape and click-away (needs a popover-dismissal class decision); there is
    no "jump to newest" control; `qa-stack.mjs` deletes every `cloud9-qa-*`
    workspace at startup so parallel QA runs can destroy each other.

- **2026-07-31 ~00:25 — ROUND 2 IS SHIPPED AND ON THE INSTALLED APP.** While
  Vikas was out (birthday), the Fable conductor drained the whole queue.
  On master, pushed, verified by the conductor on the combined tree: build
  clean, **660 tests** (407 engine + 242 hub + 11 desktop, incl. Cursor's
  insider/naming/phase-5 suites), **440/440 + 8/8 + 4/4** browser, **16/16 on the
  freshly installed app** (built 00:21, reinstalled, walked).
  - Engine (`cea8b57`): TurnBrief so the instruction can't be dropped; a named
    character context budget; the `search_conversation` doorway proved end to end
    on this machine; the top rung derived from what host.ts grants; `refusal.ts`.
  - Screen (`acdc518`): artifact cards from `cloud9://artifact/…`, `useUnsavedWork`
    guarding every navigation, `sayable()` for plain-word errors.
  - Cursor round 2 (`0ab921b`, merged): insider security sweep (NO data-leak
    holes; its one finding was the Error: prefix, already fixed by refusal.ts),
    naming torture, phase-5 repro, keep-awake script.
  - Cursor round 1 earlier (`06f19a6`): honest search fallback, true unread
    counts, safe parallel QA, +10 skills (25 total).
  - Conductor's own slice (`feat/join-invites`, merged): `hubaddress.ts` — the
    one owner for "where is the hub I'm joining", the foundation of friends
    connecting; refuses public-internet addresses. 18 tests.
  - **A conductor bug, caught and fixed by the installer build, not hidden:** the
    hubaddress test imported `./hubaddress.ts`; the strict `build:app` rejects a
    `.ts` import extension, so the FIRST installer build failed. Root cause: shared
    had no test script and was never built with its tests. Fixed the import to the
    `.js` convention AND gave shared a real test script wired into the root suite,
    so its 18 tests run with the rest from now on (`fix` before the rebuild).
  - **In flight for when he returns:** four Cursor feature lanes queued in
    `CURSOR-BACKLOG.md` (GitHub-deep, join-hub relay, agent memory+handoff,
    notifications) — awaiting Cursor agents; the conductor watches `cursor/*` and
    reviews+merges each push.

## Still open, in priority order (nothing here needs Vikas)
0. **Round 2 of the feedback batch** (he said go on the whole batch):
   the audit's five fixes as classes (trigger reaching `buildAgentPrompt`; the
   context keyhole; a doorway tool — search first; prompt derived from
   truly-granted flags; unsaved-work guard on the editor; one error-sentence
   owner), the artifact store SCREEN half (`artifact-store-handoff.md`), and
   the GitHub controls on screen (`!code` button + project↔folder link,
   `approval-handoff.md` §8).
1. **Old renderer findings**: #9 #16 #17 #18 #19 #21 are all CLOSED (proved
   2026-07-30). Still open from that list: the P3s (unread capped at 1000
   reporting "999", the no-FTS5 fallback searching raw JSON, `runstore`
   non-atomic writes, two unlinked retention constants), plus the new sweep
   finds: emoji-tray dismissal, no "jump to newest", parallel-QA workspace
   deletion.
3. **The 7 Majors from phase 5** (`docs/qa/phase5-negative.md`) and the 2
   Minors from phase 6 (`docs/qa/phase6-ui.md`) — phase 6's Major (the ladder)
   is now fixed and merged; the rest are not.
4. **No way to join someone else's Cloud9** — the packaged app always starts
   its own hub; Tailscale is not the blocker. The next big feature.
5. **Codex cannot be isolated** as tightly as Claude — four of its own tools and
   the owner's Codex skills still load. Written down, not fixed.

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
