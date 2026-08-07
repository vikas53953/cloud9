# LIVE TRACKER — Cloud9

**This file is the single source of truth. If it disagrees with a chat message,
a commit, or an agent's report, THIS FILE WINS.**

Anyone arriving — Vikas, a new session, a new agent — reads this first and
needs nothing else. Anyone doing work updates it as they go, not at the end.

Last updated: **2026-08-07, ~04:00 — PAUSED ON QUOTA, resets 6am** · by: conductor session

---

## 1. WHERE WE ARE RIGHT NOW

| Count | |
|---|---|
| Things Vikas has asked for and are open | **4** |
| Agents working right now | **4** |
| Open PRs | **2** — #9 activity, #10 spending. Both agents stopped mid-work on the session limit at ~04:00; both resume from where they stopped, nothing lost. |
| Merged today | **4** — #7 threads (the real fix), #6 the time limit, and #5 and #8, both reverts of code that reached master without review (one of them mine). |

| # | HIS ASK (his words — never renamed) | Who has it | Stage | Evidence so far |
|---|---|---|---|---|
| 1 | **threads** — "still able to pull thread intersection to make it big… should be like slack" | threads agent | **PR #7 · rebased on master · back with the reviewer for its second pass** | The rejected change is off master (PR #5, merged). The real fix: measured in the installed app, the panel was never actually wide at his window sizes (20% of the screen at 1440, 15% at 1920) — but it was a fixed slab while the room was told to give way to nothing, so **pulling the window narrower pushed the thread from 15% to 34% of the screen until at 800px the thread (268px) was WIDER than the room (238px)**. That is the thing he can do with his mouse. Now the thread is a share of the space beside it — 280/245/232px at 1920/1440/1184 — capped at 280px, and **the room is the wider of the two at every window size the app allows**, which it never was. Reviewer re-derived every number independently and they reproduce. Before/after pictures at four sizes in `docs/qa/threads-2026-08-07/`. |
| 2 | **agent activity and details** | agent | building | Must first prove what the existing Log screen / live steps / run records already show. A duplicate screen is worse than none. |
| 3 | **agent time bug** — his Fable task was killed at 10 min, "It was working the whole time" | agent | **fix written · tests green · not yet pushed** | Cause confirmed and widened: a TOTAL wall clock was being used as a deadline on the ANSWER, so how long work took decided whether it lived. Raising 3 min → 10 min in the morning only moved it. Fix: the total is now one backstop number (45 min) for every kind of turn — chat, job, schedule, repo — so no kind is judged by its length, and the SILENCE clock (chat 3 min, jobs 10 min, unchanged) does all the judging, because it is the only one that can see whether the program is still producing output. Also proposed differently from the sketch: 60 min was rejected — it sat ON the ceiling (clamp becomes decoration) and made an attended chat reply outlive an unattended job. Money is NOT guarded by a clock and never was; see "the money default" above — that is the honest place to close it. Fail-then-pass on `turnleash.test.ts` / `timebudget.test.ts`; full engine suite green against `dist`. |
| 4 | **token consumption** — "so that agents can see and help optimize others agents automatically" | agent fixing | **PR #10 · review done · CHANGES REQUESTED** | **The approval half PASSED and was checked hard** — every write path traced; nothing changes without his click; `narrowingOnly` is a closed two-member union checked at engine AND hub; the write happens inside his decision rather than as a follow-up frame, which the reviewer endorsed. No cross-owner leak. Codex honesty holds. **The numbers are INVERTED, found by running the shipped code against his 185 REAL run records.** `sentToIt` sums `usage.inputTokens` alone — for Claude Code that is the un-cached remainder, 2-4 tokens a turn; the bulk arrives as `cache_read_input_tokens` and was filed under "reused" and never used. So Fable5 at **$7.79** draws as **"0% handed to it / 100% written back"** while actually handed **1,120,105 tokens**. The flagship "here is your waste" finding therefore NEVER fires for a Claude agent. One card contradicts itself on screen. **59 tests passed because `tokenuse.test.ts` contains ZERO occurrences of `cachedInputTokens`** — no test ever built a realistic Claude usage shape, so every test agreed with the bug. Plus: an accusation the app cannot support (absent data read as zero), a verdict fired off ONE turn quoting a hard-coded 318x as if measured, a suggested cap that could stop an agent immediately, and screenshots absent from the PR. |
| 5 | **(found for him, not asked)** a Codex agent cannot be given a spending limit AT ALL | nobody yet | **OPEN — needs an agent** | `providerCanBeCapped` (shared/index.ts:664) returns true only for `"claude"`, because only Claude reports what a turn cost. So a Codex agent has NO money ceiling and cannot be given one. The time limit was its only ceiling, and PR #6 raises that 10 -> 45 min. Found by the PR #6 reviewer. Ties directly to "the money default" below — that decision is now more urgent than it looked. |
| 6 | **(found for him, not asked)** an agent that asks him a question is killed before he can answer | nobody yet | **OPEN — needs an agent** | The permission card waits **10 minutes** (shared/index.ts:470, engine.ts:2009) but a chat turn is killed after **3 minutes of silence** — and a turn parked on a card prints nothing. So it asks, he thinks about it, and it dies telling him it "stopped moving". Pre-existing, not caused by PR #6, but it means "the silence clock does all the judging" is not yet a complete fix. |
| 7 | **(found for him, not asked)** one path runs with no time limit at all | nobody yet | **OPEN — needs an agent** | `SdkProvider` (provider.ts:705) runs under NO total clock and NO silence clock, and `host.ts:183-189` PREFERS it over the command-line app whenever a stored key or sign-in token exists. A hung turn there hangs for ever. Pre-existing. |


### PAUSED AT ~04:00 ON THE SESSION LIMIT (resets 6am)

Both remaining agents stopped mid-work. Neither is broken and nothing is lost —
their work is on their branches and their context survives, so each resumes
where it stopped rather than starting again.

- **#10 spending** — ONE blocker left, about five minutes: two stale
  `deepStrictEqual` fixtures in `runrecord.test.ts` that were never updated for
  the new mapper fields. The values it produces are CORRECT; only the
  expectations are stale. The reviewer also asked that the test be rewritten
  rather than renumbered, because its name "carried through untouched" is now
  false — the mapper deliberately derives a field, and that seam is exactly
  where a future double-count would surface.
- **#9 activity** — had just packaged the app and was taking the walk to
  photograph the two states it never captured (🛑 "you stopped it" and
  "waiting for you"), which is where three of its eight faults live.

### WHAT IS NOT ON HIS MACHINE

Threads and the time limit are MERGED but **not installed**. His Cloud9
currently runs the spending branch's build, because that agent installed to take
a screenshot. Nobody may say threads is done until a build from master is
installed, the files compared, and it is walked.


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

## 3. THE PROCESS — how work is done

```
his ask  →  a row here  →  ONE agent, ONE issue, its OWN branch
         →  PR (never straight to master)
         →  ADVERSARIAL review by a DIFFERENT agent  (find what is wrong, not approve)
         →  implement the feedback
         →  review AGAIN
         →  merge
```

- **Nobody merges their own work.** Ever.
- The reviewer is briefed to REJECT. Approving wrongly costs Vikas another
  round on a complaint he has already made; rejecting wrongly costs one
  iteration. Err toward rejecting.
- A row is created the moment he asks — before any code, never at delivery.
- A commit cannot close a row. Only a finished evidence run can.

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
