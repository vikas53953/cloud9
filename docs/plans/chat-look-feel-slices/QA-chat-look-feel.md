# Chat look-and-feel QA finish line

Date: 2026-08-09
Scope: `scripts/qa.mjs` only; product changes are intentionally out of scope.
Artifact: `docs/plans/chat-look-feel-slices/QA-chat-look-feel.md`

## Contract covered

- Composer and thread parity still compares the complete `.tools button.mini` title set. The obsolete `Hand this over as background work` title is no longer required; the room's `＋` menu must instead expose exactly one `.ap-row[data-command="!bg"]`.
- A negative parity check also requires zero toolbar buttons titled `Hand this over as background work` in both the room and thread composers, so the retired affordance cannot silently return in either surface.
- Presence reason proof reads the first line of the `.agentmain` row-button `title`, where `presenceSays(...).title` is rendered. It does not treat `.an-state`'s compact one-word text as the reason.
- The composer emoji tray is opened through `.emojihold`, then required to close through both the shared Escape stack and pointer click-away (`.emojipop` disappears in each case).
- A reply line must render `.threadline .tl-faces` with one to three `.avatar` children.
- Conversation face elements (`.msgs .msg .avatar .portrait` / `.initialplate`) are checked through `getComputedStyle(...).borderRadius === "50%"`.

The expected full-run count moves from 584 to 590 for these six new checks. The positive parity and presence checks are updates to existing checks; the retired-title absence assertion is the sixth added check.

## Integration follow-up

G1 rail grouping and F4 empty-room cards are not covered here: the handoff marks both as not started, and this branch has no stable product selectors for either surface. Add their checks with the corresponding product work rather than guessing selectors in this QA slice.

## Validation boundary

- `node --check scripts/qa.mjs`: pass.
- Static `ok(` count: 543 at the original base, 549 after this change (`+6`), matching the expected-count increase.
- `node scripts/qa-stack.mjs --smoke` was attempted with a 15-second bound and timed out before producing a result; the temporary stack process was stopped. Dependencies and built UI artifacts are absent (`node_modules`, `packages/engine/dist`, and `apps/desktop/dist` are not present), so this is an environment boundary, not a QA pass.
- Focused red/green contract probe (in-memory fixtures, not a browser substitute) made all six new predicates fail on deliberately wrong fixtures and pass on the correct fixtures. The harness's normal self-check (`assertHarnessIsHonest`) remains in the existing runner; no broken state is committed.
