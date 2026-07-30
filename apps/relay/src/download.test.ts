// Getting an attached file's BYTES back out of the hub.
//
// The whole design in one sentence: you ask for the file on the socket you are
// already signed in on, the relay answers with a ticket that is good for one
// file, once, for thirty seconds, and the permission is checked again when the
// ticket is spent. These tests pin all four of those, plus the two ways this
// could have become a hole — a type chosen by the uploader, and a name that
// points somewhere else.
//
// Every test here failed before the change it covers landed.
import test from "node:test";
import assert from "node:assert/strict";
import { ATTACHMENT_TICKET, ServerFrame } from "@cloud9/shared";
import { Relay, attachmentTicketFrom } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

async function stand(name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const http = `http://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const general = welcome.state.channels.find(c => c.name === "general")!;
  return { relay, url, http, owner, general, me: welcome.state.me };
}

async function guestOf(url: string, owner: TestClient, name: string, notCode?: string) {
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(
    f => f.type === "invite" && f.code !== notCode);
  const guest = new TestClient(url, `invite:${inv.code}:${name}`);
  const w = await guest.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { guest, me: w.state.me, code: inv.code };
}

/** Park a file and send it, so it is a real attachment on a real message. */
async function attach(client: TestClient, channelId: string, name: string, body: string, mime?: string) {
  client.send({
    type: "uploadAttachment", channelId, name,
    dataBase64: Buffer.from(body).toString("base64"),
    ...(mime ? { mime } : {}),
  });
  const parked = await client.wait<Extract<ServerFrame, { type: "attachment" }>>(
    f => f.type === "attachment");
  client.send({ type: "send", channelId, text: "have a look", attachmentIds: [parked.attachment.id] });
  await client.wait(f => f.type === "message" && f.message.text === "have a look");
  return parked.attachment;
}

async function ticketFor(client: TestClient, attachmentId: string) {
  client.frames.length = 0;
  client.send({ type: "attachmentTicket", attachmentId });
  return client.wait<Extract<ServerFrame, { type: "attachmentTicket" }>>(
    f => f.type === "attachmentTicket");
}

async function refuses(client: TestClient, frame: Parameters<TestClient["send"]>[0], contains: string) {
  client.frames.length = 0;
  client.send(frame);
  const err = await client.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(err.error.includes(contains), `expected "${contains}", got "${err.error}"`);
}

// ---------------------------------------------------------------------------

test("a member of the room gets the bytes, once, with a type the hub chose", async () => {
  const { relay, http, owner, general } = await stand("dl-happy.db");
  const file = await attach(owner, general.id, "notes.txt", "the plan is fine");

  const t = await ticketFor(owner, file.id);
  assert.equal(t.url, ATTACHMENT_TICKET.path + t.ticket);
  assert.ok(t.expiresAt > Date.now() && t.expiresAt <= Date.now() + ATTACHMENT_TICKET.ttlMs + 1000);

  const res = await fetch(http + t.url);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "the plan is fine");
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  // the header now carries the RFC 5987 form as well, because the file rule
  // (correctly) accepts names a Latin-1 header cannot hold on its own
  assert.equal(res.headers.get("content-disposition"),
    `inline; filename="notes.txt"; filename*=UTF-8''notes.txt`);
  assert.equal(res.headers.get("cache-control"), "no-store");

  // ONE USE. The second request gets nothing, so a ticket sitting in a log line
  // or a browser history is already spent.
  const again = await fetch(http + t.url);
  assert.equal(again.status, 404);

  owner.close(); relay.close();
});

test("a ticket that has run out of time is worth nothing", async () => {
  const { relay, http, owner, general } = await stand("dl-expiry.db");
  const file = await attach(owner, general.id, "notes.txt", "hello");
  const t = await ticketFor(owner, file.id);

  // wind the clock forward on the ticket itself rather than waiting 30 seconds
  const held = (relay as unknown as {
    tickets: Map<string, { attachmentId: string; userId: string; expiresAt: number }>;
  }).tickets;
  held.get(t.ticket)!.expiresAt = Date.now() - 1;

  assert.equal((await fetch(http + t.url)).status, 404);
  owner.close(); relay.close();
});

test("a made-up ticket buys nothing, and neither does the shape of one", async () => {
  const { relay, http, owner, general } = await stand("dl-guess.db");
  await attach(owner, general.id, "notes.txt", "secret");

  for (const path of [
    ATTACHMENT_TICKET.path + "tk_aaaaaaaaaaaaaaaaaaaaaa",
    ATTACHMENT_TICKET.path + "../../cloud9-relay.db",
    ATTACHMENT_TICKET.path,
    ATTACHMENT_TICKET.path + "tk_x?and=more",
  ]) {
    const res = await fetch(http + path);
    assert.equal(res.status, 404, `${path} must not be served`);
  }
  // and the health check still answers, so the new route did not eat the old one
  assert.equal((await fetch(http + "/health")).status, 200);

  owner.close(); relay.close();
});

test("someone who cannot see the conversation cannot get the file", async () => {
  const { relay, url, http, owner } = await stand("dl-outsider.db");
  // a room of the owner's own — a redeemed invite lands in #general, so the
  // file has to live somewhere the guest was never put
  owner.send({ type: "createChannel", name: "ops", memberIds: [], kind: "channel" });
  const ops = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "ops")).channel;
  const file = await attach(owner, ops.id, "notes.txt", "private");
  const { guest } = await guestOf(url, owner, "Raj");

  // the guest is signed in to this Cloud9 but is not in the room
  await refuses(guest, { type: "attachmentTicket", attachmentId: file.id }, "no such file");

  // and there is no second way in: the HTTP route only takes tickets
  assert.equal((await fetch(http + ATTACHMENT_TICKET.path + "tok-owner")).status, 404);

  guest.close(); owner.close(); relay.close();
});

test("being thrown out of the room between asking and fetching stops the download", async () => {
  const { relay, url, http, owner, general } = await stand("dl-revoke.db");
  const { guest, me } = await guestOf(url, owner, "Raj");
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [me.id] });
  await guest.wait(f => f.type === "channel" && f.channel.memberIds.includes(me.id));

  const file = await attach(owner, general.id, "notes.txt", "still readable?");
  await guest.wait(f => f.type === "message" && f.message.text === "have a look");

  // they ask while they are still in the room, so the ticket is honestly minted
  const t = await ticketFor(guest, file.id);

  // …and are removed before they spend it
  owner.send({ type: "removeMember", channelId: general.id, memberId: me.id });
  await owner.wait(f => f.type === "channel" && !f.channel.memberIds.includes(me.id));

  // PERMISSION IS CHECKED AGAIN AT REDEEM. A ticket is not a promise.
  assert.equal((await fetch(http + t.url)).status, 404);

  guest.close(); owner.close(); relay.close();
});

test("the sender does not get to choose how the file is treated", async () => {
  const { relay, http, owner, general } = await stand("dl-type.db");
  // a text file that CLAIMS to be a web page — the mime is display text and has
  // never been allowed to decide anything
  const evil = await attach(owner, general.id, "readme.txt", "<script>alert(1)</script>", "text/html");
  const t = await ticketFor(owner, evil.id);
  const res = await fetch(http + t.url);
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8",
    "the type comes from the name the relay validated, never from what the sender said");
  assert.ok(res.headers.get("content-security-policy")!.includes("default-src 'none'"));

  // and something the hub will not vouch for is handed over as bytes to save
  const zip = await attach(owner, general.id, "bundle.zip", "PK");
  const t2 = await ticketFor(owner, zip.id);
  const res2 = await fetch(http + t2.url);
  assert.equal(res2.headers.get("content-type"), "application/octet-stream");
  assert.equal(res2.headers.get("content-disposition"),
    `attachment; filename="bundle.zip"; filename*=UTF-8''bundle.zip`);

  owner.close(); relay.close();
});

test("a stored name that could not pass the file-name rule is never served", async () => {
  const { relay, http, owner, general } = await stand("dl-badname.db");
  const file = await attach(owner, general.id, "notes.txt", "hello");

  // simulate a row written by some older or badly-behaved build: the name rule
  // is asked again on the way OUT, so the bad row cannot become a header or a
  // file on somebody's disk
  const row = relay.store.attachment(file.id)!;
  const tampered = { ...row.attachment, name: "../../evil.txt" };
  relay.store.db.prepare("UPDATE attachments SET json=? WHERE id=?")
    .run(JSON.stringify(tampered), file.id);

  const t = await ticketFor(owner, file.id);
  assert.equal((await fetch(http + t.url)).status, 404);

  owner.close(); relay.close();
});

test("a parked file nobody has sent yet is only its uploader's business", async () => {
  const { relay, url, owner, general } = await stand("dl-parked.db");
  const { guest, me } = await guestOf(url, owner, "Raj");
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [me.id] });
  await guest.wait(f => f.type === "channel" && f.channel.memberIds.includes(me.id));

  // the owner parks a file but never sends it
  owner.send({
    type: "uploadAttachment", channelId: general.id, name: "draft.txt",
    dataBase64: Buffer.from("not ready").toString("base64"),
  });
  const parked = await owner.wait<Extract<ServerFrame, { type: "attachment" }>>(
    f => f.type === "attachment");

  // sharing the room is not enough — nothing has been said with it yet
  await refuses(guest, { type: "attachmentTicket", attachmentId: parked.attachment.id }, "no such file");
  // the uploader can still fetch their own
  const t = await ticketFor(owner, parked.attachment.id);
  assert.ok(t.ticket.length > 16);

  guest.close(); owner.close(); relay.close();
});

test("only a GET at exactly the ticket path is a ticket at all", () => {
  const at = (method: string, url: string) =>
    attachmentTicketFrom({ method, url } as never);
  assert.equal(at("POST", ATTACHMENT_TICKET.path + "tk_aaaaaaaaaaaaaaaaaaaa"), undefined);
  assert.equal(at("GET", "/health"), undefined);
  assert.equal(at("GET", "/attachmentsomething"), undefined);
  assert.equal(at("GET", ATTACHMENT_TICKET.path + "tk_aaaaaaaaaaaaaaaaaaaa"),
    "tk_aaaaaaaaaaaaaaaaaaaa");
  // anything that isn't the shape we mint is refused rather than tidied up
  assert.equal(at("GET", ATTACHMENT_TICKET.path + "tk_a/../../etc/passwd"), "");
  assert.equal(at("GET", ATTACHMENT_TICKET.path + "tk_aaaaaaaaaaaaaaaaaaaa?x=1"), "");
});

test("one person cannot mint an unbounded pile of tickets", async () => {
  const { relay, owner, general } = await stand("dl-cap.db");
  const file = await attach(owner, general.id, "notes.txt", "hello");
  for (let i = 0; i < ATTACHMENT_TICKET.perUser; i++) await ticketFor(owner, file.id);
  await refuses(owner, { type: "attachmentTicket", attachmentId: file.id }, "too many files");
  owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// The app is never on the hub's origin — and it has to be able to READ the
// answer, not just cause it. Both of these failed before `attachmentCors`.
// ---------------------------------------------------------------------------

test("the app can read the bytes from its own origin, and from file:// too", async () => {
  const { relay, http, owner, general } = await stand("dl-cors.db");
  const file = await attach(owner, general.id, "notes.txt", "the plan is fine");

  // the dev/QA origin
  const t1 = await ticketFor(owner, file.id);
  const web = await fetch(http + t1.url, { headers: { origin: "http://127.0.0.1:4173" } });
  assert.equal(web.status, 200);
  assert.equal(web.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");
  assert.equal(web.headers.get("vary"), "Origin");
  // the load-bearing half: no ambient authority may ever ride along
  assert.equal(web.headers.get("access-control-allow-credentials"), null);
  assert.equal(await web.text(), "the plan is fine");

  // the packaged app, whose origin is the literal string "null"
  const t2 = await ticketFor(owner, file.id);
  const packaged = await fetch(http + t2.url, { headers: { origin: "null" } });
  assert.equal(packaged.status, 200);
  assert.equal(packaged.headers.get("access-control-allow-origin"), "null");

  // an expired link must be READABLE as a 404, or the app cannot re-ticket
  const dead = await fetch(http + t2.url, { headers: { origin: "http://127.0.0.1:4173" } });
  assert.equal(dead.status, 404);
  assert.equal(dead.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");

  // and a request that names no origin gets no header — none is needed
  const t3 = await ticketFor(owner, file.id);
  const plain = await fetch(http + t3.url);
  assert.equal(plain.headers.get("access-control-allow-origin"), null);

  owner.close(); relay.close();
});

test("no other route in the hub answers a cross-origin read", async () => {
  const { relay, http, owner } = await stand("dl-cors-only.db");
  const from = { headers: { origin: "http://127.0.0.1:4173" } };

  const health = await fetch(`${http}/health`, from);
  assert.equal(health.status, 200);
  assert.equal(health.headers.get("access-control-allow-origin"), null,
    "one response, one reason — the header does not spread");

  const nothing = await fetch(`${http}/whatever`, from);
  assert.equal(nothing.status, 404);
  assert.equal(nothing.headers.get("access-control-allow-origin"), null);

  owner.close(); relay.close();
});
