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
import { RECEIPT_EMOJI } from "./receipts.js";

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
  | "queued"     // it has his job and has not started it yet
  | "braked"     // it stopped itself after going round in circles
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
  /**
   * Is one of ITS go-ahead requests sitting unanswered in front of him?
   *
   * ONLY ONE THAT IS STILL ANSWERABLE. A request that ran out is not something
   * he can act on, and because this fact outranks every other one, getting it
   * wrong does not just add a bad row — it HIDES the agent's real state behind
   * a button that is no longer there. The caller must decide this with the same
   * `approvalIsDead` rule the tasks tray and the rail badge use, never by
   * looking at `status === "pending"` alone.
   */
  awaitingOwner?: boolean;
  /** what it asked him for, so the row can say what is being held up */
  awaitingWhat?: string;
  /**
   * IT HAS ONE OF HIS JOBS AND HAS NOT STARTED IT YET.
   *
   * The engine queues turns and runs two at a time, and the working lamp is
   * only lit once a turn actually begins — so an agent sitting on his job looked
   * exactly like an idle one, right down to showing the tick from the job
   * BEFORE it. This is the title of the job that is waiting to start.
   */
  queuedWork?: string;
  /** the most recent finished job we know about, if any */
  last?: {
    outcome: RunOutcome;
    /** what it was asked to do */
    ask: string;
    /** the plain-words wrap-up — `summarizeRun` already builds this */
    summary: string;
    /**
     * WHEN IT ENDED, not when it began.
     *
     * "3 minutes ago" for a job that started three hours ago and finished ten
     * seconds ago is a lie about the only thing the row is claiming. Callers
     * pass `startedAt + durationMs`, because a run record stores a start and a
     * length and there is no stored end.
     */
    finishedAt: number;
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
 *     be mid-job and still be standing there waiting for a go-ahead. THE ENGINE
 *     KEEPS THE WORKING LAMP LIT THROUGH AN APPROVAL WAIT (the lamp is set when
 *     a turn starts and cleared when it ends, and the asking happens in
 *     between), which is exactly why this rung has to come first and why
 *     anything counting "who is working" must count THESE STATES and not the
 *     raw lamp — see `workingCount`.
 *  2. It is WORKING. Beats paused and switched off deliberately — a job already
 *     in flight is a fact on the screen, and hiding it behind a setting would
 *     make a busy agent look idle.
 *  3. NOTHING CAN RUN IT — switched off, or the hub says offline. Said WITH the
 *     reason, because "off" without a why is the version of this screen that
 *     sends him hunting. Above the queue on purpose: a job queued for an agent
 *     nothing can run is not about to happen, and saying "next up" would be a
 *     promise the app cannot keep.
 *  4. He PAUSED it. His own choice, so it is a state and not a fault.
 *  5. IT IS HOLDING HIS JOB but has not started. Invisible until now, because
 *     the working lamp only lights once a turn really begins.
 *  6. IT PUT ITS OWN BRAKE ON. Its own row, never the last job's tick — an
 *     agent that stopped itself has NOT "finished", and drawing ✅ on it is the
 *     same lie 🛑 was added to stop the app telling.
 *  7. Otherwise the last finished job speaks: stopped / didn't finish /
 *     finished, in that order of "things he'd want to know first".
 *  8. And if there is no last job, say so plainly rather than showing a
 *     confident-looking empty row.
 */
export function agentActivityLine(facts: AgentActivityFacts): AgentActivityLine {
  if (facts.awaitingOwner) {
    return {
      state: "waiting",
      /* ❓ ALREADY MEANS "it asked a question back; the next move is a person's"
         (`RECEIPT_EMOJI.needsInput`) — which is this row exactly. 👀 was wrong
         here: it is already spoken for, and it means the opposite thing
         ("picked your message up, the job is queued"), so the same tick would
         have meant both "I am holding this" and "I am stuck on you". */
      mark: RECEIPT_EMOJI.needsInput,
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

  if (facts.queuedWork) {
    return {
      state: "queued",
      /* 👀 IS THE RIGHT TICK HERE AND ONLY HERE: the app already puts it on his
         message to mean "picked your message up — the job is queued". This row
         is that same fact, gathered onto one screen. */
      mark: WORK_REACTIONS.picked,
      headline: "Next up",
      detail: `It has your job and hasn't started it yet: ${facts.queuedWork}`,
    };
  }

  if (facts.status === "braked") {
    return {
      state: "braked",
      mark: "—",
      headline: "Taking a break",
      /* THE WORDS THE RAIL ALREADY USES for this same lamp ("taking a break"),
         so one fact is not called two things on two screens. */
      detail: "It stopped itself after your agents went back and forth too long. "
        + "Say something and it picks up again.",
    };
  }

  if (facts.last) {
    const when = `${agoWords(facts.last.finishedAt)}, you asked it: ${facts.last.ask}`;
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
  /* Things he can DO SOMETHING ABOUT, hardest first. `off` sits up here, not
     down with the quiet rows: "Claude isn't signed in" is a job for him, and
     burying it under three finished agents is how it stays unfixed for a day.
     It was below `done` and `ready` in the first version of this list, which
     contradicted this file's own stated rule. */
  "waiting", "working", "queued", "off", "failed", "stopped", "braked",
  /* Nothing to do here. */
  "done", "ready", "paused",
];

export function activityRank(state: AgentActivityState): number {
  const i = ACTIVITY_ORDER.indexOf(state);
  return i < 0 ? ACTIVITY_ORDER.length : i;
}

/**
 * HOW MANY AGENTS ARE WORKING — the ONE answer, for every part of the screen.
 *
 * ================== WHY THIS IS A FUNCTION AND NOT A FILTER =================
 *
 * The button in the side bar used to count `agentStatus === "working"` itself
 * while the board decided each row with the ladder above. Those are two
 * different questions and they gave two different answers ON THE SAME SCREEN:
 * the engine holds the working lamp lit through an approval wait, so an agent
 * that had stopped to ask him something made the button say "1" while the board
 * three inches away said "Nothing is being worked on".
 *
 * A person cannot be shown two numbers for one fact and be expected to pick the
 * true one. So there is now exactly one place that answers it, it answers from
 * the SAME lines the board draws, and any other count is a bug.
 */
export function workingCount(lines: readonly AgentActivityLine[]): number {
  return lines.filter(l => l.state === "working").length;
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
  const working = workingCount(lines);
  const waiting = lines.filter(l => l.state === "waiting").length;
  const queued = lines.filter(l => l.state === "queued").length;

  const waitingBit = waiting === 0
    ? ""
    : waiting === 1
      ? " One is waiting for your go-ahead."
      : ` ${waiting} are waiting for your go-ahead.`;
  const queuedBit = queued === 0
    ? ""
    : queued === 1
      ? " One has a job lined up."
      : ` ${queued} have jobs lined up.`;

  if (working > 0) {
    const busy = working === 1
      ? (total === 1 ? "Your agent is working right now." : `1 of ${crew} is working right now.`)
      : `${working} of ${crew} are working right now.`;
    return `${busy}${waitingBit}${queuedBit}`;
  }
  /* "NOTHING IS BEING WORKED ON" MUST NOT BE SAID OVER WORK THAT EXISTS. A
     queued job is work he has already handed over, so a summary that ignored it
     would be the top line disagreeing with a row three inches below it. */
  if (waiting > 0 || queued > 0) {
    return `Nothing has started yet.${waitingBit}${queuedBit}`;
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
