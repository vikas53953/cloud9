# Lane R — relay Store coverage report

**Branch:** `cursor/relay-store-tests`
**Base:** `origin/master` @ `9375abbb651d6c6bbb61d02601f9566e0186d455`
**Worktree:** `C:\Users\vikasmit\cloud9-cursor-lane-R`
**Constraint honoured:** `apps/relay/src/store.ts` was never edited — only read. New files only.

## What was added

- `apps/relay/src/store.coverage.test.ts` — 22 new unit tests against the real
  `Store` (imported, never modified), covering behaviours the existing suite
  either didn't reach directly or only exercised through the full WebSocket
  protocol.
- `cursor-relay-store-tests-REPORT.md` — this report.

## Coverage added, by area

### 1. Search parity edges (4 tests)
- `authorId` filter agrees between the FTS5 path and the no-FTS5 fallback on a
  page-boundary fixture (mirrors the shape of the historical author-filter
  bug, but proves the fallback path specifically — the existing
  `hardening.test.ts` regression only exercises the FTS5 path).
- A tombstoned message (`deletedAt` set, words still present in the row) is
  invisible to **both** engines — proves the `deletedAt IS NULL` rule itself,
  not an accident of `deleteMessage` also clearing `text`.
- A query with no real words (empty, whitespace, punctuation-only) returns an
  empty page from both engines without a "no term" crash.
- `hasMore` is verified at the exact page-size boundary (size vs. size+1) in
  both engines.

### 2. Unread near the cap (3 tests)
- The `ts > since` boundary: a message stamped exactly at `lastReadTs` is
  read; one tick later it is unread. (The one existing unread test only
  covers the *volume* cap at 1000+, not this timestamp boundary.)
- `mentions` only counts an id inside the caller's own `mine` set, and an
  agent's own turn (`authorId` in `mine`) never counts as unread even when it
  contains an `@mention`.
- `markRead` is proven forward-only directly against the Store (not just
  observed through the WS `read` frame as `chat.test.ts` does).

### 3. Retention pruning boundaries (5 tests)
- `pruneArtifactVersions`: exactly at the cap prunes nothing; one version past
  it prunes exactly the oldest, and its bytes are removed from disk while the
  newest's are not.
- `pruneArtifactVersions` with `keep=0`: the artifact still keeps its one
  newest version — `Math.max(1, keep)` proven directly.
- `pruneRuns`: a task sitting exactly at `RUN_RETENTION.perTask` survives an
  agent whose *own* recency window would otherwise evict every one of them.
- `pruneRuns`: a task one run *past* its own `perTask` cap loses only its own
  oldest run — the task budget is itself bounded, not just agent-protected.
- `cap()`: an oversized limit is clamped to `listPage`, a limit below 1 still
  returns at least one row, and `NaN` falls back to `listDefault` rather than
  zero.

### 4. Channel role transitions (5 tests)
- A role is never inherited across a leave/rejoin — the new spell always
  starts as a plain `member`, and the old spell's row (with its original role)
  is untouched.
- `setMemberRole` on an already-removed (non-live) row is a silent no-op; it
  cannot resurrect a row or rewrite history.
- Repeated `setMemberRole` transitions on one live membership update the same
  row in place (one row, `joinedAt` unchanged) rather than creating new
  spells.
- The `joinedAt` collision-avoidance loop in `addChannelMember` is exercised
  directly: rejoining at an already-taken instant steps the key forward by
  one millisecond instead of colliding or dropping a row.
- `channelMembers({ at })` is checked at the *exact* join and leave instants:
  present at `joinedAt`, absent one tick before it; absent at `removedAt`,
  present one tick before it.

### 5. Attachment single-use / races (5 tests)
Tickets themselves are minted and redeemed through an in-memory `Map` inside
`server.ts` (not through `Store`), so the store-level races that exist are the
ones between **parking**, **claiming**, and **sweeping** a file:
- A claimed attachment survives a sweep run immediately afterward, however
  old its `uploadedAt` is — `sweepParkedAttachments` only ever touches
  `messageId IS NULL` rows.
- `parkedBytes` (the upload-quota counter) drops the instant a file is
  claimed, closing the quota-race window.
- Pinned, on purpose: `Store.claimAttachment` itself has **no** single-use
  guard — calling it twice silently overwrites `messageId`. The actual
  single-use rule lives in `server.ts` (`"that file has already been sent"`,
  checked via `attachment().messageId` before calling `claimAttachment`).
  This test documents that boundary so a future refactor can't assume a
  guard that was never in the Store.
- `releaseAttachments` is idempotent: a second call for the same message
  finds nothing and returns `[]` rather than throwing.
- `removeAttachmentBytes` is idempotent under a concurrent-delete race
  (missing file is not an error, called twice in a row).

## Proof of a real failure

Before finalizing, one assertion (`unread: a message AT the read watermark…`)
was temporarily mutated to expect an impossible value (`999` instead of `1`)
to prove the test harness genuinely fails on a wrong answer, then reverted:

```
✖ unread: a message AT the read watermark is read; one past it is not
  AssertionError [ERR_ASSERTION]: 'lastReadTs' means everything AT OR BEFORE
  it was seen — ts=100 must not count twice
```

The assertion was restored to its correct value immediately after.

## Test run

```
$ npm run build   # tsc -p apps/relay/tsconfig.json — succeeded
$ node --test dist/*.test.js
ℹ tests 295
ℹ suites 0
ℹ pass 291
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 1
```

(3 skipped / 1 todo are pre-existing and unrelated to this change — nothing in
this branch skips or marks anything.) The new file alone:

```
$ node --test dist/store.coverage.test.js
ℹ tests 22
ℹ pass 22
ℹ fail 0
```

## Files touched

- `apps/relay/src/store.coverage.test.ts` (new)
- `cursor-relay-store-tests-REPORT.md` (new)
- `apps/relay/src/store.ts` — **not touched**

## Branch / commit

- Branch: `cursor/relay-store-tests`
- Pushed to: `origin/cursor/relay-store-tests`
- See commit SHA in the `git push` output below (recorded at push time).
