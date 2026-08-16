// REAL SOCKET PROBE for the no-timing zombie-card fix.
//
// `packages/engine/src/parkedwaits.test.ts` proves the desk decisions, but its
// fake socket cannot prove the Engine close handler really reconnects. This
// file drives a real Relay + Engine WebSocket for both paths:
//   1. a dropped socket leaves a pending plan alive and a later approval reaches
//      the same waiter after reconnect;
//   2. after an actual Engine stop/restart, an approval for the old pending card
//      is called out plainly instead of becoming a silent green no-op.
import test from "node:test";
import assert from "node:assert/strict";
import { Engine } from "@cloud9/engine";
import { Approval, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const AGENT = {
  emoji: "🔧", persona: "You write code",
  abilities: {
    webSearch: false, files: true, schedules: false,
    background: true, commands: true,
  },
};

async function until(what: () => boolean, why: string, ms = 10_000): Promise<void> {
  const stop = Date.now() + ms;
  while (!what()) {
    if (Date.now() > stop) throw new Error(`gave up waiting: ${why}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function stand(name: string): Promise<{
  relay: Relay; url: string; owner: TestClient; channelId: string; agentId: string;
}> {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const hello = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(
    frame => frame.type === "welcome");
  owner.send({ type: "createAgent", agent: { ...AGENT, name: "Architect" } });
  const created = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    frame => frame.type === "agent" && frame.agent.name === "Architect");
  return { relay, url, owner, channelId: hello.state.channels[0]!.id, agentId: created.agent.id };
}

async function connectEngine(url: string): Promise<Engine> {
  const engine = new Engine({
    relayUrl: url, token: "tok-owner", dataDir: tmp("engine-data"), demoMode: true,
  });
  const ready = new Promise<void>(resolve => { engine.onReady = () => resolve(); });
  engine.connect();
  await ready;
  return engine;
}

function pendingCard(owner: TestClient, agentId: string): Promise<Approval> {
  return owner.wait<Extract<ServerFrame, { type: "approval" }>>(
    frame => frame.type === "approval" && frame.approval.agentId === agentId
      && frame.approval.status === "pending",
  ).then(frame => frame.approval);
}

test("a real WebSocket close reconnects without answering a pending plan", async () => {
  const { relay, url, owner, channelId, agentId } = await stand("reconnect.db");
  const engine = await connectEngine(url);
  const agent = engine.state!.agents.find(a => a.id === agentId)!;
  const outcome = engine.approvals.askPlan({ agent, channelId, plan: "1. wait for approval" });
  const card = await pendingCard(owner, agentId);
  const oldSocket = engine.ws!;

  // This is the real ws close event, not a field assignment on a fake socket.
  oldSocket.close();
  await until(() => engine.ws !== oldSocket, "the Engine to create its reconnect socket");
  assert.equal(engine.approvals.pending, 1, "a dropped socket answered for the owner");

  owner.send({
    type: "decideApproval", approvalId: card.id, decision: "approved",
    expectedRevision: card.revision ?? 0, approvalEpoch: card.approvalEpoch,
    requestId: "reconnect-approve",
  });
  const result = await outcome;
  assert.equal(result.approved, true, "the later approval did not reach the original waiter");

  engine.stop(); owner.close(); await relay.close();
});

test("a real restart says when an approved zombie card did nothing", async () => {
  let relay: Relay | undefined;
  let owner: TestClient | undefined;
  let first: Engine | undefined;
  let restarted: Engine | undefined;
  try {
    const setup = await stand("restart.db");
    relay = setup.relay;
    owner = setup.owner;
    const currentRelay = setup.relay;
    const { url, channelId, agentId } = setup;
    const currentOwner = setup.owner;
    const currentFirst = await connectEngine(url);
    first = currentFirst;
    const agent = currentFirst.state!.agents.find(a => a.id === agentId)!;
    const outcome = currentFirst.approvals.askPlan({ agent, channelId, plan: "1. wait for approval" });
    const card = await pendingCard(currentOwner, agentId);

    // Stop the first process: the persisted card remains pending in the hub,
    // but there is deliberately no waiter left behind to execute a later
    // decision.
    currentFirst.stop();
    await outcome;
    currentOwner.send({
      type: "decideApproval", approvalId: card.id, decision: "approved",
      expectedRevision: card.revision ?? 0, approvalEpoch: card.approvalEpoch,
      requestId: "restart-approve",
    });
    await until(() => currentRelay.store.approval(card.id)?.status === "approved",
      "the hub to record the approval");

    // Register before reconnect: the warning is sent during the welcome replay.
    const warning = currentOwner.wait<Extract<ServerFrame, { type: "message" }>>(
      frame => frame.type === "message" && /restarted after I asked/i.test(frame.message.text),
      15_000,
    );
    restarted = await connectEngine(url);
    const frame = await warning;
    assert.match(frame.message.text, /did not happen and nothing left this computer/i);
    assert.match(frame.message.text, /ask me again/i);
  } finally {
    first?.stop();
    restarted?.stop();
    first?.ws?.terminate();
    restarted?.ws?.terminate();
    owner?.ws.terminate();
    owner?.close();
    if (relay) await relay.close();
  }
});
