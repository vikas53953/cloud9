import test from "node:test";
import assert from "node:assert/strict";
import { Message, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
};

async function stand(name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const general = welcome.state.channels.find(c => c.name === "general")!;
  return { relay, url, owner, general };
}

async function say(client: TestClient, channelId: string, text: string): Promise<Message> {
  client.send({ type: "send", channelId, text });
  return (await client.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.text === text)).message;
}

function waitForClose(...clients: Array<TestClient | undefined>): Promise<void> {
  for (const client of clients) client?.close();
  return new Promise(resolve => setTimeout(resolve, 80));
}

test("thread summary mobile requester disconnect settles and stale provider result is refused", async t => {
  const { relay, url, owner, general } = await stand("thread-summary-mobile-focused.db");
  let mobile: TestClient | undefined;
  let engine: TestClient | undefined;
  let replacement: TestClient | undefined;
  t.after(async () => {
    await waitForClose(replacement, engine, mobile, owner);
    relay.close();
  });
  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
  const scout = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [scout.id] });
  await owner.wait(f => f.type === "channel" && f.channel.id === general.id && f.channel.memberIds.includes(scout.id));
  const root = await say(owner, general.id, "Mobile requester lifecycle");
  owner.close();
  await new Promise(resolve => setTimeout(resolve, 80));
  mobile = new TestClient(url, "tok-owner", "mobile");
  await mobile.wait(f => f.type === "welcome");
  engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  mobile.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
    sourceMessageId: root.id, agentId: scout.id, requestId: "summary-mobile-focused" });
  await mobile.wait(f => f.type === "threadSummary" && f.summary.status === "pending");
  const request = await engine.wait<Extract<ServerFrame, { type: "threadSummaryRequest" }>>(
    f => f.type === "threadSummaryRequest" && f.request.requestId === "summary-mobile-focused");
  mobile.close();
  await new Promise(resolve => setTimeout(resolve, 80));
  replacement = new TestClient(url, "tok-owner");
  await replacement.wait(f => f.type === "welcome");
  replacement.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
    sourceMessageId: root.id, agentId: scout.id, requestId: "summary-mobile-focused" });
  const ended = await replacement.wait<Extract<ServerFrame, { type: "threadSummary" }>>(
    f => f.type === "threadSummary" && f.summary.requestId === "summary-mobile-focused" && f.summary.status === "unavailable");
  assert.match(ended.summary.error ?? "", /requester disconnected/);
  engine.send({ type: "threadSummaryResult", result: {
    ...request.request, status: "ready", updatedAt: Date.now(), decisions: ["stale"],
    openQuestions: [], nextActions: [], sources: [],
  } });
  const stale = await engine.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && /conflicts with the accepted request|no pending request/.test(f.error));
  assert.match(stale.error, /conflicts with the accepted request/);
});

test("thread summary malformed and deleted sources terminally settle provider work", async t => {
  const { relay, url, owner, general } = await stand("thread-summary-invalid-focused.db");
  let engine: TestClient | undefined;
  t.after(async () => {
    await waitForClose(engine, owner);
    relay.close();
  });
  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
  const scout = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [scout.id] });
  await owner.wait(f => f.type === "channel" && f.channel.id === general.id && f.channel.memberIds.includes(scout.id));
  const root = await say(owner, general.id, "Provider result should not outlive its source");
  engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  owner.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
    sourceMessageId: root.id, agentId: scout.id, requestId: "summary-malformed-focused" });
  await owner.wait(f => f.type === "threadSummary" && f.summary.status === "pending");
  const malformed = await engine.wait<Extract<ServerFrame, { type: "threadSummaryRequest" }>>(
    f => f.type === "threadSummaryRequest" && f.request.requestId === "summary-malformed-focused");
  engine.send({ type: "threadSummaryResult", result: {
    ...malformed.request, status: "ready", updatedAt: Date.now(), decisions: "not-a-list",
    openQuestions: [], nextActions: [], sources: [],
  } as never });
  const malformedEnded = await owner.wait<Extract<ServerFrame, { type: "threadSummary" }>>(
    f => f.type === "threadSummary" && f.summary.requestId === "summary-malformed-focused" && f.summary.status === "unavailable");
  assert.match(malformedEnded.summary.error ?? "", /unavailable/);
  await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");

  const deletedRoot = await say(owner, general.id, "This root will be deleted before the result");
  owner.send({ type: "threadSummary", channelId: general.id, threadId: deletedRoot.id,
    sourceMessageId: deletedRoot.id, agentId: scout.id, requestId: "summary-deleted-focused" });
  await owner.wait(f => f.type === "threadSummary" && f.summary.requestId === "summary-deleted-focused" && f.summary.status === "pending");
  const deletedRequest = await engine.wait<Extract<ServerFrame, { type: "threadSummaryRequest" }>>(
    f => f.type === "threadSummaryRequest" && f.request.requestId === "summary-deleted-focused");
  owner.send({ type: "deleteMessage", messageId: deletedRoot.id });
  await owner.wait(f => f.type === "messageUpdated" && f.message.id === deletedRoot.id && Boolean(f.message.deletedAt));
  engine.send({ type: "threadSummaryResult", result: {
    ...deletedRequest.request, status: "ready", updatedAt: Date.now(), decisions: ["should not persist"],
    openQuestions: [], nextActions: [], sources: [{ messageId: deletedRoot.id, label: "provider label" }],
  } });
  const deletedEnded = await owner.wait<Extract<ServerFrame, { type: "threadSummary" }>>(
    f => f.type === "threadSummary" && f.summary.requestId === "summary-deleted-focused" && f.summary.status === "unavailable");
  assert.match(deletedEnded.summary.error ?? "", /deleted/);
});

test("thread summary rejects a deleted root before creating provider work", async t => {
  const { relay, owner, general } = await stand("thread-summary-deleted-request-focused.db");
  t.after(async () => {
    await waitForClose(owner);
    relay.close();
  });
  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
  const scout = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [scout.id] });
  await owner.wait(f => f.type === "channel" && f.channel.id === general.id && f.channel.memberIds.includes(scout.id));
  const root = await say(owner, general.id, "Delete me before asking");
  owner.send({ type: "deleteMessage", messageId: root.id });
  await owner.wait(f => f.type === "messageUpdated" && f.message.id === root.id && Boolean(f.message.deletedAt));
  owner.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
    sourceMessageId: root.id, agentId: scout.id, requestId: "summary-deleted-request-focused" });
  const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "summary-deleted-request-focused");
  assert.match(refused.error, /deleted/);
});
