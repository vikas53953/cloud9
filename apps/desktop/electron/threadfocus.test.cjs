// The thread's mode is a focus boundary, not only a visual one. Keep the
// source-level contract close to the desktop tests so a future cleanup cannot
// silently return keyboard users to <body> after the panel closes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const APP = path.join(__dirname, "..", "src", "App.tsx");
const source = fs.readFileSync(APP, "utf8");
const chat = source.slice(source.indexOf("function ChatScreen"), source.indexOf("function RailEmpty"));

test("thread takeover keeps an opener and restores a visible logical target", () => {
  assert.match(chat, /threadOpener = useRef<HTMLElement \| null>\(null\)/);
  assert.match(chat, /active instanceof HTMLElement && active !== document\.body/,
    "opening from the body must not overwrite a usable opener");
  assert.match(source, /target\.focus\(\{ preventScroll: true \}\)/,
    "restoration must be a real focus operation, not a CSS/source marker");
  assert.match(source, /el\.isConnected/,
    "a stale reply control must be rejected before it is focused");
  assert.match(chat, /requestAnimationFrame\(restoreThreadFocus\)/,
    "restoration must wait until inert/aria-hidden mode has rendered away");
  assert.match(source, /\.composer textarea:not\(:disabled\)/,
    "a missing opener needs a stable room-control fallback");
});

test("every keyboard route out of takeover requests focus restoration", () => {
  assert.match(chat, /const leaveTakeover = useCallback\(\(\) => \{\s*requestThreadFocusRestore\(\);/s,
    "beside/back and forced narrow back must request restoration");
  assert.match(chat, /onClose=\{\(\) => \{ requestThreadFocusRestore\(\); setThreadRoot\(null\); \}\}/,
    "closing the thread must request restoration");
  assert.match(chat, /const leftTakeover = previousTakeover\.current && !takeover/,
    "responsive forced/unforced transitions must be handled");
});
