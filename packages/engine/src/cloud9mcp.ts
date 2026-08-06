// Cloud9's MCP server, as the harness sees it: a program on stdio.
//
// It is DELIBERATELY DUMB. It knows no tools, no conversation and no rules — it
// reads a JSON-RPC line, posts it to the engine's per-turn bridge with the
// ticket it was handed, and writes back what comes home. Every decision about
// what may be reached is made in the engine, where the conversation is known.
//
// Why that matters: this process is spawned by the harness, which is running a
// model. A rule enforced HERE would be a rule sitting inside the blast radius.
// The only thing this file can leak is a ticket that is worthless once the turn
// it belongs to has ended.
//
// Run as: node dist/cloud9mcp.js   with CLOUD9_TOOL_URL and CLOUD9_TOOL_SECRET.
import readline from "node:readline";

export interface McpProxyIo {
  url: string;
  secret: string;
  send(line: string): void;
  fetchImpl?: typeof fetch;
}

/** One line in, at most one line out. Exported so a test can drive it. */
export async function proxyLine(line: string, io: McpProxyIo): Promise<void> {
  const text = line.trim();
  if (!text) return;
  let id: unknown = null;
  try { id = (JSON.parse(text) as { id?: unknown }).id ?? null; } catch { /* answered below */ }
  const doFetch = io.fetchImpl ?? fetch;
  try {
    const res = await doFetch(io.url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cloud9-turn": io.secret },
      body: text,
    });
    // 202 WITH NO BODY is the bridge saying "that was a notification" — MCP
    // wants silence, and reading a body that is not there would land in the
    // catch below and look like the engine had gone. (It used to answer every
    // notification with the four letters `null`, which this line then dropped.
    // Harmless here; fatal for an MCP client speaking to the bridge directly,
    // which is why the bridge stopped doing it — see `toolbridge.ts`.)
    if (res.status === 202) return;
    const answer = (await res.json()) as unknown;
    if (answer !== null && answer !== undefined) io.send(JSON.stringify(answer));
  } catch {
    // The engine has gone, or this ticket has expired with its turn. Answering
    // with an error is what lets the model carry on and say it could not search,
    // instead of hanging until the harness's own leash runs out.
    if (id !== null) {
      io.send(JSON.stringify({
        jsonrpc: "2.0", id,
        error: { code: -32000, message: "Cloud9 is not answering tool calls right now" },
      }));
    }
  }
}

export function main(): void {
  const url = process.env.CLOUD9_TOOL_URL;
  const secret = process.env.CLOUD9_TOOL_SECRET;
  if (!url || !secret) {
    console.error("[cloud9-mcp] no ticket — this program is started by Cloud9, not by hand");
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin });
  const io: McpProxyIo = { url, secret, send: line => process.stdout.write(line + "\n") };
  // Lines are answered IN ORDER. A tool call and the `initialize` behind it
  // arriving out of order would look to the harness like a server that never
  // finished starting.
  let chain: Promise<void> = Promise.resolve();
  rl.on("line", line => { chain = chain.then(() => proxyLine(line, io)); });
  rl.on("close", () => { void chain; });
}

// Only when this file IS the program, never when a test imports it.
if (process.argv[1] && /cloud9mcp\.(js|ts)$/.test(process.argv[1])) main();
