// THE DOORWAY, SPOKEN OVER HTTP — because a second harness now knocks on it.
//
// Cloud9's tool bridge was written for ONE caller: our own MCP child
// (`cloud9mcp.ts`), which reads a line, posts it here, and decides for itself
// whether the answer is worth printing. That let two small untidinesses hide,
// and both of them are real protocol faults the moment an MCP CLIENT talks to
// this listener directly — which is exactly what a Codex turn now does:
//
//  1. A JSON-RPC NOTIFICATION WAS ANSWERED. `notifications/initialized` has no
//     id and must get no reply; the bridge wrote the four letters `null` with a
//     JSON content type. Over stdio the child swallowed it. Over HTTP the body
//     IS the answer, so the Codex MCP client saw a malformed response to the
//     handshake and dropped the server. MEASURED, 2026-08-06, codex-cli
//     0.146.0: with `null`, the client never asked for `tools/list` at all and
//     the agent listed its tools with no Cloud9 ones among them; with an empty
//     202 it went straight on to `tools/list`, then `tools/call`, and printed
//     what `search_conversation` returned.
//
//  2. THE TICKET ONLY HAD ONE SPELLING. Codex authenticates an HTTP MCP server
//     with `Authorization: Bearer …` and offers no way to send a header of our
//     choosing. The bridge read `x-cloud9-turn` and nothing else, so every
//     Codex call would have been a 403.
//
// Neither change loosens the gate: it is the SAME per-turn secret, minted in
// memory, dead when the turn closes. Both tests below fail without the change.
import test from "node:test";
import assert from "node:assert/strict";
import { ToolBridge } from "./toolbridge.js";

async function open() {
  const bridge = new ToolBridge();
  await bridge.start();
  const turn = bridge.openTurn({
    channelId: "c1",
    search: async () => ({ hits: [{ author: "Vikas", when: 1, text: "PINEAPPLE" }], hasMore: false }),
    openAttachment: async () => ({ found: false, why: "nothing attached here" }),
  });
  assert.ok(turn, "the bridge must be listening for any of this to mean anything");
  return { bridge, turn };
}

const post = (url: string, headers: Record<string, string>, body: unknown) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

test("a notification gets no body at all — an MCP client reads `null` as a broken server", async () => {
  const { bridge, turn } = await open();
  try {
    const res = await post(turn.url, { authorization: `Bearer ${turn.secret}` },
      { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(res.status, 202, "accepted, and nothing said");
    assert.equal((await res.text()).trim(), "",
      "this used to be the four letters `null`, and it cost every Codex turn its Cloud9 tools");
  } finally {
    turn.close(); bridge.stop();
  }
});

test("the ticket is accepted in both spellings, and in neither one when it is wrong", async () => {
  const { bridge, turn } = await open();
  try {
    const ask = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const both: Record<string, string>[] = [
      { "x-cloud9-turn": turn.secret },              // Cloud9's own MCP child
      { authorization: `Bearer ${turn.secret}` },    // what Codex sends, not negotiable
    ];
    for (const headers of both) {
      const res = await post(turn.url, headers, ask);
      assert.equal(res.status, 200);
      const answer = await res.json() as { result?: { tools?: { name: string }[] } };
      assert.ok(answer.result?.tools?.some(t => t.name === "search_conversation"));
    }
    const wrong: Record<string, string>[] = [
      {}, { authorization: "Bearer nope" }, { "x-cloud9-turn": "nope" },
      { authorization: turn.secret }, // a bare secret is not a Bearer token
    ];
    for (const headers of wrong) {
      assert.equal((await post(turn.url, headers, ask)).status, 403,
        "a ticket that is not this turn's is no ticket");
    }
  } finally {
    turn.close(); bridge.stop();
  }
});

test("a closed turn's ticket stops working in both spellings", async () => {
  const { bridge, turn } = await open();
  try {
    turn.close();
    const both: Record<string, string>[] = [
      { "x-cloud9-turn": turn.secret },
      { authorization: `Bearer ${turn.secret}` },
    ];
    for (const headers of both) {
      assert.equal(
        (await post(turn.url, headers, { jsonrpc: "2.0", id: 1, method: "tools/list" })).status,
        403, "a copy of the ticket must be worth nothing once the turn has ended");
    }
  } finally {
    bridge.stop();
  }
});
