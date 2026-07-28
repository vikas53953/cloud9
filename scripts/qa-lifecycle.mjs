import { chromium } from "playwright";
const UI = "http://127.0.0.1:4173/?relay=ws://127.0.0.1:8787";
let pass = 0, fail = 0;
const ok = (n, p) => { console.log(`${p ? "PASS" : "FAIL"} - ${n}`); p ? pass++ : fail++; };
const b = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
try {
  const p = await (await b.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await p.goto(UI);
  await p.click("text=Enter Cloud9");
  await p.waitForSelector(".sidebar >> text=# general");
  await p.click('button[title="New agent"]');
  await p.fill('.panel input[placeholder="Scout"]', "Echo");
  await p.fill(".panel textarea", "You echo travel research requests helpfully");
  await p.click('.panel .foot >> text=Create agent');
  await p.waitForSelector(".sidebar >> text=Echo");
  const chanSel = await p.$$eval(".chathead select option", os => os.find(o => o.textContent.includes("Echo"))?.value);
  await p.selectOption(".chathead select", chanSel);

  // pause via edit modal
  await p.hover(".agentrow");
  await p.click(".agentrow .editbtn");
  await p.waitForSelector("text=Edit");
  await p.selectOption(".panel select", "paused");
  await p.screenshot({ path: "docs/qa/14-agent-edit.png" });
  await p.click('.panel .foot >> text=Save');
  await p.waitForSelector(".chip:has-text('PAUSED')");
  ok("agent shows PAUSED after edit", true);

  const box = p.locator(".composer textarea");
  const before = await p.locator(".msg").count();
  await box.fill("@Echo are you there?");
  await box.press("Enter");
  await p.waitForTimeout(2500);
  const agentReplies = await p.locator(".msg .chip:has-text('AGENT')").count();
  ok("paused agent stays silent", agentReplies === 0);

  // unpause → replies again
  await p.hover(".agentrow");
  await p.click(".agentrow .editbtn");
  await p.selectOption(".panel select", "enabled");
  await p.click('.panel .foot >> text=Save');
  await box.fill("@Echo are you there now?");
  await box.press("Enter");
  await p.waitForSelector(".msg:has-text('Echo') .chip:has-text('AGENT')", { timeout: 8000 });
  ok("re-enabled agent replies", true);
} catch (e) { ok("UNCAUGHT: " + String(e).slice(0, 160), false); }
await b.close();
console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
