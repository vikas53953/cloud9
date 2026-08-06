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
 * `chat` — 10 minutes, RAISED FROM 3 ON 2026-08-05, and this is the paragraph
 *   that explains why the old number was wrong rather than merely small.
 *
 *   MEASURED ON THE INSTALLED APP. Chat turns that really pick up a tool —
 *   running a command, reading files, then writing the answer — took **70 to 205
 *   seconds** on this machine. One of them, a plain `git rev-parse`, was KILLED
 *   at 180 seconds and the owner was told "this was taking too long for a chat
 *   reply". It was not taking too long. It was working, on a slow computer, and
 *   the app stopped it and blamed it.
 *
 *   The old 3 minutes was set when a chat turn meant "write a sentence". Since
 *   2026-07-30 a chat turn can run programs, read the disk and search the web —
 *   the ceiling was raised for what an agent may DO and nobody raised the clock
 *   it does it under. 10 minutes is roughly three times the longest turn we have
 *   actually watched finish, so an ordinary slow day cannot reach it, and it is
 *   still a number a person reads as a limit rather than as a hang.
 *
 *   WHY THIS IS NOT SIMPLY "BE MORE PATIENT". A ten-minute total on its own
 *   would mean somebody sitting in front of a wedged CLI for ten minutes. That
 *   is why the quiet table below exists and why the two were changed together:
 *   the TOTAL says how long real work may take, and the QUIET says how long
 *   NOTHING may happen. A turn is only allowed the big number while it is
 *   visibly still going.
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
  chat: 10 * 60_000,
  task: 30 * 60_000,
  schedule: 30 * 60_000,
  repo: 30 * 60_000,
};

/**
 * THE SECOND CLOCK: HOW LONG A TURN MAY SAY NOTHING AT ALL.
 *
 * WHAT IT MEASURES, and it is not the same thing as the table above: SILENCE.
 * `claude -p --output-format stream-json` prints a line for every step it takes
 * — the tool it is about to use, the result that came back, each block of the
 * answer. `run.ts` already watches those lines arrive (`onStdoutLine`, added for
 * the live-steps view), so "is this thing still going?" stopped being a guess
 * and became something the app can see. A turn that is still printing steps is
 * WORKING. A turn that has printed nothing for a long time is the only kind that
 * deserves to be called stuck.
 *
 * WHY BOTH CLOCKS AND NOT ONE. Each catches what the other cannot:
 *   · silence alone would never stop a CLI stuck in a loop — it prints happily
 *     for ever, so only the total ceiling ends that;
 *   · a total alone leaves a person watching a dead process for the whole
 *     budget, which is exactly what makes a long total feel like a hang.
 * Neither is "unlimited", and a turn is stopped by whichever fires first.
 *
 * `chat` — 3 minutes of silence. A PERSON IS SITTING THERE, so the wait for
 *   nothing-at-all must stay short. It is generous enough to survive one long
 *   command inside a chat reply (a build, an install) and short enough that a
 *   wedged harness is admitted to within a few minutes rather than ten.
 *
 * `task` / `schedule` / `repo` — 10 minutes of silence. Nobody is waiting, and
 *   a single quiet step is genuinely longer here: a dependency install or a full
 *   test run prints nothing for minutes and is not stuck. Held level across the
 *   three delegated kinds for the same reason their totals are level — three
 *   separate long numbers would drift.
 *
 * WHEN A RUNNER CANNOT SEE THE OUTPUT. Nothing breaks: the quiet clock is an
 * option `run.ts` only arms when it is given, and a turn with no quiet budget
 * behaves exactly as it always did — the total ceiling and nothing else.
 */
export const TURN_QUIET_BUDGET_MS: Readonly<Record<PromptTurnKind, number>> = {
  chat: 3 * 60_000,
  task: 10 * 60_000,
  schedule: 10 * 60_000,
  repo: 10 * 60_000,
};

/**
 * THE CEILING NO ROW MAY PASS. Not a budget — a check on the table above, so a
 * future edit cannot turn a leash into "effectively never" by adding a zero.
 * An hour is well beyond every row and still finite.
 */
export const MAX_TURN_TIME_BUDGET_MS = 60 * 60_000;

/**
 * THE SAME GUARD FOR THE SILENCE CLOCK. A quiet budget that grew past this
 * would quietly turn the two-clock design back into a one-clock design, because
 * a silence leash longer than the work itself can never fire.
 */
export const MAX_TURN_QUIET_BUDGET_MS = 15 * 60_000;

/** How long this turn gets in total. The ONLY way a provider learns its clock. */
export function turnTimeBudgetMs(kind: PromptTurnKind): number {
  const budget = TURN_TIME_BUDGET_MS[kind] ?? TURN_TIME_BUDGET_MS.chat;
  // belt and braces: a bad row is clamped rather than trusted
  return Math.min(budget, MAX_TURN_TIME_BUDGET_MS);
}

/** How long this turn may print nothing before it is called stuck. */
export function turnQuietBudgetMs(kind: PromptTurnKind): number {
  const budget = TURN_QUIET_BUDGET_MS[kind] ?? TURN_QUIET_BUDGET_MS.chat;
  const clamped = Math.min(budget, MAX_TURN_QUIET_BUDGET_MS);
  // A silence leash is never allowed to be the LONGER of the two: if it were,
  // it could not fire before the total, and the second clock would be decoration.
  return Math.min(clamped, turnTimeBudgetMs(kind));
}

/** Both clocks for this turn, in the shape `run.ts` takes them. One call site. */
export function turnLeash(kind: PromptTurnKind): { timeoutMs: number; quietMs: number } {
  return { timeoutMs: turnTimeBudgetMs(kind), quietMs: turnQuietBudgetMs(kind) };
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
    /**
     * TRUE when what ran out was the SILENCE clock, not the total one — the turn
     * printed nothing for `budgetMs` and was called stuck.
     *
     * It is a separate fact because it is a separate thing to tell somebody. "It
     * used up its half hour" and "it froze" ask for different next moves, and an
     * app that says the first when it means the second sends the owner off to
     * split up a job that was never too big.
     */
    public readonly wentQuiet: boolean = false,
  ) {
    super(timedOutSentence(kind, budgetMs, wentQuiet));
    this.name = "TurnTimedOutError";
  }
}

/**
 * What the person reads. Two shapes, because the two situations are different:
 * somebody is waiting on a chat reply and can simply ask again, while a
 * delegated job has already had its half hour and needs to come back smaller.
 */
export function timedOutSentence(
  kind: PromptTurnKind, budgetMs: number, wentQuiet = false,
): string {
  const took = describeBudget(budgetMs);
  // IT FROZE. Said as its own thing, because it is not the same event as running
  // out of time and the owner's next move is different: there is nothing to make
  // smaller, and asking again is the right answer even for a big job.
  if (wentQuiet) {
    return `this stopped moving — nothing new came back from it for ${took}, so I ` +
      `treated it as stuck and shut it down. Nothing was left running. It had not ` +
      `finished, so ask me again.`;
  }
  if (kind === "chat") {
    return `this was still going after ${took}, which is as long as I let a reply run, ` +
      `so I stopped it. It was working the whole time — it just needed longer than that. ` +
      `Ask me again, or send it as a background job with !bg so it gets a much longer run.`;
  }
  return `this ran out of time — I gave it ${took} of work and then stopped it, ` +
    `so it is unfinished. Nothing was left running. Try asking for a smaller piece of it.`;
}
