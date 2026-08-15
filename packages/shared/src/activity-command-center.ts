import type {
  ActivityKind, ActivityRecord, Approval, Channel, ID, RunRecord, Task,
} from "./index.js";

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

/** Plain-words kind labels for the activity trail. The row's `detail` stays the sentence. */
export const ACTIVITY_KIND_WORDS: Record<ActivityKind, string> = {
  message: "Said",
  task_created: "Job",
  task_status: "Job",
  approval_requested: "Asked you",
  approval_decided: "Go-ahead",
  approval_checkpoint: "Go-ahead",
  agent_created: "Agent",
  agent_updated: "Agent",
  agent_deleted: "Agent",
  workflow_created: "Workflow",
  workflow_updated: "Workflow",
  workflow_archived: "Workflow",
  workflow_run_started: "Workflow",
  workflow_run_state: "Workflow",
  channel_created: "Room",
  member_added: "Room",
  invite_created: "Invite",
  invite_redeemed: "Invite",
  channel_updated: "Room",
  channel_archived: "Room",
  member_removed: "Room",
  member_role_changed: "Room",
  message_edited: "Edited",
  message_deleted: "Deleted",
  run_recorded: "Work",
  project_connected: "Project",
  project_updated: "Project",
  project_forgotten: "Project",
  canvas_created: "Canvas",
  canvas_block_added: "Canvas",
  project_poll_created: "Poll",
  project_poll_voted: "Poll",
  project_poll_closed: "Poll",
  artifact_access_changed: "File access",
  pulse_created: "Pulse",
  pulse_updated: "Pulse",
  pulse_deleted: "Pulse",
  forum_topic_deleted: "Forum",
  forum_reply_deleted: "Forum",
  forum_status_changed: "Forum",
  forum_decision_accepted: "Forum",
  forum_member_added: "Forum",
  forum_member_removed: "Forum",
};

export function activityKindWords(kind: ActivityKind): string {
  return ACTIVITY_KIND_WORDS[kind];
}

export interface ActivityFeedWorld {
  channels: readonly Pick<Channel, "id" | "name" | "kind">[];
  tasks: readonly Pick<Task, "id" | "title" | "channelId" | "runId" | "approvalId" | "status">[];
  approvals: readonly Pick<Approval, "id" | "taskId" | "channelId" | "status" | "action" | "detail">[];
  runs: Readonly<Record<string, Pick<RunRecord, "id" | "channelId" | "taskId" | "files" | "tests" | "steps" | "outcome" | "ask" | "branch" | "commit" | "pullRequest" | "truncated">>>;
  messages: Readonly<Record<string, readonly { id: ID }[]>>;
}

export interface ActivityLinkedFacts {
  channelName?: string;
  task?: ActivityFeedWorld["tasks"][number];
  run?: ActivityFeedWorld["runs"][string];
  approval?: ActivityFeedWorld["approvals"][number];
}

export function activityRoomName(
  channelId: ID | undefined,
  channels: ActivityFeedWorld["channels"],
): string | undefined {
  if (!channelId) return undefined;
  const channel = channels.find(candidate => candidate.id === channelId);
  if (!channel) return undefined;
  return channel.kind === "dm" ? "Direct message" : channel.name;
}

function channelIdOfMessage(
  messageId: ID,
  messages: ActivityFeedWorld["messages"],
): ID | undefined {
  for (const [channelId, list] of Object.entries(messages)) {
    if (list.some(row => row.id === messageId)) return channelId;
  }
  return undefined;
}

/**
 * Join one ledger row to rooms, jobs, runs, and go-aheads already in world.
 * Missing links stay absent — this must not invent a place or an outcome.
 */
export function linkActivityRow(
  row: Pick<ActivityRecord, "kind" | "refId">,
  world: ActivityFeedWorld,
): ActivityLinkedFacts {
  const taskById = (id?: ID) => id ? world.tasks.find(task => task.id === id) : undefined;
  const approvalById = (id?: ID) => id ? world.approvals.find(approval => approval.id === id) : undefined;
  const runById = (id?: ID) => id ? world.runs[id] : undefined;

  const linked = (
    run?: ActivityLinkedFacts["run"],
    task?: ActivityLinkedFacts["task"],
    approval?: ActivityLinkedFacts["approval"],
    channelId?: ID,
  ): ActivityLinkedFacts => {
    const channelName = activityRoomName(channelId, world.channels);
    return {
      ...(run ? { run } : {}),
      ...(task ? { task } : {}),
      ...(approval ? { approval } : {}),
      ...(channelName ? { channelName } : {}),
    };
  };

  if (row.kind === "run_recorded") {
    const run = runById(row.refId);
    const task = run?.taskId ? taskById(run.taskId) : world.tasks.find(task => task.runId === row.refId);
    const approval = approvalById(task?.approvalId)
      ?? world.approvals.find(candidate => candidate.taskId && candidate.taskId === task?.id);
    return linked(run, task, approval, run?.channelId ?? task?.channelId ?? approval?.channelId);
  }

  if (row.kind === "task_created" || row.kind === "task_status") {
    const task = taskById(row.refId);
    const run = runById(task?.runId);
    const approval = approvalById(task?.approvalId)
      ?? world.approvals.find(candidate => candidate.taskId === task?.id);
    return linked(run, task, approval, task?.channelId ?? approval?.channelId ?? run?.channelId);
  }

  if (row.kind === "approval_requested" || row.kind === "approval_decided" || row.kind === "approval_checkpoint") {
    const approval = approvalById(row.refId);
    const task = taskById(approval?.taskId)
      ?? world.tasks.find(candidate => candidate.approvalId === approval?.id);
    const run = runById(task?.runId);
    return linked(run, task, approval, approval?.channelId ?? task?.channelId ?? run?.channelId);
  }

  if (row.kind === "message" || row.kind === "message_edited" || row.kind === "message_deleted") {
    const channelId = row.refId ? channelIdOfMessage(row.refId, world.messages) : undefined;
    const name = activityRoomName(channelId, world.channels);
    return name ? { channelName: name } : {};
  }

  if (
    row.kind === "channel_created" || row.kind === "channel_updated" || row.kind === "channel_archived"
    || row.kind === "member_added" || row.kind === "member_removed" || row.kind === "member_role_changed"
  ) {
    const name = activityRoomName(row.refId, world.channels);
    return name ? { channelName: name } : {};
  }

  return {};
}

export interface ActivityOutcomeChip {
  key: "files" | "tests" | "outcome" | "approval";
  label: string;
}

const RUN_OUTCOME_CHIP: Record<NonNullable<ActivityLinkedFacts["run"]>["outcome"], string> = {
  ok: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  refused: "Refused",
};

const APPROVAL_CHIP: Record<NonNullable<ActivityLinkedFacts["approval"]>["status"], string> = {
  pending: "Waiting for you",
  approved: "Approved",
  rejected: "Refused",
  expired: "Expired",
};

const INSPECTABLE_STEP_KINDS = new Set(["command", "write", "read", "search", "web", "tool", "note"]);

/**
 * Compact engineering facts already on the joined run or go-ahead.
 * Absent arrays stay absent — this must not print "0 files" or guessed tests.
 */
export function activityOutcomeChips(linked: ActivityLinkedFacts): ActivityOutcomeChip[] {
  const chips: ActivityOutcomeChip[] = [];
  const files = linked.run?.files;
  if (files?.length) {
    chips.push({
      key: "files",
      label: files.length === 1 ? "1 file changed" : `${files.length} files changed`,
    });
  }
  const tests = linked.run?.tests;
  if (tests?.length) {
    const passed = tests.filter(test => test.ok === true).length;
    const failed = tests.filter(test => test.ok === false).length;
    const unsaid = tests.length - passed - failed;
    const parts: string[] = [];
    if (passed) parts.push(`${passed} passed`);
    if (failed) parts.push(`${failed} failed`);
    if (unsaid) parts.push(`${unsaid} not reported`);
    chips.push({ key: "tests", label: `Tests · ${parts.join(", ")}` });
  }
  if (linked.run?.outcome) {
    chips.push({ key: "outcome", label: RUN_OUTCOME_CHIP[linked.run.outcome] });
  }
  if (linked.approval) {
    const status = APPROVAL_CHIP[linked.approval.status];
    chips.push({
      key: "approval",
      label: linked.approval.action ? `${status} · ${linked.approval.action}` : status,
    });
  }
  return chips;
}

export function activityInspectableSteps(
  steps: ActivityFeedWorld["runs"][string]["steps"] | undefined,
): NonNullable<ActivityFeedWorld["runs"][string]["steps"]> {
  if (!steps?.length) return [];
  return steps.filter(step => INSPECTABLE_STEP_KINDS.has(step.kind));
}

export function activityHasDetails(linked: ActivityLinkedFacts, kind: ActivityKind): boolean {
  if (kind === "run_recorded") return true;
  if (linked.run?.steps?.length) return true;
  if (linked.run?.files?.length) return true;
  if (linked.run?.tests?.length) return true;
  if (linked.approval?.detail) return true;
  return false;
}
