import assert from "node:assert/strict";
import test, { TestContext } from "node:test";
import { Message, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { Store } from "./store.js";
import { TestClient, tmp } from "./testclient.js";

async function stand(t: TestContext, name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const clients: TestClient[] = [];
  t.after(() => { clients.forEach(client => client.close()); relay.close(); });
  const open = (token: string) => {
    const client = new TestClient(`ws://127.0.0.1:${port}`, token);
    clients.push(client);
    return client;
  };
  const owner = open("tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { relay, owner, open, channelId: welcome.state.channels[0].id };
}

async function post(owner: TestClient, channelId: string, text: string): Promise<Message> {
  owner.send({ type: "send", channelId, text });
  return (await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.text === text,
  )).message;
}

test("saved rows survive reopen and unsave is a durable soft removal", () => {
  const dbPath = tmp("saved-reopen.db");
  const first = new Store(dbPath, { ownerToken: "tok-owner" });
  const owner = first.ensureOwner("Vikas", "tok-owner");
  first.saveMessage({
    id: "m-saved", channelId: "ch-general", authorId: owner.id, authorName: owner.name,
    authorKind: "human", text: "Keep this", ts: 10,
  });
  first.saveSavedMessage(owner.id, "m-saved", "ch-general", "bring it up", 99, "save-replay");
  const original = first.savedMessages(owner.id)[0];
  first.saveSavedMessage(owner.id, "m-saved", "ch-general", undefined, undefined, "save-replay");
  const replayed = first.savedMessages(owner.id)[0];
  assert.equal(replayed.savedAt, original.savedAt, "a replay does not move the saved row");
  assert.equal(replayed.note, "bring it up", "a replay does not erase metadata");
  assert.throws(
    () => first.saveSavedMessage(owner.id, "m-saved", "ch-general", "changed", 99, "save-replay"),
    /already used/,
  );
  first.saveSavedMessage(owner.id, "m-active", "ch-general", "keep after restart", undefined, "active-save");
  assert.equal(first.schemaVersion(), 8);
  assert.ok(first.savedMessages(owner.id).some(entry => entry.note === "bring it up"));
  first.unsaveMessage(owner.id, "m-saved");
  assert.ok(!first.savedMessages(owner.id).some(entry => entry.messageId === "m-saved"));
  first.db.close();

  const reopened = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(reopened.schemaVersion(), 8);
  assert.ok(reopened.savedMessages(owner.id).some(entry => entry.messageId === "m-active"), "active saves survive restart");
  reopened.db.close();
});

test("saved mutation receipts are owner-scoped, bounded, and expire conservatively", () => {
  const dbPath = tmp("saved-receipts.db");
  const store = new Store(dbPath, { ownerToken: "tok-owner" });
  const owner = store.ensureOwner("Vikas", "tok-owner");
  const invite = store.createInvite(owner.id);
  const friend = store.redeemInvite(invite, "Priya")!.user;
  store.saveSavedMessage(owner.id, "m-owner", "ch-general", "private", undefined, "same-request");
  store.saveSavedMessage(friend.id, "m-friend", "ch-general", "friend", undefined, "same-request");
  assert.equal(store.savedMessages(owner.id)[0].note, "private");
  assert.equal(store.savedMessages(friend.id)[0].note, "friend");
  store.db.prepare("UPDATE saved_mutation_receipts SET createdAt=0 WHERE userId=? AND requestId=?")
    .run(owner.id, "same-request");
  store.saveSavedMessage(owner.id, "m-new", "ch-general", undefined, undefined, "new-request");
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM saved_mutation_receipts WHERE userId=? AND requestId=?")
    .get(owner.id, "same-request") as { n: number }).n, 0, "old receipts are outside the 30-day retry window");
  for (let i = 0; i < 520; i++) {
    store.saveSavedMessage(owner.id, `m-${i}`, "ch-general", undefined, undefined, `request-${i}`);
  }
  assert.ok((store.db.prepare("SELECT COUNT(*) AS n FROM saved_mutation_receipts WHERE userId=?")
    .get(owner.id) as { n: number }).n <= 512, "retry receipts stay bounded per account");
  store.removeUser(friend.id);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM saved_mutation_receipts WHERE userId=?")
    .get(friend.id) as { n: number }).n, 0, "account removal purges retry receipts");
  assert.deepEqual(store.savedMessages(friend.id), [], "account removal purges private saves");
  store.db.close();
});

test("saved v8 migration runs after Workflow v7 from a v6 database", () => {
  const dbPath = tmp("saved-after-workflow-v7.db");
  const old = new Store(dbPath, { ownerToken: "tok-owner" });
  old.db.exec("UPDATE meta SET value='6' WHERE key='schemaVersion'");
  assert.equal(old.schemaVersion(), 6);
  old.db.close();
  const migrated = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(migrated.schemaVersion(), 8);
  const tables = migrated.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('saved_messages','workflows') ORDER BY name",
  ).all() as { name: string }[];
  assert.deepEqual(tables.map(row => row.name), ["saved_messages", "workflows"]);
  migrated.db.close();
});

test("saved queue is owner-scoped, idempotent, ordered, and projects deleted tombstones", async t => {
  const { owner, open, channelId } = await stand(t, "saved-queue.db");
  const mirror = open("tok-owner");
  await mirror.wait(f => f.type === "welcome");
  const first = await post(owner, channelId, "First saved note");
  const second = await post(owner, channelId, "Second saved note");
  const saveRequest = "save-first";
  owner.send({ type: "saveMessage", messageId: first.id, note: "follow up", remindAt: 123, requestId: saveRequest });
  const saved = await owner.wait<Extract<ServerFrame, { type: "savedMessages" }>>(
    f => f.type === "savedMessages" && f.requestId === saveRequest,
  );
  const mirrored = await mirror.wait<Extract<ServerFrame, { type: "savedMessages" }>>(
    f => f.type === "savedMessages" && f.entries.some(entry => entry.messageId === first.id),
  );
  assert.equal(mirrored.requestId, undefined, "another owner window receives a push without the first window's request id");
  assert.equal(saved.entries.length, 1);
  assert.equal(saved.entries[0].state, "active");
  assert.equal(saved.entries[0].note, "follow up");
  assert.equal(saved.entries[0].remindAt, 123);
  assert.equal(saved.entries[0].message?.id, first.id);
  owner.send({ type: "saveMessage", messageId: second.id, remindAt: Number.MAX_VALUE, requestId: "bad-reminder" });
  const badReminder = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "bad-reminder",
  );
  assert.match(badReminder.error, /reminder date/);

  owner.send({ type: "saveMessage", messageId: second.id, requestId: "save-second" });
  await owner.wait(f => f.type === "savedMessages" && f.requestId === "save-second");
  owner.send({ type: "saveMessage", messageId: first.id, requestId: "save-again" });
  const repeated = await owner.wait<Extract<ServerFrame, { type: "savedMessages" }>>(
    f => f.type === "savedMessages" && f.requestId === "save-again",
  );
  assert.equal(repeated.entries.length, 2, "re-saving updates one row, not a duplicate");
  assert.deepEqual(
    repeated.entries.map(entry => entry.messageId),
    [...repeated.entries].sort((a, b) => b.savedAt - a.savedAt || b.messageId.localeCompare(a.messageId)).map(entry => entry.messageId),
  );

  owner.send({ type: "deleteMessage", messageId: first.id });
  await owner.wait(f => f.type === "messageUpdated" && f.message.id === first.id && !!f.message.deletedAt);
  owner.send({ type: "listSaved", requestId: "list-after-delete" });
  const deleted = await owner.wait<Extract<ServerFrame, { type: "savedMessages" }>>(
    f => f.type === "savedMessages" && f.requestId === "list-after-delete",
  );
  assert.equal(deleted.entries.find(e => e.messageId === first.id)?.state, "deleted");
  owner.send({ type: "saveMessage", messageId: first.id, note: "follow up", remindAt: 123, requestId: saveRequest });
  const replayAfterDelete = await owner.wait<Extract<ServerFrame, { type: "savedMessages" }>>(
    f => f.type === "savedMessages" && f.requestId === saveRequest,
  );
  assert.equal(replayAfterDelete.entries.find(e => e.messageId === first.id)?.state, "deleted", "a replay does not re-authorise deleted content");

  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${invite.code}:Priya`);
  await friend.wait(f => f.type === "welcome");
  friend.send({ type: "listSaved", requestId: "friend-list" });
  const friendList = await friend.wait<Extract<ServerFrame, { type: "savedMessages" }>>(
    f => f.type === "savedMessages" && f.requestId === "friend-list",
  );
  assert.deepEqual(friendList.entries, [], "saved rows never cross user accounts");
  friend.send({ type: "unsaveMessage", messageId: second.id, requestId: "friend-unsave" });
  const friendAfter = await friend.wait<Extract<ServerFrame, { type: "savedMessages" }>>(
    f => f.type === "savedMessages" && f.requestId === "friend-unsave",
  );
  assert.deepEqual(friendAfter.entries, []);
  owner.send({ type: "listSaved", requestId: "owner-still-has-second" });
  const ownerAfter = await owner.wait<Extract<ServerFrame, { type: "savedMessages" }>>(
    f => f.type === "savedMessages" && f.requestId === "owner-still-has-second",
  );
  assert.ok(ownerAfter.entries.some(entry => entry.messageId === second.id));
});

test("saved source access is rechecked after membership removal", async t => {
  const { owner, open } = await stand(t, "saved-access.db");
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${invite.code}:Priya`);
  const welcome = await friend.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "createChannel", name: "Shared notes", memberIds: [welcome.state.me.id], kind: "channel" });
  const channel = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(f => f.type === "channel" && f.channel.name === "Shared notes");
  await friend.wait(f => f.type === "channel" && f.channel.id === channel.channel.id);
  const message = await post(friend, channel.channel.id, "Private to the shared room");
  friend.send({ type: "saveMessage", messageId: message.id, requestId: "friend-save" });
  const saved = await friend.wait<Extract<ServerFrame, { type: "savedMessages" }>>(
    f => f.type === "savedMessages" && f.requestId === "friend-save",
  );
  assert.equal(saved.entries[0].state, "active");
  owner.send({ type: "removeMember", channelId: channel.channel.id, memberId: welcome.state.me.id });
  await friend.wait(f => f.type === "channelLeft" && f.channelId === channel.channel.id);
  friend.send({ type: "listSaved", requestId: "friend-after-leave" });
  const afterLeave = await friend.wait<Extract<ServerFrame, { type: "savedMessages" }>>(
    f => f.type === "savedMessages" && f.requestId === "friend-after-leave",
  );
  assert.equal(afterLeave.entries[0].state, "inaccessible");
  assert.equal(afterLeave.entries[0].message, undefined);
  owner.send({ type: "addMembers", channelId: channel.channel.id, memberIds: [welcome.state.me.id] });
  const rejoined = await friend.wait<Extract<ServerFrame, { type: "savedMessages" }>>(
    f => f.type === "savedMessages" && f.entries.some(entry => entry.messageId === message.id),
  );
  assert.equal(rejoined.entries[0].state, "active", "membership return rehydrates saved source access");
});
