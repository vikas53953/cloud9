// NOTICING what an agent's turn produced. These tests are about the half nobody
// had: today the agent says "the file is at C:\Users\… " and that sentence is
// useless to everybody except the machine it ran on.
//
// Every test here was watched to FAIL with the feature broken on purpose — the
// break is named beside each one, so a check that cannot fail cannot hide here.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ARTIFACT_LIMITS } from "@cloud9/shared";
import { pendingNameFor } from "./wholefile.js";
import { SKIP_FOLDERS, SWEEP_DEFAULTS, describeRefusals, sweepProduced } from "./artifacts.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-artifacts-"));

/** Write a file and set its modified time, so "this turn" is a real fact. */
function put(dir: string, rel: string, body: string | Buffer, at?: number): string {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  if (at !== undefined) fs.utimesSync(full, new Date(at), new Date(at));
  return full;
}

test("a file the turn wrote is offered; one that was already there is not", () => {
  const dir = tmp();
  const turnStarted = Date.now();
  put(dir, "old-notes.md", "from last week", turnStarted - 7 * 24 * 3600_000);
  put(dir, "report.md", "# what I found", turnStarted + 500);

  const sweep = sweepProduced(dir, { since: turnStarted });

  assert.deepEqual(sweep.offers.map(o => o.name), ["report.md"],
    "only what this turn touched — otherwise every hello re-shares the whole folder");
  assert.equal(sweep.offers[0].size, "# what I found".length);
  assert.equal(sweep.refused.length, 0);
  // BREAK: drop the `stat.mtimeMs < opts.since` line and this test fails with
  // old-notes.md offered as well. Watched.
});

test("the engine's own bookkeeping and a checkout's litter are never shared", () => {
  const dir = tmp();
  const since = Date.now() - 1000;
  put(dir, "runs/r-1.json", '{"id":"r-1"}');
  put(dir, "skills/brief.md", "always do this");
  put(dir, ".git/COMMIT_EDITMSG", "wip");
  put(dir, "node_modules/left-pad/index.js", "module.exports=1");
  put(dir, "dist/bundle.js", "compiled");
  put(dir, ".hidden-state", "not his file");
  put(dir, "summary.txt", "this one IS his file");

  const sweep = sweepProduced(dir, { since });

  assert.deepEqual(sweep.offers.map(o => o.name), ["summary.txt"]);
  for (const folder of ["runs", "skills", ".git", "node_modules", "dist"]) {
    assert.ok(SKIP_FOLDERS.has(folder), `${folder} must be on the skip list, not skipped by luck`);
  }
  // BREAK: empty SKIP_FOLDERS and this fails with five files offered, including
  // the agent's own run records. Watched.
});

test("a file still being written is invisible, so nothing is ever shared half-made", () => {
  const dir = tmp();
  const since = Date.now() - 1000;
  // the REAL name the whole-write mechanism uses, from its own function — not a
  // shape typed out here, which would be a second spelling of the same rule
  const pending = pendingNameFor(path.join(dir, "report.md"));
  fs.writeFileSync(pending, "half a rep");
  assert.ok(!path.basename(pending).startsWith("."),
    "a pending file does NOT start with a dot, so the dot rule is not what catches it");
  const sweep = sweepProduced(dir, { since });
  assert.deepEqual(sweep.offers, [],
    "a temporary file from the whole-write mechanism is not a result");
  assert.deepEqual(sweep.refused, [],
    "and it is not a refusal either — nobody is waiting on a file that does not exist yet");
  // BREAK: remove the `isPendingName` guard and this fails — a truncated file
  // gets shared as if it were finished. Watched.
});

test("too big is REFUSED IN WORDS, with the size, the limit and what to do", () => {
  const dir = tmp();
  const since = Date.now() - 1000;
  put(dir, "huge.bin", Buffer.alloc(ARTIFACT_LIMITS.bytes + 1, 7));
  put(dir, "small.md", "fine");

  const sweep = sweepProduced(dir, { since });

  assert.deepEqual(sweep.offers.map(o => o.name), ["small.md"]);
  assert.equal(sweep.refused.length, 1);
  const why = sweep.refused[0].why;
  assert.ok(why.includes("huge.bin"), "the sentence names the file");
  assert.ok(why.includes("10 MB"), `the sentence says the limit: ${why}`);
  assert.ok(why.includes("still on this computer"),
    `it must say the file did NOT vanish: ${why}`);
  assert.ok(!/[A-Za-z]:\\/.test(why), "and it carries no Windows path");
  // BREAK: return the file as an offer instead of a refusal and this fails on
  // the refusal count; drop the sentence and it fails on the words. Watched.
});

test("a name that may not become a file is refused, never quietly renamed", () => {
  const dir = tmp();
  const since = Date.now() - 1000;
  // both are real names Windows will happily create and `isSafeFileName`
  // (the ONE owner of this rule) will not accept
  put(dir, "-report.md", "starts with a dash");
  put(dir, "notes..md", "carries a double dot");
  put(dir, "fine.md", "ok");

  const sweep = sweepProduced(dir, { since });

  assert.deepEqual(sweep.offers.map(o => o.name), ["fine.md"]);
  assert.deepEqual(sweep.refused.map(r => r.name).sort(), ["-report.md", "notes..md"]);
  for (const r of sweep.refused) {
    assert.ok(r.why.includes("file name isn't allowed"), r.why);
  }
  // BREAK: drop the `isSafeFileName` branch and this fails — the two names are
  // offered, and the hub refuses them later with nobody told why. Watched.
});

test("a turn that changed hundreds of files shares the newest few and SAYS SO", () => {
  const dir = tmp();
  const since = Date.now() - 60_000;
  for (let i = 0; i < SWEEP_DEFAULTS.maxFiles + 5; i++) {
    put(dir, `note-${i}.txt`, `n${i}`, since + 1000 + i * 1000);
  }
  const sweep = sweepProduced(dir, { since });

  assert.equal(sweep.offers.length, SWEEP_DEFAULTS.maxFiles);
  assert.equal(sweep.offers[0].name, `note-${SWEEP_DEFAULTS.maxFiles + 4}.txt`,
    "newest first — the file it was working on last");
  assert.equal(sweep.refused.length, 5, "the ones left behind are counted, not dropped quietly");
  assert.ok(sweep.refused[0].why.includes("still on this computer"));
  // BREAK: slice without pushing the remainder into `refused` and this fails —
  // which is the silent-trim bug. Watched.
});

test("an empty file and a folder that cannot be read produce nothing, and no throw", () => {
  const dir = tmp();
  put(dir, "empty.txt", "", Date.now());
  assert.deepEqual(sweepProduced(dir, { since: Date.now() - 1000 }).offers, []);
  // a path that is not there at all is a folder with nothing in it, not a crash
  assert.deepEqual(sweepProduced(path.join(dir, "nope"), { since: 0 }),
    { offers: [], refused: [] });
});

test("the refusal sentence is one short message, never a wall of them", () => {
  assert.equal(describeRefusals([]), undefined, "silence when there is nothing to admit");
  const one = describeRefusals([{ name: "a.bin", why: "too big" }])!;
  assert.ok(one.startsWith("One file"), one);
  const many = describeRefusals(
    Array.from({ length: 7 }, (_, i) => ({ name: `f${i}`, why: `reason ${i}` })))!;
  assert.ok(many.includes("7 files"), many);
  assert.equal(many.split("\n").length, 5, `header + 3 reasons + the count: ${many}`);
  assert.ok(many.includes("and 4 more"), many);
});
