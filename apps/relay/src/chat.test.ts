// The chat basics — scrollback, search, reactions, edit/delete, threads,
// attachments, read state — plus the two rules the Buzz teardown said we were
// missing: who may drive an agent, and an audit trail that is a ledger.
//
// Every test here failed before the change it covers landed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { AgentDef, Message, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { SCHEMA_VERSION } from "./store.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
};

/** A relay with the owner signed in and #general to hand. */
async function stand(name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const general = welcome.state.channels.find(c => c.name === "general")!;
  return { relay, url, owner, general, me: welcome.state.me };
}

async function invite(owner: TestClient, notCode?: string): Promise<string> {
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(
    f => f.type === "invite" && f.code !== notCode);
  return inv.code;
}

/** Bring a guest in and put them in the given channel. */
async function bringIn(relay: Relay, url: string, owner: TestClient, name: string, channelId: string, notCode?: string) {
  const code = await invite(owner, notCode);
  const guest = new TestClient(url, `invite:${code}:${name}`);
  const w = await guest.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "addMembers", channelId, memberIds: [w.state.me.id] });
  await owner.wait(f => f.type === "channel" && f.channel.id === channelId
    && f.channel.memberIds.includes(w.state.me.id));
  return { guest, me: w.state.me, code };
}

/** Say `text` and wait until it is really stored. */
async function say(client: TestClient, channelId: string, text: string): Promise<Message> {
  client.send({ type: "send", channelId, text });
  const f = await client.wait<Extract<ServerFrame, { type: "message" }>>(
    x => x.type === "message" && x.message.text === text);
  return f.message;
}

test("human typing is membership-scoped, request-independent, debounced, and ephemeral", async () => {
  const { relay, url, owner, general, me } = await stand("chat-typing.db");
  const { guest, me: guestMe, code: usedCode } = await bringIn(relay, url, owner, "Priya", general.id);
  // General is intentionally shared with every newly invited user. Exercise a
  // private room instead, so the outsider assertion proves current membership.
  owner.send({ type: "createChannel", name: "typing-private", memberIds: [guestMe.id], kind: "channel" });
  const privateRoom = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "typing-private");
  const ownerTyping = { type: "typing" as const, channelId: privateRoom.channel.id, typing: true };
  owner.frames.length = 0;
  guest.frames.length = 0;
  owner.send(ownerTyping);
  const first = await guest.wait<Extract<ServerFrame, { type: "typing" }>>(
    f => f.type === "typing" && f.typing.typing);
  assert.equal(first.typing.userId, me.id);
  assert.equal(first.typing.userName, "Vikas");
  assert.ok((first.typing.expiresAt ?? 0) > Date.now());
  assert.equal(JSON.stringify(first).includes("requestId"), false,
    "typing broadcasts are not request answers");

  // A second keydown inside the debounce window renews the relay TTL but does
  // not create a second broadcast frame.
  const before = guest.frames.filter(f => f.type === "typing" && f.typing.typing).length;
  owner.send(ownerTyping);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(guest.frames.filter(f => f.type === "typing" && f.typing.typing).length, before);

  owner.send({ type: "typing", channelId: privateRoom.channel.id, typing: false });
  const stopped = await guest.wait<Extract<ServerFrame, { type: "typing" }>>(
    f => f.type === "typing" && !f.typing.typing);
  assert.equal(stopped.typing.userId, first.typing.userId);

  // An unjoined person cannot make the relay invent a room-scoped signal.
  const inviteCode = await invite(owner, usedCode);
  const outsider = new TestClient(url, `invite:${inviteCode}:Outsider`);
  await outsider.wait(f => f.type === "welcome");
  outsider.send(ownerTyping);
  const refused = await outsider.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(refused.error, /no such channel/);

  // The signal never appears in durable history (there is no typing table or
  // message row for it).
  assert.equal(relay.store.history(privateRoom.channel.id, {}, 50).items.some(m => m.text === "typing"), false);
  outsider.close(); guest.close(); owner.close(); relay.close();
});

test("one window cannot stop another window of the same person from typing", async () => {
  const { relay, url, owner, general } = await stand("chat-typing-windows.db");
  const { guest, me: guestMe } = await bringIn(relay, url, owner, "Priya", general.id);
  owner.send({ type: "createChannel", name: "typing-windows", memberIds: [guestMe.id], kind: "channel" });
  const room = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "typing-windows");
  const mirror = new TestClient(url, "tok-owner");
  await mirror.wait(f => f.type === "welcome");
  const typing = { type: "typing" as const, channelId: room.channel.id, typing: true };
  owner.send(typing);
  await guest.wait(f => f.type === "typing" && f.typing.typing);
  mirror.send(typing);
  owner.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(guest.frames.some(f => f.type === "typing" && !f.typing.typing), false,
    "closing one source must not stop the same person's other window");
  mirror.send({ type: "typing", channelId: room.channel.id, typing: false });
  await guest.wait(f => f.type === "typing" && !f.typing.typing);
  mirror.close(); guest.close(); relay.close();
});

// ---------------------------------------------------------------------------
// 1. Scrollback
// ---------------------------------------------------------------------------

test("scrollback walks the whole conversation, once each, and says when it ends", async () => {
  const { relay, owner, general } = await stand("chat-history.db");

  // 120 messages is more than the 50 a client was ever given before
  for (let i = 0; i < 120; i++) await say(owner, general.id, `line ${i}`);

  const seen: string[] = [];
  let cursor: { before?: number; beforeId?: string } = {};
  let pages = 0;
  for (;;) {
    owner.frames.length = 0;
    owner.send({ type: "history", channelId: general.id, limit: 25, ...cursor });
    const page = await owner.wait<Extract<ServerFrame, { type: "history" }>>(f => f.type === "history");
    pages++;
    // oldest first, so a client can prepend a page without re-sorting
    const ts = page.messages.map(m => m.ts);
    assert.deepEqual(ts, [...ts].sort((a, b) => a - b), "a page must arrive oldest first");
    seen.push(...page.messages.map(m => m.id));
    if (!page.hasMore) break;
    assert.ok(page.nextBefore !== undefined && page.nextBeforeId !== undefined,
      "hasMore must come with the cursor to use");
    cursor = { before: page.nextBefore, beforeId: page.nextBeforeId };
    assert.ok(pages < 20, "paging did not terminate");
  }

  assert.equal(seen.length, 120, "every message was handed over exactly once");
  assert.equal(new Set(seen).size, 120, "a message was served twice across a page boundary");

  owner.close(); relay.close();
});

test("messages sharing one millisecond are not skipped at a page boundary", async () => {
  const { relay, owner, general } = await stand("chat-ties.db");

  // Write straight to the store so every row really does share a timestamp —
  // this is the case that ordering by `ts` alone gets wrong.
  const ts = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) {
    const id = `m_tie${String(i).padStart(2, "0")}`;
    ids.push(id);
    relay.store.saveMessage({
      id, channelId: general.id, authorId: "u1", authorName: "Vikas",
      authorKind: "human", text: `tie ${i}`, ts,
    });
  }

  const seen: string[] = [];
  let cursor: { before?: number; beforeId?: string } = {};
  for (;;) {
    owner.frames.length = 0;
    owner.send({ type: "history", channelId: general.id, limit: 3, ...cursor });
    const page = await owner.wait<Extract<ServerFrame, { type: "history" }>>(f => f.type === "history");
    seen.push(...page.messages.map(m => m.id));
    if (!page.hasMore) break;
    cursor = { before: page.nextBefore, beforeId: page.nextBeforeId };
  }
  assert.deepEqual([...seen].sort(), [...ids].sort(), "a tied message was skipped or repeated");

  owner.close(); relay.close();
});

test("scrollback obeys membership exactly as the opening frame does", async () => {
  const { relay, url, owner } = await stand("chat-history-scope.db");
  owner.send({ type: "createChannel", name: "money", memberIds: [], kind: "channel" });
  const room = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "money")).channel;
  await say(owner, room.id, "the bank password is hunter2");

  const code = await invite(owner);
  const raj = new TestClient(url, `invite:${code}:Raj`);
  await raj.wait(f => f.type === "welcome");

  raj.send({ type: "history", channelId: room.id, limit: 50 });
  const err = await raj.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /no such channel/);
  assert.ok(!raj.frames.some(f => f.type === "history"), "history came back to an outsider");

  raj.close(); owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// 2. Search
// ---------------------------------------------------------------------------

test("search finds old messages and never reaches a room you are not in", async () => {
  const { relay, url, owner, general } = await stand("chat-search.db");

  await say(owner, general.id, "the router in the loft keeps dropping");
  for (let i = 0; i < 60; i++) await say(owner, general.id, `filler ${i}`);

  owner.send({ type: "createChannel", name: "money", memberIds: [], kind: "channel" });
  const room = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "money")).channel;
  await say(owner, room.id, "the router password is hunter2");

  // 1. the owner finds both, with enough context to draw a row
  owner.frames.length = 0;
  owner.send({ type: "search", query: "router" });
  const mine = await owner.wait<Extract<ServerFrame, { type: "searchResults" }>>(f => f.type === "searchResults");
  assert.equal(mine.results.length, 2, "search only sees the last 50 messages");
  for (const hit of mine.results) {
    assert.ok(hit.channelName, "a result must name its conversation");
    assert.ok(hit.message.authorName, "a result must name its author");
    assert.ok(hit.message.ts > 0, "a result must carry its time");
    assert.ok(hit.snippet.length > 0, "a result must carry a snippet");
  }

  // 2. a guest who is only in #general finds only the #general one
  const { guest: raj } = await bringIn(relay, url, owner, "Raj", general.id);
  raj.frames.length = 0;
  raj.send({ type: "search", query: "router" });
  const his = await raj.wait<Extract<ServerFrame, { type: "searchResults" }>>(f => f.type === "searchResults");
  assert.equal(his.results.length, 1);
  assert.ok(!JSON.stringify(his.results).includes("hunter2"), "search leaked a private room");

  // 3. naming a room you are not in is refused, never quietly widened
  raj.frames.length = 0;
  raj.send({ type: "search", query: "router", channelId: room.id });
  const err = await raj.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /no such channel/);

  raj.close(); owner.close(); relay.close();
});

test("a search query is words, never search syntax", async () => {
  const { relay, owner, general } = await stand("chat-search-inject.db");
  await say(owner, general.id, "kettle");

  // Every one of these is an operator or a syntax error in raw FTS5. None may
  // crash the hub or mean anything but "look for these words".
  for (const q of ['" OR 1=1 --', "kettle NEAR toaster", "*", "kettle AND", "(((", '""']) {
    owner.frames.length = 0;
    owner.send({ type: "search", query: q });
    const f = await owner.wait<ServerFrame>(x => x.type === "searchResults" || x.type === "error");
    assert.equal(f.type, "searchResults", `query ${JSON.stringify(q)} broke search`);
  }

  owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// 3. Reactions
// ---------------------------------------------------------------------------

test("a reaction is stored, broadcast, and idempotent per person, message and emoji", async () => {
  const { relay, url, owner, general } = await stand("chat-react.db");
  const msg = await say(owner, general.id, "shipped it");
  const { guest: raj, me: rajUser } = await bringIn(relay, url, owner, "Raj", general.id);

  // pressing it three times is still one vote
  for (let i = 0; i < 3; i++) {
    owner.frames.length = 0;
    owner.send({ type: "react", messageId: msg.id, emoji: "👍" });
    const r = await owner.wait<Extract<ServerFrame, { type: "reaction" }>>(f => f.type === "reaction");
    assert.deepEqual(r.userIds.length, 1, "one person pressing twice must not be two votes");
  }

  // someone else in the room is told, and joins the same pill
  raj.frames.length = 0;
  raj.send({ type: "react", messageId: msg.id, emoji: "👍" });
  const both = await owner.wait<Extract<ServerFrame, { type: "reaction" }>>(
    f => f.type === "reaction" && f.userIds.length === 2);
  assert.ok(both.userIds.includes(rajUser.id));

  // taking it back removes exactly one vote, and doing so twice changes nothing
  raj.send({ type: "react", messageId: msg.id, emoji: "👍", on: false });
  await owner.wait<Extract<ServerFrame, { type: "reaction" }>>(
    f => f.type === "reaction" && f.userIds.length === 1 && !f.userIds.includes(rajUser.id));
  raj.send({ type: "react", messageId: msg.id, emoji: "👍", on: false });

  // and it survives a reload: reactions ride along with history
  owner.frames.length = 0;
  owner.send({ type: "history", channelId: general.id, limit: 50 });
  const page = await owner.wait<Extract<ServerFrame, { type: "history" }>>(f => f.type === "history");
  const stored = page.messages.find(m => m.id === msg.id)!;
  assert.deepEqual(stored.reactions, [{ emoji: "👍", userIds: [relay.ownerId] }]);

  raj.close(); owner.close(); relay.close();
});

test("an outsider cannot react to a message in a room they are not in", async () => {
  const { relay, url, owner } = await stand("chat-react-scope.db");
  owner.send({ type: "createChannel", name: "money", memberIds: [], kind: "channel" });
  const room = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "money")).channel;
  const msg = await say(owner, room.id, "hunter2");

  const code = await invite(owner);
  const raj = new TestClient(url, `invite:${code}:Raj`);
  await raj.wait(f => f.type === "welcome");
  raj.send({ type: "react", messageId: msg.id, emoji: "👍" });
  const err = await raj.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /no such channel/);
  assert.equal(relay.store.reactionsFor([msg.id]).size, 0);

  raj.close(); owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// 4. Edit and delete
// ---------------------------------------------------------------------------

test("only the author edits or deletes, and a delete is a tombstone", async () => {
  const { relay, url, owner, general } = await stand("chat-edit.db");
  const msg = await say(owner, general.id, "meet at 5pm");
  const { guest: raj } = await bringIn(relay, url, owner, "Raj", general.id);

  // 1. somebody else may not touch it
  raj.frames.length = 0;
  raj.send({ type: "editMessage", messageId: msg.id, text: "meet at 3am" });
  const denied = await raj.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /your own messages/);
  assert.equal(relay.store.message(msg.id)!.text, "meet at 5pm");

  raj.frames.length = 0;
  raj.send({ type: "deleteMessage", messageId: msg.id });
  await raj.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(!relay.store.message(msg.id)!.deletedAt);

  // 2. the author may, and the edit is marked and told to the room
  owner.frames.length = 0;
  owner.send({ type: "editMessage", messageId: msg.id, text: "meet at 6pm" });
  const edited = await raj.wait<Extract<ServerFrame, { type: "messageUpdated" }>>(
    f => f.type === "messageUpdated");
  assert.equal(edited.message.text, "meet at 6pm");
  assert.ok(edited.message.editedAt, "an edit must carry its marker");

  // 3. a delete leaves the row where it was, with nothing in it
  owner.send({ type: "deleteMessage", messageId: msg.id });
  const gone = await raj.wait<Extract<ServerFrame, { type: "messageUpdated" }>>(
    f => f.type === "messageUpdated" && !!f.message.deletedAt);
  assert.equal(gone.message.text, "");
  const row = relay.store.message(msg.id)!;
  assert.ok(row, "a deleted message must stay as a tombstone, not vanish");
  assert.ok(row.deletedAt);
  assert.equal(row.text, "");

  // 4. and it is gone from search, because there are no words left
  owner.frames.length = 0;
  owner.send({ type: "search", query: "meet" });
  const results = await owner.wait<Extract<ServerFrame, { type: "searchResults" }>>(
    f => f.type === "searchResults");
  assert.equal(results.results.length, 0);

  // 5. both actions are in the trail
  const trail = relay.store.activity(Date.now() + 1, 100);
  assert.ok(trail.some(r => r.kind === "message_edited" && r.refId === msg.id));
  assert.ok(trail.some(r => r.kind === "message_deleted" && r.refId === msg.id));

  raj.close(); owner.close(); relay.close();
});

test("an agent's message belongs to its owner, not to whoever shares the room", async () => {
  const { relay, url, owner, general } = await stand("chat-edit-agent.db");
  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
  const scout = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [scout.id] });
  await owner.wait(f => f.type === "channel" && f.channel.memberIds.includes(scout.id));

  const engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  engine.send({ type: "agentSend", agentId: scout.id, channelId: general.id, text: "found three flights" });
  const posted = (await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.authorKind === "agent")).message;

  const { guest: raj } = await bringIn(relay, url, owner, "Raj", general.id);
  raj.frames.length = 0;
  raj.send({ type: "deleteMessage", messageId: posted.id });
  const denied = await raj.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /not your agent/);
  assert.ok(!relay.store.message(posted.id)!.deletedAt);

  // the agent's owner may
  owner.send({ type: "deleteMessage", messageId: posted.id });
  await owner.wait<Extract<ServerFrame, { type: "messageUpdated" }>>(
    f => f.type === "messageUpdated" && !!f.message.deletedAt);

  raj.close(); engine.close(); owner.close(); relay.close();
});

test("per-message invocation controls are mention-bound, validated, and durable", async () => {
  const { relay, owner, general } = await stand("chat-invocation-controls.db");
  try {
  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
  const scout = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Guide" } as never });
  const guide = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === "Guide")).agent;
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [scout.id, guide.id] });
  await owner.wait(f => f.type === "channel"
    && f.channel.memberIds.includes(scout.id) && f.channel.memberIds.includes(guide.id));

  owner.send({
    type: "send", channelId: general.id, text: "@Scout inspect this",
    clientMessageId: "cm-invocation-controls",
    invocation: { agentId: scout.id, effort: "hard", permissionScope: "readOnly" },
  });
  const accepted = (await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.text === "@Scout inspect this")).message;
  assert.deepEqual(accepted.invocation, {
    agentId: scout.id, effort: "hard", permissionScope: "readOnly",
  });
  assert.deepEqual(relay.store.message(accepted.id)?.invocation, accepted.invocation);

  // A lost acknowledgement may reorder keys and carry stale UI-only fields;
  // the retry must still replay the original row rather than create a second.
  owner.frames.length = 0;
  owner.send({
    type: "send", channelId: general.id, text: "@Scout inspect this",
    clientMessageId: "cm-invocation-controls",
    invocation: { permissionScope: "readOnly", effort: "hard", agentId: scout.id, staleUiKey: "ignored" } as never,
  });
  const replay = (await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.id === accepted.id)).message;
  assert.equal(replay.id, accepted.id);

  owner.send({
    type: "send", channelId: general.id, text: "@Scout model check",
    invocation: { agentId: scout.id, model: "claude-sonnet-4-5" },
  });
  const unavailable = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(unavailable.error, /catalog/);
  owner.frames.length = 0;

  owner.send({
    type: "send", channelId: general.id, text: "@Scout @Guide compare these",
    invocation: { agentId: scout.id, effort: "hard" },
  });
  const ambiguous = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(ambiguous.error, /exactly one|unambiguous/);
  owner.frames.length = 0;

  owner.send({
    type: "send", channelId: general.id, text: "ordinary prose",
    invocation: { agentId: scout.id, model: "claude-sonnet-4-5" },
  });
  const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(refused.error, /mention the agent|exactly one|unambiguous/);
  } finally {
    owner.close(); relay.close();
  }
});

// ---------------------------------------------------------------------------
// 5. Threads
// ---------------------------------------------------------------------------

test("replies hang off a message, are counted on it, and stay one level deep", async () => {
  const { relay, url, owner, general } = await stand("chat-thread.db");
  const root = await say(owner, general.id, "where shall we eat");
  const { guest: raj } = await bringIn(relay, url, owner, "Raj", general.id);

  raj.send({ type: "send", channelId: general.id, text: "the noodle place", replyTo: root.id });
  const first = (await raj.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.text === "the noodle place")).message;
  assert.equal(first.replyTo, root.id);

  // replying to a REPLY joins the same thread rather than nesting
  owner.send({ type: "send", channelId: general.id, text: "good call", replyTo: first.id });
  const second = (await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.text === "good call")).message;
  assert.equal(second.replyTo, root.id, "threads must not nest");

  // the count is cached on the root and pushed out, not left for a reload
  const bumped = relay.store.message(root.id)!;
  assert.equal(bumped.replyCount, 2);
  assert.ok(bumped.lastReplyAt);

  // and the whole thread can be asked for
  owner.frames.length = 0;
  owner.send({ type: "thread", messageId: first.id });
  const thread = await owner.wait<Extract<ServerFrame, { type: "thread" }>>(f => f.type === "thread");
  assert.equal(thread.parentId, root.id, "asking about a reply gives you its thread");
  assert.deepEqual(thread.messages.map(m => m.text),
    ["where shall we eat", "the noodle place", "good call"]);

  raj.close(); owner.close(); relay.close();
});

test("a reply cannot be aimed at a message in another conversation", async () => {
  const { relay, owner, general } = await stand("chat-thread-scope.db");
  owner.send({ type: "createChannel", name: "money", memberIds: [], kind: "channel" });
  const room = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "money")).channel;
  const elsewhere = await say(owner, room.id, "hunter2");

  owner.frames.length = 0;
  owner.send({ type: "send", channelId: general.id, text: "sneaky", replyTo: elsewhere.id });
  const err = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /isn't in this conversation/);

  owner.close(); relay.close();
});

test("thread summaries are explicit, access-checked, idempotent, and relay-redacted", async () => {
  const { relay, url, owner, general, me } = await stand("chat-thread-summary.db");
  let engine: TestClient | undefined;
  try {
    owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
    const scout = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
    owner.send({ type: "addMembers", channelId: general.id, memberIds: [scout.id] });
    await owner.wait(f => f.type === "channel" && f.channel.id === general.id && f.channel.memberIds.includes(scout.id));
    const root = await say(owner, general.id, "We should ship Friday");
    owner.send({ type: "send", channelId: general.id, text: "What about the migration?", replyTo: root.id });
    await owner.wait(f => f.type === "message" && f.message.replyTo === root.id);

    engine = new TestClient(url, "tok-owner", "engine");
    await engine.wait(f => f.type === "welcome");
    owner.frames.length = 0;
    owner.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
      sourceMessageId: root.id, agentId: scout.id, requestId: "summary-idempotent-1" });
    const pending = await owner.wait<Extract<ServerFrame, { type: "threadSummary" }>>(
      f => f.type === "threadSummary" && f.summary.status === "pending");
    assert.equal(pending.summary.requestId, "summary-idempotent-1");
    const request = await engine.wait<Extract<ServerFrame, { type: "threadSummaryRequest" }>>(
      f => f.type === "threadSummaryRequest" && f.request.requestId === "summary-idempotent-1");
    const result = {
      requestId: request.request.requestId, channelId: request.request.channelId,
      threadId: request.request.threadId, sourceMessageId: request.request.sourceMessageId,
      agentId: request.request.agentId, requesterId: request.request.requesterId,
      status: "ready" as const, updatedAt: Date.now(), decisions: ["Ship Friday"],
      openQuestions: ["Migration plan"], nextActions: ["Confirm rollback"],
      sources: [{ messageId: root.id, label: "provider supplied secret label" }],
    };
    engine.send({ type: "threadSummaryResult", result });
    const ready = await owner.wait<Extract<ServerFrame, { type: "threadSummary" }>>(
      f => f.type === "threadSummary" && f.summary.requestId === result.requestId && f.summary.status === "ready");
    assert.deepEqual(ready.summary.decisions, ["Ship Friday"]);
    assert.match(ready.summary.sources[0].label, /Vikas: We should ship Friday/);
    // A lost/retried provider acknowledgement with a different label is still
    // the same bounded result: relay-owned source labels remain canonical.
    engine.send({ type: "threadSummaryResult", result: { ...result, sources: [{ messageId: root.id, label: "another provider label" }] } });
    const replay = await owner.wait<Extract<ServerFrame, { type: "threadSummary" }>>(
      f => f.type === "threadSummary" && f.summary.requestId === result.requestId && f.summary.status === "ready");
    assert.match(replay.summary.sources[0].label, /Vikas: We should ship Friday/);

    // The source must be the root, not a reply or an unrelated message.
    owner.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
      sourceMessageId: "not-a-message", agentId: scout.id, requestId: "summary-bad-source" });
    const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "summary-bad-source");
    assert.match(refused.error, /no such message|thread root/);
    assert.equal(ready.summary.requesterId, me.id);
  } finally {
    engine?.close(); owner.close(); relay.close();
  }
});

test("thread summary pending work settles on engine loss and rejects stale provider results", async () => {
  const { relay, url, owner, general } = await stand("chat-thread-summary-engine-loss.db");
  let engine: TestClient | undefined;
  let replacement: TestClient | undefined;
  try {
    owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
    const scout = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
    owner.send({ type: "addMembers", channelId: general.id, memberIds: [scout.id] });
    await owner.wait(f => f.type === "channel" && f.channel.id === general.id && f.channel.memberIds.includes(scout.id));
    const root = await say(owner, general.id, "Summarize this thread after the engine drops");
    engine = new TestClient(url, "tok-owner", "engine");
    await engine.wait(f => f.type === "welcome");
    owner.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
      sourceMessageId: root.id, agentId: scout.id, requestId: "summary-engine-loss" });
    await owner.wait(f => f.type === "threadSummary" && f.summary.status === "pending");
    await engine.wait(f => f.type === "threadSummaryRequest" && f.request.requestId === "summary-engine-loss");
    engine.close(); engine = undefined;
    const ended = await owner.wait<Extract<ServerFrame, { type: "threadSummary" }>>(
      f => f.type === "threadSummary" && f.summary.requestId === "summary-engine-loss" && f.summary.status === "unavailable");
    assert.match(ended.summary.error ?? "", /engine disconnected/);

    replacement = new TestClient(url, "tok-owner", "engine");
    await replacement.wait(f => f.type === "welcome");
    replacement.frames.length = 0;
    replacement.send({ type: "threadSummaryResult", result: {
      requestId: "summary-engine-loss", channelId: general.id, threadId: root.id,
      sourceMessageId: root.id, agentId: scout.id, requesterId: relay.ownerId,
      status: "ready", updatedAt: Date.now(), decisions: ["stale"],
      openQuestions: [], nextActions: [], sources: [],
    } });
    const stale = await replacement.wait<Extract<ServerFrame, { type: "error" }>>(
      f => f.type === "error" && /conflicts with the accepted request|no pending request/.test(f.error));
    assert.match(stale.error, /conflicts with the accepted request/);
  } finally {
    replacement?.close(); engine?.close(); owner.close(); relay.close();
  }
});

test("thread summary requester disconnect and agent access loss settle terminally", async () => {
  const { relay, url, owner, general } = await stand("chat-thread-summary-access-loss.db");
  let replacement: TestClient | undefined;
  try {
    owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
    const scout = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
    owner.send({ type: "addMembers", channelId: general.id, memberIds: [scout.id] });
    await owner.wait(f => f.type === "channel" && f.channel.id === general.id && f.channel.memberIds.includes(scout.id));
    const root = await say(owner, general.id, "This request will lose access");
    owner.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
      sourceMessageId: root.id, agentId: scout.id, requestId: "summary-requester-loss" });
    await owner.wait(f => f.type === "threadSummary" && f.summary.status === "pending");
    owner.close();
    await new Promise(resolve => setTimeout(resolve, 80));
    replacement = new TestClient(url, "tok-owner");
    await replacement.wait(f => f.type === "welcome");
    replacement.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
      sourceMessageId: root.id, agentId: scout.id, requestId: "summary-requester-loss" });
    const requesterEnded = await replacement.wait<Extract<ServerFrame, { type: "threadSummary" }>>(
      f => f.type === "threadSummary" && f.summary.requestId === "summary-requester-loss" && f.summary.status === "unavailable");
    assert.match(requesterEnded.summary.error ?? "", /requester disconnected/);

    replacement.frames.length = 0;
    replacement.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
      sourceMessageId: root.id, agentId: scout.id, requestId: "summary-agent-loss" });
    await replacement.wait(f => f.type === "threadSummary" && f.summary.status === "pending");
    replacement.send({ type: "removeMember", channelId: general.id, memberId: scout.id });
    const agentEnded = await replacement.wait<Extract<ServerFrame, { type: "threadSummary" }>>(
      f => f.type === "threadSummary" && f.summary.requestId === "summary-agent-loss" && f.summary.status === "unavailable");
    assert.match(agentEnded.summary.error ?? "", /selected agent/);
  } finally {
    replacement?.close(); owner.close(); relay.close();
  }
});

test("thread summary settles when the last mobile requester disconnects and rejects a stale result", async () => {
  const { relay, url, owner, general } = await stand("chat-thread-summary-mobile-loss.db");
  let mobile: TestClient | undefined;
  let engine: TestClient | undefined;
  let replacement: TestClient | undefined;
  try {
    owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
    const scout = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
    owner.send({ type: "addMembers", channelId: general.id, memberIds: [scout.id] });
    await owner.wait(f => f.type === "channel" && f.channel.id === general.id && f.channel.memberIds.includes(scout.id));
    const root = await say(owner, general.id, "Mobile requester lifecycle");
    // Leave only a mobile requester socket alive. The old desktop-only gate
    // would leave this pending forever when that socket closed.
    owner.close();
    await new Promise(resolve => setTimeout(resolve, 80));
    mobile = new TestClient(url, "tok-owner", "mobile");
    await mobile.wait(f => f.type === "welcome");
    engine = new TestClient(url, "tok-owner", "engine");
    await engine.wait(f => f.type === "welcome");
    mobile.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
      sourceMessageId: root.id, agentId: scout.id, requestId: "summary-mobile-loss" });
    await mobile.wait(f => f.type === "threadSummary" && f.summary.status === "pending");
    const request = await engine.wait<Extract<ServerFrame, { type: "threadSummaryRequest" }>>(
      f => f.type === "threadSummaryRequest" && f.request.requestId === "summary-mobile-loss");
    mobile.close();
    await new Promise(resolve => setTimeout(resolve, 80));
    replacement = new TestClient(url, "tok-owner");
    await replacement.wait(f => f.type === "welcome");
    replacement.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
      sourceMessageId: root.id, agentId: scout.id, requestId: "summary-mobile-loss" });
    const ended = await replacement.wait<Extract<ServerFrame, { type: "threadSummary" }>>(
      f => f.type === "threadSummary" && f.summary.requestId === "summary-mobile-loss" && f.summary.status === "unavailable");
    assert.match(ended.summary.error ?? "", /requester disconnected/);

    engine.send({ type: "threadSummaryResult", result: {
      ...request.request, status: "ready", updatedAt: Date.now(), decisions: ["stale"],
      openQuestions: [], nextActions: [], sources: [],
    } });
    const stale = await engine.wait<Extract<ServerFrame, { type: "error" }>>(
      f => f.type === "error" && /conflicts with the accepted request|no pending request/.test(f.error));
    assert.match(stale.error, /conflicts with the accepted request/);
  } finally {
    replacement?.close(); engine?.close(); mobile?.close(); owner.close(); relay.close();
  }
});

test("thread summary turns malformed and deleted-source provider results into terminal unavailable", async () => {
  const { relay, url, owner, general } = await stand("chat-thread-summary-invalid-result.db");
  let engine: TestClient | undefined;
  try {
    owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
    const scout = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
    owner.send({ type: "addMembers", channelId: general.id, memberIds: [scout.id] });
    await owner.wait(f => f.type === "channel" && f.channel.id === general.id && f.channel.memberIds.includes(scout.id));
    const root = await say(owner, general.id, "Provider result should not outlive its source");
    engine = new TestClient(url, "tok-owner", "engine");
    await engine.wait(f => f.type === "welcome");

    owner.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
      sourceMessageId: root.id, agentId: scout.id, requestId: "summary-malformed-result" });
    await owner.wait(f => f.type === "threadSummary" && f.summary.status === "pending");
    const malformed = await engine.wait<Extract<ServerFrame, { type: "threadSummaryRequest" }>>(
      f => f.type === "threadSummaryRequest" && f.request.requestId === "summary-malformed-result");
    engine.send({ type: "threadSummaryResult", result: {
      ...malformed.request, status: "ready", updatedAt: Date.now(), decisions: "not-a-list",
      openQuestions: [], nextActions: [], sources: [],
    } as never });
    const malformedEnded = await owner.wait<Extract<ServerFrame, { type: "threadSummary" }>>(
      f => f.type === "threadSummary" && f.summary.requestId === "summary-malformed-result" && f.summary.status === "unavailable");
    assert.match(malformedEnded.summary.error ?? "", /unavailable/);
    await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");

    const deletedRoot = await say(owner, general.id, "This root will be deleted before the result");
    owner.send({ type: "threadSummary", channelId: general.id, threadId: deletedRoot.id,
      sourceMessageId: deletedRoot.id, agentId: scout.id, requestId: "summary-deleted-result" });
    await owner.wait(f => f.type === "threadSummary" && f.summary.requestId === "summary-deleted-result" && f.summary.status === "pending");
    const deletedRequest = await engine.wait<Extract<ServerFrame, { type: "threadSummaryRequest" }>>(
      f => f.type === "threadSummaryRequest" && f.request.requestId === "summary-deleted-result");
    owner.send({ type: "deleteMessage", messageId: deletedRoot.id });
    await owner.wait(f => f.type === "messageUpdated" && f.message.id === deletedRoot.id && Boolean(f.message.deletedAt));
    engine.send({ type: "threadSummaryResult", result: {
      ...deletedRequest.request, status: "ready", updatedAt: Date.now(), decisions: ["should not persist"],
      openQuestions: [], nextActions: [], sources: [{ messageId: deletedRoot.id, label: "provider label" }],
    } });
    const deletedEnded = await owner.wait<Extract<ServerFrame, { type: "threadSummary" }>>(
      f => f.type === "threadSummary" && f.summary.requestId === "summary-deleted-result" && f.summary.status === "unavailable");
    assert.match(deletedEnded.summary.error ?? "", /deleted/);
    await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && /deleted/.test(f.error));
  } finally {
    engine?.close(); owner.close(); relay.close();
  }
});

test("thread summary rejects a deleted root before creating provider work", async () => {
  const { relay, owner, general } = await stand("chat-thread-summary-deleted-request.db");
  try {
    owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
    const scout = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
    owner.send({ type: "addMembers", channelId: general.id, memberIds: [scout.id] });
    await owner.wait(f => f.type === "channel" && f.channel.id === general.id && f.channel.memberIds.includes(scout.id));
    const root = await say(owner, general.id, "Delete me before asking");
    owner.send({ type: "deleteMessage", messageId: root.id });
    await owner.wait(f => f.type === "messageUpdated" && f.message.id === root.id && Boolean(f.message.deletedAt));
    owner.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
      sourceMessageId: root.id, agentId: scout.id, requestId: "summary-deleted-request" });
    const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
      f => f.type === "error" && f.requestId === "summary-deleted-request");
    assert.match(refused.error, /deleted/);
  } finally {
    owner.close(); relay.close();
  }
});

test("thread summary pending ledger rejects requests beyond its honest bound", async () => {
  const { relay, owner, general } = await stand("chat-thread-summary-bound.db");
  try {
    owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
    const scout = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
    owner.send({ type: "addMembers", channelId: general.id, memberIds: [scout.id] });
    await owner.wait(f => f.type === "channel" && f.channel.id === general.id && f.channel.memberIds.includes(scout.id));
    const root = await say(owner, general.id, "Bound this summary queue");
    owner.frames.length = 0;
    for (let i = 0; i < 128; i++) {
      owner.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
        sourceMessageId: root.id, agentId: scout.id, requestId: `summary-bound-${i}` });
    }
    await owner.wait(f => f.type === "threadSummary" && f.summary.requestId === "summary-bound-127");
    owner.send({ type: "threadSummary", channelId: general.id, threadId: root.id,
      sourceMessageId: root.id, agentId: scout.id, requestId: "summary-bound-overflow" });
    const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
      f => f.type === "error" && /too many thread summaries/.test(f.error));
    assert.match(refused.error, /try again/);
  } finally {
    owner.close(); relay.close();
  }
});

// ---------------------------------------------------------------------------
// 6. Attachments
// ---------------------------------------------------------------------------

test("a file is stored on the hub, named on a message, and validated by the skill-file rule", async () => {
  const { relay, owner, general } = await stand("chat-files.db");

  owner.frames.length = 0;
  owner.send({
    type: "uploadAttachment", channelId: general.id, name: "trace.txt",
    dataBase64: Buffer.from("ping 8.8.8.8 timed out").toString("base64"), mime: "text/plain",
  });
  const parked = await owner.wait<Extract<ServerFrame, { type: "attachment" }>>(f => f.type === "attachment");
  assert.equal(parked.attachment.name, "trace.txt");
  assert.equal(parked.attachment.size, 22);

  // the bytes really are on this machine, under a name the relay chose
  const onDisk = path.join(relay.store.attachmentsDir, parked.attachment.storedAs);
  assert.ok(fs.existsSync(onDisk), "the file was not written to the hub");
  assert.equal(fs.readFileSync(onDisk, "utf8"), "ping 8.8.8.8 timed out");

  owner.send({
    type: "send", channelId: general.id, text: "here it is",
    attachmentIds: [parked.attachment.id],
  });
  const msg = (await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.text === "here it is")).message;
  assert.equal(msg.attachments?.length, 1);
  assert.equal(msg.attachments![0].name, "trace.txt");

  // the same parked file cannot be sent twice
  owner.frames.length = 0;
  owner.send({ type: "send", channelId: general.id, text: "again", attachmentIds: [parked.attachment.id] });
  const reuse = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(reuse.error, /already been sent/);

  // deleting the message takes the bytes with it
  owner.send({ type: "deleteMessage", messageId: msg.id });
  await owner.wait<Extract<ServerFrame, { type: "messageUpdated" }>>(
    f => f.type === "messageUpdated" && !!f.message.deletedAt);
  assert.equal(fs.existsSync(onDisk), false, "a deleted message left its file behind");

  owner.close(); relay.close();
});

test("a file name that could escape the attachments folder is refused, never rewritten", async () => {
  const { relay, owner, general } = await stand("chat-files-names.db");
  const data = Buffer.from("x").toString("base64");

  // exactly the names isSafeFileName already refuses — one rule, one owner
  for (const name of ["../escape.txt", "..\\escape.txt", "CON.md", "evil.md.", "evil.md ", "/etc/passwd"]) {
    owner.frames.length = 0;
    owner.send({ type: "uploadAttachment", channelId: general.id, name, dataBase64: data });
    const err = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
    assert.match(err.error, /file name isn't allowed/, `${name} was accepted`);
  }
  assert.equal(fs.existsSync(relay.store.attachmentsDir)
    ? fs.readdirSync(relay.store.attachmentsDir).length : 0, 0, "a refused name still wrote a file");

  // and an empty or oversized file is refused too
  owner.frames.length = 0;
  owner.send({ type: "uploadAttachment", channelId: general.id, name: "empty.txt", dataBase64: "" });
  const empty = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(empty.error, /empty/);

  owner.close(); relay.close();
});

test("a file parked in one conversation cannot be sent into another", async () => {
  const { relay, url, owner, general } = await stand("chat-files-scope.db");
  const { guest: raj } = await bringIn(relay, url, owner, "Raj", general.id);

  owner.send({
    type: "uploadAttachment", channelId: general.id, name: "notes.txt",
    dataBase64: Buffer.from("mine").toString("base64"),
  });
  const parked = await owner.wait<Extract<ServerFrame, { type: "attachment" }>>(f => f.type === "attachment");

  raj.frames.length = 0;
  raj.send({ type: "send", channelId: general.id, text: "not mine", attachmentIds: [parked.attachment.id] });
  const err = await raj.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /isn't yours/);

  raj.close(); owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// 7. Read state on the account, not the browser
// ---------------------------------------------------------------------------

test("read state lives on the account and follows you to another machine", async () => {
  const { relay, url, owner, general } = await stand("chat-read.db");
  const { guest: raj } = await bringIn(relay, url, owner, "Raj", general.id);

  await say(raj, general.id, "one");
  await say(raj, general.id, "two");
  const third = await say(raj, general.id, "three");

  // the owner's laptop signs in fresh and is told what it has not read
  const laptop = new TestClient(url, "tok-owner");
  const w = await laptop.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const before = w.state.unread!.find(u => u.channelId === general.id)!;
  assert.equal(before.unread, 3, "unread must come from the relay, not from this browser");

  // reading on ONE machine is told to every machine
  laptop.send({ type: "markRead", channelId: general.id, ts: third.ts });
  const echoed = await owner.wait<Extract<ServerFrame, { type: "read" }>>(f => f.type === "read");
  assert.equal(echoed.entry.unread, 0);

  // and a machine that reconnects later starts already read
  const phone = new TestClient(url, "tok-owner", "mobile");
  const pw = await phone.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  assert.equal(pw.state.unread!.find(u => u.channelId === general.id)!.unread, 0);

  // an old position replayed by a slow client must not un-read what was read
  phone.send({ type: "markRead", channelId: general.id, ts: 1 });
  const merged = await phone.wait<Extract<ServerFrame, { type: "read" }>>(f => f.type === "read");
  assert.equal(merged.entry.lastReadTs, third.ts, "read state must only ever move forward");
  assert.equal(merged.entry.unread, 0);

  phone.close(); laptop.close(); raj.close(); owner.close(); relay.close();
});

test("an @mention of you is counted separately from ordinary unread", async () => {
  const { relay, url, owner, general } = await stand("chat-mentions.db");
  const { guest: raj } = await bringIn(relay, url, owner, "Raj", general.id);

  await say(raj, general.id, "morning all");
  await say(raj, general.id, "@Vikas can you look at the router");

  const laptop = new TestClient(url, "tok-owner");
  const w = await laptop.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const entry = w.state.unread!.find(u => u.channelId === general.id)!;
  assert.equal(entry.unread, 2);
  assert.equal(entry.mentions, 1, "a mention badge is not the same as an unread badge");

  laptop.close(); raj.close(); owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// 8. Who may drive an agent (Buzz teardown — respond_to_allowlist)
// ---------------------------------------------------------------------------

test("a friend in the room cannot spend the owner's subscription", async () => {
  const { relay, url, owner, general } = await stand("chat-respondto.db");
  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
  const scout = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [scout.id] });
  await owner.wait(f => f.type === "channel" && f.channel.memberIds.includes(scout.id));

  // an agent nobody chose to open up is owner-only, by default and by omission
  assert.equal(scout.respondTo ?? "owner", "owner");

  const { guest: raj, me: rajUser } = await bringIn(relay, url, owner, "Raj", general.id);

  // 1. Raj @mentions Scout. The words go through — they are his message — but
  //    the agent's id never reaches the mentions list the engine acts on.
  const mentioned = await say(raj, general.id, "@Scout book me a flight");
  assert.ok(!(mentioned.mentions ?? []).includes(scout.id),
    "a mention drove an agent its owner never opened up");

  // 2. and the engine relaying his "!bg …" is refused outright
  const engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  engine.frames.length = 0;
  engine.send({
    type: "createTask", agentId: scout.id, channelId: general.id,
    title: "book a flight", requesterId: rajUser.id,
  });
  const denied = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /isn't set up to take work from Raj/);
  assert.equal(relay.store.tasks().length, 0, "a refused job was created anyway");

  // 3. the owner opens it up to Raj by name — and only then does it work
  const opened: AgentDef = { ...scout, respondTo: "allowlist", respondToAllowlist: [rajUser.id] };
  owner.send({ type: "updateAgent", agent: opened });
  await owner.wait(f => f.type === "agent" && f.agent.respondTo === "allowlist");

  const nowMentioned = await say(raj, general.id, "@Scout book me a flight please");
  assert.ok((nowMentioned.mentions ?? []).includes(scout.id));

  engine.frames.length = 0;
  engine.send({
    type: "createTask", agentId: scout.id, channelId: general.id,
    title: "book a flight", requesterId: rajUser.id,
  });
  const task = await engine.wait<Extract<ServerFrame, { type: "task" }>>(f => f.type === "task");
  assert.equal(task.task.requesterName, "Raj");

  engine.close(); raj.close(); owner.close(); relay.close();
});

test("a guest cannot open up somebody else's agent", async () => {
  const { relay, url, owner, general } = await stand("chat-respondto-escalate.db");
  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
  const scout = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
  const { guest: raj, me: rajUser } = await bringIn(relay, url, owner, "Raj", general.id);

  raj.frames.length = 0;
  raj.send({ type: "updateAgent", agent: { ...scout, respondTo: "anyone" } });
  const denied = await raj.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /not your agent/);
  const stored = relay.store.agents().find(a => a.id === scout.id)!;
  assert.equal(stored.respondTo ?? "owner", "owner");
  assert.equal(stored.ownerId, relay.ownerId);
  assert.notEqual(stored.ownerId, rajUser.id);

  raj.close(); owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// 9. The trail is a ledger (Buzz teardown — seq + prevHash)
// ---------------------------------------------------------------------------

test("the activity trail is a chain, and a rewritten line shows up", async () => {
  const { relay, owner, general } = await stand("chat-ledger.db");
  const msg = await say(owner, general.id, "meet at 5pm");
  owner.send({ type: "editMessage", messageId: msg.id, text: "meet at 6pm" });
  await owner.wait(f => f.type === "messageUpdated");
  owner.send({ type: "deleteMessage", messageId: msg.id });
  await owner.wait(f => f.type === "messageUpdated" && !!f.message.deletedAt);

  const trail = relay.store.activity(Date.now() + 1, 100);
  assert.ok(trail.length >= 2);
  // numbered from 1, with no gaps, each line naming the one before it
  const seqs = trail.map(r => r.seq!);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
  assert.equal(relay.store.verifyActivity(), null, "a freshly written trail must verify");

  // now quietly rewrite one line, the way an editor with the file would
  const victim = trail[trail.length - 1];
  relay.store.db.prepare("UPDATE activity SET json=? WHERE id=?")
    .run(JSON.stringify({ ...victim, detail: "nothing happened here" }), victim.id);
  const broken = relay.store.verifyActivity();
  assert.ok(broken, "an altered line went undetected");
  assert.match(broken!.problem, /changed since it was written/);

  owner.close(); relay.close();
});

test("a database written before the ledger is chained on the way in", async () => {
  const dbPath = tmp("chat-migrate.db");
  const first = new Relay({ dbPath, ownerToken: "tok-owner", ownerName: "Vikas" });
  await first.listen(0);
  // simulate the old shape: rows with no seq, hash or prevHash
  first.store.db.exec("UPDATE activity SET seq=NULL, hash=NULL, prevHash=NULL");
  first.store.db.exec(
    "INSERT INTO activity(id,ts,json) VALUES('act_old',1,'" +
    JSON.stringify({
      id: "act_old", ts: 1, actorKind: "human", actorId: "u", actorName: "Vikas",
      kind: "message", detail: "an old line",
    }) + "')");
  first.store.db.exec("DELETE FROM meta WHERE key='schemaVersion'");
  first.close();

  const second = new Relay({ dbPath, ownerToken: "tok-owner", ownerName: "Vikas" });
  await second.listen(0);
  // brought all the way up to date, whatever "up to date" is today — pinned to
  // the constant so this line cannot go stale on the next migration step
  assert.equal(second.store.schemaVersion(), SCHEMA_VERSION);
  assert.equal(second.store.verifyActivity(), null, "the old rows were not chained");
  const old = second.store.activity(Date.now() + 1, 100).find(r => r.id === "act_old")!;
  assert.equal(old.seq, 1);
  assert.equal(old.prevHash, "");
  second.close();
});
