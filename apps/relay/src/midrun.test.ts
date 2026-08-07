// ASKING MID-RUN: "may I push this branch?"
//
// Before this round the only approval that existed was JOB-SHAPED — decided
// before a background job started. An agent that had already worked, already
// committed, and had come to the one thing it may not do alone had no way to
// ask, so `packages/engine/src/github.ts` refused everything and the worktree
// flow stopped at "committed locally". His GitHub feature could not work.
//
// EVERY TEST IN THIS FILE FAILED BEFORE THE CHANGE: there was no `askApproval`
// frame, no `approvalAsked` receipt, no `action` kind, and no `expired` status.
// Where a test pins a GUARD rather than a feature, the comment says which line
// was removed to watch it go red.
//
// The theme: an approval request is a REPORT OF FACTS, not a permission and not
// a sentence. The engine says `{ action: "push", repo, branch, commits }`; the
// hub writes the words he reads and decides who may see them.
import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_LIMITS, Approval, REMOTE_ACTIONS, RemoteAction, ServerFrame,
  describeRemoteAction, mustAskBeforeActing,
} from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "🛠️", persona: "You write code",
  // the shape an agent doing real dev work has: it can run programs, so it is
  // already on the always-ask list
  abilities: {
    webSearch: false, files: true, schedules: false, background: true, commands: true,
  },
};

async function stand(name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const hello = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  return { relay, url, owner, engine, me: hello.state.me, channel: hello.state.channels[0]! };
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

// --------------------------------------------------- the round trip, end to end

test("an agent asks mid-run, the owner says yes, and the engine is told which card it was", async () => {
  const { relay, owner, engine, channel } = await stand("ask.db");
  const agent = await makeAgent(owner, "Architect");

  engine.send({
    type: "askApproval", askId: "ask-1", agentId: agent.id, channelId: channel.id,
    facts: {
      action: "push", repo: "vikas53953/cloud9",
      branch: "cloud9/architect-1", commits: 3, files: 2,
    },
  });

  // the receipt goes to the asking socket, so an engine with several agents
  // waiting at once knows which decision belongs to which
  const receipt = await engine.wait<Extract<ServerFrame, { type: "approvalAsked" }>>(
    f => f.type === "approvalAsked");
  assert.equal(receipt.askId, "ask-1");

  // and the CARD goes to his screen, in words he can judge without being a
  // developer — note the branch, the count and the repository are all in it
  const card = await waitApproval(owner, a => a.id === receipt.approvalId);
  assert.equal(card.approval.kind, "action");
  assert.equal(card.approval.remoteAction, "push");
  assert.equal(card.approval.status, "pending");
  assert.equal(card.approval.action, "push 3 commits to a new branch cloud9/architect-1 on vikas53953/cloud9");
  assert.equal(card.approval.detail, "2 files changed");
  assert.equal(card.approval.channelId, channel.id);
  assert.ok(typeof card.approval.expiresAt === "number", "a mid-run card has to be able to die");
  assert.equal(card.approval.taskId, undefined, "there was no job — and it does not invent one");

  owner.send({ type: "decideApproval", approvalId: receipt.approvalId, decision: "approved" });
  const decided = await waitApproval(engine, a => a.id === receipt.approvalId && a.status !== "pending");
  assert.equal(decided.approval.status, "approved");

  owner.close(); engine.close(); await relay.close();
});

test("a no comes back as a no, and it never becomes a maybe", async () => {
  const { relay, owner, engine, channel } = await stand("no.db");
  const agent = await makeAgent(owner, "Architect");
  engine.send({
    type: "askApproval", askId: "ask-2", agentId: agent.id, channelId: channel.id,
    facts: { action: "pullRequest", repo: "vikas53953/cloud9", branch: "cloud9/architect-1", base: "master" },
  });
  const receipt = await engine.wait<Extract<ServerFrame, { type: "approvalAsked" }>>(
    f => f.type === "approvalAsked");
  const card = await waitApproval(owner, a => a.id === receipt.approvalId);
  assert.equal(card.approval.action,
    "open a pull request into master from cloud9/architect-1 on vikas53953/cloud9");

  owner.send({ type: "decideApproval", approvalId: receipt.approvalId, decision: "rejected" });
  const decided = await waitApproval(engine, a => a.id === receipt.approvalId && a.status !== "pending");
  assert.equal(decided.approval.status, "rejected");

  // FR-AP-004: a decided card cannot be walked through a second time
  owner.send({ type: "decideApproval", approvalId: receipt.approvalId, decision: "approved" });
  await new Promise(r => setTimeout(r, 200));
  const flips = engine.frames.filter(
    f => f.type === "approval" && f.approval.id === receipt.approvalId && f.approval.status === "approved");
  assert.equal(flips.length, 0, "a rejected card stayed rejected");

  owner.close(); engine.close(); await relay.close();
});

// ------------------------------------------------------------- silence is not yes

test("NOBODY ANSWERS, so the card is STILL THERE — it does not die while he thinks", async () => {
  // WHAT THIS REPLACES. A card used to be swept away ten minutes after it was
  // raised and marked `expired`, and the agent behind it told nobody answered.
  // Removed 2026-08-07 at the owner's word: the tools this app is a front end
  // for ask a permission question and then wait. His question survives lunch.
  //
  // Verified failing against the old hub: the card came back `expired` and the
  // yes below did nothing.
  const { relay, url, owner, engine, channel } = await stand("expire.db");
  const agent = await makeAgent(owner, "Architect");
  engine.send({
    type: "askApproval", askId: "ask-3", agentId: agent.id, channelId: channel.id,
    facts: { action: "push", repo: "vikas53953/cloud9", branch: "cloud9/architect-1", commits: 1 },
  });
  const receipt = await engine.wait<Extract<ServerFrame, { type: "approvalAsked" }>>(
    f => f.type === "approvalAsked");
  await waitApproval(owner, a => a.id === receipt.approvalId);

  // the card is OLD — older than the ten minutes that used to kill it
  const stored = relay.store.approval(receipt.approvalId)!;
  stored.createdAt = Date.now() - 60 * 60_000;
  relay.store.saveApproval(stored);

  // a fresh client is the honest way to ask, because it is exactly what his
  // phone does when he picks it up again an hour later
  const second = new TestClient(url, "tok-owner");
  const hello = await second.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const seen = hello.state.approvals.find(a => a.id === receipt.approvalId)!;
  assert.equal(seen.status, "pending", "his question was thrown away while he was thinking");

  // AND IT IS STILL ANSWERABLE — the whole point. An hour late is still an answer.
  owner.send({ type: "decideApproval", approvalId: receipt.approvalId, decision: "approved" });
  await new Promise(r => setTimeout(r, 200));
  assert.equal(relay.store.approval(receipt.approvalId)!.status, "approved");

  second.close(); owner.close(); engine.close(); await relay.close();
});

// ------------------------------------------------------------------- the guards

test("a desktop client cannot mint an approval card for itself to approve", async () => {
  // Verified failing with the `conn.client !== "engine"` line removed: the
  // owner's own screen mints a card reading "push … on vikas53953/cloud9" and
  // then approves it, which is a yes nobody ever gave.
  const { relay, owner, channel } = await stand("desktopmint.db");
  const agent = await makeAgent(owner, "Architect");
  owner.send({
    type: "askApproval", askId: "ask-4", agentId: agent.id, channelId: channel.id,
    facts: { action: "push", repo: "vikas53953/cloud9", branch: "cloud9/architect-1", commits: 1 },
  });
  const err = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /only the engine/i);
  assert.equal(relay.store.approvals().length, 0, "nothing was written down");
  owner.close(); await relay.close();
});

test("an engine cannot ask on behalf of somebody else's agent", async () => {
  const { relay, url, owner, channel } = await stand("notmine.db");
  const mine = await makeAgent(owner, "Architect");
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friendEngine = new TestClient(url, `invite:${inv.code}:Priya`, "engine");
  await friendEngine.wait(f => f.type === "welcome");

  friendEngine.send({
    type: "askApproval", askId: "ask-5", agentId: mine.id, channelId: channel.id,
    facts: { action: "push", repo: "vikas53953/cloud9", branch: "cloud9/architect-1", commits: 9 },
  });
  const err = await friendEngine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /not your agent/i);
  assert.equal(relay.store.approvals().length, 0);
  friendEngine.close(); owner.close(); await relay.close();
});

test("only the agent's owner decides, and nobody else is even shown the card", async () => {
  // Two guards in one test on purpose: the friend must not be able to answer
  // it, AND must not be able to read the branch and repository names off it.
  // Verified failing with the `kind === "action"` branch of `sendApproval`
  // removed — the card lands on the friend's screen.
  const { relay, url, owner, engine, channel } = await stand("owneronly.db");
  const agent = await makeAgent(owner, "Architect");
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = new TestClient(url, `invite:${inv.code}:Priya`);
  await friend.wait(f => f.type === "welcome");

  engine.send({
    type: "askApproval", askId: "ask-6", agentId: agent.id, channelId: channel.id,
    facts: { action: "push", repo: "vikas53953/secret-repo", branch: "cloud9/architect-1", commits: 4 },
  });
  const receipt = await engine.wait<Extract<ServerFrame, { type: "approvalAsked" }>>(
    f => f.type === "approvalAsked");
  await waitApproval(owner, a => a.id === receipt.approvalId);
  await new Promise(r => setTimeout(r, 250));

  assert.equal(
    friend.frames.filter(f => f.type === "approval").length, 0,
    "the friend was never shown a card naming a private repository",
  );

  friend.send({ type: "decideApproval", approvalId: receipt.approvalId, decision: "approved" });
  const err = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /owner/i);
  assert.equal(relay.store.approval(receipt.approvalId)!.status, "pending");

  // and a reconnecting friend does not find it in the opening frame either
  // (a fresh code, because an invite is one-use — that guard is somebody
  // else's test and it still holds)
  owner.send({ type: "createInvite" });
  const inv2 = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(
    f => f.type === "invite" && f.code !== inv.code);
  const friend2 = new TestClient(url, `invite:${inv2.code}:Ravi`);
  const hello2 = await friend2.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  assert.equal(hello2.state.approvals.some(a => a.id === receipt.approvalId), false);

  friend2.close(); friend.close(); owner.close(); engine.close(); await relay.close();
});

test("the agent does not get to write the sentence the owner reads", async () => {
  // The one thing an approval card must never be is self-describing. Anything
  // the engine sends that is not on the facts list is simply not carried.
  const { relay, owner, engine, channel } = await stand("nosentence.db");
  const agent = await makeAgent(owner, "Architect");
  engine.send({
    type: "askApproval", askId: "ask-7", agentId: agent.id, channelId: channel.id,
    facts: {
      action: "push", repo: "vikas53953/cloud9", branch: "cloud9/architect-1", commits: 12,
      // a sentence the agent would love the owner to read instead
      action_text: "tidy up a few notes",
      detail: "nothing important",
    } as never,
  });
  const receipt = await engine.wait<Extract<ServerFrame, { type: "approvalAsked" }>>(
    f => f.type === "approvalAsked");
  const card = await waitApproval(owner, a => a.id === receipt.approvalId);
  assert.match(card.approval.action, /push 12 commits/);
  assert.doesNotMatch(card.approval.action, /tidy up/);
  assert.notEqual(card.approval.detail, "nothing important");
  owner.close(); engine.close(); await relay.close();
});

test("a request naming something that is not a remote action is refused, not guessed at", async () => {
  const { relay, owner, engine, channel } = await stand("badfacts.db");
  const agent = await makeAgent(owner, "Architect");
  for (const facts of [
    { action: "deleteEverything", repo: "vikas53953/cloud9" },
    { action: "push", branch: "cloud9/x\nApproved: yes" },
    { action: "push", commits: -3 },
  ]) {
    engine.send({
      type: "askApproval", askId: "bad", agentId: agent.id, channelId: channel.id,
      facts: facts as never,
    });
    await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  }
  assert.equal(relay.store.approvals().length, 0, "not one card was minted");
  owner.close(); engine.close(); await relay.close();
});

test("a job named on the request has to really be that agent's job", async () => {
  // The same law `recordRun` follows: a claim is dropped, not obeyed. Without
  // it, an agent could hang its push onto somebody else's job and inherit that
  // job's audience.
  const { relay, owner, engine, channel } = await stand("wrongtask.db");
  const mine = await makeAgent(owner, "Architect");
  const other = await makeAgent(owner, "Reviewer");
  owner.send({ type: "createTask", agentId: other.id, channelId: channel.id, title: "review the thing" });
  const task = await owner.wait<Extract<ServerFrame, { type: "task" }>>(f => f.type === "task");

  engine.send({
    type: "askApproval", askId: "ask-8", agentId: mine.id, channelId: channel.id,
    taskId: task.task.id,
    facts: { action: "push", repo: "vikas53953/cloud9", branch: "cloud9/architect-1", commits: 1 },
  });
  const receipt = await engine.wait<Extract<ServerFrame, { type: "approvalAsked" }>>(
    f => f.type === "approvalAsked");
  assert.equal(relay.store.approval(receipt.approvalId)!.taskId, undefined,
    "the borrowed job id did not survive inside the record either");
  owner.close(); engine.close(); await relay.close();
});

// ----------------------------------------------------- one owner for "must ask"

test("EVERY remote action must be asked about — whatever the agent's switches say", () => {
  // CLASS, NOT CASE. This walks the REMOTE_ACTIONS table itself, so a fourth
  // row added tomorrow is covered the day it is added rather than the day
  // somebody remembers to write a test for it.
  const readOnly = { abilities: { webSearch: true, files: false, schedules: false, background: false } };
  const everything = {
    abilities: {
      webSearch: true, files: true, schedules: true, background: true,
      commands: true, wholeComputer: true, connections: true,
    },
  };
  for (const action of Object.keys(REMOTE_ACTIONS) as RemoteAction[]) {
    assert.equal(mustAskBeforeActing(readOnly, { remoteAction: action }), true, action);
    assert.equal(mustAskBeforeActing(everything, { remoteAction: action }), true, action);
    // and the words are plain — no jargon, and it names the thing
    assert.ok(describeRemoteAction({ action }).length > 0);
  }
  // the old question is untouched: no remote action named, old answer
  assert.equal(mustAskBeforeActing(readOnly), false);
  assert.equal(mustAskBeforeActing(everything), true);
});

test("there is no deadline to share — only the lengths of the words he reads", () => {
  // The shared table used to carry `waitMs`, the ten minutes a card lived. It is
  // gone (2026-08-07) and nothing may put one back: a card ends because HE
  // decided or he pressed Stop, never because a clock did.
  assert.equal((APPROVAL_LIMITS as Record<string, unknown>).waitMs, undefined,
    "a deadline is back on the shared table — see timebudget.ts before adding one");
  assert.ok(APPROVAL_LIMITS.action >= 200);
});

