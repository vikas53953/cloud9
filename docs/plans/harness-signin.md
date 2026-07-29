# Harness sign-in — architecture note            2026-07-28
> **SUPERSEDED IN PART, 2026-07-29.** The `setup-token` capture described below
> was built, proved to hang (it is interactive-only and was spawned without a
> terminal), and REPLACED. The shipped design is CLI-login-first: Cloud9 spawns
> the local Claude Code / Codex CLIs with every credential environment variable
> stripped, and never captures or stores a token. A teardown of Buzz's source
> (`docs/plans/buzz-teardown.md`) confirms Buzz does exactly the same — its
> "sign in with Claude" runs `claude auth login` and keeps the credential inside
> Claude Code. **We already match the behaviour Vikas asked us to copy.**
> `setup-token` survives only as an explicit advanced fallback, and only in a
> visible terminal. Read this file for the verified CLI facts; read
> `docs/plans/feedback-round-1.md` and `docs/plans/backend-decision.md` for the
> design that actually shipped.

Vikas's directive (resolves PARKING-LOT D2 + A2): connect Claude and Codex the
way Buzz does — a "Sign in with …" button that hands off to each provider's own
locally installed app. API keys become a fallback only. Verified against
official docs 2026-07-28 (two research passes; see below).

## Verified facts (do not re-derive)

Claude (CLI 2.1.220 installed at `%APPDATA%\npm\claude.ps1`):
- Third-party apps MUST NOT silently ride the CLI's own `/login` credentials —
  explicitly disallowed in Agent SDK docs. Do not use the silent fallback.
- The sanctioned subscription path: `claude setup-token` — opens the browser,
  the user authorizes on Anthropic's page, a 1-year `sk-user-…` token prints to
  stdout for the app to capture. Runs on Pro/Max. This IS the Buzz-style flow.
- Detection: `claude --version` (installed), `claude auth status` (JSON with
  login/email; exit 0 = logged in; v2.1.210+).
- Token is used via env `CLAUDE_CODE_OAUTH_TOKEN` with the existing SdkProvider.
- Disclosure requirement (FR-PC-004) stays in the UI.

Codex (CLI 0.144.4 installed; user already logged in via ChatGPT account):
- Detection: `codex login status` → exit 0 "Logged in using ChatGPT" / exit 1
  "Not logged in". Machine-readable detail: `codex doctor --json` →
  `checks["auth.credentials"]`.
- Sign-in: spawn `codex login` (browser OAuth + local callback; can run as a
  detached hidden process — completion detected by polling `codex login status`).
  Fallback: `codex login --device-auth` (prints code/URL to surface in UI).
- Execution: `codex exec --json --color never --skip-git-repo-check
  -C <agentDataDir> -s read-only|-s workspace-write -m <model>
  -c approval_policy="never" --ephemeral` with the prompt on STDIN.
  Parse JSONL; final text = last `item.completed` with `item.type ===
  "agent_message"`. `thread_id` arrives in the first event (`thread.started`).
  No turn-limit flag exists → enforce a wall-clock timeout and kill.
  `--ephemeral` avoids unbounded session files (user already has 1.8 GB).
- Credentials live in `%USERPROFILE%\.codex\auth.json`; the app never reads,
  copies, or logs them — it only spawns the CLI.

## Decisions (mechanical, logged per pipeline law)

1. `AgentDef.provider?: "claude" | "codex"` (absent = "claude"). Per-agent
   provider choice in the create/edit modals. Fixes FR-AG-005 PARTIAL.
2. New `CodexProvider implements ClaudeProvider` in `packages/engine` — same
   seam as MockProvider/SdkProvider (FR-PC-003, spec §17).
3. Engine routes each turn by `agent.provider`. Missing/unauthed harness →
   agent replies with a plain-words "my engine isn't connected" message and
   the failure is logged (FR-TL-005).
4. Secrets class fix (standing law): the captured Claude token and any fallback
   API key are stored ONLY via Electron `safeStorage` (OS-encrypted, main
   process, on disk under userData as ciphertext). ALL `localStorage`
   credential code is removed. Renderer never sees a token after capture; it
   sees only status ("Connected as …"). Browser-only dev mode (no Electron):
   harness detection still works via the engine host; token capture is
   Electron-only, env var `CLOUD9_CRED` remains the dev escape hatch.
5. Sign-in orchestration lives in the ENGINE HOST process (it owns spawning
   CLIs); the desktop app asks for it over the existing local relay connection
   with owner-token auth — new frames: `harnessStatus` (query) and
   `harnessSignIn` (claude|codex). Status is broadcast so all clients see
   connection state. No credential material ever crosses the wire — only
   status booleans/emails.
6. Never log token values anywhere; log lengths/booleans only.

## Test strategy
- Unit: provider routing by agent.provider; CodexProvider JSONL parsing
  (fixture transcripts); harness status frame handling.
- Integration: engine-host with mock CLI shims (fake `claude`/`codex` scripts
  echoing canned JSON/JSONL) — sign-in flow state machine end to end.
- Browser QA: settings shows both harnesses with live status; agent create
  offers provider picker.
- Live verification on Vikas's machine: his real Codex login (already active)
  and a real `setup-token` run are the final TEST IT steps — cannot be
  click-tested by an agent alone.
