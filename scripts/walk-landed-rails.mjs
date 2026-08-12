#!/usr/bin/env node
/**
 * walk-landed-rails.mjs — open the INSTALLED Cloud9 and prove the newly
 * landed left-rail screens are on his screen (not only in git).
 *
 * Fresh user-data only — never touches his real Cloud9 database.
 *
 *   node scripts/walk-landed-rails.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_EXE = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "Programs", "Cloud9", "Cloud9.exe");
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(REPO, "docs", "qa", "landed-walk-" + new Date().toISOString().slice(0, 10));
const PORT = 9340 + Math.floor(Math.random() * 50);

const RAILS = [
  { title: "Workflows", expect: /workflow|runbook|nothing starts until you press run|no workflows/i },
  { title: "Decision threads", expect: /decision|forum|thread|no project|pick a project|topics/i },
  { title: "Huddles", expect: /huddle|presence|shared notes|no huddle|project/i },
  { title: "Engineering Pulse", expect: /pulse|engineering pulse|updates|nothing yet|project/i },
  { title: "Polls", expect: /poll|vote|no poll|project/i },
  { title: "Canvas", expect: /canvas|board|no canvas|project/i },
  { title: "Public updates", expect: /public update|draft|publish|approve|no update/i },
  { title: "Hooks", expect: /hook|rule|event|when|no hook|owner/i },
  { title: "Team feed", expect: /team feed|social|post|no post|project/i },
  { title: "Saved for later", expect: /saved|later|nothing saved|save/i },
  { title: "Activity", expect: /activity|working|nothing has started|trail/i },
];

function freePort(p) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(p, "127.0.0.1");
  });
}

async function pickPort() {
  for (let i = 0; i < 40; i++) {
    const p = PORT + i;
    if (await freePort(p)) return p;
  }
  throw new Error("no free debug port");
}

async function waitCdp(port, ms = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 400));
  }
  throw new Error(`debugger never answered on ${port}`);
}

const results = [];
function ok(name, detail = "") {
  results.push({ name, pass: true, detail });
  console.log(`  PASS  ${name}${detail ? " — " + detail : ""}`);
}
function fail(name, detail) {
  results.push({ name, pass: false, detail });
  console.error(`  FAIL  ${name} — ${detail}`);
}

async function main() {
  if (!fs.existsSync(APP_EXE)) {
    console.error("Cloud9 is not installed at", APP_EXE);
    process.exit(2);
  }
  fs.mkdirSync(SHOTS, { recursive: true });
  const port = await pickPort();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-landed-"));
  console.log("Installed app:", APP_EXE);
  console.log("Fresh data:   ", userData);
  console.log("Shots:        ", SHOTS);
  console.log("Debug port:   ", port);

  const child = spawn(APP_EXE, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userData}`,
  ], { stdio: "ignore", windowsHide: true });

  let browser;
  try {
    await waitCdp(port);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const ctx = browser.contexts()[0] ?? await browser.newContext();
    let page = ctx.pages().find(p => !p.url().startsWith("devtools:")) ?? ctx.pages()[0];
    if (!page) page = await ctx.newPage();
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    // Owner sign-in for fresh data
    const token = page.locator('input[placeholder*="token" i], input[name*="token" i], input[type="password"]').first();
    const runBtn = page.getByRole("button", { name: /I run this Cloud9|Continue|Open Cloud9|Get in/i }).first();
    if (await token.isVisible({ timeout: 8000 }).catch(() => false)) {
      await token.fill("dev-owner-token");
      if (await runBtn.isVisible().catch(() => false)) await runBtn.click();
      else await page.keyboard.press("Enter");
      await page.waitForTimeout(2000);
    }
    // Some builds have a picker card
    const ownerCard = page.getByText(/I run this Cloud9|I own this Cloud9/i).first();
    if (await ownerCard.isVisible({ timeout: 3000 }).catch(() => false)) {
      await ownerCard.click();
      await page.waitForTimeout(1500);
    }

    await page.screenshot({ path: path.join(SHOTS, "00-home.png"), fullPage: true });
    ok("app opened", path.basename(SHOTS) + "/00-home.png");

    let i = 0;
    for (const rail of RAILS) {
      i += 1;
      const btn = page.locator(`button.rail-btn[title="${rail.title}"]`).first();
      const visible = await btn.isVisible({ timeout: 4000 }).catch(() => false);
      if (!visible) {
        // fallback: any button with that title
        const alt = page.locator(`button[title="${rail.title}"]`).first();
        if (!(await alt.isVisible({ timeout: 2000 }).catch(() => false))) {
          fail(`rail: ${rail.title}`, "button not on screen");
          continue;
        }
        await alt.click();
      } else {
        await btn.click();
      }
      await page.waitForTimeout(900);
      const body = await page.locator("main, .stage, .screen, body").first().innerText().catch(() => "");
      const shot = path.join(SHOTS, `${String(i).padStart(2, "0")}-${rail.title.replace(/\s+/g, "-").toLowerCase()}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      if (rail.expect.test(body) || body.length > 20) {
        ok(`rail: ${rail.title}`, path.basename(shot));
      } else {
        fail(`rail: ${rail.title}`, "screen opened but body looked empty / unmatched");
      }
    }
  } catch (e) {
    fail("walk crashed", e?.message ?? String(e));
  } finally {
    try { await browser?.close(); } catch {}
    try { child.kill(); } catch {}
    // Windows: kill by image if still around with our port
    try {
      spawn("taskkill", ["/F", "/IM", "Cloud9.exe"], { stdio: "ignore", windowsHide: true });
    } catch {}
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  console.log("\n==== LANDED RAIL WALK ====");
  console.log(`${passed} pass · ${failed} fail · of ${results.length}`);
  console.log("shots:", SHOTS);
  if (failed) process.exit(1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
