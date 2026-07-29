# Harness isolation — what the ability switches really control, and the ask for the screen

**Written by:** the engine builder, 2026-07-29.
**Owns:** `packages/engine/src/**` only. Nothing in `packages/shared`, `apps/relay`
or `apps/desktop` was touched — this document is the request to the renderer.
**Follows on from:** `run-records-handoff.md` §7.2, which recorded the Codex hole
but did not close any of it.

---

## 1. The problem, in one paragraph

Vikas is shown four switches on an agent — search the web, files, schedules,
background — and those switches are presented to him as the permission boundary.
For a **Claude** agent that is now literally true: the command line declares the
exact tool set with `--tools`, so nothing he did not switch on can arrive. For a
**Codex** agent it is **not** true and cannot be made true on codex-cli 0.146.0.
A screen that shows the same reassuring sentence under both is telling him
something false about one of them. The engine now knows the difference and
exports it; the screen has to start using it.

---

## 2. What was established by running the real CLI (2026-07-29, codex-cli 0.146.0)

Everything below came from running things, not from reading docs.

### 2.1 There is still no `--tools`
`codex --help` and `codex exec --help` were both read in full at 0.146.0. There
is no flag that declares a tool set. The built-in surface can only be whittled
at, never declared. (The task brief said 0.146.4; the installed CLI reports
**0.146.0**. Nothing here has been checked against 0.146.4.)

### 2.2 A free, offline way to see exactly what reaches the model
`codex debug prompt-input --json` renders the model-visible prompt list without
calling the API. Every claim about *text* below was measured that way, at no
cost, and can be re-measured in seconds.

### 2.3 Two live turns, differing only in flags

Same tiny prompt, "List the exact names of every tool you can call."

**Before** (`--ignore-user-config --ignore-rules`, what shipped yesterday):

```
tool_search_tool, functions.wait, functions.shell_command,
functions.list_mcp_resources, functions.list_mcp_resource_templates,
functions.read_mcp_resource, functions.update_plan, functions.request_user_input,
functions.request_plugin_install, functions.view_image, functions.exec,
functions.apply_patch, collaboration.followup_task, collaboration.interrupt_agent,
collaboration.list_agents, collaboration.send_message, collaboration.spawn_agent,
collaboration.wait_agent, web.run, image_gen.imagegen
```
plus the CLI's own note *"Skill descriptions were shortened to fit the 2% skills
context budget."*

**After** (the eight `--disable` switches this round adds):

```
functions.wait, functions.shell_command, functions.update_plan,
functions.request_user_input, functions.view_image, functions.exec,
functions.apply_patch, collaboration.followup_task, collaboration.interrupt_agent,
collaboration.list_agents, collaboration.send_message, collaboration.spawn_agent,
collaboration.wait_agent, web.run
```
and no skills note.

---

## 3. What was closed

`codexArgs` now adds `--disable` for each of `plugins, apps, multi_agent,
image_generation, computer_use, browser_use, memories, hooks` — every name taken
from `codex features list` on this machine, so none can be a typo the CLI
ignores. `--disable X` is the CLI's documented shorthand for `-c features.X=false`.

**Six tools stopped arriving**, measured on the two turns above:

| Tool that is now gone | What it was |
|---|---|
| `image_gen.imagegen` | generating images on the owner's account |
| `functions.list_mcp_resources` | reading the owner's connected accounts |
| `functions.list_mcp_resource_templates` | the same |
| `functions.read_mcp_resource` | the same |
| `functions.request_plugin_install` | installing plugins into the owner's Codex |
| `tool_search_tool` | discovering further tools at run time |

**And 4,641 characters of the owner's own setup** stopped being sent every turn —
measured with `codex debug prompt-input`: the `<plugins_instructions>`,
`<apps_instructions>` and `<recommended_plugins>` blocks. (The Claude equivalent
of that saving was 48,843 cached tokens down to 9,291.)

Also closed, and unrelated to features: Codex's own `[tools] web_search` switch
is now driven by the agent's `webSearch` ability, in both directions, from the
same `CAPABILITIES` table that writes the sentence the agent reads about itself.
Before this round a Codex agent's web ability drove nothing at all.

### 3.1 One thing that was tried and deliberately NOT shipped

`-c agents.max_depth=0` looked like the way to stop sub-agent spawning. Running
the exact shipped argv proved two things: it does not remove
`collaboration.spawn_agent`, **and the CLI refuses the value** —
`Error: agents.max_depth must be at least 1`, exit 1, before the model is
reached. Shipping it would have broken every Codex turn on the machine. It is
out, and the reason is written into `codex.ts` so nobody adds it back.

---

## 4. What genuinely cannot be closed, tool by tool

| Still there | What it means for Vikas | Why it cannot be closed |
|---|---|---|
| `collaboration.*` — 6 tools including `spawn_agent` | the agent can start further agents and talk to them | survived `--disable multi_agent` on a live turn; `agents.max_depth=0` is refused by the CLI; there is no `--tools` |
| `web.run` | it can read web pages even with "search the web" switched off | survived `-c tools.web_search=false` on a live turn |
| `functions.exec`, `functions.shell_command`, `functions.apply_patch` | it can run commands and change files | no switch exists. What holds them back is the sandbox (`-s read-only` unless the files ability is on) — a **fence, not an absence** |
| the owner's skills | standing instructions Vikas wrote for himself are read by his agents | see below |

### 4.1 The skills hole, in detail — this is the one with no route out

Skills load from **two** roots, and neither can be dropped:

1. `$CODEX_HOME/skills` — 27 of Vikas's own skills.
2. `~/.agents/skills` — 32 more (`agent-browser`, the whole `baoyu-*` family,
   `wayfinder`, `tinyfish`, …). **This root is not under `CODEX_HOME` at all.**

Everything tried, and its measured result:

- `-c skills.enabled=false` — **no effect.** 49 skills before, 49 after.
- `-c include_skills_usage_instructions=false` — no effect.
- `-c skills.disabled_skill_names=["…"]` — no effect.
- `-c skills=false` — rejected: *"invalid type: boolean, expected struct
  SkillsConfig"*, so the struct exists but has no usable off switch at 0.146.0.
- **Pointing `CODEX_HOME` at a Cloud9-owned folder** drops root 1 and the
  owner's `config.toml`, `AGENTS.md`, plugins and MCP servers with it — and
  **signs the agent out.** Measured directly: `codex login status` prints
  `Logged in using ChatGPT` against the real home and `Not logged in` against a
  fresh one. This is exactly the trap `CLAUDE_CONFIG_DIR` set on the Claude
  side. Root 2 stayed loaded even then, and overriding `USERPROFILE`/`HOME` for
  the child process did not move it either.

So: no. Not with this CLI version.

---

## 5. The ask for the renderer

The engine now exports the honest answer as **data**, so this never has to be
re-derived in the UI or trusted to a document the UI cannot read:

```ts
import { HARNESS_ISOLATION, isolationFor } from "@cloud9/engine";

isolationFor(agent.provider)   // "claude" | "codex" | "mock" → HarnessIsolation | undefined
```

`HarnessIsolation` carries:

| Field | Plain-words role |
|---|---|
| `togglesAreTheBoundary` | **the one bit that matters.** true = these switches are the whole story |
| `headline` | one sentence to show under the switches. Already written in his words |
| `togglesControl` | what the switches DO govern, when they do not govern everything |
| `stillLoaded[]` | every leak, each with `name`, `plainWords` and `why` |
| `measuredOn` | CLI version and date, so a stale claim is visible rather than silent |

**What the screen must do:**

1. **Stop showing one sentence for both harnesses.** Show `headline`. For Claude
   it reads *"This agent can only use what you switched on. Nothing else reaches
   it."* For Codex it reads *"These switches control what this agent may CHANGE
   on your PC. They do not control every tool it holds — Codex does not let us
   take the rest away yet."*
2. **Give the Codex card a way to see `stillLoaded`** — a "what else can it do?"
   disclosure listing each leak's `plainWords`. He should not have to read a
   markdown file to learn his agent can spawn other agents.
3. **`isolationFor` returning `undefined` means "we have not measured this
   harness".** Do NOT fall back to the reassuring sentence. Say nothing, or say
   we do not know.
4. If the agent-creation screen ever lets him pick a harness, this is the
   difference that should be visible **at the moment he picks**, not afterwards.

A class rule is enforced by a test in `isolation.test.ts`: a harness may not
claim `togglesAreTheBoundary` while `stillLoaded` is non-empty. So the renderer
can trust that one boolean and never have to second-guess it.

**Nothing about Claude's isolation was weakened to make this general.** A test
asserts `--tools`, all three Claude isolation flags, and that no Codex-shaped
flag leaked into the Claude command line.

---

## 6. Three smaller fixes in the same files

- **`runstore` writes are atomic now.** A record goes to `<id>.json.tmp-<pid>-<t>`
  and is then renamed, so the final name only ever holds finished bytes. Before,
  a turn interrupted mid-write left half a file that parsed as nothing, showed
  as nothing, and still counted towards the 50 kept runs for ever — it pushed a
  real run out and then sat there. Pre-existing torn files are now **recovered**:
  a file that reads fine and is not a record is deleted so it stops holding a
  slot, while a file we merely could not read (busy, locked) is left alone.
- **Retention is one number.** `RUN_STORE_DEFAULTS.keepPerAgent` is now derived
  from `RUN_RETENTION.perAgent` instead of being a second `50` in a second
  package. A test reads the source and fails if anyone writes the number out
  again — equal values are not enough, because two 50s are equal right up until
  they are not.
- **An absurd retention count can no longer empty an agent's history.**
  `prune` used `ids.slice(keep)`, so a keep of −5 sliced from the end and deleted
  everything. Anything below 1 (or NaN, or a fraction) now falls back to the
  default. Unreachable today; closed anyway, because the cheap moment is before
  something is wired to it.

**The same `-5` hole exists in `apps/relay/src/store.ts:1475`,
`pruneRuns(agentId, keep = RUN_RETENTION.perAgent)`** — that file has another
owner, so it was not touched. It needs the same clamp.
