import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { Project, ServerFrame, Task } from "@cloud9/shared";
import { Relay } from "./server.js";
import { Store, SCHEMA_VERSION } from "./store.js";
import { TestClient, tmp } from "./testclient.js";

async function stand(t: TestContext, name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const clients: TestClient[] = [];
  t.after(() => { for (const c of clients) c.close(); relay.close(); });
  const open = (token: string, client: "desktop" | "engine" = "desktop"): TestClient => {
    const c = new TestClient(url, token, client);
    clients.push(c);
    return c;
  };
  const owner = open("tok-owner");
  await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const project: Project = {
    id: "project-forum", ownerId: relay.ownerId, repo: "vikas53953/cloud9",
    name: "Cloud9", createdAt: Date.now(),
  };
  relay.store.saveProject(project);
  return { relay, owner, project, open };
}

test("forums persist topics, threaded replies, accepted decisions, tombstones and read state", async t => {
  const { relay, owner, project } = await stand(t, "forums-roundtrip.db");
  owner.send({ type: "forumTopic", projectId: project.id, title: "Release decision", body: "Should we ship?", tags: ["release"] });
  const created = await owner.wait<Extract<ServerFrame, { type: "forumTopic" }>>(
    f => f.type === "forumTopic" && f.topic.title === "Release decision",
  );
  owner.send({ type: "forumReply", topicId: created.topic.id, body: "Ship it" });
  const replied = await owner.wait<Extract<ServerFrame, { type: "forumTopic" }>>(
    f => f.type === "forumTopic" && f.topic.replyCount === 1,
  );
  const answer = replied.replies[0];
  owner.send({ type: "forumReply", topicId: created.topic.id, parentId: answer.id, body: "Agreed" });
  await owner.wait(f => f.type === "forumTopic" && f.topic.replyCount === 2);
  owner.send({ type: "forumAcceptReply", topicId: created.topic.id, replyId: answer.id, summary: "Ship after smoke test" });
  const resolved = await owner.wait<Extract<ServerFrame, { type: "forumChanged" }>>(
    f => f.type === "forumChanged" && !!f.topic?.decisionSummary,
  );
  assert.equal(resolved.topic!.decisionSummary, "Ship after smoke test");
  assert.equal(resolved.topic!.status, "resolved");
  const trail = relay.store.activity(Date.now() + 1, 50);
  assert.ok(trail.some(r => r.kind === "forum_decision_accepted" && r.refId === created.topic.id));

  owner.send({ type: "forumDeleteReply", replyId: answer.id });
  const delReply = await owner.wait<Extract<ServerFrame, { type: "forumChanged" }>>(
    f => f.type === "forumChanged" && !!f.reply?.deletedAt,
  );
  assert.equal(delReply.reply!.links.length, 0);
  assert.ok(relay.store.activity(Date.now() + 1, 20).some(r => r.kind === "forum_reply_deleted"));

  owner.send({ type: "forumMarkRead", projectId: project.id, ts: Date.now() });
  const read = await owner.wait<Extract<ServerFrame, { type: "forumRead" }>>(f => f.type === "forumRead");
  assert.ok(read.entry.lastReadAt > 0);
  assert.equal(relay.store.forumReplies(created.topic.id).length, 2);
});

test("forum membership isolates project topics and owner-only moderation", async t => {
  const { relay, owner, project, open } = await stand(t, "forums-members.db");
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${invite.code}:Priya`);
  await friend.wait(f => f.type === "welcome");

  friend.send({ type: "forumProjects" });
  assert.deepEqual(
    (await friend.wait<Extract<ServerFrame, { type: "forumProjects" }>>(f => f.type === "forumProjects")).projects,
    [],
  );
  friend.send({ type: "forumList", projectId: project.id });
  assert.match(
    (await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error")).error,
    /no such forum project/,
  );
  friend.frames = friend.frames.filter(f => f.type !== "error");
  const friendId = relay.store.users().find(u => u.name === "Priya")!.id;
  owner.send({ type: "forumAddMember", projectId: project.id, userId: friendId });
  friend.send({ type: "forumProjects" });
  const visible = await friend.wait<Extract<ServerFrame, { type: "forumProjects" }>>(
    f => f.type === "forumProjects" && f.projects.length === 1,
  );
  assert.equal(visible.projects[0].id, project.id);
  friend.send({ type: "forumTopic", projectId: project.id, title: "Question", body: "Details" });
  const topic = await friend.wait<Extract<ServerFrame, { type: "forumTopic" }>>(
    f => f.type === "forumTopic" && f.topic.title === "Question",
  );
  friend.frames = friend.frames.filter(f => f.type !== "error");
  friend.send({ type: "forumSetStatus", topicId: topic.topic.id, status: "archived" });
  assert.match(
    (await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error")).error,
    /only the project owner/,
  );
});

test("forgetting a project removes forum receipts atomically with master cleanups", async t => {
  const { relay, owner, project } = await stand(t, "forums-forget.db");
  owner.send({
    type: "forumTopic", projectId: project.id, title: "Forget me", body: "Receipt cleanup",
    requestId: "forget-topic",
  });
  const created = await owner.wait<Extract<ServerFrame, { type: "forumTopic" }>>(
    f => f.type === "forumTopic" && f.requestId === "forget-topic",
  );
  assert.ok(relay.store.forumRequestInfo(relay.ownerId, "forget-topic"));
  owner.send({ type: "forgetProject", projectId: project.id });
  await owner.wait(f => f.type === "projectForgotten" && f.projectId === project.id);
  assert.equal(relay.store.forumRequestInfo(relay.ownerId, "forget-topic"), undefined);
  assert.equal(relay.store.forumTopic(created.topic.id), undefined);
  assert.equal(relay.store.project(project.id), undefined);
});

test("forum mutations are idempotent, redact links per reader, and soft-delete redacts decision residue", async t => {
  const { relay, owner, project, open } = await stand(t, "forums-hardening.db");
  owner.send({ type: "createChannel", name: "forum-private", memberIds: [] });
  const channel = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "forum-private",
  );
  const bound = { ...project, channelId: channel.channel.id };
  relay.store.saveProject(bound);
  const task: Task = {
    id: "forum-private-task", title: "Private", requesterId: relay.ownerId, requesterName: "Vikas",
    agentId: "agent", channelId: channel.channel.id, status: "completed",
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  relay.store.saveTask(task);

  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${invite.code}:Priya`);
  await friend.wait(f => f.type === "welcome");
  const friendId = relay.store.users().find(u => u.name === "Priya")!.id;
  owner.send({ type: "forumAddMember", projectId: project.id, userId: friendId, requestId: "member-add" });
  await friend.wait<Extract<ServerFrame, { type: "forumProjects" }>>(
    f => f.type === "forumProjects" && f.projects.length === 1,
  );
  assert.ok(relay.store.activity(Date.now() + 1, 30).some(r => r.kind === "forum_member_added"));

  const create = {
    type: "forumTopic" as const, projectId: project.id, title: "Idempotent", body: "Keep one",
    links: [{ kind: "task" as const, id: "forum-private-task" }], requestId: "topic-retry",
  };
  owner.send(create);
  const first = await owner.wait<Extract<ServerFrame, { type: "forumTopic" }>>(
    f => f.type === "forumTopic" && f.requestId === create.requestId,
  );
  owner.send(create);
  await owner.wait<Extract<ServerFrame, { type: "forumTopic" }>>(
    f => f.type === "forumTopic" && f.requestId === create.requestId && f.topic.id === first.topic.id,
  );
  assert.equal(relay.store.forumTopics(project.id).items.length, 1, "retry cannot create a second topic");

  owner.send({
    type: "forumReply", topicId: first.topic.id, body: "request id cannot change operation",
    requestId: create.requestId,
  });
  assert.match(
    (await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error")).error,
    /already used/,
  );

  friend.send({ type: "forumList", projectId: project.id, requestId: "friend-list" });
  const friendFeed = await friend.wait<Extract<ServerFrame, { type: "forumFeed" }>>(
    f => f.type === "forumFeed" && f.requestId === "friend-list",
  );
  assert.equal(friendFeed.topics[0].links.length, 0, "private-channel task redacted for non-member");

  owner.send({
    type: "forumReply", topicId: first.topic.id, body: "Private context",
    links: [{ kind: "task", id: "forum-private-task" }],
  });
  await owner.wait<Extract<ServerFrame, { type: "forumTopic" }>>(
    f => f.type === "forumTopic" && f.topic.id === first.topic.id && f.topic.replyCount === 1,
  );
  friend.send({ type: "forumOpen", topicId: first.topic.id, requestId: "friend-open" });
  const friendTopic = await friend.wait<Extract<ServerFrame, { type: "forumTopic" }>>(
    f => f.type === "forumTopic" && f.requestId === "friend-open",
  );
  assert.equal(friendTopic.replies[0].links.length, 0);

  owner.send({ type: "forumReply", topicId: first.topic.id, body: "Ship" });
  const withShip = await owner.wait<Extract<ServerFrame, { type: "forumTopic" }>>(
    f => f.type === "forumTopic" && f.topic.replyCount === 2,
  );
  const ship = withShip.replies.find(r => r.body === "Ship")!;
  owner.send({
    type: "forumAcceptReply", topicId: first.topic.id, replyId: ship.id,
    summary: "We ship Friday", requestId: "accept-1",
  });
  await owner.wait(f => f.type === "forumChanged" && f.requestId === "accept-1");

  owner.send({ type: "forumDeleteTopic", topicId: first.topic.id, requestId: "topic-delete" });
  const tomb = await owner.wait<Extract<ServerFrame, { type: "forumChanged" }>>(
    f => f.type === "forumChanged" && f.requestId === "topic-delete" && !!f.topic?.deletedAt,
  );
  assert.equal(tomb.topic!.title, "Deleted topic");
  assert.equal(tomb.topic!.decisionSummary, undefined);
  assert.deepEqual(tomb.topic!.tags, []);
  assert.deepEqual(tomb.topic!.links, []);
  assert.ok(relay.store.activity(Date.now() + 1, 40).some(r => r.kind === "forum_topic_deleted"));

  owner.frames = owner.frames.filter(f => f.type !== "error");
  owner.send({ type: "forumSetStatus", topicId: first.topic.id, status: "bogus" as never, requestId: "bad-status" });
  assert.match(
    (await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error")).error,
    /invalid|deleted/i,
  );
});

test("removed member cannot re-read via requestId replay (B3)", async t => {
  const { relay, owner, project, open } = await stand(t, "forums-replay.db");
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${invite.code}:Priya`);
  await friend.wait(f => f.type === "welcome");
  const friendId = relay.store.users().find(u => u.name === "Priya")!.id;
  owner.send({ type: "forumAddMember", projectId: project.id, userId: friendId });
  await friend.wait(f => f.type === "forumProjects" && f.projects.length === 1);

  friend.send({
    type: "forumTopic", projectId: project.id, title: "Secret decision",
    body: "Do not leak after removal", requestId: "friend-topic-1",
  });
  const created = await friend.wait<Extract<ServerFrame, { type: "forumTopic" }>>(
    f => f.type === "forumTopic" && f.requestId === "friend-topic-1",
  );
  friend.send({
    type: "forumEditTopic", topicId: created.topic.id, title: "Secret decision",
    body: "edited once", requestId: "friend-edit-1",
  });
  await friend.wait(f => f.type === "forumChanged" && f.requestId === "friend-edit-1");

  owner.send({ type: "forumRemoveMember", projectId: project.id, userId: friendId, requestId: "kick" });
  await friend.wait(f => f.type === "forumUnavailable" && f.projectId === project.id);
  assert.ok(relay.store.activity(Date.now() + 1, 20).some(r => r.kind === "forum_member_removed"));
  assert.equal(relay.store.forumIsMember(project.id, friendId), false);

  // Drop prior successful snapshots so we only inspect frames from the replay.
  friend.frames = [];
  const framesBefore = friend.frames.length;
  // Replay a prior mutation requestId — must fail closed (no topic body, only error).
  friend.send({
    type: "forumEditTopic", topicId: created.topic.id, title: "Secret decision",
    body: "edited once", requestId: "friend-edit-1",
  });
  const err = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /no such forum (project|topic)/);
  const after = friend.frames.slice(framesBefore);
  assert.equal(
    after.some(f => f.type === "forumChanged" || f.type === "forumTopic" || f.type === "forumFeed"),
    false,
    "replay must not re-ship decision content after removal",
  );

  friend.frames = friend.frames.filter(f => f.type !== "error");
  friend.send({ type: "forumList", projectId: project.id });
  assert.match(
    (await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error")).error,
    /no such forum project/,
  );
  friend.frames = friend.frames.filter(f => f.type !== "error");
  friend.send({ type: "forumOpen", topicId: created.topic.id });
  assert.match(
    (await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error")).error,
    /no such forum topic/,
  );
});

test("list-members receipt is not owner-only; manage uses distinct kinds (B5)", async t => {
  const { relay, owner, project, open } = await stand(t, "forums-list-members.db");
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${invite.code}:Priya`);
  await friend.wait(f => f.type === "welcome");
  const friendId = relay.store.users().find(u => u.name === "Priya")!.id;
  owner.send({ type: "forumAddMember", projectId: project.id, userId: friendId });
  await friend.wait(f => f.type === "forumProjects" && f.projects.length === 1);

  friend.send({ type: "forumMembers", projectId: project.id, requestId: "list-1" });
  const listed = await friend.wait<Extract<ServerFrame, { type: "forumMembers" }>>(
    f => f.type === "forumMembers" && f.requestId === "list-1",
  );
  assert.ok(listed.userIds.includes(friendId));
  friend.send({ type: "forumMembers", projectId: project.id, requestId: "list-1" });
  const again = await friend.wait<Extract<ServerFrame, { type: "forumMembers" }>>(
    f => f.type === "forumMembers" && f.requestId === "list-1",
  );
  assert.deepEqual(again.userIds, listed.userIds);

  friend.frames = friend.frames.filter(f => f.type !== "error");
  friend.send({ type: "forumAddMember", projectId: project.id, userId: friendId, requestId: "bad-add" });
  // Non-owners hit the project gate (privacy-preserving "no such project") or the
  // explicit owner-only manage message — either way they cannot manage members.
  assert.match(
    (await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error")).error,
    /only the project owner|no such project/,
  );
});

test("link binding refuses task/run/artifact when project has no room (B7)", async t => {
  const { relay, owner, project } = await stand(t, "forums-no-room.db");
  assert.equal(project.channelId, undefined);
  owner.send({ type: "createChannel", name: "somewhere", memberIds: [] });
  const channel = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "somewhere",
  );
  const task: Task = {
    id: "orphan-task", title: "Elsewhere", requesterId: relay.ownerId, requesterName: "Vikas",
    agentId: "agent", channelId: channel.channel.id, status: "completed",
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  relay.store.saveTask(task);
  owner.send({
    type: "forumTopic", projectId: project.id, title: "No room links",
    body: "should refuse", links: [{ kind: "task", id: "orphan-task" }], requestId: "no-room",
  });
  assert.match(
    (await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error")).error,
    /no room/,
  );
});

test("schema backfill runs on a DB already at master Pulse v9 (B1)", async () => {
  const dbPath = tmp("v9-pulse.db");
  const first = new Store(dbPath);
  assert.equal(first.schemaVersion(), SCHEMA_VERSION);
  const owner = first.ensureOwner("Vikas", "tok");
  const project: Project = {
    id: "p-backfill", ownerId: owner.id, repo: "acme/app", name: "App", createdAt: Date.now(),
  };
  first.saveProject(project);
  assert.ok(first.forumIsMember(project.id, owner.id));
  first.db.prepare("DELETE FROM forum_members WHERE projectId=?").run(project.id);
  assert.equal(first.forumIsMember(project.id, owner.id), false);
  // Simulate a hub that already finished Pulse (v9) before forums existed.
  // Schema version lives in meta, not PRAGMA user_version.
  first.db.prepare("INSERT INTO meta(key,value) VALUES('schemaVersion','9') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  assert.equal(first.schemaVersion(), 9);
  first.db.close();

  const second = new Store(dbPath);
  assert.equal(second.schemaVersion(), SCHEMA_VERSION, "step 10 must advance past Pulse v9");
  assert.ok(second.forumIsMember(project.id, project.ownerId), "v10 backfill restores owner membership");
  second.db.close();
});

test("agent forum paths refuse non-engine clients", async t => {
  const { owner, project } = await stand(t, "forums-agent.db");
  owner.send({
    type: "agentForumTopic", agentId: "nope", projectId: project.id,
    title: "Agent only", body: "should fail from desktop",
  });
  assert.match(
    (await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error")).error,
    /agent host|no such agent|only an agent/i,
  );
});
