import { chromium } from "playwright";
import fs from "node:fs";

const SHOTS = "C:/Users/vikasmit/cloud9/docs/qa";
fs.mkdirSync(SHOTS, { recursive: true });
const UI = "http://127.0.0.1:5173/?relay=ws://127.0.0.1:8799";
const errs = [];

const theme = (p, t) => p.evaluate(t => document.documentElement.setAttribute("data-theme", t), t);
const wait = (p, ms = 320) => p.waitForTimeout(ms);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", e => errs.push("pageerror: " + e.message));

await page.goto(UI);
await page.waitForSelector("text=Welcome to Cloud9");
await theme(page, "light"); await wait(page);
await page.screenshot({ path: `${SHOTS}/studio-welcome.png`, fullPage: true });

await page.fill(".panel input[type=password]", "studio-shot-key");
await page.click("text=Enter Cloud9");
await page.waitForSelector("text=# general");
await page.click(".sidebar >> text=# ops-floor");
await wait(page, 600);

await theme(page, "light"); await wait(page);
await page.screenshot({ path: `${SHOTS}/studio-chat-light.png`, fullPage: true });
await theme(page, "dark"); await wait(page);
await page.screenshot({ path: `${SHOTS}/studio-chat-dark.png`, fullPage: true });
await theme(page, "light"); await wait(page);

await page.click('.sidebar-foot button:has-text("Crew")');
await page.waitForSelector(".crew-grid, .crew-empty");
await wait(page, 450);
await page.screenshot({ path: `${SHOTS}/studio-crew.png`, fullPage: true });
await theme(page, "dark"); await wait(page);
await page.screenshot({ path: `${SHOTS}/studio-crew-dark.png`, fullPage: true });
await theme(page, "light"); await wait(page);

for (const [w, h] of [[1280, 800], [1440, 900]]) {
  for (const t of ["light", "dark"]) {
    await page.setViewportSize({ width: w, height: h });
    await theme(page, t); await wait(page, 240);
    const over = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      body: document.body.scrollWidth - document.body.clientWidth,
      crew: (() => { const c = document.querySelector(".crew"); return c ? c.scrollWidth - c.clientWidth : 0; })(),
    }));
    console.log(`crew overflow @${w} ${t}: ${JSON.stringify(over)}`);
  }
}
await page.setViewportSize({ width: 1280, height: 900 });
await theme(page, "light"); await wait(page);
await page.click('.crew-bar button:has-text("Back to chat")');

await page.click('button[title="New agent"]');
await page.waitForSelector(".panel select.modelpick");
await page.fill('.panel input[placeholder="Scout"]', "Marlow");
await page.fill(".panel textarea.persona-input",
  "You watch our network the way a good engineer would. You explain findings in plain English first and the detail second. You never change a live device.");
await page.click(".panel .skills .skill-add");
await page.fill(".panel .skill-name-input", "Branch health sweep");
await page.fill(".panel .skill-desc-input", "Runs every weekday at 08:00");
await page.fill(".panel .skill-instructions-input",
  "Pull 14 days of counters for every branch. Flag any link over 85%, any errors climbing, any config off the template.");
await page.click(".panel .skills .skill-save");
await page.waitForSelector('.panel .skillrow[data-skill="Branch health sweep"]');
await page.evaluate(() => document.querySelector(".panel .runsonbox")?.scrollIntoView({ block: "center" }));
await wait(page, 350);
await page.screenshot({ path: `${SHOTS}/studio-new-agent.png`, fullPage: true });
await page.click('.overlay .foot button:has-text("Cancel")');

await page.click('.sidebar-foot button:has-text("⚙")');
await page.waitForSelector(".panel.settingspanel");
await wait(page, 600);
await page.screenshot({ path: `${SHOTS}/studio-settings.png`, fullPage: true });
await page.click('.overlay .foot button:has-text("Done")');

await page.click('.sidebar-foot button:has-text("Tasks")');
await page.waitForSelector(".panel .taskrow, .panel .emptyplate");
await wait(page, 400);
await page.screenshot({ path: `${SHOTS}/studio-tasks.png`, fullPage: true });
await page.click('.overlay .foot button:has-text("Close")');

await page.keyboard.press("Control+k");
await page.waitForSelector(".qc-input");
await page.fill(".qc-input", "check if reading has the same backup problem");
await wait(page, 350);
await page.screenshot({ path: `${SHOTS}/studio-quickchat.png`, fullPage: true });
await page.keyboard.press("Escape");

console.log("console errors:", errs.length ? errs.slice(0, 6).join(" | ") : "none");
await browser.close();
