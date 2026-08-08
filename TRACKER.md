# LIVE TRACKER — Cloud9

## Current Hooks editor snapshot (2026-08-08)

Hooks editor is BUILDING on `feature/hooks-rules-editor` from `origin/master`
`f555ed1`. PR #27 is OPEN and pending independent review; owner-only CRUD,
existing event/action validation, durable SQLite/audit state, live engine sync,
request correlation, accessible loading/error/test-result UI, and no
shell/webhook credential fields are implemented. Stable source/test commit is
`6e27436`. Evidence: shared, engine, and relay builds pass; engine host 18/18
and hooks 26/26; relay Hooks CRUD/action replacement/test replay/ledger retention 5/5; desktop typecheck and
Hooks source 3/3; combined focused engine/relay coverage 48/48; diff-check clean. Hook firing reports now carry a receipt id,
are event-bound and deduplicated, successful actions audit as `dispatched`
with `ok=false` because no relay acknowledgement protocol exists, note-save failures are refused, hook
jobs carry recursion provenance, relay caps an owner at 50 hooks while
preserving accepted create receipts on replay; CRUD responses mirror to every
owner desktop window with correlation only on the origin. No
package/install/QA/app walk or performance comparison.

**This file is the single source of truth. If it disagrees with a chat message,
a commit, or an agent's report, THIS FILE WINS.**

Anyone arriving — Vikas, a new session, a new agent — reads this first and
needs nothing else. Anyone doing work updates it as they go, not at the end.

Last verified at: **2026-08-08 01:34 +05:30** · by: audit session · *the live delivery board below is a dated snapshot; external counts and open heads can change without this file changing*

## LIVE DELIVERY BOARD — 2026-08-08 01:34 +05:30 (last-verified snapshot)

This compact board is the delivery contract for this last-verified snapshot. Allowed statuses are **MERGED**, **BUILDING**, **IN REVIEW**, **READY NEXT**, and **BLOCKED WITH REASON**. “Unassigned” is intentional until an author and a different reviewer are named.

This board was last verified against GitHub at **2026-08-08 01:34 +05:30** and `master` **`c3519a6`**. External PR heads and review state can change without this file changing; the Slack audit report's source line citations remain pinned to inspected commit `7329537`.

| Feature | Status | Branch-PR | Author | Reviewer | Next proof / software-team scope |
|---|---|---|---|---|---|
| Resizable threads | MERGED | `master` / PR #14 | Luna | unassigned | Verify the installed build still preserves draggable width, focus restoration, narrow takeover, and restart persistence. |
| Remove timing | MERGED | `fix/agents-are-not-on-a-timer` / PR #13 (`97daeae`) | Vikas Mittal | unassigned | Re-read the merged no-clock turn/approval contract; retain the focused Stop/process-tree proof and unknown installed-build gates. |
| Manual workflows | MERGED | `master` / PR #18 (`daf851f`) | Vikas Mittal | chatgpt-codex-connector | Re-read the merged plain manual-v1 list/builder slice without implying triggers, schedules, run history, or permissions. |
| Persistent mentions-and-replies notification inbox | MERGED | `master` / PR #19 (`551b2f8`) | Vikas Mittal | chatgpt-codex-connector | Re-read the merged durable per-user mention/reply contract and later prove read/dismiss, source navigation, ownership, retention, mute/quiet/OS, and deleted/inaccessible states. |
| Saved/Later message queue | MERGED | `master` / PR #28 (`9429c48`) | Vikas Mittal | unassigned | Re-read the merged per-user save/unsave contract and later prove persistence, auth isolation, source navigation, retention, and deleted/inaccessible handling; PR #17 remains audit/contract only. |

| Visible queue/fair concurrency | READY NEXT | unassigned / next PR | unassigned | unassigned | Expose queued/started/cancelled order and capacity in Activity without adding a timing foundation. |
| Context compaction/remaining visibility | READY NEXT | unassigned / next PR | unassigned | unassigned | Show what was compacted and honest remaining-room state while preserving thread-first routing. |
| Real SKILL/project skills | READY NEXT | unassigned / next PR | unassigned | unassigned | Add an explicit allow-list and on-demand loading with an owner security boundary; never read arbitrary folders silently. |
| Richer handoff context | READY NEXT | unassigned / next PR | unassigned | unassigned | Deliver and render memory/run/artifact/thread pointers with owner and membership checks. |
| Verification runner/status | READY NEXT | unassigned / next PR | unassigned | unassigned | Run an owner-approved recipe and persist visible checked/could-not-check/mismatch evidence. |
| Engineering Pulse | BUILDING | `engineering-pulse` / PR #21 (`9b37d00`) | Vikas Mittal | unassigned | Review the internal Pulse/feed surface for loading, error, membership, and moderation boundaries. |
| Internal team social feed | BUILDING | `internal-team-social-feed` / PR #20 (`53ea088`) | Vikas Mittal | chatgpt-codex-connector | Review project-scoped chronological posts/comments/reactions by humans and agents with membership isolation, own edit/delete, durable links, unread, and accessible states. |
| Project polls | BUILDING | `feature/project-polls` / PR #22 (`b03b99a`) | Vikas Mittal | unassigned | Review project-scoped durable polls with explicit ownership, close/edit rules, and accessible results; no public publishing. |
| Engineering Canvas | BUILDING | `feature/engineering-canvas` / PR #26 (`83ebc26`) | Vikas Mittal | unassigned | Review the internal project Canvas implementation for membership isolation, durable edits, and accessible loading/error states. |
| Project forums/decision threads | BUILDING | `project-forums-decision-threads` / PR #23 (`6a76fbf`) | Vikas Mittal | chatgpt-codex-connector | Review durable project discussion and decision records with membership, moderation, link-access, and audit boundaries. |
| Huddle presence/shared notes | BUILDING | `huddle-presence-shared-notes` / PR #24 (`9c8fbb9`) | Vikas Mittal | chatgpt-codex-connector | Review project/channel-scoped presence and notes only; v1 excludes audio and video and must preserve membership boundaries. |
| Public project update publishing | BUILDING | `public-project-updates` / PR #25 (`1f6efa3`) | Vikas Mittal | chatgpt-codex-connector | Review explicit human approval, immutable revisions, revocation, and audit trail; no autopublish or external posting. |

## 0. THE THREE REFERENCES — read this before designing anything

**Strict rule, 2026-08-07, his words:** *"you are not going to assume or guess
anything. if i am giving you the reference of any product to you, you just have
to OPEN THAT AND SEE IT FIRST and then only implement. from now on you will TELL
ME FIRST what you are implementing."*

| What you are building | What you copy | How to check it |
|---|---|---|
| **The harness** — prompt, skills, tools, hooks, memory, permissions, agent loop, verification | **Claude Code / Codex** | You are running inside Claude Code. Observe your own harness. If Claude Code does not do it, Cloud9 does not do it unless he asks. |
| **The front end** — chat, channels, threads, anything he looks at | **Slack** | Real docs, cited. Never a remembered feature list. |
| **Other features** | **Buzz** (`github.com/block/buzz`) | **Installed on this machine.** Open it and watch it. |

**The gate: open the reference → say what you will build → wait → then build.**

Anything you cannot verify says **"not verified"**. Never fill a gap with a
plausible answer.

**What ignoring this cost:** threads took THREE attempts and all three were
aimed the wrong way, because nobody ever looked at Slack. The shipped result
made the panel *narrower and fixed* when he wanted it *draggable and big*. A
reviewer even wrote "there is no drag handle anywhere in the codebase — he may
want control of that edge", and it was ignored in favour of tuning CSS numbers.
On the same day the conductor invented a reference he had never given
("creator.io"), which is the same failure wearing a different hat: when the fact
is not there, say so and ask once.

---

## 1. WHERE WE ARE RIGHT NOW

### CURRENT SNAPSHOT — 2026-08-08 01:34 +05:30

| # | Ask | Owner | Current stage | Evidence / boundary |
|---|---|---|---|---|
| 12 | **remove the timing** — *"agents are employees"* | timing author | **MERGED — PR #13 on `origin/master` `daf851f`** | The no-timer source and tests are merged. This current row supersedes the dated PR13 snapshots below; those rows remain historical evidence only. |
| 17 | **Persistent mentions-and-replies notification inbox** | notification author | **MERGED — PR #19 on `feature/persistent-notifications`, based on `origin/master` `551b2f8`** | Durable mention/thread-reply inbox shipped with deterministic ids, idempotent SQLite writes, recipient-scoped read/dismiss, retention, tombstone projection, edit/delete refresh, accessible rail/list/empty/loading/error/focus/live states, request correlation, and guarded navigation. PR #19 is merged; no package/install/QA/app-walk claim is added here. PR: https://github.com/vikas53953/cloud9/pull/19 |

| 19 | **Saved/Later message queue** | master | **MERGED — PR #28 (`9429c48`)** | V1 saves and unsaves readable messages per account, stores note/reminder metadata without scheduling notifications, projects active/deleted/inaccessible source states, and mirrors correlated updates to the owner's windows. The merged Saved commit is `9429c48`, now included in master `c3519a6`; Saved migration is schema v8 after Workflow v7 and includes durable fingerprinted receipts (30-day/512 bounded retry ledger), deterministic pagination, access re-projection on membership changes, account cleanup, offline/lost request notices, pending detail-action guards, timezone-safe reminder dates, and draft retention until correlated success. Evidence on current source: shared build passed; relay focused Saved tests **5/5** and desktop Saved checks **3/3**; no package/install/app-walk claim. |

The dated snapshot rows below are preserved history; the rows above are the current live stages for PR13, PR17, and Saved/Later.

### Historical tracker rows (preserved snapshots)

Historical PR13 snapshot (2026-08-07 17:43 IST): PR #13 was OPEN and
MERGEABLE/CLEAN against `origin/master` (`7ce7bcd`) at head `6fc1c5f`.
Round-2 ownership and terminal-output fixes were pushed; review was pending,
and the PR was not approved or merged. The count table below is retained as
dated history, including its earlier CONFLICTING state.

| Count | |
|---|---|
| Things Vikas has asked for and are open | **2** - **threads** (author verified, PR #14 open; review not done) and **remove the timing** (PR #13, rejected in review). **As of 2026-08-07 15:27 +05:30.** |
| Agents working right now | **2** — the threads build, and the timing agent fixing four blockers. **As of 2026-08-07 11:00.** |
| Open PRs | **2** - #14 (threads, open and not reviewed) and #13 (remove the timing, conflicting on `TRACKER.md`). **As of 2026-08-07 15:27 +05:30.** |
| Merged today | **8** — #6 time limit · #7 threads width · #9 activity · #10 spending · **#11 harness inventory** · **#12 threads research** · plus #5 and #8, both reverts of code that reached master unreviewed (one the conductor's). |

| # | HIS ASK (his words — never renamed) | Who has it | Stage | Evidence so far |
|---|---|---|---|---|
| 1 | **threads** - *"pull it to the left-hand side like slack"* | author (Luna) | **MERGED (PR #14, `7ce7bcd`) · BUILT · PACKAGED · INSTALLED · MEASURED.** | Round-1 width/inert findings remain fixed. Round-2 focus fix retains the initiating reply control, restores it after beside/back, forced 800px back, and responsive unforce when it remains visible, and uses a visible room-control fallback when the reply action is no longer visible; close no longer falls to `<body>`. Installed evidence from `%LOCALAPPDATA%\\Programs\\Cloud9\\Cloud9.exe` (SHA256 `CB0018B75455A29090CC6386A9EBBFD04B0F680B5ED92575CD23C5E721E3E52E`), renderer `index-DKWyPRcf.js` (SHA256 `23C2019264327BB6B85B318CF54EF8B9EC26396865235F5EA637F6AA824D0245`) / `index-shSU9Pdt.css`, is in `docs/qa/threads-drag-2026-08-07/measured.txt` (run 2026-08-07 17:03 +05:30). Measured acceptance map: startup 388 with divider aria 300/388/1292; pointer drag 1100, 340 and 1292 with room floor 300 and pointer cleanup; arrow keys 696 then 648; tooltip changes only after a custom width; take-over dims the room and returns with `show thread beside channel`; actual 40-Tab focus isolation at wide and forced 800; exact focus restoration to the initiating reply after wide back, responsive 800→1330 unforce, and forced 800 back; close restoration to the initiating reply; 894 exact 300/300 with aria 300/300/300; stored 900 survives 1330, 800, 1920 and a real restart. Desktop source tests 29/29, build/typecheck, dist, install and dedicated installed walk pass. Full `npm test`, `npm run qa`, and generic `npm run qa:app` remain UNKNOWN from prior bounded runs; no full-suite or generic-walk pass is claimed. Rebased branch includes round-2 commit `6d1a942` on origin/master `7ce7bcd`. PR #14 was independently reviewed and merged; full `npm test`, `npm run qa`, and generic `npm run qa:app` remain UNKNOWN from prior bounded runs.
pm run qa`, and generic `pm run qa:app` remain UNKNOWN from prior bounded runs.
| 2 | **agent activity and details** | **DONE** | **MERGED (PR #9, `2e83846`) · BUILT · INSTALLED · WALKED — on his machine 09:30** | **2026-08-07 09:10 — rebased and re-photographed.** The spending change landed on master after this branch was last lined up, and the two of them wanted the same line: the rail of buttons down the left. Master's copy of that line put the button back to its old name "Log" with no number on it, so a careless tidy-up would have quietly undone the two things this whole task was about. Resolved by hand and re-checked in the app itself: the button now says **Activity**, it **carries the count**, and master's new **Spending** button is still sitting right above it — all three visible in one picture, `docs/qa/activity-2026-08-07-rebased/activity-3-working-now.png`, where the board says "1 of your 2 agents is working right now" and the button beside it shows **1**. The whole walk was re-run on the freshly packaged app and all four states came out again, including the two the review asked for — 🛑 "You stopped it" and ❓ "Waiting for you", together in `activity-6-waiting-for-you.png`, where nobody is working and the Activity button correctly shows **no number at all**. Tests after the rebase: shared **218/218**, hub **421 pass, 0 fail**, desktop **27/27**, build clean. Older evidence, still true: **All eight are closed, and the two states the review named are photographed** — 🛑 "You stopped it" and ❓ "Waiting for you", both in `docs/qa/activity-2026-08-07/activity-6-waiting-for-you.png`, from `cloud9-activity\release\win-unpacked\Cloud9.exe` (this branch's own package, not the main tree's). That one picture also settles the worst fault: the top line reads "Nothing has started yet. One is waiting for your go-ahead." and **the Activity button carries no count at all** — they finally agree, where before the button said 1 over a board saying nobody was working. The "finished" fix is visible too: a 2-minute-43-second job that had just ended reads **"Just now"**, not "3 minutes ago". Two faults were only half-closed and are now closed by SHAPE: an agent doing something this build has never heard of can no longer fall through to a ✅ (adding a state without telling this screen is now a build failure), and the clock is checked against **his own real job records** captured out of the running app, where the old sum reads "3 minutes ago" for a job that ended ten seconds ago. **Two more were found that the review missed** — the Crew screen was telling the SAME two lies one screen over — and **one new one the walk caught: a job he stopped took SIX MINUTES to say so**, because the board asked "what did it just do" the instant the lamp went out, which is before the record is written, and then never asked again. It now keeps asking while he is watching. Engine tests, measured properly this time: **master on this machine fails 8 of 1,053 on its own; this branch fails 14 of the same 1,053** — but the branch touches **no engine file whatsoever**, and re-running the extra ones on their own passes them. The three files holding them fail 7 alone here, 6 of which master fails too. So the number people keep quoting (10, then 16, then 14) is the same GitHub/worktree/timing set plus however loaded the machine was. |
| 3 | **agent time bug** | **DONE** | **MERGED (PR #6) · BUILT · INSTALLED · WALKED — on his machine 09:30** | A TOTAL clock was a deadline on the ANSWER, so how long work took decided whether it lived; 3→10 min that morning only moved the guillotine. Now ONE 45-min backstop for every kind, and the SILENCE clock (chat 3 min, unchanged) does all the judging — it is the only one that can see whether the program is still producing output. Nothing got shorter; jobs went 30→45. **Round 1 was REJECTED for repeating the sin inverted**: the new message told a 45-minute job "it was going round in circles" — another guess about work the app cannot see. The rule that came out of it, and it is the best thing this loop produced: **pass no verdict at all** — say only the two things the app can see, that a clock ran out and which one. Tests now FAIL if a verdict phrase is put back into either message. The reviewer ran a CONTROL against master to prove the 15 remaining failures were the loaded machine, not this change. |
| 4 | **token consumption** — "so that agents can see and help optimize others agents automatically" | **DONE** | **MERGED (PR #10) after THREE rounds · BUILT · INSTALLED · WALKED — on his machine 09:30. The inverted figure below was CAUGHT AND FIXED before it ever reached him; both mistakes now fail a test that names the cost in tokens.** | **The approval half PASSED and was checked hard** — every write path traced; nothing changes without his click; `narrowingOnly` is a closed two-member union checked at engine AND hub; the write happens inside his decision rather than as a follow-up frame, which the reviewer endorsed. No cross-owner leak. Codex honesty holds. **The numbers are INVERTED, found by running the shipped code against his 185 REAL run records.** `sentToIt` sums `usage.inputTokens` alone — for Claude Code that is the un-cached remainder, 2-4 tokens a turn; the bulk arrives as `cache_read_input_tokens` and was filed under "reused" and never used. So Fable5 at **$7.79** draws as **"0% handed to it / 100% written back"** while actually handed **1,120,105 tokens**. The flagship "here is your waste" finding therefore NEVER fires for a Claude agent. One card contradicts itself on screen. **59 tests passed because `tokenuse.test.ts` contains ZERO occurrences of `cachedInputTokens`** — no test ever built a realistic Claude usage shape, so every test agreed with the bug. Plus: an accusation the app cannot support (absent data read as zero), a verdict fired off ONE turn quoting a hard-coded 318x as if measured, a suggested cap that could stop an agent immediately, and screenshots absent from the PR. |
| 5 | **(found for him, not asked)** a Codex agent cannot be given a spending limit AT ALL | nobody yet | **OPEN — needs an agent** | `providerCanBeCapped` (shared/src/index.ts:672-674) returns true only for `"claude"`, because only Claude reports what a turn cost. So a Codex agent has NO money ceiling and cannot be given one. The time limit was its only ceiling, and PR #6 raises that 10 -> 45 min. Found by the PR #6 reviewer. Ties directly to "the money default" below — that decision is now more urgent than it looked. |
| 6 | **(found for him, not asked)** an agent that asks him a question is killed before he can answer | agent · in review | **PR #13 OPEN — became REMOVE ALL THE TIMING** | Opened as a 3-vs-10-minute bug: the card waits 10 minutes but a chat turn parked on it prints nothing and was killed at 3. **Vikas then ruled on the whole thing** — *"just remove the timing… what is the meaning of agents? agents are employees"*. Claude Code and Codex put **no** deadline on a turn and **never** expire a permission prompt; Cloud9 invented three deadlines they do not have and tuned them across three rounds (3 → 10 → 45 + a silence clock) when the answer was always zero. The last round's own defence is what kills it: the silence clock was "the honest judge because it can see whether the program is still producing output" — true of the PROGRAM, blind to the PERSON. PR #13 removes both budget tables, their ceilings, the leash, the timeout error and its sentences, `run.ts`'s quiet clock, `APPROVAL_LIMITS.waitMs`, the hub's expiry sweep, and the on-screen countdown. **Net −1,027 lines.** `timebudget.ts` is kept as a headstone that exports nothing and carries the old arguments FOR a clock, with a test that fails if any constant reappears. **A turn now ends when it finishes, when it fails, or when he presses Stop — nothing else.** Evidence: `notimers.test.ts` 7/7 (incl. Stop still killing a real process tree with no clock underneath it), `spendplanfallback` 28/28, shared 218/218, build green. Two reds with a control: master fails the IDENTICAL `repowork` test (34.3s master vs 30.7s branch) in a file this branch does not touch. |
| 7 | **(found for him, not asked)** one path runs with no time limit at all | Vikas Mittal | **BUILDING — saved-key provider parity** | The saved-key SDK intentionally has no wall-clock leash, matching the no-clock contract, but now receives the owner Stop abort controller and fails loudly when no final answer survives. Focused source evidence is on `feature/saved-key-provider-parity-current`; package/install/app-walk evidence remains pending. |
| 8 | **(found for him, not asked)** a message an agent is queued behind still shows the LAST thing it finished | nobody yet | **OPEN — needs an agent** | The Activity board now shows "Next up" for a job he handed over with `!bg` — that comes from the jobs tray, where a job that has not begun is marked `not_started`. But an ordinary `@Agent do X` in a room creates **no job at all**, and the engine runs only **two turns at once** (`engine.ts:808`) and holds the rest in memory. So he can type a message, the agent is genuinely holding it, and its row goes on saying "✅ Finished — 2 hours ago" about something else entirely. Closing it is not a screen change: **nothing on the wire says an agent has a message queued**, so the engine has to start reporting its own queue before the board can draw it. Found by the PR #9 second review, which correctly did not block the branch on it — the board is right about everything it is actually told. |


### CURRENT RECONCILIATION — PR #13 (2026-08-07)

The timing branch was rebased onto current `origin/master` `551b2f8`. All
master tracker rows and the branch-only timing evidence are retained. PR #13
is currently **OPEN and MERGEABLE/CLEAN** against that base; the stable code/test
commit is `8f50f61`, and final independent review is pending. It is not approved
or merged, and later tracker/body-only commits may move the PR head without
changing the code evidence.

Evidence carried forward from the timing branch: the four review blockers were
addressed (parked approval waits release execution slots; websocket close and
restart replay do not answer for the owner and explain how to ask again; the
16 MiB capture keeps the answer tail and fails loudly when it is lost; and a
historical, non-quiet taskstuck comparison was paired with controls). That
historical comparison is machine-sensitive evidence only; no fresh detached,
rebuilt, quiet-machine taskstuck control has been run yet. Focused evidence is
`notimers.test.ts` 7/7, `spendplanfallback` 28/28, shared 218/218, full build
green, relay reconnect probe 2/2, and the targeted engine run 24/24.
Boundaries remain explicit: the Codex provider has no spending cap, and Stop
does not reach the `SdkProvider` route.

### THE PAUSE AT ~04:00 IS OVER

Both agents picked up where they stopped and nothing was lost.

- **#10 spending** — finished and **MERGED** as PR #10.
- **#9 activity** — took the walk it was in the middle of, passed its third
  review, and has now been lined up again on top of #10. It is with the
  reviewer, who merges it. Nobody merges their own work.

### WHAT IS NOT ON HIS MACHINE

Threads and the time limit are MERGED but **not installed**. His Cloud9
currently runs the spending branch's build, because that agent installed to take
a screenshot. Nobody may say threads is done until a build from master is
installed, the files compared, and it is walked.



### INSTALLED AND WALKED — 2026-08-07 09:30

Built from master `2e83846`, packaged, installed, and the files compared rather
than trusted:

```
installed: index-C13jspEO.js   index-D5Epe0JS.css
built:     index-C13jspEO.js   index-D5Epe0JS.css
```

Installer took **34 seconds** (it used to hang for twelve minutes doing nothing)
and checked its own work.

**Walk of the real installed app: 41 pass, 1 fail.**

The single failure is NOT a bug and must not be recorded as one: the check asks
an agent to read a file called `the-secret-note.txt` and report the passphrase
inside. The agent REFUSED, saying that is the shape of a prompt-injection test
rather than a real task. The file-reading ability itself was proved repeatedly
on 2026-08-06. **The test is written like a phishing attempt and the agent
correctly declined.** The honest fix is to rewrite the check with an ordinary
file and an ordinary question — logged as row 9, not closed by pretending the
run was green.

### What the four asks actually became

1. **threads** — the panel can no longer grow when he pulls the window, and the
   conversation is the wider of the two at every size the app allows. Reviewer
   swept 700→2560px in 2px steps: 931 measurements.
2. **agent time bug** — a working agent is no longer killed by a stopwatch. The
   rule that came out of it: **pass no verdict at all** — say only that a clock
   ran out and which one. Tests fail if a verdict phrase is put back.
3. **agent activity and details** — one screen showing what every agent is doing
   now. Reaching "✅ Finished" requires an affirmative "this agent is quiet" on
   all four fields that arrive over the wire; 38 unrecognised inputs were fed in
   and **none** produced a tick. A new state that this screen does not handle is
   a compile error.
4. **token consumption** — what each agent costs and what is wasted, with agents
   able to propose savings he approves. Its central figure was INVERTED in
   review — caught by running the code against his 185 real records, not by
   reading it.


| 10 | **HIS ASK:** "what all the harnesses we have and what all the harnesses we do not have at this moment when we compare to claude code" | **harness-inventory agent** | **PR #11 OPEN — round 6 REJECTED (one row), fixed, back with the reviewer who merges. I DO NOT MERGE.** | The page is `docs/harness-vs-claude-code.html`, under his own eight headings. **The headline: Cloud9 does not have its own agent brain — it drives the real `claude` program on his PC (`claude-cli.ts:1033` → `run.ts:375`), so most of the harness is already his. The gaps are what Cloud9 switches off, never shows, or hands to a weaker second route.** Two things were measured against the LIVE programs rather than read off the code: the real CLI was started with Cloud9's own command line and reported **37 tools** with his setup off, **166** with it on, **6** for a talk-only agent; and the INSTALLED `Cloud9.exe` was started as the tool doorway and really answered a search — so the old wrong-executable bug is fixed in the installed app, not just in dev. **Two old notes are corrected: `attachHooks` with no caller and `verifyClaims` shipping `false` were both real and were both fixed 2026-08-06 — both fixes are in the installed bundle** (`host.ts:143-144`, confirmed in `…\resources\app\node_modules\@cloud9\engine\dist\host.js`). The installed web bundle is `index-C13jspEO.js`, the same file built from master, so the page describes the code on his machine. **Three biggest gaps: (1) saving an API key in Settings switches him to a route where a default agent is REFUSED before it starts, Stop kills nothing, no live view, no Cloud9 tools, and a 6-step cap that reports `(no response)` — `host.ts:184-189`, `provider.ts:723-726` / `provider.ts:770`, proved by `sdkreach.test.ts:51-95`; (2) the hooks engine is finished, switched on and reachable and there is NO screen, button or command to write a rule — searching `apps/desktop` + `apps/relay` for `saveHooks\|newHookId\|HOOK_EVENTS` returns nothing; (3) only two turns run at once (`engine.ts:815`) and a queued agent shows nothing — that is row 8.** New for the board: `notify-feed.ts` has only a test as a caller and is not exported — the same class of failure as the two just fixed. **On the timers: as of this reading BOTH are still on master** (`timebudget.ts:108-112`, `shared/src/index.ts:487`) and `gh pr list` showed no open PR, so the page reports them as present and says so; the 10-minute one lives in three places (engine, hub, screen) so a partial removal will only half-work. Suites run this session: 88 prompt/skills · 98 hooks/verify · 91 tools/attachments/fences · 80 memory/approvals · 20 stopping-a-turn · 12 relay. No build/package/install was taken. **REVIEW ROUND 1 — REJECTED, and it caught two things I had WRONG, both now fixed and owned on the page itself.** (1) The page claimed we have a per-agent spending cap. We do not by default — `shared/src/index.ts:756` says no ceiling at all is "the day-one default" — and a **Codex agent cannot be given one at all** (`providerCanBeCapped`, `shared/src/index.ts:672-674`, board row 5). Combined with new agents starting with his own setup ON at ~318x the cost, he would have finished the page believing every agent has a money ceiling when none do. **That is now ranked item 1 and recommendation 1.** (2) I wrote that Claude Code cannot leave a command running in the background so there was nothing to fix — **false, and the page contradicted its own tool table.** Background work is a SETTING on the command tool, not a separate tool, so counting tools could never find it; `Monitor/TaskOutput/TaskList/TaskStop` are the check-back family and `abilities.ts:404-412` grants all four. This is exactly the failure section 0 exists to prevent and the page now says so out loud. Also fixed: the headline proof now cites the **engine** folder (`attachHooks` x3 in installed `host.js`, `ELECTRON_RUN_AS_NODE` x2, `chat: 45 * 60_000`) rather than the web bundle, which proved nothing about the engine; the 10-minute permission card is shown **dying at 3 minutes** because a turn parked on it prints nothing (row 6); "nobody is removing the timers" replaces a false claim that someone was; `gh pr list` no longer described as empty; every ranked item and every recommendation carries its own feedback handle; recommendations re-ranked to money default > API-key trap > the dying card, with the queue and hooks demoted. **Rendering checked in a browser, not assumed:** an earlier attempt to put a feedback handle on all 67 table rows visually broke the page below the fold — caught by screenshot, reverted. 45 handles now, page renders top to bottom. **ROUND 2 — REJECTED NARROWLY (4 small fixes), and TWO OF THE FOUR WERE CAUSED BY MY OWN ROUND-1 FIXES.** Worth recording as a pattern: correcting a claim in one place and leaving the old version standing somewhere else. (a) The closing advice still read "do not chase `TodoWrite` or background shells — nothing on our side to fix", which is the exact sentence the correction 300 lines above it retracts, sitting in the block he is most likely to read. Split: `TodoWrite` stays, background shells out. (b) The background row was tagged **HAVE on inference** while its own last line said "not verified" — the same overclaim round 1 rejected — and it named `Monitor`/`TaskOutput`/`TaskList`/`TaskStop` as how a background command is checked on. **Those are the HELPER-AGENT family** (`abilities.ts:404-412`); reading a background command is `BashOutput` and stopping it is `KillShell`, **and both are absent from the 31 tools an agent can hold**. The row is now NOT VERIFIED and carries back the doubt my FIRST draft had right and I threw out along with its wrong premise: every turn is a fresh program that exits (`claude-cli.ts:1033`) and the 3-minute silence clock (`timebudget.ts:157`) kills exactly the shape of a turn that waits quietly. (c) The new number-one item cited `ownersetup.ts:36-38` — a bare comment and a note about credentials. The figures are at **`ownersetup.ts:34-35`**, which also show the prompt gets **~14.5x BIGGER but ~318x DEARER**; the page now explains that gap (the small prompt is nearly all cached, and cached words are billed at a fraction) instead of quoting both numbers unexplained. (d) The installed-Cloud9.exe spawn now says who ran it and that **only the disk half is independently attested** — installed `cloud9mcp.js` present, `ELECTRON_RUN_AS_NODE` x2, `attachHooks` x3 in the installed engine — while the launch itself remains one agent's word. Minor citations corrected: `shared/src/index.ts:928-936` to `:4458-4459`, `agent-memory.ts:296` to `:337`, `agent-handoff.ts:36-38` to `:163-164`. The dying-card story is now told once instead of three times. **Per rule 7 (feedback is said once), recommendation 1 was reframed:** it is no longer a fresh ask but the decision already sitting under "Waiting on Vikas — the money default", plus the fact that should settle it — a Codex agent cannot be capped at all, so "we will add a cap later" does not cover every agent. Rendering re-checked in a browser down to the last recommendation; 45 handles, no duplicate labels. The reviewer re-verified and ACCEPTED the round-1 work: the 12 room commands, the 166 breakdown, the timers statement, every money claim, the four new gap rows, a long list of citations, and the decision to drop row-level handles after a screenshot caught them breaking the page. **ROUND 3 — REJECTED on ONE blocker, and it was the SAME PATTERN for the third round running: correcting a row and leaving a stale copy of the old claim in a block that SUMMARISES rows.** The class fix, and the thing worth keeping: **this page has exactly two blocks that restate other rows — "What I could not prove" and the closing advice — so every retraction anywhere always leaves a copy in one of them.** Both are now swept end to end whenever anything is retracted, instead of being patched line by line. What was still stale in them: the honesty list said "the tools for it are granted" for background work while the row it summarises says in bold that `BashOutput` and `KillShell` are absent; and the confession about getting background work wrong still named the four helper-agent tools as how a background command is checked on — **the confession repeated the error it was confessing to**. Also swept: "the two best rows on this page" now carries "neither re-run by me, nor by the reviewer". Two clauses added on top. (1) **The 318x is now stated as ONE COLD TURN wherever it appears**, with the doubt attached: the money multiplies far faster than the size (~14.5x bigger, ~318x dearer) because the big prompt is a fresh cache WRITE, so a repeat question could cost far less — his own records show caching really happens, 171 of 185 saved runs carry a cached figure — **but every Cloud9 turn is a fresh program and whether a warm cache is ever there for the next one is NOT VERIFIED.** It is written as the worst case and the cold-start price, not a certainty on every question, because recommendation 1 asks him to make a money decision on that number. Arithmetic confirmed by the reviewer: 87,498/6,030 = 14.5 and 1.75/0.0055 = 318.2. (2) The missing background tools are named as **absent from the CLI's own measured set, not withheld by Cloud9**, so he does not blame the app for something it did not do. **One correction to my own earlier note on this board:** I recorded that putting a feedback handle on all 67 table rows "visually broke the page". Measured properly this round with a script rather than a screenshot, the page is **17,809px tall, 15 sections, footer present at 17,677px, tallest section 2,083px, and 47,847 characters of RENDERED READING TEXT** (that last number is the browser`s `innerText`, i.e. what a person actually reads — it is NOT the file, which is 87,797 characters, nor the page markup, which is 77,831; an unlabelled number is the exact failure this page exists to catch, so it is labelled here) — completely healthy. **The blank screenshots were a capture artifact on a very long page, not a layout bug.** Dropping the row-level handles was still the right call and the reviewer endorsed it, but my stated reason was wrong and the record should say so. Reviewer verified and accepted, no action: `ownersetup.ts:34-35`, the background row (called the strongest row on the page, `NOT VERIFIED` the correct tag), the doorway attribution, all three minor citations, the dying card told once, the closing paragraph split, and the rule-7 reframing of recommendation 1 — judged honest rather than soft re-asking because it names the board decision and adds exactly one new fact instead of restating the ask. **ROUND 4 — REJECTED on ONE LINE, and the lesson is the one worth keeping off this whole task.** The stale phrase "the tools are granted" was still in the closing advice at `:1046-1049`, contradicting its own row at `:731-733` ("neither is in the 31 tools a Cloud9 agent can hold") — the same contradiction, in the same words, in a block I had just declared swept end to end. **The diagnosis was right and the execution was at the old altitude: I swept by READING, and reading is exactly what missed it the three previous rounds.** The construction that actually closes this class, and the one to use from now on: **grep the retracted phrase itself across the whole page before saying it is clean.** `grep "tools are granted"` finds it in one command; re-reading a 1,200-line page does not. That grep is now run for every retracted phrase before any push — this round it returned zero hits for "tools are granted", "tools for it are granted", "check-on-it", "the four check" and "two best rows", and confirmed the surviving hits ("are granted every" at `:707` about helper nesting, "nothing on our side to fix" at `:1046` about TodoWrite) are correct in context. **Also settled: the "47,847 characters" I reported last round was unlabelled and reconciles with nothing** — it is the browser's rendered `innerText`, i.e. what a person actually reads. The file is 87,797 characters and the page markup is 77,831. An unlabelled number is the exact failure this whole page exists to catch, so the board now says what it counted. The structural half of that measurement stands and was independently confirmed: 15 sections, footer present at 17,677px, tallest section 2,083px — the blank screenshots were a capture artifact, not a layout bug. **And row-level feedback handles are SETTLED AS NO — keep 45, do not restore the 67.** The reason is not layout: ~112 blocks makes the copy-back a wall of text, which defeats the one thing the feedback layer exists for. What he would actually contest is the seven ranked items and the three recommendations, and those all have their own handles already; table rows are the evidence UNDER a claim, not the claim. If a middle ever is wanted, the cut is handles on the ~15 rows tagged DOESN'T WORK / STILL ON / DEAD / NEW FINDING / NOT VERIFIED — not all 67. **ROUND 5 — REJECTED, and this one was not craft: a fact on the page had gone FALSE and the page argued against a ruling Vikas had since made.** PR #13 ("just remove the timing — an agent is not on a clock any more", branch `fix/agents-are-not-on-a-timer`, open and MERGEABLE) removes **all three** clocks. The page said in five places that nobody was removing them, and **recommendation 3 told him to go and build it** — so acting on this page would have sent someone to build a second time. All five corrected; recommendation 3 is now "**Land PR #13 — already built, it needs reviewing, not building**", with the one thing to check named (the card deadline must go in all three places — engine, hub, screen — or it only half-works). **The 45-minute defence is WITHDRAWN and the page says why it was wrong to make it:** it argued the backstop was "the deliberate result of the merged time-limit fix", against his ruling that "agents are employees so i don't want to implement a timing foundation". That was a product decision that was his, argued down with an engineering reason that was ours — the same disease as inventing the clocks in the first place. Written into the page rather than quietly deleted. **THE CLASS, and it is genuinely new: this is round 1's finding INVERTED.** "Another agent is removing them" was false then because nobody was; "nobody is removing them" was false now because someone was. **Anything derived from `gh pr list` rots on its own — it is the only claim class on this page that goes wrong with NOBODY TOUCHING THE FILE, so the pre-push grep cannot catch it, because the words do not change, the world does.** The construction for this class (the way grep was for the last one): **stamp every such claim with the time it was read and say what would change it.** Eight stamps now on the page, an amber "as of 2026-08-07 06:00" style, a paragraph in "How to read this page" telling him these rot and to ask what is open before acting, and an honesty item admitting the page has now been wrong on this in BOTH directions. Everything about code is unstamped and holds until the code changes. **Also settled this round:** the "47,847 characters" is labelled as rendered `innerText` (file 87,797, markup 77,831) — an unlabelled number being the exact failure this page exists to catch; and **row-level feedback handles are settled as NO for a better reason than mine** — not layout, but that ~112 blocks turns the copy-back into a wall and defeats the layer's purpose, while the ranked items and recommendations he would actually contest already have handles. Reviewer's independent grep confirmed the round-4 retracted-phrase sweep genuinely clean. 46 handles, 15 sections, page renders top to bottom. **ROUND 6 — REJECTED on ONE ROW, and it produced the construction that finally closes this class.** The Agent Loop row at `:702-710` was untouched by the round-5 sweep: it still carried the tag `STILL ON`, still said the 45-minute clock "is still on master", and **still argued the silence clock was "a genuinely good Cloud9 idea"** — the entire withdrawn defence, alive in the one section a person goes to when asking "why did my agent get cut off". **Round 3 was: row corrected, summary stale. This is the exact mirror: summary corrected, row stale. Sixth time for this class.** Row now tagged `BOTH GOING`, names PR #13, withdraws both arguments, and says the constants it cites are deleted when #13 lands. **WHY THE GREP COULD NOT CATCH IT, AND THE FIX — this is the durable lesson of the whole task.** My round-4 construction was "grep every retracted phrase". That works for words I have already used and is **structurally blind to synonyms I never thought of**: this row said "it is still on master", which means the same as "nobody is removing it" and shares not one word with it. **Phrasings are unbounded and cannot be enumerated. STATUS TAGS ARE BOUNDED.** There are ~15 on the page, every one asserting a fact about right now, and one command lists them all: `grep -n "STILL ON\|DOESN'T WORK\|DEAD\|NEW FINDING\|NOT VERIFIED"` — then check that list against `gh pr list`. **That closes the class by construction rather than by remembering, and it proved itself immediately: run on the fixed page it found ANOTHER row whose words had been corrected but whose TAG still said `STILL ON`** (the 10-minute card, now `GOING`). The check is written into the page itself so the next person inherits it. **Also this round:** the page now states it is **a photograph of one commit** (`e08ba7f`) and that ~15 of its citations — `timebudget.ts`, `approvaldesk.ts`, the card deadline in hub and screen — **point at code PR #13 DELETES, so those line numbers stop existing when it lands**; the findings stay true, the pointers die, and that is the honest cost of a dated snapshot rather than a fault in it. **The stamped class was also too narrow** — it is not "claims from `gh pr list`" but **"claims about the world outside this repo's source"**. Seventeen stamps now, including the one that matters most: the reassurance under the API-key warning that no `cloud9-credential-claude.bin` exists, which **stops being true the instant he does the thing being warned about** — it now says so. Also stamped: the 171-of-185 cached runs, the CLI at 2.1.224, the memory folder, `sessions.json`, and the installed-bundle hash, which rots the next time anyone takes the build slot. **MERGE ORDER — say it before it is discovered: PRs #11, #12 and #13 ALL touch `TRACKER.md`.** All three are MERGEABLE against master right now, but **#12 and #13 will each need a `TRACKER.md` conflict resolved after #11 lands.** This already bit once this round: the conductor's board commit conflicted with mine and was resolved by keeping both sides (master's PR #13 row 6, this branch's row 10, and this branch's corrected `shared/src/index.ts:672-674` on row 5, where master still carried the stale `:664`). This repo has lost work to concurrent edits before. Everything else on the page was accepted this round: all five 318x occurrences correctly qualified without swinging so far that the headline stops being a number he can act on (the reviewer checked that specifically, and noted the load-bearing fact under recommendation 1 — a Codex agent cannot be capped at all — is untouched by the cache caveat, so qualifying the number costs the recommendation nothing); "absent from the CLI's own measured set, not withheld by Cloud9"; the honesty section, called better than it asked for, owning that my own correction was itself wrong and leaving the trail rather than tidying it away; and `providerCanBeCapped` tightened to `:672-674`.

| 9 | **(found for him, not asked)** the file-reading QA check reads like a phishing test | nobody yet | **OPEN — needs an agent** | `drive-app.mjs` asks an agent to read `the-secret-note.txt` and report the passphrase inside. The agent refuses — correctly — because that is the shape of a prompt-injection test. The ability itself was proved on 2026-08-06. Rewrite the check with an ordinary file and an ordinary question, so a sensible refusal stops reading as a product failure. |

| 11 | **what all the harnesses we have and what all we do not have vs claude code** | done | **MERGED (PR #11, `cbe8134`) after SEVEN review rounds · published to him** | Headline: **Cloud9 has no agent brain of its own — it drives the real Claude Code on his PC**, so most of the harness is already there. What is missing is what Cloud9 switches OFF, never SHOWS him, and one much weaker route. Top three findings he would feel: every new agent starts with his setup ON, **no cap, and a Codex agent cannot be capped at all**; **saving an API key switches every agent to a broken route** where Stop stops working and agents die after 6 steps; the rules engine is finished and switched on with **no screen to write a rule**. Seven rejections, every one a real defect — 3 the author's, **2 created by its own fixes**, 1 created by the reviewer's (it defended the 45-min clock after Vikas had ruled against it). The class was only closed when a **check** replaced careful reading: grep the bounded set of status tags, not the unbounded set of phrasings. |
| 12 | **remove the timing** — *"agents are employees"* | agent · fixing 4 blockers | **HISTORICAL SNAPSHOT (2026-08-07): PR #13 OPEN · REJECTED IN REVIEW · CONFLICTING** | −1,027 lines: both budget tables, the leash, the timeout error and its sentences, the quiet clock, the card's expiry, the hub sweep, the on-screen countdown. **But the review found the clocks were holding up three things nobody had noticed**, all of which bite on exactly the overnight run he asks for: (1) two agents parked on approval cards now **freeze the whole crew for ever** — measured, branch: third agent never answers; master: it does; (2) a laptop sleep leaves a **zombie card** — green, clickable, and pressing Approve does nothing at all; (3) with no clock a long run passes **2 MB of output and the app keeps the FIRST 2 MB**, discarding the real answer and recording `outcome: ok`. Also: the author's control was wrong — master `taskstuck` is **11/11 twice**, so that IS a branch regression. This row is preserved dated history, not a live status. |

| 13 | **Buzz vs Cloud9 — installed feature audit (2026-08-07)** | audit agent | **AUDIT COMPLETE · REPORT ONLY · no feature implementation** | Opened `%LOCALAPPDATA%\Buzz\buzz-desktop.exe` (external metadata reported **0.5.5; unverified in the app**) and walked Inbox/home, Pulse, Projects, Agents, Workflows and `#coding`. Dated screenshots are in `docs/qa/buzz-*-2026-08-07.jpg`; the visual report is `docs/buzz-vs-cloud9-2026-08-07.html`. Counts: **8 Cloud9 source capability rows (installed UI unverified) · 1 visible Buzz gap · 2 Buzz surfaces that need Vikas's decision before copying · 6 unverified feature rows · 2 partial behavior checks · 1 observed Runtime errors state excluded from feature counts.** Feature classes total **17 rows**; adding the two partial checks and one observed state gives **20 audited checks**. Unverified feature rows: **DMs, Approvals, Repos/PR/project details, Canvas, Forums, Settings/account.** Partial behavior checks: **Search execution and file send/artifact card.** Runtime errors remain observed Buzz state and are excluded from feature counts. Inbox visibly showed Sol twice, luna and Fizz; no Honey. The red “Some message context could not be loaded” banner is recorded as Buzz app state, not a Cloud9 gap or proven Buzz defect. Cloud9 was compared from source at commit `6f4b7ea`; its installed app was not launched in this lane. |
| 14 | **Workflow list / builder** | workflow-list-builder (Luna) | **BUILDING — current base + installed evidence (2026-08-07), final reviewer pending** | Concept A is implemented as owner-only manual runbooks: the Workflows rail route lists saved definitions, the builder edits name/description/channel/enabled ordered agent steps, and detail shows named agents, per-step status, durable run history, archive/restore, and explicit restart interruption. Relay Store schema 7 owns `workflows` and `workflow_runs`; runs create ordinary Cloud9 tasks with workflow links, serially advance from task truth, wait on existing approvals, stop on first failed/stopped step, and retry from that step without silent continuation. Duplicate/stale task updates are monotonic and terminal-attempt idempotent; workflow tasks are scoped to the owner/authorized channel audience; deleting an agent stops affected runs and retires approvals. Schedules, event triggers, graph editing, and sharing remain explicit v1 non-goals. Rebased onto `origin/master` `7329537`; current review source tip `773adb5`. Source evidence: root/shared/relay/desktop build passed; focused workflow relay tests are **17/17** and desktop electron checks are **33/33**, including raw-wire update patch identity/archive protection. Installed lane was captured on pre-rebase source-equivalent head `ded3a1c`: `npm run dist` generated `release/Cloud9-Setup-0.1.0.exe`, silent install exited 0, and Computer Use launched `C:\\Users\\vikasmit\\AppData\\Local\\Programs\\Cloud9\\Cloud9.exe`. Installed Workflows evidence included rail/list empty state (`MANUAL RUNBOOKS`, `Nothing starts until you press Run`, `No workflows yet`), builder focus on Workflow name and validation alerts for missing name/step, saved detail with named agent/instruction, Edit, Archive confirmation and `Archive keeps history`, Restore, manual Run, and a stopped run with `Retry from here` plus `This workflow was stopped.` Approval wait/resume and restart interruption were not reached in the installed lane; source integration covers those paths. Desktop package test timed out after 304.9s and is **UNKNOWN**, not green. The decision record and Buzz evidence remain at `docs/workflow-list-builder-decision-2026-08-07.html` and `docs/qa/buzz-workflows-2026-08-07.jpg`; no independent WCAG conformance claim. |
Workflow row metadata (2026-08-08): current review tip `773adb5`, rebased onto `origin/master` `7329537`; focused workflow relay tests are **17/17**, desktop electron checks **33/33**, and root/shared/relay/desktop build passed. Installed evidence remains explicitly pre-rebase source-equivalent (`ded3a1c`); desktop package test timed out and is **UNKNOWN**, not green.

### 2026-08-07 Buzz important-functions frontier (audit only; no feature implementation)

The complete visual program map is [`docs/buzz-important-functions-2026-08-07.html`](docs/buzz-important-functions-2026-08-07.html). It uses the dated Buzz captures in `docs/qa/` and separates observed UI, installed-CLI/source capability, verified gaps, decisions, and fog. The installed Buzz binary is `0.5.5` by Windows file metadata; the in-app version was not observed. Computer Use could not be initialized in this session (`Windows Computer Use Sky runtime is unavailable`), so no new UI action or screenshot is claimed here. Existing captures remain the only visual evidence. CLI help is capability evidence, not visible UI evidence.

| 15 | **hooks editor** | remove-the-timing agent | **BUILDING — PR #27 OPEN; independent review pending; not approved or merged** | Existing engine events/actions are exposed through shared validation and an owner-only relay SQLite rule store with durable audit, request-id idempotency/correlation, live relay→engine sync/firing audit, enable/disable/delete/test flows, and accessible Hooks rail/editor. Commands/shell and webhook credentials are intentionally absent. Base `f555ed1`; stable source/test commit `014a972`. Evidence: shared, engine, and relay builds pass; engine host 18/18 and hooks 26/26; relay Hooks CRUD/receipt-limit/audit namespace 3/3; desktop typecheck and Hooks source 3/3; diff-check clean. Firing receipts are event-bound and deduplicated; success reports audit as `dispatched` with `ok=false` because no relay acknowledgement protocol exists; note-save failures refuse; hook jobs carry recursion provenance; relay enforces the 50-hook owner cap while preserving accepted create receipts on replay; CRUD responses mirror to every owner desktop window with correlation only on the origin, including no-id delete/list mirrors without clearing concurrent pending requests. Visible scoped hook audit history has correlated loading/empty/error states. No package/install/QA/app walk or performance comparison. PR: https://github.com/vikas53953/cloud9/pull/27 |
| 16 | **saved-key provider parity** | Vikas Mittal | **BUILDING — PR #30 (\
| 17 | **queue visibility and fair concurrency** | nobody yet | **NOT STARTED — verified buildable harness gap; author/reviewer unassigned** | `packages/engine/src/engine.ts:808-825` drains a hard default of two turns at once; the queue is private. `packages/shared/src/agentactivity.ts:101-108` explicitly says ordinary chat turns waiting behind that cap have no wire field, so Activity can show the last completed job instead of queued work. Boundary: report queued/started/cancelled order and capacity in the same activity/task contract, with retry/stop semantics; do not add a timing foundation. Dependencies: run lifecycle state only; queue visibility is independent of saved-key provider parity (16). |
| 18 | **context compaction and remaining-room visibility** | nobody yet | **NOT STARTED — verified buildable harness gap; author/reviewer unassigned** | `packages/engine/src/context.ts:52-58,236-273` keeps a bounded newest slice and drops older conversation without a summary or a visible “room left” signal. `apps/desktop/src/App.tsx` has no context-budget/compaction surface. Boundary: preserve thread-first routing, tell the agent/person what was compacted, and expose remaining-room state without claiming token precision the harness cannot report. Dependencies: session/persistence contract and run evidence. |
| 19 | **real project and plugin skill instructions** | nobody yet | **NOT STARTED — verified buildable harness gap; author/reviewer unassigned** | Cloud9's own skills and `open_skill` are present (`packages/engine/src/cloud9tools.ts:556-608`, `provider.ts:361-435`), but the Codex isolation test creates owner `SKILL.md` fixtures and an isolated environment (`packages/engine/src/codex.test.ts:227-243`), then asserts owner skill directories are absent and skill paths are disabled (`:255-264`). Boundary: an explicit, inspectable allow-list for project/plugin skill discovery and on-demand loading; no silent access to arbitrary owner folders. Dependencies: owner-setup/security decision outside this audit. |
| 20 | **handoff context beyond a channel** | nobody yet | **NOT STARTED — verified buildable harness gap; author/reviewer unassigned** | The wire allows context pointers to `memory`, `run`, `channel`, or `artifact` (`packages/shared/src/index.ts:4361-4365`), but `packages/engine/src/engine.ts:3260-3305` only delivers room-channel pointers; other pointers are dropped, and thread context is not represented. Boundary: deliver and render memory/run/artifact/thread pointers with owner/membership checks, preserving the existing channel handoff behavior. Dependencies: artifact/memory access contracts, then queue/run lifecycle (17). |
| 21 | **verification runner and visible check status** | nobody yet | **NOT STARTED — verified buildable harness gap; author/reviewer unassigned** | `packages/engine/src/verify.ts:1-367` checks only four claim shapes against recorded steps; `apps/desktop/src/App.tsx:2361` exposes `verifyClaims`, but no build/test runner or positive checked state is present. Boundary: an explicit owner-approved verification recipe per project/worktree, durable run evidence, and visible “checked / could not check / mismatch” status; no blanket auto-publish or hidden command execution. Dependencies: repo/worktree action model and run records only; verification is independent of saved-key provider parity (16) and queue visibility (17). |
| 24 | **Internal team social feed** | Vikas Mittal / chatgpt-codex-connector; hardening checkpoint 2026-08-08 | **BUILDING** | Project-scoped internal posts, comments, and reactions with human and agent authors, chronological ordering only, membership isolation, edit/delete of one's own post, links to task/run/PR/artifact, durable persistence, unread indicator, and accessible rail/feed/composer/loading/empty/error states. Boundary: this branch defines the internal project contract only; no public publishing, ranking, DMs, polls, or Pulse fields. Dependencies: project membership/owner auth, durable post identity and storage, moderation/deletion rules, unread/read state, link target permissions, and accessible UI state contract. |


| 22 | **Persistent mentions-and-replies notification inbox** | Vikas Mittal; reviewer `chatgpt-codex-connector` | **MERGED — PR #19 (`551b2f8`)** | The separate durable per-user notification inbox for mention/thread-reply entries—not a second view of the existing agent Activity screen—landed in PR #19 with read/dismiss, source navigation, persistence/storage, owner isolation/auth, retention, deleted/inaccessible handling, and mute/quiet/OS-preservation dependencies. Slack behavior remains **FOG** because the live UI and current canonical help-page status/content were unavailable; this is not a Slack-parity claim. |
| 23 | **Saved/Later message queue** | Vikas Mittal; reviewer unassigned as of 2026-08-08 01:34 +05:30 | **MERGED — PR #28 (`9429c48`)** | Cloud9 contract: save/unsave; durable per-user list; open the source message/thread; honest deleted or inaccessible state. Dependencies: message identity + persistence/storage + per-user ownership/auth isolation + navigation/read + deletion/access/retention semantics. Slack behavior remains **FOG** because the live UI and current canonical help-page status/content were unavailable; Terra/Luna chose retention semantics in the implementation. PR #17 remains the audit/contract only; PR #28 is merged in master. |

### Waiting on Vikas — nobody else can do these

- **Uninstall McAfee.** Every program start costs **~271ms instead of ~20ms**. Windows Defender is OFF; McAfee is the only scanner. This is why everything takes ten minutes.
- **The money default.** New agents start with his own setup ON and no spend cap — **$1.75 a question vs half a cent**. Recommended: default OFF + a cap, switch stays one click away.
- **Tailscale sign-in** — ten minutes in his browser; it is what lets friends connect.

---

## 2. THE RULES — every agent and every session follows these

1. **His words, never renamed.** The agent name, the row here, and the PR title
   all carry the task name HE gave. A renamed request is an invisible request —
   "make Cloud9 fully agentic" once got built as "chat experience round" and
   vanished as a thing he could ask about.
2. **No "done" without evidence run in this session.** Not an agent's report,
   not a green suite. He confirms; he never discovers.
3. **A green build is NOT evidence for anything visual.** A layout or screen
   change needs a **before/after screenshot** from the INSTALLED app at his
   window size. A change was rejected for exactly this on 2026-08-07.
4. **Fix the class, not the case.** One principle or one structural change that
   makes the whole category impossible — never a rule for the one instance.
5. **Never silent.** Anything the app cannot do must say what it cannot do AND
   how he can allow it. A refusal with no door is the thing he hates most.
6. **Plain words.** He is a network engineer, not a developer. No jargon on
   screen, in commits, or in reports.
7. **Feedback is said once.** Check this file before asking him anything.
8. **Blaming the slow machine is not a diagnosis.** It explained away THREE real
   bugs on 2026-08-06. A red gets an explanation with a number attached, or it
   stays red.

10. **ANYTHING DRAWN FROM "WHAT IS OPEN RIGHT NOW" ROTS BY ITSELF.** Stamp it
   with a date and say what would change it. On 2026-08-07 a report said
   "nobody is removing the timers" in five places while PR #13 was open doing
   exactly that — and its own earlier round had said the opposite when nobody
   was. **The words never changed; the world did**, so the pre-push grep that
   closes the stale-copy class cannot catch this one. A different construction
   is needed: date-stamp the claim, or do not make it.

## 3. THE PROCESS — how work is done

**Law locked 2026-08-08** (Vikas approved). Visual: `docs/gates/pipeline-loop-2026-08-08.html`.
This is a **pure agentic loop**. The main agent is the **Conductor** (orchestrator).
Author and reviewer are always **different** agents. Builder never reviews own work.
You (Vikas) name the ask and settle escalations — you do not sit every review round.

### The room

| Role | Does |
|---|---|
| **Conductor** | Spawns one agent per free role; relays author↔reviewer; keeps this board honest; escalates after 2 reject rounds; never builds and reviews the same work |
| **Author** | Writes the plan, or builds on one branch · one issue |
| **Reviewer** | Different agent · finds what is wrong · verdict only: Blockers / Out of scope / Agree |
| **You** | Name the ask · settle escalations · approve direction when brought a clean page |

```
0  ASK
   you name it → board row (your words) → conductor assigns author + reviewer

1  PLAN  (cheap · no product code)
   Author writes plan  ⇄  Reviewer attacks it
   verdict: Blockers | Out of scope | Agree
   max 2 reject rounds → conductor escalates
   Big work only: light program design (files · signatures · test names · least confident)
   Optional when fuzzy: brainstorm / grill / throwaway prototype (never ships)
   Compact decisions to docs before leaving the stage
   ↓ only when plan AGREED

2  BUILD  (expensive · vertical slices)
   Author: own branch → thin end-to-end slices (not all-backend-then-UI)
   ⇄ Reviewer per slice/PR (never the builder)
   same verdict shape · max 2 rejects → escalate
   Logic prefers TDD; screens need install walk when visual
   If “branch broke X”: control-check master first
   Compact status to docs after every slice
   ↓ builder + reviewer AGREE

3  MERGE
   only after agreement · nobody merges their own work · board gets real evidence
```

### Standing laws

- **Nobody merges their own work.** Ever.
- **Nobody reviews their own work.** Ever.
- The reviewer is briefed to REJECT. Approving wrongly costs Vikas another
  round on a complaint he has already made; rejecting wrongly costs one
  iteration. Err toward rejecting.
- A row is created the moment he asks — before any code, never at delivery.
- A commit cannot close a row. Only a finished evidence run can.
- **One artifact per stage** — reviewer judges only that plan file or PR.
- **Dex upgrades inside this loop** (not a second pipeline): vertical slices,
  light program design for big work, compact to docs at stage/slice boundaries.

## 4. HOW TO REPORT AND UPDATE

**Every agent, at the end of its work:**
1. Update its row in section 1 — stage, and the evidence with real numbers.
2. Commit `TRACKER.md` with the work. Plain words in the message.
3. Report: root cause with evidence · what changed · fail-then-pass proof ·
   the PR URL.

**The conductor session, every wake-up:** move every open PR one stage forward,
then update this file. If this file is stale, that is the failure — not the code.

## 5. MACHINE CONDITIONS — known, not bugs to chase

- Program start ~271ms (McAfee real-time scanning; Defender off).
- **ONE** build, **ONE** package, **ONE** install, **ONE** `qa:app` walk at a
  time. Three walks were destroyed by agents packaging concurrently.
- An agent must never rewrite a whole shared file — one overwrote `App.tsx`
  mid-run and wiped another agent's work.

## 6. THE EVIDENCE CHAIN

```
npm run build → npm test → npm run qa → npm run dist
→ scripts/install-cloud9.ps1  (verifies the install landed)
→ npm run qa:app              (walks the REAL installed app)
```

Last full run, 2026-08-06 evening: **walk 41/41 · tests 1,618/1,620 ·
installer 19s** (it used to hang for 12 minutes).

Only the walk found the bugs that mattered — unit tests and browser QA were
both green while Stop was silently lying and agents could not read his files.

---

*Related files: `ASKS.md` is the historical board with the full story per ask.
This file is the live one. When they disagree, fix both.*
