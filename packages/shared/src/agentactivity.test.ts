// The board that answers "what is my crew doing right now" — pinned in words.
//
// These tests are about SENTENCES, not shapes. The bug this screen exists to
// prevent is a row that looks confident and says nothing, so nearly every
// assertion below is "the words a person reads are the right words".
import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_ORDER, activityRank, agentActivityLine, agoWords, crewActivitySummary,
  type AgentActivityFacts,
} from "./agentactivity.js";
import { WORK_REACTIONS } from "./index.js";

const HOUR = 60 * 60 * 1000;

const lastDone = (over: Partial<NonNullable<AgentActivityFacts["last"]>> = {}) => ({
  outcome: "ok" as const,
  ask: "tidy the notes",
  summary: "Read 2 files, took 9 seconds.",
  startedAt: Date.now() - 5 * 60 * 1000,
  ...over,
});

// ---------------------------------------------------------------- the ladder

test("something waiting on him outranks everything, even a job in flight", () => {
  const line = agentActivityLine({
    awaitingOwner: true, awaitingWhat: "may I push to main?",
    status: "working", lifecycle: "enabled", presence: "working",
  });
  assert.equal(line.state, "waiting");
  assert.equal(line.headline, "Waiting for you");
  assert.match(line.detail, /may I push to main\?/);
});

test("working beats paused, so a busy agent never looks idle", () => {
  const line = agentActivityLine({ status: "working", lifecycle: "paused" });
  assert.equal(line.state, "working");
  assert.equal(line.mark, WORK_REACTIONS.working);
});

test("mid-job with a live step shows the step and what it was asked", () => {
  const line = agentActivityLine({
    status: "working", doingNow: "Read note.txt", askedTo: "summarise my notes",
  });
  assert.equal(line.detail, "Read note.txt — for: summarise my notes");
});

test("mid-job that has not reported a step SAYS it has not, rather than going blank", () => {
  const line = agentActivityLine({ status: "working" });
  assert.equal(line.state, "working");
  assert.equal(line.detail, "It hasn't said what it's up to yet.");
});

test("an agent nothing can run says WHY, in the hub's own words", () => {
  const line = agentActivityLine({
    presence: "offline", presenceReason: "its agent engine isn't running",
  });
  assert.equal(line.state, "off");
  assert.equal(line.detail, "Its agent engine isn't running");
});

test("switched off is its own headline, not a mystery dash", () => {
  const line = agentActivityLine({
    lifecycle: "disabled", presence: "offline", presenceReason: "switched off by its owner",
  });
  assert.equal(line.headline, "Switched off");
});

test("paused is HIS choice, and the words say so", () => {
  const line = agentActivityLine({ lifecycle: "paused", presence: "paused" });
  assert.equal(line.state, "paused");
  assert.match(line.detail, /You paused it/);
});

// -------------------------------------------- the three endings stay distinct

test("a job HE stopped never wears the finished tick", () => {
  const line = agentActivityLine({
    presence: "ready", last: lastDone({ outcome: "cancelled", summary: "Stopped after read 1 file — took 3 seconds." }),
  });
  assert.equal(line.state, "stopped");
  assert.equal(line.headline, "You stopped it");
  assert.equal(line.mark, WORK_REACTIONS.stopped);
  assert.notEqual(line.mark, WORK_REACTIONS.done);
});

test("a job that broke reads as didn't finish, with its own tick", () => {
  const line = agentActivityLine({ presence: "ready", last: lastDone({ outcome: "failed" }) });
  assert.equal(line.state, "failed");
  assert.equal(line.headline, "Didn't finish");
  assert.equal(line.mark, WORK_REACTIONS.failed);
});

test("a finished job says what he asked and how it went", () => {
  const line = agentActivityLine({ presence: "ready", last: lastDone() });
  assert.equal(line.state, "done");
  assert.equal(line.mark, WORK_REACTIONS.done);
  assert.match(line.detail, /you asked it: tidy the notes/);
  assert.match(line.detail, /Read 2 files/);
});

test("all three endings are told apart by BOTH the tick and the words", () => {
  const marks = new Set<string>();
  const heads = new Set<string>();
  for (const outcome of ["ok", "failed", "cancelled"] as const) {
    const line = agentActivityLine({ presence: "ready", last: lastDone({ outcome }) });
    marks.add(line.mark);
    heads.add(line.headline);
  }
  assert.equal(marks.size, 3);
  assert.equal(heads.size, 3);
});

// -------------------------------------------------------- never a silent row

test("every branch produces a non-empty sentence", () => {
  const cases: AgentActivityFacts[] = [
    {},
    { status: "idle" },
    { status: "working" },
    { status: "braked", presence: "ready", presenceReason: "waiting for a person to speak" },
    { awaitingOwner: true },
    { lifecycle: "paused" },
    { lifecycle: "disabled" },
    { presence: "offline" },
    { presence: "ready", last: lastDone() },
  ];
  for (const facts of cases) {
    const line = agentActivityLine(facts);
    assert.ok(line.headline.trim().length > 0, `blank headline for ${JSON.stringify(facts)}`);
    assert.ok(line.detail.trim().length > 0, `blank detail for ${JSON.stringify(facts)}`);
  }
});

test("an agent that has never been asked anything says exactly that", () => {
  const line = agentActivityLine({ presence: "ready" });
  assert.equal(line.state, "ready");
  assert.match(line.detail, /hasn't been asked to do anything yet/);
});

test("no jargon reaches the screen", () => {
  const banned = /\b(turn|invocation|token|payload|frame|LLM|prompt|API)\b/i;
  const cases: AgentActivityFacts[] = [
    {}, { status: "working" }, { awaitingOwner: true }, { lifecycle: "paused" },
    { lifecycle: "disabled" }, { presence: "offline" },
    { presence: "ready", last: lastDone() },
    { presence: "ready", last: lastDone({ outcome: "failed" }) },
    { presence: "ready", last: lastDone({ outcome: "cancelled" }) },
  ];
  for (const facts of cases) {
    const line = agentActivityLine(facts);
    assert.doesNotMatch(line.headline, banned);
    assert.doesNotMatch(line.detail, banned);
  }
});

// ------------------------------------------------------------ the top line

test("no agents at all tells him what the screen is for", () => {
  assert.match(crewActivitySummary([]), /don't have any agents yet/);
});

test("the top line counts who is working", () => {
  const lines = [
    agentActivityLine({ status: "working" }),
    agentActivityLine({ status: "working" }),
    agentActivityLine({ presence: "ready" }),
  ];
  assert.equal(crewActivitySummary(lines), "2 of your 3 agents are working right now.");
});

test("a quiet crew is said in words, never left blank", () => {
  const lines = [agentActivityLine({ presence: "ready" }), agentActivityLine({ presence: "ready" })];
  const summary = crewActivitySummary(lines);
  assert.match(summary, /Nothing is being worked on/);
  assert.match(summary, /ready when you are/);
});

test("anything waiting on him is named in the top line, working or not", () => {
  const busy = crewActivitySummary([
    agentActivityLine({ status: "working" }), agentActivityLine({ awaitingOwner: true }),
  ]);
  assert.match(busy, /waiting for your go-ahead/);

  const quiet = crewActivitySummary([
    agentActivityLine({ presence: "ready" }), agentActivityLine({ awaitingOwner: true }),
  ]);
  assert.match(quiet, /waiting for your go-ahead/);
});

test("a crew that cannot work at all does not get told it is ready", () => {
  const lines = [
    agentActivityLine({ presence: "offline", presenceReason: "its agent engine isn't running" }),
    agentActivityLine({ presence: "offline", presenceReason: "its agent engine isn't running" }),
  ];
  const summary = crewActivitySummary(lines);
  // "None of your 2 agents CAN work" and "Your agent CAN'T work" are the same
  // statement in singular and plural, so the check allows both spellings.
  assert.match(summary, /can(?:'t)? work at the moment/);
  assert.doesNotMatch(summary, /ready when you are/);
  assert.match(
    crewActivitySummary([agentActivityLine({ presence: "offline", presenceReason: "x" })]),
    /can't work at the moment/,
  );
});

test("one agent is spoken about in the singular", () => {
  assert.equal(
    crewActivitySummary([agentActivityLine({ status: "working" })]),
    "Your agent is working right now.",
  );
});

// ------------------------------------------------------------------ ordering

test("the rows he can act on float to the top", () => {
  assert.ok(activityRank("waiting") < activityRank("working"));
  assert.ok(activityRank("working") < activityRank("done"));
  assert.ok(activityRank("done") < activityRank("off"));
});

test("every state has a place in the order — no row can fall off the list", () => {
  const states = [
    "working", "waiting", "stopped", "failed", "done", "paused", "off", "ready",
  ] as const;
  for (const s of states) assert.ok(ACTIVITY_ORDER.includes(s), `${s} is not ordered`);
  assert.equal(new Set(ACTIVITY_ORDER).size, states.length);
});

// -------------------------------------------------------------------- "when"

test("how long ago is said the way a person says it", () => {
  const now = Date.now();
  assert.equal(agoWords(now - 5_000, now), "Just now");
  assert.equal(agoWords(now - 4 * 60_000, now), "4 minutes ago");
  assert.equal(agoWords(now - 60 * 60_000, now), "1 hour ago");
  assert.equal(agoWords(now - 3 * HOUR, now), "3 hours ago");
  assert.equal(agoWords(now - 25 * HOUR, now), "Yesterday");
  assert.equal(agoWords(now - 72 * HOUR, now), "3 days ago");
});

test("a clock that is slightly ahead never reads as the future", () => {
  const now = Date.now();
  assert.equal(agoWords(now + 10_000, now), "Just now");
});
