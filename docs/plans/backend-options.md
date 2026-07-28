# Where the Cloud9 hub could live — the options, with real numbers

Date: 2026-07-29. Research only. **No code was changed to produce this.**
Companion to `docs/plans/backend-assessment.md`, which recommended Option 4
(hybrid: hub in the cloud, agents still on your PC). This document answers the
next question: *hosted where?*

I checked prices and capabilities on the web on 29 July 2026. Every number has a
source at the bottom. Where I could not verify something, I say so instead of
guessing.

---

## Read this part first — it decides almost everything

Before comparing hosts, it's worth being precise about what our hub actually
*is*, because that one fact eliminates half the candidates immediately.

`apps/relay/src/server.ts` is **one long-running program that holds open
sockets and remembers things in its own memory.** Four lines make that true:

| Line | What it does | Why it matters |
|---|---|---|
| `server.ts:80` | `new WebSocketServer({ server })` | It *is* a WebSocket server. Not a client of one. |
| `server.ts:42` | `conns = new Set<Conn>()` | A live list of everyone currently connected, held in RAM. |
| `server.ts:508-510` | `broadcast()` loops that Set and calls `ws.send()` | Fan-out only works because **one process** holds **every** socket. |
| `server.ts:43-59` | `agentStatus`, `harness`, `signInAt`, `signInFlight` | In-memory state, not in the database. It vanishes on restart and cannot be split across two copies of the server. |

And `apps/relay/src/store.ts:2` is `import { DatabaseSync } from "node:sqlite"`
— the SQLite engine **built into Node 22+**, used synchronously. It writes to a
file on a real disk.

So the hub needs three things from a host:

1. **A process that stays alive for days**, not seconds.
2. **The ability to accept raw WebSocket connections and hold them open**, on
   our own message format (`ClientFrame` / `ServerFrame` from `@cloud9/shared`).
3. **A disk that survives a restart** (or a database to replace SQLite with).

Anything that gives us all three runs our code roughly as-is. Anything that
gives us fewer means a rewrite. That is the whole story, and the table at the
end is just this test applied eight times.

One more thing that is true for **every** option below: none of them fix the
"agents stop when your PC sleeps" problem, because agents deliberately stay on
your PC. That was the point of Option 4. Don't judge these hosts on it.

---

## The candidates you named

### 1. Supabase

**What it is, plainly.** A hosted PostgreSQL database with a set of extras
bolted around it: a login system, file storage, an auto-generated REST API, a
"Realtime" push service, and small serverless scripts called Edge Functions.
It is sold as "a backend", but it is a *database* platform. It is not a place
you upload a Node program to and let it run.

**Can it host a persistent WebSocket server?** **No — not ours.** Two separate
answers:

- **Realtime** *is* a WebSocket service, but it is **Supabase's** WebSocket
  server, not yours. It's an Elixir/Phoenix cluster that Supabase operates
  ([Realtime architecture docs][s-rt-arch]). You connect to it with the
  `supabase-js` client, and it offers exactly three fixed behaviours:
  **Broadcast** (relay a message to other clients), **Presence** (who's online),
  and **Postgres Changes** (tell me when a row changes) ([Realtime
  docs][s-rt]). You cannot put your own server-side handler on a message. There
  is nowhere to run `handleFrame()`.
- **Edge Functions** *can* accept a WebSocket ([Handling WebSockets][s-ws]) —
  but they die on a hard clock. Supabase's own limits page states a maximum
  wall-clock lifetime of **150 seconds on Free and 400 seconds on Paid**, plus
  2 seconds of CPU and 256 MB of memory ([Edge Function limits][s-limits]). A
  chat hub whose connections are guillotined every 2½ minutes is not a chat hub.

**Does our code run on it?** **Rewrite.** Not a port — a redesign. Concretely:

- `server.ts` is deleted as a server. Fan-out (`broadcast`, `toUser`,
  `toEngines`, `server.ts:508-545`) becomes Realtime channel subscriptions on
  each client, with the *clients* deciding who hears what — so the
  membership filter at `server.ts:185-190` and `postMessage`'s
  member-resolution loop (`server.ts:485-498`) must be re-expressed as Postgres
  **row-level security policies**, a security model nobody on this project has
  written before.
- Every in-memory field (`conns`, `agentStatus`, `harness`, `signInFlight`)
  must become database rows, because there is no long-lived process to hold
  them.
- The whole of `store.ts` is rewritten: `node:sqlite` → Postgres, and the
  "stuff the object in a JSON column" pattern (`store.ts:150`, `:162`, `:188`,
  `:210`) should become real columns to make RLS possible at all.
- The privileged harness path (`server.ts:394-434`) has no home. It needs a
  server that can hold a socket to your engine host and send it an instruction.
  Edge Functions can't. You'd end up running a separate always-on process
  *somewhere else* anyway — at which point, why is Supabase in the picture?

**Monthly cost at our scale.** **$0 on Free, or $25/month for Pro.**
Free includes 500 MB database, 5 GB egress, 1 GB file storage, 200 concurrent
Realtime connections, 2 M Realtime messages, 500 k Edge Function calls. Pro is
$25/mo with 8 GB database, 250 GB egress, 500 concurrent Realtime connections,
5 M messages ([pricing][s-price]). Our six people are a rounding error against
any of those.

**What breaks on Free.** **Project pausing.** A Free project with low activity
over a 7-day window gets paused; data is preserved and you restore it by hand
from the dashboard ([project pausing docs][s-pause]). For a message hub that
friends open occasionally, this is a real hazard — though in practice a hub
with anyone connected is generating activity. Free is also limited to 2 active
projects.

**TLS and auth.** Both are genuinely good and both are free of effort. TLS is
Supabase's — you get `https://`/`wss://` on their domain with no certificate
work at all. Auth is a full product (email, magic link, OAuth, JWTs), and it
would replace our `dev-owner-token` string entirely. This is the single
strongest argument for Supabase.

**Where the SQLite data goes.** Into Supabase's Postgres, via a one-off
migration you write yourself. There is no import path for `cloud9-relay.db`.

**Operational burden.** *Running* it: almost none. Backups, TLS, upgrades are
theirs. *Getting there*: high — this is weeks of rewriting, and RLS is a
genuinely tricky thing to get right when you're not a developer.

**Honest failure modes.** You spend a month rewriting into a model with no
place for the harness-control path, and discover late that you still need a
small always-on server for it. Free-tier pausing bites during a quiet fortnight.
RLS policies are subtly wrong and a friend sees a DM they shouldn't.

---

### 2. Convex

**What it is, plainly.** A hosted backend where you write TypeScript functions
that Convex runs for you, on top of a document database Convex manages. Its
selling point is *reactivity*: a client "subscribes" to a query, and whenever
the underlying data changes, Convex works out that the answer changed and pushes
the new answer down automatically ([how it works][cv-how]).

**The programming model it imposes.** Three function kinds, and you must fit
into them ([functions docs][cv-fn]):

- **Query** — reads the database. Cached, and automatically reactive. **Cannot
  call the outside world.**
- **Mutation** — writes the database, as a transaction. Not reactive, no
  outside calls.
- **Action** — *can* call external services, but **cannot touch the database
  directly**; it has to call a query or mutation to do that.

Data is documents in tables, not rows and columns.

**Could our WebSocket protocol map onto it?** **No — this is a rewrite, and a
sharper one than it looks.** Convex *does* use a WebSocket: the client opens
one to `wss://<deployment>.convex.cloud/api/<version>/sync` and speaks a JSON
envelope protocol for subscribing, calling mutations and receiving patches
([sync protocol][cv-sync]). But that is **Convex's protocol on Convex's
socket**. Ours is a different protocol on a socket we own. You cannot run
`server.ts` inside Convex, and HTTP actions — the one place you handle raw
requests — are documented for webhooks and APIs with a 20 MB body limit and
**no mention of WebSocket upgrade anywhere** ([HTTP actions][cv-http]).

*(Uncertainty: I could not find an explicit "WebSockets are not supported in
HTTP actions" sentence. The absence of any mention, plus the fact that HTTP
actions run in the same non-Node isolate as queries, makes me confident it is
unsupported — but I did not find it stated outright.)*

What the rewrite looks like in our files:

- `server.ts`'s frame switch (`handleFrame`, `:192-443`) becomes ~20 separate
  mutation functions — `send`, `createChannel`, `createAgent`, `decideApproval`
  and so on. That mapping is actually clean; our frames are already
  command-shaped.
- `broadcast()` / `toUser()` / `visibleChannels()` (`server.ts:185-190`,
  `:508-545`) **disappear entirely** and are replaced by queries that each
  client subscribes to. Convex handles the fan-out. This is arguably *better*
  than what we have — it deletes code.
- `store.ts` is deleted. Every table becomes a Convex table; the JSON-blob
  columns become real document fields.
- The harness path (`server.ts:394-434`) is the problem again. Convex has no
  way to hold a socket open *to your engine host* and push it an instruction.
  Your engine would have to poll a Convex query instead — which is a real
  change to `packages/engine/src/engine.ts`, not just a URL change. Everything
  the assessment said about the engine being portable stops being true here.

**Free and cheapest paid tiers.** Free/Starter is **$0** with 1 M function
calls, 0.5 GB database, 1 GB file storage, 1 GB egress, 20 GB-hours of action
compute, and 1–6 developers. Professional is **$25 per developer per month**
with 25 M calls, 50 GB database, 50 GB egress ([pricing][cv-price]). Six chatty
humans will not approach 1 M function calls, so **$0/month is realistic** —
with the caveat that every reactive re-computation counts as a call, so a badly
shaped query can burn the allowance faster than you'd expect.

*(Uncertainty: the pricing page said nothing about free-project pausing. I could
not confirm whether Convex idles or deletes inactive free projects.)*

**TLS and auth.** TLS is theirs, free, automatic. Auth is **OpenID Connect
JWTs** — Convex validates a token you got from somewhere else. The usual
"somewhere else" is Clerk or WorkOS (both have free tiers); Convex Auth is
their own first-party option and was still described as beta in what I read
([auth docs][cv-auth]). Only RS256 and ES256 signing are supported. Net effect:
proper auth, but you are adopting a second vendor to get it.

**Where the SQLite data goes.** Into Convex's document store, via a migration
script you write.

**Operational burden.** Lowest of any option here once you're on it. Highest of
any option to *get* onto it, because the whole hub is rewritten in someone
else's paradigm and you'd be learning that paradigm from zero.

**Honest failure modes.** Vendor lock-in is total — there is no "export the
Convex app and run it elsewhere". The engine-host push path has no clean
answer. And every one of your friends' idle open tabs is re-running queries,
which is the meter.

---

### 3. Neon

**What it is, plainly.** Managed PostgreSQL, and essentially nothing else. Its
distinguishing tricks are branching (a copy of your database for testing, made
in seconds) and scale-to-zero (the database switches off when idle and you stop
paying for compute).

**Confirmed: it cannot host our WebSocket process.** Neon's own pricing page
describes the product as "Postgres Database, Authentication, and more backend
primitives" — database primitives. **There is no place to deploy application
code** ([pricing][n-price]). This is not a limitation to work around; it is what
Neon is. If the hub lived nowhere, Neon would still be nothing but a database.

**So what is it good for?** The **database half**, and it is good at it. If you
put the hub on a small server (see the next section), you have a choice:

- Keep SQLite on that server's disk — simplest, and honestly fine for six
  people.
- Or point the hub at Neon and delete `store.ts`'s SQLite dependency.

Neon earns its place in the second case for one specific reason: **it fixes the
"one file, no backup, lose it and lose everything" problem** flagged in
assessment §D.9, without you doing anything. It also removes the
`DatabaseSync` synchronous-write concern (assessment §D.8) — but note that
swapping to Postgres means every call in `store.ts` becomes asynchronous, which
ripples out into `server.ts` (`postMessage`, `handleFrame`, `worldFor` all
become `async`). That is a mechanical change, not a redesign, but it touches
most of both files.

**What would host the server half?** Anything from section 4 below: a VPS, Fly,
Railway, Render, or your own PC. Neon is a *component* of an answer, never the
answer.

**Cost.** Free: **$0**, 100 compute-hours per project per month, 0.5 GB storage
per project, scale-to-zero after 5 minutes idle. Paid (Launch) is
pay-as-you-go: **$0.106 per compute-hour** and **$0.35 per GB-month** of
storage, no monthly minimum ([pricing][n-price]).

**A trap worth naming.** Scale-to-zero plus an always-on hub interact badly.
Our hub opens the database at boot and keeps it. A cold database that suspends
after 5 minutes of no queries means an occasional multi-second stall on the
first message after a quiet spell — visible to a user as a hang. On Free you
cannot turn scale-to-zero off; on paid you can.

**TLS and auth.** TLS on the database connection only. Neon does nothing about
your app's TLS or your users' logins. (It has started offering auth primitives;
I did not verify what they cover, so treat that as unknown.)

**Operational burden.** Very low. Automatic backups and point-in-time restore
are the whole reason to use it.

**Honest failure modes.** Free-tier compute hours run out mid-month and the
database stops. Scale-to-zero causes the stalls above. And you've added a
network hop and a second bill to solve a problem — backups — that a nightly
`copy cloud9-relay.db` also solves for £0.

---

## The options you did not name, that you should see

### 4. A small VPS (Hetzner, Fly.io, Railway, Render)

**What it is, plainly.** A rented Linux computer on the internet, always on.
You `ssh` into it, install Node, copy the repo, run `node dist/server.js`. As a
network engineer this is the option you already understand better than any
developer would.

**Does our code run on it?** **As is — genuinely as is.** This is the only
family of options where that sentence is literally true. The complete change
list:

1. `server.ts:65` — `bind` goes from `127.0.0.1` to `0.0.0.0` (there's already
   a `CLOUD9_BIND` environment variable for exactly this, so it's a config
   change, not a code change).
2. Set a real `CLOUD9_OWNER_TOKEN` so `server.ts:63` stops falling back to
   `DEFAULT_OWNER_TOKEN` — **non-negotiable**, see below.
3. Change the URL in `apps/desktop/src/store.ts` and
   `packages/engine/src/engine.ts` from `ws://127.0.0.1:8787` to `wss://<your
   host>`.
4. Put a reverse proxy (Caddy is one line of config) in front for TLS.

`store.ts` does not change at all — SQLite lives on the server's disk. In-memory
state keeps working because there is still exactly one process. Note only that
the server must run **Node 22 or newer**, because `node:sqlite` (`store.ts:2`)
does not exist before that.

**Real current prices:**

| Provider | Cheapest always-on | Free tier | Notes |
|---|---|---|---|
| **Hetzner** CX22 | **≈ €4.35–4.49/month** (~£3.70–3.85) for 2 shared vCPU, 4 GB RAM, 40 GB NVMe | none | Prices rose on 1 Apr 2026; CX22 was €3.29 before. Best value by a distance. ([spec/price][h-cx22], [increase][h-inc]) |
| **Fly.io** | **≈ $2.02/month** (~£1.60) for shared-cpu-1x / 256 MB always-on, plus **$0.15/GB-month** for a volume | **No free tier for new accounts** — $5 trial credit only. Legacy Hobby accounts kept 3 small VMs free. | Pay-as-you-go; tiered plans discontinued for new customers. Egress $0.02/GB (NA/EU), inbound free. ([pricing][f-price]) |
| **Railway** | **$5/month** Hobby, which *includes* $5 of usage | $5 one-time trial credit | Then metered: ~$0.139 per GB-hour RAM, ~$0.278 per vCPU-hour, $0.05/GB egress, volumes extra. A tiny hub fits inside the $5. ([pricing][r-price]) |
| **Render** | **$7/month** Starter (512 MB) | Free web services exist **but spin down after 15 minutes of no traffic** and take 30–60 s to wake | **The free tier is disqualified for us**: spinning down kills every open WebSocket and the engine host's connection. ([pricing summary][rn-price]) |

**Realistic monthly cost for us: £0–£6.** Hetzner at ~£3.85 or Fly at ~£1.60
are the sane picks. Add a domain name (~£10/year) if you want a memorable
address; a raw IP address plus a free `sslip.io`-style hostname also works.

**TLS and auth.** **Both are yours to do, and this is the real cost of this
option.** TLS: Caddy or Cloudflare in front of the box gets you a free Let's
Encrypt certificate with about three lines of config — genuinely easy, and you
already know what a certificate is. Auth: **nothing is provided.** The hub keeps
its own token table (`store.ts:17-19`, `:52-59`, `:61-66`), which means the
assessment's step 2 — kill the default token, add expiry, add revocation — is
work you must do *before* this box is reachable, not after.

**The specific danger.** Today `Start Cloud9.cmd` sets `CLOUD9_DEV=1`, which
switches off the guard at `server.ts:521` that stops the shipped default token
from triggering harness frames. Harness frames start programs on your PC. A
public IP + `dev-owner-token` + `CLOUD9_DEV=1` is remote code execution on your
computer with a password that is in the repo. Fixing this is a prerequisite for
this whole family of options.

**Where the SQLite data goes.** On the server's disk. On Hetzner that's the
included NVMe; on Fly it's a paid volume you must remember to attach (a machine
without one loses the file on redeploy — a classic and painful mistake).

**Operational burden.** The highest of any option here, but it is
*sysadmin* work, not *developer* work: OS updates, a firewall, watching disk
space, and — the one nobody does — **arranging a backup of that one SQLite
file**. Realistically an hour to set up and ten minutes a month, if you use
`unattended-upgrades` and a nightly `scp` of the database somewhere.

**Honest failure modes.** You forget the backup and lose everything (this is
the most likely bad outcome across every option in this document). You expose
the box before fixing the token. The disk fills with the WAL file — already 3.3
MB against a 4 KB database on your machine, which suggests it isn't being
checkpointed. Nobody patches the OS for a year.

---

### 5. Cloudflare — Durable Objects + D1

**What it is, plainly.** Cloudflare runs small JavaScript programs (Workers) on
its own network. A **Durable Object** is a special Worker with two properties
that matter enormously to us: (a) there is **exactly one instance** of it for a
given name, anywhere in the world, and (b) it **has its own private SQLite
database attached** ([overview][cf-do]).

Read that again with our hub in mind. "One instance, holds connections,
coordinates clients, has its own SQLite" is *a description of
`apps/relay/src/server.ts`.* Cloudflare's own docs name the target use cases as
"collaborative editing tools, interactive chat, multiplayer games, live
notifications". This is not a workaround; it is the thing they built it for.

There is a second piece, **WebSocket Hibernation**: the Durable Object can be
evicted from memory while the sockets stay open, and wakes when a message
arrives. You stop paying for idle time — which is what a chat hub mostly is.
**D1** is Cloudflare's separate standalone SQL database; for our shape you
probably want the Durable Object's *own* SQLite rather than D1, since all our
data belongs to one hub.

**Does our code run on it?** **Small-to-moderate changes — more than a VPS, far
less than a rewrite.** The good news is that the *architecture* survives
completely, which is not true of Supabase or Convex. What changes:

- **The socket plumbing.** `http.createServer` + `new WebSocketServer`
  (`server.ts:76-81`) is replaced by a `fetch()` handler that accepts the
  upgrade. `ws.on("message", …)` becomes a `webSocketMessage()` method. Perhaps
  40 lines.
- **`conns`, and everything that walks it.** `broadcast`, `toUser`, `toEngines`
  (`server.ts:508-545`) currently loop an in-memory `Set`. Under hibernation
  the object may have been evicted, so the connection list comes from
  `getWebSockets()` and the "who is this socket" information
  (`Conn.userId`, `Conn.client`) must be attached to each socket as a
  serializable tag rather than held in a JS object. Real work, but small and
  mechanical — maybe 60 lines across those three methods plus `onConnection`.
- **The other in-memory fields.** `agentStatus`, `harness`, `signInAt`,
  `signInFlight` (`server.ts:43-59`) must move into the object's storage,
  because eviction wipes memory. Also small — and it *fixes* a real bug we
  already have, where a hub restart silently loses harness state.
- **`store.ts`.** The SQL barely changes — it's SQLite either way. But
  `node:sqlite`'s `DatabaseSync` API (`prepare().run()` / `.get()` / `.all()`)
  becomes Cloudflare's `ctx.storage.sql.exec()`. That's a find-and-replace
  across ~30 call sites, not a redesign. The schema at `store.ts:12-48` can be
  pasted across unchanged.
- **One genuine constraint:** Workers are not Node. If any part of the hub
  reaches for a Node built-in beyond what Cloudflare polyfills, it breaks. Our
  hub's imports are `node:http`, `ws`, `node:sqlite` and `@cloud9/shared` —
  all three Node pieces are being replaced anyway, so this is less of a wall
  than it usually is.
- **What doesn't change at all:** `@cloud9/shared`, the entire
  `ClientFrame`/`ServerFrame` protocol, `handleFrame`'s 250 lines of business
  logic, `apps/desktop`, and `packages/engine` (URL only). The engine host
  connects as a WebSocket client exactly as it does now — **the harness push
  path survives**, which it does not on Supabase or Convex.

**Cost.** **£0–£4/month.**

- **Free plan:** Durable Objects *are* available, but **only with the SQLite
  storage backend** — which is the one we want. Limits are per-day: 100,000
  requests, 13,000 GB-s duration, 5 M SQLite rows read, 100,000 rows written,
  5 GB storage ([DO pricing][cf-price]).
- **Paid plan:** $5/month minimum (the Workers Paid plan), including 1 M DO
  requests/month then $0.15/M, 400,000 GB-s then $12.50/M GB-s, 25 billion row
  reads and 50 M row writes, 5 GB-month storage then $0.20/GB-month
  ([DO pricing][cf-price], [Workers pricing][cf-wk]).
- **The billing detail that makes this cheap for chat:** outgoing WebSocket
  messages are **free**, and incoming ones are billed at **20:1** — 100 messages
  in count as 5 requests. With hibernation, idle connections cost nothing;
  Cloudflare's own worked example puts a hibernating app at ~$10/month against
  ~$138/month without it. Six people chatting will not leave the free tier.

*(Uncertainty: one secondary source quoted the free duration allowance as
313,000 GB-s/day where the official docs page I read said 13,000 GB-s/day. I
have used the official figure. Either is far beyond our needs.)*

**TLS and auth.** TLS is Cloudflare's and is automatic and free — you get
`wss://` on a `workers.dev` subdomain or your own domain with zero certificate
work. **Auth is still yours** — the token table comes across unchanged, so the
assessment's step 2 is required here too. Cloudflare Access exists as an extra
front door if you want one.

**Where the SQLite data goes.** Into the Durable Object's own SQLite storage,
replicated and backed up by Cloudflare. Migrating `cloud9-relay.db` means a
one-off script that reads the rows and re-inserts them — but into an *identical
schema*, which makes it the easiest migration on this page.

**Operational burden.** Very low, and importantly **it is not sysadmin work.**
No OS, no patching, no disk, no certificates, no backup script. You deploy with
`wrangler deploy` and that's the job.

**Honest failure modes.** The rewrite of the socket layer is real work that
must be got right, and "state must survive eviction" is a discipline you have
to hold every time you add a feature — forget it once and something silently
resets. Debugging is harder than `console.log` on a box you own. Vendor
lock-in is meaningful, though less than Convex's because the protocol and the
business logic stay portable. And every Durable Object is single-threaded, so
one slow operation blocks that hub — the same property `DatabaseSync` already
gives us, so no worse than today.

---

### 6. Tailscale — not hosting at all

**What it is, plainly.** A private network overlay. You install Tailscale on
your PC and on your phone, both join your "tailnet", and they get stable
private addresses that work from anywhere — coffee shop, mobile data,
anywhere — as if they were on the same LAN. It's WireGuard with the key
exchange and NAT traversal done for you. **Nothing is exposed to the public
internet.** Nothing is hosted.

**Does our code run on it?** **As is, and this is the smallest change of all.**
Change `server.ts:65`'s bind from `127.0.0.1` to `0.0.0.0` (or to the
machine's Tailscale address), and point the clients at
`ws://<your-pc>.<tailnet>.ts.net:8787`. `store.ts` is untouched. The database
stays exactly where it is. There is no migration, no deploy, no new bill.
**You could test the entire idea this evening.**

**Cost. £0.** The Personal plan is free forever: **unlimited devices, up to 6
users**, up to 3 ACL groups ([pricing][t-price]).

**Two things to notice about that "6 users".** First, "1 owner + ~5 friends" is
*exactly* 6 — you fit, with zero headroom. A seventh person means $8/user/month
on Standard. Second, the Personal plan is explicitly **non-commercial only**,
and Tailscale infers this from your email domain — a `@gmail.com` signup reads
as personal, a custom domain triggers a business trial. Fine today; a wall the
day Cloud9 becomes anything commercial.

**TLS and auth.** This is the interesting part. **Every packet is
WireGuard-encrypted end to end**, so the "no TLS, tokens cross the network in
clear" problem (assessment §D.5) is solved *without adding TLS*. Better still,
**Tailscale becomes the front door**: a device that isn't in your tailnet
cannot even reach port 8787 to try a token. That means `dev-owner-token` stops
being an emergency — it's still bad practice and still worth fixing, but the
network guarantee is doing the work the token can't.

If you later want a genuinely public URL, **Tailscale Funnel** will publish one
service to the open internet with an automatic HTTPS certificate, on ports 443,
8443 or 10000, available on all plans including free ([Funnel docs][t-funnel]).
Use it deliberately, if ever — turning it on re-opens every risk that the
tailnet had closed.

**Where the SQLite data goes.** Nowhere. It stays in `cloud9-relay.db` on your
PC. Still no backup. Still one file.

**Operational burden.** The lowest here — install an app on each device,
approve each friend into the tailnet. But note the *social* burden: **every
friend must install Tailscale and be invited.** That is a real barrier for a
casual user in a way that "click this link" is not.

**Honest failure modes — and these are the ones that matter.**

- **It does not make anything always-on.** Your PC asleep = Cloud9 down for
  everyone, including message history. This is the big one. Options 4 and 5
  keep the hub alive with your PC off; Tailscale does not.
- No web GUI for anyone outside the tailnet, so spec item FR-CL-001 stays
  unmet.
- Six-user ceiling, non-commercial only.
- Your home upload bandwidth and your ISP's NAT are now load-bearing.
- Zero backup, unchanged.

**How to read this option.** Tailscale is not really a competitor to the
others — it's the **£0, one-evening experiment that tells you whether remote
access is even the feature you wanted**, before you spend money or rewrite
anything. If phone-from-anywhere turns out to be the whole point and you can
live with "only while the PC is on", you may never need a host at all. If it
turns out you badly want messages to keep arriving overnight, you've learned
that for free, and Option 4 or 5 is waiting.

---

## Decision table

Ranked for **this** project: one owner, ~5 friends, tiny data, agents staying on
your PC, and an owner who is a network engineer rather than a developer.

| # | Option | Our code runs… | Concretely, what changes | £/month | TLS | Auth | Always-on? | Ops burden | Backups |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **Cloudflare** DO + SQLite | **Small-to-moderate changes** | socket layer + `conns` tagging (~100 lines), `store.ts` API swap (~30 sites); protocol, `handleFrame`, desktop, engine all survive | **£0–£4** | free, automatic | ours to build | **yes** | very low, not sysadmin | included |
| 2 | **Small VPS** (Hetzner / Fly) | **As is** | bind address, owner token, client URLs, a reverse proxy | **£1.60–£3.85** | Caddy/LE, easy | ours to build | **yes** | moderate — real sysadmin | **yours to arrange** |
| 3 | **Tailscale** (no host) | **As is** | bind address + client URLs. That's it. | **£0** | WireGuard everywhere | network *is* the door | **no** — PC only | lowest | none |
| 4 | **VPS + Neon** | **Mechanical change** | as VPS, plus `store.ts` → Postgres and async ripple through `server.ts` | **£2–£6** | as VPS | ours to build | yes | low-moderate | **automatic** |
| 5 | **Railway / Render** | **As is** | as VPS, but managed | **£4–£6** | free, automatic | ours to build | yes (Render *free* tier: **no**) | low | disk snapshots |
| 6 | **Supabase** | **Rewrite** | `server.ts` deleted; fan-out → Realtime + RLS; `store.ts` → Postgres; harness path homeless | **£0–£20** | free, automatic | **excellent, free** | yes (Free pauses at 7d idle) | low once done | automatic |
| 7 | **Convex** | **Rewrite** | frames → mutations; fan-out → reactive queries; `store.ts` deleted; engine must poll | **£0–£20** | free, automatic | good, via Clerk/WorkOS | yes | lowest once done | automatic |
| 8 | **Neon alone** | **impossible** | it hosts no code | — | — | — | — | — | — |

---

## The two strongest candidates

### Cloudflare Durable Objects — the best *architectural* fit

Because a Durable Object is, almost word for word, the thing `server.ts`
already is: **one instance, holding every client's socket, with its own SQLite
next to it.** Everything that makes our hub hard to host elsewhere — the
in-memory `conns` Set, the single-writer database, the need to push an
instruction down to a specific engine host — is native here rather than
worked around.

The concrete case for it:

- **The rewrite is the socket layer only.** `@cloud9/shared`, the entire
  protocol, `handleFrame`'s 250 lines of rules, the desktop app and the engine
  all survive. Supabase and Convex delete far more than that.
- **The harness path survives.** `toEngines()` (`server.ts:529-533`) needs a
  server that holds a socket to your engine host. Cloudflare gives you one;
  Supabase and Convex do not. That path is how Cloud9 signs into Claude and
  Codex, so this is not a detail.
- **It removes the sysadmin job entirely** — no OS, no certificates, no disk,
  no patching, no backup script — while still being always-on. That is exactly
  the right trade for someone who does not want to be a sysadmin.
- **£0–£4/month**, and the WebSocket billing (free outbound, 20:1 inbound,
  hibernation for idle) is unusually favourable to a chat hub specifically.
- Forced side-benefit: moving `agentStatus` and `harness` into storage **fixes
  a real bug** — right now a hub restart silently drops that state.

The honest cost: it is the only option requiring you to hold a new discipline
("state must survive eviction") for every future feature, and it is real
engineering work up front.

### Tailscale — the best *first move*

Because it costs £0, takes an evening, changes two settings and no code, and
answers the question the other seven options are all *assuming* the answer to:
**is remote access from your phone actually the thing you want, and is "only
while my PC is on" good enough?**

The concrete case for it:

- **The change is a bind address and a URL.** Nothing to migrate, nothing to
  deploy, nothing to un-do if it disappoints.
- **It fixes the worst security problem for free.** WireGuard end-to-end plus
  "unenrolled devices can't reach the port at all" is a stronger position than
  a VPS with TLS and a shared token — and it is the *only* option where
  exposing the hub does not first require rewriting the auth system.
- **It is not exclusive with anything.** Whatever you choose later, Tailscale
  costs nothing to have tried, and a week of using it will tell you far more
  about what you need than any more research will.

Its ceiling is real and you should go in knowing it: **no always-on, no web GUI
for outsiders, 6 users, non-commercial.** It is a probe, not a destination —
but it is the cheapest possible way to buy certainty before committing to one.

**The pairing to notice:** these two are not rivals. Tailscale this week tells
you whether you need Cloudflare next month. The natural third option is the
Hetzner VPS at ~£3.85 — it runs the code untouched today, which neither of the
above quite does, at the price of becoming your own sysadmin including the
backup nobody ever sets up.

**Not picking a winner is deliberate.** The choice turns on one thing only a
human can answer: *how much do you care that messages keep arriving while your
PC is asleep?* If a lot — Cloudflare or a VPS. If not much — Tailscale, for
free, this evening.

---

## What I could not verify

Stated plainly, so nothing here is mistaken for fact:

1. **Convex free-project pausing** — the pricing page said nothing about idling
   or deleting inactive free projects. Unknown.
2. **Convex HTTP actions and WebSocket upgrade** — no explicit "not supported"
   statement found. I infer it from total absence in the docs plus the non-Node
   isolate runtime. High confidence, not verified.
3. **Cloudflare free-tier duration allowance** — official docs said 13,000
   GB-s/day; a secondary source said 313,000. I used the official number.
4. **Neon's authentication offering** — Neon now advertises auth primitives
   alongside Postgres. I did not check what they cover.
5. **Hetzner CX22 exact price** — sources gave €4.35 and €4.49 (post-1-Apr-2026
   increase, up from €3.29). Confirm in the Hetzner console. Any IPv4 surcharge
   is unverified.
6. **Currency conversion** — all £ figures are approximate conversions from
   USD/EUR at roughly $1.27 and €1.17 to the pound, and exclude VAT.
7. **Effort estimates** ("~100 lines", "an evening") are my reading of the code,
   not measurements.
8. **Render's detailed plan table** — its pricing page did not render for
   automated fetching; the Render figures come from secondary summaries and
   should be re-checked before relying on them.

---

## Sources

All fetched 29 July 2026.

- [Supabase pricing][s-price] — https://supabase.com/pricing
- [Supabase Realtime overview][s-rt] — https://supabase.com/docs/guides/realtime
- [Supabase Realtime architecture][s-rt-arch] — https://supabase.com/docs/guides/realtime/architecture
- [Supabase Edge Functions WebSockets][s-ws] — https://supabase.com/docs/guides/functions/websockets
- [Supabase Edge Function limits][s-limits] — https://supabase.com/docs/guides/functions/limits
- [Supabase free project pausing][s-pause] — https://supabase.com/docs/guides/platform/free-project-pausing
- [Convex pricing][cv-price] — https://www.convex.dev/pricing
- [Convex functions][cv-fn] — https://docs.convex.dev/functions
- [Convex HTTP actions][cv-http] — https://docs.convex.dev/functions/http-actions
- [Convex authentication][cv-auth] — https://docs.convex.dev/auth
- [How Convex works][cv-how] — https://stack.convex.dev/how-convex-works
- [Convex sync protocol][cv-sync] — https://docs.convex.dev/client/javascript
- [Neon pricing][n-price] — https://neon.com/pricing
- [Cloudflare Durable Objects overview][cf-do] — https://developers.cloudflare.com/durable-objects/
- [Cloudflare Durable Objects pricing][cf-price] — https://developers.cloudflare.com/durable-objects/platform/pricing/
- [Cloudflare Workers pricing][cf-wk] — https://developers.cloudflare.com/workers/platform/pricing/
- [Hetzner CX22 price and specs][h-cx22] — https://vpsfor.dev/posts/hetzner-cx22-pricing-2026/
- [Hetzner 2026 price increase][h-inc] — https://agentdeals.dev/hetzner-pricing-2026
- [Fly.io resource pricing][f-price] — https://fly.io/docs/about/pricing/
- [Railway pricing][r-price] — https://railway.com/pricing
- [Render pricing summary (secondary)][rn-price] — https://costbench.com/software/developer-tools/render/free-plan/
- [Tailscale pricing][t-price] — https://tailscale.com/pricing
- [Tailscale Funnel][t-funnel] — https://tailscale.com/kb/1223/funnel

[s-price]: https://supabase.com/pricing
[s-rt]: https://supabase.com/docs/guides/realtime
[s-rt-arch]: https://supabase.com/docs/guides/realtime/architecture
[s-ws]: https://supabase.com/docs/guides/functions/websockets
[s-limits]: https://supabase.com/docs/guides/functions/limits
[s-pause]: https://supabase.com/docs/guides/platform/free-project-pausing
[cv-price]: https://www.convex.dev/pricing
[cv-fn]: https://docs.convex.dev/functions
[cv-http]: https://docs.convex.dev/functions/http-actions
[cv-auth]: https://docs.convex.dev/auth
[cv-how]: https://stack.convex.dev/how-convex-works
[cv-sync]: https://docs.convex.dev/client/javascript
[n-price]: https://neon.com/pricing
[cf-do]: https://developers.cloudflare.com/durable-objects/
[cf-price]: https://developers.cloudflare.com/durable-objects/platform/pricing/
[cf-wk]: https://developers.cloudflare.com/workers/platform/pricing/
[h-cx22]: https://vpsfor.dev/posts/hetzner-cx22-pricing-2026/
[h-inc]: https://agentdeals.dev/hetzner-pricing-2026
[f-price]: https://fly.io/docs/about/pricing/
[r-price]: https://railway.com/pricing
[rn-price]: https://costbench.com/software/developer-tools/render/free-plan/
[t-price]: https://tailscale.com/pricing
[t-funnel]: https://tailscale.com/kb/1223/funnel
