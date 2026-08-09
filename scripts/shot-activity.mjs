#!/usr/bin/env node
/**
 * shot-activity.mjs — photograph the Activity screen in the INSTALLED app.
 *
 * WHY A SCRIPT AND NOT A CLAIM. A green build proves the code compiles and
 * proves nothing about what is on his screen. This launches
 * %LOCALAPPDATA%\Programs\Cloud9\Cloud9.exe — the only Cloud9 he owns — against
 * a THROWAWAY database, makes two agents, opens Activity and photographs it.
 *
 * FRESH ONLY. There is no --real-data door here on purpose: this script creates
 * agents, and creating test agents in his real crew is vandalism. The run
 * ABORTS if `--user-data-dir` did not take, rather than falling through onto
 * %APPDATA%\Cloud9 — the same guard `drive-app.mjs` states and for the same
 * reason.
 *
 *   node scripts/shot-activity.mjs             photograph and close
 *   node scripts/shot-activity.mjs --keep-open leave the window up to look at
 */
import { chromium } from "playwright";
import { clickRail } from "./rail-navigation.mjs";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * WHICH CLOUD9 GETS PHOTOGRAPHED.
 *
 * By default: `release/win-unpacked/Cloud9.exe` — the PACKAGED app this branch
 * built. Not a dev server and not a Vite preview: the same Electron bundle the
 * installer copies into place, with the same `dist-web`, launched as a real
 * Windows program. It is deliberately the default because several branches
 * share this machine and only one `%LOCALAPPDATA%\Programs\Cloud9` exists —
 * installing over it would quietly replace whatever another branch is in the
 * middle of verifying.
 *
 * `--installed` photographs that shared install instead, for when this branch
 * is the one actually being handed over.
 */
const PACKAGED_EXE = path.join(REPO_ROOT, "release", "win-unpacked", "Cloud9.exe");
const INSTALLED_EXE = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "Programs", "Cloud9", "Cloud9.exe");
const APP_EXE = process.argv.includes("--installed") ? INSTALLED_EXE : PACKAGED_EXE;
const SHOTS = path.join(REPO_ROOT, "docs", "qa");
const KEEP_OPEN = process.argv.includes("--keep-open");
const DEMO = process.argv.includes("--demo");
/**
 * Photograph ONLY the stop, skipping the states already captured.
 *
 * A full walk asks real Claude for several real turns: it takes twenty minutes
 * and costs real money, so iterating on the last state by re-running all of it
 * is wasteful in both. This jumps to the stop with the crew already made.
 */
const ONLY_STOP = process.argv.includes("--only-stop");

/** Wait on an observable condition, never on a guessed number of seconds. */
async function until(what, test, { timeout = 60000, every = 400 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (await test()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, every));
  }
}

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

function killStale() {
  try {
    execFileSync("taskkill", ["/F", "/IM", "Cloud9.exe", "/T"], { stdio: "ignore" });
  } catch { /* nothing was running, which is the normal case */ }
}

async function shot(page, slug) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `activity-${slug}.png`);
  await page.screenshot({ path: file });
  console.log(`  shot  ${file}`);
  return file;
}

async function makeAgent(page, name, persona) {
  await clickRail(page, "crew");
  await page.waitForSelector(".crew-bar", { timeout: 30000 });
  const write = page.locator(".crew-bar button, .crew-bar a")
    .filter({ hasText: /write|new agent|make/i }).first();
  if (await write.count()) await write.click();
  else await page.click('button:has-text("Write an agent")');
  await page.waitForSelector(".editor .persona-input", { timeout: 30000 });
  await page.fill(".editor #f-name", name);
  await page.fill(".editor .persona-input", persona);
  await page.click(".editor .topbar >> text=Create agent");
  await page.waitForSelector(`.cast[data-crew="${name}"]`, { timeout: 40000 });
  console.log(`  made agent ${name}`);
}

/**
 * Ask an agent something WITHOUT LEAVING THE BOARD.
 *
 * Quick chat is drawn above the screen, so the board stays mounted behind it.
 * That matters: walking to the chat screen and back takes longer than a short
 * turn, so earlier versions of this script kept arriving after the live row was
 * already over and reporting a working feature as unproven.
 */
async function askFromBoard(page, agentName, text) {
  await page.keyboard.press("Control+K");
  await page.waitForSelector(".qc-input", { timeout: 15000 });
  await page.fill(".qc-input", text);
  const opt = page.locator(".qc-opt").filter({ hasText: agentName }).first();
  if (await opt.count()) await opt.click();
  await page.press(".qc-input", "Enter");
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForSelector(".qc-input", { state: "detached", timeout: 15000 }).catch(() => {});
  console.log(`  asked ${agentName}: "${text}" (from quick chat, standing on the board)`);
}

/**
 * CAPTURE THE REAL RUN RECORDS THE APP IS HOLDING, as a test fixture.
 *
 * WHY. A hand-written fixture agrees with the code because both came out of the
 * same head. That is how the recency bug survived its own tests: the fixture had
 * a `finishedAt` field because the function asked for one, and a REAL record has
 * no such field — it stores a start and a length. A test built from a real
 * record would have had nowhere to put the wrong answer.
 *
 * So the fixture is whatever the hub really sent this app, written out verbatim.
 */
async function captureRunFixture(page) {
  const entries = await page.evaluate(() => window.cloud9Runs?.history?.() ?? null)
    .catch(() => null);
  if (!entries || entries.length === 0) return 0;
  const file = path.join(REPO_ROOT, "packages", "shared", "src", "runs.fixture.json");
  /* ADDED TO WHAT IS ALREADY THERE, KEYED ON THE RECORD'S OWN ID — never
     replacing it. A short targeted run holds one or two records, and writing
     the file flat threw away the long job captured by a full walk, which is the
     only record in there that catches the "measured from the start" clock bug.
     A run that photographs one state must not narrow the evidence for another. */
  let held = [];
  try { held = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first capture */ }
  const byId = new Map(held.map(r => [r.id, r]));
  for (const e of entries) byId.set(e.id, e);
  const all = [...byId.values()].sort((a, b) => a.startedAt - b.startedAt);
  fs.writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`);
  console.log(`  captured ${entries.length} real run record(s), ${all.length} held → ${file}`);
  return entries.length;
}

/** Read every row on the board, as a person would see it. */
const readBoard = page => page.$$eval(".rn-row", rows => rows.map(r => ({
  state: r.getAttribute("data-state"),
  name: r.querySelector(".rn-tx b")?.innerText.trim(),
  headline: r.querySelector(".rn-state")?.innerText.trim(),
  detail: r.querySelector(".rn-detail")?.innerText.trim(),
})));

async function main() {
  if (!fs.existsSync(APP_EXE)) {
    throw new Error(`no Cloud9 to photograph at: ${APP_EXE}\n` +
      "Run `npm run dist` first (that builds release/win-unpacked).");
  }
  killStale();

  const port = await freePort();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-shot-"));
  console.log(`  launching ${APP_EXE} (throwaway data: ${userData})`);
  /* REAL BY DEFAULT, DEMO ONLY IF ASKED.
     `--demo` makes the engine answer with made-up text. It is useful for the
     quiet states, but it CANNOT photograph the working row: the demo provider
     returns synchronously, so the lamp is on for microseconds and no amount of
     polling will ever see it. A real turn takes seconds, which is the whole
     reason the live row is worth having — so the default is real. */
  const child = spawn(APP_EXE,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`],
    {
      detached: true, stdio: "ignore",
      env: { ...process.env, ...(DEMO ? { CLOUD9_DEMO: "1" } : {}) },
    });
  child.unref();

  await until("the app's debugger to answer", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    return !!r?.ok;
  }, { timeout: 120000 });

  /* NO PROOF, NO RUN. If Electron ignored --user-data-dir this run is sitting
     on his real crew, and it must stop rather than write test agents into it. */
  await until("the app to build its database in the throwaway folder",
    () => fs.existsSync(path.join(userData, "cloud9-relay.db")), { timeout: 90000 })
    .catch(() => {
      killStale();
      throw new Error("--user-data-dir was ignored — refusing to touch his real Cloud9 data.");
    });

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page = null;
  await until("Cloud9's own window to appear", async () => {
    page = browser.contexts().flatMap(c => c.pages())
      .find(p => /dist-web|index\.html/i.test(p.url()));
    return !!page;
  }, { timeout: 60000 });
  console.log(`  attached to ${page.url()}`);
  await page.waitForSelector(".rail .rail-btn", { timeout: 60000 });

  /* ---- 1. the empty board: it must SAY it is empty, not show a blank box --- */

  await page.click('.rail .rail-btn[data-go="activity"]');
  await page.waitForSelector(".rightnow", { timeout: 30000 });
  const emptyLine = (await page.locator(".rn-sum").innerText()).trim();
  console.log(`  no agents yet → "${emptyLine}"`);
  if (!emptyLine) throw new Error("NOT ON SCREEN — the board said nothing with no agents.");
  await shot(page, "1-no-agents");

  /* ---- 2. with a crew on it ---------------------------------------------- */

  await makeAgent(page, "Scout", "Looks things up and reports back in plain words.");
  await makeAgent(page, "Ledger", "Keeps the numbers straight.");

  await page.click('.rail .rail-btn[data-go="activity"]');
  await page.waitForSelector(".rn-row", { timeout: 30000 });
  await until("both agents on the board",
    async () => await page.locator(".rn-row").count() >= 2);

  const board = await page.$$eval(".rn-row", rows => rows.map(r => ({
    state: r.getAttribute("data-state"),
    name: r.querySelector(".rn-tx b")?.innerText.trim(),
    headline: r.querySelector(".rn-state")?.innerText.trim(),
    detail: r.querySelector(".rn-detail")?.innerText.trim(),
  })));
  const summary = (await page.locator(".rn-sum").innerText()).trim();
  console.log(`  top line: "${summary}"`);
  for (const r of board) console.log(`  row: ${r.name} [${r.state}] ${r.headline} — ${r.detail}`);

  /* THE THING THIS SCREEN EXISTS FOR: no row may be silent. */
  for (const r of board) {
    if (!r.headline || !r.detail) {
      throw new Error(`NOT ON SCREEN — ${r.name} has a blank row: ${JSON.stringify(r)}`);
    }
  }
  const railLabel = (await page.locator('.rail .rail-btn[data-go="activity"]').innerText()).trim();
  console.log(`  rail button reads: "${railLabel}"`);
  if (!/activity/i.test(railLabel)) {
    throw new Error(`NOT ON SCREEN — the rail button reads "${railLabel}", not Activity.`);
  }

  await shot(page, "2-board-and-trail");

  /* ---- 3. AN AGENT ACTUALLY WORKING ---------------------------------------
     The quiet states are the easy half. The row this feature exists for is the
     one that says "Working now", and a screenshot of an idle board does not
     prove it. So: really ask an agent something, in the real composer, and
     photograph the board while the answer is being worked on. */

  /* ASK FROM WHERE HE IS ALREADY STANDING.
     Earlier tries walked to the chat screen, typed, and walked back — and a
     round trip through two screens takes longer than a short turn, so the live
     row was over before the board was on screen again and the run kept
     reporting it as unprovable. Quick chat is drawn ABOVE the screen, so the
     board is already mounted behind it: ask, close, and the working row is
     right there. This is also exactly how he would do it. */
  await page.click('.rail .rail-btn[data-go="activity"]');
  await page.waitForSelector(".rightnow", { timeout: 30000 });

  /* WAIT FOR THE APP TO REPORT IN BEFORE ASKING IT ANYTHING.
     The first attempt typed the moment the agents existed, while the board
     still read "Claude hasn't reported in yet" — so nothing ran and the walk
     reported both live states as unprovable when the real problem was that it
     had asked too early. The board's own words are the readiness signal, which
     is a neat thing about having built it: the screen says when it is ready. */
  await until("this computer's Claude to report in", async () => {
    const said = await page.locator(".rn-row").first().innerText().catch(() => "");
    return !/hasn't reported in yet/.test(said);
  }, { timeout: 90000, every: 1000 }).catch(() => {
    console.log("  (Claude never reported in — the turn below may not run)");
  });

  let sawWorking = false;
  let sawEnding = false;
  if (!ONLY_STOP) {
  await askFromBoard(page, "Scout", "say the word ok");

  try {
    await until("the Activity board to show an agent working", async () => {
      sawWorking = await page.locator('.rn-row[data-state="working"]').count() > 0;
      return sawWorking;
    }, { timeout: 60000, every: 120 });
  } catch { /* reported below — a miss is said out loud, never swallowed */ }

  if (sawWorking) {
    const line = (await page.locator(".rn-sum").innerText()).trim();
    const row = await page.locator('.rn-row[data-state="working"]').first().innerText();
    console.log(`  WORKING top line: "${line}"`);
    console.log(`  WORKING row: ${row.replace(/\s+/g, " ")}`);
    await shot(page, "3-working-now");
  } else {
    console.log("  (never caught the working state — the turn finished faster than the board was opened)");
  }

  /* ---- 4. AND WHAT IT JUST DID ------------------------------------------- */

  try {
    await until("the board to report a finished job", async () => {
      sawEnding = await page.locator('.rn-row[data-state="done"], .rn-row[data-state="failed"], ' +
        '.rn-row[data-state="stopped"]').count() > 0;
      return sawEnding;
      /* A REAL turn on this machine, with real-time virus scanning on every
         process start, is minutes not seconds. This wait is generous on
         purpose: a harness that gives up early reports a working feature as
         unproven, which is the more expensive mistake. */
    }, { timeout: 420000, every: 500 });
  } catch { /* said out loud below */ }

  if (sawEnding) {
    const row = await page.locator('.rn-row[data-state="done"], .rn-row[data-state="failed"], ' +
      '.rn-row[data-state="stopped"]').first();
    console.log(`  ENDING row: ${(await row.innerText()).replace(/\s+/g, " ")}`);
    console.log(`  ENDING state: ${await row.getAttribute("data-state")}`);
    await shot(page, "4-what-it-just-did");
  } else {
    console.log("  (no finished job reached the board within the wait)");
  }
  } // end !ONLY_STOP

  /* ---- 5. YOU STOPPED IT -------------------------------------------------
     One of the two states the review named. 🛑 exists because a job the owner
     stopped used to wear the same ✅ as one that ran to the end, so a board
     that cannot show this row has not been checked where it matters most.
     The Stop button sends "!stop" — the engine's one owner of stopping — so
     typing it is the same route the button takes.

     ON LEDGER, NOT SCOUT, AND BEFORE THE PLAN TEST. Both of these are ordering
     lessons from a run that stalled: an agent with an unanswered go-ahead is
     BLOCKED, so a long job sent to it never starts and the stop lands on
     nothing. Each state gets an agent that is free to enter it, and the test
     that deliberately blocks an agent goes last. */

  await askFromBoard(page, "Ledger",
    "count slowly from 1 to 500, writing out every single number in words");

  /* WAIT FOR **LEDGER** TO BE WORKING, NOT FOR "SOMEBODY" TO BE WORKING.
     The first version watched for any working row at all, so another agent's
     turn satisfied it and the stop went out while Ledger's turn was still
     QUEUED. A queued turn is dropped rather than killed — deliberately, so his
     money is not spent on work he has cancelled — and a dropped turn writes no
     record, so there was correctly nothing for the board to show. The harness
     was stopping the wrong thing at the wrong moment and calling the feature
     unproven. */
  const ledgerWorking = page.locator('.rn-row[data-state="working"]').filter({ hasText: "Ledger" });
  let ledgerRan = true;
  await until("Ledger itself to start the long job", async () => {
    await page.click('.rail .rail-btn[data-go="activity"]').catch(() => {});
    return await ledgerWorking.count() > 0;
  }, { timeout: 300000, every: 800 }).catch(() => {
      ledgerRan = false;
      console.log("  (Ledger never started the long job — cannot stop what is not running)");
    });
  if (ledgerRan) {
    /* LET THE TURN GET PROPERLY UNDERWAY — three quarters of a minute, not ten
       seconds, and the number is the finding.

       At ten seconds the stop landed on a turn that had taken a slot but not
       yet produced anything, so the engine dropped it rather than killing it —
       deliberately, so his money is not spent on work he has cancelled — and a
       dropped turn writes NO RECORD. The board then correctly had nothing to
       show and read "Ready · it hasn't been asked to do anything yet", which
       looks exactly like a broken feature and is not one. The one run that DID
       produce a stopped record had been going 35 seconds first.

       So the wait is now long enough that there is really something to kill.
       This is the harness catching up with the engine, not a change to it. */
    await page.waitForTimeout(45000);
    await askFromBoard(page, "Ledger", "!stop");
  }

  /* WATCH FOR *AN ENDING*, THEN SAY WHICH ONE IT WAS.
     Waiting only for `stopped` meant that when the board settled on some other
     ending the harness sat there for five minutes and then reported nothing at
     all — a shrug, when what was actually on the screen was a fact worth
     knowing. Now it waits for Ledger to stop working, reads what the row
     actually says, and either photographs it or names exactly what it got
     instead. A wrong answer is a finding; silence is not. */
  let ledgerState = null;
  if (ledgerRan) {
    const ledgerRow = page.locator(".rn-row").filter({ hasText: "Ledger" }).first();
    /* WAIT FOR THE ROW TO SETTLE, NOT JUST FOR THE LAMP TO GO OUT.
       Two facts arrive at different times: the lamp clears the moment the turn
       ends, and the RECORD of what happened arrives afterwards, on its own
       round trip. Watching only for "not working any more" photographed the gap
       between them — the row read "Ready · hasn't been asked to do anything
       yet" for a fraction of a second, and the harness believed it and reported
       the feature unproven. (This is the same race, seen from the outside, that
       the run-history dependency bug was on the inside.) */
    const ENDED = ["stopped", "failed", "done"];
    try {
      await until("Ledger's row to settle on what happened", async () => {
        /* MAKE SURE THE BOARD IS ACTUALLY ON SCREEN BEFORE BELIEVING IT IS
           EMPTY. Sending a message can leave the app on the conversation, and
           then there are no rows to read — which the harness recorded as "no
           row for Ledger" for five minutes and reported as a missing feature.
           An ending is written down and stays written down, so unlike the live
           states there is no race here: re-opening the screen each time costs
           nothing and removes the whole class of false negative. */
        await page.click('.rail .rail-btn[data-go="activity"]').catch(() => {});
        ledgerState = await ledgerRow.getAttribute("data-state").catch(() => null);
        return ledgerState !== null && ENDED.includes(ledgerState);
      }, { timeout: 300000, every: 1500 });
    } catch {
      /* WHAT THE ROW ACTUALLY SAID, not just its state word. The last run
         reported only `null` and left nobody able to tell whether the row was
         missing, still working, or sitting on a state nobody expected. */
      const seen = await ledgerRow.innerText().catch(() => "(no row for Ledger at all)");
      const board = await readBoard(page).catch(() => []);
      console.log(`  (Ledger's row never settled on an ending — last state "${ledgerState}")`);
      console.log(`    row said: ${seen.replace(/\s+/g, " ")}`);
      for (const r of board) console.log(`    board: [${r.state}] ${JSON.stringify(r).slice(0, 160)}`);
    }

    if (ledgerState && ENDED.includes(ledgerState)) {
      const row = (await ledgerRow.innerText()).replace(/\s+/g, " ");
      console.log(`  AFTER THE STOP, Ledger reads [${ledgerState}]: ${row}`);
      /* THE WHOLE POINT OF 🛑, checked whatever the state turned out to be: a
         job HE stopped must never wear the finished tick. */
      if (/✅/.test(row) || /\bFinished\b/.test(row)) {
        throw new Error(`a job HE stopped is wearing the finished tick: ${row}`);
      }
      await shot(page, "5-you-stopped-it");
    } else {
      /* WHY, NOT JUST "NO". The engine answers a stop out loud in the room —
         "🛑 Stopping — pulling the plug" when it really killed something, or
         "There was nothing running to stop" when the work had not started yet
         and was simply dropped from the queue. A dropped turn writes no record
         by design, so the board correctly has nothing to show. Reading the room
         is what turns "the harness saw nothing" into a fact about which of
         those two happened. */
      console.log("  (Ledger's row never reached an ending — asking the room what the stop did)");
      /* LEDGER'S OWN CONVERSATION, NOT WHATEVER ROOM WAS LAST OPEN. Clicking
         the Chat button alone landed on #general — an empty room nobody had
         spoken in — so the diagnosis printed nothing and photographed a blank
         channel. The stop is answered in the DM with the agent, so that is the
         conversation that has to be opened by name. */
      await page.click('.rail .rail-btn[data-go="chat"]').catch(() => {});
      await page.click('.agent-row[data-agent="Ledger"] .agentmain').catch(() => {});
      await page.waitForTimeout(2500);
      const said = await page.$$eval(".msg, .bubble, .msgrow",
        ns => ns.slice(-8).map(n => n.innerText.replace(/\s+/g, " ").slice(0, 200)))
        .catch(() => []);
      for (const s of said) console.log(`    room: ${s}`);
      await shot(page, "5-stop-diagnosis");
    }
  }
  const sawStopped = ledgerState === "stopped";

  /* ---- 6. WAITING FOR YOU ------------------------------------------------
     The other state the review named by hand, because three of its eight
     findings live in this path: the rail count disagreeing with the board, and
     expired go-aheads being raised as live ones. "!plan" is the owner's own way
     of saying "show me the plan before you do anything", and it produces a real
     approval that really sits waiting on him.
     LAST, because it deliberately leaves an agent blocked. */

  let sawWaiting = false;
  if (!ONLY_STOP) {
  await askFromBoard(page, "Scout", "!plan tidy up my notes folder");

  try {
    await until("the board to show an agent waiting on him", async () => {
      /* THE BOARD HAS TO BE ON SCREEN TO BE READ. Sending from quick chat can
         leave the app on the conversation, and a screen that is not mounted has
         no rows — which the harness recorded as "no go-ahead" for seven minutes
         and reported as a missing feature. */
      await page.click('.rail .rail-btn[data-go="activity"]').catch(() => {});
      sawWaiting = await page.locator('.rn-row[data-state="waiting"]').count() > 0;
      return sawWaiting;
    }, { timeout: 420000, every: 1500 });
  } catch { /* said out loud below */ }

  if (sawWaiting) {
    const row = await page.locator('.rn-row[data-state="waiting"]').first().innerText();
    const line = (await page.locator(".rn-sum").innerText()).trim();
    /* THE CONTRADICTION THE REVIEW FOUND, CHECKED ON THE REAL SCREEN.
       The engine keeps the working lamp lit while an agent stands waiting, so
       this is exactly the moment the rail button used to say "1" over a board
       reading "Nothing is being worked on". Both are read here, together. */
    const badge = (await page.locator('.rail .rail-btn[data-go="activity"] .rail-count')
      .innerText().catch(() => "0")).trim() || "0";
    console.log(`  WAITING row: ${row.replace(/\s+/g, " ")}`);
    console.log(`  WAITING top line: "${line}"`);
    console.log(`  WAITING rail badge: "${badge}"`);
    if (/working right now/.test(line) && badge === "0") {
      throw new Error("the top line and the badge disagree about who is working");
    }
    if (badge !== "0" && !/working right now/.test(line)) {
      throw new Error(`CONTRADICTION — rail badge says ${badge}, board says "${line}"`);
    }
    await shot(page, "6-waiting-for-you");
  } else {
    /* WHY, NOT JUST "NO" — the same rule as the stop above. A go-ahead that
       never appears could be an agent that never got going, a plan gate that
       did not fire, or a board that is not redrawing. Those look identical from
       a bare "false", and telling them apart is the whole job. */
    console.log("  (no go-ahead reached the board within the wait — here is what was there)");
    const board = await readBoard(page).catch(() => []);
    for (const r of board) console.log(`    board: [${r.state}] ${JSON.stringify(r).slice(0, 200)}`);
    const badge = await page.locator('.rail .rail-btn[data-go="activity"] .rail-count')
      .innerText().catch(() => "0");
    console.log(`    rail badge: "${(badge || "0").trim()}"`);
    await page.click('.rail .rail-btn[data-go="chat"]').catch(() => {});
    await page.click('.agent-row[data-agent="Scout"] .agentmain').catch(() => {});
    await page.waitForTimeout(2500);
    const said = await page.$$eval(".msg, .bubble, .msgrow",
      ns => ns.slice(-8).map(n => n.innerText.replace(/\s+/g, " ").slice(0, 220)))
      .catch(() => []);
    for (const s of said) console.log(`    room: ${s}`);
    await shot(page, "6-waiting-diagnosis");
  }
  } // end !ONLY_STOP

  await captureRunFixture(page);

  console.log("\n  Activity board is on screen, with words in every row.");
  console.log(`  photographed — working: ${sawWorking}  finished: ${sawEnding}  ` +
    `waiting-for-you: ${sawWaiting}  you-stopped-it: ${sawStopped}`);
  if (KEEP_OPEN) {
    console.log("  --keep-open: the window is still up; close it yourself.");
    return;
  }
  await browser.close().catch(() => {});
  killStale();
  /* The throwaway folder is the app's, not ours, and Windows can still be
     holding a handle on it a moment after the process goes. Failing to delete
     a temp folder is not a failed verification — `sweepOldTempDirs` in
     drive-app.mjs clears the strays on the next run. */
  try { fs.rmSync(userData, { recursive: true, force: true }); }
  catch { console.log(`  (left ${userData} behind — Windows still had it open)`); }
}

main().catch(err => {
  console.error(`\n  FAILED: ${err.message}`);
  if (!KEEP_OPEN) killStale();
  process.exit(1);
});
