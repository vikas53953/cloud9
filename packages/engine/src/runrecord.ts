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
// THE VOCABULARY MOVED. `RunStepKind`, `RunStep`, `RunUsage`, `RunRecord`,
// `RunOutcome`, `RunKind`, `RunListEntry`, `RUN_LIMITS` and the plain-words
// helpers now live in `@cloud9/shared`: the engine writes a run record, the
// relay stores one and the screen draws one, so a definition owned by any one
// of the three is a definition the other two can drift from. Nothing about
// them changed in the move — `runrecord.test.ts` pins the shapes against real
// CLI output and still passes unaltered.
//
// What stays here is what only the engine can do: read a harness's stream
// (`traceFromStream` + an `EventMapper`) and turn one turn into a record.
import {
  RunKind, RunOutcome, RunRecord, RunStep, RunStepKind, RunUsage, RUN_LIMITS,
} from "@cloud9/shared";

export {
  RUN_LIMITS, countSteps, summarizeRun, humanDuration, humanMoney, shareableRun,
  runListEntry, fitRunRecord, validateRunRecord, redactForSharing,
  type RunStepKind, type RunStep, type RunUsage, type RunRecord,
  type RunOutcome, type RunKind, type RunCounts, type RunListEntry,
} from "@cloud9/shared";

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
 *  shared file-name rule (`isSafeFileName`) does not allow them. */
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

// ------------------------------------------------------------------ helpers

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}



/** The last piece of a path — "note.txt" out of anything. Shared by both mappers. */
export function baseName(p: string): string {
  const cleaned = p.replace(/["']/g, "").replace(/[\\/]+$/, "");
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}
