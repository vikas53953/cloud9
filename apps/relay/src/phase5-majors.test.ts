// ROUND 2 — reproduce the seven Phase-5 Majors as tests (5-M1…5-M7).
// The seven: A3, B6, C12, D2, D3, D4, F3 (docs/qa/phase5-negative.md).
import test from "node:test";
import assert from "node:assert/strict";
import {
  FILE_NAME_SENTENCE, isSafeFileName, NAME_LIMITS, ServerFrame, validateMessageText,
  validateName,
} from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

async function stand(name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const owner = new TestClient(`ws://127.0.0.1:${port}`, "tok-owner");
  await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { relay, owner };
}

async function refuses(client: TestClient, frame: Parameters<TestClient["send"]>[0], like: RegExp) {
  client.frames.length = 0;
  client.send(frame);
  const err = await client.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, like);
}

const agentBody = (name: string) => ({
  name, emoji: "✨", persona: "finds villas", provider: "claude" as const,
  abilities: { webSearch: false, files: false, schedules: false, background: false },
});

// 5-M1 A3
test("5-M1 (A3): hub refuses a too-long message in plain words", () => {
  assert.match(validateMessageText("x".repeat(40_001)) ?? "", /too long \(max 40000 characters\)/);
});
test("5-M1 (A3): composer emptying on refuse", {
  skip: "screen-side, not mine — apps/desktop clears the box before the hub answers",
}, () => { assert.fail("unreachable"); });

// 5-M2 B6 (+ B6b picker is screen)
test("5-M2 (B6): a second agent named Scout is refused at the hub", async () => {
  const { relay, owner } = await stand("p5-m2.db");
  owner.send({ type: "createAgent", agent: agentBody("Scout") });
  await owner.wait(f => f.type === "agent" && (f as { agent: { name: string } }).agent.name === "Scout");
  await refuses(owner, { type: "createAgent", agent: agentBody("Scout") }, /already have an agent called/);
  assert.equal(relay.store.agents().filter(a => /^scout$/i.test(a.name)).length, 1);
  owner.close(); relay.close();
});
test("5-M2 (B6b): indistinguishable @ picker rows", {
  skip: "screen-side, not mine — picker UI; hub uniqueness above is the class fix",
}, () => { assert.fail("unreachable"); });

// 5-M3 C12
test("5-M3 (C12): malformed repo names are refused in plain words", async () => {
  const { relay, owner } = await stand("p5-m3.db");
  await refuses(owner, { type: "connectProject", repo: "not a repository at all" },
    /isn't a repository name/);
  owner.close(); relay.close();
});
test("5-M3 (C12): unknown-but-well-formed owner/name needs a GitHub look", {
  skip: "needs engine projectSynced path (server.ts / engine) — not store-only",
}, () => { assert.fail("unreachable"); });

// 5-M4 D2
test("5-M4 (D2): six spaces are refused, not rewritten into a channel named -", async () => {
  assert.match(validateName("channel", "      ") ?? "", /needs a name/);
  const { relay, owner } = await stand("p5-m4.db");
  await refuses(owner, { type: "createChannel", name: "      ", memberIds: [], kind: "channel" },
    /needs a name/);
  assert.ok(!relay.store.channels().some(c => c.name === "-"));
  owner.close(); relay.close();
});

// 5-M5 D3
test("5-M5 (D3): a second #goa-trip is refused at the hub", async () => {
  const { relay, owner } = await stand("p5-m5.db");
  owner.send({ type: "createChannel", name: "goa-trip", memberIds: [], kind: "channel" });
  await owner.wait(f => f.type === "channel" && (f as { channel: { name: string } }).channel.name === "goa-trip");
  await refuses(owner, { type: "createChannel", name: "goa-trip", memberIds: [], kind: "channel" },
    /already have a channel called/);
  assert.equal(relay.store.channels().filter(c => c.name === "goa-trip").length, 1);
  owner.close(); relay.close();
});

// 5-M6 D4
test("5-M6 (D4): a 3000-character channel name is refused with the cap said out loud", async () => {
  assert.match(validateName("channel", "x".repeat(3000)) ?? "",
    new RegExp(`too long \\(max ${NAME_LIMITS.channel}`));
  const { relay, owner } = await stand("p5-m6.db");
  await refuses(owner,
    { type: "createChannel", name: "x".repeat(3000), memberIds: [], kind: "channel" }, /too long/);
  assert.ok(!relay.store.channels().some(c => c.name.length > NAME_LIMITS.channel));
  owner.close(); relay.close();
});

// 5-M7 F3
test("5-M7 (F3): ordinary filenames are accepted and the sentence matches the rule", () => {
  for (const n of ["report(1).pdf", "café-menu.txt", "budget,notes.txt", "photo#3.png", "मेरी फ़ाइल.txt"]) {
    assert.equal(isSafeFileName(n), true, n);
  }
  assert.ok(!/use plain letters, numbers, dots and dashes/.test(FILE_NAME_SENTENCE));
  assert.ok(FILE_NAME_SENTENCE.includes("keep it to"));
});
