// Harness detection + sign-in state machine, driven through REAL child
// processes: fake `claude` / `codex` executables are written to a temp folder
// and put on PATH, exactly the way the shipped code finds the real ones.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessState } from "@cloud9/shared";
import { HarnessManager, detectClaude, detectCodex, detectGitHub } from "./harness.js";
import { run, RunResult } from "./run.js";

const isWin = process.platform === "win32";

/** A fake token the shim prints — shaped like the real one, worth nothing. */
const FAKE_TOKEN = "sk-user-test0123456789abcdefghij";

const STARTED: RunResult =
  { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false };

function shimDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-shims-"));
}

function writeShim(dir: string, name: string, cmd: string, sh: string): void {
  if (isWin) fs.writeFileSync(path.join(dir, `${name}.cmd`), cmd);
  else fs.writeFileSync(path.join(dir, name), sh, { mode: 0o755 });
}

/**
 * A fake `claude`. With `statePath` it behaves like the real thing during a
 * sign-in: `auth status` answers from a file that `setup-token` creates, so a
 * test can watch the flow actually flip from signed-out to signed-in.
 */
function writeClaudeShim(
  dir: string, opts: { loggedIn: boolean; statePath?: string }, name = "claude",
): void {
  const s = opts.statePath;
  writeShim(dir, name,
    [
      "@echo off",
      'if "%1"=="--version" goto ver',
      'if "%1"=="auth" goto auth',
      'if "%1"=="setup-token" goto token',
      "exit /b 1",
      ":ver",
      "echo 2.1.220 (Claude Code)",
      "exit /b 0",
      ":auth",
      ...(s ? [`if exist "${s}" goto authyes`] : opts.loggedIn ? ["goto authyes"] : []),
      'echo {"loggedIn": false}',
      "exit /b 1",
      ":authyes",
      'echo {"loggedIn": true, "email": "vikas@example.com", "subscriptionType": "max"}',
      "exit /b 0",
      ":token",
      "echo Opening your browser to authorise Cloud9...",
      `echo ${FAKE_TOKEN}`,
      ...(s ? [`echo signed-in> "${s}"`] : []),
      "exit /b 0",
      "",
    ].join("\r\n"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "2.1.220 (Claude Code)"; exit 0; fi',
      'if [ "$1" = "auth" ]; then',
      s
        ? `  if [ -f "${s}" ]; then echo '{"loggedIn": true, "email": "vikas@example.com", "subscriptionType": "max"}'; exit 0; fi`
        : opts.loggedIn
          ? `  echo '{"loggedIn": true, "email": "vikas@example.com", "subscriptionType": "max"}'; exit 0`
          : "  :",
      `  echo '{"loggedIn": false}'; exit 1`,
      "fi",
      'if [ "$1" = "setup-token" ]; then',
      '  echo "Opening your browser..."',
      `  echo "${FAKE_TOKEN}"`,
      ...(s ? [`  echo signed-in > "${s}"`] : []),
      "  exit 0",
      "fi",
      "exit 1",
      "",
    ].join("\n"));
}

/**
 * The codex shim keeps its "logged in" state in a file, so `codex login` really
 * does change what `codex login status` reports — that is the state machine
 * under test. Note it writes its status line to STDERR, like the real CLI.
 */
function writeCodexShim(dir: string, statePath: string): void {
  writeShim(dir, "codex",
    [
      "@echo off",
      'if "%1"=="--version" goto ver',
      'if "%1"=="login" goto login',
      "exit /b 1",
      ":ver",
      "echo codex-cli 0.144.4",
      "exit /b 0",
      ":login",
      'if "%2"=="status" goto status',
      `echo signed-in> "${statePath}"`,
      "exit /b 0",
      ":status",
      `if exist "${statePath}" goto yes`,
      "echo Not logged in 1>&2",
      "exit /b 1",
      ":yes",
      "echo Logged in using ChatGPT 1>&2",
      "exit /b 0",
      "",
    ].join("\r\n"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "codex-cli 0.144.4"; exit 0; fi',
      'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
      `  if [ -f "${statePath}" ]; then echo "Logged in using ChatGPT" >&2; exit 0; fi`,
      '  echo "Not logged in" >&2; exit 1',
      "fi",
      `if [ "$1" = "login" ]; then echo signed-in > "${statePath}"; exit 0; fi`,
      "exit 1",
      "",
    ].join("\n"));
}

/**
 * A fake `gh`. Its signed-in state lives in a file, so `gh auth login` really
 * does change what `gh auth status` reports afterwards — that is the flow the
 * Settings card depends on. It prints to STDERR and includes the masked token
 * and scope lines the REAL gh prints, because "no secret reaches the frame" is
 * only proved against output that actually contains one.
 */
function writeGhShim(dir: string, statePath: string): void {
  const signedIn = [
    "echo github.com 1>&2",
    "echo   Logged in to github.com account vikas53953 (keyring) 1>&2",
    "echo   - Active account: true 1>&2",
    "echo   - Git operations protocol: https 1>&2",
    "echo   - Token: gho_************************************ 1>&2",
    "echo   - Token scopes: 'gist', 'read:org', 'repo', 'workflow' 1>&2",
  ];
  writeShim(dir, "gh",
    [
      "@echo off",
      'if "%1"=="auth" goto auth',
      "exit /b 1",
      ":auth",
      'if "%2"=="status" goto status',
      'if "%2"=="login" goto login',
      "exit /b 1",
      ":login",
      `echo signed-in> "${statePath}"`,
      "exit /b 0",
      ":status",
      `if exist "${statePath}" goto yes`,
      "echo You are not logged into any GitHub hosts. 1>&2",
      "exit /b 1",
      ":yes",
      ...signedIn,
      "exit /b 0",
      "",
    ].join("\r\n"),
    [
      "#!/bin/sh",
      'if [ "$1" != "auth" ]; then exit 1; fi',
      'if [ "$2" = "login" ]; then echo signed-in > "' + statePath + '"; exit 0; fi',
      'if [ "$2" = "status" ]; then',
      `  if [ -f "${statePath}" ]; then`,
      "    echo 'github.com' 1>&2",
      "    echo '  ✓ Logged in to github.com account vikas53953 (keyring)' 1>&2",
      "    echo '  - Git operations protocol: https' 1>&2",
      "    echo '  - Token: gho_************************************' 1>&2",
      "    echo \"  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'\" 1>&2",
      "    exit 0",
      "  fi",
      "  echo 'You are not logged into any GitHub hosts.' 1>&2",
      "  exit 1",
      "fi",
      "exit 1",
      "",
    ].join("\n"));
}

/** Put a folder first on PATH for the duration of one test. */
function withPath<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const before = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${before}`;
  return fn().finally(() => { process.env.PATH = before; });
}

test("detects an installed, signed-in Claude and calls it a CLI login", async () => {
  const dir = shimDir();
  writeClaudeShim(dir, { loggedIn: true });
  await withPath(dir, async () => {
    const info = await detectClaude(run, "claude");
    assert.equal(info.installed, true);
    assert.equal(info.signedIn, true);
    assert.equal(info.account, "vikas@example.com");
    assert.equal(info.authKind, "cli-login", "the app owns the credential, not us");
    assert.match(info.version ?? "", /2\.1\.220/);
    // the model list travels with detection so the picker is never empty
    assert.ok(info.models.includes("claude-sonnet-5"));
    assert.equal(info.defaultModel, "claude-sonnet-5");
    assert.match(info.detail, /Signed in as vikas@example\.com/);
  });
});

test("detects an installed, signed-OUT Claude", async () => {
  const dir = shimDir();
  writeClaudeShim(dir, { loggedIn: false });
  await withPath(dir, async () => {
    const info = await detectClaude(run, "claude");
    assert.equal(info.installed, true);
    assert.equal(info.signedIn, false);
    assert.equal(info.authKind, "none");
    assert.match(info.detail, /not signed in/);
  });
});

test("a harness that isn't installed is reported in plain words", async () => {
  const info = await detectClaude(run, "cloud9-no-such-cli", 15_000);
  assert.equal(info.installed, false);
  assert.equal(info.signedIn, false);
  assert.equal(info.authKind, "none");
  assert.deepEqual(info.models, [], "an app we don't have offers no models");
  assert.match(info.detail, /isn't installed/);
});

test("detects Codex from its exit code and stderr line", async () => {
  const dir = shimDir();
  const state = path.join(dir, "codex-state.txt");
  writeCodexShim(dir, state);
  await withPath(dir, async () => {
    const out = await detectCodex(run, "codex", 20_000, { models: false });
    assert.equal(out.installed, true);
    assert.equal(out.signedIn, false);
    assert.equal(out.authKind, "none");
    fs.writeFileSync(state, "signed-in");
    const inn = await detectCodex(run, "codex", 20_000, { models: false });
    assert.equal(inn.signedIn, true);
    assert.equal(inn.account, "ChatGPT account");
    assert.equal(inn.authKind, "cli-login");
  });
});

test("refresh() publishes one state covering both harnesses", async () => {
  const dir = shimDir();
  writeClaudeShim(dir, { loggedIn: true });
  writeCodexShim(dir, path.join(dir, "state.txt"));
  await withPath(dir, async () => {
    const seen: HarnessState[] = [];
    const mgr = new HarnessManager({ onChange: s => seen.push(structuredClone(s)), log: () => {} });
    const state = await mgr.refresh();
    // one publish to say "checking", one with the answer
    assert.equal(seen[0].checking, true, "the UI is told a check started");
    assert.equal(seen[seen.length - 1].checking, false, "and that it finished");
    assert.equal(state.claude.signedIn, true);
    assert.equal(state.codex.installed, true);
    assert.equal(state.codex.signedIn, false);
    assert.ok(state.updatedAt > 0);
    // the status object must never carry credential material
    assert.ok(!JSON.stringify(state).includes("sk-"));
    mgr.stop();
  });
});

test("concurrent refreshes share one detection round", async () => {
  const dir = shimDir();
  writeClaudeShim(dir, { loggedIn: true });
  writeCodexShim(dir, path.join(dir, "state.txt"));
  await withPath(dir, async () => {
    let spawns = 0;
    const mgr = new HarnessManager({
      log: () => {},
      runner: async (cmd, args, o) => { spawns++; return run(cmd, args, o); },
    });
    const [a, b, c] = await Promise.all([mgr.refresh(), mgr.refresh(), mgr.refresh()]);
    assert.equal(a, b);
    assert.equal(b, c);
    // ONE round is: claude --version, claude auth status, codex --version,
    // codex login status, gh auth status. The cap was 4 until GitHub joined the
    // same round on 2026-08-01 — the number is what a SINGLE round costs, and
    // the point of the check is that three clicks never pay for it twice.
    assert.ok(spawns <= 5, `three clicks spawned ${spawns} processes — the guard did not hold`);
    mgr.stop();
  });
});

test("stop() releases a sign-in that is sleeping between polls", async () => {
  const dir = shimDir();
  writeClaudeShim(dir, { loggedIn: true });
  writeCodexShim(dir, path.join(dir, "nope", "state.txt")); // never completes
  await withPath(dir, async () => {
    const mgr = new HarnessManager({ pollIntervalMs: 60_000, signInTimeoutMs: 300_000, log: () => {} });
    const started = Date.now();
    const pending = mgr.signIn("codex");
    await new Promise(r => setTimeout(r, 200));
    mgr.stop();
    await pending; // must not wait out the 60s sleep
    assert.ok(Date.now() - started < 15_000, "stop() left the caller hanging");
  });
});

// --- security review 2026-07-29, finding #10: Cancel must really cancel ---

test("cancelSignIn stops the wait, and leaves no failure on the card", async () => {
  const dir = shimDir();
  writeClaudeShim(dir, { loggedIn: true });
  writeCodexShim(dir, path.join(dir, "nope", "state.txt")); // never completes
  await withPath(dir, async () => {
    const mgr = new HarnessManager({
      pollIntervalMs: 60_000, signInTimeoutMs: 300_000, log: () => {},
    });
    const started = Date.now();
    const pending = mgr.signIn("codex");
    await new Promise(r => setTimeout(r, 200));
    mgr.cancelSignIn("codex");
    const after = await pending;
    assert.ok(Date.now() - started < 15_000, "Cancel left the user waiting anyway");
    assert.equal(after.codex.signingIn, undefined, "the spinner is gone");
    assert.equal(after.codex.problem, undefined, "walking away is not an error to report");
    // and the harness is usable again straight away
    const again = mgr.signIn("codex");
    await new Promise(r => setTimeout(r, 100));
    mgr.cancelSignIn("codex");
    await again;
    mgr.stop();
  });
});

// --- feedback round 1, his 2/3/4 — the fallback sign-in that used to hang ---

test("the Claude fallback opens a VISIBLE terminal and never reads its output", async () => {
  const dir = shimDir();
  const authState = path.join(dir, "claude-auth.txt");
  writeClaudeShim(dir, { loggedIn: false, statePath: authState });
  writeCodexShim(dir, path.join(dir, "state.txt"));
  await withPath(dir, async () => {
    const visible: { cmd: string; args: string[] }[] = [];
    const logs: string[] = [];
    const states: HarnessState[] = [];
    const mgr = new HarnessManager({
      pollIntervalMs: 30, signInTimeoutMs: 15_000, log: m => logs.push(m),
      onChange: s => states.push(structuredClone(s)),
      // the interactive CLI is handed a real console; nothing is piped back
      visibleRunner: async (cmd, args) => {
        visible.push({ cmd, args });
        fs.writeFileSync(authState, "signed-in"); // the user finishes in that window
        return STARTED;
      },
      // a piped runner here would be the round-1 bug, so make it a failure
      runner: async (cmd, args, o) => {
        assert.notEqual(args[0], "setup-token",
          "setup-token is interactive — it must never be run with piped stdio again");
        return run(cmd, args, o);
      },
    });
    const after = await mgr.signIn("claude");
    assert.deepEqual(visible, [{ cmd: "claude", args: ["setup-token"] }]);
    assert.equal(after.claude.signedIn, true, "polling `auth status` saw the sign-in land");
    assert.equal(after.claude.authKind, "cli-login", "and it is the app's own login, not a token");
    assert.equal(after.claude.signingIn, undefined, "the spinner stopped");
    assert.equal(after.claude.problem, undefined);
    assert.ok(states.some(s => s.claude.signingIn === true), "UI is told a sign-in started");
    // secrets law: no token is captured on this path at all, so none can leak
    assert.ok(!logs.some(l => l.includes(FAKE_TOKEN)), "no token may reach a log");
    assert.ok(!JSON.stringify(after).includes("sk-"), "and none may reach the status object");
    mgr.stop();
  });
});

test("a Claude sign-in the user never finishes gives up inside its cap", async () => {
  const dir = shimDir();
  // auth status never flips: the user closed the window / walked away
  writeClaudeShim(dir, { loggedIn: false, statePath: path.join(dir, "nope", "auth.txt") });
  writeCodexShim(dir, path.join(dir, "nope", "state.txt"));
  await withPath(dir, async () => {
    const mgr = new HarnessManager({
      pollIntervalMs: 30, signInTimeoutMs: 400, log: () => {},
      visibleRunner: async () => STARTED,
    });
    const started = Date.now();
    const after = await mgr.signIn("claude");
    const took = Date.now() - started;
    assert.equal(after.claude.signedIn, false);
    assert.equal(after.claude.signingIn, undefined, "NOT left stuck on 'waiting for you'");
    assert.match(after.claude.problem ?? "", /five minutes|try again/);
    assert.match(after.claude.detail, /try again/, "the card says what happened");
    assert.ok(took < 20_000, `the flow took ${took}ms — it must resolve inside its cap`);
    mgr.stop();
  });
});

test("a Claude app that isn't installed fails the sign-in immediately", async () => {
  const mgr = new HarnessManager({
    claudeCommand: "cloud9-no-such-cli", codexCommand: "cloud9-no-such-cli",
    pollIntervalMs: 30, signInTimeoutMs: 30_000, log: () => {},
    visibleRunner: async () => ({
      code: null, stdout: "", stderr: "not found", timedOut: false, notFound: true,
    }),
  });
  const after = await mgr.signIn("claude");
  assert.equal(after.claude.signingIn, undefined);
  assert.match(after.claude.problem ?? "", /isn't installed/);
  mgr.stop();
});

test("a held credential outranks the app's own login when reporting authKind", async () => {
  const dir = shimDir();
  writeClaudeShim(dir, { loggedIn: true });
  writeCodexShim(dir, path.join(dir, "state.txt"));
  await withPath(dir, async () => {
    const mgr = new HarnessManager({
      log: () => {},
      credentialKind: h => (h === "claude" ? "token" : undefined),
    });
    const state = await mgr.refresh();
    assert.equal(state.claude.authKind, "token", "we bill against the key we hold");
    assert.equal(state.codex.authKind, "none", "and Codex is untouched by it");
    mgr.stop();
  });
});

test("a saved key makes a signed-OUT app usable, and says so in plain words", async () => {
  const dir = shimDir();
  writeClaudeShim(dir, { loggedIn: false });
  writeCodexShim(dir, path.join(dir, "state.txt"));
  await withPath(dir, async () => {
    const mgr = new HarnessManager({
      log: () => {},
      credentialKind: h => (h === "claude" ? "apiKey" : undefined),
    });
    const state = await mgr.refresh();
    assert.equal(state.claude.signedIn, true);
    assert.equal(state.claude.authKind, "apiKey");
    assert.match(state.claude.detail, /key you saved/);
    mgr.stop();
  });
});

test("Sign in with Codex polls until the CLI reports success", async () => {
  const dir = shimDir();
  writeClaudeShim(dir, { loggedIn: true });
  const state = path.join(dir, "state.txt");
  writeCodexShim(dir, state);
  await withPath(dir, async () => {
    const mgr = new HarnessManager({
      pollIntervalMs: 50, signInTimeoutMs: 15_000, log: () => {},
    });
    const before = await detectCodex(run, "codex", 20_000, { models: false });
    assert.equal(before.signedIn, false);
    const after = await mgr.signIn("codex");
    assert.equal(after.codex.signedIn, true, "detached `codex login` flipped the state, polling saw it");
    assert.equal(after.codex.account, "ChatGPT account");
    mgr.stop();
  });
});

test("a codex sign-in that never completes gives up instead of hanging", async () => {
  const dir = shimDir();
  writeClaudeShim(dir, { loggedIn: true });
  // point `codex login` at a path it cannot create, so status never flips
  writeCodexShim(dir, path.join(dir, "nope", "state.txt"));
  await withPath(dir, async () => {
    const mgr = new HarnessManager({ pollIntervalMs: 30, signInTimeoutMs: 200, log: () => {} });
    const after = await mgr.signIn("codex");
    assert.equal(after.codex.signedIn, false);
    assert.equal(after.codex.signingIn, undefined, "not left stuck in 'signing in'");
    assert.match(after.codex.problem ?? "", /try again/);
    mgr.stop();
  });
});

/* =================== GITHUB, THE THIRD CARD IN SETTINGS ===================
 *
 * GitHub is NOT a harness — it runs no turns — but "is this computer signed in
 * to GitHub, and as whom?" is the same shape of question as the two above and
 * travels the same pipe. These drive the REAL child processes, same as every
 * test in this file. */

test("a signed-in GitHub is detected, with the login and the protocol, and a time it was asked", async () => {
  const dir = shimDir();
  const state = path.join(dir, "gh-state.txt");
  fs.writeFileSync(state, "signed-in");
  writeGhShim(dir, state);
  await withPath(dir, async () => {
    const before = Date.now();
    const who = await detectGitHub(run, "gh");
    assert.equal(who.installed, true);
    assert.equal(who.signedIn, true);
    assert.equal(who.login, "vikas53953");
    assert.equal(who.protocol, "https");
    assert.ok(who.checkedAt >= before, "the card may only say 'signed in' about a moment we really asked");
  });
});

test("gh's masked token and its scope list never leave the engine", async () => {
  const dir = shimDir();
  const state = path.join(dir, "gh-state.txt");
  fs.writeFileSync(state, "signed-in");
  writeGhShim(dir, state);
  await withPath(dir, async () => {
    // the shim prints BOTH, exactly as the real gh does — so this is a real test
    const who = await detectGitHub(run, "gh");
    const json = JSON.stringify(who);
    assert.ok(!/gho_/.test(json), `a token shape reached the object: ${json}`);
    assert.ok(!/scope/i.test(json), `a scope list reached the object: ${json}`);
    assert.ok(!/read:org|workflow/.test(json), json);
  });
});

test("installed-but-signed-out is NOT reported as 'not installed'", async () => {
  const dir = shimDir();
  writeGhShim(dir, path.join(dir, "never-written.txt"));
  await withPath(dir, async () => {
    const who = await detectGitHub(run, "gh");
    assert.equal(who.installed, true, "gh answered, so it IS here — it just has nobody signed in");
    assert.equal(who.signedIn, false);
    assert.match(who.detail, /not signed in/i);
    assert.ok(who.checkedAt > 0);
  });
});

test("no gh on the computer is a finding, not a crash", async () => {
  const who = await detectGitHub(run, "cloud9-no-such-gh");
  assert.equal(who.installed, false);
  assert.equal(who.signedIn, false);
  assert.match(who.detail, /isn't installed/i);
});

test("a gh that blows up answers 'not signed in' in plain words, never a stack trace", async () => {
  const exploding = ((): Promise<RunResult> =>
    Promise.reject(new Error("C:\Users\vikasmit\secret path — EPERM"))) as never;
  const who = await detectGitHub(exploding, "gh");
  assert.equal(who.signedIn, false);
  assert.equal(who.installed, false);
  assert.ok(who.detail.length > 0);
  assert.ok(!/vikasmit|EPERM|Error/.test(who.detail),
    `the inside of a program reached the screen: ${who.detail}`);
  assert.ok(who.checkedAt > 0, "a failed look is still a look, and it is stamped");
});

test("a detection round carries GitHub alongside the two AI apps, on one state", async () => {
  const dir = shimDir();
  const gh = path.join(dir, "gh-state.txt");
  fs.writeFileSync(gh, "signed-in");
  writeClaudeShim(dir, { loggedIn: true });
  writeCodexShim(dir, path.join(dir, "codex-state.txt"));
  writeGhShim(dir, gh);
  await withPath(dir, async () => {
    const mgr = new HarnessManager({ log: () => {} });
    const state = await mgr.refresh();
    assert.equal(state.github?.signedIn, true);
    assert.equal(state.github?.login, "vikas53953");
    assert.equal(state.claude.signedIn, true, "GitHub joined the round without disturbing it");
    // and nothing secret rode along on the state every client receives
    assert.ok(!/gho_|scopes/i.test(JSON.stringify(state)));
    mgr.stop();
  });
});

test("Check again really re-runs gh — a sign-in that happened outside Cloud9 is picked up", async () => {
  const dir = shimDir();
  const gh = path.join(dir, "gh-state.txt");
  writeClaudeShim(dir, { loggedIn: true });
  writeCodexShim(dir, path.join(dir, "codex-state.txt"));
  writeGhShim(dir, gh);
  await withPath(dir, async () => {
    const mgr = new HarnessManager({ log: () => {} });
    const out = await mgr.refresh();
    assert.equal(out.github?.signedIn, false);
    const firstLook = out.github?.checkedAt ?? 0;
    assert.ok(firstLook > 0);

    // he signs in elsewhere — in a terminal, or through the button
    fs.writeFileSync(gh, "signed-in");
    await new Promise(r => setTimeout(r, 5));
    const inn = await mgr.refresh();
    assert.equal(inn.github?.signedIn, true,
      "'Check again' asked the computer again rather than repeating what it remembered");
    assert.ok((inn.github?.checkedAt ?? 0) > firstLook, "the freshness stamp moved with the answer");
    mgr.stop();
  });
});

test("Sign in now opens a VISIBLE window, runs GitHub's own command, and never reads its output", async () => {
  const dir = shimDir();
  const gh = path.join(dir, "gh-state.txt");
  writeClaudeShim(dir, { loggedIn: true });
  writeCodexShim(dir, path.join(dir, "codex-state.txt"));
  writeGhShim(dir, gh);
  await withPath(dir, async () => {
    const seen: { cmd: string; args: string[] }[] = [];
    const mgr = new HarnessManager({
      log: () => {},
      pollIntervalMs: 30,
      signInTimeoutMs: 5_000,
      visibleRunner: async (cmd, args) => {
        seen.push({ cmd, args });
        // the window is what the OWNER finishes; here, finishing it is a file
        fs.writeFileSync(gh, "signed-in");
        return STARTED;
      },
    });
    const after = await mgr.signInGitHub();
    assert.deepEqual(seen, [{ cmd: "gh", args: ["auth", "login", "--web", "--git-protocol", "https"] }],
      "the interactive command must go to a real terminal, never to a pipe with nobody at it");
    assert.equal(after.github?.signedIn, true, "polling gh's OWN status is what ended the wait");
    assert.equal(after.github?.signingIn, undefined, "not left spinning");
    assert.equal(after.github?.problem, undefined);
    mgr.stop();
  });
});

test("a GitHub sign-in nobody finishes gives up inside its cap and says so plainly", async () => {
  const dir = shimDir();
  writeClaudeShim(dir, { loggedIn: true });
  writeCodexShim(dir, path.join(dir, "codex-state.txt"));
  writeGhShim(dir, path.join(dir, "nope", "state.txt")); // can never flip
  await withPath(dir, async () => {
    const mgr = new HarnessManager({
      log: () => {}, pollIntervalMs: 30, signInTimeoutMs: 200,
      visibleRunner: async () => STARTED,
    });
    const after = await mgr.signInGitHub();
    assert.equal(after.github?.signedIn, false);
    assert.equal(after.github?.signingIn, undefined, "not left stuck in 'a window is open'");
    assert.match(after.github?.problem ?? "", /try again/);
    mgr.stop();
  });
});

test("gh missing when Sign in now is pressed fails at once instead of waiting five minutes", async () => {
  const mgr = new HarnessManager({
    log: () => {}, ghCommand: "cloud9-no-such-gh",
    pollIntervalMs: 30, signInTimeoutMs: 60_000,
    visibleRunner: async () => ({ code: null, stdout: "", stderr: "", timedOut: false, notFound: true }),
  });
  const started = Date.now();
  const after = await mgr.signInGitHub();
  assert.ok(Date.now() - started < 15_000, "it waited for a window that never opened");
  assert.match(after.github?.problem ?? "", /isn't installed/i);
  mgr.stop();
});

/* ------------------------------------------------------------------------
 * 2026-08-05: "Claude — not installed on this computer · ✗ app not found",
 * on a machine where Claude was installed and signed in the whole time.
 *
 * The app looked at this computer ONCE, at startup, and never again. So a
 * moment when the CLI could not answer — an `npm i -g` rewriting the shim, a
 * busy machine, a scanner holding node.exe — became a permanent verdict, with
 * a greyed-out sign-in button and "install the Claude app first" underneath.
 * These two hold the fix: a missing app is looked for again by itself, and a
 * leash that ran out is never reported as an absence.
 * ---------------------------------------------------------------------- */

test("an app missing for a moment is found again on its own — nobody presses Re-check", async () => {
  const dir = shimDir();
  writeCodexShim(dir, path.join(dir, "codex-state.txt"));
  writeGhShim(dir, path.join(dir, "gh-state.txt"));
  await withPath(dir, async () => {
    /* A NAME NOTHING ELSE ON THIS COMPUTER HAS. The real `claude` is installed
       here, so a shim called "claude" would only ever be shadowing something
       that answers anyway, and round one could never be honestly absent. */
    const mgr = new HarnessManager({
      log: () => {},
      claudeCommand: "cloud9-test-claude",
      // fast enough for a test, same code path the app runs
      relookMissingMs: 50, relookSteadyMs: 60_000,
    });
    const first = await mgr.refresh();
    assert.equal(first.claude.installed, false, "the Claude shim really is absent for round one");

    // ...and now it is back, exactly as an interrupted reinstall would leave it
    writeClaudeShim(dir, { loggedIn: true }, "cloud9-test-claude");

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !mgr.state.claude.installed) {
      await new Promise(r => setTimeout(r, 50));
    }
    assert.equal(mgr.state.claude.installed, true,
      "the app never looked again, so a momentary absence is permanent");
    assert.equal(mgr.state.claude.signedIn, true);
    mgr.stop();
  });
});

test("a detection that ran out of time is not reported as 'not installed'", async () => {
  const timedOut: RunResult =
    { code: null, stdout: "", stderr: "", timedOut: true, notFound: false };
  let asked = 0;
  const runner = async () => { asked++; return timedOut; };
  const info = await detectClaude(runner, "claude", 10);
  assert.equal(asked, 2, "a timeout gets one second chance before anyone is told anything");
  assert.equal(info.installed, false);
  assert.doesNotMatch(info.detail ?? "", /isn't installed|not installed/i,
    "a leash that ran out was reported as an app that is not there");
  assert.match(info.detail ?? "", /did not answer in time/i);
});
