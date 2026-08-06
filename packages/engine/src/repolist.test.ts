// THE REPOSITORY PICKER — "show me MY repositories", his ask of 2026-08-01.
//
// WHAT THIS FILE IS GUARDING. Connecting a project made him TYPE `owner/name`
// from memory, which is not how anything else he uses works. The fix is that
// the computer holding his GitHub sign-in is asked which repositories it can
// see. Three ways that could go wrong, and each has a test here:
//
//  1. The command never reaches gh at all. `--json a,b` did exactly that for a
//     day (run.ts refuses a comma), so the argv this file builds is pushed
//     through the REAL guard rather than a fake that waves it through.
//  2. A listing quietly becomes a way to CHANGE something. `repo list` is on
//     the read-only allowlist; `repo create` and `repo delete` are not, and a
//     listing has no approver, so every gated method still refuses.
//  3. A failure is drawn as "you have no repositories". `repos` absent and
//     `repos: []` are opposite facts and must stay that way the whole way from
//     gh to the frame.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClientFrame, REPO_LIST_LIMITS, validateRepoChoice } from "@cloud9/shared";
import { Engine } from "./engine.js";
import { GitHubClient, readRepoChoices } from "./github.js";
import { commandLine, RunOptions, RunResult } from "./run.js";
import { tempDir } from "./tmp-for-tests.js";

const quiet = (): void => { /* tests do not narrate */ };

interface Call { cmd: string; args: string[]; opts: RunOptions }

function fakeRunner(reply: (call: Call) => Partial<RunResult> = () => ({})) {
  const calls: Call[] = [];
  const runner = (cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    const call = { cmd, args, opts };
    calls.push(call);
    return Promise.resolve({
      code: 0, stdout: "", stderr: "", timedOut: false, notFound: false, ...reply(call),
    });
  };
  return { calls, runner: runner as never };
}

/** What `gh auth status` really prints on this machine (verified 2026-07-30). */
const SIGNED_IN = `github.com
  ✓ Logged in to github.com account vikas53953 (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'`;

/**
 * REAL OUTPUT. Copied from
 * `gh repo list --json nameWithOwner --json description --json visibility --json updatedAt --limit 3`
 * run on this machine with gh 2.92.0 on 2026-08-01. A test written against a
 * shape we imagined would only prove that we can imagine consistently — and it
 * is exactly how `--json number,url` survived review.
 */
const REAL_REPOS = JSON.stringify([
  { description: "", nameWithOwner: "vikas53953/cloud9", updatedAt: "2026-08-01T07:26:14Z", visibility: "PUBLIC" },
  {
    description: "The senior-engineer discipline loop for non-coders.",
    nameWithOwner: "vikas53953/graybeard", updatedAt: "2026-07-22T19:12:19Z", visibility: "PUBLIC",
  },
  {
    description: "Fuse — a DJ-first music app. Blend, mix, and play.",
    nameWithOwner: "vikas53953/fuse", updatedAt: "2026-07-22T07:01:35Z", visibility: "PRIVATE",
  },
]);

function listRunner(over: (call: Call) => Partial<RunResult> = () => ({})) {
  return fakeRunner(call => {
    const said = over(call);
    if (Object.keys(said).length > 0) return said;
    if (call.args[0] === "auth") return { stderr: SIGNED_IN };
    if (call.args[0] === "repo" && call.args[1] === "list") return { stdout: REAL_REPOS };
    return {};
  });
}

function client(runner: unknown): GitHubClient {
  return new GitHubClient({ runner: runner as never, log: quiet });
}

/* ============================================================================
   1. THE COMMAND REALLY REACHES GH
   ========================================================================= */

test("every command the picker runs survives the REAL command-line guard", async () => {
  const { calls, runner } = listRunner();
  await client(runner).listRepositories();
  assert.ok(calls.length >= 2, `expected auth + list, ran ${calls.length}`);
  for (const call of calls) {
    assert.doesNotThrow(() => commandLine(call.cmd, call.args),
      `refused by the guard: gh ${call.args.join(" ")}`);
  }
});

test("the picker asks for each column with its own --json flag, never a comma", async () => {
  const { calls, runner } = listRunner();
  await client(runner).listRepositories();
  const list = calls.find(c => c.args[0] === "repo" && c.args[1] === "list")!;
  assert.deepEqual(list.args.filter(a => a.includes(",")), [],
    "a comma would be refused before gh ever ran");
  for (const field of ["nameWithOwner", "description", "visibility", "updatedAt"]) {
    assert.ok(list.args.includes(field), `the picker never asked GitHub for ${field}`);
  }
  const limit = list.args[list.args.indexOf("--limit") + 1];
  assert.equal(limit, String(REPO_LIST_LIMITS.rows), "it asks for exactly what the hub will hold");
});

/* ============================================================================
   2. NOTHING THE PICKER DOES CAN WRITE
   ========================================================================= */

test("listing repositories runs read-only commands only", async () => {
  const { calls, runner } = listRunner();
  await client(runner).listRepositories();
  const allowed = new Set(["auth status", "repo list"]);
  for (const call of calls) {
    assert.equal(call.cmd, "gh", "the picker talks to gh and nothing else");
    assert.ok(allowed.has(`${call.args[0]} ${call.args[1]}`),
      `the picker ran "gh ${call.args[0]} ${call.args[1]}", which is not read-only`);
  }
  // and the client it used has NO approver, so every gated method still refuses
  await assert.rejects(
    () => client(runner).openPullRequest({
      repoDir: "/repo", path: "/w", branch: "cloud9/x-1", base: "master", agentId: "a", taskId: "t",
    } as never),
    /needs your approval first/);
});

/* ============================================================================
   3. THE LIST FILLS, FROM WHAT GH REALLY PRINTS
   ========================================================================= */

test("the picker turns gh's real answer into rows the hub will accept", async () => {
  const { runner } = listRunner();
  const found = await client(runner).listRepositories();
  assert.equal(found.problem, undefined);
  const repos = found.repos ?? [];
  assert.equal(repos.length, 3, JSON.stringify(repos));
  for (const row of repos) assert.equal(validateRepoChoice(row), null, JSON.stringify(row));
  assert.equal(repos[0].nameWithOwner, "vikas53953/cloud9");
  assert.equal(repos[0].description, undefined,
    "gh prints \"\" for a repository with no description — that is not a description");
  assert.equal(repos[0].visibility, "public", "gh SHOUTS its visibility; the screen does not");
  assert.equal(repos[0].updatedAt, Date.parse("2026-08-01T07:26:14Z"));
  assert.equal(repos[2].visibility, "private",
    "a private repository must never be drawn as a public one");
});

test("one unusable row costs itself and nothing else", () => {
  const found = readRepoChoices(JSON.stringify([
    { nameWithOwner: "vikas53953/cloud9", visibility: "PUBLIC" },
    // not owner/name — the hub would refuse the WHOLE frame over this one row
    { nameWithOwner: "--repo", visibility: "PUBLIC" },
    { nameWithOwner: "someone/else", visibility: "PRIVATE" },
  ]));
  assert.deepEqual((found.repos ?? []).map(r => r.nameWithOwner),
    ["vikas53953/cloud9", "someone/else"]);
});

test("a listing never carries more rows than the hub will hold", () => {
  const many = Array.from({ length: REPO_LIST_LIMITS.rows + 25 },
    (_v, i) => ({ nameWithOwner: `vikas53953/repo${i}`, visibility: "PUBLIC" }));
  const found = readRepoChoices(JSON.stringify(many));
  assert.equal((found.repos ?? []).length, REPO_LIST_LIMITS.rows);
});

test("GitHub answering with none is an empty list, NOT a failure", async () => {
  const { runner } = listRunner(call => (call.args[1] === "list" ? { stdout: "[]\n" } : {}));
  const found = await client(runner).listRepositories();
  assert.deepEqual(found.repos, [], "he really has none, and that is an answer");
  assert.equal(found.problem, undefined);
});

/* ============================================================================
   4. EVERY FAILURE IS A SENTENCE, AND NEVER AN EMPTY LIST
   ========================================================================= */

test("not signed in is said in words, and no list is invented", async () => {
  const { calls, runner } = listRunner(call => (call.args[0] === "auth" ? { code: 1 } : {}));
  const found = await client(runner).listRepositories();
  assert.ok(/not signed in/i.test(found.problem ?? ""), found.problem);
  assert.ok(/sign in/i.test(found.problem ?? ""), "it has to say what to do about it");
  assert.equal(found.repos, undefined,
    "an empty list would read as 'you have no repositories', which is a different fact");
  assert.equal(calls.length, 1, "there is no point asking GitHub anything while signed out");
});

test("gh not installed is said in words, and no list is invented", async () => {
  const { runner } = listRunner(() => ({ notFound: true, code: null }));
  const found = await client(runner).listRepositories();
  assert.ok(/isn't installed/i.test(found.problem ?? ""), found.problem);
  assert.equal(found.repos, undefined);
});

test("GitHub refusing the sign-in names no empty repository — the sentence stays readable", async () => {
  const { runner } = listRunner(call => (call.args[1] === "list"
    ? { code: 1, stderr: "GraphQL: Could not resolve to a User with the login of 'x'." }
    : {}));
  const found = await client(runner).listRepositories();
  assert.ok((found.problem ?? "").length > 0);
  assert.ok(!/repository called\s*\./.test(found.problem ?? ""),
    "a sentence with a hole where a repository name should be reads like a bug");
  assert.equal(found.repos, undefined);
});

test("an answer we cannot read is said in words, not thrown", () => {
  const found = readRepoChoices("<!DOCTYPE html><html>a proxy sign-in page</html>");
  assert.ok(/could not be read/i.test(found.problem ?? ""), JSON.stringify(found));
  assert.equal(found.repos, undefined);
});

/* ============================================================================
   5. THE ENGINE ALWAYS ANSWERS THE HUB
   ========================================================================= */

function engineFor(runner: unknown): { engine: Engine; frames: ClientFrame[] } {
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t",
    dataDir: tempDir("cloud9-repolist-"),
    github: { runner: runner as never, log: quiet },
  });
  const frames: ClientFrame[] = [];
  (engine as unknown as { sendFrame: (f: ClientFrame) => void }).sendFrame = f => { frames.push(f); };
  return { engine, frames };
}

test("asked for the repositories, the engine answers the hub with what gh said", async () => {
  const { runner } = listRunner();
  const { engine, frames } = engineFor(runner);
  await engine.listRepositories();
  engine.stop();
  const sent = frames.find(f => f.type === "repositoriesFound") as
    Extract<ClientFrame, { type: "repositoriesFound" }>;
  assert.ok(sent, JSON.stringify(frames));
  assert.equal(sent.repos?.length, 3);
  assert.equal(sent.problem, undefined);
});

test("a listing that failed is still ANSWERED — silence would leave the panel asking for ever", async () => {
  const { runner } = listRunner(() => ({ notFound: true, code: null }));
  const { engine, frames } = engineFor(runner);
  await engine.listRepositories();
  engine.stop();
  const sent = frames.find(f => f.type === "repositoriesFound") as
    Extract<ClientFrame, { type: "repositoriesFound" }>;
  assert.ok(/isn't installed/i.test(sent.problem ?? ""), sent.problem);
  assert.equal(sent.repos, undefined);
});

test("a runner that blows up is still answered, and never with the inside of a program", async () => {
  const exploding = (): Promise<RunResult> => Promise.reject(new Error("C:\\Users\\vikasmit secret stack"));
  const { engine, frames } = engineFor(exploding);
  await engine.listRepositories();
  engine.stop();
  const sent = frames.find(f => f.type === "repositoriesFound") as
    Extract<ClientFrame, { type: "repositoriesFound" }>;
  assert.ok((sent.problem ?? "").length > 0);
  assert.ok(!/vikasmit|stack/i.test(sent.problem ?? ""), sent.problem);
});

test("no token and no scope list ever appears on the frame", async () => {
  const { runner } = listRunner();
  const { engine, frames } = engineFor(runner);
  await engine.listRepositories();
  engine.stop();
  const said = JSON.stringify(frames);
  assert.ok(!/gho_|ghp_|Token scopes|keyring/i.test(said), said.slice(0, 300));
});
