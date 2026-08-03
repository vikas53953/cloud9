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
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artifactRef } from "@cloud9/shared";

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
  const connection = await page.evaluate(() => ({
    relay: new URL(window.location.href).searchParams.get("relay"),
    token: window.localStorage.getItem("cloud9.token"),
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
  return { record, publish, close: owned.close };
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
        if (resources.browserServer) await resources.browserServer.close();
        else if (resources.browser?.isConnected()) await resources.browser.close();
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
        problems.push(`member browser graceful close: ${gracefulProblem?.message ?? "process remained alive"}; ` +
          "forced termination succeeded and root close/OS exit were verified");
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
        await resources.page.waitForSelector(".rail", { timeout: 30000 });
        const reconnectedId = await assertRedeemedMemberIdentity(resources.page, ownerId);
        if (reconnectedId !== expectedMemberId) {
          throw new Error("the relaunched sidecar did not reconnect as the same invited member");
        }
        return reconnectedId;
      },
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

async function assertRedeemedMemberIdentity(memberPage, ownerId) {
  const identity = await memberPage.evaluate(() => ({
    id: window.cloud9Wire.me(),
    durableTokenPresent: (window.localStorage.getItem("cloud9.token")?.length ?? 0) > 0,
  }));
  if (!identity.id || identity.id === ownerId || !identity.durableTokenPresent) {
    throw new Error("the visible invite did not create a distinct member with its own durable session");
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
        await page.click('.rail .rail-btn[data-go="crew"]');
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
      await usable.click();
      const filled = (await page.inputValue(".composer textarea")).trim();
      if (!filled.includes("!")) {
        throw new Error(`choosing an action left the message box without a command: "${filled}"`);
      }
      await page.fill(".composer textarea", "");
      /* Escape must close the menu if it reopened — same one-owner rule as every
         other overlay; a leftover popover breaks every later step. */
      await page.keyboard.press("Escape").catch(() => {});
      return `${rows.length} actions offered (${rows.filter(r => r.blocked).length} honestly blocked); ` +
        `choosing one filled in: "${filled.slice(0, 60)}"`;
    });
  } catch (err) {
    failGroup([EXPECTED_CHECKS[9], EXPECTED_CHECKS[17]].filter(n => !results.some(r => r.name === n)),
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
  } catch (err) {
    failGroup([EXPECTED_CHECKS[18]].filter(n => !results.some(r => r.name === n)),
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
    const filesDoor = page.locator('.rail .rail-btn[data-go="files"]');
    await filesDoor.click();
    await page.waitForSelector("[data-files-screen]", { timeout: 30000 });
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
      if ((await filesDoor.count()) !== 1 || !await filesDoor.isVisible() || !await filesDoor.isEnabled()
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
    await memberPage.waitForSelector(".rail", { timeout: 30000 });
    const memberId = await assertRedeemedMemberIdentity(memberPage, known.me);
    await memberSidecar.reconnect(memberId, known.me);
    memberPage = memberSidecar.page;

    await page.click('.rail .rail-btn[data-go="files"]');
    await page.waitForSelector(`.file-index-row[data-file-row="${v1.id}"]`, { timeout: 20000 });
    await row.click();
    await page.waitForSelector(`.files-detail[data-file-detail="${v1.id}"][data-file-detail-state="here"]`,
      { timeout: 20000 });
    await memberPage.click('.rail .rail-btn[data-go="files"]');
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
  const forcedResources = {
    page: null, context: null,
    browser: { isConnected: () => ownedProcessIsAlive(ownedChild) },
    browserServer: {
      close: async () => { await new Promise(() => {}); },
      kill: async () => { forcedKillCalled = true; ownedChild.kill(); },
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
  if (!forcedCleanupFailure?.requiredCleanupFailure || !forcedKillCalled
    || forcedResources.forcedTerminationCount !== 1 || ownedProcessIsAlive(ownedChild)) {
    if (ownedProcessIsAlive(ownedChild)) ownedChild.kill();
    throw new Error("browser close timeout did not force and verify owned process termination");
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
  console.log("PASS browser close timeout forced the owned Chromium process down and verified root close/OS exit");
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
    await ownerPage.waitForSelector(".rail", { timeout: 30000 });
    const ownerId = await ownerPage.evaluate(() => window.cloud9Wire.me());
    const relay = new URL(ownerPage.url()).searchParams.get("relay");

    await ownerPage.click('.rail .rail-btn[data-go="crew"]');
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
    await sidecar.page.waitForSelector(".rail", { timeout: 30000 });
    if (!ownerId) throw new Error("the installed owner has no real owner identity");
    const memberId = await assertRedeemedMemberIdentity(sidecar.page, ownerId);
    await sidecar.reconnect(memberId, ownerId);

    await ownerPage.click('.rail .rail-btn[data-go="files"]');
    await ownerPage.waitForSelector(`.file-index-row[data-file-row="${probeArtifact.id}"]`, { timeout: 30000 });
    probeRow = ownerPage.locator(`.file-index-row[data-file-row="${probeArtifact.id}"]`);
    await probeRow.click();
    await ownerPage.waitForSelector(
      `.files-detail[data-file-detail="${probeArtifact.id}"][data-file-detail-state="here"]`, { timeout: 20000 });
    probeAccess = ownerPage.locator(`.files-detail[data-file-detail="${probeArtifact.id}"] .fileaccess`);
    await ownerPage.waitForSelector(
      `.files-detail[data-file-detail="${probeArtifact.id}"] .fileaccess[data-access-editor="yes"]`, { timeout: 20000 });

    await sidecar.page.click('.rail .rail-btn[data-go="files"]');
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
        console.log("PASS cleanup closed member page/context/browser, stopped loopback server, and removed temp state");
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
