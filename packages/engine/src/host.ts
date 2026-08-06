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
import fs from "node:fs";
import path from "node:path";
import { HarnessName, HarnessState } from "@cloud9/shared";
import { ClaudeCliProvider } from "./claude-cli.js";
import { SessionBook } from "./sessionresume.js";
import { mcpConfigPathFor } from "./connections.js";
import { addDirRootsFor } from "./wholecomputer.js";
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

/**
 * IS THIS FILE REALLY ON THIS COMPUTER, RIGHT NOW?
 *
 * Asked every turn, never remembered — the twin of `isFolderOnDisk` in
 * `engine.ts`, and for the same reason: a file the owner chose last month can be
 * moved, renamed or deleted, and a stale yes would put a path on a command line
 * that is not there any more. A folder is a no: `--mcp-config` wants a file.
 */
function isFileOnDisk(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * IS THIS FOLDER REALLY ON THIS COMPUTER, RIGHT NOW?
 *
 * The twin of `isFileOnDisk` above, and asked for the same reason: a folder the
 * owner opened up last month can be moved, renamed, or sit on a drive that is
 * unplugged, and a stale yes would put a path on a command line that is not
 * there. A file is a no: `--add-dir` wants a folder.
 */
function isFolderOnDisk(folder: string): boolean {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

export function startEngineHost(opts: EngineHostOptions): EngineHost {
  const log = opts.log ?? ((m: string) => console.log(m));
  const engine = new Engine({
    relayUrl: opts.relayUrl, token: opts.token, dataDir: opts.dataDir,
    // the flag is passed through so the engine can TELL every client it is in
    // demo mode; the providers themselves are decided by applyProviders below
    demoMode: opts.demoMode,
  });
  if (opts.demoMode) {
    log("[engine-host] DEMO MODE IS ON — agents will answer with made-up examples, " +
      "not real answers. Nothing here came from Claude or Codex.");
  }

  // one slot per harness; a missing slot means "no credential"
  const creds: Partial<Record<HarnessName, StoredCredential>> = { ...opts.credentials };
  let lastState: HarnessState | undefined;

  /** The models a harness currently offers — the last gate before a command line. */
  const modelsFor = (harness: HarnessName): string[] => lastState?.[harness].models ?? [];

  /**
   * Rebuild both providers from (credentials + detected harness state).
   *
   * Order per harness, and it is the same for both (feedback-round-1.md):
   *  1. demo mode, when a person explicitly asked for it
   *  2. a credential WE hold  → today's behaviour (SDK for Claude, key for Codex)
   *  3. the app's own login   → spawn the CLI with NO credential variables
   *  4. nothing — the agent says "my engine isn't connected"
   *
   * Demo mode used to sit at position 3, as a FALLBACK: it fired only when
   * everything else was missing. That is the worst possible place for it. It
   * meant the one moment canned answers appeared was the moment the owner was
   * signed out and least able to tell — and, in the other direction, that asking
   * for demo mode on a signed-in machine did nothing at all, so QA runs quietly
   * spent real money on real models and got a different answer every time.
   *
   * So it is not a fallback any more, it is an OVERRIDE: it happens only because
   * somebody asked, and when they ask it is what they get. Nothing broken can
   * cause it. And it is never invisible — the engine reports it to every screen
   * and every canned line is stamped "[demo — not a real answer]" at the source.
   */
  const applyProviders = (): void => {
    if (opts.demoMode) {
      engine.provider = new MockProvider();
      engine.codexProvider = new MockProvider();
      return;
    }

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
        // CLOUD9'S OWN DOORWAY — search, scoped to the conversation the turn is
        // in.
        cloud9Tools: engine.openToolTurn,
        // THE CONNECTIONS FILE THE OWNER CHOSE FOR THIS AGENT — the one and only
        // place a stored path becomes a real `--mcp-config` on a command line.
        //
        // It is asked FRESH per turn (that is what this being a function buys),
        // and it goes through `connectionsFileFor`, which is the same answer the
        // agent editor draws on screen. So there is one decision, read twice: a
        // file the screen calls gone can never arrive here, and a file the screen
        // calls in use is exactly what the harness is handed.
        //
        // The switch still has the last word after this — `grantedSupply` in
        // `abilities.ts` drops the path for an agent without `connections`, and
        // the prompt is built from what survives that.
        mcpConfigPath: (agentId: string) =>
          mcpConfigPathFor(engine.agentById(agentId), isFileOnDisk),
        // THE FOLDERS THE OWNER OPENED UP FOR THIS AGENT — the one and only
        // place stored paths become real `--add-dir` arguments on a command
        // line, and the line that finally closes the LAST inert switch
        // (docs/qa/gap-audit.md §3). It was empty until 2026-08-04 because
        // nothing on any screen chose folders; the agent editor now does, and
        // this reads the very same `wholeComputerRootsFor` the editor draws
        // from, asked FRESH per turn. One decision, read twice: a folder the
        // screen calls gone can never arrive here, and the folders the screen
        // calls in use are exactly what the harness is handed.
        wholeComputerRoots: (agentId: string) =>
          addDirRootsFor(engine.agentById(agentId), isFolderOnDisk),
        // REMEMBER THE CONVERSATION BETWEEN TURNS (`sessionresume.ts`). One small
        // file beside the run records, in the SAME folder they already live in —
        // `engine.agentDataDir` is handed to both, so there is no second place
        // an agent's history can end up.
        //
        // Leaving this out is a supported way to run Cloud9: every turn is then
        // cold with the whole transcript, exactly as it was before this existed.
        sessions: new SessionBook({ agentDataDir: engine.agentDataDir }),
      });
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
        // CLOUD9'S OWN DOORWAY — the SAME engine method the Claude path is
        // given, so an agent's ability to search the room it is standing in
        // does not depend on which harness its owner picked. Until 2026-08-06
        // there was no MCP path in `codex.ts` at all and every Codex turn went
        // without it; see the long note there for what had to be measured.
        cloud9Tools: engine.openToolTurn,
      });
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
    // the proved Claude model list lives beside the engine's other state, so it
    // survives a restart and is thrown away when the CLI is updated
    claudeModelCachePath: path.join(engine.dataDir, "claude-models.json"),
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
      // the second argument is the honesty gate: the hub hears about this
      // computer only once this computer has actually been looked at. Before
      // that, `state` is the placeholder every harness starts as, and telling
      // the hub "neither app is installed" would put every agent's lamp out.
      engine.reportHarness(state, harness.hasDetected);
    },
    log: opts.harness?.log ?? ((m: string) => log(m)),
  });

  // the engine's last gate reads the same live list the providers do
  engine.harnessModels = modelsFor;

  // Every action is named explicitly. The old `else` branch treated ANY action
  // that carried a harness name as "sign in", so a new action would have
  // silently started a browser sign-in instead of doing its own job.
  engine.onHarnessRequest = (
    action: "status" | "signIn" | "cancel" | "githubSignIn", which?: HarnessName,
  ) => {
    if (action === "status") void harness.refresh();
    else if (action === "signIn" && which) void harness.signIn(which);
    else if (action === "cancel" && which) harness.cancelSignIn(which);
    // GitHub carries no harness name — it is not one. Named explicitly for the
    // same reason every other action here is: a fall-through `else` once turned
    // an unknown action into a browser sign-in.
    else if (action === "githubSignIn") void harness.signInGitHub();
  };
  engine.onReady = () => {
    opts.onReady?.();
    void harness.refresh();
  };

  // The doorway is opened before the socket, so a turn can never arrive at a
  // half-open one. It never throws: no doorway means agents take their turns
  // without Cloud9's tools and are not told they have any.
  void engine.startTools();

  if (opts.connect !== false) engine.connect();
  return {
    engine, harness, useCredential,
    stop() { harness.stop(); engine.stop(); },
  };
}
