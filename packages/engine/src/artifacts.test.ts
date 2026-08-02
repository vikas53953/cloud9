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
import {
  CAPTURE_WORK_LIMIT_BYTES, SKIP_FOLDERS, SWEEP_DEFAULTS, describeRefusals, sweepProduced,
} from "./artifacts.js";

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
  // BREAK: drop the current-turn modified-time guard and this test fails with
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

test("a current private manifest attaches its note and exact typed links only to the matching file", () => {
  const dir = tmp();
  const since = Date.now();
  put(dir, "summary.pdf", "summary", since + 1000);
  put(dir, "figures.csv", "figures", since + 1100);
  put(dir, ".cloud9/artifact-links.json", JSON.stringify({
    files: [{
      name: "SUMMARY.pdf",
      note: "final figures",
      links: [
        { kind: "made-from", target: { artifactId: "af-123", version: 2 } },
        { kind: "goes-with", target: { artifactId: "af-456", version: 7 } },
      ],
    }],
  }), since + 1200);

  const sweep = sweepProduced(dir, { since });
  const byName = new Map(sweep.offers.map(file => [file.name, file]));
  const summary = byName.get("summary.pdf") as unknown as {
    note?: string;
    links?: { kind: string; target: { artifactId: string; version: number } }[];
  };
  const figures = byName.get("figures.csv") as unknown as { note?: string; links?: unknown[] };

  assert.equal(summary.note, "final figures");
  assert.deepEqual(summary.links, [
    { kind: "made-from", target: { artifactId: "af-123", version: 2 } },
    { kind: "goes-with", target: { artifactId: "af-456", version: 7 } },
  ], "targets stay pinned to the declared exact version");
  assert.equal(figures.note, undefined, "a row for another name cannot bleed onto this file");
  assert.equal(figures.links, undefined);
  assert.ok(!sweep.offers.some(file => file.name === "artifact-links.json"),
    "the private dot-folder manifest is never itself offered");
});

test("an old manifest is ignored before its contents are read", () => {
  const dir = tmp();
  const since = Date.now();
  put(dir, "summary.pdf", "summary", since + 1000);
  put(dir, ".cloud9/artifact-links.json", "{this old file is not even JSON", since - 1000);

  const sweep = sweepProduced(dir, { since });
  const summary = sweep.offers[0] as unknown as { note?: string; links?: unknown[] };

  assert.deepEqual(sweep.offers.map(file => file.name), ["summary.pdf"]);
  assert.equal(summary.note, undefined);
  assert.equal(summary.links, undefined);
  assert.deepEqual(sweep.refused, [],
    "stale private instructions are absence, not a current-turn failure");
});

test("bad current manifest data is refused in plain words and no part of it is guessed", () => {
  const dir = tmp();
  const since = Date.now();
  put(dir, "summary.pdf", "summary", since + 1000);
  put(dir, ".cloud9/artifact-links.json", JSON.stringify({
    files: [{
      name: "summary.pdf",
      note: "do not partly trust this",
      links: [{ kind: "made-from", target: { artifactId: "af-123", version: 0 } }],
    }],
  }), since + 1100);

  const sweep = sweepProduced(dir, { since });
  const summary = sweep.offers[0] as unknown as { note?: string; links?: unknown[] };

  assert.equal(summary.note, undefined, "one bad link invalidates the whole current manifest");
  assert.equal(summary.links, undefined);
  assert.equal(sweep.refused.length, 1);
  assert.equal(sweep.refused[0].name, "artifact-links.json");
  assert.match(sweep.refused[0].why, /did not add any file notes or links/i);
  assert.match(sweep.refused[0].why, /artifact-links\.json/i);
  assert.ok(!sweep.refused[0].why.includes("do not partly trust this"),
    "untrusted manifest contents are not repeated into chat");
  assert.ok(!/[A-Za-z]:\\/.test(sweep.refused[0].why), "no machine path leaves the engine");
});

test("the private manifest read is bounded at the shared byte limit", () => {
  const since = Date.now();
  const row = JSON.stringify({ files: [{ name: "report.md", note: "at the limit" }] });

  const exactDir = tmp();
  put(exactDir, "report.md", "report", since + 1000);
  put(exactDir, ".cloud9/artifact-links.json",
    row + " ".repeat(ARTIFACT_LIMITS.manifestBytes - Buffer.byteLength(row)), since + 1100);
  const exact = sweepProduced(exactDir, { since });
  assert.equal((exact.offers[0] as unknown as { note?: string }).note, "at the limit");
  assert.deepEqual(exact.refused, []);

  const overDir = tmp();
  put(overDir, "report.md", "report", since + 1000);
  put(overDir, ".cloud9/artifact-links.json",
    row + " ".repeat(ARTIFACT_LIMITS.manifestBytes + 1 - Buffer.byteLength(row)), since + 1100);
  const over = sweepProduced(overDir, { since });
  assert.equal((over.offers[0] as unknown as { note?: string }).note, undefined);
  assert.equal(over.refused.length, 1);
  assert.match(over.refused[0].why, /not valid/i);
  assert.ok(!over.refused[0].why.includes("at the limit"), "private contents stay private");
});

test("an ambiguous normalised name leaves every colliding file unannotated and says why once", () => {
  const dir = tmp();
  const since = Date.now();
  put(dir, "a b.txt", "one", since + 1000);
  put(dir, "a  b.txt", "two", since + 1100);
  put(dir, ".cloud9/artifact-links.json", JSON.stringify({
    files: [{ name: "A B.txt", note: "must not choose one by luck" }],
  }), since + 1200);

  const sweep = sweepProduced(dir, { since });
  const offers = sweep.offers as unknown as { name: string; note?: string; links?: unknown[] }[];

  assert.deepEqual(offers.map(file => file.name).sort(), ["a  b.txt", "a b.txt"]);
  assert.ok(offers.every(file => file.note === undefined && file.links === undefined),
    "one manifest row cannot annotate two different files");
  assert.equal(sweep.refused.length, 1, "one ambiguous key produces one refusal sentence");
  assert.match(sweep.refused[0].why, /more than one file/i);
  assert.match(sweep.refused[0].why, /rename/i);
  assert.ok(!/[A-Za-z]:\\/.test(sweep.refused[0].why), "no machine path leaves the engine");
});

test("no manifest leaves annotations absent from the existing produced-file result", () => {
  const dir = tmp();
  const since = Date.now();
  put(dir, "report.md", "report", since + 1000);

  const sweep = sweepProduced(dir, { since });
  const report = sweep.offers[0] as unknown as { note?: string; links?: unknown[] };

  assert.deepEqual(sweep.offers.map(file => file.name), ["report.md"]);
  assert.equal(report.note, undefined);
  assert.equal(report.links, undefined);
  assert.deepEqual(sweep.refused, []);
});

test("an offer is a pathless captured value whose bytes survive source mutation", () => {
  const dir = tmp();
  const since = Date.now();
  const full = put(dir, "captured.txt", "before!", since + 1000);

  const offer = sweepProduced(dir, { since }).offers[0] as unknown as {
    bytes?: Buffer; path?: string; state?: unknown; size: number;
  };
  fs.writeFileSync(full, "after!!");
  fs.utimesSync(full, new Date(since + 1000), new Date(since + 1000));

  assert.equal(offer.bytes?.toString("utf8"), "before!",
    "the offer owns the exact bytes captured before the rewrite");
  assert.equal(offer.size, offer.bytes?.length, "size derives from the captured value");
  assert.equal(offer.path, undefined, "nothing publishable may reopen a source path");
  assert.equal(offer.state, undefined, "publish-time metadata recipes are gone");
});

test("three failed captures backfill to ten successes within budget and leave true cap extras", () => {
  const dir = tmp();
  const since = Date.now();
  for (let i = 0; i < 15; i++) put(dir, `file-${i}.txt`, "x", since + 1000 + i);
  const fail = new Set(["file-14.txt", "file-13.txt", "file-12.txt"]);
  const attempted: string[] = [];

  const sweep = sweepProduced(dir, {
    since,
    captureWorkBytes: 13,
    capture: candidate => {
      attempted.push(candidate.name);
      return fail.has(candidate.name) ? undefined : Buffer.from(`captured:${candidate.name}`);
    },
  });

  assert.equal(sweep.offers.length, 10, "failed captures do not consume offer slots");
  assert.deepEqual(attempted, [
    "file-14.txt", "file-13.txt", "file-12.txt",
    "file-11.txt", "file-10.txt", "file-9.txt", "file-8.txt", "file-7.txt",
    "file-6.txt", "file-5.txt", "file-4.txt", "file-3.txt", "file-2.txt",
  ], "older candidates backfill until ten successful values use the exact work budget");
  assert.equal(sweep.refused.filter(row => /changed or could not be read/.test(row.why)).length, 3);
  assert.equal(sweep.refused.filter(row => /only the newest 10/.test(row.why)).length, 2,
    "files after ten successes are product-cap extras, not capture-safety refusals");
  assert.equal(sweep.refused.filter(row => /capture safety limit/.test(row.why)).length, 0);
  assert.deepEqual(sweep.offers.map(file => file.name), [
    "file-11.txt", "file-10.txt", "file-9.txt", "file-8.txt", "file-7.txt",
    "file-6.txt", "file-5.txt", "file-4.txt", "file-3.txt", "file-2.txt",
  ]);
});

test("capture work stops at the exact byte boundary and labels the untouched remainder safely", () => {
  const dir = tmp();
  const since = Date.now();
  for (let i = 0; i < 5; i++) put(dir, `candidate-${i}.bin`, Buffer.alloc(4), since + 1000 + i);
  const attempted: string[] = [];

  const sweep = sweepProduced(dir, {
    since,
    captureWorkBytes: 12,
    capture: candidate => {
      attempted.push(candidate.name);
      return undefined;
    },
  });

  assert.deepEqual(attempted, ["candidate-4.bin", "candidate-3.bin", "candidate-2.bin"],
    "three 4-byte attempts spend the 12-byte budget exactly; no fourth read starts");
  assert.equal(sweep.offers.length, 0);
  assert.equal(sweep.refused.filter(row => /changed or could not be read/.test(row.why)).length, 3);
  const untouched = sweep.refused.filter(row => /capture safety limit/.test(row.why));
  assert.deepEqual(untouched.map(row => row.name), ["candidate-1.bin", "candidate-0.bin"]);
  assert.ok(untouched.every(row => !/only the newest 10/.test(row.why)),
    "safety-limited candidates are never mislabeled as the ten-file product cap");
  const said = describeRefusals(sweep.refused)!;
  assert.ok(said.includes("capture safety limit"),
    "the distinct reason remains visible in the room even after earlier capture failures");
  assert.ok(!said.includes("same kind of reason"),
    "a mixed failure-and-safety summary does not falsely call every refusal the same");
});

test("exact 10 MB is captured, over-limit is refused before capture, and accepted bytes are bounded", () => {
  const since = Date.now();
  const exactDir = tmp();
  put(exactDir, "exact.bin", Buffer.alloc(ARTIFACT_LIMITS.bytes, 7), since + 1000);
  const exact = sweepProduced(exactDir, { since });
  assert.equal(exact.offers.length, 1);
  assert.equal(exact.offers[0].bytes.length, ARTIFACT_LIMITS.bytes);
  assert.equal(exact.offers[0].size, exact.offers[0].bytes.length);

  const overDir = tmp();
  const overPath = path.join(overDir, "over.bin");
  const fd = fs.openSync(overPath, "w");
  try { fs.ftruncateSync(fd, ARTIFACT_LIMITS.bytes + 1); } finally { fs.closeSync(fd); }
  fs.utimesSync(overPath, new Date(since + 1000), new Date(since + 1000));
  let captureCalls = 0;
  const over = sweepProduced(overDir, {
    since,
    capture: () => { captureCalls++; return Buffer.from("must not run"); },
  });
  assert.equal(captureCalls, 0, "an over-limit file is rejected from stat, never fully read");
  assert.equal(over.offers.length, 0);
  assert.equal(over.refused.length, 1);

  assert.equal(SWEEP_DEFAULTS.maxFiles * ARTIFACT_LIMITS.bytes, 100_000_000,
    "production can retain at most ten 10 MB captured values per turn");
  assert.equal(CAPTURE_WORK_LIMIT_BYTES, ARTIFACT_LIMITS.bytes * 20,
    "capture work has a separate engine-owned 200 MB ceiling with backfill headroom");
  const boundedDir = tmp();
  for (let i = 0; i < 5; i++) put(boundedDir, `tiny-${i}.txt`, "x", since + 1000 + i);
  const bounded = sweepProduced(boundedDir, {
    since, maxFiles: 2, maxBytes: 4, capture: () => Buffer.alloc(4),
  });
  assert.equal(bounded.offers.reduce((sum, file) => sum + file.bytes.length, 0), 8,
    "the same bound holds under lower injected limits");
});
