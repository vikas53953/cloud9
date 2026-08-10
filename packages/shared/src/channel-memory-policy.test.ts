import test from "node:test";
import assert from "node:assert/strict";
import {
  channelMemoryMaySave, channelMemoryMayUse, defaultChannelMemoryMode,
  channelMemoryPolicyWords,
} from "./index.js";

test("channel memory defaults are conservative for DMs and preserve room explicit saves", () => {
  assert.equal(defaultChannelMemoryMode("dm"), "none");
  assert.equal(defaultChannelMemoryMode("channel"), "explicit");
  assert.equal(channelMemoryMaySave("none", "owner", "fact"), false);
  assert.equal(channelMemoryMaySave("explicit", "owner", "fact"), true);
  assert.equal(channelMemoryMaySave("explicit", "agent", "fact"), false);
  assert.equal(channelMemoryMaySave("summary", "agent", "decision"), true);
  assert.equal(channelMemoryMaySave("summary", "agent", "fact"), false);
});

test("policy wording names Cloud9 storage rather than model forgetting", () => {
  assert.match(channelMemoryPolicyWords("none"), /Cloud9 channel memory/i);
  assert.match(channelMemoryPolicyWords("none"), /model may still see/i);
  assert.match(channelMemoryPolicyWords("explicit"), /does not claim model-level forgetting/i);
  assert.equal(channelMemoryMayUse("none", { kind: "fact", channelId: "dm-1" } as never), false);
  assert.equal(channelMemoryMayUse("none", { kind: "fact" } as never), true,
    "global owner memory remains available in a No retention DM");
  assert.equal(channelMemoryMayUse("summary", { kind: "fact", channelId: "room-1" } as never), true);
});
