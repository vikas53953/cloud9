// Hardening `joinhub.ts`: does single-use / expiry / revoke still hold when the
// world stops being polite?
//
// `joinhub.test.ts` next door already walks the happy sequence — mint, check,
// redeem, revoke — one tidy step at a time, each with a clock that only ever
// moves forward. That is the right shape for "does this module do what it
// says". It is the wrong shape for the question a join token actually faces
// once it is a link sitting in somebody's chat app:
//
//   - The events do NOT arrive in the order they happened. Two friends click
//     the same link at once; one of them is on a phone that spent four seconds
//     in a captive portal, so the hub sees the second click first.
//   - The events arrive MORE THAN ONCE. A retried websocket frame, a
//     double-tapped button, a reconnect that replays its outbox — the hub is
//     handed the same "redeem this" twice and must not admit two people.
//   - The clock is NOT monotonic across arrivals. Each caller stamps its own
//     `now`; a replayed frame carries a `now` from before an expiry that has
//     already been decided. A token that has died must not come back to life
//     just because a stale timestamp asked nicely.
//   - The code string is NOT a code. It is whatever came off the wire:
//     empty, ten thousand characters, `__proto__`, a null byte, a quote and a
//     semicolon and the word DROP.
//
// So this file does not write scenarios by hand. It runs CAMPAIGNS: seeded,
// reproducible streams of thousands of mixed events — mints, checks,
// redemptions, revocations, replays of earlier events verbatim, timestamps
// that jitter backwards — against the real module and a store that behaves
// the way a SQLite table would, and it checks after EVERY single step that a
// short list of promises still holds:
//
//   1. The module's answer matches an independent model of what the answer
//      should be, including WHICH refusal (unknown / cancelled / used /
//      expired), not merely that it refused.
//   2. No code ever admits two people. Ever. Under any interleaving.
//   3. Death is permanent: once a token has admitted someone, or has been
//      revoked, no later call at ANY timestamp — including one rewound to
//      before the token was born — gets an `ok` back.
//   4. Every refusal is a sentence a person could read. No stack traces, no
//      `[object Object]`, no `undefined`, and never the caller's own garbage
//      echoed back at them.
//
// And because a fuzz harness that cannot fail is worse than no harness at all
// — it is a green light wired to nothing — the PROVE FAIL block at the bottom
// hands the SAME campaign a deliberately broken store and demands that it go
// red. If those tests ever start passing quietly, the teeth have fallen out.
//
// Nothing here edits `joinhub.ts`. The module under test is imported whole,
// from the real file, exactly as `server.ts` would import it.
import test from "node:test";
import assert from "node:assert/strict";
import {
  JoinHubStore,
  JoinTokenResult,
  JoinTokenRow,
  checkJoinToken,
  mintJoinToken,
  redeemJoinToken,
  revokeJoinToken,
} from "./joinhub.js";

// ---------------------------------------------------------------------------
// A reproducible coin. `Math.random()` would make every red run a story nobody
// can retell; a seeded generator means a violation reported at seed 7, step
// 412 is a violation anyone can stand in front of again.

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

function intBetween(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

// ---------------------------------------------------------------------------
// Stores.
//
// The module takes a `JoinHubStore` and does the arithmetic against it, so the
// store is where a real deployment's sharp edges live. Three of them here: one
// that behaves, two that misbehave in the two ways a real one plausibly would.

/**
 * What the conductor's SQLite table will act like, including the parts that
 * would bite: reads hand back a COPY (a caller cannot mutate the row it was
 * shown), and `spendJoinToken` is a guarded update — `WHERE used_by IS NULL` —
 * that raises rather than silently overwriting if the row was already spent.
 *
 * That guard is the point. It means any double-spend the module might commit
 * cannot hide behind a last-writer-wins UPDATE; it comes out of these tests as
 * a thrown error at the exact step that caused it.
 */
function ledgerStore(): JoinHubStore & { spendAttempts(): number } {
  const rows = new Map<string, JoinTokenRow>();
  let attempts = 0;
  return {
    insertJoinToken(row) {
      if (rows.has(row.code)) throw new Error("duplicate join token code");
      rows.set(row.code, { ...row, revoked: false });
    },
    joinToken(code) {
      const row = rows.get(code);
      return row ? { ...row } : undefined;
    },
    spendJoinToken(code, usedBy, usedAt) {
      attempts++;
      const row = rows.get(code);
      if (!row) throw new Error("no such join token");
      if (row.usedBy !== undefined) {
        throw new Error(`join token spent twice: ${code} was ${row.usedBy}, now ${usedBy}`);
      }
      rows.set(code, { ...row, usedBy, usedAt });
    },
    revokeJoinToken(code) {
      const row = rows.get(code);
      if (row) rows.set(code, { ...row, revoked: true });
    },
    spendAttempts: () => attempts,
  };
}

/**
 * MUTANT (used only by the PROVE FAIL block): an `UPDATE` that matched zero
 * rows and nobody checked. The write is accepted and thrown away, so the token
 * is still unspent the next time anyone looks — the exact bug that turns a
 * single-use link into an unlimited one.
 */
function forgetfulStore(): JoinHubStore {
  const inner = ledgerStore();
  return {
    insertJoinToken: (row) => inner.insertJoinToken(row),
    joinToken: (code) => inner.joinToken(code),
    spendJoinToken: () => {},
    revokeJoinToken: (code) => inner.revokeJoinToken(code),
  };
}

/**
 * MUTANT (PROVE FAIL only): reads served from a snapshot taken before the
 * write — a cache, a read replica, a row the handler held onto across an
 * await. Spends and revocations really happen; they are just invisible to the
 * next question anyone asks, which is indistinguishable from not happening.
 */
function staleReadStore(): JoinHubStore {
  const live = new Map<string, JoinTokenRow>();
  const snapshot = new Map<string, JoinTokenRow>();
  return {
    insertJoinToken(row) {
      const fresh: JoinTokenRow = { ...row, revoked: false };
      live.set(row.code, fresh);
      snapshot.set(row.code, { ...fresh });
    },
    joinToken(code) {
      const row = snapshot.get(code);
      return row ? { ...row } : undefined;
    },
    spendJoinToken(code, usedBy, usedAt) {
      const row = live.get(code);
      if (row) live.set(code, { ...row, usedBy, usedAt });
    },
    revokeJoinToken(code) {
      const row = live.get(code);
      if (row) live.set(code, { ...row, revoked: true });
    },
  };
}

// ---------------------------------------------------------------------------
// The oracle: what SHOULD the module say?
//
// Kept as a separate, deliberately dumb model so the campaign is comparing the
// module against an independent statement of the rule, not against itself.
// The ORDER matters as much as the answers: a token that is both revoked and
// expired must say "cancelled", because that is the thing the owner did on
// purpose and the thing they will be asked about.

type Verdict = "ok" | "unknown" | "revoked" | "used" | "expired";

interface ModelRow {
  createdAt: number;
  expiresAt: number;
  revoked: boolean;
  usedBy?: string;
}

function expectedVerdict(model: Map<string, ModelRow>, code: string, now: number): Verdict {
  const row = model.get(code);
  if (!row) return "unknown";
  if (row.revoked) return "revoked";
  if (row.usedBy !== undefined) return "used";
  if (now >= row.expiresAt) return "expired";
  return "ok";
}

/**
 * Read the module's answer back as a category. This is where the plain-words
 * promise is enforced from the other side: a refusal whose wording matches
 * none of the four known sentences is not "some other refusal", it is a bug —
 * either a new failure mode nobody told the person about, or a raw error
 * leaking through the seam.
 */
function actualVerdict(result: JoinTokenResult): Verdict | "UNRECOGNISED" {
  if (result.ok) return "ok";
  const reason = result.reason;
  if (/isn't valid/.test(reason)) return "unknown";
  if (/was cancelled/.test(reason)) return "revoked";
  if (/already been used/.test(reason)) return "used";
  if (/has expired/.test(reason)) return "expired";
  return "UNRECOGNISED";
}

/**
 * A refusal a person could read out loud. Not a stack, not a type name, not a
 * hundred lines, and — the one that matters for a value arriving off a wire —
 * never the caller's own input echoed back into a message that might end up in
 * a log or a toast.
 */
function reasonIsPlain(reason: string, input?: string): string | null {
  if (typeof reason !== "string") return `reason is ${typeof reason}, not a string`;
  if (reason.trim().length === 0) return "reason is blank";
  if (reason.length > 240) return `reason is ${reason.length} characters long`;
  if (/[\r\n]/.test(reason)) return "reason spans multiple lines";
  if (/\b(Error|TypeError|RangeError|Exception|undefined|null|NaN)\b/.test(reason)) {
    return `reason leaks a machine word: ${reason}`;
  }
  if (/\[object |at .+:\d+:\d+/.test(reason)) return `reason leaks internals: ${reason}`;
  if (input !== undefined && input.length >= 8 && reason.includes(input)) {
    return "reason echoes the caller's own token text back at them";
  }
  return null;
}

// ---------------------------------------------------------------------------
// The campaign.

interface Violation {
  seed: number;
  step: number;
  what: string;
  detail: string;
}

type Event =
  | { kind: "check"; code: string; now: number }
  | { kind: "redeem"; code: string; user: string; now: number }
  | { kind: "revoke"; code: string };

interface CampaignResult {
  violations: Violation[];
  events: number;
  mints: number;
  admissions: number;
  refusals: Record<Verdict | "UNRECOGNISED", number>;
}

/**
 * Run one seeded storm of events at a store and report — rather than throw —
 * everything that broke. Reporting instead of throwing is what lets the PROVE
 * FAIL block below run the identical campaign against a broken store and
 * assert that it DID find something.
 */
function runCampaign(opts: { seed: number; steps: number; store: JoinHubStore }): CampaignResult {
  const { seed, steps, store } = opts;
  const rng = mulberry32(seed);
  const violations: Violation[] = [];

  const model = new Map<string, ModelRow>();
  const codes: string[] = [];
  const history: Event[] = [];
  /** Every user each code has successfully admitted. Length must never exceed 1. */
  const admittedBy = new Map<string, string[]>();
  /** Codes that are dead for good — spent or revoked. Nothing revives these. */
  const buried = new Set<string>();

  let clock = 1_000_000;
  let mints = 0;
  let admissions = 0;
  const refusals: Record<Verdict | "UNRECOGNISED", number> = {
    ok: 0, unknown: 0, revoked: 0, used: 0, expired: 0, UNRECOGNISED: 0,
  };

  const note = (step: number, what: string, detail: string) =>
    violations.push({ seed, step, what, detail });

  /** Timestamps that do not agree with each other — the whole point. */
  const stampFor = (): number => {
    const roll = rng();
    if (roll < 0.15) return clock - intBetween(rng, 1, 90_000); // a laggard frame
    if (roll < 0.25) return clock + intBetween(rng, 60_000, 900_000); // a leap past expiry
    return clock + intBetween(rng, 0, 4_000);
  };

  /**
   * The one check that runs after EVERY event, whatever it was. Verdict
   * against the oracle, permanence of death, and plainness of the words.
   */
  const audit = (step: number, code: string, now: number, result: JoinTokenResult) => {
    const want = expectedVerdict(model, code, now);
    const got = actualVerdict(result);
    refusals[got]++;
    if (got !== want) {
      note(step, "verdict disagrees with the model", `code=${code} now=${now} model=${want} module=${got}`);
    }
    if (!result.ok) {
      const complaint = reasonIsPlain(result.reason, code);
      if (complaint) note(step, "refusal is not plain words", complaint);
    }
    if (result.ok && buried.has(code)) {
      note(step, "a dead token came back to life", `code=${code} now=${now} was spent or revoked earlier`);
    }
  };

  for (let step = 0; step < steps; step++) {
    clock += intBetween(rng, 0, 5_000);

    // Replay: with real frequency, re-deliver an event that already happened,
    // byte for byte, stale timestamp and all. Nothing about the second
    // delivery may differ in effect from the first.
    const replaying = history.length > 0 && rng() < 0.28;
    const roll = rng();

    let event: Event;
    if (replaying) {
      event = history[Math.floor(rng() * history.length)]!;
    } else if (codes.length === 0 || roll < 0.14) {
      // mint
      const owner = `u_owner_${intBetween(rng, 1, 3)}`;
      const ttl = pick(rng, [1, 1_000, 60_000, 15 * 60_000]);
      const at = stampFor();
      const code = mintJoinToken(store, owner, at, ttl);
      mints++;
      if (model.has(code)) {
        note(step, "mint handed back a code that already existed", code);
      }
      model.set(code, { createdAt: at, expiresAt: at + ttl, revoked: false });
      codes.push(code);
      if (!/^join_[A-Za-z0-9_-]{16,}$/.test(code)) {
        note(step, "mint handed back a code of the wrong shape", code);
      }
      continue;
    } else if (roll < 0.45) {
      event = { kind: "check", code: pick(rng, codes), now: stampFor() };
    } else if (roll < 0.9) {
      event = { kind: "redeem", code: pick(rng, codes), user: `u_guest_${intBetween(rng, 1, 40)}`, now: stampFor() };
    } else {
      event = { kind: "revoke", code: pick(rng, codes) };
    }

    if (!replaying) history.push(event);

    if (event.kind === "check") {
      const before = store.joinToken(event.code);
      const result = checkJoinToken(store, event.code, event.now);
      audit(step, event.code, event.now, result);
      const after = store.joinToken(event.code);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        note(step, "checking a token changed it", `code=${event.code}`);
      }
      continue;
    }

    if (event.kind === "revoke") {
      revokeJoinToken(store, event.code);
      const row = model.get(event.code);
      if (row) row.revoked = true;
      buried.add(event.code);
      // Revocation must land the same way whether the token was fresh, spent,
      // or already revoked — and must never undo an admission that happened.
      const stored = store.joinToken(event.code);
      if (stored && stored.revoked !== true) {
        note(step, "revoke did not stick", `code=${event.code}`);
      }
      const admitted = admittedBy.get(event.code);
      if (admitted && admitted.length === 1 && stored?.usedBy !== admitted[0]) {
        note(step, "revoke erased who had already been admitted", `code=${event.code}`);
      }
      continue;
    }

    // redeem
    const want = expectedVerdict(model, event.code, event.now);
    let result: JoinTokenResult;
    try {
      result = redeemJoinToken(store, event.code, event.user, event.now);
    } catch (err) {
      // A guarded store raising is the loudest possible double-spend signal.
      note(step, "redeem threw instead of refusing", `code=${event.code} ${(err as Error).message}`);
      continue;
    }
    audit(step, event.code, event.now, result);

    if (result.ok) {
      admissions++;
      const list = admittedBy.get(event.code) ?? [];
      list.push(event.user);
      admittedBy.set(event.code, list);
      if (list.length > 1) {
        note(step, "one token admitted two people", `code=${event.code} admitted=${list.join(", ")}`);
      }
      if (want !== "ok") {
        note(step, "redeem admitted someone the model says it should not have", `code=${event.code} model=${want}`);
      }
      const row = model.get(event.code)!;
      row.usedBy = event.user;
      buried.add(event.code);

      const stored = store.joinToken(event.code);
      if (stored?.usedBy !== event.user) {
        note(step, "admission was not recorded against the right person", `code=${event.code} stored=${stored?.usedBy}`);
      }
      if (stored?.usedAt !== event.now) {
        note(step, "admission recorded the wrong instant", `code=${event.code} stored=${stored?.usedAt} event=${event.now}`);
      }
    }
  }

  // A last sweep at the end of time: nothing that died is alive, at any clock
  // reading we can think of — including one from before the token was minted.
  for (const code of codes) {
    if (!buried.has(code)) continue;
    for (const when of [0, 1, clock - 10_000_000, clock, clock + 10_000_000, Number.MAX_SAFE_INTEGER]) {
      const result = checkJoinToken(store, code, when);
      if (result.ok) {
        note(steps, "a buried token verifies at some other clock reading", `code=${code} now=${when}`);
      }
    }
  }

  return { violations, events: steps, mints, admissions, refusals };
}

function describe(violations: Violation[]): string {
  return violations.slice(0, 6).map((v) => `  seed ${v.seed} step ${v.step}: ${v.what} — ${v.detail}`).join("\n");
}

// ---------------------------------------------------------------------------
// The campaigns themselves.

const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597];

test("fuzz: single-use, expiry and revoke hold across 16 seeded storms of mixed, replayed, out-of-order events", () => {
  let totalEvents = 0;
  let totalAdmissions = 0;
  let totalMints = 0;
  const allViolations: Violation[] = [];

  for (const seed of SEEDS) {
    const result = runCampaign({ seed, steps: 600, store: ledgerStore() });
    allViolations.push(...result.violations);
    totalEvents += result.events;
    totalAdmissions += result.admissions;
    totalMints += result.mints;
  }

  assert.equal(
    allViolations.length,
    0,
    `${allViolations.length} invariant violations across ${totalEvents} events:\n${describe(allViolations)}`,
  );
  // Guard against a campaign that proved nothing because it never got going.
  assert.ok(totalMints > 300, `campaign should have minted plenty of tokens, minted ${totalMints}`);
  assert.ok(totalAdmissions > 50, `campaign should have admitted plenty of people, admitted ${totalAdmissions}`);
});

test("fuzz: every refusal category actually gets exercised — the storm is not all one weather", () => {
  const seen: Record<string, number> = { ok: 0, unknown: 0, revoked: 0, used: 0, expired: 0, UNRECOGNISED: 0 };
  for (const seed of SEEDS) {
    const result = runCampaign({ seed, steps: 600, store: ledgerStore() });
    for (const [k, v] of Object.entries(result.refusals)) seen[k] = (seen[k] ?? 0) + v;
  }
  assert.equal(seen.UNRECOGNISED, 0, "every refusal must be one of the four sentences the module promises");
  for (const category of ["ok", "revoked", "used", "expired"] as const) {
    assert.ok(seen[category]! > 0, `the campaign never produced a "${category}" outcome — it is not testing that path`);
  }
});

test("fuzz: a token is never verifiable twice — success is a one-time event per code, whatever the order", () => {
  for (const seed of SEEDS) {
    const store = ledgerStore();
    const rng = mulberry32(seed);
    const code = mintJoinToken(store, "u_owner", 1000, 10_000);

    // Forty attempts, timestamps all over the place, some of them replays of
    // an earlier attempt verbatim, one revoke dropped in at a random point.
    const attempts: Array<{ user: string; now: number }> = [];
    for (let i = 0; i < 40; i++) {
      attempts.push({ user: `u_guest_${i}`, now: intBetween(rng, 0, 20_000) });
    }
    const revokeAt = intBetween(rng, 0, 39);

    let wins = 0;
    for (let i = 0; i < attempts.length; i++) {
      if (i === revokeAt) revokeJoinToken(store, code);
      const a = attempts[i]!;
      const result = redeemJoinToken(store, code, a.user, a.now);
      if (result.ok) wins++;
      // and the same attempt delivered a second time
      const replay = redeemJoinToken(store, code, a.user, a.now);
      if (replay.ok) wins++;
    }
    assert.ok(wins <= 1, `seed ${seed}: one token verified ${wins} times`);
  }
});

test("fuzz: a revoked token never admits anyone, at any timestamp, however many times it is asked", () => {
  for (const seed of SEEDS) {
    const store = ledgerStore();
    const rng = mulberry32(seed);
    const code = mintJoinToken(store, "u_owner", 1000, 60_000);
    revokeJoinToken(store, code);
    for (let i = 0; i < 60; i++) {
      const now = pick(rng, [0, 1, 999, 1000, 1001, 30_000, 60_999, 61_000, Number.MAX_SAFE_INTEGER]);
      const result = redeemJoinToken(store, code, `u_guest_${i}`, now);
      assert.equal(result.ok, false, `seed ${seed}: a revoked token admitted someone at ${now}`);
      if (!result.ok) assert.match(result.reason, /was cancelled/);
    }
    assert.equal(store.joinToken(code)?.usedBy, undefined, "a revoked token must have admitted nobody");
  }
});

test("fuzz: an expired token never admits anyone once the deadline has passed, even after the clock is rewound and pushed forward again", () => {
  const store = ledgerStore();
  const code = mintJoinToken(store, "u_owner", 0, 1_000);

  // Dead as of 1000. Now shove the clock back and forth over that line many
  // times. The module reads the clock it is handed, so a rewound stamp before
  // the deadline is genuinely still inside the window — that is correct and
  // deliberate. What must never happen is the reverse: a stamp at or past the
  // deadline getting an `ok`.
  for (const now of [1_000, 1_001, 999, 500, 5_000, 999, 0, 1_000, 60_000, 1, 1_000_000]) {
    const result = checkJoinToken(store, code, now);
    if (now >= 1_000) {
      assert.equal(result.ok, false, `an expired token verified at ${now}`);
      if (!result.ok) assert.match(result.reason, /has expired/);
    } else {
      assert.equal(result.ok, true, `a token inside its window refused at ${now}`);
    }
  }

  // And once anybody actually comes through, rewinding stops helping at all —
  // "already used" is checked before the deadline is.
  const admitted = redeemJoinToken(store, code, "u_friend", 500);
  assert.equal(admitted.ok, true);
  for (const now of [0, 1, 499, 500, 999, 1_000, 10_000]) {
    const again = checkJoinToken(store, code, now);
    assert.equal(again.ok, false, `a spent token verified again at ${now}`);
    if (!again.ok) assert.match(again.reason, /already been used/);
  }
});

// ---------------------------------------------------------------------------
// Concurrency.
//
// `redeemJoinToken` is synchronous, which on one Node thread means the gap
// between "is this good?" and "burn it" cannot be interleaved. That is a
// property worth pinning down rather than assuming, because it is the entire
// reason the function exists as one call instead of two.

test("concurrent: thirty-two callers race one token and exactly one is admitted", async () => {
  const store = ledgerStore();
  const code = mintJoinToken(store, "u_owner", 1_000, 60_000);

  const racers = Array.from({ length: 32 }, (_, i) => `u_racer_${i}`);
  const results = await Promise.all(
    racers.map(async (user, i) => {
      // Every racer suspends at least once before touching the store, so all
      // thirty-two are genuinely in flight together, then they resume in an
      // order the scheduler picks, not the one they started in.
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, i % 3));
      return redeemJoinToken(store, code, user, 2_000);
    }),
  );

  const winners = results.filter((r): r is Extract<JoinTokenResult, { ok: true }> => r.ok);
  assert.equal(winners.length, 1, `${winners.length} racers were admitted through one join token`);
  const losers = results.filter((r) => !r.ok);
  assert.equal(losers.length, 31);
  for (const loser of losers) {
    if (!loser.ok) assert.match(loser.reason, /already been used/);
  }
  assert.ok(store.joinToken(code)?.usedBy?.startsWith("u_racer_"));
});

test("concurrent: a revocation landing mid-race stops every racer that has not already come through", async () => {
  for (const revokeAfterMs of [0, 1, 2]) {
    const store = ledgerStore();
    const code = mintJoinToken(store, "u_owner", 1_000, 60_000);

    const race = Promise.all(
      Array.from({ length: 16 }, async (_, i) => {
        await new Promise((r) => setTimeout(r, i));
        return redeemJoinToken(store, code, `u_racer_${i}`, 2_000);
      }),
    );
    const revocation = (async () => {
      await new Promise((r) => setTimeout(r, revokeAfterMs));
      revokeJoinToken(store, code);
    })();

    const [results] = await Promise.all([race, revocation]);
    const winners = results.filter((r) => r.ok);
    assert.ok(winners.length <= 1, `${winners.length} racers admitted while a revocation was landing`);
    assert.equal(store.joinToken(code)?.revoked, true);
  }
});

test("concurrent: racers straddling the expiry deadline — nobody past it gets in, and at most one gets in at all", async () => {
  const store = ledgerStore();
  const code = mintJoinToken(store, "u_owner", 0, 5_000);

  const stamps = [4_998, 5_000, 4_999, 6_000, 5_001, 4_997, 9_999, 5_000];
  const results = await Promise.all(
    stamps.map(async (now, i) => {
      await new Promise((r) => setTimeout(r, i % 2));
      return { now, result: redeemJoinToken(store, code, `u_racer_${i}`, now) };
    }),
  );

  const winners = results.filter((r) => r.result.ok);
  assert.ok(winners.length <= 1, `${winners.length} racers admitted through one token`);
  for (const { now, result } of results) {
    if (now >= 5_000) assert.equal(result.ok, false, `a racer stamped ${now} got in past the deadline`);
  }
});

test("concurrent: splitting check from spend across an await double-admits — which is why redeemJoinToken is one call", async () => {
  // This test does not exercise a bug in `joinhub.ts`. It nails down the
  // hazard the module's shape exists to prevent, so that the day someone
  // "helpfully" refactors the handler into `checkJoinToken(...)` / await /
  // `store.spendJoinToken(...)`, there is a test standing there explaining
  // exactly what they just broke.
  const store = ledgerStore();
  const code = mintJoinToken(store, "u_owner", 1_000, 60_000);

  let checksThatPassed = 0;
  let secondSpendRejected = false;

  await Promise.all(
    ["u_alice", "u_mallory"].map(async (user) => {
      const check = checkJoinToken(store, code, 2_000);
      await new Promise((r) => setTimeout(r, 1)); // the fatal gap
      if (!check.ok) return;
      checksThatPassed++;
      try {
        store.spendJoinToken(code, user, 2_000);
      } catch {
        secondSpendRejected = true;
      }
    }),
  );

  assert.equal(checksThatPassed, 2, "both naive callers pass their check before either spends — that is the hazard");
  assert.ok(secondSpendRejected, "a guarded store must be the thing that catches the split-caller's second spend");

  // The same two callers, going through the module instead: one winner, no
  // guard needed, no exception anywhere.
  const store2 = ledgerStore();
  const code2 = mintJoinToken(store2, "u_owner", 1_000, 60_000);
  const safe = await Promise.all(
    ["u_alice", "u_mallory"].map(async (u) => {
      await new Promise((r) => setTimeout(r, 1));
      return redeemJoinToken(store2, code2, u, 2_000);
    }),
  );
  assert.equal(safe.filter((r) => r.ok).length, 1);
});

// ---------------------------------------------------------------------------
// Malformed token strings.
//
// Everything below arrives as `code` off a websocket frame. None of it is a
// token. All of it must come back as the same flat, unhelpful, non-echoing
// refusal — and none of it may throw, because a throw here is a crashed
// connection handler, which is a denial of service anyone can trigger with a
// four-character string.

const MALFORMED: ReadonlyArray<[label: string, code: string]> = [
  ["empty", ""],
  ["one space", " "],
  ["whitespace only", "\t\r\n  "],
  ["bare prefix", "join_"],
  ["prefix without underscore", "join"],
  ["an invite code, not a join token", "inv_9f8a7b6c5d4e3f2a"],
  ["prototype key", "__proto__"],
  ["constructor", "constructor"],
  ["prototype", "prototype"],
  ["toString", "toString"],
  ["hasOwnProperty", "hasOwnProperty"],
  ["valueOf", "valueOf"],
  ["a number as text", "0"],
  ["a negative number as text", "-1"],
  ["the word null", "null"],
  ["the word undefined", "undefined"],
  ["NaN", "NaN"],
  ["embedded null byte", "join_abc\u0000def"],
  ["percent-encoded null", "join_%00"],
  ["posix traversal", "join_../../../../etc/passwd"],
  ["windows traversal", "..\\..\\..\\windows\\system32\\config\\sam"],
  ["sql tautology", "join_' OR 1=1 --"],
  ["sql drop", 'join_"; DROP TABLE join_tokens; --'],
  ["script tag", "<script>alert(1)</script>"],
  ["format string", "%s%s%s%n%x"],
  ["json object", '{"code":"join_x","revoked":false}'],
  ["crlf injection", "join_ABC\r\nX-Admin: true"],
  ["ten thousand characters", `join_${"A".repeat(10_000)}`],
  ["emoji", "🙂".repeat(64)],
  ["right-to-left override", "join_\u202Egnol"],
  ["zero-width joiner", "join_\u200Dabc"],
  ["combining marks", "join_a\u0301\u0301\u0301\u0301"],
  ["homoglyph prefix", "jоin_abcdefghijklmnop"], // that 'о' is Cyrillic
  ["newline-separated pair", "join_aaa\njoin_bbb"],
  ["a very deep nesting", "(".repeat(5_000)],
];

test("malformed: no garbage token string ever throws, and none of it is ever mistaken for a token", () => {
  const store = ledgerStore();
  mintJoinToken(store, "u_owner", 1_000, 60_000); // a real token exists alongside

  for (const [label, code] of MALFORMED) {
    let checked: JoinTokenResult | undefined;
    assert.doesNotThrow(() => {
      checked = checkJoinToken(store, code, 2_000);
    }, `checkJoinToken threw on ${label}`);
    assert.ok(checked, `no result for ${label}`);
    assert.equal(checked!.ok, false, `${label} was accepted as a valid join token`);
    if (!checked!.ok) {
      assert.match(checked!.reason, /isn't valid/, `${label} got the wrong refusal`);
      assert.equal(reasonIsPlain(checked!.reason, code), null, `${label}: refusal was not plain words`);
    }

    let redeemed: JoinTokenResult | undefined;
    assert.doesNotThrow(() => {
      redeemed = redeemJoinToken(store, code, "u_attacker", 2_000);
    }, `redeemJoinToken threw on ${label}`);
    assert.equal(redeemed!.ok, false, `${label} admitted someone`);

    assert.doesNotThrow(() => revokeJoinToken(store, code), `revokeJoinToken threw on ${label}`);
  }
});

test("malformed: every garbage string gets the SAME refusal — the message never reflects what was sent", () => {
  const store = ledgerStore();
  const reasons = new Set<string>();
  for (const [, code] of MALFORMED) {
    const result = checkJoinToken(store, code, 2_000);
    if (!result.ok) reasons.add(result.reason);
  }
  assert.equal(
    reasons.size,
    1,
    `an unknown code must always read the same way, got ${reasons.size} different messages: ${[...reasons].join(" | ")}`,
  );
});

test("malformed: values that are not strings at all are refused rather than crashing the handler", () => {
  const store = ledgerStore();
  const throwingToString = { toString() { throw new Error("boom"); } };
  const notStrings: unknown[] = [
    undefined, null, 0, -1, NaN, Infinity, true, false, {}, [], [1, 2, 3],
    Object.create(null), throwingToString, () => "join_x", new Date(0), Symbol.iterator,
  ];
  for (const value of notStrings) {
    const code = value as unknown as string;
    let result: JoinTokenResult | undefined;
    assert.doesNotThrow(() => {
      result = checkJoinToken(store, code, 2_000);
    }, `checkJoinToken threw on ${String(typeof value)}`);
    assert.equal(result!.ok, false);
    assert.doesNotThrow(() => {
      redeemJoinToken(store, code, "u_attacker", 2_000);
    });
  }
});

test("malformed: near-misses of a real, live token are refused — no trimming, no case folding, no prefix guessing", () => {
  const store = ledgerStore();
  const real = mintJoinToken(store, "u_owner", 1_000, 60_000);
  assert.equal(checkJoinToken(store, real, 2_000).ok, true, "the real token should be good, or this test proves nothing");

  const body = real.slice("join_".length);
  const flipped = body === body.toUpperCase() ? body.toLowerCase() : body.toUpperCase();
  const nearMisses: ReadonlyArray<[string, string]> = [
    ["leading space", ` ${real}`],
    ["trailing space", `${real} `],
    ["wrapped in spaces", `  ${real}  `],
    ["a newline glued on", `${real}\n`],
    ["case flipped", `join_${flipped}`],
    ["prefix uppercased", `JOIN_${body}`],
    ["prefix doubled", `join_join_${body}`],
    ["prefix stripped", body],
    ["one character short", real.slice(0, -1)],
    ["one character longer", `${real}A`],
    ["last character changed", `${real.slice(0, -1)}${real.endsWith("A") ? "B" : "A"}`],
    ["sql wildcard", "join_%"],
    ["sql single-char wildcard", `join_${"_".repeat(body.length)}`],
    ["regex wildcard", "join_.*"],
  ];

  for (const [label, candidate] of nearMisses) {
    if (candidate === real) continue; // a case flip on an all-digit body could collide
    const result = checkJoinToken(store, candidate, 2_000);
    assert.equal(result.ok, false, `${label} was accepted — the module is matching leniently`);
    if (!result.ok) assert.match(result.reason, /isn't valid/, `${label} got the wrong refusal`);
  }

  // and the real one is untouched by every one of those attempts
  assert.equal(checkJoinToken(store, real, 2_000).ok, true, "probing near-misses must not disturb the real token");
});

test("malformed: a garbage code cannot burn, revive or reach a real token", () => {
  const store = ledgerStore();
  const real = mintJoinToken(store, "u_owner", 1_000, 60_000);
  for (const [, code] of MALFORMED) {
    redeemJoinToken(store, code, "u_attacker", 2_000);
    revokeJoinToken(store, code);
  }
  const row = store.joinToken(real);
  assert.equal(row?.usedBy, undefined, "garbage traffic spent a real token");
  assert.equal(row?.revoked, false, "garbage traffic revoked a real token");
  assert.equal(checkJoinToken(store, real, 2_000).ok, true, "the real token survived none of that");
});

// ---------------------------------------------------------------------------
// PROVE FAIL.
//
// Everything above is only worth reading if it can go red. These four run the
// same machinery against deliberately broken stores and against the real
// module's own guarantees, and DEMAND a failure. A green suite where these
// pass silently would mean the campaign has stopped checking anything.

test("PROVE FAIL: the campaign catches a store that forgets to record a spend — the unlimited-link bug", () => {
  const result = runCampaign({ seed: 4242, steps: 400, store: forgetfulStore() });
  assert.ok(
    result.violations.length > 0,
    "a store that silently drops spends must be caught — if this passes, the campaign is checking nothing",
  );
  const doubleAdmission = result.violations.some((v) => v.what === "one token admitted two people");
  assert.ok(
    doubleAdmission,
    `expected a double-admission violation, got:\n${describe(result.violations)}`,
  );
});

test("PROVE FAIL: the campaign catches a store whose reads lag behind its writes", () => {
  const result = runCampaign({ seed: 4243, steps: 400, store: staleReadStore() });
  assert.ok(
    result.violations.length > 0,
    "a store serving stale reads must be caught — spends and revocations that nobody can see are the same as none",
  );
  assert.ok(
    result.violations.some((v) => v.what === "one token admitted two people" || v.what === "a dead token came back to life"),
    `expected a resurrection or double admission, got:\n${describe(result.violations)}`,
  );
});

test("PROVE FAIL: a guarded store raises the moment anything spends a token twice", () => {
  const store = ledgerStore();
  const code = mintJoinToken(store, "u_owner", 1_000, 60_000);
  store.spendJoinToken(code, "u_alice", 1_500);
  assert.throws(
    () => store.spendJoinToken(code, "u_mallory", 1_600),
    /spent twice/,
    "the store the whole campaign runs on must reject a second spend — that is what makes a silent double-spend impossible to miss",
  );
});

test("PROVE FAIL: an expired, unrevoked, never-used token still refuses — time alone kills a join link", () => {
  const store = ledgerStore();
  const code = mintJoinToken(store, "u_owner", 0, 1_000);
  // Nobody revoked it, nobody spent it, and the storm above is not involved.
  // The plainest statement of the promise, on its own line, so that a
  // regression in expiry cannot hide inside a fuzz summary.
  for (const now of [1_000, 1_001, 60_000, Date.now()]) {
    const result = redeemJoinToken(store, code, "u_friend", now);
    assert.equal(result.ok, false, `an expired join token redeemed at ${now}`);
    if (!result.ok) assert.match(result.reason, /has expired/);
  }
  assert.equal(store.joinToken(code)?.usedBy, undefined);
  assert.equal(store.spendAttempts(), 0, "an expired token must never reach the store's spend path at all");
});
