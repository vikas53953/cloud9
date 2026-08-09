/**
 * Durable, plain-text composer drafts.
 *
 * Drafts are deliberately scoped to the signed-in user, channel, and (when
 * present) a reply/thread.  The value is kept as text exactly as entered.  A
 * rejected write never clears or truncates an existing draft.
 */

export interface ChatDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ChatDraftScope {
  channelId: string;
  userId: string;
  /** A reply/thread id; omit it for the channel composer draft. */
  threadId?: string | null;
}

export interface ChatDraftOptions {
  /** Dependency injection for tests or an alternate browser storage. */
  storage?: ChatDraftStorage | null;
}

export const CHAT_DRAFT_KEY_PREFIX = "cloud9.chat-draft.v1";
/** Maximum UTF-16 code units accepted for one draft. */
export const CHAT_DRAFT_MAX_LENGTH = 20_000;
const MAX_SCOPE_PART_LENGTH = 256;

export type ChatDraftFailureReason =
  | "invalid-scope"
  | "invalid-text"
  | "too-long"
  | "storage-unavailable"
  | "storage-error";

export interface ChatDraftFailure {
  ok: false;
  reason: ChatDraftFailureReason;
  key?: string;
  length?: number;
  maxLength?: number;
}

export interface ChatDraftLoadSuccess {
  ok: true;
  key: string;
  text: string | null;
}

export interface ChatDraftSaveSuccess {
  ok: true;
  key: string;
  text: string;
}

export interface ChatDraftClearSuccess {
  ok: true;
  key: string;
}

export type ChatDraftLoadResult = ChatDraftLoadSuccess | ChatDraftFailure;
export type ChatDraftSaveResult = ChatDraftSaveSuccess | ChatDraftFailure;
export type ChatDraftClearResult = ChatDraftClearSuccess | ChatDraftFailure;

interface NormalizedScope {
  channelId: string;
  userId: string;
  threadId: string;
}

function isStorage(value: unknown): value is ChatDraftStorage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ChatDraftStorage>;
  return typeof candidate.getItem === "function" &&
    typeof candidate.setItem === "function" &&
    typeof candidate.removeItem === "function";
}

function readDefaultStorage(): ChatDraftStorage | null {
  // Access to browser storage itself can throw (for example, in a blocked
  // origin or a privacy-restricted WebView), so even the getter is guarded.
  try {
    const candidate = (globalThis as typeof globalThis & {
      localStorage?: unknown;
    }).localStorage;
    return isStorage(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function resolveStorage(options?: ChatDraftOptions): ChatDraftStorage | null {
  if (options?.storage !== undefined) {
    return isStorage(options.storage) ? options.storage : null;
  }
  return readDefaultStorage();
}

function normalizeScopePart(value: unknown, optional: boolean): string | null {
  if (optional && (value === undefined || value === null || value === "")) {
    return "";
  }
  if (typeof value !== "string" || value.length === 0 ||
      value.length > MAX_SCOPE_PART_LENGTH || value.trim() !== value) {
    return null;
  }
  return value;
}

function normalizeScope(scope: ChatDraftScope): NormalizedScope | null {
  if (!scope || typeof scope !== "object") return null;
  const candidate = scope as Partial<ChatDraftScope>;
  const channelId = normalizeScopePart(candidate.channelId, false);
  const userId = normalizeScopePart(candidate.userId, false);
  const threadId = normalizeScopePart(candidate.threadId, true);
  if (channelId === null || userId === null || threadId === null) return null;
  return { channelId, userId, threadId };
}

function encodeKeyPart(value: string): string {
  // URI encoding makes separators and user-controlled punctuation unambiguous
  // without putting the raw identifiers into a storage key.
  return encodeURIComponent(value);
}

function keyForScope(scope: NormalizedScope): string {
  // Prefix the optional part so a legitimate message id can never collide with
  // the room-level sentinel (for example, a message id literally named "room").
  const thread = scope.threadId ? `message-${encodeKeyPart(scope.threadId)}` : "room-level";
  return `${CHAT_DRAFT_KEY_PREFIX}:user=${encodeKeyPart(scope.userId)}:channel=${encodeKeyPart(scope.channelId)}:thread=${thread}`;
}

function failure(reason: ChatDraftFailureReason, key?: string): ChatDraftFailure {
  return key === undefined ? { ok: false, reason } : { ok: false, reason, key };
}

/** Return the deterministic localStorage key, or null for an invalid scope. */
export function chatDraftKey(scope: ChatDraftScope): string | null {
  const normalized = normalizeScope(scope);
  return normalized ? keyForScope(normalized) : null;
}

export function loadChatDraft(
  scope: ChatDraftScope,
  options?: ChatDraftOptions,
): ChatDraftLoadResult {
  const normalized = normalizeScope(scope);
  if (!normalized) return failure("invalid-scope");
  const key = keyForScope(normalized);
  const storage = resolveStorage(options);
  if (!storage) return failure("storage-unavailable", key);
  try {
    const text = storage.getItem(key);
    // A real Storage returns only string|null. Treat an incompatible adapter
    // as unavailable rather than handing non-text data to the composer.
    return text === null || typeof text === "string"
      ? { ok: true, key, text }
      : failure("storage-error", key);
  } catch {
    return failure("storage-error", key);
  }
}

export function saveChatDraft(
  scope: ChatDraftScope,
  text: string,
  options?: ChatDraftOptions,
): ChatDraftSaveResult {
  const normalized = normalizeScope(scope);
  if (!normalized) return failure("invalid-scope");
  const key = keyForScope(normalized);
  if (typeof text !== "string") return failure("invalid-text", key);
  if (text.length > CHAT_DRAFT_MAX_LENGTH) {
    return {
      ...failure("too-long", key),
      length: text.length,
      maxLength: CHAT_DRAFT_MAX_LENGTH,
    };
  }
  const storage = resolveStorage(options);
  if (!storage) return failure("storage-unavailable", key);
  try {
    storage.setItem(key, text);
    return { ok: true, key, text };
  } catch {
    // setItem is atomic for browser Storage. Crucially, do not remove a prior
    // value after a quota/security failure: the user's last draft is safer
    // left intact than silently destroyed.
    return failure("storage-error", key);
  }
}

export function clearChatDraft(
  scope: ChatDraftScope,
  options?: ChatDraftOptions,
): ChatDraftClearResult {
  const normalized = normalizeScope(scope);
  if (!normalized) return failure("invalid-scope");
  const key = keyForScope(normalized);
  const storage = resolveStorage(options);
  if (!storage) return failure("storage-unavailable", key);
  try {
    storage.removeItem(key);
    return { ok: true, key };
  } catch {
    return failure("storage-error", key);
  }
}
