# Buzz teardown — what it actually is, and what Cloud9 should take from it

**Date:** 2026-07-29
**What this is:** a study of the public Buzz source code, written to answer "Vikas
wants Buzz's features — which ones, and what would they cost us?"
**How it was done:** by reading the public repository at
[github.com/block/buzz](https://github.com/block/buzz) over the web. Nothing on this
machine was opened. The locally installed copy of Buzz was **not** touched, not run
and not decompiled. No Buzz code has been copied into Cloud9 and none should be.
**Cloud9 side:** read from `docs/plans/backend-assessment.md`,
`docs/plans/harness-signin.md`, `docs/plans/feature-gap.md` and
`packages/shared/src/index.ts`. Nothing in Cloud9 was edited.

### Its licence, and what that lets us do

Buzz is **Apache License 2.0, "Copyright 2026 Block, Inc."**
(https://raw.githubusercontent.com/block/buzz/main/LICENSE).

In plain words, Apache 2.0 means we *may* copy the code, change it and ship it in a
closed product, so long as we keep their copyright notice, state what we changed, and
include a copy of the licence. It also grants us a patent licence. It does **not**
force Cloud9 to become open source.

**But we are not going to copy any of it, and the reason is practical, not legal:**
Buzz is ~30 Rust crates on Postgres + Redis + S3 + the Nostr protocol. Cloud9 is
TypeScript on one SQLite file. There is no file in Buzz that could be pasted into
Cloud9 and work. What is worth taking is the *thinking* — which fields they found they
needed, which order they built things in, and which of their choices are wrong for us.
Ideas are not covered by copyright.

---

## 0. The one-paragraph answer

Buzz is a **self-hosted Slack that speaks Nostr**. Every message, reaction, approval
and git event is a signed record in one log, and an AI agent is just another member
with its own key. Its server is a Rust program called a *relay*; its store is
Postgres + Redis + S3; its client is a Tauri desktop app. Agents do **not** run inside
Buzz — Buzz spawns Claude Code / Codex / Goose on your own machine through a standard
called ACP, and those programs use their own logins. **Buzz never sees or stores a
Claude token, and neither does Cloud9's current code — on that specific point we
already match them.** Where Buzz is far ahead is the boring middle of a chat app:
threads, reactions, editing, files, search, read state, channel roles. Where Cloud9 is
ahead is approvals, which in Buzz are half-built and, at the agent-tool level,
switched off by default.

---

## 1. Architecture

### 1.1 What each piece is

| Question | Buzz's answer | Where I saw it |
|---|---|---|
| Client | A desktop app, Tauri (Rust shell) + React. Also mobile (Flutter, unfinished), a web app, an admin web app, and `buzz-cli` for agents. | README "Desktop app (Tauri + React)"; repo root has `desktop/`, `mobile/`, `web/`, `admin-web/` (https://github.com/block/buzz/tree/main) |
| Server | One Rust program, **`buzz-relay`** (Axum). "The relay serves as the single source of truth. All reads and writes flow through it." | https://raw.githubusercontent.com/block/buzz/main/ARCHITECTURE.md |
| Transport | **WebSocket** for the live stream (Nostr NIP-01 wire format), plus **REST** for channel/DM/media/workflow/git operations. | README architecture diagram: "WebSocket" and "WS + REST"; ARCHITECTURE.md "Axum WS + REST" |
| Datastore | **Postgres** (all events, month-partitioned, plus full-text search), **Redis** (fan-out, presence, typing), **S3/MinIO** (files, via the "Blossom" protocol). Search also has an optional **Typesense**. | README diagram; https://raw.githubusercontent.com/block/buzz/main/.env.example (`DATABASE_URL`, `REDIS_URL`, `TYPESENSE_URL`) |
| Where agents run | **Outside the relay**, on the operator's own machine, as separate processes spawned by `buzz-acp`. "The harness spawns agent subprocesses." | https://raw.githubusercontent.com/block/buzz/main/crates/buzz-acp/README.md |
| How it reaches Claude Code / Codex | Through **ACP (Agent Client Protocol)** over stdin/stdout. Supported commands include `goose`, `codex` / `codex-acp`, `claude-code` / `claude-code-acp`, `claude-agent-acp`, `hermes`, and their own `buzz-agent`. | https://raw.githubusercontent.com/block/buzz/main/crates/buzz-acp/src/config.rs |
| Bind address | `BUZZ_BIND_ADDR` defaults to **`0.0.0.0:3000`** — i.e. it answers the network by default. | .env.example |
| Deployment | Docker Compose bundle with Postgres, Redis, MinIO and optional Caddy/TLS, for "a single-node / VPS relay". | README, `deploy/compose/` |

### 1.2 How onboarding actually authenticates — the thing Vikas asked us to copy

This is the most important correction in this document, so it gets its own section.

**There are two completely separate sign-ins in Buzz, and they are often confused.**

#### (a) The human signing in to Buzz: there is no account at all

No email. No password. No OAuth. No "sign in with Claude". **A person in Buzz is a
cryptographic keypair**, and the app generates one for you silently on first run.

The desktop app resolves an identity in a fixed order — environment variable
`BUZZ_PRIVATE_KEY`, then the OS keyring, then a legacy file, then *generate a new one
and save it* — and refuses to start without one:

> "Resolve persisted identity key (env var → file → generate+save). This is fatal —
> the app should not start with an ephemeral identity"
> — https://raw.githubusercontent.com/block/buzz/main/desktop/src-tauri/src/lib.rs

The private key is kept in **the operating system's keychain** (Windows Credential
Manager / macOS Keychain / Linux Secret Service), as a single JSON blob, falling back
to a `0600` file if the keyring is unavailable
(https://raw.githubusercontent.com/block/buzz/main/desktop/src-tauri/src/secret_store.rs;
SECURITY.md: "Desktop app stores private keys in OS keyrings ... rather than plaintext").

The onboarding screens are: *identity landing → optional key import → back up your key
→ install agent runtimes → configure*. The landing offers "Create a new identity key"
or "Use an existing key". The backup screen shows the key once and says:

> "This key is stored in your system keychain, but save it some place safe in case you
> ever need to restore your account." / "Never share your private key. Anyone with this
> key can impersonate you and access everything in your account."
> — https://raw.githubusercontent.com/block/buzz/main/desktop/src/features/onboarding/ui/BackupStep.tsx

Having a key does **not** get you into a workspace. Joining a *community* is a second
step, and there are exactly two ways in:

1. **An admin adds your public key.** Admin-signed commands `9030 RELAY_ADMIN_ADD_MEMBER`
   / `9031 REMOVE` / `9032 CHANGE_ROLE`, with the roster published as kind `13534`
   signed by the relay's own key (`crates/buzz-admin/src/main.rs`,
   `desktop/src-tauri/src/commands/relay_members.rs`).
2. **You redeem an invite code.** Codes are `"v2." + base64url(32 random bytes)`; the
   database stores **only the SHA-256 of the code**, never the code itself; codes carry
   a TTL (min 60s, default 72h, max 30 days) and a redemption cap (max 10,000)
   (https://raw.githubusercontent.com/block/buzz/main/crates/buzz-core/src/invite.rs).
   Redemption writes the member row and a signed acceptance of the join policy in one
   transaction — "membership cannot be granted without its acceptance record"
   (`crates/buzz-db/src/relay_members.rs`).

If you are not a member, the app shows a dedicated screen: *"Ask a relay admin to add
you as a member, then come back and try again"*, with a copy button for your public key
(`desktop/src/features/onboarding/ui/MembershipDenied.tsx`).

Every connection is then authenticated per-socket with **NIP-42**: the relay sends a
random challenge, the client signs a kind `22242` event containing that challenge and
the relay's URL, and the relay checks the signature, the challenge, the URL and a
**±60 second** timestamp window. Those auth events are *never* stored or logged
"(may contain bearer tokens)"
(https://raw.githubusercontent.com/block/buzz/main/crates/buzz-auth/src/nip42.rs).
REST calls are signed the same way with NIP-98 (kind `27235`).

A second device gets your identity by **QR code + a 6-digit number you compare on both
screens** (their own spec, NIP-AB, with a formal proof file next to it). The QR carries
only a throwaway key and a session secret; the real key is encrypted; the whole session
times out in 120 seconds
(https://raw.githubusercontent.com/block/buzz/main/crates/buzz-core/src/pairing/NIP-AB.md).

#### (b) The agent's sign-in to Claude: Buzz shells out, and captures nothing

This is the "sign in with Claude, no API key" that Vikas remembers — and it is **not
part of Buzz's onboarding**. It is a button in the agent setup step that runs the
Claude CLI's own login for you.

The desktop asks the ACP adapter what login methods it offers by running
`buzz-acp auth-methods --json`. If the runtime is `"claude"` and the method id is
`"claude-login"` or `"claude-ai-login"`, it takes a special path — it runs the login
command **silently, with output sent to nowhere**, rather than opening a terminal
window. For every other runtime it opens a real terminal (`cmd /K` on Windows,
`gnome-terminal`/`konsole`/`xterm` on Linux, a temporary script via `open` on macOS).
The command it launches for Claude is of the form
`["claude", "auth", "login", "--claudeai"]`
(https://raw.githubusercontent.com/block/buzz/main/desktop/src-tauri/src/commands/agent_auth.rs).

**Buzz has no token capture, no token storage, and no completion detection in that
file. The credential stays inside Claude Code.** That matches what the harness does at
runtime: `buzz-acp` simply spawns the adapter binary and expects it to be already
authenticated — `crates/buzz-acp/src/config.rs` contains no `claude auth status`-style
check at all.

When an agent *isn't* configured, Buzz does something we should steal outright: it
starts the agent process in **"setup mode"**, where it joins the relay but instead of
working it replies to @mentions with a plain-words nudge naming exactly what is
missing — "set the *provider* field in Edit Agent dropdowns", "set `KEY` in Edit Agent →
Environment variables", "run `codex login`", "install Git for Windows"
(https://raw.githubusercontent.com/block/buzz/main/crates/buzz-acp/src/setup_mode.rs).
The broken agent tells you how to fix it, in the room, instead of failing silently.

#### (c) Side by side with Cloud9

| Point | Buzz | Cloud9 | Verdict |
|---|---|---|---|
| Human identity | A keypair generated on first run, kept in the OS keychain; you *are* your public key everywhere | One opaque string (`dev-owner-token` by default), plain text in SQLite and in `localStorage`, no expiry, no revocation (backend-assessment.md §B) | **Buzz is far better.** Ours is not authentication. |
| Getting a friend in | Invite code, hashed in the DB, with TTL and a use cap; or an admin adds their key | Invite code, stored in plain text, no expiry, no cap; known duplicate-user bug on repeat redemption | **Buzz is better**, and the fix is small: hash the code, add expiry and a use count. |
| Per-connection auth | Signed challenge every connect (NIP-42), ±60s window, auth events never logged | Bearer string replayed forever | **Buzz is better** — but only matters once we leave loopback. |
| Roles | `owner` / `admin` / `member` in a table, per community | owner vs not-owner, hardcoded | **Buzz is better.** |
| Where it listens | `0.0.0.0:3000` by default | `127.0.0.1:8787` | **Different, and ours is safer for today.** Ours only becomes a liability when we expose it. |
| Sign in to Claude | Shell out to `claude auth login --claudeai`, capture nothing | Spawn the CLI with every credential env var deliberately deleted, capture nothing (`packages/engine/src/claude-cli.ts`) | **Same answer, arrived at independently. We already match them.** |
| The stored-key fallback | `buzz-agent` (their own agent) uses `ANTHROPIC_API_KEY`; the ACP path does not | An API key, if stored, silently *outranks* the CLI login (`host.ts`, `harness.ts`) | **Different.** Ours is riskier: a pasted key silently changes who pays, with no UI saying so. |
| Where an agent runs | Separate process on your machine, spawned by the harness | Separate Node process (engine host) on your machine | **The same shape.** |
| Server + store | Rust relay, Postgres + Redis + S3, Docker Compose, TLS via Caddy | One Node file, one SQLite file, no backups, no migrations | **Buzz is better, and it is not close** — but theirs is also 100× the operational burden. |
| Multi-tenancy | Every row carries a `community_id`, resolved from the hostname, never from the client | No workspace concept at all | **Buzz is better**, and this is the single hardest thing to retrofit. |

**Two things Cloud9's own plan documents get wrong, which this study settles:**

1. `docs/plans/feature-gap.md` says Buzz onboarding is "sign in with Claude Code or
   Codex". That is the *agent* setup step, not the sign-in. The human sign-in is a
   generated keypair. Our sidebar for "how does a person get in" should be modelled on
   the invite/membership half, not on the Claude button.
2. `docs/plans/harness-signin.md` decided we should capture a `claude setup-token` and
   store it. **Buzz does not do that**, and our own code has since moved off it. That
   plan file is stale and should say so — the code (spawn the CLI, hold nothing) is the
   correct and Buzz-matching design.

---

## 2. The data model — and what our shared types are missing

### 2.1 How Buzz stores anything at all

Everything is one shape: a **signed event** with six fields — `id` (a SHA-256 hash),
`pubkey` (who), `kind` (an integer saying what sort of thing it is), `tags` (a list of
lists, the metadata), `content` (the payload) and `sig` (the signature). The `kind`
number decides routing and storage (ARCHITECTURE.md).

Kinds are banded: `0–9999` standard, `10000–19999` replaceable (only the latest
survives), `20000–29999` **ephemeral — never written to disk**, `30000–39999`
replaceable-by-name, `40000–49999` Buzz's own.

That last band is worth understanding even though we will never adopt it: it means
"typing indicator" and "presence" cost the database nothing by construction, because
the *number itself* says "don't store this". Cloud9 would have to remember that rule
by hand.

### 2.2 The tables (the part that transfers directly)

From https://raw.githubusercontent.com/block/buzz/main/schema/schema.sql — this is the
most useful single file in the whole repository for us.

**`channels`** — and look how much of this we don't have:
```sql
id, community_id, name, channel_type, visibility, description, canvas,
created_by, created_at, updated_at, archived_at, deleted_at,
nip29_group_id, topic_required, max_members,
topic, topic_set_by, topic_set_at,
purpose, purpose_set_by, purpose_set_at,
participant_hash, ttl_seconds, ttl_deadline
```
Cloud9's `Channel` is `{ id, name, kind, memberIds, createdAt }`. Missing: description,
topic (and *who* set it and *when*), purpose, visibility (open/private), archive,
soft-delete, member cap, and a time-to-live for temporary rooms.

The two enums, from
https://raw.githubusercontent.com/block/buzz/main/crates/buzz-core/src/channel.rs:
`ChannelVisibility` is `Open` ("Searchable; anyone can join without an invite") or
`Private` ("Hidden; requires an invite to join"); `ChannelType` is `Stream`, `Forum`,
`Dm` or `Workflow`. Cloud9 has only `"channel" | "dm"` and no visibility at all.

Buzz also emits a **system message** (kind 40099) into the room for every state change,
with a typed content: `member_joined, member_left, member_removed, topic_changed,
purpose_changed, visibility_changed, ttl_changed, channel_archived, channel_unarchived,
channel_created, channel_deleted, message_deleted`
(`crates/buzz-relay/src/handlers/side_effects.rs`). Cloud9 has nothing of the kind —
people appear in rooms with no explanation.

**`channel_members`** — a real membership row, not an array of ids:
```sql
community_id, channel_id, pubkey, role, joined_at,
invited_by, removed_at, removed_by, hidden_at
```
Cloud9 keeps membership as `memberIds: ID[]` inside the channel JSON. That cannot say
when someone joined, who added them, what role they have, or that they left. Every
"who could see this message at the time?" question is unanswerable in our model.

**`thread_metadata`** — the thing that makes threads cheap:
```sql
event_id, channel_id, parent_event_id, root_event_id, depth,
reply_count, descendant_count, last_reply_at, broadcast
```
Note `reply_count` and `last_reply_at` are **stored, not computed**. That is why their
channel list can show "12 replies · 3m ago" without a scan.

**`reactions`**:
```sql
event_id, pubkey, emoji, created_at, removed_at, reaction_event_id
```
Note `removed_at` — un-reacting is a soft delete, not a row deletion, so the history
stays honest.

**`users`**:
```sql
pubkey, nip05_handle, display_name, avatar_url, about,
agent_type, capabilities (JSONB), okta_user_id,
created_at, updated_at, deactivated_at, metadata_event_id,
agent_owner_pubkey, channel_add_policy
```
Two things to notice. First, **humans and agents are the same table**, distinguished by
`agent_type` and `agent_owner_pubkey`. Cloud9 has `User` and `AgentDef` as separate
types, which is why our `Channel.memberIds` has the comment "user ids and agent ids" —
we are already faking a union type. Second, `channel_add_policy`: a per-person rule for
who may drag you into a room.

**`workflow_approvals`** — the shape our approvals should grow into:
```sql
token, workflow_id, run_id, step_id, step_index,
approver_spec, status, approver_pubkey, note,
granted_at, denied_at, expires_at, created_at
```
Cloud9's `Approval` has no **expiry** and no **note**. An approval that can sit pending
forever is a task that never finishes, and a rejection with no reason teaches the agent
nothing.

**`audit_log`** — tamper-evident by construction:
```sql
community_id, seq, hash, prev_hash, action, actor_pubkey,
object_id, detail (JSONB), created_at
```
Each row's `hash` covers the previous row's hash, so removing or editing a row breaks
the chain. Written under a Postgres advisory lock so only one writer can append
(ARCHITECTURE.md). Cloud9's `ActivityRecord` has the same *fields* (actor, kind, refId,
detail, ts) but **no `seq` and no `prev_hash`** — ours is a list, theirs is a ledger.
Their own SECURITY.md is honest about the limit: "Audit Log is Tamper-Evident, Not
Resistant — detects accidental corruption but not attacks from adversaries with
database write access."

**Other tables worth knowing exist:** `relay_invites` (hashed token, role, max_uses,
use_count, expires_at), `api_tokens` (hashed, with scopes, channel scoping, expiry and
revocation), `event_mentions` (a dedicated index so "mentions of me" is one query),
`community_bans`, `moderation_reports`, `moderation_actions`, `push_leases`,
`join_policy_acceptances`, `archived_identities`.

### 2.3 The message shape

From https://raw.githubusercontent.com/block/buzz/main/crates/buzz-sdk/src/builders.rs.
A live channel message is **kind 9** (kind 40002 exists in the constants but no builder
emits it — treat it as legacy), content is plain text capped at **64 KiB**, and it
carries:

| What | Tag |
|---|---|
| Which room | `["h", "<channel-uuid>"]` — a UUID, not a hash |
| Top of the thread | `["e", "<root>", "", "root"]` |
| Direct parent | `["e", "<parent>", "", "reply"]` (a direct reply to the root carries only this one) |
| Mentions | `["p", "<hex pubkey>"]`, deduplicated, **max 50** |
| Also show in the room | `["broadcast", "1"]` |
| Attachments | `["imeta", ...]` — see below |

That `broadcast` flag is the answer to a real question in our own feature-gap doc
("does an agent reply in the thread or the channel?"). Buzz's answer: **both, and the
message says which**.

**Reactions** (kind 7): `["e", target_id]` and the emoji in `content` (≤64 chars);
custom emoji adds `["emoji", shortcode, url]` with content `:shortcode:`. There is
**no `h` tag on a reaction**. Un-reacting is a kind 5 pointing at the *reaction* event,
and the database row is soft-deleted via `removed_at` — one reaction per user per emoji
per message, enforced by a unique key
(https://raw.githubusercontent.com/block/buzz/main/crates/buzz-db/src/reaction.rs).

**Edits** (kind 40003): `["h", channel]` + `["e", target]`, new text in `content`.
Deletes are kind 9005 (`["h"]`, `["e"]`, plus optional `reason_code` / `public_reason`)
with kind 5 kept for compatibility.

**One design choice of theirs I would not copy:** the relay only checks that you are
allowed to edit — there is **no edits table and no edited-content column**. The *client*
walks the events and works out the current text, most recent edit wins
(`desktop/src/features/messages/lib/formatTimelineMessages.ts`). That is a consequence
of being an event log. Cloud9 stores rows, so we should just store `text` and
`editedAt` on the message and be done.

**Attachments are NIP-92 `imeta` tags on the message itself**, not separate events.
The relay validates them
(https://raw.githubusercontent.com/block/buzz/main/crates/buzz-relay/src/handlers/imeta.rs):
allowed keys are `url, m, x, size, dim, blurhash, alt, thumb, fallback, duration,
bitrate, image, filename`; **`url`, `m` (mime), `x` (sha256) and `size` are mandatory**;
`x` must be 64 lowercase hex; `url` must be a local `/media/` path; `filename` is 1–255
characters with no path separators; `duration`/`bitrate` are video-only.

The upload API returns a `BlobDescriptor`
(https://raw.githubusercontent.com/block/buzz/main/crates/buzz-media/src/types.rs):
```
url, sha256, size, mime_type ("type" on the wire), uploaded,
dim ("WxH"), blurhash, thumb, duration
```
`blurhash` is the little coloured smudge shown while an image loads; `thumb` is a
generated thumbnail; `duration` is video length. Files are addressed by their SHA-256,
so the same file uploaded twice is stored once. Upload is authorised by a signed kind
24242 event in an `Authorization: Nostr <base64>` header, with a one-hour freshness
window (`crates/buzz-relay/src/api/media.rs`).

### 2.4 The full kind list, grouped by what it means

From https://raw.githubusercontent.com/block/buzz/main/crates/buzz-core/src/kind.rs.
Read this as **a checklist of concepts a mature chat app turns out to need**, not as
something to implement.

Two warnings before reading it: **kind 9 is the live message kind** (40002 is defined
but unused), and **49001 is not a wire kind at all** — kind.rs says verbatim "Internal
kind for media upload audit entries. Not a relay event kind."

| Area | Kinds |
|---|---|
| Chat | **9** message (40002 legacy), 40003 edit, 9005 / 5 delete, 7 reaction, 40004 pin, 40005 bookmark ("save for later"), 40006 scheduled send, 40007 reminder, 40008 diff, 40099 system message ("X joined") |
| Threads / paging | 39005 thread summary (reply counts, participants), 39006 window bounds (pagination cursor) |
| DMs | 41001 created, 41010 open, 41011 add member, 41012 hide, 30622 per-viewer hidden-set |
| People | 0 profile, 30315 status ("in a meeting"), 20001 presence, 20002 typing, 10000 mute list, 10001 pins, 10003 bookmarks, 10030 + 30030 custom emoji, 30078 **read state** |
| Files | 1063 file metadata, 49001 upload audit, 24242 upload auth |
| Canvas | 40100 |
| Agents | 10100 agent profile, 30175 persona, 30176 team, 30177 managed agent, 30174 **agent memory**, 24200 agent telemetry, 44200 **token/cost record**, 43001–43006 job protocol (request / accepted / progress / result / cancel / error) |
| Workflows | 30620 definition, 46001–46007 lifecycle, 46010–46012 approval requested/granted/denied, 46020 trigger, 46030/46031 grant/deny |
| Git | 30617 repo, 30618 refs, 1617 patch, 1618 PR, 1619 PR update, 1621 issue, 1630–1633 status open/merged/closed/draft |
| Governance | 48001 audit entry, 1984 report, 9040–9044 ban/unban/timeout/untimeout/resolve, 9030–9033 membership admin, 13534 roster |
| Voice | 48100–48106 huddles |
| Notifications | 30350 push lease, 44100/44101 added/removed from channel |

### 2.5 The blunt list: what `packages/shared/src/index.ts` is missing

This is the highest-value output of this study. Ordered by how much it hurts.

**Missing from `Message`:**
1. `replyToId` / `threadRootId` — no threading is possible without them.
2. `editedAt` — you cannot show "(edited)".
3. `deletedAt` — a deletion has to be a tombstone or the audit log starts lying.
4. `attachments: BlobDescriptor[]` — no files at all today.
5. Reactions — not a field, a separate list keyed by `(messageId, userId, emoji)` with
   a `removedAt`. Buzz proved the soft-delete matters.
6. Nothing marks a message as "this is the result of task X". Buzz has a whole job
   protocol (43001–43006) linking a request to its progress and result.

**Missing from `Channel`:**
7. `description`, `topic` (+ who set it, when), `purpose` — a room cannot say what it
   is for.
8. `visibility: "open" | "private"` — every Cloud9 channel is effectively private, so
   there is no browse-and-join.
9. `archivedAt` — no way to retire a room without losing it.
10. Membership as rows, not an id array: `role`, `joinedAt`, `invitedBy`, `removedAt`.

**Missing entirely — no type exists:**
11. **Read state.** Ours lives in one browser's `localStorage`. Buzz's is a signed,
    encrypted, per-device blob (`kind 30078`) with a beautifully simple merge rule:
    each conversation keeps the **highest timestamp seen across all your devices**, so
    devices converge with no coordination at all
    (https://raw.githubusercontent.com/block/buzz/main/docs/nips/NIP-RS.md). Copy that
    rule exactly; it is about twenty lines.
12. **Presence and typing** for humans.
13. **Search.** No index, no query type, no filters.
14. **Pins and saved messages.**
15. **Agent memory.** See §3.
16. **Cost and token accounting per agent turn.** See §3.
17. **Per-channel notification settings** (mute one noisy room).
18. **Custom emoji.**
19. **Reminders.**
20. **Schema version.** Buzz partitions events by month and has a migration crate;
    Cloud9's SQLite has no version column at all, so our first schema change is a
    hand-repair job (already flagged in backend-assessment.md §D9).

**Missing from `Approval`:** an `expiresAt` and a free-text `note` from the decider.

**Missing from `ActivityRecord`:** a `seq` and a `prevHash`. Without those it is a list
of claims, not a record.

---

## 3. Agents

### 3.1 How an agent is defined

Two layers, and they are separate on purpose.

**The persona** (their NIP-AP, kind `30175`,
https://raw.githubusercontent.com/block/buzz/main/docs/nips/NIP-AP.md) is public
configuration, stored as plain JSON:

```json
{
  "display_name": "<string>",
  "system_prompt": "<string | null>",
  "avatar_url": "<string | null>",
  "runtime": "<string | null>",
  "model": "<string | null>",
  "provider": "<string | null>",
  "name_pool": ["<string>"],
  "respond_to": "<string | null>",
  "respond_to_allowlist": ["<64-hex pubkey>"],
  "parallelism": "<integer | null>"
}
```

Only `display_name` is required. The event carries one tag, `["d", "<persona-slug>"]`,
where the slug matches `^[a-z0-9][a-z0-9_-]{0,63}$`. The spec is explicit that
**secrets are forbidden here** — "API keys/credentials prohibited" — and personas are
author-only unless the owner adds a `["shared","true"]` tag.

Compare with Cloud9's `AgentDef`. We have `name`, `emoji`, `persona`, `abilities`,
`provider`, `model`, `skills`, `approvals`, `lifecycle`. **Buzz has three fields we
don't, and all three are ones we will want:**

- `respond_to` + `respond_to_allowlist` — *who is allowed to make this agent work*.
  Ours has no such thing: if a friend is in the channel, they can drive any of my
  agents, on my subscription. That is a real hole, and it is cheap to close.
- `parallelism` — how many turns this agent may run at once.
- `name_pool` — cosmetic; ignore.

Conversely **Cloud9 has two things Buzz's persona does not**: `abilities` (our
web-search / files / schedules / background switches) and `approvals`. Those are ours
to keep.

The second layer is **the runtime**: which program actually thinks. Configured by
environment, not files — `BUZZ_ACP_AGENT_COMMAND` (default `goose`), plus
`BUZZ_ACP_MODEL`, `BUZZ_ACP_SYSTEM_PROMPT`, `BUZZ_ACP_IDLE_TIMEOUT` (default 620s) and
`BUZZ_ACP_MAX_TURN_DURATION` (default 7200s — two hours)
(https://raw.githubusercontent.com/block/buzz/main/crates/buzz-acp/README.md). Cloud9's
equivalent timeouts are 180s for Claude and 120s for Codex, which is *far* shorter;
worth knowing if we ever want an agent to do real work rather than answer a question.

### 3.2 How it is invoked, and what it can do

An agent has **its own keypair** and its own channel memberships. You add it to a room
the way you add a person. It sees a message when it is @mentioned — technically, a
kind 9 event with the agent's public key in a `#p` tag. Events queue per channel, one
prompt in flight at a time, and the harness batches anything that arrived while it was
busy into a single turn (buzz-acp README).

What it can *do* is whatever `buzz-cli` exposes, which is close to everything a person
can do (https://raw.githubusercontent.com/block/buzz/main/crates/buzz-cli/README.md):

> `messages` (send, edit, delete, get, thread, search, vote, send-diff) · `channels`
> (list, create, join, topic, members, archive, delete) · `users` · `reactions` ·
> `dms` · `workflows` (list, trigger, **approve**) · `canvas` · `mem` · `repos`

All output is JSON on stdout, errors JSON on stderr, with a proper exit-code table
(0 ok, 1 user error, 2 network, 3 auth, 4 other, 5 write conflict). It authenticates
with its own key via NIP-98 — no shared secret, no impersonation of the owner.

**This is the design idea worth stealing from Buzz above all others:** give the agent a
tool surface that is *the same protocol the humans use*, so an agent creating a channel
or reacting to a message is indistinguishable from a person doing it — including in the
audit log.

### 3.3 What it remembers

Buzz has real, durable agent memory: **NIP-AE, kind `30174`**
(https://raw.githubusercontent.com/block/buzz/main/docs/nips/NIP-AE.md,
https://raw.githubusercontent.com/block/buzz/main/crates/buzz-core/src/engram.rs).

- Two record types: exactly one `core` record holding the agent's identity, rules and
  goals, and any number of `mem/<slug>` records holding `{ slug, value }`.
- Slugs are paths: `^mem/[a-z0-9][a-z0-9_-]{0,63}(/[a-z0-9][a-z0-9_-]{0,63})*$`,
  ≤255 bytes total.
- Setting `value: null` writes a **tombstone** rather than deleting.
- Content is **encrypted to the owner** (NIP-44), max 65,535 bytes, and the storage key
  is an HMAC of the slug — so the relay cannot even see what an agent remembers *about*.
- The agent manages it itself: `buzz mem ls / get / set / patch / rm`.

Separately, the session has short-term memory with a **handoff**: when history passes
`BUZZ_AGENT_MAX_HISTORY_BYTES` (default 1 MiB) the agent summarises its own conversation
and continues, up to `BUZZ_AGENT_MAX_HANDOFFS` (default 10), then truncates
(https://raw.githubusercontent.com/block/buzz/main/crates/buzz-agent/README.md).

**Cloud9 has neither.** Our agents remember nothing between turns except whatever the
prompt builder puts in front of them.

### 3.4 What it records about what it did

Three separate streams, and the split is thoughtful:

1. **Telemetry, live and disposable** — kind `24200`, ephemeral, encrypted to the
   owner. Every ACP frame, every tool call, every reasoning step, sequence-numbered so
   you can tell if you dropped one. "Relays MUST NOT persist kind 24200 events to any
   durable storage" and must keep them out of search and out of the audit log. The same
   channel carries control the other way: the owner can send `{"type":"cancel_turn"}`
   (https://raw.githubusercontent.com/block/buzz/main/docs/nips/NIP-AO.md).
2. **Cost, durable** — kind `44200`, encrypted to the owner, one per turn: `harness`,
   `model`, `channelId`, `sessionId`, `turnId`, `turnSeq`, `stopReason`, and both
   per-turn and cumulative `inputTokens` / `outputTokens` / `totalTokens` / `costUsd`,
   plus a `deltaReliable` flag for when the baseline is unknown. The spec insists a
   missing number stays null: "a null MUST NOT be recorded or summed as zero"
   (https://raw.githubusercontent.com/block/buzz/main/docs/nips/NIP-AM.md).
3. **The audit log** — kind `48001` and the hash-chained `audit_log` table.

Item 1 is exactly what our own coverage audit already ranks as Cloud9's #1 gap
("show what an agent actually did"). Buzz's design decision is the useful part:
**stream it live and throw it away; keep only the cost record and the audit entry.**
That avoids the trap of storing megabytes of tool chatter per turn.

### 3.5 Handoff to other agents

`crates/buzz-agent/src/handoff.rs` exists, and `buzz-persona` provides `KIND_TEAM`
(30176) and `KIND_MANAGED_AGENT` (30177) to group agents. The documented handoff in
`buzz-agent`'s README is the agent handing off **to itself** when context fills.
**Agent-to-agent delegation: UNKNOWN** — I found the kind numbers and the file name but
no specification of the shape (NIP-AP does not describe 30176 or 30177).

### 3.6 Approvals — where Cloud9 is genuinely ahead

There are two different "approval" ideas in Buzz and **both are weaker than ours**.

**(a) Workflow approval gates.** Kinds exist (46010 requested, 46011 granted, 46012
denied, 46030/46031 grant/deny), a `RequestApproval` action exists in the workflow
schema with `from` / `message` / `timeout` (default 24h), a `workflow_approvals` table
exists, and `buzz workflows approve` exists in the CLI. And yet their own
ARCHITECTURE.md "Known Gaps" says:

> "Approval gates in workflows return `Suspended` but runs are marked `Failed` before
> persisting approval rows."

In plain words: **when a workflow hits an approval step, the run is recorded as failed
before the thing you are supposed to approve is even saved.** So the gate stops the
work but there is nothing left to approve. That is what the README means by "infra
exists, glue still drying". Every piece is built except the one that joins them.

**(b) Tool-call permission, for agents.** This is the more serious one.
`BUZZ_ACP_PERMISSION_MODE` defaults to **`"bypass-permissions"`**
(https://raw.githubusercontent.com/block/buzz/main/crates/buzz-acp/src/config.rs), and
`pool.rs` describes the fallback as "per-tool auto-approval in
`handle_permission_request`". **No human is asked before an agent runs a tool.** Their
SECURITY.md declines to cover this: "The policy does not address agent capability
restrictions, workflow permissions, or risks specific to self-hosted deployments."

Cloud9's approvals, by contrast, work end to end: `requiresApproval()` gates the task,
the task sits in `waiting_approval`, `decideApproval` is owner-only, and a decided
approval cannot be re-used (`apps/relay/src/server.ts:410–420, 474–479, 737–745`).

Their access-control model is also flatter than it looks. SECURITY.md:
> "Channel membership is the **only** access control mechanism"

That is elegant — "scoped by identity, not by permission flags", as the README puts it —
and it is why they need no per-agent capability system. It also means an agent in a
channel can do anything in that channel.

---

## 4. The features Vikas would notice

Effort estimates are **my judgement for Cloud9's codebase**, not anything Buzz says.
Small ≈ under a day, medium ≈ a few days, large ≈ a week or more.

| Feature | What it does in Buzz | Roughly how it is built | Our job |
|---|---|---|---|
| **Threads** | Reply under a message; channel shows "N replies · 3m ago" with the faces of who is in it. A reply can be flagged to also appear in the room. | `e` tags carrying root + parent; a `thread_metadata` row **caching** reply_count / descendant_count / last_reply_at / depth; a relay-computed summary (kind 39005: `{reply_count, descendant_count, last_reply_at, participants}`, participants capped at 10 and ordered most-recent-first) and a paging cursor (kind 39006: `{has_more, next_cursor:{created_at,id}}`). The whole reason for the extra protocol, in their own words, is that a plain filter "cannot express *non-reply messages*", so clients were downloading everything and rebuilding threads themselves. | **Medium.** Two fields on `Message`, one counts table, and a rewrite of the message list. Take three lessons: cache the counts, cap the participant list, and page with a **`(timestamp, id)` pair** rather than a timestamp alone — Buzz hit real bugs from two messages sharing a second (see their open issue #3468). The `broadcast` flag answers the "thread or channel?" question for agent replies. |
| **Reactions** | 👍 on a message, custom emoji supported | `reactions` table keyed `(event_id, pubkey, emoji)` with `removed_at` for un-reacting | **Small.** Copy the table shape including the soft delete. |
| **Editing / deleting** | Edit shows "(edited)"; delete is a tombstone | Kind 40003 edit pointing at the original, kind 5 deletion; original row keeps `deleted_at` | **Small.** |
| **Attachments** | Drag a file in; images get thumbnails and a blur placeholder; videos show duration | S3/MinIO via the Blossom protocol, addressed by SHA-256, upload authorised by a signed kind 24242 event; `BlobDescriptor` carries `sha256, size, mime_type, dim, blurhash, thumb, duration` | **Medium**, and the storage question is ours to answer (a folder next to the SQLite file is fine for one PC). Copy the descriptor shape verbatim — it is exactly right. |
| **Search** | Search conversations, patches, workflow runs and approvals in one box | Postgres full-text on a **generated column**: `search_tsv` is `to_tsvector('simple', content)` — content only, no tags, no stemming — and it is forced to `NULL` for private kinds (1059 wrapped DMs, 30300 reminders, 30350 push leases, 30622 DM visibility, 44100/44101 membership notices, 44200 cost records). Queries always scope to the community, skip deleted rows, rank with `ts_rank_cd`, and support filters on kind, author, date and channel. The code says "search is never the access boundary — it cannot widen visibility": results are refetched and re-authorised before return. | **Medium.** SQLite FTS5 does this well. **Copy the two rules, not the plumbing:** (i) decide *at write time* which things are never indexed, and (ii) treat the index as a hint — always re-check permission on the rows you are about to show. |
| **Canvases** | A shared document per channel | Kind 40100, one tag `["h", channel_id]`, and the **whole document as markdown in the content**. It is stored as a single `canvas` TEXT column on the channel row. **There is no CRDT and no operational transform — last write wins, and the loser's edits are gone.** | **Medium-large, and not recommended** — see §5. Worth knowing how thin it is: if we ever wanted one, "a markdown box attached to a channel" is honestly the whole feature. |
| **Media comments** | Comments pinned to a video frame, shown as markers on the scrubber | **Far simpler than it looks, and this is the nicest trick in the repo.** There is no event kind, no frame tag, no anchor field. A comment is an ordinary threaded reply whose text begins with a timecode — `[01:23] the audio drops here`. The player matches `/^\s*\[((?:(?:\d{1,2}:)?\d{1,2}:)?\d{2}(?:\.\d{1,3})?)\]\s*/`, strips it, renders it as a clickable seek button, and draws the author's avatar on the timeline at that position (`desktop/src/shared/ui/VideoPlayer.tsx`). | **Small — once we have attachments and threads.** It is a regular expression and a click handler. No data-model change at all. Put it on the "copy" list. |
| **Audit log** | Every action, hash-chained | `audit_log(seq, hash, prev_hash, action, actor, object_id, detail)`, single-writer via advisory lock. Each hash is SHA-256 over, in order: community id → sequence number → timestamp → action → actor (with a presence byte) → object id (presence byte) → detail as canonical JSON with sorted keys → the previous hash, or an all-zero genesis value for the first row. Community id goes first so "an entry cannot be lifted out of one community's chain and re-verified inside another." Actions are a fixed list: `event_created, event_deleted, channel_created, channel_updated, channel_deleted, member_added, member_removed, auth_success, auth_failure, rate_limit_exceeded, media_uploaded`. | **Small.** We already write activity rows; adding `seq` + `prevHash` is an afternoon and it turns our log into a record. Copy the hashing recipe exactly, including the presence bytes and sorted-key JSON — those details are what stop two different rows hashing the same. |
| **Workflows** | YAML automation | Triggers: `message_posted` (with an evalexpr filter), `reaction_added`, `diff_posted`, `schedule` (cron or interval, ≥60s), `webhook`. Actions: `send_message`, `send_dm`, `set_channel_topic`, `add_reaction`, `call_webhook`, `request_approval`, `delay`. Steps have `id`, `if`, `timeout_secs` (https://raw.githubusercontent.com/block/buzz/main/crates/buzz-workflow/src/schema.rs) | **Large, and mostly not recommended.** But our existing agent schedules are already 60% of `trigger: schedule`, and "react with ✅ to trigger X" is a genuinely nice small feature. |
| **The Git forge** | A branch becomes a channel; patches, CI results and the merge decision live in the room; Git hosting over Smart HTTP with your public key as your login; commits signed with your Nostr key | NIP-34 kinds 1617/1618/1621/1630-1633, `buzz-protect` tags on the repo announcement enforced by the relay | **Large, and firmly not recommended.** Spec §14 already excludes a code-hosting platform. |
| **Read state** | Unread marks follow you between machines | Kind 30078, encrypted per-device blob, merged by "highest timestamp wins per conversation" | **Small, and the highest value-per-hour item on this table after markdown.** Our unread state is per-browser today. |
| **Presence / typing** | Live, costs nothing | Ephemeral kinds 20001/20002 in Redis with a 90s presence TTL and a 5s typing window | **Small.** |
| **Push notifications** | Wake the phone without the server learning anything | Kind 30350 "push lease": the relay sends only a fixed reconnect signal — "never relay-supplied bytes, event ids, event content" — and the phone reconnects and fetches normally | **Not now** (our push is a stub and we have no Apple account), but the *design* is the right one and costs nothing to adopt later. |
| **Huddles (voice)** | Kinds reserved | README lists "Huddle lifecycle events" as unfinished | **Not recommended.** Spec §14 excludes voice. |
| **Setup-mode nudges** | A misconfigured agent joins the room and tells you what's missing | Alternate start path triggered by an env payload | **Small, and delightful.** Directly fixes our "my engine isn't connected" dead end. |
| **Keep the PC awake** | `preventSleepActivity.ts` in the desktop app | — | **Small.** Partly answers backend-assessment §D1 ("agents stop when the PC sleeps") without moving anything to a server. |

---

## 5. What to copy, what to skip, what to do differently

For Cloud9's actual user: one person, a few friends, a crew of agents, one Windows PC.

### Copy — in this order

1. **Read-state merge (kind 30078's rule).** Move last-read off `localStorage` onto the
   relay, one row per `(user, channel)`, merged by "highest timestamp wins". About
   twenty lines of logic, and it fixes a daily annoyance. *Small.*
2. **The `BlobDescriptor` field list**, when we do attachments:
   `sha256, size, mimeType, dim, blurhash, thumb, duration`. Content-address by hash so
   the same screenshot pasted twice is stored once. *Comes free with the feature.*
3. **`reactions` with `removedAt`**, not row deletion. *Small.*
4. **Thread counts stored, not computed** — `replyCount` and `lastReplyAt` cached on
   the parent. Buzz built a whole extra protocol (NIP-CW) because they learned that
   recomputing threads on read does not scale. *Comes free with threads.*
5. **`seq` + `prevHash` on our activity log.** Turns a list into a ledger. *Small.*
6. **`respond_to` + `respondToAllowlist` on `AgentDef`.** Right now any friend in a
   channel can spend Vikas's Claude subscription. Buzz gates this per agent. *Small,
   and it is a security fix, not a feature.*
7. **Setup-mode nudges.** When a harness isn't signed in, have the agent post *what to
   do* in the channel — "run `codex login` in a terminal, then ask me again" — instead
   of "my engine isn't connected". *Small.*
8. **The three-stream agent record**: stream tool activity live and discard it, keep a
   small durable cost row per turn (`model, tokens in/out, costUsd, stopReason`), keep
   an audit entry. This is our #1 ranked gap and Buzz has already solved the "don't
   drown in logs" part. *Medium.*
9. **Expiry + a note on approvals.** An approval that can never time out is a task that
   never ends. *Small.*
10. **Channel `description` / `topic` / `visibility` / `archivedAt`, and membership as
    rows with `role`, `joinedAt`, `invitedBy`, `removedAt`.** This is the schema change
    that unblocks browse-and-join, roles, and any honest "who could see this?" answer.
    *Medium — and worth doing before the message-feature work, because everything else
    hangs off it.*
11. **Hash the invite code, give it an expiry and a use cap.** Buzz stores only the
    SHA-256 of the code. Ours is plain text, unlimited, forever — and it has a known
    duplicate-user bug. *Small, and it is on the critical path for ever exposing the
    hub.*
12. **Decide what is never indexed, at write time.** When we build search, DMs and any
    future agent memory should be excluded at the storage layer, the way Buzz does it —
    not filtered at query time, where one forgotten `WHERE` leaks everything. And treat
    the index as a hint: re-check permission on the rows before showing them.
13. **`preventSleep` while an agent is working.** *Small.*
14. **Timecode comments on video and audio** — `[01:23] the audio drops here` in an
    ordinary reply, turned into a clickable seek button and a marker on the scrubber.
    A regular expression and a click handler, no schema change. *Small, once we have
    attachments.*
15. **System messages in the room** for joins, leaves, topic changes and archives —
    Buzz's kind 40099 with a typed reason. Cheap, and it stops rooms silently changing
    under you. *Small.*
16. **Page with `(timestamp, id)`, never timestamp alone.** Buzz has an open bug
    (#3468) from two events sharing a second. Our `newId()` already embeds the
    millisecond, so this costs nothing to get right first time. *Free if done now.*

### Skip — deliberately, with the reason

- **Nostr itself.** Signed events, keypairs, relays, NIPs. It buys portable identity
  across servers you don't control and interoperability with other Nostr apps. Vikas
  has one PC and four friends; he needs neither, and the cost is that *every* feature
  becomes a protocol design exercise. Their `kind.rs` is a 41 KB file of integer
  constants. Take their **shapes**, not their **substrate**.
- **Postgres + Redis + S3 + Docker.** Correct for a company with a VPS and an on-call
  rota. For one PC it is four more things that can be broken at 11pm. SQLite plus a
  folder does everything above.
- **The Git forge.** A different product for a different person. Spec §14 already
  excludes it.
- **Canvases.** A second product surface. Buzz's own is thin — a `canvas` TEXT column
  on the channel row plus one event kind carrying the whole markdown document, with
  **last-write-wins and no merge**. Two people editing at once silently lose work. Not
  what a network engineer chatting with friends needs before threads and files, and not
  a design worth reproducing as-is.
- **Huddles / voice.** Unfinished in Buzz, excluded by our spec §14.
- **The full YAML workflow engine.** Seven action types, an expression language, a
  scheduler, approval gates that don't work yet. Our agent schedules already cover the
  useful 60%. If one piece is worth lifting it is `reaction_added` as a trigger —
  "react ✅ to approve" is a lovely interaction and needs no engine.
- **Multi-tenancy (`community_id` on every row).** Only if Cloud9 ever becomes a
  product for strangers. That is open question Q-D in `feature-gap.md` and is still
  unanswered. Do **not** pre-build it.
- **Web-of-trust reputation.** Their own README files this under "Strong opinions,
  pending code".

### Do differently — where Buzz is wrong for us

1. **Do not adopt `bypass-permissions`.** Buzz's ACP harness auto-approves every agent
   tool call by default and its security policy doesn't cover the consequences. Our
   approvals work and our command-line allowlist (`run.ts`) is genuinely careful. That
   is our advantage over Buzz — keep it and say so.
2. **Do not bind to `0.0.0.0` by default.** Buzz does (`BUZZ_BIND_ADDR=0.0.0.0:3000`)
   because it is a server product. Cloud9 spawns programs on Vikas's PC. Loopback by
   default, and an explicit, deliberate act to change it — with the
   `dev-owner-token` default and the `CLOUD9_DEV=1` bypass removed **first**
   (backend-assessment.md §E, step 2).
3. **Fix our credential precedence.** In Cloud9 a stored API key silently outranks the
   CLI login, so pasting a key quietly changes who pays with nothing on screen saying
   so. Buzz has no such trap because its ACP path holds no credentials at all. Either
   drop the stored-key path or make the settings screen state plainly which one is
   paying.
4. **Do not put a two-hour agent turn timeout in.** Buzz allows 7200s. Our 180s/120s is
   sane for chat; raise it deliberately per task type if we ever need long jobs, not
   globally.
5. **Do not copy their approval design.** It is the one part of Buzz that is broken —
   the run is marked failed before the approval row is written. Ours is simpler and it
   works. If we extend it, extend our own.
6. **Keep human and agent as one member concept.** Buzz puts both in `users` with an
   `agent_type` and an `agent_owner_pubkey`. Cloud9 has two separate types and already
   fakes the union inside `Channel.memberIds`. Buzz's way is less code and it makes
   "who did this?" answerable with one lookup. This is a refactor, so do it before the
   membership-rows change in copy-item 10, not after.

### The single highest-value thing on this page

Not a feature: **item 10, the channel/membership schema change.** Threads, reactions,
files, search, roles, browse-and-join and any honest audit trail all sit on top of it.
Doing it after those features means doing them twice.

And the cheapest genuine win remains the one `feature-gap.md` already found — render
the markdown people are already typing. Buzz has nothing to teach us there; we simply
have a bug.

---

## 6. What I could not establish

Written plainly rather than guessed:

- **Agent-to-agent handoff.** `handoff.rs` exists and kinds 30176 (team) / 30177
  (managed agent) exist, but NIP-AP documents neither. The documented handoff is an
  agent summarising its own history. Cross-agent delegation: **UNKNOWN**.
- **Where the relay writes a canvas.** The event kind and the column are clear; the
  code path joining them was not found: **UNKNOWN**.
- **Whether kind 48001 (audit entry) is ever actually published** as an event — the
  audit service writes only Postgres rows and no emitter was found: **UNKNOWN**.
- **Whether kind 1063 (file metadata) is ever produced.** No builder emits it;
  attachments travel as `imeta` tags instead: **UNKNOWN**.
- **Why kind 40002 exists alongside kind 9** for messages: **UNKNOWN**. (GitHub code
  search needs a login, so the whole repo could not be grepped.)
- **NIP-43 (relay membership) has no written spec in the repo** — the file 404s; the
  name appears only inside code.
- **Where the relay refuses a non-member after a successful NIP-42 handshake**:
  **UNKNOWN** (the code path behind their "MembershipDenied" screen was not found).
- **Their ARCHITECTURE.md and their code disagree** on roles: the doc lists Owner /
  Admin / Member / Guest / Bot and soft-delete on membership; `relay_members.rs`
  implements only owner / admin / member. Which is current: **UNKNOWN**.
- **Rate limiting.** Their own ARCHITECTURE.md says it is "designed but not enforced
  (only a test stub exists)". Worth knowing before anyone cites Buzz as a security
  model.
- **Which version of Buzz Vikas has installed, and which parts he actually uses.** This
  remains the single most useful thing he could tell us, and it is question Q-B in
  `feature-gap.md`. Nothing on this machine was inspected to find out.
