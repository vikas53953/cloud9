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
import { AsyncLocalStorage } from "node:async_hooks";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** we killed it because it blew the wall-clock leash */
  timedOut: boolean;
  /**
   * WHICH clock ran out — true when we killed it for going SILENT rather than
   * for using up its total time (`quietMs` below).
   *
   * Optional so every existing construction site of a `RunResult` (and every
   * fake runner in a test) keeps compiling and keeps meaning what it meant:
   * absent is "the total ran out", which is the only thing that could happen
   * before this existed.
   */
  wentQuiet?: boolean;
  /** the command could not be started / is not on PATH */
  notFound: boolean;
  /**
   * GAP C (2026-08-05): the OWNER stopped this, and it is a different fact from
   * both of the two above. A timeout is a clock nobody chose; a stop is a person
   * deciding. Optional so every existing fake runner in the tests still
   * satisfies the type — absent means "nobody stopped it", which is the truth
   * for every run that came before this existed.
   */
  stopped?: boolean;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  /** don't wait — used for `codex login`, which owns the user's browser */
  detached?: boolean;
  /**
   * WATCH THE OUTPUT AS IT ARRIVES — one call per COMPLETE line of stdout.
   *
   * This is the whole of the live-progress seam. It is deliberately ADDITIVE:
   * `stdout` in the returned `RunResult` is still captured exactly as it was,
   * still capped the same way, and every caller that ignores this option gets
   * byte-for-byte the behaviour it got before. Nothing downstream reads the
   * stream twice by accident — the buffered result stays the truth, and this is
   * only a preview of it.
   *
   * ONE LINE MEANS ONE COMPLETE LINE. A chunk that stops mid-JSON is held back
   * until its newline arrives, because a half-written line handed to a parser
   * is the normal case mid-stream, not an error. The last line of a stream that
   * ended without a newline is flushed when the process closes.
   *
   * It can never break a run: it is called inside a try/catch, a line longer
   * than `MAX_LINE_BYTES` is dropped rather than buffered forever, and the
   * timeout/kill path does not depend on it at all.
   */
  onStdoutLine?: (line: string) => void;
  // ===== GAP A BLOCK (the silence clock, 2026-08-05) — start =====
  /**
   * HOW LONG THIS RUN MAY PRINT NOTHING AT ALL before it is called stuck.
   *
   * The second of two clocks; `timeoutMs` above is still the total ceiling and
   * is unchanged. This one is reset by every chunk that arrives on stdout OR
   * stderr, so it measures SILENCE, not work. A harness that is still announcing
   * steps is working, however long it has been at it; one that has said nothing
   * for this long is the only kind that has earned the word "hung".
   *
   * WHY THE CHUNK AND NOT THE LINE. It is deliberately wired to the raw `data`
   * events rather than to `onStdoutLine` above, so the clock behaves identically
   * whether or not anybody happens to be watching the live view. A leash whose
   * length depended on whether a window was open would be the worst of both.
   *
   * OPT-IN, AND SILENT WHEN ABSENT. Leave it out — as `gh`, `codex login` and
   * every version check do — and there is no silence clock at all, exactly as
   * before. Those callers legitimately print nothing until they are done.
   */
  quietMs?: number;
  // ===== GAP A BLOCK — end =====
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

// ===== GAP C BLOCK (stopping a running turn, 2026-08-05) — start =====
//
// THE WALL: Cloud9 had no way to stop anything. A turn that had misunderstood
// ran until a wall clock killed it — three minutes for a chat message, THIRTY
// for a job — burning the owner's own subscription the whole way, while he
// watched. There was no button, no command, and no abort anywhere in the stack.
//
// WHY IT LIVES HERE, in run.ts, and not in the engine. The thing that must
// actually die is a CHILD PROCESS TREE, and this module is the only place that
// knows a pid. `killTree` — the same one the timeout path has always used — is
// the one owner of "make it stop", and stopping deliberately reuses it rather
// than growing a second killer that could drift from it.
//
// WHY A SCOPE AND NOT AN ABORT SIGNAL THREADED THROUGH EVERY CALLER. A signal
// would have to be added to `RunOptions`, then to the provider interface, then
// to every provider, then to every caller of every provider — and the day
// somebody adds a new provider and forgets, the stop button silently does
// nothing on it. A scope is opened once, around a whole turn, and EVERY child
// started underneath it is stoppable by construction. That is the difference
// between fixing the case and fixing the class.
//
// It is `AsyncLocalStorage`, Node's own: the scope follows the turn across every
// await without being passed anywhere, and a run started outside any scope
// behaves exactly as it always did.

/** What a caller holds so it can stop a turn it started. */
export interface StopScope {
  /** Kill every child process running under this scope, now. Safe to call twice. */
  stop(): void;
  /** Did anybody call `stop()`? Stays true afterwards — it is what the record reads. */
  readonly stopped: boolean;
}

interface ScopeState {
  stopped: boolean;
  /** every child alive under this scope, each knowing how to kill its own tree */
  live: Set<() => void>;
}

/**
 * BUILT ON FIRST USE, NEVER ON IMPORT — and this is not tidiness, it is a bug
 * that was caught by the QA stack on 2026-08-05.
 *
 * `run.ts` is a Node module, but the desktop app's SCREEN imports a constant out
 * of it (through `ownersetup.ts` → `EMPTY_ARG`), so this file is bundled into
 * the browser too. A `new AsyncLocalStorage()` at the top level therefore ran in
 * the browser, where the bundler's stand-in for `node:async_hooks` has no such
 * constructor — and the whole app failed to start with
 * "AsyncLocalStorage is not a constructor". Not the stop feature failing: the
 * WINDOW, blank, because of one line in a module the screen only wanted a string
 * from.
 *
 * So it is built lazily, and if it cannot be built at all the scope degrades to
 * doing nothing — which is exactly the behaviour Cloud9 had before stopping
 * existed, and is the only honest answer in a place where there are no child
 * processes to stop anyway.
 */
let stopScopes: AsyncLocalStorage<ScopeState> | undefined;

function scopeStore(): AsyncLocalStorage<ScopeState> | undefined {
  if (stopScopes) return stopScopes;
  try {
    stopScopes = new AsyncLocalStorage<ScopeState>();
  } catch {
    return undefined; // not Node — nothing here can spawn anything either
  }
  return stopScopes;
}

/** Make a scope. It stops nothing until `withStopScope` runs something inside it. */
export function newStopScope(): StopScope & { state: ScopeState } {
  const state: ScopeState = { stopped: false, live: new Set() };
  return {
    state,
    get stopped(): boolean { return state.stopped; },
    stop(): void {
      state.stopped = true;
      // copy first: killing removes entries as the children close
      for (const kill of [...state.live]) {
        try { kill(); } catch { /* best effort — a child that is already gone is a win */ }
      }
      state.live.clear();
    },
  };
}

/**
 * Run something with a stop scope around it. Every `run()` started underneath —
 * however many awaits deep, in whichever module — can be killed by the scope.
 */
export function withStopScope<T>(
  scope: StopScope & { state: ScopeState }, fn: () => Promise<T>,
): Promise<T> {
  const store = scopeStore();
  // No storage means no Node, which means no child processes and nothing to
  // stop — so the work runs exactly as it would have done before stopping
  // existed, rather than refusing to run at all.
  return store ? store.run(scope.state, fn) : fn();
}
// ===== GAP C BLOCK — end =====

/** Stop a runaway harness from eating memory through its own output. */
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

/**
 * The longest single line the watcher will hold in memory before giving up on
 * it. A CLI that emits one enormous line must not be able to grow this buffer
 * without limit; the line is dropped from the LIVE view only — the buffered
 * `stdout` still has it, and the record built at the end is unaffected.
 */
const MAX_LINE_BYTES = 1024 * 1024;

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

    // ===== GAP C BLOCK (stopping a running turn, 2026-08-05) — start =====
    // THE SCOPE THIS RUN IS STANDING IN, if any. Read before the spawn so a turn
    // already stopped never starts one more process — the classic race where a
    // person presses stop and the harness fires off its next command anyway.
    const scope = scopeStore()?.getStore();
    if (scope?.stopped) {
      finish({ code: null, stdout: "", stderr: "", timedOut: false, notFound: false, stopped: true });
      return;
    }
    /** did the OWNER kill this particular child? */
    let stoppedHere = false;
    // ===== GAP C BLOCK — end =====

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
    // the live watcher's own buffer, kept SEPARATE from `stdout` on purpose: the
    // capture is capped and the watcher is not allowed to change what that cap
    // does, in either direction.
    const watch = opts.onStdoutLine;
    let pending = "";
    /** a line grew past the cap; skip it and everything up to the next newline */
    let skipping = false;

    const emit = (line: string): void => {
      // never let a watcher's mistake become a failed turn — the same law
      // `onTrace` already lives under one layer up.
      try { watch?.(line); } catch (err) {
        console.error("[engine] a live-output watcher threw; the run is unaffected:", err);
      }
    };

    const feed = (chunk: string): void => {
      pending += chunk;
      let nl = pending.indexOf("\n");
      while (nl !== -1) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        if (skipping) skipping = false; else emit(line.endsWith("\r") ? line.slice(0, -1) : line);
        nl = pending.indexOf("\n");
      }
      if (pending.length > MAX_LINE_BYTES) { pending = ""; skipping = true; }
    };

    /** the stream ended without a trailing newline — that tail is still a line */
    const flush = (): void => {
      if (!watch) return;
      const tail = pending;
      pending = "";
      if (skipping) { skipping = false; return; }
      if (tail.trim() !== "") emit(tail.endsWith("\r") ? tail.slice(0, -1) : tail);
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    // ===== GAP A BLOCK (the silence clock, 2026-08-05) — start =====
    // IT IS STILL SAYING THINGS, SO IT IS STILL WORKING. Every chunk of output —
    // stdout or stderr — pushes the silence deadline back. Nothing else does:
    // this clock must not be restartable by anything except the child actually
    // producing something, or it stops meaning "nothing is happening".
    let quietTimer: NodeJS.Timeout | undefined;
    const heard = (): void => {
      if (!opts.quietMs) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        killTree(child.pid);
        // `wentQuiet` is the whole reason this is a separate clock: the caller
        // has to be able to tell the owner "it froze" rather than "it ran out of
        // its half hour", because those ask him for different next moves.
        finish({ code: null, stdout, stderr, timedOut: true, wentQuiet: true, notFound: false });
      }, opts.quietMs);
    };
    /** stop both clocks. Every path out of the run calls this exactly once. */
    const clearClocks = (): void => {
      clearTimeout(timer);
      if (quietTimer) clearTimeout(quietTimer);
    };
    // ===== GAP A BLOCK — end =====

    child.stdout?.on("data", d => {
      stdout = cap(stdout + d);
      heard();
      if (watch) feed(String(d));
    });
    child.stderr?.on("data", d => { stderr = cap(stderr + d); heard(); });

    const timer = setTimeout(() => {
      killTree(child.pid);
      finish({ code: null, stdout, stderr, timedOut: true, notFound: false });
    }, timeoutMs);
    // start the silence clock the moment the child exists: a harness that never
    // says a single word is the most stuck a harness can be.
    heard();

    // ===== GAP C BLOCK (stopping a running turn, 2026-08-05) — start =====
    // THE OWNER'S HAND ON THE SAME LEVER THE CLOCK PULLS. `killTree` is the one
    // owner of "make it stop", so a stop and a timeout kill exactly the same way
    // — only the fact recorded afterwards is different.
    const stopMe = (): void => {
      stoppedHere = true;
      killTree(child.pid);
      // Do not settle here. The child's own `close` settles, so the output it
      // had already produced is not thrown away — a stopped turn's transcript is
      // still what went on the record.
    };
    scope?.live.add(stopMe);
    const forgetMe = (): void => { scope?.live.delete(stopMe); };
    // ===== GAP C BLOCK — end =====

    child.on("error", err => {
      clearClocks();
      forgetMe();
      finish({ code: null, stdout, stderr: String(err), timedOut: false, notFound: true });
    });
    child.on("close", code => {
      clearClocks();
      forgetMe();
      // flush BEFORE settling, so the last line a CLI printed reaches the live
      // view before the caller starts parsing the buffered result.
      flush();
      // A STOP IS NOT A "COMMAND NOT FOUND". Killing a shell can leave a
      // complaint on stderr that `isNotFound` would happily read as "the app
      // isn't installed", which would have told the owner his Claude app had
      // vanished because he pressed stop.
      if (stoppedHere) {
        finish({ code, stdout, stderr, timedOut: false, notFound: false, stopped: true });
        return;
      }
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
