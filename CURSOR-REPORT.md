# CURSOR-REPORT — quality round — 2026-07-30

Work done on branch `cursor/quality-round` only. Forbidden files were not edited.

## Gate

- `npm install` — done (fresh worktree).
- `npm run build` — clean (exit 0). Shared, engine, relay, desktop vite build, and `typecheck:app` all passed.
- `npm test` — all green (exit 0):
  - `@cloud9/engine`: **371 pass / 0 fail**
  - `@cloud9/relay`: **205 pass / 0 fail** (includes new `search.test` and `unread.test`)
  - `@cloud9/desktop`: **11 pass / 0 fail**
- Extra (not in `npm test`): `node --test scripts/qa-stack.test.mjs` → **5 pass / 0 fail**

## Per task

### Task 1 — Atomic run-record writes — DONE (with path note)

- **Brief path was wrong:** there is no `apps/relay/src/runstore.ts`. Run records live in `packages/engine/src/runstore.ts` (allowed — not on the forbidden engine list). That file already routes every write through `writeWholeFile` and uses the boolean result.
- **Added** acceptance coverage in `packages/engine/src/runstore.test.ts`:
  - torn write: temp litter present, real file intact and readable
  - failed write: `save` returns `undefined` and logs `could not store`
- **Fail-proof:** existing suite already covers the atomic path; new tests assert the two acceptance cases above.

### Task 2 — Search fallback must not match JSON plumbing — DONE

- **File:** `apps/relay/src/store.ts` (allowed).
- **Fix:** FTS5-less fallback now matches on `json_extract(m.json,'$.text')` (same human text FTS5 indexes), AND across terms — never `m.json LIKE`.
- **Test:** `apps/relay/src/search.test.ts` — both engines; word `text` hits only the message that says it; `flight` agrees under FTS5 and fallback.
- **Fail-proof:** temporarily forced `m.json LIKE` again → test failed with `actual: ['m1','m2','m3'] expected: ['m2']`; restored; rebuild clean.

### Task 3 — Link retention constants — DONE (already linked before this round)

- Grep of `retention|prune|keepDays|daysToKeep` under `apps/relay/src` and `packages` shows the keep/size pair is already one owner: `RUN_RETENTION` in `@cloud9/shared`, with `RUN_STORE_DEFAULTS` in `packages/engine/src/runstore.ts` **derived** from it (`keepPerAgent ← perAgent`, `maxBytes ← bytes`).
- Acceptance already present in `packages/engine/src/runstore.test.ts` ("how many runs are kept is ONE number…", "how BIG a stored run may be is ONE number too…") including a read-your-own-source check.
- **No further code change.** If a different unlinked pair was intended (e.g. time-based `keepDays` that does not exist in these trees), ask and I will reopen — I did not invent one.

### Task 4 — Parallel QA must not delete each other — DONE

- **File:** `scripts/qa-stack.mjs`.
- **Fix:** exported `shouldDeleteQaWorkspace` + `QA_WORKSPACE_MAX_AGE_MS` (3 hours). Startup sweep deletes only abandoned workspaces (mtime older than 3h), never a younger sibling. Side effects gated behind `isMain` so importing the module in tests does not start the stack.
- **Test:** `scripts/qa-stack.test.mjs` — run with `node --test scripts/qa-stack.test.mjs` (5 pass). Not picked up by `npm test`.
- **Fail-proof:** forced `return true` for siblings → "younger sibling is kept" failed (`true !== false`); restored.

### Task 5 — Unread must not lie ("999") — DONE (hub side)

- **Counted in:** `apps/relay/src/store.ts` → `unreadFor` (was `LIMIT 1000`).
- **Frame shape:** `UnreadEntry` in forbidden `packages/shared/src/index.ts` has only `unread` / `mentions` — no `capped` field. Honesty without forbidden edits = **report the true count**.
- **Fix:** removed the 1000-row cap; hub now counts every unread message.
- **Test:** `apps/relay/src/unread.test.ts` — 1005 unread → reports **1005**, not 1000.
- **Fail-proof:** restored `LIMIT 1000` → test failed `1000 !== 1005`; restored.
- **Note for conductor / desktop owners:** `apps/desktop/src/store.ts` still has `UNREAD_CEILING = 1000` and `unreadLabel` → `"999+"` for display. That is forbidden territory today. Hub now tells the truth; the screen may still *display* a capped label until that file is updated by its owner. Linking display ceiling to hub behaviour needs either shared types or a desktop edit.

### Task 6 — Fact-check Slack / Buzz — DONE

- Wrote `docs/plans/market-facts.md` from live fetches on **2026-07-30**.
- Slack annual USD from https://slack.com/pricing: Pro **$7.25**, Business+ **$15** per user / month when paying annually (quoted exactly in the doc).
- INR: Slack's India page still quotes **USD**, not an official INR list price — stated plainly; no invented rupee figure.
- Buzz repo is https://github.com/block/buzz; README tagline and promises quoted exactly in the doc.

### Task 7 — Skill library 15 → 25 — DONE

- **File:** `packages/shared/src/skill-library.ts` only (existing 15 untouched).
- Added 10 skills on existing shelves (release checklist, DB migration safety, test triage, performance budget, incident report, threat model, API contract, honest logging, feature flag, changelog), each with a real checkable source.
- `SKILL_LIBRARY.length === 25` after build. Existing `skilllibrary.test.ts` asserts `>= 12` and shape — still green; no count literal to update.

## Files touched

| File | Why |
|------|-----|
| `packages/engine/src/runstore.test.ts` | Task 1 acceptance tests |
| `apps/relay/src/store.ts` | Task 2 search fallback; Task 5 unread truth |
| `apps/relay/src/search.test.ts` | Task 2 (new) |
| `apps/relay/src/unread.test.ts` | Task 5 (new) |
| `scripts/qa-stack.mjs` | Task 4 deletion rule |
| `scripts/qa-stack.test.mjs` | Task 4 (new) |
| `docs/plans/market-facts.md` | Task 6 (new) |
| `packages/shared/src/skill-library.ts` | Task 7 (+10 skills) |
| `CURSOR-REPORT.md` | this file |

## Tests proved able to fail

1. Search fallback → reintroduced raw-JSON match → `search.test` failed; restored.
2. Unread → reintroduced `LIMIT 1000` → `unread.test` failed `1000 !== 1005`; restored.
3. QA stack → always-delete siblings → `qa-stack.test` failed; restored.

## Questions for the conductor (none blocking)

1. Task 1 brief path `apps/relay/src/runstore.ts` — confirm engine path is the intended target (already fixed there).
2. Task 3 — if a second unlinked retention pair was meant beyond `RUN_RETENTION` ↔ `RUN_STORE_DEFAULTS`, name the two constants.
3. Task 5 follow-up: desktop `UNREAD_CEILING` / `unreadLabel` still display-cap; needs the desktop owner once this branch merges.
