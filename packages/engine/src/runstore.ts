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
import { isSafeSkillFileName } from "@cloud9/shared";
import { RunRecord, RUN_LIMITS, summarizeRun } from "./runrecord.js";

export interface RunStoreOptions {
  /** the agent's own folder — the engine already owns this decision */
  agentDataDir: (agentId: string) => string;
  /** how many runs to keep per agent before the oldest are deleted */
  keepPerAgent?: number;
  /** a single record may not exceed this on disk */
  maxBytes?: number;
  log?: (message: string) => void;
}

/** A run as it appears in a list, without loading every step. */
export interface RunListEntry {
  id: string;
  kind: RunRecord["kind"];
  outcome: RunRecord["outcome"];
  startedAt: number;
  durationMs: number;
  ask: string;
  /** the plain-words line, rebuilt from the record it came from */
  summary: string;
}

export const RUN_STORE_DEFAULTS = { keepPerAgent: 50, maxBytes: 64 * 1024 } as const;

export class RunStore {
  private keep: number;
  private maxBytes: number;
  private log: (message: string) => void;

  constructor(private opts: RunStoreOptions) {
    this.keep = opts.keepPerAgent ?? RUN_STORE_DEFAULTS.keepPerAgent;
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
    try {
      fs.writeFileSync(target, serialize(this.fit(record)), "utf8");
      this.prune(record.agentId);
      return target;
    } catch (err) {
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
    let out = record;
    // measured with the SAME serializer that writes the file — measuring one
    // shape and writing another is how a cap quietly stops capping
    while (serialize(out).length > this.maxBytes && out.steps.length > 2) {
      const half = Math.max(1, Math.floor(out.steps.length / 2));
      out = {
        ...out,
        steps: [...out.steps.slice(0, half - 1), ...out.steps.slice(half + 1)],
        truncated: true,
      };
    }
    if (serialize(out).length > this.maxBytes) {
      out = { ...out, steps: [], truncated: true, ask: out.ask.slice(0, RUN_LIMITS.ask) };
    }
    return out;
  }

  /** Every stored run for an agent, newest first. Unreadable files are skipped. */
  list(agentId: string, limit = this.keep): RunListEntry[] {
    const dir = this.dirFor(agentId, false);
    if (!dir) return [];
    const out: RunListEntry[] = [];
    for (const id of this.idsNewestFirst(dir).slice(0, limit)) {
      const record = this.read(agentId, id);
      if (!record) continue;
      out.push({
        id: record.id,
        kind: record.kind,
        outcome: record.outcome,
        startedAt: record.startedAt,
        durationMs: record.durationMs,
        ask: record.ask,
        summary: summarizeRun(record),
      });
    }
    return out;
  }

  /** One stored run, or undefined if it is missing or unreadable. */
  read(agentId: string, runId: string): RunRecord | undefined {
    const dir = this.dirFor(agentId, false);
    if (!dir) return undefined;
    const target = this.fileFor(dir, runId);
    if (!target) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(target, "utf8")) as RunRecord;
      return parsed && typeof parsed === "object" && parsed.id ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  /** Delete everything past the keep limit, oldest first. */
  prune(agentId: string): number {
    const dir = this.dirFor(agentId, false);
    if (!dir) return 0;
    const ids = this.idsNewestFirst(dir);
    let removed = 0;
    for (const id of ids.slice(this.keep)) {
      const target = this.fileFor(dir, id);
      if (!target) continue;
      try { fs.rmSync(target); removed++; } catch { /* it is already gone, or busy */ }
    }
    return removed;
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
    try {
      return fs.readdirSync(dir)
        .filter(n => n.endsWith(".json"))
        .map(n => n.slice(0, -".json".length))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }
}

function serialize(record: RunRecord): string {
  return JSON.stringify(record, null, 2);
}
