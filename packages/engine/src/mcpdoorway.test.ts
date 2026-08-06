// THE FLAG THAT KILLED CLOUD9'S OWN TOOLS — and the guard that stops it coming back.
//
// WHAT HAPPENED. `claudeArgs` put `--safe-mode` and `--mcp-config <path>` on the
// same command line and assumed both applied. They do not. `--safe-mode` means
// "all customizations disabled" ABSOLUTELY — including an MCP server we hand the
// CLI ourselves, on that same line. Measured 2026-08-05 against CLI 2.1.222 with
// a throwaway one-tool MCP server, four runs differing only in flags:
//
//   --safe-mode --strict-mcp-config --mcp-config X → mcp_servers: []
//                                                    the server was never spawned
//                                                    model said "no such tool"
//   --safe-mode                     --mcp-config X → mcp_servers: []
//               --strict-mcp-config --mcp-config X → mcp_servers: [probe:connected]
//                                                    tool CALLED, right answer back
//                                   --mcp-config X → probe + all 17 of the owner's
//
// WHAT IT COST. Two things Cloud9 believed it shipped were dead in every real
// turn: the `connections` switch granted nothing at all, and CLOUD9'S OWN TOOLS
// (`search_conversation`, `open_attachment` — cloud9tools.ts) did not exist.
// Agents were told in their prompts that they could search the conversation and
// open attached files, then answered "I can't do that" — which, from where they
// were standing, was true. This file exists so that can never be true again.
//
// THE CLASS, not the case. The guard below is not "don't pass --safe-mode". It is
// "no flag whose job is to switch the CLI's customizations off may sit on a line
// that also passes an MCP config we need honoured" — a named list with the
// reason on each row, so the next tempting flag is caught by the same rule.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentAbilities, AgentDef } from "@cloud9/shared";
import {
  CLAUDE_ISOLATION_ENV, CLAUDE_ISOLATION_FLAGS, ClaudeCliProvider, claudeArgs,
} from "./claude-cli.js";
import { CLOUD9_TOOLS, cloud9ToolNames, renderCloud9Tools } from "./cloud9tools.js";
import { buildAgentPrompt } from "./provider.js";
import { EMPTY_ARG } from "./run.js";
import { tempDir } from "./tmp-for-tests.js";

const ALL_OFF: AgentAbilities = {
  webSearch: false, files: false, schedules: false, background: false,
};

const agent = (abilities: Partial<AgentAbilities> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { ...ALL_OFF, ...abilities }, createdAt: 0,
});

const DOORWAY = "C:\\data\\a1\\.cloud9-mcp-turn1.json";

/**
 * Flags that switch the CLI's own customizations off WHOLESALE. Each was either
 * measured to kill a `--mcp-config` we passed, or documents that it would.
 * Cloud9 needs `--mcp-config` honoured for its own tools, so none of these may
 * ever appear on an agent's line — the isolation has to be built from flags that
 * remove the OWNER'S things specifically, not from a blanket off switch.
 */
const KILLS_OUR_MCP_CONFIG: { flag: string; measured: string }[] = [
  {
    flag: "--safe-mode",
    measured: "CLI 2.1.222, 2026-08-05: identical runs, with it mcp_servers came back " +
      "[] and the server process was never spawned; without it [{probe,connected}] and " +
      "the tool answered.",
  },
  {
    flag: "--bare",
    measured: "CLI 2.1.222 --help: skips hooks, plugin sync and CLAUDE.md, but ALSO makes " +
      "auth strictly ANTHROPIC_API_KEY — 'OAuth and keychain are never read'. Cloud9's " +
      "whole Claude path is the app's own sign-in, so this would sign every agent out.",
  },
];

test("no flag on an agent's line may switch off the MCP config Cloud9 depends on", () => {
  // every shape of agent, doorway open and shut — the guard is not conditional
  const shapes: Partial<AgentAbilities>[] = [
    {}, { webSearch: true }, { webSearch: true, files: true, schedules: true, background: true },
  ];
  for (const abilities of shapes) {
    for (const extras of [{}, { cloud9McpConfigPath: DOORWAY }, { mcpConfigPath: "C:\\x\\m.json" }]) {
      const args = claudeArgs(agent(abilities), [], extras);
      for (const { flag, measured } of KILLS_OUR_MCP_CONFIG) {
        assert.ok(!args.includes(flag), `${flag} is back on the line. ${measured}`);
      }
    }
  }
  // and it cannot be smuggled in through the constant either
  for (const { flag } of KILLS_OUR_MCP_CONFIG) {
    assert.ok(!(CLAUDE_ISOLATION_FLAGS as readonly string[]).includes(flag));
  }
});

test("the isolation that replaced --safe-mode is still on the line", () => {
  const args = claudeArgs(agent({ webSearch: true }), [], { cloud9McpConfigPath: DOORWAY });
  // an EMPTY list of setting sources: no user, project or local settings, and on
  // this CLI that is also what stops CLAUDE.md and plugins loading.
  const at = args.indexOf("--setting-sources");
  assert.ok(at >= 0, "the owner's CLAUDE.md, plugins, hooks and settings would load");
  assert.equal(args[at + 1], EMPTY_ARG,
    "an empty source list — a real value here loads his settings straight back in");
  assert.ok(args.includes("--strict-mcp-config"), "the owner's own 17 MCP servers");
  assert.ok(args.includes("--disable-slash-commands"), "the owner's skills");
});

test("auto-memory is closed by the environment, because the CLI has no flag for it", () => {
  assert.equal(CLAUDE_ISOLATION_ENV.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1",
    "without this the init event reports a memory_paths folder --safe-mode used to close");
});

test("the provider really hands that environment to the child, not just declares it", async () => {
  const dir = tempDir("cloud9-doorway-");
  try {
    let seen: NodeJS.ProcessEnv | undefined;
    const cli = new ClaudeCliProvider({
      agentDataDir: () => dir,
      runner: async (_cmd, _args, opts) => {
        seen = opts?.env;
        return {
          code: 0, stdout: `{"type":"result","subtype":"success","is_error":false,"result":"ok"}`,
          stderr: "", timedOut: false, notFound: false,
        };
      },
    });
    await cli.respond({
      agent: agent(), context: "", trigger: "hi", triggerAuthor: "V", kind: "chat",
    });
    assert.ok(seen, "the runner was never given an environment");
    for (const [key, value] of Object.entries(CLAUDE_ISOLATION_ENV)) {
      assert.equal(seen![key], value, `${key} never reached the child`);
    }
    // and the credential stripping it rides alongside is still doing its job
    assert.equal(seen!.ANTHROPIC_API_KEY, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("when the doorway is open, its server AND its tools are both on the line", () => {
  const args = claudeArgs(agent(), [], { cloud9McpConfigPath: DOORWAY });
  // the server
  const configs = args.map((a, i) => (a === "--mcp-config" ? args[i + 1] : undefined)).filter(Boolean);
  assert.ok(configs.includes(DOORWAY), "Cloud9's own MCP config is not passed at all");
  // the tools, declared — `--tools` is what decides which tools exist, so a
  // server on the line whose tools are undeclared is still a dead doorway
  for (const name of cloud9ToolNames()) {
    assert.ok(args.includes(name), `${name} is not declared in --tools`);
  }
  assert.ok(cloud9ToolNames().length >= 2, "search_conversation and open_attachment");
});

test("an agent is never told about a Cloud9 tool the line does not carry", () => {
  const brief = {
    context: "", trigger: "what does budget-q3.xlsx say?", triggerAuthor: "Vikas",
    kind: "chat" as const,
  };
  const withDoor = buildAgentPrompt(agent(), { ...brief, supply: {}, cloud9Tools: true });
  const without = buildAgentPrompt(agent(), { ...brief, supply: {}, cloud9Tools: false });
  for (const tool of CLOUD9_TOOLS) {
    assert.ok(withDoor.includes(tool.name), `${tool.name} is granted and never mentioned`);
    assert.ok(!without.includes(tool.name),
      `${tool.name} is promised while the command line does not carry it — ` +
      `this is the exact shape of the --safe-mode bug, in the prompt instead of the argv`);
  }
  assert.match(renderCloud9Tools(), /search_conversation/);
});
