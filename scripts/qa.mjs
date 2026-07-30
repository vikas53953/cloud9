import { chromium } from "playwright";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  assertHarnessIsHonest, qaOwnerToken, qaTarget, reportAndExit, signInAsOwner, waitFor,
  waitForAgentReply,
} from "./qa-target.mjs";
// The screen shows `summarizeRun`'s sentence VERBATIM, so the check that it did
// has to be able to say the sentence itself. Imported from the same package the
// app imports, never re-spelled here.
// The size ceilings are the HUB's numbers. The screen reads them from this
// package and so does this suite, so a check can never agree with a number the
// renderer made up on its own.
import { ATTACHMENT_LIMITS, humanMoney, summarizeRun } from "@cloud9/shared";
// THE LADDER AND THE TABLE, from the engine that owns them. Every count below
// is derived, never typed: a ninth capability or a fifth rung moves this suite
// with it instead of leaving a number here that used to be right.
import {
  abilitiesForReach, CAPABILITIES, REACH_LEVELS,
} from "@cloud9/engine/dist/abilities.js";
import { isolationFor } from "@cloud9/engine/dist/isolation.js";

/**
 * EVERYTHING ONE AGENT EDITOR PUTS IN FRONT OF HIM.
 *
 * The point of reading it as one object is the comparison it makes possible:
 * a role hired from the catalogue must offer EXACTLY this, field for field,
 * against an agent he typed out himself. He reported that it did not — no tool
 * permissions, no files folder, no skills — and the only check that can hold
 * that shut for good is one that compares the two screens rather than looking
 * for three things by name.
 */
const editorOffers = page => page.evaluate(() => ({
  sections: [...document.querySelectorAll(".editor .form-col > section h3")]
    .map(h => h.innerText.trim()),
  rungs: [...document.querySelectorAll(".editor .reachrung")].map(b => b.dataset.reach),
  abilities: [...document.querySelectorAll(".editor .abilitypick .toggle-row")]
    .map(r => r.dataset.ability),
  approvals: [...document.querySelectorAll(".editor .asksec .panelbox .toggle-row .tx b")]
    .map(b => b.innerText.trim()),
  whoCanUse: [...document.querySelectorAll(".editor .respondpick")].map(b => b.dataset.respond),
  skillsEditor: document.querySelectorAll(".editor .skills").length,
  skillButtons: [...document.querySelectorAll(".editor .skillhead button")]
    .map(b => b.innerText.trim()),
  honestReport: document.querySelectorAll(".editor .harnesshonest").length,
  namePlate: document.querySelectorAll(".editor .preview-card .plate .portrait svg").length,
}));

/**
 * The drawing of one portrait, so two screens can be held to the same face.
 *
 * The gradient's id is unique per render (React's `useId`), and it is the one
 * thing in there that is allowed to differ — so it is normalised out. Without
 * that, this would compare two identical drawings and call them different.
 */
const portraitOf = async (page, sel) =>
  (await page.$eval(sel, el => el.innerHTML)).replace(/plate-[A-Za-z0-9_:-]+/g, "PLATE");

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
const EXPECTED_CHECKS = 305;
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

  /* ---- A HOLD ON ONE KIND OF ANSWER FROM THE HUB ----------------------------
   *
   * Two of the findings below can only be PROVED by catching the app in a state
   * that lasts a fraction of a second: one file on the wire and unanswered, with
   * a second already read and queued behind it. The suite used to try to catch
   * it by racing — pick a big file, then spin waiting for the moment to come
   * round. On a hub that answered quickly the moment had already gone, and the
   * check failed on a run where nothing whatsoever was wrong. Worse, the failure
   * cascaded: with no refusal ever provoked there was no toast to read, and the
   * whole run died on a 30-second timeout with 70 checks never executed.
   *
   * So the moment is HELD OPEN instead of chased. `__c9hold.hold(["attachment"])`
   * makes the browser keep the hub's answers to uploads in a queue until
   * `release()` hands them over, in the order they arrived. Nothing in the app is
   * stubbed or stood in for: every frame the hub sends is still delivered, to the
   * app's own handler, unchanged and in order — the only thing this decides is
   * WHEN. That turns "if the hub happens to be slow" into a state the app is
   * simply in, which is what the checks then wait on.
   *
   * It also matches the real ordering the bug needs: a refusal about something
   * else is a small, fast answer, so on a busy hub it genuinely does arrive
   * before the upload it got mistakenly pinned on. */
  await owner.addInitScript(() => {
    const Real = window.WebSocket;
    const gate = { types: [], held: [] };
    window.__c9hold = {
      hold: types => { gate.types = types; gate.held = []; },
      holding: () => gate.held.length,
      release: () => {
        gate.types = [];
        const queued = gate.held.splice(0);
        for (const deliver of queued) deliver();
        return queued.length;
      },
    };
    class Gated extends Real {
      constructor(...args) {
        super(...args);
        let mine = null;
        // the app assigns `ws.onmessage`; this instance property shadows the
        // native one, so every frame comes through here first
        Object.defineProperty(this, "onmessage", {
          configurable: true,
          get: () => mine,
          set: fn => { mine = fn; },
        });
        Real.prototype.addEventListener.call(this, "message", ev => {
          const deliver = () => { if (mine) mine.call(this, ev); };
          let type = "";
          try { type = JSON.parse(ev.data).type; } catch { /* not a frame we know */ }
          if (gate.types.includes(type)) gate.held.push(deliver);
          else deliver();
        });
      }
    }
    window.WebSocket = Gated;
  });

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
  await page.waitForSelector(".threadpanel", { state: "detached", timeout: 10000 });

  /* ================= WHAT HE COULD NOT FIND ================================
   *
   * Threads were all there — a panel, reply counts, a `replyTo` on the wire —
   * and he still said they were missing, because every reply was ALSO posted
   * into the room. A thread that changes nothing about the room is a thread
   * nobody can see. So: with threads on, a reply is NOT a row in the
   * conversation. That is the check.
   */
  const rowsInRoom = async () => page.evaluate(() => [...document.querySelectorAll(".msgs .msg")]
    .map(m => (m.querySelector(".body")?.innerText ?? "").replace(/\s+/g, " ")));
  const roomRows = await rowsInRoom();
  ok("with threads on, a reply is kept in its thread and is NOT a row in the conversation",
    roomRows.some(t => /what should we do about the backlog/.test(t)) &&
    !roomRows.some(t => /cut it in half/.test(t)),
    `${roomRows.length} row(s) in the room`);

  /* The door to a thread used to be an unlabelled ↳ among five other glyphs,
     revealed only on hover. It carries the word now. */
  await root.hover();
  ok("the way into a thread is a control that says Reply, not a bare glyph",
    /reply/i.test((await root.locator(".ma.reply").innerText()).trim()),
    (await root.locator(".ma.reply").innerText()).replace(/\s+/g, " "));
  await page.screenshot({ path: `${SHOTS}/thread-channel.png` });

  /* ---- and the setting he asked for, which must CHANGE the behaviour ---- */
  await page.evaluate(() => window.cloud9Menu.run("settings"));
  await page.waitForSelector("#set-replies", { timeout: 15000 });
  const replyChoices = await page.$$eval(".repliespick", bs => bs.map(b => ({
    value: b.dataset.replies,
    words: b.innerText.replace(/\s+/g, " ").trim(),
  })));
  ok("Settings offers the two ways a reply can behave, and says plainly what each one does",
    replyChoices.length === 2 &&
    replyChoices[0].value === "thread" && replyChoices[1].value === "inline" &&
    /reply count/i.test(replyChoices[0].words) &&
    /does not appear in the conversation/i.test(replyChoices[0].words) &&
    /straight into the conversation/i.test(replyChoices[1].words) &&
    /no thread opens/i.test(replyChoices[1].words),
    replyChoices.map(c => `${c.value}: ${c.words.slice(0, 60)}`).join(" | "));
  ok("threads is what it starts on — the behaviour he is comparing it against",
    (await page.$eval('.repliespick[aria-pressed="true"]', b => b.dataset.replies)) === "thread");
  await page.screenshot({ path: `${SHOTS}/thread-setting.png` });

  // KEEP IT IN THE CONVERSATION — the reply comes back into the room…
  await page.click('.repliespick[data-replies="inline"]');
  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# backlog");
  await page.waitForSelector('.msgs .msg:has-text("cut it in half")', { timeout: 15000 });
  const inlineRows = await rowsInRoom();
  ok("choosing “keep it in the conversation” really does put the reply back in the room",
    inlineRows.some(t => /cut it in half/.test(t)), `${inlineRows.length} row(s) in the room`);
  ok("and it says which message it is answering, instead of just appearing",
    (await page.locator('.msg:has-text("cut it in half") .answeringmark').count()) === 1,
    (await page.locator('.msg:has-text("cut it in half") .answeringmark').innerText()).replace(/\s+/g, " "));
  ok("no thread pill is offered when threads are off — there is nothing to open",
    (await page.locator(".threadline").count()) === 0);

  // …and Reply now aims the room's own box instead of opening a panel
  const inlineRoot = page.locator('.msgs .msg:has-text("what should we do about the backlog?")').last();
  await inlineRoot.hover();
  await inlineRoot.locator(".ma.reply").click();
  await page.waitForSelector(".answeringbar", { timeout: 10000 });
  ok("with threads off, Reply aims the conversation's own box and opens no thread at all",
    (await page.locator(".threadpanel").count()) === 0 &&
    (await page.locator(".answeringbar").count()) === 1,
    (await page.locator(".answeringbar").innerText()).replace(/\s+/g, " "));
  await page.fill(".thread .composer textarea", "and ship the rest next week");
  await page.press(".thread .composer textarea", "Enter");
  await page.waitForSelector('.msgs .msg:has-text("ship the rest next week")', { timeout: 20000 });
  ok("a reply written that way lands in the conversation, under the message it answers",
    (await page.locator('.msgs .msg:has-text("ship the rest next week") .answeringmark').count()) === 1 &&
    (await page.locator(".answeringbar").count()) === 0);
  await page.screenshot({ path: `${SHOTS}/thread-inline.png` });

  // put it back, and prove the room goes quiet again
  await page.evaluate(() => window.cloud9Menu.run("settings"));
  await page.waitForSelector("#set-replies", { timeout: 15000 });
  await page.click('.repliespick[data-replies="thread"]');
  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# backlog");
  await waitFor(page, () => ![...document.querySelectorAll(".msgs .msg")]
    .some(m => /cut it in half/.test(m.textContent ?? "")),
  undefined, { timeout: 20000, what: "the replies to leave the conversation again" });
  const backRows = await rowsInRoom();
  ok("switching back to threads takes the replies out of the conversation again",
    !backRows.some(t => /cut it in half/.test(t)) &&
    !backRows.some(t => /ship the rest next week/.test(t)) &&
    (await page.locator(".threadline").count()) >= 1,
    `${backRows.length} row(s), ${await page.locator(".threadline").count()} reply pill(s)`);
  await page.locator(".threadline").last().click();
  await page.waitForSelector(".threadpanel", { timeout: 15000 });
  ok("and every reply written either way is in the thread, none of them lost",
    (await page.locator(".threadpanel .msg").count()) === 3,
    `${await page.locator(".threadpanel .msg").count()} messages in the panel`);
  await page.screenshot({ path: `${SHOTS}/thread-panel.png` });
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

  /* ================= THE REACH LADDER (capability-handoff.md 4.1-4.3) =======
   *
   * WHAT WAS WRONG. The engine grew a full ladder — from "just talk" up to
   * everything Claude Code and Codex can do on his PC — and the agent editor
   * still showed the same four checkboxes it always had. He said so himself:
   * "I told you last night." The switches that let an agent run a program on
   * his computer existed, were enforced, and were unreachable from any screen.
   *
   * Every number in these checks is read from `@cloud9/engine`, so the suite
   * cannot agree with a screen that has quietly drifted from the table.
   */
  await page.click('.rail-btn[data-go="crew"]');
  await page.waitForSelector(".crew-bar", { timeout: 15000 });
  await page.click('.cast[data-crew="Scout"] button:has-text("Edit")');
  await page.waitForSelector(".editor .reachladder", { timeout: 20000 });

  const rungs = await page.$$eval(".editor .reachrung", bs => bs.map(b => ({
    level: b.dataset.reach,
    label: b.querySelector(".rr-tx b")?.innerText.trim() ?? "",
    plain: b.querySelector(".rr-tx span")?.innerText.trim() ?? "",
    count: b.querySelector(".rr-count")?.innerText.trim() ?? "",
  })));
  ok("the agent editor leads with the whole ladder the engine offers, not four checkboxes",
    rungs.length === REACH_LEVELS.length &&
    rungs.every((r, i) => r.level === REACH_LEVELS[i].level && r.label === REACH_LEVELS[i].label),
    rungs.map(r => r.level).join(" → "));
  ok("every rung says in his words what it means for his computer",
    rungs.every((r, i) => r.plain === REACH_LEVELS[i].plainWords),
    rungs.find((r, i) => r.plain !== REACH_LEVELS[i].plainWords)?.level ?? "all match");
  ok("the top rung is offered as a thing he can pick, not hidden behind a warning",
    rungs[rungs.length - 1].level === "computer" &&
    /Everything this app can do on this computer/.test(rungs[rungs.length - 1].label),
    rungs[rungs.length - 1].label);

  const abilityRows = () => page.$$eval(".editor .abilitypick .toggle-row", rs => rs.map(r => ({
    ability: r.dataset.ability,
    label: r.querySelector(".tx b")?.innerText.trim() ?? "",
    on: r.querySelector("input")?.checked === true,
  })));
  /* Open the one-by-one list once, deliberately, and leave it open: it is his
     disclosure, and nothing in the ladder re-decides it under him. */
  const openSwitches = async () => {
    if ((await page.getAttribute(".editor .abilitypick", "data-open")) !== "yes") {
      await page.click(".editor .abilityshow");
    }
    await page.waitForSelector('.editor .abilitypick[data-open="yes"]', { timeout: 10000 });
  };
  await openSwitches();
  const rows = await abilityRows();
  ok("every power the engine's table owns has a switch on this screen, in the same order",
    rows.length === CAPABILITIES.length &&
    rows.every((r, i) => r.ability === CAPABILITIES[i].ability),
    `${rows.length} rows: ${rows.map(r => r.ability).join(", ")}`);
  ok("each switch is named in his words, never with a tool name",
    rows.every((r, i) => r.label.startsWith(CAPABILITIES[i].label)) &&
    !/Bash|PowerShell|WebFetch|MCP/.test(rows.map(r => r.label).join(" ")),
    rows.map(r => r.label).join(" | "));
  ok("the powers that change his machine or spend money are marked as asking first",
    CAPABILITIES.filter(c => c.alwaysAsk).every((c, _i) =>
      rows.find(r => r.ability === c.ability)?.label.includes("asks you first")) &&
    CAPABILITIES.filter(c => !c.alwaysAsk).every(c =>
      !rows.find(r => r.ability === c.ability)?.label.includes("asks you first")),
    rows.filter(r => r.label.includes("asks you first")).map(r => r.ability).join(", "));

  // ---- a rung really is a prefix of the table, in both directions ----
  await page.locator('.editor .reachrung[data-reach="computer"]').click();
  const atTop = await abilityRows();
  ok("picking the top rung really hands over every power the engine has",
    atTop.every(r => r.on) && atTop.length === CAPABILITIES.length,
    atTop.filter(r => !r.on).map(r => r.ability).join(", ") || "all on");
  ok("and the ladder then reads as the top rung",
    (await page.getAttribute(".editor .reachladder", "data-reach")) === "computer" &&
    (await page.locator('.editor .reachrung[data-reach="computer"]').getAttribute("aria-pressed")) === "true");
  /* HONESTY IN THE OTHER DIRECTION. Two of those powers are wired in the engine
     and inert until he can choose a folder list and a service, and there is
     nowhere to choose either yet. A switch that is ON and hands the agent
     nothing must say so, or it reads as broken and every other switch is
     doubted with it. */
  ok("a power that is on and still grants nothing today admits it, rather than looking broken",
    (await page.locator(".editor .inertswitch").count()) === 1 &&
    (await page.locator('.editor .inertswitch [data-inert-row="wholeComputer"]').count()) === 1 &&
    (await page.locator('.editor .inertswitch [data-inert-row="connections"]').count()) === 1,
    (await page.locator(".editor .inertswitch").innerText()).replace(/\s+/g, " ").slice(0, 110));
  await page.screenshot({ path: `${SHOTS}/reach-top.png` });

  // ---- what will ask first, and that it is NOT something he can clear ----
  const asksList = () => page.$$eval(".editor .willask li", ls => ls.map(l => l.dataset.ask));
  const shownAsks = await asksList();
  ok("with the top rung on, the screen names exactly the powers that will stop and ask him",
    JSON.stringify(shownAsks) ===
      JSON.stringify(CAPABILITIES.filter(c => c.alwaysAsk).map(c => c.label)),
    shownAsks.join(" / "));
  ok("and those are stated, never offered as switches he could clear",
    (await page.locator(".editor .willask input").count()) === 0 &&
    /not switches/i.test(await page.locator(".editor .willask .wa-note").innerText()));
  ok("the two approvals that really are his choice stay editable",
    (await page.locator(".editor .asksec .panelbox .toggle-row input").count()) === 2);
  await page.locator(".editor .willask").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/reach-asks.png` });

  await page.locator('.editor .reachrung[data-reach="talk"]').click();
  const atBottom = await abilityRows();
  ok("and with nothing switched on, nothing claims to be inert either",
    (await page.locator(".editor .inertswitch").count()) === 0);
  ok("picking the bottom rung takes every one of them back",
    atBottom.every(r => !r.on),
    atBottom.filter(r => r.on).map(r => r.ability).join(", ") || "all off");
  ok("and nothing then claims it will ask him about anything",
    (await page.locator(".editor .willask").count()) === 0);

  // ---- a hand-picked mix is never rounded UP ----
  await page.locator('.editor .reachrung[data-reach="look"]').click();
  await openSwitches();
  await page.locator('.editor .toggle-row[data-ability="commands"] input').check();
  ok("a mix that adds a power without the rungs beneath it is NOT rounded up to that rung",
    (await page.getAttribute(".editor .reachladder", "data-reach")) === "look",
    `reads as ${await page.getAttribute(".editor .reachladder", "data-reach")}`);
  ok("and the screen says out loud that this is his own mix, and which rung it covers",
    (await page.locator(".editor .reachmixed").count()) === 1 &&
    /Look things up and keep notes/.test(await page.locator(".editor .reachmixed").innerText()),
    (await page.locator(".editor .reachmixed").innerText()).replace(/\s+/g, " "));
  ok("switching one power on is enough to make the screen promise he will be asked",
    (await asksList()).includes("Run programs on this computer"),
    (await asksList()).join(" / "));
  await page.locator(".editor .reachladder").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/reach-ladder.png` });

  /* ---- the honest report: how high the switches go, and whether they hold ---- */
  const claudeIso = isolationFor("claude");
  const codexIso = isolationFor("codex");
  ok("the screen says how high these switches GO, not only what they keep out",
    (await page.locator('.editor .harnesshonest [data-field="ceiling"]').innerText()).trim()
      === claudeIso.ceiling,
    (await page.locator('.editor .harnesshonest [data-field="ceiling"]').innerText()).trim().slice(0, 70));
  ok("a Claude agent is told the switches really are the whole boundary",
    (await page.getAttribute(".editor .harnesshonest", "data-boundary")) === "yes" &&
    (await page.locator('.editor .harnesshonest [data-field="headline"]').innerText()).trim()
      === claudeIso.headline);
  await page.locator(".editor .harnesshonest").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/reach-honest-claude.png` });

  await page.click('.editor .app-pick[data-app="codex"]');
  await page.waitForSelector('.editor .harnesshonest[data-boundary="no"]', { timeout: 10000 });
  ok("and a Codex agent is NOT — the same screen refuses to tell him the same story twice",
    (await page.locator('.editor .harnesshonest [data-field="headline"]').innerText()).trim()
      === codexIso.headline,
    (await page.locator('.editor .harnesshonest [data-field="headline"]').innerText()).trim().slice(0, 70));
  ok("it says instead what those switches DO control on Codex",
    new RegExp(codexIso.togglesControl.split(":")[0]).test(
      await page.locator('.editor .harnesshonest [data-field="controls"]').innerText()));
  await page.locator(".editor .harnesshonest .hh-more summary").click();
  ok("everything Codex keeps hold of anyway is named, one line each",
    (await page.locator(".editor .honestleaks li").count()) === codexIso.stillLoaded.length,
    `${await page.locator(".editor .honestleaks li").count()} of ${codexIso.stillLoaded.length}`);
  ok("and what we looked at and could not settle is kept apart from it, under its own heading",
    (await page.locator(".editor .honestunknowns li").count()) === codexIso.unknowns.length &&
    /could not tell/i.test(await page.locator(".editor .harnesshonest .hh-more").innerText()),
    `${await page.locator(".editor .honestunknowns li").count()} unknown(s)`);
  /* textContent, not innerText: the line is set in small caps by the stylesheet
     and innerText hands back what the CSS did, not what the engine said. */
  ok("the report carries the version and date it was measured on, so a stale claim shows",
    (await page.locator(".editor .hh-measured").textContent()).includes(codexIso.measuredOn),
    (await page.locator(".editor .hh-measured").textContent()).trim());
  await page.locator(".editor .harnesshonest").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/reach-honest-codex.png` });

  /* WHAT A HAND-MADE AGENT'S EDITOR OFFERS — held for the comparison below.
     Nothing typed here is saved: the editor is left with Cancel. */
  const handMadeOffers = await editorOffers(page);
  ok("a hand-written agent's file offers the ladder, the switches, who may use it, and skills",
    handMadeOffers.rungs.length === REACH_LEVELS.length &&
    handMadeOffers.abilities.length === CAPABILITIES.length &&
    handMadeOffers.skillsEditor === 1 && handMadeOffers.honestReport === 1,
    JSON.stringify(handMadeOffers.sections));
  await page.click(".editor .topbar >> text=Cancel");
  await page.waitForSelector(".crew-grid", { timeout: 20000 });

  /* ================= THE CASTING ROOM (the marketplace) =====================
   *
   * A catalogue that ships INSIDE the app: no server, no download. The things
   * that make it a product rather than a list — you can get to it from where
   * you already go to add an agent, the brief is real, a role looks like a
   * person, and what you hire is an ordinary agent in every respect — are each
   * checked, and hiring is done for real, against the hub.
   */
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector(".sidebar", { timeout: 15000 });
  ok("the casting room is reachable from where he already goes to add an agent",
    (await page.locator(".sidebar .side-head .browsebtn.tomarket").count()) === 1,
    (await page.getAttribute(".sidebar .side-head .browsebtn.tomarket", "aria-label")) ?? "");
  ok("and nothing on screen calls it a hiring hall any more",
    !/hiring hall/i.test(await page.locator("body").innerText()),
    (await page.getAttribute(".sidebar .side-head .browsebtn.tomarket", "aria-label")) ?? "");
  await page.click('.rail-btn[data-go="crew"]');
  await page.waitForSelector(".crew-bar", { timeout: 15000 });
  ok("and from the crew screen",
    (await page.locator(".crew-bar .tomarket").count()) === 1 &&
    /casting room/i.test(await page.locator(".crew-bar .tomarket").innerText()),
    (await page.locator(".crew-bar .tomarket").innerText()).trim());
  await page.click(".crew-bar .tomarket");
  await page.waitForSelector(".market .cast.role", { timeout: 15000 });

  const roles = await page.$$eval(".market .cast.role", cards => cards.map(c => ({
    id: c.dataset.role,
    title: c.querySelector("h3")?.innerText.trim() ?? "",
    tagline: c.querySelector(".role")?.innerText.trim() ?? "",
    asks: c.querySelectorAll(".roleasks li").length,
    app: c.querySelector(".runs .chip")?.innerText.trim() ?? "",
  })));
  const wantedRoles = ["architect", "backend", "frontend", "qa", "security", "devops", "reviewer", "writer"];
  ok("the software roles he asked for are all in the catalogue",
    wantedRoles.every(r => roles.some(c => c.id === `sw-${r}`)),
    roles.map(r => r.id).join(", "));
  ok("every role says what it is for, what to ask it, and which app suits it",
    roles.length >= 8 && roles.every(r => r.title && r.tagline.length > 20 && r.asks >= 3
      && /^Suggested: (Claude|Codex)$/.test(r.app)),
    JSON.stringify(roles.find(r => !r.title || r.tagline.length <= 20 || r.asks < 3) ?? "all complete"));
  ok("the catalogue is grouped by category, so a second category is data and not a redesign",
    (await page.locator('.market .marketgroup[data-group="software"]').count()) === 1 &&
    (await page.locator('.market .seg button[data-cat]').count()) >= 1);
  /* A ROLE LOOKS LIKE A PERSON. Static emoji was a placeholder that never
     became anybody; a role now wears the same drawn-from-the-name portrait an
     agent gets, on the same square plate, so the picture he chooses by is the
     picture his crew shows him afterwards. */
  ok("every role in the catalogue wears a drawn portrait, and no emoji face is left",
    (await page.locator(".market .cast.role .plate.roleplate .portrait svg").count()) === roles.length &&
    (await page.locator(".market .roleface").count()) === 0,
    `${await page.locator(".market .cast.role .plate.roleplate .portrait svg").count()} portraits`);
  const hallFace = await portraitOf(page,
    '.market .cast.role[data-role="sw-architect"] .roleplate .portrait svg');
  await page.screenshot({ path: `${SHOTS}/hall-roles.png` });
  await page.screenshot({ path: `${SHOTS}/market-hall.png` });

  // the brief itself — the product, not filler
  await page.click('.market .cast.role[data-role="sw-architect"] .rolesee');
  await page.waitForSelector(".hirepanel", { timeout: 15000 });
  const brief = (await page.locator(".hirepanel .briefbox").innerText()).trim();
  ok("the brief he is hiring is shown in full, in the agent's own words",
    brief.length > 400 && /^You are my software architect/.test(brief),
    `${brief.length} characters`);
  ok("the panel says what the hire may touch, and that it stops and asks first",
    (await page.locator(".hirepanel .abilitywords .chip").count()) >= 1 &&
    /asks you first/i.test(await page.locator(".hirepanel .abilitywords .ab-note").first().innerText()));
  ok("a hire answers only its owner, the same default a hand-written agent gets",
    /Just you/.test(await page.locator(".hirepanel .field-row:has-text('Who can set them working')").innerText()));
  ok("he picks which app runs it, and from his app's real model list",
    (await page.locator(".hirepanel .hireapp").count()) === 1 &&
    (await page.locator(".hirepanel .hiremodel option").count()) >= 1,
    `${await page.locator(".hirepanel .hiremodel option").count()} models offered`);
  ok("the panel he hires from wears the face the agent will really be hired with",
    (await page.locator(".hirepanel .hireface .portrait svg").count()) === 1);
  await page.screenshot({ path: `${SHOTS}/market-brief.png` });
  await page.screenshot({ path: `${SHOTS}/hall-brief.png` });

  // hire it, for real, on Codex — and prove what landed
  await page.selectOption(".hirepanel .hireapp", "codex");
  const hireModel = await page.locator(".hirepanel .hiremodel").inputValue();
  await page.click(".hirepanel .hirebtn");
  /* HIS COMPLAINT, AND THE FIX FOR IT. He hired the Architect and reported it
     had no tool permissions, no files folder and no skills. All three were
     there — one click away, behind a note on the crew screen telling him to
     press Edit, which he had no reason to do. A role he has just taken on now
     opens ITS OWN FILE, so everything a hand-written agent has is the first
     thing he sees rather than something he has to go and find. */
  await page.waitForSelector(".editor .reachladder", { timeout: 25000 });
  ok("hiring opens the new agent's own file, instead of telling him to go and press Edit",
    (await page.locator('.editor .hirednote[data-hired="Architect"]').count()) === 1 &&
    (await page.locator(".editor .topbar h2").innerText()).trim() === "Architect",
    (await page.locator(".editor .hirednote").innerText()).replace(/\s+/g, " ").slice(0, 80));

  const hiredOffers = await editorOffers(page);
  ok("A HIRED AGENT'S FILE OFFERS EXACTLY WHAT A HAND-WRITTEN ONE'S DOES — nothing less",
    JSON.stringify(hiredOffers) === JSON.stringify(handMadeOffers),
    JSON.stringify(hiredOffers) === JSON.stringify(handMadeOffers)
      ? `${hiredOffers.sections.length} sections, ${hiredOffers.rungs.length} rungs, ` +
        `${hiredOffers.abilities.length} switches, skills editor present`
      : `hired ${JSON.stringify(hiredOffers)} vs hand-made ${JSON.stringify(handMadeOffers)}`);
  await openSwitches();
  ok("and the three he could not find are each on that screen, by name",
    (await page.locator('.editor .toggle-row[data-ability="files"]').count()) === 1 &&
    (await page.locator(".editor .abilitypick .toggle-row").count()) === CAPABILITIES.length &&
    (await page.locator(".editor .skills").count()) === 1);
  ok("a hired role starts no more powerful than a hand-written agent plus what its brief asked for",
    (await page.locator('.editor .toggle-row[data-ability="commands"] input').isChecked()) === false &&
    (await page.locator('.editor .toggle-row[data-ability="wholeComputer"] input').isChecked()) === false,
    `reads as ${await page.getAttribute(".editor .reachladder", "data-reach")}`);
  const hiredPersona = await page.locator(".editor .persona-input").inputValue();
  ok("the brief really was copied onto the agent, word for word",
    hiredPersona.trim() === brief, `${hiredPersona.length} characters on the agent`);
  ok("the model he picked was saved on the agent too",
    (await page.locator(".editor .modelpick").inputValue()) === hireModel,
    `${await page.locator(".editor .modelpick").inputValue()} (picked ${hireModel})`);
  const editorFace = await portraitOf(page, ".editor .preview-card .plate .portrait svg");
  ok("the face on the role card is the face the agent now wears — the same drawing",
    editorFace === hallFace);
  await page.screenshot({ path: `${SHOTS}/hall-hired-editor.png` });
  await page.locator(".editor .reachladder").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/hall-hired-reach.png` });

  // …and it is genuinely editable, not a locked template
  await page.fill(".editor .persona-input", `${hiredPersona}\n\nAlways answer in British English.`);
  await page.click('.editor .topbar >> text=Save');
  await page.waitForSelector(".crew-grid", { timeout: 20000 });
  ok("hiring copies the role onto his floor as one of his own agents",
    (await page.locator('.cast[data-crew="Architect"]').count()) === 1);
  ok("and it runs on the app he chose, not the one the catalogue suggested",
    /Codex/.test(await page.locator('.cast[data-crew="Architect"] .runs').innerText()),
    (await page.locator('.cast[data-crew="Architect"] .runs').innerText()).replace(/\s+/g, " "));
  ok("the crew screen says the hire is his to change",
    (await page.locator('.hirednote[data-hired="Architect"]').count()) === 1,
    (await page.locator(".hirednote").innerText()).replace(/\s+/g, " ").slice(0, 90));
  ok("a hire is owner-only, exactly like an agent he wrote himself",
    /Only you/.test(await page.locator('.cast[data-crew="Architect"] .whocan').innerText()),
    (await page.locator('.cast[data-crew="Architect"] .whocan').innerText()).replace(/\s+/g, " "));
  ok("and the crew shows the very same picture the casting room showed",
    (await portraitOf(page, '.cast[data-crew="Architect"] .plate .portrait svg')) === hallFace);
  await page.screenshot({ path: `${SHOTS}/market-hired.png` });
  await page.screenshot({ path: `${SHOTS}/hall-crew.png` });

  await page.click('.cast[data-crew="Architect"] button:has-text("Edit")');
  await page.waitForSelector(".editor .persona-input", { timeout: 15000 });
  ok("and every word of it can be changed afterwards — the change survives the hub",
    /Always answer in British English\.$/.test(
      (await page.locator(".editor .persona-input").inputValue()).trim()),
    (await page.locator(".editor .persona-input").inputValue()).trim().slice(-40));
  await page.screenshot({ path: `${SHOTS}/market-editable.png` });
  await page.click(".editor >> text=← Crew");
  await page.waitForSelector(".crew-grid", { timeout: 20000 });

  /* ================= CAN THIS AGENT ACTUALLY BE USED RIGHT NOW? ============
   *
   * HIS BUG, IN HIS WORDS: "every agent shows offline." The hub was taught to
   * work the answer out from what it genuinely observes and to send a plain
   * sentence saying why — and none of it reached the screen. An agent row was
   * a name and a pencil.
   *
   * The rule these checks hold shut: the word, the dot and the reason are ONE
   * fact from ONE place, and an agent nobody has reported on is never drawn as
   * if all were well.
   */
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector(".sidebar .agentrow", { timeout: 20000 });
  const rowState = pg => pg.$$eval(".sidebar .agentrow", rs => rs.map(r => ({
    agent: r.dataset.agent,
    presence: r.dataset.presence,
    word: r.querySelector(".an-state b")?.innerText.trim() ?? "",
    why: (r.querySelector(".an-state")?.innerText ?? "").replace(/\s+/g, " ").trim(),
    dot: [...(r.querySelector(".pdot")?.classList ?? [])].find(c => c.startsWith("p-")) ?? "",
  })));
  const mine = await rowState(page);
  const WORDS = { ready: "Ready", working: "Working", paused: "Paused", offline: "Offline" };
  ok("every agent row on screen carries a presence, and it is one the hub can actually say",
    mine.length >= 2 && mine.every(r => ["ready", "working", "paused", "offline"].includes(r.presence)),
    mine.map(r => `${r.agent}=${r.presence}`).join(", "));
  ok("the row says the state in words, not only as a colour",
    mine.every(r => r.word === WORDS[r.presence]),
    mine.map(r => `${r.agent}:${r.word}`).join(", "));
  ok("and it says WHY, in a plain sentence",
    mine.every(r => r.why.length > r.word.length + 3),
    mine.map(r => r.why).join(" | "));
  ok("the dot and the word can never disagree — they are drawn from the same one field",
    mine.every(r => r.dot === `p-${r.presence}`),
    mine.map(r => `${r.agent}:${r.dot}`).join(", "));
  await page.screenshot({ path: `${SHOTS}/presence-sidebar.png` });

  // ---- the conversation says the same thing the rail says ----
  await page.click('.sidebar .agentrow[data-agent="Scout"] .agentmain');
  await page.waitForSelector(".dm-head .presencehere", { timeout: 20000 });
  const inHead = await page.evaluate(() => {
    const el = document.querySelector(".dm-head .presencehere");
    return {
      presence: el.dataset.presence,
      word: el.querySelector("b").innerText.trim(),
      why: el.querySelector(".ph-why").innerText.trim(),
    };
  });
  const scoutRow = (await rowState(page)).find(r => r.agent === "Scout");
  ok("the conversation header says the same state as the rail, and the reason with it",
    inHead.presence === scoutRow.presence && inHead.word === scoutRow.word &&
    scoutRow.why.endsWith(inHead.why),
    `${inHead.word} — ${inHead.why}`);
  await page.screenshot({ path: `${SHOTS}/presence-conversation.png` });

  // ---- paused is a real answer, and it is the owner's own doing ----
  await page.click('.rail-btn[data-go="crew"]');
  await page.waitForSelector(".crew-grid", { timeout: 20000 });
  await page.click('.cast[data-crew="Architect"] button:has-text("Edit")');
  await page.waitForSelector(".editor .lifecyclepick", { timeout: 20000 });
  await page.selectOption(".editor .lifecyclepick", "paused");
  await page.click('.editor .topbar >> text=Save');
  await page.waitForSelector('.crew-grid .cast[data-crew="Architect"][data-presence="paused"]',
    { timeout: 25000 });
  ok("pausing an agent is shown as paused, with the owner's own doing given as the reason",
    /Paused — paused by its owner/.test(
      await page.locator('.cast[data-crew="Architect"] .nowpresence').innerText()),
    (await page.locator('.cast[data-crew="Architect"] .nowpresence').innerText()).replace(/\s+/g, " "));
  ok("and the crew card's pill says it too, rather than leaving a green dot behind",
    (await page.locator('.cast[data-crew="Architect"] .presencepill').innerText()).trim() === "Paused" &&
    (await page.locator('.cast[data-crew="Architect"] .presencepill .pdot.p-ready').count()) === 0);
  await page.screenshot({ path: `${SHOTS}/presence-paused.png` });
  ok("the Off duty filter finds it by that state, not by guessing from the record",
    await (async () => {
      await page.click('.crew-bar .seg >> text=Off duty');
      await page.waitForTimeout(300);
      return (await page.locator('.crew-grid .cast[data-crew="Architect"]').count()) === 1;
    })());
  await page.click('.crew-bar .seg >> text=Everyone');

  // put it back, and prove the screen follows
  await page.click('.cast[data-crew="Architect"] button:has-text("Edit")');
  await page.waitForSelector(".editor .lifecyclepick", { timeout: 20000 });
  await page.selectOption(".editor .lifecyclepick", "enabled");
  await page.click('.editor .topbar >> text=Save');
  await page.waitForSelector('.crew-grid .cast[data-crew="Architect"][data-presence="ready"]',
    { timeout: 25000 });
  ok("un-pausing puts it back to ready on screen, without a reload",
    (await page.locator('.cast[data-crew="Architect"] .presencepill').innerText()).trim() === "Ready");

  /* ---- AN AGENT NOBODY CAN RUN SAYS SO, AND SAYS WHY ----
     "Offline" is the answer the hub gives whenever nobody could run this agent
     if they tried — no engine, no signed-in app, or switched off by its owner.
     Switching one off is the one of those three a QA run can cause on purpose
     without lying about the machine, so that is the one driven here: it goes
     down the same branch and must come back with a REASON and a hollow dot,
     never the green one. */
  await page.click('.cast[data-crew="Architect"] button:has-text("Edit")');
  await page.waitForSelector(".editor .lifecyclepick", { timeout: 20000 });
  await page.selectOption(".editor .lifecyclepick", "disabled");
  await page.click('.editor .topbar >> text=Save');
  await page.waitForSelector('.crew-grid .cast[data-crew="Architect"][data-presence="offline"]',
    { timeout: 25000 });
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector('.sidebar .agentrow[data-agent="Architect"][data-presence="offline"]',
    { timeout: 20000 });
  const dead = (await rowState(page)).find(r => r.agent === "Architect");
  ok("an agent nobody can run reads Offline, with the honest reason — never a green dot",
    !!dead && dead.presence === "offline" && dead.dot === "p-offline" &&
    /switched off by its owner/.test(dead.why),
    dead ? dead.why : "(Architect not on screen)");
  await page.screenshot({ path: `${SHOTS}/presence-offline.png` });
  await page.click('.rail-btn[data-go="crew"]');
  await page.waitForSelector(".crew-grid", { timeout: 20000 });
  await page.click('.cast[data-crew="Architect"] button:has-text("Edit")');
  await page.waitForSelector(".editor .lifecyclepick", { timeout: 20000 });
  await page.selectOption(".editor .lifecyclepick", "enabled");
  await page.click('.editor .topbar >> text=Save');
  await page.waitForSelector('.crew-grid .cast[data-crew="Architect"][data-presence="ready"]',
    { timeout: 25000 });
  ok("switching it back on is enough — the screen follows the hub, not a reload",
    (await page.locator('.cast[data-crew="Architect"] .presencepill').innerText()).trim() === "Ready");
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector(".sidebar", { timeout: 20000 });
  await page.click('.sidebar .side-item[data-channel="general"]');
  await page.waitForSelector(".composer textarea", { timeout: 20000 });

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

  /* ---- what is sitting unsent, in the hub's own numbers (handoff §11.5) ----
     The ceiling on parked files is per PERSON and is enforced by the hub. The
     screen must be able to say it BEFORE somebody hits it, and must say the
     same number the hub holds — so this check compares what is on screen with
     the constant imported from `@cloud9/shared`, never with a number typed
     here. A renderer that restated "50 MB" by hand would fail the day the hub
     moved it. */
  const parkedSaid = await page.$eval(".composer .parked", el => ({
    held: Number(el.dataset.parked),
    max: Number(el.dataset.parkedMax),
    text: el.innerText.replace(/\s+/g, " ").trim(),
  }));
  const parkedMB = `${Math.round(ATTACHMENT_LIMITS.parkedBytesPerUser / 100_000) / 10} MB`;
  const parkedHours = `${Math.round(ATTACHMENT_LIMITS.parkedTtlMs / 3_600_000)} hours`;
  ok("the composer says how much is waiting to be sent, against the ceiling the hub itself holds",
    parkedSaid.max === ATTACHMENT_LIMITS.parkedBytesPerUser &&
    parkedSaid.held === PICTURE.length + LEDGER.length &&
    parkedSaid.text.includes(`of ${parkedMB}`) &&
    parkedSaid.text.includes(parkedHours),
    `${parkedSaid.text} :: held=${parkedSaid.held} max=${parkedSaid.max}`);
  await page.screenshot({ path: `${SHOTS}/room-files-waiting.png` });

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

  /* ---- ONE ROUTE TO A FILE, and this is the run that proves it ----
     The screen is served on :4173 and the hub answers on :8799, so every fetch
     below really is cross-origin. There used to be a second code path for
     exactly this case, because the hub sent no CORS header and the page could
     not read its own answer; the header is there now and the branch is gone.
     A `blob:` source is the evidence: only the fetch → blob route can produce
     one, so if the old handing-the-ticket-to-the-img shortcut were still in
     use this check would fail. */
  const origins = await page.evaluate(() => ({
    screen: location.origin,
    hub: new URL((new URLSearchParams(location.search).get("relay") ?? "").replace(/^ws/, "http")).origin,
  }));
  ok("the screen and the hub really are on different addresses, so the next check means something",
    !!origins.hub && origins.screen !== origins.hub, `${origins.screen} vs ${origins.hub}`);
  ok("a picture takes the one intended route — fetched, held as a blob, freed on close",
    drawn.src === "blob:", `img src begins "${drawn.src}"`);

  // and saving still hands the file to the browser's own download path
  const saving = page.waitForEvent("download", { timeout: 20000 });
  await page.click('.fileblock[data-file="ledger.bin"] .fileopen');
  const saved = await saving;
  ok("saving a file still hands it to the browser, under its own name",
    saved.suggestedFilename() === "ledger.bin", saved.suggestedFilename());

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
  /* Kept for the membership-history check further down: leaving and coming back
     writes a SECOND row, and the only way to prove the screen did not fold the
     two into one is to know what the first one said. */
  const priyaFirstJoin = Number(await joinedRow.getAttribute("data-joined"));
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

  /* ============ WHO CAN READ THIS ROOM (handoff §11.2, §11.3, §11.6) ============

     The review reproduced this end to end: an ordinary member added SOMEBODY
     ELSE'S AGENT to a private room, and because an agent counts as its owner
     for visibility, that owner silently gained the room's entire history — with
     NOTHING ON SCREEN to say a person had been let in. The hub refuses that
     now. These checks are the other half of the fix: that the screen says who
     can read the room, and that the control which lets somebody in is offered
     by ROLE and not to whoever happens to be looking. */

  // Priya hires an agent of her own, so the room can be asked the exact
  // question the review asked.
  await fpage.click('button[title="New agent"]');
  await fpage.fill('input[placeholder="Scout"]', "Bramble");
  await fpage.fill("textarea.persona-input",
    "You keep the trip paperwork tidy and say what is still to file");
  await fpage.click(".editor >> text=Create agent");
  await fpage.click('.rail-btn[data-go="chat"]');
  await fpage.waitForSelector('.sidebar .agentrow[data-agent="Bramble"]', { timeout: 20000 });
  ok("a friend can hire an agent of their own", true);

  // ---- the control that lets somebody in is offered BY ROLE ----
  const addOptions = () => page.$$eval(".chathead .addmember option", os => os.map(o => ({
    id: o.value,
    text: (o.textContent ?? "").replace(/\s+/g, " ").trim(),
    disabled: o.disabled,
    why: o.dataset.why ?? "",
  })));
  await page.waitForSelector(".chathead .addmember", { timeout: 20000 });
  ok("the person who runs the room is offered the way to let somebody in",
    (await page.locator(".chathead .addmember").count()) === 1);

  const shutOut = await addOptions();
  const brambleShut = shutOut.find(o => /Bramble/.test(o.text));
  ok("an agent whose owner is not in this room is offered greyed, with the reason, before the click",
    !!brambleShut && brambleShut.disabled && /Priya isn't in this room/.test(brambleShut.why),
    JSON.stringify(brambleShut ?? null));
  const scoutOption = shutOut.find(o => /Scout/.test(o.text));
  ok("the picker says whose each agent is, and who admitting it would let in",
    !!scoutOption && !scoutOption.disabled && /Your agent/.test(scoutOption.text),
    scoutOption?.text ?? "(no Scout option)");

  /* The owner's own agent goes in first, so the list below holds one of each:
     an agent that tells the reader nothing new, and an agent that tells them
     somebody else is now reading the room. */
  await page.selectOption(".chathead .addmember", scoutOption.id);
  await page.waitForSelector('.roommembers .memberrow[data-member="Scout"]', { timeout: 25000 });

  // ---- Priya comes back into the room, so her agent may be admitted ----
  await fpage.click(".sidebar .browserooms");
  await fpage.waitForSelector('.browsepanel .roomcard[data-room="paperwork"]', { timeout: 20000 });
  await fpage.locator('.browsepanel .roomcard[data-room="paperwork"] .roomjoin').click();
  await fpage.waitForSelector('.sidebar .side-item[data-channel="paperwork"]', { timeout: 20000 });

  await waitFor(page, () => {
    const sel = document.querySelector(".chathead .addmember");
    return !!sel && [...sel.options].some(o => /Bramble/.test(o.textContent ?? "") && !o.disabled);
  }, undefined, { timeout: 25000, what: "the picker to notice Priya is back in the room" });
  const nowOffered = (await addOptions()).find(o => /Bramble/.test(o.text));
  ok("once its owner is in the room the agent can be added — and the picker names the person it lets in",
    !!nowOffered && !nowOffered.disabled && /Priya's agent/.test(nowOffered.text) &&
    /Priya can read it/.test(nowOffered.text),
    nowOffered?.text ?? "(no Bramble option)");

  // ---- and now the thing whose ABSENCE made the breach invisible ----
  await page.selectOption(".chathead .addmember", nowOffered.id);
  await page.waitForSelector('.roommembers .memberrow[data-member="Bramble"]', { timeout: 25000 });
  const ownerSeesBramble = page.locator('.roommembers .memberrow[data-member="Bramble"]');
  ok("an agent in a member list names its OWNER, so reading the list tells you who can see the room",
    (await ownerSeesBramble.locator(".agentowner").getAttribute("data-owner")) === "Priya" &&
    /Priya's agent/.test(await ownerSeesBramble.locator(".agentowner .whose").innerText()) &&
    /Priya can read this room/i.test(await ownerSeesBramble.locator(".agentowner .readsroom").innerText()),
    (await ownerSeesBramble.locator(".agentowner").innerText()).replace(/\s+/g, " ").trim());
  const ownScout = page.locator('.roommembers .memberrow[data-member="Scout"] .agentowner');
  ok("your own agent is named as yours in the same place, so the two are told apart at a glance",
    (await ownScout.getAttribute("data-mine")) === "yes" &&
    /Your agent/.test(await ownScout.locator(".whose").innerText()),
    (await ownScout.innerText()).replace(/\s+/g, " ").trim());
  await page.screenshot({ path: `${SHOTS}/room-members-owner.png` });

  // the right rail says it too — an agent is a room participant wherever it is drawn
  await page.click(".roompanel .roomclose");
  await page.waitForSelector('.aside .mini-agent[data-agent="Bramble"]', { timeout: 20000 });
  const railBramble = page.locator('.aside .mini-agent[data-agent="Bramble"] .agentowner');
  ok("the same is said in the rail beside the conversation, not only in the details panel",
    (await railBramble.getAttribute("data-owner")) === "Priya" &&
    /Priya can read this room/i.test(await railBramble.locator(".readsroom").innerText()),
    (await railBramble.innerText()).replace(/\s+/g, " ").trim());
  await page.screenshot({ path: `${SHOTS}/room-rail-owner.png` });
  await page.click(".chathead .roomdetailsbtn");
  await page.waitForSelector(".roompanel .memberrow", { timeout: 20000 });

  // ---- the same room, read by a plain member ----
  await fpage.click(".sidebar >> text=# paperwork");
  await fpage.click(".chathead .roomdetailsbtn");
  await fpage.waitForSelector('.roommembers .memberrow[data-member="Bramble"]', { timeout: 25000 });
  const memberSeesBramble = fpage.locator('.roommembers .memberrow[data-member="Bramble"]');
  const memberSeesScout = fpage.locator('.roommembers .memberrow[data-member="Scout"] .agentowner');
  ok("everybody in the room is told who an agent belongs to, not only the person who runs it",
    /Your agent/.test(await memberSeesBramble.locator(".agentowner .whose").innerText()) &&
    (await memberSeesBramble.locator(".agentowner").getAttribute("data-mine")) === "yes" &&
    (await memberSeesScout.getAttribute("data-owner")) === "Vikas" &&
    /Vikas can read this room/i.test(await memberSeesScout.locator(".readsroom").innerText()),
    (await memberSeesScout.innerText()).replace(/\s+/g, " ").trim());
  ok("a plain member is not offered the control that lets somebody in — it is not there to click",
    (await fpage.locator(".chathead .addmember").count()) === 0 &&
    (await fpage.locator(".chathead select").count()) === 0);
  await fpage.screenshot({ path: `${SHOTS}/room-members-member.png` });

  // ---- membership is a HISTORY now: two rows, not one (§11.6) ----
  const memberKeys = await fpage.$$eval(".roommembers .memberrow",
    rs => rs.map(r => r.dataset.memberkey ?? ""));
  ok("every member row is keyed by the membership itself, so two spells in one room cannot collapse into one",
    memberKeys.length >= 2 && memberKeys.every(k => /^[^:]+:\d+$/.test(k)) &&
    new Set(memberKeys).size === memberKeys.length,
    memberKeys.join(" "));
  const priyaBack = fpage.locator('.roommembers .memberrow[data-member="Priya"]');
  const priyaSecondJoin = Number(await priyaBack.getAttribute("data-joined"));
  ok("coming back into a room is a NEW membership, and the list shows the one she has now",
    (await priyaBack.count()) === 1 && priyaSecondJoin > priyaFirstJoin,
    `first ${priyaFirstJoin} · now ${priyaSecondJoin}`);
  ok("somebody let back in comes back as a plain member — power is not restored by the door",
    (await priyaBack.locator(".rolename").getAttribute("data-role")) === "member",
    (await priyaBack.locator(".rl").innerText()).replace(/\s+/g, " ").trim());

  // ---- nothing new pushes the page sideways, in either look ----
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await fpage.setViewportSize({ width, height });
      await fpage.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await fpage.waitForTimeout(220);
      const over = await fpage.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      ok(`a member list naming an agent's owner does not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await fpage.screenshot({ path: `${SHOTS}/room-owner-named-${theme}.png` });
      }
    }
  }
  await fpage.setViewportSize({ width: 1280, height: 800 });
  await fpage.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  /* ================= ROLES CAN BE CHANGED, NOT ONLY READ (finding #21) =======

     `removeMember` and `setMemberRole` existed on the hub with nothing on
     screen to reach them. The rule these checks hold to is the same one the
     rest of the panel follows: a control is offered only where the hub would
     say yes, and it says what the change MEANS before it is made. */

  // ---- a plain member is offered neither, because neither would be allowed ----
  ok("somebody who does not run the room is offered no way to change roles or take people out",
    (await fpage.locator(".roompanel .memberopen").count()) === 0 &&
    (await fpage.locator(".roompanel .memberout").count()) === 0 &&
    (await fpage.locator(".roompanel .roleopt").count()) === 0);
  await fpage.click(".roompanel .roomclose");

  // ---- the person who runs it is ----
  const priyaRow = page.locator('.roommembers .memberrow[data-member="Priya"]');
  await page.waitForSelector('.roommembers .memberrow[data-member="Priya"]', { timeout: 20000 });
  ok("the person who runs the room is offered a way to change what somebody can do here",
    (await priyaRow.locator(".memberopen").count()) === 1);
  /* Never a button whose one outcome is a refusal: the hub refuses to let the
     owner stand themselves down, and an agent has no screen to run a room from,
     so neither is offered a role at all. */
  ok("the owner is not offered a way to demote themselves — the hub would refuse it, so it is not there",
    (await page.locator('.memberrow[data-member="Vikas"] .memberopen').count()) === 0);
  await page.locator('.roommembers .memberrow[data-member="Bramble"] .memberopen').click();
  await page.waitForSelector('.memberask[data-manage="Bramble"]', { timeout: 15000 });
  ok("an agent can be taken out of a room but is never offered a role — a role is a job on a screen",
    (await page.locator('.memberask[data-manage="Bramble"] .roleopt').count()) === 0 &&
    (await page.locator('.memberask[data-manage="Bramble"] .memberout').count()) === 1);
  await page.locator('.roommembers .memberrow[data-member="Bramble"] .memberopen').click();

  await priyaRow.locator(".memberopen").click();
  await page.waitForSelector('.memberask[data-manage="Priya"]', { timeout: 15000 });
  const roleOpts = await page.$$eval('.memberask[data-manage="Priya"] .roleopt', bs => bs.map(b => ({
    role: b.dataset.setrole,
    name: b.querySelector("b")?.textContent?.trim() ?? "",
    means: b.querySelector("span")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
    on: b.getAttribute("aria-pressed") === "true",
  })));
  ok("every role on offer says what picking it would actually do",
    roleOpts.length === 3 &&
    roleOpts.map(o => o.role).join(",") === "owner,admin,member" &&
    roleOpts.every(o => o.means.length > 30) &&
    /Hands this room over/.test(roleOpts.find(o => o.role === "owner").means) &&
    roleOpts.find(o => o.role === "member").on === true,
    roleOpts.map(o => `${o.role}:${o.means.slice(0, 34)}`).join(" | "));
  await page.screenshot({ path: `${SHOTS}/fix2-roles-offered.png` });

  // ---- and changing one really reaches the hub and comes back ----
  await page.click('.memberask[data-manage="Priya"] .roleopt[data-setrole="admin"]');
  await waitFor(page, () => document.querySelector(
    '.roommembers .memberrow[data-member="Priya"] .rolename')?.dataset.role === "admin",
  undefined, { timeout: 20000, what: "the new role to come back from the hub" });
  ok("a role changed on screen is changed at the hub, and the room says so",
    (await priyaRow.locator(".rolename").getAttribute("data-role")) === "admin" &&
    /Helps run it/.test(await priyaRow.locator(".rolename").innerText()));
  // and the person it was done to is told, on their own screen
  await waitFor(fpage, () => document.querySelectorAll(
    ".roompanel .memberopen").length > 0 || true, undefined, { timeout: 5000, what: "a moment" });
  await fpage.click(".chathead .roomdetailsbtn");
  await fpage.waitForSelector(".roompanel .memberrow", { timeout: 20000 });
  await waitFor(fpage, () => document.querySelector(
    '.roommembers .memberrow[data-member="Priya"] .rolename')?.dataset.role === "admin",
  undefined, { timeout: 20000, what: "the new role to reach the person it was given to" });
  ok("being given a job in a room reaches that person's own screen, and brings the controls with it",
    (await fpage.locator(".roompanel .memberopen").count()) >= 1 &&
    (await fpage.locator(".roompanel .roomarchive").count()) === 1);
  await fpage.screenshot({ path: `${SHOTS}/fix2-role-arrived.png` });
  /* An admin may take people out but may NOT hand out roles — that is the
     owner's alone at the hub — and may not throw out the person who runs the
     room. Neither is offered, so on the owner's row there is nothing to press
     at all. */
  ok("somebody helping run a room is offered nothing at all on the row of the person who runs it",
    (await fpage.locator('.roommembers .memberrow[data-member="Vikas"] .memberopen').count()) === 0 &&
    (await fpage.locator('.roommembers .memberrow[data-member="Vikas"] .memberout').count()) === 0);
  /* …but may take out an ordinary member, which is exactly what an admin is
     for — so the control IS there where the hub would allow it. */
  await fpage.locator('.roommembers .memberrow[data-member="Bramble"] .memberopen').click();
  await fpage.waitForSelector('.memberask[data-manage="Bramble"]', { timeout: 15000 });
  ok("and IS offered the one thing an admin may do — taking an ordinary member out — with no role picker",
    (await fpage.locator('.memberask[data-manage="Bramble"] .memberout').count()) === 1 &&
    (await fpage.locator('.memberask[data-manage="Bramble"] .roleopt').count()) === 0);
  await fpage.locator('.roommembers .memberrow[data-member="Bramble"] .memberopen').click();
  await fpage.click(".roompanel .roomclose");

  // ---- taking somebody out says what it means before it happens ----
  await page.locator('.roommembers .memberrow[data-member="Bramble"] .memberopen').click();
  await page.click('.memberask[data-manage="Bramble"] .memberout');
  await page.waitForSelector(".memberoutask", { timeout: 15000 });
  const outSays = (await page.locator(".memberoutask span").innerText()).replace(/\s+/g, " ").trim();
  ok("taking somebody out says what it costs them before it is done, and that nothing is deleted",
    /stops answering here/.test(outSays) &&
    /Priya stops seeing this room|whoever owns it stops seeing/.test(outSays) &&
    /Everything already said stays/.test(outSays), outSays);
  await page.screenshot({ path: `${SHOTS}/fix2-remove-asks.png` });
  await page.click(".memberoutask .memberout-yes");
  await waitFor(page, () => document.querySelectorAll(
    '.roommembers .memberrow[data-member="Bramble"]').length === 0,
  undefined, { timeout: 20000, what: "the agent to be taken out of the room" });
  ok("taking somebody out reaches the hub and the room list stops showing them",
    (await page.locator('.roommembers .memberrow[data-member="Bramble"]').count()) === 0);
  await page.screenshot({ path: `${SHOTS}/fix2-removed.png` });

  /* ---- nothing new pushes the panel sideways ---- */
  await page.locator('.roommembers .memberrow[data-member="Priya"] .memberopen').click();
  await page.waitForSelector('.memberask[data-manage="Priya"]', { timeout: 15000 });
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(220);
      const over = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        body: document.body.scrollWidth - document.body.clientWidth,
      }));
      ok(`the role controls do not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) await page.screenshot({ path: `${SHOTS}/fix2-roles-${theme}.png` });
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.locator('.roommembers .memberrow[data-member="Priya"] .memberopen').click();
  await page.click(".roompanel .roomclose");

  /* ================= A REPLY MUST BE MATCHABLE TO ITS REQUEST ===============

     Findings #9 and #18, and they are ONE finding: an answer from the hub that
     is applied to the wrong question. An `error` frame carries no echo of what
     it refuses, so an unrelated refusal was pinned on whatever happened to be
     waiting — a file that had reached the hub perfectly well could never be
     attached to anything afterwards. The same shape, the other way round: a
     `searchResults` frame was applied whether or not anybody was still asking.

     BOTH ARE REPRODUCED FIRST. Each check below proves the two things really
     overlapped before it claims the fix held; a run in which they never
     overlapped fails rather than passing on a technicality. */

  // ---- a message this person did NOT write, so a refusal can be provoked ----
  await fpage.click(".sidebar >> text=# paperwork");
  await fpage.fill(".composer textarea", "the villa deposit receipt is filed");
  await fpage.press(".composer textarea", "Enter");
  await page.waitForSelector('.msg p:has-text("villa deposit receipt")', { timeout: 25000 });
  const notMine = await page.getAttribute('.msg:has-text("villa deposit receipt")', "data-msg");

  /* TWO files, because that is what the bug needs and it is what people do.
     Uploads go up ONE AT A TIME, so the second waits its turn — and the moment
     the first is answered the second is put on the wire inside that very
     handler. A refusal that was already queued behind the first then landed on
     the second, which had done nothing wrong: it flipped to failed carrying a
     sentence about somebody else's message, and its real answer arrived to find
     nobody waiting, so the file could never be attached to anything.

     The first file is deliberately large and RANDOM — a solid-colour PNG
     deflates to almost nothing, and a hub that answers instantly cannot be
     caught in the middle of anything. */
  const HEAVY = crypto.randomBytes(ATTACHMENT_LIMITS.bytes - 200_000);
  const LIGHT = Buffer.from("deposit,7400\nbalance,2600\n", "utf8");
  /* The hub's answers to uploads are held from here until the refusal has
     landed, so the overlap the bug needs is a state the app is HELD in rather
     than a moment this script has to be lucky enough to catch. See the note on
     `__c9hold` where the browser context is made. */
  await page.evaluate(() => window.__c9hold.hold(["attachment"]));
  /* The heavy one goes first and on its own, so it is the one the hub is busy
     with. The light one is picked only once the heavy one is on the wire — it
     is read in a moment and then QUEUED, waiting for the wire rather than on
     it. */
  await page.setInputFiles(".composer input.filepick", {
    name: "survey-scan.bin", mimeType: "application/octet-stream", buffer: HEAVY,
  });
  await page.waitForFunction(
    () => window.cloud9Wire.outstanding().filter(k => k === "uploadAttachment").length === 1,
    null, { timeout: 40000 });
  await page.setInputFiles(".composer input.filepick", {
    name: "deposit-note.bin", mimeType: "application/octet-stream", buffer: LIGHT,
  });
  /* THE EXACT STATE THE BUG NEEDS: one file on the wire and unanswered, and a
     second already READ and queued behind it. A queued file is put on the wire
     from inside the handler that answers the one ahead of it — so a refusal
     that was queued behind the first arrives to find the second waiting, and
     that is the one that used to be blamed for it.

     Waiting for a second TILE is not enough, and that hole made this check pass
     against the very bug it exists to catch: a tile appears the moment a file is
     PICKED, and a file that has not finished being read cannot be pumped and so
     cannot be blamed. Both halves are the app's own state, waited for. */
  await page.waitForFunction(
    () => window.cloud9Files.queued() === 1 &&
      window.cloud9Wire.outstanding().filter(k => k === "uploadAttachment").length === 1,
    null, { timeout: 40000 });
  const overlapped = await page.evaluate(messageId => {
    const wire = window.cloud9Wire;
    // provoke a refusal that has nothing to do with either file
    wire.ask({ type: "editMessage", messageId, text: "changing words that are not mine" });
    return {
      onTheWire: wire.outstanding().filter(k => k === "uploadAttachment").length,
      queuedBehind: window.cloud9Files.queued(),
      asked: wire.outstanding(),
    };
  }, notMine);
  ok("REPRODUCED: a refusal was provoked with one file on the wire and a second read and queued behind it",
    overlapped.onTheWire === 1 && overlapped.queuedBehind === 1 &&
    overlapped.asked.includes("uploadAttachment") && overlapped.asked.includes("editMessage"),
    JSON.stringify(overlapped));

  /* The refusal must ARRIVE while the two are still overlapped — that is the
     whole point — so it is read here, before the hub's held answers are let
     through, rather than hoped to still be on screen several checks later. */
  const refusal = (await page.locator(".toast .toast-text").innerText({ timeout: 30000 })).trim();
  const letThrough = await page.evaluate(() => window.__c9hold.release());
  ok("REPRODUCED: the refusal really did land while the upload was still unanswered",
    letThrough >= 1, `${letThrough} held answer(s) released afterwards`);

  /* Waited on both files STOPPING — landed or refused — rather than on both
     landing, so a file the refusal wrongly killed is reported by the check
     below instead of being lost in a timeout. */
  await page.waitForFunction(() => document.querySelectorAll(
    ".uploadtray .uptile.done, .uploadtray .uptile.failed").length === 2,
  null, { timeout: 60000 });
  ok("the unrelated refusal touches NEITHER file — both land and both are ready to send",
    (await page.locator(".uploadtray .uptile.failed").count()) === 0 &&
    (await page.locator(".uploadtray .uptile.done").count()) === 2,
    (await page.locator(".uploadtray").innerText()).replace(/\s+/g, " ").trim().slice(0, 120));
  ok("and the refusal is still said on screen, in the hub's own words",
    /can only change your own messages/.test(refusal), refusal);
  await page.screenshot({ path: `${SHOTS}/fix2-upload-survives.png` });

  /* ---- ENTER MUST NEVER THROW AWAY A FILE THAT IS STILL GOING UP (#17) ----
     The tray is emptied when a message goes, and it used to take whatever had
     not landed yet with it: the upload finished into nothing and nobody was
     told. Pressing Enter mid-upload now refuses in a sentence and leaves the
     file exactly where it is. */
  await page.fill(".composer textarea", "the survey and the note");
  await page.click(".composer .primary.small");
  await page.waitForSelector('.msg .fileblock[data-file="survey-scan.bin"]', { timeout: 30000 });
  ok("the files that survived an unrelated refusal really go out with the message",
    (await page.locator('.msg .fileblock[data-file="survey-scan.bin"]').count()) === 1 &&
    (await page.locator('.msg .fileblock[data-file="deposit-note.bin"]').count()) === 1);

  // as big as the hub will take, so the window the press must fall inside is
  // as wide as it can honestly be made
  const SECOND = crypto.randomBytes(ATTACHMENT_LIMITS.bytes - 300_000);
  await page.setInputFiles(".composer input.filepick", {
    name: "roof-survey.bin", mimeType: "application/octet-stream", buffer: SECOND,
  });
  /* The press happens IN THE PAGE, because the window it has to fall inside is
     shorter than a round trip out to this script and back. It is dispatched at
     the composer's own textarea and goes through the app's real `onKeyDown` —
     the same handler a finger reaches; only the browser's key delivery is
     stood in for. */
  const pressedEarly = await page.evaluate(async () => {
    const tile = () => document.querySelector('.uploadtray .uptile[data-upload="roof-survey.bin"]');
    const stillGoing = () => {
      const t = tile();
      return !!t && !t.classList.contains("done") && !t.classList.contains("failed");
    };
    if (!stillGoing()) return { reproduced: false, why: "the file had already landed" };
    const box = document.querySelector(".composer textarea");
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(box, "sending this before the file is up");
    box.dispatchEvent(new Event("input", { bubbles: true }));
    const waitingWhenPressed = stillGoing();
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // give whatever the press caused a chance to be drawn
    const until = Date.now() + 6000;
    let said = "";
    while (Date.now() < until) {
      said = document.querySelector(".toast .toast-text")?.textContent?.trim() ?? "";
      if (/still going up/.test(said)) break;
      await new Promise(r => setTimeout(r, 20));
    }
    /* The send button is read HERE, at the instant of the refusal, and not out
       in the script afterwards. Read afterwards it is a race the checker
       usually loses on a busy machine: the upload finishes, the button flips
       back to "Send with 1 file", and a correct app is failed for being quick.
       The claim is unchanged — while it is refusing, the button must say what
       it is waiting for — it is only asked at the moment it is true. */
    const btn = document.querySelector(".composer .sendbtn");
    return {
      reproduced: true, waitingWhenPressed, said,
      stillThere: !!tile(),
      wordsKept: box.value,
      stillGoingWhenRead: stillGoing(),
      sendWaiting: btn?.dataset.waiting ?? "",
      sendSays: (btn?.textContent ?? "").trim(),
      wentAnyway: [...document.querySelectorAll(".msg p")]
        .filter(p => p.textContent.includes("sending this before the file is up")).length,
    };
  });
  ok("REPRODUCED: the Enter key was pressed while a file was genuinely still on its way up",
    pressedEarly.reproduced === true && pressedEarly.waitingWhenPressed === true,
    JSON.stringify(pressedEarly));
  ok("Enter mid-upload refuses in a sentence instead of throwing the file away in silence",
    /still going up/.test(pressedEarly.said) && pressedEarly.stillThere === true &&
    pressedEarly.wentAnyway === 0 &&
    pressedEarly.wordsKept === "sending this before the file is up",
    JSON.stringify(pressedEarly));
  ok("and the send button says it is waiting for the file rather than offering to send without it",
    pressedEarly.stillGoingWhenRead === true &&
    pressedEarly.sendWaiting === "file" && /Waiting for a file/.test(pressedEarly.sendSays),
    `${pressedEarly.sendSays} (data-waiting=${pressedEarly.sendWaiting}, ` +
    `still going: ${pressedEarly.stillGoingWhenRead})`);
  await page.screenshot({ path: `${SHOTS}/fix2-enter-waits.png` });

  // and once it lands, the very same message goes with the file it was holding
  await page.waitForSelector('.uploadtray .uptile[data-upload="roof-survey.bin"].done',
    { timeout: 40000 });
  await page.click(".composer .primary.small");
  await page.waitForSelector('.msg .fileblock[data-file="roof-survey.bin"]', { timeout: 30000 });
  ok("nothing was lost by waiting — the file goes out with the words that were typed",
    (await page.locator('.msg .fileblock[data-file="roof-survey.bin"]').count()) === 1 &&
    (await page.locator('.msg p:has-text("sending this before the file is up")').count()) === 1);

  /* ---- a search cleared before its answer arrives (#18) ---- */
  const searchRace = await page.evaluate(async () => {
    const wire = window.cloud9Wire;
    const before = wire.seen().searchResults ?? 0;
    wire.search("villa");        // ask
    wire.clearSearch();          // and call it off, in the same tick
    const deadline = Date.now() + 20000;
    while ((wire.seen().searchResults ?? 0) <= before && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 25));
    }
    await new Promise(r => setTimeout(r, 400)); // let anything wrong settle in
    return {
      answersArrived: (wire.seen().searchResults ?? 0) - before,
      searchOnScreen: wire.searching(),
      hitsOnScreen: document.querySelectorAll(".searchhit").length,
    };
  });
  ok("REPRODUCED: the answer to the cleared search really did come back from the hub",
    searchRace.answersArrived >= 1, `${searchRace.answersArrived} searchResults frame(s)`);
  ok("a search called off before its answer arrives stays gone — nothing is brought back to life",
    searchRace.searchOnScreen === null && searchRace.hitsOnScreen === 0,
    JSON.stringify(searchRace));

  /* ================= ONE HELD FILE, SHOWN IN TWO PLACES (#16) ===============

     A `blob:` URL lives until it is revoked, and the same message is drawn in
     two places at once — in the room and again in an open thread. Whichever
     copy went away first used to revoke it, so closing a thread panel wiped the
     picture out of the room behind it. Ownership of a held thing cannot be
     "whoever let go of it first": every copy takes a hold and the LAST one to
     let go frees the bytes. */
  const planMsg = page.locator('.msg:has-text("here is the site plan and the ledger")').last();
  await planMsg.waitFor({ timeout: 20000 });
  await planMsg.hover();
  await planMsg.locator(".ma.reply").click();
  await page.waitForSelector(".threadpanel", { timeout: 20000 });
  await page.waitForSelector('.threadpanel .fileblock[data-file="site-plan.png"]',
    { timeout: 20000 });
  const planId = await page.getAttribute(
    '.msgs .fileblock[data-file="site-plan.png"]', "data-attachment");
  const holders = () => page.evaluate(id => window.cloud9Files.holders(id), planId);
  ok("REPRODUCED: the same picture really is drawn in two places at once, and held by both",
    (await page.locator('.fileblock[data-file="site-plan.png"]').count()) === 2 &&
    (await holders()) === 2, `${await holders()} places holding it`);

  await page.click('.msgs .fileblock[data-file="site-plan.png"] .fileopen');
  await page.waitForSelector('.msgs .fileblock[data-file="site-plan.png"] .fileshot img',
    { timeout: 20000 });
  await page.click(".threadpanel .threadclose");
  await page.waitForSelector(".threadpanel", { state: "detached", timeout: 15000 });
  await page.waitForTimeout(500);
  const stillDrawn = await page.evaluate(() => {
    const img = document.querySelector('.msgs .fileblock[data-file="site-plan.png"] .fileshot img');
    if (!img) return null;
    return { w: img.naturalWidth, h: img.naturalHeight, blob: img.src.startsWith("blob:"), done: img.complete };
  });
  ok("closing the thread does NOT take the picture out of the room behind it",
    !!stillDrawn && stillDrawn.blob && stillDrawn.done && stillDrawn.w === 180 && stillDrawn.h === 120,
    JSON.stringify(stillDrawn));
  ok("and the file is held once now, by the one place still showing it",
    (await holders()) === 1, `${await holders()} holder(s)`);
  await page.screenshot({ path: `${SHOTS}/fix2-picture-survives-thread.png` });

  /* ---- and the LAST place letting go really does free it ---- */
  await page.click(".sidebar >> text=# general");
  await page.waitForTimeout(600);
  ok("when the last place showing a file goes, the bytes are let go",
    (await holders()) === 0 &&
    !(await page.evaluate(() => window.cloud9Files.opened())).includes(planId),
    `${await holders()} holder(s) left`);
  await page.click(".sidebar >> text=# paperwork");
  await page.waitForSelector('.msg .fileblock[data-file="site-plan.png"]', { timeout: 20000 });

  /* ================= A NUMBER WITH A CEILING (#P3) ========================= */
  const capSays = await page.evaluate(() => {
    const w = window.cloud9Wire;
    const cap = w.unreadCeiling();
    return { cap, at: w.unreadSays(cap), over: w.unreadSays(cap + 40), under: w.unreadSays(12) };
  });
  ok("a count that has hit the ceiling is never printed as though it were exact",
    capSays.at === `${capSays.cap - 1}+` && capSays.over === `${capSays.cap - 1}+` &&
    capSays.under === "12", JSON.stringify(capSays));

  /* ---- and a real, uncapped count on the rail is still the plain truth ---- */
  await fpage.click(".sidebar >> text=# paperwork");
  await fpage.fill(".composer textarea", "one more for the pile");
  await fpage.press(".composer textarea", "Enter");
  await waitFor(page, () => (document.querySelector(
    '.sidebar .side-item[data-channel="paperwork"] .cnt.hot')?.textContent ?? "") !== "",
  undefined, { timeout: 25000, what: "an unread mark to appear on the rail" });
  const badge = await page.$eval('.sidebar .side-item[data-channel="paperwork"] .cnt.hot', el => ({
    says: el.textContent.trim(), capped: el.dataset.capped ?? "", label: el.getAttribute("aria-label"),
  }));
  ok("an unread count below the ceiling is said exactly, with no plus and no hedging",
    /^\d+$/.test(badge.says) && badge.capped === "" && /^\d+ new$/.test(badge.label),
    JSON.stringify(badge));

  /* ================= A HIGHLIGHT MUST BE ONE THE HUB REALLY FOUND ========== */
  await page.click(".sidebar >> text=# paperwork");
  await page.fill(".composer textarea", "the «gazebo» quote came in under budget");
  await page.press(".composer textarea", "Enter");
  await page.waitForSelector('.msg p:has-text("quote came in under budget")', { timeout: 25000 });
  await page.evaluate(() => window.cloud9Menu.run("search"));
  await page.waitForSelector(".searchpanel", { timeout: 10000 });
  await page.fill(".search-input", "gazebo");
  await page.waitForSelector(".searchhit", { timeout: 25000 });
  await page.waitForTimeout(400);
  const marked = await page.$eval(".searchhit .snippet", el => ({
    mode: el.dataset.marked,
    marks: el.querySelectorAll("mark").length,
    text: el.textContent,
  }));
  ok("a message that contains « » is not given a highlight it never earned, and no stray bracket is drawn",
    marked.mode === "plain" && marked.marks === 0 &&
    marked.text.includes("gazebo") && !/«»|»«/.test(marked.text),
    JSON.stringify(marked));
  await page.screenshot({ path: `${SHOTS}/fix2-snippet-honest.png` });

  // and an ordinary message is still highlighted, so the fix did not just
  // switch highlighting off
  await page.fill(".search-input", "ledger");
  await waitFor(page, () => [...document.querySelectorAll(".searchhit .snippet")]
    .some(s => s.dataset.marked === "marks"), undefined,
  { timeout: 25000, what: "a result whose marks can be trusted" });
  ok("an ordinary result is still highlighted where the hub really found the word",
    (await page.locator('.searchhit .snippet[data-marked="marks"] mark').count()) >= 1);
  await page.keyboard.press("Escape");

  /* ================= THE VIEW HAS ONE OWNER (#19) ==========================

     Rule 2 (an older page must not move the words under the reader) used to be
     undone by rule 1 (a new message follows a reader who is at the bottom):
     layout effects run first, so rule 1's guard never saw rule 2's anchor and
     followed anyway. Walking back to a search result therefore snapped to the
     newest message on every page it loaded. The reader is put a little way off
     the bottom — near enough that rule 1 still considers them "at the bottom",
     far enough that rule 1 firing would be unmistakable. */
  /* A conversation LONG ENOUGH that walking back to the target takes several
     pages. One page back is not a test of this at all: the snap and the jump
     would land in the same commit, before the browser paints, and the bug would
     be invisible to anything watching the screen. The messages are sent through
     the app's own `send`, because typing a hundred and sixty of them one key at
     a time would take longer than the rest of this suite. */
  await page.click('button[title="New channel"]');
  await page.fill('.panel input[placeholder="trip-goa"]', "longhaul");
  await page.click(".panel .foot >> text=Create");
  await page.waitForSelector(".sidebar >> text=# longhaul", { timeout: 20000 });
  await page.click("text=# longhaul");
  const seeded = await page.evaluate(async () => {
    const wire = window.cloud9Wire;
    const id = wire.channels().find(c => c.name === "longhaul").id;
    // the one message with this word in it, said first and never repeated
    wire.ask({ type: "send", channelId: id, text: "the marker message nobody repeats" });
    for (let i = 1; i <= 160; i++) {
      wire.ask({ type: "send", channelId: id, text: `longhaul line ${i}` });
      if (i % 20 === 0) await new Promise(r => setTimeout(r, 60));
    }
    return id;
  });
  await page.waitForSelector('.msg:has-text("longhaul line 160")', { timeout: 60000 });
  void seeded;

  // a reload is the honest starting point: only the newest page is on screen
  await page.reload();
  await page.waitForSelector(".sidebar >> text=# longhaul", { timeout: 25000 });
  await page.click("text=# longhaul");
  await page.waitForSelector('.msg:has-text("longhaul line 160")', { timeout: 25000 });
  await page.waitForTimeout(900);
  const startedWith = await page.evaluate(async () => {
    const el = document.querySelector(".msgs");
    el.scrollTop = el.scrollHeight;                        // at the bottom first
    await new Promise(r => setTimeout(r, 120));            // let the app see it
    el.scrollTop = el.scrollHeight - el.clientHeight - 40; // 40px up: still "at the bottom"
    await new Promise(r => setTimeout(r, 120));
    /* Sampled every frame for as long as the walk could possibly take. The
       search overlay takes the message list off screen for a moment, so a
       sampler that stopped the first time it could not find one would only ever
       have watched the part before the click — which is the part that proves
       nothing. It keeps its own frame budget instead. */
    /* WATCH THE RULE ITSELF, not the paint it leaves behind.
       The follow-to-bottom rule is the only thing that calls `scrollTo` on the
       message list — keeping the reader's place sets `scrollTop` directly, and
       going to a particular message uses `scrollIntoView`. So a call here IS
       the rule firing, whether or not the browser ever painted the result. */
    window.__followed = [];
    const realScrollTo = Element.prototype.scrollTo;
    Element.prototype.scrollTo = function (...args) {
      if (this.classList && this.classList.contains("msgs")) {
        window.__followed.push(Math.round((args[0] && args[0].top) ?? args[1] ?? -1));
      }
      return realScrollTo.apply(this, args);
    };
    window.__fromBottom = [];
    const note = () => {
      const m = document.querySelector(".msgs");
      if (m) window.__fromBottom.push(Math.round(m.scrollHeight - m.scrollTop - m.clientHeight));
    };
    /* Sampled on the list's OWN scroll events as well as once a frame.
       Frames are a clock, and the clock made this check lie: on a run where the
       walk finished inside sixteen frames every sample taken was perfect and the
       check failed anyway, on "not enough samples". A scroll event is the app
       moving the view — the thing actually being watched — so no movement can
       now happen without being sampled, however fast the walk is. Listened for
       in the capture phase at the document, because scroll events do not bubble
       and React may hand this list a different element than the one on screen
       now. */
    document.addEventListener("scroll", note, true);
    let frames = 0;
    const tick = () => { note(); if (++frames < 4000) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return { onScreen: document.querySelectorAll(".msgs .msg").length };
  });
  await page.evaluate(() => window.cloud9Menu.run("search"));
  await page.waitForSelector(".searchpanel", { timeout: 10000 });
  await page.fill(".search-input", "marker");
  await waitFor(page, () => document.querySelectorAll(".searchhit").length >= 1,
    undefined, { timeout: 25000, what: "the one marker message to be found" });
  const oldestHit = await page.locator(".searchhit").last().getAttribute("data-hit");
  const mustWalk = await page.evaluate(id =>
    document.querySelectorAll(`.msgs .msg[data-msg="${id}"]`).length === 0, oldestHit);
  ok("REPRODUCED: the message asked for is several pages further back than what is on screen, so pages must really be walked",
    mustWalk && startedWith.onScreen <= 50,
    `${startedWith.onScreen} of 161 messages on screen, target already loaded: ${!mustWalk}`);
  await page.locator(".searchhit").last().click();
  await page.waitForSelector(`.msgs .msg[data-msg="${oldestHit}"].litup`, { timeout: 30000 });
  const walk = await page.evaluate(() => {
    const m = document.querySelector(".msgs");
    const endedAt = m ? Math.round(m.scrollHeight - m.scrollTop - m.clientHeight) : -1;
    // one last reading, taken directly, so this can never depend on a sampler
    // having been given a slice of the machine at the right instant
    if (m) (window.__fromBottom ?? []).push(endedAt);
    const seen = window.__fromBottom ?? [];
    /* The reader was put 40px off the bottom — near enough that the
       follow-to-bottom rule still counts them as "at the bottom", so if it ever
       fired the view would be pinned to 0. */
    return {
      followedToBottom: (window.__followed ?? []).length,
      samples: seen.length,
      pinned: seen.filter(d => d <= 2).length,
      min: seen.length ? Math.min(...seen) : -1,
      max: seen.length ? Math.max(...seen) : -1,
      endedAt,
    };
  });
  /* What this check is really made of, and none of it is a clock:
     - `followedToBottom` counts CALLS to the follow-to-bottom rule, caught at
       the one function it uses. It cannot be missed however fast the walk was.
     - `pinned`/`min` say the view was never at the newest message at any moment
       anybody sampled.
     - `endedAt` says the reader finished a long way from the bottom, which is
       what proves pages were really walked back rather than nudged.
     It used to also demand more than twenty samples, which was nothing but a
     guess that the walk would be slow. It was not, on a machine with a spare
     moment, and the check failed a working app for it. */
  ok("walking back to a result never snaps the view to the newest message",
    walk.followedToBottom === 0 && walk.samples >= 1 && walk.pinned === 0
      && walk.min >= 30 && walk.endedAt >= 200,
    JSON.stringify(walk));
  ok("and the reader ends up on the message they asked for",
    (await page.locator(`.msgs .msg[data-msg="${oldestHit}"].litup`).count()) === 1);
  await page.screenshot({ path: `${SHOTS}/fix2-jump-holds.png` });
  await page.keyboard.press("Escape");

  /* ---- `from:` really filters now, so the placeholder is not a promise the
     hub breaks (§11.4). The author filter used to be applied in JavaScript
     AFTER SQL's limit, so on a busy room it returned nothing at all. Two people
     say the same word here, deliberately: a filter that returned one hit
     because only one hit existed would prove nothing. */
  await fpage.click(".sidebar >> text=# general");
  await fpage.fill(".composer textarea", "kayak hire is sorted for Saturday");
  await fpage.press(".composer textarea", "Enter");
  await page.click(".sidebar >> text=# general");
  await page.waitForSelector('.msg p:has-text("kayak hire is sorted")', { timeout: 25000 });
  await page.fill(".composer textarea", "kayak deposit is still to pay");
  await page.press(".composer textarea", "Enter");
  await page.waitForSelector('.msg p:has-text("kayak deposit is still")', { timeout: 25000 });

  await page.evaluate(() => window.cloud9Menu.run("search"));
  await page.waitForSelector(".searchpanel", { timeout: 10000 });
  const searchPlaceholder = await page.getAttribute(".search-input", "placeholder");
  ok("the search box still offers from:, and the offer is true now",
    /from:Priya/.test(searchPlaceholder ?? ""), searchPlaceholder ?? "");
  await page.fill(".search-input", "kayak");
  await waitFor(page, () => document.querySelectorAll(".searchhit").length === 2,
    undefined, { timeout: 25000, what: "both people's kayak messages to be found" });
  const bothSaid = await page.$$eval(".searchhit .hitwho b", bs => bs.map(b => b.textContent.trim()));
  ok("two different people said the same word, so narrowing by author has something to do",
    bothSaid.length === 2 && new Set(bothSaid).size === 2, bothSaid.join(" / "));
  await page.fill(".search-input", "from:Priya kayak");
  await waitFor(page, () => document.querySelectorAll(".searchhit").length === 1,
    undefined, { timeout: 25000, what: "the author filter to narrow the results" });
  const narrowed = await page.$$eval(".searchhit .hitwho b", bs => bs.map(b => b.textContent.trim()));
  ok("from: narrows to that one person's messages, from the screen",
    narrowed.length === 1 && narrowed[0] === "Priya", narrowed.join(" / "));
  await page.screenshot({ path: `${SHOTS}/room-search-from.png` });
  await page.keyboard.press("Escape");

  /* ---- the hub could not open its messages (§11.7) ----
     The sentence is written by `StoreOpenError` for a person to read, and the
     screen shows it WORD FOR WORD. So this check does not type the sentence: it
     makes a database the hub genuinely cannot read, catches the error the hub
     itself would throw, and compares that string with what the screen drew. */
  const { Store } = await import("../apps/relay/dist/store.js");
  const brokenDbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-qa-broken-")), "not-a.db");
  fs.writeFileSync(brokenDbPath, "this file is not a database at all\n");
  let hubSentence = "";
  try {
    new Store(brokenDbPath);
  } catch (err) {
    hubSentence = err.name === "StoreOpenError" ? err.message : "";
  }
  ok("the hub really does refuse an unreadable database with a sentence written for a person",
    hubSentence.startsWith("Cloud9 could not open its message database at") &&
    /Nothing has been changed/.test(hubSentence), hubSentence.slice(0, 90));

  const downPage = await owner.newPage();
  downPage.on("console", m => { if (m.type() === "error") consoleErrors.push("hubdown: " + m.text()); });
  await downPage.goto(`${UI}&hubError=${encodeURIComponent(hubSentence)}`);
  await downPage.waitForSelector(".hubdown .hubsay", { timeout: 20000 });
  const shownSentence = (await downPage.locator(".hubdown .hubsay").innerText()).replace(/\s+/g, " ").trim();
  ok("when the hub cannot open its database the screen says its sentence as-is, never a stack trace",
    shownSentence === hubSentence.replace(/\s+/g, " ").trim() &&
    (await downPage.locator(".join").count()) === 0 &&
    !/at Object|at new Store|\.js:\d+/.test(shownSentence),
    shownSentence.slice(0, 90));
  await downPage.screenshot({ path: `${SHOTS}/room-hub-unreadable.png` });
  await downPage.close();
  /* Best effort: SQLite opened the file before it discovered it was not a
     database, and on Windows that handle outlives the failed open for a moment.
     A locked scratch file in the OS temp folder must never be the reason a QA
     run reports a failure it did not find. */
  try { fs.rmSync(path.dirname(brokenDbPath), { recursive: true, force: true }); }
  catch { /* the OS will sweep it — it holds nothing but a line of text */ }

  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# paperwork");
  await page.waitForSelector(".chathead .roomdetailsbtn", { timeout: 20000 });
  // the panel is closed by the trip out to another screen; the checks below are
  // about the panel, so it is opened again rather than assumed
  if ((await page.locator(".roompanel").count()) === 0) await page.click(".chathead .roomdetailsbtn");
  await page.waitForSelector(".roompanel .memberrow", { timeout: 20000 });

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

  /* ================= WHAT AN AGENT ACTUALLY DID (FR-TL-003) =================

     The whole point of this feature is that the screen can show what an agent
     really did instead of repeating what it SAID it did. So these checks are
     written against records that came off the wire, never against anything the
     page invented — and the one they lean on hardest is the absence check:
     a record with no money must render no COST ROW AT ALL. Asserting that the
     row does not say "0" would pass on a card that says "0"; asserting the row
     is not in the document is the only version that means anything. */

  await page.click('.rail-btn[data-go="tasks"]');
  // What the screen is holding, printed before anything is asserted — a missing
  // card and a record that never arrived look identical on screen and are two
  // completely different bugs.
  const jobs = await page.evaluate(() => window.cloud9Runs.jobs());
  console.log("[qa] jobs the screen knows about: " + JSON.stringify(jobs));
  console.log("[qa] runs held by the screen: " + JSON.stringify(
    await page.evaluate(() => window.cloud9Runs.held())));

  const doneJob = jobs.find(j => j.status === "completed" && j.runId);
  ok("a finished job carries the record of what its agent actually did",
    !!doneJob && /^r-/.test(doneJob.runId), JSON.stringify(doneJob ?? null));
  const jobRunId = doneJob?.runId;

  /* This suite reloads the page three times before it gets here, so the record
     that was PUSHED when the job finished is long gone — which is exactly the
     everyday case of opening the app the morning after. The job offers the
     record and the click is what asks for it. Nothing is drawn from a runId
     alone. (The unasked push is proved further down, on a live run.) */
  await page.waitForSelector(`.taskrow .runopen[data-run="${jobRunId}"]`, { timeout: 30000 });
  await page.click(`.taskrow .runopen[data-run="${jobRunId}"]`);
  await page.waitForSelector(`.taskrow .callout.run[data-run="${jobRunId}"]`, { timeout: 30000 });
  const jobCard = page.locator(`.taskrow .callout.run[data-run="${jobRunId}"]`);
  ok("opening it fetches the real record from the hub and draws it as a finished run",
    (await jobCard.getAttribute("data-outcome")) === "ok",
    await jobCard.getAttribute("data-outcome"));

  const jobTook = (await jobCard.locator('dd[data-row="took"]').innerText()).trim();
  const jobSum = (await jobCard.locator(".runsum").innerText()).trim();
  // This demo turn used no tools, so `summarizeRun` has exactly one sentence for
  // it — and the TOOK row is the same `humanDuration` of the same field. If the
  // screen had grown a second way of saying either, these two would disagree.
  ok("the plain-words line is the hub's own sentence, built from the same numbers as the rows",
    jobSum === `Answered straight from what it knew — no tools used, took ${jobTook}.`,
    `${jobSum} :: took=${jobTook}`);

  const jobRows = await jobCard.locator("dl.kv dt").evaluateAll(ds => ds.map(d => d.dataset.row));
  ok("a run the app reported no money for renders NO COST ROW AT ALL — not a zero, not an estimate",
    (await jobCard.locator('[data-row="cost"]').count()) === 0 && !jobRows.includes("cost"),
    jobRows.join("/"));
  ok("and the rows it does carry are the ones the record really holds",
    jobRows.join("/") === "asked-by/ran-on/took", jobRows.join("/"));
  await page.screenshot({ path: `${SHOTS}/run-task.png` });

  // ---- the same record, under the 📦 result in the conversation ----
  await page.click('.rail-btn[data-go="chat"]');
  await page.click(".sidebar >> text=# trip-goa");
  await page.waitForSelector(`.msg .callout.run[data-run="${jobRunId}"]`, { timeout: 30000 });
  ok("the 📦 job result in the conversation carries that job's own record, not a lookalike",
    (await page.locator(`.msg .callout.run[data-run="${jobRunId}"]`).count()) === 1);
  await page.screenshot({ path: `${SHOTS}/run-chat.png` });

  /* A run card is the widest thing the app draws: a long ask in its title, a
     full URL in a step. It is checked in EVERY place it renders, because the
     column it sits in differs in each of them. */
  const overflowNow = async () => page.evaluate(() => ({
    doc: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth,
  }));
  const noSidewaysWithACard = async (where, shot) => {
    for (const [width, height] of [[1280, 800], [1440, 900]]) {
      for (const theme of ["light", "dark"]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
        await page.waitForTimeout(220);
        const over = await overflowNow();
        ok(`a run card ${where} does not scroll sideways at ${width} in the ${theme} look`,
          over.doc <= 0 && over.body <= 0, JSON.stringify(over));
        if (width === 1280 && shot) await page.screenshot({ path: `${SHOTS}/${shot}-${theme}.png` });
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  };
  await noSidewaysWithACard("under a job result in the conversation", "run-chat");

  await page.click('.rail-btn[data-go="tasks"]');
  await page.waitForSelector(`.taskrow .callout.run[data-run="${jobRunId}"]`, { timeout: 20000 });
  await noSidewaysWithACard("in the Tasks in-tray", "run-tasks");

  /* ---- records with the things a demo turn cannot have ----
     A mock harness reports no tools, no tokens and no money, which is honest and
     is exactly why the absence check above is real. To see the OTHER half — a
     step list, a refused tool, a cost — this opens a second connection as the
     engine and reports three runs through the real frame the real engine uses.
     Nothing is faked on the screen's side: the hub validates them, checks they
     belong to this owner's agent, redacts them and pushes them out like any
     other. */
  const { relayPort } = qaTarget();
  const engineWs = new WebSocket(`ws://127.0.0.1:${relayPort}`);
  const hub = await new Promise((resolve, reject) => {
    const giveUp = setTimeout(() => reject(new Error("the hub never answered the QA engine")), 20000);
    engineWs.onerror = () => { clearTimeout(giveUp); reject(new Error("the QA engine could not connect")); };
    engineWs.onmessage = ev => {
      const f = JSON.parse(ev.data);
      if (f.type === "welcome") { clearTimeout(giveUp); resolve(f.state); }
      if (f.type === "error") { clearTimeout(giveUp); reject(new Error(f.error)); }
    };
    engineWs.onopen = () => engineWs.send(JSON.stringify({
      type: "hello", token: qaOwnerToken(), client: "engine",
    }));
  });
  const scout = hub.agents.find(a => a.name === "Scout");
  const general = hub.channels.find(c => c.name === "general");
  if (!scout || !general) throw new Error("the QA engine could not find Scout and #general to report against");

  const base = {
    kind: "chat", agentId: scout.id, agentName: "Scout", channelId: general.id,
    requestedBy: "Vikas", requestedByKind: "human",
    // the newest runs this agent has: "Recent work" shows the last ten, and by
    // now Scout has taken more turns than that
    startedAt: Date.now(), finishedAt: Date.now() + 41000, durationMs: 41000,
    replyChars: 812, events: 24,
  };
  const RICH_URL = "https://villas.example/goa";
  const rich = {
    ...base, id: "r-qa-rich-1", provider: "claude",
    model: "claude-sonnet-5", actualModel: "claude-sonnet-5",
    ask: "find three villas in Goa under 8k", outcome: "ok",
    steps: [
      { seq: 1, kind: "web", label: "Read a web page", detail: RICH_URL, ok: true },
      { seq: 2, kind: "read", label: "Read notes.md", detail: "notes.md", ok: true },
      { seq: 3, kind: "note", label: "Refused to use Bash" },
      { seq: 4, kind: "command", label: "Ran a command", detail: "ls", ok: false },
      { seq: 5, kind: "thinking", label: "Thought it through" },
      { seq: 6, kind: "message", label: "Said something" },
    ],
    usage: { inputTokens: 9291, outputTokens: 640, cachedInputTokens: 4100, costUsd: 0.76 },
    sessionId: "qa-session", numTurns: 3,
  };
  const codexRun = {
    ...base, id: "r-qa-codex-1", provider: "codex", model: "gpt-5.6-sol",
    ask: "tidy the shortlist", outcome: "ok",
    steps: [{ seq: 1, kind: "command", label: "Ran a command", detail: "sort list.txt", ok: true }],
    // tokens but NO money: Codex never reports a cost, and we never compute one
    usage: { inputTokens: 400, outputTokens: 90, reasoningTokens: 120 },
  };
  const brokenRun = {
    ...base, id: "r-qa-failed-1", provider: "claude", model: "claude-sonnet-5",
    ask: "book the second villa", outcome: "failed",
    error: "the booking site refused the card",
    steps: [{ seq: 1, kind: "web", label: "Read a web page", detail: "https://villas.example/book", ok: false }],
    truncated: true,
  };
  for (const record of [rich, codexRun, brokenRun]) {
    engineWs.send(JSON.stringify({ type: "runRecorded", record }));
  }

  /* THE UNASKED PUSH. Nothing on screen asked for these; the hub sends a run to
     everyone who could see the conversation it happened in, the moment it
     finishes. The screen has to hold one that arrives for a room it is not even
     looking at, keyed by the record's own id. */
  await waitFor(page, ids => {
    const held = window.cloud9Runs.held().map(r => r.id);
    return ids.every(id => held.includes(id));
  }, [rich.id, codexRun.id, brokenRun.id], { timeout: 20000, what: "runs to arrive unasked" });
  ok("a run that finishes anywhere this person can see arrives unasked, and is kept by its own id",
    (await page.evaluate(id => window.cloud9Runs.held().find(r => r.id === id)?.steps, rich.id)) === 6);
  // ---- an agent's own history, in its editor. Owner only. ----
  await page.click('.rail-btn[data-go="crew"]');
  await page.click('.cast[data-crew="Scout"] >> text=Edit');
  await page.waitForSelector(".recentwork", { timeout: 20000 });
  await page.waitForSelector(`.recentwork .workrow[data-run="${rich.id}"]`, { timeout: 20000 });
  const richRow = page.locator(`.recentwork .workrow[data-run="${rich.id}"]`);
  ok("an agent's recent work lists what it did, with the ask and the same plain-words line",
    (await richRow.locator(".wr-tx b").innerText()).trim() === rich.ask &&
    (await richRow.locator(".wr-sum").innerText()).trim() === summarizeRun(rich),
    (await richRow.locator(".wr-sum").innerText()).trim());
  await page.screenshot({ path: `${SHOTS}/run-recent-work.png` });

  await richRow.locator(".wr-head").click();
  await page.waitForSelector(`.workrow[data-run="${rich.id}"] .callout.run`, { timeout: 20000 });
  const richCard = page.locator(`.workrow[data-run="${rich.id}"] .callout.run`);
  ok("a run the app DID report money for shows the cost, in the hub's own words",
    (await richCard.locator('dd[data-row="cost"]').innerText()).trim() === humanMoney(0.76),
    (await richCard.locator('dd[data-row="cost"]').innerText()).trim());

  await richCard.locator(".runmore").click();
  await page.waitForSelector(`.workrow[data-run="${rich.id}"] .runsteps .runstep`, { timeout: 20000 });
  const kinds = await richCard.locator(".runstep").evaluateAll(
    ls => ls.map(l => `${l.dataset.seq}:${l.dataset.kind}`));
  ok("every step is listed in the order it happened, each as its own kind of thing",
    kinds.join(" ") === "1:web 2:read 3:note 4:command", kinds.join(" "));
  const link = richCard.locator('.runstep[data-kind="web"] a.dt');
  ok("a web step's detail is a real link to the page it read",
    (await link.getAttribute("href")) === RICH_URL &&
    (await link.innerText()).trim() === RICH_URL,
    await link.getAttribute("href"));
  // The refusal is the one step here the app reported no outcome for. It gets
  // neither a tick nor a cross — the two steps the app DID vouch for get ticks,
  // so this is not passing because no marks are drawn at all.
  ok("a step the app said nothing about gets NO tick and NO cross",
    (await richCard.locator('.runstep[data-ok="unsaid"]').count()) === 1 &&
    (await richCard.locator('.runstep[data-ok="unsaid"] .mk').count()) === 0 &&
    (await richCard.locator('.runstep[data-ok="true"] .mk.yes').count()) === 2,
    `${await richCard.locator('.runstep[data-ok="unsaid"]').count()} unsaid, ` +
    `${await richCard.locator(".mk").count()} marks in all`);
  ok("a step the app said failed is marked failed, and only that one",
    (await richCard.locator(".runstep.bad .mk.no").count()) === 1 &&
    (await richCard.locator('.runstep[data-kind="command"].bad').count()) === 1);
  ok("a refused tool reads as a boundary that held, not as an error",
    (await richCard.locator('.runstep[data-kind="note"].held').count()) === 1 &&
    (await richCard.locator('.runstep[data-kind="note"].bad').count()) === 0 &&
    /Refused to use Bash/.test(await richCard.locator('.runstep[data-kind="note"]').innerText()));
  ok("what it thought and what it said are folded away until they are asked for",
    (await richCard.locator('.runstep[data-kind="thinking"]').count()) === 0 &&
    (await richCard.locator(".runquiet").innerText()).includes("2"));
  await richCard.locator(".runquiet").click();
  await page.waitForSelector(`.workrow[data-run="${rich.id}"] .runstep[data-kind="thinking"]`, { timeout: 10000 });
  await page.screenshot({ path: `${SHOTS}/run-steps.png` });

  // ---- the Codex half: tokens, and never a price ----
  await page.locator(`.recentwork .workrow[data-run="${codexRun.id}"] .wr-head`).click();
  await page.waitForSelector(`.workrow[data-run="${codexRun.id}"] .callout.run`, { timeout: 20000 });
  const codexCard = page.locator(`.workrow[data-run="${codexRun.id}"] .callout.run`);
  const codexRows = await codexCard.locator("dl.kv dt").evaluateAll(ds => ds.map(d => d.dataset.row));
  ok("a Codex run shows NO cost row at all — the app reports no money and none is invented",
    (await codexCard.locator('[data-row="cost"]').count()) === 0 && !codexRows.includes("cost") &&
    !/cost|\$|cents/i.test(await codexCard.locator("dl.kv").innerText()),
    codexRows.join("/"));

  // ---- a run that failed says so, in the record's own words ----
  await page.locator(`.recentwork .workrow[data-run="${brokenRun.id}"] .wr-head`).click();
  await page.waitForSelector(`.workrow[data-run="${brokenRun.id}"] .callout.run[data-outcome="failed"]`,
    { timeout: 20000 });
  const brokenCard = page.locator(`.workrow[data-run="${brokenRun.id}"] .callout.run`);
  ok("a run that failed says what went wrong, word for word from the record",
    (await brokenCard.locator('dd[data-row="went-wrong"]').innerText()).trim() === brokenRun.error,
    (await brokenCard.locator('dd[data-row="went-wrong"]').innerText()).trim());
  await brokenCard.locator(".runmore").click();
  await page.waitForSelector(`.workrow[data-run="${brokenRun.id}"] .runtrunc`, { timeout: 10000 });
  ok("a record that had steps dropped to keep it small says so",
    /left out/.test(await brokenCard.locator(".runtrunc").innerText()));
  await page.screenshot({ path: `${SHOTS}/run-failed.png` });

  // ---- and none of it is offered for somebody else's agent ----
  await fpage.click('.rail-btn[data-go="crew"]');
  await fpage.waitForSelector(".cast", { timeout: 20000 });
  ok("a friend is never shown — and never asks for — the history of an agent that isn't theirs",
    (await fpage.locator(".recentwork").count()) === 0 &&
    (await fpage.locator('.cast[data-crew="Scout"] >> text=Edit').count()) === 0);

  // ---- and the third place it renders: an agent's own history ----
  await noSidewaysWithACard("with every step showing, in an agent's history", "run-card");
  engineWs.close();
  await page.click(".editor >> text=← Crew");

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

  /* ---- the reach ladder, at its widest: top rung, everything disclosed ---- */
  await page.click('.rail-btn[data-go="crew"]');
  await page.waitForSelector(".crew-bar", { timeout: 20000 });
  await page.click('.cast[data-crew="Scout"] button:has-text("Edit")');
  await page.waitForSelector(".editor .reachladder", { timeout: 20000 });
  await page.locator('.editor .reachrung[data-reach="computer"]').click();
  if ((await page.getAttribute(".editor .abilitypick", "data-open")) !== "yes") {
    await page.click(".editor .abilityshow");
  }
  await page.locator(".editor .harnesshonest .hh-more summary").click();
  await page.locator(".editor .reachladder").scrollIntoViewIfNeeded();
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(200);
      const over = await overflow();
      ok(`the reach ladder at full stretch does not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.locator(".editor .reachladder").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${SHOTS}/reach-ladder-${theme}.png` });
        await page.locator(".editor .harnesshonest").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${SHOTS}/reach-honest-${theme}.png` });
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click(".editor .topbar >> text=Cancel");
  await page.waitForSelector(".crew-grid", { timeout: 20000 });

  /* ---- and the casting room, with a brief open over it ---- */
  await page.waitForSelector(".crew-bar .tomarket", { timeout: 20000 });
  await page.click(".crew-bar .tomarket");
  await page.waitForSelector(".market .cast.role", { timeout: 20000 });
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(200);
      const over = await overflow();
      ok(`the casting room's role cards do not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.screenshot({ path: `${SHOTS}/hall-roles-${theme}.png` });
      }
    }
  }
  await page.click('.market .cast.role[data-role="sw-devops"] .rolesee');
  await page.waitForSelector(".hirepanel", { timeout: 15000 });
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(200);
      const over = await overflow();
      ok(`the casting room and an open brief do not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.screenshot({ path: `${SHOTS}/market-brief-${theme}.png` });
        await page.screenshot({ path: `${SHOTS}/hall-brief-${theme}.png` });
      }
    }
  }
  await page.click('.hirepanel .foot >> text=Not now');

  /* ---- and the rail carrying a presence line on every agent ---- */
  await page.click('.rail-btn[data-go="chat"]');
  await page.waitForSelector(".sidebar .agentrow", { timeout: 20000 });
  for (const [width, height] of [[1280, 800], [1440, 900]]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(t => document.documentElement.setAttribute("data-theme", t), theme);
      await page.waitForTimeout(200);
      const over = await overflow();
      ok(`a rail showing every agent's state does not scroll sideways at ${width} in the ${theme} look`,
        over.doc <= 0 && over.body <= 0, JSON.stringify(over));
      if (width === 1280) {
        await page.screenshot({ path: `${SHOTS}/presence-sidebar-${theme}.png` });
      }
    }
  }

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
