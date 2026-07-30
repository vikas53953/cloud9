// THE CLASS RULE: A WRITE THAT MIGHT NOT HAVE HAPPENED IS NEVER IGNORED.
//
// `writeWholeFile` never throws — that is deliberate, and it is only safe while
// every caller looks at what it returns. The moment one stops looking, a
// failure that used to be loud becomes silent: the app carries on, tells the
// owner the thing is saved, and he finds out days later that it never was. For
// this project that is the worse of the two failures. A failure he can see
// beats a failure he cannot.
//
// One caller getting this wrong was the finding. Every caller was in the same
// position, and every caller written tomorrow will be too — so this is not a
// review someone has to remember to do. It is a test that reads the source of
// this package and fails if a call site does neither of the two allowed things:
//
//   1. USE the answer (assign it, return it, branch on it), or
//   2. carry a `WRITE OUTCOME IGNORED:` line above it saying, in plain words,
//      why nobody needs telling about this particular failure.
//
// Put the bug back — delete the justification in `models.ts`, or drop the
// `const written =` in `runstore.ts` — and this test fails by name.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

/** The `src` folder, resolved from THIS FILE — never from where you stood. */
const srcDir = (): string => {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  return path.resolve(here, "..", "src");
};

/** The one owner of the write. Its own definition is not a call site. */
const OWNER_FILE = "wholefile.ts";
const JUSTIFICATION = "WRITE OUTCOME IGNORED:";
/** How far above a call the justification may sit, so a long comment still counts. */
const LOOK_BACK = 14;

interface CallSite { file: string; line: number; text: string; justified: boolean; used: boolean }

function callSites(): CallSite[] {
  const dir = srcDir();
  const out: CallSite[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name === OWNER_FILE) continue;
    const lines = fs.readFileSync(path.join(dir, name), "utf8").split(/\r?\n/);
    lines.forEach((raw, i) => {
      const text = raw.trim();
      if (!text.includes("writeWholeFile(")) return;
      if (text.startsWith("import") || text.startsWith("export {") || text.startsWith("*")
        || text.startsWith("//")) return;
      out.push({
        file: name,
        line: i + 1,
        text,
        // the answer is bound to something: `const ok =`, `return`, `if (!…`
        used: !text.startsWith("writeWholeFile("),
        justified: lines.slice(Math.max(0, i - LOOK_BACK), i).some(l => l.includes(JUSTIFICATION)),
      });
    });
  }
  return out;
}

test("every write in this package either acts on the answer or says why it need not", () => {
  const sites = callSites();
  // a rule that scans nothing passes for the wrong reason
  assert.ok(sites.length >= 3,
    `only found ${sites.length} call sites — this test is not looking where it thinks it is`);

  const silent = sites.filter(s => !s.used && !s.justified);
  assert.deepEqual(silent, [],
    "a write here can fail and this caller would never know. Either use the boolean it " +
    `returns, or write a "${JUSTIFICATION} <why>" comment above it:\n` +
    silent.map(s => `  ${s.file}:${s.line}  ${s.text}`).join("\n"));
});

test("the callers we know about are each accounted for, by name", () => {
  // Naming them is deliberate. If one disappears this test says so, rather than
  // quietly having nothing left to check.
  const byFile = new Map<string, CallSite[]>();
  for (const s of callSites()) {
    byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  }
  for (const file of ["engine.ts", "runstore.ts", "models.ts"]) {
    assert.ok(byFile.has(file), `${file} no longer writes anything — has the write moved?`);
  }
  // the run record and the schedules act on it; the model cache argues its case
  assert.ok(byFile.get("runstore.ts")!.every(s => s.used), "runstore must act on the answer");
  assert.ok(byFile.get("engine.ts")!.every(s => s.used), "engine must act on the answer");
  assert.ok(byFile.get("models.ts")!.every(s => s.used || s.justified),
    "the model cache must at least say why it does not care");
});

test("the justification has to be an actual sentence, not the marker on its own", () => {
  const dir = srcDir();
  let found = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    for (const line of fs.readFileSync(path.join(dir, name), "utf8").split(/\r?\n/)) {
      const at = line.indexOf(JUSTIFICATION);
      if (at < 0) continue;
      found++;
      assert.ok(line.slice(at + JUSTIFICATION.length).trim().length >= 20,
        `${name}: "${JUSTIFICATION}" with nothing after it is a way of ignoring the rule, ` +
        `not of satisfying it: ${line.trim()}`);
    }
  }
  assert.ok(found >= 1, "no justification found anywhere — is the marker still spelled the same?");
});
