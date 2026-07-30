// Search must match the words people wrote — never the JSON field names that
// hold them. The FTS5 path and the no-FTS5 fallback must agree on that.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Channel, Message } from "@cloud9/shared";
import { Store } from "./store.js";

function fresh(): Store {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-search-"));
  return new Store(path.join(dir, "hub.db"), { ownerToken: "tok-owner" });
}

function put(store: Store, over: Partial<Message> & Pick<Message, "id" | "text">): Message {
  const m: Message = {
    channelId: "ch1",
    authorId: "u1",
    authorName: "Vikas",
    authorKind: "human",
    ts: Number(over.id.replace(/\D/g, "")) || 1,
    ...over,
  };
  store.saveMessage(m);
  return m;
}

const channel = { id: "ch1" } as Channel;

test("the word 'text' matches only messages that actually say text — FTS5 and fallback", () => {
  const store = fresh();
  assert.equal(store.searchIndexed, true, "this machine's SQLite has FTS5 — both paths must run");

  put(store, { id: "m1", text: "please see the attachment", ts: 1 });
  put(store, { id: "m2", text: "the word text appears here", ts: 2 });
  put(store, { id: "m3", text: "nothing special", ts: 3 });

  const idsOf = (q: string) =>
    store.search([channel], q, { limit: 50 }).items.map(x => x.message.id).sort();

  // FTS5 path first
  assert.deepEqual(idsOf("text"), ["m2"],
    "FTS5 must not treat the JSON field name 'text' as a hit");
  assert.deepEqual(idsOf("attachment"), ["m1"],
    "FTS5: a normal word finds the message that said it");

  // Force the LIKE/instr fallback the same Store would use without FTS5
  store.searchIndexed = false;
  assert.deepEqual(idsOf("text"), ["m2"],
    "fallback must search message text only — not raw JSON plumbing");
  assert.deepEqual(idsOf("attachment"), ["m1"],
    "fallback and FTS5 must agree on an ordinary word");

  // And a word that lives only in JSON keys / structure must still miss
  assert.deepEqual(idsOf("authorKind"), [],
    "a JSON field name that nobody wrote must match nothing under the fallback");
});

test("both engines return the same set for an ordinary word", () => {
  const store = fresh();
  put(store, { id: "m10", text: "flight to goa tomorrow", ts: 10 });
  put(store, { id: "m11", text: "train to pune", ts: 11 });
  put(store, { id: "m12", text: "another flight home", ts: 12 });

  const run = () =>
    store.search([channel], "flight", { limit: 50 }).items.map(x => x.message.id).sort();

  const withFts = run();
  store.searchIndexed = false;
  const withoutFts = run();

  assert.deepEqual(withFts, ["m10", "m12"]);
  assert.deepEqual(withoutFts, withFts,
    "FTS5 and the fallback must name the same messages for a normal word");
});
