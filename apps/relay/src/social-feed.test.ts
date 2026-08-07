import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { ServerFrame, Task } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

async function stand(t: TestContext, name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const clients: TestClient[] = [];
  t.after(() => { for (const c of clients) c.close(); relay.close(); });
  const open = (token: string): TestClient => {
    const c = new TestClient(url, token);
    clients.push(c);
    return c;
  };
  const owner = open("tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { relay, owner, welcome, open };
}

async function makeProject(owner: TestClient): Promise<string> {
  owner.send({ type: "connectProject", repo: "vikas53953/cloud9" });
  const frame = await owner.wait<Extract<ServerFrame, { type: "project" }>>(f => f.type === "project");
  return frame.project.id;
}

test("project social feed persists posts/comments, reactions, edits, tombstones, and read state", async t => {
  const { relay, owner, welcome } = await stand(t, "social-roundtrip.db");
  const projectId = await makeProject(owner);
  const channelId = welcome.state.channels[0]?.id;
  assert.ok(channelId);
  const task: Task = {
    id: "task-social-1", title: "Review the social feed", requesterId: relay.ownerId,
    requesterName: "Vikas", agentId: "agent-social-1", channelId, status: "completed",
    createdAt: Date.now(), updatedAt: Date.now(),
  };
  relay.store.saveTask(task);

  owner.send({ type: "socialList", projectId, requestId: "social-list-1" });
  const first = await owner.wait<Extract<ServerFrame, { type: "socialFeed" }>>(f => f.type === "socialFeed");
  assert.equal(first.posts.length, 0);
  assert.equal(first.unread, 0);

  owner.send({ type: "socialCreate", projectId, text: "Ship the first internal update", links: [{ kind: "task", id: task.id }] });
  const post = await owner.wait<Extract<ServerFrame, { type: "socialPost" }>>(f => f.type === "socialPost");
  assert.equal(post.post.projectId, projectId);
  assert.equal(post.post.links?.[0]?.kind, "task");

  owner.send({ type: "socialCreate", projectId, parentId: post.post.id, text: "I checked the task" });
  const comment = await owner.wait<Extract<ServerFrame, { type: "socialPost" }>>(
    f => f.type === "socialPost" && f.post.parentId === post.post.id);
  assert.equal(comment.post.parentId, post.post.id);

  owner.send({ type: "socialReact", postId: post.post.id, emoji: "👍" });
  const reaction = await owner.wait<Extract<ServerFrame, { type: "socialReaction" }>>(
    f => f.type === "socialReaction" && f.postId === post.post.id);
  assert.deepEqual(reaction.actorIds, [relay.ownerId]);

  owner.send({ type: "socialEdit", postId: post.post.id, text: "Ship the edited update" });
  const edited = await owner.wait<Extract<ServerFrame, { type: "socialUpdated" }>>(
    f => f.type === "socialUpdated" && f.post.id === post.post.id && !!f.post.editedAt);
  assert.equal(edited.post.text, "Ship the edited update");

  owner.send({ type: "socialDelete", postId: post.post.id });
  const deleted = await owner.wait<Extract<ServerFrame, { type: "socialUpdated" }>>(
    f => f.type === "socialUpdated" && f.post.id === post.post.id && !!f.post.deletedAt);
  assert.equal(deleted.post.text, "", "deleted content becomes a tombstone");
  assert.equal(relay.store.socialPost(post.post.id)?.deletedAt !== undefined, true);

  owner.send({ type: "socialMarkRead", projectId, at: Date.now() });
  const read = await owner.wait<Extract<ServerFrame, { type: "socialRead" }>>(f => f.type === "socialRead");
  assert.equal(read.entry.unread, 0);

  owner.send({ type: "socialList", projectId });
  const persisted = await owner.wait<Extract<ServerFrame, { type: "socialFeed" }>>(
    f => f.type === "socialFeed" && f.posts.some(p => p.id === post.post.id));
  assert.equal(persisted.posts.find(p => p.id === post.post.id)?.deletedAt !== undefined, true);
  assert.equal(persisted.posts.some(p => p.parentId === post.post.id), true);
});

test("social feed is project-membership isolated and removed members lose access", async t => {
  const { relay, owner, open } = await stand(t, "social-membership.db");
  const projectId = await makeProject(owner);
  const project = relay.store.project(projectId)!;
  project.localPath = "C:\\private\\worktree";
  relay.store.saveProject(project);

  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${invite.code}:Priya`);
  const friendWelcome = await friend.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const friendId = friendWelcome.state.me.id;
  friend.send({ type: "socialList", projectId });
  const denied = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /no such project/);

  owner.send({ type: "socialAddMember", projectId, userId: friendId });
  await friend.wait<Extract<ServerFrame, { type: "socialMembers" }>>(f => f.type === "socialMembers");
  friend.send({ type: "socialProjects" });
  const visibleProjects = await friend.wait<Extract<ServerFrame, { type: "socialProjects" }>>(
    f => f.type === "socialProjects");
  assert.deepEqual(visibleProjects.projects.map(project => project.id), [projectId]);
  assert.equal(visibleProjects.projects[0]?.localPath, undefined, "membership never exposes the owner's disk path");
  friend.send({ type: "socialList", projectId });
  const allowed = await friend.wait<Extract<ServerFrame, { type: "socialFeed" }>>(f => f.type === "socialFeed");
  assert.equal(allowed.projectId, projectId);

  owner.send({ type: "socialRemoveMember", projectId, userId: friendId });
  await friend.wait<Extract<ServerFrame, { type: "socialUnavailable" }>>(f => f.type === "socialUnavailable");
  friend.send({ type: "socialList", projectId });
  const removed = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(removed.error, /no such project/);
});
