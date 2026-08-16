const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");

test("command center exposes explicit server-fact filters", () => {
  for (const label of ["Mine", "Waiting for me", "Failed", "Completed"]) assert.match(app, new RegExp(label));
  assert.match(app, /taskMatchesCommandCenterFilter/);
  assert.match(app, /Command center filters/);
  assert.match(app, /Cloud9 is offline/);
});

test("activity trail answers who, where, and what happened without dumping logs", () => {
  const screen = app.slice(app.indexOf("function ActivityScreen"), app.indexOf("const blankPulseDraft"));
  assert.match(screen, /function ActivityTrailRow/);
  assert.match(screen, /linkActivityRow/);
  assert.match(screen, /activityKindWords/);
  assert.match(screen, /activityOutcomeChips/);
  assert.match(screen, /Commands, logs, and files/);
  assert.match(screen, /quoteOf\(step\.detail, ACTIVITY_STEP_PREVIEW\)/);
  assert.match(screen, /testFactsFromSteps/);
  assert.doesNotMatch(screen, /function RunSteps/);
  assert.match(css, /\.act-facts/);
  assert.match(css, /\.act-inspect/);
  assert.match(css, /\.act-clip\{[^}]*max-height/);
});

test("Ctrl-K launcher is keyboard and pointer accessible with durable actions", () => {
  assert.match(app, /function CommandLauncher/);
  assert.match(app, /role="dialog" aria-modal="true" aria-label="Command launcher"/);
  assert.match(app, /role="listbox" aria-label="Available commands"/);
  assert.match(app, /Jump to/);
  assert.match(app, /Open source/);
  assert.match(app, /Search everywhere/);
  assert.match(app, /onToggleMute/);
  assert.match(app, /client\.markRead/);
  assert.match(app, /setLauncherOpen\(open => !open\)/);
  assert.match(css, /\.command-launcher-veil/);
  assert.match(css, /@media \(max-width:320px\)/);
});
