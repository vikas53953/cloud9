// "USE MY OWN CLAUDE CODE / CODEX SETUP" — his switch, and what it really does.
//
// THE DECISION THIS PINS DOWN. Cloud9's law was that an agent runs in a DECLARED
// environment: no CLAUDE.md, no slash commands, no MCP servers, no plugins, no
// hooks, no auto-memory. Vikas asked, repeatedly, for the opposite on his own
// machine. So it is a SWITCH: on, and the isolation is simply not applied; off,
// and today's exact flag set is still there, flag for flag.
//
// MEASURED LIVE, 2026-08-05, CLI 2.1.222, the same probe twice, differing ONLY
// in these flags (see `ownersetup.ts` for the whole table):
//   switch OFF → CLAUDE.md not loaded, 0 MCP servers, 0 slash commands,
//                6,030-token prompt, "Unknown command: /cloud9probe"
//   switch ON  → CLAUDE.md LOADED (answered the codeword), 17 MCP servers,
//                132 slash commands, 87,498-token prompt, /cloud9probe ran
//
// FOUR THINGS ARE CHECKED HERE AND NOWHERE ELSE:
//   1. ON  → not one isolation flag survives, on EITHER harness.
//   2. OFF → today's exact set survives, on EITHER harness.
//   3. credentials are stripped in BOTH modes — the one thing the switch may
//      never buy.
//   4. both harnesses read the SAME owner, so they can never drift.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentAbilities, AgentDef, NEW_AGENT_USE_OWNER_SETUP, validateAgentInput } from "@cloud9/shared";
import {
  CLAUDE_ISOLATION_ENV, CLAUDE_ISOLATION_FLAGS, ClaudeCliProvider, claudeAbilityFingerprint,
  claudeArgs,
} from "./claude-cli.js";
import {
  CODEX_ALWAYS_DISABLED, CODEX_ISOLATION_FLAGS, CODEX_ISOLATION_PROFILE, codexArgs,
  createCodexIsolatedEnvironment,
} from "./codex.js";
import {
  claudeSetupEnv, claudeSetupFlags, CODEX_NEVER_ENABLED, CODEX_OWNER_SETUP_FEATURES,
  codexSetupFlags, codexUsesDisposableHome, NEVER_INHERITED, OWNER_SETUP_WORDS, setupModeFor,
  usesOwnerSetup,
} from "./ownersetup.js";
import { isolationFor } from "./isolation.js";
import { buildRunRecord } from "./runrecord.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ALL_OFF: AgentAbilities = {
  webSearch: false, files: false, schedules: false, background: false,
};
/** the four rows Codex cannot give up, so a Codex turn is admitted at all */
const CODEX_ADMITTED: Partial<AgentAbilities> = {
  webSearch: true, files: true, helpers: true, commands: true,
};

const agent = (over: Partial<AgentDef> = {}, abilities: Partial<AgentAbilities> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { ...ALL_OFF, ...abilities }, createdAt: 0, ...over,
});

const HIS = (abilities: Partial<AgentAbilities> = {}): AgentDef =>
  agent({ useOwnerSetup: true }, abilities);
const DECLARED = (abilities: Partial<AgentAbilities> = {}): AgentDef =>
  agent({ useOwnerSetup: false }, abilities);

// ---------------------------------------------------------------- the switch

test("absent means OFF — an agent he saved before this existed does not change", () => {
  const old = agent();               // no such field, like his six real agents
  assert.equal(usesOwnerSetup(old), false);
  assert.equal(setupModeFor(old), "declared");
  const args = claudeArgs(old);
  for (const flag of CLAUDE_ISOLATION_FLAGS) {
    assert.ok(args.includes(flag), `an existing agent silently lost ${flag}`);
  }
  // …and a NEW agent is given the answer in writing rather than inheriting it
  // from this absence. That is the whole reason absent can safely mean off.
  assert.equal(NEW_AGENT_USE_OWNER_SETUP, true, "he asked for this four times");
});

test("only a real yes counts — a truthy value is not a decision", () => {
  assert.equal(usesOwnerSetup({ useOwnerSetup: undefined }), false);
  assert.equal(usesOwnerSetup(undefined), false);
  // and a non-boolean is refused at the gate rather than coerced into a yes
  assert.equal(
    validateAgentInput({ name: "Scout", useOwnerSetup: "yes" as unknown as boolean }),
    "whether an agent uses your own setup is a yes/no",
  );
  assert.equal(validateAgentInput({ name: "Scout", useOwnerSetup: true }), null);
});

// ------------------------------------------------------------------- Claude

test("switch OFF: today's exact Claude flag set, flag for flag", () => {
  const args = claudeArgs(DECLARED({ webSearch: true }));
  for (const flag of CLAUDE_ISOLATION_FLAGS) assert.ok(args.includes(flag), `missing ${flag}`);
  assert.ok(args.includes("--strict-mcp-config"), "the owner's 17 connected services");
  assert.ok(args.includes("--disable-slash-commands"), "the owner's 132 slash commands");
  assert.ok(args.includes("--setting-sources"), "the owner's CLAUDE.md and plugins");
  assert.equal(claudeSetupEnv(DECLARED()).CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1",
    "the owner's auto-memory folder, which has no flag");
});

test("switch ON: not one isolation flag survives on the Claude line", () => {
  const args = claudeArgs(HIS({ webSearch: true }));
  for (const flag of CLAUDE_ISOLATION_FLAGS) {
    assert.ok(!args.includes(flag), `${flag} still shut his own setup out`);
  }
  assert.equal(claudeSetupFlags(HIS()).length, 0);
  // …and the environment half of the boundary goes with them, or his saved
  // memory would still be missing while everything else loaded.
  assert.deepEqual(claudeSetupEnv(HIS()), {});
  // WHAT DOES NOT CHANGE: the ability toggles. Measured live on 2026-08-05 with
  // the switch ON — the built-in tool set was still exactly what --tools said.
  const his = claudeArgs(HIS({ webSearch: true }));
  const declared = claudeArgs(DECLARED({ webSearch: true }));
  assert.ok(his.includes("--tools"), "his setup is not a way past the switches");
  const toolsOf = (args: string[]) =>
    args.slice(args.indexOf("--tools") + 1, args.indexOf("--allowed-tools")).join(",");
  assert.equal(toolsOf(his), toolsOf(declared),
    "a switch about whose settings load must not grant or remove one tool");
});

test("the remembered session is dropped when the mode changes", () => {
  // A session opened with his CLAUDE.md, his commands and his servers is not a
  // session the same agent is in after the switch flips. Resuming it would be
  // continuing a conversation the agent was never really part of.
  assert.notEqual(
    claudeAbilityFingerprint(HIS({ webSearch: true })),
    claudeAbilityFingerprint(DECLARED({ webSearch: true })),
  );
});

// -------------------------------------------------------------------- Codex

test("switch OFF: today's exact Codex flags, profile and feature list", () => {
  const args = codexArgs(DECLARED(CODEX_ADMITTED), "C:/data/a1");
  for (const flag of CODEX_ISOLATION_FLAGS) assert.ok(args.includes(flag), `missing ${flag}`);
  assert.ok(args.includes("--ignore-user-config"), "no config.toml: his MCP servers, his policy");
  assert.ok(args.includes("--ignore-rules"), "no execpolicy rules of his");
  const at = args.indexOf("-p");
  assert.ok(at >= 0 && args[at + 1] === CODEX_ISOLATION_PROFILE, "the one-turn skill profile");
  for (const feature of CODEX_ALWAYS_DISABLED) {
    assert.ok(args.includes(feature), `${feature} is a door into his own setup`);
  }
  assert.equal(codexUsesDisposableHome(DECLARED()), true);
});

test("switch ON: his Codex config loads, and the profile that would fail is gone", () => {
  const args = codexArgs(HIS(CODEX_ADMITTED), "C:/data/a1");
  for (const flag of CODEX_ISOLATION_FLAGS) {
    assert.ok(!args.includes(flag), `${flag} still shut his own Codex setup out`);
  }
  // The one-turn profile lives in a throwaway CODEX_HOME that is not created in
  // this mode. Naming it anyway would fail the turn before the model was reached.
  assert.ok(!args.includes(CODEX_ISOLATION_PROFILE), "a profile that does not exist");
  assert.equal(codexUsesDisposableHome(HIS()), false);
  for (const feature of CODEX_OWNER_SETUP_FEATURES) {
    assert.ok(!args.includes(feature), `${feature} is HIS setup and he asked for it`);
  }
});

test("what the switch may never buy: acting as him, at any setting", () => {
  // His signed-in browser and his actual desktop are not configuration. An agent
  // driving them is not using his settings, it is being him — with no approval
  // card in front of it. Off in BOTH modes, on purpose.
  for (const mode of [HIS(CODEX_ADMITTED), DECLARED(CODEX_ADMITTED)]) {
    const args = codexArgs(mode, "C:/data/a1");
    for (const feature of CODEX_NEVER_ENABLED) {
      assert.ok(args.includes("--disable"), "nothing was disabled at all");
      assert.ok(args.includes(feature), `${feature} must be off whatever the switch says`);
    }
  }
  assert.ok(CODEX_NEVER_ENABLED.includes("browser_use"));
  assert.ok(CODEX_NEVER_ENABLED.includes("computer_use"));
});

// ------------------------------------------------- the line that never moves

test("credentials are stripped in BOTH modes — Codex", () => {
  const dirty: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: "sk-ant-should-never-travel",
    OPENAI_API_KEY: "sk-should-never-travel",
    PATH: "/usr/bin",
  };
  for (const who of [HIS(), DECLARED()]) {
    const isolated = createCodexIsolatedEnvironment({ baseEnv: dirty, agent: who });
    try {
      assert.equal(isolated.env.ANTHROPIC_API_KEY, undefined,
        `a ${setupModeFor(who)} turn could bill his Anthropic account`);
      assert.equal(isolated.env.OPENAI_API_KEY, undefined,
        `a ${setupModeFor(who)} turn could bill his OpenAI account`);
      assert.equal(isolated.env.PATH, "/usr/bin", "ordinary variables must still travel");
    } finally {
      isolated.dispose();
    }
  }
  // …and in his-setup mode his REAL Codex home is left exactly where it is,
  // which is the whole mechanism by which his config.toml and AGENTS.md load.
  const his = createCodexIsolatedEnvironment({
    baseEnv: { CODEX_HOME: "C:/Users/v/.codex", USERPROFILE: "C:/Users/v" }, agent: HIS(),
  });
  try {
    assert.equal(his.env.CODEX_HOME, "C:/Users/v/.codex", "his own Codex home");
    assert.equal(his.env.USERPROFILE, "C:/Users/v", "his own profile — both skill roots");
  } finally { his.dispose(); }
  // …while a declared turn still gets a throwaway one that is NOT his.
  const declared = createCodexIsolatedEnvironment({
    baseEnv: { CODEX_HOME: "C:/Users/v/.codex", USERPROFILE: "C:/Users/v" }, agent: DECLARED(),
  });
  try {
    assert.notEqual(declared.env.CODEX_HOME, "C:/Users/v/.codex");
    assert.notEqual(declared.env.USERPROFILE, "C:/Users/v");
  } finally { declared.dispose(); }
});

test("credentials are stripped in BOTH modes — Claude, at the real child", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-ownersetup-"));
  try {
    for (const who of [HIS(), DECLARED()]) {
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
        agent: who, context: "", trigger: "hi", triggerAuthor: "V", kind: "chat",
      });
      assert.ok(seen, "the runner was never given an environment");
      assert.equal(seen!.ANTHROPIC_API_KEY, undefined,
        `a ${setupModeFor(who)} turn could bill his API key`);
      // …and the auto-memory switch follows the mode, at the real child.
      // Compared against the STORED field, never against `usesOwnerSetup` — a
      // test that asks the same function the code asked would agree with any
      // answer, including a broken one.
      assert.equal(
        seen!.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
        who.useOwnerSetup === true
          ? undefined
          : CLAUDE_ISOLATION_ENV.CLAUDE_CODE_DISABLE_AUTO_MEMORY,
      );
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- one owner

test("both harnesses read the SAME owner, so they cannot drift", () => {
  for (const useOwnerSetup of [true, false, undefined]) {
    const who = agent({ useOwnerSetup });
    const claudeIsolated = claudeSetupFlags(who).length > 0;
    const codexIsolated = codexSetupFlags(who).length > 0;
    assert.equal(claudeIsolated, codexIsolated,
      "one harness isolated the owner's setup while the other let it in");
    assert.equal(claudeIsolated, !usesOwnerSetup(who));
    // the environment halves agree with the flag halves, on both sides
    assert.equal(Object.keys(claudeSetupEnv(who)).length > 0, claudeIsolated);
    assert.equal(codexUsesDisposableHome(who), codexIsolated);
  }
});

test("the honest sentence exists, in plain words, and says what it costs", () => {
  assert.ok(OWNER_SETUP_WORDS.label.length > 0);
  assert.ok(/CLAUDE\.md/.test(OWNER_SETUP_WORDS.oneLine), "he is told what actually loads");
  assert.ok(/hook/i.test(OWNER_SETUP_WORDS.cost), "his hooks really running is the honest cost");
  assert.ok(/bigger prompt/i.test(OWNER_SETUP_WORDS.cost), "so is paying for a 14x prompt");
  assert.ok(/API key/i.test(OWNER_SETUP_WORDS.keptBack), "and what is kept back either way");
  // no flag names, no jargon, in anything he reads
  for (const line of Object.values(OWNER_SETUP_WORDS)) {
    assert.ok(!/--[a-z]/.test(line), `a flag name leaked into his sentence: ${line}`);
  }
  assert.equal(NEVER_INHERITED.length, 2, "the two things the switch may never buy");
  for (const kept of NEVER_INHERITED) {
    assert.ok(kept.why.length > 0 && kept.residual.length > 0,
      "a thing we kept back must say WHY, and what is still open");
  }
});

// ------------------------------------------------------------- the record

test("the run record says which mode the turn ran in — including 'no'", () => {
  const seed = {
    kind: "chat" as const, agentId: "a1", agentName: "Scout", provider: "claude",
    requestedBy: "Vikas", requestedByKind: "human" as const, ask: "hello",
    startedAt: 1000,
  };
  const finish = { finishedAt: 2000, outcome: "ok" as const, reply: "hi" };
  assert.equal(buildRunRecord({ ...seed, ownerSetup: true }, finish, "r-1").ownerSetup, true);
  assert.equal(buildRunRecord({ ...seed, ownerSetup: false }, finish, "r-2").ownerSetup, false,
    "'not your setup' is a fact worth recording, not an absence");
  assert.equal(buildRunRecord(seed, finish, "r-3").ownerSetup, undefined,
    "a caller that does not know must not claim either way");
});

// ------------------------------------------------------- the honest screen

test("the reassuring sentence is NOT shown for an agent running in his setup", () => {
  const declared = isolationFor("claude")!;
  const his = isolationFor("claude", "owner")!;
  assert.equal(declared.togglesAreTheBoundary, true, "the declared answer is unchanged");
  assert.equal(declared.stillLoaded.length, 0);
  // …and with his setup loaded the same card must stop promising that.
  assert.equal(his.togglesAreTheBoundary, false,
    "measured 2026-08-05: an agent limited to 3 built-in tools held 127 in his setup");
  assert.notEqual(his.headline, declared.headline);
  const named = his.stillLoaded.map(l => l.name).join(" | ");
  assert.match(named, /connected services/i, "his MCP servers and their tools");
  assert.match(named, /instructions/i, "his CLAUDE.md steering the agent");
  assert.match(named, /hooks/i, "his hook scripts really running");
  // the Codex leaks are still there underneath, not replaced by the new ones
  const codex = isolationFor("codex", "owner")!;
  assert.ok(codex.stillLoaded.length > isolationFor("codex")!.stillLoaded.length);
  // a stand-in agent runs nothing at all, so nothing changes for it either way
  assert.equal(isolationFor("mock", "owner")!.togglesAreTheBoundary, true);
  // and an app nobody measured still gets NO sentence, in both modes
  assert.equal(isolationFor("gemini", "owner"), undefined);
});
