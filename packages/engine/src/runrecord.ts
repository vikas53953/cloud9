// What an agent actually DID during a turn — the run record.
//
// Until now Cloud9 kept the last sentence an agent said and threw the rest
// away. Both harnesses already stream the detail: `codex exec --json` emits one
// JSON line per step, `claude -p --output-format stream-json` emits one JSON
// line per assistant message, tool call and tool result, then a final result
// envelope. This module is where those two streams become ONE shape.
//
// THE SEAM. There is exactly one stream walker (`traceFromStream`) and exactly
// one record/summary builder. A provider contributes only an `EventMapper` —
// a function that reads ONE already-parsed event and describes it in the shared
// vocabulary below. Everything after that point (capping, ordering, counting,
// summarising, redacting, storing) has a single implementation, so the Claude
// path and the Codex path cannot drift.
//
// THE HONESTY RULE. Nothing here invents, estimates or infers a number. If a
// CLI does not report a duration, a cost or an exit code, the field is absent —
// never zero, never "about". Absent means absent. The only figure this module
// measures itself is wall-clock time around the call, and it is labelled as
// such (`durationMs`, measured by Cloud9; `cliDurationMs`, claimed by the CLI).
import { redactForSharing } from "./provider.js";

// ---------------------------------------------------------------- vocabulary

/**
 * The kinds of thing an agent does, in words a non-developer reads. Both CLIs
 * map onto this list; anything we do not recognise becomes "tool" with the
 * tool's own name as the label, so a new tool shows up as a real step rather
 * than disappearing.
 */
export type RunStepKind =
  | "command"   // ran something on this computer
  | "read"      // opened a file
  | "write"     // wrote or changed a file
  | "search"    // searched files on this computer
  | "web"       // searched or fetched something online
  | "tool"      // used some other tool
  | "thinking"  // reasoning the CLI reported
  | "message"   // said something
  | "note";     // the CLI told us something about itself (a warning, a limit)

export interface RunStep {
  /** order within the run, from 1 */
  seq: number;
  kind: RunStepKind;
  /** short human label — "Read note.txt", "Ran a command" */
  label: string;
  /** the specific thing acted on. Redacted before it is ever shared. */
  detail?: string;
  /** true/false ONLY when the CLI reported an outcome. Absent = it did not. */
  ok?: boolean;
}

/** Token and money figures, each present only if the CLI reported it. */
export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  /** the CLI's own cost figure. Codex does not report one; Claude does. */
  costUsd?: number;
}

/** What one provider's stream told us. The single shape both CLIs produce. */
export interface ProviderTrace {
  provider: string;
  /** the agent's final chat message */
  text: string;
  steps: RunStep[];
  usage?: RunUsage;
  /** the CLI's own conversation id, for matching against its logs */
  sessionId?: string;
  /** the model the CLI says it actually used — not the one we asked for */
  model?: string;
  /** the CLI's own duration claim, when it makes one */
  cliDurationMs?: number;
  /** how many back-and-forths the CLI counted, when it counts them */
  numTurns?: number;
  /** a turn-level failure the CLI reported */
  error?: string;
  /** how many JSON events we understood */
  events: number;
  /** we stopped adding steps because the run blew the cap */
  truncated?: boolean;
}

export type RunOutcome = "ok" | "failed" | "cancelled";
export type RunKind = "chat" | "task" | "schedule";

/** One agent turn or one delegated job, start to finish. */
export interface RunRecord {
  id: string;
  /** chat reply, delegated job, or scheduled check-in */
  kind: RunKind;
  agentId: string;
  agentName: string;
  /** which app ran it: claude, codex, mock … */
  provider: string;
  /** the model we ASKED for (trace.model is what the CLI says it used) */
  model?: string;
  channelId?: string;
  taskId?: string;
  /** who asked — the person's name, not an id, so the record reads on its own */
  requestedBy: string;
  requestedByKind: "human" | "agent" | "schedule";
  /** what they asked for, trimmed */
  ask: string;
  startedAt: number;
  finishedAt: number;
  /** measured by Cloud9 around the call. Always present. */
  durationMs: number;
  outcome: RunOutcome;
  /** plain-words failure, already redacted. Absent on a clean run. */
  error?: string;
  steps: RunStep[];
  usage?: RunUsage;
  sessionId?: string;
  /** the model the CLI reported using */
  actualModel?: string;
  cliDurationMs?: number;
  numTurns?: number;
  /** how long the reply was, in characters — the reply text is NOT copied here */
  replyChars: number;
  /** JSON events we understood in the CLI's stream */
  events: number;
  /** steps were dropped to keep this record small */
  truncated?: boolean;
}

// -------------------------------------------------------------------- limits
//
// A run record must never be able to grow without bound: a runaway agent that
// reads ten thousand files would otherwise fill the owner's disk with the proof
// of it. Caps live here, in one place, and are applied by the walker.

export const RUN_LIMITS = {
  /** steps kept per run; the rest are counted and dropped */
  steps: 200,
  label: 120,
  detail: 300,
  ask: 500,
  error: 300,
  /** a single stream line longer than this is skipped, not parsed */
  line: 256 * 1024,
} as const;

// ------------------------------------------------------------------ the seam

/** What an EventMapper is handed, so it can describe an event. */
export interface TraceBuilder {
  /**
   * Record one thing the agent did. Returns the step's number so a later event
   * can finish it off — a CLI that announces a command and then reports its
   * exit code sends two events about ONE step, and a turn that is killed
   * half-way through still leaves the started step visible.
   * Returns undefined when the run has hit the step cap.
   */
  add(step: { kind: RunStepKind; label: string; detail?: string; ok?: boolean }): number | undefined;
  /** fill in what a later event told us about a step already recorded */
  update(seq: number | undefined, patch: { label?: string; detail?: string; ok?: boolean }): void;
  /** the agent's latest chat message — the LAST one wins */
  setText(text: string): void;
  /** a turn-level failure the CLI reported */
  setError(message: string): void;
  /** anything else the CLI told us about the run as a whole */
  set(patch: Partial<Pick<ProviderTrace,
    "sessionId" | "model" | "cliDurationMs" | "numTurns" | "usage">>): void;
}

/**
 * A provider's ONLY contribution to tracing: how to read one of its events.
 * It never splits lines, parses JSON, counts, caps or orders anything — the
 * walker owns all of that for both providers.
 *
 * A mapper may keep state for the stream it is reading (matching a tool's
 * result back to the call that started it), so providers hand over a FRESH one
 * per stream via a small factory rather than a shared singleton.
 */
export type EventMapper = (event: Record<string, unknown>, t: TraceBuilder) => void;

/**
 * Walk a CLI's output and build the shared trace.
 *
 * Fail-safe by construction: a line that is not JSON is skipped, a line that is
 * too big is skipped, and a mapper that throws on one event loses that event
 * and nothing else. A stream we cannot read at all yields an empty trace — it
 * never throws, because a recording problem must never cost the owner an answer.
 */
export function traceFromStream(raw: string, provider: string, map: EventMapper): ProviderTrace {
  const trace: ProviderTrace = { provider, text: "", steps: [], events: 0 };
  let dropped = 0;

  const builder: TraceBuilder = {
    add(step) {
      if (trace.steps.length >= RUN_LIMITS.steps) { dropped++; return undefined; }
      const seq = trace.steps.length + 1;
      trace.steps.push({
        seq,
        kind: step.kind,
        label: clip(step.label, RUN_LIMITS.label) || step.kind,
        ...(step.detail ? { detail: clip(step.detail, RUN_LIMITS.detail) } : {}),
        ...(typeof step.ok === "boolean" ? { ok: step.ok } : {}),
      });
      return seq;
    },
    update(seq, patch) {
      if (!seq) return;
      const step = trace.steps[seq - 1];
      if (!step) return;
      if (patch.label) step.label = clip(patch.label, RUN_LIMITS.label);
      if (patch.detail) step.detail = clip(patch.detail, RUN_LIMITS.detail);
      if (typeof patch.ok === "boolean") step.ok = patch.ok;
    },
    setText(text) { const t = text.trim(); if (t) trace.text = t; },
    setError(message) { const m = message.trim(); if (m) trace.error = clip(m, RUN_LIMITS.error); },
    set(patch) { Object.assign(trace, patch); },
  };

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    if (trimmed.length > RUN_LIMITS.line) continue;
    let event: Record<string, unknown>;
    try { event = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }
    trace.events++;
    try { map(event, builder); } catch (err) {
      console.error("[engine] could not read one line of a harness transcript:", err);
    }
  }
  if (dropped > 0) trace.truncated = true;
  return trace;
}

// ----------------------------------------------------------- building a record

export interface RunSeed {
  kind: RunKind;
  agentId: string;
  agentName: string;
  provider: string;
  model?: string;
  channelId?: string;
  taskId?: string;
  requestedBy: string;
  requestedByKind: "human" | "agent" | "schedule";
  ask: string;
  startedAt: number;
}

export interface RunFinish {
  finishedAt: number;
  outcome: RunOutcome;
  trace?: ProviderTrace;
  /** already-safe failure words (what the agent said in chat) */
  error?: string;
  /** the reply — only its LENGTH is kept */
  reply?: string;
}

/** A run id that is also a safe file name and sorts by time. No underscores: the
 *  shared file-name rule (`isSafeSkillFileName`) does not allow them. */
export function newRunId(now = Date.now(), rand = Math.random): string {
  const time = now.toString(36).padStart(9, "0");
  const noise = Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0");
  return `r-${time}-${noise}`;
}

export function buildRunRecord(seed: RunSeed, finish: RunFinish, id = newRunId()): RunRecord {
  const t = finish.trace;
  return {
    id,
    kind: seed.kind,
    agentId: seed.agentId,
    agentName: seed.agentName,
    provider: seed.provider,
    ...(seed.model ? { model: seed.model } : {}),
    ...(seed.channelId ? { channelId: seed.channelId } : {}),
    ...(seed.taskId ? { taskId: seed.taskId } : {}),
    requestedBy: seed.requestedBy,
    requestedByKind: seed.requestedByKind,
    ask: clip(seed.ask.trim(), RUN_LIMITS.ask),
    startedAt: seed.startedAt,
    finishedAt: finish.finishedAt,
    durationMs: Math.max(0, finish.finishedAt - seed.startedAt),
    outcome: finish.outcome,
    ...(finish.error ? { error: clip(finish.error, RUN_LIMITS.error) } : {}),
    steps: t?.steps ?? [],
    ...(t?.usage ? { usage: t.usage } : {}),
    ...(t?.sessionId ? { sessionId: t.sessionId } : {}),
    ...(t?.model ? { actualModel: t.model } : {}),
    ...(typeof t?.cliDurationMs === "number" ? { cliDurationMs: t.cliDurationMs } : {}),
    ...(typeof t?.numTurns === "number" ? { numTurns: t.numTurns } : {}),
    replyChars: finish.reply?.length ?? 0,
    events: t?.events ?? 0,
    ...(t?.truncated ? { truncated: true } : {}),
  };
}

// ------------------------------------------------------------- plain words

export interface RunCounts {
  command: number; read: number; write: number; search: number;
  web: number; tool: number; message: number;
}

/** Count the steps by kind. Nothing is inferred — a kind we did not see is 0. */
export function countSteps(steps: RunStep[]): RunCounts {
  const counts: RunCounts = { command: 0, read: 0, write: 0, search: 0, web: 0, tool: 0, message: 0 };
  for (const s of steps) {
    if (s.kind in counts) counts[s.kind as keyof RunCounts]++;
  }
  return counts;
}

/**
 * One short line a non-developer can read: "checked 4 sites, wrote 1 file, took
 * 41 seconds". Every clause is derived from a step that was actually recorded —
 * there is no sentence in here that can appear without evidence behind it.
 */
export function summarizeRun(record: RunRecord): string {
  const c = countSteps(record.steps);
  const parts: string[] = [];
  if (c.web) parts.push(plural(c.web, "checked 1 site", `checked ${c.web} sites`));
  if (c.search) parts.push(plural(c.search, "ran 1 search", `ran ${c.search} searches`));
  if (c.read) parts.push(plural(c.read, "read 1 file", `read ${c.read} files`));
  if (c.write) parts.push(plural(c.write, "wrote 1 file", `wrote ${c.write} files`));
  if (c.command) parts.push(plural(c.command, "ran 1 command", `ran ${c.command} commands`));
  if (c.tool) parts.push(plural(c.tool, "used 1 other tool", `used ${c.tool} other tools`));

  const time = `took ${humanDuration(record.durationMs)}`;
  const money = typeof record.usage?.costUsd === "number"
    ? `, cost ${humanMoney(record.usage.costUsd)}` : "";

  if (record.outcome === "cancelled") {
    return parts.length
      ? `Stopped after ${parts.join(", ")} — ${time}${money}.`
      : `Stopped before it got started — ${time}.`;
  }
  if (record.outcome === "failed") {
    const why = record.error ? ` — ${record.error}` : "";
    return parts.length
      ? `Didn't finish. Got as far as ${parts.join(", ")}, ${time}${money}.${why}`
      : `Didn't finish, ${time}${money}.${why}`;
  }
  if (parts.length === 0) {
    return `Answered straight from what it knew — no tools used, ${time}${money}.`;
  }
  return `${capitalise(parts.join(", "))}, ${time}${money}.`;
}

/** "41 seconds", "2 minutes 5 seconds", "under a second" — no decimals, no jargon. */
export function humanDuration(ms: number): string {
  if (ms < 1000) return "under a second";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} second${total === 1 ? "" : "s"}`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  const m = `${mins} minute${mins === 1 ? "" : "s"}`;
  return secs ? `${m} ${secs} second${secs === 1 ? "" : "s"}` : m;
}

/** Money as the owner would say it. Under a dollar reads in cents. */
export function humanMoney(usd: number): string {
  if (usd < 0.01) return "less than a cent";
  if (usd < 1) return `${Math.round(usd * 100)} cents`;
  return `$${usd.toFixed(2)}`;
}

// ------------------------------------------------------------- safe to share

/**
 * The version of a record that may be shown in chat, sent to a client, or read
 * by a guest. Every free-text field goes through `redactForSharing`, which owns
 * the "what may leave this machine" rule alongside `sanitizeForChat`.
 *
 * This is deliberately a SEPARATE object rather than a flag on the record: the
 * raw record on disk keeps the owner's own detail, and the only way to get a
 * shareable one is to call this. There is no path that shares the raw record by
 * forgetting to set something.
 */
export function shareableRun(record: RunRecord): RunRecord {
  return {
    ...record,
    ask: redactForSharing(record.ask, RUN_LIMITS.ask),
    ...(record.error ? { error: redactForSharing(record.error, RUN_LIMITS.error) } : {}),
    steps: record.steps.map(s => ({
      ...s,
      label: redactForSharing(s.label, RUN_LIMITS.label),
      ...(s.detail ? { detail: redactForSharing(s.detail, RUN_LIMITS.detail) } : {}),
    })),
  };
}

// ------------------------------------------------------------------ helpers

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The last piece of a path — "note.txt" out of anything. Shared by both mappers. */
export function baseName(p: string): string {
  const cleaned = p.replace(/["']/g, "").replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}
