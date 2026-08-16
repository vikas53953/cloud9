// PROJECT POLLS — durable, member-only decisions.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

async function setup(t: TestContext) {
  const relay = new Relay({ dbPath: tmp("polls.db"), ownerToken: "owner", ownerName: "Owner" });
  const port = await relay.listen(0);
  const owner = new TestClient(`ws://127.0.0.1:${port}`, "owner");
  await owner.wait(f => f.type === "welcome");
  const engine = new TestClient(`ws://127.0.0.1:${port}`, "owner", "engine");
  await engine.wait(f => f.type === "welcome");
  t.after(() => { owner.close(); engine.close(); relay.close(); });
  return { owner, engine, url: `ws://127.0.0.1:${port}` };
}

async function project(owner: TestClient, engine: TestClient, channelId?: string) {
  owner.send({ type: "connectProject", repo: "vikas53953/cloud9", name: "Cloud9 polls", ...(channelId ? { channelId } : {}) });
  const made = await owner.wait<Extract<ServerFrame, { type: "project" }>>(f => f.type === "project" && f.project.repo === "vikas53953/cloud9");
  await engine.wait(f => f.type === "lookAtProject" && f.projectId === made.project.id);
  engine.send({ type: "projectSynced", projectId: made.project.id, items: [] });
  return made.project.id;
}

test("polls are durable, one-vote-per-member, changeable, and close into a decision", async t => {
  const { owner, engine } = await setup(t);
  const projectId = await project(owner, engine);
  owner.send({ type: "createPoll", projectId, question: "Ship this week?", options: ["Yes", "No"] });
  const created = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(f => f.type === "poll");
  const [yes, no] = created.poll.options;
  owner.send({ type: "votePoll", pollId: created.poll.id, optionId: yes.id });
  await owner.wait(f => f.type === "poll" && f.poll.id === created.poll.id && f.poll.myOptionId === yes.id);
  owner.send({ type: "votePoll", pollId: created.poll.id, optionId: no.id });
  const changed = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(f => f.type === "poll" && f.poll.id === created.poll.id && f.poll.myOptionId === no.id);
  assert.equal(changed.poll.totalVotes, 1, "changing a vote replaces rather than duplicates it");
  owner.send({ type: "closePoll", pollId: created.poll.id, summary: "No: hold for review" });
  const closed = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(f => f.type === "poll" && f.poll.id === created.poll.id && f.poll.status === "closed");
  assert.equal(closed.poll.decision?.summary, "No: hold for review");
  // A fresh `polls` request exercises the same durable projection path used on
  // reconnect; the store survives process restarts via its SQLite tables.
  owner.send({ type: "polls", projectId });
  const listed = await owner.wait<Extract<ServerFrame, { type: "polls" }>>(f => f.type === "polls" && f.projectId === projectId);
  assert.equal(listed.polls[0].status, "closed");
});

test("agent-authored polls still require the owner's engine and project membership", async t => {
  const { owner, engine } = await setup(t);
  const projectId = await project(owner, engine);
  engine.send({ type: "createAgent", agent: {
    name: "Poll bot", emoji: "🤖", persona: "A decision helper",
    abilities: { webSearch: false, files: false, schedules: false, background: false },
  } as never });
  const agent = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Poll bot");
  engine.send({ type: "createPoll", projectId, question: "Agent choice?", options: ["A", "B"], authorAgentId: agent.agent.id });
  const poll = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(f => f.type === "poll" && f.poll.authorKind === "agent");
  assert.equal(poll.poll.authorId, agent.agent.id);
});

test("a deadline is a durable close and cannot be voted past", async t => {
  const { owner, engine } = await setup(t);
  const projectId = await project(owner, engine);
  owner.send({ type: "createPoll", projectId, question: "Expires?", options: ["Now", "Later"], deadlineAt: Date.now() + 500 });
  const created = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(
    f => f.type === "poll" && f.poll.question === "Expires?", 15_000);
  await new Promise(resolve => setTimeout(resolve, 600));
  owner.send({ type: "polls", projectId });
  const listed = await owner.wait<Extract<ServerFrame, { type: "polls" }>>(
    f => f.type === "polls" && f.projectId === projectId, 15_000);
  const expired = listed.polls.find(p => p.id === created.poll.id)!;
  assert.equal(expired.status, "closed");
  assert.equal(expired.decision?.reason, "deadline");
  owner.send({ type: "votePoll", pollId: created.poll.id, optionId: created.poll.options[0].id });
  const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error", 15_000);
  assert.match(refused.error, /closed/);
});

test("poll reads and votes follow project-channel membership, not a guessed id", async t => {
  const { owner, engine, url } = await setup(t);
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const member = new TestClient(url, `invite:${invite.code}:Member`);
  t.after(() => member.close());
  const memberWelcome = await member.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "createChannel", name: "poll-room", memberIds: [memberWelcome.state.me.id] });
  const channel = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(f => f.type === "channel" && f.channel.name === "poll-room");
  const projectId = await project(owner, engine, channel.channel.id);
  member.send({ type: "polls", projectId });
  const memberList = await member.wait<Extract<ServerFrame, { type: "polls" }>>(f => f.type === "polls" && f.projectId === projectId);
  assert.deepEqual(memberList.polls, []);
  owner.send({ type: "createPoll", projectId, question: "Member-only?", options: ["Yes", "No"] });
  const poll = await member.wait<Extract<ServerFrame, { type: "poll" }>>(f => f.type === "poll" && f.poll.question === "Member-only?");
  member.send({ type: "votePoll", pollId: poll.poll.id, optionId: poll.poll.options[0].id });
  const voted = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(f => f.type === "poll" && f.poll.id === poll.poll.id && f.poll.totalVotes === 1);
  assert.equal(voted.poll.totalVotes, 1);
  owner.send({ type: "createInvite" });
  const second = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite" && f.code !== invite.code);
  const outsider = new TestClient(url, `invite:${second.code}:Outsider`);
  t.after(() => outsider.close());
  await outsider.wait(f => f.type === "welcome");
  outsider.send({ type: "polls", projectId });
  const denied = await outsider.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && /no such (project|channel)/.test(f.error));
  assert.match(denied.error, /no such (project|channel)/);
});

test("poll creation request ids are idempotent and results follow option order", async t => {
  const { owner, engine } = await setup(t);
  const projectId = await project(owner, engine);
  const requestId = "rq_poll_retry_1";
  owner.send({ type: "createPoll", projectId, requestId, question: "Order?", options: ["First", "Second"] });
  const first = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(f => f.type === "poll" && f.poll.question === "Order?");
  owner.send({ type: "createPoll", projectId, requestId, question: "Order?", options: ["First", "Second"] });
  const replay = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(
    f => f.type === "poll" && f.poll.id === first.poll.id && f.requestId === requestId,
  );
  assert.equal(replay.poll.id, first.poll.id, "a retried request reprojects the original poll");
  owner.send({ type: "votePoll", pollId: first.poll.id, optionId: first.poll.options[1].id });
  await owner.wait(f => f.type === "poll" && f.poll.id === first.poll.id && f.poll.totalVotes === 1);
  owner.send({ type: "votePoll", pollId: first.poll.id, optionId: first.poll.options[0].id });
  await owner.wait(f => f.type === "poll" && f.poll.id === first.poll.id && f.poll.totalVotes === 1);
  owner.send({ type: "closePoll", pollId: first.poll.id });
  const closed = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(
    f => f.type === "poll" && f.poll.id === first.poll.id && f.poll.status === "closed",
  );
  // Results follow option order and include zero-vote options so open/closed tallies match.
  assert.deepEqual(
    closed.poll.decision?.results.map(r => r.optionId),
    [first.poll.options[0].id, first.poll.options[1].id],
  );
  assert.deepEqual(closed.poll.decision?.results.map(r => r.votes), [1, 0]);
});

test("removing a project channel redacts cached polls in another member window", async t => {
  const { owner, engine, url } = await setup(t);
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const member = new TestClient(url, `invite:${invite.code}:Member`);
  t.after(() => member.close());
  const memberWelcome = await member.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "createChannel", name: "poll-redaction", memberIds: [memberWelcome.state.me.id] });
  const channel = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(f => f.type === "channel" && f.channel.name === "poll-redaction");
  const projectId = await project(owner, engine, channel.channel.id);
  member.send({ type: "polls", projectId, requestId: "member-polls" });
  await member.wait(f => f.type === "polls" && f.requestId === "member-polls");
  owner.send({ type: "createPoll", projectId, requestId: "redaction-poll", question: "Visible?", options: ["Yes", "No"] });
  await member.wait(f => f.type === "poll" && f.poll.question === "Visible?");
  owner.send({ type: "updateProject", projectId, channelId: "" });
  const revoked = await member.wait<Extract<ServerFrame, { type: "projectAccessRevoked" }>>(
    f => f.type === "projectAccessRevoked" && f.projectId === projectId,
  );
  assert.equal(revoked.projectId, projectId);
  owner.send({ type: "forgetProject", projectId });
  // The owner is the only remaining audience after revocation; its window still
  // receives the ordinary forgotten projection.
  await owner.wait(f => f.type === "projectForgotten" && f.projectId === projectId);
});

test("an engine cannot masquerade as a human poll author", async t => {
  const { owner, engine } = await setup(t);
  const projectId = await project(owner, engine);
  engine.send({ type: "createPoll", projectId, question: "Missing author?", options: ["A", "B"] });
  const refused = await engine.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && /author agent/.test(f.error),
  );
  assert.match(refused.error, /author agent/);
});

test("real removeMember revokes linked project polls immediately", async t => {
  const { owner, engine, url } = await setup(t);
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const member = new TestClient(url, `invite:${invite.code}:Removed`);
  t.after(() => member.close());
  const hello = await member.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "createChannel", name: "remove-poll-room", kind: "channel", memberIds: [hello.state.me.id] });
  const channel = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "remove-poll-room",
  );
  const projectId = await project(owner, engine, channel.channel.id);
  owner.send({ type: "createPoll", projectId, question: "Remove me?", options: ["Yes", "No"] });
  const created = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(
    f => f.type === "poll" && f.poll.question === "Remove me?",
  );
  await member.wait(f => f.type === "poll" && f.poll.id === created.poll.id);
  owner.send({ type: "removeMember", channelId: channel.channel.id, memberId: hello.state.me.id });
  const revoked = await member.wait<Extract<ServerFrame, { type: "projectAccessRevoked" }>>(
    f => f.type === "projectAccessRevoked" && f.projectId === projectId,
  );
  assert.equal(revoked.projectId, projectId);
});

test("real leaveChannel revokes linked project polls immediately", async t => {
  const { owner, engine, url } = await setup(t);
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const member = new TestClient(url, `invite:${invite.code}:Leaver`);
  t.after(() => member.close());
  const hello = await member.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "createChannel", name: "leave-poll-room", kind: "channel", memberIds: [hello.state.me.id] });
  const channel = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "leave-poll-room",
  );
  const projectId = await project(owner, engine, channel.channel.id);
  owner.send({ type: "createPoll", projectId, question: "Leave me?", options: ["Yes", "No"] });
  const created = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(
    f => f.type === "poll" && f.poll.question === "Leave me?",
  );
  await member.wait(f => f.type === "poll" && f.poll.id === created.poll.id);
  member.send({ type: "leaveChannel", channelId: channel.channel.id });
  const revoked = await member.wait<Extract<ServerFrame, { type: "projectAccessRevoked" }>>(
    f => f.type === "projectAccessRevoked" && f.projectId === projectId,
  );
  assert.equal(revoked.projectId, projectId);
});

test("a deadline closes and broadcasts to every connected project window", async t => {
  const { owner, engine, url } = await setup(t);
  const secondWindow = new TestClient(url, "owner");
  await secondWindow.wait(f => f.type === "welcome");
  t.after(() => secondWindow.close());
  const projectId = await project(owner, engine);
  const deadlineAt = Date.now() + 180;
  owner.send({ type: "createPoll", projectId, question: "Broadcast close?", options: ["Now", "Later"], deadlineAt });
  const created = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(
    f => f.type === "poll" && f.poll.question === "Broadcast close?",
  );
  await secondWindow.wait(f => f.type === "poll" && f.poll.id === created.poll.id && f.poll.status === "open");
  const closed = await secondWindow.wait<Extract<ServerFrame, { type: "poll" }>>(
    f => f.type === "poll" && f.poll.id === created.poll.id && f.poll.status === "closed",
    3000,
  );
  assert.equal(closed.poll.decision?.reason, "deadline");
  const ownerClosed = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(
    f => f.type === "poll" && f.poll.id === created.poll.id && f.poll.status === "closed",
  );
  assert.equal(ownerClosed.poll.decision?.reason, "deadline");
});

test("a restarted relay reschedules a persisted poll deadline", async t => {
  const dbPath = tmp("poll-restart.db");
  const first = new Relay({ dbPath, ownerToken: "owner", ownerName: "Owner" });
  const firstPort = await first.listen(0);
  const firstOwner = new TestClient(`ws://127.0.0.1:${firstPort}`, "owner");
  await firstOwner.wait(f => f.type === "welcome");
  const firstEngine = new TestClient(`ws://127.0.0.1:${firstPort}`, "owner", "engine");
  await firstEngine.wait(f => f.type === "welcome");
  const projectId = await project(firstOwner, firstEngine);
  firstOwner.send({
    type: "createPoll", projectId, question: "Survive restart?", options: ["Yes", "No"],
    deadlineAt: Date.now() + 700,
  });
  await firstOwner.wait(f => f.type === "poll" && f.poll.question === "Survive restart?");
  firstOwner.close(); firstEngine.close(); first.close();

  const second = new Relay({ dbPath, ownerToken: "owner", ownerName: "Owner" });
  const secondPort = await second.listen(0);
  const window = new TestClient(`ws://127.0.0.1:${secondPort}`, "owner");
  t.after(() => { window.close(); second.close(); });
  await window.wait(f => f.type === "welcome");
  const closed = await window.wait<Extract<ServerFrame, { type: "poll" }>>(
    f => f.type === "poll" && f.poll.question === "Survive restart?" && f.poll.status === "closed",
    4000,
  );
  assert.equal(closed.poll.decision?.reason, "deadline");
});

test("a far-future deadline is not clamped into an immediate close", async t => {
  const { owner, engine } = await setup(t);
  const projectId = await project(owner, engine);
  owner.send({
    type: "createPoll", projectId, question: "Future?", options: ["Yes", "No"],
    deadlineAt: Date.now() + 25 * 24 * 60 * 60 * 1000,
  });
  const created = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(
    f => f.type === "poll" && f.poll.question === "Future?",
  );
  await new Promise(resolve => setTimeout(resolve, 50));
  owner.send({ type: "polls", projectId, requestId: "future-check" });
  const listed = await owner.wait<Extract<ServerFrame, { type: "polls" }>>(
    f => f.type === "polls" && f.requestId === "future-check",
  );
  assert.equal(listed.polls.find(p => p.id === created.poll.id)?.status, "open");
});

test("non-owner close is refused by the server", async t => {
  const { owner, engine, url } = await setup(t);
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const member = new TestClient(url, `invite:${invite.code}:Closer`);
  t.after(() => member.close());
  const hello = await member.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "createChannel", name: "close-deny", kind: "channel", memberIds: [hello.state.me.id] });
  const channel = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "close-deny",
  );
  const projectId = await project(owner, engine, channel.channel.id);
  owner.send({ type: "createPoll", projectId, question: "Close me?", options: ["Yes", "No"] });
  const created = await member.wait<Extract<ServerFrame, { type: "poll" }>>(
    f => f.type === "poll" && f.poll.question === "Close me?",
  );
  assert.equal(created.poll.canClose, false, "member projection must not claim close");
  member.send({ type: "closePoll", pollId: created.poll.id });
  const refused = await member.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && /no such project/.test(f.error),
  );
  assert.match(refused.error, /no such project/);
});

test("after removeMember, polls and vote are refused", async t => {
  const { owner, engine, url } = await setup(t);
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const member = new TestClient(url, `invite:${invite.code}:PostRemove`);
  t.after(() => member.close());
  const hello = await member.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "createChannel", name: "post-remove", kind: "channel", memberIds: [hello.state.me.id] });
  const channel = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "post-remove",
  );
  const projectId = await project(owner, engine, channel.channel.id);
  owner.send({ type: "createPoll", projectId, question: "Still mine?", options: ["Yes", "No"] });
  const created = await member.wait<Extract<ServerFrame, { type: "poll" }>>(
    f => f.type === "poll" && f.poll.question === "Still mine?",
  );
  owner.send({ type: "removeMember", channelId: channel.channel.id, memberId: hello.state.me.id });
  await member.wait(f => f.type === "projectAccessRevoked" && f.projectId === projectId);
  member.send({ type: "polls", projectId, requestId: "after-remove" });
  const deniedList = await member.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && /no such (project|channel)/.test(f.error),
  );
  assert.match(deniedList.error, /no such (project|channel)/);
  member.send({ type: "votePoll", pollId: created.poll.id, optionId: created.poll.options[0].id });
  const deniedVote = await member.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && /no such (project|channel)/.test(f.error),
  );
  assert.match(deniedVote.error, /no such (project|channel)/);
});

test("non-owner project projection omits localPath and private repo", async t => {
  const { owner, engine, url } = await setup(t);
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const member = new TestClient(url, `invite:${invite.code}:Redacted`);
  t.after(() => member.close());
  const hello = await member.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "createChannel", name: "redact-room", kind: "channel", memberIds: [hello.state.me.id] });
  const channel = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "redact-room",
  );
  const projectId = await project(owner, engine, channel.channel.id);
  // Owner sets a local folder — that fact must never fan to members.
  owner.send({ type: "setProjectFolder", projectId, path: "C:\\Users\\owner\\secret-repo" });
  await owner.wait(f => f.type === "project" && f.project.id === projectId && !!f.project.localPath);
  // Rename fans a project frame to the room audience with member-safe projection.
  owner.send({ type: "updateProject", projectId, name: "Shared label" });
  const pushed = await member.wait<Extract<ServerFrame, { type: "project" }>>(
    f => f.type === "project" && f.project.id === projectId && f.project.name === "Shared label",
  );
  assert.equal(pushed.project.localPath, undefined, "member must never see owner disk path");
  assert.equal(pushed.project.repo, "", "member must not receive the private repo string");
  assert.equal(pushed.project.name, "Shared label");
  assert.equal(pushed.project.id, projectId);
  // List path uses the same redaction class.
  member.send({ type: "projects" });
  const listed = await member.wait<Extract<ServerFrame, { type: "projects" }>>(f => f.type === "projects");
  const row = listed.projects.find(p => p.id === projectId);
  assert.ok(row, "member sees the linked project for the poll picker");
  assert.equal(row!.localPath, undefined);
  assert.equal(row!.repo, "");
  assert.equal(row!.name, "Shared label");
});

test("non-member activity cannot observe project_poll rows", async t => {
  const { owner, engine, url } = await setup(t);
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const member = new TestClient(url, `invite:${invite.code}:MemberAct`);
  t.after(() => member.close());
  const hello = await member.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "createChannel", name: "act-room", kind: "channel", memberIds: [hello.state.me.id] });
  const channel = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "act-room",
  );
  const projectId = await project(owner, engine, channel.channel.id);
  owner.send({ type: "createPoll", projectId, question: "Secret?", options: ["Yes", "No"] });
  const created = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(
    f => f.type === "poll" && f.poll.question === "Secret?",
  );
  owner.send({ type: "votePoll", pollId: created.poll.id, optionId: created.poll.options[0].id });
  await owner.wait(f => f.type === "poll" && f.poll.id === created.poll.id && f.poll.totalVotes === 1);
  // Owner activity can see poll rows; detail must not name the private repo.
  owner.send({ type: "activity", limit: 50 });
  const ownerAct = await owner.wait<Extract<ServerFrame, { type: "activity" }>>(f => f.type === "activity");
  const pollRows = ownerAct.records.filter(r => String(r.kind).startsWith("project_poll_"));
  assert.ok(pollRows.length >= 1, "owner sees poll activity");
  for (const row of pollRows) {
    assert.equal(/vikas53953\/cloud9/i.test(row.detail), false, "detail must not leak repo path");
  }
  // Outsider on the same hub must not see those rows at all.
  owner.send({ type: "createInvite" });
  const second = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(
    f => f.type === "invite" && f.code !== invite.code,
  );
  const outsider = new TestClient(url, `invite:${second.code}:OutsiderAct`);
  t.after(() => outsider.close());
  await outsider.wait(f => f.type === "welcome");
  outsider.send({ type: "activity", limit: 50 });
  const outsiderAct = await outsider.wait<Extract<ServerFrame, { type: "activity" }>>(f => f.type === "activity");
  const leaked = outsiderAct.records.filter(r => String(r.kind).startsWith("project_poll_"));
  assert.equal(leaked.length, 0, "hub guest must not observe project_poll activity");
});

test("open polls report live option tallies, not zeros", async t => {
  const { owner, engine } = await setup(t);
  const projectId = await project(owner, engine);
  owner.send({ type: "createPoll", projectId, question: "Counts?", options: ["A", "B"] });
  const created = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(
    f => f.type === "poll" && f.poll.question === "Counts?",
  );
  owner.send({ type: "votePoll", pollId: created.poll.id, optionId: created.poll.options[0].id });
  const voted = await owner.wait<Extract<ServerFrame, { type: "poll" }>>(
    f => f.type === "poll" && f.poll.id === created.poll.id && f.poll.totalVotes === 1,
  );
  assert.equal(voted.poll.status, "open");
  assert.equal(voted.poll.results.find(r => r.optionId === created.poll.options[0].id)?.votes, 1);
  assert.equal(voted.poll.results.find(r => r.optionId === created.poll.options[1].id)?.votes, 0);
});
