// Makes "build a real app" work on a plain Windows account.
//
// The packager keeps a toolbox of signing helpers in a cache folder. That
// toolbox is a mac/linux/windows bundle, and two of the mac files inside it are
// shortcuts (symlinks). Creating a shortcut on Windows needs a permission an
// ordinary account does not have, so unpacking the toolbox fails, and the whole
// build stops with a 7-Zip error that says nothing useful.
//
// We only ever build for Windows, so the mac files are dead weight. This script
// unpacks the same toolbox itself, skipping the mac folder, and puts it exactly
// where the packager looks. If the toolbox is already there it does nothing.
//
// Safe to run any time: it never deletes anything and never fails the build.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Version the packager asks for today. If it ever asks for a newer one this
// script simply does nothing and the packager falls back to its own download.
const TOOLBOX = "winCodeSign-2.6.0";
const URL =
  "https://github.com/electron-userland/electron-builder-binaries/releases/download/" +
  `${TOOLBOX}/${TOOLBOX}.7z`;

function cacheRoot() {
  if (process.env.ELECTRON_BUILDER_CACHE) return process.env.ELECTRON_BUILDER_CACHE;
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, "electron-builder", "Cache");
}

async function main() {
  if (process.platform !== "win32") return;

  const target = path.join(cacheRoot(), "winCodeSign", TOOLBOX);
  if (fs.existsSync(path.join(target, "windows-10"))) return; // already good

  const sevenZip = path.join(repoRoot, "node_modules", "7zip-bin", "win", "x64", "7za.exe");
  if (!fs.existsSync(sevenZip)) return; // packager not installed yet — nothing to prepare

  console.log("[cloud9] setting up the packaging toolbox (first time only)…");
  const archive = `${target}.7z`;
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const res = await fetch(URL);
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));

  // -xr!darwin drops the mac-only files, which are the ones Windows refuses to unpack
  execFileSync(sevenZip, ["x", "-bd", "-y", `-xr!darwin`, archive, `-o${target}`], {
    stdio: "ignore",
  });
  fs.rmSync(archive, { force: true });
  console.log("[cloud9] packaging toolbox ready");
}

main().catch((err) => {
  // Never block the build: the packager will try its own way and report properly.
  console.warn(`[cloud9] could not pre-build the packaging toolbox (${err.message}) — carrying on`);
});
