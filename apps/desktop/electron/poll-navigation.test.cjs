const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("poll projections reject stale project frames and correlate list answers", () => {
  const store = fs.readFileSync(path.join(__dirname, "..", "src", "store.ts"), "utf8");
  const pollStart = store.indexOf('case "poll":');
  const pollEnd = store.indexOf('case "projectAccessRevoked"', pollStart);
  assert.ok(pollStart >= 0 && pollEnd > pollStart);
  const block = store.slice(pollStart, pollEnd);
  assert.match(block, /w\.polls\.projectId !== frame\.poll\.projectId/,
    "a live update from another project must not enter the active list");
  const listStart = store.indexOf('case "polls":');
  const listEnd = store.indexOf('case "poll":', listStart);
  assert.match(store.slice(listStart, listEnd), /frame\.requestId === undefined/,
    "an old or uncorrelated list answer must be ignored");
  assert.match(store, /case "projectAccessRevoked"/, "membership loss has a cache purge path");
  const leftStart = store.indexOf('case "channelLeft"');
  const leftEnd = store.indexOf('case "project"', leftStart);
  assert.match(store.slice(leftStart, leftEnd), /linkedProjectIds/,
    "leaving a room purges projects and their poll cache");
  const forgottenStart = store.indexOf('case "projectForgotten"');
  const forgottenEnd = store.indexOf('case "projectItems"', forgottenStart);
  assert.match(store.slice(forgottenStart, forgottenEnd), /w\.polls\.projectId === frame\.projectId/,
    "forgetting a project purges its active poll cache");
});

test("poll form has no impossible desktop agent-author selector and explains closure", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  const start = app.indexOf("function PollsScreen");
  const end = app.indexOf("function PollCard", start);
  assert.ok(start >= 0 && end > start);
  const screen = app.slice(start, end);
  assert.equal(screen.includes("authorAgentId"), false);
  assert.match(screen, /role="status">Loading polls…/);
  assert.match(screen, /Alternative \{i \+ 1\}/);
  assert.match(app, /poll\.decision\.reason/);
  assert.match(app, /poll\.decision\.closedAt/);
});

test("poll cards speak decision language from stored fields only", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  const start = app.indexOf("function PollCard");
  const end = app.indexOf("function CanvasScreen", start);
  assert.ok(start >= 0 && end > start);
  const card = app.slice(start, end);
  assert.match(card, /<h3>\{poll\.question\}<\/h3>/);
  assert.match(card, /<legend>Alternatives<\/legend>/);
  assert.match(card, /Participants ·/);
  assert.match(card, /Owner ·/);
  assert.match(card, /Chosen option ·/);
  assert.match(card, /poll\.createdAt/);
  assert.match(card, /studio-advanced/);
  assert.match(card, /pollChosenLabel/);
  assert.doesNotMatch(card, /Human\} · \{poll\.status\}/);
  assert.match(card, /poll\.status === "open" \? "Open" : "Closed"/);
  assert.doesNotMatch(card, /participantNames|fakeVoters|invented/);
  const helpers = app.slice(app.indexOf("function pollChosenLabel"), app.indexOf("function CopyTechnicalId"));
  assert.match(helpers, /poll\.myOptionId/);
  assert.doesNotMatch(helpers, /Math\.max|leading|winner/);
});
