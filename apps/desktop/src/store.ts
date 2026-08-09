// Renderer-side relay client: one WebSocket, one mutable world, subscribers.
import { useCallback, useRef, useSyncExternalStore } from "react";
import {
  ActivityRecord, AgentDef, AgentPresenceState, AgentStatus, Approval, ARTIFACT_LIMITS, Artifact, ArtifactAccess,
  ArtifactRelationView, ArtifactVersion, ArtifactWorkspaceEntry,
  Attachment, ATTACHMENT_LIMITS, Channel,
  ChannelMember, ChannelSummary, ClientFrame, HarnessState, ID, isInlineViewable, Message,
  MemoryNote,
  NotificationInboxEntry,
  SavedMessageEntry,
  EverywhereHit, SearchKind,
  ReachCatchup,
  Project, ForumTopic, ForumReply, ForumReadEntry, ForumLink, ForumStatus, ProjectItem, ProjectPollView, PublicUpdateDraft, PublicUpdateRevision, PublicUpdateAudit, RepoChoice, RunListEntry, RunRecord, SearchHit, ServerFrame, Task, StoredHook, HookAuditEntry,
  EngineeringCanvasView, EngineeringCanvasRevision, CanvasBlockKind, CanvasLink,
  EngineeringPulseUpdate, EngineeringPulseDraft, EngineeringPulseProject, validateEngineeringPulseDraft,
  Workflow, WorkflowRun,
  HuddleSession, HuddleNote, HuddleReadEntry, HuddleParticipant, HuddleNoteKind, HuddleLink,
  SocialLink, SocialPost,
  // SPENDING BLOCK (what the crew costs, 2026-08-07)
  AgentTokenUse, WasteFinding,
  UnreadEntry, User,
  effectiveArtifactAccess, latestVersion,
  validateAttachment, validateLocalFolder, validateMessageText, validateProjectText, validateRepo,
  validateSocialLinks, validateSocialText,
  // Joining a friend's Cloud9 — the address, the address book, the connection
  // lifecycle. All three are the shared modules the handoff says to build ON,
  // never reimplement (docs/plans/join-hub-handoff.md).
  HubAddress, HubReach, KnownHub, HubBook, ConnState, DEFAULT_HUB_PORT,
  parseHubAddress, hubWebSocketUrl, reachInWords,
  selfOnlyBook, activeHub, addHub as addHubToBook, removeHub as removeHubFromBook,
  renameHub as renameHubInBook, switchTo, reconcile,
  initialConn, reduceConn, connInWords,
} from "@cloud9/shared";
// Semantic receipts live in their own tiny ephemeral store, on purpose — see
// the header of that file. This is the only line of this module that knows.
import { noteReceipt } from "./receipts.js";
// …and so do live steps, for the same reasons, in their own file.
import { clearLiveSteps, noteLiveSteps } from "./livesteps.js";

type WorkflowRequestFrame = Extract<ClientFrame, {
  type: "listWorkflows" | "createWorkflow" | "updateWorkflow" | "archiveWorkflow" | "runWorkflow" | "stopWorkflow" | "retryWorkflow"
}>;

/** Match relay's updatedAt/id ordering for both snapshots and live receipts. */
function workflowOrder(a: Workflow, b: Workflow): number {
  return (b.updatedAt - a.updatedAt) || b.id.localeCompare(a.id);
}

type SavedRequestFrame = Extract<ClientFrame, {
  type: "listSaved" | "saveMessage" | "unsaveMessage"
}>;

/**
 * Pull a join token (`join_…`) off the end of a pasted link, however it was
 * attached, leaving the bare address for `parseHubAddress`. An `inv_…` code is
 * NOT split here — `parseHubAddress` already understands those; only a join
 * token is a credential the address parser was never taught, so it would choke
 * on the fragment if it were left on.
 */
export function splitJoinLink(raw: string): { address: string; joinToken?: string } {
  const text = typeof raw === "string" ? raw.trim() : "";
  const m = text.match(/[#?/](?:token=)?(join_[A-Za-z0-9_-]+)\s*$/);
  if (m && m.index !== undefined) return { address: text.slice(0, m.index).trim(), joinToken: m[1] };
  return { address: text };
}

/**
 * Where scrollback has got to in ONE conversation.
 *
 * The cursor is a PAIR and it is the relay's, never ours: two messages can land
 * in the same millisecond, and the id is what breaks the tie. `hasMore` is the
 * only honest end-of-history signal — a short page is not the end.
 */
export interface Page {
  hasMore: boolean;
  nextBefore?: number;
  nextBeforeId?: ID;
  /** a page is in flight — stops the scroll handler asking for it twice */
  loading: boolean;
  /** we have asked for this conversation at least once, so `hasMore` means something */
  asked: boolean;
}

export interface SearchState {
  query: string;
  running: boolean;
  results: SearchHit[];
  hasMore: boolean;
  /** the query the results on screen actually belong to */
  answered: string;
}

/**
 * THE ONE "SEARCH EVERYWHERE" ON SCREEN — chat, thread replies, file names and
 * the words inside every readable version, older ones included.
 *
 * It is a SEPARATE piece of state from `search` on purpose. `search` is the
 * message-only question that also takes `in:`/`from:`, and the two answers have
 * different shapes; merging them would mean one of the two renderers guessing
 * which sort of row it had. One question, one state, one renderer.
 *
 * `answered` is the query the rows on screen really belong to — without it a
 * result list read as an answer to whatever is in the box RIGHT NOW, which is
 * how "nothing found" got printed under a query still being typed. `problem`
 * holds the hub's own refusal sentence, shown as-is and never re-spelled here.
 */
export interface EverywhereState {
  query: string;
  kind?: SearchKind;
  running: boolean;
  results: EverywhereHit[];
  hasMore: boolean;
  /** the query the rows on screen actually belong to; "" until one lands */
  answered: string;
  /** the hub's refusal, in the hub's own words */
  problem?: string;
}

/**
 * One file on its way from this machine to the hub.
 *
 * It is held per CONVERSATION, because that is where the person can see it:
 * a file picked in #trip must not turn up attached to a message in #general
 * just because the reader changed rooms while it was going up.
 */
export interface Upload {
  /** ours, for the life of this screen — the hub's id only exists once it lands */
  localId: string;
  name: string;
  size: number;
  state: "sending" | "done" | "failed";
  /** the hub's own sentence when it refused, never a paraphrase */
  error?: string;
  /** what to name in `send` once it is up */
  attachmentId?: ID;
}

/**
 * An attached file this screen has opened.
 *
 * `url` is a `blob:` we made and therefore must revoke (see `closeFile`),
 * unless `direct` is set — which only SAVING does, because a download is a
 * navigation to a one-use hub URL rather than a copy this app is holding, and
 * there is nothing of ours to free.
 */
export interface OpenFile {
  state: "opening" | "ready" | "failed";
  url?: string;
  direct?: boolean;
  error?: string;
  /**
   * The bytes read back as words, and ONLY when the thing that stored them said
   * they were text — which for an artifact is the HUB's answer about the bytes
   * (`ArtifactVersion.text`), never a guess made from the file's name here. A
   * screen may draw this; nothing else may.
   */
  text?: string;
}

/**
 * One answer to "what has this agent — or this job — been doing".
 *
 * `asked` is what tells an empty history from an unanswered one. Without it a
 * rail would say "nothing yet" the instant it opened, which is a claim nobody
 * has checked. Same law as the room directory above.
 */
export interface RunList {
  asked: boolean;
  loading: boolean;
  entries: RunListEntry[];
}

/**
 * One bounded answer to "which files can I read across this Cloud9?"
 *
 * `asked` separates a real empty list from a question nobody has asked.
 * `loading` covers both the first page and an older page. `checkedAt` belongs
 * to the hub answer (or the refusal), so the screen never labels stale rows as
 * current without saying when they were last checked.
 */
export interface ArtifactWorkspacePage extends Page {
  entries: ArtifactWorkspaceEntry[];
  /** How many rows the pages explicitly opened; live pushes may not grow past it. */
  capacity: number;
  checkedAt?: number;
  problem?: string;
}

export interface PulseState {
  asked: boolean;
  loading: boolean;
  updates: EngineeringPulseUpdate[];
  unreadByProject: Record<ID, number>;
  projects: EngineeringPulseProject[];
  projectId?: ID;
  /** The one list request whose correlated answer may replace this view. */
  requestId?: ID;
  /** Exact mutation acknowledged by the relay; peer pushes never set this. */
  mutationSuccessId?: ID;
  problem?: string;
}

const emptyArtifactWorkspace = (loading = false): ArtifactWorkspacePage => ({
  asked: false, loading, entries: [], hasMore: true,
  capacity: ARTIFACT_LIMITS.workspaceDefault,
});

export interface ArtifactAccessSaveState {
  artifactId: ID;
  requestId: ID;
  state: "pending" | "succeeded" | "refused" | "lost";
  /** uncorrelated same-file pushes observed while the save stayed pending */
  pushesWhilePending: number;
  problem?: string;
}

export interface World {
  connected: boolean;
  authFailed: boolean;
  me?: User;
  users: User[];
  agents: AgentDef[];
  channels: Channel[];
  messages: Record<ID, Message[]>; // by channel
  agentStatus: Record<ID, AgentStatus>;
  /**
   * CAN THIS AGENT ACTUALLY BE USED RIGHT NOW — the hub's answer, never ours.
   *
   * ABSENT IS A REAL ANSWER AND IT IS NOT "FINE". A missing entry means nobody
   * has reported on that agent yet, which is why this is a sparse map rather
   * than a map with a cheerful default: the screen has to be able to tell "we
   * have not looked" apart from "it is ready", and a default would erase the
   * difference at the only place it matters.
   */
  presence: Record<ID, AgentPresenceState>;
  inviteCode?: string;
  /**
   * A freshly minted join link, waiting for the screen to wrap it into a
   * `cloud9://…` a friend can paste. Cleared when the "Invite a friend" panel
   * closes. The code alone is enough to become a member, so it is never logged.
   */
  joinToken?: { code: string; expiresInMs: number; ts: number };
  /** Every Cloud9 this person knows — their own (self) and any friends' added. */
  hubs: KnownHub[];
  /** Which known hub the client is connected to (or falling back from) right now. */
  activeHubId: string;
  /** Where the live connection stands, in one plain sentence (`connInWords`). */
  hubConn: { phase: ConnState["phase"]; line: string };
  tasks: Task[];
  approvals: Approval[];
  workflows: Workflow[];
  workflowRuns: WorkflowRun[];
  workflowLoading: boolean;
  workflowError?: { text: string; ts: number; requestId?: ID };
  workflowNotice?: { text: string; ts: number; workflowId?: ID };
  workflowRetry?: WorkflowRequestFrame;
  activity: ActivityRecord[];
  /** Durable mention and thread-reply rows for this account. */
  notifications: NotificationInboxEntry[];
  notificationsAsked: boolean;
  notificationsLoading: boolean;
  /** The exact inbox request whose answer may replace this list. */
  notificationsRequestId?: ID;
  /** Refusal/loss for that request only; unrelated errors must not stop loading. */
  notificationsProblem?: string;
  /** Durable saved-message queue, independent from read/unread state. */
  savedMessages: SavedMessageEntry[];
  savedLoading: boolean;
  savedAsked: boolean;
  savedRequestId?: ID;
  savedRevision: number;
  savedHasMore: boolean;
  savedNextSavedAt?: number;
  savedNextMessageId?: ID;
  savedProblem?: string;
  savedNotice?: { text: string; ts: number; requestId?: ID; messageId?: ID };
  savedPending: ID[];
  /** Set when a save arrives while the Saved screen is not open. */
  savedNew: boolean;
  /** status of the local Claude/Codex apps — booleans and labels, never secrets */
  harness?: HarnessState;
  /**
   * The last thing the relay refused, so a failed save is never silent.
   *
   * `keptSignedIn` is set when the refusal was a SIGN-IN attempt that failed
   * while a credential that already worked was left untouched — the screen then
   * says so, because "that invite has already been used" on its own reads like
   * you have just been thrown out of your own Cloud9.
   */
  lastError?: { text: string; ts: number; keptSignedIn?: boolean };
  /**
   * The last channel the relay handed us. Asking for a direct conversation is
   * answered with one of these — whether it made a new one or found the old
   * one — so the UI can open exactly what it was given instead of guessing.
   */
  lastChannel?: { id: ID; ts: number };
  /** how far back each conversation has been read, by channel */
  pages: Record<ID, Page>;
  /** one thread's messages, keyed by the id of the message that started it */
  threads: Record<ID, Message[]>;
  /**
   * Where this person has read up to, per conversation — from the RELAY, so it
   * follows them between machines. There is no browser copy of this any more.
   */
  unread: Record<ID, UnreadEntry>;
  /**
   * WHAT THE HUB CHANGED ABOUT HIS AGENTS BEFORE HE ARRIVED — the receipt for
   * the one-time catch-up, from the welcome frame, and only ever sent to the
   * person whose agents they are. Absent means nothing was changed.
   */
  reachCatchup?: ReachCatchup;
  /** the one search running or last answered */
  search?: SearchState;
  /** the one "search everywhere" running or last answered */
  everywhere?: EverywhereState;
  /**
   * Bumped every time a page of OLDER messages was put on the front of a
   * conversation. The message list watches this to keep the reader's place:
   * prepending changes `scrollHeight`, and without this the view would jump.
   */
  prepended: number;
  /** files being sent up from this machine, by conversation */
  uploads: Record<ID, Upload[]>;
  /** attached files this screen has opened, by attachment id */
  files: Record<ID, OpenFile>;
  /**
   * The open rooms you are NOT in — the answer to "Browse rooms".
   *
   * `asked` is what tells an empty list from an unanswered one: without it the
   * browser would say "no open rooms" the instant it opened, which is a claim
   * nobody has checked yet.
   */
  directory: { asked: boolean; channels: ChannelSummary[] };
  /** who is in one room, with roles and dates, by conversation */
  members: Record<ID, ChannelMember[]>;
  /**
   * WHAT AN AGENT ACTUALLY DID, by run id.
   *
   * Keyed by the record's own id and nothing else, because a `run` frame
   * arrives UNASKED the moment any turn finishes — in a conversation this
   * screen has open, or one it does not. Anything that wants to find a run by
   * job or by agent looks it up through the indexes below, which are built off
   * what arrived rather than off what we happened to request.
   */
  runs: Record<string, RunRecord>;
  /** histories, keyed by `runKey` — "agent:<id>" or "task:<id>" */
  runLists: Record<string, RunList>;
  /**
   * WHAT HIS CREW HAS COST HIM THIS MONTH, as the hub last added it up.
   *
   * `asked: false` and no rows is "we have never looked", which is why the
   * screen says "working it out" rather than "nothing to show" the first time
   * it opens — those are different answers and a person can tell.
   */
  spending: {
    asked: boolean;
    loading: boolean;
    /** when the hub added it up; absent until it has */
    at?: number;
    rows: { use: AgentTokenUse; findings: WasteFinding[] }[];
  };
  /**
   * Runs the hub has said are not there.
   *
   * A run you may not read and a run that never existed get the SAME sentence,
   * deliberately, so an id cannot be probed. Both mean one thing to a screen —
   * it is not there — and saying so is better than a disclosure that spins for
   * ever waiting for an answer that already came.
   */
  runsGone: Record<string, true>;
  /**
   * THE REPOSITORIES THIS PERSON HAS CONNECTED, and what is open in each.
   *
   * `asked` is the same law the room directory and the run histories already
   * follow: an empty list nobody has requested is not "you have no projects",
   * it is "we have not looked". Without it the Projects screen would greet a
   * person with "connect your first repository" for the moment between opening
   * and the hub answering — a claim nobody had checked, about the one screen
   * whose whole job is to say what GitHub holds.
   */
  projects: { asked: boolean; list: Project[] };
  /**
   * One project's pull requests and issues, by project id.
   *
   * A CACHE OF SOMEBODY ELSE'S TRUTH twice over: the hub holds GitHub's answer
   * as of the last time the engine looked, and this holds the hub's. So the
   * screen never says "no open pull requests" off the back of an unanswered
   * question — `asked` is what tells the two apart, and `Project.syncedAt` is
   * what says how old the answer is.
   */
  projectItems: Record<ID, { asked: boolean; items: ProjectItem[] }>;
  /** Poll list is tied to both its active project and its latest request. */
  polls: { asked: boolean; projectId?: ID; requestId?: ID; list: ProjectPollView[] };
  canvases: { asked: boolean; projectId?: ID; requestId?: ID; mutationRequestId?: ID; historyAsked?: boolean; historyRequestId?: ID; historyCanvasId?: ID; historyLoading?: boolean; historyProblem?: string; list: EngineeringCanvasView[]; history: EngineeringCanvasRevision[]; problem?: string };
  publicUpdates: {
    asked: boolean;
    drafts: PublicUpdateDraft[];
    selected?: PublicUpdateDraft;
    revisions: PublicUpdateRevision[];
    audit: PublicUpdateAudit[];
    /** Set after a successful publish so the screen can show the public link. */
    lastPublished?: { draftId: ID; token: string; publicPath: string };
  };
  forumProjects: { asked: boolean; projects: Project[]; requestId?: ID };
  forumFeeds: Record<ID, { asked: boolean; loading: boolean; topics: ForumTopic[]; unread: number; selected?: ID; problem?: string; requestId?: ID }>;
  forumTopicRequests: Record<ID, ID>;
  forumReplies: Record<ID, ForumReply[]>;
  forumUnavailableProjects: Record<ID, true>;
  forumMutations: Record<ID, { kind: ClientFrame["type"]; projectId?: ID; topicId?: ID; state: "pending" | "succeeded" | "refused" | "lost"; problem?: string; draft?: { title?: string; body?: string; reply?: string; tags?: string; links?: string; summary?: string } }>;
  forumMembersByProject: Record<ID, ID[]>;

  huddles: { asked: boolean; sessions: HuddleSession[] };
  huddleProjects: { asked: boolean; list: Project[] };
  huddleMutations: Record<ID, { kind: ClientFrame["type"]; state: "pending" | "succeeded" | "refused" | "lost"; problem?: string }>;
  huddleNotes: Record<ID, HuddleNote[]>;
  huddleNavigation?: HuddleLink;
  hooks: { asked: boolean; requestId?: ID; mutationRequestId?: ID; pending?: Record<ID, true>; auditRequestId?: ID; auditAsked?: boolean; auditLoading?: boolean; audit?: HookAuditEntry[]; auditProblem?: string; list: StoredHook[]; problem?: string; test?: { hookId: ID; ok: boolean; said: string } };
  socialProjects: { asked: boolean; list: Project[]; requestId?: ID };
  /** Unread counts for every member project, not just the currently open feed. */
  socialUnread: Record<ID, number>;
  socialPending: Record<ID, true>;
  socialCompleted?: ID;
  socialProblem?: string;
  /** Project-scoped social feeds, loaded only when the Social screen asks. */
  socialFeeds: Record<ID, {
    asked: boolean; loading: boolean; posts: SocialPost[]; hasMore: boolean;
    nextBefore?: number; nextBeforeId?: ID; unread: number; problem?: string; requestId?: ID;
  }>;
  pulse: PulseState;
  /**
   * THE REPOSITORIES HIS OWN GITHUB SIGN-IN CAN SEE — the picker's list.
   *
   * Four states, and they are four different sentences on screen, never one:
   * nobody has asked (`asked: false`), we are asking (`asking`), GitHub
   * answered (`repos`, possibly empty — he really has none), and we could not
   * ask (`problem`). An empty list and a failed ask must never look alike:
   * "you have no repositories" is a claim, and we only make it when GitHub
   * really said so.
   *
   * `fetchedAt` is the hub's stamp, so the list can say WHEN it is from. A list
   * with no time on it is a list pretending to be current.
   */
  repoChoices: {
    asked: boolean; asking: boolean;
    repos?: RepoChoice[]; problem?: string; fetchedAt?: number;
  };
  /**
   * FILES AGENTS MADE, by artifact id.
   *
   * Keyed by the artifact's own id and nothing else, for the same reason runs
   * are: an `artifact` frame arrives UNASKED the moment any agent publishes or
   * updates a file, in a conversation this screen has open or one it does not.
   * A card drawn from a reference in a message looks the file up here by id, so
   * it does not matter which room it came from or whether anybody asked.
   *
   * WHAT IS NOT HERE: the bytes. An artifact is a name, a history and an
   * attribution; the bytes come through the same one-use ticket an attachment's
   * do, and land in `files` under the VERSION's id.
   */
  artifacts: Record<ID, Artifact>;
  /**
   * Artifacts the hub has said are not there — or are not ours to see.
   *
   * The same law the run records follow: both refusals get one sentence,
   * deliberately, so an id cannot be probed, and both mean one thing to a
   * screen. Without this a card asked for once would spin for ever on an answer
   * that had already come back as a "no".
   */
  artifactsGone: Record<ID, true>;
  /**
   * Which files are in one conversation, by channel — ids only, so there is one
   * copy of an artifact (above) and not a second one per room.
   *
   * `asked` is the same law as the room directory, the run histories and the
   * projects: an empty list nobody has requested is not "no agent has shared a
   * file here", it is "we have not looked". An `artifact` push does NOT set it —
   * one file arriving is proof of that file, never proof that we know them all.
   */
  channelArtifacts: Record<ID, { asked: boolean; ids: ID[] }>;
  /**
   * The bounded, cross-room Files index. Entries are summaries only; opening one
   * asks for the existing full artifact card and immutable history.
   */
  artifactWorkspace: ArtifactWorkspacePage;
  /** Typed outgoing and permitted incoming links, loaded with artifact detail. */
  artifactRelations: Record<ID, ArtifactRelationView[]>;
  /** Present only when the relay says the bounded detail has more safe rows. */
  artifactRelationsTruncated: Record<ID, true>;
  /** Transient detail failures are retryable and never become permanent absence. */
  artifactDetailProblems: Record<ID, string>;
  /**
   * WHAT EACH AGENT HAS SAVED TO REMEMBER, by agent id.
   *
   * `asked` is the same law the run histories and the projects follow: an empty
   * list nobody has requested is not "this agent remembers nothing", it is "we
   * have not looked". The memory panel must be able to tell those apart, so it
   * says "loading" until the engine has answered and only then the honest empty
   * state. The one durable copy lives in the engine's own store; this is the
   * hub's answer about it, refreshed whenever a note is saved or cleared.
   */
  memory: Record<ID, { asked: boolean; loading: boolean; notes: MemoryNote[] }>;
}

/** The whole hooks bag on the desktop — list, audit, pending, test, problems. */
export type HooksBag = World["hooks"];

/**
 * CLASS RULE for every hooks answer and refusal: spread the prior bag, never
 * replace it with a two-field `{ asked, list }` object. Co-asking the list and
 * the audit must leave audit, pending, and test fields intact when the list settles.
 */
export function keepHooksBag(prior: HooksBag, patch: Partial<HooksBag> & Pick<HooksBag, "asked" | "list">): HooksBag {
  return { ...prior, ...patch };
}

type Listener = () => void;

/**
 * ONE QUESTION THIS APP ASKED THE HUB, AND WHAT BECOMES OF THE ANSWER.
 *
 * `answers` recognises the reply. `answered` is what to do with it — a reply is
 * applied BY THE REQUEST THAT ASKED FOR IT, never by a handler that assumes
 * somebody must still want it. `refused` is what to do with the hub's "no".
 * `lost` is the same question with no answer at all.
 */
interface Asked {
  /** what was asked — for reading a queue in a debugger, and for the tests */
  kind: ClientFrame["type"];
  /** exact identity assigned at the one desktop send boundary */
  requestId: ID;
  /** does this frame from the hub answer THIS question? */
  answers?: (frame: ServerFrame) => boolean;
  answered?: (frame: ServerFrame) => void;
  /** the hub said no, in the hub's own words */
  refused?: (why: string) => void;
  /** nothing came back — the net under the whole thing, so a queue cannot jam */
  lost?: () => void;
}

/**
 * How long the hub gets before a question stops waiting for it.
 *
 * The hub is on this machine, over loopback, and answers a frame the moment it
 * reads it. Twenty seconds is not a guess at how long an answer takes — it is
 * long enough that anything arriving after it is certainly about something
 * else. A question that times out is TOLD (`lost`), never quietly dropped.
 */
const ANSWER_WINDOW_MS = 20_000;

/**
 * The most unread messages the hub will ever count in one conversation.
 *
 * `apps/relay/src/store.ts` — `unreadFor` reads at most this many rows, so a
 * count that reaches it means "this many or more" and NOT "exactly this many".
 * Printed as an exact number it was a claim nobody had checked; `unreadLabel`
 * below is the one place that decides how such a number is said.
 */
export const UNREAD_CEILING = 1000;

/**
 * Say a count that has a ceiling, honestly.
 *
 * Below the ceiling the number is the truth. At it, the only true thing that
 * can be said is "more than the ones we could count".
 */
export function unreadLabel(n: number): string {
  return n >= UNREAD_CEILING ? `${UNREAD_CEILING - 1}+` : String(n);
}

const params = new URLSearchParams(location.search);
export const RELAY_URL =
  params.get("relay") ?? localStorage.getItem("cloud9.relay") ?? "ws://127.0.0.1:8787";

/** Where localStorage keeps the address book of known hubs. */
const HUBBOOK_KEY = "cloud9.hubbook";

/* ================= WHERE THIS COMPUTER'S HUB KEY LIVES =================
 *
 * THE LAW: a secret never sits in plain text on the disk. Browser Local Storage
 * IS plain text on the disk — an ordinary file under %APPDATA% that any junk
 * process running as him reads. The hub key used to be written there, and that
 * key is not a chat cookie: it creates agents, and an agent is spawned with
 * folders on this computer.
 *
 * So in the Cloud9 window the key is never stored by this screen at all. The
 * shell (`preload.cjs` → the main process) hands it over in memory each launch
 * and keeps the one copy encrypted by Windows.
 *
 * IN A PLAIN BROWSER — the QA sweep, and any browser pointed at a hub — there
 * IS no shell to keep it, so Local Storage stays the only place there is. That
 * path is unchanged and it is written down rather than implied: a browser has
 * no OS keychain a web page may reach. What makes it acceptable is that it is
 * not the path he uses; his Cloud9 is the window, and the window no longer
 * writes anything.
 */
interface HubSignInBridge {
  token(): string | null;
  remember(token: string): Promise<{ ok: boolean; error?: string }>;
  forget(): Promise<{ ok: boolean; error?: string }>;
}

function hubSignIn(): HubSignInBridge | undefined {
  const bridge = (globalThis as unknown as { cloud9?: { hubSignIn?: HubSignInBridge } }).cloud9;
  return bridge?.hubSignIn;
}

/**
 * This launch's key, once the shell has handed it over. Memory only — declaring
 * it here rather than reading storage is what makes "the window keeps no
 * secret" a property of the code and not a habit.
 */
let sessionToken: string | null = null;

/**
 * This computer's own hub, as a checked address — the floor every install has.
 * Derived from the loopback URL the shell handed the screen, so "self" is
 * always exactly the hub the app runs for itself.
 */
export function selfAddress(): HubAddress {
  const parsed = parseHubAddress(RELAY_URL);
  if (parsed.ok) return parsed.address;
  return { host: "127.0.0.1", port: DEFAULT_HUB_PORT, reach: "thisPc" };
}

/** Load and repair the saved book; a fresh install starts with self only. */
function loadHubBook(): HubBook {
  let raw: unknown;
  try {
    const s = localStorage.getItem(HUBBOOK_KEY);
    if (s) raw = JSON.parse(s);
  } catch { /* unreadable — reconcile falls back to self only */ }
  return reconcile(raw, selfAddress());
}

/**
 * v1 kept the Claude credential in localStorage. That was wrong, and simply
 * removing the code that writes it does not remove the copy already sitting in
 * an existing install's browser storage — so wipe it, unconditionally, on every
 * start. Listed by name (not by pattern) so the session token survives.
 */
const LEGACY_SECRET_KEYS = ["cloud9.claudeCred", "cloud9.claudeCredKind"];

/**
 * The hub key, which USED to be exempt from the purge above — and that
 * exemption was the bug. It is a secret like any other: it creates agents, and
 * an agent is spawned with folders on this computer. In the Cloud9 window the
 * shell now keeps it, encrypted by the OS, so the copy sitting in this browser's
 * storage from every previous run is pure liability and goes on the next start.
 *
 * It is purged ONLY where there is a shell to keep the key instead. A plain
 * browser has nowhere else to put it, and wiping it there would sign the person
 * out with nothing to sign back in with.
 */
const SHELL_HELD_SECRET_KEYS = ["cloud9.token"];

/**
 * State that used to live in this browser and now lives on the account.
 *
 * `cloud9.lastRead` was read state kept per MACHINE: read a room on the laptop
 * and the phone still showed it bold. The relay owns it now, so the old copy is
 * not just unused — it is a second, disagreeing answer, and it goes.
 */
const LEGACY_LOCAL_STATE_KEYS = ["cloud9.lastRead"];

export function purgeLegacySecrets(): void {
  try {
    for (const key of LEGACY_LOCAL_STATE_KEYS) {
      if (localStorage.getItem(key) !== null) {
        localStorage.removeItem(key);
        console.warn(`[cloud9] removed machine-only read state (${key}) — the relay keeps it now`);
      }
    }
    for (const key of LEGACY_SECRET_KEYS) {
      if (localStorage.getItem(key) !== null) {
        localStorage.removeItem(key);
        console.warn(`[cloud9] removed an old credential (${key}) from browser storage`);
      }
    }
    // The hub key, where the shell holds it instead. Anything already in
    // storage is carried over to the shell FIRST, so a person who was signed in
    // stays signed in — then the plaintext copy goes.
    const bridge = hubSignIn();
    if (bridge) {
      for (const key of SHELL_HELD_SECRET_KEYS) {
        const stale = localStorage.getItem(key);
        if (stale === null) continue;
        if (!bridge.token()) {
          sessionToken = stale;
          void bridge.remember(stale).catch(() => { /* asked again next launch */ });
        }
        localStorage.removeItem(key);
        console.warn(
          `[cloud9] moved the hub sign-in (${key}) out of browser storage — ` +
          "this computer keeps it encrypted now");
      }
    }
  } catch { /* storage unavailable — nothing to purge */ }
}

export class RelayClient {
  world: World = {
    connected: false, authFailed: false, users: [], agents: [], channels: [],
    messages: {}, agentStatus: {}, presence: {}, tasks: [], approvals: [], activity: [],
    notifications: [], notificationsAsked: false, notificationsLoading: false,
    notificationsRequestId: undefined, notificationsProblem: undefined,
    workflows: [], workflowRuns: [], workflowLoading: false,
    savedMessages: [], savedLoading: false, savedAsked: false,
    savedRequestId: undefined, savedProblem: undefined, savedNotice: undefined,
    savedRevision: 0, savedHasMore: false, savedPending: [], savedNew: false,
    pages: {}, threads: {}, unread: {}, prepended: 0,
    uploads: {}, files: {}, directory: { asked: false, channels: [] }, members: {},
    runs: {}, runLists: {}, runsGone: {},
    // SPENDING BLOCK (2026-08-07): never looked yet — see the note on the field
    spending: { asked: false, loading: false, rows: [] },
    projects: { asked: false, list: [] }, projectItems: {}, publicUpdates: { asked: false, drafts: [], revisions: [], audit: [] }, polls: { asked: false, list: [] }, canvases: { asked: false, list: [], history: [] },
    forumProjects: { asked: false, projects: [] }, forumFeeds: {}, forumTopicRequests: {}, forumReplies: {}, forumUnavailableProjects: {}, forumMutations: {}, forumMembersByProject: {},

    huddles: { asked: false, sessions: [] }, huddleProjects: { asked: false, list: [] }, huddleMutations: {}, huddleNotes: {}, huddleNavigation: undefined,
    hooks: { asked: false, list: [] },
    socialProjects: { asked: false, list: [] }, socialUnread: {}, socialPending: {}, socialCompleted: undefined, socialFeeds: {},
    pulse: { asked: false, loading: false, updates: [], unreadByProject: {}, projects: [] },
    repoChoices: { asked: false, asking: false },
    artifacts: {}, artifactsGone: {}, channelArtifacts: {},
    artifactWorkspace: emptyArtifactWorkspace(),
    artifactRelations: {}, artifactRelationsTruncated: {}, artifactDetailProblems: {},
    memory: {},
    hubs: [], activeHubId: "self", hubConn: { phase: "idle", line: "" },
  };
  private ws?: WebSocket;
  /** Frames from a socket that has been replaced never reach the new world. */
  private socketEpoch = 0;
  private listeners = new Set<Listener>();
  private snapshotCache: World = { ...this.world };

  /* ---------------- which hub, and how the connection to it is going ----------------
   *
   * `hubaddress.ts` says whether an address is dialable; `hubbook.ts` remembers
   * the hubs and which is active; `hubconnection.ts` is the reducer that decides
   * dial / retry / FALL BACK TO SELF. This client OWNS the socket and the timer
   * and does nothing but carry out the effects those pure modules hand back —
   * it never re-decides a backoff or a fallback here.
   */
  private book: HubBook = loadHubBook();
  private conn: ConnState = initialConn("self", true);
  private retryTimer?: ReturnType<typeof setTimeout>;
  /** The url the live socket is on — so file downloads follow the active hub. */
  private currentUrl: string = RELAY_URL;
  /**
   * The credential this session is TRYING on this computer's own hub.
   *
   * Unproven until the hub answers `welcome`. It is deliberately NOT the stored
   * credential: a newly typed owner key or a pasted invite has to be the thing
   * we say `hello` with, and the stored one has to survive it failing.
   */
  private selfHello = "";
  /**
   * A durable credential the hub minted for THIS attempt, held until `welcome`
   * proves the attempt actually worked. Never written to storage from here.
   */
  private issued?: string;
  /** One automatic fall-back per refused attempt — never a loop of them. */
  private recovering = false;

  constructor() {
    this.syncHubWorld();
    this.snapshotCache = { ...this.world };
  }

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): World => this.snapshotCache;

  private emit(): void {
    this.snapshotCache = { ...this.world };
    for (const fn of this.listeners) fn();
  }

  /** Mirror the book + connection sentence into the world so the screen updates. */
  private syncHubWorld(): void {
    const hub = activeHub(this.book);
    this.world.hubs = this.book.hubs;
    this.world.activeHubId = this.book.activeId;
    this.world.hubConn = { phase: this.conn.phase, line: connInWords(this.conn, hub.label) };
  }

  private saveBook(): void {
    try { localStorage.setItem(HUBBOOK_KEY, JSON.stringify(this.book)); } catch { /* storage full — the book stays in memory */ }
  }

  /**
   * Sign into THIS computer's own hub. Kept as the public entry the app has
   * always called (`connect(token)`); it always lands you on self, because your
   * own Cloud9 is the floor you can never be locked out of. Friends' hubs are
   * reached with `switchHub`, not this.
   */
  connect(token: string): void {
    this.selfHello = token;
    const sw = switchTo(this.book, "self");
    if (sw.ok) this.book = sw.book;
    this.saveBook();
    this.connectActive();
  }

  /** Dial whichever hub is active, from a clean slate. */
  private connectActive(): void {
    const hub = activeHub(this.book);
    this.conn = initialConn(hub.id, hub.isSelf);
    // a fresh attempt starts clean: last attempt's refusal belonged to it, and
    // so did any credential the last hub minted for it — an unproven one is
    // never carried into a different attempt
    this.issued = undefined;
    this.recovering = false;
    this.world.authFailed = false;
    this.world.lastError = undefined;
    // questions asked of the last connection will never be answered by this one
    const orphaned = this.asked;
    this.asked = [];
      this.loseForumRequests();
    for (const a of orphaned) a.lost?.();
    this.syncHubWorld();
    this.emit();
    this.dialActive();
  }

  /** The url to dial for a hub — loopback for self, the checked address for a friend. */
  private urlFor(hub: KnownHub): string {
    return hub.isSelf ? RELAY_URL : hubWebSocketUrl(hub.address);
  }

  private dialActive(): void {
    const hub = activeHub(this.book);
    const url = this.urlFor(hub);
    this.currentUrl = url;
    this.applyConn(reduceConn(this.conn, { t: "dialed", url }));
  }

  /**
   * Carry out ONE reducer transition: set the new state and perform the single
   * effect the pure module returned. This is the only place a socket is opened,
   * a backoff timer is started, or a fallback is triggered.
   */
  private applyConn(next: { state: ConnState; effect: ReturnType<typeof reduceConn>["effect"] }): void {
    this.conn = next.state;
    this.syncHubWorld();
    this.emit();
    const e = next.effect;
    if (e.do === "openSocket") {
      this.openSocketTo(e.url);
    } else if (e.do === "waitThenRetry") {
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => {
        this.conn = reduceConn(this.conn, { t: "timerFired" }).state;
        this.dialActive();
      }, e.ms);
    } else if (e.do === "fallBackToSelf") {
      // The friend's hub would not answer. Drop to this computer's own so the
      // person is never locked out — the whole point of "self is the floor".
      const sw = switchTo(this.book, "self");
      if (sw.ok) { this.book = sw.book; this.saveBook(); }
      this.conn = reduceConn(this.conn, { t: "switched", targetId: "self", targetIsSelf: true }).state;
      this.world.lastError = {
        text: `${activeHub(this.book).label === "This computer" ? "That Cloud9" : "Your friend's Cloud9"} couldn't be reached — you're back on this computer's Cloud9.`,
        ts: Date.now(),
      };
      this.syncHubWorld();
      this.emit();
      this.dialActive();
    }
  }

  private openSocketTo(url: string): void {
    // Public activity belongs to one live socket epoch. A reconnect has no
    // authority to keep showing a previous engine's in-flight preview.
    clearLiveSteps();
    this.ws?.close();
    const epoch = ++this.socketEpoch;
    const ws = new WebSocket(url);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.helloForActive();
      this.applyConn(reduceConn(this.conn, { t: "opened" }));
    };
    ws.onclose = () => {
      // A newer socket has already taken over (a switch or a retry) — this close
      // belongs to a connection nobody is on any more.
      if (this.ws !== ws) return;
      clearLiveSteps();
      this.world.connected = false;
      // Settle every lifecycle row before dropping request maps. Mutation
      // callbacks clear their own pending IDs and leave a scoped retry notice;
      // simply clearing the maps used to lose that intent silently.
      const orphaned = this.asked;
      this.asked = [];
      for (const a of orphaned) a.lost?.();
      // Request ids belong to this socket epoch. A late workflow response from
      // the dropped socket must never settle a new window's run/archive/stop
      // request after reconnect; those mutations are durable and the welcome
      // snapshot is the source of truth for the next epoch.
      this.workflowRequests.clear();
      this.savedRequests.clear();
      this.pulseMutationRequestId = undefined;
      this.pulseAcceptedRequestId = undefined;
      this.pulseReadRequests.clear();
      // Do not present a disconnected copy as the current queue. Welcome
      // seeds this again, and SavedScreen will ask for the canonical list.
      this.world.savedMessages = [];
      this.world.savedAsked = false;
      this.world.savedLoading = false;
      this.world.savedRequestId = undefined;
      this.world.savedRevision = 0;
      this.world.savedHasMore = false;
      this.world.savedNextSavedAt = undefined;
      this.world.savedNextMessageId = undefined;
      // lost callbacks above own pending cleanup; this fallback only covers a
      // fire-and-forget row that never entered the lifecycle ledger.
      this.world.savedPending = this.world.savedPending.filter(messageId =>
        [...this.savedRequests.values()].some(frame => frame.type !== "listSaved" && frame.messageId === messageId));
      // A credential the hub REFUSED must not spin: the reason is on screen and
      // retrying it would only overwrite it with the same refusal.
      if (this.world.authFailed) { this.syncHubWorld(); this.emit(); return; }
      this.applyConn(reduceConn(this.conn, { t: opened ? "dropped" : "failed" }));
    };
    ws.onmessage = ev => {
      if (this.ws !== ws || this.socketEpoch !== epoch) return;
      this.onFrame(JSON.parse(ev.data) as ServerFrame);
    };
  }

  /** Prove who we are to the active hub — the right credential for THIS hub. */
  private helloForActive(): void {
    const hub = activeHub(this.book);
    if (hub.isSelf) {
      // What the person is TRYING wins over what is stored. It used to be the
      // other way round, which is why the join screen had to wipe the stored
      // credential before an attempt could even be heard — and a spent invite
      // then left nothing to go back to. Nothing is written until `welcome`.
      const t = this.selfHello || this.token();
      if (!t) { this.world.authFailed = true; this.emit(); return; }
      this.send({ type: "hello", token: t, client: "desktop" });
      return;
    }
    const durable = this.hubTokenFor(hub.id);
    if (durable) { this.send({ type: "hello", token: durable, client: "desktop" }); return; }
    const pending = this.pendingJoinFor(hub.id);
    if (pending) {
      this.send({ type: "joinWithToken", token: pending.token, displayName: pending.name });
      return;
    }
    // Nothing to authenticate with — this friend's link has no join token and we
    // were never admitted, so fall back rather than sit on a dead socket.
    this.friendJoinFailed("This Cloud9 needs a fresh join link — ask your friend for a new one.");
  }

  /** A friend's hub refused us (or we had nothing to offer): say so, drop to self. */
  private friendJoinFailed(why: string): void {
    this.world.lastError = { text: why, ts: Date.now() };
    const sw = switchTo(this.book, "self");
    if (sw.ok) { this.book = sw.book; this.saveBook(); }
    this.connectActive();
  }

  /**
   * The key for THIS computer's hub.
   *
   * In the Cloud9 window: whatever the shell handed us this launch, or what we
   * have been given since. Nothing is read from browser storage, because
   * nothing is written there. In a plain browser (QA): storage, as before.
   */
  token(): string {
    const bridge = hubSignIn();
    if (bridge) return sessionToken ?? bridge.token() ?? "";
    return localStorage.getItem("cloud9.token") ?? "";
  }
  /** Private on purpose — see `adoptCredential`, the only caller. */
  private setToken(token: string): void {
    const bridge = hubSignIn();
    if (bridge) {
      // memory for this run, and the shell keeps the only stored copy —
      // encrypted by the OS. A computer that cannot encrypt says so and simply
      // asks again next launch; it never gets a plaintext copy instead.
      sessionToken = token;
      void bridge.remember(token).then(r => {
        if (!r?.ok && r?.error) console.warn(`[cloud9] ${r.error}`);
      }).catch(() => { /* the sign-in still works for this run */ });
      return;
    }
    localStorage.setItem("cloud9.token", token);
  }

  /* ================= ADOPTING A SESSION — THE ONE OWNER =================
   *
   * NEVER DESTROY A WORKING CREDENTIAL BEFORE ITS REPLACEMENT IS PROVED.
   *
   * The join screen used to write storage itself, BEFORE the attempt: pasting
   * an invite blanked `cloud9.token` and only then asked the hub about the
   * code. A spent, mistyped or expired invite therefore cost the person the
   * sign-in they already had — recoverable for Vikas, who has the owner key,
   * and permanent for an invited friend, who has nothing else.
   *
   * So there is one owner now, and it runs at exactly one moment: `welcome`,
   * the frame that means the hub has actually let us in. Everything that can
   * fail — a refused code, a mistyped key, a hub that will not answer —
   * happens BEFORE this point and therefore cannot touch storage at all.
   */

  /** An invite code is a one-shot claim to be checked, never a credential to keep. */
  private static isClaim(t: string): boolean {
    return t.startsWith("invite:");
  }

  /**
   * The session is real: file the credential that got us in.
   *
   * A hub-issued durable token (the `token` frame, which always arrives just
   * before `welcome`) beats whatever we arrived with, because that is the thing
   * that will work next time. Called from the `welcome` case and nowhere else.
   */
  private adoptCredential(): void {
    const hub = activeHub(this.book);
    const arrivedWith = RelayClient.isClaim(this.selfHello) ? "" : this.selfHello;
    const proven = this.issued ?? (hub.isSelf ? arrivedWith : "");
    this.issued = undefined;
    this.recovering = false;
    if (!proven) return;
    if (hub.isSelf) {
      this.setToken(proven);
      // A retry of THIS session must re-send the durable token, never the
      // one-shot code that has now been spent.
      this.selfHello = proven;
    } else {
      this.setHubToken(hub.id, proven);
      this.clearPendingJoin(hub.id);
    }
  }

  /**
   * A refused sign-in must not cost you the one you already had.
   *
   * If what was just refused is NOT what is in storage — a spent invite typed
   * over a working session, a mistyped owner key — then the stored credential
   * was never tested and is still good, so we go straight back in on it and the
   * screen says what happened. Returns true when that fall-back is under way.
   */
  private recoverPreviousCredential(refusal: string): boolean {
    const kept = this.token();
    if (!kept || kept === this.selfHello || this.recovering) return false;
    const say = { text: refusal, ts: Date.now(), keptSignedIn: true };
    this.connect(kept);        // clears the last attempt's state and dials again
    this.recovering = true;    // ...one fall-back only, so a dead key cannot spin
    this.world.lastError = say; // ...and the reason survives the fresh attempt
    this.emit();
    return true;
  }

  /* ---- per-hub credentials (a friend's durable token, and a pending join) ----
   * A friend's hub issues its OWN durable token; it must never overwrite the
   * owner key for this computer's own hub, so it is filed under the hub's id. */
  private hubTokenFor(id: string): string | null {
    try { return localStorage.getItem(`cloud9.hubToken.${id}`); } catch { return null; }
  }
  private setHubToken(id: string, t: string): void {
    try { localStorage.setItem(`cloud9.hubToken.${id}`, t); } catch { /* nothing to do */ }
  }
  private clearHubToken(id: string): void {
    try { localStorage.removeItem(`cloud9.hubToken.${id}`); } catch { /* nothing to do */ }
  }
  private pendingJoinFor(id: string): { token: string; name: string } | null {
    try { const s = localStorage.getItem(`cloud9.pendingJoin.${id}`); return s ? JSON.parse(s) : null; } catch { return null; }
  }
  private setPendingJoin(id: string, v: { token: string; name: string }): void {
    try { localStorage.setItem(`cloud9.pendingJoin.${id}`, JSON.stringify(v)); } catch { /* nothing to do */ }
  }
  private clearPendingJoin(id: string): void {
    try { localStorage.removeItem(`cloud9.pendingJoin.${id}`); } catch { /* nothing to do */ }
  }

  /* ---------------- the join screen's own methods ---------------- */

  /**
   * Check a pasted link WITHOUT saving it, so the screen can show — honestly —
   * who could reach it before the person commits. A public address is refused
   * in words here, the same as it is at add time.
   */
  previewLink(raw: string): {
    ok: boolean; reason?: string; host?: string; port?: number;
    reach?: HubReach; reachWords?: string; hasToken: boolean;
  } {
    const { address, joinToken } = splitJoinLink(raw);
    const parsed = parseHubAddress(address);
    if (!parsed.ok) return { ok: false, reason: parsed.reason, hasToken: !!joinToken };
    return {
      ok: true, host: parsed.address.host, port: parsed.address.port,
      reach: parsed.address.reach, reachWords: reachInWords(parsed.address.reach),
      hasToken: !!joinToken,
    };
  }

  /**
   * Add a friend's Cloud9 to the address book from a pasted link, keeping any
   * join token as the credential for the first connection. Refuses whatever
   * `hubbook.addHub` refuses (bad address, blank/over-long name, duplicate,
   * over the ceiling) in its own words.
   */
  addHub(label: string, raw: string, myName: string): { ok: boolean; reason?: string; id?: string } {
    const { address, joinToken } = splitJoinLink(raw);
    const id = `hub_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    const res = addHubToBook(this.book, id, label, address);
    if (!res.ok) return { ok: false, reason: res.reason };
    this.book = res.book;
    if (joinToken) this.setPendingJoin(id, { token: joinToken, name: (myName || "Friend").trim() });
    this.saveBook();
    this.syncHubWorld();
    this.emit();
    return { ok: true, id };
  }

  /** Switch which Cloud9 is live and dial it. */
  switchHub(id: string): { ok: boolean; reason?: string } {
    const res = switchTo(this.book, id);
    if (!res.ok) return { ok: false, reason: res.reason };
    this.book = res.book;
    this.saveBook();
    this.connectActive();
    return { ok: true };
  }

  /** Forget a friend's hub. If it was live, drop back to this computer's own. */
  removeHub(id: string): { ok: boolean; reason?: string } {
    const wasActive = this.book.activeId === id;
    const res = removeHubFromBook(this.book, id);
    if (!res.ok) return { ok: false, reason: res.reason };
    this.book = res.book;
    this.clearHubToken(id);
    this.clearPendingJoin(id);
    this.saveBook();
    if (wasActive) this.connectActive();
    else { this.syncHubWorld(); this.emit(); }
    return { ok: true };
  }

  /** Rename a friend's hub. "This computer" keeps its name (hubbook refuses). */
  renameHub(id: string, label: string): { ok: boolean; reason?: string } {
    const res = renameHubInBook(this.book, id, label);
    if (!res.ok) return { ok: false, reason: res.reason };
    this.book = res.book;
    this.saveBook();
    this.syncHubWorld();
    this.emit();
    return { ok: true };
  }

  /** The known hubs and which is active — for the screen and the QA suite. */
  hubs(): KnownHub[] { return this.book.hubs; }
  activeHubId(): string { return this.book.activeId; }

  /** Owner action: ask the hub to mint a one-time join link. */
  requestJoinLink(): void {
    this.send({ type: "createJoinToken" });
  }
  /** Drop a minted link once the "Invite a friend" panel is closed. */
  clearJoinToken(): void {
    this.world.joinToken = undefined;
    this.emit();
  }

  /**
   * WHAT WE ASKED, IN THE ORDER WE ASKED IT.
   *
   * Only sends with an answer/refusal/lost lifecycle belong here. A fire-and-
   * forget frame has nothing to settle, so recording it would create a fake
   * queue row. It still carries an id on the wire, which lets a direct refusal
   * be shown generally without borrowing an older request's lifecycle.
   *
   * Every modern row carries the exact id assigned at the send boundary. A
   * direct refusal can therefore remove only its own refusal-capable row. A
   * legacy refusal with no id is general information only: this runtime cannot
   * create a legacy no-id row, so there is nothing safe for it to settle.
   *
   * The same list stops a LATE answer being applied to a question nobody is
   * asking any more: an answer is handed to the request that asked for it, and
   * if that request has been called off the answer goes nowhere.
   */
  private asked: Asked[] = [];
  private workflowRequests = new Map<ID, WorkflowRequestFrame>();
  private savedRequests = new Map<ID, SavedRequestFrame>();
  /** Mutation receipts currently expected; late direct frames are ignored. */
  private loseForumRequests(): void {
    const live = this.asked;
    this.asked = live.filter(entry => !entry.kind.startsWith("forum") && !entry.kind.startsWith("agentForum"));
    live.filter(entry => entry.kind.startsWith("forum") || entry.kind.startsWith("agentForum")).forEach(entry => entry.lost?.());
  }

  private socialRequests = new Set<ID>();

  private rememberSocialRequest(requestId: ID): void {
    this.socialRequests.add(requestId);
    setTimeout(() => this.socialRequests.delete(requestId), ANSWER_WINDOW_MS);
  }

  private socialMutation(frame: ClientFrame): ID | false {
    const requestId = this.nextRequestId(frame.type);
    const outgoing = { ...frame, requestId } as ClientFrame;
    const settle = (problem?: string): void => {
      this.socialRequests.delete(requestId);
      const { [requestId]: pending, ...rest } = this.world.socialPending;
      void pending;
      this.world.socialPending = rest;
      this.world.socialProblem = problem;
      this.emit();
    };
    const sent = this.transmit(outgoing, {
      refused: why => settle(why),
      lost: () => settle("the hub did not answer — your draft is still here"),
    });
    if (!sent) {
      settle("not connected to the hub yet");
      return false;
    }
    this.rememberSocialRequest(requestId);
    this.world.socialPending = { ...this.world.socialPending, [requestId]: true };
    this.world.socialCompleted = undefined;
    this.world.socialProblem = undefined;
    this.emit();
    return requestId;
  }

  private settleSocialSuccess(requestId?: ID): void {
    if (!requestId) return;
    this.socialRequests.delete(requestId);
    const { [requestId]: pending, ...rest } = this.world.socialPending;
    void pending;
    this.world.socialPending = rest;
    this.world.socialCompleted = requestId;
    this.world.socialProblem = undefined;
  }
  private pulseMutationRequestId?: ID;
  private pulseAcceptedRequestId?: ID;
  private pulseReadRequests = new Set<ID>();

  /** Give every outgoing frame one identity without changing its caller's object. */
  private identify(frame: ClientFrame): ClientFrame & { requestId: ID } {
    const requestId = typeof frame.requestId === "string" && frame.requestId.length > 0
      ? frame.requestId : this.nextRequestId(frame.type);
    return { ...frame, requestId };
  }

  /**
   * The one desktop send boundary.
   *
   * Returns the exact id put on the wire, or undefined when nothing was sent.
   * Lifecycle callers put that same id in the ledger; fire-and-forget callers
   * receive the id but create no row.
   */
  private transmit(frame: ClientFrame, waiting: Omit<Asked, "kind" | "requestId"> = {}): ID | undefined {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return undefined;
    const outgoing = this.identify(frame);
    ws.send(JSON.stringify(outgoing));
    // `hello` is the one frame asked before there is a conversation to have.
    // Its refusals are about the connection itself and are handled as such.
    if (outgoing.type === "hello") return outgoing.requestId;
    const hasLifecycle = waiting.answers !== undefined || waiting.answered !== undefined
      || waiting.refused !== undefined || waiting.lost !== undefined;
    if (!hasLifecycle) return outgoing.requestId;
    const entry: Asked = {
      kind: outgoing.type,
      requestId: outgoing.requestId,
      ...waiting,
    };
    this.asked.push(entry);
    setTimeout(() => {
      const i = this.asked.indexOf(entry);
      if (i < 0) return;
      this.asked.splice(i, 1);
      entry.lost?.();
    }, ANSWER_WINDOW_MS);
    return outgoing.requestId;
  }

  /** Ask the hub something and remember its lifecycle only when it was sent. */
  private ask(frame: ClientFrame, waiting: Omit<Asked, "kind" | "requestId"> = {}): boolean {
    return this.transmit(frame, waiting) !== undefined;
  }

  /**
   * Hand one answer to the ONE question that recognises it.
   *
   * A pushed artifact can arrive between two unrelated questions, and a late
   * timed-out answer can arrive after its replacement. Removing every earlier
   * ledger row when one later row matched silently cancelled those unrelated
   * questions and their lost callbacks. Exact answers remove only their own row;
   * unasked pushes remove nothing.
   */
  private settle(frame: ServerFrame): void {
    const i = this.asked.findIndex(a => a.answers !== undefined && a.answers(frame));
    if (i < 0) return;
    const [settled] = this.asked.splice(i, 1);
    settled.answered?.(frame);
  }

  /** Route one exact refusal without consuming any unrelated question. */
  private settleRefusal(frame: Extract<ServerFrame, { type: "error" }>): void {
    if (frame.requestId === undefined) return;
    const i = this.asked.findIndex(a =>
      a.requestId === frame.requestId && a.refused !== undefined);
    if (i < 0) return;
    const [settled] = this.asked.splice(i, 1);
    settled.refused?.(frame.error);
  }

  /** Fire-and-forget still returns the exact id put on the wire for deterministic QA. */
  send(frame: ClientFrame): ID | undefined {
    return this.transmit(frame);
  }

  listWorkflows(): ID | undefined {
    this.world.workflowError = undefined;
    this.world.workflowRetry = undefined;
    this.world.workflowNotice = undefined;
    this.world.workflowLoading = true;
    this.emit();
    const frame: WorkflowRequestFrame = { type: "listWorkflows" };
    const id = this.send(frame);
    if (id) this.workflowRequests.set(id, frame);
    else this.world.workflowLoading = false;
    return id;
  }

  sendWorkflow(frame: Exclude<WorkflowRequestFrame, { type: "listWorkflows" }>, onLost?: () => void): ID | undefined {
    this.world.workflowError = undefined;
    this.world.workflowRetry = undefined;
    this.world.workflowNotice = undefined;
    const requestId = this.nextRequestId(frame.type);
    const outgoing = { ...frame, requestId };
    const id = this.transmit(outgoing, {
      answers: response => (response as { requestId?: ID }).requestId === requestId
        && (response.type === "workflow" || response.type === "workflowRun"),
      refused: () => { /* the correlated workflow error restores the draft */ },
      lost: () => {
        this.workflowRequests.delete(requestId);
        this.world.workflowError = {
          text: "Cloud9 disconnected before it confirmed that workflow action. Try again.",
          ts: Date.now(), requestId,
        };
        this.world.workflowRetry = frame;
        this.world.workflowNotice = undefined;
        this.emit();
        onLost?.();
      },
    });
    if (id) this.workflowRequests.set(id, frame);
    return id;
  }

  /** Replay only the workflow frame that was refused, with a fresh request id. */
  retryWorkflowRequest(onLost?: () => void): ID | undefined {
    const frame = this.world.workflowRetry;
    if (!frame) return undefined;
    if (frame.type === "listWorkflows") return this.listWorkflows();
    return this.sendWorkflow(frame as Exclude<WorkflowRequestFrame, { type: "listWorkflows" }>, onLost);
  }

  /**
   * THE ONE ANSWER TO "WHAT HAPPENS TO WHAT HE TYPED WHEN A FORM REFUSES IT".
   *
   * WHY THIS EXISTS. Phase 5 (A3) typed 100,000 characters into the composer
   * and pressed Enter. The box emptied, and only THEN did the hub answer "that
   * message is too long (max 40000 characters)". Every word was gone and he
   * could not shorten what he had written. Two screens away the agent-name box
   * and the personality box get it exactly right — they say why and keep the
   * text — so the app already knew how, in one place and not the other. Three
   * boxes were each deciding for themselves.
   *
   * THE RULE, and there is only one: nothing is ever cleared before it is known
   * to have been ACCEPTED. So the check runs FIRST, here, using the hub's own
   * validator imported rather than re-spelled; a refusal is said out loud and
   * `false` comes back, and the caller's box is untouched because the caller
   * only ever clears on `true`.
   *
   * The hub is still the boundary and still checks everything again — this does
   * not replace it, it just means the ordinary refusals happen before his words
   * can be thrown away.
   *
   * @param problem the plain-words refusal, or null when there is nothing wrong
   * @param say     where to print it; the toast unless the form has its own line
   * @returns true only if the frame really went
   */
  submit(problem: string | null, frame: ClientFrame, say?: (why: string) => void): boolean {
    if (this.refused(problem, say)) return false;
    if (this.send(frame) === undefined) {
      (say ?? ((why: string) => this.notify(why)))("Cloud9 is offline. Your message is still in the box.");
      return false;
    }
    return true;
  }

  /**
   * The judgement half of `submit`, on its own.
   *
   * A form that needs `ask` (because it wants the HUB'S refusal routed back to
   * its own line rather than to the toast) cannot call `submit`, and without
   * this it would have to re-decide what a refusal means — which is exactly how
   * three boxes ended up with three different answers. So the decision lives
   * here, once, and both routes ask it.
   *
   * @returns true when this was refused and the caller must change NOTHING
   */
  refused(problem: string | null, say?: (why: string) => void): boolean {
    if (!problem) return false;
    (say ?? ((why: string) => this.notify(why)))(problem);
    return true;
  }

  /**
   * What has been asked and not yet answered, oldest first.
   *
   * Exposed because the one thing that matters about the ledger cannot be seen
   * on screen: that a refusal arrived WHILE something else was still waiting.
   * A test that only checked the outcome would pass just as happily when the
   * two never overlapped at all.
   */
  outstanding(): string[] {
    return this.asked.map(a => a.kind);
  }

  /** Exact modern ledger rows for deterministic late-answer/push/refusal QA. */
  outstandingQuestions(): Array<{ kind: ClientFrame["type"]; requestId: ID; refusable: boolean }> {
    return this.asked.map(a => ({
      kind: a.kind,
      requestId: a.requestId,
      refusable: a.refused !== undefined,
    }));
  }

  /**
   * Feed one typed hub frame through the real dispatcher for deterministic QA.
   * The browser hook uses this to interleave exact/no-id refusals and successes;
   * production traffic still enters through the WebSocket's onmessage handler.
   */
  receiveForQa(frame: ServerFrame): void {
    this.onFrame(frame);
  }

  /** how many frames of each kind the hub has sent — evidence that an answer really arrived */
  private seen: Record<string, number> = {};

  framesSeen(): Record<string, number> {
    return { ...this.seen };
  }

  /**
   * Say something the app itself decided, in the one place refusals are said.
   *
   * When the app declines to do something (a guest asking for an invite the
   * relay would refuse anyway), it must not just do nothing — silence is the
   * dead click this round exists to kill. It goes through `lastError` so there
   * is still exactly ONE owner of "here is why that didn't happen": the toast
   * on every workspace screen, the notice on the join screen. Pass the relay's
   * own wording where one exists, so both routes print the same sentence.
   */
  notify(text: string): void {
    this.world.lastError = { text, ts: Date.now() };
    this.emit();
  }

  /* ---------------- scrollback ---------------- */

  page(channelId: ID): Page {
    return this.world.pages[channelId] ?? { hasMore: true, loading: false, asked: false };
  }

  private setPage(channelId: ID, patch: Partial<Page>): void {
    this.world.pages = {
      ...this.world.pages,
      [channelId]: { ...this.page(channelId), ...patch },
    };
  }

  /**
   * Ask for one page of a conversation.
   *
   * With no cursor this is the newest page — the first thing a conversation
   * needs, because `welcome` hands over recent messages without ever saying
   * whether there are older ones. With the cursor from the last `history`
   * frame it is the page before that. The cursor is sent back EXACTLY as it
   * arrived; a hand-built one skips or repeats a message at the boundary.
   */
  loadOlder(channelId: ID): void {
    const page = this.page(channelId);
    if (page.loading) return;
    if (page.asked && !page.hasMore) return;
    this.setPage(channelId, { loading: true });
    this.emit();
    this.send({
      type: "history", channelId, limit: 50,
      before: page.asked ? page.nextBefore : undefined,
      beforeId: page.asked ? page.nextBeforeId : undefined,
    });
  }

  /* ---------------- read state ---------------- */

  /** "I have read this conversation up to here." Kept on the account, not here. */
  markRead(channelId: ID, ts?: number): void {
    this.send({ type: "markRead", channelId, ts });
  }

  /** Fetch the relay-owned, durable mention/thread-reply inbox. */
  askNotifications(includeDismissed = false, limit = 100): void {
    const requestId = this.nextRequestId("notifications");
    this.world.notificationsAsked = true;
    this.world.notificationsLoading = true;
    this.world.notificationsRequestId = requestId;
    this.world.notificationsProblem = undefined;
    this.emit();
    const sent = this.ask({ type: "notifications", includeDismissed, limit, requestId }, {
      answers: f => f.type === "notificationInbox" && f.requestId === requestId,
      answered: f => {
        if (f.type !== "notificationInbox" || this.world.notificationsRequestId !== requestId) return;
        this.world.notifications = [...f.entries];
        this.world.notificationsLoading = false;
        this.world.notificationsProblem = undefined;
        this.world.notificationsRequestId = undefined;
        this.emit();
      },
      refused: error => {
        if (this.world.notificationsRequestId !== requestId) return;
        this.world.notificationsLoading = false;
        this.world.notificationsProblem = error;
        this.world.notificationsRequestId = undefined;
        this.emit();
      },
      lost: () => {
        if (this.world.notificationsRequestId !== requestId) return;
        this.world.notificationsLoading = false;
        this.world.notificationsProblem = "The relay did not answer. Try loading notifications again.";
        this.world.notificationsRequestId = undefined;
        this.emit();
      },
    });
    if (!sent && this.world.notificationsRequestId === requestId) {
      this.world.notificationsRequestId = undefined;
      this.world.notificationsLoading = false;
      this.world.notificationsProblem = "Cloud9 is reconnecting. Notifications will return when the relay answers.";
      this.emit();
    }
  }

  markNotificationRead(notificationId: ID): void {
    this.send({ type: "markNotificationRead", notificationId });
  }

  dismissNotification(notificationId: ID): void {
    this.send({ type: "dismissNotification", notificationId });
  }

  /** Fetch saved messages with a loading/error boundary scoped to this route. */
  askSaved(beforeSavedAt?: number, beforeMessageId?: ID): void {
    const requestId = this.nextRequestId("listSaved");
    const append = beforeSavedAt !== undefined && beforeMessageId !== undefined;
    if (!append) this.world.savedNew = false;
    this.world.savedAsked = true;
    this.world.savedLoading = true;
    this.world.savedRequestId = requestId;
    this.world.savedProblem = undefined;
    this.emit();
    const frame: SavedRequestFrame = {
      type: "listSaved", ...(append ? { beforeSavedAt, beforeMessageId } : {}),
    };
    this.savedRequests.set(requestId, frame);
    const sent = this.ask({ ...frame, requestId }, {
      answers: f => f.type === "savedMessages" && f.requestId === requestId,
      answered: f => {
        if (f.type !== "savedMessages" || this.world.savedRequestId !== requestId) return;
        this.savedRequests.delete(requestId);
        this.world.savedMessages = append
          ? [...this.world.savedMessages, ...f.entries.filter(entry => !this.world.savedMessages.some(old => old.id === entry.id))]
          : [...f.entries];
        this.world.savedRevision = f.revision ?? this.world.savedRevision;
        this.world.savedHasMore = f.hasMore ?? false;
        this.world.savedNextSavedAt = f.nextSavedAt;
        this.world.savedNextMessageId = f.nextMessageId;
        this.world.savedLoading = false;
        this.world.savedProblem = undefined;
        this.world.savedRequestId = undefined;
        this.world.savedNew = false;
        this.emit();
      },
      refused: error => {
        this.savedRequests.delete(requestId);
        if (this.world.savedRequestId !== requestId) return;
        this.world.savedLoading = false;
        this.world.savedProblem = error;
        this.world.savedRequestId = undefined;
        this.emit();
      },
      lost: () => {
        this.savedRequests.delete(requestId);
        if (this.world.savedRequestId !== requestId) return;
        this.world.savedLoading = false;
        this.world.savedProblem = "The relay did not answer. Try loading saved messages again.";
        this.world.savedRequestId = undefined;
        this.emit();
      },
    });
    if (!sent && this.world.savedRequestId === requestId) {
      this.savedRequests.delete(requestId);
      this.world.savedRequestId = undefined;
      this.world.savedLoading = false;
      this.world.savedProblem = "Cloud9 is reconnecting. Saved messages will return when the relay answers.";
      this.emit();
    }
  }

  saveForLater(messageId: ID, note?: string, remindAt?: number, onLost?: () => void): ID | undefined {
    this.world.savedNotice = undefined;
    const frame: SavedRequestFrame = { type: "saveMessage", messageId, ...(note ? { note } : {}), ...(remindAt !== undefined ? { remindAt } : {}) };
    return this.sendSaved(frame, onLost);
  }

  unsaveForLater(messageId: ID, onLost?: () => void): ID | undefined {
    this.world.savedNotice = undefined;
    return this.sendSaved({ type: "unsaveMessage", messageId }, onLost);
  }

  private sendSaved(frame: Exclude<SavedRequestFrame, { type: "listSaved" }>, onLost?: () => void): ID | undefined {
    const requestId = this.nextRequestId(frame.type);
    this.savedRequests.set(requestId, frame);
    const id = this.transmit({ ...frame, requestId }, {
      answers: f => f.type === "savedMessages" && f.requestId === requestId,
      answered: f => {
        this.savedRequests.delete(requestId);
        this.finishSavedPending(requestId, frame.messageId);
        if (f.type !== "savedMessages") return;
        this.world.savedMessages = [...f.entries];
        this.world.savedRevision = f.revision ?? this.world.savedRevision;
        this.world.savedHasMore = f.hasMore ?? false;
        this.world.savedNextSavedAt = f.nextSavedAt;
        this.world.savedNextMessageId = f.nextMessageId;
        this.world.savedProblem = undefined;
        this.world.savedNotice = {
          text: frame.type === "saveMessage" ? "Saved for later" : "Removed from saved",
          ts: Date.now(), requestId, messageId: frame.messageId,
        };
        this.emit();
      },
      refused: error => {
        this.savedRequests.delete(requestId);
        this.finishSavedPending(requestId, frame.messageId);
        this.world.savedNotice = undefined;
        this.world.savedProblem = error;
        this.emit();
      },
      lost: () => {
        this.savedRequests.delete(requestId);
        this.finishSavedPending(requestId, frame.messageId);
        onLost?.();
        this.world.savedNotice = undefined;
        this.world.savedProblem = "The relay did not answer. Try again.";
        this.emit();
      },
    });
    if (!id) {
      this.savedRequests.delete(requestId);
      // transmit() refuses while offline. Keep the mutation visible instead
      // of silently dropping the user's save/unsave intent.
      this.world.savedProblem = "Cloud9 is reconnecting. Try again when the relay answers.";
      this.world.savedNotice = undefined;
      this.emit();
    }
    else {
      this.world.savedPending = [...new Set([...this.world.savedPending, frame.messageId])];
      this.emit();
    }
    return id;
  }

  private finishSavedPending(requestId: ID, messageId: ID): void {
    const stillWaiting = [...this.savedRequests.values()].some(frame =>
      frame.type !== "listSaved" && frame.messageId === messageId);
    if (!stillWaiting) this.world.savedPending = this.world.savedPending.filter(id => id !== messageId);
  }

  /* ---------------- search ---------------- */

  /**
   * WHICH SEARCH THIS SCREEN IS WAITING FOR.
   *
   * Bumped when a new one is asked and again when one is called off, so an
   * answer can tell whether the question that produced it is still being asked.
   * A search cleared while its results were still coming back used to be
   * brought back to life by them, hits and all, and the ghost hits were
   * clickable. An answer to a question nobody is asking any more goes nowhere.
   */
  private searchEpoch = 0;

  search(query: string, filters: { channelId?: ID; authorId?: ID } = {}): void {
    const epoch = ++this.searchEpoch;
    this.world.search = {
      query, running: true,
      results: this.world.search?.results ?? [],
      hasMore: false,
      answered: this.world.search?.answered ?? "",
    };
    this.emit();
    /** the answer only lands if this is still the search on screen */
    const stale = (): boolean => this.searchEpoch !== epoch;
    const stopRunning = (): void => {
      if (stale() || !this.world.search) return;
      this.world.search = { ...this.world.search, running: false };
      this.emit();
    };
    this.ask({ type: "search", query, ...filters, limit: 50 }, {
      answers: f => f.type === "searchResults",
      answered: f => {
        if (stale() || f.type !== "searchResults") return;
        this.world.search = {
          query, answered: f.query, running: false,
          results: f.results, hasMore: f.hasMore,
        };
      },
      // A refused search stops spinning. The hub's own sentence is already on
      // screen through `lastError` — saying it twice would not make it truer.
      refused: stopRunning,
      lost: stopRunning,
    });
  }

  clearSearch(): void {
    this.searchEpoch++;
    this.world.search = undefined;
    this.emit();
  }

  /** Which "search everywhere" this screen is waiting for — see `searchEpoch`. */
  private everywhereEpoch = 0;

  /**
   * Ask the hub for words in EVERYTHING this person may already read.
   *
   * Correlated by the UNIVERSAL requestId at the one desktop send boundary
   * (`identify`/`transmit`), the same way the workspace page and the artifact
   * detail are — the id is minted here, put on the frame, and the answer is
   * recognised by that exact id and nothing else. A second question asked while
   * the first is still out therefore cannot be settled by the first's answer,
   * and the epoch on top of it means an answer to a question the reader has
   * since called off is dropped rather than drawn.
   *
   * `kind` narrows what comes back. It can never widen the scope — which rooms
   * and which files are readable is the hub's decision from stored membership
   * and stored file permissions, and this frame cannot argue with it.
   */
  searchEverywhere(query: string, kind?: SearchKind): void {
    const epoch = ++this.everywhereEpoch;
    const previous = this.world.everywhere;
    /* THE QUESTION IS THE WORDS *AND* THE KIND. Rows already on screen may be
       kept while the next answer is on its way, but only when they answer the
       SAME question — and the same words asked about a NARROWER kind are a
       different question, so the wider answer is not an answer to it. Judging
       by the words alone left the whole wide list under a narrowed heading. */
    const sameQuestion = !!previous && previous.answered === query && previous.kind === kind;
    this.world.everywhere = {
      query, kind, running: true,
      results: sameQuestion ? previous.results : [],
      hasMore: sameQuestion ? previous.hasMore : false,
      answered: sameQuestion ? previous.answered : "",
    };
    this.emit();
    const stale = (): boolean => this.everywhereEpoch !== epoch;
    const stopRunning = (why?: string): void => {
      if (stale() || !this.world.everywhere) return;
      this.world.everywhere = { ...this.world.everywhere, running: false, ...(why ? { problem: why } : {}) };
      this.emit();
    };
    const requestId = this.nextRequestId("searchEverywhere");
    this.ask({ type: "searchEverywhere", query, ...(kind ? { kind } : {}), limit: 40, requestId }, {
      answers: f => f.type === "searchEverywhereResults" && f.requestId === requestId,
      answered: f => {
        if (stale() || f.type !== "searchEverywhereResults") return;
        this.world.everywhere = {
          query, kind, running: false, answered: f.query,
          results: f.results, hasMore: f.hasMore,
        };
      },
      /* The hub's own sentence, kept and shown where he is looking. A refused
         search that only spun forever is what made "type at least one word"
         invisible — it went to a toast beside a box that never stopped. */
      refused: why => stopRunning(why),
      lost: () => stopRunning("The hub did not answer that search."),
    });
  }

  clearEverywhere(): void {
    this.everywhereEpoch++;
    this.world.everywhere = undefined;
    this.emit();
  }

  /**
   * Put one changed message everywhere it is being held.
   *
   * ONE OWNER for "a message changed": the conversation, the open thread and
   * the search results all read from here, so an edit cannot be applied to two
   * of the three and quietly missed by the last.
   */
  private replaceMessage(next: Message): void {
    const w = this.world;
    const list = w.messages[next.channelId];
    if (list) {
      const i = list.findIndex(m => m.id === next.id);
      if (i >= 0) {
        const copy = [...list];
        copy[i] = next;
        w.messages = { ...w.messages, [next.channelId]: copy };
      }
    }
    for (const [root, msgs] of Object.entries(w.threads)) {
      const i = msgs.findIndex(m => m.id === next.id);
      if (i >= 0) {
        const copy = [...msgs];
        copy[i] = next;
        w.threads = { ...w.threads, [root]: copy };
      }
    }
    if (w.search) {
      const hits = w.search.results;
      if (hits.some(h => h.message.id === next.id)) {
        w.search = {
          ...w.search,
          results: hits.map(h => (h.message.id === next.id ? { ...h, message: next } : h)),
        };
      }
    }
  }

  /** Apply the full, current list of who reacted with one emoji to one message. */
  private applyReaction(messageId: ID, emoji: string, userIds: ID[]): void {
    const w = this.world;
    const rewrite = (m: Message): Message => {
      const others = (m.reactions ?? []).filter(r => r.emoji !== emoji);
      // an empty list is not "no change" — it means nobody reacts with this any
      // more, so the pill goes away entirely
      const reactions = userIds.length > 0 ? [...others, { emoji, userIds }] : others;
      return { ...m, reactions };
    };
    for (const [cid, list] of Object.entries(w.messages)) {
      const i = list.findIndex(m => m.id === messageId);
      if (i < 0) continue;
      const copy = [...list];
      copy[i] = rewrite(copy[i]);
      w.messages = { ...w.messages, [cid]: copy };
    }
    for (const [root, msgs] of Object.entries(w.threads)) {
      const i = msgs.findIndex(m => m.id === messageId);
      if (i < 0) continue;
      const copy = [...msgs];
      copy[i] = rewrite(copy[i]);
      w.threads = { ...w.threads, [root]: copy };
    }
  }

  /* ---------------- what an agent actually did ---------------- */

  /** The one spelling of a history's key. Two spellings is two caches. */
  private runKey(scope: "agent" | "task", id: ID): string {
    return `${scope}:${id}`;
  }

  /** run ids already asked for, so a render cannot ask for the same one twice */
  private runAsked = new Set<string>();

  /** One run in full, if this screen is holding it. */
  run(runId: string): RunRecord | undefined {
    return this.world.runs[runId];
  }

  /** One history, answered or not. Never undefined — an unasked list says so. */
  runsFor(scope: "agent" | "task", id: ID): RunList {
    return this.world.runLists[this.runKey(scope, id)] ?? { asked: false, loading: false, entries: [] };
  }

  /**
   * Ask for one run in full — the steps, the time, the money.
   *
   * Asked ONCE per run for the life of this screen: a record does not change
   * after it is written, and a disclosure that re-asked on every open would put
   * a frame on the wire for every click. A run already pushed here unasked is
   * never asked for at all.
   *
   * A run this person may not read is answered "no such run" — the same
   * sentence an invented id gets, deliberately, so an id cannot be probed. Both
   * mean the same thing to this screen: it is not there.
   */
  askRun(runId: string): void {
    if (this.world.runs[runId] || this.runAsked.has(runId)) return;
    this.runAsked.add(runId);
    /* "It isn't there" used to be recognised by reading the hub's sentence and
       matching the words "no such run". That was a patch: it worked only while
       the hub kept spelling it that way, and only for refusals it had been
       taught. A refusal is now recognised by WHOSE it is (see `asked`), so any
       reason this run cannot be shown ends the disclosure's wait. */
    const gone = (): void => {
      this.world.runsGone = { ...this.world.runsGone, [runId]: true };
      this.emit();
    };
    this.ask({ type: "runDetail", runId }, {
      answers: f => f.type === "run" && f.record.id === runId,
      refused: gone,
      lost: gone,
    });
  }

  /**
   * Ask what an agent, or one job, has been doing.
   *
   * By AGENT this is owner-only at the hub, by design — sharing a room with
   * someone's agent shows you the turns it takes there, and is not a licence to
   * read everything it has ever done. Callers must not ask about an agent that
   * is not this person's; the rail simply does not offer it.
   */
  askRuns(scope: "agent" | "task", id: ID, limit?: number): void {
    const key = this.runKey(scope, id);
    const held = this.runsFor(scope, id);
    /* ASKED EVERY TIME THE RAIL OPENS, and only the one already in flight is
       skipped. A history is not a record: it grows with every turn the agent
       takes, so an answer from the last time this screen was opened is out of
       date the moment anything happens. Caching it the way a single record is
       cached showed the owner an agent's work as it stood an hour ago, with the
       job they just watched finish missing from it. */
    if (held.loading) return;
    this.world.runLists = { ...this.world.runLists, [key]: { ...held, loading: true } };
    this.emit();
    this.send(scope === "agent"
      ? { type: "runList", agentId: id, ...(limit ? { limit } : {}) }
      : { type: "runList", taskId: id, ...(limit ? { limit } : {}) });
  }

  // ===== SPENDING BLOCK (what the crew costs, 2026-08-07) — start =====
  /**
   * "WHAT ARE MY AGENTS COSTING ME?" — asked every time the screen opens.
   *
   * ASKED AFRESH, NEVER CACHED ACROSS AN OPENING, for the same reason
   * `askRuns` is: this is not a record, it is a running total. It changes with
   * every turn any agent takes, so an answer from the last time he looked is
   * out of date the moment anything happens — and a spending figure that is
   * quietly an hour old is the one kind of stale number that could cost him
   * money. Only a request already in flight is skipped.
   */
  askSpending(): void {
    if (this.world.spending.loading) return;
    this.world.spending = { ...this.world.spending, loading: true };
    this.emit();
    this.send({ type: "spending" });
  }
  // ===== SPENDING BLOCK — end =====

  /**
   * An agent is gone, so what it did goes with it.
   *
   * The hub forgets an agent's runs when the agent goes. A screen that carried
   * on drawing them would be showing something that no longer exists anywhere
   * else — which is the same class of lie as showing a cost nobody reported.
   */
  private forgetRunsOf(agentId: ID): void {
    const w = this.world;
    const kept: Record<string, RunRecord> = {};
    for (const [id, record] of Object.entries(w.runs)) {
      if (record.agentId !== agentId) kept[id] = record;
    }
    w.runs = kept;
    const { [this.runKey("agent", agentId)]: gone, ...rest } = w.runLists;
    void gone;
    w.runLists = rest;
  }

  /* ---------------- rooms ---------------- */

  /** Ask for the open rooms this person could join. */
  browseChannels(): void {
    this.send({ type: "browseChannels" });
  }

  /** Ask who is in one room. Answered with roles, join dates and who let them in. */
  askMembers(channelId: ID): void {
    this.send({ type: "channelMembers", channelId });
  }

  /* ---------------- what an agent remembers between conversations ----------------
   *
   * ONE OWNER FOR "WHAT THIS AGENT REMEMBERS", and it is the engine's own store
   * on this computer. This app never invents a note: every note drawn on the
   * memory panel arrived on a `memory` frame, and clearing one asks the engine
   * to delete it and report back what is left. The engine has to be running to
   * answer — its store is not on the hub — so an agent whose engine is offline
   * shows "loading" rather than a made-up empty state.
   */

  /** One agent's saved notes, answered or not. Never undefined — an unasked list says so. */
  memoryFor(agentId: ID): { asked: boolean; loading: boolean; notes: MemoryNote[] } {
    return this.world.memory[agentId] ?? { asked: false, loading: false, notes: [] };
  }

  /**
   * Ask what an agent has saved to remember.
   *
   * Asked every time the panel opens, not once: memory grows and shrinks as the
   * agent works and as the owner clears notes, so a list cached from the last
   * visit would be an answer to an older question. A refusal and a silence both
   * settle the panel — it must not spin for ever, and the hub's own sentence is
   * already on screen through `lastError`.
   */
  askMemory(agentId: ID): void {
    const held = this.memoryFor(agentId);
    if (held.loading) return;
    this.world.memory = { ...this.world.memory, [agentId]: { ...held, loading: true } };
    this.emit();
    const settled = (): void => {
      const now = this.memoryFor(agentId);
      this.world.memory = {
        ...this.world.memory, [agentId]: { ...now, asked: true, loading: false },
      };
      this.emit();
    };
    this.ask({ type: "memoryList", agentId }, {
      answers: f => f.type === "memory" && f.agentId === agentId,
      // the `memory` frame itself is applied in onFrame (it arrives unasked too,
      // whenever a note is saved or cleared), so here we only stop the spinner
      answered: settled,
      refused: settled,
      lost: settled,
    });
  }

  /**
   * Clear one saved note. The engine deletes it from its own store and reports
   * the shrunken list straight back on a `memory` frame — so there is nothing
   * to apply here, and the panel never shows a note the store no longer holds.
   */
  forgetMemoryNote(agentId: ID, noteId: ID): void {
    this.send({ type: "forgetMemoryNote", agentId, noteId });
  }

  /* ---------------- projects: a repository, its pull requests, its issues ----------------
   *
   * ONE OWNER FOR "WHAT IS IN THIS REPOSITORY", and it is the hub. Nothing in
   * this app reaches GitHub, guesses a default branch, or invents a state for a
   * pull request; every value drawn on the Projects screen arrived on a frame.
   * That is the same split the hub keeps for the same reason — the part a guest
   * can talk to must never be the part that can reach out of the machine.
   */

  /** One project's lists, answered or not. Never undefined — an unasked list says so. */
  itemsFor(projectId: ID): { asked: boolean; items: ProjectItem[] } {
    return this.world.projectItems[projectId] ?? { asked: false, items: [] };
  }

  /**
   * Ask for the repositories this person has connected.
   *
   * Asked EVERY time the screen opens, not once: a project gains a
   * `defaultBranch`, a `syncedAt` and sometimes a `problem` the moment the
   * engine looks at GitHub, so a list cached from the last visit would show a
   * repository as never-looked-at long after it had been.
   */
  forumFeed(projectId: ID): { asked: boolean; loading: boolean; topics: ForumTopic[]; unread: number; selected?: ID; problem?: string } {
    return this.world.forumFeeds[projectId] ?? { asked: false, loading: false, topics: [], unread: 0 };
  }
  askForumProjects(): void {
    const requestId = this.nextRequestId("forumProjects");
    this.world.forumProjects = { ...this.world.forumProjects, requestId };
    this.ask({ type: "forumProjects", requestId }, {
      answers: f => f.type === "forumProjects" && f.requestId === requestId,
      answered: f => { if (f.type === "forumProjects" && f.requestId === requestId && this.world.forumProjects.requestId === requestId) this.world.forumProjects = { asked: true, projects: f.projects, requestId: undefined }; this.emit(); },
      refused: _why => { if (this.world.forumProjects.requestId === requestId) this.world.forumProjects = { ...this.world.forumProjects, asked: true, requestId: undefined }; this.emit(); },
      lost: () => { if (this.world.forumProjects.requestId === requestId) this.world.forumProjects = { ...this.world.forumProjects, asked: true, requestId: undefined }; this.emit(); },
    });
  }
  askForumFeed(projectId: ID): void {
    const old=this.forumFeed(projectId); const requestId=this.nextRequestId("forumList"); this.world.forumFeeds={...this.world.forumFeeds,[projectId]:{...old,loading:true,problem:undefined,requestId}}; this.emit();
    this.ask({type:"forumList",projectId,requestId},{answers:f=>f.type==="forumFeed"&&f.projectId===projectId&&f.requestId===requestId,answered:f=>{if(f.type!=="forumFeed"||f.requestId!==requestId||this.world.forumFeeds[projectId]?.requestId!==requestId)return;this.world.forumFeeds={...this.world.forumFeeds,[projectId]:{asked:true,loading:false,topics:f.topics,unread:f.unread,selected:f.topics[0]?.id,requestId:undefined}};this.emit();},refused:e=>{if(this.world.forumFeeds[projectId]?.requestId!==requestId)return;this.world.forumFeeds={...this.world.forumFeeds,[projectId]:{...old,asked:true,loading:false,problem:e,requestId:undefined}};this.emit();},lost:()=>{if(this.world.forumFeeds[projectId]?.requestId!==requestId)return;this.world.forumFeeds={...this.world.forumFeeds,[projectId]:{...old,asked:true,loading:false,problem:"the forum did not answer",requestId:undefined}};this.emit();}});
  }
  forumMutation(requestId: ID): World["forumMutations"][ID] | undefined { return this.world.forumMutations[requestId]; }
  private forumAnswer(frame: ClientFrame, requestId: ID, response: ServerFrame): boolean {
    if (!("requestId" in response) || response.requestId !== requestId) return false;
    if (frame.type === "forumTopic" || frame.type === "agentForumTopic") return response.type === "forumTopic";
    if (frame.type === "forumReply" || frame.type === "agentForumReply" || frame.type === "forumEditTopic" || frame.type === "forumEditReply" || frame.type === "forumDeleteTopic" || frame.type === "forumDeleteReply" || frame.type === "forumSetStatus" || frame.type === "forumAcceptReply") return response.type === "forumChanged" || response.type === "forumTopic";
    if (frame.type === "forumMarkRead") return response.type === "forumRead";
    if (frame.type === "forumMembers" || frame.type === "forumAddMember" || frame.type === "forumRemoveMember") return response.type === "forumMembers" || response.type === "forumProjects" || response.type === "forumUnavailable";
    return false;
  }
  forumSend(frame: ClientFrame, draft?: World["forumMutations"][ID]["draft"]): ID | undefined {
    const requestId = frame.requestId ?? this.nextRequestId(frame.type);
    const outgoing = { ...frame, requestId } as ClientFrame;
    const withIds = outgoing as ClientFrame & { projectId?: ID; topicId?: ID };
    const projectId = withIds.projectId;
    const topicId = withIds.topicId;
    const mark = (state: World["forumMutations"][ID]["state"], problem?: string): void => {
      const current = this.world.forumMutations[requestId];
      if (!current) return;
      this.world.forumMutations = { ...this.world.forumMutations, [requestId]: { ...current, state, ...(problem ? { problem } : {}) } };
      this.emit();
    };
    this.world.forumMutations = { ...this.world.forumMutations, [requestId]: { kind: outgoing.type, projectId, topicId, state: "pending", ...(draft ? { draft } : {}) } };
    this.emit();
    const sent = this.transmit(outgoing, {
      answers: response => this.forumAnswer(outgoing, requestId, response),
      answered: () => mark("succeeded"),
      refused: problem => mark("refused", problem),
      lost: () => mark("lost", "Cloud9 disconnected before it confirmed that forum action. Your draft is still open.") ,
    });
    if (!sent) mark("lost", "Cloud9 is offline. Your draft is still open.");
    return sent;
  }
  askForumTopic(topicId: ID): void {
    const requestId=this.nextRequestId("forumOpen");
    this.world.forumTopicRequests={...this.world.forumTopicRequests,[topicId]:requestId};
    this.ask({type:"forumOpen",topicId,requestId},{answers:f=>f.type==="forumTopic"&&f.topic.id===topicId&&f.requestId===requestId,answered:f=>{if(f.type!=="forumTopic"||f.requestId!==requestId||this.world.forumTopicRequests[topicId]!==requestId)return;this.world.forumReplies={...this.world.forumReplies,[topicId]:f.replies};this.emit();},refused:()=>{if(this.world.forumTopicRequests[topicId]===requestId){const {[topicId]:_gone,...rest}=this.world.forumTopicRequests;void _gone;this.world.forumTopicRequests=rest;}this.emit();},lost:()=>{if(this.world.forumTopicRequests[topicId]===requestId){const {[topicId]:_gone,...rest}=this.world.forumTopicRequests;void _gone;this.world.forumTopicRequests=rest;}this.emit();}});
  }
  askForumMembers(projectId: ID): void {
    const requestId = this.nextRequestId("forumMembers");
    this.ask({ type: "forumMembers", projectId, requestId }, {
      answers: f => f.type === "forumMembers" && f.projectId === projectId && f.requestId === requestId,
      answered: f => {
        if (f.type !== "forumMembers" || f.requestId !== requestId) return;
        this.world.forumMembersByProject = { ...this.world.forumMembersByProject, [projectId]: f.userIds };
        this.emit();
      },
      refused: () => this.emit(),
      lost: () => this.emit(),
    });
  }

  askProjects(): void {
    this.ask({ type: "projects" }, {
      answers: f => f.type === "projects",
      answered: f => {
        if (f.type !== "projects") return;
        this.world.projects = { asked: true, list: f.projects };
      },
      /* A refusal and a silence both mean the same thing here: we asked and got
         no list. The screen must not be left spinning on either, and the hub's
         own sentence is already on screen through `lastError`. */
      refused: () => { this.world.projects = { ...this.world.projects, asked: true }; this.emit(); },
      lost: () => { this.world.projects = { ...this.world.projects, asked: true }; this.emit(); },
    });
  }

  /** Ask for one project's pull requests and issues, as of the last look. */
  
  askCanvases(projectId: ID): void {
    const requestId = this.nextRequestId("canvases");
    this.world.canvases = { asked: false, projectId, requestId, historyAsked: false, list: [], history: [] };
    const sent = this.ask({ type: "canvases", projectId, requestId }, {
      answers: f => f.type === "canvases" && f.projectId === projectId && f.requestId === requestId,
      answered: f => { if (f.type === "canvases" && this.world.canvases.requestId === requestId) this.world.canvases = { asked: true, projectId, list: f.canvases, historyAsked: false, history: [] }; },
      refused: why => { if (this.world.canvases.requestId === requestId) this.world.canvases = { asked: true, projectId, list: [], history: [], problem: why }; this.emit(); },
      lost: () => { if (this.world.canvases.requestId === requestId) this.world.canvases = { asked: true, projectId, list: [], history: [], problem: "the hub did not answer" }; this.emit(); },
    });
    if (!sent && this.world.canvases.requestId === requestId) { this.world.canvases = { asked: true, projectId, list: [], history: [], problem: "not connected to the hub yet" }; this.emit(); }
  }
  private canvasMutation(frame: ClientFrame, requestId: ID, hooks: { onSaved?: () => void; onLost?: () => void } = {}): void {
    this.world.canvases = { ...this.world.canvases, mutationRequestId: requestId, problem: undefined };
    const sent = this.ask({ ...frame, requestId } as ClientFrame, {
      answers: f => f.type === "canvas" && f.requestId === requestId,
      answered: () => {
        if (this.world.canvases.mutationRequestId === requestId) {
          this.world.canvases = { ...this.world.canvases, mutationRequestId: undefined };
        }
        hooks.onSaved?.();
      },
      refused: why => {
        if (this.world.canvases.mutationRequestId === requestId) {
          this.world.canvases = { ...this.world.canvases, mutationRequestId: undefined, problem: why };
        }
        this.emit();
      },
      lost: () => {
        if (this.world.canvases.mutationRequestId === requestId) {
          this.world.canvases = { ...this.world.canvases, mutationRequestId: undefined, problem: "the hub did not confirm that Canvas change" };
        }
        hooks.onLost?.();
        this.emit();
      },
    });
    if (!sent && this.world.canvases.mutationRequestId === requestId) {
      this.world.canvases = { ...this.world.canvases, mutationRequestId: undefined, problem: "not connected to the hub yet" };
      this.emit();
    }
  }
  createCanvas(projectId: ID, title: string, hooks?: { onSaved?: () => void; onLost?: () => void }): void { const requestId = this.nextRequestId("createCanvas"); this.canvasMutation({ type: "createCanvas", projectId, title }, requestId, hooks); }
  updateCanvas(canvasId: ID, title: string): void { const revision = this.world.canvases.list.find(c => c.id === canvasId)?.revision; const requestId = this.nextRequestId("updateCanvas"); this.canvasMutation({ type: "updateCanvas", canvasId, title, ...(revision !== undefined ? { expectedRevision: revision } : {}) }, requestId); }
  addCanvasBlock(canvasId: ID, kind: CanvasBlockKind, text: string, link?: CanvasLink, hooks?: { onSaved?: () => void; onLost?: () => void }): void { const revision = this.world.canvases.list.find(c => c.id === canvasId)?.revision; const requestId = this.nextRequestId("addCanvasBlock"); this.canvasMutation({ type: "addCanvasBlock", canvasId, kind, text, ...(link ? { link } : {}), ...(revision !== undefined ? { expectedRevision: revision } : {}) }, requestId, hooks); }
  editCanvasBlock(canvasId: ID, blockId: ID, text: string, kind?: CanvasBlockKind, hooks?: { onSaved?: () => void; onLost?: () => void }): void { const revision = this.world.canvases.list.find(c => c.id === canvasId)?.revision; const requestId = this.nextRequestId("editCanvasBlock"); this.canvasMutation({ type: "editCanvasBlock", canvasId, blockId, text, ...(kind ? { kind } : {}), ...(revision !== undefined ? { expectedRevision: revision } : {}) }, requestId, hooks); }
  tombstoneCanvasBlock(canvasId: ID, blockId: ID): void { const revision = this.world.canvases.list.find(c => c.id === canvasId)?.revision; const requestId = this.nextRequestId("tombstoneCanvasBlock"); this.canvasMutation({ type: "tombstoneCanvasBlock", canvasId, blockId, ...(revision !== undefined ? { expectedRevision: revision } : {}) }, requestId); }
  askCanvasHistory(canvasId: ID): void {
    const requestId = this.nextRequestId("canvasHistory");
    this.world.canvases = { ...this.world.canvases, historyAsked: true, historyRequestId: requestId, historyCanvasId: canvasId, historyLoading: true, historyProblem: undefined, history: [] };
    const sent = this.ask({ type: "canvasHistory", canvasId, limit: 50, requestId }, {
      answers: f => f.type === "canvasHistory" && f.canvasId === canvasId && f.requestId === requestId,
      answered: f => {
        if (f.type !== "canvasHistory" || this.world.canvases.historyRequestId !== requestId) return;
        this.world.canvases = { ...this.world.canvases, history: f.revisions, historyRequestId: undefined, historyLoading: false, historyProblem: undefined };
      },
      refused: why => {
        if (this.world.canvases.historyRequestId !== requestId) return;
        this.world.canvases = { ...this.world.canvases, historyRequestId: undefined, historyLoading: false, historyProblem: why };
        this.emit();
      },
      lost: () => {
        if (this.world.canvases.historyRequestId !== requestId) return;
        this.world.canvases = { ...this.world.canvases, historyRequestId: undefined, historyLoading: false, historyProblem: "the hub did not answer" };
        this.emit();
      },
    });
    if (!sent && this.world.canvases.historyRequestId === requestId) {
      this.world.canvases = { ...this.world.canvases, historyRequestId: undefined, historyLoading: false, historyProblem: "not connected to the hub yet" };
      this.emit();
    }
  }
  markCanvasRead(canvasId: ID, revision: number): void { this.send({ type: "markCanvasRead", canvasId, revision }); }

askPolls(projectId: ID): void {
    const requestId = this.nextRequestId("polls");
    this.world.polls = { asked: false, projectId, requestId, list: [] };
    const sent = this.ask({ type: "polls", projectId, requestId }, {
      answers: f => f.type === "polls" && f.projectId === projectId && f.requestId === requestId,
      answered: f => {
        if (f.type !== "polls" || this.world.polls.requestId !== requestId) return;
        this.world.polls = { asked: true, projectId, requestId: undefined, list: f.polls };
      },
      refused: () => {
        if (this.world.polls.requestId !== requestId) return;
        this.world.polls = { asked: true, projectId, requestId: undefined, list: [] }; this.emit();
      },
      lost: () => {
        if (this.world.polls.requestId !== requestId) return;
        this.world.polls = { asked: true, projectId, requestId: undefined, list: [] }; this.emit();
      },
    });
    if (!sent && this.world.polls.requestId === requestId) {
      this.world.polls = { asked: true, projectId, requestId: undefined, list: [] }; this.emit();
    }
  }
  createPoll(projectId: ID, question: string, options: string[], deadlineAt?: number, requestId = this.nextRequestId("createPoll")): void {
    this.send({ type: "createPoll", projectId, question, options, requestId, ...(deadlineAt ? { deadlineAt } : {}) });
  }
  votePoll(pollId: ID, optionId: ID): void { this.send({ type: "votePoll", pollId, optionId }); }
  closePoll(pollId: ID, summary?: string): void { this.send({ type: "closePoll", pollId, ...(summary ? { summary } : {}) }); }


  askPublicUpdates(projectId?: ID): void {
    this.ask({ type: "publicUpdates", ...(projectId ? { projectId } : {}) }, {
      answers: f => f.type === "publicUpdates",
      answered: f => {
        if (f.type !== "publicUpdates") return;
        this.world.publicUpdates = {
          ...this.world.publicUpdates, asked: true, drafts: f.drafts,
        };
        this.emit();
      },
    });
  }
  askPublicUpdate(draftId: ID): void {
    this.ask({ type: "publicUpdate", draftId }, {
      answers: f => f.type === "publicUpdate" && f.draft.id === draftId,
      answered: f => {
        if (f.type !== "publicUpdate") return;
        const drafts = this.world.publicUpdates.drafts;
        this.world.publicUpdates = {
          ...this.world.publicUpdates,
          asked: true,
          selected: f.draft,
          revisions: f.revisions,
          audit: f.audit,
          drafts: drafts.some(d => d.id === f.draft.id)
            ? drafts.map(d => d.id === f.draft.id ? f.draft : d)
            : [f.draft, ...drafts],
        };
        this.emit();
      },
    });
  }
  publicSend(frame: ClientFrame): void { this.send(frame); }



  askProjectItems(projectId: ID): void {
    const settled = (): void => {
      this.world.projectItems = {
        ...this.world.projectItems,
        [projectId]: { ...this.itemsFor(projectId), asked: true },
      };
      this.emit();
    };
    this.ask({ type: "projectItems", projectId }, {
      answers: f => f.type === "projectItems" && f.projectId === projectId,
      answered: f => {
        if (f.type !== "projectItems") return;
        this.world.projectItems = {
          ...this.world.projectItems,
          [f.projectId]: { asked: true, items: f.items },
        };
      },
      refused: settled,
      lost: settled,
    });
  }
  askHuddleProjects(): void { const requestId=this.nextRequestId("huddleProjects"); const settled=():void=>{this.world.huddleProjects={...this.world.huddleProjects,asked:true};this.emit();}; this.transmit({type:"huddleProjects",requestId},{answers:f=>f.type==="huddleProjects"&&f.requestId===requestId,answered:f=>{if(f.type==="huddleProjects")this.world.huddleProjects={asked:true,list:f.projects};this.emit();},refused:settled,lost:settled}); }
  askHuddles(projectId?: ID): void { const requestId=this.nextRequestId("huddleList"); const settled=():void=>{this.world.huddles={...this.world.huddles,asked:true};this.emit();}; this.transmit({type:"huddleList",...(projectId?{projectId}: {}),requestId},{answers:f=>f.type==="huddleList"&&f.requestId===requestId,answered:f=>{if(f.type==="huddleList")this.world.huddles={asked:true,sessions:f.sessions};this.emit();},refused:settled,lost:settled}); }
  askHuddle(sessionId: ID): void { const requestId=this.nextRequestId("huddleOpen"); const settled=():void=>{this.emit();}; this.transmit({type:"huddleOpen",sessionId,requestId},{answers:f=>f.type==="huddleSession"&&f.session.id===sessionId&&f.requestId===requestId,answered:f=>{if(f.type==="huddleSession")this.world.huddleNotes={...this.world.huddleNotes,[sessionId]:f.notes};this.emit();},refused:settled,lost:settled}); }
  huddleSend(frame: ClientFrame): ID | undefined {
    const requestId = this.nextRequestId(frame.type);
    this.world.huddleMutations = { ...this.world.huddleMutations, [requestId]: { kind: frame.type, state: "pending" } };
    this.emit();
    const id = this.transmit({ ...frame, requestId }, {
      answers: response => (response as { requestId?: ID }).requestId === requestId && ["huddleSession", "huddleChanged", "huddleRead", "huddleMembers"].includes(response.type),
      answered: () => { const current=this.world.huddleMutations[requestId]; if(current)this.world.huddleMutations={...this.world.huddleMutations,[requestId]:{...current,state:"succeeded"}}; this.emit(); },
      refused: problem => { const current=this.world.huddleMutations[requestId]; if(current)this.world.huddleMutations={...this.world.huddleMutations,[requestId]:{...current,state:"refused",problem}}; this.emit(); },
      lost: () => { const current=this.world.huddleMutations[requestId]; if(current)this.world.huddleMutations={...this.world.huddleMutations,[requestId]:{...current,state:"lost",problem:"Cloud9 disconnected before it confirmed this huddle action; your draft is still here."}}; this.emit(); },
    });
    if (!id) { const current=this.world.huddleMutations[requestId]; if(current)this.world.huddleMutations={...this.world.huddleMutations,[requestId]:{...current,state:"lost",problem:"Cloud9 is offline; your huddle action was not sent."}}; this.emit(); }
    return id;
  }
  huddleLink(link: HuddleLink): void {
    if (link.available === false) return;
    this.world.huddleNavigation = link;
    if (link.kind === "artifact" && (link.artifactId ?? link.id)) this.askArtifactDetail(link.artifactId ?? link.id!);
    if (link.kind === "projectItem" && link.projectItemKind) this.askProjects();
    this.emit();
  }
  clearHuddleNavigation(): void { this.world.huddleNavigation = undefined; this.emit(); }
  askHooks(): void {
    const requestId = this.nextRequestId("hooks");
    // Class rule: always spread the prior hooks bag. A list answer must never
    // replace world.hooks with a two-field object and wipe audit/pending/test.
    this.world.hooks = { ...this.world.hooks, asked: false, requestId, list: [], problem: undefined };
    const sent = this.ask({ type: "hooks", requestId }, {
      answers: f => f.type === "hooks" && f.requestId === requestId,
      answered: f => {
        if (f.type === "hooks" && this.world.hooks.requestId === requestId) {
          this.world.hooks = keepHooksBag(this.world.hooks, { asked: true, list: f.hooks, problem: undefined });
        }
      },
      refused: why => {
        if (this.world.hooks.requestId === requestId) {
          this.world.hooks = keepHooksBag(this.world.hooks, { asked: true, list: [], problem: why });
          this.emit();
        }
      },
      lost: () => {
        if (this.world.hooks.requestId === requestId) {
          this.world.hooks = keepHooksBag(this.world.hooks, { asked: true, list: [], problem: "the hub did not answer" });
          this.emit();
        }
      },
    });
    if (!sent && this.world.hooks.requestId === requestId) {
      this.world.hooks = keepHooksBag(this.world.hooks, { asked: true, list: [], problem: "not connected to the hub yet" });
      this.emit();
    }
  }
  askHooksAudit(): void {
    const requestId = this.nextRequestId("hooksAudit");
    this.world.hooks = { ...this.world.hooks, auditRequestId: requestId, auditAsked: true, auditLoading: true, auditProblem: undefined };
    const sent = this.ask({ type: "hooksAudit", requestId }, {
      answers: f => f.type === "hookAudit" && f.requestId === requestId,
      answered: f => { if (f.type === "hookAudit" && this.world.hooks.auditRequestId === requestId) this.world.hooks = { ...this.world.hooks, auditRequestId: undefined, auditLoading: false, audit: f.entries, auditProblem: undefined }; },
      refused: why => { if (this.world.hooks.auditRequestId === requestId) this.world.hooks = { ...this.world.hooks, auditRequestId: undefined, auditLoading: false, auditProblem: why }; this.emit(); },
      lost: () => { if (this.world.hooks.auditRequestId === requestId) this.world.hooks = { ...this.world.hooks, auditRequestId: undefined, auditLoading: false, auditProblem: "the hub did not answer" }; this.emit(); },
    });
    if (!sent && this.world.hooks.auditRequestId === requestId) this.world.hooks = { ...this.world.hooks, auditRequestId: undefined, auditLoading: false, auditProblem: "not connected to the hub yet" };
    this.emit();
  }
  private hookMutation(frame: ClientFrame, requestId: ID): void {
    this.world.hooks = { ...this.world.hooks, mutationRequestId: requestId, pending: { ...this.world.hooks.pending, [requestId]: true }, problem: undefined };
    const sent = this.send({ ...frame, requestId } as ClientFrame);
    if (!sent) {
      const pending = { ...this.world.hooks.pending }; delete pending[requestId];
      this.world.hooks = { ...this.world.hooks, mutationRequestId: Object.keys(pending).at(-1), pending, problem: "not connected to the hub yet" };
    }
    this.emit();
  }
  createHook(hook: Omit<StoredHook, "id" | "ownerId" | "updatedAt">): void { const requestId = this.nextRequestId("createHook"); this.hookMutation({ type: "createHook", hook }, requestId); }
  updateHook(hookId: ID, hook: Partial<Pick<StoredHook, "name" | "event" | "when" | "action">>): void { const requestId = this.nextRequestId("updateHook"); this.hookMutation({ type: "updateHook", hookId, hook }, requestId); }
  setHookEnabled(hookId: ID, enabled: boolean): void { const requestId = this.nextRequestId("setHookEnabled"); this.hookMutation({ type: "setHookEnabled", hookId, enabled }, requestId); }
  deleteHook(hookId: ID): void { const requestId = this.nextRequestId("deleteHook"); this.hookMutation({ type: "deleteHook", hookId }, requestId); }
  testHook(hookId: ID): void { const requestId = this.nextRequestId("testHook"); this.hookMutation({ type: "testHook", hookId }, requestId); }

  askSocialProjects(): void {
    const requestId = this.nextRequestId("socialProjects");
    this.world.socialProjects = { ...this.world.socialProjects, requestId };
    this.emit();
    this.ask({ type: "socialProjects", requestId }, {
      answers: f => f.type === "socialProjects" && f.requestId === requestId,
      answered: f => {
        if (f.type !== "socialProjects") return;
        this.world.socialProjects = { asked: true, list: f.projects, requestId: undefined };
        this.emit();
      },
      refused: () => { this.world.socialProjects = { ...this.world.socialProjects, asked: true }; this.emit(); },
      lost: () => { this.world.socialProjects = { ...this.world.socialProjects, asked: true }; this.emit(); },
    });
  }

  socialFor(projectId: ID): {
    asked: boolean; loading: boolean; posts: SocialPost[]; hasMore: boolean;
    nextBefore?: number; nextBeforeId?: ID; unread: number; problem?: string;
  } {
    return this.world.socialFeeds[projectId] ?? {
      asked: false, loading: false, posts: [], hasMore: true, unread: 0,
    };
  }

  askSocialFeed(projectId: ID, older = false): void {
    const current = this.socialFor(projectId);
    if (current.loading) return;
    const requestId = this.nextRequestId("socialList");
    const frame: ClientFrame = older
      ? {
          type: "socialList", projectId,
          requestId,
          ...(current.nextBefore !== undefined ? { before: current.nextBefore } : {}),
          ...(current.nextBeforeId !== undefined ? { beforeId: current.nextBeforeId } : {}),
        }
      : { type: "socialList", projectId, requestId };
    this.world.socialFeeds = {
      ...this.world.socialFeeds, [projectId]: { ...current, loading: true, problem: undefined, requestId },
    };
    this.emit();
    const settle = (problem?: string): void => {
      const now = this.socialFor(projectId);
      this.world.socialFeeds = {
        ...this.world.socialFeeds, [projectId]: { ...now, asked: true, loading: false, ...(problem ? { problem } : {}) },
      };
      this.emit();
    };
    const sent = this.ask(frame, {
      answers: f => f.type === "socialFeed" && f.projectId === projectId && f.requestId === requestId,
      answered: () => { /* applied in onFrame so pushed answers are identical */ },
      refused: settle,
      lost: () => settle("the hub did not answer — is it still running?"),
    });
    if (!sent) settle("not connected to the hub yet");
  }

  createSocialPost(projectId: ID, text: string, parentId?: ID, links?: SocialLink[]): ID | false {
    const bad = validateSocialText(text) ?? validateSocialLinks(links);
    if (this.refused(bad)) return false;
    return this.socialMutation({ type: "socialCreate", projectId, text, ...(parentId ? { parentId } : {}), ...(links?.length ? { links } : {}) });
  }

  editSocialPost(postId: ID, text: string): boolean {
    if (this.refused(validateSocialText(text))) return false;
    return this.socialMutation({ type: "socialEdit", postId, text }) !== false;
  }

  deleteSocialPost(postId: ID): void {
    this.socialMutation({ type: "socialDelete", postId });
  }

  reactSocialPost(postId: ID, emoji: string, on = true): void {
    this.socialMutation({ type: "socialReact", postId, emoji, on });
  }

  markSocialRead(projectId: ID, at?: number): void {
    this.socialMutation({ type: "socialMarkRead", projectId, ...(at !== undefined ? { at } : {}) });
  }

  /* ---------------- Engineering Pulse ---------------- */

  askPulse(projectId?: ID): void {
    // A newer list supersedes the older one. Its late answer may still settle
    // its timer, but it must not replace the newer projection.
    this.world.pulse = { ...this.world.pulse, requestId: undefined,
      loading: true, problem: undefined,
      ...(projectId ? { projectId } : {}) };
    this.emit();
    const requestId = this.nextRequestId("pulseList");
    this.world.pulse = { ...this.world.pulse, requestId };
    const sent = this.ask({ type: "pulseList", ...(projectId ? { projectId } : {}), requestId }, {
      answers: f => f.type === "pulse" && f.requestId === requestId
        && (projectId === undefined || f.projectId === projectId),
      answered: f => {
        if (f.type !== "pulse" || this.world.pulse.requestId !== requestId) return;
        this.world.pulse = {
          asked: true, loading: false, updates: f.updates,
          unreadByProject: f.unreadByProject, projects: f.projects,
          requestId,
          ...(f.projectId ? { projectId: f.projectId } : {}),
        };
      },
      refused: why => {
        if (this.world.pulse.requestId !== requestId) return;
        this.world.pulse = { ...this.world.pulse, asked: true, loading: false, requestId: undefined, problem: why };
        this.emit();
      },
      lost: () => {
        if (this.world.pulse.requestId !== requestId) return;
        this.world.pulse = { ...this.world.pulse, asked: true, loading: false, requestId: undefined,
          problem: "the hub did not answer - is it still running?" };
        this.emit();
      },
    });
    if (!sent) {
      this.world.pulse = { ...this.world.pulse, asked: true, loading: false, requestId: undefined,
        problem: "connect to Cloud9 before loading Engineering Pulse updates" };
      this.emit();
    }
  }

  createPulse(projectId: ID, draft: EngineeringPulseDraft, agentId?: ID, onRefused?: (why: string) => void): ID | undefined {
    const bad = validateEngineeringPulseDraft(draft);
    if (this.refused(bad, onRefused)) return undefined;
    this.world.pulse = { ...this.world.pulse, loading: true, problem: undefined };
    this.emit();
    const requestId = this.nextRequestId("pulseCreate");
    this.pulseMutationRequestId = requestId;
    const sent = this.ask({ type: "pulseCreate", projectId, draft, ...(agentId ? { agentId } : {}), requestId }, {
      answers: f => f.type === "pulseChanged" && f.requestId === requestId
        && f.update.projectId === projectId && f.update.authorId === (agentId ?? this.world.me?.id),
      answered: () => {
        if (this.pulseMutationRequestId !== requestId) return;
        this.pulseAcceptedRequestId = requestId;
        this.pulseMutationRequestId = undefined;
        this.world.pulse = { ...this.world.pulse, loading: false, asked: true, problem: undefined, mutationSuccessId: requestId }; this.emit();
      },
      refused: why => {
        if (this.pulseMutationRequestId !== requestId) return;
        this.pulseMutationRequestId = undefined;
        this.world.pulse = { ...this.world.pulse, loading: false, problem: why }; onRefused?.(why); this.emit();
      },
      lost: () => { const why = "the hub did not answer - is it still running?";
        if (this.pulseMutationRequestId !== requestId) return;
        this.pulseMutationRequestId = undefined;
        this.world.pulse = { ...this.world.pulse, loading: false, problem: why }; onRefused?.(why); this.emit(); },
    });
    if (!sent) {
      if (this.pulseMutationRequestId === requestId) this.pulseMutationRequestId = undefined;
      this.world.pulse = { ...this.world.pulse, loading: false,
        problem: "connect to Cloud9 before saving this update" };
      this.emit();
    }
    return sent ? requestId : undefined;
  }

  updatePulse(updateId: ID, patch: Partial<EngineeringPulseDraft>, onRefused?: (why: string) => void): ID | undefined {
    this.world.pulse = { ...this.world.pulse, loading: true, problem: undefined };
    this.emit();
    const requestId = this.nextRequestId("pulseUpdate");
    this.pulseMutationRequestId = requestId;
    // Related links: when the editor touches a key, send value-or-null so
    // JSON.stringify cannot drop a clear. Untouched keys stay omitted (keep).
    const safePatch: Partial<EngineeringPulseDraft> = { ...patch };
    if ("relatedTaskId" in patch) safePatch.relatedTaskId = patch.relatedTaskId ?? null;
    if ("relatedRunId" in patch) safePatch.relatedRunId = patch.relatedRunId ?? null;
    if ("relatedProjectItem" in patch) safePatch.relatedProjectItem = patch.relatedProjectItem ?? null;
    const sent = this.ask({ type: "pulseUpdate", updateId, patch: safePatch, requestId }, {
      answers: f => f.type === "pulseChanged" && f.requestId === requestId && f.update.id === updateId,
      answered: () => {
        if (this.pulseMutationRequestId !== requestId) return;
        this.pulseAcceptedRequestId = requestId;
        this.pulseMutationRequestId = undefined;
        this.world.pulse = { ...this.world.pulse, loading: false, problem: undefined, mutationSuccessId: requestId }; this.emit();
      },
      refused: why => {
        if (this.pulseMutationRequestId !== requestId) return;
        this.pulseMutationRequestId = undefined;
        this.world.pulse = { ...this.world.pulse, loading: false, problem: why }; onRefused?.(why); this.emit();
      },
      lost: () => { const why = "the hub did not answer - is it still running?";
        if (this.pulseMutationRequestId !== requestId) return;
        this.pulseMutationRequestId = undefined;
        this.world.pulse = { ...this.world.pulse, loading: false, problem: why }; onRefused?.(why); this.emit(); },
    });
    if (!sent) {
      if (this.pulseMutationRequestId === requestId) this.pulseMutationRequestId = undefined;
      this.world.pulse = { ...this.world.pulse, loading: false,
        problem: "connect to Cloud9 before saving this update" };
      this.emit();
    }
    return sent ? requestId : undefined;
  }

  deletePulse(updateId: ID, onRefused?: (why: string) => void): ID | undefined {
    this.world.pulse = { ...this.world.pulse, loading: true, problem: undefined };
    this.emit();
    const requestId = this.nextRequestId("pulseDelete");
    this.pulseMutationRequestId = requestId;
    const sent = this.ask({ type: "pulseDelete", updateId, requestId }, {
      answers: f => f.type === "pulseChanged" && f.requestId === requestId && f.update.id === updateId,
      answered: () => {
        if (this.pulseMutationRequestId !== requestId) return;
        this.pulseAcceptedRequestId = requestId;
        this.pulseMutationRequestId = undefined;
        this.world.pulse = { ...this.world.pulse, loading: false, problem: undefined, mutationSuccessId: requestId }; this.emit();
      },
      refused: why => {
        if (this.pulseMutationRequestId !== requestId) return;
        this.pulseMutationRequestId = undefined;
        this.world.pulse = { ...this.world.pulse, loading: false, problem: why }; onRefused?.(why); this.emit();
      },
      lost: () => { const why = "the hub did not answer - is it still running?";
        if (this.pulseMutationRequestId !== requestId) return;
        this.pulseMutationRequestId = undefined;
        this.world.pulse = { ...this.world.pulse, loading: false, problem: why }; onRefused?.(why); this.emit(); },
    });
    if (!sent) {
      if (this.pulseMutationRequestId === requestId) this.pulseMutationRequestId = undefined;
      this.world.pulse = { ...this.world.pulse, loading: false,
        problem: "connect to Cloud9 before deleting this update" };
      this.emit();
    }
    return sent ? requestId : undefined;
  }

  markPulseRead(projectId: ID, at = Date.now()): void {
    const safeAt = Number.isFinite(at) ? Math.min(Math.max(0, Math.floor(at)), Date.now()) : Date.now();
    const requestId = this.send({ type: "pulseRead", projectId, at: safeAt });
    if (requestId) this.pulseReadRequests.add(requestId);
  }

  /**
   * "LOOK AT GITHUB NOW" for one project.
   *
   * This app still never reaches GitHub. It asks the hub, the hub asks the
   * engine on this computer, and the engine runs `gh` with the sign-in that is
   * already here. Everything that comes back arrives on the ordinary `project`
   * and `projectItems` frames, so there is nothing to apply here.
   *
   * The BUTTON'S STATE is not invented either: the hub marks the project
   * `looking` while a look is in flight and clears it when the engine answers
   * or stops answering. A spinner this app started itself would have no way to
   * end. The refusal is handed back so the screen can print the hub's own
   * sentence — "nothing is running on this computer to ask GitHub" is the one a
   * person can actually act on.
   */
  lookAtProject(projectId: ID, onRefused?: (why: string) => void): void {
    const sent = this.ask({ type: "syncProject", projectId }, {
      answers: f => f.type === "project" && f.project.id === projectId,
      refused: why => onRefused?.(why),
      lost: () => onRefused?.("the hub did not answer — is it still running?"),
    });
    if (!sent) onRefused?.("not connected to the hub yet");
  }

  /**
   * Connect a repository, named the way `gh` names one.
   *
   * The refusal is the hub's own sentence, handed back to the caller so the
   * form can print it where the person is looking instead of only in the toast
   * that floats above every screen.
   */
  connectProject(
    repo: string,
    extra: { name?: string; description?: string; channelId?: ID } = {},
    onRefused?: (why: string) => void,
  ): void {
    /* Checked HERE, in the store, so no form can forget to — and through the
       same `refused` the composer and every other box goes through, so there is
       one answer to "what happens to what he typed when it is refused". */
    if (this.refused(validateRepo(repo) ?? validateProjectText(extra.name, extra.description),
      onRefused)) return;
    const sent = this.ask({ type: "connectProject", repo, ...extra }, {
      answers: f => f.type === "project",
      refused: why => onRefused?.(why),
      lost: () => onRefused?.("the hub did not answer — is it still running?"),
    });
    if (!sent) onRefused?.("not connected to the hub yet");
  }

  /**
   * ASK FOR HIS OWN REPOSITORIES — the picker's one way in.
   *
   * This app still never reaches GitHub. It asks the hub, the hub asks the copy
   * of Cloud9 on the computer that holds the GitHub sign-in, and `gh repo list`
   * runs there. Everything comes back on the `repositories` frame, so there is
   * nothing to apply here beyond saying we are asking.
   *
   * A refusal or a silence both leave `asking` false and `asked` true: we asked
   * and got nothing, which the panel says in words — the typed field below it
   * keeps working either way, which is the whole point of keeping it.
   */
  askRepositories(): void {
    this.world.repoChoices = { ...this.world.repoChoices, asked: true, asking: true };
    const settle = (problem: string): void => {
      this.world.repoChoices = { asked: true, asking: false, problem };
      this.emit();
    };
    const sent = this.ask({ type: "listRepositories" }, {
      answers: f => f.type === "repositories",
      // applied in `apply`, because a `repositories` frame reaches every window
      // this person has open, not only the one that asked
      answered: () => { /* see apply() */ },
      refused: why => settle(why),
      lost: () => settle("the hub did not answer — is it still running?"),
    });
    if (!sent) settle("not connected to the hub yet");
    else this.emit();
  }

  /**
   * SAY WHERE THIS PROJECT'S CODE LIVES on this computer. `""` unlinks it.
   *
   * The path is checked HERE as well as at the hub — the same function, so
   * there is one rule — because the answer he needs is in the panel he is
   * looking at, not only in the toast above it.
   */
  setProjectFolder(projectId: ID, folder: string, onRefused?: (why: string) => void): void {
    const path = folder.trim();
    if (path && this.refused(validateLocalFolder(path), onRefused)) return;
    const sent = this.ask({ type: "setProjectFolder", projectId, path }, {
      answers: f => f.type === "project" && f.project.id === projectId,
      refused: why => onRefused?.(why),
      lost: () => onRefused?.("the hub did not answer — is it still running?"),
    });
    if (!sent) onRefused?.("not connected to the hub yet");
  }

  /* ---------------- attaching a file ---------------- */

  private uploadQueue: Array<{ channelId: ID; localId: string; frame: ClientFrame }> = [];
  /** the one upload the hub is working on — see `attach` for why there is only one */
  private uploading: { channelId: ID; localId: string } | null = null;

  private setUploads(channelId: ID, next: Upload[]): void {
    this.world.uploads = { ...this.world.uploads, [channelId]: next };
  }

  private patchUpload(channelId: ID, localId: string, patch: Partial<Upload>): void {
    const list = this.world.uploads[channelId] ?? [];
    this.setUploads(channelId, list.map(u => (u.localId === localId ? { ...u, ...patch } : u)));
  }

  /**
   * Put one picked file on the hub, ready to be named in a `send`.
   *
   * ONE AT A TIME, deliberately. The `attachment` frame that answers an upload
   * carries no echo of what was asked, and neither does the `error` frame that
   * refuses one — so two uploads in the air at once could not be told apart,
   * and a refusal would be pinned on the wrong file. A queue costs a moment on
   * a second file and buys an answer that is always about the right one.
   */
  attach(channelId: ID, file: File): void {
    const localId = `up_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    const list = this.world.uploads[channelId] ?? [];
    // The same ceilings the hub holds, asked here first so a 10 MB file is
    // refused in the moment it is picked rather than after it has been read,
    // encoded and sent. `validateAttachment` is the hub's own function — there
    // is no second copy of the rule in this app.
    const already = list.filter(u => u.state !== "failed").length;
    if (already >= ATTACHMENT_LIMITS.perMessage) {
      this.notify(`that's the most files one message can carry (${ATTACHMENT_LIMITS.perMessage})`);
      return;
    }
    const refusal = validateAttachment(file.name, file.size);
    if (refusal) {
      this.setUploads(channelId,
        [...list, { localId, name: file.name, size: file.size, state: "failed", error: refusal }]);
      this.emit();
      return;
    }
    this.setUploads(channelId,
      [...list, { localId, name: file.name, size: file.size, state: "sending" }]);
    this.emit();

    const reader = new FileReader();
    reader.onerror = () => {
      this.patchUpload(channelId, localId, { state: "failed", error: "that file could not be read" });
      this.emit();
    };
    reader.onload = () => {
      const asUrl = String(reader.result ?? "");
      const comma = asUrl.indexOf(",");
      if (comma < 0) {
        this.patchUpload(channelId, localId, { state: "failed", error: "that file could not be read" });
        this.emit();
        return;
      }
      this.uploadQueue.push({
        channelId, localId,
        frame: {
          type: "uploadAttachment", channelId, name: file.name,
          dataBase64: asUrl.slice(comma + 1), mime: file.type || undefined,
        },
      });
      this.pumpUploads();
    };
    reader.readAsDataURL(file);
  }

  private pumpUploads(): void {
    if (this.uploading) return;
    const next = this.uploadQueue.shift();
    if (!next) return;
    const up = { channelId: next.channelId, localId: next.localId };
    this.uploading = up;
    /* Only ever about THIS file. Both of these are reached from the request
       ledger, so they are called for this upload's own answer and for nothing
       else — an unrelated refusal cannot get in here at all. */
    const failed = (why: string): void => {
      if (this.uploading !== up) return;
      this.uploading = null;
      this.patchUpload(up.channelId, up.localId, { state: "failed", error: why });
      this.emit();
      this.pumpUploads();
    };
    const sent = this.ask(next.frame, {
      answers: f => f.type === "attachment",
      answered: f => {
        if (this.uploading !== up || f.type !== "attachment") return;
        this.uploading = null;
        this.patchUpload(up.channelId, up.localId,
          { state: "done", attachmentId: f.attachment.id });
        this.pumpUploads();
      },
      refused: failed,
      lost: () => failed("the hub never answered about this file — take it off and try again"),
    });
    if (!sent) failed("there's no connection to the hub — take the file off and try again");
  }

  /** Take one picked file back out before the message is sent. */
  dropUpload(channelId: ID, localId: string): void {
    this.uploadQueue = this.uploadQueue.filter(q => q.localId !== localId);
    this.setUploads(channelId, (this.world.uploads[channelId] ?? []).filter(u => u.localId !== localId));
    this.emit();
  }

  /** The ids to name in `send` — only the files that really landed. */
  uploadIds(channelId: ID): ID[] {
    return (this.world.uploads[channelId] ?? [])
      .filter(u => u.state === "done" && u.attachmentId)
      .map(u => u.attachmentId!);
  }

  /**
   * How many files have been READ and are waiting their turn on the wire.
   *
   * Not the same as "a file is in the tray": a tray tile appears the moment a
   * file is picked, long before it has been read. Only a file that is already
   * queued will be put on the wire the instant the one ahead of it is answered
   * — which is the exact moment a refusal meant for something else used to land
   * on it — so this is what a test of that has to wait for.
   */
  queuedUploads(): number {
    return this.uploadQueue.length;
  }

  /** How many files in this conversation's tray are still on their way up. */
  uploadsInFlight(channelId: ID): number {
    return (this.world.uploads[channelId] ?? []).filter(u => u.state === "sending").length;
  }

  /**
   * MAY THIS MESSAGE GO YET, AND WITH WHICH FILES?
   *
   * The one owner of that question, so every way of sending — the button, the
   * Enter key, a thread's own box — gets the same answer. Pressing Enter used
   * to take the files that had landed, empty the tray, and send: a file still
   * going up was thrown away without a word, and it finished uploading into
   * nothing. Nothing is ever discarded in silence; a message that cannot go yet
   * is refused in a sentence, and the file stays exactly where it is.
   */
  readyToSend(channelId: ID, hasWords: boolean): { ok: boolean; ids: ID[]; why?: string } {
    const waiting = this.uploadsInFlight(channelId);
    if (waiting > 0) {
      return {
        ok: false, ids: [],
        why: waiting === 1
          ? "that file is still going up — give it a moment, or take it off"
          : `those ${waiting} files are still going up — give them a moment, or take them off`,
      };
    }
    const ids = this.uploadIds(channelId);
    if (!hasWords && ids.length === 0) return { ok: false, ids: [] };
    return { ok: true, ids };
  }

  /** The tray is emptied once its files have gone out with a message. */
  clearUploads(channelId: ID): void {
    if (!this.world.uploads[channelId]) return;
    const { [channelId]: gone, ...rest } = this.world.uploads;
    void gone;
    this.world.uploads = rest;
    this.emit();
  }

  /* ---------------- getting an attached file back ---------------- */

  /** where the active hub's own HTTP lives — follows whichever hub is live */
  private hubHttp(): string {
    return this.currentUrl.replace(/^ws/, "http");
  }

  /**
   * Ask for permission to fetch ONE file, ONCE.
   *
   * Asked at the moment of the click and never at render: a ticket minted when
   * a message scrolls into view is dead thirty seconds later, and a screenful
   * of messages would mint more of them than the hub will hold.
   *
   * There used to be a separate queue of waiters here, and an `error` frame
   * rejected the OLDEST of them whatever the error was actually about. It goes
   * through the one request ledger now (see `asked`), which knows whose refusal
   * a refusal is — and matches the ticket that comes back to the file it is for.
   */
  private mintTicket(attachmentId: ID): Promise<{ url: string; expiresAt: number }> {
    return this.askTicket(
      { type: "attachmentTicket", attachmentId },
      f => f.type === "attachmentTicket" && f.attachmentId === attachmentId);
  }

  /**
   * ONE OWNER OF "ASK FOR PERMISSION TO FETCH SOMETHING, ONCE".
   *
   * A person's attachment and a file an agent made are two kinds of thing with
   * ONE download endpoint behind them (`artifact-store-handoff.md` §4), so they
   * get one way of asking as well: the same request ledger, the same twenty
   * seconds, the same three ways it can end, and the same rule that a refusal
   * is the hub's own sentence handed back rather than a paraphrase. A second
   * copy of this would be a second set of behaviour to get right.
   */
  private askTicket(
    frame: ClientFrame, answers: (f: ServerFrame) => boolean,
  ): Promise<{ url: string; expiresAt: number }> {
    return new Promise((resolve, reject) => {
      let done = false;
      const once = (fn: () => void): void => { if (!done) { done = true; fn(); } };
      const sent = this.ask(frame, {
        answers,
        answered: f => once(() => {
          if (f.type === "attachmentTicket" || f.type === "artifactTicket") {
            resolve({ url: f.url, expiresAt: f.expiresAt });
          }
        }),
        refused: why => once(() => reject(new Error(why))),
        lost: () => once(() => reject(new Error("the hub didn't answer — try again"))),
      });
      if (!sent) once(() => reject(new Error("there's no connection to the hub — try again in a moment")));
    });
  }

  /**
   * Ask for permission to fetch ONE version of a file an agent made.
   *
   * No version means the newest, which is what a card drawn from a reference in
   * a message wants. A version that the hub no longer keeps is NOT quietly
   * swapped for the newest — the hub refuses with its own sentence naming both
   * numbers, and that sentence is what the screen shows.
   */
  private mintArtifactTicket(artifactId: ID, version?: number): Promise<{ url: string; expiresAt: number }> {
    return this.askTicket(
      { type: "artifactTicket", artifactId, ...(version === undefined ? {} : { version }) },
      f => f.type === "artifactTicket" && f.artifactId === artifactId
        && (version === undefined || f.version === version));
  }

  /**
   * One ticket to one file, as a whole URL.
   *
   * The same mint the buttons use, exposed so the QA suite can fetch a file
   * back over the real HTTP path and check the bytes against what it sent —
   * "a link appeared" is not evidence that a file came back.
   */
  async ticketFor(attachmentId: ID): Promise<{ url: string; expiresAt: number }> {
    const t = await this.mintTicket(attachmentId);
    return { url: this.hubHttp() + t.url, expiresAt: t.expiresAt };
  }

  /** The attachment ids whose bytes this screen is currently holding. */
  openFileIds(): ID[] {
    return Object.keys(this.world.files);
  }

  private setFile(id: ID, next: OpenFile): void {
    this.world.files = { ...this.world.files, [id]: next };
    this.emit();
  }

  /**
   * Get one attached file's bytes and keep them for the life of this screen.
   *
   * The rules that are not negotiable (§9.3):
   *  - ONE fetch per ticket. The first request spends it.
   *  - A `404` is the ONLY failure the hub reports, and it means "spent, expired
   *    or no longer yours". The recovery is a NEW ticket, not an error message —
   *    so that is what happens here, once, before anything is said to anyone.
   *  - Because the hub answers `no-store`, this cache IS the cache. A second
   *    click on the same file must not re-ticket.
   */
  async openFile(a: Attachment): Promise<void> {
    await this.fetchTicketed(a.id, () => this.mintTicket(a.id));
  }

  /**
   * The body of `openFile`, with the question of WHICH ticket left to the caller.
   *
   * There is one download endpoint behind an attachment and an artifact alike,
   * so there is one place that spends a ticket, retries the one failure worth
   * retrying, and decides what a person is told when it still will not come.
   *
   * @param asText read the bytes back as words too, for a screen that may show
   *               them. Only ever passed when the HUB said these bytes are text.
   */
  private async fetchTicketed(
    key: ID, mint: () => Promise<{ url: string }>, asText = false,
  ): Promise<void> {
    const held = this.world.files[key];
    if (held && (held.state === "ready" || held.state === "opening")) return;
    this.setFile(key, { state: "opening" });

    const fetchOnce = async (): Promise<Response> => {
      const t = await mint();
      return fetch(this.hubHttp() + t.url);
    };

    try {
      /**
       * ONE ROUTE, whatever address the hub is on.
       *
       * There used to be a second one here: when the hub answered from its own
       * origin, the page could not READ a cross-origin response, so the ticket
       * was handed to an `<img>` instead of fetched. The hub now sends the
       * cross-origin headers on the download (`chat-basics-handoff.md` §9.9),
       * so that branch was a workaround for a problem that no longer exists —
       * and a second route is a second set of behaviour to get right. Every
       * file now takes the intended path: fetch, blob, revoke on close.
       */
      let res = await fetchOnce();
      // 404 means the ticket was spent or has expired. Ask for another and
      // try once more — showing a person an error here would be showing them
      // a problem the app can fix by itself.
      if (res.status === 404) res = await fetchOnce();
      if (!res.ok) {
        this.setFile(key, { state: "failed", error: "that link has expired — open the file again" });
        return;
      }
      const blob = await res.blob();
      const text = asText ? await blob.text() : undefined;
      this.setFile(key, {
        state: "ready", url: URL.createObjectURL(blob),
        ...(text === undefined ? {} : { text }),
      });
    } catch (err) {
      this.setFile(key, {
        state: "failed",
        error: (err as Error).message || "that file could not be opened",
      });
    }
  }

  /**
   * Save an attached file — the browser's (or Electron's) own download path.
   *
   * A download is a navigation, not a read, so it needs no blob and nothing to
   * free afterwards. The ticket is minted here, at the click.
   */
  async saveFile(a: Attachment): Promise<void> {
    await this.downloadTicketed(a.id, a.name, () => this.mintTicket(a.id));
  }

  /**
   * The body of `saveFile`, with the ticket left to the caller — the same one
   * owner as `fetchTicketed`, for the same reason.
   *
   * The fallback sentence is not decoration. A browser exception can carry an
   * EMPTY message, and this line used to print it: a "failed" banner with no
   * words beside it (the gap audit's 4.6). A failure that says nothing is the
   * silence this whole app is against, so there is always a sentence.
   */
  private async downloadTicketed(
    key: ID, name: string, mint: () => Promise<{ url: string }>,
  ): Promise<void> {
    this.setFile(key, { state: "opening" });
    try {
      const t = await mint();
      const link = document.createElement("a");
      link.href = this.hubHttp() + t.url;
      link.download = name;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      this.setFile(key, { state: "ready", url: link.href, direct: true });
    } catch (err) {
      this.setFile(key, {
        state: "failed",
        error: (err as Error).message || "that file could not be saved",
      });
    }
  }

  /* ---------------- files an AGENT made ----------------
   *
   * The screen half of the shared artifact store. Everything below reads the
   * shapes in `@cloud9/shared` and the frames in
   * `docs/plans/artifact-store-handoff.md`; nothing here invents a field, and
   * the BYTES take the attachment's own road — one endpoint, one ticket, one
   * use, thirty seconds, permission checked twice.
   */

  private requestSequence = 0;
  private accessSave?: ArtifactAccessSaveState;

  artifactAccessSaveState(): ArtifactAccessSaveState | undefined {
    return this.accessSave ? { ...this.accessSave } : undefined;
  }

  private nextRequestId(kind: ClientFrame["type"] | "workspace" | "access"): ID {
    this.requestSequence++;
    return `rq_${kind}_${Date.now().toString(36)}_${this.requestSequence.toString(36)}`;
  }

  /** A newer first-page ask makes any older page still in flight stale. */
  private artifactWorkspaceEpoch = 0;
  /** Every privacy invalidation advances this; old detail answers cannot repopulate it. */
  private artifactRelationGeneration = 0;
  /** One stale detail frame is discarded as a whole before it can regress metadata. */
  private discardArtifactDetailFrames = new Set<ID>();

  /** The current bounded cross-room index, answered or not. */
  artifactWorkspace(): ArtifactWorkspacePage {
    return this.world.artifactWorkspace;
  }

  /**
   * Ask for the newest Files page, or the next page using the hub's cursor.
   *
   * Reset clears the previous answer rather than presenting yesterday's rows as
   * today's while the hub is still being asked. Older pages append by id and
   * never make the list unbounded: every request uses the shared default limit.
   */
  askArtifactWorkspace(reset = false): void {
    const held = this.world.artifactWorkspace;
    /* A fresh entry supersedes an older-page request already in flight. Its epoch
       makes the old answer harmless; refusing the reset here skipped the fresh
       page entirely and let the stale answer append after re-entry. */
    if (!reset && held.loading) return;
    if (!reset && held.asked && !held.hasMore) return;
    const limit = ARTIFACT_LIMITS.workspaceDefault;
    const epoch = reset ? ++this.artifactWorkspaceEpoch : this.artifactWorkspaceEpoch;
    const cursor = reset ? undefined : held.nextBefore;
    const cursorId = reset ? undefined : held.nextBeforeId;
    this.world.artifactWorkspace = reset
      ? emptyArtifactWorkspace(true)
      : { ...held, loading: true, problem: undefined };
    this.emit();

    const settleProblem = (problem: string): void => {
      if (epoch !== this.artifactWorkspaceEpoch) return;
      this.world.artifactWorkspace = {
        ...this.world.artifactWorkspace,
        asked: true, loading: false, checkedAt: Date.now(), problem,
      };
      this.emit();
    };
    const requestId = this.nextRequestId("workspace");
    const sent = this.ask({
      type: "artifactWorkspace", requestId,
      ...(cursor === undefined ? {} : { before: cursor }),
      ...(cursorId === undefined ? {} : { beforeId: cursorId }),
      limit,
    }, {
      answers: f => f.type === "artifactWorkspace" && f.requestId === requestId,
      answered: f => {
        if (epoch !== this.artifactWorkspaceEpoch || f.type !== "artifactWorkspace"
          || f.requestId !== requestId) return;
        const current = this.world.artifactWorkspace;
        const before = reset ? [] : current.entries;
        const seen = new Set(f.artifacts.map(a => a.artifactId));
        const capacity = reset ? limit : current.capacity + limit;
        const merged = [...before.filter(a => !seen.has(a.artifactId)), ...f.artifacts];
        this.world.artifactWorkspace = {
          asked: true, loading: false, capacity,
          entries: merged.slice(0, capacity),
          hasMore: f.hasMore || merged.length > capacity,
          nextBefore: f.nextBefore,
          nextBeforeId: f.nextBeforeId,
          checkedAt: Date.now(),
        };
      },
      refused: settleProblem,
      lost: () => settleProblem("the hub did not answer — try again"),
    });
    if (!sent) settleProblem("there's no connection to the hub — try again in a moment");
  }

  /** One file an agent made, if this screen is holding it. */
  artifact(artifactId: ID): Artifact | undefined {
    return this.world.artifacts[artifactId];
  }

  /** undefined = not loaded; [] = loaded and there are no permitted links. */
  relationsFor(artifactId: ID): ArtifactRelationView[] | undefined {
    return this.world.artifactRelations[artifactId];
  }

  relationsTruncated(artifactId: ID): boolean {
    return !!this.world.artifactRelationsTruncated[artifactId];
  }

  artifactDetailProblem(artifactId: ID): string | undefined {
    return this.world.artifactDetailProblems[artifactId];
  }

  /**
   * ONE PRIVACY RULE FOR RELATION VIEWS.
   *
   * Any artifact publish, permission change or disappearance can change both its
   * outgoing rows and another file's incoming rows. No cached relation view can
   * prove it is unaffected, so all of them go. The selected detail asks again;
   * until it answers, no old target name/id/version remains in the world.
   */
  private invalidateArtifactRelations(): void {
    this.artifactRelationGeneration++;
    this.world.artifactRelations = {};
    this.world.artifactRelationsTruncated = {};
    /* A new artifact fact is also a reason to retry a detail that previously
       timed out; leaving the old problem would block the required fresh ask. */
    this.world.artifactDetailProblems = {};
    this.artifactDetailAsked.clear();
  }

  /** ids already asked for, so a render cannot ask for the same one twice */
  private artifactAsked = new Set<ID>();
  /** ids with a current relation view installed */
  private artifactDetailAsked = new Set<ID>();
  /** detail questions already on the wire — invalidating a cache must not duplicate them */
  private artifactDetailInFlight = new Set<ID>();

  /**
   * Ask for one file an agent made, by id — the card behind a reference.
   *
   * Asked ONCE per id for the life of this screen, the same way a run record
   * is: a card that re-asked on every render would put a frame on the wire for
   * every message drawn. It does not go stale, because a NEW version of the
   * file arrives here unasked on an `artifact` frame the moment it is published.
   *
   * A file this person may not read and one that never existed get the same
   * sentence from the hub, deliberately, so an id cannot be probed. Both mean
   * the same thing to a screen — it is not there — and saying so is better than
   * a card that spins for ever on an answer that already came.
   */
  askArtifact(artifactId: ID): void {
    if (this.world.artifacts[artifactId] || this.artifactAsked.has(artifactId)) return;
    this.artifactAsked.add(artifactId);
    if (!this.requestArtifact(artifactId, false)) this.artifactAsked.delete(artifactId);
  }

  /**
   * Ask for full detail even when a summary or pushed artifact is already held.
   * The workspace needs relation views, and those are intentionally loaded only
   * when a row opens rather than multiplied across every list row.
   */
  askArtifactDetail(artifactId: ID): void {
    if (this.artifactDetailInFlight.has(artifactId)) return;
    if (this.artifactDetailAsked.has(artifactId)
      && Object.prototype.hasOwnProperty.call(this.world.artifactRelations, artifactId)) return;
    const hadProblem = !!this.world.artifactDetailProblems[artifactId];
    if (hadProblem) {
      const { [artifactId]: oldProblem, ...rest } = this.world.artifactDetailProblems;
      void oldProblem;
      this.world.artifactDetailProblems = rest;
    }
    this.artifactDetailInFlight.add(artifactId);
    const relationGeneration = this.artifactRelationGeneration;
    if (!this.requestArtifact(artifactId, true, relationGeneration)) {
      this.artifactDetailInFlight.delete(artifactId);
      this.world.artifactDetailProblems = {
        ...this.world.artifactDetailProblems,
        [artifactId]: "there's no connection to the hub — try again in a moment",
      };
      this.emit();
    } else if (hadProblem) this.emit();
  }

  /** One request path; detail upgrades the answer by claiming relation views. */
  private requestArtifact(artifactId: ID, detail: boolean, relationGeneration?: number): boolean {
    const gone = (): void => this.forgetArtifact(artifactId);
    const lost = (): void => {
      if (!detail) {
        this.artifactAsked.delete(artifactId);
        return;
      }
      /* A pushed artifact may already have installed a newer safe relation view
         while this older question was waiting. Its silence cannot overwrite that
         fresh answer with an error. */
      this.artifactDetailInFlight.delete(artifactId);
      if (Object.prototype.hasOwnProperty.call(this.world.artifactRelations, artifactId)) return;
      /* Silence is not proof of absence. Keep the valid workspace row and make
         the failure retryable instead of turning it into the non-probing gone state. */
      this.artifactDetailAsked.delete(artifactId);
      this.world.artifactDetailProblems = {
        ...this.world.artifactDetailProblems,
        [artifactId]: "the hub did not answer — try again",
      };
      this.emit();
    };
    const requestId = this.nextRequestId("artifact");
    return this.ask({ type: "artifact", artifactId, requestId }, {
      answers: f => f.type === "artifact" && f.artifact.id === artifactId
        && f.requestId === requestId,
      answered: detail ? f => {
        if (f.type !== "artifact") return;
        this.artifactDetailInFlight.delete(artifactId);
        /* onFrame invalidates once for THIS artifact frame before settling it.
           Anything beyond that one generation means another publish/access/role
           fact landed after the question was asked, so this projection is stale. */
        if (relationGeneration === undefined
          || this.artifactRelationGeneration !== relationGeneration + 1) {
          this.artifactDetailAsked.delete(artifactId);
          this.discardArtifactDetailFrames.add(artifactId);
          return;
        }
        /* The relay omits an empty relation array. The fact this was the answer
           to a DETAIL ask is what makes absence mean "looked, and there are none"
           rather than "this pushed update did not include relation views". */
        this.world.artifactRelations = {
          ...this.world.artifactRelations,
          [artifactId]: f.relations ?? [],
        };
        if (f.relationsTruncated === true) {
          this.world.artifactRelationsTruncated = {
            ...this.world.artifactRelationsTruncated, [artifactId]: true,
          };
        }
        const { [artifactId]: oldProblem, ...rest } = this.world.artifactDetailProblems;
        void oldProblem;
        this.world.artifactDetailProblems = rest;
        /* onFrame invalidates before settle; this successful detail answer owns
           the fresh cache and must mark it held again. */
        this.artifactDetailAsked.add(artifactId);
      } : undefined,
      refused: gone,
      lost,
    });
  }

  /**
   * Change who may read this whole immutable version chain. The relay is still
   * the gate; callbacks only keep the editor's Save state honest.
   */
  setArtifactAccess(
    artifactId: ID, access: ArtifactAccess,
    onDone?: () => void, onRefused?: (why: string) => void,
  ): void {
    const requestId = this.nextRequestId("access");
    this.accessSave = {
      artifactId, requestId, state: "pending", pushesWhilePending: 0,
    };
    const sent = this.ask({ type: "setArtifactAccess", artifactId, access, requestId }, {
      /* Same-file publish/role pushes deliberately omit requestId. They may
         refresh caches but can never complete this save or steal its refusal. */
      answers: f => f.type === "artifact" && f.artifact.id === artifactId
        && f.requestId === requestId,
      answered: () => {
        if (this.accessSave?.requestId === requestId) {
          this.accessSave = { ...this.accessSave, state: "succeeded" };
        }
        onDone?.();
      },
      refused: why => {
        if (this.accessSave?.requestId === requestId) {
          this.accessSave = { ...this.accessSave, state: "refused", problem: why };
        }
        onRefused?.(why);
      },
      lost: () => {
        const why = "the hub did not answer — try again";
        if (this.accessSave?.requestId === requestId) {
          this.accessSave = { ...this.accessSave, state: "lost", problem: why };
        }
        onRefused?.(why);
        this.emit();
      },
    });
    if (!sent) {
      const why = "there's no connection to the hub — try again in a moment";
      this.accessSave = { ...this.accessSave, state: "lost", problem: why };
      onRefused?.(why);
      this.emit();
    }
  }

  /** Every file agents have made in one conversation, answered or not. */
  artifactsIn(channelId: ID): { asked: boolean; list: Artifact[] } {
    const held = this.world.channelArtifacts[channelId] ?? { asked: false, ids: [] };
    return {
      asked: held.asked,
      list: held.ids.map(id => this.world.artifacts[id]).filter((a): a is Artifact => !!a),
    };
  }

  /**
   * Ask what files agents have made in one conversation.
   *
   * Asked every time the list is opened, like the projects list and for the
   * same reason: a room gains files while nobody is looking at it, and a list
   * cached from the last visit would be an answer to an older question. A
   * refusal and a silence both mark it `asked` — the screen must not be left
   * spinning on either, and the hub's own sentence is already on screen through
   * `lastError`.
   */
  askArtifacts(channelId: ID): void {
    const settled = (): void => {
      const held = this.world.channelArtifacts[channelId] ?? { asked: false, ids: [] };
      this.world.channelArtifacts = {
        ...this.world.channelArtifacts, [channelId]: { ...held, asked: true },
      };
      this.emit();
    };
    this.ask({ type: "artifacts", channelId }, {
      answers: f => f.type === "artifacts" && f.channelId === channelId,
      answered: f => {
        if (f.type !== "artifacts") return;
        this.holdArtifacts(f.channelId, f.artifacts, true);
      },
      refused: settled,
      lost: settled,
    });
  }

  /** Build the list summary from a full artifact pushed while Files is open. */
  private workspaceEntryOf(artifact: Artifact): ArtifactWorkspaceEntry | undefined {
    const latest = latestVersion(artifact);
    const channel = this.world.channels.find(c => c.id === artifact.channelId);
    if (!latest || !channel) return undefined;
    return {
      artifactId: artifact.id,
      channelId: artifact.channelId,
      channelName: channel.name,
      name: artifact.name,
      latest,
      versionCount: latest.version,
      access: effectiveArtifactAccess(artifact.access),
      updatedAt: artifact.updatedAt,
    };
  }

  /** Pushed versions move their summaries to the front in one list rewrite. */
  private holdWorkspaceArtifacts(artifacts: Artifact[]): void {
    const held = this.world.artifactWorkspace;
    if (!held.asked) return;
    const incoming = artifacts
      .map(a => this.workspaceEntryOf(a))
      .filter((a): a is ArtifactWorkspaceEntry => !!a);
    if (incoming.length === 0) return;
    const ids = new Set(incoming.map(a => a.artifactId));
    const merged = [...incoming, ...held.entries.filter(a => !ids.has(a.artifactId))]
      .sort((a, b) => b.updatedAt - a.updatedAt || b.artifactId.localeCompare(a.artifactId));
    const overflow = merged.length > held.capacity;
    const entries = merged.slice(0, held.capacity);
    const tail = entries[entries.length - 1];
    const retryOlder = overflow && held.loading && held.asked;
    if (retryOlder) this.artifactWorkspaceEpoch++;
    this.world.artifactWorkspace = {
      ...held,
      entries,
      loading: retryOlder ? false : held.loading,
      // If a live push displaced the tail, an older row still exists even when
      // the last requested page had reached the former end. Move the cursor to
      // the NEW retained tail so the displaced row is the next page, not skipped.
      hasMore: held.hasMore || overflow,
      nextBefore: overflow && tail ? tail.updatedAt : held.nextBefore,
      nextBeforeId: overflow && tail ? tail.artifactId : held.nextBeforeId,
    };
    /* The in-flight older ask used the former tail and can never return the row
       just displaced by this push. Supersede it and ask again from the new tail. */
    if (retryOlder) this.askArtifactWorkspace(false);
  }

  /** Inaccessible and nonexistent are the same state on this screen. */
  private forgetArtifact(artifactId: ID, notify = true): void {
    this.forgetArtifacts(new Set([artifactId]), notify);
  }

  /** Remove one or a roomful from every artifact index in one pass. */
  private forgetArtifacts(ids: Set<ID>, notify = true): void {
    if (ids.size === 0) return;
    const w = this.world;
    this.invalidateArtifactRelations();
    w.artifacts = Object.fromEntries(
      Object.entries(w.artifacts).filter(([id]) => !ids.has(id)));
    w.artifactDetailProblems = Object.fromEntries(
      Object.entries(w.artifactDetailProblems).filter(([id]) => !ids.has(id)));
    w.channelArtifacts = Object.fromEntries(
      Object.entries(w.channelArtifacts).map(([channelId, room]) => [
        channelId, { ...room, ids: room.ids.filter(id => !ids.has(id)) },
      ]));
    w.artifactWorkspace = {
      ...w.artifactWorkspace,
      entries: w.artifactWorkspace.entries.filter(a => !ids.has(a.artifactId)),
    };
    w.artifactsGone = { ...w.artifactsGone };
    for (const id of ids) {
      w.artifactsGone[id] = true;
      this.artifactAsked.add(id);
      /* If access is restored later the hub pushes the artifact again. Its detail
         must be allowed to load anew; a revoked relation cache is not a lifetime
         answer about that id. */
      this.artifactDetailAsked.delete(id);
      this.artifactDetailInFlight.delete(id);
    }
    if (notify) this.emit();
  }

  /**
   * Put artifacts into the world — the ONE way any of them gets there.
   *
   * @param complete true only for an answer to `artifacts`, which really is the
   *                 whole list for that room. A single pushed file is proof of
   *                 itself and never proof that we know them all, so it adds an
   *                 id and leaves `asked` exactly where it was.
   */
  private holdArtifacts(channelId: ID, list: Artifact[], complete: boolean): void {
    const w = this.world;
    const held = w.channelArtifacts[channelId] ?? { asked: false, ids: [] };
    const artifacts = { ...w.artifacts };
    const detailProblems = { ...w.artifactDetailProblems };
    for (const a of list) {
      artifacts[a.id] = a;
      delete detailProblems[a.id];
    }
    w.artifacts = artifacts;
    w.artifactDetailProblems = detailProblems;
    this.holdWorkspaceArtifacts(list);
    // an artifact that turned up is not missing, whatever an older ask decided
    if (list.some(a => w.artifactsGone[a.id])) {
      const kept: Record<ID, true> = { ...w.artifactsGone };
      for (const a of list) delete kept[a.id];
      w.artifactsGone = kept;
    }
    const ids = complete
      ? list.map(a => a.id)
      // NEWEST CHANGE FIRST, the same order the hub answers `artifacts` in —
      // an updated file moves to the front rather than sitting where its first
      // version happened to land.
      : [...list.map(a => a.id), ...held.ids.filter(id => !list.some(a => a.id === id))];
    w.channelArtifacts = {
      ...w.channelArtifacts,
      [channelId]: { asked: complete || held.asked, ids },
    };
  }

  /**
   * Open one version of a file an agent made — its bytes, into this screen.
   *
   * Held under the VERSION's id, not the artifact's: version 2 and version 3 of
   * one file are two different sets of bytes, and one blob standing for both
   * would show him the wrong one the moment he looked back at an older version.
   * That is also why the same holder-counting and the same revoke apply — this
   * is the attachment's own road, reached from a different door.
   */
  async openArtifact(artifact: Artifact, version: ArtifactVersion): Promise<void> {
    await this.fetchTicketed(
      version.id,
      () => this.mintArtifactTicket(artifact.id, version.version),
      // WHETHER THIS IS TEXT IS THE HUB'S ANSWER ABOUT THE BYTES, never a guess
      // from the name. A binary called `.md` is still a download.
      version.text);
  }

  /** Save one version of a file an agent made — the browser's own download. */
  async saveArtifact(artifact: Artifact, version: ArtifactVersion): Promise<void> {
    await this.downloadTicketed(
      version.id, artifact.name,
      () => this.mintArtifactTicket(artifact.id, version.version));
  }

  /**
   * One ticket to one version, as a whole URL.
   *
   * The same mint the buttons use, exposed for the same reason `ticketFor` is:
   * the QA suite fetches the bytes back over the real HTTP path and compares
   * them with what the agent published. "A card appeared" is not evidence that
   * a file came back.
   */
  async artifactTicketFor(artifactId: ID, version?: number): Promise<{ url: string; expiresAt: number }> {
    const t = await this.mintArtifactTicket(artifactId, version);
    return { url: this.hubHttp() + t.url, expiresAt: t.expiresAt };
  }

  /** May this file be drawn where it sits, or must it be saved first? */
  canShowInline(a: Attachment): boolean {
    return isInlineViewable(a.name);
  }

  /**
   * HOW MANY PLACES ON SCREEN ARE SHOWING EACH OPENED FILE.
   *
   * The same message is drawn in more than one place at once — in the
   * conversation and again in an open thread — and each copy showed the same
   * picture from the same `blob:` URL. Whichever copy went away first used to
   * revoke it, and the picture still on screen in the other one turned into a
   * broken image: closing a thread panel wiped a picture out of the room
   * behind it.
   *
   * Ownership of a held thing cannot be "whoever let go of it first". Every
   * copy that shows a file takes a hold; the bytes are freed when the LAST one
   * lets go, and not before.
   */
  private fileHolders = new Map<ID, number>();

  /** "I am showing this file, so keep its bytes alive." Paired with `releaseFile`. */
  holdFile(id: ID): void {
    this.fileHolders.set(id, (this.fileHolders.get(id) ?? 0) + 1);
  }

  /** "I have stopped showing it." The bytes go only when nobody is left holding them. */
  releaseFile(id: ID): void {
    const left = (this.fileHolders.get(id) ?? 0) - 1;
    if (left > 0) { this.fileHolders.set(id, left); return; }
    this.fileHolders.delete(id);
    this.closeFile(id);
  }

  /** how many places are showing one file — the QA suite asks, so the count is provable */
  holdersOf(id: ID): number {
    return this.fileHolders.get(id) ?? 0;
  }

  /**
   * Let one opened file go, everywhere, now.
   *
   * This is what "Hide" means, and it is a DELIBERATE act: the picture goes
   * from every place it was showing, because the file itself is dropped from
   * the world and no copy has anything left to draw. A copy merely going off
   * screen is not this — that is `releaseFile`, which waits for the last one.
   */
  closeFile(id: ID): void {
    const held = this.world.files[id];
    if (!held) return;
    if (held.url && !held.direct) URL.revokeObjectURL(held.url);
    const { [id]: gone, ...rest } = this.world.files;
    void gone;
    this.world.files = rest;
    this.emit();
  }

  private onFrame(frame: ServerFrame): void {
    const w = this.world;
    this.seen[frame.type] = (this.seen[frame.type] ?? 0) + 1;
    if (frame.type === "artifact" && frame.requestId === undefined
      && this.accessSave?.state === "pending"
      && this.accessSave.artifactId === frame.artifact.id) {
      this.accessSave = {
        ...this.accessSave,
        pushesWhilePending: this.accessSave.pushesWhilePending + 1,
      };
    }
    /* Relationship views name OTHER files. A change to one artifact can make a
       cached row on any artifact unsafe, so privacy invalidation happens before
       the answer callback can install the one freshly-projected detail response. */
    if (frame.type === "artifact" || frame.type === "artifactUnavailable") {
      this.invalidateArtifactRelations();
    }
    /* Hand this to whatever asked for it, FIRST — a reply is applied by the
       request that wanted it, and one nobody is waiting for any more is not
       applied at all. Refusals are the exception and are matched below, where
       the sentence they carry can also be put on screen. */
    if (frame.type !== "error") this.settle(frame);
    switch (frame.type) {
      case "welcome": {
        // The snapshot is durable state, never a continuation of a transient
        // tool stream. Begin each admitted session with a quiet activity cache.
        clearLiveSteps();
        w.connected = true;
        w.authFailed = false;
        // The hub has let us in — and only now is the credential that got us
        // here allowed anywhere near storage. One owner, one moment.
        this.adoptCredential();
        w.me = frame.state.me;
        w.users = frame.state.users;
        w.agents = frame.state.agents;
        w.channels = frame.state.channels;
        w.agentStatus = frame.state.agentStatus;
        // A hub from before presence existed sends nothing here. Empty is the
        // honest landing place: every row then says "we have not looked yet"
        // rather than a green dot nobody stood behind.
        w.presence = frame.state.presence ?? {};
        w.tasks = frame.state.tasks;
        w.approvals = frame.state.approvals;
        w.notifications = frame.state.notifications ?? [];
        w.notificationsAsked = true;
        w.notificationsLoading = false;
        w.notificationsRequestId = undefined;
        w.notificationsProblem = undefined;
        w.workflows = [...(frame.state.workflows ?? [])].sort(workflowOrder);
        w.workflowRuns = frame.state.workflowRuns ?? [];
        // A reconnect starts a new request epoch. Do not let a stale response
        // from the old socket match run/archive/stop/retry bookkeeping.
        this.workflowRequests.clear();
        this.pulseMutationRequestId = undefined;
        this.pulseAcceptedRequestId = undefined;
        this.pulseReadRequests.clear();
        // The welcome snapshot is a useful seed, but the owner still asks for
        // the canonical workflow list. Keep the route in loading until that
        // correlated answer arrives so an empty seed never flashes as truth.
        w.workflowLoading = true;
        w.savedMessages = frame.state.savedMessages ?? [];
        w.savedLoading = false;
        w.savedAsked = false;
        w.savedRequestId = undefined;
        w.savedProblem = undefined;
        w.savedNotice = undefined;
        w.savedRevision = 0;
        w.savedHasMore = false;
        w.savedNextSavedAt = undefined;
        w.savedNextMessageId = undefined;
        w.savedPending = [];
        w.savedNew = false;
        w.pulse = {
          asked: true, loading: false, updates: frame.state.pulse?.updates ?? [],
          unreadByProject: frame.state.pulse?.unreadByProject ?? {}, projects: frame.state.pulse?.projects ?? [],
          requestId: undefined,
        };
        w.messages = {};
        for (const m of frame.state.messages) {
          (w.messages[m.channelId] ??= []).push(m);
        }
        // a fresh world means fresh cursors: the pages we walked back through
        // belonged to the last connection
        w.pages = {};
        w.threads = {};
        w.unread = {};
        // Everything derived from the last connection goes with it. Blob URLs
        // are freed rather than dropped, or a reconnect would leak every
        // picture the last session opened.
        for (const id of Object.keys(w.files)) {
          const f = w.files[id];
          if (f.url && !f.direct) URL.revokeObjectURL(f.url);
        }
        w.files = {};
        w.members = {};
        w.directory = { asked: false, channels: [] };
        // Records belonged to the last connection too. Keeping them would mean
        // drawing an agent's work from a world this screen is no longer in.
        w.runs = {};
        w.runLists = {};
        w.runsGone = {};
        this.runAsked.clear();
        // Projects belonged to the last connection too, and `asked` goes back
        // to false with them: this world has not asked anything yet, so the
        // screen must say "looking" rather than "you have none".
        w.projects = { asked: false, list: [] };
        w.forumProjects = { asked: false, projects: [] };
        w.forumFeeds = {};
        w.forumTopicRequests = {};
        w.forumReplies = {};
        w.forumUnavailableProjects = {};
        w.forumMembersByProject = {};
        w.projectItems = {};
        w.publicUpdates = { asked: false, drafts: [], revisions: [], audit: [] };
        w.huddles = { asked: false, sessions: [] };
        w.huddleProjects = { asked: false, list: [] };
        w.huddleMutations = {};
        w.huddleNotes = {};
        w.huddleNavigation = undefined;
        w.hooks = { asked: false, list: [] };
        w.socialProjects = { asked: false, list: [] };
        w.socialUnread = {};
        w.socialPending = {};
        w.socialCompleted = undefined;
        w.socialProblem = undefined;
        w.socialFeeds = {};
        // Files agents made belonged to the last connection too, and `asked`
        // goes back to false with them: this world has not asked anything yet,
        // so a room's file list says "looking" rather than "there are none".
        w.artifacts = {};
        w.artifactsGone = {};
        w.channelArtifacts = {};
        w.artifactWorkspace = emptyArtifactWorkspace();
        w.artifactRelations = {};
        w.artifactRelationsTruncated = {};
        w.artifactDetailProblems = {};
        this.artifactWorkspaceEpoch++;
        this.artifactRelationGeneration++;
        this.accessSave = undefined;
        this.discardArtifactDetailFrames.clear();
        this.artifactAsked.clear();
        this.artifactDetailAsked.clear();
        this.artifactDetailInFlight.clear();
        // Memory belonged to the last connection too, and `asked` goes back to
        // false with it: this world has not asked anything yet, so a panel says
        // "loading" rather than the honest empty state it has not earned.
        w.memory = {};
        for (const entry of frame.state.unread ?? []) w.unread[entry.channelId] = entry;
        // The one-time catch-up's receipt, if this hub ran it just now. It is a
        // fact about THIS connection like everything else above, so a reconnect
        // to a hub that has nothing to say clears it rather than leaving a
        // notice on screen about something that has already been told.
        w.reachCatchup = frame.state.reachCatchup;
        break;
      }
      case "notificationInbox":
        /* An inbox answer is a projection of one exact request. A response
           from an older request (or an old relay with no id) must not regress
           a newer list or clear its loading state. */
        if (frame.requestId === undefined || frame.requestId !== w.notificationsRequestId) break;
        w.notifications = [...frame.entries];
        w.notificationsAsked = true;
        w.notificationsLoading = false;
        w.notificationsProblem = undefined;
        break;
      case "notificationUpdated": {
        // The normal inbox view does not request dismissed rows.  Remove one
        // immediately when the relay confirms dismissal; keeping it visible
        // until reconnect would make the Dismiss action look ineffective.
        if (frame.entry.state === "dismissed") {
          w.notifications = w.notifications.filter(entry => entry.id !== frame.entry.id);
          break;
        }
        const i = w.notifications.findIndex(entry => entry.id === frame.entry.id);
        w.notifications = i < 0
          ? [frame.entry, ...w.notifications]
          : w.notifications.map((entry, index) => index === i ? frame.entry : entry);
        break;
      }
      case "savedMessages": {
        const previous = w.savedMessages;
        if (frame.requestId !== undefined) {
          if (!this.savedRequests.has(frame.requestId)) break;
          this.savedRequests.delete(frame.requestId);
          if (w.savedRequestId === frame.requestId) {
            w.savedLoading = false;
            w.savedRequestId = undefined;
            w.savedProblem = undefined;
          }
        } else if (w.savedRequestId !== undefined) {
          // A no-id mirror arriving while this window is asking cannot outrank
          // the correlated answer; leave ordering to that request.
          break;
        } else if (frame.revision !== undefined && frame.revision < w.savedRevision) {
          // A late push from the same socket must not regress a newer snapshot.
          break;
        } else if (previous.length !== frame.entries.length || frame.entries.some((entry, index) => {
          const old = previous[index];
          return !old || old.id !== entry.id || old.state !== entry.state || old.savedAt !== entry.savedAt;
        })) {
          // A same-count replacement (save A after unsaving B) is still new.
          // Compare stable row identity/state rather than only the list length.
          w.savedNew = true;
        }
        w.savedRevision = frame.revision ?? w.savedRevision;
        w.savedHasMore = frame.hasMore ?? false;
        w.savedNextSavedAt = frame.nextSavedAt;
        w.savedNextMessageId = frame.nextMessageId;
        w.savedMessages = [...frame.entries];
        break;
      }
      case "token":
        // HELD, NOT WRITTEN. The hub has minted a credential for this attempt,
        // but the attempt is not a session until `welcome` arrives — and until
        // then the credential that was already working stays exactly as it is.
        // `adoptCredential` files it, against the hub that issued it.
        this.issued = frame.token;
        break;
      case "joinToken":
        // A minted "invite a friend" link. The code alone opens the door, so it
        // is held only long enough for the screen to wrap it into a link and is
        // never logged.
        w.joinToken = { code: frame.code, expiresInMs: frame.expiresInMs, ts: Date.now() };
        break;
      case "message": {
        // new arrays, not in-place pushes: the UI compares references to decide
        // what to recompute, so a mutated-in-place list looks like "no change"
        const cid = frame.message.channelId;
        w.messages = { ...w.messages, [cid]: [...(w.messages[cid] ?? []), frame.message] };
        // A reply belongs to its thread as well as to the room. Without this
        // the open thread panel would sit there missing the very reply that was
        // just typed into it, until somebody closed and reopened it.
        const root = frame.message.replyTo;
        if (root && w.threads[root] && !w.threads[root].some(m => m.id === frame.message.id)) {
          w.threads = { ...w.threads, [root]: [...w.threads[root], frame.message] };
        }
        break;
      }
      case "channel": {
        const i = w.channels.findIndex(c => c.id === frame.channel.id);
        if (i >= 0) w.channels[i] = frame.channel; else w.channels.push(frame.channel);
        w.channels = [...w.channels];
        // A room arriving for the FIRST time is a room we just joined, so the
        // browse list — which only ever shows rooms you are not in — has gone
        // stale. Only on arrival: a topic change must not reset it.
        if (i < 0) w.directory = { asked: false, channels: [] };
        w.lastChannel = { id: frame.channel.id, ts: Date.now() };
        const stillVisible = frame.channel.memberIds.includes(w.me?.id ?? "")
          || frame.channel.memberIds.some(memberId =>
            w.agents.some(agent => agent.id === memberId && agent.ownerId === w.me?.id));
        if (!stillVisible) {
          w.savedMessages = w.savedMessages.map(entry => entry.channelId === frame.channel.id
            ? { ...entry, state: "inaccessible", message: undefined }
            : entry);
        }
        break;
      }
      case "agent": {
        const i = w.agents.findIndex(a => a.id === frame.agent.id);
        if (i >= 0) w.agents[i] = frame.agent; else w.agents.push(frame.agent);
        w.agents = [...w.agents];
        break;
      }
      case "agentDeleted": {
        w.agents = w.agents.filter(a => a.id !== frame.agentId);
        // a deleted agent's presence is not a fact about anything any more
        const { [frame.agentId]: _gone, ...rest } = w.presence;
        w.presence = rest;
        this.forgetRunsOf(frame.agentId);
        break;
      }
      case "agentStatus":
        w.agentStatus = { ...w.agentStatus, [frame.agentId]: frame.status };
        // The SAME frame carries both halves, so the lamp and the words on the
        // row can never drift apart the way two frames would let them.
        w.presence = {
          ...w.presence,
          [frame.agentId]: {
            agentId: frame.agentId, status: frame.status,
            presence: frame.presence, reason: frame.reason, updatedAt: Date.now(),
          },
        };
        break;
      case "invite":
        w.inviteCode = frame.code;
        break;
      case "task": {
        const i = w.tasks.findIndex(t => t.id === frame.task.id);
        if (i >= 0) w.tasks[i] = frame.task; else w.tasks.unshift(frame.task);
        w.tasks = [...w.tasks];
        break;
      }
      case "approval": {
        const i = w.approvals.findIndex(a => a.id === frame.approval.id);
        if (i >= 0) w.approvals[i] = frame.approval; else w.approvals.push(frame.approval);
        w.approvals = [...w.approvals];
        break;
      }
      case "workflows":
        if (frame.requestId) {
          if (!this.workflowRequests.has(frame.requestId)) break;
          this.workflowRequests.delete(frame.requestId);
        }
        w.workflowError = undefined;
        w.workflowRetry = undefined;
        w.workflows = [...frame.workflows].sort(workflowOrder);
        w.workflowRuns = frame.runs;
        w.workflowLoading = false;
        break;
      case "workflow": {
        if (frame.requestId) {
          if (!this.workflowRequests.has(frame.requestId)) break;
          this.workflowRequests.delete(frame.requestId);
          w.workflowError = undefined;
          w.workflowRetry = undefined;
          w.workflowNotice = { text: "Workflow saved", ts: Date.now(), workflowId: frame.workflow.id };
        }
        const i = w.workflows.findIndex(x => x.id === frame.workflow.id);
        if (i >= 0) w.workflows[i] = frame.workflow; else w.workflows.unshift(frame.workflow);
        w.workflows = [...w.workflows].sort(workflowOrder);
        break;
      }
      case "workflowRun": {
        if (frame.requestId) {
          if (!this.workflowRequests.has(frame.requestId)) break;
          const request = this.workflowRequests.get(frame.requestId);
          this.workflowRequests.delete(frame.requestId);
          w.workflowError = undefined;
          w.workflowRetry = undefined;
          if (request?.type === "runWorkflow") {
            w.workflowNotice = { text: "Workflow run started", ts: Date.now() };
          }
        }
        const i = w.workflowRuns.findIndex(x => x.id === frame.run.id);
        if (i >= 0) w.workflowRuns[i] = frame.run; else w.workflowRuns.unshift(frame.run);
        // A transition on an older run can make it the newest receipt. Keep
        // the detail screen's first row aligned with relay's updatedAt order.
        w.workflowRuns = [...w.workflowRuns].sort((a, b) =>
          (b.updatedAt ?? b.finishedAt ?? b.createdAt) - (a.updatedAt ?? a.finishedAt ?? a.createdAt)
          || b.id.localeCompare(a.id));
        break;
      }
      case "activity":
        w.activity = frame.records;
        break;
      case "harness":
        w.harness = frame.state;
        break;
      case "history": {
        const existing = w.messages[frame.channelId] ?? [];
        const known = new Set(existing.map(m => m.id));
        const older = frame.messages.filter(m => !known.has(m.id));
        w.messages = {
          ...w.messages,
          // oldest first, prepended as-is — the relay already sorted them
          [frame.channelId]: [...older, ...existing],
        };
        this.setPage(frame.channelId, {
          hasMore: frame.hasMore,
          nextBefore: frame.nextBefore,
          nextBeforeId: frame.nextBeforeId,
          loading: false,
          asked: true,
        });
        // only a page that actually put messages ON THE FRONT moves the reader
        if (older.length > 0 && existing.length > 0) w.prepended += 1;
        break;
      }
      case "searchResults":
        /* Applied by the search that asked for it (see `search`), and by
           nothing else. A results frame for a search that has been cleared has
           nobody to give it to, so it is dropped here — which is the whole
           point: it used to land unconditionally and bring a search the reader
           had already closed back onto the screen, hits and all. */
        break;
      case "reaction":
        // A reaction frame is a FACT, not a delta: replace the list, never add
        this.applyReaction(frame.messageId, frame.emoji, frame.userIds);
        break;
      case "receipt":
        /* A SEMANTIC RECEIPT — live 👀 / 💭 / verdict. DELIBERATELY NOT PUT IN
           THE WORLD: it is ephemeral, the hub stores none of it, and anything
           that lands in `w` is a thing the rest of the app treats as real and
           lasting. It goes to its own small store in `receipts.tsx`, which
           throws it away on a timer and on reload. See that file's header. */
        noteReceipt(frame.receipt);
        break;
      case "liveSteps":
        /* WHAT AN AGENT IS DOING RIGHT NOW. Same law as `receipt` above, same
           reason: ephemeral, stored nowhere, kept out of `w` entirely. The
           STORED record still arrives as `runRecorded` when the turn ends and
           is what survives — this only fills the silence in between. Its own
           small store in `livesteps.ts`. */
        noteLiveSteps(frame.live);
        break;
      case "messageUpdated":
        this.replaceMessage(frame.message);
        if (frame.message.deletedAt) {
          w.savedMessages = w.savedMessages.map(entry => entry.messageId === frame.message.id
            ? { ...entry, state: "deleted", message: undefined }
            : entry);
        } else {
          w.savedMessages = w.savedMessages.map(entry => entry.messageId === frame.message.id
            ? { ...entry, state: "active", message: frame.message }
            : entry);
        }
        break;
      case "thread":
        w.threads = { ...w.threads, [frame.parentId]: frame.messages };
        break;
      case "read":
        // Apply unconditionally — this frame is how the other machine finds out
        w.unread = { ...w.unread, [frame.entry.channelId]: frame.entry };
        break;
      case "userJoined":
        w.users = [...w.users, frame.user];
        break;
      case "userRemoved": {
        // Removed means removed EVERYWHERE, now — not after a reload. The
        // sidebar, the @-mention list and the "Remove a person" dropdown all
        // read these two arrays, so dropping them here fixes every list at once.
        if (w.me && frame.userId === w.me.id) {
          // it was us: the relay has already closed the socket, so show the
          // welcome screen with a reason rather than an empty app
          w.authFailed = true;
          w.lastError = { text: "you were removed from this Cloud9", ts: Date.now() };
          break;
        }
        w.users = w.users.filter(u => u.id !== frame.userId);
        w.channels = w.channels.filter(
          c => !(c.kind === "dm" && c.memberIds.includes(frame.userId)));
        break;
      }
      case "forumProjects": {
        const projects = [...frame.projects].sort((a,b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
        const visible = new Set(projects.map(p => p.id));
        const unavailable = { ...w.forumUnavailableProjects };
        Object.keys(unavailable).forEach(id => { if (visible.has(id)) delete unavailable[id]; });
        w.forumUnavailableProjects = unavailable;
        const feeds = Object.fromEntries(Object.entries(w.forumFeeds).filter(([id]) => visible.has(id)));
        const replies = { ...w.forumReplies };
        for (const [id, feed] of Object.entries(w.forumFeeds)) if (!visible.has(id)) for (const topic of feed.topics) delete replies[topic.id];
        w.forumProjects={asked:true,projects}; w.forumFeeds=feeds; w.forumReplies=replies; break;
      }
      case "forumFeed": {
        const old=w.forumFeeds[frame.projectId]??{asked:false,loading:false,topics:[],unread:0};
        const topics = [...frame.topics].sort((a,b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
        w.forumFeeds={...w.forumFeeds,[frame.projectId]:{...old,asked:true,loading:false,topics,unread:frame.unread,selected:topics.some(t=>t.id===old.selected)?old.selected:topics[0]?.id}}; break;
      }
      case "forumTopic": {
        const projectId=frame.topic.projectId; const old=w.forumFeeds[projectId]??{asked:false,loading:false,topics:[],unread:0}; const i=old.topics.findIndex(t=>t.id===frame.topic.id); const topics=(i<0?[frame.topic,...old.topics]:old.topics.map(t=>t.id===frame.topic.id?frame.topic:t)).sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id)); w.forumFeeds={...w.forumFeeds,[projectId]:{...old,topics,selected:frame.topic.id}}; w.forumReplies={...w.forumReplies,[frame.topic.id]:frame.replies.sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id))}; break;
      }
      case "forumChanged": {
        const old=w.forumFeeds[frame.projectId]??{asked:true,loading:false,topics:[],unread:0}; let topics=old.topics; if(frame.topic){const i=topics.findIndex(t=>t.id===frame.topic!.id);topics=i<0?[frame.topic,...topics]:topics.map(t=>t.id===frame.topic!.id?frame.topic!:t);topics=[...topics].sort((a,b)=>b.createdAt-a.createdAt||b.id.localeCompare(a.id));} if(frame.reply){const list=w.forumReplies[frame.reply.topicId]??[]; const i=list.findIndex(r=>r.id===frame.reply!.id); const replies=i<0?[...list,frame.reply]:list.map(r=>r.id===frame.reply!.id?frame.reply!:r); w.forumReplies={...w.forumReplies,[frame.reply.topicId]:replies.sort((a,b)=>a.createdAt-b.createdAt||a.id.localeCompare(b.id))};} w.forumFeeds={...w.forumFeeds,[frame.projectId]:{...old,topics}}; break;
      }
      case "forumRead": { const old=w.forumFeeds[frame.entry.projectId]; if(old)w.forumFeeds={...w.forumFeeds,[frame.entry.projectId]:{...old,unread:frame.entry.unread}}; break; }
      case "forumUnavailable": { const old=w.forumFeeds[frame.projectId]; const ids=old?.topics.map(t=>t.id)??[]; const {[frame.projectId]:gone,...rest}=w.forumFeeds; void gone; const replies={...w.forumReplies}; ids.forEach(id=>delete replies[id]); w.forumFeeds=rest; w.forumReplies=replies; w.forumProjects={...w.forumProjects,projects:w.forumProjects.projects.filter(p=>p.id!==frame.projectId)}; break; }
      case "forumMembers": {
        w.forumMembersByProject = { ...w.forumMembersByProject, [frame.projectId]: frame.userIds };
        break;
      }

      case "error": {
        if (frame.requestId) {
          const workflowFrame = this.workflowRequests.get(frame.requestId);
          if (workflowFrame) {
            this.workflowRequests.delete(frame.requestId);
            if (workflowFrame.type === "listWorkflows") w.workflowLoading = false;
            w.workflowError = { text: frame.error, ts: Date.now(), requestId: frame.requestId };
            w.workflowRetry = workflowFrame;
          }
        }
        if (frame.requestId !== undefined && this.savedRequests.has(frame.requestId)) {
          const savedFrame = this.savedRequests.get(frame.requestId)!;
          this.savedRequests.delete(frame.requestId);
          w.savedProblem = frame.error;
          if (savedFrame.type === "listSaved" && w.savedRequestId === frame.requestId) {
            w.savedLoading = false;
            w.savedRequestId = undefined;
          }
        }
        w.lastError = { text: frame.error, ts: Date.now() };
        if (frame.requestId !== undefined && frame.requestId === w.notificationsRequestId) {
          w.notificationsLoading = false;
          w.notificationsProblem = frame.error;
        }
        if (frame.requestId !== undefined && w.hooks.pending?.[frame.requestId]) {
          const pending = { ...w.hooks.pending }; delete pending[frame.requestId];
          w.hooks = { ...w.hooks, mutationRequestId: Object.keys(pending).at(-1), pending, problem: frame.error };
        }
        if (frame.requestId !== undefined && frame.requestId === w.hooks.auditRequestId) {
          w.hooks = { ...w.hooks, auditRequestId: undefined, auditLoading: false, auditProblem: frame.error, audit: [] };
        }
        /* A direct refusal names its exact refusal-capable request. A legacy
           no-id refusal is shown here generally but cannot settle a modern row.
           Unrelated rows stay alive, including their timeout nets. */
        this.settleRefusal(frame);
        // WHOSE hub refused matters. On THIS computer's own hub, a refusal
        // before we were let in is a failed sign-in — back to the welcome
        // screen, where the reason is visible. On a FRIEND'S hub it must never
        // throw the person out of their own Cloud9: drop back to self, carrying
        // the friend's own words, so a bad or spent join link is explained
        // rather than dead-ending on an empty workspace.
        if (!w.me) {
          if (activeHub(this.book).isSelf) {
            // A refused attempt that had a working credential behind it goes
            // back in on that one instead of dumping the person on a sign-in
            // box with nothing left to type. Only when there is genuinely
            // nothing to fall back to is this a failed sign-in.
            if (!this.recoverPreviousCredential(frame.error)) w.authFailed = true;
          } else this.friendJoinFailed(frame.error);
        } else if (frame.error === "bad token") {
          w.authFailed = true;
        }
        break;
      }
      // Frames that are not ours to act on. Named, not defaulted, so the
      // exhaustiveness check below still holds.
      case "push":        // relay → mobile only
      case "harnessRequest": // relay → engine host only
      case "memoryListRequested": // relay → engine host only
      case "forgetMemoryRequested": // relay → engine host only
      case "handoffReceived":     // relay → the receiving agent's engine only
        break;
      case "memory":
        /* WHAT AN AGENT REMEMBERS. Applied here rather than only by `askMemory`,
           because a `memory` frame arrives UNASKED as well — the engine pushes
           it the moment a note is saved with "!remember" or cleared — and an
           open panel has to become the new list by itself. The store's order is
           kept as-is (oldest first); the panel decides how to show it. */
        w.memory = {
          ...w.memory,
          [frame.agentId]: { asked: true, loading: false, notes: frame.notes },
        };
        break;
      case "run":
        // Unasked or asked, new or already held — keyed by the record's OWN id,
        // so a run from a conversation this screen never opened still lands
        // somewhere findable rather than being dropped for not being expected.
        w.runs = { ...w.runs, [frame.record.id]: frame.record };
        break;
      // ===== SPENDING BLOCK (what the crew costs, 2026-08-07) =====
      case "spending":
        w.spending = { asked: true, loading: false, at: frame.at, rows: frame.rows };
        break;
      case "runs": {
        // The frame echoes back WHICH question it answers, so two lists in
        // flight cannot be mistaken for each other. One with neither is an
        // answer to nothing and is left alone.
        const key = frame.agentId ? `agent:${frame.agentId}`
          : frame.taskId ? `task:${frame.taskId}` : undefined;
        if (key) {
          w.runLists = { ...w.runLists, [key]: { asked: true, loading: false, entries: frame.runs } };
        }
        break;
      }
      // Both of these are the answer to one particular question and are applied
      // by the question that asked (see `pumpUploads` and `mintTicket`). One
      // that answers nothing outstanding is not ours to act on.
      case "attachment":
      case "attachmentTicket":
        break;
      case "channelDirectory":
        w.directory = { asked: true, channels: frame.channels };
        break;
      case "channelMembers":
        // Only the list of who is in the room NOW is kept here. An `at` list is
        // an answer to one question about one message, and holding it under the
        // room's id would quietly overwrite the room's real membership.
        if (frame.at === undefined) {
          const before = w.members[frame.channelId] ?? [];
          const membershipKey = (rows: ChannelMember[]): string => rows
            .map(m => `${m.memberId}:${m.role}:${m.removedAt ?? "here"}`)
            .sort().join("|");
          if (membershipKey(before) !== membershipKey(frame.members)) {
            /* Roles are part of file access: manager inclusion and relation
               visibility can change while memberIds stays identical. */
            this.invalidateArtifactRelations();
          }
          w.members = { ...w.members, [frame.channelId]: frame.members };
        }
        break;
      case "huddleProjects": w.huddleProjects={asked:true,list:frame.projects}; break;
      case "huddleList": w.huddles={asked:true,sessions:frame.sessions}; break;
      case "huddleSession": { w.huddles={asked:true,sessions:w.huddles.sessions.some(s=>s.id===frame.session.id)?w.huddles.sessions.map(s=>s.id===frame.session.id?frame.session:s):[frame.session,...w.huddles.sessions]}; w.huddleNotes={...w.huddleNotes,[frame.session.id]:frame.notes}; break; }
      case "huddleChanged": { const i=w.huddles.sessions.findIndex(s=>s.id===frame.session.id); w.huddles={asked:true,sessions:i<0?[frame.session,...w.huddles.sessions]:w.huddles.sessions.map(s=>s.id===frame.session.id?frame.session:s)}; if(frame.note){const list=w.huddleNotes[frame.session.id]??[]; const j=list.findIndex(n=>n.id===frame.note!.id); w.huddleNotes={...w.huddleNotes,[frame.session.id]:j<0?[...list,frame.note]:list.map(n=>n.id===frame.note!.id?frame.note!:n)};} break; }
      case "huddleRead": { const i=w.huddles.sessions.findIndex(s=>s.id===frame.entry.sessionId); if(i>=0)w.huddles={...w.huddles,sessions:w.huddles.sessions.map(s=>s.id===frame.entry.sessionId?{...s,unread:frame.entry.unread}:s)}; break; }
      case "huddleUnavailable": { w.huddles={...w.huddles,sessions:w.huddles.sessions.filter(s=>s.id!==frame.sessionId)}; const {[frame.sessionId]:goneNotes,...restNotes}=w.huddleNotes; void goneNotes; w.huddleNotes=restNotes; break; }
      case "huddleMembers": break;
      case "channelLeft": {
        // Out of the room means out of it NOW — not after a reload. Everything
        // cached for it goes with it, or the app would keep drawing a
        // conversation the relay will no longer answer about.
        w.channels = w.channels.filter(c => c.id !== frame.channelId);
        const { [frame.channelId]: goneMessages, ...restMessages } = w.messages;
        void goneMessages;
        w.messages = restMessages;
        const { [frame.channelId]: gonePage, ...restPages } = w.pages;
        void gonePage;
        w.pages = restPages;
        const { [frame.channelId]: goneUnread, ...restUnread } = w.unread;
        void goneUnread;
        w.unread = restUnread;
        const pulseProjects = new Set(w.pulse.projects.filter(p => p.id &&
          w.projects.list.some(project => project.id === p.id && project.channelId === frame.channelId)).map(p => p.id));
        if (pulseProjects.size > 0) {
          w.pulse = {
            ...w.pulse,
            updates: w.pulse.updates.filter(update => !pulseProjects.has(update.projectId)),
            unreadByProject: Object.fromEntries(Object.entries(w.pulse.unreadByProject)
              .filter(([id]) => !pulseProjects.has(id))),
          };
        }
        const { [frame.channelId]: goneMembers, ...restMembers } = w.members;
        void goneMembers;
        w.members = restMembers;
        const { [frame.channelId]: goneUploads, ...restUploads } = w.uploads;
        void goneUploads;
        w.uploads = restUploads;
        /* The room's files go with the room. The hub will refuse to ticket them
           now — permission is checked against membership at the moment of the
           click — so a list left on screen would be a list of dead buttons. */
        const { [frame.channelId]: goneArtifacts, ...restArtifacts } = w.channelArtifacts;
        void goneArtifacts;
        w.channelArtifacts = restArtifacts;
        const goneArtifactIds = new Set([
          ...Object.values(w.artifacts).filter(a => a.channelId === frame.channelId).map(a => a.id),
          ...w.artifactWorkspace.entries
            .filter(a => a.channelId === frame.channelId).map(a => a.artifactId),
        ]);
        this.forgetArtifacts(goneArtifactIds, false);
        // A room you just left may now be one you could join, so the browser's
        // list is no longer an answer to anything.
        w.directory = { asked: false, channels: [] };
        w.savedMessages = w.savedMessages.map(entry => entry.channelId === frame.channelId
          ? { ...entry, state: "inaccessible", message: undefined }
          : entry);

        // Projects linked to the room derive access from its membership. The
        // relay sends a revocation too, but purge by channel here so a window
        // cannot keep drawing a poll if the two frames arrive out of order.
        const linkedProjectIds = new Set(
          w.projects.list
            .filter(project => project.channelId === frame.channelId && project.ownerId !== w.me?.id)
            .map(project => project.id),
        );
        if (linkedProjectIds.size) {
          w.projects = {
            ...w.projects,
            list: w.projects.list.filter(project => !linkedProjectIds.has(project.id)),
          };
          const remainingItems = { ...w.projectItems };
          for (const projectId of linkedProjectIds) delete remainingItems[projectId];
          w.projectItems = remainingItems;
          if (w.polls.projectId && linkedProjectIds.has(w.polls.projectId)) {
            w.polls = { asked: true, list: [] };
          }
        }
        const removedHuddleProjects = new Set(w.huddleProjects.list.filter(p => p.channelId === frame.channelId && p.ownerId !== w.me?.id).map(p => p.id));
        w.huddleProjects = { ...w.huddleProjects, list: w.huddleProjects.list.filter(p => !removedHuddleProjects.has(p.id)) };
        const removedHuddles = w.huddles.sessions.filter(s => removedHuddleProjects.has(s.projectId));
        w.huddles = { ...w.huddles, sessions: w.huddles.sessions.filter(s => !removedHuddleProjects.has(s.projectId)) };
        for (const session of removedHuddles) { const { [session.id]: gone, ...rest } = w.huddleNotes; void gone; w.huddleNotes = rest; }
        break;
      }
      /* Projects. These four used to be dropped with a comment saying the
         Projects screen would claim them one day. It has. */
      case "project": {
        /* A `project` frame arrives UNASKED as well as in answer: connecting a
           repository, renaming it, and the engine reporting back what it found
           on GitHub all send the same frame to every window this person has
           open. So it is applied here rather than by whoever asked — and the
           list is marked `asked`, because a project we are holding is proof the
           hub has talked to us about projects. */
        const list = w.projects.list;
        const i = list.findIndex(p => p.id === frame.project.id);
        const next = i >= 0
          ? list.map(p => (p.id === frame.project.id ? frame.project : p))
          : [...list, frame.project];
        w.projects = { asked: true, list: next };
        break;
      }
      case "projects":
        // Applied by `askProjects`, which is the only thing that asks. A list
        // arriving for a question nobody is asking any more goes nowhere.
        break;
      case "projectForgotten": {
        w.projects = {
          ...w.projects,
          list: w.projects.list.filter(p => p.id !== frame.projectId),
        };
        // Its lists go with it, exactly as they do in the hub. Keeping them
        // would leave this screen able to draw pull requests for a repository
        // it is no longer connected to.
        const { [frame.projectId]: goneItems, ...restItems } = w.projectItems;
        void goneItems;
        w.projectItems = restItems;
        // Keep both Pulse and Huddles project caches in step when a project is forgotten.
        w.pulse = {
          ...w.pulse,
          projects: w.pulse.projects.filter(p => p.id !== frame.projectId),
          updates: w.pulse.updates.filter(update => update.projectId !== frame.projectId),
          unreadByProject: Object.fromEntries(Object.entries(w.pulse.unreadByProject)
            .filter(([id]) => id !== frame.projectId)),
        };
        if (w.polls.projectId === frame.projectId) w.polls = { asked: true, list: [] };
        if (w.canvases.projectId === frame.projectId) {
          w.canvases = { asked: true, list: [], history: [], problem: "this project is no longer connected" };
        }
        const removed = w.huddles.sessions.filter(s => s.projectId === frame.projectId);
        w.huddles = { ...w.huddles, sessions: w.huddles.sessions.filter(s => s.projectId !== frame.projectId) };
        for (const session of removed) { const { [session.id]: gone, ...rest } = w.huddleNotes; void gone; w.huddleNotes = rest; }
        w.huddleProjects = { ...w.huddleProjects, list: w.huddleProjects.list.filter(p => p.id !== frame.projectId) };
        break;
      }
      case "projectItems":
        /* Pushed UNASKED every time the engine re-syncs a project, as well as
           in answer to `askProjectItems`. Applied unconditionally for the same
           reason `read` is: this frame is how a window finds out that GitHub
           moved underneath it. */
        w.projectItems = {
          ...w.projectItems,
          [frame.projectId]: { asked: true, items: frame.items },
        };
        break;


      case "publicUpdates":
        w.publicUpdates = { ...w.publicUpdates, asked: true, drafts: frame.drafts };
        break;
      case "publicUpdate": {
        const drafts = w.publicUpdates.drafts;
        w.publicUpdates = {
          ...w.publicUpdates,
          asked: true,
          selected: frame.draft,
          revisions: frame.revisions,
          audit: frame.audit,
          drafts: drafts.some(d => d.id === frame.draft.id)
            ? drafts.map(d => d.id === frame.draft.id ? frame.draft : d)
            : [frame.draft, ...drafts],
        };
        break;
      }
      case "publicPublished": {
        // Keep the token so the screen can show the Cloud9 public link.
        const drafts = w.publicUpdates.drafts.map(d =>
          d.id === frame.revision.draftId
            ? { ...d, state: "published" as const, publicToken: frame.token, revision: frame.revision.revision, publishedAt: frame.revision.publishedAt }
            : d,
        );
        const selected = w.publicUpdates.selected?.id === frame.revision.draftId
          ? { ...w.publicUpdates.selected, state: "published" as const, publicToken: frame.token, revision: frame.revision.revision, publishedAt: frame.revision.publishedAt }
          : w.publicUpdates.selected;
        w.publicUpdates = {
          ...w.publicUpdates,
          drafts,
          selected,
          lastPublished: { draftId: frame.revision.draftId, token: frame.token, publicPath: frame.publicPath },
          revisions: w.publicUpdates.revisions.some(r => r.id === frame.revision.id)
            ? w.publicUpdates.revisions.map(r => r.id === frame.revision.id ? frame.revision : r)
            : [...w.publicUpdates.revisions, frame.revision],
        };
        break;
      }
      case "publicRoute":
        // Internal diagnostic frame — the real public surface is HTTP.
        break;

      case "polls":
        if (frame.requestId === undefined || frame.requestId !== w.polls.requestId) break;
        w.polls = { asked: true, projectId: frame.projectId, requestId: undefined, list: frame.polls };
        break;
      case "poll": {
        if (w.polls.projectId !== frame.poll.projectId) break;
        const list = w.polls.list;
        const i = list.findIndex(p => p.id === frame.poll.id);
        w.polls = {
          ...w.polls, asked: true,
          list: i < 0 ? [frame.poll, ...list] : list.map(p => p.id === frame.poll.id ? frame.poll : p),
        };
        break;
      }

      case "canvases":
        if ((frame.requestId !== undefined && frame.requestId !== w.canvases.requestId)
          || (frame.requestId === undefined && w.canvases.projectId !== frame.projectId)) break;
        w.canvases = { asked: true, projectId: frame.projectId, list: frame.canvases, historyAsked: false, history: [] };
        break;
      case "canvas": {
        const currentProject = w.canvases.projectId;
        const correlated = frame.requestId !== undefined && frame.requestId === w.canvases.mutationRequestId;
        if (frame.requestId !== undefined && !correlated && currentProject !== frame.canvas.projectId) break;
        if (frame.requestId === undefined && currentProject !== frame.canvas.projectId) break;
        const list = w.canvases.list;
        const i = list.findIndex(c => c.id === frame.canvas.id);
        w.canvases = { ...w.canvases, asked: true,
          ...(currentProject ? { projectId: currentProject } : { projectId: frame.canvas.projectId }),
          list: i < 0 ? [frame.canvas, ...list] : list.map(c => c.id === frame.canvas.id ? frame.canvas : c) };
        if (correlated) w.canvases = { ...w.canvases, mutationRequestId: undefined, problem: undefined };
        break;
      }
      case "canvasHistory":
        if (frame.requestId === undefined || frame.requestId !== w.canvases.historyRequestId || w.canvases.historyCanvasId !== frame.canvasId) break;
        w.canvases = { ...w.canvases, history: frame.revisions, historyRequestId: undefined, historyLoading: false, historyProblem: undefined };
        break;
      case "projectAccessRevoked": {
        w.projects = { ...w.projects, list: w.projects.list.filter(p => p.id !== frame.projectId) };
        const { [frame.projectId]: goneItems, ...restItems } = w.projectItems;
        void goneItems;
        w.projectItems = restItems;
        if (w.polls.projectId === frame.projectId) w.polls = { asked: true, list: [] };
        if (w.canvases.projectId === frame.projectId) {
          w.canvases = { asked: true, list: [], history: [], problem: "this project is no longer accessible" };
        }
        if (w.publicUpdates.selected?.projectId === frame.projectId || w.publicUpdates.drafts.some(d => d.projectId === frame.projectId)) {
          w.publicUpdates = {
            ...w.publicUpdates,
            drafts: w.publicUpdates.drafts.filter(d => d.projectId !== frame.projectId),
            selected: w.publicUpdates.selected?.projectId === frame.projectId ? undefined : w.publicUpdates.selected,
            revisions: w.publicUpdates.selected?.projectId === frame.projectId ? [] : w.publicUpdates.revisions,
            audit: w.publicUpdates.selected?.projectId === frame.projectId ? [] : w.publicUpdates.audit,
            lastPublished: w.publicUpdates.lastPublished && w.publicUpdates.drafts.every(d => d.projectId === frame.projectId)
              ? undefined : w.publicUpdates.lastPublished,
          };
        }
        break;
      }
      case "hooks":
        {
          if (frame.requestId === undefined) {
            // Live mirror from another owner window. It must not clear this
            // window's pending mutation ledger or request spinner.
            w.hooks = { ...w.hooks, asked: true, list: frame.hooks, problem: undefined };
            break;
          }
          const expected = w.hooks.requestId ?? (w.hooks.pending?.[frame.requestId] ? frame.requestId : w.hooks.mutationRequestId);
          if (frame.requestId !== expected) break;
          const pending = { ...w.hooks.pending };
          if (frame.requestId && pending[frame.requestId]) delete pending[frame.requestId];
          w.hooks = { ...w.hooks, asked: true, requestId: undefined, mutationRequestId: Object.keys(pending).at(-1), pending, list: frame.hooks };
        }
        break;
      case "hook": {
        if (frame.requestId === undefined) {
          const i = w.hooks.list.findIndex(h => h.id === frame.hook.id);
          w.hooks = { ...w.hooks, asked: true, list: i < 0 ? [frame.hook, ...w.hooks.list] : w.hooks.list.map(h => h.id === frame.hook.id ? frame.hook : h) };
          break;
        }
        if (frame.requestId !== w.hooks.requestId && !w.hooks.pending?.[frame.requestId]) break;
        const i = w.hooks.list.findIndex(h => h.id === frame.hook.id);
        const pending = { ...w.hooks.pending }; delete pending[frame.requestId];
        w.hooks = { ...w.hooks, asked: true, requestId: undefined, mutationRequestId: Object.keys(pending).at(-1), pending, problem: undefined, list: i < 0 ? [frame.hook, ...w.hooks.list] : w.hooks.list.map(h => h.id === frame.hook.id ? frame.hook : h) };
        break;
      }
      case "hookTest":
        if (frame.requestId === undefined) break;
        if (frame.requestId !== w.hooks.requestId && !w.hooks.pending?.[frame.requestId]) break;
        { const pending = { ...w.hooks.pending }; delete pending[frame.requestId];
          w.hooks = { ...w.hooks, mutationRequestId: Object.keys(pending).at(-1), pending, problem: undefined, test: { hookId: frame.hookId, ok: frame.ok, said: frame.said } }; }
        break;
      case "hookAudit":
        if (frame.requestId === undefined || frame.requestId !== w.hooks.auditRequestId) break;
        w.hooks = { ...w.hooks, auditRequestId: undefined, auditLoading: false, audit: frame.entries, auditProblem: undefined };
        break;
      case "socialProjects":
        if (frame.requestId && w.socialProjects.requestId && frame.requestId !== w.socialProjects.requestId) break;
        w.socialProjects = { asked: true, list: frame.projects, requestId: undefined };
        w.socialUnread = Object.fromEntries((frame.unread ?? []).map(entry => [entry.projectId, entry.unread]));
        break;
      case "socialFeed": {
        const current = w.socialFeeds[frame.projectId] ?? {
          asked: false, loading: false, posts: [], hasMore: true, unread: 0,
        };
        if (frame.requestId && current.requestId && frame.requestId !== current.requestId) break;
        const known = new Set(current.posts.map(post => post.id));
        const incoming = frame.posts.filter(post => !known.has(post.id));
        const posts = (current.posts.length > 0 && current.nextBeforeId
          ? [...incoming, ...current.posts]
          : frame.posts).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
        w.socialFeeds = {
          ...w.socialFeeds,
          [frame.projectId]: {
            asked: true, loading: false, posts, hasMore: frame.hasMore,
            unread: frame.unread,
            nextBefore: frame.nextBefore,
            nextBeforeId: frame.nextBeforeId,
            requestId: frame.requestId === current.requestId ? undefined : current.requestId,
          },
        };
        break;
      }
      case "socialPost": {
        if (frame.requestId && !this.socialRequests.delete(frame.requestId)) break;
        this.settleSocialSuccess(frame.requestId);
        const current = w.socialFeeds[frame.post.projectId];
        if (!current) break;
        if (current.posts.some(post => post.id === frame.post.id)) break;
        w.socialFeeds = {
          ...w.socialFeeds,
          [frame.post.projectId]: {
            ...current,
            posts: [...current.posts, frame.post].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
          },
        };
        break;
      }
      case "socialUpdated": {
        if (frame.requestId && !this.socialRequests.delete(frame.requestId)) break;
        this.settleSocialSuccess(frame.requestId);
        const current = w.socialFeeds[frame.post.projectId];
        if (!current) break;
        w.socialFeeds = {
          ...w.socialFeeds,
          [frame.post.projectId]: {
            ...current,
            posts: current.posts.map(post => post.id === frame.post.id ? frame.post : post)
              .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
          },
        };
        break;
      }
      case "socialReaction": {
        if (frame.requestId && !this.socialRequests.delete(frame.requestId)) break;
        this.settleSocialSuccess(frame.requestId);
        const current = w.socialFeeds[frame.projectId];
        if (!current) break;
        const posts = current.posts.map(post => {
          if (post.id !== frame.postId) return post;
          const reactions = (post.reactions ?? []).filter(reaction => reaction.emoji !== frame.emoji);
          if (frame.actorIds.length) reactions.push({ emoji: frame.emoji, actorIds: frame.actorIds });
          return { ...post, reactions: reactions.length ? reactions : undefined };
        });
        w.socialFeeds = { ...w.socialFeeds, [frame.projectId]: { ...current, posts } };
        break;
      }
      case "socialRead": {
        if (frame.requestId && !this.socialRequests.delete(frame.requestId)) break;
        this.settleSocialSuccess(frame.requestId);
        const current = w.socialFeeds[frame.entry.projectId];
        if (current) {
          w.socialFeeds = {
            ...w.socialFeeds,
            [frame.entry.projectId]: { ...current, unread: frame.entry.unread },
          };
        }
        w.socialUnread = { ...w.socialUnread, [frame.entry.projectId]: frame.entry.unread };
        break;
      }
      case "socialUnread": {
        w.socialUnread = { ...w.socialUnread, [frame.projectId]: frame.unread };
        const current = w.socialFeeds[frame.projectId];
        if (current) w.socialFeeds = { ...w.socialFeeds, [frame.projectId]: { ...current, unread: frame.unread } };
        break;
      }
      case "socialUnavailable": {
        const { [frame.projectId]: gone, ...rest } = w.socialFeeds;
        void gone;
        w.socialFeeds = rest;
        w.socialProjects = {
          ...w.socialProjects,
          list: w.socialProjects.list.filter(project => project.id !== frame.projectId),
        };
        const { [frame.projectId]: unreadGone, ...unreadRest } = w.socialUnread;
        void unreadGone;
        w.socialUnread = unreadRest;
        break;
      }
      case "socialMembers":
        break;
      case "pulse":
        // Correlated answers belong only to the active list/read request. A
        // no-id frame is an access push and may still refresh every open
        // window. A read acknowledgement must not cancel a list still in
        // flight, but it is otherwise a canonical snapshot.
        const readAck = frame.requestId !== undefined && this.pulseReadRequests.delete(frame.requestId);
        if (frame.requestId !== undefined && !readAck && frame.requestId !== w.pulse.requestId) break;
        w.pulse = {
          asked: true, loading: readAck ? w.pulse.loading : false, updates: frame.updates,
          unreadByProject: frame.unreadByProject, projects: frame.projects,
          requestId: readAck ? w.pulse.requestId : undefined,
          problem: undefined,
          ...(frame.projectId ? { projectId: frame.projectId } : {}),
        };
        break;
      case "pulseChanged": {
        if (frame.requestId !== undefined) {
          if (frame.requestId !== this.pulseAcceptedRequestId) break;
          this.pulseAcceptedRequestId = undefined;
        }
        // A peer window's no-id push is useful while a local save is pending,
        // but it is not that save's acknowledgement. Keep the spinner and
        // draft guard until the matching request (or refusal/lost callback)
        // settles it; otherwise another window can make a local save look done.
        const mutationPending = this.pulseMutationRequestId !== undefined;
        const authorized = new Set(frame.projects.map(project => project.id));
        if (!authorized.has(frame.update.projectId)) {
          w.pulse = { ...w.pulse,
            updates: w.pulse.updates.filter(update => authorized.has(update.projectId)),
            unreadByProject: Object.fromEntries(Object.entries(frame.unreadByProject)
              .filter(([id]) => authorized.has(id))), projects: frame.projects };
          break;
        }
        const i = w.pulse.updates.findIndex(u => u.id === frame.update.id);
        const retained = w.pulse.updates.filter(update => authorized.has(update.projectId));
        const retainedIndex = retained.findIndex(u => u.id === frame.update.id);
        const updates = retainedIndex >= 0
          ? retained.map(u => u.id === frame.update.id ? frame.update : u)
          : [frame.update, ...retained];
        w.pulse = { ...w.pulse, asked: true, loading: mutationPending ? w.pulse.loading : false, updates,
          unreadByProject: frame.unreadByProject, projects: frame.projects };
        break;
      }
      // ENGINE-ONLY RECEIPT, and it is right that the screen drops it. When an
      // agent asks mid-run "may I push this branch?", the hub answers the
      // ENGINE with the id of the card it just minted, so the engine knows
      // which decision belongs to which waiting agent. The card itself arrives
      // on the ordinary `approval` frame the screen already handles — this is
      // the plumbing behind it, and nothing on screen needs it.
      case "approvalAsked":
        break;
      // ENGINE-ONLY ORDER, and the screen is right to drop it: "go and ask
      // GitHub about this repository" is addressed to the copy of Cloud9 that
      // has the GitHub sign-in, not to a window. What comes back arrives as an
      // ordinary `project` and `projectItems` frame, handled above.
      case "lookAtProject":
        break;
      // ENGINE-ONLY ORDER, dropped for the same reason: "list the repositories
      // this sign-in can see" is addressed to the computer with the GitHub
      // sign-in. The answer arrives as `repositories`, below.
      case "listRepositoriesRequested":
        break;
      /* HIS REPOSITORIES, as the computer with the sign-in really found them.
         Applied here rather than by whoever asked, because it reaches every
         window this person has open. `repos` absent with a `problem` is "we
         could not ask"; `repos: []` is GitHub really saying he has none — and
         those are two different sentences on screen. */
      case "repositories":
        /* THE RECEIPT AND THE ANSWER ARE THE SAME FRAME TYPE, told apart by
           `asking`. The receipt says the hub has passed the question on; the
           old rows are cleared with it, because a list from the last time we
           asked is not an answer to this time. */
        w.repoChoices = frame.asking
          ? { asked: true, asking: true }
          : {
            asked: true, asking: false,
            ...(frame.repos ? { repos: frame.repos } : {}),
            ...(frame.problem ? { problem: frame.problem } : {}),
            fetchedAt: frame.fetchedAt,
          };
        break;
      /* FILES AGENTS MADE. These three used to be dropped with a comment saying
         a later round would claim them. It has. */
      case "artifact":
        if (this.discardArtifactDetailFrames.delete(frame.artifact.id)) {
          /* A privacy generation changed after this detail question was sent.
             Drop the stale artifact AND its relations; the selected detail sees
             no cache and asks again against the current world. */
          break;
        }
        /* Pushed UNASKED to everyone who can see the conversation the moment a
           file is published or updated, as well as answering an `artifact` ask.
           Applied here rather than by whoever asked, for the same reason
           `project` is: this frame is how a window finds out that an agent just
           put a file in the room, and the card on screen has to become the new
           version by itself. */
        this.holdArtifacts(frame.artifact.channelId, [frame.artifact], false);
        if (frame.relations !== undefined) {
          w.artifactRelations = {
            ...w.artifactRelations, [frame.artifact.id]: frame.relations,
          };
          if (frame.relationsTruncated === true) {
            w.artifactRelationsTruncated = {
              ...w.artifactRelationsTruncated, [frame.artifact.id]: true,
            };
          }
          this.artifactDetailAsked.add(frame.artifact.id);
        }
        break;
      case "artifactUnavailable":
        // Deliberately the same screen state as an invented id: no probing.
        // onFrame emits once after the switch; the helper only mutates here.
        this.forgetArtifact(frame.artifactId, false);
        break;
      case "artifactWorkspace":
        // Applied only by the bounded page request that asked for it.
        break;
      case "artifacts":
        // Applied by `askArtifacts`, which is the only thing that asks. A list
        // arriving for a question nobody is asking any more goes nowhere.
        break;
      case "artifactTicket":
        /* The permission itself is applied by the click that asked for it (see
           `askTicket`). What is taken here is the ARTIFACT the frame carries:
           it is the hub's current answer about that file, so a card that was
           only ever drawn from a message reference learns its whole history
           from the first download without a second question. */
        this.holdArtifacts(frame.artifact.channelId, [frame.artifact], false);
        break;
      case "searchEverywhereResults":
        /* Applied by the search that asked for it (see `searchEverywhere`),
           recognised by its exact requestId, and by nothing else. An answer to
           a search the reader has already closed — or to an older question its
           replacement has overtaken — has nobody to give it to, so it is
           dropped here. This is the same rule `searchResults` follows, and it
           is the rule because the alternative once brought a closed search back
           onto the screen with clickable hits. */
        break;
      case "hooksUpdated":
        // Owner hook sync is engine-only; the desktop already owns the list
        // through the correlated `hooks` responses above.
        break;
      default: {
        /**
         * If a new frame is added to `ServerFrame` and not handled above, this
         * line stops being assignable and `tsc` fails the build. An unhandled
         * frame can no longer ship silently the way `userRemoved` did.
         */
        const unhandled: never = frame;
        void unhandled;
        break;
      }
    }
    this.emit();
  }
}

export const client = new RelayClient();

/* ============ READING ONE SLICE OF THE WORLD — the one owner ============
 *
 * WHY THIS EXISTS. `emit()` hands out a NEW world object on every frame — a
 * message in any room, a presence tick, a reaction, a job update. Every screen
 * that asked for the whole world therefore looked changed every time, and React
 * redrew all of them. With 150 messages loaded, one arriving message redrew all
 * 151 bubbles; so did an agent's status tick, which changes nothing a bubble
 * draws. That is what "the chat is not smooth" was made of.
 *
 * The fix is to let a screen say WHAT IT READS. `useWorld` runs that little
 * selector against each new world and, when the answer is the same as last
 * time, hands back the SAME object — so React sees no change and does not
 * redraw. The comparison is shallow by design: every field of the world is
 * replaced (never mutated) when it changes, so "same object" IS "unchanged".
 *
 * Two rules for anyone adding a call site:
 *  1. select the smallest thing you actually read (`w.messages[id]`, not
 *     `w.messages`) — a wider selector is only ever a slower one;
 *  2. never build a fresh object/array INSIDE a selector unless every field of
 *     it is a world field, or the shallow check has nothing stable to compare
 *     and the screen redraws exactly as often as before (no harm, no gain).
 */

/** Same object, or an object whose every field is the same object. */
export function shallowEqual<T>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(right, k)) return false;
    if (!Object.is(left[k], right[k])) return false;
  }
  return true;
}

/**
 * Watch one slice of the world from outside React (QA, tests, anything that is
 * not a component). `onChange` runs only when the slice really changed.
 */
export function subscribeTo<T>(
  select: (w: World) => T,
  onChange: (value: T) => void,
  isEqual: (a: T, b: T) => boolean = shallowEqual,
): () => void {
  let last = select(client.getSnapshot());
  return client.subscribe(() => {
    const next = select(client.getSnapshot());
    if (isEqual(last, next)) return;
    last = next;
    onChange(next);
  });
}

/**
 * Read one slice of the world in a component, and redraw only when it changed.
 *
 * A drop-in for `useSyncExternalStore(client.subscribe, client.getSnapshot)`,
 * with the selector as the whole difference. The held value is what makes it
 * work: `useSyncExternalStore` compares what `read` returns with `Object.is`,
 * so `read` has to hand back the identical object when nothing moved.
 */
export function useWorld<T>(
  select: (w: World) => T,
  isEqual: (a: T, b: T) => boolean = shallowEqual,
): T {
  const selectRef = useRef(select);
  selectRef.current = select;
  const equalRef = useRef(isEqual);
  equalRef.current = isEqual;
  /** the last answer, and the world it was read from */
  const held = useRef<{ from: World; value: T } | null>(null);

  const read = useCallback((): T => {
    const w = client.getSnapshot();
    const last = held.current;
    // the same world cannot have a different answer
    if (last && last.from === w) return last.value;
    const next = selectRef.current(w);
    if (last && equalRef.current(last.value, next)) {
      held.current = { from: w, value: last.value };
      return last.value;
    }
    held.current = { from: w, value: next };
    return next;
  }, []);

  return useSyncExternalStore(client.subscribe, read);
}
