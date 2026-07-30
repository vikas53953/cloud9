# CURSOR BACKLOG — spawn one agent per LANE, in parallel, best model each

Vikas is away ~2–3 hours and wants Cloud9's remaining features BUILT. Cursor
has several strong models (GPT-5, Sonnet, Kimi K2, Grok 4.5). Spawn ONE agent
per lane below, each on its own branch, ideally a different model. A Claude
conductor reviews and merges every branch — you never touch `master`.

## THE LAW FOR EVERY LANE (read once, applies to all)

1. Each lane works on ITS OWN branch, created from `origin/master`:
   `git fetch origin && git checkout -B <lane-branch> origin/master`
2. Push only your lane branch. NEVER push/merge `master`, NEVER open a PR.
3. **EXCLUSIVE FILES:** each lane lists the ONLY files it may create or edit.
   Touching another lane's files, or any file under `apps/desktop/**`, gets your
   work dropped in a conflict. `apps/desktop/**` and `scripts/qa.mjs` are OFF
   LIMITS to every Cursor lane — the screen is built by the conductor's own
   agents to keep one owner.
4. Build STANDALONE modules with tests + a short contract doc in `docs/plans/`.
   Do NOT wire into `engine.ts`, `host.ts`, `provider.ts`, or `server.ts` — list
   the wiring you WOULD do in your contract doc; the conductor wires it in. This
   is the proven pattern (see `docs/plans/artifact-store-handoff.md`).
5. Never claim without running. `npm install`, then `npm run build` clean and
   your package's tests green before you push. Do NOT run `npm run qa`.
6. Fix the class, one owner per rule. Prove every test can fail (break it once,
   watch it fail, restore) and record the pairs.
7. Write `<lane-branch>-REPORT.md` at the repo root: what you built, the
   contract, real test counts, files touched, break-proof pairs.

Reference reading (do not edit): `HANDOFF.md`, `RESUME.md`,
`docs/plans/turn-brief-handoff.md`, `docs/plans/artifact-store-handoff.md`,
`docs/plans/approval-handoff.md`, `docs/qa/gap-audit.md`.

---

## LANE G — GitHub, the deep version (HIGHEST PRIORITY, Vikas named it)
Branch: `cursor/github-engine`
Exclusive files: NEW `packages/engine/src/github-ops.ts`, `github-ops.test.ts`;
NEW `docs/plans/github-ops-handoff.md`. You may READ `packages/engine/src/*`.

Today an agent can already work on its own branch and open a pull request
(`!code`/`!publish`, see `approval-handoff.md`). Build the REST of "work like a
real developer on GitHub", each operation as a pure function that BUILDS the
`gh`/`git` command line (returns argv + a plain-words description of what it
will do) — it does NOT execute anything; the engine runs it behind the existing
approval card. Cover: open an issue, comment on an issue/PR, request review,
list/read PR review comments, check out and update an existing PR branch,
resolve a review thread, and read CI status. Reuse `commandLine()` and the
read-only allowlist ideas already in the repo. Every WRITE operation returns a
flag `needsApproval: true` and the facts (repo, branch, what changes) COUNTED,
never quoted from the agent. Tests: each op builds the exact argv; the comma/
injection guard is run against every command line; a write op without approval
throws. Contract doc: the frames the hub and screen need to drive this.

## LANE J — Join a friend's Cloud9, relay side (the #1 missing feature)
Branch: `cursor/join-hub`
Exclusive files: NEW `apps/relay/src/joinhub.ts`, `joinhub.test.ts`; NEW
`docs/plans/join-hub-handoff.md`. You may READ `apps/relay/src/server.ts`,
`store.ts`, `secureid.ts`.

The conductor has already merged `packages/shared/src/hubaddress.ts` (parses and
classifies a hub address; refuses public-internet addresses; import it, DO NOT
reimplement). Build the hub side of letting a friend join:
- a "join token" distinct from a channel invite: it admits a NEW PERSON to the
  HUB itself (not a channel), single-use, expiring, revocable, minted with
  `secureId`/`secureToken`. Model it in `joinhub.ts` with a store-shaped
  interface it does not itself own (define the interface; the conductor backs it
  with SQLite), so it is fully unit-testable with a fake store.
- the rule for binding the hub beyond loopback SAFELY: a function that decides,
  given config, whether the server may listen on a Tailscale/LAN interface vs
  loopback-only, defaulting to loopback and refusing `0.0.0.0`/public in words.
  Use `classifyHost` from `@cloud9/shared`.
Tests: token mint/verify/expire/revoke/single-use; binding decision for
loopback / Tailscale / LAN / public. Contract doc: the exact `server.ts` wiring
and the client→hub `joinWithToken` frame the conductor will add.

## LANE M — Agent memory + agent-to-agent handoff (engine)
Branch: `cursor/agent-memory`
Exclusive files: NEW `packages/engine/src/agent-memory.ts`,
`agent-memory.test.ts`, `agent-handoff.ts`, `agent-handoff.test.ts`; NEW
`docs/plans/agent-memory-handoff.md`. READ the rest of engine.

Two "not done at all" gaps (HANDOFF §6): agents remember nothing between
conversations, and cannot hand work to each other.
- Memory: a compact, per-agent durable "what I learned / decided" store —
  append-only notes with a size budget (reuse the budgeting idea in
  `context.ts`; do NOT edit it), retrievable to seed a later turn's context.
  Model the persistence behind an interface (fake store in tests). Include a
  rule for what is worth remembering vs conversational noise.
- Handoff: a structured "@AgentB, take this from here" object one agent's turn
  can emit — the task, the context pointer, the artifact/branch it produced —
  that the engine can turn into a new turn for another agent. Pure builder +
  validation; no execution. Tests for both; contract doc for the engine wiring.

## LANE N — Notifications (engine + relay module)
Branch: `cursor/notifications`
Exclusive files: NEW `packages/shared/src/notify.ts`, `notify.test.ts`; NEW
`docs/plans/notify-handoff.md`. READ only.

Vikas asked for notifications (weak/absent in the gap analysis). Build the pure
core: what events raise a notification (job finished, an agent asked for
approval, a mention, an artifact published), the rules for quiet-hours and
de-duplication (already a "quiet hours" idea exists in Settings — match it),
and the shape of a notification a screen or an OS toast would render. No OS
integration, no screen — a tested rules module and a contract doc naming the
frame and where the desktop and any future phone read it.

---

## When your lane is done
Push your branch, write `<branch>-REPORT.md`, and tell Vikas which lanes are
pushed. The conductor fetches each branch, re-runs build+tests, wires the module
in per your contract, and merges. If two lanes need the same NEW file name,
whoever pushes second renames — say so in the report.
