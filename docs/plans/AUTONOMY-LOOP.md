# AUTONOMY LOOP — keep both engines running until Cloud9 is DONE

Written 2026-07-31 while Vikas sleeps. He asked: keep feeding Cursor work in a
loop, and keep building, UNTIL THE GOAL IS MET. This file is the standing
instruction to whichever conductor session is alive — follow it until the
Definition of Done below is fully checked, then stop and hand Vikas a review page.

## The loop (run every time you wake — from a watcher, an agent report, or a heartbeat)

1. **Re-arm the branch watcher immediately** (it gets killed often):
   poll `git ls-remote origin 'refs/heads/cursor/*'`; wake when the set changes.
2. **A Cursor lane pushed?** Review it: forbidden-file check → clean-tree build +
   its tests (in `~/cloud9-cursor`, wiping dist to avoid stale-count artifacts) →
   if green, merge to `master`, delete the remote lane branch. If a lane found a
   real defect, open a follow-up (conductor fixes existing files, not Cursor).
3. **All current Cursor lanes merged?** Bump `CURSOR-BRIEF.md` ROUND number in
   `~/cloud9-cursor` and rewrite `CURSOR-BACKLOG.md` with the NEXT set of
   new-file lanes (draw from "Remaining Cursor work" below), push `cursor/auto`.
   Cursor's own loop picks it up; if not, Vikas re-kicks in the morning.
4. **An in-house wiring agent reported?** Verify (build + test + qa), commit,
   and when a screen feature lands, rebuild the installer (`npm run dist`),
   install, `npm run qa:app`, and update the review page. Then start the next
   wiring feature.
5. **Never** push/merge master with a dirty tree, never claim done without a
   fresh run, never let Cursor edit files an in-house agent holds.
6. Watch usage: pause self-initiated NEW work near 80% and keep only the
   review/merge/loop duties alive.

## Definition of DONE (the goal — stop the loop when ALL are true, proved by `qa:app`)

- [ ] **GitHub on screen** — an agent performs a GitHub write; the approval card
      shows it in plain words; reads have on-screen views. (Wiring in flight.)
- [ ] **Join a friend's Cloud9 on screen** — paste/scan a join link, see the hub,
      switch to it, fall back to self when it's down. (Modules merged: hubaddress,
      hubbook, hubconnection, joinhub — wiring + screen remain.)
- [ ] **Notifications visible** — toasts for job-done/approval/mention/publish,
      honoring quiet hours. (notify.ts merged — wiring + screen remain.)
- [ ] **Agent memory + handoff on screen** — an agent recalls across chats and can
      hand work to another, visibly. (Modules merged — wiring + screen remain.)
- [ ] **Codex isolation fixed** — a Codex agent inherits nothing it shouldn't
      (audit lane produces the spec; conductor implements).
- [ ] Every item re-proved on the INSTALLED app (`npm run qa:app`), installer
      rebuilt, and a review page handed to Vikas with TEST IT steps.

## In-house wiring queue (conductor's own Opus agents — they touch screen/engine/hub)
Order: **GitHub (now) → Join-a-friend → Notifications → Memory/handoff → Codex fix.**
One at a time (they share screen files), each: worker builds per its handoff doc →
conductor verifies + commits + rebuilds installer + walks it.

## Remaining Cursor work to draw future rounds from (NEW-FILE-friendly)
Cursor gets work that does NOT touch whatever the in-house agent holds this round.
- More adversarial/property tests for each newly-merged/wired module.
- Coverage for relay store, engine modules, desktop pure helpers (new test files).
- Audits: Codex isolation (round 3), a11y pass, performance budget, error-legibility
  sweep — each an audit DOC, read-only.
- Docs: user guide, architecture overview, Tailscale steps, a "what each screen
  does" reference.
- When a wiring feature lands and its files free up, Cursor may add the browser
  QA and edge tests for it (new test files) the round after.

## Progress ledger (append; newest last)
- 2026-07-31 ~01:xx — 4 Cursor lanes (notify/github/memory/joinhub) + 3 conductor
  hub modules merged; 784 tests clean. GitHub-to-screen wiring started (Opus).
  Cursor round 3 (7 new-file lanes) pushed to cursor/auto with autonomy note.
- 2026-07-31 ~03:00 — GitHub WRITES ON SCREEN, verified + installed + walked 16/16
  (798 tests, 448 browser). !issue/!comment/!review → approval card. Read-result
  UI deferred (types in). Next in-house feature STARTED: join-a-friend on screen.
- 2026-07-31 ~04:05 — JOIN-A-FRIEND ON SCREEN, verified + installed + walked 16/16
  (803 tests, 456 browser, real two-hub local proof). Tailscale (real internet)
  deferred to Vikas's sign-in, said on screen. Build hiccup: a leftover Cloud9.exe
  locked release/win-unpacked (EBUSY) — killed procs, cleaned dir, rebuilt clean.
  Next in-house feature STARTED: notifications on screen.
