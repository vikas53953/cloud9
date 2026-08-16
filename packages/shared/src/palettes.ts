/* ============================================================
   PALETTES — the 16 named looks, each with a full token contract.
   ============================================================

   Why this file exists: palette blocks in styles.css are partial deltas
   over a light-only :root. None of them declare the ink that sits ON a
   coloured control (--on-ink, --on-pine, --on-gold), so those leak from
   an OS media query and the primary button can paint at 1.00:1.

   This table is the single source of truth. J2 (a later lane) will emit
   it into styles.css. This lane does not touch the stylesheet.

   Completions: a token omitted from a named block is filled from that
   palette's FAMILY (light :root, or :root[data-appearance="dark"]), never
   from the light base when the palette is dark. On-colours, the disabled
   triple, --line-strong and --focus-ring are derived, not copied.
   ============================================================ */

export const PALETTE_TOKEN_NAMES = [
  "bg", "bg-2", "surface", "surface-2", "sunk",
  "line", "line-soft",
  "ink", "ink-2", "ink-3",
  "pine", "pine-soft",
  "marigold", "marigold-hi", "marigold-soft",
  "ultra", "ultra-soft",
  "madder", "madder-soft",
  "on-pine", "on-gold", "on-ink",
  "rail-bg", "rail-ink", "rail-muted", "rail-hover", "rail-active", "rail-active-ink",
  "shell-rail", "shell-sidebar", "shell-header", "shell-canvas",
  "chrome-bg", "rail-text", "rail-selected-bg", "rail-selected-text",
  "sidebar-bg", "sidebar-text", "sidebar-muted",
  "canvas-bg", "surface-bg", "composer-bg",
  "text-primary", "text-secondary", "text-muted",
  "accent", "on-accent", "accent-soft",
  "focus-ring", "border", "disabled-bg", "disabled-text",
  "disabled-border", "line-strong",
] as const;

export type PaletteTokenName = typeof PALETTE_TOKEN_NAMES[number];
export type PaletteTokens = Record<PaletteTokenName, string>;
export type PaletteFamily = "light" | "dark";

export const PALETTE_NAMES = [
  "daylight", "cloud9-pine", "porcelain", "warm-paper", "solarized-light", "high-contrast-light",
  "midnight", "aubergine", "solarized-dark", "rose-pine", "catppuccin", "nord",
  "dracula", "tokyo-night", "graphite", "high-contrast-dark",
] as const;

export type PaletteName = typeof PALETTE_NAMES[number];

export interface PaletteMeta {
  value: PaletteName;
  label: string;
  family: PaletteFamily;
}

/** Names, labels and families copied from App.tsx PALETTES (~L1828). */
export const PALETTE_REGISTRY: readonly PaletteMeta[] = [
  { value: "daylight", label: "Daylight", family: "light" },
  { value: "cloud9-pine", label: "Cloud9 Pine", family: "light" },
  { value: "porcelain", label: "Porcelain", family: "light" },
  { value: "warm-paper", label: "Warm Paper", family: "light" },
  { value: "solarized-light", label: "Solarized Light", family: "light" },
  { value: "high-contrast-light", label: "High Contrast Light", family: "light" },
  { value: "midnight", label: "Midnight", family: "dark" },
  { value: "aubergine", label: "Aubergine", family: "dark" },
  { value: "solarized-dark", label: "Solarized dark", family: "dark" },
  { value: "rose-pine", label: "Rose Pine", family: "dark" },
  { value: "catppuccin", label: "Catppuccin", family: "dark" },
  { value: "nord", label: "Nord", family: "dark" },
  { value: "dracula", label: "Dracula", family: "dark" },
  { value: "tokyo-night", label: "Tokyo Night", family: "dark" },
  { value: "graphite", label: "Graphite", family: "dark" },
  { value: "high-contrast-dark", label: "High Contrast Dark", family: "dark" },
];

export interface Palette {
  value: PaletteName;
  label: string;
  family: PaletteFamily;
  tokens: PaletteTokens;
}

type PigmentName =
  | "bg" | "bg-2" | "surface" | "surface-2" | "sunk"
  | "line" | "line-soft"
  | "ink" | "ink-2" | "ink-3"
  | "pine" | "pine-soft"
  | "marigold" | "marigold-hi" | "marigold-soft"
  | "ultra" | "ultra-soft"
  | "madder" | "madder-soft"
  | "rail-bg" | "rail-ink" | "rail-muted" | "rail-hover" | "rail-active" | "rail-active-ink";

type Pigments = Record<PigmentName, string>;
type AuthoredPigments = Partial<Pigments>;

const ON_DARK = "#08120F";
const ON_LIGHT = "#FFFFFF";

/** Light-family pigments from the base :root block (styles.css L22). */
const LIGHT_FAMILY: Pigments = {
  bg: "#E3E6DD",
  "bg-2": "#D8DCD1",
  surface: "#F7F8F3",
  "surface-2": "#EFF1EA",
  sunk: "#DDE1D6",
  line: "#C9CFC0",
  "line-soft": "#D9DED0",
  ink: "#151F1B",
  "ink-2": "#4E5B54",
  "ink-3": "#79857D",
  pine: "#125347",
  "pine-soft": "#D3E4DC",
  marigold: "#B77A0C",
  "marigold-hi": "#E9A227",
  "marigold-soft": "#F6E6C4",
  ultra: "#2B3CA0",
  "ultra-soft": "#DCE0F6",
  madder: "#B32A42",
  "madder-soft": "#F6DCE0",
  "rail-bg": "#103F37",
  "rail-ink": "#F7F8F3",
  "rail-muted": "#B7C9C2",
  "rail-hover": "#1A584D",
  "rail-active": "#F7F8F3",
  "rail-active-ink": "rail-bg",
};

/** Dark-family pigments from :root[data-appearance="dark"] (styles.css L143). */
const DARK_FAMILY: Pigments = {
  bg: "#0F1512",
  "bg-2": "#0A0F0D",
  surface: "#171F1B",
  "surface-2": "#1E2723",
  sunk: "#121815",
  line: "#2C3833",
  "line-soft": "#232D29",
  ink: "#ECEFE5",
  "ink-2": "#A3B0A8",
  "ink-3": "#74827A",
  pine: "#4FC7A6",
  "pine-soft": "#16332C",
  marigold: "#EFB447",
  "marigold-hi": "#F5C463",
  "marigold-soft": "#3A2C10",
  ultra: "#96A6FF",
  "ultra-soft": "#1D2352",
  madder: "#F4788C",
  "madder-soft": "#40151F",
  "rail-bg": "#080E0C",
  "rail-ink": "#ECEFE5",
  "rail-muted": "#8FA098",
  "rail-hover": "#17231F",
  "rail-active": "#23483F",
  "rail-active-ink": "rail-ink",
};

/**
 * Shared dark named-palette block (styles.css L215). These are DECLARED
 * values, not family completions — midnight is this block with no extra
 * overrides.
 */
const SHARED_DARK: AuthoredPigments = {
  bg: "#111916",
  "bg-2": "#0C1310",
  surface: "#1A2420",
  "surface-2": "#223029",
  sunk: "#141D19",
  line: "#34453D",
  "line-soft": "#293831",
  ink: "#EEF4ED",
  "ink-2": "#A8B9AF",
  "ink-3": "#7D9085",
  pine: "#61D1AF",
  "pine-soft": "#163C32",
  "rail-bg": "#08110E",
  "rail-ink": "#EEF4ED",
  "rail-muted": "#9BB5A8",
  "rail-hover": "#173028",
  "rail-active": "#23483E",
};

const AUTHORED: Record<PaletteName, AuthoredPigments> = {
  daylight: {
    bg: "#F4F1E9", "bg-2": "#E8E4D9", surface: "#FFFDF8", "surface-2": "#F3EEE4", sunk: "#E6E0D2",
    line: "#D8D0C0", "line-soft": "#E7E0D4",
    ink: "#24201B", "ink-2": "#6A6258", "ink-3": "#91877B",
    pine: "#2D6B5D", "pine-soft": "#DDEBE4",
    "rail-bg": "#214A42", "rail-ink": "#F7FBF5", "rail-muted": "#B9CEC5",
    "rail-hover": "#2C5E53", "rail-active": "#F6E6C4",
  },
  "cloud9-pine": {
    bg: "#E5EFE9", "bg-2": "#D5E6DE", surface: "#F8FCF9", "surface-2": "#EAF4EF", sunk: "#D0E2D9",
    line: "#BFD4C9", "line-soft": "#D5E4DC",
    ink: "#10261E", "ink-2": "#486357", "ink-3": "#758E82",
    pine: "#0E6653", "pine-soft": "#CDE8DB",
    "rail-bg": "#0D4438", "rail-ink": "#F0FBF5", "rail-muted": "#A8C9BA",
    "rail-hover": "#155B4C", "rail-active": "#CDE8DB",
  },
  porcelain: {
    bg: "#F6F7FA", "bg-2": "#E9ECF1", surface: "#FFF", "surface-2": "#F0F2F6",
    line: "#CBD0D9",
    ink: "#1D2430", "ink-2": "#566171", "ink-3": "#7B8592",
    pine: "#3867C8",
    "rail-bg": "#23324D", "rail-ink": "#FFF", "rail-muted": "#CDD6E6",
    "rail-active": "#DDE7FF",
  },
  "warm-paper": {
    bg: "#F7F0E3", "bg-2": "#EDE0CC", surface: "#FFF9F0", "surface-2": "#F3E8D8",
    line: "#D9C8B3",
    ink: "#33271D", "ink-2": "#69594A", "ink-3": "#947D68",
    pine: "#8A4D22",
    "rail-bg": "#493226", "rail-ink": "#FFF8EF", "rail-muted": "#E2CDBD",
    "rail-active": "#F1D6A8",
  },
  "solarized-light": {
    bg: "#FDF6E3", "bg-2": "#EEE8D5", surface: "#FFFBEF", "surface-2": "#F7F0DC",
    line: "#D5CCB8",
    ink: "#073642", "ink-2": "#586E75", "ink-3": "#839496",
    pine: "#268BD2",
    "rail-bg": "#073642", "rail-ink": "#FDF6E3", "rail-muted": "#C2CEC9",
    "rail-active": "#D9EAD3",
  },
  "high-contrast-light": {
    bg: "#FFF", "bg-2": "#F5F5F5", surface: "#FFF", "surface-2": "#EEE",
    line: "#000", "line-soft": "#555",
    ink: "#000", "ink-2": "#000", "ink-3": "#222",
    pine: "#005FCC",
    "rail-bg": "#000", "rail-ink": "#FFF", "rail-muted": "#FFF",
    "rail-active": "#FFF", "rail-active-ink": "#000",
  },
  midnight: { ...SHARED_DARK },
  aubergine: {
    ...SHARED_DARK,
    bg: "#1B1520", "bg-2": "#130F17", surface: "#261A2B", "surface-2": "#322238",
    line: "#4B3553", "line-soft": "#38263E",
    ink: "#F5EDF8", "ink-2": "#C4ADC9", "ink-3": "#9B82A1",
    pine: "#D9A7E6", "pine-soft": "#422B4C",
    "rail-bg": "#110A15", "rail-hover": "#2B1834", "rail-active": "#53345E",
  },
  "solarized-dark": {
    ...SHARED_DARK,
    bg: "#002B36", "bg-2": "#00232C", surface: "#073642", "surface-2": "#0A4050",
    line: "#23515A", "line-soft": "#17434C",
    ink: "#EEE8D5", "ink-2": "#B6C3B2", "ink-3": "#829A9A",
    pine: "#2AA198", "pine-soft": "#123F45",
    "rail-bg": "#001B22", "rail-hover": "#0A3640", "rail-active": "#164C55",
  },
  "rose-pine": {
    ...SHARED_DARK,
    bg: "#191724", "bg-2": "#13111D", surface: "#26233A", "surface-2": "#332F48",
    line: "#4A4560", "line-soft": "#39344E",
    ink: "#E0DEF4", "ink-2": "#B5B1D1", "ink-3": "#8884A4",
    pine: "#9CCFD8", "pine-soft": "#213A43",
    "rail-bg": "#100E19", "rail-hover": "#2B2940", "rail-active": "#453F62",
  },
  catppuccin: {
    ...SHARED_DARK,
    bg: "#1E1E2E", "bg-2": "#181825", surface: "#24243A", "surface-2": "#313149",
    line: "#4A4A64", "line-soft": "#3A3A53",
    ink: "#CDD6F4", "ink-2": "#A6ADC9", "ink-3": "#8589A5",
    pine: "#94E2D5", "pine-soft": "#1C4142",
    "rail-bg": "#11111B", "rail-hover": "#2D3048", "rail-active": "#45476A",
  },
  nord: {
    ...SHARED_DARK,
    bg: "#2E3440", "bg-2": "#272C36", surface: "#3B4252", "surface-2": "#434C5E",
    line: "#4C566A",
    ink: "#ECEFF4", "ink-2": "#D8DEE9", "ink-3": "#AAB3C0",
    pine: "#88C0D0",
    "rail-bg": "#242933", "rail-active": "#4C566A",
  },
  dracula: {
    ...SHARED_DARK,
    bg: "#282A36", "bg-2": "#21222C", surface: "#343746", "surface-2": "#44475A",
    line: "#6272A4",
    ink: "#F8F8F2", "ink-2": "#D0D0D5", "ink-3": "#A5A7B8",
    pine: "#50FA7B",
    "rail-bg": "#191A21", "rail-active": "#44475A",
  },
  "tokyo-night": {
    ...SHARED_DARK,
    bg: "#1A1B26", "bg-2": "#16161E", surface: "#24283B", "surface-2": "#2F354D",
    line: "#414868",
    ink: "#C0CAF5", "ink-2": "#A9B1D6", "ink-3": "#7982A9",
    pine: "#7DCFFF",
    "rail-bg": "#13131A", "rail-active": "#33467C",
  },
  graphite: {
    ...SHARED_DARK,
    bg: "#202124", "bg-2": "#191A1C", surface: "#2A2B2E", "surface-2": "#34363A",
    line: "#505156",
    ink: "#F1F3F4", "ink-2": "#C7C9CC", "ink-3": "#9AA0A6",
    pine: "#8AB4F8",
    "rail-bg": "#141518", "rail-active": "#3C4043",
  },
  "high-contrast-dark": {
    ...SHARED_DARK,
    bg: "#000", "bg-2": "#000", surface: "#111", "surface-2": "#202020",
    line: "#FFF", "line-soft": "#BFBFBF",
    ink: "#FFF", "ink-2": "#FFF", "ink-3": "#E8E8E8",
    pine: "#00FFFF",
    "rail-bg": "#000", "rail-active": "#222",
  },
};

export interface Rgb { r: number; g: number; b: number }

export function parseHex(hex: string): Rgb {
  const raw = hex.trim();
  const m = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

export function formatHex(rgb: Rgb): string {
  const ch = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${ch(rgb.r)}${ch(rgb.g)}${ch(rgb.b)}`.toUpperCase();
}

export function normalizeHex(hex: string): string {
  return formatHex(parseHex(hex));
}

function srgbChannel(c: number): number {
  const x = c / 255;
  return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex: string): number {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * srgbChannel(r) + 0.7152 * srgbChannel(g) + 0.0722 * srgbChannel(b);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Ink that sits ON a solid pigment. Same decision applyTheme uses for a
 * custom accent: compare white vs a near-black, then paint #FFFFFF or #08120F.
 */
export function onColor(bg: string): typeof ON_DARK | typeof ON_LIGHT {
  const luminance = relativeLuminance(bg);
  const whiteContrast = 1.05 / (luminance + 0.05);
  const darkContrast = (luminance + 0.05) / 0.05;
  return darkContrast >= whiteContrast ? ON_DARK : ON_LIGHT;
}

function mixHex(a: string, b: string, t: number): string {
  const A = parseHex(a);
  const B = parseHex(b);
  return formatHex({
    r: A.r + (B.r - A.r) * t,
    g: A.g + (B.g - A.g) * t,
    b: A.b + (B.b - A.b) * t,
  });
}

function meetsFloor(color: string, backgrounds: readonly string[], floor: number): boolean {
  return backgrounds.every(bg => contrastRatio(color, bg) >= floor);
}

/** Smallest mix of `start` toward `toward` that clears `floor` against every background. */
function mixTowardUntil(
  start: string,
  toward: string,
  backgrounds: readonly string[],
  floor: number,
): string | null {
  const from = normalizeHex(start);
  const to = normalizeHex(toward);
  if (meetsFloor(from, backgrounds, floor)) return from;
  if (!meetsFloor(to, backgrounds, floor)) return null;
  let lo = 0;
  let hi = 256;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (meetsFloor(mixHex(from, to, mid / 256), backgrounds, floor)) hi = mid;
    else lo = mid;
  }
  return mixHex(from, to, hi / 256);
}

/**
 * Nudge `start` until it is ≥ `floor` against every background. Prefers the
 * smallest move toward #08120F or #FFFFFF (whichever can actually clear the
 * floor). Falls back to the better of those two endpoints.
 */
export function ensureContrast(
  start: string,
  backgrounds: readonly string[],
  floor: number,
): string {
  const from = normalizeHex(start);
  if (meetsFloor(from, backgrounds, floor)) return from;
  const candidates = [ON_DARK, ON_LIGHT, "#000000", "#FFFFFF"];
  let best: string | null = null;
  let bestDist = Infinity;
  for (const toward of candidates) {
    const mixed = mixTowardUntil(from, toward, backgrounds, floor);
    if (!mixed) continue;
    const dist = contrastRatio(from, mixed);
    if (dist < bestDist) {
      best = mixed;
      bestDist = dist;
    }
  }
  if (best) return best;
  let fallback = ON_DARK;
  let score = Math.min(...backgrounds.map(bg => contrastRatio(fallback, bg)));
  for (const candidate of candidates) {
    const next = Math.min(...backgrounds.map(bg => contrastRatio(candidate, bg)));
    if (next > score) {
      fallback = candidate;
      score = next;
    }
  }
  return fallback;
}

function familyOf(family: PaletteFamily): Pigments {
  return family === "dark" ? DARK_FAMILY : LIGHT_FAMILY;
}

function isHexColor(value: string): boolean {
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim());
}

export function completePalette(meta: PaletteMeta, authored: AuthoredPigments = AUTHORED[meta.value]): Palette {
  const family = familyOf(meta.family);
  const pigments: Record<string, string> = {};
  for (const key of Object.keys(family) as PigmentName[]) {
    const authoredValue = authored[key];
    const fallback = family[key];
    const raw = authoredValue ?? fallback;
    pigments[key] = isHexColor(raw) ? normalizeHex(raw) : raw;
  }
  const aliasTarget = meta.family === "dark" ? "rail-ink" : "rail-bg";
  if (!authored["rail-active-ink"] || !isHexColor(authored["rail-active-ink"])) {
    pigments["rail-active-ink"] = pigments[aliasTarget];
  }

  const onPine = onColor(pigments.pine);
  const onGold = onColor(pigments["marigold-hi"]);
  const onInk = onColor(pigments.ink);

  const surface = pigments.surface;
  const bg = pigments.bg;
  const disabledBg = ensureContrast(pigments.sunk, [surface], 3);
  /* Walk from the fill, not from ink-3: high-contrast muted ink already sits at ~5:1 and enabled pine (5.98:1) could not beat it by 1.4×. */
  const disabledText = ensureContrast(disabledBg, [disabledBg, surface], 3);
  const disabledBorder = ensureContrast(pigments.line, [surface], 3);
  const lineStrong = ensureContrast(pigments.line, [surface, bg], 3);
  const focusRing = ensureContrast(pigments.pine, [bg], 3);

  const tokens = {
    bg,
    "bg-2": pigments["bg-2"],
    surface,
    "surface-2": pigments["surface-2"],
    sunk: pigments.sunk,
    line: pigments.line,
    "line-soft": pigments["line-soft"],
    ink: pigments.ink,
    "ink-2": pigments["ink-2"],
    "ink-3": pigments["ink-3"],
    pine: pigments.pine,
    "pine-soft": pigments["pine-soft"],
    marigold: pigments.marigold,
    "marigold-hi": pigments["marigold-hi"],
    "marigold-soft": pigments["marigold-soft"],
    ultra: pigments.ultra,
    "ultra-soft": pigments["ultra-soft"],
    madder: pigments.madder,
    "madder-soft": pigments["madder-soft"],
    "on-pine": onPine,
    "on-gold": onGold,
    "on-ink": onInk,
    "rail-bg": pigments["rail-bg"],
    "rail-ink": pigments["rail-ink"],
    "rail-muted": pigments["rail-muted"],
    "rail-hover": pigments["rail-hover"],
    "rail-active": pigments["rail-active"],
    "rail-active-ink": pigments["rail-active-ink"],
    "shell-rail": pigments["rail-bg"],
    "shell-sidebar": pigments["bg-2"],
    "shell-header": bg,
    "shell-canvas": bg,
    "chrome-bg": pigments["rail-bg"],
    "rail-text": pigments["rail-ink"],
    "rail-selected-bg": pigments["rail-active"],
    "rail-selected-text": pigments["rail-active-ink"],
    "sidebar-bg": pigments["bg-2"],
    "sidebar-text": pigments.ink,
    "sidebar-muted": pigments["ink-2"],
    "canvas-bg": bg,
    "surface-bg": surface,
    "composer-bg": surface,
    "text-primary": pigments.ink,
    "text-secondary": pigments["ink-2"],
    "text-muted": pigments["ink-3"],
    accent: pigments.pine,
    "on-accent": onPine,
    "accent-soft": pigments["pine-soft"],
    "focus-ring": focusRing,
    border: pigments.line,
    "disabled-bg": disabledBg,
    "disabled-text": disabledText,
    "disabled-border": disabledBorder,
    "line-strong": lineStrong,
  } satisfies PaletteTokens;

  return { value: meta.value, label: meta.label, family: meta.family, tokens };
}

export const PALETTES: readonly Palette[] = PALETTE_REGISTRY.map(meta => completePalette(meta));

export function paletteByName(name: PaletteName): Palette {
  const found = PALETTES.find(p => p.value === name);
  if (!found) throw new Error(`unknown palette: ${name}`);
  return found;
}

/** Deterministic CSS for the 16 named palettes. J2 pastes or imports this. */
export function generatePaletteCss(palettes: readonly Palette[] = PALETTES): string {
  const lines = [
    "/* Generated by scripts/generate-palette-css.mjs from packages/shared/src/palettes.ts. Do not edit by hand. */",
  ];
  for (const palette of palettes) {
    lines.push(`:root[data-theme="${palette.value}"]{`);
    lines.push(`  color-scheme:${palette.family};`);
    for (const name of PALETTE_TOKEN_NAMES) {
      lines.push(`  --${name}:${palette.tokens[name]};`);
    }
    lines.push(`}`);
  }
  return lines.join("\n") + "\n";
}
