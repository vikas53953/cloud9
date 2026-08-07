// WHAT A NIGHT-LONG RUN DOES TO A CREW WHEN NOTHING EXPIRES ANY MORE.
//
// Taking the clocks away (see `timebudget.ts`) was right, and it exposed three
// things that the clocks had been quietly papering over. All three are exactly
// the shape of the run he asked for — he goes to bed, agents work, he comes back
// in the morning — and all three were found by review, not by me:
//
//  1. STARVATION. A turn parked on a card is sitting on a promise inside its own
//     job, so it holds one of the engine's two slots. That was always true and
//     was survivable only because the hub swept an unanswered card away after
//     ten minutes and handed the slot back. With no sweep, two parked agents
//     froze EVERY other agent in EVERY room, for ever.
//  2. THE ZOMBIE CARD. A dropped socket used to settle every waiting agent as a
//     NO, while the hub's card stayed `pending` with a live Approve button. He
//     wakes, clicks Approve, and there is nobody left listening: the card goes
//     green and the branch was never pushed.
//  3. THE LOST ANSWER. The clock used to bound how much a turn could print.
//     `run.ts` kept the FIRST slice of the output, and a harness announces its
//     result at the END — so a turn that worked all night was answered with a
//     fragment of somebody's tool output, recorded `ok`.
//
// Every test here fails against the first version of this branch.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  AgentDef, AgentHandoff, AgentSchedule, Approval, ClientFrame, Message, WorldState,
} from "@cloud9/shared";
import { ApprovalDesk } from "./approvaldesk.js";
import { Engine } from "./engine.js";
import { ClaudeProvider, RespondInput, TurnOutputTooBigError, sanitizeForChat } from "./provider.js";
import { NO_TIME_LIMIT, run } from "./run.js";
import { tempDir } from "./tmp-for-tests.js";

const OWNER = "u1";
const tmp = (): string => tempDir("cloud9-parked-");

const agent = (id: string, name: string): AgentDef => ({
  id, ownerId: OWNER, name, emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
  createdAt: 0,
});

const CREW = [agent("a1", "Scout"), agent("a2", "Ranger"), agent("a3", "Pilot")];

function addCrewmate(engine: Engine, id: string, name: string): void {
  const extra = agent(id, name);
  engine.state!.agents.push(extra);
  engine.state!.channels[0]!.memberIds.push(id);
}

function makeEngine(provider: ClaudeProvider, dataDir = tmp()) {
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir, provider,
  });
  const frames: ClientFrame[] = [];
  (engine as unknown as { ws: unknown }).ws = {
    readyState: 1,
    send: (raw: string) => frames.push(JSON.parse(raw) as ClientFrame),
    removeAllListeners: () => { /* a fake socket has no listeners */ },
    close: () => { /* nor anything to close */ },
  };
  engine.state = {
    me: { id: OWNER, name: "Vikas" },
    users: [{ id: OWNER, name: "Vikas" }],
    agents: CREW,
    channels: [{
      id: "c1", name: "ops", kind: "channel",
      memberIds: [OWNER, ...CREW.map(a => a.id)], createdAt: 0,
    }],
    messages: [], agentStatus: {}, tasks: [], approvals: [],
  } as unknown as WorldState;
  return { engine, frames };
}

const said = (frames: ClientFrame[]): string =>
  frames.filter((f): f is Extract<ClientFrame, { type: "agentSend" }> => f.type === "agentSend")
    .map(f => f.text).join("\n");

const says = (agentId: string, text: string): Message => ({
  id: `m-${agentId}-${Math.random().toString(36).slice(2)}`,
  channelId: "c1", authorId: OWNER, authorName: "Vikas",
  authorKind: "human", text, ts: 0,
});

async function say(engine: Engine, message: Message): Promise<void> {
  await (engine as unknown as {
    considerReplies(m: Message): Promise<void>;
  }).considerReplies(message);
}

async function until(what: () => boolean, why: string, ms = 20_000): Promise<void> {
  const stop = Date.now() + ms;
  while (!what()) {
    if (Date.now() > stop) throw new Error(`gave up waiting: ${why}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

// ================================ 1. two parked agents must not freeze the crew

/**
 * A harness that stops and asks the owner something, exactly as a real one does
 * mid-turn through the Cloud9 tool doorway — and then waits for him.
 */
class AsksHimSomething implements ClaudeProvider {
  answered: string[] = [];
  constructor(private engine: () => Engine, private park: Set<string>) {}
  async respond(input: RespondInput): Promise<string> {
    if (this.park.has(input.agent.id)) {
      // the real thing: a card, and a promise that does not settle until he says
      await this.engine().approvals.askPlan({
        agent: input.agent, channelId: "c1", plan: "1. do the thing",
      });
      return "he answered at last";
    }
    this.answered.push(input.agent.id);
    return "done";
  }
}

/** Provider probe for entrypoints that bypassed the turn queue before review. */
class EntryProbeProvider implements ClaudeProvider {
  readonly calls: RespondInput[] = [];
  readonly answered: string[] = [];
  private releases = new Map<string, () => void>();

  constructor(
    private engine: () => Engine,
    private park: (input: RespondInput) => boolean,
    private active: Set<string>,
  ) {}

  async respond(input: RespondInput): Promise<string> {
    this.calls.push(input);
    if (this.active.has(input.agent.id)) {
      await new Promise<void>(resolve => this.releases.set(input.agent.id, resolve));
    }
    if (this.park(input)) {
      await this.engine().approvals.askPlan({
        agent: input.agent, channelId: input.channelId!, plan: "1. do the thing",
      });
    }
    this.answered.push(input.agent.id);
    return "done";
  }

  release(agentId: string): void {
    this.releases.get(agentId)?.();
    this.releases.delete(agentId);
  }
}

function pendingCall(provider: EntryProbeProvider, predicate: (input: RespondInput) => boolean): boolean {
  return provider.calls.some(predicate);
}

test("TWO AGENTS PARKED ON CARDS DO NOT FREEZE THE REST OF THE CREW", async () => {
  // THE BUG HE WOULD HAVE HIT ON THE FIRST NIGHT. The engine runs two turns at
  // once. Both slots go to agents standing at a card waiting for him, and every
  // other agent in every room goes silent — for ever, because nothing expires a
  // card any more. He wakes up to a crew that answered nothing all night.
  //
  // A WAIT ON A PERSON IS NOT WORK: no CPU, no money, no harness. So it must not
  // occupy the slot the cap exists to ration.
  let engine!: Engine;
  const park = new Set(["a1", "a2"]);
  const provider = new AsksHimSomething(() => engine, park);
  const made = makeEngine(provider);
  engine = made.engine;

  // two agents stop and ask him something, and neither is answered
  await Promise.all([
    say(engine, says("a1", "@Scout please publish it")),
    say(engine, says("a2", "@Ranger please publish it")),
  ]).catch(() => { /* they do not finish — that is the point */ });
  await until(() => engine.approvals.pending === 2, "both agents to be standing at a card");

  // …and now a THIRD agent, whom nobody has asked anything, is spoken to
  void say(engine, says("a3", "@Pilot are you there?"));
  await until(() => provider.answered.includes("a3"),
    "the third agent to answer while two others wait on him — the crew is frozen");

  assert.deepEqual(provider.answered, ["a3"], "the wrong agent answered");
  assert.equal(engine.approvals.pending, 2, "the two waiting agents were disturbed");
  engine.stop();
});

test("an unrelated pending card cannot release a third turn slot", async () => {
  let engine!: Engine;
  const provider = new (class implements ClaudeProvider {
    readonly answered: string[] = [];
    async respond(input: RespondInput): Promise<string> {
      if (input.agent.id === "a1" || input.agent.id === "a2") {
        return await new Promise<string>(() => { /* active work, not a parked wait */ });
      }
      this.answered.push(input.agent.id);
      return "done";
    }
  })();
  const made = makeEngine(provider);
  engine = made.engine;

  void say(engine, says("a1", "@Scout keep working"));
  void say(engine, says("a2", "@Ranger keep working"));
  await until(() => (engine as unknown as { workingTurns(): number }).workingTurns() === 2,
    "two active turns");

  // This card did not come from a queued turn, so it must not be counted as a
  // parked slot even though it belongs to the same crew.
  void engine.approvals.askPlan({ agent: CREW[2]!, channelId: "c1", plan: "1. external card", turnToken: null });
  await until(() => engine.approvals.pending === 1, "the unrelated card");
  void say(engine, says("a3", "@Pilot are you there?"));
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(provider.answered, [], "an unrelated card released the third slot");

  engine.stopAgent("a3");
  engine.stop();
});

test("a wait still cannot be used to run the whole crew at once", async () => {
  // The credit is CLAMPED: a card raised somewhere that is not one of these jobs
  // must not push the cap upwards for ever. Two parked turns can free at most
  // two slots, because there are only two turns in flight to free.
  const { engine } = makeEngine(new (class implements ClaudeProvider {
    async respond(): Promise<string> { return "ok"; }
  })());
  const desk = engine.approvals as ApprovalDesk;
  // nobody is running anything at all, and there are cards open
  void desk.askPlan({ agent: CREW[0]!, channelId: "c1", plan: "1. x" });
  void desk.askPlan({ agent: CREW[1]!, channelId: "c1", plan: "1. y" });
  const working = (engine as unknown as { workingTurns(): number }).workingTurns();
  assert.equal(working, 0,
    "the cap was credited for waits that are not holding a slot, so it can drift upwards");
  desk.giveUpAll("test over");
  engine.stop();
});

test("approve, reconnect, and cancel release only their own parked slot", async () => {
  let engine!: Engine;
  const park = new Set(["a1", "a2"]);
  const provider = new AsksHimSomething(() => engine, park);
  const made = makeEngine(provider);
  engine = made.engine;
  await Promise.all([
    say(engine, says("a1", "@Scout publish it")),
    say(engine, says("a2", "@Ranger publish it")),
  ]).catch(() => { /* both are deliberately parked */ });
  await until(() => engine.approvals.pending === 2, "both waits");

  const waiting = (engine.approvals as unknown as {
    waiting: { askId: string; agentId: string }[];
  }).waiting;
  const a1 = waiting.find(w => w.agentId === "a1")!;
  engine.approvals.onAsked(a1.askId, "ap-a1");
  engine.approvals.onApproval({
    id: "ap-a1", agentId: "a1", ownerId: OWNER, channelId: "c1",
    action: "publish", status: "approved", createdAt: 0, kind: "plan",
  } as Approval);
  await until(() => engine.approvals.pending === 1, "approval to release only a1");

  // A reconnect does not add or remove a wait. One genuine parked turn remains,
  // so a third turn may use the one real slot but never more than one.
  (engine as unknown as { ws?: unknown }).ws = undefined;
  void say(engine, says("a3", "@Pilot are you there?"));
  await until(() => provider.answered.includes("a3"), "the one released slot");
  assert.deepEqual(provider.answered, ["a3"]);

  engine.stopAgent("a2");
  engine.stopAgent("a2");
  await until(() => engine.approvals.pending === 0, "cancel to be idempotent");
  assert.ok((engine as unknown as { workingTurns(): number }).workingTurns() >= 0,
    "slot accounting went negative after cancel/reconnect");
  engine.stop();
});

test("a scheduled approval turn is queued, owns its wait, and frees one slot", async () => {
  let engine!: Engine;
  const provider = new EntryProbeProvider(
    () => engine,
    input => input.kind === "schedule" && input.agent.id === "a3",
    new Set(["a1", "a2"]),
  );
  const made = makeEngine(provider);
  engine = made.engine;
  addCrewmate(engine, "a4", "Echo");

  void say(engine, says("a1", "@Scout keep working"));
  void say(engine, says("a2", "@Ranger keep working"));
  await until(() => (engine as unknown as { workingTurns(): number }).workingTurns() === 2,
    "two ordinary turns to fill the cap");

  const schedule: AgentSchedule = {
    id: "s-review", agentId: "a3", channelId: "c1", when: "every 1m",
    prompt: "check the queue", enabled: true,
  };
  void (engine as unknown as { fireSchedule(s: AgentSchedule): Promise<void> }).fireSchedule(schedule);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(pendingCall(provider, input => input.kind === "schedule"), false,
    "the scheduler bypassed the two-turn cap");

  provider.release("a1");
  await until(() => pendingCall(provider, input => input.kind === "schedule"),
    "the queued schedule to start after one slot is released");
  await until(() => engine.approvals.pending === 1, "the scheduled approval card");

  void say(engine, says("a4", "@Echo are you there?"));
  await until(() => provider.answered.includes("a4"),
    "a queued chat to use the slot released by the scheduled wait");

  engine.stopAgent("a3");
  provider.release("a2");
  await until(() => engine.approvals.pending === 0, "scheduled cancellation cleanup");
  assert.ok((engine as unknown as { workingTurns(): number }).workingTurns() >= 0,
    "scheduled cancellation released a slot twice");
  engine.stop();
});

test("a handoff approval turn is queued, owns its wait, and frees one slot", async () => {
  let engine!: Engine;
  const provider = new EntryProbeProvider(
    () => engine,
    input => input.agent.id === "a3" && input.trigger.includes("handed this piece"),
    new Set(["a1", "a2"]),
  );
  const made = makeEngine(provider);
  engine = made.engine;
  addCrewmate(engine, "a4", "Echo");

  void say(engine, says("a1", "@Scout keep working"));
  void say(engine, says("a2", "@Ranger keep working"));
  await until(() => (engine as unknown as { workingTurns(): number }).workingTurns() === 2,
    "two ordinary turns to fill the cap");

  const handoff: AgentHandoff = {
    id: "h-review", fromAgentId: "a1", toAgentId: "a3", task: "check the queue",
    contextPointer: { kind: "channel", ref: "c1" }, createdAt: 0,
  };
  void engine.receiveHandoff(handoff);
  await new Promise(r => setTimeout(r, 100));
  assert.equal(pendingCall(provider, input => input.trigger.includes("handed this piece")), false,
    "the handoff bypassed the two-turn cap");

  provider.release("a1");
  await until(() => pendingCall(provider, input => input.trigger.includes("handed this piece")),
    "the queued handoff to start after one slot is released");
  await until(() => engine.approvals.pending === 1, "the handoff approval card");

  void say(engine, says("a4", "@Echo are you there?"));
  await until(() => provider.answered.includes("a4"),
    "a queued chat to use the slot released by the handoff wait");

  engine.stopAgent("a3");
  provider.release("a2");
  await until(() => engine.approvals.pending === 0, "handoff cancellation cleanup");
  assert.ok((engine as unknown as { workingTurns(): number }).workingTurns() >= 0,
    "handoff cancellation released a slot twice");
  engine.stop();
});

// ================================================== 2. the zombie card

test("A DROPPED CONNECTION NO LONGER THROWS HIS QUESTION AWAY", async () => {
  // BEFORE: any websocket close settled every waiting agent as a NO, while the
  // hub's card stayed `pending` for ever with a live Approve button on it. A
  // laptop sleep or a wifi blip overnight was enough. He wakes up, presses
  // Approve, and there is nobody left to act on it.
  const { engine } = makeEngine(new (class implements ClaudeProvider {
    async respond(): Promise<string> { return "ok"; }
  })());
  let outcome: { approved: boolean } | undefined;
  void engine.approvals.askPlan({ agent: CREW[0]!, channelId: "c1", plan: "1. x" })
    .then(o => { outcome = o; });
  await until(() => engine.approvals.pending === 1, "the card to be raised");

  // the socket drops, exactly as `connect()`'s close handler sees it
  (engine as unknown as { ws?: { emit?: unknown } }).ws = undefined;
  await new Promise(r => setTimeout(r, 50));

  assert.equal(outcome, undefined,
    "a dropped connection answered his question for him — and answered it NO");
  assert.equal(engine.approvals.pending, 1, "the agent stopped waiting because the wifi did");

  // …and when he finally says yes, it still reaches the agent that asked
  const ask = (engine as unknown as { approvals: ApprovalDesk }).approvals;
  ask.onAsked((ask as unknown as { waiting: { askId: string }[] }).waiting[0]!.askId, "ap1");
  ask.onApproval({
    id: "ap1", agentId: "a1", ownerId: OWNER, action: "the plan",
    status: "approved", createdAt: 0, kind: "plan",
  } as Approval);
  await until(() => outcome !== undefined, "his yes to reach the agent that asked");
  assert.equal(outcome!.approved, true);
  engine.stop();
});

test("A YES THAT ARRIVES AFTER CLOUD9 RESTARTED IS SAID OUT LOUD, NEVER SWALLOWED", async () => {
  // THE ZOMBIE CARD. Nothing expires a card, so one can outlive the run behind
  // it: he approves a push in the morning against an agent that stopped waiting
  // when Cloud9 was last closed. The hub records `approved` and draws the card
  // green. This side has no waiter. Silence there is the worst thing this app
  // can produce — a record saying he agreed to something, and nothing agreed to.
  const { engine, frames } = makeEngine(new (class implements ClaudeProvider {
    async respond(): Promise<string> { return "ok"; }
  })());
  (engine as unknown as { onFrame(f: unknown): void }).onFrame({
    type: "approval",
    approval: {
      id: "ap-old", agentId: "a1", ownerId: OWNER, channelId: "c1",
      action: "push a branch to GitHub", status: "approved", createdAt: 0, kind: "action",
    } as Approval,
  });

  const text = said(frames);
  assert.match(text, /no longer waiting/i, "his yes vanished into nothing and he was not told");
  assert.match(text, /did not happen/i, "he is not told the work did NOT happen");
  assert.doesNotMatch(text, /\.ts:|Error|stack/, "and it is a sentence, not a report");
  engine.stop();
});

test("a card still PENDING is not something to announce — only a real decision is", () => {
  const { engine, frames } = makeEngine(new (class implements ClaudeProvider {
    async respond(): Promise<string> { return "ok"; }
  })());
  for (const status of ["pending", "rejected"] as const) {
    (engine as unknown as { onFrame(f: unknown): void }).onFrame({
      type: "approval",
      approval: {
        id: `ap-${status}`, agentId: "a1", ownerId: OWNER, channelId: "c1",
        action: "push a branch", status, createdAt: 0, kind: "action",
      } as Approval,
    });
  }
  assert.doesNotMatch(said(frames), /no longer waiting/i,
    "he is nagged about cards nothing was ever going to happen for");
  engine.stop();
});

test("a late approval warning is one-per-card across replay, live duplicates, and restart", () => {
  const dataDir = tmp();
  const provider = new (class implements ClaudeProvider {
    async respond(): Promise<string> { return "ok"; }
  })();
  const first = makeEngine(provider, dataDir);
  const approval = (id: string): Approval => ({
    id, agentId: "a1", ownerId: OWNER, channelId: "c1",
    action: "push a branch to GitHub", status: "approved", createdAt: 0, kind: "action",
  });
  const welcome = (engine: Engine, cards: Approval[]): void => {
    (engine as unknown as { onFrame(f: unknown): void }).onFrame({
      type: "welcome", state: { ...engine.state!, approvals: cards },
    });
  };
  const old = approval("ap-old");
  const newer = approval("ap-new");
  welcome(first.engine, [old]);
  welcome(first.engine, [old]);
  (first.engine as unknown as { onFrame(f: unknown): void }).onFrame({ type: "approval", approval: old });
  (first.engine as unknown as { onFrame(f: unknown): void }).onFrame({ type: "approval", approval: old });
  assert.equal(first.frames.filter(f => f.type === "agentSend").length, 1,
    "the same approved card was announced more than once");
  (first.engine as unknown as { onFrame(f: unknown): void }).onFrame({ type: "approval", approval: newer });
  assert.equal(first.frames.filter(f => f.type === "agentSend").length, 2,
    "a genuinely new approval ID did not get its one warning");

  const restarted = makeEngine(provider, dataDir);
  welcome(restarted.engine, [old, newer]);
  (restarted.engine as unknown as { onFrame(f: unknown): void }).onFrame({
    type: "approval", approval: newer,
  });
  assert.equal(restarted.frames.filter(f => f.type === "agentSend").length, 0,
    "a persisted card replayed after restart was announced again");
  first.engine.stop();
  restarted.engine.stop();
});

// ============================================ 3. the answer at the end survives

/** Write a throwaway script and give back a path `run()` will accept. */
function script(body: string): string {
  const file = path.join(tempDir("cloud9-big-"), "probe.js");
  fs.writeFileSync(file, body);
  return file;
}

test("A TURN THAT PRINTS FOR HOURS STILL COMES BACK WITH ITS ANSWER, NOT A FRAGMENT", async () => {
  // `run.ts` used to keep the FIRST slice of a run's output. A harness announces
  // its result at the END, so an overflow ate exactly the thing the owner was
  // waiting for — and the run still exited 0 and was recorded `ok`.
  //
  // Deliberately overflowing rather than reasoning about it: this prints past
  // the cap and then says the one line that matters.
  const file = script(
    `const junk = "x".repeat(64 * 1024);
     for (let i = 0; i < 300; i++) console.log(junk);
     console.log("THE-ANSWER-IS-HERE");`);
  const ran = await run(process.execPath, [file], { timeoutMs: NO_TIME_LIMIT });

  assert.equal(ran.timedOut, false);
  assert.equal(ran.code, 0);
  assert.match(ran.stdout, /THE-ANSWER-IS-HERE/,
    "the last thing it said — its answer — was thrown away to keep the first thing it said");
});

test("when the overflow really does eat the answer, it is said out loud", () => {
  // The other half, and the one that must never be quiet. If the output was
  // truncated AND no answer survived, what is left is a fragment of somebody's
  // tool result. Handing that back as the reply is the exact lie this branch
  // exists to remove.
  const said = sanitizeForChat(new TurnOutputTooBigError(), "a turn printed too much");
  assert.doesNotMatch(said, /something went wrong/,
    "the one fact he needs was swallowed by the generic apology");
  assert.match(said, /more than I can hold/i);
  assert.match(said, /Nothing was left running/);
  assert.doesNotMatch(said, /[A-Za-z]:\\|--[a-z]|stdout|stderr/, "jargon or a path got in");
});
