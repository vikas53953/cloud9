// THE HUB KEY MUST NEVER BE A PLAIN FILE ON THIS DISK.
//
// Security review 2026-08-04, Critical 2. The preload used to copy the hub key
// into the app screen's Local Storage — which is an ordinary, unencrypted file
// under %APPDATA%. That value is not a chat cookie: owner rights create agents,
// and an agent is spawned with folders on this computer, so one copy of it is
// "read and change anything, as him". Local Storage files are the first thing
// ordinary junk software reads.
//
// Every test here failed before the fix landed.
//
// Run it:  node --test apps/desktop/electron/hubsignin.test.cjs
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { loadMain, MAGIC } = require("./testkit.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-signin-"));

/**
 * Load the REAL `preload.cjs` with a stand-in Electron and a stand-in browser,
 * and report everything it touched. Nothing here re-implements the preload; it
 * only pretends to be the two things it talks to.
 */
function loadPreload({ token }) {
  const wrote = [];
  const read = [];
  const storage = {
    getItem: (k) => { read.push(k); return null; },
    setItem: (k, v) => { wrote.push({ key: k, value: v }); },
    removeItem: () => {},
  };
  let exposed;
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
    ipcRenderer: {
      sendSync: (channel) => (channel === "cloud9:ownerToken" ? token : null),
      invoke: async () => ({ ok: true }),
      on: () => {}, removeListener: () => {},
    },
  };
  const realWindow = global.window;
  const realLoad = Module._load;
  global.window = { localStorage: storage };
  global.localStorage = storage;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electron;
    return realLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve("./preload.cjs")];
    require("./preload.cjs");
  } finally {
    Module._load = realLoad;
    if (realWindow === undefined) delete global.window; else global.window = realWindow;
    delete global.localStorage;
  }
  return { exposed, wrote, read };
}

// ---------------------------------------------------------------------------
// THE PROOF OF CONCEPT
// ---------------------------------------------------------------------------

test("PoC: starting the app screen writes NO secret into browser storage", () => {
  const key = "s3cret-owner-key-do-not-store";
  const { exposed, wrote } = loadPreload({ token: key });

  assert.deepEqual(wrote, [],
    "the shell wrote something into the browser's own storage — that file is not encrypted");
  // ...and the sign-in still happens: the key is handed over in memory
  assert.equal(exposed.hubSignIn.token(), key,
    "the app screen was left with no way to sign in");
});

test("no key to hand over is a plain null, not an empty sign-in", () => {
  const { exposed, wrote } = loadPreload({ token: null });
  assert.equal(exposed.hubSignIn.token(), null);
  assert.deepEqual(wrote, []);
});

// ---------------------------------------------------------------------------
// THE CLASS, not the case: the bridge may not reach browser storage AT ALL
// ---------------------------------------------------------------------------

test("the shell bridge cannot touch browser storage, so it cannot leak one again", () => {
  const src = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")     // block comments may explain the rule
    .replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(code),
    "preload.cjs reaches browser storage again — that is the exact hole Critical 2 was");
});

// ---------------------------------------------------------------------------
// WHERE IT LIVES INSTEAD
// ---------------------------------------------------------------------------

test("the key the shell keeps is encrypted on disk, and comes back byte for byte", async () => {
  const userData = tmp();
  const { main } = loadMain({ userData, packaged: false });
  assert.equal(await main.loadDurableWrite(), true,
    "main.cjs could not load the safe-write rule from @cloud9/engine — build it first");

  const key = "owner-key-9f2b-this-must-not-be-readable";
  assert.deepEqual(main.writeSessionToken(key), { ok: true });

  const blob = fs.readFileSync(main.sessionTokenPath());
  // The stand-in for Windows' encryption leaves its own mark. What is being
  // proved here is that the value went THROUGH the OS encryption on its way to
  // the disk — the stand-in's ciphertext is deliberately still readable, so a
  // "no plaintext in the file" check would prove nothing about the real thing.
  assert.equal(blob[0], 0x01, "the key was filed as something other than encrypted");
  assert.ok(blob.subarray(1, 1 + MAGIC.length).equals(MAGIC),
    "the key went to disk without going through the operating system's encryption");
  assert.equal(main.readSessionToken(), key, "the key did not come back as it went in");

  // and forgetting really forgets
  main.writeSessionToken("");
  assert.equal(main.readSessionToken(), null);
  assert.equal(fs.existsSync(main.sessionTokenPath()), false);
});

test("a computer that cannot encrypt is told so — it never gets a plaintext copy", async () => {
  const userData = tmp();
  const { main } = loadMain({ userData, packaged: false, canEncrypt: false });
  await main.loadDurableWrite();

  const answer = main.writeSessionToken("owner-key-never-written");
  assert.equal(answer.ok, false);
  assert.match(answer.error, /can't store sign-ins safely/,
    "the refusal must be a sentence he can read, not a silent failure");
  assert.equal(fs.existsSync(main.sessionTokenPath()), false,
    "a plaintext key was written by a computer that said it could not encrypt");
});

test("a plaintext key file is not read back, however it got there", async () => {
  const userData = tmp();
  const { main } = loadMain({ userData, packaged: false });
  await main.loadDurableWrite();
  // 0x00 was the old 'not encrypted' marker used elsewhere in this file. This
  // store has no such case ON PURPOSE, so nothing can be tempted to write one.
  fs.writeFileSync(main.sessionTokenPath(),
    Buffer.concat([Buffer.from([0x00]), Buffer.from("plain-key", "utf8")]));
  assert.equal(main.readSessionToken(), null);
});

// ---------------------------------------------------------------------------
// THE SECOND WALL: a link in a chat message may not become a window of this app
//
// Electron's default for a `target="_blank"` link is a CHILD WINDOW that
// inherits the preload bridge. With the key now handed over that bridge, a web
// page an agent quoted a link from would be holding the sign-in, the saved-key
// buttons, the network setting and the folder picker. There was no handler at
// all before this.
// ---------------------------------------------------------------------------

/** A stand-in window that records what the guard did to it. */
function fakeWindow() {
  const listeners = {};
  let openHandler = null;
  return {
    url: "http://127.0.0.1:5173/",
    webContents: {
      setWindowOpenHandler: (fn) => { openHandler = fn; },
      on: (event, fn) => { listeners[event] = fn; },
      getURL() { return this._url ?? "http://127.0.0.1:5173/"; },
    },
    open: (u) => openHandler({ url: u }),
    navigate: (u) => {
      let prevented = false;
      listeners["will-navigate"]?.({ preventDefault: () => { prevented = true; } }, u);
      return prevented;
    },
    hasHandlers: () => openHandler !== null && listeners["will-navigate"] !== undefined,
  };
}

test("a link in a message opens in his own browser and never inside Cloud9", () => {
  const { main, state } = loadMain({ userData: tmp(), packaged: false });
  const win = fakeWindow();
  main.guardWindow(win);
  assert.ok(win.hasHandlers(), "the window was left with Electron's defaults");

  assert.deepEqual(win.open("https://example.com/villas"), { action: "deny" },
    "a link was allowed to open a window of this app — that window holds the bridge");
  assert.deepEqual(state.openedExternally, ["https://example.com/villas"],
    "the link should have gone to his own browser instead");
});

test("a link that is not an ordinary web link is dropped, not handed to Windows", () => {
  const { main, state } = loadMain({ userData: tmp(), packaged: false });
  const win = fakeWindow();
  main.guardWindow(win);

  for (const nasty of ["file:///C:/Windows/System32/cmd.exe", "ms-msdt:/id", "javascript:alert(1)"]) {
    assert.deepEqual(win.open(nasty), { action: "deny" });
  }
  assert.deepEqual(state.openedExternally, [],
    '"open this with whatever handles it" is how a link becomes a program');
});

test("the app's own window cannot be steered somewhere else", () => {
  const { main, state } = loadMain({ userData: tmp(), packaged: false });
  const win = fakeWindow();
  main.guardWindow(win);

  assert.equal(win.navigate("https://evil.example/page"), true,
    "the app window was allowed to navigate to a web page — it keeps the bridge when it does");
  assert.deepEqual(state.openedExternally, ["https://evil.example/page"]);
  // ...and the app's own reloads and routes are untouched
  assert.equal(win.navigate("http://127.0.0.1:5173/#quick"), false,
    "the app can no longer navigate its own screen");
});
