// Spawning local CLI harnesses (claude / codex), safely and with a hard leash.
//
// Windows note (verified on this machine 2026-07-28): both CLIs are npm shims
// (`%APPDATA%\npm\claude.ps1` / `codex.cmd`). Node cannot exec a .cmd/.ps1
// directly since the 2024 spawn hardening, so every call goes through
// `shell: true`. That makes the argument list a SHELL STRING, so this module
// treats every argument as hostile: anything outside a strict allowlist is
// REJECTED, never escaped. Quoting rules differ per shell and get outsmarted;
// refusing does not. Untrusted text (prompts) goes on STDIN, never in argv.
import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** we killed it because it blew the wall-clock leash */
  timedOut: boolean;
  /** the command could not be started / is not on PATH */
  notFound: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  /** don't wait — used for `codex login`, which owns the user's browser */
  detached?: boolean;
}

/** Characters that may appear in a command-line argument. Nothing else. */
const SAFE_ARG_RE = /^[A-Za-z0-9._:\\/=+@-]*$/;
/** Same, but a path may also contain spaces (it gets quoted). */
const SAFE_PATH_RE = /^[A-Za-z0-9._:\\/=+@ -]*$/;

export class UnsafeArgumentError extends Error {
  constructor(value: string) {
    super(`refusing to run a command containing unsafe characters: ${JSON.stringify(value.slice(0, 40))}`);
    this.name = "UnsafeArgumentError";
  }
}

/**
 * Check one plain argument (flags, model ids, sandbox names).
 * Throws rather than trying to escape — see the module note.
 */
export function safeArg(value: string): string {
  if (!SAFE_ARG_RE.test(value)) throw new UnsafeArgumentError(value);
  return value;
}

/**
 * Check a filesystem path and quote it if it contains spaces. Still refuses
 * every shell metacharacter — a path with a `&` in it does not get to run.
 */
export function shellQuote(value: string): string {
  if (!SAFE_PATH_RE.test(value)) throw new UnsafeArgumentError(value);
  return /\s/.test(value) ? `"${value}"` : value;
}

/**
 * THE ONE PLACE A COMMAND LINE IS BUILT, and therefore the one place the
 * allowlist is applied. `run` and `runVisibleTerminal` both call it, so there
 * is no second spelling of "is this argv safe?" to drift.
 *
 * It is EXPORTED so a test can prove a caller's argv against the real guard
 * rather than against a fake runner that never checks anything. That is not a
 * theoretical worry: `gh --json number,url` shipped and threw
 * `UnsafeArgumentError` every time it met the real runner, because the only
 * thing that had ever called it was a fake (github.ts, `pullRequestFor`).
 * Anything that hands arguments to `gh` should assert on this function.
 *
 * Throws `UnsafeArgumentError` — it never escapes and never repairs.
 */
export function commandLine(cmd: string, args: string[]): string {
  return [shellQuote(cmd), ...args.map(a => checkArg(a))].join(" ");
}

/** Stop a runaway harness from eating memory through its own output. */
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

/**
 * Run a CLI and collect its output. Never throws for a non-zero exit — the
 * caller decides what a failure means. Throws UnsafeArgumentError if the
 * command or any argument is not allowlist-clean.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  // validate BEFORE anything is concatenated. Reported as a rejection, not a
  // synchronous throw, so every caller's `await` handles it the same way.
  let line: string;
  try {
    line = commandLine(cmd, args);
  } catch (err) {
    return Promise.reject(err);
  }

  return new Promise<RunResult>(resolve => {
    let settled = false;
    const finish = (r: RunResult) => { if (!settled) { settled = true; resolve(r); } };

    let child;
    try {
      child = spawn(line, {
        shell: true,
        windowsHide: true,
        cwd: opts.cwd,
        env: opts.env,
        detached: opts.detached ?? false,
        stdio: opts.detached ? "ignore" : ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      finish({ code: null, stdout: "", stderr: String(err), timedOut: false, notFound: true });
      return;
    }

    if (opts.detached) {
      // attach the handler FIRST: a spawn failure emits 'error' asynchronously,
      // and an unhandled 'error' event would take the whole process down.
      child.on("error", () => { /* nothing waits on this; the poller finds out */ });
      child.unref();
      finish({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", d => { stdout = cap(stdout + d); });
    child.stderr?.on("data", d => { stderr = cap(stderr + d); });

    const timer = setTimeout(() => {
      killTree(child.pid);
      finish({ code: null, stdout, stderr, timedOut: true, notFound: false });
    }, timeoutMs);

    child.on("error", err => {
      clearTimeout(timer);
      finish({ code: null, stdout, stderr: String(err), timedOut: false, notFound: true });
    });
    child.on("close", code => {
      clearTimeout(timer);
      finish({ code, stdout, stderr, timedOut: false, notFound: isNotFound(code, stderr) });
    });

    if (opts.stdin !== undefined) {
      child.stdin?.on("error", () => { /* closed early — the exit code tells the story */ });
      child.stdin?.end(opts.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

/**
 * Start a CLI in a terminal window the user can SEE and type into.
 *
 * This exists for one job: `claude setup-token` is interactive-only. Round 1
 * spawned it with piped stdio and no TTY, so after the browser hand-off it had
 * no terminal to finish in and the app waited forever (feedback-round-1.md,
 * root cause). An interactive CLI gets a real console or it doesn't get run.
 *
 * We do not wait for it and we never read its output — the token stays in the
 * user's own terminal. Completion is detected by polling the CLI's own status
 * command, exactly like the Codex flow.
 *
 * Safety: every argument still goes through the same allowlist as run(). The
 * console-opening wrapper around it is a fixed literal in this file, never
 * anything a client can influence.
 */
export function runVisibleTerminal(cmd: string, args: string[]): Promise<RunResult> {
  let inner: string;
  try {
    inner = commandLine(cmd, args);
  } catch (err) {
    return Promise.reject(err);
  }

  // constant wrapper per platform — no interpolation but `inner`, already checked
  const line = process.platform === "win32"
    ? `start "Cloud9 sign-in" cmd /k ${inner}`
    : process.platform === "darwin"
      ? `open -a Terminal ${inner}`
      : `x-terminal-emulator -e ${inner}`;

  return new Promise<RunResult>(resolve => {
    try {
      const child = spawn(line, {
        shell: true,
        windowsHide: false, // the entire point: the user must see this window
        detached: true,
        stdio: "ignore",
      });
      child.on("error", () => { /* nothing waits on this; the poller finds out */ });
      child.unref();
      resolve({ code: 0, stdout: "", stderr: "", timedOut: false, notFound: false });
    } catch (err) {
      resolve({ code: null, stdout: "", stderr: String(err), timedOut: false, notFound: true });
    }
  });
}

/** A `runVisibleTerminal`-shaped function — tests inject a fake one. */
export type VisibleRunner = typeof runVisibleTerminal;

/**
 * The ONE way to put a deliberately EMPTY argument on a command line.
 *
 * `claude --tools ""` means "no built-in tools at all", which is exactly what a
 * Cloud9 agent with no abilities switched on should get. There is no way to
 * write that with the allowlist above — a quote character is refused, and a
 * genuinely empty string would vanish in the shell and let `--tools` swallow
 * the next flag instead. So the intent is named here, at the quoting owner,
 * rather than each caller inventing its own escape.
 *
 * It is a sentinel a client could never send: the allowlist rejects the NUL
 * characters in it, so the only way this value reaches argv is a Cloud9 module
 * importing the constant on purpose.
 */
export const EMPTY_ARG = "\u0000cloud9-empty\u0000";

function checkArg(arg: string): string {
  if (arg === EMPTY_ARG) return '""';
  // an argument that is a path may contain spaces; anything else may not
  return /\s/.test(arg) ? shellQuote(arg) : safeArg(arg);
}

function cap(s: string): string {
  return s.length > MAX_CAPTURE_BYTES ? s.slice(0, MAX_CAPTURE_BYTES) : s;
}

/**
 * With `shell: true` the child IS the shell, so killing it can leave the real
 * CLI (and whatever it spawned) running. Kill the whole tree.
 */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        .on("error", () => { /* best effort */ });
    } catch { /* best effort */ }
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { /* not a group leader */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

/**
 * With `shell: true` a missing command is reported by the shell, not by Node,
 * so "not installed" has to be read off the shell's complaint.
 */
function isNotFound(code: number | null, stderr: string): boolean {
  if (code === 0) return false;
  return /is not recognized as an internal or external command|command not found|: not found/i
    .test(stderr);
}

/** A `run`-shaped function — tests inject a fake one. */
export type Runner = typeof run;
