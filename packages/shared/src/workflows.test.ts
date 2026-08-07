import assert from "node:assert/strict";
import test from "node:test";
import { validateWorkflow, type Workflow } from "./index.js";

const good: Workflow = {
  id: "wf_demo",
  ownerId: "u_owner",
  channelId: "c_general",
  name: "Release notes",
  description: "Draft and check the notes.",
  enabled: true,
  version: 1,
  steps: [
    { id: "wfs_one", agentId: "a_writer", instruction: "Draft release notes in plain words." },
    { id: "wfs_two", agentId: "a_editor", instruction: "Check the draft for missing facts." },
  ],
  createdAt: 100,
  updatedAt: 100,
};

test("a saved workflow accepts ordered named steps", () => {
  assert.equal(validateWorkflow(good), null);
});

test("workflow validation rejects an empty instruction and duplicate step ids", () => {
  const empty = validateWorkflow({
    ...good,
    steps: [
      { id: "wfs_one", agentId: "a_writer", instruction: "" },
      { id: "wfs_one", agentId: "a_editor", instruction: "Check it." },
    ],
  });
  assert.ok(empty);
  assert.match(empty, /instruction/);
  const duplicate = validateWorkflow({
    ...good,
    steps: [
      { id: "wfs_one", agentId: "a_writer", instruction: "Draft it." },
      { id: "wfs_one", agentId: "a_editor", instruction: "Check it." },
    ],
  });
  assert.ok(duplicate);
  assert.match(duplicate, /unique/);
});

test("workflow validation requires one step to be runnable", () => {
  const error = validateWorkflow({ ...good, steps: [] });
  assert.equal(error, "add at least one workflow step");
});
