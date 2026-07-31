# LANE E — engine edge-test coverage report

**Branch:** `cursor/engine-tests`
**Base:** `origin/master` @ `9375abb` ("Loop ledger: join-a-friend on screen (16/16)…") at worktree creation
**Scope:** NEW FILES ONLY. No existing `.ts` source was edited; the suites import the real modules (`./agent-memory.js`, `./agent-handoff.js`, `@cloud9/shared`).

## Files added

| File | Tests | What it edges |
|---|---|---|
| `packages/engine/src/agent-memory.edge.test.ts` | 17 | memory budget exactly at the limit; store keep/list floors; torn-file taxonomy; id range ends |
| `packages/engine/src/agent-handoff.edge.test.ts` | 17 | handoff with missing/oversized/wrong-typed fields; caps measured raw vs stored trimmed; wire-vs-builder fencing |
| `packages/engine/src/artifactref.edge.test.ts` | 20 | artifact refs at every sentence boundary; 40 refs in one message; finder/reader/writer asymmetries |
| `cursor-engine-tests-REPORT.md` | — | this file |

## Test summary

- New edge tests: **54 pass, 0 fail** (`node --test dist/agent-memory.edge.test.js dist/agent-handoff.edge.test.js dist/artifactref.edge.test.js`)
- Full engine suite with the new files included: **518 pass, 0 fail**
- Shared suite (artifact refs live there): **55 pass, 0 fail**
- Build: `tsc` clean for `@cloud9/shared` and `@cloud9/engine`

## Fail-proof (each suite watched to fail once)

Three rules were broken **in the compiled `dist/` only** (build artifacts, never sources), the suites run, then `tsc` rebuilt dist from the untouched sources:

| Broken rule (dist mutation) | Watched failure |
|---|---|
| `agent-memory.js`: budget check `>` → `>=` | "the character budget keeps the note that fits EXACTLY, and drops the one after" |
| `agent-handoff.js`: task cap `>` → `>=` | "a task at the EXACT cap is accepted" + "the task cap is measured on what was TYPED" |
| `shared/index.js`: trailing-punctuation trim removed | "a reference becomes a card at EVERY sentence boundary" + "forty references…" (5 failures total across the three runs) |

After rebuild: 54/54 green again. `git status` confirms only the three new test files are untracked; dist restored byte-identical.

## Findings surfaced by the edges (behavior pinned, NOT fixed — owner lanes decide)

1. **`validateHandoff` can throw, though its doc says it never does.** A wire frame with `artifact: null` passes the `typeof null === "object"` check and crashes on the property read (`TypeError`). The builder treats a null artifact as absent. Pinned in "a null artifact is no artifact to the builder — and a CRASH to the wire validator".
2. **Memory prune contradicts its own header.** The module comment says "the OLDEST are pruned" and the base suite's title says "keeps its most recent notes", but `prune()` keeps the OLDEST `keep` notes and deletes the newest — consistent with retrieval's foundation-first rule. The base test only asserts the count. Pinned in "when the keep cap bites, the OLDEST notes survive on disk", with a comment pointing at the mismatch.
3. **`MemoryStore` does not re-check the agent id.** `agentId: "../x"` writes outside the `agents/` folder; the only fence is `opts.agentDataDir` ("the engine already owns this decision"). Pinned as a trust-boundary test so hardening it later changes the test on purpose.
4. **Finder/reader asymmetries in artifact refs** (all pinned): `@0` kills the whole ref with no unversioned fallback; `@-2` and a bare `@` are punctuation to the finder but refusals to the strict reader; `@007` normalizes to version 7 and dedupes with `@7`; `artifactRef` will happily build strings the reader refuses (writer is dumb, reader is the gate).
5. **Task/note caps are measured on what was typed, before trimming** — 500 chars + a trailing space throws even though the trimmed task would fit. Pinned both directions.

## Reproduce

```bash
git worktree add cursor/engine-tests  # branch exists on origin
npm install
npm run build -w @cloud9/shared -w @cloud9/engine
node --test packages/engine/dist/agent-memory.edge.test.js packages/engine/dist/agent-handoff.edge.test.js packages/engine/dist/artifactref.edge.test.js
```
