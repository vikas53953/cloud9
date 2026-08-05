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
import { CLOUD9_ATTACHMENT_TEXT_LIMIT, Cloud9AttachmentAnswer } from "./cloud9tools.js";

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

/** The sentence for a file that is real, is here, and is not words. */
export function notWordsSentence(name: string): string {
  return `"${name}" is attached in this conversation, but it is not a file I can read as ` +
    "words — it is a picture, a PDF or another packed format. Say that plainly: you can " +
    "see it is there and you cannot read what is inside it.";
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

  const words = asWords(bytes);
  if (words === undefined) return { found: false, why: notWordsSentence(found.attachment.name) };

  const truncated = words.length > CLOUD9_ATTACHMENT_TEXT_LIMIT;
  return {
    found: true,
    name: found.attachment.name,
    text: truncated ? words.slice(0, CLOUD9_ATTACHMENT_TEXT_LIMIT) : words,
    truncated,
  };
}
