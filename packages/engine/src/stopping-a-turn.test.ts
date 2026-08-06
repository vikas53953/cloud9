// GAP C (2026-08-05) — STOPPING A RUNNING TURN.
//
// Cloud9 had no stop. A turn that had misunderstood ran until a wall clock
// killed it — three minutes for a chat message, thirty for a job — spending the
// owner's own subscription the whole way while he watched. There was no button,
// no command and no abort anywhere in the stack.
//
// Two halves are proved here, and they are deliberately separate:
//
//   1. `run.ts` really KILLS the child process tree, through the same `killTree`
//      the timeout path uses, and says a stop is a stop — not a timeout, and not
//      "the app isn't installed".
//   2. `engine.ts` writes it down as the OWNER'S DOING (`outcome: "cancelled"`),
//      not as a failure, and the room is told plainly.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef, ClientFrame, Message, RunRecord, WorldState } from "@cloud9/shared";
import { newStopScope, run, withStopScope } from "./run.js";
import { Engine } from "./engine.js";
import { ClaudeProvider, RespondInput } from "./provider.js";

const OWNER = "u-vikas";
const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-stop-"));

// --------------------------------------------------------- 1. the real kill

/** A command that sits there doing nothing for a long time, on either platform. */
const SLEEPER = process.platform === "win32"
  ? { cmd: "ping", args: ["-n", "60", "127.0.0.1"] }
  : { cmd: "sleep", args: ["60"] };

test("a running child is really killed when its scope is stopped", async () => {
  const scope = newStopScope();
  const started = Date.now();
  const running = withStopScope(scope, () =>
    // a leash far longer than this test: if the stop does not work, the timeout
    // cannot be what ends it, so a pass here can only mean the kill landed
    run(SLEEPER.cmd, SLEEPER.args, { timeoutMs: 60_000 }));
  // let it actually start before pulling the plug
  await new Promise(r => setTimeout(r, 300));
  scope.stop();
  const result = await running;
  assert.equal(result.stopped, true, "the result says the owner stopped it");
  assert.equal(result.timedOut, false, "a stop is NOT a timeout — the clock never ran out");
  assert.equal(result.notFound, false,
    "and it is not 'the app isn't installed' either — killing a shell can leave a " +
    "complaint on stderr that would otherwise be read as a missing command");
  assert.ok(Date.now() - started < 30_000, "it ended when it was stopped, not when the leash fired");
});

test("a run started in an ALREADY stopped scope never starts a process at all", async () => {
  const scope = newStopScope();
  scope.stop();
  const result = await withStopScope(scope, () =>
    run(SLEEPER.cmd, SLEEPER.args, { timeoutMs: 60_000 }));
  assert.equal(result.stopped, true);
  assert.equal(result.stdout, "", "nothing ran, so there is nothing it said");
});

test("a run outside any scope behaves exactly as it always did", async () => {
  const result = await run(process.platform === "win32" ? "cmd" : "echo",
    process.platform === "win32" ? ["/c", "echo", "hello"] : ["hello"], { timeoutMs: 20_000 });
  assert.ok(result.stdout.includes("hello"));
  assert.ok(!result.stopped, "nothing stopped it, so it does not claim anything did");
});

// THE ONE THAT BLANKED THE APP (found by `npm run qa`, 2026-08-05).
//
// The desktop SCREEN imports a constant out of `run.ts` (through
// `ownersetup.ts`), so this Node module is bundled into the browser as well.
// A `new AsyncLocalStorage()` at the top of the file therefore ran in the
// browser, where the bundler's stand-in has no such constructor, and the whole
// window failed to start: "AsyncLocalStorage is not a constructor". Nothing to
// do with stopping — the app simply did not open.
test("run.js constructs nothing Node-only just because it was imported", () => {
  const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const built = fs.readFileSync(path.join(here, "run.js"), "utf8");
  const lines = built.split("\n").filter(l => l.includes("new AsyncLocalStorage"));
  assert.ok(lines.length > 0, "the storage is still built somewhere — this test is still watching");
  for (const line of lines) {
    assert.ok(/^\s+/.test(line),
      "every construction must sit INSIDE a function, so importing this module for a " +
      "string never runs it. A top-level one blanks the desktop window:\n  " + line);
  }
});

test("stopping twice is safe, and a scope remembers it was stopped", () => {
  const scope = newStopScope();
  assert.equal(scope.stopped, false);
  scope.stop();
  scope.stop();
  assert.equal(scope.stopped, true, "the fact survives — it is what the run record reads");
});

// ------------------------------------------------ 2. what the engine records

/** A provider that hangs until the test lets it go — a turn mid-flight. */
class HangingProvider implements ClaudeProvider {
  started = 0;
  release!: () => void;
  private gate = new Promise<void>(resolve => { this.release = resolve; });
  async respond(_input: RespondInput): Promise<string> {
    this.started++;
    await this.gate;
    // what a killed harness gives you: noise, not a reason
    throw new Error("the harness exited with no output");
  }
}

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: OWNER, name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
  createdAt: 0, ...over,
});

const trigger: Message = {
  id: "m1", channelId: "c1", authorId: OWNER, authorName: "Vikas",
  authorKind: "human", text: "find villas", ts: 0,
};

function makeEngine(
  provider: ClaudeProvider, agents: AgentDef[] = [agent()],
  // ONE SLOT is how the queue is made visible: with the default of two, a test
  // about queued work would have to start three turns to see one wait.
  over: { maxConcurrentTurns?: number } = {},
) {
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(), provider, ...over,
  });
  const frames: ClientFrame[] = [];
  (engine as unknown as { ws: unknown }).ws = {
    readyState: 1,
    send: (raw: string) => frames.push(JSON.parse(raw) as ClientFrame),
  };
  engine.state = {
    me: { id: OWNER, name: "Vikas" },
    users: [{ id: OWNER, name: "Vikas" }],
    agents,
    channels: [{
      id: "c1", name: "ops", kind: "channel",
      memberIds: [OWNER, ...agents.map(a => a.id)], createdAt: 0,
    }],
    messages: [], agentStatus: {}, tasks: [], approvals: [],
  } as unknown as WorldState;
  return { engine, frames };
}

const agentSends = (frames: ClientFrame[]): string[] =>
  frames.filter((f): f is Extract<ClientFrame, { type: "agentSend" }> => f.type === "agentSend")
    .map(f => f.text);

const recorded = (frames: ClientFrame[]): RunRecord[] =>
  frames.filter((f): f is Extract<ClientFrame, { type: "runRecorded" }> => f.type === "runRecorded")
    .map(f => f.record);

/** A message arriving in the room, exactly as the hub delivers one. */
async function say(engine: Engine, message: Message): Promise<void> {
  await (engine as unknown as {
    considerReplies(m: Message): Promise<void>;
  }).considerReplies(message);
}

/** Wait until the agent has a turn a stop could reach. */
async function untilWorking(engine: Engine, agentId: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (engine.isWorking(agentId)) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error("the turn never became stoppable");
}

test("a stopped turn is recorded as the owner's doing, never as a failure", async () => {
  const provider = new HangingProvider();
  const { engine, frames } = makeEngine(provider);
  const turn = engine.takeTurn(agent(), "c1", trigger);
  await untilWorking(engine, "a1");

  const stopped = engine.stopAgent("a1");
  assert.equal(stopped, 1, "one running turn was found and stopped");
  provider.release();          // the killed harness now throws its meaningless noise
  await turn;

  const runs = recorded(frames);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].outcome, "cancelled",
    "STOPPED is its own outcome — not 'failed', which is what a crash gets, and not " +
    "'ok', which is what a finished turn gets");
  assert.match(runs[0].error ?? "", /you stopped this run/i,
    "and the record says whose doing it was, in words he would recognise");

  // AND THE ROOM SAYS SO. Going quiet after a stop leaves him wondering whether
  // it is still running and still costing him.
  const said = agentSends(frames).join("\n");
  assert.match(said, /stopped/i);
  assert.ok(!said.includes("could not take a turn"),
    "he is never shown a failure sentence for doing exactly what the button offered");
});

test("a turn that was never stopped still fails as a failure", async () => {
  class Broken implements ClaudeProvider {
    async respond(): Promise<string> { throw new Error("the model refused"); }
  }
  const { engine, frames } = makeEngine(new Broken());
  await engine.takeTurn(agent(), "c1", trigger);
  const runs = recorded(frames);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].outcome, "failed",
    "stopping must not turn every unhappy turn into 'he stopped it'");
});

test("stopping when nothing is running says so, and stops nothing", () => {
  const { engine } = makeEngine(new HangingProvider());
  assert.equal(engine.stopAgent("a1"), 0);
  assert.equal(engine.isWorking("a1"), false);
});

test("an agent this computer does not own cannot be stopped from here", async () => {
  const provider = new HangingProvider();
  const { engine } = makeEngine(provider);
  const turn = engine.takeTurn(agent(), "c1", trigger);
  await untilWorking(engine, "a1");
  assert.equal(engine.stopAgent("a-somebody-elses"), 0,
    "somebody else's agent is not this computer's to kill");
  assert.equal(engine.isWorking("a1"), true, "and ours is untouched by the attempt");
  engine.stopAgent("a1");
  provider.release();
  await turn;
});

test("a finished turn is no longer stoppable — no stale handle, no stale pid", async () => {
  class Quick implements ClaudeProvider {
    async respond(): Promise<string> { return "done"; }
  }
  const { engine } = makeEngine(new Quick());
  await engine.takeTurn(agent(), "c1", trigger);
  assert.equal(engine.isWorking("a1"), false);
  assert.equal(engine.stopAgent("a1"), 0);
});

// --------------------------------------------------------- "!stop" in the room

test("'!stop' typed in the room stops the agent, and only a person may type it", async () => {
  const provider = new HangingProvider();
  const { engine, frames } = makeEngine(provider);
  // a turn is running…
  const turn = engine.takeTurn(agent(), "c1", trigger);
  await untilWorking(engine, "a1");

  // …an AGENT says the magic words, and they mean nothing
  await say(engine, {
    id: "m2", channelId: "c1", authorId: "a2", authorName: "Other",
    authorKind: "agent", text: "@Scout !stop", ts: 1,
  });
  assert.equal(engine.isWorking("a1"), true,
    "an agent must not be able to stop another agent's work by saying the right words");

  // …the OWNER types it, and the work dies
  await say(engine, {
    id: "m3", channelId: "c1", authorId: OWNER, authorName: "Vikas",
    authorKind: "human", text: "@Scout !stop", ts: 2,
  });
  provider.release();
  await turn;
  assert.match(agentSends(frames).join("\n"), /Stopping/i,
    "the room is told plainly that the work was stopped");
  assert.equal(provider.started, 1, "and '!stop' did not itself start another turn");
});

test("'!stop' with nothing running says nothing was running, rather than going quiet", async () => {
  const { engine, frames } = makeEngine(new HangingProvider());
  await say(engine, {
    id: "m2", channelId: "c1", authorId: OWNER, authorName: "Vikas",
    authorKind: "human", text: "@Scout !stop", ts: 1,
  });
  assert.match(agentSends(frames).join("\n"), /nothing running to stop/i);
});

// ===========================================================================
// 3. THE WAIT THAT IS NOT A PROCESS (2026-08-06)
// ===========================================================================
//
// Two features built the same night, each right on its own and wrong together.
//
//   · The stop button (above) works by reaching into a scope and KILLING CHILD
//     PROCESSES.
//   · The approval desk parks a turn on a card — waiting to be allowed to push
//     a branch, waiting on a plan — where there is NO child process at all.
//
// So an agent standing at that gate was the one place a stop reached nothing.
// The room said "🛑 Stopping — pulling the plug on what I'm doing now" and the
// jobs screen went on saying "waiting for you" for the rest of the card's life
// — up to the whole approval window. The button was true about the processes
// and false about the only thing the owner could see.
//
// Neither feature's own tests could have caught it: the stop tests never park
// an agent on a card, and the approval tests never press stop.

const PUSH_FACTS = {
  action: "push" as const,
  repo: "vikas53953/cloud9", branch: "cloud9/scout-1", commits: 1, files: 2,
};

test("STOP RELEASES AN AGENT PARKED ON AN APPROVAL CARD — not just a running process", async () => {
  const { engine, frames } = makeEngine(new HangingProvider());
  // the agent is standing at the gate, exactly as `!code` leaves it
  const waiting = engine.approvals.ask({
    agent: agent(), channelId: "c1", facts: PUSH_FACTS,
  });
  assert.equal(engine.approvals.pending, 1, "the card is really on the table");
  assert.ok(frames.some(f => f.type === "askApproval"), "and it really reached a screen");

  // …and a stop must reach it, without a single process to kill
  const stopped = engine.stopAgent("a1");
  assert.equal(stopped, 1, "'!stop' must be able to say something true happened");

  const outcome = await waiting;
  assert.equal(outcome.approved, false,
    "pressing stop is NOT permission — this is the one answer that may never be a yes");
  assert.match(outcome.reason, /you stopped this run/i);
  assert.equal(engine.approvals.pending, 0, "and the job is no longer stuck on the jobs screen");
});

test("a stop reaches ONE agent's card, never everybody's", async () => {
  const mine = agent();
  const theirs = agent({ id: "a2", name: "Ranger" });
  const { engine } = makeEngine(new HangingProvider(), [mine, theirs]);
  const a = engine.approvals.ask({ agent: mine, channelId: "c1", facts: PUSH_FACTS });
  const b = engine.approvals.ask({ agent: theirs, channelId: "c1", facts: PUSH_FACTS });

  assert.equal(engine.stopAgent("a1"), 1);
  assert.equal((await a).approved, false);
  assert.equal(engine.approvals.pending, 1,
    "the other agent's work is not something he stopped, and one button must not mean 'stop everything'");

  engine.stopAgent("a2");
  assert.equal((await b).approved, false);
});

test("stopping an agent that is neither running nor waiting still says nothing happened", () => {
  const { engine } = makeEngine(new HangingProvider());
  assert.equal(engine.stopAgent("a1"), 0,
    "no process and no card is a real zero — the room says 'nothing was running'");
});

test("'!stop' in the room releases the card too, end to end", async () => {
  const { engine, frames } = makeEngine(new HangingProvider());
  const waiting = engine.approvals.ask({
    agent: agent(), channelId: "c1", facts: PUSH_FACTS,
  });
  await say(engine, {
    id: "m9", channelId: "c1", authorId: OWNER, authorName: "Vikas",
    authorKind: "human", text: "@Scout !stop", ts: 9,
  });
  assert.equal((await waiting).approved, false);
  assert.match(agentSends(frames).join("\n"), /Stopping/i,
    "and he is told the plug was pulled, rather than 'there was nothing running'");
});

// ===========================================================================
// 4. AND THE WORK THAT HAD NOT STARTED YET (2026-08-06)
// ===========================================================================
//
// The engine runs two turns at a time and queues the rest. A queued turn has no
// scope, no card and no child process — so `stopAgent` walked past it. The
// owner pressed Stop, was told "there was nothing running to stop", and then
// the agent answered anyway once a slot came free, recorded as an ordinary
// `ok`. Both halves of that are wrong and the second one is the one that costs
// him money.

test("STOP DROPS WORK THAT IS STILL QUEUED — it does not run a moment later", async () => {
  const provider = new HangingProvider();
  // one slot, so the second and third turns can only ever be queued
  const { engine } = makeEngine(provider, [agent()], { maxConcurrentTurns: 1 });

  // three asks: one runs (and hangs), two sit in the queue
  for (const id of ["m1", "m2", "m3"]) {
    await say(engine, {
      id, channelId: "c1", authorId: OWNER, authorName: "Vikas",
      authorKind: "human", text: "@Scout find villas", ts: Number(id.slice(1)),
    });
  }
  await untilWorking(engine, "a1");
  assert.equal(provider.started, 1, "only one turn may be in flight");

  // ONE stop: the live turn plus the two waiting behind it
  const stopped = engine.stopAgent("a1");
  assert.equal(stopped, 3, "the running turn AND the two queued ones");

  provider.release();
  // give the queue every chance to start something it should not
  await new Promise(r => setTimeout(r, 150));
  assert.equal(provider.started, 1,
    "a turn he stopped ran anyway — this is the failure the owner pays for twice");
});

test("stopping one agent never drops another agent's queued work", async () => {
  const provider = new HangingProvider();
  const mine = agent();
  const theirs = agent({ id: "a2", name: "Ranger" });
  const { engine } = makeEngine(provider, [mine, theirs], { maxConcurrentTurns: 1 });

  await say(engine, {
    id: "m1", channelId: "c1", authorId: OWNER, authorName: "Vikas",
    authorKind: "human", text: "@Scout find villas", ts: 1,
  });
  await untilWorking(engine, "a1");
  await say(engine, {
    id: "m2", channelId: "c1", authorId: OWNER, authorName: "Vikas",
    authorKind: "human", text: "@Ranger find flights", ts: 2,
  });

  // stopping Scout must leave Ranger's queued turn exactly where it was
  assert.equal(engine.stopAgent("a1"), 1,
    "only Scout's live turn — Ranger's is not his to drop");
  provider.release();
  await new Promise(r => setTimeout(r, 150));
  assert.equal(provider.started, 2, "Ranger's turn must still have run");
});
