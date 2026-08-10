/**
 * The public state of one agent turn, as far as the desktop can honestly tell.
 *
 * This is deliberately a pure reducer-shaped function.  A receipt, a public
 * live step, or a task row is evidence; an agent lamp or a guessed timer is not.
 * Keeping the vocabulary here makes the card and its tests independent from
 * React, and keeps private provider reasoning out of the contract entirely.
 */
import type { AgentReceipt, ID, RunOutcome, RunStep, Task, TaskStatus } from "@cloud9/shared";

export type TurnLifecycleState =
  | "queued"
  | "accepted"
  | "working"
  | "waiting-user"
  | "completed"
  | "failed"
  | "cancelled";

export interface TurnLifecycleInput {
  /** A durable background task anchored to this exact message. */
  taskStatus?: TaskStatus;
  /** The latest receipt for this exact agent/message pair. */
  receipt?: Pick<AgentReceipt, "stage" | "verdict">;
  /** At least one public step arrived for this exact agent/message pair. */
  steps?: readonly Pick<RunStep, "seq" | "kind" | "label">[];
  /** A provider response preview is live for this exact message. */
  response?: "streaming" | "finalizing";
  /** A terminal record/stream signal, when the caller has one. */
  outcome?: RunOutcome;
  /** An accepted signal without a receipt stage (for a future wire version). */
  accepted?: boolean;
}

export interface TurnTaskAnchorMessage {
  id: ID;
  channelId: ID;
  authorId: ID;
  authorKind: string;
  deletedAt?: number;
}

/**
 * Join a durable task to the exact message that created it. A title is not an
 * identity: two requests may intentionally have the same words in one room.
 * Returning nothing for an ambiguous or legacy row is safer than drawing work
 * beneath the wrong message.
 */
export function taskForSourceMessage(
  message: TurnTaskAnchorMessage,
  tasks: readonly Task[],
  agentIds: ReadonlySet<ID>,
): Task | undefined {
  if (message.authorKind !== "human" || message.deletedAt !== undefined) return undefined;
  // Keep the desktop build compatible with an older linked shared declaration;
  // the source field is optional for legacy persisted tasks and is present in
  // the shared source contract above the package build boundary.
  const matches = tasks.filter(task => (task as Task & { sourceMessageId?: ID }).sourceMessageId === message.id
    && task.channelId === message.channelId
    && task.requesterId === message.authorId
    && agentIds.has(task.agentId));
  return matches.length === 1 ? matches[0] : undefined;
}

/** The words shown on the compact card. Keep them plain and stable. */
export const TURN_LIFECYCLE_WORDS: Readonly<Record<TurnLifecycleState, string>> = {
  queued: "Queued",
  accepted: "Accepted",
  working: "Working",
  "waiting-user": "Waiting for user",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * Resolve one state.  Terminal evidence always wins over a live preview, and
 * a durable task wins over a weaker/older receipt.  No input means no card.
 */
export function turnLifecycleState(input: TurnLifecycleInput): TurnLifecycleState | undefined {
  const outcome = input.outcome;
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "failed" || outcome === "refused") return "failed";
  if (outcome === "ok") return "completed";

  // A committed receipt is terminal evidence for this exact turn.  It must
  // beat a task echo that is one socket tick behind it.
  if (input.receipt?.stage === "verdict") {
    switch (input.receipt.verdict) {
      case "needsInput": return "waiting-user";
      case "conflict": return "failed";
      case "agreed":
      case "investigating": return "completed";
      default: return undefined;
    }
  }

  switch (input.taskStatus) {
    case "not_started": return "queued";
    case "working": return "working";
    case "waiting_user":
    case "waiting_approval":
    case "blocked": return "waiting-user";
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case undefined: break;
    default: {
      // TaskStatus is closed in this build.  An unknown newer status must not
      // look like completed work.
      return undefined;
    }
  }

  if (input.steps && input.steps.length > 0) return "working";
  if (input.response) return "working";
  if (input.receipt?.stage === "thinking") return "working";
  if (input.receipt?.stage === "reading" || input.accepted) return "accepted";
  return undefined;
}

/**
 * Stop is a capability claim, not another spelling of "working".  The
 * engine registers its real stop scope immediately before provider work and
 * the first public live-step frame is the desktop's proof that work crossed
 * that boundary.  Receipts, tasks, and response previews intentionally do not
 * grant this capability because they can arrive before registration.
 */
export function turnLifecycleStoppable(input: Pick<TurnLifecycleInput, "steps">): boolean {
  return (input.steps?.length ?? 0) > 0;
}

/** A single stable sentence for aria labels and the compact summary. */
export function turnLifecycleSentence(
  name: string, state: TurnLifecycleState,
): string {
  return `${name}: ${TURN_LIFECYCLE_WORDS[state]}`;
}
