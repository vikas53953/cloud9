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
}

/** Defaults matching `cloud9.prefs` in Settings today. */
export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = {
  notify: false,
  quietOn: false,
  quietFrom: "22:00",
  quietTo: "08:00",
};

/**
 * The four events that raise a notification. Nothing else.
 * (Ordinary chat lines are NOT in this set — the legacy desktop
 * "new message" toast is outside this contract; the conductor may
 * retire it later.)
 */
export type NotifyKind =
  | "job_finished"
  | "approval_asked"
  | "mention"
  | "artifact_published";

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
  | "self";

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
 *  3. quiet hours
 *  4. already shown (key in `seen`)
 *  5. raise
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
 * True when this kind is one of the four that may raise.
 * Useful for callers that map hub frames → events and want a
 * single allow-list check.
 */
export function isNotifyKind(k: string): k is NotifyKind {
  return (
    k === "job_finished" ||
    k === "approval_asked" ||
    k === "mention" ||
    k === "artifact_published"
  );
}
