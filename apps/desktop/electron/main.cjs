// Cloud9 desktop shell: hosts the renderer, the global ⌘K quick-chat window,
// and the agent engine (so agents run while the app is open — Stage-1 decision 5).
const {
  app, BrowserWindow, Menu, dialog, globalShortcut, ipcMain, nativeTheme, Notification, safeStorage, shell,
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
/** The hub's own sentence when it could not open its database — shown on screen. */
let hubError = "";
/** The key that proves "I am the owner of this Cloud9". Filled in on startup. */
let ownerToken = "dev-owner-token";

/* ---------- writing a file this app will later believe ----------
 *
 * Three files in this process are written now and trusted later: this install's
 * private key, his settings, and his saved Claude/Codex sign-ins. A plain
 * `fs.writeFileSync` is not one action — it empties the file and then fills it,
 * so a power cut, a crash or antivirus arriving mid-write leaves HALF A FILE
 * under a name the app trusts. For the private key that is total, silent loss:
 * the app cannot read it, mints a new one over the top, and comes back as a
 * stranger to its own hub.
 *
 * The rule that fixes it already exists and has ONE owner — `writeWholeFile` in
 * `@cloud9/engine`: write next door, flush to the disk, rename into place,
 * retrying the rename while Defender holds a handle. This file is plain
 * CommonJS in the Electron main process and cannot `import` TypeScript, but it
 * CAN load the engine's built JavaScript, and it already does exactly that for
 * the engine host. So it loads the real rule rather than keeping a second copy
 * of it here. A second copy that drifts from the first is precisely the bug
 * this whole round removed.
 *
 * If the engine cannot be loaded at all, nothing is written unsafely — the
 * write returns false and every caller says so out loud. A save he can see fail
 * beats a save that quietly did not happen. */
let writeWholeFile = null;
let sweepPending = null;

/**
 * Load the one owner of the safe write. Called once, before anything is written.
 *
 * TWO WAYS TO THE SAME FILE, not two copies of the rule. The first is the file
 * itself, and it costs about 20 ms; the second is the engine's front door, which
 * costs about 300 ms because it drags in the whole agent SDK behind it. That
 * 300 ms would be spent before Vikas's window appeared, every single launch, to
 * load code the app is going to load a second later anyway. The front door is
 * kept as the fallback because it is the supported surface and it will survive
 * the day someone rearranges the engine's folders.
 */
async function loadDurableWrite() {
  const routes = ["@cloud9/engine/dist/wholefile.js", "@cloud9/engine"];
  const failures = [];
  for (const route of routes) {
    try {
      const mod = route === "@cloud9/engine"
        ? await import("@cloud9/engine")
        : await import("@cloud9/engine/dist/wholefile.js");
      if (typeof mod.writeWholeFile !== "function") throw new Error("no writeWholeFile in it");
      ({ writeWholeFile, sweepPending } = mod);
      return true;
    } catch (err) {
      failures.push(`${route}: ${err?.message ?? err}`);
    }
  }
  console.error(`[cloud9] could not load the safe-write rule from the engine — ${failures.join("; ")}`);
  writeWholeFile = null;
  sweepPending = null;
  return false;
}

/**
 * Write a file whole or not at all. `data` may be text or bytes — the encrypted
 * blobs below are bytes, and turning them into a string would mangle them.
 * Returns true only when the bytes are really under the real name.
 */
function writeFileWhole(target, data, onError, options) {
  if (!writeWholeFile) {
    onError?.(
      "Cloud9 could not load its own safe-saving code, so nothing was written rather " +
      "than written half-way");
    return false;
  }
  return writeWholeFile(target, data, onError, options);
}

/**
 * Clear away the litter of a write this app was killed in the middle of.
 * Only the top of the settings folder: that is where all three of these files
 * live, and the engine sweeps its own folder underneath already.
 */
function sweepOwnLitter() {
  if (!sweepPending) return 0;
  try {
    const n = sweepPending(app.getPath("userData"));
    if (n) console.log(`[cloud9] cleared ${n} leftover part-file(s) from an interrupted save`);
    return n;
  } catch (err) {
    console.error("[cloud9] could not tidy leftover part-files:", err);
    return 0;
  }
}

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

/**
 * Write this install's private key so that it either fully happens or does not
 * happen at all. Returns `{ ok }`, and a sentence when it is false.
 *
 * THIS IS THE MOST VALUABLE WRITE IN THE APP. It happens once, on first run —
 * while the installer is also hammering the disk — and every run afterwards
 * depends on reading it back. Torn, it is not recoverable: `readOwnerToken`
 * returns null, `ensureOwnerToken` mints a new key over the top, and the app is
 * a stranger to its own hub for ever. So it goes through the whole-file rule,
 * `0o600` travels with it on the temporary file, and the answer is acted on.
 */
function writeOwnerToken(token) {
  const canEncrypt = safeStorage.isEncryptionAvailable();
  const blob = canEncrypt
    ? Buffer.concat([Buffer.from([0x01]), safeStorage.encryptString(token)])
    : Buffer.concat([Buffer.from([0x00]), Buffer.from(token, "utf8")]);
  let why = "";
  const ok = writeFileWhole(ownerTokenPath(), blob, (m) => { why = m; }, { mode: 0o600 });
  if (!ok) {
    // never the value, only that it did not land
    console.error(`[cloud9] this install's private key could NOT be saved: ${why}`);
    return { ok: false, why: why || "the key could not be written to this computer" };
  }
  console.log(
    `[cloud9] made this install its own private key (length ${token.length}, ` +
    `${canEncrypt ? "encrypted by Windows" : "NOT encrypted — this computer can't"})`);
  return { ok: true };
}

/**
 * A key file that is THERE but cannot be read is never thrown away silently.
 *
 * The whole-file write above means a torn key is no longer possible. Other
 * things still are — a disk fault, or Windows refusing to decrypt a blob made
 * under a different account. In every one of those cases the old behaviour was
 * to mint a new key straight over the top of the old one, which destroys the
 * only copy of the thing that proves who this install is. Keeping a copy costs
 * nothing and is the difference between "recoverable by hand" and "gone".
 */
function keepUnreadableOwnerToken() {
  const from = ownerTokenPath();
  const to = `${from}.unreadable-${Date.now()}`;
  try {
    fs.renameSync(from, to);
    console.error(
      "[cloud9] there was already a private key here and it could not be read. A copy was " +
      `kept as ${path.basename(to)} and a new key made — this Cloud9 may not recognise ` +
      "things signed with the old one.");
  } catch (err) {
    console.error("[cloud9] could not keep a copy of the unreadable private key:", err);
  }
}

/**
 * Dev keeps today's behaviour exactly (the well-known token plus CLOUD9_DEV=1).
 * The installed app never uses either: it makes a real key on first run.
 *
 * Returns `{ ok, token }`, or `{ ok: false, why }` when a new key could not be
 * put on the disk. A key that is only in memory is worse than no key: this run
 * would work, the next would not, and nothing would have said why.
 */
function ensureOwnerToken() {
  if (!PACKAGED) return { ok: true, token: process.env.CLOUD9_OWNER_TOKEN || SHIPPED_DEFAULT_TOKEN };
  const existing = readOwnerToken();
  if (existing && existing !== SHIPPED_DEFAULT_TOKEN) return { ok: true, token: existing };
  // about to REPLACE this install's identity — if there is something there we
  // simply could not read, keep it rather than write over it
  if (existing === null && fs.existsSync(ownerTokenPath())) keepUnreadableOwnerToken();
  const token = crypto.randomBytes(32).toString("base64url");
  const wrote = writeOwnerToken(token);
  if (!wrote.ok) return { ok: false, why: wrote.why };
  return { ok: true, token };
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
/**
 * Read his settings, and SAY SO when they could not be believed.
 *
 * One file holds every preference he has ever set. Returning `{}` in silence
 * means the next `writeSettings` writes the defaults straight over whatever was
 * left — so a single bad read wipes the lot and nothing anywhere mentions it.
 * There is nothing sensible to do but carry on with defaults; there is a great
 * deal of difference between carrying on loudly and carrying on quietly.
 */
function readSettings() {
  let text;
  try {
    text = fs.readFileSync(settingsPath(), "utf8");
  } catch {
    return {}; // no settings yet — an ordinary first run, not a problem
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("the file is not a set of settings");
    }
    return parsed;
  } catch (err) {
    console.error(
      `[cloud9] your settings file could not be read (${String(err)}). Cloud9 is carrying on ` +
      `with its defaults; the file is ${settingsPath()} if you want to look at it.`);
    return {};
  }
}

/**
 * Save his settings whole or not at all, and hand back whether it landed.
 *
 * Torn, this file silently resets every preference he has ever set — the reader
 * above cannot tell a half-written file from an absent one, and the next save
 * writes the defaults over the wreckage. Same class as the engine's schedules
 * file, which is what started this round.
 */
function writeSettings(s) {
  let why = "";
  const ok = writeFileWhole(settingsPath(), JSON.stringify(s, null, 2), (m) => { why = m; });
  if (!ok) console.error(`[cloud9] your settings could not be saved: ${why}`);
  return ok;
}

/* ---------- secrets (harness-signin.md decision 4) ----------
 * The Claude token captured by "Sign in with Claude", and any fallback API key,
 * live ONLY here: encrypted by the OS (safeStorage) in a file under userData.
 * The renderer never receives them — it only ever sees status. Nothing in this
 * file logs a secret value; lengths and booleans only. */

/* ---------- THE HUB SIGN-IN, AND WHY IT IS NOT IN THE BROWSER ----------
 *
 * THE RULE, and it has no exception: a secret never sits in plain text on this
 * disk. Claude and Codex sign-ins already obeyed it. The HUB key did not — the
 * preload used to copy it into the app screen's Local Storage, which is an
 * ordinary unencrypted file under %APPDATA%. That is not a chat cookie: owner
 * rights create agents, and an agent is spawned with folders on this computer,
 * so that one value is "read and change anything, as him". Local Storage files
 * are the first thing ordinary junk software reads.
 *
 * So the key lives HERE, encrypted by Windows, in every mode — installed and
 * workbench alike — and the app screen is handed it in memory when it starts.
 * Nothing is written to the browser at all.
 *
 * A computer that cannot encrypt gets a REFUSAL, never a quiet plaintext copy:
 * the app screen keeps the key for that one run and says it could not be
 * remembered. That matches how the Claude sign-in already behaves.
 */
function sessionTokenPath() {
  return path.join(app.getPath("userData"), "cloud9-session-token.bin");
}

function readSessionToken() {
  try {
    const blob = fs.readFileSync(sessionTokenPath());
    // 0x01 = encrypted. There is no 0x00 case on purpose: a plaintext key file
    // is not something this app will read, and therefore not something a future
    // edit can be tempted to write.
    if (blob[0] !== 0x01) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.decryptString(blob.subarray(1)) || null;
  } catch {
    return null;
  }
}

/** Returns `{ ok }`, and a sentence the app screen may show when it is false. */
function writeSessionToken(token) {
  if (!token) {
    try { fs.unlinkSync(sessionTokenPath()); } catch { /* nothing stored */ }
    return { ok: true };
  }
  if (!safeStorage.isEncryptionAvailable()) {
    console.error("[cloud9] this computer can't encrypt, so the hub sign-in was not remembered");
    return { ok: false, error: "This computer can't store sign-ins safely, so Cloud9 will ask you again next time." };
  }
  const blob = Buffer.concat([Buffer.from([0x01]), safeStorage.encryptString(token)]);
  let why = "";
  const ok = writeFileWhole(sessionTokenPath(), blob, (m) => { why = m; }, { mode: 0o600 });
  if (!ok) {
    // never the value, only that it did not land
    console.error(`[cloud9] the hub sign-in could not be saved: ${why}`);
    return { ok: false, error: "Cloud9 could not remember your sign-in on this computer." };
  }
  console.log(`[cloud9] remembered the hub sign-in securely (length ${token.length})`);
  return { ok: true };
}

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
    // Whole or not at all: a torn credential file makes the sign-in stop
    // working with no explanation, and sends him back through "Sign in with
    // Claude" wondering what he did. `0o600` goes on the temporary file so the
    // permission travels with the rename and the blob is never briefly readable.
    let why = "";
    const ok = writeFileWhole(secretPath(harness), blob, (m) => { why = m; }, { mode: 0o600 });
    if (!ok) {
      console.error(`[cloud9] could not save the ${harness} sign-in: ${why}`);
      return false;
    }
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
  if (!writeSettings(s)) {
    // The encrypted copy IS saved, so nothing is lost — but the plain-text one
    // is still sitting in settings.json and saying otherwise would be a lie.
    console.error(
      "[cloud9] the encrypted sign-in was saved, but the old plain-text copy could not be " +
      "removed from your settings file. It will be tried again next time Cloud9 starts.");
    return;
  }
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
/* ---------- A LINK IN A CHAT MESSAGE IS NOT ALLOWED TO BECOME THIS APP ----------
 *
 * THE HOLE, in plain words: every link in a message is drawn with
 * `target="_blank"`, and Electron's own default for that is to open a CHILD
 * WINDOW OF THIS APP — one that inherits the preload bridge. So a web page an
 * agent read and quoted a link from would be running inside Cloud9, holding the
 * bridge: the hub sign-in, the saved-key buttons, the network setting, the
 * folder picker. That is the second wall behind the sign-in fix, and there was
 * no wall here at all.
 *
 * The rule: a link goes to the person's OWN browser, outside this app, and
 * nothing may navigate an app window anywhere but the app's own screen.
 * `http`/`https`/`mailto` only — nothing else is handed to the operating system,
 * because "open this with whatever handles it" is how a link becomes a program.
 */
const OPENABLE = new Set(["http:", "https:", "mailto:"]);

function guardWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    let scheme = "";
    try { scheme = new URL(url).protocol; } catch { /* not a link at all */ }
    // NEVER a child window of this app, whatever it is. The only question left
    // is whether it is safe to hand to the operating system.
    if (OPENABLE.has(scheme)) shell.openExternal(url).catch(() => { /* nothing to do */ });
    else console.warn(`[cloud9] a link was not opened because it is not an ordinary web link`);
    return { action: "deny" };
  });
  // ...and the app's own window may not be steered somewhere else either. The
  // screen it starts on is the only one it ever shows.
  win.webContents.on("will-navigate", (event, url) => {
    const here = win.webContents.getURL();
    const same = (u) => { try { return new URL(u).origin; } catch { return u; } };
    if (same(url) === same(here)) return;   // the app's own reloads and routes
    event.preventDefault();
    let scheme = "";
    try { scheme = new URL(url).protocol; } catch { /* not a link at all */ }
    if (OPENABLE.has(scheme)) shell.openExternal(url).catch(() => { /* nothing to do */ });
  });
}

function loadRenderer(win, hash) {
  guardWindow(win);
  const suffix = hash ? `#${hash}` : "";
  // If the hub could not open its database, the screen shows that sentence
  // instead of a sign-in box it can never satisfy. The words come from the hub
  // itself (StoreOpenError) and are written for a person, so they are passed
  // through untouched rather than re-worded here.
  const q = new URLSearchParams({ relay: relayUrl ?? "", ...(hubError ? { hubError } : {}) });
  if (DEV_URL) win.loadURL(`${DEV_URL}/${suffix}${hubError ? `?${q}` : ""}`);
  else {
    win.loadFile(path.join(__dirname, "..", "dist-web", "index.html"), {
      hash,
      query: { relay: relayUrl, ...(hubError ? { hubError } : {}) },
    });
  }
}

function titleBarOverlayFor(appearance) {
  const fallback = nativeTheme.shouldUseDarkColors
    ? { color: "#111916", symbolColor: "#EEF4ED" }
    : { color: "#F7F8F3", symbolColor: "#17211D" };
  const valid = value => typeof value === "string" && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i.test(value);
  return {
    color: valid(appearance?.color) ? appearance.color : fallback.color,
    symbolColor: valid(appearance?.symbolColor) ? appearance.symbolColor : fallback.symbolColor,
    height: 28,
  };
}

function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1200, height: 800, minWidth: 800, minHeight: 500,
    title: "Cloud9",
    backgroundColor: "#10131c",
    icon: appIconPath(),
    // Keep the application menu (and its accelerators) installed, but keep
    // its native strip out of the installed app's normal window chrome.
    autoHideMenuBar: true,
    ...(process.platform === "win32" ? {
      titleBarStyle: "hidden",
      titleBarOverlay: titleBarOverlayFor(),
    } : {}),
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  // autoHideMenuBar controls the platform default; make the initial state
  // explicit so a restored window cannot bring the strip back on startup.
  mainWin.setMenuBarVisibility(false);
  loadRenderer(mainWin);
  mainWin.on("closed", () => { mainWin = null; });
}

ipcMain.handle("cloud9:setTitleBarAppearance", (event, appearance) => {
  if (process.platform !== "win32") return { ok: true, supported: false };
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!mainWin || win !== mainWin || typeof mainWin.setTitleBarOverlay !== "function") {
    return { ok: false, supported: true };
  }
  mainWin.setTitleBarOverlay(titleBarOverlayFor(appearance));
  return { ok: true, supported: true };
});

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
    // THE SAME ANSWER THE WINDOW GETS for "where is his home folder" — one
    // function, asked here and by `cloud9:homeFolder`, so the folder the hub's
    // one-time catch-up opens up for an agent that has none is the exact folder
    // the crew-screen button would have opened. Null means the hub claims none.
    homeFolder: homeFolderHere() ?? undefined,
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

/* ---------- picking the folder a project's code lives in ----------
 *
 * THE RENDERER NEVER TOUCHES THE FILESYSTEM. It cannot list a folder, cannot
 * read one and cannot check whether one exists — it asks here, the OS draws its
 * own picker, and the ONLY thing that crosses back is the one folder the owner
 * themselves chose. Nothing here can be driven from a page: `showOpenDialog`
 * always draws a real window, so there is no silent path from a script to a
 * path on this machine.
 *
 * `{ ok: false, cancelled: true }` is a normal answer, not an error — closing
 * the picker means "not now", and the screen must not report a failure for it.
 */
ipcMain.handle("cloud9:chooseFolder", async (_ev, current) => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    title: "Where does this project's code live?",
    properties: ["openDirectory"],
    ...(typeof current === "string" && current ? { defaultPath: current } : {}),
  };
  try {
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true };
    return { ok: true, path: picked.filePaths[0] };
  } catch (err) {
    // never the inside of a program: the screen prints this word for word
    console.error("[cloud9] the folder picker failed:", err);
    return { ok: false, error: "This computer could not open the folder picker." };
  }
});

/* ---------- ONE AGENT'S CONNECTIONS FILE (feature 5, slice 2) ----------
 *
 * A SEPARATE BLOCK ON PURPOSE, and it touches nothing else in this file.
 *
 * "Connections" are extra tools an agent can reach that Cloud9 did not write —
 * whoever makes the tool hands you a small config file, and the owner picks that
 * file for ONE agent. Two handlers, and between them they are the only way a
 * path or a disk fact crosses into the window:
 *
 *   chooseConnectionsFile — the operating system's own picker, exactly the shape
 *     `cloud9:chooseFolder` above uses (`{ ok, path }` / `{ ok: false, cancelled }`
 *     / `{ ok: false, error }`). `openFile`, not `openDirectory` — `--mcp-config`
 *     wants a file.
 *   connectionsFileHere — "is the file you chose still on this computer?", asked
 *     fresh, answered yes/no with the time it was asked. It reads NOTHING out of
 *     the file and never returns anything but a boolean and a clock reading, so
 *     it cannot become a way to read the disk from a page. A path that is not a
 *     whole path, or one carrying `..`, is answered "no" without touching the
 *     filesystem at all.
 *
 * THE RENDERER STILL NEVER TOUCHES THE FILESYSTEM. It cannot list, read or walk
 * anything; it can ask about the one path it was already given back.
 */
function wholePathOnThisComputer(value) {
  if (typeof value !== "string") return null;
  const said = value.trim();
  if (!said || said.length > 400 || said.includes("..")) return null;
  for (let i = 0; i < said.length; i++) {
    // a control character is never part of a path anyone chose
    const code = said.charCodeAt(i);
    if (code < 32 || code === 127) return null;
  }
  const whole = /^[A-Za-z]:[\\/]/.test(said) || /^\\\\[^\\/]/.test(said) || said.startsWith("/");
  return whole ? said : null;
}

ipcMain.handle("cloud9:chooseConnectionsFile", async (_ev, current) => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    title: "Which connections file should this agent use?",
    properties: ["openFile"],
    filters: [
      { name: "Connections file", extensions: ["json"] },
      { name: "Any file", extensions: ["*"] },
    ],
    ...(wholePathOnThisComputer(current) ? { defaultPath: current.trim() } : {}),
  };
  try {
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true };
    return { ok: true, path: picked.filePaths[0] };
  } catch (err) {
    console.error("[cloud9] the file picker failed:", err);
    return { ok: false, error: "This computer could not open the file picker." };
  }
});

ipcMain.handle("cloud9:connectionsFileHere", (_ev, file) => {
  const checkedAt = Date.now();
  const said = wholePathOnThisComputer(file);
  if (!said) return { here: false, checkedAt };
  try {
    return { here: fs.statSync(said).isFile(), checkedAt };
  } catch {
    // gone, unreadable, on a drive that is unplugged — all the same answer
    return { here: false, checkedAt };
  }
});

/* ---------- THE FOLDERS ONE AGENT MAY REACH OUTSIDE ITS OWN ----------
 *
 * A SEPARATE BLOCK ON PURPOSE, exactly like the connections file above, and it
 * touches nothing else in this file.
 *
 * In the owner's words: folders on this computer this agent may read and change,
 * besides its own. He picks them from the operating system's own picker — he can
 * pick several at once — and they end up as real `--add-dir` arguments when that
 * agent takes a turn. Two handlers, and between them they are the only way a
 * folder path or a disk fact crosses into the window:
 *
 *   chooseWholeComputerFolders — the OS's own picker, `openDirectory` plus
 *     `multiSelections`, answering `{ ok, paths }` / `{ ok: false, cancelled }` /
 *     `{ ok: false, error }`. It ADDS to what he already chose rather than
 *     replacing it, so a second visit to the picker is not a way to silently
 *     lose the first folder — the window does that merge, this only reports what
 *     was picked.
 *   wholeComputerFoldersHere — "which of these are still on this computer?",
 *     asked fresh, answered with the subset that is there and the time it was
 *     asked. It lists NOTHING and reads NOTHING inside any folder, so it cannot
 *     become a way to walk the disk from a page: it can only answer about paths
 *     it was already handed. A path that is not a whole path, or one carrying
 *     `..`, is answered "not there" without touching the filesystem at all, and
 *     more paths than one agent may hold are refused outright.
 *
 * THE RENDERER STILL NEVER TOUCHES THE FILESYSTEM.
 */
const WHOLE_COMPUTER_ROOT_MAX = 12;

ipcMain.handle("cloud9:chooseWholeComputerFolders", async () => {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const options = {
    title: "Which folders may this agent read and change?",
    properties: ["openDirectory", "multiSelections"],
  };
  try {
    const picked = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options);
    if (picked.canceled || picked.filePaths.length === 0) return { ok: false, cancelled: true };
    const paths = picked.filePaths
      .map(wholePathOnThisComputer)
      .filter(p => typeof p === "string");
    if (paths.length === 0) {
      return { ok: false, error: "That is not a folder Cloud9 can open up for an agent." };
    }
    return { ok: true, paths };
  } catch (err) {
    // never the inside of a program: the screen prints this word for word
    console.error("[cloud9] the folder picker failed:", err);
    return { ok: false, error: "This computer could not open the folder picker." };
  }
});

/**
 * THIS COMPUTER'S HOME FOLDER — the folder a brand-new agent starts able to
 * reach, so it can do something for him from its first message.
 *
 * ASKED, NEVER GUESSED. `os.homedir()` is what Windows itself says, resolved in
 * the main process on the machine the app is running on. It goes through the
 * same path check every other folder does, and if anything about it is not a
 * whole, ordinary path the answer is `null` — the window then chooses NO folder
 * and says so plainly, rather than storing a path that might not exist. The
 * renderer cannot construct this value itself and there is no fallback string
 * anywhere: no home folder from here means no folder claimed.
 */
function homeFolderHere() {
  try {
    const os = require("node:os");
    const said = wholePathOnThisComputer(os.homedir());
    if (!said) return null;
    // it must really be a folder on this computer, right now
    if (!fs.statSync(said).isDirectory()) return null;
    return said;
  } catch {
    return null;
  }
}

ipcMain.handle("cloud9:homeFolder", () => {
  const said = homeFolderHere();
  return said ? { ok: true, path: said } : { ok: false };
});

ipcMain.handle("cloud9:wholeComputerFoldersHere", (_ev, folders) => {
  const checkedAt = Date.now();
  if (!Array.isArray(folders) || folders.length > WHOLE_COMPUTER_ROOT_MAX) {
    return { here: [], checkedAt };
  }
  const here = [];
  for (const folder of folders) {
    const said = wholePathOnThisComputer(folder);
    if (!said) continue; // refused shapes are answered without a disk lookup
    try {
      if (fs.statSync(said).isDirectory()) here.push(said);
    } catch {
      /* gone, unreadable, on a drive that is unplugged — all the same answer */
    }
  }
  return { here, checkedAt };
});

/* ---------- Windows' own notifications ----------
 *
 * WHY THIS EXISTS. Everything Cloud9 had to say lived inside its own window, so
 * the moment it was minimised nothing reached him at all — not a finished job,
 * not an agent waiting for a yes, not a mention. Only the main process can ask
 * Windows to show one, so the window asks here.
 *
 * WHAT THIS IS NOT. It is NOT a second opinion about whether to interrupt him.
 * `decideNotification` (packages/shared/src/notify.ts) already said yes before
 * anything reached this file, and `chooseDelivery` in the same file already
 * decided the OS was the right door. This only carries it out, and says plainly
 * when it could not — the window then falls back to its own toast rather than
 * letting the news disappear.
 */

/** Can this computer show one at all? Asked once per call — it is cheap. */
function osNotificationsSupported() {
  try { return Notification.isSupported(); } catch { return false; }
}

ipcMain.handle("cloud9:notifySupported", () => osNotificationsSupported());

ipcMain.handle("cloud9:osNotify", (_ev, note) => {
  const title = typeof note?.title === "string" ? note.title : "";
  const body = typeof note?.body === "string" ? note.body : "";
  if (!title && !body) return { ok: false, supported: true, error: "there was nothing to show" };
  if (!osNotificationsSupported()) {
    return {
      ok: false,
      supported: false,
      error: "this computer does not show notifications for programs",
    };
  }
  try {
    const shown = new Notification({
      title: title || "Cloud9",
      body,
      icon: appIconPath(),
      // Windows groups by app, and the app is already named by APP_ID above.
      silent: false,
    });
    /* Clicking it is a request to be taken to the thing itself. The shell only
       brings the window back and hands the note over — WHERE to land is the
       screen's own rule (`notifyTarget`), decided by the same navigation owners
       a search result uses. */
    shown.on("click", () => {
      const win = mainWin && !mainWin.isDestroyed() ? mainWin : null;
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        win.webContents.send("cloud9:notificationClicked", {
          id: note?.id ?? null,
          kind: note?.kind ?? null,
          channelId: note?.channelId ?? null,
          subjectId: note?.subjectId ?? null,
        });
      }
    });
    shown.show();
    return { ok: true, supported: true };
  } catch (err) {
    // Never the inside of a program: the window records this sentence and shows
    // its own toast instead, so the news still lands somewhere.
    console.error("[cloud9] Windows refused a notification:", err);
    return {
      ok: false,
      supported: true,
      error: "this computer would not show the notification",
    };
  }
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
  const saved = writeSettings(s);
  // apply it now and report honestly whether the key could actually be claimed
  const status = quickChatHotkeyStatus(applyGlobalQuickChatShortcut());
  // A setting that works this time and is gone tomorrow must not read as saved.
  if (!saved) {
    status.error = "that worked for now, but it could not be saved — it will be back to " +
      "how it was next time you start Cloud9";
  }
  return status;
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
  if (!writeSettings(s)) {
    // This one only takes effect on the NEXT start, so an unsaved change does
    // nothing at all. Saying "restart to apply" would be sending him to look at
    // a change that is not there.
    return {
      ok: false,
      error: "that address could not be saved on this computer, so nothing was changed. " +
        "Check there is free disk space and try again.",
    };
  }
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
  // The installed app knows its own key. The workbench hands back whatever was
  // remembered last time — encrypted, by this process — so signing in survives a
  // restart without a single secret being written into the browser.
  event.returnValue = PACKAGED ? ownerToken : readSessionToken();
});

/**
 * The app screen got in, and asks this process to remember how. The value never
 * goes back to the browser's own storage — that is the whole point.
 */
ipcMain.handle("cloud9:rememberSignIn", (_ev, token) => {
  if (typeof token !== "string" || !token) return { ok: false, error: "nothing to remember" };
  if (PACKAGED) return { ok: true };   // the installed app already owns its key
  return writeSessionToken(token);
});

ipcMain.handle("cloud9:forgetSignIn", () => {
  if (PACKAGED) return { ok: true };
  return writeSessionToken("");
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
    // FIRST, before a single byte is written: load the one owner of the safe
    // write, and clear away the part-files of a save this app was killed during.
    await loadDurableWrite();
    migrateUnnamedUserData();
    sweepOwnLitter();
    migratePlaintextCredential();
    const owner = ensureOwnerToken();
    if (!owner.ok) {
      // The private key is what proves this install is itself. Carrying on with
      // a key held only in memory would work today and be gone tomorrow, with
      // nothing to say why — so stop, and say it in words he can act on.
      dialog.showErrorBox(
        "Cloud9 could not start",
        "Cloud9 makes its own private key the first time it runs, and that key could not be " +
        `saved on this computer.\n\n${owner.why}\n\nNothing has been lost. Check there is ` +
        "free disk space, and that your antivirus is not holding the Cloud9 folder, then " +
        "start Cloud9 again.");
      app.quit();
      return;
    }
    ownerToken = owner.token;
    // The installed app carries its own hub. Dev keeps using the one
    // Start Cloud9.cmd opened, exactly as before.
    if (PACKAGED) {
      try {
        await startRelay();
      } catch (err) {
        console.error("[cloud9] the hub could not start:", err);
        // Keep the hub's own sentence — StoreOpenError is already written in
        // plain words and names the file. The screen shows it; a native error
        // box on top of it would say the same thing twice.
        hubError = err?.message ? String(err.message) : String(err);
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

/* ---------- a way in for the durability test, and nothing else ----------
 *
 * Electron ignores `module.exports` on the file it launches, so this costs the
 * running app exactly nothing. It exists because the owner-token write is the
 * single most valuable write in Cloud9 and "it looks right" is not evidence:
 * `main.durability.test.cjs` loads this file with a stand-in for Electron, KILLS
 * A REAL PROCESS in the middle of a real write, and then asks this same code
 * whether the app still knows who it is.
 *
 * Nothing here is a second implementation. Every name below is the one the app
 * itself runs. */
module.exports = {
  __test: {
    loadDurableWrite, writeFileWhole, sweepOwnLitter,
    ownerTokenPath, readOwnerToken, writeOwnerToken, ensureOwnerToken,
    sessionTokenPath, readSessionToken, writeSessionToken,
    guardWindow,
    settingsPath, readSettings, writeSettings,
    secretPath, saveSecret, loadSecret, clearSecret,
  },
};
