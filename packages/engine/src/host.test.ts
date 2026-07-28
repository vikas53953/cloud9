// Engine host wiring: which harness state and which credentials produce a
// working provider — and which must NOT quietly produce canned answers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef, HarnessState } from "@cloud9/shared";
import { ClaudeCliProvider, CREDENTIAL_ENV_VARS } from "./claude-cli.js";
import { EngineHostOptions, startEngineHost } from "./host.js";
import { MockProvider, SdkProvider } from "./provider.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-host-"));

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
  createdAt: 0, ...over,
});

const state = (over: { claudeIn?: boolean; codexIn?: boolean } = {}): HarnessState => {
  const claudeIn = over.claudeIn ?? true;
  const codexIn = over.codexIn ?? false;
  return {
    claude: {
      name: "claude", installed: true, signedIn: claudeIn,
      authKind: claudeIn ? "cli-login" : "none",
      models: claudeIn ? ["claude-sonnet-5", "claude-opus-5"] : [],
      defaultModel: claudeIn ? "claude-sonnet-5" : undefined,
      detail: claudeIn ? "Signed in as vikas@example.com" : "not signed in yet",
    },
    codex: {
      name: "codex", installed: true, signedIn: codexIn,
      authKind: codexIn ? "cli-login" : "none",
      models: codexIn ? ["gpt-5.6-sol"] : [],
      defaultModel: codexIn ? "gpt-5.6-sol" : undefined,
      detail: codexIn ? "Signed in as your ChatGPT account" : "not signed in yet",
    },
    updatedAt: Date.now(),
  };
};

/** Start a host that never touches the network or a real CLI. */
function host(opts: Partial<EngineHostOptions> = {}) {
  return startEngineHost({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(), connect: false,
    log: () => {},
    harness: { runner: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, notFound: true }) },
    ...opts,
  });
}

test("Codex attaches when the CLI reports signed in, and detaches when it doesn't", () => {
  const h = host();
  assert.equal(h.engine.codexProvider, undefined, "nothing attached before detection");

  h.harness.state = state({ codexIn: true });
  h.harness.setState(state({ codexIn: true }));
  assert.ok(h.engine.codexProvider, "attached once Codex reports signed in");

  h.harness.setState(state({ codexIn: false }));
  assert.equal(h.engine.codexProvider, undefined, "detached when Codex signs out");
  h.stop();
});

test("a signed-out Claude does NOT fall back to canned replies", () => {
  const h = host();
  h.harness.setState(state({ claudeIn: false }));
  assert.equal(h.engine.provider, undefined);
  assert.equal(h.engine.providerFor(agent()), undefined, "the agent will say it isn't connected");
  h.stop();
});

// --- feedback round 1, his 2/3/4: the local app's own login IS the credential ---

test("a signed-in Claude app runs agents with NO credential anywhere", () => {
  const h = host();
  h.harness.setState(state({ claudeIn: true }));
  assert.ok(h.engine.provider instanceof ClaudeCliProvider,
    "the app on this computer is signed in, so Cloud9 just spawns it");
  assert.ok(h.engine.providerFor(agent()), "and the agent gets a real turn");
  h.stop();
});

test("a saved key still wins over the app's own login", () => {
  const h = host({ credentials: { claude: { kind: "oauthToken", value: "sk-ant-aaaaaaaaaaaaaaaa" } } });
  h.harness.setState(state({ claudeIn: true }));
  assert.ok(h.engine.provider instanceof SdkProvider,
    "when the owner saved a key, that is what we bill against");
  h.stop();
});

test("a CLI-login turn is spawned with every credential variable stripped", async () => {
  const h = host();
  h.harness.setState(state({ claudeIn: true }));
  let seenEnv: NodeJS.ProcessEnv | undefined;
  let seenStdin: string | undefined;
  (h.engine.provider as unknown as { runner: unknown }).runner =
    async (_c: string, _a: string[], o: { env?: NodeJS.ProcessEnv; stdin?: string }) => {
      seenEnv = o.env;
      seenStdin = o.stdin;
      return {
        code: 0, timedOut: false, notFound: false, stderr: "",
        stdout: `{"type":"result","subtype":"success","is_error":false,"result":"ready"}`,
      };
    };
  const said = await h.engine.provider!.respond({
    agent: agent({ model: "claude-sonnet-5" }), context: "V: hi", trigger: "hi", triggerAuthor: "V",
  });
  assert.equal(said, "ready");
  for (const key of CREDENTIAL_ENV_VARS) {
    assert.equal(seenEnv?.[key], undefined, `${key} must not reach a CLI-login turn`);
  }
  assert.ok(seenEnv?.PATH || seenEnv?.Path, "the rest of the environment is still there");
  assert.match(seenStdin ?? "", /Scout/, "the prompt goes on stdin, never on the command line");
  h.stop();
});

test("the engine refuses a model the harness doesn't actually offer", async () => {
  const h = host();
  h.harness.setState(state({ claudeIn: true }));
  (h.engine.provider as unknown as { runner: unknown }).runner = async () => {
    throw new Error("a turn must never be attempted with an unknown model");
  };
  await assert.rejects(
    () => h.engine.respondAs(agent({ model: "claude-not-a-real-model" }), {
      context: "V: hi", trigger: "hi", triggerAuthor: "V",
    }),
    /isn't one this app offers/,
  );
  h.stop();
});

test("demo mode is the only route to canned replies", () => {
  const h = host({ demoMode: true });
  h.harness.setState(state({ claudeIn: false, codexIn: false }));
  assert.ok(h.engine.provider instanceof MockProvider);
  assert.ok(h.engine.codexProvider instanceof MockProvider);
  h.stop();
});

test("credentials are per harness: a Codex key never disturbs the Claude one", () => {
  const h = host({ credentials: { claude: { kind: "oauthToken", value: "sk-claude-aaaaaaaaaaaaaaaa" } } });
  const claudeBefore = h.engine.provider;
  assert.ok(claudeBefore, "Claude is connected from its stored token");

  h.useCredential("codex", "apiKey", "sk-codex-bbbbbbbbbbbbbbbb");
  assert.ok(h.engine.provider, "Claude is still connected");
  assert.ok(h.engine.codexProvider, "Codex now has its own provider");

  h.useCredential("codex", "apiKey", "");
  assert.ok(h.engine.provider, "clearing Codex left Claude alone");
  h.stop();
});

test("a Codex key is passed as CODEX_API_KEY and never as an ANTHROPIC variable", async () => {
  let seenEnv: NodeJS.ProcessEnv | undefined;
  const h = host({
    credentials: { codex: { kind: "apiKey", value: "sk-codex-secret-value" } },
    harness: { runner: async () => ({ code: 1, stdout: "", stderr: "", timedOut: false, notFound: true }) },
  });
  // swap the runner inside the freshly built CodexProvider
  (h.engine.codexProvider as unknown as { runner: unknown }).runner =
    async (_c: string, _a: string[], o: { env?: NodeJS.ProcessEnv }) => {
      seenEnv = o.env;
      return {
        code: 0, timedOut: false, notFound: false, stderr: "",
        stdout: `{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}`,
      };
    };
  await h.engine.codexProvider!.respond({
    agent: agent({ provider: "codex" }), context: "", trigger: "hi", triggerAuthor: "V",
  });
  assert.equal(seenEnv?.CODEX_API_KEY, "sk-codex-secret-value");
  assert.notEqual(seenEnv?.ANTHROPIC_API_KEY, "sk-codex-secret-value");
  assert.notEqual(seenEnv?.CLAUDE_CODE_OAUTH_TOKEN, "sk-codex-secret-value");
  h.stop();
});
