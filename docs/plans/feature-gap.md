# Feature gap — what Cloud9 is missing, and what to build next

**Date:** 2026-07-29
**Why this exists:** Vikas said *"all of the features which we have in buzz, i really want
those features"* and *"also do add the feature of slack and buzz, whatever features we have"*.
This file stops us guessing. It lists what Cloud9 actually has today, what a chat app
of this kind is expected to have, what Buzz actually has, and a ranked list of what to
build — so he can pick.

**How this was checked:** by reading the code, not the docs. Read-only; nothing was changed.
Snapshot: commit `c74c959`, clean working tree, `npm run build` passes.

---

## 0. The short answer

Cloud9 is a working group chat with agents in it. You can talk in channels and DMs,
build agents, hand them jobs, approve those jobs, and read a log of what happened.

But it is missing almost every ordinary chat feature that a person expects without
thinking about it. **You cannot react to a message, reply in a thread, edit a message,
delete a message, send a file or a picture, or search anything older than the last 50
messages.** The composer has Bold, Italic and Code buttons that put `**stars**` into
the text — and then the message list prints the stars, because nothing renders
formatting. That single detail is the honest summary of where the app is: it looks like
a real chat app and does not yet behave like one.

**About the spec.** Vikas believes these features are already in the spec. He is half
right, and the half that is wrong matters. Threads, reactions, attachments, editing,
deletion and mentions are all named in the spec — in **FR-CM-009** — but that line has
priority **`TBD`**, and spec rule 5 says *"do not silently replace a TBD with a
default."* Search is the same (FR-AU-005, TBD). So the spec has written these down as
**open questions, not as approved requirements**. Nobody can build them until he says
"yes, build these" — and the cleanest first move is for him to answer spec §25.6
(Communication) so the spec stops blocking its own features.

**About Buzz.** Buzz is real and it is the same idea as Cloud9. It is **Block, Inc.'s**
open-source workspace (github.com/block/buzz), launched around 21–22 July 2026: a
desktop app where you sign in with Claude Code or Codex, create a community, open a
channel, and add agents like people. It already ships channels, **threads**, DMs,
**full-text search**, canvases, media, an audit log, and agent membership. So the
features he wants from Buzz are, mostly, exactly the ordinary chat features listed
above — plus threads and real search.

---

## 1. What Cloud9 actually has today

Checked in `packages/shared/src/index.ts` (the shared dictionary),
`apps/relay/src/server.ts` + `store.ts` (the hub and the filing cabinet),
`apps/desktop/src/App.tsx` (the whole screen), `apps/desktop/electron/main.cjs` (the menu).

**Conversations**
- Channels with a member list, and direct conversations between two people or between
  you and an agent. A DM is found-or-created, never duplicated.
- One message type: sender, text, timestamp, and a list of who was @mentioned.
  Nothing else. (`Message` in `packages/shared/src/index.ts`)
- @mention autocomplete in the composer, with arrow keys and Tab.
- Day separators, a "New" line where you last read, and grouping of a person's
  consecutive messages.
- Unread counts per conversation in the sidebar — **stored in this browser only**
  (`localStorage`, `cloud9.lastRead`). Read on your laptop, still unread on the next machine.
- A "someone is working" line at the bottom — but it is only for **agents mid-job**.
  There is no human typing indicator.
- Copy-a-message and reply-by-mention buttons on hover.

**Agents**
- Create, edit, pause/disable, delete. Name, emoji, personality, four ability
  switches (web search, files, schedules, background work).
- Pick the app (Claude or Codex) and the model per agent.
- Plain-words "skills" per agent, with optional files.
- Approvals: an agent can be made to ask before starting background work or before
  making a schedule.
- A "Crew" screen listing every agent, filterable by working / off.

**Work**
- `!bg` / `!task` in chat hands a job over. Jobs have eight states, live in a Tasks
  panel, and can be cancelled.
- An Activity log: who did what, when — messages, task changes, approvals, agent and
  channel changes, invites.

**The app around it**
- Invite codes to bring a friend in; the owner can remove someone.
- Settings with six sections: appearance, default app+model, notifications, quiet
  hours, agent files folder, danger zone.
- Desktop pop-up notifications, honouring quiet hours. Preferences are per-machine.
- A real Electron menu (File / Edit / View / Help) with shortcuts, and Ctrl+K quick chat.
- Light / dark theme.

---

## 2. The Slack baseline — what people assume exists

Sourced from Slack's own help centre. Everything in this table is on Slack's **free**
tier, i.e. it is what a brand-new workspace gets on day one — these are interaction
basics, not premium extras ([Slack Free plan](https://slack.com/pricing/free)).

| What people expect | Cloud9 today | Evidence in our code |
|---|---|---|
| [Threads / reply to a message](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions-) | **MISSING** | No `parentId`/`threadId` anywhere. `Message` has no reply field. The ↩ button just types `@name` into the box. |
| [Emoji reactions](https://slack.com/help/articles/202931348-Use-emoji-and-reactions) | **MISSING** | The word "reaction" does not appear in the relay, the store or the shared types. |
| [Edit a sent message](https://slack.com/help/articles/202395258-Edit-or-delete-messages) | **MISSING** | No `editMessage` frame; no `editedAt` field. |
| [Delete a sent message](https://slack.com/help/articles/202395258-Edit-or-delete-messages) | **MISSING** | No `deleteMessage` frame. A typo is permanent. |
| [File and image attachments](https://slack.com/help/articles/201330736-Add-files-to-Slack) | **MISSING** | No upload path, no attach button in the composer, no file storage. Text only. Vikas asked for an attach button in feedback round 1 ("a genuine composer — formatting row, attach, emoji"); the formatting row and emoji were built, attach was not. |
| [Search across history, with `in:` / `from:` filters](https://slack.com/help/articles/202528808-Search-in-Slack) | **PARTIAL — and weaker than it looks** | Ctrl+F filters the **current conversation** only, and only the messages already loaded. The client is only ever given the **last 50 messages per channel** (`store.ts:recentMessages`, `perChannel = 50`) and never asks for more — the `history` frame exists on the wire but no client calls it. So there is no scrollback and nothing older than 50 messages can be found at all. |
| [Unread badges and mention badges](https://slack.com/help/articles/226410907-View-all-your-unread-messages) | **PARTIAL** | Counts and a "New" line exist. But it is per-machine, there is no separate *mention* badge, no "mark as unread", and no jump-to-unread. |
| [Pin a message to a channel](https://slack.com/help/articles/205239997-Pin-messages-and-bookmark-links) | **MISSING** | — |
| [Save a message for later](https://slack.com/help/articles/360042650274-Save-messages-and-files-for-later) | **MISSING** | — |
| [Channel topic and description](https://slack.com/help/articles/201654083-Set-a-conversation-topic-or-channel-description) | **MISSING** | `Channel` has `name`, `kind`, `memberIds`, `createdAt`. Nothing to say what a room is for. |
| [Public vs private channels; browse and join](https://slack.com/help/articles/360017938993-What-is-a-channel) | **MISSING** | Every channel is effectively private: `visibleChannels()` shows you only rooms you are already in. There is no channel directory, no join, no leave, no archive. |
| [Drafts list](https://slack.com/help/articles/201457107-Send-and-read-messages) | **MISSING** | Half-typed text is lost when you switch conversation. |
| [Link previews](https://slack.com/help/articles/360001502048-Manage-link-previews) | **MISSING** | A pasted URL is not even clickable — message text is rendered as plain text with only @names highlighted (`MessageRow` in `App.tsx`). |
| [Typing indicator](https://slack.com/help/articles/213893898-Change-how-messages-are-displayed) | **PARTIAL** | "Agent X is working on it" exists. Humans typing: nothing. |
| Read state / last-read marker | **PRESENT (and Slack has no more)** | Our "New" line matches Slack. Worth knowing: **Slack deliberately has no read receipts** — no "seen by". So "read state" is done, unless he specifically wants WhatsApp-style ticks, which would be a deliberate choice *beyond* the baseline. |
| [Per-channel notification settings; mute](https://slack.com/help/articles/360056534254-Manage-notifications-for-specific-channels-and-direct-messages) | **MISSING** | Notifications are one global on/off plus quiet hours. You cannot mute one noisy channel. |
| [Keyword alerts](https://slack.com/help/articles/201355156-Configure-your-Slack-notifications) | **MISSING** | — |
| [Profiles, avatar, custom status](https://slack.com/help/articles/204092246-Edit-your-profile) | **PARTIAL** | A person is `{ id, name, invitedBy }`. Generated face-drawings stand in for avatars. No photo, no title, no status, no away state, no profile card. |
| [Keyboard shortcuts](https://slack.com/help/articles/201374536-Slack-keyboard-shortcuts) | **PARTIAL** | Ctrl+K quick chat, Ctrl+F find, Ctrl+, settings, and the menu accelerators exist. Missing the ones people lean on: jump to first unread, edit last message, open the shortcut list. |
| [Emoji picker](https://slack.com/help/articles/206870177-Add-custom-emoji-and-aliases-to-your-workspace) | **PARTIAL** | 16 hard-coded emoji in a small pop-up. No full picker, no search, no custom emoji. |
| [Message formatting / markdown](https://slack.com/help/articles/202288908-Format-your-messages) | **BROKEN — worse than missing** | The composer's B / I / `</>` buttons insert `**`, `_` and backticks, and the message view **renders none of it**. So using the formatting buttons makes your message look worse. This is the most visible single defect in the app. |
| [@user mentions](https://slack.com/help/articles/205240127-Use-mentions-in-Slack) | **PRESENT** | Autocomplete, highlighting, and mentions drive which agent replies. |
| [@channel / @here](https://slack.com/help/articles/202009646-Notify-a-channel-or-workspace) | **MISSING** | — |
| [#channel links](https://slack.com/help/articles/205240127-Use-mentions-in-Slack) | **MISSING** | — |
| [Scheduled send](https://slack.com/help/articles/1500012915082-Schedule-messages-to-send-later) | **PARTIAL** | Agents can be given schedules. A person cannot schedule their own message. |
| [Reminders](https://slack.com/help/articles/208423427-Set-a-reminder) | **MISSING** | — |
| [Huddles / voice](https://slack.com/help/articles/4402059015315-Use-huddles-in-Slack) | **MISSING** | Spec §14 explicitly puts voice and video **outside** the platform unless approved later. Not recommended. |

---

## 3. Buzz — what it factually is

**FACT.** Buzz is an open-source workspace from **Block, Inc.**, public around
21–22 July 2026. Source: [github.com/block/buzz](https://github.com/block/buzz),
[Product Hunt](https://www.producthunt.com/products/buzz-3),
[TechTimes coverage](https://www.techtimes.com/articles/321242/20260722/block-launches-buzz-open-source-workspace-where-ai-agents-sign-their-own-work.htm).
Nothing on this machine was opened or inspected — this is public sources only.

> **CORRECTED 2026-07-29** after reading Buzz's source (`docs/plans/buzz-teardown.md`):
> there are TWO sign-ins in Buzz and they are easy to conflate. The **human** does
> not sign in at all — no account, no password, no OAuth; you are a keypair made
> silently on first run, and you join a workspace by invite code or by an admin
> adding your key. The "sign in with Claude" button is the **agent's** sign-in:
> it runs `claude auth login` through the adapter and **captures no token** — the
> credential stays inside Claude Code. That is precisely what Cloud9 does today,
> so we already match Buzz on the thing Vikas asked us to copy. Where Buzz is
> genuinely ahead of us is the HUMAN side: real invites with expiry and use
> caps, roles, and per-connection authentication.

**FACT — the onboarding Vikas described is exactly right.** Download the desktop app,
sign in with Claude Code or Codex, create a community, open a channel, add agents,
tag an agent, give it a task, review the output. The repo states onboarding
"currently surfaces only Claude Code and Codex."

**FACT — what Buzz ships today**, quoted from its own README:
- Channels, **threads**, and direct messages
- **Canvases** (shared visual/text workspaces)
- **Media with frame-anchored comments** (comments pinned to a video frame)
- **Full-text search** across conversations, patches, workflow runs and approvals
- **Audit log** — a complete signed event history
- Desktop app for macOS, Linux and Windows (Tauri + React)
- **Agent membership** — add an agent to a channel like a teammate, with its own
  cryptographic key and its own audit trail ("agents sign their own work")
- **YAML workflows** — automation triggered by messages, reactions, schedules or webhooks
- **Git integration and self-hosted Git hosting** — branches become channels, with
  patches and review comments beside the discussion
- `buzz-cli` — an agent-first command tool
- Three agent apps supported: **Claude Code, Codex, and Goose** (Block's own)

**FACT — what Buzz has NOT finished** (also from its README): mobile clients,
**workflow approval gates** (built but not wired up), huddle lifecycle events, push
notifications, web-of-trust reputation. Its own README says "not finished."

**UNKNOWN.** Which of these Vikas has actually used, which he liked, and whether his
"whatever features we have" means the chat basics or the Git/canvas parts. Also
unknown: exact version he has installed. **This is the single most useful thing he
could tell us**, and it is one question, below.

**What this means for us.** Cloud9 and Buzz are the same product idea. Buzz's
advantage today is not agents — it is that it is a **complete chat app underneath**
the agents: threads, search, media, canvases. Cloud9 has the agent half and is missing
the chat half. Notably, Cloud9 is **ahead** of Buzz on one thing: our approvals
actually work, and Buzz's do not yet.

Two Buzz features are worth flagging as deliberately *not* recommended for Cloud9:
the Git forge (that is a different product for a different user) and canvases
(large, and not what a network engineer chatting with friends needs first).

---

## 4. What the spec actually says about each gap

This is the honest cross-reference. Spec rule 4: *treat every `TBD` as unresolved.*
Rule 5: *do not silently replace a `TBD` with a default.*

| Gap | Spec requirement | Its state |
|---|---|---|
| Threads | **FR-CM-009** | Named. Priority `TBD`. Also listed as an open decision in **§25.6**. |
| Reactions | **FR-CM-009** | Named. Priority `TBD`. |
| Attachments | **FR-CM-009**, **§25.6** | Named. Priority `TBD`. |
| Edit a message | **FR-CM-009**, **§25.6** | Named. Priority `TBD`. |
| Delete a message | **FR-CM-009**, **§25.6** | Named. Priority `TBD`. |
| Mentions | **FR-CM-009** | Named as `TBD`, but **already built** — FR-CM-004 (P0) required it anyway. |
| Search | **FR-AU-005** ("export, retention, immutability, **search**"), **§25.6** | Named. Priority `TBD`. |
| Unread / mention badges | **Spec is silent.** Closest is FR-NT-003 (notification channels and preferences, `TBD`). |
| Markdown rendering | **Spec is silent.** No requirement mentions formatting at all. |
| Link previews | **Spec is silent.** |
| Pin / save for later | **Spec is silent.** |
| Channel topic / description | **Spec is silent.** §9.4 only requires that direct and shared conversations exist. |
| Public vs private channels, browse/join | **FR-UW-004** (membership management, `TBD`), **§19** permission layers. Also **§25.6** "channel model". |
| Drafts | **Spec is silent.** |
| Typing indicator (humans) | **§25.6** "Presence" — open decision. |
| Read receipts | **§25.6** "Read receipts" — open decision. Slack has none; recommend we match Slack and close this as "not doing it". |
| Per-channel notification settings, mute | **FR-NT-003 / FR-NT-004** — both `TBD`. |
| Profiles, avatar, status | **§9.1** lists "profile" as a User concern requiring later definition. `TBD`. |
| Keyboard shortcuts | **Spec is silent.** |
| Voice / huddles | **FR-CM-010** `TBD`, and **§14** explicitly excludes voice and video unless later approved. |

The existing coverage audit (`docs/plans/spec-coverage-2026-07-29.md`) marks
FR-CM-009 and FR-CM-010 as **BLOCKED-TBD** with a blank "what's missing" column — it
did not itemise them, which is why this file exists.

### The one decision that unblocks nearly all of it

Almost every row above is blocked by the same thing: **spec §25.6 (Communication) has
never been answered.** One "yes, build the chat basics" from Vikas turns FR-CM-009 and
FR-AU-005 from `TBD` into approved P0/P1 work, and the spec should then be updated to
say so (spec rule 15). Without that, an agent building threads is inventing a
requirement — which spec rule 1 forbids.

---

## 5. What to build — ranked

Ranked by how much it changes the daily feel of using Cloud9 with a few friends and a
crew of agents. Sizes are rough: **small** ≈ under a day, **medium** ≈ a few days,
**large** ≈ a week or more.

### (a) Small wins — the ones that make it feel like a real chat app

**1. Render the formatting people are already typing** — *small*
Bold, italic, code, code blocks, quotes, bullet lists, and clickable links in the
message view. **This is a bug as much as a feature**: the app already has the buttons,
they already insert the marks, and the marks are printed raw. Agents also write in
markdown, so today every agent answer with a list or a code block reads as clutter.
Closes: spec is silent — this is quality, not a requirement.
Decide first: nothing. This one needs no permission from anybody.
**Highest value per hour of any item on this page.**

**2. Reactions** — *small*
👍 on a message without writing a reply. New table, one new frame each way, a hover
button, a row of pills under the message. Also the cheapest way to tell an agent
"good answer" without spending a turn.
Closes: part of **FR-CM-009**.
Decide first: nothing beyond the §25.6 yes.

**3. Edit and delete your own message** — *small*
Fix a typo; take back a message sent to the wrong room. Keep it honest: show
"edited", and leave a "message deleted" tombstone so the Activity log and any agent
that already read it are not lying. Only the author can do either.
Closes: part of **FR-CM-009**.
Decide first: whether a deleted message disappears from the Activity log too. Recommend
**no** — the audit trail is a spec promise (FR-AU-003) and should not be editable.

**4. Real search, and scrollback** — *medium (and it is two things)*
Today nothing older than the last 50 messages exists on your screen, so "search" cannot
find it. This needs (i) the client to actually ask for older messages when you scroll
up — the `history` frame is already built on the relay and simply never called — and
(ii) a real search across all conversations you are allowed to see, with `in:` and
`from:` filters. SQLite full-text search is a natural fit and the store is already SQLite.
Closes: part of **FR-AU-005**. Matches Buzz's full-text search.
Decide first: nothing technical. Note that scrollback alone is a **half-day fix** and
should be done immediately whatever happens to search.

**5. Unread and mention badges that actually work** — *small*
Move the last-read mark from this-browser storage to the relay so it follows you
between machines; add a separate red badge for "someone @mentioned you"; add
jump-to-first-unread.
Closes: strengthens **FR-NT-003**; spec is otherwise silent.
Decide first: nothing.

**6. Files and images** — *medium*
Drag a file in, paste a screenshot, see it in the conversation. This is the one Vikas
explicitly asked for in feedback round 1 and did not get. For a network engineer this
is the difference between describing an error and pasting the screenshot of it.
Closes: part of **FR-CM-009**.
Decide first: **two real questions.** (i) Where do files live — beside the relay's
SQLite on his PC? (ii) Can an agent *read* an attached file, and does that need
approval? That second one touches FR-AG-006 and FR-TS-006 and must not be answered by
guessing. Recommend shipping human-to-human attachments first, agent-reads-file second.

### (b) Medium — the next layer of "this is a proper workspace"

**7. Threads** — *medium-large*
Replies hang off a message instead of filling the room. This matters more in Cloud9
than in Slack: when three agents answer one question in a busy channel, the room
becomes unreadable. Buzz has this. It touches the message model, the relay, the whole
message list, unread counts, and how the engine decides what context an agent sees.
Closes: part of **FR-CM-009**; helps **FR-ME-001** (an agent could be given the thread
rather than the last 20 lines).
Decide first: does an agent replying to a job post in the thread or in the channel?
Recommend **thread, with the final result also posted to the channel**.

**8. Channel topic, description, and public vs private** — *medium*
Say what a room is for. Let a channel be browsable and joinable rather than
invite-only. Add leave and archive.
Closes: **FR-UW-004**; part of **§25.6** "channel model"; touches **§19**.
Decide first: **is Cloud9 one shared space forever, or many spaces?** (This is
question Q6 already on the coverage audit's list.) Building public channels before
answering it risks building the wrong shape twice.

**9. Per-channel notification settings and mute** — *small-medium*
Mute the noisy channel; get pop-ups only for mentions in another. Today it is one
global switch, so the only way to stop the noise is to stop all of it.
Closes: **FR-NT-003**, **FR-NT-004**.
Decide first: nothing. Should ride along with moving preferences off this-browser
storage onto the account, which item 5 already requires.

**10. Pin, and save for later** — *small*
Pin the important message to the top of a room; save one for yourself. Cheap, and
directly useful for "the agent's answer I need again on Thursday".
Closes: spec is silent.
Decide first: nothing.

**11. Profiles and status** — *small-medium*
A real photo, a line about who you are, and an away/status marker. Cloud9 draws faces
today, which looks good but tells you nothing.
Closes: part of **§9.1**.
Decide first: nothing. Low urgency with four friends; grows with the group.

**12. Drafts, human typing indicators, link previews, full emoji picker,
@here, #channel links, scheduled send, reminders** — *small each*
The remaining polish. None of them changes the day; all of them are noticed when
absent. Worth doing as one clean-up pass after the items above, not before.
Closes: bits of **FR-CM-009**, **§25.6** "presence"; mostly spec-silent.

### (c) Large / structural — real, but not "chat features"

**13. Show what an agent actually did during a job** — *medium-large*
Already ranked #1 in the existing coverage audit (its Chunk 2), and it stays there.
Both Claude and Codex already stream a structured record of every step and Cloud9
throws all of it away except the last sentence. This is Buzz's "signed audit trail"
equivalent, and it is what turns "the agent says it did it" into "here is what it did".
Closes: **FR-TL-003**, **FR-AU-003**, **FR-TS-008**.
Not a chat feature — but if Vikas is choosing between this and threads, **this is worth
more**, because it is the thing the product promises and does not deliver.

**14. One real outside tool, behind a proper adapter** — *large*
Unchanged from the coverage audit (its Chunk 3). Blocked on him naming the first
outside thing an agent should touch.

**15. Canvases, and the Git forge** — *large, and NOT recommended*
Buzz has both. Neither belongs in Cloud9 yet. Canvases are a second product surface;
the Git forge serves a developer team, not a network engineer chatting with friends.
Spec §14 already excludes a code-hosting platform. Listed here only so the answer to
"does Cloud9 have everything Buzz has" is honest: no, and deliberately.

**16. Voice / huddles** — *large, NOT recommended*
**FR-CM-010** is `TBD` and spec §14 explicitly excludes voice and video from the
platform unless later approved. Buzz has huddles; its own README lists huddle
lifecycle events as unfinished.

---

## 6. The recommended order

If the goal is "make it feel like a real chat app, quickly", do this:

1. **Render markdown** — half a day, fixes a visible defect.
2. **Scrollback** — half a day, the relay half is already written.
3. **Reactions** + **edit/delete** — one small round together.
4. **Unread and mention badges on the account, not the browser.**
5. **Real search.**
6. **Attachments.**

That is roughly one to two weeks of work and it closes most of **FR-CM-009** plus
**FR-AU-005**. After it, Cloud9 stops feeling like a demo of a chat app.

Then choose between **threads** (feels like Slack/Buzz) and **showing what an agent
did** (delivers what the product promises). The honest recommendation is: **show what
the agent did first** — it is the one thing Cloud9 claims and cannot do, and Buzz's
whole pitch is built on exactly that.

---

## 7. The questions that must be answered first

One at a time, in his words, with a recommendation attached.

**Q-A (blocks nearly everything above):**
"The spec left threads, reactions, attachments, editing, deleting and search as open
questions — it never says yes or no. Can I write 'yes, build the ordinary chat basics'
into the spec so we're allowed to build them?"
*Recommendation: yes. Nothing below is buildable without it.*

**Q-B (shapes what we copy from Buzz):**
"Which bits of Buzz do you actually use — the chat side (threads, search, files), or
the code side (the Git channels, the canvases)?"
*Recommendation: assume chat side. The Git side does not fit Cloud9's user.*

**Q-C (blocks attachments):**
"When you drop a file into a chat, should your agents be allowed to read it — or only
the people?"
*Recommendation: people first, agents second and behind an approval.*

**Q-D (blocks public channels):**
"Is Cloud9 one shared space for you and your friends forever, or do you want separate
spaces with different people in each?"
*This is the same question the coverage audit already flagged as Q6 and it is still unanswered.*
