// WHOSE SETUP DOES THIS AGENT RUN IN — the owner's own, or a declared one?
//
// ONE OWNER FOR THE DECISION. Until now the answer was spread across four
// constants in two files: `CLAUDE_ISOLATION_FLAGS` and `CLAUDE_ISOLATION_ENV` in
// `claude-cli.ts`, `CODEX_ISOLATION_FLAGS` and `CODEX_ALWAYS_DISABLED` in
// `codex.ts`. Two harnesses, two lists, no shared rule — so "does an agent get
// his CLAUDE.md" had two answers that only agreed by hand. They now live HERE,
// and both harnesses ask THIS file the same question about the same agent. A
// flag a future CLI adds lands in one place, and the two paths cannot drift.
//
// WHY THE SWITCH EXISTS AT ALL. Cloud9's original law was that an agent runs in
// a DECLARED environment: no CLAUDE.md, no slash commands, no MCP servers, no
// plugins, no hooks, no auto-memory. The reasons were good ones — reproducible
// behaviour on any machine, and "an agent may do everything Codex can do" was
// never "an agent may be me". Vikas has asked, repeatedly and explicitly, for
// the opposite: he wants his agents to have what he has. That is his call to
// make about his own machine, so it is a SWITCH, not a new law — and the old
// behaviour is still exactly what happens when the switch is off.
//
// WHAT IT COSTS, and it is said once, in the words a screen shows him: with his
// setup loaded, the same agent behaves differently on someone else's computer,
// his own written instructions steer it, his hook scripts really run, and every
// turn carries a much bigger prompt. Measured on this machine, 2026-08-05, CLI
// 2.1.222 — the same probe run twice, differing ONLY in these flags:
//
//                                switch OFF          switch ON
//   his CLAUDE.md                not loaded          LOADED (answered the codeword)
//   his MCP servers              0                   17 (4 connected, 13 need auth)
//   his slash commands           0                   132–147
//   his skills                   0                   100
//   his plugins                  0                   7
//   his hooks                    did not run         RAN (SessionEnd fired)
//   a project slash command      "Unknown command"   ran, answered SLASHOK-4417
//   prompt for one tiny turn     6,030 tokens        87,498 tokens  (~14.5x)
//   cost of that one tiny turn   $0.0055             $1.75
//
// TWO THINGS ARE NOT INHERITED, AT EITHER SETTING, and they are not negotiable
// here — see `NEVER_INHERITED` at the bottom for the argument in full:
//   1. his stored API credentials. `envWithoutCredentials` strips them from the
//      child's environment in BOTH modes. Inheriting an environment is not the
//      same as inheriting a way to bill him.
//   2. anything that lets an agent act as HIM to a third party with no approval
//      card — driving his signed-in browser or his actual desktop.
import { AgentDef } from "@cloud9/shared";
import { EMPTY_ARG } from "./run.js";

/** Just enough of an agent to answer the question. */
export type SetupChoice = Pick<AgentDef, "useOwnerSetup"> | undefined;

/**
 * `"declared"` — Cloud9 builds the environment and nothing of the owner's
 * reaches the agent. `"owner"` — the harness starts the way it does when he runs
 * it himself.
 */
export type SetupMode = "declared" | "owner";

/**
 * IS THIS AGENT RUNNING IN HIS SETUP?
 *
 * ABSENT MEANS NO, and that is load-bearing. Every agent already on this machine
 * was saved before this switch existed; if absence meant "yes" they would all
 * quietly gain his instructions, his hooks and a 14x prompt the next time they
 * spoke, without him touching anything. A new agent is given the switch as a
 * REAL STORED VALUE by the editor at the moment it is created
 * (`NEW_AGENT_USE_OWNER_SETUP`, in @cloud9/shared) — exactly the way `trust`
 * does it, and for exactly the same reason.
 *
 * Read from what is STORED about the agent, never from a frame that arrived.
 */
export function usesOwnerSetup(agent: SetupChoice): boolean {
  return agent?.useOwnerSetup === true;
}

export function setupModeFor(agent: SetupChoice): SetupMode {
  return usesOwnerSetup(agent) ? "owner" : "declared";
}

// ------------------------------------------------------------------- Claude

/**
 * THE DECLARED ENVIRONMENT FOR CLAUDE. Moved here from `claude-cli.ts` unchanged;
 * the long measurement note that used to sit above it is still in that file,
 * beside `claudeArgs`, because it explains why `--safe-mode` is NOT on the line.
 *
 *  - `--strict-mcp-config`      only the servers Cloud9 passes in may exist
 *  - `--disable-slash-commands` his skills and commands do not load
 *  - `--setting-sources ""`     an EMPTY list: no user, project or local
 *                               settings, and on this CLI that also stops
 *                               CLAUDE.md and plugins loading
 *
 * `EMPTY_ARG` is the one way to put a real `""` on a command line through
 * `run.ts`; a bare empty string would vanish and let `--setting-sources` swallow
 * the next flag.
 */
export const CLAUDE_ISOLATION_FLAGS = [
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--setting-sources", EMPTY_ARG,
] as const;

/**
 * THE ISOLATION THAT IS NOT A FLAG. `--setting-sources ""` leaves the CLI's
 * auto-memory folder on (it shows up as `memory_paths` in the init event) and
 * there is no flag for it — the CLI reads this environment variable. Cloud9
 * already owns the child's environment, so it rides there.
 */
export const CLAUDE_ISOLATION_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
};

/**
 * The isolation flags for THIS agent — the whole list, or none of it.
 *
 * There is no half-way. A flag left on in "his setup" mode would be Cloud9
 * deciding which parts of his own configuration he is allowed to have, which is
 * the opposite of what the switch is for.
 *
 * WHAT DOES *NOT* CHANGE with the switch, on purpose: `--tools`, `--allowed-tools`
 * and `--disallowed-tools`. Those are the ability toggles he set on this agent —
 * a different question from whose configuration is loaded. Measured 2026-08-05:
 * with the switch ON and `--tools Read Grep Glob`, the built-in set was still
 * exactly those three. His MCP servers' tools DO arrive alongside them (127 tools
 * in that init event), because `--tools` governs built-ins only — that is the
 * honest cost of asking for his connected services, and it is recorded in
 * `isolation.ts` rather than papered over.
 */
export function claudeSetupFlags(agent: SetupChoice): readonly string[] {
  return usesOwnerSetup(agent) ? [] : CLAUDE_ISOLATION_FLAGS;
}

/** The isolation environment for THIS agent. Empty when it runs in his setup. */
export function claudeSetupEnv(agent: SetupChoice): Readonly<Record<string, string>> {
  return usesOwnerSetup(agent) ? {} : CLAUDE_ISOLATION_ENV;
}

// -------------------------------------------------------------------- Codex

/**
 * THE DECLARED ENVIRONMENT FOR CODEX. Moved here from `codex.ts` unchanged.
 *  - `--ignore-user-config` does not load his `config.toml` — his MCP servers,
 *    feature switches, personality and injected orchestration policy. It says
 *    "auth still uses CODEX_HOME", so the login survives.
 *  - `--ignore-rules` does not load his or the project's execpolicy `.rules`.
 */
export const CODEX_ISOLATION_FLAGS = ["--ignore-user-config", "--ignore-rules"] as const;

/**
 * HIS OWN SETUP, IN CODEX'S OWN FEATURE NAMES. Every one of these is a door into
 * something he configured: his installed plugins, his connected apps, the
 * memories his own sessions wrote, his hook scripts. They are off in the declared
 * environment and ON when he asks for his setup — that is what the switch means.
 *
 * Names came from `codex features list` on this machine at 0.146.0, so none can
 * be a typo the CLI silently ignores.
 */
export const CODEX_OWNER_SETUP_FEATURES = [
  "plugins",   // his installed plugins + functions.request_plugin_install
  "apps",      // his connected apps and their MCP tools
  "memories",  // memories written by his own sessions
  "hooks",     // his hook scripts
] as const;

/**
 * OFF AT EVERY SETTING, AND THIS IS THE ARGUED PART.
 *
 * `computer_use` drives his actual desktop and `browser_use` drives his actual
 * signed-in browser. Those are not "his configuration" — they are a way for an
 * agent to act AS HIM to a third party, in a session where he is already logged
 * in, with no approval card in front of it. That is precisely the one thing this
 * switch was told not to hand over, so it does not, and the switch being on does
 * not quietly become permission for it.
 *
 * `image_generation` is neither configuration nor impersonation; it is simply a
 * Codex feature Cloud9 has never offered. Turning it on as a side effect of a
 * switch about *whose settings load* would be a second decision smuggled inside
 * the first, so it stays where it was. If he wants it, it should arrive as its
 * own switch with its own sentence.
 */
export const CODEX_NEVER_ENABLED = [
  "image_generation",
  "computer_use",
  "browser_use",
] as const;

/**
 * KEPT FOR EVERY EXISTING CALLER AND TEST: the full always-off list as it was
 * before the switch existed — which is exactly what a declared-environment agent
 * still gets today.
 */
export const CODEX_ALWAYS_DISABLED = [
  ...CODEX_OWNER_SETUP_FEATURES,
  ...CODEX_NEVER_ENABLED,
] as const;

/** The isolation flags for THIS agent — all of them, or none. */
export function codexSetupFlags(agent: SetupChoice): readonly string[] {
  return usesOwnerSetup(agent) ? [] : CODEX_ISOLATION_FLAGS;
}

/**
 * The features switched off for THIS agent by the setup choice alone. The
 * capability toggles add their own on top (`codexDisabledFeaturesFor`).
 */
export function codexDisabledBySetup(agent: SetupChoice): readonly string[] {
  return usesOwnerSetup(agent) ? CODEX_NEVER_ENABLED : CODEX_ALWAYS_DISABLED;
}

/**
 * DOES THIS AGENT GET A ONE-TURN HOME?
 *
 * The disposable `CODEX_HOME`/`HOME` is how the declared environment closes the
 * two skill roots the CLI has no flag for, and it carries the `-p
 * cloud9-isolated` profile that disables them by exact path. In his setup mode
 * there is no throwaway home, so there is no such profile either — passing `-p`
 * for a profile that does not exist would fail the turn before the model was
 * reached. One answer, read by `codexArgs` (for the `-p`) and by
 * `createCodexIsolatedEnvironment` (for the folders), so the two cannot disagree.
 */
export function codexUsesDisposableHome(agent: SetupChoice): boolean {
  return !usesOwnerSetup(agent);
}

// -------------------------------------------------------------- the words

/**
 * WHAT A SCREEN SAYS ABOUT THIS SWITCH. In the engine, not in the window,
 * because the desktop app, a future mobile screen and a run record all describe
 * the same setting and three copies of a sentence is three sentences that can
 * drift. Plain words: no flag names, no jargon.
 */
export const OWNER_SETUP_WORDS = {
  label: "Use my own Claude Code / Codex setup",
  /** one honest line under the switch — what actually changes */
  oneLine:
    "On: this agent starts up the way Claude Code or Codex does when you run it "
    + "yourself — your CLAUDE.md and AGENTS.md, your slash commands, your connected "
    + "services, your plugins, your hooks and your saved memory all load.",
  /** the trade, said once, without a lecture */
  cost:
    "The honest cost: your own written instructions steer it, anything your hooks "
    + "do will really run, it will behave differently on someone else's computer, "
    + "and every turn carries a much bigger prompt — measured here at about 14 times "
    + "the size, which costs more and takes longer.",
  /** what stays shut either way */
  keptBack:
    "Either way, it never gets your saved API keys, and it still cannot drive your "
    + "browser or your desktop as you.",
  whenOff: "Off: it runs in a plain setup Cloud9 builds, with nothing of yours loaded.",
} as const;

/**
 * THE TWO THINGS THE SWITCH DOES NOT HAND OVER, as data a test can read, so that
 * "we kept these back" is checked rather than asserted in a comment.
 */
export const NEVER_INHERITED = [
  {
    what: "his stored API keys and tokens",
    how: "envWithoutCredentials strips every credential variable from the child's "
      + "environment in BOTH modes (env.ts)",
    why: "Inheriting his setup is a decision about instructions and tools. It is not "
      + "a decision to let an agent bill his API account, and nothing about loading "
      + "a CLAUDE.md requires one. The harnesses' own logins still pay for the turn, "
      + "exactly as before.",
    residual: "A `env` block inside his own settings.json WOULD be read by the CLI in "
      + "his-setup mode, and Cloud9 cannot strip what the CLI reads off disk. "
      + "Measured 2026-08-05: that block is empty on this machine.",
  },
  {
    what: "acting as him to a third party without an approval card",
    how: "computer_use and browser_use stay off for Codex at every setting "
      + "(CODEX_NEVER_ENABLED); Cloud9's own approval cards are decided upstream by "
      + "`decideAsking` and this switch does not touch them",
    why: "His browser and his desktop are already signed in as him. A turn that "
      + "clicks through them is not the agent using his settings, it is the agent "
      + "being him, and no configuration switch should be able to buy that.",
    residual: "In his-setup mode his own MCP servers DO load, and some of them reach "
      + "third parties as him. That is what he asked for — but it is why the "
      + "approval cards stay, and why the run record now says which mode ran.",
  },
] as const;
