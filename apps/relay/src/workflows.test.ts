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
    createdAt: 11, finishedAt: 12, updatedAt: 12,
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

test("a relay restart marks active runs interrupted and never resumes them", () => {
  const dbPath = tmp("workflow-interrupted.db");
  const firstRelay = new Relay({ dbPath, ownerToken: "tok-owner", ownerName: "Vikas" });
  const owner = firstRelay.store.userByToken("tok-owner")!;
  const run: WorkflowRun = {
    id: "wfr-active", workflowId: "wf-active", workflowVersion: 1, ownerId: owner.id,
    requestedBy: owner.id, channelId: "ch-general", status: "running", steps: [
      { id: "step-active", agentId: "agent-active", instruction: "Wait", status: "running", attempts: [], },
    ], currentStepId: "step-active", createdAt: 10, updatedAt: 11,
  };
  firstRelay.store.saveWorkflowRun(run);
  firstRelay.close();
  const restarted = new Relay({ dbPath, ownerToken: "tok-owner", ownerName: "Vikas" });
  const interrupted = restarted.store.workflowRun(run.id)!;
  assert.equal(interrupted.status, "interrupted");
  assert.match(interrupted.error ?? "", /restarted.*run it again manually/i);
  restarted.close();
});

test("run history orders by transition time, with id as a deterministic tie-breaker", () => {
  const store = new Store(tmp("workflow-order.db"), { ownerToken: "tok-owner" });
  const owner = store.ensureOwner("Vikas", "tok-owner");
  const base = (id: string, updatedAt: number): WorkflowRun => ({
    id, workflowId: "wf-order", workflowVersion: 1, ownerId: owner.id, requestedBy: owner.id,
    channelId: "ch-general", status: "running", steps: [], createdAt: 1, updatedAt,
  });
  store.saveWorkflowRun(base("run-old", 10));
  store.saveWorkflowRun(base("run-new", 20));
  assert.deepEqual(store.workflowRuns(owner.id).map(run => run.id).slice(0, 2), ["run-new", "run-old"]);
  store.db.close();
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

test("replayed terminal task updates are idempotent and cannot regress a run", async t => {
  const { owner, engine, channelId, relay } = await stand(t, "workflow-replay.db");
  const first = await makeAgent(owner, "Scout");
  const second = await makeAgent(owner, "Scribe");
  const workflow = await saveWorkflow(owner, channelId, [first.id, second.id], "Replay brief");
  const created = await run(owner, workflow);
  const taskOne = await engine.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.workflowRunId === created.id && f.task.workflowStepId === "step-1",
  );
  engine.send({ type: "updateTask", taskId: taskOne.task.id, status: "completed" });
  const taskTwo = await engine.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.workflowRunId === created.id && f.task.workflowStepId === "step-2",
  );
  engine.frames.length = 0;
  engine.send({ type: "updateTask", taskId: taskOne.task.id, status: "completed" });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(engine.frames.filter(f => f.type === "task" && f.task.workflowStepId === "step-2").length, 0);

  engine.send({ type: "updateTask", taskId: taskTwo.task.id, status: "completed" });
  await owner.wait(f => f.type === "workflowRun" && f.run.id === created.id && f.run.status === "succeeded");
  engine.send({ type: "updateTask", taskId: taskTwo.task.id, status: "working" });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(relay.store.task(taskTwo.task.id)?.status, "completed");
  assert.equal(relay.store.workflowRun(created.id)?.status, "succeeded");
});

test("workflow uses the existing approval gate and waits without claiming active work", async t => {
  const { owner, engine, channelId, relay } = await stand(t, "workflow-approval.db");
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

  // A delayed queued replay must not erase the visible approval wait.
  engine.send({ type: "updateTask", taskId: task.task.id, status: "not_started" });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(relay.store.task(task.task.id)?.status, "waiting_approval");
  assert.equal(relay.store.workflowRun(created.id)?.status, "waiting_you");

  owner.frames.length = 0;
  engine.frames.length = 0;
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
  owner.send({ type: "archiveWorkflow", workflowId: workflow.id, archived: true });
  const archived = await owner.wait<Extract<ServerFrame, { type: "workflow" }>>(
    frame => frame.type === "workflow" && frame.workflow.id === workflow.id && frame.workflow.archivedAt !== undefined,
  );
  assert.ok(archived.workflow.archivedAt);
  owner.send({ type: "archiveWorkflow", workflowId: workflow.id, archived: false });
  await owner.wait(frame => frame.type === "workflow" && frame.workflow.id === workflow.id && frame.workflow.archivedAt === undefined);
  const activityKinds = relay.store.activity(Date.now() + 1, 1000).map(record => record.kind);
  assert.ok(activityKinds.includes("workflow_created"));
  assert.ok(activityKinds.includes("workflow_archived"));
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

test("workflow tasks stay out of an unrelated friend's initial world and live feed", async t => {
  const { owner, engine, open } = await stand(t, "workflow-private-task.db");
  const agent = await makeAgent(owner, "Scout");
  owner.send({ type: "createChannel", name: "private-runbook", memberIds: [], kind: "channel" });
  const channel = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    frame => frame.type === "channel" && frame.channel.name === "private-runbook",
  );
  const workflow = await saveWorkflow(owner, channel.channel.id, [agent.id], "Private brief");
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(frame => frame.type === "invite");
  const friend = open("invite:" + invite.code + ":Priya");
  const welcome = await friend.wait<Extract<ServerFrame, { type: "welcome" }>>(frame => frame.type === "welcome");
  assert.equal(welcome.state.tasks.some(task => task.workflowId === workflow.id), false);
  friend.frames.length = 0;
  const run = await runWorkflowForTest(owner, workflow);
  await engine.wait(frame => frame.type === "task" && frame.task.workflowRunId === run.id);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(friend.frames.some(frame => frame.type === "task" && frame.task.workflowRunId === run.id), false);
  friend.close();
});

async function runWorkflowForTest(owner: TestClient, workflow: Workflow): Promise<WorkflowRun> {
  owner.send({ type: "runWorkflow", workflowId: workflow.id });
  return (await owner.wait<Extract<ServerFrame, { type: "workflowRun" }>>(
    frame => frame.type === "workflowRun" && frame.run.workflowId === workflow.id,
  )).run;
}

test("deleting an agent stops its active workflow instead of leaving it queued", async t => {
  const { owner, engine, channelId, relay } = await stand(t, "workflow-agent-delete.db");
  const agent = await makeAgent(owner, "Disposable");
  const workflow = await saveWorkflow(owner, channelId, [agent.id], "Delete race");
  const created = await run(owner, workflow);
  const task = await engine.wait<Extract<ServerFrame, { type: "task" }>>(
    frame => frame.type === "task" && frame.task.workflowRunId === created.id,
  );
  engine.send({ type: "updateTask", taskId: task.task.id, status: "working" });
  owner.send({ type: "deleteAgent", agentId: agent.id });
  const stopped = await owner.wait<Extract<ServerFrame, { type: "workflowRun" }>>(
    frame => frame.type === "workflowRun" && frame.run.id === created.id && frame.run.status === "stopped",
  );
  assert.match(stopped.run.error ?? "", /agent.*removed/i);
  assert.equal(relay.store.task(task.task.id)?.status, "cancelled");
});
