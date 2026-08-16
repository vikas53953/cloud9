/**
 * Emit the 16 :root[data-theme="…"] blocks from packages/shared/src/palettes.ts.
 *
 * Reads the compiled table at packages/shared/dist/palettes.js — run
 * `npm run build -w @cloud9/shared` first. Not wired into the app build yet;
 * J2 pastes or imports the output.
 *
 *   node scripts/generate-palette-css.mjs
 *   node scripts/generate-palette-css.mjs --out path/to/palettes.css
 */
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const table = resolve(root, "packages/shared/dist/palettes.js");

let generatePaletteCss;
try {
  ({ generatePaletteCss } = await import(pathToFileURL(table).href));
} catch (err) {
  const reason = err instanceof Error ? err.message : String(err);
  console.error(`generate-palette-css: build shared first (npm run build -w @cloud9/shared).\n${reason}`);
  process.exit(1);
}

const css = generatePaletteCss();
const outFlag = process.argv.indexOf("--out");
if (outFlag >= 0) {
  const dest = process.argv[outFlag + 1];
  if (!dest) {
    console.error("generate-palette-css: --out needs a path");
    process.exit(1);
  }
  writeFileSync(resolve(root, dest), css, "utf8");
} else {
  process.stdout.write(css);
}
