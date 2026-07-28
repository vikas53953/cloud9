// Secret-grade identifiers: the ONE place a value that grants access is minted.
//
// Why this file exists (security review 2026-07-29, finding #2): invite codes
// and sign-in tokens were made by `newId()`, which builds a string out of
// `Date.now()` and `Math.random()`. Neither is a secret — `Math.random()` is a
// fast, predictable generator that browsers and Node both document as unfit for
// security, and the timestamp half is simply "now". Anyone who can guess when a
// code was made is most of the way to guessing the code.
//
// The law this file encodes: a value that opens a door comes from the operating
// system's cryptographic randomness, never from `Math.random()`. `newId()` is
// still fine for message and channel names — they are labels, not keys.
import { randomBytes } from "node:crypto";

/** 128 bits of OS randomness, url-safe, with a human-readable prefix. */
export function secureId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString("base64url")}`;
}

/**
 * A durable sign-in token: 256 bits. Longer than an invite code because it is
 * the credential that lasts, and it is never typed by a human.
 */
export function secureToken(): string {
  return `tok_${randomBytes(32).toString("base64url")}`;
}
