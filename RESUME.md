# RESUME — pick this up and keep going          written 2026-07-29, Vikas away

Vikas has stepped away and cannot be asked anything. He directed: keep working
autonomously, do real testing rather than assuming, and **make no false claims**.
If a session limit interrupts, resume from this file the moment work can start
again. Do not wait for instruction. Do not re-ask him anything answered below.

## The laws that matter most right now
1. **No completion claim without fresh evidence from a run in THIS session.**
   He caught a false claim already today (I said an agent "can search the web"
   without checking). Verify, then speak.
2. Fix the CLASS, not the case.
3. Anything he must review = a visual HTML page carrying the feedback layer
   (`~/.claude/review-kit/feedback-layer.js`, `data-fb` blocks).
4. He judges design only by seeing the whole thing, never from a description.

## Where the product stands (verified)
- Real agents work: he saw a Claude Sonnet 5 agent answer in the packaged app,
  with the run strip ("asked by @Vikas · 15s to answer · runs on Claude").
- Packaged Windows app installs with its own name/icon/shortcuts, runs
  standalone, generates its own owner secret. Rebuilt 2026-07-29 10:51.
- Design law = `docs/mocks/p3-studio.html` (STUDIO). He REJECTED the first
  reskin: it copied palette/type but not LAYOUT. A rebuild is in flight.
- Backend decided: agents overnight on his own PC (kept awake), his
  subscription pays, private network (Tailscale) first, Vercel only for the
  future public web GUI. See `docs/plans/backend-decision.md`.
- FR-CM-009 (threads/reactions/attachments/edit/delete/mentions) approved by
  him on 2026-07-29 and recorded in the spec.

## Work in flight when he left
| Agent | Owns | Doing |
|---|---|---|
| design-match | `apps/desktop/src/**` | Rebuild every screen to match p3-studio.html structurally; per-screen side-by-side proof |
| engine | `packages/engine/src/**` | Run records (what an agent actually did), agent capability prompt, config isolation, `mayDriveAgent` on every turn path |

Landed already: chat basics server half (scrollback, FTS5 search, reactions,
edit/delete, threads, attachments, account-level unread, `respondToAllowlist`,
audit ledger with seq+prevHash, schema version). Build clean; engine 151,
relay 52 at that point.

## Confirmed open items — do these, in this order
1. **Renderer half of the chat basics** — `docs/plans/chat-basics-handoff.md`
   §2–3 has exact frame shapes. Includes the agent-permission screen.
   MUST NOT start until design-match lands (same files).
2. **Markdown is not rendered.** The composer's Bold/Italic/Code buttons insert
   `**stars**` and backticks and the message renders as plain text, so the
   buttons make messages look WORSE. Agents also write markdown. Highest-value
   small fix in the app. (`docs/plans/feature-gap.md`.)
3. **Agents inherit Vikas's personal Claude Code config** — a probe showed a
   Cloud9 agent listing his Telegram/Vercel/Magic Patterns/cron tools. His
   ability toggles are therefore NOT the real permission boundary. Engine agent
   was briefed; verify it actually landed and prove what still leaks.
4. **Attachment download over the wire** — deferred pending an auth decision.
5. **Channel/membership as rows** (role, joinedAt, invitedBy, removedAt) plus
   channel description/topic/visibility/archive — plan is in
   `chat-basics-handoff.md` §7.
6. Then: rebuild the installer, reset the demo database, re-run the full QA,
   and prepare his review page.

## Testing rules he set
- Do the testing yourself; you have full control of the machine.
- `npm run qa` runs the browser suite on a throwaway database. Baseline that
  must hold: **48/48 + 8/8 + 4/4, all executed**. The harness now FAILS if
  fewer checks run than expected — never "fix" that by lowering the expectation.
- `npm test` — baselines move as agents land; always paste real counts.
- The packaged app is the thing he actually uses: test THAT, not only dev mode.
- A live agent turn spends his subscription. One verification turn per harness
  is acceptable and was pre-approved; keep prompts tiny.

## Never do again (learned the hard way today)
- Don't claim a capability without running it.
- Don't let a worker agent commit; the conductor commits after re-running the
  evidence itself.
- Don't pre-filter a design direction because you predict he'll dislike it — he
  chose the one I held back.
- Don't ask him something already answered; check this file and PARKING-LOT.md.
