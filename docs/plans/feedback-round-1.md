# Feedback round 1 — Vikas, 2026-07-28 (after first real test)

His 15 points, the root causes, and the contract both builders work against.
Numbers below are HIS numbering.

## Root cause of the stuck sign-in (his 2, 3, 4)

`claude setup-token` is interactive-only — `--help` shows no non-interactive
flag. The engine host spawned it with piped stdio (no TTY), so after Vikas
authorised in the browser the CLI had no terminal to finish in and never
printed a token. The card sat on "waiting for you in the browser…" forever.

Verified on this machine: `claude auth status` → exit 0,
`{"loggedIn":true,"authMethod":"claude.ai","email":"vikas53953@gmail.com",
"subscriptionType":"max"}`. The CLI is ALREADY signed in.

**Decision (Vikas's standing directive, stated twice: "use claude harness and
codex harness"; he is the machine owner, his own subscription, an app he runs
himself — the Buzz model):** Cloud9 uses the LOCAL CLI's own login as the
primary path for BOTH harnesses. It spawns the CLI; the CLI owns the
credential. Cloud9 never captures, stores, or sees a Claude token in this path.
`setup-token` is demoted to an explicit "advanced" fallback and, when used,
MUST run in a VISIBLE terminal window (never hidden). API key remains a
fallback. The in-app policy disclosure (FR-PC-004) stays visible and truthful.

## Contract — both builders build to this

### Protocol (`packages/shared`)
```ts
type HarnessAuthKind = "cli-login" | "token" | "apiKey" | "none";

interface HarnessInfo {
  name: HarnessName;
  installed: boolean;
  signedIn: boolean;
  account?: string;      // "vikas53953@gmail.com" / "ChatGPT account"
  authKind: HarnessAuthKind;
  version?: string;      // "2.1.220"
  models: string[];      // selectable model ids for this harness, may be []
  defaultModel?: string;
  detail: string;        // one plain sentence, user-facing
  signingIn?: boolean;
  problem?: string;      // last failure, plain words
}
```
- `AgentDef.model` already exists; it is now USER-VISIBLE and must always be
  set (fall back to the harness default at create time).
- New client frame `refreshHarness` (replaces implicit refresh-on-open).
- `harnessSignIn` stays but only means "run the fallback flow in a visible
  terminal"; it must never leave the card stuck — always resolves or fails
  with `problem` set inside 5 minutes.

### Model lists
- Codex: `codex debug models` (JSON) — real list, e.g. gpt-5.6-sol, gpt-5.6-terra,
  gpt-5.6-luna, gpt-5.5, gpt-5.4, gpt-5.4-mini. Default = the user's configured
  default from `~/.codex/config.toml` if readable, else first entry.
- Claude: the SDK/CLI model ids Cloud9 supports —
  `claude-opus-4-5` style ids are NOT to be guessed. Use the documented set:
  "Fable 5" (claude-fable-5), "Opus 5" (claude-opus-5), "Sonnet 5"
  (claude-sonnet-5), "Haiku 4.5" (claude-haiku-4-5-20251001). Show friendly
  names, store ids. Default = Sonnet 5 (fast + cheap for chat).
- Model lists are refreshed with harness detection, cached in HarnessInfo.

## Work split (files, to avoid collisions)

**Builder A — engine / protocol / Electron main. MUST NOT touch
`apps/desktop/src/App.tsx` or `styles.css`.**
Files: `packages/shared/src/*`, `packages/engine/src/*`, `apps/relay/src/*`,
`apps/desktop/electron/*`, `scripts/*`.
1. (his 2,3,4,11) CLI-login-first auth. Detection reports `authKind`,
   `account`, `version`, `models`. A signed-in CLI ⇒ `signedIn: true,
   authKind: "cli-login"` and agents RUN, with no token anywhere.
2. Engine: when `authKind === "cli-login"`, spawn the harness with NO
   credential env vars (the CLI uses its own login). When a token/API key
   exists, keep today's behaviour. Per-harness, never crossed.
3. Fallback `setup-token` runs in a VISIBLE terminal (Windows: `start` a real
   console). Poll `claude auth status` for completion, like the Codex flow.
   Hard 5-minute cap, then `problem` set — never an endless "waiting".
4. (his 5,6) Serve real model lists per harness; validate `AgentDef.model`
   against the harness list at the relay (reject unknown ids — keeps the
   injection guard).
5. (his 15) Fix duplicate people: invite redemption must not create a new user
   for a name that already redeemed; add `removeUser` (owner only) and make
   sure a DM channel between two ids is found-or-created, never duplicated.
   QA must run against a FRESH database each run (class fix for the junk).
6. (his 14) Electron app menu: File / Edit / View / Help with real items
   (New agent, New channel, Settings, Reload, Zoom, Toggle theme, Quit, About).
   Menu actions reach the renderer over existing IPC as `menu:<action>` events.
7. (his 9) Skills groundwork ONLY: `AgentSkill { id, name, description,
   instructions, files? }` on AgentDef (`skills?: AgentSkill[]`), stored and
   synced like the rest; engine injects skill instructions into the agent
   prompt and exposes skill files in the agent's data dir. No UI.

**Builder B — renderer only. MUST NOT touch anything outside
`apps/desktop/src/` (App.tsx, styles.css, store.ts, main.tsx).**
1. (his 1,11) Button label derives from state — never the word "again":
   signed in ⇒ green tick + "Signed in as <account>" + quiet "Switch account".
   Not signed in ⇒ "Sign in with Claude" / "Sign in with Codex".
   Working ⇒ spinner + "Waiting for you in the browser" + a Cancel that works.
   Failed ⇒ red line with `problem` and a Try again button.
2. (his 5,6) Model picker in agent create AND edit, grouped under the chosen
   app; agent rows and the details rail show which app + model each agent runs
   on. Never show an agent without a model.
3. (his 13) Settings gets real, changeable things: appearance (light/dark/
   system), which app+model new agents default to, quiet hours, notifications
   on/off, where agent files live (open folder), and a Danger zone
   (remove saved key, remove a person).
4. (his 15) Clicking any person or agent opens the direct conversation with
   them (found-or-created). The people list must show each person once.
5. (his 12,14) Design: it must read as a real Slack-class app, not a mock.
   Keep the Workbench palette/typography (his pick) but raise the finish:
   proper hover/active/focus states everywhere, real empty states, avatars
   with presence, section headers that collapse, unread markers, a top bar
   that matches an app with a menu bar, denser message rhythm, and a genuine
   composer (formatting row, attach, emoji, @-autocomplete visuals).
   Every interactive element must LOOK interactive.
6. (his 9) Skills UI inside the agent modals: an Abilities → Skills section
   where a skill can be written in plain words (name + what it does +
   instructions), saved to the agent, edited, deleted, and uploaded from a
   file (`.md` or `.txt` → name from filename, body as instructions).
   Multiple skills per agent. Uses Builder A's `skills` field only.

## Verification bar (both)
`npm run build` clean, `npm test` green (extend, never weaken), browser QA
green with new checks for every numbered item above, screenshots refreshed.
No commits — the conductor commits after re-running the evidence.
