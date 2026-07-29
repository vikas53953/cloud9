import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertHarnessIsHonest, qaTarget, reportAndExit, signInAsOwner, waitFor, waitForAgentReply,
} from "./qa-target.mjs";

const SHOTS = new URL("../docs/qa", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
fs.mkdirSync(SHOTS, { recursive: true });
// A QA run points at the throwaway stack by default, never at the real hub
// (finding #18). `qa-target.mjs` owns that decision for every QA script.
const { ui: UI } = qaTarget();

/**
 * How many checks a complete run of this file performs.
 *
 * This number is the difference between "12 of 13 passed" (which reads like a
 * near-miss) and the truth, which was that 36 checks never ran at all. If the
 * run stops early it now FAILS and says so. Add or remove an `ok(...)` and this
 * number must move with it — a mismatch is the suite telling you it drifted.
 */
const EXPECTED_CHECKS = 48;
const results = [];
let failShot = null; // set once a page exists, so an uncaught error leaves evidence
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
  failShot = page;
  page.on("console", m => { if (m.type() === "error") consoleErrors.push("owner: " + m.text()); });
  page.on("pageerror", e => consoleErrors.push("owner pageerror: " + e.message));

  await page.goto(UI);
  await page.waitForSelector("text=Welcome to Cloud9");
  await page.screenshot({ path: `${SHOTS}/01-join.png` });
  ok("join screen renders", true);

  // one owner for how a QA run signs in — it types THIS stack's key, not the
  // shipped default the join screen pre-fills
  await signInAsOwner(page);
  ok("owner connects, #general visible", true);

  // §4.0 harness pre-flight: prove this suite can still tell true from false
  // before a single result from it is believed.
  await assertHarnessIsHonest(page);

  // create agent
  await page.click('button[title="New agent"]');
  await page.fill('.panel input[placeholder="Scout"]', "Scout");
  // selector updated (round 2): the create panel now holds more than one textarea
  // (the skills form), so the personality box is addressed by its own class.
  await page.fill(".panel textarea.persona-input", "You research travel, villas, flights and hotels for trips, always with prices");
  // provider picker (FR-AG-005): Claude default, Codex offered
  const pickerOptions = await page.$$eval(".panel select.providerpick option", os => os.map(o => o.value));
  const pickerValue = await page.inputValue(".panel select.providerpick");
  ok("agent create offers a provider picker (Claude default)",
    pickerOptions.join(",") === "claude,codex" && pickerValue === "claude",
    `${pickerOptions.join("/")} value=${pickerValue}`);

  // ---- feedback round 1, his 5+6: a model picker in CREATE ----
  await page.waitForSelector(".panel select.modelpick");
  const createModels = await page.$$eval(".panel select.modelpick option", os => os.map(o => o.value));
  const createModel = await page.inputValue(".panel select.modelpick");
  ok("agent create offers a model picker with a model already chosen",
    createModels.length > 0 && !!createModel && createModels.includes(createModel),
    `${createModels.join("/")} value=${createModel}`);
  const createModelNames = await page.$$eval(".panel select.modelpick option", os => os.map(o => o.textContent.trim()));
  ok("models are shown by friendly name, not raw ids",
    createModelNames.every(n => n && !/^claude-/.test(n)), createModelNames.join("/"));

  // ---- his 9: the skills section lives in the create modal too ----
  ok("agent create has a Skills section with a way to write and to upload one",
    (await page.locator(".panel .skills .skill-add").count()) === 1 &&
    (await page.locator(".panel .skills .skill-upload").count()) === 1);
  await page.screenshot({ path: `${SHOTS}/02-create-agent.png` });
  await page.click(".panel .foot >> text=Create agent");
  await page.waitForSelector(".sidebar >> text=Scout");
  ok("agent created and listed", true);

  // the sidebar row must say which app AND which model the agent runs on
  const scoutSub = (await page.textContent('.sidebar .agentrow[data-agent="Scout"] .agent-sub')).trim();
  ok("agent row shows the app and the model it runs on",
    /Claude/.test(scoutSub) && scoutSub.split("·").length >= 2, scoutSub);

  // ---- his 15: clicking an agent opens the direct conversation, never a dead click ----
  await page.click('.sidebar .agentrow[data-agent="Scout"] .agentmain');
  await page.waitForSelector('.chathead .ch-title .n:text-is("Scout")', { timeout: 15000 });
  ok("clicking an agent opens the direct conversation with it", true);
  // clicking it a second time must land in the SAME conversation, not a new one
  const scoutRowsBefore = await page.locator('.sidebar .agent-row .agent-name:text-is("Scout")').count();
  await page.click(".sidebar >> text=# general");
  await page.click('.sidebar .agentrow[data-agent="Scout"] .agentmain');
  await page.waitForSelector('.chathead .ch-title .n:text-is("Scout")', { timeout: 15000 });
  await page.waitForTimeout(400);
  const scoutRowsAfter = await page.locator('.sidebar .agent-row .agent-name:text-is("Scout")').count();
  ok("that conversation is found, not created a second time",
    scoutRowsAfter === scoutRowsBefore, `${scoutRowsBefore} then ${scoutRowsAfter} rows named Scout`);

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
  // This is the FIRST time the engine is asked to speak, so it pays the whole
  // cold-start cost: connect, detect both harnesses, start a CLI. That is
  // 15-25s on this machine and the old 8s wait simply could not survive it —
  // the suite died here and blamed the feature. The wait is now on the thing we
  // actually need (an agent message carrying the answer), with a bound that
  // fits a cold engine. Later replies are fast because this one warmed it up.
  await waitForAgentReply(page, "villas");
  ok("@mention draws agent reply", true);
  await page.screenshot({ path: `${SHOTS}/03-chat-reply.png` });

  // free chatter (no mention, relevant)
  await box.fill("should we also look at flights and hotels?");
  await box.press("Enter");
  await waitFor(page, () =>
    [...document.querySelectorAll(".msg p")].filter(p => p.textContent.includes("flights")).length >= 2,
  undefined, { what: "an unmentioned agent to chime in about flights" });
  ok("free chatter: relevant agent chimes in unmentioned", true);

  // background task
  await box.fill("@Scout !bg compare 14 villas and shortlist 3");
  await box.press("Enter");
  await waitFor(page, () => [...document.querySelectorAll(".msg p")]
    .some(p => p.textContent.includes("background")),
  undefined, { what: "the agent's acknowledgement of the background job" });
  // the "started on its own" marker in the run strip (was .proactive-tag)
  await waitFor(page, () => !!document.querySelector(".msg.proactive .selfstart"),
    undefined, { what: "the finished background job to post itself back" });
  ok("background task acks then posts proactive result", true);
  await page.screenshot({ path: `${SHOTS}/04-background-task.png` });

  // quick chat
  await page.keyboard.press("Control+k");
  await page.waitForSelector(".qc-input");
  await page.screenshot({ path: `${SHOTS}/05-quick-chat.png` });
  await page.fill(".qc-input", "quick ping from the hotkey popup");
  await page.press(".qc-input", "Enter");
  await page.waitForSelector("text=Sent to", { timeout: 15000 });
  ok("quick chat (Ctrl/Cmd+K) sends", true);

  // settings: two harness cards with live status from the engine host.
  // No sleep here: Playwright will not click a button something is covering, so
  // the click itself is the wait for the quick panel to get out of the way.
  await page.click('.sidebar-foot button:has-text("⚙")', { timeout: 20000 });
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

  // ---- his 1 + 11: the sign-in card says what is TRUE for its state ----
  // Replaces the old "both sign-in buttons are present" check: when a harness is
  // already signed in the contract forbids a sign-in button at all, so the check
  // is now per-card and state-aware (stricter, never weaker).
  for (const [h, title] of [["claude", "Claude"], ["codex", "Codex"]]) {
    const card = page.locator(`.harnesscard[data-harness="${h}"]`);
    const text = (await card.innerText()).replace(/\s+/g, " ").trim();
    const signedIn = (await card.locator(".signedinline").count()) === 1;
    const waiting = (await card.locator(".waitingline").count()) === 1;
    const failed = (await card.locator(".problemline").count()) === 1;
    const signInBtn = await card.locator(`.primary:has-text("Sign in with ${title}")`).count();
    const states = [signedIn, waiting, failed].filter(Boolean).length;

    if (signedIn) {
      const tick = await card.locator(".signedinline .tick").count();
      const switcher = await card.locator(".signedinline .switchacct").count();
      ok(`${title} card, signed in: green tick, an account line and a quiet Switch account`,
        tick === 1 && switcher === 1 && signInBtn === 0 && !/again/i.test(text), text.slice(0, 120));
    } else if (waiting) {
      const spinner = await card.locator(".waitingline .spinner").count();
      const cancel = await card.locator('.waitingline button:has-text("Cancel")').count();
      ok(`${title} card, working: spinner, "Waiting for you in the browser" and a Cancel`,
        spinner === 1 && cancel === 1 && /waiting for you in the browser/i.test(text), text.slice(0, 120));
    } else if (failed) {
      const retry = await card.locator('.problemline button:has-text("Try again")').count();
      ok(`${title} card, failed: the problem in plain words and a Try again`,
        retry === 1 && (await card.locator(".problemtext").innerText()).trim().length > 0, text.slice(0, 120));
    } else {
      ok(`${title} card, not signed in: one "Sign in with ${title}" button and no "again"`,
        signInBtn === 1 && !/again/i.test(text), text.slice(0, 120));
    }
    ok(`${title} card shows exactly one state`, states <= 1, `signedIn=${signedIn} waiting=${waiting} failed=${failed}`);
  }
  const fallbacks = await page.$$eval(".harnesscard .linkbtn", bs => bs.map(b => b.textContent.trim()));
  ok("settings still offers the API-key fallback on both cards",
    fallbacks.filter(b => /API key instead/.test(b)).length === 2, fallbacks.join(" · "));

  // ---- his 13: settings has real, changeable things ----
  const settingsPanel = page.locator(".panel.settingspanel");
  const themeButtons = await settingsPanel.locator("#set-look .segmented button").count();
  await settingsPanel.locator('#set-look .segmented button:has-text("Dark")').click();
  const wentDark = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  await settingsPanel.locator('#set-look .segmented button:has-text("Light")').click();
  const wentLight = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  ok("settings can actually change the look (light / dark / match this computer)",
    themeButtons === 3 && wentDark === "dark" && wentLight === "light", `${wentDark} then ${wentLight}`);
  await settingsPanel.locator('#set-look .segmented button:has-text("Match this computer")').click();

  const defaultModels = await settingsPanel.locator("#set-agents select.defaultmodelpick option").count();
  ok("settings sets which app + model new agents start on",
    (await settingsPanel.locator("#set-agents select.defaultproviderpick").count()) === 1 && defaultModels > 0,
    `${defaultModels} models`);

  await settingsPanel.locator('#set-notify .switchrow:has-text("Quiet hours") input').check();
  const quietEnabled = await settingsPanel.locator('#set-notify input[type="time"]').first().isEnabled();
  ok("settings has notifications on/off and quiet hours that switch on",
    (await settingsPanel.locator('#set-notify .switchrow:has-text("new messages") input').count()) === 1 && quietEnabled);
  await settingsPanel.locator('#set-notify .switchrow:has-text("Quiet hours") input').uncheck();

  ok("settings tells you where agent files live and offers a Danger zone",
    (await settingsPanel.locator("#set-files .pathbox").count()) === 1 &&
    (await settingsPanel.locator('#set-danger button:has-text("Remove Claude key")').count()) === 1 &&
    (await settingsPanel.locator("#set-danger select.removepersonpick").count()) === 1);

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

  // ---- his 5+6: the model picker is in EDIT too, already holding a model ----
  await page.waitForSelector(".panel select.modelpick");
  const editModels = await page.$$eval(".panel select.modelpick option", os => os.map(o => o.value));
  const editModel = await page.inputValue(".panel select.modelpick");
  ok("agent edit offers a model picker with this agent's model selected",
    editModels.length > 0 && !!editModel && editModels.includes(editModel),
    `${editModels.join("/")} value=${editModel}`);

  // ---- his 9: write a skill, edit it, upload one from a file, delete it ----
  // Names carry a per-run stamp so the check is exact even when the relay's
  // database still holds agents from an earlier run.
  const stamp = Date.now().toString(36).slice(-5);
  const skillA = `Villa shortlist ${stamp}`;
  const skillB = `Villa shortlist ${stamp} v2`;
  const skillC = `Flight watch ${stamp}`;

  await page.click(".panel .skills .skill-add");
  await page.fill(".panel .skill-name-input", skillA);
  await page.fill(".panel .skill-desc-input", "Picks three villas and says why");
  await page.fill(".panel .skill-instructions-input", "Read the villa notes, keep the three best under budget, and give a one-line reason for each.");
  await page.click(".panel .skills .skill-save");
  await page.waitForSelector(`.panel .skillrow[data-skill="${skillA}"]`);
  ok("a skill can be written in plain words and saved", true);

  await page.click(`.panel .skillrow[data-skill="${skillA}"] .skill-edit`);
  await page.fill(".panel .skill-name-input", skillB);
  await page.click(".panel .skills .skill-save");
  await page.waitForSelector(`.panel .skillrow[data-skill="${skillB}"]`);
  ok("a saved skill can be edited",
    (await page.locator(`.panel .skillrow[data-skill="${skillA}"]`).count()) === 0);

  const skillFile = path.join(os.tmpdir(), `${skillC}.md`);
  fs.writeFileSync(skillFile, "Check the fare every morning and tell me when it drops below 8k.");
  await page.setInputFiles(".panel .skills .skill-upload", skillFile);
  await page.waitForSelector(`.panel .skillrow[data-skill="${skillC}"]`);
  await page.click(`.panel .skillrow[data-skill="${skillC}"] .skill-edit`);
  await page.waitForSelector(".panel .skill-instructions-input");
  const uploadedInstructions = await page.inputValue(".panel .skill-instructions-input");
  const uploadedName = await page.inputValue(".panel .skill-name-input");
  ok("a skill can be uploaded from a .md file (name from the filename, body as the instructions)",
    /fare every morning/.test(uploadedInstructions) && uploadedName === skillC,
    `${uploadedName} :: ${uploadedInstructions.slice(0, 50)}`);
  await page.click(".panel .skills .skillformbtns button:has-text('Cancel')");

  await page.click(`.panel .skillrow[data-skill="${skillC}"] .skill-delete`);
  ok("a skill can be deleted",
    (await page.locator(`.panel .skillrow[data-skill="${skillC}"]`).count()) === 0 &&
    (await page.locator(`.panel .skillrow[data-skill="${skillB}"]`).count()) === 1);
  await page.screenshot({ path: `${SHOTS}/14-agent-edit.png` });

  // the surviving skill must actually reach the agent
  await page.click('.overlay .foot button:has-text("Save")');
  // wait for the editor to actually be gone (the save round-tripped), not 800ms
  await waitFor(page, () => !document.querySelector(".overlay .panel .skills"),
    undefined, { timeout: 20000, what: "the agent editor to close after Save" });
  await page.hover(".sidebar .agentrow");
  await page.click('.sidebar .agentrow button[title="Edit agent"]');
  await page.waitForSelector(".panel .skills");
  ok("skills are saved onto the agent and are still there when you reopen it",
    (await page.locator(`.panel .skillrow[data-skill="${skillB}"]`).count()) === 1);
  // put the agent back the way it was found
  await page.click(`.panel .skillrow[data-skill="${skillB}"] .skill-delete`);
  await page.click('.overlay .foot button:has-text("Save")');
  await page.waitForTimeout(400);

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
  await fpage.waitForSelector("text=# general", { timeout: 30000 });
  ok("friend joins via invite", true);

  await fpage.click("text=# general");
  const fbox = fpage.locator(".composer textarea");
  await fbox.fill("hi everyone, Priya here!");
  await fbox.press("Enter");
  await fpage.screenshot({ path: `${SHOTS}/08-friend-view.png` });

  // owner sees the friend's message
  await page.click("text=# general");
  await page.waitForSelector(".msg p:has-text('Priya here')", { timeout: 30000 });
  ok("human-to-human message syncs across clients", true);
  await page.screenshot({ path: `${SHOTS}/09-owner-sees-friend.png` });

  // empty-input edge: Enter on empty composer sends nothing
  const before = await page.locator(".msg").count();
  await box.press("Enter");
  await page.waitForTimeout(400);
  ok("empty message is not sent", (await page.locator(".msg").count()) === before);

  // ---- his 15: every person is listed once ----
  const personNames = await page.$$eval(".sidebar .person-row", rows => rows.map(r => r.dataset.person));
  const duplicates = personNames.filter((n, i) => personNames.indexOf(n) !== i);
  ok("the people list shows each person once",
    duplicates.length === 0 && personNames.filter(n => n === "Priya").length === 1,
    personNames.join(", "));

  // ---- his 15: clicking a person opens the direct conversation with them ----
  await page.click('.sidebar .person-row[data-person="Priya"]');
  await page.waitForSelector('.chathead .ch-title .n:text-is("Priya")', { timeout: 15000 });
  ok("clicking a person opens the direct conversation with them", true);
  const dmRows = await page.locator('.sidebar .agent-row .agent-name:text-is("Priya")').count();
  await page.click('.sidebar .person-row[data-person="Priya"]');
  await page.waitForSelector('.chathead .ch-title .n:text-is("Priya")', { timeout: 15000 });
  ok("clicking that person again reuses the same conversation",
    (await page.locator('.sidebar .agent-row .agent-name:text-is("Priya")').count()) === dmRows,
    `${dmRows} DM row(s)`);
  // your own row is not a dead click — it is plainly not a button
  ok("your own row is marked as you, not offered as a chat",
    (await page.locator(".sidebar .person-row.is-me .youtag").count()) === 1);

  // ---- his 12+14: the design pass — screenshots and no sideways scroll ----
  await page.click(".sidebar >> text=# general");
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(220);
      const over = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      ok(`no sideways scrolling at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
    }
  }
  // the design shots are pinned to the light look so they are comparable run
  // to run; the dark look gets its own shot below
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/design-main.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/design-main-dark.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.waitForTimeout(250);

  await page.click('.sidebar-foot button:has-text("⚙")');
  await page.waitForSelector(".panel.settingspanel");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/design-settings.png`, fullPage: true });
  await page.click('.overlay .foot button:has-text("Done")');

  await page.click('button[title="New agent"]');
  await page.waitForSelector(".panel select.modelpick");
  await page.click(".panel .skills .skill-add");
  await page.fill(".panel .skill-name-input", "Weekly report");
  await page.fill(".panel .skill-desc-input", "Writes the Monday summary of last week");
  await page.fill(".panel .skill-instructions-input", "Read the last seven days of notes. Write five bullet points: what moved, what stalled, what needs me.");
  await page.click(".panel .skills .skill-save");
  await page.waitForSelector('.panel .skillrow[data-skill="Weekly report"]');
  // frame the shot so the model picker and the skills list are both in view
  await page.evaluate(() => document.querySelector(".panel .runsonbox")
    ?.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/design-new-agent.png`, fullPage: true });
  ok("the create screen shows the model picker and the skills editor together",
    (await page.locator(".panel select.modelpick").count()) === 1 &&
    (await page.locator('.panel .skillrow[data-skill="Weekly report"]').count()) === 1 &&
    (await page.locator(".panel .skills .skill-add").count()) === 1);
  await page.click('.overlay .foot button:has-text("Cancel")');

  await page.keyboard.press("Control+k");
  await page.waitForSelector(".qc-input");
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/design-quickchat.png`, fullPage: true });
  await page.keyboard.press("Escape");

  await owner.close();
  await friendCtx.close();
} catch (err) {
  ok("UNCAUGHT", false, String(err));
  if (failShot) {
    try {
      await failShot.screenshot({ path: `${SHOTS}/99-uncaught.png`, fullPage: true });
      console.log("state when it broke:", (await failShot.textContent(".chathead")) ?? "(no chat header)");
    } catch { /* the page is already gone */ }
  }
} finally {
  await browser.close();
}

ok("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 5).join(" | "));
fs.writeFileSync(`${SHOTS}/qa-results.json`, JSON.stringify({
  ranAt: new Date().toISOString(), expected: EXPECTED_CHECKS, executed: results.length, results,
}, null, 2));
// a run that stopped early is a FAILURE, not a good score out of a small number
reportAndExit("qa.mjs", results, EXPECTED_CHECKS);
