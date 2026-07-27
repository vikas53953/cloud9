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

## Run it (dev)

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

## Tests & QA

```bash
npm test               # engine + relay unit/integration tests
node scripts/qa.mjs    # Playwright browser QA (screenshots → docs/qa/)
```

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
