# F4 · Empty-room welcome cards

Date: 2026-08-09  
Status: implemented on `feature/chat-look-feel-welcome`  
Approval boundary: NOT_ADVISOR_APPROVED (root proceeded under user best-effort approval)

## Change

- Replaced the channel empty-state instruction paragraph with two responsive cards:
  - **Add an agent here** opens the existing new-agent editor. Its copy says the agent is created first and then added from the room header, so the card does not claim an atomic create-and-add flow.
  - **Invite someone** opens the existing one-time invite modal for the owner. The card remains visible for guests but is disabled and explains that only the owner can invite people.
- Kept direct-message empties as the simpler start-of-chat state; the cards are for rooms only.
- Kept the command hint below the cards, shortened to the supported `@name`, `!bg`, and `/` paths.
- Cards are native `button` elements with visible focus, readable labels, responsive one-column narrow layout, and theme tokens from the existing Studio palette.

## Focused proof

- `git diff --check` — passed (exit 0; Git only reported the repository's LF→CRLF warning).
- `node` TypeScript `transpileModule` syntax check for `apps/desktop/src/App.tsx` — passed.
- F4 source invariant check — passed: exactly two `.empty-welcome-card` instances, both approved labels, room marker, and shortened hint present.
- `npm run typecheck:app` — blocked by the checkout's missing built workspace declarations (`@cloud9/shared` and `@cloud9/engine/dist/*`), producing the existing cascade of unresolved-module/implicit-any diagnostics. No F4-specific diagnostics remained after callback wiring was corrected.

## Risks / unknowns

- No installed-app screenshot or browser interaction proof was run in this focused slice; full build/QA/install evidence remains an independent gate.
- Agent creation still returns to the existing editor/crew flow; the card intentionally does not promise that the new agent is automatically added to the current room.
- Guest invite behavior is intentionally fail-closed in the UI because the relay's invite action is owner-only.

