// Agent lifecycle QA: pause an agent, prove it goes quiet, un-pause it, prove
// it speaks again (FR-AG-007).
import { chromium } from "playwright";
import {
  AGENT_REPLY_TIMEOUT_MS, assertHarnessIsHonest, qaTarget, reportAndExit, signInAsOwner,
} from "./qa-target.mjs";
// throwaway QA stack by default, never the real hub (finding #18)
const { ui: UI } = qaTarget();
/** Checks a complete run performs. Fewer than this and the run FAILED. */
const EXPECTED_CHECKS = 4;
const results = [];
const ok = (n, pass, detail = "") => {
  results.push({ name: n, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} - ${n}${detail ? ` :: ${detail}` : ""}`);
};
const b = await chromium.launch(
  process.env.CLOUD9_CHROMIUM ? { executablePath: process.env.CLOUD9_CHROMIUM } : {},
);
try {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.goto(UI);
  // one owner for how a QA run signs in — types THIS stack's key (qa-target.mjs)
  await signInAsOwner(p);
  // prove this suite can still tell true from false before believing any result
  await assertHarnessIsHonest(p);
  // open a conversation first: the "add an agent here" picker lives in the chat
  // header, so with no conversation open there is nothing to pick from
  await p.click(".sidebar >> text=# general");
  await p.click('button[title="New agent"]');
  await p.fill('input[placeholder="Scout"]', "Echo");
  // the create screen holds more than one textarea (the skills form), so the
  // personality box is addressed by its own class
  await p.fill("textarea.persona-input", "You echo travel research requests helpfully");
  await p.click('.editor >> text=Create agent');
  await p.click('.rail-btn[data-go="chat"]');
  await p.click(".sidebar >> text=# general");
  await p.waitForSelector(".sidebar >> text=Echo");
  const chanSel = await p.$$eval(".chathead select option", os => os.find(o => o.textContent.includes("Echo"))?.value);
  await p.selectOption(".chathead select", chanSel);

  const box = p.locator(".composer textarea");

  /* Echo's OWN row in the rail — never "the first agent row".
   *
   * The QA stack keeps one database for all three scripts, so by the time this
   * one runs the rail already holds Scout (from qa.mjs) and Guard (from
   * qa-v2.mjs). `.agentrow` unqualified meant this suite paused SCOUT, then
   * asked ECHO a question, then reported Cloud9 as broken when Echo — correctly,
   * being enabled — answered. A check that does not name the thing it is
   * checking will eventually accuse the app of a bug it does not have. */
  const echoRow = p.locator('.sidebar .agentrow[data-agent="Echo"]');
  await echoRow.waitFor({ timeout: 20000 });

  /* ---- warm the engine up, and prove it answers AT ALL ----
   * "The paused agent stayed silent" is only worth something if we know the
   * agent would otherwise have spoken. A cold engine is silent too, and it is
   * silent for 15-25s — which is exactly how a 2.5s silence check used to pass
   * an agent that was never going to answer either way. So: get one real reply
   * first. From here on the engine is warm, and silence means silence. */
  await box.fill("@Echo hello, are you awake?");
  await box.press("Enter");
  await p.waitForSelector(".msg:has-text('Echo') .badge", { timeout: AGENT_REPLY_TIMEOUT_MS });
  ok("an enabled agent answers (the engine is awake — the control for the silence check below)", true);
  const warmReplies = await p.locator(".msg .badge").count();

  // pause via edit modal
  await echoRow.hover();
  await echoRow.locator(".editbtn").click();
  await p.waitForSelector(".editor .lifecyclepick");
  await p.selectOption(".editor select.lifecyclepick", "paused");
  await p.screenshot({ path: "docs/qa/14-agent-edit.png" });
  await p.click('.editor .topbar >> text=Save');
  /* What "it says it is paused" looks like on screen TODAY.
   *
   * This check has now been wrong twice for the same reason: it named a
   * decoration (.chip 'PAUSED', then .badge 'PAUSED') rather than the thing the
   * journey actually asks for — that the rail tells you this agent will not
   * answer. Both of those elements were removed in the reskin, so the suite was
   * failing a feature that works. The rail's own status line is what a person
   * reads, so that is what is asserted. */
  /* Selector updated in the Studio reskin, and made STRICTER rather than
   * weaker: saving lands you on the crew screen, whose card must say the agent
   * is paused in plain words, AND the rail's own portrait lamp must go dark. */
  await p.locator('.cast[data-crew="Echo"] .now:has-text("Paused")').waitFor({ timeout: 30000 });
  await p.click('.rail-btn[data-go="chat"]');
  await echoRow.locator(".avatar .status.st-asleep").waitFor({ timeout: 30000 });
  ok("the app says the agent is paused after the edit", true);

  /* An absence cannot be waited for, only given time to appear. That window is
   * meaningful now only because the reply above proved the engine is warm and
   * answers in well under it. */
  await box.fill("@Echo are you there?");
  await box.press("Enter");
  await p.waitForTimeout(6000);
  const pausedReplies = await p.locator(".msg .badge").count();
  // if it DID speak, say what it said — "false" on its own sends the next
  // person hunting through the engine for a bug that may not be there
  const spoke = pausedReplies === warmReplies ? "" : await p.$$eval(
    ".msg", (rows, n) => rows.filter(r => r.querySelector(".badge"))
      .slice(n).map(r => r.innerText.replace(/\s+/g, " ").slice(0, 120)).join(" || "),
    warmReplies);
  ok("paused agent stays silent", pausedReplies === warmReplies,
    spoke && `it answered anyway: ${spoke}`);

  // unpause → replies again
  await echoRow.hover();
  await echoRow.locator(".editbtn").click();
  await p.waitForSelector(".editor .lifecyclepick");
  await p.selectOption(".editor select.lifecyclepick", "enabled");
  await p.click('.editor .topbar >> text=Save');
  await p.click('.rail-btn[data-go="chat"]');
  await box.fill("@Echo are you there now?");
  await box.press("Enter");
  await p.waitForFunction(
    n => document.querySelectorAll(".msg .badge").length > n,
    pausedReplies, { timeout: AGENT_REPLY_TIMEOUT_MS, polling: 250 });
  ok("re-enabled agent replies", true);
} catch (e) { ok("UNCAUGHT: " + String(e).slice(0, 160), false); }
await b.close();
reportAndExit("qa-lifecycle.mjs", results, EXPECTED_CHECKS);
