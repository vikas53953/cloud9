// THE CEILING. Vikas, 2026-07-30: "these agents are fully agentic and using the
// harness from claude and codex, they already have access to everything…
// whatever functions we have as codex and claude code on my system, every
// functionality should be replicated."
//
// The day before, the switches were made a real boundary — and the boundary was
// set too low: `Bash` was refused on every path for every agent, so no switch he
// could ever set would let an agent run a program on his own computer. Both
// facts are right. These tests pin the reconciliation:
//
//   the switches STAY the boundary,     (isolation.test.ts still passes)
//   his own dev setup STAYS out,        (safe-mode / strict-mcp / ignore-config)
//   but the switches can now reach the CLI's FULL surface,
//   and everything that changes the machine or spends money ASKS FIRST.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentAbilities, AgentDef } from "@cloud9/shared";
import {
  CAPABILITIES, CLAUDE_BUILTIN_TOOLS, REACH_LEVELS, abilitiesForReach, alwaysAskAbilities,
  approvalsFor, claudeToolsFor, deniedClaudeTools, codexSandboxFor,
  needsApprovalToRun, renderCapabilities,
} from "./abilities.js";
import { claudeArgs, CLAUDE_ISOLATION_FLAGS } from "./claude-cli.js";
import { codexArgs, CODEX_ALWAYS_DISABLED, codexDisabledFeaturesFor } from "./codex.js";
import { buildAgentPrompt } from "./provider.js";
import { aTurn } from "./turnfixture.js";

const ALL_OFF: AgentAbilities = {
  webSearch: false, files: false, schedules: false, background: false,
};

const agent = (abilities: Partial<AgentAbilities> = {}, over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { ...ALL_OFF, ...abilities }, createdAt: 0, ...over,
});

/** the top rung, with the approvals it forces already granted */
const maxed = () => agent(abilitiesForReach("computer"));

// ------------------------------------------------------- the ceiling is lifted

test("running a program is a CHOICE now, not a refusal on every path", () => {
  // the exact thing that was impossible yesterday
  const worker = agent({ commands: true });
  const tools = claudeToolsFor(worker);
  assert.ok(tools.includes("Bash"), "Bash must be grantable — that is the ceiling he asked us to lift");
  assert.ok(tools.includes("PowerShell"),
    "on Windows the CLI ships PowerShell as its OWN tool; granting Bash alone is a half-measure");

  const args = claudeArgs(worker);
  const at = args.indexOf("--tools");
  const declared = args.slice(at + 1).filter((a, i, all) => all.slice(0, i + 1).every(x => !x.startsWith("--")));
  assert.ok(declared.includes("Bash"), "and it reaches the real command line");

  // and it is still refused for an agent that was not given it
  assert.ok(!claudeToolsFor(agent()).includes("Bash"));
  assert.ok(deniedClaudeTools(agent()).includes("Bash"));
});

test("the top rung grants every tool the installed CLI actually has", () => {
  const granted = new Set(claudeToolsFor(maxed()));
  const missing = CLAUDE_BUILTIN_TOOLS.filter(t => !granted.has(t));
  assert.deepEqual(missing, [],
    "'everything this app can do on this computer' must mean every built-in tool, not a curated subset");
  assert.deepEqual(deniedClaudeTools(maxed()), [], "and nothing left over to deny");
});

test("no row may name a tool this CLI does not have — a typo is silently ignored by the CLI", () => {
  // measured: `claude -p --tools NotARealToolXYZ` exits 0 and answers. An unknown
  // name is not an error, it is a capability that quietly never arrives.
  for (const cap of CAPABILITIES) {
    for (const tool of cap.claudeTools) {
      assert.ok((CLAUDE_BUILTIN_TOOLS as readonly string[]).includes(tool),
        `"${cap.ability}" grants "${tool}", which claude-code 2.1.220 does not have`);
    }
  }
});

// ------------------------------------------------- a ladder a non-developer reads

test("the choices are a ladder: each rung is everything below it, plus more", () => {
  const names = REACH_LEVELS.map(l => l.level);
  assert.deepEqual(names, ["talk", "look", "work", "computer"]);
  let previous: string[] = [];
  for (const level of REACH_LEVELS) {
    const on = Object.entries(abilitiesForReach(level.level))
      .filter(([, v]) => v === true).map(([k]) => k).sort();
    for (const below of previous) {
      assert.ok(on.includes(below), `"${level.level}" drops "${below}" from the rung below it`);
    }
    assert.ok(level.label && level.plainWords, `"${level.level}" has no words for a non-developer`);
    previous = on;
  }
  assert.deepEqual(Object.entries(abilitiesForReach("talk")).filter(([, v]) => v), [],
    "the bottom rung is answer-questions-only: no tools at all");
});

test("every switch in the table is reachable from some rung, and the top has them all", () => {
  const top = abilitiesForReach("computer");
  for (const cap of CAPABILITIES) {
    assert.equal(top[cap.ability], true, `"${cap.ability}" is unreachable — the top rung does not turn it on`);
  }
});

// ----------------------------------------------------------- ask first, always

test("a switch that changes the machine or spends money forces the owner's approval ON", () => {
  const dangerous = alwaysAskAbilities();
  assert.ok(dangerous.includes("commands"), "running programs changes the machine");
  assert.ok(dangerous.includes("wholeComputer"), "writing outside its own folder changes the machine");

  for (const ability of dangerous) {
    const on = agent({ [ability]: true }, { approvals: { background: false, schedules: false } });
    const approvals = approvalsFor(on);
    assert.equal(approvals[ability as keyof typeof approvals], true,
      `"${ability}" is switched on and the owner is NOT asked first`);
    assert.equal(needsApprovalToRun(on), true);
  }
  // and an agent holding none of them is not nagged
  assert.equal(needsApprovalToRun(agent({ webSearch: true, files: true })), false);
});

test("the ask cannot be switched off from a stored agent definition", () => {
  // a client that sends approvals:{commands:false} must not get a silent machine
  const forged = agent({ commands: true }, {
    approvals: { background: false, schedules: false, commands: false } as never,
  });
  assert.equal(approvalsFor(forged).commands, true,
    "'ask first' is the honest guard — it is not something the stored definition can drop");
});

test("the harmless switches are NOT made to ask — the guard stays meaningful", () => {
  const safe = agent({ webSearch: true, files: true, helpers: true });
  const approvals = approvalsFor(safe);
  assert.equal(approvals.commands, false);
  assert.equal(approvals.wholeComputer, false);
});

test("an unattended job for an agent that can change the machine is ALWAYS asked about", () => {
  // The two unattended paths — a background job and a repeating check-in — are
  // where nobody is watching. `needsApprovalToRun` is what the engine asks on
  // both, so a dangerous agent cannot be handed a standing order quietly.
  const dangerous = agent({ commands: true }, {
    approvals: { background: false, schedules: false },
  });
  assert.equal(needsApprovalToRun(dangerous), true);
  assert.equal(approvalsFor(dangerous).background, false,
    "his own choice about ordinary background jobs is left alone…");
  assert.equal(approvalsFor(dangerous).commands, true,
    "…and the dangerous power still asks, which is what the engine ORs in");
});

// ------------------------------------------- the agent is told the same story

test("an agent that CAN run programs is never told it cannot", () => {
  const prompt = buildAgentPrompt(agent({ commands: true }), aTurn(""));
  assert.ok(!/CANNOT run commands/i.test(prompt),
    "the old blanket sentence would tell a shell-enabled agent it has no shell");
  assert.match(prompt, /You CAN run programs/);
  // and it is told the ask exists, so it does not promise instant action
  assert.match(prompt, /ask(s|ed)? .*(owner|first)/i);
});

test("an agent that cannot run programs is still told so, plainly", () => {
  assert.match(buildAgentPrompt(agent(), aTurn("")), /CANNOT run programs/);
});

test("every row still has two faces: the tools and the words move together", () => {
  for (const cap of CAPABILITIES) {
    // supplied, because this test is about the SWITCH — see gap-audit.test.ts
    // for the case where the switch is on and the launcher hands over nothing.
    const supply = {
      wholeComputerRoots: ["C:\\Users\\Vikas\\Documents"],
      mcpConfigPath: "C:\\Users\\Vikas\\AppData\\cloud9\\mcp.json",
    };
    const on = buildAgentPrompt(agent({ [cap.ability]: true }), aTurn("", { supply }));
    const off = buildAgentPrompt(agent(), aTurn("", { supply }));
    assert.ok(on.includes(cap.can), `"${cap.ability}" on: not told it CAN`);
    assert.ok(off.includes(cap.cannot), `"${cap.ability}" off: not told it CANNOT`);
    for (const tool of cap.claudeTools) {
      assert.ok(claudeToolsFor(agent({ [cap.ability]: true })).includes(tool));
      assert.ok(!claudeToolsFor(agent()).includes(tool));
    }
  }
});

test("the blanket 'no tools beyond this list' promise is still made and still true", () => {
  const prompt = renderCapabilities(maxed());
  assert.match(prompt, /no tools at all beyond the ones listed above/);
  assert.deepEqual(deniedClaudeTools(maxed()), []);
});

// ------------------------------- raising the ceiling did not open HIS dev setup

test("at maximum reach the owner's own setup is still shut out", () => {
  const args = claudeArgs(maxed());
  for (const flag of CLAUDE_ISOLATION_FLAGS) {
    assert.ok(args.includes(flag), `${flag} was traded away for the raised ceiling`);
  }
  assert.ok(args.includes("--safe-mode"), "his CLAUDE.md, plugins and hooks");
  assert.ok(args.includes("--strict-mcp-config"), "his connected accounts");
  assert.ok(args.includes("--disable-slash-commands"), "his slash commands");
  // no path adds his config back
  assert.ok(!args.includes("--setting-sources"));
  assert.ok(!args.includes("--plugin-dir"));
  assert.ok(!args.includes("--add-dir") || args.includes("--safe-mode"));
});

test("connections never load the owner's MCP servers — only ones passed for this agent", () => {
  const chosen = "C:/cloud9/agents/a1/mcp.json";
  const withServers = claudeArgs(maxed(), [], { mcpConfigPath: chosen });
  assert.ok(withServers.includes("--mcp-config"), "a server chosen FOR this agent is passed in");
  assert.ok(withServers.includes(chosen));
  assert.ok(withServers.includes("--strict-mcp-config"),
    "and strict stays on, so only that one exists — never his");
  // and with the switch on but nothing chosen, no config is invented
  assert.ok(!claudeArgs(maxed()).includes("--mcp-config"));
  // and never when the switch is off
  assert.ok(!claudeArgs(agent(), [], { mcpConfigPath: chosen }).includes("--mcp-config"),
    "handing a config to an agent whose owner did not switch connections on must do nothing");
});

test("reaching outside its own folder is an explicit --add-dir, never the default", () => {
  const roots = ["C:/Users/vikasmit/projects"];
  assert.ok(!claudeArgs(agent({ files: true }), [], { wholeComputerRoots: roots }).includes("--add-dir"),
    "the files switch alone stays inside the agent's own folder");
  const wide = claudeArgs(agent({ files: true, wholeComputer: true }), [], { wholeComputerRoots: roots });
  assert.ok(wide.includes("--add-dir"));
  assert.ok(wide.includes(roots[0]));
});

// ------------------------------------------------------------- the Codex half

test("Codex's sandbox opens only as far as the switches say", () => {
  assert.equal(codexSandboxFor(agent()), "read-only");
  assert.equal(codexSandboxFor(agent({ files: true })), "workspace-write");
  assert.equal(codexSandboxFor(maxed()), "workspace-write",
    "even at full reach the sandbox is a real fence — danger-full-access is never chosen for him");
  assert.ok(!codexArgs(maxed(), "C:/data/a1").includes("danger-full-access"));
  assert.ok(!codexArgs(maxed(), "C:/data/a1").includes("--dangerously-bypass-approvals-and-sandbox"));
});

test("Codex sub-agents follow the helpers switch, and his own setup stays off regardless", () => {
  const plain = codexDisabledFeaturesFor(agent());
  const helping = codexDisabledFeaturesFor(agent({ helpers: true }));
  assert.ok(plain.includes("multi_agent"), "an agent not given helpers is not handed sub-agents on purpose");
  assert.ok(!helping.includes("multi_agent"), "and one that IS given helpers keeps them");
  for (const always of CODEX_ALWAYS_DISABLED) {
    assert.ok(plain.includes(always) && helping.includes(always),
      `${always} is the owner's own setup and must be off at every reach`);
  }
  const args = codexArgs(maxed(), "C:/data/a1");
  assert.ok(args.includes("--ignore-user-config") && args.includes("--ignore-rules"),
    "full reach still does not mean his config");
});
