# Durability review — the "write a file this app will later believe" rewrite

Reviewed 2026-07-30, read-only, by a separate session. Everything below was
re-run or re-read in this session; nothing is taken from the building agent's
own report. Another agent was editing `apps/desktop/**`, `packages/shared/**`
and `apps/relay/**` at the same time, so anything in those folders is judged
with that in mind and the relay suite was deliberately not run.

## VERDICT: SOUND WITH GAPS

The core of the work is genuinely good. The write path (temp file next door →
flush to disk → rename into place) is the right shape on Windows as well as
POSIX, the four writers really did move onto it, no fifth writer was missed
*inside the engine*, the derivation test is real, and the tests include the one
that matters most: killing a live Node process mid-write and checking the bytes
on disk. The claimed numbers check out where they could be checked.

The gaps are around the edges: one place now tells the user "Scheduled!" when
the disk save silently failed; the reader half checks that fields *exist* but
not that they make sense; and the litter-sweeping claim is only true for one of
the three folders that can collect litter.

---

## Claims verified by running them

| Claim | What this session did | Result |
|---|---|---|
| build clean | `npm run build -w @cloud9/shared -w @cloud9/engine` | exit 0, clean. (Full build including desktop NOT run — the other agent's in-flight edits would confound it.) |
| engine 329 pass | `$f=(Get-ChildItem packages\engine\dist\*.test.js).FullName; node --test @f` — 27 files | **tests 329, pass 329, fail 0, cancelled 0, skipped 0, exit 0** |
| hub 177 pass | NOT run — `apps/relay/src` is being edited by another agent right now | unverified |
| four writers moved | searched every non-test file in `packages/engine/src` for `writeFileSync` / `appendFileSync` / `createWriteStream` / `writeFile(` | only `wholefile.ts` itself writes; `runstore.ts`, `engine.ts` (schedules + skill files), `models.ts` all call `writeWholeFile` |
| derivation is real | `RUN_RETENTION.bytes` (64 * 1024) already existed at HEAD in shared; `RUN_STORE_DEFAULTS.maxBytes` now reads it; the new test asserts equality AND reads the source text of `runstore.ts` and fails unless the `maxBytes:` line literally contains `RUN_RETENTION.bytes` | real — re-hardcoding the number would pass the equality and fail the source-text check |

One caveat on the first run of the suite: my own first attempt at the test
command let bash mangle the PowerShell `$f`, which made `node --test` discover
raw `.ts` sources and report 41 bogus file-level failures. That was my harness
mistake, not the code — the corrected run above is the evidence. It is worth
recording because it is exactly the kind of thing that produces false alarms
between concurrent agents.

---

## Findings, worst first

### 1. "⏰ Scheduled!" is said even when the save failed (moderate)

`writeWholeFile` never throws, by design. For run records that is defensible —
`Engine` also publishes every record to the hub (`engine.ts:444-445`), so the
disk copy is a second copy. For schedules it changed who finds out about a
failure:

- Before: `saveSchedule` used a bare `writeFileSync`; a full disk or locked
  file **threw**, and the confirmation on the next line was never sent.
- Now (`engine.ts:919-921`): the write fails, returns `false`, prints one
  `console.error` line nobody looks at, and the agent still tells him
  *"⏰ Scheduled! I'll do this daily 06:30…"*. The schedule lives in memory,
  fires until the app restarts, and is then gone without a word.

`writeSchedules()` ignores `writeWholeFile`'s return value; so do
`saveSchedule` and `deleteSchedule`. This is the one place where "never
throws" hid a failure the caller needed, and it runs against the house law
that he confirms results rather than discovering problems. The fix is small:
`writeSchedules` returns the boolean and the two command handlers say
something honest when it is false.

### 2. The reader trusts any value as long as the key exists (moderate)

`readRecord` (`runstore.ts:283-311`) now rejects empty files, torn JSON,
non-objects, and objects missing `id` / `agentId` / `startedAt` / `outcome` —
verified in code and by the new tests. But it only checks *presence*. A file
holding `{"id":42,"agentId":{},"startedAt":"soup","outcome":"banana"}` is
returned as a `RunRecord` via a cast, and flows on to `runListEntry` and the
screen. The stricter checker already exists — `validateRunRecord` in
`@cloud9/shared` type-checks every field — and the reader does not use it.
So "readers were made honest" is true against power-cut damage (the class
that was targeted) but not against the "valid JSON, every field, semantically
nonsense" case this review was asked about. Same one step short in
`loadSchedules`: a row only needs `id` to be a string; `when: 12` sails
through to the scheduler.

### 3. Windows reality: one-shot rename, no retry (minor–moderate)

The durability argument itself holds on Windows: Node's `renameSync` maps to
`MoveFileExW(MOVEFILE_REPLACE_EXISTING)`, which on same-volume NTFS replaces
the name in one step in practice; the file-flush before the rename is real
(`FlushFileBuffers`); and the directory-flush honestly documents that Windows
has no equivalent and NTFS journals the metadata. Two genuine Windows caveats:

- The header comment states rename-over-existing is "a single indivisible
  step on Windows" as fact. Microsoft documents no such guarantee; it is a
  well-earned convention (it is what everyone, including SQLite, relies on),
  but the comment is more certain than the platform is.
- **No retry on a share violation.** Antivirus and the search indexer briefly
  hold handles without `FILE_SHARE_DELETE`; the rename then fails `EPERM`
  once, and the write is abandoned for good — a lost run record or schedule
  save on a machine that runs Defender by definition. Windows-hardened
  writers usually retry the rename a few times over ~100 ms. Missing here.

Nonexistent folder (`mkdirSync recursive` first), disk full, and over-long
paths were checked in code: all end in `false` + cleanup + the old file
intact, and the failure-path test proves the old-file-survives part.

### 4. The sweeping claim covers one folder of three (minor)

"The engine sweeps leftover temp files at startup" is literally true only for
the top level of `dataDir` (`engine.ts:160`) — which does cover
`schedules.json` and the model cache (`host.ts:149` puts
`claude-models.json` there). Run folders are swept on every `prune`. But
**skill folders** (`agents/<id>/skills`) are written through `wholefile` and
never swept by anything: a process killed mid-skill-write leaves
`checklist.md.tmp-…` sitting forever in a folder the CLI reads. Litter with
a name no skill loader should match, so likely harmless — but "cleans up its
own litter" is a per-write claim, not a per-folder one, and this folder has
no sweeper. One `sweepPending(dir)` at the top of `writeSkillFiles` closes it.

### 5. Two windows sharing one data folder can eat each other's in-flight save (minor)

Startup sweep deletes anything matching `.tmp-` in `dataDir`. If a second
Cloud9 window opens while the first is mid-`schedules.json` write, the new
window's sweep can delete the first one's temp file before its rename, which
then fails safely (old file intact, save lost, logged). The models.ts comment
explicitly contemplates two windows sharing this folder, so this is a real —
if millisecond-wide — window. Safe failure mode, so minor.

### 6. The class is fixed engine-wide, not app-wide (informational)

The "single owner" claim was scoped to the engine and holds there. But files
this app writes and later believes also exist outside it, still on plain
`writeFileSync`: relay attachments (`apps/relay/src/store.ts:1239`) and the
desktop main process's owner token, settings and harness secrets
(`apps/desktop/electron/main.cjs:71,123,151`). Both areas belong to the other
agent today, so no criticism of this diff — but "fix the class" is not
finished until those either move onto the same rule or are argued exempt.

---

## Honesty of the reporting

- **Numbers**: engine 329 — exact. Build of the packages it touched — clean.
  Hub 177 — could not be checked here.
- **The diff matches the story.** The ten changed engine/shared-adjacent files
  are the four writers, the readers, the tests, and the exports. The claim of
  fixing "a regression outside its own making" is consistent with what is
  visible: shared (the other agent's file) renamed `isSafeSkillFileName` to
  `isSafeFileName`/`isSafeStoredId`, and this diff adapts the engine to it
  (`engine.ts:9`, `runstore.ts`, `runrecord.ts`). Because both agents' edits
  sit uncommitted in one working tree, attribution is by inference, not proof.
- **One change not mentioned in the claims, in its favour**: `fileFor` in
  `runstore.ts` now validates the final *file name* as well as the id, closing
  a `trailing.` → `trailing..json` hole, with a comment explaining it.
- **The tests are not fake.** The kill-a-real-process test refuses to count a
  run where the write wasn't provably in flight, and fails if it never catches
  one — the opposite of the fake-test pattern this project has been burned by.

## What was NOT checked — treat none of these as passed

- The hub/relay suite (claimed 177) — not run; the folder is being edited by
  another agent.
- The full build including desktop typecheck — same reason.
- `npm run qa` and `npm run qa:app` — forbidden to this session (ports/app
  belong to the other agent).
- The seven claimed bug-backs, and the claim that another agent's test run was
  killed — no artefact in the repo to check either against.
- Real power loss. The fsync-before-rename ordering is proven by test; that
  the disk firmware honours the flush is taken on the platform's word, as it
  must be.
- Real antivirus / locked-file behaviour — reasoned from code (finding 3), not
  reproduced with an actual handle held open.
- Two *real* engine processes racing on one data folder (findings 5's window
  was reasoned, not reproduced).
- Anything in `apps/desktop`, `apps/relay`, or the rest of `packages/shared`
  beyond the lines the engine change depends on.
