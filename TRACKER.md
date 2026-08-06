# LIVE TRACKER — Cloud9

**This file is the single source of truth. If it disagrees with a chat message,
a commit, or an agent's report, THIS FILE WINS.**

Anyone arriving — Vikas, a new session, a new agent — reads this first and
needs nothing else. Anyone doing work updates it as they go, not at the end.

Last updated: **2026-08-07, evening** · by: conductor session

---

## 1. WHERE WE ARE RIGHT NOW

| Count | |
|---|---|
| Things Vikas has asked for and are open | **4** |
| Agents working right now | **4** |
| Open PRs | **0** — verified with `gh pr list` |
| Merged today | 1 — PR #4, but it merged the REJECTED version before its review existed. Master is carrying that regression until the threads agent removes it. |

| # | HIS ASK (his words — never renamed) | Who has it | Stage | Evidence so far |
|---|---|---|---|---|
| 1 | **threads** — "still able to pull thread intersection to make it big… should be like slack" | threads agent | **taking the rejected change back off master (PR #5)** | PR #4 was merged before its review existed, so the REJECTED attempt 1 is sitting on master right now (300px floor — *wider* than the 292px he objected to; an overlay that covers the room's Send button). His installed app is safe; the next build from master would not be. This PR puts master back exactly as it was before #4. The real fix follows on its own branch. |
| 2 | **agent activity and details** | agent | building | Must first prove what the existing Log screen / live steps / run records already show. A duplicate screen is worse than none. |
| 3 | **agent time bug** — his Fable task was killed at 10 min, "It was working the whole time" | agent | **fix written · tests green · not yet pushed** | Cause confirmed and widened: a TOTAL wall clock was being used as a deadline on the ANSWER, so how long work took decided whether it lived. Raising 3 min → 10 min in the morning only moved it. Fix: the total is now one backstop number (45 min) for every kind of turn — chat, job, schedule, repo — so no kind is judged by its length, and the SILENCE clock (chat 3 min, jobs 10 min, unchanged) does all the judging, because it is the only one that can see whether the program is still producing output. Also proposed differently from the sketch: 60 min was rejected — it sat ON the ceiling (clamp becomes decoration) and made an attended chat reply outlive an unattended job. Money is NOT guarded by a clock and never was; see "the money default" above — that is the honest place to close it. Fail-then-pass on `turnleash.test.ts` / `timebudget.test.ts`; full engine suite green against `dist`. |
| 4 | **token consumption** — "so that agents can see and help optimize others agents automatically" | agent | building | Real waste measured: own-setup = **318x** ($1.75 vs $0.0055); skills-on-demand already cut prompts **74%**; one room already at **88%** of its limit. |

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
