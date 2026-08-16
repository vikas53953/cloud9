# Handoff — continuing PR #43 and the UX lanes (written 2026-08-14, ~00:15 IST)

**Audience:** the next agent (Cursor / Grok 4.6, or any platform), cold, with no
access to the prior session. Everything needed is here or in the linked repo
docs. Written by the Claude conductor session that ran 2026-08-12 → 08-14.

**Why this handoff exists:** the prior platform's scheduled self-wakeups did
NOT fire after quota resets (twice: overnight 08-12→13 and 11:22→13:40 on
08-13), stalling autonomous work for hours each time. Do not rely on in-session
timers on any platform; the owner (Vikas) drives sessions manually or via an
OS-level scheduler.

**The deadline is real: the product ships Friday 2026-08-14 (fallback Saturday
morning), Windows desktop only.** The delivery scope cut (owner-approved):
fold the UX lanes, land the palette overhaul, run the release chain, build the
installer, and give Vikas a visual HTML review page. Everything in §6 waits.

---

## 1. State of the repo (all verified at handoff time)

- Repo `vikas53953/cloud9`, owner's working copy `C:\Users\vikasmit\cloud9`.
- Feature branch **`codex/global-chat-shell`**, head **`dc049c5`**, pushed.
  PR #43 (into `master`) is the umbrella PR.
- **Merged into the feature branch, each after independent review + repair:**
  | Lane | PR | What it delivered |
  |---|---|---|
  | A | #45 | Visible blocked-agent chip in the room header; reach-gap info in RoomPanel "Who's here"; Focus-layout grid fix |
  | C | #44 | Real Windows test gate (quoted recursive globs), Node ≥22.12 pin + engine-strict, PR CI with per-suite timeouts |
  | B | #46 | Truthful engine refusals (unsure ≠ absent), the app now writes a log (`%APPDATA%\Cloud9\logs\cloud9-main.log`), strengthened walk checks 37/39/40 |
  | G | #47 | Chat+Files layout choice persists (click-away and Escape can no longer silently rewrite it; reload no longer wipes it) |
- Node 24.11.0 is the machine default and correct. `npm install` exits non-zero
  on engine warnings — normal; check node_modules exists.
- Local worktrees live under `.claude/worktrees/` (lane-e, lane-f, lane-d etc.)
  and `.worktrees/` is the owner's own — leave it alone.
- **NEVER use `git stash`** — shared across all worktrees; it already caused
  one cross-lane incident.

## 2. Open PRs — exact status, what each needs

> **UPDATE (final, ~01:45 IST):** a finishing wave completed after this
> document was first written. **PRs #48, #49, #50 and #51 are now all verified,
> reviewed and MERGED** — the table below is kept for the evidence trail, but
> none of these PRs needs work anymore. Eight lanes total are folded
> (A, B, C, D, E, F1, G, H). What actually remains: the §4 release chain
> (first job), f2/f3 (header dedup + the "V" control, briefs in the #51 row),
> Lane J (§3), the relay flake (§5 last bullet), and the §6 deferred list.
> New non-blocking tickets from the final reviews, added to §6: drag-and-drop
> guard tests assert the live region exists but not that it's fed; keyboard
> reorder under an active sidebar search announces moves among hidden rows;
> repeated boundary presses go silent (React state bail-out); DMs/More-tools
> clicks leave the previous rail item marked current; the two-row sidebar
> header is a deliberate visible change awaiting the owner's verdict
> (screenshots in docs/qa/lane-f1/).

| PR | Branch | Status | To finish |
|---|---|---|---|
| **#48** | codex/pr43-lane-d | **APPROVED conditionally** (reviewer ran 28 adversarial cases; 28/28 refused). Windows 8.3 short-path fix in the engine's security guard. | 3 conditions, all small, spelled out in the last conductor comment expectations + review: (1) remove the pre-existing NUL byte at `packages/engine/src/run.ts` offset ~7917 (cache-key separator) → printable separator, verify file greps as text; (2) restate the mask's safety comment in terms of the real invariant (≥1 name char immediately before the tilde — `safeArg` is called on fragments, so `^` anchors the fragment); (3) add 5 pin tests: `--flag=~1`, colon family (`:~1`, `a:b~1`, `C:~1`), space-anchored `a ~1`, a codex.ts fragment-composition case, `a\b~1` on POSIX. Then rebuild CLEAN (`rm -rf dist` first — stale-dist artifact bit the reviewer), engine suite, push, re-review, merge. |
| **#49** | codex/pr43-lane-h | Repair `f6b7076` pushed answering the full review; **re-review NOT done** (reviewer died). Drag-and-drop channel/section reordering. | Re-review the delta `702ce1c..f6b7076` against the checklist in the last conductor comment on the PR (keyboard activation gate, live-region announcements incl. double-announcement risk, unified `letGo` teardown removing the escapeStack entry on unmount, PR-body accuracy, boundary announcements). If clean → merge. |
| **#50** | codex/pr43-lane-e | **WIP — do not merge as-is.** Commit `f197265` fixes clicked sidebar items reading as disabled. | Finish per the PR body: AFTER measurement pass both directions (light-under-dark-OS keeps light on-inks; nord vs dracula keep distinct `--bg`; High Contrast Dark regains `--line:#FFF`), owner's scope extension (tabs/mode selector/Chat+Files controls, same class), build + desktop suite, review, merge. Evidence harness + logs in `.claude/worktrees/lane-e/`. |
| **#51** | codex/pr43-lane-f1 | **WIP — do not merge as-is.** Commit `74c1de1` fixes workspace-name truncation (Problem 1 of 3). | Verify at several widths/name lengths (driver `lanef-drive.mjs` + baseline screenshots in `.claude/worktrees/lane-f/`), build + suite, review, merge. Then do **f2** (header dedup — verify the Create action near the header genuinely duplicates the Channels-section one before removing; ONE obvious create path) and **f3** (the "V" control — TRACE its real function with file:line evidence first; keep function w/ tooltip if real, remove cleanly if decorative) as separate stacked PRs per the owner's one-PR-per-problem law. |
| **#43** | codex/global-chat-shell → master | Umbrella. | After all lanes fold: rewrite its body truthfully (current body is stale), run the §4 release chain, merge to master, build installer. |

## 3. The palette overhaul (Lane J) — the owner's top complaint

Two independent audits measured **260 failing color combinations (82 critical)**
across the 16 palettes; on the owner's dark-mode Windows every light palette
renders the primary button at ~1.1–1.4:1 (near-invisible). Full data:
`docs/qa/ux-walk-2026-08-12/` (contrast-data.json, colour-audit.html — a
writeable review page for Vikas, reproducible scripts).

- **Root cause (one sentence):** palette blocks are partial deltas over a
  light-only base and never declare the on-colors (`--on-ink`, `--on-pine`,
  `--on-gold`), so those leak from an OS media query at a different
  specificity.
- **J1 (groundwork, new files only — safe to start NOW):** complete brief at
  `docs/lanes/CURSOR-LANE-J1.md`. Builds `packages/shared/src/palettes.ts`
  (single source of truth, full 54-token contract per palette, derived
  on-colors/disabled-triple/line-strong/focus-ring), guard tests, and a CSS
  generator script.
- **J2 (wire-in, AFTER #50/#51/f2/f3 fold):** swap `styles.css` to the
  generated blocks, delete the `@media (prefers-color-scheme: dark)`
  custom-property block entirely (`applyTheme` already resolves appearance
  before first paint), replace the ~14 bare-opacity disabled rules with the
  disabled tokens, point `:focus-visible` at `--focus-ring`, kill the
  hardcoded fallbacks at styles.css ~L4050 and ~L4336-4337. The five guard
  assertions designed for `apps/desktop/electron/palette-contrast.test.cjs`
  are listed in the conductor transcript §palette audit; assertion 2 ("no
  OS-driven tokens") is the one that would have caught the d486b79 regression.

## 4. Release chain — serial, one at a time, after the folds

```powershell
npm run build      # exit 0
npm test           # real per-workspace counts; engine has known reds (see §5)
npm run qa         # browser QA; last known baseline 595/595 pre-lanes
npm run dist       # Windows installer
powershell -ExecutionPolicy Bypass -File scripts/install-cloud9.ps1
npm run qa:app     # installed walk — the real gate
```

Rules: only one build/package/install/walk at a time; a timeout or cascading
check is not green; a hidden DOM node is not evidence; never modify tests to
pass; no version bump (0.1.0); no committed binaries.

**What `qa:app` settles (installed blockers 3–4):** read
`%APPDATA%\Cloud9\logs\cloud9-main.log` (exists only after installing a build
with #46's fix). The one-line discriminator: `claude installed=… signedIn=…` —
`installed=false` while `claude --version` works in a terminal ⇒ PATH
resolution from the packaged Electron process (fix lands in command
resolution); `installed=true signedIn=false` ⇒ sign-in probe; both true ⇒
detection fine, look at `ClaudeCliProvider` construction next. Also watch when
`[engine-host] Claude connected` arrives relative to check 39 (late = startup
race). Machine fact: `claude auth status` answers logged-in in <1s here.

## 5. Known honest reds (do NOT silence; report them)

- `packages/engine` on GitHub Windows runners: 36 failures (8.3 short paths,
  `RUNNER~1`) — **fixed by PR #48 once its conditions land.**
- `packages/engine` on Linux CI: hard hang (leaked child processes;
  `killTree` group-kill is dead code on POSIX) — full ticket-quality diagnosis
  in §6 item 1. CI caps the step at 10m so other suites still report.
- Engine suite under heavy parallel local load: up to ~9-16 `gave up waiting`
  flakes in repowork/taskstuck/livesteps; all pass quiet or isolated.
- One relay Windows flake: `dist/runs.test.js` ~407 "bounded number of runs"
  `timeout waiting for frame` — a Codex lane was dispatched to fix it and
  produced nothing before dying; unassigned again.

## 6. Deferred past delivery (owner-approved cut) — ticket list

1. **Lane I — `killTree` never kills the tree on POSIX** (product bug: Stop
   leaves grandchildren running on Linux/macOS; also the cause of the Linux CI
   hang). Diagnosis, proven from code+logs: `run.ts:642-653` group-kill
   `process.kill(-pid)` targets a group that never exists because
   `run.ts:395-402` spawns with `detached:false`; ESRCH silently swallowed;
   only the immediate child dies; `sh -c` means the grandchild survives. Fix
   design (5 steps + test plan) is in the conductor transcript's hang-ticket;
   key: detached:true on POSIX spawns + escalating group kill + never signal
   `-pid` unless the child was actually made a group leader + t.after reaping
   belts + the two never-passing tree tests (`run.test.ts:85`,
   `notimers.test.ts:145`) must go green on BOTH platforms. Do it after #48
   lands (same file).
2. J2 if it misses Friday (J1 alone changes nothing user-visible).
3. `closeWorkspace()` lets a room-scoped refusal reset the GLOBAL layout pref
   (flagged in PR #47 body).
4. `plainlyRedact` fallback doesn't blank machine names (PR #46 final review).
5. `apps/relay` carries `--test-force-exit`, which may mask killTree-class
   leaks there — audit after Lane I.
6. Branch cleanup: 33 of 38 parked branches are fully merged or superseded and
   safe to delete (full table in the conductor transcript's triage report);
   `fix/chat-qa-trust-owner` is the ONE valuable unlanded branch (~1,130 lines
   of chat polish) — needs a careful rebase onto the folded head; two
   thread-width branches stay blocked on §7 question 1.
7. Global search: implement rooms/agents/activity search or keep the narrowed
   copy (owner never answered).
8. The engine load-flakiness class (`gave up waiting` under parallel load).

## 7. Open questions only Vikas can answer (asked before, never answered —
do not re-ask unless he raises them; recorded so they aren't lost)

1. Thread sizing 460/520 vs measured 388/300 (restored to 388/300 in d486b79;
   `docs/threads-like-slack.html` is the measured reference).
2. Priority after delivery: split the 1MB App.tsx, five-group IA, or mobile.

## 8. Operating rules for any continuing agent (owner's laws + AGENTS.md)

- One problem = one branch = one agent = one PR into `codex/global-chat-shell`;
  independent review by a non-author before merge; conductor folds.
- Truthful and fail closed; never let the UI claim what the system didn't do.
- Fix the class, not the case. Evidence before "done" — real command output,
  honest reds. Vikas confirms; he never discovers.
- Anything Vikas must review: a visual HTML page with the feedback layer
  (see `docs/qa/ux-walk-2026-08-12/colour-audit.html` for a working example —
  every reviewable block has data-fb, thumbs, notes, one Copy-my-feedback
  button).
- Surgical edits in `App.tsx` (~1MB, all lanes collide there); no reformats.
- Never `git stash`. Leave `.worktrees/` alone. No version bumps, no binaries.
