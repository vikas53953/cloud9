# What Vikas asked for — the only status board

**This is the one file that says what he asked for and where it really is.**
Everything else in this repo is a build log, a rulebook, or an archive.

Four statuses, plain words: **NOT STARTED · BUILDING · PART DONE · DONE-PROVEN**
(plus **DROPPED**, which must carry a reason).

Rules that make it true, not the file itself:
1. **A row is created the moment he asks** — before any code, never at delivery.
2. **His words, never renamed.** A renamed request is an invisible request. This
   is the exact failure of 2026-08-04: "make Cloud9 fully agentic" was built
   under the name "chat experience round" and so disappeared as a thing he
   could ask about.
3. **A commit cannot close a row.** Only a finished evidence run can, and the
   row names the count.
4. **When part of an ask ships, the row stays PART DONE and names what is left.**
   There is no status called "folded into another round".
5. **If he opens this and is surprised, the mechanism failed.**

| # | Asked | What he said | Status | Proof | What is left |
|---|---|---|---|---|---|
| 14 | 08-05 | "make Cloud9 fully agentic — system prompt, context, skills, tools, PC access, file system, memory, policy, hooks, like Claude Code and Codex" + "consider forking Buzz" | **BUILDING** | — | being scoped against what already exists; Buzz fork being judged |
| 13 | 08-05 | "why is sign in with Claude and Codex greyed out / not installed" | **DONE-PROVEN** | 1,266 tests · walk 38/38 · recovered live in 72s | — |
| 12 | 08-04 | (found for him) 3 Critical security holes sitting unactioned | **PART DONE** | 1,260 tests · qa 572/572 | an invited friend can still read the whole activity log; no database backup before migrations |
| 11 | 08-04 | "make Cloud9 fully agentic like Codex / Claude Code" | **PART DONE 3 of 5** | walk 36/36 | agents start cold every turn (no session memory); file + image attachments |
| 10 | 08-04 | "the chat is not smooth" | **DONE-PROVEN** | 151 redraws → 1 · qa 542/542 | — |
| 9 | 08-04 | "threads — conversations should not flatten into one scroll" | **DONE-PROVEN** | walk 36/36 · screenshots | DM behaviour is his open call |
| 8 | 08-03 | semantic receipts (👀 💭 ✅⚠️🔍❓) from his own draft | **DONE-PROVEN** | qa 561/561 | — |
| 7 | 08-03 | scroll anchoring + composer de-clutter (his draft §3) | **DONE-PROVEN** | 7/13 broken → 0/13 | — |
| 6 | 08-02 | notifications round 2 + connections | **DONE-PROVEN** | walk 34/34 | webhooks and mobile dropped with reasons |
| 5 | 08-02 | turn coordination | **DONE-PROVEN** | walk 33/33 twice | nothing names the passed-over agent on screen |
| 4 | 08-02 | search everywhere | **DONE-PROVEN** | walk 29/29 | — |
| 3 | 08-01 | GitHub round 2 | **NOT STARTED** | — | waiting on his feedback after using round 1 |
| 2 | 08-01 | shared Files workspace | **DONE-PROVEN** | walk 28/28 | — |
| 1 | — | Tailscale sign-in so friends can connect | **BLOCKED ON HIM** | — | ten minutes in his browser; nobody else can do it |

## Open decisions waiting on him

- DMs now put every agent answer in a thread — may feel heavy one-to-one.
- Every agent answer now notifies him as a reply in his own thread. Recommended:
  suppress when the reply answers his own question.
- A channel-started background job now splits output: detail in the thread, one
  line in the room.

## Overnight 2026-08-05 → 06 — his harness diagram, one row per piece

He drew the harness he wants: Prompt · Skills · Tools · Hooks · Memory ·
Permissions · Agent loop · Verification. Eight agents were spawned, one or
more per piece. NOTHING here may be reported as done without the conductor
re-running the evidence chain and installing it.

| # | Piece of his diagram | What is being built | Status |
|---|---|---|---|
| 15 | **Prompt** | Real system prompt: 88% of the brief is now cached instead of re-sent. MEASURED: the naive move made it WORSE ($0.019->$0.044); with the right flag it is CHEAPER than before ($0.016). Codex honestly has no equivalent flag. Plus "How hard should it think?" (Quick/Normal/Hard/Hardest) per agent. | BUILT, unproven |
| 16 | **Prompt** | "Use my own Claude Code / Codex setup" per-agent switch. PROVED: ON loads his CLAUDE.md, 17 MCP servers, 145 slash commands, 100 skills, 7 plugins, 41 tools (vs 8) and fires his hooks. OFF = todays isolation. New agents ON, existing untouched. COST: prompt 7,111 -> 30,213 tokens, ~4.25x (one probe 14x). Never inherited: his API keys, and browser/computer use (acting AS him). | BUILT, unproven |
| 17 | **Skills** | Load on demand through the tool doorway instead of re-sending all 25 every turn | BUILDING |
| 18 | **Tools** | Images and PDFs an agent can actually see (ranked #1 felt gap) | BUILDING |
| 19 | **Tools** | Codex gets connected services + Cloud9's own tools (today: none at all) | BUILDING |
| 20 | **Hooks** | Cloud9 OWN hooks: 4 events (turn finished, job finished, waiting for your OK, claim-vs-record mismatch) x 4 actions. A hook can never do what an agent would need approval for. | BUILT, unproven |
| 21 | **Memory** | Agents write their own notes (remember_this), shown with who wrote them, one click to delete. SEEDING BUG CONFIRMED AND FIXED: a full budget kept last week and dropped today's correction. | BUILT, unproven |
| 22 | **Permissions** | Spend cap, plan mode, honest sandbox wording | BUILDING |
| 23 | **Agent loop** | Context budget follows the model instead of a 24k constant; thread-scoped reading; fallback model | BUILDING |
| 24 | **Agent loop** | STOP button on a working agent + !stop. Really kills the process tree; the run says "you stopped this", distinct from failed or timed out. | BUILT, unproven |
| 25 | **Verification** | BUILT: checks 4 claim shapes (edited a file / tests pass / ran the build / pushed-PR-issue-comment) against the record, posts only on a mismatch, and REFUSES to accuse when it cannot see the record. | BUILT, unproven |
| 26 | **Reported to him, his call** | His Buzz install runs `bypassPermissions respond_to=anyone parallelism=10`, and points at `wss://vikas.communities.buzz.xyz` — a relay he does not run | HIS DECISION |

Conductor's rules for tonight: reconcile the agents' overlapping edits, run
build → tests → browser QA → installer → install → walk, fix what the chain
finds, commit per piece with his words in the message, install, and have ONE
page ready for the morning. If a quota resets, resume without waiting.

## 2026-08-06 11:00–12:20 — what the chain really said

Run in this session, not quoted from an agent:

- **build** clean, all four packages.
- **npm test** — shared 134/134 · engine 1022/1037 · relay 413/417 (3 skip,
  1 todo) · desktop 27/27. THE SUITE IS NOT GREEN. 15 engine reds.
- **npm run qa** 585/596.
- **INSTALLED AND VERIFIED 12:19** — installed bundle `index-CsfrjYuU.css,
  index-DDU8N5Wk.js` compared by name against the built one. They match. This
  is the first time today's work has been on his machine.
## FINAL — the walk, run by the conductor, not by an agent

**`npm run qa:app` → 41 pass, 0 fail, exit 0.** Against the installed app,
installed bundle `index-CsfrjYuU.css, index-DZF7gabT.js` verified equal to the
built one. Tree clean, everything pushed. All three failures below are closed.

THE STOP CORRECTION, OWED TO HIM AND NOW SETTLED: I told him Stop was proven
broken in the app, then told him it was probably the harness lying. **The first
was right.** Measured on the unfixed installed app: the run record underneath
correctly said `cancelled`, but every surface he can SEE said the work finished
normally — job `completed`, a green tick on his own message, the room reading
"🧵 Finished in the thread", and no run card at all for 60+ seconds. Reading the
code kept saying "this is fine" because the truth existed and never reached the
screen. One line: `respondAs` RETURNED the stop sentence like an ordinary
answer, so nothing downstream could tell a stop from a finish. Two more lies
fell out of the same class fix — a run card was only drawn for a job that
FINISHED, and every reason row was headed "What went wrong", so a job he stopped
on purpose told him his own decision had gone wrong.

STANDING RULE LEARNED THE HARD WAY TODAY: only ONE walk, ONE package and ONE
install may be in flight on this machine at a time — three walks were destroyed
by agents packaging concurrently. And an agent must never rewrite a whole shared
file: one overwrote `App.tsx` mid-run and wiped another agent's screen edits.

- **npm run qa:app RUN 14:10 against the installed app — 38 pass, 3 FAIL.**
  Exit 1. This is the run that decides the board, because it drives the real
  installed Cloud9 with a real harness rather than a browser mock.

### The 3 failures, and why they matter more than the other 38

1. **FIXED 15:40, commit `78f0dd9`, walk now 39/41.** `an agent asked in chat to
   read a real file on this computer actually reads it` — HIS ORIGINAL
   COMPLAINT, told to him as fixed MORE THAN ONCE before today.

   ROOT CAUSE, and it explains every word of his complaint: the room's line
   beside an agent's name could only speak in **2 of 5 reach states** and
   returned `null` in the other three. Harmless until 2026-08-05, when new
   agents started getting the home folder as a starting folder — from that day
   **every new agent landed in a silent state**. He was not missing a setting;
   there was nothing on screen to find. Second hole, same class: every "I can't"
   carries a door EXCEPT the sentence read when the switch is already ON, which
   is the one he kept meeting.

   CLASS FIX: `reachLineInRoom` is now a TOTAL function — every provider ×
   switch × folder list returns a sentence AND a button; the screen no longer
   decides when to speak. `widenItInApp` added to the capability table so any
   row bounded by something he supplies must carry the words that widen it.
   `neversilent.test.ts` walks every combination and fails if any sentence says
   no without saying how.

   PROOF on the installed app: before `FAIL … gave up after 30s waiting for the
   room to stop saying Drivecheck has nowhere to go` (38/41) → after
   `PASS — Drivecheck read C:\...\the-secret-note.txt from a plain chat message`
   (39/41).

   Old text kept for the record: still broken on the installed app. The second half is worse than the first: the
   failure reads `NOT ON SCREEN — … says nothing about it in the room, or offers
   no way to change it: null`. **A SILENT refusal.** He has said in his own words
   that being told "I can't" with no reason and no door is the thing he hates.
   The class fix owed: an agent that cannot do a thing must ALWAYS say what it
   cannot do AND how he can allow it. Never `null`.
2. **`stopping a real running turn really stops it, and the record says stopped,
   not failed`** — gave up after 120s with no record saying he stopped it.
   NOTE: an agent previously closed this as "a demo-mode artifact, the engine
   path is correct". A Stop whose record still reads `ok` cannot be told apart
   from finished or failed, which makes the button a lie.

   **CORRECTION 15:45 — I OVERSTATED THIS TO HIM.** I told him it was proven
   broken in the real app. It may be the TEST HARNESS lying: `until()` in
   `scripts/drive-app.mjs:496` returns a bare `true` instead of its callback's
   value, so `const record = await until(...)` then `record.words` is
   `undefined` — which is exactly the error this check now dies on. The check
   never reads the record it waited for. Owed to him either way: a plain
   correction once the agent on it says which it is, app or harness.
3. **`a hired agent's editor offers exactly what a hand-made one's does`** — a
   hired Architect is missing the section "How much can … do on its own?". Agents
   from the library silently offer him fewer controls than ones he builds.

Two agents were spawned on these at 14:20. Until all three are green, NOTHING
on this board says DONE-PROVEN.

### The lesson to keep

Unit tests were green (1023/1037) and browser QA was green (585/596) while all
three of these were broken. Only walking the INSTALLED app found them. That is
the argument for never closing a row on an agent's word, or on a passing suite.

### Two reds that were REAL, not flaky — and one that still is

Two agents reported the slow reds as test-concurrency artifacts. That was
checked rather than believed, by re-running the files alone on a quiet machine:

- `harness.test.ts` 4 reds → **2 survived alone → both were real bugs**, now
  fixed (`settleSignIn`, commit 0b3032c). 28/28. A failed sign-in used to make
  him wait 30 SECONDS — a full five-process detection round — to be told a
  thing known the instant the window refused to open. Measured 30s → 2.6s.
- `repowork.test.ts` **8 reds survived alone**, so NOT contention. An agent is
  root-causing; symptom is `gave up waiting: Scout to finish` with a STUB
  provider, so nothing about a slow model can explain it.
- Found on the way: **76,068 leftover `cloud9-*` temp folders** the suite never
  cleaned up, compounding every run. Purged. The class fix — a test that
  cleans up after itself — is still owed.

### THE INSTALLER ITSELF IS A BUG (found 12:10, unfixed)

`Cloud9-Setup-0.1.0.exe /S` **hangs**: 12 minutes alive on 1.4 seconds of CPU,
no UAC prompt, no window, app not running. Three attempts, three hangs. Today's
build reached his machine by copying `release/win-unpacked` over the install
folder — byte-for-byte what the installer would have placed, then verified by
comparing file names on both sides.

This is not a test-rig problem. **It is the shipping path.** If it hangs here it
hangs for anyone he ever gives this to. Nothing installs itself reliably today.

### Waiting on him

- **New agents default to owner-setup ON with NO spend cap. Measured $1.75 vs
  $0.0055 on one tiny question — 318x**, not the ~4x estimated on 08-05.
  Recommended to him 12:00: default OFF + a cap, switch stays one click away.
- Tailscale sign-in (row 1) — ten minutes in his browser, nobody else can do it.

| 27 | **Catch-up** | His 5 existing agents lacked commands entirely and had no folder - they were telling the truth. A one-time startup migration adds only, never removes, tells him on screen what changed and how to undo it. | BUILT, unproven |
