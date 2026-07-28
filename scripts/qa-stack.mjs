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

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const stackOnly = args.includes("--stack-only");
const noUi = args.includes("--no-ui") || stackOnly;

const RELAY_PORT = Number(process.env.CLOUD9_RELAY_PORT ?? 8799);
const UI_PORT = Number(process.env.CLOUD9_UI_PORT ?? 4173);
/** A QA run gets its own owner token, so it is never the shipped default. */
const OWNER_TOKEN = process.env.CLOUD9_OWNER_TOKEN ?? `qa-owner-${Date.now().toString(36)}`;

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
  console.error(
    `[qa-stack] something is already using port ${RELAY_PORT} — probably a QA stack ` +
    "from an earlier run. Close it (or set CLOUD9_RELAY_PORT to a free port) and try again.");
  cleanup(1);
}

start("relay", "node", ["apps/relay/dist/server.js"], {
  CLOUD9_DB: dbPath,
  CLOUD9_OWNER_TOKEN: OWNER_TOKEN,
  CLOUD9_DEV: "1",
  PORT: String(RELAY_PORT),
});
if (!(await waitForPort(RELAY_PORT, 40))) {
  console.error("[qa-stack] the hub did not start — run `npm run build` first");
  cleanup(1);
}
console.log(`[qa-stack] hub ready on :${RELAY_PORT}`);

start("engine", "node", ["scripts/engine-host.mjs"], {
  CLOUD9_RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}`,
  CLOUD9_OWNER_TOKEN: OWNER_TOKEN,
  CLOUD9_ENGINE_DATA: engineData,
  // QA drives the UI, not real models: canned replies keep runs free and fast
  CLOUD9_DEMO: process.env.CLOUD9_DEMO ?? "1",
});

if (!noUi) {
  start("ui", "npx", ["vite", "preview", "--host", "127.0.0.1", "--port", String(UI_PORT)],
    {}, path.join(repo, "apps", "desktop"));
  if (!(await waitForPort(UI_PORT, 90))) {
    console.error("[qa-stack] the app screen did not start — run `npm run build -w @cloud9/desktop`");
    cleanup(1);
  }
  console.log(`[qa-stack] screen ready on :${UI_PORT}`);
}

if (stackOnly || noUi) {
  console.log("[qa-stack] stack is up. Ctrl+C to stop and delete the QA data.");
} else {
  const scripts = ["scripts/qa.mjs", "scripts/qa-v2.mjs", "scripts/qa-lifecycle.mjs"];
  let failed = 0;
  for (const script of scripts) {
    console.log(`\n[qa-stack] === ${script} ===`);
    const code = await new Promise(resolve => {
      const child = spawn("node", [script], {
        cwd: repo, stdio: "inherit", shell: process.platform === "win32",
        env: {
          ...process.env,
          CLOUD9_RELAY_PORT: String(RELAY_PORT),
          CLOUD9_UI_PORT: String(UI_PORT),
        },
      });
      child.on("close", resolve);
      child.on("error", () => resolve(1));
    });
    if (code !== 0) failed++;
  }
  console.log(`\n[qa-stack] ${failed === 0 ? "all QA scripts passed" : `${failed} QA script(s) failed`}`);
  cleanup(failed === 0 ? 0 : 1);
}
