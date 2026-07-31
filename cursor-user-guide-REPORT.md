# Cursor Lane U — user-guide REPORT

**Branch:** `cursor/user-guide`
**Worktree:** `C:\Users\vikasmit\cloud9-cursor-lane-U`
**Base:** `origin/master` (HEAD `9375abb` — "Loop ledger: join-a-friend on
screen (16/16); notifications wiring started")
**Mode:** AUTO-RUN / YOLO. New files only. No touch of `master` or any PR.

## What this lane did

Wrote a plain-words user guide for Vikas (a network engineer, not a developer)
that describes **everything Cloud9 does today**, honestly — including what is
built underneath but not yet on screen. No feature was invented; every claim
was read from the code or from `HANDOFF.md` / `RESUME.md`.

## Files (new only)

| File | Purpose |
|---|---|
| `docs/USER-GUIDE.md` | The guide itself — 19 short sections, plain words, no jargon. |
| `cursor-user-guide-REPORT.md` | This report. |

Nothing else was touched. `git status --short` in the worktree shows exactly
those two untracked files and nothing modified.

## How the guide was written

1. Read `HANDOFF.md` and `RESUME.md` end to end — these are the source of truth
   for what is on screen (verified 16/16 on the installed app) and what is not.
2. Read the code for the features the brief named specifically:
   - `packages/engine/src/engine.ts` — the typed room commands `!bg`/`!task`,
     `!code`, `!publish`, `!schedule`, and the GitHub write commands
     `!issue` / `!comment` / `!review` (`parseGitHubWriteCommand`,
     `workGitHubWriteInRoom`, `workInRepository`).
   - `packages/engine/src/githubwrite.ts` and `docs/plans/github-ops-handoff.md`
     — the approval-gated GitHub writes, counted facts, stdin-only prose.
   - `packages/engine/src/abilities.ts` via `docs/plans/capability-handoff.md`
     — the four-rung reach ladder and the eight switches.
   - `docs/plans/artifact-store-handoff.md` — artifact cards (done underneath,
     NOT on screen).
   - `docs/plans/let-a-friend-connect.md` and `docs/plans/join-hub-handoff.md`
     — connect-to-a-friend (plumbing exists, NOT on screen).
   - `docs/plans/notify-handoff.md` — notifications (rules done, not wired to
     screen).
   - `apps/desktop/src/App.tsx` — confirmed the icon rail is
     Chat / Crew / Tasks / Projects / Log, the casting-room name, and the
     skill library wiring.
3. Wrote each section in plain words, kept it short, and said "NOT on screen
   yet" wherever the HANDOFF's verified-on-screen list did not include it.

## Honesty calls worth flagging

- **`!issue` / `!comment` / `!review`** are wired in the engine and reachable
  by typing, behind the same approval card as a push. They were **not** in the
  16/16 installed-app verification walk, so the guide calls them "built, not
  yet proven on the double-clicked app" rather than "done".
- **Artifact cards** are plumbing only — nobody has seen one. The guide says so
  in §15 and again in the §17 honest list.
- **Connect to a friend** has no on-screen mode; the packaged app always starts
  its own hub. The guide says so plainly in §16.
- The guide does **not** repeat the false "23 Scouts" claim from an earlier
  session; it points only at the real database at `%APPDATA%\cloud9`.

## Verification

- `git status --short` → only the two new files, nothing modified, nothing
  staged from elsewhere.
- The worktree was created with `git worktree add -B cursor/user-guide …
  origin/master`, so `master` is untouched and the branch tracks `origin/master`
  for the push.

## Return values

- **Branch:** `cursor/user-guide`
- **Base SHA:** `9375abbb651d6c6bbb61d02601f9566e0186d455`
- **Files:**
  - `docs/USER-GUIDE.md` (new)
  - `cursor-user-guide-REPORT.md` (new)

The commit SHA and push result will be filled in by the steps that follow this
report (commit, then `git push -u origin cursor/user-guide`).
