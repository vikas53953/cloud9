import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef, AgentSchedule } from "@cloud9/shared";
import { Engine, SCHEDULE_NOT_SAVED } from "./engine.js";
import { isScheduleWhen, Scheduler } from "./scheduler.js";
import { isPendingName, PENDING_MARK } from "./wholefile.js";

const sched = (when: string, id = "s1"): AgentSchedule => ({
  id, agentId: "a1", channelId: "c1", when, prompt: "check in", enabled: true,
});

test("daily fires at the right minute, once", () => {
  const fired: string[] = [];
  const s = new Scheduler(() => [sched("daily 06:30")], f => fired.push(f.schedule.id));
  const at = new Date(); at.setHours(6, 30, 5, 0);
  s.tick(at);
  s.tick(new Date(at.getTime() + 20_000)); // same minute — no double fire
  assert.equal(fired.length, 1);
  const wrong = new Date(); wrong.setHours(7, 0, 0, 0);
  s.tick(wrong);
  assert.equal(fired.length, 1);
});

test("every Nm fires on interval", () => {
  const fired: string[] = [];
  const s = new Scheduler(() => [sched("every 15m", "s2")], f => fired.push(f.schedule.id));
  const t0 = new Date();
  s.tick(t0);                                    // first fire (never fired before)
  s.tick(new Date(t0.getTime() + 5 * 60_000));   // too soon
  s.tick(new Date(t0.getTime() + 16 * 60_000));  // fires
  assert.equal(fired.length, 2);
});

test("disabled schedules never fire", () => {
  const fired: string[] = [];
  const s = new Scheduler(() => [{ ...sched("every 1m"), enabled: false }], f => fired.push(f.schedule.id));
  s.tick(new Date());
  assert.equal(fired.length, 0);
});

// ------------------------------------------------- the schedules FILE itself
//
// Same class as the run records, and worse: ONE file holds every schedule for
// every agent, and it is rewritten whole on every change. A torn write here
// does not lose one run — it loses everything he ever scheduled, silently.

const tmpDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-sched-"));
function engineIn(dataDir: string): Engine {
  return new Engine({ relayUrl: "ws://127.0.0.1:1", token: "t", dataDir });
}

test("the schedules file is written whole or not at all", () => {
  const dir = tmpDir();
  const file = path.join(dir, "schedules.json");
  const written: string[] = [];

  const realWrite = fs.writeFileSync;
  (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync =
    ((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, o?: unknown) => {
      if (typeof p === "string" && p.includes("schedules.json")) written.push(path.basename(p));
      return realWrite(p as string, data as string, o as never);
    }) as typeof fs.writeFileSync;
  try {
    engineIn(dir).saveSchedule(sched("daily 06:30"));
  } finally {
    (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = realWrite;
  }

  assert.equal(written.length, 1);
  assert.notEqual(written[0], "schedules.json",
    "the bytes went straight to the real name — a power cut here loses every schedule he set");
  assert.ok(isPendingName(written[0]), `and the temporary name says so: ${written[0]}`);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).length, 1);
  assert.deepEqual(fs.readdirSync(dir), ["schedules.json"], "no litter left behind");
});

test("starting up clears away the litter of a write that was killed", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "schedules.json"), "[]", "utf8");
  fs.writeFileSync(path.join(dir, `schedules.json${PENDING_MARK}999-1-1`), "x".repeat(5000), "utf8");

  engineIn(dir);
  assert.deepEqual(fs.readdirSync(dir), ["schedules.json"],
    "a temporary file nobody was ever told about must not live in his data folder for ever");
});

test("a damaged schedules file is refused in plain words, never half-believed", () => {
  const said: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { said.push(args.map(String).join(" ")); };
  try {
    for (const [bytes, words] of [
      ['[{"id":"s1","agentId":"a1","when":"daily 06:', "damaged"],
      ['{"id":"s1"}', "does not hold a list"],
    ] as [string, string][]) {
      said.length = 0;
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, "schedules.json"), bytes, "utf8");
      const engine = engineIn(dir); // must not throw
      assert.deepEqual(engine.schedules, [],
        `a file we cannot believe must give no schedules, not half of them: ${bytes}`);
      assert.ok(said.some(m => m.includes(words)),
        `the refusal must say what is wrong: ${JSON.stringify(said)}`);
    }
    // and rows inside a good list that are not schedules are dropped, not trusted
    said.length = 0;
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "schedules.json"),
      JSON.stringify([sched("daily 06:30"), null, "nope", { when: "daily 07:00" }]), "utf8");
    assert.deepEqual(engineIn(dir).schedules.map(s => s.id), ["s1"]);
  } finally {
    console.error = realError;
  }
});

// ------------------------------------------- FINDING 2: present ≠ sensible
//
// A row only had to carry a string `id` to be believed. `{"id":"s1","when":12}`
// therefore came back as a schedule, sat in the list, matched nothing the
// scheduler understands and never fired — for ever, without a word. `when` is
// now asked of the SCHEDULER'S OWN grammar, so a time this file accepts and the
// scheduler cannot act on is impossible by construction.

test("a saved schedule that could never fire is dropped out loud, not believed", () => {
  const said: string[] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { said.push(args.map(String).join(" ")); };
  try {
    const rubbish = [
      { ...sched("daily 06:30", "bad-when"), when: 12 },
      { ...sched("daily 06:30", "no-grammar"), when: "sometime on Tuesday" },
      { ...sched("daily 06:30", "impossible-hour"), when: "daily 99:99" },
      { ...sched("daily 06:30", "spin"), when: "every 0m" },
      { ...sched("daily 06:30", "no-prompt"), prompt: 7 },
      { ...sched("daily 06:30", "no-agent"), agentId: "" },
      { ...sched("daily 06:30", "half-on"), enabled: "yes" },
    ];
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, "schedules.json"),
      JSON.stringify([sched("daily 06:30"), ...rubbish, sched("every 5m", "s9")]), "utf8");

    const engine = engineIn(dir);
    assert.deepEqual(engine.schedules.map(s => s.id), ["s1", "s9"],
      "a row nothing can act on was kept and will silently never happen");
    assert.equal(said.filter(m => m.includes("cannot be acted on")).length, rubbish.length,
      `every dropped row must be said out loud — got ${JSON.stringify(said)}`);

    // and every `when` that survived is one the scheduler itself accepts
    for (const s of engine.schedules) {
      assert.ok(isScheduleWhen(s.when), `loaded a when the scheduler cannot fire: ${s.when}`);
    }
  } finally {
    console.error = realError;
  }
});

test("the schedule command can only ever produce a when the scheduler can fire", () => {
  // The command handler has its own regex for the two forms. That is a second
  // spelling of the same grammar, and a second spelling drifts — so every
  // `when` the command path can actually create is run through the REAL owner
  // of the question rather than eyeballed.
  for (const when of [
    "daily 06:30", "daily 0:00", "daily 23:59", "every 1m", "every 15m", "every 1440m",
  ]) {
    assert.ok(isScheduleWhen(when), `the command can make this and the scheduler ignores it: ${when}`);
  }
  for (const when of ["daily 24:00", "daily 06:60", "every 0m", "weekly", "", "daily 6:3"]) {
    assert.equal(isScheduleWhen(when), false, `accepted something nothing will ever fire: ${when}`);
  }
});

// ------------------------- FINDING 1: NOTHING SAYS "SAVED" UNLESS IT IS SAVED
//
// `writeWholeFile` never throws. Before it, `saveSchedule` used a bare
// `writeFileSync`, so a failed save THREW and the "⏰ Scheduled!" line below it
// never ran. Making the write quiet turned a loud failure into a silent one:
// the confirmation went out regardless, the schedule fired until the app was
// closed and was then gone with nobody told. These tests make the disk write
// fail for real and watch what the owner is told.

const agentDef = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u-vikas", name: "Scout", emoji: "🔭", persona: "checks things",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
  provider: "codex", createdAt: 0, ...over,
});

/** Run `body` with every rename into place failing, the way a full disk does. */
function withTheDiskRefusing<T>(body: () => T): T {
  const realRename = fs.renameSync;
  const realError = console.error;
  (fs as { renameSync: typeof fs.renameSync }).renameSync = (() => {
    const err = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
    err.code = "ENOSPC"; // NOT a share violation, so it is not retried
    throw err;
  }) as typeof fs.renameSync;
  console.error = () => { /* the log line is not what is on trial here */ };
  try { return body(); } finally {
    (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename;
    console.error = realError;
  }
}

test("a schedule that could not be saved is NOT reported as scheduled", () => {
  const dir = tmpDir();
  const engine = engineIn(dir);
  const sent: string[] = [];
  engine.agentSend = (_a, _c, text) => { sent.push(text); };

  const handled = withTheDiskRefusing(() =>
    engine.handleScheduleCommand(agentDef(), "c1", "!schedule daily 06:30 post a morning check-in"));

  assert.equal(handled, true, "the command was still handled");
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes("Scheduled!"),
    `he was told it was scheduled when it was not: ${sent[0]}`);
  assert.equal(sent[0], SCHEDULE_NOT_SAVED);
  assert.ok(sent[0].includes("NOT"), "the sentence has to be unmissable");

  // and the app agrees with the disk rather than with itself
  assert.deepEqual(engine.schedules, [],
    "a schedule kept in memory after a failed save fires all afternoon and is gone at the restart");
  assert.equal(fs.existsSync(path.join(dir, "schedules.json")), false, "nothing reached the disk");
});

test("a cancellation that could not be saved is NOT reported as cancelled", () => {
  const dir = tmpDir();
  const engine = engineIn(dir);
  engine.saveSchedule(sched("daily 06:30")); // this one really is on the disk
  const sent: string[] = [];
  engine.agentSend = (_a, _c, text) => { sent.push(text); };

  withTheDiskRefusing(() => engine.handleScheduleCommand(agentDef(), "c1", "!unschedule s1"));

  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes("Cancelled"), `he was told it was cancelled: ${sent[0]}`);
  assert.ok(sent[0].includes("could NOT cancel"), sent[0]);
  assert.deepEqual(engine.schedules.map(s => s.id), ["s1"],
    "the schedule is still set, and the app says so — it comes back at the next restart either way");
});

test("saveSchedule and deleteSchedule report what the disk did", () => {
  const dir = tmpDir();
  const engine = engineIn(dir);
  assert.equal(engine.saveSchedule(sched("daily 06:30")), true);
  assert.equal(withTheDiskRefusing(() => engine.saveSchedule(sched("every 5m", "s2"))), false);
  assert.equal(withTheDiskRefusing(() => engine.deleteSchedule("s1")), false);
  assert.equal(engine.deleteSchedule("s1"), true);
});
