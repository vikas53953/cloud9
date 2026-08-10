import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { Relay } from "./server.js";
import { Store } from "./store.js";
import { ATTACHMENT_LIMITS } from "@cloud9/shared";
import type { Attachment, ChatDraft, ClientFrame, ServerFrame } from "@cloud9/shared";

function db(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "c9-draft-")), "hub.db");
}

class Client {
  ws: WebSocket;
  frames: ServerFrame[] = [];
  constructor(url: string, token: string) {
    this.ws = new WebSocket(url);
    this.ws.on("open", () => this.send({ type: "hello", token, client: "desktop" }));
    this.ws.on("message", raw => this.frames.push(JSON.parse(String(raw)) as ServerFrame));
  }
  send(frame: ClientFrame): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
    else this.ws.once("open", () => this.ws.send(JSON.stringify(frame)));
  }
  async wait(pred: (frame: ServerFrame) => boolean): Promise<ServerFrame> {
    const existing = this.frames.find(pred);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
      const end = setTimeout(() => reject(new Error("draft frame timeout")), 4_000);
      const timer = setInterval(() => {
        const found = this.frames.find(pred);
        if (found) { clearInterval(timer); clearTimeout(end); resolve(found); }
      }, 10);
    });
  }
  close(): void { this.ws.close(); }
}

test("durable drafts survive reconnect, reject request-id conflicts, and clear on accepted send", async () => {
  const relay = new Relay({ dbPath: db(), ownerToken: "draft-owner" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const first = new Client(url, "draft-owner");
  const welcome = await first.wait(f => f.type === "welcome") as Extract<ServerFrame, { type: "welcome" }>;
  const channel = welcome.state.channels[0];
  first.send({ type: "send", requestId: "root-r1", channelId: channel.id, text: "thread root" });
  const rootFrame = await first.wait(f => f.type === "message" && f.requestId === "root-r1") as Extract<ServerFrame, { type: "message" }>;
  const root = rootFrame.message;
  first.send({ type: "uploadAttachment", channelId: channel.id, name: "draft.txt", dataBase64: Buffer.from("draft").toString("base64"), mime: "text/plain" });
  const uploaded = await first.wait(f => f.type === "attachment") as Extract<ServerFrame, { type: "attachment" }>;
  const a = uploaded.attachment;
  first.send({ type: "draftUpdate", requestId: "draft-r1", channelId: channel.id, text: "parked text", attachments: [{ id: a.id, name: a.name, size: a.size, uploadedAt: a.uploadedAt, expiresAt: a.uploadedAt + 86_400_000, state: "available" }] });
  const changed = await first.wait(f => f.type === "draftChanged" && f.requestId === "draft-r1") as Extract<ServerFrame, { type: "draftChanged" }>;
  assert.equal(changed.draft.text, "parked text");
  assert.equal(changed.draft.attachments[0].state, "available");
  // A lost acknowledgement may be retried after the parked row/bytes have
  // disappeared. The request fingerprint is the client's intent, not the
  // relay's mutable availability projection, so this remains an idempotent
  // replay and truthfully reports the attachment as unavailable.
  first.frames.length = 0;
  relay.store.db.prepare("DELETE FROM attachments WHERE id=?").run(a.id);
  first.send({ type: "draftUpdate", requestId: "draft-r1", channelId: channel.id, text: "parked text", attachments: [{ id: a.id, name: a.name, size: a.size, uploadedAt: a.uploadedAt, expiresAt: a.uploadedAt + 86_400_000, state: "available" }] });
  const replayed = await first.wait(f => f.type === "draftChanged" && f.requestId === "draft-r1") as Extract<ServerFrame, { type: "draftChanged" }>;
  assert.equal(replayed.draft.text, "parked text");
  assert.equal(replayed.draft.attachments[0].state, "unavailable");
  relay.store.saveAttachment(a, channel.id);
  first.send({ type: "send", requestId: "child-r1", channelId: channel.id, replyTo: root.id, text: "child" });
  const child = await first.wait(f => f.type === "message" && f.requestId === "child-r1") as Extract<ServerFrame, { type: "message" }>;
  first.send({ type: "draftUpdate", requestId: "draft-thread-r1", channelId: channel.id, threadId: root.id, replyTo: root.id, text: "thread-only text", attachments: [] });
  const threadChanged = await first.wait(f => f.type === "draftChanged" && f.requestId === "draft-thread-r1") as Extract<ServerFrame, { type: "draftChanged" }>;
  assert.equal(threadChanged.draft.threadId, root.id);
  assert.equal(threadChanged.draft.text, "thread-only text");
  first.send({ type: "draftReclaim", requestId: "draft-child-reclaim", channelId: channel.id, threadId: child.message.id });
  const canonicalReclaim = await first.wait(f => f.type === "draftChanged" && f.requestId === "draft-child-reclaim") as Extract<ServerFrame, { type: "draftChanged" }>;
  assert.equal(canonicalReclaim.draft.threadId, root.id, "reply-child scope resolves to the root draft");
  first.send({ type: "draftList", requestId: "draft-thread-unscoped", threadId: root.id });
  const unscoped = await first.wait(f => f.type === "error" && f.requestId === "draft-thread-unscoped") as Extract<ServerFrame, { type: "error" }>;
  assert.match(unscoped.error, /thread draft needs its channel/);
  first.send({ type: "draftReconcile", requestId: "draft-reconcile-unscoped", threadId: root.id });
  const unscopedReconcile = await first.wait(f => f.type === "error" && f.requestId === "draft-reconcile-unscoped") as Extract<ServerFrame, { type: "error" }>;
  assert.match(unscopedReconcile.error, /thread draft needs its channel/);
  first.send({ type: "draftUpdate", requestId: "draft-r1", channelId: channel.id, text: "different", attachments: [] });
  const conflict = await first.wait(f => f.type === "error" && f.requestId === "draft-r1");
  assert.match((conflict as Extract<ServerFrame, { type: "error" }>).error, /already used/);
  first.close();
  const second = new Client(url, "draft-owner");
  await second.wait(f => f.type === "welcome");
  second.send({ type: "draftReconcile", requestId: "draft-r2" });
  const listed = await second.wait(f => f.type === "drafts" && f.requestId === "draft-r2") as Extract<ServerFrame, { type: "drafts" }>;
  assert.equal(listed.drafts.length, 2);
  assert.equal(listed.drafts.find(d => !d.threadId)?.attachments[0].state, "available");
  assert.equal(listed.drafts.find(d => d.threadId)?.text, "thread-only text");
  // The accepted send carries the same intent as the room draft. A newer
  // concurrent draft is covered below; only this matching row may be removed.
  second.send({ type: "send", requestId: "send-r1", channelId: channel.id, text: "parked text", attachmentIds: [a.id] });
  const message = await second.wait(f => f.type === "message" && f.requestId === "send-r1");
  assert.equal(message.type, "message");
  const removed = await second.wait(f => f.type === "draftRemoved" && f.channelId === channel.id);
  assert.equal(removed.type, "draftRemoved");
  second.send({ type: "draftList", requestId: "draft-after-send", channelId: channel.id });
  const afterSend = await second.wait(f => f.type === "drafts" && f.requestId === "draft-after-send") as Extract<ServerFrame, { type: "drafts" }>;
  assert.equal(afterSend.drafts.length, 1);
  assert.equal(afterSend.drafts[0].threadId, root.id);
  second.send({ type: "draftList", requestId: "draft-thread-r2", channelId: channel.id, threadId: root.id });
  const threadListed = await second.wait(f => f.type === "drafts" && f.requestId === "draft-thread-r2") as Extract<ServerFrame, { type: "drafts" }>;
  assert.equal(threadListed.drafts.length, 1);
  assert.equal(threadListed.drafts[0].text, "thread-only text");
  second.send({ type: "draftRemove", requestId: "draft-remove-r1", channelId: channel.id, threadId: root.id });
  const removedThread = await second.wait(f => f.type === "draftRemoved" && f.requestId === "draft-remove-r1") as Extract<ServerFrame, { type: "draftRemoved" }>;
  assert.equal(removedThread.threadId, root.id);
  second.close();
  await relay.close();
});

test("lost send acknowledgement replays one canonical message and keeps the claim atomic", async () => {
  const relay = new Relay({ dbPath: db(), ownerToken: "send-receipt-owner" });
  const port = await relay.listen(0);
  const client = new Client(`ws://127.0.0.1:${port}`, "send-receipt-owner");
  const welcome = await client.wait(f => f.type === "welcome") as Extract<ServerFrame, { type: "welcome" }>;
  const channel = welcome.state.channels[0];
  client.send({ type: "uploadAttachment", channelId: channel.id, name: "receipt.txt", dataBase64: Buffer.from("receipt").toString("base64") });
  const uploaded = await client.wait(f => f.type === "attachment") as Extract<ServerFrame, { type: "attachment" }>;
  const a = uploaded.attachment;
  client.send({ type: "draftUpdate", requestId: "send-draft", channelId: channel.id, text: "receipt", attachments: [{
    id: a.id, name: a.name, size: a.size, uploadedAt: a.uploadedAt,
    expiresAt: a.uploadedAt + ATTACHMENT_LIMITS.parkedTtlMs, state: "available",
  }] });
  await client.wait(f => f.type === "draftChanged" && f.requestId === "send-draft");
  client.send({ type: "send", requestId: "send-first", clientMessageId: "stable-send-1", channelId: channel.id,
    text: "receipt", attachmentIds: [a.id] });
  const first = await client.wait(f => f.type === "message" && f.requestId === "send-first") as Extract<ServerFrame, { type: "message" }>;
  // The first response is discarded to model a lost acknowledgement. The
  // retry uses a new transport request id but the same durable client intent.
  client.frames.length = 0;
  client.send({ type: "send", requestId: "send-retry", clientMessageId: "stable-send-1", channelId: channel.id,
    text: "receipt", attachmentIds: [a.id] });
  const replay = await client.wait(f => f.type === "message" && f.requestId === "send-retry") as Extract<ServerFrame, { type: "message" }>;
  assert.equal(replay.message.id, first.message.id);
  assert.equal(relay.store.history(channel.id, {}, 100).items.filter(m => m.id === first.message.id).length, 1);
  assert.equal(relay.store.attachment(a.id)?.messageId, first.message.id);
  assert.equal(relay.store.chatDraft(welcome.state.me.id, channel.id), undefined);
  client.close(); await relay.close();
});

test("account cleanup removes draft rows, receipts, and parked bytes", () => {
  const store = new Store(db(), { ownerToken: "cleanup-owner" });
  const owner = store.ensureOwner("Cleanup", "cleanup-owner");
  const storedAs = store.writeAttachmentBytes("at_cleanup", "cleanup.txt", Buffer.from("parked"));
  const attachment: Attachment = {
    id: "at_cleanup", name: "cleanup.txt", size: 6, storedAs,
    uploadedBy: owner.id, uploadedAt: Date.now(), mime: "text/plain",
  };
  store.saveAttachment(attachment, "channel-cleanup");
  const draft: ChatDraft = {
    id: store.draftId(owner.id, "channel-cleanup"), channelId: "channel-cleanup",
    text: "keep me only until account removal", attachments: [{
      id: attachment.id, name: attachment.name, size: attachment.size,
      mime: attachment.mime, uploadedAt: attachment.uploadedAt,
      expiresAt: attachment.uploadedAt + 86_400_000, state: "available",
    }], updatedAt: Date.now(), expiresAt: Date.now() + 86_400_000, state: "active",
  };
  store.saveChatDraft(owner.id, draft, "cleanup-draft-r1");
  assert.ok(store.chatDraft(owner.id, draft.channelId));
  assert.ok(store.attachment(attachment.id));
  assert.ok(fs.existsSync(path.join(store.attachmentsDir, storedAs)));
  store.removeUser(owner.id);
  assert.equal(store.chatDraft(owner.id, draft.channelId), undefined);
  assert.equal(store.attachment(attachment.id), undefined);
  assert.equal(fs.existsSync(path.join(store.attachmentsDir, storedAs)), false);
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM draft_mutation_receipts WHERE userId=?").get(owner.id) as { n: number }).n, 0);
  store.db.close();
});

test("draft removal preserves shared parked bytes, then releases the last reference", () => {
  const store = new Store(db(), { ownerToken: "shared-owner" });
  const owner = store.ensureOwner("Shared", "shared-owner");
  const uploadedAt = Date.now();
  const storedAs = store.writeAttachmentBytes("at_shared", "shared.txt", Buffer.from("shared"));
  store.saveAttachment({ id: "at_shared", name: "shared.txt", size: 6, storedAs, uploadedBy: owner.id, uploadedAt }, "channel-shared");
  const attachment = { id: "at_shared", name: "shared.txt", size: 6, uploadedAt, expiresAt: uploadedAt + 86_400_000, state: "available" as const };
  const expired = Date.now() - 1_000;
  for (const [threadId, requestId] of [[undefined, "shared-r1"], ["thread-shared", "shared-r2"]] as const) {
    store.saveChatDraft(owner.id, {
      id: store.draftId(owner.id, "channel-shared", threadId), channelId: "channel-shared", ...(threadId ? { threadId } : {}),
      text: "shared", attachments: [attachment], updatedAt: expired, expiresAt: expired, state: "active",
    }, requestId);
  }
  store.removeChatDraft(owner.id, "channel-shared");
  assert.ok(store.attachment("at_shared"));
  assert.ok(fs.existsSync(path.join(store.attachmentsDir, storedAs)));
  store.sweepChatDrafts(Date.now());
  assert.equal(store.attachment("at_shared"), undefined);
  assert.equal(fs.existsSync(path.join(store.attachmentsDir, storedAs)), false);
  store.db.close();
});

test("reclaiming away an attachment releases its unreferenced parked bytes immediately", () => {
  const store = new Store(db(), { ownerToken: "reclaim-owner" });
  const owner = store.ensureOwner("Reclaim", "reclaim-owner");
  const storedAs = store.writeAttachmentBytes("at_reclaim", "reclaim.txt", Buffer.from("reclaim"));
  const uploadedAt = Date.now();
  store.saveAttachment({ id: "at_reclaim", name: "reclaim.txt", size: 7, storedAs, uploadedBy: owner.id, uploadedAt }, "channel-reclaim");
  const draft = { id: store.draftId(owner.id, "channel-reclaim"), channelId: "channel-reclaim", text: "keep", attachments: [{ id: "at_reclaim", name: "reclaim.txt", size: 7, uploadedAt, expiresAt: uploadedAt + 86_400_000, state: "available" as const }], updatedAt: uploadedAt, expiresAt: uploadedAt + 86_400_000, state: "active" as const };
  store.saveChatDraft(owner.id, draft, "reclaim-r1");
  store.reclaimChatDraftAttachments(owner.id, { ...draft, attachments: [] }, "reclaim-r2");
  assert.equal(store.attachment("at_reclaim"), undefined);
  assert.equal(fs.existsSync(path.join(store.attachmentsDir, storedAs)), false);
  store.db.close();
});

test("v12 databases migrate durable drafts on reopen", () => {
  const dbPath = db();
  const old = new Store(dbPath, { ownerToken: "migration-owner" });
  old.db.prepare("UPDATE meta SET value='12' WHERE key='schemaVersion'").run();
  old.db.close();
  const reopened = new Store(dbPath, { ownerToken: "migration-owner" });
  assert.equal(reopened.schemaVersion(), 14);
  assert.deepEqual(reopened.chatDrafts("missing-user"), []);
  reopened.db.close();
});

test("failed attachment claim rolls back the message, claims, and draft across reopen", () => {
  const dbPath = db();
  const store = new Store(dbPath, { ownerToken: "claim-owner" });
  const owner = store.ensureOwner("Claim", "claim-owner");
  const storedAs = store.writeAttachmentBytes("at_claim", "claim.txt", Buffer.from("claim"));
  const uploadedAt = Date.now();
  store.saveAttachment({ id: "at_claim", name: "claim.txt", size: 5, storedAs, uploadedBy: owner.id, uploadedAt }, "channel-claim");
  store.saveChatDraft(owner.id, { id: store.draftId(owner.id, "channel-claim"), channelId: "channel-claim", text: "claim", attachments: [{ id: "at_claim", name: "claim.txt", size: 5, uploadedAt, expiresAt: uploadedAt + 86_400_000, state: "available" }], updatedAt: uploadedAt, expiresAt: uploadedAt + 86_400_000, state: "active" }, "claim-draft-r1");
  const message = { id: "m-claim", channelId: "channel-claim", authorId: owner.id, authorName: owner.name, authorKind: "human" as const, text: "claim", ts: Date.now() };
  assert.throws(() => store.saveMessageAndRemoveDraft(message, owner.id, undefined, ["at_claim", "missing-claim"]), /no longer available/);
  assert.equal(store.message(message.id), undefined);
  assert.equal(store.attachment("at_claim")?.messageId, undefined);
  assert.ok(store.chatDraft(owner.id, "channel-claim"));
  store.db.close();
  const reopened = new Store(dbPath, { ownerToken: "claim-owner" });
  assert.equal(reopened.message(message.id), undefined);
  assert.equal(reopened.attachment("at_claim")?.messageId, undefined);
  assert.ok(reopened.chatDraft(owner.id, "channel-claim"));
  reopened.db.close();
});

test("accepted send preserves a newer draft saved by another window", () => {
  const store = new Store(db(), { ownerToken: "newer-draft-owner" });
  const owner = store.ensureOwner("Newer draft", "newer-draft-owner");
  const channelId = "channel-newer-draft";
  const original = {
    id: store.draftId(owner.id, channelId), channelId, text: "first intent", attachments: [],
    updatedAt: 100, expiresAt: 86_400_100, state: "active" as const,
  };
  store.saveChatDraft(owner.id, original, "window-a-draft");
  // Model a second window winning the draft write just before the send
  // transaction reads the current row.
  const newer = { ...original, text: "newer intent", attachments: [{
    id: "at-newer", name: "newer.txt", size: 6, uploadedAt: 200,
    expiresAt: 86_400_200, state: "available" as const,
  }], updatedAt: 200, expiresAt: 86_400_200 };
  store.saveChatDraft(owner.id, newer, "window-b-draft");
  const message = {
    id: "m-newer-draft", channelId, authorId: owner.id, authorName: owner.name,
    authorKind: "human" as const, text: original.text, ts: Date.now(),
  };
  const saved = store.saveMessageAndRemoveDraft(message, owner.id, undefined, [], "stable-newer-draft", store.messageSendHash(channelId, original.text, undefined, []));
  assert.equal(saved.replayed, false);
  assert.equal(saved.draftRemoved, false);
  assert.equal(store.message(message.id)?.text, original.text);
  assert.equal(store.chatDraft(owner.id, channelId)?.text, newer.text);
  assert.equal(store.chatDraft(owner.id, channelId)?.attachments[0]?.id, "at-newer");
  store.db.close();
});

test("send refuses missing, future-dated, and expired parked bytes", async () => {
  const relay = new Relay({ dbPath: db(), ownerToken: "attachment-validity-owner" });
  const port = await relay.listen(0);
  const client = new Client(`ws://127.0.0.1:${port}`, "attachment-validity-owner");
  const welcome = await client.wait(f => f.type === "welcome") as Extract<ServerFrame, { type: "welcome" }>;
  const channel = welcome.state.channels[0];
  const upload = async (name: string): Promise<Attachment> => {
    client.frames.length = 0;
    client.send({ type: "uploadAttachment", channelId: channel.id, name, dataBase64: Buffer.from(name).toString("base64"), mime: "text/plain" });
    return (await client.wait(f => f.type === "attachment") as Extract<ServerFrame, { type: "attachment" }>).attachment;
  };
  const missing = await upload("missing.txt");
  relay.store.removeAttachmentBytes(missing.storedAs);
  client.send({ type: "send", requestId: "missing-send", channelId: channel.id, text: "missing", attachmentIds: [missing.id] });
  await client.wait(f => f.type === "error" && f.requestId === "missing-send");
  assert.equal(relay.store.attachment(missing.id), undefined);

  const future = await upload("future.txt");
  const futureAt = Date.now() + 86_400_000;
  relay.store.db.prepare("UPDATE attachments SET uploadedAt=?,json=? WHERE id=?")
    .run(futureAt, JSON.stringify({ ...future, uploadedAt: futureAt }), future.id);
  client.send({ type: "send", requestId: "future-send", channelId: channel.id, text: "future", attachmentIds: [future.id] });
  const futureRefusal = await client.wait(f => f.type === "error" && f.requestId === "future-send") as Extract<ServerFrame, { type: "error" }>;
  assert.match(futureRefusal.error, /not available yet/);
  assert.equal(relay.store.attachment(future.id), undefined);

  const expired = await upload("expired.txt");
  const expiredAt = Date.now() - ATTACHMENT_LIMITS.parkedTtlMs - 1;
  relay.store.db.prepare("UPDATE attachments SET uploadedAt=?,json=? WHERE id=?")
    .run(expiredAt, JSON.stringify({ ...expired, uploadedAt: expiredAt }), expired.id);
  client.send({ type: "send", requestId: "expired-send", channelId: channel.id, text: "expired", attachmentIds: [expired.id] });
  await client.wait(f => f.type === "error" && f.requestId === "expired-send");
  assert.equal(relay.store.attachment(expired.id), undefined);
  client.close(); await relay.close();
});

test("future-dated parked uploads project unavailable before send", async () => {
  const relay = new Relay({ dbPath: db(), ownerToken: "future-projection-owner" });
  const port = await relay.listen(0);
  const client = new Client(`ws://127.0.0.1:${port}`, "future-projection-owner");
  const welcome = await client.wait(f => f.type === "welcome") as Extract<ServerFrame, { type: "welcome" }>;
  const channel = welcome.state.channels[0];
  client.send({ type: "uploadAttachment", channelId: channel.id, name: "future-draft.txt", dataBase64: Buffer.from("future").toString("base64") });
  const uploaded = await client.wait(f => f.type === "attachment") as Extract<ServerFrame, { type: "attachment" }>;
  const futureAt = Date.now() + 60_000;
  relay.store.db.prepare("UPDATE attachments SET uploadedAt=?,json=? WHERE id=?")
    .run(futureAt, JSON.stringify({ ...uploaded.attachment, uploadedAt: futureAt }), uploaded.attachment.id);
  client.send({ type: "draftUpdate", requestId: "future-draft", channelId: channel.id, text: "future", attachments: [{
    ...uploaded.attachment, uploadedAt: futureAt,
    expiresAt: futureAt + ATTACHMENT_LIMITS.parkedTtlMs, state: "available",
  }] });
  const changed = await client.wait(f => f.type === "draftChanged" && f.requestId === "future-draft") as Extract<ServerFrame, { type: "draftChanged" }>;
  assert.equal(changed.draft.attachments[0].state, "unavailable");
  client.close(); await relay.close();
});

test("draft sweep expires its mutation receipts before a same-id retry", () => {
  const store = new Store(db(), { ownerToken: "expiry-owner" });
  const owner = store.ensureOwner("Expiry", "expiry-owner");
  const original = store.saveChatDraft(owner.id, {
    id: store.draftId(owner.id, "channel-expiry"), channelId: "channel-expiry", text: "expire me", attachments: [],
    updatedAt: Date.now(), expiresAt: Date.now() + 86_400_000, state: "active",
  }, "expiry-r1");
  store.db.prepare("UPDATE chat_drafts SET updatedAt=0,expiresAt=0 WHERE userId=? AND channelId=?").run(owner.id, "channel-expiry");
  store.sweepChatDrafts(Date.now());
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM draft_mutation_receipts WHERE userId=? AND requestId=?").get(owner.id, "expiry-r1") as { n: number }).n, 0);
  const retried = store.saveChatDraft(owner.id, { ...original, updatedAt: 0, expiresAt: 0 }, "expiry-r1");
  assert.ok(retried.updatedAt > original.updatedAt, "retry is a fresh update, never a stale-result resurrection");
  store.db.close();
});

test("room access gates draft listing and mutation after membership removal", async () => {
  const relay = new Relay({ dbPath: db(), ownerToken: "access-owner" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new Client(url, "access-owner");
  const welcome = await owner.wait(f => f.type === "welcome") as Extract<ServerFrame, { type: "welcome" }>;
  const channel = welcome.state.channels[0];
  owner.send({ type: "createInvite" });
  const invite = await owner.wait(f => f.type === "invite") as Extract<ServerFrame, { type: "invite" }>;
  const guest = new Client(url, `invite:${invite.code}:Guest`);
  const guestWelcome = await guest.wait(f => f.type === "welcome") as Extract<ServerFrame, { type: "welcome" }>;
  owner.send({ type: "addMembers", channelId: channel.id, memberIds: [guestWelcome.state.me.id] });
  await owner.wait(f => f.type === "channel" && f.channel.id === channel.id && f.channel.memberIds.includes(guestWelcome.state.me.id));
  guest.send({ type: "draftUpdate", requestId: "access-draft-r1", channelId: channel.id, text: "private draft", attachments: [] });
  await guest.wait(f => f.type === "draftChanged" && f.requestId === "access-draft-r1");
  owner.send({ type: "removeMember", channelId: channel.id, memberId: guestWelcome.state.me.id });
  await owner.wait(f => f.type === "channel" && f.channel.id === channel.id && !f.channel.memberIds.includes(guestWelcome.state.me.id));
  guest.send({ type: "draftList", requestId: "access-list-r1", channelId: channel.id });
  const deniedList = await guest.wait(f => f.type === "error" && f.requestId === "access-list-r1") as Extract<ServerFrame, { type: "error" }>;
  assert.match(deniedList.error, /no such channel|not in|conversation/);
  guest.send({ type: "draftReclaim", requestId: "access-reclaim-r1", channelId: channel.id });
  const deniedReclaim = await guest.wait(f => f.type === "error" && f.requestId === "access-reclaim-r1") as Extract<ServerFrame, { type: "error" }>;
  assert.match(deniedReclaim.error, /no such channel|not in|conversation/);
  guest.send({ type: "draftRemove", requestId: "access-remove-r1", channelId: channel.id });
  const deniedRemove = await guest.wait(f => f.type === "error" && f.requestId === "access-remove-r1") as Extract<ServerFrame, { type: "error" }>;
  assert.match(deniedRemove.error, /no such channel|not in|conversation/);
  guest.close(); owner.close(); await relay.close();
});
