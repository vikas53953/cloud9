#!/usr/bin/env node
/**
 * shot-activity.mjs — photograph the Activity screen in the INSTALLED app.
 *
 * WHY A SCRIPT AND NOT A CLAIM. A green build proves the code compiles and
 * proves nothing about what is on his screen. This launches
 * %LOCALAPPDATA%\Programs\Cloud9\Cloud9.exe — the only Cloud9 he owns — against
 * a THROWAWAY database, makes two agents, opens Activity and photographs it.
 *
 * FRESH ONLY. There is no --real-data door here on purpose: this script creates
 * agents, and creating test agents in his real crew is vandalism. The run
 * ABORTS if `--user-data-dir` did not take, rather than falling through onto
 * %APPDATA%\Cloud9 — the same guard `drive-app.mjs` states and for the same
 * reason.
 *
 *   node scripts/shot-activity.mjs             photograph and close
 *   node scripts/shot-activity.mjs --keep-open leave the window up to look at
 */
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * WHICH CLOUD9 GETS PHOTOGRAPHED.
 *
 * By default: `release/win-unpacked/Cloud9.exe` — the PACKAGED app this branch
 * built. Not a dev server and not a Vite preview: the same Electron bundle the
 * installer copies into place, with the same `dist-web`, launched as a real
 * Windows program. It is deliberately the default because several branches
 * share this machine and only one `%LOCALAPPDATA%\Programs\Cloud9` exists —
 * installing over it would quietly replace whatever another branch is in the
 * middle of verifying.
 *
 * `--installed` photographs that shared install instead, for when this branch
 * is the one actually being handed over.
 */
const PACKAGED_EXE = path.join(REPO_ROOT, "release", "win-unpacked", "Cloud9.exe");
const INSTALLED_EXE = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "Programs", "Cloud9", "Cloud9.exe");
const APP_EXE = process.argv.includes("--installed") ? INSTALLED_EXE : PACKAGED_EXE;
const SHOTS = path.join(REPO_ROOT, "docs", "qa");
const KEEP_OPEN = process.argv.includes("--keep-open");
const DEMO = process.argv.includes("--demo");

/** Wait on an observable condition, never on a guessed number of seconds. */
async function until(what, test, { timeout = 60000, every = 400 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await test()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, every));
  }
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

function killStale() {
  try {
    execFileSync("taskkill", ["/F", "/IM", "Cloud9.exe", "/T"], { stdio: "ignore" });
  } catch { /* nothing was running, which is the normal case */ }
}

async function shot(page, slug) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `activity-${slug}.png`);
  await page.screenshot({ path: file });
  console.log(`  shot  ${file}`);
  return file;
}

async function makeAgent(page, name, persona) {
  await page.click('.rail .rail-btn[data-go="crew"]');
  await page.waitForSelector(".crew-bar", { timeout: 30000 });
  const write = page.locator(".crew-bar button, .crew-bar a")
    .filter({ hasText: /write|new agent|make/i }).first();
  if (await write.count()) await write.click();
  else await page.click('button:has-text("Write an agent")');
  await page.waitForSelector(".editor .persona-input", { timeout: 30000 });
  await page.fill(".editor #f-name", name);
  await page.fill(".editor .persona-input", persona);
  await page.click(".editor .topbar >> text=Create agent");
  await page.waitForSelector(`.cast[data-crew="${name}"]`, { timeout: 40000 });
  console.log(`  made agent ${name}`);
}

async function main() {
  if (!fs.existsSync(APP_EXE)) {
    throw new Error(`no Cloud9 to photograph at: ${APP_EXE}\n` +
      "Run `npm run dist` first (that builds release/win-unpacked).");
  }
  killStale();

  const port = await freePort();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-shot-"));
  console.log(`  launching ${APP_EXE} (throwaway data: ${userData})`);
  /* REAL BY DEFAULT, DEMO ONLY IF ASKED.
     `--demo` makes the engine answer with made-up text. It is useful for the
     quiet states, but it CANNOT photograph the working row: the demo provider
     returns synchronously, so the lamp is on for microseconds and no amount of
     polling will ever see it. A real turn takes seconds, which is the whole
     reason the live row is worth having — so the default is real. */
  const child = spawn(APP_EXE,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`],
    {
      detached: true, stdio: "ignore",
      env: { ...process.env, ...(DEMO ? { CLOUD9_DEMO: "1" } : {}) },
    });
  child.unref();

  await until("the app's debugger to answer", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    return !!r?.ok;
  }, { timeout: 120000 });

  /* NO PROOF, NO RUN. If Electron ignored --user-data-dir this run is sitting
     on his real crew, and it must stop rather than write test agents into it. */
  await until("the app to build its database in the throwaway folder",
    () => fs.existsSync(path.join(userData, "cloud9-relay.db")), { timeout: 90000 })
    .catch(() => {
      killStale();
      throw new Error("--user-data-dir was ignored — refusing to touch his real Cloud9 data.");
    });

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page = null;
  await until("Cloud9's own window to appear", async () => {
    page = browser.contexts().flatMap(c => c.pages())
      .find(p => /dist-web|index\.html/i.test(p.url()));
    return !!page;
  }, { timeout: 60000 });
  console.log(`  attached to ${page.url()}`);
  await page.waitForSelector(".rail .rail-btn", { timeout: 60000 });

  /* ---- 1. the empty board: it must SAY it is empty, not show a blank box --- */

  await page.click('.rail .rail-btn[data-go="activity"]');
  await page.waitForSelector(".rightnow", { timeout: 30000 });
  const emptyLine = (await page.locator(".rn-sum").innerText()).trim();
  console.log(`  no agents yet → "${emptyLine}"`);
  if (!emptyLine) throw new Error("NOT ON SCREEN — the board said nothing with no agents.");
  await shot(page, "1-no-agents");

  /* ---- 2. with a crew on it ---------------------------------------------- */

  await makeAgent(page, "Scout", "Looks things up and reports back in plain words.");
  await makeAgent(page, "Ledger", "Keeps the numbers straight.");

  await page.click('.rail .rail-btn[data-go="activity"]');
  await page.waitForSelector(".rn-row", { timeout: 30000 });
  await until("both agents on the board",
    async () => await page.locator(".rn-row").count() >= 2);

  const board = await page.$$eval(".rn-row", rows => rows.map(r => ({
    state: r.getAttribute("data-state"),
    name: r.querySelector(".rn-tx b")?.innerText.trim(),
    headline: r.querySelector(".rn-state")?.innerText.trim(),
    detail: r.querySelector(".rn-detail")?.innerText.trim(),
  })));
  const summary = (await page.locator(".rn-sum").innerText()).trim();
  console.log(`  top line: "${summary}"`);
  for (const r of board) console.log(`  row: ${r.name} [${r.state}] ${r.headline} — ${r.detail}`);

  /* THE THING THIS SCREEN EXISTS FOR: no row may be silent. */
  for (const r of board) {
    if (!r.headline || !r.detail) {
      throw new Error(`NOT ON SCREEN — ${r.name} has a blank row: ${JSON.stringify(r)}`);
    }
  }
  const railLabel = (await page.locator('.rail .rail-btn[data-go="activity"]').innerText()).trim();
  console.log(`  rail button reads: "${railLabel}"`);
  if (!/activity/i.test(railLabel)) {
    throw new Error(`NOT ON SCREEN — the rail button reads "${railLabel}", not Activity.`);
  }

  await shot(page, "2-board-and-trail");

  /* ---- 3. AN AGENT ACTUALLY WORKING ---------------------------------------
     The quiet states are the easy half. The row this feature exists for is the
     one that says "Working now", and a screenshot of an idle board does not
     prove it. So: really ask an agent something, in the real composer, and
     photograph the board while the answer is being worked on. */

  /* ASK FROM WHERE HE IS ALREADY STANDING.
     Earlier tries walked to the chat screen, typed, and walked back — and a
     round trip through two screens takes longer than a short turn, so the live
     row was over before the board was on screen again and the run kept
     reporting it as unprovable. Quick chat is drawn ABOVE the screen, so the
     board is already mounted behind it: ask, close, and the working row is
     right there. This is also exactly how he would do it. */
  await page.click('.rail .rail-btn[data-go="activity"]');
  await page.waitForSelector(".rightnow", { timeout: 30000 });

  /* WAIT FOR THE APP TO REPORT IN BEFORE ASKING IT ANYTHING.
     The first attempt typed the moment the agents existed, while the board
     still read "Claude hasn't reported in yet" — so nothing ran and the walk
     reported both live states as unprovable when the real problem was that it
     had asked too early. The board's own words are the readiness signal, which
     is a neat thing about having built it: the screen says when it is ready. */
  await until("this computer's Claude to report in", async () => {
    const said = await page.locator(".rn-row").first().innerText().catch(() => "");
    return !/hasn't reported in yet/.test(said);
  }, { timeout: 90000, every: 1000 }).catch(() => {
    console.log("  (Claude never reported in — the turn below may not run)");
  });

  await page.keyboard.press("Control+K");
  await page.waitForSelector(".qc-input", { timeout: 15000 });
  await page.fill(".qc-input", "say the word ok");
  const scoutOpt = page.locator(".qc-opt").filter({ hasText: "Scout" }).first();
  if (await scoutOpt.count()) await scoutOpt.click();
  await page.press(".qc-input", "Enter");
  await page.keyboard.press("Escape").catch(() => {});
  console.log("  asked Scout something from quick chat, standing on the board");

  let sawWorking = false;
  try {
    await until("the Activity board to show an agent working", async () => {
      sawWorking = await page.locator('.rn-row[data-state="working"]').count() > 0;
      return sawWorking;
    }, { timeout: 60000, every: 120 });
  } catch { /* reported below — a miss is said out loud, never swallowed */ }

  if (sawWorking) {
    const line = (await page.locator(".rn-sum").innerText()).trim();
    const row = await page.locator('.rn-row[data-state="working"]').first().innerText();
    console.log(`  WORKING top line: "${line}"`);
    console.log(`  WORKING row: ${row.replace(/\s+/g, " ")}`);
    await shot(page, "3-working-now");
  } else {
    console.log("  (never caught the working state — the turn finished faster than the board was opened)");
  }

  /* ---- 4. AND WHAT IT JUST DID ------------------------------------------- */

  let sawEnding = false;
  try {
    await until("the board to report a finished job", async () => {
      sawEnding = await page.locator('.rn-row[data-state="done"], .rn-row[data-state="failed"], ' +
        '.rn-row[data-state="stopped"]').count() > 0;
      return sawEnding;
      /* A REAL turn on this machine, with real-time virus scanning on every
         process start, is minutes not seconds. This wait is generous on
         purpose: a harness that gives up early reports a working feature as
         unproven, which is the more expensive mistake. */
    }, { timeout: 420000, every: 500 });
  } catch { /* said out loud below */ }

  if (sawEnding) {
    const row = await page.locator('.rn-row[data-state="done"], .rn-row[data-state="failed"], ' +
      '.rn-row[data-state="stopped"]').first();
    console.log(`  ENDING row: ${(await row.innerText()).replace(/\s+/g, " ")}`);
    console.log(`  ENDING state: ${await row.getAttribute("data-state")}`);
    await shot(page, "4-what-it-just-did");
  } else {
    console.log("  (no finished job reached the board within the wait)");
  }

  console.log("\n  Activity board is on screen, with words in every row.");
  console.log(`  working state photographed: ${sawWorking}; ending state photographed: ${sawEnding}`);
  if (KEEP_OPEN) {
    console.log("  --keep-open: the window is still up; close it yourself.");
    return;
  }
  await browser.close().catch(() => {});
  killStale();
  /* The throwaway folder is the app's, not ours, and Windows can still be
     holding a handle on it a moment after the process goes. Failing to delete
     a temp folder is not a failed verification — `sweepOldTempDirs` in
     drive-app.mjs clears the strays on the next run. */
  try { fs.rmSync(userData, { recursive: true, force: true }); }
  catch { console.log(`  (left ${userData} behind — Windows still had it open)`); }
}

main().catch(err => {
  console.error(`\n  FAILED: ${err.message}`);
  if (!KEEP_OPEN) killStale();
  process.exit(1);
});
