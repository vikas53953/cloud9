import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CHAT_PERSONALIZATION,
  chatAvatarScale,
  chatAvatarSizePx,
  channelNotificationModeFor,
  channelNotificationModeWords,
  normalizeChatPersonalization,
  reconcileChannelNotificationPrefs,
  validateChatPersonalization,
  withChannelNotificationMode,
} from "./chat-personalization.js";

test("chat personalization has stable defaults and rejects malformed values", () => {
  assert.deepEqual(normalizeChatPersonalization({}), DEFAULT_CHAT_PERSONALIZATION);
  assert.equal(validateChatPersonalization(DEFAULT_CHAT_PERSONALIZATION), null);
  assert.equal(validateChatPersonalization({ ...DEFAULT_CHAT_PERSONALIZATION, fontSize: "huge" }),
    "fontSize must be small, medium, or large");
  assert.equal(normalizeChatPersonalization({ fontSize: "large", density: "compact", timestamp: "exact", avatarSize: "small" }).fontSize, "large");
});

test("avatar choices resolve to actual face dimensions, not wrapper-only scale", () => {
  assert.deepEqual(["small", "medium", "large"].map(size =>
    chatAvatarSizePx(size as "small" | "medium" | "large")), [27, 34, 41]);
  assert.deepEqual(["small", "medium", "large"].map(size =>
    chatAvatarSizePx(size as "small" | "medium" | "large", 48)), [38, 48, 58]);
  assert.equal(chatAvatarScale("small"), 0.8);
  assert.equal(chatAvatarScale("medium"), 1);
  assert.equal(chatAvatarScale("large"), 1.2);
});

test("channel rules support all, mentions, and off without inheriting a stale mute", () => {
  const base = { mutedChannelIds: ["room-1", "room-old"], channelNotificationModes: {} };
  assert.equal(channelNotificationModeFor(base, "room-1"), "mentions");
  const all = withChannelNotificationMode(base, "room-1", "all");
  assert.equal(channelNotificationModeFor(all, "room-1"), "all");
  assert(!all.mutedChannelIds.includes("room-1"));
  const off = withChannelNotificationMode(all, "room-1", "off");
  assert.equal(channelNotificationModeFor(off, "room-1"), "off");
  assert.equal(channelNotificationModeFor(off, "missing"), "all");
});

test("channel marker words distinguish mentions-only from fully off", () => {
  assert.deepEqual(channelNotificationModeWords("mentions"), {
    markerTitle: "Muted — only somebody mentioning you by name gets through",
    markerAriaLabel: "Muted; mentions still get through",
  });
  assert.deepEqual(channelNotificationModeWords("off"), {
    markerTitle: "Notifications off — no notifications from this channel; mentions do not get through",
    markerAriaLabel: "Notifications off; mentions do not get through",
  });
});

test("reconcile removes malformed and inaccessible channel rules", () => {
  const p = {
    channelNotificationModes: {
      "room-1": "off",
      "room-secret": "mentions",
      "": "all",
      "room-bad": "wat",
    },
    mutedChannelIds: ["room-1", "room-secret", "", "room-secret"],
  };
  const result = reconcileChannelNotificationPrefs(p, ["room-1"]);
  assert.deepEqual(result.channelNotificationModes, { "room-1": "off" });
  assert.deepEqual(result.mutedChannelIds, ["room-1"]);
});

test("channel preference bounds refuse prototype-shaped room ids", () => {
  const result = reconcileChannelNotificationPrefs({
    channelNotificationModes: { __proto__: "off", constructor: "mentions", "room-1": "all" },
    mutedChannelIds: ["__proto__", "constructor", "room-1"],
  }, ["__proto__", "constructor", "room-1"]);
  assert.deepEqual(result.channelNotificationModes, { "room-1": "all" });
  assert.deepEqual(result.mutedChannelIds, ["room-1"]);
});
