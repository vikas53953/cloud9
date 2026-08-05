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
//   * his own dev setup is still shut out at EVERY reach (`--strict-mcp-config`,
//     `--disable-slash-commands`, `--setting-sources ""`, `--ignore-user-config`);
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
import {
  AgentAbilities, AgentApprovals, AgentDef, REMOTE_ACTIONS, RemoteAction, mustAskBeforeActing,
} from "@cloud9/shared";

/**
 * Every built-in tool claude-code **2.1.220** has, measured on 2026-07-30 by
 * running the real command line Cloud9 ships and reading the CLI's own
 * `system/init` event:
 *
 *   claude -p --output-format stream-json --verbose --permission-mode dontAsk \
 *     --strict-mcp-config --disable-slash-commands --setting-sources "" --tools default
 *
 * RE-MEASURED 2026-08-05 on CLI 2.1.222 after `--safe-mode` came off that line
 * (see claude-cli.ts): the built-in set came back BYTE-IDENTICAL, all 31 names,
 * so this table and the denied list derived from it did not move.
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
 *  - the same probe reported seven of Vikas's **plugins** by path under
 *    `--safe-mode`. That is now moot: the flag set that replaced it on 2026-08-05
 *    reports NO plugins at all, so the `isolation.ts` unknown it caused is closed.
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
  /**
   * Codex built-ins this switch cannot remove. Cloud9 refuses to start a Codex
   * turn when one of these switches is off: refusing the turn is the only real
   * gate codex-cli offers when it cannot declare or subtract the tool.
   */
  codexUnavoidableTools?: string[];
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
  /**
   * THE FOURTH FACE, and the one this whole file existed for without having.
   *
   * 2026-08-05, in his words: "cloud9 is not able to access my pc… when I say
   * from a chat 'go and read this file on my PC' it is always saying I do not
   * have access to this folder." Every link of the chain was correct. The
   * `wholeComputer` switch was OFF on the agent he was talking to (`Architect`),
   * and ON-with-no-folders on the newest one (`Fable5`) — so the honest answer
   * really was "I cannot". His run record has the agent's exact words: "I can't
   * run commands or reach files outside this directory."
   *
   * That sentence is TRUE and USELESS. It ends the conversation with a wall and
   * never says the wall has a door, where the door is, or that he — the owner,
   * sitting right there — opens it in ten seconds. He read it as the app being
   * broken, which from where he sits is the only reasonable reading.
   *
   * So a row that says CANNOT must, in the same breath, say HOW. These are the
   * literal steps on the literal screen, in his words, and they live on the row
   * beside the `cannot` they answer — for the same reason every other face does:
   * a switch whose refusal has no fix attached is now impossible to add, because
   * there is nowhere to write the refusal except next to the fix.
   */
  fixItInApp: string;
  /**
   * THE ONE ROW A BRAND-NEW AGENT DOES NOT GET, and the reason written beside it.
   *
   * Every other row is ON the moment an agent exists (see `NEW_AGENT_ABILITIES`).
   * A row may only opt out of that by proving it grants NOTHING until the owner
   * hands over something THIS APP CANNOT PRODUCE — today that is `connections`,
   * whose whole surface arrives as a config file written by whoever made the
   * outside tool. Switching it on by default would put "on with nothing behind
   * it" on every agent he owns, for ever, which is the exact half-state this
   * file exists to kill. `wholeComputer` also needs something supplied and is
   * still on by default, because the app CAN supply it honestly: his real home
   * folder, resolved on this machine and shown to him.
   */
  offForNewAgents?: true;
  /** why this row is off for a new agent, in his words. Required when it is. */
  whyOffForNewAgents?: string;
}

/**
 * THE ONE PRESS, and the only route any refusal is ever allowed to name.
 *
 * It used to be six discoveries: crew list → the agent → Edit → the reach
 * section → two switches → a box that only appears after the second one. He did
 * four of them, stopped, and his agent told him it could not reach his PC. So
 * every `fixItInApp` below is built from this one sentence: there is now no way
 * to write a limit in this table that points at a longer path, because the
 * function that writes them only knows this one.
 */
const ONE_PRESS =
  "press “Work on my computer, like Claude Code” in my editor (the ✎ next to my " +
  "name in this room, or on my card in the crew list)";

/** The fix sentence for one row: name the switch, name the one press, stop. */
function onePressFix(label: string, extra = ""): string {
  return `${ONE_PRESS}. That single press switches on “${label}” along with everything ` +
    `else this app can do on this computer — there is no second step to find.${extra}`;
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
 *
 * WHY `connections` IS LAST, moved there 2026-08-05. It reaches OUTSIDE this
 * computer — real accounts, somebody else's servers — which is the furthest any
 * row goes, so on the danger ordering it belongs at the end. And putting it
 * there buys the thing that made a new agent read honestly: what a brand-new
 * agent gets (every row the app can really grant) is now a PREFIX of this table
 * like every rung is, so it IS a rung — "Work on my computer, like Claude Code"
 * — instead of a mixture no rung could describe. Nothing else moved, so the
 * rungs below it grant exactly what they granted before.
 */
export const CAPABILITIES: readonly Capability[] = [
  {
    ability: "webSearch",
    label: "Look things up on the web",
    claudeTools: ["WebSearch", "WebFetch"],
    opensCodexWebSearch: true,
    codexUnavoidableTools: ["web.run"],
    fixItInApp: onePressFix("Look things up on the web"),
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
    codexUnavoidableTools: ["functions.exec", "functions.shell_command", "functions.apply_patch"],
    fixItInApp: onePressFix("Keep and change files in its own folder"),
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
    codexUnavoidableTools: ["collaboration.spawn_agent", "collaboration.*"],
    fixItInApp: onePressFix("Get help from its own helper agents"),
    can: "You CAN hand parts of a job to helper agents of your own and wait for what they " +
      "find, instead of doing every step yourself in one long answer.",
    cannot: "You CANNOT hand work to helper agents — whatever you do, you do yourself in " +
      "this one answer.",
  },
  {
    ability: "schedules",
    label: "Check in on a repeating schedule",
    claudeTools: ["ScheduleWakeup", "CronCreate", "CronList", "CronDelete"],
    fixItInApp: onePressFix("Check in on a repeating schedule"),
    can: "You CAN be given a repeating check-in, so your owner can ask you to do something " +
      "every day or every few minutes without asking again each time.",
    cannot: "You CANNOT be given a repeating check-in.",
  },
  {
    ability: "background",
    label: "Work on jobs in the background",
    claudeTools: ["EnterWorktree", "ExitWorktree", "RemoteTrigger", "PushNotification"],
    fixItInApp: onePressFix("Work on jobs in the background"),
    can: "You CAN be handed a job to work on in the background and report back on when it " +
      "is finished, instead of answering in one go.",
    cannot: "You CANNOT be handed background jobs — you answer in the conversation only.",
  },
  {
    ability: "wholeComputer",
    label: "Reach files outside its own folder",
    claudeTools: [],
    widensBeyondOwnFolder: true,
    alwaysAsk: true,
    needsSupply: "wholeComputerRoots",
    fixItInApp: onePressFix(
      "Reach files outside its own folder",
      " It opens “Choose a folder” in the same breath, so I am never allowed out of my own "
      + "folder with nowhere to go — and a new agent already starts with your home folder, so "
      + "there is usually nothing to do at all."),
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
    codexUnavoidableTools: ["functions.exec", "functions.shell_command"],
    alwaysAsk: true,
    fixItInApp: onePressFix(
      "Run programs on this computer",
      " You are still asked before I actually run anything."),
    can: "You CAN run programs and commands on this computer, the same way Claude Code and " +
      "Codex do. Because that changes his machine, your owner is asked first — say what " +
      "you intend to run and wait, rather than promising it is already done.",
    cannot: "You CANNOT run programs, shell scripts or terminal commands.",
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
    offForNewAgents: true,
    whyOffForNewAgents:
      "A connected service is an outside account, and the only thing that can switch it on "
      + "for real is a small file written by whoever made that service. Cloud9 cannot invent "
      + "one. Switching this on for every new agent would put “allowed, nothing connected” on "
      + "every card you own — a promise the app cannot keep. Most people never need it; when "
      + "you do, it is one press away in the same place as everything else.",
    fixItInApp: onePressFix(
      "Use connected services your owner picked for you",
      " Connected services are the one thing that needs a second action afterwards: press "
      + "“Choose the file” in the box that appears and point me at the connections file "
      + "whoever made that service gave you. Nothing but that file can switch it on."),
    can: "You CAN use the connected services your owner set up for you specifically. Those " +
      "are real accounts, so your owner is asked before you act through them.",
    cannot: "You CANNOT use any connected service or outside account.",
    onButNothingSupplied:
      "You CANNOT use any connected service right now. Your owner has allowed it, but this " +
      "computer has not given you one — no service is connected for you on this turn, and " +
      "no tool for one is in your hands. Say that plainly if you are asked; do not promise " +
      "work through an account you cannot reach.",
  },
] as const;

/**
 * The ladder Vikas actually picks from. Plain words, each rung everything below
 * it plus more — from "answer questions only" to "everything this app can do on
 * this computer".
 *
 * It is NOT a second source of truth: a rung is a PREFIX of the table above, so
 * a new capability row automatically lands on the rungs its position implies and
 * there is nowhere to forget it.
 *
 * `mypc` was added on 2026-08-05 and is WHAT EVERY NEW AGENT IS. It exists
 * because the default had to be describable: a set of switches that is not a
 * rung is drawn as "your own mixture", and every agent he made would have opened
 * its file saying that. It is the whole table except the one row nobody but he
 * can supply — and `fullreach.test.ts` holds it to `NEW_AGENT_ABILITIES`, so the
 * rung and the default cannot come to mean different things.
 */
export type Reach = "talk" | "look" | "work" | "mypc" | "computer";

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
    level: "mypc",
    label: "Work on my computer, like Claude Code",
    plainWords:
      "What every new agent starts with: running programs, your files, helper agents. " +
      "Anything that changes your machine asks you first.",
    // every row the app can really hand over — see `capabilitiesForNewAgent`
    rows: CAPABILITIES.filter(c => !c.offForNewAgents).length,
  },
  {
    level: "computer",
    label: "Everything this app can do on this computer",
    plainWords:
      "The rung above plus connected services — outside accounts you point it at with a file. " +
      "Most people never need this one.",
    rows: CAPABILITIES.length,
  },
] as const;

/** A whole switch set from a list of rows: on for these, off for every other. */
function abilitiesOf(rows: readonly Capability[]): AgentAbilities {
  const on = new Set(rows.map(c => c.ability));
  const abilities: AgentAbilities = {
    webSearch: false, files: false, schedules: false, background: false,
  };
  for (const cap of CAPABILITIES) {
    (abilities as unknown as Record<string, boolean>)[cap.ability] = on.has(cap.ability);
  }
  return abilities;
}

/** The switches a rung turns on. The only place a rung becomes abilities. */
export function abilitiesForReach(level: Reach): AgentAbilities {
  const rung = REACH_LEVELS.find(l => l.level === level) ?? REACH_LEVELS[0];
  return abilitiesOf(CAPABILITIES.slice(0, rung.rows));
}

/* ===========================================================================
 * FULLY CAPABLE THE SECOND IT EXISTS — 2026-08-05, his instruction, repeated
 * and finally in anger.
 *
 * "make cloud9 fully agentic"… "an agent can perform any task like codex or
 * claude code"… "don't teach me". And still, the agent he had just made was
 * answering him: "What I can't do: run git, npm, or build commands; create
 * branches; push PRs; or delegate the work to other agents. Those need switches
 * you'd have to turn on."
 *
 * IT WAS TELLING THE TRUTH. A new agent started on a SUBSET — web search, its
 * own folder, schedules, background jobs — so the first thing every agent he
 * made did was explain what it was not. He does not want to flip switches. He
 * wants what Claude Code is on the day you install it.
 *
 * WHY THIS IS SAFE, AND NOT RECKLESS. Three things, none of which this change
 * touches:
 *   1. THE APPROVAL CARD. Every row that changes his machine or spends money
 *      carries `alwaysAsk`; `approvalsFor()` forces the approval ON whenever the
 *      switch is on, and no stored (or forged) agent definition can turn it off.
 *      Power arrives; the hand on the door does not move.
 *   2. OWNER-ONLY DRIVING. `mayDriveAgent` still means nobody but him can set
 *      one of his agents working unless he says otherwise, so a capable agent is
 *      a capable agent OF HIS.
 *   3. THE TOOLS ARE STILL DECLARED PER TURN. `--tools` names the exact set and
 *      `--disallowed-tools` spells out everything else, and his own Claude Code
 *      setup — his CLAUDE.md, his slash commands, his MCP servers, his hooks —
 *      is shut out at every reach by the isolation flags. "Fully capable" never
 *      means "running as him with his configuration".
 *
 * ONE ROW IS OFF, and it is the honest kind of off: see `offForNewAgents`.
 * =========================================================================== */

/** The rows a brand-new agent is given. Everything the app can really grant. */
export function capabilitiesForNewAgent(): Capability[] {
  return CAPABILITIES.filter(c => !c.offForNewAgents);
}

/**
 * WHAT A BRAND-NEW AGENT STARTS WITH — one owner for the answer, and it is the
 * table, so a capability added tomorrow is granted the day it is written rather
 * than the day somebody remembers a second list.
 *
 * The desktop's editor and the casting room both read THIS. There is no
 * hand-typed default anywhere in Cloud9 any more.
 */
export const NEW_AGENT_ABILITIES: AgentAbilities = abilitiesOf(capabilitiesForNewAgent());

/**
 * IS THIS AGENT ALREADY AS CAPABLE AS A NEW ONE?
 *
 * Asked of the STORED switches, because that is what the one-press upgrade would
 * write. A Codex agent whose app forces rows on is still counted as missing them
 * if they are not stored on — pressing the button then stores what was already
 * true, which is the honest direction.
 */
export function hasFullReach(
  agent: Pick<AgentDef, "abilities" | "wholeComputerRoots">, homeFolder?: string,
): boolean {
  const stored = (agent.abilities ?? {}) as AgentAbilities;
  if (capabilitiesForNewAgent().some(c => stored[c.ability] !== true)) return false;
  // "allowed out of its own folder with nowhere to go" is not full reach either
  if (homeFolder && storedRootCount(agent) === 0) return false;
  return true;
}

function storedRootCount(agent: Pick<AgentDef, "wholeComputerRoots">): number {
  const said = Array.isArray(agent.wholeComputerRoots) ? agent.wholeComputerRoots : [];
  return said.filter(r => typeof r === "string" && r.trim().length > 0).length;
}

/**
 * THE AGENTS HE ALREADY HAS THAT ARE STUCK BELOW A NEW ONE.
 *
 * He has six (Architect, sonnet, Opus, Sol, terra, Fable5) made before the
 * defaults changed. Nothing rewrites them behind his back — this only answers
 * "who would the one press change", so the screen can name them and count them
 * before he presses anything.
 */
export function agentsWithoutFullReach<T extends Pick<AgentDef, "abilities" | "wholeComputerRoots">>(
  agents: readonly T[], homeFolder?: string,
): T[] {
  return agents.filter(a => !hasFullReach(a, homeFolder));
}

/**
 * ONE AGENT, BROUGHT UP TO WHAT A NEW ONE GETS — the whole of the one press.
 *
 * IT ONLY EVER ADDS. A switch he turned on that a new agent does not get
 * (`connections`) stays on; a folder he chose stays chosen and is never replaced
 * by the home folder. There is no path through this function that takes
 * something away, which is what makes "do it to all six at once" a safe thing to
 * offer.
 *
 * `changed` is the truth about THIS agent, so the caller can send nothing at all
 * for an agent that already had everything — never a save that looks like a
 * change and is not.
 */
export function bringUpToFullReach<T extends AgentDef>(
  agent: T, homeFolder?: string,
): { agent: T; changed: boolean } {
  const stored = { ...((agent.abilities ?? {}) as AgentAbilities) };
  let changed = false;
  for (const cap of capabilitiesForNewAgent()) {
    if (stored[cap.ability] !== true) { changed = true; }
    (stored as unknown as Record<string, boolean>)[cap.ability] = true;
  }
  const roots = (Array.isArray(agent.wholeComputerRoots) ? agent.wholeComputerRoots : [])
    .filter(r => typeof r === "string" && r.trim().length > 0);
  const home = typeof homeFolder === "string" ? homeFolder.trim() : "";
  const nextRoots = roots.length > 0 ? roots : (home ? [home] : []);
  if (nextRoots.length !== roots.length) changed = true;
  return {
    agent: {
      ...agent,
      abilities: stored,
      ...(nextRoots.length > 0 ? { wholeComputerRoots: nextRoots } : {}),
    },
    changed,
  };
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

/**
 * Is this switch on for this agent? Absent always means off — and the agent's
 * APP has the last word, because a switch its app cannot honour is not a switch.
 *
 * EVERY function in this file asks this one, which is what makes
 * `effectiveAbilities` a single owner rather than a patch applied per call site:
 * the tools, the sandbox, the prompt sentences, the ladder and the approvals all
 * come out of the same answer.
 */
function isOn(agent: Pick<AgentDef, "provider" | "abilities">, ability: keyof AgentAbilities): boolean {
  return effectiveAbilities(agent)[ability] === true;
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

/** Codex capability rows whose built-ins cannot be removed by codex-cli. */
export function codexUnavoidableCapabilities(): Capability[] {
  return CAPABILITIES.filter(c => (c.codexUnavoidableTools?.length ?? 0) > 0);
}

/**
 * THE ROWS THIS AGENT'S APP SWITCHES ON WHETHER OR NOT ITS OWNER DID.
 *
 * Empty for a Claude agent: `--tools` declares the exact set, so an off switch
 * really does remove the tool. For a Codex agent it is the rows above, because
 * codex-cli 0.146.0 has no way to declare or subtract its built-ins.
 */
export function forcedOnCapabilities(agent: Pick<AgentDef, "provider">): Capability[] {
  return (agent.provider ?? "claude") === "codex" ? codexUnavoidableCapabilities() : [];
}

/** The sentence a locked-on switch carries on a screen. Plain words, no jargon. */
export const FORCED_ON_NOTE = "Always on with Codex — its program cannot give this up.";

/**
 * WHAT THIS AGENT CAN ACTUALLY DO — THE ONE OWNER OF THAT QUESTION.
 *
 * THE BUG THIS EXISTS TO MAKE IMPOSSIBLE. Every Codex agent saved before the
 * fail-closed rule landed refused to run: "Codex did not start because Get help
 * from its own helper agents, Run programs on this computer are switched off,
 * but this harness cannot remove the matching built-in tools." The app was
 * happily holding, showing and saving a state the engine would ALWAYS refuse.
 * The contradiction was never in Codex — it was that the app let those switches
 * be off for an agent whose app cannot honour an off.
 *
 * So the app no longer represents that state at all. An agent running on Codex
 * HAS the web, file, helper-agent and command tools, so this is what everything
 * reads: the command line, the sandbox, the prompt, the reach ladder, the
 * approvals and the screen. Nothing computes its own answer beside it.
 *
 * READ TIME, NOT MIGRATION TIME. The stored switches are left exactly as they
 * were, so moving an agent back to Claude gives him back the switches he set.
 * Nothing is rewritten in the database to make this true.
 *
 * HONEST, NOT CONVENIENT. Showing these as ON is the truthful direction: Codex
 * genuinely holds those tools at every setting. Showing them OFF was the tick
 * that was not true.
 */
export function effectiveAbilities(
  agent: Pick<AgentDef, "provider" | "abilities">,
): AgentAbilities {
  const stored = { ...(agent.abilities ?? {}) } as AgentAbilities;
  for (const cap of forcedOnCapabilities(agent)) {
    (stored as unknown as Record<string, boolean>)[cap.ability] = true;
  }
  return stored;
}

/**
 * The same agent, with the abilities its app really gives it. For the callers
 * that must hand a whole definition onward (the Codex command line builder) —
 * so they read the effective answer once, at the top, instead of remembering to
 * ask per line.
 */
export function withEffectiveAbilities<T extends Pick<AgentDef, "provider" | "abilities">>(
  agent: T,
): T {
  return { ...agent, abilities: effectiveAbilities(agent) };
}

/**
 * THE SWITCHES THIS AGENT HAS ON THAT ARE NOTHING WITHOUT SOMETHING SUPPLIED.
 *
 * A row with `needsSupply` grants no tool by itself: it only says the launcher
 * MAY hand something over. A way of running an agent that can never hand it over
 * is a way of running that agent in which the switch is permanently inert — and
 * the owner cannot see that from the editor, which reads the switch and says
 * "In use". `SdkProvider` asks this and refuses the turn rather than running one
 * that quietly cannot do what he set it to do (see the class comment there).
 *
 * DERIVED FROM THE TABLE, so it is a CLASS and not a case. The trap was found on
 * `wholeComputer`; `connections` had it too and would have been fixed separately
 * or not at all. Any future row that needs something supplied is covered the day
 * it is added, because there is nowhere to add it except the table this reads.
 */
export function switchesNeedingSupply(agent: AgentDef): Capability[] {
  return CAPABILITIES.filter(c => c.needsSupply && isOn(agent, c.ability));
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
 *
 * WHAT THIS IS **NOT**, since 2026-08-05. This says which approvals BELONG to
 * this agent's powers. It does not say whether a given job or action will
 * actually stop — that is `decideAsking` in shared, which also reads his
 * per-agent trust setting. The forcing here is deliberately left absolute: a
 * stored `commands: false` still cannot make an ability that changes the machine
 * claim it needs no approval. The owner turns the asking down by choosing a
 * trust setting in his own editor, out loud and per agent — never by a value
 * appearing in `agent.approvals`.
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
  // HIS TRUST SETTING IS PART OF THE ANSWER, not a separate note further down
  // the page. The editor draws this list under "you'll be asked before it", so a
  // list that ignored the setting would tell him he is about to be interrupted
  // by the very thing he just switched off — the same class of lie as a switch
  // that says "In use" while the command line never carries it.
  //
  // It asks the ONE rule (`decideAsking`, in shared) per ability rather than
  // re-deriving the trust logic here, so this list cannot come to mean something
  // different from what actually happens.
  return CAPABILITIES
    .filter(c => c.alwaysAsk && isOn(agent, c.ability)
      && mustAskBeforeActing({ abilities: { [c.ability]: true }, trust: agent.trust }))
    .map(c => c.label);
}

/**
 * THE ACTIONS THAT STILL STOP AND ASK HOWEVER MUCH HE TRUSTS THIS AGENT.
 *
 * Everything on the shared `REMOTE_ACTIONS` table, in plain words, filtered
 * through the same one rule — so under "ask me only before something leaves this
 * computer" the editor can list exactly what that means (push, pull request,
 * issue, comment, review, checkout, resolve) instead of him having to take the
 * sentence on faith, and under "don't ask me" it correctly lists nothing.
 */
export function describeRemoteAsks(agent: Pick<AgentDef, "trust">): string[] {
  return (Object.keys(REMOTE_ACTIONS) as RemoteAction[])
    .filter(action => mustAskBeforeActing({ trust: agent.trust }, { remoteAction: action }))
    .map(action => REMOTE_ACTIONS[action]);
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
export function renderCapabilities(
  agent: AgentDef, granted: Supply = {}, harness: "declared" | "codex" = "declared",
): string {
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
    (harness === "codex"
      ? `• You run on Codex, and Codex cannot give up these built-in tools: ` +
        `${codexUnavoidableCapabilities().map(c => c.label.toLowerCase()).join("; ")}. ` +
        `They are yours whatever the switches were set to, and this list says so above ` +
        `rather than pretending an off switch removed them.\n`
      : `• You have no tools at all beyond the ones listed above.\n`) +
    `• Your owner's own Claude Code and Codex setup — his instructions, his connected ` +
    `accounts, his shortcuts — is not loaded for you, and you should not act as if it were.\n` +
    `• You do not remember past conversations. What you have is the recent messages ` +
    `below` + (isOn(agent, "files")
      ? `, plus whatever you have written into your own folder.\n`
      : ` — and nothing else. Do not claim to remember things you cannot.\n`) +
    (hasSkills
      ? `• The skills listed below are standing instructions your owner wrote for you. ` +
        `They are part of what you are, not a suggestion from the conversation.\n`
      : "") +
    `\nWhen someone asks what you can do, answer from this list. Do not tell them you ` +
    `cannot do something that is switched on above.\n` +
    `\nAND NEVER STOP AT "I CANNOT". Every limit above is a switch your OWNER controls, and ` +
    `he is the person you are talking to. If he asks you for something a switch would give ` +
    `you — a file somewhere else on this computer, a command to run, a service to reach — ` +
    `say plainly that you cannot do it YET, and in the same message give him the exact steps ` +
    `from the line above that says so. Naming the switch and where to find it is part of the ` +
    `answer, not an extra. A bare refusal reads to him as this app being broken, and it is ` +
    `not — it is a switch nobody has turned on.\n`
  );
}

/**
 * The one sentence this agent is told about one switch — derived from BOTH the
 * switch and what the launcher truly supplied, never from the switch alone.
 * The default supply being empty is what makes silence honest: a caller who
 * supplies nothing gets "switched on, nothing behind it", not "you CAN".
 */
function sentenceFor(agent: AgentDef, cap: Capability, granted: Supply): string {
  if (!isOn(agent, cap.ability)) return `${cap.cannot} ${fixSentence(cap)}`;
  if (isSupplied(cap, granted)) return cap.can;
  return `${cap.onButNothingSupplied ?? cap.cannot} ${fixSentence(cap)}`;
}

/**
 * THE DOOR, said in the same breath as the wall.
 *
 * Attached to EVERY refusal rather than to the one row that burned him, because
 * "I cannot, and I will not tell you how to change that" is the shape of the
 * fault — `wholeComputer` is only where he happened to meet it. There is now no
 * way to write a `cannot` in this table without a `fixItInApp` beside it, so the
 * next switch cannot repeat this.
 */
function fixSentence(cap: Capability): string {
  return `If your owner wants that, do not leave him at a dead end — tell him, in these words: ` +
    `to let me do this, ${cap.fixItInApp}`;
}
