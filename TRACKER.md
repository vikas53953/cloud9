# LIVE TRACKER — Cloud9

**This file is the single source of truth. If it disagrees with a chat message,
a commit, or an agent's report, THIS FILE WINS.**

Anyone arriving — Vikas, a new session, a new agent — reads this first and
needs nothing else. Anyone doing work updates it as they go, not at the end.

Last updated: **2026-08-07 — THREADS REOPENED. He rejected it; the research is now done against the real
products and is waiting on his sign-off before any code.** · by: threads-drag-to-resize agent

---

## 1. WHERE WE ARE RIGHT NOW

| Count | |
|---|---|
| Things Vikas has asked for and are open | **0 of his 4** — all four merged, installed and walked. 5 problems found FOR him stay open below. |
| Agents working right now | **0** — all finished. |
| Open PRs | **0** — verified with `gh pr list`. |
| Merged today | **6** — #6 time limit, #7 threads, #9 activity, #10 spending, plus #5 and #8, both reverts of code that reached master unreviewed (one of them the conductor's). |

| # | HIS ASK (his words — never renamed) | Who has it | Stage | Evidence so far |
|---|---|---|---|---|
| 1 | **threads** | **threads-drag-to-resize agent** | **REOPENED 2026-08-07 — HE REJECTED IT. Research done and evidence-backed; waiting on his sign-off before ANY code.** | **The whole diagnosis below was WRONG and it went the wrong way.** He wants to **drag the thread's edge and make it BIG, and have it stay** — "pull it to the left-hand side like slack". What shipped made it a fixed, narrower slab with a hard 280px ceiling and no handle at all. Three rounds failed for one reason: **nobody opened Slack or Buzz and looked.** This round did. **Slack's own announcement (12 June 2020) names the thread view:** "You can now resize both sidebars within Slack! Expand the thread view, collapse the channel sidebar entirely." **Buzz 0.5.5 — the reference product installed on this machine — was opened and driven**, not read about: its divider tooltip literally says **"Drag to resize. Double-click to reset width."** Measured on his maximised 1936px window: Buzz's thread runs **293px → 1384px** (the CHANNEL takes the squeeze, floor ~299px), default 373px, double-click resets, width holds across a channel switch and reopen (907→907px) but is **forgotten on restart** (907→373px); at an 800px window Buzz **stops splitting entirely** — thread full-width with a back arrow. Cloud9 measured in the installed app at the same size: **thread 268px, room 1315px, no resizer anywhere in the code**. The one line that says it all: **Buzz's SMALLEST thread (293px) is wider than Cloud9's LARGEST (280px).** Review page with every source and picture: `docs/threads-like-slack.html`. **Nothing gets built until he has seen it** — his new standing rule: "if i am giving you the reference of any product, you just have to open that and see it first and then only implement. from now on you will tell me first what you are implementing." *Superseded diagnosis, kept for the record:* He was never dragging a divider — he was PULLING THE WINDOW. Measured in the installed app: the thread was 15% of the screen at 1920 and 20% at 1440, but **34% at 800px, where it was WIDER than the conversation itself** (268 vs 238px), room title cut to a bare `#`. It was a fixed slab while the room was told to give way to nothing, so the room was the only thing that ever yielded. That is why tuning the width at 1440 twice changed 4px and looked identical. Now: capped at 280px, and **the room is the wider of the two at every window size the app allows**, which it never was. The reviewer swept **700→2560px in 2px steps — 931 measurements** rather than sampling. At 1440: 292 → 244.6px. Before/after pictures at four sizes in `docs/qa/threads-2026-08-07/`. |
| 2 | **agent activity and details** | **DONE** | **MERGED (PR #9, `2e83846`) · BUILT · INSTALLED · WALKED — on his machine 09:30** | **2026-08-07 09:10 — rebased and re-photographed.** The spending change landed on master after this branch was last lined up, and the two of them wanted the same line: the rail of buttons down the left. Master's copy of that line put the button back to its old name "Log" with no number on it, so a careless tidy-up would have quietly undone the two things this whole task was about. Resolved by hand and re-checked in the app itself: the button now says **Activity**, it **carries the count**, and master's new **Spending** button is still sitting right above it — all three visible in one picture, `docs/qa/activity-2026-08-07-rebased/activity-3-working-now.png`, where the board says "1 of your 2 agents is working right now" and the button beside it shows **1**. The whole walk was re-run on the freshly packaged app and all four states came out again, including the two the review asked for — 🛑 "You stopped it" and ❓ "Waiting for you", together in `activity-6-waiting-for-you.png`, where nobody is working and the Activity button correctly shows **no number at all**. Tests after the rebase: shared **218/218**, hub **421 pass, 0 fail**, desktop **27/27**, build clean. Older evidence, still true: **All eight are closed, and the two states the review named are photographed** — 🛑 "You stopped it" and ❓ "Waiting for you", both in `docs/qa/activity-2026-08-07/activity-6-waiting-for-you.png`, from `cloud9-activity\release\win-unpacked\Cloud9.exe` (this branch's own package, not the main tree's). That one picture also settles the worst fault: the top line reads "Nothing has started yet. One is waiting for your go-ahead." and **the Activity button carries no count at all** — they finally agree, where before the button said 1 over a board saying nobody was working. The "finished" fix is visible too: a 2-minute-43-second job that had just ended reads **"Just now"**, not "3 minutes ago". Two faults were only half-closed and are now closed by SHAPE: an agent doing something this build has never heard of can no longer fall through to a ✅ (adding a state without telling this screen is now a build failure), and the clock is checked against **his own real job records** captured out of the running app, where the old sum reads "3 minutes ago" for a job that ended ten seconds ago. **Two more were found that the review missed** — the Crew screen was telling the SAME two lies one screen over — and **one new one the walk caught: a job he stopped took SIX MINUTES to say so**, because the board asked "what did it just do" the instant the lamp went out, which is before the record is written, and then never asked again. It now keeps asking while he is watching. Engine tests, measured properly this time: **master on this machine fails 8 of 1,053 on its own; this branch fails 14 of the same 1,053** — but the branch touches **no engine file whatsoever**, and re-running the extra ones on their own passes them. The three files holding them fail 7 alone here, 6 of which master fails too. So the number people keep quoting (10, then 16, then 14) is the same GitHub/worktree/timing set plus however loaded the machine was. |
| 3 | **agent time bug** | **DONE** | **MERGED (PR #6) · BUILT · INSTALLED · WALKED — on his machine 09:30** | A TOTAL clock was a deadline on the ANSWER, so how long work took decided whether it lived; 3→10 min that morning only moved the guillotine. Now ONE 45-min backstop for every kind, and the SILENCE clock (chat 3 min, unchanged) does all the judging — it is the only one that can see whether the program is still producing output. Nothing got shorter; jobs went 30→45. **Round 1 was REJECTED for repeating the sin inverted**: the new message told a 45-minute job "it was going round in circles" — another guess about work the app cannot see. The rule that came out of it, and it is the best thing this loop produced: **pass no verdict at all** — say only the two things the app can see, that a clock ran out and which one. Tests now FAIL if a verdict phrase is put back into either message. The reviewer ran a CONTROL against master to prove the 15 remaining failures were the loaded machine, not this change. |
| 4 | **token consumption** — "so that agents can see and help optimize others agents automatically" | **DONE** | **MERGED (PR #10) after THREE rounds · BUILT · INSTALLED · WALKED — on his machine 09:30. The inverted figure below was CAUGHT AND FIXED before it ever reached him; both mistakes now fail a test that names the cost in tokens.** | **The approval half PASSED and was checked hard** — every write path traced; nothing changes without his click; `narrowingOnly` is a closed two-member union checked at engine AND hub; the write happens inside his decision rather than as a follow-up frame, which the reviewer endorsed. No cross-owner leak. Codex honesty holds. **The numbers are INVERTED, found by running the shipped code against his 185 REAL run records.** `sentToIt` sums `usage.inputTokens` alone — for Claude Code that is the un-cached remainder, 2-4 tokens a turn; the bulk arrives as `cache_read_input_tokens` and was filed under "reused" and never used. So Fable5 at **$7.79** draws as **"0% handed to it / 100% written back"** while actually handed **1,120,105 tokens**. The flagship "here is your waste" finding therefore NEVER fires for a Claude agent. One card contradicts itself on screen. **59 tests passed because `tokenuse.test.ts` contains ZERO occurrences of `cachedInputTokens`** — no test ever built a realistic Claude usage shape, so every test agreed with the bug. Plus: an accusation the app cannot support (absent data read as zero), a verdict fired off ONE turn quoting a hard-coded 318x as if measured, a suggested cap that could stop an agent immediately, and screenshots absent from the PR. |
| 5 | **(found for him, not asked)** a Codex agent cannot be given a spending limit AT ALL | nobody yet | **OPEN — needs an agent** | `providerCanBeCapped` (shared/index.ts:664) returns true only for `"claude"`, because only Claude reports what a turn cost. So a Codex agent has NO money ceiling and cannot be given one. The time limit was its only ceiling, and PR #6 raises that 10 -> 45 min. Found by the PR #6 reviewer. Ties directly to "the money default" below — that decision is now more urgent than it looked. |
| 6 | **(found for him, not asked)** an agent that asks him a question is killed before he can answer | nobody yet | **OPEN — needs an agent** | The permission card waits **10 minutes** (shared/index.ts:470, engine.ts:2009) but a chat turn is killed after **3 minutes of silence** — and a turn parked on a card prints nothing. So it asks, he thinks about it, and it dies telling him it "stopped moving". Pre-existing, not caused by PR #6, but it means "the silence clock does all the judging" is not yet a complete fix. |
| 7 | **(found for him, not asked)** one path runs with no time limit at all | nobody yet | **OPEN — needs an agent** | `SdkProvider` (provider.ts:705) runs under NO total clock and NO silence clock, and `host.ts:183-189` PREFERS it over the command-line app whenever a stored key or sign-in token exists. A hung turn there hangs for ever. Pre-existing. |
| 8 | **(found for him, not asked)** a message an agent is queued behind still shows the LAST thing it finished | nobody yet | **OPEN — needs an agent** | The Activity board now shows "Next up" for a job he handed over with `!bg` — that comes from the jobs tray, where a job that has not begun is marked `not_started`. But an ordinary `@Agent do X` in a room creates **no job at all**, and the engine runs only **two turns at once** (`engine.ts:808`) and holds the rest in memory. So he can type a message, the agent is genuinely holding it, and its row goes on saying "✅ Finished — 2 hours ago" about something else entirely. Closing it is not a screen change: **nothing on the wire says an agent has a message queued**, so the engine has to start reporting its own queue before the board can draw it. Found by the PR #9 second review, which correctly did not block the branch on it — the board is right about everything it is actually told. |


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


| 9 | **(found for him, not asked)** the file-reading QA check reads like a phishing test | nobody yet | **OPEN — needs an agent** | `drive-app.mjs` asks an agent to read `the-secret-note.txt` and report the passphrase inside. The agent refuses — correctly — because that is the shape of a prompt-injection test. The ability itself was proved on 2026-08-06. Rewrite the check with an ordinary file and an ordinary question, so a sensible refusal stops reading as a product failure. |

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
