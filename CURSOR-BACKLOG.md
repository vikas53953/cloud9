# CURSOR BACKLOG — ROUND 3 — SPAWN MANY, FRONTIER MODELS ONLY

## >>> RUN FULLY AUTONOMOUS — NEVER WAIT FOR APPROVAL <<<
Turn ON auto-run / "run without asking" / YOLO mode for every agent. Do NOT pause
on "approve this command?" — you have standing permission to run builds, tests,
git add/commit, and push YOUR OWN branch. If a step would need Vikas, SKIP it,
note it in your report, move on. Permanent rules that are NOT approvals and must
never be bypassed: never push/merge `master`, never open a PR, never edit a
forbidden file.

Lanes G/J/M/N from the previous rounds are DONE and merged — do NOT redo them.
Spawn as many agents as you can, ONE PER LANE below, each on a TOP FRONTIER model
(GPT-5 / Claude Sonnet / Kimi K2 / Grok 4.5 — never a mini/fast/lite). SEVEN
independent lanes; run them all in parallel if your plan allows.

A Claude conductor's own agents are editing the wiring/screen files right now, so
every lane here is **NEW FILES ONLY** — that is what makes running seven agents at
once safe: each writes different new files, colliding with nothing.

## HARD RULES (all lanes)
1. Each lane = its OWN branch off `origin/master`
   (`git fetch origin && git checkout -B <branch> origin/master`). Push only your
   branch. NEVER touch `master`, never open a PR.
2. **CREATE NEW FILES ONLY. Edit NO existing file.** Never open `engine.ts`,
   `packages/shared/src/index.ts`, `apps/relay/src/server.ts`, `apps/desktop/**`,
   `scripts/qa.mjs`, `github-ops.*`, `notify.ts`, `agent-memory.ts`,
   `agent-handoff.ts`, `joinhub.ts`, or the `hub*.ts` modules. Import what you
   test BY PATH (`./hubaddress.js`). If a task seems to need editing an existing
   file, STOP it and write why in your report.
3. `npm install`, then gate: `npm run build` clean; run your new tests with
   `node --test <your files>` and paste counts. Do NOT run `npm run qa`/`qa:app`.
4. Prove each test can fail (break once, watch fail, restore); record the pairs.
   Never claim without running.
5. Write `<branch>-REPORT.md` at the repo root. Small commits.
6. A found real defect is a SUCCESS — write it up; do NOT fix an existing file.

---

## LANE H — Fuzz tests for the join-a-hub + notify modules
Branch `cursor/harden-hub` · new files `packages/shared/src/hubaddress.fuzz.test.ts`,
`hubbook.fuzz.test.ts`, `hubconnection.fuzz.test.ts`, `notify.fuzz.test.ts`.
Throw hostile input (zero-width/bidi/confusable unicode, 100k strings, boundary
numbers 0/-1/2^53/NaN/Infinity, malformed shapes, `__proto__`/`constructor` keys,
every IP boundary) at each module's public functions; assert it never throws,
never leaks, always a plain refusal or safe value. For hubconnection drive
thousands of random event sequences; assert the state stays valid (phase in
union, attempts ≥ 0, self never falls back).

## LANE J — Fuzz + property tests for join-hub tokens
Branch `cursor/harden-joinhub` · new file `apps/relay/src/joinhub.fuzz.test.ts`.
Assert single-use / expiry / revoke hold under out-of-order, replayed, concurrent
events; a token never verifies twice; revoked/expired never admits; malformed
token strings refuse plainly.

## LANE R — Relay store test coverage (new test files; do NOT edit store.ts)
Branch `cursor/relay-store-tests` · new files e.g. `apps/relay/src/store.coverage.test.ts`.
READ store.ts; add tests for behaviours not already covered: search parity edges,
unread near the cap, retention pruning boundaries, channel role transitions,
attachment ticket single-use races. Import the real store; never modify it.

## LANE E — Engine module test coverage (new test files; NOT github-ops)
Branch `cursor/engine-tests` · new files e.g. `agent-memory.edge.test.ts`,
`agent-handoff.edge.test.ts`, `artifactref.edge.test.ts`. Deepen edge coverage of
the merged engine modules: memory budget exactly at the limit, handoff with
missing/oversized fields, artifact refs at sentence boundaries and many refs.

## LANE C — Codex isolation audit (READ-ONLY + one new doc)
Branch `cursor/codex-audit` · new file `docs/qa/codex-isolation-audit.md`. No code
changes. Read `codex.ts`, `claude-cli.ts`, `abilities.ts`, `host.ts`; produce a
precise plain-words audit of exactly what a Codex agent inherits that it should
not (tools, skills, MCP, config, env) vs a Claude agent, WHY (cite lines), and a
proposed class-fix in words. Tag findings CONFIRMED / SUSPECTED.

## LANE U — The user guide, in Vikas's words (new doc)
Branch `cursor/user-guide` · new file `docs/USER-GUIDE.md`. Vikas is a network
engineer, NOT a developer. Write a plain-words guide to EVERYTHING Cloud9 does
today (read the code + HANDOFF.md/RESUME.md; never invent a feature): agents,
chat, rooms, jobs, projects, skills, the reach ladder, artifact cards, approvals,
GitHub commands (!issue/!comment/!review), connect-to-a-friend. Short sections,
no jargon; say honestly what is "not on screen yet".

## LANE T — Tailscale setup, concrete (new files)
Branch `cursor/tailscale` · new files `docs/plans/tailscale-steps.md` and
`scripts/check-network.ps1`. Write EXACT click-by-click steps for Vikas to put his
PC and phone on a tailnet, and a READ-ONLY PowerShell checker reporting whether
Tailscale is installed, signed in, and this machine's 100.x address — no system
changes, plain sentences, graceful refusal if not installed.

---

## When a lane is done
Push its branch, write `<branch>-REPORT.md`, tell Vikas. The conductor reviews and
merges each. Then re-enter THE LOOP (CURSOR-BRIEF.md) for the next round.
