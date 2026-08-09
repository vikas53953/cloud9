# QA trust and owner-setup contract

Date: 2026-08-09  
Scope: `scripts/qa.mjs` only; product and shared engine code are intentionally out of scope.

## Root cause

Two QA expectations had drifted from the current public contract:

- A new agent is created with `localFree` trust. Its approval list is therefore the
  off-machine `connections` capability, not every `alwaysAsk` capability. The stale
  check hard-coded all `CAPABILITIES.filter(c => c.alwaysAsk)` labels.
- A new agent also starts with owner setup enabled. The honesty card consequently
  renders `isolationFor(provider, "owner")`, while QA compared the declared-mode
  report. That made the boundary headline, leak count, and unknown count disagree.

## Fail → pass proof

- **Fail:** the top-rung approval check expected commands, whole-computer, and
  connections for the default agent, even though the UI correctly showed only the
  connected-service ask. **Pass:** QA derives the expected labels and block count
  from `describeApprovalNeeds` using the selected trust and also exercises an
  explicit `askEveryTime` control case before restoring the default.
- **Fail:** the hand-picked-mix check still expected a command switch to produce
  an approval under that same local-free default. **Pass:** it now compares the
  mixed abilities to `describeApprovalNeeds` and asserts the local-only command
  remains quiet.
- **Fail:** the honesty checks called `isolationFor("claude")` and
  `isolationFor("codex")`, which means declared mode, while the editor's
  `data-owner-setup="on"` card was in owner mode. **Pass:** QA reads that rendered
  mode and compares ceiling, boundary/headline, leaks, unknowns, and measurement
  evidence against the matching `isolationFor(provider, mode)` result.

## Check count and validation

The stale predicates were replaced in place; the full-run expected count remains
**590**. No product or shared/engine files changed.

- `node --check scripts/qa.mjs`: pass.
- Focused static probes: the new trust/isolation expressions parse and the old
  hard-coded always-ask and declared-only calls are absent from the edited blocks.
- Full browser QA was not run here; this branch has no installed dependencies or
  built UI artifacts in the checkout. That is an environment boundary, not a QA
  pass.
