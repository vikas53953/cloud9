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

test("OS notification jumps keep room and thread state inside the leave guard", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  const start = source.indexOf("const openNotification = useCallback");
  const end = source.indexOf("useEffect(() => {", start);
  assert.ok(start >= 0 && end > start, "OS notification callback is present");
  const block = source.slice(start, end);
  const leave = block.indexOf("attemptLeave(() => {");
  assert.ok(leave >= 0, "notification navigation has a leave guard");
  for (const setter of ["setActiveId(target.channelId)", "setScreen(\"chat\")", "setJumpTo(", "setOpenThreadFor("]) {
    assert.ok(block.indexOf(setter) > leave, `${setter} must run only after the guard accepts`);
  }
  assert.equal(block.includes("goChannel(target.channelId)"), false,
    "notification navigation must not leave guarded state outside the callback");
  const room = block.indexOf('target.go === "room"');
  assert.ok(room >= 0, "artifact notifications restore their room destination");
  const roomLeave = block.indexOf("attemptLeave(() => {", room);
  assert.ok(roomLeave > room, "artifact room destination is guarded");
  for (const setter of ["setActiveId(target.channelId)", "setScreen(\"chat\")"]) {
    assert.ok(block.indexOf(setter, roomLeave) > roomLeave,
      `${setter} must stay inside the guarded artifact branch`);
  }
});

test("notification inbox answers are request-correlated and fetched once on mount", () => {
  const store = fs.readFileSync(path.join(__dirname, "..", "src", "store.ts"), "utf8");
  const askStart = store.indexOf("askNotifications(includeDismissed");
  const askEnd = store.indexOf("markNotificationRead", askStart);
  assert.ok(askStart >= 0 && askEnd > askStart, "notification ask method is present");
  const askBlock = store.slice(askStart, askEnd);
  assert.match(askBlock, /requestId/);
  assert.match(askBlock, /f\.requestId === requestId/,
    "out-of-order inbox answers must match the active request id");
  assert.match(askBlock, /notificationsRequestId = undefined/,
    "late answers after refusal/loss must be invalidated");
  assert.match(askBlock, /notificationsProblem/,
    "loading/error state belongs to the active inbox request");
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  const openStart = app.indexOf("const openNotifications = useCallback");
  const openEnd = app.indexOf("/* Asked on the way in", openStart);
  assert.ok(openStart >= 0 && openEnd > openStart);
  assert.equal(app.slice(openStart, openEnd).includes("askNotifications"), false,
    "opening the screen must not issue a duplicate fetch before its mount effect");
});
