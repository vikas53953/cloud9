# Cloud9 — a plain-words guide for Vikas

Written **2026-07-31**. This guide tells you what Cloud9 does **today**, in plain
words. You are a network engineer, not a developer, so nothing here assumes
you write code. Where something is built underneath but you cannot see or use it
yet on the screen, it says so honestly — it does not pretend.

Everything here was read from the code and from `HANDOFF.md` / `RESUME.md`. No
feature is invented.

---

## 1. What Cloud9 is, in one paragraph

Cloud9 is a desktop chat app where you create **AI agents that work like hired
colleagues**. They sit in channels beside you and your friends, take jobs, do
real work, and **stop to ask you before they change anything that matters**.
Your words for it: instead of *find an app, learn it, operate it*, you
**describe the outcome and give it to an expert who does the work**.

The one thing that makes Cloud9 different from every other AI tool: **the
agents run on the Claude Code and Codex apps already installed on your PC,
using your own subscriptions.** Cloud9 spawns those programs. It never holds a
credential, never calls Anthropic or OpenAI itself, and never asks you for an
API key. That is the whole reason it exists for you.

---

## 2. Where everything runs

Everything is on your machine. Nothing is hosted.

| Part | Plain words | Lives in |
|---|---|---|
| The hub | The post office. Holds messages, agents, jobs. Every client talks to it. | `apps/relay` — WebSocket + SQLite, **this computer only** |
| The engine | Runs an agent's turn by spawning the Claude or Codex program. | `packages/engine` |
| The screen | What you look at. | `apps/desktop` — React inside Electron |
| Shared | The dictionary both sides speak. | `packages/shared` |

The **installed app is the product**. `Build Cloud9 app.cmd` builds the Windows
installer. It carries its own hub and engine and needs no dev server. Click
Cloud9 and it opens; close the window and everything stops.

Your real database lives at `%APPDATA%\cloud9\cloud9-relay.db`. That is where
your agents and conversations are. (There is also a *development* database
inside the repo folder — that one is for testing, not yours. Don't confuse
them.)

### How to install or update Cloud9 (the only supported way)

Double-click **`Install Cloud9.cmd`** in the main Cloud9 folder. From a
terminal it is:

```
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-cloud9.ps1
```

It closes Cloud9 if it is open, runs the installer, and then **checks that the
new version really landed**. It prints a heartbeat while it works, and if it
gets stuck it stops itself and tells you why in plain English. It never sits
there frozen and silent.

**Do not run `release\Cloud9-Setup-0.1.0.exe /S` by hand.** On its own the
installer gives no window, no progress and no error — if something blocks it,
it just looks dead.

**Why this machine is slow at installing.** It has *two* security products
switched on at once (Windows Defender and McAfee). Both inspect every program
as it starts. Measured on 2026-08-06: starting one tiny program took **336 ms
to 776 ms** instead of the normal ~20 ms, and starting Windows PowerShell took
**10 to 22 seconds**. An install that takes ~45 seconds here would take a few
seconds on a clean machine. That is your antivirus, not Cloud9.

If installs ever become unbearably slow, an administrator can exclude the two
Cloud9 folders (this is Vikas's call, not something a script should do):

```
Add-MpPreference -ExclusionPath 'C:\Users\vikasmit\cloud9\release'
Add-MpPreference -ExclusionPath 'C:\Users\vikasmit\AppData\Local\Programs\Cloud9'
```

and add the same two folders in McAfee → Settings → Real-Time Scanning →
Excluded Files.

---

## 3. The screen tour — the icon rail down the side

When you open Cloud9, five icons run down the side. In order:

- **Chat** — your conversations: rooms, threads, direct messages.
- **Crew** — your agents. Each one has a face, a name, and a pencil to edit it.
- **Tasks** — jobs you gave to agents, and approval cards waiting on you.
- **Projects** — GitHub repositories you connected, their pull requests and issues.
- **Log** — a record of what happened (the activity log).

Above the rail there is a global search / quick-chat hotkey (**Ctrl-K**) that
reaches any room or person from anywhere.

---

## 4. Agents — your hired colleagues

An **agent** is a person you create who works for you. Each one has:

- a **name** and a **face** (a generated portrait);
- a **personality** — what you wrote about how it should behave;
- an **app** it runs on — **Claude** or **Codex** — your choice, per agent;
- a **model** — for Claude, the list of 13 models Cloud9 found by actually
  asking your Claude app. The list prints its own honest note: *"the list
  Cloud9 last proved by running it, not checked just now."* Codex draws no
  such note, because no code writes one — inventing it would be a lie;
- **skills** — ready-made procedures (see §6);
- **abilities** — how far it is allowed to go (see §5, the reach ladder);
- **who may use it** — owner-only by default, or anyone in a room.

You can **create** an agent, **edit** it, and **pause** it. A paused agent does
not take turns.

Every agent names its **owner** wherever it appears — because admitting an
agent admits a person (you).

---

## 5. The reach ladder — how far an agent may go

This is the one control that matters most. You do **not** pick tools. You pick
**how far** you are letting the agent go, in four steps:

| Rung | Label | What it means |
|---|---|---|
| 1 | **Just talk** | Answers from what it knows. No tools at all. |
| 2 | **Look things up and keep notes** | Can check the web and keep files in its own folder. Nothing on your PC changes. |
| 3 | **Do real work for you** | Adds helper agents, repeating check-ins and background jobs. Still only its own folder. |
| 4 | **Everything this app can do on this computer** | The same reach Claude Code and Codex have on your PC. Anything that changes your machine or spends money **asks you first**. |

A rung is everything below it plus more — so a higher rung can never quietly
drop something a lower one had.

You can also **pick switches one by one** if you want a mix. There are eight
switches, from harmless to powerful:

1. **Look things up on the web**
2. **Keep and change files in its own folder**
3. **Get help from its own helper agents**
4. **Check in on a repeating schedule** — your choice whether it asks first
5. **Work on jobs in the background** — your choice whether it asks first
6. **Use connected services your owner picked for you** — **always asks first**
7. **Reach files outside its own folder** — **always asks first**
8. **Run programs on this computer** — **always asks first**

The last three **always ask first**, no matter what you set. A switch being on
*is* the ask being on — you cannot turn the ask off for those three.

When an agent holds anything dangerous, the screen shows a list: *"You'll be
asked before it: Run programs on this computer, …"* in your words.

**Honest limit:** with the Claude and Codex command-line programs, there is no
way to pause mid-turn and ask per tool call. What Cloud9 can put in front of
you is the **whole unattended job** — a background job or a repeating
check-in. An ordinary chat turn with a "run programs" agent still runs its
tools inside that turn.

---

## 6. Skills and the skill library

A **skill** is a written procedure an agent follows — like a runbook. You can
write your own, or pick one from the **skill library**.

The library has **15 ready-made skills on 5 shelves**, reachable from any
agent's own file. Each card says **when it helps**, shows the **whole
procedure**, and names **where it came from**. A library skill looks exactly
like one you typed yourself — same pencil to edit, same bin to delete, no
badge. The screen and the library are checked against each other, so they can
never drift apart.

**Honest limit:** per-role ordering in the library only works in the moment
right after you hire from the casting room. After you save the agent, Cloud9
forgets which role it came from, so the library falls back to natural order.
The fix is a small field on the agent; it is written down, not done yet.

---

## 7. The casting room (the marketplace)

The **casting room** is Cloud9's built-in marketplace. It has **8 built-in
software roles**, each with a real brief and a drawn portrait (the same kind
of portrait your agents get, so a role looks like a person):

- Architect
- Backend
- Frontend
- QA
- Security review
- DevOps / SRE
- Code reviewer
- Tech writer

**Hiring** copies one of these roles into your crew as an ordinary agent —
fully editable, with the same reach ladder, files switch, skills and approval
controls as a hand-made one. You pick which app (Claude or Codex) it runs on.

The marketplace is **built into the app** — no server, software roles first.
Categories can grow later.

---

## 8. Chat — talking with agents and friends

Chat works the way you expect from Slack or Teams, with agents in the same
channels as people:

- **Scrollback** — the history of a room is there when you open it.
- **Search** — full-text search across messages, including a `from:` filter.
- **Reactions** — emoji on a message.
- **Edit and delete** — your own messages; a deleted one leaves a small
  tombstone so the conversation still reads right.
- **Threads** — a reply can stay inline in the channel or open a thread. There
  is a **setting** that lets you choose which one is the default — your call.
- **Attachments** — files on a message, downloaded through a one-use,
  30-second ticket.
- **Mentions** — `@name` to talk to a person or an agent.
- **Markdown** — bold, italic, code, lists and links render properly. A
  script tag in a message shows up as the word "script" — it can never run.
  Only http/https/mailto links are allowed.
- **Unread** — account-level unread counts, so you know what you haven't read.

---

## 9. Rooms

A **room** is a channel. You can:

- **Browse** rooms, **join** and **leave** them.
- **Archive** a room you are done with.
- See **roles** — who is an owner, a member, a guest.
- An agent always names its owner wherever it appears.

Rooms can be open or private, have a topic and description, and keep a
membership list (who joined, when, and who invited them).

---

## 10. Presence — who is around

Each agent and person shows a real status:

- **Ready** — can take a turn.
- **Working** — busy on something right now.
- **Paused** — you paused it; it will not run.
- **Offline** — cannot run, with the reason shown.

Presence shows in the sidebar **and** in the conversation, the way Slack and
Buzz show it.

---

## 11. Jobs — giving work to an agent

A **job** is real work you delegate to an agent. You start one by typing in a
room:

- **`@Agent !bg <what to do>`** or **`@Agent !task <what to do>`** — gives the
  agent a tracked job. It works on it and reports back.

As the job happens:

- the agent's status changes (working then done);
- **emoji appear on the message** as work is picked up, in progress, and done,
  so you can see what is happening at a glance;
- when the job finishes, it is **highlighted** and a **short summary** appears
  (the agent writes the summary itself);
- a **record of what the agent did** is kept, so you can read what really
  happened.

A job that would change the machine or spend money **asks you first** (see
§13, the approval card).

---

## 12. Projects — GitHub inside Cloud9

**Projects** is the icon in the rail for GitHub work. Inside a project:

- **Connect a repository** by typing `owner/name` (for example
  `vikas53953/cloud9`). A mistyped name says so when you connect it — it
  really asks GitHub.
- See the repository's **trunk**, **when it was last looked at**, and the
  conversation it reports into.
- See its **pull requests** and **issues** in their own lists.
- See **which agent is on which branch**, with the agent's face on the branch.
- A pull request can be **traced to the very turn that made it** when a held
  run names the branch — and honestly **UNTRACED** when none does.
- **Rename** and **disconnect** a repository, with "your repository is not
  touched" said before it happens.
- **"Look at GitHub now"** — a button that really asks GitHub for fresh data,
  with a busy state the hub owns (so it always ends), a three-state
  last-looked-at chip, and any refusal printed beside the button.

This read path is **read-only by construction**: a four-command allowlist, and
the client is built with no approver so every writing method throws.

---

## 13. The approval card — your hand on the door

Whenever an agent wants to do something that leaves your computer or changes
something, you get an **approval card**. For a push it shows:

- **what will happen** (push, open a PR, etc.);
- **which repository and branch**;
- **how many commits and how many files**;
- a **countdown** — the card expires if nobody answers;
- **`expired` is its own state** — "nobody answered" is not the same as "you
  said no." The card stays put, so a request that ran out is **found** rather
  than vanished.

The card's facts are **counted by git/gh**, never quoted from the agent. So an
agent that calls two files "a one-line comment, straight onto main" still
produces a card reading **2 files / 1 commit / its own branch / base master**.

One owner counts "how many are waiting", so the rail badge, the gold pill and
the Tasks in-tray can never disagree.

---

## 14. GitHub commands you type in a room

These are **typed commands**, not buttons. You write them in a chat room,
addressed to an agent:

- **`@Agent !code <what to do>`** — the agent works in **its own git worktree**,
  commits to **its own branch**, and only if **it** decides to push does it
  ask — through the same approval card (§13). Everything up to the ask is
  local. An agent that changed nothing produces no card at all.
- **`!publish`** — the word the agent writes inside its `!code` turn when it
  wants to push and open a pull request.
- **`!issue <title>`** — ask to open a GitHub issue.
- **`!comment <pr#> <text>`** — ask to comment on a pull request (or issue).
- **`!review <pr#> <user> [user…]`** — ask to request reviewers on a pull
  request.

For `!issue`, `!comment` and `!review`: everything up to your "yes" is local,
and the only thing that leaves your computer is behind the **same approval
card** the push uses. The title and text ride on standard input — they never
touch the card and never touch the command line as arguments.

**Your decision, already made:** code goes to GitHub as **branch + pull
request, always.** Nothing lands on the default branch without you. Several
agents can work one repo at once without colliding because each gets its own
worktree.

**Honest limits:**

- `!code` is a typed command with **no button on screen** yet.
- **Nothing links a Cloud9 project to a folder on this computer yet.** The
  `!code` and `!issue` / `!comment` / `!review` commands need a project folder
  to be set (once, at launch). With no folder, the agent says so plainly rather
  than inventing one.
- The `!issue` / `!comment` / `!review` commands are wired in the engine and
  reachable by typing, behind the approval card. They were **not** part of the
  16/16 installed-app verification walk, so treat them as built, not yet proven
  on the double-clicked app.

---

## 15. Artifact cards — files an agent makes

An **artifact** is a file an agent produced and put **into the conversation**.
Before this, an agent could only paste a Windows path into chat — and a path
on your machine is not a file anyone else can open (not another agent, not you
on another machine, not a friend).

With the artifact store:

- the agent offers the file in the room;
- the file has a **name**, **who made it**, **which version**, and the agent's
  own one-line note about what changed;
- publishing the same name again is an **update** — version 1 is kept, so two
  agents editing the same file become one file with two authors in its
  history (that is the handoff this store exists to make possible);
- a file is opened through the **same one-use, 30-second ticket** a person's
  attachment uses, with permission checked twice;
- text files can be previewed inline; binary files are a download and nothing
  more.

**Honest limit — NOT on screen yet.** The shared shapes, the engine noticing a
file its turn made, and the hub storing and serving it are all **done and
tested underneath**. But **nobody has seen an artifact card** — the screen half
is not built. By Cloud9's own law (*a feature is done when you can see it and
use it*), this is plumbing, not a finished feature.

---

## 16. Connect to a friend

You want a friend on another computer to reach your Cloud9, and you to reach
theirs. The plan for that is a **private network** (Tailscale) — only devices
you have personally added can even see your hub. It is not the public internet.

What you would do, once, about twenty minutes:

1. Install Tailscale on your PC, sign in with Google.
2. Find your private address (four numbers starting with `100.`).
3. Tell Cloud9 to use it (Settings, the network box, paste the address,
   restart) — or add `"networkBind": "100.x.x.x"` to Cloud9's `settings.json`.
4. Restart Cloud9; the startup log says the address to give a friend.
5. Your friend installs Tailscale too, signs in, and you add them to your
   network from the Tailscale admin page.
6. Send them the invite code; on their join screen they use your address.

The hub **refuses** `0.0.0.0` and `*` (every network, including café wifi) with
a plain sentence. Opening the network does not open any other gate — an invite
is still single-use and owner-only, the harness sign-in is still owner-only,
and a guest still cannot drive your agents or read a room they are not in.

**Honest limit — NOT on screen yet.** The plumbing for a private-network bind
exists, and join-tokens are built and tested underneath. But **nothing on any
screen calls it**: the packaged app **always starts its own hub and always
talks to it**. There is no "join someone else's Cloud9" mode yet. Tailscale
itself is not installed. Your browser sign-in to Tailscale is the one step
nobody can do for you. Free Tailscale allows 6 people (you plus five).

---

## 17. What is NOT on screen yet — the honest list

These are built and tested underneath, but you cannot see or use them from
the double-clicked app today:

- **Artifact cards** (§15) — files an agent makes. Plumbing done, screen not
  built.
- **Connect to a friend / join a remote hub** (§16) — the packaged app always
  starts its own hub.
- **Agent memory and agent-to-agent handoff** — durable per-agent notes and a
  structured "AgentB, take this" object are built in the engine; nothing on
  screen surfaces them. Agents also remember nothing between conversations.
- **Notifications** — four kinds (job finished, approval asked, mention,
  artifact published) with quiet-hours math are built as pure rules; the
  desktop does not yet read them for pop-ups, and phone/APNs delivery is a
  stub.
- **A button for `!code`** and a **project-to-folder link** (§14) — typed only.
- **`wholeComputer` and `connections` switches** — wired in the engine but
  inert: no folder picker and no per-agent MCP file on screen. The screen says
  so rather than pretending.
- **Narrow window widths are untested.** The last attempt's resizing tool lied
  about resizing; it caught itself and reported it.
- **No web GUI**; the phone app is a scaffold that has never run.

---

## 18. Decisions you have already made — so you don't get asked again

| Decision | Your answer |
|---|---|
| Design | **Studio** — you judge only by seeing the whole thing. |
| Agent capability | **Everything Claude Code and Codex can do on your PC.** Keep your personal config shut out; raise the ceiling. |
| Code to GitHub | **Branch + pull request, always.** Nothing lands on the default branch without you. |
| Agents in parallel | **Git worktrees**, one per agent or task. |
| Marketplace | **Built into the app**, no server, software roles first. |
| Reach of the app | **Private network (Tailscale) first**; a public website is later, on your Vercel Pro. |
| Backend shape | Agents overnight on **your own PC**, your subscriptions pay. |
| Where the hub lives eventually | Hybrid — hub hosted, agents local. |

---

## 19. Plain-words glossary

- **Agent** — an AI colleague you created. Runs on your Claude or Codex app.
- **Hub** — the post office on your PC that holds all messages and agents.
- **Engine** — the part that spawns your Claude/Codex program to run a turn.
- **Room / channel** — a conversation. Can be open or private.
- **Thread** — a side-conversation off a message in a room.
- **Job / task** — real work you delegated to an agent (`!bg` / `!task`).
- **Reach ladder** — the four rungs of how far an agent may go.
- **Approval card** — the card that asks you before something leaves your PC.
- **Artifact** — a file an agent made and put into the conversation.
- **Worktree** — a separate working copy of a repo, so two agents don't collide.
- **Casting room** — the built-in marketplace of ready-made roles.
- **Skill** — a written procedure an agent follows, like a runbook.

---

*This guide describes Cloud9 as of the code on `master` at the time of
writing. Where it says "not on screen yet", that is the truth today — not a
promise that it is finished.*

