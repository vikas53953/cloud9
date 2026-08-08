const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");

test("Engineering Pulse renders honest route states and navigable related links", () => {
  const app = read("App.tsx");
  assert.match(app, /function EngineeringPulseScreen/);
  assert.match(app, /Loading Engineering Pulse updates\.\.\./);
  assert.match(app, /Connecting to Cloud9\.\.\./);
  assert.match(app, /No updates yet/);
  assert.match(app, /role="alert"/);
  assert.match(app, /onOpenTask/);
  assert.match(app, /onOpenRun/);
  assert.match(app, /onOpenProject/);
  assert.match(app, /Open related task/);
  assert.match(app, /Open related run/);
  assert.match(app, /screen === "pulse"/);
  // B3: Pulse loading/status copy uses plain ASCII, not corrupted em-dash/ellipsis.
  const pulseScreen = app.slice(app.indexOf("function EngineeringPulseScreen"));
  assert.match(pulseScreen, /Connecting to Cloud9\.\.\./);
  assert.match(pulseScreen, /Loading Engineering Pulse updates\.\.\./);
  assert.match(pulseScreen, /Saving Engineering Pulse update\.\.\./);
  assert.match(pulseScreen, /Deleting Engineering Pulse update\.\.\./);
  assert.doesNotMatch(pulseScreen, /Connecting to Cloud9â/);
  assert.doesNotMatch(pulseScreen, /Loading Engineering Pulse updatesâ/);
  assert.doesNotMatch(pulseScreen, /Saving Engineering Pulse updateâ/);
  assert.doesNotMatch(pulseScreen, /Deleting Engineering Pulse updateâ/);
});

test("Engineering Pulse edit sends null to clear related links", () => {
  const app = read("App.tsx");
  const screen = app.slice(app.indexOf("function EngineeringPulseScreen"));
  assert.match(screen, /relatedTaskId: draft\.relatedTaskId \?\? null/);
  assert.match(screen, /relatedRunId: draft\.relatedRunId \?\? null/);
  assert.match(screen, /relatedProjectItem: draft\.relatedProjectItem \?\? null/);
  assert.match(screen, /relatedTaskId: e\.target\.value \|\| null/);
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
  // B2: client keeps null clear signals on related link keys the editor touched.
  assert.match(store, /if \("relatedTaskId" in patch\) safePatch\.relatedTaskId = patch\.relatedTaskId \?\? null/);
  // B3: Pulse lost strings use plain ASCII dashes, not mojibake.
  assert.match(store, /the hub did not answer - is it still running\?/);
  assert.doesNotMatch(store, /the hub did not answer â€/);
});

test("related project links preserve kind and number for exact item focus", () => {
  const app = read("App.tsx");
  // After social-feed keep-both, Pulse and Team feed share openAt navigation:
  // projectOpenAt carries itemKind + number, ProjectsScreen focuses that row.
  assert.match(app, /projectOpenAt/);
  assert.match(app, /itemKind: item\.kind, number: item\.number/);
  assert.match(app, /data-item=\{key\}/);
  assert.match(app, /onOpenProject\(update\.projectId, related\)/);
  assert.match(app, /setTab\(openItem\.kind\)/);
  assert.match(app, /setFocusItem\(\{ kind: openAt\.itemKind, number: openAt\.number, at: openAt\.at \}\)/);
});
