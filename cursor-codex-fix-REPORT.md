# Codex isolation fix report

Branch: `cursor/codex-fix`

## Contract

Codex CLI 0.146.0 still cannot declare or subtract its complete built-in tool
set. Cloud9 now fails closed: a Codex turn does not start unless the switches
for the unavoidable web, file, helper-agent, and command tools are all on.
This is an admission gate, not a prompt-only promise.

Each admitted turn also gets a disposable `CODEX_HOME` and user home. Only
`auth.json` is copied in. A one-turn Codex profile disables every owner skill
found under both `$CODEX_HOME/skills` and `~/.agents/skills`, including
symlinked skill folders. The temporary home is deleted after the turn.

## Findings F1-F7

- **F1 — no Codex `--tools`: mitigated with a hard gate.** `codexArgs` validates
  the agent against the unavoidable Codex surfaces before building argv. An
  unsafe ability mix throws `HarnessAbilityBoundaryError`; the runner is never
  called.
- **F2 — helper agents survive helpers-off: fixed fail-closed.** Turning
  `helpers` off refuses the whole Codex turn before `collaboration.*` can reach
  a model.
- **F3 — web survives webSearch-off: fixed fail-closed.** Turning `webSearch`
  off refuses the whole Codex turn; the ineffective `tools.web_search=false`
  flag is no longer treated as a boundary.
- **F4 — shell/patch always present: fixed fail-closed.** Both `files` and
  `commands` must be on before a Codex turn can start. This covers read/write
  and execution semantics instead of treating a read-only sandbox as tool
  removal.
- **F5 — owner skills leak: fixed.** A disposable home removes the old
  `$CODEX_HOME/skills` root. The generated isolation profile disables exact
  `~/.agents/skills` paths because Codex on Windows resolves that root through
  the OS profile rather than the child `HOME`. A live `codex debug
  prompt-input` render reported `ownerSkillsLeaked:false`, while `codex login
  status` against the same isolated home returned logged in.
- **F6 — inert switches: disposition split by ownership.** `commands` is now a
  hard admission gate. `schedules`, `background`, and `connections` do not map
  to surviving Codex built-ins; they continue to gate Cloud9's scheduler,
  background orchestration, and supplied MCP configuration. `wholeComputer`
  continues to gate `--add-dir`.
- **F7 — dishonest prompt: fixed.** Codex prompts no longer claim that no
  unlisted tools exist. They state that unavoidable Codex tools must be
  switched on or Cloud9 refuses the turn. No admitted prompt says “CANNOT” for
  web, files, helper agents, or commands that Codex still carries.

The screen keeps its existing “Codex cannot declare every tool” warning. The
runtime gate is named there, and the three unavoidable built-in groups remain
listed. Owner skills are no longer listed as loaded.

## Tests and proof

Red tests were observed before implementation:

1. The first boundary/isolated-home tests failed compilation because
   `codexAbilityBoundaryProblems` and `createCodexIsolatedEnvironment` did not
   exist (`TS2305`).
2. The skill-profile test failed compilation because
   `CODEX_ISOLATION_PROFILE` and `ownerUserHome` did not exist.
3. The symlink test then failed with
   `symlinked owner skills are disabled too`; the generated profile contained
   only ordinary skill folders.
4. The plain refusal test failed compilation because
   `HarnessAbilityBoundaryError` did not exist.

Final evidence:

- `npm run build`: pass for shared, engine, relay, desktop, and desktop
  typecheck.
- `npm test`: pass — shared 71/71; engine 535/535; relay 309 passed with 4
  skipped and 0 failed; desktop 11/11.
- `npm run qa` on isolated ports: pass — `qa.mjs` 461/461, `qa-v2.mjs` 8/8,
  `qa-lifecycle.mjs` 4/4.
- Focused Codex/abilities/isolation/host regression run: 56/56 pass.
- Live offline prompt render: `loginCode:0`, `loggedIn:true`,
  `profileCode:0`, `ownerSkillsLeaked:false`.

## Files

- `packages/engine/src/abilities.ts`
- `packages/engine/src/abilities.test.ts`
- `packages/engine/src/codex.ts`
- `packages/engine/src/codex.test.ts`
- `packages/engine/src/provider.ts`
- `packages/engine/src/isolation.ts`
- `packages/engine/src/isolation.test.ts`
- `packages/engine/src/host.test.ts`
- `packages/engine/src/run.test.ts`
- `cursor-codex-fix-REPORT.md`

One measured unknown remains explicit in `isolation.ts`: the copied login works
today, but refresh-token rotation across repeated disposable auth clones has not
been live-probed.
