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
  REMOTE_ACTIONS as SHARED_REMOTE_ACTIONS, RemoteActionFacts, mustAskBeforeActing,
} from "@cloud9/shared";
import {
  ApprovalRequiredError, findPullRequestUrl, GitHubClient, REMOTE_ACTIONS, RemoteAction,
} from "./github.js";
import { GitError } from "./worktree.js";
import { RunOptions, RunResult, safeArg } from "./run.js";

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

/**
 * The two READ-ONLY probes that run between "somebody is set up to be asked"
 * and the question itself: what is this repository called, and how many commits
 * are going up. They exist because "push a branch" cannot be judged by a
 * non-developer and "push 3 commits to a new branch cloud9/a1-x on
 * vikas53953/cloud9" can.
 *
 * They change nothing, anywhere. Every assertion about "what actually ran" in
 * this file is made against `changing()` below so that adding a way to DESCRIBE
 * an action can never quietly become a way to PERFORM one.
 */
function isProbe(call: Call): boolean {
  if (call.cmd === "gh") return call.args[0] === "repo" && call.args[1] === "view";
  if (call.cmd === "git") return call.args[0] === "rev-list";
  return false;
}

/** Everything that ran which was NOT one of those two probes. */
function changing(calls: Call[]): Call[] {
  return calls.filter(c => !isProbe(c));
}

/** A runner whose probes answer the way the real gh and git do on this machine. */
function repoRunner(reply: (call: Call) => Partial<RunResult> = () => ({})) {
  return fakeRunner(call => {
    if (call.cmd === "gh" && call.args[0] === "repo") return { stdout: "vikas53953/cloud9\n" };
    if (call.cmd === "git" && call.args[0] === "rev-list") return { stdout: "3\n" };
    return reply(call);
  });
}

// ------------------------------------------------------- the gate is closed

test("a client with nobody to ask refuses everything, and pushes nothing", async () => {
  const { calls, runner } = fakeRunner();
  const gh = new GitHubClient({ runner, log: quiet });

  await assert.rejects(() => gh.pushBranch(worktree), (e: unknown) => e instanceof ApprovalRequiredError);
  await assert.rejects(() => gh.openPullRequest(worktree), (e: unknown) => e instanceof ApprovalRequiredError);
  assert.deepEqual(calls, [], "not one command ran — the refusal happens BEFORE the command line");
});

test("a no is a no, and it says which action in his words", async () => {
  const { calls, runner } = repoRunner();
  const gh = new GitHubClient({ runner, approve: () => false, log: quiet });
  await assert.rejects(() => gh.pushBranch(worktree), (err: unknown) => {
    assert.ok(err instanceof ApprovalRequiredError);
    assert.equal(err.action, "push");
    assert.match(err.message, /push a branch to GitHub/);
    // and the refusal names the same thing the card named, so the sentence in
    // the conversation matches the sentence he saw
    assert.match(err.message, /push 3 commits to a new branch cloud9\/a1-x on vikas53953\/cloud9/);
    return true;
  });
  assert.deepEqual(changing(calls), [], "nothing that changes anything ran");
});

test("an approver that throws is a no, never an accident", async () => {
  const { calls, runner } = repoRunner();
  const gh = new GitHubClient({
    runner, log: quiet,
    approve: () => { throw new Error("the approval screen crashed"); },
  });
  await assert.rejects(() => gh.pushBranch(worktree), (e: unknown) => e instanceof ApprovalRequiredError);
  assert.deepEqual(changing(calls), []);
});

test("the facts on the card come from git and gh, never from the agent", async () => {
  // Verified failing before this round: the request said only "branch
  // cloud9/a1-x", which is not something a non-developer can judge — there was
  // no repository in it and no idea how much was going up.
  const { calls, runner } = repoRunner();
  let seen: RemoteActionFacts | undefined;
  const gh = new GitHubClient({
    runner, log: quiet,
    approve: (_a, _d, facts) => { seen = facts; return true; },
  });
  await gh.pushBranch(worktree, { files: 2 });
  assert.deepEqual(seen, {
    action: "push", branch: "cloud9/a1-x", base: "master",
    repo: "vikas53953/cloud9", commits: 3, files: 2,
  });
  // and both probes are read-only ones
  for (const c of calls.filter(isProbe)) {
    assert.ok(!c.args.includes("push") && !c.args.includes("create"), "a probe changes nothing");
  }
});

test("a repository gh cannot name is left out, never guessed at", async () => {
  const { runner } = fakeRunner(call => {
    if (call.cmd === "gh" && call.args[0] === "repo") return { code: 1, stderr: "no remote" };
    if (call.cmd === "git" && call.args[0] === "rev-list") return { code: 128 };
    return {};
  });
  let seen: RemoteActionFacts | undefined;
  const gh = new GitHubClient({
    runner, log: quiet, approve: (_a, _d, f) => { seen = f; return true; },
  });
  await gh.pushBranch(worktree);
  assert.equal(seen?.repo, undefined, "absent is the honest answer");
  assert.equal(seen?.commits, undefined);
});

test("the one list of remote actions is SHARED's, not a copy of it", () => {
  // Object identity, not equality. Two lists that happen to agree today are
  // exactly the drift this check exists to prevent — the hub writes the
  // sentence for these rows and the screen draws the card for them.
  assert.equal(REMOTE_ACTIONS, SHARED_REMOTE_ACTIONS);
  // and "must ask" has one owner, which says yes to every row of it
  for (const action of Object.keys(REMOTE_ACTIONS) as RemoteAction[]) {
    assert.equal(mustAskBeforeActing({ abilities: {} }, { remoteAction: action }), true);
  }
});

test("every remote action is on ONE list, and each one asks", async () => {
  const asked: RemoteAction[] = [];
  const { runner } = repoRunner(() => ({ stdout: "https://github.com/vikas53953/cloud9/pull/7" }));
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
  const { calls, runner } = repoRunner();
  const gh = new GitHubClient({ runner, approve: () => true, log: quiet });
  await gh.pushBranch(worktree);

  const ran = changing(calls);
  assert.equal(ran.length, 1);
  assert.equal(ran[0].cmd, "git");
  assert.deepEqual(ran[0].args, ["push", "-u", "origin", "cloud9/a1-x"]);
  assert.equal(ran[0].opts.cwd, worktree.path, "the path rides in cwd, never in argv");
});

test("a pull request is branch → base, with the title coming off the commit", async () => {
  const { calls, runner } = repoRunner(() => ({
    stdout: "Warning: 2 uncommitted changes\nhttps://github.com/vikas53953/cloud9/pull/12\n",
  }));
  const gh = new GitHubClient({ runner, approve: () => true, log: quiet });
  const pr = await gh.openPullRequest(worktree, { body: "What I did & why: `stuff`" });

  const ran = changing(calls);
  assert.deepEqual(ran[0].args, [
    "pr", "create", "--head", "cloud9/a1-x", "--base", "master", "--fill", "--body-file", "-",
  ]);
  assert.equal(ran[0].opts.stdin, "What I did & why: `stuff`",
    "a body an agent wrote goes in on stdin — it is never an argument");
  assert.equal(pr.url, "https://github.com/vikas53953/cloud9/pull/12");
  assert.equal(pr.base, "master");
});

test("nothing in this file can put anything on the default branch", async () => {
  const { calls, runner } = repoRunner(() => ({ stdout: "https://github.com/v/c/pull/1" }));
  const gh = new GitHubClient({ runner, approve: () => true, log: quiet });
  await gh.pushBranch(worktree);
  await gh.openPullRequest(worktree);
  for (const call of changing(calls)) {
    assert.ok(!call.args.includes("master") || call.args.includes("--base"),
      "master appears only as the target a pull request aims AT");
    assert.ok(!call.args.some(a => a === "--admin" || a === "--merge" || a === "merge"),
      "no path here merges anything");
  }
});

test("a pull request GitHub did not confirm is a failure, not a shrug", async () => {
  const { runner } = repoRunner(() => ({ stdout: "created something, somewhere" }));
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

// ------------------------------------------- the allowlist is not negotiable

test("no argument this file builds can be refused by the command-line allowlist", async () => {
  // FOUND BY RUNNING IT: `pullRequestFor` asked gh for `--json number,url`, and
  // run.ts refuses a comma — so against the REAL runner it threw
  // UnsafeArgumentError every time and never reached gh at all. Only a fake
  // runner had ever called it.
  //
  // CLASS, NOT CASE: this drives every method through the real `safeArg`, so a
  // future argument with a comma, a space or a quote in it fails here rather
  // than the first time somebody uses the feature.
  const seen: string[] = [];
  const checking = ((cmd: string, args: string[]): Promise<RunResult> => {
    safeArg(cmd);
    for (const a of args) { safeArg(a); seen.push(a); }
    const stdout = cmd === "gh" && args[0] === "repo" ? "vikas53953/cloud9\n"
      : cmd === "git" && args[0] === "rev-list" ? "2\n"
      : cmd === "gh" && args[0] === "pr" && args[1] === "list"
        ? '[{"url":"https://github.com/vikas53953/cloud9/pull/9"}]'
        : "https://github.com/vikas53953/cloud9/pull/9";
    return Promise.resolve({ code: 0, stdout, stderr: "", timedOut: false, notFound: false });
  }) as never;

  const gh = new GitHubClient({ runner: checking, approve: () => true, log: quiet });
  await gh.account();
  await gh.pushBranch(worktree);
  await gh.openPullRequest(worktree, { body: "a body with, commas & quotes \"like this\"" });
  const already = await gh.pullRequestFor(worktree);
  assert.deepEqual(already, { number: 9, url: "https://github.com/vikas53953/cloud9/pull/9" });
  assert.ok(seen.length > 0);
});
