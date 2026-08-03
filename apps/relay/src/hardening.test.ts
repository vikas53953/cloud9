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
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import WebSocket from "ws";
import {
  ATTACHMENT_LIMITS, ArtifactVersion, Channel, ClientFrame, Message, RUN_RETENTION, RunRecord, ServerFrame,
  StoredArtifactVersion,
  WS_LIMITS, knownMachineNames, redactForSharing, setMachineNames, shareableRun,
} from "@cloud9/shared";
import { Relay } from "./server.js";
import {
  activityHash, ARTIFACT_STAGE_GRACE_MS, SCHEMA_VERSION, Store, StoreOpenError,
} from "./store.js";
import { TestClient, tmp } from "./testclient.js";

function firstRawAnswer(url: string, frame: ClientFrame | string): Promise<ServerFrame> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => { ws.close(); reject(new Error("timeout waiting for raw answer")); }, 5_000);
    ws.on("open", () => ws.send(typeof frame === "string" ? frame : JSON.stringify(frame)));
    ws.on("message", raw => {
      clearTimeout(timer);
      const answer = JSON.parse(String(raw)) as ServerFrame;
      ws.close();
      resolve(answer);
    });
    ws.on("error", error => { clearTimeout(timer); reject(error); });
  });
}

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

test("pre-auth valid JSON without an own string type is refused without crashing the relay", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import WebSocket from "ws";
    const { Relay } = await import(process.env.CLOUD9_RELAY_MODULE);
    const realJsonParse = JSON.parse.bind(JSON);
    JSON.parse = text => {
      if (text === "inherited-type") {
        return Object.assign(Object.create({ type: "hello" }), {
          token: "tok-owner", client: "desktop", requestId: "req_inherited_type",
        });
      }
      if (text === "inherited-request-id") {
        return Object.assign(Object.create({ requestId: "req_inherited_request" }), { type: 17 });
      }
      return realJsonParse(text);
    };
    const relay = new Relay({ dbPath: process.env.CLOUD9_TEST_DB, ownerToken: "tok-owner" });
    const port = await relay.listen(0);
    const ws = new WebSocket("ws://127.0.0.1:" + port);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const answer = raw => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout after " + raw)), 2_000);
      ws.once("message", data => {
        clearTimeout(timer);
        resolve(JSON.parse(String(data)));
      });
      ws.send(raw);
    });
    const cases = [
      ["null", undefined],
      ["42", undefined],
      ['"text"', undefined],
      ["[]", undefined],
      ["{}", undefined],
      ["inherited-type", "req_inherited_type"],
      ["inherited-request-id", undefined],
      ['{"__proto__":{"type":"hello"},"requestId":"req_proto_payload"}', "req_proto_payload"],
      ['{"type":17,"requestId":"req_non_string_type"}', "req_non_string_type"],
      ['{"type":17,"requestId":17}', undefined],
      ['{"type":17,"requestId":[]}', undefined],
      ['{"type":17,"requestId":"bad..id"}', undefined],
      [JSON.stringify({ type: 17, requestId: "x".repeat(65) }), undefined],
    ];
    for (const [raw, requestId] of cases) {
      const frame = await answer(raw);
      assert.equal(frame.type, "error");
      assert.equal(frame.error, "not authenticated");
      if (requestId === undefined) assert.equal(Object.hasOwn(frame, "requestId"), false);
      else assert.equal(frame.requestId, requestId);
    }
    const welcome = await answer(JSON.stringify({
      type: "hello", token: "tok-owner", client: "desktop",
    }));
    assert.equal(welcome.type, "welcome", "the same process and socket remain usable");
    ws.close();
    relay.close();
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      CLOUD9_RELAY_MODULE: new URL("./server.js", import.meta.url).href,
      CLOUD9_TEST_DB: tmp("hd-preauth-shapes-child.db"),
    },
  });
  assert.equal(child.status, 0,
    `malformed pre-auth JSON must not escape the socket callback\nstdout:\n${child.stdout}\nstderr:\n${child.stderr}`);
});

test("pre-auth invalid hello, invite and join refusals echo their exact request ids", async () => {
  const relay = new Relay({ dbPath: tmp("hd-preauth-request-id.db"), ownerToken: "tok-owner" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;

  const hello = await firstRawAnswer(url, {
    type: "hello", token: "wrong-token", client: "desktop", requestId: "req_bad_hello",
  });
  assert.deepEqual(hello, { type: "error", error: "bad token", requestId: "req_bad_hello" });

  const invite = await firstRawAnswer(url, {
    type: "hello", token: "invite:not-real:Priya", client: "desktop", requestId: "req_bad_invite",
  });
  assert.deepEqual(invite, {
    type: "error", error: "that invite code isn't valid", requestId: "req_bad_invite",
  });

  const join = await firstRawAnswer(url, {
    type: "joinWithToken", token: "join_not-a-real-code", displayName: "Priya",
    requestId: "req_bad_join",
  });
  assert.equal(join.type, "error");
  assert.equal(join.requestId, "req_bad_join");
  assert.match(join.error, /isn't valid|ask for a new one/i,
    "request correlation must not change the join refusal or reveal token details");

  relay.close();
});

test("a reused invite refusal echoes the exact pre-auth request id", async () => {
  const relay = new Relay({ dbPath: tmp("hd-preauth-reused-invite.db"), ownerToken: "tok-owner" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  owner.send({ type: "createInvite" });
  const invitation = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const token = `invite:${invitation.code}:Priya`;
  const firstGuest = new TestClient(url, token);
  await firstGuest.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");

  const reused = await firstRawAnswer(url, {
    type: "hello", token, client: "desktop", requestId: "req_reused_invite",
  });
  assert.deepEqual(reused, {
    type: "error",
    error: "that invite has already been used — ask for a new one",
    requestId: "req_reused_invite",
  });

  firstGuest.close();
  owner.close();
  relay.close();
});

test("pre-auth old no-id refusals stay no-id and unparsed input invents no error", async () => {
  const relay = new Relay({ dbPath: tmp("hd-preauth-no-request-id.db"), ownerToken: "tok-owner" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;

  const old = await firstRawAnswer(url, { type: "hello", token: "wrong-token", client: "desktop" });
  assert.deepEqual(old, { type: "error", error: "bad token" },
    "the old frame gets the same refusal and no invented request id");

  const ws = new WebSocket(url);
  const frames: ServerFrame[] = [];
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error("timeout waiting for welcome")); }, 5_000);
    ws.on("open", () => {
      ws.send("this is not a frame");
      ws.send(JSON.stringify({ type: "hello", token: "tok-owner", client: "desktop" }));
    });
    ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as ServerFrame;
      frames.push(frame);
      if (frame.type === "welcome") { clearTimeout(timer); resolve(); }
    });
    ws.on("error", error => { clearTimeout(timer); reject(error); });
  });
  assert.equal(frames.some(frame => frame.type === "error"), false,
    "input that never parsed into a frame has no request id to echo and invents no error");
  ws.close();
  relay.close();
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

test("the v5 → v6 artifact migration preserves old rows and gives them room access", () => {
  const dbPath = tmp("hd-artifact-v6.db");
  const first = new Store(dbPath, { ownerToken: "tok-owner" });
  const row = first.claimArtifactVersion({ channelId: "ch_old", name: "report.md", at: 10 });
  const version: ArtifactVersion = {
    id: "av_old", version: 1, size: 3, sha256: "a".repeat(64), text: true,
    storedAs: "av_old-report.md", agentId: "a1", agentName: "Scribe", ownerId: "u1",
    producedAt: 10,
  };
  first.saveArtifactVersion(row.id, "ch_old", version);
  first.db.close();

  // Put the file back in the exact schema-5 shape: old rows, no access/link
  // tables and no immutable pair index.
  const old = new DatabaseSync(dbPath);
  old.exec(`
    DROP INDEX av_art_version;
    DROP TABLE artifact_links;
    DROP TABLE artifact_access_users;
    DROP TABLE artifact_access;
    UPDATE meta SET value='5' WHERE key='schemaVersion';
  `);
  old.close();

  const migrated = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(migrated.schemaVersion(), SCHEMA_VERSION);
  assert.deepEqual(migrated.artifactVersionsOf(row.id), [version],
    "the immutable old row is copied nowhere, renumbered nowhere and left unchanged");
  assert.deepEqual(migrated.artifactAccess(row.id), { kind: "room" },
    "absence is the safe compatibility default for every existing chain");
  assert.throws(
    () => migrated.saveArtifactVersion(row.id, "ch_old", { ...version, id: "av_duplicate" }),
    /UNIQUE|constraint/i,
    "the new pair rule is active after the migration",
  );
  migrated.db.close();
});

test("the v5 → v6 duplicate-version migration rolls back and leaves every old row untouched", () => {
  const dbPath = tmp("hd-artifact-v6-duplicate.db");
  const first = new Store(dbPath, { ownerToken: "tok-owner" });
  const row = first.claimArtifactVersion({ channelId: "ch_old", name: "report.md", at: 10 });
  const version: ArtifactVersion = {
    id: "av_old", version: 1, size: 3, sha256: "a".repeat(64), text: true,
    storedAs: "av_old-report.md", agentId: "a1", agentName: "Scribe", ownerId: "u1",
    producedAt: 10,
  };
  first.saveArtifactVersion(row.id, "ch_old", version);
  first.db.close();

  const old = new DatabaseSync(dbPath);
  old.exec(`
    DROP INDEX av_art_version;
    DROP TABLE artifact_links;
    DROP TABLE artifact_access_users;
    DROP TABLE artifact_access;
    UPDATE meta SET value='5' WHERE key='schemaVersion';
  `);
  old.prepare(
    "INSERT INTO artifact_versions(id,artifactId,channelId,agentId,version,producedAt,json) " +
    "VALUES(?,?,?,?,?,?,?)",
  ).run("av_duplicate", row.id, "ch_old", "a1", 1, 11, JSON.stringify({ ...version, id: "av_duplicate" }));
  old.close();

  assert.throws(() => new Store(dbPath, { ownerToken: "tok-owner" }), (e: unknown) => {
    assert.ok(e instanceof StoreOpenError);
    assert.ok((e as Error).message.includes("immutable versions cannot be guessed at"));
    return true;
  });
  const check = new DatabaseSync(dbPath);
  assert.equal((check.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get() as { value: string }).value, "5");
  assert.equal((check.prepare(
    "SELECT COUNT(*) n FROM artifact_versions WHERE artifactId=? AND version=1",
  ).get(row.id) as { n: number }).n, 2, "neither duplicate legacy row was deleted or renumbered");
  check.close();
});

test("startup cleanup cannot delete another live hub's staged publish", () => {
  const dbPath = tmp("hd-artifact-two-hubs.db");
  const publisher = new Store(dbPath, { ownerToken: "tok-owner" });
  const full: StoredArtifactVersion = {
    id: "av_live", version: 1, size: 5, sha256: "a".repeat(64), text: true,
    storedAs: "av_live-report.md", agentId: "a1", agentName: "Scribe", ownerId: "u1",
    producedAt: 10,
  };
  const { version: _number, ...pending } = full;
  const stage = publisher.writeArtifactBytes(full.id, "report.md", Buffer.from("alive"));
  pending.storedAs = stage.storedAs;

  // This exact interleaving used to delete the final bytes: hub A wrote them,
  // hub B started and swept them as orphaned, then hub A inserted the row.
  const starter = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(fs.existsSync(path.join(publisher.artifactsDir, stage.stagedAs)), true,
    "startup ignores a publish-only stage another live process may own");
  starter.db.close();

  const artifact = publisher.appendArtifactVersion({
    channelId: "ch1", name: "report.md", at: 10, version: pending, stage,
  });
  assert.ok(publisher.artifactVersionNumber(artifact.id, 1), "the immutable row committed");
  assert.equal(fs.existsSync(path.join(publisher.artifactsDir, stage.storedAs)), true,
    "and the exact bytes still exist after the deterministic two-hub interleaving");
  publisher.db.close();
});

test("artifact directory flush is after rename, before commit, and failure rolls everything back", () => {
  const dbPath = tmp("hd-artifact-dir-flush.db");
  const store = new Store(dbPath, { ownerToken: "tok-owner" });
  const make = (id: string, at: number) => {
    const full: StoredArtifactVersion = {
      id, version: 1, size: 5, sha256: "a".repeat(64), text: true,
      storedAs: `${id}-report.md`, agentId: "a1", agentName: "Scribe", ownerId: "u1",
      producedAt: at,
    };
    const { version: _number, ...row } = full;
    const stage = store.writeArtifactBytes(id, "report.md", Buffer.from("alive"));
    row.storedAs = stage.storedAs;
    return { row, stage };
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const writable = store as any;
  const realFlush = writable.flushArtifactDirectory.bind(store);
  let sawFlush = false;
  const first = make("av_flush_1", 10);
  writable.flushArtifactDirectory = () => {
    assert.equal(fs.existsSync(path.join(store.artifactsDir, first.stage.storedAs)), true,
      "rename to the final name happened before directory flush");
    const outside = new DatabaseSync(dbPath);
    const visible = (outside.prepare(
      "SELECT COUNT(*) n FROM artifact_versions WHERE id=?",
    ).get(first.row.id) as { n: number }).n;
    outside.close();
    assert.equal(visible, 0, "another connection cannot see the row yet: flush is before COMMIT");
    sawFlush = true;
    realFlush();
  };
  const artifact = store.appendArtifactVersion({
    channelId: "ch1", name: "report.md", at: 10, version: first.row, stage: first.stage,
  });
  assert.equal(sawFlush, true);
  assert.ok(store.artifactVersionNumber(artifact.id, 1), "the row commits after the flush returns");

  const before = store.artifactRow(artifact.id)!;
  const second = make("av_flush_2", 20);
  writable.flushArtifactDirectory = () => { throw new Error("directory flush failed"); };
  assert.throws(() => store.appendArtifactVersion({
    channelId: "ch1", name: "report.md", at: 20, version: second.row, stage: second.stage,
  }), /directory flush failed/);
  writable.flushArtifactDirectory = realFlush;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const after = store.artifactRow(artifact.id)!;
  assert.equal(after.nextVersion, before.nextVersion, "flush failure rolls back the version counter");
  assert.equal(after.updatedAt, before.updatedAt, "flush failure rolls back the list timestamp");
  assert.equal(store.artifactVersionNumber(artifact.id, 2), undefined, "no version row committed");
  assert.equal(fs.existsSync(path.join(store.artifactsDir, second.stage.storedAs)), false,
    "promoted final bytes are compensated after rollback");
  assert.equal(fs.existsSync(path.join(store.artifactsDir, second.stage.stagedAs)), false,
    "no stage litter remains either");
  store.db.close();
});

test("startup reclaims a publish stage whose owning process is gone", () => {
  const dbPath = tmp("hd-artifact-abandoned-stage.db");
  const first = new Store(dbPath, { ownerToken: "tok-owner" });
  fs.mkdirSync(first.artifactsDir, { recursive: true });
  const abandoned =
    `.publishing-v2-99999999-boot_${"a".repeat(22)}-stage_${"b".repeat(22)}-av_dead-report.md`;
  fs.writeFileSync(path.join(first.artifactsDir, abandoned), "never committed");
  first.db.close();

  const reopened = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(fs.existsSync(path.join(reopened.artifactsDir, abandoned)), false,
    "a dead process can never finish its stage, so restart cleanup owns it");
  reopened.db.close();
});

test("a recent v2 stage with this pid but another startup nonce is reclaimed", () => {
  const dbPath = tmp("hd-artifact-reused-pid-recent.db");
  const first = new Store(dbPath, { ownerToken: "tok-owner" });
  fs.mkdirSync(first.artifactsDir, { recursive: true });
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const currentNonce = (first as any).artifactStageNonce as string;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const differentNonce = currentNonce === `boot_${"c".repeat(22)}`
    ? `boot_${"d".repeat(22)}` : `boot_${"c".repeat(22)}`;
  const reused =
    `.publishing-v2-${process.pid}-${differentNonce}-stage_${"e".repeat(22)}-av_recent-report.md`;
  const file = path.join(first.artifactsDir, reused);
  fs.writeFileSync(file, "older startup, reused pid");
  first.db.close();

  const reopened = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(fs.existsSync(file), false,
    "this pid is not enough: a different startup nonce belongs to an abandoned run");
  reopened.db.close();
});

test("an old v2 stage from this pid and this startup nonce is still reclaimed", () => {
  const dbPath = tmp("hd-artifact-current-owner-old.db");
  const store = new Store(dbPath, { ownerToken: "tok-owner" });
  fs.mkdirSync(store.artifactsDir, { recursive: true });
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const currentNonce = (store as any).artifactStageNonce as string;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const name =
    `.publishing-v2-${process.pid}-${currentNonce}-stage_${"j".repeat(22)}-av_old-current-report.md`;
  const file = path.join(store.artifactsDir, name);
  fs.writeFileSync(file, "this process abandoned it past the grace window");
  const old = new Date(Date.now() - ARTIFACT_STAGE_GRACE_MS - 1_000);
  fs.utimesSync(file, old, old);

  store.sweepArtifactOrphans();

  assert.equal(fs.existsSync(file), false,
    "matching pid and nonce protect only a recent in-flight write, never old litter");
  store.db.close();
});

test("another live pid keeps only its recent v2 stage; an old one is reclaimed", () => {
  const dbPath = tmp("hd-artifact-other-live-pid.db");
  const store = new Store(dbPath, { ownerToken: "tok-owner" });
  fs.mkdirSync(store.artifactsDir, { recursive: true });
  const otherPid = process.pid + 100_000;
  const recentName =
    `.publishing-v2-${otherPid}-boot_${"f".repeat(22)}-stage_${"g".repeat(22)}-av_recent-report.md`;
  const oldName =
    `.publishing-v2-${otherPid}-boot_${"h".repeat(22)}-stage_${"i".repeat(22)}-av_old-report.md`;
  const recentFile = path.join(store.artifactsDir, recentName);
  const oldFile = path.join(store.artifactsDir, oldName);
  fs.writeFileSync(recentFile, "another live process is still publishing");
  fs.writeFileSync(oldFile, "the live pid has outlived this abandoned stage");
  const old = new Date(Date.now() - ARTIFACT_STAGE_GRACE_MS - 1_000);
  fs.utimesSync(oldFile, old, old);

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const writable = store as any;
  const realAlive = writable.artifactStageProcessAlive.bind(store);
  writable.artifactStageProcessAlive = (pid: number) => pid === otherPid;
  try {
    store.sweepArtifactOrphans();
  } finally {
    writable.artifactStageProcessAlive = realAlive;
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  assert.equal(fs.existsSync(recentFile), true,
    "another live process keeps its recent stage under the established recent-plus-live rule");
  assert.equal(fs.existsSync(oldFile), false,
    "age always wins: even a live pid cannot protect an old stage");
  store.db.close();
});

test("numeric legacy stages use age only: recent is kept, old is reclaimed", () => {
  const dbPath = tmp("hd-artifact-numeric-legacy.db");
  const first = new Store(dbPath, { ownerToken: "tok-owner" });
  fs.mkdirSync(first.artifactsDir, { recursive: true });
  const legacy = `.publishing-${process.pid}-legacy-stage-report.md`;
  const file = path.join(first.artifactsDir, legacy);
  fs.writeFileSync(file, "legacy numeric name");
  first.db.close();

  const recentOpen = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(fs.existsSync(file), true,
    "numeric legacy names are not guessed to be current pid ownership, but recent age is protected");
  recentOpen.db.close();

  const old = new Date(Date.now() - ARTIFACT_STAGE_GRACE_MS - 1_000);
  fs.utimesSync(file, old, old);
  const oldOpen = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(fs.existsSync(file), false, "old legacy litter is eventually reclaimed");
  oldOpen.db.close();
});

test("malformed publishing names are handled as legacy and never guessed from text", () => {
  const dbPath = tmp("hd-artifact-malformed-stage.db");
  const first = new Store(dbPath, { ownerToken: "tok-owner" });
  fs.mkdirSync(first.artifactsDir, { recursive: true });
  const malformed = `.publishing-v2-${process.pid}-not-a-valid-v2-stage`;
  const file = path.join(first.artifactsDir, malformed);
  fs.writeFileSync(file, "unknown stage");
  first.db.close();

  const recentOpen = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(fs.existsSync(file), true, "recent malformed names are preserved safely");
  recentOpen.db.close();
  const old = new Date(Date.now() - ARTIFACT_STAGE_GRACE_MS - 1_000);
  fs.utimesSync(file, old, old);
  const oldOpen = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.equal(fs.existsSync(file), false, "old malformed names are reclaimed by age only");
  oldOpen.db.close();
});

test("valid JSON with an invalid version shape is recorded and cannot crash orphan cleanup", () => {
  const dbPath = tmp("hd-artifact-malformed.db");
  const first = new Store(dbPath, { ownerToken: "tok-owner" });
  fs.mkdirSync(first.artifactsDir, { recursive: true });
  fs.writeFileSync(path.join(first.artifactsDir, "unknown-final.bin"), "keep until understood");
  first.db.prepare(
    "INSERT INTO artifact_versions(id,artifactId,channelId,agentId,version,producedAt,json) " +
    "VALUES(?,?,?,?,?,?,?)",
  ).run("av_bad", "af_bad", "ch1", "a1", 1, 1, "{}");
  first.db.close();

  const reopened = new Store(dbPath, { ownerToken: "tok-owner" });
  assert.ok(reopened.problems.some(p => p.includes("av_bad") && p.includes("invalid stored shape")));
  assert.equal(fs.existsSync(path.join(reopened.artifactsDir, "unknown-final.bin")), true,
    "one unknown pointer makes cleanup preserve unknown bytes rather than guess");
  reopened.db.close();
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
  db.exec("DELETE FROM search_docs WHERE docId NOT IN (SELECT id FROM messages LIMIT 8)");
  const short = (db.prepare("SELECT COUNT(*) n FROM search_docs").get() as { n: number }).n;
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
