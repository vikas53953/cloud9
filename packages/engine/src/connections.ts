// THE CONNECTIONS FILE — one owner for "does this agent really have connected
// services, and what do we say about it?"
//
// WHAT A CONNECTION IS, in the owner's words: extra tools an agent can reach
// that Cloud9 did not write — a calendar, a ticket system, a company search box.
// Whoever makes the tool hands you a small config file. The owner picks that
// file for ONE agent, and only that agent ever sees it.
//
// THE BUG THIS EXISTS TO MAKE IMPOSSIBLE. The `connections` switch has been
// fully wired at the command line since 2026-07-30 (`claude-cli.ts` passes
// `--mcp-config`, `abilities.ts` gates it behind the switch) and nothing on any
// screen ever chose a file, so the switch was permanently inert: on, allowed,
// approved — and handing the agent nothing at all. The prompt was already honest
// about it (`onButNothingSupplied`), because it is derived from what the
// LAUNCHER really supplies rather than from the switch. This file is the other
// half of that same law: the ONE place that turns "a stored path" into "a path
// the harness may have", so the screen and the command line cannot disagree.
//
// FOUR STATES, AND NONE OF THEM IS A GUESS:
//   off   — the switch is off. Nothing is passed, whatever is stored.
//   none  — the switch is on and no file has been chosen. The agent gets none.
//   gone  — a file was chosen and it is not on this computer any more. NOT used,
//           and said out loud: a path that silently stops working is exactly the
//           kind of quiet lie this product refuses.
//   ready — the switch is on, a file was chosen, and it is there right now.
//
// EXISTENCE IS ASKED FRESH, NEVER REMEMBERED. `onDisk` is injected rather than
// imported, for two reasons: the answer is a fact about THIS MOMENT (a file the
// owner moved yesterday must read as gone today), and this module is imported by
// the desktop window, which is not allowed to touch the filesystem at all — it
// asks the desktop shell and passes the answer back in.
import { AgentDef, validateConnectionsFile } from "@cloud9/shared";
import { allowsConnections } from "./abilities.js";

/** Is this file on the computer, right now? Answered by whoever can see the disk. */
export type FileOnDisk = (path: string) => boolean;

export interface ConnectionsFile {
  /** what is true for this agent this second */
  state: "off" | "none" | "gone" | "ready";
  /** the path the owner chose, when one is stored — shown even when unusable */
  path?: string;
  /**
   * THE PATH THE HARNESS MAY REALLY BE HANDED, and the only field the launcher
   * reads. Set for `ready` and for nothing else, so there is no state in which
   * a caller could take a path the screen is calling gone.
   */
  supply?: string;
}

/**
 * THE ONE ANSWER. The engine host asks it to build a command line; the agent
 * editor asks it to write a sentence. Same function, same four states, so the
 * screen can never promise a connection the command line will not carry.
 */
export function connectionsFileFor(
  agent: Pick<AgentDef, "provider" | "abilities" | "connectionsFile">,
  onDisk: FileOnDisk,
): ConnectionsFile {
  const said = typeof agent.connectionsFile === "string" ? agent.connectionsFile.trim() : "";
  // Blank and absent are the same answer — "nobody has chosen one" — so there is
  // no second meaning for `""` anywhere in the app.
  const path = said.length > 0 ? said : undefined;
  // The switch has the last word, and it is asked through `allowsConnections`
  // (which reads `effectiveAbilities`), never from `agent.abilities` directly.
  if (!allowsConnections(agent as AgentDef)) return path ? { state: "off", path } : { state: "off" };
  if (!path) return { state: "none" };
  // A stored path is untrusted input by the time it gets here — it has been
  // through a database and a socket since the owner chose it. Same gate as the
  // hub's, because neither trusts the other.
  if (validateConnectionsFile(path)) return { state: "gone", path };
  if (!safely(() => onDisk(path))) return { state: "gone", path };
  return { state: "ready", path, supply: path };
}

/**
 * What the engine host hands `ClaudeCliProviderOptions.mcpConfigPath`. It is a
 * thin reading of the state above rather than its own rule, so "the screen says
 * ready" and "the command line carries it" are one decision.
 */
export function mcpConfigPathFor(
  agent: Pick<AgentDef, "provider" | "abilities" | "connectionsFile"> | undefined,
  onDisk: FileOnDisk,
): string | undefined {
  if (!agent) return undefined;
  return connectionsFileFor(agent, onDisk).supply;
}

/**
 * The same four states in the owner's words — no jargon, no file-format talk.
 * The screen prints these; nothing on screen writes its own version, which is
 * how the sentence and the fact stay one thing.
 */
export function connectionsWords(
  file: ConnectionsFile, agentName: string,
): { headline: string; detail: string } {
  switch (file.state) {
    case "off":
      return {
        headline: "Connected services are switched off.",
        detail: file.path
          ? `${agentName} is not using the file you chose, and will not until you switch ` +
            "connected services back on."
          : `${agentName} cannot reach any outside service or account.`,
      };
    case "none":
      return {
        headline: "No connections file chosen yet, so there are no connections.",
        detail: `You have allowed ${agentName} to use connected services, but you have not ` +
          "picked the file that says which ones. Until you do, it has none — it is not " +
          "using your own connected accounts, and it never will.",
      };
    case "gone":
      return {
        headline: "That file is gone.",
        detail: "The file you chose is not on this computer any more, so it is not being " +
          `used and ${agentName} has no connected services. Choose it again from wherever ` +
          "it lives now, or forget it.",
      };
    default:
      return {
        headline: "In use.",
        detail: `${agentName} can reach the services in this file, and only this file — ` +
          "your own connected accounts are never used. You are asked before it acts " +
          "through any of them.",
      };
  }
}

/** A disk check must never take a turn down with it — an error means "not there". */
function safely(check: () => boolean): boolean {
  try { return check() === true; } catch { return false; }
}
