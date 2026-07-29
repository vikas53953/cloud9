// An agent runs in a DECLARED environment, not in the owner's.
//
// The bug these pin down was measured, not guessed. On 2026-07-29, an agent
// whose only ability was "search the web" arrived at the model holding 30
// built-in tools (Task, the Cron family, SendMessage, worktrees, RemoteTrigger),
// every MCP server on Vikas's machine — Telegram, Vercel, Notion, Gmail — 130 of
// his slash commands, and his global CLAUDE.md. The ability toggles were not
// the permission boundary they claim to be.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentAbilities, AgentDef } from "@cloud9/shared";
import { claudeToolsFor } from "./abilities.js";
import { claudeArgs, CLAUDE_ISOLATION_FLAGS } from "./claude-cli.js";
import { codexArgs, CODEX_ISOLATION_FLAGS } from "./codex.js";
import { EMPTY_ARG, run, UnsafeArgumentError } from "./run.js";

const ALL_OFF: AgentAbilities = {
  webSearch: false, files: false, schedules: false, background: false,
};

const agent = (abilities: Partial<AgentAbilities> = {}, over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { ...ALL_OFF, ...abilities }, createdAt: 0, ...over,
});

/** Everything the CLI can hand a model that we never asked for. */
const NOT_OURS = [
  "Task", "CronCreate", "CronDelete", "CronList", "SendMessage", "EnterWorktree",
  "RemoteTrigger", "Skill", "ToolSearch", "Workflow", "NotebookEdit", "Edit", "Bash",
];

test("the argv declares the exact tool set, and nothing else can arrive", () => {
  const scout = agent({ webSearch: true });
  const args = claudeArgs(scout);

  const at = args.indexOf("--tools");
  assert.ok(at >= 0, "the built-in tool set is declared, not left to the machine's config");
  // everything up to the next flag is the declared set
  const declared: string[] = [];
  for (let i = at + 1; i < args.length && !args[i].startsWith("--"); i++) declared.push(args[i]);
  assert.deepEqual(declared, ["WebSearch", "WebFetch"]);
  assert.deepEqual(declared, claudeToolsFor(scout), "declared IS what the abilities table grants");

  for (const stranger of NOT_OURS) {
    assert.ok(!declared.includes(stranger), `${stranger} was declared to a web-search agent`);
  }
});

test("an agent with no abilities is declared ZERO tools, not 'the default set'", () => {
  const args = claudeArgs(agent());
  const at = args.indexOf("--tools");
  assert.ok(at >= 0);
  assert.equal(args[at + 1], EMPTY_ARG, "the empty declaration, not a missing flag");
  assert.ok(!args.includes("--allowed-tools"), "and nothing is permitted either");
});

test("the empty declaration survives the real command-line builder as a real \"\"", async () => {
  // through the REAL run(), so the real argument checker sees the real argv.
  // A missing command is fine: we only care that it agreed to build the line.
  const result = await run("cloud9-no-such-command-9x", claudeArgs(agent()), { timeoutMs: 15_000 });
  assert.equal(result.notFound, true, "it tried to run — the empty argument was accepted");
});

test("the empty-argument escape has exactly one owner and cannot be forged", async () => {
  // a client cannot produce EMPTY_ARG: the allowlist refuses its characters
  await assert.rejects(
    () => run("cloud9-no-such-command-9x", ['""'], {}),
    (err: unknown) => err instanceof UnsafeArgumentError,
    "a literal quote pair is still refused",
  );
  assert.match(EMPTY_ARG, /\u0000/, "the sentinel is unspellable through the allowlist");
});

test("no MCP server, skill, hook or CLAUDE.md of the owner's reaches an agent", () => {
  const args = claudeArgs(agent({ webSearch: true, files: true }));
  for (const flag of CLAUDE_ISOLATION_FLAGS) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }
  // named individually so a future edit that drops one fails here, loudly
  assert.ok(args.includes("--safe-mode"), "the owner's CLAUDE.md, skills, plugins and hooks");
  assert.ok(args.includes("--strict-mcp-config"), "the owner's connected accounts");
  assert.ok(args.includes("--disable-slash-commands"), "the owner's skills");
});

test("a Codex agent does not load the owner's config or rules either", () => {
  const args = codexArgs(agent({ files: true }), "C:/data/a1");
  for (const flag of CODEX_ISOLATION_FLAGS) assert.ok(args.includes(flag), `missing ${flag}`);
  assert.ok(args.includes("--ignore-user-config"), "no ~/.codex/config.toml: MCP servers, features");
  assert.ok(args.includes("--ignore-rules"), "no user or project execpolicy rules");
  // and the sandbox is still driven by the ability, not by his settings
  assert.ok(args.includes("workspace-write"));
  assert.ok(codexArgs(agent(), "C:/data/a1").includes("read-only"));
});

test("isolation is not something an agent definition can switch off", () => {
  // every shape of agent still gets every isolation flag
  const shapes: Partial<AgentAbilities>[] = [
    {}, { webSearch: true }, { files: true },
    { webSearch: true, files: true, schedules: true, background: true },
  ];
  for (const abilities of shapes) {
    const claude = claudeArgs(agent(abilities));
    for (const flag of CLAUDE_ISOLATION_FLAGS) assert.ok(claude.includes(flag));
    const codex = codexArgs(agent(abilities), "C:/data/a1");
    for (const flag of CODEX_ISOLATION_FLAGS) assert.ok(codex.includes(flag));
  }
});

// This one is a KNOWN LIMIT written down as a test so nobody claims otherwise.
test("Codex cannot declare its built-in tool set — this is recorded, not fixed", () => {
  const args = codexArgs(agent({ webSearch: true }), "C:/data/a1");
  assert.ok(!args.includes("--tools"),
    "codex-cli 0.146.0 has no --tools; if this ever fails, Codex grew one and we should use it");
  // Measured 2026-07-29 with both isolation flags on: the model still reported
  // collaboration.spawn_agent, list_mcp_resources, web.run and image_gen.
  // A Codex agent's toggles govern its SANDBOX, not its whole tool surface.
});
