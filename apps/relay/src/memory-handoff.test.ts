// THE HUB'S HALF of agent memory and agent-to-agent handoff.
//
// The hub keeps NO copy of either: an agent's memory lives in its own engine's
// store, and a handoff is built and delivered, never stored. So everything the
// hub does here is ROUTING, and these tests pin exactly that:
//
//   - a screen's "what does this agent remember?" is forwarded to the OWNER'S
//     engine, and only for an agent the asker owns;
//   - the engine's report of those notes is handed back to the owner's screens;
//   - a handoff from one engine is validated with the SAME rule the builder
//     used, and delivered to the RECEIVING agent's engine;
//   - a desktop cannot forge either of the engine-only frames.
import test from "node:test";
import assert from "node:assert/strict";
import { ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const AGENT = { emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: false, schedules: false, background: false } };

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
  client.send({ type: "createAgent", agent: { ...AGENT, name } });
  const frame = await client.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === name);
  return frame.agent;
}

// ------------------------------------------------------------------- memory

test("a screen asking for an agent's memory is forwarded to the owner's engine", async () => {
  const { relay, owner, engine } = await stand("mem-list.db");
  const scout = await makeAgent(owner, "Scout");

  owner.send({ type: "memoryList", agentId: scout.id });

  const req = await engine.wait<Extract<ServerFrame, { type: "memoryListRequested" }>>(
    f => f.type === "memoryListRequested");
  assert.equal(req.agentId, scout.id, "the engine is asked to report this agent's notes");
  owner.close(); engine.close(); await relay.close();
});

test("the engine's report of an agent's notes reaches the owner's screens", async () => {
  const { relay, owner, engine } = await stand("mem-report.db");
  const scout = await makeAgent(owner, "Scout");

  // the engine reports what it read off its own store
  engine.send({
    type: "memoryChanged", agentId: scout.id,
    notes: [{
      id: "m-test-0001", agentId: scout.id, kind: "fact",
      text: "Vikas ships on Fridays", createdAt: Date.now(), source: "owner",
    }],
  });

  const got = await owner.wait<Extract<ServerFrame, { type: "memory" }>>(f => f.type === "memory");
  assert.equal(got.agentId, scout.id);
  assert.equal(got.notes.length, 1);
  assert.match(got.notes[0].text, /ships on Fridays/);
  owner.close(); engine.close(); await relay.close();
});

test("a desktop cannot masquerade as the engine and inject memory", async () => {
  const { relay, owner, engine } = await stand("mem-forge.db");
  const scout = await makeAgent(owner, "Scout");
  // the SAME frame, sent from a desktop connection, must be refused
  owner.send({
    type: "memoryChanged", agentId: scout.id,
    notes: [{ id: "m-x", agentId: scout.id, kind: "fact", text: "forged", createdAt: 0, source: "owner" }],
  });
  const err = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /only the engine/i);
  owner.close(); engine.close(); await relay.close();
});

// ------------------------------------------------------------------ handoff

test("a handoff from the engine is validated and delivered to the receiver's engine", async () => {
  const { relay, owner, engine, channel } = await stand("handoff.db");
  const scout = await makeAgent(owner, "Scout");
  const terra = await makeAgent(owner, "Terra");

  engine.send({
    type: "sendHandoff",
    handoff: {
      id: "h-test-0001", fromAgentId: scout.id, toAgentId: terra.id,
      task: "finish the deployment notes",
      contextPointer: { kind: "channel", ref: channel.id },
      createdAt: Date.now(),
    },
  });

  const delivered = await engine.wait<Extract<ServerFrame, { type: "handoffReceived" }>>(
    f => f.type === "handoffReceived");
  assert.equal(delivered.handoff.fromAgentId, scout.id);
  assert.equal(delivered.handoff.toAgentId, terra.id);
  assert.equal(delivered.handoff.task, "finish the deployment notes");
  owner.close(); engine.close(); await relay.close();
});

test("the hub refuses a handoff that does not check out", async () => {
  const { relay, owner, engine } = await stand("handoff-bad.db");
  const scout = await makeAgent(owner, "Scout");
  // an agent handing off to itself — refused by the same rule the builder uses
  engine.send({
    type: "sendHandoff",
    handoff: {
      id: "h-test-0002", fromAgentId: scout.id, toAgentId: scout.id,
      task: "do it", contextPointer: { kind: "channel", ref: "c1" }, createdAt: Date.now(),
    },
  });
  const err = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /itself/i);
  owner.close(); engine.close(); await relay.close();
});

test("a desktop cannot hand work between agents — only the engine can", async () => {
  const { relay, owner, engine } = await stand("handoff-forge.db");
  const scout = await makeAgent(owner, "Scout");
  const terra = await makeAgent(owner, "Terra");
  owner.send({
    type: "sendHandoff",
    handoff: {
      id: "h-test-0003", fromAgentId: scout.id, toAgentId: terra.id,
      task: "do it", contextPointer: { kind: "channel", ref: "c1" }, createdAt: Date.now(),
    },
  });
  const err = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /only the engine/i);
  owner.close(); engine.close(); await relay.close();
});
