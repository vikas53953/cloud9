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
- **Fail, first revision:** selecting the right setup mode fixed the values but
  left asymmetric coverage. Claude only compared ceiling, boundary, and headline;
  Codex alone compared controls, leaks, unknowns, and measurement evidence, and
  its wait still hard-coded `data-boundary="no"`. **Pass:** one reader now captures
  both cards, and the same paired assertions compare Claude and Codex against
  `isolationFor(provider, setupMode)` for ceiling, boundary, headline, controls,
  exact leak names and order, exact unknown text and heading, and exact measurement
  evidence.

## Check count and validation

The stale predicates were replaced in place; the full-run expected count remains
**590**, and the static `ok(` call count remains **549**. No product or
shared/engine files changed.

- `node --check scripts/qa.mjs`: pass.
- `git diff --check`: pass.
- Focused red/green source-contract probe: the committed first revision fails the
  symmetric-provider predicate; this revision passes it, including absence of the
  hard-coded Codex boundary selector.
- Browser QA is not claimed: current `Test-Path` probes return false for
  `node_modules`, `packages/engine/dist`, `packages/shared/dist`, and
  `apps/desktop/dist`. No runtime result can be reproduced in this checkout
  without first installing and building those artifacts.
