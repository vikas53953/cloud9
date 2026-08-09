# HANDOFF — Chat the Slack/Buzz way (left panel + chat experience)

**Written:** 2026-08-08 · **Branch:** `feature/chat-look-feel` @ `1024ffb` (committed, build clean, NOT pushed, NOT merged, NOT reviewed)
**Picking this up? Read this file, then the plan page, then TRACKER.md row 25. Nothing else is needed.**

## The ask, in his words

1. *"work on frontend layout and chat experience of cloud9 — improve it and make it like slack or Buzz"*
2. *"and the feature we added on left panel arrange/group those in neat and clean format so that it looks clean and professional like slack"*
3. *"keep on building and follow the process cum pipeline which we following"*

## What he approved (all 👍, 2026-08-08)

The plan page is `docs/gates/chat-experience-plan-2026-08-08.html` (committed on the branch). Nine changes:

| # | Change | Status on the branch |
|---|---|---|
| L1 | Round faces in conversation (`.avatar` contexts); crew/casting plates stay square | **DONE** (`styles.css`, `.avatar .portrait` / `.avatar .initialplate` → 50%) |
| L2 | Hover tools pinned to the message's top-right + whole-row hover tint (halo via box-shadow, zero layout shift) | **DONE** (`styles.css` `.msg:hover`, `.msgactions` z-index 22) |
| L3 | Slimmer room header; "Room details" is now a quiet ⓘ icon button (aria-label unchanged — checks and screen readers still find it); "Add someone…" select is quiet until hovered | **DONE** (`App.tsx` ChatView header, `styles.css` `.chathead`, `.iconbtn`) |
| L4 | Day markers as centred pills (Buzz shape, Studio palette); the "New" separator is untouched | **DONE** (`styles.css` `.daymark`) |
| L5 | Sidebar agent rows: dot + ONE word; the full sentence stays one hover away (row tip, same owner `presenceSays`) | **DONE** (`App.tsx` sidebar `.an-state`) |
| F1 | Composer one calm row: ＋ · 📎 · 🙂 · Aa · Send. Bold/italic/code one click deep behind Aa (still in DOM). "Delegate as a job" button removed — it is the `!bg` row in the ＋ menu, same line | **DONE** (`App.tsx` Composer, `styles.css` `.emojihold`/`.fmtset`) |
| F2 | Faces of up to 3 repliers on the "↳ N replies" line | **DONE end to end**: `replyFaces?: ID[]` on the shared `Message` type; `store.bumpReplyCount(rootId, at, authorId)` keeps newest-first 3; `server.ts` passes `message.authorId`; `MessageRow` draws the stack (`.tl-faces`). NOTE: faces appear on replies written AFTER this build; old threads have counts but no faces — deliberate, honest degradation |
| F3 | Emoji trays learn manners: Escape via the one stack (`useEscapeCloses`), click-away via ONE new hook `useClickAwayCloses` (module scope, next to the stack). Wired for BOTH the composer tray and the message reaction tray | **DONE** (`App.tsx`) |
| F4 | Empty room shows two inviting cards instead of a paragraph | **NOT STARTED** |

Plus the late addition, NOT in the plan page:

| # | Change | Status |
|---|---|---|
| G1 | **Left rail grouping** — 18 rail buttons are a flat strip (`App.tsx` ~3000-3047: chat, crew, tasks, workflows, files, projects, forums, huddles, pulse, polls, canvas, updates, hooks, social, spending, activity, notifications, saved). Group them with small section labels, Slack/Buzz-neat | **NOT STARTED** — suggested groups: **Talk** (Chat, Notifications, Saved) · **Crew** (Crew, Team feed, Huddles) · **Work** (Tasks, Workflows, Files, Projects, Decision threads, Pulse, Polls, Canvas, Public updates) · **Running the studio** (Hooks, Spending, Activity). Bottom row (Ctrl-K, Settings, hub switch, lamp) stays as-is. Watch total height — 18 buttons + 4 labels may overflow short windows; `.rail` will need `overflow-y:auto` |

## TRAPS the next builder must not step in

1. **Two qa.mjs checks WILL FAIL until updated to the new UX** (they assert the old shapes):
   - `scripts/qa.mjs` ~line 2038-2047 — the thread-box tools parity check reads every `.tools button.mini` title and requires `NAMED_TOOLS = ["Bold","Italic","Code","Hand this over as background work"]`. Bold/Italic/Code still pass (buttons stay in the DOM behind Aa). **"Hand this over as background work" is GONE from the row** — update the named list and add an assertion that the ＋ menu offers the `!bg` row (`data-command="!bg"`), which is the same capability one click deeper. Keep the room-vs-thread parity assertion exactly as strong.
   - `scripts/qa.mjs` ~line 3830-3832 — "and it says WHY, in a plain sentence" reads `.an-state` innerText, which no longer carries the reason (L5). The sentence now lives in the row button's `title` (`says.title`). Update the check to read the title. The one-fact-one-place rule still holds (`presenceSays` is still the only owner).
   - When adding checks, bump the harness's expected-checks count (it fails if fewer run than expected — never lower it).
2. **Add new checks for the new behaviour** (house rule: prove it can fail, break it once, watch it fail, restore): emoji tray closes on Escape AND on click-away · faces on the reply line (`.threadline .tl-faces`) · round faces (`.avatar .portrait` computed border-radius 50%).
3. **Master is RED in 6 places BEFORE this branch** (control established 2026-08-08, none of it ours):
   - `packages/engine/dist/timebudget.test.js` + `turnleash.test.js` — STALE compiled test files; their sources were deleted by PR #13 and `tsc` never cleans `dist`. Phantom failures. Class fix (not done): clean dist before build, or delete the two files by hand.
   - `writeoutcome.test.js` ×2 — REAL: `packages/engine/src/engine.ts:520` writes `late-approval-warnings.json` and ignores the outcome, no justification comment. Real rule violation on master.
   - `apps/relay/dist/projects.test.js` ×2 — REAL: "only the engine reports what GitHub said" (expected 'main', got undefined) and "while a look is under way the hub SAYS so". Need diagnosis.
   - Do NOT let anyone blame this branch for these; re-run and compare counts.
4. **Reply keeps its word.** L2's strip is icons except the Reply button — the word "Reply" is deliberate (an earlier finding: an unlabelled ↳ icon was a door nobody found). Do not icon-ify it.
5. **`useEscapeCloses` deliberately excludes** the find bar and side panels (comment at App.tsx ~591). The emoji trays were wired through it anyway because they are popovers that float over content — if a reviewer questions the scope, that is the reasoning; the click-away hook is new and named `useClickAwayCloses`.
6. **Never rewrite `App.tsx` wholesale** (16k lines, machine-conditions law). Targeted edits only.

## The process laws that govern finishing this (TRACKER.md §2-§4, non-negotiable)

- **A different agent reviews.** The author never reviews or merges their own branch. Reviewer verdicts: Blockers / Out of scope / Agree. Max 2 reject rounds, then escalate to Vikas.
- **Evidence chain, in order:** `npm run build` → `npm test` (expect the 6 pre-existing reds above, no NEW reds) → `npm run qa` (browser suite) → `npm run dist` → `scripts/install-cloud9.ps1` → `npm run qa:app` (walks the REAL installed app). ONE build/package/install/walk at a time on this machine.
- **Visual changes need before/after screenshots from the INSTALLED app at his window size.** Before shots exist: `docs/qa/app-09-chat.png`, `app-11-composer-enter-lands.png`, `app-22-thread-agent-answer.png` (7 Aug). Take matching afters.
- **A green build is not evidence. A feature is done when he can SEE it and USE it.**
- Plain words everywhere; date-stamp every status claim; TRACKER.md row 25 gets updated with the evidence.

## References (verified vs not)

- **Buzz** — verified, installed on this machine; dated captures `docs/qa/buzz-*-2026-08-07.jpg` (home/inbox, #coding, agents, projects, pulse, workflows). THE visual model for this work.
- **Cloud9 before-state** — `docs/qa/app-09/10/11/22` (installed app, 7 Aug).
- **Slack** — NOT VERIFIED. His Chrome was not started with a remote-debug port, so Slack-in-his-browser could not be read (agent-browser got `about:blank`); slack.com/help rate-limited (429) once. If he still wants Slack-specific ideas, relaunch his Chrome with `--remote-debugging-port=9222` (ask him first — it restarts his browser) or walk slack.com/help slowly.
- **Design law** is still Studio (`docs/mocks/p3-studio.html`) — this round adopts Slack/Buzz ergonomics, NOT their skin. Do not reskin.

## What "done" looks like for the handoff back to him

A review page (visual HTML, feedback layer inlined from `~/.claude/review-kit/feedback-layer.js`, `data-fb` blocks per change) with before/after screenshots of every changed surface, the real test/QA/walk counts, and anything NOT claimed said out loud.
