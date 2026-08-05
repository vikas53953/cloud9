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
