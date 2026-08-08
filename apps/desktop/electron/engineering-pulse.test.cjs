const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");

test("Engineering Pulse renders honest route states and navigable related links", () => {
  const app = read("App.tsx");
  assert.match(app, /function EngineeringPulseScreen/);
  assert.match(app, /Loading Engineering Pulse updates/);
  assert.match(app, /No updates yet/);
  assert.match(app, /role="alert"/);
  assert.match(app, /onOpenTask/);
  assert.match(app, /onOpenRun/);
  assert.match(app, /onOpenProject/);
  assert.match(app, /Open related task/);
  assert.match(app, /Open related run/);
  assert.match(app, /screen === "pulse"/);
});

test("Engineering Pulse draft settles only on its correlated mutation acknowledgement", () => {
  const app = read("App.tsx");
  const screen = app.slice(app.indexOf("function EngineeringPulseScreen"));
  assert.match(screen, /pendingSaveRequest/);
  assert.match(screen, /pendingDeleteRequest/);
  assert.match(screen, /world\.pulse\.mutationSuccessId/);
  assert.match(screen, /consumedPulseMutation/);
  assert.match(screen, /setDraft\(blankPulseDraft\(\)\)/);
  assert.doesNotMatch(screen, /pendingSave && !world\.pulse\.loading/);
});

test("Engineering Pulse relay client scopes mutation and read answers", () => {
  const store = read("store.ts");
  assert.match(store, /pulseMutationRequestId/);
  assert.match(store, /if \(this\.pulseMutationRequestId !== requestId\) return/);
  assert.match(store, /mutationSuccessId: requestId/);
  assert.match(store, /pulseReadRequests/);
  assert.match(store, /this\.pulseReadRequests\.delete\(frame\.requestId\)/);
  assert.match(store, /frame\.requestId !== w\.pulse\.requestId/);
  assert.match(store, /const mutationPending = this\.pulseMutationRequestId !== undefined/);
  assert.match(store, /loading: mutationPending \? w\.pulse\.loading : false/);
});

test("related project links preserve kind and number for exact item focus", () => {
  const app = read("App.tsx");
  assert.match(app, /focusProjectItem/);
  assert.match(app, /data-item=\{key\}/);
  assert.match(app, /onOpenProject\(update\.projectId, related\)/);
  assert.match(app, /setTab\(focusItem\.kind\)/);
});
