// Which harness's ability toggles are a REAL boundary — and which are not.
//
// WHY THIS FILE EXISTS. Vikas is shown four switches on an agent: search the
// web, files, schedules, background. Those switches are presented to him as the
// permission boundary. For a Claude agent that is now literally true — the
// command line DECLARES the exact tool set with `--tools`, so nothing he did
// not switch on can arrive. For a Codex agent it is NOT true, and no amount of
// flags makes it true on codex-cli 0.146.0. A screen that shows the same
// sentence for both harnesses is telling him something false about one of them.
//
// So the honest answer lives here, in the engine, as data the screen can read —
// rather than as a paragraph in a design document that the UI never sees.
//
// THE CLASS RULE. A harness may not claim its toggles are the boundary while it
// still lists something that leaks. Those two facts are one row, checked by a
// test, so the next person to add a harness cannot record an optimistic
// headline and a leak list underneath it.
//
// EVIDENCE, not belief. Every entry carries the date and CLI version it was
// measured on, by running the real thing. See the block comments below for the
// exact commands and their exact output.

/** The harnesses an agent can run on. `mock` runs no tools at all. */
export type HarnessName = "claude" | "codex" | "mock";

/** One thing the harness hands an agent that its owner never switched on. */
export interface LeakedSurface {
  /** the tool or surface as the harness itself names it */
  name: string;
  /** what it means, in words Vikas would use */
  plainWords: string;
  /** why it is still there after everything we can switch off */
  why: string;
}

export interface HarnessIsolation {
  harness: HarnessName;
  /**
   * How far the switches can be turned UP on this harness — the other half of
   * the same honesty. `togglesAreTheBoundary` says nothing can get in that he
   * did not switch on; this says whether everything the CLI can do is available
   * to be switched on. Added 2026-07-30, when Vikas said the ceiling was wrong.
   */
  ceiling: string;
  /**
   * TRUE only when the owner's ability toggles govern the agent's WHOLE tool
   * surface. False means the toggles govern something narrower — for Codex,
   * only the sandbox — and the screen must say so.
   */
  togglesAreTheBoundary: boolean;
  /** one plain sentence a screen can show under the toggles. Never shared. */
  headline: string;
  /** empty when nothing leaks; otherwise every leak, named. */
  stillLoaded: readonly LeakedSurface[];
  /** what the toggles DO control, when they do not control everything */
  togglesControl: string;
  /**
   * Things we SAW and could not settle either way. Not leaks — nothing here was
   * measured reaching an agent — but not "clean" either. A screen may ignore
   * these; a person auditing this file may not. Keeping them out of
   * `stillLoaded` is what stops the class rule below from being a lie in the
   * other direction: "we found nothing" and "we looked and could not tell" are
   * different sentences and are stored as different fields.
   */
  unknowns: readonly string[];
  /** the run this was measured on: version and date, so a stale claim is visible */
  measuredOn: string;
}

/**
 * Claude, re-measured 2026-08-05 on CLI 2.1.222 after `--safe-mode` came OFF
 * the command line (see the long block in `claude-cli.ts` for why: it was
 * killing Cloud9's own MCP doorway and the `connections` switch along with it).
 *
 * `claudeArgs` now passes `--strict-mcp-config --disable-slash-commands
 * --setting-sources ""` plus an explicit `--tools <exact set>`, and the child's
 * environment carries CLAUDE_CODE_DISABLE_AUTO_MEMORY=1. Probed live, in a
 * folder holding its own CLAUDE.md, against a throwaway MCP server:
 *   tools            → exactly the agent's own, plus Cloud9's
 *   mcp_servers      → only the one we passed in; none of the owner's 17
 *   plugins          → NONE (under `--safe-mode` the init event named SEVEN)
 *   skills / commands→ none
 *   CLAUDE.md        → neither the owner's global one nor the folder's own
 *   hooks            → did not run
 *   memory_paths     → absent
 *   the login        → still works
 */
const CLAUDE: HarnessIsolation = {
  harness: "claude",
  togglesAreTheBoundary: true,
  ceiling:
    "Everything Claude Code can do on this computer is available to switch on — " +
    "running programs, files anywhere, helper agents, connected services.",
  headline: "This agent can only use what you switched on. Nothing else reaches it.",
  stillLoaded: [],
  togglesControl: "every tool the agent has",
  unknowns: [
    // The plugin-naming unknown that stood here from 2026-07-30 is CLOSED: it was
    // an artefact of --safe-mode, and the flag set that replaced it reports no
    // plugins at all. Kept as a note rather than deleted, so the record shows the
    // measurement moved rather than the claim being quietly upgraded.
    "Admin-managed (policy) settings still apply, on this CLI, whatever we pass. " +
    "There is no such file on this machine, so this has never been observed. On a " +
    "work-managed PC it would be a real hole and Cloud9 could not close it.",
    // GAP C, measured 2026-08-05. The line above this list says the switches are
    // the whole boundary, and that is true of WHICH TOOLS EXIST — which is what
    // it claims. It is NOT true of WHERE those tools may write, and the folder
    // picker sat right beside it looking like it was. Said here so the honest
    // report is honest about its own edge. Full measurements: abilities.ts.
    "The switches decide which tools this agent has; they do not fence WHERE a " +
    "tool may write. Claude Code offers no sandbox on this route — a write outside " +
    "every folder we named went through in every permission mode we tried, and " +
    "even with a rule naming that exact file. So the folders you choose are where " +
    "this agent is pointed, not a wall around it. Switch the file tools off and it " +
    "genuinely cannot touch a file; leave them on and a real fence needs Codex.",
  ],
  measuredOn: "claude-code 2.1.222, 2026-08-05",
};

/**
 * Codex, measured 2026-07-29 on codex-cli **0.146.0** by running two real
 * `codex exec` turns that differed ONLY in the feature switches, plus offline
 * `codex debug prompt-input` renders of exactly what reaches the model.
 *
 * With `--ignore-user-config --ignore-rules` only, the model reported:
 *   tool_search_tool, functions.wait, functions.shell_command,
 *   functions.list_mcp_resources, functions.list_mcp_resource_templates,
 *   functions.read_mcp_resource, functions.update_plan,
 *   functions.request_user_input, functions.request_plugin_install,
 *   functions.view_image, functions.exec, functions.apply_patch,
 *   collaboration.{followup_task,interrupt_agent,list_agents,send_message,
 *   spawn_agent,wait_agent}, web.run, image_gen.imagegen
 * — and the CLI's own note "Skill descriptions were shortened to fit the 2%
 * skills context budget".
 *
 * With `--disable plugins apps multi_agent image_generation computer_use
 * browser_use memories hooks` added, the SAME prompt reported:
 *   functions.{wait,shell_command,update_plan,request_user_input,view_image,
 *   exec,apply_patch}, collaboration.* (6), web.run
 * — and no skills note. Six tools closed. What is below is what survived.
 */
const CODEX: HarnessIsolation = {
  harness: "codex",
  togglesAreTheBoundary: false,
  ceiling:
    "Everything Codex can do is available here. Codex cannot remove some of its " +
    "built-ins, so a Codex agent always has them and Cloud9 shows those switches " +
    "on and locked rather than offering an off that would not happen.",
  headline:
    "Codex cannot remove every built-in tool. The switches it cannot give up are " +
    "shown on and locked for a Codex agent, because that is what is true — moving " +
    "the agent to Claude is what shuts those doors.",
  togglesControl:
    "which folders it may write in, web search, and Cloud9-supplied powers",
  stillLoaded: [
    {
      name: "collaboration.spawn_agent (and 5 more collaboration tools)",
      plainWords: "Codex always carries helper-agent tools once a turn starts",
      why: "Codex cannot remove them, so the helper-agent switch is shown on and locked for a " +
        "Codex agent instead of pretending an off would remove them.",
    },
    {
      name: "web.run",
      plainWords: "Codex always carries its web tool once a turn starts",
      why: "Codex cannot remove it, so the web switch is shown on and locked for a Codex agent " +
        "instead of pretending an off would remove it.",
    },
    {
      name: "functions.exec / functions.shell_command / functions.apply_patch",
      plainWords: "Codex always carries command and file tools once a turn starts",
      why: "Codex cannot remove them, so the files and run-programs switches are shown on and " +
        "locked for a Codex agent instead of pretending an off would remove them.",
    },
  ],
  unknowns: [
    "The disposable auth clone preserves today's signed-in turn. Whether a Codex token refresh " +
    "rotates the owner's refresh token, making a later clone stale, has not been measured yet.",
  ],
  measuredOn: "codex-cli 0.146.0, locked-on switches and isolated-home tests 2026-08-01",
};

/** A mock agent runs nothing at all, so there is nothing to leak. */
const MOCK: HarnessIsolation = {
  harness: "mock",
  togglesAreTheBoundary: true,
  ceiling: "None. A stand-in agent cannot be given anything, at any setting.",
  headline: "This agent is a stand-in. It runs no tools at all.",
  stillLoaded: [],
  togglesControl: "nothing — there is no real harness behind it",
  unknowns: [],
  measuredOn: "by construction",
};

export const HARNESS_ISOLATION: Readonly<Record<HarnessName, HarnessIsolation>> = {
  claude: CLAUDE, codex: CODEX, mock: MOCK,
};

/**
 * =============================================================================
 * …AND THE SAME HONESTY, FOR AN AGENT RUNNING IN HIS OWN SETUP. (2026-08-06)
 * =============================================================================
 *
 * Every report above describes the DECLARED environment. When the owner switches
 * an agent to his own Claude Code / Codex setup (`ownersetup.ts`), the
 * reassuring sentence stops being true and MUST NOT be shown — that is exactly
 * the class of lie this file exists to prevent, arriving from a new direction.
 *
 * MEASURED, not assumed, 2026-08-05 on CLI 2.1.222. The probe passed
 * `--tools Read Grep Glob` with the switch ON:
 *   built-in tools   → still exactly Read, Grep, Glob. The switches held.
 *   ALL tools        → 127. His MCP servers arrived with 124 tools of their own,
 *                      because `--tools` governs BUILT-INS ONLY and there is no
 *                      equivalent flag for MCP tools.
 *   his CLAUDE.md    → loaded (it answered a codeword planted there)
 *   his hooks        → ran (a SessionEnd hook fired at the end of the turn)
 *
 * So for a his-setup agent the toggles are NOT the whole boundary on either
 * harness, and the leaks are named rather than summarised.
 */
const OWNER_SETUP_LEAKS: readonly LeakedSurface[] = [
  {
    name: "his connected services (MCP servers) and their tools",
    plainWords: "everything he has connected to Claude Code or Codex is connected here too",
    why: "He asked for his own setup, and his servers are part of it. Their tools are not "
      + "governed by the ability switches — measured 2026-08-05: an agent limited to three "
      + "built-in tools still arrived holding 124 more from his servers.",
  },
  {
    name: "his own written instructions (CLAUDE.md / AGENTS.md) and slash commands",
    plainWords: "the rules he wrote for himself steer this agent too",
    why: "That is the point of the switch. It also means the agent may follow an instruction "
      + "he wrote for his own coding sessions and never meant for an agent.",
  },
  {
    name: "his hooks",
    plainWords: "whatever his hook scripts do, they really run on this turn",
    why: "Hooks are programs he installed. With his setup loaded they fire on this agent's "
      + "turns exactly as they fire on his own.",
  },
];

/**
 * WHAT THE CODEX SIDE OF THE SWITCH REALLY OPENS.
 *
 * Kept separate from the Claude list above because it was learned a different
 * way and must not borrow the Claude probe's authority. What we know for Codex
 * is what `codexSetupFlags` and `codexDisabledBySetup` STOP DOING when the
 * switch is on (`ownersetup.ts`): `--ignore-user-config` and `--ignore-rules`
 * come off the line, and the four features `plugins`, `apps`, `memories` and
 * `hooks` are no longer disabled. Those names came from `codex features list`
 * on this machine at 0.146.0, so none of them is a guess about the flag set.
 *
 * What we have NOT done on Codex is the end-to-end probe that was run on Claude
 * — planting a codeword and watching it come back. So the flags are stated as
 * flags, and the thing we did not watch happen is listed under `unknowns`,
 * where "we looked and could not tell" belongs. That distinction is the whole
 * point of this file.
 */
const CODEX_OWNER_SETUP_LEAKS: readonly LeakedSurface[] = [
  {
    name: "his own Codex configuration (config.toml) and its connected apps",
    plainWords: "his Codex settings, his connected apps and their tools load here too",
    why: "With the switch on, Cloud9 stops passing `--ignore-user-config`, so his own "
      + "config.toml is read: his MCP servers, his connected apps, his chosen personality "
      + "and any orchestration policy he set for himself.",
  },
  {
    name: "his execpolicy rules (.rules)",
    plainWords: "the command rules he wrote for himself apply to this agent",
    why: "`--ignore-rules` comes off the line with the rest of the isolation, so his own "
      + "and the project's rule files decide what commands are allowed.",
  },
  {
    name: "his plugins, his saved memories and his hooks",
    plainWords: "his installed plugins, what his own sessions remembered, and his hook scripts",
    why: "These four Codex features (plugins, apps, memories, hooks) are switched OFF for a "
      + "declared agent and left ON for one running in his setup. Hooks are programs he "
      + "installed, and they really run on this agent's turns.",
  },
];

/** What we did not measure on Codex, said as its own sentence rather than claimed. */
const CODEX_OWNER_SETUP_UNKNOWNS: readonly string[] = [
  "The Claude side of this switch was probed end to end on 2026-08-05 — a planted codeword "
  + "came back, a hook fired, 124 extra tools arrived. The Codex side has NOT had that probe. "
  + "What is listed above is what Cloud9 stops switching off, read from the flags and from "
  + "`codex features list` at 0.146.0, not from watching a turn hold them.",
];

/**
 * The honest report for an agent running in HIS setup, built from the declared
 * one — PER HARNESS.
 *
 * ============================================================================
 * THE BUG THIS FIXES (2026-08-06). It used to return one answer for every
 * harness: the Claude leak list, and `measuredOn: "claude-code 2.1.222,
 * owner-setup probe 2026-08-05"`. So a CODEX agent's card carried the CLAUDE
 * app's version and the CLAUDE probe's date as the evidence for what that agent
 * could reach, and listed three Claude-shaped leaks nobody had measured on
 * Codex — on top of the three real Codex ones, which is where the "6 leaks
 * where the table has 3" came from.
 *
 * That is precisely the class of lie this whole file exists to prevent, and it
 * is worse than the lie it replaced: an unmeasured claim wearing another app's
 * measurement is harder to catch than no claim at all. A card may only ever
 * show the evidence for the app it is describing.
 * ============================================================================
 */
function inOwnerSetup(base: HarnessIsolation): HarnessIsolation {
  const claude = base.harness === "claude";
  // The agent's OWN app is named, so the sentence is about the thing on screen
  // rather than about both apps at once.
  const appName = claude ? "Claude Code" : "Codex";
  return {
    ...base,
    togglesAreTheBoundary: false,
    headline:
      `This agent is set to use your own setup, so it starts the way ${appName} does when `
      + "you run it yourself. The switches still decide its own tools, but they are no "
      + "longer the whole story — what is below arrives with your setup.",
    togglesControl: base.togglesAreTheBoundary
      ? "the agent's own tools — but not what your connected services, your instructions or "
        + "your hooks add on top"
      : base.togglesControl,
    stillLoaded: claude
      ? [...OWNER_SETUP_LEAKS, ...base.stillLoaded]
      : [...CODEX_OWNER_SETUP_LEAKS, ...base.stillLoaded],
    unknowns: claude ? base.unknowns : [...CODEX_OWNER_SETUP_UNKNOWNS, ...base.unknowns],
    // EACH CARD CARRIES ITS OWN APP'S EVIDENCE. The declared measurement is kept
    // beside the switch's own, because both are still true of this card: the
    // base report is what was measured about the app, and the second half is
    // what was measured about the switch.
    measuredOn: claude
      ? "claude-code 2.1.222, owner-setup probe 2026-08-05"
      : `${base.measuredOn}; owner-setup read from the flag set at codex-cli 0.146.0, not probed`,
  };
}

/**
 * The honest report for a harness name off the wire, or undefined if we have
 * never measured that harness. Undefined means "we do not know" — a screen must
 * NOT fall back to the reassuring sentence.
 *
 * `mode` is the agent's setup choice (`setupModeFor` in `ownersetup.ts`).
 * Omitted means the declared environment, which is what every caller written
 * before the switch existed meant — and what an agent with the switch off gets.
 * A mock agent runs nothing at all, so its report is the same either way.
 */
export function isolationFor(
  harness: string, mode: "declared" | "owner" = "declared",
): HarnessIsolation | undefined {
  const base = (HARNESS_ISOLATION as Record<string, HarnessIsolation>)[harness];
  if (!base) return undefined;
  return mode === "owner" && harness !== "mock" ? inOwnerSetup(base) : base;
}
