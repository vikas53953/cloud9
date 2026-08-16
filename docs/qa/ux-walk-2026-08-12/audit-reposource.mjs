/**
 * palette-contrast-audit.mjs — STATIC audit of the INSTALLED Cloud9 stylesheet.
 *
 * This is NOT a walk of the app. Cloud9 was already running when the audit ran,
 * and the running copy carries no --remote-debugging-port, so nothing could be
 * attached to and nothing was launched. This instead loads the exact stylesheet
 * the installed app ships and lets a headless Chromium resolve the real cascade
 * (specificity, media queries, var() chains, color-mix) for every palette under
 * both OS appearance settings, then measures WCAG contrast on the control pairs
 * taken verbatim from that stylesheet's own rules.
 *
 * Nothing in %APPDATA%\Cloud9 is opened, read or written.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";

const CSS = String.raw`C:/Users/vikasmit/cloud9/apps/desktop/src/styles.css`;
const OUT = path.dirname(new URL(import.meta.url).pathname.slice(1));

/* The 16 palettes and their declared family, copied from App.tsx PALETTES. */
const PALETTES = [
  ["daylight", "Daylight", "light"], ["cloud9-pine", "Cloud9 Pine", "light"],
  ["porcelain", "Porcelain", "light"], ["warm-paper", "Warm Paper", "light"],
  ["solarized-light", "Solarized Light", "light"], ["high-contrast-light", "High Contrast Light", "light"],
  ["midnight", "Midnight", "dark"], ["aubergine", "Aubergine", "dark"],
  ["solarized-dark", "Solarized dark", "dark"], ["rose-pine", "Rose Pine", "dark"],
  ["catppuccin", "Catppuccin", "dark"], ["nord", "Nord", "dark"],
  ["dracula", "Dracula", "dark"], ["tokyo-night", "Tokyo Night", "dark"],
  ["graphite", "Graphite", "dark"], ["high-contrast-dark", "High Contrast Dark", "dark"],
];

/* Control pairs, each citing the stylesheet rule it came from. `parent` is the
   surface the control sits on, used only when the rule fades it with opacity. */
const CONTROLS = [
  { id: "send",         label: "Composer send button (ENABLED)",      fg: "--on-pine", bg: "--pine",        rule: ".composer .tools .sendbtn", enabled: true },
  { id: "send-dis",     label: "Composer send button (disabled)",     fg: "--ink-3",   bg: "--sunk",        rule: ".composer .tools .sendbtn:disabled", enabled: false },
  { id: "primary",      label: "Primary button at rest",              fg: "--on-ink",  bg: "--ink",         rule: ".primary", enabled: true },
  { id: "primary-hov",  label: "Primary button HOVER",                fg: "--on-pine", bg: "--pine",        rule: ".primary:hover:not(:disabled)", enabled: true },
  { id: "primary-dis",  label: "Primary button disabled",             fg: "--on-ink",  bg: "--ink",         rule: ".primary:disabled", enabled: false, opacity: .4, parent: "--surface" },
  { id: "btn",          label: "Secondary button",                    fg: "--ink",     bg: "--surface",     rule: ".btn", enabled: true },
  { id: "btn-dis",      label: "Secondary button disabled",           fg: "--ink",     bg: "--surface",     rule: ".btn:disabled", enabled: false, opacity: .45, parent: "--surface" },
  { id: "subtle",       label: "Subtle/text button label",            fg: "--ink-2",   bg: "--surface",     rule: ".subtle", enabled: true },
  { id: "note",         label: "Muted helper text",                   fg: "--ink-3",   bg: "--surface",     rule: ".sec-note / --text-muted", enabled: true },
  { id: "topicon",      label: "Topbar icon button",                  fg: "--rail-muted", bg: "--rail-bg",  rule: ".globalbar .iconbtn", enabled: true },
  { id: "topicon-dis",  label: "Topbar icon disabled",                fg: "--rail-muted", bg: "--rail-bg",  rule: ".globalbar .iconbtn:disabled", enabled: false, opacity: .38, parent: "--rail-bg" },
  { id: "gold",         label: "Go / confirm button",                 fg: "--on-gold", bg: "--marigold-hi", rule: ".gold,.btn.go", enabled: true },
  { id: "mention",      label: "Composer @mention button",            fg: "--ultra",   bg: "--ultra-soft",  rule: ".composer .tools .mentionbtn", enabled: true },
  { id: "danger-hov",   label: "Danger button HOVER",                 fg: "--madder",  bg: "--madder-soft", rule: ".btn.danger:hover", enabled: true },
  { id: "railactive",   label: "Rail selected item",                  fg: "--rail-active-ink", bg: "--rail-active", rule: ".rail-btn[aria-current]", enabled: true },
  { id: "border",       label: "Control border vs surface (3:1 UI)",  fg: "--line",    bg: "--surface",     rule: ".btn border", enabled: true, nonText: true },
];

const TOKENS = [...new Set(CONTROLS.flatMap(c => [c.fg, c.bg, c.parent]).filter(Boolean)
  .concat(["--bg", "--surface", "--ink", "--pine", "--rail-bg"]))];

/* ------------------------------------------------------------------ colour */
const srgb = c => { c /= 255; return c <= .03928 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => .2126 * srgb(r) + .7152 * srgb(g) + .0722 * srgb(b);
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + .05) / (y + .05); };
const mix = (a, b, o) => a.map((v, i) => Math.round(v * o + b[i] * (1 - o)));
const parse = s => {
  const m = String(s).trim().match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const n = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [n[0], n[1], n[2]];
};
const hex = c => "#" + c.map(v => v.toString(16).padStart(2, "0")).join("").toUpperCase();

/* --------------------------------------------------------------------- run */
const cssText = fs.readFileSync(CSS, "utf8");
const html = `<!doctype html><html><head><style>${cssText}</style></head>
<body><span id="probe"></span></body></html>`;
const tmp = path.join(os.tmpdir(), `cloud9-palette-audit-${Date.now()}.html`);
fs.writeFileSync(tmp, html);

const browser = await chromium.launch();
const rows = [];
for (const osMode of ["dark", "light"]) {
  const ctx = await browser.newContext({ colorScheme: osMode });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(tmp).href);
  for (const [value, label, family] of PALETTES) {
    /* Exactly what applyTheme() writes onto <html>. A palette only ever shows
       under its own family, so the resolved appearance is the family. */
    const appearance = family;
    const resolved = await page.evaluate(({ value, appearance, TOKENS }) => {
      const r = document.documentElement;
      r.setAttribute("data-appearance-mode", "system");
      r.setAttribute("data-palette", value);
      r.setAttribute("data-appearance", appearance);
      r.setAttribute("data-theme", value);
      const probe = document.getElementById("probe");
      const out = {};
      for (const t of TOKENS) {
        /* Resolve through a real property so var() chains and color-mix()
           become concrete rgb, exactly as the painted pixel would be. */
        probe.style.color = "";
        probe.style.color = `var(${t})`;
        out[t] = getComputedStyle(probe).color;
      }
      return out;
    }, { value, appearance, TOKENS });

    const tok = Object.fromEntries(Object.entries(resolved).map(([k, v]) => [k, parse(v)]));
    for (const c of CONTROLS) {
      let fg = tok[c.fg], bg = tok[c.bg];
      if (!fg || !bg) continue;
      if (c.opacity) { const p = tok[c.parent] ?? bg; fg = mix(fg, p, c.opacity); bg = mix(bg, p, c.opacity); }
      const ratio = contrast(fg, bg);
      const floor = c.nonText ? 3 : 4.5;
      rows.push({
        osMode, palette: value, paletteLabel: label, family,
        control: c.id, controlLabel: c.label, rule: c.rule, enabled: c.enabled,
        fgToken: c.fg, bgToken: c.bg, fg: hex(fg), bg: hex(bg),
        ratio: Number(ratio.toFixed(2)), floor, passes: ratio >= floor,
      });
    }
  }
  await ctx.close();
}
await browser.close();
fs.rmSync(tmp, { force: true });

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "contrast-data-REPOSOURCE.json"), JSON.stringify(rows, null, 1));

/* ---------------------------------------------------------------- findings */
const say = [];
const P = s => { say.push(s); console.log(s); };

P(`Cloud9 palette contrast audit — installed stylesheet ${path.basename(CSS)}`);
P(`Rows: ${rows.length}  (16 palettes x ${CONTROLS.length} controls x 2 OS modes)`);

/* 1. Do the named dark palettes actually differ from one another? */
for (const osMode of ["dark", "light"]) {
  const sig = new Map();
  for (const [value, label, family] of PALETTES.filter(p => p[2] === "dark")) {
    const r = rows.filter(x => x.osMode === osMode && x.palette === value);
    const key = r.map(x => `${x.fg}/${x.bg}`).join("|");
    sig.set(label, key);
  }
  const groups = new Map();
  for (const [label, key] of sig) groups.set(key, [...(groups.get(key) ?? []), label]);
  P(`\n== OS ${osMode}: distinct looks among the 10 DARK palettes: ${groups.size}/10`);
  for (const [, labels] of groups) if (labels.length > 1) P(`   IDENTICAL: ${labels.join(", ")}`);
}

/* 2. ENABLED controls that fail — the "looks disabled but isn't" class. */
P(`\n== ENABLED controls below the readable floor (the owner's bug) ==`);
const bad = rows.filter(r => r.enabled && !r.passes);
const byControl = new Map();
for (const r of bad) byControl.set(r.control, [...(byControl.get(r.control) ?? []), r]);
for (const [, list] of [...byControl].sort((a, b) => b[1].length - a[1].length)) {
  const worst = list.reduce((w, r) => r.ratio < w.ratio ? r : w);
  P(`  ${list[0].controlLabel}  [${list[0].rule}]`);
  P(`     fails in ${list.length} palette/OS combos; worst ${worst.ratio}:1 ` +
    `(${worst.paletteLabel}, OS ${worst.osMode}, ${worst.fgToken} ${worst.fg} on ${worst.bgToken} ${worst.bg})`);
}

/* 3. Enabled controls that read DIMMER than a genuinely disabled one. */
P(`\n== ENABLED controls dimmer than the same palette's DISABLED send button ==`);
for (const osMode of ["dark", "light"]) {
  for (const [value, label] of PALETTES) {
    const dis = rows.find(r => r.osMode === osMode && r.palette === value && r.control === "send-dis");
    if (!dis) continue;
    const worse = rows.filter(r => r.osMode === osMode && r.palette === value && r.enabled && r.ratio < dis.ratio);
    if (worse.length) {
      P(`  ${label} (OS ${osMode}) — disabled send reads ${dis.ratio}:1, yet these ENABLED controls are worse: ` +
        worse.map(w => `${w.controlLabel} ${w.ratio}:1`).join("; "));
    }
  }
}

fs.writeFileSync(path.join(OUT, "contrast-findings.txt"), say.join("\n"));
console.log(`\nwrote ${path.join(OUT, "contrast-data.json")}`);
