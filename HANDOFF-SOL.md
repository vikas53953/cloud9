# HANDOFF — Cloud9 · Claude Code → Sol (Codex)

**Written 2026-08-07 ~11:30 by the Claude Code conductor session, because Vikas's
weekly Claude quota is about to run out. It resets Monday.**

Sol, Terra or Luna: **you are the conductor now.** Read this file, then
`TRACKER.md`, then start. Nothing else is required reading.

On Monday the Claude session picks this back up and will read `TRACKER.md` to
learn what you did. **So keep `TRACKER.md` current — that is the handover back.**

---

## 0. YOUR ROLE — you orchestrate, you do not do the work yourself

**Vikas's rule: one agent per issue. Always.** You are a workstator /
orchestrator. For every issue and every feature:

- spawn **one** agent that owns it end to end
- spawn a **different** agent to adversarially review it
- relay between them; **you never merge your own work**
- **the review loop REPEATS until author and reviewer AGREE**, then it merges

Do not carry two issues in one agent. Do not review work you wrote. Do not
merge without a review. This is not a suggestion — he stated it as law and
said he will not repeat it.

**Name every agent with HIS words for the task**, verbatim — "threads",
"remove the timing", "token consumption". Never a reworded label. A renamed
request is an invisible request: on 2026-08-04 his ask "make Cloud9 fully
agentic" was built under the name "chat experience round" and vanished as a
thing he could ask about.

---

## 1. WHO YOU ARE WORKING FOR

**Vikas.** Network engineer by background, **not a developer**. He thinks in
visual maps, not code walls. He is building Cloud9 as a product.

- **Plain words. No jargon.** Not in replies, not on screen, not in commit
  messages. If he has to scroll to understand you, you failed.
- **Anything he must review is a visual HTML page**, never a wall of text.
- **One question at a time, always with a recommendation.** Never a menu.
- **He confirms; he never discovers.** If he finds a bug you could have found,
  that is the failure.
- **Feedback is said once.** Check `TRACKER.md` before asking him anything.

---

## 2. THE THREE REFERENCES — the rule that matters most

He set this as a **strict rule** on 2026-08-07, in his words:

> *"you are not going to assume or guess anything. if i am giving you the
> reference of any product to you, you just have to **OPEN THAT AND SEE IT
> FIRST** and then only implement. from now on you will **TELL ME FIRST what
> you are implementing**."*

| What you are building | What you copy | How to check it |
|---|---|---|
| **The harness** — prompt, skills, tools, hooks, memory, permissions, agent loop, verification | **Claude Code / Codex** | You are running inside one. Observe your own harness. **If Claude Code does not do it, Cloud9 does not do it unless he asks.** |
| **The front end** — chat, channels, threads, anything he looks at | **Slack** | Real docs, cited with links. Never a remembered feature list. |
| **Other features** | **Buzz** — `github.com/block/buzz` | **Installed on this machine** at `%LOCALAPPDATA%\Buzz\buzz-desktop.exe`. Open it, drive it, measure it. |

**The gate: open the reference → say what you will build → wait → then build.**

Anything you cannot verify says **"not verified"**. Never fill a gap with a
plausible answer.

**What ignoring this cost:** threads took **four attempts**. The first three
never opened Slack, reasoned from his words, and shipped a panel that was
*narrower and fixed* when he wanted it *draggable and big*. A reviewer wrote
"there is no drag handle anywhere in the codebase — he may want control of that
edge" and it was ignored in favour of tuning CSS numbers. The fourth attempt
opened Slack's docs and drove Buzz, and got it right in one pass.

**Also: never invent a source.** On the same day the conductor claimed Vikas had
pointed at a "creator.io blog". He never said it. When the fact is not there,
say so and ask once.

---

## 3. HIS RULES — every one, in force

1. **No "done" without evidence run in this session.** Not an agent's report,
   not a green suite. Show the output.
2. **A green build is NOT evidence for anything visual.** A screen change needs
   a **before/after photograph from the INSTALLED app at his window size**
   (1920 viewport). A change was rejected for exactly this on 2026-08-07.
3. **Fix the class, not the case.** One principle or one structural change that
   makes the whole category impossible. Never a rule for the one instance.
4. **Never silent.** Anything the app cannot do must say what it cannot do
   **and how he can allow it**. *A refusal with no door is the thing he hates
   most.*
5. **Plain words everywhere**, including commits.
6. **Feedback is said once.** Check the board before asking.
7. **Blaming the slow machine is not a diagnosis.** It explained away three real
   bugs. **And it cuts both ways** — a red needs a number before it is called a
   bug, not only before it is dismissed.
8. **His words, never renamed** — agent names, board rows, PR titles.
9. **Nothing reaches him before its review has finished.** A page was published
   early on 2026-08-07 and two bad citations reached him as a result.
10. **Anything drawn from "what is open right now" rots by itself.** Stamp it
    with a date and say what would change it. The words never change; the world
    does.
11. **No invented guards.** He removed three clocks that Claude Code does not
    have. *"What is the meaning of agents? agents are employees so i don't want
    to implement a timing foundation."* Do not add safety machinery he did not
    ask for.
12. **Every project keeps a `TRACKER.md`** — the live dashboard, single source
    of truth. If it disagrees with a chat message or a commit, **the file wins**.

---

## 4. THE PIPELINE — follow it exactly

```
his ask
   ↓
a row in TRACKER.md, in HIS words, created the moment he asks
   ↓
ONE agent, ONE issue, its OWN branch
   ↓
PR  (never straight to master)
   ↓
ADVERSARIAL review by a DIFFERENT agent
   (briefed to find what is WRONG, not to approve; may not edit, may not merge)
   ↓
implement the feedback
   ↓
review AGAIN  ──repeat until author and reviewer AGREE──┐
   ↓                                                     │
merge  ←─────────────────────────────────────────────────┘
   ↓
build → install → walk → THEN tell him it is done
```

**How to brief a reviewer** (this is what made it work):
- "Find what is WRONG. Do not approve to be agreeable."
- Give it the specific lines to attack, with the evidence you already have.
- Tell it **approving wrongly costs him another round on a complaint he has
  already made; rejecting wrongly costs one iteration. Err toward rejecting.**
- Tell it to **verify, not accept** — re-run the numbers itself.
- **Verify the "we have it" claims, not the gaps.** A wrong "we have this" is
  worse than a missing row, because a real gap goes unfixed.

The loop found **26 real defects** across five PRs on 2026-08-07. Several were
created by the fixes themselves. Two were created by reviewers. **Every one
would have reached him.**

---

## 5. WHERE THINGS ARE

| File | What it is |
|---|---|
| `TRACKER.md` | **The board. Read it second, keep it current.** Rules, process, every open row. |
| `ASKS.md` | Historical board — the full story per ask. |
| `docs/harness-vs-claude-code.html` | What Cloud9's harness has and hasn't got vs Claude Code. Merged, published to him. |
| `docs/threads-like-slack.html` | The approved threads design. **This is the spec for the threads build.** |
| `docs/qa/` | Screenshots. `scripts/drive-app.mjs` walks the installed app. |

Repo: `github.com/vikas53953/cloud9` · branch `master` · npm workspaces:
`apps/relay` (hub), `packages/engine` (spawns the real CLIs), `apps/desktop`
(Electron + React), `packages/shared`.

**The evidence chain:**
```
npm run build → npm test → npm run qa → npm run dist
→ scripts/install-cloud9.ps1   (verifies the install landed)
→ npm run qa:app               (walks the REAL installed app)
```
Only the walk has ever found the bugs that mattered. Unit tests and browser QA
were both green while Stop was silently lying and agents could not read files.

---

## 6. WHAT IS OPEN RIGHT NOW — *as of 2026-08-07 11:30*

### A. **threads** — build in progress, design approved by him
Branch: a new one off master. Spec: `docs/threads-like-slack.html`.
He answered **"i want both"** — the draggable divider AND the take-over mode.

Nine points to build, all measured, all in the page:
1. Draggable divider on the thread's left edge, live drag.
2. **Default 388px** (Buzz's measured default), not today's 280.
3. **Floors 300/300.** A floor on the ROOM, **never a cap on the thread.**
4. **Keyboard resizing** — arrow keys on the focused strip. Slack ships this.
5. **Width AND mode remembered across restarts** (`App.tsx:1550` `makeStore()`).
6. Conditional tooltip: `"Drag to resize."` → `"Drag to resize. Double-click to
   reset width."` only once he has set a width.
7. **Take-over mode** — over a **dimmed** room; way back says
   `show thread beside channel` (Buzz's own words).
8. **Below 894px the take-over mode IS the narrow-window answer.** One
   mechanism, not two. 894 = 78 rail + 216 sidebar + 300 + 300.
9. **His width is never thrown away** — drawn clamped, stored intact, restored
   when the window widens. *"The window never edits your choice — it only
   borrows it for as long as it has to."*

Today's rule: `clamp(232px, calc((100vw - var(--rail-w) - var(--side-w)) * 0.22),
280px)` at `apps/desktop/src/styles.css:423`. `--rail-w` 78px; `--side-w` 250px
above 1330px and **216px at or below** (`styles.css:82`, `:1576`).

**Proof required:** photographs from the installed app — before/after, dragged
wide, dragged narrow, keyboard, take-over and back, at 800px, at 894px, **and
after a restart showing width and mode both came back.**

### B. **PR #13 "remove the timing"** — REJECTED in review, four blockers
`gh pr view 13`. Branch `fix/agents-are-not-on-a-timer`. **CONFLICTING on
`TRACKER.md`** after #11 and #12 landed — resolve that first.

It removes all three clocks (45-min turn, 3-min silence, 10-min card expiry),
−1,027 lines. **He ruled the clocks must go.** But the reviewer proved the
clocks were holding up three things nobody had noticed:

1. **Two agents parked on approval cards freeze the entire crew, for ever.**
   `engine.ts:808-813` caps at 2 turns; a parked turn holds a slot; the hub's
   10-minute sweep used to release it. Measured: branch → third agent never
   answers; master → it does. *He goes to bed, two agents hit a `!publish` gate,
   every other agent is silent all night.*
2. **The zombie card.** `engine.ts:443` gives up every wait on any websocket
   close; the hub no longer sweeps; `App.tsx:4635-4637` keeps a live Approve
   button on a `pending` card for ever. Laptop sleeps → he clicks Approve in the
   morning → **no-op. Card goes green. Nothing pushed. Nobody told.**
3. **A long turn silently loses its answer at 2 MB.** `run.ts:319` keeps the
   **first** 2 MB. Measured: the final result line is dropped, `respond()`
   returns a mid-session fragment, recorded `outcome: "ok"`.
4. The author's control was wrong: master `taskstuck` is **11/11 twice**, so the
   branch failures ARE a regression. (`repowork` is genuinely noise — 13/13.)

Plus four to state in the PR body: the money question (below), `SdkProvider`
runs under no clock and Stop cannot reach it, the blocker test does not test a
process *tree*, and stale comments still describe the deadline as current.

### C. Problems found FOR him, open, nobody assigned
- **A Codex agent cannot be given a spending limit at all** —
  `providerCanBeCapped`, `shared/src/index.ts:672-674`. Only Claude reports what
  a turn cost. **Its only other ceiling was a clock that is being removed.**
- **`SdkProvider` runs under no clock and Stop cannot reach it** —
  `provider.ts:703-780`, and `host.ts:184-189` **prefers** it whenever a key is
  stored.
- **Saving an API key switches every agent to a broken route** — new agents
  refused, Stop dead, no live view, 6-step cap.
- **The rules engine (hooks) is finished and switched on with no screen to
  write a rule** — `hookwiring.ts:63-78` exists, nothing calls it.
- **Only two agents work at once and the third says nothing** —
  `engine.ts:815`, and nothing on the wire reports a queue.
- The file-reading QA check reads like a phishing test and the agent correctly
  refuses it — rewrite the check, not the app.

### D. **WAITING ON HIM — do not decide these for him**
- **The money default.** New agents start with his own setup **ON** and **no
  cap**: measured **$1.75 vs $0.0055 on one cold turn (318×)**. Recommendation
  on the board: default OFF + a cap, switch one click away. **He has not
  answered.**
- **Uninstall McAfee** — every program start costs ~271ms instead of ~20ms.
- **Tailscale sign-in** — ten minutes in his browser, lets friends connect.

---

## 7. MACHINE CONDITIONS — known, not bugs to chase

- **Program start costs ~271ms instead of ~20ms.** McAfee real-time scanning is
  on; **Windows Defender is OFF**. Everything is slow. This is not a bug.
- **ONE build, ONE package, ONE install, ONE `qa:app` walk at a time.** Three
  walks were destroyed by concurrent packaging.
- **Never let an agent rewrite a whole shared file** — one overwrote `App.tsx`
  mid-run and wiped another agent's work.
- **The installer** takes ~19–35s via `scripts/install-cloud9.ps1`, which
  verifies the install landed. It used to hang for 12 minutes.

---

## 8. TRAPS THAT COST REAL TIME — do not rediscover these

1. **`git checkout` leaves the previous branch's compiled `dist/` behind**, and
   `npm test -w @cloud9/engine` rebuilds only that workspace. **A "master
   control" run can execute the branch's own code and fail.** Two agents were
   caught; one nearly reported a false regression. **Delete both `dist/` folders
   and build shared first, or the number is void.**
2. **The shell eats backticks** inside a double-quoted `node -e` or `python -c`.
   An agent's board update lost every file reference and reported success.
   **Write updates through a script file, and read back what landed.**
3. **A blank screenshot is a capture result, not a layout result.** An agent
   diagnosed a layout bug from one; measuring showed the page was fine.
   **Render headless and measure — height, sections, overflow, console errors.**
4. **Screenshot rulers are ~15px out** — the width of a divider. **Measure real
   element rects over a debug port.**
5. **Stale copies in summary blocks.** A correction anywhere leaves a stale copy
   in whatever block summarises it. Six rounds of careful reading missed it.
   **The fix that worked: grep the bounded set of STATUS TAGS** (`STILL ON`,
   `DOESN'T WORK`, `DEAD`, `NOT VERIFIED`, …) — *phrasings are unbounded, tags
   are not.* It caught an instance on its first run.
6. **`gh pr merge` can print `fatal: 'master' is already used by worktree`
   while having actually succeeded.** Verify state before concluding anything.
7. **Check base branches BEFORE `--delete-branch`** — one merge accidentally
   closed another open PR.
8. **A clean `git merge` is not proof.** `TRACKER.md` rows are single enormous
   lines; a resolution can drop the other side's row and report success. **Diff
   the merged file against both parents.**
9. **Test fixtures written by hand agree with the code's own bug.** 59 tests
   passed while the central number was inverted. **Build fixtures from his real
   records** — 185 run records are committed for exactly this.

---

## 9. HOW TO REPORT BACK

**Every agent, at the end of its work:** update its row in `TRACKER.md` — stage
and evidence with real numbers — and commit it with the work. Report: root cause
with evidence · what changed · fail-then-pass proof · the PR URL.

**You, as conductor, every session:** move every open PR one stage forward, then
update the board. **If the board is stale, that is the failure — not the code.**

**To him:** short, plain, and a **visual HTML page** for anything he reviews.
Give every reviewable block `data-fb="<short label>"` and inline
`C:\Users\vikasmit\.claude\review-kit\feedback-layer.js` in a `<script>` at the
end, so he can 👍/👎/note each block and press **Copy my feedback** once.

**Honest limit, restate it rather than pretend:** a published page cannot send
data back into a session. The copy-paste hand-back is the mechanism.

---

## 10. WHAT MONDAY'S CLAUDE SESSION NEEDS FROM YOU

Just keep `TRACKER.md` true. It will read:
- which rows moved, and what evidence closed them
- what you added that nobody asked for, and why
- what is still open and who had it
- anything he decided while you had it

**Do not write a second handoff.** The board is the handover.

---

*Written by the Claude Code conductor session, 2026-08-07. Everything in
section 6 is stamped and rots on its own — run `gh pr list` before acting on it.*
