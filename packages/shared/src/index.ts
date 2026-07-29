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

/**
 * WHO MAY MAKE THIS AGENT ACT.
 *
 * An agent's turns are spent on ITS OWNER'S subscription and run on ITS
 * OWNER'S computer. So "can you see the channel" was never the right question:
 * being in a room with someone's agent is not permission to spend their money
 * or start programs on their machine.
 *
 * - `"owner"` — only the person who built it. THE DEFAULT, and the default
 *   when the field is absent, because an agent from before this rule existed
 *   must not be more open than one made after it.
 * - `"allowlist"` — the owner, plus the people named in `respondToAllowlist`.
 * - `"anyone"` — anyone who can see the conversation. A deliberate, typed-out
 *   choice; never something that happens by omission.
 */
export type AgentRespondTo = "owner" | "allowlist" | "anyone";

/**
 * A skill is a plain-words ability the owner writes for one agent: a name, what
 * it does, and the instructions to follow. Optional files are dropped into the
 * agent's own folder so the agent can read them while it works.
 *
 * Groundwork only in this round — the engine injects the instructions and
 * writes the files; the UI for editing them is Builder B's.
 */
export interface AgentSkillFile {
  /** bare file name, no folders — e.g. "checklist.md" */
  name: string;
  /** the file's text content */
  text: string;
}

export interface AgentSkill {
  id: ID;
  name: string;
  /** one line: what this skill is for */
  description: string;
  /** what the agent should actually do — written in plain words */
  instructions: string;
  files?: AgentSkillFile[];
}

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
  /**
   * Which model of the chosen app runs this agent. USER-VISIBLE from round 2:
   * clients must always set it (falling back to the harness default), and the
   * relay and engine both check it against that harness's real model list.
   */
  model?: string;
  /** FR (feedback round 1, his 9) — plain-words skills, absent means none */
  skills?: AgentSkill[];
  /** who may make this agent act — absent means "owner" (the safe default) */
  respondTo?: AgentRespondTo;
  /** user ids allowed to drive it, only read when respondTo is "allowlist" */
  respondToAllowlist?: ID[];
  createdAt: number;
}

/**
 * May this person make this agent act?
 *
 * ONE OWNER FOR THE RULE. Mentioning an agent, delegating a background job,
 * asking for a schedule — every path that ends in a turn on the owner's
 * machine asks THIS function, so a new path cannot quietly arrive without the
 * check. The relay enforces it; the engine may also ask, and will get the same
 * answer because it is the same code.
 *
 * The answer is computed from what is STORED about the agent, never from what
 * a client said about itself.
 */
export function mayDriveAgent(userId: ID, agent: AgentDef): boolean {
  if (agent.ownerId === userId) return true;
  switch (agent.respondTo ?? "owner") {
    case "anyone": return true;
    case "allowlist": return (agent.respondToAllowlist ?? []).includes(userId);
    default: return false;
  }
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
  | "channel_created" | "member_added" | "invite_created" | "invite_redeemed"
  // FR-CM-009: changing or withdrawing something already said is an ACTION, and
  // the trail has to keep it — otherwise "delete" quietly means "rewrite history"
  | "message_edited" | "message_deleted";

/**
 * One line of the trail.
 *
 * A LEDGER, NOT A LIST (FR-AU-003). `seq` counts from 1 with no gaps, and
 * `hash` covers this row's own contents PLUS the previous row's hash — so
 * quietly editing or removing a line breaks every hash after it, and a missing
 * line shows up as a hole in the numbering. Both are cheap to add now and
 * impossible to add honestly later, because a chain can only be built forwards.
 *
 * HONEST LIMIT (the same one Buzz states about theirs): this is tamper-EVIDENT,
 * not tamper-PROOF. Someone who can write to the database file can rebuild the
 * whole chain. It catches corruption and casual editing, not an attacker with
 * the file in their hands.
 */
export interface ActivityRecord {
  id: ID;
  ts: number;
  actorKind: "human" | "agent" | "system";
  actorId: ID;
  actorName: string;
  kind: ActivityKind;
  refId?: ID;              // message/task/approval/agent/channel id
  detail: string;          // plain-language summary (FR-AU-003)
  /** position in the chain, from 1, no gaps (absent on rows written before the ledger) */
  seq?: number;
  /** the previous row's hash — "" for the very first row */
  prevHash?: string;
  /** hex sha256 over this row's fields and `prevHash` */
  hash?: string;
}

// ---------- harness sign-in (docs/plans/harness-signin.md) ----------

/**
 * How this harness's turns get paid for.
 *
 * "cli-login" is the PRIMARY path (feedback-round-1.md): the locally installed
 * app is already signed in and owns its own credential. Cloud9 spawns it and
 * never sees, captures or stores a token. "token"/"apiKey" are the fallbacks
 * for a machine where the app itself isn't signed in.
 */
export type HarnessAuthKind = "cli-login" | "token" | "apiKey" | "none";

/** One selectable model, with the name a person reads and the id we store. */
export interface ModelChoice {
  id: string;
  label: string;
}

/**
 * What the app knows about one locally installed AI harness.
 * STATUS ONLY — booleans and display strings. No token, key or credential
 * material may ever appear in this object (harness-signin.md decision 6).
 */
export interface HarnessInfo {
  name: HarnessName;
  /** the CLI is on this machine */
  installed: boolean;
  /** the CLI reports a logged-in account (or we hold a credential for it) */
  signedIn: boolean;
  /** display label, e.g. an email or "ChatGPT account" — never a secret */
  account?: string;
  /** which credential actually runs this harness's turns */
  authKind: HarnessAuthKind;
  /** CLI version string, for the settings card */
  version?: string;
  /** selectable model ids for this harness, may be empty when unknown */
  models: string[];
  /** the id an agent gets when the owner doesn't pick one */
  defaultModel?: string;
  /** one plain sentence, user-facing */
  detail: string;
  /** a sign-in is in progress (browser window open, waiting) */
  signingIn?: boolean;
  /** the last sign-in failure, in plain words */
  problem?: string;
}

export interface HarnessState {
  claude: HarnessInfo;
  codex: HarnessInfo;
  /** a detection round is running right now — the UI disables "Re-check" */
  checking?: boolean;
  /**
   * This engine is answering with CANNED replies, not a real AI (demo mode).
   *
   * Demo mode can only be switched on by a human who asks for it, and when it is
   * on the app must SAY SO on screen — a fake answer that looks real is worse
   * than no answer at all. The flag rides on the harness state because that is
   * the one thing every client already listens to.
   */
  demo?: boolean;
  updatedAt: number;
}

/** The plain sentence every client shows while demo mode is on. */
export const DEMO_MODE_BANNER =
  "Demo mode: these answers are made up examples, not real answers from Claude or Codex.";

/** Prefixed to every canned reply so a demo answer can never be mistaken for a real one. */
export const DEMO_REPLY_PREFIX = "[demo — not a real answer] ";

export type ChannelKind = "channel" | "dm";

export interface Channel {
  id: ID;
  name: string; // for dm: derived, e.g. "dm:<a>:<b>" — clients render the peer name
  kind: ChannelKind;
  memberIds: ID[]; // user ids and agent ids
  createdAt: number;
}

export type AuthorKind = "human" | "agent";

/**
 * One file that rode along with a message.
 *
 * The BYTES live on the machine running the hub, never in the database and
 * never on the wire twice. `storedAs` is written by the relay — a client that
 * sends one is ignored, because a path chosen by a client is a path that can
 * point anywhere.
 */
export interface Attachment {
  id: ID;
  /** the name a person sees — validated by `isSafeSkillFileName` */
  name: string;
  /** size of the stored bytes */
  size: number;
  /** what the sender said it is. Display only — never used to decide anything. */
  mime?: string;
  /** file name inside the hub's attachment folder. RELAY-OWNED. */
  storedAs: string;
  uploadedBy: ID;
  uploadedAt: number;
}

/**
 * Everyone who currently has this one emoji on a message.
 *
 * Taking a reaction back is a SOFT delete in the database (`removedAt`), not a
 * row deletion, so "who reacted and then thought better of it" is still a
 * question the record can answer. What travels on the wire is only the live
 * list, because that is all a client can draw.
 */
export interface MessageReaction {
  emoji: string;
  /** user ids, sorted, never duplicated — one person, one emoji, one vote */
  userIds: ID[];
}

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
  /**
   * The message this one answers. Threads are ONE level deep on purpose:
   * replying to a reply joins the same thread rather than starting a new one,
   * so a conversation can never become a tree nobody can read.
   */
  replyTo?: ID;
  /** set the first time the author changes the words — the "edited" marker */
  editedAt?: number;
  /**
   * A tombstone, not a hole. The row stays so the conversation still reads in
   * order and the activity trail is not lying; the words are gone.
   */
  deletedAt?: number;
  attachments?: Attachment[];
  /**
   * How many replies hang off this message. STORED on the root and kept up to
   * date as replies arrive, not counted on the way out — so a channel list can
   * say "12 replies" without walking the conversation. (Buzz's
   * `thread_metadata.reply_count`, and it is why theirs is cheap.)
   */
  replyCount?: number;
  /** when the newest reply landed — the other half of "12 replies · 3m ago" */
  lastReplyAt?: number;
  // ---- filled in by the relay when it hands a message out, never stored ----
  /** who reacted with what */
  reactions?: MessageReaction[];
}

/** One search result, with enough around it to draw a row without asking again. */
export interface SearchHit {
  message: Message;
  channelName: string;
  channelKind: ChannelKind;
  /** the matching words in context, with `«` `»` around each hit */
  snippet: string;
}

/** Where one person has read up to in one conversation, and what is left. */
export interface UnreadEntry {
  channelId: ID;
  /** everything at or before this moment has been seen */
  lastReadTs: number;
  /** messages after it that this person did not write */
  unread: number;
  /** how many of those @mention them (or one of their agents) */
  mentions: number;
}

// ---------- WebSocket frames ----------

export type ClientFrame =
  | { type: "hello"; token: string; client: "desktop" | "mobile" | "engine" }
  | { type: "send"; channelId: ID; text: string; tempId?: string; replyTo?: ID; attachmentIds?: ID[] }
  | { type: "createChannel"; name: string; memberIds: ID[]; kind?: ChannelKind }
  | { type: "addMembers"; channelId: ID; memberIds: ID[] }
  | { type: "createAgent"; agent: Omit<AgentDef, "id" | "ownerId" | "createdAt"> }
  | { type: "updateAgent"; agent: AgentDef }
  | { type: "deleteAgent"; agentId: ID }
  | { type: "createInvite" }
  // owner only: take a person out of this Cloud9 (their agents go with them)
  | { type: "removeUser"; userId: ID }
  /**
   * Scroll back. `before`/`beforeId` are the cursor handed back by the last
   * `history` frame — send them exactly as received and never build your own,
   * because two messages can share a millisecond and the id is what breaks
   * the tie.
   */
  | { type: "history"; channelId: ID; before?: number; beforeId?: ID; limit?: number }
  /** Find words across every conversation the asker can see. */
  | { type: "search"; query: string; channelId?: ID; authorId?: ID; limit?: number }
  /** Put an emoji on a message, or take yours off. Saying it twice changes nothing. */
  | { type: "react"; messageId: ID; emoji: string; on?: boolean }
  /** Change the words of a message you wrote. */
  | { type: "editMessage"; messageId: ID; text: string }
  /** Take back a message you wrote — it becomes a tombstone, not a hole. */
  | { type: "deleteMessage"; messageId: ID }
  /** The whole of one thread: the message that started it and every reply. */
  | { type: "thread"; messageId: ID; limit?: number }
  /** Park a file on the hub. Answered with an `attachment` frame carrying its id. */
  | { type: "uploadAttachment"; channelId: ID; name: string; dataBase64: string; mime?: string }
  /** "I have read this conversation up to here" — kept on the account, not the machine. */
  | { type: "markRead"; channelId: ID; ts?: number }
  // engine-host only: post a message authored by one of the owner's agents
  | { type: "agentSend"; agentId: ID; channelId: ID; text: string; proactive?: boolean; replyTo?: ID }
  | { type: "agentStatus"; agentId: ID; status: AgentStatus }
  // v2 — tasks / approvals / activity
  // `requesterId` says WHO ASKED for this work. The engine host relays a task on
  // behalf of whoever typed "!bg …", so without it the relay would credit the
  // engine's own account (the owner) for a friend's request. Only an engine
  // connection may set it, and the relay still checks that person is real and
  // can see the channel — it is a claim, not a permission.
  | { type: "createTask"; agentId: ID; channelId: ID; title: string; requesterId?: ID; needsApproval?: boolean; action?: string }
  | { type: "updateTask"; taskId: ID; status: TaskStatus; result?: string; error?: string } // engine (agent owner) only
  | { type: "cancelTask"; taskId: ID }
  | { type: "decideApproval"; approvalId: ID; decision: "approved" | "rejected" }
  | { type: "activity"; before?: number; limit?: number }
  // harness sign-in — asked by any of the owner's clients, answered by the engine host
  //
  // `refreshHarness` is the explicit "go and look again" (it replaced the
  // implicit refresh-on-open). `harnessStatus` is the older name for the same
  // thing and still works, so an older client keeps functioning.
  | { type: "refreshHarness" }
  | { type: "harnessStatus" }
  | { type: "harnessSignIn"; harness: HarnessName }
  // "I'm not finishing that sign-in" — stops the waiting state instead of
  // leaving the user locked out of trying again (finding #10). Owner only, like
  // every other harness frame.
  | { type: "harnessCancel"; harness: HarnessName }
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
  /**
   * Where this person has read up to, per conversation — from the RELAY, so it
   * follows them between machines (absent on a relay older than this round).
   */
  unread?: UnreadEntry[];
}

export type ServerFrame =
  | { type: "welcome"; state: WorldState }
  | { type: "message"; message: Message; tempId?: string }
  | { type: "channel"; channel: Channel }
  | { type: "agent"; agent: AgentDef }
  | { type: "agentDeleted"; agentId: ID }
  | { type: "agentStatus"; agentId: ID; status: AgentStatus }
  | { type: "invite"; code: string }
  /**
   * One page of scrollback, oldest first. `hasMore` is the only honest way to
   * know whether to keep scrolling — an empty page is NOT the signal, because a
   * page can be short without being the last one.
   */
  | {
      type: "history"; channelId: ID; messages: Message[]; hasMore: boolean;
      /** feed these straight back as `before`/`beforeId` to get the next page */
      nextBefore?: number; nextBeforeId?: ID;
    }
  | { type: "searchResults"; query: string; results: SearchHit[]; hasMore: boolean }
  /** The full, current list of who reacted with this emoji. Empty means nobody does. */
  | { type: "reaction"; channelId: ID; messageId: ID; emoji: string; userIds: ID[] }
  /** A message changed — edited, deleted, or given its first attachment. */
  | { type: "messageUpdated"; message: Message }
  | { type: "thread"; parentId: ID; messages: Message[] }
  /** A parked file, ready to be named in a `send`. Goes only to the uploader. */
  | { type: "attachment"; attachment: Attachment }
  /** Read state for one conversation — sent to EVERY machine this person is on. */
  | { type: "read"; entry: UnreadEntry }
  | { type: "userJoined"; user: User }
  | { type: "userRemoved"; userId: ID }
  | { type: "token"; token: string } // durable token issued after invite redemption
  | { type: "task"; task: Task }
  | { type: "approval"; approval: Approval }
  | { type: "activity"; records: ActivityRecord[] }
  | { type: "push"; message: Message } // relay → mobile: delivered as notification
  // harness status broadcast to the owner's clients
  | { type: "harness"; state: HarnessState }
  // relay → engine host: do the harness work (the engine owns the CLIs)
  | { type: "harnessRequest"; action: "status" | "signIn" | "cancel"; harness?: HarnessName }
  | { type: "error"; error: string };

// ---------- desktop menu actions ----------
//
// ONE list, owned here, read by both halves: the Electron shell builds its menu
// from it (and refuses to start if it names anything not on this list), and the
// app screen's handler map is typed `Record<MenuAction, () => void>` so a
// missing handler is a BUILD failure, not a dead click a user finds later.
// Adding a menu item and forgetting to handle it is no longer possible.

export const MENU_ACTIONS = [
  "new-agent",
  "new-channel",
  "invite",
  "settings",
  "search",
  "toggle-theme",
  "activity",
  "tasks",
  "quick-chat",
] as const;

export type MenuAction = (typeof MENU_ACTIONS)[number];

export function isMenuAction(value: unknown): value is MenuAction {
  return typeof value === "string" && (MENU_ACTIONS as readonly string[]).includes(value);
}

// ---------- untrusted input validation ----------
//
// Agent fields are written by clients and some of them (model) end up on a
// command line. They are validated at BOTH boundaries: the relay refuses to
// store a bad one, and the engine refuses to run one. Same function, so the two
// checks can never drift apart.

/**
 * Model ids are vendor slugs — letters, digits, dot, dash, underscore.
 *
 * The FIRST character must be a letter or a digit. Round 2's version allowed a
 * leading dash, so `--yolo` was a "valid model id" and went straight onto a
 * command line as a flag (finding #21). An id can never be mistaken for a flag
 * again: a value that starts with `-` is not an id, it is an option.
 */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const AGENT_LIMITS = { name: 64, emoji: 16, persona: 8000 } as const;

/**
 * How big a message, a page of scrollback, and a reaction may be.
 *
 * `text` bounds BOTH sending and editing. Before this round `send` had no
 * bound at all, which meant "edit your message" would have been a way to put
 * an unbounded blob in the database through a path nobody had ever sized.
 */
export const MESSAGE_LIMITS = {
  text: 40_000,
  /** biggest page of scrollback the relay will hand back in one frame */
  page: 200,
  /** the page size used when a client doesn't ask for one */
  defaultPage: 50,
  /** an emoji, not an essay */
  emoji: 32,
  /** search needs at least this many characters to be worth running */
  queryMin: 2,
  queryMax: 200,
  /** results per search page */
  searchPage: 50,
} as const;

/**
 * Attachment rules. The name is checked by `isSafeSkillFileName` — the same
 * one, deliberately: a name that may become a real file in the agents folder
 * and a name that may become a real file in the attachments folder are the
 * SAME question, and asking it in two places is how the two answers drift.
 */
export const ATTACHMENT_LIMITS = {
  perMessage: 10,
  /** biggest single file the hub will accept over the socket */
  bytes: 10_000_000,
} as const;

export const SKILL_LIMITS = {
  perAgent: 20, name: 64, description: 200, instructions: 8000,
  files: 10, fileName: 128, fileText: 40_000,
} as const;

/**
 * The Claude models Cloud9 offers. Ids are NOT guessed — this is the documented
 * set from the contract (feedback-round-1.md "Model lists"), stored as ids and
 * shown by friendly name. Sonnet 5 is the default: fast and cheap for chat.
 */
export const CLAUDE_MODELS: ModelChoice[] = [
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

export const CLAUDE_DEFAULT_MODEL = "claude-sonnet-5";

/** Friendly name for a model id — falls back to the id for Codex slugs. */
export function modelLabel(id: string): string {
  return CLAUDE_MODELS.find(m => m.id === id)?.label ?? id;
}

export interface AgentInput {
  name?: string;
  emoji?: string;
  persona?: string;
  model?: string;
  provider?: string;
  skills?: unknown;
  respondTo?: unknown;
  respondToAllowlist?: unknown;
}

/** How many people one agent may be opened up to. */
export const RESPOND_TO_LIMITS = { allowlist: 50 } as const;

export interface AgentInputRules {
  /**
   * The real model list for this agent's harness. When given, a model id that
   * isn't on it is REJECTED. When the list is unknown (the engine hasn't
   * reported yet) the shape check above is still the floor — it is the
   * injection guard and never depends on knowing the list.
   */
  models?: string[];
}

/**
 * Check an agent's user-supplied fields.
 * Returns a plain-words problem description, or null when the agent is fine.
 */
export function validateAgentInput(agent: AgentInput, rules: AgentInputRules = {}): string | null {
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
  if (agent.provider !== undefined && agent.provider !== "claude" && agent.provider !== "codex") {
    return "an agent must run on either Claude or Codex";
  }
  if (agent.model !== undefined && agent.model !== "") {
    // shape first — this is the injection guard and is never skipped
    if (!MODEL_ID_RE.test(agent.model)) return "that model name isn't a valid model id";
    if (rules.models && rules.models.length > 0 && !rules.models.includes(agent.model)) {
      return "that model isn't one this app offers";
    }
  }
  const openness = validateRespondTo(agent.respondTo, agent.respondToAllowlist);
  if (openness) return openness;
  return validateSkills(agent.skills);
}

/** Check the "who may drive me" setting before it is stored. */
export function validateRespondTo(respondTo: unknown, allowlist: unknown): string | null {
  if (respondTo !== undefined
    && respondTo !== "owner" && respondTo !== "allowlist" && respondTo !== "anyone") {
    return "say who may use this agent: just you, a chosen few, or anyone in the room";
  }
  if (allowlist === undefined || allowlist === null) return null;
  if (!Array.isArray(allowlist)) return "the list of people who may use this agent must be a list";
  if (allowlist.length > RESPOND_TO_LIMITS.allowlist) {
    return `that's too many people (max ${RESPOND_TO_LIMITS.allowlist})`;
  }
  for (const id of allowlist) {
    if (typeof id !== "string" || id.length === 0 || id.length > 64) {
      return "that isn't a person";
    }
  }
  return null;
}

/** Skills are owner-written text; they are bounded so one agent can't eat the DB. */
export function validateSkills(skills: unknown): string | null {
  if (skills === undefined || skills === null) return null;
  if (!Array.isArray(skills)) return "skills must be a list";
  if (skills.length > SKILL_LIMITS.perAgent) {
    return `that's too many skills (max ${SKILL_LIMITS.perAgent})`;
  }
  for (const raw of skills) {
    if (!raw || typeof raw !== "object") return "a skill must have a name and instructions";
    const s = raw as Partial<AgentSkill>;
    if (typeof s.name !== "string" || s.name.trim().length === 0) return "every skill needs a name";
    if (s.name.length > SKILL_LIMITS.name) {
      return `a skill name is too long (max ${SKILL_LIMITS.name} characters)`;
    }
    if (typeof s.description === "string" && s.description.length > SKILL_LIMITS.description) {
      return `a skill description is too long (max ${SKILL_LIMITS.description} characters)`;
    }
    if (typeof s.instructions !== "string" || s.instructions.trim().length === 0) {
      return `skill "${s.name}" needs instructions`;
    }
    if (s.instructions.length > SKILL_LIMITS.instructions) {
      return `skill "${s.name}" is too long (max ${SKILL_LIMITS.instructions} characters)`;
    }
    const problem = validateSkillFiles(s.files, s.name);
    if (problem) return problem;
  }
  return null;
}

/**
 * Skill file names become real files in the agent's folder, so a name is
 * REFUSED (never rewritten) if it could point anywhere but that folder.
 * Same law as run.ts: allowlist, don't escape.
 */
export const SKILL_FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$/;

/**
 * Names Windows refuses to treat as ordinary files. `CON`, `NUL`, `COM1` and
 * friends are DEVICES, whatever extension you bolt on: writing "CON.md" writes
 * to the console device, not to a file. A trailing dot or space is stripped by
 * the OS, so "evil.md." and "evil.md " both land on "evil.md" — two different
 * names that become the same file (finding #20).
 *
 * The rule is the same one the whole file follows: REFUSE, never rewrite.
 */
const WINDOWS_DEVICE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * One place that decides whether a skill file name may become a real file.
 * Both the relay (before storing) and the engine (before writing) call THIS —
 * so the two checks can never drift apart.
 */
export function isSafeSkillFileName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (!SKILL_FILE_NAME_RE.test(name)) return false;
  if (name.includes("..")) return false;
  // the OS strips these, turning two names into one file
  if (/[. ]$/.test(name)) return false;
  // device names, with or without an extension: CON, con.md, COM1.txt
  const stem = name.split(".")[0].trim().toUpperCase();
  if (WINDOWS_DEVICE_NAMES.has(stem)) return false;
  return true;
}

function validateSkillFiles(files: unknown, skillName?: string): string | null {
  if (files === undefined || files === null) return null;
  if (!Array.isArray(files)) return "skill files must be a list";
  if (files.length > SKILL_LIMITS.files) {
    return `that's too many files on skill "${skillName}" (max ${SKILL_LIMITS.files})`;
  }
  for (const raw of files) {
    if (!raw || typeof raw !== "object") return "a skill file needs a name and some text";
    const f = raw as Partial<AgentSkillFile>;
    if (!isSafeSkillFileName(f.name)) {
      return "that file name isn't allowed — use plain letters, numbers, dots and dashes";
    }
    if (typeof f.text !== "string") return `file "${f.name}" has no text`;
    if (f.text.length > SKILL_LIMITS.fileText) {
      return `file "${f.name}" is too big (max ${SKILL_LIMITS.fileText} characters)`;
    }
  }
  return null;
}

/**
 * Check the words of a message (sent or edited).
 * Returns a plain-words problem, or null when it is fine.
 */
export function validateMessageText(text: unknown, allowEmpty = false): string | null {
  if (typeof text !== "string") return "a message needs some words";
  if (!allowEmpty && text.trim().length === 0) return "a message needs some words";
  if (text.length > MESSAGE_LIMITS.text) {
    return `that message is too long (max ${MESSAGE_LIMITS.text} characters)`;
  }
  return null;
}

/**
 * Check an emoji before it becomes a reaction.
 *
 * A reaction is a short label drawn next to a message, so anything with a line
 * break or a tab in it is not an emoji — it is someone trying to draw
 * something else. Refused, never trimmed into shape.
 */
export function validateReactionEmoji(emoji: unknown): string | null {
  if (typeof emoji !== "string" || emoji.length === 0) return "pick an emoji";
  if (emoji.length > MESSAGE_LIMITS.emoji) return "that's not an emoji";
  // whitespace and control characters are not emoji — refused, never trimmed into shape
  if (/[\s\u0000-\u001f\u007f]/.test(emoji)) return "that's not an emoji";
  return null;
}

/**
 * Check an attachment's name and size.
 *
 * The name question is delegated to `isSafeSkillFileName` on purpose — see
 * ATTACHMENT_LIMITS. There is no second copy of that rule anywhere.
 */
export function validateAttachment(name: unknown, size: number): string | null {
  if (!isSafeSkillFileName(name)) {
    return "that file name isn't allowed — use plain letters, numbers, dots and dashes";
  }
  if (!Number.isFinite(size) || size <= 0) return "that file is empty";
  if (size > ATTACHMENT_LIMITS.bytes) {
    return `that file is too big (max ${Math.floor(ATTACHMENT_LIMITS.bytes / 1_000_000)} MB)`;
  }
  return null;
}

/** A harness we know nothing about yet — used before the first detection run. */
export function unknownHarness(name: HarnessName): HarnessInfo {
  return {
    name, installed: false, signedIn: false, authKind: "none",
    models: [], detail: "checking…",
  };
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

/**
 * An id for ORDINARY things — messages, channels, agents, activity rows.
 *
 * `Math.random()` is not a random-number generator you can bet a lock on: it is
 * fast and predictable by design. So this function is for names, never for
 * keys. Anything that GRANTS ACCESS (an invite code, a sign-in token) must come
 * from `secureId`/`secureToken` in the relay, which uses the OS's cryptographic
 * randomness. The two are deliberately different functions so the choice is
 * visible at every call site (finding #2).
 */
export function newId(prefix: string): ID {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
