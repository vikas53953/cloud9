// OPENING A FILE THE OWNER DROPPED INTO THE ROOM — the rules, with no socket,
// no disk and no hub anywhere near them.
//
// THE GAP THIS CLOSES (gap 1, 2026-08-05). `context.ts` carried an attachment's
// NAME into the prompt and its bytes nowhere, and said so in its own comment:
// "AN ATTACHMENT IS NAMED, NEVER OPENED … Cloud9 supplies no tool to read one
// yet". So the owner drags `budget-q3.xlsx` into a room, asks what it says, and
// his agent answers about a file name. From where he sits that is the app being
// broken.
//
// WHAT LIVES HERE AND WHAT DOES NOT. This file answers three questions and only
// these three:
//
//   1. WHICH file did the agent mean, out of the ones attached in this
//      conversation? (`findAttachment`)
//   2. Are these bytes words at all? (`asWords`)
//   3. What does the agent say when the answer is no? (the sentences, in one
//      place, in plain words)
//
// It does NOT decide whether the agent may have the file. That is not this
// file's business and must never become it: the hub already owns that question
// and answers it twice — once when the engine asks for a download ticket
// (`attachmentTicket` → `channelFor`) and again when the bytes are served
// (`serveAttachment` → `channelFor`, and the ticket is spent before either
// check can fail). Re-deriving it here would be a second copy of a permission
// rule, which is the failure this codebase spends most of its comments
// avoiding. The one boundary this file DOES enforce is narrower than the hub's
// and belongs to the turn: the candidates it will even consider are the
// messages of the ONE conversation the turn is happening in.
import { Attachment, Message, nameKey } from "@cloud9/shared";
import {
  CLOUD9_ATTACHMENT_TEXT_LIMIT, CLOUD9_IMAGE_BYTES_LIMIT, CLOUD9_PDF_BYTES_LIMIT,
  Cloud9AttachmentAnswer,
} from "./cloud9tools.js";

/** One attached file the turn can see, with the message it arrived on. */
export interface RoomFile {
  attachment: Attachment;
  /** who attached it and when — for the sentence, never for permission */
  authorName: string;
  ts: number;
}

/**
 * Every file attached in this conversation, newest first.
 *
 * A DELETED MESSAGE'S FILE IS GONE WITH IT. The room shows "(this message was
 * deleted)" and so does the agent's context; a file the room no longer offers
 * is not a file the agent may quietly still open.
 */
export function filesInConversation(messages: readonly Message[]): RoomFile[] {
  const files: RoomFile[] = [];
  for (const m of messages) {
    if (m.deletedAt) continue;
    for (const attachment of m.attachments ?? []) {
      if (!attachment?.name) continue;
      files.push({ attachment, authorName: m.authorName, ts: m.ts });
    }
  }
  return files.sort((a, b) => b.ts - a.ts);
}

/**
 * WHICH FILE DID IT MEAN?
 *
 * Matched on the name the room shows, through `nameKey` — the app's existing
 * owner of "are these two file names the same name", already used to match an
 * agent's own produced files against its manifest. Case and spacing therefore
 * do not have to be typed back perfectly, which matters because the model is
 * copying a name out of a line of prose.
 *
 * NEWEST WINS when the same name was attached twice. Re-attaching a corrected
 * spreadsheet under the same name is an ordinary thing a person does, and
 * answering from the first version would be answering from a file he replaced.
 */
export function findAttachment(
  files: readonly RoomFile[], wanted: string,
): RoomFile | undefined {
  const key = nameKey(wanted);
  return files.find(f => nameKey(f.attachment.name) === key);
}

/** No such file here — and the sentence names what IS here, so it is actionable. */
export function noSuchFileHere(wanted: string, files: readonly RoomFile[]): string {
  const names = [...new Set(files.map(f => f.attachment.name))].slice(0, 10);
  if (names.length === 0) {
    return `Nothing called "${wanted}" is attached in this conversation — in fact no file ` +
      "has been attached here at all. Say that plainly rather than guessing at what is in it.";
  }
  return `Nothing called "${wanted}" is attached in this conversation. The files that ARE ` +
    `attached here: ${names.join(", ")}. Say that plainly rather than guessing.`;
}

/**
 * WHAT IS THIS FILE, REALLY?
 *
 * ONE OWNER FOR "WHAT KIND OF THING IS THIS", and it reads the BYTES — never the
 * `mime` the sender claimed and never the extension on the name. That is the law
 * the hub already applies on the way out (`downloadContentType` computes from
 * the name, never from the claimed type), taken one step further: a name can be
 * wrong by accident as easily as a claimed type can be wrong on purpose, and a
 * screenshot saved as `notes.txt` is still a screenshot.
 *
 * SNIFFING RUNS BEFORE `asWords`, and that ordering is load-bearing. A small
 * uncompressed PDF contains no NUL byte and decodes cleanly as UTF-8, so the
 * words test used to ACCEPT one and hand the model a page of `BT /F1 18 Tf …`
 * PostScript operators as though they were the invoice. Asking "what is it"
 * first means a PDF is a PDF whatever its insides happen to decode to.
 *
 * THE FOUR IMAGE TYPES ARE NOT A GUESS. PNG, JPEG, GIF and WEBP are exactly the
 * four the model can be shown; anything else that happens to be a picture is
 * refused with a sentence rather than sent and rejected upstream, where the
 * failure would reach the room as "something went wrong".
 */
export interface FileKind {
  /** how it must travel to the model */
  as: "image" | "document";
  /** the type the model is told, computed from the bytes */
  mimeType: string;
  /** plain words for the sentence, when it cannot travel after all */
  what: string;
}

const starts = (b: Buffer, ...bytes: number[]): boolean =>
  b.length >= bytes.length && bytes.every((x, i) => b[i] === x);

const SNIFFERS: readonly { kind: FileKind; test: (b: Buffer) => boolean }[] = [
  {
    kind: { as: "image", mimeType: "image/png", what: "a PNG picture" },
    test: b => starts(b, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
  },
  {
    kind: { as: "image", mimeType: "image/jpeg", what: "a JPEG photo" },
    test: b => starts(b, 0xff, 0xd8, 0xff),
  },
  {
    kind: { as: "image", mimeType: "image/gif", what: "a GIF picture" },
    test: b => b.subarray(0, 6).toString("latin1") === "GIF87a"
      || b.subarray(0, 6).toString("latin1") === "GIF89a",
  },
  {
    kind: { as: "image", mimeType: "image/webp", what: "a WEBP picture" },
    test: b => b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF"
      && b.subarray(8, 12).toString("latin1") === "WEBP",
  },
  {
    kind: { as: "document", mimeType: "application/pdf", what: "a PDF" },
    test: b => starts(b, 0x25, 0x50, 0x44, 0x46, 0x2d),   // "%PDF-"
  },
];

/** The kind, from the bytes — or undefined for "not something the model can be shown". */
export function sniffKind(bytes: Buffer): FileKind | undefined {
  return SNIFFERS.find(s => s.test(bytes))?.kind;
}

/**
 * PLAIN WORDS FOR A FILE THAT IS NONE OF THE ABOVE AND IS NOT WORDS EITHER.
 *
 * Honesty rule 4 in one function: the agent must be able to say what the file IS
 * and what it cannot do with it. "It is not words" alone invites the model to
 * fill the silence from the file name, which is the exact failure this whole
 * doorway exists to stop.
 */
export function describeOpaque(bytes: Buffer): string {
  if (starts(bytes, 0x50, 0x4b, 0x03, 0x04) || starts(bytes, 0x50, 0x4b, 0x05, 0x06)) {
    return "a zip-packed file — Word, Excel, PowerPoint and .zip archives are all this";
  }
  if (starts(bytes, 0xd0, 0xcf, 0x11, 0xe0)) return "an old-style Office file (.doc/.xls/.ppt)";
  if (starts(bytes, 0x52, 0x61, 0x72, 0x21)) return "a RAR archive";
  if (starts(bytes, 0x1f, 0x8b)) return "a gzip-compressed file";
  if (starts(bytes, 0x49, 0x44, 0x33) || starts(bytes, 0xff, 0xfb)) return "an audio file";
  if (bytes.subarray(4, 8).toString("latin1") === "ftyp") return "a video file";
  return "a packed or binary format";
}

/**
 * ARE THESE BYTES WORDS?
 *
 * Decided from the BYTES, never from the `mime` the sender claimed — the same
 * law the hub already applies on the way out (`downloadContentType` computes
 * from the name, never from the claimed type). A sender's label is a wish.
 *
 * The test is deliberately crude and deliberately conservative: a NUL byte, or
 * anything that does not survive a strict UTF-8 decode, means "not words". That
 * refuses a PDF, a picture and a real .xlsx — all of which are zip or binary
 * containers — and it accepts text, CSV, JSON, code, logs and Markdown, which
 * is what the owner actually drops into a room to be read. Refusing them with a
 * sentence beats handing the model a page of mojibake it will confidently
 * summarise.
 */
export function asWords(bytes: Buffer): string | undefined {
  if (bytes.includes(0)) return undefined;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  // U+FFFD is what a failed decode leaves behind. One is an accident in a long
  // file; a scattering of them means these were never characters.
  let bad = 0;
  for (const ch of text) if (ch === "�") bad++;
  if (bad > 0 && bad * 100 > text.length) return undefined;
  return text;
}

/**
 * The sentence for a file that is real, is here, and is neither words nor
 * something the model can be shown.
 *
 * It NAMES THE THING. Before pictures and PDFs could travel, this sentence
 * covered them too and said "a picture, a PDF or another packed format" — a list
 * of guesses, because nothing had actually looked. Now something has, so the
 * sentence says what the bytes are.
 */
export function notWordsSentence(name: string, what = "a packed or binary format"): string {
  return `"${name}" is attached in this conversation, and it is ${what} — not something I ` +
    "can read as words and not a picture or PDF I can be shown. Say exactly that: name " +
    "what the file is, say you cannot read inside it, and do not guess at its contents " +
    "from its name.";
}

/**
 * The sentence for a picture or PDF that IS the right kind and is simply too big
 * to travel.
 *
 * A separate sentence from `notWordsSentence` on purpose: "I cannot read this
 * kind of file" and "this one is too big" are different facts and lead to
 * different next moves — the second one the owner can act on by sending a
 * smaller copy, and only if he is told which it was.
 */
export function tooBigSentence(name: string, what: string, bytes: number, cap: number): string {
  const mb = (n: number): string => `${(n / 1_000_000).toFixed(1)} MB`;
  return `"${name}" is ${what}, attached in this conversation, but at ${mb(bytes)} it is over ` +
    `the ${mb(cap)} I can be shown in one go, so I have not seen it. Say exactly that — ` +
    "including the size — and do not guess at what is in it. A smaller copy would work.";
}

/** The sentence for a file whose bytes would not come back from the hub. */
export function couldNotFetchSentence(name: string): string {
  return `I could not get "${name}" just now, so I have not read it. Say that plainly ` +
    "rather than answering as if you had.";
}

/**
 * THE WHOLE ANSWER, assembled from the three questions above.
 *
 * `fetchBytes` is injected rather than imported for the reason `wholecomputer.ts`
 * gives about the disk: it is a fact about this moment and about a live
 * connection, and keeping it out means every rule in this file can be tested
 * without a hub, a socket or a ticket. The engine supplies the real one.
 */
export async function openAttachmentInConversation(
  messages: readonly Message[],
  wanted: string,
  fetchBytes: (attachment: Attachment) => Promise<Buffer | undefined>,
): Promise<Cloud9AttachmentAnswer> {
  const files = filesInConversation(messages);
  const found = findAttachment(files, wanted);
  if (!found) return { found: false, why: noSuchFileHere(wanted, files) };

  let bytes: Buffer | undefined;
  try { bytes = await fetchBytes(found.attachment); }
  catch (err) {
    console.error("[attachment-reach] could not fetch an attachment:", err);
    bytes = undefined;
  }
  if (!bytes) return { found: false, why: couldNotFetchSentence(found.attachment.name) };
  const name = found.attachment.name;

  // WHAT IS IT, before whether it decodes. See `sniffKind` for why this order is
  // load-bearing rather than tidy.
  const kind = sniffKind(bytes);
  if (kind) {
    // THE CAP IS PER KIND, because the ceilings underneath are per kind. Over it,
    // the agent is told the size and the type — never handed the bytes to fail on
    // upstream, where the failure would reach the room as "something went wrong".
    const cap = kind.as === "image" ? CLOUD9_IMAGE_BYTES_LIMIT : CLOUD9_PDF_BYTES_LIMIT;
    if (bytes.length > cap) {
      return { found: false, why: tooBigSentence(name, kind.what, bytes.length, cap) };
    }
    return {
      found: true, as: kind.as, name, mimeType: kind.mimeType,
      base64: bytes.toString("base64"), what: kind.what,
    };
  }

  const words = asWords(bytes);
  if (words === undefined) {
    return { found: false, why: notWordsSentence(name, describeOpaque(bytes)) };
  }

  const truncated = words.length > CLOUD9_ATTACHMENT_TEXT_LIMIT;
  return {
    found: true,
    as: "words",
    name,
    text: truncated ? words.slice(0, CLOUD9_ATTACHMENT_TEXT_LIMIT) : words,
    truncated,
  };
}
