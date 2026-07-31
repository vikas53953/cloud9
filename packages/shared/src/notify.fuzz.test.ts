import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_NOTIFY_PREFS,
  decideNotification,
  dedupeKey,
  inQuietHours,
  isNotifyKind,
  notificationFromEvent,
  type Cloud9Notification,
  type NotifyDecision,
  type NotifyEvent,
  type NotifyKind,
  type NotifyPrefs,
} from "./notify.js";

const HUGE = "x".repeat(100_000);
const HOSTILE_TEXT = [
  "",
  " ",
  "\u200b",
  "\u200fmention",
  "\u202eapproval_asked",
  "ｍention",
  "__proto__",
  "constructor",
  "prototype",
  "a:b:c",
  HUGE,
] as const;
const KINDS: readonly NotifyKind[] = [
  "job_finished",
  "approval_asked",
  "mention",
  "artifact_published",
];
const NUMBER_BOUNDARIES = [
  0,
  -1,
  Number.MAX_SAFE_INTEGER,
  2 ** 53,
  NaN,
  Infinity,
  -Infinity,
] as const;

function assertPlain(value: object): void {
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal((Object.prototype as { polluted?: unknown }).polluted, undefined);
}

function hostileEvent(kind: NotifyKind, subjectId: string, at: number): NotifyEvent {
  const event = {
    kind,
    subjectId,
    channelId: "\u202e__proto__",
    actorId: "constructor",
    recipientId: "prototype",
    title: "\u200bTitle",
    body: HUGE,
    at,
    secret: "must-not-leak",
  } as NotifyEvent & { secret: string };
  Object.defineProperty(event, "__proto__", {
    value: { polluted: true },
    enumerable: true,
    configurable: true,
  });
  return event;
}

function assertSafeNotification(notification: Cloud9Notification, event: NotifyEvent): void {
  assertPlain(notification);
  assert.deepEqual(Object.keys(notification).sort(), [
    "at",
    "body",
    "channelId",
    "id",
    "kind",
    "subjectId",
    "title",
  ]);
  assert.equal(notification.id, `${event.kind}:${event.subjectId}`);
  assert.equal(notification.kind, event.kind);
  assert.equal(notification.subjectId, event.subjectId);
  assert.ok(!("actorId" in notification));
  assert.ok(!("recipientId" in notification));
  assert.ok(!("secret" in notification));
  assert.equal(Object.prototype.hasOwnProperty.call(notification, "__proto__"), false);
}

function assertSafeDecision(decision: NotifyDecision, event: NotifyEvent): void {
  assertPlain(decision);
  assert.equal(decision.key, `${event.kind}:${event.subjectId}`);
  if (decision.raise) {
    assertSafeNotification(decision.notification, event);
  } else {
    assert.ok(["notifications_off", "quiet_hours", "duplicate", "self"].includes(decision.reason));
  }
}

test("isNotifyKind remains an exact allow-list for malformed runtime values", () => {
  const malformed: unknown[] = [
    undefined,
    null,
    false,
    true,
    0,
    -1,
    Number.MAX_SAFE_INTEGER,
    NaN,
    Infinity,
    0n,
    Symbol("mention"),
    [],
    {},
    { ["__proto__"]: "mention" },
    ...HOSTILE_TEXT,
  ];
  const runtimeCheck = isNotifyKind as (value: unknown) => boolean;
  for (const value of malformed) {
    let answer: boolean | undefined;
    assert.doesNotThrow(() => {
      answer = runtimeCheck(value);
    }, typeof value);
    assert.equal(typeof answer, "boolean");
    assert.equal(answer, false);
  }
  for (const kind of KINDS) assert.equal(isNotifyKind(kind), true);
});

test("quiet-hour parsing stays boolean across hostile clocks and dates", () => {
  const clocks = [
    "",
    " ",
    "\u200b",
    "\u202e22:00",
    "__proto__",
    "constructor",
    "-1:-1",
    "00:00",
    "23:59",
    "24:00",
    "9007199254740992:9007199254740992",
    "NaN:Infinity",
    HUGE,
  ];
  const dates = [
    new Date(0),
    new Date(-1),
    new Date(Number.MAX_SAFE_INTEGER),
    new Date(2 ** 53),
    new Date(NaN),
    new Date(Infinity),
    new Date(-Infinity),
  ];

  for (const quietOn of [false, true]) {
    for (let index = 0; index < clocks.length; index++) {
      const prefs = {
        quietOn,
        quietFrom: clocks[index],
        quietTo: clocks[clocks.length - 1 - index],
      };
      for (const now of dates) {
        let answer: boolean | undefined;
        assert.doesNotThrow(() => {
          answer = inQuietHours(prefs, now);
        });
        assert.equal(typeof answer, "boolean");
        if (!quietOn) assert.equal(answer, false);
      }
    }
  }
});

test("notification builders do not copy identity, secrets, or prototype payloads", () => {
  for (const kind of KINDS) {
    for (const subjectId of HOSTILE_TEXT) {
      for (const at of NUMBER_BOUNDARIES) {
        const event = hostileEvent(kind, subjectId, at);
        let key: string | undefined;
        let notification: Cloud9Notification | undefined;
        assert.doesNotThrow(() => {
          key = dedupeKey(event);
          notification = notificationFromEvent(event);
        });
        assert.equal(key, `${kind}:${subjectId}`);
        assertSafeNotification(notification as Cloud9Notification, event);
        assert.ok(Object.is((notification as Cloud9Notification).at, at));
      }
    }
  }
});

test("decisions stay plain and deterministic for hostile prefs and seen keys", () => {
  const prefVariants: NotifyPrefs[] = [
    { ...DEFAULT_NOTIFY_PREFS },
    { ...DEFAULT_NOTIFY_PREFS, notify: true },
    { notify: true, quietOn: true, quietFrom: "", quietTo: HUGE },
    { notify: true, quietOn: true, quietFrom: "\u202e22:00", quietTo: "08:00" },
    { notify: true, quietOn: true, quietFrom: "NaN", quietTo: "Infinity" },
  ];
  const dates = [new Date(0), new Date(-1), new Date(NaN), new Date(Infinity)];

  for (const prefs of prefVariants) {
    for (const kind of KINDS) {
      for (const subjectId of HOSTILE_TEXT) {
        const event = hostileEvent(kind, subjectId, Number.MAX_SAFE_INTEGER);
        for (const now of dates) {
          for (const seen of [
            new Set<string>(),
            new Set<string>(["__proto__", "constructor", dedupeKey(event)]),
          ]) {
            let decision: NotifyDecision | undefined;
            assert.doesNotThrow(() => {
              decision = decideNotification(event, prefs, seen, now);
            });
            assertSafeDecision(decision as NotifyDecision, event);
          }
        }
      }
    }
  }
});
