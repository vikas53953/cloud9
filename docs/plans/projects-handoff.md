# Projects on screen — what the screen needs next

**Written by:** the agent that owns `apps/desktop/src/**` and `scripts/qa.mjs`,
2026-07-30.
**This document is the request to whoever owns `packages/**` and `apps/relay/**`.**
Nothing here was reached across into. Everything below is a thing the screen
wanted, could not get honestly, and therefore does not draw.

---

## 1. What now exists on his screen

**PROJECTS is in the icon rail**, added beside Chat / Crew / Tasks / Log. The
Studio navigation he approved is otherwise unchanged.

The four frames `apps/desktop/src/store.ts` used to drop with a comment saying
"the day someone builds the Projects screen" — `project`, `projects`,
`projectForgotten`, `projectItems` — are **claimed**. The screen sends
`projects`, `projectItems`, `connectProject`, `updateProject` and
`forgetProject`, and nothing else.

Inside a project: its repository (named the way `gh` names one), its default
branch when GitHub reported one, when it was last looked at, the conversation it
reports into, its pull requests, its issues, and which of his agents is standing
on which branch.

The mid-run approval card draws `kind`, `remoteAction`, `detail` and
`expiresAt`, and `expired` is its own state.

---

## 2. THE BIGGEST GAP, and it is not on this side

**Nothing in Cloud9 ever sends `projectSynced`.** `grep -rn projectSynced
packages/engine/src` finds nothing but the relay's handler for it. So:

- the hub can store pull requests and issues,
- the screen can draw them,
- and **no code path ever puts one there.** A connected repository is
  permanently empty in the real app.

The screen says so rather than showing an empty list that reads like "no open
work": a project with no `syncedAt` carries a card saying nobody has asked
GitHub yet, and no trunk chip, because none was reported. That is honest, and it
is also not a feature.

**What is needed, smallest first:**

1. **A client frame the screen can send to ask for a look** — something like
   `{ type: "syncProject"; projectId: ID }`, refused unless it is your project,
   forwarded to the engine host the way `harnessRequest` already is. Without it
   there is no button the screen can honestly offer: "Look at GitHub now" would
   be a button that does nothing. **The screen has deliberately not drawn one.**
2. **An engine path that runs `gh pr list` / `gh issue list` for a project's
   `repo` and answers with `projectSynced`** — items, `defaultBranch`, and
   `problem` in plain words when it could not look. `problem` is already drawn
   verbatim.
3. Whatever schedule that should run on. The screen makes no assumption; it
   prints `syncedAt` and lets him judge how old it is.

Until 1 and 2 exist, the only way items reach the screen is an engine
connection sending `projectSynced` by hand — which is exactly how the QA suite
proves the screen draws them (`scripts/qa.mjs`, the PROJECTS section).

---

## 3. Which agent is in which worktree — NOT on the wire

His item 3 for this round was "show which agent is in which worktree and on
which branch". Only half of that can be told the truth about:

- **the branch** travels: `ProjectItem.branch` plus `ProjectItem.agentId`. The
  screen draws it, with the agent's face on it.
- **the worktree does not.** `Worktree` is `packages/engine/src/worktree.ts` and
  engine-local; nothing carries a worktree path, a state, or "this agent is
  working in this folder right now" to the hub. The screen therefore says, in
  words: *"The folder each agent works in stays on this computer and is not
  reported to Cloud9 yet — the branch above is what travels."* It does not draw
  a plausible-looking path.

**What would fix it:** move `Worktree` to `@cloud9/shared` (the approval handoff
§7 already says `Worktree`, `PullRequest` and `GitHubAccount` move "when
Projects gets a screen" — it has one now), and add a frame for "these are the
worktrees open on this machine, and whose they are". One shape that would work:

```ts
| { type: "worktrees"; projectId?: ID; open: Array<{
    agentId: ID; branch: string; path: string; taskId?: ID; since: number }> }
```

`path` is the owner's own folder on the owner's own machine, so it is his to
see; it must never go to a guest. **Please do not let the screen define a second
pull-request shape** — it has not, and `ProjectItem` is the only shape it reads.

---

## 4. A pull request is traced to a turn by reading run steps. That is a guess.

`ProjectItem` has no run id, and `RunRecord` has no branch. So the screen traces
a pull request to the job that made it by looking through the run records it is
already holding for one whose steps NAME the branch (`git push origin
cloud9/scout-7`). When it finds one it shows that turn. When it does not, it
says so — *"No turn we are holding names `<branch>`"* — and offers the agent's
full history instead.

This works, and it is the honest version of a link nobody recorded. **The real
fix is one field.** Either:

- `RunRecord.branch?: string` — set by the engine when a turn worked in a
  worktree; or
- `ProjectItem.runId?: string` — set when the engine reports an item it opened
  itself.

Either one turns a text match into a fact. `ProjectItem.runId` is the better of
the two: it is set exactly once, by the code that opened the pull request, and
it survives an agent taking a hundred more turns.

---

## 5. Smaller things the screen wanted and did without

| Wanted | Why it is not drawn |
|---|---|
| An issue's body | `ProjectItem` carries the title and the URL only. The screen says the description and the conversation stay on GitHub, and links out. It does not summarise something it cannot read. |
| Which project an approval belongs to | `Approval` has `channelId` but no `projectId`, so a push request cannot be shown inside the project it is about. It appears in its conversation and in the Tasks in-tray, per the approval handoff. |
| Which project an agent or a job is working in | Nothing links `AgentDef` or `Task` to a `Project`. So the crew panel is built backwards, from the pull requests an agent has opened — an agent with no pull request yet does not appear at all, which is honest but thin. `Task.projectId` would fix it. |
| A "review this pull request" action | There is no frame for it, and a review is a thing that leaves the machine — it belongs behind `REMOTE_ACTIONS` with the other three, not in the screen. |
| Creating a repository | `REMOTE_ACTIONS.createRepo` exists and the approval card can draw it, but nothing in the screen or the hub can start one. |

---

## 6. What the screen promises, so the other half can rely on it

- It never reaches GitHub. Every value drawn came from a frame.
- It never guesses a default branch. No `defaultBranch`, no trunk chip.
- It draws `merged` and `closed` as **opposite outcomes, in words** — "Merged
  in" and "Closed, not merged" — not as two shades of the same chip.
- It renders `problem` verbatim and never paraphrases it.
- An unasked-for list says "looking", never "you have none" (`asked` on both
  `world.projects` and `world.projectItems`).
- `forgetProject` takes the project's items off the screen with it, the same way
  the hub takes them out of the database.
- An `action` approval past `expiresAt` shows **no buttons**, because the hub
  refuses a late decision and offering one would be a button that cannot work.
  It is not painted as an error and it does not disappear.
