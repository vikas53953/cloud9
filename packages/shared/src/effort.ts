// HOW HARD AN AGENT SHOULD THINK — one owner for the whole idea.
//
// WHAT WAS ON THE FLOOR. Both apps Cloud9 drives let you turn a dial on how much
// thinking a model does before it answers, and Cloud9 turned neither. Every
// agent took whichever setting its app happened to default to — for Codex that
// is "low" on its newest model (`codex debug models`, measured 2026-08-05), for
// Claude it is whatever the app decides. So the cheapest quality control either
// app offers was never in the owner's hands.
//
// WHY IT ALL LIVES IN ONE FILE. There are three separate things that must agree:
// the four words the owner reads, the flag the Claude app takes, and the config
// key the Codex app takes. When those live at their own call sites they drift —
// somebody adds a fifth choice to a dropdown and two command lines quietly do
// nothing with it. Here, adding a rung means adding a row, and a row that is
// missing a harness will not compile.
//
// MEASURED AGAINST THE INSTALLED APPS, NOT REMEMBERED (2026-08-05):
//
//   claude 2.1.222   `--effort <level>`
//                    The CLI names its own valid set when given a bad one:
//                      "Warning: Unknown --effort value 'banana' — ignoring it
//                       and using the default effort. Valid values: low,
//                       medium, high, xhigh, max."
//                    An unknown value is a WARNING, not a refusal — which is
//                    exactly why the table below is checked here rather than
//                    trusted to the CLI.
//
//   codex  0.146.0   no `--effort` flag exists on `codex exec` (its `--help`
//                    was read in full). The dial is a config value:
//                      `-c model_reasoning_effort=<level>`
//                    Proved both ways on live turns: `high` ran normally, and
//                    `banana` came back as a real API refusal
//                      "[ReasoningEffortParam] [reasoning.effort] [invalid…]"
//                    so the key name is load-bearing rather than ignored.
//
// WHY "HARDEST" IS NOT THE SAME WORD ON BOTH. `codex debug models` lists what
// each model will actually accept, and it is not the same list per model:
// gpt-5.6-sol goes up to `ultra`, while gpt-5.5, gpt-5.4, gpt-5.4-mini and
// gpt-5.3-codex-spark stop at `xhigh`. `xhigh` is the highest rung EVERY Codex
// model on this machine advertises, so that is what "Hardest" means there —
// picking `max` would have worked on one model and failed on four. Claude's
// `--effort` set is not per-model, so "Hardest" there is `max`.

/**
 * HOW HARD SHOULD IT THINK? — the owner's own four words, in his own order.
 *
 * ABSENT MEANS TODAY'S BEHAVIOUR, and that is the load-bearing part: every agent
 * that already exists carries no such field, so no flag is passed for it and
 * nothing about it changes until he chooses. "Normal" is NOT the same as absent
 * — absent is "whatever the app picks", Normal is "medium, because I said so".
 */
export type AgentEffort = "quick" | "normal" | "hard" | "hardest";

export interface AgentEffortChoice {
  id: AgentEffort;
  /** what the owner reads on the button */
  label: string;
  /** one line under it — plain words, no model jargon */
  hint: string;
}

/**
 * The four rungs, in order. Written for a network engineer, not a developer:
 * nothing here says "reasoning tokens", "effort level" or "inference budget".
 */
export const AGENT_EFFORT_CHOICES: readonly AgentEffortChoice[] = [
  { id: "quick", label: "Quick", hint: "Answers fast. Best for chat and simple asks." },
  { id: "normal", label: "Normal", hint: "A sensible middle. Good for most work." },
  { id: "hard", label: "Hard", hint: "Takes longer and thinks it through. Costs more." },
  { id: "hardest", label: "Hardest", hint: "Slowest and dearest. Save it for the tricky jobs." },
] as const;

/** What to show when he has never chosen — the honest word for "the app decides". */
export const AGENT_EFFORT_UNSET_LABEL = "App's own setting";
export const AGENT_EFFORT_UNSET_HINT =
  "Cloud9 says nothing about thinking time, so the app uses whatever it normally would.";

/** Is this one of the four words? Everything that reaches storage goes through here. */
export function isAgentEffort(value: unknown): value is AgentEffort {
  return typeof value === "string"
    && AGENT_EFFORT_CHOICES.some(choice => choice.id === value);
}

/** The harnesses this table knows about. Deliberately spelled here, not imported. */
export type EffortHarness = "claude" | "codex";

/**
 * ONE ROW PER RUNG, ONE COLUMN PER APP. TypeScript will not let a rung exist
 * without an answer for both apps, which is the whole point of the shape.
 *
 * The VALUES are the apps' own words, copied from the apps themselves — see the
 * measurements at the top of this file.
 */
const EFFORT_LEVELS: Readonly<Record<AgentEffort, Readonly<Record<EffortHarness, string>>>> = {
  quick: { claude: "low", codex: "low" },
  normal: { claude: "medium", codex: "medium" },
  hard: { claude: "high", codex: "high" },
  // see the long note above: `max` on Claude, `xhigh` on Codex, because four of
  // the nine Codex models on this machine refuse anything above `xhigh`.
  hardest: { claude: "max", codex: "xhigh" },
};

/**
 * THE LEVEL THIS APP SHOULD BE TOLD, or undefined for "say nothing".
 *
 * Undefined is returned for an agent that has never been given a choice, and for
 * a stored value that is not one of the four words — a corrupt setting must cost
 * the dial, never put something odd on a command line. Both cases land on
 * exactly today's behaviour, which is the only safe direction for this to fail.
 */
export function effortLevelFor(
  harness: EffortHarness, effort: unknown,
): string | undefined {
  if (!isAgentEffort(effort)) return undefined;
  return EFFORT_LEVELS[effort][harness];
}

/**
 * CAN THIS WAY OF RUNNING AN AGENT HONOUR THE DIAL AT ALL?
 *
 * Both locally-installed apps can. The one route that cannot is the stored-API-
 * key route (`SdkProvider`): the Claude Agent SDK's options were read at the
 * installed version and there is no effort field of any kind on them. Rather
 * than pretend, that path passes nothing and this function says so out loud, so
 * a screen can too.
 */
export function effortSupportedBy(route: EffortHarness | "sdk" | "mock"): boolean {
  return route === "claude" || route === "codex";
}

/** Plain words for a stored choice — the sentence a screen or a record shows. */
export function effortWords(effort: unknown): string {
  const choice = AGENT_EFFORT_CHOICES.find(c => c.id === effort);
  return choice ? choice.label : AGENT_EFFORT_UNSET_LABEL;
}
