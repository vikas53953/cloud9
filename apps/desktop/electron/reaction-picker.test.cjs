const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("recent emoji is per-user/device, newest-first, deduped, capped, and persisted", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    const values = new Map();
    globalThis.localStorage = {
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };
    const recent = await import("./apps/desktop/src/recentemoji.ts");
    assert.deepEqual(recent.recentEmojisFor("u-one"), []);
    recent.rememberRecentEmoji("u-one", "👍");
    recent.rememberRecentEmoji("u-one", "🎉");
    recent.rememberRecentEmoji("u-one", "👍");
    assert.deepEqual(recent.recentEmojisFor("u-one"), ["👍", "🎉"]);
    assert.deepEqual(recent.recentEmojisFor("u-two"), [], "another user must not inherit this device's list");
    for (let i = 0; i < recent.RECENT_EMOJI_LIMIT + 3; i++) recent.rememberRecentEmoji("u-one", String.fromCodePoint(0x1f600 + i));
    const capped = recent.recentEmojisFor("u-one");
    assert.equal(capped.length, recent.RECENT_EMOJI_LIMIT);
    assert.equal(new Set(capped).size, capped.length);
    assert.equal(values.size, 1, "only this user's device key is written");
    assert.match([...values.keys()][0], /cloud9\.recentEmoji\.v1\.u-one/);
  `;
  execFileSync(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "-e", script,
  ], { cwd: path.join(__dirname, "..", "..", ".."), stdio: "pipe" });
});

test("message reaction picker has truthful persistence, search, categories, and accessible dismissal", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
  assert.match(app, /reactpop reactpicker emojipop/);
  assert.match(app, /placeholder="Search emoji"/);
  assert.match(app, /aria-label="Search reaction emoji"/);
  assert.match(app, /role="tablist" aria-label="Reaction emoji categories"/);
  assert.match(app, /role="menuitem" aria-label=\{`React with \$\{e\}`\}/);
  assert.match(app, /useEscapeCloses\(\(\) => setPickEmoji\(false\), pickEmoji\)/);
  assert.match(app, /useClickAwayCloses\(reactHoldRef, \(\) => setPickEmoji\(false\), pickEmoji\)/);
  assert.match(app, /const pendingReactionRef = useRef<Set<string>>\(new Set\(\)\)/);
  assert.match(app, /rememberRecentEmoji\(me\.id, emoji\)/);
  assert.match(app, /rememberRecentEmoji\(world\.me\?\.id, e\)/);
  assert.match(app, /recent\.length > 0 \? \{ Recent:/);
  assert.doesNotMatch(app, /const REACT_EMOJI\s*=/, "the picker must not keep a static six-emoji source");
  assert.match(css, /\.reactpop\.reactpicker\s*\{/);
});
