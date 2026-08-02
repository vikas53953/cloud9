# Feature 1 shared-contract handoff

## Status

DONE

## Files changed

- `C:\Users\vikasmit\cloud9\packages\shared\src\index.ts` — shared artifact access, exact-version link, manifest, workspace pagination and WebSocket contracts.
- `C:\Users\vikasmit\cloud9\packages\shared\src\artifact-workspace.test.ts` — permanent shared edge tests for access, links, manifest parsing and page limits.

No other implementation file was edited. No commit was made.

## Contract added

### Artifact access

- `Artifact.access?: ArtifactAccess`; absence remains room access for old stored artifacts.
- `ArtifactAccess` is either `{ kind: "room" }` or `{ kind: "restricted"; userIds: ID[] }`.
- Added `effectiveArtifactAccess`, `isArtifactRestricted`, `validateArtifactAccess` and `normaliseArtifactAccess`.
- Restricted user IDs are bounded to 200 raw entries and canonicalised by first-seen deduplication.
- Shared validation checks shape only. Current room membership, human-only selection, manager inclusion, owner/admin mutation authority and DM behavior remain relay-owned permission checks.

### Typed exact-version links

- Added `ArtifactLinkKind`, `ArtifactVersionRef` and `ArtifactLink`. Round-1 review then separated raw storage into `StoredArtifactVersion.links?`; public `ArtifactVersion` forbids raw links with `links?: never`.
- Only `made-from` and `goes-with` are accepted.
- Every target requires a safe stored artifact ID and a positive whole version number; there is no newest-version shortcut.
- Added validators and first-seen deduplication by `(kind, artifactId, version)`.
- Links are capped at 20 raw entries per publishing version.

### Private turn manifest

- Added `ArtifactLinkManifestFile`, `ArtifactLinkManifest`, `ArtifactLinkManifestResult`, `validateArtifactLinkManifest` and `parseArtifactLinkManifest`.
- Parser signature: `parseArtifactLinkManifest(text: unknown): ArtifactLinkManifestResult`.
- Parser is bounded at 65,536 UTF-8 bytes before JSON parsing.
- Object and JSON paths use the same validator and return the same plain refusal.
- Manifest is capped at 10 file rows, uses the existing safe-file-name rule, uses the existing 300-character artifact-note cap, refuses duplicate normalised file names and canonicalises duplicate links.
- `publishArtifact` now accepts optional checked `links` alongside the existing optional `note`; existing publishers remain compatible.

### Cross-room Files workspace

- Added `ArtifactWorkspaceEntry`: artifact/room IDs, room name, file name, latest version, version count, explicit effective access and update time.
- Added bounded cursor request: `{ type: "artifactWorkspace"; before?; beforeId?; limit? }`.
- Added response: `{ type: "artifactWorkspace"; artifacts; hasMore; nextBefore?; nextBeforeId? }`.
- Maximum page is 100 rows; default is 50.

### Permission/detail responses

- Added client mutation `{ type: "setArtifactAccess"; artifactId; access }`.
- Existing `artifact` server frame remains compatible and now optionally carries `relations?: ArtifactRelationView[]` for permitted incoming/outgoing exact-version links and hidden-target placeholders.
- Added `{ type: "artifactUnavailable"; artifactId }` so a revoked desktop can immediately discard cached detail/workspace rows.
- Added `artifact_access_changed` to the shared activity kinds.

## Compatibility kept

- Existing `ArtifactRef`, `artifactRef`, `parseArtifactRef`, `findArtifactRefs`, message-card behavior, room-scoped `artifacts`, `artifactTicket` and artifact server frames retain their existing fields and meaning.
- Compatibility fields remain optional where old data exists: `Artifact.access?`, `StoredArtifactVersion.links?`, `publishArtifact.links?`, and artifact-frame `relations?`. Public `ArtifactVersion` cannot carry raw links.

## Tests

Command run from `C:\Users\vikasmit\cloud9`:

```text
npm test --workspace @cloud9/shared
```

Latest completed run before this report:

- 80 passed
- 0 failed
- 0 skipped/cancelled
- TypeScript shared build completed first as part of the command

The new permanent test was first run before implementation and failed at compilation because the new exports and limits did not exist. It was then implemented and restored to green.

New edge coverage includes:

- legacy absent access resolves to room access;
- malformed access types, unexpected fields, unsafe IDs and raw cap overflow;
- access dedupe and stable ordering;
- invalid link kinds, unsafe IDs, absent/zero/fractional versions and unexpected fields;
- exact link identity, dedupe and raw link cap;
- malformed manifests, unsafe names, note/link types, note cap, file cap, link cap, duplicate normalised file names and unexpected fields;
- parser/object-rule refusal agreement;
- canonical parsed-link dedupe;
- invalid JSON and non-text parser input;
- UTF-8 byte cap rather than JavaScript character count;
- workspace default/max page constants.

## Concerns and integration notes

- By assignment, only the shared package tests were run. Relay, engine, desktop and installed-app integration evidence remains for Sol after all worker slices land.
- Shared helpers intentionally do not decide room membership or roles. The relay must filter permissions before applying workspace limits, include current owner/admin managers for restricted files, re-check access at ticket mint and redemption, and keep inaccessible/nonexistent responses indistinguishable.
- `ArtifactRelationView` is now a discriminated union: hidden outgoing placeholders cannot carry `to`/`linkedName`; visible relations require both; hidden incoming is not a valid type.
- `ArtifactWorkspaceEntry.versionCount` is a server-supplied total. The relay should derive it from durable version numbering, not from the retained `versions.length`, because retention keeps only the newest 20.

## Fix round 1 — verified review findings

All seven verified findings were addressed in the owned shared files.

### API corrections

- Raw exact targets were removed from the public artifact/version contract.
- New private storage types:
  - `StoredArtifactVersion = Omit<ArtifactVersion, "links"> & { links?: ArtifactLink[] }`
  - `StoredArtifact = Omit<Artifact, "versions"> & { versions: StoredArtifactVersion[] }`
- Public `ArtifactVersion` now has `links?: never`, which makes a stored version non-assignable to public artifact frames and workspace rows.
- New mandatory projection helpers:
  - `artifactVersionForPublic(stored): ArtifactVersion`
  - `artifactForPublic(stored): Artifact`
- `ArtifactRelationView` became a discriminated union:
  - hidden: outgoing only, `hidden: true`, no `to`, no `linkedName`;
  - visible: incoming or outgoing, `hidden: false`, required `to` and `linkedName`.
- New `validateArtifactAccessMutation` requires explicit room/restricted access. `validateArtifactAccess` alone keeps legacy absent-is-room reads.
- New `validateArtifactLinks` validates a whole direct-publish or manifest link list and owns the 20-link cap.
- Required validator fields must be own properties. Inherited required/optional contract fields are refused rather than treated differently from parsed JSON.
- `latestVersion` and `versionOf` now preserve whether the caller supplied stored or public versions.

### New permanent checks

- Stored versions/artifacts are compile-time refused from `ArtifactVersion`, artifact server frames and `ArtifactWorkspaceEntry.latest`.
- Hidden relation states that leak targets, hidden incoming relations and visible relations missing target/name are compile-time refused.
- Effective ClientFrame, ServerFrame, workspace and compatibility objects are constructed in the test.
- Exact accepted boundaries are pinned: 200 restricted IDs, 20 raw links, 10 manifest rows and 65,536 UTF-8 manifest bytes.
- The 20-link whole-list validator is exercised directly and through manifest validation.
- Inherited contract properties are refused.

### Commands and exact output

Red check run after adding the new review tests:

```text
npm test --workspace @cloud9/shared
```

```text
Exit code 2
> @cloud9/shared@0.1.0 test
> npm run build && node --test dist/*.test.js


> @cloud9/shared@0.1.0 build
> tsc -p tsconfig.json

src/artifact-workspace.test.ts(13,3): error TS2305: Module '"./index.js"' has no exported member 'StoredArtifact'.
src/artifact-workspace.test.ts(14,3): error TS2724: '"./index.js"' has no exported member named 'StoredArtifactVersion'. Did you mean 'ArtifactVersion'?
src/artifact-workspace.test.ts(15,3): error TS2305: Module '"./index.js"' has no exported member 'artifactForPublic'.
src/artifact-workspace.test.ts(16,3): error TS2305: Module '"./index.js"' has no exported member 'artifactVersionForPublic'.
src/artifact-workspace.test.ts(23,3): error TS2724: '"./index.js"' has no exported member named 'validateArtifactAccessMutation'. Did you mean 'validateArtifactAccess'?
src/artifact-workspace.test.ts(26,3): error TS2724: '"./index.js"' has no exported member named 'validateArtifactLinks'. Did you mean 'validateArtifactLink'?
src/artifact-workspace.test.ts(252,3): error TS2578: Unused '@ts-expect-error' directive.
src/artifact-workspace.test.ts(302,3): error TS2578: Unused '@ts-expect-error' directive.
src/artifact-workspace.test.ts(307,3): error TS2578: Unused '@ts-expect-error' directive.
src/artifact-workspace.test.ts(311,3): error TS2578: Unused '@ts-expect-error' directive.
```

Final green verification command:

```text
npm test --workspace @cloud9/shared
```

Exact output:

```text
> @cloud9/shared@0.1.0 test
> npm run build && node --test dist/*.test.js


> @cloud9/shared@0.1.0 build
> tsc -p tsconfig.json

✔ legacy artifacts with no access field keep room access, but mutations must be explicit (7.928ms)
✔ artifact access rejects invalid shapes, inherited fields and raw overflow (0.6574ms)
✔ restricted access accepts exactly 200 users and deduplicates canonically (0.7209ms)
✔ typed links accept only the two kinds and exact positive own-property versions (0.631ms)
✔ the whole-list link validator covers direct publish and manifest input (2.1362ms)
✔ links dedupe by kind plus exact target without changing order (0.3724ms)
✔ manifest object rules cover own properties, names, notes, duplicates and invalid types (0.5109ms)
✔ manifest accepts exactly 10 files and refuses the eleventh (0.3509ms)
✔ the JSON parser and object validator apply the same manifest rule (0.6188ms)
✔ manifest parsing accepts exactly 65,536 UTF-8 bytes and refuses one more (0.7793ms)
✔ stored raw links require an explicit public projection before any wire view (0.4445ms)
✔ relation views encode only visible links or hidden outgoing placeholders (0.2927ms)
✔ effective client/server/workspace contracts pin compatibility and pagination (0.3185ms)
✔ workspace pagination values are bounded and have an honest default (0.1148ms)
✔ parseHubAddress totally refuses hostile values without prototype leakage (8.1104ms)
✔ classifyHost covers every private and loopback IPv4 boundary (1.9719ms)
✔ checked addresses format, dial, and round-trip as safe strings (1.4571ms)
✔ reachInWords returns a bounded plain sentence for every reach (0.1862ms)
✔ a full Tailscale link with an invite parses whole (22.1233ms)
✔ a bare host takes the default port and no invite (4.9896ms)
✔ a tailnet MagicDNS name is private (2.4914ms)
✔ localhost is this-PC (2.0291ms)
✔ LAN ranges are local-network (2.1909ms)
✔ 172.32 is NOT private — it is public and refused (4.0837ms)
✔ a public IP is refused with the private-network sentence (2.5589ms)
✔ a public hostname is refused (2.5937ms)
✔ the invite may be attached three ways, all folded (2.5519ms)
✔ a malformed invite is refused, not silently dropped (6.445ms)
✔ Tailscale 100.64/10 boundaries (2.3415ms)
✔ octets over 255 are not an address at all (2.4802ms)
✔ empty and junk are refused in plain words (3.6627ms)
✔ a non-numeric port is caught (1.143ms)
✔ IPv6 loopback and Tailscale v6 (0.543ms)
✔ the WebSocket URL brackets a bare IPv6 (0.4307ms)
✔ format is the inverse of parse for a checked address (1.9513ms)
✔ every reach has a plain-words sentence (0.8335ms)
✔ reconcile absorbs malformed persisted shapes and prototype keys (48.9628ms)
✔ all book edits safely refuse hostile ids, labels, and addresses (9.4636ms)
✔ prototype-named hubs stay inert through add, switch, rename, and remove (0.7802ms)
✔ describeHub returns plain text for every reconciled row (0.4709ms)
✔ a fresh book is self only, and self is active (2.9274ms)
✔ adding a friend's hub keeps the input untouched (immutable) (1.6406ms)
✔ a bad address is refused with the address module's own words (0.7743ms)
✔ blank and over-long labels are refused (0.3741ms)
✔ the reserved id and duplicate ids are refused (0.5046ms)
✔ the same address twice is caught however it was typed (0.4714ms)
✔ the hub ceiling holds (0.8474ms)
✔ removing the active hub falls back to self (0.5604ms)
✔ this computer can never be removed or renamed (0.5831ms)
✔ rename refuses a duplicate label (0.71ms)
✔ switchTo refuses an unknown id (0.2382ms)
✔ reconcile repairs a junk file down to a safe book (0.3904ms)
✔ reconcile drops malformed rows, dedupes, and fixes a dangling active id (2.8549ms)
✔ describeHub reads plainly (0.4545ms)
✔ backoff handles numeric boundaries without throwing or escaping its cap (1.603ms)
✔ forty thousand seeded events preserve state and effect invariants (100.4849ms)
✔ self retries forever under a long hostile failure stream (24.1183ms)
✔ every phase renders hostile labels as a defined string (0.9303ms)
✔ backoff doubles from the floor and caps at the ceiling (3.5842ms)
✔ dialing then opening reaches connected and clears attempts (1.4874ms)
✔ a drop schedules a backoff retry whose delay grows (0.3083ms)
✔ a friend's hub falls back to self after the limit (0.349ms)
✔ this computer's own hub NEVER falls back — it retries forever (0.2586ms)
✔ a live drop counts and can also trigger fallback (0.1798ms)
✔ a stray timer outside 'waiting' is ignored, never wedges (0.2897ms)
✔ switching hubs resets cleanly to a fresh connecting state (0.2245ms)
✔ opening after retries clears the attempt count (0.2518ms)
✔ every phase has a plain-words sentence (0.6371ms)
✔ isNotifyKind remains an exact allow-list for malformed runtime values (2.7222ms)
✔ quiet-hour parsing stays boolean across hostile clocks and dates (3.2034ms)
✔ notification builders do not copy identity, secrets, or prototype payloads (16.3785ms)
✔ decisions stay plain and deterministic for hostile prefs and seen keys (112.9473ms)
✔ quiet hours off means never quiet (23.2023ms)
✔ same-day quiet window: inside and at the edges (3.6614ms)
✔ overnight quiet window wraps midnight (22:00 → 08:00) (3.141ms)
✔ DEFAULT_NOTIFY_PREFS matches Settings defaults (9.9804ms)
✔ each of the four kinds raises when notifications are on (1.5569ms)
✔ isNotifyKind names exactly the four raisers (0.6744ms)
✔ master switch off suppresses everything (0.5355ms)
✔ quiet hours suppress even approvals (Tasks hold the urgent path) (0.4449ms)
✔ you do not get a toast for your own action (0.5695ms)
✔ de-duplication: same kind+subject raises once (0.6748ms)
✔ different subjects do not collide in the de-dupe set (0.3334ms)
✔ notificationFromEvent fills the toast shape without consulting prefs (0.3224ms)
✔ suppression order: off beats quiet hours and self (0.2956ms)
ℹ tests 85
ℹ suites 0
ℹ pass 85
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 735.9212
```

### Remaining concerns

- No shared-slice concern remains from review round 1.
- Relay/engine/desktop must switch raw durable rows to `StoredArtifactVersion`/`StoredArtifact` and call the public projection helpers before any artifact/workspace server frame.
- Only the shared package suite was run, as required; combined integration remains the coordinator's evidence step.

## Narrow integration addition — relation detail cap

Final names added without changing the approved private/public split:

- `ARTIFACT_LIMITS.relationDetail = 100`
- Artifact server frame now includes `relationsTruncated?: true` beside `relations?: ArtifactRelationView[]`.
- Absence means the returned relation detail is complete/not truncated. `false` is deliberately not a wire value.

Permanent contract coverage constructs exactly 100 valid relation rows, proves both old artifact frames and complete frames omit the signal, proves a truncated frame may send `true`, and compile-checks that `false` is refused.

Command:

```text
npm test --workspace @cloud9/shared
```

Exact output summary:

```text
ℹ tests 86
ℹ suites 0
ℹ pass 86
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 440.1844
```

The command also ran `tsc -p tsconfig.json` first through the shared package test script and exited 0.

## Narrow protocol addition — artifact request correlation

Exact backward-compatible fields added:

- Client `artifactWorkspace`: `requestId?: ID`
- Client `artifact`: `requestId?: ID`
- Server `artifactWorkspace`: `requestId?: ID`
- Server `artifact`: `requestId?: ID`

Direct answers echo the request ID. Unsolicited artifact pushes omit it. All old request and response forms remain valid.

Permanent contract coverage constructs old requests without IDs, requests and direct responses with matching IDs, and an unsolicited push without an ID.

Command:

```text
npm test --workspace @cloud9/shared
```

Exact output summary:

```text
ℹ tests 87
ℹ suites 0
ℹ pass 87
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 616.3601
```

The shared test command ran the TypeScript build first and exited 0.

## Narrow protocol addition — access mutation correlation

Exact backward-compatible field added:

```ts
{ type: "setArtifactAccess"; artifactId: ID; access: ArtifactAccess; requestId?: ID }
```

The existing artifact success response already supports `requestId?: ID`, so a direct successful mutation can echo the request ID. Old no-ID mutations remain valid.

Permanent contract coverage constructs the old mutation, an ID-bearing mutation and an artifact success response echoing the same ID.

Command:

```text
npm test --workspace @cloud9/shared
```

Exact output summary:

```text
ℹ tests 88
ℹ suites 0
ℹ pass 88
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 373.7751
```

The shared test command ran the TypeScript build first and exited 0.

## Documentation truth fix — artifact response correlation

Updated the existing artifact ServerFrame `requestId` comment without changing its type or behavior. It now states that direct `artifact` reads and successful `setArtifactAccess` mutations may echo the request ID, while unsolicited publish/update pushes omit it.

Command:

```text
npm test --workspace @cloud9/shared
```

Exact output summary:

```text
ℹ tests 88
ℹ suites 0
ℹ pass 88
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 690.3749
```

The shared test command ran the TypeScript build/typecheck first and exited 0.

## Narrow protocol addition — refusal correlation

Added optional request correlation to the existing error frame without renaming its established payload field:

```ts
{ type: "error"; error: string; requestId?: ID }
```

When a client request carried a request ID, its direct refusal may echo it. General or unsolicited errors omit it. The old `{ type: "error", error }` form remains valid. The coordinator's shorthand named `message`, but the existing shared contract is `error`; retaining it avoids an unrelated breaking change.

Permanent contract coverage constructs both the old no-ID error and an ID-bearing direct refusal.

Command:

```text
npm test --workspace @cloud9/shared
```

Exact output summary:

```text
ℹ tests 89
ℹ suites 0
ℹ pass 89
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 444.458
```

The shared test command ran the TypeScript build/typecheck first and exited 0.

## Final protocol extension — universal client request IDs

One type-level owner now adds optional correlation to every ClientFrame union member:

```ts
export type WithRequestId<T> = T extends unknown ? T & { requestId?: ID } : never;
type ClientFrameBase = /* existing discriminated union */;
export type ClientFrame = WithRequestId<ClientFrameBase>;
```

The individually copied request ID fields were removed from artifact/workspace/access base rows; their public ClientFrame shapes remain identical through the wrapper. All old frames without an ID remain valid. No ServerFrame type changed in this extension. The existing error-frame comment now says a direct refusal for any client frame may echo its request ID; general errors omit it.

Permanent contract coverage constructs ordinary `channelMembers` and `setChannelInfo` frames with IDs, an old no-ID frame, and compile-checks that discriminant narrowing remains exact.

Command:

```text
npm test --workspace @cloud9/shared
```

Exact output summary:

```text
ℹ tests 90
ℹ suites 0
ℹ pass 90
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 451.1504
```

The shared test command ran the TypeScript build/typecheck first and exited 0.
