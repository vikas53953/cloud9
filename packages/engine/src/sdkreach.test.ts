import test from "node:test";
import assert from "node:assert/strict";
import { AgentAbilities, AgentDef } from "@cloud9/shared";
import {
  ProviderOutputMissingError, SdkProvider,
} from "./provider.js";

const ALL_OFF: AgentAbilities = {
  webSearch: false, files: false, schedules: false, background: false,
};

const agent = (abilities: Partial<AgentAbilities> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Fable5", emoji: "🧭",
  persona: "You help with the accounts",
  abilities: { ...ALL_OFF, ...abilities } as AgentAbilities,
  createdAt: 0,
  model: "claude-sonnet-4-6",
});

const turn = (a: AgentDef) => ({
  agent: a, context: "Vikas: hello", trigger: "read the file", triggerAuthor: "Vikas",
  kind: "chat" as const,
});

type Event = Record<string, unknown>;
function fakeQuery(events: Event[], seen?: (options: Record<string, unknown>) => void) {
  return async function* ({ options }: { prompt: string; options: Record<string, unknown> }) {
    seen?.(options);
    for (const event of events) yield event;
  };
}

const system = { type: "system", subtype: "init", session_id: "sess-1", model: "claude-sonnet-4-6" };
const success = (result = "final answer") => ({
  type: "result", subtype: "success", session_id: "sess-1", result,
  duration_ms: 12, num_turns: 2, usage: { input_tokens: 3, output_tokens: 4 },
});

test("stored-key SDK keeps supplied folders and does not impose a six-turn trap", async () => {
  let options: Record<string, unknown> | undefined;
  const provider = new SdkProvider(
    { apiKey: "saved-key" }, () => "C:\\agents\\a1",
    { wholeComputerRoots: () => ["C:\\shared"], mcpConfigPath: () => undefined },
    fakeQuery([system, success()], o => { options = o; }),
  );
  const answer = await provider.respond(turn(agent({ wholeComputer: true })));
  assert.equal(answer, "final answer");
  assert.deepEqual(options?.additionalDirectories, ["C:\\shared"]);
  assert.equal("maxTurns" in (options ?? {}), false);
  const env = options?.env as Record<string, string | undefined>;
  assert.equal(env.ANTHROPIC_API_KEY, "saved-key");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
});

test("SDK exposes live steps, trace/session/run facts, Cloud9 tools, and closes its doorway", async () => {
  let options: Record<string, unknown> | undefined;
  let closed = false;
  const steps: unknown[] = [];
  let trace: Record<string, unknown> | undefined;
  const provider = new SdkProvider(
    { oauthToken: "oauth" }, () => "C:\\agents\\a1",
    { cloud9Tools: () => ({ id: "t1", url: "http://127.0.0.1/tool", secret: "s", close: () => { closed = true; } }) },
    fakeQuery([
      system,
      { type: "assistant", session_id: "sess-1", message: { content: [{ type: "tool_use", name: "Read" }, { type: "text", text: "intermediate" }] } },
      success("surviving final"),
    ], o => { options = o; }),
  );
  const answer = await provider.respond({ ...turn(agent()), channelId: "c1", onStep: s => steps.push(...s), onTrace: t => { trace = t as unknown as Record<string, unknown>; } });
  assert.equal(answer, "surviving final");
  assert.ok(steps.length >= 1);
  assert.equal(trace?.sessionId, "sess-1");
  assert.equal(trace?.resumed, false);
  assert.equal(trace?.finalAnswer, true);
  assert.equal(closed, true);
  const servers = options?.mcpServers as Record<string, unknown>;
  assert.ok(servers.cloud9);
  assert.ok((options?.tools as string[]).some(name => name.startsWith("mcp__cloud9__")));
});

test("Stop's abort controller reaches the SDK query", async () => {
  const controller = new AbortController();
  let seen: AbortController | undefined;
  const provider = new SdkProvider(
    { apiKey: "saved-key" }, () => "C:\\agents\\a1", {},
    fakeQuery([system, success()], options => { seen = options.abortController as AbortController; }),
  );
  await provider.respond({ ...turn(agent()), abortController: controller });
  assert.equal(seen, controller);
});

test("intermediate assistant text without a final result fails loudly", async () => {
  const provider = new SdkProvider(
    { apiKey: "saved-key" }, () => "C:\\agents\\a1", {},
    fakeQuery([system, { type: "assistant", message: { content: [{ type: "text", text: "stale" }] } }]),
  );
  await assert.rejects(() => provider.respond(turn(agent())), ProviderOutputMissingError);
});

test("terminal result without a surviving final answer is not success", async () => {
  const provider = new SdkProvider(
    { apiKey: "saved-key" }, () => "C:\\agents\\a1", {}, fakeQuery([system, success("")]),
  );
  await assert.rejects(() => provider.respond(turn(agent())), ProviderOutputMissingError);
});
