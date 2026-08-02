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
  ARTIFACT_LIMITS, ATTACHMENT_TICKET, ArtifactLink, RunRecord, ServerFrame,
  StoredArtifactVersion,
  artifactRef, findArtifactRefs, latestVersion, nameKey,
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
           runId?: string; taskId?: string; note?: string; links?: ArtifactLink[] },
) {
  watcher.frames.length = 0;
  const bytes = Buffer.isBuffer(input.body) ? input.body : Buffer.from(input.body);
  engine.send({
    type: "publishArtifact", channelId: input.channelId, agentId: input.agentId,
    name: input.name, dataBase64: bytes.toString("base64"),
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.taskId ? { taskId: input.taskId } : {}),
    ...(input.note ? { note: input.note } : {}),
    ...(input.links ? { links: input.links } : {}),
  });
  // waits for the artifact frame OR the refusal, so a broken publish fails with
  // the hub's own sentence rather than with "timeout waiting for frame"
  const answer = await watcher.wait<ServerFrame>(
    f => (f.type === "artifact" && nameKey(f.artifact.name) === nameKey(input.name)) || f.type === "error");
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
  const run = {
    id: "r-abc-0001", kind: "chat", agentId: agent.id, agentName: agent.name,
    provider: "claude", requestedBy: "Vikas", requestedByKind: "human",
    ask: "write the villas file", channelId: general.id,
    startedAt: 1, finishedAt: 2, durationMs: 1, outcome: "ok", steps: [],
  } as unknown as RunRecord;
  relay.store.saveRun({ record: run, agentId: agent.id, ownerId: me.id, channelId: general.id });

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

test("run attribution is kept only for the same stored agent in the same stored room", async () => {
  const { relay, owner, engine, general, me } = await stand("art-run-attribution.db");
  const agent = await makeAgent(owner, "Scribe");
  const otherAgent = await makeAgent(owner, "Other");
  owner.send({ type: "createChannel", name: "ops", memberIds: [], kind: "channel" });
  const ops = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "ops")).channel;
  const record = (id: string, agentId: string, channelId: string) => ({
    id, kind: "chat", agentId, agentName: agentId === agent.id ? agent.name : otherAgent.name,
    provider: "claude", requestedBy: "Vikas", requestedByKind: "human", ask: "make it",
    channelId, startedAt: 1, finishedAt: 2, durationMs: 1, outcome: "ok", steps: [],
  }) as unknown as RunRecord;
  relay.store.saveRun({
    record: record("r-valid", agent.id, general.id), agentId: agent.id, ownerId: me.id, channelId: general.id,
  });
  relay.store.saveRun({
    record: record("r-wrong-room", agent.id, ops.id), agentId: agent.id, ownerId: me.id, channelId: ops.id,
  });
  relay.store.saveRun({
    record: record("r-wrong-agent", otherAgent.id, general.id),
    agentId: otherAgent.id, ownerId: me.id, channelId: general.id,
  });

  const valid = await publish(engine, owner,
    { channelId: general.id, agentId: agent.id, name: "valid.md", body: "ok", runId: "r-valid" });
  const wrongRoom = await publish(engine, owner,
    { channelId: general.id, agentId: agent.id, name: "wrong-room.md", body: "no", runId: "r-wrong-room" });
  const wrongAgent = await publish(engine, owner,
    { channelId: general.id, agentId: agent.id, name: "wrong-agent.md", body: "no", runId: "r-wrong-agent" });

  assert.equal(latestVersion(valid.artifact)!.runId, "r-valid");
  assert.equal(latestVersion(wrongRoom.artifact)!.runId, undefined,
    "a real run from another room is not attributed to these bytes");
  assert.equal(latestVersion(wrongAgent.artifact)!.runId, undefined,
    "a real run from another agent is not attributed to these bytes");

  owner.close(); engine.close(); relay.close();
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

test("artifact request ids echo only on direct answers, never unsolicited pushes", async () => {
  const { relay, owner, engine, general } = await stand("art-request-id.db");
  const agent = await makeAgent(owner, "Scribe");
  const pushed = await publish(engine, owner,
    { channelId: general.id, agentId: agent.id, name: "request.md", body: "one" });
  assert.equal(Object.prototype.hasOwnProperty.call(pushed, "requestId"), false,
    "a publish push is unsolicited and must not settle a direct request");

  owner.frames.length = 0;
  owner.send({ type: "artifact", artifactId: pushed.artifact.id });
  const oldArtifact = await owner.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === pushed.artifact.id);
  assert.equal(Object.prototype.hasOwnProperty.call(oldArtifact, "requestId"), false,
    "old clients that send no id still receive the ordinary answer");

  owner.frames.length = 0;
  owner.send({ type: "artifact", artifactId: pushed.artifact.id, requestId: "req_artifact_1" });
  const directArtifact = await owner.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.requestId === "req_artifact_1");
  assert.equal(directArtifact.requestId, "req_artifact_1");

  owner.frames.length = 0;
  owner.send({ type: "artifactWorkspace" });
  const oldWorkspace = await owner.wait<Extract<ServerFrame, { type: "artifactWorkspace" }>>(
    f => f.type === "artifactWorkspace");
  assert.equal(Object.prototype.hasOwnProperty.call(oldWorkspace, "requestId"), false);

  owner.frames.length = 0;
  owner.send({ type: "artifactWorkspace", requestId: "req_workspace_1" });
  const directWorkspace = await owner.wait<Extract<ServerFrame, { type: "artifactWorkspace" }>>(
    f => f.type === "artifactWorkspace" && f.requestId === "req_workspace_1");
  assert.equal(directWorkspace.requestId, "req_workspace_1");

  owner.frames.length = 0;
  owner.send({
    type: "setArtifactAccess", artifactId: pushed.artifact.id,
    access: { kind: "restricted", userIds: [] },
  });
  const oldAccess = await owner.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === pushed.artifact.id);
  assert.equal(Object.prototype.hasOwnProperty.call(oldAccess, "requestId"), false,
    "old no-id access mutations still receive one ordinary success frame");

  owner.frames.length = 0;
  engine.frames.length = 0;
  owner.send({
    type: "setArtifactAccess", artifactId: pushed.artifact.id,
    access: { kind: "room" }, requestId: "req_access_1",
  });
  const directAccess = await owner.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.requestId === "req_access_1");
  assert.equal(directAccess.requestId, "req_access_1", "the requesting socket gets the exact id");
  const otherConnectionPush = await engine.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === pushed.artifact.id);
  assert.equal(Object.prototype.hasOwnProperty.call(otherConnectionPush, "requestId"), false,
    "the same access change reaches another connection only as an unsolicited no-id push");
  assert.equal(owner.frames.filter(f => f.type === "artifact"
    && (f as Extract<ServerFrame, { type: "artifact" }>).artifact.id === pushed.artifact.id).length, 1,
  "the requesting socket is omitted from the separate push and cannot settle twice");

  owner.frames.length = 0;
  owner.send({ type: "artifact", artifactId: "af_missing", requestId: "req_artifact_error" });
  const artifactError = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "req_artifact_error");
  assert.equal(artifactError.requestId, "req_artifact_error");

  owner.frames.length = 0;
  owner.send({
    type: "setArtifactAccess", artifactId: "af_missing", access: { kind: "room" },
    requestId: "req_access_error",
  });
  const accessError = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "req_access_error");
  assert.equal(accessError.requestId, "req_access_error");

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const realWorkspace = relay.store.artifactWorkspace.bind(relay.store);
  (relay.store as any).artifactWorkspace = () => { throw new Error("workspace refused for test"); };
  owner.frames.length = 0;
  owner.send({ type: "artifactWorkspace", requestId: "req_workspace_error" });
  const workspaceError = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "req_workspace_error");
  assert.equal(workspaceError.requestId, "req_workspace_error");
  (relay.store as any).artifactWorkspace = realWorkspace;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  owner.frames.length = 0;
  owner.send({
    type: "send", channelId: "ch_missing", text: "ordinary refusal",
    requestId: "req_send_error",
  });
  const sendError = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "req_send_error");
  assert.equal(sendError.requestId, "req_send_error",
    "an ordinary fire-and-forget frame receives its exact id on refusal");

  owner.frames.length = 0;
  owner.send({ type: "send", channelId: "ch_missing", text: "old ordinary refusal" });
  const oldSendError = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error");
  assert.equal(Object.prototype.hasOwnProperty.call(oldSendError, "requestId"), false,
    "old ordinary frames remain valid and their refusal invents no id");

  owner.frames.length = 0;
  owner.send({ type: "artifact", artifactId: "af_missing" });
  const oldError = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.equal(Object.prototype.hasOwnProperty.call(oldError, "requestId"), false,
    "old no-id refusals and general errors never invent a correlation id");

  owner.close(); engine.close(); relay.close();
});

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
  owner.send({
    type: "setArtifactAccess", artifactId: made.artifact.id,
    access: { kind: "restricted", userIds: [me.id] },
  });
  await guest.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === made.artifact.id);

  guest.frames.length = 0;
  guest.send({ type: "artifactTicket", artifactId: made.artifact.id });
  const t = await guest.wait<Extract<ServerFrame, { type: "artifactTicket" }>>(
    f => f.type === "artifactTicket");

  // THE GATE IS ASKED AGAIN WHEN THE TICKET IS SPENT, not only when it is minted
  owner.frames.length = 0;
  owner.send({ type: "removeMember", channelId: general.id, memberId: me.id });
  await guest.wait(f => f.type === "channelLeft");
  const refreshed = await owner.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === made.artifact.id
      && f.artifact.access?.kind === "restricted" && f.artifact.access.userIds.length === 1);
  assert.deepEqual(refreshed.artifact.access, { kind: "restricted", userIds: [relay.ownerId] },
    "member removal refreshes effective access summaries for remaining readers");
  assert.equal((await fetch(http + t.url)).status, 404,
    "being taken out of the room inside those thirty seconds stops the download");

  guest.close(); owner.close(); engine.close(); relay.close();
  // BREAK: drop the `channelFor` call inside `serveAttachment` and this fails —
  // a ticket becomes a thirty-second licence that outlives the permission.
  // Watched.
});

test("Files filters permission before the page limit and paginates across rooms", async () => {
  const { relay, url, owner, engine, general } = await stand("art-workspace.db");
  const agent = await makeAgent(owner, "Scribe");
  const { guest, me } = await guestOf(url, owner, "Priya");

  owner.send({ type: "createChannel", name: "ops", memberIds: [me.id], kind: "channel" });
  const ops = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "ops")).channel;

  const generalFile = await publish(engine, owner,
    { channelId: general.id, agentId: agent.id, name: "general.md", body: "general" });
  const visibleOps = await publish(engine, owner,
    { channelId: ops.id, agentId: agent.id, name: "visible.md", body: "visible" });
  const hiddenOps = await publish(engine, owner,
    { channelId: ops.id, agentId: agent.id, name: "hidden.md", body: "hidden" });

  guest.frames.length = 0;
  owner.send({
    type: "setArtifactAccess", artifactId: hiddenOps.artifact.id,
    access: { kind: "restricted", userIds: [] },
  });
  await guest.wait<Extract<ServerFrame, { type: "artifactUnavailable" }>>(
    f => f.type === "artifactUnavailable" && f.artifactId === hiddenOps.artifact.id);

  guest.frames.length = 0;
  guest.send({ type: "artifactWorkspace", limit: 1 });
  const first = await guest.wait<Extract<ServerFrame, { type: "artifactWorkspace" }>>(
    f => f.type === "artifactWorkspace");
  assert.deepEqual(first.artifacts.map(a => a.artifactId), [visibleOps.artifact.id],
    "the newer hidden row is filtered in SQL before LIMIT, so the allowed row behind it fills the page");
  assert.equal(first.artifacts[0].channelName, "ops");
  assert.equal(first.artifacts[0].latest.version, 1);
  assert.equal(first.artifacts[0].versionCount, 1);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextBefore !== undefined && first.nextBeforeId);

  guest.frames.length = 0;
  guest.send({
    type: "artifactWorkspace", limit: 1,
    before: first.nextBefore, beforeId: first.nextBeforeId,
  });
  const second = await guest.wait<Extract<ServerFrame, { type: "artifactWorkspace" }>>(
    f => f.type === "artifactWorkspace");
  assert.deepEqual(second.artifacts.map(a => a.artifactId), [generalFile.artifact.id]);
  assert.equal(second.hasMore, false);

  guest.frames.length = 0;
  guest.send({ type: "artifacts", channelId: ops.id });
  const room = await guest.wait<Extract<ServerFrame, { type: "artifacts" }>>(f => f.type === "artifacts");
  assert.deepEqual(room.artifacts.map(a => a.id), [visibleOps.artifact.id],
    "the older room-scoped list follows the same non-probing permission filter");

  guest.close(); owner.close(); engine.close(); relay.close();
});

test("room managers control whole-chain access, and revocation kills cached detail and tickets", async () => {
  const { relay, url, http, owner, engine, general } = await stand("art-access.db");
  const agent = await makeAgent(owner, "Scribe");
  const { guest, me } = await guestOf(url, owner, "Priya");
  const made = await publish(engine, guest,
    { channelId: general.id, agentId: agent.id, name: "budget.md", body: "room default" });

  await refuses(guest, {
    type: "setArtifactAccess", artifactId: made.artifact.id,
    access: { kind: "restricted", userIds: [me.id] },
  }, "don't run this conversation");
  await refuses(owner, {
    type: "setArtifactAccess", artifactId: made.artifact.id,
    access: undefined,
  } as unknown as Parameters<TestClient["send"]>[0], "say whether this file uses room or restricted access");

  guest.frames.length = 0;
  guest.send({ type: "artifactTicket", artifactId: made.artifact.id });
  const ticket = await guest.wait<Extract<ServerFrame, { type: "artifactTicket" }>>(
    f => f.type === "artifactTicket");

  owner.send({
    type: "setArtifactAccess", artifactId: made.artifact.id,
    access: { kind: "restricted", userIds: [] },
  });
  await guest.wait<Extract<ServerFrame, { type: "artifactUnavailable" }>>(
    f => f.type === "artifactUnavailable" && f.artifactId === made.artifact.id);
  assert.equal((await fetch(http + ticket.url)).status, 404,
    "redemption re-checks the file rule, not only the room membership used at mint");
  await refuses(guest, { type: "artifact", artifactId: made.artifact.id }, "no such file");
  await refuses(guest, { type: "artifactTicket", artifactId: made.artifact.id }, "no such file");

  owner.send({ type: "setMemberRole", channelId: general.id, memberId: me.id, role: "admin" });
  await guest.wait(f => f.type === "channel"
    && (relay.store.memberRole(general.id, me.id) === "admin"));
  guest.frames.length = 0;
  guest.send({ type: "artifact", artifactId: made.artifact.id });
  const asManager = await guest.wait<Extract<ServerFrame, { type: "artifact" }>>(f => f.type === "artifact");
  assert.deepEqual(asManager.artifact.access, { kind: "restricted", userIds: [relay.ownerId, me.id] },
    "all current owners/admins are added even when the stored selected list is empty");

  guest.frames.length = 0;
  owner.frames.length = 0;
  owner.send({ type: "setMemberRole", channelId: general.id, memberId: me.id, role: "member" });
  await guest.wait<Extract<ServerFrame, { type: "artifactUnavailable" }>>(
    f => f.type === "artifactUnavailable" && f.artifactId === made.artifact.id);
  const remainingReader = await owner.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === made.artifact.id
      && f.artifact.access?.kind === "restricted"
      && f.artifact.access.userIds.length === 1);
  assert.deepEqual(remainingReader.artifact.access, { kind: "restricted", userIds: [relay.ownerId] },
    "role changes refresh effective access summaries for every remaining reader");
  owner.send({ type: "setMemberRole", channelId: general.id, memberId: me.id, role: "admin" });
  await guest.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === made.artifact.id);

  guest.frames.length = 0;
  guest.send({
    type: "setArtifactAccess", artifactId: made.artifact.id, access: { kind: "room" },
  });
  await guest.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === made.artifact.id);

  owner.send({ type: "createChannel", name: "dm-priya", memberIds: [me.id], kind: "dm" });
  const dm = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.kind === "dm")).channel;
  const direct = await publish(engine, owner,
    { channelId: dm.id, agentId: agent.id, name: "direct.md", body: "inherited only" });
  await refuses(owner, {
    type: "setArtifactAccess", artifactId: direct.artifact.id,
    access: { kind: "restricted", userIds: [relay.ownerId] },
  }, "always inherit");

  guest.close(); owner.close(); engine.close(); relay.close();
});

test("typed links pin exact same-room versions and hide inaccessible targets without probing", async () => {
  const { relay, url, owner, engine, general } = await stand("art-links.db");
  const agent = await makeAgent(owner, "Scribe");
  const { guest } = await guestOf(url, owner, "Priya");
  await refuses(engine, {
    type: "publishArtifact", channelId: general.id, agentId: agent.id,
    name: "bad-shape.md", dataBase64: Buffer.from("bad").toString("base64"), links: "guess",
  } as unknown as Parameters<TestClient["send"]>[0], "file links must be a list");
  assert.equal(relay.store.artifactRowByName(general.id, "bad-shape.md"), undefined);
  await refuses(engine, {
    type: "publishArtifact", channelId: general.id, agentId: agent.id,
    name: "missing-target.md", dataBase64: Buffer.from("bad").toString("base64"),
    links: [{ kind: "made-from", target: { artifactId: "af_missing", version: 1 } }],
  }, "not available in this conversation");
  assert.equal(relay.store.artifactRowByName(general.id, "missing-target.md"), undefined,
    "a valid-shaped link to a missing exact target stores no identity row");
  assert.equal((relay.store.db.prepare(
    "SELECT COUNT(*) n FROM artifact_versions",
  ).get() as { n: number }).n, 0, "no immutable version row was inserted either");
  assert.deepEqual(
    fs.existsSync(relay.store.artifactsDir) ? fs.readdirSync(relay.store.artifactsDir) : [],
    [],
    "target validation happens before byte staging: no staged, pending or final artifact litter exists",
  );

  const targetOne = await publish(engine, owner,
    { channelId: general.id, agentId: agent.id, name: "figures.csv", body: "one" });
  guest.frames.length = 0;
  const source = await publish(engine, owner, {
    channelId: general.id, agentId: agent.id, name: "summary.pdf", body: "summary",
    links: [{ kind: "made-from", target: { artifactId: targetOne.artifact.id, version: 1 } }],
  });
  const incomingPushed = await guest.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === targetOne.artifact.id
      && !!f.relations?.some(r => r.direction === "incoming" && r.from.artifactId === source.artifact.id));
  assert.equal(incomingPushed.relationsTruncated, undefined,
    "a complete relation list never sends a false truncation flag");
  await publish(engine, owner,
    { channelId: general.id, agentId: agent.id, name: "figures.csv", body: "two" });

  guest.frames.length = 0;
  guest.send({ type: "artifact", artifactId: source.artifact.id });
  const sourceDetail = await guest.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === source.artifact.id);
  assert.equal(Object.prototype.hasOwnProperty.call(sourceDetail.artifact.versions[0], "links"), false,
    "raw exact targets never ride inside a public artifact version");
  assert.deepEqual(sourceDetail.relations, [{
    kind: "made-from", direction: "outgoing",
    from: { artifactId: source.artifact.id, version: 1 },
    to: { artifactId: targetOne.artifact.id, version: 1 },
    linkedName: "figures.csv", hidden: false,
  }], "the link stays on target version 1 after version 2 exists");

  guest.frames.length = 0;
  guest.send({ type: "artifacts", channelId: general.id });
  const roomList = await guest.wait<Extract<ServerFrame, { type: "artifacts" }>>(f => f.type === "artifacts");
  const sourceInList = roomList.artifacts.find(a => a.id === source.artifact.id)!;
  assert.equal(Object.prototype.hasOwnProperty.call(sourceInList.versions[0], "links"), false);
  guest.frames.length = 0;
  guest.send({ type: "artifactTicket", artifactId: source.artifact.id });
  const sourceTicket = await guest.wait<Extract<ServerFrame, { type: "artifactTicket" }>>(
    f => f.type === "artifactTicket" && f.artifactId === source.artifact.id);
  assert.equal(Object.prototype.hasOwnProperty.call(sourceTicket.artifact.versions[0], "links"), false,
    "detail, list and ticket frames all project storage links out");

  guest.frames.length = 0;
  guest.send({ type: "artifact", artifactId: targetOne.artifact.id });
  const targetDetail = await guest.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === targetOne.artifact.id);
  assert.ok(targetDetail.relations?.some(r =>
    r.direction === "incoming"
    && r.from.artifactId === source.artifact.id
    && r.to?.version === 1), "the exact target shows its permitted incoming source");

  guest.frames.length = 0;
  owner.send({
    type: "setArtifactAccess", artifactId: source.artifact.id,
    access: { kind: "restricted", userIds: [] },
  });
  await guest.wait<Extract<ServerFrame, { type: "artifactUnavailable" }>>(
    f => f.type === "artifactUnavailable" && f.artifactId === source.artifact.id);
  const incomingCleared = await guest.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === targetOne.artifact.id
      && Array.isArray(f.relations) && f.relations.length === 0);
  assert.deepEqual(incomingCleared.relations, [],
    "hiding a source pushes an explicit empty incoming list to its cached target");

  // A later version of the still-hidden source changes nothing Priya may see:
  // source stays absent and target's permitted incoming list stays empty. A
  // request-id barrier proves no unsolicited artifact timing frame preceded it.
  guest.frames.length = 0;
  await publish(engine, owner, {
    channelId: general.id, agentId: agent.id, name: "summary.pdf", body: "hidden revision",
  });
  guest.send({ type: "artifactWorkspace", requestId: "barrier_hidden_source" });
  await guest.wait<Extract<ServerFrame, { type: "artifactWorkspace" }>>(
    f => f.type === "artifactWorkspace" && f.requestId === "barrier_hidden_source");
  assert.deepEqual(guest.frames.filter(f => f.type === "artifact"), [],
    "an invisible restricted-source event sends zero artifact frame or timing hint to Priya");

  guest.frames.length = 0;
  owner.send({
    type: "setArtifactAccess", artifactId: source.artifact.id, access: { kind: "room" },
  });
  await guest.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === source.artifact.id);
  await guest.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === targetOne.artifact.id
      && !!f.relations?.some(r => r.direction === "incoming" && r.from.artifactId === source.artifact.id));

  guest.frames.length = 0;
  owner.send({
    type: "setArtifactAccess", artifactId: targetOne.artifact.id,
    access: { kind: "restricted", userIds: [] },
  });
  await guest.wait(f => f.type === "artifactUnavailable"
    && (f as Extract<ServerFrame, { type: "artifactUnavailable" }>).artifactId === targetOne.artifact.id);
  const hidden = await guest.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === source.artifact.id
      && !!f.relations?.some(r => r.direction === "outgoing" && r.hidden));
  assert.deepEqual(hidden.relations, [{
    kind: "made-from", direction: "outgoing",
    from: { artifactId: source.artifact.id, version: 1 }, hidden: true,
  }], "a hidden target carries no name and no exact reference");
  await refuses(guest, { type: "artifact", artifactId: targetOne.artifact.id }, "no such file");

  // Retention removes target v1 while newer target bytes remain. The link stays
  // pinned and becomes unavailable; it must never slide forward to v2/v21.
  for (let v = 3; v <= ARTIFACT_LIMITS.versions; v++) {
    await publish(engine, owner,
      { channelId: general.id, agentId: agent.id, name: "figures.csv", body: `version ${v}` });
  }
  owner.frames.length = 0;
  await publish(engine, owner, {
    channelId: general.id, agentId: agent.id, name: "figures.csv",
    body: `version ${ARTIFACT_LIMITS.versions + 1}`,
  });
  const pruned = await owner.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === source.artifact.id
      && !!f.relations?.some(r => r.direction === "outgoing" && r.hidden));
  assert.deepEqual(pruned.relations, [{
    kind: "made-from", direction: "outgoing",
    from: { artifactId: source.artifact.id, version: 1 }, hidden: true,
  }], "a pruned exact target is unavailable, not replaced by the newest retained target");

  owner.send({ type: "createChannel", name: "other", memberIds: [], kind: "channel" });
  const other = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "other")).channel;
  const elsewhere = await publish(engine, owner,
    { channelId: other.id, agentId: agent.id, name: "elsewhere.md", body: "elsewhere" });
  await refuses(engine, {
    type: "publishArtifact", channelId: general.id, agentId: agent.id,
    name: "bad-link.md", dataBase64: Buffer.from("bad").toString("base64"),
    links: [{ kind: "goes-with", target: { artifactId: elsewhere.artifact.id, version: 1 } }],
  }, "not available in this conversation");
  assert.equal(relay.store.artifactRowByName(general.id, "bad-link.md"), undefined,
    "a refused cross-room link stores neither identity nor bytes");

  guest.close(); owner.close(); engine.close(); relay.close();
});

test("artifact detail caps relation projection and says honestly when more exist", async () => {
  const { relay, url, owner, engine, general } = await stand("art-relations-cap.db");
  const agent = await makeAgent(owner, "Scribe");
  const { guest } = await guestOf(url, owner, "Priya");
  const target = await publish(engine, owner,
    { channelId: general.id, agentId: agent.id, name: "target.md", body: "target" });

  const insertArtifact = relay.store.db.prepare(
    "INSERT INTO artifacts(id,channelId,name,nameKey,createdAt,updatedAt,nextVersion) VALUES(?,?,?,?,?,?,?)",
  );
  const insertVersion = relay.store.db.prepare(
    "INSERT INTO artifact_versions(id,artifactId,channelId,agentId,version,producedAt,json) " +
    "VALUES(?,?,?,?,?,?,?)",
  );
  const insertLink = relay.store.db.prepare(
    "INSERT INTO artifact_links(sourceArtifactId,sourceVersion,channelId,kind,targetArtifactId,targetVersion) " +
    "VALUES(?,?,?,?,?,?)",
  );
  for (let i = 0; i <= ARTIFACT_LIMITS.relationDetail; i++) {
    const artifactId = `af_rel_${i}`;
    const versionId = `av_rel_${i}`;
    const name = `source-${i}.md`;
    const version: StoredArtifactVersion = {
      id: versionId, version: 1, size: 1, sha256: "a".repeat(64), text: true,
      storedAs: `${versionId}-${name}`, agentId: agent.id, agentName: agent.name,
      ownerId: relay.ownerId, producedAt: i + 1,
      links: [{ kind: "made-from", target: { artifactId: target.artifact.id, version: 1 } }],
    };
    insertArtifact.run(artifactId, general.id, name, name.toLowerCase(), i + 1, i + 1, 2);
    insertVersion.run(versionId, artifactId, general.id, agent.id, 1, i + 1, JSON.stringify(version));
    insertLink.run(artifactId, 1, general.id, "made-from", target.artifact.id, 1);
  }

  guest.frames.length = 0;
  guest.send({ type: "artifact", artifactId: target.artifact.id });
  const detail = await guest.wait<Extract<ServerFrame, { type: "artifact" }>>(
    f => f.type === "artifact" && f.artifact.id === target.artifact.id
      && f.relationsTruncated === true);
  assert.equal(detail.relations!.length, ARTIFACT_LIMITS.relationDetail);
  assert.equal(detail.relationsTruncated, true,
    "true means a real permitted 101st relation exists beyond the shared cap");

  guest.close(); owner.close(); engine.close(); relay.close();
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
