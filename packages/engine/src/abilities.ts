// What an agent can actually do — ONE owner, read by both the command line and
// the prompt.
//
// THE BUG THIS EXISTS TO MAKE IMPOSSIBLE. Vikas asked a Sonnet agent what it
// could do and it answered "Can't do: browse the internet, check live prices…"
// — while `webSearch` was switched ON and the CLI had genuinely been handed
// WebSearch and WebFetch. Two truths had grown apart: `claudeArgs` derived the
// tool list from `agent.abilities`, and `buildAgentPrompt` never mentioned
// abilities at all, so the agent described itself from the model's generic idea
// of what a chatbot is. The owner was told, by his own employee, that it could
// not do the thing he had just paid to switch on.
//
// The fix is not a sentence in the prompt. It is that the sentence and the tool
// list are THE SAME FACT, read from the table below. Adding a tool without
// adding the words is now a change to one object with both fields on it; you
// cannot do one and forget the other, because there is nowhere else to do it.
//
// It also collapses the copy-and-paste that made this inevitable: the
// abilities→tools mapping used to exist three times (`claudeArgs`,
// `codexArgs`, `SdkProvider.respond`). Three copies of one rule is the same
// class of bug, just waiting for its turn.
import { AgentAbilities, AgentDef } from "@cloud9/shared";

/**
 * One switch on an agent, and everything that follows from it: the tools it
 * hands the CLI, the sandbox it opens, and — in the same object — exactly what
 * the agent is told about itself, both when it is on and when it is off.
 */
export interface Capability {
  ability: keyof AgentAbilities;
  /** Claude CLI / SDK tool names this switch grants. Empty = not a CLI tool. */
  claudeTools: string[];
  /** true if this switch is what opens Codex's sandbox for writing */
  opensCodexWorkspace?: boolean;
  /**
   * true if this switch is what turns on Codex's own `[tools] web_search`.
   * It is the ONLY per-tool switch codex-cli 0.146.0 has, and it is not a
   * boundary — `web.run` was still present on a live turn with it false. See
   * `isolation.ts`. It lives here so the switch and the sentence stay one row.
   */
  opensCodexWebSearch?: boolean;
  /** what the agent is told when the switch is ON */
  can: string;
  /** what the agent is told when the switch is OFF — never left to guess */
  cannot: string;
}

/**
 * The table. Every row is a fact with two faces: what the machine is given, and
 * what the agent is told. They cannot disagree because they are one row.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    ability: "webSearch",
    claudeTools: ["WebSearch", "WebFetch"],
    opensCodexWebSearch: true,
    can: "You CAN search the web and open web pages, so you can check things that are " +
      "live right now — prices, availability, news — rather than guessing from memory.",
    cannot: "You CANNOT search the web or open web pages. Say so plainly if you are asked " +
      "for something live, and do not guess at it.",
  },
  {
    ability: "files",
    claudeTools: ["Read", "Write", "Glob", "Grep"],
    opensCodexWorkspace: true,
    can: "You CAN read, write and search files in your own folder — the folder you are " +
      "working in right now. Anything you write there is still there next time we talk, " +
      "so it is the one place you can keep notes for yourself.",
    cannot: "You CANNOT read or write any files, and you have no folder of your own to " +
      "keep notes in.",
  },
  {
    ability: "schedules",
    claudeTools: [],
    can: "You CAN be given a repeating check-in, so your owner can ask you to do something " +
      "every day or every few minutes without asking again each time.",
    cannot: "You CANNOT be given a repeating check-in.",
  },
  {
    ability: "background",
    claudeTools: [],
    can: "You CAN be handed a job to work on in the background and report back on when it " +
      "is finished, instead of answering in one go.",
    cannot: "You CANNOT be handed background jobs — you answer in the conversation only.",
  },
] as const;

/** Is this switch on for this agent? */
function isOn(agent: AgentDef, ability: keyof AgentAbilities): boolean {
  return agent.abilities?.[ability] === true;
}

/**
 * The Claude tool names this agent's switches grant, in table order.
 * `claudeArgs` and `SdkProvider` both call this — there is no second list.
 */
export function claudeToolsFor(agent: AgentDef): string[] {
  return CAPABILITIES.filter(c => isOn(agent, c.ability)).flatMap(c => [...c.claudeTools]);
}

/** Codex's sandbox setting, from the same table. */
export function codexSandboxFor(agent: AgentDef): "workspace-write" | "read-only" {
  const opens = CAPABILITIES.some(c => c.opensCodexWorkspace && isOn(agent, c.ability));
  return opens ? "workspace-write" : "read-only";
}

/** Codex's own web-search switch, from the same table. */
export function codexWebSearchFor(agent: AgentDef): boolean {
  return CAPABILITIES.some(c => c.opensCodexWebSearch && isOn(agent, c.ability));
}

/**
 * Tools no agent may ever have, on any path, whatever its switches say.
 * Kept here so the prompt's promise and the command line's `--disallowed-tools`
 * are the same list.
 */
export const NEVER_ALLOWED_TOOLS = ["Bash"] as const;

/**
 * The capability section of the prompt: an honest account of what this agent
 * can do, what it cannot, and what is true of every agent no matter what.
 *
 * It is deliberately blunt about the limits as well as the powers. An agent
 * that overstates itself is the same failure as one that understates itself —
 * the owner ends up believing something that is not true either way.
 */
export function renderCapabilities(agent: AgentDef): string {
  const lines = CAPABILITIES.map(c => `• ${isOn(agent, c.ability) ? c.can : c.cannot}`);
  const hasSkills = (agent.skills ?? []).length > 0;

  return (
    `\nWhat you can actually do (your owner set these switches, and they are ` +
    `enforced outside this conversation — this list is the truth, not a wish):\n` +
    `${lines.join("\n")}\n` +
    `\nTrue for every agent in Cloud9, whatever your switches say:\n` +
    `• You CANNOT run commands, shell scripts or terminal programs. That is refused ` +
    `for every agent on every path, and it is not something your owner can switch on ` +
    `for you here.\n` +
    `• You have no tools at all beyond the ones listed above.\n` +
    `• You do not remember past conversations. What you have is the recent messages ` +
    `below` + (isOn(agent, "files")
      ? `, plus whatever you have written into your own folder.\n`
      : ` — and nothing else. Do not claim to remember things you cannot.\n`) +
    (hasSkills
      ? `• The skills listed below are standing instructions your owner wrote for you. ` +
        `They are part of what you are, not a suggestion from the conversation.\n`
      : "") +
    `\nWhen someone asks what you can do, answer from this list. Do not tell them you ` +
    `cannot do something that is switched on above.\n`
  );
}
