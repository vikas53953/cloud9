// LOOKING AT A REPOSITORY — the read-only half of GitHub (his item 7).
//
// WHAT THIS FILE IS REALLY GUARDING. A Projects screen that draws pull requests
// beautifully and is never given any is worth nothing, and the reason it was
// never given any is in `github.ts`'s own comment: `gh --json number,url` was
// written, shipped, and only ever exercised by a FAKE RUNNER that checked
// nothing. Against the real tool it threw `UnsafeArgumentError` every single
// time, because run.ts refuses a comma on purpose.
//
// So the first test below does not trust the fake: it takes the argv the look
// actually produced and pushes it through `commandLine`, the REAL function
// `run()` uses to build a command line. If a comma ever comes back, this fails
// here rather than in his hands.
//
// Everything else is the other half of the same law: every way this can fail
// must reach the screen as a sentence a non-developer can act on — never an
// empty list that reads like "no open work", never a stack trace.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ClientFrame, PROJECT_LIMITS, validateProjectItem } from "@cloud9/shared";
import { Engine } from "./engine.js";
import { GitHubClient, readItems, whyGitHubSaidNo } from "./github.js";
import { commandLine, RunOptions, RunResult, UnsafeArgumentError } from "./run.js";

const quiet = (): void => { /* tests do not narrate */ };

interface Call { cmd: string; args: string[]; opts: RunOptions }

/** A runner that records every command line and answers with a script. */
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
 * REAL OUTPUT, copied from `gh pr list --repo cli/cli --json ... ` run on this
 * machine on 2026-07-30. A test written against a shape we imagined would have
 * proved only that we can imagine consistently.
 */
const REAL_PULLS = JSON.stringify([
  {
    author: { id: "MDQ6VXNlcjc1NDAyMjM2", is_bot: false, login: "tidy-dev", name: "tidy-dev" },
    createdAt: "2026-07-29T14:38:39Z",
    headRefName: "tidy-dev-merge-worktree-guards",
    isDraft: false, number: 14007, state: "OPEN",
    title: "Guard `pr merge --delete-branch` against worktree conflicts",
    updatedAt: "2026-07-29T15:25:39Z",
    url: "https://github.com/cli/cli/pull/14007",
  },
  {
    author: { id: "MDQ6VXNlcjQ2OTQ0NjY5", is_bot: false, login: "michaeljacholke", name: "Michael Jacholke" },
    createdAt: "2026-07-29T14:22:34Z",
    headRefName: "mj/semantic-search-issues",
    isDraft: true, number: 14006, state: "OPEN",
    title: "Add --search-type flag for semantic and hybrid issue search",
    updatedAt: "2026-07-29T16:19:24Z",
    url: "https://github.com/cli/cli/pull/14006",
  },
]);

const REAL_ISSUES = JSON.stringify([
  {
    author: { login: "vikas53953" },
    createdAt: "2026-07-20T09:00:00Z", updatedAt: "2026-07-28T11:30:00Z",
    number: 12, state: "OPEN", title: "Agents cannot hand work to each other",
    url: "https://github.com/vikas53953/cloud9/issues/12",
  },
]);

/** A runner that answers the three commands a look makes, the way gh does. */
function lookRunner(over: (call: Call) => Partial<RunResult> = () => ({})) {
  return fakeRunner(call => {
    const said = over(call);
    if (Object.keys(said).length > 0) return said;
    if (call.args[0] === "auth") return { stderr: SIGNED_IN };
    if (call.args[0] === "repo") return { stdout: "master\n" };
    if (call.args[0] === "pr") return { stdout: REAL_PULLS };
    if (call.args[0] === "issue") return { stdout: REAL_ISSUES };
    return {};
  });
}

function client(runner: unknown): GitHubClient {
  return new GitHubClient({ runner: runner as never, log: quiet });
}

/* ============================================================================
   1. THE ARGV, AGAINST THE REAL GUARD — not against a fake that waves it through
   ========================================================================= */

test("every command a look at GitHub runs survives the REAL command-line guard", async () => {
  const { calls, runner } = lookRunner();
  await client(runner).lookAtRepository("vikas53953/cloud9");
  assert.ok(calls.length >= 3, `a look should have run three commands, ran ${calls.length}`);
  for (const call of calls) {
    // the same function run() itself calls. If this throws, the real tool would
    // never have been reached — which is exactly the bug that shipped before.
    assert.doesNotThrow(() => commandLine(call.cmd, call.args),
      `refused by the guard: gh ${call.args.join(" ")}`);
  }
});

test("no argument a look sends contains a comma — the guard refuses one, so we never need one", async () => {
  const { calls, runner } = lookRunner();
  await client(runner).lookAtRepository("vikas53953/cloud9");
  const withComma = calls.flatMap(c => c.args).filter(a => a.includes(","));
  assert.deepEqual(withComma, [], "a comma would be refused before gh ever ran");
  // and it asks for every column it needs, one flag at a time
  const pr = calls.find(c => c.args[0] === "pr")!;
  for (const field of ["number", "title", "url", "state", "headRefName", "author", "isDraft"]) {
    assert.ok(pr.args.includes(field), `the look never asked GitHub for ${field}`);
  }
});

test("the exact bug that shipped is still refused: gh --json number,url cannot be built", () => {
  assert.throws(() => commandLine("gh", ["pr", "list", "--json", "number,url"]),
    (err: unknown) => err instanceof UnsafeArgumentError,
    "the comma guard must stay closed — the fix was to stop needing a comma, not to widen it");
});

/* ============================================================================
   2. NOTHING A LOOK DOES CAN WRITE
   ========================================================================= */

test("a look runs read-only commands only — there is no path from it to a change on GitHub", async () => {
  const { calls, runner } = lookRunner();
  await client(runner).lookAtRepository("vikas53953/cloud9");
  const allowed = new Set(["repo view", "pr list", "issue list", "auth status"]);
  for (const call of calls) {
    assert.equal(call.cmd, "gh", "a look talks to gh and nothing else");
    assert.ok(allowed.has(`${call.args[0]} ${call.args[1]}`),
      `a look ran "gh ${call.args[0]} ${call.args[1]}", which is not read-only`);
  }
  // and the client it used has NO approver, so every gated method refuses
  await assert.rejects(
    () => client(runner).openPullRequest({
      repoDir: "/repo", path: "/w", branch: "cloud9/x-1", base: "master", agentId: "a", taskId: "t",
    } as never),
    /needs your approval first/);
});

test("a repository name that is not owner/name is refused before any command runs", async () => {
  const { calls, runner } = lookRunner();
  const look = await client(runner).lookAtRepository("not a repository");
  assert.ok(look.problem && /owner\/name/.test(look.problem), look.problem);
  assert.equal(calls.length, 0, "nothing may be handed to gh until the name is a name");
});

/* ============================================================================
   3. THE LISTS ACTUALLY FILL, FROM WHAT GH REALLY PRINTS
   ========================================================================= */

test("a look turns gh's real answer into pull requests and issues the hub will accept", async () => {
  const { runner } = lookRunner();
  const look = await client(runner).lookAtRepository("cli/cli");
  assert.equal(look.problem, undefined);
  assert.equal(look.defaultBranch, "master");
  const items = look.items ?? [];
  assert.equal(items.length, 3, JSON.stringify(items));
  // every row must pass the HUB's own gate, or the whole frame would be refused
  for (const item of items) {
    assert.equal(validateProjectItem({ ...item, projectId: "p1" }), null, JSON.stringify(item));
  }
  const first = items[0];
  assert.equal(first.kind, "pull");
  assert.equal(first.number, 14007);
  assert.equal(first.author, "tidy-dev");
  assert.equal(first.branch, "tidy-dev-merge-worktree-guards");
  assert.equal(first.state, "open");
  assert.equal(first.createdAt, Date.parse("2026-07-29T14:38:39Z"));
  const issue = items.find(i => i.kind === "issue")!;
  assert.equal(issue.number, 12);
  assert.equal(issue.branch, undefined, "an issue has no branch and must not be given one");
});

test("a draft pull request is its own state — it is not asking to be reviewed yet", async () => {
  const { runner } = lookRunner();
  const look = await client(runner).lookAtRepository("cli/cli");
  const draft = (look.items ?? []).find(i => i.number === 14006)!;
  assert.equal(draft.state, "draft");
});

test("merged and closed stay opposite outcomes — a look never flattens them", () => {
  const read = readItems("pull", JSON.stringify([
    { number: 39, title: "Redact secrets", state: "MERGED", url: "https://github.com/v/c/pull/39",
      createdAt: "2026-07-28T10:00:00Z", updatedAt: "2026-07-28T12:00:00Z" },
    { number: 38, title: "Widen visibleChannels", state: "CLOSED", url: "https://github.com/v/c/pull/38",
      createdAt: "2026-07-27T10:00:00Z", updatedAt: "2026-07-27T12:00:00Z" },
  ]));
  assert.ok("items" in read);
  assert.deepEqual(read.items.map(i => i.state), ["merged", "closed"]);
});

test("one unusable row costs itself and nothing else — the rest of the list survives", () => {
  const read = readItems("issue", JSON.stringify([
    { number: 1, title: "fine", state: "OPEN", url: "https://github.com/v/c/issues/1",
      createdAt: "2026-07-28T10:00:00Z", updatedAt: "2026-07-28T10:00:00Z" },
    // a link that is not GitHub's own: the hub would refuse the WHOLE frame
    { number: 2, title: "hostile", state: "OPEN", url: "javascript:alert(1)",
      createdAt: "2026-07-28T10:00:00Z", updatedAt: "2026-07-28T10:00:00Z" },
    { number: 3, title: "no dates", state: "OPEN", url: "https://github.com/v/c/issues/3" },
  ]));
  assert.ok("items" in read);
  assert.deepEqual(read.items.map(i => i.number), [1]);
});

test("a trunk that is not a branch name is not reported — a refused frame would lose the lists too", async () => {
  const { runner } = lookRunner(call => (call.args[0] === "repo" ? { stdout: "--force\n" } : {}));
  const look = await client(runner).lookAtRepository("vikas53953/cloud9");
  assert.equal(look.defaultBranch, undefined);
  assert.equal((look.items ?? []).length, 3, "the lists still come back");
});

test("a look asks GitHub for at most the number of items the hub will keep", async () => {
  const { calls, runner } = lookRunner();
  await client(runner).lookAtRepository("vikas53953/cloud9");
  for (const call of calls.filter(c => c.args[0] === "pr" || c.args[0] === "issue")) {
    const limit = call.args[call.args.indexOf("--limit") + 1];
    assert.equal(limit, String(PROJECT_LIMITS.lookItems));
  }
});

/* ============================================================================
   4. EVERY FAILURE REACHES THE SCREEN AS A SENTENCE
   ========================================================================= */

test("gh not installed is said in words, and no list is invented", async () => {
  const { runner } = lookRunner(() => ({ notFound: true, code: null }));
  const look = await client(runner).lookAtRepository("vikas53953/cloud9");
  assert.ok(/isn't installed/i.test(look.problem ?? ""), look.problem);
  assert.equal(look.items, undefined, "a failed look must never hand over an empty list");
});

test("not signed in to GitHub is said in words, and nothing else is even attempted", async () => {
  const { calls, runner } = lookRunner(call => (call.args[0] === "auth" ? { code: 1 } : {}));
  const look = await client(runner).lookAtRepository("vikas53953/cloud9");
  assert.ok(/not signed in/i.test(look.problem ?? ""), look.problem);
  assert.ok(/sign in/i.test(look.problem ?? ""), "it has to say what to do about it");
  assert.equal(calls.length, 1, "there is no point asking GitHub anything while signed out");
});

test("a repository that does not exist — or is somebody else's private one — is named and explained", async () => {
  const { runner } = lookRunner(call => (call.args[0] === "repo"
    ? { code: 1, stderr: "GraphQL: Could not resolve to a Repository with the name 'v/nope'. (repository)" }
    : {}));
  const look = await client(runner).lookAtRepository("vikas53953/nope");
  assert.ok(/vikas53953\/nope/.test(look.problem ?? ""), look.problem);
  assert.ok(/private/i.test(look.problem ?? ""), "the private case is the one he will actually hit");
  assert.equal(look.items, undefined);
});

test("being rate limited is said in words, with what to do about it", () => {
  const said = whyGitHubSaidNo("API rate limit exceeded for user ID 1234.", "vikas53953/cloud9");
  assert.ok(/slow down/i.test(said) && /few minutes/i.test(said), said);
  assert.ok(!/\brate limit exceeded for user ID\b/.test(said), "gh's own line is not the answer");
});

test("the network being down is said in words, not as a stack trace", () => {
  const said = whyGitHubSaidNo(
    'Get "https://api.github.com/repos/v/c": dial tcp: lookup api.github.com: no such host',
    "vikas53953/cloud9");
  assert.ok(/could not reach github\.com/i.test(said), said);
  assert.ok(!/dial tcp/.test(said), said);
});

test("a sign-in GitHub refuses is said in words", () => {
  const said = whyGitHubSaidNo("HTTP 401: Bad credentials (https://api.github.com/graphql)", "v/c");
  assert.ok(/sign in/i.test(said), said);
});

test("a problem sentence always fits the space the hub keeps for it", () => {
  const said = whyGitHubSaidNo("x".repeat(4000), "vikas53953/cloud9");
  assert.ok(said.length <= PROJECT_LIMITS.problem, `${said.length} characters`);
});

test("an answer from GitHub we cannot read is said in words, not thrown", () => {
  const read = readItems("pull", "<!DOCTYPE html><html>a proxy sign-in page</html>");
  assert.ok("problem" in read && /could not be read/i.test(read.problem), JSON.stringify(read));
});

test("GitHub answering nothing at all is an empty list, not a failure", () => {
  const read = readItems("pull", "[]\n");
  assert.ok("items" in read && read.items.length === 0);
});

/* ============================================================================
   5. THE ENGINE ALWAYS ANSWERS THE HUB
   ========================================================================= */

function engineFor(runner: unknown): { engine: Engine; frames: ClientFrame[] } {
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t",
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-look-")),
    github: { runner: runner as never, log: quiet },
  });
  const frames: ClientFrame[] = [];
  (engine as unknown as { sendFrame: (f: ClientFrame) => void }).sendFrame = f => { frames.push(f); };
  return { engine, frames };
}

test("told to look, the engine answers the hub with what GitHub said", async () => {
  const { runner } = lookRunner();
  const { engine, frames } = engineFor(runner);
  await engine.lookAtProject("p1", "cli/cli");
  engine.stop();
  assert.equal(frames.length, 1);
  const sent = frames[0] as Extract<ClientFrame, { type: "projectSynced" }>;
  assert.equal(sent.type, "projectSynced");
  assert.equal(sent.projectId, "p1");
  assert.equal(sent.defaultBranch, "master");
  assert.equal(sent.items?.length, 3);
  assert.ok(sent.items?.every(i => i.projectId === "p1"), "every row carries the project it belongs to");
});

test("a look that failed is still ANSWERED — silence would leave the button spinning for ever", async () => {
  const { runner } = lookRunner(() => ({ notFound: true, code: null }));
  const { engine, frames } = engineFor(runner);
  await engine.lookAtProject("p1", "vikas53953/cloud9");
  engine.stop();
  const sent = frames[0] as Extract<ClientFrame, { type: "projectSynced" }>;
  assert.equal(sent.type, "projectSynced");
  assert.ok(/isn't installed/i.test(sent.problem ?? ""), sent.problem);
  assert.equal(sent.items, undefined, "no items at all beats an empty list reading 'no open work'");
});

test("a runner that blows up is still answered, and never with the inside of a program", async () => {
  const exploding = (): Promise<RunResult> => Promise.reject(new Error("C:\\Users\\vikasmit secret stack"));
  const { engine, frames } = engineFor(exploding);
  await engine.lookAtProject("p1", "vikas53953/cloud9");
  engine.stop();
  const sent = frames[0] as Extract<ClientFrame, { type: "projectSynced" }>;
  assert.equal(sent.type, "projectSynced");
  assert.ok((sent.problem ?? "").length > 0);
  assert.ok(!/vikasmit|stack/i.test(sent.problem ?? ""), sent.problem);
});
