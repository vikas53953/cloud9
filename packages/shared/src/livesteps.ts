// LIVE STEPS — what an agent is doing RIGHT NOW, while it is still doing it.
//
// Sitting in a CLI you watch each tool call land as it happens. Cloud9 showed
// "X is working on it" for two minutes and then the whole story at once, because
// every provider waited for the process to exit before it parsed a single line.
// This is the wire shape for the other half: the steps, as they arrive.
//
// ======================== IT IS A PREVIEW, NOT A RECORD ========================
//
// THE STORED `RunRecord` IS STILL THE TRUTH, and it is unchanged. It is built at
// the end of the turn from the full buffered output, exactly as before, and it
// is the only thing that is written down, searched, listed, or fetched later.
// What travels here is a preview of that same record while it is being earned.
//
// So this follows the RECEIPTS law (`receipts.ts`), word for word:
//
//   * THE HUB STORES NOTHING. It checks who may see the room, forwards, and
//     forgets. Nothing becomes a message, a reaction, an activity row or an
//     unread. Search finds none of it.
//   * IT MAY HONESTLY VANISH. Reload mid-turn and the live steps are simply
//     gone — and the real record still appears when the turn finishes, because
//     that arrives by its own separate, stored path.
//   * ROOM VISIBILITY HAS ONE OWNER. It goes out through the same
//     `audienceFor`/`toChannel` every other broadcast uses. A second rule about
//     who may see a room is a leak waiting to be written.
//
// ============================== AND IT NEVER INVENTS =========================
//
// Every step here came out of the CLI's own stream, through the SAME mapper
// that builds the stored record. Cloud9 does not add a "starting…" step, does
// not guess what is coming next, and does not show a step for a line it could
// not read. If a provider or a run cannot stream, nothing is sent at all and
// the screen shows what it always showed — the record, at the end. An empty
// "live" box that never fills would be a worse lie than no box.

import type { ID, RunStep } from "./index.js";

/**
 * ONE BATCH OF STEPS FROM ONE LIVE TURN, on its way to the screens.
 *
 * `steps` is INCREMENTAL: the steps that one line of the CLI's output added or
 * changed, in `seq` order. A step already sent can come back with more filled
 * in — a command is announced when it starts and gets its `ok` when it
 * finishes, which is two events about one step. Clients merge by `seq`.
 *
 * `messageId` is the message that TRIGGERED the turn — the same anchor a
 * receipt uses, so the live steps appear against the thing that was asked, and
 * a turn with no triggering message (a schedule, a proactive line) sends none.
 *
 * `at` is stamped by the HUB, never by the engine — same reason a receipt's is:
 * a signal may only claim to be from now if the thing that saw it saw it now.
 */
export interface LiveRunSteps {
  channelId: ID;
  /** the message whose turn this is */
  messageId: ID;
  agentId: ID;
  /** steps added or changed since the last batch, in `seq` order */
  steps: RunStep[];
  /**
   * THE TURN IS OVER — stop showing the preview.
   *
   * Sent once, whether the turn worked or fell over, and it carries no steps.
   * It exists so the screen hands back to the stored record at the right moment
   * instead of waiting out a timer. The timer below is the backstop for the
   * case this never arrives (an engine that died mid-turn), and it must stay:
   * a preview that spins forever is a machine claiming work that is not
   * happening.
   */
  done?: boolean;
  /** when the hub saw it */
  at: number;
}

/**
 * HOW MANY STEPS ONE BATCH MAY CARRY.
 *
 * One line of a CLI's output describes one thing, so a real batch is one or two
 * steps. This is the hub refusing a frame that is trying to be a record rather
 * than a signal. It is far below `RUN_LIMITS.steps` on purpose: the whole run's
 * worth arrives as many small batches, never as one big one.
 */
export const LIVE_STEPS_PER_BATCH = 16;

/**
 * HOW LONG A SCREEN MAY KEEP A LIVE PREVIEW with nothing new arriving.
 *
 * Shorter than a turn can be, so it is refreshed by the next batch and expires
 * only when the batches really have stopped. Same job as `RECEIPT_STALE_MS`:
 * the hub holds nothing and cannot tell anybody a turn died, so the screen must
 * be able to stop believing in one by itself.
 */
export const LIVE_STEPS_STALE_MS = 3 * 60 * 1000;
