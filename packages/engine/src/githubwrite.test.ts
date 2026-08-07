// PERFORMING a GitHub write, and the one promise that matters most: on every
// path that is not a literal yes, the command NEVER RAN.
//
// The runner here is a spy that records every call. A no-path that let it be
// called even once would fail loudly — which is exactly the regression these
// tests exist to catch, because "a denied approval runs nothing" is the whole
// safety story of this feature.
import test from "node:test";
import assert from "node:assert/strict";
import {
  RemoteActionFacts, describeRemoteAction, detailRemoteAction, validateRemoteActionFacts,
  isGitHubWriteKind,
} from "@cloud9/shared";
import { ApprovalDesk } from "./approvaldesk.js";
import {
  runGitHubWrite, runGitHubRead, writeFactsFor, buildGitHubWrite, parseRead,
  GitHubWriteRequest,
} from "./githubwrite.js";
import { RunOptions, RunResult } from "./run.js";

const quiet = () => { /* tests do not narrate */ };

interface Call { cmd: string; args: string[]; opts: RunOptions }

/** A runner that records what it was asked to run — and, crucially, IF it was. */
function spyRunner(reply: (call: Call) => Partial<RunResult> = () => ({})) {
  const calls: Call[] = [];
  const runner = (cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    calls.push({ cmd, args, opts });
    return Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false, ...reply({ cmd, args, opts }) });
  };
  return { calls, runner: runner as never };
}

const agent = {
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🛰", persona: "", createdAt: 0,
  abilities: { webSearch: false, files: false, schedules: false, background: false },
} as never;

const issueReq: GitHubWriteRequest = { kind: "openIssue", repo: "vikas53953/cloud9", title: "Crash on start", body: "steps: x && y" };

// ---------------------------------------------------------------- the facts

test("counted facts carry no prose, and the sentence comes from them", () => {
  const facts = writeFactsFor(issueReq);
  assert.equal(facts.action, "openIssue");
  assert.equal(facts.repo, "vikas53953/cloud9");
  assert.equal(facts.issues, 1);
  // the title and body are NOWHERE in the facts
  assert.ok(!JSON.stringify(facts).includes("Crash"));
  assert.ok(!JSON.stringify(facts).includes("x && y"));
  assert.match(describeRemoteAction(facts), /open an issue in vikas53953\/cloud9/);
  assert.equal(validateRemoteActionFacts(facts), null);
  assert.ok(isGitHubWriteKind(facts.action));
});

test("request-review facts count reviewers and read as a card sentence", () => {
  const facts = writeFactsFor({
    kind: "requestReview", repo: "vikas53953/cloud9", pullRequest: 31,
    reviewers: ["alice", "bob"], teamReviewers: ["platform"],
  });
  assert.equal(facts.reviewers, 3);
  assert.equal(facts.number, 31);
  assert.equal(facts.pullRequests, 1);
  assert.match(describeRemoteAction(facts), /request 3 reviewers for pull request #31 in vikas53953\/cloud9/);
  assert.match(detailRemoteAction(facts) ?? "", /1 pull request/);
  assert.match(detailRemoteAction(facts) ?? "", /3 reviewers/);
});

// ------------------------------------------------ the yes path runs it exactly

test("a YES runs the builder's tool, argv and stdin VERBATIM — never a rebuild", async () => {
  const { calls, runner } = spyRunner(() => ({ stdout: "{}" }));
  const outcome = await runGitHubWrite({
    request: issueReq, run: runner,
    ask: async () => ({ approved: true, reason: "approved" }),
  });
  assert.equal(outcome.ran, true);
  assert.equal(outcome.approved, true);
  assert.equal(calls.length, 1);
  const op = buildGitHubWrite(issueReq);
  assert.equal(calls[0].cmd, "gh");
  assert.deepEqual(calls[0].args, op.argv);
  assert.equal(calls[0].opts.stdin, op.stdin);
  // the prose is on stdin, never in argv
  assert.ok(!calls[0].args.some(a => /Crash|&&/.test(a)));
  assert.ok((calls[0].opts.stdin ?? "").includes("Crash on start"));
});

// -------------------------------------------- the no-paths run NOTHING

test("a NO runs nothing, and says which no it was", async () => {
  const { calls, runner } = spyRunner();
  const outcome = await runGitHubWrite({
    request: issueReq, run: runner,
    ask: async () => ({ approved: false, reason: "the owner said no, so it did not happen" }),
  });
  assert.equal(outcome.ran, false);
  assert.equal(outcome.approved, false);
  assert.match(outcome.reason, /the owner said no/);
  assert.equal(calls.length, 0, "a denied write must never reach the runner");
});

test("a request the builder refuses (malformed) runs nothing and does not lie", async () => {
  const { calls, runner } = spyRunner();
  // pullRequest 0 is not a positive integer — buildRequestReview throws
  await assert.rejects(runGitHubWrite({
    request: { kind: "requestReview", repo: "vikas53953/cloud9", pullRequest: 0, reviewers: ["alice"] },
    run: runner,
    ask: async () => ({ approved: true, reason: "approved" }),
  }));
  assert.equal(calls.length, 0, "a malformed write must never reach the runner");
});

// ----- the SAME no-paths, driven through the real ApprovalDesk (yes / no / disconnect)

/** Wire a real ApprovalDesk to the executor and hand back the levers the hub pulls. */
function withDesk() {
  let asked: { askId: string } | undefined;
  const desk = new ApprovalDesk({
    send: frame => { if (frame.type === "askApproval") asked = { askId: frame.askId }; },
    log: quiet,
  });
  const ask = async (facts: RemoteActionFacts) => {
    const o = await desk.ask({ agent, channelId: "c1", facts });
    return { approved: o.approved, reason: o.reason };
  };
  return { desk, ask, approvalId: () => { desk.onAsked(asked!.askId, "ap-1"); return "ap-1"; } };
}

test("desk YES: the executor runs exactly once", async () => {
  const { calls, runner } = spyRunner(() => ({ stdout: "{}" }));
  const { desk, ask, approvalId } = withDesk();
  const p = runGitHubWrite({ request: issueReq, run: runner, ask });
  await tick();
  const id = approvalId();
  desk.onApproval({ id, agentId: "a1", ownerId: "u1", action: "x", status: "approved", createdAt: 0 });
  const outcome = await p;
  assert.equal(outcome.ran, true);
  assert.equal(calls.length, 1);
});

test("desk NO: the executor runs NOTHING", async () => {
  const { calls, runner } = spyRunner();
  const { desk, ask, approvalId } = withDesk();
  const p = runGitHubWrite({ request: issueReq, run: runner, ask });
  await tick();
  const id = approvalId();
  desk.onApproval({ id, agentId: "a1", ownerId: "u1", action: "x", status: "rejected", createdAt: 0 });
  const outcome = await p;
  assert.equal(outcome.ran, false);
  assert.match(outcome.reason, /said no/);
  assert.equal(calls.length, 0);
});

test("desk DISCONNECT: the hub went away, the executor runs NOTHING", async () => {
  const { calls, runner } = spyRunner();
  const { desk, ask } = withDesk();
  const p = runGitHubWrite({ request: issueReq, run: runner, ask });
  await tick();
  desk.giveUpAll("the connection to Cloud9 dropped, so it did not happen");
  const outcome = await p;
  assert.equal(outcome.ran, false);
  assert.match(outcome.reason, /dropped/);
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------ reads: parse + cap

test("a read never asks, and raw gh JSON becomes a capped, validated view", async () => {
  const rows = JSON.stringify([[
    { id: 1, user: { login: "alice" }, path: "a.ts", line: 3, side: "RIGHT", body: "fix this", html_url: "https://github.com/vikas53953/cloud9/pull/1#r1" },
    { id: 2, user: { login: "bob" }, body: "and this", html_url: "not-a-github-url" }, // dropped: bad url
  ]]);
  const { calls, runner } = spyRunner(() => ({ stdout: rows }));
  const { result, problem } = await runGitHubRead({
    request: { kind: "listReviewComments", repo: "vikas53953/cloud9", pullRequest: 1 }, run: runner,
  });
  assert.equal(problem, undefined);
  assert.equal(calls.length, 1);
  assert.equal(result?.kind, "reviewComments");
  if (result?.kind === "reviewComments") {
    assert.equal(result.comments.length, 1, "the bad-url row is dropped, not repaired");
    assert.equal(result.comments[0].author, "alice");
  }
});

test("CI status keeps GitHub's own buckets and drops unknown ones", () => {
  const { result } = parseRead(
    { kind: "readCiStatus", repo: "vikas53953/cloud9", pullRequest: 1 },
    JSON.stringify([
      { name: "build", workflow: "CI", state: "SUCCESS", bucket: "pass" },
      { name: "weird", state: "?", bucket: "made-up" }, // dropped
    ]),
  );
  assert.equal(result?.kind, "ciStatus");
  if (result?.kind === "ciStatus") {
    assert.equal(result.checks.length, 1);
    assert.equal(result.checks[0].bucket, "pass");
    assert.equal(result.checks[0].workflow, "CI");
  }
});

function tick(): Promise<void> { return new Promise(r => setTimeout(r, 5)); }
