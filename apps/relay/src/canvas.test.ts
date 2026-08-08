// Engineering Canvas — durable project documents with revision history.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

async function stand(t: TestContext) {
  const relay = new Relay({ dbPath: tmp("canvas.db"), ownerToken: "owner", ownerName: "Owner" });
  const port = await relay.listen(0); const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "owner"); await owner.wait(f => f.type === "welcome");
  const engine = new TestClient(url, "owner", "engine"); await engine.wait(f => f.type === "welcome");
  t.after(() => { owner.close(); engine.close(); relay.close(); });
  owner.send({ type: "connectProject", repo: "vikas53953/cloud9", name: "Canvas project" });
  const project = await owner.wait<Extract<ServerFrame, { type: "project" }>>(f => f.type === "project" && f.project.repo === "vikas53953/cloud9");
  await engine.wait(f => f.type === "lookAtProject" && f.projectId === project.project.id);
  engine.send({ type: "projectSynced", projectId: project.project.id, items: [] });
  return { owner, engine, projectId: project.project.id, url };
}

test("canvas edits are durable, attributed, tombstoned, and historical", async t => {
  const { owner, engine, projectId } = await stand(t);
  owner.send({ type: "createCanvas", projectId, title: "Architecture" });
  const made = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.title === "Architecture");
  owner.send({ type: "addCanvasBlock", canvasId: made.canvas.id, kind: "decision", text: "Use SQLite", link: { kind: "artifact", id: "missing" } });
  const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(refused.error, /accessible/);
  owner.send({ type: "addCanvasBlock", canvasId: made.canvas.id, kind: "decision", text: "Use SQLite" });
  const added = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.revision === 2);
  const block = added.canvas.blocks.find(b => !b.deletedAt)!;
  owner.send({ type: "editCanvasBlock", canvasId: made.canvas.id, blockId: block.id, text: "Use SQLite WAL" });
  const edited = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.revision === 3);
  assert.equal(edited.canvas.blocks.find(b => b.id === block.id)?.text, "Use SQLite WAL");
  owner.send({ type: "tombstoneCanvasBlock", canvasId: made.canvas.id, blockId: block.id });
  const removed = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.revision === 4);
  assert.ok(removed.canvas.blocks.find(b => b.id === block.id)?.deletedAt);
  owner.send({ type: "canvasHistory", canvasId: made.canvas.id, limit: 20 });
  const history = await owner.wait<Extract<ServerFrame, { type: "canvasHistory" }>>(f => f.type === "canvasHistory" && f.canvasId === made.canvas.id);
  assert.ok(history.revisions.length >= 4);
  engine.send({ type: "addCanvasBlock", canvasId: made.canvas.id, kind: "requirements", text: "Agent-authored note", authorAgentId: "missing-agent" });
  const denied = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /not your agent/);
});

test("canvas keeps only the recent 100 revisions after reopen", { timeout: 60_000 }, async t => {
  // 105 sequential durable writes + reopen need more than the default 5s budget.
  const dbPath = tmp("canvas-retention.db");
  const relay = new Relay({ dbPath, ownerToken: "owner", ownerName: "Owner" });
  const port = await relay.listen(0);
  const owner = new TestClient(`ws://127.0.0.1:${port}`, "owner");
  await owner.wait(f => f.type === "welcome");
  let firstClosed = false;
  t.after(() => {
    if (!firstClosed) { try { owner.close(); } catch { /* */ } try { relay.close(); } catch { /* */ } }
  });
  owner.send({ type: "connectProject", repo: "vikas53953/cloud9", name: "Retention project" });
  const project = await owner.wait<Extract<ServerFrame, { type: "project" }>>(
    f => f.type === "project" && f.project.repo === "vikas53953/cloud9",
  );
  owner.send({ type: "createCanvas", projectId: project.project.id, title: "Retention" });
  const made = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(
    f => f.type === "canvas" && f.canvas.title === "Retention",
  );
  for (let i = 0; i < 105; i++) {
    owner.send({ type: "addCanvasBlock", canvasId: made.canvas.id, kind: "markdown", text: `revision ${i}` });
    await owner.wait(f => f.type === "canvas" && f.canvas.id === made.canvas.id && f.canvas.revision === i + 2, 30_000);
  }

  // Close the first process cleanly, then read the same file from a fresh Relay.
  // This proves retention is on-disk rather than just a response limit.
  owner.close();
  // Let WS close handlers finish before shutting the store (huddle cleanup).
  await new Promise(r => setTimeout(r, 50));
  relay.close();
  firstClosed = true;
  try { relay.store.db.close(); } catch { /* already closed by relay.close */ }
  await new Promise(r => setTimeout(r, 50));
  const reopened = new Relay({ dbPath, ownerToken: "owner", ownerName: "Owner" });
  const reopenedPort = await reopened.listen(0);
  const reader = new TestClient(`ws://127.0.0.1:${reopenedPort}`, "owner");
  await reader.wait(f => f.type === "welcome");
  t.after(() => {
    try { reader.close(); } catch { /* */ }
    try { reopened.close(); } catch { /* */ }
  });
  reader.send({ type: "canvasHistory", canvasId: made.canvas.id, limit: 200 });
  const history = await reader.wait<Extract<ServerFrame, { type: "canvasHistory" }>>(
    f => f.type === "canvasHistory" && f.canvasId === made.canvas.id,
    15_000,
  );
  assert.equal(history.revisions.length, 100);
  assert.equal(history.revisions[0]?.revision, 106);
  assert.equal(history.revisions.at(-1)?.revision, 7);
});

test("canvas requests refuse an owner-only project to an invited outsider", async t => {
  const { owner, projectId, url } = await stand(t);
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const outsider = new TestClient(url, `invite:${invite.code}:Outsider`); t.after(() => outsider.close());
  await outsider.wait(f => f.type === "welcome");
  outsider.send({ type: "canvases", projectId });
  const denied = await outsider.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /no such project/);
});

test("canvas mutations are request-id idempotent and reject stale revisions", async t => {
  const { owner, projectId, url } = await stand(t);
  const second = new TestClient(url, "owner");
  await second.wait(f => f.type === "welcome");
  t.after(() => second.close());
  const createRequest = "canvas-create-retry";
  owner.send({ type: "createCanvas", projectId, title: "Retry me", requestId: createRequest });
  const made = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.title === "Retry me");
  owner.send({ type: "createCanvas", projectId, title: "Retry me", requestId: createRequest });
  const replay = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.id === made.canvas.id);
  assert.equal(replay.canvas.id, made.canvas.id);
  owner.send({ type: "addCanvasBlock", canvasId: made.canvas.id, kind: "decision", text: "first", expectedRevision: 1, requestId: "first-edit" });
  await owner.wait(f => f.type === "canvas" && f.canvas.revision === 2);
  second.send({ type: "addCanvasBlock", canvasId: made.canvas.id, kind: "decision", text: "stale", expectedRevision: 1, requestId: "stale-edit" });
  const refused = await second.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(refused.error, /changed/);
});

test("marking a canvas read is projected to every same-user window", async t => {
  const { owner, projectId, url } = await stand(t);
  const second = new TestClient(url, "owner");
  await second.wait(f => f.type === "welcome");
  t.after(() => second.close());
  owner.send({ type: "createCanvas", projectId, title: "Read sync" });
  const made = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.title === "Read sync");
  await second.wait(f => f.type === "canvas" && f.canvas.id === made.canvas.id);
  owner.send({ type: "markCanvasRead", canvasId: made.canvas.id, revision: made.canvas.revision });
  const synced = await second.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.id === made.canvas.id && !f.canvas.unread);
  assert.equal(synced.canvas.unread, false);
});

test("inaccessible linked records are redacted per reader without leaking the id", async t => {
  const { owner, engine, projectId, url } = await stand(t);
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const member = new TestClient(url, `invite:${invite.code}:Member`);
  t.after(() => member.close());
  const memberWelcome = await member.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "createChannel", name: "canvas-shared", memberIds: [memberWelcome.state.me.id] });
  const shared = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(f => f.type === "channel" && f.channel.name === "canvas-shared");
  owner.send({ type: "updateProject", projectId, channelId: shared.channel.id });
  await member.wait(f => f.type === "project" && f.project.id === projectId);
  owner.send({ type: "createAgent", agent: { name: "Task bot", emoji: "🤖", persona: "Task", abilities: { webSearch: false, files: false, schedules: false, background: false } } as never });
  const agent = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Task bot");
  owner.send({ type: "createChannel", name: "private-task", memberIds: [] });
  const privateChannel = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(f => f.type === "channel" && f.channel.name === "private-task");
  owner.send({ type: "createTask", agentId: agent.agent.id, channelId: privateChannel.channel.id, title: "Owner-only task" });
  const task = await owner.wait<Extract<ServerFrame, { type: "task" }>>(f => f.type === "task" && f.task.title === "Owner-only task");
  owner.send({ type: "createCanvas", projectId, title: "Links" });
  const made = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.title === "Links");
  owner.send({ type: "addCanvasBlock", canvasId: made.canvas.id, kind: "task", text: "private", link: { kind: "task", id: task.task.id } });
  await owner.wait(f => f.type === "canvas" && f.canvas.revision === 2);
  const redacted = await member.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.id === made.canvas.id && f.canvas.revision === 2);
  const block = redacted.canvas.blocks.find(b => b.kind === "task")!;
  assert.equal(block.link, undefined);
  assert.equal(block.linkUnavailable, true);
});

test("every Canvas mutation replays its receipt without applying twice", async t => {
  const { owner, projectId } = await stand(t);
  owner.send({ type: "createCanvas", projectId, title: "Receipts", requestId: "mut-create" });
  const made = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.title === "Receipts");
  owner.send({ type: "updateCanvas", canvasId: made.canvas.id, title: "Renamed", expectedRevision: 1, requestId: "mut-update" });
  await owner.wait(f => f.type === "canvas" && f.canvas.revision === 2);
  owner.send({ type: "updateCanvas", canvasId: made.canvas.id, title: "Renamed", expectedRevision: 1, requestId: "mut-update" });
  await owner.wait(f => f.type === "canvas" && f.canvas.revision === 2 && f.canvas.title === "Renamed");
  owner.send({ type: "addCanvasBlock", canvasId: made.canvas.id, kind: "decision", text: "one", expectedRevision: 2, requestId: "mut-add" });
  await owner.wait(f => f.type === "canvas" && f.canvas.revision === 3);
  owner.send({ type: "addCanvasBlock", canvasId: made.canvas.id, kind: "decision", text: "one", expectedRevision: 2, requestId: "mut-add" });
  await owner.wait(f => f.type === "canvas" && f.canvas.revision === 3);
  const block = (await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.revision === 3)).canvas.blocks[0];
  owner.send({ type: "editCanvasBlock", canvasId: made.canvas.id, blockId: block.id, text: "two", expectedRevision: 3, requestId: "mut-edit" });
  await owner.wait(f => f.type === "canvas" && f.canvas.revision === 4);
  owner.send({ type: "editCanvasBlock", canvasId: made.canvas.id, blockId: block.id, text: "two", expectedRevision: 3, requestId: "mut-edit" });
  await owner.wait(f => f.type === "canvas" && f.canvas.revision === 4);
  owner.send({ type: "tombstoneCanvasBlock", canvasId: made.canvas.id, blockId: block.id, expectedRevision: 4, requestId: "mut-delete" });
  await owner.wait(f => f.type === "canvas" && f.canvas.revision === 5);
  owner.send({ type: "tombstoneCanvasBlock", canvasId: made.canvas.id, blockId: block.id, expectedRevision: 4, requestId: "mut-delete" });
  const replay = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.revision === 5);
  assert.ok(replay.canvas.blocks[0].deletedAt);
});

test("Canvas request ids are bound to action, target, and payload", async t => {
  const { owner, projectId } = await stand(t);
  owner.send({ type: "createCanvas", projectId, title: "Receipt binding", requestId: "same-request" });
  const made = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.title === "Receipt binding");
  owner.send({ type: "updateCanvas", canvasId: made.canvas.id, title: "Different operation", requestId: "same-request" });
  const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "same-request");
  assert.match(refused.error, /different operation/);
});

test("deleting an agent finishes cleanly with canvas project still intact", async t => {
  const { owner, projectId } = await stand(t);
  owner.send({ type: "createAgent", agent: { name: "Room bot", emoji: "🤖", persona: "Room work", abilities: { webSearch: false, files: false, schedules: false, background: false } } as never });
  const madeAgent = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Room bot");
  owner.send({ type: "createCanvas", projectId, title: "Agent links", requestId: "agent-canvas" });
  const made = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(
    f => f.type === "canvas" && f.canvas.title === "Agent links" && f.requestId === "agent-canvas",
  );
  owner.send({ type: "deleteAgent", agentId: madeAgent.agent.id });
  const gone = await owner.wait<Extract<ServerFrame, { type: "agentDeleted" }>>(f => f.type === "agentDeleted" && f.agentId === madeAgent.agent.id);
  assert.equal(gone.agentId, madeAgent.agent.id);
  // Canvas is durable independently of the agent row.
  owner.send({ type: "canvases", projectId, requestId: "agent-canvas-list" });
  const list = await owner.wait<Extract<ServerFrame, { type: "canvases" }>>(
    f => f.type === "canvases" && f.projectId === projectId && f.requestId === "agent-canvas-list",
  );
  assert.ok(list.canvases.some(c => c.id === made.canvas.id));
});

test("Canvas read rejects non-finite or fractional revisions", async t => {
  const { owner, projectId } = await stand(t);
  owner.send({ type: "createCanvas", projectId, title: "Read validation" });
  const made = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.title === "Read validation");
  owner.send({ type: "markCanvasRead", canvasId: made.canvas.id, revision: 1.5 });
  const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(refused.error, /finite integer/);
});

test("engine Canvas mutations cannot masquerade as human writes", async t => {
  const { owner, engine, projectId } = await stand(t);
  owner.send({ type: "createCanvas", projectId, title: "Identity" });
  const made = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.title === "Identity");
  owner.send({ type: "addCanvasBlock", canvasId: made.canvas.id, kind: "decision", text: "human" });
  const added = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(f => f.type === "canvas" && f.canvas.revision === 2);
  for (const frame of [
    { type: "updateCanvas", canvasId: made.canvas.id, title: "spoof" } as const,
    { type: "editCanvasBlock", canvasId: made.canvas.id, blockId: added.canvas.blocks[0].id, text: "spoof" } as const,
    { type: "tombstoneCanvasBlock", canvasId: made.canvas.id, blockId: added.canvas.blocks[0].id } as const,
    { type: "addCanvasBlock", canvasId: made.canvas.id, kind: "decision", text: "spoof" } as const,
  ]) {
    engine.send(frame);
    const refused = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
    assert.match(refused.error, /must name an agent/);
  }
});


test("channel members never receive owner folder path or repo on canvas project projections", async t => {
  const { owner, projectId, url } = await stand(t);
  // Same membership path as the link-redaction test: invite a friend, put them
  // in a shared room, hang the project on that room, then create a canvas.
  // pushCanvasProject re-projects the project envelope to every audience
  // member — that envelope must stay member-safe (no repo, no localPath).
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const member = new TestClient(url, `invite:${invite.code}:CanvasMember`);
  t.after(() => member.close());
  const memberWelcome = await member.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "createChannel", name: "canvas-redact", memberIds: [memberWelcome.state.me.id] });
  const shared = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(f => f.type === "channel" && f.channel.name === "canvas-redact");
  owner.send({ type: "updateProject", projectId, channelId: shared.channel.id });
  await member.wait(f => f.type === "project" && f.project.id === projectId);
  owner.send({ type: "setProjectFolder", projectId, path: "C:\\Users\\owner\\private-repo" });
  const ownerFolder = await owner.wait<Extract<ServerFrame, { type: "project" }>>(
    f => f.type === "project" && f.project.id === projectId && !!f.project.localPath,
  );
  assert.equal(ownerFolder.project.repo, "vikas53953/cloud9");
  assert.ok(ownerFolder.project.localPath);

  // Project frames already received from updateProject / setProjectFolder must
  // be redacted for the member (repo cleared, no folder path).
  member.send({ type: "projects" });
  const memberProjects = await member.wait<Extract<ServerFrame, { type: "projects" }>>(f => f.type === "projects");
  const memberRow = memberProjects.projects.find(p => p.id === projectId);
  assert.ok(memberRow, "channel member should see the shared project by id/name");
  assert.equal(memberRow!.repo, "", "members must not receive the repo string");
  assert.equal(memberRow!.localPath, undefined, "members must not receive localPath");

  owner.send({ type: "createCanvas", projectId, title: "Member-safe" });
  const made = await owner.wait<Extract<ServerFrame, { type: "canvas" }>>(
    f => f.type === "canvas" && f.canvas.title === "Member-safe",
  );
  // Live canvas push reaches the member without leaking project secrets.
  await member.wait<Extract<ServerFrame, { type: "canvas" }>>(
    f => f.type === "canvas" && f.canvas.id === made.canvas.id,
  );

  // updateProject re-projects via viewProject(project, userId) for every
  // audience member — same redaction class as pushCanvasProject.
  owner.send({ type: "updateProject", projectId, name: "Canvas shared project" });
  const memberAfterCanvas = await member.wait<Extract<ServerFrame, { type: "project" }>>(
    f => f.type === "project" && f.project.id === projectId && f.project.name === "Canvas shared project",
  );
  assert.equal(memberAfterCanvas.project.repo, "", "canvas-era project push still redacts repo");
  assert.equal(memberAfterCanvas.project.localPath, undefined, "canvas-era project push still strips localPath");

  // Owner still sees the private path on their own projection.
  owner.send({ type: "projects" });
  const ownerProjects = await owner.wait<Extract<ServerFrame, { type: "projects" }>>(f => f.type === "projects");
  const ownerRow = ownerProjects.projects.find(p => p.id === projectId);
  assert.ok(ownerRow);
  assert.equal(ownerRow!.repo, "vikas53953/cloud9");
  assert.ok(ownerRow!.localPath);

  // Member can list canvases without learning the folder.
  member.send({ type: "canvases", projectId, requestId: "member-canvases" });
  const memberCanvases = await member.wait<Extract<ServerFrame, { type: "canvases" }>>(
    f => f.type === "canvases" && f.projectId === projectId && f.requestId === "member-canvases",
  );
  assert.ok(memberCanvases.canvases.some(c => c.title === "Member-safe"));
});
