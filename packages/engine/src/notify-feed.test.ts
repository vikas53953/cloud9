/* The event → notification path, end to end but with no browser.

   This is the "hub side" of a toast: a fact the hub holds (a task, an
   approval, a message, an artifact version) becomes a `NotifyEvent`
   (this file's builders), which is then handed to the SAME
   `decideNotification` the screen calls. Two things are proven together:
     1. each of the four facts maps to a raised notification with the
        right words, and
     2. the gate the screen shares (self / quiet / de-dupe / master-off)
        does the suppressing — there is no second rules path.
*/
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NOTIFY_PREFS,
  decideNotification,
  type NotifyPrefs,
} from "@cloud9/shared/dist/notify.js";
import type { Approval, ArtifactVersion, Message, Task } from "@cloud9/shared";
import {
  approvalEvent,
  artifactEvent,
  jobFinishedEvent,
  mentionEvent,
  type NotifyViewer,
} from "./notify-feed.js";

const ME: NotifyViewer = { id: "u-vikas", agentIds: ["a-scout"] };
const ON: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS, notify: true };
const NOON = new Date(2026, 6, 31, 12, 0, 0, 0);

function msg(p: Partial<Message>): Message {
  return {
    id: "m-1", channelId: "ch-1", authorId: "u-priya", authorName: "Priya",
    authorKind: "human", text: "hey", ts: 1_700_000_000_000, ...p,
  } as Message;
}
function task(p: Partial<Task>): Task {
  return {
    id: "t-1", title: "clean up the logs", requesterId: ME.id, requesterName: "Vikas",
    agentId: "a-sol", channelId: "ch-1", status: "working",
    createdAt: 1, updatedAt: 2, ...p,
  } as Task;
}
function approval(p: Partial<Approval>): Approval {
  return {
    id: "ap-1", agentId: "a-sol", ownerId: ME.id, action: "push a branch to GitHub",
    status: "pending", createdAt: 3, ...p,
  } as Approval;
}
function version(p: Partial<ArtifactVersion>): ArtifactVersion {
  return {
    id: "av-1", version: 1, size: 10, sha256: "x", text: true, storedAs: "s",
    agentId: "a-sol", agentName: "Sol", ownerId: "u-priya", producedAt: 4, ...p,
  } as ArtifactVersion;
}

/* ---------- 1. the four facts each raise, with the right words ---------- */

test("a finished job raises, addressed to the person who asked", () => {
  const ev = jobFinishedEvent(task({ status: "completed", summary: "Archived 3 logs." }), ME, "Sol");
  assert.ok(ev);
  assert.equal(ev.kind, "job_finished");
  assert.equal(ev.title, "Sol finished a job");
  assert.equal(ev.body, "Archived 3 logs.");
  const d = decideNotification(ev, ON, new Set(), NOON);
  assert.equal(d.raise, true);
});

test("a mention raises", () => {
  const ev = mentionEvent(msg({ mentions: [ME.id], text: "can you look @vikas" }), ME);
  assert.ok(ev);
  assert.equal(ev.kind, "mention");
  assert.equal(ev.title, "Priya mentioned you");
  assert.equal(decideNotification(ev, ON, new Set(), NOON).raise, true);
});

test("a mention of one of my agents counts as a mention of me", () => {
  const ev = mentionEvent(msg({ mentions: ["a-scout"] }), ME);
  assert.ok(ev);
  assert.equal(ev.kind, "mention");
});

test("a pending approval raises, only for the owner", () => {
  const ev = approvalEvent(approval({}), ME, "Sol");
  assert.ok(ev);
  assert.equal(ev.kind, "approval_asked");
  assert.equal(ev.title, "Sol needs your OK");
  assert.equal(decideNotification(ev, ON, new Set(), NOON).raise, true);
});

test("a published artifact raises", () => {
  const ev = artifactEvent(version({}), "ch-1", "report.md", ME);
  assert.ok(ev);
  assert.equal(ev.kind, "artifact_published");
  assert.equal(ev.title, "Sol shared a file");
  assert.equal(decideNotification(ev, ON, new Set(), NOON).raise, true);
});

/* ---------- 2. the shared gate does the suppressing ---------- */

test("my own action shows nothing: a job I did not ask for is not my news", () => {
  assert.equal(jobFinishedEvent(task({ status: "completed", requesterId: "u-priya" }), ME), null);
});

test("my own action shows nothing: a file my own agent published is self-suppressed", () => {
  const ev = artifactEvent(version({ ownerId: ME.id }), "ch-1", "report.md", ME);
  assert.ok(ev, "the event is still built");
  const d = decideNotification(ev, ON, new Set(), NOON);
  assert.equal(d.raise, false);
  assert.equal(d.raise === false && d.reason, "self");
});

test("my own action shows nothing: my own message never becomes a mention", () => {
  assert.equal(mentionEvent(msg({ authorId: ME.id, mentions: [ME.id] }), ME), null);
});

test("quiet hours silence a real event", () => {
  const quiet: NotifyPrefs = { ...ON, quietOn: true, quietFrom: "22:00", quietTo: "08:00" };
  const ev = mentionEvent(msg({ mentions: [ME.id] }), ME);
  assert.ok(ev);
  const night = new Date(2026, 6, 31, 23, 30, 0, 0);
  const d = decideNotification(ev, quiet, new Set(), night);
  assert.equal(d.raise, false);
  assert.equal(d.raise === false && d.reason, "quiet_hours");
});

test("a duplicate does not stack: the same subject twice raises once", () => {
  const ev = mentionEvent(msg({ mentions: [ME.id] }), ME);
  assert.ok(ev);
  const seen = new Set<string>();
  const first = decideNotification(ev, ON, seen, NOON);
  assert.equal(first.raise, true);
  seen.add(first.key);
  const second = decideNotification(ev, ON, seen, NOON);
  assert.equal(second.raise, false);
  assert.equal(second.raise === false && second.reason, "duplicate");
});

test("master switch off silences every kind", () => {
  const off: NotifyPrefs = { ...DEFAULT_NOTIFY_PREFS, notify: false };
  const ev = approvalEvent(approval({}), ME, "Sol");
  assert.ok(ev);
  assert.equal(decideNotification(ev, off, new Set(), NOON).raise, false);
});

/* ---------- builders reject facts that are not for this viewer ---------- */

test("a non-terminal job is not an event", () => {
  assert.equal(jobFinishedEvent(task({ status: "working" }), ME), null);
});

test("an approval I cannot answer is not my event", () => {
  assert.equal(approvalEvent(approval({ ownerId: "u-priya" }), ME), null);
});

test("a message that mentions nobody is not an event", () => {
  assert.equal(mentionEvent(msg({ mentions: [] }), ME), null);
});
