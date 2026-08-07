// THE GITHUB WRITES ON THE SAME APPROVAL CARD.
//
// The five GitHub writes an agent can ask to make — open an issue, comment,
// request a review, check out a pull request branch, resolve a review thread —
// are NOT a second approval system. They ride the exact `askApproval` frame the
// push already uses, are minted as the exact same `action`-kind `Approval`, and
// are answered by the exact same `decideApproval`. This file proves the hub
// writes the right owner-words for them, counts their facts, and refuses a
// malformed one — reusing the midrun harness for exactly that reason.
import test from "node:test";
import assert from "node:assert/strict";
import { Approval, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "🛠️", persona: "You write code",
  abilities: { webSearch: false, files: true, schedules: false, background: true, commands: true },
};

async function stand(name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const hello = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  return { relay, owner, engine, channel: hello.state.channels[0]! };
}

async function makeAgent(client: TestClient, name: string) {
  client.send({ type: "createAgent", agent: { ...BASE_AGENT, name } });
  const frame = await client.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === name);
  return frame.agent;
}

function waitApproval(c: TestClient, pred: (a: Approval) => boolean) {
  return c.wait<Extract<ServerFrame, { type: "approval" }>>(
    f => f.type === "approval" && pred(f.approval));
}

test("the hub writes owner-words and counts for each GitHub write kind", async () => {
  const { relay, owner, engine, channel } = await stand("ghwrite.db");
  const agent = await makeAgent(owner, "Architect");

  const cases: Array<{ askId: string; facts: unknown; action: string; remoteAction: string; detail?: RegExp }> = [
    {
      askId: "gw-issue",
      facts: { action: "openIssue", repo: "vikas53953/cloud9", issues: 1 },
      action: "open an issue in vikas53953/cloud9", remoteAction: "openIssue",
      detail: /1 issue/,
    },
    {
      askId: "gw-review",
      facts: { action: "requestReview", repo: "vikas53953/cloud9", target: "pullRequest", number: 31, pullRequests: 1, reviewers: 3 },
      action: "request 3 reviewers for pull request #31 in vikas53953/cloud9", remoteAction: "requestReview",
      detail: /3 reviewers/,
    },
    {
      askId: "gw-comment",
      facts: { action: "comment", repo: "vikas53953/cloud9", target: "pullRequest", number: 12, pullRequests: 1, comments: 1 },
      action: "comment on pull request #12 in vikas53953/cloud9", remoteAction: "comment",
      detail: /1 comment/,
    },
    {
      askId: "gw-checkout",
      facts: { action: "checkoutPullRequest", repo: "vikas53953/cloud9", target: "pullRequest", number: 12, pullRequests: 1, branches: 1 },
      action: "check out or update the branch for pull request #12 in vikas53953/cloud9", remoteAction: "checkoutPullRequest",
      detail: /1 branch/,
    },
    {
      askId: "gw-thread",
      facts: { action: "resolveReviewThread", reviewThreads: 1 },
      action: "resolve a review thread", remoteAction: "resolveReviewThread",
      detail: /1 review thread/,
    },
  ];

  for (const c of cases) {
    engine.send({ type: "askApproval", askId: c.askId, agentId: agent.id, channelId: channel.id, facts: c.facts as never });
    const receipt = await engine.wait<Extract<ServerFrame, { type: "approvalAsked" }>>(
      f => f.type === "approvalAsked" && f.askId === c.askId);
    const card = await waitApproval(owner, a => a.id === receipt.approvalId);
    assert.equal(card.approval.kind, "action", c.askId);
    assert.equal(card.approval.remoteAction, c.remoteAction, c.askId);
    assert.equal(card.approval.action, c.action, c.askId);
    assert.equal(card.approval.status, "pending", c.askId);
    assert.equal(card.approval.expiresAt, undefined, `${c.askId} has no expiry clock`);
    if (c.detail) assert.match(card.approval.detail ?? "", c.detail, c.askId);
  }
  owner.close(); engine.close(); await relay.close();
});

test("a GitHub write with a non-positive count is refused, not guessed at", async () => {
  const { relay, owner, engine, channel } = await stand("ghwrite-bad.db");
  const agent = await makeAgent(owner, "Architect");
  for (const facts of [
    { action: "requestReview", repo: "vikas53953/cloud9", number: 31, reviewers: 0 },   // zero reviewers
    { action: "comment", repo: "vikas53953/cloud9", number: -1, comments: 1 },            // negative number
    { action: "openIssue", repo: "vikas53953/cloud9", issues: 1, target: "banana" },      // bad target
  ]) {
    engine.send({ type: "askApproval", askId: "bad", agentId: agent.id, channelId: channel.id, facts: facts as never });
    await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  }
  assert.equal(relay.store.approvals().length, 0, "not one bad card was minted");
  owner.close(); engine.close(); await relay.close();
});

test("a desktop client cannot mint a GitHub-write approval — only the engine", async () => {
  const { relay, owner, channel } = await stand("ghwrite-client.db");
  const agent = await makeAgent(owner, "Architect");
  // the OWNER's desktop socket (not an engine) tries to ask
  owner.send({
    type: "askApproval", askId: "sneaky", agentId: agent.id, channelId: channel.id,
    facts: { action: "openIssue", repo: "vikas53953/cloud9", issues: 1 } as never,
  });
  await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.equal(relay.store.approvals().length, 0, "a client-minted write card is impossible");
  owner.close(); await relay.close();
});
