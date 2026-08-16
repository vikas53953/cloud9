/** Dump the raw resolved tokens per palette so the audit's numbers can be checked by hand. */
import { chromium } from "playwright";
import fs from "node:fs"; import path from "node:path"; import os from "node:os";
import { pathToFileURL } from "node:url";

const CSS = String.raw`C:/Users/vikasmit/cloud9/apps/desktop/src/styles.css`;
const tmp = path.join(os.tmpdir(), `probe-${Date.now()}.html`);
fs.writeFileSync(tmp, `<!doctype html><html><head><style>${fs.readFileSync(CSS, "utf8")}</style></head><body><span id="p"></span></body></html>`);

const TOK = ["--bg", "--surface", "--sunk", "--line", "--ink", "--ink-2", "--ink-3",
  "--pine", "--pine-soft", "--on-pine", "--on-ink", "--on-gold", "--marigold-hi",
  "--ultra", "--ultra-soft", "--madder-soft", "--rail-bg", "--rail-active", "--rail-active-ink", "--rail-muted"];

const browser = await chromium.launch();
for (const osMode of ["dark", "light"]) {
  const ctx = await browser.newContext({ colorScheme: osMode });
  const page = await ctx.newPage();
  await page.goto(pathToFileURL(tmp).href);
  for (const [theme, appearance] of [["daylight", "light"], ["nord", "dark"], ["dracula", "dark"], ["high-contrast-dark", "dark"]]) {
    const out = await page.evaluate(({ theme, appearance, TOK }) => {
      const r = document.documentElement;
      r.setAttribute("data-appearance-mode", "system");
      r.setAttribute("data-palette", theme);
      r.setAttribute("data-appearance", appearance);
      r.setAttribute("data-theme", theme);
      const p = document.getElementById("p");
      const viaColor = {}, viaVar = {};
      for (const t of TOK) {
        viaVar[t] = getComputedStyle(r).getPropertyValue(t).trim();
        p.style.color = ""; p.style.color = `var(${t})`;
        viaColor[t] = getComputedStyle(p).color;
      }
      return { viaVar, viaColor };
    }, { theme, appearance, TOK });
    console.log(`\n--- OS ${osMode} / data-theme=${theme} data-appearance=${appearance} ---`);
    for (const t of TOK) console.log(`  ${t.padEnd(20)} declared=${(out.viaVar[t] || "(none)").padEnd(24)} painted=${out.viaColor[t]}`);
  }
  await ctx.close();
}
await browser.close(); fs.rmSync(tmp, { force: true });
