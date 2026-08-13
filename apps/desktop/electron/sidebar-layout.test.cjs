const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");

test("sidebar layout is account/device scoped with keyboard-safe reorder and pins", () => {
  const app = read("App.tsx");
  const css = read("styles.css");
  assert.match(app, /cloud9\.sidebar-layout\.v1\.\$\{encodeURIComponent\(userId\)\}/,
    "layout storage must be scoped to the signed-in account");
  assert.match(app, /SidebarSectionOrder/);
  assert.match(app, /sidebarLayout\.layout\.sections\.map\(section =>/,
    "persisted section order must be the DOM order, not a CSS-only reorder");
  assert.doesNotMatch(app, /sectionStyle\(/, "section order must not depend on CSS order");
  /* The always-visible up/down buttons are gone; dragging replaced them. The
     keyboard route did NOT go with them — the grip still moves on the arrow
     keys, and a channel row still moves on Alt+Arrow. */
  assert.match(app, /className=\{`drag-grip\$\{dragging \? " is-dragging" : ""\}`\}/);
  assert.match(app, /aria-keyshortcuts="ArrowUp ArrowDown"/,
    "the section grip must announce its keyboard reorder");
  assert.match(app, /if \(e\.key !== "ArrowUp" && e\.key !== "ArrowDown"\) return;/);
  assert.match(app, /if \(up \? position <= 0 : position >= count - 1\) \{/,
    "the ends of the list must be respected, not wrapped");
  assert.match(app, /say\(`\$\{label\} section is already \$\{up \? "first" : "last"\}`\)/,
    "a move that cannot happen must say so rather than go silent");
  assert.match(app, /aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/,
    "a channel row must announce its keyboard reorder");
  assert.match(app, /nudgeChannel\(c\.id, c\.name, e\.key === "ArrowUp" \? -1 : 1\)/);
  assert.match(app, /<div className="sr-only" role="status" aria-live="polite">\{reorderSaid\}<\/div>/,
    "a keyboard move must be spoken, not silent");
  assert.match(app, /aria-pressed=\{isPinned\}/);
  assert.match(app, /aria-label=\{isPinned \? `Unpin \$\{c\.name\}` : `Pin \$\{c\.name\}`\}/);
  assert.match(app, /data-sidebar-section="channels"/);
  assert.match(app, /data-sidebar-section="direct"/);
  assert.match(app, /data-sidebar-section="people"/);
  assert.match(app, /Sidebar changes stay on this screen/);
  assert.match(app, /unavailable: true/,
    "storage read/parse failures must be represented immediately");
  assert.match(app, /const channelListLoaded = world\.connected && !!world\.me && !world\.authFailed/,
    "a loaded empty account must be distinguishable from loading/disconnected state");
  assert.match(app, /if \(!scope \|\| !channelListLoaded\) return/,
    "disconnected/loading empty lists must not erase durable pins");
  assert.match(css, /\.channel-pin/);
  assert.match(css, /@media \(max-width:320px\)[\s\S]*?\.sidebar-section-order/);
  assert.doesNotMatch(app, /draggable=/,
    "the grab is pointer-based like the thread divider, not HTML5 drag-and-drop");
});
