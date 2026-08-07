// The board that answers "what is my crew doing right now" — pinned in words.
//
// These tests are about SENTENCES, not shapes. The bug this screen exists to
// prevent is a row that looks confident and says nothing, so nearly every
// assertion below is "the words a person reads are the right words".
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTIVITY_ORDER, activityRank, agentActivityLine, agoWords, crewActivitySummary,
  workingCount, type AgentActivityFacts,
} from "./agentactivity.js";
import { RECEIPT_EMOJI, WORK_REACTIONS } from "./index.js";

const HOUR = 60 * 60 * 1000;

/* THE RECORD'S OWN SHAPE — a start and a length, which is what a run record
   really stores. There is deliberately no `finishedAt` to hand in: the end is
   worked out inside `agentActivityLine`, so a test cannot accidentally agree
   with a caller that computes it wrongly. */
const lastDone = (over: Partial<NonNullable<AgentActivityFacts["last"]>> = {}) => ({
  outcome: "ok" as const,
  ask: "tidy the notes",
  summary: "Read 2 files, took 9 seconds.",
  startedAt: Date.now() - 5 * 60 * 1000 - 9000,
  durationMs: 9000,
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
  /* `done` used to sort above `off`. That was this file's own rule broken:
     "Claude isn't signed in" is something he must fix, and a finished agent is
     not. The full ordering is pinned in the review block at the end. */
  assert.ok(activityRank("off") < activityRank("done"));
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

/* ===========================================================================
   THE REVIEW OF 2026-08-07. Every test below pins one way this board was
   caught telling him something untrue about his own agents. They are grouped
   because they are one disease, not eight bugs: the screen answering from a
   fact that looked close enough instead of the fact it was claiming.
   =========================================================================== */

// --- 1. the rail count and the board must never disagree --------------------

test("an agent waiting on him is NOT counted as working", () => {
  /* THE ENGINE HOLDS THE WORKING LAMP THROUGH AN APPROVAL WAIT — the lamp goes
     on when a turn starts and off when it ends, and the asking happens in
     between. So these facts arrive together, and the button used to say "1"
     while the board said "Nothing is being worked on". */
  const line = agentActivityLine({ awaitingOwner: true, status: "working" });
  assert.equal(line.state, "waiting");
  assert.equal(workingCount([line]), 0);
});

test("the count and the summary are always the same story", () => {
  const lines = [
    agentActivityLine({ awaitingOwner: true, status: "working" }),
    agentActivityLine({ status: "working" }),
    agentActivityLine({ presence: "ready" }),
  ];
  assert.equal(workingCount(lines), 1);
  assert.match(crewActivitySummary(lines), /^1 of your 3 agents is working right now\./);
});

test("nothing working means the count is zero and the words agree", () => {
  const lines = [agentActivityLine({ awaitingOwner: true, status: "working" })];
  assert.equal(workingCount(lines), 0);
  assert.doesNotMatch(crewActivitySummary(lines), /is working right now/);
});

// --- 2. an agent that braked has NOT finished -------------------------------

test("A BRAKED AGENT NEVER WEARS THE FINISHED TICK", () => {
  /* The exact bug 🛑 exists to prevent, recreated: `agentPresence` maps braked
     to `ready`, so with no branch of its own the row fell through to the last
     job and drew ✅ over an agent that had stopped itself. */
  const line = agentActivityLine({
    status: "braked", presence: "ready", presenceReason: "waiting for a person to speak",
    last: lastDone(),
  });
  assert.equal(line.state, "braked");
  assert.notEqual(line.mark, WORK_REACTIONS.done);
  assert.notEqual(line.headline, "Finished");
  assert.match(line.detail, /back and forth/);
});

test("braked outranks the last job even when that job failed", () => {
  const line = agentActivityLine({
    status: "braked", presence: "ready", last: lastDone({ outcome: "failed" }),
  });
  assert.equal(line.state, "braked");
});

test("A STATE THIS BUILD HAS NEVER HEARD OF CANNOT COME OUT AS SUCCESS", () => {
  /* The structural half of the braked fix, and the point of the whole exercise:
     it is not that `braked` was missing, it is that a MISSING state defaulted to
     claiming a job succeeded. A hub newer than this app can send a word this
     build has never seen, and the row must say so rather than reach for the
     last job's ✅. */
  const line = agentActivityLine({
    status: "hibernating" as never, presence: "ready", last: lastDone(),
  });
  assert.equal(line.state, "unknown");
  assert.notEqual(line.mark, WORK_REACTIONS.done);
  assert.notEqual(line.headline, "Finished");
  assert.match(line.detail, /doesn't recognise/);
});

test("no unrecognised state anywhere can reach a finished tick", () => {
  for (const bogus of ["", "  ", "done", "ok", "finished", "ACTIVE", "42", "null"]) {
    const line = agentActivityLine({
      status: bogus as never, presence: "ready", last: lastDone(),
    });
    assert.equal(line.state, "unknown", `"${bogus}" was not treated as unknown`);
    assert.notEqual(line.headline, "Finished");
  }
});

test("the three states this build DOES know still behave", () => {
  assert.equal(agentActivityLine({ status: "idle", presence: "ready", last: lastDone() }).state, "done");
  assert.equal(agentActivityLine({ status: "working" }).state, "working");
  assert.equal(agentActivityLine({ status: "braked", presence: "ready" }).state, "braked");
  /* No status at all is a real, common case — an agent no engine has reported
     on yet — and it must stay quiet-and-truthful, not unknown. */
  assert.equal(agentActivityLine({ presence: "ready", last: lastDone() }).state, "done");
});

// --- 3. work it is holding but has not started ------------------------------

test("a job it has not started yet is VISIBLE, not the job before it", () => {
  /* The engine queues turns and runs two at a time; the lamp only lights when
     one really begins. So an agent sitting on his job read as idle, wearing the
     tick from the previous job. */
  const line = agentActivityLine({ queuedWork: "sort the invoices", last: lastDone() });
  assert.equal(line.state, "queued");
  assert.equal(line.mark, WORK_REACTIONS.picked);
  assert.match(line.detail, /sort the invoices/);
  assert.notEqual(line.headline, "Finished");
});

test("queued work is never described as nothing happening", () => {
  const summary = crewActivitySummary([agentActivityLine({ queuedWork: "sort the invoices" })]);
  assert.doesNotMatch(summary, /Nothing is being worked on/);
  assert.match(summary, /lined up/);
});

test("an agent nothing can run does not promise to start its queued job", () => {
  const line = agentActivityLine({
    presence: "offline", presenceReason: "its agent engine isn't running",
    queuedWork: "sort the invoices",
  });
  assert.equal(line.state, "off");
});

// --- 4/7. the ticks are the app's existing ones, each meaning one thing ------

test("waiting-for-you wears ❓, the tick that already means the next move is his", () => {
  const line = agentActivityLine({ awaitingOwner: true });
  assert.equal(line.mark, RECEIPT_EMOJI.needsInput);
  /* 👀 is spoken for: it means "picked your message up — the job is queued".
     Using it for both would make one tick mean two opposite things. */
  assert.notEqual(line.mark, WORK_REACTIONS.picked);
});

test("no two states on one board share a tick", () => {
  const byMark = new Map<string, string[]>();
  for (const facts of [
    { awaitingOwner: true },
    { status: "working" as const },
    { queuedWork: "a job" },
    { presence: "ready" as const, last: lastDone() },
    { presence: "ready" as const, last: lastDone({ outcome: "failed" as const }) },
    { presence: "ready" as const, last: lastDone({ outcome: "cancelled" as const }) },
  ]) {
    const line = agentActivityLine(facts);
    byMark.set(line.mark, [...(byMark.get(line.mark) ?? []), line.state]);
  }
  for (const [mark, states] of byMark) {
    assert.equal(states.length, 1, `${mark} is used by ${states.join(" and ")}`);
  }
});

// --- 5. "how long ago" is measured from the END ------------------------------

test("a long job that just finished reads as just finished, not as hours old", () => {
  const now = Date.now();
  /* Started three hours ago, ran for three hours, ended ten seconds ago. Timing
     it from the START called that "3 hours ago" — wrong about the row's only
     claim, and visible in the very screenshot that shipped it. */
  const line = agentActivityLine({
    presence: "ready",
    last: {
      outcome: "ok", ask: "the big one", summary: "Took a while.",
      startedAt: now - 3 * HOUR - 10_000, durationMs: 3 * HOUR,
    },
  });
  assert.match(line.detail, /^Just now, you asked it: the big one/);
  assert.doesNotMatch(line.detail, /hours ago/);
});

/* ===========================================================================
   AGAINST REAL RECORDS, NOT HAND-WRITTEN ONES.

   `runs.fixture.json` is captured verbatim from a running Cloud9 by
   `scripts/shot-activity.mjs` — the entries the hub really sent the app. A
   fixture written by the same hand as the code agrees with the code by
   construction, which is exactly how the recency bug passed its own tests: the
   made-up record had a `finishedAt` because the function asked for one, and a
   real record has no such field at all.
   =========================================================================== */

test("every real record the app has held produces a full, honest row", () => {
  /* Read at run time, from the source tree, rather than imported: turning on
     JSON module resolution changes the build for every other file in this
     package, and other branches share it. */
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.resolve(here, "..", "src", "runs.fixture.json");
  if (!fs.existsSync(file)) {
    /* The fixture is captured by a walk of the packaged app. If it has not been
       captured on this machine yet, say so plainly rather than passing quietly:
       a test that silently skips is a test that stops being run. */
    console.log("    (no runs.fixture.json captured yet — run scripts/shot-activity.mjs)");
    return;
  }
  const entries = JSON.parse(fs.readFileSync(file, "utf8")) as
    NonNullable<AgentActivityFacts["last"]>[];
  assert.ok(entries.length > 0, "the captured fixture is empty");

  for (const entry of entries) {
    /* A REAL RECORD GOES STRAIGHT IN. If this stops type-checking or throwing,
       the shape the screen expects has drifted from the shape the hub sends. */
    const line = agentActivityLine({ presence: "ready", last: entry });
    assert.ok(line.headline.trim().length > 0, `blank headline for ${entry.ask}`);
    assert.ok(line.detail.trim().length > 0, `blank detail for ${entry.ask}`);
    assert.ok(["done", "failed", "stopped"].includes(line.state),
      `a finished record produced "${line.state}"`);
    /* THE ENDING AND THE TICK MUST AGREE — on real data, not on my idea of it. */
    if (entry.outcome === "cancelled") assert.equal(line.headline, "You stopped it");
    if (entry.outcome === "failed") assert.equal(line.headline, "Didn't finish");
    if (entry.outcome === "ok") assert.equal(line.headline, "Finished");
    /* AND THE AGE MUST BE MEASURED FROM THE END.

       SLID FORWARD SO IT ENDED TEN SECONDS AGO, keeping the REAL length. The
       first version of this check compared the record where it sat, and a
       record captured hours ago reads "3 hours ago" from either end — so the
       check quietly agreed with the bug and skipped. A test that only fails
       during the few minutes after a capture is a test that never fails.
       Sliding the start keeps everything real about the record except the day
       it happened, and makes the one claim being tested visible every time. */
    if (entry.durationMs > 90_000) {
      const justEnded = { ...entry, startedAt: Date.now() - entry.durationMs - 10_000 };
      const row = agentActivityLine({ presence: "ready", last: justEnded });
      assert.match(row.detail, /^Just now, you asked it: /,
        `a ${Math.round(entry.durationMs / 1000)}s job that ended 10s ago reads as `
        + `"${row.detail.slice(0, 40)}…" — it is being timed from its start`);
      /* And the thing the old code actually printed, named, so the failure
         message says which mistake was made rather than just "no match". */
      assert.notEqual(row.detail.split(",")[0], agoWords(justEnded.startedAt));
    }
  }
});

// --- 6. things he must fix sort above things that are fine ------------------

test("an agent that CANNOT WORK sorts above ones that are merely finished or idle", () => {
  /* "Claude isn't signed in" is a job for him. It used to sit below `done` and
     `ready`, which is how it stays unnoticed for a day. */
  assert.ok(activityRank("off") < activityRank("done"));
  assert.ok(activityRank("off") < activityRank("ready"));
  assert.ok(activityRank("off") < activityRank("paused"));
});

test("the order is: act on it, then watch it, then everything quiet", () => {
  const order: ("waiting" | "working" | "queued" | "off" | "done" | "ready")[] =
    ["waiting", "working", "queued", "off", "done", "ready"];
  for (let i = 1; i < order.length; i++) {
    assert.ok(activityRank(order[i - 1]!) < activityRank(order[i]!),
      `${order[i - 1]} should sort above ${order[i]}`);
  }
});

test("every state — including the ones added by review — has exactly one place", () => {
  const states = [
    "working", "waiting", "queued", "braked", "stopped", "failed", "done", "paused",
    "off", "ready", "unknown",
  ] as const;
  for (const s of states) assert.ok(ACTIVITY_ORDER.includes(s), `${s} is not ordered`);
  assert.equal(new Set(ACTIVITY_ORDER).size, states.length);
  assert.equal(ACTIVITY_ORDER.length, states.length);
});

test("the new states are not silent either", () => {
  for (const facts of [
    { queuedWork: "a job" },
    { status: "braked" as const, presence: "ready" as const },
  ]) {
    const line = agentActivityLine(facts);
    assert.ok(line.headline.trim().length > 0);
    assert.ok(line.detail.trim().length > 0);
  }
});
