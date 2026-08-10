/**
 * Public recovery facts for an agent run.
 *
 * This module is deliberately made out of facts a provider/relay can observe:
 * completed steps, retained artifact metadata and source-control coordinates.
 * It never accepts a transcript, prompt internals, provider credentials or
 * model reasoning. A checkpoint is a receipt, not a snapshot of provider
 * memory; providers may resume only when they explicitly advertise that
 * capability for the same session and action semantics.
 */
import { redactForSharing, type RunRecord, type RunStep } from "./index.js";

export const RUN_RECOVERY_LIMITS = {
  checkpointsPerRun: 8,
  artifactsPerCheckpoint: 32,
  filesPerCheckpoint: 64,
  field: 240,
  reason: 320,
  differences: 64,
  requestId: 180,
  token: 512,
} as const;

/** The closed vocabulary accepted in a durable checkpoint. */
const RUN_STEP_KINDS = new Set<RunStep["kind"]>([
  "command", "read", "write", "search", "web", "tool", "thinking", "message", "note",
]);

export type RecoveryMode = "retry" | "resume" | "restart";
export type RecoveryOutcome = "failed" | "cancelled" | "refused";

/** Only the public identity of an artifact is retained in a checkpoint. */
export interface PublicRunArtifact {
  id: string;
  name: string;
  version?: number;
  size?: number;
  available?: boolean;
}

/** Provider capability, as observed at action time. */
export interface ProviderSessionCapability {
  provider: string;
  /** Provider session id, if the provider reported one. Never a token. */
  sessionId?: string;
  /** True only when this provider/session/action can actually continue. */
  canResume: boolean;
  /** A user-visible explanation when continuation is unavailable. */
  reason?: string;
  /** Whether the requested action has idempotent semantics for resume. */
  actionSemantics?: "idempotent" | "non-idempotent" | "unknown";
}

/** Durable, redacted metadata about the last observable point of a run. */
export interface RunCheckpoint {
  id: string;
  runId: string;
  createdAt: number;
  /** Last contiguous step sequence known to have completed. */
  completedStepSeq: number;
  completedSteps: Array<Pick<RunStep, "seq" | "kind" | "label" | "ok">>;
  artifacts: PublicRunArtifact[];
  files?: string[];
  branch?: string;
  commit?: string;
  providerSession?: ProviderSessionCapability;
  /** Links a retry/resume/restart back to the original run. */
  priorRunId?: string;
}

export interface RecoveryAction {
  mode: RecoveryMode;
  available: boolean;
  label: string;
  reason?: string;
}

export interface RecoveryDecision {
  actions: RecoveryAction[];
  recommended: RecoveryMode;
  /** A short-lived server-minted capability; never accepted from the client as self-auth. */
  authorizationToken?: string;
}

export interface RecoveryRequestPayload {
  mode: RecoveryMode;
  /** Original request, copied as a public bounded string for safe retry. */
  ask: string;
  checkpointId?: string;
  /** New side effects must be authorised independently. */
  approvalEpoch: string;
}

export interface RecoveryRequest {
  requestId: string;
  requesterId: string;
  agentId: string;
  channelId?: string;
  runId: string;
  /** Factual context copied from the original run; absent only for legacy rows. */
  kind?: "chat" | "task" | "schedule";
  taskId?: string;
  replyTo?: string;
  requesterKind?: "human" | "agent" | "schedule";
  requestedBy?: string;
  payload: RecoveryRequestPayload;
}

export interface RecoveryReceipt {
  request: RecoveryRequest;
  payloadFingerprint: string;
  status: "pending" | "accepted" | "replayed" | "conflict" | "refused";
  reason?: string;
  createdAt: number;
}

export interface ComparableRun {
  runId: string;
  accessible: true;
  ask: string;
  agent: string;
  agentId: string;
  model?: string;
  effort?: string;
  provider: string;
  durationMs: number;
  costUsd?: number;
  outcome: string;
  steps: Array<Pick<RunStep, "seq" | "kind" | "label" | "ok">>;
  files: string[];
  pullRequest?: string;
  artifacts: PublicRunArtifact[];
  branch?: string;
  commit?: string;
}

export interface InaccessibleRun {
  runId: string;
  accessible: false;
  reason: "unavailable";
}

export interface RunComparison {
  left: ComparableRun | InaccessibleRun;
  right: ComparableRun | InaccessibleRun;
  differences: Array<{ field: string; left?: string | number; right?: string | number }>;
}

export function validateRunCheckpoint(value: unknown): string | null {
  if (!value || typeof value !== "object") return "that checkpoint is not an object";
  const cp = value as Partial<RunCheckpoint>;
  if (!safeId(cp.id) || !safeId(cp.runId)) return "that checkpoint id is not usable";
  if (!Number.isSafeInteger(cp.createdAt) || cp.createdAt! < 0) return "that checkpoint time is not usable";
  if (!Number.isSafeInteger(cp.completedStepSeq) || cp.completedStepSeq! < 0 || cp.completedStepSeq! > RUN_RECOVERY_LIMITS.filesPerCheckpoint) return "that checkpoint step is not usable";
  if (!Array.isArray(cp.completedSteps) || cp.completedSteps.length > RUN_RECOVERY_LIMITS.filesPerCheckpoint) return "that checkpoint has too many steps";
  if (!Array.isArray(cp.artifacts) || cp.artifacts.length > RUN_RECOVERY_LIMITS.artifactsPerCheckpoint) return "that checkpoint has too many artifacts";
  let expectedSeq = 1;
  for (const step of cp.completedSteps) {
    if (!step || !Number.isSafeInteger(step.seq) || step.seq !== expectedSeq
      || step.seq < 1 || !RUN_STEP_KINDS.has(step.kind as RunStep["kind"])
      || step.ok !== true || !bounded(step.label)) {
      return "that checkpoint has unusable steps";
    }
    expectedSeq++;
  }
  if (cp.completedStepSeq !== expectedSeq - 1) return "that checkpoint step does not match its completed steps";
  if (cp.artifacts.some(a => !a || !safeId(a.id) || !bounded(a.name)
    || (a.version !== undefined && safePositive(a.version) === undefined)
    || (a.size !== undefined && safePositive(a.size) === undefined)
    || (a.available !== undefined && typeof a.available !== "boolean"))) return "that checkpoint has unusable artifacts";
  if (cp.files !== undefined && (!Array.isArray(cp.files) || cp.files.length > RUN_RECOVERY_LIMITS.filesPerCheckpoint || cp.files.some(f => !bounded(f)))) return "that checkpoint has unusable files";
  if (cp.branch !== undefined && !bounded(cp.branch, RUN_RECOVERY_LIMITS.field)) return "that checkpoint branch is not usable";
  if (cp.commit !== undefined && !bounded(cp.commit, RUN_RECOVERY_LIMITS.field)) return "that checkpoint commit is not usable";
  if (cp.priorRunId !== undefined && !safeId(cp.priorRunId)) return "that checkpoint prior run is not usable";
  if (cp.providerSession) {
    if (!bounded(cp.providerSession.provider) || typeof cp.providerSession.canResume !== "boolean" || (cp.providerSession.reason !== undefined && !bounded(cp.providerSession.reason, RUN_RECOVERY_LIMITS.reason))) return "that checkpoint provider capability is not usable";
    if (cp.providerSession.sessionId !== undefined && !safeSessionId(cp.providerSession.sessionId)) return "that checkpoint session id is not public";
    if (cp.providerSession.actionSemantics !== undefined && !["idempotent", "non-idempotent", "unknown"].includes(cp.providerSession.actionSemantics)) return "that checkpoint action semantics are not usable";
  }
  return null;
}

function bounded(value: unknown, max: number = RUN_RECOVERY_LIMITS.field): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : undefined;
}

function safeId(value: unknown): string | undefined {
  const id = bounded(value, 180);
  return id && /^[A-Za-z0-9._:-]+$/.test(id) ? id : undefined;
}

function safeSessionId(value: unknown): string | undefined {
  const id = safeId(value);
  return id && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id) ? id : undefined;
}

function safePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function publicFile(value: unknown): string | undefined {
  const text = bounded(value, RUN_RECOVERY_LIMITS.field);
  if (!text) return undefined;
  const parts = text.replace(/[\\/]+$/, "").split(/[\\/]/);
  return bounded(parts[parts.length - 1], RUN_RECOVERY_LIMITS.field);
}

/** Step labels are observable facts, but may still contain command secrets or paths. */
function publicStepLabel(value: unknown): string | undefined {
  let text = bounded(value);
  if (!text) return undefined;
  text = text
    .replace(/\b(?:sk|pk|ghp|gho|ghu|ghs|github_pat|xox[abprs]|glpat|AIza|hooks)[-_][A-Za-z0-9_-]{6,}/gi, "***")
    .replace(/\b[A-Za-z_][A-Za-z0-9_]*(?:API[_-]?KEY|ACCESS[_-]?KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|TOKEN)\s*=\s*[^\s,;]+/gi,
      match => `${match.slice(0, match.indexOf("="))}=***`)
    .replace(/\b[A-Za-z]:[\\/][^\s"'|;&]+/g, match => publicFile(match) ?? "unavailable")
    .replace(/(^|[\s"'(=,])\/(?:home|Users|root|mnt|opt|srv|var|etc|tmp|private)\/[^\s"'|;&]+/g,
      (_match, lead: string) => `${lead}unavailable`);
  return bounded(text);
}

/** Bounded public copy of the original ask used by recovery receipts/engines. */
export function sanitizeRecoveryAsk(value: unknown): string {
  return publicStepLabel(value) ?? "recovery request";
}

function publicArtifact(value: PublicRunArtifact): PublicRunArtifact {
  return {
    id: safeId(publicStepLabel(value.id)) ?? "unavailable", name: publicStepLabel(publicFile(value.name)) ?? "artifact",
    ...(safePositive(value.version) !== undefined ? { version: value.version } : {}),
    ...(safePositive(value.size) !== undefined ? { size: value.size } : {}),
    ...(typeof value.available === "boolean" ? { available: value.available } : {}),
  };
}

function checkpointId(runId: string, createdAt: number): string {
  const safe = safeId(runId) ?? "run";
  return `cp-${safe}-${Math.max(0, Math.floor(createdAt)).toString(36)}`.slice(0, 180);
}

/** Build public metadata from a completed/observed run. */
export function buildRunCheckpoint(
  record: RunRecord,
  observed: {
    createdAt?: number;
    artifacts?: readonly PublicRunArtifact[];
    files?: readonly string[];
    branch?: string;
    commit?: string;
    providerSession?: ProviderSessionCapability;
    priorRunId?: string;
  } = {},
): RunCheckpoint {
  const createdAt = Number.isFinite(observed.createdAt) ? Math.floor(observed.createdAt!) : record.finishedAt;
  const contiguous: RunStep[] = [];
  let expectedSeq = 1;
  for (const step of [...record.steps].sort((a, b) => a.seq - b.seq)) {
    if (step.seq !== expectedSeq || step.ok !== true) break;
    contiguous.push(step);
    expectedSeq++;
  }
  const completedSteps = contiguous
    .slice(0, RUN_RECOVERY_LIMITS.filesPerCheckpoint)
    .map(({ seq, kind, label, ok }) => ({ seq, kind, label: publicStepLabel(label) ?? kind, ok }));
  const artifacts = (observed.artifacts ?? []).slice(0, RUN_RECOVERY_LIMITS.artifactsPerCheckpoint).map(publicArtifact);
  const session = observed.providerSession && {
    provider: bounded(observed.providerSession.provider) ?? record.provider,
    ...(safeSessionId(observed.providerSession.sessionId) ? { sessionId: safeSessionId(observed.providerSession.sessionId) } : {}),
    canResume: observed.providerSession.canResume === true,
    ...(publicStepLabel(observed.providerSession.reason)
      ? { reason: publicStepLabel(observed.providerSession.reason)!.slice(0, RUN_RECOVERY_LIMITS.reason) } : {}),
    ...(observed.providerSession.actionSemantics ? { actionSemantics: observed.providerSession.actionSemantics } : {}),
  } satisfies ProviderSessionCapability;
  return {
    id: checkpointId(record.id, createdAt), runId: record.id, createdAt,
    completedStepSeq: completedSteps.length ? completedSteps[completedSteps.length - 1].seq : 0,
    completedSteps, artifacts,
    ...(observed.files ? { files: observed.files.slice(0, RUN_RECOVERY_LIMITS.filesPerCheckpoint).map(f => publicStepLabel(publicFile(f)) ?? "unavailable") } : {}),
    ...(publicStepLabel(observed.branch) ? { branch: publicStepLabel(observed.branch) } : {}),
    ...(publicStepLabel(observed.commit) ? { commit: publicStepLabel(observed.commit) } : {}),
    ...(session ? { providerSession: session } : {}),
    ...(safeId(observed.priorRunId) ? { priorRunId: safeId(observed.priorRunId) } : {}),
  };
}

/** Decide what the UI may offer. Resume is never inferred from a run id. */
export function recoveryDecision(
  record: Pick<RunRecord, "outcome">,
  checkpoint?: RunCheckpoint,
): RecoveryDecision {
  const recoverable = record.outcome === "failed" || record.outcome === "cancelled" || record.outcome === "refused";
  const resume = checkpoint?.providerSession?.canResume === true
    && checkpoint.providerSession.actionSemantics === "idempotent"
    && !!checkpoint.providerSession.sessionId;
  const resumeReason = !checkpoint ? "no public checkpoint is available"
    : !checkpoint.providerSession ? "the provider did not report a resumable session"
      : !checkpoint.providerSession.sessionId ? "the provider session id is unavailable"
        : checkpoint.providerSession.canResume !== true ? (checkpoint.providerSession.reason ?? "this provider cannot resume")
          : checkpoint.providerSession.actionSemantics !== "idempotent" ? "the requested action is not safely resumable"
            : undefined;
  return {
    actions: [
      { mode: "retry", available: recoverable, label: "Retry safely", ...(recoverable ? {} : { reason: "this run completed successfully" }) },
      { mode: "resume", available: recoverable && resume, label: "Resume from checkpoint when supported", ...(!resume ? { reason: resumeReason } : {}) },
      { mode: "restart", available: recoverable, label: "Restart with prior context", ...(recoverable ? {} : { reason: "this run completed successfully" }) },
    ],
    recommended: resume && recoverable ? "resume" : "retry",
  };
}

/** Stable, bounded identity for request replay/conflict detection. */
export function recoveryRequestFingerprint(request: RecoveryRequest): string {
  const p = request.payload;
  return JSON.stringify({
    requesterId: request.requesterId, agentId: request.agentId, channelId: request.channelId ?? "",
    runId: request.runId, kind: request.kind ?? "", taskId: request.taskId ?? "",
    replyTo: request.replyTo ?? "", requesterKind: request.requesterKind ?? "",
    requestedBy: bounded(request.requestedBy, RUN_RECOVERY_LIMITS.field) ?? "",
    mode: p.mode, ask: bounded(p.ask, 500) ?? "", checkpointId: p.checkpointId ?? "",
  });
}

export function compareRecoveryRequest(previous: RecoveryReceipt | undefined, next: RecoveryRequest): "new" | "replay" | "conflict" {
  if (!previous) return "new";
  return previous.payloadFingerprint === recoveryRequestFingerprint(next) ? "replay" : "conflict";
}

function publicField(value: unknown, max: number = RUN_RECOVERY_LIMITS.field): string | undefined {
  if (typeof value !== "string") return undefined;
  const clean = redactForSharing(value.replace(/[\u0000-\u001f\u007f]/g, " "), max);
  return clean.trim() || undefined;
}

function publicPathField(value: unknown, max: number = RUN_RECOVERY_LIMITS.field): string | undefined {
  const clean = publicField(value, max);
  if (!clean) return undefined;
  const parts = clean.replace(/[\\/]+$/, "").split(/[\\/]/);
  return publicField(parts[parts.length - 1], max);
}

function publicNumber(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : undefined;
}

function publicAmount(value: unknown, max = Number.MAX_SAFE_INTEGER): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : undefined;
}

function publicStep(step: unknown): Pick<RunStep, "seq" | "kind" | "label" | "ok"> | undefined {
  if (!step || typeof step !== "object") return undefined;
  const raw = step as Partial<RunStep>;
  if (!Number.isSafeInteger(raw.seq) || (raw.seq as number) < 1 || !RUN_STEP_KINDS.has(raw.kind as RunStep["kind"])) return undefined;
  const label = publicField(raw.label, RUN_RECOVERY_LIMITS.field);
  if (!label) return undefined;
  return { seq: raw.seq as number, kind: raw.kind as RunStep["kind"], label, ...(typeof raw.ok === "boolean" ? { ok: raw.ok } : {}) };
}

function publicArtifactValue(value: unknown): PublicRunArtifact | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Partial<PublicRunArtifact>;
  const id = publicPathField(raw.id, 180);
  const name = publicPathField(raw.name);
  if (!id || !name) return undefined;
  return {
    id, name,
    ...(publicNumber(raw.version) !== undefined ? { version: publicNumber(raw.version) } : {}),
    ...(publicNumber(raw.size) !== undefined ? { size: publicNumber(raw.size) } : {}),
    ...(typeof raw.available === "boolean" ? { available: raw.available } : {}),
  };
}

function publicCheckpoint(checkpoint?: RunCheckpoint): RunCheckpoint | undefined {
  if (!checkpoint || validateRunCheckpoint(checkpoint)) return undefined;
  return {
    id: publicField(checkpoint.id, 180) ?? "unavailable",
    runId: publicField(checkpoint.runId, 180) ?? "unavailable",
    createdAt: publicNumber(checkpoint.createdAt) ?? 0,
    completedStepSeq: publicNumber(checkpoint.completedStepSeq, RUN_RECOVERY_LIMITS.filesPerCheckpoint) ?? 0,
    completedSteps: checkpoint.completedSteps.slice(0, RUN_RECOVERY_LIMITS.filesPerCheckpoint)
      .map(publicStep).filter((s): s is Pick<RunStep, "seq" | "kind" | "label" | "ok"> => !!s),
    artifacts: checkpoint.artifacts.slice(0, RUN_RECOVERY_LIMITS.artifactsPerCheckpoint)
      .map(publicArtifactValue).filter((a): a is PublicRunArtifact => !!a),
    ...(checkpoint.files ? { files: checkpoint.files.slice(0, RUN_RECOVERY_LIMITS.filesPerCheckpoint).map(f => publicPathField(f) ?? "unavailable") } : {}),
    ...(publicField(checkpoint.branch) ? { branch: publicField(checkpoint.branch) } : {}),
    ...(publicField(checkpoint.commit) ? { commit: publicField(checkpoint.commit) } : {}),
    ...(checkpoint.providerSession ? { providerSession: {
      provider: publicField(checkpoint.providerSession.provider) ?? "unknown",
      ...(publicField(checkpoint.providerSession.sessionId, 180) ? { sessionId: publicField(checkpoint.providerSession.sessionId, 180) } : {}),
      canResume: checkpoint.providerSession.canResume === true,
      ...(publicField(checkpoint.providerSession.reason, RUN_RECOVERY_LIMITS.reason) ? { reason: publicField(checkpoint.providerSession.reason, RUN_RECOVERY_LIMITS.reason) } : {}),
      ...(checkpoint.providerSession.actionSemantics ? { actionSemantics: checkpoint.providerSession.actionSemantics } : {}),
    } } : {}),
    ...(publicField(checkpoint.priorRunId, 180) ? { priorRunId: publicField(checkpoint.priorRunId, 180) } : {}),
  };
}

function comparable(record: RunRecord, checkpoint?: RunCheckpoint): ComparableRun {
  const safeCheckpoint = publicCheckpoint(checkpoint);
  const rawSteps = safeCheckpoint?.completedSteps ?? (Array.isArray(record.steps) ? record.steps : []);
  const steps = rawSteps.slice(0, RUN_RECOVERY_LIMITS.filesPerCheckpoint)
    .map(publicStep).filter((step): step is Pick<RunStep, "seq" | "kind" | "label" | "ok"> => !!step);
  const files = safeCheckpoint?.files ?? (Array.isArray(record.files) ? record.files.map(f => publicPathField(f) ?? "unavailable") : []);
  const artifacts = safeCheckpoint?.artifacts ?? (Array.isArray(record.artifacts) ? record.artifacts.map(publicArtifactValue).filter((a): a is PublicRunArtifact => !!a) : []);
  return {
    runId: publicField(record.id, 180) ?? "unavailable", accessible: true,
    ask: publicField(record.ask, 500) ?? "Not reported", agent: publicField(record.agentName) ?? "agent",
    agentId: publicField(record.agentId, 180) ?? "unavailable", ...(publicField(record.actualModel ?? record.model, 120) ? { model: publicField(record.actualModel ?? record.model, 120) } : {}),
    ...(publicField(record.effort, 32) ? { effort: publicField(record.effort, 32) } : {}),
    provider: publicField(record.provider, 64) ?? "unknown", durationMs: publicAmount(record.durationMs, 31_536_000_000) ?? 0,
    ...(publicAmount(record.usage?.costUsd, 1_000_000_000) !== undefined ? { costUsd: publicAmount(record.usage?.costUsd, 1_000_000_000) } : {}),
    outcome: ["ok", "failed", "cancelled", "refused"].includes(record.outcome) ? record.outcome : "unknown", steps, files,
    ...(publicField(record.pullRequest) ? { pullRequest: publicField(record.pullRequest) } : {}),
    artifacts,
    ...(publicField(safeCheckpoint?.branch ?? record.branch) ? { branch: publicField(safeCheckpoint?.branch ?? record.branch) } : {}),
    ...(publicField(safeCheckpoint?.commit ?? record.commit) ? { commit: publicField(safeCheckpoint?.commit ?? record.commit) } : {}),
  };
}

/** Compare only public facts; an inaccessible side is redacted, never guessed. */
export function compareRuns(
  left: RunRecord | undefined, right: RunRecord | undefined,
  access: (record: RunRecord) => boolean = () => true,
  checkpoints: { left?: RunCheckpoint; right?: RunCheckpoint } = {},
): RunComparison {
  const l = left && access(left) ? comparable(left, checkpoints.left) : { runId: publicField(left?.id, 180) ?? "unavailable", accessible: false as const, reason: "unavailable" as const };
  const r = right && access(right) ? comparable(right, checkpoints.right) : { runId: publicField(right?.id, 180) ?? "unavailable", accessible: false as const, reason: "unavailable" as const };
  const differences: RunComparison["differences"] = [];
  if (l.accessible && r.accessible) {
    const fields: Array<[string, string | number | undefined, string | number | undefined]> = [
      ["Ask", l.ask, r.ask], ["Agent", l.agent, r.agent], ["Model", l.model, r.model],
      ["Effort", l.effort, r.effort], ["Provider", l.provider, r.provider], ["Duration", l.durationMs, r.durationMs],
      ["Cost", l.costUsd, r.costUsd], ["Outcome", l.outcome, r.outcome],
      ["Branch", l.branch, r.branch], ["Commit", l.commit, r.commit],
      ["Files", l.files.join(", "), r.files.join(", ")],
      ["Pull request", l.pullRequest, r.pullRequest],
      ["Artifacts", l.artifacts.map(a => `${a.id}@${a.version ?? ""}`).join(", "), r.artifacts.map(a => `${a.id}@${a.version ?? ""}`).join(", ")],
    ];
    for (const [field, a, b] of fields) if (a !== b) differences.push({ field, ...(a !== undefined ? { left: a } : {}), ...(b !== undefined ? { right: b } : {}) });
  }
  return { left: l, right: r, differences: differences.slice(0, RUN_RECOVERY_LIMITS.differences) };
}
