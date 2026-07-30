// Admitting a NEW PERSON to this Cloud9 hub — over a network, not just a
// second window on the same PC.
//
// Why this file exists, and why it is not `store.ts`'s `createInvite` /
// `redeemInvite`: those mint an `inv_…` code that is redeemed inline, on the
// same `hello` frame, by whoever is sitting at a browser tab pointed at this
// machine already. There is no separate moment where the hub decides "is the
// NETWORK ADDRESS this guest is arriving on even one I should be answering
// on at all" — `resolveBind` in `server.ts` answers that once, at startup,
// for the process as a whole, and every invite redemption afterwards just
// trusts whatever socket reached it.
//
// A join token is the credential for the OTHER doorway
// (`docs/plans/let-a-friend-connect.md`): a friend on their own computer,
// reached over Tailscale or a home LAN, who is not going to type a display
// name into the same tab you did. That doorway needs its own answers to two
// questions an invite was never asked:
//
//   1. Does this token expire? An invite lives until someone uses it or the
//      owner revokes it by hand — fine for a code you hand to someone across
//      the same room, wrong for a link that might sit in chat history for
//      weeks. A join token carries its own deadline.
//   2. Is the address it is arriving on even one this hub should be
//      listening on? `resolveJoinBind` below answers that from the SAME
//      three-tier map `classifyHost` (`@cloud9/shared`) already gives the
//      *client* side of this feature (`parseHubAddress`) — imported, not
//      reimplemented, so "which addresses are private" is decided in
//      exactly one place for both directions of a join.
//
// This module is pure and storage-shaped, not SQLite-backed: it takes a
// `JoinHubStore` — an interface, not a class — and does the redemption
// arithmetic (expired? revoked? already spent?) against whatever implements
// it. Tests back it with a plain in-memory fake. The conductor's job, later,
// is a real `JoinHubStore` on the same `node:sqlite` connection `store.ts`
// already opens, plus the wire wiring this file does not do — see
// `docs/plans/join-hub-handoff.md` for the exact frame and the exact lines.
//
// The credential itself follows the law `secureid.ts` encodes: OS randomness,
// never `Math.random()`, because this is a value that opens a door.

// `classifyHost` is not (yet) re-exported from `@cloud9/shared`'s package
// root — this lane's exclusive files do not include
// `packages/shared/src/index.ts`, so rather than widen scope onto a file
// another lane may be mid-edit, this imports the module directly off the
// package's build output. Node's default resolution allows any subpath of a
// package that declares no `exports` map (`@cloud9/shared`'s `package.json`
// does not), so this is a real import of the real function — never a
// reimplementation — and it upgrades to the shorter `@cloud9/shared` form
// for free the day someone adds that re-export.
import { classifyHost, HubReach } from "@cloud9/shared/dist/hubaddress.js";
import { secureId } from "./secureid.js";

/** An id — kept as `string` here so this file never has to import `ID` just to alias it. */
export type JoinUserId = string;

/**
 * One join token, as a store would hand it back. `usedBy`/`usedAt` absent
 * means unspent; `revoked` is a hard kill switch independent of expiry.
 */
export interface JoinTokenRow {
  code: string;
  createdBy: JoinUserId;
  createdAt: number;
  /** After this instant the token is dead even if nobody ever revoked it. */
  expiresAt: number;
  usedBy?: JoinUserId;
  usedAt?: number;
  revoked: boolean;
}

/**
 * The storage shape this module needs — nothing more. `store.ts` does not
 * implement this today; the conductor adds a `join_tokens` table and a class
 * that does (see the handoff doc). Tests implement it with a `Map`.
 *
 * Every method here is synchronous because `store.ts`'s own SQLite calls are
 * (`node:sqlite` is sync) — matching that means the conductor's real
 * implementation is a thin, obvious wrapper around a couple of prepared
 * statements, not an async rewrite of a sync codebase.
 */
export interface JoinHubStore {
  /** Insert a freshly minted, unspent, unrevoked token. `code` is unique. */
  insertJoinToken(row: { code: string; createdBy: JoinUserId; createdAt: number; expiresAt: number }): void;
  /** Look a token up by its code. `undefined` if no such code was ever minted. */
  joinToken(code: string): JoinTokenRow | undefined;
  /** Mark a token spent, once, by the person it admitted. */
  spendJoinToken(code: string, usedBy: JoinUserId, usedAt: number): void;
  /** Retire a token so it can never be redeemed, spent or not. */
  revokeJoinToken(code: string): void;
}

/**
 * How long an unused join token stays good for: 15 minutes. Long enough for
 * someone to paste a link into a chat app and have their friend click it a
 * moment later; short enough that a link forwarded into an old thread months
 * later is simply dead, no revocation required. Callers may pass a shorter
 * one in tests; nobody should need a longer one in production.
 */
export const JOIN_TOKEN_TTL_MS = 15 * 60_000;

/**
 * Mint a join token. Secret-grade randomness (`secureId`, same law as
 * `store.ts`'s invites) — this string alone is enough to become a member of
 * the hub, so it must never be guessable.
 *
 * The `join_` prefix is deliberate and different from `inv_`: the two
 * credentials are redeemed by different code paths on the hub side (see the
 * handoff doc), and a code that carries its own kind on its face cannot be
 * fed to the wrong redemption function by accident.
 */
export function mintJoinToken(
  store: JoinHubStore,
  createdBy: JoinUserId,
  now: number = Date.now(),
  ttlMs: number = JOIN_TOKEN_TTL_MS,
): string {
  const code = secureId("join");
  store.insertJoinToken({ code, createdBy, createdAt: now, expiresAt: now + ttlMs });
  return code;
}

export type JoinTokenResult =
  | { ok: true; token: JoinTokenRow }
  | { ok: false; reason: string };

/**
 * Is this code good RIGHT NOW — unknown, expired, revoked, or already spent
 * all read the same way a person would ask "can I still use this?" without
 * spending it. `handleHello` (or whatever the conductor names its handler)
 * calls this, or `redeemJoinToken` below, never the raw store, so "what makes
 * a join token alive" is answered in exactly one place.
 */
export function checkJoinToken(store: JoinHubStore, code: string, now: number = Date.now()): JoinTokenResult {
  const row = store.joinToken(code);
  if (!row) return { ok: false, reason: "that join link isn't valid — ask for a new one" };
  if (row.revoked) return { ok: false, reason: "that join link was cancelled — ask for a new one" };
  if (row.usedBy) return { ok: false, reason: "that join link has already been used — ask for a new one" };
  if (now >= row.expiresAt) return { ok: false, reason: "that join link has expired — ask for a new one" };
  return { ok: true, token: row };
}

/**
 * Spend a join token — exactly once, ever, on the caller's own new user id.
 *
 * Deliberately mirrors `redeemInvite`'s law (P0 #1, `store.ts`): the identity
 * being admitted is never derived from anything the token's TEXT carries — it
 * is the id the CALLER already decided on (having already created the user
 * row) and hands in here only to be recorded as who spent it. This function
 * never creates a user; it only answers "is this code allowed to admit one",
 * and if so, burns it so it cannot admit a second.
 */
export function redeemJoinToken(
  store: JoinHubStore,
  code: string,
  admittedAs: JoinUserId,
  now: number = Date.now(),
): JoinTokenResult {
  const check = checkJoinToken(store, code, now);
  if (!check.ok) return check;
  store.spendJoinToken(code, admittedAs, now);
  return check;
}

/** Retire a token by hand — the owner changed their mind before anyone used it. */
export function revokeJoinToken(store: JoinHubStore, code: string): void {
  store.revokeJoinToken(code);
}

// ---------------------------------------------------------------------------
// Binding: which network address may accept a join at all.
//
// `resolveBind` (`server.ts`) already refuses to LISTEN on every interface;
// it does not classify what it IS asked to bind to, because until this
// feature the only two answers that ever mattered were "loopback" (default)
// and "whatever specific address he typed, trust him". A join token is a
// credential the hub is now willing to redeem from OFF this machine, so the
// decision of "which addresses that even makes sense for" belongs beside it,
// answered with the same three-tier map `parseHubAddress` gives the person
// dialing IN — `classifyHost`, imported, never rebuilt here.

/** This computer only — the address a join listener binds to unless told otherwise. */
export const JOIN_LOOPBACK_HOST = "127.0.0.1";

/**
 * Spellings of "every interface this computer has" — the same set
 * `server.ts`'s `resolveBind` refuses, repeated here rather than imported
 * because `server.ts` is off-limits to this lane and the set is three
 * strings, not a rule anyone would want to evolve in only one place. If it
 * changes, it changes in both files.
 */
const EVERY_INTERFACE = new Set(["0.0.0.0", "::", "[::]", "*", "0", "::0"]);

export type JoinBindResult =
  | { ok: true; host: string; reach: HubReach }
  | { ok: false; reason: string };

/**
 * Decide whether a join listener may bind to `requested`, and what kind of
 * reachability that grants. Unset stays loopback-only (`thisPc`) — a fresh
 * checkout admits nobody off the machine until asked to. A wildcard
 * ("answer on every network") is refused in plain words, the same law
 * `resolveBind` already enforces for the whole hub. Anything else is handed
 * to `classifyHost`: Tailscale and LAN addresses are allowed (that is the
 * entire point of this feature — `let-a-friend-connect.md`); a public
 * address, or anything `classifyHost` does not recognise, is refused.
 */
export function resolveJoinBind(requested?: string): JoinBindResult {
  const want = (requested ?? "").trim();
  if (!want) return { ok: true, host: JOIN_LOOPBACK_HOST, reach: "thisPc" };

  if (EVERY_INTERFACE.has(want.toLowerCase())) {
    return {
      ok: false,
      reason:
        `Cloud9 will not admit joins on every network ("${want}") — give one address, your ` +
        "private-network (Tailscale) address, e.g. 100.x.y.z, or leave it unset to stay on this computer only.",
    };
  }

  const reach = classifyHost(want);
  if (reach === null) {
    return { ok: false, reason: `"${want}" isn't a computer name Cloud9 recognises` };
  }
  if (reach === "public") {
    return {
      ok: false,
      reason:
        `"${want}" is on the open internet — Cloud9 only admits joins over your private ` +
        "network (Tailscale) or a home/office LAN, never the public internet",
    };
  }
  return { ok: true, host: want, reach };
}
