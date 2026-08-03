// WHAT IS STORED IS ALWAYS A WHOLE AGENT.
//
// THE BUG THIS FILE WAS WRITTEN FOR, and it was reproduced before it was fixed.
// The hub's `updateAgent` wrote whatever object arrived straight into the
// database. `validateAgentInput` did not stop it, because that function judges
// the fields that ARE there — a nonsense emoji, a model id with a `&&` in it —
// and says nothing about the fields that are missing. So a client that sent
//
//     { type: "updateAgent", agent: { id, name, ownerId } }
//
// — a stale screen, a half-built mobile client, anything — had that three-field
// stub ACCEPTED and SAVED over a complete agent. Its job description, its
// abilities and its emoji were gone from his database for good. The next screen
// that drew it ran `persona.trim()` on nothing and the window went white with
// *Cannot read properties of undefined (reading 'trim')*.
//
// THE CLASS RULE, and it is not a null-check at the crash site: an agent write
// is refused unless the record it would STORE is a whole agent. Every write
// goes through one gate — `validateAgentDefinition` in `@cloud9/shared`, asked
// about the finished record, not about the frame — so create and update cannot
// drift apart and a new write path cannot arrive without the check.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import { AgentDef, ServerFrame, validateAgentDefinition } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const WHOLE = {
  emoji: "🔭", persona: "You research travel, villas and flights",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
  provider: "claude" as const, model: "claude-sonnet-5",
};

async function stand(t: TestContext, name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const owner = new TestClient(`ws://127.0.0.1:${port}`, "tok-owner");
  t.after(() => { owner.close(); relay.close(); });
  await owner.wait(f => f.type === "welcome");
  owner.send({ type: "createAgent", agent: { ...WHOLE, name: "Scout" } });
  const made = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent");
  return { relay, owner, scout: made.agent };
}

/** Exactly what is on disk right now, as text — the thing that must not move. */
function storedText(relay: Relay, id: string): string {
  return JSON.stringify(relay.store.agents().find(a => a.id === id));
}

async function refusedAndUnchanged(
  relay: Relay, owner: TestClient, scout: AgentDef, frame: Parameters<TestClient["send"]>[0],
) {
  const before = storedText(relay, scout.id);
  owner.frames.length = 0;
  owner.send(frame);
  const err = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.equal(storedText(relay, scout.id), before,
    "a refused save must leave the stored agent exactly as it was");
  assert.equal(owner.frames.some(f => f.type === "agent"), false,
    "a refused save must not be broadcast as though it happened");
  return err.error;
}

// ---------------------------------------------------------------------------
// The bug itself
// ---------------------------------------------------------------------------

test("a half-written agent update is refused and nothing is stored", async t => {
  const { relay, owner, scout } = await stand(t, "whole-partial.db");
  // the exact frame that used to destroy an agent: id, name, owner, and nothing else
  const said = await refusedAndUnchanged(relay, owner, scout, {
    type: "updateAgent",
    agent: { id: scout.id, name: "Scout", ownerId: scout.ownerId } as never,
  });
  assert.match(said, /whole agent|part of/i, said);

  // and the agent a screen would draw is still whole — this is the white window
  const after = relay.store.agents().find(a => a.id === scout.id)!;
  assert.equal(typeof after.persona, "string");
  assert.equal(typeof after.emoji, "string");
  assert.equal(typeof after.abilities, "object");
});

test("every single missing piece is refused on its own, not just an empty object", async t => {
  const { relay, owner, scout } = await stand(t, "whole-each.db");
  for (const missing of ["name", "emoji", "persona"] as const) {
    const partial = { ...scout } as Record<string, unknown>;
    delete partial[missing];
    await refusedAndUnchanged(relay, owner, scout,
      { type: "updateAgent", agent: partial as never });
  }
});

test("a whole, valid update still goes through", async t => {
  const { relay, owner, scout } = await stand(t, "whole-ok.db");
  owner.frames.length = 0;
  owner.send({ type: "updateAgent", agent: { ...scout, persona: "finds villas and flights" } });
  const back = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.id === scout.id);
  assert.equal(back.agent.persona, "finds villas and flights");
  const stored = relay.store.agents().find(a => a.id === scout.id)!;
  assert.equal(stored.persona, "finds villas and flights");
  assert.equal(stored.emoji, WHOLE.emoji, "the rest of the agent came through untouched");
  assert.deepEqual(stored.abilities, WHOLE.abilities);
});

test("an update that would make the agent invalid is refused and nothing is stored", async t => {
  const { relay, owner, scout } = await stand(t, "whole-invalid.db");
  // a name that is not a name
  await refusedAndUnchanged(relay, owner, scout,
    { type: "updateAgent", agent: { ...scout, name: "   " } });
  // a job description longer than the hub will hold
  await refusedAndUnchanged(relay, owner, scout,
    { type: "updateAgent", agent: { ...scout, persona: "x".repeat(9000) } });
  // a model id with a shell command hidden in it
  await refusedAndUnchanged(relay, owner, scout,
    { type: "updateAgent", agent: { ...scout, model: "claude-opus-5 && calc" } });
  // abilities that are not abilities
  await refusedAndUnchanged(relay, owner, scout,
    { type: "updateAgent", agent: { ...scout, abilities: "all of them" } as never });
});

test("a half-written NEW agent is refused too — one gate, both doors", async t => {
  const { relay, owner } = await stand(t, "whole-create.db");
  owner.frames.length = 0;
  owner.send({ type: "createAgent", agent: { name: "Stub" } as never });
  const err = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /whole agent|part of/i);
  assert.equal(relay.store.agents().some(a => a.name === "Stub"), false);
});

// ---------------------------------------------------------------------------
// The words he reads
// ---------------------------------------------------------------------------

test("the refusal is a sentence, not computer-speak", async t => {
  const { relay, owner, scout } = await stand(t, "whole-words.db");
  const said = await refusedAndUnchanged(relay, owner, scout, {
    type: "updateAgent",
    agent: { id: scout.id, name: "Scout", ownerId: scout.ownerId } as never,
  });
  assert.doesNotMatch(said, /Error:|TypeError|undefined|null|\bat \w+ \(/, said);
  // no field-name soup: the sentence names the thing, not the property
  assert.doesNotMatch(said, /persona|ownerId|AgentDef|abilities\W*:/i, said);
  assert.ok(said.length > 15 && said.length < 200, said);
  assert.match(said, /agent/i, said);
});

// ---------------------------------------------------------------------------
// His existing data
// ---------------------------------------------------------------------------

test("an agent saved before abilities existed is still editable", async t => {
  const { relay, owner } = await stand(t, "whole-legacy.db");
  // written straight into the store, exactly as an older database holds it
  const legacy = {
    id: "a_legacy", ownerId: relay.ownerId, name: "Oldtimer", emoji: "🕰️",
    persona: "was here before abilities", createdAt: Date.now(),
  } as AgentDef;
  relay.store.saveAgent(legacy);

  owner.frames.length = 0;
  owner.send({ type: "updateAgent", agent: { ...legacy, persona: "still here" } });
  const back = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.id === legacy.id);
  assert.equal(back.agent.persona, "still here",
    "an agent made before a field existed must not become uneditable");
});

test("an update that never mentions abilities cannot delete them", async t => {
  const { relay, owner, scout } = await stand(t, "whole-keep-abilities.db");
  const noAbilities = { ...scout } as Record<string, unknown>;
  delete noAbilities.abilities;
  // Abilities are not a thing a person can CLEAR — there is no "no abilities"
  // state — so silence about them means "leave them alone", the same rule
  // skills' files already follow.
  owner.frames.length = 0;
  owner.send({ type: "updateAgent", agent: noAbilities as never });
  await owner.wait(f => f.type === "agent" && f.agent.id === scout.id);
  const stored = relay.store.agents().find(a => a.id === scout.id)!;
  assert.deepEqual(stored.abilities, WHOLE.abilities);
});

// ---------------------------------------------------------------------------
// The gate on its own
// ---------------------------------------------------------------------------

test("the gate answers about a whole record, not about the fields it was given", () => {
  const whole = { ...WHOLE, id: "a1", ownerId: "u1", name: "Scout", createdAt: 0 } as AgentDef;
  assert.equal(validateAgentDefinition(whole), null);
  assert.ok(validateAgentDefinition({ id: "a1", ownerId: "u1", name: "Scout" } as never));
  assert.ok(validateAgentDefinition(undefined as never));
  assert.ok(validateAgentDefinition("Scout" as never));
});
