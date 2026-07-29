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
  // owner only: take a person out of this Cloud9 (their agents go with them)
  | { type: "removeUser"; userId: ID }
  | { type: "history"; channelId: ID; before?: number; limit?: number }
  // engine-host only: post a message authored by one of the owner's agents
  | { type: "agentSend"; agentId: ID; channelId: ID; text: string; proactive?: boolean }
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
}

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
  return validateSkills(agent.skills);
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
