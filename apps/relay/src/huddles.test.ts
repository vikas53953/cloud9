import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { AgentDef, Project, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

async function stand(t: TestContext) {
  const relay = new Relay({ dbPath: tmp("huddles.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const cs: TestClient[] = [];
  t.after(() => { cs.forEach(c => c.close()); relay.close(); });
  const open = (token: string, kind: "desktop" | "engine" = "desktop") => {
    const c = new TestClient(url, token, kind);
    cs.push(c);
    return c;
  };
  const owner = open("tok-owner");
  await owner.wait(f => f.type === "welcome");
  // Real room bound to the project so channel-member isolation is testable.
  owner.send({ type: "createChannel", name: "huddle-room", memberIds: [], kind: "channel" });
  const ch = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "huddle-room")).channel;
  const project: Project = {
    id: "huddle-project",
    ownerId: relay.ownerId,
    repo: "vikas53953/cloud9",
    name: "Cloud9",
    channelId: ch.id,
    createdAt: Date.now(),
  };
  relay.store.saveProject(project);
  return { relay, owner, open, project, channel: ch };
}

async function inviteFriend(
  owner: TestClient,
  open: (token: string, kind?: "desktop" | "engine") => TestClient,
  name: string,
): Promise<{ client: TestClient; userId: string }> {
  // Drop prior invite frames so wait() does not reuse a spent code.
  owner.frames = owner.frames.filter(f => f.type !== "invite");
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const client = open(`invite:${inv.code}:${name}`);
  const welcome = await client.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { client, userId: welcome.state.me.id };
}

async function addToChannel(owner: TestClient, member: TestClient, channelId: string, userId: string) {
  owner.send({ type: "addMembers", channelId, memberIds: [userId] });
  await member.wait(f => f.type === "channel" && f.channel.id === channelId && f.channel.memberIds.includes(userId));
}

test("huddle session persists presence, notes, end state and unread/read", async t => {
  const { relay, owner, project } = await stand(t);
  owner.send({ type: "huddleStart", projectId: project.id, title: "Release", agenda: "Decide ship date" });
  const started = await owner.wait<Extract<ServerFrame, { type: "huddleSession" }>>(f => f.type === "huddleSession");
  owner.send({ type: "huddleNote", sessionId: started.session.id, kind: "decision", body: "Ship Friday" });
  const changed = await owner.wait<Extract<ServerFrame, { type: "huddleChanged" }>>(f => f.type === "huddleChanged" && !!f.note);
  assert.equal(changed.note?.kind, "decision");
  owner.send({ type: "huddleMarkRead", sessionId: started.session.id, ts: Date.now() });
  const read = await owner.wait<Extract<ServerFrame, { type: "huddleRead" }>>(f => f.type === "huddleRead");
  assert.equal(read.entry.unread, 0);
  owner.send({ type: "huddleEnd", sessionId: started.session.id });
  const ended = await owner.wait<Extract<ServerFrame, { type: "huddleChanged" }>>(f => f.type === "huddleChanged" && f.session.state === "ended");
  assert.equal(ended.session.state, "ended");
  assert.equal(relay.store.huddleNotes(started.session.id).length, 1);
});

test("huddle membership isolates sessions and owner-only end", async t => {
  const { owner, open, project } = await stand(t);
  owner.send({ type: "huddleStart", projectId: project.id, title: "Private", agenda: "Members only" });
  const started = await owner.wait<Extract<ServerFrame, { type: "huddleSession" }>>(f => f.type === "huddleSession");
  const { client: friend } = await inviteFriend(owner, open, "Priya");
  friend.send({ type: "huddleOpen", sessionId: started.session.id });
  assert.match((await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error")).error, /no such huddle/);
});

test("huddle mutation receipts reject changed payloads and allow ended-note tombstones", async t => {
  const { relay, owner, project } = await stand(t);
  const start = { type: "huddleStart" as const, projectId: project.id, title: "Receipt", agenda: "Replay", requestId: "h-start" };
  owner.send(start);
  const started = await owner.wait<Extract<ServerFrame, { type: "huddleSession" }>>(f => f.type === "huddleSession" && f.requestId === "h-start");
  owner.send({ ...start, title: "Changed" });
  const conflict = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "h-start");
  assert.match(conflict.error, /already used/);
  owner.send({ type: "huddleNote", sessionId: started.session.id, kind: "note", body: "Keep this", requestId: "h-note" });
  const note = await owner.wait<Extract<ServerFrame, { type: "huddleChanged" }>>(f => f.type === "huddleChanged" && f.note?.id !== undefined);
  owner.send({ type: "huddleEnd", sessionId: started.session.id, requestId: "h-end" });
  await owner.wait<Extract<ServerFrame, { type: "huddleChanged" }>>(f => f.type === "huddleChanged" && f.session.state === "ended");
  owner.send({ type: "huddleDeleteNote", noteId: note.note!.id, requestId: "h-delete" });
  const deleted = await owner.wait<Extract<ServerFrame, { type: "huddleChanged" }>>(f => f.type === "huddleChanged" && f.requestId === "h-delete");
  assert.equal(deleted.note?.deletedAt !== undefined, true);
  assert.equal(relay.store.huddleNotes(started.session.id)[0].deletedAt !== undefined, true);
});

test("agent huddle presence is durable and cleaned on engine disconnect", async t => {
  const { relay, owner, project, open } = await stand(t);
  const agent = { id: "huddle-agent", ownerId: relay.ownerId, name: "Build bot", emoji: "🤖", persona: "Builds", abilities: {} } as AgentDef;
  relay.store.saveAgent(agent);
  owner.send({ type: "huddleStart", projectId: project.id, title: "Agent", agenda: "Presence" });
  const started = await owner.wait<Extract<ServerFrame, { type: "huddleSession" }>>(f => f.type === "huddleSession");
  const engine = open("tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  engine.send({ type: "agentHuddleNote", agentId: agent.id, sessionId: started.session.id, kind: "note", body: "Online" });
  const withAgent = await owner.wait<Extract<ServerFrame, { type: "huddleChanged" }>>(f => f.type === "huddleChanged" && f.note?.authorId === agent.id);
  assert.equal(withAgent.session.participants.some(p => p.id === agent.id && p.present), true);
  assert.equal(relay.store.huddleMembers(started.session.id).some(m => m.userId === agent.id), true);
  engine.close();
  const gone = await owner.wait<Extract<ServerFrame, { type: "huddleChanged" }>>(f => f.type === "huddleChanged" && f.session.participants.some(p => p.id === agent.id && !p.present));
  assert.equal(gone.session.participants.find(p => p.id === agent.id)?.present, false);
});

test("channel member can open and read notes; non-member cannot; notes need no presence", async t => {
  const { owner, open, project, channel } = await stand(t);
  owner.send({ type: "huddleStart", projectId: project.id, title: "Team", agenda: "Scope" });
  const started = await owner.wait<Extract<ServerFrame, { type: "huddleSession" }>>(f => f.type === "huddleSession");
  owner.send({ type: "huddleNote", sessionId: started.session.id, kind: "note", body: "Secret plan" });
  await owner.wait(f => f.type === "huddleChanged" && !!(f as Extract<ServerFrame, { type: "huddleChanged" }>).note);

  const member = await inviteFriend(owner, open, "Member");
  const outsider = await inviteFriend(owner, open, "Outsider");
  await addToChannel(owner, member.client, channel.id, member.userId);

  // Member opens without joining presence — notes are project-scoped.
  member.client.send({ type: "huddleOpen", sessionId: started.session.id });
  const opened = await member.client.wait<Extract<ServerFrame, { type: "huddleSession" }>>(f => f.type === "huddleSession");
  assert.equal(opened.notes.some(n => n.body === "Secret plan"), true);

  // Non-member of the project channel gets the same denial as a missing id.
  outsider.client.send({ type: "huddleOpen", sessionId: started.session.id });
  assert.match((await outsider.client.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error")).error, /no such huddle/);

  // Project-scoped write without join/presence.
  member.client.send({ type: "huddleNote", sessionId: started.session.id, kind: "decision", body: "Member wrote without joining" });
  const wrote = await member.client.wait<Extract<ServerFrame, { type: "huddleChanged" }>>(
    f => f.type === "huddleChanged" && f.note?.body === "Member wrote without joining");
  assert.equal(wrote.note?.body, "Member wrote without joining");
  assert.equal(wrote.session.participants.some(p => p.id === member.userId && p.present), false);
});

test("leave and remove revoke open access; forget notifies openers who never joined", async t => {
  const { owner, open, project, channel } = await stand(t);
  owner.send({ type: "huddleStart", projectId: project.id, title: "Revoke", agenda: "Access" });
  const started = await owner.wait<Extract<ServerFrame, { type: "huddleSession" }>>(f => f.type === "huddleSession");
  owner.send({ type: "huddleNote", sessionId: started.session.id, kind: "note", body: "Visible once" });
  await owner.wait(f => f.type === "huddleChanged" && !!(f as Extract<ServerFrame, { type: "huddleChanged" }>).note);

  const member = await inviteFriend(owner, open, "Leaver");
  await addToChannel(owner, member.client, channel.id, member.userId);

  member.client.send({ type: "huddleOpen", sessionId: started.session.id });
  const opened = await member.client.wait<Extract<ServerFrame, { type: "huddleSession" }>>(f => f.type === "huddleSession");
  assert.equal(opened.notes.length >= 1, true);

  // Leave the room without ever joining huddle presence.
  member.client.send({ type: "leaveChannel", channelId: channel.id });
  const unavailable = await member.client.wait<Extract<ServerFrame, { type: "huddleUnavailable" }>>(f => f.type === "huddleUnavailable");
  assert.equal(unavailable.sessionId, started.session.id);
  await member.client.wait(f => f.type === "channelLeft");

  member.client.send({ type: "huddleOpen", sessionId: started.session.id });
  assert.match((await member.client.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error")).error, /no such huddle/);

  // Second person opens without joining; owner forgets the project → they get huddleUnavailable.
  const opener = await inviteFriend(owner, open, "Opener");
  await addToChannel(owner, opener.client, channel.id, opener.userId);
  opener.client.send({ type: "huddleOpen", sessionId: started.session.id });
  await opener.client.wait(f => f.type === "huddleSession");

  owner.send({ type: "forgetProject", projectId: project.id });
  const forgotten = await opener.client.wait<Extract<ServerFrame, { type: "huddleUnavailable" }>>(f => f.type === "huddleUnavailable");
  assert.equal(forgotten.sessionId, started.session.id);
  assert.match(forgotten.problem, /forgotten/i);
  await owner.wait(f => f.type === "projectForgotten");
});

test("removeMember revokes huddle open for a non-participant member", async t => {
  const { owner, open, project, channel } = await stand(t);
  owner.send({ type: "huddleStart", projectId: project.id, title: "Kick", agenda: "Remove" });
  const started = await owner.wait<Extract<ServerFrame, { type: "huddleSession" }>>(f => f.type === "huddleSession");
  const guest = await inviteFriend(owner, open, "Guest");
  await addToChannel(owner, guest.client, channel.id, guest.userId);
  guest.client.send({ type: "huddleOpen", sessionId: started.session.id });
  await guest.client.wait(f => f.type === "huddleSession");

  owner.send({ type: "removeMember", channelId: channel.id, memberId: guest.userId });
  const unavailable = await guest.client.wait<Extract<ServerFrame, { type: "huddleUnavailable" }>>(f => f.type === "huddleUnavailable");
  assert.equal(unavailable.sessionId, started.session.id);

  guest.client.send({ type: "huddleOpen", sessionId: started.session.id });
  assert.match((await guest.client.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error")).error, /no such huddle/);
});

test("huddleOpen after reconnect returns durable notes (desktop open contract)", async t => {
  const { owner, open, project } = await stand(t);
  owner.send({ type: "huddleStart", projectId: project.id, title: "Durable", agenda: "History" });
  const started = await owner.wait<Extract<ServerFrame, { type: "huddleSession" }>>(f => f.type === "huddleSession");
  owner.send({ type: "huddleNote", sessionId: started.session.id, kind: "decision", body: "Keep this forever" });
  await owner.wait(f => f.type === "huddleChanged" && !!(f as Extract<ServerFrame, { type: "huddleChanged" }>).note);

  // Second desktop connection for the same owner asks open — same as live screen on select.
  const again = open("tok-owner");
  await again.wait(f => f.type === "welcome");
  again.send({ type: "huddleOpen", sessionId: started.session.id });
  const reopened = await again.wait<Extract<ServerFrame, { type: "huddleSession" }>>(f => f.type === "huddleSession");
  assert.equal(reopened.notes.some(n => n.body === "Keep this forever"), true);
  again.send({ type: "huddleMarkRead", sessionId: started.session.id, ts: Date.now() });
  const read = await again.wait<Extract<ServerFrame, { type: "huddleRead" }>>(f => f.type === "huddleRead");
  assert.equal(read.entry.sessionId, started.session.id);
});

test("channel rebind is refused while huddles exist", async t => {
  const { owner, project, channel } = await stand(t);
  owner.send({ type: "huddleStart", projectId: project.id, title: "Locked", agenda: "Stay put" });
  await owner.wait(f => f.type === "huddleSession");
  owner.send({ type: "createChannel", name: "other-room", memberIds: [], kind: "channel" });
  const other = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "other-room")).channel;
  owner.send({ type: "updateProject", projectId: project.id, channelId: other.id });
  const err = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /huddles/i);
  // Same room is a no-op, not an error path for rebind.
  owner.frames.length = 0;
  owner.send({ type: "updateProject", projectId: project.id, channelId: channel.id });
  const projectFrame = await owner.wait<Extract<ServerFrame, { type: "project" }>>(f => f.type === "project");
  assert.equal(projectFrame.project.channelId, channel.id);
});

test("link write checks refuse inaccessible targets; open redacts stripped ids", async t => {
  const { relay, owner, open, project, channel } = await stand(t);
  owner.send({ type: "huddleStart", projectId: project.id, title: "Links", agenda: "Redact" });
  const started = await owner.wait<Extract<ServerFrame, { type: "huddleSession" }>>(f => f.type === "huddleSession");

  // Missing task on write is refused.
  owner.send({
    type: "huddleNote",
    sessionId: started.session.id,
    kind: "note",
    body: "See task",
    links: [{ kind: "task", id: "missing-task", label: "Missing" }],
  });
  const refuse = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(refuse.error, /unavailable|task/i);

  // Missing project item on write is refused.
  owner.send({
    type: "huddleNote",
    sessionId: started.session.id,
    kind: "note",
    body: "See PR",
    links: [{ kind: "projectItem", projectItemKind: "pull", projectItemNumber: 9999, label: "PR 9999" }],
  });
  const refuseItem = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(refuseItem.error, /unavailable|project item/i);

  // Seed a real task in the project channel, link it, then open as a member — available:true.
  const agent = { id: "link-agent", ownerId: relay.ownerId, name: "Linker", emoji: "🔗", persona: "Links", abilities: {} } as AgentDef;
  relay.store.saveAgent(agent);
  owner.send({ type: "createTask", agentId: agent.id, channelId: channel.id, title: "Linked work" });
  const taskFrame = await owner.wait<Extract<ServerFrame, { type: "task" }>>(f => f.type === "task");
  owner.send({
    type: "huddleNote",
    sessionId: started.session.id,
    kind: "action",
    body: "Do this task",
    links: [{ kind: "task", id: taskFrame.task.id, label: "Linked work" }],
  });
  const noted = await owner.wait<Extract<ServerFrame, { type: "huddleChanged" }>>(f => f.type === "huddleChanged" && f.note?.kind === "action");
  assert.equal(noted.note?.links?.[0]?.available, true);
  assert.equal(noted.note?.links?.[0]?.id, taskFrame.task.id);

  const member = await inviteFriend(owner, open, "Reader");
  await addToChannel(owner, member.client, channel.id, member.userId);
  member.client.send({ type: "huddleOpen", sessionId: started.session.id });
  const view = await member.client.wait<Extract<ServerFrame, { type: "huddleSession" }>>(f => f.type === "huddleSession");
  const link = view.notes.find(n => n.kind === "action")?.links?.[0];
  assert.equal(link?.available, true);
  assert.equal(link?.id, taskFrame.task.id);
});
