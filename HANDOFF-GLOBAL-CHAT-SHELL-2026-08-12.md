# Cloud9 global chat shell — takeover handoff

## Purpose and current location

This document hands the work to the next agent exactly where it was stopped on 2026-08-12.

- Repository: `https://github.com/vikas53953/cloud9`
- Branch: `codex/global-chat-shell`
- Pull request: [#43 — Complete global chat shell and appearance library](https://github.com/vikas53953/cloud9/pull/43)
- Base branch: `master`
- Package version: `0.1.0` (no version/tag change was requested)
- Release status: **work in progress; installed but not release-approved**

The user explicitly asked to stop further debugging, document the exact state, commit the work as-is, and push it for another agent.

## Where the pipeline stopped

The branch reached this sequence:

1. Feature work was developed in isolated author worktrees.
2. Every feature slice received a separate reviewer pass; rejected slices were repaired and reviewed again.
3. Approved slices were folded into `codex/global-chat-shell` as the 29 commits listed below.
4. The integrated production build passed.
5. The complete automated test suite passed.
6. Browser QA passed **595/595**, with zero failures.
7. The Windows installer was built and installed successfully.
8. Installed-app QA launched the installed binary but ended with four unresolved checks.
9. The release therefore stopped before final acceptance. This handoff commit and push are an explicit user-requested work-in-progress publication, not a green release claim.

In short, the project is at **installed-app verification / release-candidate repair**, after build, tests, browser QA, packaging, and installation.

## What “folding” means here

Folding is how parallel work was integrated without letting independent edits overwrite one another:

- Each bounded feature started in its own `.worktrees/<feature>` checkout.
- An author implemented and ran focused checks.
- A different reviewer inspected the feature and returned `APPROVE` or `REJECT` with evidence.
- Rejected work returned to the author for a narrow repair and another independent review.
- Once accepted, the feature diff was applied to the conductor branch in dependency order.
- Shared contracts were folded before relay/engine/desktop consumers.
- The conductor resolved overlapping edits in the large `apps/desktop/src/App.tsx` carefully, preserving previously integrated behavior.
- Only after all folds were present did the serial release evidence pipeline run.

The isolated `.worktrees/` directory is intentionally not part of the commit. The integrated branch and Git history are the durable result.

## What the pipeline is

The Cloud9 pipeline is a fail-closed delivery chain:

```text
branch
  -> bounded implementation
  -> distinct reviewer
  -> repair/re-review if needed
  -> fold into conductor branch
  -> production build
  -> automated tests
  -> browser QA
  -> Windows installer
  -> install exact artifact
  -> installed-app visual/behavior walk
  -> final handoff and GitHub publication
```

Evidence types are kept separate:

- **Structural/unit evidence:** source-level and deterministic tests.
- **Build evidence:** TypeScript/Vite/Electron packaging results.
- **Browser evidence:** `npm run qa` against the integrated product.
- **Installed evidence:** `npm run qa:app` against `%LOCALAPPDATA%\Programs\Cloud9\Cloud9.exe`.
- **Human evidence:** a person manually checking the installed screens; this was not completed for the final candidate.

A timeout, skipped check, or cascading unavailable check is not green. That rule is why this handoff says installed-app QA is still pending even though the installer itself succeeded.

## Integrated feature commits

These commits were folded locally and are part of the branch being pushed:

| Commit | Feature |
|---|---|
| `1e2a54a` | Sealed chat completion baseline |
| `b1e2904` | Safe public agent-response streaming |
| `7a9d3ab` | Durable message delivery states |
| `d33fcbe` | Durable channel and thread drafts |
| `cf7d8b8` | Safe run recovery and comparison |
| `e72f62c` | Channel memory policies |
| `f79075d` | Truthful turn outcome actions |
| `17e4e5e` | Room-aware mention picker |
| `a5fee30` | Hardened attachment tray |
| `b457ca9` | Exact composer commands |
| `7bee93e` | Truthful voice recording feedback |
| `fc04aff` | Truthful inline turn lifecycle and stable Stop routing |
| `a377e26` | Contextual Send/Run labels |
| `b14a6a3` | Recent emoji reactions |
| `2abae4d` | Validated per-turn agent controls |
| `c3431f8` | Channel context header |
| `7df5f5d` | Access-safe rich-link previews |
| `a1b310f` | Truthful message delegation |
| `c2f9b46` | Turn messages into durable tasks |
| `b512064` | Truthful thread summaries |
| `e69d95a` | Activity command center |
| `c39fc95` | Revisable approval checkpoints |
| `ff0fd8e` | Truthful execution receipts |
| `8e340b7` | Chat personalization controls |
| `91ee193` | Legacy mute compatibility |
| `2c120c2` | Customizable chat sidebar |
| `ae10797` | Truthful chat workspace layouts |
| `0aa966a` | Memory quota/channel policy alignment |
| `b2cba13` | Strict relay chat-gate fixtures |

## Additional work in the final handoff commit

The final working-tree changes add or repair:

- Attachment/draft causal fencing so late durable projections do not delete a newly uploaded file.
- Accepted-message draft fencing so a late pre-send draft cannot reappear after the message is accepted, including reconnect scope handling.
- Attachment cleanup scoped to the IDs captured by the accepted send, preserving newer uploads.
- Explicit notification-mode compatibility for `all`, `mentions`, `off`, and legacy muted rooms.
- Message-row memoization that ignores unrelated global presence heartbeats while still redrawing for relevant room-agent changes.
- Unsaved Room Context editor guards across click-away, Escape, close, navigation, archive, DM/canvas, and leave paths.
- Mock-provider lifecycle facts and focused QA fixtures.
- QA fixture repairs for upload settlement, draft races, command pagination, task-agent membership, More-tools navigation, slash-command Actions, and workspace-layout navigation.
- A test-only engine repair that removes a flaky global working-directory snapshot while retaining direct attachment reach/runtime checks.

Relevant implementation and regression files are visible in the final commit diff. The most concentrated files are:

- `apps/desktop/src/App.tsx`
- `apps/desktop/src/store.ts`
- `apps/desktop/src/chatdrafts.ts`
- `packages/engine/src/provider.ts`
- `scripts/qa.mjs`
- `scripts/drive-app.mjs`
- the focused Electron test files under `apps/desktop/electron/`

## Verification evidence

### Green evidence

- Latest integrated `npm run build`: **PASS**.
- Latest integrated `npm test`: **PASS**; desktop suite included **153/153** passing tests.
- Latest full browser `npm run qa`: **PASS, 595/595**, zero failures.
- `npm run dist`: **PASS** in 208.4 seconds.
- Installer: `release/Cloud9-Setup-0.1.0.exe`
  - size: 128,308,165 bytes
  - SHA-256: `2FFF4C89E0EF52BE72F6518CF2ADF797F017631238F08FE40E1E248A6411F7FC`
- Installation script: **PASS** in 37 seconds; it matched freshly built and installed renderer assets.
- Installed executable:
  - path: `%LOCALAPPDATA%\Programs\Cloud9\Cloud9.exe`
  - version: `0.1.0`
  - SHA-256: `CB0018B75455A29090CC6386A9EBBFD04B0F680B5ED92575CD23C5E721E3E52E`
- Clean `origin/master` control build: **PASS**. Its older QA assumptions were not fully green, so it was used only as an environment/build control.

The browser QA record is `docs/qa/qa-results.json` in the working environment. The tracked smoke record and retained screenshots are included where already part of the repository.

### Installed-app gate: not green

The final installed walk launched the exact installed executable above and confirmed many real installed surfaces, including:

- installed app launch and debugger connection;
- workspace/home rendering;
- Projects reachable through More tools;
- agent creation/editor capability ladder;
- model list and skill library;
- marketplace portraits and hired-agent editor parity;
- Reply/thread control;
- Actions menu filling the current slash command;
- calm/armed composer behavior;
- Projects, repository, spending, settings, and several Files checks;
- room mute and connection-state UI.

It still exited non-zero with four unresolved checks:

1. **Blocked-agent presence line:** the check looked for `.agentrow[data-agent="Drivecheck"]`, but that row was hidden in Focus layout. The durable state itself had `data-trouble="blocked"`; the next agent must prove it through a currently visible surface or add a truthful visible projection.
2. **Reach a real file:** the installed walk reported `Drivecheck is not in the room's details panel`. The old `ChannelRail/ReachGap` component is unused, while the live `RoomPanel` does not expose equivalent reach-gap/fix metadata. This may require a product integration change, not only a selector change.
3. **Image understanding:** Drivecheck replied that its engine was not connected instead of describing the image. Determine whether the installed-engine sidecar failed to attach, whether room membership setup was skipped after the earlier reach failure, or whether this is a real packaged provider problem.
4. **Stop a real turn:** no Stop control appeared. This can be a cascade from the missing engine/room membership, but must be proven independently before calling Stop installed and usable.

The last run must not be reported as green. It was useful because it removed earlier stale Projects/Actions assumptions and isolated the remaining installed-runtime boundary.

## Known installed-walk navigation issue

`WorkspaceLayoutPanel` intentionally closes when the user clicks outside it. Selecting `Chat + Files` once at startup is therefore not durable after clicking More, Crew, or another rail destination. The current QA helper tries to re-establish the layout before sidebar-dependent steps, but the next agent should prefer visible header/More controls rather than depend on the sidebar:

- Invite: channel header overflow -> `Invite people`.
- Current room: after Home, assert the visible channel header instead of clicking a hidden sidebar row.
- Room settings/mute: use `.chathead .roomdetailsbtn` and the live `RoomPanel`.
- Presence/trouble: use or add a visible current surface; do not pass by querying a hidden row.

`scripts/drive-app.mjs --real-data` promises to change nothing. Any fixture repair must preserve that contract; layout mutations must remain fresh-profile-only or be fully restored.

## Exact next-agent starting checklist

1. Check out `codex/global-chat-shell` and read this document plus `AGENTS.md`, `PIPELINE.md`, and PR #43.
2. Inspect the final commit diff, especially `scripts/drive-app.mjs`, before changing product code.
3. Reproduce only the four installed failures with bounded instrumentation; do not rerun the entire browser suite merely to diagnose them.
4. First prove the installed-engine connection and the selected agent's exact room membership before the image/Stop journeys.
5. Decide whether the absent ReachGap in live `RoomPanel` is a product requirement. If so, implement it in a bounded slice with a distinct reviewer.
6. Make installed QA use visible current controls. Never turn a hidden DOM node into green evidence.
7. After repairs, rerun the serial release chain for any product-code change:
   - `npm run build`
   - `npm test`
   - `npm run qa` exactly once
   - `npm run dist`
   - `powershell -ExecutionPolicy Bypass -File scripts/install-cloud9.ps1`
   - `npm run qa:app`
8. If only `scripts/drive-app.mjs` changes and the installed hash is unchanged, a separately reviewed QA-only rerun may be sufficient, but record that boundary explicitly.
9. Do not tag or bump the version without the user's explicit request.
10. Update PR #43 with the final evidence and keep failures/unknowns visible.

## Suggested skills

- `diagnosing-bugs` — isolate installed-engine, membership, image, and Stop causality before editing.
- `frontend-design-thinking` — audit the visible RoomPanel/ReachGap and presence surfaces using installed screenshots.
- `code-review` — require a different reviewer for every product or QA repair.
- `release-skills` — rerun the bounded build/test/package/install evidence chain.
- `github:gh-address-comments` — handle any actionable PR #43 feedback.
- `handoff` — update this document if the work changes hands again.

## Files deliberately not folded into this commit

- `.worktrees/` — local isolated author/reviewer checkouts, not product source.
- `release/` and installed binaries — generated artifacts, represented by hashes above rather than committed executables.
- Unrelated local scratch/status artifacts are not required to continue the branch unless explicitly included in the final staged diff.

## Handoff truth

The work is substantial, built, browser-tested, packaged, and installed. It is not finished. The branch is being pushed because the user asked for an immediate takeover point, not because the final installed-app gate passed.
