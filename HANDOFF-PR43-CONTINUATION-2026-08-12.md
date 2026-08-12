# Handoff — continuing PR #43 (`codex/global-chat-shell`)

Written to hand this work to another agent or platform, cold, with no access to the
originating session's context. It supersedes nothing: read
`HANDOFF-GLOBAL-CHAT-SHELL-2026-08-12.md` first for the release state, then this
document for what changed after it and what to do next.

- Repository: `vikas53953/cloud9`
- Branch: `codex/global-chat-shell`
- PR: https://github.com/vikas53953/cloud9/pull/43 (open, into `master`)
- Head at time of writing: **`d486b79`** ("fix: answer the six review findings on the
  global chat shell"), pushed. Parent is `add99c3`, the earlier handoff commit.
- Working tree clean; nothing uncommitted, nothing stashed. Untracked `.worktrees/` was
  left alone deliberately.

## 1. What was completed in this session

### The six open Codex review comments on #43 — all answered, in `d486b79`

The commit touches four files: `apps/desktop/src/App.tsx`,
`apps/desktop/src/styles.css`, `packages/shared/src/threadwidth.ts`,
`packages/shared/src/threadwidth.test.ts` (+68 / −39).

**1. Measured thread dimensions restored (this was the P1).**
The branch had changed `THREAD_DEFAULT` 388 → 460 and `ROOM_FLOOR` 300 → 520.
`docs/threads-like-slack.html` is the recorded measurement of the reference product
(Buzz): thread default **388px**, thread floor ≈308px, room floor ≈301px, split
threshold 894px. No new measurement anywhere in the repo supports 460/520, and the
raised room floor pushes every window between roughly 894px and 1113px into thread
takeover — i.e. it silently breaks the split behaviour the same reference specifies.
Both `threadwidth.ts` and `threadwidth.test.ts` were restored from `origin/master`, so
the tests assert the measured numbers again.

If the user tells you they deliberately picked 460/520 by eye on their own screen, that
is a legitimate answer — but then the reference doc must be re-measured and updated,
because right now the code and the reference disagree.

**2. Back / Forward now re-enter screens through their loaders.**
Previously they only called `setScreen(...)`, so returning to a data-bearing screen
showed stale cached data. A single `askOnEnter(screen)` callback now owns "what this
screen asks for on the way in" (spending, projects, updates, social, forums, huddles,
canvas, activity, pulse), and `goScreen`, Back and Forward all call it. One owner, so a
new screen only has to be added in one place.

**3. Composer height resets after send.**
Height was being set imperatively in `onChange`, so when `sendNow()` cleared the
controlled value programmatically the inline `style.height` stayed large and left an
empty tall box. `onChange` now only updates state; a `useLayoutEffect` keyed on
`[text, inThreadPanel]` derives the height from the current value, clamped to 180px in
the thread panel and 240px otherwise.

**4. Global-search copy narrowed to what is implemented.**
It advertised "messages, rooms, agents, files and activity". `SearchKind` is
`"message" | "reply" | "file" | "fileVersion"`. The label, aria-label and the Ctrl-K
help notification now say **messages, replies and files**. (The alternative — implement
room/agent/activity search — is a real feature, not a copy fix; if the user wants it,
scope it separately.)

**5. A light palette can no longer be repainted by a dark OS.**
`data-appearance-mode` can legitimately say `"system"`, and a palette name alone cannot
answer "is this a light screen?" — a chosen light palette under a dark OS is still a
light screen. `applyTheme()` now also writes the *resolved* appearance as
`data-appearance="dark" | "light"` on the root, and the four dark-only CSS rules in
`styles.css` changed from `:root:not([data-theme="light"])` to
`:root:not([data-appearance="light"]):not([data-theme="light"])`. So High Contrast Light
stays light on a dark Windows.

### Evidence actually observed for `d486b79`

Run on this VM under Node 24, and these are real numbers, not assumed:

| Check | Result |
|---|---|
| `npm run build` (vite + tsc typecheck) | **exit 0** |
| `packages/shared`, `node --test "dist/**/*.test.js"` | **284 pass / 0 fail** |
| `apps/desktop`, `node --test "electron/**/*.test.cjs"` | **153 pass / 0 fail** |
| `npm run qa` (browser QA) | **not run after `d486b79`** |
| `npm run dist` / install / `npm run qa:app` | **not run after `d486b79`** |

Treat the last two rows as unknown, not as passing. The browser QA baseline recorded in
the previous handoff was 595/595, but that was before these changes.

## 2. Three known-true findings about the repo that are not yet fixed

These were verified directly and each is a real defect, independent of #43's features.

**A. `npm test` never runs at all on Windows PowerShell.**
Every workspace test script is shaped `node --test dist/*.test.js`. PowerShell does not
expand that glob for the child process, so Node receives the literal string and exits
with `Could not find '...\dist\*.test.js'` — in all four workspaces, before a single
test executes. A quoted recursive glob (`node --test "dist/**/*.test.js"`) is correct on
Windows *and* on POSIX shells. Until this is fixed, "the full test suite passed" cannot
honestly be claimed from a PowerShell run, which matters because `AGENTS.md` makes that
a release gate.

**B. Nothing pins Node, and the project requires Node ≥ 22.**
`apps/relay/src/store.ts` imports `node:sqlite`, which does not exist before Node 22. On
Node 20 the relay suite does not fail loudly — all 58 tests fail as
`ERR_UNKNOWN_BUILTIN_MODULE` phantoms, precisely the silently-not-green outcome
`AGENTS.md` forbids. Some Electron dev dependencies also warn they want ≥ 22.12. Add an
`engines` constraint plus a pinned CI Node so an unsupported runtime fails immediately
and visibly.

**C. `ChannelRail` / `ReachGap` is dead code, which is why installed blocker 2 cannot
pass.** It is defined in `App.tsx` and has **no call site anywhere in the repository**
(9 total matches, all definition-side). The installed walk's failure message
(`Drivecheck is not in the room's details panel`) is therefore not a selector problem:
the live `RoomPanel` never exposes reach-gap or fix metadata at all. Fixing blocker 2
means deciding how reach-gap information should appear in the current design and
integrating it — a product change.

Also observed, lower priority: the engine suite has **1052 pass / 37 fail** on this VM,
and several failures are the engine's own unsafe-argument guard rejecting Windows 8.3
short paths (`C:\Users\ADMINI~1\...`). That is a genuine bug for any Windows username
longer than eight characters, not merely a VM artefact. The relay suite passes except
one timing-sensitive run-boundedness test.

## 3. What remains on PR #43

The four installed-app blockers from the previous handoff are **all still open**. None
were attempted in this session.

1. **Blocked-agent presence line** — the walk looks for `.agentrow[data-agent="Drivecheck"]`,
   which is hidden in Focus layout. Durable state is correct (`data-trouble="blocked"`).
   Needs a truthful *visible* projection, or an assertion through a surface that is
   genuinely visible. A hidden DOM node is not evidence.
2. **Reach a real file** — see finding C above. Product integration, not a selector fix.
3. **Image understanding** — the agent replied that its engine was not connected instead
   of describing the image. Candidate causes: the packaged engine sidecar failed to
   attach; room-membership setup was skipped after blocker 2 cascaded; or a real
   packaged-provider defect. Not yet discriminated.
4. **Stop a real turn** — no Stop control appeared. Possibly a cascade of 1–3, but the
   previous handoff is explicit that it must be proven independently.

**Do 3 and 4 in this order and no other:** first prove the *installed* binary
(`%LOCALAPPDATA%\Programs\Cloud9\Cloud9.exe`, not `npm run dev`) actually connects its
engine; then prove the selected agent's exact room membership; only then judge image and
Stop, stating for each whether it was a genuine defect or a cascade. Most of the
cascade hypothesis rests on membership, so proving it early is what stops you chasing
ghosts.

### Release chain still to run, serially, one at a time

```
npm run build
npm test
npm run qa
npm run dist
powershell -ExecutionPolicy Bypass -File scripts/install-cloud9.ps1
npm run qa:app
```

The final walk must drive the actual installed binary. Per `AGENTS.md`, a timeout, a
skipped check, or a cascading unavailable check **is not green** — and a visual change is
not complete on source or browser evidence alone.

## 4. Suggested lane split (bounded so parallel agents cannot collide)

This is the decomposition prepared in this session. `App.tsx` is a single ~1MB file, so
two agents editing it will conflict; the split exists to prevent that.

| Lane | Scope | Owns exactly |
|---|---|---|
| A | Blockers 1 + 2: visible blocked presence, reach-gap in the live `RoomPanel` | `apps/desktop/src/App.tsx`, `apps/desktop/src/styles.css`, checks 1–2 in `scripts/drive-app.mjs` |
| B | Blockers 3 + 4: packaged engine connection, image understanding, Stop | `apps/desktop/electron/**`, `packages/engine/**`, checks 3–4 in `scripts/drive-app.mjs` |
| C | Findings A + B: real test gate on Windows, Node ≥22 pin, CI on PRs | root and workspace `package.json` (scripts/`engines` only), `.nvmrc`, `.github/**`, the test/Node section of `README.md` |

`scripts/drive-app.mjs` is shared between A and B, so both must keep edits surgical —
only their own check bodies, no reformatting, reordering or helper renames. Its
`--real-data` contract must be preserved: in real-data mode the walk must never mutate
the user's real state.

Lanes A, B and C are mutually independent and can run at once. Each should open a PR
**into `codex/global-chat-shell`** (not `master`), be reviewed by a different agent than
wrote it, and be folded by whoever is conducting.

Three sessions were started on exactly this split and then put to sleep at the user's
request before producing any commits or PRs; they consumed no measurable compute. There
is nothing to recover from them — the lane briefs are reproduced above in full.

## 5. Rules any continuing agent must honour

From `AGENTS.md`, and they are the reason this project's evidence is trustworthy:

- The app must be **truthful and fail closed**. Never let the UI claim something
  happened unless the underlying system recorded it. A refusal must explain why and how
  the user can enable the capability.
- **Fix the class, not the case.** No special-casing to make a QA check pass.
- **Nobody reviews or merges their own work.**
- A hidden DOM node is not installed evidence.
- Only one build / package / install / installed walk at a time.
- Do not bump the package version (currently `0.1.0`) without being asked. Do not commit
  installer or release binaries. Do not modify tests merely to make them pass.

An honest red is worth more than a fabricated green. The previous handoff's willingness
to publish "installed gate: not green" is why the state of this project is knowable at
all — preserve that.

## 6. Environment quickstart

```powershell
$env:Path="C:\hostedtoolcache\node\24.0.1\x64;"+$env:Path   # Node >= 22 is mandatory
npm install                                                  # warns about engines; fine
npm run build                                                # must exit 0
cd packages/shared; node --test "dist/**/*.test.js"          # 284/284
cd ../../apps/desktop; node --test "electron/**/*.test.cjs"  # 153/153
```

`npm install` exits non-zero on Windows purely from engine warnings plus four
high-severity audit findings; packages do install. No dependency or security policy was
changed in this session, deliberately.

The user's own working copy is at `C:\Users\vikasmit\cloud9` with the app already
installed there; that path was not reachable from the VM this session, so everything
above was done from a fresh GitHub clone.
