# Spec → Code Traceability                 per spec.md §26.4 · 2026-07-28

Maps `docs/plans/spec.md` requirement IDs to Cloud9 code and tests.
Status: DONE (implemented + tested) · PARTIAL · NOT BUILT · BLOCKED-TBD
(needs a spec `TBD` resolved by Vikas before building — see PARKING-LOT.md).

## 10.1 User & Workspace
| ID | Status | Where |
|---|---|---|
| FR-UW-001 auth account | PARTIAL | Token auth: `apps/relay/src/store.ts` (tokens/invites), join screen `apps/desktop/src/App.tsx`. No password/OAuth identity yet. |
| FR-UW-002 access a workspace | PARTIAL | One implicit workspace per relay instance. |
| FR-UW-003 workspace holds humans + agents | DONE | `apps/relay/src/server.ts` (users, agents, channels); integration tests. |
| FR-UW-004/005/006 | BLOCKED-TBD | Membership/roles/org-vs-personal are spec TBDs. |

## 10.2 Provider Connections
| ID | Status | Where |
|---|---|---|
| FR-PC-001 provider-connectable architecture | DONE | `packages/engine/src/provider.ts` — `ClaudeProvider` interface; Mock + SDK implementations behind it (the spec's adapter seam). |
| FR-PC-002 Claude intended provider | DONE | `SdkProvider` (Claude Agent SDK). Live-credential run still unverified. |
| FR-PC-003 Codex intended provider | NOT BUILT | Adapter interface exists; no Codex implementation. Meaning of "connect Codex subscription" is a spec TBD. |
| FR-PC-004 no unverified subscription claims | DONE | Verified against official docs 2026-07-27; both options disclosed in-app (`SettingsModal`, `App.tsx`) + `implementation-notes.md`. |
| FR-PC-005 credentials not exposed to others | DONE | Credential stays on the owner's machine (localStorage/Electron settings → env for SDK subprocess); never sent to relay. |
| FR-PC-006 more providers later | DONE | Same interface. |
| FR-PC-007/008 ownership, metering | BLOCKED-TBD | |

## 10.3 Agent Creation & Management
| ID | Status | Where |
|---|---|---|
| FR-AG-001..004 create/identity/role/instructions | DONE | `AgentModal` in `App.tsx`; `createAgent` in `server.ts`; QA screenshot 02. |
| FR-AG-005 provider association | PARTIAL | All agents use the owner's single provider; per-agent provider choice not built. |
| FR-AG-006 explicit permission scope | PARTIAL | Ability toggles → `allowedTools` mapping (`provider.ts`); Bash always disallowed. Not a full policy model. |
| FR-AG-007 enable/pause/disable | DONE | `lifecycle` field; paused/disabled agents never reply, run tasks, or fire schedules (unit + browser tested); edit modal control. |
| FR-AG-008 edit after creation | DONE | ✎ AgentEditModal: persona, emoji, abilities, approvals, lifecycle, delete. |
| FR-AG-009..012 duplicate/templates/marketplace/versioning | NOT BUILT / TBD | |

## 10.4 Communication
| ID | Status | Where |
|---|---|---|
| FR-CM-001..005 messaging, shared convs, @addressing, agent identity | DONE | `server.ts`, `engine.ts`, `chatter.ts`; `extractMentions` in `packages/shared`; AGENT badge in UI; QA checks 5–7. |
| FR-CM-006 history retention | DONE | SQLite messages table + `history` frame; retention policy itself TBD. |
| FR-CM-007 agent→agent handoff | PARTIAL | Mention-driven agent-to-agent replies (`chatter.ts` + brake); no formal work handoff object. |
| FR-CM-008 working/waiting status | DONE | `agentStatus` frames; idle/working/braked dots. |
| FR-CM-009/010 threads, voice… | BLOCKED-TBD | |

## 10.5 Task Delegation  ← built 2026-07-28
| ID | Status | Where |
|---|---|---|
| FR-TS-001 request an outcome | DONE | `!bg`/`!task` in chat → Task record (`engine.ts`), Tasks panel in UI. |
| FR-TS-002..004 traceable task, status, result | DONE | `Task` entity + §20 states (`packages/shared`), relay `createTask/updateTask` handlers + SQLite `tasks` table; integration test "v2: task lifecycle". |
| FR-TS-005 cancel where possible | DONE | `cancelTask` frame + UI Cancel; engine discards results of cancelled tasks. |
| FR-TS-006 tools within scope | DONE | `allowedTools` enforced per agent turn. |
| FR-TS-009/010 scheduling model | PARTIAL | Chat-created schedules + background tasks exist (`scheduler.ts`, `!bg`); formal model TBD. |

## 10.6 Agent-to-Agent · 10.7 Tools · 10.8 Memory
| Area | Status | Notes |
|---|---|---|
| FR-AA-001..004 delegation traceability | PARTIAL | Conversation-level only; no delegation records. |
| FR-TL-001..003 tool access, explicit grant, attribution | PARTIAL | Grants per agent (abilities); attribution at message level, not tool-call level. |
| FR-TL-004 approval before configured actions | DONE | Per-agent approval config (background work, schedules) gates execution through the approval flow. |
| FR-ME-001..003 authorised context | PARTIAL | Channel context windows + per-agent files dir (`engine.ts renderContext`, `agentDataDir`). |

## 10.9 Approvals · 10.12 Audit  ← v2 gaps
| ID | Status |
|---|---|
| FR-AP-001..004 approvals | DONE — `Approval` entity, owner-only decision (provisional D4), rejected work never executes (tested), Approve/Reject in Tasks panel |
| FR-AP-005 decisions in history | DONE — `approval_decided` activity records with decider attribution |
| FR-AU-001..004 attributable activity records | DONE — relay `activity` table logs agent messages, task transitions, approvals, agent/channel/invite events; Activity viewer in UI; tested |

## 10.10 Clients · 10.11 Notifications
| ID | Status | Where |
|---|---|---|
| FR-CL-001 web GUI | DONE | Vite renderer runs standalone in a browser (all QA ran this way). |
| FR-CL-002 desktop app | DONE | Electron shell, smoke-tested. |
| FR-CL-003/004 cross-client continuity | DONE | Relay sync; QA check 12. |
| FR-CL-005 monitor status cross-client | DONE | `agentStatus` broadcast to all clients. |
| FR-CL-006 native mobile | PARTIAL | Expo scaffold (`apps/mobile`) — untested on device; spec marks native mobile TBD anyway. |
| FR-NT-001/002 notifications | PARTIAL | Proactive `push` frames + pushlog; APNs pending Apple account. |

## Acceptance criteria (spec §24) scorecard: 14 of 16 satisfied (2026-07-28 v2 build)
Newly met: #10 traceable tasks · #12 approvals · #13 attribution/audit.
Unmet: #15 Codex adapter proof (blocked on TBD D2) · #2 arguably met (web GUI)
pending Vikas's confirmation.
