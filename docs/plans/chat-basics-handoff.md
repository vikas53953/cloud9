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
| **Attachment download over the wire** | The relay has no HTTP file route; adding one needs an auth decision (token in a query string is a credential in a log line). | A `GET /attachment/:id` on the relay's existing http server, authorised by the same durable token, plus a short-lived one-use ticket frame. One round of work; needs a yes on the auth shape. |
| **Agents reading an attached file** | Feature-gap Q-C is unanswered, and it touches FR-AG-006 / FR-TS-006. | Vikas answers "can my agents read files I drop in chat?" first. Recommendation on record: people first, agents second, behind an approval. |
| **`broadcast` flag on a reply** (thread-only vs also-in-channel) | Buzz has it; we do not need it until threads are actually in use. | One boolean on `Message`, one filter in the channel view. Cheap later. |
| **Channel `description` / `topic` / `visibility` / `archivedAt`, and membership as rows** | Judged too large to land safely alongside seven other features in one round. See §7 — it is written out as a concrete plan rather than half-done. | §7. |
| **Pins, saved messages, drafts, link previews, per-channel mute, custom emoji, reminders, human typing indicators** | Not in this round's brief. | Feature-gap §5(b) items 9–12. |
| **Markdown rendering** | Renderer-only, and the highest value-per-hour item in the whole gap audit. | Yours. Nothing server-side blocks it. |

---

## 7. The channel and membership migration — a concrete plan

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
