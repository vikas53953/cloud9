// WHAT EACH AGENT IS COSTING, WHERE IT GOES, AND WHICH PART OF IT IS WASTE.
//
// THE WALL THIS CLOSES. Cloud9 already wrote down what every turn cost — the
// Claude app's own `total_cost_usd`, on `RunRecord.usage`, never estimated. It
// was written down and then never read by anybody except the spending ceiling.
// There was no screen that answered "which of my agents is the expensive one",
// there was no way for an agent to find out, and — the part that actually costs
// him money — nothing anywhere NAMED the waste. A number on its own is not
// useful to somebody who is not going to go and read the code: "$41.20" tells
// him nothing he can act on. "This agent re-sends your whole Claude Code setup
// on every single turn, it has never once used it, and that is 90% of its bill"
// is a sentence he can do something about in one click.
//
// So this file does three separate jobs and keeps them separate:
//
//   1. ADD UP what really happened      — `rollUpTokenUse`. Arithmetic only.
//   2. NAME the waste in plain words    — `findWaste`. Judgement, and it shows
//                                          its working on every finding.
//   3. SAY what would fix it            — `SavingChange`, a CLOSED list of two
//                                          changes, both of which can only ever
//                                          make an agent cost LESS or do LESS.
//
// THE HONESTY RULE TRAVELS FROM `RunRecord` UNCHANGED, and it is the reason
// most of the awkward-looking fields below exist:
//
//   • NOTHING IS ESTIMATED. A run whose app reported no cost contributes
//     nothing — never a zero standing in for a figure, never an average. So
//     every total here comes with a COUNT of how many runs actually carried the
//     figure it was summed from, and a screen that draws the total without the
//     count is lying by omission.
//   • CODEX REPORTS NO MONEY AT ALL. Not "reports zero" — reports nothing.
//     `providerCanBeCapped` in index.ts is the one owner of that fact, and this
//     file asks IT rather than having its own opinion. A Codex agent's row says
//     "Codex doesn't report what it costs" out loud and shows no money; it must
//     never show $0.00, because $0.00 reads as "this one is free" and he would
//     make exactly the wrong decision from it.
//   • ABSENT IS ABSENT. `undefined` on a total means "no run told us", which is
//     a different thing from 0 and is drawn differently.
//
// PLAIN WORDS ARE A REQUIREMENT, NOT A POLISH. The owner is a network engineer.
// "Token", "context window" and "prompt cache" are not words that appear on his
// screen, so they do not appear in any string this file produces. What is on
// the screen is: what he is sent, what it wrote back, what it cost him, and
// what stops if he does nothing.
import {
  AgentDef, AgentSpendCap, ID, RunRecord,
  humanMoney, providerCanBeCapped, spendCapOf, spendMonthKey, tidyPlan,
} from "./index.js";

// ---------------------------------------------------------------------------
// 0. HOW MUCH WAS HANDED TO IT — the one figure that means the same thing
//    whichever app ran the turn.
// ---------------------------------------------------------------------------

/**
 * WHAT WENT UP THE WIRE TO THE AGENT THIS TURN, and how sure we are of it.
 *
 * THE BUG THIS EXISTS TO KILL. The first version of this file summed
 * `usage.inputTokens`. For Claude that field is the UN-CACHED REMAINDER — two
 * to four tokens on a normal turn — while the actual material arrives as
 * `cache_read_input_tokens` and `cache_creation_input_tokens`. Run against the
 * owner's own 185 stored runs, his dearest agent drew as "0% handed to it, 100%
 * written back" while having really been handed 1,120,105 tokens. The finding
 * whose entire job is to name that waste could not fire on a single Claude
 * agent, and one card contradicted itself on screen: "loads your whole Claude
 * Code setup on every turn" printed directly above "less than a page handed to
 * it per turn". Fifty-nine green tests missed it because every fixture in them
 * was hand-written, and no hand-written fixture had a cache in it.
 *
 * TWO WAYS THIS CAN ANSWER, and they are told apart on purpose:
 *
 *  • `reported` — the provider's own mapper wrote `handedToIt` down at the time
 *    (`claude-cli.ts`, `codex.ts`). Nothing was worked out here.
 *  • `rebuilt` — an older record, from before that field existed. The figure is
 *    rebuilt from that provider's documented, live-verified convention.
 *
 * REBUILDING IS NOT ESTIMATING, and the difference matters enough to spell out.
 * Nothing is averaged, inferred or priced. It is the same arithmetic the mapper
 * itself now does, applied after the fact to figures the CLI really reported —
 * exactly what `claudeUsage` does when it adds three numbers the CLI printed.
 * The alternative was to show nothing at all for the owner's entire history,
 * which would have made this feature useless on the day it shipped.
 *
 * AND WHEN IT CANNOT BE DONE, IT IS NOT DONE. A record with no usable figures
 * comes back `undefined`, and every total built from it says how many runs it
 * was actually able to count.
 */
export type HandedToIt =
  | { tokens: number; how: "reported" | "rebuilt" }
  | undefined;

export function handedToItOf(
  usage: RunRecord["usage"], provider: string | undefined,
): HandedToIt {
  if (!usage) return undefined;
  const said = plainNumber(usage.handedToIt);
  if (said !== undefined) return { tokens: said, how: "reported" };

  const input = plainNumber(usage.inputTokens);
  const cached = plainNumber(usage.cachedInputTokens);
  const written = plainNumber(usage.cacheWriteTokens);

  // CODEX COUNTS THE WAY OPENAI DOES: `input_tokens` is the TOTAL and
  // `cached_input_tokens` is the part of it that came from the cache. Adding
  // them would count the cache twice — the mirror image of the Claude bug.
  if ((provider ?? "claude") === "codex") {
    return input === undefined ? undefined : { tokens: input, how: "rebuilt" };
  }
  // CLAUDE COUNTS IN THREE SEPARATE PILES and `input_tokens` is only the
  // smallest of them. All three, added, is what was handed over. See the
  // warning on `RunUsage` in index.ts for the live-verified shapes.
  const parts = [input, cached, written].filter((n): n is number => n !== undefined);
  return parts.length === 0
    ? undefined
    : { tokens: parts.reduce((a, b) => a + b, 0), how: "rebuilt" };
}

/** A figure a CLI really reported. Nonsense is not zero — it is nothing. */
function plainNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

// ---------------------------------------------------------------------------
// 1. THE ARITHMETIC
// ---------------------------------------------------------------------------

/**
 * Just enough of a run to add it up. Taking a narrow slice rather than a whole
 * `RunRecord` is deliberate: it is what lets the relay, the engine and a test
 * hand this the same thing, and it means nothing in here can accidentally start
 * depending on a step, a reply or an error message.
 */
export interface CountableRun {
  startedAt: number;
  provider: string;
  outcome: RunRecord["outcome"];
  ownerSetup?: boolean;
  usage?: RunRecord["usage"];
}

/**
 * WHAT ONE AGENT HAS COST, and how much of the answer we are actually entitled
 * to give.
 *
 * Every "how many runs said so" count beside a total is load-bearing. `costUsd`
 * of $12 over 40 runs means something quite different depending on whether 40
 * runs reported a figure or 3 did, and a screen cannot tell those apart from
 * the total alone — so it is not allowed to have only the total.
 */
export interface AgentTokenUse {
  agentId: ID;
  agentName: string;
  provider: string;
  /**
   * FALSE when the app behind this agent does not report money at all. Read off
   * `providerCanBeCapped`, never decided here — the same fact that greys out the
   * spending-limit boxes greys out the money on this row, so the two can never
   * disagree about the same agent.
   */
  reportsCost: boolean;

  /** every run counted, whatever it did or did not report */
  runs: number;
  /** of those, how many carried a cost figure. `costUsd` is the sum of THESE. */
  runsWithCost: number;
  /** the money, summed from real reported figures only. Absent if none reported. */
  costUsd?: number;

  /** of those, how many carried size figures. The sizes are sums of THESE. */
  runsWithSize: number;
  /**
   * WHAT WAS HANDED TO IT — the standing instructions, the room, the skills,
   * the lot. Summed through `handedToItOf`, never off `inputTokens`; see the
   * note there for the inversion that caused.
   */
  sentToIt?: number;
  /** what it wrote back */
  wroteBack?: number;
  /**
   * Of the runs counted in `sentToIt`, how many had to have their figure
   * REBUILT from an older record rather than read off one the provider wrote
   * down. A screen may say so; it must never pretend the difference away.
   */
  runsWithRebuiltSize: number;
  /** how much of what was handed over was material the app already had */
  reusedFromLastTime?: number;
  /** thinking the app charged for and reported separately */
  thinking?: number;

  /** how many of these runs ran with the owner's own setup loaded */
  runsInOwnerSetup: number;
  /** what those cost, when they reported a figure */
  costInOwnerSetupUsd?: number;
  /** how many of those reported one */
  runsInOwnerSetupWithCost: number;
  /** and the same two for the runs that did NOT load his setup */
  costOutsideOwnerSetupUsd?: number;
  runsOutsideOwnerSetupWithCost: number;

  /** first and last run counted, so a screen can say over what period */
  firstAt?: number;
  lastAt?: number;
}

/** The window a roll-up covers. A screen must always say which. */
export type UsePeriod = "thisMonth" | "everythingKept";

export interface RollUpInput {
  agentId: ID;
  agentName: string;
  provider: string;
  runs: readonly CountableRun[];
  /** limit the sum to the calendar month containing this moment */
  period?: UsePeriod;
  now?: number;
}

/**
 * Add up one agent's runs. Pure arithmetic — it makes no judgement and writes
 * no sentence. Everything a person reads is built from this, never instead of
 * it, so there is exactly one place the numbers come from.
 */
export function rollUpTokenUse(input: RollUpInput): AgentTokenUse {
  const period = input.period ?? "thisMonth";
  const month = spendMonthKey(input.now ?? Date.now());
  const out: AgentTokenUse = {
    agentId: input.agentId,
    agentName: input.agentName,
    provider: input.provider,
    reportsCost: providerCanBeCapped(input.provider),
    runs: 0,
    runsWithCost: 0,
    runsWithSize: 0,
    runsWithRebuiltSize: 0,
    runsInOwnerSetup: 0,
    runsInOwnerSetupWithCost: 0,
    runsOutsideOwnerSetupWithCost: 0,
  };
  // Sums are kept beside a "did anything ever land here" flag rather than
  // starting at 0 and being handed out as 0. A total of zero and no total at all
  // are different answers and the second one is not allowed to look like the
  // first — see the honesty note at the top.
  let cost = 0, sent = 0, wrote = 0, reused = 0, thought = 0;
  let costIn = 0, costOut = 0;
  let anySize = false, anyReused = false, anyThought = false;

  for (const run of input.runs) {
    if (period === "thisMonth" && spendMonthKey(run.startedAt) !== month) continue;
    out.runs++;
    if (out.firstAt === undefined || run.startedAt < out.firstAt) out.firstAt = run.startedAt;
    if (out.lastAt === undefined || run.startedAt > out.lastAt) out.lastAt = run.startedAt;
    const inOwnerSetup = run.ownerSetup === true;
    if (inOwnerSetup) out.runsInOwnerSetup++;

    const money = usable(run.usage?.costUsd);
    if (money !== undefined) {
      out.runsWithCost++;
      cost += money;
      if (inOwnerSetup) { out.runsInOwnerSetupWithCost++; costIn += money; }
      else { out.runsOutsideOwnerSetupWithCost++; costOut += money; }
    }

    // NEVER `usage.inputTokens`. The two apps mean opposite things by it, and
    // reading it directly is the bug this whole file was rebuilt around — see
    // `handedToItOf`. The provider is taken from the RUN, so a record made
    // while the agent was on Codex is read in Codex's accounting even if the
    // agent is on Claude today.
    const handed = handedToItOf(run.usage, run.provider);
    const outTok = usable(run.usage?.outputTokens);
    if (handed !== undefined || outTok !== undefined) {
      out.runsWithSize++;
      anySize = true;
      sent += handed?.tokens ?? 0;
      wrote += outTok ?? 0;
      if (handed?.how === "rebuilt") out.runsWithRebuiltSize++;
    }
    const cached = usable(run.usage?.cachedInputTokens);
    if (cached !== undefined) { anyReused = true; reused += cached; }
    const think = usable(run.usage?.reasoningTokens);
    if (think !== undefined) { anyThought = true; thought += think; }
  }

  if (out.runsWithCost > 0) out.costUsd = round(cost);
  if (out.runsInOwnerSetupWithCost > 0) out.costInOwnerSetupUsd = round(costIn);
  if (out.runsOutsideOwnerSetupWithCost > 0) out.costOutsideOwnerSetupUsd = round(costOut);
  if (anySize) { out.sentToIt = sent; out.wroteBack = wrote; }
  if (anyReused) out.reusedFromLastTime = reused;
  if (anyThought) out.thinking = thought;
  return out;
}

/**
 * A figure a CLI actually reported, or `undefined`.
 *
 * A negative or non-finite number is NOT reported-as-zero, it is nonsense, and
 * nonsense is dropped rather than folded into a total — the same treatment
 * `spendCapOf` gives a garbled ceiling and for the same reason: a total nobody
 * can trust is worse than a total that admits it is short.
 */
function usable(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
}

/** Everybody, dearest first — with the ones that report nothing last, never as $0. */
export function dearestFirst(rows: readonly AgentTokenUse[]): AgentTokenUse[] {
  return [...rows].sort((a, b) => {
    const am = a.costUsd, bm = b.costUsd;
    if (am === undefined && bm === undefined) return b.runs - a.runs;
    if (am === undefined) return 1;   // "we don't know" never outranks a real figure
    if (bm === undefined) return -1;
    return bm - am;
  });
}

// ---------------------------------------------------------------------------
// PLAIN WORDS FOR A SIZE
// ---------------------------------------------------------------------------

/**
 * HOW A SIZE IS SAID ON HIS SCREEN.
 *
 * The apps count in "tokens". He is a network engineer and that word means
 * nothing to him, so it is never printed — but a raw count with no scale is
 * just as useless ("31,000 what?"). So a size is said as pages, with the exact
 * count kept beside it for anyone who wants it, and the conversion is marked
 * "about" because it IS about: it is the same 2.5-characters-a-token figure
 * `conversationBudgetFor` already budgets with, at roughly 1,800 characters to
 * a printed page.
 *
 * This is a PRESENTATION rule, not an estimate of anything. The number it is
 * derived from is exact and reported; only the unit is approximate, and it says
 * so on the screen.
 */
export const TEXT_SIZE_RULE = {
  charactersPerToken: 2.5,
  charactersPerPage: 1_800,
} as const;

export function pagesOf(tokens: number): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return (tokens * TEXT_SIZE_RULE.charactersPerToken) / TEXT_SIZE_RULE.charactersPerPage;
}

/** "about 42 pages" — or "less than a page", which is the honest small answer. */
export function humanTextSize(tokens: number): string {
  const pages = pagesOf(tokens);
  if (pages <= 0) return "nothing";
  if (pages < 1) return "less than a page";
  if (pages < 10) return `about ${pages.toFixed(1)} pages`;
  return `about ${Math.round(pages).toLocaleString("en-US")} pages`;
}

/**
 * "$12.40 across 38 turns", or the honest refusal when the app behind this agent
 * does not report money. NEVER "$0.00" for an agent nobody costed.
 */
export function moneyWords(use: AgentTokenUse): string {
  if (!use.reportsCost) return "Codex doesn't report what a turn costs, so Cloud9 cannot say";
  if (use.costUsd === undefined) {
    return use.runs === 0 ? "nothing recorded yet" : "no turn reported a cost";
  }
  const of = use.runsWithCost === use.runs
    ? `${use.runs} turn${use.runs === 1 ? "" : "s"}`
    : `${use.runsWithCost} of ${use.runs} turns (the rest reported nothing)`;
  return `${humanMoney(use.costUsd)} across ${of}`;
}

/**
 * HOW THE MONEY SPLITS BETWEEN "WHAT IT WAS SENT" AND "WHAT IT WROTE".
 *
 * The single most useful thing on the screen, because the two halves have
 * completely different cures. A bill that is mostly what it WROTE means the
 * agent is doing a lot of work — that is money buying something. A bill that is
 * mostly what it was SENT means he is paying, over and over, to hand the same
 * standing material to an agent that may never look at it. Only the second one
 * is waste, and until now nothing told the two apart.
 *
 * Returns undefined when no run reported sizes — there is no honest split to
 * draw, so nothing is drawn.
 */
export function sentVsWrote(use: AgentTokenUse): { sentShare: number; wroteShare: number } | undefined {
  if (use.sentToIt === undefined || use.wroteBack === undefined) return undefined;
  const total = use.sentToIt + use.wroteBack;
  if (total <= 0) return undefined;
  return { sentShare: use.sentToIt / total, wroteShare: use.wroteBack / total };
}

// ---------------------------------------------------------------------------
// 3. WHAT WOULD FIX IT — a CLOSED list, and every entry can only narrow
// ---------------------------------------------------------------------------

/**
 * THE ONLY TWO CHANGES AN AGENT MAY EVER PROPOSE.
 *
 * A CLOSED UNION, ON PURPOSE, AND IT IS THE WHOLE SAFETY ARGUMENT. The owner
 * asked for agents that "optimize other agents automatically". Read literally
 * that is one agent editing another agent's settings, which fights everything
 * else this app is built on — approval cards, `ALWAYS_ASK_ABILITIES`, trust
 * levels, "nothing changes behind your back". So the power is split in two:
 *
 *   • an agent may SEE and may PROPOSE (this type, and `propose_saving`)
 *   • only the OWNER may change anything, and the change happens in the same
 *     step as his decision — the hub applies it when HIS `decideApproval`
 *     arrives, so a card that says "approved" and a setting that never moved
 *     cannot exist. No agent, and no engine, can reach that line.
 *
 * And because the proposal is a closed list of two rather than an arbitrary
 * patch, there is a second guarantee on top of the first: even if a card were
 * approved by accident, or by a confused agent's persuasion, the WORST it can
 * do is make an agent cost less and do less. `narrowingOnly` below is that
 * claim written as code, and `tokenuse.test.ts` is that claim proved.
 *
 * Neither change can grant an ability, reach a file, touch a credential, alter
 * a trust level, or make anything cost MORE.
 */
export type SavingChange =
  | {
    /** stop loading the owner's own Claude Code / Codex setup on every turn */
    what: "stopUsingOwnerSetup";
  }
  | {
    /** put a ceiling on what this agent may spend in a calendar month */
    what: "setMonthlyLimit";
    perMonthUsd: number;
  };

/** What an agent is proposing, about which agent, and on what evidence. */
export interface SavingProposal {
  /** the agent the change is ABOUT — not the agent proposing it */
  about: ID;
  aboutName: string;
  change: SavingChange;
  /**
   * The evidence, in the proposing agent's own words. Contained rather than
   * trusted, exactly like `Approval.plan`: bounded and stripped by `tidySaving`
   * before it is stored, and drawn as plain text, never as anything a screen
   * would interpret.
   */
  because: string;
}

export const SAVING_LIMITS = {
  /** the longest reason a card will carry */
  because: 600,
} as const;

/**
 * IS THIS CHANGE ONE THAT CAN ONLY EVER NARROW?
 *
 * Written as a function rather than left as an argument in a comment so that a
 * third member of `SavingChange` cannot be added without somebody deciding, in
 * code, whether it belongs. A shape this does not recognise is refused — the
 * fail-closed direction, because the thing being protected is his money and his
 * agents' settings.
 */
export function narrowingOnly(change: unknown): change is SavingChange {
  if (!change || typeof change !== "object" || Array.isArray(change)) return false;
  const c = change as Partial<SavingChange> & Record<string, unknown>;
  if (c.what === "stopUsingOwnerSetup") {
    // it takes nothing away except the loading of his own setup, and it carries
    // no other fields — an extra field is a change nobody reviewed
    return Object.keys(c).length === 1;
  }
  if (c.what === "setMonthlyLimit") {
    if (Object.keys(c).length !== 2) return false;
    const v = (c as { perMonthUsd?: unknown }).perMonthUsd;
    return typeof v === "number" && Number.isFinite(v) && v > 0;
  }
  return false;
}

/**
 * Clean and bound the agent's own words before they are stored or drawn.
 *
 * IT BORROWS `tidyPlan`'S STRIPPING RATHER THAN REPEATING IT. The dangerous
 * part of this job — control characters, zero-width marks, line separators — is
 * already solved once in shared for the plan card, and a second hand-written
 * character class here would be a second one to get subtly wrong. The only
 * thing this adds is that a reason is ONE paragraph (a card has one line under
 * the headline, not a document) and a shorter ceiling.
 */
export function tidySaving(text: unknown): string {
  const flat = tidyPlan(text).replace(/\s+/g, " ").trim();
  return flat.length > SAVING_LIMITS.because
    ? `${flat.slice(0, SAVING_LIMITS.because - 1)}…`
    : flat;
}

/**
 * Is this a proposal the hub may store and the owner may be shown? Plain words,
 * or null when it is fine. The same shape of answer `validateSpendCap` gives.
 */
export function validateSavingProposal(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "a saving suggestion has to say which agent it is about and what to change";
  }
  const p = value as Partial<SavingProposal>;
  if (typeof p.about !== "string" || !p.about.trim()) return "it doesn't say which agent it is about";
  if (typeof p.aboutName !== "string" || !p.aboutName.trim()) return "it doesn't name the agent";
  if (!narrowingOnly(p.change)) return "that isn't a change Cloud9 knows how to make";
  if (typeof p.because !== "string" || !tidySaving(p.because)) {
    return "it doesn't say why, and a change with no reason is not something to approve";
  }
  return null;
}

/**
 * THE HEADLINE ON THE CARD — what he is being asked, in his words, with the
 * agent named. No flag names, no setting names, no jargon.
 */
export function savingHeadline(p: SavingProposal): string {
  switch (p.change.what) {
    case "stopUsingOwnerSetup":
      return `Stop ${p.aboutName} loading your own Claude Code setup on every turn?`;
    case "setMonthlyLimit":
      return `Put a ${humanMoney(p.change.perMonthUsd)} a month spending limit on ${p.aboutName}?`;
  }
}

/**
 * The smaller line under the headline: what actually changes, and how to undo it.
 *
 * IT HAS TO FIT ON THE CARD, and that is not a style note — it is the thing a
 * test caught. The hub trims this to `APPROVAL_LIMITS.detail` on the way in,
 * and the first draft ran past it, so the sentence that got cut off was
 * "you can switch it back on any time". The one sentence that makes a change
 * safe to accept was the one the cap ate. So the undo now comes EARLY, and
 * `tokenuse.test.ts` fails if either of these ever grows past the cap again.
 */
export function savingDetail(p: SavingProposal): string {
  switch (p.change.what) {
    case "stopUsingOwnerSetup":
      return "You can switch it back on any time on the agent's own page. It will run in "
        + "the plain setup Cloud9 builds instead — your written instructions, your slash "
        + "commands, your connected services, your plugins and your hooks will not load "
        + "for it, so its turns get much smaller and cheaper.";
    case "setMonthlyLimit":
      return "You can raise or remove the limit any time on the agent's own page. Once it "
        + `has spent ${humanMoney(p.change.perMonthUsd)} in a calendar month it stops until `
        + "the next month, and it says so rather than going quiet. Nothing else changes.";
  }
}

/**
 * THE CHANGE AS A PATCH ON THE AGENT — the only place a `SavingChange` becomes
 * a field.
 *
 * Returns a WHOLE agent, built from the stored one, so the caller sends exactly
 * what his own editor would send. Refuses (returns undefined) anything
 * `narrowingOnly` does not recognise, so a change that reached here by some
 * route nobody thought of still cannot be written.
 */
export function applySaving(agent: AgentDef, change: SavingChange): AgentDef | undefined {
  if (!narrowingOnly(change)) return undefined;
  switch (change.what) {
    case "stopUsingOwnerSetup":
      return { ...agent, useOwnerSetup: false };
    case "setMonthlyLimit": {
      const cap: AgentSpendCap = { ...spendCapOf(agent), perMonthUsd: change.perMonthUsd };
      return { ...agent, spendCap: cap };
    }
  }
}

// ---------------------------------------------------------------------------
// 2. NAMING THE WASTE
// ---------------------------------------------------------------------------

/**
 * ONE THING THAT IS WRONG WITH HOW AN AGENT IS SET UP, said as a sentence he
 * could repeat to somebody else.
 *
 * `evidence` is not decoration. Every finding has to be able to show the
 * counted facts it was drawn from, because the alternative is an app that tells
 * him to change something and cannot say why — which is exactly the "trust me"
 * he has been burned by. A finding with no evidence is not built.
 */
export interface WasteFinding {
  /** stable name, so a screen or a test can point at one */
  id: "ownerSetupOnEveryTurn" | "noSpendingLimit" | "mostlyWhatItIsSent" | "noCostReported";
  agentId: ID;
  agentName: string;
  /** the one line he reads first */
  headline: string;
  /** the counted facts behind it — never a claim, always a measurement */
  evidence: string[];
  /** what he would gain, when it can be said honestly. Absent when it cannot. */
  worth?: string;
  /**
   * A MEASUREMENT FROM SOMEWHERE ELSE, kept apart from `evidence` and always
   * saying whose it is.
   *
   * It exists because a hard-coded figure from a different agent on a different
   * day was sitting in `evidence` among counted facts about THIS agent, where
   * it read as something Cloud9 had measured here. Facts about him go in
   * `evidence`; anything borrowed goes here, drawn differently and attributed.
   */
  reference?: string;
  /** the change that would fix it — absent when there is nothing to propose */
  change?: SavingChange;
}

/**
 * How many turns an agent has to have taken before a finding about a share or a
 * pattern is worth showing. One expensive turn is not a habit, and telling him
 * to change a setting on the strength of a single run is how an app loses the
 * right to be believed.
 */
export const ENOUGH_RUNS_TO_JUDGE = 3;

/**
 * The share of a bill that has to be "what it was sent" before that is worth
 * naming. Measured against this app's own behaviour rather than picked: a turn
 * with the owner's setup loaded was measured on this machine at 30,213 of
 * standing instructions before the conversation was added at all, against 7,111
 * without — so an agent whose bill is four-fifths material it did not ask for is
 * the ordinary shape of the problem, not an edge of it.
 */
export const MOSTLY_SENT_SHARE = 0.8;

/** What a monthly limit is proposed at, when one is proposed. See `suggestedMonthlyLimit`. */
export const LIMIT_HEADROOM = 2;

/**
 * A LIMIT WITH ROOM IN IT.
 *
 * Twice what the agent has actually spent this month, rounded up to a whole
 * dollar and never below one. Deliberately generous: the point of the first
 * limit is to stop a runaway, not to stop his agent working — a limit set at
 * what he has already spent would fire this afternoon and he would rightly
 * never trust another suggestion from this feature.
 */
export function suggestedMonthlyLimit(spentUsd: number): number {
  const safe = Number.isFinite(spentUsd) && spentUsd > 0 ? spentUsd : 0;
  return Math.max(1, Math.ceil(safe * LIMIT_HEADROOM));
}

export interface FindWasteInput {
  use: AgentTokenUse;
  /** the agent as it is set up right now — what is already true is not a finding */
  agent: Pick<AgentDef, "useOwnerSetup" | "spendCap">;
  /**
   * WHAT THE SPENDING CEILING WILL ACTUALLY BE COMPARED AGAINST — the figure
   * `decideSpend` uses, which is `RunStore.spentInMonth`.
   *
   * IT IS NOT THE SAME AS `use.costUsd`, AND THAT GAP WAS A REAL BUG. The
   * roll-up can only sum runs still on disk; `spentInMonth` also adds
   * `spent.ledger`, the money carried forward from runs since deleted. So a
   * limit suggested at twice the roll-up could be BELOW what the month has
   * really cost — and he would accept a card promising "this won't get in its
   * way today" and watch the agent stop within the hour. That is the single
   * worst thing this feature could do to him, because it would look exactly
   * like the app breaking his crew for no reason.
   *
   * Absent means the caller has no better figure than the roll-up (the hub,
   * which keeps no carry ledger). The suggestion then still cannot land below
   * what it can see — see `suggestedMonthlyLimit`.
   */
  spentThisMonthUsd?: number;
}

/**
 * Everything worth saying about one agent, most useful first.
 *
 * WHAT IT WILL NOT DO. It says nothing it cannot show the counting for; it
 * never repeats a finding about a setting that is already the way it would
 * suggest; and it never proposes a change to something the app cannot change
 * (a Codex agent has no spending limit to set, so it is told that instead of
 * being offered a box that does nothing).
 */
export function findWaste(input: FindWasteInput): WasteFinding[] {
  const { use, agent } = input;
  const out: WasteFinding[] = [];
  const who = { agentId: use.agentId, agentName: use.agentName };

  // --- the 318x one. First, because on this machine it is the whole game. ---
  //
  // HELD TO `ENOUGH_RUNS_TO_JUDGE` LIKE EVERY OTHER FINDING, and it was not.
  // It fired on a single turn — proved by the very screenshot taken to show the
  // feature working, which raised it on 1 of 1 turn that had no reported cost
  // at all. One turn is not a habit, and telling him to change a setting on the
  // strength of one run is how an app loses the right to be believed. The rule
  // was always written down; this finding simply did not ask.
  if (agent.useOwnerSetup === true
    && use.runsInOwnerSetup > 0
    && use.runs >= ENOUGH_RUNS_TO_JUDGE) {
    const evidence = [
      `${use.runsInOwnerSetup} of its ${use.runs} turn${use.runs === 1 ? "" : "s"} this month `
      + `started up with your own Claude Code setup loaded.`,
    ];
    let worth: string | undefined;
    let reference: string | undefined;
    // THE BEST EVIDENCE IS THIS AGENT'S OWN. When it happens to have run both
    // ways, the comparison is real and measured here, on his machine, on his
    // work — so that is what is shown. It is only when it has never run the
    // other way that the general measurement is quoted, and it is labelled as
    // somebody else's measurement when it is.
    const inAvg = averageOf(use.costInOwnerSetupUsd, use.runsInOwnerSetupWithCost);
    const outAvg = averageOf(use.costOutsideOwnerSetupUsd, use.runsOutsideOwnerSetupWithCost);
    if (inAvg !== undefined && outAvg !== undefined && outAvg > 0) {
      evidence.push(
        `Its turns WITH your setup averaged ${humanMoney(inAvg)}; its turns without it `
        + `averaged ${humanMoney(outAvg)} — ${(inAvg / outAvg).toFixed(0)} times cheaper.`,
      );
      if (use.costInOwnerSetupUsd !== undefined) {
        const saved = use.costInOwnerSetupUsd - outAvg * use.runsInOwnerSetupWithCost;
        if (saved > 0) {
          worth = `On this agent's own figures, running those turns without your setup `
            + `would have cost about ${humanMoney(saved)} less this month.`;
        }
      }
    } else {
      // A MEASUREMENT OF SOMETHING ELSE IS NOT EVIDENCE ABOUT THIS AGENT.
      //
      // This sentence used to sit in `evidence` beside counted facts about his
      // agent, which made a hard-coded figure from a different agent on a
      // different day read as something Cloud9 had measured about THIS one. It
      // is the same number and it is still worth knowing — so it moves to
      // `reference`, which the screen draws apart and attributes out loud.
      reference =
        "For scale, from a different test on this computer on 5 August 2026: the same "
        + "tiny question cost $1.75 with your setup loaded and $0.0055 without it — 318 "
        + "times as much. That was measured on another agent, not on this one.";
    }
    // WHAT THIS AGENT IS REALLY HANDED, per turn, measured on its own runs.
    // Worth far more than the borrowed 318x and it was drawn far too small
    // until `handedToItOf` existed — "less than a page" printed directly under
    // "loads your whole Claude Code setup", which is a card arguing with itself.
    if (use.sentToIt !== undefined && use.runsWithSize > 0) {
      evidence.push(
        `Across those turns it was handed `
        + `${humanTextSize(use.sentToIt / use.runsWithSize)} of material per turn before `
        + `your question was added to it.`,
      );
    }
    out.push({
      id: "ownerSetupOnEveryTurn", ...who,
      headline: `${use.agentName} loads your whole Claude Code setup on every turn`,
      evidence, ...(worth ? { worth } : {}), ...(reference ? { reference } : {}),
      change: { what: "stopUsingOwnerSetup" },
    });
  }

  // --- an agent that can be capped, is spending, and has no ceiling ---
  const cap = spendCapOf(agent);
  if (use.reportsCost && cap.perMonthUsd === undefined
    && use.costUsd !== undefined && use.runs >= ENOUGH_RUNS_TO_JUDGE) {
    // THE FIGURE THE CEILING WILL REALLY BE JUDGED AGAINST, never the roll-up
    // alone — see `FindWasteInput.spentThisMonthUsd`. The larger of the two,
    // because whichever is bigger is the one the agent has provably spent.
    const spent = Math.max(use.costUsd, input.spentThisMonthUsd ?? 0);
    const limit = suggestedMonthlyLimit(spent);
    out.push({
      id: "noSpendingLimit", ...who,
      headline: `${use.agentName} has no spending limit at all`,
      evidence: [
        `It has spent ${humanMoney(spent)} this month across ${use.runsWithCost} `
        + `turn${use.runsWithCost === 1 ? "" : "s"}.`,
        `Nothing would stop it spending more than that — there is no ceiling on it, `
        + `and there never has been.`,
      ],
      worth: `A ${humanMoney(limit)} ceiling is about twice what it has actually used, `
        + `so it would not get in its way today but it would stop a runaway.`,
      change: { what: "setMonthlyLimit", perMonthUsd: limit },
    });
  }

  // --- the bill is mostly material it was handed, not work it did ---
  const split = sentVsWrote(use);
  if (split && use.runsWithSize >= ENOUGH_RUNS_TO_JUDGE && split.sentShare >= MOSTLY_SENT_SHARE) {
    out.push({
      id: "mostlyWhatItIsSent", ...who,
      headline: `Nearly everything ${use.agentName} costs is material handed TO it, `
        + `not work it did`,
      evidence: [
        `${pct(split.sentShare)} of everything that went through it was material sent to `
        + `it; only ${pct(split.wroteShare)} was what it actually wrote back.`,
        `That works out at ${humanTextSize((use.sentToIt ?? 0) / use.runsWithSize)} sent `
        + `per turn against ${humanTextSize((use.wroteBack ?? 0) / use.runsWithSize)} written.`,
      ],
    });
  }

  // --- THERE IS DELIBERATELY NO "nothing is being re-used" FINDING ------------
  //
  // There was one. It said "this agent is paying full price for the same
  // material every turn" whenever `reusedFromLastTime` came out at zero, and it
  // was WRONG, in the most damaging direction an app can be wrong: it made an
  // accusation out of something it could not tell apart from its opposite.
  //
  // A run with no cache reads is either an agent genuinely re-sending
  // everything, or an agent WRITING the cache — the first turn of a
  // conversation, which is the correct and cheapest thing for it to be doing.
  // Until 2026-08-07 nothing recorded `cache_creation_input_tokens` at all, so
  // for every run the owner already had, those two are indistinguishable. And a
  // zero that is really an absence read as the bad one of the two.
  //
  // The honest fix was not a better threshold. It was to stop saying it. The
  // field it needs (`RunUsage.cacheWriteTokens`) is now recorded going forward,
  // so a future version of this finding can be written on evidence rather than
  // on the absence of evidence — and if it ever is, it must refuse to speak
  // about any run that predates the field.

  // --- and the honest one, which is not a fault ---
  if (!use.reportsCost && use.runs > 0) {
    out.push({
      id: "noCostReported", ...who,
      headline: `Cloud9 cannot say what ${use.agentName} costs`,
      evidence: [
        `It runs on Codex, and the Codex app does not report what a turn cost. `
        + `${use.runs} turn${use.runs === 1 ? " has" : "s have"} been recorded and `
        + `not one of them carried a figure.`,
        `That is why this agent shows no money rather than showing $0.00 — nobody has `
        + `told Cloud9 it was free, and it almost certainly was not.`,
      ],
    });
  }

  return out;
}

function averageOf(total: number | undefined, count: number): number | undefined {
  if (total === undefined || count <= 0) return undefined;
  return total / count;
}

function pct(share: number): string {
  return `${Math.round(share * 100)}%`;
}

// ---------------------------------------------------------------------------
// THE WHOLE ANSWER, IN WORDS — what an agent gets back through the tool
// ---------------------------------------------------------------------------

export interface TokenUseReportRow {
  use: AgentTokenUse;
  findings: WasteFinding[];
}

/**
 * The report an agent reads when it asks how the crew is spending.
 *
 * IT IS THE SAME WORDS THE SCREEN SHOWS HIM. Deliberately: the moment the agent
 * is given a private, more technical version of this, an agent starts telling
 * him things his own screen does not say, and he has no way to check any of it.
 * One set of sentences, one set of numbers, two audiences.
 */
export function renderTokenUseReport(rows: readonly TokenUseReportRow[], period: UsePeriod): string {
  const when = period === "thisMonth" ? "so far this calendar month" : "across every turn still kept";
  if (rows.length === 0) {
    return `No agent has taken a recorded turn ${when}, so there is nothing to say about `
      + `spending yet. Say that, rather than guessing.`;
  }
  const lines: string[] = [`How this crew is spending, ${when}:`, ""];
  for (const row of dearestFirst(rows.map(r => r.use)).map(u => rows.find(r => r.use.agentId === u.agentId)!)) {
    const u = row.use;
    lines.push(`• ${u.agentName} (${u.provider}) — ${moneyWords(u)}`);
    const split = sentVsWrote(u);
    if (split) {
      lines.push(`  ${pct(split.sentShare)} of that was material sent TO it; `
        + `${pct(split.wroteShare)} was what it wrote back.`);
    }
    for (const f of row.findings) {
      lines.push(`  ⚠ ${f.headline}`);
      for (const e of f.evidence) lines.push(`    - ${e}`);
      if (f.worth) lines.push(`    - ${f.worth}`);
      // KEPT APART AND ATTRIBUTED, exactly as the screen keeps it apart. An
      // agent handed a borrowed measurement among counted facts will repeat it
      // as this agent's own, and then he is being quoted a number about
      // something else as though it were about his.
      if (f.reference) lines.push(`    (for scale, measured elsewhere) ${f.reference}`);
      if (f.change) {
        lines.push(`    → You can offer this to the owner with propose_saving: `
          + `about "${u.agentName}", change ${describeChangeForAgent(f.change)}.`);
      }
    }
  }
  lines.push("");
  lines.push(
    "These are real reported figures, not estimates. Where an app reported nothing, "
    + "nothing is shown — never a zero. You cannot change any of these settings yourself: "
    + "the only thing you can do is put a suggestion in front of the owner with "
    + "propose_saving, and he decides.",
  );
  return lines.join("\n");
}

/** How a change is named to an AGENT — the argument it would pass, not prose. */
export function describeChangeForAgent(change: SavingChange): string {
  return change.what === "stopUsingOwnerSetup"
    ? `"stopUsingOwnerSetup"`
    : `"setMonthlyLimit" with perMonthUsd ${change.perMonthUsd}`;
}
