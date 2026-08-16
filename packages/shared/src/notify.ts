/* ============================================================
   NOTIFICATIONS — the pure rules for when a toast may fire.
   ============================================================

   Why this file exists: the screen already pops desktop toasts for
   new chat lines, and the hub already sends `{ type: "push" }` for
   proactive agent messages on mobile — but NOTHING owns the product
   rules. Quiet hours live as a private helper in App.tsx. Approvals,
   finished jobs, mentions, and published artifacts have no shared
   "should this raise a notification?" answer. So each client invents
   its own half-right behaviour (or stays silent).

   This module is that answer. Pure: no OS toast, no WebSocket, no
   disk. The screen, the phone, and any future engine path that wants
   to raise one all ask the same functions and get the same decision.

   Settings shape (apps/desktop Prefs / cloud9.prefs) is MATCHED on
   purpose — field names and quiet-hours math are the same so the
   conductor can point the desktop helper at this file without a
   prefs migration.
*/

import { channelNotificationModeFor, type ChannelNotificationMode } from "./chat-personalization.js";

/** Preference fields that gate notifications. Same names as Settings. */
export interface NotifyPrefs {
  /** Master switch. Off → nothing raises. Default in Settings is false. */
  notify: boolean;
  /** When true, the From/Until window silences pop-ups. */
  quietOn: boolean;
  /** "HH:MM" local time — start of the quiet window. */
  quietFrom: string;
  /** "HH:MM" local time — end of the quiet window (exclusive). */
  quietTo: string;
  /**
   * ROOMS HE HAS TURNED DOWN. One list of channel ids; absent or empty means
   * nothing is muted, so an install from before this setting behaves exactly
   * as it did.
   *
   * Muting a room silences its news EXCEPT a direct mention of him — somebody
   * asking him a question by name is not the noise he muted the room for. That
   * is the whole rule; there is no second level and no per-kind matrix.
   */
  mutedChannelIds?: readonly string[];
  /** Explicit per-room mode. Legacy mutedChannelIds remains supported. */
  channelNotificationModes?: Readonly<Record<string, ChannelNotificationMode>>;
}

/** Defaults matching `cloud9.prefs` in Settings today. */
export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  notify: false,
  quietOn: false,
  quietFrom: "22:00",
  quietTo: "08:00",
  mutedChannelIds: [],
  channelNotificationModes: {},
};

/**
 * The five events that raise a notification. Nothing else.
 * (Ordinary chat lines are NOT in this set — the legacy desktop
 * "new message" toast is outside this contract; the conductor may
 * retire it later.)
 *
 * `thread_reply` is the fifth and the narrowest: a thread is a side
 * conversation, and a side conversation is only news to the people already
 * in it. See `threadReplyEvent` at the foot of this file for who that is.
 */
export type NotifyKind =
  | "job_finished"
  | "approval_asked"
  | "mention"
  | "artifact_published"
  | "thread_reply";

/** One thing that happened and might deserve a toast. */
export interface NotifyEvent {
  kind: NotifyKind;
  /**
   * Stable id of the underlying thing — task id, approval id,
   * message id, or artifact version id. Used for de-duplication.
   */
  subjectId: string;
  /** Conversation it belongs to, when known. */
  channelId?: string;
  /** Who caused it (agent or person). Absent when unknown. */
  actorId?: string;
  /** Who should receive the toast. */
  recipientId: string;
  /** Short title a toast would show (already plain words). */
  title: string;
  /** Body line, already truncated by the caller if needed. */
  body: string;
  /** When it happened, ms since epoch. */
  at: number;
}

/**
 * Shape a screen row or an OS toast would render. No OS fields —
 * the client maps `title`/`body` onto Notification / APNs later.
 */
export interface Cloud9Notification {
  /** Same as the de-dupe key — one toast per subject forever in a session. */
  id: string;
  kind: NotifyKind;
  title: string;
  body: string;
  channelId?: string;
  subjectId: string;
  at: number;
}

export type NotifySuppressReason =
  | "notifications_off"
  | "quiet_hours"
  | "duplicate"
  | "self"
  | "room_muted";

export type NotifyDecision =
  | { raise: true; notification: Cloud9Notification; key: string }
  | { raise: false; reason: NotifySuppressReason; key: string };

/** Parse "HH:MM" into minutes since midnight. Bad input → 0. */
function mins(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Are we inside the quiet window right now?
 *
 * Matches the Settings helper in App.tsx byte-for-byte in spirit:
 * - quietOn false → never quiet
 * - from <= to → same-day window [from, to)
 * - from > to  → wraps midnight (e.g. 22:00 → 08:00)
 *
 * Quiet hours silence EVERY toast, including approvals. Settings copy
 * says urgent work still lands in Tasks for the morning — that path
 * is Tasks, not a pop-up. So this function does not carve out kinds.
 */
export function inQuietHours(
  prefs: Pick<NotifyPrefs, "quietOn" | "quietFrom" | "quietTo">,
  now: Date = new Date(),
): boolean {
  if (!prefs.quietOn) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  const from = mins(prefs.quietFrom);
  const to = mins(prefs.quietTo);
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

/**
 * IS THIS ROOM TURNED DOWN? The one reader of the mute list.
 *
 * An event with no room (`channelId` absent) is never muted — there is no room
 * to have muted, and silently dropping news nobody chose to silence would be
 * the opposite of what this setting says.
 */
export function isRoomMuted(
  prefs: Pick<NotifyPrefs, "mutedChannelIds">,
  channelId?: string,
): boolean {
  if (!channelId) return false;
  // A stored settings file is not a promise: anything that is not a list is
  // read as "nothing muted" rather than throwing inside the one gate.
  const list = prefs.mutedChannelIds;
  return Array.isArray(list) && list.includes(channelId);
}

/**
 * Turn one room down, or back up — as a NEW prefs object. Pure, so the screen,
 * a test and any future phone all change the list the same way, and a room can
 * never end up in the list twice.
 */
export function withRoomMuted<P extends Pick<NotifyPrefs, "mutedChannelIds">>(
  prefs: P, channelId: string, muted: boolean,
): P & { mutedChannelIds: string[] } {
  const list = prefs.mutedChannelIds;
  const now = (Array.isArray(list) ? list : []).filter(id => id !== channelId);
  return { ...prefs, mutedChannelIds: muted ? [...now, channelId] : now };
}

/**
 * One key per (kind, subject). Two "job finished" events for the
 * same task collapse; a mention and an approval about different
 * subjects never collide.
 */
export function dedupeKey(event: Pick<NotifyEvent, "kind" | "subjectId">): string {
  return `${event.kind}:${event.subjectId}`;
}

/** Build the renderable notification. Does not apply prefs or quiet hours. */
export function notificationFromEvent(event: NotifyEvent): Cloud9Notification {
  return {
    id: dedupeKey(event),
    kind: event.kind,
    title: event.title,
    body: event.body,
    channelId: event.channelId,
    subjectId: event.subjectId,
    at: event.at,
  };
}

/**
 * Should this event raise a notification for this recipient, right now?
 *
 * Order of checks (first match wins):
 *  1. master switch off
 *  2. you caused it yourself (actor === recipient)
 *  3. this room is muted — unless it is a direct mention of you
 *  4. quiet hours
 *  5. already shown (key in `seen`)
 *  6. raise
 *
 * The room rule lives INSIDE this gate on purpose: a second gate outside it
 * would be a second owner of "should this interrupt him", which is exactly how
 * quiet hours drifted before. It can only ever SILENCE — a mention that
 * survives a muted room still has quiet hours and the master switch ahead of
 * it, so muting can never make something louder.
 *
 * Pure: does not mutate `seen`. Caller records `decision.key` after a
 * raise so the next call suppresses the duplicate.
 */
export function decideNotification(
  event: NotifyEvent,
  prefs: NotifyPrefs,
  seen: ReadonlySet<string> = new Set(),
  now: Date = new Date(),
): NotifyDecision {
  const key = dedupeKey(event);

  if (!prefs.notify) {
    return { raise: false, reason: "notifications_off", key };
  }
  if (event.actorId && event.actorId === event.recipientId) {
    return { raise: false, reason: "self", key };
  }
  /* A MUTED ROOM SILENCES A THREAD REPLY TOO — deliberately.
     Turning a room down is a statement about the whole room, and a thread is
     part of that room, not an exception to it. Only a DIRECT mention pierces
     mute, because somebody asking him by name is the one thing he did not mute
     the room to avoid. If thread replies pierced it as well, muting a busy room
     would still deliver most of its traffic — the setting would be wording
     rather than behaviour. (He can still see the thread on his own terms: the
     room row says the new activity is inside a thread — see `unreadFor` on the
     desktop screen — so muting hides the interruption, never the news.) */
  const roomMode = channelNotificationModeFor(prefs, event.channelId);
  if (roomMode === "off" || (roomMode === "mentions" && event.kind !== "mention")) {
    return { raise: false, reason: "room_muted", key };
  }
  if (inQuietHours(prefs, now)) {
    return { raise: false, reason: "quiet_hours", key };
  }
  if (seen.has(key)) {
    return { raise: false, reason: "duplicate", key };
  }

  return {
    raise: true,
    notification: notificationFromEvent(event),
    key,
  };
}

/**
 * True when this kind is one of the five that may raise.
 * Useful for callers that map hub frames → events and want a
 * single allow-list check.
 */
export function isNotifyKind(k: string): k is NotifyKind {
  return (
    k === "job_finished" ||
    k === "approval_asked" ||
    k === "mention" ||
    k === "artifact_published" ||
    k === "thread_reply"
  );
}

/* ============================================================
   WHERE A RAISED NOTIFICATION IS DELIVERED
   ============================================================

   `decideNotification` above is still the ONLY judge of WHETHER he is
   interrupted. Nothing below can raise something the gate silenced, and
   nothing below can silence something the gate raised. This half answers a
   different question — the notification IS happening; which door does it come
   through, the in-app toast or the operating system's own?

   The rule in one line: if he is looking at Cloud9, the toast is enough; if he
   is not, the toast is invisible and it has to be the operating system's.
   Anything that stops the OS one from happening falls back to the toast and
   SAYS SO — a notification is never dropped in silence.

   Pure on purpose: this is the piece worth testing, and it must be testable
   without Electron, a window or a real operating system.
*/

/** What the app knows about its own window and the OS, at the moment of delivery. */
export interface DeliveryContext {
  /** Is the Cloud9 window the one he is looking at right now? */
  windowFocused: boolean;
  /** Can this build show an OS notification at all? (No bridge in a browser.) */
  osSupported: boolean;
  /**
   * Has the operating system allowed it? False after a refusal (Windows
   * focus-assist, a disabled app in OS settings, a throw from the shell).
   * Default true — most machines allow it, and a refusal is learned, not assumed.
   */
  osPermitted?: boolean;
}

/** The two doors. There is no third. */
export type DeliveryVia = "in_app_toast" | "os_notification";

export type DeliveryReason =
  /** he is looking at Cloud9 — the toast is the right home, no OS toast */
  | "window_focused"
  /** he is elsewhere — the OS is the only door he would see */
  | "window_not_focused"
  /** no OS door in this build (dev in a browser, or no bridge) */
  | "os_unsupported"
  /** the OS was asked and said no */
  | "os_refused";

export interface DeliveryChoice {
  via: DeliveryVia;
  reason: DeliveryReason;
  /**
   * True when the OS was the right home for this and could not take it, so the
   * in-app toast is standing in. The screen records these; "it went nowhere"
   * is never an acceptable outcome.
   */
  fellBack: boolean;
}

/**
 * Which door this notification comes through. See the block comment above.
 *
 * - focused window                    → in-app toast (and NO OS toast: one
 *                                       piece of news, one interruption)
 * - unfocused, OS available           → OS notification
 * - unfocused, no OS door             → in-app toast, marked as a fallback
 * - unfocused, OS refused             → in-app toast, marked as a fallback
 */
export function chooseDelivery(ctx: DeliveryContext): DeliveryChoice {
  if (ctx.windowFocused) {
    return { via: "in_app_toast", reason: "window_focused", fellBack: false };
  }
  if (!ctx.osSupported) {
    return { via: "in_app_toast", reason: "os_unsupported", fellBack: true };
  }
  if (ctx.osPermitted === false) {
    return { via: "in_app_toast", reason: "os_refused", fellBack: true };
  }
  return { via: "os_notification", reason: "window_not_focused", fellBack: false };
}

/**
 * WHAT CLICKING A NOTIFICATION SHOULD OPEN.
 *
 * Pure, because "which screen" is a rule, not a rendering job. The screen maps
 * each answer onto the navigation owners it already has (the same ones a search
 * result uses): a room + a message to jump to, the Tasks screen, or the room a
 * file was published in.
 *
 * `artifact_published` deliberately lands in the ROOM and not in Files: the
 * notification's subject is a VERSION id, and Files opens by artifact id — so
 * pointing it at Files would be a guess. The room shows the file's own card,
 * which is a real place the thing actually is.
 *
 * `thread_reply` lands on the REPLY, the same way a mention does, and for the
 * same reason: the subject IS a message. There is no `go: "thread"` answer here
 * because this module does not know which message the reply hangs off — the
 * screen does (`replyTo`), and it already has one owner for "open the thread
 * this message is in", the one a search result uses. Pointing at the message is
 * the whole truth this file holds; the screen unrolls the thread around it.
 */
export type NotifyTarget =
  | { go: "message"; channelId: string; messageId: string }
  | { go: "tasks" }
  | { go: "room"; channelId: string };

export function notifyTarget(n: Pick<Cloud9Notification, "kind" | "channelId" | "subjectId">):
  NotifyTarget | null {
  if (n.kind === "mention" || n.kind === "thread_reply") {
    return n.channelId ? { go: "message", channelId: n.channelId, messageId: n.subjectId } : null;
  }
  if (n.kind === "job_finished" || n.kind === "approval_asked") return { go: "tasks" };
  return n.channelId ? { go: "room", channelId: n.channelId } : null;
}

/* ============================================================
   A REPLY IN A THREAD YOU ARE IN
   ============================================================

   The complaint this answers: a thread is a side conversation, and nothing
   ever told him one had moved. The room badge said "1 new", the conversation
   showed nothing new (the reply lives off-scroll, on the message it answers),
   and he had to hunt for it.

   WHO IS TOLD, in one sentence: the people already in the thread — whoever
   wrote the message it hangs off, and whoever has already replied in it.
   Nobody else. A thread you have nothing to do with is exactly the noise the
   room's own scroll was already too full of; turning it into a pop-up would be
   the same mistake with a louder voice.

   WHY THE RULE LIVES HERE and not with the other four builders (which are in
   `packages/engine/src/notify-feed.ts`): those four map a domain OBJECT —
   Task, Approval, Message, ArtifactVersion — onto words, so they belong with
   the engine's types. This one is a RULE about who counts as being in a
   conversation, and rules are this file's job. It therefore takes plain
   strings, never a `Message`, so it stays free of every domain type and is
   testable on its own. The engine may re-export it; it must not re-decide it.
*/

/** Longest body a thread-reply toast carries. Matches `NOTIFY_BODY_MAX` in
 *  `packages/engine/src/notify-feed.ts` — the engine cannot be imported from
 *  here (this package is the one it depends on), so the number is repeated on
 *  purpose and the two are meant to stay the same. */
export const THREAD_REPLY_BODY_MAX = 140;

function shortBody(text: string, max = THREAD_REPLY_BODY_MAX): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/** Who is looking, and which agents count as "one of theirs". */
export interface ThreadViewer {
  /** the person this decision is being made for */
  id: string;
  /** ids of the agents this person owns — their agent being in a thread puts
   *  them in it too, the same way a mention of their agent is a mention of them */
  agentIds?: readonly string[];
}

/**
 * ONE REPLY, AND THE THREAD AS IT STOOD WHEN IT LANDED.
 *
 * `threadAuthorIds` is the honest half of this shape. It must hold the authors
 * of the root and of the replies that were ALREADY there — never the ones that
 * came after. Passing the thread as it stands *today* would mean that the
 * moment he replies to a thread, every older reply in it suddenly becomes news
 * he was "in the thread" for, and he would be handed a burst of toasts about
 * messages he has just finished reading. The caller therefore filters by time;
 * this module cannot, because it is handed ids, not timestamps.
 */
export interface ThreadReplyFacts {
  /** the reply itself — the de-dupe subject, so each reply raises at most once */
  replyId: string;
  /** the room the thread lives in — the mute list is read against this */
  channelId: string;
  /** who wrote the reply */
  authorId: string;
  /** their display name, for the toast's first line */
  authorName: string;
  /** what the reply says (trimmed here to one toast-sized line) */
  text: string;
  /** when the reply landed, ms since epoch */
  at: number;
  /** the message the thread hangs off */
  rootId: string;
  /** who wrote that message — starting a thread puts you in it */
  rootAuthorId: string;
  /** authors of the replies that were already in the thread. See above. */
  threadAuthorIds?: readonly string[];
  /** ids this reply @s, if any — a mention is a louder event than this one */
  mentions?: readonly string[];
}

/** Is this viewer (or one of their agents) one of `ids`? */
function isOneOfMine(ids: readonly string[], viewer: ThreadViewer): boolean {
  const mine = viewer.agentIds ?? [];
  return ids.some(id => id === viewer.id || mine.includes(id));
}

/**
 * IS THIS VIEWER IN THIS THREAD? — started it, or has replied in it.
 *
 * Exported because the screen wants the same answer for a quieter purpose than
 * a toast (which threads to mark as having moved), and two answers to "am I in
 * this thread" is exactly how quiet hours drifted before.
 */
export function isThreadParticipant(
  facts: Pick<ThreadReplyFacts, "rootAuthorId" | "threadAuthorIds">,
  viewer: ThreadViewer,
): boolean {
  return isOneOfMine([facts.rootAuthorId, ...(facts.threadAuthorIds ?? [])], viewer);
}

/**
 * A reply in a thread this person is in → a `thread_reply` event. `null` when
 * it is not their news at all.
 *
 * Four ways it is not their news, and each is decided from the FACT, never from
 * the clock or the settings (those are `decideNotification`'s job):
 *
 *  1. they wrote it themselves — your own reply is not news;
 *  2. they are not in the thread — a side conversation between other people is
 *     the noise this whole feature exists to keep out of his way;
 *  3. the reply @s them — then it is a `mention`, which is louder, pierces a
 *     muted room, and would otherwise arrive as a SECOND toast about the same
 *     message. One message, one interruption;
 *  4. it is not a reply at all (`rootId` empty) — there is no thread.
 *
 * Everything else — the master switch, muting, quiet hours, de-dupe — is
 * `decideNotification`'s, unchanged and un-bypassed.
 */
export function threadReplyEvent(
  facts: ThreadReplyFacts, viewer: ThreadViewer,
): NotifyEvent | null {
  if (!facts.rootId || !facts.replyId) return null;
  if (facts.authorId === viewer.id) return null;
  if (!isThreadParticipant(facts, viewer)) return null;
  if (isOneOfMine(facts.mentions ?? [], viewer)) return null;

  const mine = facts.rootAuthorId === viewer.id
    || (viewer.agentIds ?? []).includes(facts.rootAuthorId);
  return {
    kind: "thread_reply",
    subjectId: facts.replyId,
    channelId: facts.channelId,
    actorId: facts.authorId,
    recipientId: viewer.id,
    title: mine
      ? `${facts.authorName} replied in your thread`
      : `${facts.authorName} replied in a thread you are in`,
    // A reply of nothing but spaces is still a reply that happened; the toast
    // says so rather than showing him a blank line.
    body: shortBody(facts.text).trim() || "(no message)",
    at: facts.at,
  };
}
