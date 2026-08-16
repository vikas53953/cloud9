import assert from "node:assert/strict";
import test from "node:test";
import {
  latestWorkflowRun,
  workflowAgentLine,
  workflowAgentNames,
  workflowApprovalWords,
  workflowApprovalsForRun,
  workflowCurrentStep,
  workflowCurrentStepWords,
  workflowFailureWords,
  workflowLatestOutput,
  workflowPurposeWords,
  workflowReadyWords,
  workflowRoomWords,
  workflowRowNowWords,
  workflowStatusWords,
  workflowStepOutput,
  workflowTriggerWords,
} from "./workflow-view.js";

const agents = [
  { id: "a_writer", name: "Writer" },
  { id: "a_editor", name: "Editor" },
];

test("workflow status words stay in the owner's language", () => {
  assert.equal(workflowStatusWords("succeeded"), "Finished");
  assert.equal(workflowStatusWords("waiting_you"), "Waiting for you");
  assert.equal(workflowStatusWords("interrupted"), "Stopped when Cloud9 restarted");
  assert.equal(workflowTriggerWords(), "You press Run");
  assert.equal(workflowReadyWords({ enabled: true }), "Ready to run");
  assert.equal(workflowReadyWords({ enabled: false }), "Switched off");
  assert.equal(workflowReadyWords({ enabled: true, archivedAt: 9 }), "Archived");
});

test("purpose prefers the description, then the first step, and never invents one", () => {
  assert.equal(workflowPurposeWords({
    description: "Draft and check the notes.",
    steps: [{ instruction: "Ignore this fallback." }],
  }), "Draft and check the notes.");
  assert.equal(workflowPurposeWords({
    description: "  ",
    steps: [{ instruction: "Draft release notes in plain words." }],
  }), "Draft release notes in plain words.");
  assert.equal(workflowPurposeWords({ steps: [] }), "No description yet");
});

test("involved agents stay unique and in step order", () => {
  assert.deepEqual(workflowAgentNames([
    { agentId: "a_writer" },
    { agentId: "a_editor" },
    { agentId: "a_writer" },
  ], agents), ["Writer", "Editor"]);
  assert.deepEqual(workflowAgentNames([{ agentId: "a_gone" }], agents), ["Agent removed"]);
  assert.equal(workflowAgentLine([]), "No agents chosen yet");
  assert.equal(workflowAgentLine(["Writer"]), "Writer");
  assert.equal(workflowAgentLine(["Writer", "Editor"]), "Writer and Editor");
  assert.equal(workflowAgentLine(["Writer", "Editor", "Reviewer"]), "Writer, Editor, and Reviewer");
  assert.equal(workflowRoomWords("c_general", [{ id: "c_general", name: "general" }]), "#general");
  assert.equal(workflowRoomWords("c_gone", []), "Room removed");
});

test("current step and failures come from the run, not from a second story", () => {
  const running = {
    status: "running" as const,
    currentStepId: "s2",
    steps: [
      { id: "s1", instruction: "Draft the notes.", status: "succeeded" },
      { id: "s2", instruction: "Check the draft for missing facts.", status: "running" },
    ],
  };
  assert.deepEqual(workflowCurrentStep(running), {
    index: 2, instruction: "Check the draft for missing facts.", status: "running",
  });
  assert.equal(
    workflowCurrentStepWords(running),
    "Now: step 2 of 2 · Check the draft for missing facts.",
  );
  assert.equal(workflowCurrentStepWords(undefined), "Not run yet");
  assert.equal(workflowCurrentStepWords({
    status: "failed",
    error: "Writer stopped.",
    steps: [
      { id: "s1", instruction: "Draft the notes.", status: "failed", error: "Writer stopped." },
    ],
  }), "Failed on step 1 · Draft the notes.");
  assert.equal(workflowFailureWords({
    error: "Writer stopped.",
    steps: [{ status: "failed", instruction: "Draft the notes." }],
  }), "Writer stopped.");
  assert.equal(latestWorkflowRun([
    { workflowId: "wf_a", id: "newer" },
    { workflowId: "wf_b", id: "other" },
  ], "wf_a")?.id, "newer");
});

test("outputs and approvals attach to the run that produced them", () => {
  assert.equal(workflowStepOutput({ result: "Notes drafted." }), "Notes drafted.");
  assert.equal(workflowStepOutput({
    attempts: [{ result: "old" }, { result: "Notes drafted." }],
  }), "Notes drafted.");
  assert.equal(workflowStepOutput({ attempts: [] }), undefined);
  const approvals = workflowApprovalsForRun("run_1", [
    { id: "t1", workflowRunId: "run_1", approvalId: "ap1" },
    { id: "t2", workflowRunId: "run_2", approvalId: "ap2" },
  ], [
    { id: "ap1", taskId: "t1" },
    { id: "ap2", taskId: "t2" },
    { id: "ap3", taskId: "t1" },
  ]);
  assert.deepEqual(approvals.map(item => item.id), ["ap1", "ap3"]);
  assert.equal(workflowApprovalWords("pending"), "Waiting for you");
  assert.equal(workflowApprovalWords("approved"), "Approved");
  assert.equal(workflowLatestOutput({
    steps: [{ result: "first" }, { result: "Notes drafted." }],
  }), "Notes drafted.");
  assert.equal(workflowRowNowWords({ enabled: true, steps: [{}, {}] }, undefined), "Ready to run · 2 steps");
  assert.equal(workflowRowNowWords({ enabled: true, steps: [{}] }, {
    status: "succeeded",
    steps: [{ id: "s1", instruction: "Draft", status: "succeeded", result: "Notes drafted." }],
  }), "Notes drafted.");
});
