// THE BRIDGE a Cloud9 tool call crosses to get back into the engine.
//
// The harness spawns Cloud9's MCP server as its own child process, so the tool
// call happens in a process that is not the engine. It needs a way home. This is
// it: a loopback HTTP listener the engine opens, and a TICKET the engine mints
// for one turn.
//
// THREE RULES, and each one is here because the obvious shortcut is worse:
//
//  1. **127.0.0.1 only.** The hub itself refuses to listen on every network by
//     default and this is the same reasoning — a tool doorway that answered the
//     office wifi would be a way into Vikas's conversations from another machine.
//  2. **A per-turn secret, not the relay token.** The alternative was to hand
//     the MCP child the owner's relay token so it could talk to the hub itself.
//     That would have written a durable credential into a JSON file on disk. The
//     ticket here is random, lives in memory, is minted when a turn opens and is
//     forgotten when it closes — a copy of it is worth nothing a minute later.
//  3. **The ticket carries the conversation, and the model never sees it.** What
//     a ticket can reach is decided HERE, when the engine opens the turn. The
//     child forwards words; it cannot forward a scope, because there is nowhere
//     to put one.
import crypto from "node:crypto";
import http from "node:http";
import { answerCloud9Rpc, Cloud9McpTicket, Cloud9ToolTurn, JsonRpcRequest } from "./cloud9tools.js";

/** One open turn. Closing it makes every ticket for it stop working. */
export interface OpenTurn extends Cloud9McpTicket {
  /**
   * THIS TURN'S OWN NAME, and the reason it exists: any file a turn writes must
   * carry it.
   *
   * Two turns for the same agent may run at the same time (the engine's cap is
   * two turns, and it is not per-agent). Both used to write their ticket to one
   * fixed filename in the agent's folder, so the later write replaced the
   * earlier one — and the first turn's tool child then read the SECOND turn's
   * ticket, answering every history search with the other conversation's
   * messages, which the first turn would then quote as fact into its own room.
   * Whichever turn ended first also deleted the file out from under the other.
   *
   * It is deliberately NOT the ticket secret: a filename is visible to anything
   * that can list the folder, and a secret is not.
   */
  id: string;
  close(): void;
}

/** The most a tool call body may be. A tool call is a few words, never a file. */
const MAX_BODY_BYTES = 64 * 1024;

export class ToolBridge {
  private server?: http.Server;
  private turns = new Map<string, Cloud9ToolTurn>();
  private port = 0;

  /** Is the doorway open at all? False until `start()` has finished. */
  get listening(): boolean { return this.port > 0; }

  async start(): Promise<number> {
    if (this.server) return this.port;
    const server = http.createServer((req, res) => void this.onRequest(req, res));
    this.server = server;
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    this.port = typeof addr === "object" && addr ? addr.port : 0;
    return this.port;
  }

  stop(): void {
    this.turns.clear();
    this.server?.close();
    this.server = undefined;
    this.port = 0;
  }

  /**
   * Open the doorway for ONE turn, in ONE conversation.
   *
   * Returns undefined when the bridge is not listening — a turn simply goes
   * without Cloud9's tools rather than failing, and the prompt is built from the
   * same answer, so an agent is never told about a doorway that is not there.
   */
  openTurn(turn: Cloud9ToolTurn): OpenTurn | undefined {
    if (!this.listening) return undefined;
    const secret = crypto.randomBytes(24).toString("hex");
    // A second random value, never derived from the secret: this one is allowed
    // to appear in a filename, and the secret never is.
    const id = crypto.randomBytes(8).toString("hex");
    this.turns.set(secret, turn);
    return {
      url: `http://127.0.0.1:${this.port}/tool`,
      secret,
      id,
      close: () => { this.turns.delete(secret); },
    };
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== "/tool") {
        res.writeHead(404); res.end(); return;
      }
      // The ticket decides everything. An unknown one is not "no scope", it is
      // no answer at all — a stale ticket from a finished turn must not quietly
      // reach a conversation that turn is no longer taking place in.
      const secret = ticketFrom(req.headers);
      const turn = secret ? this.turns.get(secret) : undefined;
      if (!turn) { res.writeHead(403); res.end(); return; }
      const body = await readBody(req);
      if (body === undefined) { res.writeHead(413); res.end(); return; }
      let rpc: JsonRpcRequest;
      try { rpc = JSON.parse(body) as JsonRpcRequest; }
      catch { res.writeHead(400); res.end(); return; }
      const answer = await answerCloud9Rpc(rpc, turn);
      // A NOTIFICATION GETS NO ANSWER AT ALL, and over HTTP that means an empty
      // 202 — not the four letters "null" with a JSON content type.
      //
      // This line used to write `JSON.stringify(answer ?? null)` for everything.
      // Over stdio nobody noticed, because `cloud9mcp.ts` checks for `undefined`
      // and stays silent on our behalf. Over HTTP the body IS the answer, so
      // Codex received `null` as the reply to `notifications/initialized`, took
      // it for a broken server and dropped the connection — measured 2026-08-06:
      // the exact same command line reached `tools/list` against a server that
      // returned 202 and never got past `initialize` against this one. Every
      // Cloud9 tool was silently missing from the turn.
      if (answer === undefined || answer === null) { res.writeHead(202); res.end(); return; }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    } catch (err) {
      console.error("[tool-bridge] could not answer a tool call:", err);
      try { res.writeHead(500); res.end(); } catch { /* the socket already went */ }
    }
  }
}

/**
 * THE TICKET, however the caller was told to send it. One ticket, one meaning,
 * two spellings — because the two harnesses were built by different people:
 *
 *  - `x-cloud9-turn` is what Cloud9's own MCP child sends (`cloud9mcp.ts`); it
 *    is our program and we chose the header.
 *  - `Authorization: Bearer …` is what the Codex CLI sends, and it is not
 *    negotiable: `mcp_servers.<name>.bearer_token_env_var` is the only way to
 *    authenticate an HTTP MCP server there, and it sends that header. Measured
 *    on 0.146.0, 2026-08-06, straight off the wire.
 *
 * NEITHER IS A WEAKER GATE. Both carry the SAME per-turn secret, minted here,
 * held only in memory, and dead the moment the turn closes. This function only
 * says where to read it from.
 */
function ticketFrom(headers: http.IncomingHttpHeaders): string {
  const own = String(headers["x-cloud9-turn"] ?? "");
  if (own) return own;
  const auth = String(headers.authorization ?? "");
  const bearer = /^Bearer\s+(\S+)$/i.exec(auth);
  return bearer ? bearer[1] : "";
}

function readBody(req: http.IncomingMessage): Promise<string | undefined> {
  return new Promise(resolve => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { resolve(undefined); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(undefined));
  });
}
