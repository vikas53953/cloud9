# ☁️ Cloud9 — Parking Lot                       updated 2026-07-28

Everything pending, in one place. Nothing here is forgotten; nothing here is
being built until it leaves the lot.

## A. Decisions waiting on Vikas (from the morning review)
| # | Decision | Options / recommendation |
|---|---|---|
| A1 | **Design direction pick** (Gate 2 still open) | Built on A (Slack Classic). Keep A / reskin to B Mission Control / C Zen Sky / mix. Rec: keep A, add B's agent-cards as a "Crew" tab later. |
| A2 | **Auth stance** | API-key-only (safest) vs also keep the `claude setup-token` option (policy gray zone, disclosed in-app). Rec: keep both, disclosure stays. |
| A3 | **Push to GitHub** | BLOCKED in-session: this cloud session has no configured source repo, so its GitHub token can't create/reach one. Unblock (2 min): create an empty repo `cloud9` at github.com/new, then either (a) open a new claude.ai/code session on that repo and say "pull in the bundle", or (b) locally: `git clone cloud9.bundle cloud9 && cd cloud9 && git remote add origin <url> && git push -u origin master`. |
| A4 | **Apple developer account** ($99/yr) | Unlocks TestFlight + real APNs push. Only you can enroll. |

## B. Deferred work items (not blocked on decisions, just not done yet)
| # | Item | Why deferred |
|---|---|---|
| B1 | Live-credential agent run (real Claude, not demo mode) | Needs your API key or setup-token in ⚙ Settings; 5-minute verification once provided. |
| B2 | Global OS-level ⌘K hotkey verification | Needs a real desktop (your Mac); code is written and Electron boots. |
| B3 | iPhone app run via Expo Go | Needs your Mac + iPhone; code is written. |
| B4 | Real APNs push delivery | Blocked on A4. |
| B5 | ~~Agent edit UI~~ **BUILT 2026-07-28** (✎ on agent row) | — |
| B6 | ~~Agent enable/pause/disable~~ **BUILT 2026-07-28** (edit modal status) | — |
| B7 | Engine lift to always-on server (agents work while desktop is off) | Designed-for; build when wanted. Small monthly cost. |
| B8 | Android app | You chose iPhone-first. |

## C. Spec adoption — v2 build queue (approved direction, sequenced)
Per docs/plans/spec.md; see docs/plans/traceability.md for current coverage.
| # | Item | Spec refs |
|---|---|---|
| C1 | ~~Task entity + state machine~~ **BUILT 2026-07-28** (tests + browser QA green) | FR-TS-002..005, §20 |
| C2 | ~~Approvals~~ **BUILT 2026-07-28** (owner-only decisions; reject blocks execution) | FR-AP-001..005, FR-TL-004 |
| C3 | ~~Activity/audit records~~ **BUILT 2026-07-28** (Activity viewer + attribution) | FR-AU-001..004 |
| C4 | **Codex provider adapter** (second provider behind the existing interface) | FR-PC-003, §17 |
| C5 | Workspaces/roles/governance | §9.2, FR-UW-004..006, §22.6 |

## D. Spec TBDs that need YOUR words before the affected item is built
(The spec forbids guessing these — spec.md rules 4–6.)

### Provisional resolutions made during the autonomous v2 build (reversible — say the word):
- D3 (task states): adopted the spec §20 candidate list verbatim
  (not_started, working, waiting_user, waiting_approval, blocked, completed, failed, cancelled).
- D4 (approvals): categories = background work + schedule creation, configured
  per agent at creation; only the agent's OWNER may approve/reject (their
  credential pays). Both easily changed.
| # | TBD | Blocks |
|---|---|---|
| D1 | Exact wording of the 4 confirmed outcomes (spec §6) + 4 target users (§7) — from your original intake in the other tool | Acceptance criteria for v2 |
| D2 | What "connect Codex subscription" means to you (OpenAI account? Codex CLI? API key?) — provider rules must then be verified officially, like we did for Claude | C4 |
| D3 | Task state names + workflow (spec §20 lists candidates) | C1 |
| D4 | Which actions require approval (categories/risk levels, §9.8) | C2 |
| D5 | Audit retention/depth/export (§8.8, FR-AU-005) | C3 |
| D6 | First-release scope for v2 (spec §23: MVP, first target user, pricing…) | C-queue ordering |

House rule going forward: anything new that isn't being built immediately gets
a line here instead of getting lost.
