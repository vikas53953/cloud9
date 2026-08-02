- **HIGH** — `C:\Users\vikasmit\cloud9\packages\engine\src\artifacts.ts:119-135` reads the entire current manifest synchronously before the 64 KiB limit is enforced. The limit is checked only after the full file has become a JavaScript string (`C:\Users\vikasmit\cloud9\packages\shared\src\index.ts:2796-2805`), where `TextEncoder` allocates another byte copy. A provider can write an arbitrarily large `.cloud9/artifact-links.json` and return normally; the engine then loads the whole file during `shareProduced`, so a sparse or very large manifest can block or exhaust the engine process instead of producing the required bounded plain refusal. The new engine tests cover small malformed manifests only (`C:\Users\vikasmit\cloud9\packages\engine\src\artifact-manifest.test.ts:170-194`) and do not exercise the 64 KiB boundary at the file-reading seam.

- **MEDIUM** — `C:\Users\vikasmit\cloud9\packages\engine\src\artifacts.ts:136-143` appends the shared parser's detailed reason to the room-visible refusal, but several reasons interpolate private manifest-controlled file names (`C:\Users\vikasmit\cloud9\packages\shared\src\index.ts:2773-2788`); that refusal is sent to the conversation at `C:\Users\vikasmit\cloud9\packages\engine\src\engine.ts:667-671`. Concrete reproduction with the current parser returned `{"ok":false,"reason":"the links for \"private-roadmap.txt\" must be a list"}`, so a bad private manifest leaks its declared name into chat despite the stated no-untrusted-content privacy rule. The added negative test checks only that one note string is absent (`C:\Users\vikasmit\cloud9\packages\engine\src\artifact-manifest.test.ts:189-193`), leaving filename-bearing parser failures uncovered.

# Engine implementation and review-fix resolution

## Status

READY FOR INTEGRATION. No commit was made.

The two review findings above are now resolved, along with the coordinator's three engine review findings.

## Final behavior

- Reads only a current-turn `.cloud9/artifact-links.json`.
- Reads at most the shared 64 KiB limit plus one refusal byte; oversized private manifests are never loaded whole.
- Uses `parseArtifactLinkManifest` for strict shared validation and canonical typed-link de-duplication.
- Uses one generic room-visible refusal for bad private data. Parser details, notes, declared file names, raw JSON, and machine paths are not repeated into chat.
- Matches manifest rows only to files actually produced in the turn.
- Detects normalized-name collisions such as `a b.txt` and `a  b.txt`; every colliding file remains unannotated and one refusal asks for a rename.
- Captures exact local file identity, size, modification time, and change time during the sweep.
- Immediately before publish, checks the open file before and after reading and checks the path again. Rewritten, replaced, or concurrently changing files do not publish with stale note, links, or run attribution.
- `publishArtifact` still carries the shared input type `ArtifactLink[]`; the engine makes no assumption that public `ArtifactVersion` exposes raw stored links.
- Markdown is never inspected for relationships.
- Every provider call and every produced-file publish remains behind the single `respondAs` / `shareProduced` funnel. A permanent source invariant fails if another provider doorway or publish path is introduced.
- Every successful publish carries the exact run ID created for that turn.

## Engine API changes

Internal engine API only:

- `ProducedFile` now includes `state: ProducedFileState`.
- New exported helper: `readProducedBytes(file: ProducedFile): Buffer | undefined`.
- No wire API was added or changed by the engine fix round.
- Shared final seam required no engine rename: private manifest rows and `publishArtifact.links` continue to use `ArtifactLink`; public `ArtifactVersion` is not used as a raw-link container here.

## Owned files changed

- `C:\Users\vikasmit\cloud9\packages\engine\src\artifacts.ts`
- `C:\Users\vikasmit\cloud9\packages\engine\src\engine.ts`
- `C:\Users\vikasmit\cloud9\packages\engine\src\artifacts.test.ts`
- `C:\Users\vikasmit\cloud9\packages\engine\src\artifact-manifest.test.ts` (new)

`C:\Users\vikasmit\cloud9\packages\engine\src\artifactref.test.ts` required no change.

## Permanent checks added

- current, stale, absent, malformed, exact-limit, and over-limit manifests;
- normalized matching and ambiguous normalized collisions;
- private manifest exclusion and no accidental file creation/sharing;
- exact `made-from` / `goes-with` frame data pinned to target versions;
- no markdown inference;
- no private filename/note/path leakage in refusals;
- exact swept-state byte reading, including a same-size rewrite with restored mtime;
- one provider doorway, one publish funnel, and mandatory state-checking reader use;
- correct run ID on every publish.

## Deliberate failure proof

Normalised manifest lookup was deliberately broken after the first green run. Two new tests failed because notes and links disappeared. The real lookup was restored before the final runs.

## Final focused command and exact output

Command:

```text
npm run build -w @cloud9/shared && npm run build -w @cloud9/engine && node --test packages/engine/dist/artifacts.test.js packages/engine/dist/artifact-manifest.test.js
```

Output:

```text
> @cloud9/shared@0.1.0 build
> tsc -p tsconfig.json

> @cloud9/engine@0.1.0 build
> tsc -p tsconfig.json

✔ publishArtifact carries the matching note and exact-version typed links, not the manifest (35.9748ms)
✔ the source has one provider doorway and one produced-file funnel (2.0554ms)
✔ markdown that mentions file relationships never becomes typed link data (15.0785ms)
✔ a malformed current manifest produces a plain refusal but the file still publishes unannotated (17.3486ms)
✔ a file the turn wrote is offered; one that was already there is not (5.2027ms)
✔ the engine's own bookkeeping and a checkout's litter are never shared (4.4561ms)
✔ a file still being written is invisible, so nothing is ever shared half-made (1.0244ms)
✔ too big is REFUSED IN WORDS, with the size, the limit and what to do (9.2952ms)
✔ a name that may not become a file is refused, never quietly renamed (8.311ms)
✔ a turn that changed hundreds of files shares the newest few and SAYS SO (12.0787ms)
✔ an empty file and a folder that cannot be read produce nothing, and no throw (2.7786ms)
✔ the refusal sentence is one short message, never a wall of them (0.8599ms)
✔ a current private manifest attaches its note and exact typed links only to the matching file (4.6266ms)
✔ an old manifest is ignored before its contents are read (5.7906ms)
✔ bad current manifest data is refused in plain words and no part of it is guessed (8.1299ms)
✔ the private manifest read is bounded at the shared byte limit (7.3286ms)
✔ an ambiguous normalised name leaves every colliding file unannotated and says why once (6.7372ms)
✔ no manifest leaves annotations absent from the existing produced-file result (4.1435ms)
✔ bytes are read only while the produced file still has the exact swept state (2.5655ms)
ℹ tests 19
ℹ suites 0
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 394.1918
```

## Final full engine command and exact summary

Command:

```text
npm test -w @cloud9/engine
```

Output summary:

```text
ℹ tests 594
ℹ suites 0
ℹ pass 594
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 39388.3525
```

## Concerns

- Same-room target lookup, target existence, access enforcement, hidden-target projection, and private stored-link/public-view separation remain relay/shared responsibilities. The engine sends only strict shared-validated input links.
- No engine blocker remains.

# Engine fix round 2 — runtime entry-path proof

## Coverage correction

The earlier direct `respondAs` variants were removed. The permanent runtime test now drives the real paths:

- chat through public `takeTurn`;
- delegated work through the relay's real `task` frame entry, then the queue and task runner;
- scheduled work through public `scheduler.tick`, which invokes the engine's schedule callback;
- repository work through public `workInRepository`, using a real temporary Git repository and a real Cloud9 git worktree.

Each path asserts exactly one `publishArtifact`, exactly one run record, and equality between the published `runId` and that record's id. The task case also proves `taskId` reaches both the run and publish frame. The repository case proves the provider receives the exact created worktree and that sharing sweeps that worktree rather than the ordinary agent folder.

The complementary source invariant remains, but runtime behavior is now the primary proof.

## Additional exact-byte correction found by the new run

The first focused run exposed a real filesystem edge: on this Windows filesystem, a same-size rewrite with restored mtime can also retain the captured change time. The state-only test failed and returned the changed bytes. The fix now hashes only the newest at-most-`maxFiles` candidates during the sweep and compares that digest immediately before publish. This binds note, links and run attribution to exact bytes without reading thousands of files in a runaway folder.

Internal API detail: `ProducedFileState.sha256?: string` is populated before a file becomes an offer. No wire API changed.

## Focused command and exact output

Command:

```text
npm run build -w @cloud9/shared && npm run build -w @cloud9/engine && node --test packages/engine/dist/artifacts.test.js packages/engine/dist/artifact-manifest.test.js
```

Output:

```text
> @cloud9/shared@0.1.0 build
> tsc -p tsconfig.json

> @cloud9/engine@0.1.0 build
> tsc -p tsconfig.json

✔ publishArtifact carries the matching note and exact-version typed links, not the manifest (26.0984ms)
✔ the source has one provider doorway and one produced-file funnel (7.6573ms)
▶ real chat, task, schedule and repository entries each reach one run-linked publish
  ✔ chat entry (21.5003ms)
  ✔ delegated task frame (15.9261ms)
  ✔ scheduled tick (20.9675ms)
[git] prepared cloud9/a1-msbmblj9 for agent a1
  ✔ repository worktree entry (1811.8063ms)
✔ real chat, task, schedule and repository entries each reach one run-linked publish (1871.9555ms)
✔ markdown that mentions file relationships never becomes typed link data (56.7077ms)
✔ a malformed current manifest produces a plain refusal but the file still publishes unannotated (14.7095ms)
✔ a file the turn wrote is offered; one that was already there is not (10.8122ms)
✔ the engine's own bookkeeping and a checkout's litter are never shared (20.0546ms)
✔ a file still being written is invisible, so nothing is ever shared half-made (5.1117ms)
✔ too big is REFUSED IN WORDS, with the size, the limit and what to do (19.7665ms)
✔ a name that may not become a file is refused, never quietly renamed (2.8098ms)
✔ a turn that changed hundreds of files shares the newest few and SAYS SO (16.1853ms)
✔ an empty file and a folder that cannot be read produce nothing, and no throw (1.9058ms)
✔ the refusal sentence is one short message, never a wall of them (1.1819ms)
✔ a current private manifest attaches its note and exact typed links only to the matching file (4.13ms)
✔ an old manifest is ignored before its contents are read (1.7695ms)
✔ bad current manifest data is refused in plain words and no part of it is guessed (1.9115ms)
✔ the private manifest read is bounded at the shared byte limit (7.7768ms)
✔ an ambiguous normalised name leaves every colliding file unannotated and says why once (3.5509ms)
✔ no manifest leaves annotations absent from the existing produced-file result (1.5661ms)
✔ bytes are read only while the produced file still has the exact swept state (2.9269ms)
ℹ tests 24
ℹ suites 0
ℹ pass 24
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2240.0599
```

## Full engine confirmation

Command:

```text
npm test -w @cloud9/engine
```

Exact summary:

```text
ℹ tests 599
ℹ suites 0
ℹ pass 599
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36041.2946
```

## Round 2 concerns

- No engine blocker remains.
- The repository entry test intentionally uses local git only; its GitHub client is a deterministic disconnected stub, so nothing can leave the machine.

## Round 2 final correction — public task entry

The delegated-task check now enters through public `Engine.connect()` and a real local WebSocket relay. The relay sends `welcome` followed by the real `task` server frame. No private engine method is invoked by the test.

Final focused command:

```text
npm run build -w @cloud9/shared && npm run build -w @cloud9/engine && node --test packages/engine/dist/artifacts.test.js packages/engine/dist/artifact-manifest.test.js
```

Exact output:

```text
> @cloud9/shared@0.1.0 build
> tsc -p tsconfig.json

> @cloud9/engine@0.1.0 build
> tsc -p tsconfig.json

✔ publishArtifact carries the matching note and exact-version typed links, not the manifest (16.1443ms)
✔ the source has one provider doorway and one produced-file funnel (1.088ms)
▶ real chat, task, schedule and repository entries each reach one run-linked publish
  ✔ chat entry (8.2184ms)
  ✔ delegated task through the public relay connection (75.7794ms)
  ✔ scheduled tick (27.3074ms)
[git] prepared cloud9/a1-msbmfnl7 for agent a1
  ✔ repository worktree entry (2426.6887ms)
✔ real chat, task, schedule and repository entries each reach one run-linked publish (2539.1416ms)
✔ markdown that mentions file relationships never becomes typed link data (33.8438ms)
✔ a malformed current manifest produces a plain refusal but the file still publishes unannotated (72.3562ms)
✔ a file the turn wrote is offered; one that was already there is not (5.9337ms)
✔ the engine's own bookkeeping and a checkout's litter are never shared (17.4829ms)
✔ a file still being written is invisible, so nothing is ever shared half-made (2.0837ms)
✔ too big is REFUSED IN WORDS, with the size, the limit and what to do (9.3254ms)
✔ a name that may not become a file is refused, never quietly renamed (2.9121ms)
✔ a turn that changed hundreds of files shares the newest few and SAYS SO (12.1396ms)
✔ an empty file and a folder that cannot be read produce nothing, and no throw (1.178ms)
✔ the refusal sentence is one short message, never a wall of them (0.2732ms)
✔ a current private manifest attaches its note and exact typed links only to the matching file (3.9068ms)
✔ an old manifest is ignored before its contents are read (2.4698ms)
✔ bad current manifest data is refused in plain words and no part of it is guessed (2.2936ms)
✔ the private manifest read is bounded at the shared byte limit (4.6145ms)
✔ an ambiguous normalised name leaves every colliding file unannotated and says why once (2.8283ms)
✔ no manifest leaves annotations absent from the existing produced-file result (1.1938ms)
✔ bytes are read only while the produced file still has the exact swept state (3.863ms)
ℹ tests 24
ℹ suites 0
ℹ pass 24
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 2904.1415
```

Final full engine command:

```text
npm test -w @cloud9/engine
```

Exact summary:

```text
ℹ tests 599
ℹ suites 0
ℹ pass 599
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 36213.5393
```

# Engine fix round 3 — application-owned Buffer snapshots

## Root cause

The previous `ProducedFile` was a recipe for reopening a mutable path. Windows can preserve or restore the metadata that recipe checked, and a second hash only describes the bytes read the second time. Neither can prove what bytes existed when the turn's file, note and typed links were accepted.

The permanent invariant is now structural:

> Once a candidate becomes an offer, it owns the exact Buffer later encoded into `publishArtifact`. No operation after capture can reopen, restat, reread, rehash or otherwise consult the source path.

## Architecture replacement

- Scan candidates are private and may carry path plus capture-time stat identity.
- `ProducedFile` is now pathless and contains `name`, engine-owned `bytes`, byte-derived `size`, `modifiedAt`, and optional checked `note` / `links`.
- Each accepted source file is opened and read once during capture into a new Buffer. Descriptor/stat checks are capture-coherence guards only.
- The private manifest is captured once as its own bounded snapshot and parsed once.
- Manifest annotations attach only to unique normalized candidate names.
- Candidates are sorted newest first. Failed captures produce plain room-visible refusals and do not consume an offer slot; older valid candidates backfill until ten successful snapshots exist or candidates are exhausted.
- Only candidates after ten successful captures receive cap refusals.
- `Engine.publishCaptured` base64-encodes `file.bytes` directly. Its body has no filesystem/path/hash operation.
- Relay remains the durable SHA owner. No frame or wire type changed.

## API deletions and additions

Deleted:

- `ProducedFile.path`
- `ProducedFile.state`
- exported `ProducedFileState`
- exported `readProducedBytes()`
- publish-time stat/read/hash checks and the console-only changed-file skip

Added/changed:

- `ProducedFile.bytes: Buffer`
- `ProducedFile.size` is derived from `bytes.length`
- private scan candidate/state and one-time capture helpers
- `SweepOptions.maxBytes` and `SweepOptions.capture` deterministic test seams
- private `Engine.publishCaptured(...)`, which accepts an `ArtifactSweep` of held values and performs zero filesystem work

No wire/API contract outside the engine changed.

## Permanent deterministic proof

- same-size rewrite with restored mtime publishes the old captured bytes with the captured note, typed links, task ID and run ID;
- replaced and deleted paths still publish the captured values;
- source and manifest mutation after capture cannot alter a held frame;
- pathless `ProducedFile` plus source invariant blocks publish-time open/stat/read/hash architecture;
- three injected failures plus ten successes plus two extras yields exactly 10 offers, 3 capture refusals and 2 cap refusals;
- failures do not consume slots and older candidates backfill;
- exact 10 MB captures; over-limit is refused before the capture callback/full read;
- production accepted raw bytes are bounded to 100,000,000 bytes, with lower injectable limits proving the same rule cheaply;
- real chat, public relay task, scheduler and real local repository/worktree entry paths remain covered with run ID, task ID and workdir assertions.

The first new red check failed as expected: the old offer had no Buffer and still exposed a mutable path/state recipe (`15 passed, 1 failed`).

## Final focused command and exact output

Command:

```text
npm run build -w @cloud9/shared && npm run build -w @cloud9/engine && node --test packages/engine/dist/artifacts.test.js packages/engine/dist/artifact-manifest.test.js
```

Output:

```text
> @cloud9/shared@0.1.0 build
> tsc -p tsconfig.json

> @cloud9/engine@0.1.0 build
> tsc -p tsconfig.json

✔ publishArtifact carries the matching note and exact-version typed links, not the manifest (31.096ms)
✔ captured frames survive rewrite, replacement, deletion and manifest mutation (7.5605ms)
✔ the source has one provider doorway and one produced-file funnel (1.6095ms)
▶ real chat, task, schedule and repository entries each reach one run-linked publish
  ✔ chat entry (15.4407ms)
  ✔ delegated task through the public relay connection (66.8596ms)
  ✔ scheduled tick (17.6144ms)
[git] prepared cloud9/a1-msbnln4l for agent a1
  ✔ repository worktree entry (1483.8375ms)
✔ real chat, task, schedule and repository entries each reach one run-linked publish (1585.022ms)
✔ markdown that mentions file relationships never becomes typed link data (9.896ms)
✔ a malformed current manifest produces a plain refusal but the file still publishes unannotated (10.4652ms)
✔ a file the turn wrote is offered; one that was already there is not (4.4267ms)
✔ the engine's own bookkeeping and a checkout's litter are never shared (7.2024ms)
✔ a file still being written is invisible, so nothing is ever shared half-made (1.2319ms)
✔ too big is REFUSED IN WORDS, with the size, the limit and what to do (9.6098ms)
✔ a name that may not become a file is refused, never quietly renamed (2.3719ms)
✔ a turn that changed hundreds of files shares the newest few and SAYS SO (9.9972ms)
✔ an empty file and a folder that cannot be read produce nothing, and no throw (1.292ms)
✔ the refusal sentence is one short message, never a wall of them (0.2986ms)
✔ a current private manifest attaches its note and exact typed links only to the matching file (3.3106ms)
✔ an old manifest is ignored before its contents are read (1.85ms)
✔ bad current manifest data is refused in plain words and no part of it is guessed (2.1973ms)
✔ the private manifest read is bounded at the shared byte limit (4.4237ms)
✔ an ambiguous normalised name leaves every colliding file unannotated and says why once (2.9228ms)
✔ no manifest leaves annotations absent from the existing produced-file result (1.2596ms)
✔ an offer is a pathless captured value whose bytes survive source mutation (1.1977ms)
✔ three failed captures backfill to ten successes and leave two true cap extras (11.1875ms)
✔ exact 10 MB is captured, over-limit is refused before capture, and accepted bytes are bounded (23.9047ms)
ℹ tests 27
ℹ suites 0
ℹ pass 27
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1828.0943
```

## Final full engine command and exact summary

Command:

```text
npm test -w @cloud9/engine
```

Summary:

```text
ℹ tests 602
ℹ suites 0
ℹ pass 602
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 33326.189
```

## Round 3 concerns

- No engine blocker remains.
- The required raw snapshot budget is strictly bounded to 100,000,000 accepted bytes per turn. Base64/JSON/WebSocket encoding has additional temporary memory overhead, but no mutable source path is retained or consulted after capture.

# Engine fix round 4 — bounded capture work

## Status

READY FOR INTEGRATION. No commit was made.

## Design choice

- Added the engine-owned named constant `CAPTURE_WORK_LIMIT_BYTES = ARTIFACT_LIMITS.bytes * 20`.
- Production capture work is therefore capped at 200,000,000 source bytes attempted per turn, separate from both the 10-file product cap and the existing 100,000,000-byte retained snapshot bound.
- A candidate's full stat-declared size is charged before its capture begins. Early failures still consume that conservative reservation; a candidate that would cross the remaining budget is not read.
- Twenty maximum-sized attempts allow ten successful 10 MB snapshots plus ten maximum-sized failed backfill attempts, while replacing the prior approximately 50 GB worst case with a finite 200 MB ceiling.
- Capture failures before the ceiling still backfill older candidates. If ten captures succeed, every later candidate receives only the existing “only the newest 10” refusal.
- If fewer than ten captures succeed and another candidate cannot fit inside the remaining work budget, it receives the distinct plain `capture safety limit` refusal, never the ten-file-cap refusal. One safety refusal is kept in the three-line room summary even when earlier read failures would otherwise hide it.
- The approved pathless `ProducedFile.bytes` snapshot architecture is unchanged. Publish still encodes the held Buffer and performs zero filesystem work.

## Deterministic round-4 checks

- Three 4-byte late failures spend an injected 12-byte work budget exactly; no fourth capture callback runs, and the two untouched candidates receive the capture-safety refusal.
- Three failed captures followed by ten successes spend an injected 13-byte budget exactly, reach ten offers through backfill, and leave the final two candidates as true ten-file-cap extras.
- The capture-safety reason remains visible in the room summary after earlier capture failures.
- The permanent 100 MB retained snapshot assertion and publish-time zero-filesystem source invariant remain green.

## Red proof

The new boundary test was run before implementation and failed at compile time because `CAPTURE_WORK_LIMIT_BYTES` and `SweepOptions.captureWorkBytes` did not exist. After the first implementation, the strengthened room-summary check failed because the safety reason was hidden behind the first three capture failures. After making it visible, the mixed-summary honesty check failed because the final line incorrectly said all hidden refusals had the same reason. Each failure was then fixed before the final runs.

## Final focused command and exact output

Command:

```text
npm run build -w @cloud9/shared && npm run build -w @cloud9/engine && node --test packages/engine/dist/artifacts.test.js packages/engine/dist/artifact-manifest.test.js
```

Output:

```text
> @cloud9/shared@0.1.0 build
> tsc -p tsconfig.json

> @cloud9/engine@0.1.0 build
> tsc -p tsconfig.json

✔ publishArtifact carries the matching note and exact-version typed links, not the manifest (46.6189ms)
✔ captured frames survive rewrite, replacement, deletion and manifest mutation (7.3472ms)
✔ the source has one provider doorway and one produced-file funnel (1.4665ms)
▶ real chat, task, schedule and repository entries each reach one run-linked publish
  ✔ chat entry (14.759ms)
  ✔ delegated task through the public relay connection (86.931ms)
  ✔ scheduled tick (13.2486ms)
[git] prepared cloud9/a1-msbohtff for agent a1
  ✔ repository worktree entry (1564.1576ms)
✔ real chat, task, schedule and repository entries each reach one run-linked publish (1680.6057ms)
✔ markdown that mentions file relationships never becomes typed link data (13.1363ms)
✔ a malformed current manifest produces a plain refusal but the file still publishes unannotated (11.5862ms)
✔ a file the turn wrote is offered; one that was already there is not (18.0092ms)
✔ the engine's own bookkeeping and a checkout's litter are never shared (19.4303ms)
✔ a file still being written is invisible, so nothing is ever shared half-made (0.9244ms)
✔ too big is REFUSED IN WORDS, with the size, the limit and what to do (10.8184ms)
✔ a name that may not become a file is refused, never quietly renamed (4.3715ms)
✔ a turn that changed hundreds of files shares the newest few and SAYS SO (20.6725ms)
✔ an empty file and a folder that cannot be read produce nothing, and no throw (1.8277ms)
✔ the refusal sentence is one short message, never a wall of them (0.4084ms)
✔ a current private manifest attaches its note and exact typed links only to the matching file (4.2978ms)
✔ an old manifest is ignored before its contents are read (3.5062ms)
✔ bad current manifest data is refused in plain words and no part of it is guessed (4.1583ms)
✔ the private manifest read is bounded at the shared byte limit (6.879ms)
✔ an ambiguous normalised name leaves every colliding file unannotated and says why once (4.9134ms)
✔ no manifest leaves annotations absent from the existing produced-file result (1.9825ms)
✔ an offer is a pathless captured value whose bytes survive source mutation (2.1963ms)
✔ three failed captures backfill to ten successes within budget and leave true cap extras (10.291ms)
✔ capture work stops at the exact byte boundary and labels the untouched remainder safely (5.8159ms)
✔ exact 10 MB is captured, over-limit is refused before capture, and accepted bytes are bounded (19.5301ms)
ℹ tests 28
ℹ suites 0
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1998.9913
```

## Final full engine command and exact summary

Command:

```text
npm test -w @cloud9/engine > /tmp/cloud9-engine-round4-final.log 2>&1
```

Exact summary from that output:

```text
ℹ tests 603
ℹ suites 0
ℹ pass 603
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 32990.5127
```

## Round 4 concerns

- No feature blocker remains.
- The byte ceiling deliberately does not add a second attempt-count cap: maximum-size failures stop after 20 attempts, while very small files can still use the existing 5,000-candidate scan ceiling without recreating the large synchronous-read risk.
- One earlier ordinary full-suite invocation returned exit 1, but its failure detail was lost in truncated tool output. It did not reproduce: the immediate concise full rerun passed, and two subsequent captured full runs each passed 603/603. The final evidence above is the last run.
