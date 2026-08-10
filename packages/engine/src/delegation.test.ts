import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { AgentDef, ClientFrame, ServerFrame, Task, WorldState } from "@cloud9/shared";
import { Engine } from "./engine.js";
import { ClaudeProvider, RespondInput } from "./provider.js";
import { tempDir } from "./tmp-for-tests.js";

const agent: AgentDef = {
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🤖", persona: "You handle delegated work",
  abilities: { webSearch: false, files: false, schedules: false, background: true }, createdAt: 0,
};
const state = (): WorldState => ({
  me: { id: "u1", name: "Vikas", createdAt: 0 } as WorldState["me"],
  users: [{ id: "u1", name: "Vikas", createdAt: 0 } as WorldState["users"][number]],
  agents: [agent], channels: [{ id: "c1", name: "ops", kind: "channel", memberIds: ["u1", "a1"], createdAt: 0 }],
  messages: [], agentStatus: {}, tasks: [], approvals: [],
});
class Provider implements ClaudeProvider {
  async respond(_input: RespondInput): Promise<string> { return "Handed work is complete."; }
}

test("a desktop handoff uses durable source message and thread anchors", async t => {
  const engine = new Engine({ relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tempDir("cloud9-delegation-"), provider: new Provider() });
  const frames: ClientFrame[] = [];
  (engine as unknown as { sendFrame: (f: ClientFrame) => void }).sendFrame = f => frames.push(f);
  const feed = (f: ServerFrame): void => (engine as unknown as { onFrame: (f: ServerFrame) => void }).onFrame(f);
  feed({ type: "welcome", state: state() });
  t.after(() => engine.stop());
  const task: Task = {
    id: "t-handoff", title: "finish the build", requesterId: "u1", requesterName: "Vikas",
    agentId: "a1", channelId: "c1", status: "not_started", createdAt: 0, updatedAt: 0,
    sourceMessageId: "m-source", sourceThreadId: "m-root",
  };
  feed({ type: "task", task });
  await new Promise(resolve => setTimeout(resolve, 80));
  const sends = frames.filter((f): f is Extract<ClientFrame, { type: "agentSend" }> => f.type === "agentSend");
  assert.ok(sends.some(f => f.replyTo === "m-root"), "the completion is posted in the durable source thread");
});
