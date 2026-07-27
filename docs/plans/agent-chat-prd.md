# PRD — Cloud9                v1 · draft for Gate 1 · 2026-07-27

## One-liner
A private Slack-like chat app (desktop + iPhone, synced) where every "coworker"
is a Claude agent you created: each has its own personality and abilities, some
work proactively in the background, and any of them is one hotkey away.

## Who it's for
Vikas + up to ~5 invited friends/testers. Not a public product in v1. Each
person connects their **own** Claude subscription, so usage bills to their own
plan, not Vikas's.

## V1 features

### Connect & access
- **Sign in with Claude**: connect a Claude Pro/Max subscription via OAuth so
  agents run against the user's own plan. Fallback if third-party subscription
  auth turns out to be restricted: paste an Anthropic API key (pay-per-use).
- **Device pairing**: the desktop app is home base; the iPhone app pairs to it
  through a small relay service, with proper tokens/TLS even at 3 users.

### Agents
- **Create/edit agents**: name, avatar, personality instructions ("you're my
  fitness coach…"), and per-agent ability toggles.
- **Abilities (v1 set)**: web search, open/read links, read & write files in a
  folder you designate, scheduled tasks/reminders, background tasks ("work on
  this and ping me when done").
- **Proactive workers**: agents can message you first — on a schedule ("daily
  9am summary") or when a background task finishes. Arrives as an iPhone push
  notification when you're away from the desktop.

### Chat everywhere
- **DMs**: a 1-on-1 thread with every agent.
- **Channels**: group rooms holding multiple agents AND multiple humans
  (Gate-1 pick) — invite friends to a channel, everyone sees the
  conversation, agents converse freely and can be steered with @mentions.
- **People**: invite a friend (link/code), member list per channel, DMs
  between humans ride the same sync.
- **Global hotkey popup (desktop)**: from anywhere — even outside the app —
  hit a hotkey, pick an agent, send. Slack Cmd+K feel.
- **Sync**: full history on desktop; recent history + live messages on iPhone.

## Non-goals (v1)
- Android app (later), public App Store listing, voice/video, agent
  marketplace/sharing, and the always-on cloud agent host (designed-for, not
  built — agents pause when the desktop app is closed).
- Note: humans-chatting-with-humans moved INTO scope at Gate 1 (shared
  channels pick).

## Gate-1 decisions (picked by Vikas, 2026-07-27)
1. **Workspaces → SHARED**: friends and agents can share channels — real
   human-to-human messaging is in scope for v1 (invites, member list,
   per-channel membership). This grows the build; accepted knowingly.
2. **Agent chatter → FREE**: agents may converse with each other freely in
   channels. Mechanical safety brake (logged, not a product change): a hard
   ceiling of 25 consecutive agent messages with no human message, plus a
   per-channel hourly cap — both configurable — so a loop can't silently
   drain a subscription overnight.
3. **Name**: being picked now (see PIPELINE).

## Costs (annual reality check)
- Apple Developer account: **$99/year** (required for TestFlight + push).
- Relay server: **$0–10/month** (small VPS or free tier).
- Claude usage: covered by each user's own subscription.

## Risks (from the Stage-1 blindspot pass)
1. Subscription OAuth for third-party apps must be verified at Stage 4;
   fallback is API keys.
2. iPhone can't host agents (iOS backgrounding) — phone is a remote surface;
   agents pause when the desktop is off.
3. Relay is a real (small) piece of infrastructure to keep alive.
4. Agent loops in channels can burn usage limits — mitigated by decision 2.

## Completeness target
V1 as scoped ≈ **8/10**: the whole core idea works end-to-end (agents,
channels, hotkey, proactive pings, iPhone sync), but agents sleep when the
desktop is off, Android is absent, and abilities are a starter set.
