// PROJECTS — a GitHub repository connected to Cloud9 (his item 7).
//
// Every test here failed before this round: there was no project, no
// `connectProject` frame, and no table to put one in.
//
// WHAT THIS HALF IS. Storage and wire only. Nothing the hub does reaches
// GitHub — the engine owns `git` and `gh`, on the owner's own machine, behind
// the approvals that already sit in front of anything that leaves it. So the
// questions this file pins are the hub's questions: whose project is it, what
// may be stored, and can a name we hold ever end up as an option on somebody's
// command line.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  PROJECT_LIMITS, ProjectItem, ServerFrame, validateProjectItem, validateRepo,
} from "@cloud9/shared";
import { Relay, isSafeBranchName } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

async function stand(t: TestContext, name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const clients: TestClient[] = [];
  t.after(() => { for (const c of clients) c.close(); relay.close(); });
  const open = (token: string, kind: "desktop" | "engine" = "desktop") => {
    const c = new TestClient(url, token, kind);
    clients.push(c);
    return c;
  };
  const owner = open("tok-owner");
  await owner.wait(f => f.type === "welcome");
  const engine = open("tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  return { relay, owner, engine, open };
}

async function connect(client: TestClient, repo: string) {
  client.send({ type: "connectProject", repo });
  const f = await client.wait<Extract<ServerFrame, { type: "project" }>>(
    f => f.type === "project" && f.project.repo === repo);
  return f.project;
}

function item(over: Partial<ProjectItem> = {}): ProjectItem {
  return {
    projectId: "?", kind: "pull", number: 12, title: "Presence, honestly",
    state: "open", author: "vikas53953", branch: "presence-honest",
    url: "https://github.com/vikas53953/cloud9/pull/12",
    createdAt: 1_000, updatedAt: 2_000,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A repository name becomes an argument to `gh`, so it is checked like one
// ---------------------------------------------------------------------------

test("a repository name is owner/name and cannot be mistaken for an option", () => {
  assert.equal(validateRepo("vikas53953/cloud9"), null);
  assert.equal(validateRepo("Some-Org/my.repo_1"), null);
  for (const bad of [
    "--repo", "-x/y", "vikas53953/--yolo", "vikas53953", "a/b/c", "",
    "vikas53953/../../etc", "vikas 53953/cloud9", "vikas53953/cloud9;rm -rf /",
    "https://github.com/vikas53953/cloud9", 42, null, undefined,
  ]) {
    assert.notEqual(validateRepo(bad as never), null, `${String(bad)} must be refused`);
  }
});

test("a branch name cannot be mistaken for an option either", () => {
  for (const good of ["main", "cloud9/presence-fix", "release-1.2"]) {
    assert.equal(isSafeBranchName(good), true, good);
  }
  for (const bad of ["--force", "-b", "a..b", "trunk/", "x.lock", "a//b", "", "a b", "$(id)"]) {
    assert.equal(isSafeBranchName(bad), false, `${bad} must be refused`);
  }
});

test("a pull request that arrived from somewhere else is checked before it is stored", () => {
  assert.equal(validateProjectItem(item()), null);
  assert.notEqual(validateProjectItem(item({ state: "invented" as never })), null);
  assert.notEqual(validateProjectItem(item({ kind: "discussion" as never })), null);
  assert.notEqual(validateProjectItem(item({ number: 0 })), null);
  // a link a person clicks must be GitHub's own — this is the whole reason the
  // url is pattern-checked rather than length-checked
  for (const url of [
    "javascript:alert(1)", "http://github.com/x/y/pull/1",
    "https://github.evil.com/x/y/pull/1", "https://githubXcom/x",
  ]) {
    assert.notEqual(validateProjectItem(item({ url })), null, url);
  }
});

// ---------------------------------------------------------------------------
// The hub: whose project is it
// ---------------------------------------------------------------------------

test("connecting a repository, twice, finds the one you already have", async t => {
  const { relay, owner } = await stand(t, "proj-connect.db");
  const first = await connect(owner, "vikas53953/cloud9");
  assert.equal(first.name, "cloud9", "the repository's own name unless he says otherwise");
  assert.equal(first.syncedAt, undefined, "nobody has looked at GitHub yet, and we do not pretend");

  owner.send({ type: "connectProject", repo: "vikas53953/cloud9" });
  const again = await owner.wait<Extract<ServerFrame, { type: "project" }>>(
    f => f.type === "project" && f.project.id !== "");
  assert.equal(again.project.id, first.id, "two projects over one repository is two disagreeing lists");
  assert.equal(relay.store.projectsOf(relay.ownerId).length, 1);
});

test("a project is its owner's — a friend cannot see it, act on it, or probe for it", async t => {
  const { relay, owner, open } = await stand(t, "proj-owner.db");
  const project = await connect(owner, "vikas53953/cloud9");

  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${inv.code}:Priya`);
  await friend.wait(f => f.type === "welcome");

  friend.send({ type: "projects" });
  const theirs = await friend.wait<Extract<ServerFrame, { type: "projects" }>>(f => f.type === "projects");
  assert.deepEqual(theirs.projects, [], "somebody else's repository is not in your list");

  for (const frame of [
    { type: "projectItems", projectId: project.id },
    { type: "updateProject", projectId: project.id, name: "mine now" },
    { type: "forgetProject", projectId: project.id },
  ] as const) {
    friend.frames.length = 0;
    friend.send(frame);
    const denied = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
    // "no such project" — the same sentence an invented id gets, so an id
    // cannot be probed. (The hub prefixes thrown errors with "Error: ".)
    assert.match(denied.error, /no such project$/, frame.type);
  }
  assert.equal(relay.store.project(project.id)?.name, "cloud9");
});

test("only the engine reports what GitHub said, and only for its own projects", async t => {
  const { relay, owner, engine, open } = await stand(t, "proj-sync-gate.db");
  const project = await connect(owner, "vikas53953/cloud9");

  // an ordinary client cannot claim to have looked at GitHub
  owner.send({ type: "projectSynced", projectId: project.id, items: [] });
  const notEngine = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(notEngine.error, /only the engine/);

  // and somebody else's engine cannot plant a list on his project
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friendEngine = open(`invite:${inv.code}:Priya`, "engine");
  await friendEngine.wait(f => f.type === "welcome");
  friendEngine.send({
    type: "projectSynced", projectId: project.id,
    items: [item({ title: "trust me" })],
  });
  const denied = await friendEngine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /no such project$/);
  assert.deepEqual(relay.store.projectItems(project.id), []);

  // his own engine can
  engine.send({
    type: "projectSynced", projectId: project.id, defaultBranch: "main",
    items: [item(), item({ kind: "issue", number: 3, title: "Presence shows offline", url: "https://github.com/vikas53953/cloud9/issues/3" })],
  });
  const items = await engine.wait<Extract<ServerFrame, { type: "projectItems" }>>(f => f.type === "projectItems");
  assert.equal(items.items.length, 2);
  assert.equal(items.items[0].projectId, project.id, "stamped with the project we verified");
  const updated = await engine.wait<Extract<ServerFrame, { type: "project" }>>(
    f => f.type === "project" && !!f.project.syncedAt);
  assert.equal(updated.project.defaultBranch, "main");
});

test("a re-sync REPLACES the lists — a merged pull request stops being open work", async t => {
  const { relay, owner, engine } = await stand(t, "proj-resync.db");
  const project = await connect(owner, "vikas53953/cloud9");

  engine.send({
    type: "projectSynced", projectId: project.id,
    items: [item({ number: 12 }), item({ number: 13, updatedAt: 3_000 })],
  });
  await engine.wait(f => f.type === "projectItems" && f.items.length === 2);

  // 13 was merged and 12 is gone from GitHub's answer entirely
  engine.frames.length = 0;
  engine.send({
    type: "projectSynced", projectId: project.id,
    items: [item({ number: 13, state: "merged", updatedAt: 4_000 })],
  });
  const after = await engine.wait<Extract<ServerFrame, { type: "projectItems" }>>(f => f.type === "projectItems");
  assert.equal(after.items.length, 1, "an append-only cache leaves closed work on the list for ever");
  assert.equal(after.items[0].state, "merged");
  assert.deepEqual(relay.store.projectItems(project.id).map(i => i.number), [13]);
});

test("nothing unbounded gets in through the new field, and a bad link is refused whole", async t => {
  const { relay, owner, engine } = await stand(t, "proj-bounds.db");
  const project = await connect(owner, "vikas53953/cloud9");

  engine.send({
    type: "projectSynced", projectId: project.id,
    items: Array.from({ length: PROJECT_LIMITS.items + 1 }, (_, n) => item({ number: n + 1 })),
  });
  const tooMany = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(tooMany.error, /too much work/);

  // one bad row refuses the whole report rather than storing the rest — a
  // half-stored answer from GitHub is not an answer from GitHub
  engine.frames.length = 0;
  engine.send({
    type: "projectSynced", projectId: project.id,
    items: [item(), item({ number: 2, url: "javascript:alert(1)" })],
  });
  const badLink = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(badLink.error, /GitHub address/);
  assert.deepEqual(relay.store.projectItems(project.id), []);

  // and a branch name that is really a flag never becomes one
  engine.frames.length = 0;
  engine.send({ type: "projectSynced", projectId: project.id, defaultBranch: "--force" });
  const badBranch = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(badBranch.error, /branch name/);
  assert.equal(relay.store.project(project.id)?.defaultBranch, undefined);
});

test("forgetting a project forgets our copy and its lists, and nothing else", async t => {
  const { relay, owner, engine } = await stand(t, "proj-forget.db");
  const project = await connect(owner, "vikas53953/cloud9");
  engine.send({ type: "projectSynced", projectId: project.id, items: [item()] });
  await engine.wait(f => f.type === "projectItems" && f.items.length === 1);

  owner.send({ type: "forgetProject", projectId: project.id });
  await owner.wait(f => f.type === "projectForgotten" && f.projectId === project.id);
  assert.equal(relay.store.project(project.id), undefined);
  assert.deepEqual(relay.store.projectItems(project.id), [], "its lists go with it");
});

// ---------------------------------------------------------------------------
// "LOOK AT GITHUB NOW" — the ask, the owner gate, and the honest in-between
//
// The hub cannot reach GitHub and never will. What it CAN do is decide whose
// project this is, tell the right engine to go and look, and be the one honest
// answer to "is anybody looking right now?" — because nothing else knows.
// ---------------------------------------------------------------------------

test("the owner asking for a look reaches THEIR engine, with the repository the hub has stored", async t => {
  const { owner, engine } = await stand(t, "proj-look-ask.db");
  const project = await connect(owner, "vikas53953/cloud9");

  owner.send({ type: "syncProject", projectId: project.id });
  const told = await engine.wait<Extract<ServerFrame, { type: "lookAtProject" }>>(
    f => f.type === "lookAtProject");
  assert.equal(told.projectId, project.id);
  // the name comes from stored state, not from the frame the client sent
  assert.equal(told.repo, "vikas53953/cloud9");
});

test("while a look is under way the hub SAYS so, and stops saying it the moment the engine answers", async t => {
  const { owner, engine } = await stand(t, "proj-look-state.db");
  const project = await connect(owner, "vikas53953/cloud9");

  owner.frames.length = 0;
  owner.send({ type: "syncProject", projectId: project.id });
  const busy = await owner.wait<Extract<ServerFrame, { type: "project" }>>(
    f => f.type === "project" && f.project.looking === true);
  assert.equal(busy.project.looking, true);
  assert.equal(busy.project.syncedAt, undefined, "asking is not looking — nothing has been looked at yet");

  // and it is on the LIST too, not only on the one that changed
  owner.send({ type: "projects" });
  const list = await owner.wait<Extract<ServerFrame, { type: "projects" }>>(f => f.type === "projects");
  assert.equal(list.projects[0].looking, true);

  engine.send({ type: "projectSynced", projectId: project.id, defaultBranch: "master", items: [item()] });
  const done = await owner.wait<Extract<ServerFrame, { type: "project" }>>(
    f => f.type === "project" && f.project.looking !== true);
  assert.equal(done.project.looking, undefined, "nobody is looking any more");
  assert.ok((done.project.syncedAt ?? 0) > 0, "and the hub is the one that stamped when");
});

test("a second look while one is still running is refused rather than piled on", async t => {
  const { owner } = await stand(t, "proj-look-twice.db");
  const project = await connect(owner, "vikas53953/cloud9");
  owner.send({ type: "syncProject", projectId: project.id });
  await owner.wait(f => f.type === "project" && f.project.looking === true);

  owner.frames.length = 0;
  owner.send({ type: "syncProject", projectId: project.id });
  const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(refused.error, /already looking/);
});

test("only the OWNER may set a look going, and it is checked here rather than on the screen", async t => {
  const { owner, engine, open } = await stand(t, "proj-look-owner.db");
  const project = await connect(owner, "vikas53953/cloud9");

  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${inv.code}:Priya`);
  await friend.wait(f => f.type === "welcome");
  engine.frames.length = 0;

  friend.send({ type: "syncProject", projectId: project.id });
  const refused = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  // the same answer an invented id gets, so an id cannot be probed
  assert.match(refused.error, /no such project/);
  assert.ok(!engine.frames.some(f => f.type === "lookAtProject"),
    "nothing reached the engine on somebody else's say-so");

  friend.send({ type: "syncProject", projectId: "pr_invented" });
  const invented = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.equal(invented.error, refused.error);
});

test("with no Cloud9 running on this computer, the hub says so in words and claims no look", async t => {
  // deliberately WITHOUT the engine `stand` opens: this is the case where the
  // button has nothing to talk to
  const relay = new Relay({ dbPath: tmp("proj-look-noengine.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const owner = new TestClient(`ws://127.0.0.1:${port}`, "tok-owner", "desktop");
  t.after(() => { owner.close(); relay.close(); });
  await owner.wait(f => f.type === "welcome");
  const project = await connect(owner, "vikas53953/cloud9");

  owner.frames.length = 0;
  owner.send({ type: "syncProject", projectId: project.id });
  const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(refused.error, /isn't running on the computer/);

  const said = await owner.wait<Extract<ServerFrame, { type: "project" }>>(f => f.type === "project");
  assert.match(said.project.problem ?? "", /isn't running on the computer/);
  assert.equal(said.project.looking, undefined, "nothing is looking, so nothing says it is");
  // ABSENT MEANS ABSENT: nobody looked, so "last looked at" stays empty
  assert.equal(said.project.syncedAt, undefined);
});

test("an engine cannot start a look on somebody else's project by asking for one", async t => {
  const { owner, open } = await stand(t, "proj-look-engine.db");
  const project = await connect(owner, "vikas53953/cloud9");

  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${inv.code}:Priya`, "engine");
  await friend.wait(f => f.type === "welcome");
  friend.send({ type: "syncProject", projectId: project.id });
  const refused = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(refused.error, /no such project/);
});

test("forgetting a project while a look is in flight leaves nothing waiting behind it", async t => {
  const { relay, owner } = await stand(t, "proj-look-forget.db");
  const project = await connect(owner, "vikas53953/cloud9");
  owner.send({ type: "syncProject", projectId: project.id });
  await owner.wait(f => f.type === "project" && f.project.looking === true);

  owner.send({ type: "forgetProject", projectId: project.id });
  await owner.wait(f => f.type === "projectForgotten" && f.projectId === project.id);
  assert.equal(relay.store.project(project.id), undefined);
});
