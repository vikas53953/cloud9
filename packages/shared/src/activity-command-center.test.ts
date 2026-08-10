import assert from "node:assert/strict";
import test from "node:test";
import { taskMatchesCommandCenterFilter } from "./activity-command-center.js";

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
