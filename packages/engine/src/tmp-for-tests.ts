// A SCRATCH FOLDER THAT TAKES ITSELF AWAY AGAIN — for tests only.
//
// WHY THIS EXISTS. Forty-one test files made scratch folders with
// `fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-…"))` and only eight of them
// ever deleted one. On 2026-08-06 that had left **75,940** `cloud9-*` folders in
// this machine's temp directory, and the suite was adding a few hundred more
// every run. The tests then started failing on the clock — a repository turn
// runs a dozen or more git commands, and every one of them got slower as the
// folder they all live next to grew. Green one week, red the next, with nobody
// having changed a line of the code under test.
//
// WHY IT IS A HELPER AND NOT A RULE. "Remember to delete your temp folder" is
// exactly the kind of instruction that is followed eight times out of
// forty-one. So the deleting is not something a test has to remember: it is
// attached HERE, at the moment the folder is made, to the only function that
// makes one. A test written next year that calls `tempDir` cannot leave litter
// behind, because it is not the thing doing the cleaning up.
//
// WHEN IT RUNS. On the test process's own exit, in one sweep. `node --test`
// gives each test FILE its own process, so a suite's litter is gone the moment
// that file is done — it never has to survive until the end of the run. It is
// deliberately not `t.after`: a folder shared by several tests in a file (a git
// repository built once and reused) would be deleted underneath the tests still
// using it, and a test that fails halfway would skip its own cleanup precisely
// when it has made the most mess.
//
// IT CAN NEVER FAIL A TEST. Every delete is best-effort. A folder that Windows
// still has a handle open on is left where it is rather than turned into a red
// test — losing one folder is a much smaller problem than the one this fixes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** every scratch folder this process made, so the sweep at the end can find them */
const made = new Set<string>();
/** the exit sweep is attached once, however many folders get made */
let sweeping = false;

function sweepOnExit(): void {
  if (sweeping) return;
  sweeping = true;
  process.on("exit", () => {
    for (const dir of made) {
      // best effort, always: see the note above. `force` also covers the folder
      // that some earlier failure already removed.
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* leave it */ }
    }
    made.clear();
  });
}

/**
 * Make a throwaway folder under the system temp directory, and arrange for it
 * to be thrown away.
 *
 * Drop-in for `fs.mkdtempSync(path.join(os.tmpdir(), prefix))` — same argument,
 * same returned path — so a test that switches to it reads the same and behaves
 * the same, except that it no longer litters.
 */
export function tempDir(prefix: string): string {
  sweepOnExit();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(dir);
  return dir;
}
