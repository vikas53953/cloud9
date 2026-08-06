// THE FOLDERS OUTSIDE ITS OWN — one owner for "does this agent really reach
// anywhere else on this computer, and what do we say about it?"
//
// WHAT THIS IS, in the owner's words: folders on this computer this agent may
// read and change, besides its own. He picks them from the computer's own folder
// picker, for ONE agent, and only that agent ever gets them.
//
// THE BUG THIS EXISTS TO MAKE IMPOSSIBLE — the last one of its kind. The
// `wholeComputer` switch has been wired at the command line since 2026-07-30
// (`claudeArgs` passes `--add-dir`, `grantedSupply` gates it) and nothing on any
// screen ever chose a folder, so the switch was permanently inert: on, allowed,
// approved — and handing the agent nothing at all. `host.ts` said so outright in
// a comment, and the editor drew it in an "on, but not doing anything yet" box.
// This file is the other half of the law `connections.ts` already carries: the
// ONE place that turns "stored paths" into "paths the harness may have", so the
// screen and the command line cannot disagree.
//
// FIVE STATES, AND NONE OF THEM IS A GUESS:
//   off    — the switch is off. Nothing is passed, whatever is stored.
//   none   — the switch is on and no folder has been chosen. The agent gets none.
//   gone   — folders were chosen and NOT ONE of them is on this computer now.
//            Nothing is passed, and it is said out loud.
//   partly — some of the chosen folders are there and some are not. The ones
//            that are there are passed; the missing ones are NAMED. A list that
//            quietly shrinks is the same lie as a path that silently stops
//            working, so it is never rounded to "ready".
//   ready  — the switch is on and every folder chosen is there right now.
//
// EXISTENCE IS ASKED FRESH, NEVER REMEMBERED. `onDisk` is injected rather than
// imported, for the two reasons `connections.ts` gives: the answer is a fact
// about THIS MOMENT (a folder moved yesterday must read as gone today), and this
// module is imported by the desktop window, which is not allowed to touch the
// filesystem at all — it asks the desktop shell and passes the answer back in.
import { AgentDef, validateWholeComputerRoot } from "@cloud9/shared";
import { FILE_FENCE_WORDS, FileFence, fileFenceFor, reachesBeyondOwnFolder } from "./abilities.js";

/** Is this folder on the computer, right now? Answered by whoever can see the disk. */
export type FolderOnDisk = (path: string) => boolean;

export interface WholeComputerRoots {
  /** what is true for this agent this second */
  state: "off" | "none" | "gone" | "partly" | "ready";
  /** every folder the owner chose, in his order — shown even when unusable */
  chosen: string[];
  /** the ones that are not on this computer right now, or were never allowed */
  missing: string[];
  /**
   * THE FOLDERS THE HARNESS MAY REALLY BE HANDED, and the only field the
   * launcher reads. Never contains a folder this answer calls missing, so there
   * is no state in which a caller could take a path the screen calls gone.
   */
  supply: string[];
  /**
   * GAP C (2026-08-05): WHAT KIND OF BOUNDARY THIS REALLY IS.
   *
   * It rides on the answer rather than being asked separately, so the words
   * below cannot describe one kind of fence while the agent has the other. See
   * the long measured note on `FILE_FENCE_WORDS` in abilities.ts: a Codex agent
   * is genuinely boxed in by its own program; a Claude agent is POINTED at these
   * folders, and the hard boundary it really has is which tools exist at all.
   */
  fence: FileFence;
}

/** Blank, absent and a list of blanks are one answer: nobody chose anything. */
function storedRoots(agent: Pick<AgentDef, "wholeComputerRoots">): string[] {
  const said = Array.isArray(agent.wholeComputerRoots) ? agent.wholeComputerRoots : [];
  const clean: string[] = [];
  for (const root of said) {
    if (typeof root !== "string") continue;
    const trimmed = root.trim();
    // The same folder twice is one folder — a duplicate on the command line
    // would be noise, and on the screen it would look like more reach than he
    // actually gave.
    if (trimmed.length > 0 && !clean.includes(trimmed)) clean.push(trimmed);
  }
  return clean;
}

/**
 * THE ONE ANSWER. The engine host asks it to build a command line; the agent
 * editor asks it to write a sentence. Same function, same five states, so the
 * screen can never promise reach the command line will not carry.
 */
export function wholeComputerRootsFor(
  agent: Pick<AgentDef, "provider" | "abilities" | "wholeComputerRoots">,
  onDisk: FolderOnDisk,
): WholeComputerRoots {
  const chosen = storedRoots(agent);
  // The switch has the last word, and it is asked through `reachesBeyondOwnFolder`
  // (which reads `effectiveAbilities`), never from `agent.abilities` directly.
  // An off switch is answered without touching the disk at all.
  const fence = fileFenceFor(agent);
  if (!reachesBeyondOwnFolder(agent as AgentDef)) {
    return { state: "off", chosen, missing: [], supply: [], fence };
  }
  if (chosen.length === 0) return { state: "none", chosen, missing: [], supply: [], fence };

  const supply: string[] = [];
  const missing: string[] = [];
  for (const root of chosen) {
    // A stored path is untrusted input by the time it gets here — it has been
    // through a database and a socket since the owner chose it. Same gate as the
    // hub's, because neither trusts the other, and it is asked BEFORE the disk:
    // a path we already refuse is never even looked for.
    if (validateWholeComputerRoot(root)) { missing.push(root); continue; }
    if (!safely(() => onDisk(root))) { missing.push(root); continue; }
    supply.push(root);
  }
  if (supply.length === 0) return { state: "gone", chosen, missing, supply: [], fence };
  if (missing.length > 0) return { state: "partly", chosen, missing, supply, fence };
  return { state: "ready", chosen, missing: [], supply, fence };
}

/**
 * What the engine host hands `ClaudeCliProviderOptions.wholeComputerRoots`. It
 * is a thin reading of the state above rather than its own rule, so "the screen
 * says ready" and "the command line carries it" are one decision.
 */
export function addDirRootsFor(
  agent: Pick<AgentDef, "provider" | "abilities" | "wholeComputerRoots"> | undefined,
  onDisk: FolderOnDisk,
): string[] {
  if (!agent) return [];
  return wholeComputerRootsFor(agent, onDisk).supply;
}

/**
 * The same five states in the owner's words — no jargon, no flag names. The
 * screen prints these; nothing on screen writes its own version, which is how
 * the sentence and the fact stay one thing.
 */
export function wholeComputerWords(
  roots: WholeComputerRoots, agentName: string,
): { headline: string; detail: string } {
  switch (roots.state) {
    case "off":
      return {
        headline: "Reaching outside its own folder is switched off.",
        detail: roots.chosen.length > 0
          ? `${agentName} is not using the folders you chose, and will not until you switch `
            + "this back on."
          : `${agentName} is working in its own folder only — no other folder on this `
            + `computer has been opened up for it. ${fenceNote(roots)}`,
      };
    case "none":
      return {
        headline: "No folders chosen yet, so it has no extra reach.",
        detail: `You have allowed ${agentName} to go outside its own folder, but you have not `
          + "said which folders. Until you do it has been sent nowhere, so it stays in its "
          + `own folder. ${fenceNote(roots)}`,
      };
    case "gone":
      return {
        headline: roots.chosen.length === 1 ? "That folder is gone." : "Those folders are gone.",
        detail: "Not one of the folders you chose is on this computer any more, so none is "
          + `being used and ${agentName} has no reach outside its own folder. Choose them again `
          + "from wherever they live now, or forget them.",
      };
    case "partly":
      return {
        headline: "Some of those folders are gone.",
        detail: `${agentName} can reach the folders below that are still here, and only those. `
          + "The ones marked missing are not on this computer any more, so they are not being "
          + "used — choose them again from wherever they live now, or forget them.",
      };
    default:
      return {
        headline: "In use.",
        detail: `${agentName} is pointed at these folders and told to work in them only. `
          + `You are asked before it acts in any of them. ${fenceNote(roots)}`,
      };
  }
}

/**
 * GAP C (2026-08-05): THE ONE SENTENCE ABOUT WHAT THIS BOUNDARY REALLY IS.
 *
 * It is appended to every state that talks about reach, and it is read off the
 * ONE table in abilities.ts rather than written here — because the reason this
 * needed fixing at all is that a screen invented its own version ("and only
 * these; the rest of this computer is still closed to it") and nobody had
 * measured whether it was true. It is not, on the Claude side.
 */
function fenceNote(roots: WholeComputerRoots): string {
  const words = FILE_FENCE_WORDS[roots.fence];
  return `${words.headline} ${words.detail}`;
}

/** A disk check must never take a turn down with it — an error means "not there". */
function safely(check: () => boolean): boolean {
  try { return check() === true; } catch { return false; }
}
