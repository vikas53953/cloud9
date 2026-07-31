# Codex isolation audit — what a Codex agent inherits that it should not

**Lane C · read-only code audit · new files only · no code changed.**

Scope: `packages/engine/src/codex.ts`, `claude-cli.ts`, `abilities.ts`, `host.ts`.
Cross-read for context only: `isolation.ts`, `env.ts`.
Every finding is tagged **CONFIRMED** (proven by the code and the measurements the
code itself records) or **SUSPECTED** (visible in the code but not settled from
these files alone). Line numbers are `file:line` at the audited SHA.

---

## The one-sentence answer

A **Claude** agent runs inside a *declared* tool set: `claude -p` is handed
`--tools <exact list>` plus `--disallowed-tools <everything else>`, so a tool the
owner did not switch on genuinely never arrives. A **Codex** agent runs inside a
*fence*: `codex exec` has **no tool-declaration flag at all**, so the whole
built-in surface is always present and the owner's ability switches only move the
sandbox. The result is that several of Vikas's own things — his skills, sub-agent
spawning, web reading, and shell/patch tools — reach a Codex agent regardless of
what its switches say, while the same switches make them truly absent on Claude.

This is not a hidden bug: the engine already records it honestly in
`isolation.ts` (`HARNESS_ISOLATION.codex.togglesAreTheBoundary = false`,
`isolation.ts:122`). This audit confirms that record against the four files and
names the class-level fix that would make Codex's switches a real boundary
instead of a labelled fence.

---

## How the two paths are built (side by side)

| Concern | Claude (`claude-cli.ts` / `abilities.ts`) | Codex (`codex.ts` / `abilities.ts`) |
|---|---|---|
| Declare the exact tool set | `--tools <granted>` (`claude-cli.ts:392`) | **no equivalent flag exists** (`codex.ts:261-268`, `288`) |
| Deny everything else | `--disallowed-tools <rest>` derived from measured built-ins (`claude-cli.ts:400-401`, `abilities.ts:387-390`) | none |
| Drop owner's config / rules | `--safe-mode` (`claude-cli.ts:309-313`) | `--ignore-user-config --ignore-rules` (`codex.ts:288`) |
| Drop owner's skills / commands | `--disable-slash-commands` + `--safe-mode` → **0 skills measured** (`claude-cli.ts:297`, `isolation.ts:83`) | **cannot** — skills still load (`codex.ts:272-280`) |
| Owner's MCP servers | `--strict-mcp-config`, none passed (`claude-cli.ts:311`) | `--ignore-user-config`, none passed (`codex.ts:427-430`) |
| Strip credential env vars | `envWithoutCredentials()` (`claude-cli.ts:476`) | `envWithoutCredentials()` (`codex.ts:445`) |
| What the switches actually control | **every tool the agent has** (`isolation.ts:84`) | **only the sandbox + web_search** (`isolation.ts:131`) |

---

## Findings

### F1 — Codex has no way to declare its tool set; Claude does. *(CONFIRMED — root cause)*

`claudeArgs` pushes `--tools` with the exact granted list and `--disallowed-tools`
with everything else (`claude-cli.ts:392`, `:400-401`). `codexArgs` has no such
line and cannot, because — as the file states after reading `codex --help` and
`codex exec --help` at 0.146.0 — **"Codex has no equivalent of Claude's
`--tools`"** (`codex.ts:261-268`). Everything below is a consequence of F1.

Why it matters: on Claude the ability table is the whole boundary; on Codex the
same table can only choose a sandbox and one web flag. The abstraction in
`abilities.ts` is shared by both, so the *appearance* of parity is total while the
*enforcement* is not.

### F2 — Sub-agent spawning (`collaboration.*`, 6 tools incl. `spawn_agent`) reaches a Codex agent even with the "helper agents" switch OFF. *(CONFIRMED)*

On Claude, `helpers` off means `Task`, `TaskCreate/Get/List/Output/Stop/Update`
land in `--disallowed-tools` (`abilities.ts:209-212`, `:387-390`). On Codex, the
`helpers` switch is wired to `--disable multi_agent` via
`codexDisabledFeaturesFor` (`codex.ts:338-344`, `abilities.ts:213`), but the code
records that this flag **did not remove `collaboration.*` on a live turn**, and
`-c agents.max_depth=0` is refused outright by the CLI (`codex.ts:266-267`,
`:398-405`; `isolation.ts:132-139`). So a Codex agent that was never granted
helpers can still start and drive further agents.

### F3 — Web reading (`web.run`) reaches a Codex agent even with "search the web" OFF. *(CONFIRMED)*

Claude drops `WebSearch`/`WebFetch` into `--disallowed-tools` when `webSearch` is
off (`abilities.ts:186-192`). Codex sets `-c tools.web_search=<bool>` from the
same switch (`codex.ts:391-397`, `abilities.ts:187`), but the code records that
`web.run` **survived `tools.web_search=false` on a live turn** (`codex.ts:268`;
`isolation.ts:141-145`). The flag is set anyway because it is the only one the CLI
offers, but it is not a boundary.

### F4 — Shell + patch tools (`functions.exec`, `shell_command`, `apply_patch`) are always in a Codex agent's hand; only the sandbox fences them. *(CONFIRMED)*

On Claude, `Bash` and `PowerShell` are granted only by the `commands` switch and
otherwise disallowed (`abilities.ts:271`, `:387-390`). On Codex these tools
**cannot be removed at all** (`codex.ts:269-270`; `isolation.ts:147-151`); what
holds them back is `-s read-only` vs `-s workspace-write` (`codex.ts:373-375`,
`abilities.ts:393-396`) — "a fence, not an absence." Consequence: a "just talk"
or "look only" Codex agent still holds an execute-command tool and can run
read-only commands, where the Claude equivalent holds no shell tool at all.

### F5 — The owner's Codex skills load for every Codex agent; a Claude agent gets zero. *(CONFIRMED)*

Claude's `--disable-slash-commands` + `--safe-mode` produced **0 skills** on the
probe (`claude-cli.ts:297`; `isolation.ts:83`). Codex loads skills from **two**
roots — `$CODEX_HOME/skills` **and** `~/.agents/skills` — and the code records
that `skills.enabled=false`, `include_skills_usage_instructions=false` and
`skills.disabled_skill_names` each changed nothing (49 skills before and after),
while pointing `CODEX_HOME` at a fresh folder signs the agent out
(`codex.ts:272-280`; `isolation.ts:153-160`). So standing instructions Vikas
wrote for himself are read by his Codex agents.

### F6 — Four of the seven ability switches do nothing to a Codex agent's tool surface. *(CONFIRMED)*

The capability table exposes only `opensCodexWorkspace` (files),
`opensCodexWebSearch` (webSearch) and one `codexFeature` (helpers → multi_agent)
to the Codex path (`abilities.ts:90-100`, `:184-278`). `codexDisabledFeaturesFor`
therefore maps **only** `helpers`; `schedules`, `background`, `connections` and
`commands` contribute nothing to `codexArgs` (`codex.ts:338-344`, `:363-407`).
Notably the **`commands`** switch is inert on Codex: the execute tool is present
regardless (F4), and even the *sandbox* is opened by the **`files`** switch
(`opensCodexWorkspace`), not by `commands`. So "run programs" on the Codex side
neither grants nor gates the shell — a semantic mismatch with Claude, where it is
the one switch that grants `Bash`/`PowerShell`.

### F7 — The prompt tells a Codex agent it "CANNOT" do things it can actually do. *(CONFIRMED)*

`buildAgentPrompt` is built from `grantedSupply(agent, …)` — i.e. from the
switches — for both harnesses (`codex.ts:431-434`; `abilities.ts:486-520`,
`:528-532`). So a Codex agent with `webSearch` off is told, verbatim, *"You CANNOT
search the web or open web pages"* (`abilities.ts:190-192`) and *"You have no
tools at all beyond the ones listed above"* (`abilities.ts:506-508`) while
`web.run`, `collaboration.*` and `exec` are in its hand (F2–F4). The screen is
made honest by `isolation.ts`, but the **model's own instructions are not** — the
prompt asserts a boundary Codex does not enforce.

### F8 — Read-only sandbox may not stop network egress or reads outside the workspace. *(SUSPECTED)*

The code treats `-s read-only` as the containment for `exec`/`web.run`
(`codex.ts:269-270`, `:373-375`). Whether read-only also blocks outbound network
(so `web.run`/`exec` cannot phone out) or reads of files outside `-C cwd` is not
established by these four files. If it does not, F3/F4 are worse than "can't
write." Needs a live sandbox probe. *(SUSPECTED.)*

### F9 — `~/.agents/skills` is a shared, cross-tool skills directory outside `CODEX_HOME`. *(SUSPECTED impact)*

F5 confirms it loads; its *content* is not audited here. Because it is shared with
other agent tooling on the machine, a skill written for a different purpose could
steer a Cloud9 Codex agent in ways nobody chose per agent. Impact unmeasured.
*(SUSPECTED.)*

---

## Where Codex is already clean (parity achieved — stated for completeness)

- **Credential env vars.** Both providers strip secrets via
  `envWithoutCredentials` (`codex.ts:445`, `claude-cli.ts:476`, `env.ts:33-43`).
  The old `env: undefined` leak (a stray `ANTHROPIC_*` paying for a Codex turn)
  is **fixed** — CONFIRMED, security finding #9 (`env.ts:1-10`).
- **Owner's MCP servers.** `--ignore-user-config` drops `config.toml` and Cloud9
  passes no MCP config for Codex at all (`codex.ts:427-430`), matching Claude's
  `--strict-mcp-config`. No owner MCP reaches a Codex agent — CONFIRMED.
- **Owner's `config.toml` (personality, orchestration policy) and `.rules`.**
  Dropped by `--ignore-user-config` / `--ignore-rules` (`codex.ts:245-256`,
  `:288`) — CONFIRMED.
- **`CODEX_ALWAYS_DISABLED`.** plugins, apps, image_generation, computer_use,
  browser_use, memories, hooks are off at every reach (`codex.ts:316-324`), six of
  them measured gone (`codex.ts:302-314`) — CONFIRMED.

---

## Proposed class-fix (in words — no code here)

The defect is architectural, not a typo: **one ability→boundary abstraction is
shared by two harnesses, but only Claude's CLI can honour a declared tool set.
Codex silently degrades that abstraction to "sandbox only" without forcing anyone
to acknowledge the degradation.** Four moves make it a real boundary again.

1. **Make the isolation contract a gate, not a caption.** Today
   `togglesAreTheBoundary=false` (`isolation.ts:122`) is data a screen may read.
   Promote it to an enforced invariant: a harness whose toggles are not the
   boundary must not be *silently* run as if they were. Either (a) refuse/downgrade
   a Codex turn whose granted reach implies tools Codex cannot withhold, or (b)
   require a one-time per-agent owner acknowledgment ("on Codex these switches
   move the fence, not the tools"). The choice is Vikas's; the point is that the
   gap can no longer be invisible at run time.

2. **Invert Codex to a sandbox-only model and stop pretending otherwise.** Since
   Codex cannot subtract tools, drive it purely from `-s read-only|workspace-write`
   plus `--add-dir`, and treat every Codex agent as *"holds exec + web + sub-agent
   tools no matter what; the switches decide only where it may write."* Drop the
   `opensCodexWebSearch`/`multi_agent` toggles' pretence of gating tools (keep
   sending them, since a future CLI that honours them fixes us for free — the code
   already argues this at `codex.ts:326-336`).

3. **Build the Codex prompt from the real surface, not the switches (fixes F7).**
   `buildAgentPrompt` for Codex should read `HARNESS_ISOLATION.codex` and never
   emit the word "CANNOT" for a tool that survives (`web.run`, `exec`,
   `collaboration.*`). An agent that is told it cannot do a thing it can do is the
   same failure `abilities.ts` was written to prevent (`abilities.ts:1-16`), only
   pointed the other way.

4. **Contain skills at the process boundary (fixes F5, needs a live check).**
   Launch Codex with a **Cloud9-owned `CODEX_HOME` that is a populated clone**
   (empty `skills/`, but a real `auth.json` copied in so login survives — an empty
   one signs out, per `codex.ts:276-280`), and additionally neutralise
   `~/.agents/skills` by pointing the child's `HOME`/`USERPROFILE` at a scratch dir
   for the turn (or by upstreaming a `--no-skills` request to codex-cli). Whether a
   copied `auth.json` survives is **SUSPECTED** and must be probed before shipping.

5. **Lock it with one class test.** For every capability row, assert that turning
   it OFF measurably removes the tool on each harness that claims
   `togglesAreTheBoundary=true`; and for any harness where it is false, assert the
   prompt and screen text contain no "cannot" for a surviving tool. This turns the
   honesty rule (`isolation.ts:14-17`) from prose into a failing build.

---

## Finding tally

- **CONFIRMED — 7:** F1 (no `--tools`, root cause), F2 (`collaboration.*`
  spawn_agent survives helpers-off), F3 (`web.run` survives webSearch-off),
  F4 (`exec`/`shell_command`/`apply_patch` always present, sandbox-fenced only),
  F5 (owner skills load from two roots), F6 (schedules/background/connections/
  commands switches inert on Codex), F7 (prompt says "CANNOT" for surviving tools).
- **SUSPECTED — 2:** F8 (read-only sandbox may not block network egress / outside
  reads), F9 (shared `~/.agents/skills` content impact unmeasured).
- **Parity already achieved (no leak) — 4:** credential env stripping, owner MCP
  servers, owner `config.toml`/`.rules`, `CODEX_ALWAYS_DISABLED` features.
