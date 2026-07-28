// Harness detection and sign-in — "Sign in with Claude" / "Sign in with Codex".
//
// This module owns the two local CLIs. It runs inside the ENGINE HOST process
// (harness-signin.md decision 5), because that process already spawns CLIs and
// can be lifted onto a server unchanged.
//
// Secrets law: the only credential this module ever touches is the token that
// `claude setup-token` prints. It is handed straight to `onClaudeToken` (which
// stores it in the OS keychain via Electron safeStorage) and is NEVER logged,
// never written to a file here, and never put in a status object.
import { HarnessInfo, HarnessName, HarnessState } from "@cloud9/shared";
import { run, Runner } from "./run.js";

export interface HarnessOptions {
  runner?: Runner;
  /** command names — tests point these at shim scripts */
  claudeCommand?: string;
  codexCommand?: string;
  /** leash for detection commands (they must never hang the engine) */
  detectTimeoutMs?: number;
  /** leash for `claude setup-token` — the user has to click through a browser */
  signInTimeoutMs?: number;
  /** `codex login` completion is detected by polling `codex login status` */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** called after every state change (fresh detection, sign-in start/finish) */
  onChange?: (state: HarnessState) => void;
  /** receives the captured Claude token — store it encrypted, never log it */
  onClaudeToken?: (token: string) => void | Promise<void>;
  log?: (message: string) => void;
}

const BLANK = (name: HarnessName): HarnessInfo => ({
  name, installed: false, signedIn: false, detail: "not checked yet",
});

/**
 * Pull the token out of `claude setup-token` stdout. The CLI prints chatter
 * around it, so we take the first token-shaped word and nothing else.
 */
export function extractSetupToken(stdout: string): string | undefined {
  const m = /\bsk-[A-Za-z0-9_-]{16,}/.exec(stdout);
  return m ? m[0] : undefined;
}

/** `claude --version` + `claude auth status` (harness-signin.md verified facts). */
export async function detectClaude(
  runner: Runner, command = "claude", timeoutMs = 20_000,
): Promise<HarnessInfo> {
  const info: HarnessInfo = { name: "claude", installed: false, signedIn: false };
  const version = await runner(command, ["--version"], { timeoutMs });
  if (version.notFound || version.code !== 0) {
    info.detail = "the Claude app isn't installed on this computer";
    return info;
  }
  info.installed = true;
  info.version = (version.stdout.trim().split(/\r?\n/)[0] ?? "").slice(0, 60) || undefined;

  const status = await runner(command, ["auth", "status"], { timeoutMs });
  const parsed = parseJsonish(status.stdout) ?? parseJsonish(status.stderr);
  if (parsed && typeof parsed.loggedIn === "boolean") {
    info.signedIn = parsed.loggedIn;
    if (typeof parsed.email === "string") info.account = parsed.email;
    if (typeof parsed.subscriptionType === "string" && parsed.subscriptionType) {
      info.detail = `Claude ${parsed.subscriptionType} plan`;
    }
  } else {
    info.signedIn = status.code === 0;
  }
  if (!info.signedIn) info.detail = "installed, but not signed in yet";
  return info;
}

/**
 * `codex --version` + `codex login status`.
 *
 * Deviation from the note (logged in implementation-notes.md): `codex doctor
 * --json` is NOT used. Measured on this machine it can take over two minutes,
 * which would stall the engine host; `login status` answers the same question
 * (exit 0 = logged in) in well under a second. Also verified: `login status`
 * writes its human-readable line to STDERR, so both streams are read.
 */
export async function detectCodex(
  runner: Runner, command = "codex", timeoutMs = 20_000,
): Promise<HarnessInfo> {
  const info: HarnessInfo = { name: "codex", installed: false, signedIn: false };
  const version = await runner(command, ["--version"], { timeoutMs });
  if (version.notFound || version.code !== 0) {
    info.detail = "the Codex app isn't installed on this computer";
    return info;
  }
  info.installed = true;
  info.version = (version.stdout.trim().split(/\r?\n/)[0] ?? "").slice(0, 60) || undefined;

  const status = await runner(command, ["login", "status"], { timeoutMs });
  const line = `${status.stdout} ${status.stderr}`.trim();
  info.signedIn = status.code === 0 && !/not logged in/i.test(line);
  if (info.signedIn) {
    const using = /logged in using ([^\n\r.]+)/i.exec(line);
    info.account = using ? `${using[1].trim()} account` : "signed in";
  } else {
    info.detail = "installed, but not signed in yet";
  }
  return info;
}

function parseJsonish(raw: string): Record<string, unknown> | undefined {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return undefined; }
}

/**
 * Tracks both harnesses and drives the two sign-in flows.
 *
 * Claude: `claude setup-token` opens the browser, the user authorises, a token
 * prints to stdout; we capture it and hand it to `onClaudeToken`.
 * Codex: `codex login` is spawned detached (it owns the browser and its own
 * local callback), then `codex login status` is polled until it reports success.
 */
export class HarnessManager {
  state: HarnessState = { claude: BLANK("claude"), codex: BLANK("codex"), updatedAt: 0 };
  private runner: Runner;
  private commands: Record<HarnessName, string>;
  private inFlight = new Set<HarnessName>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private waiters = new Set<() => void>();
  private stopped = false;
  /** the last sign-in problem per harness, so refresh() doesn't erase it */
  private lastProblem: Partial<Record<HarnessName, string>> = {};
  /** a detection round already running — callers share it instead of piling up */
  private refreshing?: Promise<HarnessState>;

  constructor(private opts: HarnessOptions = {}) {
    this.runner = opts.runner ?? run;
    this.commands = {
      claude: opts.claudeCommand ?? "claude",
      codex: opts.codexCommand ?? "codex",
    };
  }

  private log(message: string): void {
    (this.opts.log ?? console.log)(`[harness] ${message}`);
  }

  private publish(): void {
    this.state.updatedAt = Date.now();
    this.opts.onChange?.(this.state);
  }

  /**
   * Replace what we believe about the harnesses and tell everyone. Used when a
   * state is known from elsewhere (and by tests) — detection normally calls it
   * through refresh().
   */
  setState(state: HarnessState): void {
    this.state = state;
    this.publish();
  }

  /**
   * Re-detect both harnesses and broadcast the result. Concurrent callers
   * (an impatient "Re-check", a sign-in finishing) share one round rather than
   * spawning four more CLI processes.
   */
  refresh(): Promise<HarnessState> {
    if (this.refreshing) return this.refreshing;
    this.state.checking = true;
    this.publish();
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<HarnessState> {
    const t = this.opts.detectTimeoutMs ?? 20_000;
    const [claude, codex] = await Promise.all([
      detectClaude(this.runner, this.commands.claude, t),
      detectCodex(this.runner, this.commands.codex, t),
    ]);
    // a sign-in already running must not be erased by a detection round, and
    // neither must the reason the last sign-in failed
    this.state.claude = this.merge(claude);
    this.state.codex = this.merge(codex);
    this.state.checking = false;
    this.publish();
    this.log(
      `claude installed=${claude.installed} signedIn=${claude.signedIn} · ` +
      `codex installed=${codex.installed} signedIn=${codex.signedIn}`,
    );
    return this.state;
  }

  private merge(fresh: HarnessInfo): HarnessInfo {
    const problem = this.lastProblem[fresh.name];
    return {
      ...fresh,
      signingIn: this.inFlight.has(fresh.name) || undefined,
      // a failure the user hasn't resolved is more useful than "not signed in"
      detail: !fresh.signedIn && problem ? problem : fresh.detail,
    };
  }

  /** Start (and await) the sign-in flow for one harness. */
  async signIn(harness: HarnessName): Promise<HarnessState> {
    if (this.inFlight.has(harness)) {
      this.log(`${harness}: sign-in already running`);
      return this.state;
    }
    this.inFlight.add(harness);
    delete this.lastProblem[harness];
    this.state[harness] = { ...this.state[harness], signingIn: true, detail: "waiting for you in the browser…" };
    this.publish();
    try {
      if (harness === "claude") await this.signInClaude();
      else await this.signInCodex();
    } catch (err) {
      // the reason survives the refresh below, so the card can show it
      this.lastProblem[harness] = describeProblem(err);
      this.log(`${harness}: sign-in failed — ${String(err).slice(0, 160)}`);
    } finally {
      this.inFlight.delete(harness);
    }
    return this.refresh();
  }

  private async signInClaude(): Promise<void> {
    const result = await this.runner(this.commands.claude, ["setup-token"], {
      timeoutMs: this.opts.signInTimeoutMs ?? 300_000,
    });
    if (result.notFound) throw new Error("claude CLI not found");
    if (result.timedOut) throw new Error("setup-token timed out");
    const token = extractSetupToken(result.stdout);
    if (!token) {
      // never log the stream itself — it may contain the token
      throw new Error(`setup-token exited ${result.code} without a token`);
    }
    this.log(`claude: captured a sign-in token (length ${token.length})`); // length only, never the value
    await this.opts.onClaudeToken?.(token);
  }

  private async signInCodex(): Promise<void> {
    // `codex login` owns the browser and its own local callback: fire and forget,
    // then watch `codex login status` for the result.
    const started = await this.runner(this.commands.codex, ["login"], { detached: true });
    if (started.notFound) throw new Error("codex CLI not found");
    const interval = this.opts.pollIntervalMs ?? 10_000;
    const deadline = Date.now() + (this.opts.pollTimeoutMs ?? 300_000);
    while (!this.stopped && Date.now() < deadline) {
      await this.wait(interval);
      const info = await detectCodex(this.runner, this.commands.codex, this.opts.detectTimeoutMs ?? 20_000);
      if (info.signedIn) {
        this.log("codex: signed in");
        return;
      }
    }
    throw new Error("codex login was not completed in time");
  }

  /** A sleep that stop() can cut short — otherwise shutdown waits 10s a tick. */
  private wait(ms: number): Promise<void> {
    return new Promise(resolve => {
      if (this.stopped) { resolve(); return; }
      const done = () => {
        clearTimeout(t);
        this.timers.delete(t);
        this.waiters.delete(done);
        resolve();
      };
      const t = setTimeout(done, ms);
      this.timers.add(t);
      this.waiters.add(done);
    });
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    // settle anything still sleeping, so callers don't hang on a stopped manager
    for (const w of [...this.waiters]) w();
    this.waiters.clear();
  }
}

/** Plain-words reason for a failed sign-in, safe to show in the UI. */
function describeProblem(err: unknown): string {
  const text = String(err);
  if (/not found/i.test(text)) return "that app isn't installed on this computer";
  if (/timed out|not completed in time/i.test(text)) return "sign-in timed out — try again";
  if (/without a token/i.test(text)) return "sign-in finished but no token came back — try again";
  return "sign-in didn't finish — try again";
}
