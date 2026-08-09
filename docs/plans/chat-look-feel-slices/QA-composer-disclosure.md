# QA · Composer formatting disclosure

Date: 2026-08-09
Status: QA-only fix on `fix/chat-qa-composer-disclosure`
Approval boundary: NOT_ADVISOR_APPROVED; independent Sol review pending.

## Root cause

The product deliberately keeps Bold, Italic, and Code inside `.fmtset`, hidden
until the `Aa` button is opened. The stale writing-state predicate in
`scripts/qa.mjs` treated every descendant `.toolset button.mini` as a surface
control and required all of them to have a client rect while writing. That made
the correct composer fail because Attach, Emoji, and Aa were visible while the
nested formatting controls were still closed.

## QA contract change

- The calm/writing predicate now checks the three direct surface controls:
  Attach, Emoji, and Formatting (`Aa`).
- The complete descendant `.toolset button.mini` title list remains in the
  result, so room/thread DOM and title parity is still held elsewhere.
- While writing, Bold/Italic/Code must remain hidden until Aa is opened.
- A focused browser check opens Aa, requires exactly the ordered Bold/Italic/Code
  controls to be visible, closes Aa, and requires the closed/`aria-expanded=false`
  state with no formatting button visible.

## Red → green proof

The focused fixture probe used the old all-descendant visibility rule and the
new direct-surface rule:

- RED: a writing fixture with visible Attach/Emoji/Aa but hidden Bold/Italic/Code
  fails the old rule.
- GREEN: the same fixture passes the new surface rule while preserving all six
  toolbar titles in the DOM.
- RED: an Aa-open fixture with a missing or reordered formatting title fails.
- GREEN: the exact Bold / Italic / Code open fixture and the closed
  `aria-expanded=false` fixture pass.

## Counts and validation

- Expected full-run checks: **590 → 591** (`+1` focused Aa disclosure check).
- Static `ok(` calls: **549 → 550** (`+1`), matching the added check.
- `node --check scripts/qa.mjs`: PASS.
- `git diff --check`: PASS (Git emitted only its normal LF→CRLF warning).
- No full build, test, QA, packaging, install, or installed-app walk was run;
  those remain independent gates.

## Unknowns

- The focused probe is not a substitute for a live browser run; dependency and
  built-artifact availability were not assumed.
- Independent Sol review and the draft PR gate remain pending.
- No product files (`App.tsx` or `styles.css`) were changed.
