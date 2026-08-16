// ============================================================================
// THE APP'S OWN DIARY — because "logs before guesses" needs there to be a log.
// ============================================================================
//
// 2026-08-12, installed blocker 3. An agent in the installed app answered "my
// engine isn't connected" and nobody could say why. The engine host writes the
// answer down every single time — `[engine-host] Claude connected (…)`,
// `[engine-host] Claude disconnected`, `claude installed=… signedIn=…` — and in
// a packaged Electron app on Windows those `console.log` lines go to a console
// that is not attached to anything. The Help menu offered "Open the app's log
// folder", pointing at a folder nothing had ever written to, so pressing it
// failed silently as well. A whole round of diagnosis was spent inferring what
// the app already knew and had already said.
//
// Two properties are held here, and the second is the one that bit:
//
//   1. the diary really is written, and it carries what was said BEFORE the
//      file existed as well as after;
//   2. merely LOADING `main.cjs` writes nothing at all. `main.durability.test`
//      asserts the exact contents of the user's folder — a stray file there is
//      the bug it exists to catch — and the first version of the diary made a
//      folder as an import side effect and broke four of its cases.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { loadMain } = require("./testkit.cjs");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-diary-"));

test("loading main.cjs writes nothing into the user's folder", () => {
  const userData = tmp();
  loadMain({ userData });
  assert.deepEqual(fs.readdirSync(userData), [],
    "requiring a module must not make folders — this is the property main.durability.test.cjs " +
    "depends on when it asserts exactly what is in the user's folder");
});

test("the diary is only put on the disk when the app says it has started", async () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  assert.deepEqual(fs.readdirSync(userData), []);

  const folder = await main.openDiary();
  assert.equal(folder, path.join(userData, "logs"));
  assert.ok(fs.existsSync(path.join(folder, "cloud9-main.log")),
    "the folder the Help menu opens must be a folder something really writes to");
});

test("what was said before the file existed is not lost", async () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  // said while the process was coming up — before there is anywhere to put it
  console.log("[cloud9] a-line-said-before-the-diary-opened");
  await main.openDiary();
  console.log("[cloud9] a-line-said-after-the-diary-opened");

  const written = fs.readFileSync(path.join(userData, "logs", "cloud9-main.log"), "utf8");
  assert.match(written, /a-line-said-before-the-diary-opened/,
    "THE INTERESTING LINES ARE THE EARLY ONES: harness detection and engine attach happen " +
    "while the app is still starting, and they are exactly what blocker 3 needed. They are " +
    "also said BEFORE the redaction rule can be loaded, so they are held raw in memory and " +
    "redacted on the way out — dropping them would have emptied the diary of its whole point");
  assert.match(written, /a-line-said-after-the-diary-opened/);
  assert.match(written, /\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO /,
    "every line carries when it was said, or it cannot be lined up with what he saw");
});

test("a failure goes in as a failure, so a red line can be found by reading for one", async () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  await main.openDiary();
  console.error("[cloud9] the-engine-fell-over");
  console.warn("[cloud9] something-was-odd");

  const written = fs.readFileSync(path.join(userData, "logs", "cloud9-main.log"), "utf8");
  assert.match(written, /ERROR \[cloud9\] the-engine-fell-over/);
  assert.match(written, /WARN \[cloud9\] something-was-odd/);
});

test("an Error is written with its frames, not as an empty object", async () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  await main.openDiary();
  console.error("[cloud9] the hub could not start:", new Error("the port was taken"));

  const written = fs.readFileSync(path.join(userData, "logs", "cloud9-main.log"), "utf8");
  assert.match(written, /the port was taken/,
    "`JSON.stringify(new Error(...))` is `{}` — a log full of those is worse than no log");
  assert.match(written, /at /,
    "LOGS BEFORE GUESSES: a crash that lands as a one-line summary with no frames sends the " +
    "next person back to guessing. The redaction pass is what makes keeping them safe");
});

// ---------------------------------------------------------------------------
// WHAT MAY BE WRITTEN DOWN — enforced by the sink, not by its callers.
// ---------------------------------------------------------------------------

test("A SECRET SAID TO THE CONSOLE DOES NOT REACH THE FILE", async () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  await main.openDiary();
  // exactly the shape `sanitizeForChat` deliberately console.errors RAW
  console.error("[cloud9] the harness fell over:",
    "spawn failed: ANTHROPIC_API_KEY=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");

  const written = fs.readFileSync(path.join(userData, "logs", "cloud9-main.log"), "utf8");
  assert.ok(!written.includes("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    "THE TEE PERSISTS WHAT USED TO BE EPHEMERAL. Before this the promise was a property of " +
    "hundreds of console calls in electron/ and packages/engine/; it is now a property of " +
    `the sink: ${written}`);
  assert.match(written, /\*\*\*/, "and it is the engine's own tested rule doing it");
  assert.match(written, /the harness fell over/, "while the useful part still arrives");
});

test("this computer's own account name does not reach the log either", async () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  await main.openDiary();
  const me = os.userInfo().username;
  console.log(`[cloud9] agent folder for ${me} at ${os.homedir()}`);

  const written = fs.readFileSync(path.join(userData, "logs", "cloud9-main.log"), "utf8");
  assert.ok(!written.includes(me),
    "PINNED ON PURPOSE: `redactForSharing` only blanks this machine's names once " +
    "`setMachineNames` has run, and the only thing that runs it is `@cloud9/engine`'s own " +
    `import side effect. A refactor that stops pulling provider.js in would silently weaken ` +
    `this with nothing to say so: ${written}`);
});

// ---------------------------------------------------------------------------
// AND WHEN THE REAL RULE CANNOT BE LOADED AT ALL.
//
// This is not a hypothetical branch. "The packaged app cannot load
// @cloud9/engine" is one of the live root-cause hypotheses for blocker 8.3
// itself — so it is precisely the session where the diary matters most, and the
// first version of it responded by writing ONE generic warning and discarding
// every startup line including the loader's own error. A diagnostic instrument
// that switches itself off inside the failure it exists to diagnose is not an
// instrument. It degrades now instead.
// ---------------------------------------------------------------------------

/** An `@cloud9/engine` that cannot be found, exactly as a broken install fails. */
const brokenEngine = async () => {
  throw new Error("Cannot find package '@cloud9/engine' imported from " +
    "C:\\Users\\vikasmit\\AppData\\Local\\Programs\\Cloud9\\resources\\app\\electron\\main.cjs");
};

test("A LOST REDACTION RULE DEGRADES THE LOG — it does not empty it", async () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  console.log("[cloud9] STARTUP-LINE-ONE claude installed=true signedIn=false");
  await main.openDiary({ importEngine: brokenEngine });
  console.log("[cloud9] STARTUP-LINE-TWO engine online");

  const written = fs.readFileSync(path.join(userData, "logs", "cloud9-main.log"), "utf8");
  assert.match(written, /STARTUP-LINE-ONE claude installed=true signedIn=false/,
    "THE LINE BLOCKER 3 NEEDED was thrown away by the old fail-closed branch");
  assert.match(written, /STARTUP-LINE-TWO/, "and lines said after it are kept too");
});

test("…and it says loudly that it is degraded, and why", async () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  await main.openDiary({ importEngine: brokenEngine });
  console.log("[cloud9] an-ordinary-line");

  const written = fs.readFileSync(path.join(userData, "logs", "cloud9-main.log"), "utf8");
  assert.match(written, /REDUCED LOGGING THIS SESSION/,
    "a person reading this file must not mistake the blunt rule's output for the real one's");
  assert.match(written, /Cannot find package '@cloud9\/engine'/,
    "THE SINGLE MOST VALUABLE SENTENCE the app can write in this session is the reason, and " +
    "`console.error` in a packaged main process goes nowhere — so it has to land here");
  assert.match(written, /INFO~ \[cloud9\] an-ordinary-line/,
    "every degraded line carries its own mark, so they can all be found with one search");
});

test("the reduced rule still keeps secrets out", async () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  await main.openDiary({ importEngine: brokenEngine });
  console.error("[cloud9] spawn failed:",
    "ANTHROPIC_API_KEY=sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB " +
    "at C:\\Users\\vikasmit\\.local\\bin\\claude.exe");

  const written = fs.readFileSync(path.join(userData, "logs", "cloud9-main.log"), "utf8");
  assert.ok(!written.includes("sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
    `FAILING CLOSED ON SECRETS is the part that must not change: ${written}`);
  assert.ok(!written.includes("C:\\Users\\vikasmit\\.local\\bin"),
    "absolute paths are still cut down to their last segment");
  assert.match(written, /claude\.exe/, "while the part worth reading survives");
  assert.match(written, /spawn failed/);
});

test("the reduced rule is blunt on purpose, and never throws", () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  const r = main.plainlyRedact;
  assert.equal(r(""), "");
  assert.equal(r(null), "");
  assert.equal(r(undefined), "");
  assert.match(r("CLOUD9_CRED=hunter2 stays out"), /CLOUD9_CRED=\*\*\*/);
  assert.match(r("token ghp_AAAAAAAAAAAAAAAAAAAA here"), /\*\*\*/);
  assert.match(r("/Users/vikasmit/notes/secret.md"), /secret\.md/);
  assert.ok(!r("/Users/vikasmit/notes/secret.md").includes("vikasmit"));
  // it caps, so one enormous line cannot swamp the file
  assert.ok(r("x".repeat(9000)).length <= 4000);
});

// ---------------------------------------------------------------------------
// AND WHEN THINGS GO WRONG.
// ---------------------------------------------------------------------------

test("a diary that cannot be opened never takes the app down", async () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  // a FILE where the logs folder wants to be: mkdir cannot win this
  fs.writeFileSync(path.join(userData, "logs"), "not a folder");
  assert.equal(await main.openDiary(), null);
  // and the console still works afterwards
  assert.doesNotThrow(() => console.log("[cloud9] still running"));
});

test("Electron refusing to name the logs folder falls back to the user's own folder", () => {
  const userData = tmp();
  // real Electron has refused `getPath("logs")` until the folder exists
  const { main } = loadMain({ userData, getPathThrowsFor: ["logs"] });
  assert.equal(main.diaryFolder(), path.join(userData, "logs"),
    "the fallback existed but nothing had ever taken it");
});

test("the Help menu really opens the folder, and makes it if it is gone", async () => {
  const userData = tmp();
  const { main, state } = loadMain({ userData });
  await main.openDiary();
  fs.rmSync(path.join(userData, "logs"), { recursive: true, force: true });

  const out = await main.openLogFolder();
  assert.equal(out.ok, true);
  assert.ok(fs.existsSync(path.join(userData, "logs")),
    "a folder deleted while the app is running is remade rather than failing without a word");
  assert.deepEqual(state.openedPaths, [path.join(userData, "logs")]);
  assert.equal(state.messageBoxes.length, 0, "nothing to complain about, so it says nothing");
});

test("and when the folder will not open, he is TOLD rather than left pressing a dead menu item", async () => {
  const userData = tmp();
  const { main, state } = loadMain({ userData, openPathProblem: "Windows would not open it" });
  const out = await main.openLogFolder();
  assert.equal(out.ok, false);
  assert.equal(out.problem, "Windows would not open it");
  assert.equal(state.messageBoxes.length, 1,
    "THE OLD BEHAVIOUR WAS SILENCE — `shell.openPath` returns its refusal as a string and " +
    "the return value was thrown away, so the menu item did nothing and said nothing");
  assert.match(state.messageBoxes[0].message, /could not open its log folder/i);
  assert.match(state.messageBoxes[0].detail, /Windows would not open it/);
});
