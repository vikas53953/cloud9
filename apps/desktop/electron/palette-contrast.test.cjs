/**
 * J2 guards: named palettes are complete contracts, the OS does not
 * hand out colour tokens, disabled/focus use those tokens, and leftover
 * hardcoded hex fallbacks cannot sneak back in.
 *
 * Assertion 2 (no OS-driven tokens) is the one that would have caught
 * the d486b79 regression: on-ink/on-pine leaking from prefers-color-scheme.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

const PALETTES = [
  "daylight", "cloud9-pine", "porcelain", "warm-paper", "solarized-light", "high-contrast-light",
  "midnight", "aubergine", "solarized-dark", "rose-pine", "catppuccin", "nord",
  "dracula", "tokyo-night", "graphite", "high-contrast-dark",
];

const REQUIRED = [
  "--on-ink:", "--on-pine:", "--on-gold:",
  "--disabled-bg:", "--disabled-text:", "--disabled-border:",
  "--line-strong:", "--focus-ring:",
];

test("every named palette declares on-colors, the disabled triple, line-strong and focus-ring", () => {
  const missing = [];
  for (const name of PALETTES) {
    const start = bare.indexOf(`:root[data-theme="${name}"]{`);
    assert.ok(start >= 0, `missing palette block: ${name}`);
    const body = bare.slice(start, bare.indexOf("}", start));
    for (const token of REQUIRED) {
      if (!body.includes(token)) missing.push(`${name} ${token}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("no OS-driven tokens: prefers-color-scheme must not set custom properties", () => {
  const media = bare.match(/@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{[\s\S]*?\n\}/gi) || [];
  for (const block of media) {
    assert.doesNotMatch(block, /--[a-z0-9-]+:/,
      "an OS media query is handing out palette tokens — that is the on-color leak");
  }
  assert.doesNotMatch(bare, /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)[\s\S]{0,400}--on-ink/,
    "on-ink must never come from the operating system");
});

test("disabled controls use the disabled tokens, not a bare opacity fade", () => {
  assert.match(bare, /\.btn:disabled,\.ghostbtn:disabled\{[^}]*--disabled-bg/);
  assert.match(bare, /\.primary:disabled\{[^}]*--disabled-text/);
  assert.match(bare, /\.composer \.tools \.sendbtn:disabled\{[^}]*--disabled-bg/);
  assert.match(bare, /\.composer \.tools \.sendbtn:disabled\{[^}]*--disabled-text/);
  assert.doesNotMatch(bare, /\.btn:disabled,\.ghostbtn:disabled\{[^}]*opacity:\s*\.\d+/);
  assert.doesNotMatch(bare, /\.primary:disabled\{[^}]*opacity:\s*\.\d+/);
  assert.doesNotMatch(bare, /\.composer \.tools \.sendbtn:disabled\{[^}]*--sunk/);
});

test("the default focus ring is the per-palette --focus-ring token", () => {
  assert.match(bare, /:focus-visible\{outline:2\.5px solid var\(--focus-ring\)/);
  assert.match(bare, /\.rail-btn:focus-visible\{outline:2px solid var\(--focus-ring\)/);
});

test("colour var() calls do not smuggle a hardcoded hex fallback", () => {
  const leaks = [...bare.matchAll(/var\(--[a-z0-9-]+\s*,\s*#[0-9A-Fa-f]+\)/gi)]
    .map(m => m[0]);
  assert.deepEqual(leaks, [],
    "a hardcoded fallback wins when the token is missing and re-creates the leak J2 closed");
});
