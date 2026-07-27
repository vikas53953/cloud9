# Cloud9 — Architecture (Stage 4)          implementation-ready · 2026-07-27 night

## Topology

Everything meets at a small **relay** (the always-on hub). All clients speak the
same WebSocket protocol to it:

```
 iPhone app (Expo RN) ──WS──┐
 Desktop renderer (React) ──WS──┤── relay (Node + SQLite)
 Engine host (agents)  ──WS──┘        · users / invites / channels / messages
                                      · fan-out to connected clients
                                      · push-notification dispatch (APNs later)
```

- **Engine host** runs inside the Electron main process in v1 (decision 5) but
  is a plain Node library + WS client with zero Electron imports — liftable to
  a server unchanged.
- Channels are shared (Gate-1): humans and agents mingle; the relay is the
  source of truth for membership and history.

## Packages (npm workspaces, TypeScript)

| Path | What |
|---|---|
| `packages/shared` | Message/event types, protocol constants, agent schema |
| `packages/engine` | Agent runtime: personas, abilities→tools mapping, Claude Agent SDK calls, scheduler (cron), background tasks, chatter brake, mock mode |
| `apps/relay` | WS + REST hub, SQLite (better-sqlite3), invite codes, auth tokens |
| `apps/desktop` | Electron shell: main = engine host + global ⌘K hotkey + popup window; renderer = React/Vite UI (Direction A) |
| `apps/mobile` | Expo React Native scaffold (run via Expo Go; TestFlight later) |

## Key mechanical decisions (decided silently, logged)

1. **Claude access**: `@anthropic-ai/claude-agent-sdk` `query()` per agent turn.
   Abilities map to `allowedTools`: web search→`WebSearch,WebFetch`, files→
   `Read,Write,Glob,Grep` (cwd = per-agent folder), schedules/background→engine
   features, not SDK tools. `permissionMode: "dontAsk"`, `maxTurns` capped.
2. **Auth**: per-user credential = API key or setup-token OAuth token; stored
   via Electron `safeStorage`; injected as env (`ANTHROPIC_API_KEY` /
   `CLAUDE_CODE_OAUTH_TOKEN`) into SDK calls. Policy note shown in settings.
3. **Mock mode** (`CLOUD9_MOCK=1`): deterministic persona-flavored responses so
   the full system runs and is testable without credentials. Same code path up
   to the SDK boundary.
4. **Chatter brake** (Gate-1 free-conversation pick): agents reply freely, but
   ≥25 consecutive agent messages in a channel with no human message → brake
   (agents pause until a human speaks); plus per-channel hourly cap (60 agent
   msgs). Both configurable in settings.
5. **Proactive**: cron schedules and finished background tasks post messages
   through the engine host → relay → clients; relay marks them `proactive` for
   push delivery. APNs is stubbed until the Apple account exists.
6. **Storage**: relay SQLite = users, devices, channels, membership, messages,
   invites. Engine SQLite = agents, schedules, tasks, per-agent session ids.
7. **Model**: engine default `claude-opus-5` per agent turn (Agent SDK default
   model override), configurable per agent later.
8. **QA strategy**: engine + relay unit tests (node:test, mock mode); renderer
   runs as a plain web app for Playwright QA in the preinstalled Chromium;
   Electron launch is smoke-tested separately.

## Risks accepted overnight
- iPhone app is a scaffold (Expo Go), not TestFlight — needs Apple account.
- APNs push stubbed for the same reason.
- Electron+Agent SDK subprocesses ~1 GiB/agent-turn — turns are serialized per
  agent; concurrent turns capped at 2 in v1.

## Build order (loop iterations)
1. shared + engine (mock + real) + tests
2. relay + tests
3. renderer UI (Direction A) + Electron shell + ⌘K popup
4. Expo scaffold
5. Playwright QA + evidence + morning review dashboard
