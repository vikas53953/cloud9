import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { Channel, EngineeringPulseDraft, Project, ProjectItem, RunRecord, ServerFrame, Task, newId, validateEngineeringPulseDraft } from "@cloud9/shared";
import { Relay } from "./server.js";
import { Store } from "./store.js";
import { TestClient, tmp } from "./testclient.js";

const draft: EngineeringPulseDraft = {
  done: "Shipped the intake copy", doing: "Reviewing the next task",
  blocked: "", decisions: "Keep the feed project-scoped", helpNeeded: "",
};
/** Section fields only — safe to spread into a stored EngineeringPulseUpdate. */
const draftSections = {
  done: draft.done, doing: draft.doing, blocked: draft.blocked,
  decisions: draft.decisions, helpNeeded: draft.helpNeeded,
};

async function stand(t: TestContext) {
  const relay = new Relay({ dbPath: tmp("engineering-pulse.db"), ownerToken: "pulse-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const clients: TestClient[] = [];
  t.after(() => { for (const c of clients) c.close(); relay.close(); });
  const open = (token: string, client: "desktop" | "engine" = "desktop") => {
    const c = new TestClient(`ws://127.0.0.1:${port}`, token, client); clients.push(c); return c;
  };
  const owner = open("pulse-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { relay, owner, open, ownerId: welcome.state.me.id };
}

function project(ownerId: string, channelId?: string): Project {
  return {
    id: newId("project"), ownerId, repo: "vikas53953/cloud9", name: "Cloud9",
    createdAt: Date.now(), ...(channelId ? { channelId } : {}),
  };
}

test("Engineering Pulse validates bounded sections and requires one section", () => {
  assert.equal(validateEngineeringPulseDraft(draft), null);
  assert.match(validateEngineeringPulseDraft({ ...draft, done: "", doing: "", decisions: "", helpNeeded: "", blocked: "" }) ?? "", /at least one/);
  assert.match(validateEngineeringPulseDraft({ ...draft, done: "x".repeat(2001) }) ?? "", /too long/);
});

test("Pulse updates persist across Store reopen and keep a deletion tombstone", () => {
  const db = tmp("pulse-store.db");
  const first = new Store(db);
  const p = project("u-owner");
  first.saveProject(p);
  first.savePulse({ id: "pulse-1", projectId: p.id, authorId: "u-owner", authorKind: "human", authorName: "Vikas",
    createdAt: 10, updatedAt: 10, ...draftSections, relatedTaskId: "task-secret" });
  first.markPulseRead("u-owner", p.id, 10);
  first.db.close();
  const second = new Store(db);
  assert.equal(second.schemaVersion(), 9);
  assert.equal(second.pulses(p.id)[0].id, "pulse-1");
  const row = second.pulse("pulse-1")!; row.deletedAt = 20; row.updatedAt = 20; second.savePulse(row);
  const tombstone = second.pulses(p.id)[0];
  assert.equal(tombstone.deletedAt, 20);
  // Soft-delete purges section bodies and related links in storage.
  assert.equal(tombstone.done, "");
  assert.equal(tombstone.doing, "");
  assert.equal(tombstone.blocked, "");
  assert.equal(tombstone.decisions, "");
  assert.equal(tombstone.helpNeeded, "");
  assert.equal(tombstone.relatedTaskId, undefined);
  const raw = second.db.prepare("SELECT json FROM pulse_updates WHERE id=?").get("pulse-1") as { json: string };
  assert.equal(raw.json.includes("Shipped the intake copy"), false, "deleted body must not remain in the row");
  assert.equal(raw.json.includes("task-secret"), false, "deleted related link must not remain in the row");
  second.db.close();
});

test("v6 migration runs Workflow v7, Saved v8, then Pulse v9 without collision", () => {
  const db = tmp("pulse-schema-collision.db");
  const first = new Store(db);
  first.db.exec("DROP TABLE pulse_mutation_receipts; DROP TABLE pulse_reads; DROP TABLE pulse_updates; "
    + "DROP TABLE saved_mutation_receipts; DROP TABLE saved_messages; DROP TABLE workflow_runs; DROP TABLE workflows; "
    + "UPDATE meta SET value='6' WHERE key='schemaVersion'");
  assert.equal(first.schemaVersion(), 6);
  first.db.close();
  const second = new Store(db);
  assert.equal(second.schemaVersion(), 9);
  const tables = second.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('workflows','workflow_runs','saved_messages','saved_mutation_receipts','pulse_updates','pulse_reads','pulse_mutation_receipts') ORDER BY name",
  ).all() as { name: string }[];
  assert.deepEqual(tables.map(row => row.name), ["pulse_mutation_receipts", "pulse_reads", "pulse_updates", "saved_messages", "saved_mutation_receipts", "workflow_runs", "workflows"]);
  second.db.close();
});

test("an already-v9 Pulse file gains the receipt project binding on reopen", () => {
  const db = tmp("pulse-receipt-binding.db");
  const first = new Store(db);
  first.db.exec("DROP TABLE pulse_mutation_receipts; "
    + "CREATE TABLE pulse_mutation_receipts(userId TEXT NOT NULL, requestId TEXT NOT NULL, "
    + "kind TEXT NOT NULL, payloadHash TEXT NOT NULL, updateId TEXT NOT NULL, createdAt INTEGER NOT NULL, "
    + "PRIMARY KEY(userId, requestId)); UPDATE meta SET value='9' WHERE key='schemaVersion'");
  first.db.close();
  const second = new Store(db);
  const columns = second.db.prepare("PRAGMA table_info(pulse_mutation_receipts)").all() as { name: string }[];
  assert.ok(columns.some(column => column.name === "projectId"));
  second.db.close();
});

test("v9 receipt repair backfills live updates and retires orphan ids", () => {
  const db = tmp("pulse-receipt-repair.db");
  const first = new Store(db);
  first.savePulse({ id: "bind-pulse", projectId: "project-bind", authorId: "u-owner", authorKind: "human",
    authorName: "Vikas", createdAt: 10, updatedAt: 10, ...draftSections });
  first.db.exec("DROP TABLE pulse_mutation_receipts; "
    + "CREATE TABLE pulse_mutation_receipts(userId TEXT NOT NULL, requestId TEXT NOT NULL, "
    + "kind TEXT NOT NULL, payloadHash TEXT NOT NULL, updateId TEXT NOT NULL, createdAt INTEGER NOT NULL, "
    + "PRIMARY KEY(userId, requestId)); "
    + "INSERT INTO pulse_mutation_receipts VALUES('u-owner','valid-request','pulseCreate','hash','bind-pulse',1); "
    + "INSERT INTO pulse_mutation_receipts VALUES('u-owner','orphan-request','pulseCreate','hash','gone-pulse',1); "
    + "UPDATE meta SET value='9' WHERE key='schemaVersion'");
  first.db.close();
  const second = new Store(db);
  const rows = (second.db.prepare(
    "SELECT requestId,projectId FROM pulse_mutation_receipts ORDER BY requestId",
  ).all() as { requestId: string; projectId: string }[]).map(row => ({ ...row }));
  assert.deepEqual(rows, [{ requestId: "valid-request", projectId: "project-bind" }]);
  second.db.close();
});

test("owner can post, edit, delete, list and mark a Pulse update", async t => {
  const { relay, owner, ownerId } = await stand(t);
  const p = project(ownerId);
  relay.store.saveProject(p);
  const item: ProjectItem = { projectId: p.id, kind: "pull", number: 4, title: "Pulse links",
    state: "open", url: "https://github.com/vikas53953/cloud9/pull/4", createdAt: 1, updatedAt: 2 };
  relay.store.syncProjectItems(p.id, [item]);

  owner.send({ type: "pulseCreate", projectId: p.id, draft: { ...draft, relatedProjectItem: { kind: "pull", number: 4 } }, requestId: "create-1" });
  const created = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.requestId === "create-1" && f.update.authorId === ownerId);
  assert.equal(created.update.done, draft.done);
  owner.send({ type: "pulseCreate", projectId: p.id, draft: { ...draft, relatedProjectItem: { kind: "pull", number: 4 } }, requestId: "create-1" });
  const replay = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.requestId === "create-1");
  assert.equal(replay.update.id, created.update.id, "replaying a create returns the original update");
  owner.send({ type: "pulseCreate", projectId: p.id, draft: { ...draft, doing: "changed" }, requestId: "create-1" });
  const conflict = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "create-1");
  assert.match(conflict.error, /request id was already used/);
  owner.send({ type: "pulseUpdate", updateId: created.update.id, patch: { doing: "Finished review" }, requestId: "update-1" });
  const updated = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.requestId === "update-1"
      && f.update.id === created.update.id && f.update.doing === "Finished review");
  assert.equal(updated.update.projectId, p.id);
  owner.send({ type: "pulseDelete", updateId: created.update.id, requestId: "delete-1" });
  const deleted = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.requestId === "delete-1"
      && f.update.id === created.update.id && !!f.update.deletedAt);
  assert.ok(deleted.update.deletedAt);
  // Wire projection must not ship the deleted section text (B1).
  assert.equal(deleted.update.done, "");
  assert.equal(deleted.update.doing, "");
  assert.equal(deleted.update.decisions, "");
  assert.equal(deleted.update.relatedProjectItem, undefined);
  assert.equal(deleted.update.done.includes("Shipped"), false);
  const stored = relay.store.pulse(created.update.id)!;
  assert.equal(stored.done, "");
  assert.equal(stored.relatedProjectItem, undefined);
  owner.send({ type: "pulseUpdate", updateId: created.update.id, patch: { doing: "should stay deleted" }, requestId: "update-deleted" });
  const editDenied = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "update-deleted");
  assert.match(editDenied.error, /deleted.*cannot be edited/);
  owner.send({ type: "pulseList", projectId: p.id, requestId: "list-after-delete" });
  const listed = await owner.wait<Extract<ServerFrame, { type: "pulse" }>>(
    f => f.type === "pulse" && f.requestId === "list-after-delete");
  const listedRow = listed.updates.find(u => u.id === created.update.id)!;
  assert.ok(listedRow.deletedAt);
  assert.equal(listedRow.done, "");
  assert.equal(listedRow.doing, "");
  assert.equal(JSON.stringify(listedRow).includes("Shipped the intake copy"), false);
  owner.send({ type: "pulseRead", projectId: p.id, at: Date.now(), requestId: "read-1" });
  const read = await owner.wait<Extract<ServerFrame, { type: "pulse" }>>(
    f => f.type === "pulse" && f.projectId === p.id && f.requestId === "read-1");
  assert.equal(read.unreadByProject[p.id], 0);
  owner.send({ type: "pulseRead", projectId: p.id, at: Number.MAX_SAFE_INTEGER, requestId: "read-future" });
  await owner.wait(f => f.type === "pulse" && f.requestId === "read-future");
  assert.ok(relay.store.pulseReadAt(ownerId, p.id) <= Date.now(), "future read watermarks are clamped");
});

test("clearing related links on edit uses null and list/replay stay clear", async t => {
  const { relay, owner, ownerId } = await stand(t);
  const p = project(ownerId); relay.store.saveProject(p);
  const task: Task = { id: "task-1", title: "Linked task", requesterId: ownerId,
    requesterName: "Vikas", agentId: "agent-1", channelId: "ch-pulse-link", status: "completed",
    createdAt: 1, updatedAt: 1 };
  relay.store.saveTask(task);
  const run: RunRecord = {
    id: "run-1", kind: "task", agentId: task.agentId, agentName: "bot",
    provider: "mock", requestedBy: "Vikas", requestedByKind: "human", ask: task.title,
    startedAt: 1, finishedAt: 2, durationMs: 1, outcome: "ok", steps: [], replyChars: 0, events: 0,
  };
  relay.store.saveRun({ record: run, agentId: task.agentId, ownerId, channelId: task.channelId });
  const item: ProjectItem = { projectId: p.id, kind: "pull", number: 9, title: "Link me",
    state: "open", url: "https://github.com/vikas53953/cloud9/pull/9", createdAt: 1, updatedAt: 2 };
  relay.store.syncProjectItems(p.id, [item]);

  owner.send({ type: "pulseCreate", projectId: p.id, draft: {
    ...draft, relatedTaskId: task.id, relatedRunId: run.id,
    relatedProjectItem: { kind: "pull", number: 9 },
  }, requestId: "link-create" });
  const created = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.requestId === "link-create");
  assert.equal(created.update.relatedTaskId, task.id);
  assert.equal(created.update.relatedRunId, run.id);
  assert.deepEqual(created.update.relatedProjectItem, { kind: "pull", number: 9 });

  // null is the explicit clear signal (undefined would be dropped by JSON).
  owner.send({ type: "pulseUpdate", updateId: created.update.id, patch: {
    relatedTaskId: null, relatedRunId: null, relatedProjectItem: null,
  }, requestId: "link-clear" });
  const cleared = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.requestId === "link-clear");
  assert.equal(cleared.update.relatedTaskId, undefined);
  assert.equal(cleared.update.relatedRunId, undefined);
  assert.equal(cleared.update.relatedProjectItem, undefined);
  assert.equal(relay.store.pulse(created.update.id)!.relatedTaskId, undefined);
  assert.equal(relay.store.pulse(created.update.id)!.relatedRunId, undefined);
  assert.equal(relay.store.pulse(created.update.id)!.relatedProjectItem, undefined);

  // Replay of the same clear must stay clear.
  owner.send({ type: "pulseUpdate", updateId: created.update.id, patch: {
    relatedTaskId: null, relatedRunId: null, relatedProjectItem: null,
  }, requestId: "link-clear" });
  const replay = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.requestId === "link-clear");
  assert.equal(replay.update.relatedTaskId, undefined);
  assert.equal(replay.update.relatedRunId, undefined);
  assert.equal(replay.update.relatedProjectItem, undefined);

  // Omitted keys still keep remaining links (only clear what was null'd).
  owner.send({ type: "pulseUpdate", updateId: created.update.id, patch: {
    relatedTaskId: task.id,
  }, requestId: "link-restore-task" });
  const restored = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.requestId === "link-restore-task");
  assert.equal(restored.update.relatedTaskId, task.id);
  owner.send({ type: "pulseUpdate", updateId: created.update.id, patch: {
    doing: "still working",
  }, requestId: "link-keep-omitted" });
  const kept = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.requestId === "link-keep-omitted");
  assert.equal(kept.update.relatedTaskId, task.id, "omitted relatedTaskId keeps the existing link");
  assert.equal(kept.update.doing, "still working");
});

test("editing or deleting an inaccessible Pulse id is indistinguishable from a missing id", async t => {
  const { relay, owner, open, ownerId } = await stand(t);
  const p = project(ownerId); relay.store.saveProject(p);
  owner.send({ type: "pulseCreate", projectId: p.id, draft, requestId: "probe-create" });
  const created = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.requestId === "probe-create");
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${invite.code}:Priya`);
  const friendWelcome = await friend.wait<Extract<ServerFrame, { type: "welcome" }>>(
    f => f.type === "welcome");
  assert.notEqual(friendWelcome.state.me.id, ownerId);
  friend.send({ type: "pulseUpdate", updateId: created.update.id, patch: { doing: "probe" }, requestId: "probe-real" });
  const realEdit = await friend.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "probe-real");
  friend.send({ type: "pulseUpdate", updateId: "missing-pulse-id", patch: { doing: "probe" }, requestId: "probe-missing" });
  const missingEdit = await friend.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "probe-missing");
  assert.equal(realEdit.error, "no such update");
  assert.equal(missingEdit.error, realEdit.error);
  friend.send({ type: "pulseDelete", updateId: created.update.id, requestId: "probe-real-delete" });
  const realDelete = await friend.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "probe-real-delete");
  friend.send({ type: "pulseDelete", updateId: "missing-pulse-id", requestId: "probe-missing-delete" });
  const missingDelete = await friend.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "probe-missing-delete");
  assert.equal(realDelete.error, "no such update");
  assert.equal(missingDelete.error, realDelete.error);
});

test("forgetting a project removes Pulse updates and their retry receipts", async t => {
  const { relay, owner, ownerId } = await stand(t);
  const p = project(ownerId); relay.store.saveProject(p);
  owner.send({ type: "pulseCreate", projectId: p.id, draft, requestId: "forget-create" });
  const created = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.requestId === "forget-create");
  assert.equal((relay.store.db.prepare("SELECT COUNT(*) n FROM pulse_mutation_receipts WHERE updateId=? AND projectId=?")
    .get(created.update.id, p.id) as { n: number }).n, 1);
  owner.send({ type: "forgetProject", projectId: p.id });
  await owner.wait<Extract<ServerFrame, { type: "projectForgotten" }>>(
    f => f.type === "projectForgotten" && f.projectId === p.id);
  assert.equal((relay.store.db.prepare("SELECT COUNT(*) n FROM pulse_updates WHERE projectId=?").get(p.id) as { n: number }).n, 0);
  assert.equal((relay.store.db.prepare("SELECT COUNT(*) n FROM pulse_mutation_receipts WHERE projectId=? OR updateId=?")
    .get(p.id, created.update.id) as { n: number }).n, 0);
});

test("connecting a project refreshes Pulse in every owner window", async t => {
  const { owner, open } = await stand(t);
  const mirror = open("pulse-owner");
  await mirror.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.frames.length = 0; mirror.frames.length = 0;
  owner.send({ type: "connectProject", repo: "vikas53953/cloud9" });
  const created = await owner.wait<Extract<ServerFrame, { type: "project" }>>(
    f => f.type === "project" && f.project.repo === "vikas53953/cloud9");
  const snapshot = await mirror.wait<Extract<ServerFrame, { type: "pulse" }>>(
    f => f.type === "pulse" && f.projects.some(p => p.id === created.project.id));
  assert.equal(snapshot.requestId, undefined, "peer windows receive an uncorrelated access push");
});

test("Pulse owner windows receive correlated answers only on the origin and no-id pushes elsewhere", async t => {
  const { relay, owner, open, ownerId } = await stand(t);
  const mirror = open("pulse-owner");
  await mirror.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const p = project(ownerId); relay.store.saveProject(p);

  owner.send({ type: "pulseList", projectId: p.id, requestId: "pulse-list-origin" });
  const originList = await owner.wait<Extract<ServerFrame, { type: "pulse" }>>(
    f => f.type === "pulse" && f.requestId === "pulse-list-origin");
  const mirrorList = await mirror.wait<Extract<ServerFrame, { type: "pulse" }>>(
    f => f.type === "pulse" && f.projects.some(project => project.id === p.id));
  assert.equal(originList.requestId, "pulse-list-origin");
  assert.equal(mirrorList.requestId, undefined);

  owner.send({ type: "pulseRead", projectId: p.id, requestId: "pulse-read-origin" });
  const originRead = await owner.wait<Extract<ServerFrame, { type: "pulse" }>>(
    f => f.type === "pulse" && f.requestId === "pulse-read-origin");
  const mirrorRead = await mirror.wait<Extract<ServerFrame, { type: "pulse" }>>(
    f => f.type === "pulse" && f.requestId === undefined && f.projects.some(project => project.id === p.id));
  assert.equal(originRead.requestId, "pulse-read-origin");
  assert.equal(mirrorRead.requestId, undefined);

  owner.send({ type: "pulseCreate", projectId: p.id, draft, requestId: "pulse-create-origin" });
  const originChange = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.requestId === "pulse-create-origin");
  const mirrorChange = await mirror.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.update.id === originChange.update.id);
  assert.equal(mirrorChange.requestId, undefined);
});

test("replayed Pulse changes redact a link after a reader loses task access", async t => {
  const { relay, owner, open, ownerId } = await stand(t);
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${invite.code}:Priya`);
  const fw = await friend.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const channel: Channel = { id: newId("pulse-privacy"), name: "pulse-privacy", kind: "channel",
    memberIds: [ownerId, fw.state.me.id], createdAt: Date.now() };
  relay.store.createChannel(channel, ownerId);
  const p = project(ownerId, channel.id); relay.store.saveProject(p);
  const task: Task = { id: "pulse-private-task", title: "Owner task", requesterId: ownerId,
    requesterName: "Vikas", agentId: "agent-owner", channelId: channel.id, status: "completed",
    createdAt: 1, updatedAt: 1 };
  relay.store.saveTask(task);
  owner.send({ type: "pulseCreate", projectId: p.id, draft: { ...draft, relatedTaskId: task.id }, requestId: "privacy-create" });
  const created = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.requestId === "privacy-create");
  await friend.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.update.id === created.update.id);

  // The friend remains a project-room member, but the task has moved to a
  // channel they cannot read. Replay must re-project the current access, not
  // resend the old raw link to every audience socket.
  relay.store.saveTask({ ...task, channelId: "channel-hidden-after-post", updatedAt: 2 });
  owner.frames.length = 0;
  friend.frames.length = 0;
  owner.send({ type: "pulseCreate", projectId: p.id, draft: { ...draft, relatedTaskId: task.id }, requestId: "privacy-create" });
  const ownerReplay = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.requestId === "privacy-create");
  const friendReplay = await friend.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.update.id === ownerReplay.update.id);
  assert.equal(friendReplay.update.relatedTaskId, undefined);
});

test("Pulse mutation receipts are owner-scoped and expire on lookup", () => {
  const db = tmp("pulse-receipts.db");
  const store = new Store(db);
  const hash = store.pulseMutationHash("pulseCreate", { projectId: "p", draft, agentId: null });
  const update = { id: "receipt-pulse", projectId: "p", authorId: "u-owner", authorKind: "human" as const,
    authorName: "Vikas", createdAt: 1, updatedAt: 1, ...draftSections };
  store.savePulseMutation("u-owner", "pulse-request", "pulseCreate", hash, update);
  assert.equal((store.db.prepare("SELECT projectId FROM pulse_mutation_receipts WHERE userId=? AND requestId=?")
    .get("u-owner", "pulse-request") as { projectId: string }).projectId, "p");
  assert.equal(store.pulseMutationStatus("u-owner", "pulse-request", "pulseCreate", hash)?.status, "replay");
  assert.equal(store.pulseMutationStatus("u-friend", "pulse-request", "pulseCreate", hash), undefined);
  store.db.prepare("UPDATE pulse_mutation_receipts SET createdAt=0 WHERE userId=? AND requestId=?")
    .run("u-owner", "pulse-request");
  assert.equal(store.pulseMutationStatus("u-owner", "pulse-request", "pulseCreate", hash), undefined);
  store.db.close();
});

test("an owner's engine may post as its stored agent, but cannot forge another agent", async t => {
  const { relay, owner, open, ownerId } = await stand(t);
  owner.send({ type: "createAgent", agent: {
    name: "Pulse bot", emoji: "ðŸ”­", persona: "Summarise the team", provider: "claude",
    abilities: { webSearch: true, files: false, schedules: false, background: false },
  } });
  const agent = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Pulse bot");
  const p = project(ownerId); relay.store.saveProject(p);
  const engine = open("pulse-owner", "engine"); await engine.wait(f => f.type === "welcome");
  engine.send({ type: "pulseCreate", projectId: p.id, agentId: agent.agent.id, draft });
  const posted = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.update.authorId === agent.agent.id);
  assert.equal(posted.update.authorKind, "agent");

  // A desktop cannot claim an agent author, even if it knows the id.
  owner.send({ type: "pulseCreate", projectId: p.id, agentId: agent.agent.id, draft });
  const denied = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /agent engine/);
});

test("an invited member can read and post only a project linked to their room", async t => {
  const { relay, owner, open, ownerId } = await stand(t);
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${invite.code}:Priya`);
  const fw = await friend.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const channel: Channel = { id: newId("channel"), name: "pulse-team", kind: "channel",
    memberIds: [ownerId, fw.state.me.id], createdAt: Date.now() };
  relay.store.createChannel(channel, ownerId);
  const p = project(ownerId, channel.id); relay.store.saveProject(p);
  friend.send({ type: "pulseList", projectId: p.id, requestId: "friend-list" });
  const listed = await friend.wait<Extract<ServerFrame, { type: "pulse" }>>(
    f => f.type === "pulse" && f.requestId === "friend-list");
  assert.equal(listed.updates.length, 0);
  assert.deepEqual(listed.projects.map(row => row.id), [p.id]);
  friend.send({ type: "pulseCreate", projectId: p.id, draft, requestId: "friend-create" });
  const posted = await friend.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.update.authorId === fw.state.me.id);
  assert.equal(posted.update.authorName, "Priya");
  const ownerCopy = await owner.wait<Extract<ServerFrame, { type: "pulseChanged" }>>(
    f => f.type === "pulseChanged" && f.update.id === posted.update.id);
  assert.equal(ownerCopy.unreadByProject[p.id], 1);

  // Losing room membership must redact the cached feed, not merely hide the
  // project picker. Relinking restores the same durable update for a member.
  owner.send({ type: "updateProject", projectId: p.id, channelId: "" });
  const unlinked = await friend.wait<Extract<ServerFrame, { type: "pulse" }>>(
    f => f.type === "pulse" && f.projects.every(row => row.id !== p.id));
  assert.equal(unlinked.updates.some(update => update.projectId === p.id), false);
  owner.send({ type: "updateProject", projectId: p.id, channelId: channel.id });
  const relinked = await friend.wait<Extract<ServerFrame, { type: "pulse" }>>(
    f => f.type === "pulse" && f.projects.some(row => row.id === p.id)
      && f.updates.some(update => update.id === posted.update.id));
  assert.equal(relinked.updates.some(update => update.id === posted.update.id), true);

  owner.send({ type: "removeMember", channelId: channel.id, memberId: fw.state.me.id });
  const removed = await friend.wait<Extract<ServerFrame, { type: "pulse" }>>(
    f => f.type === "pulse" && f.projects.every(row => row.id !== p.id));
  assert.equal(removed.updates.some(update => update.projectId === p.id), false);
});

test("owner-only Pulse projects cannot link another person's task or run", async t => {
  const { relay, owner, open, ownerId } = await stand(t);
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${invite.code}:Priya`);
  const fw = await friend.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const p = project(ownerId); relay.store.saveProject(p);

  const hiddenTask: Task = {
    id: "task-hidden-pulse", title: "Priya's private work", requesterId: fw.state.me.id,
    requesterName: "Priya", agentId: "agent-hidden-pulse", channelId: "channel-hidden-pulse",
    status: "completed", createdAt: 1, updatedAt: 1,
  };
  relay.store.saveTask(hiddenTask);
  const hiddenRun: RunRecord = {
    id: "run-hidden-pulse", kind: "task", agentId: hiddenTask.agentId, agentName: "Priya bot",
    provider: "mock", requestedBy: "Priya", requestedByKind: "human", ask: hiddenTask.title,
    startedAt: 1, finishedAt: 2, durationMs: 1, outcome: "ok", steps: [], replyChars: 0, events: 0,
  };
  relay.store.saveRun({ record: hiddenRun, agentId: hiddenTask.agentId, ownerId: fw.state.me.id, channelId: hiddenTask.channelId });

  owner.send({ type: "pulseCreate", projectId: p.id, draft: { ...draft, relatedTaskId: hiddenTask.id }, requestId: "hidden-task-link" });
  const taskDenied = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "hidden-task-link");
  assert.match(taskDenied.error, /related task is not available/);
  owner.send({ type: "pulseCreate", projectId: p.id, draft: { ...draft, relatedRunId: hiddenRun.id }, requestId: "hidden-run-link" });
  const runDenied = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "hidden-run-link");
  assert.match(runDenied.error, /related run is not available/);
});

test("a project outsider cannot probe or receive Pulse updates", async t => {
  const { relay, owner, open, ownerId } = await stand(t);
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${invite.code}:Priya`);
  await friend.wait(f => f.type === "welcome");
  const p = project(ownerId); relay.store.saveProject(p);
  owner.send({ type: "pulseCreate", projectId: p.id, draft });
  await owner.wait(f => f.type === "pulseChanged" && f.update.projectId === p.id);
  friend.send({ type: "pulseList", projectId: p.id });
  const denied = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /no such project/);
  assert.equal(friend.frames.some(f => f.type === "pulseChanged"), false);
});
