import { chromium } from "playwright";
import fs from "node:fs";

const SHOTS = new URL("../docs/qa", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
fs.mkdirSync(SHOTS, { recursive: true });
const RELAY_PORT = process.env.CLOUD9_RELAY_PORT ?? "8787";
const UI = `http://127.0.0.1:${process.env.CLOUD9_UI_PORT ?? "4173"}/?relay=ws://127.0.0.1:${RELAY_PORT}`;
const results = [];
const consoleErrors = [];

function ok(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? " :: " + detail : ""}`);
}

const browser = await chromium.launch(
  process.env.CLOUD9_CHROMIUM ? { executablePath: process.env.CLOUD9_CHROMIUM } : {}
);
try {
  // ---------- owner context ----------
  const owner = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await owner.newPage();
  page.on("console", m => { if (m.type() === "error") consoleErrors.push("owner: " + m.text()); });
  page.on("pageerror", e => consoleErrors.push("owner pageerror: " + e.message));

  await page.goto(UI);
  await page.waitForSelector("text=Welcome to Cloud9");
  await page.screenshot({ path: `${SHOTS}/01-join.png` });
  ok("join screen renders", true);

  await page.click("text=Enter Cloud9");
  await page.waitForSelector("text=# general");
  ok("owner connects, #general visible", true);

  // create agent
  await page.click('button[title="New agent"]');
  await page.fill('.panel input[placeholder="Scout"]', "Scout");
  await page.fill(".panel textarea", "You research travel, villas, flights and hotels for trips, always with prices");
  // provider picker (FR-AG-005): Claude default, Codex offered
  const pickerOptions = await page.$$eval(".panel select.providerpick option", os => os.map(o => o.value));
  const pickerValue = await page.inputValue(".panel select.providerpick");
  ok("agent create offers a provider picker (Claude default)",
    pickerOptions.join(",") === "claude,codex" && pickerValue === "claude",
    `${pickerOptions.join("/")} value=${pickerValue}`);
  await page.screenshot({ path: `${SHOTS}/02-create-agent.png` });
  await page.click(".panel .foot >> text=Create agent");
  await page.waitForSelector(".sidebar >> text=Scout");
  ok("agent created and listed", true);

  // create channel with agent
  await page.click('button[title="New channel"]');
  await page.fill('.panel input[placeholder="trip-goa"]', "trip-goa");
  await page.click('label:has-text("Scout") input');
  await page.click(".panel .foot >> text=Create");
  await page.waitForSelector(".sidebar >> text=# trip-goa");
  await page.click("text=# trip-goa");
  ok("channel created with agent member", true);

  // @mention reply
  const box = page.locator(".composer textarea");
  await box.fill("@Scout find beach villas in Goa under 8k");
  await box.press("Enter");
  // the AGENT tag on an agent message (Workbench reskin renamed .chip -> .badge)
  await page.waitForSelector(".msg:has-text('Scout') .badge", { timeout: 8000 });
  await page.waitForSelector(".msg p:has-text('villas')", { timeout: 8000 });
  ok("@mention draws agent reply", true);
  await page.screenshot({ path: `${SHOTS}/03-chat-reply.png` });

  // free chatter (no mention, relevant)
  await box.fill("should we also look at flights and hotels?");
  await box.press("Enter");
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".msg p")].filter(p => p.textContent.includes("flights")).length >= 2,
  { timeout: 8000 });
  ok("free chatter: relevant agent chimes in unmentioned", true);

  // background task
  await box.fill("@Scout !bg compare 14 villas and shortlist 3");
  await box.press("Enter");
  await page.waitForSelector(".msg p:has-text('background')", { timeout: 8000 });
  // the "started on its own" marker in the run strip (was .proactive-tag)
  await page.waitForSelector(".msg.proactive .selfstart", { timeout: 10000 });
  ok("background task acks then posts proactive result", true);
  await page.screenshot({ path: `${SHOTS}/04-background-task.png` });

  // quick chat
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".qc-input");
  await page.screenshot({ path: `${SHOTS}/05-quick-chat.png` });
  await page.fill(".qc-input", "quick ping from the hotkey popup");
  await page.press(".qc-input", "Enter");
  await page.waitForSelector("text=Sent to", { timeout: 5000 });
  ok("quick chat (Ctrl/Cmd+K) sends", true);
  await page.waitForTimeout(1100);

  // settings: two harness cards with live status from the engine host
  await page.click('.sidebar-foot button:has-text("⚙")');
  await page.waitForSelector("text=connect your AI apps");
  await page.waitForSelector('.harnesscard[data-harness="claude"]');
  await page.waitForSelector('.harnesscard[data-harness="codex"]');
  // status arrives over the relay from the engine host — wait for a real verdict
  await page.waitForFunction(() =>
    ![...document.querySelectorAll(".harnessstate")].some(e => e.textContent.includes("checking")),
  { timeout: 15000 });
  const claudeState = (await page.textContent('.harnesscard[data-harness="claude"] .harnessstate')).trim();
  const codexState = (await page.textContent('.harnesscard[data-harness="codex"] .harnessstate')).trim();
  ok("settings shows live Claude + Codex status", !!claudeState && !!codexState,
    `claude: ${claudeState} | codex: ${codexState}`);

  const buttons = await page.$$eval(".harnesscard .primary, .harnesscard .linkbtn", bs => bs.map(b => b.textContent.trim()));
  ok("settings offers both sign-in buttons and the API-key fallback",
    buttons.some(b => /with Claude/.test(b)) && buttons.some(b => /with Codex/.test(b)) &&
    buttons.filter(b => /API key instead/.test(b)).length === 2,
    buttons.join(" · "));

  // the policy disclosure (FR-PC-004) stays visible
  await page.waitForSelector("text=Heads up");
  // credentials must never be kept in the browser (secrets class fix)
  const leaked = await page.evaluate(() =>
    Object.keys(localStorage).filter(k => /cred|token|key/i.test(k) && k !== "cloud9.token"));
  ok("no credential is stored in the browser", leaked.length === 0, leaked.join(","));

  // an upgraded install must have its old plain-text credential wiped on start
  await page.evaluate(() => {
    localStorage.setItem("cloud9.claudeCred", "sk-ant-leftover-from-v1");
    localStorage.setItem("cloud9.claudeCredKind", "apiKey");
  });
  await page.reload();
  await page.waitForSelector("text=# general", { timeout: 10000 });
  const purged = await page.evaluate(() => [
    localStorage.getItem("cloud9.claudeCred"),
    localStorage.getItem("cloud9.claudeCredKind"),
  ]);
  ok("an old browser-stored credential is wiped on startup",
    purged[0] === null && purged[1] === null, JSON.stringify(purged));
  await page.click('.sidebar-foot button:has-text("⚙")');
  await page.waitForSelector("text=connect your AI apps");
  await page.screenshot({ path: `${SHOTS}/06-settings.png` });
  await page.click('.overlay .foot button:has-text("Done")');

  // agent edit also lets you change which app an agent runs on
  await page.hover(".sidebar .agentrow");
  await page.click('.sidebar .agentrow button[title="Edit agent"]');
  await page.waitForSelector(".panel select.providerpick");
  const editPicker = await page.$$eval(".panel select.providerpick option", os => os.map(o => o.value));
  ok("agent edit offers a provider picker", editPicker.join(",") === "claude,codex", editPicker.join("/"));
  await page.click('.overlay .foot button:has-text("Cancel")');

  // invite flow
  await page.click('button[title="Invite a friend"]');
  await page.waitForSelector(".code");
  await page.waitForFunction(() => document.querySelector(".code")?.textContent?.startsWith("inv_"));
  const code = (await page.textContent(".code")).trim();
  await page.screenshot({ path: `${SHOTS}/07-invite.png` });
  await page.click('.overlay .foot button:has-text("Done")');
  ok("invite code generated", true, code);

  // ---------- friend context ----------
  const friendCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const fpage = await friendCtx.newPage();
  fpage.on("console", m => { if (m.type() === "error") consoleErrors.push("friend: " + m.text()); });
  await fpage.goto(UI);
  await fpage.click("text=I have an invite");
  await fpage.fill('.panel input[placeholder="inv_…"]', code);
  await fpage.fill('.panel input[placeholder="Priya"]', "Priya");
  await fpage.click("text=Enter Cloud9");
  await fpage.waitForSelector("text=# general", { timeout: 8000 });
  ok("friend joins via invite", true);

  await fpage.click("text=# general");
  const fbox = fpage.locator(".composer textarea");
  await fbox.fill("hi everyone, Priya here!");
  await fbox.press("Enter");
  await fpage.screenshot({ path: `${SHOTS}/08-friend-view.png` });

  // owner sees the friend's message
  await page.click("text=# general");
  await page.waitForSelector(".msg p:has-text('Priya here')", { timeout: 8000 });
  ok("human-to-human message syncs across clients", true);
  await page.screenshot({ path: `${SHOTS}/09-owner-sees-friend.png` });

  // empty-input edge: Enter on empty composer sends nothing
  const before = await page.locator(".msg").count();
  await box.press("Enter");
  await page.waitForTimeout(400);
  ok("empty message is not sent", (await page.locator(".msg").count()) === before);

  await owner.close();
  await friendCtx.close();
} catch (err) {
  ok("UNCAUGHT", false, String(err));
} finally {
  await browser.close();
}

ok("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
fs.writeFileSync(`${SHOTS}/qa-results.json`, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
const fails = results.filter(r => !r.pass).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
