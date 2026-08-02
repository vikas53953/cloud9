# Cloud9 feature 1 — shared Files workspace

Approved source: `HANDOFF-SOL.md` feature 1. This brief is the exact contract for all workers.

## Current truth
- Artifact chat cards, per-room lists, attribution, version history, exact-version downloads and producing-run links already exist. Extend them; do not rebuild them.
- Sol re-ran the baseline at `e738083`: build clean; 1,002 passed, 0 failed; QA 494/494 + 8/8 + 4/4.
- Worker agents never commit. Only Sol commits after the full installed-app evidence chain.

## Product contract
1. Add **Files** to the icon rail, after Tasks and before Projects.
2. Files is one workspace across every room the signed-in person can currently read, newest change first. List results are bounded and paginated; opening a row loads the full existing card/history.
3. Each row/detail names the room, latest maker, exact turn when present, date, version count and whether access is restricted.
4. Versions are append-only: publishing the same `(room, normalised name)` adds a new immutable row and immutable bytes. Old retained rows are never replaced or renumbered. Existing retention remains the newest 20 versions.
5. Permission choice approved by Vikas on 2026-08-02:
   - default: everyone currently in the source room;
   - optional: selected current human room members plus all current room managers;
   - only source-room owner/admin may change it;
   - direct conversations inherit room access and offer no separate editor in this release;
   - permission applies to the whole version chain;
   - it may narrow room access, never broaden it;
   - removing room membership or file access immediately blocks lists, detail, preview, ticket mint and redemption of already-minted tickets;
   - inaccessible and nonexistent stay indistinguishable.
6. Typed links are first-class stored data, never inferred from markdown. Two types only:
   - `made-from` — this exact version was made using that exact target version;
   - `goes-with` — companion deliverables.
   Links attach to the publishing version, target an exact version, stay inside one source room in this release, never grant access, and never substitute a newer target when the exact version is gone.
7. An agent declares a link through a private typed turn manifest at `.cloud9/artifact-links.json` in its work folder. Shape:
   ```json
   {"files":[{"name":"summary.pdf","note":"final figures","links":[{"kind":"made-from","target":{"artifactId":"af-123","version":2}}]}]}
   ```
   The engine only reads a manifest modified during the current turn, validates it through shared helpers, attaches matching rows to files produced in that turn, and never shares the manifest itself. A missing/old/bad manifest means no links and no note, with a plain refusal for bad current data rather than guessing.
8. The Files detail shows outgoing and permitted incoming links in plain words: Made from / Used to make / Goes with. A hidden target yields only “A linked file isn’t available to you.”
9. Add copy actions for the stable newest-file reference and the exact-version reference.
10. No upload, delete, public link, cross-room link, graph editor or manual relation editor in this release.

## Autonomous product defaults recorded for Vikas's later review
- I chose same-room typed links only in this first release — Vikas may overrule.
- I chose agent-declared typed manifests, not manual on-screen link editing — Vikas may overrule.
- I chose **Files** as the screen name — Vikas may overrule. It follows the standing plain-words law and the existing “Files agents made” wording.

## One owner per slice
- Shared worker: `packages/shared/src/index.ts` and new shared artifact-workspace tests only.
- Relay worker: `apps/relay/src/store.ts`, `apps/relay/src/server.ts`, and relay artifact/migration tests only.
- Engine worker: `packages/engine/src/artifacts.ts`, `packages/engine/src/engine.ts`, and engine artifact tests only.
- Desktop worker: `apps/desktop/src/App.tsx`, `apps/desktop/src/store.ts`, `apps/desktop/src/styles.css` only.
- QA worker: `scripts/qa.mjs`, `scripts/drive-app.mjs` only.
No worker edits another slice. No worker commits.

## Permanent evidence checks
- Shared/relay/engine tests cover validation, immutability, migration, permission filtering before limits, non-probing, ticket re-check, manifest age/shape, exact-version link pinning and hidden targets.
- `scripts/qa.mjs` covers Files rail/screen, cross-room list, honest empty/loading, attribution, history, copy refs, link wording/navigation, default/restricted access controls, revoked access, and 1280 + narrow width overflow in light/dark.
- `scripts/drive-app.mjs` creates a real two-version linked file in the installed app and walks the same visible behavior.
- At least one new permanent check is deliberately broken, watched fail, then restored before completion.
