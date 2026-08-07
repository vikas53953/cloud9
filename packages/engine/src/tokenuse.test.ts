// THE TWO NEW DOORWAYS — SEEING WHAT THE CREW COSTS, AND OFFERING TO FIX IT.
//
// The law they are built on, and the whole of it:
//
//     AN AGENT MAY SEE WHAT ITS OWNER'S AGENTS COST.
//     AN AGENT MAY NOT CHANGE ANY OF THEM. EVER. IT MAY ONLY ASK.
//
// The owner asked for agents that "optimize other agents automatically". Taken
// literally that is one agent silently rewriting another's settings, which
// fights the approval cards, the trust levels and the whole "nothing changes
// behind your back" design. So the power is SPLIT — seeing is wide, doing is
// nothing — and these tests attack the second half from every side a model
// could: a change that is not on the closed list, a change already true, an
// agent belonging to somebody else, an argument nobody declared, and the
// wording an agent is handed after a yes (because "I turned it off" is a claim
// it must never be able to make).
//
// The arithmetic itself is proved in `@cloud9/shared`'s own `tokenuse.test.ts`.
// What is proved HERE is the boundary and the words.
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { AgentAbilities, AgentDef, RunRecord } from "@cloud9/shared";
import {
  CLOUD9_TOOLS, Cloud9SavingAnswer, Cloud9SpendingAnswer, Cloud9ToolTurn,
  callCloud9Tool, cloud9TextOf, cloud9ToolNames, renderCloud9Tools,
} from "./cloud9tools.js";
import { RunStore } from "./runstore.js";
import { tempDir } from "./tmp-for-tests.js";

const ALL_OFF: AgentAbilities = {
  webSearch: false, files: false, schedules: false, background: false,
};

const check = CLOUD9_TOOLS.find(t => t.name === "check_token_use")!;
const propose = CLOUD9_TOOLS.find(t => t.name === "propose_saving")!;

/** A stand-in Cloud9 that records exactly what each doorway was asked for. */
function stand(over: Partial<Cloud9ToolTurn> = {}) {
  const proposals: { about: string; change: unknown; because: string }[] = [];
  let spendingAsked = 0;
  const turn: Cloud9ToolTurn = {
    channelId: "c1",
    search: async () => ({ hits: [], hasMore: false }),
    openAttachment: async () => ({ found: false, why: "no" }),
    spending: async (): Promise<Cloud9SpendingAnswer> => {
      spendingAsked++;
      return { found: true, report: "Scout — $12.40 across 8 turns" };
    },
    proposeSaving: async (about, change, because): Promise<Cloud9SavingAnswer> => {
      proposals.push({ about, change, because });
      return { raised: true, what: "he accepted it" };
    },
    ...over,
  };
  return { turn, proposals, spendingAsked: () => spendingAsked };
}

// ===========================================================================
// THE TOOLS EXIST, AND THE AGENT IS TOLD ABOUT THEM
// ===========================================================================

test("both doorways are handed to the harness AND named in the prompt", () => {
  // The law `mcpdoorway.test.ts` already guards for the other four: a tool the
  // command line carries and the prompt never mentions is something the agent
  // is holding and nobody told it about.
  const names = cloud9ToolNames();
  assert.ok(names.includes(check.toolName));
  assert.ok(names.includes(propose.toolName));
  const prompt = renderCloud9Tools();
  assert.match(prompt, /check_token_use/);
  assert.match(prompt, /propose_saving/);
});

test("the prompt tells the agent, in the same breath, that it cannot change anything", () => {
  const prompt = renderCloud9Tools();
  assert.match(prompt, /It changes\s+NOTHING by itself/,
    "an agent that thinks propose_saving applies a change will report that it did");
  assert.match(prompt, /never tell him you have turned something off/);
});

// ===========================================================================
// SEEING: WIDE, BUT ONLY IN ONE DIRECTION
// ===========================================================================

test("check_token_use takes no arguments at all — there is nothing to argue with", async () => {
  assert.deepEqual((check.schema as { properties: object }).properties, {},
    "one declared argument is one thing a model can try to widen");
  const { turn } = stand();
  const ok = await callCloud9Tool(check, {}, turn);
  assert.equal(ok.isError, undefined);
  assert.match(cloud9TextOf(ok), /Scout/);
});

test("an argument nobody declared is REFUSED, not ignored", async () => {
  const { turn, spendingAsked } = stand();
  for (const args of [
    { owner: "somebody-else" },
    { agentId: "a9" },
    { all: true },
    { since: "2020-01-01" },
  ]) {
    const out = await callCloud9Tool(check, args, turn);
    assert.equal(out.isError, true, `must refuse ${JSON.stringify(args)}`);
    assert.match(cloud9TextOf(out), /your own owner's agents/);
  }
  assert.equal(spendingAsked(), 0,
    "and it must not have LOOKED before refusing — ignoring the argument would answer " +
    "a question about somebody else with this owner's figures");
});

test("a turn with no doorway says so plainly instead of guessing a figure", async () => {
  const { turn } = stand({ spending: undefined });
  const out = await callCloud9Tool(check, {}, turn);
  assert.equal(out.isError, true);
  assert.match(cloud9TextOf(out), /rather than guessing at any figure/);
});

test("a doorway that throws costs the answer, never leaks the reason", async () => {
  const { turn } = stand({
    spending: async () => { throw new Error("ECONNREFUSED 127.0.0.1:7777 /Users/vikas/secret"); },
  });
  const out = await callCloud9Tool(check, {}, turn);
  assert.equal(out.isError, true);
  const said = cloud9TextOf(out);
  assert.doesNotMatch(said, /ECONNREFUSED|127\.0\.0\.1|vikas/,
    "whatever the model is handed can end up in the room");
});

// ===========================================================================
// DOING: NOTHING AT ALL
// ===========================================================================

test("only the two changes on the closed list can be offered", async () => {
  const { turn, proposals } = stand();
  for (const change of ["startUsingOwnerSetup", "setTrust", "grantEverything", "", "delete"]) {
    const out = await callCloud9Tool(propose,
      { about: "Scout", change, because: "it is expensive" }, turn);
    assert.equal(out.isError, true, `must refuse "${change}"`);
    assert.match(cloud9TextOf(out), /exactly two changes/);
  }
  assert.equal(proposals.length, 0, "and nothing reached the engine on the way past");
});

test("a monthly limit with no amount, or a silly one, never becomes a card", async () => {
  const { turn, proposals } = stand();
  for (const perMonthUsd of [undefined, 0, -5, "twenty", Number.NaN]) {
    const out = await callCloud9Tool(propose, {
      about: "Scout", change: "setMonthlyLimit", because: "it spent $40",
      ...(perMonthUsd === undefined ? {} : { perMonthUsd }),
    }, turn);
    assert.equal(out.isError, true, `must refuse perMonthUsd ${String(perMonthUsd)}`);
  }
  assert.equal(proposals.length, 0);
});

test("a suggestion with no reason is refused — a change with no why is not decidable", async () => {
  const { turn, proposals } = stand();
  const out = await callCloud9Tool(propose,
    { about: "Scout", change: "stopUsingOwnerSetup", because: "   " }, turn);
  assert.equal(out.isError, true);
  assert.match(cloud9TextOf(out), /Say WHY/);
  assert.equal(proposals.length, 0);
});

test("an argument nobody declared cannot ride along on a proposal", async () => {
  const { turn, proposals } = stand();
  const out = await callCloud9Tool(propose, {
    about: "Scout", change: "stopUsingOwnerSetup", because: "it costs 318x",
    abilities: { wholeComputer: true }, trust: "full",
  }, turn);
  assert.equal(out.isError, true);
  assert.match(cloud9TextOf(out), /no way to change any other setting/);
  assert.equal(proposals.length, 0);
});

test("a well-formed suggestion reaches the engine with exactly what was asked for", async () => {
  const { turn, proposals } = stand();
  const out = await callCloud9Tool(propose, {
    about: "Scout", change: "setMonthlyLimit", perMonthUsd: 25,
    because: "Scout has spent $12.40 this month with no ceiling on it",
  }, turn);
  assert.equal(out.isError, undefined);
  assert.deepEqual(proposals, [{
    about: "Scout",
    change: { what: "setMonthlyLimit", perMonthUsd: 25 },
    because: "Scout has spent $12.40 this month with no ceiling on it",
  }]);
});

test("after a yes, the agent is told HE did it — never that the agent did", async () => {
  const { turn } = stand({
    proposeSaving: async () => ({
      raised: true,
      what: "Your owner accepted your suggestion for Scout, so the change is now in place. "
        + "HE made it by saying yes — you did not change anything and you cannot.",
    }),
  });
  const out = await callCloud9Tool(propose,
    { about: "Scout", change: "stopUsingOwnerSetup", because: "318x" }, turn);
  const said = cloud9TextOf(out);
  assert.match(said, /you did not change anything and you cannot/);
});

test("a no is a real answer and says plainly that nothing changed", async () => {
  const { turn } = stand({
    proposeSaving: async () => ({
      raised: false,
      why: "Your suggestion was put in front of your owner and the owner said no, so it "
        + "did not happen. Nothing has been changed. Say that plainly.",
    }),
  });
  const out = await callCloud9Tool(propose,
    { about: "Scout", change: "stopUsingOwnerSetup", because: "318x" }, turn);
  assert.equal(out.isError, true);
  assert.match(cloud9TextOf(out), /Nothing has been changed/);
});

test("a turn with no proposing doorway never half-works", async () => {
  const { turn } = stand({ proposeSaving: undefined });
  const out = await callCloud9Tool(propose,
    { about: "Scout", change: "stopUsingOwnerSetup", because: "318x" }, turn);
  assert.equal(out.isError, true);
  assert.match(cloud9TextOf(out), /nothing has been changed/i);
});

// ===========================================================================
// WHAT LEAVES THE DISK — the boundary as a type, checked as a fact
// ===========================================================================

function storeIn(dir: string): RunStore {
  return new RunStore({ agentDataDir: id => path.join(dir, id), log: () => { } });
}

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r-000000001-0001", kind: "chat", agentId: "a1", agentName: "Scout",
    provider: "claude", requestedBy: "Vikas", requestedByKind: "human",
    ask: "what is the villa address in Ibiza",
    startedAt: Date.now(), finishedAt: Date.now(), durationMs: 10,
    outcome: "ok", steps: [], replyChars: 40, events: 3,
    ...over,
  } as RunRecord;
}

test("what an agent can be shown about ANOTHER agent is money and settings only", () => {
  const dir = tempDir("countable");
  const store = storeIn(dir);
  store.save(record({
    ownerSetup: true,
    usage: { costUsd: 1.75, inputTokens: 87_498, outputTokens: 120 },
    steps: [{ seq: 1, kind: "read", label: "Read passwords.txt", detail: "C:/Users/vikas/passwords.txt" }],
    sessionId: "sess-secret",
    error: "could not reach 10.4.2.9",
  }));

  const rows = store.countableRuns("a1", "claude");
  assert.equal(rows.length, 1);
  const only = rows[0]!;
  // THE WHOLE BOUNDARY, ASSERTED AS A FACT ABOUT THE OBJECT rather than trusted
  // to the type: this is what would cross to another agent, so what is NOT on
  // it matters more than what is.
  assert.deepEqual(Object.keys(only).sort(),
    ["outcome", "ownerSetup", "provider", "startedAt", "usage"]);
  const asText = JSON.stringify(only);
  for (const leak of ["villa", "Ibiza", "passwords", "vikas", "sess-secret", "10.4.2.9"]) {
    assert.doesNotMatch(asText, new RegExp(leak, "i"),
      `"${leak}" must never travel to another agent through the spending doorway`);
  }
  assert.equal(only.usage?.costUsd, 1.75, "and the money it exists for is still there");
});

test("a run keeps the provider it RAN on, not the one the agent is set to today", () => {
  const dir = tempDir("countable-provider");
  const store = storeIn(dir);
  store.save(record({ id: "r-000000001-0001", provider: "codex" }));
  // he has since moved the agent to Claude; the record must not re-describe itself
  assert.equal(store.countableRuns("a1", "claude")[0]?.provider, "codex");
});

test("an agent with nothing stored is an empty answer, never a throw", () => {
  const store = storeIn(path.join(tempDir("countable-empty"), "nope"));
  assert.deepEqual(store.countableRuns("a1", "claude"), []);
});
