/**
 * The reaction picker is allowed to remember a person's choices on this
 * device, but that preference is not room data and never belongs on the wire.
 * The user id is part of the key so switching accounts in one desktop profile
 * cannot make one person's recent reactions appear for another.
 */

export const RECENT_EMOJI_LIMIT = 12;

const STORAGE_PREFIX = "cloud9.recentEmoji.v1.";
const EMPTY: readonly string[] = [];
const snapshots = new Map<string, readonly string[]>();
const listeners = new Map<string, Set<() => void>>();

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId)}`;
}

function clean(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const emoji = candidate.trim();
    if (!emoji || seen.has(emoji)) continue;
    seen.add(emoji);
    out.push(emoji);
    if (out.length >= RECENT_EMOJI_LIMIT) break;
  }
  return out;
}

function load(userId: string): readonly string[] {
  const existing = snapshots.get(userId);
  if (existing) return existing;
  let value: string[] = [];
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(storageKey(userId));
      if (raw) value = clean(JSON.parse(raw));
    }
  } catch { /* unavailable or malformed storage means no recent list */ }
  const snapshot = value.length > 0 ? value : EMPTY;
  snapshots.set(userId, snapshot);
  return snapshot;
}

/** Read the persisted recent list for one authenticated user on this device. */
export function recentEmojisFor(userId?: string): readonly string[] {
  return userId ? load(userId) : EMPTY;
}

/** Subscribe to changes for one user; the UI remains scoped to that identity. */
export function subscribeRecentEmojis(userId: string | undefined, listener: () => void): () => void {
  if (!userId) return () => undefined;
  const set = listeners.get(userId) ?? new Set<() => void>();
  set.add(listener);
  listeners.set(userId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(userId);
  };
}

/**
 * Remember a choice only after its caller knows the action succeeded. Newest
 * first, exact-emoji deduplication, and a small cap keep the picker useful.
 */
export function rememberRecentEmoji(userId: string | undefined, value: string): readonly string[] {
  if (!userId) return EMPTY;
  const emoji = value.trim();
  if (!emoji) return load(userId);
  const current = load(userId);
  const next = [emoji, ...current.filter(item => item !== emoji)].slice(0, RECENT_EMOJI_LIMIT);
  if (next.length === current.length && next.every((item, index) => item === current[index])) return current;
  const snapshot = next.length > 0 ? next : EMPTY;
  snapshots.set(userId, snapshot);
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(storageKey(userId), JSON.stringify(snapshot));
  } catch { /* a full/blocked store must not break reacting */ }
  for (const listener of listeners.get(userId) ?? []) listener();
  return snapshot;
}

/* Another Cloud9 window may write the same per-device preference. Keep that
   update local and identity-scoped; no relay frame or room state is involved. */
if (typeof window !== "undefined") {
  window.addEventListener("storage", event => {
    if (!event.key?.startsWith(STORAGE_PREFIX)) return;
    const userId = decodeURIComponent(event.key.slice(STORAGE_PREFIX.length));
    snapshots.delete(userId);
    load(userId);
    for (const listener of listeners.get(userId) ?? []) listener();
  });
}

