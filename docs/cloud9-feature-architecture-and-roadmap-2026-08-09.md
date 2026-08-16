# Cloud9 feature architecture and software-engineering roadmap

**Purpose:** reorganize Cloud9 by meaning, remove navigation clutter, keep Settings permanently reachable, and define the feature set required for a go-to software-development workspace.

**Evidence used:** installed Cloud9 `0.1.0`, the runtime Cloud9/Buzz/Slack comparison dated 9 August 2026, and the current Cloud9 desktop screen inventory.

## Product position

Cloud9 should be a **conversation-first engineering operating system**:

- communication quality comparable to Slack;
- attention triage comparable to Buzz;
- native projects, code, delivery workflows, and engineering artifacts;
- agents that work as governed engineering teammates rather than detached chatbots.

The problem is not that Cloud9 has too many capabilities. The problem is that too many capabilities are presented as equal first-level destinations.

## Information-architecture options considered

### Option A — keep every feature in the rail

**Model:** Chat, Crew, Tasks, Workflows, Files, Projects, Decisions, Huddles, Pulse, Polls, Canvas, Hooks, Notifications, Saved, Settings.

**Advantage:** every feature is immediately visible.

**Risk:** the current laptop problem remains—important utilities fall below the viewport, every icon competes equally, and users must understand the entire product before they can navigate it.

**Decision:** reject.

### Option B — put everything inside Projects

**Model:** Projects is the primary destination; chat, tasks, agents, code, workflows, decisions, and releases live inside the selected project.

**Advantage:** excellent local context and reduced global clutter.

**Risk:** cross-project inboxes, direct messages, agents, approvals, failures, and portfolio work become hard to find.

**Decision:** retain project-local views inside Build, but reject this as the whole application shell.

### Option C — group by the user's job

**Model:** Inbox, Chat, Build, Agents, Insights; Settings is a pinned utility.

**Advantage:** five stable concepts cover the product without hiding its engineering identity. New features can be added inside a group instead of expanding the primary rail.

**Risk:** each group needs a well-designed secondary navigation layer and universal search.

**Decision:** recommended.

## Recommended primary navigation

```text
Global search / command palette

● Inbox       What needs my attention?
● Chat        Where are people and agents talking?
● Build       What software work is moving?
● Agents      Who or what can perform work?
● Insights    What has been learned, decided, or reported?

────────────── pinned utility area ──────────────
⚙ Settings    Always visible
● Profile     Account, presence, workspace switcher
```

The primary rail should never contain more than these five product destinations. Settings and Profile are persistent utilities, not feature destinations and not members of a scrollable list.

## Feature groups

### 1. Inbox — attention and follow-up

The Inbox answers: **What needs me now?**

Include:

- All activity
- Mentions
- Threads and replies
- Approvals waiting
- Agent updates
- Failed or blocked work
- Notifications
- Saved for later
- Scheduled messages and reminders
- Assigned-to-me work
- Unread filters, project/agent filters, search
- Bulk mark read, archive, save, assign, and snooze
- Detailed and dense layouts

Current features moved here:

- Notifications
- Activity
- Saved for later
- Approval and failure events currently scattered across tasks, runs, workflows, and chat

### 2. Chat — human and agent communication

Chat answers: **Where is the team collaborating?**

Include:

- Channels and project rooms
- Direct messages
- Threads in a side inspector
- Huddles / live presence
- Human and agent mentions
- Rich text, markdown, code, attachments, emoji
- Task, run, PR, issue, artifact, project, workflow, poll, and canvas links
- Schedule send
- “Also post to channel” for thread replies
- Delegate to agent
- Request approval
- Delivery, pending, failure, retry, and offline state
- Draft preservation across navigation and reconnect

Current features moved here:

- Chat
- Channels
- Direct agents / direct messages
- Huddles
- Room participant and agent presence

### 3. Build — software delivery workspace

Build answers: **What are we building and how is it progressing?**

Include:

- Projects and project overview
- Tasks, issues, milestones, and assignments
- Repositories, branches, commits, and pull requests
- Code browser, diff, review comments, and blame/history
- Files and engineering artifacts
- Integrated terminal and development environments
- Workflows and run history
- Canvas / architecture workspace
- Tests, CI checks, coverage, and quality gates
- Build artifacts and logs
- Preview environments and deployments
- Releases, changelogs, rollback, and environment promotion
- Dependency and package health
- Exact target navigation from every source link

Current features moved here:

- Tasks
- Projects
- Workflows
- Files
- Canvas
- Runs and artifacts

### 4. Agents — engineering workforce and automation

Agents answers: **Who can do the work, with what authority and cost?**

Include:

- Crew overview
- Agent profiles, roles, capabilities, presence, and assignments
- Agent builder/editor
- Skills, tools, plugins, and integration access
- Hooks and event rules
- Reusable automations
- Provider and model configuration
- Permissions and approval boundaries
- Working folders and project access
- Memory and context sources
- Run timeline and handoffs
- Parallel delegation and coordination
- Agent evaluation and quality history
- Budget, token, cost, and rate-limit controls
- Audit history for actions, tools, approvals, and failures

Current features moved here:

- Crew
- Agent editor
- Hooks
- Skills/marketplace
- Provider/model configuration
- Spending and usage controls

### 5. Insights — decisions, knowledge, and reporting

Insights answers: **What do we know, what was decided, and what should the wider team see?**

Include:

- Engineering Pulse
- Decision threads
- Polls
- Forums
- Public/internal project updates
- Architecture decision records
- Project health and delivery trends
- Team and agent activity summaries
- Test, quality, security, deployment, and incident trends
- Searchable decision and knowledge history
- Audit reports and exports

Current features moved here:

- Engineering Pulse
- Decision Threads
- Polls
- Forums
- Public Updates / Social feed

## Current-to-new mapping

| Current Cloud9 destination | New location |
|---|---|
| Chat | Chat |
| Crew | Agents → Crew |
| Tasks | Build → Tasks |
| Workflows | Build → Workflows |
| Files | Build → Files & artifacts |
| Projects | Build → Projects |
| Decision Threads | Insights → Decisions |
| Huddles | Chat → Huddles |
| Engineering Pulse | Insights → Pulse |
| Polls | Insights → Polls |
| Canvas | Build → Canvas |
| Notifications | Inbox → Notifications |
| Activity | Inbox → All activity |
| Saved for later | Inbox → Saved |
| Hooks | Agents → Automation → Hooks |
| Agent editor | Agents → Agent builder |
| Marketplace | Agents → Skills & integrations |
| Spending | Agents → Usage & cost |
| Social/Public Updates | Insights → Updates |
| Settings | Pinned bottom utility |

## Fix for the missing Settings button

Settings is currently vulnerable because it follows a long list of feature buttons. It should never participate in that list.

### Required layout

Use three vertical regions in the primary rail:

1. workspace/logo header — fixed;
2. five-item product navigation — scrollable only if absolutely necessary;
3. Settings/Profile utility footer — fixed to the bottom.

Implementation pattern:

```css
.app-rail {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  height: 100dvh;
}

.app-rail__navigation {
  min-height: 0;
  overflow-y: auto;
}

.app-rail__utilities {
  flex: none;
  position: sticky;
  bottom: 0;
}
```

Also provide:

- `Ctrl+,` / `Cmd+,` to open Settings;
- Settings search from the command palette;
- Settings access from the profile menu;
- compact icon-only rail on short laptop displays;
- tooltips and accessible names in compact mode;
- scroll only inside secondary lists, never behind the pinned Settings control.

Acceptance checks:

- Settings remains visible at 1280×720 and 1024×768.
- Settings remains reachable at 200% zoom.
- Settings is keyboard reachable without first scrolling the feature list.
- Long workspace names, badges, localization, and eleven or more secondary modules cannot push it out of view.
- Compact mode preserves every primary destination and utility.

## Features required to become a go-to software-engineering application

### A. Daily development essentials

- GitHub, GitLab, and Bitbucket repositories
- Branch, commit, issue, pull-request, and review workflows
- Code browser, semantic search, diffs, inline comments, and blame
- Integrated terminal and task runner
- Local/remote development environments
- Project, task, milestone, and sprint management
- Test execution, coverage, linting, type checks, and build logs
- Universal search across code, chat, tasks, decisions, runs, and artifacts
- Command palette and complete keyboard navigation

### B. AI-native engineering

- Delegate a scoped task directly from chat, code, issue, or project
- Multi-agent parallel execution with visible ownership
- Plan/review/execute roles and explicit handoffs
- Human approval gates for writes, merges, deployments, and destructive actions
- Per-agent tools, skills, working folders, and project permissions
- Durable run timeline with tool calls, artifacts, cost, status, and source links
- Agent memory/context controls with provenance and removal
- Model/provider routing, fallback, limits, and health
- Evals for correctness, regression, latency, and cost
- Replay-safe actions and auditable attribution

### C. Collaboration and knowledge

- Channels, DMs, threads, mentions, rich composer, and huddles
- Consolidated Inbox/Activity
- Saved/Later, reminders, follow-up, and assignments
- Decision records, polls, forums, and architecture discussions
- Project updates and stakeholder-ready summaries
- Searchable documentation and knowledge base
- Contextual presence: who or which agent is working on what

### D. Delivery and operations

- CI/CD integrations and workflow visualization
- Preview environments and deployment approvals
- Release management, changelogs, promotion, and rollback
- Logs, metrics, traces, incidents, and service health
- Test/build/deployment status inside projects and chat
- Security scanning, secrets detection, dependency health, and SBOM support
- Production incident rooms with timeline and postmortem
- Environment variables and secret-reference management without exposing values

### E. Platform and governance

- Extension, plugin, skill, and integration marketplace
- APIs, webhooks, and event subscriptions
- Organization/workspace/project roles and permissions
- SSO, SCIM, audit logs, retention, export, and deletion controls
- Notification policies, quiet hours, routing, and escalation
- Usage, cost, quotas, and budget policies
- Backups, recovery, data portability, and workspace migration
- Desktop update status, diagnostics, and support bundle

## Recommended delivery sequence

### Phase 1 — make the existing product coherent

1. Replace the long rail with Inbox, Chat, Build, Agents, Insights.
2. Pin Settings/Profile permanently.
3. Add universal search and command palette.
4. Consolidate notifications, mentions, threads, approvals, failures, and saved items into Inbox.
5. Standardize loading, empty, pending, success, error, offline, permission, and deleted states.
6. Make every link open the exact destination item.

### Phase 2 — own the developer's daily loop

1. Repository integrations and project linking.
2. Code browser, diff, review, terminal, and task runner.
3. Tasks/issues/milestones connected to commits, PRs, runs, and chat.
4. Test/CI status and artifacts inside Build.
5. Preview environments and deployment visibility.

### Phase 3 — become the best agentic engineering workspace

1. Delegation from any source object.
2. Parallel agent plans, ownership, and handoffs.
3. Approval and permission boundaries.
4. Run timelines, provenance, cost, and audit.
5. Agent skills, hooks, context, memory, providers, and evaluations.

### Phase 4 — production delivery and reliability

1. Deployments, releases, rollback, and environments.
2. Observability and incident collaboration.
3. Security, secrets, dependencies, and compliance evidence.
4. Engineering health and delivery insights.

### Phase 5 — platform and enterprise readiness

1. Marketplace, APIs, webhooks, and ecosystem integrations.
2. RBAC, SSO/SCIM, organization policies, retention, and export.
3. Admin analytics, cost controls, backups, and migration tooling.

## Product rules for future features

Before adding any new feature, answer:

1. Which of the five jobs does it serve: Inbox, Chat, Build, Agents, or Insights?
2. Can it appear inside an existing screen instead of becoming a new destination?
3. What source object does it link to?
4. What are its loading, empty, pending, success, error, offline, permission, and deleted states?
5. How does it behave across reconnect and multiple windows?
6. What can a human do, what can an agent do, and how is attribution shown?
7. What enters Inbox when the user needs attention?
8. How is it found through search and the command palette?

If a feature cannot answer these questions, it is not ready to enter the navigation.

## Final recommendation

Adopt **Option C: Inbox, Chat, Build, Agents, Insights**, with Settings permanently pinned below them.

This structure preserves Cloud9's unusually strong feature breadth while making the product understandable on a laptop. It also creates a durable rule for future growth: add capabilities inside meaningful domains, not as new rail icons.
