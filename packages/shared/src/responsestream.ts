import type { ID } from "./index.js";

/**
 * A response preview is deliberately a different protocol from receipts and
 * live tool steps. It carries only provider-emitted answer text and is never a
 * durable message or transcript.
 */
export type AgentResponseStreamKind =
  | "response-start"
  | "response-delta"
  | "response-final"
  | "response-cancel"
  | "response-fail";

export interface AgentResponseStreamEvent {
  kind: AgentResponseStreamKind;
  channelId: ID;
  /** The human/agent message that triggered this turn. */
  triggerMessageId: ID;
  agentId: ID;
  /** The durable run id allocated before the provider starts. */
  turnId: string;
  /** start is 0; every following event is strictly increasing. */
  seq: number;
  /** Hub timestamp; engines never supply this value. */
  at: number;
  /** Only response-delta carries text. */
  text?: string;
  /** A bounded, non-sensitive terminal explanation. */
  reason?: string;
}

/** Shared ceilings for engine, relay and desktop. */
export const RESPONSE_STREAM_LIMITS = {
  deltaChars: 4_096,
  totalChars: 200_000,
  eventsPerSecond: 60,
  maxActiveStreams: 256,
  staleMs: 3 * 60 * 1_000,
  reasonChars: 300,
} as const;

export function isAgentResponseStreamKind(value: unknown): value is AgentResponseStreamKind {
  return value === "response-start" || value === "response-delta"
    || value === "response-final" || value === "response-cancel" || value === "response-fail";
}

/** Validate shape/size only. Ownership, turn ordering and audience are per-relay concerns. */
export function validateAgentResponseStream(value: unknown): string | null {
  if (!value || typeof value !== "object") return "a response stream event is required";
  const event = value as Partial<AgentResponseStreamEvent>;
  if (!isAgentResponseStreamKind(event.kind)) return "that response stream event is not supported";
  for (const [key, field] of [["channel", event.channelId], ["trigger", event.triggerMessageId], ["agent", event.agentId], ["turn", event.turnId]] as const) {
    if (typeof field !== "string" || field.length === 0 || field.length > 200) return `a response stream needs a valid ${key}`;
  }
  const seq = event.seq;
  if (!Number.isSafeInteger(seq) || seq === undefined || seq < 0) return "a response stream needs an ordered sequence";
  if (typeof event.at !== "number" || !Number.isFinite(event.at)) return "a response stream needs a timestamp";
  if (event.kind === "response-start" && seq !== 0) return "a response stream must start at sequence zero";
  if (event.kind === "response-delta") {
    if (typeof event.text !== "string" || event.text.length === 0) return "a response delta needs text";
    if (event.text.length > RESPONSE_STREAM_LIMITS.deltaChars) return "that response delta is too large";
  } else if (event.text !== undefined) {
    return "only response deltas may carry text";
  }
  if (event.reason !== undefined) {
    if (event.kind === "response-start" || event.kind === "response-delta") {
      return "a response reason is only allowed when it ends";
    }
    if (typeof event.reason !== "string" || event.reason.length > RESPONSE_STREAM_LIMITS.reasonChars) {
      return "that response ending is too long";
    }
  }
  return null;
}
