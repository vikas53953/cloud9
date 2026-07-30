# Join-hub tokens — handoff to the conductor          2026-07-31

**Status:** `apps/relay/src/joinhub.ts` is done and tested (23 tests, all
green) in isolation. Nothing in `server.ts` or `store.ts` calls it yet — this
document is the exact, mechanical wiring so the conductor can do that without
re-deriving any of the decisions below.

Scope note: this lane (`cursor/join-hub`) touched only
`apps/relay/src/joinhub.ts`, `apps/relay/src/joinhub.test.ts`, `join-hub-REPORT.md`,
and this file — nothing else. `classifyHost` is not (yet) re-exported from
`@cloud9/shared`'s package root (only `hubaddress.ts`/`hubbook.ts` export it
internally), so rather than widen this lane's scope onto
`packages/shared/src/index.ts` — a file many lanes read and write —
`joinhub.ts` imports it as `@cloud9/shared/dist/hubaddress.js`. That is a real
import of the real function (`@cloud9/shared`'s `package.json` declares no
`exports` map, so any subpath of the built package is a legal import target),
never a reimplementation, and it costs nothing to tidy up:

**Suggested follow-up for the conductor (optional, one line):** add, next to
the existing skill-library re-export at the end of
`packages/shared/src/index.ts`,

```ts
export {
  DEFAULT_HUB_PORT, parseHubAddress, hubWebSocketUrl, formatHubAddress, reachInWords,
  classifyHost, type HubAddress, type HubAddressResult, type HubReach,
} from "./hubaddress.js";
```

and then `joinhub.ts`'s import line shortens to `from "@cloud9/shared"`. Not
required for anything in this handoff to work — the deep import already
works today — but it is the more idiomatic long-term home, same as the skill
library got one.

## Why a join token is not the existing `invite`

`store.ts` already has `createInvite` / `redeemInvite` / `revokeInvite`. A
join token is a **second, distinct** credential, not a replacement:

| | `invite` (`store.ts`) | join token (`joinhub.ts`) |
|---|---|---|
| Prefix | `inv_` | `join_` |
| Expires on its own | No — lives until used or revoked | Yes — 15 minutes (`JOIN_TOKEN_TTL_MS`), independent of revocation |
| Redeemed via | `hello` frame, token string `"invite:<code>:<name>"` | proposed new frame, `joinWithToken` (below) |
| Who may mint | owner only | owner only (same rule, enforced by the caller — `joinhub.ts` does not know about roles) |
| Network awareness | none — trusts whatever socket reached the hub | paired with `resolveJoinBind`, which classifies the address the hub is listening on |

Keeping them distinct means the network-join feature
(`docs/plans/let-a-friend-connect.md`) can ship, be tested, and be turned off
independently of the existing same-machine invite path — nobody has to touch
`redeemInvite` (P0 #1's fix) to add this.

## `joinhub.ts` — what is already built

```ts
mintJoinToken(store, createdBy, now?, ttlMs?): string        // "join_<...>"
checkJoinToken(store, code, now?): JoinTokenResult            // peek, no side effect
redeemJoinToken(store, code, admittedAs, now?): JoinTokenResult // spends it, once
revokeJoinToken(store, code): void
resolveJoinBind(requested?: string): JoinBindResult           // loopback | privateNetwork | localNetwork, refuses public/wildcard
```

`JoinHubStore` is the interface `joinhub.ts` needs — implement it against
`store.ts`'s existing `DatabaseSync` connection (`this.db` in `Store`); do not
open a second database file.

## 1. Add the table (in `store.ts`'s existing migration block)

Beside the existing `invites` table:

```sql
CREATE TABLE IF NOT EXISTS join_tokens(
  code TEXT PRIMARY KEY, createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL, usedBy TEXT, usedAt INTEGER,
  revoked INTEGER NOT NULL DEFAULT 0
);
```

## 2. Implement `JoinHubStore` on `Store`

Four methods, each a direct, one-statement mirror of the existing invite
methods (`createInvite`/`invite`/`revokeInvite` at `store.ts:775-791`):

```ts
import { JoinHubStore, JoinTokenRow } from "./joinhub.js";

// inside class Store, `implements JoinHubStore` added to the class signature
insertJoinToken(row: { code: string; createdBy: ID; createdAt: number; expiresAt: number }): void {
  this.db.prepare(
    "INSERT INTO join_tokens(code,createdBy,createdAt,expiresAt) VALUES(?,?,?,?)"
  ).run(row.code, row.createdBy, row.createdAt, row.expiresAt);
}

joinToken(code: string): JoinTokenRow | undefined {
  const row = this.db.prepare(
    "SELECT code,createdBy,createdAt,expiresAt,usedBy,usedAt,revoked FROM join_tokens WHERE code=?"
  ).get(code) as RawJoinToken | undefined;
  return row ? toJoinToken(row) : undefined; // same ?? undefined pattern as toInvite()
}

spendJoinToken(code: string, usedBy: ID, usedAt: number): void {
  this.db.prepare("UPDATE join_tokens SET usedBy=?, usedAt=? WHERE code=?").run(usedBy, usedAt, code);
}

revokeJoinToken(code: string): void {
  this.db.prepare("UPDATE join_tokens SET revoked=1 WHERE code=?").run(code);
}
```

(`RawJoinToken`/`toJoinToken` follow `RawInvite`/`toInvite` at
`store.ts:44-47,121-127` exactly — `revoked: r.revoked === 1`, optional
fields via `?? undefined`.)

## 3. Mint — owner-only, mirrors `createInvite`

In `handleFrame`'s switch, beside `case "createInvite"` (`server.ts:1353`):

```ts
case "createJoinToken": {
  if (conn.userId !== this.ownerId) {
    throw new Error("only the owner of this Cloud9 can create a join link");
  }
  const code = mintJoinToken(this.store, conn.userId);
  this.audit(conn, "join_token_created", code, "created a join link");
  send(conn.ws, { type: "joinToken", code, expiresInMs: JOIN_TOKEN_TTL_MS });
  break;
}
case "revokeJoinToken": {
  if (conn.userId !== this.ownerId) {
    throw new Error("only the owner of this Cloud9 can cancel a join link");
  }
  revokeJoinToken(this.store, frame.code);
  this.audit(conn, "join_token_revoked", frame.code, "cancelled a join link");
  break;
}
```

New `ClientFrame` variants (`packages/shared/src/index.ts`, beside
`createInvite` if one exists, or beside `hello`):

```ts
| { type: "createJoinToken" }
| { type: "revokeJoinToken"; code: string }
| { type: "joinWithToken"; token: string; displayName: string }
```

New `ServerFrame` variants (beside `{ type: "invite"; code: string }`):

```ts
| { type: "joinToken"; code: string; expiresInMs: number }
```

(`{ type: "token"; token: string }` already exists and is reused for a
successful join — see below. No new error frame is needed; the existing
`{ type: "error"; error: string }` carries the plain-words refusal.)

## 4. Redeem — a NEW top-level frame, not an overload of `hello`'s token string

`redeemInvite` piggybacks on `hello`'s token field
(`"invite:<code>:<name>"`, `server.ts:283-314`) because an invite and a
sign-in token look the same to the wire: both are "the string you have,
prove it". A join token is different in one way that matters: **the address
it is arriving on is part of the decision** (`resolveJoinBind`), so the
handler needs the connection's remote address, which `handleHello` does not
currently thread through. Cleanest fix: a dedicated frame, sent instead of
`hello`, so the join path and the sign-in path never have to share one
function's control flow.

```ts
// onConnection's message handler, beside the existing `if (frame.type === "hello")`:
if (frame.type === "joinWithToken") {
  conn = this.handleJoinWithToken(ws, frame, remoteAddress /* from ws or req.socket.remoteAddress */);
  return;
}
```

```ts
private handleJoinWithToken(
  ws: WebSocket,
  frame: Extract<ClientFrame, { type: "joinWithToken" }>,
  remoteAddress: string,
): Conn | undefined {
  // this.bind is already resolved at startup (resolveBind, server.ts:103) —
  // resolveJoinBind here is answering "was THIS PROCESS even willing to admit
  // a join at all", not re-classifying the caller's address a second way.
  const bind = resolveJoinBind(this.bind === LOOPBACK ? undefined : this.bind);
  if (!bind.ok) {
    send(ws, { type: "error", error: bind.reason });
    ws.close();
    return undefined;
  }

  const result = checkJoinToken(this.store, frame.token);
  if (!result.ok) {
    send(ws, { type: "error", error: result.reason });
    ws.close();
    return undefined;
  }

  // Identical shape to redeemInvite: the display name is a LABEL, never an
  // identity lookup (P0 #1). Create the user the same way redeemInvite does,
  // then spend the token on the id that was just created — never on
  // anything the token's own text carried.
  const user: User = { id: newId("u"), name: frame.displayName || "Friend", invitedBy: result.token.createdBy };
  this.store.createUserRow(user); // whatever store.ts's equivalent insert is named
  const token = secureToken();
  this.store.saveToken(token, user.id);
  redeemJoinToken(this.store, frame.token, user.id);

  send(ws, { type: "token", token });
  // same #general auto-join as redeemInvite (server.ts:305-313)
  ...
  return { ws, userId: user.id, client: frame.client ?? "desktop" };
}
```

`remoteAddress` is not used for authorization above (the token is already
network-address-agnostic once minted) — it is a placeholder for the
conductor's own decision about whether to also log or rate-limit joins by
origin. Nothing in `joinhub.ts` requires it; `resolveJoinBind` only ever
looks at `this.bind` (the address the *hub* is listening on), never at the
caller's address, because the hub cannot be reached from an address it never
bound to in the first place — the wildcard/public refusal already happened
at `listen()` time.

## 5. Binding — `resolveJoinBind` complements `resolveBind`, it does not replace it

`resolveBind` (`server.ts:103`) decides what the **process** listens on, once,
at startup, and already refuses every-interface wildcards. `resolveJoinBind`
answers a narrower question for the join feature specifically: **is the
address this hub ended up bound to one where admitting a stranger even makes
sense**, tiered the same way `parseHubAddress` tiers the client's dialing-in
address (`thisPc` / `privateNetwork` / `localNetwork` refused-as-`public`).
Call it once, at the point a `joinWithToken` frame arrives (step 4 above),
passing `this.bind` — not as a second gate that duplicates `resolveBind`, but
so the *response* to a friend's attempt can honestly say "this Cloud9 is
private-network reachable" vs. "this Cloud9 only answers this computer, so
that link cannot work" instead of guessing.

## Tests to add once wired (`server.ts`-level, not `joinhub.ts`-level — those already exist)

- an owner can mint a join token and a fresh socket can redeem it into a new
  user, once
- a second redemption of the same code is refused
- `revokeJoinToken` (owner action) kills an unredeemed token
- a non-owner cannot mint or revoke a join token
- redeeming while `this.bind` resolves to a refused address (public/wildcard)
  never reaches the store — `resolveJoinBind`'s refusal fires first
- opening the hub to a join does not open the harness gate or agent driving
  (same law as `"opening the hub to a private network does not open the
  harness gate"`, `hardening.test.ts`)
