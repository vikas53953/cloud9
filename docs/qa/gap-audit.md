# Gap audit — checking the agents' own gap analysis

**Written 2026-07-30 by an auditor session. No code was changed.**
Only two things were written: this file, and the `gap-audit-*.png` pictures beside it.

Your own agents — the ones running inside Cloud9 — wrote a gap analysis saying
Cloud9 is **missing** shared artifacts, provenance, search, in-channel patches and
integrations; **weak** on notifications and error legibility; and that there is
**no turn discipline** (you had to say "the file's on disk" four times).

Some of that is wrong. Some of it is right for a reason nobody had spotted, and
that reason is the most important thing in this document.

**The headline: your agents were not describing Cloud9. They were describing the
tiny slot Cloud9 pushes them through.** An agent taking a turn is handed 20 flat
lines of chat text and nothing else — no search, no files, no threads, no job
instruction, no memory, and no way to ask Cloud9 anything. Everything you can see
on screen genuinely exists. Almost none of it exists *for them*. So when they said
"absent", they were being honest about their own world, and they had no way to know
about yours.

Everything below is tagged **CONFIRMED** (I reproduced it and the evidence is
named) or **SUSPECTED** (I could not reach it; the last line says what you would
have to do to settle it).

---

## How this was tested

- A throwaway Cloud9 was started on its own ports (hub `8940`, screen `4370`) with
  a brand-new empty database, in demo mode, so no real agent turns were spent and
  nothing touched your real Cloud9. Command:
  `CLOUD9_RELAY_PORT=8940 CLOUD9_UI_PORT=4370 CLOUD9_DEMO=1 node scripts/qa-stack.mjs --stack-only`
  plus a `vite preview` on 4370.
- The screens were driven with Playwright, the same tool your QA suite uses.
- **The prompt probe.** For the turn-discipline part I did not read the code and
  describe it. I ran the engine's own compiled code (`packages/engine/dist/`) with
  a stand-in for Claude that writes down *exactly* what it was handed, then printed
  the prompt verbatim. That printout is quoted below and is the strongest evidence
  in this file.
- **The chat screen was left alone** — another agent owns it right now. The
  seamlessness sweep covers everything else: the icon rail, the crew, the casting
  room, the agent editor, Tasks, Projects, the Log and Setup.

---

## 1. The verdict table

| What the analysis claimed | Verdict | In one line |
|---|---|---|
| **Search — absent** | **EXISTS BUT AGENTS CANNOT REACH IT** | Full-text search is built, indexed and on your screen. An agent has no way to run one, and is never told search exists. |
| **Provenance — absent** | **EXISTS BUT AGENTS CANNOT REACH IT** | Run records — every step, every file touched, tokens, cost — are stored and drawn on screen. No agent can read one, not even its own. |
| **Shared artifacts — absent** | **EXISTS BUT AGENTS CANNOT REACH IT** (files), **TRUE GAP** (agents making them) | People can attach files to messages and everyone in the room sees them. An agent is never told the attachment exists, cannot open one, and cannot put one in the room. |
| **In-channel patches — absent** | **TRUE GAP** | Nothing renders a change-set in the conversation for you to accept. `!code` exists but its product is a GitHub pull request, not a patch in the room. |
| **Integrations — absent** | **TRUE GAP, and worse than "absent"** | The switch exists and the agent is *told it works*, while the app supplies nothing behind it. The agent is being lied to. |
| **Notifications — weak** | **MOSTLY EXISTS AND REACHABLE — analysis was wrong** for you; **TRUE GAP** for agents | Unread counts, per-account read state, quiet hours and desktop pop-ups all work. An agent cannot see or raise one. |
| **Error legibility — weak** | **CONFIRMED WEAK, in specific named places** | The intention is excellent and mostly kept. There are five real leaks where raw computer text reaches your eyes. See §4. |
| **"No turn discipline"** | **CONFIRMED — and much worse than they described** | See §2. A background job and a scheduled check-in never receive their instruction at all. |

---

## 2. Turn discipline — exactly what an agent gets, and why you repeated yourself

### 2.1 The one paragraph that explains it — CONFIRMED

Every turn an agent takes is built by one function, `renderContext` in
`packages/engine/src/engine.ts` line 753:

```
private renderContext(channelId, n = this.opts.contextMessages ?? 20): string {
  const history = this.history.get(channelId) ?? [];
  return history.slice(-n).map(m => `${m.authorName}: ${m.text}`).join("\n");
}
```

That is the whole of an agent's world. In plain words:

- **The last 20 messages of that one conversation. Nothing before them.** The 20
  is a default nobody ever overrides — I searched the whole repo for
  `contextMessages` and it is set in exactly zero places outside the option's own
  declaration.
- **Only the name and the words.** Everything else on a message is thrown away:
  the attached file, whether it was a thread reply, whether it was edited,
  whether it was deleted, the reactions, the time it was said.
- **Nothing about the room.** Not its name, not who else is in it, not what it is for.
- **No memory.** Each turn is a brand-new `claude -p` (or `codex`) run with a
  fresh prompt. Nothing carries over. The prompt says so out loud: *"You do not
  remember past conversations."*

**Why you had to say "the file's on disk" four times.** You said it once. Twelve
messages later it had fallen out of the 20-message window and, as far as the agent
was concerned, you had never said it. It was not ignoring you. It could no longer
see you saying it. I reproduced exactly this: I put *"The file is already on disk at
report.md — read it, do not rewrite it"* as message 1 of 32, and the prompt that
reached the agent began at message 13.

### 2.2 The finding nobody had spotted — CONFIRMED

**A background job and a scheduled check-in never receive their instruction.**

The engine carefully builds an instruction for every turn and calls it `trigger`:

- a delegated job → `"Background task: <the job>. Do the work and report the outcome."`
- a scheduled check-in → `"Scheduled task fired: <what you scheduled>"`
- work in a repository → the ask plus a briefing naming its branch and repository

And then **`trigger` is thrown away.** The function that turns a turn into a prompt
is `buildAgentPrompt(agent, context)` in `packages/engine/src/provider.ts` line 156 —
it takes the context and *only* the context. All three real engines
(`ClaudeCliProvider`, `CodexProvider`, `SdkProvider`) call it that way. The only
thing that ever reads `trigger` is the fake demo provider used in tests.

Proof, from the probe (verbatim output):

```
### CHAT TURN
trigger the ENGINE built   : "chit-chat number 32"
is that trigger in the prompt the CLI receives? : YES     <- only by luck: it is
                                                            also the last context line
### BACKGROUND JOB
trigger the ENGINE built   : "Background task: read report.md and summarise it. …"
is that trigger in the prompt the CLI receives? : NO
### SCHEDULED TURN
trigger the ENGINE built   : "Scheduled task fired: check the build and post the result"
is that trigger in the prompt the CLI receives? : NO
```

All three prompts were **3233 characters and byte-for-byte identical**. A chat
reply, a delegated job and a 6:30am check-in are, today, the same prompt.

The consequences, plainly:

- **A scheduled agent never learns what it was scheduled to do.** Your instruction
  is not in the chat (you typed it into a schedule), and the trigger is dropped.
  At 6:30am the agent wakes up, reads the last 20 lines of yesterday's chat and
  writes a chat message about them.
- **A delegated job (`!bg …`) only half-works** — the job title survives *only*
  because you typed it as a chat message, so it is sitting in the context as one
  unmarked line among twenty. Nothing tells the agent that line is its job.
- **A repository turn is never told it is in a worktree**, on which branch, or in
  which repository. The briefing `repowork.ts` writes for exactly that purpose is
  dropped on the same line of code.
- **Nothing marks which message is the one being answered.** Twenty lines arrive
  and the agent is told "write your next chat message". If another agent spoke
  last, the ask is buried mid-list.
- **Every turn is told to keep it short.** The prompt ends: *"keep it chat-length
  (1-4 sentences unless a list is clearly needed)"* — including background jobs
  and repository work, where that is precisely wrong.

Here is the end of the real prompt for the scheduled turn. Notice that the words
"check the build" appear nowhere:

```
Recent conversation (oldest first):
Vikas: chit-chat number 13
… (18 more lines) …
Vikas: chit-chat number 32

Write your next chat message as Sol. Stay in persona, be genuinely useful, and keep
it chat-length (1-4 sentences unless a list is clearly needed). …
```

### 2.3 The class fix (not implemented — this is a proposal)

Give a turn **one owner that builds the whole brief**, and make the trigger part of
it by construction rather than by a caller remembering to pass it. Concretely:
replace `buildAgentPrompt(agent, context)` with `buildAgentPrompt(agent, turn)`
where `turn` is the existing `TurnInput` object — so the instruction, the kind of
turn (chat / job / schedule / repository), the workdir briefing and the context all
arrive together and a provider physically cannot render a prompt with the
instruction missing; then have that one function lay the brief out in named parts —
**who you are · what you have been asked to do right now · what kind of turn this
is and how long an answer suits it · what you are allowed to reach · the
conversation so far, with the message you are answering marked, attachments named
and thread replies indented** — and make the conversation part *pinned plus
recent* rather than a blind last-20, so a standing instruction like "the file is
already on disk" cannot age out of view while chit-chat pushes it off the end. One
function, one shape, and a test that fails if any turn kind reaches a provider
without its instruction inside the prompt — which is the check that would have
caught this the day the schedule feature was written.

---

## 3. What agents can and cannot reach — item by item

The reason every answer below is the same shape: **an agent has no way to talk to
Cloud9.** It is started as a one-shot command with a fixed, declared list of
built-in tools (`--tools`, `--strict-mcp-config`, `--safe-mode`,
`--disable-slash-commands`), and Cloud9 supplies **no tool of its own**. There is no
"search the chat" tool, no "read the attachment" tool, no "open the thread" tool.
`packages/engine/src/engine.ts` contains **zero** mentions of attachments, thread
replies or search results — I grepped it.

So the wall is not a missing feature. It is a missing doorway.

### Search — EXISTS BUT AGENTS CANNOT REACH IT — CONFIRMED
On your screen: full-text search over every message, built on SQLite's own FTS5
index, with a plain fallback scan on an old SQLite, snippets with the matched words
marked, filters by room and by author (`apps/relay/src/store.ts` lines 380–460 and
1096–1140). Already photographed in `docs/qa/chat-search.png`.
For an agent: nothing. The hub *would* answer a `search` frame from the engine —
the plumbing on the hub side is complete and open — but the engine never sends one,
and no tool exists for an agent to ask it to. The agent is not even told search
exists.

### Provenance — EXISTS BUT AGENTS CANNOT REACH IT — CONFIRMED
On your screen: a run record for every single turn, including the ones that failed —
each step it took, every file it read or changed, every command, tokens, cost, and
its own written summary (`runrecord.ts`, `runstore.ts`, drawn by `RunCard`).
Photographed in `docs/qa/run-card-light.png`, `run-steps.png`.
For an agent: no way to read any run record, including its own from five minutes
ago. This is the same wall as "no memory between conversations" — the memory is
written down carefully and then not handed back.

### Shared artifacts — SPLIT VERDICT — CONFIRMED
People-to-people works: attach a file to a message, everyone in the room can open
it, size limits enforced on both sides (`docs/qa/files-message.png`).
Agents are cut out of it in both directions. The probe proves the read side: a
message carrying `budget-q3.xlsx` reached the agent as the words *"here is the
spreadsheet"* and nothing else —
`does the context mention the attachment "budget-q3.xlsx"? : NO`.
And there is no frame or tool by which an agent could put a file into a room, so
"an agent produces something the room can look at" is a **TRUE GAP**.

### In-channel patches — TRUE GAP — CONFIRMED
Nothing in the app renders a proposed change for you to accept or reject in the
conversation. `apps/desktop/src/markdown.tsx` draws code blocks as code blocks; it
has no notion of a diff. `!code` is the nearest thing and it is a different shape:
the agent works in its own git worktree, commits to its own branch and asks
permission to open a pull request. That is a good design and it is not this. If you
want "here is the change, press yes", it does not exist.

### Integrations — TRUE GAP, and the worst kind — CONFIRMED
This one is not merely absent, it is **claimed**. Two switches on the top rung of
the reach ladder — *"Use connected services your owner picked for you"* and
*"Reach files outside its own folder"* — have nothing behind them in the shipped
wiring. `startEngineHost` in `packages/engine/src/host.ts` line 108 builds the
Claude provider with three settings and no more:

```
engine.provider = new ClaudeCliProvider({ agentDataDir, command, models });
```

The two settings that would make those switches real — `wholeComputerRoots` and
`mcpConfigPath` — are never supplied. So in `claudeArgs`, `--add-dir` is never
added and `--mcp-config` is never added.

Meanwhile the agent is told, word for word (this is from the real prompt above):

> • You CAN use the connected services your owner set up for you specifically. …
> • You CAN reach files outside your own folder, in the places your owner opened up for you.

`HANDOFF.md` §7 is honest that these are inert, and says *"the screen says so rather
than pretending"*. The screen may. **The prompt does not.** This is exactly the class
of bug `abilities.ts` was written to make impossible — the switch and the sentence
were kept in one row, but the *third* face of the fact, whether the host actually
supplies the thing, was left out of that row. An agent on the top rung will confidently
promise you connected-service work it has no tools for.

### Notifications — MOSTLY EXISTS AND REACHABLE FOR YOU (analysis was wrong); TRUE GAP FOR AGENTS — CONFIRMED
For you: unread counts per conversation with a sensible ceiling, mentions counted
separately, read position stored on the *hub* so it follows you between machines,
quiet hours, and desktop pop-ups with permission asked at the moment you switch
them on. That is not "weak"; it is more than most chat apps ship.
Two honest caveats. The sentence *"This computer is blocking Cloud9's pop-ups"*
only appears when the operating system has actually said no, which is correct — I
checked, because in my browser test it appeared and looked like a bug.
And for agents: an agent cannot see that anything is unread and cannot raise a
notification. `PushNotification` is on its granted tool list at the "background"
rung, but that is Claude's own tool, not Cloud9's, so it does not reach your app.

---

## 4. Error legibility — every place computer-speak reaches your eyes

The intention here is genuinely good. There is a single funnel,
`sanitizeForChat` in `provider.ts`, whose whole job is to stop raw error text
reaching a chat message, and most failures do go through it. The problem is that a
few paths route around it. Five leaks, worst first.

**4.1 CONFIRMED — the hub's catch-all sends raw computer text, and I have a picture
of it.** `apps/relay/src/server.ts` line 224 wraps *every* request from every screen
in `send(ws, { type: "error", error: String(err) })`. `String(err)` on an
exception produces `Error: <message>` — and any unexpected bug on the hub produces
things like `TypeError: Cannot read properties of undefined`.

Reproduced live: on the Projects screen I connected two repositories and gave both
the same nickname. The refusal appeared **twice, in two different states of
politeness**, side by side on the same screen:

- the pop-up toast said: *you already have a project called "Audit Box" — give this
  one a different name*
- the line under the form said: **`Error:`** *you already have a project called "Audit
  Box" — give this one a different name*

Picture: `docs/qa/gap-audit-error-prefix.png`. The toast is clean because
`plainError()` in `App.tsx` strips the `Error:` prefix; the inline line uses the
raw text and does not. Two owners for one sentence, and one of them shows you the
word "Error:" as though it were part of what went wrong. This is also the widest
leak in the app: it is not limited to sentences someone wrote for you.

**4.2 CONFIRMED — "the details are in the app's log."** `sanitizeForChat` in
`provider.ts` line 91 is the sentence an agent says when something broke:
*"something went wrong on my side and I couldn't finish that — the details are in
the app's log."* This is the deliberate design and it is defensible, but for you it
is a dead end: you are not going to open a log, and there is no button that shows
you one. Used from four places (`engine.ts` lines 558, 652, 747, 876) — so it covers
chat replies, background jobs, scheduled check-ins and repository work.

**4.3 CONFIRMED — the "What went wrong" line on a run card can be raw CLI text.**
`engine.ts` line 445 stores the failure as `redactForSharing(err.message)`, and
`App.tsx` line 1997 prints it verbatim as *"What went wrong"*. `redactForSharing`
removes secrets, paths and your machine's name — it does **not** turn computer-speak
into English. So that row can read things like `Claude exited with 1: fatal: …` or
`refusing to run agent ag_7f3: …`.

**4.4 CONFIRMED — a git or GitHub failure puts raw `git` output into the room.**
`repowork.ts` lines 180, 224 and 280 build the agent's chat message as
`"I could not open a workspace for this repository: " + err.detail`, where
`err.detail` is the first line of `git`'s or `gh`'s own error output —
e.g. *"fatal: could not read Username for 'https://github.com': terminal prompts
disabled"*. The app already owns a translator for exactly this, `whyGitHubSaidNo`
in `github.ts`, which turns rate limits, missing repositories and sign-in problems
into full sentences. It is wired to the read-only "look at GitHub" path and **not**
to the push and pull-request paths.

**4.5 CONFIRMED — the "cannot open the database" screen shows you a file path and a
raw SQLite message.** `apps/relay/src/store.ts` lines 131–140 build the sentence
that `App.tsx` line 850 prints word for word, and it embeds the full path plus
whatever SQLite said (e.g. `SQLITE_CORRUPT: database disk image is malformed`).
This is the one screen a non-developer meets at the worst possible moment.

**4.6 CONFIRMED — a saved-file failure can show you an empty message.**
`apps/desktop/src/store.ts` line 1163 sets `error: (err as Error).message` with no
fallback, so a browser exception with an empty message renders a "failed" banner
with no words next to it. Its sibling at line 1139 does have a fallback; this one
was missed.

**Good news worth recording**, so nobody "fixes" what is already right: the hub's
~70 hand-written refusals are plain English and often excellent
(*"that's too many files (max 4)"*, *"only the owner of this Cloud9 can invite
someone"*). The GitHub not-found sentence is a model of the form — I triggered it
live by connecting a repository that does not exist and got: *"GitHub has no
repository called no-such-owner-zzz9/no-such-repo-zzz9 that this computer's sign-in
can see. Check the name — and if it is private, …"*. No jargon, names the thing,
says what to do.

---

## 5. Seamlessness sweep — everything outside the chat screen

Tested: the icon rail, the crew, the casting room, the agent editor, Tasks,
Projects, the Log, Setup. Chat was deliberately left alone.

### 5.1 MAJOR · CONFIRMED — the agent editor throws away your writing without a word

The worst friction I found. Reproduced twice, on a brand-new agent and on an
existing one:

1. Crew → **Edit** on an agent (or **Write an agent**).
2. Type into the brief — I typed *"AUDIT EDIT: this sentence should not vanish
   without a word."*
3. Click any icon in the left rail.

The editor closes. **No warning, no question, no toast, and nothing saved.** Come
back and the words are gone. Probe output: `dialog: false, toast: null,
editorGone: true` … `EDIT SURVIVED? false`.

Pictures: `gap-audit-editor-typed.png` (typed) → `gap-audit-editor-lost.png` (gone).

The editor has a **Cancel** and a **Save** button, so the app clearly knows there is
such a thing as unsaved work — the rail simply does not ask. The class fix is one
owner for "this screen has unsaved words", checked by every navigation, not a guard
bolted onto the rail.

### 5.2 MINOR · CONFIRMED — Setup's side menu tells you the wrong place

Open Setup, click **Danger zone** (it scrolls down there and highlights it), then
scroll back to the top by hand. **Appearance** is filling the screen and **Danger
zone** is still the highlighted item. The highlight is set by clicking and never by
looking. Picture: `gap-audit-settings-nav-lies.png` — the caption is the picture:
the menu says one thing, the page shows another.

### 3 more, all CONFIRMED, all small

- **5.3 · No screen ever takes the cursor.** Open the agent editor and the
  keyboard focus is on nothing at all (`document.activeElement` is `BODY`) — you
  must reach for the mouse to type the name. Same after hiring from the casting
  room, same on entering the casting room. The one place that gets this right is
  the Ctrl-K quick chat, which lands you in its box immediately — so the app knows
  how; the other screens just don't. Evidence: `focus: BODY.` recorded on entering
  the editor (new agent and existing agent), after **Hire**, after **Save**, and on
  entering the casting room.
- **5.4 · A casting-room card looks like a button and is not one.** The card has a
  drawn portrait, a job title, a tagline and a list of things to ask for — and
  clicking any of it does nothing. Only the small **Read the brief** button works.
  Measured: `cursor: default` on the card, and clicking the title area opened
  nothing.
- **5.5 · Screens swap with no transition at all.** `.stage` has
  `transition-duration: 0s`, so every rail click is an instant hard cut, while the
  rail buttons themselves fade over 0.15s. Every other overlay in the app is
  animated; the main screen change is the one thing that snaps.
- **5.6 · Setup forgets where you were.** Scroll Setup halfway down, go to Crew,
  come back: you are at the top again (measured: 400 → 0). Same shape of thing as
  5.2 — the screen keeps no place.

### Things I expected to find broken and did not — worth recording

- **Narrow widths hold up outside chat.** `HANDOFF.md` §7 says nobody has tested
  these because the last attempt's tool lied about resizing. I resized properly and
  checked for content pushed off the right edge at **1024, 900 and 760** pixels
  across Crew, Tasks, Projects, Log and Setup: **nothing overflows, and the page
  never scrolls sideways, at any of them.** Pictures at 900:
  `gap-audit-narrow-900-crew.png`, `gap-audit-narrow-900-settings.png`. This does
  **not** cover the chat screen, which another agent owns.
- **Loading states are there where they matter.** Projects says *"Looking…"* while
  it asks the hub, and *"Looking at GitHub now…"* while the engine is out at
  GitHub, and it correctly stops saying it. Browse-rooms says *"Looking for rooms
  you can join…"*. The empty states are written, not blank — Tasks, Log, Crew and
  Projects each say what would fill them.
- **Refused forms behave properly.** A mistyped repository name keeps what you
  typed and says why, right under the box (*"that isn't a repository name — use
  owner/name, like vikas53953/cloud9"*). A refusal that only the hub can judge
  also keeps the form open — I checked this specifically because the code looked
  like it would close the form too early, and it does not.
- **Connecting the same repository twice** simply selects the one you have, which
  is right.
- **Zero JavaScript errors** in the browser console across every screen, every
  width, and every one of the six passes.

---

## 6. What I could not settle — SUSPECTED

- **The installed Windows app.** Everything above was tested against the dev screen
  in a browser. The desktop app carries its own hub and engine.
  **To confirm:** run `npm run qa:app`, then repeat §5.1 by hand — type into an
  agent's brief and click a rail icon.
- **Desktop pop-ups.** A headless browser reports notifications as blocked, so I
  could not see a real one arrive.
  **To confirm:** in the installed app, turn on *Tell me about new messages*, then
  have an agent post while another screen is in front.
- **Whether a repository turn's briefing is missing in a live run.** I proved the
  mechanism (the `trigger` that carries it never enters the prompt) and I proved it
  end-to-end for chat, job and schedule turns. I did not run a real `!code` turn,
  because that needs a live checkout and real agent time.
  **To confirm:** `@Agent !code <something small>` in the real app and see whether
  it knows which branch it is on.

---

## 7. If you fix five things, fix these

1. **Give a turn its instruction.** A scheduled agent is being woken up and told
   nothing. §2.2, one function.
2. **Stop the agent editor eating your writing.** §5.1.
3. **Stop telling agents they can do things the app does not supply** — the
   connected-services and files-anywhere sentences. §3, Integrations.
4. **Open one doorway from an agent back into Cloud9** — search first, because it
   is already built, indexed and answerable by the hub today. That single tool also
   fixes "no memory": an agent that can search the conversation stops needing to be
   told the same thing four times.
5. **Give the hub's raw `String(err)` one plain-English owner.** §4.1 — it is the
   one leak that is not limited to sentences a person wrote.
