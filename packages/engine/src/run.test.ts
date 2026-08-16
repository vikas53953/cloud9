import { tempDir } from "./tmp-for-tests.js";
// Command-line safety and process-tree stopping.
//
// Everything here runs through `shell: true`, so an argument that escapes its
// quoting is a remote-code-execution bug. These tests assert the module REFUSES
// dangerous input rather than trying to escape it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef, validateAgentInput } from "@cloud9/shared";
import { codexArgs } from "./codex.js";
import { commandLine, run, safeArg, shellQuote, UnsafeArgumentError } from "./run.js";

const isWin = process.platform === "win32";

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: {
    webSearch: true, files: true, helpers: true, commands: true,
    schedules: false, background: false,
  },
  provider: "codex", createdAt: 0, ...over,
});

/** Every shape of shell mischief we can think of. */
const NASTY = [
  "x&&echo pwned",
  "x & echo pwned",
  "x | echo pwned",
  "x; echo pwned",
  "x$(echo pwned)",
  "x`echo pwned`",
  "x\necho pwned",
  "x > pwned.txt",
  "x||echo pwned",
  'x" && echo pwned && "',
  "x%CD%",
];

test("safeArg refuses every shell metacharacter", () => {
  for (const value of NASTY) {
    assert.throws(() => safeArg(value), UnsafeArgumentError, `accepted: ${value}`);
  }
  // ordinary values still pass
  for (const value of ["gpt-5.6-sol", "read-only", "--json", "approval_policy=never"]) {
    assert.equal(safeArg(value), value);
  }
});

test("shellQuote refuses metacharacters in paths and quotes plain spaces", () => {
  assert.equal(shellQuote("C:/data/a1"), "C:/data/a1");
  assert.equal(shellQuote("C:/Vik As/a1"), '"C:/Vik As/a1"');
  for (const value of ["C:/data/a1&calc", "C:/data/$(calc)", 'C:/da"ta']) {
    assert.throws(() => shellQuote(value), UnsafeArgumentError, `accepted: ${value}`);
  }
});

// ===== WINDOWS 8.3 SHORT PATHS (2026-08-12) — start =====
//
// Windows gives every name longer than eight characters a second, SHORT name:
// `Administrator` is also `ADMINI~1`, and a GitHub runner's own `os.tmpdir()`
// really is `C:\Users\RUNNER~1\AppData\Local\Temp`. The engine hands its own
// temp and worktree paths to `git` and `codex` as arguments, so while the
// allowlist refused every tilde the engine REFUSED ITS OWN PATHS on any machine
// whose username is over eight characters — dozens of tests red on
// `windows-latest`, for a path the operating system itself handed us.
//
// The rule that fixes it must not buy that back by letting a tilde-expansion
// shape through, so both halves are asserted here, and neither half is guarded
// on `process.platform`: the rule is a pure string check, so these exact
// assertions run and must pass on Linux and macOS CI too.

/** Real short paths, of the kind Windows hands us. All of these must run. */
const SHORT_PATHS = [
  "C:\\Users\\ADMINI~1\\AppData\\Local\\Temp\\cloud9-abc",
  "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\cloud9-abc",
  "C:/Users/RUNNER~1/AppData/Local/Temp/cloud9-abc",
  "C:\\PROGRA~1\\MICROS~1\\bin",          // two short segments in one path
  "C:\\Users\\RUNNER~1\\LONGFI~1.TXT",    // a short FILE name, extension and all
  "RUNNER~1\\sub",                        // relative — the segment can start the string
  "C:\\Users\\RUNNER~1",                  // the segment can also end it
];

/** Every tilde shape a shell would actually expand. All of these must be refused. */
const TILDE_EXPANSIONS = [
  "~",
  "~/x",
  "~root/x",
  "~root",
  "~/.ssh/id_rsa",
  "~1",                                   // digits, but nothing before the tilde
  "~+/x",
  "C:\\Users\\~1\\x",                     // tilde starts the segment
  "C:\\Users\\ADMINI~\\x",                // tilde with no digits after it
  "C:\\Users\\ADMINI~1x\\y",              // digits do not run to the end of the segment
  "C:\\ABCDEFG~12345678\\x",              // far too long to be an 8.3 name
  "PATH=~/x",                             // bash expands a tilde straight after `=`
  "PATH=C:\\x:~/y",                       // ...and straight after a `:`
];

test("a Windows 8.3 short path is accepted by both gates", () => {
  for (const value of SHORT_PATHS) {
    assert.equal(safeArg(value), value, `refused: ${value}`);
    assert.equal(shellQuote(value), value, `refused: ${value}`);
    // and end to end, through the one place a command line is built
    assert.equal(commandLine("git", ["-C", value, "status"]), `git -C ${value} status`);
  }
  // a short path with a space in it is still quoted, exactly as a long one is
  assert.equal(
    shellQuote("C:\\Users\\RUNNER~1\\Vik As\\a1"),
    '"C:\\Users\\RUNNER~1\\Vik As\\a1"',
  );
});

test("a tilde that a shell would expand is still refused", () => {
  for (const value of TILDE_EXPANSIONS) {
    assert.throws(() => safeArg(value), UnsafeArgumentError, `accepted: ${value}`);
    assert.throws(() => shellQuote(value), UnsafeArgumentError, `accepted: ${value}`);
  }
  // a lone tilde surrounded by spaces goes down the path branch; still refused
  assert.throws(() => shellQuote("foo ~ bar"), UnsafeArgumentError);
  assert.throws(() => shellQuote("foo ~/x bar"), UnsafeArgumentError);
});

test("a short path does not smuggle a metacharacter past the guard", () => {
  // the point of the whole rule: recognising `RUNNER~1` must not soften ANY
  // other part of the allowlist, so every nasty shape is still refused when it
  // is glued onto a perfectly legitimate short path.
  for (const nasty of NASTY) {
    const value = `C:\\Users\\RUNNER~1\\${nasty}`;
    assert.throws(() => safeArg(value), UnsafeArgumentError, `accepted: ${value}`);
    assert.throws(() => shellQuote(value), UnsafeArgumentError, `accepted: ${value}`);
  }
  // and a second tilde outside the shape is not covered by the first one
  assert.throws(() => safeArg("C:\\Users\\RUNNER~1\\~/x"), UnsafeArgumentError);
});

// The five shapes below are PINS. They all behave correctly today; they are
// written down so that a later widening of the rule cannot change any of them
// without a test going red. Review of PR #48 asked for each one by name.

test("PIN: a tilde straight after a flag's `=` is refused", () => {
  // `--flag=~1` has digits after the tilde, so it is close to the accepted
  // shape — but nothing precedes the tilde inside the segment, and in bash a
  // tilde right after an unquoted `=` really does expand. It is the shape most
  // likely to be waved through as "just a short name", so it is pinned first.
  for (const value of ["--flag=~1", "--flag=~/x", "=~1"]) {
    assert.throws(() => safeArg(value), UnsafeArgumentError, `accepted: ${value}`);
    assert.throws(() => shellQuote(value), UnsafeArgumentError, `accepted: ${value}`);
  }
});

test("PIN: the colon family is refused", () => {
  // bash also expands a tilde straight after a `:` in an assignment-shaped word,
  // and a drive-relative `C:~1` is not a path segment either. None of these has
  // a name character before the tilde that follows a path separator.
  for (const value of [":~1", "a:b~1", "C:~1"]) {
    assert.throws(() => safeArg(value), UnsafeArgumentError, `accepted: ${value}`);
    assert.throws(() => shellQuote(value), UnsafeArgumentError, `accepted: ${value}`);
  }
});

test("PIN: a tilde anchored on a space is refused", () => {
  // a space ends a word, so `~1` here IS word-initial and would expand.
  assert.throws(() => shellQuote("a ~1"), UnsafeArgumentError);
  assert.throws(() => safeArg("a ~1"), UnsafeArgumentError);
});

test("PIN: a checked FRAGMENT cannot smuggle a tilde into the finished argument", () => {
  // `safeArg` is called on fragments that are then pasted into a bigger string
  // (codex.ts:581 `…url=${safeArg(ticket.url)}`, codex.ts:727
  // `model_reasoning_effort=${safeArg(effort)}`), so the `^` in the pattern
  // anchors the FRAGMENT, not the argument. What protects the finished argument
  // is the invariant — a name character immediately left of the tilde — plus
  // `commandLine` checking the composed string all over again.

  // 1. nothing before the tilde: refused at the fragment gate, so the fragment
  //    can never contribute a leading tilde to whatever it is pasted into.
  assert.throws(() => safeArg("~1"), UnsafeArgumentError);

  // 2. a name character before the tilde: the fragment passes on its own...
  assert.equal(safeArg("A~1"), "A~1");
  // ...and the COMPOSED argument is then refused by the real gate, because
  // there the `A` follows an `=` rather than a path separator.
  assert.throws(
    () => commandLine("codex", ["-c", "model_reasoning_effort=A~1"]),
    UnsafeArgumentError,
  );

  // 3. the case the rule actually exists for — a tilde genuinely inside a path
  //    segment — passes both the fragment gate and the composed gate.
  const url = "mcp_servers.cloud9.url=C:\\Users\\RUNNER~1\\sock";
  assert.equal(safeArg(url), url);
  assert.equal(commandLine("codex", ["-c", url]), `codex -c ${url}`);
});

test("PIN: a backslash counts as a separator on every platform, and that is safe", () => {
  // The pattern treats `\` as a path separator unconditionally, so `a\b~1` is
  // masked and accepted even on Linux, where `\` is an escape character rather
  // than a separator. That is deliberate and it is safe: the tilde still has
  // `b` immediately to its left, so it is mid-word in every shell, and `sh`
  // resolving `a\b~1` to `ab~1` leaves it mid-word too.
  assert.equal(safeArg("a\\b~1"), "a\\b~1");
  assert.equal(shellQuote("a\\b~1"), "a\\b~1");
  // the invariant is what carries it — remove the character before the tilde
  // and it is refused again, on this platform and every other one.
  assert.throws(() => safeArg("a\\~1"), UnsafeArgumentError);
});

test("run() no longer refuses its own short temp path", async () => {
  // The class, at the boundary that actually broke. `run()` REJECTS an unsafe
  // argument before it spawns anything (the "refuses to execute an unsafe
  // argument at all" test below is the other side of this), so a short path used
  // to come back as an `UnsafeArgumentError` and never reach the command at all.
  // Now it gets through the guard and the run reports on the COMMAND rather than
  // on the argument. The command is deliberately one that does not exist, so
  // nothing is executed either way and the two outcomes cannot be confused.
  const short = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\cloud9-abc";
  const r = await run("cloud9-no-such-command", ["-C", short]);
  assert.equal(r.notFound, true);
  // and the opposite case is unchanged, on the very same short path
  await assert.rejects(
    () => run("cloud9-no-such-command", ["-C", `${short}&&echo pwned`]),
    UnsafeArgumentError,
  );
});
// ===== WINDOWS 8.3 SHORT PATHS — end =====

test("a model id with shell metacharacters is rejected, not escaped", () => {
  // gate 1: the shared validator the relay uses
  assert.ok(validateAgentInput({ name: "Scout", model: "x&&echo pwned" }));
  assert.equal(validateAgentInput({ name: "Scout", model: "gpt-5.6-sol" }), null);
  // gate 2: the engine, at the moment it would become a command line
  assert.throws(() => codexArgs(agent({ model: "x&&echo pwned" }), "C:/data/a1"), /bad model id|refusing/);
  // the safe one still builds
  assert.ok(codexArgs(agent({ model: "gpt-5.6-sol" }), "C:/data/a1").includes("gpt-5.6-sol"));
});

test("oversized agent fields are rejected", () => {
  assert.ok(validateAgentInput({ name: "x".repeat(65) }));
  assert.ok(validateAgentInput({ name: "Scout", persona: "x".repeat(8001) }));
  assert.ok(validateAgentInput({ name: "" }));
  assert.ok(validateAgentInput({ name: "Scout", provider: "bash" }));
  assert.equal(validateAgentInput({ name: "Scout", persona: "fine", provider: "codex" }), null);
});

test("run() refuses to execute an unsafe argument at all", async () => {
  await assert.rejects(
    () => run("cmd-that-does-not-exist", ["a&&echo pwned"]),
    UnsafeArgumentError,
  );
});

test("run() kills the whole process tree when it times out", async () => {
  const dir = tempDir("cloud9-kill-");
  const beat = path.join(dir, "beat.txt");
  // A child that spawns a GRANDCHILD which keeps writing. Killing only the
  // shell would leave the grandchild ticking — that is the bug under test.
  const grandchild =
    `const fs=require('fs');setInterval(()=>fs.writeFileSync(${JSON.stringify(beat)},String(Date.now())),100);` +
    `setTimeout(()=>process.exit(0),60000);`;
  const script = path.join(dir, "spawner.js");
  fs.writeFileSync(script,
    `const {spawn}=require('child_process');` +
    `spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});` +
    `setTimeout(()=>{},60000);`);

  // The leash must not fire before the grandchild is actually alive, or the
  // test proves nothing and fails for the wrong reason (node can take over a
  // second to boot on a loaded machine). So: start the run, WAIT for the
  // grandchild to announce itself, and only then let the timeout land.
  const started = Date.now();
  const pending = run(process.execPath, [script], { timeoutMs: 8_000 });

  const aliveBy = Date.now() + 30_000;
  while (!fs.existsSync(beat) && Date.now() < aliveBy) {
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(fs.existsSync(beat), "the grandchild really did start");

  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 30_000, "the leash actually fired");

  // The tree-kill is asynchronous and best-effort (`taskkill /T /F` on Windows),
  // so this WAITS for the beat to stop rather than assuming a fixed delay is
  // enough — on a loaded machine one more beat can land after the kill is sent.
  // The assertion is unchanged: within the budget, the grandchild must go quiet
  // and STAY quiet. Only the impatience is gone.
  const quietFor = 1200;
  const budget = Date.now() + 20_000;
  let wentQuiet = false;
  while (Date.now() < budget) {
    const first = fs.readFileSync(beat, "utf8");
    await new Promise(r => setTimeout(r, quietFor));
    if (fs.readFileSync(beat, "utf8") === first) { wentQuiet = true; break; }
  }
  assert.ok(wentQuiet, "the grandchild is STILL alive well after the timeout — the tree was not killed");
});

test("output is captured as text and capped", async () => {
  // an inline `-e` program would (correctly) be refused by the allowlist, so
  // the noisy program goes in a file — the same route real CLIs take
  const dir = tempDir("cloud9-cap-");
  const script = path.join(dir, "noisy.js");
  fs.writeFileSync(script, "const s='x'.repeat(1024);for(let i=0;i<4096;i++)console.log(s);");

  const result = await run(process.execPath, [script], { timeoutMs: 60_000 });
  assert.equal(typeof result.stdout, "string", "decoded as text, not Buffers");
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 16 * 1024 * 1024,
    `captured ${Buffer.byteLength(result.stdout, "utf8")} bytes — the 16MB cap did not hold`);
  assert.ok(result.stdout.length > 1024, "it really did produce output");
});

test("UTF-8 capture is byte-capped, valid, and keeps the answer tail", async () => {
  const dir = tempDir("cloud9-utf8-cap-");
  const script = path.join(dir, "unicode.js");
  fs.writeFileSync(script,
    "process.stdout.write('😀'.repeat(4194310));" +
    "process.stdout.write('\\nFINAL-ANSWER-TAIL');");

  const result = await run(process.execPath, [script], { timeoutMs: 60_000 });
  assert.equal(result.truncated, true, "the multibyte fixture did exceed the cap");
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 16 * 1024 * 1024,
    "the retained output exceeded 16 MiB in UTF-8 bytes");
  assert.doesNotMatch(result.stdout, /�/, "the tail starts with a split UTF-8 code point");
  assert.match(result.stdout, /FINAL-ANSWER-TAIL$/, "the answer tail was lost");
});

test("a detached spawn of a missing command does not crash the process", async () => {
  // an unhandled 'error' event here would take the whole engine host down
  const result = await run(isWin ? "cloud9-no-such-cli" : "cloud9-no-such-cli", ["login"], { detached: true });
  assert.equal(result.notFound, false, "detached calls return immediately, by design");
  await new Promise(r => setTimeout(r, 300)); // long enough for a late 'error'
});
