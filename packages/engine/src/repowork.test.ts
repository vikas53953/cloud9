// AN AGENT DECIDING BY ITSELF THAT IT WANTS TO PUSH — driven the way the hub
// drives the engine, against REAL git.
//
// WHAT THESE TESTS ARE FOR. `Engine.githubFor` existed for a day with no caller
// in any agent turn, so the permission card only ever appeared when a test
// drove the engine directly and Vikas could never reach it. Every test below
// starts from a MESSAGE IN A ROOM — "@Scout !code …" — and goes all the way to
// the `askApproval` frame the hub would draw a card from, or proves that no
// such frame was ever sent.
//
// REAL GIT, FAKE GITHUB. The worktree, the branch, the commit and the counting
// are done by git itself in a throwaway repository, because the facts on the
// card have to be OBSERVED for any of this to mean anything. Only the two
// things that would leave this computer — `git push` and `gh pr create` — are
// stubbed, and each test asserts on whether they were reached at all.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentDef, Approval, ClientFrame, Message, RemoteActionFacts, ServerFrame, WorldState,
} from "@cloud9/shared";
import { Engine } from "./engine.js";
import { ClaudeProvider, RespondInput } from "./provider.js";
import { repoBriefing, wantsToPublish, withoutPublishMarker } from "./repowork.js";
import { run, RunOptions, RunResult } from "./run.js";

const tmp = (prefix: string): string => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

// ------------------------------------------------------------- the marker

test("an agent asks to publish in one unmistakable way, and only that way", () => {
  assert.equal(wantsToPublish("Done.\n!publish"), true);
  assert.equal(wantsToPublish("!PUBLISH\nDone."), true, "shouting it still counts");
  assert.equal(wantsToPublish("Done.\n  !publish  "), true, "indented still counts");
  assert.equal(wantsToPublish("- !publish"), true, "a bullet is still a line of its own");
  assert.equal(wantsToPublish("I could !publish this later if you want"), false,
    "talking about it is not asking for it");
  assert.equal(wantsToPublish("nothing here"), false);
  assert.equal(wantsToPublish(""), false);
});

test("asking twice in a row is asking twice — no leftover state between calls", () => {
  // this project lost a night to a module-level /g regex whose lastIndex
  // survived between calls. Same shape, so the same check.
  for (let i = 0; i < 5; i++) {
    assert.equal(wantsToPublish("work done\n!publish"), true, `call ${i}`);
    assert.equal(withoutPublishMarker("work done\n!publish"), "work done", `call ${i}`);
  }
});

test("the instruction to Cloud9 is not something the room has to read", () => {
  assert.equal(withoutPublishMarker("Fixed the build.\n\n!publish"), "Fixed the build.");
  assert.equal(withoutPublishMarker("!publish"), "");
  assert.equal(withoutPublishMarker("kept it local"), "kept it local");
});

test("the agent is told it cannot push by itself, and where it is standing", () => {
  const said = repoBriefing({ branch: "cloud9/scout-1", base: "master", repo: "vikas53953/cloud9" });
  assert.match(said, /cloud9\/scout-1/);
  assert.match(said, /master/);
  assert.match(said, /vikas53953\/cloud9/);
  assert.match(said, /CANNOT PUSH ANYTHING YOURSELF/i);
  assert.match(said, /!publish/);
});

// ------------------------------------------------------- the world it runs in

const AGENT: AgentDef = {
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You write code",
  abilities: { webSearch: false, files: true, schedules: false, background: true },
  approvals: { background: false, schedules: false },
  createdAt: 0,
};

const SECOND: AgentDef = { ...AGENT, id: "a2", name: "Mason" };

function world(agents: AgentDef[] = [AGENT]): WorldState {
  return {
    me: { id: "u1", name: "Vikas", createdAt: 0 } as WorldState["me"],
    users: [{ id: "u1", name: "Vikas", createdAt: 0 } as WorldState["users"][number]],
    agents,
    channels: [{
      id: "c1", name: "ops", kind: "channel",
      memberIds: ["u1", ...agents.map(a => a.id)], createdAt: 0,
    }],
    messages: [], agentStatus: {}, tasks: [], approvals: [],
  };
}

/** A real repository with one commit, thrown away with the temp folder. */
async function makeRepo(): Promise<string> {
  const repoDir = path.join(tmp("cloud9-repowork-"), "repo");
  fs.mkdirSync(repoDir, { recursive: true });
  await run("git", ["init", "-q", "-b", "master"], { cwd: repoDir });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
  await run("git", ["config", "user.name", "Cloud9Test"], { cwd: repoDir });
  fs.writeFileSync(path.join(repoDir, "README.md"), "hello\n");
  await run("git", ["add", "-A"], { cwd: repoDir });
  await run("git", ["commit", "-q", "-F", "-"], { cwd: repoDir, stdin: "base\n" });
  return repoDir;
}

/**
 * The harness, stubbed. It writes the files it says it wrote — because a turn
 * that only TALKS about changing code is exactly the case that must not produce
 * a permission card.
 */
class Worker implements ClaudeProvider {
  briefings: string[] = [];
  constructor(
    private reply: string,
    private writes: Record<string, string> = {},
  ) {}

  async respond(input: RespondInput): Promise<string> {
    this.briefings.push(input.trigger);
    for (const [name, text] of Object.entries(this.writes)) {
      assert.ok(input.workdir, "a repository turn must happen in its own worktree");
      fs.writeFileSync(path.join(input.workdir!, name), text);
    }
    return this.reply;
  }
}

/**
 * Everything that would leave this computer, refused into a record.
 *
 * `git push` and `gh pr create` are the only two calls stubbed. Everything else
 * — counting commits, reading the repository's name — is passed through to the
 * real tool so the numbers on the card are numbers something really counted.
 */
function fakeGitHub(): { runner: (c: string, a: string[], o?: RunOptions) => Promise<RunResult>; left: string[][] } {
  const left: string[][] = [];
  const runner = async (command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false, notFound: false });
    if (command === "git" && args[0] === "push") {
      left.push([command, ...args]);
      return ok("");
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      left.push([command, ...args]);
      return ok("https://github.com/vikas53953/cloud9/pull/7\n");
    }
    if (command === "gh" && args[0] === "repo" && args[1] === "view") {
      return ok("vikas53953/cloud9\n");
    }
    if (command === "gh") return ok("");
    // real git for everything that only reads
    return run(command, args, opts);
  };
  return { runner, left };
}

interface Rig {
  engine: Engine;
  frames: ClientFrame[];
  feed: (f: ServerFrame) => void;
  worker: Worker;
  left: string[][];
  repoDir: string;
}

async function rig(t: TestContext, input: {
  reply: string;
  writes?: Record<string, string>;
  agents?: AgentDef[];
  repoDir?: string;
  approvalWaitMs?: number;
}): Promise<Rig> {
  const repoDir = input.repoDir ?? await makeRepo();
  const worker = new Worker(input.reply, input.writes ?? {});
  const { runner, left } = fakeGitHub();
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp("cloud9-repowork-data-"),
    provider: worker,
    repoDir,
    github: { runner, log: () => { /* quiet */ } },
    ...(input.approvalWaitMs ? { approvalWaitMs: input.approvalWaitMs } : {}),
  });
  const frames: ClientFrame[] = [];
  (engine as unknown as { sendFrame: (f: ClientFrame) => void }).sendFrame = f => { frames.push(f); };
  const feed = (f: ServerFrame): void =>
    (engine as unknown as { onFrame: (f: ServerFrame) => void }).onFrame(f);
  feed({ type: "welcome", state: world(input.agents ?? [AGENT]) });
  t.after(() => { engine.stop(); });
  return { engine, frames, feed, worker, left, repoDir };
}

function says(agentId: string, text: string, id = "m1"): Message {
  return {
    id, channelId: "c1", authorId: "u1", authorName: "Vikas",
    authorKind: "human", text, ts: 1, mentions: [agentId],
  };
}

async function waitFor<T>(get: () => T | undefined, why: string, ms = 20000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() > until) throw new Error(`gave up waiting: ${why}`);
    await new Promise(r => setTimeout(r, 20));
  }
}

const asks = (frames: ClientFrame[]): Extract<ClientFrame, { type: "askApproval" }>[] =>
  frames.filter(f => f.type === "askApproval") as Extract<ClientFrame, { type: "askApproval" }>[];

const said = (frames: ClientFrame[]): string =>
  frames.filter(f => f.type === "agentSend")
    .map(f => (f as Extract<ClientFrame, { type: "agentSend" }>).text).join("\n---\n");

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

// --------------------------------------------------------------- the turns

test("an agent that changed nothing cannot ask to push, however it describes itself", async t => {
  const { frames, feed } = await rig(t, {
    // it claims a big risky change and asks to publish, and it wrote no files
    reply: "Rewrote the whole build system. Huge change.\n!publish",
  });
  feed({ type: "message", message: says("a1", "@Scout !code tidy the build") });

  await waitFor(() => said(frames).includes("did not change any files") || undefined,
    "the agent to report that it changed nothing");
  assert.equal(asks(frames).length, 0,
    "no work, no card — a card he cannot act on teaches him to ignore cards");
});

test("work with no ask stays on its own branch, on this computer", async t => {
  const { frames, feed, left, repoDir } = await rig(t, {
    reply: "Fixed the typo. I am not asking to publish this.",
    writes: { "notes.md": "one small change\n" },
  });
  feed({ type: "message", message: says("a1", "@Scout !code fix the typo") });

  const text = await waitFor(
    () => said(frames).includes("Committed") ? said(frames) : undefined,
    "the agent to report a local commit");
  assert.match(text, /own branch `cloud9\/a1-/);
  assert.match(text, /nothing has left this machine/i);
  assert.equal(asks(frames).length, 0, "it never asked, so nobody was interrupted");
  assert.equal(left.length, 0, "and nothing was pushed");

  // the commit is really there, on a branch of its own
  const branches = await run("git", ["branch"], { cwd: repoDir });
  assert.match(branches.stdout, /cloud9\/a1-/, "the branch exists in the real repository");
});

test("THE CARD'S FACTS ARE COUNTED BY GIT, NOT QUOTED FROM THE AGENT", async t => {
  const { frames, feed } = await rig(t, {
    // the agent describes risky work as harmless, and names a branch it is not on
    reply: "Only a one-line comment, nothing risky, straight onto main.\n!publish",
    writes: { "a.ts": "export const a = 1;\n", "b.ts": "export const b = 2;\n" },
  });
  feed({ type: "message", message: says("a1", "@Scout !code add two modules") });

  const ask = await waitFor(() => asks(frames)[0], "the agent to ask for permission");
  const facts: RemoteActionFacts = ask.facts;
  assert.equal(facts.action, "push");
  assert.equal(facts.repo, "vikas53953/cloud9", "the repository gh named, not one the agent typed");
  assert.match(facts.branch ?? "", /^cloud9\/a1-/, "the branch Cloud9 generated");
  assert.equal(facts.base, "master", "read from the repository — never assumed to be main");
  assert.equal(facts.commits, 1, "counted by git rev-list");
  assert.equal(facts.files, 2, "two files, whatever the agent called it");
  assert.equal(ask.agentId, "a1");
  assert.equal(ask.channelId, "c1", "the card belongs in the conversation it happened in");
});

test("APPROVED: the branch goes up and a pull request is opened, and only then", async t => {
  const { frames, feed, left } = await rig(t, {
    reply: "Added the module.\n!publish",
    writes: { "a.ts": "export const a = 1;\n" },
  });
  feed({ type: "message", message: says("a1", "@Scout !code add a module") });

  const ask = await waitFor(() => asks(frames)[0], "the push request");
  assert.equal(left.length, 0, "NOTHING has left this computer while the card is pending");
  decide(feed, ask.askId, "approved");

  // the pull request is a second question, and it is asked
  const prAsk = await waitFor(() => asks(frames).find(a => a.facts.action === "pullRequest"),
    "the pull request request");
  decide(feed, prAsk.askId, "approved");

  const text = await waitFor(
    () => said(frames).includes("pull request") ? said(frames) : undefined,
    "the agent to report the pull request");
  assert.match(text, /https:\/\/github\.com\/vikas53953\/cloud9\/pull\/7/);
  assert.match(text, /into `master`/, "branch → base, always");
  assert.equal(left.length, 2, "exactly two things left this computer: the push and the pull request");
  assert.deepEqual(left[0].slice(0, 4), ["git", "push", "-u", "origin"]);
  assert.equal(left[1][2], "create");
  assert.ok(!left[1].includes("master") || left[1].indexOf("--base") + 1 === left[1].indexOf("master"),
    "master is only ever named as the thing the pull request AIMS at");
});

test("REFUSED: he said no, and GitHub never hears about the branch", async t => {
  const { frames, feed, left } = await rig(t, {
    reply: "Added the module.\n!publish",
    writes: { "a.ts": "export const a = 1;\n" },
  });
  feed({ type: "message", message: says("a1", "@Scout !code add a module") });

  const ask = await waitFor(() => asks(frames)[0], "the push request");
  decide(feed, ask.askId, "rejected");

  const text = await waitFor(
    () => said(frames).includes("said no") ? said(frames) : undefined,
    "the agent to say he refused");
  assert.match(text, /the owner said no, so it did not happen/);
  assert.match(text, /committed on that branch on this computer/i,
    "the work is not thrown away, and he is told where it is");
  assert.equal(left.length, 0, "nothing left this computer");
  assert.equal(asks(frames).length, 1, "and it did not go on to ask for a pull request anyway");
});

test("SILENCE IS NOT REFUSAL, and it is not a yes either", async t => {
  const { frames, feed, left } = await rig(t, {
    reply: "Added the module.\n!publish",
    writes: { "a.ts": "export const a = 1;\n" },
    approvalWaitMs: 60,
  });
  feed({ type: "message", message: says("a1", "@Scout !code add a module") });

  const text = await waitFor(
    () => said(frames).includes("nobody answered") ? said(frames) : undefined,
    "the agent to say nobody answered");
  assert.match(text, /nobody answered in \d+ seconds?, so it did not happen/,
    "a different sentence from 'the owner said no' — they are different events");
  assert.doesNotMatch(text, /said no/);
  assert.equal(left.length, 0, "and, like a refusal, nothing left this computer");
});

test("TWO AGENTS work one repository at the same time, each on its own branch", async t => {
  const repoDir = await makeRepo();
  const one = await rig(t, {
    reply: "did my bit", writes: { "one.txt": "1\n" }, agents: [AGENT], repoDir,
  });
  const two = await rig(t, {
    reply: "did my bit", writes: { "two.txt": "2\n" }, agents: [SECOND], repoDir,
  });
  one.feed({ type: "message", message: says("a1", "@Scout !code do part one") });
  two.feed({ type: "message", message: says("a2", "@Mason !code do part two") });

  await waitFor(() => said(one.frames).includes("Committed") || undefined, "Scout to finish");
  await waitFor(() => said(two.frames).includes("Committed") || undefined, "Mason to finish");

  const branches = await run("git", ["branch"], { cwd: repoDir });
  assert.match(branches.stdout, /cloud9\/a1-/);
  assert.match(branches.stdout, /cloud9\/a2-/);
  assert.equal(asks(one.frames).length + asks(two.frames).length, 0, "neither asked");
});

test("with nowhere to work, the agent says so instead of inventing a folder", async t => {
  const worker = new Worker("should never run");
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp("cloud9-repowork-none-"),
    provider: worker,
  });
  const frames: ClientFrame[] = [];
  (engine as unknown as { sendFrame: (f: ClientFrame) => void }).sendFrame = f => { frames.push(f); };
  const feed = (f: ServerFrame): void =>
    (engine as unknown as { onFrame: (f: ServerFrame) => void }).onFrame(f);
  feed({ type: "welcome", state: world() });
  t.after(() => { engine.stop(); });

  feed({ type: "message", message: says("a1", "@Scout !code fix the build") });
  const text = await waitFor(() => said(frames) || undefined, "the agent to answer");
  assert.match(text, /Nobody has told Cloud9 where this project's code lives/);
  assert.equal(worker.briefings.length, 0, "and no turn was spent on it");
});

test("the turn really happens inside the worktree, and is told the rules", async t => {
  const { frames, feed, worker } = await rig(t, {
    reply: "looked around", writes: { "seen.txt": "here\n" },
  });
  feed({ type: "message", message: says("a1", "@Scout !code look around") });
  await waitFor(() => said(frames) || undefined, "the agent to answer");

  assert.equal(worker.briefings.length, 1);
  assert.match(worker.briefings[0], /^look around/, "what it was asked comes first");
  assert.match(worker.briefings[0], /!publish/, "and it is told how to ask");
  assert.match(worker.briefings[0], /vikas53953\/cloud9/, "and which repository it is standing in");
});
