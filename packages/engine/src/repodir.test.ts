// WHERE THIS PROJECT'S CODE LIVES ON THIS COMPUTER — approval-handoff.md §8.
//
// THE HOLE THIS CLOSES. `EngineOptions.repoDir` was one folder, chosen once by
// whoever launched the engine, and NOTHING on screen could set it. So every
// `!code` and every `!issue` in a room either worked in that one folder — the
// wrong one, if he had two projects — or said "nobody has told Cloud9 where
// this project's code lives" for ever.
//
// ONE FUNCTION ANSWERS IT NOW: `Engine.repoDirFor(channelId)`. Everything that
// needs a repository directory asks it, so `!code` and `!issue` can never work
// in different folders, and the honesty rules are written once:
//  • a folder the owner linked wins over the launch-time one;
//  • a linked folder that is GONE is said out loud, never skipped over quietly
//    (falling back would work in the wrong repository, which is worse);
//  • no folder at all keeps the sentence that was already there.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClientFrame, Project, ServerFrame } from "@cloud9/shared";
import { Engine } from "./engine.js";
import { tempDir } from "./tmp-for-tests.js";

function tmpDir(name: string): string {
  return tempDir(name);
}

function engineWith(opts: { repoDir?: string } = {}): { engine: Engine; frames: ClientFrame[] } {
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t",
    dataDir: tmpDir("cloud9-repodir-"),
    ...(opts.repoDir ? { repoDir: opts.repoDir } : {}),
  });
  const frames: ClientFrame[] = [];
  (engine as unknown as { sendFrame: (f: ClientFrame) => void }).sendFrame = f => { frames.push(f); };
  return { engine, frames };
}

function project(over: Partial<Project> = {}): Project {
  return {
    id: "p1", ownerId: "u1", repo: "vikas53953/cloud9", name: "Cloud9",
    channelId: "c1", createdAt: 1, ...over,
  };
}

/** Feed the engine a hub frame the way the socket really would. */
function tell(engine: Engine, frame: ServerFrame): void {
  (engine as unknown as { onFrame: (f: ServerFrame) => void }).onFrame(frame);
}

test("a folder the owner linked to THIS conversation is the folder an agent works in", () => {
  const here = tmpDir("cloud9-code-");
  const { engine } = engineWith({ repoDir: tmpDir("cloud9-launch-") });
  tell(engine, { type: "project", project: project({ localPath: here }) });
  const found = engine.repoDirFor("c1");
  engine.stop();
  assert.deepEqual(found, { dir: here }, "the project he linked beats the launch-time folder");
});

test("two projects on one computer are two folders — the room decides which", () => {
  const one = tmpDir("cloud9-one-");
  const two = tmpDir("cloud9-two-");
  const { engine } = engineWith();
  tell(engine, {
    type: "projects",
    projects: [
      project({ id: "p1", channelId: "c1", localPath: one }),
      project({ id: "p2", channelId: "c2", repo: "vikas53953/fuse", name: "Fuse", localPath: two }),
    ],
  });
  assert.deepEqual(engine.repoDirFor("c1"), { dir: one });
  assert.deepEqual(engine.repoDirFor("c2"), { dir: two });
  engine.stop();
});

test("the launch-time folder is still the fallback — nothing that worked yesterday stops working", () => {
  const launch = tmpDir("cloud9-launch-");
  const { engine } = engineWith({ repoDir: launch });
  // a project with no folder linked, and a conversation with no project at all
  tell(engine, { type: "project", project: project() });
  assert.deepEqual(engine.repoDirFor("c1"), { dir: launch });
  assert.deepEqual(engine.repoDirFor("c-nobody"), { dir: launch });
  engine.stop();
});

test("a linked folder that is GONE is said in words — it is never quietly swapped for another", () => {
  const launch = tmpDir("cloud9-launch-");
  const gone = path.join(tmpDir("cloud9-gone-"), "moved-away");
  const { engine } = engineWith({ repoDir: launch });
  tell(engine, { type: "project", project: project({ localPath: gone }) });
  const found = engine.repoDirFor("c1");
  engine.stop();
  assert.ok("problem" in found, JSON.stringify(found));
  assert.ok(/not on this computer any more/i.test(found.problem), found.problem);
  assert.ok(found.problem.includes(gone), "he needs to see WHICH folder is missing");
  assert.ok(/Cloud9/.test(found.problem), "and which project it belonged to");
});

test("a file is not a folder — a path pointing at one is reported, not used", () => {
  const dir = tmpDir("cloud9-file-");
  const file = path.join(dir, "notes.txt");
  fs.writeFileSync(file, "hello\n");
  const { engine } = engineWith();
  tell(engine, { type: "project", project: project({ localPath: file }) });
  const found = engine.repoDirFor("c1");
  engine.stop();
  assert.ok("problem" in found && /not on this computer any more/i.test(found.problem), JSON.stringify(found));
});

test("with no folder anywhere, the sentence he already knew is unchanged", () => {
  const { engine } = engineWith();
  const found = engine.repoDirFor("c1");
  engine.stop();
  assert.ok("problem" in found);
  assert.ok(/Nobody has told Cloud9 where this project's code lives/.test(found.problem), found.problem);
  assert.ok(/Projects/.test(found.problem), "and now it says where to go and fix that");
});

test("a project that is forgotten takes its folder with it", () => {
  const here = tmpDir("cloud9-forget-");
  const { engine } = engineWith();
  tell(engine, { type: "project", project: project({ localPath: here }) });
  assert.deepEqual(engine.repoDirFor("c1"), { dir: here });
  tell(engine, { type: "projectForgotten", projectId: "p1" });
  const found = engine.repoDirFor("c1");
  engine.stop();
  assert.ok("problem" in found, "a disconnected project must not still point at a folder");
});

test("the engine ASKS for the projects the moment it is welcomed — otherwise it would claim nobody had said", () => {
  const { engine, frames } = engineWith();
  tell(engine, {
    type: "welcome",
    state: {
      me: { id: "u1", name: "Vikas", role: "owner" },
      users: [], agents: [], channels: [], messages: [], tasks: [], approvals: [],
    } as never,
  });
  engine.stop();
  assert.ok(frames.some(f => f.type === "projects"),
    `the engine never asked for the projects: ${JSON.stringify(frames.map(f => f.type))}`);
});

/* ------------------------------------------------------------------------
   AN AGENT CANNOT SET THE FOLDER — the engine has no way to say it.
   The hub refuses `setProjectFolder` from an engine connection (proved in
   apps/relay/src/projectfolder.test.ts); this is the other half of the same
   law, on this side of the wire: nothing an agent can drive ever builds that
   frame, so there is no path from a turn to a folder on this machine.
   --------------------------------------------------------------------- */

test("nothing in the engine ever sends setProjectFolder — the owner is the only source of a folder", () => {
  /* The `src` folder, resolved from THIS FILE — never from where you stood.
     (The same trick `writeoutcome.test.ts` uses to read this package's source.) */
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const src = path.resolve(here, "..", "src");
  const guilty: string[] = [];
  for (const name of fs.readdirSync(src)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    if (fs.readFileSync(path.join(src, name), "utf8").includes("setProjectFolder")) guilty.push(name);
  }
  assert.deepEqual(guilty, [],
    "the engine must never build a setProjectFolder frame — only the owner's screen may");
});
