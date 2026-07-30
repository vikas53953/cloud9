// THE CLIENT-FACING HALF OF THE ARTIFACT CONTRACT: the reference that can sit in
// a message, the text/binary question, and the one line a card shows.
//
// These are in `@cloud9/shared` because three programs read them — the engine
// writes a reference, the hub stores the file, the screen draws the card. They
// are TESTED from here because that is where this package's suite lives.
//
// Every test was watched to fail with its rule broken on purpose.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_LIMITS, ARTIFACT_REF_SCHEME, ArtifactVersion, ATTACHMENT_LIMITS,
  artifactRef, describeArtifactVersion, findArtifactRefs, latestVersion, looksLikeText,
  parseArtifactRef, validateArtifact, versionOf,
} from "@cloud9/shared";

const version = (over: Partial<ArtifactVersion> = {}): ArtifactVersion => ({
  id: "av_1", version: 1, size: 10, sha256: "a".repeat(64), text: true,
  storedAs: "av_1-notes.md", agentId: "ag_1", agentName: "Scribe", ownerId: "u_1",
  producedAt: 1_000, ...over,
});

test("a reference survives a round trip, with and without a version", () => {
  assert.equal(artifactRef("af_1"), `${ARTIFACT_REF_SCHEME}af_1`);
  assert.equal(artifactRef("af_1", 3), `${ARTIFACT_REF_SCHEME}af_1@3`);
  assert.deepEqual(parseArtifactRef(artifactRef("af_1")), { artifactId: "af_1" });
  assert.deepEqual(parseArtifactRef(artifactRef("af_1", 3)), { artifactId: "af_1", version: 3 });
});

test("a reference that is not one, or names an id we would not store, is refused", () => {
  for (const junk of [
    undefined, "", "af_1", "https://example.com/af_1",
    `${ARTIFACT_REF_SCHEME}../../secret`,      // a path, not an id
    `${ARTIFACT_REF_SCHEME}af_1@0`,            // there is no version 0
    `${ARTIFACT_REF_SCHEME}af_1@-2`,
    `${ARTIFACT_REF_SCHEME}af_1@newest`,
    `${ARTIFACT_REF_SCHEME}`,
  ]) {
    assert.equal(parseArtifactRef(junk), undefined, `should be refused: ${String(junk)}`);
  }
  // BREAK: drop the `isSafeStoredId` call and the `../../secret` case passes —
  // a reference that could become a file path. Watched.
});

test("every reference in a message is found, in order, once each", () => {
  const text = [
    `Done — the report is at ${artifactRef("af_1")} and ${artifactRef("af_1")} again,`,
    `and the version I started from is ${artifactRef("af_1", 1)}.`,
    `Nothing to see in cloud9://artifact/ or in af_2.`,
  ].join("\n");

  assert.deepEqual(findArtifactRefs(text), [
    { artifactId: "af_1" },
    { artifactId: "af_1", version: 1 },
  ], "one card per distinct reference, in the order they are written");
  assert.deepEqual(findArtifactRefs(undefined), [],
    "a message with no text is not a crash");
  // BREAK: remove the `seen` set and the first reference appears twice, which is
  // two cards for one file. Watched.
});

test("a reference at the END OF A SENTENCE still becomes a card", () => {
  // This is how a person and an agent both actually write it, and the greedy
  // match swallows the full stop — which used to mean no card at all.
  assert.deepEqual(findArtifactRefs(`it is at ${artifactRef("af_1")}.`),
    [{ artifactId: "af_1" }]);
  assert.deepEqual(findArtifactRefs(`the old one was ${artifactRef("af_1", 2)}.`),
    [{ artifactId: "af_1", version: 2 }]);
  // BREAK: drop the trailing-punctuation trim and both fail. Watched.
});

test("text and binary are told apart FROM THE BYTES, not from anyone's word", () => {
  assert.equal(looksLikeText(Buffer.from("# a plain report\n")), true);
  assert.equal(looksLikeText(Buffer.from("मेरी फ़ाइल है")), true, "non-English text is text");
  assert.equal(looksLikeText(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])), false,
    "a NUL byte means binary");
  assert.equal(looksLikeText(Buffer.from([0xff, 0xfe, 0xfd])), false, "not valid UTF-8");
  assert.equal(looksLikeText(Buffer.alloc(0)), false, "there is nothing to read");

  // A MULTI-BYTE CHARACTER CUT IN HALF BY THE 8 KB WINDOW IS NOT A BINARY FILE.
  // This is the case that would have mislabelled a long Hindi or emoji file:
  // the first look stops mid-character, so the whole thing gets one more chance.
  const padding = "a".repeat(8191);
  const straddles = Buffer.from(`${padding}😀 and then some more text`);
  assert.equal(straddles[8191] > 0x7f, true, "the character really does straddle the window");
  assert.equal(looksLikeText(straddles), true);
  // BREAK: return false on the first decode failure and this last case fails —
  // a real text file offered as a download nobody can preview. Watched.
});

test("the cap is the attachment cap, on purpose, and the refusal says what to do", () => {
  assert.equal(ARTIFACT_LIMITS.bytes, ATTACHMENT_LIMITS.bytes,
    "derived from one number, because the socket's own ceiling is derived from it too");
  assert.equal(validateArtifact("notes.md", 10), null);
  assert.match(validateArtifact("../escape.md", 10)!, /file name isn't allowed/);
  assert.match(validateArtifact("notes.md", 0)!, /no bytes/);
  const big = validateArtifact("huge.bin", ARTIFACT_LIMITS.bytes + 1)!;
  assert.match(big, /too big to share here/);
  assert.match(big, /10 MB/);
  assert.match(big, /still on this computer/);
});

test("the line under an artifact's name says only what is true", () => {
  assert.equal(describeArtifactVersion(version()), "made by Scribe",
    "version 1 gets no version number — there is nothing to compare it to");
  assert.equal(describeArtifactVersion(version({ version: 3 })), "made by Scribe · version 3");
  assert.equal(describeArtifactVersion(version({ version: 3, note: "fixed the numbers" })),
    "made by Scribe · version 3 · fixed the numbers");
  // BREAK: print the note unconditionally and version 1 with no note ends in a
  // dangling separator — an absent fact drawn as an empty one. Watched.
});

test("the newest version has ONE owner, and it is not indexing the list", () => {
  const artifact = {
    id: "af_1", channelId: "ch_1", name: "notes.md", createdAt: 1, updatedAt: 9,
    versions: [version({ id: "av_3", version: 3 }), version({ id: "av_2", version: 2 })],
  };
  assert.equal(latestVersion(artifact)!.version, 3);
  assert.equal(versionOf(artifact, 2)!.id, "av_2");
  assert.equal(versionOf(artifact, 1), undefined, "a pruned version is absent, not the newest");
  assert.equal(latestVersion({ ...artifact, versions: [] }), undefined);
});
