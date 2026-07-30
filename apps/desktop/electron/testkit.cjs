// A STAND-IN FOR ELECTRON, so `main.cjs` can be tested for real.
//
// `main.cjs` is the app shell. It writes the three files this install cannot
// afford to lose — its private key, his settings, his saved Claude/Codex
// sign-ins — and until now none of that had ever been tested, because loading
// it means loading Electron.
//
// It does not, quite. `main.cjs` asks for `electron` with an ordinary
// `require`, so a stand-in handed back in its place is enough to load the REAL
// file and call the REAL functions. Nothing here re-implements anything
// `main.cjs` does; it only pretends to be the parts of Electron it leans on.
//
// This file is loaded by the test AND by the child process the kill test
// starts, so there is exactly one definition of the pretend Electron. Two would
// be able to drift, and a test that drifts from the thing it tests passes for
// the wrong reason.
const Module = require("node:module");
const path = require("node:path");

/** Where `main.cjs` really is, found from here rather than from the caller. */
const MAIN = path.join(__dirname, "main.cjs");

/**
 * The mark our pretend encryption puts in front of a blob. Real `safeStorage`
 * produces bytes that are not text; so does this, deliberately — the padding is
 * 0xFF, which no UTF-8 decoder can carry. If the write path ever turned these
 * blobs into a string on the way past, the round-trip below would come back
 * mangled and the tests would say so.
 */
const MAGIC = Buffer.from([0x43, 0x39, 0x45, 0x4e]); // "C9EN"

/**
 * @param {object} opts
 * @param {string} opts.userData  the folder to use as Electron's userData
 * @param {number} [opts.pad]     bytes of 0xFF filler in each encrypted blob —
 *                                make it large to widen the write window so a
 *                                kill can land in the middle of a real write
 * @param {boolean} [opts.packaged]
 * @param {boolean} [opts.canEncrypt]
 */
function fakeElectron(opts) {
  const pad = opts.pad ?? 0;
  const state = {
    quit: 0,
    errorBoxes: [],
    userData: opts.userData,
  };
  const noop = () => {};
  const electron = {
    app: {
      setName: noop,
      setAppUserModelId: noop,
      isPackaged: opts.packaged !== false,
      getVersion: () => "0.0.0-test",
      getPath: (what) => (what === "userData" ? state.userData : path.join(state.userData, what)),
      // false keeps the whole startup block from running, so requiring
      // `main.cjs` is inert and the test drives it a function at a time
      requestSingleInstanceLock: () => false,
      quit: () => { state.quit++; },
      on: noop,
      whenReady: () => new Promise(() => {}),
    },
    BrowserWindow: class { static getFocusedWindow() { return null; } },
    Menu: { setApplicationMenu: noop, buildFromTemplate: (t) => t },
    dialog: {
      showErrorBox: (title, body) => { state.errorBoxes.push({ title, body }); },
      showMessageBox: async () => ({ response: 0 }),
    },
    globalShortcut: { unregisterAll: noop, register: () => true, unregister: noop },
    ipcMain: { handle: noop, on: noop, removeHandler: noop },
    shell: { openPath: async () => "" },
    safeStorage: {
      isEncryptionAvailable: () => opts.canEncrypt !== false,
      // The key goes at the END, behind the filler, because that is how real
      // ciphertext behaves: lose the tail of it and you have lost all of it.
      // A stand-in that kept the secret readable in the first few bytes would
      // make a torn file look survivable when it is not.
      encryptString: (s) => Buffer.concat([
        MAGIC, Buffer.alloc(pad, 0xff), Buffer.from([0x00]), Buffer.from(String(s), "utf8"),
      ]),
      decryptString: (b) => {
        const buf = Buffer.from(b);
        if (buf.subarray(0, MAGIC.length).compare(MAGIC) !== 0) {
          throw new Error("not something this computer encrypted");
        }
        const end = buf.indexOf(0x00, MAGIC.length);
        if (end < 0) throw new Error("that blob is not whole");
        return buf.subarray(end + 1).toString("utf8");
      },
    },
  };
  return { electron, state };
}

/**
 * Load the REAL `main.cjs` with the stand-in in place of Electron, and hand back
 * its test seam. Loaded fresh every time, so one test cannot leave state in
 * another's way.
 */
function loadMain(opts) {
  const { electron, state } = fakeElectron(opts);
  const realLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "electron") return electron;
    return realLoad.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve(MAIN)];
    const mod = require(MAIN);
    return { main: mod.__test, state, electron };
  } finally {
    Module._load = realLoad;
  }
}

module.exports = { fakeElectron, loadMain, MAIN, MAGIC };
