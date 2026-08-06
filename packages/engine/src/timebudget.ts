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
//
// WHAT THIS FILE DOES NOT COVER, said plainly so nobody inherits a false sense
// of completeness. Both clocks live in `run.ts`, so they only exist for turns
// that go through a COMMAND-LINE harness — `ClaudeCliProvider` and
// `CodexProvider`. `SdkProvider` (provider.ts) does not go through `run.ts` and
// therefore runs under NO total clock and NO silence clock at all; its only
// bound is `maxTurns: 6`. That path is not exotic: `host.ts` PREFERS it over the
// CLI whenever a stored key or sign-in token exists, so it can be the one most
// turns actually take. Nothing here regressed it and this change does not touch
// it — but "the two clocks protect every turn" would be untrue, and the next
// person to reason about hangs needs to know where the edge of this file is.
//
// WHAT CHANGED ON 2026-08-07, and it is the more important half of the story:
// the TOTAL clock stopped being a judgement on the work. It had been used as a
// deadline — "as long as I let a reply run" — and a deadline cannot tell working
// from stuck, so it kept killing turns that were fine. It is now a backstop
// against a program that never stops printing, one number for every kind of
// turn. The clock that decides whether a turn is alive is the SILENCE clock, and
// it is unchanged.
import type { PromptTurnKind } from "./provider.js";

/**
 * THE BACKSTOP TABLE. One number, four rows, and the row is the same on purpose.
 *
 * WHAT THIS CLOCK IS FOR, AND IT IS NOT A DEADLINE ON THE WORK. It exists to
 * stop a program that never stops printing from holding this computer for ever.
 * That is the whole job. It is NOT an opinion about how long a good answer is
 * allowed to take, because — and this is the mistake that had to be pulled out
 * by the root — HOW LONG A PIECE OF WORK TAKES IS NOT EVIDENCE OF ANYTHING. A
 * real answer can take twenty minutes on this machine and be right.
 *
 * WHAT WENT WRONG, 2026-08-07, in the owner's hands. He asked for a real piece
 * of work and was told, out loud, by his own app:
 *
 *   "this was still going after 10 minutes, which is as long as I let a reply
 *    run, so I stopped it. It was working the whole time — it just needed
 *    longer than that. Ask me again"
 *
 * The app killed work it could SEE was working and reported it as normal. That
 * sentence was true, which is what makes it damning. The morning's change (3
 * minutes to 10) did not fix it; it moved the guillotine ten minutes down the
 * rope. The idea underneath both numbers was wrong: a total wall clock cannot
 * tell working from stuck, so it must never be the thing that judges the work.
 *
 * WHAT DOES TELL WORKING FROM STUCK: the silence clock below, which already
 * existed and is untouched. `claude -p --output-format stream-json` and
 * `codex exec --json` both print a line for every step they take, and `run.ts`
 * watches those lines arrive. A turn still printing steps is working. A turn
 * that has printed NOTHING for three minutes, with a person sitting in front of
 * it, is the only thing this app has any business calling stuck.
 *
 * WHY ONE NUMBER FOR ALL FOUR KINDS. A runaway is a runaway whoever asked for
 * it; the backstop's job does not change with the trigger. Different rows here
 * only ever encoded "how patient are we with this kind of work", and patience
 * is the silence clock's business, not this one's. Holding them level also kills
 * an absurdity the old table carried: because `!code` promotes a chat message to
 * `repo`, asking for the HARDER job used to change the leash under it. One row
 * cannot drift out of step with another.
 *
 * WHY 45 MINUTES, and note what this reason does NOT claim. An earlier draft of
 * this paragraph argued that no honest piece of work could ever reach 45 minutes,
 * so reaching it would itself prove the program was looping. Review killed that,
 * correctly, and it deserves to stay dead: it is the same mistake as the bug, one
 * layer up. We do not know the longest honest turn. The one turn this change
 * exists for was still working at TEN MINUTES when we cut it off, so all we have
 * is a lower bound and no idea what it would have taken.
 *
 * So 45 is not a claim about work. It is a resource decision, and the only two
 * things it has to be: long enough that it is not the thing deciding whether
 * ordinary work lives — several times any turn ever measured here — and short
 * enough that a wedged CLI is cleared the same morning rather than found days
 * later. It also stays strictly under the ceiling below, so the clamp there
 * remains a real guard against a future edit rather than decoration.
 *
 * Because the number no longer carries an argument about the work, the sentence
 * the owner reads when it fires does not either — see `timedOutSentence`.
 *
 * WHAT THIS CLOCK IS NOT: a spending limit. Money is spent in tokens, not in
 * minutes — a turn stuck in a tool loop burns more in ten minutes than a careful
 * turn does in forty — so a clock is a dishonest proxy for cost and always was.
 * The real guard is the agent's own spending ceiling (`spendCapOf` /
 * `decideSpend` in @cloud9/shared), which is handed to the CLI as its own limit
 * and stops the turn on the dollar. It is OFF unless the owner sets one; that is
 * a gap in the MONEY guard and must be closed there, in money, not papered over
 * here with a shorter clock. And for a chat turn a person is sitting in front of
 * the Stop button the whole time.
 */
export const TURN_TIME_BUDGET_MS: Readonly<Record<PromptTurnKind, number>> = {
  chat: 45 * 60_000,
  task: 45 * 60_000,
  schedule: 45 * 60_000,
  repo: 45 * 60_000,
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
 *   wedged harness is admitted to within a few minutes.
 *
 *   THIS ROW IS NOW THE ONLY CLOCK THAT JUDGES A CHAT TURN in practice, and that
 *   is deliberate (2026-08-07). The total above is a backstop no honest turn can
 *   reach; this is the number that decides, within three minutes, whether the
 *   thing in front of him is alive. It is the right one to decide it, because it
 *   is the only one of the two that is looking at the program rather than at the
 *   calendar.
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
 * What the person reads. TWO SHAPES, and they are the two clocks — not, as
 * before, one shape for a chat reply and one for a job.
 *
 * THE RULE THIS SENTENCE LIVES UNDER: SAY WHAT HAPPENED, NOT WHAT IT MEANT.
 * The app can see two things and only two — the clock ran out, and which clock.
 * It cannot see whether the work was nearly done, going round in circles, or
 * fine. Every sentence that has ever been wrong here was wrong because it
 * narrated the work instead of the event:
 *
 *   · "this was taking too long for a chat reply" — blamed the work for its
 *     length, when it was usually working.
 *   · "It was working the whole time — it just needed longer than that" — the
 *     one the owner was handed on 2026-08-07. True, and an admission that the
 *     app destroyed something it could see was fine.
 *   · "it was going round in circles rather than nearly done" — MY OWN first
 *     replacement, rejected in review on the same grounds. It swapped one
 *     invented verdict for the opposite invented verdict. It also contradicted
 *     the very argument this file is built on: if how long work takes is not
 *     evidence of anything, then 45 minutes is not evidence of a loop either.
 *
 * So it now reports the clock and stops. The only comparison left is one the app
 * genuinely knows — how long its own leash is — and that stays true whatever the
 * budget is set to, including the short pinned leashes tests use. A sentence that
 * only reads correctly at one number is a sentence waiting to become a lie.
 *
 * WHY `kind` NO LONGER CHANGES IT: the same event happened whoever asked, and
 * the totals are now one number. The old delegated wording ("try a smaller
 * piece") was the factual half worth keeping, so it is what both now say.
 */
export function timedOutSentence(
  _kind: PromptTurnKind, budgetMs: number, wentQuiet = false,
): string {
  const took = describeBudget(budgetMs);
  // IT FROZE. Said as its own thing, because it is not the same event as the
  // backstop firing and the owner's next move is different: there is nothing to
  // make smaller, and asking again is the right answer even for a big job.
  if (wentQuiet) {
    return `this stopped moving — nothing new came back from it for ${took}, so I ` +
      `treated it as stuck and shut it down. Nothing was left running. It had not ` +
      `finished, so ask me again.`;
  }
  // THE BACKSTOP. Two facts and no verdict: it was still going, and it hit the
  // longest leash there is. What that means about the work is not ours to say.
  return `this kept going for ${took} without finishing, so I stopped it — that is the ` +
    `longest I let anything run. Nothing was left running. Ask me again, and if it does ` +
    `the same, ask for a smaller piece of it.`;
}
