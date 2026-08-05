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
import { Attachment, Message } from "@cloud9/shared";
import {
  asWords, filesInConversation, findAttachment, openAttachmentInConversation,
} from "./attachmentreach.js";
import {
  callCloud9Tool, CLOUD9_TOOLS, CLOUD9_ATTACHMENT_TEXT_LIMIT, cloud9ToolNames,
  Cloud9ToolTurn, renderCloud9Tools,
} from "./cloud9tools.js";
import { ToolBridge } from "./toolbridge.js";
import { claudeArgs } from "./claude-cli.js";
import { renderConversation } from "./context.js";
import { AgentAbilities, AgentDef } from "@cloud9/shared";

const open = CLOUD9_TOOLS.find(t => t.name === "open_attachment")!;

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
  assert.ok(answer.found && answer.text.includes("villas,40000"),
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
      return { found: true, name, text: "…", truncated: false };
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
    assert.match(out.content[0].text, /only open a file attached in the conversation you are in/);
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
      return { found: true, name, text: "…", truncated: false };
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

test("a file that is not words is refused with a sentence, never with mojibake", async () => {
  const room = [msg(1, "the scan", { attachments: [file("invoice.pdf")] })];
  const store = hub({ "at_invoice.pdf": Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02]) });
  const answer = await openAttachmentInConversation(room, "invoice.pdf", store.fetch);
  assert.equal(answer.found, false);
  assert.ok(!answer.found && /cannot read what is inside it/.test(answer.why));
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
  assert.doesNotMatch(out.content[0].text, /ENOENT|Vikas|cloud9-attachments/);
  assert.match(out.content[0].text, /Say so plainly rather than answering as if you had read it/);
});

// -------------------------------------------------- SIZE

test("a file longer than the budget comes back cut, and says it was cut", async () => {
  const room = [msg(1, "the log", { attachments: [file("run.log")] })];
  const huge = "x".repeat(CLOUD9_ATTACHMENT_TEXT_LIMIT + 5_000);
  const store = hub({ "at_run.log": Buffer.from(huge) });
  const answer = await openAttachmentInConversation(room, "run.log", store.fetch);
  assert.equal(answer.found, true);
  assert.ok(answer.found && answer.text.length === CLOUD9_ATTACHMENT_TEXT_LIMIT);
  assert.ok(answer.found && answer.truncated);

  const turn: Cloud9ToolTurn = {
    channelId: "c_goa",
    search: async () => ({ hits: [], hasMore: false }),
    openAttachment: async () => answer,
  };
  const out = await callCloud9Tool(open, { name: "run.log" }, turn);
  assert.match(out.content[0].text, /the file is longer than I can read in one go/);
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
    openAttachment: async name => ({ found: true, name, text: "…", truncated: false }),
  };
  for (const tool of CLOUD9_TOOLS) {
    assert.ok(tool.refuseExtraArgs.length > 20, `${tool.name} has no refusal sentence`);
    const declared = Object.keys(
      (tool.schema as { properties: Record<string, unknown> }).properties);
    const args: Record<string, unknown> = { channelId: "c_private_hr" };
    for (const d of declared) args[d] = "something";
    const out = await callCloud9Tool(tool, args, turn);
    assert.equal(out.isError, true, `${tool.name} accepted an undeclared argument`);
    assert.match(out.content[0].text, /channelId/);
  }
});
