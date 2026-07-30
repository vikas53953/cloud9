// IS THIS AGENT ACTUALLY AVAILABLE? (his item 2 — reported as a BUG: every
// agent showed offline.)
//
// WHAT THE HUB KNEW BEFORE THIS FILE EXISTED, and why every test here failed:
// `agentStatus` was written in exactly one place (an engine sending a lamp),
// never seeded and never cleared. A hub that had just started knew NOTHING
// about any agent, so `welcome` carried `agentStatus: {}` and there was no
// `presence` field at all — a client had to invent an answer, which is exactly
// what "every agent shows offline" was. Worse, the lamp was not cleared when
// the engine went away, so an engine that died mid-turn left its agent
// "working" for ever, about a machine nobody was watching.
//
// The hub had the facts all along — `hasEngine`, the stored `lifecycle`, and
// the harness report it was already keeping for the settings card — and no rule
// joining them up. The rule now lives in ONE function in shared
// (`agentPresence`); this file pins both halves: the rule itself, and the hub
// telling people about it at every moment the answer can change.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  AgentPresence, HarnessState, ServerFrame, agentPresence,
} from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
};

/**
 * A hub and the owner's ordinary client. NO engine connected — and that is the
 * point: "nobody is running this" is the state a fresh app is really in, and
 * the one his screen was getting wrong.
 *
 * Everything is torn down through `t.after`, so a FAILING test still closes its
 * hub. Without that, one broken assertion leaves a listening socket behind and
 * the whole test file hangs instead of reporting.
 */
async function stand(t: TestContext, name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const clients: TestClient[] = [];
  t.after(() => { for (const c of clients) c.close(); relay.close(); });
  const open = (token: string, kind: "desktop" | "engine" = "desktop") => {
    const c = new TestClient(url, token, kind);
    clients.push(c);
    return c;
  };
  const owner = open("tok-owner");
  const hello = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { relay, url, owner, open, me: hello.state.me };
}

async function makeAgent(client: TestClient, name: string, over: Record<string, unknown> = {}) {
  client.send({ type: "createAgent", agent: { ...BASE_AGENT, name, ...over } as never });
  const frame = await client.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === name);
  return frame.agent;
}

/**
 * Wait for the hub to say this agent is in this state, and hand back the reason.
 *
 * `TestClient.wait` searches frames ALREADY RECEIVED first, so anything that
 * looks for a state the agent has been in before must forget the old frames
 * before triggering the change — otherwise the test passes on history rather
 * than on what just happened. `forget` below is that call, and two of these
 * tests were quietly passing on history until it existed.
 */
async function presence(client: TestClient, agentId: string, want: AgentPresence): Promise<string> {
  const f = await client.wait<Extract<ServerFrame, { type: "agentStatus" }>>(
    f => f.type === "agentStatus" && f.agentId === agentId && f.presence === want);
  assert.ok(f.reason.length > 0, "presence must always say WHY");
  return f.reason;
}

/** Drop everything received so far — call it BEFORE the thing under test. */
function forget(...clients: TestClient[]): void {
  for (const c of clients) c.frames.length = 0;
}

function harness(over: Partial<HarnessState> = {}): HarnessState {
  return {
    claude: {
      name: "claude", installed: true, signedIn: true, authKind: "cli-login",
      models: ["claude-sonnet-5"], detail: "signed in",
    },
    codex: {
      name: "codex", installed: true, signedIn: false, authKind: "none",
      models: [], detail: "not signed in",
    },
    updatedAt: Date.now(),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The rule itself. No sockets — just the ladder, in one place.
// ---------------------------------------------------------------------------

test("no engine means offline, whatever the last lamp said", () => {
  // THE BUG PUT BACK: an engine that died mid-turn used to leave this reading
  // "working" for ever. Nobody can run this agent, so the honest word is offline.
  const p = agentPresence({}, { engineConnected: false, status: "working" });
  assert.equal(p.presence, "offline");
  assert.match(p.reason, /engine isn't running/);
});

test("the hub never says ready for an agent whose app isn't signed in", () => {
  const p = agentPresence({ provider: "codex" }, {
    engineConnected: true,
    harness: { installed: true, signedIn: false },
  });
  assert.equal(p.presence, "offline");
  assert.equal(p.reason, "Codex isn't signed in");

  const missing = agentPresence({ provider: "claude" }, {
    engineConnected: true,
    harness: { installed: false, signedIn: false },
  });
  assert.equal(missing.presence, "offline");
  assert.match(missing.reason, /Claude isn't installed/);
});

test("paused beats ready; working beats both", () => {
  const ready = agentPresence({}, { engineConnected: true, status: "idle" });
  assert.equal(ready.presence, "ready");

  const paused = agentPresence({ lifecycle: "paused" }, { engineConnected: true, status: "idle" });
  assert.equal(paused.presence, "paused");
  assert.match(paused.reason, /paused by its owner/);

  const working = agentPresence({ lifecycle: "paused" }, { engineConnected: true, status: "working" });
  assert.equal(working.presence, "working");
});

test("switched off is offline, not a fifth word", () => {
  const p = agentPresence({ lifecycle: "disabled" }, {
    engineConnected: true, harness: { installed: true, signedIn: true },
  });
  assert.equal(p.presence, "offline");
  assert.match(p.reason, /switched off/);
});

test("braked is the loop guard, not a lifecycle — it stays ready and says why", () => {
  // A braked agent still answers a PERSON; calling it offline or paused would be
  // reporting a status we cannot support.
  const p = agentPresence({}, {
    engineConnected: true, harness: { installed: true, signedIn: true }, status: "braked",
  });
  assert.equal(p.presence, "ready");
  assert.match(p.reason, /waiting for a person/);
});

test("an unreported app is not the same claim as a signed-out one", () => {
  // The engine is up but has not said anything about Claude yet. "Not signed in"
  // would be a claim the hub cannot back up; "ready, and here is what I actually
  // know" is the honest answer.
  const p = agentPresence({}, { engineConnected: true, status: "idle" });
  assert.equal(p.presence, "ready");
  assert.match(p.reason, /hasn't reported in yet/);
});

// ---------------------------------------------------------------------------
// The hub: the opening frame, and every moment the answer changes
// ---------------------------------------------------------------------------

test("the opening frame carries a presence for an agent nobody has ever reported", async t => {
  // This is the one that failed hardest before: `welcome.presence` did not
  // exist, and `agentStatus` was `{}`.
  const { owner, open } = await stand(t, "presence-welcome.db");
  const agent = await makeAgent(owner, "Scout");

  const second = open("tok-owner");
  const hello = await second.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const p = hello.state.presence?.[agent.id];
  assert.ok(p, "the opening frame must say whether an agent can be used");
  assert.equal(p.presence, "offline");
  assert.match(p.reason, /engine isn't running/);
  assert.equal(p.status, "idle");
});

test("an engine arriving turns its agents on, and leaving turns them off again", async t => {
  const { relay, owner, open } = await stand(t, "presence-engine.db");
  const agent = await makeAgent(owner, "Scout");

  forget(owner);
  const engine = open("tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  assert.match(await presence(owner, agent.id, "ready"), /engine is running/);

  // mid-turn…
  engine.send({ type: "agentStatus", agentId: agent.id, status: "working" });
  await presence(owner, agent.id, "working");

  // …and the engine dies. The stale "working" must not survive it.
  forget(owner);
  engine.close();
  assert.match(await presence(owner, agent.id, "offline"), /engine isn't running/);
  assert.equal(relay.agentStatus[agent.id], undefined,
    "a lamp about a machine nobody is watching is not a fact");
});

test("the app it runs on decides: Codex signed out is offline, Claude beside it is ready", async t => {
  const { owner, open } = await stand(t, "presence-harness.db");
  const claudeAgent = await makeAgent(owner, "Scout", { provider: "claude", model: "claude-sonnet-5" });
  const codexAgent = await makeAgent(owner, "Coder", { provider: "codex" });

  const engine = open("tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  // settle the "an engine arrived" round FIRST, then forget it — otherwise the
  // assertions below can match the ready-because-nothing-has-reported-yet frame
  // and prove nothing about the harness report at all
  await presence(owner, claudeAgent.id, "ready");
  await presence(owner, codexAgent.id, "ready");
  forget(owner);
  engine.send({ type: "harnessState", state: harness() });

  assert.equal(await presence(owner, codexAgent.id, "offline"), "Codex isn't signed in");
  assert.match(await presence(owner, claudeAgent.id, "ready"), /signed in to Claude/);
});

test("pausing an agent is a presence change everyone hears", async t => {
  const { owner, open } = await stand(t, "presence-paused.db");
  const agent = await makeAgent(owner, "Scout");
  const engine = open("tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  await presence(owner, agent.id, "ready");

  forget(owner);
  owner.send({ type: "updateAgent", agent: { ...agent, lifecycle: "paused" } });
  assert.match(await presence(owner, agent.id, "paused"), /paused by its owner/);

  forget(owner);
  owner.send({ type: "updateAgent", agent: { ...agent, lifecycle: "enabled" } });
  await presence(owner, agent.id, "ready");
});

test("presence reaches a friend in the room, not only the owner", async t => {
  // A grey dot in HIS sidebar and a green one in a friend's would be two answers
  // to one question.
  const { owner, open } = await stand(t, "presence-friend.db");
  const agent = await makeAgent(owner, "Scout");
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${inv.code}:Priya`);
  await friend.wait(f => f.type === "welcome");

  forget(friend);
  const engine = open("tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  await presence(friend, agent.id, "ready");
});

test("nobody sets someone else's lamp, and a made-up status is refused", async t => {
  const { relay, owner, open } = await stand(t, "presence-guard.db");
  const agent = await makeAgent(owner, "Scout");
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = open(`invite:${inv.code}:Priya`);
  await friend.wait(f => f.type === "welcome");

  friend.send({ type: "agentStatus", agentId: agent.id, status: "working" });
  const denied = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /not your agent/);

  // and the owner cannot smuggle a word the four states don't cover
  owner.send({ type: "agentStatus", agentId: agent.id, status: "on fire" as never });
  const bad = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(bad.error, /isn't a status/);
  assert.equal(relay.agentStatus[agent.id], undefined);
});
