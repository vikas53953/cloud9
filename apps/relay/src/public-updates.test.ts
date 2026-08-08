// Public project updates — human desktop only for mutate; Cloud9-owned HTTP token route.
// Pins B1–B5: engine refuse, non-owner refuse, agent-draft human approve, revoke kills
// public read, revision immutability, edit-after-approve clears publish right.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { Project, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "📰", persona: "You draft release notes",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
};

async function stand(t: TestContext, name = "public.db") {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const clients: TestClient[] = [];
  t.after(() => { for (const c of clients) c.close(); relay.close(); });
  const open = (token: string, kind: "desktop" | "engine" | "mobile" = "desktop") => {
    const c = new TestClient(url, token, kind);
    clients.push(c);
    return c;
  };
  const owner = open("tok-owner");
  await owner.wait(f => f.type === "welcome");
  const engine = open("tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  const project: Project = {
    id: "pub-project", ownerId: relay.ownerId, repo: "vikas53953/cloud9",
    name: "Cloud9", createdAt: Date.now(),
  };
  relay.store.saveProject(project);
  return { relay, owner, engine, open, project, port, url };
}

function httpGet(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path }, res => {
      const chunks: Buffer[] = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
  });
}

test("happy path: approve, publish, HTTP public token, revoke kills public", async t => {
  const { relay, owner, project, port } = await stand(t, "public-happy.db");
  owner.send({
    type: "publicCreate", projectId: project.id,
    title: "Release", summary: "A safe release", body: "Details", changelogLinks: [],
  });
  const created = await owner.wait<Extract<ServerFrame, { type: "publicUpdate" }>>(
    f => f.type === "publicUpdate" && f.draft.state === "draft");

  owner.send({ type: "publicPublish", draftId: created.draft.id });
  assert.match((await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error")).error, /approval/);

  owner.send({ type: "publicApprove", draftId: created.draft.id });
  const approved = await owner.wait<Extract<ServerFrame, { type: "publicUpdate" }>>(
    f => f.type === "publicUpdate" && f.draft.state === "approved");
  owner.send({ type: "publicPublish", draftId: approved.draft.id });
  const published = await owner.wait<Extract<ServerFrame, { type: "publicPublished" }>>(
    f => f.type === "publicPublished");
  assert.equal(published.revision.immutable, true);
  assert.ok(published.token);
  assert.equal(published.publicPath, `/public/update/${encodeURIComponent(published.token)}`);

  // Cloud9-owned HTTP surface (no sign-in)
  const live = await httpGet(port, published.publicPath);
  assert.equal(live.status, 200);
  const payload = JSON.parse(live.body) as { title: string; summary: string; body: string; revision: number };
  assert.equal(payload.title, "Release");
  assert.equal(payload.revision, 1);

  // WS echo still works while published
  owner.send({ type: "publicRoute", token: published.token });
  const route = await owner.wait<Extract<ServerFrame, { type: "publicRoute" }>>(
    f => f.type === "publicRoute" && !!f.revision);
  assert.equal(route.revision?.draftId, created.draft.id);

  owner.send({ type: "publicRevoke", draftId: created.draft.id });
  const revoked = await owner.wait<Extract<ServerFrame, { type: "publicUpdate" }>>(
    f => f.type === "publicUpdate" && f.draft.state === "revoked");
  assert.equal(revoked.draft.state, "revoked");

  // Public death after revoke — HTTP and WS
  const dead = await httpGet(port, published.publicPath);
  assert.equal(dead.status, 404);
  assert.match(dead.body, /unavailable/i);
  owner.frames.length = 0;
  owner.send({ type: "publicRoute", token: published.token });
  const gone = await owner.wait<Extract<ServerFrame, { type: "publicRoute" }>>(
    f => f.type === "publicRoute" && !f.revision);
  assert.match(gone.problem ?? "", /unavailable/i);
  assert.equal(relay.store.publicRevisions(created.draft.id).length, 1);
});

test("engine cannot create, approve, publish, edit, or revoke", async t => {
  const { owner, engine, project } = await stand(t, "public-engine.db");
  // Owner makes a draft first so edit/approve/publish/revoke have a target.
  owner.send({
    type: "publicCreate", projectId: project.id,
    title: "Owner draft", summary: "s", body: "b", changelogLinks: [],
  });
  const created = await owner.wait<Extract<ServerFrame, { type: "publicUpdate" }>>(
    f => f.type === "publicUpdate" && f.draft.title === "Owner draft");

  for (const frame of [
    { type: "publicCreate" as const, projectId: project.id, title: "X", summary: "s", body: "b" },
    { type: "publicEdit" as const, draftId: created.draft.id, title: "X", summary: "s", body: "b" },
    { type: "publicApprove" as const, draftId: created.draft.id },
    { type: "publicPublish" as const, draftId: created.draft.id },
    { type: "publicRevoke" as const, draftId: created.draft.id },
  ]) {
    engine.frames.length = 0;
    engine.send(frame);
    const denied = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
    assert.match(denied.error, /an agent cannot|only the desktop app/i, frame.type);
  }
  // Draft still draft — engine never approved/published
  assert.equal(created.draft.state, "draft");
});

test("non-owner cannot act on a public update", async t => {
  const { owner, open, project } = await stand(t, "public-friend.db");
  owner.send({
    type: "publicCreate", projectId: project.id,
    title: "Private draft", summary: "s", body: "b", changelogLinks: [],
  });
  const created = await owner.wait<Extract<ServerFrame, { type: "publicUpdate" }>>(
    f => f.type === "publicUpdate" && f.draft.title === "Private draft");

  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${inv.code}:Priya`);
  await friend.wait(f => f.type === "welcome");

  for (const frame of [
    { type: "publicUpdate" as const, draftId: created.draft.id },
    { type: "publicEdit" as const, draftId: created.draft.id, title: "X", summary: "s", body: "b" },
    { type: "publicApprove" as const, draftId: created.draft.id },
    { type: "publicCreate" as const, projectId: project.id, title: "X", summary: "s", body: "b" },
  ]) {
    friend.frames.length = 0;
    friend.send(frame);
    const denied = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
    assert.match(denied.error, /no such public update|no such project/, frame.type);
  }
});

test("agent-authored draft can be human-approved and published", async t => {
  const { owner, engine, project, port } = await stand(t, "public-agent.db");
  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Notes bot" } });
  const agent = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === "Notes bot");

  engine.send({
    type: "agentPublicDraft", agentId: agent.agent.id, projectId: project.id,
    title: "Agent notes", summary: "From the bot", body: "Please review", changelogLinks: [],
  });
  const drafted = await owner.wait<Extract<ServerFrame, { type: "publicUpdate" }>>(
    f => f.type === "publicUpdate" && f.draft.authorKind === "agent" && f.draft.title === "Agent notes");
  assert.equal(drafted.draft.state, "draft");

  // Human approves agent content (the inverted gate must NOT block this)
  owner.send({ type: "publicApprove", draftId: drafted.draft.id });
  const approved = await owner.wait<Extract<ServerFrame, { type: "publicUpdate" }>>(
    f => f.type === "publicUpdate" && f.draft.id === drafted.draft.id && f.draft.state === "approved");
  assert.equal(approved.draft.authorKind, "agent");
  assert.ok(approved.draft.approvedBy, "human owner must stamp approval");

  owner.send({ type: "publicPublish", draftId: approved.draft.id });
  const published = await owner.wait<Extract<ServerFrame, { type: "publicPublished" }>>(
    f => f.type === "publicPublished" && f.revision.draftId === drafted.draft.id);
  const live = await httpGet(port, published.publicPath);
  assert.equal(live.status, 200);
  assert.match(live.body, /Agent notes/);
});

test("edit after approve clears publish right; revision overwrite refused", async t => {
  const { relay, owner, project } = await stand(t, "public-revision.db");
  owner.send({
    type: "publicCreate", projectId: project.id,
    title: "V1", summary: "s", body: "b", changelogLinks: [],
  });
  const created = await owner.wait<Extract<ServerFrame, { type: "publicUpdate" }>>(
    f => f.type === "publicUpdate" && f.draft.title === "V1");
  owner.send({ type: "publicApprove", draftId: created.draft.id });
  await owner.wait(f => f.type === "publicUpdate" && f.draft.id === created.draft.id && f.draft.state === "approved");

  // Edit returns to draft and clears approval
  owner.frames.length = 0;
  owner.send({
    type: "publicEdit", draftId: created.draft.id,
    title: "V1b", summary: "s2", body: "b2", changelogLinks: [],
  });
  const edited = await owner.wait<Extract<ServerFrame, { type: "publicUpdate" }>>(
    f => f.type === "publicUpdate" && f.draft.id === created.draft.id && f.draft.title === "V1b");
  assert.equal(edited.draft.state, "draft");
  assert.equal(edited.draft.approvedBy, undefined);

  owner.frames.length = 0;
  owner.send({ type: "publicPublish", draftId: created.draft.id });
  assert.match((await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error")).error, /approval/);

  // Re-approve and publish once
  owner.frames.length = 0;
  owner.send({ type: "publicApprove", draftId: created.draft.id });
  await owner.wait(f => f.type === "publicUpdate" && f.draft.id === created.draft.id && f.draft.state === "approved" && f.draft.title === "V1b");
  owner.frames.length = 0;
  owner.send({ type: "publicPublish", draftId: created.draft.id });
  const published = await owner.wait<Extract<ServerFrame, { type: "publicPublished" }>>(
    f => f.type === "publicPublished");
  assert.equal(published.revision.revision, 1);
  assert.equal(published.revision.title, "V1b");

  // Direct store insert of same revision number is refused (immutability)
  assert.throws(() => {
    relay.store.savePublicRevision({
      ...published.revision,
      id: "pubrev_dup",
      title: "overwrite attempt",
    });
  }, /immutable/i);
});
