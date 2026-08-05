// THE DOORWAY BACK INTO CLOUD9 — the tools Cloud9 itself supplies to an agent.
// One owner: this table is what the agent is TOLD it has, what the harness is
// HANDED, and what actually answers when it is called.
//
// THE WALL THIS OPENS (docs/qa/gap-audit.md §3). An agent is started as a
// one-shot command with a declared list of the harness's OWN built-in tools, and
// Cloud9 supplied none of its own. So there was no way to search the chat, no
// way to open an attachment, no way to read a run record — not even its own from
// five minutes ago. Cloud9's agents wrote a gap analysis saying "search is
// missing" while full-text search sat built, indexed and answering on the hub.
// They were not describing Cloud9; they were describing the slot Cloud9 pushed
// them through.
//
// SEARCH IS THE FIRST DOORWAY because it is the one that is already built. The
// hub answers a `search` frame today over FTS5 — nothing new has to be indexed,
// stored or migrated. And it is the doorway that also closes "no memory": an
// agent that can search the conversation stops needing to be told the same thing
// four times.
//
// THE PERMISSION RULE, and it is the whole of it:
//
//   AN AGENT MAY SEARCH ONLY THE CONVERSATION IT IS TAKING A TURN IN.
//
// That is not a new power and it is not gated behind a switch, because it cannot
// be: every agent, on every rung including "Just talk — no tools at all",
// already receives the recent messages of that room in its prompt. Reading the
// room it is standing in is what a turn IS. Searching the same room is the same
// power, deeper — it reaches further back in a conversation it can already see.
//
// Searching ANY OTHER room is a different power entirely, and it is refused.
// An agent may search only where it may read. The scope is not an argument the
// model can pass: `search_conversation` has exactly one parameter, `query`. The
// conversation is stamped in by the engine when the turn opens and there is no
// spelling of a channel id the model could put anywhere. On top of that the hub
// checks membership again on its own side. Two enforcement points, neither of
// which trusts the other, and a test that proves the first one.

// THE SECOND DOORWAY — OPENING A FILE SOMEBODY ATTACHED (gap 1, 2026-08-05).
//
// The wall, in the owner's shoes: he drags `budget-q3.xlsx` into a room, says
// "what does this say?", and his agent answers about a name. `context.ts` said
// so outright — "AN ATTACHMENT IS NAMED, NEVER OPENED" — because the names were
// carried into the prompt and the bytes were not, and there was no tool with
// which to go and get them.
//
// THE SAME LAW AS SEARCH, WORD FOR WORD:
//
//   AN AGENT MAY OPEN ONLY A FILE ATTACHED IN THE CONVERSATION IT IS TAKING A
//   TURN IN.
//
// and it is enforced the same way, for the same reason: the conversation is
// stamped in by the engine when the turn opens, `open_attachment` has exactly
// one parameter (`name`), and the hub asks its OWN question again when the
// engine goes for the bytes — an attachment ticket is refused unless the owner
// may read the room the file was posted in (`serveAttachment` / `channelFor` in
// the relay). Three gates, none of which trusts the others.
//
// WHY A TOOL RATHER THAN COPYING THE FILE INTO THE AGENT'S FOLDER. Copying was
// the other candidate and it loses on four counts: the bytes would then exist in
// a second place on disk and have to be cleaned up; a file written into the
// agent's folder during a turn is exactly what `artifacts.ts` sweeps up and
// offers back to the room, so his own attachment would come back at him as
// something the agent "made"; a repository turn stands in a worktree, not in the
// agent's folder, so the copy would land somewhere the agent is not; and it
// would need the `files` switch, which reading the room does not. Nothing is
// written anywhere by this doorway — so the "nothing outside its own space
// without the whole-computer grant" rule is not merely respected, it cannot be
// reached.

/** Everything a turn's tool call may reach. Built by the engine, never by the model. */
export interface Cloud9ToolTurn {
  /** THE ONE CONVERSATION this turn may search. Not a default — a boundary. */
  channelId: string;
  /**
   * Ask the hub. The engine supplies this; it can only ever be given the channel
   * above, because nothing else is in scope where it is built.
   */
  search(query: string, limit: number): Promise<Cloud9SearchAnswer>;
  /**
   * Open a file attached in THIS conversation, by the name the room shows.
   *
   * Same shape and same reasoning as `search`: the channel is closed over where
   * this is built, so there is no argument through which a model could name a
   * different room. The engine hands back either the file's words or a plain
   * sentence saying why not — never a path, never an error code.
   */
  openAttachment(name: string): Promise<Cloud9AttachmentAnswer>;
}

export interface Cloud9SearchAnswer {
  hits: { author: string; when: number; text: string }[];
  hasMore: boolean;
}

/**
 * What came back when an agent asked for an attached file.
 *
 * `found: false` is a real answer and carries the sentence the agent should say
 * — "that file is a PDF and I cannot read it as words", "there is nothing
 * called that in this conversation". It is NEVER an error string from
 * underneath: the same law as `sanitizeForChat`, because whatever the model is
 * handed can end up in the room.
 */
export type Cloud9AttachmentAnswer =
  | { found: true; name: string; text: string; truncated: boolean }
  | { found: false; why: string };

/**
 * One tool Cloud9 supplies. Every face of it in one row, for the same reason
 * `Capability` in abilities.ts keeps the switch and the sentence together: a
 * tool the harness is handed and the agent is never told about is a capability
 * that silently never gets used, and a tool the agent is told about and the
 * harness never receives is a lie.
 */
export interface Cloud9Tool {
  /** the bare name inside the Cloud9 MCP server */
  name: string;
  /** the name the harness sees, once MCP has namespaced it */
  toolName: string;
  /** what the model is told the tool does */
  description: string;
  /** JSON Schema for the arguments. NOTHING here may name a conversation. */
  schema: Record<string, unknown>;
  /**
   * WHAT IS SAID WHEN AN ARGUMENT NOBODY DECLARED TURNS UP.
   *
   * On the row, not in the caller, because that is what makes the boundary a
   * CLASS rather than a case. The first version of this check lived inside
   * `search_conversation` and read "you can only search the conversation you are
   * in" — true of that tool and of nothing else, so the second tool would either
   * have inherited a sentence about searching or, far more likely, have quietly
   * shipped with no check at all. A tool cannot be added to this table now
   * without saying what it refuses, because there is nowhere else to write it.
   */
  refuseExtraArgs: string;
  /** the sentence in the agent's own prompt */
  sentence: string;
}

/** The MCP server name. Part of the tool name the harness sees. */
export const CLOUD9_MCP_SERVER = "cloud9";

/** How many hits a search may return in one call. */
export const CLOUD9_SEARCH_LIMIT = 20;

/**
 * How much of an attached file's words one tool call may hand back.
 *
 * 60,000 characters is roughly 15,000 tokens — big enough for a report, a log
 * or a spreadsheet exported as text, and small enough that opening two files
 * cannot swallow the window the conversation itself is budgeted out of
 * (`CONVERSATION_BUDGET` in context.ts, 24,000). A file longer than this comes
 * back with its FIRST 60,000 characters and a line saying it was cut, because
 * the alternative — refusing it — leaves the agent answering about a file it
 * was told exists and cannot see, which is the exact bug this doorway closes.
 */
export const CLOUD9_ATTACHMENT_TEXT_LIMIT = 60_000;

export const CLOUD9_TOOLS: readonly Cloud9Tool[] = [
  {
    name: "search_conversation",
    toolName: `mcp__${CLOUD9_MCP_SERVER}__search_conversation`,
    description:
      "Search the full history of THIS conversation for words that were said earlier — " +
      "further back than the recent messages you were given. Returns who said it, when, " +
      "and what they said. It searches this conversation only; there is no way to search " +
      "any other conversation, and asking for one is not possible.",
    schema: {
      type: "object",
      // ONE property, on purpose. There is no `channel`, no `room`, no `scope`
      // and no `all` — a boundary you can argue with is not a boundary.
      properties: {
        query: {
          type: "string",
          description: "the words to look for, as you would type them into a search box",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    refuseExtraArgs:
      "You can only search the conversation you are in. `search_conversation` takes " +
      "the words to look for and nothing else — there is no way to search another " +
      "conversation from here",
    sentence:
      "You CAN search the earlier history of THIS conversation with " +
      "`search_conversation` — use it before saying you do not remember something, " +
      "because it very likely was said and has simply scrolled out of the messages " +
      "below. It reaches this conversation only, never any other one.",
  },
  {
    name: "open_attachment",
    toolName: `mcp__${CLOUD9_MCP_SERVER}__open_attachment`,
    description:
      "Open a file somebody attached to a message in THIS conversation and read what is " +
      "in it. Give the file name exactly as it appears in the conversation — for example " +
      "budget-q3.xlsx. Returns the words in the file. It reaches only files attached in " +
      "this conversation; there is no way to open a file from any other conversation, or " +
      "anything else on this computer, and asking for one is not possible.",
    schema: {
      type: "object",
      // ONE property, for the same reason `search_conversation` has one: there
      // is no `channel`, no `path` and no `id`. A file name is not a location,
      // so nothing here can be pointed at the disk.
      properties: {
        name: {
          type: "string",
          description: "the file's name, exactly as the conversation shows it",
        },
      },
      required: ["name"],
      additionalProperties: false,
    },
    refuseExtraArgs:
      "You can only open a file attached in the conversation you are in. " +
      "`open_attachment` takes the file's name and nothing else — there is no way to " +
      "open a file from another conversation, and no way to name a place on this " +
      "computer",
    sentence:
      "You CAN open a file somebody attached in THIS conversation with " +
      "`open_attachment` — give it the file name the conversation shows. When a message " +
      "below says files are attached to it, that is a file you can actually read, so " +
      "open it rather than answering from its name. It reaches attached files in this " +
      "conversation only — never another conversation, and never anything else on this " +
      "computer.",
  },
] as const;

/** The tool names the harness is handed. The same list the sentences come from. */
export function cloud9ToolNames(): string[] {
  return CLOUD9_TOOLS.map(t => t.toolName);
}

/**
 * The paragraph in the prompt. Written from the table, so a tool cannot be
 * handed to the harness without the agent being told it exists.
 */
export function renderCloud9Tools(): string {
  return (
    `\nWhat Cloud9 itself gives you (these are Cloud9's own tools, not your harness's):\n` +
    CLOUD9_TOOLS.map(t => `• ${t.sentence}`).join("\n") + "\n"
  );
}

// ---------------------------------------------------------------------------
// The MCP side. Cloud9 speaks the small part of MCP a one-shot tool server
// needs — `initialize`, `tools/list`, `tools/call` — over JSON-RPC. It is kept
// as a PURE FUNCTION of (request, turn) so the boundary can be tested without a
// process, a socket or a harness anywhere near it.
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** The MCP protocol version this server answers with. */
export const CLOUD9_MCP_PROTOCOL = "2024-11-05";

/**
 * Answer one JSON-RPC request. `undefined` means "this was a notification —
 * say nothing", which is what MCP expects for `notifications/initialized`.
 */
export async function answerCloud9Rpc(
  req: JsonRpcRequest, turn: Cloud9ToolTurn,
): Promise<JsonRpcResponse | undefined> {
  const id = req.id ?? null;
  const reply = (result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });

  switch (req.method) {
    case "initialize":
      return reply({
        protocolVersion: CLOUD9_MCP_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: CLOUD9_MCP_SERVER, version: "1" },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return undefined;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({
        tools: CLOUD9_TOOLS.map(t => ({
          name: t.name, description: t.description, inputSchema: t.schema,
        })),
      });
    case "tools/call": {
      const name = String(req.params?.name ?? "");
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      const tool = CLOUD9_TOOLS.find(t => t.name === name);
      if (!tool) {
        return reply(refusal(`Cloud9 has no tool called "${name}".`));
      }
      return reply(await callCloud9Tool(tool, args, turn));
    }
    default:
      return { jsonrpc: "2.0", id, error: { code: -32601, message: "no such method" } };
  }
}

/**
 * Run one tool. Everything a tool is allowed to reach comes from `turn`, which
 * the model never touches — so however the arguments are phrased, forged or
 * injected, they cannot widen where this looks.
 */
export async function callCloud9Tool(
  tool: Cloud9Tool, args: Record<string, unknown>, turn: Cloud9ToolTurn,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  // ARGUMENTS NOBODY DECLARED ARE REFUSED, NOT IGNORED, FOR EVERY TOOL.
  //
  // Ignoring them would answer a question about another room with this room's
  // answer, and the agent would report it as the truth. The list of what is
  // allowed is read off the tool's OWN schema rather than written out beside
  // the check, so a tool cannot grow a parameter here and keep an old guard.
  const widening = Object.keys(args).filter(k => !declaredArgs(tool).has(k));
  if (widening.length > 0) {
    return refusal(`${tool.refuseExtraArgs} (I was given: ${widening.join(", ")}).`);
  }
  if (tool.name === "open_attachment") return openAttachment(args, turn);
  if (tool.name !== "search_conversation") {
    return refusal(`Cloud9 has no tool called "${tool.name}".`);
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) {
    return refusal("Say what to search for — `search_conversation` needs some words.");
  }
  let answer: Cloud9SearchAnswer;
  try {
    answer = await turn.search(query, CLOUD9_SEARCH_LIMIT);
  } catch (err) {
    // The same law as sanitizeForChat: the reason goes to the log, never to the
    // model, because whatever the model is handed can end up in the room.
    console.error("[cloud9-tools] a search failed:", err);
    return refusal("Cloud9 could not run that search just now. Carry on without it, " +
      "and say so rather than guessing at what was said.");
  }
  if (answer.hits.length === 0) {
    return {
      content: [{
        type: "text",
        text: `Nothing in this conversation matches "${query}". That is a real answer — ` +
          `it was not said here.`,
      }],
    };
  }
  const lines = answer.hits.map(h => `[${new Date(h.when).toISOString()}] ${h.author}: ${h.text}`);
  const more = answer.hasMore ? `\n(there are more matches than the ${answer.hits.length} shown)` : "";
  return {
    content: [{
      type: "text",
      text: `Earlier in THIS conversation, matching "${query}":\n${lines.join("\n")}${more}`,
    }],
  };
}

/**
 * OPEN AN ATTACHED FILE. Every reachable thing comes from `turn`, which the
 * model never touches — so the only decision made here is which WORDS to hand
 * back, never which file or which room.
 */
async function openAttachment(
  args: Record<string, unknown>, turn: Cloud9ToolTurn,
): Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }> {
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) {
    return refusal("Say which file to open — `open_attachment` needs the file's name, " +
      "exactly as the conversation shows it.");
  }
  let answer: Cloud9AttachmentAnswer;
  try {
    answer = await turn.openAttachment(name);
  } catch (err) {
    // Same law as the search above: the reason goes to the log, never to the
    // model, because whatever the model is handed can end up in the room.
    console.error("[cloud9-tools] could not open an attachment:", err);
    return refusal("Cloud9 could not open that file just now. Say so plainly rather than " +
      "answering as if you had read it.");
  }
  // A "no" is a REAL ANSWER, not an error the agent should retry around: the
  // file is genuinely not openable, and the agent's job is to say that.
  if (!answer.found) return refusal(answer.why);
  const cut = answer.truncated
    ? `\n\n(this is the first part of "${answer.name}" — the file is longer than I can ` +
      `read in one go, so say so if the answer might be further down.)`
    : "";
  return {
    content: [{
      type: "text",
      text: `"${answer.name}", attached in THIS conversation:\n${answer.text}${cut}`,
    }],
  };
}

/** The argument names a tool declares. Read off its schema, never written twice. */
function declaredArgs(tool: Cloud9Tool): Set<string> {
  const props = (tool.schema as { properties?: Record<string, unknown> }).properties ?? {};
  return new Set(Object.keys(props));
}

function refusal(text: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text }], isError: true };
}

// ---------------------------------------------------------------------------
// The config file the harness is pointed at.
// ---------------------------------------------------------------------------

/** Everything the Cloud9 MCP child needs to reach back into this engine. */
export interface Cloud9McpTicket {
  /** where the engine's per-turn bridge is listening (loopback only) */
  url: string;
  /** a secret minted for THIS turn and thrown away when it ends */
  secret: string;
}

/**
 * The `--mcp-config` document. `node <entry>` with the ticket in the child's own
 * environment — never on a command line, where every process on the machine can
 * read it out of the process list.
 */
export function cloud9McpConfig(entry: string, ticket: Cloud9McpTicket): string {
  return JSON.stringify({
    mcpServers: {
      [CLOUD9_MCP_SERVER]: {
        command: process.execPath,
        args: [entry],
        env: { CLOUD9_TOOL_URL: ticket.url, CLOUD9_TOOL_SECRET: ticket.secret },
      },
    },
  }, null, 2);
}
