import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PALETTES,
  PALETTE_NAMES,
  PALETTE_REGISTRY,
  PALETTE_TOKEN_NAMES,
  contrastRatio,
  generatePaletteCss,
  onColor,
  type Palette,
  type PaletteTokenName,
} from "./palettes.js";

/* The ~20 component pairs the contract has to keep readable. Text sits at
   4.5:1; UI chrome (borders, focus, disabled fill) sits at 3:1. Declared
   muted ink (--ink-3) is intentionally not in this list: completing omitted
   tokens does not restyle a pigment the stylesheet already set. */

interface ComponentPair {
  name: string;
  fg: PaletteTokenName;
  bg: PaletteTokenName;
  floor: number;
  enabled: boolean;
  disabledMate?: string;
}

const COMPONENT_PAIRS: readonly ComponentPair[] = [
  { name: "Primary button", fg: "on-ink", bg: "ink", floor: 4.5, enabled: true, disabledMate: "Primary button disabled" },
  { name: "Primary button disabled", fg: "disabled-text", bg: "disabled-bg", floor: 3, enabled: false },
  { name: "Composer send", fg: "on-pine", bg: "pine", floor: 4.5, enabled: true, disabledMate: "Composer send disabled" },
  { name: "Composer send disabled", fg: "disabled-text", bg: "disabled-bg", floor: 3, enabled: false },
  { name: "Primary hover", fg: "on-pine", bg: "pine", floor: 4.5, enabled: true },
  { name: "Go / confirm button", fg: "on-gold", bg: "marigold-hi", floor: 4.5, enabled: true },
  { name: "Secondary button", fg: "ink", bg: "surface", floor: 4.5, enabled: true, disabledMate: "Secondary button disabled" },
  { name: "Secondary button disabled", fg: "disabled-text", bg: "disabled-bg", floor: 3, enabled: false },
  { name: "Body text on canvas", fg: "ink", bg: "bg", floor: 4.5, enabled: true },
  { name: "Rail label", fg: "rail-ink", bg: "rail-bg", floor: 4.5, enabled: true },
  { name: "Rail selected item", fg: "rail-active-ink", bg: "rail-active", floor: 4.5, enabled: true },
  { name: "Mention button", fg: "ultra", bg: "ultra-soft", floor: 4.5, enabled: true },
  { name: "Danger hover", fg: "madder", bg: "madder-soft", floor: 4.5, enabled: true },
  { name: "Accent button", fg: "on-accent", bg: "accent", floor: 4.5, enabled: true },
  { name: "Sidebar text", fg: "sidebar-text", bg: "sidebar-bg", floor: 4.5, enabled: true },
  { name: "Composer text", fg: "text-primary", bg: "composer-bg", floor: 4.5, enabled: true },
  { name: "Focus ring", fg: "focus-ring", bg: "bg", floor: 3, enabled: true },
  { name: "Line strong vs surface", fg: "line-strong", bg: "surface", floor: 3, enabled: true },
  { name: "Line strong vs canvas", fg: "line-strong", bg: "bg", floor: 3, enabled: true },
  { name: "Control border", fg: "line-strong", bg: "surface", floor: 3, enabled: true },
  { name: "Disabled bg vs surface", fg: "disabled-bg", bg: "surface", floor: 3, enabled: false },
  { name: "Disabled text vs surface", fg: "disabled-text", bg: "surface", floor: 3, enabled: false },
  { name: "Disabled border vs surface", fg: "disabled-border", bg: "surface", floor: 3, enabled: false },
];

function pairRatio(palette: Palette, pair: ComponentPair): number {
  return contrastRatio(palette.tokens[pair.fg], palette.tokens[pair.bg]);
}

function failLine(palette: Palette, pair: ComponentPair, ratio: number): string {
  const fg = palette.tokens[pair.fg];
  const bg = palette.tokens[pair.bg];
  return `${palette.value} | ${pair.name} | ${ratio.toFixed(2)}:1 | ${fg} on ${bg}`;
}

test("the 54-token contract is exactly 54 names", () => {
  assert.equal(PALETTE_TOKEN_NAMES.length, 54);
  assert.equal(new Set(PALETTE_TOKEN_NAMES).size, 54);
});

test("the 16 palette names match the App.tsx PALETTES registry", () => {
  assert.deepEqual([...PALETTE_NAMES], [
    "daylight", "cloud9-pine", "porcelain", "warm-paper", "solarized-light", "high-contrast-light",
    "midnight", "aubergine", "solarized-dark", "rose-pine", "catppuccin", "nord",
    "dracula", "tokyo-night", "graphite", "high-contrast-dark",
  ]);
  assert.deepEqual(PALETTE_REGISTRY.map(p => p.value), [...PALETTE_NAMES]);
  assert.equal(PALETTES.length, 16);
  assert.deepEqual(PALETTES.map(p => p.value), [...PALETTE_NAMES]);
  assert.equal(PALETTE_REGISTRY.find(p => p.value === "solarized-dark")?.label, "Solarized dark");
});

test("every palette declares the full 54-token contract", () => {
  const missing: string[] = [];
  for (const palette of PALETTES) {
    for (const name of PALETTE_TOKEN_NAMES) {
      const value = palette.tokens[name];
      if (typeof value !== "string" || !/^#[0-9A-F]{6}$/.test(value)) {
        missing.push(`${palette.value} | ${name} | ${value ?? "(absent)"}`);
      }
    }
  }
  assert.equal(missing.length, 0, missing.join("\n"));
});

test("onColor matches applyTheme: #08120F vs #FFFFFF by relative luminance", () => {
  assert.equal(onColor("#000000"), "#FFFFFF");
  assert.equal(onColor("#FFFFFF"), "#08120F");
  assert.equal(onColor("#F8F8F2"), "#08120F");
  assert.equal(onColor("#151F1B"), "#FFFFFF");
  assert.equal(onColor("#50FA7B"), "#08120F");
  assert.equal(onColor("#00FFFF"), "#08120F");
});

test("WCAG contrast floors hold for the named component pairs across all 16 palettes", () => {
  const failures: string[] = [];
  for (const palette of PALETTES) {
    for (const pair of COMPONENT_PAIRS) {
      const ratio = pairRatio(palette, pair);
      if (ratio < pair.floor) failures.push(failLine(palette, pair, ratio));
    }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
});

test("every enabled pair beats its disabled pair by at least 1.4×", () => {
  const failures: string[] = [];
  for (const palette of PALETTES) {
    for (const pair of COMPONENT_PAIRS) {
      if (!pair.enabled || !pair.disabledMate) continue;
      const disabled = COMPONENT_PAIRS.find(candidate => candidate.name === pair.disabledMate);
      assert.ok(disabled, pair.disabledMate);
      const enabledRatio = pairRatio(palette, pair);
      const disabledRatio = pairRatio(palette, disabled);
      if (enabledRatio < disabledRatio * 1.4) {
        failures.push(
          `${palette.value} | ${pair.name} | ${enabledRatio.toFixed(2)}:1 vs ${disabled.name} ${disabledRatio.toFixed(2)}:1 | ${palette.tokens[pair.fg]} on ${palette.tokens[pair.bg]}`,
        );
      }
    }
  }
  assert.equal(failures.length, 0, failures.join("\n"));
});

test("derived on-colours come from each palette's own pigments", () => {
  for (const palette of PALETTES) {
    assert.equal(palette.tokens["on-ink"], onColor(palette.tokens.ink));
    assert.equal(palette.tokens["on-pine"], onColor(palette.tokens.pine));
    assert.equal(palette.tokens["on-gold"], onColor(palette.tokens["marigold-hi"]));
    assert.equal(palette.tokens["on-accent"], palette.tokens["on-pine"]);
  }
});

test("dark palettes do not inherit the light-base marigold / ultra / madder", () => {
  const lightMarigold = "#B77A0C";
  for (const palette of PALETTES.filter(p => p.family === "dark")) {
    assert.notEqual(
      palette.tokens.marigold.toUpperCase(),
      lightMarigold,
      `${palette.value} must not keep the light-base marigold`,
    );
  }
  const nord = PALETTES.find(p => p.value === "nord");
  assert.ok(nord);
  assert.equal(nord.tokens.bg, "#2E3440");
  const dracula = PALETTES.find(p => p.value === "dracula");
  assert.ok(dracula);
  assert.equal(dracula.tokens.bg, "#282A36");
  const hcd = PALETTES.find(p => p.value === "high-contrast-dark");
  assert.ok(hcd);
  assert.equal(hcd.tokens.line, "#FFFFFF");
});

test("the CSS generator is deterministic and emits every token for every palette", () => {
  const first = generatePaletteCss();
  const second = generatePaletteCss();
  assert.equal(first, second);
  for (const name of PALETTE_NAMES) {
    assert.ok(first.includes(`:root[data-theme="${name}"]{`), name);
  }
  const daylight = first.split(":root[data-theme=\"graphite\"]")[0] ?? "";
  for (const token of PALETTE_TOKEN_NAMES) {
    assert.ok(daylight.includes(`--${token}:`), token);
  }
  assert.ok(first.startsWith("/* Generated by scripts/generate-palette-css.mjs"));
  assert.ok(first.endsWith("\n"));
});
