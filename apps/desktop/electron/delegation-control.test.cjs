const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");

test("handoff control is an accessible, fact-first current-room chooser", () => {
  assert.match(app, /Hand this message to a room agent/);
  assert.match(app, /role="dialog" aria-modal="false"/);
  assert.match(app, /role="listbox" aria-label="Room agents"/);
  assert.match(app, /Permission: \{candidate\.permission\}/);
  assert.match(app, /Capabilities: \{candidate\.capabilities\}/);
  assert.match(app, /Availability: \{candidate\.availability\}/);
  assert.match(app, /mayDriveAgent\(me\.id, agent\)/);
  assert.match(app, /agent\.lifecycle === "paused"/);
  assert.match(app, /agent\.lifecycle === "disabled"/);
  assert.match(app, /sourceMessageId: m\.id, sourceThreadId: handSourceThreadId/);
  assert.match(app, /disabled=\{!handTargetCandidate\?\.allowed \|\| !connected\}/);
  assert.match(app, /Waiting for the relay to confirm this task/);
  assert.match(app, /client\.createHandoff\(/);
  assert.match(app, /handoff\?\.state === "lost"/);
  assert.match(app, /useClickAwayCloses\(handHoldRef, closeHand, handOpen\)/);
  assert.match(app, /aria-controls=\{`handoff-dialog-\$\{m\.id\}`\}/);
  assert.match(app, /Delegation status: \{handTask\.status/);
  assert.match(css, /\.handpop\{/);
  assert.match(css, /\.handagent:disabled/);
});

test("handoff is not offered for archived/deleted rows or without an authorized target", () => {
  assert.match(app, /const actions = deleted \|\| archived \? null/);
  assert.match(app, /!isAgent && mine && handAllowed/);
  assert.match(app, /const handAllowed = handCandidates\.some\(candidate => candidate\.allowed\)/);
  assert.match(app, /client\.createHandoff\(\{\s*type: "createTask"/s);
  assert.match(app, /const handRequestPending = handoff\?\.state === "pending"/);
});
