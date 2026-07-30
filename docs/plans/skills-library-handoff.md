# Skills library + the real model list — what the SCREEN has to do

Written 2026-07-30 by the engine/shared agent. Everything described here is
already built, built clean and tested in `packages/shared/src/**` and
`packages/engine/src/**`. Nothing in `apps/desktop/src/**` was touched — that
is yours. This file is the whole ask.

Covers Vikas's 2026-07-30 morning items **5 (the model list is short)** and
**7 (a skill library)**.

---

## 1. The model list — mostly done for you, one small job left

### What changed underneath

`CLAUDE_MODELS` in `@cloud9/shared` used to be four hand-written names. It is
now two lists:

| export | what it is |
|---|---|
| `CLAUDE_MODEL_CATALOGUE` | every Claude name the installed CLI knows (18 rows), with friendly labels. Read out of the CLI's own shipped registry, not invented. This is the CANDIDATE list. |
| `CLAUDE_MODELS` | the subset PROVED to run on this machine by running it (13 rows). The fallback, used only when the live check can't be trusted. |

`modelLabel()` now reads the catalogue, so every id has a friendly name.

The engine now discovers the real list the same way it already does for Codex —
by asking the CLI. Claude has no listing command, so `detectClaudeModels()`
tries each candidate with a one-word turn and keeps the ones that answered.
Proved live on 2026-07-30: **13 models, 71.7 seconds, `checked: true`**.

The answer is remembered in `<dataDir>/claude-models.json`, keyed on the
`claude --version` string, so it happens once per Claude Code build and
re-runs by itself when he updates.

### What the screen gets for free

`useModels()` in `App.tsx` already prefers `world.harness.claude.models` and
only falls back to `CLAUDE_MODELS`. So **the picker gets the full list with no
change from you.** He will see 13 Claude models instead of 4, including the
Sonnet 4.5 he said was missing.

### The one small job

`HarnessInfo` has two new optional fields:

```ts
modelsChecked?: boolean;   // did we actually ask the app, or is this the fallback?
modelsDetail?: string;     // one plain sentence about where the list came from
```

Show `modelsDetail` on the harness card in Settings, next to the existing
"N models" chip. Suggested treatment:

- `modelsChecked === true` — quiet grey line, e.g.
  *"13 models, proved by running them on this Claude build"*.
- `modelsChecked === false` — the same line but marked as not-yet-checked, e.g.
  *"the list Cloud9 last proved by running it, not checked just now"*.

Do NOT invent your own wording — `modelsDetail` is already the sentence.
It arrives on the existing harness state frame; no new frame, no new call.

Optional extra (nice, not required): a "Check again" affordance. The engine
method exists — `harness.proveClaudeModels(true)` — but there is **no relay
frame wired to it yet**. If you want the button, say so and I will add the
frame; do not reach into the engine from the renderer.

### Two rules this must keep

1. Never offer a model his app cannot run. A model is only on the list because
   it answered.
2. Never silently drop one it can. If any probe is unreadable — no network,
   rate limited, signed out — the whole round is thrown away and the proved
   fallback is served instead, saying so in `modelsDetail`. A bad minute must
   never look like models disappearing.

---

## 2. The skill library — a whole new screen

### What exists

`@cloud9/shared` now exports a curated, built-in library. It ships inside the
app exactly like the hiring hall: no server, no download, works offline.

```ts
import {
  SKILL_CATEGORIES,   // SkillCategory[] — the shelves
  SKILL_LIBRARY,      // LibrarySkill[]  — 15 skills, ONE table
  librarySkillsFor,   // (roleId) => LibrarySkill[]  — ordered for a role
  libraryCategory,    // (id) => SkillCategory | undefined
  skillFromLibrary,   // (LibrarySkill) => AgentSkill  — take it off the shelf
  type LibrarySkill, type SkillCategory,
} from "@cloud9/shared";
```

`LibrarySkill` fields you will draw:

| field | on screen |
|---|---|
| `name` | the card title |
| `emoji` | the card's mark |
| `description` | one plain line: **when this helps**. This is what he reads. |
| `instructions` | the product — the full procedure. Show it in a preview/expand, and in the editor after taking it. |
| `category` | which shelf; group and filter by this |
| `recommendedFor` | hiring-hall role ids, best first — for the "recommended for this agent" strip |
| `source` | where the procedure came from, so he can go and check. Show it small, at the bottom of the card. |

### The shelves

`review` "Checking work" · `build` "Building it right" · `fix` "Finding and
fixing" · `ship` "Shipping safely" · `explain` "Writing it down".

Drive the filter bar, the group headings and the empty state from
`SKILL_CATEGORIES`. **Never hard-code a shelf or a skill in the renderer** —
adding a row to either list must be the whole job of adding a skill.

### The promise that must not be broken

Taking a skill produces an **ordinary skill**. `skillFromLibrary()` returns a
plain `AgentSkill` — `{ id, name, description, instructions }` and nothing
else. No category, no source, no id pointing back at the shelf. After it lands
it is indistinguishable from one he typed, and every field is editable in the
existing skill editor.

So: **use the skill editor you already have.** Do not build a separate
read-only "library skill" view on an agent. Adding from the library is just
`agent.skills = [...agent.skills, skillFromLibrary(chosen)]` followed by the
save you already do.

Two guards worth putting on screen:

- `SKILL_LIMITS.perAgent` is 20. If adding would go over, say so before he
  picks, don't fail after.
- If the agent already has a skill with the same name, offer to replace rather
  than silently making two. The library never enforces this — it is a screen
  decision.

### Recommending per role

`librarySkillsFor(roleId)` takes a hiring-hall template id (`sw-architect`,
`sw-qa`, `sw-security`, …) and returns **the whole library**, reordered so the
ones recommended to that role come first. It never hides anything.

Where to use it:

1. On an agent hired from the hiring hall, the library opens with
   `librarySkillsFor(template.id)` — so the Architect and the QA engineer do
   not see the same first three. This is tested.
2. For a hand-made agent with no role, call it with anything (or use
   `SKILL_LIBRARY` directly) — an unknown role gets the natural order, which is
   a sensible default rather than an error.

An agent does not currently remember which template it was hired from. If you
want the per-role ordering to survive past the hiring moment, that needs a
field on `AgentDef` — ask me and I will add it rather than storing it in the
renderer.

### Where it should live on screen (my suggestion, your call)

The agent editor already has a skills section. Put a "Add from the library"
button there that opens the library the same way "Browse the hiring hall"
opens the marketplace — same shell, same filter bar, same card rhythm — so it
reads as one idea rather than a second marketplace.

---

## 3. Anything I could not verify

- The **relay frame for a manual "check models again"** does not exist. The
  engine method does. I did not add a frame because I could not test the
  screen half.
- **Role memory**: as above, `AgentDef` has no field saying which template an
  agent came from, so per-role ordering only works at the hiring moment today.
- I have **not seen either of these on screen**. Everything above is proved by
  running tests and by running the real CLI, not by looking at the app.
