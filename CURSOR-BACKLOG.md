# CURSOR BACKLOG — ROUND 4 — the last two features, FULL STACK, ON SCREEN

## >>> RUN FULLY AUTONOMOUS — AUTO-RUN, NEVER WAIT FOR APPROVAL <<<
Turn on auto-run/YOLO. Standing permission to run builds, tests, git add/commit,
and push YOUR OWN branch. Never push/merge master, never open a PR. If a step
would need Vikas, skip it, note it in your report, move on.

**This round is different:** these two lanes MAY edit the screen (apps/desktop/**)
and wire into engine/hub — they are the last two features and each must end up
CLICKABLE, not "built underneath". Two lanes, two branches, two agents, different
frontier models, in parallel.

## RULES (both lanes)
1. Each lane its own branch off origin/master
   (git fetch origin && git checkout -B <branch> origin/master). Push only your
   branch. Never touch master, never a PR.
2. If you BOTH must touch apps/desktop/src/App.tsx, keep your change to a SINGLE
   small mount point (import one new component, render it once). Do NOT reformat
   the file — that lets the conductor merge both trivially.
3. Never claim without running. Gate: npm run build clean, npm test green,
   npm run qa green (raise EXPECTED_CHECKS by exactly what you add; prove each new
   check by breaking it once). Reuse the Studio design in App.tsx — no new look.
4. Write <branch>-REPORT.md: what's on screen, files changed, real counts,
   break-proof pairs, anything deferred.

---

## LANE MEM — Agent memory + handoff, ON SCREEN   (branch cursor/mem-screen)
Already merged & tested: packages/engine/src/agent-memory.ts (durable per-agent
notes with a budget) and agent-handoff.ts (a structured "@AgentB take this"
object). READ docs/plans/agent-memory-handoff.md FIRST. Wire so Vikas SEES + USES it:
- Memory in the turn: an agent's turn seeds its context from its own saved notes,
  and can write a note it wants to keep (per the contract). Persist notes (SQLite
  table in apps/relay/src/store.ts + hub frames in server.ts, or the engine's own
  store — follow the doc).
- On screen: in the agent editor (or a small panel), "What this agent remembers" —
  its notes newest-first, with a way to clear one. Honest empty state.
- Handoff on screen: when an agent hands work to another (@AgentB take this), show
  a clear "passed to @AgentB" line in the room, and the receiving agent's next turn
  actually gets the handoff.
- Tests: engine/hub for memory-in-turn and handoff; browser checks in scripts/qa.mjs
  proving the "remembers" panel shows a note and the handoff line appears.

## LANE CODEX — Codex isolation fix   (branch cursor/codex-fix)
READ docs/qa/codex-isolation-audit.md FIRST — 7 CONFIRMED findings with exact
lines. Fix as a CLASS (root cause F1: a Codex agent can't declare its tool set the
way Claude can). Deliver:
- A real tool-set boundary for a Codex agent so the ability switches gate it:
  sub-agent spawning (F2), web (F3), shell/patch (F4) must NOT reach a Codex agent
  when the matching switch is OFF — same as Claude.
- Stop the owner's Codex skills loading for every Codex agent (F5).
- Make the prompt HONEST (F7): never tell a Codex agent it "CANNOT" do something it
  actually can, never promise what isn't granted — the same one-owner abilities.ts
  pattern used for Claude.
- Files: packages/engine/src/codex.ts, abilities.ts, host.ts and their tests.
  Little/no screen change (if the reach-ladder honesty line needs a word, ONE line).
- Tests: assert F2/F3/F4/F5 are gated/removed for Codex, and the prompt matches
  what's truly granted in both directions. If SUSPECTED items need a live run, say so.

---
## When done
Push your branch, write the report, tell Vikas. The conductor reviews, resolves any
small App.tsx overlap, merges, rebuilds the installer, and walks it.
