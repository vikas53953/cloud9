// DID IT REALLY DO WHAT IT SAID? — `verify.ts` held to its three promises.
//
//  1. IT CATCHES THE THING IT EXISTS FOR. An agent that says it edited a file,
//     ran the tests or pushed a branch, and did none of them, is caught — and
//     the owner is told in words he can act on.
//  2. IT NEVER ACCUSES ANYONE FALSELY. A plan, a suggestion, a question, a
//     failure the agent owned up to, a harness that reported nothing, a run
//     whose step list was cut short: none of these produce a mismatch. This
//     half of the suite is the larger half on purpose — one false accusation
//     costs more than ten missed checks.
//  3. IT DERIVES, IT NEVER ASKS. Every input is a recorded fact. There is no
//     model in this file and no way to add one without a new parameter.
import test from "node:test";
import assert from "node:assert/strict";
import type { RemoteActionFacts, RunStep } from "@cloud9/shared";
import { readClaims, verifyTurn, type VerifyInput } from "./verify.js";

let seq = 0;
const step = (kind: RunStep["kind"], label: string, detail?: string, ok?: boolean): RunStep => ({
  seq: ++seq, kind, label, ...(detail ? { detail } : {}), ...(ok === undefined ? {} : { ok }),
});

function input(over: Partial<VerifyInput> & { reply: string }): VerifyInput {
  seq = 0;
  return {
    ...over,
    record: {
      steps: [], events: 12, outcome: "ok", agentName: "Scout",
      ...(over.record ?? {}),
    },
  };
}

// ===================================================================
// 1. IT CATCHES THE THING IT EXISTS FOR
// ===================================================================

test("it said it edited a file, and no file was written — mismatch, in plain words", () => {
  const r = verifyTurn(input({
    reply: "I updated notes.md with the new plan.",
    record: { steps: [step("read", "Read notes.md", "notes.md")], events: 9, outcome: "ok" },
  }));
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.mismatches[0]?.kind, "wroteFile");
  assert.equal(r.mismatches[0]?.subject, "notes.md");
  assert.match(String(r.line), /Cloud9 checked what Scout just said/);
  assert.match(String(r.line), /no file was changed at all/);
});

test("it said it edited ONE file and wrote a DIFFERENT one — the owner is told which", () => {
  const r = verifyTurn(input({
    reply: "I updated config.json.",
    record: { steps: [step("write", "Wrote notes.md", "notes.md")], events: 9, outcome: "ok" },
  }));
  assert.equal(r.mismatches.length, 1);
  assert.match(String(r.mismatches[0]?.because), /notes\.md/);
});

test("it said the tests pass and no test command was run — mismatch", () => {
  const r = verifyTurn(input({
    reply: "Done — the tests pass.",
    record: { steps: [step("command", "Ran a command", "git status")], events: 9, outcome: "ok" },
  }));
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.mismatches[0]?.kind, "testsPass");
  assert.match(String(r.mismatches[0]?.because), /no test command was run/);
});

test("it said the tests pass and the test command FAILED — mismatch", () => {
  const r = verifyTurn(input({
    reply: "All tests passing now.",
    record: { steps: [step("command", "Ran a command", "npm test", false)], events: 9, outcome: "ok" },
  }));
  assert.equal(r.mismatches.length, 1);
  assert.match(String(r.mismatches[0]?.because), /reported a failure/);
});

test("it said it pushed and nothing left this computer — mismatch", () => {
  const r = verifyTurn(input({
    reply: "I pushed the branch.",
    remote: [], remoteKnown: true,
    record: { steps: [step("command", "Ran a command", "git commit")], events: 9, outcome: "ok" },
  }));
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.mismatches[0]?.kind, "leftThisComputer");
  assert.match(String(r.mismatches[0]?.because), /nothing left this computer/);
});

test("it said it opened a pull request when only a push was counted — the owner is told which", () => {
  const pushed: RemoteActionFacts = { action: "push", repo: "vikas/cloud9", branch: "c9/x", commits: 2 };
  const r = verifyTurn(input({
    reply: "I opened a pull request for you.",
    remote: [pushed], remoteKnown: true,
    record: { steps: [], events: 9, outcome: "ok" },
  }));
  assert.equal(r.mismatches.length, 1);
  // the words come from `describeRemoteAction` — the one owner, counted facts
  assert.match(String(r.mismatches[0]?.because), /push 2 commits to a new branch c9\/x/);
});

test("several mismatches are listed together, and the matches are counted", () => {
  const r = verifyTurn(input({
    reply: "I updated notes.md and the tests pass. I ran the build too.",
    record: {
      steps: [step("command", "Ran a command", "npm run build", true)],
      events: 20, outcome: "ok",
    },
  }));
  assert.equal(r.mismatches.length, 2, "the file and the tests");
  assert.match(String(r.line), /2 things do not match/);
  assert.match(String(r.line), /did match the record/);
});

test("a mismatch line quotes the agent's OWN words back", () => {
  const r = verifyTurn(input({
    reply: "I deleted the old runner.ts and everything is tidy now.",
    record: { steps: [], events: 5, outcome: "ok" },
  }));
  assert.match(String(r.line), /It said “I deleted the old runner\.ts/);
});

// ===================================================================
// 2. IT NEVER ACCUSES ANYONE FALSELY
// ===================================================================

test("a claim the record SUPPORTS produces no line at all", () => {
  const r = verifyTurn(input({
    reply: "I updated notes.md and the tests pass.",
    record: {
      steps: [
        step("write", "Wrote notes.md", "notes.md"),
        step("command", "Ran a command", "npm test", true),
      ],
      events: 20, outcome: "ok",
    },
  }));
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.line, undefined, "silence is the answer when everything checks out");
  assert.equal(r.claims.every(c => c.verdict === "matches"), true);
});

test("a PLAN is not a claim — “I'll update notes.md next” is never checked", () => {
  for (const reply of [
    "I'll update notes.md next.",
    "You could update notes.md yourself.",
    "The next step is to run the tests and make sure they pass.",
    "I would edit config.json, but I don't have permission.",
    "I couldn't update notes.md — the folder is read-only.",
    "Should I update notes.md?",
    "I did not run the tests.",
  ]) {
    const r = verifyTurn(input({ reply, record: { steps: [], events: 9, outcome: "ok" } }));
    assert.deepEqual(r.mismatches, [], `this must not be treated as a claim: ${reply}`);
  }
});

test("a harness that reported NOTHING can settle nothing — no accusation", () => {
  const r = verifyTurn(input({
    reply: "I updated notes.md and the tests pass.",
    record: { steps: [], events: 0, outcome: "ok" },
  }));
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.line, undefined);
  assert.equal(r.claims.length, 2);
  assert.equal(r.claims.every(c => c.verdict === "cannotCheck"), true);
  assert.match(String(r.claims[0]?.because), /did not report what it did/);
});

test("a run whose step list was CUT SHORT can settle nothing either", () => {
  const r = verifyTurn(input({
    reply: "I updated notes.md.",
    record: { steps: [step("read", "Read a file")], events: 900, outcome: "ok", truncated: true },
  }));
  assert.deepEqual(r.mismatches, []);
  assert.match(String(r.claims[0]?.because), /too much for Cloud9 to keep/);
});

test("a turn the owner STOPPED claims nothing", () => {
  const r = verifyTurn(input({
    reply: "I updated notes.md.",
    record: { steps: [], events: 9, outcome: "cancelled" },
  }));
  assert.deepEqual(r.mismatches, []);
  assert.match(String(r.claims[0]?.because), /stopped part-way/);
});

test("a remote claim is never settled when nobody supplied the counted facts", () => {
  const r = verifyTurn(input({
    reply: "I pushed the branch.",
    record: { steps: [], events: 9, outcome: "ok" },     // no `remoteKnown`
  }));
  assert.deepEqual(r.mismatches, []);
  assert.equal(r.claims[0]?.verdict, "cannotCheck");
});

test("a delete or a rename done by COMMAND still counts as changing the file", () => {
  const r = verifyTurn(input({
    reply: "I removed old-notes.md.",
    record: {
      steps: [step("command", "Ran a command", "rm old-notes.md", true)],
      events: 9, outcome: "ok",
    },
  }));
  assert.deepEqual(r.mismatches, []);
});

test("“test” inside a commit message is NOT a test run", () => {
  const r = verifyTurn(input({
    reply: "The tests pass.",
    record: {
      steps: [step("command", "Ran a command", 'git commit -m "add tests"', true)],
      events: 9, outcome: "ok",
    },
  }));
  assert.equal(r.mismatches.length, 1, "a commit that mentions tests is not a test run");
});

test("a reply that claims nothing checkable produces an empty report", () => {
  const r = verifyTurn(input({
    reply: "Sure — the config lives in the settings screen, under Agents.",
    record: { steps: [], events: 9, outcome: "ok" },
  }));
  assert.deepEqual(r.claims, []);
  assert.equal(r.line, undefined);
});

// ===================================================================
// READING THE CLAIMS — the extractor on its own
// ===================================================================

test("version numbers and abbreviations are not file names", () => {
  assert.deepEqual(readClaims("I updated it to 2.1 (i.e. the newer one)."), []);
});

test("the same file claimed twice is ONE claim", () => {
  const claims = readClaims("I updated notes.md. I also edited notes.md again.");
  assert.equal(claims.filter(c => c.kind === "wroteFile").length, 1);
});

test("a path is reduced to its file name, so any spelling of it matches the record", () => {
  const claims = readClaims("I edited `packages/engine/src/verify.ts` today.");
  assert.equal(claims[0]?.subject, "verify.ts");
});

test("“I ran the build” on a turn with no command at all is caught", () => {
  const r = verifyTurn(input({
    reply: "I ran the build for you.",
    record: { steps: [step("read", "Read a file")], events: 9, outcome: "ok" },
  }));
  assert.equal(r.mismatches.length, 1);
  assert.equal(r.mismatches[0]?.kind, "ranCommand");
});
