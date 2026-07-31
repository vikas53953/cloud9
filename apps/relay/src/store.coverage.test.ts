// Lane R — extra Store coverage for behaviours the existing suite exercises
// only through the WebSocket protocol (or not at all): search parity between
// the FTS5 path and its no-FTS5 fallback, the unread count's own boundary
// (`ts > since`, not `>=`), where pruning draws its line, what a role
// transition actually does to the live row versus the ones before it, and the
// two races the attachment store leaves for its CALLER to guard rather than
// guarding itself.
//
// This file never touches store.ts — it only imports the real Store and
// drives it exactly as server.ts does.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  ArtifactVersion, Attachment, Channel, Message, RUN_RETENTION, RunRecord,
} from "@cloud9/shared";
import { Store } from "./store.js";
import { tmp } from "./testclient.js";

function fresh(name: string): Store {
  return new Store(tmp(name), { ownerToken: "tok-owner" });
}

function msg(over: Partial<Message> & Pick<Message, "id" | "channelId" | "ts">): Message {
  return {
    authorId: "u1", authorName: "Vikas", authorKind: "human", text: "hello",
    ...over,
  };
}

const asChannel = (id: string): Channel => ({ id } as Channel);

// ===========================================================================
// 1. Search parity: the FTS5 path and the no-FTS5 fallback must agree on
//    every rule, not just on an ordinary word (search.test.ts already proves
//    that one). These are the rules a parity bug would slip through.
// ===========================================================================

test("search: the author filter agrees between FTS5 and the fallback, on a page boundary", () => {
  const store = fresh("cov-search-author.db");
  assert.equal(store.searchIndexed, true, "this machine's SQLite has FTS5 — both paths must run");
  const ch = asChannel("ch1");

  // Priya's five are the OLDEST, so every one of them sits behind a page of
  // somebody else's newer matches — exactly the shape that broke the fallback
  // for the same reason it once broke FTS5 (hardening.test.ts, #author-filter).
  for (let i = 0; i < 5; i++) {
    store.saveMessage(msg({ id: `m-priya-${i}`, channelId: ch.id, ts: 1000 + i, authorId: "u_priya", authorName: "Priya", text: `flight ${i} to goa` }));
  }
  for (let i = 0; i < 60; i++) {
    store.saveMessage(msg({ id: `m-owner-${i}`, channelId: ch.id, ts: 500_000 + i, text: `flight ${i} to delhi` }));
  }

  const idsOf = () => store.search([ch], "flight", { authorId: "u_priya" }).items.map(x => x.message.id).sort();

  assert.deepEqual(idsOf(), ["m-priya-0", "m-priya-1", "m-priya-2", "m-priya-3", "m-priya-4"],
    "FTS5: the author filter must be IN the query, not applied after the page was cut");

  store.searchIndexed = false;
  assert.deepEqual(idsOf(), ["m-priya-0", "m-priya-1", "m-priya-2", "m-priya-3", "m-priya-4"],
    "the fallback must apply the SAME filter, in the SAME place, for the same result");
});

test("search: a tombstone is invisible to both engines, even with words still in the row", () => {
  const store = fresh("cov-search-tombstone.db");
  const ch = asChannel("ch1");
  // A real delete clears `text`, but the filter that hides a tombstone is
  // `deletedAt IS NULL` — not "text happens to be empty". This proves the
  // rule itself, not an accident of what the caller usually does to a row.
  store.saveMessage(msg({ id: "m1", channelId: ch.id, ts: 1, text: "the vault code is 4471", deletedAt: 5 }));
  store.saveMessage(msg({ id: "m2", channelId: ch.id, ts: 2, text: "nothing about that word here" }));

  const idsOf = () => store.search([ch], "vault", { limit: 50 }).items.map(x => x.message.id);

  assert.deepEqual(idsOf(), [], "FTS5 must not surface a tombstoned row's leftover words");
  store.searchIndexed = false;
  assert.deepEqual(idsOf(), [], "the fallback must refuse the same tombstone the same way");
});

test("search: a query with no real words is an empty page, not a query", () => {
  const store = fresh("cov-search-empty.db");
  const ch = asChannel("ch1");
  store.saveMessage(msg({ id: "m1", channelId: ch.id, ts: 1, text: "anything at all" }));

  for (const q of ["", "   ", "***", "—-—"]) {
    assert.deepEqual(store.search([ch], q), { items: [], hasMore: false },
      `"${q}" has no term FTS5 could even be asked to match`);
    store.searchIndexed = false;
    assert.deepEqual(store.search([ch], q), { items: [], hasMore: false },
      `the fallback must refuse it the same way, not scan every row for nothing`);
    store.searchIndexed = true;
  }
});

test("search: hasMore is decided by asking for one row more than the page — in both engines", () => {
  const store = fresh("cov-search-page.db");
  const ch = asChannel("ch1");
  const size = 3;
  for (let i = 0; i < size; i++) {
    store.saveMessage(msg({ id: `m${i}`, channelId: ch.id, ts: i + 1, text: "goa trip" }));
  }

  const at = () => store.search([ch], "goa", { limit: size });
  assert.equal(at().items.length, size);
  assert.equal(at().hasMore, false, "exactly a page of matches must not claim there is more");

  store.saveMessage(msg({ id: "m-extra", channelId: ch.id, ts: 999, text: "goa trip" }));
  assert.equal(at().items.length, size, "one page, still");
  assert.equal(at().hasMore, true, "one match past the page must say so");

  store.searchIndexed = false;
  assert.equal(at().hasMore, true, "the fallback must draw the same line at the same count");
});

// ===========================================================================
// 2. Unread near the cap — the exact edge of `ts > since`, and what "mine"
//    actually protects.
// ===========================================================================

test("unread: a message AT the read watermark is read; one past it is not", () => {
  const store = fresh("cov-unread-boundary.db");
  const owner = store.ensureOwner("Vikas", "tok-owner");
  store.db.prepare("INSERT INTO users(id,name) VALUES(?,?)").run("u_raj", "Raj");
  store.createChannel({ id: "ch1", name: "general", kind: "channel", memberIds: [owner.id, "u_raj"], createdAt: 1 });

  store.markRead(owner.id, "ch1", 100);
  store.saveMessage(msg({ id: "m-at", channelId: "ch1", ts: 100, authorId: "u_raj", authorName: "Raj" }));
  store.saveMessage(msg({ id: "m-after", channelId: "ch1", ts: 101, authorId: "u_raj", authorName: "Raj" }));

  const entry = store.unreadFor(owner.id, "ch1", new Set([owner.id]));
  assert.equal(entry.unread, 1, "'lastReadTs' means everything AT OR BEFORE it was seen — ts=100 must not count twice");
});

test("unread: mentions only count for ids in `mine`, and an agent's own words never count as unread", () => {
  const store = fresh("cov-unread-mentions.db");
  const owner = store.ensureOwner("Vikas", "tok-owner");
  store.db.prepare("INSERT INTO users(id,name) VALUES(?,?)").run("u_raj", "Raj");
  store.createChannel({ id: "ch1", name: "general", kind: "channel", memberIds: [owner.id, "u_raj"], createdAt: 1 });
  const mine = new Set([owner.id, "agent-scout"]);
  store.markRead(owner.id, "ch1", 0);

  store.saveMessage(msg({ id: "m1", channelId: "ch1", ts: 1, authorId: "u_raj", authorName: "Raj", mentions: ["u_raj"] }));
  store.saveMessage(msg({ id: "m2", channelId: "ch1", ts: 2, authorId: "u_raj", authorName: "Raj", mentions: [owner.id] }));
  store.saveMessage(msg({
    id: "m3", channelId: "ch1", ts: 3, authorId: "agent-scout", authorName: "Scout", authorKind: "agent",
    mentions: [owner.id],
  }));

  const entry = store.unreadFor(owner.id, "ch1", mine);
  assert.equal(entry.unread, 2, "the agent's own turn is 'mine' and must not count as unread");
  assert.equal(entry.mentions, 1, "only the mention of an id in `mine` counts — m1's mention of Raj himself does not");
});

test("unread: read state cannot be pushed backwards by a stale replay", () => {
  const store = fresh("cov-unread-forward.db");
  const owner = store.ensureOwner("Vikas", "tok-owner");
  store.createChannel({ id: "ch1", name: "general", kind: "channel", memberIds: [owner.id], createdAt: 1 });

  assert.equal(store.markRead(owner.id, "ch1", 500), 500);
  assert.equal(store.markRead(owner.id, "ch1", 100), 500, "an older ts from a slow client must not un-read anything");
  assert.equal(store.markRead(owner.id, "ch1", 500), 500, "the same ts again is a no-op, not an error");
  assert.equal(store.lastRead(owner.id, "ch1"), 500);
});

// ===========================================================================
// 3. Retention pruning boundaries: artifact versions and runs.
// ===========================================================================

function version(over: Partial<ArtifactVersion> & Pick<ArtifactVersion, "id" | "version">): ArtifactVersion {
  return {
    size: 1, sha256: "x".repeat(64), text: true, storedAs: `${over.id}-log.md`,
    agentId: "a1", agentName: "Scribe", ownerId: "u1", producedAt: over.version,
    ...over,
  };
}

test("pruneArtifactVersions: exactly at the cap prunes nothing; one past it prunes exactly the oldest", () => {
  const store = fresh("cov-prune-artifacts.db");
  const row = store.claimArtifactVersion({ channelId: "ch1", name: "log.md", at: 1 });
  const keep = 5;
  for (let v = 1; v <= keep; v++) {
    const ver = version({ id: `av${v}`, version: v });
    store.saveArtifactVersion(row.id, "ch1", ver);
    store.writeArtifactBytes(ver.id, "log.md", Buffer.from(`pass ${v}`));
  }

  assert.equal(store.pruneArtifactVersions(row.id, keep), 0, "exactly `keep` versions must not lose one");
  assert.equal(store.artifactVersionsOf(row.id).length, keep);

  // one more arrives, pushing the count to keep+1
  const ver6 = version({ id: "av6", version: 6 });
  store.saveArtifactVersion(row.id, "ch1", ver6);
  store.writeArtifactBytes(ver6.id, "log.md", Buffer.from("pass 6"));

  assert.equal(store.pruneArtifactVersions(row.id, keep), 1, "one over the cap must prune exactly one");
  const left = store.artifactVersionsOf(row.id).map(v => v.version).sort((a, b) => a - b);
  assert.deepEqual(left, [2, 3, 4, 5, 6], "the OLDEST goes, the newest is never touched");
  assert.equal(fs.existsSync(path.join(store.artifactsDir, "av1-log.md")), false,
    "the pruned row's bytes must go with it");
  assert.equal(fs.existsSync(path.join(store.artifactsDir, "av6-log.md")), true);
});

test("pruneArtifactVersions: a cap of zero still keeps the newest — an artifact can never have none", () => {
  const store = fresh("cov-prune-zero.db");
  const row = store.claimArtifactVersion({ channelId: "ch1", name: "log.md", at: 1 });
  for (let v = 1; v <= 3; v++) {
    const ver = version({ id: `av${v}`, version: v });
    store.saveArtifactVersion(row.id, "ch1", ver);
    store.writeArtifactBytes(ver.id, "log.md", Buffer.from(`pass ${v}`));
  }

  const doomed = store.pruneArtifactVersions(row.id, 0);
  assert.equal(doomed, 2, "asking to keep zero still keeps one — the newest");
  const left = store.artifactVersionsOf(row.id);
  assert.equal(left.length, 1);
  assert.equal(left[0].version, 3, "the survivor is the newest, however low the cap");
});

function run(id: string, startedAt: number, taskId?: string): { record: RunRecord; agentId: string; ownerId: string; taskId?: string } {
  return {
    record: {
      id, kind: "task", agentId: "a1", agentName: "Scout", provider: "claude",
      requestedBy: "Vikas", requestedByKind: "human", ask: "do the thing",
      startedAt, finishedAt: startedAt + 1, durationMs: 1, outcome: "ok", steps: [],
    } as unknown as RunRecord,
    agentId: "a1", ownerId: "u1", ...(taskId ? { taskId } : {}),
  };
}

test("pruneRuns: a task sitting exactly at its own cap survives an agent that is otherwise very busy", () => {
  const store = fresh("cov-prune-runs-task.db");
  // the task's own runs — exactly RUN_RETENTION.perTask of them, oldest first
  for (let i = 0; i < RUN_RETENTION.perTask; i++) {
    store.saveRun(run(`r-task-${i}`, i, "t1"));
  }
  // then the agent gets busy with enough OTHER work to evict every one of
  // those from its own per-agent budget on ordinary recency alone
  for (let i = 0; i < RUN_RETENTION.perAgent + 5; i++) {
    store.saveRun(run(`r-chat-${i}`, 10_000 + i));
  }

  assert.equal(store.runsForTask("t1", RUN_RETENTION.listPage).length, RUN_RETENTION.perTask,
    "every one of the task's own runs must still be there — none was spare capacity");
});

test("pruneRuns: a task with one run past ITS OWN cap loses only the oldest of its own", () => {
  const store = fresh("cov-prune-runs-task-over.db");
  const total = RUN_RETENTION.perTask + 1;
  for (let i = 0; i < total; i++) {
    store.saveRun(run(`r-task-${i}`, i, "t1"));
  }
  // push the task's runs out of the agent's own recency window too, so the
  // only thing keeping any of them is the task protection being tested
  for (let i = 0; i < RUN_RETENTION.perAgent; i++) {
    store.saveRun(run(`r-chat-${i}`, 10_000 + i));
  }

  const kept = store.runsForTask("t1", RUN_RETENTION.listPage);
  assert.equal(kept.length, RUN_RETENTION.perTask, "a task is bounded too, just on its own larger budget");
  assert.equal(store.run("r-task-0"), undefined, "the oldest of the task's own runs is the one that goes");
  assert.ok(store.run(`r-task-${total - 1}`), "the newest of the task's own runs survives");
});

test("cap(): a limit outside sane bounds is clamped, never trusted from the caller", () => {
  const store = fresh("cov-cap.db");
  for (let i = 0; i < 5; i++) store.saveRun(run(`r-${i}`, i));

  assert.equal(store.runsForAgent("a1", 1_000_000).length <= RUN_RETENTION.listPage, true,
    "an enormous limit is capped at listPage");
  assert.equal(store.runsForAgent("a1", 0).length, 1, "a limit below 1 still returns at least one row");
  assert.equal(store.runsForAgent("a1", Number.NaN).length, Math.min(5, RUN_RETENTION.listDefault),
    "a limit that isn't a real number falls back to the default page, not zero");
});

// ===========================================================================
// 4. Channel role transitions.
// ===========================================================================

test("role transitions: a role is never inherited across a leave and a rejoin", () => {
  const store = fresh("cov-role-inherit.db");
  store.createChannel({ id: "ch1", name: "ops", kind: "channel", memberIds: [], createdAt: 1 });
  store.addChannelMember("ch1", "u2", { role: "member", at: 10 });
  store.setMemberRole("ch1", "u2", "admin");
  assert.equal(store.memberRole("ch1", "u2"), "admin");

  store.removeChannelMember("ch1", "u2");
  assert.equal(store.memberRole("ch1", "u2"), undefined, "removed means removed — no live role at all");

  // let back in, with no role named — the default, never the old row's role
  store.addChannelMember("ch1", "u2", { at: 20 });
  assert.equal(store.memberRole("ch1", "u2"), "member",
    "being let back in is not the same act as being handed power — that old admin row must not resurrect");

  const rows = store.channelMembers("ch1", { includeRemoved: true });
  const spells = rows.filter(m => m.memberId === "u2");
  assert.equal(spells.length, 2, "two spells in the room, not one row overwritten");
  assert.equal(spells[0].role, "admin", "the FIRST spell's own history is untouched");
  assert.equal(spells[0].removedAt !== undefined, true);
  assert.equal(spells[1].role, "member");
  assert.equal(spells[1].removedAt, undefined);
});

test("role transitions: setMemberRole cannot reach a row that already left", () => {
  const store = fresh("cov-role-dead-row.db");
  store.createChannel({ id: "ch1", name: "ops", kind: "channel", memberIds: [], createdAt: 1 });
  store.addChannelMember("ch1", "u2", { role: "member", at: 10 });
  store.removeChannelMember("ch1", "u2");

  // nothing to promote — the row is dead, and this must be a silent no-op,
  // never an error and never a live row appearing from nowhere
  store.setMemberRole("ch1", "u2", "owner");
  assert.equal(store.memberRole("ch1", "u2"), undefined);
  const dead = store.channelMembers("ch1", { includeRemoved: true }).find(m => m.memberId === "u2")!;
  assert.equal(dead.role, "member", "the historical row must not be rewritten by a role change after death");
});

test("role transitions: many transitions on the SAME live row leave exactly one row behind", () => {
  const store = fresh("cov-role-many.db");
  store.createChannel({ id: "ch1", name: "ops", kind: "channel", memberIds: [], createdAt: 1 });
  store.addChannelMember("ch1", "u2", { role: "member", at: 10 });
  for (const role of ["admin", "owner", "member", "admin"] as const) {
    store.setMemberRole("ch1", "u2", role);
    assert.equal(store.memberRole("ch1", "u2"), role);
  }
  const rows = store.channelMembers("ch1", { includeRemoved: true }).filter(m => m.memberId === "u2");
  assert.equal(rows.length, 1, "a role change is an UPDATE of the live row, never a new spell");
  assert.equal(rows[0].joinedAt, 10, "and it must not disturb when they actually joined");
});

test("role transitions: a rejoin at an already-taken instant steps forward rather than colliding", () => {
  const store = fresh("cov-role-collision.db");
  store.createChannel({ id: "ch1", name: "ops", kind: "channel", memberIds: [], createdAt: 1 });
  store.addChannelMember("ch1", "u2", { at: 500 });
  store.removeChannelMember("ch1", "u2");
  // rejoin at the EXACT same millisecond the first spell used
  store.addChannelMember("ch1", "u2", { at: 500 });

  const spells = store.channelMembers("ch1", { includeRemoved: true }).filter(m => m.memberId === "u2");
  assert.equal(spells.length, 2, "both spells must exist — neither is silently dropped");
  assert.equal(spells[0].joinedAt, 500);
  assert.equal(spells[1].joinedAt, 501, "the second spell stepped forward one millisecond to find a free key");
});

test("role transitions: `at` answers who was in the room at the exact join and leave instants", () => {
  const store = fresh("cov-role-at.db");
  store.createChannel({ id: "ch1", name: "ops", kind: "channel", memberIds: [], createdAt: 1 });
  store.addChannelMember("ch1", "u2", { at: 100 });
  store.removeChannelMember("ch1", "u2", undefined);
  store.db.prepare("UPDATE channel_members SET removedAt=? WHERE channelId=? AND memberId=?").run(200, "ch1", "u2");

  assert.ok(store.channelMembers("ch1", { at: 100 }).some(m => m.memberId === "u2"),
    "present at the exact moment they joined");
  assert.ok(!store.channelMembers("ch1", { at: 99 }).some(m => m.memberId === "u2"),
    "not present one instant before they joined");
  assert.ok(!store.channelMembers("ch1", { at: 200 }).some(m => m.memberId === "u2"),
    "gone at the exact moment they left — removedAt is the first moment they are NOT there");
  assert.ok(store.channelMembers("ch1", { at: 199 }).some(m => m.memberId === "u2"),
    "still there one instant before they left");
});

// ===========================================================================
// 5. Attachment races — what the Store guarantees on its own, and the one
//    guard it deliberately leaves to its caller (server.ts checks
//    `row.messageId` before calling `claimAttachment`; the Store itself does
//    not re-check, which is exactly what this pins down).
// ===========================================================================

function attachment(over: Partial<Attachment> & Pick<Attachment, "id">): Attachment {
  return {
    name: "notes.txt", size: 10, storedAs: `${over.id}-notes.txt`,
    uploadedBy: "u1", uploadedAt: Date.now(),
    ...over,
  };
}

test("attachments: a claim is never undone by a sweep that runs a moment later", () => {
  const store = fresh("cov-att-sweep-race.db");
  const a = attachment({ id: "at1", uploadedAt: 1 }); // old enough to be sweep bait
  store.saveAttachment(a, "ch1");
  store.writeAttachmentBytes(a.id, a.name, Buffer.from("secret"));

  // the send that claims it wins the race against the sweep
  store.claimAttachment(a.id, "m1");
  const swept = store.sweepParkedAttachments(Date.now() + 1_000);
  assert.equal(swept, 0, "a claimed attachment is not 'parked' any more, however old it is");
  assert.ok(store.attachment(a.id), "the row must still be there — it belongs to a message now");
  assert.equal(fs.existsSync(path.join(store.attachmentsDir, a.storedAs)), true,
    "and its bytes must still be on disk");
});

test("attachments: parkedBytes drops the instant a file is claimed — the quota race", () => {
  const store = fresh("cov-att-quota-race.db");
  const a = attachment({ id: "at1", size: 500 });
  store.saveAttachment(a, "ch1");
  assert.equal(store.parkedBytes("u1"), 500, "an unsent file counts against its uploader's quota");

  store.claimAttachment(a.id, "m1");
  assert.equal(store.parkedBytes("u1"), 0, "a sent file is no longer parked — it must not double-count forever");
});

test("attachments: the Store itself does not enforce single-use on a claim — that is the caller's gate", () => {
  const store = fresh("cov-att-claim-overwrite.db");
  const a = attachment({ id: "at1" });
  store.saveAttachment(a, "ch1");

  store.claimAttachment(a.id, "m1");
  assert.equal(store.attachment(a.id)!.messageId, "m1");

  // The Store's own `claimAttachment` has no re-check; server.ts is the one
  // gate ("that file has already been sent"), read from `attachment().messageId`
  // BEFORE calling this. This pins the boundary so a future refactor that
  // moves the claim below the check does not silently rely on a guard that
  // was never here.
  store.claimAttachment(a.id, "m2");
  assert.equal(store.attachment(a.id)!.messageId, "m2",
    "the Store overwrites silently — single-use is enforced by the caller reading messageId first, not by this method");
});

test("attachments: releasing a message's files twice is a no-op the second time, not a crash", () => {
  const store = fresh("cov-att-release-twice.db");
  const a = attachment({ id: "at1" });
  store.saveAttachment(a, "ch1");
  store.claimAttachment(a.id, "m1");
  store.writeAttachmentBytes(a.id, a.name, Buffer.from("x"));

  const first = store.releaseAttachments("m1");
  assert.equal(first.length, 1);
  const second = store.releaseAttachments("m1");
  assert.deepEqual(second, [], "the rows are already gone — a second release must find nothing, not throw");
});

test("attachments: removing bytes that are already gone is not an error — the concurrent-delete case", () => {
  const store = fresh("cov-att-remove-twice.db");
  const a = attachment({ id: "at1" });
  store.writeAttachmentBytes(a.id, a.name, Buffer.from("x"));
  const storedAs = `${a.id}-${a.name}`;

  store.removeAttachmentBytes(storedAs);
  assert.doesNotThrow(() => store.removeAttachmentBytes(storedAs),
    "two concurrent cleanups racing for the same file must not make either of them fail");
});
