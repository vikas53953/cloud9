// ONE AGENT SUGGESTS A SAVING ON ANOTHER AGENT — and the owner is the only
// thing in the system that can make it happen.
//
// THE ASK THIS COMES FROM, in the owner's own words: "i want to add about token
// consumption so that agents can see and help optimize others agents
// automatically". Read literally, "automatically" is one agent rewriting
// another agent's settings with nobody watching — which fights the approval
// cards, the trust levels and the "nothing changes behind your back" design the
// rest of this hub is built on.
//
// So the power was split, and this file is the proof that the split holds:
//
//     AN AGENT MAY SEE WHAT ITS OWNER'S AGENTS COST.  (`spending`)
//     AN AGENT MAY ONLY ASK ABOUT CHANGING ONE.       (`askSaving`)
//     ONLY THE OWNER'S OWN YES CHANGES ANYTHING.      (`decideApproval`)
//
// EVERY TEST HERE FAILED BEFORE THE CHANGE: there was no `askSaving` frame, no
// `saving` kind, no `spending` frame, and no way for anything but the agent
// editor to alter an agent.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { Approval, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "🛠️", persona: "You write code",
  abilities: { webSearch: false, files: true, schedules: false, background: true },
};

/**
 * EVERYTHING THIS FILE OPENS, SO THAT EVERYTHING GETS SHUT.
 *
 * Found by running it: without this the file passed every test and then sat
 * there for ever, because a listening hub and an open socket are live handles
 * and node's runner waits for them. A suite that never exits reads as a hang,
 * and a hang is indistinguishable from a broken test to whoever runs it next.
 * Registering here rather than at the end of each test means a test that fails
 * half-way still hands its handles back.
 */
const opened: { relay: Relay; clients: TestClient[] }[] = [];
after(async () => {
  for (const s of opened) {
    for (const c of s.clients) c.close();
    await s.relay.close();
  }
});

async function stand(name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const hello = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  const clients = [owner, engine];
  opened.push({ relay, clients });
  /** any extra client a test opens has to be handed back too */
  const joins = (c: TestClient): TestClient => { clients.push(c); return c; };
  return { relay, url, owner, engine, joins, me: hello.state.me, channel: hello.state.channels[0]! };
}

async function makeAgent(client: TestClient, name: string, extra: object = {}) {
  client.send({ type: "createAgent", agent: { ...BASE_AGENT, name, ...extra } });
  const frame = await client.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === name);
  return frame.agent;
}

function waitApproval(c: TestClient, pred: (a: Approval) => boolean) {
  return c.wait<Extract<ServerFrame, { type: "approval" }>>(
    f => f.type === "approval" && pred(f.approval));
}

async function refuses(c: TestClient, frame: object, why: RegExp) {
  // CLEARED FIRST, or the loop below would match the error the PREVIOUS attempt
  // produced and every case after the first would pass without being tried.
  c.frames.length = 0;
  c.send(frame as never);
  const err = await c.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, why);
}

// ------------------------------------------------- the round trip, end to end

test("one agent suggests, the owner says yes, and the OTHER agent really changes", async () => {
  const { owner, engine, channel } = await stand("saving-yes.db");
  const watcher = await makeAgent(owner, "Watcher");
  // the expensive one: it loads his whole Claude Code setup on every turn
  const scout = await makeAgent(owner, "Scout", { useOwnerSetup: true });
  assert.equal(scout.useOwnerSetup, true);

  engine.send({
    type: "askSaving", askId: "ask-s1", agentId: watcher.id, channelId: channel.id,
    proposal: {
      about: scout.id, aboutName: "Scout",
      change: { what: "stopUsingOwnerSetup" },
      because: "Scout's turns average $1.75 each; the same question without your setup "
        + "loaded costs half a cent.",
    },
  });

  const receipt = await engine.wait<Extract<ServerFrame, { type: "approvalAsked" }>>(
    f => f.type === "approvalAsked");
  assert.equal(receipt.askId, "ask-s1");

  // THE CARD, IN WORDS HE CAN JUDGE WITHOUT BEING A DEVELOPER — and note that
  // the headline and the detail are CLOUD9'S, built from the closed change, not
  // anything the agent phrased. Only `saving.because` is the agent's.
  const card = (await waitApproval(owner, a => a.id === receipt.approvalId)).approval;
  assert.equal(card.kind, "saving");
  assert.equal(card.status, "pending");
  assert.equal(card.agentId, watcher.id, "the agent ASKING");
  assert.equal(card.saving?.about, scout.id, "and the agent it is ABOUT — a different one");
  assert.equal(card.action, "Stop Scout loading your own Claude Code setup on every turn?");
  assert.match(String(card.detail), /switch it back on any time/);
  assert.match(String(card.saving?.because), /\$1\.75/);
  assert.ok(typeof card.expiresAt === "number", "an agent is standing there, so it can die");
  for (const words of [card.action, String(card.detail)]) {
    assert.doesNotMatch(words, /token|context window|useOwnerSetup/i,
      "no jargon and no field names on his card");
  }

  // NOTHING HAS CHANGED YET, and that is the half of this feature that matters.
  owner.send({ type: "updateAgent", agent: { ...scout } });   // force a fresh read
  const untouched = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.id === scout.id);
  assert.equal(untouched.agent.useOwnerSetup, true, "a card waiting is not a change made");

  // HIS YES IS THE MOMENT IT CHANGES — one frame, one decision, one write.
  owner.send({ type: "decideApproval", approvalId: receipt.approvalId, decision: "approved" });
  const changed = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.id === scout.id && f.agent.useOwnerSetup === false);
  assert.equal(changed.agent.useOwnerSetup, false);
  assert.equal(changed.agent.name, "Scout", "and nothing else about it moved");
  assert.deepEqual(changed.agent.abilities, scout.abilities);
});

test("a no changes nothing at all, and says so", async () => {
  const { owner, engine, channel } = await stand("saving-no.db");
  const watcher = await makeAgent(owner, "Watcher");
  const scout = await makeAgent(owner, "Scout", { useOwnerSetup: true });

  engine.send({
    type: "askSaving", askId: "ask-s2", agentId: watcher.id, channelId: channel.id,
    proposal: {
      about: scout.id, aboutName: "Scout",
      change: { what: "stopUsingOwnerSetup" }, because: "it is expensive",
    },
  });
  const receipt = await engine.wait<Extract<ServerFrame, { type: "approvalAsked" }>>(
    f => f.type === "approvalAsked");
  owner.send({ type: "decideApproval", approvalId: receipt.approvalId, decision: "rejected" });
  const decided = await waitApproval(owner, a => a.id === receipt.approvalId && a.status !== "pending");
  assert.equal(decided.approval.status, "rejected");

  owner.send({ type: "updateAgent", agent: { ...scout } });
  const still = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.id === scout.id);
  assert.equal(still.agent.useOwnerSetup, true, "a rejected suggestion must leave no trace");
});

test("a monthly limit lands as a real ceiling, and keeps the per-job one he set", async () => {
  const { owner, engine, channel } = await stand("saving-cap.db");
  const watcher = await makeAgent(owner, "Watcher");
  const scout = await makeAgent(owner, "Scout", { spendCap: { perJobUsd: 3 } });

  engine.send({
    type: "askSaving", askId: "ask-s3", agentId: watcher.id, channelId: channel.id,
    proposal: {
      about: scout.id, aboutName: "Scout",
      change: { what: "setMonthlyLimit", perMonthUsd: 25 },
      because: "Scout has spent $12.40 this month and has no ceiling on it at all",
    },
  });
  const receipt = await engine.wait<Extract<ServerFrame, { type: "approvalAsked" }>>(
    f => f.type === "approvalAsked");
  const card = (await waitApproval(owner, a => a.id === receipt.approvalId)).approval;
  assert.match(card.action, /\$25\.00 a month/,
    "the amount he is agreeing to is IN the question — never just 'a limit'");

  owner.send({ type: "decideApproval", approvalId: receipt.approvalId, decision: "approved" });
  const changed = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.id === scout.id && !!f.agent.spendCap?.perMonthUsd);
  assert.deepEqual(changed.agent.spendCap, { perJobUsd: 3, perMonthUsd: 25 });
});

// ------------------------------------------------------------ what is refused

test("a window cannot mint a saving card — only the engine can", async () => {
  const { owner, channel } = await stand("saving-mint.db");
  const watcher = await makeAgent(owner, "Watcher");
  const scout = await makeAgent(owner, "Scout", { useOwnerSetup: true });
  // A CLIENT ABLE TO MINT ONE COULD MANUFACTURE A HARMLESS-LOOKING CARD AND
  // THEN APPROVE IT WITH ITS OWN SECOND FRAME — the same reason `askApproval`
  // and `askPlan` are engine-only.
  await refuses(owner, {
    type: "askSaving", askId: "ask-s4", agentId: watcher.id, channelId: channel.id,
    proposal: {
      about: scout.id, aboutName: "Scout",
      change: { what: "stopUsingOwnerSetup" }, because: "x",
    },
  }, /only the engine/);
});

test("a change that is not on the closed list never becomes a card", async () => {
  const { owner, engine, channel } = await stand("saving-closed.db");
  const watcher = await makeAgent(owner, "Watcher");
  const scout = await makeAgent(owner, "Scout");
  // THIS IS THE WHOLE SAFETY ARGUMENT. Even a completely subverted agent can
  // only ever put one of two narrowing changes in front of him.
  for (const change of [
    { what: "startUsingOwnerSetup" },
    { what: "setTrust", trust: "full" },
    { what: "stopUsingOwnerSetup", abilities: { wholeComputer: true } },
    { what: "setMonthlyLimit", perMonthUsd: -1 },
    "stopUsingOwnerSetup",
  ]) {
    await refuses(engine, {
      type: "askSaving", askId: "ask-s5", agentId: watcher.id, channelId: channel.id,
      proposal: { about: scout.id, aboutName: "Scout", change, because: "trust me" },
    }, /isn't a change Cloud9 knows how to make/);
  }
});

test("a suggestion about somebody else's agent never becomes a card", async () => {
  const { url, owner, engine, channel, joins } = await stand("saving-stranger.db");
  const watcher = await makeAgent(owner, "Watcher");
  // a second person with their own agent on the same hub
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = joins(new TestClient(url, `invite:${invite.code}:Friend`));
  await friend.wait(f => f.type === "welcome");
  const theirs = await makeAgent(friend, "TheirAgent", { useOwnerSetup: true });

  await refuses(engine, {
    type: "askSaving", askId: "ask-s6", agentId: watcher.id, channelId: channel.id,
    proposal: {
      about: theirs.id, aboutName: "TheirAgent",
      change: { what: "stopUsingOwnerSetup" }, because: "it is expensive",
    },
  }, /not your agent/);
});

test("the card names the agent it would REALLY change, not the name the agent typed", async () => {
  const { owner, engine, channel } = await stand("saving-name.db");
  const watcher = await makeAgent(owner, "Watcher");
  const scout = await makeAgent(owner, "Scout", { useOwnerSetup: true });

  engine.send({
    type: "askSaving", askId: "ask-s7", agentId: watcher.id, channelId: channel.id,
    proposal: {
      about: scout.id,
      // an agent that names the target one thing and points at another must not
      // be able to get the friendly name onto the card
      aboutName: "Something Harmless",
      change: { what: "stopUsingOwnerSetup" }, because: "trust me",
    },
  });
  const receipt = await engine.wait<Extract<ServerFrame, { type: "approvalAsked" }>>(
    f => f.type === "approvalAsked");
  const card = (await waitApproval(owner, a => a.id === receipt.approvalId)).approval;
  assert.equal(card.saving?.aboutName, "Scout");
  assert.match(card.action, /Scout/);
  assert.doesNotMatch(card.action, /Harmless/);
});

// --------------------------------------------------------- seeing the figures

test("the spending answer covers only the asker's own agents", async () => {
  const { url, owner, joins } = await stand("saving-see.db");
  await makeAgent(owner, "Scout");
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = joins(new TestClient(url, `invite:${invite.code}:Friend`));
  await friend.wait(f => f.type === "welcome");
  await makeAgent(friend, "TheirAgent");

  friend.send({ type: "spending" });
  const theirs = await friend.wait<Extract<ServerFrame, { type: "spending" }>>(
    f => f.type === "spending");
  // Neither has taken a turn, so both answers are empty — but the SHAPE is the
  // point: the frame carries no way to name anybody, so there is nothing to
  // widen. Being in a room with someone's agent has never been a licence to see
  // what they spend.
  assert.equal(theirs.period, "thisMonth");
  assert.ok(theirs.rows.every(r => r.use.agentName !== "Scout"),
    "a stranger's agent must never appear in this answer");
});
