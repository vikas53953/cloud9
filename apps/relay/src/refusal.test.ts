// ONE OWNER FOR "NO" — the class fix behind §4.1 of `docs/qa/gap-audit.md`.
//
// What Vikas saw, photographed in `docs/qa/gap-audit-error-prefix.png`: he
// connected two repositories and gave both the same nickname, and the SAME
// refusal appeared twice on one screen in two different states of politeness —
// the toast said *you already have a project called "Audit Box" — give this one
// a different name*, and the line under the form said **Error:** followed by the
// same words.
//
// The cause was `send(ws, { type: "error", error: String(err) })` wrapping every
// request the hub handles. `String(err)` on an exception is `"Error: " + message`.
// And the leak was not limited to sentences somebody wrote: any unexpected bug
// on the hub went out of the same hole, so a raw `TypeError` was one mistake
// away from being printed under a form.
//
// Every test here failed before `refusal.ts` existed.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";
import { Refusal, refusalText, UNEXPECTED_REFUSAL } from "./refusal.js";

// ------------------------------------------------- the owner, on its own

test("a written refusal keeps its words and loses the prefix", () => {
  const said = 'you already have a project called "Audit Box" — give this one a different name';
  assert.equal(refusalText(new Error(said)), said);
  assert.equal(refusalText(new Refusal(said)), said);
  // the exact shape that reached his screen
  assert.equal(refusalText(new Error(`Error: ${said}`)), said);
});

test("no class name, no stack trace and no path ever reaches a screen", () => {
  const err = new TypeError("Cannot read properties of undefined (reading 'name')");
  const said = refusalText(err, "a test");
  assert.doesNotMatch(said, /TypeError|Error:/);
  // an unexpected failure is not shown its own words at all — it is replaced
  assert.equal(said, UNEXPECTED_REFUSAL);

  const withStack = new Error("something broke\n    at Store.saveProject (C:\\cloud9\\store.js:88:9)");
  assert.doesNotMatch(refusalText(withStack, "a test"), /at Store|store\.js/);

  const withPath = new Error("SQLITE_CORRUPT: cannot open C:\\Users\\Vikas\\AppData\\cloud9.db");
  assert.equal(refusalText(withPath, "a test"), UNEXPECTED_REFUSAL);

  // a bare error code is not English, however short it is
  for (const code of ["ENOENT", "ECONNRESET", "SQLITE_BUSY"]) {
    assert.equal(refusalText(new Error(code), "a test"), UNEXPECTED_REFUSAL);
  }
  // and something that is not an Error at all
  assert.equal(refusalText(42, "a test"), UNEXPECTED_REFUSAL);
  assert.equal(refusalText(undefined, "a test"), UNEXPECTED_REFUSAL);
});

test("the hub holds no second way of turning an exception into text", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const url = await import("node:url");
  // this file runs from `dist/`; the source it is about is next door in `src/`
  const dir = path.dirname(url.fileURLToPath(import.meta.url));
  const src = path.join(dir, "..", "src", "server.ts");
  const server = fs.readFileSync(src, "utf8");
  const leaks = server.split(/\r?\n/)
    .map((line, i) => ({ line, at: i + 1 }))
    .filter(({ line }) => /error:\s*String\(/.test(line) || /error:\s*\(err as Error\)/.test(line));
  assert.deepEqual(leaks, [],
    "an exception is being turned into screen text somewhere other than refusal.ts");
});

// ------------------------------------------------- and on the wire

async function stand(t: TestContext) {
  const relay = new Relay({ dbPath: tmp("refusal"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const owner = new TestClient(`ws://127.0.0.1:${port}`, "tok-owner");
  t.after(() => { owner.close(); relay.close(); });
  await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { relay, owner };
}

test("a real refusal off the hub arrives with no 'Error:' on the front", async (t) => {
  const { owner } = await stand(t);
  // the audit's own example: two projects, one nickname
  owner.send({ type: "connectProject", repo: "vikas53953/cloud9", name: "Audit Box" });
  await owner.wait<Extract<ServerFrame, { type: "project" }>>(f => f.type === "project");
  owner.frames.length = 0;

  owner.send({ type: "connectProject", repo: "vikas53953/other", name: "Audit Box" });
  const err = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.doesNotMatch(err.error, /^Error:/i,
    `the hub is still putting a class name in front of a refusal: ${err.error}`);
  assert.match(err.error, /already have a project called/);
});
