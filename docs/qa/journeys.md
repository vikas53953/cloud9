# Phase 0 — Core user journeys (vibe-qa)

Written from `docs/plans/spec.md` and Vikas's own words, deliberately NOT from
the code. These are the acceptance tests everything downstream is measured
against. Each names the spec requirement it covers.

Run against the **packaged app** (`%LOCALAPPDATA%\Programs\Cloud9\Cloud9.exe`)
wherever possible — that is what Vikas will actually use. Where a journey can
only be driven in the dev stack (browser automation), say so in the finding.

| # | Journey | Spec |
|---|---|---|
| J1 | **First run.** Open Cloud9 for the first time. It tells me what it is and what it needs. Nothing is broken or blank, and I am not asked for an API key. | §11.1, FR-UW-001 |
| J2 | **Connect my AI apps.** Settings shows Claude and Codex. Both are found on my computer and show, in plain words, that I am signed in — with a tick, not jargon. If one is not signed in, it says so and offers one obvious way to fix it. | FR-PC-001/002/003/004, Vikas feedback 1,2,3,4,11 |
| J3 | **Hire an agent.** Create an agent: name it, say in plain words what it does, choose which app (Claude or Codex) AND which model it runs on, switch on abilities, and decide what needs my permission. It appears in my crew with its app and model visible. | FR-AG-001..006, feedback 5,6 |
| J4 | **Give it a skill.** Add a skill in plain words to an agent, then a second one, edit one, delete one, and upload one from a file. All survive closing and reopening the agent. | Vikas feedback 9 |
| J5 | **Talk to an agent and get a real answer.** Message an agent directly and get a genuine reply from the real Claude or Codex on my machine — not a canned demo line. | FR-CM-001/002, §24.6/7 |
| J6 | **Agents and people in one room.** Create a channel, put a person and an agent in it, @mention the agent, and see its reply clearly marked as an agent. | FR-CM-003/004/005, §24.8 |
| J7 | **Hand over a job.** Delegate background work to an agent. I can see the job exists, what state it is in, and its result when it finishes. I can cancel it. | FR-TS-001..005, §24.9/10 |
| J8 | **Approve or refuse.** When an agent needs my permission, I am told plainly what it wants to do, and Reject actually stops it. | FR-AP-001..004, §24.12 |
| J9 | **See who did what.** Open the activity trail and see human and agent actions attributed correctly. | FR-AU-001..004, §24.13 |
| J10 | **Invite a friend.** Generate an invite, have someone join with it, exchange messages, and see them listed exactly once. A spent invite cannot be reused, and a guest cannot become me. | FR-UW-004, feedback 15, security P0 #1 |
| J11 | **Reach anyone from anywhere in the app.** Press Ctrl+K from any screen and send a message without losing my place. | Vikas's original ask ("communicate across the app anywhere") |
| J12 | **Click a person or agent.** Clicking any name opens the conversation with them. It is never a dead click, and nobody is listed twice. | Vikas feedback 15 |
| J13 | **Change how it behaves.** Settings changes something real: switch light/dark, set the default app+model for new agents, set quiet hours, open the agent files folder. Choices survive a restart. | Vikas feedback 13 |
| J14 | **Use the menus.** File / Edit / View / Help do what they say. Nothing is a dead click. | Vikas feedback 14 |
| J15 | **It is a real app.** It has its own name and icon in the window, taskbar and Start menu; it starts without a terminal; closing it leaves nothing running. | Vikas feedback (Electron icon) |
| J16 | **It survives being closed.** Reopen and my channels, agents, skills, jobs and history are all still there. | FR-CM-006, FR-CL-003 |

## What "pass" means here
A journey passes only when a **person could see it work** — visible text, a
state change, data that survives a restart. "The element exists" is not a pass.
Every failure is tagged CONFIRMED (reproduced, with evidence) or
AUTOMATION-SUSPECT (may be a robot-browser artifact — with the exact manual
re-check step for Vikas).

## Known not-tested going in (must appear in the final report)
- Real mobile/iPhone client (scaffold only, never run on a device).
- Anything requiring a second physical machine or a network beyond this PC.
- The visible-terminal Claude sign-in fallback (his CLI is already signed in, so
  it cannot be exercised without signing him out).
