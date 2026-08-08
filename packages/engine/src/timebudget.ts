// THERE IS NO TIME LIMIT ON A TURN. REMOVED 2026-08-07. DO NOT REBUILD IT.
//
// This file used to hold the clocks: a TOTAL budget (45 minutes at the end,
// 30/10/3 before that) and a SILENCE budget (3 minutes for a chat reply, 10 for
// delegated work), plus the error and the sentence a person read when one of
// them fired. All of it is gone. The file is kept as a headstone, because the
// arguments that built it were long and careful and wrong, and the next person
// to arrive deserves to find out here rather than reinvent them.
//
// WHY IT WENT, in the owner's words:
//
//   "just remove the timing… when i do use the claude code or codex there is
//    nothing like that. my agent keeps on working and you can see it. you keep
//    on working over the whole night and now i am coming back in the morning.
//    there is nothing like a timing… what is the meaning of agents? agents are
//    employees so i don't want to implement a timing foundation."
//
// That is the whole case and it is stronger than anything that was written here.
// The tools Cloud9 is a front end for — `claude` and `codex` — put no deadline
// on a turn. They run until they finish, until they fail, or until the person
// stops them. Cloud9 invented a deadline they do not have, and then spent three
// rounds tuning it:
//
//   · 3 minutes, and real turns that were WORKING were killed at 180 seconds.
//   · 10 minutes, and the owner was told "it was working the whole time — it
//     just needed longer than that", which is a confession, not a report.
//   · 45 minutes plus a silence clock, argued as "the silence clock is the
//     honest judge, because it can see whether the program is still producing
//     output". That was the best version of the idea and it still had a hole:
//     it could not tell THE AGENT going quiet from THE PERSON going quiet, so an
//     agent that asked its owner a question and waited for him was killed after
//     three minutes and told it had "stopped moving".
//
// Every round moved the number and kept the mistake. The mistake was the number.
//
// WHAT ENDS A TURN NOW, and it is a short list on purpose:
//   · it finishes;
//   · it fails, and the failure says what it was;
//   · THE OWNER PRESSES STOP — `run.ts` (`StopScope`, `killTree`) and
//     `Engine.stopAgent`, which kills the whole process tree, releases any card
//     the agent was standing at, drops work still queued behind it, and writes
//     the run down as "you stopped this" rather than as finished or failed.
//
// Stop is therefore the ONLY early ending, and it is the one that has a person
// behind it. That is the whole design: a decision, never a clock.
//
// WHERE THAT SENTENCE IS NOT YET TRUE, said plainly so nobody inherits a false
// sense of completeness — this is the same warning the old version of this file
// carried about its own clocks, and it is still owed:
//
//   · The stored-key `SdkProvider` receives the owner's Stop through an abort
//     signal, so its SDK query is cancelled together with command-line children.
//     The provider stops promptly. `host.ts` uses that route whenever a
//     stored key or sign-in token exists, so it can be the one most turns take.
//     Removing the clocks leaves the same no-clock
//     ending law for every provider, with Stop as the sole deliberate early end.
//
//   · MONEY IS THE OTHER CEILING, and for one harness there is now none at all.
//     A turn is bounded by the agent's spending limit (`spendCapOf` /
//     `decideSpend` in @cloud9/shared), handed to the CLI as its own limit — but
//     that limit is OFF unless the owner sets one, and `providerCanBeCapped`
//     answers true only for Claude, because only Claude reports what a turn
//     cost. So a CODEX agent cannot be given a money ceiling at all, and the
//     clock was the only bound it had. That is a real consequence of this
//     change and the owner has to be told it rather than discover it. The answer
//     is a money guard for Codex, not a clock brought back through the side
//     door: a clock was always a dishonest proxy for cost, because a turn stuck
//     in a tool loop burns more in ten minutes than a careful turn does in
//     forty.
//
// WHAT WENT WITH IT: `TURN_TIME_BUDGET_MS`, `TURN_QUIET_BUDGET_MS`, their
// ceilings and clamps, `turnLeash`, `TurnTimedOutError`, `timedOutSentence`,
// `describeBudget`, the `quietMs` option in `run.ts`, and the `wentQuiet` fact
// in its result. The sentences that told the owner a clock had run out went too,
// rather than being reworded — with no clock there is nothing to report, and the
// rule those sentences were written under still stands: THE APP MAY SAY ONLY
// WHAT IT CAN SEE.
//
// IF YOU ARE HERE BECAUSE SOMETHING HUNG. The answer is not a clock. Look at
// what is actually holding it: the harness itself, the thing it is waiting on,
// or a missing Stop path. A deadline does not fix a hang; it hides it, and it
// takes honest long-running work down with it every time.
export {};
