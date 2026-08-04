// HOW LONG A TURN IS ALLOWED TO TAKE — one table, one owner.
//
// WHAT WAS WRONG. Every turn had the same leash, and it was set for a chat
// reply: 3 minutes on the Claude path, 2 on the Codex path, hard-coded in each
// provider's constructor and never overridden by anything. So `!bg`, `!code`
// and a scheduled check-in — the three kinds of work a person hands over and
// then WALKS AWAY FROM — were killed after two or three minutes of wall clock.
// The owner asked for real work and got a generic failure that did not even say
// a clock had run out. That is not a background job; that is a chat reply with
// a longer prompt.
//
// WHAT DECIDES. The same answer the prompt is built from: `promptTurnKind`
// (provider.ts). It already knows the difference between "write your next chat
// message" and "do the work", and it is derived, not passed twice — a turn
// standing in a git worktree is repository work whether it was typed in the room
// or made into a job. Reusing it means the sentence the agent reads about the
// turn and the clock the turn runs under can never disagree.
//
// WHAT IS NOT HERE. "Unlimited". The leash exists to stop a runaway CLI holding
// a slot on this computer forever, and every kind still has a real ceiling.
import type { PromptTurnKind } from "./provider.js";

/**
 * THE BUDGET TABLE. One place, four numbers, each with its reason.
 *
 * `chat` — 3 minutes. A PERSON IS SITTING THERE. This is the number the app has
 *   always used for the Claude path and nothing about it was wrong: past about
 *   three minutes a chat reply is not late, it is broken, and the honest thing
 *   is to say so rather than leave somebody watching a typing dot. It also
 *   keeps a mistyped chat message from occupying a slot for half an hour.
 *
 * `task` — 30 minutes. NOBODY IS WAITING. `!bg` and a job made from the Tasks
 *   panel are the whole delegated-work story: the point is to ask for something
 *   substantial and go and do something else. 30 minutes is a real piece of
 *   work — a CLI reading a dozen files, running a build, and writing a report —
 *   while still being short enough that a wedged process is noticed and cleared
 *   the same morning rather than found days later.
 *
 * `schedule` — 30 minutes. The same reason as `task`, more so: a 6:30am
 *   check-in has nobody waiting on it AT ALL, and it must not be the one kind of
 *   work that quietly cannot finish. Held level with `task` on purpose — a
 *   standing instruction and a delegated job are the same work with a different
 *   trigger, and giving them different clocks would be a difference nobody could
 *   explain.
 *
 * `repo` — 30 minutes. `!code`. Work inside a checkout is the LONGEST kind this
 *   app does — a worktree, edits across files, a build, a test run — and it was
 *   the worst served by the old 3-minute leash. Same number as the other
 *   delegated kinds, deliberately: three separate long numbers would drift.
 *
 * Why 30 and not 60 or 120: it is the largest number that is still obviously
 * bounded. A person who sees "I stopped after 30 minutes" reads a limit; one who
 * sees "I stopped after 2 hours" reads a hang. If a real job needs more, this
 * table is the one line to change — that is the point of it being a table.
 */
export const TURN_TIME_BUDGET_MS: Readonly<Record<PromptTurnKind, number>> = {
  chat: 3 * 60_000,
  task: 30 * 60_000,
  schedule: 30 * 60_000,
  repo: 30 * 60_000,
};

/**
 * THE CEILING NO ROW MAY PASS. Not a budget — a check on the table above, so a
 * future edit cannot turn a leash into "effectively never" by adding a zero.
 * An hour is well beyond every row and still finite.
 */
export const MAX_TURN_TIME_BUDGET_MS = 60 * 60_000;

/** How long this turn gets. The ONLY way a provider learns its clock. */
export function turnTimeBudgetMs(kind: PromptTurnKind): number {
  const budget = TURN_TIME_BUDGET_MS[kind] ?? TURN_TIME_BUDGET_MS.chat;
  // belt and braces: a bad row is clamped rather than trusted
  return Math.min(budget, MAX_TURN_TIME_BUDGET_MS);
}

/**
 * A length of time as a person would say it: "3 minutes", "45 seconds". No
 * milliseconds, no decimals — this text goes into a chat message.
 */
export function describeBudget(ms: number): string {
  if (ms < 60_000) {
    const secs = Math.max(1, Math.round(ms / 1000));
    return `${secs} second${secs === 1 ? "" : "s"}`;
  }
  const mins = Math.max(1, Math.round(ms / 60_000));
  return `${mins} minute${mins === 1 ? "" : "s"}`;
}

/**
 * THE WORK RAN PAST ITS TIME BUDGET AND WAS STOPPED.
 *
 * It gets to speak for itself where other errors do not, for the same reason
 * `InstructionsNotSavedError` does: its message is built entirely out of things
 * that are already safe to show — a harness name we chose, a number of minutes,
 * and fixed words. No path, no argv, no error code, nothing from the CLI.
 *
 * And it is exactly the failure a person must be TOLD about rather than left to
 * guess at. Before this, a job that blew its leash reached the room as "something
 * went wrong on my side", which is true and useless: the one thing the owner
 * needed to know — that a clock ran out, and which clock — was the one thing
 * `sanitizeForChat` threw away.
 */
export class TurnTimedOutError extends Error {
  constructor(
    public readonly harness: string,
    public readonly kind: PromptTurnKind,
    public readonly budgetMs: number,
  ) {
    super(timedOutSentence(kind, budgetMs));
    this.name = "TurnTimedOutError";
  }
}

/**
 * What the person reads. Two shapes, because the two situations are different:
 * somebody is waiting on a chat reply and can simply ask again, while a
 * delegated job has already had its half hour and needs to come back smaller.
 */
export function timedOutSentence(kind: PromptTurnKind, budgetMs: number): string {
  const took = describeBudget(budgetMs);
  if (kind === "chat") {
    return `this was taking too long for a chat reply — I gave it ${took} and then stopped it. ` +
      `Ask me again, or send it as a background job with !bg so it gets a much longer run.`;
  }
  return `this ran out of time — I gave it ${took} of work and then stopped it, ` +
    `so it is unfinished. Nothing was left running. Try asking for a smaller piece of it.`;
}
