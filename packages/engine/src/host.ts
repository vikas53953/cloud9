// Engine host wiring — shared by the dev script (scripts/engine-host.mjs) and
// the Electron shell, so both behave identically.
//
// The host is the only process that spawns the local CLIs and the only one that
// ever holds a credential in memory. It publishes STATUS to the relay and keeps
// secrets to itself (harness-signin.md decisions 4–6).
//
// Credentials are PER HARNESS. A Claude key and a Codex key are different
// accounts on different services; they are stored, injected and cleared
// separately, and a Codex key must never reach an ANTHROPIC_* variable.
import { HarnessName, HarnessState } from "@cloud9/shared";
import { ClaudeCliProvider } from "./claude-cli.js";
import { CodexProvider } from "./codex.js";
import { Engine } from "./engine.js";
import { HarnessManager, HarnessOptions } from "./harness.js";
import { MockProvider, SdkProvider } from "./provider.js";

export interface StoredCredential {
  kind: "apiKey" | "oauthToken";
  value: string;
}

export interface EngineHostOptions {
  relayUrl: string;
  token: string;
  dataDir?: string;
  /** credentials already on this machine (decrypted by the shell just now) */
  credentials?: Partial<Record<HarnessName, StoredCredential>>;
  /**
   * Canned replies with no harness at all. Must be asked for explicitly — a
   * signed-out harness must never quietly produce fake answers that look real.
   */
  demoMode?: boolean;
  harness?: Omit<HarnessOptions, "onChange" | "credentialKind">;
  /** called once the relay says hello */
  onReady?: () => void;
  /** false in tests */
  connect?: boolean;
  log?: (message: string) => void;
}

export interface EngineHost {
  engine: Engine;
  harness: HarnessManager;
  /** set or clear one harness's credential at runtime (sign-in, or settings) */
  useCredential(harness: HarnessName, kind: "apiKey" | "oauthToken", value: string): void;
  stop(): void;
}

export function startEngineHost(opts: EngineHostOptions): EngineHost {
  const log = opts.log ?? ((m: string) => console.log(m));
  const engine = new Engine({
    relayUrl: opts.relayUrl, token: opts.token, dataDir: opts.dataDir,
  });

  // one slot per harness; a missing slot means "no credential"
  const creds: Partial<Record<HarnessName, StoredCredential>> = { ...opts.credentials };
  let lastState: HarnessState | undefined;

  /** The models a harness currently offers — the last gate before a command line. */
  const modelsFor = (harness: HarnessName): string[] => lastState?.[harness].models ?? [];

  /**
   * Rebuild both providers from (credentials + detected harness state).
   *
   * Order per harness, and it is the same for both (feedback-round-1.md):
   *  1. a credential WE hold  → today's behaviour (SDK for Claude, key for Codex)
   *  2. the app's own login   → spawn the CLI with NO credential variables
   *  3. demo mode, if asked for explicitly
   *  4. nothing — the agent says "my engine isn't connected"
   *
   * A signed-out harness never quietly falls back to canned replies.
   */
  const applyProviders = (): void => {
    // --- Claude
    const claude = creds.claude?.value ? creds.claude : undefined;
    if (claude) {
      engine.provider = new SdkProvider(
        claude.kind === "apiKey" ? { apiKey: claude.value } : { oauthToken: claude.value },
        engine.agentDataDir,
      );
    } else if (lastState?.claude.installed && lastState.claude.signedIn) {
      // the Claude app on this computer is signed in and owns its credential
      engine.provider = new ClaudeCliProvider({
        agentDataDir: engine.agentDataDir,
        command: opts.harness?.claudeCommand,
        models: () => modelsFor("claude"),
      });
    } else if (opts.demoMode) {
      engine.provider = new MockProvider();
    } else {
      engine.provider = undefined; // agents will say "my engine isn't connected"
    }

    // --- Codex
    const codexReady = (lastState?.codex.installed && lastState.codex.signedIn)
      || !!creds.codex?.value;
    if (codexReady) {
      engine.codexProvider = new CodexProvider({
        agentDataDir: engine.agentDataDir,
        command: opts.harness?.codexCommand,
        apiKey: () => creds.codex?.value || undefined,
        models: () => modelsFor("codex"),
      });
    } else if (opts.demoMode) {
      engine.codexProvider = new MockProvider();
    } else {
      engine.codexProvider = undefined;
    }
  };

  const useCredential = (
    harness: HarnessName, kind: "apiKey" | "oauthToken", value: string,
  ): void => {
    if (value) creds[harness] = { kind, value };
    else delete creds[harness];
    // length only — never the value (decision 6)
    log(value
      ? `[engine-host] ${harness} credential set (${kind}, length ${value.length})`
      : `[engine-host] ${harness} credential cleared`);
    applyProviders();
  };

  applyProviders();

  const harness = new HarnessManager({
    ...opts.harness,
    // a held credential outranks the CLI's own login when deciding authKind,
    // because it is what the engine will actually bill against
    credentialKind: (h: HarnessName) => {
      const c = creds[h];
      if (!c?.value) return undefined;
      return c.kind === "oauthToken" ? "token" : "apiKey";
    },
    onChange: (state: HarnessState) => {
      const hadClaude = !!engine.provider;
      const hadCodex = !!engine.codexProvider;
      lastState = state;
      applyProviders();
      if (!!engine.provider !== hadClaude) {
        log(engine.provider
          ? `[engine-host] Claude connected (${state.claude.authKind}) — Claude agents can run`
          : "[engine-host] Claude disconnected — Claude agents will ask you to sign in");
      }
      if (!!engine.codexProvider !== hadCodex) {
        log(engine.codexProvider
          ? `[engine-host] Codex connected (${state.codex.authKind}) — Codex agents can run`
          : "[engine-host] Codex disconnected — Codex agents will ask you to sign in");
      }
      engine.reportHarness(state);
    },
    log: opts.harness?.log ?? ((m: string) => log(m)),
  });

  // the engine's last gate reads the same live list the providers do
  engine.harnessModels = modelsFor;

  engine.onHarnessRequest = (action: "status" | "signIn", which?: HarnessName) => {
    if (action === "status") void harness.refresh();
    else if (which) void harness.signIn(which);
  };
  engine.onReady = () => {
    opts.onReady?.();
    void harness.refresh();
  };

  if (opts.connect !== false) engine.connect();
  return {
    engine, harness, useCredential,
    stop() { harness.stop(); engine.stop(); },
  };
}
