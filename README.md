# ☁️ Cloud9

Chat with your crew — friends and AI agents together. Create agents with
personalities and abilities (web search, files, schedules, background tasks),
put them in channels with your friends, reach any of them with a global ⌘K
hotkey, and get proactive pings on your phone.

## Layout

| Path | What |
|---|---|
| `packages/shared` | Protocol types shared by every client |
| `packages/engine` | Agent runtime (Claude Agent SDK; mock mode without credentials) |
| `apps/relay` | The small always-on hub (WS + SQLite) |
| `apps/desktop` | Electron app — UI + engine host + global hotkey |
| `apps/mobile` | Expo iPhone app (run via Expo Go until TestFlight) |
| `docs/` | PRD, architecture, mocks, gate reviews, QA evidence |

## Get the real app (what you want most of the time)

Double-click **`Build Cloud9 app.cmd`**. It takes a few minutes and produces an
installer at `release/Cloud9-Setup-0.1.0.exe`. Run that installer once.

After that Cloud9 is a normal Windows program:

- it has its own Cloud9 icon on the taskbar, desktop and Start menu — no more
  "Electron";
- it installs **just for you**, so Windows never asks for an administrator
  password;
- it needs **nothing else running** — no black command windows, no hub to
  start, no app-screen server. Click Cloud9 and it opens.

Everything the app needs is inside it: the app screen, the hub and your agents
all run inside the one Cloud9 program, and they all stop when you close the
window. The first time it runs it makes its own private key for the hub and
locks it away with Windows' own encryption, so the shared practice key from this
folder is never used by a real install.

To remove it: Start menu → right-click Cloud9 → Uninstall. Your conversations
and agents stay on disk (in `%APPDATA%\Cloud9`) unless you delete them yourself.

From a terminal the same thing is:

```bash
npm run dist    # installer  -> release/Cloud9-Setup-<version>.exe
npm run pack    # no installer, just release/win-unpacked/Cloud9.exe (faster)
```

## Run it (dev / workbench mode)

Double-click **`Start Cloud9.cmd`** — this is the mode for *changing* Cloud9.
The app screen reloads as you edit files, and it keeps three background parts
running, so leave that window open. Nothing here changed. Or by hand:

```bash
npm install && npm run build
node apps/relay/dist/server.js &            # the hub (port 8787)
node scripts/engine-host.mjs &              # agents (demo mode without creds)
cd apps/desktop && npx vite dev             # UI at http://localhost:5173
```

Open http://localhost:5173, pick "I run this Cloud9" (token `dev-owner-token`).
For live Claude agents: settings (⚙) → paste your Anthropic API key, or run
`CLOUD9_CRED=sk-ant-… node scripts/engine-host.mjs`.

Desktop shell: `cd apps/desktop && npx electron .` (set `CLOUD9_DEV_URL=http://localhost:5173` for dev).
iPhone: `cd apps/mobile && npm install && npx expo start`, scan with Expo Go.

## Node version — check this first

Cloud9 needs **Node 22.12 or newer**. It is developed and verified on **Node
24**, which is what `.nvmrc` pins. Node 20 is not enough: the hub uses Node's
own built-in database (`node:sqlite`), which does not exist before Node 22, and
Electron 43 and Vite 8 both ask for 22.12 or newer.

```bash
node -v      # must print v22.12.0 or higher
nvm use      # picks up .nvmrc if you use nvm / fnm
```

`npm install` now **stops with an error** on an unsupported Node instead of
printing a warning and carrying on (`engine-strict=true` in `.npmrc`). That is
deliberate: on Node 20 everything installs, then every hub test fails with a
confusing "unknown builtin module" message that looks like broken code rather
than a wrong runtime.

## Tests & QA

```bash
npm test                # all four parts: shared, engine, relay, desktop
npm run qa              # Playwright browser QA (screenshots → docs/qa/)
npm run qa:app          # drives the real installed Windows app (local only)
```

`npm test` stops at the first part that fails, so to see the whole picture run
them one at a time:

```bash
npm test -w @cloud9/shared
npm test -w @cloud9/engine
npm test -w @cloud9/relay
npm test -w @cloud9/desktop
```

Windows note: the test scripts pass a **quoted** recursive glob
(`node --test "dist/**/*.test.js"`), so Node expands it itself. Neither
PowerShell nor `cmd` expands an unquoted `dist/*.test.js`, and the old
non-recursive pattern also skipped test files sitting in sub-folders.

Every pull request runs build plus all four suites on Windows and Linux
(`.github/workflows/ci.yml`). `npm run qa:app` is not in CI — it needs a real
installed Windows app. `packages/engine` has known failures on Windows caused
by short (`NAME~1`) temp paths; see §7-D of
`HANDOFF-PR43-CONTINUATION-2026-08-12.md`.

## Claude credentials — important

Each user connects **their own** Claude access. Two options in Settings:
- **Anthropic API key** (platform.claude.com) — fully supported, pay-per-use.
- **`claude setup-token` OAuth token** — bills to a Claude Pro/Max
  subscription. Note: Anthropic's docs say third-party apps may not offer
  claude.ai subscription login without approval; generating your own token and
  pasting it into software you run yourself is your call. See
  `implementation-notes.md`.

Without a credential, agents run in demo mode (canned replies) so the whole
app is usable and testable for free.
