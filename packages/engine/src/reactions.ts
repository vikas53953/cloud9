// "Agents should react with emoji as work happens" — his item 5.
//
// THERE IS NO SECOND MECHANISM. Reactions already exist end to end (the `react`
// frame, `MessageReaction`, soft-deleted `removedAt` rows), so an agent putting
// 👀 on a message is the same feature a person putting 👀 on a message is. What
// is new is only that an ENGINE may send one on behalf of an agent it owns —
// the `agentReact` frame — authorised exactly as `agentSend` already is.
//
// AND THE VOCABULARY IS NOT OURS. `WORK_REACTIONS` lives in `@cloud9/shared`
// because the engine puts the emoji on, the hub stores it and the screen draws
// it; three programs, one tick. This file deliberately re-exports it rather
// than restating it, so there is no second list to drift.
//
// What IS this file's own job is the small, unglamorous bookkeeping underneath:
// the message that ASKED for a job and the job itself are two different things
// that arrive at two different times, and something has to hold them together
// long enough for the tick to land on the right message.
import { ID, WORK_REACTIONS, WorkReaction } from "@cloud9/shared";

export { WORK_REACTIONS, type WorkReaction };

/** The emoji for one moment in a job's life. The ONLY place phase → emoji happens. */
export function workEmoji(phase: WorkReaction): string {
  return WORK_REACTIONS[phase];
}

/**
 * "Somebody asked for a job in this message, and the hub has not given the job
 * an id yet."
 *
 * The engine sends `createTask` and the HUB mints the id, so for a moment the
 * engine knows the message but not the task. This is that moment, written down.
 */
export interface PendingAsk {
  agentId: ID;
  channelId: ID;
  /** the title we sent — the hub echoes it back on the task, unchanged */
  title: string;
  /** the message to put the ticks on */
  messageId: ID;
  at: number;
}

/**
 * How many un-matched asks are kept. A job whose task never comes back (the hub
 * refused it, the approval was rejected) would otherwise sit here forever.
 */
export const PENDING_ASK_LIMIT = 50;

/** Remember an ask, oldest dropped first. Returns a new list — nothing mutates. */
export function rememberAsk(list: readonly PendingAsk[], ask: PendingAsk): PendingAsk[] {
  const next = [...list, ask];
  return next.length > PENDING_ASK_LIMIT ? next.slice(next.length - PENDING_ASK_LIMIT) : next;
}

/**
 * Match a task the hub just created back to the message that asked for it, and
 * take it off the list.
 *
 * Matched on agent + conversation + the exact title we sent, and the OLDEST
 * match wins — two identical asks in the same room get their ticks in the order
 * they were made rather than both landing on the newer message. No match is a
 * normal answer: a job made from the Tasks panel was never asked for in a
 * message, and gets no ticks rather than someone else's.
 */
export function takeAsk(
  list: readonly PendingAsk[],
  task: { agentId: ID; channelId: ID; title: string },
): { messageId?: ID; rest: PendingAsk[] } {
  const i = list.findIndex(a =>
    a.agentId === task.agentId && a.channelId === task.channelId && a.title === task.title);
  if (i < 0) return { rest: [...list] };
  const rest = [...list];
  const [found] = rest.splice(i, 1);
  return { messageId: found.messageId, rest };
}
