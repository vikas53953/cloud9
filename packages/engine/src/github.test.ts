// Branch + pull request, ALWAYS — and nothing leaves this machine without a yes.
//
// The GitHub calls themselves are driven through a fake runner, because a test
// that really opened pull requests would be a test that changes his repository
// every time the suite runs. What the fake runner lets us check is the thing
// that actually matters: the exact command line, and that there IS no command
// line at all until somebody approved it.
//
// The FACTS the command lines are built from were established by running the
// real gh 2.92.0 on this machine — see the header of github.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ApprovalRequiredError, findPullRequestUrl, GitHubClient, REMOTE_ACTIONS, RemoteAction,
} from "./github.js";
import { GitError } from "./worktree.js";
import { RunOptions, RunResult } from "./run.js";

const quiet = () => { /* tests do not narrate */ };

interface Call { cmd: string; args: string[]; opts: RunOptions }

/** A runner that records what it was asked to run and answers with a script. */
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

const worktree = {
  repoDir: "/repo", path: "/work/cloud9-a1-x", branch: "cloud9/a1-x", base: "master",
  agentId: "a1", taskId: "t1",
};

// ------------------------------------------------------- the gate is closed

test("a client with nobody to ask refuses everything, and pushes nothing", async () => {
  const { calls, runner } = fakeRunner();
  const gh = new GitHubClient({ runner, log: quiet });

  await assert.rejects(() => gh.pushBranch(worktree), (e: unknown) => e instanceof ApprovalRequiredError);
  await assert.rejects(() => gh.openPullRequest(worktree), (e: unknown) => e instanceof ApprovalRequiredError);
  assert.deepEqual(calls, [], "not one command ran — the refusal happens BEFORE the command line");
});

test("a no is a no, and it says which action in his words", async () => {
  const { calls, runner } = fakeRunner();
  const gh = new GitHubClient({ runner, approve: () => false, log: quiet });
  await assert.rejects(() => gh.pushBranch(worktree), (err: unknown) => {
    assert.ok(err instanceof ApprovalRequiredError);
    assert.equal(err.action, "push");
    assert.match(err.message, /push a branch to GitHub/);
    return true;
  });
  assert.deepEqual(calls, []);
});

test("an approver that throws is a no, never an accident", async () => {
  const { calls, runner } = fakeRunner();
  const gh = new GitHubClient({
    runner, log: quiet,
    approve: () => { throw new Error("the approval screen crashed"); },
  });
  await assert.rejects(() => gh.pushBranch(worktree), (e: unknown) => e instanceof ApprovalRequiredError);
  assert.deepEqual(calls, []);
});

test("every remote action is on ONE list, and each one asks", async () => {
  const asked: RemoteAction[] = [];
  const { runner } = fakeRunner(() => ({ stdout: "https://github.com/vikas53953/cloud9/pull/7" }));
  const gh = new GitHubClient({
    runner, log: quiet,
    approve: (action: RemoteAction) => { asked.push(action); return true; },
  });
  await gh.pushBranch(worktree);
  await gh.openPullRequest(worktree);
  assert.deepEqual(asked, ["push", "pullRequest"]);
  assert.ok(Object.keys(REMOTE_ACTIONS).includes("createRepo"), "the list names the third one too");
});

// ------------------------------------------------- the command lines themselves

test("the push is a branch push with an upstream, and the folder is not an argument", async () => {
  const { calls, runner } = fakeRunner();
  const gh = new GitHubClient({ runner, approve: () => true, log: quiet });
  await gh.pushBranch(worktree);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "git");
  assert.deepEqual(calls[0].args, ["push", "-u", "origin", "cloud9/a1-x"]);
  assert.equal(calls[0].opts.cwd, worktree.path, "the path rides in cwd, never in argv");
});

test("a pull request is branch → base, with the title coming off the commit", async () => {
  const { calls, runner } = fakeRunner(() => ({
    stdout: "Warning: 2 uncommitted changes\nhttps://github.com/vikas53953/cloud9/pull/12\n",
  }));
  const gh = new GitHubClient({ runner, approve: () => true, log: quiet });
  const pr = await gh.openPullRequest(worktree, { body: "What I did & why: `stuff`" });

  assert.deepEqual(calls[0].args, [
    "pr", "create", "--head", "cloud9/a1-x", "--base", "master", "--fill", "--body-file", "-",
  ]);
  assert.equal(calls[0].opts.stdin, "What I did & why: `stuff`",
    "a body an agent wrote goes in on stdin — it is never an argument");
  assert.equal(pr.url, "https://github.com/vikas53953/cloud9/pull/12");
  assert.equal(pr.base, "master");
});

test("nothing in this file can put anything on the default branch", async () => {
  const { calls, runner } = fakeRunner(() => ({ stdout: "https://github.com/v/c/pull/1" }));
  const gh = new GitHubClient({ runner, approve: () => true, log: quiet });
  await gh.pushBranch(worktree);
  await gh.openPullRequest(worktree);
  for (const call of calls) {
    assert.ok(!call.args.includes("master") || call.args.includes("--base"),
      "master appears only as the target a pull request aims AT");
    assert.ok(!call.args.some(a => a === "--admin" || a === "--merge" || a === "merge"),
      "no path here merges anything");
  }
});

test("a pull request GitHub did not confirm is a failure, not a shrug", async () => {
  const { runner } = fakeRunner(() => ({ stdout: "created something, somewhere" }));
  const gh = new GitHubClient({ runner, approve: () => true, log: quiet });
  await assert.rejects(() => gh.openPullRequest(worktree), (e: unknown) => e instanceof GitError);
});

test("gh failing is reported in its own first line, not swallowed", async () => {
  const { runner } = fakeRunner(() => ({ code: 1, stderr: "GraphQL: Could not resolve to a Repository\nmore noise" }));
  const gh = new GitHubClient({ runner, approve: () => true, log: quiet });
  await assert.rejects(() => gh.openPullRequest(worktree), (err: unknown) => {
    assert.match(String(err), /Could not resolve to a Repository/);
    return true;
  });
});

// ------------------------------------------------------------- reading only

test("who this computer is on GitHub needs no approval — it asks GitHub nothing", async () => {
  const { calls, runner } = fakeRunner(() => ({
    stdout: "github.com\n  ✓ Logged in to github.com account vikas53953 (keyring)\n" +
      "  - Git operations protocol: https\n",
  }));
  const gh = new GitHubClient({ runner, log: quiet }); // NO approver at all
  const who = await gh.account();
  assert.equal(who.signedIn, true);
  assert.equal(who.login, "vikas53953");
  assert.equal(who.protocol, "https", "there is no SSH key on this machine — https is the only route");
  assert.deepEqual(calls[0].args, ["auth", "status"]);
});

test("no gh on the computer is said in plain words, not as a crash", async () => {
  const { runner } = fakeRunner(() => ({ notFound: true, code: 1 }));
  const gh = new GitHubClient({ runner, log: quiet });
  const who = await gh.account();
  assert.equal(who.signedIn, false);
  assert.match(who.detail, /isn't installed/);
});

test("the pull request URL is found by its shape, not by being the last line", () => {
  assert.equal(findPullRequestUrl("noise\nhttps://github.com/a/b/pull/3\ntrailing note"),
    "https://github.com/a/b/pull/3");
  assert.equal(findPullRequestUrl("https://github.com/a/b/issues/3"), undefined);
  assert.equal(findPullRequestUrl(""), undefined);
});
