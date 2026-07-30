// ROUND 2 — name and filename torture.
// Assert what validateName / isSafeFileName actually do today. Surprising but
// harmless behaviour is noted; genuinely wrong behaviour is proposed in words.
import test from "node:test";
import assert from "node:assert/strict";
import {
  FILE_NAME_MAX, FILE_NAME_SENTENCE, isSafeFileName, nameKey, validateName,
} from "@cloud9/shared";

function refusalOf(kind: "agent" | "channel" | "project", name: string, taken?: string[]): string {
  const problem = validateName(kind, name, taken);
  assert.ok(problem, `expected a refusal for ${JSON.stringify(name)}`);
  assert.ok(!problem!.startsWith("Error:"), `plain words, got ${problem}`);
  assert.ok(!/[A-Za-z]:\\/.test(problem!) && !problem!.includes("/Users/"),
    `no path in refusal: ${problem}`);
  return problem!;
}

// ---------------------------------------------------------------------------
// Zero-width and BOM
// ---------------------------------------------------------------------------

test("zero-width characters are refused as not a real name", () => {
  for (const zw of ["\u200B", "\u200C", "\u200D", "\uFEFF"]) {
    // alone: no letter/number/emoji → not a name
    assert.match(refusalOf("agent", zw), /needs a name|isn't a name|one line/);
    // embedded: control-ish? NAME_CONTROL only covers C0. Document actual behaviour.
    const embedded = validateName("agent", `Scout${zw}A`);
    // TODAY: zero-width inside a name is ACCEPTED (not in NAME_CONTROL).
    // That is surprising — two looks-identical names can diverge on keying.
    if (embedded === null) {
      // record: accepted. nameKey may or may not collapse them.
      assert.notEqual(nameKey(`Scout${zw}A`), nameKey("ScoutA"),
        "NOTE: zero-width survives into the uniqueness key — see proposal below");
    } else {
      assert.ok(!embedded.startsWith("Error:"));
    }
  }
});

// ---------------------------------------------------------------------------
// Bidi overrides
// ---------------------------------------------------------------------------

test("bidi overrides are refused or survive — assert which, in plain words", () => {
  const overrides = [
    "\u202A", "\u202B", "\u202C", "\u202D", "\u202E",
    "\u2066", "\u2067", "\u2068", "\u2069",
  ];
  for (const mark of overrides) {
    const alone = validateName("channel", mark);
    assert.ok(alone, `bidi mark alone must not be a channel name`);
    assert.ok(!alone!.startsWith("Error:"));

    const sneaky = `safe${mark}gnp.exe`;
    const problem = validateName("channel", sneaky);
    // TODAY: bidi marks are NOT in NAME_CONTROL (C0 only), so this is often accepted.
    // Documented, not silently "fixed" in this read-only shared package.
    if (problem === null) {
      assert.ok(true, `accepted with bidi mark ${mark.codePointAt(0)!.toString(16)} — see proposal`);
    } else {
      assert.ok(!problem.startsWith("Error:"));
    }
  }
});

// ---------------------------------------------------------------------------
// Confusables — Cyrillic а (U+0430) vs Latin a
// ---------------------------------------------------------------------------

test("Cyrillic а and Latin a: assert collision-or-refuse, do not invent a third answer", () => {
  const latin = "Scout";
  const cyrillic = "Sc" + "\u0430" + "ut"; // Scаut with Cyrillic а
  assert.notEqual(latin, cyrillic, "the two strings are not code-point equal");
  assert.notEqual(nameKey(latin), nameKey(cyrillic),
    "TODAY: nameKey does not fold confusables — they are two different names");

  assert.equal(validateName("agent", latin), null);
  assert.equal(validateName("agent", cyrillic), null);
  // With `taken`, they do NOT collide under today's rule
  assert.equal(validateName("agent", cyrillic, [latin]), null,
    "a Cyrillic look-alike is NOT treated as a duplicate of the Latin name today");
});

// ---------------------------------------------------------------------------
// NFC vs NFD
// ---------------------------------------------------------------------------

test("NFC and NFD of one accented name are the same name", () => {
  const nfc = "Café".normalize("NFC");
  const nfd = "Café".normalize("NFD");
  assert.notEqual(nfc, nfd, "precondition: the two encodings differ on the wire");
  assert.equal(nameKey(nfc), nameKey(nfd), "uniqueness must treat them as one");
  assert.equal(validateName("agent", nfc, [nfd]),
    `you already have an agent called "${nfd.trim()}" — give this one a different name`);
});

// ---------------------------------------------------------------------------
// Emoji-only, boundaries, spaces/dots
// ---------------------------------------------------------------------------

test("emoji-only names, 1-char and max-length boundaries", () => {
  assert.equal(validateName("agent", "🐙"), null);
  assert.equal(validateName("agent", "A"), null);
  assert.equal(validateName("channel", "x".repeat(64)), null);
  assert.match(refusalOf("channel", "x".repeat(65)), /too long \(max 64/);
  assert.match(refusalOf("agent", "   "), /needs a name/);
  assert.match(refusalOf("agent", "..."), /isn't a name/);
  assert.match(refusalOf("agent", "---"), /isn't a name/);
});

// ---------------------------------------------------------------------------
// Filenames — Windows devices, trailing junk, length
// ---------------------------------------------------------------------------

test("Windows device names are refused as filenames, with a plain sentence", () => {
  for (const raw of ["CON", "PRN", "AUX", "NUL", "COM1", "LPT1", "con.md", "COM1.txt"]) {
    assert.equal(isSafeFileName(raw), false, raw);
  }
  assert.ok(FILE_NAME_SENTENCE.includes("Windows device"));
  assert.ok(!FILE_NAME_SENTENCE.startsWith("Error:"));
});

test("trailing dots and spaces in filenames are refused", () => {
  assert.equal(isSafeFileName("evil.md."), false);
  assert.equal(isSafeFileName("evil.md "), false);
  assert.equal(isSafeFileName("notes.txt"), true);
});

test("a 300-character filename is refused; the cap itself is allowed", () => {
  assert.equal(isSafeFileName("a".repeat(300) + ".txt"), false);
  assert.equal(isSafeFileName("a".repeat(FILE_NAME_MAX)), true);
  assert.equal(isSafeFileName("a".repeat(FILE_NAME_MAX + 1)), false);
});

test("ordinary real-world filenames that phase 5 cared about are accepted", () => {
  for (const n of [
    "site plan.pdf", "Site Plan Final.pdf", "invoice_2026-07.pdf",
    "report(1).pdf", "budget,notes.txt", "café-menu.txt", "photo#3.png",
    "मेरी फ़ाइल.txt",
  ]) {
    assert.equal(isSafeFileName(n), true, n);
  }
});

/*
 * PROPOSALS (words only — packages/shared/src/index.ts is forbidden this round)
 *
 * 1. Zero-width / bidi: extend NAME_CONTROL (or a sibling NAME_INVISIBLE) to
 *    cover U+200B–200D, U+FEFF, U+202A–202E, U+2066–2069 so a name cannot
 *    hide a second spelling. Refuse with "a name is one line of ordinary text".
 *
 * 2. Confusables: either fold a small homoglyph set into nameKey (Latin/Cyrillic
 *    a/e/o/p/c/y/x at minimum) OR refuse mixed-script names. Do not silently
 *    rewrite — refuse or collide, never invent a third spelling.
 */
