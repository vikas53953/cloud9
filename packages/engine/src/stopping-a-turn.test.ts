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

function makeEngine(provider: ClaudeProvider, agents: AgentDef[] = [agent()]) {
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(), provider,
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
