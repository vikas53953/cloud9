// TWO THINGS THAT WERE WRONG WITH WHAT AN AGENT COULD SEE, and the proof that
// each one is now right. Every test here failed before the change beside it.
//
// 1. THE BUDGET WAS A CONSTANT. `CONVERSATION_BUDGET.characters` was 24,000 for
//    every agent on every model. Cloud9 can run an agent on a model that holds
//    a million tokens and was feeding it the same 24,000 characters as one that
//    holds 200,000, because a constant cannot tell the two apart. The number is
//    now derived from the model, with a floor that is exactly today's behaviour.
//
// 2. THE THREAD WAS READ AND THEN THROWN AWAY. `engine.ts` worked out which
//    thread a turn was answering in — and used it only to decide where the
//    ANSWER went. The context handed to the agent was the whole room, flat, so
//    the thread's own opening message competed with unrelated room chatter for
//    the same budget. An agent could be dropped into a side conversation
//    without being given the start of it.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentDef, ClientFrame, contextWindowTokens, Message, ServerFrame, WorldState,
} from "@cloud9/shared";
import {
  CONVERSATION_BUDGET, CONVERSATION_BUDGET_RULE, conversationBudgetFor, renderConversation,
} from "./context.js";
import { Engine } from "./engine.js";
import { ClaudeProvider, RespondInput } from "./provider.js";

// --------------------------------------------------------------- the number

test("the budget follows the model — a bigger window really does buy more room", () => {
  const small = conversationBudgetFor("claude-opus-4-6"); // 200,000 tokens
  const big = conversationBudgetFor("claude-sonnet-5");   // 1,000,000 tokens

  assert.ok(small.characters > CONVERSATION_BUDGET.characters,
    "a 200,000-token model was being fed 24,000 characters — that is the keyhole");
  assert.ok(big.characters > small.characters,
    "a million-token model must not be given the same as a 200,000-token one");
  assert.equal(small.characters, 62_500, "an eighth of 200,000 tokens at 2.5 characters a token");
  assert.equal(big.characters, CONVERSATION_BUDGET_RULE.ceilingCharacters,
    "and the million-token model lands on the ceiling, because the owner pays for it");
});

test("a model nobody has measured gets EXACTLY today's number — this can only widen", () => {
  for (const unknown of ["some-model-from-2027", "llama-9", "x"]) {
    assert.deepEqual(conversationBudgetFor(unknown), CONVERSATION_BUDGET,
      "an unmeasured model must not be guessed up OR down");
  }
  assert.deepEqual(conversationBudgetFor(undefined), CONVERSATION_BUDGET,
    "and no model at all, with no harness to ask about, is the floor too");
});

test("an agent that never picked a model still gets its harness's smallest window", () => {
  // It is running on SOMETHING. Assuming the smallest model that harness offers
  // is honest; assuming the largest would overfill a real turn.
  assert.equal(conversationBudgetFor(undefined, "claude").characters, 62_500);
  assert.equal(conversationBudgetFor(undefined, "codex").characters, 40_000);
  assert.equal(contextWindowTokens(undefined, "codex"), 128_000);
});

test("the floor and the ceiling both bind, and neither is ever crossed", () => {
  const r = CONVERSATION_BUDGET_RULE;
  for (const model of ["claude-fable-5", "claude-haiku-4-5", "gpt-5.5", "gpt-5.3-codex-spark",
    "nothing-we-know", undefined]) {
    const b = conversationBudgetFor(model);
    assert.ok(b.characters >= r.floorCharacters, `${model} fell below the floor`);
    assert.ok(b.characters <= r.ceilingCharacters, `${model} went past the ceiling`);
    assert.ok(b.messages >= CONVERSATION_BUDGET.messages,
      `${model} would see fewer messages than it does today`);
  }
});

test("the message ceiling is the character budget read in messages, not a second opinion", () => {
  const b = conversationBudgetFor("claude-sonnet-5");
  assert.equal(b.messages,
    Math.round(b.characters / CONVERSATION_BUDGET_RULE.charactersPerMessage));
});

// --------------------------------------------------------- the thread first

const say = (id: string, text: string, over: Partial<Message> = {}): Message => ({
  id, channelId: "c1", authorId: "u1", authorName: "Vikas", authorKind: "human",
  text, ts: Number(id.replace(/\D/g, "")), ...over,
});

test("the thread being answered survives a budget too small to hold the whole room", () => {
  // The shape of the real complaint: a side conversation starts, the room then
  // fills up with unrelated chatter, and the agent is asked something in the
  // thread. Oldest-first, the thread's opening line is the first thing a
  // newest-first budget throws away.
  const room: Message[] = [
    say("m1", "THREAD-ROOT: the file is already on disk at report.md — read it, do not rewrite it"),
    say("m2", "THREAD-REPLY: understood, reading it now", { replyTo: "m1" }),
    ...Array.from({ length: 40 }, (_, i) => say(`m${i + 10}`, `room chatter number ${i} ` + "x".repeat(60))),
    say("m99", "THREAD-ASK: so what did it say?", { replyTo: "m1" }),
  ];
  const tight = { characters: 900, messages: 200 };

  const flat = renderConversation(room, tight);
  assert.ok(!flat.includes("THREAD-ROOT"),
    "before the change this is what an agent in that thread was given: no root");

  const scoped = renderConversation(room, tight, { thread: "m1" });
  assert.ok(scoped.includes("THREAD-ROOT"), "the thread's opening message must be there");
  assert.ok(scoped.includes("THREAD-REPLY"));
  assert.ok(scoped.includes("THREAD-ASK"));
  assert.ok(scoped.includes("room chatter"), "and the rest of the room still fills the remainder");
  assert.ok(scoped.length <= tight.characters + 200, "the budget is still a budget");
});

test("it is an ORDERING, not a filter — a room that fits renders identically either way", () => {
  const room: Message[] = [
    say("m1", "the root"),
    say("m2", "a reply", { replyTo: "m1" }),
    say("m3", "something else entirely"),
  ];
  assert.equal(
    renderConversation(room, CONVERSATION_BUDGET, { thread: "m1" }),
    renderConversation(room, CONVERSATION_BUDGET),
    "nothing may be dropped, reordered or reworded when everything fits");
});

test("the messages are still printed in the order they were said", () => {
  const room: Message[] = [
    say("m1", "AAA root"),
    ...Array.from({ length: 30 }, (_, i) => say(`m${i + 10}`, `BBB ${i} ` + "y".repeat(50))),
    say("m99", "CCC newest", { replyTo: "m1" }),
  ];
  const out = renderConversation(room, { characters: 700, messages: 200 }, { thread: "m1" });
  assert.ok(out.indexOf("AAA root") < out.indexOf("CCC newest"),
    "an agent must read a conversation forwards, whatever order the budget was spent in");
});

// ------------------------------------------------------------- end to end

class CapturingProvider implements ClaudeProvider {
  seen: RespondInput[] = [];
  async respond(input: RespondInput): Promise<string> {
    this.seen.push(input);
    return "done";
  }
}

const AGENT: AgentDef = {
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You fix builds",
  model: "claude-sonnet-5",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
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

function makeEngine(t: TestContext) {
  const provider = new CapturingProvider();
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t",
    dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-ctxbudget-")),
    provider,
  });
  (engine as unknown as { sendFrame: (f: ClientFrame) => void }).sendFrame = () => {};
  const feed = (f: ServerFrame): void =>
    (engine as unknown as { onFrame: (f: ServerFrame) => void }).onFrame(f);
  feed({ type: "welcome", state: world() });
  t.after(() => { engine.stop(); });
  return { engine, provider, feed };
}

test("a turn taken in a thread is handed that thread first, through the whole engine", async t => {
  const { engine, provider, feed } = makeEngine(t);
  const room: Message[] = [
    say("m1", "THREAD-ROOT: the answer is in report.md, do not rewrite it"),
    ...Array.from({ length: 400 }, (_, i) =>
      say(`m${i + 10}`, `room chatter ${i} ` + "z".repeat(300))),
  ];
  for (const m of room) feed({ type: "message", message: m });
  const ask = say("m9999", "@Scout so what did it say?", {
    replyTo: "m1", mentions: ["a1"], authorName: "Vikas",
  });
  feed({ type: "message", message: ask });
  await engine.takeTurn(AGENT, "c1", ask);

  const context = provider.seen.at(-1)?.context ?? "";
  assert.ok(context.includes("THREAD-ROOT"),
    "the engine knew the thread all along and used it only to address the reply");
  assert.ok(context.includes("room chatter"), "and the room still fills what is left");
});

test("the engine's budget follows the agent's own model", async t => {
  const { engine, provider, feed } = makeEngine(t);
  // Far more room than the old flat 24,000 characters could ever carry.
  for (let i = 0; i < 400; i++) {
    feed({ type: "message", message: say(`m${i + 10}`, "filler " + "q".repeat(250)) });
  }
  const ask = say("m9999", "@Scout status?", { mentions: ["a1"] });
  feed({ type: "message", message: ask });
  await engine.takeTurn(AGENT, "c1", ask);

  const context = provider.seen.at(-1)?.context ?? "";
  assert.ok(context.length > CONVERSATION_BUDGET.characters,
    "Sonnet 5 holds a million tokens and was being fed 24,000 characters");
  assert.ok(context.length <= conversationBudgetFor(AGENT.model).characters + 300,
    "and it is still a budget, not an open tap");
});
