// WHAT EACH AGENT IS DOING RIGHT NOW, in the owner's words.
//
// ============================ WHY THIS FILE EXISTS ============================
//
// The app could already answer "what happened" (the Activity trail) and "what
// did THIS ONE agent do" (its Recent work list, one agent at a time). It could
// not answer the question the owner actually asks when he walks up to the
// machine: **"what is my crew doing RIGHT NOW?"**
//
// Answering that means turning several separate facts — a presence word, an
// idle/working lamp, a pending go-ahead, the last finished run — into ONE
// sentence per agent. That join is the thing worth testing, so it lives here as
// a pure function rather than inside a React component where nothing can reach
// it.
//
// NOTHING HERE GUESSES. Every branch below is driven by a fact the app was
// already given; when a fact is absent the line SAYS it is absent rather than
// inventing a cheerful default. That is the same law `agentPresence` follows,
// and this function sits directly on top of it.
//
// PLAIN WORDS ONLY. No "turn", no "invocation", no "run". The owner is a
// network engineer, not a developer: he reads "working now", "you stopped it",
// "waiting for you".
import { AgentPresence, AgentStatus, RunOutcome, WORK_REACTIONS } from "./index.js";

/**
 * The eight things an agent can be, from the owner's side of the screen.
 *
 * WHY EIGHT AND NOT FOUR. `AgentPresence` has four words and answers "can I use
 * this agent". That is a different question from "what is it doing" — a ready
 * agent that just failed and a ready agent that just finished are the same
 * presence and must not look the same on this board. So the endings (`done`,
 * `failed`, `stopped`) are states here even though they are all `ready` there.
 *
 * `stopped` is its own state and not a flavour of `done` for exactly the reason
 * 🛑 was added to the work ticks on 2026-08-06: he pressed Stop, and a screen
 * that then says "finished" is lying to him about his own action.
 */
export type AgentActivityState =
  | "working"    // mid-job right now
  | "waiting"    // stopped and asking him for a go-ahead
  | "stopped"    // he stopped it
  | "failed"     // it ran and didn't finish
  | "done"       // it ran and finished
  | "paused"     // paused by him
  | "off"        // switched off, or nothing can run it
  | "ready";     // able to work, nothing to report yet

/** Everything the board is allowed to know about one agent. All observed. */
export interface AgentActivityFacts {
  /** the hub's own verdict on whether this agent can be used — `agentPresence` */
  presence?: AgentPresence;
  /** the hub's reason for that verdict, already in plain words */
  presenceReason?: string;
  /** the last idle/working/braked the engine reported */
  status?: AgentStatus;
  /** what its owner set it to */
  lifecycle?: "enabled" | "paused" | "disabled";
  /**
   * The newest live step's label, if it is mid-job and has said anything —
   * "Read note.txt", "Ran a command". ABSENT is normal and means it has not
   * reported a step yet, NOT that it is doing nothing.
   */
  doingNow?: string;
  /** what it was asked, if a job is in flight */
  askedTo?: string;
  /** is one of ITS go-ahead requests sitting unanswered in front of him? */
  awaitingOwner?: boolean;
  /** what it asked him for, so the row can say what is being held up */
  awaitingWhat?: string;
  /** the most recent finished job we know about, if any */
  last?: {
    outcome: RunOutcome;
    /** what it was asked to do */
    ask: string;
    /** the plain-words wrap-up — `summarizeRun` already builds this */
    summary: string;
    /** when it started, so the row can say how long ago */
    startedAt: number;
  };
}

/** One row of the board: a tick, a state, and a sentence that is never empty. */
export interface AgentActivityLine {
  state: AgentActivityState;
  /** the SAME tick he already reads in the chat — 👀 ⚙️ ✅ ❌ 🛑 — never a new alphabet */
  mark: string;
  /** the state in his words: "Working now", "Waiting for you" */
  headline: string;
  /**
   * What it is doing, what it just did, or why it cannot work.
   *
   * NEVER EMPTY. A blank second line on a status board reads as "the app does
   * not know", and the app usually does know something — so every branch below
   * ends in a real sentence, including the branches where the honest answer is
   * "it has not said".
   */
  detail: string;
}

/**
 * Turn the facts about one agent into the line the board draws.
 *
 * READ THE ORDER AS A LADDER OF URGENCY, not a list of cases — the first true
 * thing wins, and the order is the order he cares about:
 *
 *  1. It is BLOCKED ON HIM. Nothing else on the row matters if he is the reason
 *     the work is not moving, so this outranks even "working now": an agent can
 *     be mid-job and still be standing there waiting for a go-ahead.
 *  2. It is WORKING. Beats paused and switched off deliberately — a job already
 *     in flight is a fact on the screen, and hiding it behind a setting would
 *     make a busy agent look idle.
 *  3. NOTHING CAN RUN IT — switched off, or the hub says offline. Said WITH the
 *     reason, because "off" without a why is the version of this screen that
 *     sends him hunting.
 *  4. He PAUSED it. His own choice, so it is a state and not a fault.
 *  5. Otherwise the last finished job speaks: stopped / didn't finish /
 *     finished, in that order of "things he'd want to know first".
 *  6. And if there is no last job, say so plainly rather than showing a
 *     confident-looking empty row.
 */
export function agentActivityLine(facts: AgentActivityFacts): AgentActivityLine {
  if (facts.awaitingOwner) {
    return {
      state: "waiting",
      mark: WORK_REACTIONS.picked,
      headline: "Waiting for you",
      detail: facts.awaitingWhat
        ? `It stopped to ask: ${facts.awaitingWhat}`
        : "It stopped to ask you something and can't carry on until you answer.",
    };
  }

  const working = facts.status === "working" || facts.presence === "working";
  if (working) {
    const detail = facts.doingNow
      ? (facts.askedTo ? `${facts.doingNow} — for: ${facts.askedTo}` : facts.doingNow)
      : facts.askedTo
        ? `Working on: ${facts.askedTo}`
        : "It hasn't said what it's up to yet.";
    return { state: "working", mark: WORK_REACTIONS.working, headline: "Working now", detail };
  }

  if (facts.lifecycle === "disabled" || facts.presence === "offline") {
    return {
      state: "off",
      mark: "—",
      headline: facts.lifecycle === "disabled" ? "Switched off" : "Can't work right now",
      detail: facts.presenceReason
        ? capitalise(facts.presenceReason)
        : "Nothing on this computer can run it at the moment.",
    };
  }

  if (facts.lifecycle === "paused" || facts.presence === "paused") {
    return {
      state: "paused",
      mark: "—",
      headline: "Paused",
      detail: "You paused it. It won't pick anything up until you start it again.",
    };
  }

  if (facts.last) {
    const when = `${agoWords(facts.last.startedAt)}, you asked it: ${facts.last.ask}`;
    if (facts.last.outcome === "cancelled") {
      return {
        state: "stopped",
        mark: WORK_REACTIONS.stopped,
        headline: "You stopped it",
        detail: `${when}. ${facts.last.summary}`,
      };
    }
    if (facts.last.outcome === "failed") {
      return {
        state: "failed",
        mark: WORK_REACTIONS.failed,
        headline: "Didn't finish",
        detail: `${when}. ${facts.last.summary}`,
      };
    }
    return {
      state: "done",
      mark: WORK_REACTIONS.done,
      headline: "Finished",
      detail: `${when}. ${facts.last.summary}`,
    };
  }

  return {
    state: "ready",
    mark: "—",
    headline: "Ready",
    detail: facts.presenceReason
      ? `${capitalise(facts.presenceReason)}. It hasn't been asked to do anything yet.`
      : "It hasn't been asked to do anything yet.",
  };
}

/**
 * Which rows go at the top.
 *
 * The two states he can ACT on come first — something waiting on him, then
 * something in flight — and the quiet states sink. Within a state the board
 * keeps the caller's order (the crew's own order), so rows do not shuffle
 * around under his eyes every time a lamp changes.
 */
export const ACTIVITY_ORDER: readonly AgentActivityState[] = [
  "waiting", "working", "failed", "stopped", "done", "ready", "paused", "off",
];

export function activityRank(state: AgentActivityState): number {
  const i = ACTIVITY_ORDER.indexOf(state);
  return i < 0 ? ACTIVITY_ORDER.length : i;
}

/**
 * ONE SENTENCE FOR THE WHOLE CREW — the line at the top of the board.
 *
 * THERE IS NO SILENT VERSION OF THIS BOARD. "Nothing is happening" is an
 * answer he came for, so it is written out in words; an empty panel is the app
 * refusing to answer. Every return below is a full sentence, including the
 * no-agents one, which is also the only place that tells a brand-new owner what
 * the screen is for.
 */
export function crewActivitySummary(lines: readonly AgentActivityLine[]): string {
  if (lines.length === 0) {
    return "You don't have any agents yet. When you hire one, this is where you'll watch it work.";
  }
  const total = lines.length;
  const crew = total === 1 ? "your agent" : `your ${total} agents`;
  const working = lines.filter(l => l.state === "working").length;
  const waiting = lines.filter(l => l.state === "waiting").length;

  const waitingBit = waiting === 0
    ? ""
    : waiting === 1
      ? " One is waiting for your go-ahead."
      : ` ${waiting} are waiting for your go-ahead.`;

  if (working > 0) {
    const busy = working === 1
      ? (total === 1 ? "Your agent is working right now." : `1 of ${crew} is working right now.`)
      : `${working} of ${crew} are working right now.`;
    return `${busy}${waitingBit}`;
  }
  if (waiting > 0) {
    return `Nothing is being worked on.${waitingBit}`;
  }
  const stuck = lines.filter(l => l.state === "off").length;
  if (stuck === total) {
    return total === 1
      ? "Your agent can't work at the moment — the row below says why."
      : `None of ${crew} can work at the moment — the rows below say why.`;
  }
  return total === 1
    ? "Nothing is being worked on. Your agent is ready when you are."
    : `Nothing is being worked on. ${crew.charAt(0).toUpperCase()}${crew.slice(1)} are ready when you are.`;
}

/** "just now", "4 minutes ago", "2 hours ago", "yesterday" — no clock arithmetic on screen. */
export function agoWords(then: number, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((now - then) / 1000));
  if (secs < 45) return "Just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "Yesterday" : `${days} days ago`;
}

function capitalise(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}
