// Harness detection + sign-in state machine, driven through REAL child
// processes: fake `claude` / `codex` executables are written to a temp folder
// and put on PATH, exactly the way the shipped code finds the real ones.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessState } from "@cloud9/shared";
import { HarnessManager, detectClaude, detectCodex } from "./harness.js";
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
function writeClaudeShim(dir: string, opts: { loggedIn: boolean; statePath?: string }): void {
  const s = opts.statePath;
  writeShim(dir, "claude",
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
    assert.ok(spawns <= 4, `three clicks spawned ${spawns} processes — the guard did not hold`);
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
