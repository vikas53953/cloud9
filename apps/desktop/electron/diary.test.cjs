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

test("nothing is written at all if the redaction rule cannot be loaded", async () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  const folder = await main.openDiary();
  // …now pretend the rule was never there, as it would be on a broken install
  const file = path.join(folder, "cloud9-main.log");
  fs.writeFileSync(file, "");
  const { main: second } = loadMain({ userData });
  // no `loadRedactor` call: `redactForDiary` is null in this copy
  console.log("[cloud9] must-not-reach-the-file");
  const written = fs.readFileSync(file, "utf8");
  assert.ok(!written.includes("must-not-reach-the-file"),
    "FAIL CLOSED: unchecked text does not go on the disk just because a rule failed to load");
  assert.ok(typeof second.loadRedactor === "function");
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
