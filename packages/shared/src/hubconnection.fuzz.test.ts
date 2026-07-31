import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKOFF_MAX_MS,
  BACKOFF_MIN_MS,
  backoffMs,
  connInWords,
  initialConn,
  reduceConn,
  type ConnEffect,
  type ConnEvent,
  type ConnPhase,
  type ConnState,
} from "./hubconnection.js";

const PHASES: readonly ConnPhase[] = [
  "idle",
  "connecting",
  "connected",
  "waiting",
  "fellBack",
];
const EFFECTS: ReadonlyArray<ConnEffect["do"]> = [
  "openSocket",
  "waitThenRetry",
  "fallBackToSelf",
  "nothing",
];
const HUGE = "x".repeat(100_000);
const HOSTILE_TEXT = [
  "",
  " ",
  "\u200b",
  "\u200fself",
  "\u202efriend",
  "ѕelf",
  "__proto__",
  "constructor",
  "prototype",
  HUGE,
] as const;

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function randomEvent(next: () => number, step: number): ConnEvent {
  const text = HOSTILE_TEXT[next() % HOSTILE_TEXT.length];
  switch (next() % 10) {
    case 0:
      return { t: "dialed", url: `ws://${text}:${step}` };
    case 1:
      return { t: "opened" };
    case 2:
      return { t: "dropped" };
    case 3:
      return { t: "failed" };
    case 4:
      return { t: "timerFired" };
    case 5:
      return { t: "switched", targetId: text, targetIsSelf: (next() & 1) === 0 };
    case 6:
      return { t: "__proto__" } as unknown as ConnEvent;
    case 7:
      return { t: "constructor", ["__proto__"]: { polluted: true } } as unknown as ConnEvent;
    case 8:
      return { t: "", attempts: Number.MAX_SAFE_INTEGER } as unknown as ConnEvent;
    default:
      return { t: "\u202efailed", payload: HUGE } as unknown as ConnEvent;
  }
}

function assertPlain(value: object): void {
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal((Object.prototype as { polluted?: unknown }).polluted, undefined);
}

function assertValidState(state: ConnState): void {
  assertPlain(state);
  assert.ok(PHASES.includes(state.phase));
  assert.equal(typeof state.targetId, "string");
  assert.equal(typeof state.targetIsSelf, "boolean");
  assert.ok(Number.isInteger(state.attempts));
  assert.ok(state.attempts >= 0);
}

function assertValidEffect(effect: ConnEffect, before: ConnState, after: ConnState): void {
  assertPlain(effect);
  assert.ok(EFFECTS.includes(effect.do));
  switch (effect.do) {
    case "openSocket":
      assert.equal(typeof effect.url, "string");
      break;
    case "waitThenRetry":
      assert.ok(Number.isInteger(effect.ms));
      assert.ok(effect.ms >= BACKOFF_MIN_MS && effect.ms <= BACKOFF_MAX_MS);
      break;
    case "fallBackToSelf":
      assert.equal(before.targetIsSelf, false);
      assert.equal(after.phase, "fellBack");
      break;
    case "nothing":
      break;
  }
}

test("backoff handles numeric boundaries without throwing or escaping its cap", () => {
  const boundaries = [
    0,
    -1,
    Number.MAX_SAFE_INTEGER,
    2 ** 53,
    NaN,
    Infinity,
    -Infinity,
  ];

  for (const attempt of boundaries) {
    let delay: number | undefined;
    assert.doesNotThrow(() => {
      delay = backoffMs(attempt);
    }, String(attempt));
    if (Number.isNaN(attempt)) {
      assert.equal(Number.isNaN(delay), true, "NaN remains an inert numeric sentinel");
    } else {
      assert.ok(Number.isFinite(delay));
      assert.ok((delay as number) >= BACKOFF_MIN_MS && (delay as number) <= BACKOFF_MAX_MS);
    }
  }
});

test("forty thousand seeded events preserve state and effect invariants", () => {
  const seeds = [1, 7, 42, 0x12345678, 0x7fffffff, 0x80000000, 0xdeadbeef, 0xffffffff];
  for (const seed of seeds) {
    const next = rng(seed);
    let state = initialConn(HOSTILE_TEXT[next() % HOSTILE_TEXT.length], (next() & 1) === 0);
    assertValidState(state);

    for (let step = 0; step < 5_000; step++) {
      const event = randomEvent(next, step);
      const before = state;
      let transition: ReturnType<typeof reduceConn> | undefined;
      assert.doesNotThrow(() => {
        transition = reduceConn(before, event);
      }, `seed=${seed} step=${step} event=${String((event as { t?: unknown }).t)}`);
      const observed = transition as ReturnType<typeof reduceConn>;
      assertPlain(observed);
      assertValidState(observed.state);
      assertValidEffect(observed.effect, before, observed.state);
      if (before.targetIsSelf && (event.t === "failed" || event.t === "dropped")) {
        assert.notEqual(observed.effect.do, "fallBackToSelf", `self fell back at seed=${seed} step=${step}`);
        assert.notEqual(observed.state.phase, "fellBack", `self entered fellBack at seed=${seed} step=${step}`);
      }
      state = observed.state;
    }
  }
});

test("self retries forever under a long hostile failure stream", () => {
  for (const id of HOSTILE_TEXT) {
    let state = initialConn(id, true);
    for (let attempt = 0; attempt < 2_000; attempt++) {
      const event: ConnEvent = attempt % 2 === 0 ? { t: "failed" } : { t: "dropped" };
      const transition = reduceConn(state, event);
      assert.equal(transition.state.phase, "waiting");
      assert.equal(transition.effect.do, "waitThenRetry");
      assert.equal(transition.state.targetIsSelf, true);
      assert.equal(transition.state.attempts, attempt + 1);
      state = transition.state;
    }
  }
});

test("every phase renders hostile labels as a defined string", () => {
  for (const phase of PHASES) {
    for (const label of HOSTILE_TEXT) {
      const state: ConnState = { ...initialConn("__proto__", false), phase, attempts: 2 };
      let words: string | undefined;
      assert.doesNotThrow(() => {
        words = connInWords(state, label);
      });
      assert.equal(typeof words, "string");
      assert.ok((words as string).length >= label.length);
    }
  }
});
