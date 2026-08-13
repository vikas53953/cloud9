const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");

/* THE SIDEBAR IS REORDERED BY HAND NOW — the two arrow buttons that used to sit
   on every section heading are gone. What replaces them has to keep three
   promises this file guards: a click that never travelled is still a click, the
   line showing where a row will land is real drawn UI, and nothing here claims
   an order the device did not actually store. */
test("dragging a sidebar row shows where it lands and only claims what it stored", () => {
  const app = read("App.tsx");
  const css = read("styles.css");
  /* Nothing is captured and no default is prevented until the pointer has
     passed the grab threshold, so a plain click still opens the room. */
  assert.match(app, /if \(Math\.abs\(ev\.clientY - startY\) < DRAG_GRAB_PX\) return;/,
    "a drag must not begin before the pointer has actually travelled");
  assert.match(app, /if \(channelDrag\.moved\.current\) \{ channelDrag\.moved\.current = false; return; \}/,
    "a finished drag must not also open the room it landed on");
  /* Escape must abandon the drag, and through the app's ONE escape owner — a
     private key listener never sees the press once the stack has stopped it. */
  assert.match(app, /const abandon = \(\): void => settle\(false\);/);
  assert.match(app, /escapeStack\.push\(abandon\);/);
  assert.match(app, /const at = escapeStack\.lastIndexOf\(abandon\);/);
  assert.doesNotMatch(app, /addEventListener\("keydown", key, true\)/,
    "the drag must not keep a private Escape listener beside the escape stack");
  /* The drop line is real UI, not a promise: it is drawn on the row under the
     pointer and says which edge. */
  assert.match(app, /data-drop-edge.*drag\.after \? "after" : "before"/);
  assert.match(css, /\[data-drop-edge\]::after/, "the drop indicator must be visible");
  assert.match(css, /\[data-drop-edge="before"\]::after/);
  assert.match(css, /\[data-drop-edge="after"\]::after/);
  assert.match(css, /\.drag-grip\{/);
  /* Rows only accept rows of their OWN list, so nothing can be dropped into a
     list whose order the drop would not actually change. */
  assert.match(app, /\[data-drag-list="\$\{list\}"\]\[data-drag-item\]/);
  assert.match(app, /data-drag-list=\{list\} data-drag-item=\{c\.id\}/);
  assert.match(app, /data-drag-list="sidebar-sections" data-drag-item="channels"/);
  /* Channel order lives on the SAME device-local shelf as the section order and
     the pins — no relay call is made, so nothing here can claim the account was
     changed. The reconcile pass drops ids the account no longer has. */
  assert.match(app, /channelOrder: string\[\];/);
  assert.match(app, /const channelOrder = current\.channelOrder\.filter\(id => visible\.has\(id\)\);/,
    "a deleted channel must not keep a rank");
  assert.match(app, /const inChosenOrder = /);
  assert.match(app, /rankOf\(a\.id\) - rankOf\(b\.id\)/,
    "an undragged channel must keep the position the account's channel list gave it");
});
