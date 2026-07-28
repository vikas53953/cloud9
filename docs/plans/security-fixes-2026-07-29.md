# Security fixes — 2026-07-29

Round of fixes for the code review of commit `4d8ea0a`. Every finding below was
fixed at the **class** level: the rule that made the bug possible was changed,
not just the one line where it showed up.

**Verification:** `npm run build` clean (now including `apps/desktop`).
`npm test` green — **89 → 96 engine**, **13 → 23 relay** (102 → 119 total).
Every new test was run against the unfixed code first and observed to fail.

Owned files this round: `apps/relay/src/**`, `packages/shared/src/**`,
`packages/engine/src/**`, `scripts/**`, root `package.json`. Nothing under
`apps/desktop/` was touched — renderer work is handed off at the bottom.

---

## P0 #1 — invite de-duplication let anyone become the owner — **FIXED**

**What was wrong.** `store.ts:redeemInvite` resolved the redeemer with
`userByName(name)` whenever the invite row had no `usedBy` yet. `userByName`
matched case- and space-insensitively, so a guest who typed the owner's display
name was handed **the owner's account** and a durable token for it — harness
sign-in (spawning processes on this machine), `removeUser`, approvals, agent
CRUD. And `createInvite` had no owner gate, so a guest could mint exactly the
unused code the attack needed.

**The class fix — identity is never derived from a display name.**

- `userByName` is **deleted**, not just unused. A comment stands where it was
  saying why it must not come back.
- `redeemInvite` de-duplicates strictly on the invite row's own `usedBy`, and a
  spent or revoked row returns nothing at all.
- The account that comes out of a redemption is always **freshly created**. The
  name in `invite:<code>:<name>` is a label for the screen, never a claim.
- `createInvite` is owner-only (`server.ts`).
- Audited the rest of `store.ts` for other name-as-identity uses: the only
  remaining name lookup is `channels().find(c => c.name === "general")`, which
  picks a room, not a person, and grants nothing.

**Proof.** `apps/relay/src/security.test.ts` →
`PoC: a guest cannot become the owner by typing the owner's name` — the
reviewer's proof-of-concept, automated: guest joins, is refused an invite of her
own, redeems an owner-issued code claiming the name "Vikas", and must come out
as an ordinary guest with none of the owner's powers and a token that belongs to
her. Plus `case and spacing games on a name buy nothing either`.

---

## P1 #2 — a used invite code was a permanent bearer credential — **FIXED**

**What was wrong.** A spent code kept minting fresh tokens forever, with no way
to revoke it. Worse, both invite codes and tokens came from `newId()`, which is
`Date.now()` plus `Math.random()` — a timestamp and a non-cryptographic
generator, used as authentication secrets.

**The class fix.**

- New `apps/relay/src/secureid.ts`: `secureId()` (128 bits) and `secureToken()`
  (256 bits) from `node:crypto` `randomBytes`. It is the **only** place a value
  that opens a door is minted.
- `newId()` survives for ordinary labels (messages, channels, agents) and now
  carries a doc comment pointing anything security-sensitive at the secure pair.
  Two separate functions means the choice is visible at every call site.
- Invites are **single-use**: `invites` gains `usedAt` and `revoked` columns,
  with a migration that also marks every already-spent invite revoked, so an
  existing database cannot carry the old behaviour forward.
- `store.revokeInvite(code)` exists for retiring a code on demand.

**Trade recorded:** re-opening a spent invite link is no longer a re-login. A
returning person comes back on the durable token their client stored; if they
lost it, the owner issues a new invite. A code that can be redeemed twice is a
password that can never be changed.

**Proof.** `a spent invite code is dead — it never mints another sign-in` and
`invite codes and tokens come from real randomness, not Math.random`
(200 codes, all unique, all `inv_` + 22 url-safe chars, no shared timestamp
prefix).

---

## P1 #3 — `removeUser` re-armed the invite — **FIXED**

`store.ts:removeUser` set `usedBy = NULL`, handing the code back to whoever
still had it: "remove this person" quietly meant "let them back in".

Now it **revokes**: `UPDATE invites SET revoked=1 WHERE usedBy=? OR createdBy=?`
— both the code they came in on and any code they created and had not yet given
away.

**Proof.** `a removed person's invite code does not let them back in` — checks
the row is revoked, that re-redeeming gets no welcome, and that their old
durable token is dead too.

---

## P1 #4 — every Codex turn threw for any path with a space — **FIXED**

`codex.ts` pushed `"-C", shellQuote(cwd)`. `run()` then re-applied `checkArg` to
every argument, saw the quote characters `shellQuote` had just added, and
rejected the whole command with `UnsafeArgumentError` — which the engine posted
into the chat. Two layers both trying to be careful produced something neither
would accept. `claudeArgs` was immune because it never puts a path in argv.

**The class fix — quoting has exactly one owner: `run.ts`.** `codexArgs` hands
over the plain path and nothing else; the cwd also travels through
`RunOptions.cwd`, as the Claude path does it.

**Tests.** The old test at `codex.test.ts:89-92` asserted the *bug* (that
`codexArgs` returns a quoted string) — it is **deleted** and replaced by:

- `codexArgs hands over the plain path — it never pre-quotes`
- `a Codex turn survives a user folder with a space in it, end to end through run()`
  — builds the argv and pushes it through the **real** `run()` with
  `C:/Users/Vik As/…`; it must reach the point of failing only on a missing
  command, which is what proves the argument checker accepted it
- `a path run() would refuse is still refused — the leash did not loosen`
  (a `&&` in the path still throws `UnsafeArgumentError`)

---

## P1 #6 — any user could drive the owner's agents — **FIXED**

`createTask` checked only that the agent existed, and took `needsApproval`
straight from the client frame.

**The class fix — authorisation is decided server-side from stored state,
never from a client-supplied flag.** Two new helpers in `server.ts` are now the
single gate for the whole protocol:

- `myAgent(userId, agentId)` — the agent exists **and** you own it.
- `channelFor(userId, channelId)` — the conversation exists **and** it is yours.

Applied to every frame that acts on an agent, a task or a channel:

| frame | before | now |
|---|---|---|
| `createTask` | agent exists | your agent **and** your channel |
| `createTask` approval | `frame.needsApproval` | `requiresApproval(agent, title)` from the agent's stored `approvals` |
| `createTask` approval text | `frame.action` (client's wording) | `describeApproval(task.title)`, built server-side |
| `cancelTask` | **no check at all** | requester or the agent's owner |
| `agentStatus` | **no check at all** | your agent |
| `agentSend` | your agent | your agent **and** your channel |
| `addMembers` | channel exists | your channel |
| `updateAgent` / `deleteAgent` | inline ownership check | same check, via `myAgent` |

`requiresApproval` also reads the right switch for the kind of work
(`approvals.schedules` for a `!schedule …` task, `approvals.background`
otherwise), so the schedule-approval path keeps working.

**Proof.** `a guest cannot drive the owner's agents` (task refused, none stored;
status lamp refused) and `the approval gate is the agent's setting, not the
client's claim` (`needsApproval:false` still lands in `waiting_approval`, and
the owner reads the real work, not the client's flattering description).

---

## P1 #7 — `welcome` shipped every channel's messages to every user — **FIXED**

**The class fix — one gate for "is this conversation yours?"**

- `store.recentMessages(channels, perChannel)` now **requires** a channel list.
  There is no "walk everything" mode left to forget; `worldFor` passes
  `visibleChannels(userId)`.
- `history` calls `channelFor` before answering.
- `send` calls `channelFor` before posting.
- Bonus, same class: channel objects are announced with a new
  `broadcastChannel()` that reaches members only. Broadcasting every channel to
  everyone told the whole house who was DM-ing whom — a private room's member
  list is itself private.

**Proof.** `a guest is never handed another channel's messages` — a third person
joins after a private room exists, and must not see it in `welcome`, must not be
able to fetch its history by id, must not be able to post into it; a real member
still can.

---

## P2 #9 — Codex inherited the whole ambient environment — **FIXED**

`codex.ts` passed `env: undefined`, meaning "inherit everything", while
`claude-cli.ts` stripped credential variables.

**The class fix — one shared helper, new `packages/engine/src/env.ts`.** Both
providers call `envWithoutCredentials(base, extra)`. `claude-cli.ts` re-exports
`CREDENTIAL_ENV_VARS` / `envWithoutCredentials` so existing importers are
unchanged. The Codex API-key fallback is applied as `extra`, *after* the
stripping, so it is the only credential that survives.

**Proof.** `the codex turn never inherits ambient credentials` — an ambient
`ANTHROPIC_API_KEY` and `GITHUB_TOKEN` must not reach the child, `CODEX_API_KEY`
must, and the ordinary environment must survive.

---

## P2 #18 — the fresh-QA-database fix was opt-in — **FIXED**

`qa-stack.mjs` already built a throwaway database, but the QA scripts defaulted
to port **8787** — the real dev relay — so the safe path was opt-in and the
dangerous one was what you got by typing `node scripts/qa.mjs`.

- New `scripts/qa-target.mjs` owns the decision for every QA script: the default
  target is the throwaway stack's port (8799), and pointing a run at 8787
  **exits with a plain-words refusal** unless `CLOUD9_QA_ALLOW_REAL_DB=1`.
- `qa.mjs`, `qa-v2.mjs` and `qa-lifecycle.mjs` all use it. The latter two also
  had hardcoded Linux paths (`/home/user/repo`, `/opt/pw-browsers/chromium`)
  that could never run on this machine — repaired while in there.
- Root `package.json` gains **`npm run qa`** → `node scripts/qa-stack.mjs`.

**Verified by running it:** `CLOUD9_RELAY_PORT=8787 node scripts/qa.mjs` prints
the refusal and exits 2 without opening a browser.

---

## P3 #20 — Windows device names accepted as skill file names — **FIXED**

`CON`, `NUL`, `COM1`… are **devices** on Windows whatever extension you add, and
a trailing dot or space is stripped by the OS so `evil.md.` and `evil.md ` both
land on `evil.md`.

New `isSafeSkillFileName()` in `@cloud9/shared` is the single owner of that
rule — used by the relay (before storing) and the engine (before writing), so
the two checks cannot drift. Same law as before: **refuse, never rewrite**.

**Proof.** `a Windows device name is not a file name, whatever extension it
wears` and `the engine refuses a device-named skill file at the disk gate too`.
Ordinary names like `console.md` and `contract.md` are still allowed.

---

## P3 #21 — `MODEL_ID_RE` permitted a leading `-` — **FIXED**

`--yolo` was a valid model id and went onto a command line as a flag.
`MODEL_ID_RE` is now `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/` — the first character
must be a letter or a digit, so an id can never be mistaken for an option.

**Proof.** `a model id can never be mistaken for a command-line flag`.

---

## P3 #19 — credential env deny-list → allow-list — **PARTIAL, deliberately**

Implemented as a **shape rule** rather than a strict allow-list: `env.ts` keeps
the explicit list of known credential variables *and* adds `SECRET_NAME_RE`,
which strips anything calling itself an api key, access key, secret, password,
credential, token, session key or private key. That generalises past "the
secrets we thought of", which was the point of the finding.

A strict allow-list was **not** adopted: a CLI needs an unknowable set of
ordinary OS variables (PATH, HOME, APPDATA, SystemRoot, TEMP, proxy settings,
locale), and guessing that list wrong breaks the app on someone's machine —
a silent, hard-to-diagnose failure traded for a marginal gain. The reasoning is
recorded in the file so the decision can be revisited.

---

## #10 — the Cancel button was a no-op wire — **FIXED (protocol + engine half)**

The renderer sent `{ type: "harnessCancel", harness }`, but no such frame
existed: the relay ignored it, so pressing Cancel only hid the spinner locally
while the relay held its "a sign-in is running" lock for six minutes and refused
every retry.

- `harnessCancel` added to `ClientFrame`; `harnessRequest.action` gains
  `"cancel"`.
- Relay handles it under the same owner-only gate, clears `signInFlight` and
  `signInAt`, and forwards `action: "cancel"` to that user's engine.
- `HarnessManager.cancelSignIn(harness)` ends the poll loop on its next tick and
  leaves **no** `problem` on the card — walking away is not a failure.
- `host.ts` now names every action explicitly. Its old `else if (which)` branch
  would have treated any new action carrying a harness name as *sign in*.

**Proof.** `cancelling a sign-in releases the lock instead of blocking every
retry`, `a guest cannot cancel the owner's sign-in`, and
`cancelSignIn stops the wait, and leaves no failure on the card`.

The existing renderer already sends the right frame (behind a type cast), so
this works end-to-end today — the handoff below is a tidy-up, not a repair.

---

## #26 — the renderer was outside the verification gate — **FIXED**

Root `package.json`:

- `build` now includes `-w @cloud9/desktop` **and** runs `typecheck:app`
  (`tsc -p apps/desktop/tsconfig.json --noEmit`). `vite build` alone catches
  syntax and import errors but not type errors, and a gate that does not
  typecheck is not a gate. It passes clean as of this writing.
- `build:app` is now just an alias for `build`; `pack` / `dist` unchanged
  otherwise (the packaging agent's `prepack:tools` step was left alone).
- New `qa` script (see #18).

---

## Not fixed, and why

- **Tasks and approvals are still broadcast to every connected client**, and
  `welcome` still carries every task and approval. This is the same class as
  #7, but it was not in the review's list and scoping it changes the approval
  visibility model — `integration.test.ts` currently *relies* on a guest
  receiving an approval broadcast in order to prove they cannot decide it.
  Recommend a follow-up round: scope task/approval frames to the requester and
  the agent's owner, and rework that test to read the approval id from the
  store. **Not a privilege escalation** — deciding, updating and cancelling are
  all gated — but it is a visibility leak.
- **`createChannel` still accepts arbitrary `memberIds`.** Anyone can create a
  conversation containing other people. That is arguably the feature, but worth
  a decision.

## Could not verify

- The Codex `-C` behaviour was not exercised against the real `codex` CLI (not
  driven in this session). The change is that the path is no longer pre-quoted;
  `run.ts` quotes it instead, so the string the shell receives for a spaced path
  is the same one the old code *intended* to produce. Covered by an automated
  test through the real `run()`, not by a live Codex turn.
- The `#10` Cancel flow is proven at the relay and `HarnessManager` level. It
  was not clicked in the running app.
- The two "red before green" runs for `harnessCancel` and `cancelSignIn` failed
  at **compile** time on the unfixed tree (the frame and the method did not
  exist), rather than at assertion time. Every other new test was observed
  failing on assertions against the unfixed behaviour.

---

# Handoff: renderer changes (`apps/desktop/src/**`) — NOT made here

Three from the review, plus two consequences of this round. All are in files
owned by the reskin agent.

### #5 — `userRemoved` is never consumed (`apps/desktop/src/store.ts`)

The relay broadcasts `{ type: "userRemoved", userId }` when someone is removed,
but the renderer's frame switch (around `case "agentStatus"` / `case "history"`,
~lines 146-175) has no case for it. A removed person stays in the sidebar until
a reload.

Add, alongside the other cases:

```ts
case "userRemoved": {
  w.users = w.users.filter(u => u.id !== frame.userId);
  // and drop conversations that only existed with them
  w.channels = w.channels.filter(
    c => !(c.kind === "dm" && c.memberIds.includes(frame.userId)));
  break;
}
```

If the removed id is `w.me?.id`, the socket has already been closed by the
relay — show the join screen rather than an empty app.

### #12 — drop the `removeUser` cast (`apps/desktop/src/App.tsx:2208`)

```ts
client.send({ type: "removeUser", userId: confirmPerson } as unknown as Parameters<typeof client.send>[0]);
```

`removeUser` **is** in `ClientFrame` in `@cloud9/shared`. The cast is
unnecessary and actively harmful: it disables the type check that would have
caught #10 (`harnessCancel`, which really was missing). Change to:

```ts
client.send({ type: "removeUser", userId: confirmPerson });
```

### #10 — drop the `harnessCancel` cast (`apps/desktop/src/App.tsx:2298`)

```ts
client.send({ type: "harnessCancel", harness } as unknown as Parameters<typeof client.send>[0]);
```

`harnessCancel` is now a real frame and the relay honours it. Remove the cast:

```ts
client.send({ type: "harnessCancel", harness });
```

**Class rule worth adopting while you are in there:** no `as unknown as
Parameters<typeof client.send>[0]` anywhere. If a frame does not typecheck, the
protocol is missing it — say so, don't cast past it. Both casts above hid a real
gap.

### New — the join screen must show why an invite was refused

An invite that has already been used (or was never valid) now gets a plain
`{ type: "error", error: "…" }` immediately followed by the socket closing,
instead of silently minting a session. The join screen should surface that text
next to the code box. Exact strings from `server.ts:handleHello`:

- `"that invite has already been used — ask for a new one"`
- `"that invite code isn't valid"`

Without this, a guest with a spent code sees the app simply fail to connect.

### New — hide "Invite a friend" for anyone but the owner

`createInvite` is now owner-only and answers a guest with
`"only the owner of this Cloud9 can invite someone"`. The invite button
(`App.tsx:733` and `:759`) should be rendered only when
`world.me?.id === <the owner>`; otherwise a guest clicks a button that can only
produce an error. The renderer does not currently know who the owner is — the
simplest fix is to gate on the same condition already used for the other
owner-only settings, or ask for an `ownerId` field on `WorldState` and I will
add it relay-side.
