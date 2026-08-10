import test from "node:test";
import assert from "node:assert/strict";
import { ClientFrame, ProjectItem, RunRecord, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const AGENT = {
  emoji: "🔭", persona: "Researches", abilities: { webSearch: true, files: false, schedules: false, background: false },
};

test("rich-link previews return authorized facts and omit private targets", async t => {
  const relay = new Relay({ dbPath: tmp("rich-link-previews.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  let engine!: TestClient;
  let guest!: TestClient;
  t.after(() => { owner.close(); engine?.close(); guest?.close(); relay.close(); });
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  owner.send({ type: "createAgent", agent: { ...AGENT, name: "Scout" } });
  const agentFrame = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent");
  const general = relay.store.channels()[0];
  owner.send({ type: "createChannel", name: "private work", memberIds: [agentFrame.agent.id], kind: "channel" });
  const privateFrame = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "private work",
  );
  engine.send({ type: "createTask", agentId: agentFrame.agent.id, channelId: privateFrame.channel.id,
    title: "Private task", requesterId: welcome.state.me.id });
  const task = await owner.wait<Extract<ServerFrame, { type: "task" }>>(f => f.type === "task" && f.task.title === "Private task");
  const record: RunRecord = {
    id: "r-000000001-rich", kind: "task", agentId: agentFrame.agent.id, agentName: agentFrame.agent.name,
    provider: "claude", channelId: privateFrame.channel.id, taskId: task.task.id,
    requestedBy: "Vikas", requestedByKind: "human", ask: "Private task", startedAt: 1, finishedAt: 2,
    durationMs: 1, outcome: "ok", steps: [], replyChars: 1, events: 0,
  };
  engine.send({ type: "runRecorded", record });
  await owner.wait(f => f.type === "run" && f.record.id === record.id);

  owner.send({ type: "connectProject", repo: "example/cloud9" });
  const projectFrame = await owner.wait<Extract<ServerFrame, { type: "project" }>>(
    f => f.type === "project" && f.project.repo === "example/cloud9",
  );
  await engine.wait(f => f.type === "lookAtProject" && f.projectId === projectFrame.project.id);
  const item: ProjectItem = {
    projectId: projectFrame.project.id, kind: "pull", number: 42, title: "A visible pull request",
    state: "open", author: "Vikas", url: "https://github.com/example/cloud9/pull/42",
    createdAt: 1, updatedAt: 2,
  };
  engine.send({ type: "projectSynced", projectId: projectFrame.project.id, items: [item] });
  await owner.wait(f => f.type === "projectItems" && f.items.some(i => i.number === 42));

  owner.send({ type: "send", channelId: general.id, text: "Here are the links" });
  const message = await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.authorId === welcome.state.me.id,
  );
  owner.send({ type: "richLinkPreviews", messageId: message.message.id, requestId: "preview-initial", refs: [
    { kind: "task", id: task.task.id }, { kind: "run", id: record.id },
    { kind: "url", url: item.url },
    { kind: "task", id: "tsk-does-not-exist" },
  ] });
  const projected = await owner.wait<Extract<ServerFrame, { type: "richLinkPreviews" }>>(
    f => f.type === "richLinkPreviews" && f.requestId === "preview-initial",
  );
  assert.deepEqual(projected.previews.map(p => [p.ref.kind, p.title, p.status]), [
    ["task", "Private task", "not_started"],
    ["run", "Private task", "ok"],
    ["projectItem", "A visible pull request", "open"],
  ]);

  // Correlation is bounded at the relay boundary.  A forged runtime frame
  // must be refused before it can echo an object or a 5000-character payload
  // into a response frame.
  for (const requestId of [{ forged: true }, "x".repeat(5000)]) {
    owner.send({ type: "richLinkPreviews", messageId: message.message.id, requestId,
      refs: [{ kind: "task", id: task.task.id }] } as unknown as ClientFrame);
    const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
      f => f.type === "error" && f.error === "invalid request id",
    );
    assert.equal(refused.requestId, undefined);
  }

  const invite = await new Promise<string>(resolve => {
    owner.send({ type: "createInvite" });
    void owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite").then(f => resolve(f.code));
  });
  guest = new TestClient(url, `invite:${invite}:Guest`);
  await guest.wait(f => f.type === "welcome");
  guest.send({ type: "richLinkPreviews", messageId: message.message.id, requestId: "preview-guest", refs: [
    { kind: "task", id: task.task.id }, { kind: "run", id: record.id },
    { kind: "url", url: item.url },
  ] });
  const denied = await guest.wait<Extract<ServerFrame, { type: "richLinkPreviews" }>>(
    f => f.type === "richLinkPreviews" && f.requestId === "preview-guest",
  );
  assert.deepEqual(denied.previews, []);

  // Revocation is not a stale-card timer concern: a project/item loss must
  // make a fresh correlated projection omit that URL immediately.
  owner.send({ type: "forgetProject", projectId: projectFrame.project.id });
  await owner.wait(f => f.type === "projectForgotten" && f.projectId === projectFrame.project.id);
  owner.send({ type: "richLinkPreviews", messageId: message.message.id, requestId: "preview-forgotten", refs: [{ kind: "url", url: item.url }] });
  const forgotten = await owner.wait<Extract<ServerFrame, { type: "richLinkPreviews" }>>(
    f => f.type === "richLinkPreviews" && f.requestId === "preview-forgotten",
  );
  assert.deepEqual(forgotten.previews, [], "forgotten project URLs cannot resurrect a card");

  // Agent deletion removes task/run access as well as the agent row. A later
  // preview request must not retain either durable target.
  owner.send({ type: "deleteAgent", agentId: agentFrame.agent.id });
  await owner.wait(f => f.type === "agentDeleted" && f.agentId === agentFrame.agent.id);
  owner.send({ type: "richLinkPreviews", messageId: message.message.id, requestId: "preview-agent-gone", refs: [
    { kind: "task", id: task.task.id }, { kind: "run", id: record.id },
  ] });
  const agentGone = await owner.wait<Extract<ServerFrame, { type: "richLinkPreviews" }>>(
    f => f.type === "richLinkPreviews" && f.requestId === "preview-agent-gone",
  );
  assert.deepEqual(agentGone.previews.map(p => p.ref.kind), ["task"],
    "requester-owned tasks remain readable while deleted-agent runs disappear");
});
