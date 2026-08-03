// SEMANTIC RECEIPTS — the emoji that appear the moment an agent picks your
// message up, and the one it leaves when it commits to a reply.
//
// HIS §2: "When a message is sent, emojis appear immediately — reading,
// thinking, or a context-derived emoji conveying how the message was
// understood. This is an agent-presence signal, not decoration."
//
// ============================ WHAT THIS IS NOT ============================
//
// IT IS NOT A REACTION, even though it looks a little like one on screen.
// A reaction is a PERSON'S DECISION and it is STORED — it lands in the
// reactions table, it survives a reload, it is somebody saying something. A
// receipt is a LIVE SIGNAL about a turn that is happening right now: the hub
// forwards it and forgets it, nothing is written down, and it may vanish on
// reload. That is correct and honest — a machine's "I am reading this" is not
// a fact worth keeping for a year, and keeping it would clutter the history
// his §2 is trying to fill with presence rather than silence.
//
// `WORK_REACTIONS` (👀 ⚙️ ✅ ❌, in `index.ts`) stays exactly as it is and is a
// different feature: those are STORED reactions an agent puts on the message
// that asked for a JOB. Receipts are ephemeral and cover every turn. They are
// deliberately not the same emoji set for the committed states, so the two can
// never be mistaken for each other on screen.
//
// ONE VOCABULARY, THREE PROGRAMS. The engine decides, the hub forwards, the
// screen draws — so the words and the emoji live here, once, and none of the
// three may invent a fifth stage or a different tick.

import type { ID } from "./index.js";

/**
 * WHERE A TURN IS, as far as anybody watching can honestly tell.
 *
 * - `reading`  — the agent has the message and the turn has begun. This is the
 *                signal that replaces silence.
 * - `thinking` — its CLI is actually running.
 * - `verdict`  — it has committed to a reply, and `verdict` says which one.
 *
 * There is no `done` and no `idle`: a turn that has ended stops sending, and
 * the screen drops what it is holding. A stage that means "nothing" would be a
 * stage a client has to decide how to draw.
 */
export type ReceiptStage = "reading" | "thinking" | "verdict";

/**
 * HOW THE MESSAGE WAS UNDERSTOOD — the four committed answers, and no fifth.
 *
 * These are DERIVED FROM WHAT THE TURN ACTUALLY DID (see `turnVerdict` in
 * `@cloud9/engine`). No model is ever asked to pick an emoji: an agent that
 * chose its own tick would be writing a claim about itself that nobody
 * checked, which is the same failure as an agent writing its own approval card.
 */
export type ReceiptVerdict = "agreed" | "conflict" | "investigating" | "needsInput";

export const RECEIPT_EMOJI = {
  /** understood, nothing in the way */
  agreed: "✅",
  /** it refused, it failed, or it found something that contradicts the ask */
  conflict: "⚠️",
  /** it went and looked — searches, reads, the web — and reported findings */
  investigating: "🔍",
  /** it asked a question back; the next move is a person's */
  needsInput: "❓",
} as const satisfies Record<ReceiptVerdict, string>;

/** The plain words a person reads in a tooltip. Never a code, never jargon. */
export const RECEIPT_WORDS = {
  agreed: "agreed",
  conflict: "conflict found",
  investigating: "investigating",
  needsInput: "needs input",
} as const satisfies Record<ReceiptVerdict, string>;

export function isReceiptVerdict(value: unknown): value is ReceiptVerdict {
  return value === "agreed" || value === "conflict"
    || value === "investigating" || value === "needsInput";
}

export function isReceiptStage(value: unknown): value is ReceiptStage {
  return value === "reading" || value === "thinking" || value === "verdict";
}

/**
 * ONE LIVE SIGNAL ABOUT ONE TURN, on its way to the screens.
 *
 * Tiny on purpose: four ids, a stage, and — only when the stage is `verdict` —
 * which verdict. It carries no text, because text is what a MESSAGE is for,
 * and a receipt that could carry a sentence would be a second, unstored,
 * unsearchable way to say things in a room.
 *
 * `at` is stamped by the HUB, never by the engine, for the same reason a
 * `syncedAt` is: a signal may only claim to be from now if the thing that saw
 * it really saw it now.
 */
export interface AgentReceipt {
  channelId: ID;
  /** the message this is ABOUT — the one that triggered the turn */
  messageId: ID;
  agentId: ID;
  stage: ReceiptStage;
  /** present exactly when `stage` is `verdict`, absent otherwise */
  verdict?: ReceiptVerdict;
  /** when the hub saw it */
  at: number;
}

/**
 * HOW LONG A SCREEN MAY KEEP ONE.
 *
 * `reading` and `thinking` are stale after this: a turn that dies with its
 * engine sends no ending, so a signal with no expiry would leave 💭 spinning
 * on a message forever and quietly lie about an agent that is not running.
 * The hub never enforces this — it holds nothing — so the screen must.
 */
export const RECEIPT_STALE_MS = 5 * 60 * 1000;

/**
 * HOW LONG THE COMMITTED TICK LINGERS after a turn ends.
 *
 * A verdict that vanished the instant the reply landed would be a signal
 * nobody ever saw. It stays a few seconds, fades, and is gone — it is not a
 * record and must never look like one.
 */
export const RECEIPT_VERDICT_LINGER_MS = 8000;
