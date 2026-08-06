import { tempDir } from "./tmp-for-tests.js";
// CodexProvider: JSONL transcript parsing and argument building.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef } from "@cloud9/shared";
import {
  CODEX_ISOLATION_PROFILE, CodexProvider, codexAbilityBoundaryProblems, codexArgs,
  createCodexIsolatedEnvironment, parseCodexJsonl,
} from "./codex.js";
import { HarnessAbilityBoundaryError, HarnessUnavailableError, sanitizeForChat } from "./provider.js";
import { TurnTimedOutError } from "./timebudget.js";
import { codexUnavoidableCapabilities, effectiveAbilities } from "./abilities.js";
import { RunOptions, RunResult, UnsafeArgumentError, run } from "./run.js";

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: {
    webSearch: true, files: true, helpers: true, commands: true,
    schedules: false, background: false,
  },
  provider: "codex", createdAt: 0, ...over,
});

/** A real-shaped `codex exec --json` transcript (harness-signin.md §Codex). */
const TRANSCRIPT = [
  `{"type":"thread.started","thread_id":"th_01H9XYZ"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking about villas"}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls"}}`,
  `{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Found 3 villas in Goa under 8k."}}`,
  `{"type":"turn.completed","usage":{"input_tokens":812,"output_tokens":64}}`,
].join("\n");

function fakeRunner(result: Partial<RunResult>, capture?: (a: string[], o: RunOptions) => void) {
  return async (_cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    capture?.(args, opts);
    return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false, ...result };
  };
}

test("parses the final agent_message out of a codex transcript", () => {
  const t = parseCodexJsonl(TRANSCRIPT);
  assert.equal(t.text, "Found 3 villas in Goa under 8k.");
  assert.equal(t.threadId, "th_01H9XYZ");
  assert.equal(t.events, 6);
  assert.equal(t.error, undefined);
});

test("the LAST agent_message wins", () => {
  const t = parseCodexJsonl([
    `{"type":"item.completed","item":{"type":"agent_message","text":"first draft"}}`,
    `{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}`,
  ].join("\n"));
  assert.equal(t.text, "final answer");
});

test("agent_message content blocks are joined", () => {
  const t = parseCodexJsonl(
    `{"type":"item.completed","item":{"type":"agent_message","content":[{"type":"text","text":"a "},{"type":"text","text":"b"}]}}`,
  );
  assert.equal(t.text, "a b");
});

test("non-JSON noise and unknown events are ignored", () => {
  const t = parseCodexJsonl([
    "warming up…",
    "",
    `{"type":"thread.started","thread_id":"th_2"}`,
    "not json {",
    `{"type":"some.future.event","whatever":1}`,
    `{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}`,
  ].join("\r\n"));
  assert.equal(t.text, "ok");
  assert.equal(t.threadId, "th_2");
});

test("turn.failed is surfaced as an error", () => {
  const t = parseCodexJsonl(`{"type":"turn.failed","message":"model refused"}`);
  assert.equal(t.error, "model refused");
  assert.equal(t.text, "");
});

/* ---------------------------------------------------------------------------
 * THE BUG (2026-08-01). Every Codex agent Vikas had saved before the
 * fail-closed rule landed refused to run, for good: "Codex did not start
 * because Get help from its own helper agents, Run programs on this computer
 * are switched off, but this harness cannot remove the matching built-in
 * tools." The app was holding a configuration the engine would ALWAYS refuse.
 *
 * The class fix is that the app no longer represents that state. An agent whose
 * app is Codex HAS those tools, so `effectiveAbilities` says so and everything
 * — command line, prompt, ladder, screen — reads that one answer. Nothing in
 * the database was rewritten: the switches he stored are still his, and moving
 * the agent back to Claude gives them back.
 */

test("a Codex agent saved with the unremovable switches off still runs, with them on", () => {
  const unavoidable = ["webSearch", "files", "helpers", "commands"] as const;
  for (const ability of unavoidable) {
    // exactly the shape of the agents he already had saved
    const legacy = agent({ abilities: { ...agent().abilities, [ability]: false } });

    assert.equal(effectiveAbilities(legacy)[ability], true,
      `${ability} is real on Codex however this agent was saved`);
    assert.equal(legacy.abilities[ability], false,
      "and what he stored is left exactly as he stored it");

    // the refusal that made these agents useless is gone
    const args = codexArgs(legacy, "C:/data/a1");
    assert.ok(args.includes("exec"), `${ability} off still refused the whole turn`);
    assert.ok(args.includes("workspace-write"),
      "a Codex agent can write in its own folder — apply_patch is there regardless");
  }
});

test("the same switches, stored on a Claude agent, are left alone", () => {
  const claude = agent({ provider: "claude", abilities: { ...agent().abilities, commands: false } });
  assert.equal(effectiveAbilities(claude).commands, false,
    "Claude declares its tool set with --tools, so an off switch really does remove the tool");
  assert.deepEqual(effectiveAbilities(claude), claude.abilities);
});

test("the boundary error still fires for a definition that bypassed the helper", async () => {
  // an agent whose OWN app is not Codex, put on the Codex command line: the
  // switches and the harness genuinely contradict each other, so the turn stops
  const bypass = agent({ provider: "claude", abilities: { ...agent().abilities, commands: false } });
  assert.ok(codexAbilityBoundaryProblems(bypass).some(problem => problem.ability === "commands"),
    "the backstop must still be able to name the contradiction");
  assert.throws(() => codexArgs(bypass, "C:/data/a1"), HarnessAbilityBoundaryError);

  let ran = false;
  const provider = new CodexProvider({
    agentDataDir: () => "C:/data/a1",
    runner: fakeRunner({ stdout: TRANSCRIPT }, () => { ran = true; }),
  });
  let refusal: unknown;
  try {
    await provider.respond({
      agent: bypass, context: "", trigger: "hi", triggerAuthor: "V", kind: "chat",
    });
  } catch (err) {
    refusal = err;
  }
  assert.ok(refusal instanceof HarnessAbilityBoundaryError);
  const realError = console.error;
  let reply = "";
  console.error = () => { /* expected refusal stays quiet in this test */ };
  try {
    reply = sanitizeForChat(refusal, "Codex turn");
  } finally {
    console.error = realError;
  }
  assert.match(reply, /run programs.*switched off/i);
  assert.equal(ran, false, "and the Codex process never started");
});

test("an admitted Codex turn still maps the files switch to a writable sandbox", () => {
  const writable = codexArgs(agent(), "C:/data/a1");
  assert.ok(writable.includes("workspace-write"));
  assert.deepEqual(writable.slice(writable.indexOf("-p"), writable.indexOf("-p") + 2),
    ["-p", CODEX_ISOLATION_PROFILE], "the per-turn profile disables owner skills by exact path");
  // note-mandated flags
  for (const flag of ["exec", "--json", "--skip-git-repo-check", "--ephemeral"]) {
    assert.ok(writable.includes(flag), `missing ${flag}`);
  }
  assert.ok(writable.join(" ").includes("approval_policy=never"));
});

// --- security review 2026-07-29, finding #4 ---
//
// The test this replaces asserted that codexArgs QUOTED the path itself. That
// was the bug written down as a rule: run() then re-checked the argument, saw
// the quote characters, and refused the whole command — so every Codex turn
// failed for anyone whose folder has a space in it. Quoting has one owner, and
// the only honest way to prove it is to push the argv through run() for real.
test("codexArgs hands over the plain path — it never pre-quotes", () => {
  const args = codexArgs(agent(), "C:/Users/Vik As/data");
  assert.ok(args.includes("C:/Users/Vik As/data"), "the raw path is passed through");
  assert.ok(!args.some(a => a.includes('"')), "no argument carries quote characters");
});

test("a Codex turn survives a user folder with a space in it, end to end through run()", async () => {
  const spaced = process.platform === "win32"
    ? "C:/Users/Vik As/cloud9-engine-data/agents/a1"
    : "/home/vik as/cloud9-engine-data/agents/a1";
  // the REAL run(), so the real argument checker gets a look at the real argv.
  // A command that does not exist is fine: we only care that run() agreed to
  // build the command line at all. Before the fix this rejected with
  // UnsafeArgumentError and the agent posted that error into the chat forever.
  const result = await run("cloud9-no-such-command-9x", codexArgs(agent(), spaced), {
    cwd: process.cwd(), timeoutMs: 15_000,
  });
  assert.equal(result.notFound, true, "it tried to run, and only failed on the missing command");
});

test("a path run() would refuse is still refused — the leash did not loosen", async () => {
  await assert.rejects(
    () => run("cloud9-no-such-command-9x", codexArgs(agent(), "C:/data/a1 && calc"), {}),
    (err: unknown) => err instanceof UnsafeArgumentError,
  );
});

test("the codex turn never inherits ambient credentials", async () => {
  let seenEnv: NodeJS.ProcessEnv = {};
  const provider = new CodexProvider({
    agentDataDir: () => "C:/data/a1",
    apiKey: () => "codex-key-123",
    runner: fakeRunner({ stdout: TRANSCRIPT }, (_a, o) => { seenEnv = o.env ?? {}; }),
  });
  const before = { ...process.env };
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-travel";
  process.env.GITHUB_TOKEN = "ghp-should-not-travel";
  try {
    await provider.respond({ agent: agent(), context: "", trigger: "hi", triggerAuthor: "V", kind: "chat" });
  } finally {
    process.env = before;
  }
  assert.equal(seenEnv.ANTHROPIC_API_KEY, undefined, "another account's key must never pay for a Codex turn");
  assert.equal(seenEnv.GITHUB_TOKEN, undefined, "no ambient secret reaches the child");
  assert.equal(seenEnv.CODEX_API_KEY, "codex-key-123", "Codex's own key still gets through");
  assert.ok(Object.keys(seenEnv).length > 1, "the ordinary environment is still there");
});

test("a Codex turn gets clean homes with auth but none of the owner's skills", () => {
  const ownerCodexHome = tempDir("cloud9-owner-codex-");
  const ownerProfile = tempDir("cloud9-owner-profile-");
  fs.mkdirSync(path.join(ownerCodexHome, "skills", "owner"), { recursive: true });
  fs.mkdirSync(path.join(ownerProfile, ".agents", "skills", "shared"), { recursive: true });
  fs.mkdirSync(path.join(ownerProfile, "linked-skill"), { recursive: true });
  fs.writeFileSync(path.join(ownerCodexHome, "auth.json"), "{\"tokens\":\"owner login\"}");
  fs.writeFileSync(path.join(ownerCodexHome, "skills", "owner", "SKILL.md"), "must not load");
  fs.writeFileSync(path.join(ownerProfile, ".agents", "skills", "shared", "SKILL.md"), "must not load");
  fs.writeFileSync(path.join(ownerProfile, "linked-skill", "SKILL.md"), "must not load either");
  fs.symlinkSync(
    path.join(ownerProfile, "linked-skill"),
    path.join(ownerProfile, ".agents", "skills", "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const isolated = createCodexIsolatedEnvironment({
    baseEnv: { PATH: process.env.PATH, HOME: ownerProfile, USERPROFILE: ownerProfile },
    ownerCodexHome,
    ownerUserHome: ownerProfile,
  });
  const isolatedRoot = path.dirname(isolated.env.CODEX_HOME!);
  try {
    assert.notEqual(isolated.env.CODEX_HOME, ownerCodexHome);
    assert.notEqual(isolated.env.HOME, ownerProfile);
    assert.notEqual(isolated.env.USERPROFILE, ownerProfile);
    assert.equal(fs.readFileSync(path.join(isolated.env.CODEX_HOME!, "auth.json"), "utf8"),
      "{\"tokens\":\"owner login\"}", "the CLI login survives in the isolated home");
    assert.equal(fs.existsSync(path.join(isolated.env.CODEX_HOME!, "skills")), false,
      "$CODEX_HOME/skills is absent");
    assert.equal(fs.existsSync(path.join(isolated.env.HOME!, ".agents", "skills")), false,
      "~/.agents/skills is absent");
    const profile = fs.readFileSync(
      path.join(isolated.env.CODEX_HOME!, `${CODEX_ISOLATION_PROFILE}.config.toml`), "utf8");
    assert.match(profile, /enabled = false/);
    assert.match(profile, /skills\/owner\/SKILL[.]md/);
    assert.match(profile, /skills\/shared\/SKILL[.]md/);
    assert.match(profile, /skills\/linked\/SKILL[.]md/, "symlinked owner skills are disabled too");
  } finally {
    isolated.dispose();
    fs.rmSync(ownerCodexHome, { recursive: true, force: true });
    fs.rmSync(ownerProfile, { recursive: true, force: true });
  }
  assert.equal(fs.existsSync(isolatedRoot), false, "the copied login is removed after the turn");
});

test("provider sends the prompt on stdin and returns the reply", async () => {
  let seenStdin = "";
  const provider = new CodexProvider({
    agentDataDir: () => "C:/data/a1",
    runner: fakeRunner({ stdout: TRANSCRIPT }, (_a, o) => { seenStdin = o.stdin ?? ""; }),
  });
  const text = await provider.respond({
    agent: agent(), context: "Vikas: find villas", trigger: "find villas", triggerAuthor: "Vikas", kind: "chat",
  });
  assert.equal(text, "Found 3 villas in Goa under 8k.");
  assert.ok(seenStdin.includes("Scout"), "prompt goes on stdin, not argv");
  assert.ok(seenStdin.includes("find villas"));
  assert.ok(!seenStdin.includes("no tools at all beyond the ones listed above"),
    "Codex's prompt must not claim its undeclarable built-ins are absent");
  assert.match(seenStdin, /Codex cannot give up these built-in tools/i);
  for (const cap of codexUnavoidableCapabilities()) {
    assert.ok(seenStdin.includes(cap.can),
      `${String(cap.ability)} is real on Codex, so the agent must be told it CAN`);
  }
});

test("a missing codex CLI is a harness problem, not a crash", async () => {
  const provider = new CodexProvider({
    agentDataDir: () => "C:/data/a1",
    runner: fakeRunner({ code: 1, notFound: true, stderr: "'codex' is not recognized" }),
  });
  await assert.rejects(
    () => provider.respond({ agent: agent(), context: "", trigger: "hi", triggerAuthor: "V", kind: "chat" }),
    (err: unknown) => err instanceof HarnessUnavailableError && err.harness === "codex",
  );
});

test("a signed-out codex is a harness problem", async () => {
  const provider = new CodexProvider({
    agentDataDir: () => "C:/data/a1",
    runner: fakeRunner({ code: 1, stderr: "Not logged in. Please run `codex login`." }),
  });
  await assert.rejects(
    () => provider.respond({ agent: agent(), context: "", trigger: "hi", triggerAuthor: "V", kind: "chat" }),
    (err: unknown) => err instanceof HarnessUnavailableError,
  );
});

test("a timeout is reported in plain words", async () => {
  const provider = new CodexProvider({
    agentDataDir: () => "C:/data/a1",
    timeoutMs: 120_000,
    runner: fakeRunner({ code: null, timedOut: true }),
  });
  await assert.rejects(
    () => provider.respond({ agent: agent(), context: "", trigger: "hi", triggerAuthor: "V", kind: "chat" }),
    // minutes, not seconds, and it names the clock — see timebudget.ts
    (err: unknown) => err instanceof TurnTimedOutError && /2 minutes/.test(err.message),
  );
});
