const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
const store = fs.readFileSync(path.join(root, "src", "store.ts"), "utf8");

assert.match(app, /Turn into task/);
assert.match(app, /role="menuitem" className="task-action"/);
assert.match(app, /role="menuitem" className="task-inline-state" disabled/);
assert.match(app, /msg-more-menu[\s\S]*\{taskAction\}[\s\S]*\{taskUnavailable\}/);
assert.doesNotMatch(app, /task-affordance/,
  "Turn into task must be a More menuitem, not a permanent .task-affordance grid sibling");
assert.match(app, /Task owner/);
assert.match(app, /type="datetime-local"/);
assert.match(app, /sourceThreadId: m\.replyTo \?\? m\.id/);
assert.match(app, /!archived && channelId && availableTaskAgents\.length > 0/);
assert.match(app, /const taskAction = !deleted && !task/);
assert.match(app, /const taskUnavailable = !deleted && !task/);
assert.match(app, /!task && !isAgent && mine && !archived/);
assert.match(app, /mayDriveAgent\(me\.id, candidate\)/);
assert.match(app, /No available room agent can take this task right now/);
assert.match(app, /Task created/);
assert.match(app, /\{threadLine\}[\s\S]{0,80}\{taskComposer\}[\s\S]{0,40}\{taskCard\}/,
  "task composer/card render inside .body after threadLine");
assert.match(store, /createTaskFromMessage/);
assert.match(store, /taskMutations/);
assert.match(fs.readFileSync(path.join(root, "src", "turnlifecycle.ts"), "utf8"), /sort\(\(a, b\) => b\.updatedAt/);
assert.doesNotMatch(app, /taskRequestId/, "task creation must derive lifecycle from correlated store state");
assert.match(store, /case "welcome"[\s\S]*?w\.taskMutations = \{\}/);
assert.match(store, /ws\.onclose = \(\) => \{[\s\S]*?this\.world\.taskMutations = \{\}/,
  "disconnect starts a fresh task mutation epoch");
console.log("message-task desktop affordance checks passed");
