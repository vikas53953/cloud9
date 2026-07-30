// THE WORST WRITE IN THE APPLICATION, PROVED RATHER THAN ARGUED.
//
// `cloud9-owner-token.bin` is the private key the installed app makes for
// itself the first time it runs. It is written ONCE — while the installer is
// also hammering the disk — and read on every run after that. If that one write
// is torn, `readOwnerToken` gets nothing back, `ensureOwnerToken` mints a brand
// new key straight over the top, and Cloud9 comes back A STRANGER TO ITS OWN
// HUB. One-in-a-thousand odds with total, unrecoverable loss behind them.
//
// So this file does not reason about it. It starts a real Node process, has it
// write the real key through the real code, KILLS IT MID-WRITE, and then asks
// the app whether it still knows who it is.
//
// Run it:  node --test apps/desktop/electron/main.durability.test.cjs
// (It is not in `npm test` yet — that runs the engine and the hub only, and the
// desktop has no suite of its own. See the handoff note in the round report.)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { loadMain, MAIN } = require("./testkit.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-main-"));
const TOKEN_FILE = "cloud9-owner-token.bin";

/** Load `main.cjs` against a fresh settings folder, with the safe write loaded. */
async function freshApp(opts = {}) {
  const userData = opts.userData ?? tmp();
  const loaded = loadMain({ userData, ...opts });
  const ok = await loaded.main.loadDurableWrite();
  assert.equal(ok, true,
    "main.cjs could not load the safe-write rule from @cloud9/engine — build it first");
  return { ...loaded, userData };
}

// ---------------------------------------------------------------------------
// THE BYTES THEMSELVES
// ---------------------------------------------------------------------------

test("the private key survives the trip to disk and back, byte for byte", async () => {
  const { main, userData } = await freshApp({ pad: 4096 });

  const first = main.ensureOwnerToken();
  assert.equal(first.ok, true, `first run could not make its key: ${first.why}`);
  assert.ok(first.token && first.token.length > 20);

  // the blob really is binary — a string round-trip would have mangled it
  const blob = fs.readFileSync(path.join(userData, TOKEN_FILE));
  assert.ok(blob.includes(0xff), "the test blob has no non-text bytes in it, so it proves nothing");
  assert.notEqual(Buffer.from(blob.toString("utf8"), "utf8").compare(blob), 0,
    "these bytes survive being turned into a string, so this is not the proof it looks like");

  assert.equal(main.readOwnerToken(), first.token, "the key did not come back as it went in");

  // and a second start recognises itself rather than minting a new key
  const again = main.ensureOwnerToken();
  assert.equal(again.ok, true);
  assert.equal(again.token, first.token,
    "the app made itself a NEW key on an ordinary second start — it is a stranger to its own hub");
});

test("the key is written next door and renamed in — never straight onto the real name", async () => {
  const { main, userData } = await freshApp();
  const written = [];
  const real = fs.writeFileSync;
  fs.writeFileSync = (p, d, o) => { if (typeof p === "string") written.push(p); return real(p, d, o); };
  try { main.ensureOwnerToken(); } finally { fs.writeFileSync = real; }

  assert.equal(written.length, 1, "written exactly once");
  assert.notEqual(path.basename(written[0]), TOKEN_FILE,
    "the bytes went straight to the real name — an interrupted write tears it");
  assert.ok(written[0].includes(".tmp-"), "and under a plainly temporary name");
  assert.equal(path.dirname(written[0]), userData,
    "the temporary file must be in the SAME folder or the rename is a copy, not atomic");
});

// ---------------------------------------------------------------------------
// THE REAL PROOF: A REAL PROCESS, KILLED MID-WRITE.
// ---------------------------------------------------------------------------

test("a real process killed mid-key-write leaves the app still knowing who it is", async () => {
  const userData = tmp();
  // First run happens properly: this install now HAS an identity.
  const settled = await freshApp({ userData });
  const original = settled.main.ensureOwnerToken();
  assert.equal(original.ok, true);
  const keyFile = path.join(userData, TOKEN_FILE);
  const before = fs.readFileSync(keyFile);

  // A child that rewrites the key through the very same code. The blob is
  // padded to ~48 MB so the write is still going when we pull the plug — the
  // code path is the real one, only the size is turned up. (A real key blob is
  // a few hundred bytes and its write window is a fraction of a millisecond;
  // that is a window you cannot aim at, not a window that is not there.)
  const PAD = 48 * 1024 * 1024;
  const script = path.join(userData, "writer.cjs");
  fs.writeFileSync(script, [
    `const kit = require(${JSON.stringify(path.join(__dirname, "testkit.cjs"))});`,
    `const loaded = kit.loadMain({ userData: ${JSON.stringify(userData)}, pad: ${PAD} });`,
    `loaded.main.loadDurableWrite().then(() => {`,
    `  process.send("about-to-write");`,
    `  setTimeout(() => {`,
    `    loaded.main.writeOwnerToken("A-COMPLETELY-DIFFERENT-KEY");`,
    `    process.send("finished");`,
    `  }, 1);`,
    `});`,
  ].join("\n"), "utf8");

  let caughtMidWrite = false;
  for (let attempt = 0; attempt < 14 && !caughtMidWrite; attempt++) {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    // Wait for "I am about to write" — but never for ever. A child that dies
    // first must be a loud failure, not a test that hangs until someone
    // notices. (It hung exactly once while this was being written.)
    const ready = await new Promise((resolve) => {
      child.once("message", () => resolve("ready"));
      child.once("exit", () => resolve("died"));
      setTimeout(() => resolve("timeout"), 30_000).unref();
    });
    assert.equal(ready, "ready", `the writer process ${ready} before it wrote anything`);
    // Sweep the moment of the kill across the whole life of the write, from
    // before it starts to after it should have ended. Aiming at one instant
    // catches the blob being built and proves nothing about the file.
    await new Promise(r => setTimeout(r, 2 + attempt * 15));
    child.kill("SIGKILL");
    await new Promise(resolve => child.once("exit", () => resolve()));

    const litter = fs.readdirSync(userData)
      .filter(n => n.includes(".tmp-"))
      .map(n => path.join(userData, n));
    const inFlight = litter.filter(f => { try { return fs.statSync(f).size > 0; } catch { return false; } });

    // WHATEVER happened, a fresh app must be able to read a WHOLE key.
    const after = await freshApp({ userData, pad: PAD });
    const known = after.main.readOwnerToken();
    assert.ok(known,
      "THE APP CAME BACK A STRANGER: the key file could not be read after an interrupted " +
      "write, and the next start would mint a new key over the top of it");
    assert.ok(known === original.token || known === "A-COMPLETELY-DIFFERENT-KEY",
      `the key on disk is neither the old one nor the new one — it is a mixture: ${known}`);

    // and `ensureOwnerToken` must accept it rather than replace it
    const asked = after.main.ensureOwnerToken();
    assert.equal(asked.ok, true);
    assert.equal(asked.token, known, "it read a good key and replaced it anyway");

    // WHAT IS ON THE DISK decides whether we caught it, never a message from a
    // process we killed — the child can finish the rename and die before it can
    // say so, and treating that as a torn write would be a false alarm.
    for (const f of litter) fs.rmSync(f, { force: true });
    if (known === "A-COMPLETELY-DIFFERENT-KEY") {
      // it beat us to the rename — reset and try to catch it earlier
      fs.writeFileSync(keyFile, before);
      continue;
    }
    // Only PROOF when we can see the write really was in flight: bytes on the
    // disk under the temporary name and the rename never done. Killing it
    // before it wrote anything proves nothing.
    if (inFlight.length === 0) continue;
    caughtMidWrite = true;
  }
  assert.ok(caughtMidWrite,
    "NEVER CAUGHT THE KEY WRITE IN FLIGHT. Either the proof did not really run, or — and " +
    "this is what it looks like when the whole-file rule is taken back out — there is no " +
    "in-flight file to catch, because the bytes are going straight onto the name the app " +
    "trusts. A write with nowhere to be half-done is a write that half-does the real file.");
});

test("the litter of a killed key write is swept away, and the key is not", async () => {
  const { main, userData } = await freshApp();
  main.ensureOwnerToken();
  fs.writeFileSync(path.join(userData, `${TOKEN_FILE}.tmp-999999-1-1`), Buffer.alloc(32, 0xff));
  fs.writeFileSync(path.join(userData, "settings.json.tmp-999999-1-1"), "{ half");

  assert.equal(main.sweepOwnLitter(), 2);
  assert.deepEqual(fs.readdirSync(userData).sort(), [TOKEN_FILE]);
});

// ---------------------------------------------------------------------------
// AND WHEN THE DISK SAYS NO.
// ---------------------------------------------------------------------------

test("a key that could not be saved stops first run — it is never used from memory only", async () => {
  const { main, userData } = await freshApp();
  const real = fs.renameSync;
  fs.renameSync = () => { throw new Error("the disk is full"); };
  let out;
  try { out = main.ensureOwnerToken(); } finally { fs.renameSync = real; }

  assert.equal(out.ok, false,
    "a key that never reached the disk was handed back as though it had — this run would " +
    "work and the next would not, with nothing to say why");
  assert.equal(out.token, undefined);
  assert.ok(/full|write/i.test(out.why), `and the reason says something: ${out.why}`);
  assert.deepEqual(fs.readdirSync(userData), [], "no half a key, and no litter either");
});

test("a key file that is there but cannot be read is KEPT, not written over", async () => {
  // The whole-file write means a torn key is no longer possible. A disk fault,
  // or Windows refusing to decrypt a blob made under another account, still is.
  // Minting a new key straight over the old one destroys the only copy of the
  // thing that proves who this install is.
  const { main, userData } = await freshApp();
  const first = main.ensureOwnerToken();
  const keyFile = path.join(userData, TOKEN_FILE);
  const whole = fs.readFileSync(keyFile);
  fs.writeFileSync(keyFile, whole.subarray(0, 6)); // as a torn write would have left it
  assert.equal(main.readOwnerToken(), null, "the truncated blob was read as if it were fine");

  const after = main.ensureOwnerToken();
  assert.equal(after.ok, true);
  assert.notEqual(after.token, first.token, "it is a new key — that part is unavoidable");

  const kept = fs.readdirSync(userData).filter(n => n.includes(".unreadable-"));
  assert.equal(kept.length, 1,
    "the unreadable key was destroyed rather than kept — there is now no way back at all");
  assert.equal(Buffer.compare(fs.readFileSync(path.join(userData, kept[0])), whole.subarray(0, 6)), 0);
});

// ---------------------------------------------------------------------------
// THE OTHER TWO FILES
// ---------------------------------------------------------------------------

test("his settings are saved whole, and a save that failed says so", async () => {
  const { main, userData } = await freshApp();
  assert.equal(main.writeSettings({ globalQuickChat: true, globalQuickChatKey: "Control+Alt+K" }), true);
  assert.deepEqual(main.readSettings(), { globalQuickChat: true, globalQuickChatKey: "Control+Alt+K" });
  assert.deepEqual(fs.readdirSync(userData), ["settings.json"], "no litter left behind");

  const real = fs.renameSync;
  fs.renameSync = () => { throw new Error("the disk is full"); };
  let ok;
  try { ok = main.writeSettings({ globalQuickChat: false }); } finally { fs.renameSync = real; }
  assert.equal(ok, false, 'this is the "Scheduled!" bug again: it reported a save that never happened');
  assert.deepEqual(main.readSettings(), { globalQuickChat: true, globalQuickChatKey: "Control+Alt+K" },
    "and every preference he has ever set survived the failed save");
});

test("a settings file that cannot be believed is announced, not silently swallowed", async () => {
  const { main, userData } = await freshApp();
  const said = [];
  const realErr = console.error;
  console.error = (...a) => said.push(a.join(" "));
  try {
    assert.deepEqual(main.readSettings(), {}, "no settings yet is an ordinary first run");
    assert.equal(said.length, 0, "and it must not complain about a file that was never there");
    fs.writeFileSync(path.join(userData, "settings.json"), '{"globalQuickChat": tr');
    assert.deepEqual(main.readSettings(), {});
  } finally { console.error = realErr; }
  assert.equal(said.length, 1, `a wrecked settings file said nothing at all: ${JSON.stringify(said)}`);
  assert.match(said[0], /settings file could not be read/);
  assert.ok(said[0].includes(path.join(userData, "settings.json")), "and it names the file");
});

test("a saved sign-in is written whole, comes back intact, and reports a failure", async () => {
  const { main, userData } = await freshApp({ pad: 2048 });
  assert.equal(main.saveSecret("claude", "oauthToken", "sk-not-a-real-token"), true);
  assert.deepEqual(main.loadSecret("claude"), { kind: "oauthToken", value: "sk-not-a-real-token" });
  assert.deepEqual(fs.readdirSync(userData), ["cloud9-credential-claude.bin"]);

  const real = fs.renameSync;
  fs.renameSync = () => { throw new Error("antivirus has it"); };
  let ok;
  try { ok = main.saveSecret("codex", "apiKey", "another-not-real-key"); } finally { fs.renameSync = real; }
  assert.equal(ok, false, "a sign-in that was not saved was reported as saved");
  assert.equal(main.loadSecret("codex"), null);
  assert.deepEqual(fs.readdirSync(userData), ["cloud9-credential-claude.bin"],
    "the other harness's sign-in was disturbed, or litter was left behind");
});

test("both ways main.cjs can reach the safe write land on the very same function", async () => {
  // Two routes to one file is fine. Two files would not be.
  const direct = await import("@cloud9/engine/dist/wholefile.js");
  const frontDoor = await import("@cloud9/engine");
  assert.equal(typeof direct.writeWholeFile, "function");
  assert.equal(direct.writeWholeFile, frontDoor.writeWholeFile,
    "the short route and the front door are different functions — that is a second copy");
  assert.equal(direct.sweepPending, frontDoor.sweepPending);
});

test("main.cjs holds no second copy of the safe-write rule", () => {
  // The whole point of this round was removing a second copy of one rule. A new
  // one appearing HERE, where it cannot be reviewed alongside the first, is the
  // same mistake wearing a different hat.
  const text = fs.readFileSync(MAIN, "utf8");
  assert.match(text, /await import\("@cloud9\/engine"\)/,
    "main.cjs no longer reaches the one owner of the safe write");
  for (const [what, pattern] of [
    ["a temporary-name scheme", /\.tmp-\$\{/],
    ["its own fsync", /fsyncSync/],
    ["its own rename-and-retry", /renameSync\([^)]*pending/],
  ]) {
    assert.doesNotMatch(text, pattern, `main.cjs has grown ${what} of its own`);
  }
});
