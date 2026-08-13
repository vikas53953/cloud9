const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");
/** Prose explaining a rule is not the rule. "Must not appear" reads code only. */
const codeOnly = source => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
/**
 * One function's body, bounded by the NEXT top-level function — the same helper
 * `room-visible-agent-state.test.cjs` uses. A hand-written end marker (`indexOf`
 * of some other function's name) silently returns -1 if that name is ever moved
 * or renamed, and `slice(x, -1)` then widens to the whole file: the "must not
 * appear" checks would still fail loudly, but every "must appear" check would
 * start passing on text from anywhere. This cannot do that.
 */
const bodyOf = (app, name) => {
  const from = app.indexOf(`\nfunction ${name}(`);
  assert.notEqual(from, -1, `${name} should still exist in App.tsx`);
  const next = app.indexOf("\nfunction ", from + 1);
  return app.slice(from, next === -1 ? app.length : next);
};

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
  const panel = bodyOf(app, "WorkspaceLayoutPanel");
  assert.match(panel, /currentChannel = world\.channels\.find\(candidate => candidate\.id === channel\.id\)/);
  assert.match(panel, /currentChannel\.memberIds\.includes\(world\.meId\)/);
  assert.match(panel, /filter\(run => hasAccess && run\.channelId === channel\.id\)/);
  assert.match(panel, /filter\(task => hasAccess && task\.channelId === channel\.id\)/);
  assert.match(panel, /if \(!hasAccess\) return false/);
  assert.match(panel, /data-access-state="unavailable"/);
  /* Escape still dismisses the panel — see the dedicated Escape test below for
     the shape it must have (the panel's own keyboard, never the shared stack). */
  assert.match(codeOnly(panel), /event\.key !== "Escape"/);
  assert.match(app, /priorWorkspaceLayout/);
  assert.match(app, /workspaceLayoutRef\.current\?\.focus/);
});

test("a chosen workspace layout is never undone by a click somewhere else", () => {
  const app = read("App.tsx");
  const panel = bodyOf(app, "WorkspaceLayoutPanel");
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

test("Escape belongs to whatever has the keyboard, so a workspace cannot steal it", () => {
  const app = read("App.tsx");
  const panel = codeOnly(bodyOf(app, "WorkspaceLayoutPanel"));

  /* WHY THIS TEST EXISTS. The same bug as the click-away, by keyboard: with a
     workspace open, pressing Escape while editing a message did NOT put the
     words back, and DID rewrite the durable `workspaceLayout` to Focus. The
     cause was that this side panel registered on the overlay escape stack. */

  /* (a) The stack is capture-phase and stops the event — which is exactly why a
     panel beside the conversation must not be on it. Pinned so the reasoning
     behind (b) stays true if the stack is ever reshaped. */
  const stack = app.slice(app.indexOf("const escapeStack"), app.indexOf("function useEscapeCloses"));
  assert.match(stack, /e\.stopPropagation\(\)/);
  assert.match(stack, /\}, true\);/);

  /* (b) So the panel is NOT on it. */
  assert.doesNotMatch(panel, /useEscapeCloses/);

  /* (c) Escape is scoped to the panel's own keyboard: it acts only while the
     focus is inside the panel, so an Escape meant for a message being edited,
     the composer, or a field anywhere else never reaches this close. */
  assert.match(panel, /if \(event\.key !== "Escape"\) return;/);
  assert.match(panel, /const focused = document\.activeElement;/);
  assert.match(panel, /if \(!panel \|\| !focused \|\| !panel\.contains\(focused\)\) return;/);
  assert.match(panel, /onClose\(\);/);

  /* (d) Nothing is captured and nothing is stopped, so no other Escape can be
     taken from anything. `preventDefault` is allowed — it fires only after the
     focus check has already decided this key was ours. */
  assert.doesNotMatch(panel, /addEventListener\("keydown", onKeyDown, true\)/);
  assert.doesNotMatch(panel, /stopPropagation/);
  assert.match(panel, /window\.addEventListener\("keydown", onKeyDown\);/);
  assert.match(panel, /window\.removeEventListener\("keydown", onKeyDown\);/);

  /* (e) And the Escape it used to steal still exists and still means what it
     said: put my words back, without touching any preference. */
  assert.match(codeOnly(app), /if \(e\.key === "Escape"\) \{ setEditing\(false\); setDraft\(m\.text\); \}/);
});
