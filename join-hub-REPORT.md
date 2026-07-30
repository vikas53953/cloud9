# Lane J — Join Hub (relay side)                     2026-07-31

**Branch:** `cursor/join-hub`, based on `origin/master` @ `65740ad` (fast-forwarded
right before this commit; nothing in the base touched any file this lane owns).

## What shipped

A hub-side join credential — a second, distinct door from the existing
same-machine `invite`, purpose-built for the "join a friend's Cloud9 over
Tailscale/LAN" feature (`docs/plans/let-a-friend-connect.md`):

- **`apps/relay/src/joinhub.ts`** — pure, storage-shaped module:
  - `mintJoinToken` / `checkJoinToken` / `redeemJoinToken` / `revokeJoinToken`
    against a `JoinHubStore` interface (not a concrete class) — single-use,
    time-limited (`JOIN_TOKEN_TTL_MS`, 15 min), independently revocable.
    Minted with `secureId("join")` — OS randomness, same law as `secureid.ts`.
  - `resolveJoinBind` — the binding rule: loopback by default, Tailscale/LAN
    addresses allowed, every-interface wildcards (`0.0.0.0`, `::`, `*`, …) and
    public addresses refused in plain words. Built on `classifyHost`
    (imported from `@cloud9/shared`, not reimplemented).
- **`apps/relay/src/joinhub.test.ts`** — 23 tests: mint (shape, no collisions),
  verify (peek doesn't spend), expire (TTL boundary, plus a `PROVE FAIL` test
  that redemption fails on time alone with no revoke/use involved), revoke
  (kills an unused token, no-op on unknown codes, doesn't erase a spend
  record), single-use (a second redemption fails, plus a `PROVE FAIL` test
  that two different candidates racing one code admits exactly one), and
  binding (loopback default, Tailscale CGNAT + MagicDNS, three LAN ranges,
  public IP + hostname refused, every wildcard spelling refused including a
  dedicated `PROVE FAIL` for `0.0.0.0`, and an unrecognised host refused).
- **`docs/plans/join-hub-handoff.md`** — the exact contract for the
  conductor: the `join_tokens` SQL table (mirrors `invites`), the four
  `JoinHubStore` methods as one-statement `Store` methods, the owner-only
  mint/revoke frame handlers, and a proposed new `joinWithToken` wire frame
  (not `hello`'s token-string trick, because the redemption needs
  `resolveJoinBind` against the hub's own bind address, which `handleHello`
  does not currently thread through) — plus why the existing `invite` was
  left untouched.
- **No files outside the exclusive list were touched.** `classifyHost` is not
  (yet) re-exported from `@cloud9/shared`'s package root — only
  `hubaddress.ts` itself exports it. Rather than add that re-export to
  `packages/shared/src/index.ts` (a file outside this lane's exclusive list,
  and one other lanes actively read/write), `joinhub.ts` imports it as
  `@cloud9/shared/dist/hubaddress.js` — a real import of the real function
  (the package declares no `exports` map, so that subpath is a legal, if
  unpolished, import target), never a reimplementation. A one-line, optional
  follow-up for the conductor to shorten that import is written up in
  `docs/plans/join-hub-handoff.md`.

## Verification

- `npm run build -w @cloud9/shared -w @cloud9/engine -w @cloud9/relay` — clean,
  no errors, in a fresh `npm install` (no reused build cache).
- `node --test apps/relay/dist/joinhub.test.js` — **23/23 passing**.
- Ran in an isolated worktree (`../cloud9-joinhub`) checked out to this exact
  branch/commit, specifically to rule out any interference from the other
  lanes sharing the main `cloud9-cursor` checkout (see "A note on the shared
  checkout" below).

## Files touched (complete list)

```
NEW   apps/relay/src/joinhub.ts
NEW   apps/relay/src/joinhub.test.ts
NEW   docs/plans/join-hub-handoff.md
NEW   join-hub-REPORT.md
```

Nothing else. `server.ts`, `store.ts`, `secureid.ts`, and
`packages/shared/src/hubaddress.ts` were read, never edited.
`apps/desktop/**` was not touched.

## A note on the shared checkout

`cloud9-cursor` is being used as a single, shared git working tree by several
lanes at once — mid-session, `HEAD` moved out from under this task twice
(once to `verify-notify`, once to `verify-gh`), and one commit from an
unrelated lane's "agent memory" work briefly landed on `cursor/join-hub`
before being reset off it by that lane's own process. Rather than commit into
that contention, this lane's final commit was made from a dedicated worktree
(`git worktree add ../cloud9-joinhub cursor/join-hub`) touching only the five
files listed above, so nothing from another lane could ride along.

## Return

- **Branch:** `cursor/join-hub`
- **SHA:** *(the commit created and pushed immediately after this report —
  see the accompanying message)*
- **Tests:** 23/23 passing (`apps/relay/src/joinhub.test.ts`)
- **Files:** the five listed above
