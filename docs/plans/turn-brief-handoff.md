# The turn brief, the window and the first doorway — the contract

**Written 2026-07-30 by the round that fixed `docs/qa/gap-audit.md`.**
Read the audit first; this file only says what changed and what a screen must
now draw differently.

Nothing here is on Vikas's screen yet, and most of it never will be — it is what
his agents receive, not what he looks at. The two things a screen DOES have to
change are in §5, and they are small.

---

## 1. What was wrong, in one paragraph

An agent taking a turn was handed twenty flat lines of chat and nothing else. It
was never told what it had been asked to do — a background job and a 6:30am
check-in got the same prompt as a chat reply, byte for byte, 3,233 characters,
measured. It could not search, could not see an attachment, could not tell a
thread from the main talk. And on the top rung it was told it could reach outside
files and connected services, while the launcher supplied neither.

Four owners now exist where there were none.

---

## 2. `TurnBrief` — one owner for "what is this turn?"

`packages/engine/src/provider.ts`

```
buildAgentPrompt(agent, turn: TurnBrief)     // was: (agent, context: string)
```

**The class rule:** a prompt is built from the whole turn or not at all. The
function **throws** on an empty instruction, so a provider added next year
cannot quietly drop it the way all three current ones did. The prompt now has
named parts:

| Part | Where it comes from |
|---|---|
| who you are | `agent.name`, `agent.persona` |
| what you can actually do | `renderCapabilities(agent, supply)` — §4 |
| what Cloud9 gives you | `renderCloud9Tools()`, only when the doorway is open |
| **what you have been asked to do right now** | `turn.trigger` — this is the new part |
| how long an answer suits | `turn.kind`, derived to `repo` when there is a worktree |
| the conversation so far | `renderConversation` — §3 |

`kind` is `chat` / `task` / `schedule`, plus a derived `repo` whenever the turn
is standing in a worktree. Each gets its own closing instruction. **Only a chat
turn is told to keep it to 1-4 sentences**; a delegated job is told to report
what it actually did, at whatever length that takes.

## 3. `CONVERSATION_BUDGET` — one owner for "how much of the room?"

`packages/engine/src/context.ts`

Was `slice(-20)`, a default nobody had ever set. Now a named constant with its
justification written next to it: **24,000 characters** (≈6,000 tokens, ~3% of
the smallest window a Cloud9 agent can run on) and a ceiling of **200 messages**
so a room of one-word lines cannot become two thousand lines of noise. Spent
from the newest end backwards, so the thing just said is never what gets dropped.

Two facts that used to be thrown away are now carried, because they cost nothing:

- **attachments, by name** — `[files attached to this message: budget-q3.xlsx]`
- **thread structure** — a reply is indented with `↳` and names whose message it
  is under; a root says how many replies hang off it

`contextMessages` still works and is now a **ceiling on top of** the budget, for
tests and QA. Out of scope, deliberately: memory between conversations.

## 4. `grantedSupply` — one owner for "what did the launcher REALLY hand over?"

`packages/engine/src/abilities.ts`

A `Capability` row now has a **third face**. Two switches — *connected services*
and *files outside its own folder* — grant nothing by themselves; they only say
something MAY be passed in. `host.ts` passed neither, and the prompt said "you
CAN" anyway.

Every row that needs something supplied names it (`needsSupply`) and carries a
third sentence (`onButNothingSupplied`). The prompt and the command line both ask
`grantedSupply(agent, offered)`, so:

- the sentence "You CAN use connected services" appears **only** when
  `--mcp-config` is really on the line;
- the sentence "You CAN reach files outside your own folder" appears **only**
  when `--add-dir` is really on the line;
- a path handed to an agent without the switch still grants nothing.

Tested in **both** directions (`gap-audit.test.ts`).

`host.ts` still does not supply either, because nothing on any screen picks a
folder or an MCP file yet. That is unchanged and it is now honest.

## 5. The first doorway — search

`packages/engine/src/cloud9tools.ts`, `toolbridge.ts`, `cloud9mcp.ts`

Cloud9 now supplies **one tool of its own**: `search_conversation`. It is handed
to the harness as an MCP server (`--mcp-config`, alongside the existing
`--strict-mcp-config`), and the sentence in the prompt comes from the same table
as the tool name, so one can never exist without the other.

**The law, and the whole of it:**

> An agent may search only the conversation it is taking a turn in.

It is **not gated behind a switch**, because it cannot honestly be: every agent
on every rung, including *Just talk — no tools at all*, is already handed the
recent messages of that room. Reading the room it is standing in is what a turn
is; searching the same room is that power reaching further back. Searching any
**other** room is a different power and is refused.

Four things enforce it, and none of them is the only one:

1. the tool has exactly one parameter, `query` — there is no channel to name;
2. an argument invented to widen it is **refused**, not ignored;
3. the ticket the MCP child holds is minted by the engine with the conversation
   closed over it, and dies when the turn ends;
4. the hub checks membership again on its own side.

Proved by `packages/engine/src/cloud9tools.test.ts` and
`apps/relay/src/agentsearch.test.ts`.

**Transport, and why:** a loopback-only HTTP bridge with a random per-turn
secret. The alternative was to hand the MCP child the owner's relay token so it
could talk to the hub itself — that would have written a durable credential into
a JSON file on disk. The ticket is worth nothing a minute later.

### MEASURED 2026-07-30 ~22:20 — the unknown below is settled

The conductor ran the probe on this machine (one live Sonnet turn, tiny prompt),
with a real `ToolBridge` serving a planted sentence. Result, all from one run:
`system/init` listed `mcp__cloud9__search_conversation` in `tools`;
`mcp_servers` said `{"name":"cloud9","status":"connected"}`; the bridge's search
handler was invoked with `{"query":"amber wolf","limit":20}`; and the model's
answer repeated the planted sentence word for word. The doorway works end to
end: CLI → MCP child → loopback bridge → engine handler → model's mouth.
(The original unknown is kept below for the record.)

### The original note — NOT MEASURED at the time of building

`abilities.ts` records that `claude -p --tools NotARealToolXYZ` **exits 0 and
answers normally** — an unknown tool name is not an error, it is a capability
that silently never arrives. So including `mcp__cloud9__search_conversation` in
`--tools` and `--allowed-tools` cannot break a turn. What has **not** been run on
this machine is whether the CLI then really offers the tool to the model.

**To settle it, one command:**

```
claude -p --output-format stream-json --verbose --permission-mode dontAsk \
  --safe-mode --strict-mcp-config --disable-slash-commands \
  --mcp-config <the .cloud9-mcp.json a turn writes> \
  --tools mcp__cloud9__search_conversation \
  --allowed-tools mcp__cloud9__search_conversation
```

and read the `system/init` event's `tools` and `mcp_servers`. Until somebody does
that, the doorway is **built and unit-proved, not observed end to end**.

## 6. `refusalText` — one owner for "no" on the hub

`apps/relay/src/refusal.ts`

`send(ws, { type: "error", error: String(err) })` put the word **Error:** in
front of every hand-written refusal, and would have printed a raw `TypeError`
under a form. Now every error text on the hub goes through one function that:

- strips any `Error:` / `TypeError:` / `SqliteError:` prefix and any stack;
- shows the words **only** of an `Error` or a `Refusal` — anything with a class
  name of its own is machinery and is replaced by a plain sentence;
- never shows a bare error code or a path off this machine's disk.

A test reads `server.ts` and fails if a second way of turning an exception into
screen text ever appears.

---

## 7. What a screen must draw differently

**Almost nothing, and that is on purpose.** Two items:

1. **`plainError()` in `App.tsx` can stay, and should.** The hub no longer emits
   the prefix, so the strip is now belt-and-braces rather than the only owner. It
   costs nothing and covers anything that still throws elsewhere. The bug the
   audit photographed — the toast polite and the inline line not — is closed at
   the source, so both now read the same.
2. **Nothing else changed shape.** No new server frame, no new client frame, no
   change to `AgentDef`, `Message`, `Channel` or `RunRecord`. `apps/desktop` was
   not touched by this round and needs no `store.ts` case.

## 8. What this round did NOT do

- **No memory between conversations.** The window is wider and searchable; it is
  still one conversation.
- **No attachment reading.** An agent is told a file is attached, by name, and is
  not told it can open one, because it cannot. That is the next doorway.
- **No run-record reading, no in-channel patches, no notifications for agents.**
  All still true gaps, all still written down in the audit.
- **No folder picker and no per-agent MCP file.** Those two switches remain
  inert; the difference is that the prompt now says so.

## 9. Evidence, run on 2026-07-30 in the session that wrote this

| Command | Result |
|---|---|
| `npm run build` | clean |
| `npm test` | **405 (engine) + 209 (hub) + 11 (desktop) = 625 pass, 0 fail** |
| bugs put back, engine suite re-run | **9 of the new checks failed**, then passed again once restored — the checks can fail |

`npm run qa` and `npm run qa:app` were **not** run by this round.
