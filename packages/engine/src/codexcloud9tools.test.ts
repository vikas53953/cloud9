// CLOUD9'S OWN TOOLS ON A CODEX TURN — and the honest sentence about the one
// thing Codex still cannot have.
//
// WHAT WAS WRONG. There was no MCP path in `codex.ts` at all. Cloud9's own
// doorway — `search_conversation`, `open_attachment`, `remember_this` — was on
// every Claude turn and on no Codex turn, so a Codex agent could see the NAME of
// an attached file in its context and had no way to open it. Every test below
// failed before the change beside it.
//
// AND THE OTHER HALF: the connections screen offered a Codex agent a file
// picker and, once a file was chosen, told him "In use — Scout can reach the
// services in this file". `codex.ts` has never carried a connections file onto a
// command line. The app now says so instead.
//
// MEASURED, NOT ASSUMED. The whole shape of this — an HTTP MCP server named by
// `-c`, a bearer token read from an environment variable, and
// `default_tools_approval_mode=approve` because `codex exec` has nobody to ask
// for an approval — came off live turns on codex-cli 0.146.0. The long note in
// `codex.ts` records each probe and what it proved.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentDef } from "@cloud9/shared";
import {
  CODEX_CLOUD9_SERVER, CODEX_TOOL_SECRET_ENV, codexArgs, codexCloud9ToolArgs,
  createCodexIsolatedEnvironment,
} from "./codex.js";
import { commandLine } from "./run.js";
import { connectionsFileFor, connectionsWords, mcpConfigPathFor } from "./connections.js";

const TICKET = { url: "http://127.0.0.1:52341/tool", secret: "a".repeat(48) };

const codexAgent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You fix builds",
  provider: "codex",
  // a Codex agent holds the unremovable built-ins; anything less is refused
  abilities: {
    webSearch: true, files: true, schedules: true, background: true,
    commands: true, helpers: true,
  },
  createdAt: 0,
  ...over,
});

// --------------------------------------------- the doorway reaches the CLI

test("a Codex turn with a doorway names Cloud9's MCP server on its own command line", () => {
  const args = codexArgs(codexAgent(), "C:\\work", [], [], { cloud9Tool: { url: TICKET.url } });
  const at = args.indexOf(`mcp_servers.${CODEX_CLOUD9_SERVER}.url=${TICKET.url}`);
  assert.ok(at > 0, "before this, no Codex turn had an MCP server of any kind");
  assert.equal(args[at - 1], "-c", "it is a config override, which is the only channel that " +
    "survives --ignore-user-config");
  assert.ok(args.includes(
    `mcp_servers.${CODEX_CLOUD9_SERVER}.bearer_token_env_var=${CODEX_TOOL_SECRET_ENV}`),
  "the ticket is named, never spelled out");
  assert.ok(args.includes(`mcp_servers.${CODEX_CLOUD9_SERVER}.default_tools_approval_mode=approve`),
    "without this every call comes back 'user cancelled MCP tool call' — measured");
});

test("no doorway, no promise: the command line says nothing about MCP at all", () => {
  const args = codexArgs(codexAgent(), "C:\\work");
  assert.ok(!args.some(a => a.includes("mcp_servers")),
    "a turn that could not open the doorway must not claim one");
  assert.deepEqual(codexCloud9ToolArgs(undefined), []);
  assert.deepEqual(codexCloud9ToolArgs({ url: "" }), []);
});

test("the isolation is untouched — every wall is still on the line", () => {
  const args = codexArgs(codexAgent(), "C:\\work", [], [], { cloud9Tool: { url: TICKET.url } });
  for (const flag of ["--ignore-user-config", "--ignore-rules", "--ephemeral"]) {
    assert.ok(args.includes(flag), `${flag} must survive — it is what keeps his setup out`);
  }
  for (const off of ["plugins", "apps", "memories", "hooks", "computer_use", "browser_use"]) {
    const at = args.indexOf(off);
    assert.ok(at > 0 && args[at - 1] === "--disable", `${off} must still be switched off`);
  }
  assert.ok(!args.includes("--dangerously-bypass-approvals-and-sandbox"),
    "the approval gate and the sandbox are not what bought this");
});

test("every value is something run.ts will actually accept", () => {
  // The reason this design works at all, and the reason the OWNER'S connections
  // file cannot come the same way: `run.ts` refuses quotes and brackets rather
  // than escaping them, and an MCP server defined inline needs both.
  const args = codexArgs(codexAgent(), "C:\\work", [], [], { cloud9Tool: { url: TICKET.url } });
  assert.doesNotThrow(() => commandLine("codex", args),
    "this argv has to survive the real guard, not a fake runner");
  assert.throws(() => commandLine("codex", ["-c", 'mcp_servers.x.args=["C:\\a.js"]']),
    "…which is exactly why a JSON connections file cannot be poured onto this line");
});

test("the ticket rides in the environment and never in argv", () => {
  const args = codexArgs(codexAgent(), "C:\\work", [], [], { cloud9Tool: { url: TICKET.url } });
  assert.ok(!args.some(a => a.includes(TICKET.secret)),
    "any process on this machine can read another one's command line");

  const isolated = createCodexIsolatedEnvironment({
    baseEnv: { PATH: "x", ANTHROPIC_API_KEY: "must-not-survive" },
    toolSecret: TICKET.secret,
    ownerCodexHome: "C:\\nope", ownerUserHome: "C:\\nope",
  });
  try {
    assert.equal(isolated.env[CODEX_TOOL_SECRET_ENV], TICKET.secret);
    assert.equal(isolated.env.ANTHROPIC_API_KEY, undefined,
      "the credential stripping is not softened by carrying a ticket");
    assert.ok(isolated.env.CODEX_HOME?.length, "and it is still a throwaway home");
  } finally {
    isolated.dispose();
  }
});

// ------------------------------- the one thing Codex still cannot be handed

test("a Codex agent is told plainly that a connections file cannot work for it", () => {
  const chosen = "C:\\Users\\Vikas\\AppData\\Roaming\\cloud9\\calendar-mcp.json";
  const scout = codexAgent({ connectionsFile: chosen });
  scout.abilities = { ...scout.abilities, connections: true };

  const state = connectionsFileFor(scout, () => true);
  assert.equal(state.state, "unsupported",
    "the screen used to say 'In use' about a file no Codex turn has ever carried");
  assert.equal(state.supply, undefined, "and nothing may reach a command line");
  assert.equal(mcpConfigPathFor(scout, () => true), undefined);

  const words = connectionsWords(state, "Scout");
  assert.match(words.headline, /Codex agents cannot use a connections file/);
  assert.match(words.detail, /run it on Claude instead/,
    "an honest 'no' has to say what to do about it");
  assert.match(words.detail, /searching this conversation/,
    "and it must not leave him thinking Codex agents have no tools at all");
});

test("the same agent on Claude is unaffected — this is a Codex fact, not a new refusal", () => {
  const chosen = "C:\\Users\\Vikas\\AppData\\Roaming\\cloud9\\calendar-mcp.json";
  const scout = codexAgent({ provider: "claude", connectionsFile: chosen });
  scout.abilities = { ...scout.abilities, connections: true };
  assert.equal(connectionsFileFor(scout, () => true).state, "ready");
  assert.equal(mcpConfigPathFor(scout, () => true), chosen);
});
