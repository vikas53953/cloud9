// Recovery requests are renderer state, but their lifecycle rules are easiest
// to keep regression-safe without booting Electron: the source assertions below
// pin the correlated timeout/error/reconnect cleanup at the one send boundary.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "store.ts"), "utf8");

test("recovery starts every user action with a fresh server challenge", () => {
  const start = source.indexOf("recoverRun(runId");
  const end = source.indexOf("/** Select exactly two known run ids", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /const approvalEpoch = ""/);
  assert.match(body, /pending: false/);
  assert.match(body, /Cloud9 is reconnecting/);
  assert.match(body, /The relay did not answer/);
});

test("a repeated recovery action cannot reuse the prior challenge token", () => {
  const start = source.indexOf("recoverRun(runId");
  const end = source.indexOf("/** Select exactly two known run ids", start);
  const body = source.slice(start, end);
  // The second click spreads the old decision, so the token must be explicitly
  // cleared before the fresh request is sent.
  assert.match(body, /requestId, mode, authorizationToken: undefined, pending: true/);

  const runStart = source.indexOf('case "runRecovery"');
  const runEnd = source.indexOf('case "runComparison"', runStart);
  const runBody = source.slice(runStart, runEnd);
  // A terminal response (including an approval/refusal) must not fall back to
  // the previous token, or the next challenge would be suppressed as stale.
  assert.match(runBody, /authorizationToken: frame\.decision\.authorizationToken/);
  assert.doesNotMatch(runBody, /authorizationToken: frame\.decision\.authorizationToken \?\? held/);
});

test("generic refusals and challenge resend settle the correlated request", () => {
  const errorStart = source.indexOf('case "error"');
  const runStart = source.indexOf('case "runRecovery"');
  assert.ok(errorStart >= 0 && runStart > errorStart);
  const errorBody = source.slice(errorStart, runStart);
  assert.match(errorBody, /held\.requestId === frame\.requestId/);
  assert.match(errorBody, /this\.recoveryTimers\.delete\(frame\.requestId\)/);
  assert.match(errorBody, /pending: false, problem: frame\.error/);

  const runEnd = source.indexOf('case "runComparison"', runStart);
  const runBody = source.slice(runStart, runEnd);
  assert.match(runBody, /const resent = this\.send/);
  assert.match(runBody, /resent === undefined/);
  assert.match(runBody, /Cloud9 is reconnecting/);
  assert.match(runBody, /this\.recoveryTimers\.delete\(requestId\)/);
});

test("reconnect clears stale recovery decisions and timers", () => {
  const welcomeStart = source.indexOf('case "welcome"');
  const welcomeEnd = source.indexOf('case "error"', welcomeStart);
  assert.ok(welcomeStart >= 0 && welcomeEnd > welcomeStart);
  const body = source.slice(welcomeStart, welcomeEnd);
  assert.match(body, /w\.runRecovery = \{\}/);
  assert.match(body, /for \(const timer of this\.recoveryTimers\.values\(\)\) clearTimeout/);
  assert.match(body, /this\.recoveryTimers\.clear\(\)/);
});

test("comparison send failure, timeout, and reconnect leave an honest retry", () => {
  const start = source.indexOf("compareRuns(leftRunId");
  const end = source.indexOf("runComparison(leftRunId", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /try \{/);
  assert.match(body, /sent = undefined/);
  assert.match(body, /Cloud9 could not send the comparison/);
  assert.match(body, /The relay did not answer\. Try comparing again/);
  assert.match(body, /this\.comparisonRequests\.delete\(requestId\)/);
});
