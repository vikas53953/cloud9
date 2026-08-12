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

test("the diary is only put on the disk when the app says it has started", () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  assert.deepEqual(fs.readdirSync(userData), []);

  const folder = main.openDiary();
  assert.equal(folder, path.join(userData, "logs"));
  assert.ok(fs.existsSync(path.join(folder, "cloud9-main.log")),
    "the folder the Help menu opens must be a folder something really writes to");
});

test("what was said before the file existed is not lost", () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  // said while the process was coming up — before there is anywhere to put it
  console.log("[cloud9] a-line-said-before-the-diary-opened");
  main.openDiary();
  console.log("[cloud9] a-line-said-after-the-diary-opened");

  const written = fs.readFileSync(path.join(userData, "logs", "cloud9-main.log"), "utf8");
  assert.match(written, /a-line-said-before-the-diary-opened/,
    "THE INTERESTING LINES ARE THE EARLY ONES: harness detection and engine attach happen " +
    "while the app is still starting, and they are exactly what blocker 3 needed");
  assert.match(written, /a-line-said-after-the-diary-opened/);
  assert.match(written, /\d{4}-\d{2}-\d{2}T[\d:.]+Z INFO /,
    "every line carries when it was said, or it cannot be lined up with what he saw");
});

test("a failure goes in as a failure, so a red line can be found by reading for one", () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  main.openDiary();
  console.error("[cloud9] the-engine-fell-over");
  console.warn("[cloud9] something-was-odd");

  const written = fs.readFileSync(path.join(userData, "logs", "cloud9-main.log"), "utf8");
  assert.match(written, /ERROR \[cloud9\] the-engine-fell-over/);
  assert.match(written, /WARN \[cloud9\] something-was-odd/);
});

test("an Error is written as words, never as an empty object", () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  main.openDiary();
  console.error("[cloud9] the hub could not start:", new Error("the port was taken"));

  const written = fs.readFileSync(path.join(userData, "logs", "cloud9-main.log"), "utf8");
  assert.match(written, /the port was taken/,
    "`JSON.stringify(new Error(...))` is `{}` — a log full of those is worse than no log");
});

test("a diary that cannot be opened never takes the app down", () => {
  const userData = tmp();
  const { main } = loadMain({ userData });
  // a FILE where the logs folder wants to be: mkdir cannot win this
  fs.writeFileSync(path.join(userData, "logs"), "not a folder");
  assert.doesNotThrow(() => {
    assert.equal(main.openDiary(), null);
  });
  // and the console still works afterwards
  assert.doesNotThrow(() => console.log("[cloud9] still running"));
});
