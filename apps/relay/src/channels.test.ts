// Channels become real: membership as ROWS (role, joinedAt, invitedBy,
// removedAt), plus description / topic / visibility / archive — and the
// migration that brings an existing database across without losing anything.
//
// Every test here failed before the change it covers landed.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Channel, ChannelMember, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { SCHEMA_VERSION, Store } from "./store.js";
import { TestClient, tmp } from "./testclient.js";

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

/** A guest who has signed in but is in no room but #general. */
async function guestOf(url: string, owner: TestClient, name: string, notCode?: string) {
  const code = await invite(owner, notCode);
  const guest = new TestClient(url, `invite:${code}:${name}`);
  const w = await guest.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { guest, me: w.state.me, code };
}

async function refuses(client: TestClient, frame: Parameters<TestClient["send"]>[0], contains: string) {
  client.frames.length = 0;
  client.send(frame);
  const err = await client.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(err.error.includes(contains), `expected "${contains}", got "${err.error}"`);
}

// ---------------------------------------------------------------------------
// 1. Membership is rows, not an array of ids
// ---------------------------------------------------------------------------

test("joining a room writes a row that knows the role, the date and who let you in", async () => {
  const { relay, url, owner, general } = await stand("ch-rows.db");
  const { guest, me } = await guestOf(url, owner, "Raj");

  // a room the owner makes, that the guest is then let into
  owner.send({ type: "createChannel", name: "ops", memberIds: [], kind: "channel" });
  const made = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "ops");
  const ops = made.channel;

  owner.send({ type: "addMembers", channelId: ops.id, memberIds: [me.id] });
  await owner.wait(f => f.type === "channel" && f.channel.id === ops.id && f.channel.memberIds.includes(me.id));

  owner.frames.length = 0;
  owner.send({ type: "channelMembers", channelId: ops.id });
  const list = await owner.wait<Extract<ServerFrame, { type: "channelMembers" }>>(
    f => f.type === "channelMembers");

  const mineRow = list.members.find(m => m.memberId === me.id)!;
  assert.ok(mineRow, "the guest has a membership row, not just an id in a list");
  assert.equal(mineRow.role, "member", "an invited person is a plain member");
  assert.ok(mineRow.joinedAt > 0, "a row knows WHEN — an id array never could");
  assert.equal(mineRow.invitedBy, relay.ownerId, "a row knows WHO let them in");
  assert.equal(mineRow.removedAt, undefined);

  const ownerRow = list.members.find(m => m.memberId === relay.ownerId)!;
  assert.equal(ownerRow.role, "owner", "whoever makes a room runs it");

  guest.close(); owner.close(); relay.close();
});

test("the room can say who was in it WHEN a message was said", async () => {
  const { relay, url, owner, general } = await stand("ch-history.db");
  const { guest, me } = await guestOf(url, owner, "Raj");

  owner.send({ type: "addMembers", channelId: general.id, memberIds: [me.id] });
  await owner.wait(f => f.type === "channel" && f.channel.memberIds.includes(me.id));

  const whileIn = Date.now();
  await new Promise(r => setTimeout(r, 5));

  // they leave
  guest.send({ type: "leaveChannel", channelId: general.id });
  await guest.wait(f => f.type === "channelLeft" && f.channelId === general.id);
  await new Promise(r => setTimeout(r, 5));
  const afterOut = Date.now();

  owner.frames.length = 0;
  owner.send({ type: "channelMembers", channelId: general.id, at: whileIn });
  const then = await owner.wait<Extract<ServerFrame, { type: "channelMembers" }>>(
    f => f.type === "channelMembers" && f.at === whileIn);
  assert.ok(then.members.some(m => m.memberId === me.id),
    "at that moment they WERE in the room — this is the question an id array could never answer");

  owner.frames.length = 0;
  owner.send({ type: "channelMembers", channelId: general.id, at: afterOut });
  const later = await owner.wait<Extract<ServerFrame, { type: "channelMembers" }>>(
    f => f.type === "channelMembers" && f.at === afterOut);
  assert.ok(!later.members.some(m => m.memberId === me.id), "by then they had gone");

  // and leaving really does take the room away from them
  const world = await (async () => {
    const back = new TestClient(`ws://127.0.0.1:${(relay.server.address() as { port: number }).port}`, "x");
    back.close();
    return relay.store.channel(general.id)!;
  })();
  assert.ok(!world.memberIds.includes(me.id), "the derived member list drops someone who left");

  guest.close(); owner.close(); relay.close();
});

test("leaving means the room's messages stop arriving", async () => {
  const { relay, url, owner, general } = await stand("ch-leave.db");
  const { guest, me } = await guestOf(url, owner, "Raj");
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [me.id] });
  await guest.wait(f => f.type === "channel" && f.channel.memberIds.includes(me.id));

  guest.send({ type: "leaveChannel", channelId: general.id });
  await guest.wait(f => f.type === "channelLeft");

  // they can no longer read it — the ordinary gate, unchanged
  await refuses(guest, { type: "history", channelId: general.id }, "no such channel");
  await refuses(guest, { type: "send", channelId: general.id, text: "still here?" }, "no such channel");

  guest.close(); owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// 2. Roles
// ---------------------------------------------------------------------------

test("only the people who run a room can change it", async () => {
  const { relay, url, owner, general } = await stand("ch-roles.db");
  const { guest, me } = await guestOf(url, owner, "Raj");
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [me.id] });
  await guest.wait(f => f.type === "channel" && f.channel.memberIds.includes(me.id));

  // a plain member may talk but not redecorate
  await refuses(guest, { type: "setChannelInfo", channelId: general.id, topic: "mine now" },
    "you don't run this conversation");
  await refuses(guest, { type: "setChannelVisibility", channelId: general.id, visibility: "open" },
    "you don't run this conversation");
  await refuses(guest, { type: "archiveChannel", channelId: general.id, archived: true },
    "you don't run this conversation");
  await refuses(guest, { type: "removeMember", channelId: general.id, memberId: relay.ownerId },
    "you don't run this conversation");
  // and handing out roles is the owner's alone
  await refuses(guest, { type: "setMemberRole", channelId: general.id, memberId: me.id, role: "owner" },
    "only the person who runs this conversation");

  // made an admin, they can now set a topic — but still not hand out roles
  owner.send({ type: "setMemberRole", channelId: general.id, memberId: me.id, role: "admin" });
  await owner.wait(f => f.type === "channel" && f.channel.id === general.id);
  await new Promise(r => setTimeout(r, 30));

  guest.frames.length = 0;
  guest.send({ type: "setChannelInfo", channelId: general.id, topic: "today: packing" });
  const updated = await guest.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.topic === "today: packing");
  assert.equal(updated.channel.topicSetBy, me.id, "the room remembers who set the topic");
  assert.ok(updated.channel.topicSetAt! > 0);

  await refuses(guest, { type: "setMemberRole", channelId: general.id, memberId: me.id, role: "owner" },
    "only the person who runs this conversation");
  // and an admin cannot throw out the person who runs the room
  await refuses(guest, { type: "removeMember", channelId: general.id, memberId: relay.ownerId },
    "only the person who runs this conversation");

  guest.close(); owner.close(); relay.close();
});

test("a role is read from the stored row, never from what a client claims", async () => {
  const { relay, url, owner, general } = await stand("ch-claim.db");
  const { guest, me } = await guestOf(url, owner, "Raj");
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [me.id] });
  await guest.wait(f => f.type === "channel" && f.channel.memberIds.includes(me.id));

  // a client sending a whole channel object with itself as owner changes nothing:
  // there is no frame that accepts one, and the role lives in its own table
  assert.equal(relay.store.memberRole(general.id, me.id), "member");
  await refuses(guest, { type: "setChannelInfo", channelId: general.id, description: "mine" },
    "you don't run this conversation");
  assert.equal(relay.store.memberRole(general.id, me.id), "member");

  guest.close(); owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// 3. Browse and join
// ---------------------------------------------------------------------------

test("a private room cannot be browsed, and an open one can be joined", async () => {
  const { relay, url, owner, general } = await stand("ch-browse.db");
  const { guest, me } = await guestOf(url, owner, "Raj");

  owner.send({ type: "createChannel", name: "hidden", memberIds: [], kind: "channel" });
  const hidden = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "hidden")).channel;
  owner.send({ type: "createChannel", name: "lounge", memberIds: [], kind: "channel" });
  const lounge = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "lounge")).channel;

  owner.send({ type: "setChannelInfo", channelId: lounge.id, description: "anything goes" });
  owner.send({ type: "setChannelVisibility", channelId: lounge.id, visibility: "open" });
  await owner.wait(f => f.type === "channel" && f.channel.id === lounge.id && f.channel.visibility === "open");

  guest.frames.length = 0;
  guest.send({ type: "browseChannels" });
  const dir = await guest.wait<Extract<ServerFrame, { type: "channelDirectory" }>>(
    f => f.type === "channelDirectory");
  assert.deepEqual(dir.channels.map(c => c.name), ["lounge"], "a private room is not findable");
  assert.equal(dir.channels[0].description, "anything goes");
  assert.equal(dir.channels[0].memberCount, 1);
  assert.ok(!("memberIds" in dir.channels[0]), "browsing never hands over who is in a room");

  // a room you were not allowed to find cannot be joined by naming its id
  await refuses(guest, { type: "joinChannel", channelId: hidden.id }, "no such channel");

  guest.frames.length = 0;
  guest.send({ type: "joinChannel", channelId: lounge.id });
  const joined = await guest.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.id === lounge.id);
  assert.ok(joined.channel.memberIds.includes(me.id));
  const row = relay.store.channelMembers(lounge.id).find(m => m.memberId === me.id)!;
  assert.equal(row.role, "member");
  assert.equal(row.invitedBy, undefined, "letting yourself in has no inviter");

  // now they are in it, they can talk in it
  guest.send({ type: "send", channelId: lounge.id, text: "hello" });
  await guest.wait(f => f.type === "message" && f.message.text === "hello");

  guest.close(); owner.close(); relay.close();
});

test("an open room is still not readable until you actually join it", async () => {
  const { relay, url, owner } = await stand("ch-openreads.db");
  const { guest } = await guestOf(url, owner, "Raj");

  owner.send({ type: "createChannel", name: "lounge", memberIds: [], kind: "channel" });
  const lounge = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "lounge")).channel;
  owner.send({ type: "setChannelVisibility", channelId: lounge.id, visibility: "open" });
  await owner.wait(f => f.type === "channel" && f.channel.id === lounge.id && f.channel.visibility === "open");
  owner.send({ type: "send", channelId: lounge.id, text: "a secret" });
  await owner.wait(f => f.type === "message" && f.message.text === "a secret");

  // BEING ABLE TO FIND A ROOM IS NOT PERMISSION TO READ IT. Opening a room
  // must not widen the gate every other frame goes through.
  await refuses(guest, { type: "history", channelId: lounge.id }, "no such channel");
  await refuses(guest, { type: "send", channelId: lounge.id, text: "hi" }, "no such channel");
  await refuses(guest, { type: "search", query: "secret", channelId: lounge.id }, "no such channel");
  await refuses(guest, { type: "channelMembers", channelId: lounge.id }, "no such channel");

  guest.close(); owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// 4. Archive
// ---------------------------------------------------------------------------

test("an archived room is read-only, not deleted — and can be reopened", async () => {
  const { relay, owner, general } = await stand("ch-archive.db");
  owner.send({ type: "send", channelId: general.id, text: "before" });
  const said = await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.text === "before");

  owner.send({ type: "archiveChannel", channelId: general.id, archived: true });
  const arch = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.id === general.id && !!f.channel.archivedAt);
  assert.ok(arch.channel.archivedAt! > 0);

  // nothing new can be said, in any of the ways there are to say something
  await refuses(owner, { type: "send", channelId: general.id, text: "after" }, "archived");
  await refuses(owner, { type: "react", messageId: said.message.id, emoji: "👍" }, "archived");
  await refuses(owner, { type: "editMessage", messageId: said.message.id, text: "changed" }, "archived");
  await refuses(owner, { type: "deleteMessage", messageId: said.message.id }, "archived");
  await refuses(owner,
    { type: "uploadAttachment", channelId: general.id, name: "a.txt", dataBase64: Buffer.from("x").toString("base64") },
    "archived");

  // but it is still all there to read
  owner.frames.length = 0;
  owner.send({ type: "history", channelId: general.id });
  const page = await owner.wait<Extract<ServerFrame, { type: "history" }>>(f => f.type === "history");
  assert.ok(page.messages.some(m => m.text === "before"), "archiving keeps the conversation");

  // and it is not a one-way door
  owner.frames.length = 0;
  owner.send({ type: "archiveChannel", channelId: general.id, archived: false });
  await owner.wait(f => f.type === "channel" && f.channel.id === general.id && !f.channel.archivedAt);
  owner.send({ type: "send", channelId: general.id, text: "after all" });
  await owner.wait(f => f.type === "message" && f.message.text === "after all");

  owner.close(); relay.close();
});

test("an archived room disappears from the browse list", async () => {
  const { relay, url, owner } = await stand("ch-archbrowse.db");
  const { guest } = await guestOf(url, owner, "Raj");
  owner.send({ type: "createChannel", name: "lounge", memberIds: [], kind: "channel" });
  const lounge = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "lounge")).channel;
  owner.send({ type: "setChannelVisibility", channelId: lounge.id, visibility: "open" });
  await owner.wait(f => f.type === "channel" && f.channel.id === lounge.id && f.channel.visibility === "open");
  owner.send({ type: "archiveChannel", channelId: lounge.id, archived: true });
  await owner.wait(f => f.type === "channel" && f.channel.id === lounge.id && !!f.channel.archivedAt);

  guest.frames.length = 0;
  guest.send({ type: "browseChannels" });
  const dir = await guest.wait<Extract<ServerFrame, { type: "channelDirectory" }>>(
    f => f.type === "channelDirectory");
  assert.deepEqual(dir.channels, [], "a retired room is not on offer");
  await refuses(guest, { type: "joinChannel", channelId: lounge.id }, "no such channel");

  guest.close(); owner.close(); relay.close();
});

test("a direct conversation has no settings and cannot be left", async () => {
  const { relay, url, owner } = await stand("ch-dm.db");
  const { guest, me } = await guestOf(url, owner, "Raj");
  owner.send({ type: "createChannel", name: "dm-raj", memberIds: [me.id], kind: "dm" });
  const dm = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.kind === "dm")).channel;

  await refuses(owner, { type: "setChannelInfo", channelId: dm.id, topic: "us" },
    "a direct conversation has no settings");
  await refuses(owner, { type: "archiveChannel", channelId: dm.id, archived: true },
    "a direct conversation has no settings");
  await refuses(owner, { type: "leaveChannel", channelId: dm.id },
    "you can't leave a direct conversation");

  guest.close(); owner.close(); relay.close();
});

test("a room's own words are bounded, and a topic is one line", async () => {
  const { relay, owner, general } = await stand("ch-limits.db");
  await refuses(owner, { type: "setChannelInfo", channelId: general.id, topic: "a\nb" },
    "a topic is one line");
  await refuses(owner, { type: "setChannelInfo", channelId: general.id, topic: "x".repeat(500) },
    "too long");
  await refuses(owner, { type: "setChannelInfo", channelId: general.id, description: "x".repeat(5000) },
    "too long");
  await refuses(owner, { type: "setChannelVisibility", channelId: general.id, visibility: "public" as never },
    "either open or private");
  owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// 5. The migration — v2 → v3, and the proof it loses nothing
// ---------------------------------------------------------------------------

/**
 * Roll a real v3 database back to exactly the shape a v2 build left behind:
 * the membership rows gone, the version stamp back to 2, and the member lists
 * living only inside the channel JSON where they used to.
 */
function downgradeToV2(dbPath: string): Map<string, string[]> {
  const db = new DatabaseSync(dbPath);
  const before = new Map<string, string[]>();
  for (const r of db.prepare("SELECT id,json FROM channels").all() as { id: string; json: string }[]) {
    before.set(r.id, [...((JSON.parse(r.json) as Channel).memberIds ?? [])].sort());
  }
  db.exec("DELETE FROM channel_members");
  db.prepare("INSERT INTO meta(key,value) VALUES('schemaVersion','2') " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  db.close();
  return before;
}

function memberRows(dbPath: string): ChannelMember[] {
  const db = new DatabaseSync(dbPath);
  const rows = db.prepare(
    "SELECT channelId,memberId,role,joinedAt,invitedBy,removedAt,removedBy FROM channel_members " +
    "ORDER BY channelId, memberId").all() as unknown as ChannelMember[];
  db.close();
  return rows;
}

test("the v2 → v3 migration moves every member across and loses nothing", async () => {
  const dbPath = tmp("ch-migrate.db");
  const relay = new Relay({ dbPath, ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const w = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const general = w.state.channels.find(c => c.name === "general")!;

  // a house with some history in it: two friends, three rooms, a DM
  const guests: string[] = [];
  let last: string | undefined;
  for (const name of ["Raj", "Neha"]) {
    owner.send({ type: "createInvite" });
    const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(
      f => f.type === "invite" && f.code !== last);
    last = inv.code;
    const g = new TestClient(url, `invite:${inv.code}:${name}`);
    const gw = await g.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
    guests.push(gw.state.me.id);
    g.close();
  }
  owner.send({ type: "createChannel", name: "trip", memberIds: guests, kind: "channel" });
  await owner.wait(f => f.type === "channel" && f.channel.name === "trip");
  owner.send({ type: "createChannel", name: "dm-raj", memberIds: [guests[0]], kind: "dm" });
  await owner.wait(f => f.type === "channel" && f.channel.kind === "dm");
  owner.send({ type: "send", channelId: general.id, text: "hello all" });
  await owner.wait(f => f.type === "message");

  const channelCount = relay.store.channels().length;
  const messageCount = relay.store.history(general.id, {}, 200).items.length;
  owner.close();
  relay.close();
  await new Promise(r => setTimeout(r, 50));

  // ---- roll back to v2 and migrate forward again ----
  const before = downgradeToV2(dbPath);
  assert.equal(before.size, 3, "the fixture is #general, a channel and a DM");
  assert.equal(before.get(general.id)!.length, 3, "#general holds the owner and both friends");

  const migrated = new Relay({ dbPath, ownerToken: "tok-owner", ownerName: "Vikas" });
  await migrated.listen(0);

  assert.equal(migrated.store.schemaVersion(), SCHEMA_VERSION, "the stepper ran");
  assert.equal(migrated.store.channels().length, channelCount, "no room was lost");
  assert.equal(migrated.store.history(general.id, {}, 200).items.length, messageCount,
    "no message was lost");

  // THE LOSSLESSNESS PROOF: the derived member list of every room, built from
  // the new rows, equals the list the v2 file held inside the channel JSON.
  for (const ch of migrated.store.channels()) {
    assert.deepEqual([...ch.memberIds].sort(), before.get(ch.id),
      `room ${ch.name} came across with a different member list`);
    for (const m of migrated.store.channelMembers(ch.id)) {
      // joinedAt is the room's own createdAt — the only honest answer, since a
      // v2 database never recorded when anybody arrived
      assert.equal(m.joinedAt, ch.createdAt, "joinedAt is the room's creation date, not 'now'");
      assert.equal(m.removedAt, undefined, "nobody was marked as having left");
      assert.equal(m.invitedBy, undefined, "a v2 database knew of no inviter, so none is invented");
    }
    const ownerRole = migrated.store.memberRole(ch.id, migrated.ownerId);
    if (ch.kind === "dm") {
      assert.equal(ownerRole, "member", "a direct conversation has nothing to administer");
    } else {
      assert.equal(ownerRole, "owner", "the person who runs this Cloud9 runs its rooms");
    }
    for (const other of ch.memberIds.filter(id => id !== migrated.ownerId)) {
      assert.equal(migrated.store.memberRole(ch.id, other), "member",
        "nobody is handed a power a v2 database never recorded them having");
    }
  }
  const afterFirst = memberRows(dbPath);
  migrated.close();
  await new Promise(r => setTimeout(r, 50));

  // ---- RE-RUNNABLE: opening it again changes not one row ----
  const again = new Relay({ dbPath, ownerToken: "tok-owner", ownerName: "Vikas" });
  await again.listen(0);
  assert.equal(again.store.schemaVersion(), SCHEMA_VERSION);
  assert.deepEqual(memberRows(dbPath), afterFirst,
    "running the migration a second time must be a no-op — a half-applied one is the worst state there is");
  again.close();
  await new Promise(r => setTimeout(r, 50));

  // ---- and re-running the STEP itself, on an already-migrated database ----
  const third = new Store(dbPath);
  third.db.prepare("INSERT INTO meta(key,value) VALUES('schemaVersion','2') " +
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  third.db.close();
  const forced = new Store(dbPath);
  assert.equal(forced.schemaVersion(), SCHEMA_VERSION);
  assert.deepEqual(memberRows(dbPath), afterFirst,
    "the backfill step is INSERT OR IGNORE, so a forced re-run cannot rewrite a joinedAt or a role");
  forced.db.close();
});

test("a database from BEFORE the ledger can still be opened at all", () => {
  // Found by running the migration against a copy of the real cloud9-relay.db,
  // which is older than the ledger: `CREATE TABLE IF NOT EXISTS` does nothing
  // to a table that already exists, so `activity` had no `seq` column — and the
  // unique index over `activity(seq)` used to sit ABOVE the migration that adds
  // it. Opening the file threw "no such column: seq" and the hub could not read
  // its own older database.
  //
  // The class rule this pins: an index over a column a migration adds is built
  // after the migration, never in the CREATE block.
  const dbPath = tmp("ch-preledger.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE activity(id TEXT PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE TABLE channels(id TEXT PRIMARY KEY, json TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO activity(id,ts,json) VALUES(?,?,?)").run("act_old", 1, JSON.stringify({
    id: "act_old", ts: 1, actorKind: "human", actorId: "u", actorName: "Vikas",
    kind: "message", detail: "an old line",
  }));
  db.prepare("INSERT INTO channels(id,json) VALUES(?,?)").run("ch_old", JSON.stringify({
    id: "ch_old", name: "general", kind: "channel", memberIds: ["u1", "u2"], createdAt: 111,
  }));
  db.close();

  const store = new Store(dbPath);
  assert.equal(store.schemaVersion(), SCHEMA_VERSION, "it came all the way forward in one go");
  assert.equal(store.verifyActivity(), null, "and the old trail was chained on the way through");
  assert.deepEqual(store.liveMemberIds("ch_old"), ["u1", "u2"], "and the members came across");
  store.db.close();
});

test("a v2 database still carries its member lists in the channel JSON, for one release", async () => {
  const dbPath = tmp("ch-wire.db");
  const relay = new Relay({ dbPath, ownerToken: "tok-owner", ownerName: "Vikas" });
  await relay.listen(0);
  const general = relay.store.channels()[0];
  // an older build reads memberIds out of the JSON; it must still find them
  const raw = JSON.parse(
    (relay.store.db.prepare("SELECT json FROM channels WHERE id=?").get(general.id) as { json: string }).json,
  ) as Channel;
  assert.deepEqual(raw.memberIds, general.memberIds,
    "the derived list and the stored list agree — nothing breaks for a client that has not caught up");
  relay.close();
});
