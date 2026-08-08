const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
const store = fs.readFileSync(path.join(__dirname, "..", "src", "store.ts"), "utf8");
const shared = fs.readFileSync(path.join(__dirname, "..", "..", "..", "packages", "shared", "src", "index.ts"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");

test("Canvas desktop surface is human-authored and accessible", () => {
  const canvas = app.slice(app.indexOf("function CanvasScreen"), app.indexOf("/* ================= 6b"));
  assert.doesNotMatch(canvas, /authorAgentId|<span>Author<\/span>/);
  assert.match(canvas, /role="status">Loading canvases/);
  assert.match(canvas, /role="alert"/);
  assert.match(canvas, /linkUnavailable/);
  assert.match(canvas, /Open linked/);
  assert.match(canvas, /onOpenLink/);
  assert.match(canvas, /Saving Canvas change/);
  assert.match(css, /@media \(max-width:720px\).*canvas-layout/);
});

test("Canvas clients correlate list/history and purge access revocations", () => {
  assert.match(store, /requestId.*canvases/);
  assert.match(store, /historyRequestId/);
  assert.match(store, /projectAccessRevoked/);
  assert.match(shared, /expectedRevision/);
  assert.match(shared, /linkUnavailable/);
  assert.match(store, /mutationRequestId/);
});

test("Canvas reuses openAt navigation and parks beside peer rails", () => {
  assert.match(app, /openCanvasLink/);
  assert.match(app, /setTaskOpenAt/);
  assert.match(app, /setProjectOpenAt/);
  assert.match(app, /setRunOpenAt/);
  assert.doesNotMatch(app, /taskFocusId|runFocusId|projectFocus/);
  assert.match(app, /"canvas"/);
  assert.match(app, /railBtn\("canvas"/);
  assert.match(app, /railBtn\("forums"/);
  assert.match(app, /huddles|pulse|polls|hooks|social|forums/);
});

test("Canvas project projections redact per viewer on the hub", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "..", "relay", "src", "server.ts"), "utf8");
  const relayStore = fs.readFileSync(path.join(__dirname, "..", "..", "relay", "src", "store.ts"), "utf8");
  assert.match(server, /viewProject\(project, userId\)/);
  assert.match(server, /pushCanvasProject/);
  // Forums owns step 10 on master; Canvas is SCHEMA_VERSION 11 after rebase.
  assert.match(relayStore, /export const SCHEMA_VERSION = 11/);
  assert.match(relayStore, /step\(10, \(\) => this\.addForumSchema\(\)\)/);
  assert.match(relayStore, /step\(11, \(\) => this\.addEngineeringCanvasSchema\(\)\)/);
  assert.match(relayStore, /DELETE FROM engineering_canvases/);
  assert.match(relayStore, /DELETE FROM forum_topics/);
  assert.match(store, /canvases\.projectId === frame\.projectId/);
});
