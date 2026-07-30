// ASKING HIM MID-RUN, AND SURVIVING THE WAIT.
//
// Every test here failed before this round, because `ApprovalDesk` did not
// exist: `github.ts` refused everything with "nobody is set up to approve it"
// and the worktree flow ended at "committed locally".
//
// The three properties under test are the three that make the feature safe:
// the wait does not block or spin, silence is never a yes, and it is the same
// approval entity the hub already had.
import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentDef, Approval, ClientFrame, ID, REMOTE_ACTIONS, RemoteAction,
} from "@cloud9/shared";
import { ApprovalDesk } from "./approvaldesk.js";
import { ApprovalRequiredError, GitHubClient } from "./github.js";
import { RunOptions, RunResult } from "./run.js";

const quiet = () => { /* tests do not narrate */ };

function agent(over: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "a1", ownerId: "u1", name: "Architect", emoji: "🛠️",
    persona: "you write code",
    abilities: {
      webSearch: false, files: true, schedules: false, background: true, commands: true,
    },
    createdAt: 1,
    ...over,
  } as AgentDef;
}

/** A desk with the wire replaced by a list, so what it SAYS can be read. */
function desk(waitMs = 50) {
  const sent: ClientFrame[] = [];
  const d = new ApprovalDesk({ send: f => sent.push(f), waitMs, log: quiet });
  return { d, sent };
}

function card(over: Partial<Approval> = {}): Approval {
  return {
    id: "ap1", agentId: "a1", ownerId: "u1",
    action: "push 3 commits to a new branch cloud9/a1-x on vikas53953/cloud9",
    status: "pending", createdAt: 1, kind: "action", remoteAction: "push",
    ...over,
  };
}

/** Let the hub's receipt land, the way it really does — a tick later. */
function receipt(d: ApprovalDesk, sent: ClientFrame[], approvalId: ID = "ap1"): void {
  const ask = sent.find(f => f.type === "askApproval");
  assert.ok(ask && ask.type === "askApproval");
  d.onAsked(ask.askId, approvalId);
}

// ------------------------------------------------------------- the round trip

test("an agent asks, he says yes, and the agent carries on", async () => {
  const { d, sent } = desk(5_000);
  const answer = d.ask({
    agent: agent(), channelId: "ch1",
    facts: { action: "push", repo: "vikas53953/cloud9", branch: "cloud9/a1-x", commits: 3 },
  });
  const ask = sent[0];
  assert.ok(ask && ask.type === "askApproval");
  assert.equal(ask.agentId, "a1");
  assert.equal(ask.channelId, "ch1");
  // FACTS, not a sentence — the hub writes the words he reads
  assert.deepEqual(ask.facts, {
    action: "push", repo: "vikas53953/cloud9", branch: "cloud9/a1-x", commits: 3,
  });
  assert.equal(d.pending, 1, "it is WAITING, not blocking");

  receipt(d, sent);
  d.onApproval(card({ status: "approved", decidedBy: "u1", decidedAt: 2 }));
  const out = await answer;
  assert.equal(out.approved, true);
  assert.equal(out.approvalId, "ap1");
  assert.equal(d.pending, 0);
});

test("a no is a no, and it says which kind of no it was", async () => {
  for (const [status, words] of [
    ["rejected", /said no/],
    ["expired", /nobody answered/],
  ] as const) {
    const { d, sent } = desk(5_000);
    const answer = d.ask({
      agent: agent(), channelId: "ch1",
      facts: { action: "pullRequest", branch: "cloud9/a1-x", base: "master" },
    });
    receipt(d, sent);
    d.onApproval(card({ status }));
    const out = await answer;
    assert.equal(out.approved, false, status);
    assert.match(out.reason, words);
  }
});

// -------------------------------------------------------- silence is never yes

test("nobody answers, so it times out and says so — it never proceeds on silence", async () => {
  const { d } = desk(30);
  const out = await d.ask({
    agent: agent(), channelId: "ch1",
    facts: { action: "push", branch: "cloud9/a1-x", commits: 1 },
  });
  assert.equal(out.approved, false);
  assert.match(out.reason, /nobody answered/);
  assert.equal(d.pending, 0, "the waiter was cleaned up, not left behind");
});

test("the hub going away is a no for everyone still waiting", async () => {
  const { d } = desk(60_000);
  const a = d.ask({ agent: agent(), channelId: "ch1", facts: { action: "push", branch: "b1" } });
  const b = d.ask({ agent: agent({ id: "a2" }), channelId: "ch1", facts: { action: "push", branch: "b2" } });
  assert.equal(d.pending, 2);
  d.giveUpAll("the hub went away before anyone answered, so it did not happen");
  for (const out of await Promise.all([a, b])) {
    assert.equal(out.approved, false);
    assert.match(out.reason, /hub went away/);
  }
  assert.equal(d.pending, 0);
});

test("a decision for a card nobody here is waiting on changes nothing", async () => {
  // A card the owner decided on his phone for a DIFFERENT agent must not
  // release this one. Verified failing with the `approvalId` match removed:
  // the first waiter in the list is freed by somebody else's yes.
  const { d, sent } = desk(40);
  const answer = d.ask({ agent: agent(), channelId: "ch1", facts: { action: "push", branch: "b1" } });
  receipt(d, sent, "ap-mine");
  d.onApproval(card({ id: "ap-somebody-elses", status: "approved" }));
  const out = await answer;
  assert.equal(out.approved, false, "it timed out instead — it did not borrow the other yes");
  assert.match(out.reason, /nobody answered/);
});

test("a card that is still pending is not an answer", async () => {
  const { d, sent } = desk(40);
  const answer = d.ask({ agent: agent(), channelId: "ch1", facts: { action: "push", branch: "b1" } });
  receipt(d, sent);
  d.onApproval(card({ status: "pending" }));
  assert.equal(d.pending, 1);
  const out = await answer;
  assert.equal(out.approved, false);
});

// ------------------------------------------------- it does not block or spin

test("several agents wait at once and the engine keeps going", async () => {
  const { d, sent } = desk(5_000);
  const answers = ["a1", "a2", "a3"].map((id, i) => d.ask({
    agent: agent({ id }), channelId: "ch1",
    facts: { action: "push", branch: `cloud9/${id}-x`, commits: i + 1 },
  }));
  assert.equal(d.pending, 3);
  // the engine is not held up: ordinary work runs to completion while they wait
  let ticks = 0;
  for (let i = 0; i < 1000; i++) { await Promise.resolve(); ticks++; }
  assert.equal(ticks, 1000);
  assert.equal(sent.filter(f => f.type === "askApproval").length, 3);

  // and each one is released by ITS OWN card, in whatever order they come back
  const asks = sent.filter(f => f.type === "askApproval") as Extract<ClientFrame, { type: "askApproval" }>[];
  asks.forEach((f, i) => d.onAsked(f.askId, `ap${i}`));
  d.onApproval(card({ id: "ap2", agentId: "a3", status: "approved" }));
  d.onApproval(card({ id: "ap0", agentId: "a1", status: "rejected" }));
  d.onApproval(card({ id: "ap1", agentId: "a2", status: "approved" }));
  const out = await Promise.all(answers);
  assert.deepEqual(out.map(o => o.approved), [false, true, true]);
});

test("the desk has a leash — it cannot fill up with waiters for ever", async () => {
  const sent: ClientFrame[] = [];
  const d = new ApprovalDesk({ send: f => sent.push(f), waitMs: 60_000, maxWaiting: 2, log: quiet });
  void d.ask({ agent: agent(), channelId: "ch1", facts: { action: "push", branch: "b1" } });
  void d.ask({ agent: agent(), channelId: "ch1", facts: { action: "push", branch: "b2" } });
  const third = await d.ask({ agent: agent(), channelId: "ch1", facts: { action: "push", branch: "b3" } });
  assert.equal(third.approved, false);
  assert.match(third.reason, /already waiting/);
  assert.equal(sent.filter(f => f.type === "askApproval").length, 2, "the third never reached the wire");
  d.giveUpAll("test over");
});

// --------------------------------------------- the gate and the desk together

test("the GitHub gate, wired to the desk, really is answerable now", async () => {
  // THE WHOLE POINT OF THE ROUND, in one test: the same client that refused
  // everything with "nobody is set up to approve it" now pushes, because there
  // is somebody to ask and they said yes.
  const calls: { cmd: string; args: string[] }[] = [];
  const runner = ((cmd: string, args: string[], _o: RunOptions = {}): Promise<RunResult> => {
    calls.push({ cmd, args });
    const stdout = cmd === "gh" && args[0] === "repo" ? "vikas53953/cloud9\n"
      : cmd === "git" && args[0] === "rev-list" ? "3\n" : "";
    return Promise.resolve({ code: 0, stdout, stderr: "", timedOut: false, notFound: false });
  }) as never;

  const { d, sent } = desk(5_000);
  const wt = {
    repoDir: "/repo", path: "/work/x", branch: "cloud9/a1-x", base: "master", agentId: "a1",
  };

  const gh = new GitHubClient({
    runner, log: quiet,
    approve: async (_a, _detail, facts) => (await d.ask({
      agent: agent(), channelId: "ch1", facts,
    })).approved,
  });

  const pushed = gh.pushBranch(wt);
  // the request reached the wire with the real repository name and commit count
  await new Promise(r => setTimeout(r, 20));
  const ask = sent.find(f => f.type === "askApproval");
  assert.ok(ask && ask.type === "askApproval");
  assert.deepEqual(ask.facts, {
    action: "push", branch: "cloud9/a1-x", base: "master",
    repo: "vikas53953/cloud9", commits: 3,
  });
  assert.equal(calls.some(c => c.args[0] === "push"), false, "nothing has been pushed YET");

  receipt(d, sent);
  d.onApproval(card({ status: "approved" }));
  await pushed;
  assert.deepEqual(calls.at(-1), { cmd: "git", args: ["push", "-u", "origin", "cloud9/a1-x"] });

  // and the same client with a NO still refuses, loudly
  const { d: d2, sent: s2 } = desk(5_000);
  const gh2 = new GitHubClient({
    runner, log: quiet,
    approve: async (_a, _detail, facts) => (await d2.ask({
      agent: agent(), channelId: "ch1", facts,
    })).approved,
  });
  const refused = assert.rejects(() => gh2.pushBranch(wt), (e: unknown) => e instanceof ApprovalRequiredError);
  await new Promise(r => setTimeout(r, 20));
  receipt(d2, s2);
  d2.onApproval(card({ status: "rejected" }));
  await refused;
});

test("every row of the remote-actions table can be asked about", () => {
  // CLASS, NOT CASE — walking the table means a fourth row is covered the day
  // it is added.
  for (const action of Object.keys(REMOTE_ACTIONS) as RemoteAction[]) {
    const { d, sent } = desk(60_000);
    void d.ask({ agent: agent(), channelId: "ch1", facts: { action } });
    const ask = sent[0];
    assert.ok(ask && ask.type === "askApproval" && ask.facts.action === action);
    d.giveUpAll("test over");
  }
});

test("the waiting time is said in words that are true at any length", async () => {
  // Caught by the REAL end-to-end run: a 20-second leash produced "nobody
  // answered in 0 minutes", which reads like a bug in the one sentence whose
  // job is to be believed.
  for (const [waitMs, words] of [[20, /1 second/], [30_000, /30 seconds/]] as const) {
    const { d } = desk(waitMs);
    const out = await d.ask({
      agent: agent(), channelId: "ch1", facts: { action: "push", branch: "b1" },
    });
    assert.equal(out.approved, false);
    assert.match(out.reason, words);
    assert.doesNotMatch(out.reason, /\b0 (seconds|minutes)\b/);
  }
});
