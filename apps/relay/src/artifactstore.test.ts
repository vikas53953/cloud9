// THE SHARED ARTIFACT STORE, on the hub — the #1 gap from the owner's own
// agents' gap analysis, run inside Cloud9.
//
// What it was: an agent finished a piece of work, and the only way it could hand
// the file over was to paste `C:\Users\vikasmit\…` into the chat. Nobody else
// could open that — not another agent, not the owner on another machine, not a
// friend. Four times in one evening he answered "the file's on disk".
//
// What it is now: the file lands IN the conversation, with the agent's name and
// the run that made it on it, with every older version kept, and with the same
// one-use download ticket a person's attachment already used. This file proves
// that, and proves the three ways it could have become a hole: a screen able to
// publish under an agent's name, a stranger able to read a room's files, and a
// version number a producer could choose.
//
// EVERY TEST HERE WAS WATCHED TO FAIL with the feature broken on purpose. The
// break is named beside each one.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  ARTIFACT_LIMITS, ATTACHMENT_TICKET, ServerFrame, artifactRef, findArtifactRefs, latestVersion,
} from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "🔭", persona: "You write things down",
  abilities: { webSearch: false, files: true, schedules: false, background: false },
};

async function stand(name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const http = `http://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const hello = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  // the engine host is a SECOND connection for the same person, exactly as it
  // runs in the real app — and the only client allowed to publish a file
  const engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  const general = hello.state.channels.find(c => c.name === "general")!;
  return { relay, url, http, owner, engine, general, me: hello.state.me };
}

async function makeAgent(client: TestClient, name: string) {
  client.send({ type: "createAgent", agent: { ...BASE_AGENT, name } });
  const frame = await client.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === name);
  return frame.agent;
}

async function guestOf(url: string, owner: TestClient, name: string) {
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const guest = new TestClient(url, `invite:${inv.code}:${name}`);
  const w = await guest.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { guest, me: w.state.me };
}

/** Publish one file as an agent, the way the engine does, and wait for the frame. */
async function publish(
  engine: TestClient, watcher: TestClient,
  input: { channelId: string; agentId: string; name: string; body: string | Buffer;
           runId?: string; taskId?: string; note?: string },
) {
  watcher.frames.length = 0;
  const bytes = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body);
  engine.send({
    type: "publishArtifact", channelId: input.channelId, agentId: input.agentId,
    name: input.name, dataBase64: bytes.toString("base64"),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.note ? { note: input.note } : {}),
  });
  // waits for the artifact frame OR the refusal, so a broken publish fails with
  // the hub's own sentence rather than with "timeout waiting for frame"
  const answer = await watcher.wait<ServerFrame>(
    f => f.type === "artifact" || f.type === "error");
  if (answer.type === "error") throw new Error(`the hub refused the publish: ${answer.error}`);
  return answer as Extract<ServerFrame, { type: "artifact" }>;
}

async function refuses(client: TestClient, frame: Parameters<TestClient["send"]>[0], contains: string) {
  client.frames.length = 0;
  client.send(frame);
  const err = await client.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(err.error.includes(contains), `expected "${contains}", got "${err.error}"`);
}

// ---------------------------------------------------------------------------
// The whole point: the file is IN the conversation, and it says who made it
// ---------------------------------------------------------------------------

test("a file an agent made lands in the room, with the agent and the run on it", async () => {
  const { relay, owner, engine, general, me } = await stand("art-happy.db");
  const agent = await makeAgent(owner, "Scribe");

  const frame = await publish(engine, owner, {
    channelId: general.id, agentId: agent.id, name: "villas.md",
    body: "# three villas in Goa\n", runId: "r-abc-0001", note: "first draft",
  });

  const artifact = frame.artifact;
  assert.equal(artifact.channelId, general.id);
  assert.equal(artifact.name, "villas.md");
  assert.equal(artifact.versions.length, 1);
  const v = latestVersion(artifact)!;
  assert.equal(v.version, 1);
  // ATTRIBUTION — the thing a pasted path could never carry
  assert.equal(v.agentId, agent.id);
  assert.equal(v.agentName, "Scribe");
  assert.equal(v.ownerId, me.id);
  assert.equal(v.runId, "r-abc-0001", "the file and the record of the turn join up");
  assert.equal(v.note, "first draft");
  assert.equal(v.size, Buffer.from("# three villas in Goa\n").length);
  assert.equal(v.text, true, "the hub read the bytes and found text");
  assert.equal(v.sha256, createHash("sha256").update("# three villas in Goa\n").digest("hex"),
    "the sha is computed from the bytes the HUB stored, never claimed by the producer");
  // and a stable reference a message can carry
  assert.deepEqual(findArtifactRefs(`here it is: ${artifactRef(artifact.id)}`),
    [{ artifactId: artifact.id }]);

  // the bytes really are on this machine, under a name the hub chose
  const stored = path.join(relay.store.artifactsDir, v.storedAs);
  assert.equal(fs.readFileSync(stored, "utf8"), "# three villas in Goa\n");
  assert.ok(v.storedAs.startsWith(`${v.id}-`) && v.storedAs.endsWith("villas.md"),
    "the stored name is built by the HUB from an id it minted — never a name a client chose");

  owner.close(); engine.close(); relay.close();
  // BREAK: send the frame only to the engine that published it and this fails on
  // the very first wait — which was the old world, where the file existed and
  // nobody could see it. Watched.
});

test("the same name again is a NEW VERSION, and the old one is still there", async () => {
  const { relay, owner, engine, general } = await stand("art-versions.db");
  const agent = await makeAgent(owner, "Scribe");

  const first = await publish(engine, owner,
    { channelId: general.id, agentId: agent.id, name: "report.md", body: "draft one" });
  const second = await publish(engine, owner,
    { channelId: general.id, agentId: agent.id, name: "report.md", body: "draft two", note: "fixed the numbers" });

  assert.equal(second.artifact.id, first.artifact.id, "one file, not two with one name");
  assert.deepEqual(second.artifact.versions.map(v => v.version), [2, 1],
    "newest first, and version 1 is KEPT — the evening where the file changed four times");
  assert.equal(latestVersion(second.artifact)!.note, "fixed the numbers");
  assert.notEqual(second.artifact.versions[0].id, second.artifact.versions[1].id);
  assert.equal(second.artifact.createdAt, first.artifact.createdAt);
  assert.ok(second.artifact.updatedAt >= first.artifact.updatedAt);

  // A DIFFERENT SPELLING IS THE SAME FILE — `nameKey`, the same rule that makes
  // two agents called `Scout` a refusal. The file KEEPS the name it was first
  // given: a new version is not a licence to rename the thing in his list.
  const third = await publish(engine, owner,
    { channelId: general.id, agentId: agent.id, name: "Report.md", body: "draft three" });
  assert.equal(third.artifact.id, first.artifact.id);
  assert.equal(third.artifact.name, "report.md", "the name it was first given stands");
  assert.equal(latestVersion(third.artifact)!.version, 3);

  owner.close(); engine.close(); relay.close();
  // BREAK: mint a new artifact row per publish and this fails on `second.artifact.id`
  // — two files with one name, and a list nobody can read. Watched.
});

test("the conversation's list holds every artifact, most recently changed first", async () => {
  const { relay, owner, engine, general } = await stand("art-list.db");
  const agent = await makeAgent(owner, "Scribe");

  await publish(engine, owner, { channelId: general.id, agentId: agent.id, name: "a.md", body: "a" });
  await publish(engine, owner, { channelId: general.id, agentId: agent.id, name: "b.md", body: "b" });
  await publish(engine, owner, { channelId: general.id, agentId: agent.id, name: "a.md", body: "a again" });

  owner.frames.length = 0;
  owner.send({ type: "artifacts", channelId: general.id });
  const list = await owner.wait<Extract<ServerFrame, { type: "artifacts" }>>(f => f.type === "artifacts");
  assert.deepEqual(list.artifacts.map(a => a.name), ["a.md", "b.md"],
    "a.md was touched last, so it is first — two files, not three");
  assert.equal(list.artifacts[0].versions.length, 2);

  // one by id, with its whole history
  owner.frames.length = 0;
  owner.send({ type: "artifact", artifactId: list.artifacts[0].id });
  const one = await owner.wait<Extract<ServerFrame, { type: "artifact" }>>(f => f.type === "artifact");
  assert.deepEqual(one.artifact.versions.map(v => v.version), [2, 1]);

  owner.close(); engine.close(); relay.close();
});

// ---------------------------------------------------------------------------
// Getting the bytes back — the SAME ticket a person's attachment uses
// ---------------------------------------------------------------------------

test("a member of the room gets the bytes, once, and an old version stays itself", async () => {
  const { relay, http, owner, engine, general } = await stand("art-download.db");
  const agent = await makeAgent(owner, "Scribe");
  await publish(engine, owner, { channelId: general.id, agentId: agent.id, name: "notes.txt", body: "version one" });
  const two = await publish(engine, owner,
    { channelId: general.id, agentId: agent.id, name: "notes.txt", body: "version two" });
  const id = two.artifact.id;

  owner.frames.length = 0;
  owner.send({ type: "artifactTicket", artifactId: id });
  const t = await owner.wait<Extract<ServerFrame, { type: "artifactTicket" }>>(
    f => f.type === "artifactTicket");
  assert.equal(t.version, 2, "no version asked for means the newest");
  assert.equal(t.url, ATTACHMENT_TICKET.path + t.ticket, "ONE download endpoint, not a second one");
  assert.ok(t.expiresAt > Date.now() && t.expiresAt <= Date.now() + ATTACHMENT_TICKET.ttlMs + 1000);

  const res = await fetch(http + t.url);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "version two");
  assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.equal(res.headers.get("content-disposition"),
    `inline; filename="notes.txt"; filename*=UTF-8''notes.txt`,
    "the name a person sees is the SHARED name, not the hub's stored one");

  // ONE USE — a ticket in a log line is already spent
  assert.equal((await fetch(http + t.url)).status, 404);

  // AND VERSION 1 IS STILL ITSELF. This is what version history is FOR.
  owner.frames.length = 0;
  owner.send({ type: "artifactTicket", artifactId: id, version: 1 });
  const old = await owner.wait<Extract<ServerFrame, { type: "artifactTicket" }>>(
    f => f.type === "artifactTicket");
  assert.equal(old.version, 1);
  assert.equal(await (await fetch(http + old.url)).text(), "version one");

  owner.close(); engine.close(); relay.close();
  // BREAK: resolve a ticket to the artifact instead of to the VERSION and the
  // last line fails with "version two" — silently handing him different bytes
  // than the ones he asked for. Watched.
});

test("a version that is no longer kept SAYS SO, it is not swapped for the newest", async () => {
  const { relay, owner, engine, general } = await stand("art-gone.db");
  const agent = await makeAgent(owner, "Scribe");
  const a = await publish(engine, owner,
    { channelId: general.id, agentId: agent.id, name: "notes.txt", body: "one" });

  await refuses(owner, { type: "artifactTicket", artifactId: a.artifact.id, version: 9 },
    "version 9 of notes.txt is no longer kept");
  owner.close(); engine.close(); relay.close();
});

test("binary bytes are told apart from text, and served as a download", async () => {
  const { relay, http, owner, engine, general } = await stand("art-binary.db");
  const agent = await makeAgent(owner, "Scribe");
  // a real PNG header — NUL bytes and all
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  const made = await publish(engine, owner,
    { channelId: general.id, agentId: agent.id, name: "chart.dat", body: png });

  const v = latestVersion(made.artifact)!;
  assert.equal(v.text, false, "bytes with a NUL in them are not text, whatever anyone claims");

  owner.frames.length = 0;
  owner.send({ type: "artifactTicket", artifactId: made.artifact.id });
  const t = await owner.wait<Extract<ServerFrame, { type: "artifactTicket" }>>(
    f => f.type === "artifactTicket");
  const res = await fetch(http + t.url);
  assert.equal(res.headers.get("content-type"), "application/octet-stream",
    "an unknown type is a download and nothing more — never guessed from the bytes");
  assert.ok(res.headers.get("content-disposition")!.startsWith("attachment;"));
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), png, "the bytes come back unchanged");

  owner.close(); engine.close(); relay.close();
  // BREAK: set `text: true` from a flag on the frame and the first assert fails.
  // Watched.
});

// ---------------------------------------------------------------------------
// The three ways this could have been a hole
// ---------------------------------------------------------------------------

test("a screen cannot publish a file wearing an agent's name", async () => {
  const { relay, owner, engine, general } = await stand("art-screen.db");
  const agent = await makeAgent(owner, "Scribe");

  await refuses(owner, {
    type: "publishArtifact", channelId: general.id, agentId: agent.id,
    name: "faked.md", dataBase64: Buffer.from("I did not write this").toString("base64"),
  }, "only your own agent engine");

  owner.frames.length = 0;
  owner.send({ type: "artifacts", channelId: general.id });
  const list = await owner.wait<Extract<ServerFrame, { type: "artifacts" }>>(f => f.type === "artifacts");
  assert.deepEqual(list.artifacts, [], "and nothing was stored");

  owner.close(); engine.close(); relay.close();
  // BREAK: drop the `conn.client !== "engine"` check and this fails — the
  // attribution the whole store exists for becomes a claim anyone can make.
  // Watched.
});

test("an engine cannot publish as somebody else's agent", async () => {
  const { relay, url, owner, engine, general } = await stand("art-notmine.db");
  const { guest } = await guestOf(url, owner, "Priya");
  const hers = await makeAgent(guest, "Hera");
  // the OWNER's engine, naming HER agent
  await refuses(engine, {
    type: "publishArtifact", channelId: general.id, agentId: hers.id,
    name: "hers.md", dataBase64: Buffer.from("not mine to publish").toString("base64"),
  }, "not your agent");

  guest.close(); owner.close(); engine.close(); relay.close();
});

test("a stranger to the room cannot read its files, or learn that they exist", async () => {
  const { relay, url, owner, engine } = await stand("art-stranger.db");
  const agent = await makeAgent(owner, "Scribe");
  // A ROOM THE GUEST WAS NEVER PUT IN. A redeemed invite lands in #general, so
  // "not in the room" has to be a room of the owner's own — the same setup the
  // attachment download tests use, for the same reason.
  owner.send({ type: "createChannel", name: "ops", memberIds: [], kind: "channel" });
  const ops = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "ops")).channel;
  const made = await publish(engine, owner,
    { channelId: ops.id, agentId: agent.id, name: "private.md", body: "his numbers" });
  const { guest } = await guestOf(url, owner, "Priya");

  // the same sentence an invented id gets, so an id cannot be probed
  await refuses(guest, { type: "artifactTicket", artifactId: made.artifact.id }, "no such file");
  await refuses(guest, { type: "artifact", artifactId: made.artifact.id }, "no such file");
  await refuses(guest, { type: "artifacts", channelId: ops.id }, "no such channel");

  guest.close(); owner.close(); engine.close(); relay.close();
  // BREAK: hand `store.artifact(id)` straight back without `channelFor` and all
  // three of those become answers — a guest reading the owner's private files by
  // guessing an id. Watched.
});

test("a ticket dies with the membership it was minted under", async () => {
  const { relay, url, http, owner, engine, general } = await stand("art-revoked.db");
  const agent = await makeAgent(owner, "Scribe");
  const { guest, me } = await guestOf(url, owner, "Priya");
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [me.id] });
  await guest.wait(f => f.type === "channel"
    && (f as Extract<ServerFrame, { type: "channel" }>).channel.memberIds.includes(me.id));

  const made = await publish(engine, guest,
    { channelId: general.id, agentId: agent.id, name: "shared.md", body: "everyone in here may read this" });

  guest.frames.length = 0;
  guest.send({ type: "artifactTicket", artifactId: made.artifact.id });
  const t = await guest.wait<Extract<ServerFrame, { type: "artifactTicket" }>>(
    f => f.type === "artifactTicket");

  // THE GATE IS ASKED AGAIN WHEN THE TICKET IS SPENT, not only when it is minted
  owner.send({ type: "removeMember", channelId: general.id, memberId: me.id });
  await guest.wait(f => f.type === "channelLeft");
  assert.equal((await fetch(http + t.url)).status, 404,
    "being taken out of the room inside those thirty seconds stops the download");

  guest.close(); owner.close(); engine.close(); relay.close();
  // BREAK: drop the `channelFor` call inside `serveAttachment` and this fails —
  // a ticket becomes a thirty-second licence that outlives the permission.
  // Watched.
});

// ---------------------------------------------------------------------------
// Honest limits
// ---------------------------------------------------------------------------

test("a file too big to share is refused IN WORDS, and nothing is stored", async () => {
  const { relay, owner, engine, general } = await stand("art-toobig.db");
  const agent = await makeAgent(owner, "Scribe");

  // one byte over, so the check is the CAP and not a coincidence
  const big = Buffer.alloc(ARTIFACT_LIMITS.bytes + 1, 0x61);
  engine.frames.length = 0;
  engine.send({
    type: "publishArtifact", channelId: general.id, agentId: agent.id,
    name: "huge.md", dataBase64: big.toString("base64"),
  });
  const err = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(err.error.includes("too big to share here"), err.error);
  assert.ok(err.error.includes("10 MB"), err.error);
  assert.ok(err.error.includes("still on this computer"),
    `it has to say the file did not vanish: ${err.error}`);

  owner.frames.length = 0;
  owner.send({ type: "artifacts", channelId: general.id });
  const list = await owner.wait<Extract<ServerFrame, { type: "artifacts" }>>(f => f.type === "artifacts");
  assert.deepEqual(list.artifacts, []);
  assert.deepEqual(fs.existsSync(relay.store.artifactsDir)
    ? fs.readdirSync(relay.store.artifactsDir) : [], [],
    "no bytes on disk from a refused file");

  owner.close(); engine.close(); relay.close();
  // BREAK: raise the cap in `validateArtifact` and this fails on the refusal.
  // Watched.
});

test("a name that may not become a file is refused by the hub as well as the engine", async () => {
  const { relay, owner, engine, general } = await stand("art-badname.db");
  const agent = await makeAgent(owner, "Scribe");
  await refuses(engine, {
    type: "publishArtifact", channelId: general.id, agentId: agent.id,
    name: "../../escape.md", dataBase64: Buffer.from("nope").toString("base64"),
  }, "that file name isn't allowed");
  owner.close(); engine.close(); relay.close();
});

test("only the newest versions are kept, and the pruned bytes really go", async () => {
  const { relay, owner, engine, general } = await stand("art-prune.db");
  const agent = await makeAgent(owner, "Scribe");

  let last!: Extract<ServerFrame, { type: "artifact" }>;
  for (let i = 1; i <= ARTIFACT_LIMITS.versions + 2; i++) {
    last = await publish(engine, owner,
      { channelId: general.id, agentId: agent.id, name: "log.md", body: `pass ${i}` });
  }
  const kept = last.artifact.versions;
  assert.equal(kept.length, ARTIFACT_LIMITS.versions, "the history is bounded");
  assert.equal(kept[0].version, ARTIFACT_LIMITS.versions + 2, "the newest is kept");
  assert.equal(kept[kept.length - 1].version, 3, "and the two oldest are gone");
  // BYTES AND ROW GO TOGETHER — a pruned version must not leave its file behind
  assert.equal(fs.readdirSync(relay.store.artifactsDir).length, ARTIFACT_LIMITS.versions,
    "one file on disk per kept version, no orphans");

  owner.close(); engine.close(); relay.close();
  // BREAK: delete the row without `removeArtifactBytes` and the disk count fails
  // — his hard disk filling with versions nothing points at. Watched.
});

test("an artifact in an ARCHIVED conversation can still be read, not written", async () => {
  const { relay, http, owner, engine, general } = await stand("art-archived.db");
  const agent = await makeAgent(owner, "Scribe");
  const made = await publish(engine, owner,
    { channelId: general.id, agentId: agent.id, name: "kept.md", body: "still readable" });

  owner.send({ type: "archiveChannel", channelId: general.id, archived: true });
  await owner.wait(f => f.type === "channel"
    && !!(f as { channel: { archivedAt?: number } }).channel.archivedAt);

  owner.frames.length = 0;
  owner.send({ type: "artifactTicket", artifactId: made.artifact.id });
  const t = await owner.wait<Extract<ServerFrame, { type: "artifactTicket" }>>(
    f => f.type === "artifactTicket");
  assert.equal(await (await fetch(http + t.url)).text(), "still readable",
    "archiving must not take away the file he asked an agent for last month");

  // but nothing new may be added to a retired room
  await refuses(engine, {
    type: "publishArtifact", channelId: general.id, agentId: agent.id,
    name: "new.md", dataBase64: Buffer.from("too late").toString("base64"),
  }, "archived");

  owner.close(); engine.close(); relay.close();
});
