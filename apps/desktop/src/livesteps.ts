// LIVE STEPS ON SCREEN — what an agent is doing, while it is still doing it.
//
// ============================== EPHEMERAL ==============================
//
// EVERYTHING IN THIS FILE IS THROWN AWAY, and that is the whole design, not a
// shortcut. The hub forwards live steps and stores nothing, so this small map
// is the only place they exist on the client: not part of the world state, not
// in history, not in search, gone on reload.
//
// NOTHING IS LOST WHEN IT GOES. The real answer to "what did it do?" is the
// STORED run record, which arrives by its own path when the turn ends and is
// drawn by the same `RunSteps` component. Reload mid-turn and the preview
// disappears; the record still turns up when the turn finishes. The preview is
// the waiting made visible, nothing more.
//
// It keeps its own store rather than joining the world for the same two reasons
// `receipts.tsx` does: a turn that reports twenty steps a second must not
// re-render the whole conversation, and nothing that persists the world can
// ever accidentally persist these.
import { useCallback, useSyncExternalStore } from "react";
import { ID, LIVE_STEPS_STALE_MS, LiveRunSteps, RunStep } from "@cloud9/shared";

/** One agent's live steps for one message, newest merged into oldest. */
interface Row {
  agentId: ID;
  /** every step seen so far this turn, in `seq` order */
  steps: RunStep[];
}

const EMPTY: readonly Row[] = [];
const byMessage = new Map<ID, readonly Row[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

const keyOf = (messageId: ID, agentId: ID): string => `${messageId} ${agentId}`;

function announce(): void {
  for (const fn of listeners) fn();
}

/**
 * A live batch arrived. Call this from the frame handler and nowhere else.
 *
 * MERGED BY `seq`, NOT APPENDED. A CLI reports one step twice — once when a
 * command starts and again when its exit code lands — so a batch that repeats a
 * `seq` is the SAME step with more filled in, and appending it would show the
 * owner the same command twice and count it twice. `done` clears the row: the
 * turn is over and the stored record takes it from here.
 */
export function noteLiveSteps(live: LiveRunSteps): void {
  if (live.done) { drop(live.messageId, live.agentId); return; }
  if (!live.steps || live.steps.length === 0) return;
  const rows = byMessage.get(live.messageId) ?? EMPTY;
  const mine = rows.find(r => r.agentId === live.agentId);
  const merged = new Map<number, RunStep>();
  for (const s of mine?.steps ?? []) merged.set(s.seq, s);
  for (const s of live.steps) merged.set(s.seq, s);
  const steps = [...merged.values()].sort((a, b) => a.seq - b.seq);
  byMessage.set(live.messageId, [
    ...rows.filter(r => r.agentId !== live.agentId),
    { agentId: live.agentId, steps },
  ]);
  arm(live.messageId, live.agentId);
  announce();
}

/**
 * EVERY PREVIEW HAS AN END, even the ones nobody closes.
 *
 * The engine sends `done` when the turn finishes, however it finishes. This
 * timer is the backstop for the case it never arrives — an engine that was
 * killed mid-turn — and it must stay: a list of steps that keeps growing in
 * somebody's eye-line for a turn that died is the app claiming work that is not
 * happening.
 */
function arm(messageId: ID, agentId: ID): void {
  const key = keyOf(messageId, agentId);
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(key, setTimeout(() => drop(messageId, agentId), LIVE_STEPS_STALE_MS));
}

function drop(messageId: ID, agentId: ID): void {
  const key = keyOf(messageId, agentId);
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
  const rows = byMessage.get(messageId);
  if (!rows) return;
  const next = rows.filter(r => r.agentId !== agentId);
  if (next.length === 0) byMessage.delete(messageId);
  else byMessage.set(messageId, next);
  announce();
}

/** Tests and a reconnect both want a clean slate. Nothing here survives either. */
export function clearLiveSteps(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  byMessage.clear();
  announce();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The rows for one message — the SAME array reference until something changes. */
export function liveStepsFor(messageId: ID): readonly Row[] {
  return byMessage.get(messageId) ?? EMPTY;
}

/**
 * Subscribe a component to one message's live steps.
 *
 * The HOOK lives here and the COMPONENT lives beside `RunSteps` in App.tsx, on
 * purpose: the steps are drawn by the one renderer the stored record already
 * uses, so there is no second way to draw a step, and this file does not import
 * the app back.
 */
export function useLiveSteps(messageId: ID): readonly Row[] {
  const snapshot = useCallback(() => liveStepsFor(messageId), [messageId]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export type LiveStepsRow = Row;
