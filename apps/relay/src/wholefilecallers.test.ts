// THE CLASS RULE, OUTSIDE THE ENGINE: NOTHING THIS APP LATER BELIEVES IS
// WRITTEN WITH A PLAIN `writeFileSync`.
//
// `packages/engine` already has this rule and a test that enforces it
// (`writeoutcome.test.ts`). It stopped at the engine's own front door, and four
// writes outside it went on being torn-able: an attachment's bytes here in the
// hub, and this install's private key, his settings and his saved Claude/Codex
// sign-ins in the desktop's main process.
//
// A rule that only covers the folder it was written in is not a class fix, it
// is a case fix with a wider comment. So this test reads the SOURCE of both of
// those folders and fails if:
//
//   1. a plain `fs.writeFileSync` / `appendFile` / `createWriteStream` appears
//      in a file this app ships, or
//   2. a whole-file write is made and its answer is neither used nor excused.
//
// Put either bug back — swap one call for `fs.writeFileSync`, or drop the
// `const ok =` in front of it — and this test names the file and the line.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** Resolved from THIS FILE, never from where you happened to be standing. */
function here(): string {
  return path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
}

/** The two folders that were left outside the rule, and the files they ship. */
function shippedFiles(): { label: string; file: string; text: string }[] {
  const dist = here(); // apps/relay/dist when compiled
  const folders: { label: string; dir: string; ext: string }[] = [
    { label: "apps/relay/src", dir: path.resolve(dist, "..", "src"), ext: ".ts" },
    {
      label: "apps/desktop/electron",
      dir: path.resolve(dist, "..", "..", "desktop", "electron"),
      ext: ".cjs",
    },
  ];
  const out: { label: string; file: string; text: string }[] = [];
  for (const f of folders) {
    // A folder that has moved must be a loud failure, never quietly nothing to check.
    assert.ok(fs.existsSync(f.dir), `${f.label} is not where this test thinks it is (${f.dir})`);
    for (const name of fs.readdirSync(f.dir)) {
      if (!name.endsWith(f.ext)) continue;
      if (name.endsWith(`.test${f.ext}`)) continue;
      out.push({
        label: `${f.label}/${name}`,
        file: path.join(f.dir, name),
        text: fs.readFileSync(path.join(f.dir, name), "utf8"),
      });
    }
  }
  return out;
}

/** The whole family. Any one of them can leave half a file under a real name. */
const RAW_WRITES = [
  "writeFileSync(", "writeFile(", "appendFileSync(", "appendFile(", "createWriteStream(",
];
const RAW_EXCUSE = "RAW WRITE ALLOWED:";
const OUTCOME_EXCUSE = "WRITE OUTCOME IGNORED:";
/** How far above a call the excuse may sit, so a long explanation still counts. */
const LOOK_BACK = 14;

function isComment(text: string): boolean {
  return text.startsWith("//") || text.startsWith("*") || text.startsWith("/*");
}

test("no file the hub or the app shell ships is written with a plain, tearable write", () => {
  const files = shippedFiles();
  assert.ok(files.length >= 6, `only found ${files.length} files — this test is looking in the wrong place`);
  assert.ok(files.some(f => f.label.endsWith("store.ts")), "the hub's store.ts is not being read");
  assert.ok(files.some(f => f.label.endsWith("main.cjs")), "the app shell's main.cjs is not being read");

  const raw: string[] = [];
  for (const f of files) {
    const lines = f.text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const text = line.trim();
      if (isComment(text)) return;
      // `writeWholeFile(` and `writeFileWhole(` contain none of these; a bare
      // `fs.`-qualified call does.
      if (!RAW_WRITES.some(w => text.includes(`fs.${w}`) || text.includes(`fsp.${w}`))) return;
      const excused = lines.slice(Math.max(0, i - LOOK_BACK), i).some(l => l.includes(RAW_EXCUSE));
      if (!excused) raw.push(`  ${f.label}:${i + 1}  ${text}`);
    });
  }

  assert.deepEqual(raw, [],
    "these writes can leave HALF A FILE under a name this app later trusts. Send them " +
    `through the whole-file rule, or write a "${RAW_EXCUSE} <why a torn file genuinely ` +
    `does not matter here>" comment above:\n${raw.join("\n")}`);
});

test("every whole-file write out here acts on the answer, or says why it need not", () => {
  const sites: { where: string; text: string; used: boolean; excused: boolean }[] = [];
  for (const f of shippedFiles()) {
    const lines = f.text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const text = line.trim();
      if (isComment(text) || text.startsWith("import") || text.startsWith("export {")) return;
      if (!text.includes("writeWholeFile(") && !text.includes("writeFileWhole(")) return;
      sites.push({
        where: `${f.label}:${i + 1}`,
        text,
        // bound to something: `const ok =`, `return …`, `if (!…`
        used: !text.startsWith("writeWholeFile(") && !text.startsWith("writeFileWhole("),
        excused: lines.slice(Math.max(0, i - LOOK_BACK), i).some(l => l.includes(OUTCOME_EXCUSE)),
      });
    });
  }

  // A rule that scans nothing passes for the wrong reason.
  assert.ok(sites.length >= 4,
    `only found ${sites.length} whole-file writes out here — have they moved?`);

  const silent = sites.filter(s => !s.used && !s.excused);
  assert.deepEqual(silent, [],
    "a write here can fail and this caller would never know — that is how the app came to " +
    'say "Scheduled!" about a save that never happened. Either use the boolean it returns, ' +
    `or write a "${OUTCOME_EXCUSE} <why>" comment above it:\n` +
    silent.map(s => `  ${s.where}  ${s.text}`).join("\n"));
});

test("the writes this round moved are each still accounted for, by name", () => {
  // Naming them is deliberate. If one disappears this test says so, rather than
  // quietly having nothing left to check.
  const byLabel = new Map(shippedFiles().map(f => [f.label, f.text]));
  const store = byLabel.get("apps/relay/src/store.ts");
  const main = byLabel.get("apps/desktop/electron/main.cjs");
  assert.ok(store, "the hub's store.ts is gone");
  assert.ok(main, "the app shell's main.cjs is gone");

  assert.match(store!, /writeWholeFile\(path\.join\(this\.attachmentsDir/,
    "the attachment bytes are no longer written through the whole-file rule");
  assert.match(store!, /sweepPending\(this\.attachmentsDir\)/,
    "nothing sweeps the litter of an interrupted upload any more");

  for (const [what, needle] of [
    ["the private key", /writeFileWhole\(ownerTokenPath\(\)/],
    ["his settings", /writeFileWhole\(settingsPath\(\)/],
    ["the saved sign-ins", /writeFileWhole\(secretPath\(harness\)/],
    // review 2026-08-04 C2: the hub sign-in moved OUT of the browser's storage
    // and into this process, encrypted — so it is now one of these writes too
    ["the hub sign-in", /writeFileWhole\(sessionTokenPath\(\)/],
  ] as [string, RegExp][]) {
    assert.match(main!, needle, `${what} is no longer written through the whole-file rule`);
  }

  // The permission must be asked for on the two secret files, not applied after
  // the rename — a key that was briefly world-readable has already leaked.
  const modeAsks = (main!.match(/mode: 0o600/g) ?? []).length;
  assert.equal(modeAsks, 3, "all three secret files must still ask for owner-only permission");

  // And the app shell must reach the ONE owner rather than keep a copy of it.
  assert.match(main!, /await import\("@cloud9\/engine"\)/,
    "main.cjs is no longer loading the shared safe-write rule — is there a second copy now?");
});
