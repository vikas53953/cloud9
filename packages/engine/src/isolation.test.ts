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
import { HarnessAbilityBoundaryError } from "./provider.js";
import { EMPTY_ARG, run, UnsafeArgumentError } from "./run.js";

const ALL_OFF: AgentAbilities = {
  webSearch: false, files: false, schedules: false, background: false,
};
const CODEX_ADMITTED: Partial<AgentAbilities> = {
  webSearch: true, files: true, helpers: true, commands: true,
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
  const at = args.indexOf("--setting-sources");
  assert.ok(at >= 0 && args[at + 1] === EMPTY_ARG,
    "the owner's CLAUDE.md, skills, plugins and hooks — an EMPTY source list");
  // AND THE FLAG THAT MUST NEVER COME BACK. --safe-mode reads like the obvious way
  // to write this line and it is a trap: it kills Cloud9's OWN --mcp-config doorway
  // too (measured 2026-08-05, CLI 2.1.222 — mcp_servers came back []).
  assert.ok(!args.includes("--safe-mode"),
    "--safe-mode silently kills the --mcp-config server below it: no search_conversation, " +
    "no open_attachment, and the connections switch grants nothing");
  assert.ok(args.includes("--strict-mcp-config"), "the owner's connected accounts");
  assert.ok(args.includes("--disable-slash-commands"), "the owner's skills");
});

test("a Codex agent does not load the owner's config or rules either", () => {
  const args = codexArgs(agent(CODEX_ADMITTED), "C:/data/a1");
  for (const flag of CODEX_ISOLATION_FLAGS) assert.ok(args.includes(flag), `missing ${flag}`);
  assert.ok(args.includes("--ignore-user-config"), "no ~/.codex/config.toml: MCP servers, features");
  assert.ok(args.includes("--ignore-rules"), "no user or project execpolicy rules");
  // and only an admitted turn reaches the writable sandbox
  assert.ok(args.includes("workspace-write"));
  assert.throws(() => codexArgs(agent(), "C:/data/a1"), HarnessAbilityBoundaryError);
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
    assert.throws(() => codexArgs(agent(abilities), "C:/data/a1"), HarnessAbilityBoundaryError);
  }
  const codex = codexArgs(agent(CODEX_ADMITTED), "C:/data/a1");
  for (const flag of CODEX_ISOLATION_FLAGS) assert.ok(codex.includes(flag));
});

test("Codex's missing tool declaration is closed by never offering an off that isn't one", () => {
  const args = codexArgs(agent(CODEX_ADMITTED), "C:/data/a1");
  assert.ok(!args.includes("--tools"),
    "codex-cli 0.146.0 has no --tools; if this ever fails, Codex grew one and we should use it");
  for (const ability of ["webSearch", "files", "helpers", "commands"] as const) {
    // On a CODEX agent the switch is not an off at all — the tool is there, so
    // it reads as on and the turn runs (that is `effectiveAbilities`).
    const onCodex = agent({ ...CODEX_ADMITTED, [ability]: false }, { provider: "codex" });
    assert.ok(codexArgs(onCodex, "C:/data/a1").includes("exec"),
      `${ability} off wrongly refused a Codex agent that has the tool anyway`);
    // On an agent whose own app is CLAUDE, the same definition on Codex's line
    // is a real contradiction, and the backstop still stops it.
    assert.throws(
      () => codexArgs(agent({ ...CODEX_ADMITTED, [ability]: false }), "C:/data/a1"),
      HarnessAbilityBoundaryError,
      `${ability} off still admitted Codex's unavoidable tool`,
    );
  }
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
  const args = codexArgs(agent(CODEX_ADMITTED), "C:/data/a1");
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

test("Codex's web-search switch is on only after the web ability admits the turn", () => {
  const on = codexArgs(agent(CODEX_ADMITTED), "C:/data/a1");
  assert.ok(on.includes("tools.web_search=true"), "an agent allowed the web gets the CLI switch on");
  // a Codex agent saved with web off carries web.run anyway, so the switch it
  // is given matches what it really holds rather than a wish
  assert.ok(
    codexArgs(agent({ ...CODEX_ADMITTED, webSearch: false }, { provider: "codex" }), "C:/data/a1")
      .includes("tools.web_search=true"));
  assert.throws(
    () => codexArgs(agent({ ...CODEX_ADMITTED, webSearch: false }), "C:/data/a1"),
    HarnessAbilityBoundaryError,
    "the CLI's ineffective false flag must not be mistaken for a boundary",
  );
});

// --------------------------------------------------------------------------
// The app must be able to TELL THE TRUTH about which harness's toggles are a
// real boundary. A screen that shows the same sentence for both is the bug.

test("the engine can say, per harness, whether the toggles are the boundary", () => {
  assert.equal(HARNESS_ISOLATION.claude.togglesAreTheBoundary, true,
    "Claude declares its exact tool set with --tools");
  assert.equal(HARNESS_ISOLATION.codex.togglesAreTheBoundary, false,
    "Codex still cannot declare a tool set even though unsafe mixes are now refused");
  assert.equal(HARNESS_ISOLATION.claude.stillLoaded.length, 0);
  assert.equal(HARNESS_ISOLATION.codex.stillLoaded.length, 3,
    "the unavoidable built-ins stay named, while the owner-skills leak is gone");
  assert.ok(!HARNESS_ISOLATION.codex.stillLoaded.some(leak => /skill/i.test(leak.name)),
    "owner skills are no longer listed because the isolated profile removes them");
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
    "admin-managed policy settings still apply whatever we pass; silence would be a false 'clean'");
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
