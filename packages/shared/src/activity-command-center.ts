import type { Approval, ID, RunRecord, Task } from "./index.js";

/** Filters for the command-center's durable, server-authorized work rows. */
export type CommandCenterFilter = "all" | "mine" | "waiting" | "failed" | "completed";

export interface CommandCenterFacts {
  task: Pick<Task, "id" | "requesterId" | "status" | "approvalId" | "runId">;
  approvals: readonly Pick<Approval, "id" | "taskId" | "ownerId" | "status">[];
  runs: readonly Pick<RunRecord, "id" | "taskId" | "outcome">[];
  meId?: ID;
}

/**
 * Match only facts the relay already projected. In particular, a missing run,
 * approval, or actor identity is not a reason to invent a status.
 */
export function taskMatchesCommandCenterFilter(
  facts: CommandCenterFacts,
  filter: CommandCenterFilter,
): boolean {
  if (filter === "all") return true;
  const { task, meId } = facts;
  if (filter === "mine") return !!meId && task.requesterId === meId;
  const run = task.runId
    ? facts.runs.find(candidate => candidate.id === task.runId)
    : facts.runs.find(candidate => candidate.taskId === task.id);
  if (filter === "waiting") {
    return task.status === "waiting_user" || (!!meId && facts.approvals.some(approval =>
      approval.status === "pending" && approval.ownerId === meId &&
      (approval.taskId === task.id || approval.id === task.approvalId)));
  }
  if (filter === "failed") {
    return task.status === "failed" || task.status === "cancelled" ||
      run?.outcome === "failed" || run?.outcome === "cancelled" || run?.outcome === "refused";
  }
  return task.status === "completed" || run?.outcome === "ok";
}
