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
 * Claude, measured 2026-07-29. `claudeArgs` passes `--safe-mode
 * --strict-mcp-config --disable-slash-commands` and an explicit `--tools <exact
 * set>`. Re-probed after that change: the tool list was exactly the agent's own,
 * MCP servers none, slash commands none, and the login still worked.
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
    "Under --safe-mode the CLI still NAMES seven of your installed plugins in its " +
    "own start-up report, while reporting no skills, no slash commands and no " +
    "connected accounts. Nothing from them was measured reaching an agent, and the " +
    "declared tool set is the same either way — but we cannot prove they contribute " +
    "nothing, so it is written down instead of rounded off.",
    "--safe-mode documents that admin-managed (policy) settings still apply. There " +
    "is no such file on this machine, so this has never been observed. On a " +
    "work-managed PC it would be a real hole and Cloud9 could not close it.",
  ],
  measuredOn: "claude-code 2.1.220, 2026-07-30",
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
 * The honest report for a harness name off the wire, or undefined if we have
 * never measured that harness. Undefined means "we do not know" — a screen must
 * NOT fall back to the reassuring sentence.
 */
export function isolationFor(harness: string): HarnessIsolation | undefined {
  return (HARNESS_ISOLATION as Record<string, HarnessIsolation>)[harness];
}
