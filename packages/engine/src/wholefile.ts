// THE ONE OWNER OF "WRITE A FILE THIS APP WILL LATER BELIEVE".
//
// The problem, in plain words. `fs.writeFileSync(finalName, text)` is not one
// action. It empties the file, then fills it. If the machine loses power, the
// app is closed, the disk fills up, or a second writer arrives halfway through,
// what is left under the final name is HALF A FILE. Half a file is worse than
// no file, because the next thing to open it sees a name it trusts and reads
// whatever bytes happen to be there.
//
// The fix, also in plain words. Write the bytes into a temporary file NEXT TO
// the real one, push them all the way down to the disk, and only then rename it
// over the real name. The final name then holds the old file or the new one,
// never a mixture.
//
// HOW SURE ARE WE, EXACTLY? Say it honestly rather than louder than the
// platform does:
//   - POSIX (Linux, macOS) DOES guarantee it: `rename()` over an existing name
//     in the same directory is specified as atomic. That is a documented rule.
//   - Windows does NOT publish that guarantee. Node's `renameSync` becomes
//     `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, which on the same NTFS volume
//     replaces the directory entry in one metadata transaction in practice, and
//     it is what everything that cares — SQLite included — relies on. It is a
//     very well-earned convention, not a line in Microsoft's documentation.
//   - What Windows DOES do, and POSIX mostly does not, is fail the rename
//     outright when another program (antivirus, the search indexer) is holding
//     a handle on the target. That is real and it happens on any machine
//     running Defender, so the rename is RETRIED for a short while and then
//     fails honestly. See `renameOverRetrying`.
//
// Why the flush matters. Renaming is atomic about the NAME, not about the
// CONTENT. Without `fsync` the operating system may still be holding the bytes
// in memory when the power goes, and you can end up with the new name over
// empty or partial content — exactly the thing we set out to prevent. So the
// bytes are forced to the disk before the rename, and the folder itself is
// flushed after it where the platform allows.
//
// One owner, so it cannot be half-done in four places. Every file in the engine
// that is written now and believed later goes through here: run records,
// schedules, the remembered model list, and an agent's skill files.
import fs from "node:fs";
import path from "node:path";

/**
 * The mark a not-yet-finished file carries. Anything holding this in its name
 * is litter from an interrupted write: it is never listed, never read, and
 * never counted, and a sweeper may delete it on sight.
 *
 * ONE definition. `runstore` used to spell this out for itself; a second,
 * subtly different spelling is how a sweeper starts missing files.
 */
export const PENDING_MARK = ".tmp-";

/** Is this file name the litter of an interrupted write? */
export function isPendingName(name: string): boolean {
  return name.includes(PENDING_MARK);
}

/** The temporary name a write to `target` will use — same folder, always. */
export function pendingNameFor(target: string): string {
  // pid + clock + a counter: two writers in the same millisecond in the same
  // process still get different names, so one cannot delete the other's bytes.
  return `${target}${PENDING_MARK}${process.pid}-${Date.now()}-${nextTicket()}`;
}

let ticket = 0;
function nextTicket(): number {
  ticket = (ticket + 1) % 1_000_000;
  return ticket;
}

/**
 * Write a file so that it either fully happens or does not happen at all.
 *
 * Returns true if the bytes are now under `target`, false if nothing usable was
 * written. It NEVER throws: none of the things that use this — a run record, a
 * schedule, a cached model list — is worth crashing over, and a caller that
 * wants to complain gets `false` and the reason in `onError`.
 *
 * THE ANSWER IS NOT OPTIONAL. "Never throws" is only safe while every caller
 * looks at what came back. The moment one ignores it, a failure that used to be
 * loud becomes silent — the app carries on and tells the owner the thing was
 * saved when it was not, which is the worse of the two failures for this
 * project. So the rule is: every call site either USES this boolean or carries
 * a `WRITE OUTCOME IGNORED:` line saying why it genuinely does not matter, and
 * `writeoutcome.test.ts` reads the source of this package and fails if a new
 * one does neither.
 *
 * TEXT **OR** BYTES. Not everything this app must not tear is text: an
 * attachment Vikas uploaded, and the encrypted blobs holding this install's
 * private key and his Claude/Codex sign-ins, are all raw bytes. Turning a
 * `Buffer` into a string on the way past would quietly mangle every byte that
 * is not valid UTF-8 — which is most of a PDF, a picture, or a ciphertext — so
 * this takes both and hands them to `fs.writeFileSync` untouched. The
 * alternative was a second, binary-only copy of the whole rule, and a second
 * copy is the bug this module exists to stop.
 *
 * `options.mode` goes on the TEMPORARY file, not on the final name. A file
 * created world-readable and tightened afterwards has already been readable —
 * on a shared machine that window is the leak. Putting the permission on the
 * temporary file means it travels with the rename and there is no window at
 * all. (Windows ignores the bits; POSIX does not, and this app is meant to
 * move.)
 */
export function writeWholeFile(
  target: string,
  data: string | NodeJS.ArrayBufferView,
  onError?: (message: string) => void,
  options?: { mode?: number },
): boolean {
  const pending = pendingNameFor(target);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // `encoding` is what a string is written as and is ignored for bytes, so one
    // call covers both without a branch that could drift.
    fs.writeFileSync(pending, data, options?.mode === undefined
      ? { encoding: "utf8" }
      : { encoding: "utf8", mode: options.mode });
    flushFile(pending);
    renameOverRetrying(pending, target);
    flushDir(path.dirname(target));
    return true;
  } catch (err) {
    // never leave our own litter behind
    try { fs.rmSync(pending, { force: true }); } catch { /* nothing more to do */ }
    onError?.(`could not write ${path.basename(target)}: ${String(err)}`);
    return false;
  }
}

/**
 * How hard we try to put the new name in place before giving up. Six goes,
 * ~20 ms apart, is about a tenth of a second — longer than an antivirus
 * scanner or the search indexer normally holds a handle, and short enough that
 * a genuinely stuck file still fails while the owner is still in the room.
 */
export const RENAME_TRIES = 6;
export const RENAME_WAIT_MS = 20;

/**
 * The rename, retried for the one reason it fails on a healthy Windows machine.
 *
 * Defender, the search indexer and backup tools open files WITHOUT sharing
 * delete, and while they hold that handle a rename over the target fails with
 * `EPERM` (sometimes `EACCES` or `EBUSY`). It is over in milliseconds. Trying
 * exactly once meant a run record or a schedule save was thrown away for good
 * because a scanner happened to be reading the old file at that instant.
 *
 * Anything else — a folder that is not there, a name that is too long, a full
 * disk — is not a race and is not retried: it is thrown straight out so the
 * caller hears about it now rather than a tenth of a second later.
 */
function renameOverRetrying(from: string, to: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const someoneIsHoldingIt = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (!someoneIsHoldingIt || attempt >= RENAME_TRIES) throw err;
      waitSync(RENAME_WAIT_MS);
    }
  }
}

/**
 * Wait without an `await`. `writeWholeFile` is synchronous by design — its
 * callers are in the middle of finishing a turn — so the pause between rename
 * attempts has to block this thread rather than yield it.
 */
function waitSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Force a file's bytes out of memory and onto the disk. */
function flushFile(file: string): void {
  const fd = fs.openSync(file, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/**
 * Force the FOLDER entry out too, so the new name survives a power cut and not
 * just the bytes. Windows has no such call and does not need one — opening a
 * directory there fails, and that failure is expected, not a problem.
 */
function flushDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch { /* not supported on this platform — the rename is still atomic */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

/**
 * How recently a temporary file must have been touched to count as "somebody
 * may still be writing this". A 24 MB run record takes milliseconds; a minute
 * is a wide margin, and past it the owning process has plainly died.
 */
export const IN_FLIGHT_GRACE_MS = 60_000;

/**
 * Delete every leftover temporary file in a folder — EXCEPT one another
 * process is still writing. Returns how many went.
 *
 * Why the exception. Two Cloud9 windows can share one data folder. The second
 * one sweeps at startup, and without this it could delete the first one's
 * half-written `schedules.json` temporary file a millisecond before its rename.
 * That fails safely — the old file survives — but the save is lost and nobody
 * asked for it to be. The window is small and it is real, so it is closed.
 *
 * How it can tell. The temporary name carries the pid and the clock of the
 * writer (`pendingNameFor`). A file is left alone only when BOTH are true: the
 * process that made it is still alive, and it was touched inside the grace
 * window. One alone is not enough — pids get reused, and a dead process's
 * litter must still be swept.
 */
export function sweepPending(dir: string, now: number = Date.now()): number {
  let removed = 0;
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!isPendingName(name)) continue;
    const file = path.join(dir, name);
    if (stillBeingWritten(file, name, now)) continue;
    try { fs.rmSync(file, { force: true }); removed++; } catch { /* busy */ }
  }
  return removed;
}

/**
 * Sweep a whole tree, not one floor of it.
 *
 * The startup sweep used to cover the top of the data folder only, which meant
 * `schedules.json` and the model cache were tidied and an agent's skill files
 * were not — so litter from a killed skill write sat for ever in a folder the
 * CLI reads. Naming the folders that need sweeping is a list somebody has to
 * remember to extend; walking everything the app writes under one root is not.
 *
 * `depth` is a guard against a folder that somehow points at itself. Symbolic
 * links are not followed — `isDirectory()` is false for them — so a link
 * planted in the data folder cannot send the sweep off across the disk.
 */
export function sweepPendingTree(root: string, depth = 8, now: number = Date.now()): number {
  let removed = sweepPending(root, now);
  if (depth <= 0) return removed;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    removed += sweepPendingTree(path.join(root, entry.name), depth - 1, now);
  }
  return removed;
}

/** Is another (or this) live process still filling this temporary file? */
function stillBeingWritten(file: string, name: string, now: number): boolean {
  const stamp = /\.tmp-(\d+)-(\d+)-\d+$/.exec(name);
  if (!stamp) return false; // not a name we made — nobody we know of is writing it
  const pid = Number(stamp[1]);
  let touched = Number(stamp[2]);
  try { touched = Math.max(touched, fs.statSync(file).mtimeMs); } catch { /* it went */ }
  if (now - touched > IN_FLIGHT_GRACE_MS) return false; // far too old to be in flight
  return processIsAlive(pid);
}

/** Signal 0 asks "is this pid there?" without touching the process. */
function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // "you may not signal it" still means it exists
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
