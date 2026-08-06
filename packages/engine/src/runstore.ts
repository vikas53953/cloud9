// Where run records live so they survive the app closing.
//
// One file per run, inside the agent's OWN folder, under the engine's existing
// data directory:
//
//   <dataDir>/agents/<agentId>/runs/r-<time>-<noise>.json
//
// SAFE PATHS HAVE ONE OWNER. This module writes no rule of its own: the file
// the id is checked with `isSafeStoredId` — the same function the relay and
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
  CountableRun, RunListEntry, RunRecord, RUN_RETENTION, fitRunRecord, isSafeStoredId,
  runListEntry, spendMonthKey, validateRunRecord,
} from "@cloud9/shared";
import { isPendingName, writeWholeFile } from "./wholefile.js";

export type { RunListEntry };

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
 * HOW MUCH HISTORY IS KEPT IS ONE FACT, NOT TWO.
 *
 * `RUN_RETENTION` in `@cloud9/shared` is what the hub keeps; this store keeps
 * the same amounts on disk. Every number here is DERIVED from that one source,
 * never written out again:
 *
 *   - `keepPerAgent` ← `RUN_RETENTION.perAgent` — how many runs an agent keeps.
 *   - `maxBytes`     ← `RUN_RETENTION.bytes`    — how big one stored run may be.
 *
 * `maxBytes` was a second `64 * 1024` sitting here, unconnected to the hub's.
 * Two equal numbers in two packages are the drift itself, not the safety: raise
 * the hub's cap and the engine silently keeps trimming to the old one, so the
 * SAME run has its steps on one screen and missing on another and nothing says
 * why. A comment asking the next person to keep them in step is not a fix; the
 * fix is that there is only one number and a test that fails if either line
 * stops deriving it.
 */
/**
 * How far past its retention count an agent's runs may pile up while the
 * spending total refuses to be written, before they are deleted anyway.
 * See `tooManyToKeep`.
 */
const PRUNE_ANYWAY_MULTIPLE = 4;

export const RUN_STORE_DEFAULTS = {
  keepPerAgent: RUN_RETENTION.perAgent,
  maxBytes: RUN_RETENTION.bytes,
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
    // The SAME rule the hub applies to a run id — one owner, no second opinion —
    // asked of BOTH the id and the name it turns into. Asking only about the id
    // let `trailing.` through, because the id itself has no `..` in it; it is
    // `trailing..json` that lands on the disk. The thing being written is the
    // NAME, so the name is what has to pass.
    if (!isSafeStoredId(runId) || !isSafeStoredId(name)) return undefined;
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
    // WRITE THEN RENAME — through the one owner of that rule, `wholefile.ts`.
    // `writeFileSync` straight to the final name meant a turn interrupted
    // mid-write — the app closing, the machine sleeping, a full disk — left half
    // a file under a name `list` trusts. It parsed as nothing, so it showed
    // nothing, and it still counted towards the 50 kept runs, so it pushed a
    // real run out and then sat there for ever.
    const written = writeWholeFile(target, serialize(this.fit(record)),
      m => this.log(`[engine] could not store run ${record.id}: ${m}`));
    if (!written) return undefined;
    this.prune(record.agentId);
    return target;
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
      // so it goes, AND IT IS SAID OUT LOUD. Refusing something in silence is
      // how "one run is missing" turns into an afternoon of guessing.
      // Anything we merely failed to READ (busy, locked, no permission) is left
      // exactly where it is.
      if (found.junk) {
        this.log(`[engine] run ${id} for agent ${agentId} is damaged (${found.reason}) — ` +
          `it is not a run record, so it is being left out of the list and removed`);
        this.discard(target);
      }
    }
    return out;
  }

  /**
   * One stored run, or undefined if it is missing or damaged.
   *
   * REFUSES IN PLAIN WORDS. A damaged file is never half-believed and never
   * passed back as a partly-filled record: the caller gets nothing, and the log
   * gets a sentence saying which run it was and what was wrong with it.
   */
  read(agentId: string, runId: string): RunRecord | undefined {
    const dir = this.dirFor(agentId, false);
    if (!dir) return undefined;
    const target = this.fileFor(dir, runId);
    if (!target) return undefined;
    const found = readRecord(target);
    if (found.junk) {
      this.log(`[engine] refused run ${runId} for agent ${agentId}: ${found.reason} — ` +
        `the file on disk is not a whole run record`);
    }
    return found.record;
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
      if (!isPendingName(name)) continue;
      if (this.discard(path.join(dir, name))) removed++;
    }
    // WHAT IS ABOUT TO BE FORGOTTEN IS COUNTED FIRST. A run that leaves this
    // folder must not take what it cost out of the month's total with it —
    // otherwise a spending limit would drift upwards the harder an agent
    // worked, which is precisely backwards. Read BEFORE the delete, carried
    // forward BEFORE the delete, so a crash between the two can only ever
    // count a run twice as still-present, never lose it. See `spentInMonth`.
    const doomed: RunRecord[] = [];
    const targets: string[] = [];
    for (const id of this.idsNewestFirst(dir).slice(this.keep)) {
      const target = this.fileFor(dir, id);
      if (!target) continue;
      targets.push(target);
      const record = readRecord(target).record;
      if (record) doomed.push(record);
    }
    // AND IF IT COULD NOT BE WRITTEN DOWN, NOTHING IS DELETED. Keeping a run
    // one turn longer costs a retention slot and fixes itself next time; losing
    // what it cost makes the owner's spending limit quietly stop being a limit.
    // See `carryForward`.
    //
    // BUT A GUARD THAT CAN NEVER RELEASE IS ITSELF A LEAK, so it has a ceiling.
    // In practice the things that stop the total being written — a full disk, an
    // unwritable folder — stop run records being written too, so the pile cannot
    // grow. The case this covers is the odd one out: that ONE file locked (a
    // virus scanner holding a handle, a stale lock) while records still save
    // fine. Left alone, retention would stop for ever and his data folder would
    // fill with run records. So past a hard ceiling the runs go anyway, and the
    // log SAYS the month's total is now understated — an announced undercount
    // beats both a silent one and a folder that grows without end.
    if (!this.carryForward(agentId, doomed) && !this.tooManyToKeep(dir)) return removed;
    for (const target of targets) {
      if (this.discard(target)) removed++;
    }
    return removed;
  }

  // ==================================================================
  // WHAT THIS AGENT HAS SPENT THIS MONTH — a query, not a second system
  // ==================================================================
  //
  // Cloud9 already writes down what every turn cost: `usage.costUsd` on the run
  // record, taken from the Claude app's own `total_cost_usd` and never
  // estimated. This store is where all of an agent's records live, so "how much
  // has it spent" is a sum over what is already here — there is no ledger of
  // spending to keep in step with the records, because a second number is a
  // second number that can be wrong.
  //
  // THE ONE HOLE IN THAT, AND HOW IT IS CLOSED. An agent keeps its most recent
  // runs and no more (`RUN_RETENTION.perAgent`), so a busy month would have its
  // earliest turns deleted and a plain sum would quietly forget them — the cap
  // would then drift UPWARDS the harder the agent worked, which is the exact
  // opposite of what a cap is for. `prune` below is the ONLY place a run is
  // ever deleted, so it is also the place the deleted amount is carried
  // forward, per month, into `spent.ledger`. Nothing is counted twice: a run is
  // either still on disk (summed here) or gone (carried there), never both.
  //
  // HONEST LIMIT: Codex reports no money at all, so a Codex run contributes
  // nothing here and a Codex agent cannot be capped. `providerCanBeCapped` in
  // @cloud9/shared is the one owner of that fact, and the screen says it out
  // loud rather than showing a box that does nothing.

  /**
   * What this agent has spent in the calendar month containing `at`, in
   * dollars — every run that reported a figure, plus what was carried forward
   * from runs since deleted.
   *
   * Never throws. A folder we cannot read reads as 0, which is the fail-open
   * direction on purpose: a ceiling that cannot be measured must not become a
   * crew that has silently stopped working.
   */
  spentInMonth(agentId: string, at = Date.now()): number {
    const month = spendMonthKey(at);
    let total = this.carriedSpend(agentId)[month] ?? 0;
    const dir = this.dirFor(agentId, false);
    if (!dir) return total;
    for (const id of this.idsNewestFirst(dir)) {
      const target = this.fileFor(dir, id);
      if (!target) continue;
      const record = readRecord(target).record;
      if (!record) continue;
      total += costInMonth(record, month);
    }
    return total;
  }

  /**
   * EVERY STORED RUN OF THIS AGENT, AS SOMETHING THAT CAN BE ADDED UP.
   *
   * `spentInMonth` above answers ONE question — "may this turn start?" — and it
   * answers it as a single number, because that is all a ceiling needs. The
   * spending screen and Cloud9's own `check_token_use` tool need something
   * else: WHERE the money went, how much of it was material handed to the agent
   * rather than work it did, and how much of it was spent with the owner's own
   * setup loaded. None of that survives being summed into one figure.
   *
   * SO IT IS THE SAME FILES, READ ONCE MORE — never a second ledger. Adding a
   * running "what this agent has cost, broken down" total on disk would be a
   * second number to keep in step with the records, and the comment above
   * `spentInMonth` explains at length why this store refuses to have one.
   *
   * WHAT IT DOES NOT HAND BACK, deliberately: no ask, no reply, no steps, no
   * error, no session id, no file names. A caller that wants to know what an
   * agent COST has no business being handed what it SAID — and the doorway that
   * uses this hands its answer to another agent, so the narrowness is a
   * boundary, not tidiness. `CountableRun` in @cloud9/shared is that boundary
   * written as a type.
   *
   * HONEST LIMIT, and it is the same one the spending total lives with: an
   * agent keeps only its most recent runs (`RUN_RETENTION.perAgent`), so a very
   * busy month's earliest turns are simply not here any more. Unlike the
   * spending total there is nothing carried forward, because a carried-forward
   * TOTAL cannot say what it was made of. Callers say how many runs this was
   * counted from, so a short answer reads as short rather than as small.
   */
  countableRuns(agentId: string, provider: string): CountableRun[] {
    const dir = this.dirFor(agentId, false);
    if (!dir) return [];
    const out: CountableRun[] = [];
    for (const id of this.idsNewestFirst(dir)) {
      const target = this.fileFor(dir, id);
      if (!target) continue;
      const record = readRecord(target).record;
      if (!record) continue;
      out.push({
        startedAt: record.startedAt,
        // THE RUN'S OWN PROVIDER, not the agent's as it is set up today. He can
        // move an agent from Codex to Claude, and a record that silently
        // re-describes itself when he does is not a record — the same law
        // `RunRecord.trust` and `RunRecord.ownerSetup` are written under. The
        // agent's current provider is only the fallback for a record from
        // before that field was written.
        provider: record.provider || provider,
        outcome: record.outcome,
        ...(typeof record.ownerSetup === "boolean" ? { ownerSetup: record.ownerSetup } : {}),
        ...(record.usage ? { usage: record.usage } : {}),
      });
    }
    return out;
  }

  /** The per-month totals of runs this store has already deleted. */
  private carriedSpend(agentId: string): Record<string, number> {
    const target = this.spendFile(agentId, false);
    if (!target) return {};
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(target, "utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
      const out: Record<string, number> = {};
      for (const [month, amount] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof amount === "number" && Number.isFinite(amount) && amount > 0) {
          out[month] = amount;
        }
      }
      return out;
    } catch {
      return {}; // missing, busy or damaged — 0 is the fail-open answer
    }
  }

  /**
   * Add what these about-to-be-deleted runs cost to the carried totals.
   *
   * RETURNS WHETHER THE MONEY IS SAFELY WRITTEN DOWN, and the caller is not
   * allowed to ignore it — `prune` deletes nothing until this says yes.
   *
   * WHY IT IS A BOOLEAN AND NOT A LOG LINE. This is the only moment a run's
   * cost can be lost: the record is about to be deleted, so if the carried
   * total does not reach the disk, that money leaves the month's sum for ever
   * and the owner's spending limit quietly gets LOOSER the harder his agent
   * works. Nothing would look broken; the cap would simply stop being a cap.
   * Keeping the run instead costs a retention slot for one more turn and is
   * self-healing — the next `prune` tries again — which makes "keep it" the
   * only honest answer to "we could not write the total down".
   */
  private carryForward(agentId: string, records: readonly RunRecord[]): boolean {
    if (records.length === 0) return true;
    const carried = this.carriedSpend(agentId);
    let changed = false;
    for (const record of records) {
      const cost = record.usage?.costUsd;
      if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) continue;
      const month = spendMonthKey(record.startedAt);
      carried[month] = (carried[month] ?? 0) + cost;
      changed = true;
    }
    // NOTHING TO CARRY IS A SUCCESS, not a failure. Runs with no money on them
    // — every Codex run, and any turn the CLI never costed — can be deleted
    // freely, because deleting them takes nothing out of the total.
    if (!changed) return true;
    const target = this.spendFile(agentId, true);
    if (!target) {
      this.log(`[engine] could not open the spending total for agent ${agentId} — `
        + `keeping these runs rather than losing what they cost`);
      return false;
    }
    // the same write-then-rename owner every other file here goes through, so a
    // power cut cannot leave half a total behind under a name we would believe
    return writeWholeFile(target, JSON.stringify(carried, null, 2),
      m => this.log(`[engine] could not carry forward what agent ${agentId} spent: ${m}`));
  }

  /**
   * Has the "keep it until the total is written" guard held so long that it has
   * become the bigger problem? See the note in `prune`.
   *
   * The ceiling is a MULTIPLE of the retention count rather than a number of its
   * own, so it moves with the setting it protects and there is nothing to keep
   * in step. Four times is enough that a scanner holding the file for a few
   * minutes never reaches it, and small enough that the folder cannot quietly
   * become thousands of records.
   */
  private tooManyToKeep(dir: string): boolean {
    const held = this.idsNewestFirst(dir).length;
    if (held <= this.keep * PRUNE_ANYWAY_MULTIPLE) return false;
    this.log(`[engine] the spending total could not be written for too long — `
      + `deleting ${held - this.keep} old run(s) anyway. What they cost is no longer `
      + `counted, so this agent's spending limit for this month now reads LOWER than it `
      + `really is until next month.`);
    return true;
  }

  /** Where the carried totals live — beside the runs, under the same path rules. */
  private spendFile(agentId: string, create: boolean): string | undefined {
    const dir = this.dirFor(agentId, create);
    if (!dir) return undefined;
    const target = path.resolve(path.join(dir, "spent.ledger"));
    if (path.relative(dir, target) !== "spent.ledger") return undefined;
    return target;
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
function readRecord(target: string): { record?: RunRecord; junk?: boolean; reason?: string } {
  let text: string;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch {
    return {}; // could not read it — say nothing, touch nothing
  }
  if (text.trim().length === 0) {
    // exactly what a power cut between "empty the file" and "fill it" leaves
    return { junk: true, reason: "the file is empty" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { junk: true, reason: "the text stops part-way through" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { junk: true, reason: "the file does not hold a run at all" };
  }
  // A HALF-RECORD IS NOT A RECORD — AND NEITHER IS A NONSENSE ONE.
  //
  // This used to ask only whether `id`, `agentId`, `startedAt` and `outcome`
  // were PRESENT. `{"id":42,"agentId":{},"startedAt":"soup","outcome":"banana"}`
  // passed every one of those and was handed on to the screen as a run.
  //
  // ONE JUDGE, NOT TWO. `validateRunRecord` in `@cloud9/shared` is the rule the
  // hub already applies to a record arriving over the wire, and it type-checks
  // every field rather than counting keys. A file coming off this disk is
  // untrusted for exactly the same reasons — a power cut, an older version, a
  // person with Notepad — so it is asked the same question by the same
  // function. A second checker here would be a second opinion, and two rules
  // that can disagree about the same object is the bug, not the safety.
  const problem = validateRunRecord(parsed);
  if (problem) return { junk: true, reason: problem };
  return { record: parsed as RunRecord };
}

function serialize(record: RunRecord): string {
  return JSON.stringify(record, null, 2);
}

/**
 * What this run cost, if it fell in the month asked about and if the app that
 * ran it reported a figure at all.
 *
 * NOTHING IS INFERRED, which is the same law the record itself is written
 * under: a run with no money on it contributes 0 rather than an estimate, and a
 * Codex run always has no money on it. The month is decided by when the turn
 * STARTED, so a turn that runs across midnight on the last of the month belongs
 * to the month the owner watched it start in.
 */
function costInMonth(record: RunRecord, month: string): number {
  const cost = record.usage?.costUsd;
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) return 0;
  return spendMonthKey(record.startedAt) === month ? cost : 0;
}
