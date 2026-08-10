const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
const store = fs.readFileSync(path.join(__dirname, "..", "src", "store.ts"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");

test("rich-link cards are server-projected and accessible/responsive", () => {
  assert.match(app, /findRichLinkRefs/);
  assert.match(app, /client\.askRichLinkPreviews/);
  assert.match(app, /aria-label=\"Linked Cloud9 items\"/);
  assert.match(app, /data-rich-kind=/);
  assert.match(store, /type: \"richLinkPreviews\"/);
  assert.match(store, /richLinkPreviews = \{\}/);
  assert.match(css, /\.rich-link-previews\{display:grid/);
  assert.match(css, /@media \(max-width:560px\)\{\.rich-link-previews/);
});

test("editing a message or losing access cannot leave stale rich cards", () => {
  assert.match(app, /deleted \|\| richRefs\.length === 0/);
  assert.match(app, /client\.clearRichLinkPreviews\(m\.id\)/);
  assert.match(store, /case "messageUpdated"[\s\S]*clearRichLinkPreviewsForMessage/);
  assert.match(store, /case "artifactUnavailable"[\s\S]*clearRichLinkPreviewsForRef\("artifact"/);
  assert.match(store, /case "agentDeleted"[\s\S]*forgetRunsOf\(frame\.agentId\)/);
  assert.match(store, /clearRichLinkPreviewsForAgent\(agentId\)/);
  assert.match(store, /case "projectForgotten"[\s\S]*clearRichLinkPreviewsForProject/);
  assert.match(store, /case "projectAccessRevoked"[\s\S]*clearRichLinkPreviewsForProject/);
  assert.match(store, /case "channelMembers"[\s\S]*clearRichLinkPreviewsForChannel/);
  assert.match(store, /case "task"[\s\S]*clearRichLinkPreviewsForRef\("task", frame\.task\.id\)/);
  assert.match(store, /case "run"[\s\S]*clearRichLinkPreviewsForRef\("run", frame\.record\.id\)/);
  assert.match(store, /case "forumTopic"[\s\S]*clearRichLinkPreviewsForRef\("decision", frame\.topic\.id\)/);
  assert.match(store, /case "forumChanged"[\s\S]*clearRichLinkPreviewsForRef\("decision", frame\.topic\.id\)/);
  assert.match(store, /case "forumUnavailable"[\s\S]*clearRichLinkPreviewsForRef\("decision", id\)/);
});
