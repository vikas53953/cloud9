// Running an agent turn on the local Claude app's own login — the primary path
// after feedback round 1. Nothing here may involve a token.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentDef } from "@cloud9/shared";
import {
  ClaudeCliProvider, CREDENTIAL_ENV_VARS, claudeArgs, envWithoutCredentials, parseClaudeJson,
} from "./claude-cli.js";
import { CLAUDE_BUILTIN_TOOLS, deniedClaudeTools } from "./abilities.js";
import { HarnessUnavailableError } from "./provider.js";
import { EMPTY_ARG, RunOptions, RunResult, UnsafeArgumentError } from "./run.js";

const CLAUDE_MODELS = ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5-20251001"];

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
  model: "claude-sonnet-5", createdAt: 0, ...over,
});

/** A fake `run` that records what it was asked to do. */
function fakeRunner(result: Partial<RunResult> = {}) {
  const calls: { cmd: string; args: string[]; opts: RunOptions }[] = [];
  const runner = async (cmd: string, args: string[], opts: RunOptions = {}) => {
    calls.push({ cmd, args, opts });
    return {
      code: 0, stdout: `{"type":"result","subtype":"success","is_error":false,"result":"ready"}`,
      stderr: "", timedOut: false, notFound: false, ...result,
    };
  };
  return { calls, runner };
}

const provider = (runner: ReturnType<typeof fakeRunner>["runner"]) =>
  new ClaudeCliProvider({
    agentDataDir: () => process.cwd(),
    runner,
    models: () => CLAUDE_MODELS,
  });

test("the real CLI envelope is parsed down to the reply text", () => {
  const real = `{"is_error":false,"num_turns":1,"session_id":"2ae1","subtype":"success",` +
    `"result":"ready","type":"result","duration_ms":7350}`;
  assert.deepEqual(parseClaudeJson(real), { text: "ready" });
});

test("a failed turn is read from the envelope, not from what the model said", () => {
  // the model merely TALKING about an error must not be treated as one
  assert.deepEqual(
    parseClaudeJson(`{"subtype":"success","is_error":false,"result":"is_error means failure"}`),
    { text: "is_error means failure" },
  );
  const failed = parseClaudeJson(`{"subtype":"success","is_error":true,"result":"rate limited"}`);
  assert.equal(failed.error, "rate limited");
});

test("garbage from the CLI is reported, never guessed at", () => {
  assert.match(parseClaudeJson("").error ?? "", /returned nothing/);
  assert.match(parseClaudeJson("{not json}").error ?? "", /couldn't read/);
});

test("no credential variable survives into a CLI-login turn", () => {
  const base = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-ant-should-not-be-here",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-user-should-not-be-here",
    ANTHROPIC_AUTH_TOKEN: "nope",
    ANTHROPIC_BASE_URL: "https://elsewhere.example",
  };
  const env = envWithoutCredentials(base);
  for (const key of CREDENTIAL_ENV_VARS) assert.equal(env[key], undefined);
  assert.equal(env.PATH, "/usr/bin");
  assert.ok(!JSON.stringify(env).includes("sk-"));
});

test("abilities become tools, and everything not switched on is refused by name", () => {
  const plain = claudeArgs(agent(), CLAUDE_MODELS);
  // stream-json, not json: the streamed form is a superset — same final result
  // envelope, preceded by one line per tool call, which is the run record.
  // The isolation flags and the declared (here empty) tool set are not optional
  // extras — see CLAUDE_ISOLATION_FLAGS and isolation.test.ts.
  assert.deepEqual(plain.slice(0, 13), [
    "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk",
    "--safe-mode", "--strict-mcp-config", "--disable-slash-commands",
    "--model", "claude-sonnet-5",
    "--tools", EMPTY_ARG,
  ]);
  // and then every built-in tool this agent was not given, spelled out. Until
  // 2026-07-30 this was the hand-written list ["Bash"], which both promised
  // something we no longer mean ("no agent may EVER run a command") and missed
  // PowerShell — measured that day as its own separate tool on this machine.
  assert.equal(plain[13], "--disallowed-tools");
  assert.deepEqual(plain.slice(14), [...CLAUDE_BUILTIN_TOOLS]);
  assert.ok(plain.includes("Bash") && plain.includes("PowerShell"));

  const full = claudeArgs(agent({
    abilities: { webSearch: true, files: true, schedules: false, background: false },
  }), CLAUDE_MODELS);
  assert.ok(full.includes("WebSearch"));
  assert.ok(full.includes("Read"));
  const at = full.indexOf("--disallowed-tools");
  assert.ok(at > 0);
  assert.deepEqual(full.slice(at + 1), deniedClaudeTools(agent({
    abilities: { webSearch: true, files: true, schedules: false, background: false },
  })));
  assert.ok(full.slice(at + 1).includes("Bash"), "still refused — because he did not switch it on");
});

test("a model id that isn't on the harness's real list never becomes a command line", () => {
  assert.throws(
    () => claudeArgs(agent({ model: "claude-totally-made-up" }), CLAUDE_MODELS),
    /isn't one this app offers/,
  );
  // and the shape guard still stands on its own when the list is unknown
  assert.throws(
    () => claudeArgs(agent({ model: "claude-sonnet-5 && calc.exe" }), []),
    /valid model id/,
  );
});

test("the prompt travels on stdin and never in the argument list", async () => {
  const { calls, runner } = fakeRunner();
  await provider(runner).respond({
    agent: agent(), context: "Vikas: hi there", trigger: "hi there", triggerAuthor: "Vikas", kind: "chat",
  });
  const call = calls[0];
  assert.equal(call.cmd, "claude");
  assert.match(call.opts.stdin ?? "", /Vikas: hi there/);
  assert.ok(!call.args.some(a => a.includes("hi there")), "no prompt text in argv");
  for (const key of CREDENTIAL_ENV_VARS) assert.equal(call.opts.env?.[key], undefined);
});

test("a missing Claude app becomes 'my engine isn't connected', not a stack trace", async () => {
  const { runner } = fakeRunner({ notFound: true, code: null });
  await assert.rejects(
    () => provider(runner).respond({ agent: agent(), context: "", trigger: "hi", triggerAuthor: "V", kind: "chat" }),
    (err: unknown) => err instanceof HarnessUnavailableError,
  );
});

test("only the CLI's own complaint counts as signed out", async () => {
  const signedOut = fakeRunner({
    code: 1, stdout: "", stderr: "Invalid API key · Please run `claude login`",
  });
  await assert.rejects(
    () => provider(signedOut.runner).respond({ agent: agent(), context: "", trigger: "h", triggerAuthor: "V", kind: "chat" }),
    (err: unknown) => err instanceof HarnessUnavailableError,
  );

  // a successful turn whose TEXT mentions logging in is a normal reply
  const chatty = fakeRunner({
    code: 0,
    stdout: `{"subtype":"success","is_error":false,"result":"You should run claude login first"}`,
  });
  const said = await provider(chatty.runner).respond({
    agent: agent(), context: "", trigger: "h", triggerAuthor: "V", kind: "chat",
  });
  assert.equal(said, "You should run claude login first");
});

test("a turn that blows the leash is stopped and explained in plain words", async () => {
  const { runner } = fakeRunner({ timedOut: true, code: null, stdout: "" });
  await assert.rejects(
    () => new ClaudeCliProvider({
      agentDataDir: () => process.cwd(), runner, timeoutMs: 1_000, models: () => CLAUDE_MODELS,
    }).respond({ agent: agent(), context: "", trigger: "h", triggerAuthor: "V", kind: "chat" }),
    /longer than 1s/,
  );
});

test("an agent whose name carries shell characters still cannot reach a shell", async () => {
  const { runner } = fakeRunner();
  // the name is prompt text (stdin), never argv — but the model id IS argv
  await assert.rejects(
    () => provider(runner).respond({
      agent: agent({ model: "claude-sonnet-5; shutdown" }),
      context: "", trigger: "h", triggerAuthor: "V", kind: "chat",
    }),
    (err: unknown) => err instanceof UnsafeArgumentError || /model id|isn't one this app/.test(String(err)),
  );
});
