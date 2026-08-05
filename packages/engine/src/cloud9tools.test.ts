// FINDING 3: THE FIRST DOORWAY BACK INTO CLOUD9 — and the boundary on it.
//
// The law, and the whole of it:
//
//     AN AGENT MAY SEARCH ONLY THE CONVERSATION IT IS TAKING A TURN IN.
//
// It is not a switch, because it cannot be: every agent on every rung, including
// "Just talk — no tools at all", already receives the recent messages of the
// room in its prompt. Reading the room it is standing in is what a turn IS, and
// searching the same room is that same power reaching further back.
//
// Searching ANY OTHER room is a different power and it is refused. These tests
// attack that from every side a model could: a channel in the arguments, a
// channel with a different name, a stale ticket from a turn that has ended, and
// a ticket for one conversation used to ask about another.
import test from "node:test";
import assert from "node:assert/strict";
import {
  answerCloud9Rpc, callCloud9Tool, CLOUD9_TOOLS, cloud9McpConfig, cloud9ToolNames,
  Cloud9SearchAnswer, Cloud9ToolTurn, renderCloud9Tools,
} from "./cloud9tools.js";
import { ToolBridge } from "./toolbridge.js";
import { proxyLine } from "./cloud9mcp.js";
import { claudeArgs } from "./claude-cli.js";
import { AgentAbilities, AgentDef } from "@cloud9/shared";

const ALL_OFF: AgentAbilities = {
  webSearch: false, files: false, schedules: false, background: false,
};
const agent = (abilities: Partial<AgentAbilities> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Sol", emoji: "🌞", persona: "You research travel",
  abilities: { ...ALL_OFF, ...abilities }, createdAt: 0,
});

/**
 * A stand-in Cloud9. It records WHICH conversation each search actually reached,
 * so a test can assert on the boundary rather than on the answer.
 */
function stand(channelId: string) {
  const asked: { channelId: string; query: string }[] = [];
  const opened: { channelId: string; name: string }[] = [];
  const turn: Cloud9ToolTurn = {
    channelId,
    search: async (query, limit): Promise<Cloud9SearchAnswer> => {
      asked.push({ channelId, query });
      return {
        hits: [{ author: "Vikas", when: 1_700_000_000_000, text: `something about ${query}` }],
        hasMore: false,
      };
    },
    openAttachment: async name => {
      opened.push({ channelId, name });
      return { found: true, name, text: "the villa costs 40,000", truncated: false };
    },
  };
  return { turn, asked, opened };
}

const search = CLOUD9_TOOLS.find(t => t.name === "search_conversation")!;

/** One real tool call, over the real loopback bridge, with one real ticket. */
async function call(ticket: { url: string; secret: string }, query: string): Promise<void> {
  await fetch(ticket.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloud9-turn": ticket.secret },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "search_conversation", arguments: { query } },
    }),
  });
}

// -------------------------------------------------- the boundary

test("an agent's search cannot leave the conversation it is taking a turn in", async () => {
  const { turn, asked } = stand("c_goa_trip");
  // every shape a model could use to try to reach somewhere else
  const attempts: Record<string, unknown>[] = [
    { query: "villa", channelId: "c_private_hr" },
    { query: "villa", channel: "#hr" },
    { query: "villa", scope: "all" },
    { query: "villa", all: true },
    { query: "villa", channelIds: ["c_private_hr", "c_goa_trip"] },
  ];
  for (const args of attempts) {
    const out = await callCloud9Tool(search, args, turn);
    assert.equal(out.isError, true, `${JSON.stringify(args)} was not refused`);
    assert.match(out.content[0].text, /only search the conversation you are in/);
  }
  assert.deepEqual(asked, [], "a widened search actually ran");

  // and the honest one still works, in the one conversation it may reach
  const ok = await callCloud9Tool(search, { query: "villa" }, turn);
  assert.notEqual(ok.isError, true);
  assert.deepEqual(asked, [{ channelId: "c_goa_trip", query: "villa" }]);
});

test("the tool has no way to name a conversation — there is no parameter for one", () => {
  const props = Object.keys((search.schema as { properties: Record<string, unknown> }).properties);
  assert.deepEqual(props, ["query"], "search_conversation grew a second parameter");
  assert.equal((search.schema as { additionalProperties: boolean }).additionalProperties, false);
  assert.doesNotMatch(JSON.stringify(search.schema), /channel|room|scope/i);
});

test("a ticket is bound to ONE conversation, and a second ticket cannot borrow it", async (t) => {
  const bridge = new ToolBridge();
  await bridge.start();
  t.after(() => bridge.stop());

  const goa = stand("c_goa_trip");
  const hr = stand("c_private_hr");
  const goaTicket = bridge.openTurn(goa.turn)!;
  const hrTicket = bridge.openTurn(hr.turn)!;
  assert.notEqual(goaTicket.secret, hrTicket.secret, "two turns were given the same ticket");

  await call(goaTicket, "villa");
  assert.deepEqual(goa.asked.map(a => a.channelId), ["c_goa_trip"]);
  assert.equal(hr.asked.length, 0, "the Goa ticket reached the private room");

  // the SAME words, on the other ticket, reach the other room and only that one
  await call(hrTicket, "villa");
  assert.deepEqual(hr.asked.map(a => a.channelId), ["c_private_hr"]);
  assert.equal(goa.asked.length, 1);
});

test("a ticket dies with its turn — a stale one reaches nothing at all", async (t) => {
  const bridge = new ToolBridge();
  await bridge.start();
  t.after(() => bridge.stop());
  const goa = stand("c_goa_trip");
  const ticket = bridge.openTurn(goa.turn)!;
  ticket.close();

  const res = await fetch(ticket.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloud9-turn": ticket.secret },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "search_conversation", arguments: { query: "villa" } } }),
  });
  assert.equal(res.status, 403);
  assert.deepEqual(goa.asked, [], "a finished turn's ticket still searched");
});

test("an invented ticket is refused outright", async (t) => {
  const bridge = new ToolBridge();
  await bridge.start();
  t.after(() => bridge.stop());
  const goa = stand("c_goa_trip");
  bridge.openTurn(goa.turn);
  const res = await fetch(`http://127.0.0.1:${(await bridge.start())}/tool`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloud9-turn": "not-a-real-ticket" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  assert.equal(res.status, 403);
  assert.deepEqual(goa.asked, []);
});

test("the doorway listens on this computer only", async (t) => {
  const bridge = new ToolBridge();
  const port = await bridge.start();
  t.after(() => bridge.stop());
  const goa = stand("c1");
  const ticket = bridge.openTurn(goa.turn)!;
  assert.ok(ticket.url.startsWith(`http://127.0.0.1:${port}/`),
    `the tool doorway is not loopback-only: ${ticket.url}`);
});

// -------------------------------------------------- the protocol

test("the MCP side answers initialize, tools/list and tools/call", async () => {
  const { turn } = stand("c1");
  const init = await answerCloud9Rpc({ jsonrpc: "2.0", id: 1, method: "initialize" }, turn);
  assert.ok(init && (init.result as { serverInfo: { name: string } }).serverInfo.name === "cloud9");

  const list = await answerCloud9Rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, turn);
  const tools = (list!.result as { tools: { name: string }[] }).tools;
  assert.deepEqual(tools.map(t => t.name), CLOUD9_TOOLS.map(t => t.name));

  const called = await answerCloud9Rpc({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "search_conversation", arguments: { query: "villa" } },
  }, turn);
  assert.match(JSON.stringify(called!.result), /Earlier in THIS conversation/);

  // a notification gets silence, which is what MCP expects
  assert.equal(await answerCloud9Rpc({ method: "notifications/initialized" }, turn), undefined);
});

test("the MCP child forwards a line and hands the answer back", async (t) => {
  const bridge = new ToolBridge();
  await bridge.start();
  t.after(() => bridge.stop());
  const goa = stand("c_goa_trip");
  const ticket = bridge.openTurn(goa.turn)!;

  const said: string[] = [];
  await proxyLine(JSON.stringify({
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "search_conversation", arguments: { query: "villa" } },
  }), { url: ticket.url, secret: ticket.secret, send: l => said.push(l) });

  assert.equal(said.length, 1);
  assert.match(said[0], /Earlier in THIS conversation/);
  assert.deepEqual(goa.asked.map(a => a.channelId), ["c_goa_trip"]);
});

test("when Cloud9 is not answering, the child says so instead of hanging", async () => {
  const said: string[] = [];
  await proxyLine(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }), {
    url: "http://127.0.0.1:1/tool", secret: "x", send: l => said.push(l),
  });
  assert.equal(said.length, 1);
  assert.match(said[0], /not answering tool calls/);
});

test("a search that fails tells the agent to say so, never why", async () => {
  const turn: Cloud9ToolTurn = {
    channelId: "c1",
    search: async () => { throw new Error("ECONNRESET at C:\\Users\\Vikas\\cloud9\\hub.js:12"); },
    openAttachment: async () => ({ found: false, why: "not asked in this test" }),
  };
  const out = await callCloud9Tool(search, { query: "villa" }, turn);
  assert.equal(out.isError, true);
  assert.doesNotMatch(out.content[0].text, /ECONNRESET|Vikas|hub\.js/);
  assert.match(out.content[0].text, /say so rather than guessing/);
});

test("nothing found is reported as a real answer, not as a failure", async () => {
  const turn: Cloud9ToolTurn = {
    channelId: "c1", search: async () => ({ hits: [], hasMore: false }),
    openAttachment: async () => ({ found: false, why: "not asked in this test" }),
  };
  const out = await callCloud9Tool(search, { query: "villa" }, turn);
  assert.notEqual(out.isError, true);
  assert.match(out.content[0].text, /it was not said here/);
});

// -------------------------------------------------- the tool and the sentence

test("the doorway is ungated: even a 'just talk' agent gets it, when it is open", () => {
  const talkOnly = agent();
  const withDoorway = claudeArgs(talkOnly, [], { cloud9McpConfigPath: "C:\\a\\.cloud9-mcp.json" });
  for (const name of cloud9ToolNames()) {
    assert.ok(withDoorway.includes(name),
      `${name} is not declared to the harness, so it would silently never arrive`);
  }
  assert.ok(withDoorway.includes("--mcp-config"));
  // and no doorway means no tool name and no config — never a name with nothing
  // behind it, which is the failure mode `abilities.ts` exists to prevent
  const without = claudeArgs(talkOnly);
  for (const name of cloud9ToolNames()) assert.ok(!without.includes(name));
  assert.ok(!without.includes("--mcp-config"));
});

test("the doorway does not ride on the `connections` switch", () => {
  // These are two different things and they were nearly given one slot: the
  // owner's connected services are a real account and sit on the top rung;
  // searching the room you are already reading is not.
  const talkOnly = claudeArgs(agent(), [], { cloud9McpConfigPath: "C:\\a\\.cloud9-mcp.json" });
  assert.ok(talkOnly.includes("--mcp-config"), "the doorway needs the top rung");
  // an owner's MCP file still does need it
  const notConnected = claudeArgs(agent(), [], { mcpConfigPath: "C:\\a\\owner.json" });
  assert.ok(!notConnected.includes("--mcp-config"));
});

test("the agent is told about the tool it was handed, in its own prompt", () => {
  const said = renderCloud9Tools();
  assert.match(said, /search_conversation/);
  assert.match(said, /this conversation only/i);
});

test("the config file names Cloud9's server and carries the ticket out of argv", () => {
  const doc = JSON.parse(cloud9McpConfig("C:\\a\\cloud9mcp.js", { url: "http://127.0.0.1:5/tool", secret: "s3cret" }));
  const server = doc.mcpServers.cloud9;
  assert.deepEqual(server.args, ["C:\\a\\cloud9mcp.js"]);
  assert.equal(server.env.CLOUD9_TOOL_SECRET, "s3cret");
  // a secret in argv is readable by every process on the machine
  assert.ok(!JSON.stringify(server.args).includes("s3cret"));
});
