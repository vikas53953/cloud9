# Feature 1 relay handoff

## Status

Implemented the relay/store slice for the shared Files workspace in the existing checkout. No commit was made.

Owned production files changed:

- `C:\Users\vikasmit\cloud9\apps\relay\src\store.ts` — schema v6, immutable artifact append, permissions, workspace queries, typed-link persistence and artifact cleanup.
- `C:\Users\vikasmit\cloud9\apps\relay\src\server.ts` — authorization, workspace/detail/list/ticket frames, access mutation, public projection, relation views and run attribution.

Owned test files changed:

- `C:\Users\vikasmit\cloud9\apps\relay\src\artifactstore.test.ts`
- `C:\Users\vikasmit\cloud9\apps\relay\src\store.coverage.test.ts`
- `C:\Users\vikasmit\cloud9\apps\relay\src\hardening.test.ts`

## What changed

### Safe schema migration

- Bumped relay schema from 5 to 6.
- Added transactional migration for:
  - unique `(artifactId, version)` enforcement;
  - whole-chain access rows and selected-user rows;
  - exact-version typed-link rows and incoming-link index.
- Existing artifacts receive room-default access through absence of an access row; no retained artifact/version row is rewritten or renumbered.
- Migration checks for legacy duplicate version claims before creating the unique index. It refuses and leaves them untouched rather than deleting or renumbering immutable data.
- Startup removes complete final artifact byte files that no valid version row references while holding the database write lock. Publish-only stages are ignored; if any version row is unreadable, the sweep stops rather than guessing which bytes are safe to delete.

### Immutable append and retention

- Server publishing now uses one store append transaction for identity metadata, version row and typed-link rows.
- Version rows use plain `INSERT`; neither version ids nor `(artifactId, version)` pairs can replace existing rows.
- Artifact bytes are written to a hub-minted publish-only stage, then atomically promoted to their immutable final name inside the append transaction. Any transaction refusal compensates by deleting the stage or promoted bytes, so no false `updatedAt`, consumed version number or complete orphan file remains.
- New-name room capacity is rechecked inside the append transaction.
- The existing newest-20 retention rule remains unchanged.
- Pruning removes outgoing links attached to a pruned source version. Links to a pruned target remain pinned and render unavailable rather than moving to a newer target.

### Workspace and permission behavior

- Added global Files pagination across every currently readable room using the stable `(updatedAt, id)` cursor.
- Room visibility and artifact restriction filters are inside SQL before `LIMIT`, including the older room-scoped artifact list.
- Workspace rows use shared `ArtifactWorkspaceEntry`, with `latest`, source room name, total published version number and explicit effective access.
- Access defaults to the source room.
- Restricted access accepts selected current human room members and always derives current human room owners/admins into the effective view.
- Only source-room owners/admins can change access.
- Direct-conversation files reject separate access mutation and remain room-inherited.
- Removing a room member also clears that membership spell's stored file selections, so rejoining does not silently restore old restricted access.
- Role changes immediately add/remove manager file access and send `artifactUnavailable` only for files the affected person previously could read.
- Explicit restriction changes send permitted users refreshed public artifacts and send `artifactUnavailable` only to newly revoked users, avoiding existence hints to people who never had access.

### Non-probing reads and tickets

- Detail, room list, global workspace, preview/ticket mint and ticket redemption all apply both current room visibility and the current artifact rule.
- Inaccessible and nonexistent detail/ticket ids return the same `no such file` refusal.
- Artifact tickets now carry the artifact id internally and re-run the artifact permission gate at HTTP redemption, so an already-minted ticket dies after file access is revoked.
- Attachment tickets retain their existing room-only behavior.

### Typed exact-version links

- Publishing calls shared `validateArtifactLinks` and `normaliseArtifactLinks` before storage.
- Every target is checked against stored state for exact retained version, same source room and publisher visibility before bytes are written.
- Store repeats the exact-version/same-room existence check inside the append transaction.
- Outgoing relation views expose exact target/name only when permitted. Hidden or pruned targets produce the strict hidden outgoing shape with no target reference and no name.
- Incoming relations are omitted unless the exact source version is retained and its chain is permitted.
- Raw stored `ArtifactVersion.links` never enter public frames. Store uses `StoredArtifactVersion`/`StoredArtifact`; detail, room list and ticket frames use `artifactForPublic`, and workspace latest versions use `artifactVersionForPublic`.

### Run attribution

- A published version keeps `runId` only when the stored run belongs to the publishing agent and the same source room.
- A valid id from another agent or another room is omitted rather than trusted as attribution.

## Permanent checks added

Focused coverage now includes:

- immutable `(artifactId, version)` refusal;
- append rollback preserving `updatedAt`/version counter and removing bytes;
- v5 to v6 migration preserving old version JSON and room-default access;
- permission filtering before the workspace page limit;
- stable cross-room pagination;
- room list filtering;
- owner/admin mutation and direct-message refusal;
- managers automatically included and immediate role-based revocation;
- `artifactUnavailable` cache invalidation without probing;
- permission re-check when an already-minted ticket is redeemed;
- exact-version outgoing and incoming relation views;
- hidden targets with no target id/name;
- pruned targets never substituted with a newer version;
- cross-room link refusal before artifact/byte storage;
- strict link-list and access-mutation validators at the relay boundary;
- raw stored links absent from public detail/list/ticket frames;
- same-agent/same-room run attribution.

## Red-to-green evidence

The permanent immutable-version test was deliberately added before the fix and run against the old store behavior.

Observed failure:

- `artifact versions: one artifact/version pair is immutable and cannot be replaced`
- Failed with `Missing expected exception` because two rows could claim version 1.

After adding the migration unique rule and changing storage to plain `INSERT`, the same focused check passed: 1 passed, 0 failed.

## Final evidence

Shared compiled before relay tests, as required.

Focused relay feature/migration run:

- Command: `node --test --test-force-exit apps/relay/dist/artifactstore.test.js apps/relay/dist/store.coverage.test.js apps/relay/dist/hardening.test.js`
- Result: 55 passed, 0 failed.

Full relay run:

- Command: `npm test -w @cloud9/relay`
- Result: 344 discovered; 340 passed, 0 failed, 3 skipped, 1 todo.
- Duration: about 19.8 seconds.

Additional checks:

- `npm run build -w @cloud9/shared` passed.
- `npm run build -w @cloud9/relay` passed.
- Scoped `git diff --check` reported no whitespace errors or conflict markers (only the checkout's LF-to-CRLF warnings on two test files).
- Focused high-confidence security review found no new High or Medium vulnerability in the relay slice.

## Concerns / handoff notes

- No relay blocker remains.
- Only relay tests were run, per assignment. The coordinator still needs the full cross-slice build/test/installed-app evidence chain.
- The relay intentionally stores raw exact link targets only in `StoredArtifactVersion` and `artifact_links`; every public artifact path must continue using the shared projection helpers.
- No files outside the five owned relay files were edited, except this explicitly requested handoff report.
- No commit was made.

## Relay fix round 1

All eight verified coordinator findings were addressed in the same five owned relay files.

### Fixes

- Replaced final-before-row artifact writes with a transaction-owned staging protocol. `writeArtifactBytes` now creates a `.publishing-*` stage. `appendArtifactVersion` promotes it to the immutable final name while holding the SQLite `BEGIN IMMEDIATE` lock used by startup cleanup. Startup ignores live publish stages and takes the same lock before deleting final orphans, so a second hub cannot delete bytes between publish write and row commit.
- Added durable stored-version shape validation before any `storedAs` value reaches `path.basename` or public projection. Valid JSON with an invalid shape is recorded in `Store.problems`, skipped, and makes cleanup preserve unknown bytes.
- Rechecked every restricted selected id as a current human source-room member inside the `setArtifactAccess` transaction before deleting/replacing the old rule.
- Replaced unbounded per-version relation walks with one deterministic permission-aware query capped by shared `ARTIFACT_LIMITS.relationDetail === 100`. Artifact detail sends `relationsTruncated: true` only when a real permitted/hidden 101st public relation exists; absence means complete.
- Artifact detail now always sends `relations`, including explicit `relations: []`, so clients can clear stale cached relationships.
- Publishing, pruning and access changes refresh every affected source/target projection. This covers new incoming links, hidden source removal from a target's incoming list, hidden targets becoming outgoing placeholders, and exact target pruning.
- Role/member changes now refresh effective artifact access summaries for all remaining current readers, while the changed/revoked person still receives non-probing `artifactUnavailable` only for chains they previously could read.
- Workspace pagination now scans older permission-filtered SQL pages until it fills the requested page with valid projected rows or valid data is exhausted. Its cursor and `hasMore` are based only on returned valid artifacts.

### New fail-capable permanent checks

- Deterministic two-hub interleaving proves `rowExists=true` cannot end with `bytesExist=false`.
- Post-DB-mutation duplicate-link failure proves artifact metadata, version row, link row and promoted bytes all roll back together.
- Legacy duplicate `(artifactId, version)` migration refuses, remains schema v5 and leaves both rows untouched.
- Valid JSON `{}` version row cannot crash startup cleanup and is reported.
- Selected-member removal followed by rejoin does not restore old restricted access.
- Malformed workspace rows do not shorten pages or corrupt cursors.
- New incoming relations are pushed; hiding a source pushes an explicit empty target relation list; hiding/pruning a target pushes the source placeholder.
- Missing exact targets are refused before artifact identity or bytes are stored.
- Role and member changes push refreshed effective-access summaries to remaining readers.
- Relation detail returns exactly 100 rows plus `relationsTruncated: true` when a permitted 101st row exists.

### API changes used

- Shared `ARTIFACT_LIMITS.relationDetail` is used as the single 100-row relation-detail cap.
- Shared artifact detail frame `relationsTruncated?: true` is emitted only when truncated; false is never sent.
- Relay store `writeArtifactBytes` now returns `{ stagedAs, storedAs }` for transaction-owned promotion.
- Relay store `appendArtifactVersion` now requires that stage object.

### Exact fix-round evidence

Shared and relay build command:

```text
npm run build -w @cloud9/shared; if ($?) { npm run build -w @cloud9/relay }
```

Exact result:

```text
> @cloud9/shared@0.1.0 build
> tsc -p tsconfig.json

> @cloud9/relay@0.1.0 build
> tsc -p tsconfig.json
```

Focused command:

```text
node --test --test-force-exit "apps/relay/dist/artifactstore.test.js" "apps/relay/dist/store.coverage.test.js" "apps/relay/dist/hardening.test.js"
```

Exact summary:

```text
ℹ tests 61
ℹ suites 0
ℹ pass 61
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9419.7159
```

Full relay command:

```text
npm test -w @cloud9/relay
```

Exact summary:

```text
ℹ tests 350
ℹ suites 0
ℹ pass 346
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 1
ℹ duration_ms 19434.6344
```

Scoped diff check command:

```text
git diff --check -- "apps/relay/src/store.ts" "apps/relay/src/server.ts" "apps/relay/src/artifactstore.test.ts" "apps/relay/src/store.coverage.test.ts" "apps/relay/src/hardening.test.ts"
```

Exact result: no whitespace errors or conflict markers; Git printed only the checkout's LF-to-CRLF warnings for `artifactstore.test.ts` and `hardening.test.ts`.

### Post-review stage-litter closure

The independent fix review found one remaining gap: live stages were protected, but a process that died before append could leave its `.publishing-*` stage forever.

The stage name already records its process id. Startup cleanup now:

- keeps a stage when that process is still alive;
- treats `EPERM` as alive rather than deleting another account's live stage;
- removes a protocol stage immediately when its owning process no longer exists;
- applies a 24-hour safety age only to unknown legacy stage names that do not carry a parseable process id;
- performs the decision and deletion while holding the same database write lock as publication.

A permanent restart test creates an abandoned stage for a nonexistent process and proves startup deletes it, while the existing two-live-hub interleaving still proves a current process's stage survives and commits with its bytes.

Latest focused command:

```text
npm run build -w @cloud9/shared; if ($?) { npm run build -w @cloud9/relay }; if ($?) { node --test --test-force-exit "apps/relay/dist/artifactstore.test.js" "apps/relay/dist/store.coverage.test.js" "apps/relay/dist/hardening.test.js" }
```

Exact latest focused summary:

```text
ℹ tests 62
ℹ suites 0
ℹ pass 62
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10449.3519
```

Latest full relay command:

```text
npm test -w @cloud9/relay
```

Exact latest full summary:

```text
ℹ tests 351
ℹ suites 0
ℹ pass 347
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 1
ℹ duration_ms 28180.0264
```

### Request correlation seam

Shared added the exact optional `requestId?: ID` seam on artifact and artifactWorkspace request/answer frames.

Relay behavior:

- A direct `artifact` answer echoes the exact request id.
- A direct `artifactWorkspace` answer echoes the exact request id.
- An old request with no id still receives the same answer and the response omits the field.
- Unsolicited publication, access-refresh, role/member-refresh and relation-cache-refresh artifact pushes call the no-id projection path and never carry `requestId`.

Permanent coverage exercises all four cases, including a publication push and an access-refresh push with no correlation id.

Final focused command:

```text
npm run build -w @cloud9/shared; if ($?) { npm run build -w @cloud9/relay }; if ($?) { node --test --test-force-exit "apps/relay/dist/artifactstore.test.js" "apps/relay/dist/store.coverage.test.js" "apps/relay/dist/hardening.test.js" }
```

Exact final focused summary:

```text
ℹ tests 63
ℹ suites 0
ℹ pass 63
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 12437.5394
```

Final full relay command:

```text
npm test -w @cloud9/relay
```

Exact final full summary:

```text
ℹ tests 352
ℹ suites 0
ℹ pass 348
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 1
ℹ duration_ms 22474.1942
```

## Relay fix round 2 — missing exact target byte evidence

The existing missing-exact-target check now proves all three negative outcomes before any valid artifact is published in the fixture:

- no artifact identity row for `missing-target.md`;
- zero rows in `artifact_versions`;
- the artifact directory is absent or exactly empty — no `.publishing-*` stage, `writeWholeFile` pending part, final byte file or other litter.

### Deliberate red proof

I temporarily injected `writeArtifactBytes(...)` before exact-target validation in the production publish path, built relay, and ran the typed-link test.

Command:

```text
npm run build -w @cloud9/relay; if ($?) { node --test --test-force-exit --test-name-pattern "typed links pin exact" "apps/relay/dist/artifactstore.test.js" }
```

Exact failing summary:

```text
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 821.8716
```

The permanent assertion failed on the staged litter, showing this actual file:

```text
.publishing-44716-stage_HrPEuEXqDoc1kKFCnRxd6Q-av_msbodan1kz1uzg-missing-target.md
```

Failure sentence:

```text
target validation happens before byte staging: no staged, pending or final artifact litter exists
```

The deliberate production injection was then removed.

### Restored green proof

Command:

```text
npm run build -w @cloud9/shared; if ($?) { npm run build -w @cloud9/relay }; if ($?) { node --test --test-force-exit "apps/relay/dist/artifactstore.test.js" "apps/relay/dist/store.coverage.test.js" "apps/relay/dist/hardening.test.js" }
```

Exact latest focused summary, superseding the earlier focused duration while keeping the same 63 permanent tests:

```text
ℹ tests 63
ℹ suites 0
ℹ pass 63
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 13399.7055
```

No production test seam remains and no commit was made.

## Relay fix round 3

### Durable final rename before database commit

- Artifact publish stages are already whole-file flushed by the shared engine writer.
- After the transaction renames the stage to the immutable final name and inserts artifact/version/link rows, relay now flushes the artifact directory before the transaction may return to SQLite `COMMIT`.
- Windows is handled explicitly: directory handles/fsync are unsupported there, matching the established wholefile rule. On POSIX, directory open/fsync failures are real publish failures.
- A deterministic test seam observes the final name already present, opens a second SQLite connection and proves the version row is still invisible, then allows commit.
- The same seam throws a directory-flush failure after database mutation. The test proves the version counter, updatedAt, version row and link transaction roll back and both staged/final bytes are compensated.

### Versioned stage ownership

Current stages now use the unambiguous shape:

```text
.publishing-v2-<pid>-boot_<startupNonce>-stage_<stageId>-<finalName>
```

One parser owns stage meaning:

- only the exact v2 shape may claim a pid;
- a current stage is kept only when BOTH its mtime is inside the 60-second grace and its pid is alive;
- a live reused pid cannot protect an old stage;
- numeric legacy names are legacy, not guessed pid claims;
- legacy/unknown/malformed names use age only: recent is kept, old is reclaimed.

Permanent checks cover live+recent, dead+recent, reused-live-pid+old, numeric legacy recent→old, and malformed recent→old.

### Projection-diff push owner

All unsolicited artifact refreshes now go through one public projection diff:

- snapshots include the public artifact, effective access, permitted/hidden relations, explicit empty relations and truncation state for every room viewer;
- unchanged fingerprints send zero frames;
- visible changes send the fresh no-request-id artifact frame;
- visible→hidden sends `artifactUnavailable`;
- hidden→hidden is silent.

Publish, access, pruning, member add/join/remove/leave, role changes and user removal all capture before mutation and diff afterwards. A hidden restricted-source publication now produces zero artifact frames/timing hints for Priya, while source/target viewers whose visible relation changes still receive refresh or explicit `relations: []`.

### Access mutation and error request ids

- `setArtifactAccess` accepts shared `requestId?: ID`.
- The requesting socket receives exactly one direct success artifact frame with the exact id.
- Other machines and relation/access refreshes use the projection diff and omit requestId; the requesting socket is excluded from the duplicate push.
- Old no-id access mutations remain valid.
- The per-frame refusal catch echoes requestId on direct artifact, artifactWorkspace and setArtifactAccess errors.
- Old/general no-id errors omit the field and no unsolicited error invents one.

### Combined-suite instability root cause

The disclosed focused-suite instability reproduced once as 66/67. It was not stage litter.

The exact-version pruning test published target versions through v21 before clearing the owner frames. With the 20-version cap, v1 was already pruned by v21. The test then published v22 and waited for another source refresh even though the source's public hidden relation was unchanged; the new projection-diff owner correctly sent nothing. Older runs sometimes passed by consuming the stale queued v21 refresh, so the test itself was timing-dependent.

The fixture now publishes only through v20, clears frames, then publishes v21 — the exact operation that prunes v1 — and waits for that real changed projection. The focused suite then passed consistently.

### Exact final evidence

Build + focused command:

```text
npm run build -w @cloud9/shared; if ($?) { npm run build -w @cloud9/relay }; if ($?) { node --test --test-force-exit "apps/relay/dist/artifactstore.test.js" "apps/relay/dist/store.coverage.test.js" "apps/relay/dist/hardening.test.js" }
```

Exact focused summary:

```text
ℹ tests 67
ℹ suites 0
ℹ pass 67
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10479.6436
```

Full relay command:

```text
npm test -w @cloud9/relay
```

Exact full summary:

```text
ℹ tests 356
ℹ suites 0
ℹ pass 352
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 1
ℹ duration_ms 16934.5762
```

Final scoped `git diff --check` produced no errors or conflict markers, only the checkout's existing LF→CRLF warnings for the two relay test files. No commit was made.

### Every-frame refusal correlation

Shared's final `WithRequestId<ClientFrameBase>` seam makes optional requestId available on every unchanged ClientFrame variant.

Relay's per-frame catch now generically checks `isSafeStoredId(frame.requestId)` and echoes that exact valid id on any direct refusal. This is not artifact-specific. No-id frames and invalid/absent ids produce the existing no-id error; errors not tied to a parsed frame do not invent correlation.

Permanent checks now include an ordinary fire-and-forget `send` to a nonexistent room:

- with `req_send_error`, its refusal echoes exactly that id;
- the unchanged old form without an id receives the same refusal and has no requestId property.

No ordinary success frame gained a new response field.

Latest focused command:

```text
npm run build -w @cloud9/shared; if ($?) { npm run build -w @cloud9/relay }; if ($?) { node --test --test-force-exit "apps/relay/dist/artifactstore.test.js" "apps/relay/dist/store.coverage.test.js" "apps/relay/dist/hardening.test.js" }
```

Exact latest focused summary:

```text
ℹ tests 67
ℹ suites 0
ℹ pass 67
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 14995.8578
```

Latest full relay command:

```text
npm test -w @cloud9/relay
```

Exact latest full summary:

```text
ℹ tests 356
ℹ suites 0
ℹ pass 352
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 1
ℹ duration_ms 26606.2666
```

## Relay fix round 4 — startup nonce ownership

### Fix

- The v2 stage parser now retains the startup nonce instead of reducing ownership to a pid.
- One startup nonce is minted for the process lifetime and shared by every `Store` opened in that process.
- A recent stage carrying this process's pid is protected only when its nonce also equals this process's startup nonce.
- A recent stage carrying this pid but a different nonce is reclaimed immediately as an abandoned earlier startup, covering pid reuse.
- A different live pid keeps the established recent-plus-live protection. Old stages are reclaimed regardless of pid state.
- Legacy numeric and malformed stage names keep their age-only behavior.

### Deliberate red proof

Command:

```text
npm run build -w @cloud9/relay; if ($?) { node --test --test-force-exit --test-name-pattern "startup cleanup cannot delete|another startup nonce|another live pid" "apps/relay/dist/hardening.test.js" }
```

Exact red summary before the production fix:

```text
ℹ tests 3
ℹ suites 0
ℹ pass 2
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 701.4136
```

The failing permanent check was:

```text
a recent v2 stage with this pid but another startup nonce is reclaimed
```

It observed the recent abandoned stage still present (`true !== false`).

### Exact final evidence

Focused build and relay feature command:

```text
npm run build -w @cloud9/shared; if ($?) { npm run build -w @cloud9/relay }; if ($?) { node --test --test-force-exit "apps/relay/dist/artifactstore.test.js" "apps/relay/dist/store.coverage.test.js" "apps/relay/dist/hardening.test.js" }
```

Exact focused summary:

```text
ℹ tests 68
ℹ suites 0
ℹ pass 68
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 11968.2952
```

Full relay command:

```text
npm test -w @cloud9/relay
```

Exact full summary:

```text
ℹ tests 357
ℹ suites 0
ℹ pass 353
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 1
ℹ duration_ms 20721.4078
```

Scoped `git diff --check` reported no whitespace errors or conflict markers; Git printed only the checkout's existing LF-to-CRLF warnings for `artifactstore.test.ts` and `hardening.test.ts`.

No commit was made. No relay concern remains from this startup-stage finding.

### Pre-auth refusal request correlation closure

- Every direct relay refusal now goes through one safe request-id echo helper, including failures before authentication.
- Invalid ordinary hello, invite-form hello and `joinWithToken` frames echo an exact valid request id.
- Existing refusal words and token secrecy are unchanged.
- Old no-id frames still receive no request-id field.
- Input that cannot be parsed into a frame remains silent and cannot invent correlation.

Deliberate red command:

```text
npm run build -w @cloud9/relay; if ($?) { node --test --test-force-exit --test-name-pattern "pre-auth" "apps/relay/dist/hardening.test.js" }
```

Exact red summary before the server fix:

```text
ℹ tests 2
ℹ suites 0
ℹ pass 1
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 628.4183
```

The invalid-hello assertion received the unchanged `bad token` refusal but no `requestId`.

Final focused build and test command:

```text
npm run build -w @cloud9/shared; if ($?) { npm run build -w @cloud9/relay }; if ($?) { node --test --test-force-exit "apps/relay/dist/artifactstore.test.js" "apps/relay/dist/store.coverage.test.js" "apps/relay/dist/hardening.test.js" }
```

Exact focused summary:

```text
ℹ tests 70
ℹ suites 0
ℹ pass 70
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 10729.326
```

Final full relay command:

```text
npm test -w @cloud9/relay
```

Exact full summary:

```text
ℹ tests 359
ℹ suites 0
ℹ pass 355
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 1
ℹ duration_ms 21599.2082
```

No commit was made. No relay blocker remains from the pre-auth request-correlation finding.

## Relay fix round 5 — final pre-auth and stage-append closure

### Root cause and fix

- Pre-auth input was cast to `ClientFrame` immediately after `JSON.parse`. `frame.type` was read before proving the parsed value was an object, and the catch tried to read `frame.type` again. A valid JSON `null` therefore escaped the WebSocket callback as an uncaught `TypeError`.
- The relay now accepts a frame envelope only when the parsed value is a non-null, non-array object with an own string `type`. Invalid parsed shapes receive the ordinary `not authenticated` refusal. Error correlation reads `requestId` only from an own string field that passes `isSafeStoredId`; primitives, arrays, inherited ids, non-string ids, unsafe ids and oversized ids cannot echo.
- `appendArtifactVersion` previously accepted any syntactically valid v2 stage and treated it as compensation-owned. It did not prove the stage pid/nonce belonged to this process lifetime or that the stage filename encoded the exact final version id/name. A foreign stage could therefore be promoted, and a refusal could delete bytes owned by another append.
- Append now verifies, before entering compensation scope: current-format parse, exact process pid, exact startup nonce, exact encoded final filename, exact stage final target and exact version-row `storedAs`. Any mismatch is refused before rename and leaves the stage untouched. Compensation runs only after exact ownership is established.
- Startup age remains authoritative: an old v2 stage carrying this pid and this nonce is reclaimed after the grace window.

### Deliberate red evidence

The permanent process-level WebSocket test was first run against the crashing server.

```text
npm run build -w @cloud9/relay; if ($?) { node --test --test-force-exit --test-name-pattern "pre-auth valid JSON" "apps/relay/dist/hardening.test.js" }
```

```text
ℹ tests 1
ℹ pass 0
ℹ fail 1
ℹ duration_ms 604.221
TypeError: Cannot read properties of null (reading 'type')
  at WebSocket.<anonymous> (.../apps/relay/dist/server.js:217:69)
```

The child-process check sends `null`, number, string, array, `{}`, a truly inherited `type`, an attempted JSON `__proto__` type, and non-string `type` values, then signs in on the same socket. It also checks own/inherited/non-string/array/unsafe/oversized request ids. The process died on `null` before the fix.

Each load-bearing stage condition was also removed deliberately, one at a time, and restored after its permanent test failed:

```text
npm run build -w @cloud9/relay; if ($?) { node --test --test-force-exit --test-name-pattern "foreign current-format stage" "apps/relay/dist/store.coverage.test.js" }
```

```text
ℹ tests 1
ℹ pass 0
ℹ fail 1
ℹ duration_ms 906.9738
AssertionError: Missing expected exception.
```

```text
npm run build -w @cloud9/relay; if ($?) { node --test --test-force-exit --test-name-pattern "foreign pid even" "apps/relay/dist/store.coverage.test.js" }
```

```text
ℹ tests 1
ℹ pass 0
ℹ fail 1
ℹ duration_ms 409.7561
AssertionError: Missing expected exception.
```

```text
npm run build -w @cloud9/relay; if ($?) { node --test --test-force-exit --test-name-pattern "parsed stage filename" "apps/relay/dist/store.coverage.test.js" }
```

```text
ℹ tests 1
ℹ pass 0
ℹ fail 1
ℹ duration_ms 581.9805
AssertionError: Missing expected exception.
```

```text
npm run build -w @cloud9/relay; if ($?) { node --test --test-force-exit --test-name-pattern "redirect an owned stage object" "apps/relay/dist/store.coverage.test.js" }
```

```text
ℹ tests 1
ℹ pass 0
ℹ fail 1
ℹ duration_ms 339.2018
AssertionError: Missing expected exception.
```

Removing the own-`type` check made the inherited-type sentinel authenticate and failed with `'welcome' !== 'error'`. Removing the own-`requestId` check made the inherited id echo and failed with `true !== false`. Both used the same focused pre-auth command above; the guards were restored before final verification.

### Permanent checks added

- Valid JSON `null`, number, string, array, `{}`, inherited/attempted-inherited type and non-string type cannot crash or authenticate; the same child process and socket still complete a valid hello afterwards.
- Request ids echo only from safe own fields on malformed pre-auth objects.
- A spent invite's pre-auth refusal echoes its exact safe request id.
- Foreign nonce and foreign pid are pinned independently; each refusal leaves identity row absent, version row absent, final file absent and foreign stage present.
- Parsed stage filename, stage final target, version id and publish name are bound independently; mismatched stages are preserved rather than compensated away.
- An old v2 stage with this pid and this startup nonce is still reclaimed by age.

### Exact final evidence

Shared build, relay build and focused three-file suite:

```text
npm run build -w @cloud9/shared; if ($?) { npm run build -w @cloud9/relay }; if ($?) { node --test --test-force-exit "apps/relay/dist/artifactstore.test.js" "apps/relay/dist/store.coverage.test.js" "apps/relay/dist/hardening.test.js" }
```

```text
> @cloud9/shared@0.1.0 build
> tsc -p tsconfig.json

> @cloud9/relay@0.1.0 build
> tsc -p tsconfig.json

ℹ tests 78
ℹ suites 0
ℹ pass 78
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 21408.1112
```

Full relay suite:

```text
npm test -w @cloud9/relay
```

```text
ℹ tests 367
ℹ suites 0
ℹ pass 363
ℹ fail 0
ℹ cancelled 0
ℹ skipped 3
ℹ todo 1
ℹ duration_ms 28798.889
```

Scoped diff check:

```text
git diff --check -- "apps/relay/src/store.ts" "apps/relay/src/server.ts" "apps/relay/src/artifactstore.test.ts" "apps/relay/src/store.coverage.test.ts" "apps/relay/src/hardening.test.ts"
```

Result: no whitespace errors or conflict markers. Git printed only the checkout's existing LF-to-CRLF warnings for `artifactstore.test.ts` and `hardening.test.ts`.

No commit was made.
