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
  headline: "This agent can only use what you switched on. Nothing else reaches it.",
  stillLoaded: [],
  togglesControl: "every tool the agent has",
  measuredOn: "claude-code, 2026-07-29",
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
  headline:
    "These switches control what this agent may CHANGE on your PC. They do not " +
    "control every tool it holds — Codex does not let us take the rest away yet.",
  togglesControl: "the sandbox: which folders the agent may write in, and whether it may search the web",
  stillLoaded: [
    {
      name: "collaboration.spawn_agent (and 5 more collaboration tools)",
      plainWords: "it can start further agents of its own and talk to them",
      why: "`--disable multi_agent` was tried on a live turn and the tools were still " +
        "there. `-c agents.max_depth=0` does not help either: the CLI refuses the value " +
        "outright (\"agents.max_depth must be at least 1\"). Codex has no `--tools`.",
    },
    {
      name: "web.run",
      plainWords: "it can read web pages even with 'search the web' switched off",
      why: "`-c tools.web_search=false` is the CLI's own switch and the tool was still " +
        "present on a live turn. It is set anyway, because it is the only switch there is.",
    },
    {
      name: "functions.exec / functions.shell_command / functions.apply_patch",
      plainWords: "it can run commands and change files",
      why: "Codex has no way to remove them. What stops them is the sandbox " +
        "(`-s read-only` unless the files switch is on) — a fence, not an absence.",
    },
    {
      name: "your Codex skills",
      plainWords: "standing instructions you wrote for yourself are read by this agent too",
      why: "Skills load from `$CODEX_HOME/skills` AND from `~/.agents/skills`. There is no " +
        "config key to turn them off (`skills.enabled=false` was measured to do nothing), " +
        "and pointing CODEX_HOME elsewhere signs the agent out — `codex login status` " +
        "reported \"Not logged in\" against a fresh CODEX_HOME. `~/.agents/skills` is not " +
        "under CODEX_HOME at all and stayed loaded regardless.",
    },
  ],
  measuredOn: "codex-cli 0.146.0, 2026-07-29",
};

/** A mock agent runs nothing at all, so there is nothing to leak. */
const MOCK: HarnessIsolation = {
  harness: "mock",
  togglesAreTheBoundary: true,
  headline: "This agent is a stand-in. It runs no tools at all.",
  stillLoaded: [],
  togglesControl: "nothing — there is no real harness behind it",
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
