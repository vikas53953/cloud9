import test from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_LIMITS,
  Artifact,
  ArtifactAccess,
  ArtifactLink,
  ArtifactRelationView,
  ArtifactVersion,
  ArtifactWorkspaceEntry,
  ClientFrame,
  ServerFrame,
  StoredArtifact,
  StoredArtifactVersion,
  artifactForPublic,
  artifactVersionForPublic,
  effectiveArtifactAccess,
  isArtifactRestricted,
  normaliseArtifactAccess,
  normaliseArtifactLinks,
  parseArtifactLinkManifest,
  validateArtifactAccess,
  validateArtifactAccessMutation,
  validateArtifactLink,
  validateArtifactLinkManifest,
  validateArtifactLinks,
  validateArtifactVersionRef,
} from "./index.js";

const target = (artifactId = "af_1", version = 1) => ({ artifactId, version });
const link = (kind: ArtifactLink["kind"] = "made-from", artifactId = "af_1", version = 1): ArtifactLink => ({
  kind,
  target: target(artifactId, version),
});
const publicVersion = (over: Partial<ArtifactVersion> = {}): ArtifactVersion => ({
  id: "av_1",
  version: 1,
  size: 10,
  sha256: "a".repeat(64),
  text: true,
  storedAs: "av_1-summary.pdf",
  agentId: "ag_1",
  agentName: "Scribe",
  ownerId: "u_1",
  producedAt: 1_000,
  ...over,
});

test("legacy artifacts with no access field keep room access, but mutations must be explicit", () => {
  assert.deepEqual(effectiveArtifactAccess(undefined), { kind: "room" });
  assert.equal(isArtifactRestricted(undefined), false);
  assert.equal(validateArtifactAccess(undefined), null, "stored legacy absence remains valid");
  assert.ok(validateArtifactAccessMutation(undefined), "a mutation may not use legacy absence");

  const room: ArtifactAccess = { kind: "room" };
  const restricted: ArtifactAccess = { kind: "restricted", userIds: ["u_1"] };
  assert.deepEqual(effectiveArtifactAccess(room), room);
  assert.equal(isArtifactRestricted(room), false);
  assert.equal(isArtifactRestricted(restricted), true);
  assert.equal(validateArtifactAccessMutation(room), null);
  assert.equal(validateArtifactAccessMutation(restricted), null);
});

test("artifact access rejects invalid shapes, inherited fields and raw overflow", () => {
  for (const bad of [
    null,
    "room",
    {},
    { kind: "everyone" },
    { kind: "room", userIds: [] },
    { kind: "restricted" },
    { kind: "restricted", userIds: "u_1" },
    { kind: "restricted", userIds: [1] },
    { kind: "restricted", userIds: ["../u_1"] },
    { kind: "restricted", userIds: [], extra: true },
    Object.create({ kind: "room" }),
    Object.assign(Object.create({ userIds: ["u_1"] }), { kind: "restricted" }),
  ]) {
    assert.ok(validateArtifactAccess(bad), `should reject ${JSON.stringify(bad)}`);
  }
  assert.ok(validateArtifactAccess({
    kind: "restricted",
    userIds: Array.from({ length: ARTIFACT_LIMITS.accessUsers + 1 }, (_, i) => `u_${i}`),
  }), "the cap applies before dedupe so a hostile raw list is still bounded");
});

test("restricted access accepts exactly 200 users and deduplicates canonically", () => {
  const boundary: ArtifactAccess = {
    kind: "restricted",
    userIds: Array.from({ length: ARTIFACT_LIMITS.accessUsers }, (_, i) => `u_${i}`),
  };
  assert.equal(validateArtifactAccessMutation(boundary), null);

  const input: ArtifactAccess = { kind: "restricted", userIds: ["u_2", "u_1", "u_2", "u_1"] };
  assert.equal(validateArtifactAccess(input), null);
  assert.deepEqual(normaliseArtifactAccess(input), {
    kind: "restricted",
    userIds: ["u_2", "u_1"],
  });
  assert.deepEqual(normaliseArtifactAccess(undefined), { kind: "room" });
});

test("typed links accept only the two kinds and exact positive own-property versions", () => {
  assert.equal(validateArtifactVersionRef(target()), null);
  assert.equal(validateArtifactLink(link()), null);
  assert.equal(validateArtifactLink(link("goes-with", "af_2", 9)), null);

  for (const bad of [
    null,
    {},
    { artifactId: "../escape", version: 1 },
    { artifactId: "af_1" },
    { artifactId: "af_1", version: 0 },
    { artifactId: "af_1", version: 1.5 },
    { artifactId: "af_1", version: 1, newest: true },
    Object.create({ artifactId: "af_1", version: 1 }),
    Object.assign(Object.create({ version: 1 }), { artifactId: "af_1" }),
  ]) {
    assert.ok(validateArtifactVersionRef(bad), `should reject ref ${JSON.stringify(bad)}`);
  }
  for (const bad of [
    null,
    {},
    { kind: "derived-from", target: target() },
    { kind: "made-from" },
    { kind: "goes-with", target: target(), markdown: "guess" },
    Object.create({ kind: "made-from", target: target() }),
    Object.assign(Object.create({ target: target() }), { kind: "made-from" }),
  ]) {
    assert.ok(validateArtifactLink(bad), `should reject link ${JSON.stringify(bad)}`);
  }
});

test("the whole-list link validator covers direct publish and manifest input", () => {
  const boundary = Array.from(
    { length: ARTIFACT_LIMITS.linksPerVersion },
    (_, i) => link(i % 2 ? "goes-with" : "made-from", `af_${i}`, i + 1),
  );
  assert.equal(validateArtifactLinks(boundary), null, "exactly 20 direct links are accepted");
  assert.ok(validateArtifactLinks([...boundary, link("made-from", "af_over", 1)]));
  assert.ok(validateArtifactLinks("made-from"));

  assert.equal(validateArtifactLinkManifest({ files: [{ name: "summary.pdf", links: boundary }] }), null);
  assert.ok(validateArtifactLinkManifest({
    files: [{ name: "summary.pdf", links: [...boundary, link("made-from", "af_over", 1)] }],
  }));
});

test("links dedupe by kind plus exact target without changing order", () => {
  const links = [
    link("made-from", "af_1", 2),
    link("made-from", "af_1", 2),
    link("goes-with", "af_1", 2),
    link("made-from", "af_1", 3),
    link("goes-with", "af_1", 2),
  ];
  assert.deepEqual(normaliseArtifactLinks(links), [
    link("made-from", "af_1", 2),
    link("goes-with", "af_1", 2),
    link("made-from", "af_1", 3),
  ]);
});

test("manifest object rules cover own properties, names, notes, duplicates and invalid types", () => {
  assert.equal(validateArtifactLinkManifest({
    files: [{
      name: "summary.pdf",
      note: "final figures",
      links: [link("made-from", "af_123", 2)],
    }],
  }), null);

  for (const bad of [
    null,
    [],
    {},
    { files: "summary.pdf" },
    { files: [null] },
    { files: [{ name: "../summary.pdf" }] },
    { files: [{ name: "summary.pdf", note: 2 }] },
    { files: [{ name: "summary.pdf", note: "x".repeat(ARTIFACT_LIMITS.note + 1) }] },
    { files: [{ name: "summary.pdf", links: "made-from" }] },
    { files: [{ name: "summary.pdf", extra: true }] },
    { files: [{ name: "Summary.pdf" }, { name: "summary.pdf" }] },
    { files: [], extra: true },
    Object.create({ files: [] }),
    { files: [Object.create({ name: "summary.pdf" })] },
    { files: [Object.assign(Object.create({ links: [link()] }), { name: "summary.pdf" })] },
  ]) {
    assert.ok(validateArtifactLinkManifest(bad), `should reject manifest ${JSON.stringify(bad)}`);
  }
});

test("manifest accepts exactly 10 files and refuses the eleventh", () => {
  const boundary = {
    files: Array.from({ length: ARTIFACT_LIMITS.manifestFiles }, (_, i) => ({ name: `file-${i}.txt` })),
  };
  assert.equal(validateArtifactLinkManifest(boundary), null);
  assert.ok(validateArtifactLinkManifest({
    files: [...boundary.files, { name: "file-over.txt" }],
  }));
});

test("the JSON parser and object validator apply the same manifest rule", () => {
  const object = {
    files: [{
      name: "summary.pdf",
      note: "final figures",
      links: [
        link("made-from", "af_123", 2),
        link("made-from", "af_123", 2),
        link("goes-with", "af_456", 4),
      ],
    }],
  };
  const parsed = parseArtifactLinkManifest(JSON.stringify(object));
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.manifest.files[0].links, [
      link("made-from", "af_123", 2),
      link("goes-with", "af_456", 4),
    ], "valid parsed data is canonical before the engine matches it to files");
  }

  const invalid = { files: [{ name: "summary.pdf", links: [{ kind: "guess", target: target() }] }] };
  const objectReason = validateArtifactLinkManifest(invalid);
  const parserResult = parseArtifactLinkManifest(JSON.stringify(invalid));
  assert.ok(objectReason);
  assert.deepEqual(parserResult, { ok: false, reason: objectReason });
  assert.equal(parseArtifactLinkManifest("not json").ok, false);
  assert.equal(parseArtifactLinkManifest(42).ok, false);
});

test("manifest parsing accepts exactly 65,536 UTF-8 bytes and refuses one more", () => {
  const json = '{"files":[]}';
  const exact = `${" ".repeat(ARTIFACT_LIMITS.manifestBytes - Buffer.byteLength(json))}${json}`;
  assert.equal(Buffer.byteLength(exact), ARTIFACT_LIMITS.manifestBytes);
  assert.equal(parseArtifactLinkManifest(exact).ok, true);

  const over = ` ${exact}`;
  assert.equal(Buffer.byteLength(over), ARTIFACT_LIMITS.manifestBytes + 1);
  assert.deepEqual(parseArtifactLinkManifest(over), {
    ok: false,
    reason: `that file-link manifest is too big (max ${ARTIFACT_LIMITS.manifestBytes} bytes)`,
  });
});

test("stored raw links require an explicit public projection before any wire view", () => {
  const storedVersion: StoredArtifactVersion = {
    ...publicVersion(),
    links: [link("made-from", "af_hidden", 7)],
  };
  // @ts-expect-error A stored version with raw links is not a public ArtifactVersion.
  const forbiddenPublicVersion: ArtifactVersion = storedVersion;
  void forbiddenPublicVersion;

  const visibleVersion = artifactVersionForPublic(storedVersion);
  assert.equal("links" in visibleVersion, false);
  assert.deepEqual(visibleVersion, publicVersion());

  const storedArtifact: StoredArtifact = {
    id: "af_1",
    channelId: "ch_1",
    name: "summary.pdf",
    versions: [storedVersion],
    access: { kind: "room" },
    createdAt: 1,
    updatedAt: 2,
  };
  const forbiddenFrame: Extract<ServerFrame, { type: "artifact" }> = {
    type: "artifact",
    // @ts-expect-error A storage artifact cannot be placed directly in a public frame.
    artifact: storedArtifact,
  };
  const forbiddenWorkspace: ArtifactWorkspaceEntry = {
    artifactId: "af_1",
    channelId: "ch_1",
    channelName: "General",
    name: "summary.pdf",
    // @ts-expect-error A storage version cannot be used as a public workspace latest row.
    latest: storedVersion,
    versionCount: 1,
    access: { kind: "room" },
    updatedAt: 2,
  };
  void forbiddenFrame;
  void forbiddenWorkspace;

  const visibleArtifact = artifactForPublic(storedArtifact);
  assert.equal("links" in visibleArtifact.versions[0], false);
});

test("relation views encode only visible links or hidden outgoing placeholders", () => {
  const hidden: ArtifactRelationView = {
    kind: "made-from",
    direction: "outgoing",
    from: target("af_1", 3),
    hidden: true,
  };
  const outgoing: ArtifactRelationView = {
    kind: "made-from",
    direction: "outgoing",
    from: target("af_1", 3),
    to: target("af_2", 4),
    linkedName: "source.csv",
    hidden: false,
  };
  const incoming: ArtifactRelationView = {
    kind: "goes-with",
    direction: "incoming",
    from: target("af_3", 2),
    to: target("af_1", 3),
    linkedName: "companion.pdf",
    hidden: false,
  };
  assert.deepEqual(hidden, {
    kind: "made-from", direction: "outgoing", from: target("af_1", 3), hidden: true,
  });
  assert.equal(outgoing.linkedName, "source.csv");
  assert.equal(incoming.direction, "incoming");

  // @ts-expect-error Hidden targets must expose no target reference or name.
  const hiddenLeak: ArtifactRelationView = {
    kind: "made-from", direction: "outgoing", from: target(), hidden: true,
    to: target("af_hidden", 9), linkedName: "secret.pdf",
  };
  // @ts-expect-error Visible relations require both the exact target and its name.
  const visibleWithoutTarget: ArtifactRelationView = {
    kind: "made-from", direction: "outgoing", from: target(), hidden: false,
  };
  // @ts-expect-error Hidden incoming relations are not supported.
  const hiddenIncoming: ArtifactRelationView = {
    kind: "goes-with", direction: "incoming", from: target(), hidden: true,
  };
  void hiddenLeak;
  void visibleWithoutTarget;
  void hiddenIncoming;
});

test("effective client/server/workspace contracts pin compatibility and pagination", () => {
  const legacyArtifact: Artifact = {
    id: "af_1",
    channelId: "ch_1",
    name: "summary.pdf",
    versions: [publicVersion()],
    createdAt: 1,
    updatedAt: 2,
  };
  const workspaceRow: ArtifactWorkspaceEntry = {
    artifactId: legacyArtifact.id,
    channelId: legacyArtifact.channelId,
    channelName: "General",
    name: legacyArtifact.name,
    latest: legacyArtifact.versions[0],
    versionCount: 1,
    access: effectiveArtifactAccess(legacyArtifact.access),
    updatedAt: legacyArtifact.updatedAt,
  };
  const pageRequest: Extract<ClientFrame, { type: "artifactWorkspace" }> = {
    type: "artifactWorkspace",
    before: 2,
    beforeId: "af_1",
    limit: ARTIFACT_LIMITS.workspaceDefault,
  };
  const mutation: Extract<ClientFrame, { type: "setArtifactAccess" }> = {
    type: "setArtifactAccess",
    artifactId: "af_1",
    access: { kind: "room" },
  };
  const publish: Extract<ClientFrame, { type: "publishArtifact" }> = {
    type: "publishArtifact",
    channelId: "ch_1",
    agentId: "ag_1",
    name: "summary.pdf",
    dataBase64: "YQ==",
    links: [link()],
  };
  const pageResponse: Extract<ServerFrame, { type: "artifactWorkspace" }> = {
    type: "artifactWorkspace",
    artifacts: [workspaceRow],
    hasMore: true,
    nextBefore: 2,
    nextBeforeId: "af_1",
  };
  const detailWithoutRelations: Extract<ServerFrame, { type: "artifact" }> = {
    type: "artifact",
    artifact: legacyArtifact,
  };
  const detailWithHidden: Extract<ServerFrame, { type: "artifact" }> = {
    type: "artifact",
    artifact: legacyArtifact,
    relations: [{
      kind: "made-from",
      direction: "outgoing",
      from: target("af_1", 1),
      hidden: true,
    }],
  };

  assert.equal(pageRequest.limit, 50);
  assert.equal(mutation.access.kind, "room");
  assert.equal(publish.links?.length, 1);
  assert.equal(pageResponse.hasMore, true);
  assert.equal(pageResponse.nextBeforeId, "af_1");
  assert.equal(detailWithoutRelations.relations, undefined);
  assert.equal(detailWithHidden.relations?.[0].hidden, true);
  assert.equal(workspaceRow.access.kind, "room");
});

test("every client frame may carry one optional request id without widening discriminants", () => {
  const oldMembers: Extract<ClientFrame, { type: "channelMembers" }> = {
    type: "channelMembers",
    channelId: "ch_1",
  };
  const membersWithId: Extract<ClientFrame, { type: "channelMembers" }> = {
    type: "channelMembers",
    channelId: "ch_1",
    at: 123,
    requestId: "req_members_1",
  };
  const infoWithId: Extract<ClientFrame, { type: "setChannelInfo" }> = {
    type: "setChannelInfo",
    channelId: "ch_1",
    topic: "Today",
    requestId: "req_info_1",
  };

  const readNarrowly = (frame: ClientFrame): string | undefined => {
    if (frame.type === "channelMembers") {
      const at: number | undefined = frame.at;
      void at;
      // @ts-expect-error The request-id wrapper must not widen this discriminant.
      void frame.artifactId;
      return frame.channelId;
    }
    if (frame.type === "setChannelInfo") return frame.topic;
    return undefined;
  };

  assert.equal(oldMembers.requestId, undefined);
  assert.equal(membersWithId.requestId, "req_members_1");
  assert.equal(infoWithId.requestId, "req_info_1");
  assert.equal(readNarrowly(membersWithId), "ch_1");
  assert.equal(readNarrowly(infoWithId), "Today");
});

test("error frames keep old compatibility and may echo a refused request id", () => {
  const oldError: Extract<ServerFrame, { type: "error" }> = {
    type: "error",
    error: "no such file",
  };
  const directRefusal: Extract<ServerFrame, { type: "error" }> = {
    type: "error",
    error: "no such file",
    requestId: "req_artifact_1",
  };

  assert.equal(oldError.requestId, undefined);
  assert.equal(directRefusal.requestId, "req_artifact_1");
});

test("artifact access mutation request ids are optional and direct success can echo them", () => {
  const artifact: Artifact = {
    id: "af_1",
    channelId: "ch_1",
    name: "summary.pdf",
    versions: [publicVersion()],
    access: { kind: "room" },
    createdAt: 1,
    updatedAt: 2,
  };
  const oldMutation: Extract<ClientFrame, { type: "setArtifactAccess" }> = {
    type: "setArtifactAccess",
    artifactId: "af_1",
    access: { kind: "room" },
  };
  const mutation: Extract<ClientFrame, { type: "setArtifactAccess" }> = {
    type: "setArtifactAccess",
    artifactId: "af_1",
    access: { kind: "restricted", userIds: ["u_1"] },
    requestId: "req_access_1",
  };
  const directSuccess: Extract<ServerFrame, { type: "artifact" }> = {
    type: "artifact",
    artifact,
    requestId: mutation.requestId,
  };

  assert.equal(oldMutation.requestId, undefined);
  assert.equal(mutation.requestId, "req_access_1");
  assert.equal(directSuccess.requestId, mutation.requestId);
});

test("artifact request ids round-trip while old requests and unsolicited pushes stay valid", () => {
  const artifact: Artifact = {
    id: "af_1",
    channelId: "ch_1",
    name: "summary.pdf",
    versions: [publicVersion()],
    createdAt: 1,
    updatedAt: 2,
  };
  const row: ArtifactWorkspaceEntry = {
    artifactId: "af_1",
    channelId: "ch_1",
    channelName: "General",
    name: "summary.pdf",
    latest: artifact.versions[0],
    versionCount: 1,
    access: { kind: "room" },
    updatedAt: 2,
  };
  const oldWorkspaceRequest: Extract<ClientFrame, { type: "artifactWorkspace" }> = {
    type: "artifactWorkspace",
  };
  const oldArtifactRequest: Extract<ClientFrame, { type: "artifact" }> = {
    type: "artifact",
    artifactId: "af_1",
  };
  const workspaceRequest: Extract<ClientFrame, { type: "artifactWorkspace" }> = {
    type: "artifactWorkspace",
    requestId: "req_workspace_1",
  };
  const artifactRequest: Extract<ClientFrame, { type: "artifact" }> = {
    type: "artifact",
    artifactId: "af_1",
    requestId: "req_artifact_1",
  };
  const workspaceAnswer: Extract<ServerFrame, { type: "artifactWorkspace" }> = {
    type: "artifactWorkspace",
    requestId: workspaceRequest.requestId,
    artifacts: [row],
    hasMore: false,
  };
  const artifactAnswer: Extract<ServerFrame, { type: "artifact" }> = {
    type: "artifact",
    requestId: artifactRequest.requestId,
    artifact,
  };
  const unsolicitedPush: Extract<ServerFrame, { type: "artifact" }> = {
    type: "artifact",
    artifact,
  };

  assert.equal(oldWorkspaceRequest.requestId, undefined);
  assert.equal(oldArtifactRequest.requestId, undefined);
  assert.equal(workspaceAnswer.requestId, "req_workspace_1");
  assert.equal(artifactAnswer.requestId, "req_artifact_1");
  assert.equal(unsolicitedPush.requestId, undefined);
});

test("artifact detail expresses exactly 100 relations and only signals real truncation", () => {
  const artifact: Artifact = {
    id: "af_1",
    channelId: "ch_1",
    name: "summary.pdf",
    versions: [publicVersion()],
    createdAt: 1,
    updatedAt: 2,
  };
  const relations: ArtifactRelationView[] = Array.from(
    { length: ARTIFACT_LIMITS.relationDetail },
    (_, i) => ({
      kind: "made-from" as const,
      direction: "outgoing" as const,
      from: target("af_1", i + 1),
      hidden: true as const,
    }),
  );
  const complete: Extract<ServerFrame, { type: "artifact" }> = {
    type: "artifact",
    artifact,
    relations,
  };
  const truncated: Extract<ServerFrame, { type: "artifact" }> = {
    type: "artifact",
    artifact,
    relations,
    relationsTruncated: true,
  };
  const legacy: Extract<ServerFrame, { type: "artifact" }> = { type: "artifact", artifact };
  const falsePlaceholder: Extract<ServerFrame, { type: "artifact" }> = {
    type: "artifact",
    artifact,
    // @ts-expect-error Absence means complete; false is not a wire state.
    relationsTruncated: false,
  };
  void falsePlaceholder;

  assert.equal(relations.length, 100);
  assert.equal(complete.relations?.length, ARTIFACT_LIMITS.relationDetail);
  assert.equal("relationsTruncated" in complete, false);
  assert.equal(truncated.relationsTruncated, true);
  assert.equal(legacy.relations, undefined);
  assert.equal(legacy.relationsTruncated, undefined);
});

test("workspace pagination values are bounded and have an honest default", () => {
  assert.equal(ARTIFACT_LIMITS.workspacePage, 100);
  assert.equal(ARTIFACT_LIMITS.workspaceDefault, 50);
  assert.ok(ARTIFACT_LIMITS.workspaceDefault <= ARTIFACT_LIMITS.workspacePage);
});
