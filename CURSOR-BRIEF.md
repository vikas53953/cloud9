# CURSOR BRIEF          ROUND: 2 (DONE, under review)          branch: cursor/auto

>>> GO WIDE NOW: Round 2 is pushed and the conductor is reviewing it.
>>> Vikas wants MAXIMUM parallel building. Open **CURSOR-BACKLOG.md** and
>>> spawn ONE agent per LANE (G, J, M, N) — each on its OWN branch, each on a
>>> DIFFERENT model if you can (GPT-5, Sonnet, Kimi K2, Grok 4.5). LANE G
>>> (GitHub) is the top priority — Vikas named it. The rules in CURSOR-BACKLOG.md
>>> govern those lanes. This file's older per-round tasks are superseded by the
>>> backlog while Vikas is away.

READ THIS WHOLE FILE FIRST. This is a STANDING brief — the same file is
reused every round. The `ROUND:` number above tells you which task set is
live. When it changes, a new task set is waiting for you (see THE LOOP).

If anything is genuinely ambiguous: write the question in CURSOR-REPORT.md and
move on. NEVER guess, never widen scope.

## The project (30 seconds)

Cloud9 — a Windows desktop chat app (Electron + React; Node hub with SQLite;
a TypeScript engine that spawns the Claude/Codex CLIs). Owner is Vikas, a
network engineer, NOT a developer. Layout:
- `apps/relay`   — the hub: WebSocket server + SQLite.
- `apps/desktop` — the screen. FORBIDDEN to you.
- `packages/engine` — spawns the AI CLIs.
- `packages/shared` — types/validation both sides import.
- `scripts/` — build + QA harnesses.

## GROUND RULES (override anything else you decide)

1. Work ONLY in this folder (`C:\Users\vikasmit\cloud9-cursor`). Never open the
   main checkout at `C:\Users\vikasmit\cloud9` — other AI agents are in it.
2. This folder stays on branch **`cursor/auto`**. Commit only here. Push only
   this branch: `git push origin cursor/auto`. NEVER touch `master`, never open
   a pull request. A Claude conductor reviews and merges your branch.
3. FORBIDDEN FILES (editing them gets your work dropped in a conflict):
   - `apps/desktop/**` (all of it)
   - `scripts/qa.mjs`
   - `apps/relay/src/server.ts`  — you may READ it, never edit it
   - `packages/shared/src/index.ts`  — read-only (import from it, don't edit)
   - `packages/engine/src/**` EXCEPT `*.test.ts` files (those you may add/edit)
   Allowed to edit: `apps/relay/src/store.ts`, any `*.test.ts`, new files under
   `docs/qa/` and `docs/plans/`, and `scripts/*` except `qa.mjs`.
   If a task needs a forbidden file: STOP that task, write why in the report.
4. Never claim without running. Paste real numbers in CURSOR-REPORT.md.
5. Fix the class, not the case: one rule = one owner in one file.
6. Prove every new test can fail: break the thing once, watch it fail, restore,
   record the pair in the report.
7. First: `npm install` (fresh worktree). Gate to finish: `npm run build` clean
   AND `npm test` green. Do NOT run `npm run qa` or `npm run qa:app`.
8. Small commits, one concern each, plain-English messages.

## THE LOOP — how to keep picking up new work automatically

After you finish the current ROUND and push, DO NOT stop. Enter this loop:

```
while true:
  git fetch origin cursor/auto
  git reset --hard origin/cursor/auto      # safe: you already pushed your work
  read CURSOR-BRIEF.md
  if ROUND number is HIGHER than the one you just finished:
     do that new task set, write CURSOR-REPORT.md, commit, push cursor/auto
  else:
     wait ~5 minutes, then loop again
```

The conductor bumps the ROUND number and rewrites THE TASKS below each time he
merges your previous round. So: finish, push, then keep fetching — a new task
set arrives in this same file with a higher ROUND number, and you pick it up
with no message from anyone. (If your Cursor mode cannot loop on its own, the
owner will paste "read CURSOR-BRIEF.md and go" each round — same result.)

Always overwrite CURSOR-REPORT.md fresh each round (git history keeps the old
ones). Start it with `REPORT FOR ROUND: N` so the conductor knows which set it
covers.

## THE TASKS  (for ROUND 2)

Context: on 2026-07-29 a private room was widened by a plain member, and the
relay test suite missed it because **every admin frame in the suite was sent by
the owner**. Law since: *test what an insider can do, not only an outsider.*
Nobody has swept the rest of the hub with that lens. That is this round.

### Task 1 — The insider sweep (the big one)
Create `apps/relay/src/insider.test.ts` (split into more files if large).
Read `server.ts` (reading is allowed) and list every client→hub frame that
mutates state or reads something access-controlled. For each, add tests where
the sender is (a) a plain member of the room, not owner/admin; (b) a hub member
who is NOT in that room; (c) where relevant, an agent's owner vs a stranger to
that agent. Assert the hub refuses or correctly scopes every case the frame's
purpose does not require. Cover at least: channel admin (rename, topic,
archive, roles, add/remove members), editing/deleting SOMEONE ELSE'S message,
reactions in rooms you're not in, reading scrollback/search/unread across room
boundaries, attachment tickets for other rooms' files, artifact frames
(`artifacts`/`artifact`/`artifactTicket`) across boundaries, run records
(`runDetail`) of agents you don't own, approval frames sent by a non-approver,
project frames, skill frames.
For every refusal you assert, also assert the sentence has no `Error:` prefix
and no file path (the `refusal.ts` law).
If you find a REAL hole: do NOT fix `server.ts` (forbidden). Write it in
`docs/qa/insider-audit.md` under FINDINGS — exact frame, sender, what leaked —
and leave the test `.todo`/skipped with the reason. A found hole is a SUCCESS.

### Task 2 — Name and filename torture tests
New `apps/relay/src/naming-torture.test.ts`, importing `validateName` and
`isSafeFileName` from `@cloud9/shared` (import only). Cases, each asserting the
decision AND that any refusal is plain words: zero-width chars
(U+200B/200C/200D, U+FEFF); bidi overrides (U+202A–202E, U+2066–2069);
confusables (Cyrillic а vs Latin a — two look-alike names must either collide
as duplicates or both be refused; assert what the code does, write which);
NFC vs NFD of one accented name (must be the same name); emoji-only names;
1-char and max-length boundaries; names that are only spaces/dots; Windows
device names (CON, PRN, AUX, NUL, COM1, LPT1) as filenames; trailing dots and
spaces in filenames; a 300-char filename. Note surprising-but-harmless
behaviour; propose (in words, no code) a fix for anything genuinely wrong.

### Task 3 — Reproduce the phase-5 majors as tests
Read `docs/qa/phase5-negative.md` (7 Majors). For each: if reproducible at the
hub level, write a test; if the fix lives in `apps/relay/src/store.ts`, fix it
there with the test; if it needs `server.ts` or a desktop file, leave the test
skipped with a one-line reason and record it. If it is purely screen behaviour,
list it as "screen-side, not mine". Number findings 5-M1…5-M7 to match.

### Task 4 — The keep-awake helper
Create `scripts/keep-awake.ps1`: a PowerShell script that stops Windows sleeping
while it runs (SetThreadExecutionState via Add-Type, ES_CONTINUOUS |
ES_SYSTEM_REQUIRED — display may sleep, system must not), prints one plain
sentence when engaged, restores normal behaviour on Ctrl+C/exit (finally block),
and refuses with a plain sentence if Add-Type fails. Plus `docs/plans/keep-awake.md`
in words a non-developer can follow. No test framework — run it ~10s yourself,
`powercfg /requests` while running (paste output showing the SYSTEM request),
stop it, `powercfg /requests` again showing it cleared. Paste both.

## WHEN DONE THIS ROUND
Build + test summaries into CURSOR-REPORT.md; per task DONE/STOPPED with
evidence; files touched; break-proof pairs. Commit, push `cursor/auto`, then
enter THE LOOP above and wait for ROUND 3.
