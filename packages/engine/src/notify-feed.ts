/* ============================================================
   NOTIFY FEED — turning the hub's own facts into a NotifyEvent.
   ============================================================

   `packages/shared/src/notify.ts` owns the RULES: quiet hours, de-dupe,
   self-suppression, and the `decideNotification` gate. It does NOT know
   what a task, an approval, a message or an artifact IS. This module is
   the other half: it maps ONE of those four facts onto the `NotifyEvent`
   shape that `decideNotification` reads — the plain-words title and body,
   who caused it, who should hear about it, and the stable subject id used
   to de-dupe.

   The split is deliberate and matches the two questions notify.ts already
   separates:
     • WHAT is this, in words a person reads?  → this file (builders).
     • WHETHER to show it, right now, to me?    → notify.ts (decideNotification).

   It lives in the engine because the engine is where two of the four
   events are born — a delegated job finishes a turn here, and an artifact
   is published from a turn here — and because the engine is already
   imported by the screen by path (`@cloud9/engine/dist/...`) with no
   Electron or browser assumptions. It is PURE: no OS toast, no socket, no
   disk. The screen builds an event with these, then asks notify.ts.

   Every builder returns `null` when the fact is not notification-worthy
   for this viewer (someone else's job, a message that mentions nobody, an
   approval that is not this person's to answer). Returning `null` rather
   than a suppressed event keeps "this is not for me at all" separate from
   "this is for me but quiet hours are on" — the first is decided here from
   the fact, the second is decided by notify.ts from the clock.
*/

import type { Approval, ArtifactVersion, Message, Task } from "@cloud9/shared";
import type { NotifyEvent } from "@cloud9/shared/dist/notify.js";

/** Longest body a toast carries — the rest is trimmed with an ellipsis. */
export const NOTIFY_BODY_MAX = 140;

/** Trim a line to `NOTIFY_BODY_MAX`, adding "…" only when it really had to cut. */
function short(text: string): string {
  const t = text.trim();
  if (t.length <= NOTIFY_BODY_MAX) return t;
  return t.slice(0, NOTIFY_BODY_MAX - 1).trimEnd() + "…";
}

/** Who the viewer is, and which agents count as "one of theirs". */
export interface NotifyViewer {
  /** the person looking at this screen */
  id: string;
  /** ids of the agents this person owns — a mention of one is a mention of them */
  agentIds: readonly string[];
}

/**
 * A message that @s this person (or one of their agents) → a `mention`.
 *
 * A person never gets a toast for their own line, so a message authored by
 * the viewer returns `null` here rather than relying on the gate. (The gate
 * would also drop it as `self`, but a mention of yourself is not an event at
 * all — it should never reach the gate to begin with.)
 */
export function mentionEvent(message: Message, viewer: NotifyViewer): NotifyEvent | null {
  if (message.authorId === viewer.id) return null;
  const at = message.mentions ?? [];
  const hitsMe = at.some(id => id === viewer.id || viewer.agentIds.includes(id));
  if (!hitsMe) return null;
  return {
    kind: "mention",
    subjectId: message.id,
    channelId: message.channelId,
    actorId: message.authorId,
    recipientId: viewer.id,
    title: `${message.authorName} mentioned you`,
    body: short(message.text || "(no message)"),
    at: message.ts,
  };
}

/** The three states that mean a delegated job is over, one way or another. */
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * A delegated job reaching a terminal status → a `job_finished`, but ONLY
 * for the person who asked for it. Someone else's finished job is not this
 * viewer's news.
 */
export function jobFinishedEvent(
  task: Task, viewer: NotifyViewer, agentName = "Your agent",
): NotifyEvent | null {
  if (!TERMINAL.has(task.status)) return null;
  if (task.requesterId !== viewer.id) return null;
  const name = agentName;
  let title: string;
  let body: string;
  if (task.status === "completed") {
    title = `${name} finished a job`;
    body = task.summary ?? task.title;
  } else if (task.status === "failed") {
    title = `${name} couldn't finish a job`;
    body = task.error ?? task.title;
  } else {
    title = `A job was cancelled`;
    body = task.title;
  }
  return {
    kind: "job_finished",
    subjectId: task.id,
    channelId: task.channelId,
    actorId: task.agentId,
    recipientId: viewer.id,
    title,
    body: short(body || task.title),
    at: task.updatedAt,
  };
}

/**
 * An approval becoming `pending` → an `approval_asked`, but ONLY for the
 * agent's owner: only they may decide, so only they are asked. The agent is
 * the actor, so this never self-suppresses (an owner IS meant to hear that
 * their own agent wants a yes).
 */
export function approvalEvent(
  approval: Approval, viewer: NotifyViewer, agentName?: string,
): NotifyEvent | null {
  if (approval.status !== "pending") return null;
  if (approval.ownerId !== viewer.id) return null;
  const body = approval.detail ? `${approval.action} — ${approval.detail}` : approval.action;
  return {
    kind: "approval_asked",
    subjectId: approval.id,
    channelId: approval.channelId,
    actorId: approval.agentId,
    recipientId: viewer.id,
    title: agentName ? `${agentName} needs your OK` : `An agent needs your OK`,
    body: short(body || "An agent is waiting for your decision."),
    at: approval.createdAt,
  };
}

/**
 * A new artifact version stored in a conversation this person can see → an
 * `artifact_published`. The ACTOR is the person whose agent made the file
 * (`ownerId`), so when the viewer's OWN agent publishes, the gate drops it
 * as `self` — you do not get toasted for a file your own agent made. The
 * subject is the VERSION id, so every new version is its own event.
 */
export function artifactEvent(
  version: ArtifactVersion,
  channelId: string,
  fileName: string,
  viewer: NotifyViewer,
): NotifyEvent | null {
  const body = version.note ? `${fileName} — ${version.note}` : fileName;
  return {
    kind: "artifact_published",
    subjectId: version.id,
    channelId,
    actorId: version.ownerId,
    recipientId: viewer.id,
    title:
      version.version > 1
        ? `${version.agentName} updated a file`
        : `${version.agentName} shared a file`,
    body: short(body || fileName),
    at: version.producedAt,
  };
}
