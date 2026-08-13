# Lane J1 — palette token groundwork (Cursor agent brief)

You are one lane in a multi-agent pipeline on this repo. This lane is **new files
only** — you must not modify any existing file except where step 6 says so.
Other agents are editing `apps/desktop/src/App.tsx` and
`apps/desktop/src/styles.css` right now; touching them from this lane will
cause a collision and your work will be rejected.

## Why this lane exists

Two independent audits measured the app's 16 color palettes and found 260
failing color combinations (82 critical — e.g. the primary button renders
1.00:1, literally invisible, in dracula under a light OS). Root cause: palette
blocks are partial deltas over a light-only base; none declares the "ink that
sits ON a colored control" (`--on-ink`, `--on-pine`, `--on-gold`), so those
tokens leak in from an OS media query at a different CSS specificity.

The class fix has two halves:
- **J1 (this lane): build the generator + guard tests as NEW files.**
- J2 (a later lane, not yours): swap `styles.css` to consume the generated
  blocks and delete the media-query token block. Do not attempt J2.

## What to build

1. `packages/shared/src/palettes.ts` — the single source of truth: a typed
   table of all 16 palettes (names must exactly match the `PALETTES` registry
   in `apps/desktop/src/App.tsx` around line 1828 — read it, copy the names
   and current colors from `styles.css`'s `:root[data-theme="X"]` blocks).
   Each palette entry must carry the COMPLETE token contract — all 54
   color/semantic tokens declared by the base `:root` block in `styles.css`
   (L22). Where today's palette blocks omit a token, fill it with the correct
   family value (dark palettes get dark-family completions, light get light),
   NOT the base light value.
2. Derived tokens: implement `onColor(bg)` — relative-luminance compare of
   `#08120F` vs `#FFFFFF` (the same algorithm `applyTheme` in App.tsx already
   uses for custom accents, ~L2172) — and generate `--on-ink`, `--on-pine`,
   `--on-gold` from each palette's own `--ink`, `--pine`, `--marigold-hi`.
   Also generate per palette: `--disabled-bg`, `--disabled-text`,
   `--disabled-border` (each ≥3:1 against that palette's `--surface`),
   `--line-strong` (≥3:1 vs `--surface` and `--bg`), and `--focus-ring`
   (≥3:1 vs `--bg`).
3. `packages/shared/src/palettes.test.ts` — following the repo's node:test
   conventions: (a) every palette declares the full 54-token contract;
   (b) WCAG contrast floors hold for ~20 named component pairs (text ≥4.5:1,
   UI/borders/focus ≥3:1) across all 16 palettes — failures must print
   `palette | component | ratio | hex on hex`; (c) every enabled pair beats
   the palette's disabled pair by ≥1.4×.
4. `scripts/generate-palette-css.mjs` — emits the 16 `:root[data-theme="X"]`
   CSS blocks (to stdout or a `--out` path) from the table, deterministic
   output, so J2 can paste/import them. Do NOT wire it into the build yet.
5. Reference data you may use: `docs/qa/ux-walk-2026-08-12/contrast-data.json`
   and the scripts beside it (measured ratios from the installed app).
6. The ONLY existing-file edit allowed: add the new test to
   `packages/shared`'s test glob if it would not already be picked up by
   `node --test "dist/**/*.test.js"` (it will be — so most likely you edit
   nothing).

## Rules (binding, from AGENTS.md and the pipeline)

- Branch `codex/pr43-lane-j1` from `origin/codex/global-chat-shell`
  (fetch first — the branch moves). Work in a fresh worktree or clone.
- NEVER use `git stash` (shared across worktrees on this machine).
- No version bump. No binaries. Do not modify any existing test.
- Verify honestly: `npm run build` exit 0, then from `packages/shared`:
  `node --test "dist/**/*.test.js"` — report the real numbers in the PR.
- Open the PR into `codex/global-chat-shell` (NOT master). PR body: what was
  generated, how completions were chosen for previously-missing tokens, real
  test numbers, and anything unverified.
- An honest red is worth more than a fabricated green. Never claim a check
  you did not run.

The pipeline's independent reviewers will review the PR like every other lane.
