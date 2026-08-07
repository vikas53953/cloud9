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
