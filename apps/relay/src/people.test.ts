// Feedback round 1 — his 15 (one person, one row, one conversation) and his
// 5+6 (an agent may only be pointed at a model this machine can really run).
// Every test gets its own brand-new database.
import test from "node:test";
import assert from "node:assert/strict";
import { ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
};

test("re-opening an invite link is a re-login, not a second person", async () => {
  const relay = new Relay({ dbPath: tmp("relay-dupes.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;

  const owner = new TestClient(url, "tok-owner");
  await owner.wait(f => f.type === "welcome");
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");

  const first = new TestClient(url, `invite:${inv.code}:Neha`);
  const w1 = await first.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");

  // the same link opened again — round 1 minted a brand-new Neha right here
  const again = new TestClient(url, `invite:${inv.code}:Neha`);
  const w2 = await again.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  assert.equal(w2.state.me.id, w1.state.me.id, "same person, not a copy");

  // a SECOND invite redeemed with a name that is already here is also her
  owner.send({ type: "createInvite" });
  const inv2 = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(
    f => f.type === "invite" && f.code !== inv.code);
  const third = new TestClient(url, `invite:${inv2.code}: neha `);
  const w3 = await third.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  assert.equal(w3.state.me.id, w1.state.me.id, "spaces and capitals are the same person");

  assert.equal(relay.store.users().filter(u => /neha/i.test(u.name)).length, 1,
    "the people list shows Neha exactly once");

  first.close(); again.close(); third.close(); owner.close(); relay.close();
});

test("a direct conversation is found, never duplicated", async () => {
  const relay = new Relay({ dbPath: tmp("relay-dm.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const me = welcome.state.me.id;

  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = new TestClient(url, `invite:${inv.code}:Priya`);
  const fw = await friend.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const her = fw.state.me.id;

  owner.send({ type: "createChannel", name: "dm", kind: "dm", memberIds: [her] });
  const one = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.kind === "dm");

  // click her again — and once more from her side, where the order is reversed
  owner.send({ type: "createChannel", name: "dm", kind: "dm", memberIds: [her] });
  friend.send({ type: "createChannel", name: "dm", kind: "dm", memberIds: [me] });
  await new Promise(r => setTimeout(r, 400));

  const dms = relay.store.channels().filter(c => c.kind === "dm");
  assert.equal(dms.length, 1, `one conversation between two people, got ${dms.length}`);
  assert.equal(dms[0].id, one.channel.id);

  owner.close(); friend.close(); relay.close();
});

test("the owner can remove a person, and their agents go with them", async () => {
  const relay = new Relay({ dbPath: tmp("relay-remove.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  await owner.wait(f => f.type === "welcome");
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = new TestClient(url, `invite:${inv.code}:Priya`);
  const fw = await friend.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const her = fw.state.me.id;

  friend.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "HerBot" } });
  const hers = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent");

  // a friend may not remove anyone
  friend.send({ type: "removeUser", userId: relay.ownerId });
  const denied = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /only the owner/);

  // ...and the owner may not remove themselves out of their own Cloud9
  owner.send({ type: "removeUser", userId: relay.ownerId });
  const self = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(self.error, /remove yourself/);

  owner.send({ type: "removeUser", userId: her });
  const gone = await owner.wait<Extract<ServerFrame, { type: "userRemoved" }>>(f => f.type === "userRemoved");
  assert.equal(gone.userId, her);
  assert.equal(relay.store.users().some(u => u.id === her), false);
  assert.equal(relay.store.agents().some(a => a.id === hers.agent.id), false, "her agent went too");
  assert.equal(relay.store.channels().some(c => c.memberIds.includes(her)), false);

  owner.close(); friend.close(); relay.close();
});

test("the relay refuses a model this machine's apps don't offer", async () => {
  const relay = new Relay({ dbPath: tmp("relay-models.db"), ownerToken: "tok-secret", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-secret");
  await owner.wait(f => f.type === "welcome");
  const host = new TestClient(url, "tok-secret", "engine");
  await host.wait(f => f.type === "welcome");

  host.send({
    type: "harnessState",
    state: {
      claude: {
        name: "claude", installed: true, signedIn: true, authKind: "cli-login",
        models: ["claude-sonnet-5", "claude-opus-5"], defaultModel: "claude-sonnet-5",
        detail: "Signed in as vikas@example.com",
      },
      codex: {
        name: "codex", installed: true, signedIn: true, authKind: "cli-login",
        models: ["gpt-5.6-sol", "gpt-5.4-mini"], defaultModel: "gpt-5.6-sol",
        detail: "Signed in as your ChatGPT account",
      },
      updatedAt: Date.now(),
    },
  });
  await owner.wait(f => f.type === "harness");

  // a model that exists, on the right app → fine
  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Good", model: "claude-opus-5" } });
  const made = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === "Good");
  assert.equal(made.agent.model, "claude-opus-5");

  // a real model belonging to the OTHER app → refused
  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Crossed", model: "gpt-5.6-sol" } });
  const crossed = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(crossed.error, /isn't one this app offers/);

  // ...unless it is a Codex agent, where that model IS on the list
  owner.send({
    type: "createAgent",
    agent: { ...BASE_AGENT, name: "Coder", provider: "codex" as const, model: "gpt-5.6-sol" },
  });
  await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === "Coder");

  // an invented id → refused
  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Bad", model: "claude-imaginary-9" } });
  await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && /isn't one this app offers/.test(f.error));

  // the injection guard stands on its own, whatever any list says
  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Evil", model: "claude-opus-5 && calc" } });
  await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && /valid model id/.test(f.error));
  assert.equal(relay.store.agents().some(a => a.name === "Evil"), false);

  owner.close(); host.close(); relay.close();
});

test("a skill with an unusable file name never reaches the database", async () => {
  const relay = new Relay({ dbPath: tmp("relay-skills.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const owner = new TestClient(`ws://127.0.0.1:${port}`, "tok-owner");
  await owner.wait(f => f.type === "welcome");

  owner.send({
    type: "createAgent",
    agent: {
      ...BASE_AGENT, name: "Sneaky",
      skills: [{
        id: "s1", name: "Escape", description: "", instructions: "do the thing",
        files: [{ name: "../../../evil.md", text: "x" }],
      }],
    },
  });
  const err = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /file name isn't allowed/);
  assert.equal(relay.store.agents().some(a => a.name === "Sneaky"), false);

  // the same agent with a sane file is stored, skills and all
  owner.send({
    type: "createAgent",
    agent: {
      ...BASE_AGENT, name: "Sane",
      skills: [{
        id: "s1", name: "Villa shortlist", description: "three villas",
        instructions: "give three options with prices",
        files: [{ name: "checklist.md", text: "# check" }],
      }],
    },
  });
  const stored = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === "Sane");
  assert.equal(stored.agent.skills?.[0].name, "Villa shortlist");
  assert.equal(stored.agent.skills?.[0].files?.[0].name, "checklist.md");

  owner.close(); relay.close();
});

test("refreshHarness is the new name for asking, and is still owner-only", async () => {
  const relay = new Relay({ dbPath: tmp("relay-refresh.db"), ownerToken: "tok-secret", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-secret");
  await owner.wait(f => f.type === "welcome");
  const host = new TestClient(url, "tok-secret", "engine");
  await host.wait(f => f.type === "welcome");

  owner.send({ type: "refreshHarness" });
  const asked = await host.wait<Extract<ServerFrame, { type: "harnessRequest" }>>(
    f => f.type === "harnessRequest" && f.action === "status");
  assert.equal(asked.harness, undefined);

  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = new TestClient(url, `invite:${inv.code}:Priya`);
  await friend.wait(f => f.type === "welcome");
  friend.send({ type: "refreshHarness" });
  const denied = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /only the owner/);

  owner.close(); friend.close(); host.close(); relay.close();
});
