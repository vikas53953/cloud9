# REPORT — Lane N / `cursor/notifications`

**Branch:** `cursor/notifications`
**Base:** `origin/master` @ `1f18320579631c1f7e727dd173748de42a8d956d`
**Date:** 2026-07-31

## What shipped

Pure notification rules module. No OS integration, no desktop edits, no
`index.ts` re-export (conductor wires that).

| File | Role |
|---|---|
| `packages/shared/src/notify.ts` | Events that raise, quiet hours, de-dupe, toast shape |
| `packages/shared/src/notify.test.ts` | Green suite for the rules |
| `docs/plans/notify-handoff.md` | Contract: kinds, prefs, frames, where desktop/phone read |
| `notify-REPORT.md` | This report |

## Rules (one line each)

1. **Four kinds only:** `job_finished`, `approval_asked`, `mention`, `artifact_published`.
2. **Prefs match Settings:** `notify`, `quietOn`, `quietFrom`, `quietTo` — same defaults.
3. **Quiet hours** = Settings math (overnight wrap; end exclusive). Silences all toasts.
4. **De-dupe key:** `` `${kind}:${subjectId}` ``; caller owns the `seen` set.
5. **Self:** `actorId === recipientId` → no toast.
6. **Shape:** `Cloud9Notification` `{ id, kind, title, body, channelId?, subjectId, at }`.

## Tests

```
npm test -w @cloud9/shared
→ 45 pass / 0 fail  (13 new in notify.test.ts; rest are existing hubbook/hubaddress)
```

### Prove-fail pair

| Step | Change | Result |
|---|---|---|
| Break | quiet-hours same-day end: `t < to` → `t <= to` | **FAIL** `same-day quiet window: inside and at the edges` — "end is exclusive, like Settings" (`true !== false`) → 44 pass / 1 fail |
| Restore | put `t < to` back | **PASS** 45 / 0 |

## Build

`npm run build` — clean (shared + engine + relay + desktop + typecheck:app).

## Frames / wiring (for conductor)

- **Existing wire:** `{ type: "push"; message }` — hub → mobile, proactive only.
- **Proposed later:** `{ type: "notify"; notification: Cloud9Notification }`.
- **Desktop today:** private `inQuietHours` in `App.tsx` — replace with this module.
- **Phone today:** handles `push`; later `notify`.
- **Import:** standalone until conductor re-exports from `packages/shared/src/index.ts`.

## Not touched (exclusive lane)

- `apps/desktop/**`
- `apps/relay/src/server.ts`
- `packages/shared/src/index.ts`
- Other lanes' files (an unrelated `agent-memory.ts` / dist-web churn in the worktree was left unstaged)
