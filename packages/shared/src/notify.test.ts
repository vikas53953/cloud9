// Pure notification rules — what raises a toast, quiet hours, de-dupe.
// Proves the Settings quiet-hours shape and the four event kinds.
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NOTIFY_PREFS,
  decideNotification,
  dedupeKey,
  inQuietHours,
  isNotifyKind,
  notificationFromEvent,
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
