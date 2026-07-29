// Browser QA for v2: tasks, approvals, activity (spec FR-TS / FR-AP / FR-AU).
import { chromium } from "playwright";
import fs from "node:fs";
import { assertHarnessIsHonest, qaTarget, reportAndExit, signInAsOwner } from "./qa-target.mjs";

const SHOTS = new URL("../docs/qa", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
fs.mkdirSync(SHOTS, { recursive: true });
// throwaway QA stack by default, never the real hub (finding #18)
const { ui: UI } = qaTarget();
/** Checks a complete run performs. Short of this the run FAILED — see reportAndExit. */
const EXPECTED_CHECKS = 8;
const results = [];
const consoleErrors = [];
function ok(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? " :: " + detail : ""}`);
}

const browser = await chromium.launch(
  process.env.CLOUD9_CHROMIUM ? { executablePath: process.env.CLOUD9_CHROMIUM } : {},
);
try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", e => consoleErrors.push("pageerror: " + e.message));

  await page.goto(UI);
  // one owner for how a QA run signs in — types THIS stack's key (qa-target.mjs)
  await signInAsOwner(page);
  // prove this suite can still tell true from false before believing any result
  await assertHarnessIsHonest(page);

  // agent that requires approval for background work
  await page.click('button[title="New agent"]');
  await page.fill('.panel input[placeholder="Scout"]', "Guard");
  await page.fill(".panel textarea.persona-input", "You handle sensitive research and background jobs carefully");
  await page.click('.panel label:has-text("🔒 Background work") input');
  await page.screenshot({ path: `${SHOTS}/10-agent-approvals.png` });
  await page.click('.panel .foot >> text=Create agent');
  await page.waitForSelector(".sidebar >> text=Guard");
  ok("agent created with approval requirement", true);

  // add to #general, request background work
  await page.click(".sidebar >> text=# general");
  await page.selectOption(".chathead select", { label: "✨ Guard" }).catch(async () => {
    const opt = await page.$$eval(".chathead select option", os => os.find(o => o.textContent.includes("Guard"))?.value);
    await page.selectOption(".chathead select", opt);
  });
  const box = page.locator(".composer textarea");
  await box.fill("@Guard !bg research the sensitive topic");
  await box.press("Enter");
  // a cold engine takes 15-25s to say its first word; 8s could never survive it
  await page.waitForSelector(".msg p:has-text('approval')", { timeout: 90000 });
  ok("agent announces it is waiting for approval", true);

  // tasks panel shows badge + pending approval
  await page.waitForSelector('.sidebar-foot button:has-text("Tasks (1)")', { timeout: 30000 });
  ok("tasks button shows pending-approval badge", true);
  await page.click('.sidebar-foot button:has-text("Tasks")');
  await page.waitForSelector(".taskrow");
  await page.waitForSelector(".tstatus.waiting_approval");
  await page.screenshot({ path: `${SHOTS}/11-task-approval.png` });

  // reject → cancelled
  await page.click('.taskrow button:has-text("Reject")');
  await page.waitForSelector(".tstatus.cancelled", { timeout: 30000 });
  ok("rejected task becomes cancelled and never runs", true);
  await page.click('.panel .foot >> text=Close');

  // second request → approve → completes with proactive result
  await box.fill("@Guard !bg summarise the safe topic");
  await box.press("Enter");
  await page.waitForSelector('.sidebar-foot button:has-text("Tasks (1)")', { timeout: 30000 });
  await page.click('.sidebar-foot button:has-text("Tasks")');
  await page.click('.taskrow button:has-text("Approve")');
  await page.waitForSelector(".tstatus.completed", { timeout: 90000 });
  await page.screenshot({ path: `${SHOTS}/12-task-completed.png` });
  ok("approved task runs to completed with result", true);
  await page.click('.panel .foot >> text=Close');
  await page.waitForSelector(".msg.proactive .selfstart", { timeout: 30000 });
  ok("completion posts a proactive message in the channel", true);

  // activity trail
  await page.click('.sidebar-foot button:has-text("🕘")');
  await page.waitForSelector(".actrow", { timeout: 30000 });
  const activityText = await page.locator(".panel .body").innerText();
  ok("activity shows approval decisions attributed to Vikas",
    /approved|rejected/.test(activityText) && /Vikas/.test(activityText));
  await page.screenshot({ path: `${SHOTS}/13-activity.png` });

  await ctx.close();
} catch (err) {
  ok("UNCAUGHT", false, String(err).slice(0, 300));
} finally {
  await browser.close();
}
ok("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
fs.writeFileSync(`${SHOTS}/qa-v2-results.json`, JSON.stringify({ ranAt: new Date().toISOString(), expected: EXPECTED_CHECKS, executed: results.length, results }, null, 2));
// a run that stopped early is a FAILURE, not a good score out of a small number
reportAndExit("qa-v2.mjs", results, EXPECTED_CHECKS);
