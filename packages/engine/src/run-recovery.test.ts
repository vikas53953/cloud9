import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Engine } from "./engine.js";

test("unsupported resume is visibly fail-closed and does not execute a provider turn", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "c9-recovery-engine-"));
  const engine = new Engine({ relayUrl: "ws://127.0.0.1:1", token: "t", dataDir });
  let calls = 0;
  (engine as unknown as { respondAs: () => Promise<string> }).respondAs = async () => { calls++; return "unexpected"; };
  await (engine as unknown as { handleRecoveryRequest: (request: unknown) => Promise<void> }).handleRecoveryRequest({
    requestId: "recovery-1", requesterId: "owner-1", agentId: "agent-1", runId: "run-1",
    payload: { mode: "resume", ask: "resume safely", approvalEpoch: "server-token" },
  });
  assert.equal(calls, 0);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("retry and restart execute fresh turns linked to the prior run", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "c9-recovery-engine-"));
  const engine = new Engine({ relayUrl: "ws://127.0.0.1:1", token: "t", dataDir });
  const inputs: Array<{ trigger: string; priorRunId?: string; channelId?: string; replyTo?: string; kind?: string; requesterKind?: string; triggerAuthor?: string }> = [];
  (engine as unknown as { state: unknown }).state = {
    me: { id: "owner-1", name: "Vikas" }, agents: [{ id: "agent-1", ownerId: "owner-1", name: "Scout" }],
  };
  (engine as unknown as { renderContext: () => string }).renderContext = () => "";
  (engine as unknown as { respondAs: (_agent: unknown, input: typeof inputs[number]) => Promise<string> }).respondAs = async (_agent, input) => {
    inputs.push(input);
    return "fresh";
  };
  const handle = (engine as unknown as { handleRecoveryRequest: (request: unknown) => Promise<void> }).handleRecoveryRequest.bind(engine);
  const base = { requestId: "recovery-2", requesterId: "owner-1", agentId: "agent-1", runId: "run-1",
    kind: "chat" as const, channelId: "channel-1", replyTo: "message-1",
    requesterKind: "human" as const, requestedBy: "Vikas",
    payload: { ask: "inspect safely", approvalEpoch: "server-token" } };
  await handle({ ...base, payload: { ...base.payload, mode: "retry" } });
  await handle({ ...base, requestId: "recovery-3", payload: { ...base.payload, mode: "restart" } });
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].priorRunId, "run-1");
  assert.equal(inputs[0].channelId, "channel-1");
  assert.equal(inputs[0].replyTo, "message-1");
  assert.equal(inputs[0].kind, "chat");
  assert.equal(inputs[0].requesterKind, "human");
  assert.equal(inputs[0].triggerAuthor, "Vikas");
  assert.match(inputs[1].trigger, /restart with context from run run-1/);
  assert.equal(inputs[1].priorRunId, "run-1");
  fs.rmSync(dataDir, { recursive: true, force: true });
});
