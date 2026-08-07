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
  AgentTrust, RunKind, RunOutcome, RunRecord, RunStep, RunStepKind, RunUsage, RUN_LIMITS,
  SpendCapWhich,
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
  /** the harness emitted its terminal/final envelope after this text */
  terminal?: boolean;
  /** The provider explicitly marked a surviving answer as final. */
  finalAnswer?: boolean;
  steps: RunStep[];
  usage?: RunUsage;
  /** the CLI's own conversation id, for matching against its logs */
  sessionId?: string;
  /**
   * TRUE when this turn CONTINUED the harness's own session rather than
   * starting a cold one (`sessionresume.ts`).
   *
   * Recorded either way, never inferred. A resumed turn was sent only the
   * messages new since it last spoke, so a person reading the record needs to
   * know which shape of prompt produced this answer before the token counts
   * beside it mean anything.
   */
  resumed?: boolean;
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
  /**
   * THE HARNESS STOPPED THIS TURN ITSELF because it reached the spending
   * ceiling Cloud9 handed it (`--max-budget-usd`).
   *
   * A FLAG, DELIBERATELY NOT A SENTENCE. The provider knows that a ceiling
   * fired; only the engine knows WHICH of the owner's two limits produced the
   * number, and therefore which words are true. Absent means it did not happen —
   * never `false` as a shrug.
   */
  stoppedByBudget?: boolean;
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
  setText(text: string, terminal?: boolean): void;
  /** mark a terminal envelope even when it carries no text */
  setTerminal(): void;
  /** a turn-level failure the CLI reported */
  setError(message: string): void;
  /** anything else the CLI told us about the run as a whole */
  set(patch: Partial<Pick<ProviderTrace,
    "sessionId" | "model" | "cliDurationMs" | "numTurns" | "usage" | "stoppedByBudget">>): void;
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
 * A stream being read ONE LINE AT A TIME.
 *
 * THIS IS THE STREAMING SEAM. It exists so that "read a whole transcript" and
 * "read a transcript as it is being written" are the SAME code reading the same
 * events in the same order — `traceFromStream` is now just a loop over `feed`.
 * A second walker written for the live path is a second place for the two to
 * disagree about what a CLI said, which is the one thing this module exists to
 * prevent.
 */
export interface TraceWalker {
  /** the trace so far — the SAME object throughout, filled in as lines arrive */
  readonly trace: ProviderTrace;
  /**
   * Read ONE line. Returns COPIES of the steps this line added or changed, in
   * order, so a caller can show them without holding a reference into the trace
   * it is still building. An empty array is the normal answer: most lines say
   * nothing a person would call a step.
   *
   * Never throws. A partial line, a blank line, a log line, a line that is not
   * JSON at all and a mapper that falls over on one event all cost that one
   * line and nothing else.
   */
  feed(line: string): RunStep[];
  /** end of stream: settle the truncation flag and hand back the trace */
  done(): ProviderTrace;
}

export function traceWalker(provider: string, map: EventMapper): TraceWalker {
  const trace: ProviderTrace = { provider, text: "", steps: [], events: 0 };
  let dropped = 0;
  /** the steps this LINE touched — added or patched. Reset per line. */
  let touched = new Set<number>();

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
      touched.add(seq);
      return seq;
    },
    update(seq, patch) {
      if (!seq) return;
      const step = trace.steps[seq - 1];
      if (!step) return;
      if (patch.label) step.label = clip(patch.label, RUN_LIMITS.label);
      if (patch.detail) step.detail = clip(patch.detail, RUN_LIMITS.detail);
      if (typeof patch.ok === "boolean") step.ok = patch.ok;
      touched.add(step.seq);
    },
    setText(text, terminal = true) {
      const t = text.trim();
      if (t) trace.text = t;
      if (terminal) {
        trace.terminal = true;
        trace.finalAnswer = true;
      }
    },
    setTerminal() { trace.terminal = true; },
    setError(message) { const m = message.trim(); if (m) trace.error = clip(m, RUN_LIMITS.error); },
    set(patch) { Object.assign(trace, patch); },
  };

  return {
    trace,
    feed(line) {
      const trimmed = line.trim();
      // NOT JSON, or only half of it. Both are ordinary mid-stream: a CLI logs
      // plain sentences alongside its events, and a chunk boundary can land in
      // the middle of one. Skipped, never guessed at, never thrown.
      if (!trimmed.startsWith("{")) return [];
      if (trimmed.length > RUN_LIMITS.line) return [];
      let event: Record<string, unknown>;
      try { event = JSON.parse(trimmed) as Record<string, unknown>; } catch { return []; }
      trace.events++;
      touched = new Set<number>();
      try { map(event, builder); } catch (err) {
        console.error("[engine] could not read one line of a harness transcript:", err);
      }
      if (touched.size === 0) return [];
      return [...touched].sort((a, b) => a - b)
        .map(seq => ({ ...trace.steps[seq - 1] }))
        .filter((s): s is RunStep => !!s);
    },
    done() {
      if (dropped > 0) trace.truncated = true;
      return trace;
    },
  };
}

/**
 * Walk a CLI's output and build the shared trace.
 *
 * Fail-safe by construction: a line that is not JSON is skipped, a line that is
 * too big is skipped, and a mapper that throws on one event loses that event
 * and nothing else. A stream we cannot read at all yields an empty trace — it
 * never throws, because a recording problem must never cost the owner an answer.
 */
export function traceFromStream(raw: string, provider: string, map: EventMapper): ProviderTrace {
  const walker = traceWalker(provider, map);
  for (const line of raw.split(/\r?\n/)) walker.feed(line);
  return walker.done();
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
  /**
   * The owner's trust setting for this agent at the moment the turn started —
   * so "what it did" can also say how much of it he was asked about. Optional
   * because a caller that does not know reads as "ask every time" downstream,
   * which is the fail-closed answer everywhere else.
   */
  trust?: AgentTrust;
  /**
   * DID THIS TURN RUN IN THE OWNER'S OWN CLAUDE CODE / CODEX SETUP
   * (`ownersetup.ts`)? Recorded either way when the caller knows, because
   * "no" is a fact worth having beside a token count, not just an absence.
   * A caller that does not say leaves the field off, which reads as "no" —
   * the same fail-closed answer `usesOwnerSetup` gives everywhere else.
   */
  ownerSetup?: boolean;
}

export interface RunFinish {
  finishedAt: number;
  outcome: RunOutcome;
  trace?: ProviderTrace;
  /** already-safe failure words (what the agent said in chat) */
  error?: string;
  /** the reply — only its LENGTH is kept */
  reply?: string;
  /**
   * A SPENDING CEILING STOPPED THIS RUN, and which of the owner's two it was.
   *
   * Set by the engine, which is the only thing that knows both limits. It
   * covers BOTH shapes of the event — a turn refused before it started because
   * the month was already spent, and a turn the app cut short when it reached
   * the ceiling — because to the person reading the record they are one event.
   */
  capStop?: { which: SpendCapWhich; capUsd: number };
  /**
   * THIS TURN RAN ON A STAND-IN MODEL, not the one the owner chose.
   *
   * Worked out by the engine with `fellBackTo` in @cloud9/shared, which only
   * ever says yes when the model the app REPORTED is one the owner actually
   * named as a stand-in. A swap we cannot prove is never claimed here.
   */
  fellBackTo?: string;
  /** this run was the agent writing a plan, not doing the work */
  planOnly?: boolean;
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
    // WHICH PATH THIS TURN TOOK. Present whenever the provider had an opinion,
    // including `false` — see the note on `ProviderTrace.resumed`.
    ...(typeof t?.resumed === "boolean" ? { resumed: t.resumed } : {}),
    ...(t?.model ? { actualModel: t.model } : {}),
    ...(typeof t?.cliDurationMs === "number" ? { cliDurationMs: t.cliDurationMs } : {}),
    ...(typeof t?.numTurns === "number" ? { numTurns: t.numTurns } : {}),
    ...(seed.trust ? { trust: seed.trust } : {}),
    // WHOSE SETUP IT RAN IN. `false` is kept, not dropped: a run that says
    // "not your setup" out loud is the half of this record he most needs when
    // two runs of the same agent cost wildly different amounts.
    ...(typeof seed.ownerSetup === "boolean" ? { ownerSetup: seed.ownerSetup } : {}),
    // A LIMIT STOPPED IT, and a stand-in model ran it. Both present only when
    // they really happened — an absent field here is the honest "it didn't",
    // never a zero or a false standing in for one.
    ...(finish.capStop ? { capStop: finish.capStop } : {}),
    ...(finish.fellBackTo ? { fellBackTo: finish.fellBackTo } : {}),
    ...(finish.planOnly ? { planOnly: true } : {}),
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
