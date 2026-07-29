// Start a throwaway Cloud9 stack for QA, on a FRESH DATABASE every run.
//
// Why this exists (feedback round 1, his 15): QA used to run against the same
// long-lived `cloud9-relay.db`, so every run left behind more test people,
// test agents and test channels — and Vikas saw that junk in his real app.
// The class fix is that a QA run can never touch real data at all: this script
// hands the relay and the engine host a brand-new temp folder, and deletes it
// afterwards. Nothing here writes to the repo's own database.
//
// Usage:
//   node scripts/qa-stack.mjs                  # stack + UI, then run the QA scripts
//   node scripts/qa-stack.mjs --stack-only     # just the stack; Ctrl+C to stop
//   node scripts/qa-stack.mjs --no-ui          # relay + engine only (no vite)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newQaOwnerToken } from "./qa-target.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const stackOnly = args.includes("--stack-only");
const noUi = args.includes("--no-ui") || stackOnly;

const RELAY_PORT = Number(process.env.CLOUD9_RELAY_PORT ?? 8799);
const UI_PORT = Number(process.env.CLOUD9_UI_PORT ?? 4173);
/**
 * A QA run gets its own owner key, so it is never the shipped default — and the
 * SAME key is handed down to every QA script below (`CLOUD9_OWNER_TOKEN`), so
 * the hub and the suite can never disagree about what it is. They used to: the
 * stack minted one here and the scripts typed "dev-owner-token" into the join
 * screen, which meant the owner simply could not sign in.
 */
const OWNER_TOKEN = process.env.CLOUD9_OWNER_TOKEN ?? newQaOwnerToken();

// ---- sweep anything an earlier run left behind ----
// A run that was killed outright (task manager, a closed terminal) can't run
// its own cleanup, and on Windows a locked SQLite file can outlive the process.
// So every run starts by clearing old QA workspaces: junk can never accumulate,
// whatever happened last time.
function sweepStaleWorkspaces() {
  let swept = 0;
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir()); } catch { return; }
  for (const entry of entries) {
    if (!entry.startsWith("cloud9-qa-")) continue;
    try { fs.rmSync(path.join(os.tmpdir(), entry), { recursive: true, force: true }); swept++; }
    catch { /* still locked by a run that is genuinely alive — leave it */ }
  }
  if (swept > 0) console.log(`[qa-stack] cleared ${swept} leftover QA workspace(s)`);
}
sweepStaleWorkspaces();

// ---- the fresh workspace ----
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-qa-"));
const dbPath = path.join(workspace, "qa-relay.db");
const engineData = path.join(workspace, "engine");
fs.mkdirSync(engineData, { recursive: true });
console.log(`[qa-stack] fresh workspace: ${workspace}`);
console.log(`[qa-stack] database: ${dbPath} (deleted when this exits)`);

const children = [];

function start(name, command, cmdArgs, env, cwd = repo) {
  const child = spawn(command, cmdArgs, {
    cwd, shell: process.platform === "win32",
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const tag = line => `[${name}] ${line}`;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", d => process.stdout.write(String(d).replace(/^/gm, tag(""))));
  child.stderr.on("data", d => process.stderr.write(String(d).replace(/^/gm, tag(""))));
  child.on("error", err => console.error(`[qa-stack] ${name} failed to start:`, err.message));
  children.push({ name, child });
  return child;
}

async function waitForPort(port, seconds) {
  const deadline = Date.now() + seconds * 1000;
  const net = await import("node:net");
  while (Date.now() < deadline) {
    const open = await new Promise(resolve => {
      const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
        socket.end(); resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
    });
    if (open) return true;
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

/**
 * Give up, tidy up, and — crucially — STOP.
 *
 * `cleanup` schedules the workspace delete on a timer, so calling it does not
 * end this script: every `cleanup(1)` used to fall straight through into the
 * next line. The port-clash guard below announced "something is already using
 * this port, try again" and then cheerfully started a hub anyway. A harness
 * that carries on after saying it stopped cannot be trusted about anything, so
 * an abort now really is an abort.
 */
function abort(code, message) {
  console.error(message);
  cleanup(code);
  return new Promise(() => { /* nothing after an abort ever runs */ });
}

let cleaned = false;
function cleanup(code = 0) {
  if (cleaned) return;
  cleaned = true;
  for (const { child } of children) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        child.kill("SIGTERM");
      }
    } catch { /* best effort */ }
  }
  // The whole point: the QA data goes away with the run. On Windows the relay's
  // SQLite WAL stays locked for a moment after the child is killed, so this
  // retries rather than leaving a stale database behind — a leftover QA
  // database is exactly the junk this script exists to prevent.
  let tries = 0;
  const sweep = () => {
    tries++;
    try {
      fs.rmSync(workspace, { recursive: true, force: true });
      console.log("[qa-stack] workspace deleted");
      process.exit(code);
    } catch (err) {
      if (tries < 12) { setTimeout(sweep, 500); return; }
      console.error(`[qa-stack] could not delete ${workspace} (${err.code ?? err.message}) — ` +
        "it holds only QA data and can be removed by hand");
      process.exit(code);
    }
  };
  setTimeout(sweep, 700);
}

process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

// ---- bring the stack up ----
// A previous run that was killed outright can leave its relay holding the port.
// Say so plainly instead of letting the hub crash with a stack trace.
if (await waitForPort(RELAY_PORT, 0.5)) {
  await abort(1,
    `[qa-stack] something is already using port ${RELAY_PORT} — probably a QA stack ` +
    "from an earlier run. Close it (or set CLOUD9_RELAY_PORT to a free port) and try again.");
}

start("relay", "node", ["apps/relay/dist/server.js"], {
  CLOUD9_DB: dbPath,
  CLOUD9_OWNER_TOKEN: OWNER_TOKEN,
  CLOUD9_DEV: "1",
  PORT: String(RELAY_PORT),
});
if (!(await waitForPort(RELAY_PORT, 40))) {
  await abort(1, "[qa-stack] the hub did not start — run `npm run build` first");
}
console.log(`[qa-stack] hub ready on :${RELAY_PORT}`);

start("engine", "node", ["scripts/engine-host.mjs"], {
  CLOUD9_RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}`,
  CLOUD9_OWNER_TOKEN: OWNER_TOKEN,
  CLOUD9_ENGINE_DATA: engineData,
  // QA drives the UI, not real models: canned replies keep runs free and fast.
  // This is the ONE place demo mode is switched on by default, and it is a
  // deliberate, named choice by the person running QA — never a launcher
  // quietly deciding it for Vikas (B2). Every canned reply is labelled
  // "[demo — not a real answer]" at the source, so even here nothing can pass
  // itself off as a real answer.
  CLOUD9_DEMO: process.env.CLOUD9_DEMO ?? "1",
});

if (!noUi) {
  start("ui", "npx", ["vite", "preview", "--host", "127.0.0.1", "--port", String(UI_PORT)],
    {}, path.join(repo, "apps", "desktop"));
  if (!(await waitForPort(UI_PORT, 90))) {
    await abort(1, "[qa-stack] the app screen did not start — run `npm run build -w @cloud9/desktop`");
  }
  console.log(`[qa-stack] screen ready on :${UI_PORT}`);
}

if (stackOnly || noUi) {
  console.log("[qa-stack] stack is up. Ctrl+C to stop and delete the QA data.");
} else {
  const scripts = ["scripts/qa.mjs", "scripts/qa-v2.mjs", "scripts/qa-lifecycle.mjs"];
  let failed = 0;
  /* One line per script at the very end.
   *
   * A full run prints thousands of lines, and a single failure two thirds of the
   * way up is invisible by the time it finishes — the last thing on screen was
   * whichever script happened to run last, which said nothing about the one that
   * broke. Every script is run whatever the one before it did, and this says
   * plainly which of them came back clean. It does not soften anything: a script
   * that stopped early already fails inside `reportAndExit`, and that verdict is
   * simply carried here. */
  const verdicts = [];
  for (const script of scripts) {
    console.log(`\n[qa-stack] === ${script} ===`);
    const started = Date.now();
    const code = await new Promise(resolve => {
      const child = spawn("node", [script], {
        cwd: repo, stdio: "inherit", shell: process.platform === "win32",
        env: {
          ...process.env,
          CLOUD9_RELAY_PORT: String(RELAY_PORT),
          CLOUD9_UI_PORT: String(UI_PORT),
          // the one key this stack is actually using — the suite types THIS
          CLOUD9_OWNER_TOKEN: OWNER_TOKEN,
        },
      });
      child.on("close", resolve);
      child.on("error", () => resolve(1));
    });
    verdicts.push({ script, code, seconds: Math.round((Date.now() - started) / 1000) });
    if (code !== 0) failed++;
  }
  console.log("\n[qa-stack] ---- how each script finished ----");
  for (const v of verdicts) {
    console.log(`[qa-stack] ${v.code === 0 ? "PASS" : "FAIL"}  ${v.script}  (${v.seconds}s)`);
  }
  console.log(`\n[qa-stack] ${failed === 0 ? "all QA scripts passed" : `${failed} QA script(s) failed`}`);
  cleanup(failed === 0 ? 0 : 1);
}
