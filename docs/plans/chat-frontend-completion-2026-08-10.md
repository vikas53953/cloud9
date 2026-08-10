# Cloud9 chat and frontend completion program

Status: ready for Advisor review and multi-agent execution after Codex restart.
Conductor: Sol/root. User authorization: implement, review, merge, package,
install, and prove the installed build without additional product approvals.

## Non-negotiable pipeline

`baseline -> Advisor -> feature worktree -> independent review -> focused
checks -> integration -> full build/test/browser QA -> installer -> install ->
installed visual walk/screenshots`

- One bounded feature per author lane.
- Authors never approve their own work.
- Shared protocol and schema migrations integrate sequentially.
- UI-only work may run concurrently in isolated worktrees.
- No private chain-of-thought, invented activity, fabricated delivery state, or
  unsupported transcription claim.
- Preserve unrelated working-tree and untracked files.

## Baseline

- Branch: `codex/global-chat-shell`
- Fixed source before this program: `ea81f5b`
- Current installed renderer is byte-identical to the packaged renderer.
- Current tracked follow-up files still need a baseline commit:
  `apps/desktop/src/App.tsx`, `apps/desktop/src/receipts.tsx`,
  `scripts/qa.mjs`, `scripts/qa-v2.mjs`.
- Baseline evidence on 2026-08-10: app typecheck passed; desktop tests 78/78;
  `git diff --check` passed.

## Feature backlog

### Wave 1: protocol and durability foundations

1. Durable accepted/delivered/read message state with stable client message IDs,
   reconnect queries, viewport-based reads, group privacy, and idempotency.
2. Durable channel/thread drafts that reclaim valid parked attachment IDs and
   expose expiry, unavailable, retry, and removal states.
3. Provider-capability-gated response delta streaming reconciled with the final
   durable message and cleaned on cancel/failure/reconnect.
4. Channel-level agent memory policy: allowed memory, prohibited retention,
   visible current policy, audit, and safe defaults.
5. Run checkpoints, safe retry/resume, and comparable run metadata.

### Wave 2: immediate composer and turn experience

6. Complete turn lifecycle card: queued, accepted, working, waiting for user,
   completed, failed, cancelled; delayed display and deterministic cleanup.
7. Final outcome badge plus truthful Stop, Continue, and Re-run actions.
8. Exact composer commands: `/summarize`, `/plan`, `/review`, `/ship`, `/assign`.
9. Capability/availability-aware mention picker restricted to room members.
10. Rich attachment previews, upload retry, explicit failure, and durable draft
    integration.
11. Voice waveform and pre-send playback; transcription only through a real,
    configured provider capability with consent and failure states.
12. Contextual Send versus Run wording.
13. Compact per-message model, effort, and permission controls with server-side
    validation and honest fallbacks.

### Wave 3: conversation structure and governance

14. Full reaction picker plus genuinely persisted recent emoji.
15. Access-projected rich previews for PRs, tasks, runs, files, and decisions.
16. Turn a message into a task with owner, deadline, and immutable source link.
17. Thread summary card: decisions, open questions, next actions, source links.
18. Channel context header/canvas: topic, goals, pins, active agents, current work.
19. Dedicated `Hand this to...` control with visible permission scope.
20. Approval editing and question/clarification flow in addition to approve/reject.
21. Execution receipt completeness: changed files, tests, PR, duration, and cost
    only when the underlying system reported those facts.

### Wave 4: workspace clarity and personalization

22. True Focus chat workspace.
23. Chat + Files and Chat + Diff workspaces.
24. Activity filters: Mine, Waiting for me, Failed, Completed.
25. Keyboard command launcher and shortcuts for channels, threads, search, mute,
    mark read, and workspace modes.
26. Chat font size, message density, timestamp style, and avatar size.
27. Per-channel notification rules beyond mute.
28. Sidebar sections, reordering, and pinned channels.
29. Persisted Focus, Split, Review, and Incident workspace layouts.

## Regression contracts already present

- Jump-to-latest and first-unread divider.
- Human typing from real ephemeral signals.
- Channel pins and private Save for later.
- Header members/presence and responsive small-window behavior.
- Public-only activity steps and run receipts.
- Existing approvals, commands, reactions, attachments, threads, tasks,
  notifications, workflows, files, projects, hooks, and governance.

## Release gates

1. Every feature has focused automated coverage and a distinct reviewer verdict.
2. All P0/P1 review findings are repaired before integration acceptance.
3. Run serially: `npm run build`, `npm test`, `npm run qa`.
4. Any skipped, early-stopped, or partial browser run is not green.
5. Build the installer only from the accepted integration commit.
6. Install it, then compare packaged and installed executable and renderer hashes.
7. Perform an isolated installed-app visual walk covering happy, empty, offline,
   refusal, reconnect, small-window, theme, and accessibility states.

