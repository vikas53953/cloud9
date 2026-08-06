import { tempDir } from "./tmp-for-tests.js";
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
import { TurnTimedOutError } from "./timebudget.js";
import { EMPTY_ARG, RunOptions, RunResult, UnsafeArgumentError } from "./run.js";
import { OpenTurn, ToolBridge } from "./toolbridge.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  assert.deepEqual(plain.slice(0, 14), [
    "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk",
    "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", EMPTY_ARG,
    "--model", "claude-sonnet-5",
    "--tools", EMPTY_ARG,
  ]);
  // and then every built-in tool this agent was not given, spelled out. Until
  // 2026-07-30 this was the hand-written list ["Bash"], which both promised
  // something we no longer mean ("no agent may EVER run a command") and missed
  // PowerShell — measured that day as its own separate tool on this machine.
  assert.equal(plain[14], "--disallowed-tools");
  assert.deepEqual(plain.slice(15), [...CLAUDE_BUILTIN_TOOLS]);
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
      agentDataDir: () => process.cwd(), runner, timeoutMs: 60_000, models: () => CLAUDE_MODELS,
    }).respond({ agent: agent(), context: "", trigger: "h", triggerAuthor: "V", kind: "chat" }),
    // it says a CLOCK ran out, and how long it was given — see timebudget.ts.
    // The old sentence ("took longer than 60s") named seconds and a harness and
    // was then thrown away by `sanitizeForChat` before anybody read it.
    //
    // GAP A (2026-08-05): the words changed and the guard did not. It used to
    // say "this was taking too long for a chat reply", which blamed the turn —
    // and measurement showed the turn was usually WORKING, on a slow machine,
    // when we killed it. It now says how long it was given and that it was
    // working; what this test holds is unchanged: a recognisable timeout, and
    // the number said in minutes.
    //
    // 2026-08-07: the words changed again and the guard is still unchanged. The
    // sentence used to say "as long as I let a reply run", which called the
    // clock a deadline on the answer. It now reports only the two things the app
    // can actually see — it was still going, and it hit the longest leash there
    // is — and passes no verdict on the work. Note this test PINS the leash to
    // 60 seconds, so it also proves the sentence reads correctly at a budget
    // that is nothing like 45 minutes.
    (err: unknown) => err instanceof TurnTimedOutError
      && /without finishing/.test(err.message)
      && /longest I let anything run/.test(err.message)
      && /1 minute/.test(err.message),
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

/* ============ TWO TURNS FOR ONE AGENT, AT THE SAME TIME ============
 *
 * The engine's cap is two turns and it is NOT per-agent, so one agent really
 * can be mid-turn twice. Each turn opens its own doorway with its own ticket
 * and its own conversation. What broke: both turns wrote their ticket to one
 * fixed filename in the agent's folder, so the second write replaced the first,
 * the first turn's tool child read the SECOND turn's ticket, and every history
 * search that turn ran came back with the other room's messages — which it then
 * quoted into its own room as fact. Whichever turn ended first also deleted the
 * file the other was still using.
 *
 * This test runs the real thing: two `respond` calls at once, held open until
 * both have written, then each one is asked what its own child would read.
 */
test("two turns for one agent each read their own ticket, not each other's", async () => {
  const dir = tempDir("cloud9-turnfile-");
  try {
    let bothWritten: () => void;
    const barrier = new Promise<void>(resolve => { bothWritten = resolve; });
    let written = 0;
    /** What the CLI child would actually load, read at the moment it is spawned. */
    const seen: { path: string; secret: string; channel: string }[] = [];
    const runner = async (_cmd: string, args: string[]) => {
      const at = args[args.indexOf("--mcp-config") + 1];
      // both turns must have written before either child reads — that is the
      // whole race, and waiting for it makes the test deterministic
      if (++written === 2) bothWritten();
      await barrier;
      const conf = JSON.parse(fs.readFileSync(at, "utf8"));
      const env = conf.mcpServers.cloud9.env;
      seen.push({ path: at, secret: env.CLOUD9_TOOL_SECRET, channel: env.CLOUD9_TOOL_URL });
      return {
        code: 0, stdout: `{"type":"result","subtype":"success","is_error":false,"result":"ok"}`,
        stderr: "", timedOut: false, notFound: false,
      };
    };
    const bridge = new ToolBridge();
    await bridge.start();
    const turns: Record<string, OpenTurn | undefined> = {};
    const cli = new ClaudeCliProvider({
      agentDataDir: () => dir,
      runner,
      models: () => CLAUDE_MODELS,
      cloud9Tools: ({ channelId }) => {
        const open = bridge.openTurn({
          channelId,
          search: async () => ({ hits: [], hasMore: false }),
          openAttachment: async () => ({ found: false, why: "nothing is attached here" }),
        });
        turns[channelId] = open;
        return open;
      },
    });
    const one = cli.respond({
      agent: agent(), context: "", trigger: "hi", triggerAuthor: "V",
      kind: "chat", channelId: "ch_general",
    });
    const two = cli.respond({
      agent: agent(), context: "", trigger: "hi", triggerAuthor: "V",
      kind: "chat", channelId: "ch_ops",
    });
    await Promise.all([one, two]);
    bridge.stop();

    assert.equal(seen.length, 2);
    assert.notEqual(seen[0].path, seen[1].path,
      "each turn must write its own file — one fixed name lets a turn read the other's ticket");
    const secrets = new Set(seen.map(s => s.secret));
    assert.equal(secrets.size, 2,
      "each turn's child must be handed ITS OWN ticket, never the other turn's");
    // and the tickets that were actually written are the two the bridge minted
    const minted = new Set(Object.values(turns).map(t => t?.secret));
    for (const s of secrets) assert.ok(minted.has(s), "a ticket appeared that nobody minted");
    // nothing left behind on disk once both turns are over
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.startsWith(".cloud9-mcp")), [],
      "a finished turn must take its own ticket file with it");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ============ THE STRIPPER MUST COVER CLOUD9'S OWN VARIABLES ============
 *
 * Security review 2026-08-04. The stripper is one shared function with a name
 * list and a shape pattern, and it was right about every name it knew — but
 * `CLOUD9_CRED` is the variable Cloud9's OWN launcher uses for the real
 * Anthropic key (`scripts/engine-host.mjs`), and it matched neither: `CRED` is
 * not the word `CREDENTIAL`. So on a machine started that way the key went to
 * every child process, including a Codex agent, which is a different account
 * and which this app promises will never see it.
 *
 * The names are asserted BY NAME here on purpose. Looping over the list is what
 * let this through: a test that reads the same list as the code can only ever
 * agree with it.
 */
test("Cloud9's own credential variables never reach a child process", () => {
  const before = { ...process.env };
  const planted = {
    CLOUD9_CRED: "sk-ant-should-never-travel",
    CLOUD9_CRED_KIND: "apiKey",
    CLOUD9_CODEX_CRED: "codex-should-never-travel",
  };
  Object.assign(process.env, planted);
  try {
    const env = envWithoutCredentials();
    for (const name of Object.keys(planted)) {
      assert.equal(env[name], undefined,
        `${name} was handed to the child process — that is the owner's key leaving the app`);
    }
    // and nothing else was taken with them
    assert.ok(Object.keys(env).length > 0, "the whole environment was thrown away");
  } finally {
    for (const name of Object.keys(planted)) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
});
