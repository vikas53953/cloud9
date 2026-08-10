import { useCallback, useSyncExternalStore } from "react";
import {
  RESPONSE_STREAM_LIMITS, validateAgentResponseStream,
  type AgentResponseStreamEvent, type ID,
} from "@cloud9/shared";

export interface ResponsePreview {
  channelId: ID;
  agentId: ID;
  triggerMessageId: ID;
  turnId: string;
  text: string;
  startedAt: number;
  lastAt: number;
  status: "streaming" | "finalizing";
}

interface Pending extends ResponsePreview {
  deltas: Map<number, string>;
  nextSeq: number;
  totalChars: number;
}

const rows = new Map<string, Pending>();
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const EMPTY: readonly ResponsePreview[] = [];
let snapshotTick = 0;
const snapshotByMessage = new Map<ID, { tick: number; rows: readonly ResponsePreview[] }>();

const keyOf = (e: Pick<AgentResponseStreamEvent, "triggerMessageId" | "agentId" | "turnId">): string =>
  `${e.triggerMessageId}\u0000${e.agentId}\u0000${e.turnId}`;

function announce(): void { snapshotTick++; for (const listener of listeners) listener(); }

function clearKey(key: string): void {
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
  if (rows.delete(key)) announce();
}

function arm(key: string): void {
  const prior = timers.get(key);
  if (prior) clearTimeout(prior);
  const timer = setTimeout(() => {
    if (timers.get(key) !== timer) return;
    clearKey(key);
  }, RESPONSE_STREAM_LIMITS.staleMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  timers.set(key, timer);
}

/** Feed only relay-projected response events. Partial text is never persisted. */
export function noteAgentResponse(event: AgentResponseStreamEvent): void {
  if (validateAgentResponseStream(event)) return;
  const key = keyOf(event);
  if (event.kind === "response-start") {
    if (rows.has(key)) return;
    rows.set(key, {
      channelId: event.channelId, agentId: event.agentId, triggerMessageId: event.triggerMessageId, turnId: event.turnId,
      text: "", startedAt: event.at, lastAt: event.at, status: "streaming",
      deltas: new Map(), nextSeq: 1, totalChars: 0,
    });
    arm(key);
    announce();
    return;
  }
  const pending = rows.get(key);
  if (!pending || event.seq < pending.nextSeq) return;
  if (event.kind === "response-delta") {
    if (pending.deltas.has(event.seq)) return;
    pending.deltas.set(event.seq, event.text!);
    while (pending.deltas.has(pending.nextSeq)) {
      const text = pending.deltas.get(pending.nextSeq)!;
      pending.deltas.delete(pending.nextSeq++);
      if (pending.totalChars + text.length > RESPONSE_STREAM_LIMITS.totalChars) {
        clearKey(key);
        return;
      }
      pending.totalChars += text.length;
      pending.text += text;
    }
    pending.lastAt = event.at;
    arm(key);
    announce();
    return;
  }
  // A terminal frame hands control back to the durable message. Do not retain
  // a second copy that could flicker or duplicate the final answer.
  if (event.kind === "response-final") {
    pending.status = "finalizing";
    pending.lastAt = event.at;
    arm(key);
    announce();
    return;
  }
  if (event.kind === "response-cancel" || event.kind === "response-fail") {
    clearKey(key);
  }
}

/** Reconcile a preview when its durable agent message lands.
 *
 * The relay can deliver the durable message just before the terminal preview
 * frame (or vice versa).  Match the authoritative channel/agent boundary and
 * run timestamp, not the preview status, so either order clears the duplicate
 * copy without letting an older answer remove a newer turn.
 */
export function noteAgentMessage(message: {
  channelId: ID; authorId: ID; authorKind: string; ts: number; responseTriggerMessageId?: ID;
}): void {
  if (message.authorKind !== "agent") return;
  const candidates = [...rows.entries()].filter(([, row]) => row.channelId === message.channelId
    && row.agentId === message.authorId && message.ts >= row.startedAt);
  const matched = message.responseTriggerMessageId
    ? candidates.filter(([, row]) => row.triggerMessageId === message.responseTriggerMessageId)
    : candidates.length === 1 ? candidates : [];
  for (const [key] of matched) clearKey(key);
}

export function clearAgentResponses(predicate?: (row: ResponsePreview) => boolean): void {
  if (!predicate) {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    if (rows.size === 0) return;
    rows.clear();
    snapshotByMessage.clear();
    announce();
    return;
  }
  for (const [key, row] of rows) if (predicate(row)) clearKey(key);
}

export function responsePreviewsFor(messageId: ID): readonly ResponsePreview[] {
  const cached = snapshotByMessage.get(messageId);
  if (cached?.tick === snapshotTick) return cached.rows;
  const next = [...rows.values()]
    .filter(row => row.triggerMessageId === messageId)
    .map(({ deltas: _deltas, nextSeq: _nextSeq, totalChars: _totalChars, ...view }) => view);
  const result = next.length ? next : EMPTY;
  snapshotByMessage.set(messageId, { tick: snapshotTick, rows: result });
  return result;
}

function subscribe(listener: () => void): () => void { listeners.add(listener); return () => listeners.delete(listener); }

export function useResponsePreviews(messageId: ID): readonly ResponsePreview[] {
  const snapshot = useCallback(() => responsePreviewsFor(messageId), [messageId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function responseStreamResetForTests(): void { clearAgentResponses(); }
