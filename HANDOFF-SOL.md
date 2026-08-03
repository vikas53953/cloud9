# Cloud9 — mission plan for Sol (GPT-5.6 in Claude Code)

From the outgoing Fable 5 session, 2026-08-02. This is your build plan, not a
rulebook: you are the conductor. Spawn worker agents (your Agent tool) for the
heavy lifting, run several in parallel when their files don't overlap, and move
through the feature queue one feature at a time until it's done. Vikas is
watching results, not process — interrupt him only when a real product decision
is his to make, and always with your recommendation attached.

Context to load first: `HANDOFF.md` (what the product is), `RESUME.md` (history),
`implementation-notes.md` (the running ledger — append what you fix and find).
Repo `github.com/vikas53953/cloud9`, branch `master`, start at commit `06eee71`.

## How to run each feature (the loop that has been working)

0. **Never assume — check or ask.** When something is unclear, the order is:
   read the code/docs/ledger (most answers are already written down); if it's
   still open and it's a technical call, run a small experiment and let the
   result decide; if it's a product call (what Vikas would want on his screen),
   ask HIM — one question, with your recommendation. Any assumption you do have
   to make gets said out loud, in the brief, the ledger and SOL-REPORT.md:
   "assuming X — correct me." Silent assumptions are how every past loop on
   this project started.
1. **Scout inline** — read the code that's already there; half of Vikas's wish
   list partly exists (see the map below). Never rebuild what exists.
2. **Spawn workers** — one agent per independent slice, each with its own files
   and its own ports; give each the exact acceptance checks it must add.
3. **You verify, not the workers**: `npm run build` → `npm test` (1002/0 now) →
   `npm run qa` (494/494 + 8/8 + 4/4 now — counts only grow) → `npm run dist` →
   install `release\Cloud9-Setup-0.1.0.exe /S` → `npm run qa:app` (21/21 now).
4. **Extend the checks** — every new feature gets permanent checks in
   `scripts/qa.mjs` AND the installed-app walk `scripts/drive-app.mjs`, and you
   break one once to prove it can fail.
5. **Commit + push** with a plain-words message, append the ledger, publish an
   HTML report page for Vikas (inline `~/.claude/review-kit/feedback-layer.js`,
   mark sections `data-fb="…"`) ending with TEST IT steps.
6. **Move to the next feature without waiting** — Vikas asked for the whole
   queue; pause only on genuine product forks.

Traps already paid for — don't pay again:
- QA runs against the last `npm run build`, never your working tree.
- `qa:app` refuses a stale install on purpose (bundle byte-compare) — install
  the fresh Setup exe silently before walking.
- Capture exit codes explicitly and save full QA logs; a pipe once swallowed a
  failure and cost a day of guessing.
- Fake killed-write litter in tests only via `packages/engine/src/litter-for-tests.ts`.
- The app never holds an API key or GitHub token — it spawns the CLIs on this
  PC (`claude`, `codex`, `gh`). Keep it that way; it's the product's core promise.
- Everything on screen says WHEN it was checked; empty states say why; approval
  cards count facts from git/gh, never quote the agent.
- All UI lives in `apps/desktop/src/App.tsx`; hub `apps/relay`; engine
  `packages/engine`; frames `packages/shared`. His real data `%APPDATA%\cloud9`;
  repo-root db is dev-only.

## What already exists (so workers extend, not rebuild)

GitHub: Settings card (dated, signed in as vikas53953), repo picker with
click-connect, per-project local folder link, `!issue`/`!comment`/`!review`/`!code`
with counted approval cards, branch+PR always. Actions menu at the composer
(one table, drift-tested against `engine.ts`). Notifications with quiet hours.
Mentions, threads, reactions, unread, room chat search. `!bg` + `!schedule`.
Agent memory (`!remember`) + handoff (`!handoff`). Presence with reasons. Codex
un-removable switches render locked-ON (`effectiveAbilities()` in
`packages/engine/src/abilities.ts` — the one owner). Join-a-hub address book.
Skill library, marketplace, 13 discovered models.

## The queue (his order — one at a time, each fully proven before the next)

**1. Shared artifact workspace.** Attribution, immutable versions, links between
artifacts, permissions. Today agent files appear as chat cards
(`packages/engine/src/artifacts.ts`, hub file store) — the workspace screen,
version chain, and permissions are new. Design notes: versions are append-only
(a new version never edits an old row); every artifact names who made it and in
which turn; permissions default to room-visibility; links are typed references,
not markdown strings. Give it its own icon-rail screen.

**2. GitHub round 2.** After Vikas tests round 1, whatever he reports — likely
on-screen diff review for PRs and per-repo rooms. Don't start until his feedback
lands; skip ahead to 3 if none arrives.

**3. Search everywhere.** One search over chat, threads, artifacts (names +
contents + versions), with filters (room, agent, date, kind). The relay already
has FTS for messages — extend the same index rather than adding a second engine.

**4. Turn coordination.** When two agents could answer, exactly one does:
an owner per question, deduplicated replies, visible handoffs/dependencies
("waiting on @Architect"), and richer failure states (blocked/failed + the
error in plain words on the presence chip and the job record).

**5. Notifications round 2 + integrations + mobile groundwork.** Digest
options, per-room rules, webhooks in/out. The phone app is a scaffold that has
NEVER run — any mobile claim must start from that honest fact.

Open smaller items to weave in when nearby: skill-shelf ordering forgets the
hiring template after save (needs a field on `AgentDef`); Codex model list
lacks a provenance sentence (`packages/engine/src/harness.ts`); narrow window
widths are untested. Vikas's own step, whenever he chooses: the Tailscale
browser sign-in (`docs/plans/tailscale-steps.md`) that makes friends-over-
internet real.

## Cost caps (feature 1 consumed a whole weekly quota — 2026-08-03; these are law)

Feature 1's spend went to unbounded review loops, gold-plated test tooling and
oversized scope. The quality was real; the price was not necessary. Caps:

1. **Two review rounds per slice, hard cap.** Round 1 returns the complete
   findings list. Round 2 verifies fixes ONLY — anything NEW found in round 2
   is logged as a follow-up in the ledger, not fixed now, unless it is a
   genuine security or data-loss Critical. There is no round 3.
2. **One reviewer per slice, judging a scoped diff package** — never the repo.
3. **Test tooling gets one build + one RED/GREEN proof, then stops.** No
   security reviews of test scripts, no probe redesign loops. If harness code
   fights back twice, log it as follow-up and move on — the product's own
   suites are the safety net.
4. **Slice features to shippable-in-one-session value.** Feature 3 = "one
   search box that finds things across chat and files" FIRST; filters,
   ranking and polish are a later slice. When in doubt, ship the smaller
   visible thing and iterate.
5. **Cheap agents for mechanical work, one premium agent only where the
   design is genuinely hard.** Diagnosis pairs (two parallel diagnosers) are
   reserved for a bug that has already survived two fix attempts.
6. **Git state is global — workers never touch it.** Agents get their own
   FILES, but `git stash` / `checkout` / `reset` / `clean` affect the whole
   tree and will sweep up another live worker's uncommitted work (this
   happened 2026-08-03; nothing was lost only because the worker noticed).
   Put this in every worker prompt: *no git state commands; if you need a
   clean-tree comparison, ask the conductor.* The conductor owns git.
7. **Only the conductor runs build/dist/install while workers are live.**
   `qa:app` compares the current repo build against the packaged and installed
   app, so one worker running `npm run build` blocks the walk for everyone and
   looks exactly like a harness failure (2026-08-03). Workers may run targeted
   `npm test -w <pkg>`; the full chain belongs to the conductor, after workers
   have stopped.
8. **Budget check every ~10 agent runs**: if the feature has consumed what
   feels like a quarter of a weekly quota and is not near its evidence chain,
   STOP, park on the branch, write SOL-REPORT.md, and end the session small
   rather than big.

## Context economy (a Sol session already died of a full context window — 2026-08-02)

Your model holds less conversation than this plan assumes. Structure around it:

- **One session per feature.** When a feature is committed, pushed and reported,
  END the session; a fresh one starts the next feature from SOL-REPORT.md.
- **The conductor reads summaries, not files.** Never pull whole large files
  (App.tsx is ~9,000 lines) into your own context — send an agent to read and
  return only the relevant symbols/line numbers. Delegate reading the same way
  you delegate writing.
- **Write, don't remember.** Long outputs (logs, test results, plans) go to
  files under `docs/qa/` or the ledger, and you keep only the verdict line.
- **Resume-proof every hour of work**: push to `sol/<feature>` as you go, keep
  SOL-REPORT.md current, so a dead session costs minutes, not a feature. The
  first death lost nothing ONLY because the reviewing conductor parked the tree
  by hand — do not rely on that again.

## Where to commit, and the hand-back (so the reviewing session picks up cold)

- **Everything lands on `master` of `github.com/vikas53953/cloud9`, pushed to
  `origin` immediately.** One commit per completed feature (plus small fix
  commits as needed) — never one giant commit at the end, never work sitting
  unpushed on this machine. Worker agents never commit; only you do, after
  re-running the evidence yourself.
- If a feature is interrupted half-done, park it on a branch named
  `sol/<feature>` and push it — never leave loose uncommitted work, and say in
  the ledger that it is UNVERIFIED.
- **Append to `implementation-notes.md` in the same commit** as each feature:
  what was built, the exact counts you ran, and anything you found or deviated
  on. That file is how the next session knows what to believe.
- **Write `SOL-REPORT.md` at the repo root and keep it current** — one section
  per feature: status (DONE-PROVEN / UNVERIFIED / NOT STARTED), the commit
  hash, the evidence counts from YOUR runs, the report-page URL you gave Vikas,
  and open questions. This is the first file the reviewing Claude session reads.
- **Leave the machine consistent at every stop**: working tree clean, the
  installed app rebuilt and reinstalled to match your last commit
  (`npm run dist` then `release\Cloud9-Setup-0.1.0.exe /S`), and the walk
  (`npm run qa:app`) green against it. A commit whose evidence chain did not
  finish is marked UNVERIFIED in both the ledger and SOL-REPORT.md — never
  claimed as done.
- The previous conductor will review your work by re-running the whole evidence
  chain and reading SOL-REPORT.md + `git log 92af155..`. Write for that reader:
  plain words, real counts, no claims you didn't watch happen.
