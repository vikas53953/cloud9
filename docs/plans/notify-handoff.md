# Notifications — pure core handoff

**Written by:** Cursor Lane N (`cursor/notifications`), 2026-07-31.
**Owns (this round):** `packages/shared/src/notify.ts`, `notify.test.ts`.
**Does NOT own:** `apps/desktop/**`, OS toasts, APNs, `server.ts`, re-export in `index.ts`.
**This document is the request to the conductor (and later the screen / phone).**

---

## 0. What exists now

| Half | State |
|---|---|
| Pure rules module (`packages/shared/src/notify.ts`) | **DONE** — this branch |
| Re-export from `@cloud9/shared` index | **NOT DONE** — conductor re-exports |
| Desktop reads the module for pop-ups | **NOT DONE** — still uses private `inQuietHours` in `App.tsx` |
| Hub raises typed notify frames for the four kinds | **NOT DONE** — only legacy `{ type: "push"; message }` for proactive |
| Phone / APNs delivery | **NOT DONE** — `logPush` still a stub |

By the product law — *DONE when he can SEE it and USE it* — this round is
**plumbing**. The rules are tested. Nothing new appears on his screen until
the conductor wires the desktop helper (and later the phone) to this module.

---

## 1. The four events that raise a notification

Nothing else. Ordinary chat lines are **out of scope** for this contract
(the legacy "new message" desktop toast may stay until retired).

| `NotifyKind` | When | `subjectId` is |
|---|---|---|
| `job_finished` | A delegated task reaches a terminal status (done / failed / cancelled) | task id |
| `approval_asked` | An approval card becomes `pending` (job-shaped or mid-run action) | approval id |
| `mention` | A message `@`s this person (or one of their agents) | message id |
| `artifact_published` | A new artifact version is stored in a conversation they can see | artifact **version** id |

Callers map hub/engine facts → a `NotifyEvent`, then call `decideNotification`.

---

## 2. Preference shape (matches Settings today)

Same field names as `Prefs` / `cloud9.prefs` in the desktop:

```ts
interface NotifyPrefs {
  notify: boolean;     // master switch — Settings default false
  quietOn: boolean;    // Settings default false
  quietFrom: string;   // "HH:MM" — default "22:00"
  quietTo: string;     // "HH:MM" — default "08:00"
}
```

`DEFAULT_NOTIFY_PREFS` equals those defaults.

Quiet-hours math is the Settings helper, extracted:

- `quietOn === false` → never quiet
- same-day window when `from <= to` → `[from, to)` (end exclusive)
- overnight when `from > to` (e.g. 22:00 → 08:00) → wraps midnight

**Quiet hours silence every toast**, including approvals. Settings copy already
says urgent work still lands in **Tasks** for the morning — that is not a
pop-up path. Do not special-case kinds in the client.

---

## 3. De-duplication

Key: `` `${kind}:${subjectId}` `` (`dedupeKey`).

One toast per subject per session. The module is pure — it takes a
`ReadonlySet<string>` of already-shown keys and does **not** mutate it. After
a `raise: true` decision, the caller adds `decision.key` to its set.

Self-suppression: if `actorId` is present and equals `recipientId`, reason
`"self"` — you do not toast yourself.

---

## 4. Shape a screen or OS toast renders

```ts
interface Cloud9Notification {
  id: string;          // === dedupeKey
  kind: NotifyKind;
  title: string;
  body: string;
  channelId?: string;
  subjectId: string;
  at: number;
}
```

No Electron / Notification / APNs fields here. Desktop maps `title`/`body` onto
`new Notification(...)`. A future phone maps the same shape onto push payload
bytes.

---

## 5. Frames — what exists, what to add

### Today (already on the wire)

```ts
| { type: "push"; message: Message }  // hub → mobile, proactive agent lines only
```

- **Phone reads it:** any mobile client handling `ServerFrame` `push`
  (today: logged via `store.logPush` when offline; live send when `client === "mobile"`).
- **Desktop does not read `push`.** Desktop invents toasts from local message
  count churn in `App.tsx`.

### What this module does **not** add

No new WebSocket frame on this branch (index.ts is forbidden / conductor-owned).
Recommended frame name when the conductor wires delivery for the four kinds:

```ts
| { type: "notify"; notification: Cloud9Notification }
```

Until that exists, clients may build a `NotifyEvent` from frames they already
see (`message` with `mentions`, `approval`, `task` / `updateTask`, `artifact`)
and call `decideNotification` locally — same rules, no new wire.

| Client | Where it should read the decision |
|---|---|
| **Desktop** | Replace private `inQuietHours` + the message-count toast effect in `App.tsx` with `decideNotification` over the four kinds (prefs from `cloud9.prefs`) |
| **Phone** | On `push` today; later on `notify` — still run `decideNotification` if prefs live on-device, or trust hub-side filtering once prefs are per-account |
| **Hub** | Optional later: filter before `push` / `notify` using the same prefs once they are account-scoped |

---

## 6. Import path (until re-export)

```ts
import {
  decideNotification, inQuietHours, dedupeKey,
  notificationFromEvent, DEFAULT_NOTIFY_PREFS,
  type NotifyPrefs, type NotifyEvent, type Cloud9Notification, type NotifyKind,
} from "@cloud9/shared/dist/notify.js";  // temporary, if index not yet re-exported
// preferred after conductor re-export:
import { decideNotification, /* … */ } from "@cloud9/shared";
```

Standalone on purpose — Lane N does not edit `packages/shared/src/index.ts`.

---

## 7. Tests

`packages/shared/src/notify.test.ts` — run via:

```
npm test -w @cloud9/shared
```

Covers: four kinds raise, master off, quiet same-day + overnight, self,
de-dupe, defaults match Settings, `isNotifyKind` allow-list.
