import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
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
const EXPECTED_CHECKS = 122;
const results = [];
let failShot = null; // set once a page exists, so an uncaught error leaves evidence
const consoleErrors = [];

function ok(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} - ${name}${detail ? " :: " + detail : ""}`);
}

/**
 * A real PNG of one colour, built here rather than checked into the repo.
 *
 * The attachment checks below compare what came back off the hub with what went
 * up, byte for byte. That comparison is only worth anything against a genuine
 * file with a genuine header, so this writes one: signature, IHDR, a deflated
 * IDAT and IEND, with the CRC every chunk is required to carry.
 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([len, typed, crc]);
}

function pngOfSolidColour(width, height, [r, g, b]) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    raw[row] = 0; // no per-row filter
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // 8 bits per channel
  ihdr[9] = 2;  // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
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
  await page.fill('input[placeholder="Scout"]', "Scout");
  // selector updated (round 2): the create screen holds more than one textarea
  // (the skills form), so the personality box is addressed by its own class.
  await page.fill("textarea.persona-input", "You research travel, villas, flights and hotels for trips, always with prices");
  // provider picker (FR-AG-005): Claude default, Codex offered.
  // Selector updated (Studio reskin): the app an agent runs on is picked with
  // the two cards the approved design uses, not a dropdown. Same assertion —
  // exactly claude and codex are offered, and Claude is the one already chosen.
  const pickerOptions = await page.$$eval(".app-pick", bs => bs.map(b => b.dataset.app));
  const pickerValue = await page.$eval('.app-pick[aria-pressed="true"]', b => b.dataset.app);
  ok("agent create offers a provider picker (Claude default)",
    pickerOptions.join(",") === "claude,codex" && pickerValue === "claude",
    `${pickerOptions.join("/")} value=${pickerValue}`);

  // ---- feedback round 1, his 5+6: a model picker in CREATE ----
  await page.waitForSelector("select.modelpick");
  const createModels = await page.$$eval("select.modelpick option", os => os.map(o => o.value));
  const createModel = await page.inputValue("select.modelpick");
  ok("agent create offers a model picker with a model already chosen",
    createModels.length > 0 && !!createModel && createModels.includes(createModel),
    `${createModels.join("/")} value=${createModel}`);
  const createModelNames = await page.$$eval("select.modelpick option", os => os.map(o => o.textContent.trim()));
  ok("models are shown by friendly name, not raw ids",
    createModelNames.every(n => n && !/^claude-/.test(n)), createModelNames.join("/"));

  // ---- his 9: the skills section lives on the create screen too ----
  ok("agent create has a Skills section with a way to write and to upload one",
    (await page.locator(".skills .skill-add").count()) === 1 &&
    (await page.locator(".skills .skill-upload").count()) === 1);
  await page.screenshot({ path: `${SHOTS}/02-create-agent.png` });
  await page.click(".editor >> text=Create agent");
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector(".sidebar >> text=Scout");
  ok("agent created and listed", true);

  // ---- his 15: clicking an agent opens the direct conversation, never a dead click ----
  await page.click('.sidebar .agentrow[data-agent="Scout"] .agentmain');
  await page.waitForSelector('.chathead .ch-title .n:text-is("Scout")', { timeout: 15000 });
  ok("clicking an agent opens the direct conversation with it", true);

  // The conversation's own header must say which app AND which model the agent
  // runs on. (Selector updated in the Studio reskin: the approved design's
  // sidebar row is a portrait and a name, and the app+model line lives in the
  // header of the conversation you land in.)
  const scoutSub = (await page.textContent(".chathead .runchip")).trim();
  ok("the agent's conversation shows the app and the model it runs on",
    /Claude/.test(scoutSub) && scoutSub.split("·").length >= 2, scoutSub);
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
  await page.click('.rail-btn[data-go="settings"]', { timeout: 20000 });
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
  // selectors updated (Studio reskin): the look is chosen with the approved
  // design's three painted cards, each addressed by the theme it sets.
  const settingsPanel = page.locator(".settingspanel");
  const themeButtons = await settingsPanel.locator("#set-look .theme-pick").count();
  await settingsPanel.locator('#set-look .theme-pick[data-theme-set="dark"]').click();
  const wentDark = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  await settingsPanel.locator('#set-look .theme-pick[data-theme-set="light"]').click();
  const wentLight = await page.evaluate(() => document.documentElement.getAttribute("data-theme"));
  ok("settings can actually change the look (light / dark / match this computer)",
    themeButtons === 3 && wentDark === "dark" && wentLight === "light", `${wentDark} then ${wentLight}`);
  await settingsPanel.locator('#set-look .theme-pick[data-theme-set="system"]').click();

  const defaultModels = await settingsPanel.locator("#set-agents select.defaultmodelpick option").count();
  ok("settings sets which app + model new agents start on",
    (await settingsPanel.locator("#set-agents select.defaultproviderpick").count()) === 1 && defaultModels > 0,
    `${defaultModels} models`);

  // selectors updated (Studio reskin): quiet hours is its own section now, and
  // a switch row is the approved design's `.toggle-row`.
  await settingsPanel.locator('#set-quiet .toggle-row:has-text("Quiet hours") input').check();
  const quietEnabled = await settingsPanel.locator('#set-quiet input[type="time"]').first().isEnabled();
  ok("settings has notifications on/off and quiet hours that switch on",
    (await settingsPanel.locator('#set-notify .toggle-row:has-text("new messages") input').count()) === 1 && quietEnabled);
  await settingsPanel.locator('#set-quiet .toggle-row:has-text("Quiet hours") input').uncheck();

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
  await page.click('.rail-btn[data-go="settings"]');
  await page.waitForSelector("text=connect your AI apps");
  await page.screenshot({ path: `${SHOTS}/06-settings.png` });
  await page.click('.rail-btn[data-go="chat"]');

  // agent edit also lets you change which app an agent runs on
  await page.hover(".sidebar .agentrow");
  await page.click('.sidebar .agentrow button[title="Edit agent"]');
  await page.waitForSelector(".editor .app-pick");
  const editPicker = await page.$$eval(".app-pick", bs => bs.map(b => b.dataset.app));
  ok("agent edit offers a provider picker", editPicker.join(",") === "claude,codex", editPicker.join("/"));

  // ---- his 5+6: the model picker is in EDIT too, already holding a model ----
  await page.waitForSelector("select.modelpick");
  const editModels = await page.$$eval("select.modelpick option", os => os.map(o => o.value));
  const editModel = await page.inputValue("select.modelpick");
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

  await page.click(".skills .skill-add");
  await page.fill(".skill-name-input", skillA);
  await page.fill(".skill-desc-input", "Picks three villas and says why");
  await page.fill(".skill-instructions-input", "Read the villa notes, keep the three best under budget, and give a one-line reason for each.");
  await page.click(".skills .skill-save");
  await page.waitForSelector(`.skillrow[data-skill="${skillA}"]`);
  ok("a skill can be written in plain words and saved", true);

  await page.click(`.skillrow[data-skill="${skillA}"] .skill-edit`);
  await page.fill(".skill-name-input", skillB);
  await page.click(".skills .skill-save");
  await page.waitForSelector(`.skillrow[data-skill="${skillB}"]`);
  ok("a saved skill can be edited",
    (await page.locator(`.skillrow[data-skill="${skillA}"]`).count()) === 0);

  const skillFile = path.join(os.tmpdir(), `${skillC}.md`);
  fs.writeFileSync(skillFile, "Check the fare every morning and tell me when it drops below 8k.");
  await page.setInputFiles(".skills .skill-upload", skillFile);
  await page.waitForSelector(`.skillrow[data-skill="${skillC}"]`);
  await page.click(`.skillrow[data-skill="${skillC}"] .skill-edit`);
  await page.waitForSelector(".skill-instructions-input");
  const uploadedInstructions = await page.inputValue(".skill-instructions-input");
  const uploadedName = await page.inputValue(".skill-name-input");
  ok("a skill can be uploaded from a .md file (name from the filename, body as the instructions)",
    /fare every morning/.test(uploadedInstructions) && uploadedName === skillC,
    `${uploadedName} :: ${uploadedInstructions.slice(0, 50)}`);
  await page.click(".skills .skillformbtns button:has-text('Cancel')");

  await page.click(`.skillrow[data-skill="${skillC}"] .skill-delete`);
  ok("a skill can be deleted",
    (await page.locator(`.skillrow[data-skill="${skillC}"]`).count()) === 0 &&
    (await page.locator(`.skillrow[data-skill="${skillB}"]`).count()) === 1);
  await page.screenshot({ path: `${SHOTS}/14-agent-edit.png` });

  // the surviving skill must actually reach the agent
  await page.click('.editor .topbar >> text=Save');
  // wait for the editor to actually be gone (the save round-tripped), not 800ms
  await waitFor(page, () => !document.querySelector(".editor .skills"),
    undefined, { timeout: 20000, what: "the agent editor to close after Save" });
  await page.click('.rail-btn[data-go="chat"]');
  await page.hover(".sidebar .agentrow");
  await page.click('.sidebar .agentrow button[title="Edit agent"]');
  await page.waitForSelector(".editor .skills");
  ok("skills are saved onto the agent and are still there when you reopen it",
    (await page.locator(`.skillrow[data-skill="${skillB}"]`).count()) === 1);
  // put the agent back the way it was found
  await page.click(`.skillrow[data-skill="${skillB}"] .skill-delete`);
  await page.click('.editor .topbar >> text=Save');
  await page.waitForTimeout(400);
  await page.click('.rail-btn[data-go="chat"]');

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

  await page.click('.rail-btn[data-go="settings"]');
  await page.waitForSelector(".settingspanel");
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/design-settings.png`, fullPage: true });
  await page.click('.rail-btn[data-go="chat"]');

  await page.click('button[title="New agent"]');
  await page.waitForSelector("select.modelpick");
  await page.click(".skills .skill-add");
  await page.fill(".skill-name-input", "Weekly report");
  await page.fill(".skill-desc-input", "Writes the Monday summary of last week");
  await page.fill(".skill-instructions-input", "Read the last seven days of notes. Write five bullet points: what moved, what stalled, what needs me.");
  await page.click(".skills .skill-save");
  await page.waitForSelector('.skillrow[data-skill="Weekly report"]');
  // frame the shot so the app picker and the skills list are both in view
  await page.evaluate(() => document.querySelector(".editor .pick-apps")
    ?.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/design-new-agent.png`, fullPage: true });
  ok("the create screen shows the model picker and the skills editor together",
    (await page.locator("select.modelpick").count()) === 1 &&
    (await page.locator('.skillrow[data-skill="Weekly report"]').count()) === 1 &&
    (await page.locator(".skills .skill-add").count()) === 1);
  await page.click('.editor .topbar >> text=Cancel');
  await page.click('.rail-btn[data-go="chat"]');

  await page.keyboard.press("Control+k");
  await page.waitForSelector(".qc-input");
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/design-quickchat.png`, fullPage: true });
  await page.keyboard.press("Escape");

  // ---------- a message is set the way it was written ----------
  // The formatting buttons used to make a message look WORSE: they inserted
  // **stars** and the list printed them raw. These checks assert the shapes,
  // and — the one that matters — that a message can never become markup.
  const md = [
    "**bold words** and *italic* and `inline code`",
    "- first thing",
    "- second thing",
    "```js",
    "const x = 1;",
    "```",
    "> a quoted line",
    "<script>alert('xss')</script>",
    "https://example.com/page",
  ].join("\n");
  await box.fill(md);
  await box.press("Enter");
  const last = page.locator(".msg").last();
  await last.locator(".md strong").first().waitFor({ timeout: 8000 });

  ok("a message renders bold, italic and inline code",
    (await last.locator(".md strong").count()) > 0 &&
    (await last.locator(".md em").count()) > 0 &&
    (await last.locator("code.mdcode").count()) > 0);
  ok("a message renders lists, code blocks and quotes",
    (await last.locator("ul.mdlist li").count()) >= 2 &&
    (await last.locator("pre.mdpre code").count()) > 0 &&
    (await last.locator("blockquote.mdquote").count()) > 0);
  ok("a bare link becomes a safe link",
    (await last.locator('a.mdlink[href="https://example.com/page"]').count()) === 1 &&
    (await last.locator("a.mdlink").first().getAttribute("rel")).includes("noopener"));
  // The whole safety argument in one assertion: markdown renders to React
  // elements, never to HTML, so a script tag is the WORDS "<script>".
  const scriptTags = await page.locator(".msg script").count();
  const scriptShownAsText = (await last.textContent()).includes("<script>");
  ok("a script tag in a message stays text, and never becomes markup",
    scriptTags === 0 && scriptShownAsText, `script els=${scriptTags}`);
  await page.screenshot({ path: `${SHOTS}/chat-markdown.png`, fullPage: true });

  /* ================= CHAT BASICS — the renderer half =================
   * docs/plans/chat-basics-handoff.md. Every check below drives the real UI
   * against the real relay: scrollback, search, reactions, edit and delete,
   * threads, account-level unread, and who may set an agent working. */

  // ---------- a conversation longer than one page ----------
  await page.click('button[title="New channel"]');
  await page.fill('.panel input[placeholder="trip-goa"]', "backlog");
  await page.click(".panel .foot >> text=Create");
  await page.waitForSelector(".sidebar >> text=# backlog");
  await page.click("text=# backlog");
  const backlogBox = page.locator(".composer textarea");
  const LINES = 55; // more than one 50-message page, so paging is real
  for (let i = 1; i <= LINES; i++) {
    await backlogBox.fill(`backlog line ${i}`);
    await backlogBox.press("Enter");
  }
  await page.waitForSelector(`.msg:has-text("backlog line ${LINES}")`, { timeout: 30000 });

  // a reload is the honest starting point: the app knows only what the hub says
  await page.reload();
  await page.waitForSelector(".sidebar >> text=# backlog", { timeout: 20000 });
  await page.click("text=# backlog");
  await page.waitForSelector('.msg:has-text("backlog line 55")', { timeout: 20000 });
  await page.waitForTimeout(600);
  const firstPage = await page.locator(".msgs .msg").count();
  ok("a long conversation opens on its newest page, not the whole thing",
    firstPage <= 50 && firstPage >= 20 &&
    (await page.locator(".startofhistory").count()) === 0,
    `${firstPage} messages on screen`);

  // scrolling to the top asks for the page before — and must not move the
  // words under the reader's eyes
  const anchorBefore = await page.evaluate(() => {
    const el = document.querySelector(".msgs");
    const first = el.querySelector(".msg");
    el.scrollTop = 0;
    return { id: first?.dataset.msg, top: first?.getBoundingClientRect().top ?? 0 };
  });
  await waitFor(page, n => document.querySelectorAll(".msgs .msg").length > n, firstPage,
    { timeout: 20000, what: "older messages to be loaded when the top is reached" });
  await page.waitForTimeout(350);
  const anchorAfter = await page.evaluate(id => {
    const el = document.querySelector(`.msgs .msg[data-msg="${id}"]`);
    return el ? el.getBoundingClientRect().top : null;
  }, anchorBefore.id);
  ok("older messages load on scroll-up and the reader keeps their place",
    anchorAfter !== null && Math.abs(anchorAfter - anchorBefore.top) <= 2,
    `the message the reader was on moved ${anchorAfter === null ? "off screen" : Math.round(anchorAfter - anchorBefore.top)}px`);

  // keep going until the relay says there is nothing older — `hasMore`, never
  // "the page was short"
  for (let i = 0; i < 6 && (await page.locator(".startofhistory").count()) === 0; i++) {
    await page.evaluate(() => { document.querySelector(".msgs").scrollTop = 0; });
    await page.waitForTimeout(700);
  }
  const allLoaded = await page.locator(".msgs .msg").count();
  ok("the beginning of a conversation is said, once, and only when the hub says so",
    (await page.locator(".startofhistory").count()) === 1 && allLoaded >= LINES,
    `${allLoaded} of ${LINES} messages loaded`);
  await page.evaluate(() => { document.querySelector(".msgs").scrollTop = 0; });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/chat-scrollback.png` });
  await page.evaluate(() => {
    const el = document.querySelector(".msgs");
    el.scrollTop = el.scrollHeight;
  });

  // ---------- reactions ----------
  const lastBacklog = page.locator(".msgs .msg").last();
  await lastBacklog.hover();
  await lastBacklog.locator(".ma.react").click();
  await page.click('.reactpop button:has-text("👍")');
  await page.waitForSelector('.reactpill[data-emoji="👍"]', { timeout: 15000 });
  const pill = page.locator('.reactpill[data-emoji="👍"]').last();
  ok("a reaction can be added on hover, and says who reacted",
    (await pill.locator(".n").innerText()).trim() === "1" &&
    /You/.test(await pill.getAttribute("title")),
    (await pill.getAttribute("title")) ?? "");
  await page.screenshot({ path: `${SHOTS}/chat-reactions.png` });
  await pill.click();
  await waitFor(page, () => document.querySelectorAll('.reactpill[data-emoji="👍"]').length === 0,
    undefined, { timeout: 15000, what: "the reaction pill to go when the last person takes it back" });
  ok("clicking your own reaction takes it back and the pill goes", true);

  // ---------- edit and delete your own message ----------
  await backlogBox.fill("this line will be corrected");
  await backlogBox.press("Enter");
  const toEdit = page.locator('.msg:has-text("this line will be corrected")').last();
  await toEdit.waitFor({ timeout: 15000 });
  await toEdit.hover();
  await toEdit.locator(".ma.edit").click();
  await page.fill(".editmsg-input", "this line was corrected");
  await page.click(".editmsg-save");
  await page.waitForSelector('.msg:has-text("this line was corrected")', { timeout: 15000 });
  const edited = page.locator('.msg:has-text("this line was corrected")').last();
  ok("your own message can be changed, and says it was changed",
    (await edited.locator(".editedmark").count()) === 1 &&
    (await page.locator('.msg:has-text("this line will be corrected")').count()) === 0);
  await page.screenshot({ path: `${SHOTS}/chat-edited.png` });

  const beforeDelete = await page.locator(".msgs .msg").count();
  await edited.hover();
  await edited.locator(".ma.del").click();
  await edited.locator(".ma.yes").click();
  await page.waitForSelector(".msgs .msg.deleted .tombstone", { timeout: 15000 });
  const afterDelete = await page.locator(".msgs .msg").count();
  ok("a deleted message becomes a tombstone in place, never a hole",
    afterDelete === beforeDelete &&
    (await page.locator(".msgs .msg.deleted .msgactions").count()) === 0,
    `${beforeDelete} rows before, ${afterDelete} after`);
  await page.screenshot({ path: `${SHOTS}/chat-edit-delete.png` });

  // someone else's words are not yours to change
  await page.click(".sidebar >> text=# general");
  await page.waitForSelector(".msg p:has-text('Priya here')");
  const theirs = page.locator(".msg:has-text('Priya here')").last();
  await theirs.hover();
  ok("there is no edit or delete on a message you did not write",
    (await theirs.locator(".ma.edit").count()) === 0 &&
    (await theirs.locator(".ma.del").count()) === 0);

  // ---------- threads ----------
  await page.click(".sidebar >> text=# backlog");
  await backlogBox.fill("what should we do about the backlog?");
  await backlogBox.press("Enter");
  const root = page.locator('.msg:has-text("what should we do about the backlog?")').last();
  await root.waitFor({ timeout: 15000 });
  await root.hover();
  await root.locator(".ma.reply").click();
  await page.waitForSelector(".threadpanel", { timeout: 15000 });
  ok("a message can be replied to in a thread, and the thread opens beside it",
    (await page.locator(".threadpanel .msg").count()) >= 1);

  await page.fill(".threadcomposer textarea", "cut it in half");
  await page.press(".threadcomposer textarea", "Enter");
  await page.waitForSelector('.threadpanel .msg:has-text("cut it in half")', { timeout: 20000 });
  await page.waitForSelector(".threadline", { timeout: 20000 });
  const replyLine = (await page.locator(".threadline").last().innerText()).replace(/\s+/g, " ");
  ok("a reply lands in the thread and the message it answers says how many replies it has",
    /1 reply/.test(replyLine), replyLine);
  await page.screenshot({ path: `${SHOTS}/chat-thread.png` });

  await page.click(".threadpanel .threadclose");
  await page.waitForSelector(".threadpanel", { state: "detached", timeout: 10000 });
  await page.locator(".threadline").last().click();
  await page.waitForSelector(".threadpanel", { timeout: 15000 });
  ok("the reply count opens the thread, with the message it started and every reply",
    (await page.locator(".threadpanel .msg").count()) === 2,
    `${await page.locator(".threadpanel .msg").count()} messages in the panel`);
  await page.click(".threadpanel .threadclose");

  // ---------- search across everything ----------
  await page.evaluate(() => window.cloud9Menu.run("search"));
  await page.waitForSelector(".searchpanel", { timeout: 10000 });
  ok("search opens from the menu and looks across everything, not one room", true);
  await page.fill(".search-input", "backlog");
  await page.waitForSelector(".searchhit", { timeout: 20000 });
  await page.waitForTimeout(400);
  const groups = await page.locator(".searchgroup").count();
  const firstHit = page.locator(".searchhit").first();
  const hitText = (await firstHit.innerText()).replace(/\s+/g, " ");
  ok("results are grouped by conversation, with who said it, when, and the words around it",
    groups >= 1 &&
    (await firstHit.locator(".hitwho b").count()) === 1 &&
    (await firstHit.locator(".hitwho .t").count()) === 1 &&
    (await page.locator(".searchhit .snippet mark").count()) >= 1,
    `${groups} group(s) :: ${hitText.slice(0, 80)}`);
  await page.screenshot({ path: `${SHOTS}/chat-search.png` });

  // a result is a way BACK to the message, in its own conversation
  const wantedId = await page.locator(".searchhit").first().getAttribute("data-hit");
  await page.locator(".searchhit").first().click();
  await page.waitForSelector(`.msgs .msg[data-msg="${wantedId}"].litup`, { timeout: 25000 });
  ok("clicking a result goes to that message, in the conversation it was said in", true);
  await page.screenshot({ path: `${SHOTS}/chat-search-jump.png` });

  // ---------- unread, from the account and not from this browser ----------
  await page.evaluate(() => localStorage.setItem("cloud9.lastRead", '{"c":1}'));
  await page.reload();
  await page.waitForSelector(".sidebar >> text=# general", { timeout: 20000 });
  ok("the old per-machine read state is deleted on start — the hub owns it now",
    (await page.evaluate(() => localStorage.getItem("cloud9.lastRead"))) === null);

  await page.click(".sidebar >> text=# backlog");
  await page.waitForTimeout(500);
  await fpage.click("text=# general");
  await fpage.fill(".composer textarea", "@Vikas can you look at this when you get a moment?");
  await fpage.press(".composer textarea", "Enter");
  await page.waitForSelector('.side-item[data-channel="general"] .cnt.hot', { timeout: 25000 });
  ok("a message you have not seen is counted, and one that asks for you is marked apart",
    (await page.locator('.side-item[data-channel="general"] .cnt.at').count()) === 1,
    (await page.locator('.side-item[data-channel="general"]').innerText()).replace(/\s+/g, " "));
  await page.screenshot({ path: `${SHOTS}/chat-unread.png` });

  await page.click(".sidebar >> text=# general");
  await waitFor(page, () =>
    document.querySelectorAll('.side-item[data-channel="general"] .cnt').length === 0,
  undefined, { timeout: 20000, what: "the unread marks to clear once the room is read" });
  ok("reading the conversation clears the marks", true);

  // ---------- who may set an agent working ----------
  await page.hover(".sidebar .agentrow");
  await page.click('.sidebar .agentrow button[title="Edit agent"]');
  await page.waitForSelector(".whocanuse", { timeout: 15000 });
  const respondOptions = await page.$$eval(".respondpick", bs => bs.map(b => b.dataset.respond));
  const respondChosen = await page.$eval('.respondpick[aria-pressed="true"]', b => b.dataset.respond);
  ok("the agent editor asks who may use this agent, and starts closed",
    respondOptions.join(",") === "owner,allowlist,anyone" && respondChosen === "owner",
    `${respondOptions.join("/")} chosen=${respondChosen}`);

  await page.click('.respondpick[data-respond="allowlist"]');
  await page.waitForSelector(".allowpick .allowrow", { timeout: 10000 });
  ok("choosing “me and these people” offers the people to choose",
    (await page.locator('.allowpick .allowrow[data-person="Priya"]').count()) === 1);
  await page.evaluate(() => document.querySelector(".whocanuse")?.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/chat-agent-permission.png` });
  await page.click('.allowpick .allowrow[data-person="Priya"] input');
  await page.click('.editor .topbar >> text=Save');
  await page.waitForSelector(".crew-grid", { timeout: 20000 });
  await page.locator('.cast[data-crew="Scout"] .whocan').filter({ hasText: "other person" })
    .waitFor({ timeout: 20000 });
  const crewSays = (await page.locator('.cast[data-crew="Scout"] .whocan').innerText()).replace(/\s+/g, " ");
  ok("the crew card says, in plain words, who may set this agent working",
    /1 other person/.test(crewSays), crewSays);
  await page.evaluate(() =>
    document.querySelector('.cast[data-crew="Scout"] .whocan')?.scrollIntoView({ block: "center" }));
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/chat-crew-permission.png` });

  // put it back to owner-only, and prove the closed default is visible to the
  // person it shuts out
  await page.click('.cast[data-crew="Scout"] button:has-text("Edit")');
  await page.waitForSelector(".whocanuse", { timeout: 15000 });
  await page.click('.respondpick[data-respond="owner"]');
  await page.click('.editor .topbar >> text=Save');
  await page.waitForSelector(".crew-grid", { timeout: 20000 });
  // the save has to ROUND-TRIP through the hub before the card can be believed —
  // reading the card the instant the screen appears reads the old answer
  await page.locator('.cast[data-crew="Scout"] .whocan').filter({ hasText: "Only you" })
    .waitFor({ timeout: 20000 });
  ok("the choice is saved on the agent and is there when you open it again",
    /Only you/.test((await page.locator('.cast[data-crew="Scout"] .whocan').innerText())),
    (await page.locator('.cast[data-crew="Scout"] .whocan').innerText()).replace(/\s+/g, " "));

  await fpage.fill(".composer textarea", "@Scout could you find me a villa too?");
  await fpage.press(".composer textarea", "Enter");
  await fpage.waitForSelector('.mentionrefused[data-agent="Scout"]', { timeout: 25000 });
  ok("an agent that will not answer you says so, instead of silently doing nothing",
    /only answers/.test(await fpage.locator('.mentionrefused[data-agent="Scout"]').innerText()),
    (await fpage.locator('.mentionrefused[data-agent="Scout"]').innerText()).trim());
  await fpage.screenshot({ path: `${SHOTS}/chat-mention-refused.png` });

  /* ================= FILES ON A MESSAGE (handoff §9) =================
   * The whole journey, on screen and over the wire: pick a file, watch it go
   * up, send it, see it on the message, open it, and — the part that is not
   * inferrable from a link appearing — fetch the bytes back and compare them
   * to what was sent. */
  await page.click('.rail-btn[data-go="chat"]');
  await page.click('button[title="New channel"]');
  await page.fill('.panel input[placeholder="trip-goa"]', "paperwork");
  await page.click(".panel .foot >> text=Create");
  await page.waitForSelector(".sidebar >> text=# paperwork");
  await page.click("text=# paperwork");
  await page.waitForSelector('.chathead .ch-title .n:text-is("paperwork")', { timeout: 15000 });

  ok("the composer offers a way to attach a file",
    (await page.locator(".composer .mini.attach").count()) === 1 &&
    (await page.locator(".composer input.filepick").count()) === 1);

  // a real PNG, not a token one: a file worth a byte-for-byte comparison
  const PICTURE = pngOfSolidColour(180, 120, [18, 83, 71]);
  const LEDGER = Buffer.from("row,amount\nvilla,7400\nflights,5200\n", "utf8");

  await page.setInputFiles(".composer input.filepick", {
    name: "site-plan.png", mimeType: "image/png", buffer: PICTURE,
  });
  await page.waitForSelector('.uploadtray .uptile[data-upload="site-plan.png"].done', { timeout: 20000 });
  ok("a picked file goes up and says it is ready to send",
    /ready to send/.test(await page.locator('.uptile[data-upload="site-plan.png"] .meta').innerText()),
    (await page.locator('.uptile[data-upload="site-plan.png"] .meta').innerText()).trim());

  await page.setInputFiles(".composer input.filepick", {
    name: "ledger.bin", mimeType: "application/octet-stream", buffer: LEDGER,
  });
  await page.waitForSelector('.uploadtray .uptile[data-upload="ledger.bin"].done', { timeout: 20000 });

  // a name the hub would refuse is refused HERE, in the hub's own sentence,
  // before the bytes are ever read — and it is said, never swallowed
  await page.setInputFiles(".composer input.filepick", {
    name: "bad name!.png", mimeType: "image/png", buffer: PICTURE,
  });
  await page.waitForSelector('.uploadtray .uptile.failed', { timeout: 15000 });
  const refusedSays = (await page.locator(".uploadtray .uptile.failed .meta").innerText()).trim();
  ok("a file the hub would refuse is refused in the composer, in plain words",
    /file name isn't allowed/.test(refusedSays), refusedSays);
  await page.screenshot({ path: `${SHOTS}/files-composer.png` });

  // a refused file can be taken back off, and the ones that landed stay
  await page.click('.uploadtray .uptile.failed .upx');
  await waitFor(page, () => document.querySelectorAll(".uploadtray .uptile.failed").length === 0,
    undefined, { timeout: 10000, what: "the refused file to be taken off the message" });
  ok("a file can be taken back off the message before it is sent",
    (await page.locator(".uploadtray .uptile").count()) === 2);

  const sendSays = (await page.locator(".composer .primary.small").innerText()).trim();
  ok("the send button says how many files are going with the message",
    /2 files/.test(sendSays), sendSays);

  await page.fill(".composer textarea", "here is the site plan and the ledger");
  await page.click(".composer .primary.small");
  await page.waitForSelector('.msg .fileblock[data-file="site-plan.png"]', { timeout: 20000 });
  ok("a message carries its files, each with its name and its size",
    (await page.locator(".msg .fileblock").count()) === 2 &&
    /KB|bytes/.test(await page.locator('.fileblock[data-file="site-plan.png"] .meta').innerText()),
    (await page.locator('.fileblock[data-file="site-plan.png"] .meta').innerText()).trim());

  ok("the tray is empty once the files have gone",
    (await page.locator(".composer .uploadtray").count()) === 0);

  // what may be shown in place and what may only be saved is the HUB's answer,
  // never the sender's — a picture offers "Show", anything else offers "Save"
  ok("a picture offers to be shown in place and a file offers to be saved",
    (await page.locator('.fileblock[data-file="site-plan.png"] .fileopen').innerText()).trim() === "Show" &&
    (await page.locator('.fileblock[data-file="ledger.bin"] .fileopen').innerText()).trim() === "Save");

  const pictureId = await page.getAttribute('.fileblock[data-file="site-plan.png"]', "data-attachment");

  /* ---- the bytes, fetched back over the real HTTP path ----
   * The ticket is minted through the app's own path, then redeemed from here.
   * Two things are proved that a screenshot cannot prove: the file that comes
   * back IS the file that went up, and the ticket dies on first use. */
  const ticket = await page.evaluate(id => window.cloud9Files.ticket(id), pictureId);
  const served = await fetch(ticket.url);
  const gotBytes = Buffer.from(await served.arrayBuffer());
  ok("the file fetched back off the hub is byte-for-byte the file that was sent",
    served.status === 200 && gotBytes.length === PICTURE.length && gotBytes.equals(PICTURE),
    `${served.status} · sent ${PICTURE.length} bytes, got ${gotBytes.length}`);
  ok("the hub decides the type from the name, and tells the browser not to sniff",
    served.headers.get("content-type") === "image/png" &&
    served.headers.get("x-content-type-options") === "nosniff" &&
    /inline/.test(served.headers.get("content-disposition") ?? ""),
    `${served.headers.get("content-type")} · ${served.headers.get("content-disposition")}`);
  const replayed = await fetch(ticket.url);
  ok("a ticket is spent by the first request — a second one is refused",
    replayed.status === 404 &&
    /that link has expired/.test(await replayed.text()), `status ${replayed.status}`);

  // and a file that is NOT a picture is handed over as bytes with a download
  const ledgerId = await page.getAttribute('.fileblock[data-file="ledger.bin"]', "data-attachment");
  const ledgerTicket = await page.evaluate(id => window.cloud9Files.ticket(id), ledgerId);
  const ledgerServed = await fetch(ledgerTicket.url);
  const ledgerBytes = Buffer.from(await ledgerServed.arrayBuffer());
  ok("a file the hub will not draw comes back as bytes with a download, unchanged",
    ledgerBytes.equals(LEDGER) &&
    ledgerServed.headers.get("content-type") === "application/octet-stream" &&
    /attachment/.test(ledgerServed.headers.get("content-disposition") ?? ""),
    `${ledgerServed.headers.get("content-type")} · ${ledgerServed.headers.get("content-disposition")}`);

  // ---- and the same journey through the buttons a person actually presses ----
  await page.click('.fileblock[data-file="site-plan.png"] .fileopen');
  await page.waitForSelector('.fileblock[data-file="site-plan.png"] .fileshot img', { timeout: 20000 });
  const drawn = await page.evaluate(() => {
    const img = document.querySelector('.fileblock[data-file="site-plan.png"] .fileshot img');
    return { w: img.naturalWidth, h: img.naturalHeight, src: img.src.slice(0, 5) };
  });
  ok("clicking a picture opens it in place, with the picture really loaded",
    drawn.w === 180 && drawn.h === 120, JSON.stringify(drawn));
  await page.screenshot({ path: `${SHOTS}/files-message.png` });

  ok("an opened file is held for this screen, so a second look does not re-ticket",
    (await page.evaluate(() => window.cloud9Files.opened())).includes(pictureId));

  // leaving the conversation lets every opened file go — a screen that opened a
  // hundred pictures and never freed them would be holding a hundred pictures
  await page.click(".sidebar >> text=# general");
  await page.waitForTimeout(400);
  ok("opened files are let go when the message leaves the screen",
    (await page.evaluate(() => window.cloud9Files.opened())).length === 0);
  await page.click(".sidebar >> text=# paperwork");
  await page.waitForSelector('.msg .fileblock[data-file="site-plan.png"]', { timeout: 15000 });

  /* ================= ROOMS ARE REAL THINGS (handoff §10) ================= */

  // ---- the details panel: what it's for, who's in it, how it's run ----
  await page.click(".chathead .roomdetailsbtn");
  await page.waitForSelector(".roompanel", { timeout: 15000 });
  await page.waitForSelector(".roommembers .memberrow", { timeout: 15000 });
  const myRow = page.locator('.roommembers .memberrow[data-member="Vikas"]');
  ok("the room panel lists who is in the room, with their role and when they joined",
    (await myRow.count()) === 1 &&
    (await myRow.locator(".rolename").getAttribute("data-role")) === "owner" &&
    /joined /.test(await myRow.locator(".rl").innerText()),
    (await myRow.locator(".rl").innerText()).replace(/\s+/g, " "));

  await page.click(".roominfo-edit");
  await page.fill(".roomdesc-input", "Everything that has to be filed for the trip");
  await page.fill(".roomtopic-input", "back on the 14th");
  await page.click(".roominfo-save");
  await waitFor(page, () => /back on the 14th/.test(
    document.querySelector(".roompanel .roomtopic")?.textContent ?? ""),
  undefined, { timeout: 20000, what: "the room's own words to come back from the hub" });
  ok("a room's description and one-line topic can be set, and come back from the hub",
    /has to be filed/.test(await page.locator(".roompanel .roomdesc").innerText()) &&
    /back on the 14th/.test(await page.locator(".roompanel .roomtopic").innerText()));
  ok("the topic is shown beside the room's name, where it is about today",
    /back on the 14th/.test(await page.locator(".chathead .ch-topic").innerText()));
  await page.screenshot({ path: `${SHOTS}/rooms-details.png` });

  // ---- a room is private until somebody opens it, and it SAYS which ----
  ok("a room says at a glance that it is private, in the header and in the sidebar",
    (await page.locator('.chathead .roomvis[data-vis="private"]').count()) === 1 &&
    (await page.locator('.sidebar .side-item[data-channel="paperwork"][data-vis="private"]').count()) === 1);

  // ---- browse: nothing to join while every room is shut ----
  await fpage.click(".sidebar .browserooms");
  await fpage.waitForSelector(".browsepanel", { timeout: 15000 });
  await fpage.waitForSelector(".browsepanel .browseempty, .browsepanel .roomcard", { timeout: 20000 });
  const emptySays = (await fpage.locator(".browsepanel .browseempty").innerText()).replace(/\s+/g, " ").trim();
  ok("with every room shut, browsing says so — and says why, in the hub's own words",
    emptySays === "No open rooms to join. Rooms are private unless someone opens them.", emptySays);
  await fpage.screenshot({ path: `${SHOTS}/rooms-browse-empty.png` });
  await fpage.click('.browsepanel .foot button:has-text("Done")');

  // ---- the owner opens one ----
  await page.click('.roomcontrols .segbtn[data-vis="open"]');
  await waitFor(page, () => document.querySelector('.chathead .roomvis[data-vis="open"]') !== null,
    undefined, { timeout: 20000, what: "the room to come back from the hub as an open one" });
  ok("opening a room to anyone here is said in the header and on the sidebar row",
    (await page.locator('.chathead .roomvis[data-vis="open"]').count()) === 1 &&
    (await page.locator('.sidebar .side-item[data-channel="paperwork"][data-vis="open"]').count()) === 1);
  await page.screenshot({ path: `${SHOTS}/rooms-open.png` });

  // ---- and now it can be found and joined, with no members and no messages on offer ----
  await fpage.click(".sidebar .browserooms");
  await fpage.waitForSelector('.browsepanel .roomcard[data-room="paperwork"]', { timeout: 20000 });
  const card = fpage.locator('.browsepanel .roomcard[data-room="paperwork"]');
  ok("an open room can be found by somebody who is not in it, with what it's for and how many are in it",
    /has to be filed/.test(await card.locator(".rc-desc").innerText()) &&
    /1 person/.test(await card.locator(".rc-count").innerText()),
    (await card.locator(".rc-count").innerText()).trim());
  ok("browsing offers no members and no messages — finding a room is not permission to read it",
    (await fpage.locator(".browsepanel .msg").count()) === 0 &&
    (await fpage.locator(".browsepanel .mini-agent").count()) === 0);
  await fpage.screenshot({ path: `${SHOTS}/rooms-browse.png` });

  await card.locator(".roomjoin").click();
  await fpage.waitForSelector('.sidebar .side-item[data-channel="paperwork"]', { timeout: 20000 });
  await fpage.waitForSelector('.msg p:has-text("site plan and the ledger")', { timeout: 20000 });
  ok("joining an open room lets you in and hands over what was said in it", true);
  await fpage.screenshot({ path: `${SHOTS}/rooms-joined.png` });

  // a plain member is shown the room, and not the controls they may not use
  await fpage.click(".chathead .roomdetailsbtn");
  await fpage.waitForSelector(".roompanel .roomnotyours", { timeout: 20000 });
  ok("somebody who does not run the room is told so, instead of being offered a dead button",
    (await fpage.locator(".roompanel .roomarchive").count()) === 0 &&
    (await fpage.locator(".roompanel .segbtn").count()) === 0 &&
    (await fpage.locator(".roompanel .roomleave").count()) === 1);
  const joinedRow = fpage.locator('.roommembers .memberrow[data-member="Priya"]');
  ok("letting yourself into an open room is recorded as exactly that — nobody added you",
    (await joinedRow.locator(".rolename").getAttribute("data-role")) === "member" &&
    !/added by/.test(await joinedRow.locator(".rl").innerText()),
    (await joinedRow.locator(".rl").innerText()).replace(/\s+/g, " "));

  // ---- leaving takes the room, and everything cached for it, away ----
  await fpage.click(".roompanel .roomleave");
  await fpage.click(".roompanel .roomleave-yes");
  await waitFor(fpage, () =>
    document.querySelectorAll('.sidebar .side-item[data-channel="paperwork"]').length === 0,
  undefined, { timeout: 20000, what: "the room to go from the sidebar when you leave it" });
  ok("leaving a room takes it out of the sidebar, there and then", true);

  // ---- archived: readable, and nothing new ----
  await page.click(".roomarchive");
  await waitFor(page, () => document.querySelector(".composer-box.readonly") !== null,
    undefined, { timeout: 20000, what: "the composer to be replaced once the room is archived" });
  const archivedSays = (await page.locator(".composer-box.readonly .ro-say").innerText()).trim();
  ok("an archived room replaces the composer with the hub's own sentence, word for word",
    archivedSays === "that conversation is archived — nothing new can be said in it", archivedSays);
  ok("an archived room is greyed in the sidebar and marked archived in the header",
    (await page.locator('.sidebar .side-item[data-channel="paperwork"].is-archived').count()) === 1 &&
    (await page.locator('.chathead .roomvis[data-vis="archived"]').count()) === 1);
  await page.hover(".msgs .msg >> nth=0");
  await page.waitForTimeout(250);
  ok("an archived room offers nothing that would put something new in it",
    (await page.locator(".msgs .msgactions").count()) === 0 &&
    (await page.locator(".chathead select").count()) === 0);
  ok("an archived room still reads all the way down — the words and the files stay",
    (await page.locator('.msg .fileblock[data-file="site-plan.png"]').count()) === 1 &&
    (await page.locator(".msgs .msg").count()) > 0);
  await page.screenshot({ path: `${SHOTS}/rooms-archived.png` });

  // ---- and it is a state, not an epitaph ----
  await page.click(".roomarchive");
  await waitFor(page, () => document.querySelector(".composer textarea") !== null,
    undefined, { timeout: 20000, what: "the composer to come back when the room is reopened" });
  ok("reopening an archived room gives it back, exactly as it was",
    (await page.locator(".composer-box.readonly").count()) === 0 &&
    (await page.locator('.sidebar .side-item[data-channel="paperwork"].is-archived').count()) === 0);

  // ---- the details panel must not push the page sideways either ----
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(220);
      const over = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      ok(`the room-details panel does not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.screenshot({ path: `${SHOTS}/rooms-details-${theme}.png` });
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  // the files on a message must not either — a long name is the usual culprit
  await page.click(".roompanel .roomclose");
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(220);
      const over = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      ok(`files on a message do not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.screenshot({ path: `${SHOTS}/files-message-${theme}.png` });
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  // ---------- nothing new scrolls sideways, in either look ----------
  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# backlog");
  await page.locator(".threadline").last().click();
  await page.waitForSelector(".threadpanel", { timeout: 15000 });
  const overflow = async () => page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(200);
      const over = await overflow();
      ok(`a thread beside the conversation does not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.screenshot({ path: `${SHOTS}/chat-thread-${theme}.png` });
      }
    }
  }
  await page.evaluate(() => window.cloud9Menu.run("search"));
  await page.waitForSelector(".searchpanel", { timeout: 10000 });
  await page.fill(".search-input", "backlog");
  await page.waitForSelector(".searchhit", { timeout: 20000 });
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(200);
      const over = await overflow();
      ok(`search results do not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.screenshot({ path: `${SHOTS}/chat-search-${theme}.png` });
      }
    }
  }
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

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
