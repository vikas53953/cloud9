const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = path.resolve(__dirname, "../../..");
const app = fs.readFileSync(path.join(root, "apps/desktop/src/App.tsx"), "utf8");
const css = fs.readFileSync(path.join(root, "apps/desktop/src/styles.css"), "utf8");
const personalization = fs.readFileSync(path.join(root, "packages/shared/src/chat-personalization.ts"), "utf8");

test("settings exposes labeled chat personalization and per-channel notification controls", () => {
  for (const label of ["Chat font size", "Message density", "Timestamp style", "Avatar size", "Reset chat appearance"]) {
    assert.match(app, new RegExp(label.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")));
  }
  assert.match(app, /channel-notification-rules/);
  assert.match(app, /All messages/);
  assert.match(app, /Mentions only/);
  assert.match(app, />Off</);
  assert.match(app, /aria-label=\{`Notifications for/);
  assert.match(app, /Offline.*saved locally/);
});

test("main and thread chat carry semantic personalization classes and responsive bounds", () => {
  for (const name of ["chat-font-", "chat-density-", "chat-time-", "chat-avatar-"]) assert.match(app, new RegExp(name));
  assert.match(css, /\.chat-density-compact \.msg/);
  assert.match(css, /\.chat-avatar-large \.msg/);
  assert.match(css, /Large faces are 41px[\s\S]*\.chat-avatar-large \.msg\{grid-template-columns:46px/);
  assert.match(css, /@media \(max-width:320px\)/);
});

test("avatar setting reaches the actual face dimensions at every size", async () => {
  const messageRow = app.slice(app.indexOf("const MessageRow"), app.indexOf("/* ---- one thread"));
  assert.match(messageRow, /const avatarPx = chatAvatarSizePx\(chatPrefs\.avatarSize\)/);
  assert.match(messageRow, /<AgentFace name=\{m\.authorName\} size=\{avatarPx\}/);
  assert.match(messageRow, /<PersonFace name=\{m\.authorName\} size=\{avatarPx\}/);
  assert.match(messageRow, /chatAvatarSizePx\(chatPrefs\.avatarSize, 18\)/);
  assert.doesNotMatch(messageRow, /<(?:AgentFace|PersonFace) name=\{m\.authorName\} size=\{34\}/);
  assert.match(app, /<AgentFace name=\{peerAgent\.name\} size=\{chatAvatarSizePx\(chatPrefs\.avatarSize, 48\)\}/);
  const shared = await import(pathToFileURL(path.join(root, "packages/shared/dist/chat-personalization.js")));
  assert.deepEqual(["small", "medium", "large"].map(size =>
    shared.chatAvatarSizePx(size)), [27, 34, 41]);
});

test("channel muted markers explain whether mentions still get through", () => {
  const marker = app.slice(app.indexOf("function MutedMark"), app.indexOf("/* ==================== THE THREAD'S EDGE"));
  assert.match(marker, /channelNotificationModeWords\(mode\)/);
  assert.match(marker, /title=\{words\.markerTitle\}/);
  assert.match(marker, /aria-label=\{words\.markerAriaLabel\}/);
  assert.match(personalization, /Notifications off .*mentions do not get through/);
  assert.match(personalization, /Muted.*mentions still get through/);
});

test("local migration and connected-room cleanup are explicit", () => {
  assert.match(app, /normalizeChatPersonalization/);
  assert.match(app, /reconcileChannelNotificationPrefs/);
  assert.match(app, /if \(!world\.connected\) return/);
  assert.match(app, /prefs\.set\(\{\s*channelNotificationModes/);
});

test("pure channel rules reject stale legacy room state and preserve mention semantics", async () => {
  const shared = await import(pathToFileURL(path.join(root, "packages/shared/dist/chat-personalization.js")));
  const base = { mutedChannelIds: ["room-1"], channelNotificationModes: {} };
  assert.equal(shared.channelNotificationModeFor(base, "room-1"), "mentions");
  const off = shared.withChannelNotificationMode(base, "room-1", "off");
  assert.equal(shared.channelNotificationModeFor(off, "room-1"), "off");
  assert.deepEqual(shared.reconcileChannelNotificationPrefs(off, []), { ...off, channelNotificationModes: {}, mutedChannelIds: [] });
});
