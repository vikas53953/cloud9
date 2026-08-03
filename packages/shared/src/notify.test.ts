// Pure notification rules — what raises a toast, quiet hours, de-dupe.
// Proves the Settings quiet-hours shape and the four event kinds.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NOTIFY_PREFS,
  chooseDelivery,
  decideNotification,
  dedupeKey,
  inQuietHours,
  isNotifyKind,
  isRoomMuted,
  notificationFromEvent,
  notifyTarget,
  withRoomMuted,
  type NotifyEvent,
  type NotifyPrefs,
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
  });
});

/* ---------- which events raise ---------- */

test("each of the four kinds raises when notifications are on", () => {
  const kinds = ["job_finished", "approval_asked", "mention", "artifact_published"] as const;
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

test("isNotifyKind names exactly the four raisers", () => {
  assert.equal(isNotifyKind("job_finished"), true);
  assert.equal(isNotifyKind("approval_asked"), true);
  assert.equal(isNotifyKind("mention"), true);
  assert.equal(isNotifyKind("artifact_published"), true);
  assert.equal(isNotifyKind("message"), false);
  assert.equal(isNotifyKind("push"), false);
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
