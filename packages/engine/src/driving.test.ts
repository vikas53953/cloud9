// Who may make an agent act — and therefore whose subscription gets spent and
// whose machine starts a program.
//
// The hole: `shouldReply` returned true for any DM and for any on-topic
// "free chatter" without ever asking who was speaking, so a friend invited into
// Cloud9 could drive the owner's agents just by opening a direct message. That
// is the same class of bug the relay closed on `createTask`, on a path the
// relay cannot see.
//
// The rule has ONE owner: `mayDriveAgent` in `@cloud9/shared`. These tests
// check that the engine calls it — not that the engine agrees with it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef, Channel, mayDriveAgent, Message, Task } from "@cloud9/shared";
import { shouldReply } from "./chatter.js";
import { Engine } from "./engine.js";
import { ClaudeProvider, RespondInput } from "./provider.js";

const OWNER = "u-vikas";
const FRIEND = "u-friend";

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: OWNER, name: "Scout", emoji: "🔭",
  persona: "You research travel and villas in Goa",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
  provider: "codex", createdAt: 0, ...over,
});

const channel = (over: Partial<Channel> = {}): Channel => ({
  id: "c1", name: "ops", kind: "channel", memberIds: [OWNER, FRIEND, "a1"], createdAt: 0, ...over,
});

const said = (authorId: string, text: string, over: Partial<Message> = {}): Message => ({
  id: "m1", channelId: "c1", authorId, authorName: authorId === OWNER ? "Vikas" : "Friend",
  authorKind: "human", text, ts: Date.now(), ...over,
});

// ------------------------------------------------------- the two open paths

test("a friend DMing someone else's agent gets no turn", () => {
  const dm = channel({ id: "d1", kind: "dm", memberIds: [FRIEND, "a1"] });
  const message = said(FRIEND, "hey, find me a villa", { channelId: "d1" });
  assert.equal(shouldReply(agent(), message, dm, [agent()]), false);
});

test("a friend's on-topic chatter draws no turn either", () => {
  // the words match the persona, so before the fix this was a guaranteed reply
  const message = said(FRIEND, "thinking about villas in Goa for a research trip");
  assert.equal(shouldReply(agent(), message, channel(), [agent()]), false);
});

test("a friend cannot get a turn by @mentioning the agent either", () => {
  const message = said(FRIEND, "@Scout find me a villa", { mentions: ["a1"] });
  assert.equal(shouldReply(agent(), message, channel(), [agent()]), false);
});

// ------------------------------------------------------------ the owner still works

test("the owner still gets a turn on every path", () => {
  const scout = agent();
  const dm = channel({ id: "d1", kind: "dm", memberIds: [OWNER, "a1"] });
  assert.equal(shouldReply(scout, said(OWNER, "hi", { channelId: "d1" }), dm, [scout]), true,
    "DM");
  assert.equal(shouldReply(scout, said(OWNER, "@Scout hi", { mentions: ["a1"] }), channel(), [scout]),
    true, "mention");
  assert.equal(shouldReply(scout, said(OWNER, "villas in Goa please"), channel(), [scout]), true,
    "free chatter");
});

// ---------------------------------------------------------------- allowlist

test("an explicit allowlist answers the allowed friend and refuses everyone else", () => {
  const shared = agent({ respondTo: "allowlist", respondToAllowlist: [FRIEND] });
  const other = "u-stranger";
  const room = channel({ memberIds: [OWNER, FRIEND, other, "a1"] });

  assert.equal(shouldReply(shared, said(FRIEND, "villas in Goa?"), room, [shared]), true);
  assert.equal(shouldReply(shared, said(other, "villas in Goa?"), room, [shared]), false);
  assert.equal(shouldReply(shared, said(OWNER, "villas in Goa?"), room, [shared]), true,
    "the owner is never locked out of his own agent");
});

test("respondTo: anyone opens it up, and omission does NOT", () => {
  const open = agent({ respondTo: "anyone" });
  assert.equal(shouldReply(open, said(FRIEND, "villas in Goa?"), channel(), [open]), true);
  // by omission — the default the relay also uses
  const closed = agent();
  assert.equal(closed.respondTo, undefined);
  assert.equal(shouldReply(closed, said(FRIEND, "villas in Goa?"), channel(), [closed]), false);
});

test("the engine asks the shared rule rather than deciding for itself", () => {
  // if these ever disagree, one of them has grown a second copy of the rule
  const cases: AgentDef[] = [
    agent(),
    agent({ respondTo: "anyone" }),
    agent({ respondTo: "allowlist", respondToAllowlist: [FRIEND] }),
    agent({ respondTo: "allowlist", respondToAllowlist: [] }),
  ];
  for (const a of cases) {
    for (const who of [OWNER, FRIEND, "u-stranger"]) {
      const room = channel({ memberIds: [OWNER, FRIEND, "u-stranger", "a1"] });
      const message = said(who, "@Scout hi", { mentions: ["a1"] });
      assert.equal(shouldReply(a, message, room, [a]), mayDriveAgent(who, a),
        `engine and shared rule disagree for ${who} on ${JSON.stringify(a.respondTo)}`);
    }
  }
});

// ------------------------------------------------------------- silent refusal

test("a refusal is silent — it never tells a guest the agent is even there", async () => {
  class Loud implements ClaudeProvider {
    calls = 0;
    async respond(_input: RespondInput): Promise<string> { this.calls++; return "hello"; }
  }
  const provider = new Loud();
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t",
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-drive-")),
    codexProvider: provider,
  });
  const sent: string[] = [];
  engine.agentSend = (_a, _c, text) => { sent.push(text); };

  // a job a friend is not allowed to ask for, arriving from the relay
  const scout = agent();
  engine.state = {
    me: { id: OWNER, name: "Vikas" }, users: [], agents: [scout],
    channels: [channel()], messages: [], tasks: [],
  } as never;
  const task: Task = {
    id: "t1", title: "spend his money", requesterId: FRIEND, requesterName: "Friend",
    agentId: "a1", channelId: "c1", status: "not_started", createdAt: 0, updatedAt: 0,
  };
  engine.tasks.set(task.id, task);
  // drive the same entry point the relay's "task" frame drives
  (engine as unknown as { maybeRunTask(t: Task): void }).maybeRunTask(task);
  await new Promise(r => setTimeout(r, 50));

  assert.equal(provider.calls, 0, "no turn was taken, so no subscription was spent");
  assert.deepEqual(sent, [], "and nothing was said back — a guest learns nothing");
});
