// Cloud9 desktop shell: hosts the renderer, the global ⌘K quick-chat window,
// and the agent engine (so agents run while the app is open — Stage-1 decision 5).
const { app, BrowserWindow, globalShortcut, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

let mainWin = null;
let quickWin = null;
let engine = null;

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
    const { Engine, MockProvider, SdkProvider } = await import("@cloud9/engine");
    const settings = readSettings();
    const dataDir = path.join(app.getPath("userData"), "engine");
    const creds = settings.credKind === "apiKey" && settings.cred ? { apiKey: settings.cred }
      : settings.credKind === "oauthToken" && settings.cred ? { oauthToken: settings.cred }
      : null;
    engine = new Engine({ relayUrl: RELAY_URL, token: OWNER_TOKEN, dataDir });
    engine.provider = creds
      ? new SdkProvider(creds, engine.agentDataDir)
      : new MockProvider();
    engine.connect();
    console.log(`[cloud9] engine online (${creds ? "live Claude" : "demo mode"})`);
  } catch (err) {
    console.error("[cloud9] engine failed to start:", err);
  }
}

ipcMain.on("cloud9:setCred", (_ev, kind, value) => {
  const s = readSettings();
  s.credKind = kind; s.cred = value;
  writeSettings(s);
  if (engine) { engine.stop(); engine = null; }
  startEngine();
});

app.whenReady().then(() => {
  createMainWindow();
  globalShortcut.register("CommandOrControl+K", toggleQuickWindow);
  startEngine();
  app.on("activate", () => { if (!mainWin) createMainWindow(); });
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => {
  // keep the engine alive in the background on macOS-style close later;
  // v1: quit fully (agents pause when the app is closed — documented).
  if (engine) engine.stop();
  app.quit();
});
