# Agent Workforce Platform — Product Specification

**File:** `spec.md`  
**Status:** Product vision draft based only on confirmed conversation input  
**Scope:** Full product vision  
**Implementation status:** Not yet approved for implementation  
**Source of truth:** This document

---

## 1. Document Rules

This specification must be interpreted using the following rules:

1. Do not invent requirements that are not written in this file.
2. Do not select a technology stack unless the repository already defines one or the user approves one.
3. Do not assume that a provider permits consumer-subscription access from a third-party application.
4. Treat every item marked `TBD` as unresolved.
5. Do not silently replace a `TBD` with a default.
6. Confirm unresolved product, technical, security, commercial, and provider-integration decisions before implementing the affected capability.
7. Preserve modular boundaries so unresolved providers, clients, tools, and execution environments can be added later.
8. The full product vision does not mean every capability must be delivered in the first release.

---

## 2. Confirmed Product Vision

Build a web GUI and desktop chat application where users can:

- connect supported AI coding or agent services, including Claude and Codex;
- create specialised agents;
- communicate with agents through a collaboration interface;
- allow agents to communicate and coordinate across the application;
- use the product from more than one supported client;
- delegate work to agents in the same way a company assigns work to expert employees;
- obtain outcomes without manually building or operating a separate application for every need.

The platform is intended to change the interaction model from:

```text
Need -> Build or find an application -> Learn it -> Operate it manually
```

to:

```text
Need -> Create or select an expert agent -> Explain the required outcome -> Agent performs the work
```

---

## 3. Problem Statement

Today, users and businesses often build or adopt different applications for different needs, such as:

- web applications;
- desktop applications;
- mobile applications;
- social-media applications;
- task-specific internal tools;
- other specialised software.

This creates fragmentation. Users must learn, configure, operate, and maintain multiple applications.

The proposed platform should let users create or use specialised agents that behave like expert workers. A user should describe the outcome, assign the work, monitor progress, provide approvals where required, and receive the result.

The platform is not defined as only a chatbot and not defined as only an app builder.

It is a workspace for creating, communicating with, managing, and coordinating AI agents that perform work.

---

## 4. Product Thesis

The product thesis is:

> Many tasks that currently require a separate application can be delivered through specialised agents that use tools, context, permissions, and workflows on behalf of the user.

The platform should function like a digital company or workforce:

- the user defines what needs to be achieved;
- specialised agents receive roles and responsibilities;
- agents use available tools and connected systems;
- agents coordinate with the user and with other agents;
- the user remains in control of permissions, approvals, and final outcomes.

---

## 5. Product Definition

### 5.1 Product Category

Working category:

**Agent Workforce Platform**

Alternative category names are not approved and remain `TBD`.

### 5.2 Core Product Model

```text
User
  |
  v
Workspace
  |
  +-- Conversations
  |     +-- Channels
  |     +-- Direct conversations
  |     +-- Task conversations
  |
  +-- Agents
  |     +-- Role
  |     +-- Instructions
  |     +-- Provider/runtime
  |     +-- Tools
  |     +-- Permissions
  |     +-- Context
  |
  +-- Work
        +-- Requests
        +-- Tasks
        +-- Approvals
        +-- Results
        +-- History
```

This is a conceptual model, not an approved database schema.

---

## 6. Confirmed User Outcomes

The user selected all four outcome options presented during structured intake.

The exact labels and wording of those four options were not included in the available conversation transcript. They must not be reconstructed or guessed.

Until the original labels are supplied, record them as:

1. **Outcome 1 — TBD exact wording**
2. **Outcome 2 — TBD exact wording**
3. **Outcome 3 — TBD exact wording**
4. **Outcome 4 — TBD exact wording**

### Requirement

The final product must support all four confirmed outcomes after their exact definitions are added to this document.

No implementation-specific acceptance criteria may be written for these outcomes until the wording is known.

---

## 7. Confirmed Target Users

The user selected all four target-user options presented during structured intake.

The exact labels and wording of those four options were not included in the available conversation transcript. They must not be reconstructed or guessed.

Until the original labels are supplied, record them as:

1. **Target user 1 — TBD exact definition**
2. **Target user 2 — TBD exact definition**
3. **Target user 3 — TBD exact definition**
4. **Target user 4 — TBD exact definition**

### Requirement

The product vision must accommodate all four confirmed target-user groups after their exact definitions are added.

The first release does not automatically need to serve all four groups. Release prioritisation remains `TBD`.

---

## 8. Product Principles

### 8.1 Outcome Before Interface

Users should begin with the result they want, not with a requirement to choose or build an application.

### 8.2 Agents as Expert Workers

An agent should represent a role or responsibility, not only a model session.

### 8.3 Human Control

Users must remain able to:

- inspect work;
- approve or reject sensitive actions;
- pause or stop work;
- change instructions;
- review results;
- understand which agent performed an action.

### 8.4 Multi-Agent Collaboration

The platform must support more than isolated one-to-one chats. Agents must be able to participate in shared work and communicate within the product.

### 8.5 Provider Independence

The product should not be permanently coupled to only one AI provider.

Initial provider intent includes:

- Claude;
- Codex.

The exact connection and authentication methods are `TBD` and must follow each provider's current official rules.

### 8.6 Cross-Client Continuity

A user should be able to continue supported conversations and monitor work across the supported web and desktop clients.

Additional clients are `TBD`.

### 8.7 Explicit Permissions

An agent must not automatically receive unrestricted access to user systems, files, applications, credentials, or communication channels.

### 8.8 Traceable Work

Agent activity should be attributable and reviewable.

The required retention period, audit depth, and export format are `TBD`.

---

## 9. Core Entities

The following entities are required conceptually. Their exact fields and storage design are `TBD`.

### 9.1 User

Represents a human using the platform.

Possible concerns that require later definition:

- identity;
- authentication;
- profile;
- workspace membership;
- role;
- permissions;
- notification preferences.

### 9.2 Workspace

Represents the shared environment in which humans and agents operate.

A workspace may contain:

- users;
- agents;
- conversations;
- tasks;
- connected providers;
- connected tools;
- policies;
- activity history.

Workspace ownership and membership rules are `TBD`.

### 9.3 Agent

Represents a specialised AI worker.

An agent requires, at minimum, a defined:

- identity;
- role or responsibility;
- instruction set;
- provider or runtime;
- allowed tools;
- permissions;
- accessible context;
- communication scope;
- status.

The exact creation form and defaults are `TBD`.

### 9.4 Conversation

Represents communication between:

- one user and one agent;
- multiple users;
- multiple agents;
- users and multiple agents.

Required conversation types are:

- direct conversation;
- shared channel or room.

Other types are `TBD`.

### 9.5 Task

Represents a unit of delegated work.

A task may include:

- requested outcome;
- requester;
- assigned agent or agents;
- status;
- conversation context;
- required approvals;
- result;
- errors;
- timestamps.

The workflow states are `TBD`.

### 9.6 Tool Connection

Represents access to an external capability used by an agent.

Examples are not approved as required integrations. The specific tool catalogue is `TBD`.

### 9.7 Provider Connection

Represents a supported connection to an AI provider or agent runtime.

Initial provider intent:

- Claude;
- Codex.

Authentication, subscription use, API use, billing, rate limits, and commercial terms are unresolved and must be verified before implementation.

### 9.8 Approval

Represents a human decision required before an agent performs a controlled action.

Approval categories and risk levels are `TBD`.

### 9.9 Activity Record

Represents a trace of important user, agent, tool, and system actions.

The exact event schema is `TBD`.

---

## 10. Functional Requirements

Priority labels:

- `P0`: Required for the product's core definition.
- `P1`: Required for a complete product vision but may follow the first implementation.
- `P2`: Optional or future capability.
- `TBD`: Priority not yet approved.

### 10.1 User and Workspace Management

| ID | Priority | Requirement |
|---|---:|---|
| FR-UW-001 | P0 | A user must be able to access the platform through an authenticated account. |
| FR-UW-002 | P0 | A user must be able to access at least one workspace. |
| FR-UW-003 | P0 | A workspace must support human users and agents. |
| FR-UW-004 | TBD | Workspace invitation and membership management. |
| FR-UW-005 | TBD | Workspace roles and administrative permissions. |
| FR-UW-006 | TBD | Personal workspaces versus organisation workspaces. |

Authentication method is `TBD`.

### 10.2 Provider Connections

| ID | Priority | Requirement |
|---|---:|---|
| FR-PC-001 | P0 | The architecture must support connecting an agent to a provider or runtime. |
| FR-PC-002 | P0 | Claude must be represented as an intended provider integration. |
| FR-PC-003 | P0 | Codex must be represented as an intended provider integration. |
| FR-PC-004 | P0 | The product must not claim that a consumer subscription can be connected unless the provider officially permits the method used. |
| FR-PC-005 | P0 | Provider credentials or tokens must not be exposed to other workspace members or agents without explicit permission. |
| FR-PC-006 | P1 | The architecture should permit additional providers later. |
| FR-PC-007 | TBD | Connection ownership: user-level, workspace-level, or both. |
| FR-PC-008 | TBD | Usage metering, limits, and billing behaviour. |

### 10.3 Agent Creation and Management

| ID | Priority | Requirement |
|---|---:|---|
| FR-AG-001 | P0 | A user must be able to create an agent. |
| FR-AG-002 | P0 | An agent must have a visible identity. |
| FR-AG-003 | P0 | An agent must have a defined role or responsibility. |
| FR-AG-004 | P0 | An agent must have instructions that guide its behaviour. |
| FR-AG-005 | P0 | An agent must be associated with a provider or runtime. |
| FR-AG-006 | P0 | An agent must have an explicit permission scope. |
| FR-AG-007 | P0 | A user must be able to enable, pause, or disable an agent. |
| FR-AG-008 | P1 | A user should be able to edit an agent after creation. |
| FR-AG-009 | P1 | A user should be able to duplicate an agent configuration. |
| FR-AG-010 | TBD | Agent templates. |
| FR-AG-011 | TBD | Public or private agent marketplace. |
| FR-AG-012 | TBD | Agent versioning. |

### 10.4 Communication

| ID | Priority | Requirement |
|---|---:|---|
| FR-CM-001 | P0 | A user must be able to send a message to an agent. |
| FR-CM-002 | P0 | An agent must be able to respond in the relevant conversation. |
| FR-CM-003 | P0 | The product must support shared conversations containing humans and agents. |
| FR-CM-004 | P0 | A user must be able to address a specific agent inside a shared conversation. |
| FR-CM-005 | P0 | Agent messages must visibly identify the sending agent. |
| FR-CM-006 | P0 | Conversation history must remain available according to the product's retention policy. |
| FR-CM-007 | P1 | Agents should be able to communicate or hand work to other agents when permitted. |
| FR-CM-008 | P1 | The user should be able to see when an agent is working, waiting, blocked, or completed. |
| FR-CM-009 | **P1** | Threads, reactions, attachments, editing, deletion, and mentions. **TBD resolved by Vikas 2026-07-29** (spec rule 15): *"also do add the feature of slack and buzz, whatever features we have"*, and earlier *"all of the features which we have in buzz, i really want those features"*. Build order recorded in `docs/plans/feature-gap.md`. |
| FR-CM-010 | TBD | Voice or video communication. |

### 10.5 Task Delegation and Execution

| ID | Priority | Requirement |
|---|---:|---|
| FR-TS-001 | P0 | A user must be able to request an outcome from an agent. |
| FR-TS-002 | P0 | The system must associate work with a task or traceable execution record. |
| FR-TS-003 | P0 | A task must expose its current status. |
| FR-TS-004 | P0 | A task must produce a result, failure, cancellation, or blocked state. |
| FR-TS-005 | P0 | A user must be able to stop or cancel work where technically possible. |
| FR-TS-006 | P0 | An agent must not use a tool outside its allowed permission scope. |
| FR-TS-007 | P1 | A task should support more than one participating agent. |
| FR-TS-008 | P1 | A task should retain relevant conversation and execution context. |
| FR-TS-009 | TBD | Scheduling, recurrence, deadlines, priorities, queues, and dependencies. |
| FR-TS-010 | TBD | Background and long-running execution model. |

### 10.6 Agent-to-Agent Collaboration

| ID | Priority | Requirement |
|---|---:|---|
| FR-AA-001 | P1 | A permitted agent should be able to request work from another agent. |
| FR-AA-002 | P1 | Delegated work must remain traceable to the initiating user and agent. |
| FR-AA-003 | P1 | Agents must not expand their own permissions by delegating work. |
| FR-AA-004 | P1 | The user must be able to inspect agent handoffs. |
| FR-AA-005 | TBD | Automatic team planning or manager-agent behaviour. |
| FR-AA-006 | TBD | Conflict resolution between agent outputs. |

### 10.7 Tools and External Systems

| ID | Priority | Requirement |
|---|---:|---|
| FR-TL-001 | P0 | The architecture must support giving agents access to tools. |
| FR-TL-002 | P0 | Tool access must be explicitly granted. |
| FR-TL-003 | P0 | Tool calls must be associated with the acting agent and task. |
| FR-TL-004 | P0 | Sensitive tool actions must support human approval where configured. |
| FR-TL-005 | P1 | Tool failures should be reported to the user in understandable language. |
| FR-TL-006 | P1 | The architecture should permit different tool protocols or connector types. |
| FR-TL-007 | TBD | Initial supported tools and integrations. |
| FR-TL-008 | TBD | User-created tools or connectors. |
| FR-TL-009 | TBD | Tool marketplace. |

### 10.8 Context and Memory

| ID | Priority | Requirement |
|---|---:|---|
| FR-ME-001 | P0 | An agent must receive enough authorised context to perform its assigned work. |
| FR-ME-002 | P0 | Context access must respect workspace, conversation, task, and permission boundaries. |
| FR-ME-003 | P0 | Users must be able to understand what persistent information an agent may use. |
| FR-ME-004 | P1 | Users should be able to remove or update persistent agent information. |
| FR-ME-005 | TBD | Memory types, retention, summarisation, retrieval, and sharing rules. |
| FR-ME-006 | TBD | Cross-agent shared memory. |

### 10.9 Approvals and Control

| ID | Priority | Requirement |
|---|---:|---|
| FR-AP-001 | P0 | The system must support requesting human approval before configured actions. |
| FR-AP-002 | P0 | An approval request must identify the agent, task, intended action, and requested permission. |
| FR-AP-003 | P0 | The user must be able to approve or reject the request. |
| FR-AP-004 | P0 | Rejected actions must not execute through the rejected approval. |
| FR-AP-005 | P1 | Approval decisions should be recorded in activity history. |
| FR-AP-006 | TBD | Approval expiry, delegation, multi-approver rules, and policy automation. |

### 10.10 Cross-Client Access

| ID | Priority | Requirement |
|---|---:|---|
| FR-CL-001 | P0 | The product must provide a web GUI. |
| FR-CL-002 | P0 | The product must provide a desktop chat application. |
| FR-CL-003 | P0 | Supported conversations and task state must remain consistent between web and desktop clients. |
| FR-CL-004 | P0 | A user must be able to continue a supported conversation from another supported client. |
| FR-CL-005 | P1 | A user should be able to monitor agent status from another supported client. |
| FR-CL-006 | TBD | Native mobile application. |
| FR-CL-007 | TBD | Mobile-responsive web experience. |
| FR-CL-008 | TBD | Offline behaviour. |

### 10.11 Notifications

| ID | Priority | Requirement |
|---|---:|---|
| FR-NT-001 | P1 | The system should notify a user when an approval is required. |
| FR-NT-002 | P1 | The system should notify a user when important work completes, fails, or becomes blocked. |
| FR-NT-003 | TBD | Notification channels and preferences. |
| FR-NT-004 | TBD | Notification grouping, quiet hours, and escalation. |

### 10.12 History and Auditability

| ID | Priority | Requirement |
|---|---:|---|
| FR-AU-001 | P0 | Important agent actions must be attributable to an agent and task. |
| FR-AU-002 | P0 | Important human approvals and rejections must be attributable to a user. |
| FR-AU-003 | P0 | The system must preserve enough execution history to explain what occurred. |
| FR-AU-004 | P1 | Users should be able to inspect task history. |
| FR-AU-005 | TBD | Export, retention, immutability, search, and compliance requirements. |

---

## 11. Primary User Experience

### 11.1 Entry

The user opens the web GUI or desktop application and enters a workspace.

Exact onboarding steps are `TBD`.

### 11.2 Connect a Provider

The user connects a supported provider or runtime.

The interface must clearly explain:

- what is being connected;
- who owns the connection;
- what permissions are granted;
- how usage is charged or limited;
- how the connection can be removed.

The exact connection flow for Claude and Codex is `TBD` pending official provider rules and product decisions.

### 11.3 Create an Agent

The user creates an agent and defines its purpose.

The final fields are `TBD`, but the system must capture enough information to establish:

- who the agent is;
- what the agent should do;
- which provider or runtime it uses;
- which tools and information it may access;
- where it may communicate;
- which actions require approval.

### 11.4 Add the Agent to Work

The user starts a direct conversation or adds the agent to a shared conversation.

### 11.5 Delegate an Outcome

The user explains the desired result.

Example structure only:

```text
User -> Agent: "Complete this outcome."
```

No specific domain example is part of the confirmed product scope.

### 11.6 Agent Performs Work

The agent may:

- understand the request;
- use authorised context;
- use authorised tools;
- communicate progress;
- request clarification;
- request approval;
- delegate permitted sub-work;
- return a result.

The exact autonomy model is `TBD`.

### 11.7 User Reviews the Result

The user can inspect the result and relevant activity history.

Revision, acceptance, publishing, deployment, or other final actions depend on the task and are `TBD`.

---

## 12. Conceptual Agent Execution Loop

The platform should support an agent work cycle conceptually similar to:

```text
Receive request
  -> Understand goal
  -> Inspect authorised context
  -> Plan next action
  -> Check permissions
  -> Request approval when required
  -> Use authorised tool or communicate
  -> Observe result
  -> Continue, stop, fail, or complete
  -> Report outcome
```

This is a conceptual requirement and not an approved orchestration algorithm.

---

## 13. Product Surfaces

### 13.1 Web GUI

Required at the product level.

Exact pages and navigation are `TBD`.

Expected capability categories:

- workspace access;
- conversations;
- agents;
- tasks;
- provider connections;
- tool connections;
- approvals;
- activity history;
- settings.

These categories do not approve a specific layout.

### 13.2 Desktop Chat Application

Required at the product level.

The desktop application must support the core communication experience.

Whether it also hosts local execution is `TBD`.

Desktop framework, operating systems, packaging, updates, and sandboxing are `TBD`.

### 13.3 Additional Clients

Not confirmed.

Potential additional clients must remain outside implementation scope until approved.

---

## 14. System Boundaries

The platform includes:

- agent configuration;
- human-agent communication;
- agent-agent communication where permitted;
- task delegation;
- provider/runtime connections;
- tool permissions;
- approvals;
- status visibility;
- cross-client continuity;
- activity history.

The platform does not automatically include the following unless later approved:

- a social network;
- a public agent marketplace;
- a full project-management suite;
- a complete Slack replacement;
- video meetings;
- voice calling;
- an application generator;
- a code-hosting platform;
- a payment platform;
- a native mobile app;
- autonomous access to every user account;
- unrestricted background execution.

---

## 15. Non-Functional Requirements

Exact targets are unresolved. The following requirement categories must be addressed before production.

### 15.1 Security

- Protect provider credentials and tokens.
- Apply least-privilege access.
- Isolate workspace data.
- Isolate agent permissions.
- Prevent one agent from silently using another agent's permissions.
- Record sensitive actions.
- Support revocation of provider and tool access.
- Define secure local and cloud execution boundaries.
- Define secret storage.
- Define authentication and session security.
- Define protection against malicious instructions in external content.

Specific standards and controls are `TBD`.

### 15.2 Privacy

- Define what user data is stored.
- Define where data is stored.
- Define what is sent to each provider.
- Define retention and deletion.
- Define memory behaviour.
- Define workspace visibility.
- Define data export.
- Define provider-specific privacy disclosures.

### 15.3 Reliability

- Preserve task and conversation state.
- Avoid duplicate execution of controlled actions.
- Expose failures clearly.
- Define retry behaviour.
- Define recovery for interrupted work.
- Define local-client disconnection behaviour.

Targets are `TBD`.

### 15.4 Performance

Targets for:

- message delivery;
- agent start time;
- status updates;
- synchronisation;
- history loading;
- tool-call latency;

are `TBD`.

### 15.5 Scalability

Targets for:

- users;
- workspaces;
- agents;
- concurrent tasks;
- conversation volume;
- tool events;
- provider requests;

are `TBD`.

### 15.6 Accessibility

Accessibility standard and target level are `TBD`.

### 15.7 Observability

The production system must eventually define:

- logs;
- metrics;
- traces;
- task-level diagnostics;
- provider errors;
- tool errors;
- audit events;
- alerting.

### 15.8 Cost Control

The system must eventually define:

- who pays provider usage;
- usage visibility;
- limits;
- budgets;
- rate controls;
- runaway-agent prevention;
- tool-related costs.

---

## 16. Conceptual Architecture

No technology stack is approved.

The architecture should preserve these logical boundaries:

```text
Web Client -----------------------+
                                  |
Desktop Client -------------------+--> Application/API Layer
                                             |
                                             +--> Identity and Workspace
                                             |
                                             +--> Conversation Service
                                             |
                                             +--> Agent Configuration
                                             |
                                             +--> Task Orchestration
                                             |
                                             +--> Approval and Policy
                                             |
                                             +--> Activity History
                                             |
                                             +--> Provider Adapters
                                             |       +--> Claude adapter
                                             |       +--> Codex adapter
                                             |
                                             +--> Tool Adapters
                                             |
                                             +--> Execution Environment(s)
                                             |
                                             +--> Storage and Synchronisation
```

This diagram is conceptual. It does not approve:

- monolith versus microservices;
- cloud provider;
- programming language;
- frontend framework;
- desktop framework;
- database;
- queue;
- event bus;
- container platform;
- local daemon;
- deployment model.

---

## 17. Provider Adapter Contract

Each provider integration should eventually expose a common conceptual contract.

The exact API is `TBD`.

Required capability questions for every provider:

- How is the user authenticated?
- Is a consumer subscription allowed?
- Is an API key required?
- Is enterprise authentication supported?
- Can the provider stream responses?
- Can the provider call tools?
- Can work continue asynchronously?
- Can the provider resume a task?
- How are approvals represented?
- How are usage and limits reported?
- How is conversation state stored?
- What data is sent to the provider?
- What commercial terms apply?

Claude Code must not implement a provider adapter by guessing answers to these questions.

---

## 18. Tool Adapter Contract

Every tool connection must eventually define:

- identity of the connected account;
- authentication method;
- available actions;
- read versus write permissions;
- approval requirements;
- input validation;
- output format;
- error handling;
- rate limits;
- audit events;
- revocation;
- secret storage;
- user-visible disclosure.

The exact tool protocol is `TBD`.

---

## 19. Permission Model

The permission system must be explicit and deny access that has not been granted.

Conceptual permission layers:

```text
Workspace permission
  -> Conversation permission
      -> Agent permission
          -> Context permission
              -> Tool permission
                  -> Action permission
                      -> Approval requirement
```

The final policy model is `TBD`.

Required invariant:

> Agent delegation must not increase the effective permissions of the original task.

---

## 20. Task and Status Model

The exact state machine is `TBD`.

The product must at least distinguish these outcomes conceptually:

- not started;
- working;
- waiting for user;
- waiting for approval;
- blocked;
- completed;
- failed;
- cancelled.

Names and transitions require approval before implementation.

---

## 21. Data and Storage

No database or storage system is approved.

The system will likely need to represent:

- users;
- workspaces;
- memberships;
- agents;
- agent versions or configurations;
- provider connections;
- tool connections;
- conversations;
- messages;
- tasks;
- execution events;
- approvals;
- results;
- notifications;
- activity history;
- policies;
- secrets or references to secrets.

This list is conceptual and must be validated during technical design.

---

## 22. Full Product Vision Capabilities

These capabilities belong to the full vision, but their release phase is not approved.

### 22.1 Digital Workforce

Users can organise multiple specialised agents as a working team.

### 22.2 Cross-Agent Workflows

Agents can hand off work and combine results while preserving traceability and permission boundaries.

### 22.3 Reusable Agent Roles

Users may eventually reuse an agent configuration across tasks or workspaces, subject to future product decisions.

### 22.4 Tool-Using Agents

Agents can perform work through authorised external tools rather than only producing text.

### 22.5 Cross-Device Continuity

Users can monitor and communicate through supported clients without losing the task state.

### 22.6 Governance

Users or organisations can define who may create agents, connect providers, attach tools, approve actions, or view activity.

### 22.7 Extensible Provider Layer

Additional model and agent providers can be added without redesigning the complete product.

### 22.8 Extensible Tool Layer

Additional tools and business systems can be connected through defined interfaces.

### 22.9 Domain-Specific Teams

The architecture may eventually support collections of agents designed for different types of work.

No initial domain is confirmed in this specification.

---

## 23. Release Planning

The user selected a full product vision, not a specific release plan.

The following are therefore unresolved:

- first release scope;
- MVP definition;
- first target-user group;
- first domain;
- first provider;
- first tool;
- first operating system;
- deployment model;
- pricing;
- launch geography;
- enterprise versus individual focus.

Claude Code must not treat the complete vision as a single implementation milestone.

---

## 24. Acceptance Criteria for the Product Concept

The product concept is satisfied only when all of the following are true:

1. A human can access the platform.
2. The platform provides a web GUI.
3. The platform provides a desktop chat application.
4. A human can create a specialised agent.
5. The agent has an identifiable role.
6. The agent is connected to a supported provider or runtime.
7. The human can communicate with the agent.
8. Humans and agents can participate in a shared conversation.
9. A human can delegate an outcome to an agent.
10. The platform can represent the work as a traceable task.
11. The agent can use only authorised context and tools.
12. Controlled actions can require human approval.
13. Agent activity can be attributed and reviewed.
14. Supported conversation and task state can continue across supported clients.
15. The architecture can accommodate Claude and Codex without permanently coupling the product to one provider.
16. The product moves the user experience from manually operating many applications toward delegating work to expert agents.

These are product-level criteria, not release-level test cases.

---

## 25. Open Decisions

The following decisions require user input before the affected implementation begins.

### 25.1 Missing Structured-Intake Labels

- Exact wording of outcomes 1, 2, 3, and 4.
- Exact definitions of target users 1, 2, 3, and 4.

### 25.2 Product Scope

- First release or MVP.
- First target-user group.
- First work domain.
- Whether the platform is initially personal, team-based, organisational, or all of these.
- Whether users create agents from scratch, templates, or both.
- Whether agents are private, shareable, sellable, or all of these.

### 25.3 Provider Integration

- Exact meaning of “connect Claude subscription.”
- Exact meaning of “connect Codex subscription.”
- Approved authentication method for each provider.
- API usage versus local runtime usage.
- Who pays provider usage.
- Supported plans and account types.
- Provider connection ownership.
- Required fallback when a provider does not support subscription-based third-party access.

### 25.4 Execution

- Local execution, cloud execution, or hybrid.
- Whether the desktop application hosts an agent runtime.
- Whether tasks continue when the desktop application is closed.
- Long-running task behaviour.
- Isolation and sandboxing.
- File-system access.
- Terminal or command execution.
- Network access.
- User approval policy.

### 25.5 Clients

- Supported web browsers.
- Supported desktop operating systems.
- Whether mobile-responsive web is required.
- Whether a native mobile app is required.
- Offline behaviour.

### 25.6 Communication

- Channel model.
- Direct-message model.
- Threads.
- Attachments.
- Search.
- Message editing and deletion.
- Read receipts.
- Presence.
- Voice or video.

### 25.7 Agents

- Required agent-creation fields.
- Instruction format.
- Memory model.
- Agent status model.
- Agent templates.
- Agent duplication.
- Agent versioning.
- Agent teams.
- Manager-agent behaviour.
- Agent-to-agent autonomy.

### 25.8 Tools

- First supported tool.
- Connector protocol.
- User-created connectors.
- Read/write permission model.
- Approval levels.
- Tool output handling.
- Tool credential ownership.

### 25.9 Security and Governance

- Authentication.
- Workspace roles.
- Administrative controls.
- Audit retention.
- Data residency.
- Encryption requirements.
- Compliance requirements.
- Secret management.
- Organisation policies.
- Content and prompt-injection protections.

### 25.10 Commercial Model

- Free, subscription, usage-based, enterprise, or other.
- Provider usage pass-through.
- Agent pricing.
- Workspace pricing.
- Tool-related pricing.
- Limits and quotas.

### 25.11 Technology

- Existing repository status.
- Web framework.
- Desktop framework.
- Backend language and framework.
- Storage.
- deployment platform.
- real-time transport.
- queue or orchestration mechanism.
- local runtime.
- testing strategy.
- observability stack.

---

## 26. Instructions for Claude Code

When this file is handed to Claude Code:

1. Read the complete file before changing code.
2. Inspect the repository before proposing architecture.
3. Identify which requirements are already implemented.
4. Create a traceability table from requirement IDs to code locations and tests.
5. Do not choose values for `TBD` items.
6. Do not claim provider subscription integration is supported without verifying current official provider documentation and commercial rules.
7. Do not create unrestricted tool, file-system, terminal, or network access.
8. Keep provider integrations behind adapters.
9. Keep tool integrations behind adapters.
10. Keep web and desktop clients separated from provider-specific logic.
11. Preserve permission and audit boundaries in every design.
12. Before implementation, produce:
    - repository assessment;
    - confirmed requirements;
    - blocked requirements;
    - unresolved decisions;
    - proposed implementation phases;
    - files expected to change;
    - test strategy.
13. Implement only the scope explicitly approved by the user.
14. Do not interpret “full product vision” as approval to build every feature immediately.
15. Update this specification when the user resolves a `TBD`.
16. Do not remove unresolved items to make the project appear complete.

---

## 27. Definition of Ready for Implementation

A feature is ready for implementation only when:

- its requirement is written;
- its priority is approved;
- affected `TBD` decisions are resolved;
- provider rules have been verified where relevant;
- security implications are understood;
- user flow is defined;
- acceptance criteria are defined;
- repository and architecture constraints are known.

---

## 28. Definition of Done for a Feature

A feature is done only when:

- approved behaviour is implemented;
- permission boundaries are enforced;
- failures are handled;
- relevant activity is traceable;
- tests cover the acceptance criteria;
- user-visible states are implemented;
- documentation is updated;
- no unresolved requirement is silently treated as complete.

---

## 29. Summary

The product is a web and desktop agent-workforce platform.

Its purpose is to let users delegate outcomes to specialised AI agents instead of manually building or operating a different application for every need.

The platform must support:

- agent creation;
- Claude and Codex as intended provider integrations;
- human-agent communication;
- shared conversations;
- agent collaboration;
- delegated tasks;
- tools and permissions;
- approvals;
- traceable activity;
- continuity across supported clients.

All missing decisions remain explicitly marked as `TBD` and must not be guessed.
