#!/usr/bin/env node
/**
 * drive-app.mjs — click through the app Vikas actually double-clicks.
 *
 * WHY THIS EXISTS (2026-07-30 morning). He said: "the five things you claim you
 * have done, I was not seeing." He was right. `npm run qa` drives a Vite dev
 * build in a headless Chromium. It has never once opened
 * %LOCALAPPDATA%\Programs\Cloud9\Cloud9.exe — the only Cloud9 he owns. So work
 * could be tested, green, and completely unreachable on his screen, and the
 * suite would say nothing.
 *
 * This harness launches the INSTALLED Windows app, attaches a debugger to the
 * real window, walks it the way a person does, and asserts what is VISIBLE.
 * A feature that is built underneath but not on screen FAILS here, loudly,
 * with the words "not on screen". That is the whole point — this script is
 * expected to go red until the app catches up with the claims.
 *
 * ------------------------------------------------------------------ running
 *   node scripts/drive-app.mjs                 fresh database (default, safe)
 *   node scripts/drive-app.mjs --real-data     his real Cloud9 data
 *   node scripts/drive-app.mjs --keep-open     leave the window up to look at
 *   node scripts/drive-app.mjs --port 9345     pin the debugger port
 *
 * DEFAULT IS FRESH, deliberately. A full run creates a test agent and hires a
 * role; doing that in his real crew is vandalism. Fresh means the app is
 * pointed at a throwaway `--user-data-dir`, so his `%APPDATA%\Cloud9` is never
 * opened at all — and the run ABORTS if that redirection did not actually take,
 * rather than quietly falling through onto his real database.
 *
 * `--real-data` walks his actual Cloud9 and CHANGES NOTHING: it looks at the
 * crew he already has, and the one check that cannot be made without hiring
 * somebody is reported as not-checked rather than performed on his floor.
 *
 * ---------------------------------------------------------------- honesty
 * Same three laws the browser suite learned the hard way (see qa-target.mjs):
 *   1. an expected-count guard, so a run that died halfway cannot read as a
 *      pass — checks that never ran are FAILURES, not absences;
 *   2. waits on observable conditions, never sleeps;
 *   3. a self-check that proves the page queries are really running (a
 *      deliberately-impossible selector must come back empty) before a single
 *      green result is believed.
 * Plus one this harness needs and the browser one does not: every screen it
 * reaches is photographed into docs/qa/app-*.png, so a person can see what the
 * machine saw and does not have to take its word.
 */

import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

/* ------------------------------------------------------------------ where */

const APP_EXE = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "Programs", "Cloud9", "Cloud9.exe");

const REAL_USER_DATA = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Cloud9");

const SHOTS = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "docs/qa");

/* ------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const valueOf = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

const OPTS = {
  fresh: !has("--real-data"),
  keepOpen: has("--keep-open"),
  port: valueOf("--port") ? Number(valueOf("--port")) : undefined,
};

/* ------------------------------------------------- the checks, named up front
 *
 * Declared here, before anything runs, so the count is fixed BEFORE the run can
 * influence it. A crash on step 2 can then never shrink the denominator into
 * something that looks respectable.
 */
const EXPECTED_CHECKS = [
  "app launches and its own window answers a debugger",
  "the workspace is on screen (not stuck on sign-in)",
  "Projects is in the icon rail",
  "an agent row shows a real presence state",
  "the agent editor offers the full capability ladder",
  "the model list is longer than the four old Claude models",
  "the agent editor has a skills section",
  "role cards in the marketplace show pictures, not emoji",
  "a hired agent's editor offers exactly what a hand-made one's does",
  "a message offers a Reply / thread control",
  /* HIS ITEM 7, and the reason this harness went red for a day: the hub has
     stored projects, pull requests and issues all along and there was no screen
     to reach them from. These four ask the INSTALLED app, in order: does the
     screen open, can he connect a repository, does the repository he connected
     appear with its own name, and does the screen refuse to claim anything
     nobody has checked. */
  "the Projects screen opens and offers to connect a repository",
  "a repository can be connected and appears by name",
  "a project shows its repository, its pull requests and its issues",
  "a repository nobody has looked at says so instead of showing a green tick",
  /* The button that closed the hole above. Until it existed, "nobody has looked
     at GitHub" was a permanent condition; now it is something he can change, so
     the walk has to prove the control is really there and really presses. */
  "the project offers a way to look at GitHub, and pressing it does something",
];

/* ---------------------------------------------------------------- results */

const results = [];
let step = 0;

function pass(name, detail = "") {
  results.push({ name, pass: true, detail });
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function fail(name, detail) {
  results.push({ name, pass: false, detail });
  console.log(`  FAIL  ${name} — ${detail}`);
}

/** Run one check. A check that THROWS is a failure, never a skip. */
async function check(name, fn) {
  try {
    const detail = await fn();
    pass(name, typeof detail === "string" ? detail : "");
  } catch (err) {
    fail(name, err?.message ?? String(err));
  }
}

/**
 * Mark every check a broken step was going to make as failed.
 *
 * The dishonest alternative is to let them go unrun and print "6/6 passed".
 * If the crew screen will not open, we do not KNOW whether presence is on
 * screen — and "unknown" is reported as a failure, with the reason.
 */
function failGroup(names, why) {
  for (const n of names) fail(n, `could not be checked — ${why}`);
}

/* ------------------------------------------------------------------ tools */

/** Is this TCP port actually free on this machine right now? */
function portIsFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

/**
 * Pick a debugger port that is FREE, and prove it.
 *
 * 9222 is taken on this machine by Lenovo Vantage. Attaching to it reads
 * Lenovo's window and reports on Lenovo's DOM — a run that looks like it
 * worked and is about the wrong program entirely. So: never 9222, and never a
 * port we have not just watched a socket bind to.
 */
async function pickPort() {
  if (OPTS.port) {
    if (!(await portIsFree(OPTS.port))) {
      throw new Error(`port ${OPTS.port} is already in use — something else would answer the debugger`);
    }
    return OPTS.port;
  }
  for (let p = 9333; p < 9400; p++) {
    if (p === 9222) continue; // Lenovo Vantage lives here
    if (await portIsFree(p)) return p;
  }
  throw new Error("no free debugger port between 9333 and 9400");
}

/**
 * Nothing else may be holding Cloud9's single-instance lock.
 *
 * A stale copy left running produces `Lock file can not be created! Error
 * code: 32` and the new process quits instantly, which reads as "the app is
 * broken" when it means "the app is already open".
 */
/**
 * How many Cloud9 processes are ALIVE.
 *
 * Not `tasklist`, and the reason is worth writing down. A terminated process
 * stays in `tasklist` until whatever holds a handle to it lets go — seconds
 * later, sometimes — so counting its lines warns about a process that is
 * already dead. The obvious fix, filtering `STATUS ne UNKNOWN`, is WORSE: an
 * Electron renderer reports its status as Unknown while very much running, so
 * that filter answers "nothing is left" while the app still has the database
 * open. A false all-clear is the one answer this harness must never give.
 *
 * `Get-Process` distinguishes the two correctly: it does not list corpses and
 * it does list live children. It costs a few hundred milliseconds; being right
 * is worth it.
 */
function cloud9Count() {
  try {
    const out = execFileSync("powershell",
      ["-NoProfile", "-Command", "@(Get-Process Cloud9 -ErrorAction SilentlyContinue).Count"],
      { encoding: "utf8" });
    return Number(out.trim()) || 0;
  } catch {
    // No PowerShell: fall back to tasklist, which over-counts corpses. Slower
    // to settle, but it never claims the app is gone when it is not.
    try {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq Cloud9.exe", "/NH", "/FO", "CSV"],
        { encoding: "utf8" });
      return out.split(/\r?\n/).filter(l => /Cloud9\.exe/i.test(l)).length;
    } catch { return 0; }
  }
}

/**
 * Close every Cloud9 and WAIT until Windows agrees they are gone.
 *
 * `taskkill` returning is not the same as the process being gone — it exits
 * non-zero when a child of the tree died before it got there, and the main
 * process can still be shutting down for a second or two afterwards. Anything
 * that assumed "taskkill returned, therefore it is closed" raced it: the
 * throwaway database folder could not be deleted because the app still had it
 * open. So this waits for the observable condition, like everything else here.
 */
/**
 * Kill every Cloud9 and report how many are left — in ONE round trip.
 *
 * Stop-Process rather than taskkill: `taskkill /T` walks the process tree and
 * aborts the whole command the moment one child has already exited on its own,
 * which with Electron is every time, so it can return having killed almost
 * nothing. And stop and count together, because a shell is slow to start and
 * doing them separately made each attempt cost three PowerShell launches —
 * which is how a 30-second budget quietly became six attempts and warned about
 * an app that simply needed a seventh.
 */
function stopCloud9AndCount() {
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      "Stop-Process -Name Cloud9 -Force -ErrorAction SilentlyContinue; " +
      "Start-Sleep -Milliseconds 300; " +
      "@(Get-Process Cloud9 -ErrorAction SilentlyContinue).Count"], { encoding: "utf8" });
    return Number(out.trim()) || 0;
  } catch {
    return cloud9Count();
  }
}

async function killStaleApp({ quiet = false } = {}) {
  if (cloud9Count() === 0) return;
  /* Ask REPEATEDLY, not once. Electron is several Cloud9.exe processes and
     killing the main one orphans its children; each round takes a few of them.
     On this machine a full teardown needs about half a dozen rounds, so the
     budget is generous — a slow machine must never be mistaken for a stuck app. */
  await until("every Cloud9 process to actually exit", () => stopCloud9AndCount() === 0,
    { timeout: 90000, every: 400 })
    .catch(() => console.log(
      `  WARNING: ${cloud9Count()} Cloud9 process(es) would not close — kill them by hand`));
  if (!quiet) console.log("  (closed a Cloud9 that was already running)");
}

/**
 * Throwaway folders from runs that were killed before they could tidy up.
 * Empty ones cost nothing; a half-deleted one holding a stale database does,
 * so they are swept at the START of a run, when nothing is holding them.
 */
function sweepOldTempDirs() {
  let swept = 0;
  for (const name of fs.readdirSync(os.tmpdir())) {
    if (!name.startsWith("cloud9-drive-")) continue;
    const dir = path.join(os.tmpdir(), name);
    if (tempUserData && dir === tempUserData) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); swept++; } catch { /* still in use */ }
  }
  if (swept) console.log(`  (swept ${swept} throwaway folder(s) left by earlier runs)`);
}

/** Wait for a thing to become true, rather than sleeping for a guess. */
async function until(what, fn, { timeout = 60000, every = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try { if (await fn()) return true; } catch (err) { last = err; }
    if (Date.now() > deadline) {
      throw new Error(`gave up after ${Math.round(timeout / 1000)}s waiting for ${what}` +
        (last ? ` (last error: ${last.message})` : ""));
    }
    await new Promise(r => setTimeout(r, every));
  }
}

/** Photograph what the machine is looking at. */
async function shot(page, slug) {
  const file = path.join(SHOTS, `app-${String(++step).padStart(2, "0")}-${slug}.png`);
  try {
    await page.screenshot({ path: file });
    console.log(`  shot  ${file}`);
  } catch (err) {
    console.log(`  shot  FAILED for ${slug}: ${err.message}`);
  }
  return file;
}

/* ---------------------------------------------------------------- launching */

let child = null;
let tempUserData = null;

async function launch() {
  if (!fs.existsSync(APP_EXE)) {
    throw new Error(`the installed app is not there: ${APP_EXE}\n` +
      "Install it (npm run dist, then run the installer) before driving it.");
  }
  fs.mkdirSync(SHOTS, { recursive: true });

  // Old screenshots must never be mistaken for this run's evidence.
  for (const f of fs.readdirSync(SHOTS)) {
    if (/^app-.*\.png$/.test(f)) fs.rmSync(path.join(SHOTS, f));
  }

  await killStaleApp();
  sweepOldTempDirs();
  const port = await pickPort();

  const args = [`--remote-debugging-port=${port}`];
  if (OPTS.fresh) {
    tempUserData = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-drive-"));
    args.push(`--user-data-dir=${tempUserData}`);
    console.log(`  fresh database: ${tempUserData}`);
  } else {
    console.log(`  REAL DATA: ${REAL_USER_DATA} — looking only, changing nothing`);
  }

  console.log(`  launching ${APP_EXE} ${args.join(" ")}`);
  child = spawn(APP_EXE, args, { detached: true, stdio: "ignore" });
  child.unref();

  // Wait for the debugger to answer, not for a guessed number of seconds.
  await until("the app's debugger to answer", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    return !!r?.ok;
  }, { timeout: 90000 });

  /* THE GUARD THAT MATTERS. If Electron ignored --user-data-dir, a "fresh" run
     is silently sitting on his real database, creating test agents in his real
     crew. Proof that the redirection took: the app's own hub file appears in
     the throwaway folder. No proof, no run. */
  if (OPTS.fresh) {
    await until("the app to create its database in the throwaway folder", () =>
      fs.existsSync(path.join(tempUserData, "cloud9-relay.db")), { timeout: 60000 })
      .catch(() => {
        throw new Error(
          "--fresh was asked for but the app did not create a database in the throwaway folder.\n" +
          "That means --user-data-dir was ignored and the app may be using the REAL Cloud9 data.\n" +
          "Stopping rather than writing test agents into his crew.");
      });
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

  /* Find CLOUD9's window, by its URL — never "the first page". Taking page[0]
     is how a run ends up reporting on somebody else's Electron app. */
  let page = null;
  await until("Cloud9's own window to appear", async () => {
    const pages = browser.contexts().flatMap(c => c.pages());
    page = pages.find(p => /dist-web|index\.html/i.test(p.url()));
    return !!page;
  }, { timeout: 60000 });

  console.log(`  attached to ${page.url()}`);
  return { browser, page, port };
}

async function teardown(browser) {
  try { await browser?.close(); } catch { /* already gone */ }
  if (OPTS.keepOpen) {
    console.log("\n  --keep-open: the app is still running; close it yourself.");
    return;
  }
  await killStaleApp({ quiet: true });
  if (tempUserData) {
    // Only now — with every process confirmed gone — can the folder be deleted.
    await until("the throwaway folder to be removable", () => {
      try { fs.rmSync(tempUserData, { recursive: true, force: true }); return !fs.existsSync(tempUserData); }
      catch { return false; }
    }, { timeout: 30000, every: 500 }).catch(() =>
      console.log(`  (left ${tempUserData} behind — Windows still had it open)`));
  }
}

/* ------------------------------------------------------------- self-check
 *
 * Before believing one green result: prove the queries are really reaching
 * this page. A suite that cannot fail cannot pass either.
 */
async function assertHonest(page) {
  const real = await page.locator(".rail, .welcome").count();
  const impossible = await page.locator(".cloud9-no-such-element-exists-anywhere").count();
  if (real < 1) {
    throw new Error("self-check failed: neither the icon rail nor the welcome screen is present — " +
      "this is not Cloud9's window, so nothing below could be trusted");
  }
  if (impossible !== 0) {
    throw new Error("self-check failed: a deliberately-impossible selector MATCHED — " +
      "the page queries are not really running and every green result would be meaningless");
  }
}

/* ------------------------------------------------------------------- walk */

async function walk(page) {
  await page.setViewportSize?.({ width: 1440, height: 940 }).catch(() => {});

  /* --- 1. the app is up and it is the workspace, not the sign-in box ------ */

  await check(EXPECTED_CHECKS[0], async () => {
    await assertHonest(page);
    return page.url().replace(/^.*[\\/]/, "");
  });

  await check(EXPECTED_CHECKS[1], async () => {
    const onJoin = await page.locator(".welcome.join").count();
    if (onJoin) {
      throw new Error("the installed app stopped on its sign-in screen — the packaged build is " +
        "supposed to hand itself its own owner key and go straight in");
    }
    await page.waitForSelector(".rail", { timeout: 30000 });
    return "workspace";
  });
  await shot(page, "start");

  /* --- 2. the icon rail: is Projects there? ------------------------------ */

  await check(EXPECTED_CHECKS[2], async () => {
    const sections = await page.$$eval(".rail .rail-btn",
      bs => bs.map(b => (b.getAttribute("data-go") ?? b.getAttribute("title") ?? "?").trim()));
    const found = sections.some(s => /project/i.test(s));
    if (!found) {
      throw new Error(`NOT ON SCREEN — the rail is: ${sections.join(", ")}. No Projects.`);
    }
    return `rail is ${sections.join(", ")}`;
  });

  /* --- 3. crew, with an agent on it -------------------------------------- */

  const CREW_GROUP = [EXPECTED_CHECKS[3]];

  /* What an agent editor is OFFERING, read off the open screen. Used twice:
     once for an agent he wrote himself, once for one he hired. "A hired agent
     is missing everything a hand-made one has" is only answerable if both are
     measured the same way, so there is one function that does it. */
  const readEditor = () => page.evaluate(() => ({
    sections: [...document.querySelectorAll(".editor .form-col > section")]
      .map(s => s.querySelector("h3")?.innerText.trim() ?? "(no heading)"),
    abilities: [...document.querySelectorAll(".editor .toggle-row .tx b")].map(b => b.innerText.trim()),
    skills: document.querySelectorAll(".editor .skills").length,
    filesFolder: /files folder/i.test(document.querySelector(".editor")?.innerText ?? ""),
  }));
  let handmade = null;

  try {
    await page.click('.rail .rail-btn[data-go="crew"]');
    await page.waitForSelector(".crew-bar", { timeout: 30000 });
    await shot(page, "crew-empty");

    // A presence check needs an agent to have presence. On a fresh database
    // there is none, so make one — the same way he does, by typing into the
    // editor, rather than reaching past the screen and writing to the hub.
    // On his REAL data we never create anything; his own crew is the subject.
    if (OPTS.fresh && await page.locator(".cast[data-crew]").count() === 0) {
      const write = page.locator('.crew-bar button, .crew-bar a').filter({ hasText: /write|new agent|make/i }).first();
      if (await write.count()) await write.click();
      else await page.click('button:has-text("Write an agent")');
      await page.waitForSelector(".editor .persona-input", { timeout: 30000 });
      await page.fill(".editor #f-name", "Drivecheck");
      await page.fill(".editor .persona-input", "A test agent made by the click-through harness.");
      await page.click('.editor .topbar >> text=Create agent');
      await page.waitForSelector('.cast[data-crew="Drivecheck"]', { timeout: 40000 });
    }
    await shot(page, "crew");

    await check(EXPECTED_CHECKS[3], async () => {
      const rows = await page.$$eval(".cast[data-crew]", cs => cs.map(c => ({
        name: c.getAttribute("data-crew"),
        presence: c.getAttribute("data-presence"),
        words: (c.querySelector("[data-presence] b, .pdot")?.parentElement?.innerText ?? "").trim(),
        text: c.innerText.replace(/\s+/g, " ").slice(0, 120),
      })));
      if (rows.length === 0) throw new Error("no agent rows on the crew screen at all");
      const withPresence = rows.filter(r => r.presence && r.presence !== "unknown");
      if (withPresence.length === 0) {
        const any = rows.some(r => r.presence);
        throw new Error(any
          ? `NOT ON SCREEN — every agent row reads "unknown" / "Not looked yet": ${rows.map(r => `${r.name}=${r.presence}`).join(", ")}`
          : `NOT ON SCREEN — no row carries a presence state at all. First row reads: "${rows[0].text}"`);
      }
      return withPresence.map(r => `${r.name}=${r.presence}`).join(", ");
    });
  } catch (err) {
    failGroup(CREW_GROUP.filter(n => !results.some(r => r.name === n)),
      `the crew screen did not open (${err.message})`);
    await shot(page, "crew-broken");
  }

  /* --- 4. the agent editor: ladder, models, skills ----------------------- */

  const EDITOR_GROUP = [EXPECTED_CHECKS[4], EXPECTED_CHECKS[5], EXPECTED_CHECKS[6]];

  try {
    await page.click('.cast[data-crew] button:has-text("Edit")');
    await page.waitForSelector(".editor .persona-input", { timeout: 30000 });
    await shot(page, "agent-editor");

    handmade = await readEditor();
    console.log(`  hand-made editor: ${JSON.stringify(handmade)}`);

    await check(EXPECTED_CHECKS[4], async () => {
      const rungs = await page.locator(".editor .reachladder .reachrung").count();
      const toggles = await page.$$eval(".editor .toggle-row .tx b", bs => bs.map(b => b.innerText.trim()));
      if (rungs === 0) {
        throw new Error(`NOT ON SCREEN — no reach ladder in the editor. All he gets is ` +
          `${toggles.length} toggles: ${toggles.join(", ")}`);
      }
      const labels = await page.$$eval(".editor .reachrung", bs => bs.map(b => b.innerText.trim()));
      return `${rungs} rungs (${labels.join(" / ")}) plus ${toggles.length} abilities`;
    });

    await check(EXPECTED_CHECKS[5], async () => {
      const models = await page.$$eval(".editor #f-model option",
        os => os.map(o => `${o.value}|${o.innerText.trim()}`));
      if (models.length === 0) throw new Error("NOT ON SCREEN — no model chooser in the editor");
      const ids = models.map(m => m.split("|")[0]);
      const sonnet45 = ids.some(i => /sonnet.*4[.-]5|4[.-]5.*sonnet/i.test(i));
      if (models.length <= 4 || !sonnet45) {
        throw new Error(`NOT ON SCREEN — the same four he complained about. ` +
          `${models.length} model(s) offered${sonnet45 ? "" : ", and no Sonnet 4.5 among them"}: ${ids.join(", ")}`);
      }
      return `${models.length} models: ${ids.join(", ")}`;
    });

    await check(EXPECTED_CHECKS[6], async () => {
      const skills = await page.locator(".editor .skills").count();
      if (skills === 0) throw new Error("NOT ON SCREEN — no skills section in the agent editor");
      return "skills section present";
    });
  } catch (err) {
    failGroup(EDITOR_GROUP.filter(n => !results.some(r => r.name === n)),
      `the agent editor did not open (${err.message})`);
    await shot(page, "editor-broken");
  }

  /* --- 5. the marketplace: pictures, and a hired agent's editor ---------- */

  const MARKET_GROUP = [EXPECTED_CHECKS[7], EXPECTED_CHECKS[8]];

  try {
    // Back to crew, then into the marketplace by whatever the button is called
    // this week — the NAME of that button is a thing he asked to change, so the
    // harness must not depend on it.
    const back = page.locator('.editor >> text=← Crew');
    if (await back.count()) await back.first().click();
    await page.waitForSelector(".crew-bar", { timeout: 30000 });
    const toMarket = page.locator(".crew-bar .tomarket, .crew-bar button, .crew-bar a")
      .filter({ hasText: /hir|market|casting|browse|role/i }).first();
    if (await toMarket.count()) await toMarket.click();
    else await page.click(".crew-bar .tomarket");
    await page.waitForSelector(".market .cast.role, .cast.role", { timeout: 30000 });
    await shot(page, "marketplace");

    await check(EXPECTED_CHECKS[7], async () => {
      const cards = await page.$$eval(".cast.role", cs => cs.map(c => ({
        role: c.getAttribute("data-role"),
        portrait: !!c.querySelector(".portrait svg, .roleplate svg, img"),
        emojiOnly: !!c.querySelector(".roleface") && !c.querySelector("svg, img"),
      })));
      if (cards.length === 0) throw new Error("NOT ON SCREEN — no role cards in the marketplace");
      const withPics = cards.filter(c => c.portrait).length;
      if (withPics < cards.length) {
        throw new Error(`NOT ON SCREEN — ${cards.length - withPics} of ${cards.length} role cards have ` +
          `no picture${cards.some(c => c.emojiOnly) ? " (still a static emoji)" : ""}`);
      }
      return `${withPics}/${cards.length} role cards carry a drawn portrait`;
    });

    await check(EXPECTED_CHECKS[8], async () => {
      if (!OPTS.fresh) {
        throw new Error("NOT CHECKED — hiring somebody is the only way to answer this, and this " +
          "run was told to leave your real Cloud9 alone. Run it without --real-data for this one.");
      }
      if (!handmade) throw new Error("the hand-made agent's editor never opened, so there is nothing to compare against");
      const first = page.locator(".cast.role").first();
      const role = await first.getAttribute("data-role");
      const see = first.locator(".rolesee");
      if (await see.count()) await see.click(); else await first.click();
      await page.waitForSelector(".hirepanel", { timeout: 30000 });
      const hireName = await page.locator(".hirepanel .hirebtn").innerText();
      await shot(page, "hire-panel");
      await page.click(".hirepanel .hirebtn");

      /* HIRING LANDS HIM IN THE NEW AGENT'S OWN FILE, and that is deliberate:
         he hired the Architect, was dropped on the crew screen with a note
         telling him to press Edit, never did, and concluded a hired role had no
         tool permissions, no files folder and no skills. So the app now opens
         the editor itself.

         This harness was still waiting for `.cast[data-crew]` — a crew card that
         is on screen for a single frame before the editor replaces it. It timed
         out every run and reported "NOT ON SCREEN" against a feature that was
         working, which is the same false alarm in the opposite direction and
         costs exactly as much trust. It now follows the app's real behaviour. */
      await page.waitForSelector(".editor .persona-input", { timeout: 40000 });
      const wanted = hireName.replace(/^Hire\s+/i, "").trim();
      const opened = await page.inputValue(".editor #f-name").catch(() => "");
      if (opened.trim() !== wanted) {
        throw new Error(`hired "${wanted}" from role ${role} but the editor that opened ` +
          `is for "${opened.trim() || "(nothing)"}"`);
      }
      await shot(page, "hired-editor");
      const hired = await readEditor();
      console.log(`  hired editor: ${JSON.stringify(hired)}`);

      /* The three things he actually went looking for and could not find:
         tool permissions, the files folder, and skills. Compared item by item,
         not "does it look about the same". */
      const missing = [
        ...handmade.sections.filter(s => !hired.sections.includes(s)).map(s => `section "${s}"`),
        ...handmade.abilities.filter(a => !hired.abilities.includes(a)).map(a => `permission "${a}"`),
        ...(handmade.skills > 0 && hired.skills === 0 ? ["the skills editor"] : []),
        ...(handmade.filesFolder && !hired.filesFolder ? ["the files folder"] : []),
      ];
      if (missing.length) {
        throw new Error(`NOT ON SCREEN — a hired ${wanted} is missing what a hand-made agent has: ` +
          `${missing.join(", ")}`);
      }
      return `hired ${wanted}: same ${hired.sections.length} sections, ` +
        `same ${hired.abilities.length} permissions, skills editor present, files folder present`;
    });
  } catch (err) {
    failGroup(MARKET_GROUP.filter(n => !results.some(r => r.name === n)),
      `the marketplace did not open (${err.message})`);
    await shot(page, "market-broken");
  }

  /* --- 6. chat: is there a way into a thread? ---------------------------- */

  try {
    const back = page.locator('.editor >> text=← Crew');
    if (await back.count()) await back.first().click().catch(() => {});
    await page.click('.rail .rail-btn[data-go="chat"]');
    await page.waitForSelector(".composer textarea", { timeout: 30000 });

    // Needs a message to hover. Posting one is what a person does; there is no
    // @mention in it, so no agent is asked to answer and no subscription spent.
    // Never posted into his real conversations — those already have messages.
    if (OPTS.fresh && await page.locator(".msg").count() === 0) {
      await page.fill(".composer textarea", "harness check — no agent is being asked anything here");
      await page.press(".composer textarea", "Enter");
      await until("the message to appear in the conversation",
        () => page.locator(".msg").count().then(n => n > 0), { timeout: 30000 });
    }
    await page.locator(".msg").last().hover();
    await shot(page, "chat");

    await check(EXPECTED_CHECKS[9], async () => {
      const reply = await page.locator(".msg .ma.reply, .msg .threadline").count();
      if (reply === 0) throw new Error("NOT ON SCREEN — no Reply or thread control on any message");
      return `${reply} reply/thread control(s) on screen`;
    });
  } catch (err) {
    failGroup([EXPECTED_CHECKS[9]].filter(n => !results.some(r => r.name === n)),
      `the chat screen did not open (${err.message})`);
    await shot(page, "chat-broken");
  }

  /* --- 7. projects: a repository, its pull requests, its issues ----------
   *
   * On a fresh run this CONNECTS a repository, because "can he see his
   * repositories" cannot be answered by a screen with nothing on it. On his
   * real data nothing is connected — the projects he already has are what is
   * looked at, and the one check that needs a connection says it was not made
   * rather than making one on his floor.
   */
  const PROJECT_GROUP = [
    EXPECTED_CHECKS[10], EXPECTED_CHECKS[11], EXPECTED_CHECKS[12], EXPECTED_CHECKS[13],
    EXPECTED_CHECKS[14],
  ];
  const DRIVE_REPO = "vikas53953/cloud9";

  try {
    await page.click('.rail .rail-btn[data-go="projects"]');
    await page.waitForSelector(".projects", { timeout: 30000 });
    await shot(page, "projects");

    await check(EXPECTED_CHECKS[10], async () => {
      const connect = await page.locator(".projects .topbar [data-connect]").count();
      if (connect === 0) {
        throw new Error("NOT ON SCREEN — the Projects screen opened but offers no way to connect a repository");
      }
      return "Projects opens with a way in";
    });

    await check(EXPECTED_CHECKS[11], async () => {
      const already = await page.locator(`.proj-list .side-item[data-repo="${DRIVE_REPO}"]`).count();
      if (already === 0) {
        if (!OPTS.fresh) {
          const have = await page.$$eval(".proj-list .side-item", is => is.map(i => i.dataset.repo));
          if (have.length === 0) {
            throw new Error("NOT CHECKED — nothing is connected in your real Cloud9, and this run was told " +
              "to change nothing. Run it without --real-data to have it connect one.");
          }
          return `already connected: ${have.join(", ")}`;
        }
        await page.click(".projects .topbar [data-connect]");
        await page.waitForSelector(".connectproj #f-repo", { timeout: 20000 });
        await page.fill(".connectproj #f-repo", DRIVE_REPO);
        await page.click('.connectproj button:has-text("Connect")');
        await page.waitForSelector(`.proj-list .side-item[data-repo="${DRIVE_REPO}"]`, { timeout: 30000 });
      }
      const name = await page.locator(`.proj-list .side-item[data-repo="${DRIVE_REPO}"] .txt`).innerText();
      return `connected and listed as "${name.trim()}"`;
    });
    await shot(page, "projects-connected");

    await check(EXPECTED_CHECKS[12], async () => {
      await page.waitForSelector(".projdetail", { timeout: 20000 });
      const seen = await page.evaluate(() => ({
        repo: document.querySelector(".projdetail .reponame")?.innerText.replace(/\s+/g, "") ?? "",
        tabs: [...document.querySelectorAll(".pd-tabs .seg button")].map(b => b.innerText.trim()),
      }));
      if (!seen.repo) throw new Error("NOT ON SCREEN — the open project does not name its repository");
      const hasPulls = seen.tabs.some(t => /pull request/i.test(t));
      const hasIssues = seen.tabs.some(t => /issue/i.test(t));
      if (!hasPulls || !hasIssues) {
        throw new Error(`NOT ON SCREEN — a project must hold its pull requests AND its issues. ` +
          `All that is offered: ${seen.tabs.join(" / ") || "(nothing)"}`);
      }
      return `${seen.repo} · ${seen.tabs.join(" / ")}`;
    });

    /* ABSENT MEANS ABSENT — rule 8, on the one screen most tempted to break it.
       No agent has run `gh` against this repository inside this run, so there
       is nothing to report and the screen has to SAY that rather than show an
       empty list that reads like "no open work". */
    await check(EXPECTED_CHECKS[13], async () => {
      const words = await page.locator(".projdetail").innerText();
      const neverLooked = await page.locator(".pd-never").count();
      const syncedChip = /looked at github/i.test(words);
      if (neverLooked === 0 && !syncedChip) {
        throw new Error("NOT ON SCREEN — the project says nothing at all about whether anyone has " +
          "looked at GitHub, so an empty list reads as 'nothing is open'");
      }
      if (neverLooked > 0 && /trunk/i.test(await page.locator(".pd-facts").innerText())) {
        throw new Error("a repository nobody has looked at is showing a trunk branch nobody reported");
      }
      return neverLooked > 0 ? "says nobody has looked at GitHub yet" : "says when it last looked";
    });
    await shot(page, "projects-honest");

    /* Pressing it is the point. A button that exists and does nothing is the
       thing this project keeps promising not to ship, so the check is not
       "is there a button" — it is "does the screen change when he presses it".
       Either state is an honest answer: it went to work, or it came back with
       a reason. Only "nothing happened at all" is a failure. */
    await check(EXPECTED_CHECKS[14], async () => {
      const look = page.locator(".projdetail [data-look]");
      if (await look.count() === 0) {
        throw new Error("NOT ON SCREEN — a project offers no way to look at GitHub, so " +
          "'nobody has looked yet' is a state he can never leave");
      }
      const before = await page.locator(".projdetail").innerText();
      await look.first().click();
      const moved = await page.waitForFunction(
        prev => {
          const el = document.querySelector(".projdetail");
          if (!el) return false;
          const busy = document.querySelector(".projdetail [data-look-state]");
          const refused = document.querySelector(".projdetail [data-look-refusal]");
          return !!busy || !!refused || el.innerText !== prev;
        },
        before, { timeout: 30000 },
      ).then(() => true).catch(() => false);
      if (!moved) {
        throw new Error("the look button is on screen but pressing it changed nothing — " +
          "no busy state, no answer, no refusal");
      }
      const after = await page.locator(".projdetail").innerText();
      const refusal = await page.locator(".projdetail [data-look-refusal]").count();
      await shot(page, "projects-looked");
      return refusal > 0
        ? "pressed, and the reason it could not is on screen beside the button"
        : /looking at github/i.test(after) ? "pressed, and it says it is looking now"
        : "pressed, and what the screen says about GitHub changed";
    });
  } catch (err) {
    failGroup(PROJECT_GROUP.filter(n => !results.some(r => r.name === n)),
      `the Projects screen did not open (${err.message})`);
    await shot(page, "projects-broken");
  }
}

/* ---------------------------------------------------------------- summary */

function summarise() {
  const executed = results.length;
  const failed = results.filter(r => !r.pass);
  const passed = executed - failed.length;

  console.log("\n──────────────────────────────────────────────────────────────");
  console.log(`  THE INSTALLED APP, WALKED — ${passed}/${executed} checks passed`);
  console.log("──────────────────────────────────────────────────────────────");
  for (const r of results) {
    console.log(`  ${r.pass ? "on screen  " : "NOT ON SCR."}  ${r.name}`);
    if (r.detail) console.log(`                ${r.detail}`);
  }
  console.log(`\n  screenshots: ${SHOTS}\\app-*.png`);

  let short = false;
  if (executed === 0) {
    console.error("\nFAIL — this run checked nothing. Silence is not a green light.");
    short = true;
  } else if (executed < EXPECTED_CHECKS.length) {
    const never = EXPECTED_CHECKS.filter(n => !results.some(r => r.name === n));
    console.error(`\nFAIL — stopped early: ${executed} of ${EXPECTED_CHECKS.length} checks ran. ` +
      `Never ran, so UNKNOWN rather than fine:\n    ${never.join("\n    ")}`);
    short = true;
  }
  if (failed.length) {
    console.error(`\n${failed.length} feature(s) he asked for are NOT on his screen:`);
    for (const f of failed) console.error(`  · ${f.name}\n      ${f.detail}`);
  }
  return failed.length || short ? 1 : 0;
}

/* ------------------------------------------------------------------- main */

let browser = null;
let code = 1;
try {
  const launched = await launch();
  browser = launched.browser;
  await walk(launched.page);
  code = summarise();
} catch (err) {
  console.error(`\nThe harness could not do its job: ${err.message}`);
  summarise();
  code = 1;
} finally {
  await teardown(browser);
}
process.exit(code);
