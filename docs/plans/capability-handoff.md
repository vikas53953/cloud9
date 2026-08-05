# Raising the ceiling — what the engine now offers, and the ask for the screen

**Written by:** the engine builder, 2026-07-30.
**Owns:** `packages/engine/src/**` and `packages/shared/src/**` only. Nothing in
`scripts/`, `apps/desktop` or `apps/relay` was touched — this document is the
request to whoever owns those.
**Follows on from:** `harness-isolation-handoff.md`, which made the switches a
real boundary. This round keeps that and lifts the ceiling above it.

---

## 1. What changed, in one paragraph

Yesterday the switches became a real boundary — and the boundary was set too
low. `Bash` was on a `NEVER_ALLOWED_TOOLS` list, so **no switch Vikas could ever
set would let an agent run a program on his own computer.** He said the ceiling
is wrong: an agent should be able to do everything Claude Code and Codex can do
on his machine. Both facts are right, so both are kept. The switches are still
the whole boundary; his own dev setup is still shut out at every setting; but the
switches now reach the CLI's full surface, and everything that changes the
machine or spends money **asks first** instead of being refused.

---

## 2. The real full surface, measured 2026-07-30 (not remembered)

### 2.1 Claude Code **2.1.220** — 31 built-in tools

Run: the exact command line Cloud9 ships, with `--tools default`, reading the
CLI's own `system/init` event.

```
tools: Task, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit,
       EnterWorktree, ExitWorktree, Glob, Grep, Monitor, NotebookEdit,
       PowerShell, PushNotification, Read, RemoteTrigger, ReportFindings,
       ScheduleWakeup, SendMessage, TaskCreate, TaskGet, TaskList, TaskOutput,
       TaskStop, TaskUpdate, ToolSearch, WebFetch, WebSearch, Workflow, Write
mcp_servers: []   slash_commands: []   skills: []
```

Three things that were assumed and are **not** true:

1. **`PowerShell` is its own tool, separate from `Bash`.** The old
   `NEVER_ALLOWED_TOOLS = ["Bash"]` would not have stopped a shell on Windows.
2. **An unknown tool name in `--tools` is not an error.** `claude -p --tools
   NotARealToolXYZ` was run: exit 0, normal answer. A typo is a capability that
   silently never arrives. A test now checks every name in the table against the
   measured list.
3. **`--safe-mode` still names seven of his plugins** in the init event, while
   reporting zero skills, zero slash commands and zero MCP servers. Nothing was
   measured reaching an agent — it is recorded as an *unknown*, not a leak.

> **SUPERSEDED 2026-08-05 (CLI 2.1.222).** `--safe-mode` came OFF the agent
> command line. It disables MCP servers ABSOLUTELY — including a server Cloud9
> hands the CLI itself with `--mcp-config` on the same line. Measured: with it,
> `mcp_servers: []` and the server process never spawned; without it,
> `[{probe,connected}]` and the tool answered. For as long as it was there the
> `connections` switch granted nothing and Cloud9’s OWN tools
> (`search_conversation`, `open_attachment`) did not exist, while the prompt told
> agents they did. The isolation is now `--strict-mcp-config
> --disable-slash-commands --setting-sources ""` plus
> `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` in the child’s environment — measured as
> isolated as `--safe-mode` on every axis and MORE so on plugins (it names none).
> The plugin *unknown* above is therefore closed. See the block comment on
> `CLAUDE_ISOLATION_FLAGS` in `packages/engine/src/claude-cli.ts` and the guard in
> `packages/engine/src/mcpdoorway.test.ts`.

Levers the CLI offers that we now use: `--tools`, `--allowed-tools`,
`--disallowed-tools`, `--add-dir`, `--mcp-config` + `--strict-mcp-config`.

### 2.2 Codex CLI **0.146.0** — still no `--tools`

`codex --help`, `codex exec --help` and `codex features list` all re-read at
0.146.0 on 2026-07-30. There is still no flag that declares a tool set; the
surface can only be whittled at. `codex exec` does have `--add-dir`
("Additional directories that should be writable alongside the primary
workspace") and `-s read-only | workspace-write | danger-full-access`. Cloud9
never chooses `danger-full-access` and never passes
`--dangerously-bypass-approvals-and-sandbox` — tested.

### 2.3 Live proof, both directions, on real turns

Full reach (`--tools …Bash PowerShell`), prompt "run `echo CEILING-PROOF-7731`":

```
TOOLS: 31   Bash? true   MCP: []   slash: 0   model: claude-sonnet-5
TOOL USED: Bash {"command":"echo CEILING-PROOF-7731"}
RESULT: "CEILING-PROOF-7731"   is_error: false   denials: []
```

Lower reach (`look`), same kind of prompt:

```
TOOLS: ["Edit","Glob","Grep","NotebookEdit","Read","WebFetch","WebSearch","Write"]
MCP: []   slash: 0
TOOL USED: Bash
RESULT: "I could not run it — the Bash tool is disabled for this session."
```

The ceiling is real **and** the boundary is real. Both were run, not argued.

---

## 3. The new model: one ladder, one table

### 3.1 The ladder Vikas picks from — `REACH_LEVELS`

Four rungs, plain words, each one everything below it plus more:

| `level` | `label` | `plainWords` |
|---|---|---|
| `talk` | Just talk | Answers questions from what it knows. No tools at all. |
| `look` | Look things up and keep notes | Can check the web and keep files in its own folder. Nothing on your PC changes. |
| `work` | Do real work for you | Adds helper agents, repeating check-ins and background jobs. Still only its own folder. |
| `computer` | Everything this app can do on this computer | The same reach Claude Code and Codex have on your PC. Anything that changes your machine or spends money asks you first. |

**Why a non-developer can reason about it:** he never picks tools. He picks how
far he is letting the agent go, in four steps, from "it only talks" to "it can do
what I can do on this PC". The words on each rung say what changes on *his*
computer, not what the model is handed. A rung is literally a prefix of the
capability table, so a rung can never quietly drop something a lower rung had.

He can still hand-pick individual switches; `reachOf(agent)` reports the highest
rung a mix fully covers, and **never rounds a mix up**.

### 3.2 The table — `CAPABILITIES` in `packages/engine/src/abilities.ts`

Still the single owner. Each row now carries **four** faces of one fact: the
tools it grants, the Codex effect it has, whether the owner is asked, and the two
sentences the agent reads about itself. Eight rows, harmless → powerful:

| Switch | `label` | Grants (Claude) | Asks first? |
|---|---|---|---|
| `webSearch` | Look things up on the web | WebSearch, WebFetch | no |
| `files` | Keep and change files in its own folder | Read, Write, Edit, NotebookEdit, Glob, Grep | no |
| `helpers` | Get help from its own helper agents | Task, Task{Create,Get,List,Output,Stop,Update}, ToolSearch, Workflow, Monitor, SendMessage, ReportFindings, DesignSync | no |
| `schedules` | Check in on a repeating schedule | ScheduleWakeup, CronCreate, CronList, CronDelete | owner's choice |
| `background` | Work on jobs in the background | EnterWorktree, ExitWorktree, RemoteTrigger, PushNotification | owner's choice |
| `connections` | Use connected services your owner picked for you | (an MCP config passed in for this agent) | **always** |
| `wholeComputer` | Reach files outside its own folder | (`--add-dir` roots) | **always** |
| `commands` | Run programs on this computer | Bash, PowerShell | **always** |

The four new fields on `AgentAbilities` are **optional**, and that is deliberate:
absent means off, so every agent that already exists is unchanged. Nobody gains
the power to run programs without someone typing it in.

### 3.3 "Ask first", reusing the approvals that already exist

No second mechanism. A row marked `alwaysAsk` forces the matching flag on in the
app's existing `AgentApprovals`:

```ts
approvalsFor(agent)      // stored approvals, with every dangerous row forced ON
needsApprovalToRun(agent)// does this agent hold anything that must be asked about?
describeApprovalNeeds(agent) // ["Run programs on this computer", …] — his words
```

A client that sends `approvals: { commands: false }` **does not get a silent
machine** — `approvalsFor` returns `commands: true` anyway. There is a test for
exactly that forgery.

The engine now asks `approvalsFor` / `needsApprovalToRun` on both unattended
paths (`!bg`/`!task` and `!schedule`) instead of reading `agent.approvals`
directly. A dangerous agent's background job and repeating check-in are always
put in front of him, because those are the two places nobody is watching.

**Honest limit, stated plainly:** with `claude -p` and `codex exec` there is
nobody to answer a mid-turn prompt, so **per-tool-call approval does not exist on
either CLI**. What Cloud9 can put in front is the whole unattended job. An
ordinary chat turn with a `commands` agent still runs its tools within that turn.
If that is not what he wants, the fix is a decision he has to make, not something
to invent quietly.

---

## 4. The ask for the renderer (`apps/desktop/src/**`) and the relay

Everything below is data the engine already exports from `@cloud9/engine`.

### 4.1 Replace four checkboxes with the ladder

```ts
import { REACH_LEVELS, abilitiesForReach, reachOf, CAPABILITIES } from "@cloud9/engine";
```

1. The agent screen should lead with **four choices**, `label` on the button and
   `plainWords` underneath. `abilitiesForReach(level)` is the abilities object to
   store. `reachOf(agent)` is which one to show as selected.
2. Keep an "or pick them one by one" disclosure listing `CAPABILITIES` by
   `label`. Never show a tool name to him — the tool names are the machine's
   business and the `label` is his.
3. The top rung must not read like a warning label. He asked for it. It should
   read as the thing it is: the same reach Claude Code and Codex already have on
   his PC, with a hand on the door.

### 4.2 Show what will ask first

```ts
import { needsApprovalToRun, describeApprovalNeeds } from "@cloud9/engine";
```

When `needsApprovalToRun(agent)` is true, show the list from
`describeApprovalNeeds(agent)` as "You'll be asked before it: …". These are
**not** editable checkboxes — the switch being on IS the ask being on. Rendering
them as a toggle he can clear would be showing him a control that does nothing.

`approvals.background` and `approvals.schedules` remain his real choices and
should stay editable.

### 4.3 The honest report gained two fields

`HarnessIsolation` (from `isolationFor(agent.provider)`) now carries:

| Field | Plain-words role |
|---|---|
| `ceiling` | **new.** How high the switches GO on this harness. A screen that shows only "nothing else reaches it" now understates what he has switched on — the same class of lie in reverse. Show it next to `headline`. |
| `unknowns[]` | **new.** Things we saw and could not settle either way. Not leaks, not "clean". Belongs in the same "what else?" disclosure as `stillLoaded`, under a heading that says we could not tell. |

`togglesAreTheBoundary`, `headline`, `togglesControl`, `stillLoaded` and
`measuredOn` are unchanged and the class-rule test still holds.

### 4.4 Two things that need somewhere to live (currently no UI, no storage)

Both are wired in the engine and inert until someone gives him a way to set them.

- **`wholeComputer` needs folders.** `ClaudeCliProviderOptions.wholeComputerRoots(agentId)`
  and `CodexProviderOptions.wholeComputerRoots(agentId)` are asked fresh each
  turn. With the switch on and no folders chosen, the agent gets **nothing** extra
  — which is the safe way round, but it means the switch reads as broken until
  there is a folder picker. Suggested: "Which folders may it reach?" with the
  folder list stored on the agent.
- **`connections` needs a per-agent MCP config.**
  `ClaudeCliProviderOptions.mcpConfigPath(agentId)` — a **path**, never inline
  JSON (inline JSON would put `{` and `"` on a command line, which `run.ts`
  rightly refuses). `--strict-mcp-config` stays on at every reach, so the file he
  chooses for that agent is the only source of servers that can exist. His own
  servers are never among them.

### 4.5 The relay's `requiresApproval` should stop reading `agent.approvals` directly

`apps/relay/src/server.ts:1714` still does
`agent.approvals?.background === true`. That is now the *second* place the rule
lives, and it is the one that can be wrong: it will let a `commands` agent's
background job through without an approval. It should call `approvalsFor(agent)`
and OR in `needsApprovalToRun(agent)`, exactly as `engine.ts` now does. That file
has another owner, so it was not touched.

---

## 5. What was NOT weakened

Checked by tests that fail if any of it is traded away for the ceiling:

- `--strict-mcp-config`, `--disable-slash-commands` and `--setting-sources ""`
  are on **at the top rung**, so his CLAUDE.md, plugins, hooks, MCP servers and
  130 slash commands are still shut out of an agent that can run programs.
  (`--safe-mode` used to be in this list; see the 2026-08-05 note in §2.1 for why
  it had to go and what replaced it.)
- `--ignore-user-config` and `--ignore-rules` likewise on the Codex side, and
  every feature that is a door into his own setup (`plugins`, `apps`,
  `memories`, `hooks`, `computer_use`, `browser_use`, `image_generation`) stays
  disabled at every reach. That list is now named `CODEX_ALWAYS_DISABLED` to say
  so out loud.
- Credential stripping, `mayDriveAgent`, the injection guards, `MODEL_ID_RE`,
  `validateAgentInput` and `run.ts`'s argument allowlist: untouched. Paths go
  through raw so `run.ts` stays the only owner of quoting — the lesson that broke
  every Codex turn once already.
- `--disallowed-tools` is **stronger** than before, not weaker: it used to be the
  hand-written `["Bash"]`; it is now derived from the CLI's whole measured
  surface, so it already covers `PowerShell` and will cover whatever the CLI
  grows next.

---

## 6. Evidence

Build clean (`npm run build`, including the desktop typecheck).
Tests: **184 → 203 engine**, **113 → 113 relay**, all executed, 0 failing.
Live turns: two real `claude -p` turns, quoted in §2.3, proving the ceiling in
one direction and the boundary in the other.
