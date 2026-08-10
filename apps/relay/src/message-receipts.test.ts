import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import { Message, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { Store } from "./store.js";
import { TestClient, tmp } from "./testclient.js";

function humanMessage(id: string, channelId: string, authorId: string, ts = Date.now()): Message {
  return {
    id, channelId, authorId, authorName: authorId, authorKind: "human", text: `message ${id}`, ts,
    clientMessageId: `client-${id}`,
  };
}

test("human send ledger replays canonically, refuses conflicts, and stays bounded", () => {
  const store = new Store(tmp("message-ledger.db"), { ownerToken: "tok-owner" });
  const owner = store.ensureOwner("Vikas", "tok-owner");
  const first = humanMessage("m-1", "channel-1", owner.id);
  const hash = store.messagePayloadHash({ channelId: first.channelId, text: first.text });
  const saved = store.saveHumanMessage(first, first.clientMessageId!, hash);
  assert.equal(saved.replayed, false);
  assert.equal(store.saveHumanMessage({ ...first, id: "m-other" }, first.clientMessageId!, hash).message.id, first.id);
  const conflict = { ...first, id: "m-conflict", text: "different" };
  const conflictHash = store.messagePayloadHash({ channelId: conflict.channelId, text: conflict.text });
  assert.throws(() => store.saveHumanMessage(conflict, first.clientMessageId!, conflictHash), /different words/);

  for (let i = 0; i < 520; i++) {
    const m = humanMessage(`m-${i + 10}`, "channel-1", owner.id);
    const payloadHash = store.messagePayloadHash({ channelId: m.channelId, text: m.text });
    store.saveHumanMessage(m, m.clientMessageId!, payloadHash);
  }
  const count = (store.db.prepare("SELECT COUNT(*) n FROM message_send_ledger WHERE authorId=?").get(owner.id) as { n: number }).n;
  assert.ok(count <= 512);
  store.db.prepare("UPDATE message_send_ledger SET createdAt=0 WHERE authorId=? AND clientMessageId=?")
    .run(owner.id, "client-m-529");
  assert.equal(store.messageSendStatus(owner.id, "client-m-529"), undefined);
  store.recordMessageReceipt("u-recipient", first, "delivered");
  store.removeUser(owner.id);
  assert.deepEqual(store.messageReceipts(first.id), [], "account removal purges authored-message receipts");
  store.db.close();
});

test("receipt rows are monotonic and tie-safe read state is cursor ordered", () => {
  const store = new Store(tmp("message-receipts-store.db"), { ownerToken: "tok-owner" });
  const owner = store.ensureOwner("Vikas", "tok-owner");
  const message = humanMessage("m-receipt", "channel-1", owner.id, 1000);
  const delivered = store.recordMessageReceipt("u-recipient", message, "delivered");
  assert.equal(delivered, true);
  assert.equal(store.recordMessageReceipt("u-recipient", message, "delivered"), false);
  assert.equal(store.recordMessageReceipt("u-recipient", message, "read", { ts: 1000, id: message.id }), true);
  assert.equal(store.recordMessageReceipt("u-recipient", message, "read", { ts: 1, id: "older" }), false);
  assert.deepEqual(store.messageReceipt(message.id, "u-recipient"), {
    messageId: message.id, channelId: message.channelId, recipientId: "u-recipient",
    deliveredAt: store.messageReceipt(message.id, "u-recipient")!.deliveredAt,
    readAt: store.messageReceipt(message.id, "u-recipient")!.readAt,
    cursorTs: 1000, cursorId: message.id,
  });

  store.markRead(owner.id, message.channelId, 1000, "m-b");
  store.markRead(owner.id, message.channelId, 1000, "m-a");
  assert.deepEqual(store.lastReadCursor(owner.id, message.channelId), { ts: 1000, id: "m-b" });
  store.db.close();
});

async function stand(t: TestContext, name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const clients: TestClient[] = [];
  t.after(() => { clients.forEach(client => client.close()); relay.close(); });
  const open = (token: string, clientKind: "desktop" | "mobile" | "engine" = "desktop") => {
    const client = new TestClient(url, token, clientKind); clients.push(client); return client;
  };
  const owner = open("tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { relay, owner, open, url, channel: welcome.state.channels.find(c => c.name === "general")! };
}

test("relay replays lost acknowledgements and keeps receipt status author-only", async t => {
  const { owner, open, channel } = await stand(t, "message-receipts-relay.db");
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const recipient = open(`invite:${invite.code}:Priya`);
  const recipientWelcome = await recipient.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "addMembers", channelId: channel.id, memberIds: [recipientWelcome.state.me.id] });
  await owner.wait(f => f.type === "channel" && f.channel.id === channel.id && f.channel.memberIds.includes(recipientWelcome.state.me.id));
  recipient.frames.length = 0;
  owner.frames.length = 0;

  owner.send({ type: "send", channelId: channel.id, text: "durable", clientMessageId: "cm-retry", requestId: "send-1" });
  const accepted = await owner.wait<Extract<ServerFrame, { type: "message" }>>(f => f.type === "message" && f.requestId === "send-1");
  const message = accepted.message;
  assert.equal(message.clientMessageId, "cm-retry");
  owner.send({ type: "messageStatus", clientMessageId: "cm-retry", requestId: "status-1" });
  const queried = await owner.wait<Extract<ServerFrame, { type: "messageStatus" }>>(f => f.type === "messageStatus" && f.requestId === "status-1");
  assert.equal(queried.status.stage, "accepted");

  const delivered = await recipient.wait<Extract<ServerFrame, { type: "message" }>>(f => f.type === "message" && f.message.id === message.id);
  recipient.send({ type: "messageReceipt", channelId: channel.id, messageId: delivered.message.id, status: "delivered" });
  const deliveredStatus = await owner.wait<Extract<ServerFrame, { type: "messageStatus" }>>(f => f.type === "messageStatus" && f.status.messageId === message.id && f.status.stage === "delivered");
  assert.equal(deliveredStatus.status.recipients, undefined, "group status never exposes recipient ids");
  assert.equal(deliveredStatus.status.deliveredCount, 1);

  recipient.send({ type: "messageReceipt", channelId: channel.id, messageId: message.id, status: "read", ts: message.ts, messageIdCursor: message.id });
  const readStatus = await owner.wait<Extract<ServerFrame, { type: "messageStatus" }>>(f => f.type === "messageStatus" && f.status.messageId === message.id && f.status.stage === "read");
  assert.equal(readStatus.status.readCount, 1);

  recipient.send({ type: "messageReceipt", channelId: channel.id, messageId: message.id, status: "bogus" } as never);
  const badReceipt = await recipient.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(badReceipt.error, /receipt stage/i);

  owner.send({ type: "archiveChannel", channelId: channel.id, archived: true });
  await owner.wait(f => f.type === "channel" && f.channel.id === channel.id && !!f.channel.archivedAt);
  owner.send({ type: "send", channelId: channel.id, text: "durable", clientMessageId: "cm-retry", requestId: "send-archived-replay" });
  const archivedReplay = await owner.wait<Extract<ServerFrame, { type: "message" }>>(f => f.type === "message" && f.requestId === "send-archived-replay");
  assert.equal(archivedReplay.message.id, message.id, "accepted retries replay even after archival");
  owner.send({ type: "archiveChannel", channelId: channel.id, archived: false });
  await owner.wait(f => f.type === "channel" && f.channel.id === channel.id && !f.channel.archivedAt);

  owner.send({ type: "send", channelId: channel.id, text: "durable", clientMessageId: "cm-retry", requestId: "send-replay" });
  const replay = await owner.wait<Extract<ServerFrame, { type: "message" }>>(f => f.type === "message" && f.requestId === "send-replay");
  assert.equal(replay.message.id, message.id);
  owner.send({ type: "send", channelId: channel.id, text: "changed", clientMessageId: "cm-retry", requestId: "send-conflict" });
  const conflict = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "send-conflict");
  assert.match(conflict.error, /different words/);

  owner.send({ type: "leaveChannel", channelId: channel.id });
  await owner.wait(f => f.type === "channelLeft" && f.channelId === channel.id);
  owner.send({ type: "messageStatus", clientMessageId: "cm-retry", requestId: "status-after-leave" });
  const statusAfterLeave = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "status-after-leave");
  assert.match(statusAfterLeave.error, /accepted message is not available/,
    "a durable send ledger is not a channel-access grant after the author leaves");
  owner.send({ type: "send", channelId: channel.id, text: "durable", clientMessageId: "cm-retry", requestId: "send-removed-replay" });
  const removed = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "send-removed-replay");
  assert.match(removed.error, /no such channel/);
});

test("receipts freeze the message audience, protect DM detail, and reject engines", async t => {
  const { relay, owner, open, channel } = await stand(t, "message-receipts-audience.db");
  owner.send({ type: "send", channelId: channel.id, text: "before join", clientMessageId: "cm-before" });
  const before = await owner.wait<Extract<ServerFrame, { type: "message" }>>(f => f.type === "message" && f.message.clientMessageId === "cm-before");
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const late = open(`invite:${invite.code}:Late`);
  const lateWelcome = await late.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "addMembers", channelId: channel.id, memberIds: [lateWelcome.state.me.id] });
  await owner.wait(f => f.type === "channel" && f.channel.id === channel.id && f.channel.memberIds.includes(lateWelcome.state.me.id));
  owner.send({ type: "messageStatus", clientMessageId: "cm-before", requestId: "status-before" });
  const historical = await owner.wait<Extract<ServerFrame, { type: "messageStatus" }>>(f => f.type === "messageStatus" && f.requestId === "status-before");
  assert.equal(historical.status.recipientCount, 0, "late joiners never inflate historical audience");
  late.send({ type: "messageReceipt", channelId: channel.id, messageId: before.message.id, status: "delivered" });
  const lateDenied = await late.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(lateDenied.error, /when that message was sent/);

  owner.send({ type: "createChannel", name: "private dm", memberIds: [lateWelcome.state.me.id], kind: "dm" });
  const dm = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(f => f.type === "channel" && f.channel.kind === "dm");
  owner.send({ type: "send", channelId: dm.channel.id, text: "dm words", clientMessageId: "cm-dm" });
  const dmMessage = await late.wait<Extract<ServerFrame, { type: "message" }>>(f => f.type === "message" && f.message.clientMessageId === "cm-dm");
  late.send({ type: "messageReceipt", channelId: dm.channel.id, messageId: dmMessage.message.id, status: "delivered" });
  const dmStatus = await owner.wait<Extract<ServerFrame, { type: "messageStatus" }>>(f => f.type === "messageStatus" && f.status.messageId === dmMessage.message.id && f.status.stage === "delivered");
  assert.deepEqual(dmStatus.status.recipients?.map(recipient => recipient.recipientId), [lateWelcome.state.me.id]);

  // Removing the recipient cleans the receipt row before the author can ask
  // again, so an exact DM projection never leaves a stale identity behind.
  // DMs have no admin/remove UI; exercise the supported account-removal path,
  // which revokes membership and purges receipt metadata without widening the
  // product's direct-conversation settings surface.
  relay.store.removeUser(lateWelcome.state.me.id);
  owner.send({ type: "messageStatus", clientMessageId: "cm-dm", requestId: "dm-after-removal" });
  const dmAfterRemoval = await owner.wait<Extract<ServerFrame, { type: "messageStatus" }>>(
    f => f.type === "messageStatus" && f.requestId === "dm-after-removal");
  assert.deepEqual(dmAfterRemoval.status.recipients ?? [], [],
    "a removed DM recipient id is not retained in the author's exact status view");

  const engine = open("tok-owner", "engine");
  const engineWelcome = await engine.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  assert.deepEqual(engineWelcome.state.messageStatuses, [], "engines do not bootstrap human delivery state");
  engine.send({ type: "messageReceipt", channelId: dm.channel.id, messageId: dmMessage.message.id, status: "read" });
  const engineDenied = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(engineDenied.error, /human receipts/);
});

test("author status is restored in a new desktop window after reconnect", async t => {
  const { owner, open, channel } = await stand(t, "message-receipts-reconnect.db");
  owner.send({ type: "send", channelId: channel.id, text: "survives reconnect", clientMessageId: "cm-reconnect" });
  const sent = await owner.wait<Extract<ServerFrame, { type: "message" }>>(f => f.type === "message" && f.message.clientMessageId === "cm-reconnect");
  owner.close();
  const reopened = open("tok-owner");
  const welcome = await reopened.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const status = welcome.state.messageStatuses?.find(candidate => candidate.messageId === sent.message.id);
  assert.equal(status?.stage, "accepted");
});
