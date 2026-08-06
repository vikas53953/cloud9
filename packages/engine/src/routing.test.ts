// Provider routing: each agent turn runs on the harness the agent is set to
// (FR-AG-005), and a missing harness becomes a plain-words reply (FR-TL-005).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef, Message } from "@cloud9/shared";
import { Engine } from "./engine.js";
import { ClaudeProvider, HARNESS_DISCONNECTED_REPLY, RespondInput } from "./provider.js";
import { tempDir } from "./tmp-for-tests.js";

const tmp = (): string => tempDir("cloud9-routing-");

class StubProvider implements ClaudeProvider {
  calls: RespondInput[] = [];
  constructor(private label: string) {}
  async respond(input: RespondInput): Promise<string> {
    this.calls.push(input);
    return `reply from ${this.label}`;
  }
}

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
  createdAt: 0, ...over,
});

const trigger: Message = {
  id: "m1", channelId: "c1", authorId: "u1", authorName: "Vikas",
  authorKind: "human", text: "find villas", ts: 0,
};

function makeEngine() {
  const claude = new StubProvider("claude");
  const codex = new StubProvider("codex");
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(),
    provider: claude, codexProvider: codex,
  });
  const sent: { agentId: string; text: string }[] = [];
  engine.agentSend = (agentId, _channelId, text) => { sent.push({ agentId, text }); };
  return { engine, claude, codex, sent };
}

test("an agent with no provider set runs on Claude (v1 behaviour)", () => {
  const { engine, claude } = makeEngine();
  assert.equal(engine.providerFor(agent()), claude);
});

test("provider: \"claude\" runs on Claude, provider: \"codex\" runs on Codex", () => {
  const { engine, claude, codex } = makeEngine();
  assert.equal(engine.providerFor(agent({ provider: "claude" })), claude);
  assert.equal(engine.providerFor(agent({ provider: "codex" })), codex);
});

test("a codex agent's turn goes to the Codex provider only", async () => {
  const { engine, claude, codex, sent } = makeEngine();
  await engine.takeTurn(agent({ provider: "codex" }), "c1", trigger);
  assert.equal(codex.calls.length, 1);
  assert.equal(claude.calls.length, 0);
  assert.equal(sent[0].text, "reply from codex");
});

test("a claude agent's turn goes to the Claude provider only", async () => {
  const { engine, claude, codex, sent } = makeEngine();
  await engine.takeTurn(agent({ provider: "claude" }), "c1", trigger);
  assert.equal(claude.calls.length, 1);
  assert.equal(codex.calls.length, 0);
  assert.equal(sent[0].text, "reply from claude");
});

test("an unconnected harness makes the agent say so in plain words", async () => {
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(),
    provider: new StubProvider("claude"), // codexProvider deliberately absent
  });
  const sent: string[] = [];
  engine.agentSend = (_a, _c, text) => { sent.push(text); };
  assert.equal(engine.providerFor(agent({ provider: "codex" })), undefined);

  await engine.takeTurn(agent({ provider: "codex" }), "c1", trigger);
  assert.equal(sent.length, 1);
  assert.equal(sent[0], HARNESS_DISCONNECTED_REPLY);
  assert.ok(!/error|exception|stack/i.test(sent[0]), "no developer jargon in the reply");
});

test("a real provider error is reported without leaking internals into chat", async () => {
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(),
    provider: {
      respond: async () => {
        throw new Error("ENOENT C:\\Users\\vikasmit\\.codex\\auth.json while running codex exec -C secret");
      },
    },
  });
  const sent: string[] = [];
  engine.agentSend = (_a, _c, text) => { sent.push(text); };
  await engine.takeTurn(agent(), "c1", trigger);
  assert.match(sent[0], /something went wrong/);
  assert.ok(!sent[0].includes(HARNESS_DISCONNECTED_REPLY), "not mistaken for a sign-in problem");
  // the raw error text must not reach the channel
  for (const leak of ["ENOENT", "auth.json", "codex exec", "C:\\Users"]) {
    assert.ok(!sent[0].includes(leak), `chat message leaked ${leak}`);
  }
});

test("demo mode is opt-in: no credential and no demo flag means no fake answers", async () => {
  const bare = new Engine({ relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp() });
  assert.equal(bare.providerFor(agent()), undefined, "no implicit MockProvider fallback");
  const sent: string[] = [];
  bare.agentSend = (_a, _c, text) => { sent.push(text); };
  await bare.takeTurn(agent(), "c1", trigger);
  assert.equal(sent[0], HARNESS_DISCONNECTED_REPLY);

  const demo = new Engine({ relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(), demoMode: true });
  assert.ok(demo.providerFor(agent()), "demo mode still works when asked for");
});

test("an agent carrying a shell-metacharacter model never reaches a provider", async () => {
  const { engine, codex, sent } = makeEngine();
  await engine.takeTurn(agent({ provider: "codex", model: "x&&echo pwned" }), "c1", trigger);
  assert.equal(codex.calls.length, 0, "the provider is never called with an invalid agent");
  assert.match(sent[0].text, /something went wrong/);
});
