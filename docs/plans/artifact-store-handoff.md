# The shared artifact store — the contract for the screen half

Written **2026-07-30**, at the end of the round that built the SERVER half.
Read this instead of the code. Everything a screen needs — frame names, exact
field names, what to draw, and what is deliberately not there — is below.

Plain words first: **an agent can now put a file INTO a conversation.** Before
this round the only thing it could do was paste a Windows path into the chat,
and a path on this machine is not a file anybody else can open — not another
agent, not Vikas on another machine, not a friend. This was the **#1 gap** from
his own agents' gap analysis, run inside Cloud9.

---

## 0. What exists now, and what does not

| Half | State |
|---|---|
| The shapes both sides speak (`packages/shared`) | **DONE** |
| The engine noticing a file its turn made, and offering it (`packages/engine`) | **DONE** |
| The hub storing it, versioning it, attributing it, serving it (`apps/relay`) | **DONE** |
| **The screen** — anything drawn, anywhere | **NOT DONE. Nobody has seen an artifact.** |

`apps/desktop/src/store.ts` currently has three cases — `artifact`, `artifacts`,
`artifactTicket` — that **break on purpose and draw nothing**. They exist only
because the exhaustive `never` check in that switch (correctly) refuses to
compile a frame nobody handles. Replacing those three lines with real handling is
the follow-up round's job, and it is the only place in `apps/desktop` this round
touched.

By the app's own law — *a feature is DONE when he can SEE it and USE it* — this
round is **NOT DONE**. It is the plumbing under a feature, proved by tests, with
nothing on his screen.

---

## 1. The one decision that shapes everything

**An artifact's identity is (conversation, name).** Not (agent, name).

One agent writing `report.md` and a second one revising it is a **handoff**,
which is the thing this store exists to make possible. So it stays **one file
with two authors in its history** rather than two files with the same name that
nobody can tell apart in a list.

Consequences, all of them deliberate:

* **Attribution is per VERSION**, never on the artifact. `Artifact` has no
  `agentId`; every `ArtifactVersion` has `agentId`, `agentName` and `ownerId`.
  A screen that wants "who made this" means "who made this version".
* Two spellings are one file. `Report.md` and `report.md` collide through
  `nameKey()` — the same rule that makes a second agent called `Scout` a
  refusal.
* Publishing the same name again is an **update**, and version 1 is kept.

## 2. The shapes (all in `@cloud9/shared`)

```ts
interface Artifact {
  id: ID;                      // "af-…" — the reference that survives every version
  channelId: ID;
  name: string;                // the shared name, e.g. "villas.md"
  versions: ArtifactVersion[]; // NEWEST FIRST, never empty, capped at 20
  createdAt: number;           // when version 1 landed
  updatedAt: number;           // when the newest version landed
}

interface ArtifactVersion {
  id: ID;            // "av-…" — the reference to THESE bytes, which never change
  version: number;   // 1 upwards, never reused
  size: number;
  sha256: string;    // hex, computed by the HUB from the bytes it stored
  text: boolean;     // could the hub read these bytes as text? decided from the BYTES
  storedAs: string;  // the hub's own file name. A screen has NO use for this.
  agentId: ID;
  agentName: string;
  ownerId: ID;       // the person whose agent it is
  runId?: string;    // the RunRecord this turn wrote — join the two here
  taskId?: ID;       // the delegated job, when it came out of one
  note?: string;     // the agent's own line about what changed
  producedAt: number;
}
```

**ABSENT MEANS ABSENT.** `runId`, `taskId` and `note` are missing when there is
nothing to say. Draw nothing for a missing one — never "unknown", never a blank
row, never `v1` for a version that is version 1.

Helpers to use rather than re-implement:

| Function | What it answers |
|---|---|
| `latestVersion(artifact)` | the newest version. **Do not index `versions[0]` yourself** — the ordering has one owner |
| `versionOf(artifact, n)` | one version by number, or nothing |
| `describeArtifactVersion(v)` | the one line under the name: `made by Scribe · version 3 · fixed the numbers` |
| `artifactRef(id, version?)` | the stable reference to put in a message |
| `parseArtifactRef(text)` / `findArtifactRefs(text)` | turn message words into cards |
| `ARTIFACT_LIMITS` | `bytes` 10 MB, `versions` 20, `perChannel` 200, `publishesPerMinute` 30, `note` 300, `listPage` 100 |
| `artifactTooBigSentence(name, size)` | the plain-words refusal, if a screen ever needs to say it |

## 3. The frames

### Client → hub

| Frame | Who may send it | Fields |
|---|---|---|
| `publishArtifact` | **ENGINE ONLY** | `channelId`, `agentId`, `name`, `dataBase64`, `runId?`, `taskId?`, `note?` |
| `artifacts` | anyone in the room | `channelId` |
| `artifact` | anyone who can see the room it is in | `artifactId` |
| `artifactTicket` | same | `artifactId`, `version?` (absent = newest) |

A desktop client sending `publishArtifact` is refused with *"only your own agent
engine can share a file an agent made"*. That refusal is the whole value of the
store: attribution nobody can fake.

### Hub → clients

| Frame | When | Fields |
|---|---|---|
| `artifact` | pushed to **everyone who can see the conversation** the moment a file is published or updated; also the answer to the `artifact` ask | `artifact: Artifact` |
| `artifacts` | answers `artifacts`. **Most recently changed first** | `channelId`, `artifacts: Artifact[]` |
| `artifactTicket` | answers `artifactTicket`, to the asking socket only | `artifactId`, `version`, `ticket`, `url`, `expiresAt`, `artifact` |

## 4. Downloading — the SAME path a person's attachment uses

There is **one** download endpoint. `url` on an `artifactTicket` is
`/attachment/<ticket>` — the same `ATTACHMENT_TICKET.path`, the same one-use
ticket, the same thirty seconds, the same headers. Join it to the origin the
WebSocket is on and `GET` it.

* **One use.** The first byte spends it. A second request is 404.
* **Permission twice.** Checked when the ticket is minted and again when it is
  redeemed, both times through `channelFor` on stored state. Being removed from
  the room inside those thirty seconds stops the download — there is a test.
* **The type comes from the NAME**, never from anything a producer claimed:
  `downloadContentType()` plus `nosniff`, a `default-src 'none'; sandbox` CSP and
  `no-store`. `content-disposition` carries the **shared name**, not the hub's
  stored one.
* **A version that has been pruned is not quietly swapped for the newest.** The
  hub refuses with *"version 9 of notes.txt is no longer kept — the newest is
  version 21"*. Show that sentence; do not fall back.

A screen re-tickets when a link has expired. That is why the 404 carries CORS
headers too.

## 5. What the renderer should draw

Nothing here is built. This is the contract, not a mock.

**An artifact card**, wherever a `cloud9://artifact/<id>` reference appears in a
message (use `findArtifactRefs` on the message text — there is **no new field on
`Message`**, on purpose, so every place that already carries text carries these
for free):

* the **name** (`artifact.name`), big enough to be the thing he clicks;
* the one line from `describeArtifactVersion(latestVersion(artifact))` — who
  made it, which version, and the agent's own note;
* **a way to open it** → send `artifactTicket`, then fetch `url`;
* **the history**, when there is more than one version: each version's number,
  who made it, when, and its own open button. A version is opened by asking for
  `artifactTicket` with that `version`.
* `text: true` may be previewed inline. `text: false` is **a download and
  nothing more** — never previewed, never embedded.
* When `runId` is present, the card should be able to reach the run record that
  produced it — that join is the whole point of the attribution.

**A files list per conversation** — ask `artifacts` on opening a room; every
`artifact` frame that arrives afterwards replaces the row with the same `id`.

## 6. Honest limits, stated in the app's own words

| Limit | Number | What is said |
|---|---|---|
| One file | 10 MB (`ARTIFACT_LIMITS.bytes`) | *"villas.md is 12.4 MB, which is too big to share here (the limit is 10 MB). It is still on this computer — put it in a repository, or share a smaller part of it."* |
| Versions kept | 20 | the oldest bytes are deleted with their row |
| Artifacts per room | 200 | asked only of a NEW name; an update is never refused for a full room |
| Publishes per agent | 30 a minute | *"Scribe is sharing files faster than anyone can read them — it has to wait a minute"* |
| Files offered per turn | 10, newest first | the rest are named in the agent's own message |

The size cap is **the same number an attachment gets**, and that is by
construction, not coincidence: `WS_LIMITS.maxPayloadBytes` is derived from the
attachment cap, so a bigger artifact cap would be a cap the socket silently
refuses first — a legal file vanishing with no sentence anywhere.

**A refusal is always said out loud, in the room, in the agent's own voice.** The
file really is on this computer, and silence would be *"the file's on disk"* all
over again with the app doing the hiding.

## 7. Where a file comes from, on the engine side

`packages/engine/src/artifacts.ts` — `sweepProduced(dir, { since })` — and the
one caller, `Engine.shareProduced`, reached from **`respondAs`**. That is the one
funnel every kind of turn goes through (chat, delegated job, scheduled check-in,
and a turn inside a git worktree), so a new kind of turn cannot be added that
quietly shares nothing.

* **Where it looks:** the agent's own worktree when the turn had one
  (`TurnInput.workdir`), its own data folder otherwise. Never the owner's
  repository, never anywhere else on this machine.
* **What counts:** files modified **at or after the moment the turn started**. A
  file the agent has had for a week is not re-shared every time it says hello.
* **Never a half-written file:** `isPendingName` — the same owner the whole-write
  mechanism uses.
* **Never the bookkeeping:** `SKIP_FOLDERS` = `runs`, `skills`, `.git`,
  `node_modules`, `dist`, `build`, `out`, `coverage`, `.next`, `.venv`,
  `__pycache__`, `.cache`, plus every dot-folder and dot-file.

**A DECISION WORTH RE-OPENING ON PURPOSE:** `dist`, `build` and `out` are on that
skip list, and a build output really can be the thing he asked for — an
installer, a rendered report. It is skipped today because sharing two hundred
compiled files would bury the one file he wanted. If a later round wants them, it
should be a deliberate change to `SKIP_FOLDERS`, not a surprise.

## 8. What this round did NOT do

1. **Nothing is on screen.** See §0.
2. **No artifact is attached to a message row.** The link is a reference in the
   text, which is why no `Message` field changed. If a later round wants "the
   file this message is about" as a first-class field, that is a new decision.
3. **Nothing deletes an artifact.** There is no `forgetArtifact` frame. Pruning
   old versions happens; removing a whole file does not, so `perChannel` is a
   ceiling with no way to clear it yet. Say so rather than drawing a delete
   button that cannot work.
4. **An agent cannot yet ASK for another agent's artifact.** The reference is
   readable and the download is permission-checked, but nothing puts an
   artifact's contents into another agent's prompt. That is the agent-to-agent
   handoff item, and it is the natural next round.
5. **The engine sends no `note`.** The field exists and the hub stores it; no
   caller writes one yet, because an agent has not been asked to. A version with
   no note draws no note.

## 9. Proof this round ran

* `npm run build` — clean, including `tsc --noEmit` on the desktop app.
* `npm test` — engine **369**, hub **202**, desktop **11** = **582 pass, 0 fail**
  (the baseline before this round was 353 + 188 + 11 = 552).
  New this round: **16 engine checks** — 8 in `packages/engine/src/artifacts.test.ts`
  (noticing a produced file) and 8 in `packages/engine/src/artifactref.test.ts`
  (the reference, the text/binary question, the card's own line) — and
  **14 hub checks** in `apps/relay/src/artifactstore.test.ts`.
* **Every new check was watched to fail** with its feature broken on purpose, one
  break at a time, and the break is named in a comment beside the test. The
  seventeen breaks that were run: the turn's start time ignored; the skip list
  emptied; the half-written-file guard removed; the size refusal removed; the
  name refusal removed; the silent trim; the refusal turned into a wall of text;
  the file announced only to its publisher; the engine-only gate removed; the
  room gate on reading an artifact removed; permission checked only at mint; a
  ticket resolved to the newest version instead of the asked one; everything
  labelled text; a second artifact minted per publish; pruned bytes left on disk;
  the hub-side name/size gate removed; the agent-ownership check removed; an
  archived room accepting new files; the version list reversed; the reference
  accepting any id; the reference dedupe removed; the trailing-punctuation trim
  removed; a UTF-8 character split by the 8 KB window called binary; and an
  absent note drawn as an empty one. Two of them found REAL faults in the first
  draft of these tests (a pending-file name spelled by hand rather than taken
  from `pendingNameFor`, and a duplicate reference that never reached the dedupe)
  — which is the whole reason for doing it.
* `npm run qa` was **NOT** run in this round — it exercises files another agent
  was editing at the same time. Someone must run it before this is called safe.
