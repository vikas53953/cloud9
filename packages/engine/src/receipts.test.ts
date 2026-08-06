import { tempDir } from "./tmp-for-tests.js";
// SEMANTIC RECEIPTS (his §2), held to two promises:
//
//  1. THE VERDICT IS EARNED. Every rule in `turnVerdict` is pinned here, in
//     the order it fires, including the one that answers "nothing honest to
//     say" with silence. If somebody later makes ✅ the fallback for a turn we
//     could not characterise, this suite goes red.
//  2. THE SIGNALS ONLY EXIST WHEN SOMEBODY IS WAITING. A triggered turn sends
//     reading → thinking → one verdict, on the message that triggered it. A
//     proactive turn — a schedule firing, with no message behind it — sends
//     NOTHING AT ALL. A 👀 on a message nobody asked about is worse than no
//     signal, because it claims an agent read something it never saw.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AgentDef, AgentSchedule, ClientFrame, Message, RECEIPT_EMOJI, ReceiptStage, ReceiptVerdict,
  RunStep, ServerFrame, WorldState,
} from "@cloud9/shared";
import { Engine } from "./engine.js";
import { ClaudeProvider, RespondInput } from "./provider.js";
import { endsWithQuestion, turnVerdict } from "./receipts.js";

const tmp = (): string => tempDir("cloud9-receipt-");

const step = (kind: RunStep["kind"], seq = 1): RunStep => ({ seq, kind, label: kind });

// ===================================================================
// 1. THE MAPPING — one test per rule, named for the rule
// ===================================================================

test("RULE 1 — a cancelled turn earns NO verdict", () => {
  // the owner pulled the plug: nothing was committed, so nothing is claimed
  assert.equal(turnVerdict({ outcome: "cancelled", reply: "half an answer" }), undefined);
});

test("RULE 2 — a failed turn is ⚠️, even when it managed to say something", () => {
  assert.equal(turnVerdict({ outcome: "failed", error: "the harness fell over" }), "conflict");
  assert.equal(
    turnVerdict({ outcome: "failed", reply: "I could not do that." }), "conflict",
    "the words are the apology; the tick is the state");
  // a CLI that reported its own failure on an otherwise-ok run is still ⚠️
  assert.equal(turnVerdict({ outcome: "ok", reply: "done", error: "tool refused" }), "conflict");
});

test("RULE 3 — a clean turn that said nothing earns NO verdict, never a cheerful ✅", () => {
  assert.equal(turnVerdict({ outcome: "ok", reply: "" }), undefined);
  assert.equal(turnVerdict({ outcome: "ok" }), undefined);
  assert.equal(turnVerdict({ outcome: "ok", reply: "   \n  " }), undefined);
});

test("RULE 4 — a turn that asked something back is ❓, and it BEATS 🔍", () => {
  assert.equal(turnVerdict({ outcome: "ok", reply: "Which branch did you mean?" }), "needsInput");
  assert.equal(
    turnVerdict({
      outcome: "ok", reply: "I found two files called config.\nWhich one did you mean?",
      steps: [step("search"), step("read", 2)],
    }),
    "needsInput",
    "it looked AND it asked — the useful thing to show is that it is waiting on him");
});

test("RULE 4 — a question quoted mid-reply is not a question being asked", () => {
  assert.equal(
    turnVerdict({ outcome: "ok", reply: "You asked: is the build green?\nYes, it is green." }),
    "agreed",
    "answering a question is not asking one");
  // and the check survives the emphasis CLIs like to wrap the last line in
  assert.ok(endsWithQuestion("**Which one did you mean?**"));
  assert.ok(endsWithQuestion("Which one did you mean?\n\n"));
  assert.ok(!endsWithQuestion("It is green."));
  assert.ok(!endsWithQuestion(""));
});

test("RULE 5 — a turn that went and looked is 🔍", () => {
  for (const kind of ["read", "search", "web"] as const) {
    assert.equal(
      turnVerdict({ outcome: "ok", reply: "Here is what I found.", steps: [step(kind)] }),
      "investigating", `${kind} is looking`);
  }
});

test("RULE 5 — doing is not investigating", () => {
  for (const kind of ["command", "write", "thinking", "message", "tool", "note"] as const) {
    assert.equal(
      turnVerdict({ outcome: "ok", reply: "Done.", steps: [step(kind)] }),
      "agreed", `${kind} is not evidence that it went and looked`);
  }
});

test("RULE 6 — a clean answer that looked nothing up and asked nothing is ✅", () => {
  assert.equal(turnVerdict({ outcome: "ok", reply: "Yes, that works." }), "agreed");
  assert.equal(turnVerdict({ outcome: "ok", reply: "Yes.", steps: [] }), "agreed");
});

test("there are exactly four verdicts, and the emoji are shared's", () => {
  assert.deepEqual(
    Object.keys(RECEIPT_EMOJI).sort(),
    ["agreed", "conflict", "investigating", "needsInput"],
    "a fifth verdict is a fifth thing three programs have to agree about");
  assert.equal(RECEIPT_EMOJI.agreed, "✅");
  assert.equal(RECEIPT_EMOJI.conflict, "⚠️");
  assert.equal(RECEIPT_EMOJI.investigating, "🔍");
  assert.equal(RECEIPT_EMOJI.needsInput, "❓");
});

// ===================================================================
// 2. THE ENGINE — what actually goes on the wire
// ===================================================================

class StubProvider implements ClaudeProvider {
  constructor(private reply: string, private fail = false) {}
  async respond(_input: RespondInput): Promise<string> {
    if (this.fail) throw new Error("the harness fell over");
    return this.reply;
  }
}

const AGENT: AgentDef = {
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You fix builds",
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

function makeEngine(t: TestContext, reply = "Yes, that works.", fail = false) {
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

type ReceiptFrame = Extract<ClientFrame, { type: "agentReceipt" }>;

const receipts = (frames: ClientFrame[]): ReceiptFrame[] =>
  frames.filter((f): f is ReceiptFrame => f.type === "agentReceipt");

const stages = (frames: ClientFrame[]): ReceiptStage[] => receipts(frames).map(f => f.stage);

const asked: Message = {
  id: "m9", channelId: "c1", authorId: "u1", authorName: "Vikas",
  authorKind: "human", text: "@Scout does this look right?", ts: 1, mentions: ["a1"],
};

test("a triggered turn sends reading → thinking → ONE verdict, on the asking message", async t => {
  const { engine, frames } = makeEngine(t, "Yes, that works.");
  await engine.takeTurn(AGENT, "c1", asked);

  assert.deepEqual(stages(frames), ["reading", "thinking", "verdict"], "in that order, no repeats");
  for (const r of receipts(frames)) {
    assert.equal(r.messageId, "m9", "on the message that triggered it, never another");
    assert.equal(r.channelId, "c1");
    assert.equal(r.agentId, "a1", "per agent — his spec's word");
  }
  const [reading, thinking, verdict] = receipts(frames);
  assert.equal(reading.verdict, undefined, "only a committed receipt carries a verdict");
  assert.equal(thinking.verdict, undefined);
  assert.equal(verdict.verdict, "agreed");
});

test("👀 goes out BEFORE the CLI is asked to do anything — that is the point", async t => {
  let sawReadingFirst = false;
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(),
    provider: {
      async respond(): Promise<string> { return "ok"; },
    } as ClaudeProvider,
  });
  const frames: ClientFrame[] = [];
  (engine as unknown as { sendFrame: (f: ClientFrame) => void }).sendFrame = f => {
    frames.push(f);
    // the instant the CLI is about to run, "reading" must already have gone
    if (f.type === "agentReceipt" && f.stage === "thinking") {
      sawReadingFirst = stages(frames)[0] === "reading";
    }
  };
  (engine as unknown as { onFrame: (f: ServerFrame) => void }).onFrame({ type: "welcome", state: world() });
  t.after(() => { engine.stop(); });

  await engine.takeTurn(AGENT, "c1", asked);
  assert.ok(sawReadingFirst, "silence must end before the slow part starts");
});

test("a turn that fell over ends on ⚠️, not on silence", async t => {
  const { engine, frames } = makeEngine(t, "", true);
  await engine.takeTurn(AGENT, "c1", asked);

  assert.deepEqual(stages(frames), ["reading", "thinking", "verdict"]);
  assert.equal(receipts(frames)[2].verdict, "conflict" satisfies ReceiptVerdict);
});

test("a turn that asks him something ends on ❓", async t => {
  const { engine, frames } = makeEngine(t, "I can do that.\nWhich branch did you mean?");
  await engine.takeTurn(AGENT, "c1", asked);
  assert.equal(receipts(frames)[2].verdict, "needsInput");
});

// ------------------------------------------------- the proactive case

test("a SCHEDULED turn — nobody asked, nobody waiting — sends NO receipts at all", async t => {
  const { engine, frames } = makeEngine(t, "Nothing to report this morning.");
  const s: AgentSchedule = {
    id: "s1", agentId: "a1", channelId: "c1", prompt: "morning check-in",
    when: "daily 06:30", enabled: true,
  };

  await (engine as unknown as { fireSchedule: (s: AgentSchedule) => Promise<void> }).fireSchedule(s);

  assert.equal(receipts(frames).length, 0,
    "a 👀 on a message the agent was never asked about would be a lie about what it read");
  // and it really did take the turn — the silence is about receipts, not about
  // the schedule quietly failing
  assert.ok(frames.some(f => f.type === "agentSend"), "the check-in itself still happened");
});

test("a turn with no triggering message sends nothing, whatever kind it is", async t => {
  const { engine, frames } = makeEngine(t, "Here you go.");
  await engine.respondAs(AGENT, {
    context: "", trigger: "do a thing", triggerAuthor: "Vikas", kind: "chat", channelId: "c1",
  });
  assert.equal(receipts(frames).length, 0, "no message to draw on means no signal");
});
