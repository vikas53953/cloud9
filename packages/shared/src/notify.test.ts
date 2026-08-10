// Pure notification rules — what raises a toast, quiet hours, de-dupe.
// Proves the Settings quiet-hours shape and the four event kinds.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NOTIFY_PREFS,
  THREAD_REPLY_BODY_MAX,
  chooseDelivery,
  decideNotification,
  dedupeKey,
  inQuietHours,
  isNotifyKind,
  isRoomMuted,
  isThreadParticipant,
  notificationFromEvent,
  notifyTarget,
  threadReplyEvent,
  withRoomMuted,
  type NotifyEvent,
  type NotifyPrefs,
  type ThreadReplyFacts,
} from "./notify.js";

const on: NotifyPrefs = {
  ...DEFAULT_NOTIFY_PREFS,
  notify: true,
};

function evt(partial: Partial<NotifyEvent> & Pick<NotifyEvent, "kind" | "subjectId">): NotifyEvent {
  return {
    recipientId: "u-vikas",
    actorId: "a-scout",
    title: "Scout",
    body: "something happened",
    at: 1_700_000_000_000,
    channelId: "ch-1",
    ...partial,
  };
}

function at(h: number, m = 0): Date {
  return new Date(2026, 6, 31, h, m, 0, 0);
}

/* ---------- quiet hours (matches Settings) ---------- */

test("quiet hours off means never quiet", () => {
  assert.equal(inQuietHours({ quietOn: false, quietFrom: "22:00", quietTo: "08:00" }, at(23)), false);
});

test("same-day quiet window: inside and at the edges", () => {
  const p = { quietOn: true, quietFrom: "13:00", quietTo: "14:00" };
  assert.equal(inQuietHours(p, at(12, 59)), false);
  assert.equal(inQuietHours(p, at(13, 0)), true);
  assert.equal(inQuietHours(p, at(13, 30)), true);
  assert.equal(inQuietHours(p, at(14, 0)), false, "end is exclusive, like Settings");
});

test("overnight quiet window wraps midnight (22:00 → 08:00)", () => {
  const p = { quietOn: true, quietFrom: "22:00", quietTo: "08:00" };
  assert.equal(inQuietHours(p, at(21, 59)), false);
  assert.equal(inQuietHours(p, at(22, 0)), true);
  assert.equal(inQuietHours(p, at(23, 30)), true);
  assert.equal(inQuietHours(p, at(0, 0)), true);
  assert.equal(inQuietHours(p, at(7, 59)), true);
  assert.equal(inQuietHours(p, at(8, 0)), false);
});

test("DEFAULT_NOTIFY_PREFS matches Settings defaults", () => {
  assert.deepEqual(DEFAULT_NOTIFY_PREFS, {
    notify: false,
    quietOn: false,
    quietFrom: "22:00",
    quietTo: "08:00",
    mutedChannelIds: [],
    channelNotificationModes: {},
  });
});

/* ---------- which events raise ---------- */

test("each of the five kinds raises when notifications are on", () => {
  const kinds =
    ["job_finished", "approval_asked", "mention", "artifact_published", "thread_reply"] as const;
  for (const kind of kinds) {
    const d = decideNotification(evt({ kind, subjectId: `s-${kind}` }), on, new Set(), at(12));
    assert.equal(d.raise, true, kind);
    if (d.raise) {
      assert.equal(d.notification.kind, kind);
      assert.equal(d.notification.id, `${kind}:s-${kind}`);
      assert.equal(d.notification.title, "Scout");
      assert.equal(d.notification.body, "something happened");
      assert.equal(d.notification.channelId, "ch-1");
      assert.equal(d.notification.subjectId, `s-${kind}`);
    }
  }
});

test("isNotifyKind names exactly the five raisers", () => {
  assert.equal(isNotifyKind("job_finished"), true);
  assert.equal(isNotifyKind("approval_asked"), true);
  assert.equal(isNotifyKind("mention"), true);
  assert.equal(isNotifyKind("artifact_published"), true);
  assert.equal(isNotifyKind("thread_reply"), true);
  assert.equal(isNotifyKind("message"), false);
  assert.equal(isNotifyKind("push"), false);
  assert.equal(isNotifyKind("reply"), false);
});

/* ---------- suppressions ---------- */

test("master switch off suppresses everything", () => {
  const d = decideNotification(
    evt({ kind: "approval_asked", subjectId: "ap-1" }),
    DEFAULT_NOTIFY_PREFS,
    new Set(),
    at(12),
  );
  assert.equal(d.raise, false);
  if (!d.raise) assert.equal(d.reason, "notifications_off");
});

test("explicit channel notification modes are enforced after global and self gates", () => {
  const mention = evt({ kind: "mention", subjectId: "m-1" });
  const message = evt({ kind: "thread_reply", subjectId: "r-1" });
  assert.equal(decideNotification(message, { ...on, channelNotificationModes: { "ch-1": "off" } }, new Set(), at(12)).raise, false);
  assert.equal(decideNotification(message, { ...on, channelNotificationModes: { "ch-1": "mentions" } }, new Set(), at(12)).raise, false);
  assert.equal(decideNotification(mention, { ...on, channelNotificationModes: { "ch-1": "mentions" } }, new Set(), at(12)).raise, true);
  assert.equal(decideNotification(message, { ...on, channelNotificationModes: { "ch-1": "all" } }, new Set(), at(12)).raise, true);
});

test("quiet hours suppress even approvals (Tasks hold the urgent path)", () => {
  const prefs: NotifyPrefs = { ...on, quietOn: true, quietFrom: "22:00", quietTo: "08:00" };
  const d = decideNotification(
    evt({ kind: "approval_asked", subjectId: "ap-2" }),
    prefs,
    new Set(),
    at(23),
  );
  assert.equal(d.raise, false);
  if (!d.raise) assert.equal(d.reason, "quiet_hours");
});

test("you do not get a toast for your own action", () => {
  const d = decideNotification(
    evt({ kind: "mention", subjectId: "m-1", actorId: "u-vikas", recipientId: "u-vikas" }),
    on,
    new Set(),
    at(12),
  );
  assert.equal(d.raise, false);
  if (!d.raise) assert.equal(d.reason, "self");
});

test("de-duplication: same kind+subject raises once", () => {
  const e = evt({ kind: "job_finished", subjectId: "t-9" });
  const key = dedupeKey(e);
  assert.equal(key, "job_finished:t-9");

  const first = decideNotification(e, on, new Set(), at(12));
  assert.equal(first.raise, true);

  const second = decideNotification(e, on, new Set([key]), at(12));
  assert.equal(second.raise, false);
  if (!second.raise) assert.equal(second.reason, "duplicate");
});

test("different subjects do not collide in the de-dupe set", () => {
  const a = decideNotification(evt({ kind: "mention", subjectId: "m-a" }), on, new Set(["mention:m-b"]), at(12));
  assert.equal(a.raise, true);
});

test("notificationFromEvent fills the toast shape without consulting prefs", () => {
  const n = notificationFromEvent(evt({ kind: "artifact_published", subjectId: "av-3", title: "report.md", body: "Scout published report.md" }));
  assert.deepEqual(n, {
    id: "artifact_published:av-3",
    kind: "artifact_published",
    title: "report.md",
    body: "Scout published report.md",
    channelId: "ch-1",
    subjectId: "av-3",
    at: 1_700_000_000_000,
  });
});

/* ---------- per-room rules: muting one room ---------- */

const muted: NotifyPrefs = { ...on, mutedChannelIds: ["ch-1"] };

test("a muted room suppresses its news", () => {
  for (const kind of ["job_finished", "approval_asked", "artifact_published"] as const) {
    const d = decideNotification(evt({ kind, subjectId: `s-${kind}` }), muted, new Set(), at(12));
    assert.equal(d.raise, false, kind);
    if (!d.raise) assert.equal(d.reason, "room_muted", kind);
  }
});

test("a room that is not muted is unaffected", () => {
  const d = decideNotification(
    evt({ kind: "job_finished", subjectId: "t-2", channelId: "ch-other" }), muted, new Set(), at(12));
  assert.equal(d.raise, true);
});

test("no prefs list at all behaves exactly as before (nothing muted)", () => {
  const legacy: NotifyPrefs = { notify: true, quietOn: false, quietFrom: "22:00", quietTo: "08:00" };
  const d = decideNotification(evt({ kind: "job_finished", subjectId: "t-3" }), legacy, new Set(), at(12));
  assert.equal(d.raise, true);
});

test("an event with no room is never muted — there is no room to have muted", () => {
  const d = decideNotification(
    evt({ kind: "job_finished", subjectId: "t-4", channelId: undefined }), muted, new Set(), at(12));
  assert.equal(d.raise, true);
});

test("a direct mention still gets through a muted room", () => {
  const d = decideNotification(evt({ kind: "mention", subjectId: "m-2" }), muted, new Set(), at(12));
  assert.equal(d.raise, true, "somebody asking him by name is not the noise he muted");
});

test("mute never overrides the master switch", () => {
  const off: NotifyPrefs = { ...muted, notify: false };
  const d = decideNotification(evt({ kind: "mention", subjectId: "m-3" }), off, new Set(), at(12));
  assert.equal(d.raise, false);
  if (!d.raise) assert.equal(d.reason, "notifications_off");
});

test("mute never overrides quiet hours — not even for a mention", () => {
  const quiet: NotifyPrefs = { ...muted, quietOn: true, quietFrom: "22:00", quietTo: "08:00" };
  const d = decideNotification(evt({ kind: "mention", subjectId: "m-4" }), quiet, new Set(), at(23));
  assert.equal(d.raise, false);
  if (!d.raise) assert.equal(d.reason, "quiet_hours");
});

test("muting is checked after the master switch and before quiet hours", () => {
  const both: NotifyPrefs = { ...muted, quietOn: true, quietFrom: "22:00", quietTo: "08:00" };
  const d = decideNotification(evt({ kind: "job_finished", subjectId: "t-5" }), both, new Set(), at(23));
  assert.equal(d.raise, false);
  if (!d.raise) assert.equal(d.reason, "room_muted", "the room rule is read first of the two");
});

test("isRoomMuted reads the list, and an unknown room is not muted", () => {
  assert.equal(isRoomMuted(muted, "ch-1"), true);
  assert.equal(isRoomMuted(muted, "ch-2"), false);
  assert.equal(isRoomMuted(muted, undefined), false);
  assert.equal(isRoomMuted({}, "ch-1"), false);
});

test("withRoomMuted turns a room down and back up, never twice over", () => {
  const once = withRoomMuted(on, "ch-9", true);
  assert.deepEqual(once.mutedChannelIds, ["ch-9"]);
  const twice = withRoomMuted(once, "ch-9", true);
  assert.deepEqual(twice.mutedChannelIds, ["ch-9"], "muting an already-muted room changes nothing");
  const back = withRoomMuted(twice, "ch-9", false);
  assert.deepEqual(back.mutedChannelIds, []);
  assert.deepEqual(on.mutedChannelIds, [], "the prefs handed in are never changed");
});

/* ---------- which door a raised notification comes through ---------- */

test("looking at Cloud9 → the in-app toast, and no OS notification", () => {
  const d = chooseDelivery({ windowFocused: true, osSupported: true });
  assert.deepEqual(d, { via: "in_app_toast", reason: "window_focused", fellBack: false });
});

test("window focused wins even when the OS door is shut", () => {
  const d = chooseDelivery({ windowFocused: true, osSupported: false });
  assert.equal(d.via, "in_app_toast");
  assert.equal(d.fellBack, false, "nothing fell back — the toast was the right home");
});

test("away from Cloud9 → the operating system's own notification", () => {
  const d = chooseDelivery({ windowFocused: false, osSupported: true });
  assert.deepEqual(d, { via: "os_notification", reason: "window_not_focused", fellBack: false });
});

test("no OS door in this build → the toast, recorded as a fallback", () => {
  const d = chooseDelivery({ windowFocused: false, osSupported: false });
  assert.deepEqual(d, { via: "in_app_toast", reason: "os_unsupported", fellBack: true });
});

test("the OS said no → the toast, recorded as a fallback", () => {
  const d = chooseDelivery({ windowFocused: false, osSupported: true, osPermitted: false });
  assert.deepEqual(d, { via: "in_app_toast", reason: "os_refused", fellBack: true });
});

test("permission unknown is treated as allowed — a refusal is learned, not assumed", () => {
  const d = chooseDelivery({ windowFocused: false, osSupported: true, osPermitted: undefined });
  assert.equal(d.via, "os_notification");
});

/* ---------- what clicking one opens ---------- */

test("clicking a mention lands on the message itself", () => {
  assert.deepEqual(
    notifyTarget({ kind: "mention", channelId: "ch-1", subjectId: "m-7" }),
    { go: "message", channelId: "ch-1", messageId: "m-7" });
});

test("clicking a finished job or an approval lands on Tasks", () => {
  assert.deepEqual(notifyTarget({ kind: "job_finished", channelId: "ch-1", subjectId: "t-1" }), { go: "tasks" });
  assert.deepEqual(notifyTarget({ kind: "approval_asked", subjectId: "ap-1" }), { go: "tasks" });
});

test("clicking a published file lands in the room the file was published in", () => {
  assert.deepEqual(
    notifyTarget({ kind: "artifact_published", channelId: "ch-4", subjectId: "av-2" }),
    { go: "room", channelId: "ch-4" });
});

test("nothing to open when the room is unknown — never a wrong landing", () => {
  assert.equal(notifyTarget({ kind: "mention", subjectId: "m-8" }), null);
  assert.equal(notifyTarget({ kind: "artifact_published", subjectId: "av-9" }), null);
});

/* ---- a reply in a thread: who hears about it, and who never does ---- */

/** The thread: Vikas started it, Scout and Ada have both replied since. */
function reply(partial: Partial<ThreadReplyFacts> = {}): ThreadReplyFacts {
  return {
    replyId: "m-reply",
    channelId: "ch-1",
    authorId: "a-scout",
    authorName: "Scout",
    text: "picked the second option",
    at: 1_700_000_000_000,
    rootId: "m-root",
    rootAuthorId: "u-vikas",
    threadAuthorIds: ["a-scout"],
    ...partial,
  };
}

const me = { id: "u-vikas", agentIds: ["a-mine"] };

test("the person who started the thread is told when it moves", () => {
  const e = threadReplyEvent(reply(), me);
  assert.ok(e, "the thread starter is in the thread");
  assert.equal(e!.kind, "thread_reply");
  assert.equal(e!.subjectId, "m-reply", "the reply is the subject, so each reply raises once");
  assert.equal(e!.channelId, "ch-1");
  assert.equal(e!.actorId, "a-scout");
  assert.equal(e!.recipientId, "u-vikas");
  assert.equal(e!.title, "Scout replied in your thread");
  assert.equal(e!.body, "picked the second option");
  assert.equal(e!.at, 1_700_000_000_000);
});

test("somebody who has already replied in the thread is told too", () => {
  const e = threadReplyEvent(
    reply({ rootAuthorId: "u-someone", threadAuthorIds: ["u-vikas", "a-scout"] }), me);
  assert.ok(e);
  assert.equal(e!.title, "Scout replied in a thread you are in",
    "not his thread, but he is in it — the words say which");
});

test("a thread he has nothing to do with never reaches him", () => {
  const e = threadReplyEvent(
    reply({ rootAuthorId: "u-someone", threadAuthorIds: ["u-other"] }), me);
  assert.equal(e, null, "a side conversation between other people is exactly the noise this hides");
});

test("his own agent being in the thread puts him in it", () => {
  const e = threadReplyEvent(
    reply({ rootAuthorId: "u-someone", threadAuthorIds: ["a-mine"] }), me);
  assert.ok(e, "his agent replied there on his behalf, so the thread is his business");
});

test("he is never told about his own reply", () => {
  assert.equal(threadReplyEvent(reply({ authorId: "u-vikas" }), me), null);
});

test("a reply that @s him is a mention, not a thread reply — one message, one toast", () => {
  const facts = reply({ mentions: ["u-vikas"] });
  assert.equal(threadReplyEvent(facts, me), null,
    "the mention builder raises this one; two toasts about one message is the bug");
  assert.equal(threadReplyEvent(reply({ mentions: ["a-mine"] }), me), null,
    "an @ at his agent counts the same way");
  assert.equal(threadReplyEvent(reply({ mentions: ["u-other"] }), me)?.kind, "thread_reply",
    "somebody else being @'d does not silence his thread news");
});

test("nothing raises when there is no thread", () => {
  assert.equal(threadReplyEvent(reply({ rootId: "" }), me), null);
  assert.equal(threadReplyEvent(reply({ replyId: "" }), me), null);
});

test("a long reply is trimmed to one toast-sized line", () => {
  const e = threadReplyEvent(reply({ text: "x".repeat(400) }), me);
  assert.equal(e!.body.length, THREAD_REPLY_BODY_MAX);
  assert.ok(e!.body.endsWith("…"));
});

test("an empty reply still says something rather than nothing", () => {
  assert.equal(threadReplyEvent(reply({ text: "   " }), me)!.body, "(no message)");
});

test("isThreadParticipant: started it, replied in it, or neither", () => {
  assert.equal(isThreadParticipant({ rootAuthorId: "u-vikas" }, me), true);
  assert.equal(isThreadParticipant({ rootAuthorId: "u-x", threadAuthorIds: ["u-vikas"] }, me), true);
  assert.equal(isThreadParticipant({ rootAuthorId: "u-x", threadAuthorIds: ["a-mine"] }, me), true);
  assert.equal(isThreadParticipant({ rootAuthorId: "u-x", threadAuthorIds: ["u-y"] }, me), false);
  assert.equal(isThreadParticipant({ rootAuthorId: "u-x" }, me), false);
});

test("a thread reply obeys the master switch", () => {
  const d = decideNotification(threadReplyEvent(reply(), me)!, DEFAULT_NOTIFY_PREFS, new Set(), at(12));
  assert.equal(d.raise, false);
  if (!d.raise) assert.equal(d.reason, "notifications_off");
});

test("a muted room silences a thread reply — only a mention pierces mute", () => {
  const d = decideNotification(threadReplyEvent(reply(), me)!, muted, new Set(), at(12));
  assert.equal(d.raise, false);
  if (!d.raise) assert.equal(d.reason, "room_muted");
});

test("quiet hours silence a thread reply", () => {
  const quiet: NotifyPrefs = { ...on, quietOn: true, quietFrom: "22:00", quietTo: "08:00" };
  const d = decideNotification(threadReplyEvent(reply(), me)!, quiet, new Set(), at(23));
  assert.equal(d.raise, false);
  if (!d.raise) assert.equal(d.reason, "quiet_hours");
});

test("the same reply never raises twice", () => {
  const e = threadReplyEvent(reply(), me)!;
  assert.equal(dedupeKey(e), "thread_reply:m-reply");
  assert.equal(decideNotification(e, on, new Set(), at(12)).raise, true);
  const again = decideNotification(e, on, new Set([dedupeKey(e)]), at(12));
  assert.equal(again.raise, false);
  if (!again.raise) assert.equal(again.reason, "duplicate");
});

test("a mention and a thread reply about the SAME message cannot collide in the de-dupe set", () => {
  // Belt and braces: the builder already refuses the thread event when the
  // reply @s him, but even if two events for one message existed, the keys
  // are different kinds — so this asserts the builder, not the key.
  const facts = reply({ replyId: "m-same", mentions: ["u-vikas"] });
  assert.equal(threadReplyEvent(facts, me), null);
});

test("clicking a thread reply lands on the reply itself", () => {
  assert.deepEqual(
    notifyTarget({ kind: "thread_reply", channelId: "ch-1", subjectId: "m-reply" }),
    { go: "message", channelId: "ch-1", messageId: "m-reply" });
  assert.equal(notifyTarget({ kind: "thread_reply", subjectId: "m-reply" }), null,
    "no room means no landing — never a wrong one");
});

test("suppression order: off beats quiet hours and self", () => {
  const prefs: NotifyPrefs = { ...on, notify: false, quietOn: true };
  const d = decideNotification(
    evt({ kind: "job_finished", subjectId: "t-1", actorId: "u-vikas", recipientId: "u-vikas" }),
    prefs,
    new Set(["job_finished:t-1"]),
    at(23),
  );
  assert.equal(d.raise, false);
  if (!d.raise) assert.equal(d.reason, "notifications_off");
});
