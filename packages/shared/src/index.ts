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

export interface AgentDef {
  id: ID;
  ownerId: ID; // the human whose runtime hosts this agent (and whose Claude account pays)
  name: string;
  emoji: string;
  persona: string;
  abilities: AgentAbilities;
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
  | { type: "agentStatus"; agentId: ID; status: AgentStatus };

export type AgentStatus = "idle" | "working" | "braked";

export interface WorldState {
  me: User;
  users: User[];
  agents: AgentDef[];
  channels: Channel[];
  /** most recent messages per channel */
  messages: Message[];
  agentStatus: Record<ID, AgentStatus>;
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
  | { type: "push"; message: Message } // relay → mobile: delivered as notification
  | { type: "error"; error: string };

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
