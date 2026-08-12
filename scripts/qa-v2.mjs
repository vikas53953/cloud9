// Browser QA for v2: tasks, approvals, activity (spec FR-TS / FR-AP / FR-AU).
import { chromium } from "playwright";
import fs from "node:fs";
import {
  assertHarnessIsHonest, qaTarget, reportAndExit, signInAsOwner, waitFor, waitForAgentAnswer,
} from "./qa-target.mjs";

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
  await page.fill('input[placeholder="Scout"]', "Guard");
  await page.fill("textarea.persona-input", "You handle sensitive research and background jobs carefully");
  // selector updated (Studio reskin): an approval rule is a switch row in the
  // approved design, and the rows lost their padlock emoji.
  await page.click('.toggle-row:has-text("Background work") input');
  await page.screenshot({ path: `${SHOTS}/10-agent-approvals.png` });
  await page.click('.editor >> text=Create agent');
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector(".sidebar >> text=Guard");
  ok("agent created with approval requirement", true);

  // add to #general, request background work
  await page.click(".sidebar >> text=# general");
  await page.selectOption('.chathead select[aria-label="Add someone to this room"]', { label: "✨ Guard" }).catch(async () => {
    const opt = await page.$$eval('.chathead select[aria-label="Add someone to this room"] option', os => os.find(o => o.textContent.includes("Guard"))?.value);
    await page.selectOption('.chathead select[aria-label="Add someone to this room"]', opt);
  });
  const box = page.locator(".composer textarea");
  const sendAccepted = async text => {
    await box.fill(text);
    await waitFor(page, expected => {
      const textarea = document.querySelector(".thread > .composer textarea");
      const send = document.querySelector(".thread > .composer .sendbtn");
      return textarea?.value === expected && send instanceof HTMLButtonElement && !send.disabled;
    }, text, { timeout: 10000,
      what: "the controlled composer to expose the enabled Run action" });
    await page.locator(".thread > .composer .sendbtn").click();
    const accepted = async () => waitFor(page, expected =>
      [...document.querySelectorAll(".msgs .msg[data-msg]")]
        .some(row => (row.textContent ?? "").includes(expected)),
    text, { timeout: 15000, what: `the canonical room message "${text}" to arrive` });
    try {
      await accepted();
    } catch (error) {
      // A lost acknowledgement intentionally leaves the draft untouched and
      // keeps its stable clientMessageId. One manual retry must return the
      // canonical message rather than creating a duplicate.
      if (await box.inputValue() !== text) throw error;
      await page.locator(".thread > .composer .sendbtn").click();
      await accepted();
    }
  };
  await sendAccepted("@Guard !bg research the sensitive topic");
  /* WHERE THE ANSWER IS NOW. Since 2026-08-04 an agent answers in a thread
     hanging off the message it answers, so "I'm waiting for my owner's approval"
     is a reply under his ask, not a row in the scroll — see the long note on
     `waitForAgentAnswer` in qa-target.mjs. The wait bound is that helper's, which
     is sized for a cold engine (15-25s to say its first word on this machine).
     This is the only place this script waits on an agent's words, so it is the
     only place that had to move. */
  const approvalSaid = await waitForAgentAnswer(page, {
    under: { text: "research the sensitive topic" }, text: "approval",
    what: "the agent to say it is waiting for approval, in the thread under the ask",
  });
  ok("agent announces it is waiting for approval, in a thread under the message that asked",
    approvalSaid.answerIds.length >= 1 && approvalSaid.replies >= 1,
    `${approvalSaid.answerIds.length} line(s) in the thread, the ask says ${approvalSaid.replies} reply/replies`);

  // Tasks is a Build destination behind More. Open it through the shared
  // rail helper, then assert its own badge rather than requiring permanence.
  /* SCOPED TO THIS SCRIPT'S OWN JOB, never "the first row on the screen".
   *
   * WHY IT CHANGED, 2026-08-05. Every agent Cloud9 makes is fully capable from
   * its first second, and every switch that changes the machine asks first — so
   * jobs waiting on his word are now ordinary, and this hub carries whatever
   * qa.mjs (which runs before this, on the same stack) left behind. A global
   * count of exactly one stopped being a fact about THIS script, and reading it
   * as one meant this suite could reject somebody else's job and call it a
   * pass. The badge is still checked; it is simply no longer read as a number
   * nobody owns. */
  await page.locator("[data-open-tools]").click();
  await page.waitForSelector('.rail-tools-drawer [data-go="tasks"] .rail-count', { timeout: 30000 });
  ok("tasks button shows pending-approval badge", true);
  await page.click('.rail-tools-drawer [data-go="tasks"]');
  const sensitiveRow = page.locator(".taskrow", { hasText: "research the sensitive topic" }).first();
  await sensitiveRow.waitFor({ timeout: 30000 });
  await sensitiveRow.locator(".tstatus.waiting_approval").waitFor({ timeout: 30000 });
  await page.screenshot({ path: `${SHOTS}/11-task-approval.png` });

  // reject → cancelled
  await sensitiveRow.locator('button:has-text("Reject")').click();
  await sensitiveRow.locator(".tstatus.cancelled").waitFor({ timeout: 30000 });
  ok("rejected task becomes cancelled and never runs", true);
  await page.click('.rail-btn[data-go="chat"]');

  // second request → approve → completes with proactive result
  await sendAccepted("@Guard !bg summarise the safe topic");
  await page.locator("[data-open-tools]").click();
  await page.waitForSelector('.rail-tools-drawer [data-go="tasks"] .rail-count', { timeout: 30000 });
  await page.click('.rail-tools-drawer [data-go="tasks"]');
  const safeRow = page.locator(".taskrow", { hasText: "summarise the safe topic" }).first();
  await safeRow.waitFor({ timeout: 30000 });
  await safeRow.locator('button:has-text("Approve")').click();
  await safeRow.locator(".tstatus.completed").waitFor({ timeout: 90000 });
  await page.screenshot({ path: `${SHOTS}/12-task-completed.png` });
  ok("approved task runs to completed with result", true);
  await page.click('.rail-btn[data-go="chat"]');
  /* STILL A ROOM MESSAGE, and deliberately. The job's DETAIL goes back into the
     thread it was asked for in, and the conversation gets one short proactive
     line saying it ended and where to look ("🧵 Finished in the thread: …") —
     `reportFinished` in packages/engine/src/engine.ts. So the room is never
     blind to work that happened, and this check is scoped to `.msgs` so a line
     drawn inside an open thread panel could never stand in for it. */
  await page.waitForSelector(".msgs .msg.proactive .selfstart", { timeout: 30000 });
  const roomLine = (await page.locator(".msgs .msg.proactive").last().innerText())
    .replace(/\s+/g, " ").trim();
  ok("a finished job posts one short line back to the channel, unasked, saying it ended and where the detail is",
    /in the thread/i.test(roomLine), roomLine.slice(0, 100));

  // activity trail
  await page.click('.rail-btn[data-go="activity"]');
  await page.waitForSelector(".actrow", { timeout: 30000 });
  const activityText = await page.locator(".act-body").innerText();
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
