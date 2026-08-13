/*
 * THE SIDEBAR'S WORKSPACE HEADER — the guards that keep it readable.
 *
 * He reported the name of his floor arriving as "Studio flo…" on a sidebar
 * with nothing else in it. The cause was the order of who gives way: the
 * header was one unwrappable flex row with three fixed-width icon buttons
 * pinned at `flex:none`, so the name was the only item allowed to shrink and
 * paid the whole shortfall on its own.
 *
 * These assertions are on the source, so they hold for ANY workspace name and
 * any sidebar width — nothing here depends on the name being "Studio floor".
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");

test("the workspace name is written once and carried into its tooltip and label", () => {
  const app = read("App.tsx");
  assert.match(app, /const WORKSPACE_NAME = "/,
    "the floor's name must have one source, so the header and its tooltip cannot drift");
  assert.match(app, /aria-label=\{`\$\{WORKSPACE_NAME\} — workspace options`\}/,
    "a name the header shortened must still be announced in full");
  assert.match(app, /title=\{`\$\{WORKSPACE_NAME\} — workspace options`\}/,
    "a name the header shortened must still be readable in full from its tooltip");
  assert.doesNotMatch(app, /className="workspace-name"[^>]*>Studio floor/,
    "the header must not hard-code the name a second time");
});

test("the header gives the name the row before anything else is measured", () => {
  const css = read("styles.css");
  const head = /\.sidebar-head\{([^}]*)\}/.exec(css);
  assert.ok(head, ".sidebar-head must still be styled here");
  assert.match(head[1], /flex-wrap:wrap/,
    "the header must be allowed to wrap rather than clip the name");

  const name = /\n\.workspace-name\{([^}]*)\}/.exec(css);
  assert.ok(name, ".workspace-name must still be styled here");
  assert.match(name[1], /min-width:min\(100%,max-content\)/,
    "the name must ask for its natural width, and never for more than one row");
  assert.doesNotMatch(name[1], /min-width:0/,
    "min-width:0 is what let every other control take the name's room first");
  assert.match(name[1], /text-overflow:ellipsis/,
    "a name longer than a whole row must still end cleanly");

  assert.match(css, /\.sidebar-head-actions\{[^}]*flex:none/,
    "the header's controls must move as one block, not wrap one at a time");
});

test("the header's controls are one block in the markup, not loose in the row", () => {
  const app = read("App.tsx");
  const block = /<div className="sidebar-head-actions">([\s\S]*?)<\/div>/.exec(app);
  assert.ok(block, "the header controls must sit inside .sidebar-head-actions");
});
