// HIS COMPLAINT, VERBATIM: "an agent does not have a conversation inside the
// threads. they do discuss within channels only and that is where the thread is
// not working... similar to Slack, within Slack it automatically replies inside
// the thread, and Buzz is the same."
//
// Every test here failed before the change beside it, because the engine sent
// `agentSend` frames with no `replyTo` at all — the wire has carried the field
// since threads shipped and the engine never once filled it in.
//
// What is being held:
//  1. asked in a thread → answered IN that thread;
//  2. asked in the room → answered in the room, exactly as before (no thread
//     is ever started by an agent on its own);
//  3. the ONE-LEVEL rule stays the hub's. This engine carries the value the hub
//     already normalised and never derives a parent of its own;
//  4. a long job asked for in a thread reports into the thread AND leaves one
//     short line in the room (the recorded decision — feature-gap.md:300);
//  5. nothing proactive — a schedule firing — is dragged into a thread;
//  6. the honest failure sentence goes where the question was.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentDef, AgentSchedule, ClientFrame, Message, ServerFrame, Task, WorldState,
} from "@cloud9/shared";
import { Engine } from "./engine.js";
import { ClaudeProvider, RespondInput } from "./provider.js";
import { rememberAsk, takeAsk } from "./reactions.js";
import { roomLineForThreadJob, threadOf } from "./threads.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-thread-"));

// ---------------------------------------------------------------- the rule

test("a message said inside a thread names that thread; one said in the room names none", () => {
  assert.equal(threadOf({ replyTo: "m-root" }), "m-root");
  assert.equal(threadOf({}), undefined, "a room message is answered in the room");
  assert.equal(threadOf(undefined), undefined, "no trigger at all is a room message");
});

test("the one-level rule stays the HUB's — this engine never derives a parent", () => {
  // The hub's `resolveReplyTo` re-parents a reply-to-a-reply onto the root, so
  // what arrives here is ALREADY a root. Carrying it back unchanged is what
  // keeps one owner; deriving `parent.replyTo ?? parent.id` a second time here
  // is the copy this test exists to forbid.
  const deliveredReplyToAReply: Message = {
    id: "m9", channelId: "c1", authorId: "u1", authorName: "Vikas", authorKind: "human",
    text: "@Scout and what about the second one?", ts: 3, replyTo: "m-root",
  };
  assert.equal(threadOf(deliveredReplyToAReply), "m-root",
    "the root the hub resolved, never the message being answered");

  // and a ROOT that happens to have replies is still a room message: an agent
  // does not start a thread on somebody else's message on its own
  const rootWithReplies: Message = {
    id: "m-root", channelId: "c1", authorId: "u1", authorName: "Vikas", authorKind: "human",
    text: "@Scout have a look", ts: 1, replyCount: 3, lastReplyAt: 4,
  };
  assert.equal(threadOf(rootWithReplies), undefined);
});

test("the room line about a threaded job is short, plain, and says how it ended", () => {
  assert.match(roomLineForThreadJob("fix the build"), /Finished in the thread: fix the build/);
  assert.match(roomLineForThreadJob("fix the build", "failed"), /Could not finish/);
  assert.ok(roomLineForThreadJob("x".repeat(500)).length < 120, "the detail lives in the thread");
});

test("a job remembers the thread it was asked for in, not just the message", () => {
  const list = rememberAsk([], {
    agentId: "a1", channelId: "c1", title: "fix the build",
    messageId: "m9", replyTo: "m-root", at: 1,
  });
  const found = takeAsk(list, { agentId: "a1", channelId: "c1", title: "fix the build" });
  assert.equal(found.messageId, "m9");
  assert.equal(found.replyTo, "m-root", "otherwise the answer comes back in the wrong place");

  const fromTheRoom = takeAsk(
    rememberAsk([], { agentId: "a1", channelId: "c1", title: "t", messageId: "m1", at: 1 }),
    { agentId: "a1", channelId: "c1", title: "t" });
  assert.equal(fromTheRoom.replyTo, undefined, "a job asked for in the room stays in the room");
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

function makeEngine(t: TestContext, reply = "The build is green again.", fail = false) {
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

type Said = { text: string; replyTo?: string; proactive?: boolean };

const said = (frames: ClientFrame[]): Said[] =>
  frames.filter((f): f is Extract<ClientFrame, { type: "agentSend" }> => f.type === "agentSend")
    .map(f => ({ text: f.text, replyTo: f.replyTo, proactive: f.proactive }));

/** The same question, once in the room and once inside a thread. */
const asked = (over: Partial<Message> = {}): Message => ({
  id: "m9", channelId: "c1", authorId: "u1", authorName: "Vikas", authorKind: "human",
  text: "@Scout is the build fixed?", ts: 2, mentions: ["a1"], ...over,
});

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 50));

test("a question asked INSIDE a thread is answered inside that thread", async t => {
  const { frames, feed } = makeEngine(t);
  feed({ type: "message", message: asked({ replyTo: "m-root" }) });
  await settle();

  const answers = said(frames);
  assert.equal(answers.length, 1, "one answer");
  assert.equal(answers[0].text, "The build is green again.");
  assert.equal(answers[0].replyTo, "m-root",
    "his complaint: the agent answered in the room and the thread died there");
});

test("the same question asked in the room is answered in the room", async t => {
  const { frames, feed } = makeEngine(t);
  feed({ type: "message", message: asked() });
  await settle();

  const answers = said(frames);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].replyTo, undefined,
    "an agent never starts a thread nobody asked for");
});

test("an answer to a reply-to-a-reply lands on the ROOT, by carrying the hub's own value", async t => {
  const { frames, feed } = makeEngine(t);
  // this is exactly what the hub delivers for a reply typed against another
  // reply: `resolveReplyTo` has already re-parented it onto the root
  feed({ type: "message", message: asked({ id: "m11", replyTo: "m-root", ts: 5 }) });
  await settle();

  const answers = said(frames);
  assert.equal(answers[0].replyTo, "m-root");
  assert.notEqual(answers[0].replyTo, "m11", "never the message being answered — that would nest");
});

test("the honest failure sentence goes where the question was asked", async t => {
  const { frames, feed } = makeEngine(t, "", true);
  feed({ type: "message", message: asked({ replyTo: "m-root" }) });
  await settle();

  const answers = said(frames);
  assert.equal(answers.length, 1);
  // `sanitizeForChat` owns the words; what is on trial here is WHERE they land
  assert.match(answers[0].text, /couldn't finish that|could not take a turn/);
  assert.equal(answers[0].replyTo, "m-root",
    "a failure that lands somewhere else reads as the app losing the question");
});

test("a background job asked for in a thread reports INTO it — and the room gets one short line",
  async t => {
    const { frames, feed } = makeEngine(t, "Fixed it. The build is green again.");
    feed({
      type: "message",
      message: asked({ text: "@Scout !bg fix the build", replyTo: "m-root" }),
    });
    await settle();

    const ack = said(frames);
    assert.equal(ack.length, 1);
    assert.match(ack[0].text, /On it/);
    assert.equal(ack[0].replyTo, "m-root", "even the 'on it' belongs in the thread");

    const job: Task = {
      id: "t1", title: "fix the build", requesterId: "u1", requesterName: "Vikas",
      agentId: "a1", channelId: "c1", status: "not_started", createdAt: 0, updatedAt: 0,
    };
    feed({ type: "task", task: job });
    await settle();

    const all = said(frames);
    const detail = all.find(s => s.text.startsWith("📦 Task done:"));
    assert.ok(detail, "the job reported");
    assert.equal(detail.replyTo, "m-root", "the work goes back where it was asked for");

    const roomLine = all.find(s => s.replyTo === undefined && s.text.includes("🧵"));
    assert.ok(roomLine, "the room is not left blind — feature-gap.md:300 says both");
    assert.match(roomLine.text, /fix the build/);
    assert.ok(roomLine.text.length < detail.text.length + 1,
      "the room line is the short one; the detail lives in the thread");
  });

test("a background job asked for in the ROOM behaves exactly as it always did", async t => {
  const { frames, feed } = makeEngine(t, "Fixed it. The build is green again.");
  feed({ type: "message", message: asked({ text: "@Scout !bg fix the build" }) });
  await settle();
  feed({
    type: "task",
    task: {
      id: "t1", title: "fix the build", requesterId: "u1", requesterName: "Vikas",
      agentId: "a1", channelId: "c1", status: "not_started", createdAt: 0, updatedAt: 0,
    },
  });
  await settle();

  const all = said(frames);
  assert.ok(all.every(s => s.replyTo === undefined), "nothing was moved into a thread");
  assert.equal(all.filter(s => s.text.includes("🧵")).length, 0,
    "and no second line about a thread that does not exist");
});

test("a schedule firing stays in the room — there is no question it is answering", async t => {
  const { engine, frames } = makeEngine(t, "All quiet.");
  const s: AgentSchedule = {
    id: "s1", agentId: "a1", channelId: "c1", when: "daily 06:30",
    prompt: "post a morning check-in", enabled: true,
  };
  await (engine as unknown as { fireSchedule: (s: AgentSchedule) => Promise<void> })
    .fireSchedule(s);

  const answers = said(frames);
  assert.equal(answers.length, 1);
  assert.match(answers[0].text, /All quiet/);
  assert.equal(answers[0].proactive, true);
  assert.equal(answers[0].replyTo, undefined,
    "a 6:30am check-in dropped into a weeks-old thread is a line nobody would ever see");
});
