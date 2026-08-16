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
  assert.match(canvas, /History →/);
  assert.match(canvas, /canvasVersionLine/);
  assert.match(canvas, /canvasBlockKindLabel/);
  assert.match(canvas, /kept in History/);
  assert.match(canvas, /canvas-advanced/);
  assert.doesNotMatch(canvas, /Tombstoned block/);
  assert.doesNotMatch(canvas, /active blocks/);
  assert.doesNotMatch(canvas, /Revision \{canvas\.revision\}/);
  assert.doesNotMatch(canvas, /History \(recent 100\)/);
  assert.match(css, /@media \(max-width:720px\).*canvas-layout/);
});

test("Canvas room summary and helpers speak engineering language", () => {
  const helpers = app.slice(app.indexOf("const CANVAS_BLOCK_KINDS"), app.indexOf("function RoomCanvases"));
  assert.match(helpers, /Architecture/);
  assert.match(helpers, /Last updated by/);
  assert.match(helpers, /function canvasVersionLine/);
  assert.match(helpers, /function studioPersonName/);
  const room = app.slice(app.indexOf("function RoomCanvases"), app.indexOf("function RoomFiles"));
  assert.match(room, /canvasVersionLine\(canvas, world\.users, world\.agents\)/);
  assert.doesNotMatch(room, /active blocks/);
  assert.doesNotMatch(room, /Revision \{canvas\.revision\}/);
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
  assert.match(app, /toolBtn\("canvas"/);
  assert.match(app, /toolBtn\("forums"/);
  assert.match(app, /huddles|pulse|polls|hooks|social|forums/);
});

test("Canvas project projections redact per viewer on the hub", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "..", "relay", "src", "server.ts"), "utf8");
  const relayStore = fs.readFileSync(path.join(__dirname, "..", "..", "relay", "src", "store.ts"), "utf8");
  assert.match(server, /viewProject\(project, userId\)/);
  assert.match(server, /pushCanvasProject/);
  // Forums owns step 10, Canvas step 11, channel pins step 12, message
  // receipts step 13, durable composer drafts step 14, safe run recovery step
  // 15, and channel memory policy takes step 16.
  assert.match(relayStore, /CHANNEL_MEMORY_POLICY_SCHEMA_VERSION = 16/);
  assert.match(relayStore, /export const SCHEMA_VERSION = CHANNEL_MEMORY_POLICY_SCHEMA_VERSION/);
  assert.match(relayStore, /step\(10, \(\) => this\.addForumSchema\(\)\)/);
  assert.match(relayStore, /step\(11, \(\) => this\.addEngineeringCanvasSchema\(\)\)/);
  assert.match(relayStore, /step\(12, \(\) => this\.addChannelPinsSchema\(\)\)/);
  assert.match(relayStore, /step\(13, \(\) => this\.addMessageReceiptsSchema\(\)\)/);
  assert.match(relayStore, /step\(14, \(\) => this\.addChatDraftSchema\(\)\)/);
  assert.match(relayStore, /step\(15, \(\) => this\.addRunRecoverySchema\(\)\)/);
  assert.match(relayStore, /step\(CHANNEL_MEMORY_POLICY_SCHEMA_VERSION, \(\) => this\.addChannelMemoryPolicySchema\(\)\)/);
  assert.match(relayStore, /DELETE FROM engineering_canvases/);
  assert.match(relayStore, /DELETE FROM forum_topics/);
  assert.match(store, /canvases\.projectId === frame\.projectId/);
});
