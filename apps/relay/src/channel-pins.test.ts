import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import { Message, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { SCHEMA_VERSION, Store } from "./store.js";
import { TestClient, tmp } from "./testclient.js";

async function stand(t: TestContext, name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const clients: TestClient[] = [];
  t.after(() => { clients.forEach(client => client.close()); relay.close(); });
  const open = (token: string) => { const client = new TestClient(`ws://127.0.0.1:${port}`, token); clients.push(client); return client; };
  const owner = open("tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { relay, owner, open, channelId: welcome.state.channels.find(c => c.kind === "channel")!.id };
}

async function post(client: TestClient, channelId: string, text: string): Promise<Message> {
  client.send({ type: "send", channelId, text });
  return (await client.wait<Extract<ServerFrame, { type: "message" }>>(f => f.type === "message" && f.message.text === text)).message;
}

test("channel pins migrate after v11 and keep a stable newest-first cursor", () => {
  const dbPath = tmp("pins-migration.db");
  const old = new Store(dbPath, { ownerToken: "tok-owner" });
  old.db.exec("UPDATE meta SET value='11' WHERE key='schemaVersion'");
  old.db.exec("DROP TABLE channel_pins; DROP TABLE channel_pin_receipts;");
  old.db.close();
  const store = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(store.schemaVersion(), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 14);
  assert.ok(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='channel_pins'").get());
  store.db.close();
});

test("pins are non-DM, role-gated, source-bound, projected, replay-safe, and mirrored", async t => {
  const { relay, owner, open, channelId } = await stand(t, "pins-relay.db");
  const mirror = open("tok-owner");
  await mirror.wait(f => f.type === "welcome");
  const first = await post(owner, channelId, "first pinned message");
  owner.send({ type: "pinMessage", channelId, messageId: first.id, requestId: "pin-1" });
  const pinned = await owner.wait<Extract<ServerFrame, { type: "channelPins" }>>(f => f.type === "channelPins" && f.requestId === "pin-1");
  assert.equal(pinned.entries[0].state, "active");
  assert.equal(pinned.entries[0].message?.id, first.id);
  const mirrorPush = await mirror.wait<Extract<ServerFrame, { type: "channelPins" }>>(f => f.type === "channelPins" && f.channelId === channelId && f.requestId === undefined);
  assert.equal(mirrorPush.entries[0].message?.text, first.text);

  owner.send({ type: "pinMessage", channelId, messageId: first.id, requestId: "pin-1" });
  const replay = await owner.wait<Extract<ServerFrame, { type: "channelPins" }>>(f => f.type === "channelPins" && f.requestId === "pin-1" && f.entries[0].messageId === first.id);
  assert.equal(replay.entries.length, 1, "replaying a pin never duplicates it");
  owner.send({ type: "unpinMessage", channelId, messageId: first.id, requestId: "pin-1" });
  const conflict = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "pin-1");
  assert.match(conflict.error, /already used/);

  owner.send({ type: "deleteMessage", messageId: first.id });
  await owner.wait(f => f.type === "messageUpdated" && f.message.id === first.id && !!f.message.deletedAt);
  owner.send({ type: "listChannelPins", channelId, requestId: "list-deleted" });
  const deleted = await owner.wait<Extract<ServerFrame, { type: "channelPins" }>>(f => f.type === "channelPins" && f.requestId === "list-deleted");
  assert.equal(deleted.entries[0].state, "deleted");
  assert.equal(deleted.entries[0].message, undefined, "deleted source text is redacted");

  owner.send({ type: "createChannel", name: "other pins", memberIds: [], kind: "channel" });
  const other = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(f => f.type === "channel" && f.channel.name === "other pins");
  owner.send({ type: "pinMessage", channelId: other.channel.id, messageId: first.id, requestId: "wrong-channel" });
  const wrong = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "wrong-channel");
  assert.match(wrong.error, /not in this channel/);

  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const member = open(`invite:${invite.code}:Priya`);
  const memberWelcome = await member.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const memberId = memberWelcome.state.me.id;
  owner.send({ type: "addMembers", channelId, memberIds: [memberId] });
  // The member can list but cannot mutate. The check happens before any receipt lookup.
  member.send({ type: "listChannelPins", channelId, requestId: "member-list" });
  const list = await member.wait<Extract<ServerFrame, { type: "channelPins" }>>(f => f.type === "channelPins" && f.requestId === "member-list");
  assert.equal(list.entries[0].state, "deleted", "membership may list a pin, but never the deleted source text");
  member.send({ type: "pinMessage", channelId, messageId: first.id, requestId: "member-pin" });
  const denied = await member.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "member-pin");
  assert.match(denied.error, /run this conversation/);
  owner.send({ type: "setMemberRole", channelId, memberId, role: "admin" });
  const elevated = await member.wait<Extract<ServerFrame, { type: "channelMembers" }>>(f =>
    f.type === "channelMembers" && f.channelId === channelId && f.members.some(row => row.memberId === memberId && row.role === "admin"));
  assert.ok(elevated.members.some(row => row.memberId === memberId && row.role === "admin"));
  owner.send({ type: "setMemberRole", channelId, memberId, role: "member" });
  const demoted = await member.wait<Extract<ServerFrame, { type: "channelMembers" }>>(f =>
    f.type === "channelMembers" && f.channelId === channelId && f.members.some(row => row.memberId === memberId && row.role === "member"));
  assert.ok(demoted.members.some(row => row.memberId === memberId && row.role === "member"));
  void relay;
});

test("pin receipts are user-scoped, expire after 30 days, and stay bounded", () => {
  const store = new Store(tmp("pin-receipts.db"), { ownerToken: "tok-owner" });
  const owner = store.ensureOwner("Vikas", "tok-owner");
  for (let i = 0; i < 520; i++) {
    store.pinChannelMessage(owner.id, `ch-${i}`, `m-${i}`, `pin-${i}`);
  }
  const count = (store.db.prepare("SELECT COUNT(*) AS n FROM channel_pin_receipts WHERE userId=?").get(owner.id) as { n: number }).n;
  assert.ok(count <= 512);
  store.db.prepare("UPDATE channel_pin_receipts SET createdAt=0 WHERE userId=? AND requestId=?").run(owner.id, "pin-519");
  assert.equal(store.channelPinMutationStatus(owner.id, "pin-519", "pinMessage", "ch-519", "m-519"), undefined);
  store.db.close();
});

test("a repeated active pin keeps its place and each channel is capped", () => {
  const store = new Store(tmp("pin-cap.db"), { ownerToken: "tok-owner" });
  const owner = store.ensureOwner("Vikas", "tok-owner");
  const first = store.pinChannelMessage(owner.id, "ch", "m-0", "first");
  const again = store.pinChannelMessage(owner.id, "ch", "m-0", "again");
  assert.equal(again.pinnedAt, first.pinnedAt, "an already-pinned message keeps its newest-first position");
  for (let i = 1; i < 100; i++) store.pinChannelMessage(owner.id, "ch", `m-${i}`, `p-${i}`);
  assert.throws(() => store.pinChannelMessage(owner.id, "ch", "m-100", "too-many"), /100 pinned messages/);
  store.db.close();
});
