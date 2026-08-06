// WHAT AN AGENT REMEMBERS BETWEEN CONVERSATIONS — per-agent, durable,
// append-only, and bounded. See docs/plans/agent-memory-handoff.md.
//
// `context.ts` widens the window on ONE conversation; it deliberately does
// not remember yesterday's. This module is the other door: the notes an
// agent keeps about its owner and its work that survive the app closing and
// seed the NEXT conversation's context.
//
// THE BUDGET IDEA IS REUSED, NOT THE BUDGET. The same shape — a named
// constant, a character-and-count budget, a single rendering function —
// without `context.ts` being edited. The two budgets are SEPARATE facts.
//
// APPEND-ONLY. A note is never edited in place and never silently dropped.
// It is either kept (it earned a slot) or refused before it lands (it was
// noise). When an agent has more notes than its budget, the OLDEST are
// pruned — memory is a foundation, and the foundation goes first when the
// room runs out, the opposite of the conversation window.
//
// NOT IN SCOPE: writing these notes from inside a run. This module is the
// STORE and the RULE. `context.ts`, `engine.ts`, `host.ts` and `provider.ts`
// are not this file's to touch.
import fs from "node:fs";
import path from "node:path";
import { isSafeStoredId, MemoryKind, MemoryNote } from "@cloud9/shared";
import { writeWholeFile, isPendingName } from "./wholefile.js";

// THE WIRE SHAPES MOVED, not the rules. `MemoryKind` and `MemoryNote` are shown
// on a screen the hub serves, so their one definition lives in `@cloud9/shared`
// — the same move `RunRecord` made. They are re-exported here so `@cloud9/engine`
// keeps its published surface and every existing importer keeps working; the
// STORE, the RULE (`worthRemembering`) and the retrieval below are still the
// engine's and still live here.
export type { MemoryKind, MemoryNote } from "@cloud9/shared";

// --------------------------------------------------------------- the budget

/**
 * How much of an agent's own memory is brought into a turn.
 *
 * **Why characters and not notes.** A note can be ten characters or two
 * thousand, and counting notes is counting the wrong unit. The character
 * budget is the same size every time, whatever shape the memory takes.
 *
 * **Why 8,000.** Roughly 2,000 tokens. Every model Cloud9 can run an agent
 * on has a window of at least 200,000, so seeding memory costs about 1% of
 * the smallest one — less than the conversation window costs, on purpose,
 * because memory is background and the conversation is foreground.
 *
 * **Why a note ceiling as well.** A room of one-character notes would spend
 * 8,000 characters on eight thousand lines. 200 notes is where a memory
 * stops being a foundation and starts being a dump.
 *
 * **Why not bigger.** Every character here is re-sent on every single turn,
 * and it is the owner's own subscription paying. Widening this is a decision
 * somebody makes on purpose, which is why it is a named constant and not a
 * default argument.
 */
export const MEMORY_BUDGET = {
  /** the most characters of memory an agent is seeded with per turn */
  characters: 8_000,
  /** the most notes, however short they are */
  notes: 200,
} as const;

export interface MemoryBudget {
  characters: number;
  notes: number;
}

/**
 * The most characters a single note may carry. A candidate longer than this
 * is REFUSED by `worthRemembering`, not truncated: a memory silently cut in
 * half is a memory that says something its author did not mean.
 */
export const MEMORY_NOTE_LIMIT = 500;

/**
 * The most notes an agent keeps on disk before the oldest are pruned. This is
 * the STORE cap, separate from the SEED cap in `MEMORY_BUDGET`: an agent may
 * have a thousand notes on disk and only bring the oldest 200 into any one
 * turn. Pruning at the store cap keeps the disk honest; seeding at the
 * memory budget keeps the turn affordable.
 */
export const MEMORY_STORE_KEEP = 1_000;

/**
 * The most notes an agent may write about ONE turn, through its own
 * `remember_this` tool (gap A, 2026-08-05).
 *
 * **Why there is a ceiling at all.** The owner's `!remember` is one note because
 * he typed one. An agent's is a tool it can call in a loop, and a confused agent
 * in a loop is not a theory — it is the ordinary failure of every tool that
 * writes. Without a ceiling, one bad turn could push a hundred lines of its own
 * chatter into a store that seeds every future turn, and the notes that mattered
 * would be the ones dropped.
 *
 * **Why three.** A turn that genuinely learned four durable things about its
 * owner is rarer than a turn that has lost the plot. Three is enough for a real
 * turn and short enough that a runaway one costs almost nothing; the refusal
 * says so in plain words, so the agent knows it hit a limit rather than
 * believing it saved something it did not.
 *
 * It is a SEED cap, not a store cap: nothing already written is touched, and the
 * next turn starts with three again.
 */
export const MEMORY_NOTES_PER_TURN = 3;

// --------------------------------------------------------------- the shapes

/**
 * The kinds of thing an agent remembers. The kind is carried so a future
 * retrieval can weight a `decision` over a `fact` without re-reading the
 * text. Today retrieval does not weight — it keeps the oldest within budget
 * — but the kind is recorded now so the wire shape does not change later.
 */
// `MemoryKind` and `MemoryNote` are defined once, in `@cloud9/shared`, and
// re-exported at the top of this file. The kind is carried so a future
// retrieval can weight a `decision` over a `fact` without re-reading the text.

/** What an engine hands to `save` when it wants an agent to remember something. */
export interface RememberInput {
  agentId: string;
  text: string;
  kind?: MemoryKind;
  runId?: string;
  source?: MemoryNote["source"];
  at?: number;
}

// --------------------------------------------------------------- the rule

/**
 * Should this candidate be kept as a memory, or is it noise?
 *
 * The rule is the gate the whole module leans on: an agent that remembered
 * everything would remember nothing, because the noise would push the signal
 * out of its own budget. So a candidate is refused, in plain words, when it
 * is too short to be a fact, too long to be a note, a question, or a
 * pleasantry.
 *
 * Returns `{ keep, reason }` so the caller can LOG a refusal (the same way
 * `RunStore` logs a damaged record) rather than swallow it. A refusal that
 * nobody heard is how an agent ends up remembering nothing and nobody knows
 * why.
 */
export function worthRemembering(text: string): { keep: boolean; reason?: string } {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { keep: false, reason: "the note was empty" };
  // the words an agent says to be polite are not worth a slot — checked BEFORE
  // the length rules, because "thanks" is short enough to be refused twice
  // over and the more specific reason is the one a person reads
  const pleasantries = [
    "thanks", "thank you", "ok", "okay", "done", "got it", "understood",
    "will do", "sure", "yes", "no", "nope", "yep", "cool", "great", "sounds good",
  ];
  if (pleasantries.includes(trimmed.toLowerCase().replace(/[.!]+$/, ""))) {
    return { keep: false, reason: "a pleasantry is not a memory" };
  }
  if (trimmed.length < 8) return { keep: false, reason: "the note was too short to be a fact" };
  if (trimmed.length > MEMORY_NOTE_LIMIT) {
    return { keep: false, reason: `the note was longer than ${MEMORY_NOTE_LIMIT} characters` };
  }
  // a question is not a memory — it is the absence of one
  if (trimmed.endsWith("?") && !/[.!:]/.test(trimmed.slice(0, -1))) {
    return { keep: false, reason: "a question is not a memory" };
  }
  return { keep: true };
}

// --------------------------------------------------------------- the id

/**
 * A memory id that is also a safe file name and sorts by time. The same shape
 * as `newRunId` in `runrecord.ts`, with an `m-` prefix so a memory and a run
 * can never share an id and a folder can hold both without confusion. No
 * underscores: the shared file-name rule does not allow them.
 */
export function newMemoryId(now = Date.now(), rand = Math.random): string {
  const time = now.toString(36).padStart(9, "0");
  const noise = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0");
  return `m-${time}-${noise}`;
}

// --------------------------------------------------------------- the store

export interface MemoryStoreOptions {
  /** the agent's own folder — the engine already owns this decision */
  agentDataDir: (agentId: string) => string;
  /** how many notes to keep per agent on disk before the oldest are pruned */
  keepPerAgent?: number;
  log?: (message: string) => void;
}

export const MEMORY_STORE_DEFAULTS = {
  keepPerAgent: MEMORY_STORE_KEEP,
} as const;

/**
 * Where an agent's memory lives so it survives the app closing. One file per
 * note, inside the agent's OWN folder:
 *
 *   <dataDir>/agents/<agentId>/memory/m-<time>-<noise>.json
 *
 * SAFE PATHS HAVE ONE OWNER — `isSafeStoredId` is the same rule the relay,
 * `RunStore` and `Engine.writeSkillFiles` already use, asked of BOTH the id
 * and the name it turns into. The finished path is then checked with the same
 * `path.relative` backstop. A second, subtly different rule is how a hole
 * gets opened, so there isn't one.
 *
 * FAIL SAFE. Nothing in here throws at its caller. If the disk is full, the
 * folder is read-only, or the JSON is corrupt, the next turn still gets
 * whatever memory it could read and the failure goes to the log — the same
 * promise `RunStore` makes for runs.
 */
export class MemoryStore {
  private keep: number;
  private log: (message: string) => void;

  constructor(private opts: MemoryStoreOptions) {
    this.keep = atLeastOne(opts.keepPerAgent, MEMORY_STORE_DEFAULTS.keepPerAgent);
    this.log = opts.log ?? ((m: string) => console.error(m));
  }

  /**
   * Write one note. Returns the path it landed at, or undefined if it could
   * not be written — never throws, because a turn must not fail over its own
   * paperwork.
   */
  save(note: MemoryNote): string | undefined {
    const dir = this.dirFor(note.agentId, true);
    if (!dir) {
      this.log(`[engine] refused to store a memory for agent ${note.agentId}: unusable folder`);
      return undefined;
    }
    const target = this.fileFor(dir, note.id);
    if (!target) {
      this.log(`[engine] refused to store memory ${note.id}: unusable name`);
      return undefined;
    }
    // WRITE THEN RENAME — through the one owner of that rule, `wholefile.ts`,
    // so a power cut between "empty the file" and "fill it" can never leave
    // half a note under a name `list` trusts.
    const written = writeWholeFile(target, serialize(note),
      m => this.log(`[engine] could not store memory ${note.id}: ${m}`));
    if (!written) return undefined;
    this.prune(note.agentId);
    return target;
  }

  /** Every stored note for an agent, oldest first. Unreadable files are skipped. */
  list(agentId: string, limit?: number): MemoryNote[] {
    const dir = this.dirFor(agentId, false);
    if (!dir) return [];
    const out: MemoryNote[] = [];
    for (const id of this.idsOldestFirst(dir).slice(0, atLeastOne(limit, this.keep))) {
      const target = this.fileFor(dir, id);
      if (!target) continue;
      const found = readNote(target);
      if (found.note) {
        out.push(found.note);
        continue;
      }
      // TORN, NOT LOST — same finding as RunStore. Bytes that are not a note
      // carry nothing and hold a slot, so they go, AND IT IS SAID OUT LOUD.
      if (found.junk) {
        this.log(`[engine] memory ${id} for agent ${agentId} is damaged (${found.reason}) — ` +
          `it is not a memory note, so it is being left out of the list and removed`);
        this.discard(target);
      }
    }
    return out;
  }

  /** One stored note, or undefined if it is missing or damaged. */
  read(agentId: string, noteId: string): MemoryNote | undefined {
    const dir = this.dirFor(agentId, false);
    if (!dir) return undefined;
    const target = this.fileFor(dir, noteId);
    if (!target) return undefined;
    const found = readNote(target);
    if (found.junk) {
      this.log(`[engine] refused memory ${noteId} for agent ${agentId}: ${found.reason} — ` +
        `the file on disk is not a whole memory note`);
    }
    return found.note;
  }

  /** Delete everything past the keep limit, oldest first, plus any torn file. */
  prune(agentId: string): number {
    const dir = this.dirFor(agentId, false);
    if (!dir) return 0;
    let removed = 0;
    for (const name of this.namesIn(dir)) {
      if (!isPendingName(name)) continue;
      if (this.discard(path.join(dir, name))) removed++;
    }
    const ids = this.idsOldestFirst(dir);
    if (ids.length <= this.keep) return removed;
    for (const id of ids.slice(this.keep)) {
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

  /**
   * Forget ONE note by id — what the "clear this" button on the memory panel
   * does. Returns whether a file was removed. It asks the SAME owners of the
   * safe-path rule that `save` and `list` do (`dirFor`/`fileFor`), so there is
   * no second, subtly different way to turn an id into a path. An unsafe or
   * missing id removes nothing and says so by returning false — it never throws,
   * because clearing a note the owner can see must never cost them an answer.
   */
  forgetNote(agentId: string, noteId: string): boolean {
    const dir = this.dirFor(agentId, false);
    if (!dir) return false;
    const target = this.fileFor(dir, noteId);
    if (!target) return false;
    return this.discard(target);
  }

  /** Delete every note an agent has. Used when an agent is removed. */
  forget(agentId: string): void {
    const dir = this.dirFor(agentId, false);
    if (!dir) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (err) {
      this.log(`[engine] could not clear the memory for agent ${agentId}: ${String(err)}`);
    }
  }

  private dirFor(agentId: string, create: boolean): string | undefined {
    try {
      const base = path.resolve(this.opts.agentDataDir(agentId));
      const dir = path.resolve(path.join(base, "memory"));
      const rel = path.relative(base, dir);
      if (rel !== "memory") return undefined;
      if (create) fs.mkdirSync(dir, { recursive: true });
      return dir;
    } catch (err) {
      this.log(`[engine] could not open the memory folder for agent ${agentId}: ${String(err)}`);
      return undefined;
    }
  }

  private fileFor(dir: string, noteId: string): string | undefined {
    const name = `${noteId}.json`;
    if (!isSafeStoredId(noteId) || !isSafeStoredId(name)) return undefined;
    const target = path.resolve(path.join(dir, name));
    if (path.relative(dir, target) !== name) return undefined;
    return target;
  }

  private idsOldestFirst(dir: string): string[] {
    return this.namesIn(dir)
      .filter(n => n.endsWith(".json"))
      .map(n => n.slice(0, -".json".length))
      .sort();
  }

  private namesIn(dir: string): string[] {
    try { return fs.readdirSync(dir); } catch { return []; }
  }
}

// --------------------------------------------------------------- retrieval

/**
 * The memory an agent is seeded with for one turn, as a single string.
 *
 * NEWEST KEPT, OLDEST DROPPED (fixed 2026-08-05 — see the note below).
 *
 * The budget is spent from the NEWEST end backwards, and the OLDEST note is
 * what goes when the room runs out. The reason is the one thing memory is for:
 * a note is only worth carrying if it is still TRUE, and the newest note is the
 * one most likely to be. When the owner corrects an agent today, that
 * correction is the newest note there is — and under the old order it was the
 * FIRST thing dropped, while the very note it corrected (older, therefore
 * kept) went on being seeded into every turn. The agent then confidently
 * repeated the thing it had just been told was wrong, and nobody could see why.
 *
 * The old comment argued the other way: that the newest note is probably still
 * in the conversation window, so dropping it costs least. That is true of a
 * note made MINUTES ago and false of everything else — memory is read at the
 * start of a NEW conversation, where nothing at all is still in the window.
 *
 * WHAT IS KEPT IS STILL RENDERED OLDEST-FIRST, so an agent reads its memory in
 * the order the notes were made. Only the DROPPING end changed.
 *
 * A note longer than the whole budget is still included — truncated, and it
 * says so — because dropping it would leave the agent without the one note
 * that wanted to be heard. That privilege belongs to the NEWEST note, because
 * that is the one the budget is now spent on first.
 *
 * `notes` are assumed oldest-first (the order `MemoryStore.list` returns
 * them in). The rendering is one exported function so there is one place to
 * change how memory reads, the same way `renderConversation` is one place
 * to change how conversation reads.
 */
export function retrieveMemory(
  notes: readonly MemoryNote[],
  budget: MemoryBudget = MEMORY_BUDGET,
): string {
  if (notes.length === 0) return "";
  const kept: string[] = [];
  let spent = 0;
  // GAP B FIX (2026-08-05): spend from the NEWEST end backwards, so the OLDEST
  // note is dropped first when the room runs out. `notes` are assumed
  // oldest-first (the order `MemoryStore.list` returns them in), so the walk
  // runs backwards and what survives is turned back the right way round before
  // it is joined — the agent still reads its memory oldest-first.
  for (let i = notes.length - 1; i >= 0; i--) {
    if (kept.length >= budget.notes) break;
    let line = renderNote(notes[i]);
    if (spent > 0 && spent + line.length + 1 > budget.characters) break;
    if (line.length > budget.characters) {
      line = line.slice(0, budget.characters) + " …(this note was too long to show in full)";
    }
    kept.push(line);
    spent += line.length + 1;
  }
  return kept.reverse().join("\n");
}

/**
 * One note, the way an agent reads it back. The kind is named (so a
 * `decision` reads differently from a `fact`), the source is named (so the
 * agent can tell its own notes from its owner's), and the text is verbatim.
 */
function renderNote(n: MemoryNote): string {
  const who = n.source === "owner" ? "owner" : n.source === "system" ? "system" : "self";
  return `- (${n.kind}, from ${who}) ${n.text}`;
}

// --------------------------------------------------------------- helpers

/** A keep or a limit that could never make sense, turned into one that can. */
function atLeastOne(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const whole = Math.floor(value);
  return whole >= 1 ? whole : fallback;
}

/**
 * Read one file and say WHICH kind of nothing came back, because the two need
 * opposite treatment: bytes that are not a note are junk holding a slot and
 * should go, while a file we could not read at all may be perfectly good and
 * merely busy, and deleting it would be the bug. The same split as `RunStore`.
 */
function readNote(target: string): { note?: MemoryNote; junk?: boolean; reason?: string } {
  let text: string;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch {
    return {}; // could not read it — say nothing, touch nothing
  }
  if (text.trim().length === 0) return { junk: true, reason: "the file is empty" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { junk: true, reason: "the text stops part-way through" };
  }
  const problem = validateNote(parsed);
  if (problem) return { junk: true, reason: problem };
  return { note: parsed as MemoryNote };
}

/**
 * The ONE rule about what a memory note is, asked of every file coming off
 * the disk. A half-record is not a record, and neither is a nonsense one —
 * `{"id":42,"text":"soup"}` has every key a key-counting rule would accept
 * and means nothing. Every field is type-checked, the way
 * `validateRunRecord` checks a run.
 */
export function validateNote(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "the file does not hold a memory note at all";
  }
  const n = value as Record<string, unknown>;
  if (typeof n.id !== "string" || !isSafeStoredId(n.id)) {
    return "a memory note needs a safe id";
  }
  if (typeof n.agentId !== "string" || n.agentId.length === 0) {
    return "a memory note belongs to an agent";
  }
  if (typeof n.kind !== "string" ||
    !["fact", "preference", "decision", "outcome", "correction"].includes(n.kind)) {
    return "a memory note is a fact, a preference, a decision, an outcome or a correction";
  }
  if (typeof n.text !== "string" || n.text.length === 0) {
    return "a memory note needs text";
  }
  if (typeof n.createdAt !== "number" || !Number.isFinite(n.createdAt)) {
    return "the note's time isn't a number";
  }
  if (n.runId !== undefined && (typeof n.runId !== "string" || !isSafeStoredId(n.runId))) {
    return "a run link must be a safe id";
  }
  if (n.source !== "agent" && n.source !== "owner" && n.source !== "system") {
    return "a memory note says who wrote it";
  }
  return null;
}

function serialize(note: MemoryNote): string {
  return JSON.stringify(note, null, 2);
}
