# Cloud9 — handoff to Sol (GPT-5.6, running inside Claude Code)

Written 2026-08-02 by the outgoing Fable 5 session, at Vikas's word, because his
Claude weekly quota is nearly spent. You are picking up mid-project. Read this,
then `HANDOFF.md`, then `RESUME.md`. `implementation-notes.md` is the bug/feedback
ledger — every problem Vikas reports goes there with a status, immediately.

Repo: `github.com/vikas53953/cloud9`, branch `master`, last commit `354ef6c`.
Everything below it is verified; trust nothing you haven't re-run.

---

## 1. Who you work for, and the laws (non-negotiable — they have all burned us)

Vikas: network engineer, visual thinker, NOT a developer. He confirms results;
he never discovers problems. Plain words everywhere — UI copy, replies, commit
messages. No dev/ML jargon.

1. **A feature is DONE when he can SEE it and USE it on the installed app.**
   Tests passing is not done. Invisible = absent.
2. **Never claim done without evidence you ran THIS session.** Paste real counts.
3. **Brief before code.** Before building, send him: BROKEN/CAUSE/CHANGE/
   NEIGHBORS/BLINDSPOTS (or for a feature: what/where/neighbors/assumptions),
   then WAIT for his "go".
4. **Fix the class, not the case.** One owner per rule, in one file.
5. **Anything he reviews = a visual HTML page** with the feedback layer inlined
   (`~/.claude/review-kit/feedback-layer.js`, mark blocks `data-fb="label"`).
   Never a wall of text.
6. **One question at a time, always with a recommendation.**
7. **Absent means absent.** Never render a tick/zero/estimate nobody checked.
   Every "signed in / connected / synced" statement carries WHEN it was checked.
8. **A check that cannot fail is not a check.** Break it once, watch it fail,
   restore, say so.
9. **Two failed attempts on one bug → STOP and root-cause at architecture level.**
10. **Workers never commit; the conductor commits after re-running the evidence.**
    You are the conductor now.
11. **Logs before guesses.** Read the app's own logs/QA output before theorizing.

## 2. What Cloud9 is

A Windows desktop chat app where Vikas creates AI agents that work like hired
colleagues. Agents run on the Claude Code and Codex CLIs already installed on
his PC, on his subscriptions. Cloud9 spawns those programs; it NEVER holds an
API key or calls a model API itself. That is the product's reason to exist.

| Part | Plain words | Where |
|---|---|---|
| Hub | Post office: messages, agents, jobs, projects | `apps/relay` (WebSocket+SQLite, loopback) |
| Engine | Runs an agent's turn by spawning claude/codex/gh | `packages/engine` |
| Screen | React+Vite in Electron — ALL UI is `apps/desktop/src/App.tsx` | `apps/desktop` |
| Shared | Types + frames both sides speak | `packages/shared` |

The **installed app is the product**: `npm run dist` builds the installer,
`release\Cloud9-Setup-0.1.0.exe /S` installs it silently. His real data:
`%APPDATA%\cloud9`. The repo-root `cloud9-relay.db` is a DEV database — never
draw conclusions about "his" data from it.

## 3. Evidence commands (run all before AND after your work)

```
npm run build      # clean tsc+vite
npm test           # 1002 pass, 0 fail right now (71+583+333+15; 3 relay skipped by design)
npm run qa         # browser QA vs vite preview: 494/494 + 8/8 + 4/4 — counts may only GROW
npm run dist       # build installer — then INSTALL IT: release\Cloud9-Setup-0.1.0.exe /S
npm run qa:app     # walks the INSTALLED app: 21/21 — REFUSES a stale install by design
```

Traps you must know:
- **QA tests the last `npm run build`, never your working tree.** Rebuild before
  judging a deliberate break.
- **qa:app refuses to walk yesterday's install** (bundle byte-compare). That
  guard caught a real false-verification — do not weaken it.
- A pipe swallows exit codes in shells — capture `$?` explicitly, save full logs.
- The engine test suite had 3 tests that passed **by luck of PID assignment**;
  fixed via `packages/engine/src/litter-for-tests.ts`. Plant fake killed-write
  litter ONLY through that helper.
- One qa.mjs check flaked 3 times before being root-caused (it sampled the
  screen one frame before it settled; now it waits bounded). If qa flakes,
  it is a NEW problem — save the full log first.

## 4. What already EXISTS (do not rebuild — Vikas's next-features list overlaps it)

- **GitHub**: Settings card (signed in as vikas53953, dated, sign-in button);
  Projects screen; connect panel LISTS his repositories (click-connect, typed
  fallback); per-project "where the code lives" folder link (native dialog,
  owner-only); `!issue`/`!comment`/`!review`/`!code` with approval cards whose
  facts are counted by git/gh, never quoted from the agent; branch+PR always,
  nothing lands on a default branch without him.
- **Actions menu** (＋ beside the message box): every typed command, one table in
  App.tsx cross-checked against `engine.ts` by test (`roomcommands.test.cjs`).
- **Notifications**: toasts for job-done / approval / mention / file, quiet hours.
- **Mentions, threads, reactions, edit/delete, unread counts, chat search** (rooms).
- **Scheduled/background jobs**: `!bg`, `!schedule daily HH:MM | every Nm`.
- **Agent memory + handoff**: `!remember`, `!handoff @Other`; memory panel in editor.
- **Live agent presence**: ready/working/paused/offline with reason.
- **Codex honesty**: 4 un-removable switches render locked-ON with the reason
  (one owner: `effectiveAbilities()` in `packages/engine/src/abilities.ts`).
- **Join-a-friend's-hub** (address book; internet part waits on his Tailscale
  sign-in — his step, `docs/plans/tailscale-steps.md`).
- **Skill library**, marketplace of 8 roles, 13 Claude models discovered from the CLI.

So from his list: "GitHub integration" is ~done (gaps: per-repo channels, richer
diff review UI). "Searchable chat" exists for rooms (artifacts: no). "Live agent
states" exist (blocked/failed detail: partial). "Notifications/mentions/scheduled
jobs" exist. The genuinely NEW items are **shared artifact workspace**, artifact
search/history, turn coordination, mobile, onboarding/exports/audit/cost.

## 5. His build order (one at a time, each with its own brief → "go" → build → prove)

1. **Shared artifact workspace** — attribution (who made it), immutable versions,
   links between artifacts, permissions. Files agents produce already appear as
   cards in chat (`artifacts.ts`, `artifactref`); the workspace view, versioning
   and permissions are NEW. Start by reading `packages/engine/src/artifacts.ts`
   and how the hub stores files. Brief him before building.
2. **GitHub round 2** — whatever his brief says is missing after he tests what
   exists (likely: diff review on screen, per-repo rooms).
3. **Search** — artifact + cross-room history with threads.
4. **Turn coordination** — deduplicate replies when two agents would answer,
   owners, dependencies. `docs/plans/` may have notes; check before designing.
5. **Notifications round 2 / integrations / mobile** — the phone app is a
   scaffold that has NEVER run; say so honestly in any plan.

Rule: ONE feature per round. Brief → his "go" → build → full evidence chain
(§3) → extend `scripts/qa.mjs` AND `scripts/drive-app.mjs` with permanent checks
for the new feature → install → walk → commit (message in plain words, what and
why) → push → ledger → HTML done-report page with TEST IT steps.

## 6. Decisions already made — do NOT ask him again

Design = Studio (`docs/mocks/p3-studio.html`). Branch+PR always. Git worktrees
per agent. Marketplace built-in. Tailscale first, hosted later. His PC runs the
agents. Full capability ceiling with isolation from HIS config. See HANDOFF.md
§10 for the full table.

## 7. Current open items besides the feature list

- His Tailscale browser sign-in (only he can; steps written).
- Narrow window widths: still honestly untested.
- Skill-shelf ordering forgets the hiring template after save (`AgentDef` field).
- Codex model list has no provenance sentence (`packages/engine/src/harness.ts`).
- Optional: auto-detected handoffs, auto-remember, memory seeding (his call #3).

Good luck. Re-run the evidence before believing this document.
