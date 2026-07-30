import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialConn, reduceConn, backoffMs, connInWords,
  MAX_ATTEMPTS_BEFORE_FALLBACK, BACKOFF_MIN_MS, BACKOFF_MAX_MS,
  ConnState, ConnEvent,
} from "./hubconnection.js";

function run(state: ConnState, ...events: ConnEvent[]) {
  let s = state;
  let effect;
  for (const e of events) ({ state: s, effect } = reduceConn(s, e));
  return { state: s, effect };
}

test("backoff doubles from the floor and caps at the ceiling", () => {
  assert.equal(backoffMs(1), BACKOFF_MIN_MS);
  assert.equal(backoffMs(2), BACKOFF_MIN_MS * 2);
  assert.equal(backoffMs(3), BACKOFF_MIN_MS * 4);
  assert.equal(backoffMs(99), BACKOFF_MAX_MS); // capped
  assert.equal(backoffMs(0), BACKOFF_MIN_MS); // guarded to at least attempt 1
});

test("dialing then opening reaches connected and clears attempts", () => {
  const s0 = initialConn("h1", false);
  const { state: s1, effect: e1 } = reduceConn(s0, { t: "dialed", url: "ws://x:8787" });
  assert.equal(s1.phase, "connecting");
  assert.deepEqual(e1, { do: "openSocket", url: "ws://x:8787" });
  const { state: s2, effect: e2 } = reduceConn(s1, { t: "opened" });
  assert.equal(s2.phase, "connected");
  assert.equal(s2.attempts, 0);
  assert.deepEqual(e2, { do: "nothing" });
});

test("a drop schedules a backoff retry whose delay grows", () => {
  let { state, effect } = reduceConn(initialConn("h1", false), { t: "failed" });
  assert.equal(state.phase, "waiting");
  assert.equal(state.attempts, 1);
  assert.deepEqual(effect, { do: "waitThenRetry", ms: BACKOFF_MIN_MS });
  // timer fires → back to connecting; caller re-dials; fails again → longer wait
  ({ state } = reduceConn(state, { t: "timerFired" }));
  assert.equal(state.phase, "connecting");
  ({ state, effect } = reduceConn(state, { t: "failed" }));
  assert.equal(state.attempts, 2);
  assert.deepEqual(effect, { do: "waitThenRetry", ms: BACKOFF_MIN_MS * 2 });
});

test("a friend's hub falls back to self after the limit", () => {
  let state = initialConn("friend", false);
  let effect;
  for (let i = 0; i < MAX_ATTEMPTS_BEFORE_FALLBACK - 1; i++) {
    ({ state, effect } = reduceConn(state, { t: "failed" }));
    assert.equal(state.phase, "waiting", `attempt ${i + 1} should still be retrying`);
  }
  // the MAX-th failure tips it over
  ({ state, effect } = reduceConn(state, { t: "failed" }));
  assert.equal(state.attempts, MAX_ATTEMPTS_BEFORE_FALLBACK);
  assert.equal(state.phase, "fellBack");
  assert.deepEqual(effect, { do: "fallBackToSelf" });
});

test("this computer's own hub NEVER falls back — it retries forever", () => {
  let state = initialConn("self", true);
  let effect;
  for (let i = 0; i < MAX_ATTEMPTS_BEFORE_FALLBACK + 3; i++) {
    ({ state, effect } = reduceConn(state, { t: "failed" }));
    assert.equal(state.phase, "waiting", "self must keep waiting, never fall back");
    assert.equal(effect.do, "waitThenRetry");
  }
});

test("a live drop counts and can also trigger fallback", () => {
  let state = initialConn("friend", false);
  // four failed dials
  for (let i = 0; i < MAX_ATTEMPTS_BEFORE_FALLBACK - 1; i++) ({ state } = reduceConn(state, { t: "failed" }));
  // then a live socket drop is the fifth strike
  const { state: s, effect } = reduceConn(state, { t: "dropped" });
  assert.equal(s.phase, "fellBack");
  assert.deepEqual(effect, { do: "fallBackToSelf" });
});

test("a stray timer outside 'waiting' is ignored, never wedges", () => {
  const connected = run(initialConn("h1", false),
    { t: "dialed", url: "ws://x" }, { t: "opened" }).state;
  const { state, effect } = reduceConn(connected, { t: "timerFired" });
  assert.equal(state.phase, "connected");
  assert.deepEqual(effect, { do: "nothing" });
});

test("switching hubs resets cleanly to a fresh connecting state", () => {
  let state = initialConn("friend", false);
  for (let i = 0; i < 3; i++) ({ state } = reduceConn(state, { t: "failed" }));
  assert.equal(state.attempts, 3);
  const { state: s } = reduceConn(state, { t: "switched", targetId: "self", targetIsSelf: true });
  assert.equal(s.targetId, "self");
  assert.equal(s.targetIsSelf, true);
  assert.equal(s.attempts, 0);
  assert.equal(s.phase, "connecting");
});

test("opening after retries clears the attempt count", () => {
  let state = initialConn("friend", false);
  ({ state } = reduceConn(state, { t: "failed" }));
  ({ state } = reduceConn(state, { t: "timerFired" }));
  ({ state } = reduceConn(state, { t: "opened" }));
  assert.equal(state.phase, "connected");
  assert.equal(state.attempts, 0);
});

test("every phase has a plain-words sentence", () => {
  const base = initialConn("h1", false);
  for (const phase of ["idle", "connecting", "connected", "waiting", "fellBack"] as const) {
    const s = { ...base, phase, attempts: 2 };
    const line = connInWords(s, "Priya's");
    assert.ok(line.includes("Priya's") || phase === "fellBack" || phase === "idle",
      `phase ${phase} should mention the hub`);
    assert.ok(line.length > 8);
  }
});
