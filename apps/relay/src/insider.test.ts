// WHAT A PERSON ALREADY IN THE ROOM MAY DO.
//
// The 92 tests that were here before this file all asked the outsider's
// question — "can a stranger get in?" — and every `addMembers` in the suite was
// sent by the room's owner. That is why a plain member being able to hand a
// private room to anybody survived a whole round of review: nothing ever asked
// what an INSIDER could do.
//
// Every test in this file was written against the code as it stood and FAILED,
// then passed once the fix landed. Where a test proves a leak, it proves it the
// way the leak actually happened — over the real socket, by reading the message
// that should not have been readable.
import test from "node:test";
import assert from "node:assert/strict";
import { ServerFrame } from "@cloud9/shared";
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
  return { relay, url, owner, general, me: welcome.state.me };
}

async function guestOf(url: string, owner: TestClient, name: string) {
  // drop any invite already sitting in the buffer, so this waits for the code
  // minted for THIS guest and never re-uses a spent one
  owner.frames = owner.frames.filter(f => f.type !== "invite");
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const guest = new TestClient(url, `invite:${inv.code}:${name}`);
  const w = await guest.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { guest, me: w.state.me.id, code: inv.code };
}

async function refuses(client: TestClient, frame: Parameters<TestClient["send"]>[0], contains: string) {
  client.frames.length = 0;
  client.send(frame);
  const err = await client.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(err.error.includes(contains), `expected "${contains}", got "${err.error}"`);
}

async function makeAgent(client: TestClient, name: string) {
  client.send({ type: "createAgent", agent: { ...BASE_AGENT, name } });
  const f = await client.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === name);
  return f.agent;
}

// ---------------------------------------------------------------------------
// P0: a private room is private
// ---------------------------------------------------------------------------

test("a guest in a private room cannot let a stranger in", async () => {
  const { relay, url, owner } = await stand("in-private.db");
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  const { guest: neha, me: nehaId } = await guestOf(url, owner, "Neha");

  owner.send({ type: "createChannel", name: "board", memberIds: [rajId], kind: "channel" });
  const board = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "board")).channel;
  owner.send({ type: "send", channelId: board.id, text: "the offer is 4.2 million" });
  await owner.wait(f => f.type === "message");

  // Raj is INSIDE the room. Before the fix this was allowed, because inviting
  // was gated on "are you in here" rather than "do you run this".
  await refuses(raj, { type: "addMembers", channelId: board.id, memberIds: [nehaId] },
    "you don't run this conversation");

  // and the proof that matters: Neha still cannot read a word of it
  neha.frames.length = 0;
  neha.send({ type: "history", channelId: board.id });
  const err = await neha.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(err.error.includes("no such channel"), "the room does not exist as far as Neha is concerned");

  owner.close(); raj.close(); neha.close(); relay.close();
});

test("nobody can add a third person to a direct conversation", async () => {
  const { relay, url, owner } = await stand("in-dm.db");
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  const { guest: neha, me: nehaId } = await guestOf(url, owner, "Neha");

  owner.send({ type: "createChannel", name: "dm", memberIds: [rajId], kind: "dm" });
  const dm = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.kind === "dm")).channel;
  owner.send({ type: "send", channelId: dm.id, text: "between you and me" });
  await owner.wait(f => f.type === "message");

  // A direct conversation is between two people BY DEFINITION. Refused for the
  // guest and for the owner alike — this is not a question of rank.
  await refuses(raj, { type: "addMembers", channelId: dm.id, memberIds: [nehaId] },
    "a direct conversation");
  await refuses(owner, { type: "addMembers", channelId: dm.id, memberIds: [nehaId] },
    "a direct conversation");

  assert.deepEqual([...relay.store.channel(dm.id)!.memberIds].sort(),
    [...[relay.ownerId, rajId]].sort(), "the DM still has exactly two people in it");

  neha.frames.length = 0;
  neha.send({ type: "history", channelId: dm.id });
  const err = await neha.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(err.error.includes("no such channel"));

  owner.close(); raj.close(); neha.close(); relay.close();
});

test("an agent cannot be used to smuggle its owner into a room", async () => {
  // THE ONE THAT LOOKED LIKE NOTHING ON SCREEN. `visibleChannels` counts a room
  // as yours when an AGENT of yours is in it, so adding somebody else's agent
  // silently added the person behind it — and the member list only ever showed
  // an agent's name.
  const { relay, url, owner } = await stand("in-agent.db");
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  const { guest: neha, me: nehaId } = await guestOf(url, owner, "Neha");
  const nehasAgent = await makeAgent(neha, "Scout");

  owner.send({ type: "createChannel", name: "board", memberIds: [rajId], kind: "channel" });
  const board = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "board")).channel;
  owner.send({ type: "send", channelId: board.id, text: "the offer is 4.2 million" });
  await owner.wait(f => f.type === "message");
  // give Raj the power, so the ONLY thing this test is about is the agent
  owner.send({ type: "setMemberRole", channelId: board.id, memberId: rajId, role: "admin" });
  await owner.wait(f => f.type === "channel" && f.channel.id === board.id);

  await refuses(raj, { type: "addMembers", channelId: board.id, memberIds: [nehasAgent.id] },
    "that agent's owner isn't in this conversation");

  // Neha is not in the room, and the scrollback is not hers to read
  neha.frames.length = 0;
  neha.send({ type: "history", channelId: board.id });
  const err = await neha.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(err.error.includes("no such channel"), "Neha never gained sight of the room");

  // and once her owner IS a member, her agent may come in the ordinary way
  owner.frames.length = 0;
  owner.send({ type: "addMembers", channelId: board.id, memberIds: [nehaId] });
  await owner.wait(f => f.type === "channel" && f.channel.id === board.id
    && f.channel.memberIds.includes(nehaId));
  raj.frames.length = 0;
  raj.send({ type: "addMembers", channelId: board.id, memberIds: [nehasAgent.id] });
  await raj.wait(f => f.type === "channel" && f.channel.id === board.id
    && f.channel.memberIds.includes(nehasAgent.id));

  owner.close(); raj.close(); neha.close(); relay.close();
});

test("a new room cannot be BORN with a stranger's agent in it either", async () => {
  // THE SAME CLASS, FOUND BY LOOKING FOR IT. Closing `addMembers` and leaving
  // `createChannel` open would have left the identical hole one frame along:
  // make a room, put somebody else's agent in it at birth, and its owner is in
  // your room. Both go through `assertMayAdd` — one rule, not two copies.
  const { relay, url, owner } = await stand("in-born.db");
  const { guest: raj } = await guestOf(url, owner, "Raj");
  const { guest: neha, me: nehaId } = await guestOf(url, owner, "Neha");
  const nehasAgent = await makeAgent(neha, "Scout");

  await refuses(raj, { type: "createChannel", name: "sneaky", memberIds: [nehasAgent.id], kind: "channel" },
    "that agent's owner isn't in this conversation");

  // with her owner in the room, it is an ordinary thing to do
  raj.frames.length = 0;
  raj.send({ type: "createChannel", name: "fine", memberIds: [nehaId, nehasAgent.id], kind: "channel" });
  await raj.wait(f => f.type === "channel" && f.channel.name === "fine");

  // and a "direct conversation" with three people in it is not a thing
  await refuses(raj, { type: "createChannel", name: "three", memberIds: [nehaId, relay.ownerId], kind: "dm" },
    "between two people");

  owner.close(); raj.close(); neha.close(); relay.close();
});

test("EVERY frame that changes a room or its membership is on the right gate", async () => {
  // THE CLASS CHECK. `addMembers` was missed precisely because the others moved
  // and nothing listed them together. This is that list, and a new frame that
  // changes a room has to be added to it.
  const { relay, url, owner } = await stand("in-gates.db");
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  const { guest: neha, me: nehaId } = await guestOf(url, owner, "Neha");

  owner.send({ type: "createChannel", name: "ops", memberIds: [rajId], kind: "channel" });
  const ops = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "ops")).channel;

  // Raj is a plain MEMBER of ops. Not one of these may he do.
  const administration: Parameters<TestClient["send"]>[0][] = [
    { type: "addMembers", channelId: ops.id, memberIds: [nehaId] },
    { type: "setChannelInfo", channelId: ops.id, topic: "mine now" },
    { type: "setChannelInfo", channelId: ops.id, description: "mine now" },
    { type: "setChannelVisibility", channelId: ops.id, visibility: "open" },
    { type: "archiveChannel", channelId: ops.id, archived: true },
    { type: "removeMember", channelId: ops.id, memberId: relay.ownerId },
  ];
  for (const frame of administration) {
    await refuses(raj, frame, "you don't run this conversation");
  }
  // and the one that needs more than admin
  await refuses(raj, { type: "setMemberRole", channelId: ops.id, memberId: rajId, role: "owner" },
    "only the person who runs this conversation");

  const after = relay.store.channel(ops.id)!;
  assert.deepEqual([...after.memberIds].sort(), [relay.ownerId, rajId].sort(),
    "nothing on that list moved a single member");
  assert.equal(after.topic, undefined);
  assert.equal(after.archivedAt, undefined);

  owner.close(); raj.close(); neha.close(); relay.close();
});

test("nobody may be added to an archived room", async () => {
  const { relay, url, owner } = await stand("in-archived.db");
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  owner.send({ type: "createChannel", name: "old", memberIds: [], kind: "channel" });
  const old = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "old")).channel;
  owner.send({ type: "archiveChannel", channelId: old.id, archived: true });
  await owner.wait(f => f.type === "channel" && f.channel.id === old.id && !!f.channel.archivedAt);

  // moving to `adminChannel` must not lose the archive rule `writableChannel`
  // was carrying — the class fix has to keep every question the old gate asked
  await refuses(owner, { type: "addMembers", channelId: old.id, memberIds: [rajId] }, "archived");

  owner.close(); raj.close(); relay.close();
});

// ---------------------------------------------------------------------------
// Membership: a save that is not about membership must not move anybody
// ---------------------------------------------------------------------------

test("setting a topic does not evict the person who just joined", async () => {
  const { relay, url, owner } = await stand("in-topic.db");
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  owner.send({ type: "createChannel", name: "ops", memberIds: [], kind: "channel" });
  const ops = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "ops")).channel;
  // the owner's screen is now holding a member list WITHOUT Raj in it
  owner.send({ type: "setChannelVisibility", channelId: ops.id, visibility: "open" });
  await owner.wait(f => f.type === "channel" && f.channel.id === ops.id);
  raj.send({ type: "browseChannels" });
  await raj.wait(f => f.type === "channelDirectory");
  raj.send({ type: "joinChannel", channelId: ops.id });
  await raj.wait(f => f.type === "channel" && f.channel.id === ops.id);

  owner.send({ type: "setChannelInfo", channelId: ops.id, topic: "this quarter" });
  const updated = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.id === ops.id && f.channel.topic === "this quarter");

  assert.ok(updated.channel.memberIds.includes(rajId),
    "Raj joined and then somebody set the topic — that is not a reason to throw him out");
  assert.equal(relay.store.memberRole(ops.id, rajId), "member", "and he is still really in the room");

  owner.close(); raj.close(); relay.close();
});

test("a stale screen cannot resurrect somebody an admin just removed", async () => {
  const { relay, url, owner } = await stand("in-stale.db");
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  const { guest: neha, me: nehaId } = await guestOf(url, owner, "Neha");
  owner.send({ type: "createChannel", name: "ops", memberIds: [rajId, nehaId], kind: "channel" });
  const ops = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "ops")).channel;
  // Neha's screen is holding a member list from BEFORE this removal
  owner.send({ type: "removeMember", channelId: ops.id, memberId: rajId });
  await owner.wait(f => f.type === "channel" && f.channel.id === ops.id
    && !f.channel.memberIds.includes(rajId));
  owner.send({ type: "setMemberRole", channelId: ops.id, memberId: nehaId, role: "admin" });
  await owner.wait(f => f.type === "channel" && f.channel.id === ops.id);

  // Neha now touches the room for a reason that has nothing to do with Raj
  neha.send({ type: "setChannelInfo", channelId: ops.id, topic: "still going" });
  const updated = await neha.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.id === ops.id && f.channel.topic === "still going");
  assert.ok(!updated.channel.memberIds.includes(rajId),
    "a save from a stale screen must not undo a removal an admin meant");

  owner.close(); raj.close(); neha.close(); relay.close();
});

test("being let back in does not hand back the powers you were removed with", async () => {
  const { relay, url, owner } = await stand("in-revive.db");
  const { guest: raj, me: rajId } = await guestOf(url, owner, "Raj");
  const { guest: neha, me: nehaId } = await guestOf(url, owner, "Neha");
  owner.send({ type: "createChannel", name: "ops", memberIds: [rajId, nehaId], kind: "channel" });
  const ops = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "ops")).channel;

  owner.frames.length = 0;
  owner.send({ type: "setMemberRole", channelId: ops.id, memberId: rajId, role: "admin" });
  await owner.wait(f => f.type === "channel" && f.channel.id === ops.id);
  assert.equal(relay.store.memberRole(ops.id, rajId), "admin");
  const firstJoin = relay.store.channelMembers(ops.id).find(m => m.memberId === rajId)!.joinedAt;
  owner.frames.length = 0;
  owner.send({ type: "removeMember", channelId: ops.id, memberId: rajId });
  await owner.wait(f => f.type === "channel" && f.channel.id === ops.id
    && !f.channel.memberIds.includes(rajId));

  // Neha is a PLAIN MEMBER... so make her an admin, the smallest power that can
  // invite. She may let Raj back in. She may NOT make him an admin by doing so.
  owner.frames.length = 0;
  owner.send({ type: "setMemberRole", channelId: ops.id, memberId: nehaId, role: "admin" });
  await owner.wait(f => f.type === "channel" && f.channel.id === ops.id);
  assert.equal(relay.store.memberRole(ops.id, nehaId), "admin");
  neha.frames.length = 0; // the buffer still holds the room as it was BEFORE the removal
  neha.send({ type: "addMembers", channelId: ops.id, memberIds: [rajId] });
  await neha.wait(f => f.type === "channel" && f.channel.id === ops.id
    && f.channel.memberIds.includes(rajId));

  assert.equal(relay.store.memberRole(ops.id, rajId), "member",
    "coming back into a room is not the same act as being given power in it");

  // AND THE HISTORY IS STILL THERE. The first visit is a row of its own; it was
  // not overwritten to record the second.
  const rows = relay.store.channelMembers(ops.id, { includeRemoved: true })
    .filter(m => m.memberId === rajId);
  assert.equal(rows.length, 2, "two spells in the room, two rows");
  const first = rows.find(r => r.joinedAt === firstJoin)!;
  assert.ok(first, "the first arrival is still recorded, to the millisecond");
  assert.equal(first.invitedBy, relay.ownerId, "and who let him in the first time");
  assert.ok(first.removedAt, "and that he was removed");
  const second = rows.find(r => r.joinedAt !== firstJoin)!;
  assert.equal(second.invitedBy, nehaId, "the second row records who let him back");
  assert.equal(second.removedAt, undefined);

  // and "who was in this room at that moment" is right for the gap
  const gap = first.removedAt! + 1;
  const thenMembers = relay.store.channelMembers(ops.id, { at: gap }).map(m => m.memberId);
  assert.ok(!thenMembers.includes(rajId), "he was OUT of the room at that moment, and the table says so");

  owner.close(); raj.close(); neha.close(); relay.close();
});
