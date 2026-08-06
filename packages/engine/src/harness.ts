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
  blankGitHubAccount, GitHubAccountInfo, HarnessAuthKind, HarnessInfo, HarnessName, HarnessState,
} from "@cloud9/shared";
import { GitHubClient } from "./github.js";
import {
  claudeModels, detectClaudeModels, detectCodexModels, ModelList,
  readClaudeModelCache, writeClaudeModelCache,
} from "./models.js";
import { run, Runner, runVisibleTerminal, VisibleRunner } from "./run.js";

export interface HarnessOptions {
  runner?: Runner;
  /** opens a real console window — the interactive fallback needs one */
  visibleRunner?: VisibleRunner;
  /** command names — tests point these at shim scripts */
  claudeCommand?: string;
  codexCommand?: string;
  /** GitHub's own program. Not a harness — see `detectGitHub` below. */
  ghCommand?: string;
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
  /**
   * KEEP LOOKING. Off only for tests that want one round and nothing else.
   * See `scheduleRelook` for why a single look is not allowed to be the last
   * word on whether an app exists.
   */
  relook?: boolean;
  /** how long to wait before looking again while an app looks missing */
  relookMissingMs?: number;
  /** how long to wait before looking again when everything is present */
  relookSteadyMs?: number;
  /**
   * Where the proved Claude model list is remembered, keyed on the CLI version.
   * Absent means "don't remember and don't prove" — which is what tests want.
   */
  claudeModelCachePath?: string;
  /** leash for ONE model probe (there are ~18 of them, run a few at a time) */
  modelProbeTimeoutMs?: number;
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

/**
 * How long to wait before looking at this computer again while an app appears
 * to be missing — 5s, 15s, 30s, a minute, two, then every five minutes for as
 * long as it stays missing. Short at first because the usual cause is something
 * momentary; it never stops, because the alternative is what he saw.
 */
const RELOOK_BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
/** How often to look again when both apps are present. */
const RELOOK_STEADY_MS = 600_000;

const BLANK = (name: HarnessName): HarnessInfo => ({
  name, installed: false, signedIn: false, authKind: "none",
  models: [], detail: "not checked yet",
});

/**
 * `claude --version` + `claude auth status` (harness-signin.md verified facts).
 *
 * The model list is the one PROVED against this exact CLI build if we have
 * already proved one (see `readClaudeModelCache`), and otherwise the last-known
 * good list. Detection never runs the probe itself — that takes half a minute
 * and detection has to be quick; `HarnessManager` starts it afterwards.
 */
/**
 * `<cli> --version`, with ONE second chance on a timeout.
 *
 * Both CLIs are Node programs: a cold start is seconds, and a machine doing
 * anything else (a build, a virus scan of node.exe, an npm reinstall of the
 * very shim being run) pushes that past any leash worth having. The first
 * timeout is therefore treated as "the computer was busy", not as an answer,
 * and it is asked once more with twice the patience before anybody is told
 * anything. Shared by both harnesses so they can never drift apart.
 */
async function askTwice(
  runner: Runner, command: string, args: string[], timeoutMs: number, secondMs = timeoutMs * 2,
) {
  const first = await runner(command, args, { timeoutMs });
  if (!first.timedOut) return first;
  return runner(command, args, { timeoutMs: secondMs });
}

async function askVersion(runner: Runner, command: string, timeoutMs: number) {
  return askTwice(runner, command, ["--version"], timeoutMs);
}

/**
 * IS THIS CLI SIGNED IN — asked with a leash that fits what the question really
 * costs, and never answered by the leash itself.
 *
 * MEASURED 2026-08-05 on this machine, with Cloud9 running: `claude auth status`
 * took **77 seconds**. The old code gave it the same 20s as `--version` and, on
 * a timeout, read `code !== 0` as "not signed in". Two things then went wrong at
 * once and the second is the expensive one:
 *
 *   1. every agent in the app answered "my engine isn't connected — open
 *      Settings and sign in", on a machine that WAS signed in; and
 *   2. because `installed` was true, `scheduleRelook` picked the STEADY delay —
 *      ten minutes — so the whole crew stayed dead for ten minutes per miss.
 *
 * So the sign-in probe gets its own, much longer leash, a second chance like
 * `--version` has always had, and — when it still does not answer — it reports
 * `unsure`, which the manager reads as "come back soon", never as an answer.
 */
async function askSignedIn(runner: Runner, command: string, args: string[], timeoutMs: number) {
  return askTwice(runner, command, args, timeoutMs * 3, timeoutMs * 6);
}

export async function detectClaude(
  runner: Runner, command = "claude", timeoutMs = 20_000,
  opts: { modelCachePath?: string } = {},
): Promise<HarnessInfo> {
  const info: HarnessInfo = {
    name: "claude", installed: false, signedIn: false, authKind: "none",
    models: [], detail: "the Claude app isn't installed on this computer",
  };
  const version = await askVersion(runner, command, timeoutMs);
  if (version.timedOut) {
    // A LEASH IS NOT AN ANSWER. `claude --version` is a cold Node start and
    // takes ~5s on a quiet machine; on a busy one it can blow any leash. Saying
    // "not installed on this computer" because of that sends him off to install
    // an app he already has. Say what actually happened, and let the manager's
    // re-look settle it.
    info.detail = "Claude is on this computer but did not answer in time — Cloud9 will look again shortly.";
    return info;
  }
  if (version.notFound || version.code !== 0) return info;

  info.installed = true;
  info.version = (version.stdout.trim().split(/\r?\n/)[0] ?? "").slice(0, 60) || undefined;
  const cached = opts.modelCachePath && info.version
    ? readClaudeModelCache(opts.modelCachePath, info.version)
    : undefined;
  const list = cached ?? claudeModels();
  info.models = list.models;
  info.defaultModel = list.defaultModel;
  info.modelsChecked = list.checked ?? false;
  info.modelsDetail = list.detail;

  const status = await askSignedIn(runner, command, ["auth", "status"], timeoutMs);
  const parsed = parseJsonish(status.stdout) ?? parseJsonish(status.stderr);
  let plan = "";
  if (parsed && typeof parsed.loggedIn === "boolean") {
    info.signedIn = parsed.loggedIn;
    if (typeof parsed.email === "string") info.account = parsed.email;
    if (typeof parsed.subscriptionType === "string") plan = parsed.subscriptionType;
  } else if (status.timedOut) {
    // A LEASH IS NOT AN ANSWER — the same law as `--version` above, and the one
    // that used to cost the whole crew ten minutes of "my engine isn't
    // connected". Unknown is said out loud and looked at again shortly.
    info.signedIn = false;
    info.unsure = true;
    info.detail = "Claude is on this computer but did not say whether it is signed in — " +
      "Cloud9 will look again shortly.";
    return info;
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
  const version = await askVersion(runner, command, timeoutMs);
  if (version.timedOut) {
    // same reasoning as detectClaude — see askVersion
    info.detail = "Codex is on this computer but did not answer in time — Cloud9 will look again shortly.";
    return info;
  }
  if (version.notFound || version.code !== 0) return info;
  info.installed = true;
  info.version = (version.stdout.trim().split(/\r?\n/)[0] ?? "").slice(0, 60) || undefined;

  const status = await askSignedIn(runner, command, ["login", "status"], timeoutMs);
  if (status.timedOut) {
    // same law as detectClaude's sign-in probe — unknown is not "signed out"
    info.signedIn = false;
    info.unsure = true;
    info.detail = "Codex is on this computer but did not say whether it is signed in — " +
      "Cloud9 will look again shortly.";
    return info;
  }
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

/**
 * Whether this computer has a GitHub sign-in — asked, never assumed.
 *
 * NOT A SECOND PARSER. `GitHubClient.account()` is the one place in this whole
 * repository that reads `gh auth status`, and it stays that way: the repository
 * look, the agent's push refusal and this settings card all get the same
 * sentence from the same code. This function only stamps WHEN we asked, which
 * is the one thing a screen needs that the client cannot know.
 *
 * `checkedAt` is set on every answer, including the failures. That is the
 * point: a card may only claim "signed in" as a fact about now, and a stale yes
 * left over from ten minutes ago is exactly the lie this field prevents.
 */
export async function detectGitHub(
  runner: Runner, command = "gh", log?: (m: string) => void,
): Promise<GitHubAccountInfo> {
  const who = await new GitHubClient({ runner, command, log: log ?? (() => {}) }).account();
  return {
    installed: who.installed,
    signedIn: who.signedIn,
    ...(who.login ? { login: who.login } : {}),
    ...(who.protocol ? { protocol: who.protocol } : {}),
    detail: who.detail,
    checkedAt: Date.now(),
  };
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
  state: HarnessState = {
    claude: BLANK("claude"), codex: BLANK("codex"),
    github: blankGitHubAccount(), updatedAt: 0,
  };
  private runner: Runner;
  private visibleRunner: VisibleRunner;
  private commands: Record<HarnessName, string>;
  private ghCommand: string;
  /** a GitHub sign-in window is open — a second press must not open another */
  private githubInFlight = false;
  /** why the last GitHub sign-in didn't finish, so a refresh doesn't erase it */
  private githubProblem?: string;
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
  /**
   * Has a detection round ever actually FINISHED?
   *
   * Until it has, everything in `state` is a placeholder: BLANK says
   * `installed: false` about both apps because nothing has been looked at yet,
   * not because they are missing. Telling anyone else that placeholder is how
   * every agent ends up wearing a grey dot on a machine where both apps are
   * signed in — his item 2. So the difference between "we looked and it is not
   * there" and "we have not looked" is kept, and `Engine.reportHarness` will
   * not put the second one on the wire.
   */
  private detected = false;
  /** a model-proving round already running — one at a time, they cost money */
  private provingModels = false;
  /** the next automatic look at this computer (see `scheduleRelook`) */
  private relookTimer?: ReturnType<typeof setTimeout>;
  /** how many looks in a row have come back with an app missing */
  private missedRounds = 0;

  constructor(private opts: HarnessOptions = {}) {
    this.runner = opts.runner ?? run;
    this.visibleRunner = opts.visibleRunner ?? runVisibleTerminal;
    this.commands = {
      claude: opts.claudeCommand ?? "claude",
      codex: opts.codexCommand ?? "codex",
    };
    this.ghCommand = opts.ghCommand ?? "gh";
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
    // a state that came from somewhere real IS an observation, so from here on
    // this manager has something worth telling the hub
    this.detected = true;
    this.publish();
  }

  /**
   * True once this computer has actually been looked at. Read by the host
   * before it reports anything to the hub — see `detected` above.
   */
  get hasDetected(): boolean {
    return this.detected;
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
    // ================================================================
    // A STOPPED MANAGER STARTS NOTHING (2026-08-06).
    // ================================================================
    //
    // `stop()` already did the hard half — it clears the timers and wakes
    // anything sleeping, so a poll loop ends on the spot. What it could not do
    // was stop what came AFTER: `signIn` ends with `return this.refresh()`, and
    // that spawned a fresh detection round — five child processes — on a
    // manager that had just been told to shut down. Measured on this machine
    // 2026-08-06: one round costs 30 SECONDS, so pressing stop released the
    // sleep and then made the caller wait half a minute for processes nobody
    // wanted. From the outside that is indistinguishable from stop not working.
    //
    // It is the same law `run.ts` already keeps at the spawn ("a turn already
    // stopped never starts one more process"), which is the argument for
    // putting it here rather than at the one caller that showed the symptom:
    // every path into `refresh` — the sign-in tail, the periodic re-look, an
    // impatient "Re-check" — is equally able to fire after a shutdown.
    //
    // The last known state is returned rather than nothing, with the spinners
    // cleared. That is honest: it is what we last really saw, and a stopped
    // manager will never see anything newer.
    if (this.stopped) {
      this.state = {
        ...this.state,
        checking: false,
        claude: { ...this.state.claude, signingIn: undefined },
        codex: { ...this.state.codex, signingIn: undefined },
        ...(this.state.github
          ? { github: { ...this.state.github, signingIn: undefined } } : {}),
      };
      return Promise.resolve(this.state);
    }
    if (this.refreshing) return this.refreshing;
    this.state.checking = true;
    this.publish();
    this.refreshing = this.doRefresh().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<HarnessState> {
    const t = this.opts.detectTimeoutMs ?? 20_000;
    const [claude, codex, github] = await Promise.all([
      detectClaude(this.runner, this.commands.claude, t, {
        modelCachePath: this.opts.claudeModelCachePath,
      }),
      detectCodex(this.runner, this.commands.codex, t, {
        modelsTimeoutMs: this.opts.modelsTimeoutMs,
        configPath: this.opts.codexConfigPath,
      }),
      // GitHub goes in the SAME round as the two AI apps, on purpose: one
      // "Re-check" must answer every question the Settings screen asks, or the
      // owner is back to pressing buttons and guessing which one is stale.
      detectGitHub(this.runner, this.ghCommand, m => this.log(m)),
    ]);
    // a sign-in already running must not be erased by a detection round, and
    // neither must the reason the last sign-in failed
    this.state.claude = this.merge(claude);
    this.state.codex = this.merge(codex);
    this.state.github = {
      ...github,
      ...(this.githubInFlight ? { signingIn: true } : {}),
      // a failure the owner hasn't resolved is more useful than "not signed in"
      ...(!github.signedIn && this.githubProblem ? { problem: this.githubProblem } : {}),
    };
    this.state.checking = false;
    // set BEFORE publishing: the listener that forwards this to the hub reads
    // it, and a round that has finished must be forwarded on its own frame
    this.detected = true;
    this.publish();
    this.log(
      `claude installed=${claude.installed} signedIn=${claude.signedIn} ` +
      `auth=${this.state.claude.authKind} models=${claude.models.length} · ` +
      `codex installed=${codex.installed} signedIn=${codex.signedIn} ` +
      `auth=${this.state.codex.authKind} models=${codex.models.length} · ` +
      // booleans and a public login name only. gh prints a masked token and a
      // scope list right beside these; neither is read, carried or logged.
      `github installed=${github.installed} signedIn=${github.signedIn}`,
    );
    // nothing waits on this: detection has already answered, and proving the
    // model list takes about half a minute
    void this.proveClaudeModels();
    this.scheduleRelook();
    return this.state;
  }

  /**
   * ONE LOOK IS NEVER THE LAST WORD.
   *
   * 2026-08-05, his report: Settings said "Claude — not installed on this
   * computer · ✗ app not found", with the sign-in button greyed out, on a
   * machine where `claude` was installed and signed in the whole time. Cause:
   * this computer was looked at EXACTLY ONCE, when the engine came up
   * (`host.ts`, `engine.onReady`), and whatever that one look said stood
   * forever. Anything momentary — an `npm i -g` rewriting the very shim being
   * run, a busy machine blowing the leash, a virus scanner holding node.exe —
   * became a permanent verdict, phrased as an accusation ("install it first").
   * Reproduced by launching the installed app with the CLIs hidden from PATH:
   * it said not-installed and was still saying it 150 seconds after they were
   * reachable again.
   *
   * So: look again, always. Quickly and with a backoff while something looks
   * missing (that is the answer most likely to be a lie), and slowly forever
   * after, so a sign-out or a sign-in is noticed without him pressing anything.
   * The timer is unref'd — it never holds a process open — and a sign-in in
   * flight owns the CLI, so a re-look waits its turn rather than fighting it.
   */
  private scheduleRelook(): void {
    if (this.stopped || this.opts.relook === false) return;
    if (this.relookTimer) clearTimeout(this.relookTimer);
    // "I could not tell" is treated exactly like "not here yet": come back in
    // seconds. Without this an unanswered sign-in probe parked the whole crew on
    // "my engine isn't connected" for the full ten-minute steady interval.
    const missing = !this.state.claude.installed || !this.state.codex.installed
      || this.state.claude.unsure === true || this.state.codex.unsure === true;
    let delay: number;
    if (missing) {
      delay = this.opts.relookMissingMs
        ?? RELOOK_BACKOFF_MS[Math.min(this.missedRounds, RELOOK_BACKOFF_MS.length - 1)];
      this.missedRounds++;
    } else {
      this.missedRounds = 0;
      delay = this.opts.relookSteadyMs ?? RELOOK_STEADY_MS;
    }
    const timer = setTimeout(() => {
      this.relookTimer = undefined;
      if (this.stopped) return;
      // a sign-in is driving the CLI right now; come back rather than collide
      if (this.inFlight.size > 0) { this.scheduleRelook(); return; }
      void this.refresh().catch(() => { /* the next look is already booked */ });
    }, delay);
    (timer as { unref?: () => void }).unref?.();
    this.relookTimer = timer;
  }

  /**
   * Find out which Claude models this computer can REALLY run, by running them.
   *
   * Runs at most once per Claude Code build: the answer is remembered against
   * the CLI version, so this is silent after the first time and wakes up by
   * itself when he updates Claude Code. Skipped entirely when Claude isn't
   * signed in — every probe would fail for the same reason and prove nothing.
   *
   * Returns the ids now on offer, so a caller (and a test) can await it.
   */
  async proveClaudeModels(force = false): Promise<string[]> {
    const cachePath = this.opts.claudeModelCachePath;
    const info = this.state.claude;
    if (!cachePath || this.provingModels) return info.models;
    if (!info.installed || !info.signedIn || !info.version) return info.models;
    if (!force && info.modelsChecked) return info.models;

    this.provingModels = true;
    try {
      const list = await detectClaudeModels(this.runner, this.commands.claude, {
        timeoutMs: this.opts.modelProbeTimeoutMs ?? 60_000,
      });
      if (this.stopped) return list.models;
      if (list.checked) writeClaudeModelCache(cachePath, info.version, list.models);
      this.state.claude = {
        ...this.state.claude,
        models: list.models,
        defaultModel: list.defaultModel,
        modelsChecked: list.checked ?? false,
        modelsDetail: list.detail,
      };
      this.log(`claude models proved: ${list.models.length} — ${list.detail ?? ""}`);
      this.publish();
      return list.models;
    } catch (err) {
      // an unproved list is the old list, never an empty one
      this.log(`could not prove the Claude model list: ${(err as Error).message}`);
      return this.state.claude.models;
    } finally {
      this.provingModels = false;
    }
  }

  /**
   * Fold in what only the host knows: a credential it is holding. A held
   * token/key outranks the CLI's own login, and it can make a harness usable
   * even when the CLI itself is signed out.
   */
  /**
   * WHAT A SIGN-IN HANDS BACK, AND HOW LONG THAT TAKES (2026-08-06).
   *
   * Both sign-in paths used to end `return this.refresh()`. A detection round
   * costs 30 SECONDS and five child processes — measured on this machine, and
   * already written down at the top of `refresh` where the same cost was found
   * hurting a stopped manager. That is the right price for a sign-in that
   * WORKED: the whole point is to go and see what changed.
   *
   * It is the wrong price for one that FAILED, because nothing is going to be
   * learned. `gh` is not installed; a round trip cannot make it installed. So
   * the owner sat watching a spinner for half a minute to be told a thing we
   * knew the moment the window refused to open.
   *
   * So: a failure publishes what it already knows AT ONCE, and the re-look is
   * still started — just not stood in front of. The card is honest either way;
   * only the waiting went. Same class as the stopped-manager guard above, which
   * is why it lives here, at the one point both paths return through, instead
   * of at the caller that happened to show the symptom.
   */
  private settleSignIn(harness: HarnessName | "github"): Promise<HarnessState> {
    const problem = harness === "github"
      ? this.githubProblem : this.lastProblem[harness];
    if (!problem) return this.refresh();   // it worked — go and look properly

    if (harness === "github") {
      this.state.github = {
        ...(this.state.github ?? blankGitHubAccount()),
        signingIn: undefined, problem, detail: problem,
      };
    } else {
      this.state[harness] = {
        ...this.state[harness],
        signingIn: undefined, problem, detail: problem, authKind: "none",
      };
    }
    this.publish();
    // still worth re-looking — it just happens behind him, not in front of him
    void this.refresh().catch(() => { /* a re-look that fails changes nothing */ });
    return Promise.resolve(this.state);
  }

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
    return this.settleSignIn(harness);
  }

  /**
   * Start GitHub's OWN sign-in, in a window the owner can see.
   *
   * `gh auth login --web --git-protocol https` is INTERACTIVE: it prints a
   * one-time code, waits for it to be typed into github.com, and only then
   * finishes. Run with piped output it would sit there forever with nothing to
   * type into — the exact trap `claude setup-token` fell into in round 1. So it
   * gets a real terminal window (`runVisibleTerminal`), its output is never
   * read, and the completion signal is gh's OWN `auth status` under the same
   * five-minute cap every other flow here is held to. This can never hang.
   *
   * NO CREDENTIAL PASSES THROUGH CLOUD9. gh does the whole exchange itself and
   * puts the result in this computer's vault; nothing in this method sees,
   * stores or forwards a token, and there is nowhere for one to go.
   */
  async signInGitHub(): Promise<HarnessState> {
    if (this.githubInFlight) {
      this.log("github: sign-in already running");
      return this.state;
    }
    this.githubInFlight = true;
    this.githubProblem = undefined;
    this.state.github = {
      ...(this.state.github ?? blankGitHubAccount()),
      signingIn: true, problem: undefined,
      detail: "a GitHub sign-in window is open on this computer — follow it there",
    };
    this.publish();
    try {
      const started = await this.visibleRunner(
        this.ghCommand, ["auth", "login", "--web", "--git-protocol", "https"]);
      if (started.notFound) throw new Error("gh not found");
      await this.pollUntilGitHubSignedIn();
    } catch (err) {
      this.githubProblem = describeGitHubProblem(err);
      this.log(`github: sign-in failed — ${String(err).slice(0, 160)}`);
    } finally {
      this.githubInFlight = false;
    }
    return this.settleSignIn("github");
  }

  /** The same shape as `pollUntilSignedIn`, asking gh's own status command. */
  private async pollUntilGitHubSignedIn(): Promise<void> {
    const interval = this.opts.pollIntervalMs ?? 5_000;
    const deadline = Date.now() + this.signInCapMs;
    while (!this.stopped && Date.now() < deadline) {
      await this.wait(Math.min(interval, Math.max(0, deadline - Date.now())));
      if (this.stopped) return;
      const info = await detectGitHub(this.runner, this.ghCommand, m => this.log(m));
      if (info.signedIn) {
        this.log("github: signed in");
        return;
      }
    }
    if (this.stopped) return;
    throw new Error("github sign-in was not completed in time");
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
    if (this.relookTimer) { clearTimeout(this.relookTimer); this.relookTimer = undefined; }
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

/** Plain-words reason a GitHub sign-in didn't finish. Never a stack trace. */
function describeGitHubProblem(err: unknown): string {
  const text = String(err);
  if (/not found/i.test(text)) {
    return "GitHub's own program isn't installed on this computer";
  }
  if (/timed out|not completed in time/i.test(text)) {
    return "the GitHub sign-in didn't finish in five minutes — try again";
  }
  return "the GitHub sign-in didn't finish — try again";
}

/** Re-exported so callers keep one import for the whole harness story. */
export type { HarnessAuthKind };
