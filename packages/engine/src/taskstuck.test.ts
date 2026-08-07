import { tempDir } from "./tmp-for-tests.js";
// "STUCK — WAITING ON SOMETHING", AND THE ONE CASE WHERE IT IS TRUE.
//
// `blocked` has been a task state since the jobs list was drawn, and the screen
// has always known how to say it ("Stuck — waiting on something", with the
// reason underneath). The engine never once produced it: every job it ran was
// working, done, failed or stopped. A state the product can SHOW but can never
// REACH is a promise the app does not keep.
//
// Every test in this file failed before this change:
//  * a job standing at the permission card now SAYS it is stuck, and on whom;
//  * a yes, a no, silence for the whole ten minutes, and the hub going away all
//    end the wait — a stuck state with no way out would be worse than none;
//  * a job that really fell over is still FAILED, never dressed up as stuck;
//  * the sentence he reads carries no folder, no command line and no
//    environment value, like every other free-text field this process sends.
//
// REAL GIT, FAKE GITHUB, driven the way the hub drives the engine — the same
// rig as `repowork.test.ts`, because the facts on the card have to be OBSERVED.
// Only `git push` and `gh pr create` are stubbed.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentDef, Approval, ClientFrame, ID, ServerFrame, Task, WorldState,
} from "@cloud9/shared";
import { ApprovalDesk } from "./approvaldesk.js";
import { Engine } from "./engine.js";
import { ClaudeProvider, RespondInput } from "./provider.js";
import { run, RunOptions, RunResult } from "./run.js";

const tmp = (prefix: string): string => tempDir(prefix);

const AGENT: AgentDef = {
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You write code",
  abilities: { webSearch: false, files: true, schedules: false, background: true },
  approvals: { background: false, schedules: false },
  createdAt: 0,
};

function world(): WorldState {
  return {
    me: { id: "u1", name: "Vikas", createdAt: 0 } as WorldState["me"],
    users: [{ id: "u1", name: "Vikas", createdAt: 0 } as WorldState["users"][number]],
    agents: [AGENT],
    channels: [{
      id: "c1", name: "ops", kind: "channel", memberIds: ["u1", "a1"], createdAt: 0,
    }],
    messages: [], agentStatus: {}, tasks: [], approvals: [],
  };
}

const job = (title: string): Task => ({
  id: "t1", title, requesterId: "u1", requesterName: "Vikas",
  agentId: "a1", channelId: "c1", status: "not_started", createdAt: 0, updatedAt: 0,
});

/** A real repository with one commit, thrown away with the temp folder. */
async function makeRepo(): Promise<string> {
  const repoDir = path.join(tmp("cloud9-stuck-"), "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  await run("git", ["init", "-q", "-b", "master"], { cwd: repoDir });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await run("git", ["config", "user.name", "Cloud9Test"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  await run("git", ["add", "-A"], { cwd: repoDir });
  await run("git", ["commit", "-q", "-F", "-"], { cwd: repoDir, stdin: "base\n" });
  return repoDir;
}

/** The harness, stubbed: it writes what it says it wrote, or it falls over. */
class Worker implements ClaudeProvider {
  constructor(
    private reply: string,
    private writes: Record<string, string> = {},
    private fail = false,
  ) {}

  async respond(input: RespondInput): Promise<string> {
    if (this.fail) throw new Error("the harness fell over");
    for (const [name, text] of Object.entries(this.writes)) {
      assert.ok(input.workdir, "a repository turn must happen in its own worktree");
      fs.writeFileSync(path.join(input.workdir!, name), text);
    }
    return this.reply;
  }
}

function fakeGitHub(): { runner: (c: string, a: string[], o?: RunOptions) => Promise<RunResult> } {
  const runner = async (command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false, notFound: false });
    if (command === "git" && args[0] === "push") return ok("");
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      return ok("https://github.com/vikas53953/cloud9/pull/7\n");
    }
    if (command === "gh" && args[0] === "repo" && args[1] === "view") return ok("vikas53953/cloud9\n");
    if (command === "gh") return ok("");
    return run(command, args, opts);   // real git for everything that only reads
  };
  return { runner };
}

interface Rig {
  frames: ClientFrame[];
  feed: (f: ServerFrame) => void;
  repoDir: string;
}

async function rig(t: TestContext, input: {
  reply: string;
  writes?: Record<string, string>;
  fail?: boolean;
}): Promise<Rig> {
  const repoDir = await makeRepo();
  const { runner } = fakeGitHub();
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp("cloud9-stuck-data-"),
    provider: new Worker(input.reply, input.writes ?? {}, input.fail ?? false),
    repoDir,
    github: { runner, log: () => { /* quiet */ } },
  });
  const frames: ClientFrame[] = [];
  (engine as unknown as { sendFrame: (f: ClientFrame) => void }).sendFrame = f => { frames.push(f); };
  const feed = (f: ServerFrame): void =>
    (engine as unknown as { onFrame: (f: ServerFrame) => void }).onFrame(f);
  feed({ type: "welcome", state: world() });
  t.after(() => { engine.stop(); });
  return { frames, feed, repoDir };
}

type Update = Extract<ClientFrame, { type: "updateTask" }>;

const updates = (frames: ClientFrame[]): Update[] =>
  frames.filter(f => f.type === "updateTask") as Update[];

const statuses = (frames: ClientFrame[]): string[] => updates(frames).map(u => u.status);

// 45 seconds, not 20: every rig here drives REAL git (a worktree, a commit, a
// count) and the whole suite runs its files at once, so a Windows box under
// that load has taken over 20 seconds to reach a card that was never in doubt.
// A slow machine must not read as a broken feature.
async function waitFor<T>(get: () => T | undefined, why: string, ms = 45_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error(`gave up waiting: ${why}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

/** Answer the card the way the hub does: a receipt, then a decision. */
function decide(feed: (f: ServerFrame) => void, askId: string, status: Approval["status"]): void {
  const approvalId = `ap_${askId}`;
  feed({ type: "approvalAsked", askId, approvalId });
  feed({
    type: "approval",
    approval: {
      id: approvalId, agentId: "a1", ownerId: "u1", action: "push a branch to GitHub",
      status, kind: "action", createdAt: 0,
    } as Approval,
  });
}

/** The job standing at the card, once the card is really on the wire. */
async function untilStuck(frames: ClientFrame[]): Promise<{ askId: string; stuck: Update }> {
  const ask = await waitFor(
    () => frames.find(f => f.type === "askApproval") as Extract<ClientFrame, { type: "askApproval" }> | undefined,
    "the agent to ask to publish");
  const stuck = await waitFor(
    () => updates(frames).find(u => u.status === "blocked"), "the job to say it is stuck");
  return { askId: ask.askId, stuck };
}

// =========================================================== it says it is stuck

test("a job waiting on a permission card reads stuck, with a plain-words reason", async t => {
  const { frames, feed } = await rig(t, {
    reply: "Fixed the build.\n!publish", writes: { "fix.txt": "patched\n" },
  });
  feed({ type: "task", task: job("!code fix the build") });

  const { stuck } = await untilStuck(frames);
  assert.equal(stuck.taskId, "t1");
  assert.ok(stuck.error, "a stuck job must say what it is stuck on");
  assert.match(stuck.error!, /^Waiting for you to approve: push/,
    "written for him, not for a log");
  assert.match(stuck.error!, /vikas53953\/cloud9/, "and it names the real repository");
  assert.deepEqual(statuses(frames).slice(0, 2), ["working", "blocked"],
    "it was working, and then it stopped being able to");
  // the card is REALLY unanswered while it says so
  assert.ok(!updates(frames).some(u => u.status === "completed" || u.status === "failed"),
    "nothing has finished — it is waiting on a person");
});

test("the reason carries no folder, no command line and no environment value", async t => {
  const { frames, feed, repoDir } = await rig(t, {
    reply: "Fixed the build.\n!publish", writes: { "fix.txt": "patched\n" },
  });
  feed({ type: "task", task: job("!code fix the build") });
  const { stuck } = await untilStuck(frames);
  const said = stuck.error ?? "";

  assert.ok(!said.includes(repoDir), "the repository folder is never on his screen");
  assert.ok(!said.includes(os.tmpdir()), "nor the worktree it was working in");
  assert.ok(!said.includes(os.homedir()), "nor his home folder");
  assert.ok(!/[A-Za-z]:\\/.test(said) && !said.includes("\\"), "no Windows path, ever");
  assert.ok(!/(^|\s)-{1,2}[a-z]/.test(said), "no argument list — this is a sentence");
  assert.ok(!/PATH=|APPDATA|process\.env/i.test(said), "no environment value");
});

// ================================================================ it always clears

test("saying yes puts the job back to working, and it finishes", async t => {
  const { frames, feed } = await rig(t, {
    reply: "Fixed the build.\n!publish", writes: { "fix.txt": "patched\n" },
  });
  feed({ type: "task", task: job("!code fix the build") });
  const { askId } = await untilStuck(frames);

  decide(feed, askId, "approved");
  const back = await waitFor(
    () => updates(frames).find(u => u.status === "working" && u.error === ""),
    "the job to be working again");
  assert.equal(back.error, "", "and the reason it was stuck is cleared, not left like a failure");

  // the pull request is a SECOND question, so the job is stuck a second time —
  // and says so about the pull request, not about the push
  const prAsk = await waitFor(
    () => (frames.filter(f => f.type === "askApproval") as Extract<ClientFrame, { type: "askApproval" }>[])
      .find(a => a.facts.action === "pullRequest"), "the pull request card");
  const second = await waitFor(
    () => updates(frames).filter(u => u.status === "blocked")[1], "the job to be stuck again");
  assert.match(second.error ?? "", /^Waiting for you to approve: open a pull request/);
  decide(feed, prAsk.askId, "approved");

  const done = await waitFor(() => updates(frames).find(u => u.status === "completed"),
    "the job to finish");
  assert.match(done.result ?? "", /pull request/i, "it really published");
  assert.deepEqual(statuses(frames),
    ["working", "blocked", "working", "blocked", "working", "completed"]);
});

test("saying no does not leave the job stuck — it finishes, saying nothing left the computer", async t => {
  const { frames, feed } = await rig(t, {
    reply: "Fixed the build.\n!publish", writes: { "fix.txt": "patched\n" },
  });
  feed({ type: "task", task: job("!code fix the build") });
  const { askId } = await untilStuck(frames);

  decide(feed, askId, "rejected");
  const done = await waitFor(() => updates(frames).find(
    u => u.status === "completed" || u.status === "failed"), "the job to reach an end");
  assert.equal(done.status, "completed", "his own no is not the app breaking");
  assert.match(done.result ?? "", /said no/i, "and the job says so");
  assert.match(done.result ?? "", /committed/i, "the work that WAS done is still named");
  assert.deepEqual(statuses(frames), ["working", "blocked", "working", "completed"]);
  assert.ok(!updates(frames).slice(-1)[0].error, "a refusal is not an error on the job");
});

test("nobody has answered yet, so the job is STILL STUCK — it never un-sticks itself", async t => {
  // THE OTHER HALF OF THE SAME REMOVAL (2026-08-07). This test used to prove
  // that a card nobody answered died on its own and the job carried on with
  // "nobody answered". That was the app throwing his question away while he was
  // thinking about it. Now the job stands there, visibly stuck ON HIM, until he
  // answers or presses Stop — and nothing has been pushed in the meantime.
  const { frames, feed } = await rig(t, {
    reply: "Fixed the build.\n!publish", writes: { "fix.txt": "patched\n" },
  });
  feed({ type: "task", task: job("!code fix the build") });
  const { askId } = await untilStuck(frames);

  await new Promise(r => setTimeout(r, 500));
  assert.deepEqual(statuses(frames), ["working", "blocked"],
    "the job moved on without him — his question was answered by a clock");
  assert.ok(!updates(frames).some(u => u.status === "completed" || u.status === "failed"),
    "nothing finished: it is waiting on a person and it says so");

  // AND NOW LET IT GO, INSIDE THE TEST. Leaving the wait for `t.after` to
  // release means this job's REAL git work runs on into the next test and the
  // two fight over the machine — which is exactly why this file started failing
  // a different test on every run. Nothing cleans up after a test any more, so
  // a test that parks a wait ends it itself and waits for the work to stop.
  decide(feed, askId, "rejected");
  await waitFor(() => updates(frames).find(u => u.status === "completed"),
    "the job to finish after he finally answered");
});

// ====================================== a real failure is never dressed up as stuck

test("a job that fell over is FAILED, and was never called stuck", async t => {
  const { frames, feed } = await rig(t, { reply: "", fail: true });
  feed({ type: "task", task: job("fix the build") });

  const done = await waitFor(() => updates(frames).find(u => u.status === "failed"),
    "the job to fail");
  assert.ok(done.error, "and it says why");
  assert.ok(!statuses(frames).includes("blocked"),
    "nothing is waiting on a person — the job is dead, not stuck");
});

test("a repository job that fell over is FAILED, not stuck", async t => {
  const { frames, feed } = await rig(t, { reply: "", fail: true });
  feed({ type: "task", task: job("!code fix the build") });

  await waitFor(() => updates(frames).find(u => u.status === "failed"), "the job to fail");
  assert.ok(!statuses(frames).includes("blocked"));
});

test("a job that never had to ask anybody anything never says it is stuck", async t => {
  const { frames, feed } = await rig(t, {
    // it changed a file and did NOT ask to publish: nothing leaves, nobody is asked
    reply: "Fixed the build. Keeping it local.", writes: { "fix.txt": "patched\n" },
  });
  feed({ type: "task", task: job("!code fix the build") });

  const done = await waitFor(() => updates(frames).find(u => u.status === "completed"),
    "the job to finish");
  assert.match(done.result ?? "", /nothing has left this machine/i);
  assert.deepEqual(statuses(frames), ["working", "completed"]);
});

// ============================================ the desk reports waits, and only waits

/** A desk with the wire replaced by a list and the two reports written down. */
function desk(maxWaiting = 20) {
  const sent: ClientFrame[] = [];
  const started: ID[] = [];
  const ended: { taskId: ID; approved: boolean }[] = [];
  const d = new ApprovalDesk({
    send: f => sent.push(f), maxWaiting, log: () => { /* quiet */ },
    onWaitStart: w => { started.push(w.taskId); },
    onWaitEnd: e => { ended.push({ taskId: e.taskId, approved: e.outcome.approved }); },
  });
  return { d, sent, started, ended };
}

test("an ask that never waits never reports a job as stuck", async t => {
  void t;
  // no room at the desk: the ask is refused on the spot, so nothing ever waits
  const { d, started, ended } = desk(0);
  const out = await d.ask({
    agent: AGENT, channelId: "c1", taskId: "t1",
    facts: { action: "push", repo: "vikas53953/cloud9", branch: "cloud9/a1-x", commits: 1 },
  });
  assert.equal(out.approved, false);
  assert.deepEqual(started, [], "nothing was ever waiting, so nothing was ever stuck");
  assert.deepEqual(ended, []);
});

test("the hub going away ends every wait, so no job can be left stuck for ever", async t => {
  void t;
  const { d, started, ended } = desk();
  const answer = d.ask({
    agent: AGENT, channelId: "c1", taskId: "t1",
    facts: { action: "push", repo: "vikas53953/cloud9", branch: "cloud9/a1-x", commits: 1 },
  });
  assert.deepEqual(started, ["t1"]);
  d.giveUpAll("the hub went away before anyone answered, so it did not happen");
  const out = await answer;
  assert.equal(out.approved, false);
  assert.deepEqual(ended, [{ taskId: "t1", approved: false }], "the wait is over, and it is a no");
});

test("a wait with no job behind it reports nothing — there is nothing to un-stick", async t => {
  void t;
  const { d, sent, started, ended } = desk();
  const answer = d.ask({
    agent: AGENT, channelId: "c1",
    facts: { action: "push", repo: "vikas53953/cloud9", branch: "cloud9/a1-x", commits: 1 },
  });
  const ask = sent.find(f => f.type === "askApproval");
  assert.ok(ask && ask.type === "askApproval");
  d.onAsked(ask.askId, "ap1");
  d.onApproval({
    id: "ap1", agentId: "a1", ownerId: "u1", action: "push", status: "approved",
    kind: "action", createdAt: 0,
  } as Approval);
  await answer;
  assert.deepEqual(started, []);
  assert.deepEqual(ended, []);
});
