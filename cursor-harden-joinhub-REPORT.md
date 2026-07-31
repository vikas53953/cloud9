# Hardening `joinhub.ts` — Lane J

**Branch:** `cursor/harden-joinhub` (forked from `origin/master` @ `9375abb`)
**Files added:** `apps/relay/src/joinhub.fuzz.test.ts`, `cursor-harden-joinhub-REPORT.md`
**Files edited:** none. `joinhub.ts` and `server.ts` were read, imported, and left exactly as they were.

---

## What this lane was asked, and what it actually did

`apps/relay/src/joinhub.test.ts` already existed and was already good. It walks the join
token through its life one tidy step at a time: mint it, check it, redeem it, revoke it,
let it expire. Every step in order, every clock reading larger than the last, every code
string a code string.

That is the right test for "does this module do what its comments say". It is the wrong
test for the only situation the module will ever actually be in. A join token is a link
that goes into somebody's chat app and comes back over a network. By the time it reaches
`redeemJoinToken`, four things have stopped being true:

1. **Events do not arrive in the order they happened.** Two friends tap the same link at
   the same moment; one of them is behind a captive portal, so the hub sees the second tap
   first.
2. **Events arrive more than once.** A retried frame, a double-tapped button, a reconnect
   that flushes its outbox — the hub is handed the same "redeem this" twice.
3. **The clock is not monotonic across arrivals.** Every caller stamps its own `now`. A
   replayed frame carries a timestamp from before a deadline that has already passed.
4. **The code is not a code.** It is whatever came off the wire: empty, ten thousand
   characters long, `__proto__`, a null byte, a quote and a semicolon and the word DROP.

So this lane did not add more hand-written scenarios. It added **campaigns**: seeded,
reproducible storms of thousands of mixed events fired at the real module, with a short
list of promises checked after *every single step*.

---

## The shape of the harness

**Seeded, not random.** A `mulberry32` generator means "seed 7, step 412" is a failure
anybody can stand in front of again tomorrow. `Math.random()` would make every red run a
story that cannot be retold.

**An independent oracle, not self-comparison.** A deliberately dumb model (`Map` of
`{expiresAt, revoked, usedBy}`) states what the answer *should* be, and the campaign
compares the module against it — including **which** refusal, not merely that it refused.
The precedence matters as much as the answers: a token that is both revoked and expired
must read "cancelled", because that is the thing the owner did on purpose and the thing
they will ask about.

**A store that behaves like the table it will become.** `ledgerStore()` hands back copies
on read (a caller cannot mutate the row it was shown) and its `spendJoinToken` is a
**guarded** update — the moral equivalent of `UPDATE … WHERE used_by IS NULL` with the
rowcount actually checked. It raises on a second spend. That guard is the point: any
double-spend the module might commit cannot hide behind a last-writer-wins `UPDATE`. It
comes out of the campaign as a thrown error at the exact step that caused it.

**Timestamps that disagree.** Each event picks its own `now`: 15% of the time a laggard
stamp up to 90 seconds *behind* the campaign clock, 10% of the time a leap up to 15
minutes ahead, otherwise a small forward jitter.

**Replays that are byte-identical.** 28% of steps re-deliver an event that already
happened — same code, same user, same stale timestamp. Nothing about the second delivery
may differ in effect from the first.

### The promises checked after every step

| # | Promise |
|---|---|
| 1 | The module's verdict matches the oracle, **category and all** (`unknown` / `cancelled` / `used` / `expired` / `ok`). |
| 2 | No code ever admits two people. Under any interleaving, at any timestamp, after any number of replays. |
| 3 | Death is permanent. Once a token has admitted someone or been revoked, no later call at **any** clock reading — including one rewound to before the token was minted — gets an `ok`. |
| 4 | Checking never spends. The stored row is byte-identical before and after a `checkJoinToken`. |
| 5 | Every refusal is a sentence a person could read: one line, under 240 characters, no `Error`/`undefined`/`[object …]`, no stack frames, and **never the caller's own token text echoed back**. |
| 6 | An admission is recorded against the right person at the right instant. |
| 7 | A revocation lands and never erases an admission that already happened. |

At the end of each campaign there is a final sweep: every buried token is re-checked at six
wildly different clock readings — `0`, `1`, ten million before, now, ten million after, and
`Number.MAX_SAFE_INTEGER` — and none of them may revive it.

---

## Results

**Test file: 18 tests, all passing.** Broken down:

| Group | Tests | What they cover |
|---|---|---|
| Campaigns | 2 | 16 seeds × 600 events each = **9,600 events per pass**, run twice (once for invariants, once to prove the storm exercises all four refusal paths and never produces an unrecognised one) |
| Targeted torture | 3 | never-verifiable-twice across 16 seeds × 80 redemptions; revoked-never-admits at 9 clock readings × 60 attempts × 16 seeds; expired-never-admits with the clock shoved back and forth across the deadline eleven times |
| Concurrency | 4 | 32 racers on one token; a revocation landing mid-race at three different moments; racers straddling the expiry deadline; the split-caller hazard |
| Malformed input | 5 | 65 hostile inputs total — 35 garbage strings, 16 non-string values, 14 near-misses of a real live token |
| PROVE FAIL | 4 | see below |

**Whole relay suite after the change: 291 tests, 287 pass, 0 fail, 3 skipped, 1 todo.**
(273 before this lane; nothing that existed changed its result.)
**`npm run build` at the repo root: clean**, including the desktop typecheck.

---

## Proving it can fail

A fuzz harness that cannot go red is worse than no harness: it is a green light wired to
nothing. This was proved two ways.

### 1. Live, once, on the record

The main campaign was temporarily pointed at `forgetfulStore()` — a store whose
`spendJoinToken` is a no-op, modelling an `UPDATE` that matched zero rows and nobody
checked. Rebuilt, run, and it went red:

```
✖ fuzz: single-use, expiry and revoke hold across 16 seeded storms …
  AssertionError: 6315 invariant violations across 9600 events:
    seed 1 step 1: admission was not recorded against the right person — code=join_PnDVgohSfxtMOnxO3rPRnw stored=undefined
    seed 1 step 2: verdict disagrees with the model — code=join_PnDVgohSfxtMOnxO3rPRnw now=1007162 model=used module=ok
    seed 1 step 2: a dead token came back to life — code=join_PnDVgohSfxtMOnxO3rPRnw now=1007162 was spent or revoked earlier
    …
  6315 !== 0
ℹ pass 17  ℹ fail 1
```

Then reverted, rebuilt, and back to 18/18. The single-character change that turns a
single-use link into an unlimited one is caught by the second event of the first seed.

### 2. Permanently, in the file

Four `PROVE FAIL:` tests keep that teeth-check running forever, so it cannot rot:

- **a store that forgets to record a spend** — the campaign must report a
  `one token admitted two people` violation.
- **a store whose reads lag behind its writes** (a cache, a read replica, a row held across
  an `await`) — spends and revocations that nobody can see are the same as none, and the
  campaign must catch the resurrection.
- **a guarded store raises on a second spend** — asserts the store the whole campaign runs
  on is genuinely the kind that cannot let a silent double-spend through.
- **an expired, unrevoked, never-used token still refuses** — the plainest statement of the
  promise, on its own line, so an expiry regression cannot hide inside a fuzz summary. It
  also asserts `spendAttempts() === 0`: an expired token must never even reach the store's
  write path.

---

## What the module got right

Everything asked of it. Specifically, and non-obviously:

**Single use is atomic by construction.** `redeemJoinToken` does the check and the burn in
one synchronous call, so on one Node thread there is no gap to interleave. 32 concurrent
racers, all genuinely suspended before touching the store and resumed in the scheduler's
order, produce exactly one winner and 31 identical "already been used" refusals — and the
guarded store's second-spend trap never fires, meaning the module never even *attempted* a
double spend.

**Death precedes deadline.** `checkJoinToken` asks "revoked?" then "used?" then "expired?"
The ordering is what makes rewinding the clock useless against a spent token: once someone
has come through, a stale timestamp from before the expiry still gets "already been used",
not `ok`. That is the single most important line in the file for replay safety, and it
holds under every interleaving the campaign produced.

**Refusals are constant and non-reflecting.** All 65 hostile inputs — including a
10,000-character string, a Cyrillic homoglyph of the `join_` prefix, CRLF injection, and
`__proto__` — return the *identical* sentence. Not one of them throws. Nothing the caller
sent appears in what they get back, so a garbage code cannot smuggle content into a log
line or a toast.

**Matching is exact.** No trimming, no case folding, no prefix guessing. ` join_ABC…`,
`JOIN_abc…`, `join_%`, and the real code minus its last character are all simply unknown.
A store keyed by a `Map` also means `__proto__` reaches nothing.

**Garbage traffic cannot touch a real token.** Firing every malformed input at
`redeemJoinToken` and `revokeJoinToken` beside a live token leaves it unspent, unrevoked,
and still good.

---

## Findings for whoever wires this up

None of these are defects in `joinhub.ts`. All of them are constraints the module's purity
pushes onto its caller, and every one of them is a way to lose the guarantees above without
changing a line of this file.

**1. `now` must come from the server's own clock, never from the wire.** The module is pure:
it evaluates expiry against the timestamp it is handed, per call. Expiry is not latched. A
caller that forwards a client-supplied `now` hands anyone holding an expired link a trivial
way to revive it — pass a smaller number. (A *spent* token is safe either way, per the
ordering above; an unspent expired one is not.) The handler should call `Date.now()` itself
and pass nothing else. This is nailed down by the rewind test.

**2. Do not split the check from the spend.** There is a test in the file that does exactly
that — `checkJoinToken`, `await`, `store.spendJoinToken` — and demonstrates two people
getting in. It exists so that the day someone "helpfully" refactors the handler into those
two steps around an `await`, or moves the store behind an async driver, a test is standing
there explaining precisely what they broke. Keep the redemption one call.

**3. The real store's spend must be a guarded update.** `UPDATE join_tokens SET used_by=?,
used_at=? WHERE code=? AND used_by IS NULL`, with the changed-row count checked. The module
does not need it to be correct today. It is the seatbelt for the day something else is.

**4. Nothing here throttles guessing.** 128 bits from `secureId` makes brute force
hopeless, so this is not urgent — but the module counts nothing and the hub will need a
failed-redemption limit anyway, at the connection layer, not in here.

**5. Revoking an unknown code is a silent no-op.** Correct for idempotency under replay
(and the campaign leans on it). Worth remembering that it means an owner who revokes a
mistyped code gets told nothing went wrong. That is a UI concern, not a store one.

---

## How to run it

```bash
npm install
npm run build                      # or: npm run build -w @cloud9/relay
node --test apps/relay/dist/joinhub.fuzz.test.js
```

To reproduce a violation the campaign reports, the seed and step number in the message are
all that is needed — the generator is deterministic, so `runCampaign({ seed, steps, store })`
replays the identical storm.
