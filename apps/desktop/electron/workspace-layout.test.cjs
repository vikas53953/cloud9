const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");
/** Prose explaining a rule is not the rule. "Must not appear" reads code only. */
const codeOnly = source => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

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
  assert.match(app, /priorWorkspaceLayout/);
  assert.match(app, /workspaceLayoutRef\.current\?\.focus/);
});

test("a chosen workspace layout is never undone by a click somewhere else", () => {
  const app = read("App.tsx");
  const panel = app.slice(app.indexOf("function WorkspaceLayoutPanel"), app.indexOf("function RailEmpty"));
  /* The reported bug: pick Chat + Files, click anywhere at all, and the room
     snapped back to Focus on its own. The panel was closing itself on any
     outside pointer while the layout it drew was a saved preference, so an
     ordinary click rewrote a deliberate choice. The panel must not listen for
     outside pointers at all — no click-away hook, no deferred close timer. */
  const panelCode = codeOnly(panel);
  assert.doesNotMatch(panelCode, /useClickAwayCloses/);
  assert.doesNotMatch(panelCode, /closeAfterOutsideClick/);
  assert.doesNotMatch(panelCode, /pointerdown/);
  /* The deliberate ways out are all still there. */
  assert.match(panelCode, /useEscapeCloses\(onClose, true\)/);
  assert.match(panelCode, /aria-label="Close workspace panel and focus chat"[\s\S]*?onClick=\{onClose\}/);
  assert.match(panelCode, /data-access-state="unavailable"/);
  /* And the choice itself still comes from, and goes back to, the one durable
     per-user preference — not a piece of throwaway panel state. */
  assert.match(app, /const workspaceLayout = p\.workspaceLayout/);
  assert.match(app, /onWorkspaceLayout=\{layout => prefs\.set\(\{ workspaceLayout: layout \}\)\}/);
  assert.match(app, /closeWorkspace = useCallback\(\(\) => \{ prefs\.set\(\{ workspaceLayout: "focus" \}\); \}/);
});

test("a saved layout is not overwritten while the room list has not answered yet", () => {
  const app = codeOnly(read("App.tsx"));
  /* The other half of the same bug: on every launch and reconnect the room list
     is briefly empty, and reading that silence as "this room is not yours" wrote
     Focus over the saved choice — so Chat + Files never survived a restart. The
     durable preference may only be rewritten on a KNOWN refusal: the account has
     answered (`channelListLoaded`), a room is open, and this person is not in it. */
  assert.match(app, /const workspaceAccessRefused = channelListLoaded && !!active && !!world\.me && !workspaceAccess/);
  assert.match(app, /if \(workspaceAccessRefused && workspaceLayout !== "focus"\) closeWorkspace\(\)/);
  assert.doesNotMatch(app, /if \(!workspaceAccess && workspaceLayout !== "focus"\)/);
  /* Nothing is shown while the answer is missing: drawing still fails closed on
     `workspaceAccess` itself, and the panel keeps its own membership gate. */
  assert.match(app, /active && workspaceAccess && !threadRoot && !detailsOpen && !takeover && workspaceLayout !== "focus"/);
  assert.match(app, /hasAccess = !!world\.meId && !!currentChannel && currentChannel\.memberIds\.includes\(world\.meId\)/);
});
