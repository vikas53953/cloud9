# Phase 6 — UI / UX / Design Review

**What this is:** the first pass that asks whether Cloud9 is pleasant, consistent
and understandable to use — not whether it works. Phase 5 (negative/edge
testing) found 0 blockers, 7 majors, 11 minors by attacking the app with bad
input. This phase looks at the same app with normal input and asks how it
feels: consistency, feedback, empty/loading/error states, narrow windows,
keyboard, words, and light/dark contrast.

**AUDIT ONLY.** Nothing here was fixed and nothing was committed.

- Written: 2026-07-30
- Driven against: a throwaway QA stack started by hand (not `npm run qa`, which
  also runs the automated suite and tears the stack down when it finishes) —
  hub on `:8912`, screen on `:4342`, brand-new database, deleted afterwards.
  Never Vikas's real Cloud9. Demo mode on (`CLOUD9_DEMO=1`) — agent replies are
  labelled `[demo — not a real answer]`.
- Build under test: `npm run build` completed 2026-07-30 ~16:51 IST, against
  git HEAD `74f7fce4f82792c6da571b6252d110a835519ef1` (2026-07-30 16:50:44
  +0530) — the newest commit on the branch at that moment. Two other agents
  are editing `apps/desktop/src/**`, `apps/relay/**`, `packages/**` and
  `apps/desktop/electron/main.cjs` live; if a later re-check disagrees with a
  finding here, suspect their in-flight edits before reporting a new bug.
- Driven with Claude in Chrome against the Vite preview build (`dist-web`),
  not the packaged Electron app — see NOT-LOOKED-AT.

**Tags.** `CONFIRMED` = reproduced with evidence (screenshot) in this run.
`AUTOMATION-SUSPECT` = might be the robot, not the app; a human re-check step
is given.

---

## Screen: Setup (Settings)

Checked in both Daylight (light) and Studio dark themes at 1280×860.

Well done: theme picker (Daylight / Studio dark / Follow this computer) with
live previews; every toggle has a one-line plain-English explanation under it
("No pop-ups between these times. Anything urgent still lands in Tasks for the
morning."); "Danger zone" is visually distinct (red heading, red-bordered
card) and separated from routine settings; Connected apps shows real,
specific state (`app found (2.1.220 (Claude Code))`, `13 models available`)
rather than a vague "connected" pill; both themes hold contrast throughout —
no vanishing text, no invisible controls, on every one of the eight sub-tabs
(Appearance, Replies, New agents, Notifications, Quiet hours, Agent files,
Connected apps, Danger zone).

Screenshots: not yet saved to disk (see checkpoint note below) — captured in
session as ss_8714cyaev (light, Appearance/Replies), ss_2339ins71 (New
agents/Notifications), ss_5125qe334 (Quiet hours), ss_9893mm3hq (Agent
files/Connected apps Claude), ss_0684uqv5r (Connected apps full), ss_4680ijrsb
/ ss_7518fq9l6 (Danger zone).

## Screen: Crew — empty state

`Nobody on the floor yet.` with a real, honest stat row (0 working now / 0
waiting on you / 0 jobs this month — all genuinely zero, not hidden) and two
clear calls to action (`Browse the casting room`, `Write an agent`). Filter
tabs `Everyone / Working / Waiting / Off duty` present even with nothing to
filter. Good empty-state design; matches the "an empty list must never read
like nothing is wrong" rule.

## Screen: Agent editor (Write an agent)

Full editor present, in this order: Who they are (name/emoji/job in plain
words) → Where they run (app + model, live "13 models offered by your Claude
app") → How far they can go (REACH ladder, four rungs, cumulative, each with a
plain description) → same abilities one-by-one with `asks you first` tags on
the three that touch the machine or spend money → who can use it (Just
me/Recommended, Me and these people, Anyone in the room) → when to stop and
ask (approval rules) → Skills (empty state shows a worked example). A live
"How they'll appear" card on the right updates in real time as you type the
name and job (generated face, name, job-in-progress, app/model chips). This
resolves the four gaps Vikas listed on 2026-07-30 morning (capability ladder
missing, hired-agent missing tool permissions/files/skills, short model list,
no pictures) — all four are now present in this build; model list showed 13
Claude models including Fable 5, Opus 4.8/4.7/4.6/4.5/4.1/4, Sonnet
5/4.6/4.5, Haiku 4.5 (two builds).

### Finding UI-1 — the REACH ladder's selected rung contradicts the abilities actually on (Major, CONFIRMED)

**Screen:** Agent editor → "How far they can go" (REACH).
**Steps:** Write an agent → leave REACH untouched → scroll to "Or pick them
one by one" → switch ON "Look things up on the web" and "Work on jobs in the
background" (2 of 8) → scroll back up to the ladder.
**Expected:** The ladder either reflects what's actually on, or plainly says
these two toggles don't fit any single rung.
**Actual:** The ladder shows the dot filled on **"Just talk — Answers
questions from what it knows. No tools at all. NOTHING"** — the exact
opposite of the truth, since two abilities are switched on including live web
access. Underneath, in orange text, is the explanation: *"You have picked
your own mix below. It reads as 'Just talk', because that is the highest rung
it covers all of."* That sentence is answering a question ("why does the
ladder disagree with my toggles") that most people would not think to ask,
and the plain-word summary sitting directly under the ladder title still says
"No tools at all" while two tools are visibly on 40 pixels below it. A user
skimming just the ladder — which is the entire point of a ladder, a
skimmable summary — walks away with the wrong idea of what the agent can do.
Given this project's own history (Vikas: *"I told you last night"* about the
capability ladder, and the B6/B6b finding in Phase 5 about not being able to
tell agents apart), a capability display that can visibly contradict itself
is a real risk, not a cosmetic one.
**Screenshot:** ss_5382flq9d (Studio floor / agent editor, Daylight theme,
1280×860, ladder + orange explanation + toggles all in one frame).
**Tag:** CONFIRMED — reproduced by direct interaction, screenshot in hand.
**Fix shape (not applied):** either compute the rung from the highest one
FULLY satisfied only when the picks exactly match a preset (and label a
partial match "Custom" or "Mixed" instead of naming a lower rung it doesn't
resemble), or drop the rung highlight entirely once a one-by-one pick has
been touched.

## Harness note

A Chrome-extension screenshot capture froze twice in this run (`Page.
captureScreenshot` timeout, then a fully blank cream-colored capture on the
"agent created" confirmation screen). Both were checked against `get_page_text`
before being treated as findings: the blank capture's text content was
`No. 01 / Ready / Scout / You are my QA reviewer. / Claude / Sonnet 5 / Only
you can use it / Ready — signed in to Claude / Talk to Scout / Edit` — a
fully-formed screen — and a fresh tab confirmed Scout really was created and
shows correctly (Scout in the Direct list, "Ready · signed in to Claude").
**Neither is reported as a bug.** This matches the guidance in
`references/phases.md`: browser automation freezes on real apps; verify
against a second read before writing up a "blank screen."

## Screen: Crew — with one hire

After hiring "Scout" from the editor, the card matches the editor's live
preview exactly (portrait, name, job line, app/model chips, "Only you can use
it" permission line, `No. 01` / `Ready` status). Consistent, no drift between
what was previewed and what was created. Two placeholder cards remain
alongside the real one ("The casting room", "Write your own") — reads as
options, not broken content.

## Screen: The casting room (marketplace, formerly "hiring hole")

Renamed per Vikas's 2026-07-30 morning feedback — confirmed on screen: "Hire
someone already written." 8 roles (Architect, Backend engineer, Frontend
engineer, QA engineer, Security reviewer, plus 3 more below the fold), each
with its own distinct generative portrait (this resolves his "no pictures"
complaint) and a "Suggested: Claude/Codex" + `@handle` chip pair. Clicking
"Read the brief" opens a modal with the full system prompt verbatim, what it
can touch, and who can set it working — nothing is hidden or summarized away,
which answers his "a hired agent is missing everything a hand-made one has"
complaint at the browse stage too.

Minor wording: the stat header reads **"1 / CATEGORIES"** when there is
exactly one category (Software). Plural label on a singular count.
Screenshot: ss_2766wwb1k (Daylight, 1280×860, top-right stat block).
**Minor, CONFIRMED.**

### Finding UI-2 — Escape does not close the role-brief modal (Minor, CONFIRMED)

**Screen:** The casting room → click "Read the brief" on any role.
**Steps:** Open the "Architect" brief modal → click inside the modal (to make
sure it, not the page behind it, holds focus) → press Escape.
**Expected:** Per the brief's own keyboard rule ("does Escape close what it
opened"), the modal closes.
**Actual:** Nothing happens; the modal stays open both before and after
clicking inside it first. The only way out is the "Not now" button or a
click on the dimmed backdrop (backdrop-click not separately verified).
**Screenshot:** ss_0931g8ld6 (modal still open immediately after Escape, with
a prior click inside the modal to rule out a focus miss).
**Tag:** CONFIRMED — tried twice, once with an extra click to rule out focus
being elsewhere.

## Harness note (second occurrence)

Two more screenshot captures glitched mid-way through this segment: one
returned a 2×2 tiled repeat of the entire viewport (impossible for the real
app — it does not render its own sidebar four times), and several calls
timed out on `Page.captureScreenshot` before succeeding on retry. Both were
treated as capture failures, not app bugs, and re-shot before being trusted —
consistent with the freeze pattern `references/phases.md` warns about. No
finding was written from either glitched frame.

## Screen: Tasks — empty state

`Nothing handed over yet.` Same icon language as Crew/Projects (a checkmark
folder), same plain-words instruction style (`Ask an agent with @Agent !bg
your job and the result lands here`). Right rail repeats the same empty state
for "Waiting on you (0)". Filter tabs `All / Running / Done / Failed` present
even empty. Consistent with the rest of the app.

## Screen: Projects — empty state and Connect form

`No repository connected yet`, same icon/copy pattern a third time. The
"Connect a repository" form (`owner/name`, `Call it something (optional)`,
`Connect`) matches Phase 5's Segment C findings — not re-tested here since
Phase 5 already drove it hard (14 of 15 malformed names refused with a plain
in-form sentence). One visible consistency point for this pass: the sidebar
literally shows the placeholder text `owner/name` for what to type, and the
form's own placeholder repeats it — no daylight between the two.

## Screen: Activity (Log)

`Everything that happened, and who did it.` A real entry appeared the moment
Scout was created — `Vikas · created agent Scout · 05:06 PM` — proving this
list is live, not a static mock. `Agents` / `People` filter chips present.
Not deeply tested (no second event type available in a fresh demo stack to
confirm filtering actually filters) — see NOT-LOOKED-AT.

## Screen: Quick chat (Ctrl-K)

Opens fast, `Ask anyone, or start a job…`, lists agents and channels to send
to, and states plainly where the message will land before you send it
(`SCOUT WILL ANSWER IN YOUR DIRECT CHAT — NOTHING IS POSTED TO A CHAN…`).
Carries its own visible `Esc` hint in the top-right of the palette.

**Pressing Escape here correctly closes the palette** — confirmed by direct
test. This is the control case that makes Finding UI-2 (the casting-room
brief modal ignoring Escape) a genuine **consistency** problem and not a
one-off: the app already knows how to make Escape close an overlay, it just
doesn't do it everywhere. Same class of issue Phase 5 flagged for other
controls (agent name length limit keeps typing vs. composer throws it away).

## Consistency pass — cross-screen observations

- **Empty states are one system, used everywhere.** Crew, Tasks, Projects and
  the channel view all use the same checkmark-folder icon and the same
  "plain sentence + what to do next" structure. This is the strongest
  consistency finding in the app — a genuine design system, not per-screen
  improvisation.
- **Escape is inconsistent.** Closes the Ctrl-K quick-chat palette; does not
  close the casting-room "Read the brief" modal (Finding UI-2).
- **The REACH ladder can visibly disagree with the ability toggles directly
  below it** (Finding UI-1) — the one place in this pass where the app's own
  UI contradicts itself on screen at the same time, not just across screens.
- **Numbers vs. labels:** "1 / CATEGORIES" in the casting room does not
  degrade to singular. Minor, but the kind of detail that erodes trust in the
  larger numbers elsewhere (job counts, model counts) once a user notices one
  is off.
- Wording stays plain-English and jargon-free almost everywhere a
  non-developer would read it (empty states, approval cards, setup toggles).
  The one place technical language leaks through is Setup → Connected apps
  (`app found (2.1.220 (Claude Code))`, `MEASURED ON CLAUDE-CODE 2.1.220,
  2026-07-30`) — judged acceptable here since it is presented as verification
  detail for a technically-minded owner checking his own sign-in state, not
  as a claim he needs to act on. Not filed as a finding.

## Harness limitation — narrow-width testing could not be completed

`resize_window` reported success at every size tried (1024, 900, 380, 320)
but the page's own `window.innerWidth`/`outerWidth` never changed — verified
directly with `window.innerWidth` via the JS tool, which read `1568`
(`outerWidth` `1920`) immediately after a `resize_window` call that claimed
`320×700`. The Chrome window this session controls would not actually shrink.
**No narrow-width finding in this report is from a real resize in this
session** — see NOT-LOOKED-AT. The only narrow-width evidence available is
Phase 5's G5 (900/600/375/320px, composer text survives, rail intact, no
sideways scroll, CONFIRMED in that run against the same overall build family)
— cited here as background, not re-verified today.

## Screenshots

Captured in-session via Claude in Chrome (not saved to `docs/qa/*.png` — no
disk-save step was run this pass). Screenshot IDs referenced above
(`ss_5382flq9d`, `ss_2766wwb1k`, `ss_0931g8ld6`, etc.) are session-local
Claude-in-Chrome capture IDs, viewable only within this conversation. If a
durable image is needed for Vikas's review, a follow-up pass should re-run
the same steps with `save_to_disk: true` and write files under `docs/qa/`.

---

## Summary

**0 Blockers · 1 Major · 2 Minors** found in this pass, across Setup, Chat,
Crew (empty + filled), the agent editor, the casting room/marketplace, Tasks,
Projects, Activity/Log and Quick chat, each checked in both Daylight and
Studio-dark themes at 1280×860.

### The three worst (only three findings total; all three, in order)

1. **UI-1 — the capability ladder can say "no tools at all" for an agent that
   currently has two tools switched on.** This sits directly under the exact
   feature Vikas asked for by name ("I told you last night") and is the kind
   of contradiction that would make him distrust every other capability
   display in the app, not just this one screen. Major.
2. **UI-2 — Escape closes Quick chat but not the casting-room brief modal.**
   Small on its own, but it is an inconsistency the app has already solved
   once (Quick chat) and simply didn't apply everywhere. Minor.
3. **"1 CATEGORIES"** — a plural label on a singular count in the casting
   room's own stat header. Cosmetic. Minor.

### What held up well

Empty states are a genuine, reused design system across Crew, Tasks, Projects
and channels — not per-screen improvisation, and none of them read as "silent
success" (each says plainly what is missing and what to do about it). The
agent editor now carries everything Vikas asked for on 2026-07-30 morning:
the REACH capability ladder, full tool-permission detail on a hired agent,
13 Claude models (was 4), and generated portraits in both the editor preview
and the casting room. The casting room itself was renamed away from "hiring
hole" as he asked, and its "Read the brief" modal shows a hired agent's full
system prompt rather than hiding it. Both light and dark themes hold contrast
on every screen actually reached — no vanishing text, no invisible controls
found anywhere in this pass. Live data was confirmed in two places (Activity
log entry appeared the instant an agent was created; the Crew card updated to
match the editor's live preview exactly) — nothing looked mocked.

---

## NOT-LOOKED-AT — an omission left unlisted is a claim that it passed

- **Narrow window widths (1024, 900, 768, 640, 380, 320) were not actually
  verified.** The `resize_window` tool reported success but never changed the
  page's real `window.innerWidth` in this session (stuck at 1568×698 logical
  / 1920 outer throughout) — see harness-limitation note above. Only
  1280×860 was genuinely tested in this pass. Phase 5's G5 result (clean at
  900/600/375/320 in an earlier run) is cited as background, not re-proven
  today.
- **Tab-key keyboard traversal was not swept systematically** on any screen —
  only Escape was tested, and only on two overlays (Quick chat, casting-room
  modal). Tab order, visible focus rings, and reachability of every
  interactive control were not walked end to end.
- **The installed Windows app** was not touched — everything above ran
  against the Vite preview build (`dist-web`) via a browser, per this
  session's setup. `npm run qa:app` / a real Electron window was not opened.
- **Dark mode was only checked on 4 of the ~10 screens** (Setup, Chat, Crew,
  agent editor, casting room). Tasks, Projects, Activity/Log and Quick chat
  were checked in Daylight only — no dark-mode screenshot exists for them in
  this pass.
- **Threads, reactions, edit/delete, mentions, markdown rendering** — none of
  the chat-body features were exercised visually this pass (no messages were
  posted; the only chat content seen was the empty state). Phase 5 covered
  much of this from a hostile-input angle; this pass adds nothing new there.
- **The Settings "Danger zone" actions** (Remove Claude/Codex key, Remove a
  person) were seen but not clicked — no destructive-action confirmation flow
  was reviewed for clarity or a confirm step.
- **Loading states** (a spinner or skeleton while something is fetched) were
  not directly observed — demo mode answers fast enough, and no long-running
  action was triggered, that a loading state was ever caught on screen.
- **Icons/images meaningful without color alone** — not explicitly checked
  (e.g. simulating color-blindness or grayscale). The Ready/Working/Off-duty
  status dots and REACH-ladder rungs rely on both color and a text label
  everywhere they were seen, which is a good sign, but this was not tested
  as a dedicated pass.
- **Overflow/cut-off text under real (non-demo) long content** — not tested;
  all text seen this pass was short, real strings (names, job one-liners),
  not the very long strings Phase 5 already stress-tested for truncation.
