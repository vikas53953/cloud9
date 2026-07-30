// THE HUB'S HALF OF THE SEARCH DOORWAY (docs/qa/gap-audit.md §3, finding 4 of
// "if you fix five things").
//
// Full-text search over every message has been built, indexed and answering on
// the hub for a long time. No agent could reach it, and no agent was even told
// it existed. The doorway is now open — `packages/engine/src/cloud9tools.ts` —
// and the law on it is:
//
//     AN AGENT MAY SEARCH ONLY THE CONVERSATION IT IS TAKING A TURN IN.
//
// The engine enforces that on its side by never letting the scope be an argument
// the model can reach. This file proves the OTHER side: the hub, which does not
// trust the engine, will not widen a search either. Two enforcement points, and
// neither is the only one.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { Channel, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

async function stand(t: TestContext) {
  const relay = new Relay({ dbPath: tmp("agent-search"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const owner = new TestClient(`ws://127.0.0.1:${port}`, "tok-owner");
  // an ENGINE connection, which is the client an agent's search really arrives on
  const engine = new TestClient(`ws://127.0.0.1:${port}`, "tok-owner", "engine");
  t.after(() => { owner.close(); engine.close(); relay.close(); });
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  await engine.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return {
    relay, owner, engine, port,
    general: welcome.state.channels.find(c => c.name === "general")!,
  };
}

async function room(owner: TestClient, name: string): Promise<Channel> {
  owner.send({ type: "createChannel", name, memberIds: [], kind: "channel" });
  const f = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    g => g.type === "channel" && g.channel.name === name);
  return f.channel;
}

async function say(owner: TestClient, channelId: string, text: string): Promise<void> {
  owner.send({ type: "send", channelId, text });
  await owner.wait(f => f.type === "message" && f.message.text === text);
}

test("an agent's search is answered — the doorway really opens", async (t) => {
  const { owner, engine, general } = await stand(t);
  await say(owner, general.id, "the file is already on disk at report.md");
  await say(owner, general.id, "chit-chat number 32");

  engine.frames.length = 0;
  engine.send({ type: "search", channelId: general.id, query: "report.md", limit: 20 });
  const hits = await engine.wait<Extract<ServerFrame, { type: "searchResults" }>>(
    f => f.type === "searchResults");
  assert.ok(hits.results.length >= 1, "the hub answered an agent's search with nothing");
  assert.match(hits.results[0].message.text, /already on disk/);
});

test("a search scoped to one conversation returns nothing from any other", async (t) => {
  const { owner, engine, general } = await stand(t);
  const hr = await room(owner, "hr-private");
  await say(owner, general.id, "villa in Goa, 40k a night");
  await say(owner, hr.id, "villa payroll review, confidential");

  engine.frames.length = 0;
  engine.send({ type: "search", channelId: general.id, query: "villa", limit: 20 });
  const hits = await engine.wait<Extract<ServerFrame, { type: "searchResults" }>>(
    f => f.type === "searchResults");
  assert.ok(hits.results.length > 0, "the search found nothing at all, so it proves nothing");
  for (const hit of hits.results) {
    assert.equal(hit.message.channelId, general.id,
      `a search of one conversation returned a message from ${hit.channelName}`);
    assert.doesNotMatch(hit.message.text, /confidential/);
  }
});

test("a search from an engine cannot reach a conversation its owner is not in", async (t) => {
  const { relay, owner, engine, port } = await stand(t);
  // a friend, with a room of their own that Vikas is not in
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = new TestClient(`ws://127.0.0.1:${port}`, `invite:${inv.code}:Priya`);
  t.after(() => friend.close());
  await friend.wait(f => f.type === "welcome");
  const theirs = await room(friend, "priya-notes");
  await say(friend, theirs.id, "villa deposit paid");

  engine.frames.length = 0;
  engine.send({ type: "search", channelId: theirs.id, query: "villa", limit: 20 });
  const err = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  // and it is a plain sentence, not a stack prefix — refusal.ts owns that too
  assert.doesNotMatch(err.error, /^Error:/i);
  assert.equal(relay.store.history(theirs.id, {}, 50).items.length, 1,
    "the room really does hold the message the search must not have reached");
});
