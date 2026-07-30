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
import { codexArgs, CODEX_ALWAYS_DISABLED, CODEX_ISOLATION_FLAGS } from "./codex.js";
import { HARNESS_ISOLATION, isolationFor } from "./isolation.js";
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

// ---------------------------------------------------------------------------
// What Codex CAN be told to drop. Measured on codex-cli 0.146.0, 2026-07-29,
// by two real `codex exec` turns that differ only in these flags:
//
//   with --ignore-user-config --ignore-rules ONLY, the model reported holding
//     tool_search_tool, functions.list_mcp_resources,
//     functions.list_mcp_resource_templates, functions.read_mcp_resource,
//     functions.request_plugin_install, image_gen.imagegen, web.run,
//     collaboration.* (7), functions.{wait,shell_command,update_plan,
//     request_user_input,view_image,exec,apply_patch}
//   — and the CLI's own "Skill descriptions were shortened" note.
//
//   with the feature switches below added, the SAME prompt reported
//     functions.{wait,shell_command,update_plan,request_user_input,view_image,
//     exec,apply_patch}, collaboration.* (7), web.run
//   — six tools gone, and no skills note.

test("a Codex agent is told to drop the owner's plugins, apps, MCP resources and image tool", () => {
  const args = codexArgs(agent({ files: true }), "C:/data/a1");
  for (const feature of CODEX_ALWAYS_DISABLED) {
    const at = args.indexOf(feature);
    assert.ok(at > 0, `feature ${feature} is never switched off`);
    assert.equal(args[at - 1], "--disable", `${feature} is not attached to a --disable`);
  }
  // named individually so dropping one fails here, loudly, with the tool it costs
  assert.ok(CODEX_ALWAYS_DISABLED.includes("plugins"), "functions.request_plugin_install");
  assert.ok(CODEX_ALWAYS_DISABLED.includes("apps"), "the owner's connected apps");
  assert.ok(CODEX_ALWAYS_DISABLED.includes("image_generation"), "image_gen.imagegen");
});

test("Codex's own web-search switch follows the ability, both ways", () => {
  const on = codexArgs(agent({ webSearch: true }), "C:/data/a1");
  const off = codexArgs(agent(), "C:/data/a1");
  assert.ok(on.includes("tools.web_search=true"), "an agent allowed the web gets the CLI switch on");
  assert.ok(off.includes("tools.web_search=false"), "and one that is not gets it off");
});

// --------------------------------------------------------------------------
// The app must be able to TELL THE TRUTH about which harness's toggles are a
// real boundary. A screen that shows the same sentence for both is the bug.

test("the engine can say, per harness, whether the toggles are the boundary", () => {
  assert.equal(HARNESS_ISOLATION.claude.togglesAreTheBoundary, true,
    "Claude declares its exact tool set with --tools");
  assert.equal(HARNESS_ISOLATION.codex.togglesAreTheBoundary, false,
    "codex-cli 0.146.0 has no --tools; collaboration.* and web.run survive every switch");
  assert.equal(HARNESS_ISOLATION.claude.stillLoaded.length, 0);
  assert.ok(HARNESS_ISOLATION.codex.stillLoaded.length > 0,
    "what still leaks is named, tool by tool, not summarised away");
  for (const leak of HARNESS_ISOLATION.codex.stillLoaded) {
    assert.ok(leak.name && leak.plainWords && leak.why, "every leak says what it is and why it is still there");
  }
  // the two headlines must not be the same words — that is the whole point
  assert.notEqual(HARNESS_ISOLATION.claude.headline, HARNESS_ISOLATION.codex.headline);
  assert.equal(isolationFor("codex"), HARNESS_ISOLATION.codex);
  assert.equal(isolationFor("mock")?.togglesAreTheBoundary, true, "a mock agent runs no tools at all");
});

test("the report says how high the switches GO, not only what they keep out", () => {
  // Raising the ceiling on 2026-07-30 made "nothing else reaches it" only half
  // the answer. A screen that shows only the reassuring half now understates
  // what he has switched on, which is the same class of lie in reverse.
  for (const report of Object.values(HARNESS_ISOLATION)) {
    assert.ok(report.ceiling, `${report.harness} does not say what its switches can reach`);
    assert.ok(Array.isArray(report.unknowns), `${report.harness} has no place for what we could not settle`);
  }
  assert.match(HARNESS_ISOLATION.claude.ceiling, /running programs/i,
    "Claude's switches can now grant a shell — the report has to say so");
  assert.notEqual(HARNESS_ISOLATION.claude.ceiling, HARNESS_ISOLATION.codex.ceiling);
  // and what we saw but could not settle is written down rather than rounded off
  assert.ok(HARNESS_ISOLATION.claude.unknowns.length > 0,
    "safe-mode still names his plugins; silence about that would be a false 'clean'");
});

test("a harness may not claim the toggles are the boundary while leaking tools", () => {
  // the class rule: the two fields cannot disagree, whoever edits the table next
  for (const report of Object.values(HARNESS_ISOLATION)) {
    assert.equal(report.togglesAreTheBoundary, report.stillLoaded.length === 0,
      `${report.harness} says its toggles are the boundary and still lists leaks`);
    assert.ok(report.measuredOn, `${report.harness} has no evidence date`);
  }
});

test("generalising to Codex never loosened Claude's own isolation", () => {
  const args = claudeArgs(agent({ webSearch: true }));
  assert.ok(args.includes("--tools"), "the declared tool set is still declared");
  for (const flag of CLAUDE_ISOLATION_FLAGS) assert.ok(args.includes(flag));
  assert.ok(!args.some(a => a.startsWith("--disable ")), "and no Codex-shaped flag leaked in");
});
