const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");

test("run cards expose the durable outcome as an accessible badge", () => {
  const app = read("App.tsx");
  const words = app.slice(app.indexOf("const RUN_OUTCOME_WORDS"), app.indexOf("function RunCard"));

  for (const outcome of ["ok", "failed", "cancelled", "refused"]) {
    assert.match(words, new RegExp(`${outcome}:`), `badge vocabulary must cover ${outcome}`);
  }
  assert.match(app, /data-outcome-badge=\{outcome\}/);
  assert.match(app, /role="status" aria-label=\{`Outcome: \$\{words\}`\}/);
  assert.match(app, /<RunOutcomeBadge outcome=\{record\.outcome\}/,
    "the badge must be derived from the stored RunRecord, not live UI state");
});

test("Stop is offered only after a live-step scope and never claims transport acceptance is stopping", () => {
  const app = read("App.tsx");
  const live = app.slice(app.indexOf("function LiveWork"), app.indexOf("function ResponsePreview"));

  assert.match(live, /stoppable: turnLifecycleStoppable\(\{ steps: evidence\.steps \}\)/,
    "only public live-step evidence may claim that a provider scope can stop");
  assert.doesNotMatch(live, /receipt\.stage === "thinking"/,
    "the early thinking receipt races live-turn scope registration");
  assert.match(live, /!terminal && row\.stoppable && <button/);
  assert.match(live, /text: `!stop \$\{row\.agentId\}`/,
    "Stop must use the exact stable-id stop command path");
  assert.doesNotMatch(live, /setStopping|stopping\.has|aria-busy/,
    "transport acceptance alone must not render a false Stopping state");
});

test("recovery actions are capability-gated and Continue is visibly unavailable without support", () => {
  const app = read("App.tsx");
  const recovery = app.slice(app.indexOf("function RunRecoveryCard"), app.indexOf("function TaskRun"));
  const css = read("styles.css");

  assert.match(recovery, /\{pending \? "Checking/);
  assert.match(recovery, /"Re-run"/);
  assert.match(recovery, /Continue\s*<\/button>/);
  assert.match(recovery, /client\.recoverRun\(record\.id, "retry"\)/);
  assert.match(recovery, /client\.recoverRun\(record\.id, "resume"\)/);
  assert.match(recovery, /const decisionUnavailable = !recovery/);
  assert.match(recovery, /const retryReason = retry\?\.reason/);
  assert.match(recovery, /const restartReason = restart\?\.reason/);
  assert.match(recovery, /title=\{retryReason\}/);
  assert.match(recovery, /title=\{restartReason\}/);
  assert.match(recovery, /Re-run and Restart need a provider safety check/,
    "missing relay decisions must explain why re-run/restart are not yet authorized");
  assert.match(recovery, /disabled=\{pending \|\| !canResume\}/);
  assert.match(recovery, /Continue unavailable:/,
    "unsupported continuation must be explicit rather than a fake enabled button");
  assert.match(css, /\.run-outcome-badge/);
  assert.match(css, /\.run-recovery-actions button:disabled/);
});
