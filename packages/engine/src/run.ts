// Spawning local CLI harnesses (claude / codex) safely; only mechanical
// one-shot commands get a timeout, while an agent turn has no clock.
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
import fs from "node:fs";
import path from "node:path";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /**
   * THE OUTPUT WAS BIGGER THAN WE COULD HOLD, so the beginning of it was
   * dropped. See `cap` — the END is what is kept, because that is where a
   * harness puts its answer.
   *
   * It is reported rather than swallowed because a turn that overflowed is a
   * turn whose record is incomplete, and "the app decided not to mention it" is
   * exactly the class of silence this project keeps having to remove.
   */
  truncated?: boolean;
  /**
   * We killed it because it blew the mechanical command timeout.
   *
   * ONLY ORDINARY COMMANDS CAN EVER HAVE ONE (git, gh, a version check, a hook)
   * — see `timeoutMs`. An agent's TURN has no leash at all any more, so this is
   * never true of a turn. See `timebudget.ts` for why the turn clocks went.
   */
  timedOut: boolean;
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
  /**
   * HOW LONG THIS ONE COMMAND MAY TAKE. Defaults to 20 seconds.
   *
   * IT IS FOR ORDINARY COMMANDS, NOT FOR AN AGENT'S WORK — `git rev-parse`, a
   * `gh` call, a `--version` probe, a hook. Those are single, quick, mechanical
   * things where taking minutes really does mean something is wrong, and where
   * a hang would leave a person staring at a screen with nothing on it.
   *
   * AN AGENT'S TURN PASSES `NO_TIME_LIMIT` AND HAS NO CLOCK AT ALL. That is not
   * an oversight and it is not "a very big number": it is the point. A turn ends
   * when it finishes, when it fails, or when the owner presses Stop. See
   * `timebudget.ts`, which is now nothing but the note explaining why.
   */
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
}

/**
 * NO CLOCK. What an agent's turn is run under.
 *
 * A turn runs until it finishes, until it fails, or until the owner presses
 * Stop. There used to be two clocks over it and both are gone — `timebudget.ts`
 * is the note saying why, and it is worth reading before adding a third.
 *
 * It is spelt as a value rather than as "leave the option out" because leaving
 * it out means the 20-second default above, which would be the worst possible
 * accident: every turn killed after twenty seconds, silently.
 */
export const NO_TIME_LIMIT = Number.POSITIVE_INFINITY;

/**
 * COMMANDS THAT ARE REAL PROGRAMS, so they are started directly rather than by
 * asking a shell to start them.
 *
 * WHY THIS EXISTS (measured on this machine, 2026-08-06). The module note above
 * explains why `shell: true` is used: `claude` and `codex` are npm shims
 * (`.ps1` / `.cmd`) that Node cannot execute directly. That reason is real — but
 * it was applied to EVERY command, including the ones that are ordinary `.exe`s
 * and never needed it. So each `git` call started TWO processes: a shell, whose
 * only job was to start git, and then git.
 *
 * On a busy Windows machine that is not a rounding error. Starting ANY process
 * here was measured at 0.2–4.4 seconds (a bare `cmd /c ver` took 1137ms at the
 * median), so the free shell was doubling the cost of the single most repeated
 * operation in the product: a repository turn runs fifteen-plus git commands,
 * and every one of them was paying twice. Measured end to end, one `git`
 * call went from 5952ms through the shell to 2225ms direct.
 *
 * IT IS ALSO THE SAFER BRANCH. A directly-spawned process takes its arguments as
 * an ARRAY, so there is no command line for a quoting trick to hide in — the
 * thing the allowlist above exists to defend against cannot arise at all. The
 * allowlist is still applied to both branches regardless, so nothing that was
 * refused before is accepted now.
 *
 * ONLY ADD A NAME HERE IF IT IS A REAL BINARY ON EVERY PLATFORM WE RUN ON. A
 * shim added to this set would stop working outright rather than get slower,
 * which is exactly why `claude` and `codex` are not in it.
 */
const REAL_EXECUTABLES = new Set(["git", "gh"]);

/**
 * IS THIS NAME REALLY A PROGRAM WINDOWS CAN START ON ITS OWN? (2026-08-06)
 *
 * Skipping the shell for `git` and `gh` saves a whole process launch, which is
 * worth real seconds on a machine where each one costs ~1s. But it quietly
 * assumed those names always resolve to a `.exe`. ON WINDOWS THEY OFTEN DO NOT:
 * scoop, npm and some winget packages install `gh.cmd` / `git.cmd` wrappers,
 * and `spawn` WITHOUT a shell cannot start a `.cmd` at all.
 *
 * Measured here on 2026-08-06: with the shell skipped, a `gh.cmd` earlier on
 * PATH was stepped straight over and a DIFFERENT gh answered instead. In the
 * app that is the bug Vikas already lived through once — "GitHub is not
 * installed" on a computer where it plainly is.
 *
 * So the fast path is taken only when the name really resolves to an executable
 * image. Anything else — a `.cmd`, a `.bat`, a `.ps1`, a shim, or a name we
 * cannot resolve at all — keeps the shell, which knows how to run all of them.
 * Correctness first; the saving is kept for the case that is actually safe.
 *
 * The answer is cached per (name, PATH) because it cannot change while PATH is
 * unchanged, and resolving it is itself a disk walk.
 */
const realProgramCache = new Map<string, boolean>();

/**
 * WHAT JOINS THE TWO HALVES OF THAT CACHE KEY, and why it is a PRINTABLE
 * character (2026-08-13).
 *
 * IT USED TO BE A LITERAL NUL BYTE. As a separator that was a perfectly good
 * choice; as a character sitting in a source file it was a bad one. Git
 * classifies any file containing a NUL as BINARY, so `run.ts` — the module that
 * owns the whole unsafe-argument guard — rendered in every diff as
 * `Bin 29312 -> 33868` instead of as reviewable text, and `grep` refused to
 * search the file at all. A security guard whose diff nobody can read is a
 * security guard nobody can review, which is a much worse problem than the one
 * the NUL was solving.
 *
 * `|` keeps the only guarantee a cache-key separator actually has to make: that
 * two different (command, PATH) pairs can never collide on one key. It cannot
 * appear in the FIRST half. `isRealProgram` is only ever reached for a member of
 * `REAL_EXECUTABLES`, and every command name is checked against `SAFE_ARG_RE`,
 * which has no `|` in it — so the split point is always the first `|`, whatever
 * the PATH half happens to contain. `|` is also illegal in a Windows path, and
 * Windows is the only platform this function does any work on.
 *
 * IT IS A NAMED CONSTANT, not a character typed inline, so the next person who
 * reads the key can see it is a deliberate separator rather than punctuation.
 */
const CACHE_KEY_SEP = "|";

function isRealProgram(cmd: string, env: NodeJS.ProcessEnv): boolean {
  if (process.platform !== "win32") return true;   // no PATHEXT problem here
  const pathVar = env.PATH ?? env.Path ?? "";
  const key = `${cmd}${CACHE_KEY_SEP}${pathVar}`;
  const seen = realProgramCache.get(key);
  if (seen !== undefined) return seen;
  let answer = false;
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    try {
      if (fs.existsSync(path.join(dir, `${cmd}.exe`))) { answer = true; break; }
      // a wrapper earlier on PATH WINS — it is what would really have run
      if (fs.existsSync(path.join(dir, `${cmd}.cmd`))
        || fs.existsSync(path.join(dir, `${cmd}.bat`))
        || fs.existsSync(path.join(dir, `${cmd}.ps1`))) { answer = false; break; }
    } catch { /* an unreadable folder on PATH is not an answer */ }
  }
  realProgramCache.set(key, answer);
  return answer;
}

/** Characters that may appear in a command-line argument. Nothing else. */
const SAFE_ARG_RE = /^[A-Za-z0-9._:\\/=+@-]*$/;
/** Same, but a path may also contain spaces (it gets quoted). */
const SAFE_PATH_RE = /^[A-Za-z0-9._:\\/=+@ -]*$/;

/**
 * ONE WINDOWS 8.3 SHORT-NAME SEGMENT — `ADMINI~1`, `RUNNER~1`, `PROGRA~2`,
 * `LONGFI~1.TXT`. Added 2026-08-12; see `maskShortNames` for why.
 *
 * THE INVARIANT THIS PATTERN EXISTS TO GUARANTEE, stated first because it is
 * the whole safety argument and the rest is detail:
 *
 *   EVERY TILDE THIS PATTERN MASKS HAS AN ORDINARY NAME CHARACTER
 *   (`[A-Za-z0-9_-]`) IMMEDIATELY BEFORE IT, INSIDE THE SAME MATCH.
 *
 * WHY IT IS STATED THAT WAY AND NOT AS "the tilde is never the first character
 * of the argument" (corrected 2026-08-13 — the earlier wording was weaker than
 * the code). `safeArg` is not always handed a whole argument. It is also called
 * on FRAGMENTS that are then pasted into a bigger string:
 *
 *   codex.ts:581   `mcp_servers.${s}.url=${safeArg(ticket.url)}`
 *   codex.ts:727   `model_reasoning_effort=${safeArg(effort)}`
 *
 * So the `^` in this pattern anchors THE FRAGMENT, not the finished argument —
 * a fragment that begins at the start of the checked string may well end up in
 * the middle of what the shell actually sees. Any claim about "the start of the
 * argument" is therefore not something this pattern can make.
 *
 * The invariant above survives that, and it is what actually matters. Text put
 * BEFORE a fragment cannot delete the character sitting immediately in front of
 * the tilde, and text put AFTER cannot either. So wherever the checked substring
 * lands, the tilde still has a name character on its left — which is precisely
 * the condition under which no shell expands it (see `maskShortNames`).
 *
 * THERE IS ALSO A SECOND GATE, and it is the authoritative one. Whatever a
 * fragment is pasted into, `commandLine` checks THE FINISHED ARGUMENT again
 * before anything is spawned, so the composed string has to pass on its own
 * merits too. Measured, all three cases behave:
 *
 *   effort `~1`    → refused at the fragment gate: nothing before the tilde.
 *   effort `A~1`   → passes the fragment gate, and then the composed
 *                    `model_reasoning_effort=A~1` is REFUSED by `commandLine`,
 *                    because there the `A` follows an `=` rather than a path
 *                    separator, so it is not a path segment and is not masked.
 *   url `…\RUNNER~1\x` → passes both, because there the tilde really is inside a
 *                    path segment — which is the case this whole rule exists for.
 *
 * A fragment therefore cannot smuggle a tilde into a command line by being
 * short-sighted about where it will be pasted; the worst it can do is get the
 * finished argument refused.
 *
 * With that said, every part of the shape is load-bearing:
 *
 * - `[A-Za-z0-9_-]{1,6}` — AT LEAST ONE ordinary name character before the
 *   tilde. This is the clause that establishes the invariant, and because `:`
 *   `=` and ` ` are not in the class, the tilde can never sit immediately after
 *   any of them either.
 * - `(?:^|(?<=[\\/]))` — that run of name characters starts the checked string
 *   or follows a path separator. This one is about PRECISION, not safety: it
 *   keeps the rule to things shaped like a path SEGMENT, so `a:b~1` is not
 *   quietly admitted as a short name even though its tilde does have a name
 *   character in front of it.
 * - `~[0-9]{1,6}` — a tilde followed only by digits. `~`, `~/x` and `~user/x`
 *   have no digits and so never match.
 * - the optional `.EXT` and the `(?=[\\/]|$)` lookahead — the digits must run
 *   to the end of the segment, so `ADMINI~1x` is not a short name.
 *
 * A real 8.3 name part is at most eight characters; that last rule is checked
 * in code rather than spelt in the pattern, where it would be unreadable.
 */
const SHORT_NAME_SEGMENT_RE =
  /(?:^|(?<=[\\/]))[A-Za-z0-9_-]{1,6}~[0-9]{1,6}(?:\.[A-Za-z0-9_-]{1,3})?(?=[\\/]|$)/g;

/**
 * HIDE THE TILDES THAT ARE PART OF A WINDOWS SHORT PATH, so the allowlist below
 * never sees them. Every other character — and every OTHER tilde — is passed
 * through untouched and still checked exactly as it always was.
 *
 * WHY THIS EXISTS (2026-08-12). Windows gives every name longer than eight
 * characters a second, short name: a user called `Administrator` owns
 * `C:\Users\ADMINI~1`, and on a GitHub runner `os.tmpdir()` really is
 * `C:\Users\RUNNER~1\AppData\Local\Temp`. The engine passes its own temp and
 * worktree paths as arguments (`git worktree add <target>`, `codex -C <cwd>`),
 * so on any machine whose username is over eight characters THE ENGINE REFUSED
 * ITS OWN PATHS — 36 tests red on `windows-latest`, for a path the operating
 * system handed us. That is a whole class of machine, not one runner.
 *
 * WHY MASK RATHER THAN ADD `~` TO THE ALLOWLIST. Adding the character would let
 * a tilde appear ANYWHERE, including at the start of an argument — which is
 * precisely the shape the guard exists to stop. Masking removes exactly the
 * tildes we can prove are inert and leaves the refusal surface untouched
 * everywhere else: a `~` outside this shape survives the mask and is refused by
 * the same regex as before.
 *
 * WHY THE MASKED SHAPE IS INERT IN EVERY SHELL WE SPAWN INTO. All of this rests
 * on the one invariant spelt out on `SHORT_NAME_SEGMENT_RE` above: a masked
 * tilde always has an ordinary name character immediately to its left, and that
 * stays true however the checked string is later pasted into a bigger one.
 * - `sh` / `bash` / `zsh` expand a tilde only when it BEGINS a word, or (a bash
 *   extension) when it immediately follows an unquoted `=` or `:` in an
 *   assignment-shaped word. A tilde with a name character on its left is in
 *   none of those positions, so neither case can arise.
 * - zsh's other tilde (the exclusion operator in an extended glob) only applies
 *   inside a pattern, and every glob character is still refused outright.
 * - `cmd.exe` gives a bare tilde no meaning at all. Its one tilde syntax is
 *   `%~1`, and `%` is still refused.
 * - The `git` / `gh` fast path spawns with an argv ARRAY and no shell, so there
 *   is no expansion there to reason about in the first place.
 *
 * WHY NOT EXPAND THE SHORT PATH TO ITS LONG FORM INSTEAD. That was the other
 * candidate and it is worse here. Node can only do it with
 * `fs.realpathSync.native()`, which needs the path to ALREADY EXIST — and the
 * commonest short path in this codebase is `git worktree add <target>`, whose
 * target does not exist yet, so it would fail exactly where it is needed. It
 * would also turn a pure, total, synchronous string check into one that touches
 * the disk and can fail for reasons that have nothing to do with safety, and it
 * would change the argument actually handed to the child (and so the CLI's own
 * record of it). A validator that reads the disk is a validator that cannot be
 * proven on a Linux CI runner. This rule is pure and platform-independent: the
 * same assertions run unchanged on Windows, macOS and Linux.
 */
function maskShortNames(value: string): string {
  if (!value.includes("~")) return value;   // the overwhelmingly common case
  return value.replace(SHORT_NAME_SEGMENT_RE, seg =>
    // a genuine 8.3 name part is eight characters at most, extension aside
    seg.split(".")[0]!.length <= 8 ? seg.replace("~", "-") : seg);
}

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
  if (!SAFE_ARG_RE.test(maskShortNames(value))) throw new UnsafeArgumentError(value);
  return value;
}

/**
 * Check a filesystem path and quote it if it contains spaces. Still refuses
 * every shell metacharacter — a path with a `&` in it does not get to run.
 */
export function shellQuote(value: string): string {
  if (!SAFE_PATH_RE.test(maskShortNames(value))) throw new UnsafeArgumentError(value);
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

/**
 * Stop a runaway harness from eating memory through its own output.
 *
 * RAISED FROM 2 MB ON 2026-08-07, and the reason is the whole point of this
 * branch. The clock used to bound how much a turn could ever emit; "work all
 * night" now means a real turn can print far more than a three-minute one ever
 * could, and `claude -p --output-format stream-json` puts EVERY tool result on
 * stdout. 2 MB was reachable in an evening.
 */
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

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
      // ONE PROCESS INSTEAD OF TWO, where a shell was never needed. See
      // `REAL_EXECUTABLES` — this is the whole of the difference, and everything
      // below (the clocks, the capture, the stop scope, the kill) is identical
      // either way, because both branches hand back the same kind of child.
      child = REAL_EXECUTABLES.has(cmd) && !opts.detached
        && isRealProgram(cmd, opts.env ?? process.env)
        ? spawn(cmd, args.map(a => (a === EMPTY_ARG ? "" : a)), {
          windowsHide: true,
          cwd: opts.cwd,
          env: opts.env,
          stdio: ["pipe", "pipe", "pipe"],
        })
        : spawn(line, {
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

    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
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

    /** did we have to drop the beginning of either stream? */
    let truncated = false;
    child.stdout?.on("data", d => {
      const capped = capBytes(Buffer.concat([stdout, Buffer.from(d)]));
      stdout = capped.bytes;
      if (capped.truncated) truncated = true;
      if (watch) feed(Buffer.from(d).toString("utf8"));
    });
    child.stderr?.on("data", d => {
      const capped = capBytes(Buffer.concat([stderr, Buffer.from(d)]));
      stderr = capped.bytes;
      if (capped.truncated) truncated = true;
    });

    // THE ONE CLOCK LEFT, AND ONLY WHEN THERE IS A NUMBER TO ARM IT WITH.
    // `NO_TIME_LIMIT` — what every agent turn is run under — is not finite, so
    // no timer is created at all: nothing to fire, nothing to hold the event
    // loop, nothing to clear. Ordinary commands (git, gh, a version probe, a
    // hook) still get their few seconds, for the reasons on `timeoutMs`.
    let timer: NodeJS.Timeout | undefined;
    if (Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        killTree(child.pid);
        finish({ code: null, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"),
          timedOut: true, notFound: false, truncated });
      }, timeoutMs);
    }
    /** stop the clock. Every path out of the run calls this exactly once. */
    const clearClocks = (): void => {
      if (timer) clearTimeout(timer);
    };

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
      finish({ code: null, stdout: stdout.toString("utf8"), stderr: String(err),
        timedOut: false, notFound: true, truncated });
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
        finish({ code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"),
          timedOut: false, notFound: false, stopped: true, truncated });
        return;
      }
      finish({
        code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), timedOut: false,
        notFound: isNotFound(code, stderr.toString("utf8")), truncated,
      });
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

/**
 * KEEP THE END, NOT THE BEGINNING — changed 2026-08-07, and it was silently
 * losing answers.
 *
 * This used to keep the FIRST `MAX_CAPTURE_BYTES` and throw the rest away. With
 * a clock on every turn that was survivable. Without one it is not: a turn that
 * works all night sails past the cap, and because a harness announces its result
 * at the END of the stream, what was kept was a mid-session fragment. The run
 * exited 0, nothing had timed out, the record said `ok`, and the owner was
 * handed a piece of a tool result as his answer.
 *
 * The end is where the answer is, so the end is what is kept. A first line
 * sliced in half is ordinary mid-stream to the reader (`traceWalker.feed`
 * already treats a half-written line as noise, because a chunk boundary lands
 * mid-line all the time), so nothing downstream has to learn a new rule.
 */
function capBytes(bytes: Buffer): { bytes: Buffer; truncated: boolean } {
  if (bytes.length <= MAX_CAPTURE_BYTES) return { bytes, truncated: false };
  let start = bytes.length - MAX_CAPTURE_BYTES;
  // The stream is valid UTF-8, but the byte cap may land on a continuation
  // byte. Drop that incomplete code point so the final decode never invents a
  // replacement character at the retained-tail boundary.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return { bytes: Buffer.from(bytes.subarray(start)), truncated: true };
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
