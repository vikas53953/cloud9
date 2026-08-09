# QA · No-expiry approvals

Date: 2026-08-09
Status: implemented on `fix/chat-qa-no-expiry`
Scope: `scripts/qa.mjs` only; relay and product code are intentionally unchanged.
Approval boundary: `NOT_ADVISOR_APPROVED`; independent Sol review remains pending.

## Root cause

Commit `a133f3b` deliberately removed approval timers and `expiresAt` generation. New pending action cards now show only the `Asked` row, remain pending, and have no `.apexpiry` element. The old QA still required `EXPIRES`, read `.apexpiry`, and opened a fake-clock context waiting for `data-state="expired"`. The missing selector threw before the harness could report the remaining checks; the timer wait then produced uncaught timeout/113 unknowns.

## QA contract changed

- The action card must say when it was **Asked**, contain no expiry/deadline wording, and contain no legacy expiry markup or expired state.
- The Tasks card must be correlated to the exact chat approval ID for `PUSH_FACTS`; tray ordering is never trusted.
- The same pending action must remain in the Tasks in-tray and its conversation after an owner-window reload, with both `Approve` and `Not now` controls still available and no expiry wording or legacy expiry markup on either surface.
- An explicit Approve decision must reach the asking engine as `status: "approved"` and remove the request from the waiting tray.
- The existing Not now path remains covered and now also requires the relay's `status: "rejected"` frame before the card is considered complete.

## Fail → pass proof

Before this change, the old assertions failed against the no-expiry UI: the `EXPIRES` check was false, `.apexpiry` was absent, and the fake-clock wait for `data-state="expired"` could abort the run. After this change, the stale timer branch is gone and seven equivalent checks cover the no-expiry contract, ID-correlated persistence, and approval completion/refusal semantics without changing `EXPECTED_CHECKS` (590) or product code.

Focused validation:

- `node --check scripts/qa.mjs` — PASS.
- Static `ok(` count — 549, unchanged from the 590-check suite's prior source count.
- `git diff --check` — PASS with no whitespace diagnostics.
- Stale timer wait scan (`clockCtx`, `clockPage`, `qa-push-3`, `EXPIRES`) — clean. `.apexpiry` appears only in a negative selector used to prove the element is absent.
- Focused ordering/correlation probe — PASS: a stale first tray card is rejected and only the `data-appr` equal to the chat card's `data-approval` is selected.
- Focused wording probe — PASS: `expire`, `expires`, `expired`, `expiring`, `expiry`, `expiration`, and `expirations` are rejected without matching unrelated `experience` text.

No full build, browser QA, packaging, install, or distribution run was performed. Independent Sol review and live QA remain external gates.
