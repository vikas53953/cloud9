const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");

test("channel context is membership-scoped, public-live, and accessible", () => {
  assert.match(app, /function ChannelContextSummary/);
  assert.match(app, /useLiveWorkByAgent\(\)/);
  assert.match(app, /messageIds\.has\(work\.messageId\)/);
  assert.match(app, /client\.askChannelPins\(channel\.id\)/);
  assert.match(app, /aria-controls=\{detailId\}/);
  assert.match(app, /id=\{`room-context-\$\{channel\.id\}`\}/);
  assert.match(app, /function RoomCanvases/);
  assert.match(app, /client\.askCanvases\(project\.id\)/);
  assert.match(app, /View-only summary\. Edit durable Canvas content in Canvas/);
  assert.match(app, /useEscapeCloses\(onClose, true\)/);
  assert.match(app, /useClickAwayCloses\(panelRef, onClose, true\)/);
});

test("channel context preserves narrow-window and keyboard/click-away contracts", () => {
  assert.match(app, /useEscapeCloses\(\(\) => setHeaderMenuOpen\(false\)/);
  assert.match(app, /useClickAwayCloses\(headerMenuRef/);
  assert.match(css, /\.channel-context-summary\{/);
  assert.match(css, /@media \(max-width:560px\)\{[\s\S]*channel-context-summary/);
  assert.match(css, /@media \(max-width:360px\)\{[\s\S]*channel-context-summary/);
  assert.match(css, /\.roomcanvas-row/);
});
