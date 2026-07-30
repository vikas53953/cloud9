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
// THE CEILING, raised 2026-07-30. Vikas: "these agents are fully agentic and
// using the harness from claude and codex, they already have access to
// everything… whatever functions we have as codex and claude code on my system,
// every functionality should be replicated." The day before, the switches were
// made a real boundary — and set too low: `Bash` was on a NEVER_ALLOWED list, so
// no switch he could set would ever let an agent run a program on his own PC.
// Both facts are right, so both are kept:
//
//   * the switches are still the whole boundary (Claude's `--tools` DECLARES
//     the set, and everything not granted is spelled out in `--disallowed-tools`);
//   * his own dev setup is still shut out at EVERY reach (`--safe-mode`,
//     `--strict-mcp-config`, `--disable-slash-commands`, `--ignore-user-config`);
//   * but the top of the ladder now grants the CLI's whole built-in surface;
//   * and every row that changes the machine or spends money carries
//     `alwaysAsk`, so the honest guard is "ask first", never "cannot".
//
// MEASURED, not remembered. `CLAUDE_BUILTIN_TOOLS` below is the tool list the
// installed CLI reported for itself on 2026-07-30 — see the comment on it. This
// matters more than it looks: `claude -p --tools NotARealToolXYZ` was run and it
// exits 0 and answers normally. An unknown tool name is NOT an error; it is a
// capability that silently never arrives. A test checks every name in this table
// against that measured list, so a typo cannot become a switch that does nothing.
import { AgentAbilities, AgentApprovals, AgentDef, mustAskBeforeActing } from "@cloud9/shared";

/**
 * Every built-in tool claude-code **2.1.220** has, measured on 2026-07-30 by
 * running the real command line Cloud9 ships and reading the CLI's own
 * `system/init` event:
 *
 *   claude -p --output-format stream-json --verbose --permission-mode dontAsk \
 *     --safe-mode --strict-mcp-config --disable-slash-commands --tools default
 *
 *   tools: Task, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit,
 *          EnterWorktree, ExitWorktree, Glob, Grep, Monitor, NotebookEdit,
 *          PowerShell, PushNotification, Read, RemoteTrigger, ReportFindings,
 *          ScheduleWakeup, SendMessage, TaskCreate, TaskGet, TaskList,
 *          TaskOutput, TaskStop, TaskUpdate, ToolSearch, WebFetch, WebSearch,
 *          Workflow, Write
 *   mcp_servers: []   slash_commands: []   skills: []
 *
 * TWO THINGS THAT WERE ASSUMED AND ARE NOT TRUE:
 *  - `PowerShell` is its own tool, separate from `Bash`. The old
 *    `NEVER_ALLOWED_TOOLS = ["Bash"]` would not have stopped a shell on Windows
 *    if the declaration had ever slipped. The denied list is derived from THIS
 *    list now, so it cannot miss a sibling again.
 *  - the same probe still reported seven of Vikas's **plugins** by path under
 *    `--safe-mode`, while reporting zero skills, zero slash commands and zero
 *    MCP servers. Nothing measurably reached the agent, so it is not listed as a
 *    leak — but it is written down in `isolation.ts` as an unknown rather than
 *    quietly rounded to "clean".
 */
export const CLAUDE_BUILTIN_TOOLS = [
  "Task", "Bash", "CronCreate", "CronDelete", "CronList", "DesignSync", "Edit",
  "EnterWorktree", "ExitWorktree", "Glob", "Grep", "Monitor", "NotebookEdit",
  "PowerShell", "PushNotification", "Read", "RemoteTrigger", "ReportFindings",
  "ScheduleWakeup", "SendMessage", "TaskCreate", "TaskGet", "TaskList",
  "TaskOutput", "TaskStop", "TaskUpdate", "ToolSearch", "WebFetch", "WebSearch",
  "Workflow", "Write",
] as const;

/**
 * One switch on an agent, and everything that follows from it: the tools it
 * hands the CLI, the sandbox it opens, whether the owner is asked first, and —
 * in the same object — exactly what the agent is told about itself, both when it
 * is on and when it is off.
 */
export interface Capability {
  ability: keyof AgentAbilities;
  /** the switch in the owner's words, for a screen. Never jargon. */
  label: string;
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
  /** the Codex feature flag this switch keeps ON; off means `--disable <name>` */
  codexFeature?: string;
  /** true if this switch is what widens the agent beyond its own folder */
  widensBeyondOwnFolder?: boolean;
  /** true if this switch is what lets a per-agent MCP config be passed in */
  opensConnections?: boolean;
  /**
   * TRUE when using this changes the machine or spends money. The owner is
   * ALWAYS asked first — `approvalsFor()` forces the approval on and no stored
   * agent definition can turn it off. This is the honest guard Vikas asked for:
   * he owns the PC, so the answer is "ask first", not "cannot".
   */
  alwaysAsk?: boolean;
  /** what the agent is told when the switch is ON */
  can: string;
  /** what the agent is told when the switch is OFF — never left to guess */
  cannot: string;
  /**
   * THE THIRD FACE OF THE FACT (docs/qa/gap-audit.md §3, Integrations).
   *
   * Some switches grant nothing by themselves: they only say that a thing MAY be
   * passed to the harness. Whether it actually IS passed is decided by the
   * launcher, at the moment the command line is built. When it is not, the `can`
   * sentence above is a lie — and it was being told. `host.ts` never supplied
   * `wholeComputerRoots` or `mcpConfigPath`, so an agent on the top rung was
   * told word for word "You CAN use the connected services your owner set up for
   * you" while `--mcp-config` was never on the line at all. `HANDOFF.md` was
   * honest that these are inert. The screen was honest. The prompt was not.
   *
   * So a row that needs something supplied NAMES what it needs, and gets a third
   * sentence for "switched on, nothing behind it". The prompt asks the same
   * function the command line asks (`grantedSupply`), so the sentence and the
   * flag are one fact — which is exactly what this file exists for, applied to
   * the one face of it that was left out.
   */
  needsSupply?: keyof Supply;
  /** what the agent is told when the switch is ON and nothing was supplied */
  onButNothingSupplied?: string;
}

/**
 * What the LAUNCHER actually hands the harness for this turn. Not what the owner
 * switched on — what is really going onto the command line.
 */
export interface Supply {
  /** folders outside the agent's own one, for `--add-dir` */
  wholeComputerRoots?: string[];
  /** a per-agent MCP config file, for `--mcp-config` */
  mcpConfigPath?: string;
}

/**
 * THE ONE ANSWER to "what does this agent truly get?", asked by the command line
 * and by the prompt.
 *
 * Offered is what a caller has; granted is what the switches allow of it. A
 * caller cannot widen an agent by handing it a path (the switch decides), and a
 * switch cannot promise something the caller does not have (the supply decides).
 * Both directions are tested.
 */
export function grantedSupply(agent: AgentDef, offered: Supply): Supply {
  const granted: Supply = {};
  const roots = (offered.wholeComputerRoots ?? []).filter(r => r.length > 0);
  if (reachesBeyondOwnFolder(agent) && roots.length > 0) granted.wholeComputerRoots = roots;
  if (allowsConnections(agent) && offered.mcpConfigPath) granted.mcpConfigPath = offered.mcpConfigPath;
  return granted;
}

/** Is this row's supply actually present for this turn? */
function isSupplied(cap: Capability, granted: Supply): boolean {
  if (!cap.needsSupply) return true;
  const value = granted[cap.needsSupply];
  return Array.isArray(value) ? value.length > 0 : !!value;
}

/**
 * The table. Every row is a fact with several faces: what the machine is given,
 * whether the owner is asked, and what the agent is told. They cannot disagree
 * because they are one row.
 *
 * ORDER MATTERS: it runs from harmless to powerful, and the ladder below is
 * built by taking a prefix of it. A new row goes where its danger puts it.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    ability: "webSearch",
    label: "Look things up on the web",
    claudeTools: ["WebSearch", "WebFetch"],
    opensCodexWebSearch: true,
    can: "You CAN search the web and open web pages, so you can check things that are " +
      "live right now — prices, availability, news — rather than guessing from memory.",
    cannot: "You CANNOT search the web or open web pages. Say so plainly if you are asked " +
      "for something live, and do not guess at it.",
  },
  {
    ability: "files",
    label: "Keep and change files in its own folder",
    claudeTools: ["Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep"],
    opensCodexWorkspace: true,
    can: "You CAN read, write and change files in your own folder — the folder you are " +
      "working in right now. Anything you write there is still there next time we talk, " +
      "so it is the one place you can keep notes for yourself.",
    cannot: "You CANNOT read or write any files, and you have no folder of your own to " +
      "keep notes in.",
  },
  {
    ability: "helpers",
    label: "Get help from its own helper agents",
    // the harness's own working tools: sub-agents, their task family, tool
    // discovery, workflows, and the small note-to-self tools it ships with.
    claudeTools: [
      "Task", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop", "TaskUpdate",
      "ToolSearch", "Workflow", "Monitor", "SendMessage", "ReportFindings", "DesignSync",
    ],
    codexFeature: "multi_agent",
    can: "You CAN hand parts of a job to helper agents of your own and wait for what they " +
      "find, instead of doing every step yourself in one long answer.",
    cannot: "You CANNOT hand work to helper agents — whatever you do, you do yourself in " +
      "this one answer.",
  },
  {
    ability: "schedules",
    label: "Check in on a repeating schedule",
    claudeTools: ["ScheduleWakeup", "CronCreate", "CronList", "CronDelete"],
    can: "You CAN be given a repeating check-in, so your owner can ask you to do something " +
      "every day or every few minutes without asking again each time.",
    cannot: "You CANNOT be given a repeating check-in.",
  },
  {
    ability: "background",
    label: "Work on jobs in the background",
    claudeTools: ["EnterWorktree", "ExitWorktree", "RemoteTrigger", "PushNotification"],
    can: "You CAN be handed a job to work on in the background and report back on when it " +
      "is finished, instead of answering in one go.",
    cannot: "You CANNOT be handed background jobs — you answer in the conversation only.",
  },
  {
    ability: "connections",
    label: "Use connected services your owner picked for you",
    // no built-in tool: the surface arrives as an MCP config passed in for THIS
    // agent. His own servers never load — `--strict-mcp-config` stays on always.
    claudeTools: [],
    opensConnections: true,
    alwaysAsk: true,
    needsSupply: "mcpConfigPath",
    can: "You CAN use the connected services your owner set up for you specifically. Those " +
      "are real accounts, so your owner is asked before you act through them.",
    cannot: "You CANNOT use any connected service or outside account.",
    onButNothingSupplied:
      "You CANNOT use any connected service right now. Your owner has allowed it, but this " +
      "computer has not given you one — no service is connected for you on this turn, and " +
      "no tool for one is in your hands. Say that plainly if you are asked; do not promise " +
      "work through an account you cannot reach.",
  },
  {
    ability: "wholeComputer",
    label: "Reach files outside its own folder",
    claudeTools: [],
    widensBeyondOwnFolder: true,
    alwaysAsk: true,
    needsSupply: "wholeComputerRoots",
    can: "You CAN reach files outside your own folder, in the places your owner opened up " +
      "for you. Because that changes his computer, he is asked first.",
    cannot: "You CANNOT reach anything outside your own folder.",
    onButNothingSupplied:
      "You CANNOT reach anything outside your own folder right now. Your owner has allowed " +
      "it, but he has not opened up any folder for you, so there is nowhere outside your " +
      "own folder you can actually get to. Say that plainly rather than trying.",
  },
  {
    ability: "commands",
    label: "Run programs on this computer",
    claudeTools: ["Bash", "PowerShell"],
    alwaysAsk: true,
    can: "You CAN run programs and commands on this computer, the same way Claude Code and " +
      "Codex do. Because that changes his machine, your owner is asked first — say what " +
      "you intend to run and wait, rather than promising it is already done.",
    cannot: "You CANNOT run programs, shell scripts or terminal commands.",
  },
] as const;

/**
 * The ladder Vikas actually picks from. Four rungs, plain words, each one
 * everything below it plus more — from "answer questions only" to "everything
 * this app can do on this computer".
 *
 * It is NOT a second source of truth: a rung is a PREFIX of the table above, so
 * a new capability row automatically lands on the rungs its position implies and
 * there is nowhere to forget it.
 */
export type Reach = "talk" | "look" | "work" | "computer";

export interface ReachLevel {
  level: Reach;
  /** the choice as a button on a screen */
  label: string;
  /** one line: what it means for him, no jargon */
  plainWords: string;
  /** how many rows of CAPABILITIES this rung turns on */
  rows: number;
}

export const REACH_LEVELS: readonly ReachLevel[] = [
  {
    level: "talk",
    label: "Just talk",
    plainWords: "Answers questions from what it knows. No tools at all.",
    rows: 0,
  },
  {
    level: "look",
    label: "Look things up and keep notes",
    plainWords: "Can check the web and keep files in its own folder. Nothing on your PC changes.",
    rows: 2,
  },
  {
    level: "work",
    label: "Do real work for you",
    plainWords: "Adds helper agents, repeating check-ins and background jobs. Still only its own folder.",
    rows: 5,
  },
  {
    level: "computer",
    label: "Everything this app can do on this computer",
    plainWords:
      "The same reach Claude Code and Codex have on your PC — running programs, files anywhere, " +
      "connected services. Anything that changes your machine or spends money asks you first.",
    rows: CAPABILITIES.length,
  },
] as const;

/** The switches a rung turns on. The only place a rung becomes abilities. */
export function abilitiesForReach(level: Reach): AgentAbilities {
  const rung = REACH_LEVELS.find(l => l.level === level) ?? REACH_LEVELS[0];
  const on = new Set(CAPABILITIES.slice(0, rung.rows).map(c => c.ability));
  const abilities: AgentAbilities = {
    webSearch: false, files: false, schedules: false, background: false,
  };
  for (const cap of CAPABILITIES) {
    (abilities as unknown as Record<string, boolean>)[cap.ability] = on.has(cap.ability);
  }
  return abilities;
}

/**
 * The rung an agent's switches amount to: the HIGHEST rung whose every switch is
 * on. An agent with an odd hand-picked mix reads as the highest rung it fully
 * covers, which is the honest way round — never round a mix UP.
 */
export function reachOf(agent: AgentDef): Reach {
  let answer: Reach = "talk";
  for (const rung of REACH_LEVELS) {
    const needed = CAPABILITIES.slice(0, rung.rows);
    if (needed.every(c => isOn(agent, c.ability))) answer = rung.level;
  }
  return answer;
}

/** Is this switch on for this agent? Absent always means off. */
function isOn(agent: AgentDef, ability: keyof AgentAbilities): boolean {
  return agent.abilities?.[ability] === true;
}

/** The rows this agent has switched on, in table order. */
export function grantedCapabilities(agent: AgentDef): Capability[] {
  return CAPABILITIES.filter(c => isOn(agent, c.ability));
}

/**
 * The Claude tool names this agent's switches grant, in table order.
 * `claudeArgs` and `SdkProvider` both call this — there is no second list.
 */
export function claudeToolsFor(agent: AgentDef): string[] {
  return grantedCapabilities(agent).flatMap(c => [...c.claudeTools]);
}

/**
 * Every built-in tool this agent has NOT been granted — spelled out on the
 * command line as `--disallowed-tools`.
 *
 * This REPLACES the old `NEVER_ALLOWED_TOOLS = ["Bash"]`, and is strictly
 * stronger in both directions. Stronger, because it is derived from the CLI's
 * whole measured surface, so it already covers `PowerShell` (which the old list
 * missed) and every tool a future CLI version adds to `CLAUDE_BUILTIN_TOOLS`.
 * And honest, because "no agent may EVER run a command" was the wrong promise:
 * Vikas owns the machine and asked for the ceiling to be lifted. A tool is
 * denied because HE did not switch it on, not because we decided for him.
 */
export function deniedClaudeTools(agent: AgentDef): string[] {
  const granted = new Set(claudeToolsFor(agent));
  return CLAUDE_BUILTIN_TOOLS.filter(t => !granted.has(t));
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

/** Does this agent's own folder stop being the edge of its world? */
export function reachesBeyondOwnFolder(agent: AgentDef): boolean {
  return CAPABILITIES.some(c => c.widensBeyondOwnFolder && isOn(agent, c.ability));
}

/** May a per-agent MCP config be passed in for this agent at all? */
export function allowsConnections(agent: AgentDef): boolean {
  return CAPABILITIES.some(c => c.opensConnections && isOn(agent, c.ability));
}

/** The switches that change the machine or spend money. From the table only. */
export function alwaysAskAbilities(): (keyof AgentAbilities)[] {
  return CAPABILITIES.filter(c => c.alwaysAsk).map(c => c.ability);
}

/**
 * The approvals that actually apply to this agent.
 *
 * The owner chooses whether background jobs and schedules need his nod. He does
 * NOT get to choose for anything marked `alwaysAsk` — if the switch is on, the
 * approval is on, whatever a stored (or forged) agent definition says. That is
 * the one rule that lets the ceiling be raised safely: full power, and a hand on
 * the door.
 *
 * It reuses the app's EXISTING approvals — the same `AgentApprovals` the Tasks
 * panel and `decideApproval` already work on. There is no second mechanism.
 */
export function approvalsFor(agent: AgentDef): Required<AgentApprovals> {
  const stored = agent.approvals;
  const answer: Required<AgentApprovals> = {
    background: stored?.background === true,
    schedules: stored?.schedules === true,
    commands: false, wholeComputer: false, connections: false,
  };
  for (const ability of alwaysAskAbilities()) {
    if (isOn(agent, ability)) (answer as Record<string, boolean>)[ability] = true;
  }
  return answer;
}

/**
 * Does this agent hold anything that has to be asked about before it acts?
 *
 * ONE OWNER, AND IT IS NOT THIS FILE. `mustAskBeforeActing` lives in
 * `@cloud9/shared` because the hub has to answer the same question and cannot
 * see this code — when the rule lived only here, the hub read `agent.approvals`
 * directly and would have let an unattended job from an agent that can run
 * programs straight through. This function is now a name for that rule, not a
 * second copy of it; `alwaysAskAbilities()` still exists because the CAPABILITY
 * TABLE is what turns those ability names into words for a screen, and
 * `abilities.test.ts` holds the two lists to each other.
 */
export function needsApprovalToRun(agent: AgentDef): boolean {
  return mustAskBeforeActing(agent);
}

/**
 * The powers this agent holds that will ask first, in his words. For a screen.
 *
 * NO SUPPLY ARGUMENT, on purpose. This answers the AGENT EDITOR, where Vikas is
 * setting switches: what he needs to know there is "if I turn this on, I will be
 * asked first", which is true of the switch whatever any particular turn's
 * launcher hands over. The PROMPT is a different question — "what do you hold
 * right now" — and it filters this list by what was really supplied (see
 * `renderCapabilities`).
 */
export function describeApprovalNeeds(agent: AgentDef): string[] {
  return CAPABILITIES.filter(c => c.alwaysAsk && isOn(agent, c.ability)).map(c => c.label);
}

/**
 * The capability section of the prompt: an honest account of what this agent
 * can do, what it cannot, and what is true of every agent no matter what.
 *
 * It is deliberately blunt about the limits as well as the powers. An agent
 * that overstates itself is the same failure as one that understates itself —
 * the owner ends up believing something that is not true either way.
 *
 * The blanket "you cannot run commands, and your owner cannot switch that on"
 * paragraph is GONE, because it stopped being true on 2026-07-30. Anything that
 * used to be said unconditionally is now said by the row that owns it, so the
 * words can never outlive the rule again.
 */
export function renderCapabilities(agent: AgentDef, granted: Supply = {}): string {
  const lines = CAPABILITIES.map(c => `• ${sentenceFor(agent, c, granted)}`);
  const hasSkills = (agent.skills ?? []).length > 0;
  // Only powers this agent REALLY holds this turn. Telling an agent that
  // connected services ask first, when no service is connected for it, is the
  // same lie in a politer coat.
  const asks = CAPABILITIES
    .filter(c => c.alwaysAsk && isOn(agent, c.ability) && isSupplied(c, granted))
    .map(c => c.label);

  return (
    `\nWhat you can actually do (your owner set these switches, and they are ` +
    `enforced outside this conversation — this list is the truth, not a wish):\n` +
    `${lines.join("\n")}\n` +
    (asks.length > 0
      ? `\nSome of that asks your owner first — ${asks.map(a => a.toLowerCase()).join("; ")}. ` +
        `When one of those is what a job needs, say what you intend to do and wait to be ` +
        `let through. Never report it as already done.\n`
      : "") +
    `\nTrue for every agent in Cloud9, whatever your switches say:\n` +
    `• You have no tools at all beyond the ones listed above. Your owner's own ` +
    `Claude Code and Codex setup — his instructions, his connected accounts, his ` +
    `shortcuts — is not loaded for you, and you should not act as if it were.\n` +
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

/**
 * The one sentence this agent is told about one switch — derived from BOTH the
 * switch and what the launcher truly supplied, never from the switch alone.
 * The default supply being empty is what makes silence honest: a caller who
 * supplies nothing gets "switched on, nothing behind it", not "you CAN".
 */
function sentenceFor(agent: AgentDef, cap: Capability, granted: Supply): string {
  if (!isOn(agent, cap.ability)) return cap.cannot;
  if (isSupplied(cap, granted)) return cap.can;
  return cap.onButNothingSupplied ?? cap.cannot;
}
