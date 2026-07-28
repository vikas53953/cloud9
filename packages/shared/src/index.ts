// Cloud9 shared protocol — types used by relay, engine, desktop and mobile.

export type ID = string;

export interface User {
  id: ID;
  name: string;
  /** invite code that created this user, empty for the owner */
  invitedBy?: ID;
}

export interface AgentAbilities {
  webSearch: boolean;
  files: boolean;
  schedules: boolean;
  background: boolean;
}

/** Which controlled actions need the owner's approval first (FR-AP-001, FR-TL-004). */
export interface AgentApprovals {
  background: boolean;   // !bg / !task delegated work
  schedules: boolean;    // creating a schedule
}

/** Which locally-installed AI harness runs this agent's turns (FR-PC-002/003). */
export type HarnessName = "claude" | "codex";

export interface AgentDef {
  id: ID;
  ownerId: ID; // the human whose runtime hosts this agent (and whose Claude account pays)
  name: string;
  emoji: string;
  persona: string;
  abilities: AgentAbilities;
  /** FR-AG-005 — absent means "claude" (v1 agents) */
  provider?: HarnessName;
  /** optional — absent means no approvals required (v1 agents) */
  approvals?: AgentApprovals;
  /** FR-AG-007 — absent means "enabled" (v1 agents) */
  lifecycle?: "enabled" | "paused" | "disabled";
  model?: string;
  createdAt: number;
}

export interface AgentSchedule {
  id: ID;
  agentId: ID;
  channelId: ID;
  /** "daily HH:MM" (24h, local to the engine host) or "every Nm" */
  when: string;
  prompt: string;
  enabled: boolean;
}

// ---------- v2 (spec.md): tasks, approvals, activity ----------

/** Spec §20 candidate states adopted provisionally (logged in PARKING-LOT D3). */
export type TaskStatus =
  | "not_started" | "working" | "waiting_user" | "waiting_approval"
  | "blocked" | "completed" | "failed" | "cancelled";

export interface Task {
  id: ID;
  title: string;           // the requested outcome (FR-TS-001)
  requesterId: ID;         // human who asked
  requesterName: string;
  agentId: ID;             // assigned agent (FR-TS-007 multi-agent: later)
  channelId: ID;           // conversation context (FR-TS-008)
  status: TaskStatus;
  result?: string;
  error?: string;
  approvalId?: ID;
  createdAt: number;
  updatedAt: number;
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Approval {
  id: ID;
  taskId: ID;
  agentId: ID;
  ownerId: ID;             // only the agent's owner may decide (provisional, D4)
  action: string;          // human-readable intended action (FR-AP-002)
  status: ApprovalStatus;
  decidedBy?: ID;
  decidedAt?: number;
  createdAt: number;
}

export type ActivityKind =
  | "message" | "task_created" | "task_status" | "approval_requested"
  | "approval_decided" | "agent_created" | "agent_updated" | "agent_deleted"
  | "channel_created" | "member_added" | "invite_created" | "invite_redeemed";

export interface ActivityRecord {
  id: ID;
  ts: number;
  actorKind: "human" | "agent" | "system";
  actorId: ID;
  actorName: string;
  kind: ActivityKind;
  refId?: ID;              // message/task/approval/agent/channel id
  detail: string;          // plain-language summary (FR-AU-003)
}

// ---------- harness sign-in (docs/plans/harness-signin.md) ----------

/**
 * What the app knows about one locally installed AI harness.
 * STATUS ONLY — booleans and display strings. No token, key or credential
 * material may ever appear in this object (harness-signin.md decision 6).
 */
export interface HarnessInfo {
  name: HarnessName;
  /** the CLI is on this machine */
  installed: boolean;
  /** the CLI reports a logged-in account */
  signedIn: boolean;
  /** display label, e.g. an email or "ChatGPT account" — never a secret */
  account?: string;
  /** CLI version string, for the settings card */
  version?: string;
  /** a sign-in is in progress (browser window open, waiting) */
  signingIn?: boolean;
  /** plain-words note for the UI, e.g. "not installed" */
  detail?: string;
}

export interface HarnessState {
  claude: HarnessInfo;
  codex: HarnessInfo;
  /** a detection round is running right now — the UI disables "Re-check" */
  checking?: boolean;
  updatedAt: number;
}

export type ChannelKind = "channel" | "dm";

export interface Channel {
  id: ID;
  name: string; // for dm: derived, e.g. "dm:<a>:<b>" — clients render the peer name
  kind: ChannelKind;
  memberIds: ID[]; // user ids and agent ids
  createdAt: number;
}

export type AuthorKind = "human" | "agent";

export interface Message {
  id: ID;
  channelId: ID;
  authorId: ID;
  authorName: string;
  authorKind: AuthorKind;
  authorEmoji?: string;
  text: string;
  ts: number;
  proactive?: boolean; // schedule/background-task originated → push-worthy
  mentions?: ID[];
}

// ---------- WebSocket frames ----------

export type ClientFrame =
  | { type: "hello"; token: string; client: "desktop" | "mobile" | "engine" }
  | { type: "send"; channelId: ID; text: string; tempId?: string }
  | { type: "createChannel"; name: string; memberIds: ID[]; kind?: ChannelKind }
  | { type: "addMembers"; channelId: ID; memberIds: ID[] }
  | { type: "createAgent"; agent: Omit<AgentDef, "id" | "ownerId" | "createdAt"> }
  | { type: "updateAgent"; agent: AgentDef }
  | { type: "deleteAgent"; agentId: ID }
  | { type: "createInvite" }
  | { type: "history"; channelId: ID; before?: number; limit?: number }
  // engine-host only: post a message authored by one of the owner's agents
  | { type: "agentSend"; agentId: ID; channelId: ID; text: string; proactive?: boolean }
  | { type: "agentStatus"; agentId: ID; status: AgentStatus }
  // v2 — tasks / approvals / activity
  | { type: "createTask"; agentId: ID; channelId: ID; title: string; needsApproval?: boolean; action?: string }
  | { type: "updateTask"; taskId: ID; status: TaskStatus; result?: string; error?: string } // engine (agent owner) only
  | { type: "cancelTask"; taskId: ID }
  | { type: "decideApproval"; approvalId: ID; decision: "approved" | "rejected" }
  | { type: "activity"; before?: number; limit?: number }
  // harness sign-in — asked by any of the owner's clients, answered by the engine host
  | { type: "harnessStatus" }
  | { type: "harnessSignIn"; harness: HarnessName }
  // engine-host only: report detected harness status (status strings only, never secrets)
  | { type: "harnessState"; state: HarnessState };

export type AgentStatus = "idle" | "working" | "braked";

export interface WorldState {
  me: User;
  users: User[];
  agents: AgentDef[];
  channels: Channel[];
  /** most recent messages per channel */
  messages: Message[];
  agentStatus: Record<ID, AgentStatus>;
  tasks: Task[];
  approvals: Approval[];
}

export type ServerFrame =
  | { type: "welcome"; state: WorldState }
  | { type: "message"; message: Message; tempId?: string }
  | { type: "channel"; channel: Channel }
  | { type: "agent"; agent: AgentDef }
  | { type: "agentDeleted"; agentId: ID }
  | { type: "agentStatus"; agentId: ID; status: AgentStatus }
  | { type: "invite"; code: string }
  | { type: "history"; channelId: ID; messages: Message[] }
  | { type: "userJoined"; user: User }
  | { type: "token"; token: string } // durable token issued after invite redemption
  | { type: "task"; task: Task }
  | { type: "approval"; approval: Approval }
  | { type: "activity"; records: ActivityRecord[] }
  | { type: "push"; message: Message } // relay → mobile: delivered as notification
  // harness status broadcast to the owner's clients
  | { type: "harness"; state: HarnessState }
  // relay → engine host: do the harness work (the engine owns the CLIs)
  | { type: "harnessRequest"; action: "status" | "signIn"; harness?: HarnessName }
  | { type: "error"; error: string };

// ---------- untrusted input validation ----------
//
// Agent fields are written by clients and some of them (model) end up on a
// command line. They are validated at BOTH boundaries: the relay refuses to
// store a bad one, and the engine refuses to run one. Same function, so the two
// checks can never drift apart.

/** Model ids are vendor slugs — letters, digits, dot, dash, underscore. */
export const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export const AGENT_LIMITS = { name: 64, emoji: 16, persona: 8000 } as const;

export interface AgentInput {
  name?: string;
  emoji?: string;
  persona?: string;
  model?: string;
  provider?: string;
}

/**
 * Check an agent's user-supplied fields.
 * Returns a plain-words problem description, or null when the agent is fine.
 */
export function validateAgentInput(agent: AgentInput): string | null {
  if (typeof agent.name !== "string" || agent.name.trim().length === 0) {
    return "an agent needs a name";
  }
  if (agent.name.length > AGENT_LIMITS.name) {
    return `that name is too long (max ${AGENT_LIMITS.name} characters)`;
  }
  if (typeof agent.emoji === "string" && agent.emoji.length > AGENT_LIMITS.emoji) {
    return `that emoji is too long (max ${AGENT_LIMITS.emoji} characters)`;
  }
  if (typeof agent.persona === "string" && agent.persona.length > AGENT_LIMITS.persona) {
    return `that personality is too long (max ${AGENT_LIMITS.persona} characters)`;
  }
  if (agent.model !== undefined && agent.model !== "" && !MODEL_ID_RE.test(agent.model)) {
    return "that model name isn't a valid model id";
  }
  if (agent.provider !== undefined && agent.provider !== "claude" && agent.provider !== "codex") {
    return "an agent must run on either Claude or Codex";
  }
  return null;
}

/** A harness we know nothing about yet — used before the first detection run. */
export function unknownHarness(name: HarnessName): HarnessInfo {
  return { name, installed: false, signedIn: false, detail: "checking…" };
}

// ---------- helpers ----------

/** Extract @mentions of the given directory (users+agents) from a message text. */
export function extractMentions(
  text: string,
  directory: { id: ID; name: string }[],
): ID[] {
  const found: ID[] = [];
  for (const entry of directory) {
    const re = new RegExp(`@${escapeRe(entry.name)}(?![\\w-])`, "i");
    if (re.test(text)) found.push(entry.id);
  }
  return found;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function newId(prefix: string): ID {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
