// Parallel git worktrees (his item 7) — against REAL git, not a stub.
//
// This project has been bitten twice by assumed CLI behaviour, so these tests
// run `git` itself in a throwaway repository. Every claim in worktree.ts's
// header is checked here rather than remembered: that a branch can only be
// checked out once, that removing a worktree keeps the branch, that git refuses
// to throw away uncommitted work, and that a commit message full of shell
// metacharacters survives because it never goes near a command line.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  branchNameFor, commitMessage, GitError, GitWorkspace, isSafeBranchName, worktreePathFor,
} from "./worktree.js";
import { run } from "./run.js";

const quiet = () => { /* tests do not narrate */ };

/** A real repository with one commit, thrown away afterwards. */
async function makeRepo(): Promise<{ repoDir: string; root: string }> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-wt-"));
  const repoDir = path.join(base, "repo");
  fs.mkdirSync(repoDir);
  await run("git", ["init", "-q", "-b", "master"], { cwd: repoDir });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await run("git", ["config", "user.name", "Cloud9Test"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "a.txt"), "hello\n");
  await run("git", ["add", "-A"], { cwd: repoDir });
  await run("git", ["commit", "-q", "-F", "-"], { cwd: repoDir, stdin: "base\n" });
  return { repoDir, root: path.join(base, "engine-data") };
}

// --------------------------------------------------------------- the names

test("branch names are generated, never accepted as text", () => {
  const name = branchNameFor({ agentId: "a_Scout 01", taskId: "t/9", at: 0 });
  assert.match(name, /^cloud9\//, "his repository always says which branches an agent made");
  assert.ok(isSafeBranchName(name));
  // the characters that would have needed escaping simply do not survive
  assert.doesNotMatch(name, /[ _/]t/);
});

test("a branch name that git or our command line would choke on is refused", () => {
  assert.equal(isSafeBranchName("cloud9/ok-1"), true);
  assert.equal(isSafeBranchName("master"), false, "nothing may be made outside our own prefix");
  assert.equal(isSafeBranchName("cloud9/../escape"), false);
  assert.equal(isSafeBranchName("cloud9/a b"), false);
  assert.equal(isSafeBranchName("cloud9/a;rm -rf"), false);
  assert.equal(isSafeBranchName("cloud9/x.lock"), false);
  assert.equal(isSafeBranchName("cloud9/x/"), false);
});

test("two jobs for one agent get two different workspaces", () => {
  const a = branchNameFor({ agentId: "a1", taskId: "t1", at: 1 });
  const b = branchNameFor({ agentId: "a1", taskId: "t2", at: 1 });
  assert.notEqual(a, b);
  assert.notEqual(worktreePathFor("/root", a), worktreePathFor("/root", b));
});

test("a commit message is a subject, a blank line, and the rest", () => {
  assert.equal(commitMessage({ title: "Fix  the\nbuild", body: "why" }), "Fix the build\n\nwhy\n");
  assert.equal(commitMessage({ title: "", body: "" }), "Cloud9 agent changes\n");
});

// ------------------------------------------------------- against real git

test("an agent gets its own checkout of the repository", async () => {
  const { repoDir, root } = await makeRepo();
  const git = new GitWorkspace({ root, log: quiet });

  assert.equal(await git.isRepo(repoDir), true);
  assert.equal(await git.isRepo(root), false, "a folder that is not a repository is not one");
  assert.equal(await git.defaultBranch(repoDir), "master",
    "read from the repository — half the world says main and half says master");

  const wt = await git.prepare({ repoDir, agentId: "a1", taskId: "t1" });
  assert.ok(fs.existsSync(path.join(wt.path, "a.txt")), "the files are really there");
  assert.equal(wt.base, "master");
  assert.ok(!wt.path.startsWith(repoDir), "an agent's workspace is never inside the repository");
});

test("TWO agents work one repository at the same time without colliding", async () => {
  const { repoDir, root } = await makeRepo();
  const git = new GitWorkspace({ root, log: quiet });

  const [one, two] = await Promise.all([
    git.prepare({ repoDir, agentId: "a1", taskId: "t1" }),
    git.prepare({ repoDir, agentId: "a2", taskId: "t2" }),
  ]);
  assert.notEqual(one.branch, two.branch);

  fs.writeFileSync(path.join(one.path, "one.txt"), "from agent one\n");
  fs.writeFileSync(path.join(two.path, "two.txt"), "from agent two\n");
  await git.commitAll(one, { title: "Agent one's change" });
  await git.commitAll(two, { title: "Agent two's change" });

  // neither can see the other's work-in-progress, which is the whole point
  assert.equal(fs.existsSync(path.join(one.path, "two.txt")), false);
  assert.equal(fs.existsSync(path.join(two.path, "one.txt")), false);

  const listed = await git.list(repoDir);
  const branches = listed.map(w => w.branch).filter(Boolean);
  assert.ok(branches.includes(one.branch));
  assert.ok(branches.includes(two.branch));
});

test("git itself refuses a second workspace on one branch — and we report it", async () => {
  const { repoDir, root } = await makeRepo();
  const git = new GitWorkspace({ root, log: quiet });
  const wt = await git.prepare({ repoDir, agentId: "a1", taskId: "t1", at: 7 });
  await assert.rejects(
    () => git.prepare({ repoDir, agentId: "a1", taskId: "t1", at: 7 }),
    (err: unknown) => err instanceof GitError,
    "the collision guard is git's own, and its refusal is passed on rather than worked around");
  assert.ok(wt.branch);
});

test("a commit message full of shell metacharacters survives intact", async () => {
  const { repoDir, root } = await makeRepo();
  const git = new GitWorkspace({ root, log: quiet });
  const wt = await git.prepare({ repoDir, agentId: "a1" });

  assert.equal((await git.status(wt)).clean, true);
  fs.writeFileSync(path.join(wt.path, "b.txt"), "new file\n");
  const state = await git.status(wt);
  assert.equal(state.clean, false);
  assert.deepEqual(state.files, ["b.txt"]);

  const nasty = 'Fix "the" build & $PATH `now`';
  const result = await git.commitAll(wt, { title: nasty, body: "rm -rf / ; echo pwned" });
  assert.equal(result.committed, true);
  assert.equal(result.files, 1);
  assert.ok(result.sha);

  // note: `--format=%s` cannot be asked for here — run.ts refuses `%` outright,
  // which is the allowlist doing exactly its job. The plain log carries the
  // subject indented, and that is enough to prove it survived.
  const log = await run("git", ["log", "-1"], { cwd: wt.path });
  assert.ok(log.stdout.includes(nasty), "it went in on stdin, so nothing had to be escaped");
  assert.ok(log.stdout.includes("rm -rf / ; echo pwned"),
    "and the body is stored as words, never run as a command");
  assert.equal(await git.hasNewCommits(wt), true);
});

test("nothing to commit is an answer, not a failure", async () => {
  const { repoDir, root } = await makeRepo();
  const git = new GitWorkspace({ root, log: quiet });
  const wt = await git.prepare({ repoDir, agentId: "a1" });
  const result = await git.commitAll(wt, { title: "nothing happened" });
  assert.deepEqual(result, { committed: false, files: 0 });
  assert.equal(await git.hasNewCommits(wt), false);
});

// ----------------------------------------------------------------- cleanup

test("cleanup keeps the branch — it is what the pull request points at", async () => {
  const { repoDir, root } = await makeRepo();
  const git = new GitWorkspace({ root, log: quiet });
  const wt = await git.prepare({ repoDir, agentId: "a1" });
  fs.writeFileSync(path.join(wt.path, "b.txt"), "work\n");
  await git.commitAll(wt, { title: "Some work" });

  const cleaned = await git.cleanup(wt);
  assert.equal(cleaned.removed, true);
  assert.equal(fs.existsSync(wt.path), false, "the folder is gone");

  const branches = await run("git", ["branch", "--list", wt.branch], { cwd: repoDir });
  assert.match(branches.stdout, new RegExp(wt.branch.replace("/", "\\/")),
    "the work itself is not gone");
});

test("cleanup will NOT throw away work nobody committed", async () => {
  const { repoDir, root } = await makeRepo();
  const git = new GitWorkspace({ root, log: quiet });
  const wt = await git.prepare({ repoDir, agentId: "a1" });
  fs.writeFileSync(path.join(wt.path, "unsaved.txt"), "an hour of work\n");

  const refused = await git.cleanup(wt);
  assert.equal(refused.removed, false, "git refuses, and we do not argue with it");
  assert.match(refused.reason ?? "", /force/i);
  assert.equal(fs.existsSync(path.join(wt.path, "unsaved.txt")), true);

  // throwing it away has to be a second, deliberate decision
  const forced = await git.cleanup(wt, { force: true });
  assert.equal(forced.removed, true);
});
