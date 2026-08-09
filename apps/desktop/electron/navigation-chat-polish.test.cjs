const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");

test("the permanent rail stays focused and the full feature set is grouped behind More", () => {
  const app = read("App.tsx");
  const nav = app.slice(app.indexOf('<nav className="rail"'), app.indexOf('<main className="stage">'));

  assert.match(nav, /className="rail-primary"/);
  assert.match(nav, /railBtn\("chat", "Chat"/);
  assert.match(nav, /railBtn\("tasks", "Tasks"/);
  assert.match(nav, /railBtn\("projects", "Projects"/);
  assert.match(nav, /railBtn\("activity", "Activity"/);
  assert.match(nav, /data-open-tools/);
  assert.match(nav, /aria-controls="cloud9-tools-drawer"/);
  assert.match(nav, /id="cloud9-tools-drawer"/);
  assert.match(nav, />Talk</);
  assert.match(nav, />Crew</);
  assert.match(nav, />Build</);
  assert.match(nav, />Automate & govern</);
  assert.match(nav, /toolBtn\("notifications", "Notifications"/);
  assert.match(nav, /toolBtn\("saved", "Saved for later"/);
  assert.match(nav, /toolBtn\("hooks", "Hooks"/);
  assert.match(nav, /toolBtn\("spending", "Spending"/);
  assert.match(nav, /railBtn\("settings", "Settings"/);
  assert.doesNotMatch(nav, /className="rail-group"/);
  assert.match(app, /const openPolls = useCallback\(\(\) => \{\s*attemptLeave\(\(\) => setScreen\("polls"\)\)/);
});

test("the new rail and tools drawer have explicit hierarchy and focus states", () => {
  const css = read("styles.css");
  assert.match(css, /--rail-bg:/);
  assert.match(css, /\.rail-tools-drawer/);
  assert.match(css, /\.tool-drawer-btn:focus-visible/);
  assert.match(css, /\.rail-btn:focus-visible/);
  assert.match(css, /@media \(max-height:/);
});

test("sending a message follows the newest content immediately", () => {
  const app = read("App.tsx");
  const follow = app.slice(app.indexOf("function useFollowToBottom"), app.indexOf("/* ================= the house marks"));
  assert.match(follow, /why === "sent" \? "auto"/);
  assert.match(follow, /el\.scrollTo\(\{ top: el\.scrollHeight, behavior \}\)/);
  assert.match(app, /messages\.at\(-1\)\?\.authorId === meId \? "sent" : "arrived"/);
  assert.match(app, /messages\.at\(-1\)\?\.authorId === world\.me\?\.id \? "sent" : "arrived"/);
  assert.match(follow, /const claimView = \(\): void => \{ following\.current = false; atBottom\.current = false/);
  assert.match(follow, /closest\("button,a,input,textarea,select"\)/);
});
