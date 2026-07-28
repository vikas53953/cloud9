# Backend decision — settled with Vikas, 2026-07-29

Reached by grilling him one question at a time. Each line is HIS answer, not an
inference. Supersedes the options in `docs/plans/backend-assessment.md`.

## The decisions

| # | Question | His answer |
|---|---|---|
| 1 | Must agents work overnight? | **Yes.** |
| 2 | Who pays for AI usage on an always-on machine? | **His own subscription**, via a `claude setup-token` year-long token (and the Codex equivalent) — never metered API keys. |
| 3 | Public internet or private network? | **Private network first** (Tailscale-style). Public website later, on his existing Vercel Pro, with real accounts built once. |
| 4 | Where does the always-on machine live? | **His own PC** — no second box, no rented box, for now. Same install script moves it to a rented machine later if it ever annoys him. |
| 5 | How is overnight handled on a single PC? | **The PC stays awake** (never sleep while plugged in; screen may sleep). |

Already on the record from earlier, not re-asked:
- Audience = Vikas + a few friends/testers, each connecting their own AI accounts.

## Verified facts behind these

- **Vercel cannot host the hub or the agents.** Its own docs state a WebSocket
  connection ends when a function hits its maximum duration, functions are
  stateless, and the filesystem is temporary — our hub holds live connection
  state and a SQLite file. Vercel also cannot run a long-lived process that
  spawns the Claude Code / Codex CLIs. Vercel Pro stays reserved for the
  future public web GUI (phase 2). Source: vercel.com/docs/functions/websockets.
- `claude setup-token` produces a long-lived token that works with no browser —
  the sanctioned headless route. This is why the fallback flow is kept even
  though CLI-login is primary.

## What this means for the build (the useful simplification)

Because the always-on machine IS his PC — the machine where Claude Code and
Codex are already signed in — **no token needs to be created and no credential
needs to move anywhere at all, today.** The CLI-login path already built covers
it. `setup-token` becomes relevant only if he later moves to a rented box.

## Work this unlocks, in order

1. **Real owner token** (already in tonight's packaging work): the app must
   generate a per-install secret on first run and refuse the shipped default;
   drop `CLOUD9_DEV=1` from the normal launch path.
2. **Private-network reachability**: the hub currently binds `127.0.0.1`. It must
   bind the private-network interface instead (never `0.0.0.0`), so phone and
   friends can reach it and the public internet cannot. Requires installing the
   private-network client on his PC, his phone, and each friend's device.
3. **Stay-awake + auto-start**: the hub and engine must start on boot and
   survive a sign-out, and the PC's sleep setting must be changed. Both are
   power-user Windows settings; script them, don't hand him instructions.
   Honest failure modes to tell him about: a power cut, or a Windows update
   reboot, stops the agents until the PC is back.
4. **Backup**: the SQLite file has no copy anywhere. A nightly copy is cheap
   and currently missing entirely.
5. **Phase 2, when he wants it**: public web GUI on Vercel Pro + real accounts,
   talking to the same hub. Auth designed once, in step 1, so it is not rebuilt.

## Research confirmed the choice (`docs/plans/backend-options.md`)

- **Tailscale** is the right phase-1 answer: £0, one evening, no code change
  beyond a bind address and a URL, and a stronger security position than a
  public box with TLS — unenrolled devices cannot even reach the port.
  **Hard limit to watch: the free plan allows exactly 6 users** (Vikas + 5
  friends), and it is non-commercial only.
- **Cloudflare Durable Objects** is the strongest phase-2 path if he ever wants
  true always-on without his PC: a Durable Object is almost exactly what our hub
  already is (one instance holding every socket, with its own SQLite). ~£0–4/mo,
  no sysadmin work, and — unlike Supabase or Convex — the harness push path
  survives. Rewrite is the socket layer only (~100 lines) plus a mechanical
  storage-API swap.
- Ruled out: **Vercel** (function duration kills sockets, stateless, cannot run
  the CLIs), **Supabase** (Edge Functions cap at 150–400s; no home for our frame
  handler; free projects pause after 7 days idle), **Convex** (total rewrite and
  the engine would have to poll instead of being pushed to), **Neon**
  (Postgres only — cannot host a process), **Render free** (spins down after
  15 min, killing every socket).
- Third option if he ever wants zero rewrite: a Hetzner CX22 at ~€4.35/mo runs
  the code untouched — at the price of becoming his own sysadmin.
- If he ever moves to a rented box: the install must be one script, so the move
  is a re-run rather than a rebuild. Write it that way from the start.
