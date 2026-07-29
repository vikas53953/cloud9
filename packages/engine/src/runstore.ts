// Where run records live so they survive the app closing.
//
// One file per run, inside the agent's OWN folder, under the engine's existing
// data directory:
//
//   <dataDir>/agents/<agentId>/runs/r-<time>-<noise>.json
//
// SAFE PATHS HAVE ONE OWNER. This module writes no rule of its own: the file
// name is checked with `isSafeSkillFileName` — the same function the relay and
// `Engine.writeSkillFiles` already use — and the finished path is then checked
// with the same `path.relative` backstop. A second, subtly different rule is
// how a hole gets opened, so there isn't one.
//
// BOUNDED AND PRUNABLE. A record that would be too big has its steps dropped
// (and says so). An agent keeps its most recent runs and no more; the rest are
// deleted oldest-first. Ids sort by time, so "oldest" is just the file name.
//
// FAIL SAFE. Nothing in here throws at its caller. If the disk is full, the
// folder is read-only, or the JSON is corrupt, the answer the agent gave still
// reaches the owner and the failure goes to the log.
import fs from "node:fs";
import path from "node:path";
import {
  RunListEntry, RunRecord, RUN_RETENTION, fitRunRecord, isSafeSkillFileName, runListEntry,
} from "@cloud9/shared";

export type { RunListEntry };

/** The suffix a half-written record carries until it is whole. Never listed. */
const PENDING = ".tmp-";

export interface RunStoreOptions {
  /** the agent's own folder — the engine already owns this decision */
  agentDataDir: (agentId: string) => string;
  /** how many runs to keep per agent before the oldest are deleted */
  keepPerAgent?: number;
  /** a single record may not exceed this on disk */
  maxBytes?: number;
  log?: (message: string) => void;
}

/**
 * HOW MANY RUNS ARE KEPT IS ONE FACT. `RUN_RETENTION.perAgent` in
 * `@cloud9/shared` is what the hub keeps; this store keeps the same number on
 * disk. They used to be two unrelated 50s in two packages, which is a drift
 * waiting to happen: change one and the app quietly keeps two different amounts
 * of history in two places and nobody notices until a run is missing from one
 * screen and present on another. Derived, not copied — and a test asserts it.
 */
export const RUN_STORE_DEFAULTS = {
  keepPerAgent: RUN_RETENTION.perAgent,
  maxBytes: 64 * 1024,
} as const;

/**
 * A keep or a limit that could never make sense, turned into one that can.
 *
 * `prune` used to be `ids.slice(this.keep)`, so a keep of -5 sliced from the
 * END and deleted an agent's whole history. Nothing reaches it today — which is
 * exactly the reason to close it now, while it is cheap, rather than after
 * someone wires a settings box to it. A retention count below 1 is not a
 * request to delete everything; it is a mistake, and the safe reading of a
 * mistake is "keep the default".
 */
function atLeastOne(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const whole = Math.floor(value);
  return whole >= 1 ? whole : fallback;
}

export class RunStore {
  private keep: number;
  private maxBytes: number;
  private log: (message: string) => void;

  constructor(private opts: RunStoreOptions) {
    this.keep = atLeastOne(opts.keepPerAgent, RUN_STORE_DEFAULTS.keepPerAgent);
    this.maxBytes = opts.maxBytes ?? RUN_STORE_DEFAULTS.maxBytes;
    this.log = opts.log ?? ((m: string) => console.error(m));
  }

  /**
   * The runs folder for an agent, or undefined if the agent id could not be
   * turned into a path inside its own folder. Creating the folder is part of
   * this call so no caller has to remember to.
   */
  private dirFor(agentId: string, create: boolean): string | undefined {
    try {
      const base = path.resolve(this.opts.agentDataDir(agentId));
      const dir = path.resolve(path.join(base, "runs"));
      // the backstop: "runs" must genuinely be inside the agent's own folder
      const rel = path.relative(base, dir);
      if (rel !== "runs") return undefined;
      if (create) fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch (err) {
      this.log(`[engine] could not open the runs folder for agent ${agentId}: ${String(err)}`);
      return undefined;
    }
  }

  /** The full path a run id would be written to, or undefined if it is unusable. */
  private fileFor(dir: string, runId: string): string | undefined {
    const name = `${runId}.json`;
    // the SAME rule skill files go through — one owner, no second opinion
    if (!isSafeSkillFileName(name)) return undefined;
    const target = path.resolve(path.join(dir, name));
    if (path.relative(dir, target) !== name) return undefined;
    return target;
  }

  /**
   * Write one record. Returns the path it landed at, or undefined if it could
   * not be written — never throws, because a turn must not fail over its own
   * paperwork.
   */
  save(record: RunRecord): string | undefined {
    const dir = this.dirFor(record.agentId, true);
    if (!dir) {
      this.log(`[engine] refused to store a run for agent ${record.agentId}: unusable folder`);
      return undefined;
    }
    const target = this.fileFor(dir, record.id);
    if (!target) {
      this.log(`[engine] refused to store run ${record.id}: unusable name`);
      return undefined;
    }
    // WRITE THEN RENAME. A record must become visible whole or not at all.
    // `writeFileSync` straight to the final name meant a turn interrupted
    // mid-write — the app closing, the machine sleeping, a full disk — left half
    // a file under a name `list` trusts. It parsed as nothing, so it showed
    // nothing, and it still counted towards the 50 kept runs, so it pushed a
    // real run out and then sat there for ever. Renaming is atomic on both
    // Windows and POSIX, so the final name only ever holds finished bytes.
    const pending = `${target}${PENDING}${process.pid}-${Date.now()}`;
    try {
      fs.writeFileSync(pending, serialize(this.fit(record)), "utf8");
      fs.renameSync(pending, target);
      this.prune(record.agentId);
      return target;
    } catch (err) {
      // never leave our own litter behind
      try { fs.rmSync(pending, { force: true }); } catch { /* nothing more to do */ }
      this.log(`[engine] could not store run ${record.id}: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Bring a record under the size cap by dropping steps from the MIDDLE — the
   * first few steps and the last few are what a person reads. The record then
   * says it was truncated, so nobody mistakes a trimmed run for a short one.
   */
  fit(record: RunRecord): RunRecord {
    // ONE implementation of "make it fit", in `@cloud9/shared`, because the
    // relay has to do the same thing to the same object. What differs is only
    // HOW it is measured — this store writes indented JSON, the hub writes a
    // compact database row — so the serializer is handed in. Measuring one
    // shape and writing another is how a cap quietly stops capping.
    return fitRunRecord(record, this.maxBytes, serialize);
  }

  /** Every stored run for an agent, newest first. Unreadable files are skipped. */
  list(agentId: string, limit?: number): RunListEntry[] {
    const dir = this.dirFor(agentId, false);
    if (!dir) return [];
    const out: RunListEntry[] = [];
    for (const id of this.idsNewestFirst(dir).slice(0, atLeastOne(limit, this.keep))) {
      const target = this.fileFor(dir, id);
      if (!target) continue;
      const found = readRecord(target);
      if (found.record) {
        // the SAME row-builder the hub uses, so a list drawn from disk and a list
        // drawn from the hub say the same words about the same run
        out.push(runListEntry(found.record));
        continue;
      }
      // TORN, NOT LOST. The bytes were read fine and are not a record — half a
      // file from a version that wrote straight to the final name, or something
      // truncated. It holds no information and it is holding a retention slot,
      // so it goes. Anything we merely failed to READ (busy, locked, no
      // permission) is left exactly where it is.
      if (found.junk) this.discard(target);
    }
    return out;
  }

  /** One stored run, or undefined if it is missing or unreadable. */
  read(agentId: string, runId: string): RunRecord | undefined {
    const dir = this.dirFor(agentId, false);
    if (!dir) return undefined;
    const target = this.fileFor(dir, runId);
    if (!target) return undefined;
    return readRecord(target).record;
  }

  /**
   * Delete everything past the keep limit, oldest first — plus any half-written
   * file left by a turn that was interrupted mid-save.
   *
   * `this.keep` is at least 1 by construction (see `atLeastOne`), so this can
   * never be asked to leave an agent with nothing.
   */
  prune(agentId: string): number {
    const dir = this.dirFor(agentId, false);
    if (!dir) return 0;
    let removed = 0;
    for (const name of this.namesIn(dir)) {
      if (!name.includes(PENDING)) continue;
      if (this.discard(path.join(dir, name))) removed++;
    }
    for (const id of this.idsNewestFirst(dir).slice(this.keep)) {
      const target = this.fileFor(dir, id);
      if (!target) continue;
      if (this.discard(target)) removed++;
    }
    return removed;
  }

  /** Remove one file we are sure carries nothing worth keeping. */
  private discard(target: string): boolean {
    try { fs.rmSync(target); return true; } catch { return false; /* gone, or busy */ }
  }

  /** Delete every run an agent has. Used when an agent is removed. */
  forget(agentId: string): void {
    const dir = this.dirFor(agentId, false);
    if (!dir) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) {
      this.log(`[engine] could not clear the runs for agent ${agentId}: ${String(err)}`);
    }
  }

  /**
   * The one place a record is turned into bytes. Indented on purpose: a run
   * record is something a person may end up opening in Notepad, and the size
   * cap is measured against this exact text.
   */

  /** Run ids are time-ordered by construction, so the name IS the sort key. */
  private idsNewestFirst(dir: string): string[] {
    // a half-written record is `<id>.json.tmp-…`, which does not end in `.json`,
    // so it is invisible here — it can neither be listed nor fill a keep slot
    return this.namesIn(dir)
      .filter(n => n.endsWith(".json"))
      .map(n => n.slice(0, -".json".length))
      .sort()
      .reverse();
  }

  private namesIn(dir: string): string[] {
    try { return fs.readdirSync(dir); } catch { return []; }
  }
}

/**
 * Read one file and say WHICH kind of nothing came back, because the two need
 * opposite treatment: bytes that are not a record are junk holding a slot and
 * should go, while a file we could not read at all may be perfectly good and
 * merely busy, and deleting it would be the bug.
 */
function readRecord(target: string): { record?: RunRecord; junk?: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch {
    return {}; // could not read it — say nothing, touch nothing
  }
  try {
    const parsed = JSON.parse(text) as RunRecord;
    if (parsed && typeof parsed === "object" && parsed.id) return { record: parsed };
  } catch { /* falls through to junk */ }
  return { junk: true };
}

function serialize(record: RunRecord): string {
  return JSON.stringify(record, null, 2);
}
