// HIS ITEM 2, THE ENGINE'S HALF: "every agent shows offline".
//
// The rule itself lives in `agentPresence` in `@cloud9/shared` and the hub
// applies it. What the ENGINE owns is the facts that rule is fed — and it was
// feeding it a guess. These tests pin the difference between "we looked and it
// isn't there" and "we haven't looked yet", because shared's own documentation
// says the second one must never be reported as the first.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HarnessState, agentPresence } from "@cloud9/shared";
import { HarnessManager } from "./harness.js";
import { startEngineHost } from "./host.js";
import { RunResult } from "./run.js";
import { tempDir } from "./tmp-for-tests.js";

const tmp = (): string => tempDir("cloud9-presence-");

const missing = (): Promise<RunResult> => Promise.resolve({
  code: 1, stdout: "", stderr: "'x' is not recognized as an internal or external command",
  timedOut: false, notFound: true,
});

/** A runner that takes a moment, so "during detection" is a real window. */
const slowlyMissing = (delayMs: number) => (): Promise<RunResult> =>
  new Promise(resolve => setTimeout(() => void missing().then(resolve), delayMs));

// ---------------------------------------------------------------------------
// 1. The manager knows whether it has looked
// ---------------------------------------------------------------------------

test("a harness manager that has not looked yet says so", async () => {
  const m = new HarnessManager({ runner: missing as never, detectTimeoutMs: 500 });
  assert.equal(m.hasDetected, false, "nothing has been established about this computer");
  await m.refresh();
  assert.equal(m.hasDetected, true, "now it has: we looked, and the apps are not there");
  m.stop();
});

test("a state handed in from elsewhere counts as having looked", () => {
  const m = new HarnessManager({ runner: missing as never });
  const state: HarnessState = {
    claude: { name: "claude", installed: true, signedIn: true, authKind: "cli-login", models: ["m"], detail: "Signed in" },
    codex: { name: "codex", installed: false, signedIn: false, authKind: "none", models: [], detail: "not installed" },
    updatedAt: 1,
  };
  m.setState(state);
  assert.equal(m.hasDetected, true);
  m.stop();
});

// ---------------------------------------------------------------------------
// 2. THE BUG. The hub must not be told a guess.
// ---------------------------------------------------------------------------

test("the hub is not told the apps are missing before the engine has looked", async () => {
  const frames: HarnessState[] = [];
  const host = startEngineHost({
    relayUrl: "ws://unused", token: "t", connect: false, dataDir: tmp(),
    harness: { runner: slowlyMissing(120) as never, detectTimeoutMs: 500 },
    log: () => { /* quiet */ },
  });
  (host.engine as unknown as { sendFrame: (f: { type: string; state?: HarnessState }) => void })
    .sendFrame = f => { if (f.type === "harnessState" && f.state) frames.push(f.state); };

  const done = host.harness.refresh();
  // refresh() publishes its "checking" state immediately, so the local settings
  // card can spin. That state is the placeholder: both apps installed:false,
  // "not checked yet". It must NOT have reached the hub.
  assert.equal(frames.length, 0,
    "nothing has been established about this computer, so nothing may be claimed about it");

  await done;
  assert.equal(frames.length, 1, "one frame, once there is something true to say");
  assert.equal(frames[0].claude.installed, false, "and now it IS a finding: we looked");
  host.stop();
});

test("what the hub does with each of those answers — the difference is the bug", () => {
  const agent = { provider: "codex" as const, lifecycle: "enabled" as const };
  // the guess the engine used to send
  const guessed = agentPresence(agent, {
    engineConnected: true, harness: { installed: false, signedIn: false }, status: "idle",
  });
  assert.equal(guessed.presence, "offline", "a grey dot on a signed-in machine — his complaint");

  // what it sends now while it is still looking
  const honest = agentPresence(agent, { engineConnected: true, status: "idle" });
  assert.notEqual(honest.presence, "offline");
  assert.match(honest.reason, /hasn't reported in yet/);

  // and once it really has looked and Codex really is signed out
  const found = agentPresence(agent, {
    engineConnected: true, harness: { installed: true, signedIn: false }, status: "idle",
  });
  assert.equal(found.presence, "offline");
  assert.match(found.reason, /Codex isn't signed in/,
    "the reason travels with it, in his words — that is the point of the reason");
});

// ---------------------------------------------------------------------------
// 3. Once it HAS looked, the truth still gets through
// ---------------------------------------------------------------------------

test("a real detection result reaches the hub, demo flag and all", async () => {
  const frames: HarnessState[] = [];
  const host = startEngineHost({
    relayUrl: "ws://unused", token: "t", connect: false, dataDir: tmp(),
    harness: { runner: missing as never, detectTimeoutMs: 500 },
    log: () => { /* quiet */ },
  });
  (host.engine as unknown as { sendFrame: (f: { type: string; state?: HarnessState }) => void })
    .sendFrame = f => { if (f.type === "harnessState" && f.state) frames.push(f.state); };

  await host.harness.refresh();
  assert.equal(frames.length, 1);
  assert.equal(frames[0].demo, false, "demo mode always travels with the status");
  // A second round still reports — this is not a one-shot gate. It reports
  // TWICE: once to say "I'm looking again" and once with the answer. That is
  // fine and it is the difference the gate exists for — by now the "looking"
  // frame carries the previous REAL findings, not the placeholder, so nothing
  // untrue is on the wire at any point.
  await host.harness.refresh();
  assert.equal(frames.length, 3);
  assert.equal(frames[1].checking, true, "the middle frame is the one that says 'still looking'");
  assert.equal(frames[2].checking, false);
  host.stop();
});
