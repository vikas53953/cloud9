import test from "node:test";
import assert from "node:assert/strict";
import { AgentDef, ClientFrame, Message, WorldState } from "@cloud9/shared";
import { Engine } from "./engine.js";
import { ClaudeProvider, RespondInput } from "./provider.js";
import { tempDir } from "./tmp-for-tests.js";

const OWNER = "u-owner";
const agent = (overrides: Partial<AgentDef> = {}): AgentDef => ({
  id: "a-scout", ownerId: OWNER, name: "Scout", emoji: "S", persona: "inspect code",
  abilities: { webSearch: false, files: true, schedules: false, background: true }, createdAt: 0,
  ...overrides,
});

class CaptureProvider implements ClaudeProvider {
  inputs: RespondInput[] = [];
  async respond(input: RespondInput): Promise<string> {
    this.inputs.push(input);
    return "done";
  }
}

function setup(provider: ClaudeProvider, roomAgents: AgentDef[] = [agent()]) {
  const engine = new Engine({ relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tempDir("cloud9-command-"), provider });
  const frames: ClientFrame[] = [];
  (engine as unknown as { ws: unknown }).ws = {
    readyState: 1,
    send: (raw: string) => frames.push(JSON.parse(raw) as ClientFrame),
  };
  const a = roomAgents[0]!;
  engine.state = {
    me: { id: OWNER, name: "Owner" }, users: [{ id: OWNER, name: "Owner" }], agents: roomAgents,
    channels: [{ id: "c1", name: "ops", kind: "channel", memberIds: [OWNER, ...roomAgents.map(item => item.id)], createdAt: 0 }],
    messages: [], agentStatus: {}, tasks: [], approvals: [],
  } as unknown as WorldState;
  return { engine, frames, a, roomAgents };
}

async function say(engine: Engine, text: string, mentions = ["a-scout"]): Promise<void> {
  const message: Message = {
    id: `m-${Date.now()}-${Math.random()}`, channelId: "c1", authorId: OWNER,
    authorName: "Owner", authorKind: "human", text, ts: Date.now(), mentions,
  };
  await (engine as unknown as { considerReplies(m: Message): Promise<void> }).considerReplies(message);
}

test("slash summarize and review become real provider turns", async () => {
  const provider = new CaptureProvider();
  const { engine, frames } = setup(provider);
  await say(engine, "@Scout /summarize decisions");
  await say(engine, "@Scout /review packages/shared/src/index.ts");
  assert.equal(provider.inputs[0]?.trigger, "Summarize this conversation, focusing on decisions. Include key decisions, open questions, and next actions.");
  assert.equal(provider.inputs[1]?.reviewOnly, true);
  assert.match(provider.inputs[1]?.trigger ?? "", /read-only review/i);
  assert.ok(frames.some(f => f.type === "agentSend" && f.text === "done"));
});

test("slash assign creates the existing durable task and rejects an off-room target", async () => {
  const { engine, frames } = setup(new CaptureProvider());
  await say(engine, "/assign @Scout inspect the build");
  const task = frames.find((f): f is Extract<ClientFrame, { type: "createTask" }> => f.type === "createTask");
  assert.equal(task?.agentId, "a-scout");
  assert.equal(task?.title, "inspect the build");

  const before = frames.length;
  await say(engine, "@Scout /assign @Missing inspect the build");
  assert.ok(frames.length > before, "an invalid target gets an honest refusal when a room agent can say it");
  assert.ok(frames.some(f => f.type === "agentSend" && /not an agent in this room/i.test(f.text)));
  assert.equal(frames.filter(f => f.type === "createTask").length, 1);
});

test("slash assign resolves exact spaced and emoji room agents on the dispatch path", async () => {
  const data = agent({ id: "a-data", name: "Data Scout", emoji: "📊" });
  const compass = agent({ id: "a-compass", name: "🧭 Reviewer", emoji: "🧭" });
  const { engine, frames } = setup(new CaptureProvider(), [data, compass]);
  await say(engine, "/assign @Data Scout inspect telemetry", [data.id]);
  await say(engine, "/assign @🧭 Reviewer review the release", [compass.id]);
  const tasks = frames.filter((f): f is Extract<ClientFrame, { type: "createTask" }> => f.type === "createTask");
  assert.deepEqual(tasks.map(task => [task.agentId, task.title]), [
    [data.id, "inspect telemetry"], [compass.id, "review the release"],
  ]);
});

test("slash assign routes a stable in-room agent id without a display-name mention", async () => {
  const data = agent({ id: "a-data", name: "Data Scout", emoji: "📊" });
  const provider = new CaptureProvider();
  const { engine, frames } = setup(provider, [data]);
  await say(engine, "/assign @a-data inspect telemetry", []);
  const task = frames.find((f): f is Extract<ClientFrame, { type: "createTask" }> => f.type === "createTask");
  assert.equal(task?.agentId, data.id);
  assert.equal(task?.title, "inspect telemetry");
  assert.equal(provider.inputs.length, 0, "assign uses the durable task path, not persona relevance");
});

test("stable leading ids route review and outsider ids fail visibly without free-chatter fallback", async () => {
  const data = agent({ id: "a-data", name: "Data Scout" });
  const provider = new CaptureProvider();
  const { engine, frames } = setup(provider, [data]);
  await say(engine, "@a-data /review release notes", []);
  assert.equal(provider.inputs[0]?.reviewOnly, true);
  const before = provider.inputs.length;
  await say(engine, "/assign @a-outsider inspect telemetry", []);
  assert.equal(provider.inputs.length, before);
  assert.ok(frames.some(f => f.type === "agentSend" && /not an agent in this room/i.test(f.text)));
  assert.equal(frames.filter(f => f.type === "createTask").length, 0);
});

test("unknown leading targets and duplicate room names refuse without provider or task side effects", async () => {
  const first = agent({ id: "a-first", name: "Twin" });
  const second = agent({ id: "a-second", name: "Twin" });
  const provider = new CaptureProvider();
  const { engine, frames } = setup(provider, [first, second]);
  await say(engine, "@a-outsider /review release notes", []);
  await say(engine, "/assign @Twin inspect telemetry", []);
  assert.equal(provider.inputs.length, 0);
  assert.equal(frames.filter(f => f.type === "createTask").length, 0);
  assert.equal(frames.filter(f => f.type === "agentSend").length, 2);
  assert.ok(frames.every(f => f.type !== "agentSend" || /not an agent in this room|ambiguous/i.test(f.text)));
});

test("a spaced-name prefix in an explicit assign target refuses instead of becoming chat", async () => {
  const data = agent({ id: "a-data", name: "Data Scout" });
  const provider = new CaptureProvider();
  const { engine, frames } = setup(provider, [data]);
  await say(engine, "/assign @Data inspect telemetry", []);
  assert.equal(provider.inputs.length, 0);
  assert.equal(frames.filter(f => f.type === "createTask").length, 0);
  assert.ok(frames.some(f => f.type === "agentSend" && /not an agent in this room/i.test(f.text)));
});

test("slash ship uses the repository gate instead of pretending a checkout exists", async () => {
  const provider = new CaptureProvider();
  const { engine, frames } = setup(provider);
  await say(engine, "@Scout /ship prepare the release");
  assert.equal(provider.inputs.length, 0, "no provider turn starts without a repository");
  assert.ok(frames.some(f => f.type === "agentSend" && /repository|code lives/i.test(f.text)));
});
