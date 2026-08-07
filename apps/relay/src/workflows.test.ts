import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { ServerFrame, Workflow, WorkflowRun } from "@cloud9/shared";
import { Relay } from "./server.js";
import { Store } from "./store.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "🔭",
  persona: "You research and report in plain words.",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
  approvals: { background: false, schedules: false },
};

async function stand(t: TestContext, name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = "ws://127.0.0.1:" + port;
  const clients: TestClient[] = [];
  t.after(() => { for (const client of clients) client.close(); relay.close(); });
  const open = (token: string, kind: "desktop" | "engine" = "desktop") => {
    const client = new TestClient(url, token, kind);
    clients.push(client);
    return client;
  };
  const owner = open("tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const engine = open("tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  return { relay, owner, engine, open, channelId: welcome.state.channels[0].id };
}

async function makeAgent(client: TestClient, name: string, approvals = false) {
  client.send({
    type: "createAgent",
    agent: {
      ...BASE_AGENT,
      name,
      abilities: { ...BASE_AGENT.abilities, background: approvals },
      approvals: { background: approvals, schedules: false },
    },
  });
  const frame = await client.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === name,
  );
  return frame.agent;
}

async function saveWorkflow(owner: TestClient, channelId: string, agentIds: string[], name = "Morning brief") {
  owner.send({
    type: "createWorkflow",
    workflow: {
      channelId,
      name,
      description: "A small ordered runbook.",
      enabled: true,
      steps: agentIds.map((agentId, index) => ({
        id: "step-" + (index + 1), agentId, instruction: "Report finding " + (index + 1),
      })),
    },
  });
  const frame = await owner.wait<Extract<ServerFrame, { type: "workflow" }>>(
    f => f.type === "workflow" && f.workflow.name === name,
  );
  return frame.workflow;
}

async function run(owner: TestClient, workflow: Workflow): Promise<WorkflowRun> {
  owner.frames.length = 0;
  owner.send({ type: "runWorkflow", workflowId: workflow.id });
  const frame = await owner.wait<Extract<ServerFrame, { type: "workflowRun" }>>(
    f => f.type === "workflowRun" && f.run.workflowId === workflow.id,
  );
  return frame.run;
}

test("workflow definitions and runs survive a Store reopen at schema 7", () => {
  const dbPath = tmp("workflow-restart.db");
  const first = new Store(dbPath, { ownerToken: "tok-owner" });
  const owner = first.ensureOwner("Vikas", "tok-owner");
  const workflow: Workflow = {
    id: "wf-restart", ownerId: owner.id, channelId: "ch-general", name: "Restart proof",
    description: "Keep this definition.", enabled: true, version: 1,
    steps: [{ id: "step-restart", agentId: "agent-restart", instruction: "Keep this step." }],
    createdAt: 10, updatedAt: 10,
  };
  const run: WorkflowRun = {
    id: "wfr-restart", workflowId: workflow.id, workflowVersion: 1, ownerId: owner.id,
    requestedBy: owner.id, channelId: workflow.channelId, status: "succeeded",
    steps: [{ ...workflow.steps[0], status: "succeeded", attempts: [] }],
    createdAt: 11, finishedAt: 12,
  };
  first.saveWorkflow(workflow);
  first.saveWorkflowRun(run);
  assert.equal(first.schemaVersion(), 7);
  first.db.close();

  const second = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.deepEqual(second.workflow(workflow.id), workflow);
  assert.deepEqual(second.workflowRun(run.id), run);
  assert.equal(second.schemaVersion(), 7);
  second.db.close();
});

test("opening a schema 6 database applies the workflow migration idempotently", () => {
  const dbPath = tmp("workflow-migration.db");
  const old = new Store(dbPath, { ownerToken: "tok-owner" });
  old.db.exec("DROP TABLE workflow_runs; DROP TABLE workflows; UPDATE meta SET value='6' WHERE key='schemaVersion'");
  old.db.close();

  const migrated = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(migrated.schemaVersion(), 7);
  const tables = migrated.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workflows','workflow_runs') ORDER BY name",
  ).all() as { name: string }[];
  assert.deepEqual(tables.map(row => row.name), ["workflow_runs", "workflows"]);
  migrated.db.close();
});

test("workflow run executes ordered steps through the existing task path", async t => {
  const { owner, engine, channelId, relay } = await stand(t, "workflow-serial.db");
  const first = await makeAgent(owner, "Scout");
  const second = await makeAgent(owner, "Scribe");
  const workflow = await saveWorkflow(owner, channelId, [first.id, second.id]);

  const created = await run(owner, workflow);
  assert.equal(created.status, "queued");
  const taskOne = await engine.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.workflowRunId === created.id && f.task.workflowStepId === "step-1",
  );
  assert.equal(taskOne.task.title, "Report finding 1");
  engine.send({ type: "updateTask", taskId: taskOne.task.id, status: "working" });
  await owner.wait(f => f.type === "workflowRun" && f.run.id === created.id && f.run.status === "running");
  engine.send({ type: "updateTask", taskId: taskOne.task.id, status: "waiting_user" });
  await owner.wait(f => f.type === "workflowRun" && f.run.id === created.id && f.run.status === "waiting_you");
  engine.send({ type: "updateTask", taskId: taskOne.task.id, status: "working" });
  engine.send({ type: "updateTask", taskId: taskOne.task.id, status: "completed", result: "first result" });

  const taskTwo = await engine.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.workflowRunId === created.id && f.task.workflowStepId === "step-2",
  );
  assert.equal(taskTwo.task.title, "Report finding 2");
  assert.equal(relay.store.task(taskTwo.task.id)?.workflowRunId, created.id);
  engine.send({ type: "updateTask", taskId: taskTwo.task.id, status: "completed", result: "second result" });

  const done = await owner.wait<Extract<ServerFrame, { type: "workflowRun" }>>(
    f => f.type === "workflowRun" && f.run.id === created.id && f.run.status === "succeeded",
  );
  assert.equal(done.run.steps[0].status, "succeeded");
  assert.equal(done.run.steps[1].status, "succeeded");
  assert.equal(done.run.steps[0].result, "first result");
  assert.equal(done.run.steps[1].result, "second result");
});

test("workflow uses the existing approval gate and waits without claiming active work", async t => {
  const { owner, engine, channelId } = await stand(t, "workflow-approval.db");
  const agent = await makeAgent(owner, "Careful", true);
  const workflow = await saveWorkflow(owner, channelId, [agent.id], "Approval brief");
  const created = await run(owner, workflow);
  const waiting = await owner.wait<Extract<ServerFrame, { type: "workflowRun" }>>(
    f => f.type === "workflowRun" && f.run.id === created.id && f.run.status === "waiting_you",
  );
  assert.equal(waiting.run.steps[0].status, "waiting_you");
  const task = await owner.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.workflowRunId === created.id,
  );
  assert.equal(task.task.status, "waiting_approval");
  assert.ok(task.task.approvalId);

  owner.send({ type: "decideApproval", approvalId: task.task.approvalId!, decision: "approved" });
  await owner.wait(f => f.type === "workflowRun" && f.run.id === created.id && f.run.status === "queued");
  const released = await engine.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.id === task.task.id && f.task.status === "not_started",
  );
  engine.send({ type: "updateTask", taskId: released.task.id, status: "completed" });
  const done = await owner.wait(f => f.type === "workflowRun" && f.run.id === created.id && f.run.status === "succeeded");
  assert.equal(done.type, "workflowRun");
});

test("failure stops at the failed step and retry creates a new attempt", async t => {
  const { owner, engine, channelId } = await stand(t, "workflow-retry.db");
  const agent = await makeAgent(owner, "Scout");
  const workflow = await saveWorkflow(owner, channelId, [agent.id], "Retry brief");
  const created = await run(owner, workflow);
  const task = await engine.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.workflowRunId === created.id,
  );
  engine.send({ type: "updateTask", taskId: task.task.id, status: "failed", error: "the source was unavailable" });
  const failed = await owner.wait<Extract<ServerFrame, { type: "workflowRun" }>>(
    f => f.type === "workflowRun" && f.run.id === created.id && f.run.status === "failed",
  );
  assert.equal(failed.run.steps[0].error, "the source was unavailable");
  owner.frames.length = 0;
  owner.send({ type: "retryWorkflow", workflowRunId: created.id, stepId: "step-1" });
  const retried = await owner.wait<Extract<ServerFrame, { type: "workflowRun" }>>(
    f => f.type === "workflowRun" && f.run.id === created.id && f.run.steps[0].attempts.length === 2,
  );
  assert.equal(retried.run.status, "queued");
  assert.notEqual(retried.run.steps[0].attempts[0].taskId, retried.run.steps[0].attempts[1].taskId);
  const retryTask = await engine.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.id === retried.run.steps[0].attempts[1].taskId,
  );
  engine.send({ type: "updateTask", taskId: retryTask.task.id, status: "completed" });
  await owner.wait(f => f.type === "workflowRun" && f.run.id === created.id && f.run.status === "succeeded");
});

test("stopping a waiting workflow marks the step stopped and retires its approval", async t => {
  const { owner, channelId } = await stand(t, "workflow-stop.db");
  const agent = await makeAgent(owner, "Careful", true);
  const workflow = await saveWorkflow(owner, channelId, [agent.id], "Stop brief");
  const created = await run(owner, workflow);
  const task = await owner.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.workflowRunId === created.id,
  );
  owner.send({ type: "stopWorkflow", workflowRunId: created.id });
  const stopped = await owner.wait<Extract<ServerFrame, { type: "workflowRun" }>>(
    f => f.type === "workflowRun" && f.run.id === created.id && f.run.status === "stopped",
  );
  assert.equal(stopped.run.steps[0].status, "stopped");
  assert.equal(relayApproval(owner, task.task.approvalId), "expired");
});

function relayApproval(owner: TestClient, approvalId?: string): string | undefined {
  const frame = [...owner.frames].reverse().find(f => f.type === "approval" && f.approval.id === approvalId);
  return frame?.type === "approval" ? frame.approval.status : undefined;
}

test("owner-only workflow gates reject a friend and missing agents stay explicit", async t => {
  const { owner, open, channelId, relay } = await stand(t, "workflow-permissions.db");
  const agent = await makeAgent(owner, "Scout");
  const workflow = await saveWorkflow(owner, channelId, [agent.id], "Owner brief");
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open("invite:" + invite.code + ":Priya");
  await friend.wait(f => f.type === "welcome");

  friend.send({ type: "listWorkflows" });
  const guestList = await friend.wait<Extract<ServerFrame, { type: "workflows" }>>(f => f.type === "workflows");
  assert.deepEqual(guestList.workflows, []);
  friend.send({
    type: "createWorkflow",
    workflow: { channelId, name: "No", enabled: true, steps: [{ id: "x", agentId: agent.id, instruction: "No" }] },
  });
  const denied = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /only the owner can create workflows/);

  relay.store.db.prepare("DELETE FROM agents WHERE id=?").run(agent.id);
  owner.send({ type: "runWorkflow", workflowId: workflow.id });
  const missing = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(missing.error, /workflow step agent is missing/);
  friend.close();
});
