# Cloud9 backend — straight answers and an honest assessment

Date: 2026-07-29. Written by reading the code as it stands, not the plans.
Nothing was edited to produce this.

---

## The four questions, answered in one paragraph each

**1. Where is the backend?**
It is on your own PC. It is a small Node program at `apps/relay/src/server.ts`
that listens on **127.0.0.1 port 8787** and writes everything into one file,
`cloud9-relay.db`, in the project folder. `127.0.0.1` means "this computer
only" — nothing outside your machine can reach it, not even another device on
your home Wi-Fi. I confirmed it is running right now: `netstat` shows
`TCP 127.0.0.1:8787 LISTENING` (process 40288), plus the web screen on
`127.0.0.1:5173`.

**2. Which backend is working?**
That one. There is only one, and it works. There is no second backend, no
staging server, no cloud service. There is no Dockerfile, no deploy config, no
`.env`, and no git remote anywhere in the repo — I looked. The database
currently holds 5 people, 5 agents, 10 channels, 75 messages, 8 tasks and 115
audit records, so it has been genuinely exercised.

**3. Which authentication are we using up front?**
Two different things are called "authentication" here and they are not
connected:
- **You → the app**: a plain shared secret string. Yours is literally
  `dev-owner-token` — the shipped default, hardcoded at
  `apps/relay/src/server.ts:33`, pre-filled into the sign-in box at
  `apps/desktop/src/App.tsx:196`, and confirmed as the live token sitting in
  your database right now. No password, no expiry, no rotation.
- **The app → Claude/Codex**: as of the latest direction change, it **spawns
  the Claude and Codex CLIs already installed on your PC and lets them use
  their own logins**. Cloud9 never sees or stores a token on that path. An API
  key or `claude setup-token` is a fallback only.

**4. Have we made any API calls?**
Cloud9's own code makes **zero** direct calls to `api.anthropic.com`,
`openai.com`, or any other internet address. There is no telemetry, no
analytics, no crash reporting, no third-party endpoint of any kind. When a
live agent turn happens, the outbound call is made by the `claude` / `codex`
program on your PC, not by Cloud9. And judging by the stored message history,
**no live model turn has been recorded yet** — every agent reply in the
database is either demo-mode canned text or the literal sentence
"my engine isn't connected".

Everything below is the detail behind those four answers.

---

## A. What exists today

### The three moving parts

Everything runs on your PC. The launcher `Start Cloud9.cmd` starts them in
order and kills them when you close the window.

| Part | Plain words | Where the code is | How it runs |
|---|---|---|---|
| **The hub** (relay) | The post office. Holds all messages and passes them around. | `apps/relay/src/server.ts` (510 lines), storage in `apps/relay/src/store.ts` | `node apps/relay/dist/server.js`, port 8787, loopback only |
| **The agent engine** | The thing that actually makes an agent think and reply. | `packages/engine/src/*`, started by `scripts/engine-host.mjs` or by the Electron app | separate Node process, or inside the desktop app |
| **The screen** | What you look at. | `apps/desktop/src/App.tsx` + `apps/desktop/electron/main.cjs` | Vite on port 5173, wrapped in an Electron window |

There is also an iPhone app scaffold (`apps/mobile/App.js`). It is not wired to
anything real — line 15 hardcodes `ws://192.168.1.10:8787`, a LAN address you
would have to edit by hand, and it only works while your PC is awake and on the
same network.

### The hub, precisely

- **Transport:** WebSocket only (`ws` library, `server.ts:80`). The one HTTP
  route is `/health` returning "ok" (`server.ts:77`). There is no REST API.
- **Storage:** SQLite via Node's built-in `node:sqlite`, file `cloud9-relay.db`
  (`server.ts:62`, `store.ts:11`). Tables: users, tokens, invites, agents,
  channels, messages, tasks, approvals, activity, pushlog (`store.ts:12-48`).
- **Where it binds:** `127.0.0.1` by default (`server.ts:65`, `server.ts:88-95`).
  The comment above it is honest about why: *"Harness frames can start processes
  on this computer, so the hub does not answer the network by default."*
- **What it persists:** everything except credentials. Every message you and
  your agents have ever sent is in that one file, in plain text, unencrypted.
- **Backups:** none. `.gitignore` line 3 excludes `*.db`, so the database is
  not in git either. If that file is lost, everything is lost.

### Where an agent turn actually executes

Not in the hub. In the **engine host**, a separate Node process
(`packages/engine/src/host.ts` → `engine.ts`). It connects to the hub as just
another WebSocket client identified as `client: "engine"`
(`engine.ts:80-84`). The comment at the top of `engine.ts` says it has "zero
Electron imports — so it can be lifted onto an always-on server unchanged."
That is a real and useful property; see section E.

The engine picks a way to run a turn, in this order (`host.ts:74-110`):
1. A credential Cloud9 is holding → talk to Anthropic through the Agent SDK.
2. The local `claude` / `codex` app is installed and signed in → **spawn the CLI
   with all credential environment variables deliberately deleted**
   (`claude-cli.ts:44-48`) so it can only run on its own login.
3. Demo mode, only if explicitly asked for (`CLOUD9_DEMO=1`).
4. Nothing → the agent replies "my engine isn't connected".

### One message, keystroke to reply

1. You type in the desktop window. `apps/desktop/src/App.tsx` calls
   `client.send({type:"send", ...})` in `apps/desktop/src/store.ts:89`.
2. It goes over a WebSocket to `ws://127.0.0.1:8787`
   (`apps/desktop/src/store.ts:27-28, 71`).
3. The hub receives it, writes it to SQLite, and fans it out to every connected
   client that is a member of the channel
   (`apps/relay/src/server.ts:188-197`, `426-458`).
4. The engine host is one of those clients. It gets the same message
   (`engine.ts:114-117`) and decides whether any of your agents should answer
   (`engine.ts:162-202`, rules in `chatter.ts`).
5. If yes, it builds a prompt (`provider.ts:74-85`) and runs the turn — for the
   CLI path, `claude -p --output-format json` with the prompt on **stdin, never
   on the command line** (`claude-cli.ts:112-121`), or
   `codex exec --json …` (`codex.ts:139-149`). The child process is killed if it
   exceeds 180s (Claude) or 120s (Codex).
6. The reply comes back as text, the engine sends `agentSend` to the hub
   (`engine.ts:381-383`), the hub stores it and fans it out
   (`server.ts:198-209`), and your screen renders it
   (`apps/desktop/src/store.ts:115-118`).

### Does any of this run in the cloud?

**No. Verified.** Zero cloud. Specifically:
- Every network address in the source is `127.0.0.1` or `localhost`, except the
  hardcoded LAN address in the unfinished iPhone app.
- No Dockerfile, no `fly.toml`, no `vercel.json`, no Terraform, no CI workflow,
  no `.env` — I searched the whole repo.
- `implementation-notes.md` line 15 records that there is no git remote at all,
  so the code has never even been pushed anywhere.
- The one commit that mentions "the cloud Linux box" (`6059af2`) is about
  *removing* hardcoded paths from a test script.

Your belief was correct: this is 100% local.

---

## B. Authentication, both layers

### (i) How a human gets into the app

A single opaque string, checked against a SQLite table. That's it.

- On first boot the hub creates you as the owner and inserts one row into
  `tokens` (`store.ts:52-59`). Your token is whatever `CLOUD9_OWNER_TOKEN` says,
  and if that isn't set, it is **`dev-owner-token`** (`server.ts:33`, `:63`).
- Friends get in with `invite:<code>:<name>`. The hub redeems the code and issues
  a permanent `tok_…` string (`server.ts:141-157`, `store.ts:74-84`).
- Where tokens live: in the hub's SQLite file **in plain text**, and in the
  browser's `localStorage` under `cloud9.token` on each client
  (`apps/desktop/src/store.ts:82-88`).
- What's missing: no passwords, no expiry, no rotation, no revocation, no
  per-connection rate limiting, no TLS, no device identity. Anyone holding the
  string is that person, forever.

**Your default owner token and what protects it.** Three things, and one of
them is switched off on your machine:
1. The hub only listens on loopback, so nothing off your PC can try the token.
2. The most dangerous frames — the ones that make Cloud9 start programs on your
   computer — are refused unless you are the owner **and** your token isn't the
   shipped default (`server.ts:469-478`).
3. **But** that second guard has a bypass for dev/QA: `CLOUD9_DEV=1`. And
   `Start Cloud9.cmd` line 18 sets exactly that. So on your machine, as
   launched, the app runs as owner with the publicly-known token
   `dev-owner-token` and the guard disabled. Today that is harmless because of
   guard #1 (loopback). The moment the hub is exposed to any network, it is not
   harmless at all — it is remote process execution with a password everyone can
   read on GitHub.

There is also a data-hygiene bug visible in the live database: four separate
"Priya" users with four separate tokens, from repeated invite redemptions. It's
listed as a known fix (feedback-round-1.md, his point 15), not yet done.

### (ii) How the app authenticates to Claude and Codex

The direction changed on 2026-07-28. From `docs/plans/feedback-round-1.md`
(lines 19-24):

> **Cloud9 uses the LOCAL CLI's own login as the primary path for BOTH
> harnesses. It spawns the CLI; the CLI owns the credential. Cloud9 never
> captures, stores, or sees a Claude token in this path.** `setup-token` is
> demoted to an explicit "advanced" fallback…

Why it changed: `claude setup-token` is interactive-only. The first attempt
spawned it with no terminal attached, so after you authorised in the browser it
had nowhere to finish and the app hung on "waiting for you in the browser…"
forever (feedback-round-1.md lines 6-11).

**What is primary in the code as it stands today: the local CLI login, for both
Claude and Codex.** The evidence:

- `packages/engine/src/claude-cli.ts:31-48` defines `CREDENTIAL_ENV_VARS` and
  strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`
  and `ANTHROPIC_BASE_URL` out of the child process's environment. The comment:
  *"if it runs, it runs on the app's own sign-in."*
- `packages/engine/src/harness.ts:66-148` detects both apps by running
  `claude --version` / `claude auth status` and `codex --version` /
  `codex login status`, and sets `authKind: "cli-login"`.
- `feedback-round-1.md:13-15` records your machine already answering
  `{"loggedIn":true,"authMethod":"claude.ai","email":"vikas53953@gmail.com",
  "subscriptionType":"max"}`.

One caveat worth stating plainly: **a stored key still outranks the CLI login**
(`host.ts:74-81`, and `harness.ts:259-280` explicitly makes a held credential
"outrank the CLI's own login, because that is what the engine will bill
against"). So if you ever paste an API key into Settings, that key silently
becomes the thing that pays, and the CLI login stops being used. That's a
deliberate choice, but it is not obvious from the UI.

**Where a fallback secret would live if you used one:** encrypted by Windows
itself via Electron `safeStorage`, in
`%APPDATA%\Cloud9\cloud9-credential-claude.bin` (or `-codex.bin`)
(`apps/desktop/electron/main.cjs:34-57`). The screen can never read it back —
it only asks "is one stored?" (`preload.cjs:6-11`). An older version wrote it to
`localStorage` in plain text; that's now wiped on every start
(`apps/desktop/src/store.ts:36-47`). Nothing anywhere logs a secret's value,
only its length. That part of the system is genuinely well built.

---

## C. Every outbound network call in the codebase

I searched all source (excluding build output and `node_modules`) for `fetch`,
`http`, `https`, `axios`, `XMLHttpRequest`, `WebSocket`, `net.connect`,
`telemetry`, `analytics`, `sentry`, `posthog`. The complete list:

```
apps/desktop/src/store.ts:71     new WebSocket(RELAY_URL)        → ws://127.0.0.1:8787
apps/mobile/App.js:29            new WebSocket(relayUrl)         → ws://192.168.1.10:8787 (LAN)
apps/relay/src/server.ts:80      new WebSocketServer({server})   → it IS the server
packages/engine/src/engine.ts:80 new WebSocket(relayUrl)         → ws://127.0.0.1:8787
scripts/*.mjs                    127.0.0.1 test URLs only
```

That is the entire list. Findings:

- **No direct request to `api.anthropic.com` or `openai.com` anywhere in
  Cloud9's own code.** Not one.
- **No telemetry, no analytics, no error reporting, no third-party endpoint.**
  Zero hits for sentry/posthog/analytics/telemetry.
- **Two ways a call to a model provider can actually happen:**
  1. *The CLI path (primary).* Cloud9 runs `claude -p …` or `codex exec …` as a
     child process (`claude-cli.ts:115`, `codex.ts:143`). That program makes its
     own HTTPS call, on its own login, billed to your own subscription. Cloud9
     never touches the wire.
  2. *The SDK path (fallback, only if a key is stored.*)
     `packages/engine/src/provider.ts:121` does
     `await import("@anthropic-ai/claude-agent-sdk")` — a lazy import, so the
     library is never even loaded unless a credential exists. That library talks
     to Anthropic. It is declared in `packages/engine/package.json` and is
     installed on this machine.
- **Push notifications are a stub.** `store.ts:175-178` writes rows into a
  `pushlog` table for offline users. Nothing ever reads them; there is no APNs
  integration. The table currently has 0 rows.

**Has any real model call been made?** From the stored evidence: no. Every
agent message in `cloud9-relay.db` is either demo-mode canned text
(`"acting per my brief (…), consider it handled. ✅"` — that's `MockProvider`,
`provider.ts:87-105`) or the literal string "my engine isn't connected — open
Settings and sign in, then ask me again." And `Start Cloud9.cmd` line 26 starts
the engine with `CLOUD9_DEMO=1`, i.e. canned replies on purpose. `PIPELINE.md`
line 68 agrees: the live sign-in click and "the first real Codex agent answer"
are still pending your own hands.

---

## D. Honest assessment against the stated goal

The spec (`docs/plans/spec.md`) asks for an **Agent Workforce Platform**: a web
GUI *and* a desktop app (FR-CL-001/002, both P0), state that stays consistent
between them (FR-CL-003, P0), the ability to continue a conversation from
another client (FR-CL-004, P0), workspaces, roles, governance and audit.

### What the current backend genuinely does well

- **The shape is right.** One hub, one protocol, all clients equal. The engine
  is a WebSocket client just like the UI is — which means agents, phone and
  desktop all see the same world. That is the correct architecture for this
  product, and it is rare to get right first time.
- **The engine is already portable.** `engine.ts` has no Electron imports, on
  purpose. Moving agent execution to a server is a deployment change, not a
  rewrite.
- **The command-line hardening is real security work, not theatre.**
  `run.ts:31-59` *refuses* any argument outside a strict allowlist rather than
  trying to escape it, with a written rationale for why escaping is a losing
  game. Prompts go on stdin, never argv. Every agent definition is validated
  twice — once at the hub, once again at the moment it becomes a command line
  (`validateAgentInput`, shared by both). Timeouts kill the whole process tree.
- **Secrets handling is done properly** (OS encryption, never in the renderer,
  lengths-not-values in logs, legacy plaintext actively purged).
- **Audit already exists.** Every meaningful action writes an activity row
  (`server.ts:412-420`) — 115 of them so far. That is a real head start on the
  spec's governance requirements.
- **Demo mode is a genuinely good idea.** The whole app is testable end to end
  with no credentials and no money spent.

### Where it breaks down

Each of these is a direct consequence of "the backend is a process on one PC":

1. **Agents stop when the PC sleeps.** `apps/desktop/electron/main.cjs:198-203`
   shuts the engine down when the last window closes; `Start Cloud9.cmd` kills
   the hub too. Your PRD already admits this ("agents pause when the desktop app
   is closed"). But an agent workforce that only works while you're watching it
   isn't a workforce — it's a chat window. Scheduled check-ins
   (`scheduler.ts`) simply don't fire overnight.
2. **No access from your phone away from home.** The hub is loopback-bound. Even
   on your own Wi-Fi you'd have to change the bind address; from outside your
   house it's impossible without a tunnel or a VPN. That kills spec P0 items
   FR-CL-004 and FR-CL-005 outright, and it makes the entire push-notification
   feature undeliverable.
3. **No web GUI.** FR-CL-001 is P0. What exists is a Vite dev server on
   127.0.0.1:5173, reachable only from your own machine. Nobody else can open
   Cloud9 in a browser.
4. **Authentication isn't authentication.** A single unexpiring shared string,
   stored in plain text on both ends, defaulting to a value published in the
   repo, with the safety guard disabled by your own launcher. It works because
   nothing can reach it. It provides no actual security.
5. **No TLS.** Everything is `ws://`, not `wss://`. Fine on loopback. Anywhere
   else, every message and every token would cross the network readable.
6. **One implicit workspace.** There is no workspace concept in the code at all.
   Every user shares one `#general`, one agent list, one activity log. Visibility
   is a single filter over channel membership (`server.ts:179-184`). Spec item
   C5 (workspaces/roles/governance) is not started and is blocked on an open
   decision (PARKING-LOT D6).
7. **Roles don't exist.** There is exactly one distinction — owner vs not-owner —
   and it's hardcoded (`server.ts:469-471`, approvals at `server.ts:332`). No
   admin, no viewer, no per-workspace permissions.
8. **SQLite will hurt sooner than you think.** Not from user load — from
   *architecture*. `node:sqlite` `DatabaseSync` is, as the name says,
   synchronous: every write blocks the hub's single thread. `recentMessages()`
   (`store.ts:122-131`) runs one query per channel on every single connect, and
   returns 50 messages × every channel to every client. Most rows are stored as
   JSON blobs with no indexes on their contents. It's fine at 75 messages. It is
   not a multi-tenant database, and the write-ahead-log file is already 3.3 MB
   against a 4 KB main file, which suggests it's rarely being checkpointed.
9. **No backup, no migrations, no recovery.** One file, excluded from git, never
   copied anywhere. There is no schema-version column, so the first change to a
   stored shape is a manual data-fix job.
10. **Nothing is multi-tenant.** One owner, one token, one database, one machine.
    Every path in the code assumes that.

### The blunt summary

What you have is an **excellent local prototype of the right architecture**,
with unusually good security discipline at the process-spawning boundary, and
essentially **no backend in the sense the spec means the word**. The gap isn't
quality — the code is careful. The gap is *location*. Nine of the ten problems
above disappear or shrink the moment the hub lives somewhere that is always on
and reachable.

---

## E. The fork in the road

### Option 1 — Stay local-only

*Keep everything exactly as it is.*

- **Unlocks:** nothing new. Finishes the sign-in work and gives you a working
  personal agent chat on one PC.
- **Cost:** £0/month. Near-zero complexity. Days of work, not weeks.
- **Where your Claude login lives:** on your PC, in the Claude CLI, untouched by
  Cloud9. The best possible answer for privacy.
- **Security:** strongest position by default, because nothing is exposed. But
  the weak token and the `CLOUD9_DEV=1` bypass stay as landmines for the day
  someone changes the bind address.
- **Code that survives:** 100%.
- **Kills:** phone access, web GUI, always-on agents, sharing with friends
  outside your house, push notifications — and with them, five P0 spec items.

### Option 2 — Local-first, plus an always-on relay you host yourself

*Same code, but the hub moves to a small always-on box you own (a £4/month VPS,
a Raspberry Pi, or a Tailscale network). Agents still run on your PC.*

- **Unlocks:** phone access from anywhere, friends can join, messages keep
  arriving while your PC is off, and a real web GUI becomes possible. Agents
  still only run when your PC is awake.
- **Cost:** ~£0-10/month. Moderate complexity: real tokens, TLS certificates, a
  domain name, and you become your own sysadmin.
- **Claude login:** stays on your PC. Nothing changes. Your subscription pays.
- **Security:** this is the point where the current auth becomes genuinely
  dangerous and *must* be replaced first — a network-reachable hub with
  `dev-owner-token` and `CLOUD9_DEV=1` would let anyone who finds it run
  programs on your computer.
- **Code that survives:** ~95%. Change the bind address, add TLS, replace the
  token system. No architectural rewrite.

### Option 3 — A hosted multi-tenant cloud backend

*Cloud9 becomes a real service. Accounts, workspaces, a proper database,
agents running on your servers.*

- **Unlocks:** everything in the spec. Real product, other customers,
  workspaces, roles, governance, scale.
- **Cost:** high. Hosting, a managed Postgres, TLS, an identity provider,
  on-call, backups, GDPR, a security posture. Months of work and a real monthly
  bill that grows with users. And — the killer — **you** would be paying for
  every user's model usage.
- **Claude login:** would have to move to your servers, meaning you'd hold other
  people's credentials, or resell your own API access. Anthropic's own docs
  (quoted in `implementation-notes.md:17-23`) say third-party apps may not offer
  claude.ai subscription login without prior approval. This option walks
  straight into that wall.
- **Security:** you become responsible for other people's data and secrets. A
  completely different class of obligation.
- **Code that survives:** the protocol (`packages/shared`) and the engine, maybe
  60%. The hub's storage layer would be rewritten.

### Option 4 — Hybrid: cloud hub for messages and state, agents still run on your PC

*The hub moves to a small hosted service. The engine host stays on your machine
and connects out to it — exactly as it connects to localhost today.*

- **Unlocks:** phone from anywhere, web GUI, friends, always-on message history,
  push notifications, cross-client continuity — while agent turns still run on
  your hardware, on your Claude Max subscription, with your files.
- **Cost:** low-to-moderate. The hub is small; it's a message router with a
  database. ~£5-20/month. The real cost is the auth and TLS work you'd have to
  do anyway.
- **Claude login:** **stays on your PC, in the Claude CLI, and your subscription
  pays.** This is the whole point, and it is only possible because
  `claude-cli.ts` already refuses to carry credentials. No token ever crosses
  the network. This sidesteps the Anthropic policy problem entirely — you are
  not offering anyone else's subscription login, you're spawning a program on
  your own computer.
- **Security:** the hub holds your message history, so it needs real auth, TLS,
  and backups. But it never holds a model credential, which removes the single
  scariest thing to lose. The rule "harness frames only from the owner" becomes
  load-bearing rather than decorative.
- **Trade-off you must accept:** agents still stop when your PC sleeps. Messages
  keep flowing and history keeps building, but a scheduled 6:30am check-in won't
  fire unless your PC is on. (You can fix that later by *also* running an engine
  host on the server — it's the same code, and it would then need its own
  credential.)
- **Code that survives:** ~90%. `packages/shared` unchanged, `packages/engine`
  unchanged except for the URL, `apps/desktop` unchanged except for the URL. The
  hub keeps its shape; its storage and auth get replaced.

### Recommendation

**Go with Option 4 — the hybrid — and get there by first doing the one piece of
work that Options 2, 3 and 4 all need anyway.**

The reasoning:

1. **It fixes the problems you actually have.** The three things that make
   Cloud9 feel like a demo rather than a product — can't reach it from your
   phone, no web GUI, nobody else can join — are all "the hub is on
   127.0.0.1" problems. None of them are agent problems.
2. **It keeps your money where it already is.** You have a Claude Max
   subscription and a signed-in Codex. Option 4 is the only option where that
   keeps paying for the work. Option 3 means you pay for everyone's tokens.
3. **It avoids the policy wall.** Anthropic's rules make Option 3's auth story
   genuinely hard. Option 4 never touches it.
4. **The code is already built for it.** The comment at the top of `engine.ts`
   —"so it can be lifted onto an always-on server unchanged" — was written by
   someone anticipating this exact move. Roughly 90% of what exists survives.
5. **It doesn't foreclose anything.** If Cloud9 ever becomes a product for other
   people, Option 4 is a strict subset of Option 3. Nothing you build now gets
   thrown away.

**What must be decided or built first — in this order:**

1. **Decide one thing: is Cloud9 for you and a few friends, or is it a product
   for strangers?** Everything downstream depends on this, and it's the one
   answer no one can look up in the code. My recommendation: *you and a few
   friends*, for at least the next six months.
2. **Replace the authentication before anything is exposed.** This is
   non-negotiable and it is the true prerequisite. Concretely: kill the
   `dev-owner-token` default so the hub refuses to start without a real secret;
   remove the `CLOUD9_DEV=1` bypass from `Start Cloud9.cmd`; give tokens an
   expiry and a way to revoke one; fix the duplicate-user bug in invite
   redemption. Until this is done, moving the hub off loopback would be actively
   unsafe.
3. **Then add TLS (`wss://`) and pick where the hub lives.** A £5 VPS, or
   Tailscale if you'd rather it never touch the public internet at all —
   Tailscale is the lower-effort, higher-security starting point and would let
   you test the whole idea this week.
4. **Then make the database survivable.** A nightly copy of `cloud9-relay.db`
   somewhere else, and a schema-version column so the first migration isn't a
   manual repair job.
5. **Only then**: the web GUI, the phone app, workspaces. Those are features.
   Steps 2-4 are the foundation, and none of them are visible to a user — which
   is exactly why they'll get skipped unless they're written down. They are now.

One last thing worth doing regardless of which road you pick: **run one real
agent turn and confirm it.** Right now, nothing in the stored evidence proves a
live Claude or Codex reply has ever come back through Cloud9. Everything in the
database is canned demo text. That single test is the difference between "the
sign-in code is written" and "the sign-in works".
