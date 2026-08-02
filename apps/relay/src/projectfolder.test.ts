// TWO THINGS THE HUB LEARNED ON 2026-08-01, and what stops each being abused.
//
//  1. A PROJECT CAN BE LINKED TO A FOLDER on the owner's computer
//     (approval-handoff.md §8). The folder is a local fact and may travel on a
//     frame — but it may only ever be set BY THE OWNER, FROM A WINDOW. An agent
//     that could set it could point `!code` at any folder on the machine, so an
//     ENGINE connection is refused, and that refusal is the test below.
//
//  2. THE PICKER can ask which repositories his GitHub sign-in can see. The hub
//     cannot reach GitHub and never will: it forwards the question to the
//     owner's own engine, and it is the engine — and only the engine — that may
//     answer. A window that could answer could put any repository on his screen.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { PROJECT_LIMITS, REPO_LIST_LIMITS, ServerFrame, validateLocalFolder } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const FOLDER = process.platform === "win32" ? "C:\\Users\\vikasmit\\cloud9" : "/home/vikas/cloud9";

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

/** Connect a repository and let the look that connecting starts finish. */
async function connect(owner: TestClient, engine: TestClient, repo = "vikas53953/cloud9") {
  owner.send({ type: "connectProject", repo });
  const f = await owner.wait<Extract<ServerFrame, { type: "project" }>>(
    g => g.type === "project" && g.project.repo === repo);
  await engine.wait(g => g.type === "lookAtProject" && g.projectId === f.project.id);
  engine.send({ type: "projectSynced", projectId: f.project.id, items: [] });
  await owner.wait(g => g.type === "project" && g.project.id === f.project.id && !!g.project.syncedAt);
  await engine.wait(g => g.type === "project" && g.project.id === f.project.id && !!g.project.syncedAt);
  owner.frames.length = 0;
  engine.frames.length = 0;
  return f.project;
}

/* ==========================================================================
   1. LINKING A PROJECT TO A FOLDER
   ======================================================================= */

test("the owner can say where a project's code lives, and it comes back on the project", async t => {
  const { owner, engine } = await stand(t, "folder-set.db");
  const project = await connect(owner, engine);
  owner.send({ type: "setProjectFolder", projectId: project.id, path: FOLDER });
  const said = await owner.wait<Extract<ServerFrame, { type: "project" }>>(
    f => f.type === "project" && f.project.id === project.id && !!f.project.localPath);
  assert.equal(said.project.localPath, FOLDER);
});

test("THE ENGINE — an agent's own connection — cannot set the folder", async t => {
  const { owner, engine } = await stand(t, "folder-agent.db");
  const project = await connect(owner, engine);
  engine.send({ type: "setProjectFolder", projectId: project.id, path: FOLDER });
  const refusal = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(/only you can say where your code lives/i.test(refusal.error), refusal.error);
  // and nothing was stored — the project is unchanged
  owner.send({ type: "projects" });
  const list = await owner.wait<Extract<ServerFrame, { type: "projects" }>>(f => f.type === "projects");
  assert.equal(list.projects.find(p => p.id === project.id)?.localPath, undefined);
});

test("the engine IS told where the code is — that is how the copy running the agents finds out", async t => {
  const { owner, engine } = await stand(t, "folder-told.db");
  const project = await connect(owner, engine);
  owner.send({ type: "setProjectFolder", projectId: project.id, path: FOLDER });
  const seen = await engine.wait<Extract<ServerFrame, { type: "project" }>>(
    f => f.type === "project" && f.project.id === project.id && !!f.project.localPath);
  assert.equal(seen.project.localPath, FOLDER);
});

test("a folder that is not a whole path is refused in the rule's own sentence", async t => {
  const { owner, engine } = await stand(t, "folder-bad.db");
  const project = await connect(owner, engine);
  owner.send({ type: "setProjectFolder", projectId: project.id, path: "code/cloud9" });
  const refusal = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.equal(refusal.error, validateLocalFolder("code/cloud9"),
    "the hub and the screen must say the same words — there is one rule");
});

test("a folder that climbs out of itself is refused", async t => {
  const { owner, engine } = await stand(t, "folder-climb.db");
  const project = await connect(owner, engine);
  owner.send({ type: "setProjectFolder", projectId: project.id, path: `${FOLDER}\\..\\..\\Windows` });
  const refusal = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(refusal.error.length > 0, refusal.error);
});

test("an empty path UNLINKS the folder rather than storing an empty one", async t => {
  const { owner, engine } = await stand(t, "folder-clear.db");
  const project = await connect(owner, engine);
  owner.send({ type: "setProjectFolder", projectId: project.id, path: FOLDER });
  await owner.wait(f => f.type === "project" && !!f.project.localPath);
  owner.send({ type: "setProjectFolder", projectId: project.id, path: "" });
  const cleared = await owner.wait<Extract<ServerFrame, { type: "project" }>>(
    f => f.type === "project" && f.project.id === project.id && !f.project.localPath);
  assert.equal(cleared.project.localPath, undefined, "absent means absent — never \"\"");
});

test("somebody else's project cannot be given a folder, and cannot be probed either", async t => {
  const { owner, engine, open } = await stand(t, "folder-other.db");
  const project = await connect(owner, engine);
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${inv.code}:Priya`);
  await friend.wait(f => f.type === "welcome");
  friend.send({ type: "setProjectFolder", projectId: project.id, path: FOLDER });
  const refusal = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.equal(refusal.error, "no such project",
    "an invented id and somebody else's must get the SAME answer");
});

test("a folder path longer than the hub will keep is refused, not trimmed", async t => {
  const { owner, engine } = await stand(t, "folder-long.db");
  const project = await connect(owner, engine);
  const long = `${FOLDER}\\${"x".repeat(PROJECT_LIMITS.path)}`;
  owner.send({ type: "setProjectFolder", projectId: project.id, path: long });
  const refusal = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(/too long/i.test(refusal.error), refusal.error);
});

/* ==========================================================================
   2. THE REPOSITORY PICKER
   ======================================================================= */

test("asking for his repositories is forwarded to the computer with the GitHub sign-in", async t => {
  const { owner, engine } = await stand(t, "repos-ask.db");
  owner.send({ type: "listRepositories" });
  await engine.wait(f => f.type === "listRepositoriesRequested");
});

/**
 * THE RECEIPT, and the bug it exists for — found by QA, not imagined.
 *
 * Every other frame the hub reads is answered before it reads the next, and the
 * screen relies on that to know whose refusal a later `error` belongs to (the
 * oldest question still waiting). `listRepositories` is handed to the engine
 * instead, so with no answer of its own it sat in that queue and CAUGHT
 * SOMEBODY ELSE'S REFUSAL: naming a second project the same as an existing one
 * was reported as "we could not list your repositories", and the box he had to
 * change said nothing.
 */
test("the ask is answered at once with a receipt, so a later refusal is never pinned on it", async t => {
  const { owner, engine } = await stand(t, "repos-receipt.db");
  owner.send({ type: "listRepositories" });
  const receipt = await owner.wait<Extract<ServerFrame, { type: "repositories" }>>(
    f => f.type === "repositories");
  assert.equal(receipt.asking, true, "the receipt says a question is out, not that there are none");
  assert.equal(receipt.repos, undefined, "a receipt is not an answer and carries no list");

  // now refuse something else while the engine has still not answered
  await engine.wait(f => f.type === "listRepositoriesRequested");
  owner.send({ type: "connectProject", repo: "not a repository" });
  const refusal = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(/owner\/name/.test(refusal.error),
    `the refusal that came back was about something else: ${refusal.error}`);
});

test("what the engine found reaches his screen, stamped with when the HUB heard it", async t => {
  const { owner, engine } = await stand(t, "repos-found.db");
  const before = Date.now();
  owner.send({ type: "listRepositories" });
  await engine.wait(f => f.type === "listRepositoriesRequested");
  engine.send({
    type: "repositoriesFound",
    repos: [
      { nameWithOwner: "vikas53953/cloud9", visibility: "public", updatedAt: 1_700_000_000_000 },
      { nameWithOwner: "vikas53953/fuse", description: "A DJ-first music app", visibility: "private" },
    ],
  });
  const got = await owner.wait<Extract<ServerFrame, { type: "repositories" }>>(
    // the RECEIPT comes first and is not the answer — wait for what the engine really said
    f => f.type === "repositories" && !f.asking);
  assert.deepEqual(got.repos?.map(r => r.nameWithOwner), ["vikas53953/cloud9", "vikas53953/fuse"]);
  assert.ok(got.fetchedAt >= before, "the hub stamps when it heard, not the engine");
  assert.equal(got.problem, undefined);
});

test("a WINDOW cannot answer with repositories — only the computer that really asked gh", async t => {
  const { owner, engine } = await stand(t, "repos-window.db");
  void engine;
  owner.send({ type: "repositoriesFound", repos: [{ nameWithOwner: "attacker/lookalike" }] });
  const refusal = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(/only the engine asks GitHub/i.test(refusal.error), refusal.error);
});

test("a row that is not a repository name is refused — it would end up on a command line", async t => {
  const { owner, engine } = await stand(t, "repos-bad.db");
  owner.send({ type: "listRepositories" });
  await engine.wait(f => f.type === "listRepositoriesRequested");
  engine.send({ type: "repositoriesFound", repos: [{ nameWithOwner: "--repo" }] });
  const refusal = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(refusal.error.length > 0, refusal.error);
});

test("more repositories than the hub will hold is refused rather than half-drawn", async t => {
  const { owner, engine } = await stand(t, "repos-many.db");
  owner.send({ type: "listRepositories" });
  await engine.wait(f => f.type === "listRepositoriesRequested");
  engine.send({
    type: "repositoriesFound",
    repos: Array.from({ length: REPO_LIST_LIMITS.rows + 1 },
      (_v, i) => ({ nameWithOwner: `vikas53953/repo${i}` })),
  });
  const refusal = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(/more repositories/i.test(refusal.error), refusal.error);
});

test("the engine saying it could not ask reaches his screen as WORDS, never an empty list", async t => {
  const { owner, engine } = await stand(t, "repos-problem.db");
  owner.send({ type: "listRepositories" });
  await engine.wait(f => f.type === "listRepositoriesRequested");
  engine.send({ type: "repositoriesFound", problem: "you're not signed in to GitHub on this computer" });
  const got = await owner.wait<Extract<ServerFrame, { type: "repositories" }>>(
    // the RECEIPT comes first and is not the answer — wait for what the engine really said
    f => f.type === "repositories" && !f.asking);
  assert.ok(/not signed in/i.test(got.problem ?? ""), got.problem);
  assert.equal(got.repos, undefined,
    "an empty list would read as 'you have no repositories', which is a different fact");
});

test("with nothing running on the computer that has the sign-in, he is told WHY, at once", async t => {
  const relay = new Relay({ dbPath: tmp("repos-noengine.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const owner = new TestClient(`ws://127.0.0.1:${port}`, "tok-owner", "desktop");
  t.after(() => { owner.close(); relay.close(); });
  await owner.wait(f => f.type === "welcome");
  owner.send({ type: "listRepositories" });
  const got = await owner.wait<Extract<ServerFrame, { type: "repositories" }>>(
    // the RECEIPT comes first and is not the answer — wait for what the engine really said
    f => f.type === "repositories" && !f.asking);
  assert.ok(/isn't running/i.test(got.problem ?? ""), got.problem);
  assert.ok(/type the repository/i.test(got.problem ?? ""),
    "and it points at the way in that still works");
  assert.equal(got.repos, undefined);
});
