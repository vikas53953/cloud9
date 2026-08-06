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

/** The honest report for an agent running in HIS setup, built from the declared one. */
function inOwnerSetup(base: HarnessIsolation): HarnessIsolation {
  return {
    ...base,
    togglesAreTheBoundary: false,
    headline:
      "This agent is set to use your own setup, so it starts the way Claude Code or Codex "
      + "does when you run it yourself. The switches still decide its own tools, but they "
      + "are no longer the whole story — what is below arrives with your setup.",
    togglesControl: base.togglesAreTheBoundary
      ? "the agent's own tools — but not what your connected services, your instructions or "
        + "your hooks add on top"
      : base.togglesControl,
    stillLoaded: [...OWNER_SETUP_LEAKS, ...base.stillLoaded],
    measuredOn: "claude-code 2.1.222, owner-setup probe 2026-08-05",
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
