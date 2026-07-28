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
   * Persist a token captured by "Sign in with Claude". The Electron shell
   * encrypts it with safeStorage; the dev host has nowhere safe to put one, so
   * it keeps it in memory for this run only.
   */
  onClaudeToken?: (token: string) => void | Promise<void>;
  /**
   * Canned replies with no harness at all. Must be asked for explicitly — a
   * signed-out harness must never quietly produce fake answers that look real.
   */
  demoMode?: boolean;
  harness?: Omit<HarnessOptions, "onChange" | "onClaudeToken">;
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

  /** Rebuild both providers from (credentials + detected harness state). */
  const applyProviders = (): void => {
    // --- Claude needs a credential we actually hold: the SDK bills against a
    // token/key. A signed-in CLI alone is not enough, and a signed-OUT Claude
    // must not fall back to canned replies that look like real answers.
    const claude = creds.claude?.value ? creds.claude : undefined;
    if (claude) {
      engine.provider = new SdkProvider(
        claude.kind === "apiKey" ? { apiKey: claude.value } : { oauthToken: claude.value },
        engine.agentDataDir,
      );
    } else if (opts.demoMode) {
      engine.provider = new MockProvider();
    } else {
      engine.provider = undefined; // agents will say "my engine isn't connected"
    }

    // --- Codex holds its own login inside the CLI, so a signed-in CLI is
    // enough. A stored key is the fallback for accounts without a ChatGPT login.
    const codexReady = (lastState?.codex.installed && lastState.codex.signedIn)
      || !!creds.codex?.value;
    if (codexReady) {
      engine.codexProvider = new CodexProvider({
        agentDataDir: engine.agentDataDir,
        apiKey: () => creds.codex?.value || undefined,
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
    onChange: (state: HarnessState) => {
      const hadCodex = !!engine.codexProvider;
      lastState = state;
      applyProviders();
      if (!!engine.codexProvider !== hadCodex) {
        log(engine.codexProvider
          ? "[engine-host] Codex connected — Codex agents can run"
          : "[engine-host] Codex disconnected — Codex agents will ask you to sign in");
      }
      engine.reportHarness(state);
    },
    onClaudeToken: async token => {
      useCredential("claude", "oauthToken", token);
      await opts.onClaudeToken?.(token);
    },
    log: opts.harness?.log ?? ((m: string) => log(m)),
  });

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
