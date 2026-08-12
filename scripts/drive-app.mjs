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
import { clickRail } from "./rail-navigation.mjs";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { artifactRef } from "@cloud9/shared";
/* WHERE AN AGENT'S ANSWER LIVES — the same one owner the browser suite uses,
   imported rather than re-spelled here. Since 2026-08-04 an answer hangs off the
   message it answers, in the channel as well as inside a thread, and a harness
   that kept its own idea of where to look would be the next thing to go red for
   a feature that works. See the long note on `waitForAgentAnswer`. */
import { waitForAgentAnswer } from "./qa-target.mjs";

/* ------------------------------------------------------------------ where */

const APP_EXE = path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "Programs", "Cloud9", "Cloud9.exe");

const REAL_USER_DATA = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Cloud9");

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SHOTS = path.join(REPO_ROOT, "docs", "qa");

/* ------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const valueOf = f => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

const OPTS = {
  fresh: !has("--real-data"),
  keepOpen: has("--keep-open"),
  port: valueOf("--port") ? Number(valueOf("--port")) : undefined,
  sidecarProbe: has("--sidecar-probe"),
  sidecarCleanupSimulation: has("--sidecar-cleanup-simulation"),
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
  "Projects is visibly reachable from the rail",
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
  /* The 15 researched skills sat in shared code for a day with nothing on screen
     to reach them. This asks the INSTALLED app whether he can open the library
     and whether what a skill came from is on the card — the provenance is the
     part he specifically asked for when he asked for research. */
  "the skill library opens from an agent, with its shelves and its sources",
  /* 2026-08-01, his report: every Codex agent refused to start, because the
     editor let him keep switches off that Codex's own program cannot honour.
     The fix locks those switches visibly ON with the reason on the row. This
     asks the INSTALLED app: put an agent on Codex — do they lock and say why;
     put it back on Claude — are his own settings back. */
  "on Codex, the switches Codex cannot give up lock on and say why",
  /* 2026-08-01, his report: "GitHub integration is not there" — it existed but
     only as typed commands, with no door on screen. The fix is one Actions
     menu at the message box. This asks the INSTALLED app: is the button there,
     does it open, does choosing a row really fill in the command. */
  "the message box offers an Actions menu that fills in the command",
  /* 2026-08-01, his report: "Cloud9 doesn't give me a connected GitHub
     account." gh was signed in all along — no screen said so. The fix is a
     GitHub card in Settings whose facts come from really asking gh. This asks
     the INSTALLED app: is the card there, does it claim one honest state, and
     does it say when it actually looked. */
  "Settings shows the GitHub card with an honest, dated state",
  /* 2026-08-02, his ask: connecting a project should show HIS repositories to
     click, like Slack or Buzz — not make him type owner/name from memory.
     This asks the INSTALLED app, against real gh: does the panel really list
     them, dated, and does clicking one connect it. */
  "the connect panel lists his own repositories, and clicking one connects it",
  /* Same ask, the deeper half: a project can name the folder on this computer
     where its code lives, so agents can really work on it. The honest empty
     state matters as much as the linked one. */
  "a project shows where its code lives on this computer, or honestly says nowhere yet",
  /* Feature 1: the installed app must carry the same Files truths as the browser
     suite — a door, provenance, retained history, honest access, typed links,
     and no guessed relationships from markdown words. */
  "the Files screen opens from the rail as one readable-room workspace",
  "a Files row names the latest maker and exact producing turn",
  "Files opens the retained immutable version history",
  "Files says room-visible by default and only managers can edit access",
  "Files can save a restriction while keeping room managers required",
  "a typed file link is shown as a control and follows the exact version",
  "markdown words inside a file do not become stored file links",
  /* Feature 3: one box that finds words anywhere he may already look. The walk
     asks the INSTALLED app the two things a person would: does it find a
     message he really typed AND a file an agent really made, and does clicking
     the message land him on that message in the room it was said in. */
  "search everywhere finds a seeded message and file, and the message result lands in its room",
  /* Feature 4: turn coordination, in the app he actually opens.
     Each of these exists for one thing that used to be invisible or wrong:
     · [29] a job that is in trouble used to say nothing about WHY on the screen
       he reads — and the fix must not invent a reason either, so the same check
       holds a job with nothing recorded to saying exactly that;
     · [30] a stuck job used to be printed in with the ones genuinely moving, so
       a job waiting on somebody could sit for an hour looking healthy;
     · [31] an agent whose job was stuck still read "Ready" on its presence line,
       which is the same one fact told two different ways;
     · [32] naming several agents in one message used to start a turn for each of
       them — three subscriptions spent and three half-answers to read. */
  "a job in trouble says why in plain words, and one with nothing recorded says so",
  "a stuck job reads as stuck and is not listed in with the running ones",
  "an agent whose job is stuck says so on its presence line instead of reading as fine",
  "naming two agents in one message gets exactly one answer, from the first one named",
  /* Feature 5, in the app he double-clicks. Two things that only exist as
     SCREEN in this release, so a preview passing proves nothing about them:
     · the agent editor's connections block — the switch "Use connected
       services" used to be on, allowed, approved and hand the agent nothing;
       the block must now be there and claim exactly one of its four honest
       states (none / that file is gone / in use / cannot check), never a
       reassuring blank;
     · the room details panel's mute control, with its own words about what
       muting really does — the whole point of feature 5's first half.
     The walk does NOT open the operating system's file picker and does NOT
     raise a real Windows notification: driving a native dialog is not something
     this harness can do honestly, so it asserts what is observable on screen
     and says so rather than pretending to have proved the shell. */
  "the agent editor shows the connections file in an honest state, and a room offers the mute control",
  /* Threads, in the app he double-clicks. His complaint was that an agent
     "does not have a conversation inside the threads" — every answer, including
     an answer to a question asked INSIDE a thread, came back into the room and
     broke the thread in half. The browser suite holds both halves of that; this
     asks the INSTALLED app the one that matters, with a real engine turn on this
     computer: ask an agent inside a thread, and the answer must be in that
     thread and NOT a row in the conversation. Proved by message id, so an agent
     chiming in about something else in the room cannot be mistaken for the
     answer leaking out. */
  "an agent asked inside a thread answers inside that thread, not in the conversation",
  /* 2026-08-04, the chat-experience round. Two of its promises are about the
     message box and the view — things a preview in a browser can agree with
     while the app he double-clicks does something else, because the installed
     app ships its own stylesheet and its own window size. So the walk asks the
     INSTALLED app the two questions a person would notice within a minute:
     is the box calm until I click into it (and does it show its tools when I
     do), and does pressing Enter actually put me on what I just said. */
  "the message box is calm until he clicks into it, and Enter lands him on what he just said",
  /* 2026-08-05, and the reason this walk was 36/36 while the app was useless:
     Settings said "Claude — not installed on this computer · ✗ app not found",
     with the sign-in button greyed out, on a computer where `claude` was
     installed and signed in the whole time. THIRTY-SIX CHECKS AND NOT ONE OF
     THEM LOOKED AT THE CARD THAT DECIDES WHETHER ANY AGENT CAN RUN — the only
     thing this walk ever asserted on the Settings screen was the GitHub card.
     So the two questions a person asks in the first ten seconds now get asked
     here, every run, of the app he double-clicks:
       · did the engine ever say what it found, or is the card still "checking"
         (an engine that never connects looks EXACTLY like a missing app);
       · does what the card says match what this computer can really do — the
         walk runs `claude --version` and `codex --version` itself and refuses
         to accept a card that disagrees, in either direction. */
  "the app says what it found about Claude and Codex, instead of checking forever",
  "Settings agrees with this computer about whether Claude and Codex are really there",
  /* 2026-08-05, and the loudest report yet: "cloud9 is not able to access my
     pc… when I say from a chat 'go and read this file on my pc' it is always
     saying I do not have access to this folder."
     Nothing in the chain was broken — `--add-dir` reached the command line and
     the CLI read the file, proved live the same day. The agent he was TALKING
     to simply had no folder opened up for it, and its reply said "I can't reach
     files outside this directory" and stopped there. A true sentence, a dead
     end, and from where he sits indistinguishable from a broken app.
     So this walks the whole journey in the app he double-clicks, in his order:
       · an agent with no folder says so IN THE ROOM, with the way to change it
         on the same line — the dead end is gone from the screen too;
       · give it a real folder on this computer;
       · type an ordinary chat message asking it to read a real file in there;
       · the answer must contain what is actually in that file.
     THE NATIVE FOLDER PICKER IS NOT DRIVEN — a Windows dialog is not something
     this harness can press honestly. The folder is chosen through the window's
     own save path (the very frame the editor sends), and this check says so
     rather than pretending it clicked through Explorer. */
  "an agent asked in chat to read a real file on this computer actually reads it",
  /* 2026-08-06, and deliberately only TWO added for a night that landed a dozen
     features: everything else about them can be proved in a browser, and a walk
     that grows with every feature stops being run. These two cannot:
       · A PICTURE. "Can it see the image I attached" is a question about a real
         model looking at real bytes. A preview with canned replies can agree
         with itself all day; only the installed app puts the picture in front
         of a real Claude. The trap is set on purpose — the file is NAMED after
         one colour and IS another, so an answer that guessed from the file name
         is not just unproven, it is caught.
       · STOPPING A REAL TURN. The stop button has to kill a child process that
         is really running on this computer. There is no child process in a
         browser suite, so its "stopped" is a state machine agreeing with
         itself; here it is a real CLI that has to actually stop, and a record
         that has to say STOPPED rather than failed. */
  "an agent shown a picture answers from what is inside it, not from its name",
  "stopping a real running turn really stops it, and the record says stopped, not failed",
  /* 2026-08-07, his ask: "i want to add about token consumption so that agents
     can see and help optimize others agents automatically."
     Cloud9 had recorded what every Claude turn cost since run records existed
     and never showed him one of those figures anywhere he would look, so the
     first and largest half of this is simply A DOOR. This check exists because
     that is exactly the failure this harness was built for: the arithmetic and
     the hub can be perfect and green, and if there is no way to REACH it from
     the window he double-clicks, he has nothing.
     It asks the installed app the two things a person would: is Spending in the
     rail, and does pressing it land on a page that says something honest —
     either real figures, or "nothing recorded yet" — rather than a blank. */
  "Spending is in the rail and opens a page that answers honestly",
];

/* --------------------------------------------- what this computer really has
 *
 * The walk must be able to say "the card is LYING", which means having its own
 * answer that owes nothing to the app. So it runs the CLI the same way a person
 * at a terminal would — through the shell, because both are npm/.cmd shims —
 * and treats anything but a clean exit as absent. The leash is generous on
 * purpose: these are cold Node starts (measured ~5-9s on this machine), and a
 * harness that called a slow answer a missing app would be repeating the exact
 * bug it exists to catch.
 */
const HARNESS_CARDS = ["claude", "codex"];

function cliOnThisComputer(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf8", shell: true, timeout: 120000, stdio: ["ignore", "pipe", "pipe"],
    });
    return { present: true, version: (out.trim().split(/\r?\n/)[0] ?? "").slice(0, 60) };
  } catch (err) {
    return { present: false, why: (err?.shortMessage ?? err?.message ?? String(err)).slice(0, 120) };
  }
}

/**
 * IS THIS CLI SIGNED IN, asked by the walk itself.
 *
 * ================================================================
 * WHY (2026-08-12) — check 37 was asserting half a card.
 * ================================================================
 *
 * The Settings card draws TWO independent facts and check 37 only ever compared
 * one of them: it matched "✓ app found" against `<cli> --version` and never
 * asked about signing in. Detection can return `installed:true, signedIn:false`
 * — and every agent then answers "my engine isn't connected" — while that check
 * passes. Blocker 3 was exactly that machine, and 36/36 said nothing about it.
 *
 * The leashes are long on purpose, and generous compared with the app's own:
 * `claude auth status` was MEASURED at 77 seconds on this computer with Cloud9
 * running (`harness.ts`). A walk whose own probe gave up early would accuse the
 * card of lying whenever the machine was busy, which is a flaky check — worse
 * than a weak one.
 *
 * `answered: false` is returned for a probe that did not come back, and the
 * caller treats that as "this walk does not know", never as "signed out".
 */
function signedInOnThisComputer(name) {
  const args = name === "codex" ? ["login", "status"] : ["auth", "status"];
  try {
    const out = execFileSync(name, args, {
      encoding: "utf8", shell: true, timeout: 240000, stdio: ["ignore", "pipe", "pipe"],
    });
    if (name === "codex") {
      // the same reading `detectCodex` does: exit 0 and no "not logged in"
      return { answered: true, signedIn: !/not logged in/i.test(out) };
    }
    /* And the same reading `detectClaude` does — the JSON is the answer when
       there is one, so the walk and the app cannot disagree about what the CLI
       said, only about what each of them saw. */
    const parsed = (() => { try { return JSON.parse(out.trim()); } catch { return null; } })();
    if (parsed && typeof parsed.loggedIn === "boolean") {
      return { answered: true, signedIn: parsed.loggedIn };
    }
    return { answered: true, signedIn: true }; // exit 0 with no verdict in it
  } catch (err) {
    if (err?.signal === "SIGTERM" || /ETIMEDOUT|timed? out/i.test(String(err?.message ?? ""))) {
      return { answered: false, why: "this computer did not answer in time either" };
    }
    const said = `${err?.stdout ?? ""} ${err?.stderr ?? ""}`;
    const parsed = (() => { try { return JSON.parse(String(err?.stdout ?? "").trim()); } catch { return null; } })();
    if (parsed && typeof parsed.loggedIn === "boolean") {
      return { answered: true, signedIn: parsed.loggedIn };
    }
    // a non-zero exit with something to say IS an answer: not signed in
    return { answered: true, signedIn: false, why: said.replace(/\s+/g, " ").trim().slice(0, 120) };
  }
}

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
 * Run a check whose temporary state MUST be put back before anything continues.
 *
 * The ordinary `check` deliberately catches feature failures so the walk can
 * report the rest. Cleanup is different: if it fails, later answers are about a
 * poisoned state. Record the feature result only after cleanup succeeds; a
 * cleanup failure escapes and stops the containing walk section.
 */
async function checkWithRequiredCleanup(name, fn, cleanup) {
  let detail = "";
  let problem = null;
  let cleanupProblem = null;
  try {
    const answer = await fn();
    detail = typeof answer === "string" ? answer : "";
  } catch (err) {
    const message = err?.message ?? String(err);
    if (err?.requiredCleanupFailure === true) cleanupProblem = message;
    else problem = message;
  } finally {
    try {
      await cleanup();
    } catch (err) {
      const message = err?.message ?? String(err);
      cleanupProblem = cleanupProblem ? `${cleanupProblem}; cleanup callback: ${message}` : message;
    }
  }
  if (cleanupProblem) {
    fail(name, `cleanup failed — ${cleanupProblem}${problem ? `; original check: ${problem}` : ""}`);
    throw new Error(`required Files cleanup failed; later checks are invalid (${cleanupProblem})`);
  }
  if (problem) fail(name, problem);
  else pass(name, detail);
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

/**
 * Wait for a thing to become true, rather than sleeping for a guess — AND HAND
 * BACK WHAT IT FOUND.
 *
 * IT USED TO RETURN A BARE `true` (fixed 2026-08-06). Every waiter that also
 * wanted the thing it was waiting FOR — "wait until a run card says the owner
 * stopped it, then read that card" — silently got `true` instead. The next line
 * then asked `true` for its words, got `undefined`, and the check died on
 * "Cannot read properties of undefined" while pointing at the feature. A
 * harness that throws a confusing error at the app is worse than no harness.
 *
 * So the callback's own value comes back. Nothing that ignores it changes —
 * every existing waiter reads the answer as a plain truthy — and a waiter that
 * wants the value can no longer be handed a `true` that looks like one.
 */
async function until(what, fn, { timeout = 60000, every = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try { const found = await fn(); if (found) return found; } catch (err) { last = err; }
    if (Date.now() > deadline) {
      throw new Error(`gave up after ${Math.round(timeout / 1000)}s waiting for ${what}` +
        (last ? ` (last error: ${last.message})` : ""));
    }
    await new Promise(r => setTimeout(r, every));
  }
}

/** Exact identity of the version a publish must have produced. */
function publishedArtifactMatches(frame, expected) {
  if (frame?.type !== "artifact") return false;
  const artifact = frame.artifact;
  const version = artifact?.versions?.find(v => v.version === expected.version);
  const newest = artifact?.versions?.reduce((best, v) => !best || v.version > best.version ? v : best, null);
  return artifact?.name === expected.name
    && artifact?.channelId === expected.channelId
    && (!expected.artifactId || artifact.id === expected.artifactId)
    && newest?.version === expected.version
    && version?.size === expected.size
    && version?.sha256 === expected.sha256
    && version?.agentId === expected.agentId
    && version?.agentName === expected.agentName
    && (version?.runId ?? null) === (expected.runId ?? null);
}

/** Direct verification answers must belong to this exact request as well. */
function verifiedPublishedArtifactMatches(frame, requestId, expected) {
  return frame?.requestId === requestId && publishedArtifactMatches(frame, expected);
}

/** A refresh passes only when this exact post-start request got its own answer. */
function workspaceRefreshCompleted(observation) {
  const { probe, answers, workspace } = observation;
  return typeof probe.requestId === "string" && probe.requestId.length > 0
    && typeof probe.socketId === "string" && probe.socketId.length > 0
    && probe.sentSequence > 0
    && probe.responseRequestId === probe.requestId
    && probe.responseSocketId === probe.socketId
    && probe.responseSequence > probe.sentSequence
    && answers > probe.baselineAnswers
    && workspace.asked === true && workspace.loading === false;
}

/** Decode only text WebSocket frames reported by Chrome's Network domain. */
function cdpWebSocketTextFrame(event) {
  if (typeof event?.requestId !== "string" || event.requestId.length === 0
    || event.response?.opcode !== 1 || typeof event.response.payloadData !== "string") {
    return null;
  }
  try {
    const frame = JSON.parse(event.response.payloadData);
    return frame && typeof frame === "object" && !Array.isArray(frame)
      ? { socketId: event.requestId, frame }
      : null;
  } catch {
    return null;
  }
}

/**
 * Observe the renderer's existing socket without changing the renderer.
 *
 * One dedicated CDP session owns both frame listeners and their complete
 * lifecycle. It starts accepting candidates only immediately before the visible
 * Refresh click, binds the first outbound workspace request to its CDP socket,
 * and accepts only a later response/refusal with the same app id and socket id.
 */
async function createWorkspaceRefreshObserver(page, baselineAnswers) {
  const session = await page.context().newCDPSession(page);
  let sequence = 0;
  let started = false;
  let enableAttempted = false;
  let sent = null;
  let response = null;
  let refusal = null;
  let problem = null;
  let disposePromise = null;

  const rememberProblem = message => { if (!problem) problem = message; };
  const onSent = event => {
    const decoded = cdpWebSocketTextFrame(event);
    if (!started || !decoded || decoded.frame.type !== "artifactWorkspace") return;
    const currentSequence = ++sequence;
    const requestId = decoded.frame.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) {
      rememberProblem("the Files Refresh sent a malformed artifactWorkspace request without an id");
      return;
    }
    if (sent) {
      rememberProblem("more than one artifactWorkspace request was sent after the Files Refresh observer started");
      return;
    }
    sent = { requestId, socketId: decoded.socketId, sequence: currentSequence };
  };
  const onReceived = event => {
    const decoded = cdpWebSocketTextFrame(event);
    if (!started || !decoded) return;
    const currentSequence = ++sequence;
    if (!sent || currentSequence <= sent.sequence
      || decoded.socketId !== sent.socketId
      || decoded.frame.requestId !== sent.requestId) return;
    if (decoded.frame.type === "error") {
      refusal = {
        requestId: decoded.frame.requestId,
        socketId: decoded.socketId,
        sequence: currentSequence,
        error: decoded.frame.error ?? "the installed hub refused the Files Refresh request",
      };
      return;
    }
    if (decoded.frame.type !== "artifactWorkspace") return;
    if (response) {
      rememberProblem("the Files Refresh received more than one matching artifactWorkspace response");
      return;
    }
    response = {
      requestId: decoded.frame.requestId,
      socketId: decoded.socketId,
      sequence: currentSequence,
    };
  };

  const observer = {
    start() {
      if (started) throw new Error("the Files Refresh CDP observer was started twice");
      started = true;
    },
    snapshot() {
      if (problem) throw new Error(problem);
      if (refusal) throw new Error(`the installed hub refused Files Refresh ${refusal.requestId}: ${refusal.error}`);
      return {
        baselineAnswers,
        requestId: sent?.requestId ?? null,
        socketId: sent?.socketId ?? null,
        sentSequence: sent?.sequence ?? 0,
        responseRequestId: response?.requestId ?? null,
        responseSocketId: response?.socketId ?? null,
        responseSequence: response?.sequence ?? 0,
      };
    },
    dispose() {
      if (disposePromise) return disposePromise;
      disposePromise = (async () => {
        const cleanupProblems = [];
        try {
          if (enableAttempted) await session.send("Network.disable");
        } catch (err) {
          cleanupProblems.push(`Network.disable: ${err?.message ?? String(err)}`);
        } finally {
          try {
            session.off("Network.webSocketFrameSent", onSent);
            session.off("Network.webSocketFrameReceived", onReceived);
          } catch (err) {
            cleanupProblems.push(`listener removal: ${err?.message ?? String(err)}`);
          } finally {
            try {
              await session.detach();
            } catch (err) {
              cleanupProblems.push(`CDP detach: ${err?.message ?? String(err)}`);
            }
          }
        }
        if (cleanupProblems.length > 0) {
          throw new Error(cleanupProblems.join("; "));
        }
      })();
      return disposePromise;
    },
  };

  try {
    session.on("Network.webSocketFrameSent", onSent);
    session.on("Network.webSocketFrameReceived", onReceived);
    enableAttempted = true;
    await session.send("Network.enable");
    return observer;
  } catch (err) {
    try {
      await observer.dispose();
    } catch (cleanupErr) {
      const requiredCleanupError = new Error(
        `could not enable the Files Refresh CDP observer (${err?.message ?? String(err)}); ` +
        `cleanup also failed (${cleanupErr?.message ?? String(cleanupErr)})`);
      requiredCleanupError.requiredCleanupFailure = true;
      throw requiredCleanupError;
    }
    throw err;
  }
}

/** Fetch one exact retained version through the same one-use ticket as the UI. */
async function fetchArtifactBytes(page, artifactId, version) {
  const answer = await page.evaluate(async ({ artifactId: id, version: v }) => {
    const ticket = await window.cloud9Artifacts.ticket(id, v);
    const response = await fetch(ticket.url);
    const bytes = [...new Uint8Array(await response.arrayBuffer())];
    return { status: response.status, bytes };
  }, { artifactId, version });
  if (answer.status !== 200) {
    throw new Error(`artifact ${artifactId} v${version} fetch returned HTTP ${answer.status}`);
  }
  return Buffer.from(answer.bytes);
}

/** Prove exact bytes, not text rendered by a preview component. */
async function assertArtifactBytes(page, artifactId, version, expected, what) {
  const actual = await fetchArtifactBytes(page, artifactId, version);
  const wanted = Buffer.from(expected);
  if (!actual.equals(wanted)) {
    throw new Error(`${what} returned different bytes: expected ${wanted.toString("base64")}, ` +
      `got ${actual.toString("base64")}`);
  }
  return actual.length;
}

/**
 * Publish installed-app evidence through its real embedded hub, as its engine.
 *
 * The packaged app already placed its private hub key in this renderer so the
 * screen could sign in. This reads it into memory only, never prints it and never
 * writes it anywhere. The relay address comes from the installed window's own
 * query string, so this cannot accidentally publish into a dev hub.
 */
function createOwnedEngineSocket(ws) {
  let closePromise = null;
  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      if (ws.readyState === WebSocket.CLOSED) return;
      await withDeadline(() => new Promise((resolve, reject) => {
        const onClose = () => { cleanup(); resolve(); };
        const cleanup = () => {
          ws.removeEventListener("close", onClose);
          ws.removeEventListener("error", onError);
        };
        const onError = () => {
          /* A connection error during local shutdown is acceptable only if the
             socket still reaches its close event before the deadline. */
        };
        ws.addEventListener("close", onClose, { once: true });
        ws.addEventListener("error", onError);
        try { ws.close(); }
        catch (err) { cleanup(); reject(err); }
      }), 10000, "installed engine WebSocket close");
      if (ws.readyState !== WebSocket.CLOSED) {
        throw new Error(`installed engine WebSocket remained in state ${ws.readyState}`);
      }
    })();
    return closePromise;
  };
  return { ws, close };
}

async function openInstalledEngineSocket(relay, token, handshakeTimeoutMs = 20000) {
  const owner = createOwnedEngineSocket(new WebSocket(relay));
  const frames = [];
  let cleanupHandshake = () => {};
  try {
    await withDeadline(() => new Promise((resolve, reject) => {
      let welcomed = false;
      const onOpen = () => owner.ws.send(JSON.stringify({ type: "hello", token, client: "engine" }));
      const onMessage = ev => {
        let frame;
        try { frame = JSON.parse(ev.data); } catch { return; }
        frames.push(frame);
        if (!welcomed && frame.type === "welcome") { welcomed = true; cleanup(); resolve(); }
        else if (!welcomed && frame.type === "error") { cleanup(); reject(new Error(frame.error)); }
      };
      const onError = () => { if (!welcomed) { cleanup(); reject(new Error("the installed engine socket failed")); } };
      const onClose = () => { if (!welcomed) { cleanup(); reject(new Error("the installed engine socket closed before welcome")); } };
      const cleanup = () => {
        owner.ws.removeEventListener("open", onOpen);
        owner.ws.removeEventListener("error", onError);
        owner.ws.removeEventListener("close", onClose);
        /* Keep the message collector after welcome for publish verification. */
        if (!welcomed) owner.ws.removeEventListener("message", onMessage);
      };
      cleanupHandshake = cleanup;
      owner.ws.addEventListener("open", onOpen, { once: true });
      owner.ws.addEventListener("message", onMessage);
      owner.ws.addEventListener("error", onError);
      owner.ws.addEventListener("close", onClose);
    }), handshakeTimeoutMs, "installed engine WebSocket handshake");
  } catch (err) {
    cleanupHandshake();
    try { await owner.close(); }
    catch (cleanupErr) {
      const combined = new Error(`installed engine handshake failed (${err?.message ?? String(err)}); ` +
        `socket cleanup also failed (${cleanupErr?.message ?? String(cleanupErr)})`);
      combined.requiredCleanupFailure = true;
      throw combined;
    }
    throw err;
  }
  return { ...owner, frames };
}

async function connectInstalledEngine(page) {
  /* WHERE THE OWNER KEY LIVES, AND WHY IT MOVED (2026-08-04, commit 82cdaf6).
     It used to sit in the window's Local Storage — an ordinary unencrypted file
     that any junk program reads, holding the one value that can create agents
     with folders on this computer. The shell keeps it encrypted now and hands
     it to the window in memory, so the ONLY way in is the preload bridge. The
     old spelling is kept as a fallback for a plain browser (the member sidecar
     below), which has nowhere else to put it. */
  const connection = await page.evaluate(() => ({
    relay: new URL(window.location.href).searchParams.get("relay"),
    token: window.cloud9?.hubSignIn?.token?.() ?? window.localStorage.getItem("cloud9.token"),
  }));
  if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(connection.relay ?? "")) {
    throw new Error("the installed window did not name its own loopback hub");
  }
  if (!connection.token) {
    throw new Error("the installed window has no owner session key in memory");
  }

  const owned = await openInstalledEngineSocket(connection.relay, connection.token);
  const ws = owned.ws;
  const frames = owned.frames;
  let sequence = 0;
  const record = run => ws.send(JSON.stringify({
    type: "runRecorded", requestId: `drive_run_${++sequence}`, record: run,
  }));
  const publish = async ({
    channelId, agentId, agentName, name, data, expectedVersion, artifactId, runId, note, links,
  }) => {
    const bytes = Buffer.from(data);
    const expected = {
      channelId, agentId, agentName, name, artifactId, version: expectedVersion,
      size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), runId,
    };
    const from = frames.length;
    const requestId = `drive_artifact_${++sequence}`;
    ws.send(JSON.stringify({
      type: "publishArtifact", requestId, channelId, agentId, name,
      dataBase64: bytes.toString("base64"),
      ...(runId ? { runId } : {}), ...(note ? { note } : {}), ...(links ? { links } : {}),
    }));
    let pushed;
    await until(`the installed hub to publish ${name} v${expectedVersion}`, () => {
      const recent = frames.slice(from);
      const refused = recent.find(f => f.type === "error" && f.requestId === requestId);
      if (refused) throw new Error(refused.error);
      pushed = recent.find(f => publishedArtifactMatches(f, expected));
      return !!pushed;
    }, { timeout: 30000, every: 100 });

    /* Publish pushes are intentionally unsolicited and carry no request id. Bind
       the result to THIS operation with a direct read whose echoed id and exact
       version/maker/hash must all agree. A stale same-name frame cannot satisfy it. */
    const verifyFrom = frames.length;
    const verifyRequestId = `drive_artifact_verify_${++sequence}`;
    ws.send(JSON.stringify({
      type: "artifact", requestId: verifyRequestId, artifactId: pushed.artifact.id,
    }));
    let verified;
    await until(`the installed hub to verify ${name} v${expectedVersion}`, () => {
      const recent = frames.slice(verifyFrom);
      const refused = recent.find(f => f.type === "error" && f.requestId === verifyRequestId);
      if (refused) throw new Error(refused.error);
      verified = recent.find(f => verifiedPublishedArtifactMatches(f, verifyRequestId, expected));
      return !!verified;
    }, { timeout: 30000, every: 100 });
    return verified.artifact;
  };
  /* One more seam on the SAME owned connection, for the job states the engine
     cannot yet reach on its own (`blocked`). It sends the hub's own frames —
     `createTask` and `updateTask`, the very ones the engine sends on its failed
     path — through the gate that only lets an owner write onto their own
     agent's job. Nothing is written into the screen; everything the walk then
     reads is the screen reading the hub back. */
  const ask = frame => {
    const requestId = `drive_ask_${++sequence}`;
    ws.send(JSON.stringify({ ...frame, requestId }));
    return requestId;
  };
  return { record, publish, ask, frames, close: owned.close };
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

/**
 * KEEP ONE SHOT, because somebody is going to have to look at it later.
 *
 * Every other picture this harness takes is deleted at the start of the next
 * run — there are around a hundred of them and nothing renders any of them.
 * That is right for a walk-through and wrong for the two or three that are
 * cited as evidence in a pull request: a reviewer opening that pull request is
 * not sitting at this machine, and "docs/qa/app-15-spending.png" tells them
 * nothing at all. Kept shots land in `docs/qa/kept/` under a STABLE name (no
 * step number — the number moves whenever a check is added ahead of it) and are
 * the only pictures in this repository that are tracked.
 *
 * Never throws. Evidence failing to copy must not take a walk down with it.
 */
function keep(file, name) {
  try {
    const dir = path.join(SHOTS, "kept");
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(file)) return;
    const target = path.join(dir, `${name}.png`);
    fs.copyFileSync(file, target);
    console.log(`  kept  ${target}`);
  } catch (err) {
    console.log(`  kept  FAILED for ${name}: ${err.message}`);
  }
}

/* ---------------------------------------------------------------- launching */

/** List every packaged file under one bundle, relative to that bundle. */
function packagedFiles(root, relative) {
  const bundle = path.join(root, relative);
  if (!fs.existsSync(bundle)) return null;
  if (fs.statSync(bundle).isFile()) return ["."];
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(path.relative(bundle, full).replaceAll("\\", "/"));
    }
  };
  visit(bundle);
  return files.sort();
}

const RENDERER_SNAPSHOT_MAX_FILES = 64;
const RENDERER_SNAPSHOT_MAX_DIRECTORIES = 64;
const RENDERER_SNAPSHOT_MAX_DEPTH = 8;
const RENDERER_SNAPSHOT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const RENDERER_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;
const RENDERER_SNAPSHOT_MAX_PATH_BYTES = 512;

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** Refuse a link/junction in the install root or resources/app/dist-web chain. */
function resolveInstalledRendererRoot(appExe = APP_EXE) {
  const nominalExe = path.resolve(appExe);
  if (!fs.existsSync(nominalExe) || fs.lstatSync(nominalExe).isSymbolicLink()
    || !fs.statSync(nominalExe).isFile()) {
    throw new Error(`the installed executable is missing, linked, or not a regular file: ${nominalExe}`);
  }
  const nominalInstallRoot = path.dirname(nominalExe);
  if (fs.lstatSync(nominalInstallRoot).isSymbolicLink()) {
    throw new Error(`the installed app root is a link or junction: ${nominalInstallRoot}`);
  }
  const canonicalInstallRoot = fs.realpathSync(nominalInstallRoot);
  let nominal = nominalInstallRoot;
  let canonical = canonicalInstallRoot;
  for (const segment of ["resources", "app", "dist-web"]) {
    nominal = path.join(nominal, segment);
    if (!fs.existsSync(nominal)) throw new Error(`the installed renderer ancestor is missing: ${nominal}`);
    const stat = fs.lstatSync(nominal);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`the installed renderer ancestor is linked or not a directory: ${nominal}`);
    }
    canonical = fs.realpathSync(nominal);
    if (!pathIsInside(canonicalInstallRoot, canonical)) {
      throw new Error(`the installed renderer ancestor escaped the installed app root: ${nominal}`);
    }
  }
  return { installRoot: canonicalInstallRoot, rendererRoot: canonical, nominalRendererRoot: nominal };
}

/**
 * Read one bounded renderer tree exactly once. The returned lookup copies bytes
 * from a private in-memory map; request handling never reopens the filesystem.
 */
function fileIdentityMatches(pathStat, fdStat) {
  if (!pathStat?.isFile() || !fdStat?.isFile()) return false;
  const metadataMatches = pathStat.size === fdStat.size
    && pathStat.mode === fdStat.mode
    && pathStat.mtimeMs === fdStat.mtimeMs
    && pathStat.ctimeMs === fdStat.ctimeMs;
  const inodeSupported = Number.isFinite(pathStat.dev) && Number.isFinite(pathStat.ino)
    && Number.isFinite(fdStat.dev) && Number.isFinite(fdStat.ino)
    && (pathStat.dev !== 0 || pathStat.ino !== 0 || fdStat.dev !== 0 || fdStat.ino !== 0);
  return metadataMatches && (!inodeSupported || (pathStat.dev === fdStat.dev && pathStat.ino === fdStat.ino));
}

function captureRendererSnapshot(root, label, hooks = {}) {
  const canonicalRoot = fs.realpathSync(root);
  if (fs.lstatSync(root).isSymbolicLink() || !fs.statSync(root).isDirectory()) {
    throw new Error(`${label} renderer root is linked or not a directory`);
  }
  const entries = new Map();
  let totalBytes = 0;
  let directories = 0;
  const pending = [{ full: canonicalRoot, depth: 0 }];
  while (pending.length) {
    const current = pending.pop();
    if (current.depth > RENDERER_SNAPSHOT_MAX_DEPTH) {
      throw new Error(`${label} renderer exceeds the ${RENDERER_SNAPSHOT_MAX_DEPTH}-level traversal bound`);
    }
    const beforePath = fs.lstatSync(current.full);
    if (beforePath.isSymbolicLink()) {
      throw new Error(`${label} renderer contains a link or junction: ${current.full}`);
    }
    const realBefore = fs.realpathSync(current.full);
    if (!pathIsInside(canonicalRoot, realBefore)) {
      throw new Error(`${label} renderer path escaped its root: ${current.full}`);
    }
    const relativeBefore = path.relative(canonicalRoot, realBefore).replaceAll("\\", "/");
    if (relativeBefore && Buffer.byteLength(relativeBefore, "utf8") > RENDERER_SNAPSHOT_MAX_PATH_BYTES) {
      throw new Error(`${label} renderer exceeds the relative-path snapshot bound`);
    }
    if (beforePath.isDirectory()) {
      directories += 1;
      if (directories > RENDERER_SNAPSHOT_MAX_DIRECTORIES) {
        throw new Error(`${label} renderer exceeds the ${RENDERER_SNAPSHOT_MAX_DIRECTORIES}-directory bound`);
      }
      const children = fs.readdirSync(current.full, { withFileTypes: true })
        .sort((left, right) => right.name.localeCompare(left.name));
      for (const child of children) {
        pending.push({ full: path.join(current.full, child.name), depth: current.depth + 1 });
      }
      continue;
    }
    if (!beforePath.isFile()) throw new Error(`${label} renderer contains a non-file entry: ${current.full}`);
    if (entries.size + 1 > RENDERER_SNAPSHOT_MAX_FILES) {
      throw new Error(`${label} renderer exceeds the ${RENDERER_SNAPSHOT_MAX_FILES}-file bound`);
    }

    hooks.beforeOpen?.({ full: current.full, relative: relativeBefore });
    const fd = fs.openSync(current.full, "r");
    let bytes;
    let openedBefore;
    let openedAfter;
    try {
      openedBefore = fs.fstatSync(fd);
      hooks.afterOpen?.({ full: current.full, relative: relativeBefore, fd });
      const openedPath = fs.lstatSync(current.full);
      const realOpened = fs.realpathSync(current.full);
      const openedIdentityMatches = !openedPath.isSymbolicLink()
        && pathIsInside(canonicalRoot, realOpened) && realBefore === realOpened
        && fileIdentityMatches(beforePath, openedBefore)
        && fileIdentityMatches(openedPath, openedBefore);
      if (!openedIdentityMatches) {
        throw new Error(`${label} renderer path identity changed while opening: ${current.full}`);
      }
      if (openedBefore.size > RENDERER_SNAPSHOT_MAX_FILE_BYTES
        || totalBytes + openedBefore.size > RENDERER_SNAPSHOT_MAX_BYTES) {
        throw new Error(`${label} renderer exceeds the per-file or total snapshot byte bound`);
      }
      bytes = Buffer.alloc(openedBefore.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (read === 0) break;
        offset += read;
      }
      if (offset !== bytes.length) throw new Error(`${label} renderer file shortened during capture: ${current.full}`);
      openedAfter = fs.fstatSync(fd);
      hooks.afterRead?.({ full: current.full, relative: relativeBefore, fd });
      const afterPath = fs.lstatSync(current.full);
      const realAfter = fs.realpathSync(current.full);
      const stable = !afterPath.isSymbolicLink() && pathIsInside(canonicalRoot, realAfter)
        && realBefore === realAfter
        && fileIdentityMatches(beforePath, openedBefore)
        && fileIdentityMatches(openedBefore, openedAfter)
        && fileIdentityMatches(afterPath, openedAfter)
        && openedAfter.size === bytes.length;
      if (!stable) throw new Error(`${label} renderer changed while its snapshot was being captured: ${current.full}`);
    } finally {
      fs.closeSync(fd);
    }
    totalBytes += bytes.length;
    entries.set(relativeBefore, Object.freeze({
      bytes: Buffer.from(bytes),
      size: bytes.length,
      type: STATIC_TYPES.get(path.extname(relativeBefore).toLowerCase()) ?? "application/octet-stream",
    }));
  }
  if (!entries.has("index.html")) throw new Error(`${label} renderer snapshot has no index.html`);
  const hash = createHash("sha256");
  for (const [name, entry] of entries) {
    hash.update(name);
    hash.update("\0");
    hash.update(entry.bytes);
    hash.update("\0");
  }
  const fingerprint = hash.digest("hex");
  return Object.freeze({
    root: canonicalRoot,
    fingerprint,
    files: entries.size,
    directories,
    totalBytes,
    has: name => entries.has(name),
    read: name => {
      const entry = entries.get(name);
      return entry ? { ...entry, bytes: Buffer.from(entry.bytes) } : null;
    },
  });
}

/** Use only the installed immutable snapshot approved by the freshness guard. */
function assertApprovedInstalledRenderer(approval) {
  const expectedNominalRoot = path.resolve(path.dirname(APP_EXE), "resources", "app", "dist-web");
  if (!approval || path.resolve(approval.nominalRoot) !== expectedNominalRoot || !approval.rendererSnapshot) {
    throw new Error("the member sidecar was not given the installed renderer snapshot approved at launch");
  }
  if (approval.rendererSnapshot.fingerprint !== approval.fingerprint
    || approval.fingerprint !== approval.packagedFingerprint
    || approval.fingerprint !== approval.repoBuildFingerprint) {
    throw new Error("the approved installed renderer snapshot does not match package and repo build bytes");
  }
  return approval.rendererSnapshot;
}

const STATIC_TYPES = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "application/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

function installedAssetEntry(snapshot, requestUrl, headers = {}) {
  const rawUrl = requestUrl ?? "/";
  const parsed = new URL(rawUrl, "http://127.0.0.1");
  const rawPath = rawUrl.split(/[?#]/, 1)[0];
  if (/%(?:2f|5c)/i.test(rawPath)) throw new Error("encoded separator");
  const decodedRawPath = decodeURIComponent(rawPath);
  const decodedPathname = decodeURIComponent(parsed.pathname);
  if (decodedRawPath.includes("\0") || decodedPathname.includes("\0")) throw new Error("NUL path");
  const rawSlashPath = decodedRawPath.replaceAll("\\", "/");
  const rawSegments = rawSlashPath.split("/").filter(Boolean);
  if (rawSegments.some(segment => segment === "..")
    || /^[A-Za-z]:/.test(rawSegments[0] ?? "")
    || rawSlashPath.startsWith("//")) {
    throw new Error("path traversal");
  }
  const relative = decodedPathname.replaceAll("\\", "/").split("/").filter(Boolean).join("/") || "index.html";
  const documentNavigation = /\btext\/html\b/i.test(String(headers.accept ?? ""))
    && String(headers["sec-fetch-mode"] ?? "").toLowerCase() === "navigate"
    && String(headers["sec-fetch-dest"] ?? "").toLowerCase() === "document";
  const key = snapshot.has(relative) ? relative
    : (!path.posix.extname(relative) && documentNavigation ? "index.html" : relative);
  return snapshot.read(key);
}

/** Serve only one approved installed directory, only on this computer. */
async function startInstalledRendererServer(approval) {
  const snapshot = assertApprovedInstalledRenderer(approval);
  const sockets = new Set();
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    let entry;
    try {
      entry = installedAssetEntry(snapshot, request.url, request.headers);
    } catch {
      response.writeHead(403);
      response.end();
      return;
    }
    if (!entry) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Length": entry.size,
      "Content-Type": entry.type,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(request.method === "HEAD" ? undefined : entry.bytes);
  });
  const onConnection = socket => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  };
  server.on("connection", onConnection);
  try {
    await new Promise((resolve, reject) => {
      const onError = err => { server.off("listening", onListening); reject(err); };
      const onListening = () => { server.off("error", onError); resolve(); };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    const address = server.address();
    if (!address || typeof address === "string" || address.address !== "127.0.0.1"
      || !Number.isInteger(address.port) || address.port < 1) {
      throw new Error("the installed renderer server did not bind only to 127.0.0.1 on an OS-assigned port");
    }
    return { server, sockets, onConnection, root: snapshot.root, origin: `http://127.0.0.1:${address.port}` };
  } catch (err) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise(resolve => server.close(() => resolve()));
    server.off("connection", onConnection);
    throw err;
  }
}

async function closeLoopbackServer(server, sockets = new Set(), onConnection = null) {
  if (!server) return;
  if (server.listening) {
    await new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = err => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        err ? reject(err) : resolve();
      };
      timer = setTimeout(() => {
        for (const socket of sockets) socket.destroy();
        finish(new Error("timed out stopping the loopback server"));
      }, 10000);
      server.close(finish);
      server.closeIdleConnections?.();
      server.closeAllConnections?.();
      for (const socket of sockets) socket.destroy();
    });
  }
  if (server.listening) throw new Error("loopback server still reports listening after close");
  if (onConnection) server.off("connection", onConnection);
  sockets.clear();
}

function ownedProcessIsAlive(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return false;
  try { process.kill(child.pid, 0); return true; }
  catch { return false; }
}

function observeOwnedProcessClose(child) {
  if (!child) return Promise.resolve({ exitCode: null, signal: null, error: "no process" });
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ exitCode: child.exitCode, signal: child.signalCode, error: null });
  }
  return new Promise(resolve => {
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal, error: null }));
    child.once("error", err => resolve({ exitCode: null, signal: null, error: err?.message ?? String(err) }));
  });
}

async function waitForOwnedProcessExit(child, rootClosed, timeoutMs) {
  if (!child) return { exitCode: null, signal: null, error: null };
  const result = await withDeadline(
    () => rootClosed ?? observeOwnedProcessClose(child), timeoutMs, "owned Chromium root close");
  if (result?.error) throw new Error(`owned Chromium process error: ${result.error}`);
  if (ownedProcessIsAlive(child)) throw new Error(`owned Chromium process ${child.pid} still exists after close proof`);
  return result;
}

async function withDeadline(work, timeoutMs, label) {
  let timer = null;
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function closeMemberBrowserResources(resources) {
  const problems = [];
  /* Things that happened but are not failures — a shutdown that needed the
     forced path yet still proved every exit belongs here, not in `problems`. */
  const observations = resources.cleanupObservations ??= [];
  const attempt = async (label, done, work, timeoutMs) => {
    if (done()) return;
    try { await withDeadline(work, resources.cleanupTimeoutMs ?? timeoutMs, label); }
    catch (err) { problems.push(`${label}: ${err?.message ?? String(err)}`); }
  };
  await attempt("member page close", () => resources.closed.page || resources.page?.isClosed() === true, async () => {
    if (resources.page) await resources.page.close();
    resources.closed.page = true;
  }, 12000);
  await attempt("member context close", () => resources.closed.context, async () => {
    if (resources.context) await resources.context.close();
    resources.closed.context = true;
  }, 30000);

  if (!resources.closed.browser) {
    const gracefulTimeout = resources.browserCloseTimeoutMs ?? 40000;
    let gracefulProblem = null;
    try {
      await withDeadline(async () => {
        /* Close inside-out. `startOwnedMemberBrowser` always launches a SERVER and
           then attaches a `chromium.connect()` client to it, so closing the server
           first leaves that client attached — which is exactly the state the old
           "member browser remained connected after server close" problem reported.
           Disconnect the client, then stop the server that owns the process, then
           make the OS confirm the process is gone. */
        if (resources.browser?.isConnected()) await resources.browser.close();
        if (resources.browserServer) await resources.browserServer.close();
        resources.browserExit = await waitForOwnedProcessExit(
          resources.browserProcess, resources.browserRootClosed, 10000);
      }, gracefulTimeout, "member browser graceful close");
    } catch (err) {
      gracefulProblem = err;
    }
    if (gracefulProblem || ownedProcessIsAlive(resources.browserProcess)) {
      try {
        resources.forcedTerminationCount += 1;
        if (resources.browserServer) {
          await withDeadline(() => resources.browserServer.kill(),
            resources.forceKillTimeoutMs ?? 15000, "member browser forced kill");
        } else if (resources.browserProcess?.pid) {
          resources.browserProcess.kill();
        }
        resources.browserExit = await waitForOwnedProcessExit(
          resources.browserProcess, resources.browserRootClosed, resources.forceKillTimeoutMs ?? 15000);
        if (ownedProcessIsAlive(resources.browserProcess)) throw new Error("forced browser process is still alive");
        resources.closed.browser = true;
        /* A slow shutdown that still met the SAME proof bar — root close observed
           and the OS says the process is gone — is a pass, not a failure. It is
           recorded so a run can say it happened, but it does not fail the group. */
        observations.push(`member browser needed the forced path (${gracefulProblem?.message ?? "process remained alive"}); ` +
          "the kill succeeded and root close plus OS exit were both verified");
      } catch (forceErr) {
        problems.push(`member browser forced termination: ${forceErr?.message ?? String(forceErr)}`);
      }
    } else {
      if (resources.browser?.isConnected()) problems.push("member browser remained connected after server close");
      else resources.closed.browser = true;
    }
  }
  if (resources.closed.browser) {
    resources.page = null;
    resources.context = null;
    resources.browser = null;
    resources.browserServer = null;
    resources.browserProcess = null;
  }
  if (problems.length) {
    const error = new Error(problems.join("; "));
    error.requiredCleanupFailure = true;
    throw error;
  }
}

async function startOwnedMemberBrowser(resources, storageState = undefined) {
  resources.closed.page = false;
  resources.closed.context = false;
  resources.closed.browser = false;
  resources.browserExit = null;
  resources.browserRootClosed = null;
  resources.browserServer = await chromium.launchServer({
    host: "127.0.0.1",
    port: 0,
    ...(process.env.CLOUD9_CHROMIUM ? { executablePath: process.env.CLOUD9_CHROMIUM } : {}),
    downloadsPath: resources.tempState,
  });
  resources.browserProcess = resources.browserServer.process();
  if (!resources.browserProcess?.pid || !ownedProcessIsAlive(resources.browserProcess)) {
    throw new Error("Playwright did not expose a live owned Chromium process");
  }
  resources.browserRootPid = resources.browserProcess.pid;
  resources.browserRootClosed = observeOwnedProcessClose(resources.browserProcess);
  resources.browser = await chromium.connect(resources.browserServer.wsEndpoint(), { timeout: 30000 });
  resources.context = await resources.browser.newContext({
    viewport: { width: 1280, height: 800 },
    ...(storageState ? { storageState } : {}),
  });
  resources.page = await resources.context.newPage();
  await resources.page.goto(resources.memberUrl, { waitUntil: "domcontentloaded" });
}

/** Close every sidecar resource even when an earlier close fails. */
async function closeMemberSidecarResources(resources) {
  if (resources.closePromise) return resources.closePromise;
  const closing = (async () => {
    const problems = [];
    try { await closeMemberBrowserResources(resources); }
    catch (err) { problems.push(err?.message ?? String(err)); }
    try {
      if (!resources.closed.server) {
        await withDeadline(() => closeLoopbackServer(resources.server, resources.sockets, resources.onConnection),
          resources.cleanupTimeoutMs ?? 12000, "loopback server close");
        resources.closed.server = true;
      }
    } catch (err) { problems.push(`loopback server: ${err?.message ?? String(err)}`); }
    try {
      if (!resources.closed.tempState) {
        if (resources.tempState) fs.rmSync(resources.tempState, { recursive: true, force: true });
        if (resources.tempState && fs.existsSync(resources.tempState)) throw new Error("directory still exists after removal");
        resources.closed.tempState = true;
      }
    } catch (err) { problems.push(`member temporary state: ${err?.message ?? String(err)}`); }
    resources.storageState = null;
    if (problems.length) {
      const error = new Error(problems.join("; "));
      error.requiredCleanupFailure = true;
      throw error;
    }
    activeMemberSidecars.delete(resources);
  })();
  resources.closePromise = closing;
  try { await closing; }
  catch (err) { resources.closePromise = null; throw err; }
}

const activeMemberSidecars = new Set();

async function cleanupActiveMemberSidecars() {
  const problems = [];
  for (const resources of [...activeMemberSidecars]) {
    try { await closeMemberSidecarResources(resources); }
    catch (err) { problems.push(err?.message ?? String(err)); }
  }
  if (problems.length) throw new Error(`retained sidecar cleanup failed (${problems.join("; ")})`);
}

/** Launch one ordinary Chromium member against the installed app's real hub. */
async function launchInstalledMemberSidecar(approval, relay) {
  if (!/^ws:\/\/127\.0\.0\.1:\d+$/.test(relay ?? "")) {
    throw new Error("the member sidecar was not given the installed app's loopback relay");
  }
  const resources = {
    page: null, context: null, browser: null, browserServer: null, browserProcess: null,
    browserRootPid: null, browserRootClosed: null, browserExit: null,
    server: null, sockets: new Set(), onConnection: null,
    tempState: null, closePromise: null, origin: null, rendererRoot: null, memberUrl: null,
    storageState: null, forcedTerminationCount: 0,
    closed: { page: false, context: false, browser: false, server: false, tempState: false },
  };
  activeMemberSidecars.add(resources);
  try {
    const hosted = await startInstalledRendererServer(approval);
    resources.server = hosted.server;
    resources.sockets = hosted.sockets;
    resources.onConnection = hosted.onConnection;
    resources.origin = hosted.origin;
    resources.rendererRoot = hosted.root;
    resources.tempState = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-member-"));
    const memberUrl = new URL(hosted.origin);
    memberUrl.searchParams.set("relay", relay);
    resources.memberUrl = memberUrl.href;
    await startOwnedMemberBrowser(resources);
    const loadedUrl = new URL(resources.page.url());
    if (loadedUrl.origin !== hosted.origin || loadedUrl.protocol !== "http:"
      || loadedUrl.hostname !== "127.0.0.1" || loadedUrl.pathname !== "/"
      || loadedUrl.searchParams.get("relay") !== relay) {
      throw new Error("the member page did not stay on the approved loopback origin and installed relay");
    }
    return {
      get page() { return resources.page; },
      get context() { return resources.context; },
      get browser() { return resources.browser; },
      get origin() { return resources.origin; },
      get rendererRoot() { return resources.rendererRoot; },
      close: () => closeMemberSidecarResources(resources),
      reconnect: async (expectedMemberId, ownerId) => {
        resources.storageState = await resources.context.storageState();
        const durableItem = resources.storageState.origins
          ?.flatMap(origin => origin.localStorage ?? [])
          .find(item => item.name === "cloud9.token" && item.value.length > 0);
        if (!durableItem) throw new Error("the joined member had no durable storage to reconnect with");
        await closeMemberBrowserResources(resources);
        await startOwnedMemberBrowser(resources, resources.storageState);
        await waitForEstablishedIdentity(resources.page);
        const reconnectedId = await assertRedeemedMemberIdentity(resources.page, ownerId);
        if (reconnectedId !== expectedMemberId) {
          throw new Error("the relaunched sidecar did not reconnect as the same invited member");
        }
        return reconnectedId;
      },
      /* Things that happened during shutdown and were fully proved — e.g. a slow
         close that needed the forced path. Reported, never counted as a failure. */
      cleanupObservations: () => [...(resources.cleanupObservations ?? [])],
      cleanupState: () => ({
        pageClosed: resources.page?.isClosed() ?? true,
        contextClosed: resources.closed.context,
        browserDisconnected: resources.browser ? !resources.browser.isConnected() : true,
        browserProcessExited: !ownedProcessIsAlive(resources.browserProcess),
        browserRootCloseRecorded: resources.browserExit !== null,
        serverStopped: resources.server ? !resources.server.listening : true,
        socketsClosed: resources.sockets.size === 0,
        tempStateRemoved: resources.tempState ? !fs.existsSync(resources.tempState) : true,
      }),
    };
  } catch (err) {
    try { await closeMemberSidecarResources(resources); }
    catch (cleanupErr) {
      const combined = new Error(`member sidecar setup failed (${err?.message ?? String(err)}); ` +
        `cleanup also failed (${cleanupErr?.message ?? String(cleanupErr)})`);
      combined.requiredCleanupFailure = true;
      throw combined;
    }
    throw err;
  }
}

async function assertPlainMemberStart(sidecar, relay) {
  await sidecar.page.waitForSelector(".welcome.join", { timeout: 20000 });
  const boundary = await sidecar.page.evaluate(() => ({
    href: window.location.href,
    token: window.localStorage.getItem("cloud9.token"),
    preloadAbsent: typeof window.cloud9 === "undefined",
  }));
  const url = new URL(boundary.href);
  const keys = [...url.searchParams.keys()];
  if (url.origin !== sidecar.origin || url.protocol !== "http:" || url.hostname !== "127.0.0.1"
    || url.pathname !== "/" || url.searchParams.get("relay") !== relay
    || keys.length !== 1 || keys[0] !== "relay" || url.username || url.password || url.hash
    || boundary.token !== null || !boundary.preloadAbsent) {
    throw new Error("the plain member did not start cleanly on the installed loopback screen and exact relay");
  }
}

/**
 * "The sidebar is on screen" is NOT "a person is signed in".
 *
 * `App.tsx` draws the whole workspace — icon rail included — the moment a token
 * exists in storage, before the socket has said `welcome`. Waiting on `.rail`
 * therefore returns while the window still has no identity, and whatever runs
 * next blames the invite flow for the harness's own impatience. Wait on the
 * app's OWN answer instead: `cloud9Wire.me()`, the same value the rail lamp
 * turns green (`.rail-lamp.ok`) on. Use this at every point the walk moves from
 * "a window exists" to "a person is signed in".
 */
async function waitForEstablishedIdentity(page, timeoutMs = 30000) {
  await page.waitForSelector(".rail", { timeout: timeoutMs });
  try {
    await page.waitForFunction(
      () => typeof window.cloud9Wire?.me === "function" && !!window.cloud9Wire.me(),
      undefined, { timeout: timeoutMs });
  } catch {
    throw new Error("the workspace was drawn but nobody is signed in on it yet: " +
      `window.cloud9Wire.me() never became a real id within ${timeoutMs}ms. ` +
      "The rail appears as soon as a stored token exists, so this window is still waiting " +
      "for the hub's welcome — not proof of an identity.");
  }
  return page.evaluate(() => window.cloud9Wire.me());
}

/**
 * The installed walk's fresh database starts in the shipped Focus layout, while
 * the legacy room journeys still use the Studio sidebar to choose a room. Keep
 * that fixture local to throwaway runs and make it safe to call after returning
 * Home: only change the picker when it is not already on Chat + Files.
 */
async function ensureChatFilesSidebar(page) {
  if (!OPTS.fresh) return;
  const layout = page.locator('select[aria-label="Workspace layout"]:visible').first();
  await layout.waitFor({ state: "visible", timeout: 30000 });
  if (await layout.inputValue() !== "chat-files") await layout.selectOption("chat-files");
  const sidebar = page.locator(".sidebar").first();
  await sidebar.waitFor({ state: "visible", timeout: 30000 });
  if (!await sidebar.isVisible()) {
    throw new Error("the fresh installed walk selected Chat + Files but the sidebar is not visible");
  }
}

async function assertRedeemedMemberIdentity(memberPage, ownerId) {
  const identity = await memberPage.evaluate(() => ({
    id: window.cloud9Wire?.me?.() ?? null,
    durableTokenPresent: (window.localStorage.getItem("cloud9.token")?.length ?? 0) > 0,
  }));
  /* Three different failures. They used to share one sentence, which sent a real
     investigation after the invite flow when the truth was "not connected yet". */
  if (!identity.id) {
    throw new Error("this member window is not signed in as anybody: window.cloud9Wire.me() is null, " +
      "so the hub has not welcomed this connection yet (nothing has been proved about the invite)");
  }
  if (identity.id === ownerId) {
    throw new Error(`this member window is signed in as the OWNER (${ownerId}), not a new person — ` +
      "the invite did not create a distinct member");
  }
  if (!identity.durableTokenPresent) {
    throw new Error(`member ${identity.id} exists but has no durable session: localStorage "cloud9.token" ` +
      "is empty, so this member could not come back after a restart");
  }
  return identity.id;
}

/**
 * Refuse to walk yesterday's app — including yesterday's backend.
 *
 * The Files walk crosses five separately packaged code bundles: the desktop
 * screen, the Electron shell which starts the embedded services, and the relay,
 * shared and engine builds under node_modules. Comparing only Vite's hashed
 * assets let an old relay/store pass behind a fresh-looking screen. Every file
 * in every behavioural bundle must therefore be byte-identical to win-unpacked,
 * including the manifests that choose each package's runtime entry point. A
 * missing/partial build or partial install is a stale-install refusal, never a
 * reason to skip the comparison.
 */
function assertInstallIsCurrent() {
  const builtRoot = path.join(REPO_ROOT, "release", "win-unpacked", "resources", "app");
  const installedRoot = path.join(path.dirname(APP_EXE), "resources", "app");
  if (!fs.existsSync(builtRoot)) {
    throw new Error(
      "freshness cannot be proved: release\\win-unpacked is missing. Refusing to walk an install " +
      "that may contain yesterday's desktop or backend code. Build it, install it, then drive it again.");
  }

  const bundles = [
    ["desktop package manifest", "package.json"],
    ["desktop screen", "dist-web"],
    ["desktop shell", "electron"],
    ["relay package", path.join("node_modules", "@cloud9", "relay")],
    ["shared package", path.join("node_modules", "@cloud9", "shared")],
    ["engine package", path.join("node_modules", "@cloud9", "engine")],
  ];
  const stale = [];
  for (const [label, relative] of bundles) {
    const built = packagedFiles(builtRoot, relative);
    const installed = packagedFiles(installedRoot, relative);
    if (!built || !installed) {
      stale.push(`${label}: ${!built ? "missing from built app" : "missing from installed app"}`);
      continue;
    }
    const namesMatch = built.length === installed.length && built.every((name, i) => name === installed[i]);
    const changed = namesMatch ? built.filter(name => !fs.readFileSync(path.join(builtRoot, relative, name))
      .equals(fs.readFileSync(path.join(installedRoot, relative, name)))) : [];
    if (!namesMatch || changed.length) {
      const builtOnly = built.filter(name => !installed.includes(name));
      const installedOnly = installed.filter(name => !built.includes(name));
      const why = [
        changed.length ? `changed: ${changed.slice(0, 4).join(", ")}` : "",
        builtOnly.length ? `not installed: ${builtOnly.slice(0, 4).join(", ")}` : "",
        installedOnly.length ? `installed only: ${installedOnly.slice(0, 4).join(", ")}` : "",
      ].filter(Boolean).join("; ");
      stale.push(`${label}: ${why || "file list differs"}`);
    }
  }

  /* The member screen is also checked against the current repo build output.
     This is a comparison only, never a serving fallback. The controller still
     owns the fresh build/package/install chain which produces these trees. */
  const repoBuildRoot = path.join(REPO_ROOT, "apps", "desktop", "dist-web");
  const packagedRendererRoot = path.join(builtRoot, "dist-web");
  let installedRenderer;
  let repoSnapshot;
  let packagedSnapshot;
  let installedSnapshot;
  try {
    installedRenderer = resolveInstalledRendererRoot(APP_EXE);
    repoSnapshot = captureRendererSnapshot(repoBuildRoot, "repo build");
    packagedSnapshot = captureRendererSnapshot(packagedRendererRoot, "packaged app");
    installedSnapshot = captureRendererSnapshot(installedRenderer.rendererRoot, "installed app");
    if (repoSnapshot.fingerprint !== packagedSnapshot.fingerprint
      || repoSnapshot.fingerprint !== installedSnapshot.fingerprint) {
      stale.push("desktop screen: current repo build, packaged app and installed snapshot are not byte-identical");
    }
  } catch (err) {
    stale.push(`desktop screen: freshness/snapshot cannot be proved (${err?.message ?? String(err)})`);
  }
  if (stale.length) {
    throw new Error(
      "the INSTALLED app is stale: its packaged screen/backend does not match release\\win-unpacked.\n" +
      stale.map(line => `  ${line}`).join("\n") + "\n" +
      "Run the installer first: release\\Cloud9-Setup-0.1.0.exe /S — then drive it again.");
  }
  return Object.freeze({
    nominalRoot: installedRenderer.nominalRendererRoot,
    rendererSnapshot: installedSnapshot,
    fingerprint: installedSnapshot.fingerprint,
    packagedFingerprint: packagedSnapshot.fingerprint,
    repoBuildFingerprint: repoSnapshot.fingerprint,
  });
}

let child = null;
let tempUserData = null;
let installedRendererApproval = null;

async function launch({ resetScreenshots = true } = {}) {
  if (!fs.existsSync(APP_EXE)) {
    throw new Error(`the installed app is not there: ${APP_EXE}\n` +
      "Install it (npm run dist, then run the installer) before driving it.");
  }
  installedRendererApproval = assertInstallIsCurrent();
  fs.mkdirSync(SHOTS, { recursive: true });

  // Old screenshots must never be mistaken for this run's evidence.
  if (resetScreenshots) for (const f of fs.readdirSync(SHOTS)) {
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
  let retainedSidecarProblem = null;
  try { await cleanupActiveMemberSidecars(); }
  catch (err) { retainedSidecarProblem = err; }
  try { await browser?.close(); } catch { /* already gone */ }
  if (OPTS.keepOpen) {
    console.log("\n  --keep-open: the app is still running; close it yourself.");
    if (retainedSidecarProblem) throw retainedSidecarProblem;
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
  if (retainedSidecarProblem) throw retainedSidecarProblem;
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
    await waitForEstablishedIdentity(page);
    if (OPTS.fresh) {
      await ensureChatFilesSidebar(page);
      return "workspace with Chat + Files layout and visible sidebar";
    }
    return "workspace (real data; existing layout preserved)";
  });
  await shot(page, "start");

  /* --- 2. More tools: is Projects visibly reachable from the rail? -------- */

  await check(EXPECTED_CHECKS[2], async () => {
    const toolsDoor = page.locator("[data-open-tools]").first();
    await toolsDoor.waitFor({ state: "visible", timeout: 15000 });
    await toolsDoor.click();
    const drawer = page.locator("#cloud9-tools-drawer");
    try {
      await drawer.waitFor({ state: "visible", timeout: 15000 });
      const projects = drawer.locator('[data-go="projects"]').first();
      await projects.waitFor({ state: "visible", timeout: 15000 });
      if (!await projects.isVisible()) {
        throw new Error("NOT ON SCREEN — the More tools drawer opened but Projects is not visible");
      }
      return "Projects is visible in the More tools drawer";
    } finally {
      const close = drawer.locator('[aria-label="Close tools"]').first();
      if (await close.count() && await close.isVisible()) {
        await close.click().catch(async () => { await page.keyboard.press("Escape").catch(() => {}); });
      } else {
        await page.keyboard.press("Escape").catch(() => {});
      }
      await drawer.waitFor({ state: "hidden", timeout: 10000 });
    }
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
    await clickRail(page, "crew");
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

  const EDITOR_GROUP = [
    EXPECTED_CHECKS[4], EXPECTED_CHECKS[5], EXPECTED_CHECKS[6], EXPECTED_CHECKS[15],
    EXPECTED_CHECKS[16],
  ];

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

    /* Opening it is the point, and so is what the card says. A library he cannot
       reach from an agent is a list nobody sees, and a skill whose source is
       missing is the opposite of what he asked for when he asked for research
       first. Both are asked of the app he double-clicks, not of the preview. */
    await check(EXPECTED_CHECKS[15], async () => {
      const way = page.locator('.editor .skills button:has-text("library")');
      if (await way.count() === 0) {
        const buttons = await page.$$eval(".editor .skills button", bs => bs.map(b => b.innerText.trim()));
        throw new Error("NOT ON SCREEN — no way into the skill library from an agent. " +
          `The skills section offers only: ${buttons.join(", ") || "nothing"}`);
      }
      await way.first().click();
      await page.waitForSelector("[data-libskill]", { timeout: 30000 });
      const cards = await page.locator("[data-libskill]").count();
      const shelves = await page.locator("[data-libgroup]").count();
      const sourced = await page.locator("[data-libskill] .ls-source").count();
      await shot(page, "library-installed");
      /* CLOSE IT AGAIN. A check that leaves a panel open over the app makes every
         later step fail and reads as nine broken features — which is exactly what
         happened the first time this check was written. */
      const done = page.locator("button.librarydone");
      if (await done.count()) await done.first().click();
      else await page.keyboard.press("Escape");
      await page.waitForSelector("[data-libskill]", { state: "detached", timeout: 15000 })
        .catch(() => {});
      if (cards === 0) {
        throw new Error("the library opened but holds no skills — 15 exist in the code");
      }
      if (sourced < cards) {
        throw new Error(`${cards} skills on screen and only ${sourced} say where they came from — ` +
          "he asked for research, and the source is the research");
      }
      return `${cards} skills on ${shelves} shelves, every one saying where it came from`;
    });

    await check(EXPECTED_CHECKS[16], async () => {
      const before = await page.locator('.editor .toggle-row[data-locked="yes"]').count();
      await page.click('.editor .app-pick[data-app="codex"]');
      await until("the locked rows to appear",
        () => page.locator('.editor .toggle-row[data-locked="yes"]').count().then(n => n > 0),
        { timeout: 15000 });
      const rows = await page.$$eval('.editor .toggle-row[data-locked="yes"]', rs => rs.map(r => ({
        ability: r.dataset.ability,
        chip: !!r.querySelector(".chip"),
        input: r.querySelector("input.sw"),
        checked: r.querySelector("input.sw")?.checked === true,
        disabled: r.querySelector("input.sw")?.disabled === true,
        why: r.querySelector(".tx > span:not(.chip), .tx span:last-child")?.innerText?.trim() ?? "",
      })));
      const wrong = rows.filter(r => !(r.chip && r.checked && r.disabled));
      if (wrong.length) {
        throw new Error(`NOT ON SCREEN — ${wrong.length} locked row(s) missing the chip, ` +
          `the ON state, or the disabled switch: ${wrong.map(r => r.ability).join(", ")}`);
      }
      await page.click('.editor .app-pick[data-app="claude"]');
      await until("the locks to release on Claude",
        () => page.locator('.editor .toggle-row[data-locked="yes"]').count().then(n => n === 0),
        { timeout: 15000 });
      return `${rows.length} switch(es) lock on with Codex (${rows.map(r => r.ability).join(", ")}), ` +
        `each saying why, and Claude gives them back (started with ${before} locked)`;
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

    await check(EXPECTED_CHECKS[17], async () => {
      const openMenu = async () => {
        const btn = page.locator(".composer .actionsbtn").first();
        if (await btn.count() === 0) {
          throw new Error("NOT ON SCREEN — no Actions button beside the message box");
        }
        await btn.click();
        await page.waitForSelector(".actionspop", { timeout: 15000 });
        return page.$$eval(".actionspop .ap-row", rs => rs.map(r => ({
          text: r.innerText.replace(/\s+/g, " ").trim(),
          blocked: r.classList.contains("is-blocked"),
        })));
      };
      let rows = await openMenu();
      if (rows.length === 0) throw new Error("the Actions menu opened empty");
      /* The room the walk lands in has no agent, so every row honestly says
         so. That honesty is real, but "does choosing a row fill the box" still
         has to be answered — from a direct chat with an agent, where the crew
         screen's own "Talk to" button leads. */
      if (rows.every(r => r.blocked)) {
        await page.keyboard.press("Escape").catch(() => {});
        await clickRail(page, "crew");
        const talk = page.locator('button:has-text("Talk to")').first();
        if (await talk.count() === 0) {
          throw new Error("every action is blocked in the room, and the crew screen offers " +
            "no 'Talk to' button to reach an agent directly");
        }
        await talk.click();
        await page.waitForSelector(".composer textarea", { timeout: 15000 });
        rows = await openMenu();
      }
      const usable = await page.locator(".actionspop .ap-row:not(.is-blocked)").first();
      if (await usable.count() === 0) {
        throw new Error(`every one of the ${rows.length} actions is blocked even in a direct ` +
          `chat with an agent — ` + rows.map(r => r.text).join(" | "));
      }
      const selectedCommand = await usable.getAttribute("data-command");
      if (!selectedCommand) {
        throw new Error("the usable Actions row has no data-command to verify");
      }
      await usable.click();
      const filled = (await page.inputValue(".composer textarea")).trim();
      if (!filled.includes(selectedCommand)) {
        throw new Error(`choosing "${selectedCommand}" left the message box without that command: "${filled}"`);
      }
      await page.fill(".composer textarea", "");
      /* Escape must close the menu if it reopened — same one-owner rule as every
         other overlay; a leftover popover breaks every later step. */
      await page.keyboard.press("Escape").catch(() => {});
      return `${rows.length} actions offered (${rows.filter(r => r.blocked).length} honestly blocked); ` +
        `choosing one filled in: "${filled.slice(0, 60)}"`;
    });
    /* --- the box he types in, and the view he types into ------------------
     *
     * TWO PROMISES IN ONE CHECK, because they are one experience: the box does
     * not shout at him while he is reading, and the moment he says something he
     * is looking at it.
     *
     * `data-writing` is the app's OWN word for "he is writing" (focused, or
     * holding text, or holding files, or with a menu open), written once beside
     * the box. Reading it rather than measuring pixels means this can never
     * disagree with the rule that drew it — and the second question, "is the
     * tool row still IN the box", is asked separately, because a tool deleted
     * when idle is a tool that cannot be found rather than a tidier box.
     *
     * Nothing here asks an agent anything: the message carries no `@`, so no
     * turn starts and no subscription is spent proving the view moved.
     */
    await check(EXPECTED_CHECKS[35], async () => {
      await page.click('.rail .rail-btn[data-go="chat"]');
      await page.waitForSelector(".composer textarea", { timeout: 30000 });
      const box = page.locator(".composer textarea").first();
      await box.fill("");
      await page.evaluate(() => document.activeElement?.blur?.());
      const state = () => page.evaluate(() => {
        const b = document.querySelector(".composer .composer-box");
        if (!b) return null;
        /* Judged on whether the control really takes up space, not on a class
           name and not on the wrapper's own `display`: the row is hidden with
           `display:none` and shown with `display:contents`, and a wrapper that
           generates no box of its own is exactly what `contents` means. */
        const showing = el => !!el && el.getClientRects().length > 0;
        const receding = [...b.querySelectorAll(".toolset button.mini")];
        /* Bold/italic/code deliberately stay mounted behind Aa. They are part
           of the capability count, but they are not supposed to take space
           until Aa is opened. Judge the visible row by its three direct doors:
           attach, emoji, and Aa. */
        const rowDoors = [
          b.querySelector(".toolset > .attach"),
          b.querySelector(".toolset > .emojihold > button.mini"),
          b.querySelector(".toolset > .fmtbtn"),
        ];
        return {
          writing: b.dataset.writing ?? "(no data-writing)",
          inBox: receding.length,
          toolsShowing: rowDoors.every(showing),
          actionsShowing: showing(b.querySelector(".actionsbtn")),
          sendShowing: showing(b.querySelector(".sendbtn")),
        };
      });
      await until("the box to go calm with nothing being written", async () =>
        (await state())?.writing === "no", { timeout: 15000 });
      const calm = await state();
      if (!calm) throw new Error("NOT ON SCREEN — there is no message box on this screen at all");
      await box.click();
      await until("the box to show its tools when he clicks into it", async () =>
        (await state())?.writing === "yes", { timeout: 15000 });
      const armed = await state();
      if (calm.toolsShowing || !armed.toolsShowing) {
        throw new Error(`NOT ON SCREEN — the tool row shows=${calm.toolsShowing} when idle and ` +
          `shows=${armed.toolsShowing} when he is writing; it should be the other way round`);
      }
      if (calm.inBox < 5 || armed.inBox !== calm.inBox) {
        throw new Error(`the receding tools are not still in the box: ${calm.inBox} when idle, ` +
          `${armed.inBox} when writing — hidden is right, removed is not`);
      }
      if (!calm.actionsShowing || !calm.sendShowing || !armed.actionsShowing || !armed.sendShowing) {
        throw new Error("NOT ON SCREEN — the ＋ Actions door or Send receded with the rest; " +
          `idle ＋=${calm.actionsShowing}/Send=${calm.sendShowing}, ` +
          `writing ＋=${armed.actionsShowing}/Send=${armed.sendShowing}`);
      }
      await shot(page, "composer-calm-and-armed");

      /* AND ENTER PUTS HIM ON WHAT HE SAID. Read back a little first, so this
         is the question he actually asked rather than "does a message appear
         at the bottom of a list already at its bottom". */
      const SAID = `drivecheck-enter-lands-${Date.now()}`;
      await page.evaluate(async () => {
        const m = document.querySelector(".msgs");
        if (m) { m.scrollTop = 0; await new Promise(r => setTimeout(r, 900)); }
      });
      await box.fill(SAID);
      await box.press("Enter");
      await page.waitForSelector(`.msgs .msg:has-text("${SAID}")`, { timeout: 30000 });
      await until("the view to land on the message he just sent", async () =>
        await page.evaluate(said => {
          const m = document.querySelector(".msgs");
          const mine = [...m.querySelectorAll(".msg")].find(r => r.textContent.includes(said));
          const lb = m.getBoundingClientRect();
          const mb = mine?.getBoundingClientRect();
          return m.scrollHeight - m.scrollTop - m.clientHeight < 4
            && !!mb && mb.top < lb.bottom && mb.bottom > lb.top;
        }, SAID), { timeout: 20000, every: 250 });
      await shot(page, "composer-enter-lands");
      return `${calm.inBox} tools stay in the box and hide when idle; ＋ and Send stay on ` +
        "screen in both states; Enter put the view on his own message";
    });
  } catch (err) {
    failGroup([EXPECTED_CHECKS[9], EXPECTED_CHECKS[17], EXPECTED_CHECKS[35]]
      .filter(n => !results.some(r => r.name === n)),
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
    EXPECTED_CHECKS[14], EXPECTED_CHECKS[19], EXPECTED_CHECKS[20],
  ];
  const DRIVE_REPO = "vikas53953/cloud9";

  try {
    await clickRail(page, "projects");
    await page.waitForSelector(".projects", { timeout: 30000 });
    await shot(page, "projects");

    await check(EXPECTED_CHECKS[10], async () => {
      const connect = await page.locator(".projects .topbar [data-connect]").count();
      if (connect === 0) {
        throw new Error("NOT ON SCREEN — the Projects screen opened but offers no way to connect a repository");
      }
      return "Projects opens with a way in";
    });

    /* His repositories, really listed, and click-to-connect — asked BEFORE the
       typed-field check so the picker is what actually connects on a fresh run,
       with typing kept as the proven fallback. */
    await check(EXPECTED_CHECKS[19], async () => {
      if (await page.locator(".connectproj").count() === 0) {
        await page.click(".projects .topbar [data-connect]");
      }
      await page.waitForSelector(".connectproj .repopick", { timeout: 20000 });
      const pick = page.locator(".connectproj .repopick");
      await until("the repository list to settle", async () => {
        const s = await pick.getAttribute("data-repolist");
        return s !== "asking" && s !== "unasked";
      }, { timeout: 90000 });
      const state = await pick.getAttribute("data-repolist");
      if (state === "problem") {
        const why = await pick.locator(".problemtext").innerText().catch(() => "(no reason shown)");
        throw new Error(`the panel could not ask GitHub: ${why}`);
      }
      if (state === "none") {
        throw new Error("GitHub answered 'no repositories' — on this machine that is false, " +
          "the signed-in account owns dozens");
      }
      const rows = await pick.locator(".repochoice").count();
      const dated = await pick.locator("[data-repolist-when]").count();
      if (dated === 0) {
        throw new Error(`${rows} repositories listed without saying when GitHub was asked — ` +
          "the past in the present tense");
      }
      if (!OPTS.fresh) return `${rows} repositories listed, dated — not clicked, this is your real data`;
      const mine = pick.locator(`.repochoice[data-repo-choice="${DRIVE_REPO}"]`);
      if (await mine.count() === 0) {
        return `${rows} repositories listed, dated — ${DRIVE_REPO} not among them, ` +
          "the typed fallback (next check) connects it instead";
      }
      await mine.click();
      await page.waitForSelector(`.proj-list .side-item[data-repo="${DRIVE_REPO}"]`, { timeout: 30000 });
      return `${rows} repositories listed, dated, and clicking ${DRIVE_REPO} connected it`;
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
        if (await page.locator(".connectproj").count() === 0) {
          await page.click(".projects .topbar [data-connect]");
        }
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

    await check(EXPECTED_CHECKS[20], async () => {
      const row = page.locator(".projdetail .pd-folder");
      if (await row.count() === 0) {
        throw new Error("NOT ON SCREEN — nothing on the project says where its code lives " +
          "on this computer, so an agent can never be told");
      }
      const state = await row.getAttribute("data-folder-state");
      if (state === "linked") {
        const where = (await row.locator(".folderpath").innerText().catch(() => "")).trim();
        if (!where) throw new Error('the row claims "linked" but shows no folder');
        return `linked to ${where}`;
      }
      if (state !== "none") {
        throw new Error(`the folder row claims a state the app never defined: "${state}"`);
      }
      const wayIn = await row.locator("[data-folder-choose], #f-folder").count();
      if (wayIn === 0) {
        throw new Error("says the code lives nowhere yet, but offers no way to choose a folder — " +
          "a state he can never leave");
      }
      return "honestly says nowhere yet, with a Choose-folder way in";
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
      /* WAIT FOR THE BUTTON TO BE HIS TO PRESS. Connecting a repository now
         asks GitHub straight away, so on a loaded machine that first look can
         still be in flight when the harness arrives — the button honestly reads
         "Looking at GitHub…" and is disabled. Clicking a disabled button then
         times out and reports a working feature as broken. The state we want to
         test is "he presses it", so wait until it is pressable; a look that is
         ALREADY running is itself proof the control works, so that counts. */
      const settled = await until("the look button to be pressable",
        () => look.first().getAttribute("data-look").then(s => s !== "busy"),
        { timeout: 60000 }).then(() => true).catch(() => false);
      if (!settled) {
        const state = await look.first().getAttribute("data-look");
        return `a look GitHub was already running when the harness arrived (button: ${state}) — ` +
          "the control works; it was busy doing the very thing this check presses for";
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

  /* --- 7b. spending: what the crew costs, and what is wasted -------------
   *
   * THE DOOR IS THE FEATURE. Cloud9 has held the cost of every Claude turn for
   * months and never put one of those figures anywhere he would look. So the
   * thing worth photographing is not the arithmetic — that is proved by 26
   * tests in shared — it is that the page is REACHABLE and says something
   * honest when it gets there.
   *
   * BOTH ANSWERS ARE A PASS, deliberately. On a fresh database nothing has been
   * recorded, and "nothing recorded yet this month" is the true answer; on his
   * real data there are rows. What FAILS is a rail with no Spending in it, a
   * page that never appears, or a page that appears and says nothing at all —
   * which is the one outcome that would leave him staring at a blank wondering
   * whether it was broken or whether he really had spent nothing. */

  try {
    await clickRail(page, "spending");
    await page.waitForSelector(".spending", { timeout: 30000 });
    const spendingShot = await shot(page, "spending");
    // KEPT, not thrown away with the rest. This picture is cited in a pull
    // request, and a path on this machine proves nothing to a reviewer who was
    // not sitting at it. `docs/qa/kept/` is the one place a run may leave
    // something behind — see .gitignore.
    keep(spendingShot, "spending");

    await check(EXPECTED_CHECKS[41], async () => {
      const seen = await page.evaluate(() => {
        const root = document.querySelector(".spending");
        if (!root) return null;
        return {
          heading: root.querySelector("h2")?.innerText.trim() ?? "",
          words: (root.innerText ?? "").replace(/\s+/g, " ").trim(),
          rows: root.querySelectorAll("[data-spend-agent]").length,
          findings: root.querySelectorAll("[data-finding]").length,
          /* WHERE THE MONEY IS ACTUALLY PRINTED, and only there. The first
             version of this check scanned the whole page for "$0.00" and went
             red on the page's own honest sentence — "this agent shows no money
             rather than showing $0.00". The rule being defended is about what
             stands in the money column, so the money column is what it reads. */
          amounts: [...root.querySelectorAll("[data-spend-agent] .amt")]
            .map(a => a.innerText.trim()),
        };
      });
      if (!seen) throw new Error("NOT ON SCREEN — pressing Spending drew no page at all.");
      if (!/spending/i.test(seen.heading)) {
        throw new Error(`NOT ON SCREEN — the page's heading is "${seen.heading}".`);
      }
      // A REAL SENTENCE, EITHER WAY. A page that draws its heading and then
      // nothing is the failure this check is really for.
      const honest = seen.rows > 0
        || /nothing has been recorded yet|working out what everything has cost/i.test(seen.words);
      if (!honest) {
        throw new Error(`NOT ON SCREEN — the page is there but says nothing a person could `
          + `read: "${seen.words.slice(0, 160)}"`);
      }
      // NO INVENTED ZERO, asked of the pixels rather than of a unit test: an
      // agent nobody costed must never appear as $0.00, because that reads as
      // "this one is free" and is the most expensive lie this page could tell.
      const zero = seen.amounts.find(a => /^\$0\.00\b/.test(a));
      if (zero) {
        throw new Error(`a row's money reads "${zero}" — a cost nobody reported must be `
          + "words, never a zero, because a zero reads as 'this one is free'");
      }
      return seen.rows > 0
        ? `${seen.rows} agent row(s), ${seen.findings} named piece(s) of waste`
        : "no turns recorded yet, and it says so plainly";
    });
  } catch (err) {
    fail(EXPECTED_CHECKS[41], err?.message ?? String(err));
    await shot(page, "spending-broken");
  }

  /* --- 8. settings: the GitHub card ------------------------------------- */

  try {
    await page.click('.rail .rail-btn[data-go="settings"]');
    await page.waitForSelector(".githubcard", { timeout: 30000 });
    await shot(page, "settings-github");

    await check(EXPECTED_CHECKS[18], async () => {
      const card = page.locator(".githubcard").first();
      const state = await card.getAttribute("data-state");
      const HONEST = ["checking", "waiting", "not-installed", "signed-in", "not-signed-in"];
      if (!HONEST.includes(state ?? "")) {
        throw new Error(`the GitHub card claims a state the app never defined: "${state}"`);
      }
      /* "Checking" is honest for a moment, not for a walk — wait for a verdict. */
      await until("the card to reach a settled verdict", async () =>
        !["checking", "waiting"].includes(await card.getAttribute("data-state") ?? ""),
        { timeout: 30000 });
      const settled = await card.getAttribute("data-state");
      const dated = await card.locator('.checkedline[data-checked="yes"]').count();
      if (settled !== "not-installed" && dated === 0) {
        throw new Error(`the card says "${settled}" without saying when it actually asked — ` +
          "the past in the present tense");
      }
      if (settled === "signed-in") {
        const who = (await card.locator(".signedintext").innerText().catch(() => "")).trim();
        if (!/signed in as .+/i.test(who)) {
          throw new Error("signed in, but the card does not say as WHO");
        }
        return `${who}, and the card says when it asked`;
      }
      if (settled === "not-signed-in") {
        const wayIn = await card.locator("button, code").count();
        if (wayIn === 0) {
          throw new Error("not signed in, and the card offers no way in at all");
        }
        return "honestly not signed in, with a way in offered";
      }
      return `honestly ${settled}`;
    });

    /* --- 8b. the two cards every agent depends on ------------------------- */

    await page.waitForSelector('.harnesscard[data-harness="claude"]', { timeout: 30000 });
    await shot(page, "settings-apps");

    await check(EXPECTED_CHECKS[36], async () => {
      const said = [];
      for (const name of HARNESS_CARDS) {
        const card = page.locator(`.harnesscard[data-harness="${name}"]`).first();
        if (await card.count() === 0) throw new Error(`Settings has no ${name} card at all`);
        /* "checking…" is what the card says while nothing has been reported.
           An engine that never connects sits here forever, and looks to him
           exactly like an app that is not installed. */
        await until(`the ${name} card to say what was found`, async () =>
          !/^checking/i.test(((await card.locator(".harnessstate").innerText()) ?? "").trim()),
          { timeout: 120000 }).catch(() => {
          throw new Error(`the ${name} card is still "checking…" after two minutes — ` +
            "the engine never reported what it found on this computer");
        });
        said.push(`${name}: ${(await card.locator(".harnessstate").innerText()).trim()}`);
      }
      return said.join(" · ");
    });

    await check(EXPECTED_CHECKS[37], async () => {
      /* ================================================================
       * BOTH FACTS THE CARD DRAWS, IN BOTH DIRECTIONS. (2026-08-12)
       * ================================================================
       *
       * This check used to compare ONE of the card's two facts — "✓ app found"
       * against `<cli> --version` — and never asked about signing in. That is
       * how blocker 3 passed a 36/36 walk: detection can return
       * `installed:true, signedIn:false`, the card says "app found", this check
       * agrees, and EVERY AGENT IN THE APP answers "my engine isn't connected".
       * The card that decides whether anything can run was half-asserted.
       *
       * THE CARD HAS THREE STATES, NOT TWO, and this asserts all three
       * truthfully. Sign-in reads `✓ signed in`, `✗ not signed in`, or
       * `· sign-in not confirmed` — the last meaning the probe never answered,
       * which is a real and different thing from a no. The app-found fact has
       * only two (`✓ app found` / `· app not confirmed`), because `installed`
       * alone genuinely cannot tell "not here" from "did not answer", so its
       * negative deliberately claims neither.
       *
       * What is asserted:
       *   · `✓ app found`      ⟺ `<cli> --version` really answers. Both ways.
       *   · `✓ signed in`      ⟺ the CLI really reports a signed-in account.
       *   · `✗ not signed in`  ⟹ the CLI really said no. A HARD CLAIM THAT IS
       *                          WRONG IS THE EXPENSIVE ONE — it is the
       *                          2026-08-05 report, and it costs a diagnosis
       *                          round every time.
       *   · `· not confirmed`  ⟹ only that the card claims neither ✓ nor ✗.
       *                          Not failed against a signed-in CLI: the app's
       *                          probe can legitimately have given up where
       *                          this walk's longer one did not, and failing
       *                          that would make this check flaky, which is
       *                          worse than weak. It is reported in the detail
       *                          so a person can still see it.
       *
       * AND IT IS LET TO SETTLE FIRST. The card's own "Re-check" is pressed and
       * the button is waited out, so a card caught mid-probe is never mistaken
       * for a card that disagrees. */
      const wrong = [];
      const agreed = [];
      const noted = [];
      for (const name of HARNESS_CARDS) {
        const card = page.locator(`.harnesscard[data-harness="${name}"]`).first();
        if (await card.count() === 0) throw new Error(`Settings has no ${name} card at all`);

        /* Press the app's own Re-check and let it finish.
         *
         * WAIT FOR IT TO START BEFORE WAITING FOR IT TO STOP (2026-08-13).
         * Waiting only for "Checking…" to go away is a wait that can do nothing
         * at all: `until` runs its question immediately, and the button only
         * says "Checking…" after `refreshHarness` has crossed the socket, the
         * engine has set the flag and the screen has redrawn. Land the first
         * poll before that round-trip and the button still says "Re-check", the
         * wait returns satisfied on poll zero, and the comparison below reads a
         * card that is about to correct itself — hard-failing on a stale
         * "✗ not signed in", which is precisely the flakiness this settle step
         * was added to prevent.
         *
         * A MISSED START IS NOT A FAILURE. A quick harness can finish before we
         * can see it begin, so not observing the start is treated as "already
         * settled" — never as a fault. The check must not be able to go red
         * because of its own timing either way.
         *
         * The button is named rather than positioned: the card has a second
         * `.harnessbtns` block whose button is "Remove saved key", and a
         * positional selector one DOM reorder away from deleting a real
         * credential is not something to leave in a walk that also runs in
         * `--real-data` mode. */
        const recheck = card.getByRole("button", { name: /^(Re-check|Checking…)$/ });
        if (await recheck.count()) {
          const label = async () =>
            (await recheck.first().innerText().catch(() => "")).trim();
          await recheck.first().click().catch(() => { /* already looking */ });
          await until(`the ${name} card to start looking at this computer`,
            async () => /checking/i.test(await label()),
            { timeout: 5000, every: 100 })
            .catch(() => { /* it answered before we could see it start — fine */ });
          /* 3 minutes, not 5. A full detection round costs about 30 seconds and
             five child processes, so this is already six times the measured
             worst case — and this check's total budget is worth watching: two
             cards × (this wait + a sign-in probe below) is the largest single
             cost in the walk. */
          await until(`the ${name} card to finish looking at this computer`,
            async () => !/checking/i.test(await label()),
            { timeout: 180000, every: 500 })
            .catch(() => { throw new Error(`the ${name} card never finished re-checking, so ` +
              "nothing it says can be compared with this computer"); });
        }
        await until(`the ${name} card to say what it found`, async () =>
          !/^checking/i.test(((await card.locator(".harnessstate").innerText()) ?? "").trim()),
          { timeout: 120000 }).catch(() => {
          throw new Error(`the ${name} card is still "checking…" after two minutes`);
        });

        const words = (await card.locator(".harnessfacts").innerText()).replace(/\s+/g, " ");
        const state = (await card.locator(".harnessstate").innerText()).replace(/\s+/g, " ").trim();
        const saysFound = /✓ app found/.test(words);
        const saysSignedIn = /✓ signed in/.test(words);
        const saysSignedOut = /✗ not signed in/.test(words);
        const saysSignInUnknown = /· sign-in not confirmed/.test(words);
        const savedKey = /✓ key saved on this computer/.test(words);

        // ---- fact one: is the app here at all
        const found = cliOnThisComputer(name);
        if (found.present && !saysFound) {
          wrong.push(`${name}: this computer answers "${found.version}", and the card will not ` +
            `say the app is here — it reads "${state}"`);
          continue;
        }
        if (!found.present && saysFound) {
          wrong.push(`${name}: the card claims the app is here, but this computer cannot run it ` +
            `(${found.why})`);
          continue;
        }

        /* ================================================================
         * A SAVED KEY SETTLES THE SIGN-IN, WHATEVER THE CLI SITUATION IS.
         * ================================================================
         *
         * Read straight off `applyProviders` in `host.ts`, which is the code
         * that actually decides whether a turn can run: it builds an
         * `SdkProvider` from a held credential BEFORE it ever looks at
         * `lastState.installed`. So "a key saved in Settings and no CLI on the
         * machine at all" is a fully working configuration, and the harness
         * manager's merge correctly draws `✓ signed in` + `✓ key saved` +
         * `· app not confirmed` for it.
         *
         * This escape used to live below, inside the branch for a CLI that IS
         * present, so it could never be reached on that machine — and the check
         * then failed with "the card claims a signed-in account for an app this
         * computer cannot even run" while every agent in the app worked
         * perfectly. A gating check calling a correct app a liar is the exact
         * failure this whole PR is about, so the order here mirrors the order
         * in `host.ts` rather than an order that reads naturally. */
        if (savedKey && saysSignedIn) {
          agreed.push(`${name} runs on a key saved in Settings` +
            `${found.present ? ` (the app is here too: ${found.version})` : " — the app itself " +
              "is not on this computer, and it does not need to be"}`);
          continue;
        }

        if (!found.present) {
          if (saysSignedIn) {
            wrong.push(`${name}: the card claims a signed-in account with no saved key and no ` +
              "app on this computer to hold one");
            continue;
          }
          agreed.push(`${name} genuinely absent, and the card claims nothing it cannot know`);
          continue;
        }

        // ---- fact two: is it signed in. Only asked when the app really is here.
        const login = signedInOnThisComputer(name);
        if (!login.answered) {
          /* This walk could not get an answer either. It refuses to accuse the
             card of anything on the strength of its own timeout — but a card
             claiming a HARD verdict it cannot have is still wrong. */
          if (saysSignedIn || saysSignedOut) {
            wrong.push(`${name}: the card states "${saysSignedIn ? "signed in" : "not signed in"}" ` +
              "as a fact, and this computer would not answer the same question at all");
            continue;
          }
          noted.push(`${name} found (${found.version}); neither the app nor this walk could get ` +
            "a sign-in answer out of it");
          continue;
        }
        if (login.signedIn && saysSignedOut) {
          wrong.push(`${name}: this computer IS signed in, and Settings tells him it is not — ` +
            "the 2026-08-05 report, and the direction that costs a whole diagnosis round");
          continue;
        }
        if (!login.signedIn && saysSignedIn) {
          wrong.push(`${name}: the card claims a signed-in account, and this computer says ` +
            `otherwise (${login.why ?? "no account reported"}) — every turn will refuse`);
          continue;
        }
        if (saysSignInUnknown) {
          if (saysSignedIn || saysSignedOut) {
            wrong.push(`${name}: the card says the sign-in is unconfirmed AND states a verdict ` +
              `in the same breath: "${words.trim()}"`);
            continue;
          }
          noted.push(`${name} found (${found.version}); the app has not confirmed its sign-in ` +
            `(this computer says ${login.signedIn ? "signed in" : "signed out"}), and the card ` +
            "honestly claims neither");
          continue;
        }
        agreed.push(`${name} found (${found.version}), and ` +
          `${login.signedIn ? "signed in" : "genuinely signed out"} — the card agrees on both`);
      }
      if (wrong.length) throw new Error(wrong.join("; "));
      return [...agreed, ...noted].join(" · ");
    });
  } catch (err) {
    failGroup([EXPECTED_CHECKS[18], EXPECTED_CHECKS[36], EXPECTED_CHECKS[37]]
      .filter(n => !results.some(r => r.name === n)),
      `the Settings screen did not open (${err.message})`);
    await shot(page, "settings-broken");
  }

  /* --- 9. Files: provenance, immutable history, access and typed links ----- */
  const FILES_GROUP = [
    EXPECTED_CHECKS[21], EXPECTED_CHECKS[22], EXPECTED_CHECKS[23], EXPECTED_CHECKS[24],
    EXPECTED_CHECKS[25], EXPECTED_CHECKS[26], EXPECTED_CHECKS[27],
    /* Search rides with this group because it is proved against the very file
       this group publishes — one seeded world, one failure story if the
       engine socket or the fresh-data guard stops it before either can run. */
    EXPECTED_CHECKS[28],
  ];
  let installedEngine = null;
  let memberSidecar = null;
  let memberPage = null;
  try {
    await clickRail(page, "files");
    await page.waitForSelector("[data-files-screen]", { timeout: 30000 });
    const toolsDoor = page.locator("[data-open-tools]");
    let refreshObserver = null;
    await checkWithRequiredCleanup(EXPECTED_CHECKS[21], async () => {
      const index = page.locator('[data-files-screen] .files-index[aria-label="Files you can read"]');
      const refresh = page.locator("[data-files-screen] .files-refresh");
      const hit = await page.evaluate(() => {
        const el = document.querySelector('[data-files-screen] .files-index[aria-label="Files you can read"]');
        if (!(el instanceof HTMLElement)) return false;
        const style = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        const at = document.elementFromPoint(box.left + Math.min(8, box.width / 2), box.top + Math.min(8, box.height / 2));
        return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0
          && box.width > 0 && box.height > 0 && !!at && el.contains(at);
      });
      if ((await toolsDoor.count()) !== 1 || !await toolsDoor.isVisible() || !await toolsDoor.isEnabled()
        || (await index.count()) !== 1 || !await index.isVisible() || !hit
        || (await refresh.count()) !== 1 || !await refresh.isVisible()) {
        throw new Error("NOT ON SCREEN — the Files door/index is hidden, covered, or cannot be used");
      }
      await until("the Files index's first request to settle", async () => {
        const baseline = await page.evaluate(() => ({
          workspace: window.cloud9Artifacts.workspace(),
          pending: window.cloud9Wire.questions()
            .filter(question => question.kind === "artifactWorkspace").length,
        }));
        return await refresh.isEnabled()
          && (await page.locator("[data-files-screen]").getAttribute("data-files-state")) !== "loading"
          && baseline.workspace.asked && !baseline.workspace.loading && baseline.pending === 0;
      }, { timeout: 20000 });

      const baselineAnswers = await page.evaluate(() =>
        window.cloud9Wire.seen().artifactWorkspace ?? 0);
      refreshObserver = await createWorkspaceRefreshObserver(page, baselineAnswers);
      refreshObserver.start();
      await refresh.click();

      let observation;
      await until("this exact Files refresh request and its matching answer on one socket", async () => {
        const probe = refreshObserver.snapshot();
        const screen = await page.evaluate(() => ({
          answers: window.cloud9Wire.seen().artifactWorkspace ?? 0,
          workspace: window.cloud9Artifacts.workspace(),
        }));
        observation = { probe, ...screen };
        return workspaceRefreshCompleted(observation);
      }, { timeout: 20000 });
      const state = await page.locator("[data-files-screen]").getAttribute("data-files-state");
      if (state === "error") throw new Error("the Files index is visible but its refresh came back with an error");
      return `visible, hit-testable index; refresh ${observation.probe.requestId} got its bound response ` +
        `on socket ${observation.probe.socketId}; state=${state}`;
    }, async () => {
      if (refreshObserver) await refreshObserver.dispose();
    });

    if (!OPTS.fresh) {
      throw new Error("NOT CHECKED — creating the linked two-version file and member would change your real Cloud9; " +
        "run without --real-data for the permanent Files walk");
    }

    const known = await page.evaluate(() => ({
      channels: window.cloud9Wire.channels(),
      agents: window.cloud9Wire.agents(),
      me: window.cloud9Wire.me(),
    }));
    const channel = known.channels.find(c => c.name === "general") ?? known.channels[0];
    const owned = known.agents.filter(a => a.ownerId === known.me);
    const agent1 = owned.find(a => a.name === "Drivecheck") ?? owned[0];
    const agent2 = owned.find(a => a.id !== agent1?.id);
    if (!channel || !agent1 || !agent2) {
      throw new Error("the fresh app needs one room and two different owned agents to prove a real version handoff");
    }

    installedEngine = await connectInstalledEngine(page);
    const stamp = Date.now().toString(36);
    const V1_BYTES = "# Installed Files proof\nFirst retained draft.\n";
    const V2_BYTES = "# Installed Files proof\nSecond retained draft.\n";
    const TARGET_V1_BYTES = "source,value\ninstalled,1\n";
    const TARGET_V2_BYTES = "source,value\ninstalled,2\n";
    const runOf = (maker, id, ask) => ({
      kind: "chat", id, agentId: maker.id, agentName: maker.name, channelId: channel.id,
      requestedBy: "Vikas", requestedByKind: "human", provider: "claude",
      model: "claude-sonnet-5", ask, outcome: "ok", steps: [],
      startedAt: Date.now(), finishedAt: Date.now() + 700, durationMs: 700,
      replyChars: 72, events: 1,
    });
    const run1 = runOf(agent1, `r-drive-files-v1-${stamp}`, "draft the installed Files proof");
    const run2 = runOf(agent2, `r-drive-files-v2-${stamp}`, "revise the installed Files proof");
    installedEngine.record(run1);
    installedEngine.record(run2);
    /* This WebSocket is ordered: each recorded turn is durable before a later
       publish attributes a version to it. Different agents and turn ids make a
       stale "first maker" label unable to pass as the latest attribution. */

    const linkTarget = await installedEngine.publish({
      channelId: channel.id, agentId: agent1.id, agentName: agent1.name,
      name: "drivecheck-source.csv", data: TARGET_V1_BYTES, expectedVersion: 1,
    });
    const v1 = await installedEngine.publish({
      channelId: channel.id, agentId: agent1.id, agentName: agent1.name,
      name: "drivecheck-files.md", data: V1_BYTES, expectedVersion: 1, runId: run1.id,
    });
    const v2 = await installedEngine.publish({
      channelId: channel.id, agentId: agent2.id, agentName: agent2.name,
      name: "drivecheck-files.md", data: V2_BYTES, expectedVersion: 2, artifactId: v1.id,
      runId: run2.id, note: "revised for the installed walk",
      links: [{ kind: "made-from", target: { artifactId: linkTarget.id, version: 1 } }],
    });
    const linkTargetV2 = await installedEngine.publish({
      channelId: channel.id, agentId: agent2.id, agentName: agent2.name,
      name: "drivecheck-source.csv", data: TARGET_V2_BYTES, expectedVersion: 2,
      artifactId: linkTarget.id, note: "newer source bytes which the exact-v1 link must not open",
    });
    if (linkTargetV2.id !== linkTarget.id) {
      throw new Error("publishing source version 2 created a second target instead of exact-version history");
    }
    await assertArtifactBytes(page, linkTarget.id, 2, TARGET_V2_BYTES,
      "the linked target's verified latest v2");
    const markdownOnly = await installedEngine.publish({
      channelId: channel.id, agentId: agent1.id, agentName: agent1.name,
      name: "drivecheck-markdown.md", data: `[older draft](${artifactRef(v1.id, 1)})\n`,
      expectedVersion: 1,
    });
    if (v2.id !== v1.id) throw new Error("publishing version 2 created a second file instead of one history");

    await page.waitForSelector(`.file-index-row[data-file-row="${v1.id}"]`, { timeout: 30000 });
    const row = page.locator(`.file-index-row[data-file-row="${v1.id}"]`);
    await row.click();
    await page.waitForSelector(`.files-detail[data-file-detail="${v1.id}"][data-file-detail-state="here"]`,
      { timeout: 30000 });

    await check(EXPECTED_CHECKS[22], async () => {
      const words = (await row.locator(".file-index-maker").innerText()).replace(/\s+/g, " ").trim();
      if (agent1.id === agent2.id || run1.id === run2.id
        || (await row.getAttribute("data-maker")) !== agent2.name
        || (await row.getAttribute("data-turn")) !== run2.id
        || !words.includes(agent2.name) || !words.includes(run2.id)
        || words.includes(agent1.name + ` turn ${run1.id}`)) {
        throw new Error(`NOT ON SCREEN — latest row attribution is "${words}" after ${agent1.name} handed off to ${agent2.name}`);
      }
      return `${agent1.name}/${run1.id} handed off to ${words}`;
    });

    await check(EXPECTED_CHECKS[23], async () => {
      const card = page.locator(`.files-detail .artcard[data-artifact="${v1.id}"]`);
      await card.locator(".arthistory").click();
      await page.waitForSelector(`.files-detail .artcard[data-artifact="${v1.id}"] .artversion[data-version="1"]`,
        { timeout: 15000 });
      const old = card.locator('.artversion[data-version="1"]');
      await old.locator(".artopen-old").click();
      await page.waitForSelector(`.files-detail .artcard[data-artifact="${v1.id}"] .artversion[data-version="1"] .artpeek pre`,
        { timeout: 15000 });
      const oldByteCount = await assertArtifactBytes(page, v1.id, 1, V1_BYTES,
        "the source file's retained historical v1");
      const detail = await page.evaluate(id => window.cloud9Artifacts.detail(id), v1.id);
      const first = detail?.versions?.find(version => version.version === 1);
      const latest = detail?.versions?.find(version => version.version === 2);
      if ((await card.getAttribute("data-versions")) !== "2"
        || (await old.locator(".vwho b").innerText()).trim() !== agent1.name
        || first?.agentName !== agent1.name || first?.runId !== run1.id
        || latest?.agentName !== agent2.name || latest?.runId !== run2.id) {
        throw new Error(`history did not retain v1 maker/turn after the v2 handoff: ` +
          `${first?.agentName}/${first?.runId}`);
      }
      return `${agent1.name}/${run1.id} made v1; ticket fetched ${oldByteCount} exact retained bytes`;
    });

    /* Join through a real single-use invite in one separately owned Chromium
       process. Its HTTP screen is the exact installed renderer tree approved by
       the launch guard; only the owner stays in the CDP-attached Electron app. */
    await page.click('.rail .rail-btn[data-go="chat"]');
    await ensureChatFilesSidebar(page);
    await page.waitForSelector('button[title="Invite a friend"]', { timeout: 20000 });
    await page.click('button[title="Invite a friend"]');
    await page.waitForFunction(() => document.querySelector(".code")?.textContent?.startsWith("inv_"),
      undefined, { timeout: 20000 });
    const invite = (await page.locator(".code").innerText()).trim();
    if (!/^inv_[A-Za-z0-9_-]+$/.test(invite)) throw new Error("the installed owner did not mint a valid invite");
    await page.click('.overlay .foot button:has-text("Done")');
    const installedRelay = new URL(page.url()).searchParams.get("relay");
    memberSidecar = await launchInstalledMemberSidecar(installedRendererApproval, installedRelay);
    memberPage = memberSidecar.page;
    await assertPlainMemberStart(memberSidecar, installedRelay);
    await memberPage.click("text=I have an invite");
    await memberPage.fill('.panel input[placeholder="inv_…"]', invite);
    await memberPage.fill('.panel input[placeholder="Priya"]', `Files member ${stamp}`);
    await memberPage.click("text=Enter Cloud9");
    await waitForEstablishedIdentity(memberPage);
    const memberId = await assertRedeemedMemberIdentity(memberPage, known.me);
    await memberSidecar.reconnect(memberId, known.me);
    memberPage = memberSidecar.page;

    await clickRail(page, "files");
    await page.waitForSelector(`.file-index-row[data-file-row="${v1.id}"]`, { timeout: 20000 });
    await row.click();
    await page.waitForSelector(`.files-detail[data-file-detail="${v1.id}"][data-file-detail-state="here"]`,
      { timeout: 20000 });
    await clickRail(memberPage, "files");
    await memberPage.waitForSelector(`.file-index-row[data-file-row="${v1.id}"]`, { timeout: 20000 });
    await memberPage.click(`.file-index-row[data-file-row="${v1.id}"]`);
    await memberPage.waitForSelector(
      `.files-detail[data-file-detail="${v1.id}"] .fileaccess[data-access-editor="read-only"]`,
      { timeout: 20000 });

    const access = page.locator(`.files-detail[data-file-detail="${v1.id}"] .fileaccess`);
    const memberAccess = memberPage.locator(`.files-detail[data-file-detail="${v1.id}"] .fileaccess`);
    await page.waitForSelector(`.files-detail[data-file-detail="${v1.id}"] .fileaccess[data-access-editor="yes"]`,
      { timeout: 20000 });
    await check(EXPECTED_CHECKS[24], async () => {
      const words = (await access.innerText()).replace(/\s+/g, " ").trim();
      const memberWords = (await memberAccess.innerText()).replace(/\s+/g, " ").trim();
      const memberControls = await memberAccess
        .locator('button, input, select, textarea, [role="button"], [contenteditable="true"]')
        .count();
      if ((await access.getAttribute("data-file-access")) !== "room"
        || (await access.locator('[data-access-choice="room"]').getAttribute("aria-pressed")) !== "true"
        || !/Everyone currently in the room/i.test(words)
        || (await memberAccess.getAttribute("data-access-editor")) !== "read-only"
        || memberControls !== 0 || !/Only this room.+owner or an admin can change that/i.test(memberWords)) {
        throw new Error(`NOT ON SCREEN — manager/member access differs from the real roles; member controls=${memberControls}`);
      }
      return "owner has the editor; a separately signed-in plain member has zero permission controls";
    });

    const restoreRoomAccess = async () => {
      /* Clear any unsaved restricted draft on screen first. Then send room access
         once more through the app's own wire as the LAST command, so even a slow
         restriction save cannot land after cleanup and leave later checks dirty. */
      await until("the access editor to stop saving before cleanup", async () =>
        (await access.getAttribute("data-access-saving")) !== "yes", { timeout: 30000 }).catch(() => false);
      if (await access.locator('[data-access-choice="room"]').count()) {
        await access.locator('[data-access-choice="room"]').click();
        const save = access.locator("[data-access-save]");
        if (await save.isEnabled()) await save.click();
      }
      await page.evaluate(id => window.cloud9Artifacts.setAccess(id, { kind: "room" }), v1.id);
      await until("room access to be restored after the restriction proof", async () =>
        (await row.getAttribute("data-access")) === "room"
          && (await access.getAttribute("data-file-access")) === "room"
          && (await access.getAttribute("data-access-saving")) !== "yes",
      { timeout: 30000 });
      await row.click();
      await page.waitForSelector(`.files-detail[data-file-detail="${v1.id}"][data-file-detail-state="here"]`,
        { timeout: 20000 });
      await memberPage.waitForSelector(`.file-index-row[data-file-row="${v1.id}"]`, { timeout: 30000 });
      await memberPage.click(`.file-index-row[data-file-row="${v1.id}"]`);
      await memberPage.waitForSelector(
        `.files-detail[data-file-detail="${v1.id}"][data-file-detail-state="here"] .fileaccess[data-access-editor="read-only"]`,
        { timeout: 20000 });
    };

    await checkWithRequiredCleanup(EXPECTED_CHECKS[25], async () => {
      const memberCard = memberPage.locator(`.files-detail .artcard[data-artifact="${v1.id}"]`);
      await memberCard.locator(".artopen").click();
      await memberPage.waitForSelector(`.files-detail .artcard[data-artifact="${v1.id}"] .artpeek pre`,
        { timeout: 15000 });
      const memberPreviewBefore = await memberCard.locator(".artpeek pre").innerText();
      await access.locator('[data-access-choice="restricted"]').click();
      const manager = access.locator('.accessperson[data-required="yes"] input:disabled').first();
      const excludedMember = access.locator(`.accessperson[data-access-user="${memberId}"][data-required="no"] input`);
      if (await manager.count() === 0 || await excludedMember.count() !== 1
        || await excludedMember.isChecked() || !/managers are required/i.test(await access.innerText())) {
        throw new Error("NOT ON SCREEN — restriction does not require managers and exclude the real plain member");
      }
      await access.locator("[data-access-save]").click();
      await page.waitForSelector(`.file-index-row[data-file-row="${v1.id}"][data-access="restricted"]`,
        { timeout: 20000 });
      const managerByteCount = await assertArtifactBytes(page, v1.id, 2, V2_BYTES,
        "the manager's fresh restricted-file read");
      await memberPage.waitForSelector(".files-detail [data-file-unavailable]", { timeout: 20000 });
      await until("the restricted file to leave the member's Files index", () =>
        memberPage.locator(`.file-index-row[data-file-row="${v1.id}"]`).count().then(n => n === 0),
      { timeout: 20000 });
      const memberDetailAfter = await memberPage.evaluate(id => window.cloud9Artifacts.detail(id), v1.id);
      const ownerDetail = await page.evaluate(id => window.cloud9Artifacts.detail(id), v1.id);
      const ownerStillHasIt = (await row.count()) === 1
        && (await page.locator(`.files-detail .artcard[data-artifact="${v1.id}"]`).count()) === 1
        && ownerDetail !== null;
      const memberLostIt = (await memberPage.locator(`.artcard[data-artifact="${v1.id}"]`).count()) === 0
        && (await memberPage.locator(".files-detail .artpeek pre").count()) === 0
        && memberDetailAfter === null;
      if (memberPreviewBefore !== V2_BYTES || (await access.getAttribute("data-file-access")) !== "restricted"
        || !ownerStillHasIt || !memberLostIt) {
        throw new Error(`restriction did not revoke already-open member bytes while keeping manager access; ` +
          `member before=${JSON.stringify(memberPreviewBefore)}, owner=${ownerStillHasIt}, member revoked=${memberLostIt}`);
      }
      return `excluded member's open detail/bytes were revoked; manager freshly fetched ${managerByteCount} v2 bytes`;
    }, restoreRoomAccess);

    /* The member proof is complete. Tear down its separate process/server before
       later Files claims; a cleanup failure makes those later claims invalid. */
    await memberSidecar.close();
    const memberCleanupNotes = memberSidecar.cleanupObservations();
    if (memberCleanupNotes.length) console.log(`  (member sidecar shutdown noted: ${memberCleanupNotes.join("; ")})`);
    memberSidecar = null;
    memberPage = null;

    await check(EXPECTED_CHECKS[27], async () => {
      const markdownRow = page.locator(`.file-index-row[data-file-row="${markdownOnly.id}"]`);
      await markdownRow.click();
      await page.waitForSelector(`.files-detail[data-file-detail="${markdownOnly.id}"] [data-relations-state="empty"]`,
        { timeout: 20000 });
      const card = page.locator(`.files-detail .artcard[data-artifact="${markdownOnly.id}"]`);
      await card.locator(".artopen").click();
      await page.waitForSelector(`.files-detail .artcard[data-artifact="${markdownOnly.id}"] .artpeek pre`,
        { timeout: 15000 });
      const words = await card.locator(".artpeek pre").innerText();
      const relations = await page.locator(`.files-detail[data-file-detail="${markdownOnly.id}"] .relationrow`).count();
      if (relations !== 0 || !words.includes("cloud9://artifact/")) {
        throw new Error(`markdown-only file has ${relations} stored relation(s)`);
      }
      return "the markdown reference is visible in the file, with zero stored relations";
    });

    await row.click();
    await page.waitForSelector(`.files-detail[data-file-detail="${v1.id}"] .relationtarget[data-linked-artifact="${linkTarget.id}"][data-linked-version="1"]`,
      { timeout: 20000 });
    await check(EXPECTED_CHECKS[26], async () => {
      const link = page.locator(`.files-detail[data-file-detail="${v1.id}"] .relationrow[data-relation-kind="made-from"] ` +
        `.relationtarget[data-linked-artifact="${linkTarget.id}"][data-linked-version="1"]`).first();
      const words = (await link.innerText()).replace(/\s+/g, " ").trim();
      const markdownLinks = await page.locator(`.files-detail[data-file-detail="${v1.id}"] .filerelations a.mdlink`).count();
      await link.click();
      await page.waitForSelector(`.files-detail[data-file-detail="${linkTarget.id}"] ` +
        `.artcard[data-artifact="${linkTarget.id}"][data-version="1"]`, { timeout: 15000 });
      const targetCard = page.locator(`.files-detail .artcard[data-artifact="${linkTarget.id}"]`);
      await targetCard.locator(".artopen").click();
      await page.waitForSelector(`.files-detail .artcard[data-artifact="${linkTarget.id}"] .artpeek pre`,
        { timeout: 15000 });
      const exactByteCount = await assertArtifactBytes(page, linkTarget.id, 1, TARGET_V1_BYTES,
        "the typed relationship's exact target v1");
      if (!/v1/i.test(words) || markdownLinks !== 0
        || (await targetCard.getAttribute("data-version")) !== "1") {
        throw new Error(`typed link did not open the distinct historical v1 control: "${words}"`);
      }
      return `${words}; target v2 was fetched first, then the link opened/fetched ${exactByteCount} exact v1 bytes`;
    });
    await shot(page, "files-workspace");

    /* ---- SEARCH EVERYWHERE, in the installed app ---- */
    await check(EXPECTED_CHECKS[28], async () => {
      /* A rare word, stamped, so a hit can only be THIS run's message. */
      const seededWord = `wobbegong${stamp}`;
      await page.click('.rail .rail-btn[data-go="chat"]');
      await page.waitForSelector(".composer textarea", { timeout: 30000 });
      await page.fill(".composer textarea", `the ${seededWord} sighting was near the reef`);
      await page.press(".composer textarea", "Enter");
      await page.waitForSelector(`.msgs .msg:has-text("${seededWord}")`, { timeout: 30000 });
      const messageId = await page.locator(`.msgs .msg:has-text("${seededWord}")`)
        .last().getAttribute("data-msg");
      /* WHICH conversation, by its NAME — never by the whole header's text.
         The header also carries the agent's live presence, so a harness that
         compared the rendered words failed the moment the agent went from
         "Ready" to "Working" between the two reads: two identical rooms, one
         string that changed underneath. A check that fails on a truth nobody
         broke is worse than no check. */
      const roomWords = (await page.locator(".thread .topbar .ch-title").innerText())
        .replace(/\s+/g, " ").trim();

      const open = async words => {
        await page.evaluate(() => window.cloud9Menu.run("search"));
        await page.waitForSelector('.searchpanel .searchscopes[data-search-scope="everywhere"]',
          { timeout: 20000 });
        await page.fill(".search-input", words);
      };

      await open(seededWord);
      await page.waitForSelector(
        `.everyhit[data-every-kind="message"][data-every-hit="${messageId}"]`, { timeout: 30000 });

      /* The same one box, the file this group really published. */
      await page.fill(".search-input", "drivecheck-files.md");
      await page.waitForSelector(`.everyhit[data-every-kind="file"][data-every-hit="${v1.id}"]`,
        { timeout: 30000 });
      const fileWords = (await page.locator(
        `.everyhit[data-every-kind="file"][data-every-hit="${v1.id}"]`).innerText())
        .replace(/\s+/g, " ").trim();

      await open(seededWord);
      const hit = page.locator(`.everyhit[data-every-kind="message"][data-every-hit="${messageId}"]`);
      await hit.waitFor({ timeout: 30000 });
      await hit.click();
      await page.waitForSelector(`.msgs .msg[data-msg="${messageId}"].litup`, { timeout: 30000 });
      const landedIn = (await page.locator(".thread .topbar .ch-title").innerText())
        .replace(/\s+/g, " ").trim();
      if ((await page.locator(".searchpanel").count()) !== 0) {
        throw new Error("following a result left the search panel open on top of the room");
      }
      if (landedIn !== roomWords) {
        throw new Error(`the message result landed in "${landedIn}", not the room it was said in ("${roomWords}")`);
      }
      await shot(page, "search-everywhere");
      return `found the message and "${fileWords.slice(0, 40)}", and landed on it in ${landedIn.slice(0, 40)}`;
    });
  } catch (err) {
    failGroup(FILES_GROUP.filter(n => !results.some(r => r.name === n)),
      `the Files walk could not finish (${err.message})`);
    await shot(page, "files-broken");
  } finally {
    const cleanupProblems = [];
    try { await memberSidecar?.close(); }
    catch (err) { cleanupProblems.push(`member sidecar: ${err?.message ?? String(err)}`); }
    try { await installedEngine?.close(); }
    catch (err) { cleanupProblems.push(`installed engine: ${err?.message ?? String(err)}`); }
    if (cleanupProblems.length) {
      throw new Error(`required Files cleanup failed; later checks are invalid (${cleanupProblems.join("; ")})`);
    }
  }

  /* --- 10. turn coordination: one owner per answer, trouble said out loud ----
   *
   * WHAT IS REAL HERE AND WHAT IS SEEDED, said plainly, the same way the browser
   * suite says it. The MENTION half is real all the way down: a real message,
   * typed into the real composer of the installed app, routed by the real engine
   * on this computer — nothing about the answer is written by this harness, and
   * if the machine's Claude is not signed in the agent still says so out loud in
   * its own voice, which is still exactly one answer. The JOBS are real too —
   * created through the app's own frame, minted and stored by the hub, run by
   * the engine, broadcast back like any other. Only their FINAL STATE is seeded:
   * the engine cannot yet report "blocked" at all, so that state and its reason
   * are written onto the stored job with the hub's own `updateTask`, over the
   * same owned connection the Files checks publish through, and only once the
   * engine has finished with the job so there is no race with its own result.
   */

  const COORD_GROUP = [
    EXPECTED_CHECKS[29], EXPECTED_CHECKS[30], EXPECTED_CHECKS[31], EXPECTED_CHECKS[32],
    EXPECTED_CHECKS[34],
  ];
  let coordEngine = null;
  try {
    if (!OPTS.fresh) {
      throw new Error("NOT CHECKED — asking two agents to answer and seeding a stuck job would " +
        "change your real Cloud9; run without --real-data for the permanent coordination walk");
    }

    await page.click('.rail .rail-btn[data-go="chat"]');
    await page.waitForSelector(".composer textarea", { timeout: 30000 });
    await ensureChatFilesSidebar(page);
    const crew = await page.evaluate(() => ({
      channels: window.cloud9Wire.channels(),
      agents: window.cloud9Wire.agents(),
      me: window.cloud9Wire.me(),
    }));
    const room = crew.channels.find(c => c.name === "general") ?? crew.channels[0];
    const mine = crew.agents.filter(a => a.ownerId === crew.me);
    const first = mine[0];
    const second = mine.find(a => a.id !== first?.id);
    if (!room || !first || !second) {
      throw new Error("the fresh app needs one room and two different owned agents before " +
        "'only one of them answers' means anything");
    }
    const general = page.locator(`.sidebar .side-item[data-channel="${room.name}"]`).first();
    if (await general.count()) await general.click();
    await page.waitForSelector(".composer textarea", { timeout: 20000 });

    /* Both named agents must actually be IN the room, or the rule never gets
       asked: an agent that is not a member cannot own a turn and cannot be
       passed over either, so a silent second agent would prove nothing.
       It is the hub's own `addMembers` — the identical frame the room's "Add
       someone…" control sends — over this walk's owned connection, and the
       proof it took is the hub's own broadcast of the room coming back with
       both agents in it. The screen's QA hook cannot answer this: it reports
       a conversation's id and name only, never who is in it. */
    coordEngine = await connectInstalledEngine(page);
    const membersFrom = coordEngine.frames.length;
    const askedMembers = coordEngine.ask({
      type: "addMembers", channelId: room.id, memberIds: [first.id, second.id],
    });
    await until(`${first.name} and ${second.name} to be members of ${room.name}`, () => {
      const recent = coordEngine.frames.slice(membersFrom);
      const refused = recent.find(f => f.type === "error" && f.requestId === askedMembers);
      if (refused) throw new Error(refused.error);
      const latest = recent.filter(f => f.type === "channel" && f.channel?.id === room.id).pop();
      const ids = latest?.channel?.memberIds ?? [];
      return ids.includes(first.id) && ids.includes(second.id);
    }, { timeout: 30000, every: 100 });

    await check(EXPECTED_CHECKS[32], async () => {
      /* Nobody mid-turn from anything earlier in the walk, or a reply that was
         already on its way could be counted as an answer to this message. */
      await until("the room to be quiet before the two agents are named", async () =>
        (await page.locator(".msgs .msg .thinking").count()) === 0, { timeout: 120000 });
      await page.fill(".composer textarea", `@${first.name} @${second.name} say the word ok`);
      await page.press(".composer textarea", "Enter");
      await page.waitForSelector('.msgs .msg:has-text("say the word ok")', { timeout: 30000 });

      /* WHERE THE ANSWERS ARE. Since 2026-08-04 an answer to a message typed in
         the channel goes into a THREAD under that message, so counting new rows
         in the scroll would find nothing whether one agent answered or both —
         this check would have passed for the wrong reason, which is worse than
         failing. The one shared helper opens the thread under the question (and
         fails honestly if no answer ever lands there); the counting below then
         reads THAT panel. The "is working on it" bubbles are still drawn in the
         room against the message that asked, so the quiet window is unchanged. */
      const askRoot = await page.locator('.msgs .msg:has-text("say the word ok")').last()
        .getAttribute("data-msg");
      await waitForAgentAnswer(page, {
        under: askRoot, close: false, timeout: 240000,
        what: `one of ${first.name} / ${second.name} to answer in the thread under the question`,
      });

      /* WAITING ON WHAT CAN BE SEEN, not on a guessed number of seconds: an
         answer from one of the two, then a short quiet window in which nobody
         else is mid-turn. Both agents are queued in the same pass of the
         engine's own loop, so a second agent that was going to answer is
         already showing "is working on it" by the time the first one speaks —
         the window is there to catch it, not to hope past it. */
      const spokeAt = new Map();
      const everWorking = new Set();
      let lastSaid = "";
      await until("one of the two named agents to answer and the room to go quiet", async () => {
        const state = await page.evaluate(root => {
          const said = [];
          for (const row of document.querySelectorAll(".threadpanel .msg.from-agent[data-msg]")) {
            if (row.getAttribute("data-msg") === root) continue; // the question itself
            const who = row.querySelector(".who b")?.textContent?.trim();
            if (who) said.push({ who, words: row.innerText.replace(/\s+/g, " ").trim() });
          }
          const working = [...document.querySelectorAll(".msgs .msg .thinking")]
            .map(el => el.textContent.replace(/is working on it.*/, "").trim())
            .filter(Boolean);
          return { said, working };
        }, askRoot);
        for (const one of state.said) {
          if (!spokeAt.has(one.who)) spokeAt.set(one.who, Date.now());
          if (one.who === first.name || one.who === second.name) lastSaid = one.words;
        }
        for (const name of state.working) everWorking.add(name);
        const answered = [...spokeAt.keys()].filter(n => n === first.name || n === second.name);
        if (answered.length > 1) return true;               // the old bug, caught
        if (answered.length === 1 && state.working.length === 0) {
          return Date.now() - spokeAt.get(answered[0]) > 8000;
        }
        return false;
      }, { timeout: 240000, every: 250 });

      const answered = [...spokeAt.keys()].filter(n => n === first.name || n === second.name);
      const alsoStarted = [...everWorking].filter(n => n !== answered[0]
        && (n === first.name || n === second.name));
      if (answered.length !== 1 || answered[0] !== first.name || alsoStarted.length !== 0) {
        throw new Error(`NOT ON SCREEN — naming ${first.name} first and ${second.name} second ` +
          `produced ${answered.length} answer(s) (${answered.join(", ") || "none"})` +
          (alsoStarted.length ? `, and ${alsoStarted.join(", ")} started a turn as well` : ""));
      }
      await shot(page, "one-answer-per-question");
      const close = page.locator(".threadpanel .threadclose");
      if (await close.count()) await close.click();
      /* The words are reported, not judged: on a machine whose Claude is not
         signed in the one answer is an honest refusal, and that is still one
         owner for the turn. Claiming otherwise would be inventing a reply. */
      return `${first.name} answered in the thread under the question ` +
        `("${lastSaid.slice(0, 60)}"), ${second.name} stayed quiet`;
    });

    /* ---- where an agent's answer lands: the thread, or the room ---------- */
    await check(EXPECTED_CHECKS[34], async () => {
      /* Nobody mid-turn from the check above, or an answer already on its way
         to the ROOM could still be arriving while this one is being judged. */
      await until("the room to be quiet before the thread question is asked", async () =>
        (await page.locator(".msgs .msg .thinking").count()) === 0, { timeout: 240000 });

      await page.fill(".composer textarea", "drivecheck-thread-root: where are we on the shortlist?");
      await page.press(".composer textarea", "Enter");
      const root = page.locator('.msgs .msg:has-text("drivecheck-thread-root")').last();
      await root.waitFor({ timeout: 30000 });
      const rootId = await root.getAttribute("data-msg");
      await root.hover();
      const replyBtn = root.locator(".ma.reply");
      if (await replyBtn.count() === 0) {
        throw new Error("NOT ON SCREEN — no Reply control on the message, so no thread to ask inside");
      }
      await replyBtn.click();
      if (await page.locator(".threadpanel").count() === 0) {
        await page.waitForSelector(".threadpanel", { timeout: 20000 }).catch(() => {
          throw new Error("NOT ON SCREEN — Reply opened no thread panel, so the question " +
            "cannot be asked inside a thread at all");
        });
      }
      await page.waitForSelector(".threadcomposer textarea", { timeout: 20000 });

      /* THE REAL TURN. Typed into the real thread box of the installed app and
         routed by the real engine on this computer — nothing about the answer
         is written here. If this machine's Claude is not signed in, the agent
         still says so in its own voice, and that refusal is still an answer
         that must land in the thread rather than in the room. */
      await page.fill(".threadcomposer textarea",
        `@${first.name} in one short line, which villa has the best kitchen?`);
      await page.press(".threadcomposer textarea", "Enter");
      await until(`${first.name} to answer inside the thread it was asked in`, async () =>
        (await page.locator(".threadpanel .msg.from-agent").count()) >= 1,
      { timeout: 240000, every: 250 });

      /* BY ID, NEVER BY WORDS: the answer's own `data-msg` is looked for in the
         conversation behind the panel. Free chatter in this room really does
         put other agent lines in the scroll, and a check that matched on text
         would blame the feature for one of those. */
      const answerIds = await page.evaluate(() =>
        [...document.querySelectorAll(".threadpanel .msg[data-msg]")]
          .filter(m => m.classList.contains("from-agent")).map(m => m.dataset.msg));
      const alsoInRoom = await page.evaluate(ids =>
        ids.filter(i => !!document.querySelector(`.msgs .msg[data-msg="${i}"]`)), answerIds);
      const replies = await page.locator(`.msgs .msg[data-msg="${rootId}"] .threadline`)
        .getAttribute("data-replies").catch(() => null);
      if (answerIds.length === 0 || alsoInRoom.length !== 0) {
        throw new Error(`NOT ON SCREEN — ${answerIds.length} answer(s) in the thread and ` +
          `${alsoInRoom.length} of them also posted into the conversation`);
      }
      await shot(page, "thread-agent-answer");
      const close = page.locator(".threadpanel .threadclose");
      if (await close.count()) await close.click();
      return `${first.name} answered inside the thread (${answerIds.length} agent line(s), ` +
        `the root now says ${replies ?? "?"} replies) and nothing of it went to the room`;
    });

    /* ---- the two jobs, and the states the engine cannot yet reach ---- */

    /** Hand the hub a real job, wait for the engine to let go, then the state. */
    const seedJob = async ({ agent, title, status, error }) => {
      const from = coordEngine.frames.length;
      const askedId = coordEngine.ask({
        type: "createTask", agentId: agent.id, channelId: room.id, title,
      });
      let job = null;
      await until(`the installed hub to mint the job "${title}"`, () => {
        const recent = coordEngine.frames.slice(from);
        const refused = recent.find(f => f.type === "error" && f.requestId === askedId);
        if (refused) throw new Error(refused.error);
        job = recent.find(f => f.type === "task" && f.task?.title === title
          && f.task.agentId === agent.id)?.task ?? job;
        return !!job;
      }, { timeout: 30000, every: 100 });
      /* Only once the engine has finished with it. A job still queued or
         working is one the engine is about to write its own result over. */
      await until(`the engine to finish with "${title}"`, () => {
        const latest = coordEngine.frames.filter(f => f.type === "task" && f.task?.id === job.id).pop();
        if (latest) job = latest.task;
        return job.status !== "not_started" && job.status !== "working";
      }, { timeout: 240000, every: 250 });
      const wroteFrom = coordEngine.frames.length;
      const wroteId = coordEngine.ask({
        type: "updateTask", taskId: job.id, status,
        // "" is the hub's own "clear it": a job with nothing to say keeps nothing
        error: error ?? "", summary: "", result: "",
      });
      await until(`the screen to hold "${title}" as ${status}`, async () => {
        const refused = coordEngine.frames.slice(wroteFrom)
          .find(f => f.type === "error" && f.requestId === wroteId);
        if (refused) throw new Error(refused.error);
        return await page.evaluate(([id, want]) =>
          window.cloud9Runs.jobs().find(j => j.id === id)?.status === want, [job.id, status]);
      }, { timeout: 30000 });
      return job.id;
    };

    const STUCK_WHY = "waiting on the Architect to answer the question about the budget";
    const stuckJob = await seedJob({
      agent: first, title: "shortlist the villas the Architect picked",
      status: "blocked", error: STUCK_WHY,
    });
    const silentJob = await seedJob({
      agent: second, title: "email the shortlist to Priya",
      status: "failed",   // nothing recorded: no error, no summary
    });

    await clickRail(page, "tasks");
    await page.waitForSelector(`.taskrow[data-task="${stuckJob}"]`, { timeout: 30000 });
    await page.waitForSelector(`.taskrow[data-task="${silentJob}"]`, { timeout: 30000 });
    await shot(page, "jobs-in-trouble");

    await check(EXPECTED_CHECKS[29], async () => {
      const stuckCard = (await page.locator(`.taskrow[data-task="${stuckJob}"]`).innerText())
        .replace(/\s+/g, " ").trim();
      const silentCard = (await page.locator(`.taskrow[data-task="${silentJob}"]`).innerText())
        .replace(/\s+/g, " ").trim();
      const troubleLines = await page
        .locator(`.taskrow[data-task="${stuckJob}"] .trouble[data-trouble="blocked"]`).count();
      if (!stuckCard.includes(STUCK_WHY) || troubleLines !== 1
        // words, and only words — never a path and never an argv
        || /[A-Za-z]:\\|--[a-z]/.test(stuckCard)) {
        throw new Error(`NOT ON SCREEN — the stuck job does not say why in plain words: "${stuckCard.slice(0, 160)}"`);
      }
      if (!/Failed/.test(silentCard) || !/no reason was recorded/.test(silentCard)
        || silentCard.includes(STUCK_WHY)) {
        throw new Error(`a job with nothing recorded did not say so — it says: "${silentCard.slice(0, 160)}"`);
      }
      return `"${STUCK_WHY.slice(0, 40)}…" on the stuck card; the other says no reason was recorded`;
    });

    await check(EXPECTED_CHECKS[30], async () => {
      const place = await page.evaluate(id => {
        const main = document.querySelector(".tasks-main");
        const kids = [...main.children];
        const card = main.querySelector(`.taskrow[data-task="${id}"]`);
        const stuckHead = kids.findIndex(k => k.classList.contains("stucklabel"));
        const runHead = kids.findIndex(k =>
          k.classList.contains("eyebrow") && /^Running ·/.test(k.textContent.trim()));
        return {
          words: card ? card.innerText.replace(/\s+/g, " ").trim() : "",
          status: card ? card.getAttribute("data-status") : "",
          at: kids.indexOf(card), stuckHead, runHead,
        };
      }, stuckJob);
      if (place.status !== "blocked" || !/Stuck — waiting on something/.test(place.words)
        || /\bworking\b/i.test(place.words)
        || place.stuckHead < 0 || place.at < place.stuckHead
        || (place.runHead >= 0 && place.at > place.runHead)) {
        throw new Error(`NOT ON SCREEN — the stuck job is not read apart from the running ones: ` +
          `${JSON.stringify(place).slice(0, 220)}`);
      }
      return `under its own "Stuck" heading at row ${place.at}, above the running group`;
    });

    await check(EXPECTED_CHECKS[31], async () => {
      await page.click('.rail .rail-btn[data-go="chat"]');
      await page.waitForSelector(`.agentrow[data-agent="${first.name}"]`, { timeout: 20000 });
      const row = await page.evaluate(name => {
        const el = document.querySelector(`.agentrow[data-agent="${name}"]`);
        return { trouble: el.getAttribute("data-trouble") ?? "",
          words: el.innerText.replace(/\s+/g, " ").trim() };
      }, first.name);
      /* The rail owns the concise state; the task card owns the full reason.
         Repeating the reason here is exactly the clutter the frontend pass
         removed. */
      if (row.trouble !== "blocked" || !/Stuck — waiting on something/.test(row.words)
        || row.words.includes(STUCK_WHY) || /\bReady\b/.test(row.words)) {
        throw new Error(`NOT ON SCREEN — ${first.name}'s presence line reads ` +
          `${JSON.stringify(row).slice(0, 200)} while its job is stuck`);
      }
      await shot(page, "presence-in-trouble");
      return `${first.name} reads "${row.words.slice(0, 70)}"`;
    });
  } catch (err) {
    failGroup(COORD_GROUP.filter(n => !results.some(r => r.name === n)),
      `the turn-coordination walk could not finish (${err.message})`);
    await shot(page, "coordination-broken");
  } finally {
    try { await coordEngine?.close(); }
    catch (err) {
      throw new Error(`required coordination cleanup failed (${err?.message ?? String(err)})`);
    }
  }

  /* --- 9. feature 5: the connections file, and turning one room down -------
   *
   * Both halves are SCREEN, and both are the kind of thing a preview can pass
   * while the installed app shows nothing. Nothing here is saved and nothing is
   * switched on for real: the connections switch is moved in the editor's draft
   * only and the editor is left without saving, and the mute control is READ
   * rather than pressed — so this walk is safe against his real Cloud9 too.
   *
   * WHAT THIS CHECK DOES NOT PROVE, said plainly: it never opens Windows' own
   * file picker and never raises a real Windows notification. A native dialog is
   * not something this harness can drive honestly, so "a file that is really
   * there" and "a file that has really gone" are not claimed here — only that
   * the block is present and claiming exactly one of its four honest states.
   */
  try {
    await page.click('.rail .rail-btn[data-go="chat"]');
    await page.waitForSelector(".composer textarea", { timeout: 30000 });

    await check(EXPECTED_CHECKS[33], async () => {
      // --- the room's own mute control, in the details panel ---
      if (await page.locator(".roommute").count() === 0) {
        const opener = page.locator(".chathead .roomdetailsbtn:visible").first();
        if (await opener.count() === 0) {
          throw new Error("NOT ON SCREEN — no way into the room details panel, so no mute control");
        }
        await opener.click();
      }
      await page.waitForSelector(".roommute", { timeout: 20000 })
        .catch(() => { throw new Error("NOT ON SCREEN — the room details panel offers no mute control"); });
      const muteWords = (await page.locator(".roommute").innerText()).replace(/\s+/g, " ").trim();
      const muteState = await page.getAttribute(".roommute", "data-muted");
      const muteBtn = (await page.locator(".roommute .roommute-btn").innerText()).trim();
      if (!/^(yes|no)$/.test(muteState ?? "")
        || !/(Mute|Unmute) this (room|conversation)/.test(muteBtn)
        || !/interrupt you/.test(muteWords)) {
        throw new Error("the mute control is on screen but does not say what it does: " +
          `state=${muteState} button="${muteBtn}" words="${muteWords.slice(0, 120)}"`);
      }
      await shot(page, "room-mute-installed");

      // --- the connections file block, in the agent editor ---
      await clickRail(page, "crew");
      await page.waitForSelector(".crew-bar", { timeout: 30000 });
      await page.click('.cast[data-crew] button:has-text("Edit")');
      await page.waitForSelector(".editor .reachladder", { timeout: 30000 });
      if ((await page.getAttribute(".editor .abilitypick", "data-open")) !== "yes") {
        await page.click(".editor .abilityshow");
      }
      await page.waitForSelector('.editor .abilitypick[data-open="yes"]', { timeout: 15000 });
      const connSwitch = page.locator('.editor .toggle-row[data-ability="connections"] input');
      if (await connSwitch.count() === 0) {
        throw new Error("NOT ON SCREEN — the editor has no 'use connected services' switch at all");
      }
      if (!(await connSwitch.isChecked())) await connSwitch.check();
      await page.waitForSelector(".editor .connfile", { timeout: 20000 })
        .catch(() => { throw new Error("NOT ON SCREEN — connected services is switched ON and " +
          "nothing on the editor says which file the agent uses, or that it has none"); });
      const connState = await page.getAttribute(".editor .connfile", "data-conn-state");
      const connWords = (await page.locator(".editor .connfile").innerText()).replace(/\s+/g, " ").trim();
      const HONEST = {
        none: /no connections file chosen yet/i,
        gone: /that file is gone/i,
        ready: /in use/i,
        unchecked: /cannot check that file/i,
      };
      if (!HONEST[connState] || !HONEST[connState].test(connWords)) {
        throw new Error(`the connections block claims state "${connState}" and says ` +
          `"${connWords.slice(0, 120)}" — those are not the same answer`);
      }
      if (await page.locator(".editor .connfile [data-conn-choose]").count() === 0) {
        throw new Error("the connections block offers no way to choose a file");
      }
      await shot(page, "connections-installed");
      // leave without saving — his agent is not changed by being looked at
      const leave = page.locator('.editor >> text=← Crew');
      if (await leave.count()) await leave.first().click();
      return `room mute reads "${muteBtn}" (muted=${muteState}); connections block is honestly ` +
        `"${connState}" — the file picker and a real Windows notification are NOT driven here`;
    });
  } catch (err) {
    failGroup([EXPECTED_CHECKS[33]].filter(n => !results.some(r => r.name === n)),
      `the feature 5 screens could not be reached (${err.message})`);
    await shot(page, "feature5-broken");
  }

  /* --- 10. "cloud9 cannot access my pc" — the whole journey, end to end -----
   *
   * See the note on EXPECTED_CHECKS[38]. This is the one check that would have
   * caught 2026-08-05, and none of the thirty-eight before it could: every one
   * of them was about a screen or a switch, and the thing that failed him was
   * the JOURNEY — switch, folder, chat message, file. It is deliberately the
   * slowest check in the walk, because it is the only one that ends with real
   * bytes out of a real file on this disk appearing in a real agent's answer.
   */
  let reachEngine = null;
  const reachDir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-reach-"));
  try {
    if (!OPTS.fresh) {
      throw new Error("NOT CHECKED — giving an agent a folder on this computer and asking it to " +
        "read a file would change your real Cloud9; run without --real-data for this walk");
    }

    /* A file only this run could know about. A model that guessed would have to
       guess sixteen hex characters, so "it really read the file" is not an
       inference from plausible-looking words. */
    const marker = `cloud9-reach-${createHash("sha256").update(String(Date.now()) + reachDir)
      .digest("hex").slice(0, 16)}`;
    const reachFile = path.join(reachDir, "the-secret-note.txt");
    fs.writeFileSync(reachFile,
      `This file is on Vikas's computer, outside any agent's own folder.\n` +
      `The passphrase is ${marker}\n`, "utf8");

    /* THE SECTION BEFORE THIS ONE TICKS A SWITCH IN THE EDITOR AND WALKS OUT
       WITHOUT SAVING, which is exactly what the unsaved-work owner exists to
       stop — so the app is quite correctly holding a "you haven't saved what
       you wrote" panel over everything. That is the app working, not a fault,
       and the honest thing to do here is ANSWER it the way a person would:
       throw the unsaved edit away. Clicking through it blindly would leave a
       switch saved on his agent that nobody asked for. */
    const leaveAsk = page.locator(".overlay.leaveask .discardwork");
    if (await leaveAsk.count()) await leaveAsk.first().click();
    await page.waitForSelector(".overlay.leaveask", { state: "detached", timeout: 15000 })
      .catch(() => { throw new Error("the unsaved-work panel from the section before would not close"); });

    await page.click('.rail .rail-btn[data-go="chat"]');
    await page.waitForSelector(".composer textarea", { timeout: 30000 });
    await ensureChatFilesSidebar(page);

    reachEngine = await connectInstalledEngine(page);
    /* The WHOLE stored agent, from the hub's own opening picture of the world.
       An edit has to send a complete agent (the hub judges the record, not the
       frame), and the screen's QA hook reports names and ids only. */
    const welcome = reachEngine.frames.find(f => f.type === "welcome");
    const world = await page.evaluate(() => ({
      channels: window.cloud9Wire.channels(),
      me: window.cloud9Wire.me(),
    }));
    const room = world.channels.find(c => c.name === "general") ?? world.channels[0];
    const mine = (welcome?.state?.agents ?? []).filter(a => a.ownerId === world.me);
    const worker = mine.find(a => (a.provider ?? "claude") === "claude") ?? mine[0];
    if (!room || !worker) {
      throw new Error("the fresh app needs a room and one owned agent before this journey exists");
    }

    const openRoom = page.locator(`.sidebar .side-item[data-channel="${room.name}"]`).first();
    if (await openRoom.count()) await openRoom.click();
    await page.waitForSelector(".composer textarea", { timeout: 20000 });
    const membersFrom = reachEngine.frames.length;
    const askedMembers = reachEngine.ask({
      type: "addMembers", channelId: room.id, memberIds: [worker.id],
    });
    await until(`${worker.name} to be a member of ${room.name}`, () => {
      const recent = reachEngine.frames.slice(membersFrom);
      const refused = recent.find(f => f.type === "error" && f.requestId === askedMembers);
      if (refused) throw new Error(refused.error);
      const latest = recent.filter(f => f.type === "channel" && f.channel?.id === room.id).pop();
      return (latest?.channel?.memberIds ?? []).includes(worker.id);
    }, { timeout: 30000, every: 100 });

    await check(EXPECTED_CHECKS[38], async () => {
      /* --- part one: the dead end is gone from the SCREEN ----------------
       *
       * 2026-08-06, AND THE REASON THIS PART WAS REWRITTEN. It used to read the
       * line off whatever agent the walk happened to have made and expect a
       * dead end. That assumption stopped being true the same day it was
       * written: a brand-new agent is now given the home folder as its starting
       * folder (`useHomeFolder` in App.tsx), so the agent had reach, the room
       * had nothing to warn about, and the check reported `null` — a real
       * failure, but not the one it was aiming at.
       *
       * So the state he actually hit is now PUT THERE ON PURPOSE, through the
       * window's own save: allowed outside its own folder, and no folder chosen.
       * That is the exact half-state from his report. Then the room must say so
       * with a door on the same line — and, since the app no longer goes silent
       * about reach in ANY state, the line is read again after the folder is
       * given and must have changed its answer rather than vanished. */
      const rail = `.aside .mini-agent[data-agent="${worker.name}"]`;
      if (await page.locator(rail).count() === 0) {
        const opener = page.locator(".chathead .roomdetailsbtn");
        if (await opener.count()) await opener.first().click();
      }
      await page.waitForSelector(rail, { timeout: 20000 })
        .catch(() => { throw new Error(`NOT ON SCREEN — ${worker.name} is not in the room's details panel`); });

      const readLine = async () => page.evaluate(sel => {
        const el = document.querySelector(`${sel} [data-reach-gap]`);
        return el ? {
          state: el.getAttribute("data-reach-gap"),
          words: el.innerText.replace(/\s+/g, " ").trim(),
          fix: !!el.querySelector("[data-reach-fix]"),
        } : null;
      }, rail);

      // the half-state from his report: allowed out, nowhere to go
      const emptied = await page.evaluate(agent => window.cloud9Wire.ask({
        type: "updateAgent", agent,
      }), {
        ...worker,
        abilities: { ...(worker.abilities ?? {}), files: true, wholeComputer: true },
        wholeComputerRoots: [],
      });
      if (!emptied) throw new Error("the window never sent the save that empties the folder list");
      /* `until` answers true/false and throws on a timeout — it does not hand the
         value back — so the line is kept here and read after, and a timeout is
         allowed to fall through to whatever the room really says, which is the
         sentence this check must print when it fails. */
      let gapBefore = null;
      await until(
        `the room to notice ${worker.name} has nowhere to go`,
        async () => {
          gapBefore = await readLine();
          return !!gapBefore && /no folder has been chosen/i.test(gapBefore.words);
        }, { timeout: 30000, every: 200 }).catch(() => { /* say what it DOES read, below */ });
      if (!gapBefore || !gapBefore.fix
        || !/(own folder|no folder has been chosen)/i.test(gapBefore.words)) {
        throw new Error("NOT ON SCREEN — an agent that cannot reach this computer says nothing " +
          `about it in the room, or offers no way to change it: ${JSON.stringify(gapBefore)}`);
      }
      await shot(page, "reach-dead-end-has-a-door");

      /* --- part two: give it a real folder ------------------------------ */
      const saved = await page.evaluate(agent => window.cloud9Wire.ask({
        type: "updateAgent", agent,
      }), {
        ...worker,
        abilities: {
          ...(worker.abilities ?? {}),
          files: true, wholeComputer: true,
        },
        wholeComputerRoots: [reachDir],
      });
      if (!saved) throw new Error("the window never sent the save");
      let gapAfter = null;
      await until(
        `the room to stop saying ${worker.name} has nowhere to go`,
        async () => {
          gapAfter = await readLine();
          return gapAfter?.state === "chosen";
        }, { timeout: 30000, every: 200 });
      if (!gapAfter?.fix) {
        throw new Error("NOT ON SCREEN — the room says which folders the agent has but offers " +
          `no way to change them: ${JSON.stringify(gapAfter)}`);
      }
      await shot(page, "reach-folder-given");

      /* --- part three: an ORDINARY chat message ------------------------- */
      await until("the room to be quiet before the file is asked for", async () =>
        (await page.locator(".msgs .msg .thinking").count()) === 0, { timeout: 120000 });
      const ask = `@${worker.name} open ${reachFile} on my PC, read it, and tell me the passphrase in it`;
      await page.fill(".composer textarea", ask);
      await page.press(".composer textarea", "Enter");
      await page.waitForSelector('.msgs .msg:has-text("the passphrase in it")', { timeout: 30000 });
      const askRoot = await page.locator('.msgs .msg:has-text("the passphrase in it")').last()
        .getAttribute("data-msg");
      await waitForAgentAnswer(page, {
        under: askRoot, close: false, timeout: 300000,
        what: `${worker.name} to answer the question about the file on this computer`,
      });
      const answer = await page.evaluate(root => {
        const said = [];
        for (const row of document.querySelectorAll(".threadpanel .msg.from-agent[data-msg]")) {
          if (row.getAttribute("data-msg") === root) continue;
          said.push(row.innerText.replace(/\s+/g, " ").trim());
        }
        return said.join(" · ");
      }, askRoot);
      await shot(page, "reach-real-file-read-from-chat");
      if (!answer.includes(marker)) {
        throw new Error("THE THING HE REPORTED — asked in a plain chat message to read a real " +
          `file on this computer, ${worker.name} did not come back with what is in it. It said: ` +
          `"${answer.slice(0, 300)}"`);
      }
      const close = page.locator(".threadpanel .threadclose");
      if (await close.count()) await close.click();
      return `${worker.name} read ${reachFile} from a plain chat message and quoted ${marker}; ` +
        `before the folder was given, the room offered "${gapBefore.words.slice(0, 60)}" with a ` +
        `one-press fix. Windows' own folder picker is NOT driven by this check`;
    });
  } catch (err) {
    failGroup([EXPECTED_CHECKS[38]].filter(n => !results.some(r => r.name === n)),
      `the reach-my-computer journey could not be walked (${err.message})`);
    await shot(page, "reach-my-computer-broken");
  } finally {
    try { await reachEngine?.close(); } catch { /* the walk's own socket */ }
    try { fs.rmSync(reachDir, { recursive: true, force: true }); } catch { /* temp */ }
  }

  /* --- 11. the two things ONLY the installed app can prove (2026-08-06) -----
   *
   * See the note on EXPECTED_CHECKS[39] and [40]. Both need a real harness on
   * this computer: a real model looking at real bytes, and a real child process
   * being killed. Both are slow, and both are worth it — they are the only
   * evidence that either feature does anything outside a test's imagination. */
  try {
    if (!OPTS.fresh) {
      throw new Error("NOT CHECKED — attaching a picture and stopping a turn would leave " +
        "messages in your real Cloud9; run without --real-data for this walk");
    }
    const leaveAsk2 = page.locator(".overlay.leaveask .discardwork");
    if (await leaveAsk2.count()) await leaveAsk2.first().click();

    /* ================================================================
     * CAN THIS COMPUTER RUN A TURN AT ALL — ASKED BEFORE EITHER CHECK
     * ================================================================
     *
     * 2026-08-12, and the reason both of these were misread for a round.
     * The picture check reported "it never said what is actually in the
     * picture" and the stop check reported "no Stop control ever appeared".
     * BOTH SENTENCES WERE TRUE AND BOTH WERE ABOUT THE WRONG THING: the agent
     * had answered "my engine isn't connected", so no model ever saw the
     * bytes and no child process was ever started for a Stop button to kill.
     * Two features were left looking broken by a machine whose engine simply
     * had no harness attached.
     *
     * The two harness checks earlier in this walk did not catch it either: [37]
     * now compares both of the card's facts, but it runs long before this
     * section and against whatever the machine looked like then.
     *
     * So the app's OWN visible card is read here, on the Settings screen a
     * person would look at, and if it says the engine cannot run then that is
     * what these two checks report. It is still a FAILURE — nothing here is
     * skipped or counted green, and `AGENTS.md` is explicit that a cascading
     * unavailable check is not green. What changes is that the failure now
     * names the real cause instead of blaming the picture or the button. */
    await page.click('.rail .rail-btn[data-go="chat"]');
    await page.waitForSelector(".composer textarea", { timeout: 30000 });
    const who = await page.evaluate(() => (window.cloud9Wire.agents() ?? [])[0]?.name ?? "");
    if (!who) throw new Error("the fresh app has no agent to ask");

    /* WHICH ENGINE THIS PARTICULAR AGENT RUNS ON, asked rather than assumed.
       The checks below address `agents()[0]`, whose harness the screen's QA hook
       does not report — so it is read from the hub's own opening picture of the
       world, the same way section 10 reads the stored agent. Reading the Claude
       card while the chosen agent is a Codex one would test a card that has
       nothing to do with the turn, and would go on being quietly right for
       exactly as long as nobody seeds a Codex agent. */
    let whoHarness = "claude";
    const harnessProbe = await connectInstalledEngine(page);
    try {
      const welcome = harnessProbe.frames.find(f => f.type === "welcome");
      const mine = (welcome?.state?.agents ?? []).find(a => a.name === who);
      if (!mine) throw new Error(`the hub does not know an agent called ${who}`);
      whoHarness = mine.provider ?? "claude";
    } finally {
      try { await harnessProbe.close(); } catch { /* the walk's own socket */ }
    }
    if (!HARNESS_CARDS.includes(whoHarness)) {
      throw new Error(`${who} runs on "${whoHarness}", which this walk has no card to read — ` +
        "add it to HARNESS_CARDS rather than letting it be treated as Claude");
    }

    await page.click('.rail .rail-btn[data-go="settings"]');
    await page.waitForSelector(`.harnesscard[data-harness="${whoHarness}"]`, { timeout: 30000 });
    const engineCard = await page.evaluate(harness => {
      const card = document.querySelector(`.harnesscard[data-harness="${harness}"]`);
      if (!card) return null;
      const facts = card.querySelector(".harnessfacts");
      return {
        state: (card.querySelector(".harnessstate")?.innerText ?? "").replace(/\s+/g, " ").trim(),
        facts: (facts?.innerText ?? "").replace(/\s+/g, " ").trim(),
      };
    }, whoHarness);
    if (!engineCard) throw new Error(`the Settings screen has no ${whoHarness} card to read`);
    /* The card's own words, not this harness's opinion: "✓ signed in" is the
       very line the card draws, and a saved key is the app's other way of
       being able to run. Either one means a turn can really start. Anything
       else — including the card's honest "· sign-in not confirmed" — means it
       cannot, and that is exactly the state blocker 3 was in. */
    const engineCanRun = /✓ signed in/.test(engineCard.facts)
      || /✓ key saved on this computer/.test(engineCard.facts);
    await shot(page, "engine-readiness-before-picture-and-stop");
    if (!engineCanRun) {
      throw new Error("NOT PROVED, AND NOT ABOUT EITHER FEATURE — this computer's engine " +
        `cannot run a turn for ${who} right now, so no model can be shown a picture and no ` +
        `real turn exists to stop. Cloud9's own ${whoHarness} card says: "${engineCard.state}" · ` +
        `"${engineCard.facts}". Sign in (or save a key in Settings) and run this walk again; ` +
        "these two checks are unproven either way until then");
    }

    await page.click('.rail .rail-btn[data-go="chat"]');
    await page.waitForSelector(".composer textarea", { timeout: 30000 });

    await check(EXPECTED_CHECKS[39], async () => {
      /* MAGENTA BYTES IN A FILE CALLED ocean-blue. An answer taken from the
         name says blue and is caught; an answer taken from the picture says
         magenta, pink or purple and can only have come from looking. */
      const MAGENTA = pngOfOneColour(240, 160, [255, 0, 255]);
      await page.setInputFiles(".composer input.filepick", {
        name: "ocean-blue.png", mimeType: "image/png", buffer: MAGENTA,
      });
      await page.waitForSelector('.uploadtray .uptile[data-upload="ocean-blue.png"].done',
        { timeout: 60000 });
      const ask = `@${who} open the picture I just attached and tell me, in one word, ` +
        "what colour the whole image is";
      await page.fill(".composer textarea", ask);
      await page.press(".composer textarea", "Enter");
      await page.waitForSelector('.msgs .msg:has-text("what colour the whole image is")',
        { timeout: 30000 });
      const root = await page.locator('.msgs .msg:has-text("what colour the whole image is")')
        .last().getAttribute("data-msg");
      await waitForAgentAnswer(page, {
        under: root, close: false, timeout: 300000,
        what: `${who} to answer what is inside the picture`,
      });
      const said = await page.evaluate(r => [...document.querySelectorAll(
        ".threadpanel .msg.from-agent[data-msg]")]
        .filter(m => m.getAttribute("data-msg") !== r)
        .map(m => m.innerText.replace(/\s+/g, " ").trim()).join(" · "), root);
      await shot(page, "picture-seen-not-guessed");
      const close = page.locator(".threadpanel .threadclose");
      if (await close.count()) await close.click();
      /* THE AGENT REFUSED, AND IT IS NOT A PICTURE PROBLEM. Its engine said so
         itself, in the one sentence `@cloud9/engine` uses for a harness that is
         not attached. Reported as what it is — the alternative reads "it never
         said what is in the picture", which sends the next person hunting
         through image handling for a bug that is not there. Still a failure:
         nothing about seeing a picture was proved. */
      if (/engine isn't connected/i.test(said)) {
        throw new Error("NOT ABOUT THE PICTURE — the agent refused the turn because its engine " +
          `is not connected on this computer, so nothing ever looked at the bytes. ${who} said: ` +
          `"${said.slice(0, 250)}"`);
      }
      if (/blue/i.test(said) && !/magenta|pink|purple|fuchsia/i.test(said)) {
        throw new Error("IT GUESSED FROM THE FILE NAME — the picture is magenta and is called " +
          `ocean-blue.png, and ${who} said: "${said.slice(0, 200)}"`);
      }
      if (!/magenta|pink|purple|fuchsia/i.test(said)) {
        throw new Error(`${who} never said what is actually in the picture. It said: ` +
          `"${said.slice(0, 250)}"`);
      }
      return `${who} was shown a magenta picture named ocean-blue.png and answered from the ` +
        `bytes: "${said.slice(0, 120)}"`;
    });

    await check(EXPECTED_CHECKS[40], async () => {
      /* STOPPING STANDS ON ITS OWN, whatever the picture did.
         The check above can end with a thread panel open over the room and a
         picture still sitting in the message box — and if it does, this check
         types into a composer that is not the one it thinks it is, and sends a
         second copy of the picture with it. That is how a real Stop failure and
         a leftover from the previous check become impossible to tell apart. So
         the room is put back to plain first, using the app's own visible
         controls, and nothing here reads any result of the check before it. */
      const strayThread = page.locator(".threadpanel .threadclose");
      if (await strayThread.count()) {
        await strayThread.first().click().catch(() => { /* already closing */ });
        await page.waitForSelector(".threadpanel", { state: "detached", timeout: 20000 })
          .catch(() => { /* said below if it really matters */ });
      }
      for (const tile of await page.locator(".uploadtray .uptile .upx").all()) {
        await tile.click().catch(() => { /* the tray emptied itself */ });
      }
      await until("the message box to be empty of files before the stop is asked for", async () =>
        (await page.locator(".uploadtray .uptile").count()) === 0, { timeout: 30000 })
        .catch(() => { throw new Error("could not clear the message box before asking for a " +
          "stoppable turn, so a Stop result here would not be about stopping"); });
      await page.fill(".composer textarea", "");

      const ask = `@${who} !bg take your time and write me a long, careful comparison of ` +
        "every villa you can think of";
      await page.fill(".composer textarea", ask);
      await page.press(".composer textarea", "Enter");
      await page.waitForSelector("button.stopnow[data-stop-agent]", { timeout: 120000 })
        .catch(async () => {
          /* WHY THERE IS NO BUTTON, said before blaming the button. A Stop
             control is only ever drawn over a turn that is really running: the
             engine opens the handle it kills AFTER it has a provider, so an
             agent that refused the turn never had anything to stop. Read what
             the agent actually said, so a genuine Stop defect and a refusal are
             never reported as the same thing. Both are failures. */
          const refused = await page.evaluate(() => [...document.querySelectorAll(
            ".msgs .msg.from-agent")].slice(-4)
            .map(m => m.innerText.replace(/\s+/g, " ").trim()).join(" · "));
          if (/engine isn't connected/i.test(refused)) {
            throw new Error("NOT ABOUT STOPPING — the agent refused the turn because its engine " +
              "is not connected on this computer, so no turn was ever running for a Stop control " +
              `to appear over. It said: "${refused.slice(0, 250)}"`);
          }
          throw new Error("NOT ON SCREEN — an agent was set working and no Stop " +
            "control ever appeared, so there is no way for him to pull the plug" +
            (refused ? `. The room last said: "${refused.slice(0, 200)}"` : ""));
        });
      await shot(page, "stop-offered-while-working");
      await page.click("button.stopnow[data-stop-agent]");
      await until("the running turn to really stop", async () =>
        (await page.locator("button.stopnow[data-stop-agent]").count()) === 0,
      { timeout: 120000, every: 250 });
      const record = await until("a run record saying the owner stopped it", async () => {
        const cards = await page.evaluate(() => [...document.querySelectorAll(
          ".callout.run[data-outcome]")].map(c => ({
          outcome: c.dataset.outcome,
          words: c.innerText.replace(/\s+/g, " ").trim(),
        })));
        return cards.find(c => c.outcome === "cancelled") ?? false;
      }, { timeout: 120000, every: 500 });
      await shot(page, "stopped-by-you-record");
      if (/failed|went wrong/i.test(record.words) || !/stopped/i.test(record.words)) {
        throw new Error("the record of a turn the owner stopped does not say so plainly: " +
          `"${record.words.slice(0, 200)}"`);
      }
      return `a real turn was stopped from the app and the record reads "${record.words.slice(0, 120)}"`;
    });
  } catch (err) {
    failGroup([EXPECTED_CHECKS[39], EXPECTED_CHECKS[40]]
      .filter(n => !results.some(r => r.name === n)),
    `the picture-and-stop walk could not be made (${err.message})`);
    await shot(page, "picture-and-stop-broken");
  }
}

/**
 * One real PNG of one colour, made here so the walk owes nothing to a file in
 * the repo. Signature, IHDR, a deflated IDAT and IEND, each with its CRC — the
 * same construction the browser suite uses, kept separate on purpose so this
 * harness can still be run on its own.
 */
function pngOfOneColour(width, height, [r, g, b]) {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  const crc32 = buf => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed), 0);
    return Buffer.concat([len, typed, crc]);
  };
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * stride;
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------- narrow sidecar proof */

async function runSidecarCleanupSimulation() {
  const events = [];
  const tempState = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-member-sim-"));
  let browserConnected = true;
  const resources = {
    page: {
      isClosed: () => false,
      close: async () => { events.push("page"); await new Promise(() => {}); },
    },
    context: { close: async () => { events.push("context"); } },
    browser: {
      isConnected: () => browserConnected,
      close: async () => { events.push("browser"); browserConnected = false; },
    },
    server: {
      listening: true,
      close(callback) { events.push("server"); this.listening = false; callback(); },
      closeIdleConnections() {},
      closeAllConnections() {},
      off() {},
    },
    sockets: new Set(),
    onConnection: null,
    tempState,
    closePromise: null,
    cleanupTimeoutMs: 30,
    closed: { page: false, context: false, browser: false, server: false, tempState: false },
  };
  let failure = null;
  let laterFilesChecksRan = false;
  try {
    await closeMemberSidecarResources(resources);
    laterFilesChecksRan = true;
  } catch (err) {
    failure = err;
  }
  const everyResourceAttempted = events.join(",") === "page,context,browser,server";
  const tempRemoved = !fs.existsSync(tempState);
  if (!failure?.requiredCleanupFailure || !everyResourceAttempted || !tempRemoved || laterFilesChecksRan) {
    throw new Error(`sidecar cleanup simulation failed: events=${events.join(",")}, ` +
      `tempRemoved=${tempRemoved}, laterFilesChecksRan=${laterFilesChecksRan}, failure=${failure?.message ?? "none"}`);
  }

  let retainedServerCloseAttempts = 0;
  const retainedResources = {
    page: null, context: null, browser: null, browserServer: null, browserProcess: null,
    browserRootClosed: null, browserExit: { exitCode: 0, signal: null }, forcedTerminationCount: 0,
    server: {
      listening: true,
      close(callback) {
        retainedServerCloseAttempts += 1;
        if (retainedServerCloseAttempts === 1) callback(new Error("injected first server close failure"));
        else { this.listening = false; callback(); }
      },
      closeIdleConnections() {}, closeAllConnections() {}, off() {},
    },
    sockets: new Set(), onConnection: null, tempState: null, storageState: null,
    closePromise: null,
    closed: { page: true, context: true, browser: true, server: false, tempState: true },
  };
  activeMemberSidecars.add(retainedResources);
  let firstRetainedCleanupFailed = false;
  try { await closeMemberSidecarResources(retainedResources); }
  catch { firstRetainedCleanupFailed = true; }
  await cleanupActiveMemberSidecars();
  const retainedOwnerRetried = firstRetainedCleanupFailed && retainedServerCloseAttempts === 2
    && !activeMemberSidecars.has(retainedResources);
  if (!retainedOwnerRetried) throw new Error("failed setup cleanup owner was discarded instead of retry-cleaned");

  const fakeInstall = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-ancestor-root-"));
  const ancestorTarget = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-ancestor-target-"));
  let ancestorJunctionRefused = false;
  try {
    fs.writeFileSync(path.join(fakeInstall, "Cloud9.exe"), "fixture");
    fs.mkdirSync(path.join(ancestorTarget, "app", "dist-web"), { recursive: true });
    fs.writeFileSync(path.join(ancestorTarget, "app", "dist-web", "index.html"), "outside install");
    fs.symlinkSync(ancestorTarget, path.join(fakeInstall, "resources"), "junction");
    try { resolveInstalledRendererRoot(path.join(fakeInstall, "Cloud9.exe")); }
    catch { ancestorJunctionRefused = true; }
  } finally {
    fs.rmSync(fakeInstall, { recursive: true, force: true });
    fs.rmSync(ancestorTarget, { recursive: true, force: true });
  }
  if (!ancestorJunctionRefused) throw new Error("an installed renderer ancestor junction was accepted");

  const depthRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-depth-bound-"));
  let depthRefused = false;
  try {
    fs.writeFileSync(path.join(depthRoot, "index.html"), "depth fixture");
    let current = depthRoot;
    for (let index = 0; index <= RENDERER_SNAPSHOT_MAX_DEPTH; index += 1) {
      current = path.join(current, `d${index}`);
      fs.mkdirSync(current);
    }
    try { captureRendererSnapshot(depthRoot, "depth simulation"); }
    catch { depthRefused = true; }
  } finally {
    fs.rmSync(depthRoot, { recursive: true, force: true });
  }
  if (!depthRefused) throw new Error("over-depth renderer traversal was accepted");

  const directoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-directory-bound-"));
  let directoryCountRefused = false;
  try {
    fs.writeFileSync(path.join(directoryRoot, "index.html"), "directory fixture");
    for (let index = 0; index < RENDERER_SNAPSHOT_MAX_DIRECTORIES; index += 1) {
      fs.mkdirSync(path.join(directoryRoot, `dir-${String(index).padStart(3, "0")}`));
    }
    try { captureRendererSnapshot(directoryRoot, "directory simulation"); }
    catch { directoryCountRefused = true; }
  } finally {
    fs.rmSync(directoryRoot, { recursive: true, force: true });
  }
  if (!directoryCountRefused) throw new Error("over-directory renderer traversal was accepted");

  const swapRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-open-swap-root-"));
  const swapOutside = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-open-swap-outside-"));
  let openSwapRefused = false;
  const approvedPath = path.join(swapRoot, "index.html");
  const backupPath = path.join(swapRoot, "index.approved");
  const outsidePath = path.join(swapOutside, "outside.html");
  try {
    fs.writeFileSync(approvedPath, "approved-identity");
    fs.writeFileSync(outsidePath, "outside--identity");
    try {
      captureRendererSnapshot(swapRoot, "open-swap simulation", {
        beforeOpen: ({ relative }) => {
          if (relative !== "index.html") return;
          fs.renameSync(approvedPath, backupPath);
          fs.linkSync(outsidePath, approvedPath);
        },
        afterOpen: ({ relative }) => {
          if (relative !== "index.html") return;
          fs.unlinkSync(approvedPath);
          fs.renameSync(backupPath, approvedPath);
        },
      });
    } catch {
      openSwapRefused = true;
    }
  } finally {
    if (!fs.existsSync(approvedPath) && fs.existsSync(backupPath)) fs.renameSync(backupPath, approvedPath);
    fs.rmSync(swapRoot, { recursive: true, force: true });
    fs.rmSync(swapOutside, { recursive: true, force: true });
  }
  if (!openSwapRefused) throw new Error("swap-to-outside during file open was accepted");

  const mutationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-snapshot-mutation-"));
  let snapshotStayedImmutable = false;
  let historyFallbackGuardHeld = false;
  try {
    const original = Buffer.from("approved installed bytes");
    fs.writeFileSync(path.join(mutationRoot, "index.html"), original);
    const snapshot = captureRendererSnapshot(mutationRoot, "mutation simulation");
    const approvedFingerprint = createHash("sha256")
      .update("index.html").update("\0").update(original).update("\0").digest("hex");
    fs.writeFileSync(path.join(mutationRoot, "index.html"), "changed after approval");
    snapshotStayedImmutable = snapshot.read("index.html").bytes.equals(original)
      && snapshot.fingerprint === approvedFingerprint;
    historyFallbackGuardHeld = installedAssetEntry(snapshot, "/room/history", { accept: "text/html" }) === null
      && installedAssetEntry(snapshot, "/room/history", {
        accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document",
      })?.bytes.equals(original) === true;
  } finally {
    fs.rmSync(mutationRoot, { recursive: true, force: true });
  }
  if (!snapshotStayedImmutable) throw new Error("approved snapshot bytes changed after disk mutation");
  if (!historyFallbackGuardHeld) throw new Error("history fallback accepted a non-navigation HTML request");

  const handshakeSockets = new Set();
  const handshakeServer = createServer();
  handshakeServer.on("upgrade", (request, socket) => {
    handshakeSockets.add(socket);
    socket.once("close", () => handshakeSockets.delete(socket));
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write("HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on("data", data => {
      if ((data[0] & 0x0f) === 0x08) {
        socket.write(Buffer.from([0x88, 0x00]));
        socket.end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    handshakeServer.once("error", reject);
    handshakeServer.listen(0, "127.0.0.1", resolve);
  });
  const handshakeAddress = handshakeServer.address();
  let handshakeFailedAndClosed = false;
  try {
    await openInstalledEngineSocket(`ws://127.0.0.1:${handshakeAddress.port}`, "simulation-token", 40);
  } catch {
    await until("the failed engine handshake socket to close locally", () => handshakeSockets.size === 0,
      { timeout: 5000, every: 20 });
    handshakeFailedAndClosed = true;
  } finally {
    for (const socket of handshakeSockets) socket.destroy();
    await new Promise(resolve => handshakeServer.close(() => resolve()));
  }
  if (!handshakeFailedAndClosed) throw new Error("engine handshake failure did not close and verify its socket");

  const ownedChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await until("the forced-kill simulation process to start", () => ownedProcessIsAlive(ownedChild), { timeout: 5000 });
  let forcedKillCalled = false;
  let forcedClientConnected = true;
  const forcedOrder = [];
  const forcedResources = {
    page: null, context: null,
    browser: {
      isConnected: () => forcedClientConnected && ownedProcessIsAlive(ownedChild),
      close: async () => { forcedOrder.push("client"); forcedClientConnected = false; },
    },
    browserServer: {
      close: async () => { forcedOrder.push("server"); await new Promise(() => {}); },
      kill: async () => { forcedOrder.push("kill"); forcedKillCalled = true; ownedChild.kill(); },
    },
    browserProcess: ownedChild,
    forcedTerminationCount: 0,
    browserCloseTimeoutMs: 30,
    forceKillTimeoutMs: 5000,
    closed: { page: true, context: true, browser: false },
  };
  let forcedCleanupFailure = null;
  try { await closeMemberBrowserResources(forcedResources); }
  catch (err) { forcedCleanupFailure = err; }
  /* The contract: the connected client is disconnected BEFORE the server it is
     attached to; a hung server close still gets forced and proved; and a forced
     shutdown that met the same proof bar (kill worked, OS says the process is
     gone) is a PASS carrying an observation — not a failure of the group. */
  const forcedObservations = forcedResources.cleanupObservations ?? [];
  if (forcedCleanupFailure || !forcedKillCalled || forcedOrder.join(",") !== "client,server,kill"
    || forcedResources.forcedTerminationCount !== 1 || ownedProcessIsAlive(ownedChild)
    || forcedResources.closed.browser !== true || forcedObservations.length !== 1
    || !/forced path/.test(forcedObservations[0])) {
    if (ownedProcessIsAlive(ownedChild)) ownedChild.kill();
    throw new Error("browser close did not close inside-out, force and verify owned process termination, " +
      `and record it as an observation: order=${forcedOrder.join(",")}, ` +
      `observations=${JSON.stringify(forcedObservations)}, failure=${forcedCleanupFailure?.message ?? "none"}`);
  }

  /* And a forced path that CANNOT prove the process died must still fail. */
  const unprovableChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await until("the unprovable-kill simulation process to start", () => ownedProcessIsAlive(unprovableChild),
    { timeout: 5000 });
  const unprovableResources = {
    page: null, context: null, browser: null,
    browserServer: {
      close: async () => { await new Promise(() => {}); },
      kill: async () => {},
    },
    browserProcess: unprovableChild,
    forcedTerminationCount: 0,
    browserCloseTimeoutMs: 30,
    forceKillTimeoutMs: 200,
    closed: { page: true, context: true, browser: false },
  };
  let unprovableFailure = null;
  try { await closeMemberBrowserResources(unprovableResources); }
  catch (err) { unprovableFailure = err; }
  const unprovableStillAlive = ownedProcessIsAlive(unprovableChild);
  unprovableChild.kill();
  if (!unprovableFailure?.requiredCleanupFailure || !unprovableStillAlive
    || !/forced termination/.test(unprovableFailure.message)) {
    throw new Error("a forced browser termination that proved nothing was not reported as a failure: " +
      `${unprovableFailure?.message ?? "no failure"}`);
  }

  console.log("drive-app sidecar cleanup simulation");
  console.log("PASS a timed-out page close did not prevent context/browser/server/temp cleanup attempts");
  console.log("PASS cleanup failure stayed fatal and later Files checks did not run");
  console.log("PASS a failed setup cleanup owner stayed registered and retry-cleaned remaining resources");
  console.log("PASS an ancestor resources/app/dist-web junction was refused");
  console.log("PASS iterative traversal refused over-depth and over-directory renderer trees");
  console.log("PASS fd identity binding refused a swap-to-outside during open even after path restoration");
  console.log("PASS post-approval disk mutation could not change immutable served snapshot bytes");
  console.log("PASS history fallback required an actual document navigation contract");
  console.log("PASS failed engine WebSocket handshake closed and verified its locally owned socket");
  console.log("PASS browser close ran client-then-server, forced the owned Chromium process down, " +
    "verified root close/OS exit and recorded the forced path as an observation, not a failure");
  console.log("PASS a forced termination that could not prove the process died still failed the cleanup");
}

async function runSidecarProbe() {
  if (!OPTS.fresh) throw new Error("--sidecar-probe always uses a fresh throwaway workspace; --real-data is refused");
  let browser = null;
  let ownerPage = null;
  let sidecar = null;
  let installedEngine = null;
  let probeArtifact = null;
  let probeRow = null;
  let probeAccess = null;
  let accessNeedsRestore = false;
  let problem = null;
  const cleanupProblems = [];
  const restoreProbeAccess = async () => {
    if (!accessNeedsRestore || !ownerPage || !sidecar || !probeArtifact || !probeRow || !probeAccess) return;
    await until("the probe access editor to stop saving", async () =>
      (await probeAccess.getAttribute("data-access-saving")) !== "yes", { timeout: 30000 }).catch(() => false);
    if (await probeAccess.locator('[data-access-choice="room"]').count()) {
      await probeAccess.locator('[data-access-choice="room"]').click();
      const save = probeAccess.locator("[data-access-save]");
      if (await save.isEnabled()) await save.click();
    }
    await ownerPage.evaluate(id => window.cloud9Artifacts.setAccess(id, { kind: "room" }), probeArtifact.id);
    await until("probe room access to be restored", async () =>
      (await probeRow.getAttribute("data-access")) === "room"
        && (await probeAccess.getAttribute("data-file-access")) === "room"
        && (await probeAccess.getAttribute("data-access-saving")) !== "yes",
    { timeout: 30000 });
    await probeRow.click();
    await ownerPage.waitForSelector(
      `.files-detail[data-file-detail="${probeArtifact.id}"][data-file-detail-state="here"]`, { timeout: 20000 });
    await sidecar.page.waitForSelector(`.file-index-row[data-file-row="${probeArtifact.id}"]`, { timeout: 30000 });
    await sidecar.page.click(`.file-index-row[data-file-row="${probeArtifact.id}"]`);
    await sidecar.page.waitForSelector(
      `.files-detail[data-file-detail="${probeArtifact.id}"][data-file-detail-state="here"] ` +
      `.fileaccess[data-access-editor="read-only"]`, { timeout: 20000 });
    accessNeedsRestore = false;
  };
  try {
    const launched = await launch({ resetScreenshots: false });
    browser = launched.browser;
    ownerPage = launched.page;
    if (!/^file:\/\/\/.+\/resources\/app\/dist-web\/index\.html\?/i.test(ownerPage.url().replaceAll("\\", "/"))) {
      throw new Error("the probe owner is not the real installed Electron file:// window");
    }
    const ownerId = await waitForEstablishedIdentity(ownerPage);
    const relay = new URL(ownerPage.url()).searchParams.get("relay");

    await clickRail(ownerPage, "crew");
    await ownerPage.waitForSelector(".crew-bar", { timeout: 30000 });
    if (await ownerPage.locator(".cast[data-crew]").count() === 0) {
      const write = ownerPage.locator('.crew-bar button, .crew-bar a').filter({ hasText: /write|new agent|make/i }).first();
      if (await write.count()) await write.click();
      else await ownerPage.click('button:has-text("Write an agent")');
      await ownerPage.waitForSelector(".editor .persona-input", { timeout: 30000 });
      await ownerPage.fill(".editor #f-name", "Drivecheck");
      await ownerPage.fill(".editor .persona-input", "Makes one installed Files sidecar proof.");
      await ownerPage.click('.editor .topbar >> text=Create agent');
      await ownerPage.waitForSelector('.cast[data-crew="Drivecheck"]', { timeout: 40000 });
    }
    let known;
    let channel;
    let agent;
    await until("the probe owner, room and agent fixture to settle", async () => {
      known = await ownerPage.evaluate(() => ({
        channels: window.cloud9Wire.channels(), agents: window.cloud9Wire.agents(), me: window.cloud9Wire.me(),
      }));
      channel = known.channels.find(item => item.name === "general") ?? known.channels[0];
      agent = known.agents.find(item => item.ownerId === known.me);
      return !!ownerId && !!channel && !!agent;
    }, { timeout: 30000 });
    installedEngine = await connectInstalledEngine(ownerPage);
    const stamp = Date.now().toString(36);
    const PROBE_BYTES = "# Installed sidecar proof\nExact restricted bytes.\n";
    const run = {
      kind: "chat", id: `r-sidecar-probe-${stamp}`, agentId: agent.id, agentName: agent.name,
      channelId: channel.id, requestedBy: "Vikas", requestedByKind: "human", provider: "claude",
      model: "claude-sonnet-5", ask: "make the sidecar proof", outcome: "ok", steps: [],
      startedAt: Date.now(), finishedAt: Date.now() + 500, durationMs: 500, replyChars: 48, events: 1,
    };
    installedEngine.record(run);
    probeArtifact = await installedEngine.publish({
      channelId: channel.id, agentId: agent.id, agentName: agent.name,
      name: "sidecar-probe.md", data: PROBE_BYTES, expectedVersion: 1, runId: run.id,
    });

    await ownerPage.click('.rail .rail-btn[data-go="chat"]');
    await ensureChatFilesSidebar(ownerPage);
    await ownerPage.waitForSelector('button[title="Invite a friend"]', { timeout: 20000 });
    await ownerPage.click('button[title="Invite a friend"]');
    await ownerPage.waitForFunction(() => document.querySelector(".code")?.textContent?.startsWith("inv_"),
      undefined, { timeout: 20000 });
    const invite = (await ownerPage.locator(".code").innerText()).trim();
    if (!/^inv_[A-Za-z0-9_-]+$/.test(invite)) throw new Error("the installed owner did not mint a valid invite");
    await ownerPage.click('.overlay .foot button:has-text("Done")');

    sidecar = await launchInstalledMemberSidecar(installedRendererApproval, relay);
    const indexResponse = await fetch(`${sidecar.origin}/`);
    const indexText = await indexResponse.text();
    const scriptPath = indexText.match(/<script[^>]+src="([^"]+\.js)"/i)?.[1];
    const scriptResponse = scriptPath ? await fetch(new URL(scriptPath, `${sidecar.origin}/`)) : null;
    const traversal = await fetch(`${sidecar.origin}/..%5celectron%5cpreload.cjs`);
    const missingAsset = await fetch(`${sidecar.origin}/assets/not-installed.js`, {
      headers: { Accept: "text/html" },
    });
    const wrongMethod = await fetch(`${sidecar.origin}/`, { method: "POST" });
    if (!indexResponse.ok || !/^text\/html\b/i.test(indexResponse.headers.get("content-type") ?? "")
      || !scriptResponse?.ok
      || !/^application\/javascript\b/i.test(scriptResponse.headers.get("content-type") ?? "")
      || ![403, 404].includes(traversal.status) || missingAsset.status !== 404 || wrongMethod.status !== 405) {
      throw new Error("the loopback installed-asset server failed its path, MIME, fallback or method guard");
    }
    await assertPlainMemberStart(sidecar, relay);
    await sidecar.page.click("text=I have an invite");
    await sidecar.page.fill('.panel input[placeholder="inv_…"]', invite);
    await sidecar.page.fill('.panel input[placeholder="Priya"]', "Installed sidecar probe");
    await sidecar.page.click("text=Enter Cloud9");
    await waitForEstablishedIdentity(sidecar.page);
    if (!ownerId) throw new Error("the installed owner has no real owner identity");
    const memberId = await assertRedeemedMemberIdentity(sidecar.page, ownerId);
    await sidecar.reconnect(memberId, ownerId);

    await clickRail(ownerPage, "files");
    await ownerPage.waitForSelector(`.file-index-row[data-file-row="${probeArtifact.id}"]`, { timeout: 30000 });
    probeRow = ownerPage.locator(`.file-index-row[data-file-row="${probeArtifact.id}"]`);
    await probeRow.click();
    await ownerPage.waitForSelector(
      `.files-detail[data-file-detail="${probeArtifact.id}"][data-file-detail-state="here"]`, { timeout: 20000 });
    probeAccess = ownerPage.locator(`.files-detail[data-file-detail="${probeArtifact.id}"] .fileaccess`);
    await ownerPage.waitForSelector(
      `.files-detail[data-file-detail="${probeArtifact.id}"] .fileaccess[data-access-editor="yes"]`, { timeout: 20000 });

    await clickRail(sidecar.page, "files");
    await sidecar.page.waitForSelector(`.file-index-row[data-file-row="${probeArtifact.id}"]`, { timeout: 30000 });
    await sidecar.page.click(`.file-index-row[data-file-row="${probeArtifact.id}"]`);
    await sidecar.page.waitForSelector(
      `.files-detail[data-file-detail="${probeArtifact.id}"] .fileaccess[data-access-editor="read-only"]`,
      { timeout: 20000 });
    const memberAccess = sidecar.page.locator(
      `.files-detail[data-file-detail="${probeArtifact.id}"] .fileaccess`);
    const memberControls = await memberAccess
      .locator('button, input, select, textarea, [role="button"], [contenteditable="true"]')
      .count();
    if (memberControls !== 0 || !/Only this room.+owner or an admin can change that/i.test(await memberAccess.innerText())) {
      throw new Error(`the real plain member did not have the required read-only Files view; controls=${memberControls}`);
    }

    const memberCard = sidecar.page.locator(`.files-detail .artcard[data-artifact="${probeArtifact.id}"]`);
    await memberCard.locator(".artopen").click();
    await sidecar.page.waitForSelector(
      `.files-detail .artcard[data-artifact="${probeArtifact.id}"] .artpeek pre`, { timeout: 15000 });
    const memberBytesBefore = await memberCard.locator(".artpeek pre").innerText();
    if (memberBytesBefore !== PROBE_BYTES) throw new Error("the member did not open the exact installed probe bytes");

    accessNeedsRestore = true;
    await probeAccess.locator('[data-access-choice="restricted"]').click();
    const manager = probeAccess.locator('.accessperson[data-required="yes"] input:disabled').first();
    const excludedMember = probeAccess.locator(
      `.accessperson[data-access-user="${memberId}"][data-required="no"] input`);
    if (await manager.count() === 0 || await excludedMember.count() !== 1 || await excludedMember.isChecked()) {
      throw new Error("the restriction editor did not require a manager and exclude the real member");
    }
    await probeAccess.locator("[data-access-save]").click();
    await ownerPage.waitForSelector(
      `.file-index-row[data-file-row="${probeArtifact.id}"][data-access="restricted"]`, { timeout: 20000 });
    const managerBytes = await assertArtifactBytes(ownerPage, probeArtifact.id, 1, PROBE_BYTES,
      "the sidecar probe manager's fresh restricted read");
    await sidecar.page.waitForSelector(".files-detail [data-file-unavailable]", { timeout: 20000 });
    await until("the probe file to leave the member index", () =>
      sidecar.page.locator(`.file-index-row[data-file-row="${probeArtifact.id}"]`).count().then(count => count === 0),
    { timeout: 20000 });
    const memberDetailAfter = await sidecar.page.evaluate(id => window.cloud9Artifacts.detail(id), probeArtifact.id);
    if (memberDetailAfter !== null
      || await sidecar.page.locator(`.artcard[data-artifact="${probeArtifact.id}"]`).count() !== 0
      || await sidecar.page.locator(".files-detail .artpeek pre").count() !== 0) {
      throw new Error("restriction did not revoke the member's already-open detail and bytes");
    }
    await restoreProbeAccess();

    console.log("drive-app installed sidecar probe");
    console.log(`PASS installed renderer approved and served from ${sidecar.rendererRoot}`);
    console.log(`PASS loopback server bound at ${sidecar.origin}`);
    console.log("PASS installed asset MIME, traversal, missing-asset and method guards held");
    console.log("PASS member started with no owner token and no Electron preload bridge");
    console.log("PASS visible one-use invite produced a distinct durable member on the installed relay");
    console.log("PASS closing and relaunching the sidecar browser/context reconnected as the same member, not the owner");
    console.log("PASS installed owner had access controls while the plain member had read-only wording and zero controls");
    console.log(`PASS restriction revoked already-open member detail/bytes; owner freshly read ${managerBytes} exact bytes`);
    console.log("PASS room access was restored and the same joined member could read the file again");
  } catch (err) {
    problem = err;
  } finally {
    try { await restoreProbeAccess(); }
    catch (err) { cleanupProblems.push(`access restoration: ${err?.message ?? String(err)}`); }
    try {
      if (sidecar) {
        await sidecar.close();
        const state = sidecar.cleanupState();
        if (!Object.values(state).every(Boolean)) {
          throw new Error(`incomplete sidecar cleanup: ${JSON.stringify(state)}`);
        }
        const observations = sidecar.cleanupObservations();
        console.log("PASS cleanup closed member page/context/browser, stopped loopback server, and removed temp state" +
          (observations.length ? ` (noted: ${observations.join("; ")})` : ""));
      }
    } catch (err) {
      cleanupProblems.push(`member sidecar: ${err?.message ?? String(err)}`);
    }
    try {
      if (installedEngine) {
        await installedEngine.close();
        console.log("PASS installed engine WebSocket close event was awaited and verified");
      }
    } catch (err) { cleanupProblems.push(`installed engine: ${err?.message ?? String(err)}`); }
    try { await teardown(browser); }
    catch (err) { cleanupProblems.push(`installed app: ${err?.message ?? String(err)}`); }
  }
  if (cleanupProblems.length) {
    throw new Error(`required sidecar probe cleanup failed (${cleanupProblems.join("; ")})` +
      (problem ? `; original probe failure: ${problem?.message ?? String(problem)}` : ""));
  }
  if (problem) throw problem;
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
  if (OPTS.sidecarCleanupSimulation) {
    await runSidecarCleanupSimulation();
    code = 0;
  } else if (OPTS.sidecarProbe) {
    await runSidecarProbe();
    code = 0;
  } else {
    const launched = await launch();
    browser = launched.browser;
    await walk(launched.page);
    code = summarise();
  }
} catch (err) {
  console.error(`\nThe harness could not do its job: ${err.message}`);
  if (!OPTS.sidecarProbe && !OPTS.sidecarCleanupSimulation) summarise();
  code = 1;
} finally {
  if (!OPTS.sidecarProbe && !OPTS.sidecarCleanupSimulation) await teardown(browser);
}
process.exit(code);
