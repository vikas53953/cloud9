/*
 * THE SIDEBAR'S WORKSPACE HEADER — the guards that keep it readable.
 *
 * He reported the name of his floor arriving as "Studio flo…" on a sidebar
 * with nothing else in it. The cause was the order of who gives way: the
 * header was one unwrappable flex row with three fixed-width icon buttons
 * pinned at `flex:none`, so the name was the only item allowed to shrink and
 * paid the whole shortfall on its own.
 *
 * The competing 32px buttons are gone. The header is the floor's name, which
 * opens the room list. These assertions are on the source, so they hold for
 * ANY workspace name and any sidebar width — nothing here depends on the
 * name being "Studio floor".
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
  assert.match(app, /aria-label=\{`\$\{WORKSPACE_NAME\} — browse rooms`\}/,
    "a name the header shortened must still be announced in full");
  assert.match(app, /title=\{`\$\{WORKSPACE_NAME\} — browse rooms`\}/,
    "a name the header shortened must still be readable in full from its tooltip");
  assert.match(app, /\{WORKSPACE_NAME\} <span aria-hidden="true">▾<\/span>/,
    "the visible label must read the same constant the tooltip does");
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
  assert.match(name[1], /flex:1 1 auto/,
    "the name's flex base size must be its natural width — that is what makes " +
    "the header break rather than squeeze the name");
  assert.match(name[1], /text-overflow:ellipsis/,
    "a name longer than a whole row must still end cleanly");
});

/*
 * A DECLARATION THE BROWSER THROWS AWAY IS WORSE THAN NO DECLARATION — it
 * reads like a guarantee and gives none. This header shipped for a day with
 * `min-width:min(100%,max-content)`, which looks like "ask for your natural
 * width, never more than a row" and is in fact invalid: CSS math functions
 * take lengths and percentages, never an intrinsic keyword. Chromium dropped
 * the whole declaration and nobody could see it. This guard is written for
 * the CLASS, not that one line — it fails on any `min()`, `max()` or
 * `clamp()` anywhere in the sheet that is handed an intrinsic size keyword.
 */
test("no CSS math function is handed an intrinsic keyword it cannot take", () => {
  // Comments are blanked first (keeping the line count) so that the note
  // above this rule can name the mistake without tripping the guard.
  const css = read("styles.css").replace(/\/\*[\s\S]*?\*\//g,
    c => c.replace(/[^\n]/g, " "));
  // `min(`/`max(`/`clamp(` only when not part of a longer word, so the many
  // legitimate `minmax(0,1fr)` grid tracks are left alone.
  const MATH = /(?<![-\w])(?:min|max|clamp)\(((?:[^()]|\([^()]*\))*)\)/g;
  const INTRINSIC = /(?<![-\w])(?:max-content|min-content|fit-content)(?![-\w])/;
  const offenders = [];
  for (const m of css.matchAll(MATH)) {
    if (!INTRINSIC.test(m[1])) continue;
    offenders.push(`line ${css.slice(0, m.index).split("\n").length}: ${m[0]}`);
  }
  assert.deepEqual(offenders, [],
    "these declarations are invalid and the browser silently discards them — " +
    "use a wrap, a grid track or a plain length instead");
});

test("the header is the floor's name, not a row of icon buttons", () => {
  const app = read("App.tsx");
  const block = /<div className="sidebar-head">([\s\S]*?)<\/div>/.exec(app);
  assert.ok(block, "the floor still has a header");
  assert.match(block[1], /className="workspace-name"/,
    "the header that remains is the name");
  assert.doesNotMatch(block[1], /workspace-menu/,
    "the leftover V must not sit beside the name");
  assert.doesNotMatch(block[1], /workspace-new/,
    "the leftover + must not sit beside the name");
  assert.doesNotMatch(block[1], /workspace-agent/,
    "the leftover star must not sit beside the name");
  assert.doesNotMatch(block[1], /sidebar-head-actions/,
    "the header is the name, not a button cluster");
});
