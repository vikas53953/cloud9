# CURSOR BRIEF — Cloud9 quality + content round     2026-07-30, ~22:40

READ THIS WHOLE FILE BEFORE TOUCHING ANY CODE. Do the tasks in order.
If anything is genuinely ambiguous, write your question into CURSOR-REPORT.md
and move to the next task — NEVER guess, never widen scope.

## What this project is (30 seconds)

Cloud9 is a Windows desktop chat app (Electron + React; Node hub with SQLite;
a TypeScript engine that spawns the Claude/Codex CLIs). The owner is Vikas —
a network engineer, NOT a developer. Monorepo layout:

- `apps/relay`   — "the hub": WebSocket server + SQLite. Holds messages/agents/jobs.
- `apps/desktop` — the Electron/React screen. **FORBIDDEN to you today.**
- `packages/engine` — spawns the AI CLIs for agent turns.
- `packages/shared` — types/validation both sides import.
- `scripts/`     — build and QA harnesses.

## Ground rules — these override anything else you decide

1. Work ONLY in this folder (`C:\Users\vikasmit\cloud9-cursor`). It is a git
   worktree on branch `cursor/quality-round`. The main checkout at
   `C:\Users\vikasmit\cloud9` has other AI agents in it — never open it.
2. Commit ONLY to branch `cursor/quality-round`. Push ONLY that branch:
   `git push -u origin cursor/quality-round`
   NEVER push, merge, or rebase `master`. NEVER open a pull request.
   A Claude conductor session verifies and merges your branch afterwards.
3. FORBIDDEN FILES (other agents own them today; editing them guarantees a
   merge conflict and your work gets dropped):
   - `apps/desktop/**`  (everything under it)
   - `scripts/qa.mjs`
   - `apps/relay/src/server.ts`
   - `packages/shared/src/index.ts`
   - `packages/engine/src/provider.ts`, `abilities.ts`, `claude-cli.ts`,
     `codex.ts`, `engine.ts`, `host.ts`, `context.ts`
   If a task seems to need one of these, STOP that task and write why in
   CURSOR-REPORT.md.
4. Never claim something works without running it in this folder. Paste real
   numbers in CURSOR-REPORT.md.
5. Fix the class, not the case: one rule = one owner in one file.
6. Every new test must be proven able to fail: break the fix once, watch the
   test fail, restore it, say so in the report.
7. First command: `npm install` (this worktree has no node_modules yet).
   Gate for finishing: `npm run build` clean AND `npm test` all green.
   Do NOT run `npm run qa` or `npm run qa:app` — they fight the other agents'
   test stacks and the installed app. Unit tests only in this folder.
8. Commit style: small commits, one concern each, message = one plain-English
   sentence about the value (look at `git log --oneline -20` and copy the tone).

## THE TASKS

### Task 1 — Make run-record writes atomic
- File: `apps/relay/src/runstore.ts`.
- Problem: run records are written with a direct whole-file write; a process
  kill mid-write corrupts the record permanently.
- Required fix: route every write in that file through the repo's one safe
  writer, `writeWholeFile` from `packages/engine/src/wholefile.ts` (see
  `apps/relay/src/store.ts` for how the relay already imports and uses it —
  copy that pattern exactly). Every write's RESULT must be used or the failure
  surfaced — see `apps/desktop/writeoutcome.test.ts` for the law's test style
  (read it; do not edit it).
- Acceptance: a new `apps/relay/src/runstore.test.ts` (node:test style, copy
  an existing relay test's harness) proving (a) a record survives a simulated
  torn write — temp file litter present, real file intact; (b) a failed write
  is reported, not swallowed.

### Task 2 — The search fallback must not match JSON plumbing
- File: `apps/relay/src/store.ts` (allowed — only `server.ts` is forbidden).
- Problem: when SQLite lacks FTS5, search falls back to a LIKE over the raw
  stored JSON, so searching `text` or `attachment` matches every message.
- Required fix: the fallback must search only the same human-written text the
  FTS5 index holds (find where the FTS5 index extracts text; extract the same
  way in the fallback).
- Acceptance: one test file with BOTH paths exercised (FTS5 present and the
  fallback forced): the word `text` (a JSON field name) matches only messages
  that truly contain the word "text"; a normal word matches the same set of
  messages under both engines.

### Task 3 — Link the retention constants
- Search: `grep -rn -iE "retention|prune|keepDays|daysToKeep" apps/relay/src packages`
- Problem: two constants both mean "how long we keep things" and nothing ties
  them together, so someone edits one and the other silently disagrees.
- Required fix: one named constant is the truth; the other is derived from it
  (or both become two named faces of one exported object), with a comment
  saying which is the owner.
- Acceptance: a test that imports both and asserts the relationship, plus a
  read-your-own-source test (style: `writeoutcome.test.ts`) that fails if a
  new literal with that meaning appears in those files.

### Task 4 — Parallel QA runs must not delete each other
- File: `scripts/qa-stack.mjs` (allowed; `qa.mjs` is not).
- Problem: at startup it deletes EVERY `cloud9-qa-*` temp workspace, so two QA
  runs at once destroy each other's databases mid-run.
- Required fix: it may delete (a) its own workspace and (b) workspaces whose
  directory mtime is older than 3 hours (abandoned). It must never delete a
  younger sibling. Keep the cleanup purpose — litter must still go.
- Acceptance: a unit test (new file `scripts/qa-stack.test.mjs`, node:test,
  runnable by `node --test scripts/qa-stack.test.mjs`) with the deletion rule
  extracted into an exported function: given fake ages, asserts keep/delete
  decisions. Wire that exported function into the script.
  Note: `npm test` may not pick up this file — run it directly and paste the
  output; say so in the report.

### Task 5 — The unread count must not lie ("999")
- Problem: account-level unread is capped at 1000 and shown as "999".
- Find where unread is COUNTED (hub side; grep `unread` in `apps/relay/src`
  and `packages/shared/src` — remember `packages/shared/src/index.ts` is
  READ-ONLY for you).
- Required fix, hub side only: report the true count, or an honest
  `{count, capped: true}` shape — whichever the existing frame shape allows
  WITHOUT editing `packages/shared/src/index.ts` or any `apps/desktop` file.
- If honesty is impossible without those files: implement nothing, write
  exactly what change is needed in which forbidden file in CURSOR-REPORT.md,
  and move on. That written note is a valid completion of this task.

### Task 6 — Fact-check two market claims (research only, no code)
- Create `docs/plans/market-facts.md`.
- Verify from live public sources, quoting exactly, with URL and today's date:
  (a) Slack Pro and Business+ per-user prices, annual billing, USD and INR;
  (b) what Buzz — Block Inc.'s open-source agent chat app — publicly promises
  in its README today (find the real repository; do not guess its contents).
- These numbers appear in an internal comparison the owner may publish;
  they were flagged as unverified. If you cannot browse the web, say so in the
  report and skip — do NOT write numbers from memory.

### Task 7 — Grow the skill library (content feature, exact contract)
- File: `packages/shared/src/skill-library.ts` (allowed — it is not index.ts).
- Today it holds 15 ready-made software-engineering skills shown in the app's
  Skill Library screen. Open the file and match its exact shape: every entry
  has id, name, one-line description, category/shelf, the skill body, and a
  SOURCE (where the practice comes from — a real, checkable origin).
- Add 10 more skills, same shape, categories chosen from the shelves already
  in the file (extend a shelf only if 3+ new skills need it). Real,
  practitioner-grade content only — e.g. code review checklists, incident
  writeups, release checklists, API design review, accessibility audit,
  performance budgets, test triage, database migration safety, security
  review basics, technical writing. Every skill MUST name a real source; no
  invented citations. Plain English, no jargon in names/descriptions (the
  owner is not a developer).
- Acceptance: `npm run build` still clean; if a test asserts the library's
  count or shape, update it honestly and say so. Do not renumber or edit the
  existing 15.

## When you are done

1. `npm run build` — must be clean. `npm test` — must be all green. Paste both
   summaries into the report.
2. Write `CURSOR-REPORT.md` in this folder: per task — DONE (with evidence) /
   STOPPED (with the exact reason and the question to ask) — plus every file
   you touched, and every test you proved able to fail.
3. Commit everything to `cursor/quality-round`, push that branch to origin.
4. Tell the owner you are finished; he hands your report back to the Claude
   conductor, who verifies on a clean machine state and merges.
