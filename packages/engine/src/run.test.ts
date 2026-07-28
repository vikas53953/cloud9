// Command-line safety and the wall-clock leash.
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
import { run, safeArg, shellQuote, UnsafeArgumentError } from "./run.js";

const isWin = process.platform === "win32";

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-kill-"));
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-cap-"));
  const script = path.join(dir, "noisy.js");
  fs.writeFileSync(script, "const s='x'.repeat(1024);for(let i=0;i<4096;i++)console.log(s);");

  const result = await run(process.execPath, [script], { timeoutMs: 60_000 });
  assert.equal(typeof result.stdout, "string", "decoded as text, not Buffers");
  assert.ok(result.stdout.length <= 2 * 1024 * 1024 + 8192,
    `captured ${result.stdout.length} bytes — the 2MB cap did not hold`);
  assert.ok(result.stdout.length > 1024, "it really did produce output");
});

test("a detached spawn of a missing command does not crash the process", async () => {
  // an unhandled 'error' event here would take the whole engine host down
  const result = await run(isWin ? "cloud9-no-such-cli" : "cloud9-no-such-cli", ["login"], { detached: true });
  assert.equal(result.notFound, false, "detached calls return immediately, by design");
  await new Promise(r => setTimeout(r, 300)); // long enough for a late 'error'
});
