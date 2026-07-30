# Getting Tailscale working with Cloud9 — the pack

Plain words. Written so Vikas's part is a ten-minute job with no thinking
required, and so whoever picks up "step 3" has exact file names, not vibes.

Decided already, not re-opened here: Tailscale (free), private network only,
Vercel is unrelated (future public web GUI, phase 2). See
`docs/plans/backend-decision.md`.

---

## 1. What is actually true on this machine right now

Checked directly, not assumed:

- **Tailscale is NOT installed.** No `tailscale` command, no Tailscale
  service, no Tailscale program folder found on this PC.
- **The hub binds loopback (`127.0.0.1`) by default and refuses to bind
  "every network."** `apps/relay/src/server.ts:67` — `LOOPBACK = "127.0.0.1"`.
  `apps/relay/src/server.ts:81-95` — `resolveBind()` returns loopback unless
  told a specific address, and **throws** if told `0.0.0.0`, `::`, `*`, etc.
  Its own comment already names Tailscale: *"a Tailscale address (100.x.y.z):
  friends' enrolled devices can reach it and nothing else on any network can."*
- **The default port is 8787.** `apps/relay/src/server.ts:192` —
  `listen(port = 8787)`.
- **The bind address is already wired end-to-end, further than expected:**
  - `apps/desktop/electron/main.cjs:307-310` (`hubBindAddress()`) reads, in
    order: env var `CLOUD9_BIND`, then `networkBind` in
    `%APPDATA%\Cloud9\settings.json`, else falls back to `127.0.0.1`.
  - `apps/desktop/electron/main.cjs:312-341` (`startRelay()`) starts the hub
    on that address and port 8787 (or a spare port if 8787 is taken), and
    prints the friend-facing address to the log when it isn't loopback.
  - `apps/desktop/electron/main.cjs:448-469` — IPC handlers `cloud9:hubNetwork`
    (read current bind + candidate addresses on this PC, flagging any that
    start with `100.` as `likelyTailscale`) and `cloud9:setHubNetwork` (write
    it to settings.json, refusing a wildcard with the same message as above).
    Both are exposed to the app screen in `apps/desktop/electron/preload.cjs:49-50`.
  - **But nothing in the app screen calls either of them.** Searched
    `apps/desktop/src/*.tsx` — zero references to `hubNetwork` or
    `setHubNetwork`. **There is no Settings panel for this today.** The only
    way to set it right now is hand-editing `settings.json` or an environment
    variable — not something to hand Vikas.
- **Guest sign-in already exists**, separate from the owner: an "invite"
  token (`invite:<code>:<name>`) that creates a fresh guest account, gated to
  the owner only. `apps/relay/src/server.ts:262-296`; UI at
  `apps/desktop/src/App.tsx:806-895` (the "I have an invite" sign-in mode) and
  `App.tsx:978-980` (owner clicks "Invite" to generate a code).
- **The installed app always starts its own local hub, every launch, no
  exceptions.** `apps/desktop/electron/main.cjs:694-710` — `startRelay()`
  runs unconditionally in every packaged instance. **There is no "connect to
  someone else's hub instead of my own" mode in the app.** This matters for
  section 3 below.
- **No Windows Firewall rule is created by anything in this repo.** Searched
  for `firewall` / `netsh` across `apps/` and `scripts/` — nothing.

---

## 2. Steps Vikas takes (his part — ten minutes)

Order matters: install → sign in → verify → tell Cloud9 the address.

1. **Install Tailscale.** Download from tailscale.com/download, run the
   Windows installer. You'll know it worked when the Tailscale icon appears
   in the system tray.
2. **Sign in — this is the one step nobody else can do.** Click the tray
   icon → "Log in." A browser opens; sign in with whichever account you want
   this tailnet tied to (Google/Microsoft/GitHub/email). You'll know it
   worked when the tray icon shows "Connected" and a machine name for this PC.
3. **Note this PC's Tailscale address.** Tray icon → click your machine name,
   or run `tailscale ip -4` in a terminal. It's a `100.x.y.z` address. Write
   it down — Cloud9 needs it in step 5.
4. **Install Tailscale on each device that should reach your hub** — your
   phone (Tailscale app from the App/Play Store) and each friend's computer —
   and sign each one into the **same tailnet** (send them an invite from the
   Tailscale admin console, or share your login if it's just your own
   devices). You'll know it worked the same way: tray/app shows "Connected."
5. **Tell Cloud9 the address, once Settings exists (see section 3).** Until
   that panel is built, this step cannot be done safely by hand — flagged in
   section 5. When it exists: open Settings → Network, pick the address
   starting `100.` from the list Cloud9 already detects for you, save,
   restart Cloud9. The app will show you the exact address+port to give a
   friend (this logging already exists —
   `apps/desktop/electron/main.cjs:338-340`).
6. **Verify.** From another tailnet device, ask Cloud9 (once the friend-join
   piece from section 3 exists) to connect to `ws://<your-100.x.y.z>:8787`.
   Success = the sign-in screen appears and an invite code lets a friend in.
   Failure today would most likely be Windows Firewall silently dropping the
   connection (see section 4) — the browser/app would just hang or refuse,
   with no message from Cloud9 explaining why, because that message doesn't
   exist yet either.

---

## 3. Steps WE take afterward (handoff for the building agent)

Three pieces of real work remain. None of them are "wire up Tailscale" — the
bind logic is already done and already refuses to do anything unsafe. What's
missing is: a UI a non-developer can use, a way for a friend's own install to
join a remote hub instead of always making its own, and an honest refusal
message.

### 3a. Build the Settings → Network panel (small)
- File: `apps/desktop/src/App.tsx`.
- Call `window.cloud9.hubNetwork()` on open to show current bind + the
  candidate list (mark the one starting `100.` as recommended). Call
  `window.cloud9.setHubNetwork(address)` on save; it already validates and
  refuses wildcards — surface its `{ ok, error }` result as-is; on success
  tell him "restart Cloud9 for this to take effect" (`restartNeeded: true` is
  already returned).
- No new IPC needed — `apps/desktop/electron/main.cjs:448-469` and
  `preload.cjs:49-50` already exist and are already tested logic, just unwired.

### 3b. Build "join a friend's hub" mode (the real gap)
- Today: `apps/desktop/electron/main.cjs:694-710` starts a local hub on every
  launch, unconditionally, and the renderer only ever gets pointed at
  `ws://127.0.0.1:<port>` (`main.cjs:334`, handed over via `loadRenderer` at
  `main.cjs:227-238`). A friend installing Cloud9 on their own PC today has
  no way to point their copy at Vikas's tailnet hub — it will only ever talk
  to a hub it started itself.
- Needs a first-run choice: "start my own Cloud9" vs. "join someone else's,"
  storing a `remoteRelay` address in settings.json. When set, skip
  `startRelay()`/`startEngine()` entirely and set `relayUrl` to
  `ws://<their-100.x.y.z>:<port>` instead of the loopback default.
- The existing invite flow (`App.tsx:806-895`, redemption at
  `apps/relay/src/server.ts:262-296`) needs no changes — it already assumes
  "connect somewhere, then redeem a code." It just currently never gets
  pointed anywhere but localhost in the packaged build.

### 3c. Say something when a connection is refused
- Right now a bad/missing token gets `{ type: "error", error: "bad token" }`
  (`apps/relay/src/server.ts:297`) — fine for an authenticated-but-wrong case.
- A connection from **outside the tailnet** never reaches this code at all —
  it's refused at the network layer (Tailscale/Windows Firewall), so Cloud9
  itself says nothing, and neither does anything in this repo. That silence
  is correct security-wise (don't confirm a hub exists to a stranger) but is
  a bad debugging experience for Vikas when a friend types the address wrong
  or their device isn't in the tailnet. Recommend: nothing changes on the
  hub side; instead the join-mode UI in 3b times out a failed connection
  attempt and says plainly "couldn't reach that address — check the address,
  check both devices show Connected in Tailscale."

---

## 4. Risks, stated honestly

- **Free plan caps at 6 people total** (Vikas + 5). Not enforced by Cloud9 —
  Tailscale enforces it. If he needs more than 5 friends, that's a Tailscale
  plan change, not a Cloud9 change.
- **Opening the hub beyond loopback exposes the WebSocket port to every
  device on the tailnet**, not just to specific rooms. Anyone Vikas invites
  to the tailnet can reach the hub's socket, and from there needs a valid
  invite/token to do anything — but they CAN reach it, full stop. This is the
  correct tradeoff for a private network, but it means adding a device to the
  tailnet and adding it to Cloud9 are two separate, both-required decisions —
  don't let "I added them to Tailscale" be mistaken for "I invited them to
  Cloud9."
- **A friend driving an agent Vikas owns runs on Vikas's own subscription and
  his own signed-in Claude/Codex CLI**, per `HANDOFF.md` section 1 — Cloud9
  never holds a credential of its own, it spawns the CLIs already signed into
  *his* accounts. So every turn a friend's agent takes is metered against
  *his* subscription, with no separate accounting per friend that I found in
  `apps/relay/src` or `packages/engine/src`. **Not handled**, stated plainly:
  there is no usage cap, warning, or per-guest limit on how much of Vikas's
  own Claude/Codex usage a friend can spend by driving his agents.
- **What a friend sees of scrollback**: membership is per-channel
  (`apps/relay/src/server.ts` `worldFor`/channel membership checks) — a guest
  only sees channels/rooms they've been added to, same as any member. I did
  not find a channel-level flag that hides DMs or private rooms from a newly
  invited guest beyond normal membership; a guest added to `#general`
  automatically on invite redemption (`server.ts:286-294`) sees `#general`'s
  full history, same as anyone who joins that room today. This is existing
  room-membership behavior, not something new that Tailscale introduces.
- **Windows Firewall** is very likely to prompt or silently block the first
  inbound connection to port 8787 on a "Private" or newly-seen network
  profile the first time the hub binds to a non-loopback address. Nothing in
  this repo creates a firewall rule (checked — none exists). Untested on this
  machine because Tailscale isn't installed here to trigger it.

---

## 5. What I could not determine

- **Whether Windows Firewall actually blocks the Tailscale interface by
  default on this machine or on a typical Windows 11 box** — I could not test
  this because Tailscale is not installed here. Treat as unverified until
  someone runs it for real.
- **Whether the free Tailscale plan requires each friend to have their own
  Tailscale account, or can be invited as "shared" without one** — plan
  facts from `docs/plans/backend-options.md` say 6-user cap and
  non-commercial only; I did not re-verify current Tailscale ACL/sharing
  mechanics against their live docs for this pack (that was already done in
  `backend-decision.md`/`backend-options.md`, not redone here).
- **Whether the desktop app's auto-update or installer will need a firewall
  rule bundled** — no evidence either way in `apps/desktop/package.json` or
  the installer config; not investigated further because it's out of scope
  for "does the code work," but it will matter once 3a/3b/3c ship.
- **Engine-side reachability** — I did not check whether
  `packages/engine/src` has any assumption baked in that the engine host and
  the hub are always on the same machine/loopback (beyond the relay URL it's
  given). Worth a read before 3b ships, not done here since it's product
  code and out of bounds for this task.
