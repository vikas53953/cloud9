# Renderer checks the browser suite should own

**Written by:** the renderer round, 2026-07-29 · **For:** whoever owns `scripts/**`
**Why this file exists:** every finding in `phase3-7-audit.md` tagged B1, B3, M1,
M2, M3, M5, M6 lives in `apps/desktop/src` — code that **no test in this repo
executes**. 119 tests are green and all 119 are engine + relay. Each check below
was run by hand this session and passed; none of them is guarded by anything that
runs on its own. Until they are, the same breaks can come back silently.

Two of them are already guarded by the **typechecker** instead, and those need no
browser check — see "Guarded by the build" at the bottom.

---

## How to drive the app

Everything below is reachable from a normal signed-in owner page. Two things make
that easy and are already in the renderer on purpose:

| Hook | What it is |
|---|---|
| `window.cloud9Menu` | `{ actions, run }` — `actions` is the shared `MENU_ACTIONS` list, `run(action)` is the **same** function the Electron menu calls. Drive menu items through this; it is the real path, not a stand-in. |
| `?relay=ws://127.0.0.1:<port>` | Points the page at a throwaway hub, so a check never touches the real database. |

A guest is made by redeeming an invite in a second browser context — no second
machine is needed for any check here.

---

## The checks

### 1 · A refused join says why, on the join screen — B1

Not a toast. The toast is mounted at the app root now, but a person who never
got in is looking at `JoinScreen`, so the reason has to be printed there.

- **spent code** — owner mints an invite, guest A redeems it, guest B redeems the
  *same* code. Guest B's join screen must show `.joinerror` containing
  *"That invite has already been used — ask Vikas for a new one."*
- **wrong code** — redeem `inv_not_a_real_code`. Must show
  *"That invite code isn't valid. Check it for typos…"*
- **the class rule:** assert `.joinerror` is non-empty **whenever** the page is on
  the join screen and the socket received an `error` frame. A new refusal string
  the relay invents later must not vanish — `plainError()` falls through to the
  raw text, so the box still fills.
- **the regression that made this a blocker:** after the refusal the client must
  **not** reconnect on an empty token. Assert only ONE `hello` frame is sent per
  attempt; a second one answers `"bad token"` and overwrites the real reason.

### 2 · Removed is removed everywhere, with no reload — B3

Owner opens Settings → Danger zone → Remove a person. Then, **without reloading
either page**:

- the person is gone from the People rail, the details-rail People list, the
  `@`-autocomplete, and the "Remove a person" dropdown itself;
- the DM channel with them is gone from Direct Messages;
- **on the removed person's own page**: they land back on the join screen showing
  *"You were removed from this Cloud9. Ask Vikas for a new invite…"* — not an
  empty workspace, not a silent disconnect.

Check all five in one assertion block; the bug was that four of them were fine
and the People list was not.

### 3 · Every menu action does something — M5

```js
for (const a of window.cloud9Menu.actions) { /* snapshot, run(a), compare */ }
```

Nine actions today. Assert **each one** changes the page — an overlay opens, the
find bar appears, or `data-theme` flips. `invite`, `search`, `activity` and
`tasks` were the dead four, so name them explicitly as well as looping.

Also assert the loop covers `MENU_ACTIONS.length` items, so an action added to
the shared list without a check here fails the suite too.

**Guest half:** a guest running `invite` must produce a **toast**, not silence —
*"Only Vikas can invite people to this Cloud9."* The shell's menu is identical
for everyone, so this is a real path a guest can take.

### 4 · An unset model is never displayed as a set one — M2

Store an agent with **no** `model` (the relay accepts it — that is exactly what a
pre-round-2 database row looks like), then assert every display site says
`app's default`, never a model name:

- the crew rail line, the message run-strip, the details rail, the crew-screen chip.

Assert the tooltip is present too (`MODEL_UNSET_HINT`), since the rail truncates
the words at narrow widths.

**The rule being protected:** the engine only passes `--model` when the agent
stores one. Any display that names a model the run will not use is the bug.

### 5 · An uploaded skill file becomes a file, and an edit never eats it — M3

- Upload a `.md` into a skill → the skill row shows *"📎 1 file in the agent's
  folder"*, and the sent `createAgent` frame carries `skills[0].files[0].name`.
- **Then edit that skill** (change only its description) and save → the badge is
  still there, and the `updateAgent` frame still carries `files`. This is the
  data-loss half; it is the one worth a test forever.
- A file name `isSafeSkillFileName` rejects must be **refused with a sentence**,
  not silently renamed.

### 6 · Owner-only surfaces are not offered to guests — M6

For a guest page assert **absent**: the People section's `＋`, the "Invite a
friend" empty-state button, the Danger zone's "Remove a person" row, and the
Settings "Your AI apps" sign-in cards.

**And assert the guest's socket receives ZERO `error` frames during a normal
sign-in and a normal Settings visit.** That is the class rule — the renderer must
not *ask* for anything the relay will refuse. It caught a real regression this
session: a connect-time harness refresh fired for guests too and handed them
*"only the owner of this Cloud9 can connect the AI apps"* on arrival.

### 7 · The real model list arrives without opening Settings — M1

Sign in, go **straight** to Hire an agent. The hint under the model picker must
read *"N models offered by your Claude app."*, **not** *"This is the list Cloud9
ships with."* Assert `refreshHarness` is sent **exactly once** per connection —
it makes the engine re-run `claude auth status`, so once per screen is wrong.

### 8 · The Studio look did not move

Compare against `docs/qa/studio-*.png`. Cheap assertions that catch the usual drift:

- **no raw colour outside the token layer** — every `#rrggbb` in `styles.css` sits
  in `:root` / the two dark blocks, and `App.tsx` carries none at all (the plate
  pigments are `var(--plate-N-a|b|c)` now).
- all 19 plate tokens resolve to a non-empty value, and a rendered `.p-head` has a
  computed `fill` that is a real `rgb(...)` — an unresolved `var()` paints nothing
  and would leave blank portraits nobody notices in a diff.
- light **and** dark: flip `data-theme` and re-shoot.

---

## Guarded by the build, not by the browser

Do **not** write browser checks for these two — they are already impossible to
ship, and a browser check would be the weaker guard:

| Rule | How it is enforced | Proof |
|---|---|---|
| Every `ServerFrame` is handled | `const unhandled: never = frame` in `store.ts`'s `default:` | Deleting `case "harness"` fails `tsc`: *Type '{ type: "harness"; … }' is not assignable to type 'never'* |
| Every menu action has a handler | `Record<MenuAction, () => void>` against the shared `MENU_ACTIONS` | Deleting the `tasks` handler fails `tsc`: *Property 'tasks' is missing…* |

Both were run this session by deleting the case/handler, watching the typecheck
fail, and restoring. `npm run build` includes the renderer typecheck, so a
dead menu item or a dropped frame cannot reach a build.

---

## Not covered by anything, and still open

- **M4** — a friend's `!bg` job is attributed to the owner. Relay-side.
- **M7** — the hub is loopback-only and hardcoded, so a friend on another
  computer cannot connect at all. No renderer check can cover this.
- **M8** — `Ctrl+K` is registered system-wide by the Electron shell.
- **B2** — `CLOUD9_DEMO=1` in the dev launcher.
- **Escape does not close modals.** Only the quick-chat overlay listens for it;
  Settings, Tasks, Activity, Invite and the agent editors all need their own
  button. Not a break, but it surprised this session's own screenshots.
