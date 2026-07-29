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
  /**
   * WHAT ACTUALLY HAPPENED when this job ran (FR-TL-003).
   *
   * This one field is what turns "the job finished" into "here is what it did":
   * hand it to `runDetail` and you get the steps, the time and the money behind
   * the result. Written by the hub from the run record's own `taskId` — never
   * from anything a client claimed — and absent until a run has been recorded,
   * which is also the honest answer for every task from before this existed.
   */
  runId?: string;
  createdAt: number;
  updatedAt: number;
}

// ---------- what an agent actually DID: the run record ----------
//
// THESE ARE WIRE TYPES AND THEY LIVE HERE. They were written in the engine
// first (that was the only file its author owned), but the engine writes a run
// record, the relay stores one, and the screen draws one — three programs, one
// shape. A second definition anywhere is how the three quietly stop agreeing.
//
// THE HONESTY RULE travels with them: nothing here is ever invented, estimated
// or inferred. If a CLI did not report a duration, a cost or an exit code, the
// field is ABSENT — never zero, never "about". A row whose value is absent must
// not be drawn at all.

/**
 * The kinds of thing an agent does, in words a non-developer reads. Both CLIs
 * map onto this list; anything we do not recognise becomes "tool" with the
 * tool's own name as the label, so a new tool shows up as a real step rather
 * than disappearing.
 */
export type RunStepKind =
  | "command"   // ran something on this computer
  | "read"      // opened a file
  | "write"     // wrote or changed a file
  | "search"    // searched files on this computer
  | "web"       // searched or fetched something online
  | "tool"      // used some other tool
  | "thinking"  // reasoning the CLI reported
  | "message"   // said something
  | "note";     // the CLI told us something about itself (incl. a REFUSED tool)

export interface RunStep {
  /** order within the run, from 1 */
  seq: number;
  kind: RunStepKind;
  /** short human label — "Read note.txt", "Ran a command" */
  label: string;
  /** the specific thing acted on. Redacted before it is ever shared. */
  detail?: string;
  /** true/false ONLY when the CLI reported an outcome. Absent = it did not. */
  ok?: boolean;
}

/** Token and money figures, each present only if the CLI reported it. */
export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  /** the CLI's own cost figure. Codex does not report one; Claude does. */
  costUsd?: number;
}

export type RunOutcome = "ok" | "failed" | "cancelled";
export type RunKind = "chat" | "task" | "schedule";

/** One agent turn or one delegated job, start to finish. */
export interface RunRecord {
  /** "r-<time>-<noise>" — sorts by time, and is safe as a file name */
  id: string;
  /** chat reply, delegated job, or scheduled check-in */
  kind: RunKind;
  agentId: ID;
  agentName: string;
  /** which app ran it: claude, codex, mock … */
  provider: string;
  /** the model we ASKED for */
  model?: string;
  /** the model the CLI reported using. Claude only. */
  actualModel?: string;
  channelId?: ID;
  taskId?: ID;
  /** who asked — the person's name, not an id, so the record reads on its own */
  requestedBy: string;
  requestedByKind: "human" | "agent" | "schedule";
  /** what they asked for, trimmed */
  ask: string;
  startedAt: number;
  finishedAt: number;
  /** measured by Cloud9 around the call. Always present. */
  durationMs: number;
  /** claimed by the CLI. Claude only. */
  cliDurationMs?: number;
  outcome: RunOutcome;
  /** plain-words failure, already redacted. Absent on a clean run. */
  error?: string;
  steps: RunStep[];
  usage?: RunUsage;
  /** the CLI's own conversation id */
  sessionId?: string;
  /** Claude only */
  numTurns?: number;
  /** how long the reply was — the reply TEXT is not copied into the record */
  replyChars: number;
  /** JSON events we understood in the CLI's stream */
  events: number;
  /** steps were dropped to keep this record small */
  truncated?: boolean;
}

/** A run as it appears in a list, without loading every step. */
export interface RunListEntry {
  id: string;
  kind: RunKind;
  outcome: RunOutcome;
  startedAt: number;
  durationMs: number;
  ask: string;
  /** the plain-words line, rebuilt from the record it came from */
  summary: string;
}

// -------------------------------------------------------------------- limits
//
// A run record must never be able to grow without bound: a runaway agent that
// reads ten thousand files would otherwise fill the owner's disk — and then the
// hub's database — with the proof of it. Caps live here, in one place, and the
// engine, the relay and the screen all read THESE.

export const RUN_LIMITS = {
  /** steps kept per run; the rest are counted and dropped */
  steps: 200,
  label: 120,
  detail: 300,
  ask: 500,
  error: 300,
  /** a single stream line longer than this is skipped, not parsed */
  line: 256 * 1024,
} as const;

/**
 * How many runs the hub keeps, and how big one may be once it is stored.
 *
 * The engine keeps its own copy on disk under the same rules
 * (`RUN_STORE_DEFAULTS`); this is the hub's half of the same promise, because a
 * record that is bounded on the machine that made it and unbounded on the
 * machine that shares it is not bounded at all.
 */
export const RUN_RETENTION = {
  /** runs kept per agent on the hub; the oldest go first */
  perAgent: 50,
  /** biggest single stored record — steps are dropped to fit */
  bytes: 64 * 1024,
  /** most rows one `runList` may hand back */
  listPage: 50,
  /** the page size used when a client doesn't ask for one */
  listDefault: 20,
} as const;

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
  // §7: a room is a thing that can change, so every change to it is an action
  | "channel_updated" | "channel_archived" | "member_removed" | "member_role_changed"
  // FR-CM-009: changing or withdrawing something already said is an ACTION, and
  // the trail has to keep it — otherwise "delete" quietly means "rewrite history"
  | "message_edited" | "message_deleted"
  // FR-TL-003: an agent took a turn and we wrote down what it did. This is the
  // row the Activity panel was always missing — until now it could say an agent
  // spoke, but never what the agent DID to be able to say it.
  | "run_recorded";

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

/**
 * Who may CHANGE a conversation, as opposed to who may talk in it.
 *
 * - `owner` — made it (or was handed it). May do everything, including hand
 *   out roles.
 * - `admin` — may set the topic and description, invite and remove people,
 *   change visibility and archive. May not change roles.
 * - `member` — may read and talk. THE DEFAULT, and the default when a row
 *   predates roles, because a membership from before this rule existed must
 *   not be more powerful than one made after it.
 */
export type ChannelRole = "owner" | "admin" | "member";

/**
 * Can this conversation be found and joined by someone who isn't in it?
 *
 * ABSENT MEANS `private`, which is exactly today's behaviour — every room that
 * existed before this field stays shut. Opening a room is a typed-out choice,
 * never something that happens by omission.
 */
export type ChannelVisibility = "open" | "private";

/**
 * One person's (or one agent's) place in one conversation — A ROW, NOT AN ID
 * IN A LIST.
 *
 * An array of ids can only answer "who is in here right now". It cannot say
 * when someone joined, who let them in, what they may change, or that they
 * left — so "who was in the room when this was said" was an unanswerable
 * question. This row answers all four.
 *
 * `removedAt` is a SOFT delete, like a reaction: the row stays so the record
 * still knows the person was once here. Only rows with no `removedAt` are
 * "in the room".
 */
export interface ChannelMember {
  channelId: ID;
  /** a user id or an agent id — the same union `memberIds` always carried */
  memberId: ID;
  role: ChannelRole;
  joinedAt: number;
  /** who added them; absent when they joined an open room themselves */
  invitedBy?: ID;
  /** when they left or were taken out; absent means they are still in */
  removedAt?: number;
  removedBy?: ID;
}

/** May this role change the conversation itself (topic, people, archive)? */
export function mayAdministerChannel(role: ChannelRole | undefined): boolean {
  return role === "owner" || role === "admin";
}

export interface Channel {
  id: ID;
  name: string; // for dm: derived, e.g. "dm:<a>:<b>" — clients render the peer name
  kind: ChannelKind;
  /**
   * Who is in this conversation right now.
   *
   * DERIVED, not stored: the relay builds it from the membership rows on the
   * way out. It stays on the wire so no existing client breaks, and it is the
   * field to retire once every screen reads `channelMembers` instead.
   */
  memberIds: ID[]; // user ids and agent ids
  createdAt: number;
  /** what this room is for — set once and left alone */
  description?: string;
  /** what it is about TODAY — the line that changes */
  topic?: string;
  topicSetBy?: ID;
  topicSetAt?: number;
  /** absent means "private", i.e. exactly how every room behaved before this */
  visibility?: ChannelVisibility;
  /** retired, not deleted: still readable, nothing new can be said in it */
  archivedAt?: number;
  archivedBy?: ID;
}

/**
 * A room you are NOT in, as seen from outside: enough to decide whether to
 * join, and nothing more. Never carries members or messages — being able to
 * FIND a room is not permission to read it.
 */
export interface ChannelSummary {
  id: ID;
  name: string;
  description?: string;
  topic?: string;
  memberCount: number;
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
  // ---- channels as real things (docs/plans/chat-basics-handoff.md §7) ----
  /** Set what a room is for and what it is about. Absent field = leave alone. */
  | { type: "setChannelInfo"; channelId: ID; description?: string; topic?: string }
  /** Open a room to browse-and-join, or shut it again. */
  | { type: "setChannelVisibility"; channelId: ID; visibility: ChannelVisibility }
  /** Retire a room (or bring it back). Archived is READ-ONLY, never deleted. */
  | { type: "archiveChannel"; channelId: ID; archived: boolean }
  /** The open rooms you are not in — name and description only, never contents. */
  | { type: "browseChannels" }
  /** Let yourself into an open room. */
  | { type: "joinChannel"; channelId: ID }
  /** Take yourself out of a room. */
  | { type: "leaveChannel"; channelId: ID }
  /** Take someone else out of a room. Needs `owner` or `admin`. */
  | { type: "removeMember"; channelId: ID; memberId: ID }
  /** Hand out (or take back) the power to change a room. Needs `owner`. */
  | { type: "setMemberRole"; channelId: ID; memberId: ID; role: ChannelRole }
  /**
   * Who is in this room, with roles and dates — and, with `at`, who was in it
   * at that moment. That last one is the honest answer to "who could see this
   * message when it was said".
   */
  | { type: "channelMembers"; channelId: ID; at?: number }
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
  /**
   * Ask for permission to fetch one attached file's bytes.
   *
   * The answer is a ONE-USE, SHORT-LIVED ticket for that one file. It is asked
   * for over this already-authenticated socket, so there is no second way to
   * sign in and no durable secret ever goes near a URL. See
   * `ATTACHMENT_TICKET` and the `attachmentTicket` server frame.
   */
  | { type: "attachmentTicket"; attachmentId: ID }
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
  // ---- what an agent actually did (FR-TL-003) ----
  /**
   * ENGINE-HOST ONLY: one turn finished, here is what it did.
   *
   * The engine sends `shareableRun(record)`, never the raw one. The hub then
   * decides everything that matters about it from STORED state — whose agent
   * this is, and which conversation it happened in — because a record is a
   * report, not a permission. It is scrubbed again on the way out.
   */
  | { type: "runRecorded"; record: RunRecord }
  /**
   * "What has this agent been doing?" (`agentId`, owner only), or "what did
   * this job actually do?" (`taskId`, anyone who can see the conversation).
   * Naming neither is an error — a list with no scope is a list of everything.
   */
  | { type: "runList"; agentId?: ID; taskId?: ID; limit?: number }
  /** One run, in full. The id is enough: who may see it is read from the record. */
  | { type: "runDetail"; runId: string }
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
  /**
   * Permission to fetch ONE file, ONCE, for a few seconds. Goes only to the
   * socket that asked. `url` is relative to the hub's own address — join it to
   * the same origin the WebSocket is on and `GET` it; the ticket dies the
   * moment the first byte is served, and again when `expiresAt` passes.
   */
  | {
      type: "attachmentTicket"; attachmentId: ID; ticket: string;
      /** e.g. "/attachment/<ticket>" */
      url: string;
      expiresAt: number;
      /** the file this ticket is for, so a client can draw it without asking again */
      attachment: Attachment;
    }
  /** A room you are not in, as seen from outside. Answers `browseChannels`. */
  | { type: "channelDirectory"; channels: ChannelSummary[] }
  /** Who is (or was) in one room. Answers `channelMembers`. */
  | { type: "channelMembers"; channelId: ID; at?: number; members: ChannelMember[] }
  /** You are no longer in this room — drop it, and everything you cached for it. */
  | { type: "channelLeft"; channelId: ID }
  /** Read state for one conversation — sent to EVERY machine this person is on. */
  | { type: "read"; entry: UnreadEntry }
  | { type: "userJoined"; user: User }
  | { type: "userRemoved"; userId: ID }
  | { type: "token"; token: string } // durable token issued after invite redemption
  | { type: "task"; task: Task }
  | { type: "approval"; approval: Approval }
  | { type: "activity"; records: ActivityRecord[] }
  /**
   * One run — pushed the moment it finishes to everyone who can see the
   * conversation it happened in, and sent back on its own to whoever asked for
   * it by id. Always the redacted version.
   */
  | { type: "run"; record: RunRecord }
  /** Answers `runList`. Echoes back which question it is answering. */
  | { type: "runs"; agentId?: ID; taskId?: ID; runs: RunListEntry[] }
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

/**
 * How long a ticket to fetch one file is good for, and how many a person may
 * be holding at once.
 *
 * THE WHOLE POINT IS THAT A LEAKED ONE IS WORTHLESS. Thirty seconds is long
 * enough to click a link and short enough that a ticket copied out of a log
 * line, a proxy trace or a screen recording has already expired — and it can
 * only ever have been worth ONE file anyway, because the ticket is consumed by
 * the first byte served.
 */
export const ATTACHMENT_TICKET = {
  /** milliseconds a ticket stays good for */
  ttlMs: 30_000,
  /** most unspent tickets one person may hold — stops a bulk mint */
  perUser: 32,
  /** the path a ticket is redeemed at, relative to the hub's own address */
  path: "/attachment/",
} as const;

/**
 * How long a room's own words may be.
 * Bounded for the same reason a message is: an unbounded field is a way to put
 * a blob in the database through a path nobody sized.
 */
export const CHANNEL_LIMITS = { description: 500, topic: 200 } as const;

/** Check a room's description or topic before it is stored. */
export function validateChannelText(value: unknown, what: "description" | "topic"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return `that ${what} isn't text`;
  const max = what === "topic" ? CHANNEL_LIMITS.topic : CHANNEL_LIMITS.description;
  if (value.length > max) return `that ${what} is too long (max ${max} characters)`;
  // a topic is one line drawn in a header; a newline in it is someone drawing
  // something else. Refused, never trimmed into shape (same law as an emoji).
  if (what === "topic" && /[\r\n]/.test(value)) return "a topic is one line";
  return null;
}

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

/**
 * The only kinds of file the hub will ever hand back with a type a browser
 * will RENDER. Everything else is served as a download and nothing more.
 *
 * WHY AN ALLOWLIST AND NOT THE UPLOADER'S `mime`: the `mime` on an attachment
 * is what the sender SAID it was — it is display text, and the type comment on
 * `Attachment` already says it is never used to decide anything. If the hub
 * echoed it back as `Content-Type`, anyone who could attach a file could
 * choose how the app treats it, and "here is a picture" would be a way to run
 * a page inside the app. So the type is decided HERE, from the extension of
 * the already-validated name, and anything not on this list is handed over as
 * bytes with a download prompt.
 *
 * There is deliberately no `image/svg+xml`: an SVG is a document that can
 * carry script, not a picture.
 */
const INLINE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  json: "text/plain; charset=utf-8",
  pdf: "application/pdf",
};

/** The bytes-only type: "I am not telling you this is safe to render." */
export const DOWNLOAD_FALLBACK_TYPE = "application/octet-stream";

/**
 * What `Content-Type` the hub serves this file as — computed from the name it
 * validated, never from anything the sender claimed.
 */
export function downloadContentType(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return DOWNLOAD_FALLBACK_TYPE;
  return INLINE_TYPES[name.slice(dot + 1).toLowerCase()] ?? DOWNLOAD_FALLBACK_TYPE;
}

/** May a client show this file in place, or must it be saved first? */
export function isInlineViewable(name: string): boolean {
  return downloadContentType(name) !== DOWNLOAD_FALLBACK_TYPE;
}

/** A harness we know nothing about yet — used before the first detection run. */
export function unknownHarness(name: HarnessName): HarnessInfo {
  return {
    name, installed: false, signedIn: false, authKind: "none",
    models: [], detail: "checking…",
  };
}

// ---------- what may leave this machine ----------
//
// ONE OWNER FOR THE REDACTION RULE, and it lives here because two different
// programs now need it: the engine, which writes a run record full of Windows
// paths and argv, and the relay, which hands that record to somebody else.
// A copy on each side is a rule with two versions, and the guest gets whichever
// one was forgotten.
//
// `sanitizeForChat` (in the engine) is the other half of the same law: it
// answers "may this raw error text be shown?" with a flat no, because an error
// is an unbounded string from someone else's code. This function answers the
// narrower question — "which PARTS of this may be shown?" — for text we DO want
// to show. Neither is ever bypassed; where more is needed, it is added here.

/**
 * Credential variables we know by name and always remove.
 * Kept explicit as well as pattern-matched: names we have actually seen in the
 * wild are documented here, and the pattern below catches the rest.
 */
export const CREDENTIAL_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

/**
 * The shape of a secret's NAME. A deny-list of known variables only ever
 * protects against the secrets we thought of; this catches the class.
 */
const SECRET_NAME_RE = /(API[_-]?KEY|ACCESS[_-]?KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|_TOKEN$|^TOKEN$|AUTH_TOKEN|SESSION_KEY|PRIVATE_KEY)/i;

/** Is this variable name credential-shaped? Exported so tests can pin the rule. */
export function isCredentialVar(name: string): boolean {
  if ((CREDENTIAL_ENV_VARS as readonly string[]).includes(name)) return true;
  return SECRET_NAME_RE.test(name);
}

/**
 * The names that identify THIS computer and the person sitting at it.
 *
 * This file is imported by a browser bundle as well as by two Node programs, so
 * it cannot read `os` itself. Instead every Node process that redacts installs
 * its own machine's names once, at startup — the engine host and the relay both
 * do. A process that never installs any still gets rules 1, 2 and 4; it simply
 * has no personal names to blank, which is the honest behaviour rather than a
 * silent half-redaction.
 */
let machineNames: string[] = [];

/**
 * Tell the redactor what this machine is called. Longest first, so
 * "vikasmit" is blanked before a shorter fragment of it can be.
 * Names under three characters are dropped — blanking "am" would shred prose.
 */
export function setMachineNames(names: (string | undefined)[]): void {
  const out = new Set<string>();
  for (const value of names) {
    if (!value) continue;
    for (const part of value.split(/[\\/]/)) if (part.length >= 3) out.add(part);
  }
  // drive letters and generic folders are not identifying — do not blank them
  for (const generic of ["Users", "home", "AppData", "Local", "Roaming", "var", "tmp"]) {
    out.delete(generic);
  }
  machineNames = [...out].sort((a, b) => b.length - a.length);
}

/** What the redactor is currently blanking. Exported so tests can pin it. */
export function knownMachineNames(): string[] {
  return [...machineNames];
}

/**
 * Given text we DO want to show — a command an agent ran, a file it opened, a
 * failure it hit — return the version that may leave this machine.
 *
 * What is removed, in order:
 *  1. anything that looks like a secret's value (KEY=… , sk-… , long blobs);
 *  2. every absolute path, Windows or POSIX or UNC, cut down to its last
 *     segment — "note.txt", never "C:\Users\vikasmit\…\note.txt";
 *  3. this machine's home folder and account name, wherever they appear;
 *  4. environment-variable assignments of any kind.
 * Web addresses are protected and passed through unchanged: a URL is the thing
 * the owner most wants to see, and it says nothing about this computer.
 */
export function redactForSharing(text: string, max = 300): string {
  if (!text) return "";
  const urls: string[] = [];
  let out = text
    // protect web addresses before any path rule can chew on them
    .replace(/https?:\/\/[^\s"'<>|]+/g, m => `\u0000${urls.push(m) - 1}\u0000`);

  // 1. secret VALUES — the name may stay, so the owner can see what was set
  out = out.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/g,
    (whole, name: string) => (isCredentialVar(name) ? `${name}=***` : whole));
  out = out.replace(/\b(?:sk|pk|ghp|gho|github_pat)[-_][A-Za-z0-9_-]{6,}/gi, "***");
  out = out.replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, "***");

  // 2. absolute paths → their last segment only.
  //
  // ORDER MATTERS, and it cost us a live run to learn it. Codex reports the
  // command it ran with its backslashes doubled, so "C:\\WINDOWS\\…\\foo.exe"
  // arrives with real double separators. With the UNC rule first, the "\\WINDOWS"
  // part was eaten as if it were a network share and the drive letter was left
  // stranded — "C:powershell.exe". Nothing leaked, but it read like a bug
  // because it was one. The drive-letter rule now goes first and takes the whole
  // path, and the UNC rule only fires at the START of a token.
  out = out.replace(/\b[A-Za-z]:[\\/][^\s"'|;&]*/g, m => lastSegment(m));   // C:\… , C:/…
  out = out.replace(/(^|[\s"'(=,])\\\\[^\s"'|;&]+/g,                        // \\server\share\…
    (m, lead: string) => `${lead}${lastSegment(m)}`);
  out = out.replace(/(^|[\s"'(=,])\/(?:home|Users|root|mnt|opt|srv|var|etc|tmp|private)\/[^\s"'|;&]*/g,
    (m, lead: string) => `${lead}${lastSegment(m)}`);

  // 3. this machine's own names, wherever they still appear
  for (const secret of machineNames) {
    if (secret.length < 3) continue;
    out = out.split(secret).join("someone");
    const lower = secret.toLowerCase();
    if (lower !== secret) out = out.split(lower).join("someone");
  }

  // 4. put the web addresses back
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => urls[Number(i)] ?? "");

  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

function lastSegment(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

/**
 * The version of a record that may be shown in chat, sent to a client, or read
 * by a guest. Every free-text field goes through `redactForSharing`.
 *
 * This is deliberately a SEPARATE object rather than a flag on the record: the
 * raw record on disk keeps the owner's own detail, and the only way to get a
 * shareable one is to call this. There is no path that shares the raw record by
 * forgetting to set something — and because it is applied AGAIN on the way out
 * of the hub, a record put there by an older or broken engine is still scrubbed
 * before it reaches anybody.
 */
export function shareableRun(record: RunRecord): RunRecord {
  return {
    ...record,
    ask: redactForSharing(record.ask, RUN_LIMITS.ask),
    ...(record.error ? { error: redactForSharing(record.error, RUN_LIMITS.error) } : {}),
    steps: (record.steps ?? []).map(s => ({
      ...s,
      label: redactForSharing(s.label, RUN_LIMITS.label),
      ...(s.detail ? { detail: redactForSharing(s.detail, RUN_LIMITS.detail) } : {}),
    })),
  };
}

// ---------- reading a run in plain words ----------

export interface RunCounts {
  command: number; read: number; write: number; search: number;
  web: number; tool: number; message: number;
}

/** Count the steps by kind. Nothing is inferred — a kind we did not see is 0. */
export function countSteps(steps: RunStep[]): RunCounts {
  const counts: RunCounts = { command: 0, read: 0, write: 0, search: 0, web: 0, tool: 0, message: 0 };
  for (const s of steps ?? []) {
    if (s.kind in counts) counts[s.kind as keyof RunCounts]++;
  }
  return counts;
}

/**
 * One short line a non-developer can read: "checked 4 sites, wrote 1 file, took
 * 41 seconds". Every clause is derived from a step that was actually recorded —
 * there is no sentence in here that can appear without evidence behind it.
 *
 * It lives in shared because the SCREEN shows it verbatim and the hub puts it
 * in a list row; both must say the same words about the same run.
 */
export function summarizeRun(record: RunRecord): string {
  const c = countSteps(record.steps);
  const parts: string[] = [];
  if (c.web) parts.push(plural(c.web, "checked 1 site", `checked ${c.web} sites`));
  if (c.search) parts.push(plural(c.search, "ran 1 search", `ran ${c.search} searches`));
  if (c.read) parts.push(plural(c.read, "read 1 file", `read ${c.read} files`));
  if (c.write) parts.push(plural(c.write, "wrote 1 file", `wrote ${c.write} files`));
  if (c.command) parts.push(plural(c.command, "ran 1 command", `ran ${c.command} commands`));
  if (c.tool) parts.push(plural(c.tool, "used 1 other tool", `used ${c.tool} other tools`));

  const time = `took ${humanDuration(record.durationMs)}`;
  const money = typeof record.usage?.costUsd === "number"
    ? `, cost ${humanMoney(record.usage.costUsd)}` : "";

  if (record.outcome === "cancelled") {
    return parts.length
      ? `Stopped after ${parts.join(", ")} — ${time}${money}.`
      : `Stopped before it got started — ${time}.`;
  }
  if (record.outcome === "failed") {
    const why = record.error ? ` — ${record.error}` : "";
    return parts.length
      ? `Didn't finish. Got as far as ${parts.join(", ")}, ${time}${money}.${why}`
      : `Didn't finish, ${time}${money}.${why}`;
  }
  if (parts.length === 0) {
    return `Answered straight from what it knew — no tools used, ${time}${money}.`;
  }
  return `${capitalise(parts.join(", "))}, ${time}${money}.`;
}

/** A list row for one record — the same words the card shows, in one line. */
export function runListEntry(record: RunRecord): RunListEntry {
  return {
    id: record.id,
    kind: record.kind,
    outcome: record.outcome,
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    ask: record.ask,
    summary: summarizeRun(record),
  };
}

/** "41 seconds", "2 minutes 5 seconds", "under a second" — no decimals, no jargon. */
export function humanDuration(ms: number): string {
  if (ms < 1000) return "under a second";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} second${total === 1 ? "" : "s"}`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  const m = `${mins} minute${mins === 1 ? "" : "s"}`;
  return secs ? `${m} ${secs} second${secs === 1 ? "" : "s"}` : m;
}

/** Money as the owner would say it. Under a dollar reads in cents. */
export function humanMoney(usd: number): string {
  if (usd < 0.01) return "less than a cent";
  if (usd < 1) return `${Math.round(usd * 100)} cents`;
  return `$${usd.toFixed(2)}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- a run record that arrived from somewhere else ----------

/**
 * Check a run record before it is stored.
 *
 * A record arrives over the wire from the engine host, so it is UNTRUSTED
 * INPUT exactly like an agent definition is: same law, same shape of answer —
 * a plain-words problem, or null when it is fine. The relay refuses a bad one
 * rather than putting it in the database and discovering the problem when a
 * screen tries to draw it.
 *
 * The id is checked with `isSafeSkillFileName` on purpose. A run id becomes a
 * real file name in the engine's own folder, and asking that question in two
 * places with two answers is how the two drift.
 */
export function validateRunRecord(record: unknown): string | null {
  if (!record || typeof record !== "object") return "that isn't a run record";
  const r = record as Partial<RunRecord>;
  if (!isSafeSkillFileName(typeof r.id === "string" ? `${r.id}.json` : undefined)) {
    return "that run id isn't usable";
  }
  if (r.kind !== "chat" && r.kind !== "task" && r.kind !== "schedule") {
    return "a run is a chat reply, a job or a scheduled check-in";
  }
  if (r.outcome !== "ok" && r.outcome !== "failed" && r.outcome !== "cancelled") {
    return "a run either worked, failed or was stopped";
  }
  if (typeof r.agentId !== "string" || r.agentId.length === 0 || r.agentId.length > 64) {
    return "a run belongs to an agent";
  }
  for (const [what, value, max] of [
    ["agent name", r.agentName, AGENT_LIMITS.name],
    ["app name", r.provider, 64],
    ["ask", r.ask, RUN_LIMITS.ask],
    ["requester", r.requestedBy, AGENT_LIMITS.name],
  ] as const) {
    if (typeof value !== "string") return `a run record needs a ${what}`;
    if (value.length > max) return `that ${what} is too long`;
  }
  for (const [what, value] of [
    ["start time", r.startedAt], ["finish time", r.finishedAt],
    ["duration", r.durationMs], ["reply length", r.replyChars], ["event count", r.events],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value)) return `that ${what} isn't a number`;
  }
  if (!Array.isArray(r.steps)) return "a run record needs a list of steps";
  if (r.steps.length > RUN_LIMITS.steps) return "that run has too many steps";
  for (const s of r.steps) {
    if (!s || typeof s !== "object") return "that isn't a step";
    if (typeof s.label !== "string" || s.label.length > RUN_LIMITS.label) {
      return "a step's label is too long";
    }
    if (s.detail !== undefined
      && (typeof s.detail !== "string" || s.detail.length > RUN_LIMITS.detail)) {
      return "a step's detail is too long";
    }
  }
  return null;
}

/**
 * Bring a record under a size cap by dropping steps from the MIDDLE — the first
 * few steps and the last few are what a person reads. The record then SAYS it
 * was truncated, so nobody mistakes a trimmed run for a short one.
 *
 * One implementation, two callers: the engine measures against the indented
 * JSON it writes to disk, the relay against the compact JSON it puts in a
 * database row — so the serializer is handed in rather than assumed. Measuring
 * one shape and storing another is how a cap quietly stops capping.
 */
export function fitRunRecord(
  record: RunRecord,
  maxBytes: number,
  serialize: (r: RunRecord) => string = r => JSON.stringify(r),
): RunRecord {
  let out = record;
  while (serialize(out).length > maxBytes && out.steps.length > 2) {
    const half = Math.max(1, Math.floor(out.steps.length / 2));
    out = {
      ...out,
      steps: [...out.steps.slice(0, half - 1), ...out.steps.slice(half + 1)],
      truncated: true,
    };
  }
  if (serialize(out).length > maxBytes) {
    out = { ...out, steps: [], truncated: true, ask: out.ask.slice(0, RUN_LIMITS.ask) };
  }
  return out;
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
