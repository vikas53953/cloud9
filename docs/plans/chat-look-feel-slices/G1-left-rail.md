# G1 · Left-rail grouping

**Status:** Implemented on `feature/chat-look-feel-rail` (2026-08-09).  
**Scope:** Left-rail grouping only; the utility row and existing button behavior remain unchanged.

## Visible order

- **Talk:** Chat · Notifications · Saved for later
- **Crew:** Crew · Team feed · Huddles
- **Work:** Tasks · Workflows · Files · Projects · Decision threads · Engineering Pulse · Polls · Canvas · Public updates
- **Running the studio:** Hooks · Spending · Activity

The bottom utility row remains Ctrl-K, Settings, hub switch, and connection lamp. Product buttons keep their existing `data-go`, active-state, badge, tooltip, and click behavior.

## Short-window behavior

The product groups and labels live in a `.rail-main` scroll region (`overflow-y: auto`). The utility controls are in a separate non-scrolling `.rail-utilities` region (`flex: none`), so short windows can reveal all product navigation without scrolling utilities out of reach.

## Focused proof

- Source grouping check: PASS — four labels found; item IDs and order match the approved Talk/Crew/Work/Running the studio groups.
- Utility-preservation check: PASS — Ctrl-K, Settings, hub switch, and connection lamp controls remain present in the utility region.
- CSS marker check: PASS — `.rail-main` overflow, fixed `.rail-utilities`, and visible `.rail-group-label` rules are present.
- `git diff --check`: PASS (only Git's normal LF→CRLF warning was emitted).
- `npm run typecheck:app`: NOT GREEN in this checkout — exit 2 with 160 existing TypeScript diagnostics (14 missing-module diagnostics because workspace build outputs/node_modules are absent); zero diagnostics point at the changed rail lines.

No full build, test, QA, packaging, install, or installed-app walk was run, per the G1 slice constraint. Visual installed-app proof remains an external gate.

## Risks and unknowns

- Installed-app visual behavior at the target window heights is not independently observed in this slice; the fixed utility region and scrollable main rail are proven structurally only.
- The repository's normal build/test evidence is unavailable until dependencies and generated workspace outputs are restored.
- **NOT_ADVISOR_APPROVED.** Independent review is pending; this author did not review or merge the change.
