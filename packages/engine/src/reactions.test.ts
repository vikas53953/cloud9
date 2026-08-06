import { tempDir } from "./tmp-for-tests.js";
// HIS ITEM 5: "agents should react with emoji as work happens".
//
// Two things are being held here, and the second matters more than the first:
//  1. the ticks land on the message that ASKED, in the right order;
//  2. there is exactly ONE mechanism and ONE vocabulary. The emoji come from
//     `WORK_REACTIONS` in shared and travel on the reaction feature that
//     already exists — not a second reaction system, and not a per-call-site
//     emoji somebody typed into a string.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as shared from "@cloud9/shared";
import { AgentDef, ClientFrame, Message, ServerFrame, Task, WorldState } from "@cloud9/shared";
import { Engine } from "./engine.js";
import { ClaudeProvider, RespondInput } from "./provider.js";
import { PENDING_ASK_LIMIT, rememberAsk, takeAsk, WORK_REACTIONS, workEmoji } from "./reactions.js";

const tmp = (): string => tempDir("cloud9-react-");

// ------------------------------------------------------- one vocabulary only

test("the four work emoji are shared's, not a copy of shared's", () => {
  // identity, not deep-equality: two lists that happen to agree today are
  // exactly the drift this rule exists to prevent
  assert.equal(WORK_REACTIONS, shared.WORK_REACTIONS);
  assert.equal(workEmoji("picked"), shared.WORK_REACTIONS.picked);
  assert.equal(workEmoji("done"), shared.WORK_REACTIONS.done);
  assert.equal(Object.keys(shared.WORK_REACTIONS).length, 4, "four moments, no fifth");
});

// ------------------------------------------------------------- bookkeeping

test("a job is matched back to the message that asked for it", () => {
  let list = rememberAsk([], { agentId: "a1", channelId: "c1", title: "fix the build", messageId: "m1", at: 1 });
  list = rememberAsk(list, { agentId: "a1", channelId: "c1", title: "fix the build", messageId: "m2", at: 2 });

  const first = takeAsk(list, { agentId: "a1", channelId: "c1", title: "fix the build" });
  assert.equal(first.messageId, "m1", "two identical asks are ticked in the order they were made");
  const second = takeAsk(first.rest, { agentId: "a1", channelId: "c1", title: "fix the build" });
  assert.equal(second.messageId, "m2");
  assert.equal(second.rest.length, 0);
});

test("a job nobody asked for in a message is matched to NOTHING", () => {
  const list = rememberAsk([], { agentId: "a1", channelId: "c1", title: "fix the build", messageId: "m1", at: 1 });
  // different agent, different room, different words — none of these are it
  assert.equal(takeAsk(list, { agentId: "a2", channelId: "c1", title: "fix the build" }).messageId, undefined);
  assert.equal(takeAsk(list, { agentId: "a1", channelId: "c2", title: "fix the build" }).messageId, undefined);
  assert.equal(takeAsk(list, { agentId: "a1", channelId: "c1", title: "something else" }).messageId, undefined);
});

test("asks that never became jobs cannot pile up forever", () => {
  let list: ReturnType<typeof rememberAsk> = [];
  for (let i = 0; i < PENDING_ASK_LIMIT + 20; i++) {
    list = rememberAsk(list, { agentId: "a1", channelId: "c1", title: `t${i}`, messageId: `m${i}`, at: i });
  }
  assert.equal(list.length, PENDING_ASK_LIMIT);
  assert.equal(list[list.length - 1].messageId, `m${PENDING_ASK_LIMIT + 19}`, "the newest survive");
});

// ------------------------------------------------------------- end to end

class StubProvider implements ClaudeProvider {
  constructor(private reply: string, private fail = false) {}
  async respond(_input: RespondInput): Promise<string> {
    if (this.fail) throw new Error("the harness fell over");
    return this.reply;
  }
}

const AGENT: AgentDef = {
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You fix builds",
  abilities: { webSearch: false, files: false, schedules: false, background: true },
  approvals: { background: false, schedules: false },
  createdAt: 0,
};

function world(): WorldState {
  return {
    me: { id: "u1", name: "Vikas", createdAt: 0 } as WorldState["me"],
    users: [{ id: "u1", name: "Vikas", createdAt: 0 } as WorldState["users"][number]],
    agents: [AGENT],
    channels: [{ id: "c1", name: "ops", kind: "channel", memberIds: ["u1", "a1"], createdAt: 0 }],
    messages: [], agentStatus: {}, tasks: [], approvals: [],
  };
}

/**
 * An engine with the wire replaced by a list, driven exactly as the hub drives it.
 *
 * ONE HELPER PUTS IT AWAY. `welcome` starts the scheduler, which holds the event
 * loop open, so an engine left running means `node --test` never exits — and a
 * suite that hangs is worse than one that fails, because it cannot report at
 * all. Cleanup is registered HERE, against the test's own context, so no test
 * can forget it and no future test has to remember.
 */
function makeEngine(t: TestContext, reply = "Fixed it. The build is green again.", fail = false) {
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(),
    provider: new StubProvider(reply, fail),
  });
  const frames: ClientFrame[] = [];
  (engine as unknown as { sendFrame: (f: ClientFrame) => void }).sendFrame = f => { frames.push(f); };
  const feed = (f: ServerFrame): void =>
    (engine as unknown as { onFrame: (f: ServerFrame) => void }).onFrame(f);
  feed({ type: "welcome", state: world() });
  t.after(() => { engine.stop(); });
  return { engine, frames, feed };
}

const asked: Message = {
  id: "m9", channelId: "c1", authorId: "u1", authorName: "Vikas",
  authorKind: "human", text: "@Scout !bg fix the build", ts: 1, mentions: ["a1"],
};

const job: Task = {
  id: "t1", title: "fix the build", requesterId: "u1", requesterName: "Vikas",
  agentId: "a1", channelId: "c1", status: "not_started", createdAt: 0, updatedAt: 0,
};

const reactions = (frames: ClientFrame[]): { emoji: string; on?: boolean; messageId: string }[] =>
  frames.filter(f => f.type === "agentReact")
    .map(f => f as Extract<ClientFrame, { type: "agentReact" }>)
    .map(f => ({ emoji: f.emoji, on: f.on, messageId: f.messageId }));

test("the ask is ticked 👀 the moment it lands, before anything slow starts", async t => {
  const { frames, feed } = makeEngine(t);
  feed({ type: "message", message: asked });
  await new Promise(r => setImmediate(r));

  const first = reactions(frames)[0];
  assert.ok(first, "he asked to SEE that the ask landed");
  assert.equal(first.emoji, shared.WORK_REACTIONS.picked);
  assert.equal(first.messageId, "m9", "on the message that asked, not on some other one");
  assert.equal(first.on, true);
});

test("a job runs through picked → working → done, on the same message", async t => {
  const { frames, feed } = makeEngine(t);
  feed({ type: "message", message: asked });
  await new Promise(r => setImmediate(r));
  feed({ type: "task", task: job });
  await new Promise(r => setTimeout(r, 50));

  const seen = reactions(frames);
  assert.deepEqual(seen.map(r => `${r.emoji}${r.on === false ? "-" : "+"}`), [
    `${shared.WORK_REACTIONS.picked}+`,
    `${shared.WORK_REACTIONS.picked}-`,
    `${shared.WORK_REACTIONS.working}+`,
    `${shared.WORK_REACTIONS.working}-`,
    `${shared.WORK_REACTIONS.done}+`,
  ], "one tick at a time — the old one comes off as the new one goes on");
  assert.ok(seen.every(r => r.messageId === "m9"));
});

test("a job that fell over ends on ❌, never on ✅", async t => {
  const { frames, feed } = makeEngine(t, "", true);
  feed({ type: "message", message: asked });
  await new Promise(r => setImmediate(r));
  feed({ type: "task", task: job });
  await new Promise(r => setTimeout(r, 50));

  const seen = reactions(frames);
  assert.equal(seen[seen.length - 1].emoji, shared.WORK_REACTIONS.failed);
  assert.ok(!seen.some(r => r.emoji === shared.WORK_REACTIONS.done && r.on !== false));
});

test("a job made from the Tasks panel gets no ticks rather than somebody else's", async t => {
  const { frames, feed } = makeEngine(t);
  // no message ever asked for this one
  feed({ type: "task", task: job });
  await new Promise(r => setTimeout(r, 50));
  assert.deepEqual(reactions(frames), []);
});

// ---------------------------------- his item 3 rides on the same job, so here

test("the finished job carries the TLDR the agent wrote", async t => {
  const { frames, feed } = makeEngine(t, "Fixed it. The build is green again.");
  feed({ type: "message", message: asked });
  await new Promise(r => setImmediate(r));
  feed({ type: "task", task: job });
  await new Promise(r => setTimeout(r, 50));

  const done = frames
    .filter(f => f.type === "updateTask")
    .map(f => f as Extract<ClientFrame, { type: "updateTask" }>)
    .find(f => f.status === "completed");
  assert.ok(done, "the job completed");
  assert.ok(done.summary, "and it says what happened");
  assert.match(done.summary, /^Fixed it\./, "in the agent's own words");
  assert.equal(shared.validateTaskSummary(done.summary), null, "and the hub will accept it");
});
