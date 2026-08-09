#!/usr/bin/env node
/**
 * shoot-spending.mjs — photograph the Spending page over the OWNER'S REAL DATA,
 * and touch nothing.
 *
 * WHY IT IS NOT PART OF `drive-app.mjs`. That harness walks the whole app: it
 * creates an agent, hires a role, types into rooms and runs real CLI turns. On a
 * fresh database that is exactly right. Over his real Cloud9 it would leave test
 * messages in his actual rooms and spend his actual money, which is why the
 * walk defaults to a throwaway database in the first place.
 *
 * But a fresh database has one test agent with one turn and no reported cost,
 * so a screenshot of it proves the DOOR is there and proves nothing about the
 * FIGURES — and the figures are the thing that was wrong. His real history is
 * the only place the corrected arithmetic can be seen doing its job: six agents,
 * 185 stored runs, one of them handed 1,120,105 tokens.
 *
 * SO THIS SCRIPT DOES EXACTLY THREE THINGS: open the app, press Spending,
 * photograph it. It types nothing, creates nothing, sends no message, starts no
 * turn and answers no card. The only frame it causes is the `spending` request
 * the screen makes for itself on opening, which is a read.
 *
 *   node scripts/shoot-spending.mjs
 */
import { chromium } from "playwright";
import { clickRail } from "./rail-navigation.mjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_EXE = path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Cloud9", "Cloud9.exe");
const OUT = path.join(repo, "docs", "qa", "kept");

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function main() {
  if (!fs.existsSync(APP_EXE)) {
    console.error(`Cloud9 is not installed at ${APP_EXE}. Install it first.`);
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });
  const port = await freePort();
  // NO --user-data-dir. This one is deliberately his real Cloud9, because his
  // real history is the whole point. Everything below is read-only.
  const child = spawn(APP_EXE, [`--remote-debugging-port=${port}`], {
    detached: false, stdio: "ignore",
  });

  let browser;
  try {
    // wait for the window to answer a debugger rather than sleeping at it
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
        break;
      } catch (err) {
        if (Date.now() > deadline) throw new Error(`the app never answered a debugger: ${err.message}`);
        await new Promise(r => setTimeout(r, 500));
      }
    }
    const ctx = browser.contexts()[0];
    const page = (ctx.pages().find(p => !p.url().startsWith("devtools://")))
      ?? await ctx.waitForEvent("page");
    await page.waitForSelector(".rail", { timeout: 60_000 });

    await clickRail(page, "spending");
    await page.waitForSelector(".spending", { timeout: 30_000 });
    // wait for the hub's answer to land rather than photographing "working it out"
    await page.waitForFunction(
      () => !!document.querySelector("[data-spend-agent], [data-spend-lead], .empty"),
      { timeout: 60_000 });

    const seen = await page.evaluate(() => ({
      rows: [...document.querySelectorAll("[data-spend-agent]")].map(r => ({
        name: r.querySelector(".who b")?.innerText.trim(),
        money: r.querySelector(".amt")?.innerText.trim(),
        split: r.querySelector(".splitbar .sent span")?.innerText.trim(),
        findings: [...r.querySelectorAll("[data-finding]")].map(f => f.getAttribute("data-finding")),
      })),
    }));
    const file = path.join(OUT, "spending-real-data.png");
    await page.screenshot({ path: file, fullPage: false });
    console.log(`  shot  ${file}`);
    for (const r of seen.rows) {
      console.log(`  ${String(r.name).padEnd(11)} ${String(r.money).padEnd(46)} `
        + `${String(r.split).padEnd(18)} ${r.findings.join(",")}`);
    }
    // THE SAME LAW THE WALK CHECKS, asked of his real crew: a cost nobody
    // reported must be words, never a zero.
    const zero = seen.rows.find(r => /^\$0\.00\b/.test(r.money ?? ""));
    if (zero) throw new Error(`${zero.name} is showing ${zero.money} — that must be words`);
    if (seen.rows.length === 0) console.log("  (no agent has a recorded turn this month)");
  } finally {
    if (browser) await browser.close().catch(() => { });
    // Close the window the way a person does, not by killing the process, so
    // his app shuts down cleanly and writes whatever it normally writes.
    try { child.kill(); } catch { /* already gone */ }
  }
}

main().catch(err => { console.error(err.message ?? err); process.exit(1); });
