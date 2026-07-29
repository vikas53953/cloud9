// THE THINGS THAT BITE THE OWNER WHEN HE NEXT OPENS THE APP.
//
// His live database is still at version 0/1 and will step 2 → 3 → 4 → 5 the
// next time the hub opens it. Everything in this file is about that walk being
// survivable: a step that is interrupted, a row that will not parse, an index
// that was half built, and a backfill that used to guess who he was.
//
// Plus the two quieter ones that make a record lie: a URL that carried a secret
// past the redactor, and a search filter applied after the page had been cut.
//
// Every test here failed before its fix landed.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  ATTACHMENT_LIMITS, Channel, Message, RUN_RETENTION, RunRecord, ServerFrame,
  WS_LIMITS, knownMachineNames, redactForSharing, setMachineNames, shareableRun,
} from "@cloud9/shared";
import { Relay } from "./server.js";
import { activityHash, SCHEMA_VERSION, Store, StoreOpenError } from "./store.js";
import { TestClient, tmp } from "./testclient.js";

// ---------------------------------------------------------------------------
// #2 — redaction is not defeated by its own URL protection
// ---------------------------------------------------------------------------

test("a secret inside a web address is still a secret", () => {
  const before = knownMachineNames();
  setMachineNames(["C:\\Users\\vikasmit", "vikasmit", "VIKAS-PC"]);
  try {
    // the three the reviewer reproduced, verbatim
    const slack = redactForSharing(
      "posting to https://hooks.slack.com/services/T0001/B0002/xoxb-4827-secretpart");
    assert.ok(!slack.includes("xoxb-4827-secretpart"),
      `a Slack token in a URL path must not survive: ${slack}`);

    const anthropic = redactForSharing(
      "called https://api.example.com/v1/run?token=sk-ant-api03-9f8e7d6c5b4a3210zzz&page=2");
    assert.ok(!anthropic.includes("sk-ant-api03-9f8e7d6c5b4a3210zzz"),
      `an API key in a query string must not survive: ${anthropic}`);
    assert.ok(anthropic.includes("page=2"), "and the harmless part of the query is left alone");

    const path = redactForSharing(
      "opened https://sheets.example.com/view?file=C:/Users/vikasmit/Documents/taxes.xlsx");
    assert.ok(!path.includes("Users"), `a file path in a URL must be cut down: ${path}`);
    assert.ok(!path.includes("vikasmit"), "and his account name must not be in it either");
    assert.ok(path.includes("taxes.xlsx"), "the file's own name is what he wanted to see");

    // AND THE PROTECTION IS STILL DOING ITS JOB: an ordinary link survives whole
    const plain = redactForSharing("see https://example.com/news/2026/flights-to-goa for the times");
    assert.ok(plain.includes("https://example.com/news/2026/flights-to-goa"),
      `an ordinary web address is the thing he most wants to see: ${plain}`);
  } finally {
    setMachineNames(before);
  }
});

test("a run record shared with a room carries no secret out of a URL", () => {
  const before = knownMachineNames();
  setMachineNames(["vikasmit"]);
  try {
    const record = {
      id: "r-1", kind: "chat", agentId: "a1", agentName: "Scout", provider: "claude",
      ask: "post it to https://hooks.slack.com/services/T1/B2/xoxb-9911-thesecret",
      startedAt: 1, durationMs: 10, ok: true,
      steps: [{ kind: "web", label: "GET https://x.example/q?api_key=sk-live-abcdef123456", at: 2 }],
    } as unknown as RunRecord;
    const out = shareableRun(record);
    assert.ok(!JSON.stringify(out).includes("xoxb-9911-thesecret"),
      "this is the copy every member of the room can read");
    assert.ok(!JSON.stringify(out).includes("sk-live-abcdef123456"));
  } finally {
    setMachineNames(before);
  }
});

// ---------------------------------------------------------------------------
// #5 / #6 — the walk forward is transactional, resumable and diagnosable
// ---------------------------------------------------------------------------

/** A database written by the build BEFORE any of this — the shape his file is in. */
function oldDatabase(dbPath: string, messages = 30): void {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE channels(id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE messages(id TEXT PRIMARY KEY, channelId TEXT NOT NULL, ts INTEGER NOT NULL, json TEXT NOT NULL);
    CREATE TABLE tokens(token TEXT PRIMARY KEY, userId TEXT NOT NULL);
    CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT NOT NULL, invitedBy TEXT);
  `);
  db.prepare("INSERT INTO channels(id,json) VALUES(?,?)").run("ch_old", JSON.stringify({
    id: "ch_old", name: "general", kind: "channel",
    memberIds: ["u_guest", "u_vikas"], createdAt: 111,
  }));
  for (let i = 0; i < messages; i++) {
    const m = {
      id: `m${i}`, channelId: "ch_old", ts: 1000 + i, text: `flight number ${i} to goa`,
      authorId: i % 2 === 0 ? "u_vikas" : "u_guest", authorName: "x", authorKind: "human",
    };
    db.prepare("INSERT INTO messages(id,channelId,ts,json) VALUES(?,?,?,?)")
      .run(m.id, m.channelId, m.ts, JSON.stringify(m));
  }
  // THE GUEST'S TOKEN IS WRITTEN FIRST, which is the whole point: the old
  // backfill took the first row of `tokens` by rowid and called it the owner.
  db.prepare("INSERT INTO tokens(token,userId) VALUES(?,?)").run("tok-guest", "u_guest");
  db.prepare("INSERT INTO tokens(token,userId) VALUES(?,?)").run("tok-owner", "u_vikas");
  db.prepare("INSERT INTO users(id,name) VALUES(?,?)").run("u_guest", "Raj");
  db.prepare("INSERT INTO users(id,name) VALUES(?,?)").run("u_vikas", "Vikas");
  db.close();
}

test("#13 the migration asks who the owner is instead of guessing from row order", () => {
  const dbPath = tmp("hd-owner.db");
  oldDatabase(dbPath);
  const store = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(store.memberRole("ch_old", "u_vikas"), "owner",
    "the person who runs this Cloud9 runs its rooms — even when a guest signed in first");
  assert.equal(store.memberRole("ch_old", "u_guest"), "member",
    "and a guest is not handed a room because his token happened to be written first");
  store.db.close();
});

test("#6 an interrupted migration step leaves the version where it was, and re-runs", () => {
  const dbPath = tmp("hd-atomic.db");
  oldDatabase(dbPath);

  // Kill the step half way: the membership backfill throws AFTER it has written
  // its rows, which is exactly what a crash or a closed lid looks like. Without
  // a transaction those rows survive and the version does not — the
  // half-migrated state that is worse than no migration at all.
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const proto = Store.prototype as any;
  const original = proto.backfillChannelMembers;
  let exploded = false;
  proto.backfillChannelMembers = function (this: Store) {
    original.call(this);
    exploded = true;
    throw new Error("the lid came down");
  };
  try {
    assert.throws(() => new Store(dbPath, { ownerToken: "tok-owner" }), /lid came down/);
  } finally {
    proto.backfillChannelMembers = original;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
  assert.ok(exploded, "the step really did run before it was interrupted");

  const db = new DatabaseSync(dbPath);
  const version = (db.prepare("SELECT value FROM meta WHERE key='schemaVersion'")
    .get() as { value: string } | undefined)?.value;
  const rows = (db.prepare("SELECT COUNT(*) n FROM channel_members").get() as { n: number }).n;
  db.close();
  assert.notEqual(version, "3", "the version must not claim a step that did not finish");
  assert.equal(rows, 0, "and the rows it had already written must be gone");

  // and the whole thing simply runs again, all the way, on the next open
  const healed = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(healed.schemaVersion(), SCHEMA_VERSION, "it came all the way forward on the retry");
  assert.deepEqual(healed.liveMemberIds("ch_old").sort(), ["u_guest", "u_vikas"]);
  healed.db.close();
});

test("#5 an interrupted search backfill is finished, not left silently short", () => {
  const dbPath = tmp("hd-search.db");
  oldDatabase(dbPath, 30);
  const first = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.ok(first.searchIndexComplete(), "a fresh open indexes everything");
  assert.equal(first.search([{ id: "ch_old" } as Channel], "flight", { limit: 50 }).items.length, 30);
  first.db.close();

  // Exactly the state the reviewer produced: 8 of 30 indexed, no error anywhere.
  const db = new DatabaseSync(dbPath);
  db.exec("DELETE FROM messages_fts WHERE messageId NOT IN (SELECT id FROM messages LIMIT 8)");
  const short = (db.prepare("SELECT COUNT(*) n FROM messages_fts").get() as { n: number }).n;
  db.close();
  assert.equal(short, 8, "the fixture is a half-built index");

  // The old guard was "is the index non-empty", and 8 is not empty — so this
  // database stayed permanently, silently unsearchable for 22 of its messages.
  const second = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.ok(second.searchIndexComplete(), "completeness is the guard, not emptiness");
  assert.equal(second.search([{ id: "ch_old" } as Channel], "flight", { limit: 50 }).items.length, 30,
    "every message is findable again");
  second.db.close();
});

test("#6 one unreadable row is a fault you can read, not a door that is shut forever", () => {
  const dbPath = tmp("hd-parse.db");
  oldDatabase(dbPath, 5);
  const db = new DatabaseSync(dbPath);
  db.prepare("INSERT INTO channels(id,json) VALUES(?,?)").run("ch_bad", "{this is not json");
  db.close();

  const store = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(store.schemaVersion(), SCHEMA_VERSION, "the database still opened");
  assert.deepEqual(store.liveMemberIds("ch_old").sort(), ["u_guest", "u_vikas"],
    "and every OTHER room came across untouched");
  assert.ok(store.problems.some(p => p.includes("ch_bad")),
    `the bad row is named in plain words: ${JSON.stringify(store.problems)}`);
  store.db.close();
});

test("a database this build cannot open at all says which file and why", () => {
  const dbPath = tmp("hd-notadb.db");
  fs.writeFileSync(dbPath, "this is not a database at all, it is a note");
  assert.throws(() => new Store(dbPath), (e: unknown) => {
    assert.ok(e instanceof StoreOpenError, "it is the diagnosable kind of failure");
    assert.ok((e as Error).message.includes(dbPath), "and it names the file");
    return true;
  });
});

// ---------------------------------------------------------------------------
// #7 — `from:` search actually searches
// ---------------------------------------------------------------------------

test("#7 from: finds an author's messages behind more than one page of matches", async () => {
  const dbPath = tmp("hd-from.db");
  const relay = new Relay({ dbPath, ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const general = welcome.state.channels.find(c => c.name === "general")!;

  // 60 matching messages: more than one page. Priya's are the OLDEST, so every
  // one of them sits behind the 51 rows SQL hands back.
  for (let i = 0; i < 5; i++) {
    relay.store.saveMessage({
      id: `m-priya-${i}`, channelId: general.id, ts: 1000 + i,
      authorId: "u_priya", authorName: "Priya", authorKind: "human",
      text: `flight ${i} to goa`,
    } as Message);
  }
  for (let i = 0; i < 60; i++) {
    relay.store.saveMessage({
      id: `m-other-${i}`, channelId: general.id, ts: 500_000 + i,
      authorId: welcome.state.me.id, authorName: "Vikas", authorKind: "human",
      text: `flight ${i} to delhi`,
    } as Message);
  }

  const hits = relay.store.search([general], "flight", { authorId: "u_priya" });
  assert.equal(hits.items.length, 5,
    "the author filter used to be applied AFTER the page had been cut, so this was 0");
  assert.ok(hits.items.every(h => h.message.authorId === "u_priya"));

  owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// #14 / #15 — a job's record, and a trail whose clock cannot run backwards
// ---------------------------------------------------------------------------

test("#14 a busy agent does not delete the record of what a job did", () => {
  const dbPath = tmp("hd-runs.db");
  const store = new Store(dbPath, { ownerToken: "tok-owner" });
  const run = (id: string, startedAt: number, taskId?: string) => ({
    record: { id, kind: "task", agentId: "a1", agentName: "Scout", provider: "claude",
      ask: "do the thing", startedAt, durationMs: 1, ok: true, steps: [] } as unknown as RunRecord,
    agentId: "a1", ownerId: "u1", ...(taskId ? { taskId } : {}),
  });
  // the job happened first, and then the agent did a great deal of other work
  store.saveRun(run("r-job-1", 1, "t1"));
  store.saveRun(run("r-job-2", 2, "t1"));
  for (let i = 0; i < RUN_RETENTION.perAgent + 20; i++) store.saveRun(run(`r-chat-${i}`, 100 + i));

  assert.equal(store.runsForTask("t1").length, 2,
    "opening last week's job must still show what it did — pruning it on the agent's " +
    "budget destroyed the one thing the feature is for");
  assert.ok(store.runsForAgent("a1").length <= RUN_RETENTION.perAgent + RUN_RETENTION.perTask,
    "and the whole thing is still bounded");
  store.db.close();
});

test("#15 a line dated before the one it follows is reported, not verified", () => {
  const dbPath = tmp("hd-ledger.db");
  const store = new Store(dbPath, { ownerToken: "tok-owner" });
  store.logActivity({ actorKind: "human", actorId: "u1", actorName: "Vikas", kind: "message", detail: "one" });
  const second = store.logActivity({
    actorKind: "human", actorId: "u1", actorName: "Vikas", kind: "message", detail: "two" });
  assert.equal(store.verifyActivity(), null, "a freshly written trail hangs together");

  // Back-date the second line and re-hash it so the chain itself is still
  // perfect. The old check verified this happily.
  const backdated = { ...second, ts: 1 };
  backdated.hash = activityHash(backdated);
  store.db.prepare("UPDATE activity SET json=?, ts=?, hash=? WHERE id=?")
    .run(JSON.stringify(backdated), 1, backdated.hash, second.id);

  const problem = store.verifyActivity();
  assert.ok(problem, "time running backwards is exactly what a back-dated entry looks like");
  assert.ok(problem!.problem.includes("dated before"), problem!.problem);
  store.db.close();
});

// ---------------------------------------------------------------------------
// #12 — parked files are bounded
// ---------------------------------------------------------------------------

test("#12 a guest cannot fill the owner's disk with files nobody ever sent", async () => {
  const dbPath = tmp("hd-files.db");
  const relay = new Relay({ dbPath, ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const general = welcome.state.channels.find(c => c.name === "general")!;

  // there IS a ceiling now, and the socket itself carries one too
  assert.ok(ATTACHMENT_LIMITS.parkedBytesPerUser > 0);
  assert.ok(WS_LIMITS.maxPayloadBytes >= ATTACHMENT_LIMITS.bytes,
    "a legal upload must never be dropped by the socket's own limit");
  assert.equal((relay.wss.options as { maxPayload?: number }).maxPayload, WS_LIMITS.maxPayloadBytes,
    "and the hub really is running with it — this used to be unset, so any " +
    "frame of any size was read into memory before anything checked it");

  // fill the quota directly (uploading 50 MB over a socket in a unit test is
  // the same assertion at a hundred times the cost)
  const me = welcome.state.me.id;
  for (let i = 0; i < 6; i++) {
    relay.store.saveAttachment({
      id: `at-${i}`, name: `f${i}.txt`, size: 9_000_000, storedAs: `at-${i}-f${i}.txt`,
      uploadedBy: me, uploadedAt: Date.now(),
    }, general.id);
  }
  assert.equal(relay.store.parkedBytes(me), 54_000_000);

  owner.frames.length = 0;
  owner.send({
    type: "uploadAttachment", channelId: general.id, name: "one-more.txt",
    dataBase64: Buffer.from("more").toString("base64"),
  });
  const err = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(err.error.includes("too many files waiting"), err.error);

  // and a draft nobody ever sent does not live forever
  const reclaimed = relay.store.sweepParkedAttachments(Date.now() + 1);
  assert.equal(reclaimed, 6, "abandoned drafts are reclaimed, bytes and row together");
  assert.equal(relay.store.parkedBytes(me), 0);

  owner.close(); relay.close();
});

test("#12 files cannot be fired at the hub as fast as a script can send them", async () => {
  const dbPath = tmp("hd-rate.db");
  const relay = new Relay({ dbPath, ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const general = welcome.state.channels.find(c => c.name === "general")!;
  const me = welcome.state.me.id;

  for (let i = 0; i < ATTACHMENT_LIMITS.uploadsPerMinute; i++) {
    relay.store.saveAttachment({
      id: `rt-${i}`, name: `f${i}.txt`, size: 10, storedAs: `rt-${i}-f${i}.txt`,
      uploadedBy: me, uploadedAt: Date.now(),
    }, general.id);
  }
  owner.frames.length = 0;
  owner.send({
    type: "uploadAttachment", channelId: general.id, name: "next.txt",
    dataBase64: Buffer.from("x").toString("base64"),
  });
  const err = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(err.error.includes("wait a minute"), err.error);

  owner.close(); relay.close();
});
