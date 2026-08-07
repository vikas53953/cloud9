const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("notification source jumps mark read only after the leave guard accepts", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  const start = source.indexOf("const openInboxEntry = useCallback");
  const end = source.indexOf("/* ASKED ON THE WAY IN", start);
  assert.ok(start >= 0 && end > start, "notification navigation callback is present");
  const block = source.slice(start, end);
  const leave = block.indexOf("attemptLeave(() => {");
  const mark = block.indexOf("client.markNotificationRead(entry.id)");
  assert.ok(leave >= 0 && mark > leave,
    "a blocked unsaved draft must not mark a notification read");
  assert.match(block, /entry\.sourceState !== "active"/,
    "deleted and inaccessible sources remain non-navigable");
});
