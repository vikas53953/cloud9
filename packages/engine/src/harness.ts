// Harness detection and sign-in — "Sign in with Claude" / "Sign in with Codex".
//
// This module owns the two local CLIs. It runs inside the ENGINE HOST process
// (harness-signin.md decision 5), because that process already spawns CLIs and
// can be lifted onto a server unchanged.
//
// PRIMARY PATH (feedback-round-1.md): the locally installed app's OWN login.
// If `claude auth status` / `codex login status` says the app is signed in,
// that is the credential — Cloud9 spawns the CLI and never sees, captures or
// stores a token. `authKind` is then "cli-login".
//
// FALLBACK: `claude setup-token`. It is interactive-only (`--help` shows no
// non-interactive flag). Round 1 spawned it with piped stdio and no TTY, so
// after the browser hand-off it had no terminal to finish in and the card sat
// on "waiting for you in the browser…" forever. It now runs in a VISIBLE
// terminal window, its output is never read, and completion is detected by
// polling the CLI's own status command under a hard 5-minute cap. This flow
// always resolves or fails with `problem` set — it can never hang again.
//
// Secrets law: no credential material passes through this module at all any
// more. Nothing here is logged but booleans, versions and plain-words detail.
import {
  HarnessAuthKind, HarnessInfo, HarnessName, HarnessState,
} from "@cloud9/shared";
import { claudeModels, detectCodexModels, ModelList } from "./models.js";
import { run, Runner, runVisibleTerminal, VisibleRunner } from "./run.js";

export interface HarnessOptions {
  runner?: Runner;
  /** opens a real console window — the interactive fallback needs one */
  visibleRunner?: VisibleRunner;
  /** command names — tests point these at shim scripts */
  claudeCommand?: string;
  codexCommand?: string;
  /** leash for detection commands (they must never hang the engine) */
  detectTimeoutMs?: number;
  /** `codex debug models` prints a large document, so it gets its own leash */
  modelsTimeoutMs?: number;
  /**
   * Hard cap on ANY sign-in flow. When it expires the card shows `problem` and
   * the spinner stops — the round-1 endless wait cannot come back.
   */
  signInTimeoutMs?: number;
  /** how often a sign-in flow asks the CLI whether it finished */
  pollIntervalMs?: number;
  /** deprecated alias for signInTimeoutMs, kept so older callers still work */
  pollTimeoutMs?: number;
  /** where the user's Codex default model is configured (tests override) */
  codexConfigPath?: string;
  /** called after every state change (fresh detection, sign-in start/finish) */
  onChange?: (state: HarnessState) => void;
  /**
   * Which credential the host is actually holding for a harness, if any. A held
   * credential outranks the CLI's own login, because that is what the engine
   * will bill against ("when a token/API key exists, keep today's behaviour").
   */
  credentialKind?: (harness: HarnessName) => "token" | "apiKey" | undefined;
  log?: (message: string) => void;
}

const BLANK = (name: HarnessName): HarnessInfo => ({
  name, installed: false, signedIn: false, authKind: "none",
  models: [], detail: "not checked yet",
});

/** `claude --version` + `claude auth status` (harness-signin.md verified facts). */
export async function detectClaude(
  runner: Runner, command = "claude", timeoutMs = 20_000,
): Promise<HarnessInfo> {
  const list = claudeModels();
  const info: HarnessInfo = {
    name: "claude", installed: false, signedIn: false, authKind: "none",
    models: [], detail: "the Claude app isn't installed on this computer",
  };
  const version = await runner(command, ["--version"], { timeoutMs });
  if (version.notFound || version.code !== 0) return info;

  info.installed = true;
  info.models = list.models;
  info.defaultModel = list.defaultModel;
  info.version = (version.stdout.trim().split(/\r?\n/)[0] ?? "").slice(0, 60) || undefined;

  const status = await runner(command, ["auth", "status"], { timeoutMs });
  const parsed = parseJsonish(status.stdout) ?? parseJsonish(status.stderr);
  let plan = "";
  if (parsed && typeof parsed.loggedIn === "boolean") {
    info.signedIn = parsed.loggedIn;
    if (typeof parsed.email === "string") info.account = parsed.email;
    if (typeof parsed.subscriptionType === "string") plan = parsed.subscriptionType;
  } else {
    info.signedIn = status.code === 0;
  }

  if (info.signedIn) {
    info.authKind = "cli-login";
    info.detail = info.account
      ? `Signed in as ${info.account}${plan ? ` · Claude ${plan} plan` : ""}`
      : "Signed in through the Claude app on this computer";
  } else {
    info.detail = "the Claude app is installed but not signed in yet";
  }
  return info;
}

/**
 * `codex --version` + `codex login status`, plus `codex debug models`.
 *
 * Deviation from the note (logged in implementation-notes.md): `codex doctor
 * --json` is NOT used. Measured on this machine it can take over two minutes,
 * which would stall the engine host; `login status` answers the same question
 * (exit 0 = logged in) in well under a second. Also verified: `login status`
 * writes its human-readable line to STDERR, so both streams are read.
 */
export async function detectCodex(
  runner: Runner, command = "codex", timeoutMs = 20_000,
  opts: { models?: boolean; modelsTimeoutMs?: number; configPath?: string } = {},
): Promise<HarnessInfo> {
  const info: HarnessInfo = {
    name: "codex", installed: false, signedIn: false, authKind: "none",
    models: [], detail: "the Codex app isn't installed on this computer",
  };
  const version = await runner(command, ["--version"], { timeoutMs });
  if (version.notFound || version.code !== 0) return info;
  info.installed = true;
  info.version = (version.stdout.trim().split(/\r?\n/)[0] ?? "").slice(0, 60) || undefined;

  const status = await runner(command, ["login", "status"], { timeoutMs });
  const line = `${status.stdout} ${status.stderr}`.trim();
  info.signedIn = status.code === 0 && !/not logged in/i.test(line);
  if (info.signedIn) {
    const using = /logged in using ([^\n\r.]+)/i.exec(line);
    info.account = using ? `${using[1].trim()} account` : "ChatGPT account";
    info.authKind = "cli-login";
    info.detail = `Signed in as your ${info.account}`;
  } else {
    info.detail = "the Codex app is installed but not signed in yet";
  }

  // the model list only matters once the app can actually run something
  if (opts.models !== false && info.signedIn) {
    const list: ModelList = await detectCodexModels(
      runner, command, opts.modelsTimeoutMs ?? 30_000, opts.configPath,
    );
    info.models = list.models;
    info.defaultModel = list.defaultModel;
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
 * Tracks both harnesses and drives the two fallback sign-in flows.
 *
 * Both flows are the SAME shape now, and it is the shape that cannot hang:
 * start the CLI in a way that lets the user finish it (a visible console for
 * Claude, its own browser+callback for Codex), then poll that CLI's own status
 * command until it reports success or the cap runs out.
 */
export class HarnessManager {
  state: HarnessState = { claude: BLANK("claude"), codex: BLANK("codex"), updatedAt: 0 };
  private runner: Runner;
  private visibleRunner: VisibleRunner;
  private commands: Record<HarnessName, string>;
  private inFlight = new Set<HarnessName>();
  /** sign-ins the user has walked away from — the poll loop stops for these */
  private cancelled = new Set<HarnessName>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private waiters = new Set<() => void>();
  private stopped = false;
  /** the last sign-in problem per harness, so refresh() doesn't erase it */
  private lastProblem: Partial<Record<HarnessName, string>> = {};
  /** a detection round already running — callers share it instead of piling up */
  private refreshing?: Promise<HarnessState>;

  constructor(private opts: HarnessOptions = {}) {
    this.runner = opts.runner ?? run;
    this.visibleRunner = opts.visibleRunner ?? runVisibleTerminal;
    this.commands = {
      claude: opts.claudeCommand ?? "claude",
      codex: opts.codexCommand ?? "codex",
    };
  }

  /** The hard cap every sign-in flow is held to. Five minutes by default. */
  private get signInCapMs(): number {
    return this.opts.signInTimeoutMs ?? this.opts.pollTimeoutMs ?? 300_000;
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

  /** The models one harness offers, for the last-gate check before a turn. */
  modelsFor(harness: HarnessName): string[] {
    return this.state[harness].models;
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
      detectCodex(this.runner, this.commands.codex, t, {
        modelsTimeoutMs: this.opts.modelsTimeoutMs,
        configPath: this.opts.codexConfigPath,
      }),
    ]);
    // a sign-in already running must not be erased by a detection round, and
    // neither must the reason the last sign-in failed
    this.state.claude = this.merge(claude);
    this.state.codex = this.merge(codex);
    this.state.checking = false;
    this.publish();
    this.log(
      `claude installed=${claude.installed} signedIn=${claude.signedIn} ` +
      `auth=${this.state.claude.authKind} models=${claude.models.length} · ` +
      `codex installed=${codex.installed} signedIn=${codex.signedIn} ` +
      `auth=${this.state.codex.authKind} models=${codex.models.length}`,
    );
    return this.state;
  }

  /**
   * Fold in what only the host knows: a credential it is holding. A held
   * token/key outranks the CLI's own login, and it can make a harness usable
   * even when the CLI itself is signed out.
   */
  private merge(fresh: HarnessInfo): HarnessInfo {
    const held = this.opts.credentialKind?.(fresh.name);
    const problem = this.lastProblem[fresh.name];
    const info: HarnessInfo = {
      ...fresh,
      signingIn: this.inFlight.has(fresh.name) || undefined,
      problem,
    };
    if (held) {
      info.authKind = held === "token" ? "token" : "apiKey";
      info.signedIn = true;
      if (!fresh.signedIn) {
        info.account = info.account ?? "a saved key";
        info.detail = "Connected with the key you saved in Settings";
      }
    } else if (!fresh.signedIn) {
      info.authKind = "none";
      // a failure the user hasn't resolved is more useful than "not signed in"
      if (problem) info.detail = problem;
    }
    return info;
  }

  /** Start (and await) the fallback sign-in flow for one harness. */
  async signIn(harness: HarnessName): Promise<HarnessState> {
    if (this.inFlight.has(harness)) {
      this.log(`${harness}: sign-in already running`);
      return this.state;
    }
    this.inFlight.add(harness);
    delete this.lastProblem[harness];
    this.state[harness] = {
      ...this.state[harness], signingIn: true, problem: undefined,
      detail: "waiting for you in the browser…",
    };
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
      this.cancelled.delete(harness);
    }
    return this.refresh();
  }

  /**
   * The user pressed Cancel. We cannot close the browser window they opened,
   * but we can stop waiting for it: the poll loop ends on its next tick and the
   * card goes back to offering a sign-in instead of sitting on a spinner for
   * five minutes (finding #10).
   */
  cancelSignIn(harness: HarnessName): void {
    if (!this.inFlight.has(harness)) return;
    this.cancelled.add(harness);
    this.log(`${harness}: sign-in cancelled`);
    // wake anything currently sleeping so the loop notices straight away
    for (const w of [...this.waiters]) w();
    this.waiters.clear();
  }

  /**
   * Claude fallback. `setup-token` is interactive, so it gets a real console
   * window; we never read what it prints. The CLI's own `auth status` is the
   * completion signal, under the same cap as every other flow.
   */
  private async signInClaude(): Promise<void> {
    const started = await this.visibleRunner(this.commands.claude, ["setup-token"]);
    if (started.notFound) throw new Error("claude CLI not found");
    await this.pollUntilSignedIn("claude");
  }

  private async signInCodex(): Promise<void> {
    // `codex login` owns the browser and its own local callback: fire and forget,
    // then watch `codex login status` for the result.
    const started = await this.runner(this.commands.codex, ["login"], { detached: true });
    if (started.notFound) throw new Error("codex CLI not found");
    await this.pollUntilSignedIn("codex");
  }

  /**
   * The one loop both flows share. It ALWAYS ends: either the CLI reports a
   * login, or the cap expires and the caller turns that into `problem`. There
   * is no branch here that waits forever.
   */
  private async pollUntilSignedIn(harness: HarnessName): Promise<void> {
    const interval = this.opts.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + this.signInCapMs;
    const detectTimeout = this.opts.detectTimeoutMs ?? 20_000;
    while (!this.stopped && !this.cancelled.has(harness) && Date.now() < deadline) {
      await this.wait(Math.min(interval, Math.max(0, deadline - Date.now())));
      if (this.stopped || this.cancelled.has(harness)) break;
      const info = harness === "claude"
        ? await detectClaude(this.runner, this.commands.claude, detectTimeout)
        : await detectCodex(this.runner, this.commands.codex, detectTimeout, { models: false });
      if (info.signedIn) {
        this.log(`${harness}: signed in`);
        return;
      }
    }
    // a cancelled sign-in is not a failure — it leaves no problem on the card
    if (this.stopped || this.cancelled.has(harness)) return;
    throw new Error(`${harness} sign-in was not completed in time`);
  }

  /** A sleep that stop() can cut short — otherwise shutdown waits a full tick. */
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
  if (/timed out|not completed in time/i.test(text)) {
    return "sign-in didn't finish in five minutes — try again";
  }
  return "sign-in didn't finish — try again";
}

/** Re-exported so callers keep one import for the whole harness story. */
export type { HarnessAuthKind };
