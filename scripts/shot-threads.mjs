#!/usr/bin/env node
/**
 * shot-threads.mjs — photograph and MEASURE the thread's draggable edge in a
 * real, packaged Cloud9.
 *
 * WHY THIS EXISTS. A green build proves nothing about a screen, and a change was
 * rejected this week for exactly that. It also does not read pixels off the
 * pictures: the earlier round measured off screenshots and every figure was
 * about 15px out — the width of the divider it kept losing. Every number here
 * is `getBoundingClientRect()` on the real elements, over the app's own debug
 * port, and the picture is taken beside it so a person can see the same thing.
 *
 *   node scripts/shot-threads.mjs              this branch's release/win-unpacked
 *   node scripts/shot-threads.mjs --installed  the one Cloud9 he double-clicks
 *   node scripts/shot-threads.mjs --keep-open  leave the window up to look at
 *   node scripts/shot-threads.mjs --before     photograph WITHOUT this change
 *
 * WHICH BINARY. Printed at the top of every run and written into the report
 * file beside the pictures, with the bundle's own file name — a previous PR
 * described its own evidence wrongly because the main tree's win-unpacked held
 * a different branch's build.
 *
 * FRESH ONLY. A throwaway `--user-data-dir`, and the run ABORTS if that
 * redirection did not take rather than typing test messages into his real
 * Cloud9.
 */
import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGED_EXE = path.join(REPO_ROOT, "release", "win-unpacked", "Cloud9.exe");
const INSTALLED_EXE = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "Programs", "Cloud9", "Cloud9.exe");
const USE_INSTALLED = process.argv.includes("--installed");
const APP_EXE = USE_INSTALLED ? INSTALLED_EXE : PACKAGED_EXE;
const KEEP_OPEN = process.argv.includes("--keep-open");
const BEFORE = process.argv.includes("--before");
const SHOTS = path.join(REPO_ROOT, "docs", "qa", "threads-drag-2026-08-07");

/** His own window. The design page's figures are all against this viewport. */
const HIS_WIDTH = 1920;
const HIS_HEIGHT = 1080;

const notes = [];
const say = line => { console.log(line); notes.push(line); };

async function until(what, test, { timeout = 60000, every = 300 } = {}) {
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
  try { execFileSync("taskkill", ["/F", "/IM", "Cloud9.exe", "/T"], { stdio: "ignore" }); }
  catch { /* nothing was running, the normal case */ }
}

/**
 * Cloud9 holds a single-instance lock on its data folder, so a restart that
 * starts before the last one has really gone quits on the spot and the wait for
 * its debugger runs out with no explanation. Wait for the process to be gone,
 * never for a guessed number of seconds.
 */
async function waitTillGone() {
  await until("the old Cloud9 to be gone", () => {
    try {
      const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq Cloud9.exe"], { encoding: "utf8" });
      return !/Cloud9\.exe/i.test(out);
    } catch { return true; }
  }, { timeout: 60000, every: 500 });
}

async function shot(page, slug) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, `${BEFORE ? "before-" : ""}${slug}.png`);
  await page.screenshot({ path: file });
  say(`    photo  ${path.relative(REPO_ROOT, file)}`);
  return file;
}

/**
 * THE MEASUREMENT. The real element rects, never a reading off a picture.
 * `stored` is the number the app kept for him, read out of the same little
 * store the app itself reads — that is the whole of point 9 and it cannot be
 * seen in a photograph at all.
 */
const measure = page => page.evaluate(() => {
  const box = sel => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right) };
  };
  let stored = null;
  try { stored = JSON.parse(localStorage.getItem("cloud9.prefs") ?? "{}"); } catch { /* none */ }
  const grip = document.querySelector(".threadgrip");
  const mode = document.querySelector(".threadpanel.takeover")
    ? (document.querySelector(".threadpanel.forced") ? "takeover (window forced it)" : "takeover (he asked)")
    : "beside the room";
  return {
    viewport: window.innerWidth,
    room: box(".chatgrid > .thread"),
    thread: box(".threadpanel"),
    sidebar: box(".chatgrid > .sidebar"),
    grid: box(".chatgrid"),
    scrimShowing: !!document.querySelector(".threadscrim"),
    gripShowing: !!grip,
    gripTooltip: grip?.getAttribute("title") ?? null,
    gripSpoken: grip?.getAttribute("aria-label") ?? null,
    gripAriaMin: grip?.getAttribute("aria-valuemin") ?? null,
    gripAriaNow: grip?.getAttribute("aria-valuenow") ?? null,
    gripAriaMax: grip?.getAttribute("aria-valuemax") ?? null,
    modeButton: document.querySelector(".threadmode")?.getAttribute("aria-label") ?? null,
    roomAriaHidden: document.querySelector(".chatgrid > .thread")?.getAttribute("aria-hidden") ?? null,
    roomInert: !!document.querySelector(".chatgrid > .thread")?.inert,
    mode,
    storedWidth: stored?.threadWidth ?? null,
    storedTakeover: stored?.threadTakeover ?? null,
  };
});

/**
 * A take-over must remove the covered room from the real tab order, not merely
 * dim it. This walks actual Tab events and refuses a pass if focus lands in the
 * hidden room. It is run at both the requested and window-forced take-over.
 */
async function assertFocusIsolation(page, label) {
  const state = await page.evaluate(() => {
    const room = document.querySelector(".chatgrid > .thread");
    const first = document.querySelector(
      ".threadpanel button, .threadpanel textarea, .threadpanel input, .threadpanel select");
    first?.focus();
    return {
      inert: !!room?.inert,
      ariaHidden: room?.getAttribute("aria-hidden"),
      focusedInRoom: !!room?.contains(document.activeElement),
    };
  });
  if (!state.inert || state.ariaHidden !== "true" || state.focusedInRoom) {
    throw new Error(`${label} did not isolate the room (inert=${state.inert}, aria-hidden=${state.ariaHidden}, focusedInRoom=${state.focusedInRoom})`);
  }
  for (let i = 0; i < 40; i++) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() => {
      const room = document.querySelector(".chatgrid > .thread");
      return !!room?.contains(document.activeElement);
    });
    if (inside) throw new Error(`${label} Tab ${i + 1} entered the covered room`);
  }
  say(`      focus isolation: ${label} inert + aria-hidden; 40 Tab presses never entered the room`);
}

function assertDividerAria(m, label) {
  if (!m.gripShowing) throw new Error(`${label} has no divider to inspect`);
  const min = Number(m.gripAriaMin);
  const now = Number(m.gripAriaNow);
  const max = Number(m.gripAriaMax);
  if (min !== 300 || !Number.isFinite(now) || !Number.isFinite(max)
      || now < min || now > max || max < min) {
    throw new Error(`${label} divider aria is invalid (min=${m.gripAriaMin}, now=${m.gripAriaNow}, max=${m.gripAriaMax})`);
  }
  say(`      divider aria: min ${min}, now ${now}, max ${max}`);
}

async function assertPointerCleanup(page, label) {
  const state = await page.evaluate(() => ({
    bodyDragging: document.body.classList.contains("dragging-thread"),
    gripDragging: !!document.querySelector(".threadgrip.dragging"),
  }));
  if (state.bodyDragging || state.gripDragging) {
    throw new Error(`${label} left pointer-drag state behind (body=${state.bodyDragging}, grip=${state.gripDragging})`);
  }
  say(`      pointer cleanup: ${label} removed body and divider dragging state`);
}

function report(tag, m) {
  const thread = m.thread ? `${m.thread.w}px` : "not on screen";
  const room = m.room ? `${m.room.w}px` : "hidden";
  say(`  ${tag.padEnd(34)} viewport ${m.viewport}  thread ${String(thread).padStart(7)}  `
    + `room ${String(room).padStart(7)}  [${m.mode}]  kept: ${m.storedWidth}px`
    + `${m.storedTakeover ? " + takeover" : ""}`);
  if (m.gripShowing) say(`      the strip says: "${m.gripTooltip}"`);
  if (m.modeButton) say(`      the mode button is called: "${m.modeButton}"`);
}

/**
 * PULL THE REAL WINDOW, the way his own hand would.
 *
 * Not `Emulation.setDeviceMetricsOverride` and not a Playwright viewport: this
 * moves the actual Windows window with `MoveWindow`, because a pretend viewport
 * inside a window that never changed size is not what he does. Electron does not
 * answer `Browser.getWindowForTarget` at all, so the window handle comes from
 * Windows itself.
 *
 * The OUTER window is a few pixels wider than the area the app draws in — the
 * design page was caught out by exactly that once, quoting 1936 for a 1920
 * viewport — so this corrects until the VIEWPORT is the number asked for, and
 * the viewport is what everything downstream is measured against.
 */
function moveWindow(outer, height) {
  const ps = `
$ErrorActionPreference='Stop'
Add-Type @"
using System;using System.Runtime.InteropServices;
public class W{
 [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int t,bool r);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int c);
}
"@
$p = Get-Process Cloud9 -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { throw 'no Cloud9 window' }
$want = "${outer}"
if ($want -eq "max") {
  [void][W]::ShowWindow($p.MainWindowHandle, 3)
} else {
  [void][W]::ShowWindow($p.MainWindowHandle, 9)
  Start-Sleep -Milliseconds 150
  [void][W]::MoveWindow($p.MainWindowHandle, 0, 0, [int]$want, ${height}, $true)
}
`;
  execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore" });
}

/**
 * HIS OWN WINDOW SIZE IS THE MAXIMISED ONE. Measured here rather than assumed:
 * this screen is 1920 wide, a maximised window's frame runs -8 to 1928 (1936
 * across, which is the number the design page was once caught quoting) and the
 * area the app draws in is exactly 1920. So "1920" means maximised, and every
 * other size is an ordinary window pulled to `viewport + 16`.
 */
async function setWindow(page, width, height = HIS_HEIGHT) {
  const maximise = width >= 1920;
  let outer = maximise ? "max" : width + 16;
  for (let attempt = 0; attempt < 6; attempt++) {
    moveWindow(outer, height);
    await page.evaluate(() => new Promise(r => setTimeout(r, 300)));
    const inner = await page.evaluate(() => window.innerWidth);
    if (inner === width) {
      await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
      return;
    }
    if (maximise) break;
    outer += width - inner;
  }
  const got = await page.evaluate(() => window.innerWidth);
  throw new Error(`could not pull the window to a ${width}px viewport — it settled at ${got}px`);
}

/** Drag the strip with real pointer events, from where it is to where he wants it. */
async function dragGripTo(page, targetThreadWidth) {
  const strip = await page.locator(".threadgrip").boundingBox();
  if (!strip) throw new Error("NOT ON SCREEN — there is no strip to grab.");
  const grid = await page.locator(".chatgrid").boundingBox();
  const y = strip.y + strip.height / 2;
  await page.mouse.move(strip.x + strip.width / 2, y);
  await page.mouse.down();
  /* In steps, so this is a real drag the panel follows live rather than a jump. */
  const to = grid.x + grid.width - targetThreadWidth;
  const from = strip.x + strip.width / 2;
  for (let i = 1; i <= 12; i++) await page.mouse.move(from + (to - from) * (i / 12), y);
  await page.mouse.up();
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function openAThread(page) {
  /* Somewhere to talk. A fresh Cloud9 may need its first room made. */
  if (await page.locator('button:has-text("Make your first channel")').count()) {
    await page.click('button:has-text("Make your first channel")');
    await page.waitForSelector(".panel input", { timeout: 20000 });
    await page.fill(".panel input", "threads");
    await page.locator(".panel button").filter({ hasText: /create|make/i }).first().click();
  }
  await page.waitForSelector(".composer textarea", { timeout: 40000 });
  await page.fill(".composer textarea",
    "Where are we on the villa shortlist? I want the long version of this reply, "
    + "because the whole point of a wider thread is that a real paragraph stops "
    + "breaking after five or six words a line.");
  await page.press(".composer textarea", "Enter");
  const root = page.locator('.msgs .msg:has-text("villa shortlist")').last();
  await root.waitFor({ timeout: 30000 });
  await root.hover();
  const reply = root.locator(".ma.reply");
  if (await reply.count() === 0) throw new Error("NOT ON SCREEN — no Reply control to open a thread with");
  await reply.click();
  await page.waitForSelector(".threadpanel", { timeout: 20000 });
  /* A reply of his own, so the panel has something in it worth looking at. */
  await page.waitForSelector(".threadcomposer textarea", { timeout: 20000 });
  await page.fill(".threadcomposer textarea",
    "Two of them are still open. The kitchen on the second one is the better of "
    + "the two, and the third has the parking we wanted.");
  await page.press(".threadcomposer textarea", "Enter");
  await page.evaluate(() => new Promise(r => setTimeout(r, 400)));
}

async function main() {
  if (!fs.existsSync(APP_EXE)) {
    throw new Error(`no Cloud9 to photograph at: ${APP_EXE}\n`
      + "Run `npm run pack` first (that builds release/win-unpacked).");
  }
  killStale();

  /* WHICH BINARY, said out loud and written down. */
  const bundleDir = path.join(path.dirname(APP_EXE), "resources", "app", "dist-web", "assets");
  const bundle = fs.existsSync(bundleDir)
    ? fs.readdirSync(bundleDir).filter(f => f.endsWith(".js") || f.endsWith(".css")).sort()
    : ["(no dist-web found beside the exe)"];
  say(`BINARY: ${APP_EXE}`);
  say(`  built ${fs.statSync(APP_EXE).mtime.toISOString()}`);
  say(`  web bundle: ${bundle.join("  ")}`);

  const port = await freePort();
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-threads-"));
  const child = spawn(APP_EXE, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`],
    { detached: true, stdio: "ignore", env: { ...process.env, CLOUD9_DEMO: "1" } });
  child.unref();

  await until("the app's debugger to answer", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    return !!r?.ok;
  }, { timeout: 180000 });
  await until("the app to build its database in the throwaway folder",
    () => fs.existsSync(path.join(userData, "cloud9-relay.db")), { timeout: 120000 })
    .catch(() => { killStale(); throw new Error("--user-data-dir was ignored — refusing to touch his real Cloud9."); });

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let page = null;
  await until("Cloud9's own window to appear", async () => {
    page = browser.contexts().flatMap(c => c.pages()).find(p => /dist-web|index\.html/i.test(p.url()));
    return !!page;
  }, { timeout: 90000 });
  await page.waitForSelector(".rail .rail-btn, .welcome", { timeout: 90000 });
  if (await page.locator("text=Enter Cloud9").count()) {
    await page.click("text=Enter Cloud9");
    await page.waitForSelector(".rail .rail-btn", { timeout: 60000 });
  }

  await setWindow(page, HIS_WIDTH);
  await openAThread(page);

  /* ---- 1. his own window, before he touches anything --------------------- */
  say("\n1 · HIS OWN WINDOW, thread just opened");
  let m = await measure(page);
  report("as it opens", m);
  if (m.thread?.w !== 388) throw new Error(`startup drew ${m.thread?.w}px, not the 388px default`);
  assertDividerAria(m, "startup");
  await shot(page, "1-his-window-as-it-opens");

  if (BEFORE) {
    /* The old build has no strip to grab and no take-over to ask for, so all
       that can be recorded is what it does at each size on its own. */
    for (const w of [1330, 894, 800]) {
      await setWindow(page, w);
      report(`at ${w}px`, await measure(page));
      await shot(page, `at-${w}`);
    }
    await setWindow(page, HIS_WIDTH);
    await finish(page, browser, userData);
    return;
  }

  /* ---- 2. dragged wide, then narrow -------------------------------------- */
  say("\n2 · DRAGGED, with real pointer events");
  await dragGripTo(page, 1100);
  const draggedWide = await measure(page);
  report("dragged wide", draggedWide);
  assertDividerAria(draggedWide, "dragged wide");
  await assertPointerCleanup(page, "dragged wide");
  await shot(page, "2-dragged-wide");

  await dragGripTo(page, 340);
  const draggedNarrow = await measure(page);
  report("dragged narrow", draggedNarrow);
  assertDividerAria(draggedNarrow, "dragged narrow");
  await assertPointerCleanup(page, "dragged narrow");
  await shot(page, "3-dragged-narrow");

  /* Past the floor on purpose: the room must not be allowed to disappear. */
  await dragGripTo(page, 3000);
  const pushed = await measure(page);
  report("dragged past the room's floor", pushed);
  if (pushed.room.w < 300) throw new Error(`the room fell to ${pushed.room.w}px — its floor is 300`);
  assertDividerAria(pushed, "room floor");
  await assertPointerCleanup(page, "room floor");
  await shot(page, "4-room-floor-holds");

  /* ---- 3. the keyboard --------------------------------------------------- */
  say("\n3 · THE KEYBOARD (Slack ships this; a mouse-only control is not acceptable)");
  await dragGripTo(page, 600);
  await page.focus(".threadgrip");
  const beforeKeys = (await measure(page)).thread.w;
  for (let i = 0; i < 6; i++) await page.keyboard.press("ArrowLeft");
  const afterLeft = await measure(page);
  report("after 6 × ArrowLeft", afterLeft);
  if (afterLeft.thread.w !== beforeKeys + 6 * 16) {
    throw new Error(`arrow keys moved it ${afterLeft.thread.w - beforeKeys}px, expected 96`);
  }
  await shot(page, "5-keyboard-arrow-keys");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  report("after 3 × ArrowRight", await measure(page));

  /* ---- 4. double-click puts it back, and the tooltip stops offering it ---- */
  say("\n4 · DOUBLE-CLICK PUTS IT BACK, and the tooltip is conditional");
  const custom = await measure(page);
  if (!/Double-click/.test(custom.gripTooltip)) {
    throw new Error(`the tooltip should offer a reset once he has set a width: "${custom.gripTooltip}"`);
  }
  await page.dblclick(".threadgrip");
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const back = await measure(page);
  report("after a double-click", back);
  if (back.thread.w !== 388) throw new Error(`double-click gave ${back.thread.w}px, not the 388 default`);
  if (/Double-click/.test(back.gripTooltip)) {
    throw new Error(`the tooltip still offers a reset with nothing to reset: "${back.gripTooltip}"`);
  }
  await shot(page, "6-double-click-reset");

  /* ---- 5. the take-over mode, and the way back --------------------------- */
  say("\n5 · THE TAKE-OVER MODE — he asked for this as well as the divider");
  await dragGripTo(page, 900);            // a width worth proving survives it
  await page.click(".threadmode");
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const over = await measure(page);
  report("taken over", over);
  if (!over.scrimShowing) throw new Error("the room vanished instead of dimming behind the thread");
  if (over.modeButton !== "show thread beside channel") {
    throw new Error(`the way back is called "${over.modeButton}", not Buzz's own words`);
  }
  await assertFocusIsolation(page, "wide takeover");
  await shot(page, "7-take-over-the-room");

  await page.click(".threadmode");
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const beside = await measure(page);
  report("back beside the room", beside);
  if (beside.thread.w !== 900) throw new Error(`his 900px did not survive the round trip: ${beside.thread.w}px`);
  await shot(page, "8-back-beside-the-channel");

  /* ---- 6. the narrow window — the take-over IS the answer ----------------- */
  say("\n6 · A NARROW WINDOW. His width is BORROWED, never rewritten.");
  await setWindow(page, 894);
  const at894 = await measure(page);
  report("at 894px (the last size that splits)", at894);
  if (!at894.gripShowing) throw new Error("894 should still split and still have a strip");
  if (at894.thread?.w !== 300 || at894.room?.w !== 300) {
    throw new Error(`894 should draw an exact 300/300 split (thread=${at894.thread?.w}, room=${at894.room?.w})`);
  }
  assertDividerAria(at894, "894px");
  await shot(page, "9-at-894-still-splits");

  await setWindow(page, 800);
  const at800 = await measure(page);
  report("at 800px (too narrow to split)", at800);
  if (at800.gripShowing) throw new Error("a strip that cannot move is a refusal with no door");
  if (!/forced/.test(at800.mode)) throw new Error("800px did not hand the area to the thread");
  if (at800.storedWidth !== 900) throw new Error(`his 900 was overwritten to ${at800.storedWidth}`);
  await assertFocusIsolation(page, "800 forced takeover");
  await shot(page, "10-at-800-thread-takes-over");

  await setWindow(page, 1330);
  const at1330 = await measure(page);
  report("at 1330px (the sidebar steps to 216)", at1330);
  if (at1330.storedWidth !== 900) throw new Error(`his 900 was overwritten to ${at1330.storedWidth}`);
  await shot(page, "11-at-1330-borrowed");

  await setWindow(page, HIS_WIDTH);
  const backWide = await measure(page);
  report("back at 1920px — his own number returns", backWide);
  if (backWide.thread.w !== 900) throw new Error(`his 900 did not come back: ${backWide.thread.w}px`);
  await shot(page, "12-his-width-came-back");

  /* ---- 7. AFTER A RESTART ------------------------------------------------ */
  say("\n7 · AFTER A RESTART — both the width and the mode must come back");
  await page.click(".threadmode");        // leave it taken over, at 900px
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const beforeQuit = await measure(page);
  report("as it was left", beforeQuit);
  /* QUIT IT THE WAY HE WOULD — close the window, do not shoot the process.
     A `taskkill /F` takes the app away before Chromium has flushed the little
     settings store to disk, and then a setting he changed a second earlier is
     "forgotten" by the harness and not by the app. Closing the window is what
     his own hand does, and it is the only quit worth testing. */
  await page.close().catch(() => {});
  await waitTillGone().catch(() => { killStale(); });
  await waitTillGone();

  const port2 = await freePort();
  const child2 = spawn(APP_EXE, [`--remote-debugging-port=${port2}`, `--user-data-dir=${userData}`],
    { detached: true, stdio: "ignore", env: { ...process.env, CLOUD9_DEMO: "1" } });
  child2.unref();
  await until("the restarted app's debugger to answer", async () => {
    const r = await fetch(`http://127.0.0.1:${port2}/json/version`).catch(() => null);
    return !!r?.ok;
  }, { timeout: 180000 });
  const browser2 = await chromium.connectOverCDP(`http://127.0.0.1:${port2}`);
  let page2 = null;
  await until("the restarted window", async () => {
    page2 = browser2.contexts().flatMap(c => c.pages()).find(p => /dist-web|index\.html/i.test(p.url()));
    return !!page2;
  }, { timeout: 90000 });
  await page2.waitForSelector(".rail .rail-btn", { timeout: 90000 });
  await setWindow(page2, HIS_WIDTH);
  /* Open the same thread again — the width and the mode are the app's to
     remember, not the thread's. */
  const root2 = page2.locator('.msgs .msg:has-text("villa shortlist")').last();
  await root2.waitFor({ timeout: 40000 });
  await root2.hover();
  await root2.locator(".ma.reply").click();
  await page2.waitForSelector(".threadpanel", { timeout: 20000 });
  await page2.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const restarted = await measure(page2);
  report("after quitting and starting again", restarted);
  if (restarted.storedWidth !== 900) throw new Error(`the width was forgotten: ${restarted.storedWidth}`);
  if (restarted.storedTakeover !== true) throw new Error("the mode was forgotten");
  if (!/takeover/.test(restarted.mode)) throw new Error("it came back beside the room, not over it");
  await shot(page2, "13-after-a-restart-mode-came-back");

  await page2.click(".threadmode");
  await page2.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  const restartedWidth = await measure(page2);
  report("and his width is still 900", restartedWidth);
  if (restartedWidth.thread.w !== 900) throw new Error(`the width came back as ${restartedWidth.thread.w}px`);
  await shot(page2, "14-after-a-restart-width-came-back");

  await finish(page2, browser2, userData);
}

async function finish(page, browser, userData) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, BEFORE ? "measured-before.txt" : "measured.txt");
  fs.writeFileSync(file, `${notes.join("\n")}\n`);
  console.log(`\nwritten  ${path.relative(REPO_ROOT, file)}`);
  if (KEEP_OPEN) { console.log("left open (--keep-open)"); return; }
  await browser.close().catch(() => {});
  killStale();
  /* Windows can still be holding the throwaway database open a moment after
     the app goes. It is in %TEMP% and it is not evidence — a failure to sweep
     it must not turn a green run red. */
  try { fs.rmSync(userData, { recursive: true, force: true }); }
  catch { console.log(`  (left ${userData} for Windows to clear)`); }
}

main().catch(err => {
  console.error(`\nFAILED: ${err.message}`);
  if (!KEEP_OPEN) killStale();
  process.exitCode = 1;
});
