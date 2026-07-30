# Handoff: the four writes still outside the whole-file rule

Written 2026-07-30 by the engine-durability round, from finding 6 of
`docs/reviews/durability-review.md`. **Nothing in this document has been
changed by me** — every file named below belongs to another agent, so this is a
request, not a diff.

## What the rule is

`packages/engine/src/wholefile.ts` is the ONE owner of *"write a file this app
will later believe"*. Everything the engine stores and reads back goes through
it: run records, schedules, the remembered model list, an agent's skill files.

```
writeWholeFile(target, text, onError?) -> boolean
```

What it does, in plain words:

1. writes the bytes into a temporary file **next to** the real one,
2. pushes them all the way down to the disk (`fsync`),
3. renames that file over the real name — **retrying briefly** if Windows
   refuses because Defender or the search indexer is holding a handle,
4. flushes the folder where the platform allows,
5. cleans up its own temporary file if any of that failed.

It **never throws**. It returns `true` when the bytes are under the real name
and `false` when nothing usable was written, and it hands the reason to
`onError`.

`sweepPendingTree(root)` clears away the litter of a write that was killed,
everywhere under one folder, and refuses to delete a temporary file another
live process is still filling.

## The rule that comes WITH it, and matters more

**A write that never throws is only safe while every caller looks at the
answer.** That was finding 1: the engine told Vikas *"⏰ Scheduled!"* when the
save had silently failed. Before the atomic write, the failure threw and he was
never told it worked. Making the write quiet turned a loud failure into a
silent one, which is backwards for this project — *a failure he cannot see is
worse than one he can.*

So inside `packages/engine` there is now a test — `writeoutcome.test.ts` —
that reads the package's own source and fails unless every `writeWholeFile`
call either **uses** the boolean or carries a `WRITE OUTCOME IGNORED: <why>`
comment above it. Whoever moves the writes below across should copy that test,
not just the function.

---

## The four writes still on plain `writeFileSync`

Line numbers are as of 2026-07-30 in a working tree where another agent is
editing all four files, so re-find them by name rather than by number.

### 1. `apps/relay/src/store.ts:1239` — an attachment's bytes

```js
writeAttachmentBytes(id, safeName, bytes) {
  fs.mkdirSync(this.attachmentsDir, { recursive: true });
  const storedAs = `${id}-${path.basename(safeName)}`;
  fs.writeFileSync(path.join(this.attachmentsDir, storedAs), bytes);   // <— here
  return storedAs;
}
```

**What it risks.** The hub writes the bytes and then writes a database row
saying the file is there. If the app closes, the machine sleeps or the disk
fills between the two, the row promises a file that is half there. Vikas later
opens his attachment and gets a truncated PDF or half a picture — and nothing
anywhere says the file is damaged, because the row looks perfectly healthy.
This is the same class as the torn run record, with one difference that makes
it worse: a run record can be re-derived, and **his uploaded file cannot**.

**How to move it across.** `writeWholeFile` takes a string, and this writes a
`Buffer`, so it needs the one small widening described at the bottom of this
document. Then:

```js
const ok = writeWholeFileBytes(path.join(this.attachmentsDir, storedAs), bytes,
  m => console.error(`[hub] could not store an attachment: ${m}`));
if (!ok) throw new Error("that file could not be saved on this computer");
```

**The caller must act on it.** Returning `storedAs` after a failed write is
exactly the "⏰ Scheduled!" bug in another costume: the row gets written, the
upload is reported as done, and the file is not there. Look at what
`saveAttachment` does next and make the upload fail with a sentence Vikas can
act on. Also worth checking: whether the attachments folder is ever swept for
litter (`sweepPendingTree`) — today nothing sweeps it.

### 2. `apps/desktop/electron/main.cjs:71` — **the owner token**

```js
function writeOwnerToken(token) {
  ...
  fs.writeFileSync(ownerTokenPath(), blob, { mode: 0o600 });
```

**What it risks — and this is the worst one on the list.** This file is the
private key the installed app makes for itself on first run. It is written
exactly once, on first run, and read on every run afterwards. A power cut
during that one write leaves a truncated blob. `readOwnerToken` then either
returns null or a corrupt string, and `ensureOwnerToken` **mints a brand new
token and overwrites it** — so the app comes back as a stranger to its own hub
and everything signed with the old key is unreachable. It is a one-in-a-
thousand event with a total loss behind it, and it happens on the single
riskiest moment in the app's life: first run, when the disk is also being
written by the installer.

**How to move it across.** Same call, plus two things the engine version
already does and this does not:

- keep `{ mode: 0o600 }` **on the temporary file**, not just the final name —
  a temporary file written world-readable and then renamed has already leaked
  on a shared machine;
- act on the `false`. A key that did not reach the disk must stop first run
  with a plain sentence, not be used in memory and lost at the restart.

### 3. `apps/desktop/electron/main.cjs:123` — settings

```js
function writeSettings(s) {
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}
```

**What it risks.** One file holds every setting. `readSettings` is
`try { JSON.parse(...) } catch { return {} }` — so a torn write does not
announce itself, it silently resets **every preference he has ever set** to the
default, and the next `writeSettings` writes those defaults back over the
wreckage. The identical bug in the engine's schedules file is what started this
whole round.

**How to move it across.** Straight swap, plus: `readSettings` should say out
loud when it could not believe the file, the way the engine's `loadSchedules`
does, instead of quietly returning `{}`. Losing his settings and telling him is
recoverable; losing them silently is not.

### 4. `apps/desktop/electron/main.cjs:151` — the harness sign-ins

```js
fs.writeFileSync(secretPath(harness), blob, { mode: 0o600 });
```

**What it risks.** One file per harness holding the encrypted Claude / Codex
credential. A torn write means the sign-in silently stops working and he is
sent back through "Sign in with Claude" with no explanation. Less severe than
the owner token — he can sign in again — but it is the same fix and the same
`mode: 0o600` point about the temporary file.

**In its favour:** `saveSecret` already returns a boolean and already catches
and reports. It is the closest of the four to being right; it mostly needs the
write swapped.

---

## The one small change `wholefile.ts` needs first

`writeWholeFile` takes `text: string`. Attachment bytes and both credential
blobs are `Buffer`s. Do NOT stringify them — `Buffer -> utf8 string -> Buffer`
corrupts any byte that is not valid UTF-8, which is most of a PDF.

Widen the signature in the ONE owner rather than making a second copy of the
rule for binary:

```ts
export function writeWholeFile(
  target: string,
  data: string | NodeJS.ArrayBufferView,
  onError?: (message: string) => void,
  options?: { mode?: number },
): boolean
```

`fs.writeFileSync` already accepts both, so the body barely changes; `mode`
goes on the temporary file so the permissions travel with the rename. **I have
not made this change** — it is inside `packages/engine`, which I own, but it
would be a change with no caller in this package, and an untested widening
waiting for someone else is not an improvement. Whoever picks up this handoff
should make it and prove it with a real binary round-trip.

## Or: argue one of them exempt

"Fix the class" is finished when each of the four is either moved across or
argued exempt **in writing**. My own reading, for whoever decides:

| Write | My view |
|---|---|
| owner token | Move it. Highest loss, lowest cost, one-line change. |
| settings | Move it, and make the reader say when it could not believe the file. |
| harness secrets | Move it. Nearly right already. |
| attachments | Move it — it is the only one holding bytes Vikas cannot get back. |

None of the four looks exempt to me.

## What is NOT claimed here

I did not run the hub suite, `npm run qa`, or `npm run qa:app` — the ports and
those folders belong to another agent today. Nothing above has been tested
because nothing above has been changed. The line numbers were read from the
working tree on 2026-07-30 while those files were being edited by someone else,
so treat them as pointers, not addresses.
