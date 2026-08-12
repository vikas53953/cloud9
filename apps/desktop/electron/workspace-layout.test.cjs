const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");

test("workspace layouts are persisted with a fail-closed Focus default", () => {
  const app = read("App.tsx");
  assert.match(app, /export type WorkspaceLayout = "focus" \| "chat-files" \| "chat-diff" \| "review" \| "incident"/);
  for (const label of ["Focus chat", "Chat + Files", "Chat + Diff", "Review", "Incident"]) {
    assert.ok(app.includes(`label: "${label}"`), `missing layout label: ${label}`);
  }
  assert.match(app, /workspaceLayout: "focus"/);
  assert.match(app, /if \(!isWorkspaceLayout\([\s\S]*?next\.workspaceLayout = "focus"/);
});

test("layout control and panel are accessible and stay scoped to the current channel", () => {
  const app = read("App.tsx");
  assert.match(app, /aria-label="Workspace layout"/);
  assert.match(app, /aria-label="Close workspace panel and focus chat"/);
  assert.match(app, /focus-workspace/);
  assert.match(app, /withworkspace/);
  assert.match(app, /run\.channelId === channel\.id/);
  assert.match(app, /task\.channelId === channel\.id/);
  assert.match(app, /approval\.channelId === channel\.id/);
  assert.match(app, /handoff\.channelId === channel\.id/);
  assert.match(app, /No verified diff source is available for this room yet/);
  assert.match(app, /does not invent a source diff/);
  assert.doesNotMatch(app, /generate.*diff|fake.*diff/i);
});

test("workspace panel has honest offline, empty, refusal, and small-window states", () => {
  const app = read("App.tsx");
  const css = read("styles.css");
  assert.match(app, /The connection is offline\. Showing only records already received/);
  assert.match(app, /No review records are available for this room/);
  assert.match(app, /No incident record is available for this room/);
  assert.match(app, /data-diff-state=\{problem \? "refused"/);
  assert.match(css, /\.chatgrid\.withworkspace/);
  assert.match(css, /@media \(max-width:320px\)/);
  assert.match(css, /\.chatgrid\.withworkspace>\.workspace-layout-panel\{inset:0;/);
});

test("workspace access loss fails closed and panel dismissal restores the picker", () => {
  const app = read("App.tsx");
  const panel = app.slice(app.indexOf("function WorkspaceLayoutPanel"), app.indexOf("function RailEmpty"));
  assert.match(panel, /currentChannel = world\.channels\.find\(candidate => candidate\.id === channel\.id\)/);
  assert.match(panel, /currentChannel\.memberIds\.includes\(world\.meId\)/);
  assert.match(panel, /filter\(run => hasAccess && run\.channelId === channel\.id\)/);
  assert.match(panel, /filter\(task => hasAccess && task\.channelId === channel\.id\)/);
  assert.match(panel, /if \(!hasAccess\) return false/);
  assert.match(panel, /data-access-state="unavailable"/);
  assert.match(panel, /useEscapeCloses\(onClose, true\)/);
  assert.match(panel, /window\.setTimeout\(onClose, 0\)/);
  assert.match(panel, /useClickAwayCloses\(panelRef, closeAfterOutsideClick, true\)/);
  assert.match(app, /priorWorkspaceLayout/);
  assert.match(app, /workspaceLayoutRef\.current\?\.focus/);
});
