# Handoff — continuing PR #43 (`codex/global-chat-shell`)

**Audience: an agent or engineer with no prior context on this project, possibly on a
different platform entirely.** This document assumes you know nothing. Everything needed
to continue is written down here, including things you may already know, and including
the things that are uncertain — clearly marked as such.

**Written:** 2026-08-12. **Author:** Devin (Cognition), acting as conductor.
**Reason for handoff:** the user's compute quota was near exhaustion and they chose to
continue on another agent platform rather than wait for a reset.

---

# 0. Read this first — the five facts that matter most

1. **The branch head is `d9e7220`** on `codex/global-chat-shell`. Its parent `d486b79`
   answers all six open code-review comments on PR #43. Everything is pushed; the
   working tree was clean at handoff; nothing is stashed.
2. **PR #43 is not finished.** Four installed-app blockers are open and untouched. Do
   not report #43 as complete, green, or releasable.
3. **`npm test` has never actually executed on Windows PowerShell.** The glob in the
   test scripts is not expanded, so Node dies before running a single test, in all four
   workspaces. Any historical claim that "the full test suite passed" from a PowerShell
   run on this project is vacuous. Fix this before you trust any new green. Details in
   §7-A.
4. **The project requires Node ≥ 22** (`node:sqlite`) and nothing pins it. On Node 20 the
   relay suite fails as 58 phantom `ERR_UNKNOWN_BUILTIN_MODULE` errors rather than
   failing loudly. Details in §7-B.
5. **`ChannelRail`/`ReachGap` is dead code with no call site**, which is the actual
   reason installed blocker 2 cannot pass. It is a product gap, not a selector bug.
   Details in §7-C and §8.2.

---

# 1. What Cloud9 is

Cloud9 is the user's flagship project — in their words, *"my dream project"*. It is a
**private, agentic engineering and collaboration workspace**: a Slack-like chat
application where humans and AI agents are both first-class participants in the same
channels, threads and DMs, and where the agents can actually do engineering work under
governed permissions.

It is emphatically **not** just a chat UI with a bot in it. The intended end state, per
`PIPELINE.md` and the PRDs under `docs/plans/`, combines three things:

**Conversation surface (Slack-shaped).** Channels, DMs, threads, mentions, attachments,
reactions, notifications, search, drafts, emoji, rich-link previews, huddles, presence.

**Agent runtime.** Agents have personalities, skills, tools, hooks, memory, token
budgets and permissions. They stream responses, run real turns, can be stopped
mid-turn, can be delegated to, and pause at approval checkpoints. Each user connects
their own Claude credential (API key or setup token); Codex is also supported as a
provider. Agents can act proactively as background workers, not only when addressed.

**Engineering workflow.** Projects, repositories, tasks, runs, artifacts, approvals,
tests, deployments, execution receipts, spending/token accounting, and audit records.
Messages can be converted into tasks; runs can be recovered and compared; work products
are durable and inspectable.

**Clients.** Windows desktop (Electron) and iPhone (Expo/React Native), synchronised
through a relay. Desktop is far ahead; the iPhone app is a three-file scaffold. A global
hotkey opens quick chat from anywhere.

**The defining product principle** — repeated throughout `AGENTS.md` and the docs, and
the thing that most distinguishes this codebase from a demo:

> The app must be **truthful** and **fail closed**. It must never claim an action
> occurred unless the underlying system recorded it. When it cannot do something, it
> refuses, explains why, and explains how the user can enable the capability.

Take that seriously. Most of the remaining work on PR #43 is hard *precisely because*
faking it is forbidden.

---

# 2. Architecture

```text
iPhone app (Expo)  ─┐
Desktop renderer   ─┼─ WebSocket ─→  relay  (Node + SQLite)
Engine host        ─┘                 │
                                      └─ source of truth: users, channels,
                                         membership, messages, tasks, approvals,
                                         artifacts, runs, audit
```

- **The relay is the source of truth.** Clients do not own state.
- **The engine host** drives local Claude/Codex processes. In v1 it is hosted inside the
  desktop app's Electron main process; the design intends to move it to an always-on
  server later so agents keep working when the desktop is closed.
- **Persistence** is SQLite via Node's built-in `node:sqlite` (`apps/relay/src/store.ts`,
  schema version 16). This is the reason Node ≥ 22 is mandatory.
- **Transport** is WebSocket plus some REST.

## Repository topology

| Path | What lives there |
|---|---|
| `packages/shared` | Shared protocol types, message contracts, permissions, notification models, run records, search types, skill library, token accounting. Workspace name `@cloud9/shared`. |
| `packages/engine` | Agent runtime: Claude and Codex providers, harness, tools, memory, skills, hooks, git worktrees, GitHub operations, verification, process stopping. `@cloud9/engine`. |
| `apps/relay` | WebSocket/REST hub with SQLite persistence: auth, authorization, channels, membership, messages, tasks, approvals, artifacts, runs, audit. `@cloud9/relay`. |
| `apps/desktop` | Electron shell + React renderer. `electron/` is the main process (hosts the engine, global hotkey); `src/` is the renderer. `@cloud9/desktop`. |
| `apps/mobile` | Expo scaffold. **Only three tracked files**: `App.js`, `app.json`, `package.json`. Not a workspace. Essentially unstarted. |
| `scripts` | Build, packaging, QA, installed-app driving, screenshots, installation, release helpers. |
| `docs` | PRDs, architecture plans, measured references, gates, QA evidence, reviews, roadmap. |

`workspaces` is `["packages/*", "apps/relay", "apps/desktop"]`. Package version `0.1.0`.

## Files you will care about most

| File | Why |
|---|---|
| `apps/desktop/src/App.tsx` | **~1 MB single file.** The entire renderer: every screen, the composer, the rails, `RoomPanel`, the dead `ChannelRail`/`ReachGap`, theming, navigation. Two agents editing this will collide — the `TRACKER.md` records that having happened. |
| `apps/desktop/src/styles.css` | All renderer styling, including the 16 palettes and the dark/light appearance rules. |
| `apps/desktop/electron/main.cjs` | Electron main process: engine-host wiring, global hotkey, packaging-sensitive path resolution. Prime suspect for installed blockers 3 and 4. |
| `packages/engine/src/provider.ts` | `MockProvider`, `SdkProvider`, provider lifecycle events, agent connection and streaming. The "engine not connected" message originates in this area. |
| `apps/relay/src/store.ts` | SQLite store, schema v16, `node:sqlite` import (the Node ≥ 22 constraint). |
| `packages/shared/src/threadwidth.ts` | Thread/room sizing constants. Subject of the P1 review comment; see §6.1. |
| `scripts/drive-app.mjs` | The **installed-app QA driver** (`npm run qa:app`). Contains the four failing checks. Has a `--real-data` contract that must never mutate the user's real state. |
| `scripts/qa-stack.mjs` | Browser QA (`npm run qa`), baseline 595/595 before this session's changes. |
| `scripts/install-cloud9.ps1` | Installs the built package to `%LOCALAPPDATA%\Programs\Cloud9\Cloud9.exe`. |
| `scripts/prepare-packaging.mjs` | Runs before pack/dist. Relevant if the engine sidecar is missing from the packaged app. |
| `scripts/engine-host.mjs` | The engine host entrypoint — check whether and how this ends up inside the packaged app. |
| `docs/threads-like-slack.html` | **The measured reference** for thread sizing. Authoritative for §6.1. |
| `HANDOFF-GLOBAL-CHAT-SHELL-2026-08-12.md` | The previous handoff. Authoritative for the release state and the four blockers. |
| `AGENTS.md` | Binding pipeline rules. Read in full before writing code. |
| `PIPELINE.md`, `TRACKER.md`, `ASKS.md`, `PARKING-LOT.md` | Scope, progress, open user asks, deferred items. |
| `docs/cloud9-feature-architecture-and-roadmap-2026-08-09.md` | Proposes the future five-group IA: Inbox / Chat / Build / Agents / Insights, with Settings and Profile pinned. Out of scope for #43. |

---

# 3. The pipeline you are joining (from `AGENTS.md`)

The user built this pipeline deliberately and wants it followed. It is the reason the
project's status is knowable at all.

**Roles.** A *conductor* owns the request, intent, architecture, decomposition,
integration and final handoff. Implementation happens in bounded lanes. **Every
implementation gets a distinct reviewer lane — nobody reviews or merges their own work.**

**Delivery stages, in order:**

```text
branch → bounded implementation → independent review → repair / re-review →
fold → production build → automated tests → browser QA → installer →
exact installation → installed visual/behaviour walk → final handoff/publication
```

**The reference gate.** Before implementing product or visual behaviour, you must
observe the real installed app *and* the named reference product or docs. The repo
contains captured references for this purpose (`docs/threads-like-slack.html`,
`docs/buzz-*.html`, `docs/slack-frontend-chat-audit-*.html`). "Buzz" is the reference
product these measurements come from.

**Evidence tiers.** Structural/unit → build → browser (`npm run qa`) → installed
(`npm run qa:app` against the real installed binary) → human. **A visual change is not
complete on source or browser evidence alone; it needs installed evidence.**

**Hard rules, all binding:**

- A timeout, a skipped check, or a cascading unavailable check **is not green**.
- A hidden DOM node is not installed evidence. Assert through surfaces a user can
  actually see with the current controls.
- Fix the class, not the case. No special-casing to make a QA check pass.
- The app must be truthful and fail closed; refusals must explain why and how to enable.
- Only one build / package / install / installed walk at a time.
- Do not bump the package version without an explicit request (it is `0.1.0`).
- Do not commit installer or release binaries.
- Do not modify tests merely to make them pass.
- Leave the untracked `.worktrees/` directory alone — it holds isolated temporary
  checkouts and is intentionally not pushed.

An honest red is worth more than a fabricated green. The previous handoff's willingness
to publish "installed gate: not green" is why anyone can trust this repo's state.

---

# 4. Where PR #43 stands

- PR: https://github.com/vikas53953/cloud9/pull/43
- Title: "Complete global chat shell and appearance library"
- Base: `master`. Head branch: `codex/global-chat-shell`. Open and mergeable at last check.
- PR handoff comment: https://github.com/vikas53953/cloud9/pull/43#issuecomment-5262066245

**Stage reached:** installed-app verification / release-candidate repair. Build, tests,
browser QA, packaging and installation all succeeded at the previous handoff; the
installed walk did not.

Per the previous handoff, at commit `add99c3`:

| Gate | Result |
|---|---|
| Integrated production build | pass |
| Full automated test suite | pass (in the user's own environment) |
| Browser QA `npm run qa` | **595 / 595**, zero failures |
| Installer build `npm run dist` | pass |
| Installation | pass — `%LOCALAPPDATA%\Programs\Cloud9\Cloud9.exe`, version `0.1.0`, SHA-256 `CB0018B75455A29090CC6386A9EBBFD04B0F680B5ED92575CD23C5E721E3E52E` |
| Installed-app QA `npm run qa:app` | **NOT GREEN — four unresolved checks** |
| Human visual walk | not done |

The installed walk *did* confirm a great deal working: installed launch and debugger
connection, workspace/home rendering, Projects via More tools, reply/thread control, the
actions menu filling the current slash command, calm/armed composer behaviour, projects,
repository, spending, settings, several Files checks, room mute, and connection-state UI.
The four failures below are what remain.

## Feature scope of PR #43 (for context on how large it is)

Global navigation/search bar; workspace search and actions; back/forward navigation;
distinct shell zoning; multi-line raised composer; Split/Focus thread constraints; 16
light/dark/accessibility palettes; palette categories, search, favourites, custom accent
and explicit apply; JSON import/export of appearance; durable message delivery states;
durable channel and thread drafts; attachment fencing and cleanup; response delta
streaming; channel memory policies; run recovery and comparison; full turn lifecycle;
slash commands; room-aware mention picker; attachment previews and retry;
voice-recording feedback; contextual Send/Run labels; per-turn model/effort/permission
controls; recent-emoji persistence; rich-link previews; message-to-task conversion;
thread summaries; channel context header; delegation; approval checkpoints; execution
receipts; chat personalisation; sidebar customisation; and workspace layouts including
Focus, Split and Chat + Files.

---

# 5. Git state at handoff

```text
d9e7220  docs: hand off PR 43 continuation with verified state and open blockers   <- HEAD (this file)
d486b79  fix: answer the six review findings on the global chat shell
add99c3  handoff global chat shell work in progress                                <- previous handoff
```

Working tree clean. Nothing stashed. `.worktrees/` untracked and untouched.

The repo has ~40 remote branches, many of them unlanded feature branches
(`origin/feature/*`, `origin/sol/*`, `origin/fix/*`, `origin/codex/*`). Those are out of
scope for #43 but represent a large amount of parked work — see §11.

---

# 6. What was done in this session, in full detail

## 6.1 The six review comments on #43 — all answered in `d486b79`

Files touched: `apps/desktop/src/App.tsx`, `apps/desktop/src/styles.css`,
`packages/shared/src/threadwidth.ts`, `packages/shared/src/threadwidth.test.ts`
(+68 / −39).

### (1) and (3) — Measured thread dimensions restored. **This was the P1.**

The branch had changed:

```ts
// on the branch, unsupported by any measurement
export const THREAD_DEFAULT = 460;
export const THREAD_FLOOR   = 300;
export const ROOM_FLOOR     = 520;
```

`docs/threads-like-slack.html` is the recorded measurement of the reference product
(Buzz): **thread default 388px**, thread floor ≈308px, **room floor ≈301px**, split
threshold 894px, ~300px symmetric minimum behaviour. Nothing in the repository supports
460 or 520.

The raised room floor is not merely cosmetic: with `ROOM_FLOOR = 520`, every window
between roughly **894px and 1113px** loses the ability to split and falls into thread
takeover — it silently breaks the very split behaviour the same reference specifies.

Both files were restored from `origin/master`:

```powershell
git checkout origin/master -- packages/shared/src/threadwidth.ts packages/shared/src/threadwidth.test.ts
```

giving:

```ts
export const THREAD_DEFAULT = 388;
export const THREAD_FLOOR   = 300;
export const ROOM_FLOOR     = 300;
```

The restored test asserts, among others:

```ts
assert.equal(SPLIT_NEEDS_WINDOW, 894);
assert.equal(cannotSplit(spaceToShare(894)), false);
assert.equal(cannotSplit(spaceToShare(893)), true);
assert.equal(widestThread(spaceToShare(894)), THREAD_FLOOR);
assert.equal(ROOM_FLOOR, 300);
assert.equal(widthToDraw(THREAD_DEFAULT, spaceToShare(1920)), 388);
assert.equal(widthToDraw(999999, spaceToShare(1920)), 1292);
assert.equal(widthHeChose(THREAD_DEFAULT + THREAD_STEP, spaceToShare(1920)), 404);
assert.equal(widthHeChose(THREAD_DEFAULT - THREAD_STEP, spaceToShare(1920)), 372);
```

**Open question for the user, unresolved:** if they chose 460/520 deliberately by eye on
their own display, that is a legitimate product decision — but then
`docs/threads-like-slack.html` must be re-measured and updated, because code and
reference currently disagree. They were asked and had not answered when the session
ended. Do not silently re-raise the numbers without that answer.

### (2) Back/Forward now re-enter screens through their loaders

Existing navigation history state:

```ts
const [screenPast, setScreenPast] = useState<ScreenName[]>([]);
const [screenFuture, setScreenFuture] = useState<ScreenName[]>([]);
const screenHistoryRef = useRef(screen);
const historyJumpRef = useRef(false);
```

Back and Forward previously only called `setScreen(previous)` / `setScreen(next)`, which
bypasses each screen's data loader, so returning to a data-bearing screen showed stale
cached data. A single owner for "what a screen asks for on the way in" was added:

```ts
const askOnEnter = useCallback((s: ScreenName) => {
  if (s === "spending") client.askSpending();
  else if (s === "projects") client.askProjects();
  else if (s === "updates") client.askPublicUpdates();
  else if (s === "social") client.askSocialProjects();
  else if (s === "forums") client.askForumProjects();
  else if (s === "huddles") client.askHuddles();
  else if (s === "canvas") client.askProjects();
  else if (s === "activity") client.send({ type: "activity", limit: 100 });
  else if (s === "pulse") { client.askProjects(); client.askPulse(); }
}, []);
```

`goScreen` became:

```ts
const goScreen = useCallback((s: ScreenName) => attemptLeave(() => {
  askOnEnter(s);
  setScreen(s);
}), [askOnEnter]);
```

Back calls `askOnEnter(previous)` then `setScreen(previous)` (deps
`[screen, screenPast, askOnEnter]`); Forward calls `askOnEnter(next)` then
`setScreen(next)` (deps `[screen, screenFuture, askOnEnter]`). One owner, so a new
data-bearing screen only has to be registered in one place.

### (4) Composer height resets after send

Height was set imperatively inside `onChange`:

```ts
onChange={e => {
  setText(e.target.value); setAcIndex(0);
  const box = e.currentTarget;
  box.style.height = "auto";
  box.style.height = `${Math.min(box.scrollHeight, inThreadPanel ? 180 : 240)}px`;
}}
```

When `sendNow()` cleared the controlled value programmatically, no `onChange` fired, so
the inline height stayed large and left a tall empty box. Now:

```ts
onChange={e => { setText(e.target.value); setAcIndex(0); }}
```

```ts
React.useLayoutEffect(() => {
  const ta = taRef.current;
  if (!ta) return;
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, inThreadPanel ? 180 : 240)}px`;
}, [text, inThreadPanel]);
```

Height is now derived from the current value, so it shrinks when the value empties, and
the clamp lives in exactly one place.

### (5) Global-search copy narrowed to what is implemented

It advertised "Search messages, rooms, agents, files and activity". The implementation
is:

```ts
export type SearchKind = "message" | "reply" | "file" | "fileVersion";
```

The `aria-label`, the visible label and the Ctrl-K help notification now say
**"messages, replies and files"**; the help text reads:

```ts
"Ctrl K opens the command launcher. Ctrl Shift F searches messages, replies and files."
```

The alternative — actually implementing room / agent / activity search — is a real
feature, not a copy fix. If the user wants it, scope it as its own lane.

### (6) A light palette can no longer be repainted by a dark OS

`data-appearance-mode` can legitimately say `"system"`, and a palette name alone cannot
answer "is this a light screen?" — a chosen light palette under a dark OS is still a
light screen. `applyTheme()` now writes the **resolved** appearance to the root:

```ts
root.setAttribute("data-appearance-mode", mode);
root.setAttribute("data-palette", palette);
const dark = resolvedAppearanceMode(mode) === "dark";
root.setAttribute("data-appearance", dark ? "dark" : "light");   // <- added
const effectivePalette = paletteMode(palette) === (dark ? "dark" : "light")
  ? palette : defaultPalette(dark ? "dark" : "light");
root.setAttribute("data-theme", effectivePalette);
```

and four dark-only rules in `styles.css` changed from

```css
:root:not([data-theme="light"])
```

to

```css
:root:not([data-appearance="light"]):not([data-theme="light"])
```

covering the base dark palette fallback, the body texture blend mode, the active rail
item colour and the segmented-control selected state. Result: High Contrast Light stays
light on a dark Windows. Existing palette selectors were kept as the compatibility CSS
surface.

## 6.2 Evidence actually observed for `d486b79`

Real observed numbers on the VM under Node 24 — not assumed, not inferred:

| Check | Result |
|---|---|
| `npm run build` (vite build + `tsc --noEmit`) | **exit 0** |
| `packages/shared` — `node --test "dist/**/*.test.js"` | **284 pass / 0 fail** |
| `apps/desktop` — `node --test "electron/**/*.test.cjs"` | **153 pass / 0 fail** |
| `npm run qa` (browser QA) | **NOT RUN after `d486b79`** |
| `npm run dist` | **NOT RUN after `d486b79`** |
| install + `npm run qa:app` | **NOT RUN after `d486b79`** |

Treat the last three as **unknown**, not as passing. In particular the theming change in
(6) is a visual change, and by this project's own rules a visual change is not complete
without installed evidence.

Measured earlier in the session, on `add99c3`, for context:
`packages/engine` **1052 pass / 37 fail**; `apps/relay` all pass except one
timing-sensitive run-boundedness test that timed out.

## 6.3 Orchestration attempt (superseded, but explains loose ends)

The user asked for a multi-agent pipeline rather than a single agent. Three author lane
sessions were set up on the split in §9, then **put to sleep at the user's request**
before any of them produced a commit or PR; they consumed no measurable compute. There
is nothing to recover from them. Their briefs are reproduced verbatim in §9 so any
platform can reconstitute the same lanes.

Session URLs, in case the user wants them: Lane A
`https://app.devin.ai/sessions/1eaede4af37f40b59f31b353bff647ba`, Lane B
`https://app.devin.ai/sessions/08891f315f4c49b1b0ca8372c54133e4`, Lane C
`https://app.devin.ai/sessions/d0121746dabe431ba75509a31465232c`. These are only
reachable by the user's own account on that platform.

---

# 7. Confirmed repository defects that are not yet fixed

Each was verified directly this session. None are speculative.

## 7-A. `npm test` never runs at all on Windows PowerShell

The scripts are:

| Workspace | `test` script |
|---|---|
| `packages/shared` | `npm run build && node --test dist/*.test.js` |
| `packages/engine` | `npm run build && node --test dist/*.test.js` |
| `apps/relay` | `npm run build && node --test --test-force-exit dist/*.test.js` |
| `apps/desktop` | `node --test electron/*.test.cjs` |

Root: `npm test` fans out to all four.

PowerShell does not expand `dist/*.test.js` for the child process, so Node receives the
literal string and exits with `Could not find '...\dist\*.test.js'` — **in every
workspace, before a single test executes**. A quoted recursive glob is correct on
Windows *and* on POSIX shells (where an unquoted glob would be expanded by the shell
instead):

```
node --test "dist/**/*.test.js"
node --test "electron/**/*.test.cjs"
```

Why this matters beyond convenience: `AGENTS.md` makes "the complete automated test
suite passed" a release gate, and on the user's own platform that gate has been passing
vacuously. Fix this first if you intend to trust any test evidence.

## 7-B. Nothing pins Node, and the project requires Node ≥ 22

`apps/relay/src/store.ts` imports `node:sqlite`, absent before Node 22. On Node 20 all
58 relay tests fail as `ERR_UNKNOWN_BUILTIN_MODULE` phantoms — a silent
not-green, exactly what `AGENTS.md` forbids. Some Electron dev dependencies additionally
warn they want `>= 22.12`. There is no `engines` field enforcing this, no `.nvmrc`, and
no CI.

The VM used this session defaulted to **Node v20.19.0** and had **Node 24.0.1** at
`C:\hostedtoolcache\node\24.0.1\x64`. Switching to 24 removed the phantom failures
entirely.

## 7-C. `ChannelRail` / `ReachGap` is dead code

Defined in `App.tsx`, **no call site anywhere in the repository** — 9 total matches
across the repo, all definition-side. The live `RoomPanel` exposes no reach-gap or fix
metadata at all. So the installed walk's failure message
`Drivecheck is not in the room's details panel` is not a selector problem: the surface
the check is looking for was never wired in. Blocker 2 therefore requires a product
integration decision, not a test tweak.

## 7-D. Engine safety guard rejects Windows 8.3 short paths

`packages/engine` fails 37 of 1089 tests on this VM. Several are the engine's own
unsafe-argument guard rejecting short paths:

```text
UnsafeArgumentError: refusing to run a command containing unsafe characters:
"C:\Users\ADMINI~1\AppData\Local\Temp\clo"
```

This is a genuine class bug, not just a VM artefact: **any** Windows username longer
than eight characters produces `NAME~1` short paths, and the user's own username is
`vikasmit` (eight — borderline; their temp path may or may not shorten). The remaining
failures of the 37 were not individually triaged. Do not paper these over; do not
`continue-on-error` them into green.

## 7-E. Relay run-boundedness test is timing-sensitive

One relay test timed out on this VM while the rest passed. Not investigated. It may be
genuinely flaky under load, which matters if you put the suite in CI.

## 7-F. `npm install` exits non-zero on Windows

Packages do install; the non-zero status comes from unsupported-engine warnings
(Electron wanting Node ≥ 22.12), **four high-severity audit findings**, and an npm
update notice. No dependency or security policy was changed this session, deliberately —
do not "fix" the audit findings as a side quest without asking.

---

# 8. The four open installed-app blockers, in depth

These come from `HANDOFF-GLOBAL-CHAT-SHELL-2026-08-12.md` §"Installed-app gate: not
green" and are all still open. The walk is `npm run qa:app` →
`scripts/drive-app.mjs`, driving the real installed binary at
`%LOCALAPPDATA%\Programs\Cloud9\Cloud9.exe`. "Drivecheck" is the agent the walk uses.

## 8.1 Blocked-agent presence line

**Symptom.** The check looks for `.agentrow[data-agent="Drivecheck"]`; that row is
hidden in the Focus layout, so the check fails.

**What is known true.** The durable state itself is correct — the row carries
`data-trouble="blocked"`. So this is a *visibility* problem, not a state problem.

**What is required.** Either prove the blocked state through a surface that is genuinely
visible with the current controls, or add a truthful visible projection of it. It must
render real durable state — never a hardcoded or optimistic indicator. Making the check
read a hidden node would violate the "a hidden DOM node is not evidence" rule and must
not be done.

**Suggested framing.** A user in Focus layout who has a blocked agent deserves to know
it; that argues for a real visible projection rather than a QA-only accommodation. But
that is a product judgement — surface it to the user if you are unsure.

## 8.2 Reach a real file

**Symptom.** The walk reports `Drivecheck is not in the room's details panel`.

**What is known true.** See §7-C: `ChannelRail`/`ReachGap` has no call site and
`RoomPanel` exposes no equivalent metadata. This is a product integration gap.

**What is required.** Decide — and write down the reasoning — whether `ReachGap` should
be integrated into the live `RoomPanel`, or whether reach-gap information should be
expressed some better way in the current design. Either is acceptable if truthful and
visible. **Deleting the dead code and declaring the blocker resolved is not acceptable:**
the user must be able to see, in the installed app, which agents can and cannot reach a
given file, and what concrete change would fix it.

Read what `ChannelRail`/`ReachGap` was designed to say before deciding, and read the
product intent in `docs/plans/`. Per the reference gate, understand the intended
behaviour before implementing.

## 8.3 Image understanding

**Symptom.** Drivecheck replied that **its engine was not connected** instead of
describing the image.

**Candidate causes, from the previous handoff, none yet discriminated:**

1. The installed engine sidecar failed to attach under packaging.
2. Room-membership setup was skipped after blocker 8.2 failed earlier in the walk — i.e.
   a cascade, not an independent defect.
3. A real packaged-provider defect (`SdkProvider` / credentials / Claude CLI resolution
   inside the package).

**My own assessment, offered as hypothesis and not as finding:** the cascade explanation
(2) is attractive because the walk is sequential and 8.2 fails before this point, and
because "engine not connected" is a *correct, truthful refusal* if membership or the
provider genuinely is not there. But nothing observed this session discriminates between
(1), (2) and (3). Do not promote any of them to a conclusion without evidence that the
relevant code path actually executed.

**Discriminating evidence to gather.** Whether the engine host process starts at all
under the installed binary; whether `scripts/engine-host.mjs` and any sidecar/tool
assets are actually present inside the packaged app (check
`scripts/prepare-packaging.mjs` and the electron-builder config for files that exist in
dev but are excluded from the package); whether path resolution in
`apps/desktop/electron/main.cjs` differs between `npm run dev` and packaged
(`app.isPackaged`, `process.resourcesPath`, `__dirname` inside an asar); whether the
Claude credential is visible to the packaged process; and what the installed app's own
logs say.

## 8.4 Stop a real turn

**Symptom.** No Stop control appeared.

**What is required.** The previous handoff is explicit: this **must be proven
independently** even though it may be a cascade of 8.3 / membership. Stop must actually
stop the underlying turn or process — hiding or showing a button is not the deliverable.
`packages/engine` contains process-stopping code; verify it end-to-end under the
installed binary.

## 8.5 Prescribed order of work — do not skip ahead

The previous handoff prescribes this sequence and it is sound:

1. **First prove the installed engine connects** — the installed binary, not `npm run dev`.
2. **Then prove the selected agent's exact room membership** in the installed app.
3. **Only then** judge image understanding and Stop, stating for each whether it was a
   genuine defect or a cascade of (1)/(2).

Most of the cascade hypothesis rests on membership, so proving it early is what stops
you chasing ghosts. Also: do **not** rerun the whole broad QA suite to diagnose a
bounded installed failure — reproduce the specific failing check.

## 8.6 Constraints on `scripts/drive-app.mjs`

- Use **visible current controls** only; never assert against hidden DOM nodes.
- Preserve the `--real-data` no-mutation contract: in real-data mode the walk must never
  mutate the user's real state.
- Report the real check counts and name every check still failing.

---

# 9. Lane briefs — bounded so parallel agents cannot collide

Reproduced in full so any platform can run the same decomposition. **`App.tsx` is a
single ~1 MB file; two agents editing it will conflict, and `TRACKER.md` records that
having already happened.** The split exists to prevent exactly that.

Lanes A, B and C are mutually independent and can run simultaneously. Each should branch
from `codex/global-chat-shell`, open a PR **into `codex/global-chat-shell`** (not
`master`), and be reviewed by a different agent than wrote it. The conductor folds.

```
git fetch origin
git checkout -b <lane-branch> origin/codex/global-chat-shell
```

## Lane A — installed blockers 1 and 2

**Owns exactly:** `apps/desktop/src/App.tsx`, `apps/desktop/src/styles.css`, and the
check bodies for blockers 1–2 in `scripts/drive-app.mjs`.
**Must not touch:** `apps/desktop/electron/**`, `packages/engine/**`, `package.json`,
`.github/**`, `packages/shared/src/threadwidth*`.

Tasks: §8.1 and §8.2 above. Read `ChannelRail`/`ReachGap` and the live `RoomPanel`
before deciding; document the reasoning; keep the visual language consistent with the
surrounding code, which is deliberate and strong. Proof required: `npm run build`
exit 0, the desktop test glob, `npm run qa` (report the real number against the 595/595
baseline), then the installed chain if reachable. Attach screenshots of the surfaces
added.

## Lane B — installed blockers 3 and 4

**Owns exactly:** `apps/desktop/electron/**`, `packages/engine/**`, `apps/relay/**` only
if the diagnosis genuinely lands there, and the check bodies for blockers 3–4 in
`scripts/drive-app.mjs`.
**Must not touch:** `apps/desktop/src/App.tsx`, `apps/desktop/src/styles.css`,
`package.json`, `.github/**`.

Tasks: §8.3, §8.4, in the order of §8.5. This is the lane where it is easiest to cheat,
so: if the engine genuinely cannot connect, the app must say so honestly and fail
closed, explaining how the user can enable it; never let the UI imply a model answered
when none did; never fabricate engine, image or Stop behaviour to satisfy a check. If a
demo/mock provider can satisfy the walk, that is only acceptable if the walk is honestly
labelled as exercising the mock — and say so loudly in the PR. Proof required: build,
the engine test glob (report the pre-existing 37 failures honestly; do not claim credit
for fixing them unless you did), then `npm run dist` → install → `npm run qa:app` with
real counts and every still-failing check named.

## Lane C — make the test gate real, pin Node, add CI

**Owns exactly:** root and workspace `package.json` (scripts and `engines` only), a new
`.nvmrc`/`.node-version` if useful, `.github/**`, and the short test/Node section of
`README.md` or `AGENTS.md`.
**Must not touch:** anything under `apps/desktop/src/`, `apps/desktop/electron/`,
`packages/engine/src/`, or `scripts/drive-app.mjs`.

Tasks: fix §7-A so `npm test` genuinely runs on Windows PowerShell **and** POSIX shells;
add `engines` for Node ≥ 22 per §7-B so an unsupported runtime fails loudly and
immediately; add a PR CI workflow running build + tests on a pinned Node ≥ 22 (no
secrets, no publish/release job, and do not gate on the installed walk, which is
Windows-desktop-only and local). **This lane changes how tests are invoked, never what
they assert** — do not touch any test expectation or any product behaviour.

Critically: **do not fix the §7-D engine failures in this lane, and do not paper over
them.** If CI goes red because of them, do not silence, skip or `continue-on-error` them
into green. Report precisely which tests fail and why, and let the conductor decide. An
honest red CI is the correct outcome of this lane if the tests genuinely fail.

## Shared-file coordination

`scripts/drive-app.mjs` is shared between Lanes A and B. Both must keep edits
**surgical**: only their own check bodies, no reformatting, no reordering, no helper
renames or restructuring. The conductor resolves any conflict.

---

# 10. Commands, environment, and the gotchas that cost time

## Release chain — serial, one at a time

```powershell
npm run build
npm test
npm run qa
npm run dist
powershell -ExecutionPolicy Bypass -File scripts/install-cloud9.ps1
npm run qa:app
```

The final walk must drive the actual installed binary. Only one build / package /
install / walk at a time.

## Root scripts, for reference

| Script | Command |
|---|---|
| `build` | builds shared, engine, relay, desktop, then `typecheck:app` |
| `typecheck:app` | `tsc -p apps/desktop/tsconfig.json --noEmit` |
| `test` | fans out to all four workspaces |
| `qa` | `node scripts/qa-stack.mjs` (browser QA) |
| `qa:smoke` | `node scripts/qa-stack.mjs --smoke` |
| `qa:app` | `node scripts/drive-app.mjs` (installed walk) |
| `pack` | build + `prepare-packaging.mjs` + desktop pack (unpacked build) |
| `dist` | build + `prepare-packaging.mjs` + desktop dist (Windows installer) |
| `dev:relay` | relay in dev |

## Quickstart on a fresh Windows box

```powershell
$env:Path="C:\hostedtoolcache\node\24.0.1\x64;"+$env:Path   # Node >= 22 is MANDATORY
node -v                                                      # confirm >= 22
npm install                                                  # exits non-zero on warnings; packages do install
npm run build                                                # must exit 0
cd packages/shared;   node --test "dist/**/*.test.js"        # observed 284/284
cd ../../apps/desktop; node --test "electron/**/*.test.cjs"  # observed 153/153
cd ../../packages/engine; node --test "dist/**/*.test.js"    # observed 1052 pass / 37 fail
cd ../../apps/relay;   node --test "dist/**/*.test.js"       # all but one timing-sensitive test
```

## Gotchas

- **Never use the default Node 20** — see §7-B.
- **Never trust `npm test` on PowerShell** until §7-A is fixed. Use the quoted recursive
  globs above per workspace.
- `npm run build` printing warnings (chunk > 500 kB) is normal; only the exit code
  matters. Piping its output through `Select-String` in PowerShell can mask the real exit
  code — check `$LASTEXITCODE` from the bare command instead.
- `git push` through the auth proxy writes its progress to stderr, so PowerShell reports
  it as `NativeCommandError` with a non-zero status even when the push succeeded. Confirm
  by reading the `old..new branch -> branch` line, or re-check `git status`.
- `gh` (GitHub CLI) was **not installed** on the VM. Use your platform's PR tooling or
  install it.
- The user's own working copy is `C:\Users\vikasmit\cloud9`, with the app already
  installed there. That path is on their PC and was **not** reachable from the VM; all
  work this session was done from a fresh GitHub clone. Do not write instructions that
  assume access to it.

---

# 11. Out of scope for #43, but real and waiting

Do not drift into these while #43 is open; do surface them when #43 lands.

- **Split `apps/desktop/src/App.tsx`.** ~1 MB, one file, the whole renderer. It is the
  single biggest brake on parallelism — it is *why* the lane split above has to be so
  careful. Highest-leverage refactor available.
- **The five-group IA** — Inbox / Chat / Build / Agents / Insights with Settings and
  Profile pinned, per `docs/cloud9-feature-architecture-and-roadmap-2026-08-09.md`.
- **The iPhone app.** Three tracked files. Effectively unstarted. Plus APNs and
  TestFlight.
- **The always-on server** so agents keep working when the desktop is closed (the engine
  host is currently in-process in Electron).
- **CI and Node pinning** — Lane C above covers the minimum.
- **The ~40 unlanded remote branches** (`origin/feature/*`, `origin/sol/*`,
  `origin/fix/*`, `origin/codex/*`): join invites, engineering canvas, hooks/rules
  editor, persistent notifications, project polls, huddle presence, internal social
  feed, public project updates, project forums, saved-later message queue, workflow list
  builder, thread drag-to-resize, and more. Someone should triage which are alive.
- **The four high-severity npm audit findings** and the engine 8.3-short-path bug
  (§7-D).

---

# 12. Open questions only the user can answer

1. **Thread sizing:** were 460/520 a deliberate by-eye choice on their display? If yes,
   `docs/threads-like-slack.html` must be re-measured; if no, the restored 388/300
   stands. (Asked; not answered before the session ended.)
2. **Blocker 8.1:** is a new visible blocked-agent projection in Focus layout wanted as
   product, or should the walk assert through an existing visible surface?
3. **Blocker 8.2:** integrate `ReachGap` into `RoomPanel`, or express reach-gap
   information differently in the current design?
4. **Global search:** implement room / agent / activity search (making the original copy
   true), or leave the narrowed copy?
5. **Priority after #43:** split `App.tsx`, or the five-group IA, or the mobile app?

---

# 13. Definition of done for PR #43

- All six review comments answered. **Done** (`d486b79`) — subject to question 12.1.
- All four installed blockers either fixed with installed evidence, or explicitly and
  honestly reported as still open with the diagnosis recorded.
- The full serial chain re-run after the final commit: build, test, qa, dist, install,
  qa:app — with real numbers, no skipped or timed-out checks counted as green.
- PR #43's description updated to state the truth, including anything still unproven.
- No version bump, no committed binaries, no modified test expectations, `.worktrees/`
  untouched.

If the installed walk is still not green when you finish, **say so**. That is a valid
outcome and this project is built to tolerate it. What it will not tolerate is a green
claim that is not true.
