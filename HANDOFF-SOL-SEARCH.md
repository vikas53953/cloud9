# Fresh-session handoff — Feature 3: Search everywhere

**Use this handoff only in the next fresh session.**

- Current source branch observed while preparing this handoff: `sol/shared-artifacts`.
- Recommended feature branch: `sol/search-everywhere`.
- Mission state: preparation only; Feature 3 has not started.
- This file is a scouting handoff, not an approved technical design.
- **Every technical mapping below is a scout note to verify in the fresh session before planning or editing.**
- Do not resume Feature 2 unless Vikas has supplied the requested GitHub round-1 feedback. If that feedback is still absent, explicitly record **Feature 2 skipped pending Vikas feedback** and continue with Feature 3.
- **Feature 3 precedence:** the fresh-session reading model, approval gates, durable scout-report rules, staged ownership lanes, `sol/search-everywhere` branch, and hourly checkpoint pushes in this file override conflicting Feature 3 execution/default/scouting/branch wording in both `HANDOFF-SOL.md` and `PIPELINE.md`. This precedence applies to Feature 3 only. All non-conflicting standing safety, assumption, evidence, QA, review-page, reporting, clean-tree, and installed-build laws in those files remain in force.

## 1. Mission in plain words

Give Vikas one search experience that can find what he can already read across Cloud9:

- normal chat messages;
- thread replies;
- artifact names;
- words inside readable text artifacts;
- older and newest retained artifact versions.

The same search must support room, agent, date, and result-kind filters. A result must identify what matched, its room and source, and the exact message, reply, artifact, or retained artifact version it can open.

**Non-negotiable search rule:** extend the relay's existing SQLite FTS search and fallback behavior. Do not build, add, or silently maintain a second search engine.

## 2. Start safely

1. Confirm the repository is `C:\Users\vikasmit\cloud9` and inspect `git status --short --branch`.
2. Do not branch from a dirty or uncertain tree. The preparation session observed unrelated modified and untracked Feature 1/QA files on `sol/shared-artifacts`; identify their owner and preserve them before creating the feature branch.
3. Verify the intended base is the exact committed state that contains the accepted Shared Artifacts work. Do not assume `master` is that state.
4. Create/switch to `sol/search-everywhere` only after the base is clean and verified.
5. Record the starting commit in the implementation ledger before code begins.
6. Do not edit `SOL-REPORT.md` merely to announce a start. Update it only when there is evidence-backed status to report.

## 3. Exact cold-start reading order — agents do all file reading

The conductor keeps its own context lean. It may inspect Git state, coordinate, decide, run verification, and issue implementation tasks, but it delegates **all Grep and Read work** to agents.

Every reading agent must:

1. write its full findings, checked excerpts, contradictions, assumptions, and verified `file:line` pointers to its assigned durable report file under `.superpowers/sdd/HANDOFF-SOL/`;
2. edit no product source, QA script, report page, `SOL-REPORT.md`, or other file;
3. return to the conductor only a verdict plus exact line pointers into its durable report file;
4. never paste the full report into conductor context.

The predetermined report paths make the work resume-proof even if controller context is reset.

### Wave 1 — launch these read/write-report-only scouts in parallel

**Agent A — operating rules and queue**

Read in this exact order:

1. `HANDOFF.md`
2. `RESUME.md`
3. `implementation-notes.md`
4. `HANDOFF-SOL.md`, concentrating on assumptions, evidence, QA, Feature 3 queue, commit/push, stop, and reporting rules
5. `PIPELINE.md`, concentrating on the current Feature 3 stage
6. `SOL-REPORT.md`, structure and current statuses only
7. `package.json`, scripts only

Write the full result to:

- `.superpowers/sdd/HANDOFF-SOL/search-scout-a-rules.md`

The report must preserve the rules constraining the feature, the exact evidence chain, report fields, branch/base facts, and contradictions. Return only `VERDICT` plus the decisive report-file line pointers.

**Agent B — shared contracts and engine compatibility**

Use targeted Grep and small excerpts in:

1. `packages/shared/src/index.ts`
2. `packages/engine/src/cloud9tools.ts`
3. `packages/engine/src/engine.ts`
4. their directly related search tests

Write the full result to:

- `.superpowers/sdd/HANDOFF-SOL/search-scout-b-contracts.md`

The report must preserve existing request/result contracts, limits, message/thread/artifact fields, and compatibility risks for the room-bound agent search. It must not approve a final wire design. Return only `VERDICT` plus the decisive report-file line pointers.

**Agent C — relay FTS, artifact persistence, and authorization**

Use targeted Grep and small excerpts in:

1. `apps/relay/src/store.ts`
2. `apps/relay/src/server.ts`
3. relay search, coverage, hardening, chat, authorization, artifact-retention, and agent-search tests

Write the full result to:

- `.superpowers/sdd/HANDOFF-SOL/search-scout-c-relay.md`

The report must preserve the FTS lifecycle, message indexing, artifact identity/version writes, version-pruning path, asymmetric artifact-link retention, byte-storage boundary, query/fallback path, visible-room authorization, current filters, and test seams. It must verify the current rule from source and tests: links owned by a pruned source version are deleted, while a retained source's exact-version link to a pruned target remains pinned but unavailable and never slides to a newer target. Return only `VERDICT` plus the decisive report-file line pointers.

**Agent D — desktop search and Files surfaces**

Use targeted Grep and small excerpts in:

1. `apps/desktop/src/store.ts`
2. `apps/desktop/src/App.tsx`
3. `apps/desktop/src/styles.css`
4. `apps/desktop/electron/main.cjs`
5. `apps/desktop/electron/preload.cjs`

Write the full result to:

- `.superpowers/sdd/HANDOFF-SOL/search-scout-d-desktop.md`

The report must preserve current global-search state, parsing, result navigation, thread jump behavior, Files behavior, menu/keyboard entry points, and UI ownership boundaries. It must treat overlay, expanded overlay, dedicated view, or another presentation as an open product choice. Return only `VERDICT` plus the decisive report-file line pointers.

**Agent E — permanent QA and installed walk**

Read only the relevant sections of:

1. `scripts/qa.mjs`
2. `scripts/drive-app.mjs`
3. `scripts/qa-stack.mjs`
4. current permanent QA logs and report-page conventions referenced by the handoffs

Write the full result to:

- `.superpowers/sdd/HANDOFF-SOL/search-scout-e-qa.md`

The report must preserve existing check-count baselines, reliable selectors/hooks, stale-install safeguards, deliberate-red-check pattern, log locations, and the installed-app route to exercise. Return only `VERDICT` plus the decisive report-file line pointers.

### Wave 2 — durable verification and synthesis

1. Launch one verification agent to read all five scout reports and recheck only decisive source pointers against the current feature-branch commit.
2. That agent writes `.superpowers/sdd/HANDOFF-SOL/search-scout-verified.md` and returns only `VERDICT` plus decisive report-file line pointers.
3. Launch a planning agent to read the six durable reports, separate confirmed truths from open decisions/experiments, and write `.superpowers/sdd/HANDOFF-SOL/search-brief.md` using **BROKEN / CAUSE / CHANGE / NEIGHBORS / BLINDSPOTS**.
4. The planning agent states every assumption as `assuming X — correct me`, labels every technical mapping **scout note to verify**, and returns only `VERDICT` plus decisive report-file line pointers.
5. Ask Vikas one approval question, with a recommendation, before implementation starts.
6. For follow-up reading, resume the same named agent and update the same durable report rather than launching a new broad scout.

## 4. Known existing relay FTS entry points

Everything in this section is a **scout note to verify in the fresh session, not approved design**.

### Existing storage and index lifecycle

- `apps/relay/src/store.ts:279` — durable `messages` table.
- `apps/relay/src/store.ts:441` — store startup calls search initialization.
- `apps/relay/src/store.ts:498` — SQLite FTS5 section and tokenizer notes.
- `apps/relay/src/store.ts:514` — `initSearch()` entry.
- `apps/relay/src/store.ts:517` — existing `messages_fts` table: message text plus unindexed message and room IDs.
- `apps/relay/src/store.ts:528` — successful FTS startup begins backfill.
- `apps/relay/src/store.ts:546` — `backfillSearch()` completeness/rebuild path.
- `apps/relay/src/store.ts:565` — exposed index-completeness check.
- `apps/relay/src/store.ts:575` — `indexMessage()` replaces one message's FTS row.
- `apps/relay/src/store.ts:579` — current indexed payload is `Message.text`, message ID, and room ID.
- `apps/relay/src/store.ts:1249` — common `saveMessage()` write path.
- `apps/relay/src/store.ts:1253` — saved messages are immediately passed to `indexMessage()`.

### Existing query path

- `apps/relay/src/store.ts:1332` — `Store.search(channels, query, opts)` storage entry.
- `apps/relay/src/store.ts:1335` — current options expose author and page limit; rooms arrive as authorized channel scope.
- `apps/relay/src/store.ts:1353` — author filtering in SQL.
- `apps/relay/src/store.ts:1355` — tombstone exclusion before page limit.
- `apps/relay/src/store.ts:1361` — FTS query and marked snippets.
- `apps/relay/src/store.ts:1366` — non-FTS fallback path.
- `apps/relay/src/store.ts:1386` — one-extra-row pagination for `hasMore`.
- `apps/relay/src/store.ts:2709` — search-term normalization boundary.
- `apps/relay/src/store.ts:2712` — shared maximum query length is applied.
- `apps/relay/src/store.ts:2715` — at most ten normalized terms enter the query.

### Existing relay wire and authorization

- `packages/shared/src/index.ts:1807` — current search request fields: query, optional room, optional author, and limit.
- `packages/shared/src/index.ts:1728` — current message-shaped `SearchHit`.
- `packages/shared/src/index.ts:2257` — current search-results frame.
- `apps/relay/src/server.ts:2286` — WebSocket `search` handler.
- `apps/relay/src/server.ts:2290` — default scope is all rooms visible to the caller.
- `apps/relay/src/server.ts:2291` — a requested room can narrow, not widen, scope.
- `apps/relay/src/server.ts:2294` — handler calls `Store.search()`.
- `apps/relay/src/server.ts:2306` — relay sends the search-results frame.

### Existing thread behavior

- `packages/shared/src/index.ts:1705` — thread replies use `Message.replyTo`.
- `apps/relay/src/store.ts:1394` — thread reads query the same messages store.
- `apps/desktop/src/App.tsx:3048` — a global-search target can be forced visible when it is a reply.
- `apps/desktop/src/App.tsx:3174` — bounded paged jump to a message target.

**Scout note to verify:** all non-deleted message text appears to pass through `indexMessage()` without excluding replies, so thread words may already be indexed. The current result contract does not explicitly label root-message versus thread-reply hits.

### Existing artifact storage and retention boundary

- `apps/relay/src/store.ts:340` — artifact identity table.
- `apps/relay/src/store.ts:353` — immutable artifact-version rows and metadata JSON.
- `apps/relay/src/store.ts:1621` — artifact bytes are staged outside SQLite.
- `apps/relay/src/store.ts:1920` — `appendArtifactVersion()` persistence entry.
- `apps/relay/src/store.ts:1986` — staged bytes are promoted to their final file.
- `apps/relay/src/store.ts:1990` — immutable version metadata is inserted.
- `apps/relay/src/store.ts:2023` — direct artifact-version metadata write.
- `apps/relay/src/store.ts:2037-2050` — pruning removes doomed version bytes, deletes links whose source is that doomed version, and deletes its version row.
- `apps/relay/src/artifactstore.test.ts:798-815` — a retained source's exact-version link to a pruned target remains pinned and becomes unavailable; it does not slide to the newest retained target.
- `apps/relay/src/server.ts:2498` — publish path stages artifact bytes.
- `apps/relay/src/server.ts:2503` — relay classifies text versus non-text bytes.
- `apps/relay/src/server.ts:2512` — publish path appends the version.
- `apps/relay/src/server.ts:2516` — publish flow reaches retained-version pruning; verify exact lifecycle.

**Scout note to verify:** no artifact FTS table or artifact-search query was found. Artifact names and metadata live in SQLite, while version bytes live on disk. Existing retention is asymmetric: pruning deletes the doomed version's bytes, row, and links it owns as a source; an incoming exact-version link owned by a retained source remains pinned but resolves unavailable. Content indexing and cleanup must extend the same FTS lifecycle around this durability boundary without creating a second engine, stale search hits, unauthorized snippets, or altered link semantics.

### Existing desktop surfaces

- `apps/desktop/src/store.ts:1013` — current desktop `search()` entry.
- `apps/desktop/src/store.ts:1029` — sends the current search frame.
- `apps/desktop/src/App.tsx:7544` — existing cross-room `SearchOverlay`.
- `apps/desktop/src/App.tsx:7567` — current `in:<room>` parser.
- `apps/desktop/src/App.tsx:7573` — current `from:<name>` parser.
- `apps/desktop/src/App.tsx:7592` — results grouped by conversation.
- `apps/desktop/src/App.tsx:9043` — existing cross-room `FilesScreen`.
- `apps/desktop/src/App.tsx:9137` — artifact rows already show result metadata.
- `apps/desktop/src/App.tsx:9201` — selected artifact detail/version surface.

**Scout note to verify:** Search and Files are existing surfaces inside the same large desktop component. Keep their implementation in one UI ownership lane. The final UI form remains an approval choice.

## 5. Non-overlapping ownership lanes with staged execution

These are **scout lanes to verify before approval**, not an approved implementation split. File ownership does not overlap, but dependent coding is staged. The conductor owns integration and is the only committer.

### Stage 0 — independent parallel preparation

Run in parallel:

- the five scouts in Section 3;
- QA fixture/test-case drafting that edits no permanent QA script;
- product-choice preparation using the confirmed/open split in Section 6.

Do not begin contract-dependent product code during this stage.

### Stage 1 — product decisions and technical experiment gates

Resolve the open choices in Section 6 with one recommendation and one approval question at a time. Run the listed small experiments where evidence is needed. Record decisions in `.superpowers/sdd/HANDOFF-SOL/search-brief.md` before contract work.

### Stage 2 — Lane A: shared contract/index exports

Own only:

- `packages/shared/src/index.ts`
- directly related shared contract tests, if present
- compatibility notes for `packages/engine`, but no engine edits unless the conductor explicitly reassigns them

Purpose: define one backward-safe request/result/filter contract after the product decisions are recorded. Prove the existing conversation-bound engine consumer remains safe.

Must not edit relay, desktop, or QA files. Complete this stage before dependent lanes implement against the contract.

### Stage 3 — dependent lanes may run in parallel after Lane A is fixed

**Lane B — relay query and indexing**

Own only:

- `apps/relay/src/store.ts`
- `apps/relay/src/server.ts`
- relay search/index/authorization/retention tests

Purpose: extend the same FTS lifecycle for authorized chat, reply, artifact-name, artifact-content, and retained artifact-version results; apply approved filters before pagination; preserve fallback behavior; keep live writes, pruning, backfill, and recovery correct.

Must not edit shared, desktop, or permanent-QA files.

**Lane C — desktop search surface and filter UI**

Own only:

- `apps/desktop/src/store.ts`
- `apps/desktop/src/App.tsx`
- `apps/desktop/src/styles.css`
- Electron menu/preload files only if the approved interaction requires them
- directly related desktop tests

Purpose: implement the approved search surface, visible room/agent/date/kind controls, approved result labels, deterministic empty/loading/error states, and exact navigation for each result target.

Must not edit shared, relay, or permanent-QA files.

During Stage 3, Lane D may prepare fixture data and expected assertions in its durable report, but it must not wire final selectors or permanent checks against unsettled behavior.

### Stage 4 — conductor integration

1. Integrate Lane A, Lane B, and Lane C.
2. Resolve contract or behavior mismatches centrally; do not let lanes edit one another's files.
3. Run focused tests personally.
4. Freeze stable selectors and observable result behavior for permanent QA.

### Stage 5 — Lane D: permanent QA and installed walk

Own only:

- `scripts/qa.mjs`
- `scripts/drive-app.mjs`
- feature-specific evidence logs/screenshots
- the visual HTML report page and its inlined feedback layer

Purpose: add permanent repository checks and the real packaged-app walk after integrated behavior is stable. Build both green and deliberate-red proof without weakening previous check counts.

Must not edit product source, shared contracts, or relay tests.

## 6. Confirmed acceptance truths, open product decisions, and technical experiments

### 6A. Confirmed acceptance truths — each must have deterministic pass/fail proof

These are required observable outcomes. They do not choose wire shapes, labels, ranking, grouping, or desktop presentation.

#### Executable fixture limits and set rules

- Until a continuation contract is approved, every test that claims complete FTS/fallback set equality uses at most `N = 12` expected authorized targets, sends `limit = N + 1` (never above the shared cap), asserts `hasMore === false`, sorts stable target IDs, and compares exact sets. Ranking/order is not part of that equality assertion.
- A test with more than `N = 12` expected authorized targets may assert only first-window size, membership in the known authorized universe, uniqueness, and `hasMore`; it must not claim complete-set absence or FTS/fallback equality without the approved traversal contract.
- No QA loop may invent page traversal from repeated identical requests. Complete-set inspection above the bounded fixture cap waits for the pagination/cursor decision in Section 6B.

#### Scope and authorization

- Bounded full-set fixture: seed `N = 12` authorized and `N = 12` unauthorized targets with the same unique token. Send `limit = 13`. The response contains exactly the 12 sorted authorized target IDs, contains no unauthorized ID/name/snippet/content token, and has `hasMore === false`.
- Limit-before-authorization sentinel fixture: seed exactly five authorized targets `A1..A5` and twenty unauthorized matches with the same token; designate `A5` as the authorized sentinel. Send `limit = 5`. The response contains exactly `{A1,A2,A3,A4,A5}`, includes sentinel `A5`, contains no unauthorized field value, and has `hasMore === false`. Unauthorized rows therefore cannot consume the result limit.
- Authorized-over-limit fixture: seed six authorized matches and no unauthorized matches; send `limit = 5`. The response has five unique IDs drawn only from the six known authorized IDs and `hasMore === true`. Do not assert which five until ordering is approved.
- Repeat the bounded and sentinel fixtures with artifact/version targets. No result payload field contains an unauthorized artifact ID, version ID, name, snippet, or content token.
- Narrowing by any approved filter never adds a target ID that was absent from the same user's bounded unfiltered authorized result set.

#### Chat

- Seed a root message with a unique token. The all-authorized-room query returns that exact message ID.
- Open that result from the packaged app. The correct room opens and the exact message ID receives the existing visible jump/highlight state, including when older pages must load.
- Edit the message from unique token A to unique token B. A returns zero hits for that message ID; B returns the message ID in both FTS and forced-fallback test modes.
- Interrupted-edit fixture: enable a test-only failpoint after the edited message row containing token B is durably saved but before the existing FTS row for token A is replaced; terminate the relay at that point. After restart/recovery in FTS mode, querying A returns zero hits and querying B returns exactly the edited message ID. Leave the repair mechanism open, but the stale equal-row-count index must not pass.
- Tombstone the message. Its message ID returns zero hits in both FTS and forced-fallback test modes before and after relay restart.

#### Threads

- Seed a unique token only in a reply, not its root. The query returns the exact reply message ID.
- Open that result from the packaged app. The correct room opens and the exact reply ID is visible with its parent/thread context.
- A root and reply with different unique tokens each return only their own exact message ID, proving targets are not confused.

#### Artifact names and contents

- Seed an authorized artifact whose unique name token does not occur in content. The query returns at least one result tied to that artifact ID; identity-versus-version multiplicity remains an approval decision below.
- Seed a retained text version whose unique content token does not occur in its artifact name or metadata. The query returns a target carrying that exact artifact ID and matching version ID/number.
- Open the retained-version content result from the packaged app. The selected artifact and exact matching version are visible; the app does not silently substitute the newest version.
- Seed non-previewable/binary bytes containing an ASCII token that does not appear in metadata. Searching that token returns zero content hits for that version.
- Capture logs during indexing and search. Assert that unique artifact content tokens and secret fixture values do not appear in logs.

#### Artifact version lifecycle and pruning

- Publish a new retained text version with a unique token. Without restarting the relay, the query returns its exact artifact/version target.
- Seed a unique token in an older version that remains within the retention limit. Before and after relay restart/backfill, the query returns the same exact retained version target.
- Unpinned-prune fixture: publish enough versions to prune an older unpinned version containing a unique token. Assert its version row and stored bytes are gone, its search document is gone, and querying its version ID/token returns zero hits.
- Pruned-source-link fixture: give the doomed version an outgoing artifact link before pruning it. After pruning, assert every link whose `sourceArtifactId/sourceVersion` is that doomed source is deleted.
- Pinned-incoming-link fixture: from a retained source version, create an exact-version link to target version 1; then publish enough target versions to prune target version 1. Assert the target version row, bytes, and search document are gone, but the retained source's link record remains pinned to exact target version 1, resolves hidden/unavailable, and does not slide to the newest retained target version.
- Restart or rebuild the search index after all three pruning fixtures. Every pruned token returns zero hits; unique tokens in every currently retained version still return their exact targets; the asymmetric link assertions remain unchanged.
- Interrupt the index update/prune path at each approved failure seam. Recovery either completes storage/index cleanup to the current retained set or rebuilds to it; no stale search result points to missing content, no link owned by a deleted source remains, and no retained incoming exact-version link is silently deleted or retargeted.

#### Filters

- **Room:** with the same token in two authorized rooms, filtering by each stable room ID returns only target IDs from that room; unfiltered search returns both.
- **Agent:** with the same token produced by two distinct stable author/producer IDs, filtering by each ID returns only that identity's targets.
- **Date:** after the date contract is approved below, fixtures immediately inside and outside every boundary produce the recorded expected IDs in both FTS and fallback modes.
- **Kind:** after the kind vocabulary is approved below, one fixture per approved kind proves each filter returns only target IDs of that kind.
- Filter-before-limit sentinel fixture: seed exactly five authorized targets matching the approved filter, including sentinel `F5`, plus twenty authorized same-token decoys that fail the filter. Send `limit = 5`. The response contains exactly the five matching IDs including `F5`, contains no decoy ID, and has `hasMore === false`.
- Combining room, agent, date, and kind filters in a bounded fixture of at most 12 expected targets returns the exact sorted intersection with `limit = expectedCount + 1` and `hasMore === false`.
- A syntactically invalid or unresolved filter never broadens the query. It returns the single approved deterministic error/empty outcome and no unrelated target IDs.
- For every FTS/fallback parity fixture, keep the expected authorized set at or below 12, request `limit = expectedCount + 1`, require `hasMore === false` in both modes, sort stable target IDs, and assert exact set equality. Ranking may differ only if the approved ordering contract allows it.
- Conditional continuation fixture: only after the continuation and result-multiplicity contract is approved, set `limit = 10` and seed exactly 42 authorized result targets—14 messages, 14 artifacts, and 14 artifact-version matches. Also seed exactly 21 unauthorized matches: seven messages in unreadable rooms, seven restricted artifacts in otherwise visible rooms, and seven restricted artifact-version matches in otherwise visible rooms. Give every unauthorized target its own unique leak token in searchable text/name/content plus a unique ID/version ID, while also including the fixture's common query term so it would match without authorization filtering. Traverse from the first request to terminal completion, following only each returned continuation cursor, with a hard stop at 100 results or 20 pages. Assert pages 1-4 each contain exactly ten authorized targets with `hasMore === true` and one non-empty cursor different from every prior cursor; page 5 contains the final two authorized targets with `hasMore === false` and no continuation cursor. On every page and across every response field, assert zero unauthorized message IDs, artifact IDs, version IDs, artifact names, snippets, content, or unique leak tokens; reject missing/repeated cursors, repeated target IDs, skipped expected IDs, extra pages, premature terminal state, or cap exhaustion. The final sorted union must equal the exact 42-ID authorized set. Run three separately named executions against the identical stored fixture: `normal-selected-path`, `forced-fts`, and `forced-fallback`. Each execution must independently satisfy all five-page authorization, cursor, uniqueness, and completion assertions and produce the identical exact 42-ID authorized final set; if the approved contract requires cross-engine stable ordering, also require identical 42-ID ordered sequences across all three executions, otherwise require identical sorted sets.

#### Reliability and compatibility

- Existing room-chat search regression fixtures retain their previous expected message IDs.
- Existing conversation-bound agent search returns only targets from its bound room even when the relay has cross-room/artifact results available.
- FTS unavailable, interrupted backfill, interrupted message edit before FTS replacement, edits, tombstones, version publish, asymmetric version-prune links, restart, bounded result windows, and any approved mixed message/artifact/version continuation with per-page authorization each have permanent focused tests.
- Repository QA and installed-app QA check counts never fall below the pre-feature baselines recorded by Agent E.

### 6B. Open product decisions — approve before contract implementation

Do not present these as settled acceptance truth. The planning agent must give one recommendation, consequences, and one approval question at a time.

1. **Search surface form:** keep and expand the current overlay, use a dedicated view, or use another presentation. Recommended default for the approval brief: expand the existing cross-room overlay first because it preserves the known entry point and avoids choosing a new navigation model without evidence.
2. **Artifact-name multiplicity:** one artifact-identity result, one result per retained version, or grouped identity with version matches. This controls deduplication, pagination, labels, and navigation.
3. **Version-content grouping:** separate hits per matching retained version versus grouped artifact rows that expose all matching versions.
4. **Date meaning:** timestamp field per result kind, inclusive/exclusive boundaries, local versus UTC display/input, and whether one or two date controls are exposed.
5. **Kind vocabulary:** exact user-visible and wire-level categories; chat versus thread and artifact name/content/version distinctions must be decided without assuming identical UI and wire names.
6. **Ordering/ranking:** cross-kind ordering, tie-breakers, fallback expectations, and whether grouped results alter ranking.
7. **Snippet contract:** maximum length, match marking, redaction, binary behavior, and what is displayed for a name-only match.
8. **Invalid/ambiguous filter behavior:** deterministic error, no-results state, or guided resolution; matching display names must not silently select an identity.
9. **Empty-query filters:** whether filters may browse without text or require a text query.
10. **Text-content eligibility:** approved content types, size cap, encoding handling, and treatment of malformed text.
11. **Pagination/traversal:** the current contract has `limit` and `hasMore` but no continuation cursor. Decide whether Feature 3 is intentionally a bounded first window or adds stable continuation. If continuation is approved, the contract must define cursor presence on every non-terminal page, terminal cursor absence, behavior under concurrent writes, duplicate/skip prevention, and whether `normal-selected-path`, `forced-fts`, and `forced-fallback` must produce identical ordered sequences or only identical complete target sets. Recommended default if users must inspect beyond one window: approve an opaque stable cursor with duplicate-free deterministic termination, zero per-page authorization leaks, and exact 42-target set parity across all three named executions; until then, only the bounded full-set rules in Section 6A may support complete-set claims.

### 6C. Technical experiments — evidence before architecture approval

Each experiment writes commands, fixtures, real results, and source pointers to `.superpowers/sdd/HANDOFF-SOL/search-brief.md`. Findings remain **scout notes to verify** until approved.

1. Prove whether extending the existing FTS table or using another FTS virtual table inside the same relay-owned SQLite search lifecycle best preserves one-engine behavior. A second service/library/search authority is forbidden.
2. Measure indexing and query behavior for the proposed text-size cap using representative artifact versions.
3. Kill the relay after an edited message row is saved but before its FTS row is replaced; verify the interrupted-edit acceptance fixture after restart without preselecting the repair mechanism.
4. Kill the relay between artifact byte promotion, metadata commit, index update, and prune cleanup to identify recoverable failure seams, including both sides of the asymmetric link rule.
5. Force FTS unavailable and compare exact bounded target-ID/filter sets with fallback behavior under the caps in Section 6A.
6. Exercise the existing conversation-bound engine consumer against candidate richer result contracts to prove backward compatibility.
7. If continuation is proposed, run the exact Section 6A fixture—42 authorized targets plus seven unauthorized messages, seven restricted artifacts, and seven restricted artifact versions—at `limit = 10` as three separately recorded executions: `normal-selected-path`, `forced-fts`, and `forced-fallback`. Preserve every page, cursor, response field, and unique unauthorized leak token; prove five-page deterministic completion, no repeated/missing cursors, zero unauthorized IDs/names/content/snippets/tokens on every page, no duplicate/skipped authorized target, final union equal to the exact 42-ID authorized set, and ordered-sequence or unordered-set parity across all three executions exactly as the approved contract states.
8. Prototype the minimum current-overlay extension and, only if needed, one alternate UI form using fixture data before wiring; compare navigation, filter clarity, and result density in the approval page.

## 7. Context economy and hourly push rules

- Agents do all file reading and preserve full results in the named durable report files. The conductor receives only verdicts and report-file line pointers.
- Resume the same named agent for follow-up reading and update the same durable report instead of launching a new broad scout.
- Keep one living implementation ledger in the existing project convention; link every scout report and record decisions, assumptions, lane ownership, tests run, and unresolved risks.
- At or before 50% context remaining, stop implementation, reconcile durable reports and Git state through an agent, write a resume checkpoint, and continue only after the state is recoverable.
- At least once per hour during active implementation, and before any context reset or long pause:
  1. reconcile the working tree against lane ownership;
  2. run the smallest relevant fresh check;
  3. record the real result and open issue in the ledger;
  4. have the conductor create a coherent checkpoint commit on `sol/search-everywhere` if there is meaningful validated work;
  5. push that feature branch to origin.
- Workers never commit or push.
- Never push knowingly broken code as proven. If interruption forces an incomplete checkpoint, label it `UNVERIFIED` in the commit/ledger/reporting and state the failing or missing evidence.
- Never rewrite, force-push, or use the current dirty `sol/shared-artifacts` tree as an implicit backup.

## 8. Evidence chain

The conductor—not workers—must personally run and preserve fresh proof from the integrated feature branch:

1. Focused shared/relay/desktop tests for the approved contract and every confirmed acceptance truth.
2. Permanent green checks added to both `scripts/qa.mjs` and `scripts/drive-app.mjs`.
3. Deliberately break one new permanent check, run it, and preserve proof that it fails for the intended reason; restore it and rerun green.
4. `npm run build`
5. `npm test`
6. `npm run qa`
7. `npm run dist`
8. Silently install the newly built `release\Cloud9-Setup-0.1.0.exe /S`.
9. Confirm the installed app is the new build, not a stale prior install.
10. `npm run qa:app`
11. Perform the installed-app walk for every approved user-visible truth: chat, thread-only text, artifact name, artifact content, retained older version, pruned version absence, room, agent, date, kind, combined filters, no-access scope, fallback/restart, and exact navigation. If continuation is approved, preserve the separately named `normal-selected-path`, `forced-fts`, and `forced-fallback` evidence for all five pages of the 42-authorized/21-unauthorized mixed fixture; prove no unauthorized ID, name, content, snippet, or unique leak token appears in any response field, every authorized target appears exactly once, cursors terminate correctly, and final ordered sequences or sorted sets match the approved contract across all three executions.
12. Preserve complete logs and real process exit codes. A reduced previous check count is a failure.
13. Create a visual HTML report page with every reviewable block carrying `data-fb`, and inline the contents of `~/.claude/review-kit/feedback-layer.js` at the end.
14. Include a plain **TEST IT** section that Vikas can follow in the installed app.
15. Only after the complete chain is green may the feature be described as `DONE-PROVEN`.

Package-script pointers to verify before running:

- `package.json:12` — `typecheck:app`
- `package.json:13` — full build
- `package.json:16` — package build
- `package.json:17` — distribution build
- `package.json:18` — all workspace tests
- `package.json:19` — repository QA
- `package.json:20` — installed-app QA
- `package.json:21` — relay development process

## 9. Reporting rules

- Do not edit `SOL-REPORT.md` until there is a real state change backed by fresh evidence.
- Use only `DONE-PROVEN`, `UNVERIFIED`, or `NOT STARTED`.
- The Feature 3 section must include:
  - status;
  - exact commit hash;
  - evidence with real command/check counts from the conductor's own runs;
  - visual report-page URL/path;
  - open questions and remaining risks.
- Never write invented zeroes, estimated counts, or implied green status for a command that was not run.
- State every assumption as `assuming X — correct me` in the brief, implementation ledger, and final report.
- Keep `SOL-REPORT.md`, the implementation ledger, Git state, durable scout reports, evidence logs, visual report, and installed build consistent with one another.
- Completion requires a clean tree and an installed app matching the reported commit.
- Land/push according to the verified project branch policy only after proof. Do not assume stale branch metadata in the current `SOL-REPORT.md` is authoritative.
- If incomplete, report exactly what is implemented, what evidence passed, what failed or was not run, and the safest next command.

## 10. Fresh-session concerns to resolve before code

1. The preparation session observed a dirty `sol/shared-artifacts` tree with modified QA/driver files and Feature 1 evidence artifacts. Preserve that work and verify the correct clean base before branching.
2. `SOL-REPORT.md` was reported as naming `master` and an older starting commit while the active source branch was `sol/shared-artifacts`; verify and resolve the metadata mismatch before using it as branch truth.
3. The current shared result contract is message-shaped. Rich artifact/version results may affect the engine's narrower search consumer; backward compatibility needs an explicit decision and experiment.
4. Artifact metadata is in SQLite but artifact bytes are on disk. Live indexing, crash recovery, backfill, pruning cleanup, deletion, and permission behavior need one durable rule.
5. The current fallback searches message text. Target-ID and filter parity for artifact names, contents, retained versions, and pruned-version absence must be proven in FTS and fallback modes.
6. Date semantics, result-kind vocabulary, ranking/order, artifact identity-versus-version multiplicity, snippet rules, invalid-filter behavior, UI form, text eligibility, and pagination/continuation remain product decisions.
7. The existing desktop Search overlay and Files surface share large source files. Keep them in one UI lane to avoid merge collisions.
8. Feature 2 remains blocked until Vikas feedback; do not let a fresh session silently resume it.
