# Cloud9 Lane H — hub hardening report

Branch: `cursor/harden-hub`

## Scope

Only four path-imported fuzz suites were added. Production modules and existing tests were not edited.

- `packages/shared/src/hubaddress.fuzz.test.ts`
- `packages/shared/src/hubbook.fuzz.test.ts`
- `packages/shared/src/hubconnection.fuzz.test.ts`
- `packages/shared/src/notify.fuzz.test.ts`

## Hostile-input counts

- Hub address: 32 parser values, 32 IPv4/IPv6 boundaries, 16 hostile host strings, 7 safe round-trips, and all 4 reach values.
- Hub book: 20 malformed persisted shapes, 72 hostile edit calls, and complete add/switch/rename/remove lifecycles for `__proto__`, `constructor`, and `prototype`.
- Hub connection: 40,000 seeded mixed events plus 20,000 self-target failure/drop events; 7 numeric boundaries and every phase were also checked.
- Notifications: 25 malformed kind values, 182 quiet-hour/date combinations, 308 notification-building combinations, and 1,760 decision combinations.

The corpora include zero-width, bidi, and confusable Unicode; 100,000-character strings; `0`, `-1`, `2^53`, `NaN`, and infinities; malformed persisted/event shapes; prototype-sensitive keys; and private/loopback IP range edges.

## Invariants proved

- Calls covered by the public type contracts do not throw on the hostile corpus.
- Parser and book refusals remain non-empty plain-language results.
- Produced records use the plain object prototype and do not pollute `Object.prototype`.
- Public internet addresses never become dialable checked addresses.
- Reconciled books keep exactly one self hub and a valid active hub.
- Connection phases stay in the declared union, attempts remain non-negative integers, effects stay in their declared union, and self never emits fallback.
- Notifications copy only renderable fields; actor, recipient, secret, and prototype payloads do not leak.

## Break-proof pairs

Each suite was first compiled with one intentional failing assertion, run by itself, and then rerun after that assertion was removed:

- Hub address: red `4 pass / 1 expected fail` → green `4 pass / 0 fail`.
- Hub book: red `4 pass / 1 expected fail` → green `4 pass / 0 fail`.
- Hub connection: red `4 pass / 1 expected fail` → green `4 pass / 0 fail`.
- Notifications: red `4 pass / 1 expected fail` → green `4 pass / 0 fail`.

No break-proof sentinel remains in the committed files.

## Final verification

- `npm run build` — passed for shared, engine, relay, desktop, and desktop typecheck.
- `node --test packages/shared/dist/hubaddress.fuzz.test.js packages/shared/dist/hubbook.fuzz.test.js packages/shared/dist/hubconnection.fuzz.test.js packages/shared/dist/notify.fuzz.test.js` — `16 pass / 0 fail`.

The build regenerated two tracked desktop bundles; both were restored immediately, leaving the branch diff limited to the five requested new files.
