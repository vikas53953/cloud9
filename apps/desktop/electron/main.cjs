// Cloud9 desktop shell: hosts the renderer, the global ⌘K quick-chat window,
// and the agent engine (so agents run while the app is open — Stage-1 decision 5).
const {
  app, BrowserWindow, Menu, dialog, globalShortcut, ipcMain, safeStorage, shell,
} = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

let mainWin = null;
let quickWin = null;
let host = null;
let relay = null;

/* ---------- who this app is on Windows (must run before anything else) ----------
 * Without these two lines Windows has no idea what this program is: the taskbar
 * and the Start menu fall back to Electron's own name and icon. setName also
 * decides where our settings live (%APPDATA%\Cloud9), and the App User Model ID
 * is what ties a running window to its installed shortcut, so pinning works and
 * the right icon shows. Both must match the installer's appId. */
const APP_ID = "com.vikas.cloud9";
app.setName("Cloud9");
if (process.platform === "win32") app.setAppUserModelId(APP_ID);

/** true in the installed app, false when run from the repo with `electron .` */
const PACKAGED = app.isPackaged;

const DEV_URL = process.env.CLOUD9_DEV_URL; // e.g. http://localhost:5173
/**
 * Where the app talks to its hub. In dev this is the hub Start Cloud9.cmd
 * started; in the installed app we start our own and overwrite this with the
 * port it actually got.
 */
let relayUrl = process.env.CLOUD9_RELAY_URL || "ws://127.0.0.1:8787";
/** The key that proves "I am the owner of this Cloud9". Filled in on startup. */
let ownerToken = "dev-owner-token";

/* ---------- this install's own private key ----------
 * The relay refuses to start programs on this computer for anyone holding the
 * token every checkout ships with — rightly so, it is public. A real install
 * therefore makes its own random key the first time it runs and keeps it
 * encrypted by the OS, next to the saved sign-ins. Nothing logs its value. */

const SHIPPED_DEFAULT_TOKEN = "dev-owner-token";

function ownerTokenPath() {
  return path.join(app.getPath("userData"), "cloud9-owner-token.bin");
}

function readOwnerToken() {
  try {
    const blob = fs.readFileSync(ownerTokenPath());
    if (blob[0] === 0x01) {
      if (!safeStorage.isEncryptionAvailable()) return null;
      return safeStorage.decryptString(blob.subarray(1)) || null;
    }
    if (blob[0] === 0x00) return blob.subarray(1).toString("utf8") || null;
    return null;
  } catch {
    return null;
  }
}

function writeOwnerToken(token) {
  const canEncrypt = safeStorage.isEncryptionAvailable();
  const blob = canEncrypt
    ? Buffer.concat([Buffer.from([0x01]), safeStorage.encryptString(token)])
    : Buffer.concat([Buffer.from([0x00]), Buffer.from(token, "utf8")]);
  fs.writeFileSync(ownerTokenPath(), blob, { mode: 0o600 });
  console.log(
    `[cloud9] made this install its own private key (length ${token.length}, ` +
    `${canEncrypt ? "encrypted by Windows" : "NOT encrypted — this computer can't"})`);
}

/**
 * Dev keeps today's behaviour exactly (the well-known token plus CLOUD9_DEV=1).
 * The installed app never uses either: it makes a real key on first run.
 */
function ensureOwnerToken() {
  if (!PACKAGED) return process.env.CLOUD9_OWNER_TOKEN || SHIPPED_DEFAULT_TOKEN;
  let token = readOwnerToken();
  if (!token || token === SHIPPED_DEFAULT_TOKEN) {
    token = crypto.randomBytes(32).toString("base64url");
    writeOwnerToken(token);
  }
  return token;
}

/**
 * Before this change the app had no name, so Windows filed its settings under
 * "@cloud9/desktop". Move that folder's contents across once so an existing
 * install keeps its saved sign-ins instead of looking wiped.
 */
function migrateUnnamedUserData() {
  const now = app.getPath("userData");
  const old = path.join(path.dirname(now), "@cloud9", "desktop");
  if (old === now || !fs.existsSync(old)) return;
  try {
    fs.mkdirSync(now, { recursive: true });
    let moved = 0;
    for (const entry of fs.readdirSync(old)) {
      const to = path.join(now, entry);
      if (fs.existsSync(to)) continue; // never overwrite newer data
      fs.renameSync(path.join(old, entry), to);
      moved++;
    }
    if (moved) console.log(`[cloud9] moved ${moved} item(s) from the old unnamed settings folder into Cloud9's own`);
    try { fs.rmdirSync(old); } catch { /* still has things we chose not to move */ }
  } catch (err) {
    console.error("[cloud9] could not move the old settings folder:", err);
  }
}

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

/* ---------- app icon ----------
 * The Cloud9 cast plate. Vite copies apps/desktop/public/* to dist-web/, so a
 * packaged build has the icon even if public/ is not shipped; dev falls back to
 * public/. Windows wants the .ico (it carries 16-256px); other platforms take
 * the 512px PNG. */
function appIconPath() {
  const file = process.platform === "win32" ? "icon.ico" : "logo-512.png";
  const candidates = [
    path.join(__dirname, "..", "dist-web", file),
    path.join(__dirname, "..", "public", file),
  ];
  return candidates.find((p) => fs.existsSync(p)) || undefined;
}

/**
 * Dev loads the live Vite screen; the installed app loads the screen already
 * built into it — there is no Vite in a packaged Cloud9. The hub address is
 * handed over in the address so the screen finds it even on a spare port.
 */
function loadRenderer(win, hash) {
  const suffix = hash ? `#${hash}` : "";
  if (DEV_URL) win.loadURL(`${DEV_URL}/${suffix}`);
  else {
    win.loadFile(path.join(__dirname, "..", "dist-web", "index.html"), {
      hash,
      query: { relay: relayUrl },
    });
  }
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, minHeight: 500,
    title: "Cloud9",
    backgroundColor: "#10131c",
    icon: appIconPath(),
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  loadRenderer(mainWin);
  mainWin.on("closed", () => { mainWin = null; });
}

function toggleQuickWindow() {
  if (quickWin) { quickWin.close(); quickWin = null; return; }
  quickWin = new BrowserWindow({
    width: 580, height: 420, frame: false, alwaysOnTop: true, resizable: false,
    title: "Cloud9", icon: appIconPath(),
    backgroundColor: "#1d2334", skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  loadRenderer(quickWin, "quick");
  quickWin.on("blur", () => { quickWin?.close(); quickWin = null; });
  quickWin.on("closed", () => { quickWin = null; });
}

/* ---------- the hub, inside the app ----------
 * In dev the hub is a separate window Start Cloud9.cmd opens. An installed app
 * cannot ask its user to do that, so it runs the very same hub code right here
 * in the app process: nothing extra to start, and nothing left running after
 * the window closes. It listens on this computer only, never the network.
 */
/**
 * Try one port and say plainly whether it worked. The listener goes on BOTH the
 * web server and the socket server: the socket library repeats the web server's
 * failure on itself, and an unheard failure there takes the whole app down.
 */
function listenOnce(r, port) {
  return new Promise((resolve, reject) => {
    const done = (fn) => (arg) => {
      r.server.removeListener("error", fail);
      r.wss.removeListener("error", fail);
      fn(arg);
    };
    const fail = (err) => done(reject)(err);
    r.server.on("error", fail);
    r.wss.on("error", fail);
    r.listen(port).then((p) => done(resolve)(p), fail);
  });
}

/**
 * Which address the hub answers on (docs/plans/backend-decision.md #2).
 *
 * Loopback — this computer only — unless Vikas has deliberately put his
 * private-network address in settings.json. That is the ONE supported way a
 * friend on another computer can reach his Cloud9: both machines join the same
 * Tailscale network, and the hub answers on his 100.x.y.z address, which no
 * device outside that network can even see. A wildcard like 0.0.0.0 is refused
 * outright by the relay — the hub can start programs on this machine, so it is
 * never allowed to answer the café wifi.
 *
 * Settings key:  "networkBind": "100.x.y.z"   (in Cloud9's settings.json)
 * Or, for one run:  set CLOUD9_BIND=100.x.y.z
 */
function hubBindAddress() {
  const fromSettings = readSettings().networkBind;
  return (process.env.CLOUD9_BIND || fromSettings || "").trim() || "127.0.0.1";
}

async function startRelay() {
  const { Relay } = await import("@cloud9/relay");
  const bind = hubBindAddress();
  relay = new Relay({
    dbPath: path.join(app.getPath("userData"), "cloud9-relay.db"),
    ownerToken,
    // never a wildcard: Relay's resolveBind refuses one rather than narrowing it
    bind,
    // An installed app must never accept the token every checkout ships with,
    // whatever CLOUD9_DEV happens to say in the environment it was launched from.
    devMode: false,
  });
  const wanted = Number(process.env.CLOUD9_RELAY_PORT || 8787);
  let port;
  try {
    port = await listenOnce(relay, wanted);
  } catch {
    // something else is on 8787 (a dev hub, most likely) — take any free port
    port = await listenOnce(relay, 0);
  }
  // This app's own screen always talks to itself over loopback, whatever the hub
  // is also listening on — a friend uses the address below, we do not need it.
  relayUrl = `ws://127.0.0.1:${port}`;
  if (bind === "127.0.0.1") {
    console.log(`[cloud9] hub running on ${relayUrl} (this computer only)`);
  } else {
    console.log(
      `[cloud9] hub running on ${relayUrl}, and reachable on your private network ` +
      `at ws://${bind}:${port} — that is the address to give a friend`);
  }
}

function stopRelay() {
  if (!relay) return;
  try { relay.close(); } catch (err) { console.error("[cloud9] hub did not close cleanly:", err); }
  relay = null;
}

async function startEngine() {
  try {
    const { startEngineHost } = await import("@cloud9/engine");
    const dataDir = path.join(app.getPath("userData"), "engine");
    const credentials = loadAllSecrets();
    /* Demo mode = made-up answers instead of real ones. It is opt-in and it is
     * never quiet: the engine reports it to every screen (which shows a banner)
     * and every canned reply is stamped at the source. Nothing about how the app
     * was launched can turn it on by accident — only this variable, typed by a
     * person, and the log line below says so out loud. */
    const demoMode = process.env.CLOUD9_DEMO === "1";
    if (demoMode) {
      console.log("[cloud9] DEMO MODE — agents will answer with made-up examples, " +
        "not real answers from Claude or Codex.");
    }
    host = startEngineHost({
      relayUrl,
      token: ownerToken,
      dataDir,
      credentials,
      demoMode,
      onReady: () => console.log(
        `[cloud9] engine online (Claude ${credentials.claude ? "using your saved key" : "using the Claude app's own sign-in"})`),
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

/* Where an agent's own files live. The engine puts each agent in
 * <userData>/engine/agents/<id>, so that is the folder the Settings button
 * shows. It is created on demand, so "open folder" can never fail on a fresh
 * install where no agent has written anything yet. */
function agentFolderPath() {
  const dir = path.join(app.getPath("userData"), "engine", "agents");
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* shown as-is below */ }
  return dir;
}

ipcMain.handle("cloud9:agentFolder", () => agentFolderPath());

ipcMain.handle("cloud9:openAgentFolder", async () => {
  const dir = agentFolderPath();
  const problem = await shell.openPath(dir);
  return problem ? { ok: false, error: problem } : { ok: true };
});

/* ---------- the computer-wide hotkey, as a setting ---------- */

function quickChatHotkeyStatus(applied) {
  const s = readSettings();
  return {
    enabled: s.globalQuickChat === true,
    key: String(s.globalQuickChatKey || DEFAULT_GLOBAL_QUICK_CHAT_KEY),
    defaultKey: DEFAULT_GLOBAL_QUICK_CHAT_KEY,
    // did it really take the key, or is another program holding it?
    active: applied ? applied.ok && !!applied.key : !!globalQuickChatKey(),
    error: applied && applied.error ? applied.error : null,
  };
}

ipcMain.handle("cloud9:quickChatHotkey", () => quickChatHotkeyStatus(null));

ipcMain.handle("cloud9:setQuickChatHotkey", (_ev, enabled, key) => {
  const s = readSettings();
  s.globalQuickChat = enabled === true;
  if (typeof key === "string" && key.trim()) s.globalQuickChatKey = key.trim();
  writeSettings(s);
  // apply it now and report honestly whether the key could actually be claimed
  return quickChatHotkeyStatus(applyGlobalQuickChatShortcut());
});

/* ---------- letting a friend on another computer reach this hub ---------- */

ipcMain.handle("cloud9:hubNetwork", () => ({
  address: hubBindAddress(),
  loopbackOnly: hubBindAddress() === "127.0.0.1",
  // the addresses this computer could offer — a Tailscale one starts 100.
  candidates: privateNetworkAddresses(),
}));

ipcMain.handle("cloud9:setHubNetwork", (_ev, address) => {
  const want = String(address ?? "").trim();
  // the relay is the one owner of this rule; ask it rather than re-deciding here
  if (/^(0\.0\.0\.0|::|\*|0)$/.test(want)) {
    return {
      ok: false,
      error: "that address means every network this computer is on, including " +
        "public wifi. Use your private-network address instead (it starts with 100.).",
    };
  }
  const s = readSettings();
  if (want) s.networkBind = want; else delete s.networkBind;
  writeSettings(s);
  return { ok: true, address: want || "127.0.0.1", restartNeeded: true };
});

/** Addresses on this computer that a private network (Tailscale) would have given it. */
function privateNetworkAddresses() {
  const out = [];
  try {
    const os = require("node:os");
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const iface of list || []) {
        if (iface.family !== "IPv4" || iface.internal) continue;
        out.push({ name, address: iface.address, likelyTailscale: iface.address.startsWith("100.") });
      }
    }
  } catch { /* nothing to offer — the box below just stays empty */ }
  return out;
}

ipcMain.handle("cloud9:credentialStatus", () => {
  const status = { canEncrypt: safeStorage.isEncryptionAvailable() };
  for (const h of HARNESSES) {
    const stored = loadSecret(h);
    status[h] = { hasCredential: !!stored, kind: stored ? stored.kind : null };
  }
  return status;
});

/**
 * The installed app owns its hub, so it signs its owner in with this install's
 * own key instead of showing a sign-in screen for a token only it knows. Dev
 * gets null back and keeps today's "I run this Cloud9" screen untouched.
 * This is the relay session key, not a Claude/Codex credential — those never
 * leave the main process.
 */
ipcMain.on("cloud9:ownerToken", (event) => {
  event.returnValue = PACKAGED ? ownerToken : null;
});

/* ---------- app menu (feedback round 1, his 14) ----------
 * A real menu bar, because an app with no menu reads as a mock. Every item
 * either does its job here in the shell (reload, zoom, quit, open a folder) or
 * is handed to the app screen as a `menu:<action>` message over the existing
 * preload bridge. Nothing here is decorative. */

/** Tell the focused app screen that a menu item was chosen. */
function toRenderer(action) {
  const win = BrowserWindow.getFocusedWindow() || mainWin;
  if (win && !win.isDestroyed()) win.webContents.send("cloud9:menu", action);
}

/* The canonical list of menu actions, loaded from @cloud9/shared at startup.
 * ONE list, two halves: this file builds the menu from it, and the app screen
 * types its handler map as Record<MenuAction, …> so a handler it forgets is a
 * build error rather than a menu item that silently does nothing. Four items
 * used to be exactly that (M5). */
let MENU_ACTIONS = null;
/** Every action this menu actually sends — filled in as the menu is built. */
const sentActions = new Set();

/**
 * A menu item that hands its action to the app screen.
 *
 * The action is checked against the shared list the moment the menu is built,
 * so a typo or an invented action stops the app at startup with a plain
 * sentence — instead of shipping a menu item that looks alive and is not.
 */
const menuItem = (label, action, accelerator) => {
  if (MENU_ACTIONS && !MENU_ACTIONS.includes(action)) {
    throw new Error(
      `menu item "${label}" sends "${action}", which is not in the shared MENU_ACTIONS ` +
      "list in @cloud9/shared. Add it there (and to the app screen's handler map) first.");
  }
  sentActions.add(action);
  return { label, accelerator, click: () => toRenderer(action) };
};

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        menuItem("New agent…", "new-agent", "CmdOrCtrl+Shift+A"),
        menuItem("New channel…", "new-channel", "CmdOrCtrl+Shift+N"),
        menuItem("Invite someone…", "invite", "CmdOrCtrl+Shift+I"),
        { type: "separator" },
        menuItem("Settings…", "settings", "CmdOrCtrl+,"),
        { type: "separator" },
        {
          label: "Open my agents' files",
          click: () => shell.openPath(agentFolderPath()),
        },
        { type: "separator" },
        { role: "quit", label: "Quit Cloud9" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" }, { role: "redo" }, { type: "separator" },
        { role: "cut" }, { role: "copy" }, { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        menuItem("Find in conversation…", "search", "CmdOrCtrl+F"),
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload", label: "Reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom", label: "Actual size" },
        { role: "zoomIn", label: "Zoom in" },
        { role: "zoomOut", label: "Zoom out" },
        { type: "separator" },
        menuItem("Toggle light / dark", "toggle-theme", "CmdOrCtrl+Shift+L"),
        menuItem("Activity", "activity"),
        menuItem("Tasks", "tasks"),
        { type: "separator" },
        { role: "togglefullscreen", label: "Full screen" },
        { role: "toggleDevTools", label: "Developer tools" },
      ],
    },
    {
      label: "Help",
      submenu: [
        menuItem("Quick chat (Ctrl+K)", "quick-chat"),
        {
          label: "Open the app's log folder",
          click: () => shell.openPath(app.getPath("logs")),
        },
        { type: "separator" },
        {
          label: "About Cloud9",
          click: () => dialog.showMessageBox({
            type: "info",
            title: "About Cloud9",
            message: `Cloud9 ${app.getVersion()}`,
            detail:
              "Chat with your crew of agents and friends.\n\n" +
              "Your agents run on the Claude and Codex apps already installed on " +
              "this computer, signed in with your own accounts. Cloud9 starts them " +
              "for you — it never stores your sign-in.\n\n" +
              `Electron ${process.versions.electron} · Node ${process.versions.node}`,
            buttons: ["OK"],
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  // The other direction: every action on the shared list must actually be sent
  // by some menu item. Without this the list could grow an action nothing
  // reaches, and the app screen would carry a handler for a dead route.
  if (MENU_ACTIONS) {
    const missing = MENU_ACTIONS.filter(a => !sentActions.has(a));
    if (missing.length) {
      throw new Error(
        `these menu actions are on the shared list but no menu item sends them: ` +
        `${missing.join(", ")}. Either add the menu items or take them off the list.`);
    }
    console.log(`[cloud9] menu wired: ${MENU_ACTIONS.length} actions, all reachable`);
  }
}

/* ---------- the quick-chat hotkey ----------
 * Ctrl+K inside Cloud9's own window is handled by the app screen, costs nobody
 * anything, and is always on.
 *
 * A GLOBAL hotkey is a different animal: Electron takes that key away from
 * EVERY program on the computer for as long as Cloud9 is running. Registering
 * CommandOrControl+K globally meant VS Code lost its chord prefix, Slack lost
 * its link dialog and every browser lost its search bar (M8). So the global
 * hotkey is now OFF unless asked for, and when asked for it defaults to
 * Ctrl+Alt+K — a combination essentially nothing else claims.
 *
 * Settings keys (Cloud9's settings.json):
 *   "globalQuickChat": true                  turn it on   (default: false)
 *   "globalQuickChatKey": "Control+Alt+K"    change it     (default as shown)
 */
const DEFAULT_GLOBAL_QUICK_CHAT_KEY = "CommandOrControl+Alt+K";

function globalQuickChatKey() {
  const s = readSettings();
  if (s.globalQuickChat !== true) return null;
  const key = String(s.globalQuickChatKey || DEFAULT_GLOBAL_QUICK_CHAT_KEY).trim();
  return key || DEFAULT_GLOBAL_QUICK_CHAT_KEY;
}

/** Put the current setting into effect. Safe to call again at any time. */
function applyGlobalQuickChatShortcut() {
  globalShortcut.unregisterAll();
  const key = globalQuickChatKey();
  if (!key) {
    console.log("[cloud9] no computer-wide hotkey registered — Ctrl+K works inside Cloud9 only");
    return { ok: true, key: null };
  }
  let registered = false;
  try {
    registered = globalShortcut.register(key, toggleQuickWindow);
  } catch (err) {
    console.error(`[cloud9] "${key}" is not a shortcut Windows understands:`, err.message);
  }
  if (!registered) {
    console.error(`[cloud9] could not take "${key}" — another program already has it. ` +
      "Ctrl+K still works inside Cloud9.");
    return { ok: false, key, error: "another program already uses that shortcut" };
  }
  console.log(`[cloud9] computer-wide quick-chat hotkey: ${key}`);
  return { ok: true, key };
}

// (the App User Model ID is set at the top of this file, before anything else)

/* One Cloud9 at a time. Two copies would fight over the same hub port and the
 * same database; a second launch just brings the open window to the front. */
if (PACKAGED && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWin) return;
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
  });

  app.whenReady().then(async () => {
    migrateUnnamedUserData();
    migratePlaintextCredential();
    ownerToken = ensureOwnerToken();
    // The installed app carries its own hub. Dev keeps using the one
    // Start Cloud9.cmd opened, exactly as before.
    if (PACKAGED) {
      try {
        await startRelay();
      } catch (err) {
        console.error("[cloud9] the hub could not start:", err);
        dialog.showErrorBox(
          "Cloud9 could not start",
          "Cloud9's hub did not start, so the app has nothing to talk to.\n\n" +
          `Details: ${String(err)}`);
      }
    }
    // the menu is built from the shared action list, and refuses to build if the
    // two halves have drifted apart (M5)
    try {
      ({ MENU_ACTIONS } = await import("@cloud9/shared"));
    } catch (err) {
      console.error("[cloud9] could not load the shared menu action list:", err);
    }
    buildMenu();
    createMainWindow();
    // Ctrl+K inside the app is the app screen's job and always works. A
    // computer-wide hotkey is off unless asked for (M8).
    applyGlobalQuickChatShortcut();
    startEngine();
    app.on("activate", () => { if (!mainWin) createMainWindow(); });
  });
}

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  // last line of defence: nothing of ours may outlive the app
  if (host) { host.stop(); host = null; }
  stopRelay();
});
app.on("window-all-closed", () => {
  // keep the engine alive in the background on macOS-style close later;
  // v1: quit fully (agents pause when the app is closed — documented).
  if (host) { host.stop(); host = null; }
  stopRelay();
  app.quit();
});
