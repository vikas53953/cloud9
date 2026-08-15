// WHAT A SAVED WORKFLOW IS DOING, in the owner's words.
//
// The list and detail screens used to show a name, a raw channel id, and
// implementation asides ("v1", "separate from the agent Workflow tool"). The
// run already carries purpose, agents, the current step, failures, and
// outputs — the join of those facts is what a developer scans for, so it
// lives here as pure functions a test can read. The screen only draws.

export type WorkflowRunStatusWord =
  | "queued" | "running" | "waiting_you" | "succeeded" | "failed" | "stopped" | "interrupted";

export function workflowStatusWords(status: WorkflowRunStatusWord): string {
  switch (status) {
    case "queued": return "Queued";
    case "running": return "Running";
    case "waiting_you": return "Waiting for you";
    case "succeeded": return "Finished";
    case "failed": return "Failed";
    case "stopped": return "Stopped";
    case "interrupted": return "Stopped when Cloud9 restarted";
  }
}

/** v1 workflows do not fire on a clock or an event. */
export function workflowTriggerWords(): string {
  return "You press Run";
}

export function workflowReadyWords(workflow: {
  archivedAt?: number;
  enabled: boolean;
}): string {
  if (workflow.archivedAt) return "Archived";
  return workflow.enabled ? "Ready to run" : "Switched off";
}

export function workflowPurposeWords(workflow: {
  description?: string;
  steps: { instruction: string }[];
}): string {
  const description = workflow.description?.trim();
  if (description) return description;
  const first = workflow.steps.find(step => step.instruction.trim())?.instruction.trim();
  if (first) return first;
  return "No description yet";
}

export function workflowAgentNames(
  steps: { agentId: string }[],
  agents: { id: string; name: string }[],
): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const step of steps) {
    if (!step.agentId || seen.has(step.agentId)) continue;
    seen.add(step.agentId);
    names.push(agents.find(agent => agent.id === step.agentId)?.name ?? "Agent removed");
  }
  return names;
}

export function workflowAgentLine(names: readonly string[]): string {
  if (names.length === 0) return "No agents chosen yet";
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return names[0] + " and " + names[1];
  return names.slice(0, -1).join(", ") + ", and " + names[names.length - 1];
}

export function workflowRoomWords(
  channelId: string,
  channels: { id: string; name: string }[],
): string {
  const channel = channels.find(item => item.id === channelId);
  return channel ? "#" + channel.name : "Room removed";
}

function clipInstruction(text: string, max = 72): string {
  const trimmed = text.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1).trimEnd() + "…";
}

export function workflowCurrentStep(run: {
  currentStepId?: string;
  steps: { id: string; instruction: string; status: string }[];
} | undefined): { index: number; instruction: string; status: string } | undefined {
  if (!run?.steps.length) return undefined;
  const byId = run.currentStepId
    ? run.steps.find(step => step.id === run.currentStepId)
    : undefined;
  const live = byId ?? run.steps.find(step =>
    step.status === "running" || step.status === "waiting_you" || step.status === "queued");
  if (!live) return undefined;
  return { index: run.steps.indexOf(live) + 1, instruction: live.instruction, status: live.status };
}

export function workflowCurrentStepWords(run: {
  status: WorkflowRunStatusWord;
  currentStepId?: string;
  error?: string;
  steps: { id: string; instruction: string; status: string; error?: string }[];
} | undefined): string {
  if (!run) return "Not run yet";
  if (run.status === "succeeded") return "Finished";
  if (run.status === "stopped") return "Stopped";
  if (run.status === "interrupted") return "Stopped when Cloud9 restarted";
  if (run.status === "failed") {
    const failed = run.steps.find(step => step.status === "failed");
    if (failed) {
      return "Failed on step " + (run.steps.indexOf(failed) + 1) + " · " + clipInstruction(failed.instruction);
    }
    return run.error?.trim() || "Failed";
  }
  const current = workflowCurrentStep(run);
  if (current) {
    const verb = current.status === "waiting_you" ? "Waiting on" : "Now";
    return verb + ": step " + current.index + " of " + run.steps.length + " · " + clipInstruction(current.instruction);
  }
  return workflowStatusWords(run.status);
}

export function workflowFailureWords(run: {
  error?: string;
  steps: { status: string; error?: string; instruction: string }[];
} | undefined): string | undefined {
  if (!run) return undefined;
  if (run.error?.trim()) return run.error.trim();
  const failed = run.steps.find(step => step.status === "failed" || step.error);
  return failed?.error?.trim() || undefined;
}

export function workflowStepOutput(step: {
  result?: string;
  attempts?: { result?: string }[];
}): string | undefined {
  if (step.result?.trim()) return step.result.trim();
  const last = [...(step.attempts ?? [])].reverse().find(attempt => attempt.result?.trim());
  return last?.result?.trim();
}

export function workflowApprovalsForRun<
  T extends { id: string; workflowRunId?: string; approvalId?: string },
  A extends { id: string; taskId?: string },
>(runId: string, tasks: T[], approvals: A[]): A[] {
  const runTasks = tasks.filter(task => task.workflowRunId === runId);
  const taskIds = new Set(runTasks.map(task => task.id));
  const approvalIds = new Set(runTasks.map(task => task.approvalId).filter((id): id is string => !!id));
  return approvals.filter(approval =>
    (approval.taskId && taskIds.has(approval.taskId)) || approvalIds.has(approval.id));
}

export function workflowApprovalWords(status: string): string {
  switch (status) {
    case "pending": return "Waiting for you";
    case "approved": return "Approved";
    case "rejected": return "Rejected";
    case "expired": return "Closed";
    default: return status;
  }
}

export function latestWorkflowRun<T extends { workflowId: string }>(
  runs: T[],
  workflowId: string,
): T | undefined {
  return runs.find(run => run.workflowId === workflowId);
}

export function workflowLatestOutput(run: {
  steps: { result?: string; attempts?: { result?: string }[] }[];
} | undefined): string | undefined {
  if (!run) return undefined;
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const text = workflowStepOutput(run.steps[i]!);
    if (text) return text;
  }
  return undefined;
}

/** One line under a saved workflow: where it is, or what the last run left. */
export function workflowRowNowWords(
  workflow: { archivedAt?: number; enabled: boolean; steps: unknown[] },
  run: Parameters<typeof workflowCurrentStepWords>[0] & {
    steps: { result?: string; attempts?: { result?: string }[]; id: string; instruction: string; status: string; error?: string }[];
  } | undefined,
): string {
  if (!run) {
    const n = workflow.steps.length;
    return workflowReadyWords(workflow) + " · " + n + (n === 1 ? " step" : " steps");
  }
  if (run.status === "succeeded") return workflowLatestOutput(run) || "Last run finished";
  return workflowCurrentStepWords(run);
}
