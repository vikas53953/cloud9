# Run records — handoff to the wire protocol and the screen

**Written by:** the engine builder, 2026-07-29.
**Owns:** `packages/engine/src/**` only. Nothing in `packages/shared`,
`apps/relay` or `apps/desktop` was touched — this document is the request.
**Closes when done:** FR-TL-003, FR-AU-003, FR-TS-008; strengthens spec §24
criteria #11 and #13. It is chunk 2 of `spec-coverage-2026-07-29.md` §6.

---

## 1. What exists now, in one paragraph

Every agent turn — a chat reply, a delegated job, a scheduled check-in — now
leaves a **run record**: who asked, which agent, which app and model, when it
started and finished, how long it took, **every step the agent took** (commands
run, files read and written, searches made, web pages fetched, tools used, tools
*refused*), any error, and the token and cost figures the CLI itself reported.
Records are written into the agent's own folder and survive the app closing.
Alongside the raw record there is a one-line plain-words summary — *"Read 1
file, took 45 seconds, cost 76 cents."* — derived from the record, never
invented. None of it has reached a client yet, because the wire protocol lives
in `packages/shared` and that is someone else's file. This document is the
exact ask.

---

## 2. What the engine now exports

All from `@cloud9/engine`:

| Export | Plain-words role |
|---|---|
| `RunRecord` | One turn, start to finish. The whole object. |
| `RunStep`, `RunStepKind` | One thing the agent did, in shared words. |
| `RunUsage` | Tokens and money, each present only if the CLI said so. |
| `RunStore` | Where records live on disk; `save` / `list` / `read` / `prune` / `forget`. |
| `RunListEntry` | A row for a list screen: id, kind, outcome, time, ask, summary. |
| `summarizeRun(record)` | The plain-words line. |
| `shareableRun(record)` | The version that may leave this machine. **Always send this one.** |
| `redactForSharing(text)` | The rule behind it, if a client ever needs it directly. |
| `Engine.runs` | The store, live. |
| `Engine.lastRun` | The newest record this engine wrote. |
| `Engine.onRunRecorded` | Fires as each run finishes — the hook to forward from. |
| `traceClaude` / `traceCodex` / `traceFromStream` | The parser seam, if anyone needs to re-read a transcript. |

### The shapes

```ts
type RunStepKind =
  | "command"   // ran something on this computer
  | "read"      // opened a file
  | "write"     // wrote or changed a file
  | "search"    // searched files on this computer
  | "web"       // searched or fetched something online
  | "tool"      // used some other tool
  | "thinking"  // reasoning the CLI reported
  | "message"   // said something
  | "note";     // the CLI told us something about itself (incl. a REFUSED tool)

interface RunStep {
  seq: number;          // 1, 2, 3 … in the order they happened
  kind: RunStepKind;
  label: string;        // "Read note.txt", "Ran a command"  (≤120 chars)
  detail?: string;      // the specific thing acted on       (≤300 chars)
  ok?: boolean;         // ONLY when the CLI reported an outcome
}

interface RunUsage {
  inputTokens?: number; outputTokens?: number;
  cachedInputTokens?: number; reasoningTokens?: number;
  costUsd?: number;     // Claude reports this. Codex does not.
}

interface RunRecord {
  id: string;                 // "r-<time>-<noise>", sorts by time, safe as a file name
  kind: "chat" | "task" | "schedule";
  agentId: string; agentName: string;
  provider: string;           // "claude" | "codex" | "mock"
  model?: string;             // what we ASKED for
  actualModel?: string;       // what the CLI says it used (Claude only)
  channelId?: string; taskId?: string;
  requestedBy: string;        // the person's NAME, so the record reads on its own
  requestedByKind: "human" | "agent" | "schedule";
  ask: string;                // what they asked for (≤500 chars)
  startedAt: number; finishedAt: number;
  durationMs: number;         // measured by Cloud9. Always present.
  cliDurationMs?: number;     // claimed by the CLI. Claude only.
  outcome: "ok" | "failed" | "cancelled";
  error?: string;             // plain words, already redacted
  steps: RunStep[];
  usage?: RunUsage;
  sessionId?: string;         // the CLI's own conversation id
  numTurns?: number;          // Claude only
  replyChars: number;         // the reply TEXT is not copied into the record
  events: number;             // JSON events we understood
  truncated?: boolean;        // steps were dropped to keep this small
}
```

---

> **STATUS 2026-07-29, second pass — §1–3 are DONE and this is now a record of
> what shipped, not a request.** The types moved, the frames exist, the relay
> stores and serves them, `Task.runId` is real, and everything is authorised
> from stored state and redacted on the way out. Section **4.1a** below is the
> renderer's half: the exact frames a client sends and receives. Nothing in §4
> has been built — that is still the screen's job.
>
> Baselines after the pass: build clean, **174 engine** (was 167), **92 relay**
> (was 76).

---

## 3. Protocol additions needed — `packages/shared/src/index.ts`

Move the four types above (`RunStepKind`, `RunStep`, `RunUsage`, `RunRecord`)
plus `RunListEntry` into `packages/shared`, and have the engine import them
instead of defining them. They were defined in the engine only because that file
was not mine to edit; they are wire types and belong in the shared dictionary.
**Nothing else about them should change** — the tests in
`packages/engine/src/runrecord.test.ts` pin the shapes against real CLI output.

### Frames the engine will send (`ClientFrame`)

```ts
| { type: "runRecorded"; record: RunRecord }
```

Sent once as each run finishes. Wire it to `Engine.onRunRecorded`, and send
`shareableRun(record)`, never the raw one.

```ts
| { type: "runList"; agentId: ID; limit?: number }
| { type: "runDetail"; agentId: ID; runId: string }
```

Answers to a client asking for history. Serve them from `Engine.runs.list()` and
`Engine.runs.read()`, again through `shareableRun`.

### Frames the relay will send (`ServerFrame`)

```ts
| { type: "run"; record: RunRecord }          // one run, new or asked for
| { type: "runs"; agentId: ID; runs: RunListEntry[] }
```

### Relay work (`apps/relay/src/**`)

1. **Store them.** A `runs` table keyed by `id`, with `agent_id`, `task_id`,
   `owner_id`, `started_at` and the record as JSON. The engine's own copy is the
   local truth; the relay's copy is what other clients read.
2. **Attach a run to its task.** `Task` should gain `runId?: string`. This is
   the single most valuable line in the whole handoff: it is what turns "the job
   finished" into "here is what it did", and the record already carries
   `taskId`.
3. **Guard it like a message.** A run record may only be sent to someone who can
   see the channel it belongs to (`channelId`), and only the owner may ask for
   an agent's history. A guest must never be able to list another person's runs.
   The engine has already stripped paths, usernames, argv and environment; the
   relay must not undo that by echoing raw errors alongside.
4. **Log it.** One `activity` row per run, kind `run_recorded`, so the existing
   Activity panel gains the thing it was always missing.
5. **Retention.** The engine keeps 50 runs per agent on disk and prunes the
   oldest. The relay should have its own limit. Spec question **Q7** (how long
   should the log be kept) improves this but does not block it.

---

## 4. What the screen should show — `apps/desktop/src/App.tsx`

The approved design is `docs/mocks/p3-studio.html`. Its agent-output block is
already the right shape: a `.callout` with a titled head, a `dl.kv` of labelled
rows, and an `.actions` row. A run record wants exactly that.

### 4.1 Under a finished job (the main one)

In the Tasks panel, and under the `📦 Task done:` message in chat, render one
callout:

```
┌ ✅ Scout finished “find three villas in Goa under 8k”
│ Checked 4 sites, read 1 file, took 41 seconds, cost 76 cents.
│
│ ASKED BY     Vikas · 09:26 today
│ RAN ON       Claude · claude-sonnet-5
│ TOOK         41 seconds
│ COST         76 cents            ← omit the whole row when absent
│
│ ▸ What it did  (4 steps)
│
│ [ Open the result ]  [ See every step ]
└
```

- The bold line under the title is `summarizeRun(record)` verbatim. It is the
  one line a non-developer reads, and it is the reason this feature exists.
- The `dl.kv` rows are `mock` class `kv` / `dt` / `dd`, unchanged.
- **A row whose value is absent must not be rendered at all.** No "—", no "0",
  no "unknown". Codex reports no cost, so a Codex job simply has no COST row.
  Showing a zero where the CLI said nothing is the exact lie this whole feature
  was built to stop.

### 4.1a The wire, exactly as built — READ THIS FIRST

Everything below is in `packages/shared/src/index.ts` and is what the relay
really speaks. `apps/desktop/src/store.ts` already has `case "run"` and
`case "runs"` sitting in its frame switch; filling them in is the whole job.

#### What you import

From `@cloud9/shared` — **not** from `@cloud9/engine`, which is a Node package
and has no business in a browser bundle:

```ts
import {
  RunRecord, RunStep, RunStepKind, RunUsage, RunListEntry,
  RunKind, RunOutcome, RUN_LIMITS, RUN_RETENTION,
  summarizeRun, countSteps, humanDuration, humanMoney, runListEntry,
} from "@cloud9/shared";
```

`summarizeRun(record)` is the bold line in §4.1, verbatim. `humanDuration` and
`humanMoney` write the TOOK and COST rows. Do not write your own versions of
these three — the hub puts the same sentence in its activity trail and in every
`RunListEntry.summary`, and two spellings of "76 cents" is a bug the owner will
see before we do.

#### What you send

```ts
// "what has this agent been doing" — §4.3, the Recent work rail.
// OWNER ONLY. Asking about someone else's agent errors "not your agent".
{ type: "runList"; agentId: ID; limit?: number }

// "what did this job actually do" — the Tasks panel and the 📦 Task done card.
// Anyone who can see the conversation the job was asked for in.
{ type: "runList"; taskId: ID; limit?: number }

// one run, in full, for the expanded step list (§4.2)
{ type: "runDetail"; runId: string }
```

`limit` is clamped to `RUN_RETENTION.listPage` (50); leaving it out gives
`RUN_RETENTION.listDefault` (20). Naming neither `agentId` nor `taskId` is an
error, not a list of everything.

There is **no `runRecorded` for you to send.** It is engine-only and the relay
refuses it from a desktop connection.

#### What you receive

```ts
// Pushed the moment a turn finishes, unasked, to every client of every person
// who can see the conversation it happened in — plus the agent's owner always.
// ALSO the answer to `runDetail`.
{ type: "run"; record: RunRecord }

// The answer to `runList`. It echoes back which question it is answering, so
// two lists in flight at once cannot be confused for each other.
{ type: "runs"; agentId?: ID; taskId?: ID; runs: RunListEntry[] }

// And the field that makes the whole feature findable:
interface Task { /* … */ runId?: string }
```

`Task.runId` arrives on an ordinary `{ type: "task"; task: Task }` broadcast, a
moment after the task goes `completed`. **Absent until a run has been recorded**,
and absent forever on every task from before this round — so the callout is
rendered only when `task.runId` is there, never with a placeholder.

#### The four things that will bite you

1. **A `run` frame can arrive for a run you have never heard of**, in a channel
   you have open or one you do not. Key your cache by `record.id` and index
   `record.channelId` / `record.taskId` off it; do not assume you asked.
2. **Absent means absent.** `usage`, `usage.costUsd`, `cliDurationMs`,
   `actualModel`, `numTurns`, `sessionId`, `step.ok` and `error` are all
   genuinely optional. §4.1's rule — *a row whose value is absent must not be
   rendered at all* — is the reason this feature exists. A Codex run has no
   `usage.costUsd` and never will; see §5.
3. **The text is already redacted, and it is redacted twice.** The engine
   applies `shareableRun` before sending and the relay applies it again before
   handing it out, so paths are already down to `note.txt` and the owner's
   account name is already gone. Do not "tidy" a label or a detail further —
   what survived is what the owner is meant to see. Do not try to reconstruct a
   full path.
4. **`step.detail` on a `web` step is a real URL and is passed through intact**
   (URLs are deliberately protected from redaction). It is the one detail that
   should be a link. Everything else is text — render it as text, through the
   same `<Markdown>`-free path a file name goes through.

#### A worked example, from a real shape

```ts
// arrives unasked, ~1 tick after "📦 Task done:" lands in the channel
{
  type: "run",
  record: {
    id: "r-m2k9x1abc-4f7q",
    kind: "task",
    agentId: "a_scout", agentName: "Scout",
    provider: "claude", model: "claude-sonnet-5", actualModel: "claude-sonnet-5",
    channelId: "ch_general", taskId: "t_villas",
    requestedBy: "Vikas", requestedByKind: "human",
    ask: "find three villas in Goa under 8k",
    startedAt: 1769..., finishedAt: 1769..., durationMs: 41_000,
    cliDurationMs: 40_120,
    outcome: "ok",
    steps: [
      { seq: 1, kind: "web",  label: "Read a web page", detail: "https://villas.example/goa", ok: true },
      { seq: 2, kind: "read", label: "Read notes.md",   detail: "notes.md", ok: true },
      { seq: 3, kind: "note", label: "Refused to use Bash" },
    ],
    usage: { inputTokens: 9_291, outputTokens: 640, cachedInputTokens: 4_100, costUsd: 0.76 },
    sessionId: "…", numTurns: 3,
    replyChars: 812, events: 24,
  },
}
```

`summarizeRun` of that is exactly:

> `Checked 1 site, read 1 file, took 41 seconds, cost 76 cents.`

Note step 3: `ok` is **absent**, so it gets no tick and no cross, and it is the
`note` kind §4.2 says to highlight — the first evidence Cloud9 has ever had that
a permission boundary held.

#### What the client is NOT allowed to do

- **Do not ask for another person's agent's history.** `runList` by `agentId` is
  owner-only, by design: sharing a room with someone's agent shows you the turns
  it takes *there*, and is not a licence to read everything it has ever done.
  If a details rail is open on somebody else's agent, hide Recent work; do not
  ask and swallow the error.
- **`runDetail` on a run you may not see answers `"no such run"` — the same
  sentence an invented id gets.** That is deliberate so an id cannot be probed.
  Treat both the same way: the run is not there.
- **Do not cache a run past `agentDeleted`.** The hub forgets an agent's runs
  when the agent goes; a client that keeps drawing them is showing something
  that no longer exists anywhere else.

### 4.2 The step list (expanded)

One row per `RunStep`, in `seq` order, with an icon per `kind`:

| kind | icon | reads as |
|---|---|---|
| `command` | terminal | `Ran a command` — `detail` in mono, one line, truncated |
| `read` | document | `Read note.txt` |
| `write` | pencil | `Wrote plan.md` |
| `search` | magnifier | `Searched the files on this computer` |
| `web` | globe | `Read a web page` — `detail` is a URL and **should be a link** |
| `tool` | wrench | `Used <tool>` |
| `thinking` | dotted | `Thought it through` — collapsed by default |
| `message` | speech | `Said something` — collapsed by default |
| `note` | shield | `Refused to use Bash` — **highlight this one** |

- `ok === false` → the pine/danger tint the mock already uses.
- `ok === undefined` → **no tick and no cross.** The CLI did not say.
- `truncated === true` → a line at the end: *"Some steps were left out to keep
  this small."*
- A `note` step of the "Refused to use …" form is the first evidence Cloud9 has
  ever had that a permission boundary actually held. It should read as a good
  thing, not an error.

### 4.3 On the agent

A **Recent work** section in the agent's details rail: the last few
`RunListEntry` rows — time, `ask`, `summary`, and outcome. That is FR-ME-003's
"what has this agent been doing" with real evidence behind it.

### 4.4 Where it must NOT appear

Not inline in the chat river by default. The chat message stays the agent's
sentence; the record is one line and a disclosure. The mock's `.callout` is
already a disclosure-shaped thing — keep it that way.

---

## 5. What each CLI genuinely cannot tell us

Verified live on this machine, 2026-07-29 (`claude 2.1.220`,
`codex-cli 0.146.0`). **Nothing below is filled in with a guess.**

| | Claude | Codex |
|---|---|---|
| Steps (tool calls) | yes, one line each | yes, one item each |
| Tool arguments (file, query, URL) | yes | for commands; file changes give paths |
| Per-step success | yes (`is_error` on the tool result) | yes (`exit_code`, `status`) |
| Tools it was REFUSED | yes (`permission_denials`) | **no** — never reported |
| Its own duration | yes (`duration_ms`) | **no** |
| Model actually used | yes | **no** — never names it |
| Input / output tokens | yes | yes |
| Cached tokens | yes | yes |
| Reasoning tokens | **no** | yes |
| **Money** | yes (`total_cost_usd`) | **no** — and we do not compute one |
| Conversation id | yes (`session_id`) | yes (`thread_id`) |
| Turn count | yes (`num_turns`) | **no** |

Two consequences the screen must respect:

1. **A Codex job can never show a cost.** Do not add "estimated" anywhere.
2. **A Codex job cannot prove a tool was refused.** Claude can. Until Codex
   reports denials, the promise "the agent used only what it was allowed to"
   (criterion #11) is *evidenced* for Claude and only *requested* for Codex.
   That difference should be visible to the owner rather than smoothed over.

---

## 6. One change the engine already made, that you should know about

`claudeArgs` now asks for `--output-format stream-json --verbose` instead of
`--output-format json`. The streamed form is a strict **superset**: the same
final result envelope arrives as the last line, preceded by one line per tool
call and tool result. With plain `json` the CLI tells us the answer and nothing
whatsoever about how it got there, so there was no run record to build. Verified
live; `parseClaudeJson` still returns exactly what it always did, and still
falls back to the old single-envelope shape.

---

## 7. Three other things that landed in the same pass

These were asked for mid-round and are all in `packages/engine/src/**`. They are
here because they change what the screen should say.

### 7.1 An agent now knows what it can do (`abilities.ts`)

Vikas asked a Sonnet agent what it could do and it told him it could not browse
the internet — while `webSearch` was ON and the CLI had WebSearch and WebFetch
in its hands. `buildAgentPrompt` had never mentioned abilities at all, so the
agent answered from the model's generic idea of a chatbot.

There is now ONE table (`CAPABILITIES` in `packages/engine/src/abilities.ts`)
where each row carries both the tools an ability grants **and** the sentence the
agent is told, on and off. `claudeArgs`, `codexArgs`, `SdkProvider` and
`buildAgentPrompt` all read it — three duplicated copies of the abilities→tools
mapping collapsed into one. Granting a tool without telling the agent is no
longer possible; it is the same row.

**For the screen:** nothing required. If you ever surface "what can this agent
do" in the UI, read `CAPABILITIES` rather than writing the list again.

### 7.2 Agents no longer inherit the owner's personal setup

Measured, not inferred (2026-07-29). An agent whose only ability was "search the
web" was arriving at the model holding **30 built-in tools** (Task, the Cron
family, SendMessage, worktrees, RemoteTrigger), **every MCP server on Vikas's
machine** — Telegram, Vercel, Notion, Gmail — **130 of his slash commands**, and
his global `CLAUDE.md`. The ability toggles were not the boundary they claimed
to be.

Claude agents now run with `--safe-mode --strict-mcp-config
--disable-slash-commands` and an explicit `--tools <exact set>`. Re-probed: the
tool list is exactly the agent's own, MCP servers none, slash commands none, and
**the login still works** (pointing `CLAUDE_CONFIG_DIR` at an empty folder does
not — it reports "not logged in"). A pleasant side effect, measured on the same
prompt: 48,843 cached tokens and 41 cents before, 9,291 and 9 cents after — the
owner's whole configuration had been paid for on every single turn.

Codex agents run with `--ignore-user-config --ignore-rules`, which keeps the
login and drops `config.toml`. **It is not enough**, and this belongs in front
of the owner:

- Codex has **no `--tools`**, so its built-in surface cannot be declared.
  `collaboration.spawn_agent`, `list_mcp_resources`, `web.run` and
  `image_gen.imagegen` are still present.
- The owner's `$CODEX_HOME/skills` are **still loaded** — a live turn still
  emitted the CLI's own "skill descriptions were shortened" note.

**For the screen:** a Claude agent's toggles now govern its whole tool surface;
a Codex agent's toggles govern only its sandbox. If the UI ever says "this agent
can only use what you allowed", that sentence is true for Claude and not yet
true for Codex, and it should not be shown identically for both.

### 7.3 A guest can no longer drive the owner's agents

`chatter.ts:shouldReply` returned true for any DM and for any on-topic free
chatter without asking who was speaking, so an invited friend could spend the
owner's subscription by opening a direct message. It now calls the same
`mayDriveAgent` from `@cloud9/shared` that the relay uses — imported, not
re-implemented. `Engine.maybeRunTask` calls it too, as the last gate on the
machine that would actually spend the money.

**For the screen:** a refusal is **silent** — no chat message — so a guest
cannot use a polite refusal to discover which agents exist. If the owner should
know it happened, that needs an activity row from the relay, not a chat line.

#### ⚠ One relay test now fails, and it should

`apps/relay/src/integration.test.ts`, test *"cloud9 end-to-end: agents chat with
humans across the relay"*, has the invited friend Priya @mention the owner's
agent Scout and asserts that a reply comes back. Under owner-only-by-default
that is exactly the hole we just closed, so it times out.

**Proven, not assumed:** with the one guard line commented out, the relay suite
is 52/52; with it restored, 51/52 and only that test fails.

I have not edited it — `apps/relay/src/**` has another owner who is editing it
right now, and a blind edit would collide. **The fix is one field**, at the
`createAgent` call on line ~64 of that test:

```ts
      abilities: { webSearch: true, files: false, schedules: true, background: true },
      respondTo: "anyone",   // ← this test is about a FRIEND driving the agent
```

Alternatively, split it: keep the friend's mention as a `respondTo: "anyone"`
case, and add a second agent left at the default that proves the friend gets
nothing. The second half is the more valuable test.

---

## 8. Order to do this in

1. ~~Move the five types into `packages/shared` and delete the engine's local
   copies.~~ **DONE.** Seven types plus `RUN_LIMITS`, `summarizeRun`,
   `shareableRun` and `redactForSharing` all moved; the engine re-exports them
   so `@cloud9/engine` keeps its published surface, but there is exactly one
   definition of each and a test asserts *identity*, not equality, so a second
   copy cannot quietly reappear.
2. ~~Add `runRecorded`; relay stores it and logs an activity row.~~ **DONE.**
   `Engine.publishRun` sends `shareableRun(record)` on every recorded run
   (including a cancelled one); the relay stores it in a `runs` table, writes an
   `activity` row of kind `run_recorded`, and pushes a `run` frame to the room.
3. ~~Add `Task.runId`.~~ **DONE** — set by the hub from the record's own
   `taskId`, and only when that task really belongs to that agent.
   **Showing the summary callout under a finished job is still open** and is
   the next thing worth doing: it is the moment the feature becomes visible.
   Everything it needs is in §4.1 and §4.1a.
4. ~~Add `runList` / `runDetail`.~~ **DONE** on the wire and on the hub. The
   expanded step list (§4.2) is still open.
5. Add **Recent work** to the agent rail (§4.3). Still open. Owner-only — see
   §4.1a's last block.

### 8.1 What is enforced, and where — so the screen does not re-do it

| Question | Answered by | Where |
|---|---|---|
| May this connection report a run at all? | `conn.client === "engine"` | `Relay.recordRun` |
| Whose agent is this? | `myAgent` (stored state) | `Relay.recordRun`, `runList` |
| Which room was it in? | `channelFor` (stored state) | `Relay.recordRun`, `canSeeRun` |
| May this person read this run? | `canSeeRun` — owner, or the room | `runDetail`, `runList` |
| What may leave this machine? | `shareableRun` → `redactForSharing` | engine on send, relay on store AND on serve |
| Is it bounded? | `validateRunRecord`, `fitRunRecord`, `RUN_RETENTION` | `Relay.recordRun`, `Store.saveRun` |

A claim the record makes that does not check out is **dropped, not obeyed**: an
unverifiable `channelId` leaves the run visible to its owner alone, and a
`taskId` naming another agent's job is simply not recorded — and neither
survives *inside* the record either, so a screen can trust the fields it reads.
