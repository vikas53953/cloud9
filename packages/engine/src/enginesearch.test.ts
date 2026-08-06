// THE ENGINE'S HALF OF THE SEARCH DOORWAY.
//
// `cloud9tools.test.ts` proves the tool boundary; `apps/relay/src/agentsearch.test.ts`
// proves the hub's. This file proves the piece between them: the engine asks the
// hub about ONE conversation, and whatever comes back, nothing from another one
// reaches the agent.
//
// It also pins the two things that made the old `renderContext` a keyhole: the
// engine reads the shared budget, and the turn it hands a provider carries its
// instruction and its kind.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef, Message, ServerFrame } from "@cloud9/shared";
import { Engine } from "./engine.js";
import { ClaudeProvider, RespondInput } from "./provider.js";
import { tempDir } from "./tmp-for-tests.js";

const tmp = (): string => tempDir("cloud9-search-");

const agent = (): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Sol", emoji: "🌞", persona: "You research travel",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
  createdAt: 0,
});

const say = (i: number, channelId: string, text: string): Message => ({
  id: `m${i}`, channelId, authorId: "u1", authorName: "Vikas", authorKind: "human",
  text, ts: 1_000 + i,
});

/** An engine with no socket: frames it would send are captured instead. */
function standIn() {
  const engine = new Engine({ relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp() });
  const sent: Record<string, unknown>[] = [];
  // the socket is never opened in a test, so this is the one seam to take
  (engine as unknown as { sendFrame: (f: unknown) => void }).sendFrame =
    (f: unknown) => { sent.push(f as Record<string, unknown>); };
  return { engine, sent };
}

/** Push a `searchResults` frame in as though the hub had answered. */
function hubAnswers(engine: Engine, frame: Extract<ServerFrame, { type: "searchResults" }>): void {
  (engine as unknown as { onFrame: (f: ServerFrame) => void }).onFrame(frame);
}

const hit = (channelId: string, text: string) => ({
  message: say(1, channelId, text), channelName: channelId, channelKind: "channel" as const,
  snippet: text,
});

test("the engine asks the hub about ONE conversation, by name", async (t) => {
  const { engine, sent } = standIn();
  t.after(() => engine.stop());
  const answer = engine.searchChannel("c_goa", "villa", 20);
  const asked = sent.find(f => f.type === "search");
  assert.ok(asked, "no search reached the hub at all");
  assert.equal(asked!.channelId, "c_goa",
    "the engine asked the hub to search everywhere the owner can read");
  hubAnswers(engine, {
    type: "searchResults", query: "villa", hasMore: false, results: [hit("c_goa", "villa in Goa")],
  });
  assert.equal((await answer).hits.length, 1);
});

test("anything from another conversation is dropped even if the hub sends it", async (t) => {
  // BELT AND BRACES. The hub already scopes this, and it is tested there. This
  // is the engine refusing to pass on a widened answer regardless — because
  // "the hub would never" is exactly the assumption that costs a private room.
  const { engine } = standIn();
  t.after(() => engine.stop());
  const answer = engine.searchChannel("c_goa", "villa", 20);
  hubAnswers(engine, {
    type: "searchResults", query: "villa", hasMore: false,
    results: [hit("c_goa", "villa in Goa"), hit("c_private_hr", "villa payroll, confidential")],
  });
  const got = await answer;
  assert.equal(got.hits.length, 1);
  assert.doesNotMatch(got.hits[0].text, /confidential/);
});

test("the doorway is shut until it is opened, and never half-open", async (t) => {
  const { engine } = standIn();
  t.after(() => engine.stop());
  assert.equal(engine.openToolTurn({ channelId: "c1" }), undefined,
    "a ticket was minted before the bridge was listening");
  await engine.startTools();
  const ticket = engine.openToolTurn({ channelId: "c1" });
  assert.ok(ticket && ticket.secret.length >= 32);
});

test("a turn reaches the provider with its instruction, its kind and its conversation", async (t) => {
  const seen: RespondInput[] = [];
  const provider: ClaudeProvider = {
    async respond(input) { seen.push(input); return "ok"; },
  };
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(), provider,
  });
  t.after(() => engine.stop());
  engine.agentSend = () => { /* no socket */ };

  await engine.respondAs(agent(), {
    context: "Vikas: night all",
    trigger: "Scheduled task fired: check the build and post the result",
    triggerAuthor: "schedule", kind: "schedule", channelId: "c_goa", requesterKind: "schedule",
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].kind, "schedule", "the provider was not told what kind of turn this is");
  assert.match(seen[0].trigger, /check the build/);
  assert.equal(seen[0].channelId, "c_goa");
});

test("the engine's conversation window is the shared budget, not a private 20", async (t) => {
  const { engine } = standIn();
  t.after(() => engine.stop());
  const history = [
    say(1, "c1", "the file is already on disk at report.md"),
    ...Array.from({ length: 40 }, (_, i) => say(i + 2, "c1", `chit-chat number ${i + 2}`)),
  ];
  for (const m of history) (engine as unknown as { pushHistory: (m: Message) => void }).pushHistory(m);
  const rendered = (engine as unknown as { renderContext: (c: string) => string }).renderContext("c1");
  assert.match(rendered, /already on disk/,
    "the standing instruction fell out of the window at 41 messages");
});
