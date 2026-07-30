# Insider audit — ROUND 2 (2026-07-30)

Law: *test what an insider can do, not only an outsider.*
Hub frames were swept from `apps/relay/src/server.ts` (read-only).
`server.ts` was **not** edited — it is forbidden to Cursor this round.

## FINDINGS

### F1 — Every refusal is prefixed with `Error:`

- **Frame:** any that throws (example: `history` with a stranger's channel id)
- **Sender:** any authenticated client
- **What leaked:** the wire answer is `"Error: no such channel"` rather than
  `"no such channel"`. Proven 2026-07-30 with a live probe:
  `{"type":"error","error":"Error: no such channel"}`.
- **Cause:** `onConnection` does `send(ws, { type: "error", error: String(err) })`,
  and `String(new Error("…"))` always adds the `Error:` prefix.
- **Why this round cannot fix it:** the one-line change lives in forbidden
  `apps/relay/src/server.ts`. Tests that assert the refusal *law* (no `Error:`
  prefix) are marked `.todo` with this finding id.
- **Suggested fix (words only):** send `err instanceof Error ? err.message : String(err)`
  — one owner for the sentence a person reads, never `String(err)`.

### F2 — (none further found this round that leak data)

Access-control gates checked in `apps/relay/src/insider-sweep.test.ts` refused
the insider cases below with the right *words* (modulo F1's prefix). No extra
room content, attachment bytes, run records, or approvals were observed to
cross a boundary in this sweep.

## Coverage map (what the sweep asked)

| Area | Frames | Insider cases |
|------|--------|----------------|
| Channel admin | setChannelInfo, setChannelVisibility, archiveChannel, addMembers, removeMember, setMemberRole | plain member; non-member |
| Messages | editMessage, deleteMessage | edit/delete someone else's |
| Reactions | react | in a room you are not in |
| Scrollback / search | history, search, markRead | across room boundaries |
| Attachments | attachmentTicket, uploadAttachment | other room's file / upload into stranger room |
| Artifacts | artifacts, artifact, artifactTicket | across room boundaries |
| Runs | runDetail, runList | agent you do not own |
| Approvals | decideApproval | non-approver |
| Projects | updateProject, forgetProject, syncProject, projectItems | stranger's project |
| Skills / agents | updateAgent, deleteAgent | stranger's agent |

Existing coverage in `insider.test.ts` (private-room invite, DM third person,
agent-smuggle, admin gate list, membership-save side effects) is kept; this
round adds the rest.
