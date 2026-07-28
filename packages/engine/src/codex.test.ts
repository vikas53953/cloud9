// CodexProvider: JSONL transcript parsing and argument building.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentDef } from "@cloud9/shared";
import { CodexProvider, codexArgs, parseCodexJsonl } from "./codex.js";
import { HarnessUnavailableError } from "./provider.js";
import { RunOptions, RunResult, UnsafeArgumentError, run } from "./run.js";

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
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

test("abilities map to the codex sandbox flag", () => {
  const readOnly = codexArgs(agent(), "C:/data/a1");
  assert.ok(readOnly.includes("read-only"));
  assert.ok(!readOnly.includes("workspace-write"));
  const writable = codexArgs(
    agent({ abilities: { webSearch: true, files: true, schedules: false, background: false } }),
    "C:/data/a1",
  );
  assert.ok(writable.includes("workspace-write"));
  // note-mandated flags
  for (const flag of ["exec", "--json", "--skip-git-repo-check", "--ephemeral"]) {
    assert.ok(readOnly.includes(flag), `missing ${flag}`);
  }
  assert.ok(readOnly.join(" ").includes("approval_policy=never"));
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
    await provider.respond({ agent: agent(), context: "", trigger: "hi", triggerAuthor: "V" });
  } finally {
    process.env = before;
  }
  assert.equal(seenEnv.ANTHROPIC_API_KEY, undefined, "another account's key must never pay for a Codex turn");
  assert.equal(seenEnv.GITHUB_TOKEN, undefined, "no ambient secret reaches the child");
  assert.equal(seenEnv.CODEX_API_KEY, "codex-key-123", "Codex's own key still gets through");
  assert.ok(Object.keys(seenEnv).length > 1, "the ordinary environment is still there");
});

test("provider sends the prompt on stdin and returns the reply", async () => {
  let seenStdin = "";
  const provider = new CodexProvider({
    agentDataDir: () => "C:/data/a1",
    runner: fakeRunner({ stdout: TRANSCRIPT }, (_a, o) => { seenStdin = o.stdin ?? ""; }),
  });
  const text = await provider.respond({
    agent: agent(), context: "Vikas: find villas", trigger: "find villas", triggerAuthor: "Vikas",
  });
  assert.equal(text, "Found 3 villas in Goa under 8k.");
  assert.ok(seenStdin.includes("Scout"), "prompt goes on stdin, not argv");
  assert.ok(seenStdin.includes("find villas"));
});

test("a missing codex CLI is a harness problem, not a crash", async () => {
  const provider = new CodexProvider({
    agentDataDir: () => "C:/data/a1",
    runner: fakeRunner({ code: 1, notFound: true, stderr: "'codex' is not recognized" }),
  });
  await assert.rejects(
    () => provider.respond({ agent: agent(), context: "", trigger: "hi", triggerAuthor: "V" }),
    (err: unknown) => err instanceof HarnessUnavailableError && err.harness === "codex",
  );
});

test("a signed-out codex is a harness problem", async () => {
  const provider = new CodexProvider({
    agentDataDir: () => "C:/data/a1",
    runner: fakeRunner({ code: 1, stderr: "Not logged in. Please run `codex login`." }),
  });
  await assert.rejects(
    () => provider.respond({ agent: agent(), context: "", trigger: "hi", triggerAuthor: "V" }),
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
    () => provider.respond({ agent: agent(), context: "", trigger: "hi", triggerAuthor: "V" }),
    /longer than 120s/,
  );
});
