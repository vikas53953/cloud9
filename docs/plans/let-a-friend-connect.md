# Letting a friend on another computer reach your Cloud9

**Status:** the code is done and tested. The switch is off until you turn it on.
Settles item 2 of `docs/plans/backend-decision.md` ("bind the private-network
interface instead, never `0.0.0.0`").

## What this changes

Right now your hub answers **only this computer**. That is why an invite code
works in a second window on your PC and nowhere else — the invite was real, the
front door just wasn't on any street a friend could walk down.

Turning this on puts the front door on **one private street**: a Tailscale
network that only devices you have personally added can even see. It is not the
public internet. A stranger cannot reach the address at all, so there is nothing
for them to knock on.

## What you have to do — once, about twenty minutes

1. **Install Tailscale on your PC** — tailscale.com/download. Sign in with
   Google. That is the whole setup.
2. **Find your private address.** Open Tailscale, look at "This device". It is
   four numbers starting with **100.** — for example `100.84.12.9`. Write it
   down.
3. **Tell Cloud9 to use it.** Either way works:
   - Settings → the network box → paste the `100.` address → restart Cloud9; or
   - open Cloud9's `settings.json` (in your Cloud9 app data folder) and add
     `"networkBind": "100.84.12.9"`.
4. **Restart Cloud9.** The startup log will say the address to give a friend.
5. **Your friend installs Tailscale too**, signs in, and you add them to your
   network from the Tailscale admin page. Now their computer can see yours.
6. **Send them the invite code as usual.** On their join screen they use your
   address instead of the default one.

To go back to this-computer-only: clear the box (or delete the `networkBind`
line) and restart. That is the default.

## What the code will refuse to do

Typing `0.0.0.0` — or `::`, or `*` — means "answer on **every** network this
computer is ever on", which includes café wifi. The hub can start programs on
your machine, so it is never allowed to be that reachable. Cloud9 **refuses**
that address with a plain sentence instead of quietly narrowing it. One owner
for that rule: `resolveBind` in `apps/relay/src/server.ts`, with tests.

The guards you already have stay exactly as they were: an invite is still
single-use, still owner-only to create; the harness (your Claude and Codex
sign-in) is still owner-only; a guest still cannot drive your agents or read a
room they are not in. Opening the network does not open any of those — there is
a test named for that (`opening the hub to a private network does not open the
harness gate`).

## Honest limits

- **Free Tailscale allows 6 people.** You plus five friends. Past that it costs
  money or needs a different answer.
- **Your PC must be awake.** If it sleeps or loses power, everybody's agents stop
  until it is back. That is the trade for not renting a server
  (`backend-decision.md` #4).
- **This is phase 1.** A public website with real accounts is a later, separate
  piece of work — it does not replace this.
