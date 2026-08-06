// GAP 1: AN AGENT COULD NOT OPEN A FILE THE OWNER ATTACHED IN CHAT.
//
// The reproduction, in his words: he drags `budget-q3.xlsx` into a room, asks
// his agent what is in it, and gets an answer about a file NAME. `context.ts`
// stated the cause in its own comment — the names were carried into the prompt
// and the bytes were not, and there was no tool with which to go and get them.
//
// The law this closes it under is the one search already carries, word for word:
//
//     AN AGENT MAY OPEN ONLY A FILE ATTACHED IN THE CONVERSATION IT IS TAKING
//     A TURN IN.
//
// These tests attack that from the sides a model could: an argument naming
// another room, a file attached somewhere else, a file from a message that was
// deleted, and a stale ticket from a turn that has ended. They also hold the
// three honest refusals — no such file, not words, could not fetch — to the rule
// that a refusal must be a SENTENCE THE AGENT CAN SAY, never an error from
// underneath.
import test from "node:test";
import assert from "node:assert/strict";
import { ATTACHMENT_LIMITS, Attachment, Message } from "@cloud9/shared";
import {
  asWords, filesInConversation, findAttachment, openAttachmentInConversation, sniffKind,
} from "./attachmentreach.js";
import {
  callCloud9Tool, CLOUD9_TOOLS, CLOUD9_ATTACHMENT_TEXT_LIMIT,
  CLOUD9_IMAGE_BYTES_LIMIT, CLOUD9_PDF_BYTES_LIMIT, cloud9TextOf, cloud9ToolNames,
  Cloud9ToolTurn, renderCloud9Tools,
} from "./cloud9tools.js";
import { ToolBridge } from "./toolbridge.js";
import { claudeArgs } from "./claude-cli.js";
import { renderConversation } from "./context.js";
import { AgentAbilities, AgentDef } from "@cloud9/shared";

const open = CLOUD9_TOOLS.find(t => t.name === "open_attachment")!;

// A tool result stopped being "one text block" the day a picture could be in one.
const said = cloud9TextOf;

const file = (name: string, id = `at_${name}`): Attachment => ({
  id, name, size: 10, storedAs: `${id}-${name}`, uploadedBy: "u1", uploadedAt: 1,
});

const msg = (i: number, text: string, over: Partial<Message> = {}): Message => ({
  id: `m${i}`, channelId: "c_goa", authorId: "u1", authorName: "Vikas",
  authorKind: "human", text, ts: 1_000 + i, ...over,
});

/** The bytes the hub would hand back, keyed by attachment id. */
function hub(bytes: Record<string, Buffer>) {
  const asked: string[] = [];
  return {
    asked,
    fetch: async (a: Attachment): Promise<Buffer | undefined> => {
      asked.push(a.id);
      return bytes[a.id];
    },
  };
}

// -------------------------------------------------- THE GAP ITSELF

test("gap 1: the file the owner dragged into the room can actually be read", async () => {
  // THE FAILING CASE, exactly as he meets it. Before the doorway existed this
  // could not even be expressed: `Cloud9ToolTurn` had `search` and nothing else,
  // and `CLOUD9_TOOLS` had one row.
  const room = [
    msg(1, "here is the spreadsheet", { attachments: [file("budget-q3.csv")] }),
    msg(2, "what does it say?"),
  ];
  const store = hub({ "at_budget-q3.csv": Buffer.from("line,amount\nvillas,40000\n") });

  const answer = await openAttachmentInConversation(room, "budget-q3.csv", store.fetch);
  assert.equal(answer.found, true);
  assert.ok(answer.found && answer.as === "words" && answer.text.includes("villas,40000"),
    "the agent still cannot see what is inside the file");

  // and the NAME on its own — which is all he ever got before — is still there
  assert.match(renderConversation(room), /budget-q3\.csv/);
});

test("gap 1: the tool is really handed to the harness, and the agent is told about it", () => {
  const ALL_OFF: AgentAbilities = {
    webSearch: false, files: false, schedules: false, background: false,
  };
  const talkOnly: AgentDef = {
    id: "a1", ownerId: "u1", name: "Sol", emoji: "🌞", persona: "You research travel",
    abilities: ALL_OFF, createdAt: 0,
  };
  const args = claudeArgs(talkOnly, [], { cloud9McpConfigPath: "C:\\a\\.cloud9-mcp.json" });
  assert.ok(cloud9ToolNames().includes(open.toolName));
  assert.ok(args.includes(open.toolName),
    "open_attachment is not declared to the harness, so it would silently never arrive");
  // the sentence and the tool are the same row, so one cannot ship without the other
  assert.match(renderCloud9Tools(), /open_attachment/);
});

// -------------------------------------------------- THE BOUNDARY

test("an agent cannot open a file from any conversation but its own", async () => {
  // Every shape a model could use to try to reach somewhere else. None of them
  // is a declared parameter, so all of them are refused rather than ignored —
  // ignoring would answer about another room with this room's file.
  const opened: string[] = [];
  const turn: Cloud9ToolTurn = {
    channelId: "c_goa",
    search: async () => ({ hits: [], hasMore: false }),
    openAttachment: async name => {
      opened.push(name);
      return { found: true, as: "words" as const, name, text: "…", truncated: false };
    },
  };
  const attempts: Record<string, unknown>[] = [
    { name: "salaries.csv", channelId: "c_private_hr" },
    { name: "salaries.csv", channel: "#hr" },
    { name: "salaries.csv", scope: "all" },
    { name: "salaries.csv", path: "C:\\Users\\Vikas\\Documents\\salaries.csv" },
    { name: "salaries.csv", attachmentId: "at_someone_elses" },
  ];
  for (const args of attempts) {
    const out = await callCloud9Tool(open, args, turn);
    assert.equal(out.isError, true, `${JSON.stringify(args)} was not refused`);
    assert.match(said(out), /only open a file attached in the conversation you are in/);
  }
  assert.deepEqual(opened, [], "a widened open actually ran");

  const ok = await callCloud9Tool(open, { name: "salaries.csv" }, turn);
  assert.notEqual(ok.isError, true);
  assert.deepEqual(opened, ["salaries.csv"]);
});

test("the tool has no way to name a conversation, a path or an id", () => {
  const props = Object.keys((open.schema as { properties: Record<string, unknown> }).properties);
  assert.deepEqual(props, ["name"], "open_attachment grew a second parameter");
  assert.equal((open.schema as { additionalProperties: boolean }).additionalProperties, false);
  assert.doesNotMatch(JSON.stringify(open.schema), /channel|room|scope|path|folder/i);
});

test("a file attached in another room is simply not among the candidates", async () => {
  // The engine only ever offers this function the messages of the ONE
  // conversation the turn is in, so a file from elsewhere cannot be picked even
  // by its exact name. Nothing is fetched at all.
  const goa = [msg(1, "villa quote", { attachments: [file("quote.txt")] })];
  const store = hub({ "at_salaries.csv": Buffer.from("everyone's pay") });
  const answer = await openAttachmentInConversation(goa, "salaries.csv", store.fetch);
  assert.equal(answer.found, false);
  assert.deepEqual(store.asked, [], "the hub was asked for a file from another room");
  assert.ok(!answer.found && answer.why.includes("quote.txt"),
    "the refusal should name what IS here, so he can act on it");
});

test("a file on a deleted message goes with the message", async () => {
  const room = [msg(1, "oops", {
    attachments: [file("draft.txt")], deletedAt: 2_000,
  })];
  const store = hub({ "at_draft.txt": Buffer.from("the withdrawn draft") });
  const answer = await openAttachmentInConversation(room, "draft.txt", store.fetch);
  assert.equal(answer.found, false);
  assert.deepEqual(store.asked, [], "a deleted message's file was still fetched");
});

test("a ticket dies with its turn — a stale one opens nothing at all", async (t) => {
  const bridge = new ToolBridge();
  await bridge.start();
  t.after(() => bridge.stop());
  const opened: string[] = [];
  const ticket = bridge.openTurn({
    channelId: "c_goa",
    search: async () => ({ hits: [], hasMore: false }),
    openAttachment: async name => {
      opened.push(name);
      return { found: true, as: "words" as const, name, text: "…", truncated: false };
    },
  })!;
  ticket.close();

  const res = await fetch(ticket.url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cloud9-turn": ticket.secret },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "tools/call",
      params: { name: "open_attachment", arguments: { name: "quote.txt" } },
    }),
  });
  assert.equal(res.status, 403);
  assert.deepEqual(opened, [], "a finished turn's ticket still opened a file");
});

// -------------------------------------------------- WHICH FILE DID IT MEAN

test("the name is matched the way a person would match it, and the newest wins", () => {
  const room = [
    msg(1, "first go", { attachments: [file("Budget Q3.csv", "at_old")] }),
    msg(2, "corrected", { attachments: [file("budget q3.csv", "at_new")] }),
  ];
  const files = filesInConversation(room);
  assert.equal(files.length, 2);
  // newest first, so re-attaching a corrected file under the same name wins
  const found = findAttachment(files, "BUDGET   Q3.CSV");
  assert.equal(found?.attachment.id, "at_new",
    "the agent would have answered from the version he replaced");
});

// -------------------------------------------------- THE THREE HONEST REFUSALS

test("a file that is neither words nor showable names ITSELF, never mojibake", async () => {
  // A .docx is a zip. It cannot be read as words and cannot be shown as a
  // picture, so the sentence has to carry the one thing the agent can honestly
  // say: WHAT IT IS. Before anything sniffed the bytes this sentence offered the
  // model a menu of guesses — "a picture, a PDF or another packed format".
  const room = [msg(1, "the contract", { attachments: [file("contract.docx")] })];
  const store = hub({ "at_contract.docx": Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]) });
  const answer = await openAttachmentInConversation(room, "contract.docx", store.fetch);
  assert.equal(answer.found, false);
  assert.ok(!answer.found && /zip-packed/.test(answer.why),
    "the agent is not told what the file actually is, so it will guess from the name");
  assert.ok(!answer.found && /do not guess at its contents from its name/.test(answer.why));
});

test("bytes decide whether a file is words — not the type the sender claimed", () => {
  assert.equal(asWords(Buffer.from("plain words, ₹40,000, café")), "plain words, ₹40,000, café");
  assert.equal(asWords(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00])), undefined, "a zip read as words");
  assert.equal(asWords(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x4a])), undefined, "a jpeg read as words");
});

test("a file the hub would not hand over is admitted to, never guessed around", async () => {
  const room = [msg(1, "have a look", { attachments: [file("notes.txt")] })];
  const store = hub({});          // the hub says no — expired, gone, refused
  const answer = await openAttachmentInConversation(room, "notes.txt", store.fetch);
  assert.equal(answer.found, false);
  assert.ok(!answer.found && /rather than answering as if you had/.test(answer.why));
});

test("nothing from underneath ever reaches the model — no path, no error code", async () => {
  const turn: Cloud9ToolTurn = {
    channelId: "c1",
    search: async () => ({ hits: [], hasMore: false }),
    openAttachment: async () => {
      throw new Error("ENOENT at C:\\Users\\Vikas\\cloud9\\cloud9-attachments\\at_9.bin");
    },
  };
  const out = await callCloud9Tool(open, { name: "notes.txt" }, turn);
  assert.equal(out.isError, true);
  assert.doesNotMatch(said(out), /ENOENT|Vikas|cloud9-attachments/);
  assert.match(said(out), /Say so plainly rather than answering as if you had read it/);
});

// -------------------------------------------------- SIZE

test("a file longer than the budget comes back cut, and says it was cut", async () => {
  const room = [msg(1, "the log", { attachments: [file("run.log")] })];
  const huge = "x".repeat(CLOUD9_ATTACHMENT_TEXT_LIMIT + 5_000);
  const store = hub({ "at_run.log": Buffer.from(huge) });
  const answer = await openAttachmentInConversation(room, "run.log", store.fetch);
  assert.equal(answer.found, true);
  assert.ok(answer.found && answer.as === "words" && answer.text.length === CLOUD9_ATTACHMENT_TEXT_LIMIT);
  assert.ok(answer.found && answer.as === "words" && answer.truncated);

  const turn: Cloud9ToolTurn = {
    channelId: "c_goa",
    search: async () => ({ hits: [], hasMore: false }),
    openAttachment: async () => answer,
  };
  const out = await callCloud9Tool(open, { name: "run.log" }, turn);
  assert.match(said(out), /the file is longer than I can read in one go/);
});

// -------------------------------------------------- THE CLASS, NOT THE CASE

test("every Cloud9 tool refuses arguments nobody declared, in its own words", async () => {
  // The guard used to live inside `search_conversation` and to be worded for it,
  // so the second tool would have inherited a sentence about searching or, far
  // more likely, shipped with no guard at all. It is now read off each tool's
  // OWN schema, and each row has to supply its own refusal — so a third tool
  // cannot be added without one.
  const turn: Cloud9ToolTurn = {
    channelId: "c1",
    search: async () => ({ hits: [], hasMore: false }),
    openAttachment: async name => ({ found: true, as: "words" as const, name, text: "…", truncated: false }),
  };
  for (const tool of CLOUD9_TOOLS) {
    assert.ok(tool.refuseExtraArgs.length > 20, `${tool.name} has no refusal sentence`);
    const declared = Object.keys(
      (tool.schema as { properties: Record<string, unknown> }).properties);
    const args: Record<string, unknown> = { channelId: "c_private_hr" };
    for (const d of declared) args[d] = "something";
    const out = await callCloud9Tool(tool, args, turn);
    assert.equal(out.isError, true, `${tool.name} accepted an undeclared argument`);
    assert.match(said(out), /channelId/);
  }
});

// ===================================================================
// GAP 1b: THE AGENT COULD SEE THAT A SCREENSHOT WAS THERE AND NOT SEE IT.
//
// The reproduction, in the owner's shoes: he drags a screenshot or a PDF invoice
// into a room, asks his agent about it, and gets back "it is not a file I can
// read as words". Both CLIs Cloud9 drives take pictures natively, so the bytes
// were reaching the machine and stopping one hop short of the model.
//
// THE ROUTE, AND THE MEASUREMENT BEHIND IT (claude-code 2.1.222, 2026-08-05).
// MCP content blocks, measured against the real installed CLI before a line of
// this was built:
//   • `image` + base64 + mimeType   -> the model named the bands of a PNG it had
//     never been told the colours of. A 3.4 MB one worked too.
//   • `resource` + blob + application/pdf -> the model read an invoice number out
//     of a PDF whose text was Flate-COMPRESSED and provably absent from the raw
//     bytes, so it cannot have come from a base64 text dump. A 9.4 MB one worked.
//   • Anthropic's native `document` block was REFUSED as malformed.
//   • `--file` is `file_id:relative_path` — a Files-API download, not a local
//     attach — so there is no command-line route on the Claude side to compare.
//
// These tests hold the SHAPE that measurement proved, because the shape is the
// whole of the fix: if `open_attachment` stops emitting an image block, the
// screenshot silently stops arriving and the agent goes back to answering about
// a file name, with no error anywhere.
// ===================================================================

/** The smallest real PNG signature. Sniffing reads bytes, so bytes are what tests give it. */
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("IHDR-ish body"),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF-ish body")]);
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from("body")]);

/** A turn whose `openAttachment` is the real one, over a fake hub. */
function room(name: string, bytes: Buffer): Cloud9ToolTurn {
  const messages = [msg(1, "have a look at this", { attachments: [file(name)] })];
  return {
    channelId: "c_goa",
    search: async () => ({ hits: [], hasMore: false }),
    openAttachment: async wanted => openAttachmentInConversation(
      messages, wanted, async a => (a.id === `at_${name}` ? bytes : undefined)),
  };
}

test("gap 1b: a screenshot actually REACHES THE MODEL as a picture", async () => {
  // THE FAILING CASE. Before this, the same call returned isError with "it is
  // not a file I can read as words" and no image block existed to assert on.
  const out = await callCloud9Tool(open, { name: "screenshot.png" }, room("screenshot.png", PNG));
  assert.notEqual(out.isError, true, "the screenshot was refused instead of shown");

  const image = out.content.find(c => c.type === "image");
  assert.ok(image, "no image block — the picture never left Cloud9, so the agent cannot see it");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, PNG.toString("base64"),
    "the bytes on the wire are not the bytes of the file he attached");

  // and the words that travel WITH it name the file, so an agent with two
  // screenshots open can say which one it is looking at
  assert.match(said(out), /screenshot\.png/);
  assert.match(said(out), /PNG picture/);
});

test("gap 1b: a PDF reaches the model as a document, in MCP's vocabulary", async () => {
  // `resource` and not Anthropic's `document`: measured 2026-08-05, the native
  // document block came back "malformed data" from the real CLI and this one
  // came back with the invoice read correctly.
  const out = await callCloud9Tool(open, { name: "invoice.pdf" }, room("invoice.pdf", PDF));
  assert.notEqual(out.isError, true);
  const res = out.content.find(c => c.type === "resource");
  assert.ok(res, "no resource block — the PDF never left Cloud9");
  assert.equal(res.resource.mimeType, "application/pdf");
  assert.equal(res.resource.blob, PDF.toString("base64"));
  // THE URI IS NOT A PATH. There is no file behind it; a file:// uri would be an
  // invitation to go looking for one.
  assert.doesNotMatch(res.resource.uri, /^file:/);
  assert.match(res.resource.uri, /^cloud9:\/\/attachment\//);
});

test("a PDF is a PDF even when its bytes would decode as words", async () => {
  // THE ORDERING BUG THIS CLOSES. A small uncompressed PDF has no NUL byte and
  // decodes cleanly as UTF-8, so the words test ACCEPTED one and handed the
  // model a page of `BT /F1 18 Tf ...` PostScript as though it were the invoice.
  const readable = Buffer.from("%PDF-1.4\nBT /F1 18 Tf (TOTAL 1337) Tj ET\n%%EOF\n");
  assert.ok(asWords(readable) !== undefined, "the premise of this test no longer holds");
  const answer = await openAttachmentInConversation(
    [msg(1, "bill", { attachments: [file("bill.pdf")] })], "bill.pdf", async () => readable);
  assert.ok(answer.found && answer.as === "document",
    "the PDF was handed over as fake 'words' — the model would summarise PostScript");
});

test("the kind comes from the BYTES, never from the name", () => {
  // A screenshot saved as notes.txt is still a screenshot; a text file called
  // photo.png is still text. Nothing here has ever seen a file name.
  assert.equal(sniffKind(PNG)?.mimeType, "image/png");
  assert.equal(sniffKind(JPEG)?.mimeType, "image/jpeg");
  assert.equal(sniffKind(Buffer.from("GIF89a...."))?.mimeType, "image/gif");
  assert.equal(sniffKind(Buffer.concat([
    Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]))?.mimeType, "image/webp");
  assert.equal(sniffKind(PDF)?.mimeType, "application/pdf");
  // the four image types are exactly the four that can be shown — a BMP or a
  // TIFF is refused with a sentence, not sent upstream to fail there
  assert.equal(sniffKind(Buffer.from("BM....")), undefined);
  assert.equal(sniffKind(Buffer.from("just a text file")), undefined);
});

test("a picture too big to be shown is admitted to, with its size, never sent", async () => {
  // A 50 MB photo must not blow up a turn. It never becomes a base64 string at
  // all: the cap is checked on the RAW bytes, before the 4-for-3 encoding is paid.
  const huge = Buffer.concat([PNG, Buffer.alloc(CLOUD9_IMAGE_BYTES_LIMIT)]);
  const out = await callCloud9Tool(open, { name: "holiday.png" }, room("holiday.png", huge));
  assert.equal(out.isError, true);
  assert.match(said(out), /PNG picture/, "he is not even told what kind of file it was");
  assert.match(said(out), /MB/, "the sentence has to carry the size, or he cannot act on it");
  assert.equal(out.content.find(c => c.type === "image"), undefined,
    "an oversized picture was put on the wire anyway");
});

test("a picture right up to the cap still goes", async () => {
  const atCap = Buffer.concat([PNG, Buffer.alloc(CLOUD9_IMAGE_BYTES_LIMIT - PNG.length)]);
  assert.equal(atCap.length, CLOUD9_IMAGE_BYTES_LIMIT);
  const out = await callCloud9Tool(open, { name: "wide.png" }, room("wide.png", atCap));
  assert.notEqual(out.isError, true, "the cap is off by one and refuses a legal picture");
  assert.ok(out.content.find(c => c.type === "image"));
});

test("the PDF cap cannot drift away from the hub's own ceiling", () => {
  // Deriving it is the point: a second number here could only ever refuse a file
  // the hub was happy to serve, which is the drift `WS_LIMITS` already exists to
  // stop. Nothing bigger can reach this code anyway.
  assert.equal(CLOUD9_PDF_BYTES_LIMIT, ATTACHMENT_LIMITS.bytes);
  assert.ok(CLOUD9_IMAGE_BYTES_LIMIT * 4 / 3 <= 5_000_000,
    "the image cap no longer fits under the 5 MB per-image ceiling once base64'd");
});

test("a text file still works EXACTLY as it did before pictures existed", async () => {
  // The regression that would hurt most: the doorway that already worked.
  const out = await callCloud9Tool(
    open, { name: "budget-q3.csv" },
    room("budget-q3.csv", Buffer.from("line,amount\nvillas,40000\n")));
  assert.notEqual(out.isError, true);
  assert.match(said(out), /villas,40000/);
  assert.match(said(out), /"budget-q3\.csv", attached in THIS conversation/);
  assert.equal(out.content.length, 1, "a text file grew a block it never had");
  assert.equal(out.content[0].type, "text");
});

test("NOTHING IS WRITTEN ANYWHERE — the bytes never touch a disk", async () => {
  // THE CLEANUP TEST, and it is stronger than a cleanup test: there is nothing
  // to clean up. Materialising the bytes to a temp path was the other candidate
  // route and it loses on every count `cloud9tools.ts` already records — a second
  // copy on disk, `artifacts.ts` sweeping it up and offering the owner his own
  // file back as something the agent "made", a repository turn standing in a
  // worktree rather than in the agent's folder, and needing the `files` switch
  // that reading the room does not. So the "nothing outside its own space
  // without the whole-computer grant" rule is not merely respected here; it
  // cannot be reached. This test fails the moment somebody writes a temp file.
  const fs = await import("node:fs/promises");
  const cwdBefore = new Set(await fs.readdir(process.cwd()));

  await callCloud9Tool(open, { name: "shot.png" }, room("shot.png", PNG));
  await callCloud9Tool(open, { name: "doc.pdf" }, room("doc.pdf", PDF));
  // ...and when the turn THROWS on its way out, which is where a `finally` would
  // have been needed if there were anything to undo.
  const exploding: Cloud9ToolTurn = {
    channelId: "c_goa",
    search: async () => ({ hits: [], hasMore: false }),
    openAttachment: async () => { throw new Error("the turn fell over"); },
  };
  const out = await callCloud9Tool(open, { name: "shot.png" }, exploding);
  assert.equal(out.isError, true);

  const afterCwd = (await fs.readdir(process.cwd())).filter(f => !cwdBefore.has(f));
  assert.deepEqual(afterCwd, [], `something was left in the working folder: ${afterCwd.join(", ")}`);

  // AND THE CLASS, NOT THE CASE. Watching a folder only catches a temp file that
  // is written and left behind; it says nothing about one written and tidied up,
  // and the machine's shared temp folder is churned by everything else running on
  // it, so watching THAT is a flake rather than a guard. The real guarantee is
  // structural and is asserted structurally: neither of the two files on this
  // path may reach a disk at all. The day somebody adds `node:fs` to one of them
  // to materialise the bytes, this fails — which is exactly when the `finally`
  // that would then be required has to be argued for rather than assumed.
  const path = await import("node:path");
  const url = await import("node:url");
  const src = path.join(
    path.dirname(url.fileURLToPath(import.meta.url)), "..", "src");
  for (const owner of ["cloud9tools.ts", "attachmentreach.ts"]) {
    const text = await fs.readFile(path.join(src, owner), "utf8");
    const reaches = text.match(/^import .*"node:(fs|os|child_process)[^"]*"/mu);
    assert.equal(reaches, null,
      `${owner} now reaches a disk (${reaches?.[0]}) — the bytes are being materialised, ` +
      "so the cleanup rule this route was chosen to avoid is back and needs a `finally`");
  }
});

test("a picture from ANOTHER conversation is still refused, exactly as words were", async () => {
  // The boundary does not move because the file got easier to read. The picture
  // is real, the name is exact, and it is not in this room — so it is not a
  // candidate, and the hub is never even asked for it.
  const goa = [msg(1, "villa quote", { attachments: [file("quote.txt")] })];
  const store = hub({ "at_payslip.png": PNG });
  const answer = await openAttachmentInConversation(goa, "payslip.png", store.fetch);
  assert.equal(answer.found, false);
  assert.deepEqual(store.asked, [], "the hub was asked for a picture from another room");

  // and every widening argument is still refused on the image path too
  for (const args of [
    { name: "payslip.png", channelId: "c_private_hr" },
    { name: "payslip.png", path: "C:\\Users\\Vikas\\Pictures\\payslip.png" },
  ]) {
    const out = await callCloud9Tool(open, args, room("payslip.png", PNG));
    assert.equal(out.isError, true, `${JSON.stringify(args)} was not refused`);
    assert.equal(out.content.find(c => c.type === "image"), undefined,
      "a widened open put a picture on the wire");
  }
});

test("the agent is TOLD it can see pictures, or it will say it cannot before trying", () => {
  // The row is the single owner: the tool the harness gets, the description the
  // model reads and the sentence in the prompt all come from it. An agent told
  // only about "the words in the file" answers "I can't see images" without ever
  // calling the tool — which reads in the room as the app being broken.
  assert.match(open.description, /pictures/i);
  assert.match(open.description, /PDF/);
  assert.match(renderCloud9Tools(), /picture/i);
  assert.match(renderCloud9Tools(), /never say you cannot see a picture before you have tried/);
});
