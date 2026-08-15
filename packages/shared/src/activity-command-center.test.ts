import assert from "node:assert/strict";
import test from "node:test";
import {
  activityHasDetails, activityInspectableSteps, activityKindWords,
  activityOutcomeChips, linkActivityRow, taskMatchesCommandCenterFilter,
} from "./activity-command-center.js";

const task = (patch: Record<string, unknown> = {}) => ({
  id: "task-1", requesterId: "u-1", status: "working" as const,
  approvalId: "approval-1", runId: "run-1", ...patch,
});
const approval = (patch: Record<string, unknown> = {}) => ({
  id: "approval-1", taskId: "task-1", ownerId: "u-1", status: "pending" as const, ...patch,
});
const run = (patch: Record<string, unknown> = {}) => ({
  id: "run-1", taskId: "task-1", outcome: "failed" as const, ...patch,
});

test("command-center filters use explicit public task/run/approval facts", () => {
  assert.equal(taskMatchesCommandCenterFilter({ task: task(), approvals: [], runs: [], meId: "u-1" }, "mine"), true);
  assert.equal(taskMatchesCommandCenterFilter({ task: task(), approvals: [approval()], runs: [], meId: "u-1" }, "waiting"), true);
  assert.equal(taskMatchesCommandCenterFilter({ task: task({ status: "waiting_user" }), approvals: [], runs: [], meId: "u-1" }, "waiting"), true);
  assert.equal(taskMatchesCommandCenterFilter({ task: task(), approvals: [], runs: [run()], meId: "u-1" }, "failed"), true);
  assert.equal(taskMatchesCommandCenterFilter({ task: task({ status: "completed" }), approvals: [], runs: [], meId: "u-1" }, "completed"), true);
});

test("command-center does not infer waiting, failed, or completed states", () => {
  const facts = { task: task(), approvals: [], runs: [], meId: "u-1" };
  assert.equal(taskMatchesCommandCenterFilter(facts, "waiting"), false);
  assert.equal(taskMatchesCommandCenterFilter(facts, "failed"), false);
  assert.equal(taskMatchesCommandCenterFilter(facts, "completed"), false);
  assert.equal(taskMatchesCommandCenterFilter({ ...facts, meId: undefined }, "mine"), false);
});

const feed = (patch: {
  channels?: { id: string; name: string; kind: "channel" | "dm" }[];
  tasks?: ReturnType<typeof task>[];
  approvals?: ReturnType<typeof approval>[];
  runs?: Record<string, ReturnType<typeof run>>;
  messages?: Record<string, { id: string }[]>;
} = {}) => ({
  channels: patch.channels ?? [{ id: "ch-ops", name: "ops", kind: "channel" as const }],
  tasks: patch.tasks ?? [task({ channelId: "ch-ops" })],
  approvals: patch.approvals ?? [approval({ channelId: "ch-ops" })],
  runs: patch.runs ?? { "run-1": run({ channelId: "ch-ops", files: ["a.ts", "b.ts"] }) },
  messages: patch.messages ?? { "ch-ops": [{ id: "m-1" }] },
});

test("activity trail joins who/what to a room, run files, and go-ahead without inventing them", () => {
  const fromRun = linkActivityRow({ kind: "run_recorded", refId: "run-1" }, feed());
  assert.equal(fromRun.channelName, "ops");
  assert.deepEqual(fromRun.run?.files, ["a.ts", "b.ts"]);
  assert.equal(fromRun.approval?.status, "pending");

  const fromTask = linkActivityRow({ kind: "task_created", refId: "task-1" }, feed({
    runs: {},
  }));
  assert.equal(fromTask.channelName, "ops");
  assert.equal(fromTask.run, undefined);

  const fromMessage = linkActivityRow({ kind: "message", refId: "m-1" }, feed());
  assert.equal(fromMessage.channelName, "ops");

  assert.equal(activityKindWords("run_recorded"), "Work");
});

test("activity trail stays silent when the room, run, or message is not in world", () => {
  const empty = feed({ channels: [], tasks: [], approvals: [], runs: {}, messages: {} });
  assert.deepEqual(linkActivityRow({ kind: "run_recorded", refId: "run-1" }, empty), {});
  assert.deepEqual(linkActivityRow({ kind: "message", refId: "m-missing" }, feed()), {});
  const dm = linkActivityRow({ kind: "channel_created", refId: "dm-1" }, feed({
    channels: [{ id: "dm-1", name: "dm:a:b", kind: "dm" }],
  }));
  assert.equal(dm.channelName, "Direct message");
});

test("activity outcome chips only name facts the run or go-ahead already holds", () => {
  assert.deepEqual(activityOutcomeChips({}), []);
  assert.deepEqual(activityOutcomeChips({ run: run({ files: [] }) }), []);
  const chips = activityOutcomeChips({
    run: run({
      files: ["a.ts", "b.ts"],
      tests: [{ command: "npm test", ok: true }, { command: "lint", ok: false }],
      outcome: "failed",
    }),
    approval: approval({ status: "pending", action: "push" }),
  });
  assert.deepEqual(chips.map(chip => chip.key), ["files", "tests", "outcome", "approval"]);
  assert.equal(chips[0]?.label, "2 files changed");
  assert.match(chips[1]?.label ?? "", /1 passed/);
  assert.match(chips[1]?.label ?? "", /1 failed/);
  assert.equal(chips[2]?.label, "Failed");
  assert.equal(chips[3]?.label, "Waiting for you · push");
});

test("activity inspectable steps omit thinking and do not invent a log", () => {
  assert.deepEqual(activityInspectableSteps(undefined), []);
  const shown = activityInspectableSteps([
    { seq: 1, kind: "thinking", label: "private" },
    { seq: 2, kind: "command", label: "Ran npm test", detail: "npm test", ok: true },
    { seq: 3, kind: "message", label: "said" },
  ]);
  assert.deepEqual(shown.map(step => step.seq), [2]);
  assert.equal(activityHasDetails({}, "message"), false);
  assert.equal(activityHasDetails({}, "run_recorded"), true);
});
