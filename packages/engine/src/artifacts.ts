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
import {
  ARTIFACT_LIMITS, ArtifactLink, ArtifactLinkManifestFile, FILE_NAME_SENTENCE,
  artifactTooBigSentence, isSafeFileName, nameKey, parseArtifactLinkManifest,
} from "@cloud9/shared";
import { isPendingName } from "./wholefile.js";

/**
 * One captured value the engine is willing to offer to the hub.
 *
 * Deliberately NO path and NO source-file state. Once this object exists, these
 * exact bytes are the produced value; publishing it cannot consult the mutable
 * filesystem again.
 */
export interface ProducedFile {
  /** the shared name: the base name, which is what other people see */
  name: string;
  /** engine-owned snapshot, captured once before this became an offer */
  bytes: Buffer;
  /** always derived from `bytes.length` */
  size: number;
  modifiedAt: number;
  /** the agent's own optional line for this exact version */
  note?: string;
  /** typed, exact-version relationships declared for this exact version */
  links?: ArtifactLink[];
}

interface ScanFileState {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface ScanCandidate {
  path: string;
  name: string;
  modifiedAt: number;
  state: ScanFileState;
}

type CaptureCandidate = (candidate: ScanCandidate, maxBytes: number) => Buffer | undefined;

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

/**
 * Most source bytes one turn may synchronously attempt to capture.
 *
 * Separate from the ten-file product cap: failed captures may backfill older
 * valid files, but even a folder full of late-failing 10 MB files cannot make
 * the engine read without end. Twenty artifact-sized attempts leave room for
 * meaningful backfill while bounding production capture work to 200 MB.
 */
export const CAPTURE_WORK_LIMIT_BYTES = ARTIFACT_LIMITS.bytes * 20;
const CAPTURE_SAFETY_REASON = "capture safety limit";

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
  /** test seam; production always uses the shared artifact byte limit */
  maxBytes?: number;
  /** test seam; production uses the separate engine-owned capture-work ceiling */
  captureWorkBytes?: number;
  /** deterministic capture-failure seam; production uses the descriptor reader below */
  capture?: CaptureCandidate;
}

/** Private instructions for annotating files from this turn; never a produced file itself. */
export const ARTIFACT_LINK_MANIFEST = path.join(".cloud9", "artifact-links.json");

interface TurnManifest {
  byName: Map<string, ArtifactLinkManifestFile>;
  refused?: RefusedFile;
}

/**
 * Read this turn's private file-link manifest, or deliberately treat it as absent.
 *
 * AGE COMES FIRST. A damaged manifest left by an earlier turn is none of this
 * turn's business and must not make today's successful work look broken. A
 * current manifest is parsed by the shared parser — the one owner of its shape,
 * limits and canonical link de-duplication. Nothing here guesses around a bad
 * row or repeats its untrusted contents into chat.
 */
function readTurnManifest(dir: string, since: number): TurnManifest {
  const manifestPath = path.join(dir, ARTIFACT_LINK_MANIFEST);
  let stat: fs.BigIntStats;
  try { stat = fs.statSync(manifestPath, { bigint: true }); }
  catch { return { byName: new Map() }; }
  const modifiedAt = Number(stat.mtimeNs) / 1_000_000;
  if (!stat.isFile() || modifiedAt < since) return { byName: new Map() };

  // Never read more than the shared parser can accept plus one byte. The extra
  // byte is enough for that parser to own the "too big" decision without first
  // loading an arbitrarily large private file into the engine process.
  const bytes = readSnapshot(
    manifestPath, scanState(stat), ARTIFACT_LIMITS.manifestBytes + 1, true);
  if (!bytes) return { byName: new Map(), refused: badManifestRefusal() };
  let text = bytes.toString("utf8");
  if (stat.size > BigInt(ARTIFACT_LIMITS.manifestBytes)) {
    const encoded = Buffer.byteLength(text, "utf8");
    if (encoded <= ARTIFACT_LIMITS.manifestBytes) {
      text += "x".repeat(ARTIFACT_LIMITS.manifestBytes + 1 - encoded);
    }
  }
  const parsed = parseArtifactLinkManifest(text);
  if (!parsed.ok) return { byName: new Map(), refused: badManifestRefusal() };
  return { byName: new Map(parsed.manifest.files.map(file => [nameKey(file.name), file])) };
}

/** One deliberately generic room-visible sentence: private manifest contents stay private. */
function badManifestRefusal(): RefusedFile {
  return {
    name: "artifact-links.json",
    why: "I did not add any file notes or links because this turn's artifact-links.json " +
      "is not valid; fix or remove that private file and try again.",
  };
}

function scanState(stat: fs.BigIntStats): ScanFileState {
  return {
    dev: stat.dev, ino: stat.ino, size: stat.size,
    mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs,
  };
}

function isSameScanState(expected: ScanFileState, actual: fs.BigIntStats): boolean {
  return expected.dev === actual.dev
    && expected.ino === actual.ino
    && expected.size === actual.size
    && expected.mtimeNs === actual.mtimeNs
    && expected.ctimeNs === actual.ctimeNs;
}

/**
 * Capture one coherent source snapshot into a new Buffer.
 *
 * Every filesystem check is part of capture. The returned Buffer is the value;
 * nothing is allowed to reopen this path later. `allowPrefix` is only for the
 * private manifest, where limit+1 bytes are enough to prove an oversize refusal.
 */
function readSnapshot(
  filePath: string, state: ScanFileState, maxBytes: number, allowPrefix = false,
): Buffer | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, "r");
    const before = fs.fstatSync(fd, { bigint: true });
    if (!isSameScanState(state, before)) return undefined;
    if (!allowPrefix && before.size > BigInt(maxBytes)) return undefined;
    const wanted = allowPrefix
      ? Math.min(Number(before.size), maxBytes)
      : Number(before.size);
    const bytes = Buffer.alloc(wanted);
    let read = 0;
    while (read < wanted) {
      const n = fs.readSync(fd, bytes, read, wanted - read, read);
      if (n === 0) return undefined;
      read += n;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (!isSameScanState(state, after)) return undefined;
    const stillAtPath = fs.statSync(filePath, { bigint: true });
    if (!isSameScanState(state, stillAtPath)) return undefined;
    return bytes;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort: capture is already over */ }
    }
  }
}

function captureCandidate(candidate: ScanCandidate, maxBytes: number): Buffer | undefined {
  return readSnapshot(candidate.path, candidate.state, maxBytes);
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
  const maxBytes = opts.maxBytes ?? ARTIFACT_LIMITS.bytes;
  const captureWorkBytes = opts.captureWorkBytes ?? CAPTURE_WORK_LIMIT_BYTES;
  const found: ScanCandidate[] = [];
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
      let stat: fs.BigIntStats;
      try { stat = fs.statSync(full, { bigint: true }); } catch { continue; }
      const modifiedAt = Number(stat.mtimeNs) / 1_000_000;
      const size = Number(stat.size);
      if (modifiedAt < opts.since) continue; // older than this turn
      if (stat.size === 0n) continue;        // an empty file is not a result
      if (!isSafeFileName(entry.name)) {
        refused.push({ name: entry.name, why: FILE_NAME_SENTENCE });
        continue;
      }
      if (stat.size > BigInt(maxBytes)) {
        refused.push({
          name: entry.name,
          why: maxBytes === ARTIFACT_LIMITS.bytes
            ? artifactTooBigSentence(entry.name, size)
            : `"${entry.name}" is too big for this capture limit and stayed on this computer.`,
        });
        continue;
      }
      found.push({ path: full, name: entry.name, modifiedAt, state: scanState(stat) });
    }
  };
  walk(dir, depth);

  // THE MANIFEST IS PRIVATE INSTRUCTIONS, not another result. The ordinary walk
  // never enters `.cloud9`; this separate read happens only after the produced
  // files are known, and an entry can annotate only an exact matching base name.
  const manifest = readTurnManifest(dir, opts.since);
  if (manifest.refused) refused.push(manifest.refused);
  const candidatesByName = new Map<string, ScanCandidate[]>();
  for (const candidate of found) {
    const key = nameKey(candidate.name);
    const matches = candidatesByName.get(key) ?? [];
    matches.push(candidate);
    candidatesByName.set(key, matches);
  }
  const annotationsByName = new Map<string, ArtifactLinkManifestFile>();
  for (const [key, declared] of manifest.byName) {
    const matches = candidatesByName.get(key) ?? [];
    if (matches.length > 1) {
      refused.push({
        name: declared.name,
        why: `I did not add the note or links for "${declared.name}" because more than one ` +
          "file made this turn has that name after spacing and letter case are normalised; " +
          "rename one of them and try again.",
      });
      continue;
    }
    if (matches.length === 1) annotationsByName.set(key, declared);
  }

  // NEWEST FIRST. The cap counts SUCCESSFUL captures, not paths we happened to
  // try: a changing/unreadable new file leaves its slot for the next valid one.
  found.sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
  const offers: ProducedFile[] = [];
  const capture = opts.capture ?? captureCandidate;
  let attemptedCaptureBytes = 0;
  let next = 0;
  while (next < found.length && offers.length < maxFiles) {
    const candidate = found[next++];
    const candidateBytes = Number(candidate.state.size);
    // Reserve the whole stat-sized read before it begins. Production capture
    // cannot read more than this candidate size, so the cumulative synchronous
    // work is finite even when every large file fails after a late read.
    if (attemptedCaptureBytes + candidateBytes > captureWorkBytes) {
      refused.push({
        name: candidate.name,
        why: `"${candidate.name}" was not read because this turn reached Cloud9's ` +
          `${CAPTURE_SAFETY_REASON}; it stayed on this computer. Try again in a new turn.`,
      });
      continue;
    }
    attemptedCaptureBytes += candidateBytes;
    const captured = capture(candidate, maxBytes);
    if (!captured || captured.length === 0 || captured.length > maxBytes) {
      refused.push({
        name: candidate.name,
        why: `"${candidate.name}" changed or could not be read while I was capturing it, so ` +
          "it stayed on this computer; let it finish and try again.",
      });
      continue;
    }
    // Production capture already allocated this Buffer. An injected test capture
    // is copied so the offer still owns its value rather than the injector's.
    const bytes = opts.capture ? Buffer.from(captured) : captured;
    const declared = annotationsByName.get(nameKey(candidate.name));
    offers.push({
      name: candidate.name,
      bytes,
      size: bytes.length,
      modifiedAt: candidate.modifiedAt,
      ...(declared?.note !== undefined ? { note: declared.note } : {}),
      ...(declared?.links !== undefined ? { links: declared.links } : {}),
    });
  }
  // Only candidates AFTER enough successful captures are true cap extras.
  for (const extra of found.slice(next)) {
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
  const visible = refused.slice(0, 3);
  const safety = refused.find(row => row.why.includes(CAPTURE_SAFETY_REASON));
  if (safety && !visible.includes(safety)) {
    // The safety ceiling is a different product fact from an ordinary read
    // failure. Keep one instance room-visible even when earlier failures filled
    // the three-line summary, rather than hiding it behind "more".
    visible[visible.length - 1] = safety;
  }
  const lines = visible.map(r => `• ${r.why}`);
  const rest = refused.length - lines.length;
  return [
    refused.length === 1
      ? "One file I made could not be shared here:"
      : `${refused.length} files I made could not be shared here:`,
    ...lines,
    ...(rest > 0 ? [`• …and ${rest} more.`] : []),
  ].join("\n");
}
