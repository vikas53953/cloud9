// THE ARTIFACT REFERENCE — THE EDGES. The companion suite to
// `artifactref.test.ts`: a reference at every sentence boundary a person
// actually types, forty references in one message, and the asymmetries
// between the dumb writer (`artifactRef`), the strict reader
// (`parseArtifactRef`) and the forgiving finder (`findArtifactRefs`).
// The functions live in `@cloud9/shared`; they are tested from here because
// that is where this package's suite lives. Nothing was edited to make these
// pass; each BREAK line names the rule that was broken on purpose.
import test from "node:test";
import assert from "node:assert/strict";
import {
  ARTIFACT_LIMITS, ARTIFACT_REF_SCHEME, ArtifactVersion,
  artifactRef, describeArtifactVersion, findArtifactRefs, latestVersion, looksLikeText,
  parseArtifactRef, validateArtifact, versionOf,
} from "@cloud9/shared";

const version = (over: Partial<ArtifactVersion> = {}): ArtifactVersion => ({
  id: "av_1", version: 1, size: 10, sha256: "a".repeat(64), text: true,
  storedAs: "av_1-notes.md", agentId: "ag_1", agentName: "Scribe", ownerId: "u_1",
  producedAt: 1_000, ...over,
});

// --------------------------------------------------------------- sentence boundaries

test("a reference becomes a card at EVERY sentence boundary a person types", () => {
  const ref = artifactRef("af_1");
  for (const end of [".", ",", ";", ":", "!", "?", ")", "]", "}", "\"", "'", "\n", "", "…", ".-"]) {
    const found = findArtifactRefs(`the report is at ${ref}${end}`);
    assert.deepEqual(found, [{ artifactId: "af_1" }],
      `lost the card at boundary ${JSON.stringify(end)}`);
  }
  // BREAK: drop the trailing-punctuation trim and the ".", "…" and ".-" cases
  // draw no card at all. Watched.
});

test("a dash after the id is NOT a boundary — it is part of the id", () => {
  // `cloud9://artifact/af_1-next` is a different artifact, not af_1 with a
  // trailing word: dashes are id characters, so the finder is right to keep them
  assert.deepEqual(findArtifactRefs(`see ${artifactRef("af_1-next")}`),
    [{ artifactId: "af_1-next" }]);
  assert.notDeepEqual(findArtifactRefs(`see ${artifactRef("af_1-next")}`),
    [{ artifactId: "af_1" }]);
});

test("a version becomes a card at sentence boundaries too", () => {
  assert.deepEqual(findArtifactRefs(`rolled back to ${artifactRef("af_1", 3)}.`),
    [{ artifactId: "af_1", version: 3 }]);
  assert.deepEqual(findArtifactRefs(`from ${artifactRef("af_1", 12)}, then onwards`),
    [{ artifactId: "af_1", version: 12 }]);
});

test("leading zeros in a version are read, normalized, and deduplicated", () => {
  const found = findArtifactRefs(`see ${ARTIFACT_REF_SCHEME}af_1@007`);
  assert.deepEqual(found, [{ artifactId: "af_1", version: 7 }],
    "@007 means version 7 — Number() does the reading");
  // "@007" and "@7" are the SAME card: the dedup key is rebuilt through
  // artifactRef, so the two spellings collapse into one
  const both = findArtifactRefs(`${ARTIFACT_REF_SCHEME}af_1@007 then ${ARTIFACT_REF_SCHEME}af_1@7`);
  assert.deepEqual(both, [{ artifactId: "af_1", version: 7 }]);
});

test("@0 kills the whole reference — there is no unversioned fallback", () => {
  // the greedy match takes the "@0", the reader refuses version 0, and the hit
  // is skipped ENTIRELY — the finder does not retry without the version
  assert.deepEqual(findArtifactRefs(`see ${ARTIFACT_REF_SCHEME}af_1@0`), []);
});

test("a version that is not digits is punctuation to the finder, a refusal to the reader", () => {
  // the finder's version group is @\d+ — a bare "@" or a negative "@-2" never
  // joins the match, so the finder sees plain af_1 with junk left behind
  assert.deepEqual(findArtifactRefs(`see ${ARTIFACT_REF_SCHEME}af_1@`), [{ artifactId: "af_1" }]);
  assert.deepEqual(findArtifactRefs(`see ${ARTIFACT_REF_SCHEME}af_1@-2`), [{ artifactId: "af_1" }]);
  // the strict reader, asked the same strings directly, refuses both:
  // Number("") is 0 and Number("-2") is below 1 — there is no version 0
  assert.equal(parseArtifactRef(`${ARTIFACT_REF_SCHEME}af_1@`), undefined);
  assert.equal(parseArtifactRef(`${ARTIFACT_REF_SCHEME}af_1@-2`), undefined);
});

test("junk after a version: the finder takes the digits, the reader takes nothing", () => {
  // finder: the match stops after the digit run — "af_1@3x" is version 3 with
  // a stray x left over; "af_1@3@4" is version 3 with a stray "@4" left over
  assert.deepEqual(findArtifactRefs(`${ARTIFACT_REF_SCHEME}af_1@3x`), [{ artifactId: "af_1", version: 3 }]);
  assert.deepEqual(findArtifactRefs(`${ARTIFACT_REF_SCHEME}af_1@3@4`), [{ artifactId: "af_1", version: 3 }]);
  // reader: the whole tail must be one integer, so both are refused outright
  assert.equal(parseArtifactRef(`${ARTIFACT_REF_SCHEME}af_1@3x`), undefined);
  assert.equal(parseArtifactRef(`${ARTIFACT_REF_SCHEME}af_1@3@4`), undefined);
});

// --------------------------------------------------------------- many references

test("forty references in one message are forty cards, in the order written", () => {
  const ids = Array.from({ length: 40 }, (_, i) => `af-${String(i + 1).padStart(3, "0")}`);
  const text = ids.map((id, i) => `part ${i + 1} is at ${artifactRef(id)}.`).join("\n");
  const found = findArtifactRefs(text);
  assert.equal(found.length, 40, "every reference became a card");
  assert.deepEqual(found.map(r => r.artifactId), ids, "in text order, not sorted order");
  assert.ok(found.every(r => r.version === undefined));
});

test("duplicates collapse by (id, version), in first-appearance order", () => {
  const text = [
    `a=${artifactRef("af_1")}`,
    `b=${artifactRef("af_1", 1)}`,
    `c=${artifactRef("af_1")}`,       // same as a — no second card
    `d=${artifactRef("af_1", 2)}`,
    `e=${artifactRef("af_1", 1)}`,     // same as b — no second card
    `f=${artifactRef("af_1")}`,        // said fifteen times, still one card
  ].join(" ");
  assert.deepEqual(findArtifactRefs(text), [
    { artifactId: "af_1" },
    { artifactId: "af_1", version: 1 },
    { artifactId: "af_1", version: 2 },
  ]);
});

test("lookalikes among the real references never become cards", () => {
  const text = [
    `real: ${artifactRef("af_1")}`,
    `device: ${ARTIFACT_REF_SCHEME}CON`,        // a Windows device name, never stored
    `device2: ${ARTIFACT_REF_SCHEME}aux.h`,     // device name before the dot
    `dots: ${ARTIFACT_REF_SCHEME}..`,           // not even an id character run
    `empty: ${ARTIFACT_REF_SCHEME}`,            // the scheme and nothing else
    `upper: CLOUD9://artifact/af_2`,            // the scheme is lowercase
    `zero: ${ARTIFACT_REF_SCHEME}af_3@0`,
  ].join("\n");
  assert.deepEqual(findArtifactRefs(text), [{ artifactId: "af_1" }],
    "one real card out of seven lookalikes");
  // BREAK: drop the isSafeStoredId check in parseArtifactRef and CON and aux.h
  // become cards — ids that could never be stored, drawn as files. Watched.
});

test("the scheme inside a larger URL still matches — the finder is not URL-aware", () => {
  // `https://…?r=cloud9://artifact/af_9` carries a real reference as far as the
  // finder is concerned; nothing in the rule asks what came before the scheme
  const found = findArtifactRefs(`mirror: https://example.test/?r=${artifactRef("af_9")}`);
  assert.deepEqual(found, [{ artifactId: "af_9" }]);
});

// --------------------------------------------------------------- the strict reader

test("parseArtifactRef at the exact edges of what it accepts", () => {
  // ids: 64 characters is the most the safe-id rule allows
  assert.deepEqual(parseArtifactRef(`${ARTIFACT_REF_SCHEME}${"a".repeat(64)}`),
    { artifactId: "a".repeat(64) });
  assert.equal(parseArtifactRef(`${ARTIFACT_REF_SCHEME}${"a".repeat(65)}`), undefined);
  // anything that is not one clean string is not a reference
  for (const junk of [undefined, null, 42, {}, [], `${ARTIFACT_REF_SCHEME}af_1 `]) {
    assert.equal(parseArtifactRef(junk), undefined, `accepted ${JSON.stringify(junk)}`);
  }
  // whitespace around the string is not trimmed — the reader is strict
  assert.equal(parseArtifactRef(` ${artifactRef("af_1")}`), undefined);
  // but the finder, scanning the same text, finds the reference inside it
  assert.deepEqual(findArtifactRefs(` ${artifactRef("af_1")} `), [{ artifactId: "af_1" }]);
});

test("the writer is dumb on purpose — it will build a string the reader refuses", () => {
  for (const bad of [artifactRef("af_1", 0), artifactRef("af_1", 1.5), artifactRef("../escape")]) {
    assert.equal(parseArtifactRef(bad), undefined,
      `the reader is the gate, not the writer: ${bad}`);
  }
});

// --------------------------------------------------------------- the other client questions

test("the 8 KB look is the whole contract of looksLikeText", () => {
  const full = Buffer.alloc(8192, 0x61);
  assert.equal(looksLikeText(full), true, "a window of exactly 8 KB of text is text");
  const nulInside = Buffer.alloc(8192, 0x61);
  nulInside[8191] = 0;
  assert.equal(looksLikeText(nulInside), false, "a NUL on the window's last byte means binary");
  const nulBeyond = Buffer.concat([Buffer.alloc(8192, 0x61), Buffer.from([0])]);
  assert.equal(looksLikeText(nulBeyond), true,
    "a NUL PAST the window is never seen — bytes after 8 KB are not inspected");
});

test("the size cap accepts its own exact number and nothing more", () => {
  assert.equal(validateArtifact("full.bin", ARTIFACT_LIMITS.bytes), null,
    "a file of exactly the cap is shareable");
  assert.match(validateArtifact("big.bin", ARTIFACT_LIMITS.bytes + 1)!, /too big to share here/);
  for (const size of [0, -5, Number.NaN, Infinity]) {
    assert.match(validateArtifact("odd.bin", size)!, /no bytes/,
      `a size of ${String(size)} is 'no bytes', in plain words`);
  }
});

test("the line under the name never draws an absent fact", () => {
  assert.equal(describeArtifactVersion(version({ version: 2, note: "" })),
    "made by Scribe · version 2", "an empty note is no note — no dangling separator");
  assert.equal(describeArtifactVersion(version({ note: "first cut" })),
    "made by Scribe · first cut", "version 1 carries no number, but its note still shows");
});

test("versionOf answers by NUMBER, not by position — and there is no version 0", () => {
  const artifact = {
    id: "af_1", channelId: "ch_1", name: "notes.md", createdAt: 1, updatedAt: 9,
    versions: [version({ id: "av_3", version: 3 }), version({ id: "av_2", version: 2 })],
  };
  assert.equal(versionOf(artifact, 2)!.id, "av_2", "version 2 sits at index 1 and is still found");
  assert.equal(versionOf(artifact, 0), undefined);
  assert.equal(versionOf(artifact, -1), undefined);
  assert.equal(latestVersion(artifact)!.id, "av_3", "the newest is the first, by construction");
});
