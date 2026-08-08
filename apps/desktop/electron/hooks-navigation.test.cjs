const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
const store = fs.readFileSync(path.join(__dirname, "..", "src", "store.ts"), "utf8");

test("Hooks rail/editor is owner-scoped, accessible, and has no shell field", () => {
  const surface = app.slice(app.indexOf("function HooksScreen"), app.indexOf("function SpendingScreen"));
  assert.match(app, /railBtn\("hooks", "Hooks"/);
  assert.match(surface, /role="status"/);
  assert.match(surface, /role="alert"/);
  assert.doesNotMatch(surface, /command|webhook|shell/i);
  assert.match(surface, /Test rule/);
});

test("Hooks store uses correlated request ids and CRUD actions", () => {
  assert.match(store, /askHooks/);
  assert.match(store, /requestId.*createHook/);
  assert.match(store, /case "hookTest"/);
});

test("Hooks keeps concurrent pending mutations and mirrors audit/delete pushes", () => {
  assert.match(store, /pending\?: Record<ID, true>/);
  assert.match(store, /frame\.requestId === undefined/);
  assert.match(store, /const pending = \{ \.\.\.w\.hooks\.pending \};/);
  assert.match(store, /mutationRequestId: Object\.keys\(pending\)\.at\(-1\)/);
  assert.match(store, /case "hookAudit"/);
  assert.match(store, /auditLoading/);
});

test("askHooks list settle preserves the prior hooks bag via keepHooksBag", () => {
  assert.match(store, /export function keepHooksBag/);
  const askStart = store.indexOf("askHooks(): void");
  const askEnd = store.indexOf("askHooksAudit(): void");
  const body = store.slice(askStart, askEnd);
  assert.match(body, /keepHooksBag\(this\.world\.hooks/);
  assert.match(body, /\.\.\.this\.world\.hooks/);
  assert.doesNotMatch(body, /this\.world\.hooks = \{ asked: true, list: f\.hooks \}/);
});
