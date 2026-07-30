// The address book of Cloud9 hubs this person can reach — the ONE owner of
// "which hsubs do I know, and which am I on right now".
//
// Why this file exists: `hubaddress.ts` answers "is THIS string a hub I may
// dial". This file is the next brick up: a person joins their own Cloud9 and,
// later, a friend's, and the app must remember them, let them switch, and know
// which one is live — without the screen or the client each keeping their own
// half-right list. So this is the single place that holds the known hubs, adds
// and removes and renames them, and names the active one.
//
// It is pure: no disk, no sockets. The client hands it the saved list and gets
// back a new list (nothing is mutated in place, so a caller cannot half-apply a
// change), and asks it for the connection target. Persistence and the screen
// read its answers; they do not re-decide.
//
// "This PC" is always present and cannot be removed or renamed: the hub the app
// runs for itself is the one every install has, the floor you fall back to when
// a friend's hub is unreachable.

import { HubAddress, parseHubAddress, formatHubAddress, HubReach } from "./hubaddress.js";

export interface KnownHub {
  /** Stable id, minted by the caller (it owns id-generation). `"self"` is reserved. */
  id: string;
  /** What the person calls it — "My Cloud9", "Priya's". One line, already trimmed. */
  label: string;
  /** The checked address. For `"self"` this is loopback. */
  address: HubAddress;
  /** True for the one hub this install runs itself. Exactly one is always self. */
  isSelf: boolean;
}

export interface HubBook {
  hubs: KnownHub[];
  /** The id of the hub currently connected. Always one that exists in `hubs`. */
  activeId: string;
}

export type HubBookResult =
  | { ok: true; book: HubBook }
  | { ok: false; reason: string };

const SELF_ID = "self";
const MAX_LABEL = 40;
const MAX_HUBS = 20; // a person's own + a handful of friends; a sane ceiling.

/** The starting book: only this computer, and it is active. */
export function selfOnlyBook(selfAddress: HubAddress): HubBook {
  return {
    hubs: [{ id: SELF_ID, label: "This computer", address: selfAddress, isSelf: true }],
    activeId: SELF_ID,
  };
}

/** The hub the client should dial right now. Never throws — activeId is kept valid. */
export function activeHub(book: HubBook): KnownHub {
  return book.hubs.find(h => h.id === book.activeId) ?? book.hubs[0];
}

/**
 * Add a hub from something a friend shared. `id` is minted by the caller so this
 * module never needs a clock or randomness. Refuses a bad address, a blank or
 * over-long label, a duplicate address, a clashing id, or going over the ceiling.
 * Returns a NEW book; the input is untouched.
 */
export function addHub(
  book: HubBook, id: string, label: string, shared: string,
): HubBookResult {
  const name = typeof label === "string" ? label.trim() : "";
  if (name === "") return { ok: false, reason: "give this Cloud9 a short name so you can tell it apart" };
  if (name.length > MAX_LABEL) return { ok: false, reason: `that name is too long (max ${MAX_LABEL})` };
  if (id === SELF_ID) return { ok: false, reason: "that id is reserved for this computer" };
  if (book.hubs.some(h => h.id === id)) return { ok: false, reason: "a hub with that id is already saved" };
  if (book.hubs.length >= MAX_HUBS) {
    return { ok: false, reason: `that's as many hubs as Cloud9 keeps (${MAX_HUBS}) — remove one first` };
  }

  const parsed = parseHubAddress(shared);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const key = addressKey(parsed.address);
  const clash = book.hubs.find(h => addressKey(h.address) === key);
  if (clash) return { ok: false, reason: `you already have that address, saved as "${clash.label}"` };

  return {
    ok: true,
    book: {
      ...book,
      hubs: [...book.hubs, { id, label: name, address: parsed.address, isSelf: false }],
    },
  };
}

/** Remove a saved hub. Refuses to remove "this computer". If it was active, self becomes active. */
export function removeHub(book: HubBook, id: string): HubBookResult {
  const hub = book.hubs.find(h => h.id === id);
  if (!hub) return { ok: false, reason: "there is no saved hub with that id" };
  if (hub.isSelf) return { ok: false, reason: "this computer's own Cloud9 can't be removed" };
  const hubs = book.hubs.filter(h => h.id !== id);
  const activeId = book.activeId === id ? SELF_ID : book.activeId;
  return { ok: true, book: { ...book, hubs, activeId } };
}

/** Rename a saved hub. "This computer" keeps its name. Blank/over-long/duplicate refused. */
export function renameHub(book: HubBook, id: string, label: string): HubBookResult {
  const hub = book.hubs.find(h => h.id === id);
  if (!hub) return { ok: false, reason: "there is no saved hub with that id" };
  if (hub.isSelf) return { ok: false, reason: "this computer's own Cloud9 keeps its name" };
  const name = typeof label === "string" ? label.trim() : "";
  if (name === "") return { ok: false, reason: "a hub needs a short name" };
  if (name.length > MAX_LABEL) return { ok: false, reason: `that name is too long (max ${MAX_LABEL})` };
  if (book.hubs.some(h => h.id !== id && h.label.toLowerCase() === name.toLowerCase())) {
    return { ok: false, reason: `you already have a hub called "${name}"` };
  }
  return {
    ok: true,
    book: { ...book, hubs: book.hubs.map(h => (h.id === id ? { ...h, label: name } : h)) },
  };
}

/** Switch which hub is live. Refuses an id that isn't saved. */
export function switchTo(book: HubBook, id: string): HubBookResult {
  if (!book.hubs.some(h => h.id === id)) return { ok: false, reason: "there is no saved hub with that id" };
  return { ok: true, book: { ...book, activeId: id } };
}

/**
 * Repair a book that was loaded from disk: drop anything malformed, guarantee
 * exactly one self, and keep activeId pointing at a hub that exists. A stored
 * file can be old or hand-edited, so the client passes it through here before
 * trusting it. Never throws.
 */
export function reconcile(raw: unknown, selfAddress: HubAddress): HubBook {
  const base = selfOnlyBook(selfAddress);
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Partial<HubBook>;
  if (!Array.isArray(r.hubs)) return base;

  const seenIds = new Set<string>([SELF_ID]);
  const seenAddr = new Set<string>([addressKey(selfAddress)]);
  const kept: KnownHub[] = [base.hubs[0]];

  for (const h of r.hubs) {
    if (!h || typeof h !== "object") continue;
    const { id, label, address } = h as Partial<KnownHub>;
    if (typeof id !== "string" || id === SELF_ID || seenIds.has(id)) continue;
    if (typeof label !== "string" || label.trim() === "") continue;
    if (!address || typeof address !== "object" || typeof address.host !== "string") continue;
    const key = addressKey(address as HubAddress);
    if (seenAddr.has(key)) continue;
    // Re-check the address against today's rules — a host class may have tightened.
    const reparsed = parseHubAddress(formatHubAddress(address as HubAddress));
    if (!reparsed.ok) continue;
    seenIds.add(id);
    seenAddr.add(key);
    kept.push({ id, label: label.trim().slice(0, MAX_LABEL), address: reparsed.address, isSelf: false });
    if (kept.length - 1 >= MAX_HUBS) break;
  }

  const activeId = typeof r.activeId === "string" && kept.some(h => h.id === r.activeId)
    ? r.activeId : SELF_ID;
  return { hubs: kept, activeId };
}

/** One plain line for the screen: "This computer" or "Priya's · your private network". */
export function describeHub(hub: KnownHub, reachWords: (r: HubReach) => string): string {
  return hub.isSelf ? hub.label : `${hub.label} · ${reachWords(hub.address.reach)}`;
}

/** Host+port identity, so the same place saved twice is caught however it was typed. */
function addressKey(a: HubAddress): string {
  return `${a.host.toLowerCase()}:${a.port}`;
}
