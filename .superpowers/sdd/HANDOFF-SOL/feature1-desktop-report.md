# Feature 1 desktop handoff — Files workspace

## Status

Desktop slice implemented in the existing checkout and left uncommitted.

Final desktop evidence in this session:

- `npm run typecheck:app` — passed.
- `npm run build -w @cloud9/desktop` — passed; Vite transformed 27 modules and produced the renderer bundle.
- `git diff --check -- apps/desktop/src/App.tsx apps/desktop/src/store.ts apps/desktop/src/styles.css` — no whitespace errors; Git only reported the checkout's existing LF-to-CRLF warning for `store.ts`.
- Confirmed the desktop source does not read or render raw `ArtifactVersion.links`; all relationship UI uses only the privacy-filtered `ArtifactRelationView[]` supplied on artifact detail frames.

This is compile/build proof for the desktop slice, not installed-app or user verification. The coordinator/QA worker still owns the integrated relay/engine test, scripted browser QA, installed-app drive and final evidence chain.

## Files changed

Only the assigned desktop source files were edited:

- `C:\Users\vikasmit\cloud9\apps\desktop\src\App.tsx` — Files rail entry, workspace screen, existing artifact-card integration, copy references, typed relationship navigation and access detail/editor.
- `C:\Users\vikasmit\cloud9\apps\desktop\src\store.ts` — bounded workspace paging state, detail/relation cache, permission request path, revocation cleanup and cross-room artifact cache integration.
- `C:\Users\vikasmit\cloud9\apps\desktop\src\styles.css` — Studio-law Files layout, version-stack signature, access/relationship treatments and narrow-width behavior.

This report is the explicitly requested handoff file. No commit was made.

## What was built

### Rail and global workspace

- Added **Files** after Tasks and before Projects in the icon rail.
- Added a cross-room Files screen using the shared workspace frame rather than polling each room.
- The screen requests a fresh first page on entry and uses the relay-provided `updatedAt`/id cursor for explicit **Older files** paging.
- Workspace answers retain honest `asked`, `loading`, `hasMore`, cursor, checked-time and problem states.
- Empty, loading and refusal states are distinct and dated when an answer or refusal arrives.
- A refresh resets stale rows instead of presenting an old list as current.

### Workspace rows

Each row shows:

- source room/direct-conversation label;
- file name and kind;
- latest maker;
- exact producing turn id when present;
- full date including year and time;
- total published version count from `ArtifactWorkspaceEntry.versionCount`;
- room-visible or restricted access.

Rows are newest-change-first. Pushed artifact updates are merged and re-sorted by `updatedAt` and artifact id without replacing immutable version history.

### Existing artifact behavior reused

Opening a workspace row asks for full artifact detail and renders the existing `ArtifactCard` with a new `workspace` placement. The workspace does not create a second preview/history/download implementation.

The reused card continues to provide:

- immutable retained version history;
- exact-version selection;
- text preview using the hub's `text` decision;
- save/download through the existing one-use ticket path;
- producing-turn disclosure;
- pruned-version wording without silently substituting bytes.

For an exact older version, the shared card now labels the disclosure **Other retained versions** rather than incorrectly calling newer retained rows “Earlier versions.”

### Copy references

The detail header provides two separate actions:

- stable newest-file reference: `cloud9://artifact/<artifactId>`;
- exact-version reference: `cloud9://artifact/<artifactId>@<version>`.

Both use the existing shared `artifactRef()` formatter.

### Typed relationships

- Relationship detail is loaded only when a file opens.
- All rendering uses the final strict `ArtifactRelationView` discriminated union.
- Hidden outgoing targets show only the approved sentence: **“A linked file isn’t available to you.”** No target id, version or name is read.
- Visible links render the approved plain labels:
  - **Made from** for outgoing `made-from`;
  - **Used to make** for incoming `made-from`;
  - **Goes with** for either direction of `goes-with`.
- The row names the exact version of this file carrying the relation and the exact linked version.
- Selecting a permitted relationship opens that exact target version through the same artifact detail/card path.
- The desktop source contains no access to raw stored version links; public versions now have `links?: never`.

### Permission detail and editor

The detail applies the approved whole-chain access model:

- Legacy/absent access is normalized through `effectiveArtifactAccess()` to room-visible.
- Direct conversations show inherited access only and never render a separate editor.
- Ordinary room members see a read-only explanation.
- Current room owner/admin roles may edit.
- The default choice is everyone currently able to read the source room.
- Restricted mode offers only current human room members.
- Current owners/admins are visibly checked and marked **required**.
- Managers are not stored as frozen selected ids; they are derived by the relay on every read, so role changes take effect immediately.
- Removed humans are filtered out of the draft before saving.
- The draft is normalized and validated through shared helpers before `setArtifactAccess` is sent.
- Unsaved permission changes use the app's existing leave guard.
- A revoked or unavailable artifact is removed from every desktop artifact index and shown indistinguishably from a nonexistent id.
- If access is restored later, the detail/relation cache is allowed to load again.

No upload, delete, public-link, cross-room-link, graph editor or manual relationship controls were added.

## Stable QA hooks

The screen includes stable hooks for the QA worker, including:

- `[data-files-screen]` and `data-files-state`;
- `[data-files-list-state]`, `[data-files-loading]`, `[data-files-empty]`, `[data-files-error]`;
- `[data-file-row]` with `data-room`, `data-maker`, `data-turn`, `data-access`, and `data-version-count`;
- `[data-files-more]` and `[data-files-end]`;
- `[data-file-detail]` and `[data-open-file-room]`;
- `[data-copy-ref="newest"]` and `[data-copy-ref="exact"]`;
- `[data-file-relations]`, `data-relations-state`, `data-relation-kind`, `data-relation-direction`, `data-relation-hidden`, `data-linked-artifact`, and `data-linked-version`;
- `[data-file-access]`, `data-access-editor`, `data-access-choice`, `data-access-user`, `data-required`, and `[data-access-save]`.

The existing `window.cloud9Artifacts` QA hook now also exposes bounded workspace ids/state and privacy-filtered relationship views.

## Narrow-width and visual treatment

- Wide layout uses a bounded archive-style index beside the full detail.
- At 860 px and below, the index stacks above the detail with separate bounded scrolling regions.
- At 560 px and below, row facts, detail actions, artifact actions and access rows wrap instead of introducing horizontal overflow.
- Light/dark colors use existing Studio tokens only.
- Existing reduced-motion behavior remains in force.
- The version-stack mark is the single new signature element: offset sheets express append-only immutable versions without inventing a second file-card language.

## Review cleanup applied

A four-angle cleanup review was run for reuse, simplification, efficiency and implementation altitude. Applied desktop-local improvements included:

- one owner for the initial Files refresh;
- removal of the new redundant relation/access subscriptions by passing their state from the Files parent (the reused ArtifactCard keeps its existing subscription);
- shared room-peer naming helper;
- shared role ordering and access restriction helper;
- shared `Problem`, `describeArtifactVersion`, `artifactRef`, access normalization and validation paths;
- one artifact request helper with detail upgrade behavior;
- one batch artifact-removal path for revocation and room departure;
- one tri-state relation getter (`undefined` not loaded, `[]` loaded empty);
- one empty workspace factory;
- batched workspace summary updates and stable sorting;
- a reusable module-level date formatter;
- reuse of the existing callout shell and interactive-row hover rule;
- removal of redundant screen CSS and dead version-stack markup.

Skipped suggestions that would require changing another worker's shared slice or a larger application-wide refactor, including a new shared access-view-model helper, generic paged-query framework, list virtualization, and a global clipboard hook. The workspace remains bounded and explicitly paginated; virtualization is not required for this release's contract.

## Integration concerns / next evidence

No desktop compile blocker remains against the final shared contract.

Still pending outside this slice:

1. Relay/engine/shared permanent tests and migration proof from their owners.
2. QA worker checks for the Files rail, cross-room paging, all honest states, exact links, permission changes/revocation, and 1280/narrow light/dark overflow.
3. Installed-app drive creating a real two-version linked file and walking preview/download/copy/access behavior.
4. Final coordinator review of concurrent file changes and the complete evidence chain.

The working tree contains concurrent changes from other feature workers and pre-existing QA artifacts. This worker did not edit, revert, commit or stage them.

## Desktop fix round 1

Addressed the coordinator's verified follow-up findings in the same three owned desktop source files:

- Relation privacy now has one conservative invalidation rule. Any artifact publish/access/unavailable fact clears every cached relation view, truncation mark and stale transient detail problem before a fresh projection can be installed. A generation check discards detail answers started before that invalidation, so an old response cannot repopulate a revoked target name, id or version.
- Relation detail respects the final shared bound. When `relationsTruncated === true`, the screen says: `Showing 100 links; more exist.` It does not claim a global newest order the protocol does not provide.
- The live workspace index is capped at the number of pages explicitly opened. Live pushes retain newest ordering, set `hasMore` when a tail is displaced and move the cursor to the new retained tail. If an older-page request was already in flight from the former tail, it is superseded and reissued from the new boundary so the displaced row is not skipped.
- A fresh workspace reset supersedes an older page already in flight. Epoch checks discard the stale answer rather than appending it after re-entry.
- Room membership refresh keys now include member role and removal state, not ids alone, and the current channel projection object is also a dependency so a remote role-only broadcast triggers a fresh member ask. File access authority and required-manager rows recompute, and changed membership invalidates relation views so role-based visibility is projected again.
- Initial, row and relationship selection now pass through the app's existing `attemptLeave` owner. The access draft guard is held by the Files screen rather than the detail child, so revocation cannot unmount the only guard before a selection change. Unsaved file-access drafts receive the same keep-editing/discard question as other editors.
- Access editor resets now compare semantic access values, not object identity. Equivalent access objects from a version push preserve dirty mode/member choices and form problems. A confirmed artifact switch resets the draft; an external semantic permission change resets only when the local draft is clean.
- Artifact detail silence/timeouts are retryable local problems. They no longer mark an accessible artifact gone or remove its workspace row. Explicit refusal and `artifactUnavailable` remain the non-probing terminal absence path.
- Revoked/nonexistent selected detail has a stable explicit `unavailable` data/UI state. It remains in place until the person uses the guarded **Choose another file** action, so an unsaved access draft cannot disappear silently. Transient detail errors have a stable `error` state and `data-relations-retry` action rather than an endless Looking state.
- If revocation empties the loaded rows while `hasMore` is true, the screen shows an honest backfill state and keeps **Older files** available instead of falsely claiming no files exist.
- Added QA-stable workspace `capacity`, backfill, detail-problem, truncation, unavailable and relation error/retry states through the existing DOM/window hooks.

No suitable isolated desktop unit-test file exists inside this worker's three-file ownership boundary. Permanent browser checks are owned by the concurrent QA slice; this round therefore added stable observable states and re-proved desktop compilation/build.

### Exact command evidence

Command:

```text
npm run typecheck:app
```

Exact output:

```text
> cloud9@0.1.0 typecheck:app
> tsc -p apps/desktop/tsconfig.json --noEmit
```

Command:

```text
npm run build -w @cloud9/desktop
```

Exact output:

```text
> @cloud9/desktop@0.1.0 build
> vite build

vite v8.1.5 building client environment for production...
transforming...✓ 27 modules transformed.
rendering chunks...
computing gzip size...
dist-web/index.html                   0.57 kB │ gzip:   0.34 kB
dist-web/assets/index-CrDcFIf8.css  119.38 kB │ gzip:  20.70 kB
dist-web/assets/index-CttOYpdz.js   493.24 kB │ gzip: 149.15 kB

✓ built in 280ms
```

## Desktop fix round 2

Completed the coordinator's final desktop correctness round:

- The access editor now owns an explicit semantic baseline containing the artifact, stored access key, access kind and selected-human ids the draft was derived from.
- Dirty state compares the draft with that baseline, never with a newly arrived server value.
- A clean draft adopts an external semantic access change by replacing both draft and baseline. A genuinely dirty draft remains unchanged and continues to register with the existing unsaved-work owner.
- Equivalent access object identities do not reset the draft. A confirmed saved access is recognised through its expected effective semantic key and becomes the next baseline when the server projection lands.
- Stable QA state is exposed through `data-access-dirty`, `data-access-incoming` and `data-access-baseline`.
- Artifact and artifact-workspace direct requests now carry unique `requestId` values and only responses echoing that exact id can settle them. Unsolicited artifact pushes omit the id, update caches, and cannot settle a detail question.
- The generic request ledger now removes only the matched entry. Earlier unrelated questions remain alive and keep their own timeout/lost callbacks.
- A late timed-out workspace answer cannot match its replacement request. A pushed artifact arriving between requests cannot consume either request.
- `window.cloud9Wire.questions()` exposes outstanding request kinds and ids for deterministic permanent QA of late-response and interleaved-push cases.

No isolated desktop unit-test file exists inside this worker's three-source-file ownership boundary. The stable hooks above are the deterministic seam for the concurrent permanent browser checks.

### Exact command evidence — fix round 2

Command:

```text
npm run typecheck:app
```

Exact output:

```text
> cloud9@0.1.0 typecheck:app
> tsc -p apps/desktop/tsconfig.json --noEmit
```

Command:

```text
npm run build -w @cloud9/desktop
```

Exact output:

```text
> @cloud9/desktop@0.1.0 build
> vite build

vite v8.1.5 building client environment for production...
transforming...✓ 27 modules transformed.
rendering chunks...
computing gzip size...
dist-web/index.html                   0.57 kB │ gzip:   0.33 kB
dist-web/assets/index-CrDcFIf8.css  119.38 kB │ gzip:  20.70 kB
dist-web/assets/index-C2valRRa.js   494.24 kB │ gzip: 149.45 kB

✓ built in 261ms
```

## Desktop fix round 3

Completed exact save correlation for file access:

- Every `setArtifactAccess` request now carries a unique `requestId` from the same desktop request-id generator used by artifact/workspace reads.
- The save succeeds only when an `artifact` response names the same artifact **and** echoes that exact request id.
- Same-file version, role and permission pushes omit the id. They continue to refresh safe caches, but cannot settle the save, clear its pending state or consume a later refusal.
- The existing generic ledger still routes an uncorrelated `error` to the oldest pending refusable question; the correlated success removes only its own ledger row.
- `client.artifactAccessSaveState()` and `window.cloud9Artifacts.accessSave()` expose the pending request id, state (`pending` / `succeeded` / `refused` / `lost`), count of uncorrelated same-file pushes observed while pending, and the terminal refusal/lost sentence.
- The access editor exposes `data-access-saving="yes|no"` alongside the existing dirty/incoming/baseline states. Permanent QA can now prove: save stays pending after a same-file push, then the later direct success or refusal settles the right request.

No isolated unit-test file exists inside the three-source-file desktop ownership boundary; the correlated request ledger plus stable QA hook is the deterministic seam for the permanent browser test.

### Exact command evidence — fix round 3

Command:

```text
npm run typecheck:app
```

Exact output:

```text
> cloud9@0.1.0 typecheck:app
> tsc -p apps/desktop/tsconfig.json --noEmit
```

Command:

```text
npm run build -w @cloud9/desktop
```

Exact output:

```text
> @cloud9/desktop@0.1.0 build
> vite build

vite v8.1.5 building client environment for production...
transforming...✓ 27 modules transformed.
rendering chunks...
computing gzip size...
dist-web/index.html                   0.57 kB │ gzip:   0.34 kB
dist-web/assets/index-CrDcFIf8.css  119.38 kB │ gzip:  20.70 kB
dist-web/assets/index-Cm4L0w30.js   495.18 kB │ gzip: 149.65 kB

✓ built in 245ms
```

## Desktop fix round 4

Completed the remaining request-ledger class fix:

- Fire-and-forget sends now go over the socket without creating a request-ledger row. Only a send with an answer, refusal or lost lifecycle is remembered.
- An `error` carrying `requestId` removes and refuses only the exact matching row. Older and later unrelated questions remain pending with their own timeout/lost callbacks.
- A legacy `error` without an id selects only the oldest no-id row that has a refusal callback. It skips ineligible rows and never shifts the first row blindly.
- An exact `setArtifactAccess` refusal now reaches that save's callback, records the relay's own sentence in `artifactAccessSaveState`, clears the editor's `data-access-saving` state through the existing callback, and removes the row so its timeout cannot later replace the refusal.
- Exact artifact/workspace/access success matching, unasked artifact push isolation, access baselines and the earlier lost/timeout behavior remain unchanged.
- `window.cloud9Wire.receive(frame)` now feeds a typed server frame through the real desktop dispatcher. `questions()` also reports whether each pending row is refusal-capable. Together with `cloud9Artifacts.accessSave()`, this is the deterministic browser seam for exact refusal/success and legacy no-id interleaving checks.

Round 4 changed two desktop source files: `apps/desktop/src/store.ts` and `apps/desktop/src/App.tsx`. `apps/desktop/src/styles.css` required no round-4 change. No commit was made.

### Deterministic request-ledger QA — fix round 4

Command:

```text
npx tsx - <<'TS'
[inline deterministic RelayClient ledger exercise]
TS
```

Exact output:

```text
request-ledger QA: 4/4 passed
1 fire-and-forget member ask created no row
2 exact access refusal kept unrelated request and relay reason
3 legacy no-id refusal skipped ineligible row
4 exact access success settled once
```

### Exact command evidence — fix round 4

Command:

```text
npm run typecheck:app
```

Exact output:

```text
> cloud9@0.1.0 typecheck:app
> tsc -p apps/desktop/tsconfig.json --noEmit
```

Command:

```text
npm run build -w @cloud9/desktop
```

Exact output:

```text
> @cloud9/desktop@0.1.0 build
> vite build

vite v8.1.5 building client environment for production...
transforming...✓ 27 modules transformed.
rendering chunks...
computing gzip size...
dist-web/index.html                   0.57 kB │ gzip:   0.34 kB
dist-web/assets/index-CrDcFIf8.css  119.38 kB │ gzip:  20.70 kB
dist-web/assets/index-D3348kn_.js   495.56 kB │ gzip: 149.74 kB

✓ built in 274ms
```

Command:

```text
git diff --check -- apps/desktop/src/App.tsx apps/desktop/src/store.ts apps/desktop/src/styles.css
```

Exact output:

```text
warning: in the working copy of 'apps/desktop/src/store.ts', LF will be replaced by CRLF the next time Git touches it
```

No whitespace errors were reported.

## Desktop fix round 5 — universal refusal correlation

The single transmit boundary now clones every outgoing `ClientFrame` that lacks a `requestId`, assigns a unique ID, sends that exact frame, and records the same ID only when the send has an answer/refusal/lost lifecycle. Fire-and-forget sends carry an ID on the wire but create no lifecycle row.

- Exact-ID errors settle only the row with the same ID and a refusal callback.
- No-ID legacy errors are general-only and cannot touch modern ID-bearing rows.
- A refused fire-and-forget operation reports its general error while every older pending request survives.
- Exact access success and refusal still route to the correct save; unrelated requests remain pending.
- Caller-owned frame objects are not mutated.
- Permanent QA hooks expose transmitted IDs, outstanding rows and general error state through `window.cloud9Wire`.

### Deterministic request-correlation evidence — fix round 5

```text
request-correlation QA: 15/15 passed
```

The exercise covered fire-and-forget refusal with an older pending request, exact access refusal and success, unrelated request survival, legacy no-ID isolation, caller-frame immutability and generated-ID uniqueness.

### Exact command evidence — fix round 5

```text
npm run typecheck:app
```

Result: passed.

```text
npm run build -w @cloud9/desktop
```

Exact build facts:

```text
vite v8.1.5 building client environment for production...
27 modules transformed.
dist-web/assets/index-CcB7aC2B.js  495.82 kB | gzip: 149.79 kB
built in 205ms
```

```text
git diff --check -- apps/desktop/src/App.tsx apps/desktop/src/store.ts apps/desktop/src/styles.css
```

No whitespace errors; only the existing LF-to-CRLF warning for `store.ts`.

### Independent breaker review

All request-ledger findings are ADDRESSED. Spec compliance and code quality are APPROVED for the desktop slice. No Critical or Important finding remains.
