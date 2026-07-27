import test from "node:test";
import assert from "node:assert/strict";
import { AgentDef, Channel, Message } from "@cloud9/shared";
import { isBraked, shouldReply, DEFAULT_BRAKE } from "./chatter.js";

const mk = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭",
  persona: "You research travel, villas, flights and hotels for trips",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
  createdAt: 0, ...over,
});

const chan: Channel = { id: "c1", name: "trip", kind: "channel", memberIds: ["u1", "a1", "a2"], createdAt: 0 };
const dm: Channel = { id: "d1", name: "dm", kind: "dm", memberIds: ["u1", "a1"], createdAt: 0 };

const msg = (over: Partial<Message>): Message => ({
  id: "m1", channelId: "c1", authorId: "u1", authorName: "Vikas",
  authorKind: "human", text: "hello", ts: Date.now(), ...over,
});

test("agent never replies to itself", () => {
  assert.equal(shouldReply(mk(), msg({ authorId: "a1", authorKind: "agent" }), chan, [mk()]), false);
});

test("agent replies in its DM", () => {
  assert.equal(shouldReply(mk(), msg({ channelId: "d1" }), dm, [mk()]), true);
});

test("agent replies when mentioned", () => {
  assert.equal(shouldReply(mk(), msg({ text: "@Scout find villas", mentions: ["a1"] }), chan, [mk()]), true);
});

test("mention directed elsewhere suppresses free chatter", () => {
  assert.equal(shouldReply(mk(), msg({ text: "@Chef plan food", mentions: ["a2"] }), chan, [mk()]), false);
});

test("most relevant agent chimes in on unmentioned human message", () => {
  const scout = mk();
  const chef = mk({ id: "a2", name: "Chef", persona: "You plan meals, recipes and food" });
  const m = msg({ text: "any good villas for the trip?" });
  assert.equal(shouldReply(scout, m, chan, [scout, chef]), true);
  assert.equal(shouldReply(chef, m, chan, [scout, chef]), false);
});

test("agent-to-agent needs a mention", () => {
  const scout = mk();
  const m = msg({ authorId: "a2", authorKind: "agent", text: "the villas look great" });
  assert.equal(shouldReply(scout, m, chan, [scout]), false);
  const m2 = msg({ authorId: "a2", authorKind: "agent", text: "@Scout check these villas", mentions: ["a1"] });
  assert.equal(shouldReply(scout, m2, chan, [scout]), true);
});

test("brake trips after 25 consecutive agent messages", () => {
  const history: Message[] = [];
  for (let i = 0; i < 24; i++) history.push(msg({ id: `m${i}`, authorKind: "agent", authorId: "a1" }));
  assert.equal(isBraked(history, DEFAULT_BRAKE), false);
  history.push(msg({ id: "m25", authorKind: "agent", authorId: "a2" }));
  assert.equal(isBraked(history, DEFAULT_BRAKE), true);
});

test("human message resets the consecutive count", () => {
  const history: Message[] = [];
  for (let i = 0; i < 30; i++) history.push(msg({ id: `m${i}`, authorKind: "agent", ts: Date.now() - 7200_000 }));
  history.push(msg({ id: "hx", authorKind: "human" }));
  assert.equal(isBraked(history, DEFAULT_BRAKE), false);
});

test("hourly cap trips independently", () => {
  const history: Message[] = [];
  for (let i = 0; i < 60; i++) {
    history.push(msg({ id: `m${i}`, authorKind: "agent" }));
    history.push(msg({ id: `h${i}`, authorKind: "human" })); // humans interleaved — consecutive never trips
  }
  assert.equal(isBraked(history, DEFAULT_BRAKE), true);
});
