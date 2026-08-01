// The promise: a file this app will later believe is written WHOLE, or not at
// all. These tests do not take that on trust — one of them kills a real Node
// process in the middle of a real write and then looks at what is on the disk.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  IN_FLIGHT_GRACE_MS, PENDING_MARK, RENAME_TRIES, isPendingName, pendingNameFor,
  sweepPending, sweepPendingTree, writeWholeFile,
} from "./wholefile.js";
import { plantKilledWriteLitter } from "./litter-for-tests.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-whole-"));
const here = path.dirname(fileURLToPath(import.meta.url));

test("the bytes never touch the real name — they land next door and are renamed in", () => {
  const dir = tmp();
  const target = path.join(dir, "thing.json");
  const written: string[] = [];
  const renamed: [string, string][] = [];

  const realWrite = fs.writeFileSync;
  const realRename = fs.renameSync;
  (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync =
    ((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, o?: unknown) => {
      if (typeof p === "string") written.push(p);
      return realWrite(p as string, data as string, o as never);
    }) as typeof fs.writeFileSync;
  (fs as { renameSync: typeof fs.renameSync }).renameSync = ((from: string, to: string) => {
    renamed.push([from, to]);
    return realRename(from, to);
  }) as typeof fs.renameSync;

  try {
    assert.equal(writeWholeFile(target, '{"a":1}'), true);
  } finally {
    (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = realWrite;
    (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename;
  }

  assert.equal(written.length, 1, "written exactly once");
  assert.notEqual(written[0], target,
    "bytes went straight to the real name — an interrupted write would tear it");
  assert.ok(isPendingName(path.basename(written[0])), "and under a clearly-temporary name");
  assert.equal(path.dirname(written[0]), dir,
    "the temporary file must be in the SAME folder, or the rename is a copy and not atomic");
  assert.deepEqual(renamed, [[written[0], target]]);
  assert.equal(fs.readFileSync(target, "utf8"), '{"a":1}');
});

test("the bytes are pushed to the disk BEFORE the rename, not after", () => {
  const dir = tmp();
  const target = path.join(dir, "thing.json");
  const order: string[] = [];

  const realFsync = fs.fsyncSync;
  const realRename = fs.renameSync;
  (fs as { fsyncSync: typeof fs.fsyncSync }).fsyncSync = ((fd: number) => {
    order.push("flush");
    return realFsync(fd);
  }) as typeof fs.fsyncSync;
  (fs as { renameSync: typeof fs.renameSync }).renameSync = ((from: string, to: string) => {
    order.push("rename");
    return realRename(from, to);
  }) as typeof fs.renameSync;

  try {
    writeWholeFile(target, "hello");
  } finally {
    (fs as { fsyncSync: typeof fs.fsyncSync }).fsyncSync = realFsync;
    (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename;
  }

  assert.equal(order[0], "flush",
    "renaming is atomic about the NAME only — unflushed bytes can still be lost to a power cut");
  assert.ok(order.includes("rename"));
  assert.ok(order.indexOf("flush") < order.indexOf("rename"));
});

test("a write that fails leaves the OLD file exactly as it was, and no litter", () => {
  const dir = tmp();
  const target = path.join(dir, "thing.json");
  fs.writeFileSync(target, "the good old content", "utf8");

  const said: string[] = [];
  const realRename = fs.renameSync;
  (fs as { renameSync: typeof fs.renameSync }).renameSync = (() => {
    throw new Error("disk went away");
  }) as typeof fs.renameSync;
  let ok: boolean;
  try {
    ok = writeWholeFile(target, "the new content", m => said.push(m));
  } finally {
    (fs as { renameSync: typeof fs.renameSync }).renameSync = realRename;
  }

  assert.equal(ok, false, "a failed write must say so, not pretend");
  assert.equal(fs.readFileSync(target, "utf8"), "the good old content",
    "the previous file survived — nothing was half-replaced");
  assert.equal(said.length, 1);
  assert.ok(said[0].includes("thing.json"), `the complaint names the file: ${said[0]}`);
  assert.deepEqual(fs.readdirSync(dir), ["thing.json"], "and our own temporary file was cleared up");
});

// ---------------------------------------------------------------------------
// BYTES, NOT ONLY TEXT.
//
// The three most valuable files in this app are not text: an attachment Vikas
// uploaded, this install's own private key, and his saved Claude/Codex
// sign-ins. If the one owner of "write a file this app will later believe" only
// took a string, each of those would have to make its own binary copy of the
// rule — or, worse, stringify a Buffer on the way past and mangle every byte
// that is not valid UTF-8. These tests write bytes that are DELIBERATELY not
// valid UTF-8 and demand them back exactly.
// ---------------------------------------------------------------------------

/** Bytes no UTF-8 decoder can round-trip: lone surrogates, a bare 0xFF, a NUL. */
function notUtf8(): Buffer {
  const b = Buffer.from([
    0x00, 0xff, 0xfe, 0x80, 0x81, 0xc0, 0xc1, 0xed, 0xa0, 0x80, 0xf5, 0x90, 0x0d, 0x0a, 0x1a,
  ]);
  // prove the premise of this whole test before relying on it
  assert.notEqual(Buffer.from(b.toString("utf8"), "utf8").toString("hex"), b.toString("hex"),
    "these bytes survive a string round-trip, so they prove nothing — pick worse ones");
  return b;
}

test("bytes that are not valid UTF-8 come back byte for byte", () => {
  const dir = tmp();
  const target = path.join(dir, "attachment.bin");
  const original = Buffer.concat([notUtf8(), Buffer.alloc(64 * 1024, 0xab), notUtf8()]);

  assert.equal(writeWholeFile(target, original), true);

  const back = fs.readFileSync(target);
  assert.equal(back.length, original.length, "the file changed length going through the write");
  assert.equal(Buffer.compare(back, original), 0,
    "the bytes were mangled — this is what stringifying a Buffer does to a PDF");
  assert.deepEqual(fs.readdirSync(dir), ["attachment.bin"], "no litter left behind");
});

test("a Buffer is never turned into text on the way past", () => {
  // The proof above could also be passed by a lucky encoding. This one watches
  // what is actually handed to the disk.
  const dir = tmp();
  const target = path.join(dir, "credential.bin");
  const original = notUtf8();
  let handed: unknown = "nothing was written";

  const realWrite = fs.writeFileSync;
  (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync =
    ((p: fs.PathOrFileDescriptor, d: string | NodeJS.ArrayBufferView, o?: unknown) => {
      handed = d;
      return realWrite(p as string, d as string, o as never);
    }) as typeof fs.writeFileSync;
  try {
    assert.equal(writeWholeFile(target, original), true);
  } finally {
    (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = realWrite;
  }

  assert.ok(Buffer.isBuffer(handed), `the bytes arrived as ${typeof handed}, not as bytes`);
  assert.equal(Buffer.compare(handed as Buffer, original), 0);
});

test("the permission travels with the rename — it goes on the TEMPORARY file", () => {
  // A key written world-readable and tightened a moment later HAS been readable.
  // The window is small and on a shared machine it is the whole leak, so the
  // mode goes on the file the bytes are written into, before it has the name
  // anything looks for.
  const dir = tmp();
  const target = path.join(dir, "cloud9-owner-token.bin");
  const modes: (number | undefined)[] = [];
  const paths: string[] = [];

  const realWrite = fs.writeFileSync;
  (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync =
    ((p: fs.PathOrFileDescriptor, d: string | NodeJS.ArrayBufferView, o?: { mode?: number }) => {
      if (typeof p === "string") paths.push(p);
      modes.push(o?.mode);
      return realWrite(p as string, d as string, o as never);
    }) as typeof fs.writeFileSync;
  try {
    assert.equal(writeWholeFile(target, Buffer.from("a private key"), undefined, { mode: 0o600 }),
      true);
  } finally {
    (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = realWrite;
  }

  assert.equal(paths.length, 1, "written exactly once");
  assert.ok(isPendingName(path.basename(paths[0])), "and that one write was the temporary file");
  assert.deepEqual(modes, [0o600],
    "the permission was not on the temporary file, so it did not travel with the rename");

  if (process.platform !== "win32") {
    // Windows does not carry POSIX bits at all; asserting them there would be
    // asserting the operating system, not this function.
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  }
});

test("no mode asked for means no mode forced — an ordinary file stays ordinary", () => {
  const dir = tmp();
  const target = path.join(dir, "plain.json");
  const modes: (number | undefined)[] = [];
  const realWrite = fs.writeFileSync;
  (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync =
    ((p: fs.PathOrFileDescriptor, d: string | NodeJS.ArrayBufferView, o?: { mode?: number }) => {
      modes.push(o?.mode);
      return realWrite(p as string, d as string, o as never);
    }) as typeof fs.writeFileSync;
  try {
    assert.equal(writeWholeFile(target, "{}"), true);
  } finally {
    (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = realWrite;
  }
  assert.deepEqual(modes, [undefined]);
  assert.equal(fs.readFileSync(target, "utf8"), "{}");
});

test("a killed write of BYTES leaves the old bytes whole, not a mixture", async () => {
  // The kill test at the bottom of this file proves it for text. An attachment
  // is the one file on this list Vikas cannot get back, so it is proved for
  // bytes too — with real processes, not a simulation.
  const dir = tmp();
  const target = path.join(dir, "his-upload.bin");
  const good = Buffer.concat([notUtf8(), Buffer.from("THE OLD FILE, WHOLE")]);
  fs.writeFileSync(target, good);

  const script = path.join(dir, "writer.mjs");
  fs.writeFileSync(script, [
    `import { writeWholeFile } from ${JSON.stringify(pathToImport(path.join(here, "wholefile.js")))};`,
    `const big = Buffer.alloc(24 * 1024 * 1024, 0xff);`,
    `process.send?.("about-to-write");`,
    `setTimeout(() => {`,
    `  writeWholeFile(${JSON.stringify(target)}, big);`,
    `  process.send?.("finished");`,
    `}, 1);`,
  ].join("\n"), "utf8");

  let caughtMidWrite = false;
  for (let attempt = 0; attempt < 20 && !caughtMidWrite; attempt++) {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let finished = false;
    child.on("message", m => { if (m === "finished") finished = true; });
    await new Promise<void>(resolve => child.once("message", () => resolve()));
    await new Promise(r => setTimeout(r, 2 + attempt * 2));
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child.once("exit", () => resolve()));

    const onDisk = fs.readFileSync(target);
    const litter = fs.readdirSync(dir).filter(n => isPendingName(n)).map(n => path.join(dir, n));

    if (finished) {
      assert.equal(onDisk.length, 24 * 1024 * 1024, "the new file landed half-written");
      fs.writeFileSync(target, good);
      for (const f of litter) fs.rmSync(f, { force: true });
      continue;
    }

    assert.equal(Buffer.compare(onDisk, good), 0,
      "his uploaded file was torn by a killed write — and an upload cannot be re-derived");

    const inFlight = litter.filter(f => fs.statSync(f).size > 0);
    for (const f of litter) fs.rmSync(f, { force: true });
    if (inFlight.length === 0) continue;
    caughtMidWrite = true;
  }
  assert.ok(caughtMidWrite, "never caught a write in flight — this proof did not actually run");
});

test("two writes in the same millisecond do not use the same temporary name", () => {
  const target = path.join(tmp(), "thing.json");
  const names = new Set<string>();
  for (let i = 0; i < 200; i++) names.add(pendingNameFor(target));
  assert.equal(names.size, 200, "one writer overwriting another's temporary file is the same bug again");
  for (const n of names) assert.ok(n.startsWith(`${target}${PENDING_MARK}`));
});

test("leftover temporary files are swept, and real files are not", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "keep.json"), "{}", "utf8");
  fs.writeFileSync(path.join(dir, `half.json${PENDING_MARK}1-2-3`), "{ half", "utf8");
  fs.writeFileSync(path.join(dir, `other.json${PENDING_MARK}9-9-9`), "", "utf8");

  assert.equal(sweepPending(dir), 2);
  assert.deepEqual(fs.readdirSync(dir), ["keep.json"]);
  assert.equal(sweepPending(path.join(dir, "nope")), 0, "a folder that isn't there is not a crash");
});

// ---------------------------------------------------------------------------
// FINDING 3: WINDOWS SAYS NO, BRIEFLY.
//
// Defender and the search indexer open files without sharing delete. While one
// of them holds a handle the rename over the target fails with EPERM, and it is
// over in milliseconds. Trying once meant the save was abandoned for good
// because a scanner happened to be reading the old file at that instant — on a
// machine that runs Defender by definition.
// ---------------------------------------------------------------------------

/** Make renameSync fail `times` times with `code`, then behave. Returns the attempt count. */
function renameFailing(times: number, code: string): { attempts: () => number; restore: () => void } {
  const real = fs.renameSync;
  let attempts = 0;
  (fs as { renameSync: typeof fs.renameSync }).renameSync = ((from: string, to: string) => {
    attempts++;
    if (attempts <= times) {
      const err = new Error(`${code}: someone is holding it`) as NodeJS.ErrnoException;
      err.code = code;
      throw err;
    }
    return real(from, to);
  }) as typeof fs.renameSync;
  return {
    attempts: () => attempts,
    restore: () => { (fs as { renameSync: typeof fs.renameSync }).renameSync = real; },
  };
}

test("a scanner holding the file for a moment does not lose the save — the rename is retried", () => {
  for (const code of ["EPERM", "EACCES", "EBUSY"]) {
    const dir = tmp();
    const target = path.join(dir, "schedules.json");
    fs.writeFileSync(target, "[]", "utf8");

    const stub = renameFailing(2, code);
    let ok: boolean;
    try { ok = writeWholeFile(target, '["the new one"]'); } finally { stub.restore(); }

    assert.equal(ok, true, `${code}: the save was thrown away over a share violation`);
    assert.equal(stub.attempts(), 3, `${code}: it must try again, not give up on the first refusal`);
    assert.equal(fs.readFileSync(target, "utf8"), '["the new one"]');
    assert.deepEqual(fs.readdirSync(dir), ["schedules.json"], `${code}: no litter left behind`);
  }
});

test("a file held open for good fails honestly rather than retrying for ever", () => {
  const dir = tmp();
  const target = path.join(dir, "thing.json");
  fs.writeFileSync(target, "old", "utf8");

  const said: string[] = [];
  const stub = renameFailing(Number.MAX_SAFE_INTEGER, "EPERM");
  const started = Date.now();
  let ok: boolean;
  try { ok = writeWholeFile(target, "new", m => said.push(m)); } finally { stub.restore(); }

  assert.equal(ok, false, "a write that never landed must say so");
  assert.equal(stub.attempts(), RENAME_TRIES, "it gives up after a fixed number of goes");
  assert.ok(Date.now() - started < 5000, "and it gives up quickly — the owner is waiting");
  assert.equal(fs.readFileSync(target, "utf8"), "old", "the old file survived");
  assert.equal(said.length, 1, `and the caller was told: ${JSON.stringify(said)}`);
  assert.deepEqual(fs.readdirSync(dir), ["thing.json"], "no litter left behind");
});

test("a failure that is NOT someone holding the file is not retried at all", () => {
  // Retrying a full disk or a missing folder six times just makes the owner
  // wait six times as long for the same answer.
  const dir = tmp();
  const stub = renameFailing(Number.MAX_SAFE_INTEGER, "ENOSPC");
  try {
    assert.equal(writeWholeFile(path.join(dir, "thing.json"), "new"), false);
  } finally { stub.restore(); }
  assert.equal(stub.attempts(), 1, "a full disk is not a race — asking again cannot help");
});

// ---------------------------------------------------------------------------
// FINDING 4: SWEEP EVERYWHERE THE APP WRITES, NOT THE TOP FLOOR.
// ---------------------------------------------------------------------------

test("the sweep reaches every folder underneath, not just the one it was pointed at", () => {
  const root = tmp();
  const skills = path.join(root, "agents", "a1", "skills");
  const runs = path.join(root, "agents", "a1", "runs");
  fs.mkdirSync(skills, { recursive: true });
  fs.mkdirSync(runs, { recursive: true });
  plantKilledWriteLitter(path.join(root, "schedules.json"), "x");
  // the one that mattered: an instruction the CLI reads, half written
  plantKilledWriteLitter(path.join(skills, "checklist.md"), "step 1: do");
  fs.writeFileSync(path.join(skills, "checklist.md"), "step 1: do this\nstep 2: and this", "utf8");
  plantKilledWriteLitter(path.join(runs, "r-1-a.json"), "{");

  assert.equal(sweepPending(root), 1, "the old top-floor sweep only ever saw one of the three");
  assert.equal(sweepPendingTree(root), 2, "the two underneath were left for ever");

  assert.deepEqual(fs.readdirSync(skills), ["checklist.md"], "and the real skill file is untouched");
  assert.deepEqual(fs.readdirSync(runs), []);
  assert.equal(fs.readFileSync(path.join(skills, "checklist.md"), "utf8"),
    "step 1: do this\nstep 2: and this");
});

test("the sweep does not follow a link out of the data folder, and cannot spin", () => {
  const root = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, `secret.json${PENDING_MARK}999-1-1`), "x", "utf8");
  try {
    fs.symlinkSync(outside, path.join(root, "elsewhere"), "junction");
  } catch {
    return; // no permission to make links on this machine — nothing to prove here
  }
  assert.equal(sweepPendingTree(root), 0);
  assert.equal(fs.readdirSync(outside).length, 1, "the sweep walked off down a link");
});

// ---------------------------------------------------------------------------
// FINDING 5: TWO WINDOWS, ONE DATA FOLDER.
//
// The second window sweeps at startup. Without a guard it could delete the
// first window's half-written temporary file a millisecond before its rename.
// That fails safely — the old file survives — but a save the owner asked for
// is lost and nobody told him.
// ---------------------------------------------------------------------------

test("the sweep will not touch a temporary file a live process is still writing", async () => {
  const dir = tmp();
  const mine = path.join(dir, `schedules.json${PENDING_MARK}${process.pid}-${Date.now()}-1`);
  fs.writeFileSync(mine, "half a file", "utf8");

  assert.equal(sweepPending(dir), 0, "it deleted a file this very process may be writing");
  assert.ok(fs.existsSync(mine));

  // a pid that is REALLY gone — a child we start and wait for
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  const deadPid = child.pid!;
  await new Promise<void>(resolve => child.once("exit", () => resolve()));
  const theirs = path.join(dir, `schedules.json${PENDING_MARK}${deadPid}-${Date.now()}-1`);
  fs.writeFileSync(theirs, "litter", "utf8");

  assert.equal(sweepPending(dir), 1, "litter from a process that has died must still be swept");
  assert.equal(fs.existsSync(theirs), false);
  assert.ok(fs.existsSync(mine), "and the live one is still protected");

  // ...but not for ever. A pid gets reused; an old file is litter whoever owns
  // that number now.
  const old = Date.now() - IN_FLIGHT_GRACE_MS - 60_000;
  fs.utimesSync(mine, new Date(old), new Date(old));
  const aged = path.join(dir, `schedules.json${PENDING_MARK}${process.pid}-${old}-2`);
  fs.renameSync(mine, aged);
  fs.utimesSync(aged, new Date(old), new Date(old));
  assert.equal(sweepPending(dir), 1, "an hour-old temporary file is litter, live pid or not");
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("a second window sweeping cannot eat the first one's in-flight save", async () => {
  // TWO REAL PROCESSES. A child writes a large file through `writeWholeFile`;
  // the parent sweeps the folder while those bytes are going down, exactly as a
  // second Cloud9 window does at startup. The child's save must still land.
  const dir = tmp();
  const target = path.join(dir, "schedules.json");
  fs.writeFileSync(target, '["the old one"]', "utf8");

  const script = path.join(dir, "writer.mjs");
  fs.writeFileSync(script, [
    `import { writeWholeFile } from ${JSON.stringify(pathToImport(path.join(here, "wholefile.js")))};`,
    `const big = JSON.stringify(["the new one", "x".repeat(24 * 1024 * 1024)]);`,
    `process.send?.("about-to-write");`,
    `setTimeout(() => {`,
    `  const ok = writeWholeFile(${JSON.stringify(target)}, big);`,
    `  process.send?.(ok ? "saved" : "lost");`,
    `}, 1);`,
  ].join("\n"), "utf8");

  let sweptMidWrite = false;
  for (let attempt = 0; attempt < 20 && !sweptMidWrite; attempt++) {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let outcome = "";
    child.on("message", m => { if (m === "saved" || m === "lost") outcome = String(m); });
    await new Promise<void>(resolve => child.once("message", () => resolve()));

    // catch it with bytes on the disk and the rename not yet done
    let caught = false;
    for (let look = 0; look < 200 && !caught && !outcome; look++) {
      const inFlight = fs.readdirSync(dir)
        .filter(n => isPendingName(n))
        .filter(n => fs.statSync(path.join(dir, n)).size > 0);
      if (inFlight.length > 0) { sweepPending(dir); caught = true; break; }
      await new Promise(r => setTimeout(r, 1));
    }
    await new Promise<void>(resolve => child.once("exit", () => resolve()));
    if (!caught) continue;

    sweptMidWrite = true;
    assert.equal(outcome, "saved",
      "the other window's sweep deleted a save that was in flight — the owner is never told");
    assert.equal(JSON.parse(fs.readFileSync(target, "utf8"))[0], "the new one");
    assert.deepEqual(fs.readdirSync(dir).sort(), ["schedules.json", "writer.mjs"]);
  }
  assert.ok(sweptMidWrite,
    "never swept while a write was in flight — the two-window proof did not actually run");
});

// ---------------------------------------------------------------------------
// THE REAL PROOF: kill a real process in the middle of a real write.
//
// Everything above is about how the code behaves. This is about what is
// actually on the disk after the machine is pulled out from under it. A child
// process writes a large file through `writeWholeFile`; the parent kills it
// while the bytes are still going down. The file under the REAL name must then
// be either the old whole file or absent — never a mixture.
// ---------------------------------------------------------------------------

test("a process killed mid-write never leaves half a file under the real name", async () => {
  const dir = tmp();
  const target = path.join(dir, "record.json");
  const good = JSON.stringify({ id: "the-old-one", whole: true });
  fs.writeFileSync(target, good, "utf8");

  // ~24 MB of JSON: big enough that the write is still in progress when we kill
  const script = path.join(dir, "writer.mjs");
  fs.writeFileSync(script, [
    `import { writeWholeFile } from ${JSON.stringify(pathToImport(path.join(here, "wholefile.js")))};`,
    // build the text FIRST, so the moment we say "go" the only work left is the
    // write itself — otherwise the kill lands during JSON.stringify and proves
    // nothing about the file on disk
    `const big = JSON.stringify({ id: "the-new-one", filler: "x".repeat(24 * 1024 * 1024) });`,
    `process.send?.("about-to-write");`,
    `setTimeout(() => {`,
    `  writeWholeFile(${JSON.stringify(target)}, big);`,
    `  process.send?.("finished");`,
    `}, 1);`,
  ].join("\n"), "utf8");

  let caughtMidWrite = false;
  for (let attempt = 0; attempt < 20 && !caughtMidWrite; attempt++) {
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    let finished = false;
    child.on("message", (m) => { if (m === "finished") finished = true; });
    await new Promise<void>(resolve => child.once("message", () => resolve()));
    // give it a sliver of the write, then pull the plug
    await new Promise(r => setTimeout(r, 2 + attempt * 2));
    child.kill("SIGKILL");
    await new Promise<void>(resolve => child.once("exit", () => resolve()));

    // WHATEVER happened, the real name must hold ONE whole record — never a mix
    const onDisk = fs.readFileSync(target, "utf8");
    const litter = fs.readdirSync(dir)
      .filter(n => isPendingName(n))
      .map(n => path.join(dir, n));

    if (finished) {
      // it beat us to it — then the new record must be COMPLETE, never partial
      assert.equal(JSON.parse(onDisk).id, "the-new-one");
      fs.writeFileSync(target, good, "utf8"); // reset and try to catch it earlier
      for (const f of litter) fs.rmSync(f, { force: true });
      continue;
    }

    assert.equal(onDisk, good,
      "the real name was torn by a killed write — this is the bug this module exists to prevent");
    assert.equal(JSON.parse(onDisk).id, "the-old-one");

    // Only count this as PROOF when we can SEE the write was in flight: the
    // child died with bytes on the disk under the temporary name and the rename
    // never happened. Killing it before it wrote anything proves nothing about
    // torn files, so we try again a little later.
    const inFlight = litter.filter(f => fs.statSync(f).size > 0);
    for (const f of litter) fs.rmSync(f, { force: true });
    if (inFlight.length === 0) continue;

    caughtMidWrite = true;
    assert.ok(onDisk.length < 1000,
      "the new bytes reached the real name even though the write never completed");
    assert.deepEqual(fs.readdirSync(dir).sort(), ["record.json", "writer.mjs"],
      "and the abandoned bytes were nowhere but under a sweepable temporary name");
  }
  assert.ok(caughtMidWrite,
    "never caught a write in flight — the interrupted-write proof did not actually run");
});

/** A file path the child's `import` will accept on Windows as well as POSIX. */
function pathToImport(file: string): string {
  return new URL(`file://${file.replace(/\\/g, "/").replace(/^([A-Za-z]:)/, "/$1")}`).href;
}
