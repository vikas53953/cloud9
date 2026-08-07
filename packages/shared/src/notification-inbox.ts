/**
 * Durable mention/thread-reply inbox contracts.
 *
 * Toast delivery is intentionally separate from this inbox.  A row is saved
 * whenever the relay proves that a person was a recipient; quiet hours, mute
 * settings and OS support only decide whether a toast is raised right now.
 */

export type NotificationInboxKind = "mention" | "thread_reply";
export type NotificationInboxState = "unread" | "read" | "dismissed";
export type NotificationSourceState = "active" | "deleted" | "inaccessible";

/** Conservative, explicit retention: rows are not an unbounded second history. */
export const NOTIFICATION_INBOX_LIMITS = {
  maxEntries: 500,
  maxAgeMs: 180 * 24 * 60 * 60 * 1000,
  page: 100,
} as const;

/** Stable relay-generated id: one source event per recipient, forever. */
export function notificationEventId(
  kind: NotificationInboxKind,
  messageId: string,
  recipientId: string,
): string {
  return `notification:${kind}:${recipientId}:${messageId}`;
}
/** A projected row safe for a client to render and optionally jump into. */
export interface NotificationInboxEntry {
  id: string;
  recipientId: string;
  kind: NotificationInboxKind;
  state: NotificationInboxState;
  createdAt: number;
  actorId: string;
  actorName: string;
  title: string;
  body: string;
  sourceState: NotificationSourceState;
  /** Present only while the source is accessible. */
  channelId?: string;
  messageId?: string;
  rootId?: string;
}
