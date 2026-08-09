// The native menu remains installed for commands and accelerators, but its
// visible strip is intentionally hidden from the installed main window.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

function functionSlice(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must remain defined in main.cjs`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.notEqual(end, -1, `${nextName} must remain defined after ${name}`);
  return source.slice(start, end);
}

test("the main window hides the native strip without removing the application menu", () => {
  const mainWindow = functionSlice("createMainWindow", "toggleQuickWindow");

  assert.match(mainWindow, /autoHideMenuBar:\s*true/,
    "the installed main window should autohide its native menu bar");
  assert.match(mainWindow, /mainWin\.setMenuBarVisibility\(false\)/,
    "the main window should start with its native menu bar hidden");
  assert.match(mainWindow, /titleBarStyle:\s*"hidden"/,
    "the black native title strip should be replaced by Cloud9's themed drag area");
  assert.match(mainWindow, /titleBarOverlay:\s*titleBarOverlayFor/,
    "Windows controls should remain native while their surface follows the selected appearance");
  assert.match(source, /cloud9:setTitleBarAppearance/,
    "the renderer should be able to keep native window controls legible after a theme change");
  assert.match(source, /Menu\.setApplicationMenu\(Menu\.buildFromTemplate\(template\)\)/,
    "the application menu template must remain installed for commands and accelerators");
  assert.match(source, /return \{ label, accelerator,/,
    "the application menu should retain accelerator declarations");
  assert.match(source, /globalQuickChatKey|DEFAULT_GLOBAL_QUICK_CHAT_KEY/,
    "the global quick-chat accelerator path must remain available");
  for (const label of ["File", "Edit", "View", "Help"]) {
    assert.match(source, new RegExp(`label: "${label}"`),
      `the ${label} application-menu group must remain available`);
  }
});

test("quick chat window behavior is not changed by main-window menu hiding", () => {
  const quickWindow = functionSlice("toggleQuickWindow", "listenOnce");

  assert.doesNotMatch(quickWindow, /autoHideMenuBar|setMenuBarVisibility/,
    "quick chat must keep its existing frameless-window behavior");
  assert.match(quickWindow, /frame:\s*false/,
    "quick chat should remain frameless");
});
