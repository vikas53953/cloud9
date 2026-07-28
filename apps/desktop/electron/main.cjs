// Cloud9 desktop shell: hosts the renderer, the global ⌘K quick-chat window,
// and the agent engine (so agents run while the app is open — Stage-1 decision 5).
const { app, BrowserWindow, globalShortcut, ipcMain, safeStorage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

let mainWin = null;
let quickWin = null;
let host = null;

const DEV_URL = process.env.CLOUD9_DEV_URL; // e.g. http://localhost:5173
const RELAY_URL = process.env.CLOUD9_RELAY_URL || "ws://127.0.0.1:8787";
const OWNER_TOKEN = process.env.CLOUD9_OWNER_TOKEN || "dev-owner-token";

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}
function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), "utf8")); } catch { return {}; }
}
function writeSettings(s) {
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

/* ---------- secrets (harness-signin.md decision 4) ----------
 * The Claude token captured by "Sign in with Claude", and any fallback API key,
 * live ONLY here: encrypted by the OS (safeStorage) in a file under userData.
 * The renderer never receives them — it only ever sees status. Nothing in this
 * file logs a secret value; lengths and booleans only. */

const HARNESSES = ["claude", "codex"];

/** One file per harness — Claude and Codex are separate accounts. */
function secretPath(harness) {
  return path.join(app.getPath("userData"), `cloud9-credential-${harness}.bin`);
}

function saveSecret(harness, kind, value) {
  if (!HARNESSES.includes(harness)) return false;
  if (!value) { clearSecret(harness); return true; }
  if (!safeStorage.isEncryptionAvailable()) {
    console.error("[cloud9] this computer can't encrypt saved sign-ins, so nothing was saved");
    return false;
  }
  try {
    const blob = Buffer.concat([
      Buffer.from(`${kind}\n`, "utf8"),
      safeStorage.encryptString(value),
    ]);
    fs.writeFileSync(secretPath(harness), blob, { mode: 0o600 });
    console.log(`[cloud9] saved a ${harness} ${kind} securely (length ${value.length})`);
    return true;
  } catch (err) {
    console.error(`[cloud9] could not save the ${harness} sign-in:`, err);
    return false;
  }
}

function loadSecret(harness) {
  try {
    const blob = fs.readFileSync(secretPath(harness));
    const split = blob.indexOf(0x0a);
    if (split < 0) return null;
    const kind = blob.slice(0, split).toString("utf8");
    if (!safeStorage.isEncryptionAvailable()) return null;
    const value = safeStorage.decryptString(blob.slice(split + 1));
    return value ? { kind, value } : null;
  } catch {
    return null;
  }
}

function loadAllSecrets() {
  const out = {};
  for (const h of HARNESSES) {
    const s = loadSecret(h);
    if (s) out[h] = s;
  }
  return out;
}

function clearSecret(harness) {
  try { fs.unlinkSync(secretPath(harness)); } catch { /* nothing stored */ }
}

/**
 * One-time cleanup: v1 wrote the credential in plain text, for Claude only.
 * The plaintext is deleted ONLY after the encrypted copy is confirmed written —
 * otherwise a machine that can't encrypt would lose the credential entirely.
 */
function migratePlaintextCredential() {
  const s = readSettings();
  if (!s.cred) return;
  const ok = saveSecret("claude", s.credKind === "oauthToken" ? "oauthToken" : "apiKey", s.cred);
  if (!ok) {
    console.error("[cloud9] kept the old sign-in as-is — it could not be encrypted on this computer");
    return;
  }
  delete s.cred;
  delete s.credKind;
  writeSettings(s);
  console.log("[cloud9] moved an old plain-text credential into encrypted storage");
  // also drop the pre-v2 single-slot file, now superseded by the per-harness one
  try { fs.unlinkSync(path.join(app.getPath("userData"), "cloud9-credential.bin")); } catch { /* none */ }
}

function loadRenderer(win, hash) {
  const suffix = hash ? `#${hash}` : "";
  if (DEV_URL) win.loadURL(`${DEV_URL}/${suffix}`);
  else win.loadFile(path.join(__dirname, "..", "dist-web", "index.html"), { hash });
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, minHeight: 500,
    backgroundColor: "#10131c",
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  loadRenderer(mainWin);
  mainWin.on("closed", () => { mainWin = null; });
}

function toggleQuickWindow() {
  if (quickWin) { quickWin.close(); quickWin = null; return; }
  quickWin = new BrowserWindow({
    width: 580, height: 420, frame: false, alwaysOnTop: true, resizable: false,
    backgroundColor: "#1d2334", skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  loadRenderer(quickWin, "quick");
  quickWin.on("blur", () => { quickWin?.close(); quickWin = null; });
  quickWin.on("closed", () => { quickWin = null; });
}

async function startEngine() {
  try {
    const { startEngineHost } = await import("@cloud9/engine");
    const dataDir = path.join(app.getPath("userData"), "engine");
    const credentials = loadAllSecrets();
    host = startEngineHost({
      relayUrl: RELAY_URL,
      token: OWNER_TOKEN,
      dataDir,
      credentials,
      demoMode: process.env.CLOUD9_DEMO === "1",
      // "Sign in with Claude" captured a token — encrypt it for next launch
      onClaudeToken: token => { saveSecret("claude", "oauthToken", token); },
      onReady: () => console.log(
        `[cloud9] engine online (Claude ${credentials.claude ? "connected" : "not connected"})`),
    });
  } catch (err) {
    console.error("[cloud9] engine failed to start:", err);
  }
}

// Renderer → main. Only the fallback API key path sends a value; everything
// else is status. No secret is ever sent back to the renderer.
// Every handler is per-harness: a Codex key must never overwrite a Claude one.
ipcMain.handle("cloud9:setApiKey", (_ev, harness, kind, value) => {
  const h = HARNESSES.includes(harness) ? harness : null;
  if (!h) return { ok: false, error: "unknown app" };
  const k = kind === "oauthToken" ? "oauthToken" : "apiKey";
  const text = String(value ?? "");
  const ok = saveSecret(h, k, text);
  if (!ok) {
    return { ok: false, error: "this computer can't store a key securely, so it wasn't saved" };
  }
  if (host) host.useCredential(h, k, text);
  return { ok: true };
});

ipcMain.handle("cloud9:clearCredential", (_ev, harness) => {
  const h = HARNESSES.includes(harness) ? harness : null;
  if (!h) return { ok: false, error: "unknown app" };
  clearSecret(h);
  if (host) host.useCredential(h, "apiKey", "");
  return { ok: true };
});

ipcMain.handle("cloud9:credentialStatus", () => {
  const status = { canEncrypt: safeStorage.isEncryptionAvailable() };
  for (const h of HARNESSES) {
    const stored = loadSecret(h);
    status[h] = { hasCredential: !!stored, kind: stored ? stored.kind : null };
  }
  return status;
});

app.whenReady().then(() => {
  migratePlaintextCredential();
  createMainWindow();
  globalShortcut.register("CommandOrControl+K", toggleQuickWindow);
  startEngine();
  app.on("activate", () => { if (!mainWin) createMainWindow(); });
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
  // keep the engine alive in the background on macOS-style close later;
  // v1: quit fully (agents pause when the app is closed — documented).
  if (host) host.stop();
  app.quit();
});
