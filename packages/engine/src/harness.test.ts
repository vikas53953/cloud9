// Harness detection + sign-in state machine, driven through REAL child
// processes: fake `claude` / `codex` executables are written to a temp folder
// and put on PATH, exactly the way the shipped code finds the real ones.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessState } from "@cloud9/shared";
import { HarnessManager, detectClaude, detectCodex, extractSetupToken } from "./harness.js";
import { run } from "./run.js";

const isWin = process.platform === "win32";

/** A fake token the shim prints — shaped like the real one, worth nothing. */
const FAKE_TOKEN = "sk-user-test0123456789abcdefghij";

function shimDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-shims-"));
}

function writeShim(dir: string, name: string, cmd: string, sh: string): void {
  if (isWin) fs.writeFileSync(path.join(dir, `${name}.cmd`), cmd);
  else fs.writeFileSync(path.join(dir, name), sh, { mode: 0o755 });
}

function writeClaudeShim(dir: string, opts: { loggedIn: boolean }): void {
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
      `echo {"loggedIn": ${opts.loggedIn}, "email": "vikas@example.com", "subscriptionType": "max"}`,
      `exit /b ${opts.loggedIn ? 0 : 1}`,
      ":token",
      "echo Opening your browser to authorise Cloud9...",
      `echo ${FAKE_TOKEN}`,
      "exit /b 0",
      "",
    ].join("\r\n"),
    [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "2.1.220 (Claude Code)"; exit 0; fi',
      `if [ "$1" = "auth" ]; then echo '{"loggedIn": ${opts.loggedIn}, "email": "vikas@example.com", "subscriptionType": "max"}'; exit ${opts.loggedIn ? 0 : 1}; fi`,
      `if [ "$1" = "setup-token" ]; then echo "Opening your browser..."; echo "${FAKE_TOKEN}"; exit 0; fi`,
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

test("extractSetupToken takes the token and nothing else", () => {
  assert.equal(extractSetupToken(`Opening browser...\n${FAKE_TOKEN}\nDone.`), FAKE_TOKEN);
  assert.equal(extractSetupToken("no token here"), undefined);
});

test("detects an installed, signed-in Claude", async () => {
  const dir = shimDir();
  writeClaudeShim(dir, { loggedIn: true });
  await withPath(dir, async () => {
    const info = await detectClaude(run, "claude");
    assert.equal(info.installed, true);
    assert.equal(info.signedIn, true);
    assert.equal(info.account, "vikas@example.com");
    assert.match(info.version ?? "", /2\.1\.220/);
  });
});

test("detects an installed, signed-OUT Claude", async () => {
  const dir = shimDir();
  writeClaudeShim(dir, { loggedIn: false });
  await withPath(dir, async () => {
    const info = await detectClaude(run, "claude");
    assert.equal(info.installed, true);
    assert.equal(info.signedIn, false);
    assert.match(info.detail ?? "", /not signed in/);
  });
});

test("a harness that isn't installed is reported in plain words", async () => {
  const info = await detectClaude(run, "cloud9-no-such-cli", 15_000);
  assert.equal(info.installed, false);
  assert.equal(info.signedIn, false);
  assert.match(info.detail ?? "", /isn't installed/);
});

test("detects Codex from its exit code and stderr line", async () => {
  const dir = shimDir();
  const state = path.join(dir, "codex-state.txt");
  writeCodexShim(dir, state);
  await withPath(dir, async () => {
    const out = await detectCodex(run, "codex");
    assert.equal(out.installed, true);
    assert.equal(out.signedIn, false);
    fs.writeFileSync(state, "signed-in");
    const inn = await detectCodex(run, "codex");
    assert.equal(inn.signedIn, true);
    assert.equal(inn.account, "ChatGPT account");
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
    const mgr = new HarnessManager({ pollIntervalMs: 60_000, pollTimeoutMs: 300_000, log: () => {} });
    const started = Date.now();
    const pending = mgr.signIn("codex");
    await new Promise(r => setTimeout(r, 200));
    mgr.stop();
    await pending; // must not wait out the 60s sleep
    assert.ok(Date.now() - started < 15_000, "stop() left the caller hanging");
  });
});

test("Sign in with Claude captures the token and hands it over — never logs it", async () => {
  const dir = shimDir();
  writeClaudeShim(dir, { loggedIn: true });
  writeCodexShim(dir, path.join(dir, "state.txt"));
  await withPath(dir, async () => {
    const tokens: string[] = [];
    const logs: string[] = [];
    const states: HarnessState[] = [];
    const mgr = new HarnessManager({
      onClaudeToken: t => { tokens.push(t); },
      onChange: s => states.push(structuredClone(s)),
      log: m => logs.push(m),
    });
    await mgr.signIn("claude");
    assert.deepEqual(tokens, [FAKE_TOKEN]);
    // signingIn is shown while it runs, and cleared once done
    assert.ok(states.some(s => s.claude.signingIn === true), "UI is told a sign-in started");
    assert.ok(!states[states.length - 1].claude.signingIn, "signingIn cleared at the end");
    // secrets law: length may be logged, the value never
    assert.ok(logs.some(l => /length \d+/.test(l)));
    assert.ok(!logs.some(l => l.includes(FAKE_TOKEN)), "the token must never reach a log");
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
      pollIntervalMs: 50, pollTimeoutMs: 15_000, log: () => {},
    });
    const before = await detectCodex(run, "codex");
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
    const mgr = new HarnessManager({ pollIntervalMs: 30, pollTimeoutMs: 200, log: () => {} });
    const after = await mgr.signIn("codex");
    assert.equal(after.codex.signedIn, false);
    assert.equal(after.codex.signingIn, undefined, "not left stuck in 'signing in'");
    mgr.stop();
  });
});
