const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("Saved/Later screen has honest loading, tombstone, retry, and guarded source jump states", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  assert.match(app, /function SavedScreen/);
  assert.match(app, /Loading saved messages/);
  assert.match(app, /Nothing saved yet/);
  assert.match(app, /Reminder date \(no notification\)/);
  assert.match(app, /Save details/);
  assert.match(app, /Load more saved messages/);
  assert.match(app, /safeReminderDate/);
  assert.match(app, /aria-busy=\{savedPending\}/);
  assert.match(app, /world\.connected && !world\.savedAsked/);
  assert.match(app, /Source unavailable/);
  assert.match(app, /Try again/);
  const start = app.indexOf("screen === \"saved\"");
  const end = app.indexOf("screen === \"settings\"", start);
  assert.ok(start >= 0 && end > start, "saved route is present");
  const route = app.slice(start, end);
  assert.ok(route.indexOf("attemptLeave(() => {") >= 0, "source jumps use the leave guard");
  assert.ok(route.indexOf("setActiveId(entry.channelId)") > route.indexOf("attemptLeave(() => {"));
});

test("Saved/Later mutations use request correlation and scoped errors", () => {
  const store = fs.readFileSync(path.join(__dirname, "..", "src", "store.ts"), "utf8");
  assert.match(store, /Do not present a disconnected copy/);
  assert.match(store, /this\.savedRequests\.clear\(\)/);
  const start = store.indexOf("askSaved(");
  const end = store.indexOf("/* ---------------- search", start);
  assert.ok(start >= 0 && end > start, "saved request methods are present");
  const block = store.slice(start, end);
  assert.match(block, /f\.requestId === requestId/);
  assert.match(block, /savedRequests\.set\(requestId/);
  assert.match(block, /savedPending/);
  assert.match(block, /this\.world\.savedProblem = undefined/);
  assert.match(block, /savedProblem/);
  assert.match(block, /The relay did not answer/);
  assert.match(block, /saveForLater/);
  assert.match(block, /unsaveForLater/);
});

test("Saved/Later mutations remain honest offline and guard detail actions while pending", () => {
  const store = fs.readFileSync(path.join(__dirname, "..", "src", "store.ts"), "utf8");
  const send = store.slice(store.indexOf("private sendSaved("), store.indexOf("private finishSavedPending("));
  assert.match(send, /if \(!id\)/);
  assert.match(send, /Cloud9 is reconnecting\. Try again when the relay answers/);
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  const detail = app.slice(app.indexOf("function SavedScreen"), app.indexOf("function ActivityScreen"));
  assert.match(detail, /const pending = world\.savedPending\.includes\(entry\.messageId\)/);
  assert.match(detail, /Saving details/);
  assert.match(detail, /disabled=\{pending\}/);
  assert.match(detail, /Removing…/);
  assert.match(detail, /useUnsavedWork\("Saved message details", detailsDirty\)/);
  assert.match(detail, /reminderDateMs/);
  assert.match(detail, /Only a correlated success clears the draft/);
  assert.match(store, /requestId, messageId: frame\.messageId/);
  assert.match(store, /The relay did not answer/);
  assert.match(store, /const orphaned = this\.asked/);
  assert.match(store, /for \(const a of orphaned\) a\.lost\?\.\(\)/);
});
