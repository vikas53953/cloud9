# CURSOR-REPORT

REPORT FOR ROUND: 2
Branch: `cursor/auto`
Date: 2026-07-30

## Gate

- `npm run build` — clean (exit 0).
- `npm test -w @cloud9/engine` — **371 pass / 0 fail** (exit 0; earlier full-suite run hit 1–2 flaky `repowork.test.js` timeouts under load; re-run green).
- `npm test -w @cloud9/relay` — **235 tests, 231 pass, 0 fail** (4 todo/skip from this round + prior).
- `npm test -w @cloud9/desktop` — **11 pass / 0 fail**.

## Per task

### Task 1 — Insider sweep — DONE

- Extended coverage in new `apps/relay/src/insider-sweep.test.ts` (existing `insider.test.ts` kept).
- Covers: non-member channel admin, edit/delete others' messages, react/history/search/markRead across boundaries, attachment tickets, artifact frames, runDetail/runList for foreign agents, decideApproval by non-owner, project frames for foreign projects, updateAgent/deleteAgent for foreign agents.
- **FINDING F1** (real hole, not fixed — `server.ts` forbidden): every refusal is `"Error: …"` because `String(err)` is sent. Documented in `docs/qa/insider-audit.md`. Todo test records the refusal-law until the conductor can fix `server.ts`.
- No other data-leak findings observed in this sweep.

### Task 2 — Naming / filename torture — DONE

- `apps/relay/src/naming-torture.test.ts`: zero-width, bidi, Cyrillic/Latin confusables, NFC/NFD, emoji, boundaries, Windows devices, trailing dot/space, 300-char names, phase-5 real-world filenames.
- Asserted actual behaviour; proposals for invisible-char + confusable fixes written in-file (shared `index.ts` forbidden).
- **Fail-proof:** flipped device-name assertion to expect `true` → test failed; restored.

### Task 3 — Phase-5 majors as tests — DONE

- `apps/relay/src/phase5-majors.test.ts` numbered **5-M1…5-M7**:
  - 5-M1 A3 — hub text limit asserted; composer-empty **skipped** (screen-side)
  - 5-M2 B6 — hub duplicate agent refused; B6b picker **skipped** (screen-side)
  - 5-M3 C12 — malformed repo refused; unknown-but-shaped GitHub look **skipped** (needs engine/server)
  - 5-M4 D2, 5-M5 D3, 5-M6 D4 — hub naming rules (already fixed; regression tests)
  - 5-M7 F3 — ordinary filenames accepted; sentence matches rules

### Task 4 — Keep-awake helper — DONE (with privilege note)

- `scripts/keep-awake.ps1` — SetThreadExecutionState ES_CONTINUOUS|ES_SYSTEM_REQUIRED; plain engage sentence; finally restores; Add-Type failure prints a plain refusal.
- `docs/plans/keep-awake.md` — non-developer instructions.
- **Run evidence:** script printed  
  `Cloud9 is keeping this computer awake (screen may still sleep). Press Ctrl+C when finished.`  
  and stayed alive until killed.
- **`powercfg /requests`:** this machine requires an elevated prompt  
  (`This command requires administrator privileges…`). Could not paste SYSTEM request lines without admin. API engage path itself succeeded (non-zero return from SetThreadExecutionState inside the script). Conductor can re-check elevated if needed.

## Files touched

| File | Role |
|------|------|
| `apps/relay/src/insider-sweep.test.ts` | Task 1 (new) |
| `docs/qa/insider-audit.md` | Task 1 findings (new) |
| `apps/relay/src/naming-torture.test.ts` | Task 2 (new) |
| `apps/relay/src/phase5-majors.test.ts` | Task 3 (new) |
| `scripts/keep-awake.ps1` | Task 4 (new) |
| `docs/plans/keep-awake.md` | Task 4 (new) |
| `CURSOR-REPORT.md` | this report |

Forbidden files were not edited (`server.ts`, `apps/desktop/**`, `packages/shared/src/index.ts`, engine src, `qa.mjs`).

## Break-proof pairs

1. Naming torture device-name test — assertion inverted → fail → restored.
2. F1 probe (earlier): live hub returned `{"type":"error","error":"Error: no such channel"}` — the finding the todo records.

## Next

Pushing `cursor/auto`, then entering THE LOOP (fetch until ROUND > 2).
