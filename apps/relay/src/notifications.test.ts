import test from "node:test";
import assert from "node:assert/strict";
import { Channel, NOTIFICATION_INBOX_LIMITS, notificationEventId } from "@cloud9/shared";
import { Store, NotificationInboxRow } from "./store.js";
import { TestClient, tmp } from "./testclient.js";
import { Relay } from "./server.js";

function setup() {
  const store = new Store(tmp("notifications.db"), { ownerToken: "tok-owner" });
  const owner = store.ensureOwner("Vikas", "tok-owner");
  let channel = store.channels().find(c => c.name === "general");
  if (!channel) {
    channel = {
      id: "ch_general", name: "general", kind: "channel",
      memberIds: [owner.id], createdAt: Date.now(),
    } satisfies Channel;
    store.createChannel(channel, owner.id);
  }
  const guestId = "u_guest";
  store.db.prepare("INSERT INTO users(id,name) VALUES(?,?)").run(guestId, "Guest");
  if (!channel.memberIds.includes(guestId)) {
    channel.memberIds.push(guestId);
    store.saveChannel(channel);
  }
  return { store, owner, guestId, channel };
}

function row(over: Partial<NotificationInboxRow> = {}): NotificationInboxRow {
  return {
    id: "notification:mention:u_owner:m1", recipientId: "u_owner", kind: "mention",
    channelId: "ch_general", messageId: "m1", actorId: "u_guest",
    createdAt: Date.now(), state: "unread", ...over,
  };
}

async function stand(name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const welcome = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "welcome" }>>(
    frame => frame.type === "welcome");
  const general = welcome.state.channels.find(channel => channel.name === "general")!;
  owner.frames.length = 0;
  return { relay, url, owner, general };
}

async function inviteGuest(owner: TestClient, url: string) {
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "invite" }>>(
    frame => frame.type === "invite");
  const guest = new TestClient(url, `invite:${invite.code}:Guest`);
  const welcome = await guest.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "welcome" }>>(
    frame => frame.type === "welcome");
  return { guest, me: welcome.state.me };
}

async function say(client: TestClient, channelId: string, text: string, replyTo?: string) {
  client.send({ type: "send", channelId, text, ...(replyTo ? { replyTo } : {}) });
  return client.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "message" }>>(
    frame => frame.type === "message" && frame.message.text === text);
}

test("notification event ids and SQLite insertion are deterministic and idempotent", () => {
  const { store } = setup();
  const id = notificationEventId("mention", "m1", "u_owner");
  const first = row({ id, channelId: "ch_general" });
  assert.equal(store.saveNotification(first), true);
  assert.equal(store.saveNotification({ ...first, state: "read" }), false);
  assert.deepEqual(store.notificationsFor("u_owner"), [first]);
  assert.equal(notificationEventId("mention", "m1", "u_owner"), id);
});

test("read and dismiss are recipient-scoped, monotonic, and reconnect-safe", () => {
  const { store } = setup();
  const id = notificationEventId("thread_reply", "m2", "u_owner");
  store.saveNotification(row({ id, kind: "thread_reply", messageId: "m2" }));
  assert.equal(store.setNotificationState("u_guest", id, "read"), undefined);
  assert.equal(store.setNotificationState("u_owner", id, "read")?.state, "read");
  assert.equal(store.setNotificationState("u_owner", id, "dismissed")?.state, "dismissed");
  // A stale read from another machine never resurrects a dismissed row.
  assert.equal(store.setNotificationState("u_owner", id, "read")?.state, "dismissed");
  assert.equal(store.notificationsFor("u_owner").length, 0);
  assert.equal(store.notificationsFor("u_owner", { includeDismissed: true })[0].state, "dismissed");
});

test("read and dismiss survive a real relay reconnect", async () => {
  const { relay, url, owner, general } = await stand("notifications-reconnect.db");
  const { guest, me } = await inviteGuest(owner, url);
  let reconnect: TestClient | undefined;
  try {
    const token = guest.frames.find(
      (frame): frame is Extract<import("@cloud9/shared").ServerFrame, { type: "token" }> => frame.type === "token",
    )?.token;
    assert.ok(token, "invite redemption must return a durable token");

    const posted = await say(owner, general.id, `@${me.name} survives reconnect`);
    const notice = await guest.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "notificationUpdated" }>>(
      frame => frame.type === "notificationUpdated" && frame.entry.messageId === posted.message.id,
    );
    guest.send({ type: "markNotificationRead", notificationId: notice.entry.id });
    await guest.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "notificationUpdated" }>>(
      frame => frame.type === "notificationUpdated" && frame.entry.id === notice.entry.id && frame.entry.state === "read",
    );
    guest.close();

    reconnect = new TestClient(url, token);
    const welcome = await reconnect.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "welcome" }>>(
      frame => frame.type === "welcome",
    );
    assert.equal(
      (welcome.state.notifications ?? []).find(entry => entry.id === notice.entry.id)?.state,
      "read",
      "read state must survive reconnect",
    );

    reconnect.send({ type: "dismissNotification", notificationId: notice.entry.id });
    await reconnect.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "notificationUpdated" }>>(
      frame => frame.type === "notificationUpdated" && frame.entry.id === notice.entry.id && frame.entry.state === "dismissed",
    );
    reconnect.close();
    reconnect = new TestClient(url, token);
    const dismissedWelcome = await reconnect.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "welcome" }>>(
      frame => frame.type === "welcome",
    );
    assert.equal(
      (dismissedWelcome.state.notifications ?? []).some(entry => entry.id === notice.entry.id),
      false,
      "dismissed rows stay out of the default reconnect inbox",
    );
  } finally {
    guest.close(); reconnect?.close(); owner.close(); relay.close();
  }
});

test("recipient and source indexes do not leak rows across inboxes", () => {
  const { store } = setup();
  store.saveNotification(row({ id: "n-owner", recipientId: "u_owner" }));
  store.saveNotification(row({ id: "n-guest", recipientId: "u_guest" }));
  assert.deepEqual(store.notificationsFor("u_owner").map(n => n.id), ["n-owner"]);
  assert.deepEqual(store.notificationsFor("u_guest").map(n => n.id), ["n-guest"]);
  assert.deepEqual(store.notificationsForMessage("m1").map(n => n.id).sort(), ["n-guest", "n-owner"]);
  assert.deepEqual(store.notificationsForChannel("ch_general").map(n => n.id).sort(), ["n-guest", "n-owner"]);
});

test("retention removes old read rows first, caps history, and preserves unread", () => {
  const { store } = setup();
  const now = Date.now();
  const old = now - NOTIFICATION_INBOX_LIMITS.maxAgeMs - 1;
  store.saveNotification(row({ id: "old-read", createdAt: old, state: "read" }));
  store.saveNotification(row({ id: "old-unread", createdAt: old, state: "unread" }));
  assert.equal(store.notificationsFor("u_owner", { includeDismissed: true }).some(n => n.id === "old-read"), false);
  assert.equal(store.notificationsFor("u_owner", { includeDismissed: true }).some(n => n.id === "old-unread"), true);

  for (let i = 0; i < NOTIFICATION_INBOX_LIMITS.maxEntries + 10; i++) {
    store.saveNotification(row({ id: `history-${i}`, createdAt: now + i, state: "read" }));
  }
  const rows = store.notificationsFor("u_owner", { includeDismissed: true, limit: NOTIFICATION_INBOX_LIMITS.maxEntries });
  assert.ok(rows.length <= NOTIFICATION_INBOX_LIMITS.maxEntries);
  const retainedRead = store.db.prepare(
    "SELECT COUNT(*) n FROM notification_inbox WHERE recipientId=? AND state<>'unread'",
  ).get("u_owner") as { n: number };
  assert.ok(retainedRead.n <= NOTIFICATION_INBOX_LIMITS.maxEntries,
    "the per-recipient cap applies to retained read/dismissed history");
  assert.equal(store.db.prepare(
    "SELECT id FROM notification_inbox WHERE recipientId=? AND id=?",
  ).get("u_owner", "history-0"), undefined,
  "oldest retained history is pruned first");
  const preserved = store.db.prepare(
    "SELECT id FROM notification_inbox WHERE recipientId=? AND id=?",
  ).get("u_owner", "old-unread") as { id?: string } | undefined;
  assert.equal(preserved?.id, "old-unread", "unread rows are never silently discarded by the cap");
});

test("relay derives mention rows and re-projects edits and tombstones", async () => {
  const { relay, url, owner, general } = await stand("notifications-mention.db");
  const { guest, me } = await inviteGuest(owner, url);
  try {
    owner.frames.length = 0;
    guest.frames.length = 0;
    const posted = await say(owner, general.id, `@${me.name} please read this`);
    const first = await guest.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "notificationUpdated" }>>(
      frame => frame.type === "notificationUpdated" && frame.entry.kind === "mention");
    assert.equal(first.entry.sourceState, "active");
    assert.equal(first.entry.messageId, posted.message.id);
    assert.equal(first.entry.channelId, general.id);

    guest.frames.length = 0;
    owner.send({ type: "editMessage", messageId: posted.message.id, text: `@${me.name} edited` });
    const edited = await guest.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "notificationUpdated" }>>(
      frame => frame.type === "notificationUpdated" && frame.entry.id === first.entry.id);
    assert.equal(edited.entry.sourceState, "active");
    assert.equal(edited.entry.body, `@${me.name} edited`);

    guest.frames.length = 0;
    owner.send({ type: "deleteMessage", messageId: posted.message.id });
    const deleted = await guest.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "notificationUpdated" }>>(
      frame => frame.type === "notificationUpdated" && frame.entry.id === first.entry.id);
    assert.equal(deleted.entry.sourceState, "deleted");
    assert.equal(deleted.entry.body, "This message was deleted.");
    assert.equal(deleted.entry.messageId, undefined, "deleted sources cannot be jumped into");
  } finally {
    guest.close(); owner.close(); relay.close();
  }
});

test("relay follows thread participant timing and does not notify a new participant retroactively", async () => {
  const { relay, url, owner, general } = await stand("notifications-thread.db");
  const { guest } = await inviteGuest(owner, url);
  try {
    const root = await say(owner, general.id, "thread root");
    owner.frames.length = 0;
    guest.frames.length = 0;
    const first = await say(guest, general.id, "first reply", root.message.id);
    const ownerNotice = await owner.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "notificationUpdated" }>>(
      frame => frame.type === "notificationUpdated" && frame.entry.kind === "thread_reply");
    assert.equal(ownerNotice.entry.messageId, first.message.id);
    assert.equal(guest.frames.some(frame => frame.type === "notificationUpdated"), false,
      "the author of a reply is not notified about their own reply");

    owner.frames.length = 0;
    guest.frames.length = 0;
    const second = await say(owner, general.id, "second reply", root.message.id);
    const guestNotice = await guest.wait<Extract<import("@cloud9/shared").ServerFrame, { type: "notificationUpdated" }>>(
      frame => frame.type === "notificationUpdated" && frame.entry.kind === "thread_reply");
    assert.equal(guestNotice.entry.messageId, second.message.id);
    assert.equal(owner.frames.some(frame => frame.type === "notificationUpdated" && frame.entry.messageId === second.message.id), false,
      "a thread author is not notified about their own reply");
  } finally {
    guest.close(); owner.close(); relay.close();
  }
});
