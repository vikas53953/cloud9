# Cursor Codex Audit — Lane C REPORT

**Mandate:** AUTO-RUN, read-only code audit, new files only. Never touch
master/PR. No code changes.

**Branch:** `cursor/codex-audit`
**Worktree:** `C:\Users\vikasmit\cloud9-cursor-lane-C` (based on `origin/master`)
**Base SHA:** `9375abbb651d6c6bbb61d02601f9566e0186d455`

## What I did

Read (read-only) `packages/engine/src/codex.ts`, `claude-cli.ts`, `abilities.ts`,
`host.ts`, plus `isolation.ts` and `env.ts` for context. Produced a plain-words
audit of exactly what a Codex agent inherits that a Claude agent does not, why
(with line citations), and a class-level fix — all tagged CONFIRMED / SUSPECTED.

No source was modified. Two new files only:

- `docs/qa/codex-isolation-audit.md` — the full audit.
- `cursor-codex-audit-REPORT.md` — this report.

## Headline

A Claude agent runs inside a **declared** tool set (`--tools` +
`--disallowed-tools`), so an un-granted tool never arrives. A Codex agent runs
inside a **fence** — `codex exec` has **no tool-declaration flag** — so the whole
built-in surface is always present and the ability switches only move the
sandbox. The engine already documents this honestly in `isolation.ts`
(`togglesAreTheBoundary = false` for Codex); this audit confirms it against the
code and proposes making that contract enforced rather than merely described.

## Findings (counts)

- **CONFIRMED — 7**
  - F1 No `--tools` on Codex (root cause) — `codex.ts:261-268,288` vs
    `claude-cli.ts:392`.
  - F2 `collaboration.*` / `spawn_agent` survives helpers-off — `codex.ts:266-267,
    338-344,398-405`.
  - F3 `web.run` survives webSearch-off — `codex.ts:268,391-397`.
  - F4 `exec`/`shell_command`/`apply_patch` always present, sandbox-fenced only —
    `codex.ts:269-270,373-375`.
  - F5 Owner skills load from `$CODEX_HOME/skills` **and** `~/.agents/skills` —
    `codex.ts:272-280`.
  - F6 `schedules`/`background`/`connections`/`commands` switches inert on Codex;
    `commands` neither grants nor gates the shell — `codex.ts:338-344,363-407`,
    `abilities.ts:90-100`.
  - F7 Prompt tells a Codex agent it "CANNOT" do things it can — `codex.ts:431-434`,
    `abilities.ts:486-520`.
- **SUSPECTED — 2**
  - F8 read-only sandbox may not block network egress / outside reads.
  - F9 shared `~/.agents/skills` content impact unmeasured.
- **Parity already achieved (no leak) — 4:** credential env stripping
  (`env.ts`, `codex.ts:445`), owner MCP servers (`codex.ts:427-430`),
  `config.toml`/`.rules` (`codex.ts:245-256,288`), `CODEX_ALWAYS_DISABLED`
  (`codex.ts:316-324`).

## Proposed class-fix (summary)

1. Promote `togglesAreTheBoundary` from caption to run-time gate.
2. Drive Codex as sandbox-only and stop pretending its toggles gate tools.
3. Build the Codex prompt from the real surface (`HARNESS_ISOLATION`), never
   emit "CANNOT" for a surviving tool.
4. Contain skills via a Cloud9-owned populated `CODEX_HOME` (real `auth.json`,
   empty `skills/`) + scratch `HOME` for `~/.agents/skills` (feasibility
   SUSPECTED — probe that copied auth survives).
5. One class test asserting the boundary claim per harness.

Full detail, side-by-side table and line citations: `docs/qa/codex-isolation-audit.md`.

## Build / tests

Not required by the mandate; no code changed, so no test run was necessary. This
was a documentation-only, read-only audit.
