# Chat basics — the renderer half

**Date:** 2026-07-29
**Who this is for:** whoever owns `apps/desktop/src/**`.
**What already exists:** the whole server half. Every frame below is built,
authorised and tested in `apps/relay/src/` and `packages/shared/src/index.ts`.
Nothing here needs a relay change; if you think it does, say so rather than
building a second copy of a rule.

**Where the truth lives:** `packages/shared/src/index.ts`. Frame shapes in this
document are a readable copy — the file is the contract.

**Closes:** FR-CM-009 (approved 2026-07-29), part of FR-AU-005.

---

## 0. The one-paragraph summary

A client can now: scroll back through a whole conversation, search everything it
is allowed to see, put an emoji on a message, edit and delete its own messages,
reply in a thread, attach a file, and get its unread counts from the relay
instead of `localStorage`. Six new server frames and eight new client frames.
One existing frame, `history`, changed shape.

---

## 1. What changed in something you already use

### 1.1 `history` — BREAKING shape change

**Before:** `{ type: "history", channelId, messages }`.
**Now:**

```ts
{
  type: "history";
  channelId: ID;
  messages: Message[];      // OLDEST FIRST — prepend as-is, do not re-sort
  hasMore: boolean;         // the ONLY honest end-of-history signal
  nextBefore?: number;      // cursor: feed straight back
  nextBeforeId?: ID;        // cursor: feed straight back
}
```

Ask for a page with:

```ts
{ type: "history", channelId, limit: 50, before: nextBefore, beforeId: nextBeforeId }
```

**Rules you must follow.**
- Send `before`/`beforeId` back **exactly as received**. Do not build your own
  cursor from the oldest message you happen to be holding, and do not send
  `before` without `beforeId`. Two messages can land in the same millisecond
  (the engine posts a burst of agent replies), and the id is what breaks the
  tie. A hand-built cursor skips or repeats a message at the page boundary.
- **Do not treat an empty or short page as "the end".** Use `hasMore`. A page
  can be short without being the last one.
- `limit` is capped at 200 and defaults to 50.

**Where to wire it:** when the message list is scrolled near the top and
`hasMore` was true for the last page. Keep a per-channel `{nextBefore,
nextBeforeId, hasMore, loading}` in the store, not in a component.

### 1.2 `welcome` carries read state now

`WorldState` gained `unread?: UnreadEntry[]`:

```ts
interface UnreadEntry {
  channelId: ID;
  lastReadTs: number;   // everything at or before this has been seen
  unread: number;       // messages after it this person did not write
  mentions: number;     // how many of those @mention them or one of their agents
}
```

**Delete `cloud9.lastRead` from `localStorage` and the code that reads it.**
That is the whole point of this item — read state that follows the person
between machines. It is optional in the type only so an older relay does not
crash a newer client; against this relay it is always present.

### 1.3 `send` gained two optional fields

```ts
{ type: "send", channelId, text, tempId?, replyTo?: ID, attachmentIds?: ID[] }
```

`text` may be empty **only** when `attachmentIds` is non-empty. Otherwise the
relay refuses with "a message needs some words". Max 40 000 characters.

### 1.4 `Message` gained fields

```ts
replyTo?: ID;                    // the message this answers (the thread ROOT)
editedAt?: number;               // show "(edited)"
deletedAt?: number;              // TOMBSTONE — text is "", render "message deleted"
attachments?: Attachment[];
replyCount?: number;             // cached on the thread root — "12 replies"
lastReplyAt?: number;            // "12 replies · 3m ago"
reactions?: MessageReaction[];   // [{ emoji, userIds }] — live list only
```

A deleted message **stays in the list**. It is a tombstone, not a hole: replies
still hang off it, scrollback still counts, and the activity trail still
matches. Render it greyed, with no author actions.

### 1.5 `AgentDef` gained "who may use me" — this needs UI

```ts
respondTo?: "owner" | "allowlist" | "anyone";   // absent = "owner"
respondToAllowlist?: ID[];                      // user ids
```

**This is a security setting and it defaults to closed.** Until the owner opens
an agent up, only the owner can @mention it into action or hand it a job. See
§5.

---

## 2. New client frames (what you send)

```ts
// find words across every conversation you can see
{ type: "search", query: string, channelId?: ID, authorId?: ID, limit?: number }

// put an emoji on a message, or take yours off. `on` defaults to true.
{ type: "react", messageId: ID, emoji: string, on?: boolean }

// change the words of a message you wrote
{ type: "editMessage", messageId: ID, text: string }

// take back a message you wrote
{ type: "deleteMessage", messageId: ID }

// the whole of one thread (pass the root OR any reply — you get the thread)
{ type: "thread", messageId: ID, limit?: number }

// park a file on the hub, then name its id in a `send`
{ type: "uploadAttachment", channelId: ID, name: string, dataBase64: string, mime?: string }

// "I have read this conversation up to here"
{ type: "markRead", channelId: ID, ts?: number }
```

## 3. New server frames (what you receive)

```ts
{ type: "searchResults", query: string, results: SearchHit[], hasMore: boolean }
// SearchHit = { message, channelName, channelKind, snippet }
// snippet has the matched words wrapped in « » — render those as <mark>.

{ type: "reaction", channelId: ID, messageId: ID, emoji: string, userIds: ID[] }
// The FULL current list, not a delta. Replace, never add. Empty = nobody
// reacts with that emoji any more: remove the pill.

{ type: "messageUpdated", message: Message }
// An edit, a delete, or a thread root whose replyCount changed. Replace the
// message with this id wherever you are holding it — message list, thread
// panel, search results, quick chat.

{ type: "thread", parentId: ID, messages: Message[] }
// messages[0] is the root; the rest are replies, oldest first.

{ type: "attachment", attachment: Attachment }
// Your parked file is ready. Sent ONLY to the uploader.

{ type: "read", entry: UnreadEntry }
// Sent to EVERY machine this person is signed in on. This is how the phone
// learns the laptop read the room. Apply it unconditionally.
```

These six are already listed as no-op cases in `apps/desktop/src/store.ts` so
the exhaustiveness guard keeps its teeth — replace each `break;` with real
handling as you build the screen. **That is the one file outside the relay/shared
boundary the server round touched**, and only to keep `npm run build` green.

---

## 4. How each feature is meant to behave

### 4.1 Scrollback
Load older pages on scroll-to-top. Keep the scroll anchored (measure
`scrollHeight` before prepending, restore after). Stop when `hasMore` is false
and say so once — "that's the beginning of this conversation".

### 4.2 Search
- Debounce ~200 ms. Send `query` raw; the relay turns it into words itself, so
  do **not** try to escape or quote anything.
- `in:` / `from:` filters map to `channelId` / `authorId`. You must resolve the
  name the person typed to an id yourself — the relay does not accept names.
  (Deliberate: a display name is not an identity, per the P0 #1 rule.)
- **Honest limits to put in the UI copy:** it matches whole words, in any order,
  and prefix-matches the last word as you type. It does not find a word in the
  middle of another word ("port" does not find "airport") and it does not stem
  ("running" does not find "run"). Deleted messages are never found.
- Naming a channel you are not in returns `error: "no such channel"` — treat it
  as "no results", not as a crash.

### 4.3 Reactions
- Hover button on a message, plus a row of pills underneath.
- Optimistic update is safe: the relay is idempotent per (person, message,
  emoji), so a double press cannot become two votes. Reconcile on the
  `reaction` frame.
- Clicking a pill you are already in sends `on: false`.
- Reacting to a deleted message errors. Hide the button on tombstones.

### 4.4 Edit and delete
- Only show the actions on messages you may change: your own, or an agent you
  own (`agent.ownerId === me.id`). The relay refuses either way, but a button
  that always errors is a dead click.
- Editing recomputes @mentions server-side, so a mention can be added or taken
  back by editing. Re-render highlights from `message.mentions`.
- Delete is not undoable and takes the message's files with it. Confirm once.
- Suggested shortcut: **Up arrow in an empty composer edits your last message**
  (the one people lean on and we do not have).

### 4.5 Threads
- Threads are **one level deep by design**. Replying to a reply joins the same
  thread; the relay rewrites `replyTo` to the root. Do not build a tree.
- In the channel, a root shows "N replies · <time>" from `replyCount` /
  `lastReplyAt`. Replies **also** appear in the channel today (there is no
  "only in thread" flag yet — see §6).
- Open a side panel, send `{type:"thread"}`, render `messages`, and post into it
  with `send` + `replyTo: parentId`.

### 4.6 Attachments
Two steps, on purpose, so you can show progress:

1. Read the file, base64 it, send `uploadAttachment`.
2. On the `attachment` frame, hold `attachment.id` as a chip in the composer.
3. On send, pass `attachmentIds: [...]`.

- Max **10 MB** per file, **10** files per message.
- The name rule is `isSafeSkillFileName` — the same one skill files use. Check
  it **before** uploading so the person gets a fast, plain answer instead of a
  round trip. Import it; do not re-implement it.
- A parked file can only be sent once, only by its uploader, only into the
  conversation it was uploaded to.
- **There is no download endpoint yet.** `storedAs` is a file name inside the
  hub's `cloud9-attachments` folder, beside `cloud9-relay.db`. On the owner's own
  machine the Electron main process can open it directly. For a friend across
  Tailscale, see §6.

### 4.7 Read state
- Send `markRead` when the conversation is open and scrolled to the bottom, and
  on window focus. Debounce it.
- Apply the `read` frame unconditionally — it is how the other machine finds
  out.
- Read state only ever moves **forward** (highest timestamp seen wins, which is
  the merge rule Buzz uses and we copied). Sending an old `ts` is harmless.
- `mentions` is a separate count. Render it as a distinct badge from `unread`;
  the gap audit called out that we only had one.

---

## 5. The agent-permission screen (please build this)

`AgentDef.respondTo` decides who can make an agent act. It is enforced at the
relay on every path that can cause a turn — an @mention and a delegated job —
and it defaults to **owner only**, including for agents built before the setting
existed.

In the agent editor, one control, three plain-words options:

> **Who can use this agent?**
> - Just me *(recommended)*
> - Me and these people: [picker]
> - Anyone in the room

Copy to put under it: *"This agent runs on your computer and its answers are
paid for by your account, so nobody else can set it working unless you say so."*

**Behaviour you will observe:** when someone who is not allowed @mentions the
agent, their message still goes through with their words intact, but the agent's
id is filtered out of `message.mentions`, so nothing happens. That is quiet.
**Please make it visible** — if the person typed `@Name` and that id is missing
from `mentions`, show a one-line hint under the message: *"Scout only answers
Vikas."* Otherwise it looks broken.

Delegated work (`!bg` / `!task`) is refused loudly with
`"<Agent> isn't set up to take work from <Person>"` — show it as-is.

### 5.1 ONE LINE IS STILL MISSING, AND IT IS IN THE ENGINE — please read

The relay enforces `respondTo` on the two paths it owns: the published
`mentions` list, and `createTask`. **It cannot close the other two, because they
are decided in `packages/engine/src/chatter.ts`.**

`shouldReply()` currently returns true without ever looking at who is asking:

```ts
if (channel.kind === "dm") return true;          // ← anyone in a DM with the agent
...
return !!best && best.id === agent.id && ...;    // ← "free chatter": no mention needed
```

So today a friend can still make the owner's agent take a turn by opening a DM
with it, or by saying something in a shared channel that happens to match its
persona. That spends the owner's subscription and starts a program on the
owner's machine.

**The fix is one line, at the top of `shouldReply`:**

```ts
import { mayDriveAgent } from "@cloud9/shared";
// ...
export function shouldReply(agent, message, channel, channelAgents): boolean {
  if (message.authorKind === "human" && !mayDriveAgent(message.authorId, agent)) return false;
  // ...unchanged from here
}
```

`mayDriveAgent` is already exported from `@cloud9/shared` and is the same
function the relay uses, so the two checks cannot drift. Agent-authored messages
are left to the existing agent→agent rules — an agent already needs a mention,
and that mention has already been filtered by the relay against **its owner's**
permissions, which is what stops an agent laundering a permission it does not
have (FR-AA-003).

**Until that line lands, the hole is open.** It is called out here rather than
patched from the relay because a second copy of the rule in a second place is
exactly the thing that goes stale.

---

## 6. Deliberately not built — and what it would take

| Not built | Why | What it needs |
|---|---|---|
| ~~**Attachment download over the wire**~~ **— BUILT, see §9** | ~~needs an auth decision~~ | Done. The decision that was open is written out in §9.1. |
| **Agents reading an attached file** | Feature-gap Q-C is unanswered, and it touches FR-AG-006 / FR-TS-006. | Vikas answers "can my agents read files I drop in chat?" first. Recommendation on record: people first, agents second, behind an approval. |
| **`broadcast` flag on a reply** (thread-only vs also-in-channel) | Buzz has it; we do not need it until threads are actually in use. | One boolean on `Message`, one filter in the channel view. Cheap later. |
| ~~**Channel `description` / `topic` / `visibility` / `archivedAt`, and membership as rows**~~ **— BUILT, see §10** | ~~too large for that round~~ | Done, at schema version 3. §7 was the plan; §10 is what actually landed, including the one place it deliberately departs from §7. |
| **Pins, saved messages, drafts, link previews, per-channel mute, custom emoji, reminders, human typing indicators** | Not in this round's brief. | Feature-gap §5(b) items 9–12. |
| **Markdown rendering** | Renderer-only, and the highest value-per-hour item in the whole gap audit. | Yours. Nothing server-side blocks it. |

---

## 7. The channel and membership migration — a concrete plan

> **STATUS: BUILT (2026-07-29, round 2).** This section is kept as written so
> the reasoning is on the record. What actually shipped, and the one place it
> deliberately does NOT do what this section says, is in **§10**. Where the two
> disagree, §10 is the truth.


The Buzz teardown is right that this is the change that unblocks browse-and-join,
archive, roles and "who could see this message at the time". It was **not** taken
this round because it rewrites `Channel`, which every screen and every existing
test depends on, and doing that in the same round as seven new features is how
you get a regression nobody can bisect. Here is the plan so the next round does
not have to re-derive it.

**Step 1 — additive fields on `Channel` (safe, no migration).**
```ts
description?: string;
topic?: string; topicSetBy?: ID; topicSetAt?: number;
visibility?: "open" | "private";   // absent = "private", today's behaviour
archivedAt?: number;
```
`visibility` absent meaning private keeps every existing room exactly as it is.
`visibleChannels()` gains "…or the channel is open", which is the whole
browse-and-join feature.

**Step 2 — a real `channel_members` table.**
```sql
CREATE TABLE channel_members(
  channelId TEXT NOT NULL, memberId TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  joinedAt INTEGER NOT NULL, invitedBy TEXT,
  removedAt INTEGER, removedBy TEXT,
  PRIMARY KEY (channelId, memberId)
);
```
Backfill from every channel's `memberIds` at `schemaVersion` 2 → 3, using
`channel.createdAt` as `joinedAt`. Keep `Channel.memberIds` on the wire as a
**derived** field (live members only) for one release so no client breaks, then
retire it. `channelFor()` becomes a query against the table; because every
channel-scoped frame already goes through that one function, this is a
single-site change.

**Step 3 — system messages.** A `system` author kind so "Raj joined", "topic
changed" and "channel archived" appear in the room. Buzz emits one per state
change; today people appear in rooms with no explanation.

**Step 4 — `Approval.expiresAt` and a decider's `note`.** Both named in the
teardown, both small, both blocked on nothing.

The schema-version machinery for all of this is already in place:
`Store.schemaVersion()`, `meta.schemaVersion`, and a `migrate()` that runs steps
by version. Version 2 is current. The first change is now a step, not a hand
repair on Vikas's only copy of his messages.

---

## 8. Things that are true and easy to get wrong

- **Never build a membership check.** `channelFor()`, `messageFor()`,
  `myAgent()` and `mayDriveAgent()` are the four gates; every new server path
  goes through one of them. If you need one in the renderer, it is for hiding a
  button, never for deciding what is allowed.
- **A `reaction` frame is a fact, not a delta.** Replace the list.
- **`hasMore`, not "the page was short".**
- **The cursor is a pair.** `before` alone is a bug.
- **A tombstone is a row.** Never filter deleted messages out of the list; that
  is what makes the count and the trail disagree.

---

# ROUND 2 — added 2026-07-29

Everything below landed in `packages/shared/src/index.ts` and `apps/relay/src/`
and is tested (relay suite: 52 → 76). As before: `packages/shared/src/index.ts`
is the contract, this document is a readable copy.

---

## 9. Getting an attached file's bytes — BUILT

### 9.1 The decision that was open, and why this is the answer

§6 said this needed "a yes on the auth shape", and flagged the real danger: **a
token in a URL is a credential in a log line.** Vikas was away, so the
conservative choice was made and is written here rather than left implicit.

**The rule kept:** a connection is authenticated ONCE, as a person, and
everything after that is decided from what is stored about that person. So:

1. **There is no second way to sign in.** You ask for a file on the socket you
   already said `hello` on. The answer is authorised by `channelFor` — *the same
   function* that decides whether you may read the conversation the file was
   posted in. Not a copy of it, the function itself. No durable token ever
   travels in a URL, a query string, a header or a cookie.
2. **What does travel in the URL is not a credential to this Cloud9.** It is a
   ticket to *one file*, good for **30 seconds**, and it is **spent by the first
   request that presents it**. Copied out of a log line, a proxy trace or a
   screen recording it is already worthless. That is what makes it safe *by
   construction* rather than by a promise not to log it — which would be a
   promise about somebody else's software.
3. **Permission is checked twice, and the second time is the one that counts.**
   At mint *and* at redeem, both through `channelFor` on stored state. Being
   removed from the room inside those 30 seconds stops the download. There is a
   test that does exactly that.

Tickets live in memory only, never in the database: a credential that survives a
restart is a credential somebody has to remember to expire.

This is also why it does not become a hole the moment the hub binds a
private-network address (`backend-decision.md` #2): reaching the port buys
nothing without a ticket, and a ticket cannot be had without an authenticated
socket that is already a member.

### 9.2 The two frames

```ts
// client → relay, on the ordinary WebSocket
{ type: "attachmentTicket", attachmentId: ID }

// relay → the asking socket only
{
  type: "attachmentTicket";
  attachmentId: ID;
  ticket: string;          // opaque; you never need to look inside it
  url: string;             // "/attachment/<ticket>" — relative, see below
  expiresAt: number;       // ms since epoch
  attachment: Attachment;  // so you can draw it without asking again
}
```

Refusals arrive as the ordinary `error` frame:

| You get | It means |
|---|---|
| `no such file` | No such id, **or** it is in a conversation you are not in, **or** it is a parked file somebody else uploaded and has not sent yet. Deliberately the same sentence for all three, so an id cannot be probed. |
| `too many files being opened at once — try again in a moment` | You are holding 32 unspent tickets. Wait, or spend some. |

### 9.3 How to fetch it

**Build the URL from the WebSocket URL you are already connected to.** Do not
store a hub address anywhere else and do not let a user type one:

```ts
const base = wsUrl.replace(/^ws/, "http");   // ws://host:port → http://host:port
const res = await fetch(base + frame.url);   // frame.url is "/attachment/<ticket>"
```

- **Fetch it once.** A retry gets `404`; the first request spent the ticket.
- **`404` is the only failure.** Expired, spent, made up, no longer allowed —
  all of them answer `404` with the sentence *"that link has expired — open the
  file again"*. That is on purpose: a `403` would tell a stranger the difference
  between "no such file" and "a file you may not have". **Show the person a
  retry, not an error** — asking for a new ticket is the whole recovery.
- **Ask for the ticket at the moment of the click**, not when the message
  renders. A ticket minted when a message scrolls into view will be dead by the
  time anyone presses it, and you would be minting 32 of them per screen.

### 9.4 What comes back, and what you may do with it

The relay decides the `Content-Type` **from the file's name**, never from the
`mime` the sender claimed. (`Attachment.mime` is display text and always has
been — the type comment on it says so.) If the hub echoed the sender's `mime`
back, anybody who could attach a file could choose how the app treats it, and
"here is a picture" would be a way to run a page inside the app.

Two shared helpers exist so you do not have to re-derive any of this:

```ts
import { downloadContentType, isInlineViewable } from "@cloud9/shared";

isInlineViewable(attachment.name)     // true → safe to show in place
downloadContentType(attachment.name)  // the exact type the hub will serve
```

`isInlineViewable` is true for `png jpg jpeg gif webp bmp ico txt md log csv
json pdf`. **Everything else** — including anything you have not heard of — is
served as `application/octet-stream` with `Content-Disposition: attachment`.
There is deliberately **no `svg`**: an SVG is a document that can carry script,
not a picture.

Every response also carries `X-Content-Type-Options: nosniff`,
`Content-Security-Policy: default-src 'none'; sandbox` and
`Cache-Control: no-store`.

**What to build:**
- A file chip on a message: icon, name, size. Click → ask for a ticket → fetch.
- If `isInlineViewable` and it is an image, show it inline —
  `URL.createObjectURL(await res.blob())`, and **`URL.revokeObjectURL` when the
  message unmounts** or you will hold every image ever opened in memory.
- Otherwise offer "Save" — the browser/Electron download path.
- Because of `no-store`, **you** are the cache. Keep the blob URL per attachment
  id for the life of the screen; do not re-ticket on every re-render.

### 9.5 Limits, unchanged

Max **10 MB** per file, **10** files per message, and the name rule is still
`isSafeSkillFileName` — the same one skill files use, imported, never
re-implemented. It is now checked on the way **out** as well as in, so a row
written by an older build cannot become a header or a file on somebody's disk.

---

## 10. Channels are real things now — BUILT (schema version 3)

### 10.1 What changed on `Channel`

All additive; every field optional; absent everywhere means "exactly how it
behaved before".

```ts
description?: string;             // what this room is for      (max 500)
topic?: string;                   // what it is about today     (max 200, ONE LINE)
topicSetBy?: ID; topicSetAt?: number;
visibility?: "open" | "private";  // ABSENT = private. Every old room stays shut.
archivedAt?: number; archivedBy?: ID;  // retired, not deleted
```

**`memberIds` is now DERIVED.** The relay builds it from the membership rows on
the way out. It still arrives on every `channel` frame and in `welcome`, so
nothing you have written breaks — but it is the field to retire. Read it for
"who is in here right now"; ask `channelMembers` for anything else.

### 10.2 Membership is rows

```ts
interface ChannelMember {
  channelId: ID;
  memberId: ID;      // a user id OR an agent id — the same union memberIds carried
  role: "owner" | "admin" | "member";
  joinedAt: number;
  invitedBy?: ID;    // absent when they let themselves into an open room
  removedAt?: number;// absent = still in. A SOFT delete: the row stays.
  removedBy?: ID;
}
```

Roles, in plain words for the UI:

| Role | May |
|---|---|
| `owner` | everything, including handing out roles |
| `admin` | set topic/description, open/close, archive, add and remove people — **not** roles, and **not** remove the owner |
| `member` | read and talk |

Who has `owner` today: whoever created the room. On rooms that existed before
this round, the person who runs this Cloud9 — and **only** on rooms he is in;
everyone else is a plain `member`, and a DM has no owner at all. Nothing in the
old data recorded who made a room, so nothing was guessed generously.

### 10.3 New client frames

```ts
{ type: "setChannelInfo", channelId, description?: string, topic?: string }
{ type: "setChannelVisibility", channelId, visibility: "open" | "private" }
{ type: "archiveChannel", channelId, archived: boolean }
{ type: "browseChannels" }
{ type: "joinChannel", channelId }
{ type: "leaveChannel", channelId }
{ type: "removeMember", channelId, memberId }
{ type: "setMemberRole", channelId, memberId, role }
{ type: "channelMembers", channelId, at?: number }
```

`setChannelInfo` follows the same **absent-vs-empty** rule as skill files: a
field you do not send is left alone; `""` clears it. Sending `{ topic: "" }`
removes the topic; sending `{ description: "x" }` alone does not touch the topic.

### 10.4 New server frames

```ts
{ type: "channelDirectory", channels: ChannelSummary[] }
// ChannelSummary = { id, name, description?, topic?, memberCount, createdAt }
// Answers browseChannels. NEVER carries members or messages.

{ type: "channelMembers", channelId, at?: number, members: ChannelMember[] }
// Without `at`: everyone in the room now.
// With `at`: everyone who was in it at that moment — the honest answer to
// "who could see this message when it was said". Pass a message's `ts`.

{ type: "channelLeft", channelId }
// You are out. Drop the channel AND everything cached for it — messages, the
// scrollback cursor, the unread entry. Sent when you leave and when you are
// removed.
```

### 10.5 Browse and join — and the one place this departs from §7

**§7 said `visibleChannels()` should gain "…or the channel is open". It does
not, and must not.** `visibleChannels` is what `channelFor` is built on, so
widening it would have quietly made every open room readable *and postable* by
everyone in this Cloud9 without anybody joining anything — one edit, seven
authorisation paths changed.

So browsing is a **separate, smaller** question with its own answer:

- `browseChannels` lists rooms that are `visibility === "open"`, not archived, of
  kind `channel`, and that you are not already in. Name, description, topic,
  member count, created date. **No member list. No messages.**
- **Being able to find a room is not permission to read it.** Until you join,
  `history`, `send`, `search` and `channelMembers` on that room all answer
  `no such channel` — the same sentence a made-up id gets. There is a test.
- `joinChannel` only accepts a room that would appear in *your* directory
  listing. Anything else is `no such channel`, so browsing cannot become a way
  to learn which private rooms exist.
- After joining you get the `channel` frame like everyone else, then ask for
  scrollback with `history` the ordinary way. **You are not sent a fresh
  `welcome`** — your cached messages are not reset.

**UI to build:** a "Browse rooms" entry near "New channel". A list of cards —
name, description, "N people", a Join button. Empty state: *"No open rooms to
join. Rooms are private unless someone opens them."*

### 10.6 Archived rooms are READ-ONLY

An archived room stays in your sidebar and stays fully readable. What is refused
is anything that puts something new in it: `send`, `agentSend`, `react`,
`editMessage`, `deleteMessage`, `uploadAttachment` and `addMembers` all answer
**`that conversation is archived — nothing new can be said in it`**.

Render it: grey the room in the sidebar, replace the composer with that same
sentence, hide the reaction and edit affordances, keep scrollback working.
Un-archiving is one frame and works — say so ("Reopen") rather than making it
look permanent.

### 10.7 Direct conversations

A DM has nothing to administer. `setChannelInfo`, `setChannelVisibility`,
`archiveChannel` and `setMemberRole` all answer **`a direct conversation has no
settings to change`**, and `leaveChannel` answers **`you can't leave a direct
conversation`**. Hide those controls when `channel.kind === "dm"` — the relay
refuses either way, but a button that always errors is a dead click.

### 10.8 The room-details panel, please build this

One panel per room, opened from the header:

> **# trip** — *Planning the Kerala trip*   ← description
> **Topic:** back on the 14th   ← one line, editable by owner/admin
> **Who's here (4)** — each with role, "joined 3 Jun", "added by Vikas"
> [ Open to anyone here / Private ]  [ Archive this room ]  [ Leave ]

- Show the controls only for the role that can use them (read `channelMembers` →
  your own row → `role`). The relay is still the gate; this is for hiding
  buttons, never for deciding what is allowed. (§8 rule.)
- The member list is `channelMembers` without `at`. An agent in the list should
  be drawn as an agent — `memberId` may be an agent id.
- A nice, cheap use of `at`: on a message's context menu, "Who could see this?"
  → `{ type: "channelMembers", channelId, at: message.ts }`.

### 10.9 Errors you will see, verbatim

| Sentence | When |
|---|---|
| `you don't run this conversation` | you are a plain member trying to change the room |
| `only the person who runs this conversation can do that` | you are an admin trying to hand out a role, or to remove the owner |
| `a direct conversation has no settings to change` | any room setting on a DM |
| `you can't leave a direct conversation` | `leaveChannel` on a DM |
| `that conversation is archived — nothing new can be said in it` | any write into an archived room |
| `no such channel` | not yours, or an open room you have not joined |
| `a topic is one line` | a newline in a topic |
| `give this conversation to someone else before standing down` | the owner trying to demote themselves |

### 10.10 The migration, and how it was proved

`meta.schemaVersion` 2 → 3, run by the existing `migrate()` stepper. The step
gives every id in every channel's stored `memberIds` a real membership row, with
`joinedAt` set to the room's own `createdAt` — the only honest answer available,
since nobody ever recorded when these people arrived.

It is lossless and re-runnable by construction: it only ever `INSERT OR IGNORE`s,
so an existing row is never touched, and it never writes to the `channels`
table, so the old list is still there afterwards to check the new rows against.

Proved by running it against **a copy of the real `cloud9-relay.db`** (45 rooms,
269 messages, 386 trail rows, no version stamp at all): every row count
identical afterwards, every room's member list identical, 112 membership rows
created, and a second and third open changed not one row.

That run also found a real bug, now fixed: `CREATE UNIQUE INDEX … ON
activity(seq)` sat *above* the migration that adds the `seq` column, so the hub
threw `no such column: seq` and could not open its own older database at all.
The class rule that replaces it: **an index over a column a migration adds is
built after the migration, never in the CREATE block.**

### 10.11 What did NOT get built, and what it would take

- **System messages in the room** ("Raj joined", "topic changed", "archived") —
  §7 step 3, Buzz's kind 40099. The relay writes all of these to the activity
  ledger already (`member_added`, `member_removed`, `channel_updated`,
  `channel_archived`, `member_role_changed`), so the facts exist; what is missing
  is an author kind of `system` on `Message` and one emit per change.
  Deliberately deferred: it changes `AuthorKind`, which every message renderer
  switches on, and that is a renderer-wide change to make on its own.
- **`Approval.expiresAt` and a decider's `note`** — §7 step 4, still untouched,
  still blocked on nothing.
- **Retiring `Channel.memberIds`** — it is derived now, so this is a delete once
  every screen reads `channelMembers`. Not before.
