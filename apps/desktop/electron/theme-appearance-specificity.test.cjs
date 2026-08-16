/**
 * THE GUARD FOR THE BUG THAT MADE A CLICKED SIDEBAR ITEM LOOK DISABLED.
 *
 * The fault was never a colour. It was a SELECTOR WEIGHT. A block that
 * completes the dark palette (`--bg`, `--ink`, `--rail-active-ink`, …) was
 * written as
 *
 *   :root:not([data-appearance="light"]):not([data-theme="light"])
 *
 * which is specificity 0-3-0 — heavier than every named palette below it
 * (`:root[data-theme="nord"]`, 0-2-0). So under a dark Windows all ten dark
 * palettes were repainted with one set of pigments (Nord and Dracula came out
 * byte-identical, High Contrast Dark lost `--line:#FFF`), and under a light
 * Windows the block did not match at all, so a dark palette fell through to the
 * LIGHT ink and the selected rail chip measured 1.32–2.11:1.
 *
 * These tests do not check pixels. They check the two structural facts that
 * make the pixels impossible to get wrong again:
 *
 *   1. Nothing that hands out palette tokens may weigh more than a named
 *      palette block (0-2-0), and the shared dark base must sit BEFORE the
 *      named palettes so they can override it.
 *   2. "Is this a dark screen?" has exactly one owner — the resolved
 *      `data-appearance` attribute that `applyTheme` writes before first paint
 *      — never the operating system's media query and never the single palette
 *      that happens to be named "dark".
 *
 * A third test covers the same fault one surface over: a control that sits on
 * the canvas must not be painted with the navigation rail's foreground family.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const src = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");
const css = src("styles.css");
const app = src("App.tsx");

/** Strip comments so a worked example inside one is never read as a rule. */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The class-column of CSS specificity for a `:root`-anchored selector: every
 * attribute selector, class and pseudo-class counts one, and `:not()` itself
 * counts nothing while its contents count normally.
 */
function classWeight(selector) {
  const attributes = (selector.match(/\[/g) || []).length;
  const classes = (selector.match(/\.[A-Za-z_-]/g) || []).length;
  const pseudos = (selector.match(/:[a-z-]+/g) || []).filter(p => p !== ":not").length;
  return attributes + classes + pseudos;
}

/** Every top-level rule in source order, as { selector, body, index }. */
function topLevelRules(text) {
  const rules = [];
  const pattern = /(^|[}\n])([^{}@]+?)\{([^{}]*)\}/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const selector = match[2].trim();
    if (!selector || selector.startsWith("@")) continue;
    rules.push({ selector, body: match[3], index: match.index });
  }
  return rules;
}

test("no palette-token block may outweigh a named palette block", () => {
  const tokenRules = topLevelRules(bare).filter(rule => /--bg\s*:/.test(rule.body));
  assert.ok(tokenRules.length >= 5, `expected the palette blocks to be found, saw ${tokenRules.length}`);

  const tooHeavy = [];
  for (const rule of tokenRules) {
    for (const one of rule.selector.split(",")) {
      const selector = one.trim();
      if (!selector) continue;
      if (classWeight(selector) > 2) tooHeavy.push(selector);
    }
  }
  assert.deepEqual(tooHeavy, [],
    "a block handing out palette tokens is heavier than `:root[data-theme=\"nord\"]` (0-2-0); "
    + "it will repaint every named palette and collapse them into one look");
});

test("the shared dark base comes before the named palettes, so each palette still wins", () => {
  const base = bare.indexOf(':root[data-appearance="dark"]{');
  assert.ok(base > 0, "the dark base must be gated on the resolved appearance, at 0-2-0");

  const named = bare.indexOf(':root[data-theme="midnight"]');
  assert.ok(named > 0, "the named dark palettes must still exist");
  assert.ok(base < named,
    "the dark base must precede the named palettes — at equal weight the later rule wins, "
    + "and the palette must be the one that wins");

  for (const palette of ["nord", "dracula", "high-contrast-dark"]) {
    assert.ok(bare.indexOf(`:root[data-theme="${palette}"]{`) > base,
      `${palette} must be able to override the shared dark base`);
  }

  /* The two facts the eye checks: two dark palettes are not the same theme,
     and High Contrast Dark keeps the line that makes it high contrast. A
     palette can own more than one block, so read all of them. */
  const rules = topLevelRules(bare);
  const declares = (palette, pattern) => rules.some(rule =>
    rule.selector === `:root[data-theme="${palette}"]` && rule.index > base && pattern.test(rule.body));

  assert.ok(declares("nord", /--bg:#2E3440/), "Nord keeps its own paper");
  assert.ok(declares("dracula", /--bg:#282A36/), "Dracula keeps its own paper, and it is not Nord's");
  assert.ok(declares("high-contrast-dark", /--line:#FFF(?:FFF)?/),
    "High Contrast Dark keeps the white rule that makes it high contrast");
});

test("one owner answers 'is this a dark screen': the resolved appearance", () => {
  assert.doesNotMatch(bare, /:not\(\s*\[data-appearance\s*=/,
    "negating a VALUE of the appearance is what re-creates the 0-3-0 trap; match it positively "
    + "instead. (Negating the bare attribute — `:not([data-appearance])`, the pre-paint guard — "
    + "is 0-2-0 and fine.)");

  /* applyTheme writes data-appearance before first paint. The OS media query
     must not hand out colour tokens — that leak is how on-ink/on-pine painted
     at 1:1 under a light Windows. */
  const media = bare.match(/@media \(prefers-color-scheme:dark\)\{([\s\S]*?)\n\}/g) || [];
  for (const block of media) {
    assert.doesNotMatch(block, /--[a-z0-9-]+:/,
      "no OS media query may hand out palette tokens");
  }

  /* Dark-screen component rules key off the appearance, not off one palette. */
  for (const rule of [
    ':root[data-appearance="dark"] body::before',
    ':root[data-appearance="dark"] .seg button[aria-pressed="true"]',
  ]) assert.ok(bare.includes(rule), `missing: ${rule}`);
  assert.doesNotMatch(bare, /:root\[data-theme="dark"\]\s+\S/,
    "a component may not treat the palette NAMED 'dark' as the definition of a dark screen; "
    + "the other ten dark palettes are dark too");

  /* And the attribute those rules read is written before the first paint. */
  assert.match(app, /root\.setAttribute\("data-appearance", dark \? "dark" : "light"\)/);
  assert.match(app, /^applyTheme\(prefs\.get\(\)\.appearanceMode, prefs\.get\(\)\.palette/m,
    "applyTheme must run at module load, before React paints anything");
});

test("the selected rail item reads its ink from the one token every palette sets", () => {
  const rule = bare.slice(bare.indexOf('.rail-btn[aria-current="true"]{'));
  const body = rule.slice(0, rule.indexOf("}"));
  assert.match(body, /color:var\(--rail-selected-text\)/,
    "the selected chip's ink is a published token, not a guess repaired per theme");
  assert.match(body, /background:var\(--rail-selected-bg\)/);
  assert.doesNotMatch(body, /color:var\(--rail-bg\)/,
    "painting the label in the rail's own background is how a clicked Home went near-black "
    + "on near-black and read as disabled");

  /* Every palette family answers "what colour is that ink". */
  assert.match(bare, /--rail-selected-text:var\(--rail-active-ink\)/);
  assert.match(bare, /:root\{[\s\S]*?--rail-active-ink:var\(--rail-bg\)/);
  const darkFamily = bare.slice(bare.indexOf(':root[data-theme="midnight"]'));
  const midnightBody = darkFamily.slice(0, darkFamily.indexOf("}"));
  const railInk = midnightBody.match(/--rail-ink:(#[0-9A-Fa-f]+)/);
  const railActiveInk = midnightBody.match(/--rail-active-ink:(#[0-9A-Fa-f]+)/);
  assert.ok(railInk && railActiveInk, "midnight must declare rail ink and selected-rail ink");
  assert.equal(railActiveInk[1].toUpperCase(), railInk[1].toUpperCase(),
    "on midnight the selected rail ink is the rail's own ink, not a leaked light on-color");
});

test("a control on the canvas is painted in canvas ink, never in rail ink", () => {
  /* `.chathead` is `background:var(--shell-canvas)`. The rail foreground family
     (`--rail-muted`, `--rail-ink`, `--rail-hover`) is drawn to sit on the dark
     rail; on a light palette's canvas it is near-white on near-white. */
  const rules = topLevelRules(bare);
  const ruleFor = selector => {
    const found = rules.find(rule => rule.selector === selector);
    assert.ok(found, `missing rule: ${selector}`);
    return found.body;
  };
  assert.match(ruleFor(".chathead"), /background:var\(--shell-canvas\)/,
    "the chat header sits on the canvas");

  for (const selector of [
    ".chathead select", ".chathead select:hover", ".chathead select:focus-visible",
    ".header-members", ".header-members span",
  ]) assert.doesNotMatch(ruleFor(selector), /--rail-/,
    `${selector} sits on the canvas, so it may not borrow the rail's foreground family — `
    + "on a light palette those tokens are near-white on near-white");
});

test("an icon button's own ink rule is never overruled by the shared rail-family base", () => {
  /* `.iconbtn` is one class shared by icon buttons on the rail AND on the
     canvas, and its base rule hands out `--rail-muted`. A control that says
     "no, paint me in canvas ink" only wins if its rule OUTWEIGHS that base or
     comes after it — at equal weight the later rule takes it. The Chat + Files
     close button lost exactly that way: `.workspace-layout-close{color:var(--ink-2)}`
     sat above `.iconbtn{color:var(--rail-muted)}`, so it measured 1.59:1 on
     Cloud9 Pine, fainter than a disabled button. This checks the whole class:
     every extra class an `.iconbtn` carries in the app, against the base. */
  const rules = topLevelRules(bare);
  const base = rules.findIndex(rule => rule.selector === ".iconbtn" && /--rail-muted/.test(rule.body));
  assert.ok(base >= 0, "the shared .iconbtn base rule that hands out rail ink must be findable");

  const extras = new Set();
  for (const [, classes] of app.matchAll(/className="iconbtn([^"]*)"/g)) {
    for (const name of classes.trim().split(/\s+/)) if (name) extras.add(name);
  }
  assert.ok(extras.size >= 3, `expected the app's icon buttons to be found, saw ${extras.size}`);

  const losers = [];
  for (const name of extras) {
    rules.forEach((rule, index) => {
      if (rule.selector !== `.${name}`) return;
      if (!/(^|;)\s*color\s*:/.test(rule.body)) return;
      if (index < base) losers.push(`.${name}`);
    });
  }
  assert.deepEqual(losers, [],
    "these rules name an icon button's own ink but are outranked by `.iconbtn`'s rail ink — "
    + "scope them to the surface they sit on (0-2-0) so the colour they ask for is the colour drawn");
});
