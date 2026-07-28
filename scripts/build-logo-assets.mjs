/**
 * Renders apps/desktop/public/logo.svg to PNGs at every icon size and packs a
 * multi-size Windows icon.ico. Uses Playwright's bundled Chromium (already a
 * dev dependency) — no image library needed.
 *
 * Run:  node scripts/build-logo-assets.mjs
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, "..", "apps", "desktop", "public");
const svgPath = path.join(publicDir, "logo.svg");
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const svg = fs.readFileSync(svgPath, "utf8");

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

for (const size of SIZES) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">
       <div style="width:${size}px;height:${size}px">${svg.replace(
         /width="64" height="64"/,
         `width="${size}" height="${size}"`
       )}</div>
     </body></html>`
  );
  await page.screenshot({
    path: path.join(publicDir, `logo-${size}.png`),
    omitBackground: true,
  });
  console.log("wrote", `logo-${size}.png`);
}

await browser.close();

/* ---- pack icon.ico (PNG-compressed entries; Windows Vista+ reads these) ---- */
const entries = ICO_SIZES.map((s) => ({
  size: s,
  data: fs.readFileSync(path.join(publicDir, `logo-${s}.png`)),
}));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(entries.length, 4);

const dir = Buffer.alloc(16 * entries.length);
let offset = header.length + dir.length;
entries.forEach((e, i) => {
  const b = i * 16;
  dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 0); // width  (0 == 256)
  dir.writeUInt8(e.size >= 256 ? 0 : e.size, b + 1); // height
  dir.writeUInt8(0, b + 2); // palette
  dir.writeUInt8(0, b + 3); // reserved
  dir.writeUInt16LE(1, b + 4); // colour planes
  dir.writeUInt16LE(32, b + 6); // bits per pixel
  dir.writeUInt32LE(e.data.length, b + 8);
  dir.writeUInt32LE(offset, b + 12);
  offset += e.data.length;
});

fs.writeFileSync(
  path.join(publicDir, "icon.ico"),
  Buffer.concat([header, dir, ...entries.map((e) => e.data)])
);
console.log("wrote icon.ico with", entries.length, "sizes");
