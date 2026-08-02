# Cloud9 — mission plan for Sol (GPT-5.6 in Claude Code)

From the outgoing Fable 5 session, 2026-08-02. This is your build plan, not a
rulebook: you are the conductor. Spawn worker agents (your Agent tool) for the
heavy lifting, run several in parallel when their files don't overlap, and move
through the feature queue one feature at a time until it's done. Vikas is
watching results, not process — interrupt him only when a real product decision
is his to make, and always with your recommendation attached.

Context to load first: `HANDOFF.md` (what the product is), `RESUME.md` (history),
`implementation-notes.md` (the running ledger — append what you fix and find).
Repo `github.com/vikas53953/cloud9`, branch `master`, start at commit `06eee71`.

## How to run each feature (the loop that has been working)

1. **Scout inline** — read the code that's already there; half of Vikas's wish
   list partly exists (see the map below). Never rebuild what exists.
2. **Spawn workers** — one agent per independent slice, each with its own files
   and its own ports; give each the exact acceptance checks it must add.
3. **You verify, not the workers**: `npm run build` → `npm test` (1002/0 now) →
   `npm run qa` (494/494 + 8/8 + 4/4 now — counts only grow) → `npm run dist` →
   install `release\Cloud9-Setup-0.1.0.exe /S` → `npm run qa:app` (21/21 now).
4. **Extend the checks** — every new feature gets permanent checks in
   `scripts/qa.mjs` AND the installed-app walk `scripts/drive-app.mjs`, and you
   break one once to prove it can fail.
5. **Commit + push** with a plain-words message, append the ledger, publish an
   HTML report page for Vikas (inline `~/.claude/review-kit/feedback-layer.js`,
   mark sections `data-fb="…"`) ending with TEST IT steps.
6. **Move to the next feature without waiting** — Vikas asked for the whole
   queue; pause only on genuine product forks.

Traps already paid for — don't pay again:
- QA runs against the last `npm run build`, never your working tree.
- `qa:app` refuses a stale install on purpose (bundle byte-compare) — install
  the fresh Setup exe silently before walking.
- Capture exit codes explicitly and save full QA logs; a pipe once swallowed a
  failure and cost a day of guessing.
- Fake killed-write litter in tests only via `packages/engine/src/litter-for-tests.ts`.
- The app never holds an API key or GitHub token — it spawns the CLIs on this
  PC (`claude`, `codex`, `gh`). Keep it that way; it's the product's core promise.
- Everything on screen says WHEN it was checked; empty states say why; approval
  cards count facts from git/gh, never quote the agent.
- All UI lives in `apps/desktop/src/App.tsx`; hub `apps/relay`; engine
  `packages/engine`; frames `packages/shared`. His real data `%APPDATA%\cloud9`;
  repo-root db is dev-only.

## What already exists (so workers extend, not rebuild)

GitHub: Settings card (dated, signed in as vikas53953), repo picker with
click-connect, per-project local folder link, `!issue`/`!comment`/`!review`/`!code`
with counted approval cards, branch+PR always. Actions menu at the composer
(one table, drift-tested against `engine.ts`). Notifications with quiet hours.
Mentions, threads, reactions, unread, room chat search. `!bg` + `!schedule`.
Agent memory (`!remember`) + handoff (`!handoff`). Presence with reasons. Codex
un-removable switches render locked-ON (`effectiveAbilities()` in
`packages/engine/src/abilities.ts` — the one owner). Join-a-hub address book.
Skill library, marketplace, 13 discovered models.

## The queue (his order — one at a time, each fully proven before the next)

**1. Shared artifact workspace.** Attribution, immutable versions, links between
artifacts, permissions. Today agent files appear as chat cards
(`packages/engine/src/artifacts.ts`, hub file store) — the workspace screen,
version chain, and permissions are new. Design notes: versions are append-only
(a new version never edits an old row); every artifact names who made it and in
which turn; permissions default to room-visibility; links are typed references,
not markdown strings. Give it its own icon-rail screen.

**2. GitHub round 2.** After Vikas tests round 1, whatever he reports — likely
on-screen diff review for PRs and per-repo rooms. Don't start until his feedback
lands; skip ahead to 3 if none arrives.

**3. Search everywhere.** One search over chat, threads, artifacts (names +
contents + versions), with filters (room, agent, date, kind). The relay already
has FTS for messages — extend the same index rather than adding a second engine.

**4. Turn coordination.** When two agents could answer, exactly one does:
an owner per question, deduplicated replies, visible handoffs/dependencies
("waiting on @Architect"), and richer failure states (blocked/failed + the
error in plain words on the presence chip and the job record).

**5. Notifications round 2 + integrations + mobile groundwork.** Digest
options, per-room rules, webhooks in/out. The phone app is a scaffold that has
NEVER run — any mobile claim must start from that honest fact.

Open smaller items to weave in when nearby: skill-shelf ordering forgets the
hiring template after save (needs a field on `AgentDef`); Codex model list
lacks a provenance sentence (`packages/engine/src/harness.ts`); narrow window
widths are untested. Vikas's own step, whenever he chooses: the Tailscale
browser sign-in (`docs/plans/tailscale-steps.md`) that makes friends-over-
internet real.

Write your progress into the ledger as you go, keep every report page published,
and leave the tree the way you'd want to find it: green, installed, walked.
