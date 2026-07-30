// WHAT AN AGENT'S TURN ACTUALLY PRODUCED, found on this machine.
//
// THE GAP THIS CLOSES (the #1 item from the owner's own agents' gap analysis):
// an agent that made a file could only paste a Windows path into the chat, and a
// path on this machine is not a file anybody else can open — not the other
// agents, not the owner on his phone, not a friend. The hub already knows how to
// hold a file and hand it back safely (attachments, one-use tickets); what was
// missing was the half that NOTICES a file was made and offers it.
//
// THIS FILE IS THE NOTICING, and nothing else. It reads the folder the turn ran
// in and answers with two lists: files worth offering, and files it is REFUSING
// with a sentence a person can act on. It sends nothing, stores nothing and
// decides nothing about permission — `engine.ts` sends, and the hub decides.
//
// THE RULES, and why each one is here:
//
//  • ONLY WHAT THIS TURN TOUCHED. `since` is the moment the turn started, so a
//    file the agent has had in its folder for a week is not re-shared every time
//    it says hello. A run that changes nothing produces nothing.
//  • NEVER A HALF-WRITTEN FILE. `isPendingName` is the same owner the
//    whole-write mechanism uses, so a file another process is still filling is
//    invisible here rather than shared truncated.
//  • NEVER THE BOOKKEEPING. An agent's own folder holds its run records and its
//    skill files; a worktree holds `.git` and whatever a build left behind.
//    Sharing those would bury the one file he asked for under two hundred he
//    did not.
//  • A REFUSAL IS SAID OUT LOUD. Too big, or a name that cannot become a file,
//    comes back in `refused` with the sentence — never dropped silently, because
//    the file really IS on this computer and he has to be told it stayed there.
import fs from "node:fs";
import path from "node:path";
import { ARTIFACT_LIMITS, FILE_NAME_SENTENCE, artifactTooBigSentence, isSafeFileName } from "@cloud9/shared";
import { isPendingName } from "./wholefile.js";

/** One file the engine is willing to offer to the hub. */
export interface ProducedFile {
  /** the full path on THIS machine — never leaves the engine */
  path: string;
  /** the shared name: the base name, which is what other people see */
  name: string;
  size: number;
  modifiedAt: number;
}

/** One file that will NOT be shared, and the sentence saying why. */
export interface RefusedFile {
  name: string;
  /** plain words, for the chat — no path, no error code */
  why: string;
}

export interface ArtifactSweep {
  offers: ProducedFile[];
  refused: RefusedFile[];
}

/**
 * Folders never walked into, and why.
 *
 * `runs` and `skills` are the engine's OWN bookkeeping inside an agent's folder
 * — its run records and the instructions we wrote for it. The rest are what a
 * checkout or a build leaves behind. This is a NAME list rather than a path list
 * so it holds at every depth.
 *
 * IT IS A DECISION, NOT A LAW OF NATURE: a build output really can be the thing
 * he wanted (an installer, a report). Written down in
 * `docs/plans/artifact-store-handoff.md` so the next round can widen it on
 * purpose instead of discovering it by surprise.
 */
export const SKIP_FOLDERS = new Set([
  "runs", "skills",
  ".git", "node_modules", "dist", "build", "out", "coverage",
  ".next", ".venv", "__pycache__", ".cache",
]);

export const SWEEP_DEFAULTS = {
  /** most files one turn may offer; the newest win */
  maxFiles: 10,
  /** how deep to look under the folder the turn ran in */
  depth: 4,
  /** most files to even LOOK at, so a runaway folder cannot hang a turn */
  maxScanned: 5000,
} as const;

export interface SweepOptions {
  /** the moment the turn started — nothing older than this is its work */
  since: number;
  maxFiles?: number;
  depth?: number;
}

/**
 * Look at what the turn left behind in one folder.
 *
 * Never throws: a folder that cannot be read is a folder with nothing in it as
 * far as this is concerned, because the paperwork of a turn must never be the
 * reason the turn is reported as broken.
 */
export function sweepProduced(dir: string, opts: SweepOptions): ArtifactSweep {
  const maxFiles = opts.maxFiles ?? SWEEP_DEFAULTS.maxFiles;
  const depth = opts.depth ?? SWEEP_DEFAULTS.depth;
  const found: ProducedFile[] = [];
  const refused: RefusedFile[] = [];
  let scanned = 0;

  const walk = (folder: string, left: number): void => {
    if (left < 0 || scanned >= SWEEP_DEFAULTS.maxScanned) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      if (scanned >= SWEEP_DEFAULTS.maxScanned) return;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_FOLDERS.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(full, left - 1);
        continue;
      }
      if (!entry.isFile()) continue; // a link or a device is not this turn's work
      scanned++;
      // a file still being written is not a file anybody may read yet
      if (isPendingName(entry.name)) continue;
      // dot-files are configuration and state, not the thing he asked for
      if (entry.name.startsWith(".")) continue;
      let stat: fs.Stats;
      try { stat = fs.statSync(full); } catch { continue; }
      if (stat.mtimeMs < opts.since) continue; // older than this turn
      if (stat.size === 0) continue;           // an empty file is not a result
      if (!isSafeFileName(entry.name)) {
        refused.push({ name: entry.name, why: FILE_NAME_SENTENCE });
        continue;
      }
      if (stat.size > ARTIFACT_LIMITS.bytes) {
        refused.push({ name: entry.name, why: artifactTooBigSentence(entry.name, stat.size) });
        continue;
      }
      found.push({ path: full, name: entry.name, size: stat.size, modifiedAt: stat.mtimeMs });
    }
  };
  walk(dir, depth);

  // NEWEST FIRST, because when a turn touched more than the cap the newest is
  // what it was working on last, and the cap must be a stated fact rather than
  // a silent trim.
  found.sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
  const offers = found.slice(0, maxFiles);
  for (const extra of found.slice(maxFiles)) {
    refused.push({
      name: extra.name,
      why: `that turn changed ${found.length} files, and only the newest ${maxFiles} are ` +
        `shared here — this one is still on this computer`,
    });
  }
  return { offers, refused };
}

/**
 * The one line an agent says when a file it made could not be shared.
 *
 * ONE OWNER for the sentence, so the chat never gets a wall of them: at most
 * three reasons, then a count. It reads as a person admitting a limit, which is
 * what it is.
 */
export function describeRefusals(refused: RefusedFile[]): string | undefined {
  if (refused.length === 0) return undefined;
  const lines = refused.slice(0, 3).map(r => `• ${r.why}`);
  const rest = refused.length - lines.length;
  return [
    refused.length === 1
      ? "One file I made could not be shared here:"
      : `${refused.length} files I made could not be shared here:`,
    ...lines,
    ...(rest > 0 ? [`• …and ${rest} more for the same kind of reason.`] : []),
  ].join("\n");
}
