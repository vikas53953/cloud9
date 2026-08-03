// ONE OWNER PER ANSWER. A message that names several agents used to start a
// turn on every one of them: three names, three separate answers, three
// subscriptions spent. Now the FIRST agent named takes the turn and the rest
// stay quiet — and because the rule reads only what every machine already has
// (the words typed, the mentions list, the shared agent roster), two people's
// engines reach the same answer without talking to each other.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentDef, Channel, Message } from "@cloud9/shared";
import { mentionOwner, passedOverByMention, shouldReply } from "./chatter.js";

const scout = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭",
  persona: "You research travel, villas, flights and hotels for trips",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
  createdAt: 0, ...over,
});
const architect = (over: Partial<AgentDef> = {}): AgentDef =>
  scout({ id: "a2", name: "Architect", persona: "You design systems and structures", ...over });
const chef = (over: Partial<AgentDef> = {}): AgentDef =>
  scout({ id: "a3", name: "Chef", persona: "You plan meals, recipes and food", ...over });

const room: Channel = {
  id: "c1", name: "trip", kind: "channel",
  memberIds: ["u1", "u2", "a1", "a2", "a3"], createdAt: 0,
};
const dm: Channel = { id: "d1", name: "dm", kind: "dm", memberIds: ["u1", "a1"], createdAt: 0 };

const said = (text: string, mentions?: string[]): Message => ({
  id: "m1", channelId: "c1", authorId: "u1", authorName: "Vikas",
  authorKind: "human", text, ts: Date.now(), mentions,
});

/** who actually takes a turn, asked the way the engine asks it: agent by agent */
const answering = (agents: AgentDef[], m: Message, channel = room): string[] =>
  agents.filter(a => shouldReply(a, m, channel, agents)).map(a => a.name);

test("two agents named: exactly one answers, and it is the first one named", () => {
  const agents = [scout(), architect()];
  const m = said("@Scout @Architect look at this", ["a1", "a2"]);
  assert.deepEqual(answering(agents, m), ["Scout"]);
});

test("the order typed decides, not the order of the roster", () => {
  const agents = [scout(), architect()];
  const m = said("@Architect @Scout look at this", ["a1", "a2"]);
  assert.deepEqual(answering(agents, m), ["Architect"]);
});

test("three agents named: still exactly one answer, still the first named", () => {
  const agents = [scout(), architect(), chef()];
  const m = said("@Chef @Scout @Architect what about dinner?", ["a1", "a2", "a3"]);
  assert.deepEqual(answering(agents, m), ["Chef"]);
});

test("one agent named: unchanged — it answers", () => {
  const agents = [scout(), architect()];
  assert.deepEqual(answering(agents, said("@Scout find villas", ["a1"])), ["Scout"]);
});

test("nobody named: free chatter still picks its single best-matching agent", () => {
  const agents = [scout(), architect(), chef()];
  assert.deepEqual(answering(agents, said("any good villas for the trip?")), ["Scout"]);
});

test("a DM is unchanged: the agent answers whether or not others are named", () => {
  const m: Message = { ...said("@Architect what do you think?", ["a2"]), channelId: "d1" };
  assert.equal(shouldReply(scout(), m, dm, [scout(), architect()]), true);
});

test("the passed-over agents are named, so a screen can say who else was asked", () => {
  const agents = [scout(), architect(), chef()];
  const m = said("@Scout @Architect @Chef thoughts?", ["a1", "a2", "a3"]);
  assert.equal(mentionOwner(m, room, agents), "a1");
  assert.deepEqual(passedOverByMention(m, room, agents), ["a2", "a3"]);
});

test("a paused agent cannot swallow the turn — the next one named takes it", () => {
  const agents = [scout({ lifecycle: "paused" }), architect()];
  const m = said("@Scout @Architect look at this", ["a1", "a2"]);
  assert.deepEqual(answering(agents, m), ["Architect"]);
});

test("agents on two different machines pick the same winner without coordination", () => {
  // Vikas's engine only ever drives Vikas's agent; his friend's engine only
  // ever drives the friend's. Neither can see the other's decision.
  const mine = scout();
  const theirs = architect({ ownerId: "u2", respondTo: "anyone" }); // shared into the room
  const roster = [mine, theirs]; // the hub sends the same roster to both engines
  const m = said("@Architect @Scout can you two look at this?", ["a1", "a2"]);

  const myEngineSays = shouldReply(mine, m, room, roster);       // my only agent
  const theirEngineSays = shouldReply(theirs, m, room, roster);  // their only agent

  assert.equal(myEngineSays, false, "my agent stays quiet — theirs was named first");
  assert.equal(theirEngineSays, true, "their agent takes the turn");
  assert.equal(
    Number(myEngineSays) + Number(theirEngineSays), 1,
    "exactly one turn across two machines that never spoke to each other",
  );
  // and both machines would name the same owner if asked directly
  assert.equal(mentionOwner(m, room, roster), mentionOwner(m, room, [...roster].reverse()));
});

test("nobody able to answer means nobody is falsely made the owner", () => {
  const m = said("@Scout hello", ["a1"]);
  assert.equal(mentionOwner(m, room, [scout({ lifecycle: "disabled" })]), undefined);
  assert.equal(mentionOwner(said("hello"), room, [scout()]), undefined);
});
