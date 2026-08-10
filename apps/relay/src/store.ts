// Relay persistence on node:sqlite (built into Node 22+, no native build).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ActivityRecord, AgentDef, Approval, ArtifactAccess, ArtifactLink,
  ArtifactWorkspaceEntry, Attachment, Channel, ChannelMember,
  StoredArtifact, StoredArtifactVersion, artifactVersionForPublic,
  ChannelRole, EverywhereHit, ID, Message, SearchKind,
  MessageReaction, MESSAGE_LIMITS, ARTIFACT_LIMITS, Project, PublicUpdateDraft, PublicUpdateRevision, PublicUpdateAudit, ProjectItem, PROJECT_LIMITS,
  MessageStatus, MessageDeliveryStage,
  EngineeringCanvas, EngineeringCanvasRevision, CanvasBlock, CANVAS_LIMITS,
  ProjectPoll, ProjectPollDecision, ProjectPollOption,
  SocialPost, SocialReaction, SocialReadEntry, SocialLink, SOCIAL_LIMITS,
  EngineeringPulseUpdate, redactDeletedPulseUpdate,
  RunRecord, RUN_RETENTION, Task, User, StoredHook, isSafeStoredId, nameKey, newId,
  NOTIFICATION_INBOX_LIMITS,
  ChatDraft, DraftAttachment, DRAFT_LIMITS,
  type NotificationInboxKind, type NotificationInboxState,
  Workflow, WorkflowRun, validateArtifactLinks, validateWorkflow,
  HuddleSession, HuddleNote, HuddleReadEntry,
  ForumTopic, ForumReply, ForumReadEntry, ForumPage,
} from "@cloud9/shared";
// THE ONE OWNER of "write a file this app will later believe" — write next
// door, flush it down to the disk, rename it into place. It lives in the engine
// because that is where it was first needed; the hub uses the same one rather
// than keeping a second copy, because two copies of a rule is how one of them
// quietly stops being true.
import { sweepPending, writeWholeFile } from "@cloud9/engine";
import { secureId, secureToken } from "./secureid.js";
import { JoinHubStore, JoinTokenRow } from "./joinhub.js";

/** One identity for every Store opened during this process lifetime. */
const ARTIFACT_STAGE_NONCE = secureId("boot");

/**
 * One page of scrollback, and whether there is more behind it.
 *
 * "The page came back short" is NOT a reliable end-of-history signal, so the
 * store answers the question directly instead of leaving every client to guess
 * it differently.
 */
export interface Page<T> {
  items: T[];
  hasMore: boolean;
  /** feed straight back as the next request's cursor */
  nextBefore?: number;
  nextBeforeId?: ID;
}

/** One invite ticket: who made it, whether it has been spent, whether it is dead. */
export interface InviteRow {
  code: string;
  createdBy: ID;
  usedBy?: ID;
  usedAt?: number;
  revoked: boolean;
}

interface RawInvite {
  code: string; createdBy: string; usedBy: string | null;
  usedAt: number | null; revoked: number;
}

interface RawJoinToken {
  code: string; createdBy: string; createdAt: number; expiresAt: number;
  usedBy: string | null; usedAt: number | null; revoked: number;
}

interface RawMember {
  channelId: string; memberId: string; role: string; joinedAt: number;
  invitedBy: string | null; removedAt: number | null; removedBy: string | null;
}

function toMember(r: RawMember): ChannelMember {
  return {
    channelId: r.channelId, memberId: r.memberId, role: r.role as ChannelRole,
    joinedAt: r.joinedAt,
    ...(r.invitedBy ? { invitedBy: r.invitedBy } : {}),
    ...(r.removedAt !== null ? { removedAt: r.removedAt } : {}),
    ...(r.removedBy ? { removedBy: r.removedBy } : {}),
  };
}

/**
 * One stored run, plus the four facts the hub decided about it.
 *
 * They are stored BESIDE the record rather than trusted from inside it: the
 * record arrived over the wire, and "who owns this" and "which room was this
 * in" are the two questions every later authorisation answer is built on.
 */
export interface RunRow {
  record: RunRecord;
  agentId: ID;
  /** the human whose agent this is — the person who may always read it */
  ownerId: ID;
  /** the conversation it happened in, when it happened in one */
  channelId?: ID;
  /** the delegated job it belongs to, when it belongs to one */
  taskId?: ID;
}

/**
 * The identity of one artifact, without its bytes or its history.
 *
 * It is a row and not the wire shape on purpose: `nextVersion` is the hub's own
 * counter and no client ever sees it. `Artifact` (in shared) is what travels.
 */
export interface ArtifactRow {
  id: ID;
  channelId: ID;
  name: string;
  /** `nameKey(name)` — what makes two spellings of one name one file */
  nameKey: string;
  createdAt: number;
  updatedAt: number;
  /** the number the NEXT version will get. Only ever goes up. */
  nextVersion: number;
}

/** One database link row. This is persistence shape, not a second wire type. */
export interface ArtifactLinkRow {
  sourceArtifactId: ID;
  sourceVersion: number;
  channelId: ID;
  kind: ArtifactLink["kind"];
  targetArtifactId: ID;
  targetVersion: number;
}

export interface ArtifactRelationRow extends ArtifactLinkRow {
  direction: "outgoing" | "incoming";
}

/** Bytes staged under a publish-only name until their DB transaction owns them. */
export interface ArtifactByteStage {
  stagedAs: string;
  storedAs: string;
}

interface RawRun {
  id: string; agentId: string; ownerId: string;
  channelId: string | null; taskId: string | null; startedAt: number; json: string;
}

interface RawChatDraft {
  userId: string; channelId: string; threadId: string; updatedAt: number;
  expiresAt: number; state: string; json: string;
}

export interface SavedSendResult {
  message: Message;
  /** True when this request replayed a previously committed send. */
  replayed: boolean;
  /** True when the send removed the draft whose intent matched the message. */
  draftRemoved: boolean;
}

type DraftMutationKind = "draftUpdate" | "draftReclaim" | "draftRemove";
interface DraftMutationReceipt {
  userId: ID; requestId: ID; kind: DraftMutationKind; payloadHash: string;
  resultJson: string; createdAt: number;
}

type PulseMutationKind = "pulseCreate" | "pulseUpdate" | "pulseDelete";
interface PulseMutationReceipt {
  userId: ID; requestId: ID; kind: PulseMutationKind;
  payloadHash: string; updateId: ID; projectId: ID; createdAt: number;
}

export interface NotificationInboxRow {
  id: string;
  recipientId: ID;
  kind: NotificationInboxKind;
  channelId: ID;
  messageId: ID;
  rootId?: ID;
  actorId: ID;
  createdAt: number;
  state: NotificationInboxState;
}

export interface SavedMessageRow {
  id: ID;
  userId: ID;
  messageId: ID;
  channelId: ID;
  savedAt: number;
  note?: string;
  remindAt?: number;
}

export interface SavedMessagePage {
  entries: SavedMessageRow[];
  hasMore: boolean;
  nextSavedAt?: number;
  nextMessageId?: ID;
}

export interface ChannelPinRow {
  id: ID;
  channelId: ID;
  messageId: ID;
  pinnedAt: number;
  pinnedById: ID;
}

export interface ChannelPinPage {
  entries: ChannelPinRow[];
  hasMore: boolean;
  nextPinnedAt?: number;
  nextMessageId?: ID;
}

export type ChannelPinMutationKind = "pinMessage" | "unpinMessage";

interface ChannelPinMutationReceipt {
  userId: ID;
  requestId: ID;
  kind: ChannelPinMutationKind;
  payloadHash: string;
  channelId: ID;
  messageId: ID;
  createdAt: number;
}

interface RawChannelPinRow {
  channelId: string; messageId: string; pinnedAt: number; pinnedById: string;
}

function toChannelPinRow(r: RawChannelPinRow): ChannelPinRow {
  return { id: `${r.channelId}:${r.messageId}`, channelId: r.channelId,
    messageId: r.messageId, pinnedAt: r.pinnedAt, pinnedById: r.pinnedById };
}

export type SavedMutationKind = "saveMessage" | "unsaveMessage";

const SAVED_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const CHANNEL_PIN_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MESSAGE_SEND_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MESSAGE_SEND_MAX_ROWS = 512;

interface SavedMutationReceipt {
  userId: ID;
  requestId: ID;
  kind: SavedMutationKind;
  payloadHash: string;
  createdAt: number;
}

interface RawSavedMessageRow {
  userId: string; messageId: string; channelId: string;
  savedAt: number; note: string | null; remindAt: number | null;
}

export interface MessageSendLedgerRow {
  authorId: ID;
  clientMessageId: ID;
  channelId: ID;
  messageId: ID;
  payloadHash: string;
  createdAt: number;
}

export interface MessageReceiptRow {
  messageId: ID;
  channelId: ID;
  recipientId: ID;
  deliveredAt?: number;
  readAt?: number;
  cursorTs?: number;
  cursorId?: ID;
}

export interface HumanMessageWrite {
  message: Message;
  clientMessageId: ID;
  payloadHash: string;
}

function toSavedMessageRow(r: RawSavedMessageRow): SavedMessageRow {
  return {
    id: `${r.userId}:${r.messageId}`,
    userId: r.userId,
    messageId: r.messageId,
    channelId: r.channelId,
    savedAt: r.savedAt,
    ...(r.note ? { note: r.note } : {}),
    ...(r.remindAt !== null ? { remindAt: r.remindAt } : {}),
  };
}

interface RawNotificationInboxRow {
  id: string; recipientId: string; kind: string; channelId: string;
  messageId: string; rootId: string | null; actorId: string;
  createdAt: number; state: string;
}

function toNotificationRow(r: RawNotificationInboxRow): NotificationInboxRow {
  return {
    id: r.id, recipientId: r.recipientId, kind: r.kind as NotificationInboxKind,
    channelId: r.channelId, messageId: r.messageId,
    ...(r.rootId ? { rootId: r.rootId } : {}),
    actorId: r.actorId, createdAt: r.createdAt, state: r.state as NotificationInboxState,
  };
}

function toRun(r: RawRun): RunRow {
  return {
    record: JSON.parse(r.json) as RunRecord,
    agentId: r.agentId,
    ownerId: r.ownerId,
    ...(r.channelId ? { channelId: r.channelId } : {}),
    ...(r.taskId ? { taskId: r.taskId } : {}),
  };
}

/** No caller, and no client, may ask for a bigger page than the protocol allows. */
function cap(limit: number): number {
  if (!Number.isFinite(limit)) return RUN_RETENTION.listDefault;
  return Math.max(1, Math.min(Math.floor(limit), RUN_RETENTION.listPage));
}

function toInvite(r: RawInvite): InviteRow {
  return {
    code: r.code, createdBy: r.createdBy,
    usedBy: r.usedBy ?? undefined, usedAt: r.usedAt ?? undefined,
    revoked: r.revoked === 1,
  };
}

function toJoinToken(r: RawJoinToken): JoinTokenRow {
  return {
    code: r.code, createdBy: r.createdBy, createdAt: r.createdAt, expiresAt: r.expiresAt,
    usedBy: r.usedBy ?? undefined, usedAt: r.usedAt ?? undefined,
    revoked: r.revoked === 1,
  };
}

/** How a store was asked to open itself. */
export interface StoreOptions {
  /**
   * The sign-in token of the person who RUNS this Cloud9.
   *
   * Handed in rather than guessed. The v2 → v3 membership backfill has to
   * decide who owns each existing room, and it used to take the first row of
   * `tokens` by rowid — which is only the owner by accident of insertion order.
   * On a differently-ordered file that made a guest the owner of every room and
   * demoted the real owner. The caller already knows the answer, so it says it.
   */
  ownerToken?: string;
}

/**
 * A database this build could not open or read.
 *
 * Carried as its own error type so the caller can say WHICH file and WHAT was
 * wrong with it in plain words, instead of a bare SQLite or JSON message that
 * tells the owner nothing about his own data.
 */
export class StoreOpenError extends Error {
  constructor(readonly dbPath: string, readonly cause: unknown) {
    super(
      `Cloud9 could not open its message database at ${dbPath}. ` +
      `The file is there but this build could not read it: ${(cause as Error)?.message ?? String(cause)}. ` +
      `Nothing has been changed — the file is exactly as it was.`,
    );
    this.name = "StoreOpenError";
  }
}

export class Store implements JoinHubStore {
  db: DatabaseSync;
  /**
   * Where attached files live: a folder beside the database, on the machine
   * running the hub. Nothing else in the app may choose this path — one owner,
   * so a file can never be written anywhere a client asked for.
   */
  attachmentsDir: string;
  /**
   * Where files agents made live — a SEPARATE folder beside the attachments
   * one, on the same machine and under the same rules.
   *
   * Separate on purpose: an artifact is kept for as long as its version history
   * is, and an attachment is swept when its message is deleted. One folder would
   * mean one sweep deciding about two different promises.
   */
  artifactsDir: string;

  /**
   * Rows this build could not make sense of, in plain words.
   *
   * A single unreadable row must never be the reason the owner cannot open his
   * own messages ever again. So a row that will not parse is SKIPPED, described
   * here, and the rest of the database opens — a fault you can read and repair
   * rather than a door that is shut forever.
   */
  readonly problems: string[] = [];
  /** Approval cards retired by the one startup interruption sweep. */
  private interruptedWorkflowApprovals: Approval[] = [];

  private readonly ownerToken?: string;
  /** Distinguishes this process lifetime from an older process that reused its pid. */
  private readonly artifactStageNonce = ARTIFACT_STAGE_NONCE;

  constructor(dbPath: string, opts: StoreOptions = {}) {
    this.ownerToken = opts.ownerToken;
    try {
      this.db = new DatabaseSync(dbPath);
    } catch (e) {
      throw new StoreOpenError(dbPath, e);
    }
    this.attachmentsDir = path.join(path.dirname(path.resolve(dbPath)), "cloud9-attachments");
    this.artifactsDir = path.join(path.dirname(path.resolve(dbPath)), "cloud9-artifacts");
    // Litter from an upload that was interrupted last time. Nothing swept this
    // folder before today, so it only ever grew.
    this.sweepAttachmentLitter();
    // The same sweep for the artifacts folder — the same class of litter, from
    // the same whole-write mechanism, so it is not left to grow either.
    sweepPending(this.artifactsDir);
    // EVERYTHING FROM HERE TO THE END OF THE MIGRATION IS ONE GUARDED OPEN.
    // `new DatabaseSync` succeeds on a file that is not a database at all —
    // SQLite does not look inside until the first statement — so guarding only
    // the constructor guarded nothing. The first statement is below.
    try {
      this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users(
        id TEXT PRIMARY KEY, name TEXT NOT NULL, invitedBy TEXT
      );
      CREATE TABLE IF NOT EXISTS tokens(
        token TEXT PRIMARY KEY, userId TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS invites(
        code TEXT PRIMARY KEY, createdBy TEXT NOT NULL, usedBy TEXT,
        usedAt INTEGER, revoked INTEGER NOT NULL DEFAULT 0
      );
      -- A join token is a SECOND, distinct credential from an invite: it carries
      -- its own deadline (expiresAt) and is redeemed over a network by a
      -- friend on another computer. See docs/plans/join-hub-handoff.md.
      CREATE TABLE IF NOT EXISTS join_tokens(
        code TEXT PRIMARY KEY, createdBy TEXT NOT NULL, createdAt INTEGER NOT NULL,
        expiresAt INTEGER NOT NULL, usedBy TEXT, usedAt INTEGER,
        revoked INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS agents(
        id TEXT PRIMARY KEY, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channels(
        id TEXT PRIMARY KEY, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages(
        id TEXT PRIMARY KEY, channelId TEXT NOT NULL, ts INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS msg_chan_ts ON messages(channelId, ts);
      CREATE TABLE IF NOT EXISTS message_send_ledger(
        authorId TEXT NOT NULL, clientMessageId TEXT NOT NULL,
        channelId TEXT NOT NULL, messageId TEXT NOT NULL,
        payloadHash TEXT NOT NULL, createdAt INTEGER NOT NULL,
        PRIMARY KEY(authorId, clientMessageId)
      );
      CREATE INDEX IF NOT EXISTS message_send_ledger_order
        ON message_send_ledger(authorId, createdAt DESC);
      CREATE TABLE IF NOT EXISTS message_receipts(
        messageId TEXT NOT NULL, channelId TEXT NOT NULL, recipientId TEXT NOT NULL,
        deliveredAt INTEGER, readAt INTEGER, cursorTs INTEGER, cursorId TEXT,
        PRIMARY KEY(messageId, recipientId)
      );
      CREATE INDEX IF NOT EXISTS message_receipt_message ON message_receipts(messageId);
      CREATE TABLE IF NOT EXISTS tasks(
        id TEXT PRIMARY KEY, updatedAt INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS workflows(
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, updatedAt INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workflow_owner ON workflows(ownerId, updatedAt);
      CREATE TABLE IF NOT EXISTS workflow_runs(
        id TEXT PRIMARY KEY, workflowId TEXT NOT NULL, ownerId TEXT NOT NULL,
        updatedAt INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS workflow_run_owner ON workflow_runs(ownerId, updatedAt);
      CREATE INDEX IF NOT EXISTS workflow_run_workflow ON workflow_runs(workflowId, updatedAt);
      CREATE TABLE IF NOT EXISTS approvals(
        id TEXT PRIMARY KEY, json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activity(
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL,
        seq INTEGER, hash TEXT, prevHash TEXT
      );
      CREATE INDEX IF NOT EXISTS act_ts ON activity(ts);
      -- NOTE: the index over activity(seq) is NOT created here. See migrate().
      CREATE TABLE IF NOT EXISTS pushlog(
        id TEXT PRIMARY KEY, userId TEXT NOT NULL, messageId TEXT NOT NULL,
        ts INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
      );

      -- One row per thing this database needs to remember about ITSELF. It
      -- exists so the NEXT schema change is a migration step and not a hand
      -- repair on Vikas's only copy of his messages.
      CREATE TABLE IF NOT EXISTS meta(
        key TEXT PRIMARY KEY, value TEXT NOT NULL
      );

      -- One person, one message, one emoji: the primary key IS the idempotence
      -- rule. Taking it back sets removedAt — a soft delete, so the record
      -- still knows it happened; every read filters on removedAt IS NULL.
      CREATE TABLE IF NOT EXISTS reactions(
        messageId TEXT NOT NULL, userId TEXT NOT NULL, emoji TEXT NOT NULL,
        ts INTEGER NOT NULL, removedAt INTEGER,
        PRIMARY KEY (messageId, userId, emoji)
      );
      CREATE INDEX IF NOT EXISTS react_msg ON reactions(messageId);

      -- A parked or attached file. The BYTES are on disk; this row is the
      -- metadata and the pointer. messageId is null until a send claims it.
      CREATE TABLE IF NOT EXISTS attachments(
        id TEXT PRIMARY KEY, channelId TEXT NOT NULL, uploadedBy TEXT NOT NULL,
        messageId TEXT, uploadedAt INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS att_msg ON attachments(messageId);

      -- One durable composer row per authenticated person, room and optional
      -- thread. Attachment entries are metadata projections only; bytes stay
      -- under the attachment table/folder and continue to obey its TTL.
      CREATE TABLE IF NOT EXISTS chat_drafts(
        userId TEXT NOT NULL, channelId TEXT NOT NULL, threadId TEXT NOT NULL DEFAULT '',
        updatedAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
        state TEXT NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY(userId, channelId, threadId)
      );
      CREATE INDEX IF NOT EXISTS chat_draft_user_order
        ON chat_drafts(userId, updatedAt DESC, channelId, threadId);
      CREATE TABLE IF NOT EXISTS draft_mutation_receipts(
        userId TEXT NOT NULL, requestId TEXT NOT NULL, kind TEXT NOT NULL,
        payloadHash TEXT NOT NULL, resultJson TEXT NOT NULL, createdAt INTEGER NOT NULL,
        PRIMARY KEY(userId, requestId)
      );
      CREATE INDEX IF NOT EXISTS draft_receipt_order
        ON draft_mutation_receipts(userId, createdAt DESC);

      -- A FILE AN AGENT MADE. Two tables, because an artifact has an identity
      -- that outlives any one set of bytes.
      --
      -- "artifacts" is the identity: one row per (conversation, name). The
      -- UNIQUE index over (channelId, nameKey) is what MAKES "the same name
      -- again is a new version" true — if two publishes race, SQLite refuses
      -- the second row rather than letting two files with one name exist and
      -- letting the screen pick whichever it read first. "nextVersion" is kept
      -- HERE and only ever goes up, so a version number is never reused even
      -- after the oldest versions have been pruned away.
      --
      -- A WHOLE NEW TABLE NEEDS NO MIGRATION STEP: CREATE TABLE IF NOT EXISTS
      -- makes it on a fresh file and on an old one alike, and no index here is
      -- over a column a migration adds (see migrate()).
      CREATE TABLE IF NOT EXISTS artifacts(
        id TEXT PRIMARY KEY, channelId TEXT NOT NULL, name TEXT NOT NULL,
        nameKey TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        nextVersion INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS art_chan_name ON artifacts(channelId, nameKey);
      CREATE INDEX IF NOT EXISTS art_chan ON artifacts(channelId, updatedAt);

      -- "artifact_versions" is one row per set of bytes, and the bytes
      -- themselves are on disk exactly as an attachment's are. The columns
      -- beside the JSON are the ones authorisation, ordering and pruning are
      -- decided from: channelId is written by the hub from the artifact's own
      -- row, never from the frame, because a report is not a permission.
      CREATE TABLE IF NOT EXISTS artifact_versions(
        id TEXT PRIMARY KEY, artifactId TEXT NOT NULL, channelId TEXT NOT NULL,
        agentId TEXT NOT NULL, version INTEGER NOT NULL,
        producedAt INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS av_art ON artifact_versions(artifactId, version);
      CREATE INDEX IF NOT EXISTS av_agent ON artifact_versions(agentId, producedAt);

      -- WHO IS IN A ROOM — a row each, not an array of ids inside the channel.
      --
      -- An array could only ever say "these people are in here now". It could
      -- not say when someone joined, who let them in, what they may change, or
      -- that they left — so "who was in the room when this was said" had no
      -- answer at all. removedAt is a SOFT delete, like a reaction: the row
      -- stays, so the record still knows the person was once here. Every read
      -- of "who is in here" filters on removedAt IS NULL.
      --
      -- ONE ROW PER SPELL IN THE ROOM, not one row per person. The key carries
      -- joinedAt, so someone who was removed and later let back in gets a
      -- SECOND row. The old single-row key forced a rejoin to overwrite the
      -- first visit, which destroyed the two facts this table exists to hold —
      -- when they first arrived and who let them in — and made "who was in this
      -- room at that moment" answer yes for a moment they were out of it.
      -- The partial unique index below is what still guarantees a person can
      -- only be in a room once at a time.
      CREATE TABLE IF NOT EXISTS channel_members(
        channelId TEXT NOT NULL, memberId TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        joinedAt INTEGER NOT NULL, invitedBy TEXT,
        removedAt INTEGER, removedBy TEXT,
        PRIMARY KEY (channelId, memberId, joinedAt)
      );
      CREATE INDEX IF NOT EXISTS cm_member ON channel_members(memberId);

      -- WHAT AN AGENT ACTUALLY DID, one row per turn (FR-TL-003).
      --
      -- The engine's own copy on disk is the local truth; this is the copy
      -- other people's screens read, and it only ever holds the REDACTED
      -- version. The columns beside the JSON are the ones authorisation and
      -- pruning are decided from: ownerId and channelId are written by the hub
      -- from stored state, never copied out of the record, because a record is
      -- a report and a report is not a permission.
      CREATE TABLE IF NOT EXISTS runs(
        id TEXT PRIMARY KEY, agentId TEXT NOT NULL, ownerId TEXT NOT NULL,
        channelId TEXT, taskId TEXT, startedAt INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS run_agent ON runs(agentId, startedAt);
      CREATE INDEX IF NOT EXISTS run_task ON runs(taskId);

      -- Read state lives HERE, on the account, so it follows a person between
      -- machines. It used to live in one browser's localStorage.
      CREATE TABLE IF NOT EXISTS reads(
        userId TEXT NOT NULL, channelId TEXT NOT NULL,
        lastReadTs INTEGER NOT NULL, lastReadId TEXT, updatedAt INTEGER NOT NULL,
        PRIMARY KEY (userId, channelId)
      );

      -- Durable per-user saves. Unsaving is a soft removal so retention is
      -- explicit: active rows stay until the owner unsaves them; deleted or
      -- inaccessible source rows remain as honest tombstones while saved.
      CREATE TABLE IF NOT EXISTS saved_messages(
        userId TEXT NOT NULL, messageId TEXT NOT NULL, channelId TEXT NOT NULL,
        savedAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        note TEXT, remindAt INTEGER, removedAt INTEGER,
        PRIMARY KEY (userId, messageId)
      );
      CREATE INDEX IF NOT EXISTS saved_user_order
        ON saved_messages(userId, removedAt, savedAt DESC, messageId DESC);
      -- Request receipts cover retries across reconnects without making a
      -- second save move its position or erase its note. Receipts are bounded
      -- below; saved rows themselves remain durable until the owner unsaves.
      CREATE TABLE IF NOT EXISTS saved_mutation_receipts(
        userId TEXT NOT NULL, requestId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('saveMessage','unsaveMessage')),
        payloadHash TEXT NOT NULL, createdAt INTEGER NOT NULL,
        PRIMARY KEY (userId, requestId)
      );
      CREATE INDEX IF NOT EXISTS saved_receipt_order
        ON saved_mutation_receipts(userId, createdAt DESC);

      -- Shared channel pins. Removing a pin or losing its source is a soft
      -- tombstone; active reads use the stable (pinnedAt,messageId) keyset.
      CREATE TABLE IF NOT EXISTS channel_pins(
        channelId TEXT NOT NULL, messageId TEXT NOT NULL,
        pinnedAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        pinnedById TEXT NOT NULL, removedAt INTEGER,
        PRIMARY KEY(channelId, messageId)
      );
      CREATE INDEX IF NOT EXISTS channel_pin_order
        ON channel_pins(channelId, removedAt, pinnedAt DESC, messageId DESC);
      CREATE TABLE IF NOT EXISTS channel_pin_receipts(
        userId TEXT NOT NULL, requestId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('pinMessage','unpinMessage')),
        payloadHash TEXT NOT NULL, channelId TEXT NOT NULL, messageId TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY(userId, requestId)
      );
      CREATE INDEX IF NOT EXISTS channel_pin_receipt_order
        ON channel_pin_receipts(userId, createdAt DESC);

      -- Durable mention and thread-reply events. The event id is generated by
      -- the relay from (kind, recipient, source message), so INSERT OR IGNORE
      -- is the idempotence rule even if a reconnect/replay repeats the event.
      CREATE TABLE IF NOT EXISTS notification_inbox(
        id TEXT PRIMARY KEY, recipientId TEXT NOT NULL,
        kind TEXT NOT NULL, channelId TEXT NOT NULL, messageId TEXT NOT NULL,
        rootId TEXT, actorId TEXT NOT NULL, createdAt INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'unread'
      );
      CREATE INDEX IF NOT EXISTS notification_recipient
        ON notification_inbox(recipientId, state, createdAt DESC, id DESC);

      -- A GITHUB REPOSITORY CONNECTED TO CLOUD9 (his item 7).
      --
      -- A WHOLE NEW TABLE NEEDS NO MIGRATION STEP, and that is not a shortcut:
      -- CREATE TABLE IF NOT EXISTS above makes it on a fresh file and on an
      -- old one alike, and nothing here is a COLUMN added to an existing table
      -- or an index over one. The rule the migration comment states — never
      -- index a column a migration adds — is respected because no migration
      -- step is involved at all. ownerId sits beside the JSON because it is
      -- the column authorisation is decided from, exactly as the runs table.
      CREATE TABLE IF NOT EXISTS projects(
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, repo TEXT NOT NULL,
        createdAt INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS proj_owner ON projects(ownerId);
      -- one person may connect one repository once; connecting it again finds
      -- the project they already have rather than making a second one
      CREATE UNIQUE INDEX IF NOT EXISTS proj_owner_repo ON projects(ownerId, repo);
      CREATE TABLE IF NOT EXISTS hooks(
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, updatedAt INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hooks_owner ON hooks(ownerId, updatedAt DESC);
      CREATE TABLE IF NOT EXISTS hook_audit(
        id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, hookId TEXT NOT NULL,
        action TEXT NOT NULL, ok INTEGER NOT NULL, said TEXT NOT NULL, at INTEGER NOT NULL,
        actorId TEXT NOT NULL DEFAULT '', client TEXT NOT NULL DEFAULT '',
        requestId TEXT, target TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS hook_requests(
        ownerId TEXT NOT NULL, requestId TEXT NOT NULL, hookId TEXT NOT NULL,
        kind TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL,
        createdAt INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(ownerId, requestId)
      );

      -- ITS PULL REQUESTS AND ITS ISSUES — a cache of GitHub's truth, never
      -- ours. The key is (project, kind, number) because that is what GitHub
      -- guarantees unique, so a re-sync UPDATES a row instead of growing a
      -- second copy of the same pull request.
      CREATE TABLE IF NOT EXISTS project_items(
        projectId TEXT NOT NULL, kind TEXT NOT NULL, number INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY (projectId, kind, number)
      );
      CREATE INDEX IF NOT EXISTS proj_item_updated ON project_items(projectId, updatedAt);

      -- Engineering Canvas documents and immutable revision snapshots.
      CREATE TABLE IF NOT EXISTS engineering_canvases(
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, ownerId TEXT NOT NULL,
        title TEXT NOT NULL, revision INTEGER NOT NULL, createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL, deletedAt INTEGER, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS canvas_project ON engineering_canvases(projectId, updatedAt);
      CREATE TABLE IF NOT EXISTS engineering_canvas_revisions(
        canvasId TEXT NOT NULL, revision INTEGER NOT NULL, changedAt INTEGER NOT NULL,
        changedBy TEXT NOT NULL, summary TEXT NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY(canvasId, revision)
      );
      CREATE TABLE IF NOT EXISTS engineering_canvas_reads(
        canvasId TEXT NOT NULL, userId TEXT NOT NULL, revision INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL, PRIMARY KEY(canvasId,userId)
      );
      CREATE TABLE IF NOT EXISTS engineering_canvas_requests(
        ownerId TEXT NOT NULL, requestId TEXT NOT NULL, canvasId TEXT NOT NULL,
        action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}', createdAt INTEGER NOT NULL,
        PRIMARY KEY(ownerId, requestId)
      );

      CREATE TABLE IF NOT EXISTS public_updates(
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, updatedAt INTEGER NOT NULL,
        publicToken TEXT, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS public_update_project ON public_updates(projectId, updatedAt);
      CREATE UNIQUE INDEX IF NOT EXISTS public_update_token ON public_updates(publicToken) WHERE publicToken IS NOT NULL;
      CREATE TABLE IF NOT EXISTS public_revisions(
        id TEXT PRIMARY KEY, draftId TEXT NOT NULL, revision INTEGER NOT NULL,
        publishedAt INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS public_revision_number ON public_revisions(draftId, revision);
      CREATE TABLE IF NOT EXISTS public_audit(
        id TEXT PRIMARY KEY, draftId TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS huddles(id TEXT PRIMARY KEY, projectId TEXT NOT NULL, startedAt INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS huddle_project ON huddles(projectId,startedAt);
      CREATE TABLE IF NOT EXISTS huddle_notes(id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, createdAt INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS huddle_note_session ON huddle_notes(sessionId,createdAt);
      CREATE TABLE IF NOT EXISTS huddle_members(sessionId TEXT NOT NULL,userId TEXT NOT NULL,joinedAt INTEGER NOT NULL,leftAt INTEGER,PRIMARY KEY(sessionId,userId,joinedAt));
      CREATE TABLE IF NOT EXISTS huddle_reads(userId TEXT NOT NULL,sessionId TEXT NOT NULL,lastReadAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,PRIMARY KEY(userId,sessionId));
      CREATE TABLE IF NOT EXISTS huddle_ops(userId TEXT NOT NULL,requestId TEXT NOT NULL,kind TEXT NOT NULL,targetId TEXT NOT NULL,payloadHash TEXT NOT NULL,resultId TEXT NOT NULL,createdAt INTEGER NOT NULL,PRIMARY KEY(userId,requestId));
      CREATE INDEX IF NOT EXISTS huddle_ops_target ON huddle_ops(targetId,createdAt);

      -- Internal project social feed. Posts and comments share one durable
      -- table; parentId makes comments chronological without a second tree.
      CREATE TABLE IF NOT EXISTS social_posts(
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, parentId TEXT,
        authorId TEXT NOT NULL, ownerId TEXT NOT NULL, authorKind TEXT NOT NULL,
        createdAt INTEGER NOT NULL, deletedAt INTEGER, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS social_project_time ON social_posts(projectId, createdAt, id);
      CREATE INDEX IF NOT EXISTS social_parent ON social_posts(projectId, parentId, createdAt, id);
      CREATE TABLE IF NOT EXISTS social_reactions(
        projectId TEXT NOT NULL, postId TEXT NOT NULL, actorId TEXT NOT NULL,
        emoji TEXT NOT NULL, ts INTEGER NOT NULL, removedAt INTEGER,
        PRIMARY KEY(postId, actorId, emoji)
      );
      CREATE INDEX IF NOT EXISTS social_react_post ON social_reactions(postId);
      CREATE TABLE IF NOT EXISTS social_reads(
        userId TEXT NOT NULL, projectId TEXT NOT NULL, lastReadAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL, PRIMARY KEY(userId, projectId)
      );
      CREATE TABLE IF NOT EXISTS social_members(
        projectId TEXT NOT NULL, userId TEXT NOT NULL, addedAt INTEGER NOT NULL,
        removedAt INTEGER, PRIMARY KEY(projectId, userId)
      );
      CREATE INDEX IF NOT EXISTS social_member_user ON social_members(userId);
      CREATE TABLE IF NOT EXISTS social_ops(
        userId TEXT NOT NULL, requestId TEXT NOT NULL, kind TEXT NOT NULL,
        projectId TEXT, payloadHash TEXT NOT NULL DEFAULT '', resultJson TEXT NOT NULL, createdAt INTEGER NOT NULL,
        PRIMARY KEY(userId, requestId, kind)
      );
      CREATE INDEX IF NOT EXISTS social_ops_created ON social_ops(createdAt);
      -- Durable Engineering Pulse updates.  Deletion is a tombstone in JSON,
      -- so the chronological feed can honestly say an entry was removed.
      CREATE TABLE IF NOT EXISTS pulse_updates(
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, authorId TEXT NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        deletedAt INTEGER, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pulse_project_created
        ON pulse_updates(projectId, createdAt DESC, id DESC);
      CREATE TABLE IF NOT EXISTS pulse_reads(
        userId TEXT NOT NULL, projectId TEXT NOT NULL,
        lastReadAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY(userId, projectId)
      );
      CREATE TABLE IF NOT EXISTS pulse_mutation_receipts(
        userId TEXT NOT NULL, requestId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('pulseCreate','pulseUpdate','pulseDelete')),
        payloadHash TEXT NOT NULL, updateId TEXT NOT NULL, projectId TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY(userId, requestId)
      );
      CREATE INDEX IF NOT EXISTS pulse_receipt_order
        ON pulse_mutation_receipts(userId, createdAt DESC);

      -- Durable project decisions. Poll rows carry projectId beside JSON so
      -- access checks never trust a client-provided projection.
      CREATE TABLE IF NOT EXISTS project_polls(
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, createdAt INTEGER NOT NULL,
        status TEXT NOT NULL, deadlineAt INTEGER, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS poll_project ON project_polls(projectId, createdAt);
      CREATE TABLE IF NOT EXISTS project_poll_votes(
        pollId TEXT NOT NULL, voterId TEXT NOT NULL, optionId TEXT NOT NULL,
        votedAt INTEGER NOT NULL, PRIMARY KEY (pollId, voterId)
      );
      CREATE INDEX IF NOT EXISTS poll_vote_poll ON project_poll_votes(pollId);
      -- A desktop retry reuses its request id. This row is the durable
      -- idempotency receipt, scoped to the authenticated owner and project.
      CREATE TABLE IF NOT EXISTS project_poll_requests(
        ownerId TEXT NOT NULL, requestId TEXT NOT NULL, projectId TEXT NOT NULL,
        pollId TEXT NOT NULL, createdAt INTEGER NOT NULL,
        PRIMARY KEY (ownerId, requestId)
      );

      -- Project forums / decision threads. Tables are created here so a fresh
      -- file and an older one both get them; owner membership is backfilled in
      -- the dedicated schema step (v10) so hubs already at Pulse v9 still run it.
      CREATE TABLE IF NOT EXISTS forum_members(
        projectId TEXT NOT NULL, userId TEXT NOT NULL, addedAt INTEGER NOT NULL,
        removedAt INTEGER, PRIMARY KEY(projectId,userId)
      );
      CREATE INDEX IF NOT EXISTS forum_member_user ON forum_members(userId,removedAt);
      CREATE TABLE IF NOT EXISTS forum_topics(
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS forum_topic_project ON forum_topics(projectId,createdAt,id);
      CREATE TABLE IF NOT EXISTS forum_replies(
        id TEXT PRIMARY KEY, topicId TEXT NOT NULL, createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS forum_reply_topic ON forum_replies(topicId,createdAt,id);
      CREATE TABLE IF NOT EXISTS forum_reads(
        userId TEXT NOT NULL, projectId TEXT NOT NULL, lastReadAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL, PRIMARY KEY(userId,projectId)
      );
      CREATE TABLE IF NOT EXISTS forum_ops(
        userId TEXT NOT NULL, requestId TEXT NOT NULL, projectId TEXT NOT NULL DEFAULT '', targetId TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL, resultId TEXT NOT NULL, payloadHash TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL,
        PRIMARY KEY(userId,requestId)
      );
      CREATE INDEX IF NOT EXISTS poll_request_project ON project_poll_requests(projectId);
    `);
      this.migrate();
      // v9 files created by the first Pulse build may already report the
      // current version while lacking the receipt's project binding. Repair
      // that shape before any request can read or write a receipt.
      this.tx(() => this.ensurePulseReceiptProjectColumn());
      this.sweepArtifactOrphans();
      this.initSearch();
    } catch (e) {
      // A migration that threw has already been rolled back by `step()`, so the
      // file is still the shape it was. Say which file and why, once, in words
      // the owner can act on.
      throw new StoreOpenError(dbPath, e);
    }
  }

  /**
   * Run one piece of work as ALL OF IT OR NONE OF IT.
   *
   * Every migration step goes through here, together with the version bump that
   * records it. Without this a step that was interrupted half way — a laptop
   * lid, a crash, a kill — left the database in a shape no version number
   * described, and the next start either skipped the rest of the step forever
   * or re-ran it on top of itself. With it there are only two states: the step
   * ran and the version moved, or neither happened.
   *
   * IMMEDIATE, not DEFERRED: the write lock is taken up front, so two hubs
   * opening the same file cannot both decide they are the one doing the
   * migration.
   */
  private tx<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = work();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* the transaction is already gone */ }
      throw e;
    }
  }

  /**
   * Read one stored JSON row, or record why it could not be read and give back
   * nothing.
   *
   * A row written by a newer build, truncated by a full disk, or corrupted on
   * the way to the platter must not be able to stop the hub from ever opening
   * again. The caller decides what to do without the row; the reason is kept in
   * `problems` so it can be shown rather than guessed at.
   */
  private safeParse<T>(json: string, what: string, id: string): T | undefined {
    try {
      return JSON.parse(json) as T;
    } catch (e) {
      this.note(`${what} ${id} could not be read (${(e as Error).message}) — it was skipped`);
      return undefined;
    }
  }

  private note(problem: string): void {
    if (!this.problems.includes(problem)) this.problems.push(problem);
  }

  // ---- search index ----
  //
  // SQLite's own FTS5, not a full-text engine of our own. It is compiled into
  // the SQLite that ships inside Node, it is in the same file and the same
  // transaction as the messages, and it costs nothing to keep alive.
  //
  // WHAT IT IS GOOD AT: whole words, in any order, prefix-matched on the last
  // word so typing keeps narrowing as you go.
  // WHAT IT IS NOT: the default tokenizer splits on non-letters, so it will not
  // find a word in the MIDDLE of another word ("port" does not find "airport"),
  // and it does not stem ("running" does not find "run"). Those are the honest
  // limits; both are fixable later with a different tokenizer if he asks.

  /** True when this database has a working FTS5 index. */
  searchIndexed = false;

  /**
   * ONE INDEX, NOT ONE PER THING FINDABLE.
   *
   * `search_docs` replaces the old `messages_fts`. It is the same SQLite FTS5,
   * in the same file and the same transactions — what changed is that a row no
   * longer has to be a message. A second virtual table for files would have
   * been a second index scheme: two backfills to keep complete, two rebuild
   * guards, two chances for one of them to be quietly wrong, and two places to
   * remember the permission rule. There is one.
   *
   * A row is (text, kind, channelId, docId, parentId, ts):
   *
   *   kind `message`      docId = message id,  parentId = its `replyTo` or ''
   *   kind `file`         docId = artifact id, parentId = the SAME artifact id
   *   kind `fileVersion`  docId = version id,  parentId = its artifact id
   *
   * `parentId` is deliberately the artifact id on BOTH file kinds, so the file
   * permission check is one clause keyed on one column rather than a CASE that
   * has to be right in four subqueries. On a message it carries the thread
   * parent, which is both what tells a reply from a root and the id a client
   * needs to open the thread.
   *
   * `ts` is stored as text because every FTS5 column is; it is CAST back for
   * ordering. Sorting the string would put "9" after "10".
   */
  private initSearch(): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS search_docs USING fts5(
          text, kind UNINDEXED, channelId UNINDEXED,
          docId UNINDEXED, parentId UNINDEXED, ts UNINDEXED
        );
      `);
      // The old message-only index is derived data, so it is dropped rather
      // than migrated: the completeness guard below rebuilds every row from the
      // messages, artifacts and versions that are the actual truth. Leaving it
      // would be a second index nobody writes to and somebody later reads.
      this.db.exec("DROP TABLE IF EXISTS messages_fts;");
      this.searchIndexed = true;
    } catch {
      // An old SQLite without FTS5 must not stop the hub from starting; search
      // falls back to a plain LIKE scan, which is slower and dumber but true.
      this.searchIndexed = false;
      return;
    }
    this.backfillSearch();
  }

  /**
   * Make the index hold EVERY message that should be findable — or do nothing.
   *
   * THE GUARD IS COMPLETENESS, NOT EMPTINESS. It used to be "the index has at
   * least one row in it", and that is the wrong question: a backfill that was
   * interrupted after eight messages of thirty left an index that was non-empty
   * and permanently, silently wrong — search simply never found the other
   * twenty-two, with no error anywhere. Counting what SHOULD be in there
   * against what IS means an interrupted run is detected on the next start and
   * finished, and a complete one costs two counts.
   *
   * The rebuild is one transaction, so it is all of it or none of it. An
   * interruption rolls back to the previous index and the next start tries
   * again — never a half-filled one that looks finished.
   */
  private backfillSearch(): void {
    if (!this.searchIndexed) return;
    if (this.searchIndexComplete()) return;
    this.tx(() => {
      this.db.exec("DELETE FROM search_docs");
      const messages = this.db.prepare("SELECT id,channelId,json FROM messages").all() as
        { id: string; channelId: string; json: string }[];
      for (const r of messages) {
        const m = this.safeParse<Message>(r.json, "a message", r.id);
        if (!m || m.deletedAt) continue;
        this.indexMessage(m);
      }
      const artifacts = this.db.prepare(
        "SELECT id,channelId,name,updatedAt FROM artifacts a " +
        "WHERE EXISTS (SELECT 1 FROM artifact_versions av WHERE av.artifactId=a.id)",
      ).all() as { id: string; channelId: string; name: string; updatedAt: number }[];
      for (const a of artifacts) {
        this.indexArtifactName(a.id, a.channelId, a.name, a.updatedAt);
      }
      const versions = this.db.prepare(
        "SELECT id,artifactId,channelId,json FROM artifact_versions",
      ).all() as { id: string; artifactId: string; channelId: string; json: string }[];
      for (const r of versions) {
        const v = this.storedArtifactVersion(r.json, r.id);
        if (!v || !v.text) continue;
        this.indexArtifactVersion(r.artifactId, r.channelId, v);
      }
    });
  }

  /**
   * True when everything that should be findable is in the index.
   *
   * The three counts are the three kinds of document, and they are counted from
   * the tables that actually own the truth. A file version that says it is text
   * is counted whether or not its bytes could be read: `indexArtifactVersion`
   * writes an empty document for unreadable bytes precisely so that this count
   * can stay the guard instead of an interrupted rebuild every single start.
   */
  searchIndexComplete(): boolean {
    if (!this.searchIndexed) return false;
    const want = (this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM messages WHERE json_extract(json,'$.deletedAt') IS NULL)
      + (SELECT COUNT(*) FROM artifacts a
           WHERE EXISTS (SELECT 1 FROM artifact_versions av WHERE av.artifactId=a.id))
      + (SELECT COUNT(*) FROM artifact_versions WHERE json_extract(json,'$.text')=1)
      AS n
    `).get() as { n: number }).n;
    const have = (this.db.prepare("SELECT COUNT(*) n FROM search_docs").get() as { n: number }).n;
    return have === want;
  }

  /** Take one document out of the index, whatever kind it was. */
  private unindexDoc(docId: ID): void {
    if (!this.searchIndexed) return;
    this.db.prepare("DELETE FROM search_docs WHERE docId=?").run(docId);
  }

  private indexMessage(m: Message): void {
    if (!this.searchIndexed) return;
    this.unindexDoc(m.id);
    if (m.deletedAt) return;
    this.db.prepare(
      "INSERT INTO search_docs(text,kind,channelId,docId,parentId,ts) VALUES(?,?,?,?,?,?)",
    ).run(m.text, "message", m.channelId, m.id, m.replyTo ?? "", String(m.ts));
  }

  /**
   * The file's shared NAME, as its own document.
   *
   * One per artifact identity, not one per version: the name is a property of
   * the chain, and a row per version would show the same file five times to
   * somebody who searched for its name.
   */
  indexArtifactName(artifactId: ID, channelId: ID, name: string, updatedAt: number): void {
    if (!this.searchIndexed) return;
    this.unindexDoc(artifactId);
    this.db.prepare(
      "INSERT INTO search_docs(text,kind,channelId,docId,parentId,ts) VALUES(?,?,?,?,?,?)",
    ).run(name, "file", channelId, artifactId, artifactId, String(updatedAt));
  }

  /**
   * The WORDS INSIDE one retained version, when the hub could read them as text.
   *
   * Older retained versions are indexed exactly like the newest one — that is
   * the whole point of keeping them. Bytes that cannot be read right now still
   * get a document, an empty one, so the completeness count above stays true
   * and one unreadable file cannot make the hub rebuild its index forever.
   */
  indexArtifactVersion(artifactId: ID, channelId: ID, v: StoredArtifactVersion): void {
    if (!this.searchIndexed) return;
    this.unindexDoc(v.id);
    if (!v.text) return;
    this.db.prepare(
      "INSERT INTO search_docs(text,kind,channelId,docId,parentId,ts) VALUES(?,?,?,?,?,?)",
    ).run(
      this.artifactTextForIndex(v.storedAs), "fileVersion", channelId,
      v.id, artifactId, String(v.producedAt),
    );
  }

  /**
   * Read at most `indexTextBytes` of one stored version, as text.
   *
   * Nothing here is ever logged or returned to a caller: a failure is an empty
   * document, because the alternative — a path or an errno on its way to a
   * screen or a log line — tells somebody where the hub keeps its files.
   */
  private artifactTextForIndex(storedAs: string): string {
    try {
      const full = path.join(this.artifactsDir, path.basename(storedAs));
      const fd = fs.openSync(full, "r");
      try {
        const buf = Buffer.alloc(MESSAGE_LIMITS.indexTextBytes);
        const read = fs.readSync(fd, buf, 0, buf.length, 0);
        return buf.subarray(0, read).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return "";
    }
  }

  /**
   * Bring a database written by an older build up to date. An existing
   * `invites` table has no `usedAt`/`revoked` columns, and without them a
   * spent invite would keep behaving like the bearer credential this round is
   * removing — so the columns are added, and every already-spent invite is
   * marked revoked on the way through.
   */
  private migrate(): void {
    const columns = (this.db.prepare("PRAGMA table_info(invites)").all() as { name: string }[])
      .map(c => c.name);
    if (!columns.includes("usedAt")) {
      this.db.exec("ALTER TABLE invites ADD COLUMN usedAt INTEGER");
    }
    if (!columns.includes("revoked")) {
      this.db.exec("ALTER TABLE invites ADD COLUMN revoked INTEGER NOT NULL DEFAULT 0");
      // an invite spent under the old rules must not be re-usable under the new
      this.db.exec("UPDATE invites SET revoked=1 WHERE usedBy IS NOT NULL");
    }
    // Tables that existed before this round need their new columns added; a
    // fresh database already has them from the CREATE above, and ALTER on an
    // existing column is an error, so both are checked rather than assumed.
    this.addColumn("reactions", "removedAt", "INTEGER");
    this.addColumn("activity", "seq", "INTEGER");
    this.addColumn("activity", "hash", "TEXT");
    this.addColumn("activity", "prevHash", "TEXT");
    this.addColumn("hook_audit", "actorId", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("hook_audit", "client", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("hook_audit", "requestId", "TEXT");
    this.addColumn("hook_audit", "target", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("hook_requests", "kind", "TEXT NOT NULL DEFAULT 'legacy'");
    this.addColumn("hook_requests", "target", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("hook_requests", "payload", "TEXT NOT NULL DEFAULT '{}'");
    this.addColumn("hook_requests", "createdAt", "INTEGER NOT NULL DEFAULT 0");
    this.addColumn("social_ops", "payloadHash", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("social_ops", "projectId", "TEXT");
    this.addColumn("reads", "lastReadId", "TEXT");
    // AN INDEX CAN ONLY BE BUILT OVER A COLUMN THAT EXISTS, so it is built
    // here, after the ALTERs, and not up in the CREATE block with the others.
    //
    // This is a real bug that a real file found: `CREATE TABLE IF NOT EXISTS`
    // does nothing to a table that is already there, so on a database written
    // before the ledger the `activity` table had no `seq` column — and
    // `CREATE UNIQUE INDEX ... ON activity(seq)`, sitting above the migration,
    // threw "no such column: seq" before the migration could add it. The hub
    // could not open its own older file at all.
    //
    // THE CLASS, NOT THE CASE: every index over a column that a migration adds
    // belongs here, below the ALTERs. Nothing in the CREATE block may name a
    // column that any migration step is responsible for.
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS act_seq ON activity(seq)");
    this.db.exec("CREATE INDEX IF NOT EXISTS hook_requests_owner_created ON hook_requests(ownerId, createdAt DESC, requestId DESC)");
    this.db.exec("CREATE INDEX IF NOT EXISTS hook_audit_owner_at ON hook_audit(ownerId, at DESC, id DESC)");

    // THE STEPPER. Each step is a function of the version it starts from, runs
    // once, and is written so that running it AGAIN on an already-migrated
    // database changes nothing — because the one thing worse than an
    // un-migrated database is a half-migrated one, and the only way to be able
    // to say "just run it again" is to make that true.
    //
    // AND EACH STEP IS ONE TRANSACTION, together with the version bump that
    // records it (`step`). Idempotence alone was not enough: a step that was
    // killed part-way through left rows that no version number described, and a
    // version bump that landed while its own work had not finished left the
    // work undone forever. Now there are only two outcomes per step — it
    // happened and the number moved, or nothing happened at all and the next
    // start does it again.

    // v1 → v2: the trail becomes a ledger. Rows written before the chain
    // existed are numbered and hashed in time order, ONCE. This does not make
    // them trustworthy — nothing can, after the fact — it makes everything
    // written from here on detectable if it is altered.
    this.step(2, () => this.chainExistingActivity());

    // v2 → v3: membership becomes rows.
    this.step(3, () => this.backfillChannelMembers());

    // v3 → v4: run records.
    //
    // NOTHING TO BACKFILL, and that is the honest answer rather than a
    // missing step: a database written before this round holds no record of
    // what any agent did, and inventing rows for turns nobody watched is
    // exactly the lie this feature exists to stop. The table itself is
    // brand new, so `CREATE TABLE IF NOT EXISTS` above has already made it on
    // a fresh file and an old one alike — and because no migration step adds
    // a COLUMN here, its indexes may safely live up there with it (the rule
    // the activity(seq) bug taught us).
    this.step(4, () => { /* nothing to carry forward */ });

    // v4 → v5: a membership row per SPELL in the room, not per person.
    this.step(5, () => this.rekeyChannelMembers());

    // v5 → v6: the Files workspace. Existing artifacts inherit their room's
    // access because no access row is written for them. The unique version rule
    // is added inside the migration transaction, after first proving the old
    // data already satisfies it; a migration must never silently pick one of two
    // immutable rows and throw the other away.
    this.step(6, () => this.addArtifactWorkspaceSchema());

    // v6 → v7: saved manual workflow definitions and their durable run history.
    // The tables are also created in the guarded open above, so an interrupted
    // or older database can safely retry this idempotent step.
    this.step(7, () => this.addWorkflowSchema());
    this.step(8, () => this.addSavedMessagesSchema());
    // v8 -> v9: Engineering Pulse. Workflow owns v7 and Saved/Later owns v8;
    // Pulse remains the next migration when those features are present.
    this.step(9, () => this.addEngineeringPulseSchema());
    // v9 -> v10: project forums / decision threads. Pulse already owns v9;
    // forums take the next free step so hubs upgraded to Pulse still run
    // the owner backfill and receipt-binding repair.
    this.step(10, () => this.addForumSchema());
    // v10 -> v11: Engineering Canvas. Forums already own v10 on master;
    // canvas takes the next free step so hubs upgraded to forums still run.
    this.step(11, () => this.addEngineeringCanvasSchema());
    // v11 -> v12: shared channel pins and their bounded retry ledger.
    this.step(12, () => this.addChannelPinsSchema());
    // v12 -> v13: durable human message acknowledgement ledger and receipts.
    this.step(13, () => this.addMessageReceiptsSchema());
    // v13 -> v14: durable composer rows and bounded retry ledger. The tables
    // are also declared during guarded open for fresh databases; this isolated
    // step is what upgrades an existing file atomically.
    this.step(14, () => this.addChatDraftSchema());

    // The one thing that still says a person can only be in a room once at a
    // time, now that the primary key no longer does. It lives here, below the
    // step that reshapes the table, for the same reason act_seq does.
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS cm_live ON channel_members(channelId,memberId) WHERE removedAt IS NULL",
    );
  }

  private addSocialOperationSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS social_ops(
        userId TEXT NOT NULL, requestId TEXT NOT NULL, kind TEXT NOT NULL,
        projectId TEXT, payloadHash TEXT NOT NULL DEFAULT '', resultJson TEXT NOT NULL, createdAt INTEGER NOT NULL,
        PRIMARY KEY(userId, requestId, kind)
      );
      CREATE INDEX IF NOT EXISTS social_ops_created ON social_ops(createdAt);
    `);
  }

  /**
   * Run one migration step and record it, as a single all-or-nothing write.
   *
   * The version bump is INSIDE the transaction on purpose. That is the whole
   * fix: the number in the file and the shape of the file can no longer
   * disagree, whatever happens to the process in the middle.
   */
  private step(to: number, work: () => void): void {
    if (this.schemaVersion() >= to) return;
    this.tx(() => {
      work();
      this.setSchemaVersion(to);
    });
  }

  /**
   * v5 → v6. Add the Files workspace's access and exact-version link rows,
   * plus the database rule that makes an artifact version immutable.
   *
   * NO LEGACY ROW IS REWRITTEN. Existing artifacts have no `artifact_access`
   * row, which means "inherit the room". A duplicate version in an old file is
   * reported instead of guessed at: renumbering one would change a stable exact
   * reference, and deleting one would destroy retained bytes.
   */
  private addWorkflowSchema(): void {
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS workflows(" +
      "id TEXT PRIMARY KEY, ownerId TEXT NOT NULL, updatedAt INTEGER NOT NULL, json TEXT NOT NULL);" +
      "CREATE INDEX IF NOT EXISTS workflow_owner ON workflows(ownerId, updatedAt);" +
      "CREATE TABLE IF NOT EXISTS workflow_runs(" +
      "id TEXT PRIMARY KEY, workflowId TEXT NOT NULL, ownerId TEXT NOT NULL," +
      "updatedAt INTEGER NOT NULL, json TEXT NOT NULL);" +
      "CREATE INDEX IF NOT EXISTS workflow_run_owner ON workflow_runs(ownerId, updatedAt);" +
      "CREATE INDEX IF NOT EXISTS workflow_run_workflow ON workflow_runs(workflowId, updatedAt);",
    );
  }

  private addArtifactWorkspaceSchema(): void {
    const duplicate = this.db.prepare(
      "SELECT artifactId,version,COUNT(*) n FROM artifact_versions " +
      "GROUP BY artifactId,version HAVING COUNT(*) > 1 LIMIT 1",
    ).get() as { artifactId: string; version: number; n: number } | undefined;
    if (duplicate) {
      throw new Error(
        `shared file ${duplicate.artifactId} has ${duplicate.n} rows claiming version ${duplicate.version}; ` +
        "Cloud9 left them untouched because immutable versions cannot be guessed at",
      );
    }
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS av_art_version
        ON artifact_versions(artifactId, version);

      -- No row means room-default access. A row exists only when the room's
      -- owner/admin narrowed the whole chain to selected current people; an
      -- empty selected list is valid because current room managers are always
      -- included at read time.
      CREATE TABLE IF NOT EXISTS artifact_access(
        artifactId TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('room','restricted'))
      );
      CREATE TABLE IF NOT EXISTS artifact_access_users(
        artifactId TEXT NOT NULL, userId TEXT NOT NULL, position INTEGER NOT NULL,
        PRIMARY KEY (artifactId, userId)
      );
      CREATE INDEX IF NOT EXISTS aau_user ON artifact_access_users(userId, artifactId);

      -- Links belong to the exact source version and name an exact target
      -- version. No foreign key is used for the target: retention may remove
      -- those bytes, and the link must then stay pinned and say unavailable,
      -- never slide forward to a newer target.
      CREATE TABLE IF NOT EXISTS artifact_links(
        sourceArtifactId TEXT NOT NULL, sourceVersion INTEGER NOT NULL,
        channelId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('made-from','goes-with')),
        targetArtifactId TEXT NOT NULL, targetVersion INTEGER NOT NULL,
        PRIMARY KEY (sourceArtifactId, sourceVersion, kind, targetArtifactId, targetVersion)
      );
      CREATE INDEX IF NOT EXISTS al_target
        ON artifact_links(targetArtifactId, targetVersion, sourceArtifactId, sourceVersion);
    `);
    this.addColumn("artifact_access_users", "position", "INTEGER NOT NULL DEFAULT 0");
  }

  private addEngineeringPulseSchema(): void {
    // Older files may have received the CREATE block from a partially upgraded
    // process without its indexes. CREATE IF NOT EXISTS is safe to replay.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pulse_updates(
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, authorId TEXT NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        deletedAt INTEGER, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS pulse_project_created
        ON pulse_updates(projectId, createdAt DESC, id DESC);
      CREATE TABLE IF NOT EXISTS pulse_reads(
        userId TEXT NOT NULL, projectId TEXT NOT NULL,
        lastReadAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY(userId, projectId)
      );
      CREATE TABLE IF NOT EXISTS pulse_mutation_receipts(
        userId TEXT NOT NULL, requestId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('pulseCreate','pulseUpdate','pulseDelete')),
        payloadHash TEXT NOT NULL, updateId TEXT NOT NULL, projectId TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY(userId, requestId)
      );
      CREATE INDEX IF NOT EXISTS pulse_receipt_order
        ON pulse_mutation_receipts(userId, createdAt DESC);
    `);
    this.ensurePulseReceiptProjectColumn();
  }

  /** Keep receipt cleanup scoped to the project even on an already-v9 file. */
  private addEngineeringCanvasSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS engineering_canvases(
        id TEXT PRIMARY KEY, projectId TEXT NOT NULL, ownerId TEXT NOT NULL,
        title TEXT NOT NULL, revision INTEGER NOT NULL, createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL, deletedAt INTEGER, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS canvas_project ON engineering_canvases(projectId, updatedAt);
      CREATE TABLE IF NOT EXISTS engineering_canvas_revisions(
        canvasId TEXT NOT NULL, revision INTEGER NOT NULL, changedAt INTEGER NOT NULL,
        changedBy TEXT NOT NULL, summary TEXT NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY(canvasId, revision)
      );
      CREATE TABLE IF NOT EXISTS engineering_canvas_reads(
        canvasId TEXT NOT NULL, userId TEXT NOT NULL, revision INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL, PRIMARY KEY(canvasId,userId)
      );
      CREATE TABLE IF NOT EXISTS engineering_canvas_requests(
        ownerId TEXT NOT NULL, requestId TEXT NOT NULL, canvasId TEXT NOT NULL,
        action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', payload TEXT NOT NULL DEFAULT '{}', createdAt INTEGER NOT NULL,
        PRIMARY KEY(ownerId, requestId)
      );
    `);
    this.addColumn("engineering_canvas_requests", "target", "TEXT NOT NULL DEFAULT ''");
    this.addColumn("engineering_canvas_requests", "payload", "TEXT NOT NULL DEFAULT '{}'");
  }

  private addChannelPinsSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channel_pins(
        channelId TEXT NOT NULL, messageId TEXT NOT NULL,
        pinnedAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        pinnedById TEXT NOT NULL, removedAt INTEGER,
        PRIMARY KEY(channelId,messageId)
      );
      CREATE INDEX IF NOT EXISTS channel_pin_order
        ON channel_pins(channelId,removedAt,pinnedAt DESC,messageId DESC);
      CREATE TABLE IF NOT EXISTS channel_pin_receipts(
        userId TEXT NOT NULL, requestId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('pinMessage','unpinMessage')),
        payloadHash TEXT NOT NULL, channelId TEXT NOT NULL, messageId TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        PRIMARY KEY(userId,requestId)
      );
      CREATE INDEX IF NOT EXISTS channel_pin_receipt_order
        ON channel_pin_receipts(userId,createdAt DESC);
    `);
  }

  private addMessageReceiptsSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS message_send_ledger(
        authorId TEXT NOT NULL, clientMessageId TEXT NOT NULL,
        channelId TEXT NOT NULL, messageId TEXT NOT NULL,
        payloadHash TEXT NOT NULL, createdAt INTEGER NOT NULL,
        PRIMARY KEY(authorId, clientMessageId)
      );
      CREATE INDEX IF NOT EXISTS message_send_ledger_order
        ON message_send_ledger(authorId, createdAt DESC);
      CREATE TABLE IF NOT EXISTS message_receipts(
        messageId TEXT NOT NULL, channelId TEXT NOT NULL, recipientId TEXT NOT NULL,
        deliveredAt INTEGER, readAt INTEGER, cursorTs INTEGER, cursorId TEXT,
        PRIMARY KEY(messageId, recipientId)
      );
      CREATE INDEX IF NOT EXISTS message_receipt_message ON message_receipts(messageId);
    `);
    this.addColumn("reads", "lastReadId", "TEXT");
  }

  private ensurePulseReceiptProjectColumn(): void {
    this.addColumn("pulse_mutation_receipts", "projectId", "TEXT NOT NULL DEFAULT ''");
    this.db.exec(
      "UPDATE pulse_mutation_receipts SET projectId="
      + "(SELECT projectId FROM pulse_updates WHERE id=pulse_mutation_receipts.updateId) "
      + "WHERE projectId='' AND EXISTS "
      + "(SELECT 1 FROM pulse_updates WHERE id=pulse_mutation_receipts.updateId)",
    );
    // A receipt was written in the same transaction as its update, so an old
    // row with neither binding nor update is only a torn/forgotten orphan.
    // Retire it instead of trying to write NULL into the new NOT NULL column.
    this.db.exec(
      "DELETE FROM pulse_mutation_receipts WHERE projectId='' AND NOT EXISTS "
      + "(SELECT 1 FROM pulse_updates WHERE id=pulse_mutation_receipts.updateId)",
    );
    this.db.exec("CREATE INDEX IF NOT EXISTS pulse_receipt_project ON pulse_mutation_receipts(projectId, updateId)");
  }

  /**
   * v4 → v5. Re-key `channel_members` on (channelId, memberId, joinedAt).
   *
   * SQLite cannot change a primary key in place, so the table is rebuilt beside
   * itself and renamed. Every existing row is copied verbatim — no role, no
   * `joinedAt` and no `invitedBy` is touched — so this migration cannot lose a
   * fact; it only makes room for the NEXT rejoin to be a new row instead of an
   * overwrite. It runs inside `step`, so an interruption leaves the old table
   * exactly as it was.
   */
  private rekeyChannelMembers(): void {
    this.db.exec(`
      CREATE TABLE channel_members_v5(
        channelId TEXT NOT NULL, memberId TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        joinedAt INTEGER NOT NULL, invitedBy TEXT,
        removedAt INTEGER, removedBy TEXT,
        PRIMARY KEY (channelId, memberId, joinedAt)
      );
      INSERT INTO channel_members_v5(channelId,memberId,role,joinedAt,invitedBy,removedAt,removedBy)
        SELECT channelId,memberId,role,joinedAt,invitedBy,removedAt,removedBy FROM channel_members;
      DROP TABLE channel_members;
      ALTER TABLE channel_members_v5 RENAME TO channel_members;
      CREATE INDEX IF NOT EXISTS cm_member ON channel_members(memberId);
    `);
  }

  /**
   * v2 → v3. Give every id in every channel's stored `memberIds` a real
   * membership row.
   *
   * LOSSLESS BY CONSTRUCTION, in three ways:
   * - it only ever INSERTs, and only `OR IGNORE`, so a row that already exists
   *   is left exactly as it is — running it twice cannot change a `joinedAt`,
   *   a role, or an `invitedBy`;
   * - it never writes to the `channels` table, so the old `memberIds` list is
   *   still there afterwards to check the new rows against (and still readable
   *   by the previous build, which is why it is not deleted this release);
   * - `joinedAt` is the channel's own `createdAt`, the only honest answer
   *   available — nobody recorded when these people arrived, and stamping
   *   "now" would be inventing a fact.
   *
   * ROLES. Nothing in a v2 database records who made a room. Guessing wrongly
   * in the generous direction would hand out powers nobody was given, so the
   * rule is deliberately narrow and stated out loud: the person who runs this
   * Cloud9 becomes `owner` of a room if they are in it; everyone else — and
   * every member of a room he is not in — is a plain `member`, and the owner
   * can hand roles out afterwards. A direct conversation has no owner at all:
   * there is nothing to administer.
   */
  private backfillChannelMembers(): void {
    // WHO THE OWNER IS, ASKED RATHER THAN GUESSED. This used to read the first
    // row of `tokens` by rowid, which is the owner only if he happened to sign
    // in first. On a file where somebody else's token was written first, every
    // non-direct room was handed to a guest and the owner was demoted to a
    // plain member of his own Cloud9. The hub knows its own owner token, so it
    // hands it in and we look the answer up. No token, no owner: everyone stays
    // a plain member, which is the narrow, honest answer.
    const ownerId = this.ownerToken === undefined ? undefined : (this.db.prepare(
      "SELECT userId FROM tokens WHERE token=?",
    ).get(this.ownerToken) as { userId: string } | undefined)?.userId;
    const rows = this.db.prepare("SELECT id,json FROM channels").all() as
      { id: string; json: string }[];
    const insert = this.db.prepare(
      "INSERT OR IGNORE INTO channel_members(channelId,memberId,role,joinedAt,invitedBy) VALUES(?,?,?,?,NULL)",
    );
    for (const r of rows) {
      const ch = this.safeParse<Channel>(r.json, "a conversation", r.id);
      if (!ch) continue;
      const joinedAt = ch.createdAt ?? Date.now();
      for (const memberId of ch.memberIds ?? []) {
        const role: ChannelRole =
          ch.kind !== "dm" && ownerId !== undefined && memberId === ownerId ? "owner" : "member";
        insert.run(r.id, memberId, role, joinedAt);
      }
    }
  }

  private addColumn(table: string, column: string, type: string): void {
    const has = (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .some(c => c.name === column);
    if (!has) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  /** Which shape this database is in. 0 means "written before we numbered them". */
  schemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key='schemaVersion'")
      .get() as { value: string } | undefined;
    return row ? Number(row.value) || 0 : 0;
  }

  private setSchemaVersion(v: number): void {
    this.setMeta("schemaVersion", String(v));
  }

  /**
   * ONE REMEMBERED FACT ABOUT THIS DATABASE ITSELF — read.
   *
   * `schemaVersion` was the only thing `meta` was ever asked for, through a
   * hand-written SELECT. A one-time job needs the same table to answer "have I
   * already run on this file?", and the honest way to give it one is to open
   * the existing row store rather than add a second place where the database
   * remembers things about itself. Absent means "never written", which is what
   * makes a marker a marker.
   */
  meta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  /** The same fact, written. Last write wins — one row per key, by primary key. */
  setMeta(key: string, value: string): void {
    this.db.prepare(
      "INSERT INTO meta(key,value) VALUES(?,?) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(key, value);
  }

  private chainExistingActivity(): void {
    const rows = this.db.prepare("SELECT id,json FROM activity WHERE seq IS NULL ORDER BY ts ASC, id ASC")
      .all() as { id: string; json: string }[];
    let seq = (this.db.prepare("SELECT MAX(seq) m FROM activity").get() as { m: number | null }).m ?? 0;
    let prevHash = seq > 0 ? this.lastActivityHash() : "";
    for (const r of rows) {
      // A line nobody can read cannot be chained, and refusing to open the
      // database over it would lose every OTHER line too. It is left unnumbered
      // and reported — `verifyActivity` will show the gap, which is exactly the
      // outcome an unreadable audit line deserves.
      const rec = this.safeParse<ActivityRecord>(r.json, "an activity line", r.id);
      if (!rec) continue;
      seq += 1;
      const full: ActivityRecord = { ...rec, seq, prevHash, hash: "" };
      full.hash = activityHash(full);
      this.db.prepare("UPDATE activity SET json=?, seq=?, hash=?, prevHash=? WHERE id=?")
        .run(JSON.stringify(full), seq, full.hash, prevHash, r.id);
      prevHash = full.hash;
    }
  }

  private lastActivityHash(): string {
    const row = this.db.prepare("SELECT hash FROM activity ORDER BY seq DESC LIMIT 1")
      .get() as { hash: string | null } | undefined;
    return row?.hash ?? "";
  }

  // ---- users & auth ----
  ensureOwner(name: string, token: string): User {
    const existing = this.userByToken(token);
    if (existing) return existing;
    const user: User = { id: newId("u"), name };
    this.db.prepare("INSERT INTO users(id,name) VALUES(?,?)").run(user.id, user.name);
    this.db.prepare("INSERT INTO tokens(token,userId) VALUES(?,?)").run(token, user.id);
    return user;
  }

  userByToken(token: string): User | undefined {
    const row = this.db
      .prepare("SELECT u.id,u.name,u.invitedBy FROM tokens t JOIN users u ON u.id=t.userId WHERE t.token=?")
      .get(token) as { id: string; name: string; invitedBy: string | null } | undefined;
    return row ? { id: row.id, name: row.name, invitedBy: row.invitedBy ?? undefined } : undefined;
  }

  /** Mint an invite code. Secret-grade randomness — this code opens the door. */
  createInvite(createdBy: ID): string {
    const code = secureId("inv");
    this.db.prepare("INSERT INTO invites(code,createdBy) VALUES(?,?)").run(code, createdBy);
    return code;
  }

  /** Retire a code so it can never be redeemed again. */
  revokeInvite(code: string): void {
    this.db.prepare("UPDATE invites SET revoked=1 WHERE code=?").run(code);
  }

  invite(code: string): InviteRow | undefined {
    const row = this.db
      .prepare("SELECT code,createdBy,usedBy,usedAt,revoked FROM invites WHERE code=?")
      .get(code) as RawInvite | undefined;
    return row ? toInvite(row) : undefined;
  }

  /**
   * Redeem an invite — exactly ONCE, ever.
   *
   * WHAT THIS USED TO DO, AND WHY IT WAS DANGEROUS (security review, P0 #1):
   * when the invite row had no `usedBy` yet, the redeemer was looked up BY THE
   * DISPLAY NAME they typed. A guest who typed the owner's name was handed the
   * owner's account, plus a durable token for it — every owner-only power, from
   * one text box. A display name is something anyone can type; it is never
   * proof of who you are.
   *
   * The law now: identity is never derived from a name. An invite is a
   * single-use ticket, tied to the row's own `usedBy`, and a spent or revoked
   * one is dead — it cannot mint another token for anybody. Someone who has
   * signed in already comes back with the durable token their client kept; if
   * they lost it, the owner issues a new invite. That is a deliberate trade: a
   * code that could be redeemed twice is a password that can never be changed.
   */
  redeemInvite(code: string, name: string): { user: User; token: string } | undefined {
    const row = this.invite(code);
    if (!row) return undefined;
    if (row.revoked || row.usedBy) return undefined;

    const user: User = { id: newId("u"), name, invitedBy: row.createdBy };
    const token = secureToken();
    this.db.prepare("INSERT INTO users(id,name,invitedBy) VALUES(?,?,?)").run(user.id, user.name, row.createdBy);
    this.db.prepare("INSERT INTO tokens(token,userId) VALUES(?,?)").run(token, user.id);
    // spend the ticket in the same breath, on the row's OWN id
    this.db.prepare("UPDATE invites SET usedBy=?, usedAt=? WHERE code=?")
      .run(user.id, Date.now(), code);
    return { user, token };
  }

  // ---- join tokens (docs/plans/join-hub-handoff.md) --------------------------
  // The `JoinHubStore` interface `joinhub.ts` needs, implemented as thin mirrors
  // of the invite methods above. `joinhub.ts` owns the arithmetic (expired?
  // spent? revoked?); this is only storage.

  insertJoinToken(row: { code: string; createdBy: ID; createdAt: number; expiresAt: number }): void {
    this.db.prepare(
      "INSERT INTO join_tokens(code,createdBy,createdAt,expiresAt) VALUES(?,?,?,?)",
    ).run(row.code, row.createdBy, row.createdAt, row.expiresAt);
  }

  joinToken(code: string): JoinTokenRow | undefined {
    const row = this.db.prepare(
      "SELECT code,createdBy,createdAt,expiresAt,usedBy,usedAt,revoked FROM join_tokens WHERE code=?",
    ).get(code) as RawJoinToken | undefined;
    return row ? toJoinToken(row) : undefined;
  }

  spendJoinToken(code: string, usedBy: ID, usedAt: number): void {
    this.db.prepare("UPDATE join_tokens SET usedBy=?, usedAt=? WHERE code=?").run(usedBy, usedAt, code);
  }

  revokeJoinToken(code: string): void {
    this.db.prepare("UPDATE join_tokens SET revoked=1 WHERE code=?").run(code);
  }

  /**
   * Admit a friend who redeemed a join token: a fresh account plus its durable
   * token, exactly as `redeemInvite` mints them (P0 #1 — the display name is a
   * label, the id is minted here and never derived from anything the caller
   * carried). The join token is spent by the caller through `redeemJoinToken`,
   * on the id this returns.
   */
  admitJoinedUser(name: string, invitedBy: ID): { user: User; token: string } {
    const user: User = { id: newId("u"), name, invitedBy };
    const token = secureToken();
    this.db.prepare("INSERT INTO users(id,name,invitedBy) VALUES(?,?,?)").run(user.id, user.name, invitedBy);
    this.db.prepare("INSERT INTO tokens(token,userId) VALUES(?,?)").run(token, user.id);
    return { user, token };
  }

  user(id: ID): User | undefined {
    const row = this.db.prepare("SELECT id,name,invitedBy FROM users WHERE id=?").get(id) as
      | { id: string; name: string; invitedBy: string | null } | undefined;
    return row ? { id: row.id, name: row.name, invitedBy: row.invitedBy ?? undefined } : undefined;
  }

  // NOTE: there is deliberately no `userByName`. A display name is typed by
  // whoever is at the keyboard, so it can identify a person on screen but it
  // must never identify an ACCOUNT. Looking a user up by name for any
  // authentication purpose is the bug that made P0 #1 possible; the function
  // that did it has been removed rather than left lying around to be reused.

  /**
   * Take a person out of this Cloud9: their sign-ins, their agents, and their
   * place in every channel. Their past messages stay, so old conversations
   * still read correctly.
   *
   * Removing someone REVOKES, it never recycles (P1 #3). The old code cleared
   * `usedBy` on their invite, which handed the code back to whoever still had
   * it — so "remove this person" quietly meant "let them straight back in".
   * Every code they used, and every code they created and had not yet given
   * away, is retired here.
   */
  removeUser(id: ID): void {
    // Parked bytes belong only to this account. Gather their relay-owned names
    // before the account rows are deleted, then remove bytes after the metadata
    // transaction commits so a failed transaction never loses the cleanup path.
    const parked = this.db.prepare(
      "SELECT id,json FROM attachments WHERE uploadedBy=? AND messageId IS NULL",
    ).all(id) as { id: ID; json: string }[];
    const owned = this.projectsOf(id);
    this.tx(() => {
      for (const project of owned) this.deleteHuddleRows(project.id);
      this.db.prepare("DELETE FROM huddle_members WHERE userId=?").run(id);
      this.db.prepare("DELETE FROM huddle_reads WHERE userId=?").run(id);
      this.db.prepare("DELETE FROM huddle_ops WHERE userId=?").run(id);
    });
    for (const agent of this.agents()) {
      if (agent.ownerId === id) this.deleteAgent(agent.id);
    }
    // Taken out of each room EXPLICITLY, one row at a time. It used to be done
    // by handing `saveChannel` a shortened member list, which reconciled the
    // whole room against a snapshot and could evict bystanders with them.
    for (const channel of this.channels()) {
      if (!channel.memberIds.includes(id)) continue;
      this.removeChannelMember(channel.id, id);
    }
    // Saved notes/reminder dates are private account data. Account removal
    // purges them and their retry receipts together; no tombstone survives a
    // deliberate account deletion.
    // Social posts are NOT hard-deleted here — `tombstoneSocialForRemovedUser`
    // leaves moderation-safe placeholders so remaining members' open feeds stay
    // honest. Membership, reactions-by-actor, reads, and ops still leave with
    // the account.
    this.tx(() => {
      this.db.prepare("DELETE FROM saved_mutation_receipts WHERE userId=?").run(id);
      this.db.prepare("DELETE FROM saved_messages WHERE userId=?").run(id);
      // Send retries are account-scoped and must not survive account removal;
      // retaining them would let a future account accidentally replay an old
      // author's canonical id and would keep delivery metadata past access.
      this.db.prepare("DELETE FROM message_send_ledger WHERE authorId=?").run(id);
      this.clearMessageReceiptsForAuthor(id);
      this.db.prepare("DELETE FROM channel_pin_receipts WHERE userId=?").run(id);
      this.db.prepare("DELETE FROM hook_requests WHERE ownerId=?").run(id);
      this.db.prepare("DELETE FROM hook_audit WHERE ownerId=?").run(id);
      this.db.prepare("DELETE FROM hooks WHERE ownerId=?").run(id);
      this.db.prepare("DELETE FROM social_ops WHERE userId=?").run(id);
      this.db.prepare("DELETE FROM social_reads WHERE userId=?").run(id);
      this.db.prepare("DELETE FROM social_members WHERE userId=?").run(id);
      this.db.prepare("DELETE FROM social_reactions WHERE actorId=?").run(id);
      this.db.prepare("DELETE FROM chat_drafts WHERE userId=?").run(id);
      this.db.prepare("DELETE FROM draft_mutation_receipts WHERE userId=?").run(id);
      this.db.prepare("DELETE FROM attachments WHERE uploadedBy=? AND messageId IS NULL").run(id);
    });
    for (const row of parked) {
      const attachment = this.safeParse<Attachment>(row.json, "a parked file", row.id);
      if (attachment?.storedAs) this.removeAttachmentBytes(attachment.storedAs);
    }
    this.db.prepare("DELETE FROM tokens WHERE userId=?").run(id);
    this.db.prepare("DELETE FROM pulse_mutation_receipts WHERE userId=?").run(id);
    this.db.prepare("DELETE FROM pulse_reads WHERE userId=?").run(id);
    this.db.prepare("UPDATE invites SET revoked=1 WHERE usedBy=? OR createdBy=?").run(id, id);
    this.db.prepare("DELETE FROM users WHERE id=?").run(id);
  }

  /**
   * Account removal is a moderation event for every project feed that person
   * (or their agents) wrote in. Live posts become chronological tombstones —
   * words cleared, links and reactions gone — so open Team feed windows can
   * receive a real `socialUpdated` instead of silently showing gone authors.
   *
   * Call this BEFORE `removeUser` so the posts still resolve while we write.
   */
  tombstoneSocialForRemovedUser(userId: ID, at = Date.now()): SocialPost[] {
    const rows = this.db.prepare(
      "SELECT json FROM social_posts WHERE (ownerId=? OR authorId=?) AND deletedAt IS NULL",
    ).all(userId, userId) as { json: string }[];
    if (rows.length === 0) return [];
    const tombstones: SocialPost[] = [];
    this.tx(() => {
      for (const row of rows) {
        const post = JSON.parse(row.json) as SocialPost;
        const tombstone: SocialPost = {
          ...post, text: "", deletedAt: at, links: undefined, reactions: undefined,
        };
        this.saveSocialPost(tombstone);
        this.db.prepare("DELETE FROM social_reactions WHERE postId=?").run(post.id);
        const saved = this.socialPost(post.id);
        if (saved) tombstones.push(saved);
      }
    });
    return tombstones;
  }

  users(): User[] {
    return (this.db.prepare("SELECT id,name,invitedBy FROM users").all() as
      { id: string; name: string; invitedBy: string | null }[])
      .map(r => ({ id: r.id, name: r.name, invitedBy: r.invitedBy ?? undefined }));
  }

  // ---- agents ----
  saveAgent(agent: AgentDef): void {
    this.db.prepare("INSERT OR REPLACE INTO agents(id,json) VALUES(?,?)").run(agent.id, JSON.stringify(agent));
  }
  deleteAgent(id: ID): void {
    for (const session of this.huddles()) {
      if (session.state !== "active" || !session.participants.some(p => p.id === id && p.present)) continue;
      const at = Date.now();
      this.huddleLeave(session.id, id, at);
      this.saveHuddle({ ...session, participants: session.participants.map(p => p.id === id && p.present ? { ...p, present: false, leftAt: at } : p) });
    }
    this.db.prepare("DELETE FROM agents WHERE id=?").run(id);
    // An agent's runs go with it. Leaving them behind would be a pile of
    // records about an agent nobody can see any more, and the `ownerId` on
    // them would be the only thing still deciding who may read them.
    this.forgetRuns(id);
  }
  agents(): AgentDef[] {
    return (this.db.prepare("SELECT json FROM agents").all() as { json: string }[])
      .map(r => JSON.parse(r.json) as AgentDef);
  }

  // ---- channels ----
  /**
   * Write a channel's own SETTINGS. It never touches who is in the room.
   *
   * IT USED TO, and that was three bugs in one function. Every save reconciled
   * the whole membership list against whatever `memberIds` the caller happened
   * to be holding — so setting a topic evicted anyone who had joined since that
   * copy was read, a save from a stale screen resurrected someone an admin had
   * just removed, and neither was anything the person had asked for.
   *
   * THE CLASS RULE, and it is why this function is now this short: a frame that
   * does not change membership must not touch membership at all. Joining,
   * inviting, removing and re-adding each have their own call below, each says
   * exactly who and exactly why, and none of them goes through here.
   *
   * `memberIds` is still written into the JSON so an older build reading this
   * file still finds the members where it expects them — but it is never read
   * back as the truth. `hydrateChannel` replaces it from the rows on every read.
   */
  saveChannel(channel: Channel): void {
    this.db.prepare("INSERT OR REPLACE INTO channels(id,json) VALUES(?,?)")
      .run(channel.id, JSON.stringify(channel));
  }

  /**
   * Create a room and seed the people it starts with, in one write.
   *
   * The ONLY place a membership list turns into rows wholesale, and it applies
   * to a room that did not exist a moment ago — so there is nothing stale to
   * reconcile against and nobody to evict. Anything after this moment is an
   * explicit add or an explicit remove.
   */
  createChannel(channel: Channel, by?: ID): void {
    this.tx(() => {
      this.saveChannel(channel);
      const at = channel.createdAt ?? Date.now();
      for (const id of new Set(channel.memberIds ?? [])) {
        this.addChannelMember(channel.id, id, { role: "member", invitedBy: by, at });
      }
    });
  }

  /** Everyone in this room right now — the derived `memberIds`. */
  liveMemberIds(channelId: ID): ID[] {
    return (this.db.prepare(
      "SELECT memberId FROM channel_members WHERE channelId=? AND removedAt IS NULL ORDER BY joinedAt ASC, memberId ASC",
    ).all(channelId) as { memberId: string }[]).map(r => r.memberId);
  }

  /**
   * Every membership row for one room, including people who have left.
   * With `at`, it answers the question an id array never could: who was in
   * this room at that moment.
   */
  channelMembers(channelId: ID, opts: { at?: number; includeRemoved?: boolean } = {}): ChannelMember[] {
    const rows = this.db.prepare(
      "SELECT channelId,memberId,role,joinedAt,invitedBy,removedAt,removedBy FROM channel_members " +
      "WHERE channelId=? ORDER BY joinedAt ASC, memberId ASC",
    ).all(channelId) as unknown as RawMember[];
    let members = rows.map(toMember);
    if (opts.at !== undefined) {
      const at = opts.at;
      return members.filter(m => m.joinedAt <= at && (m.removedAt === undefined || m.removedAt > at));
    }
    if (!opts.includeRemoved) members = members.filter(m => m.removedAt === undefined);
    return members;
  }

  /** What this person may change in this room — undefined when they aren't in it. */
  memberRole(channelId: ID, memberId: ID): ChannelRole | undefined {
    const row = this.db.prepare(
      "SELECT role FROM channel_members WHERE channelId=? AND memberId=? AND removedAt IS NULL",
    ).get(channelId, memberId) as { role: string } | undefined;
    return row ? (row.role as ChannelRole) : undefined;
  }

  /**
   * Put someone in a room.
   *
   * COMING BACK IS A NEW ROW, not an edit of the old one. The row recording the
   * first visit — when they arrived, who let them in, when and by whom they
   * were removed — is left exactly as it was written, and a second row records
   * this arrival. That is why the key carries `joinedAt`: "who was in this room
   * when this was said" now has a true answer for the time in between, and
   * nothing about the first visit is destroyed to record the second.
   *
   * THE ROLE IS ALWAYS SAID OUT LOUD, and it defaults to `member`. It used to
   * be inherited from the row being revived, which meant re-adding someone who
   * had been an admin quietly made them an admin again — a plain member could
   * hand out adminship by removing nobody and simply adding a name. Being let
   * back into a room is not the same act as being given power in it; the second
   * one is `setMemberRole` and it needs the owner.
   *
   * Already in the room: nothing happens, except an explicit `role` being
   * applied. Adding someone twice is not a way to change their standing.
   */
  addChannelMember(
    channelId: ID, memberId: ID,
    opts: { role?: ChannelRole; invitedBy?: ID; at?: number } = {},
  ): void {
    const live = this.db.prepare(
      "SELECT role FROM channel_members WHERE channelId=? AND memberId=? AND removedAt IS NULL",
    ).get(channelId, memberId) as { role: string } | undefined;
    if (live) {
      if (opts.role && opts.role !== live.role) this.setMemberRole(channelId, memberId, opts.role);
      return;
    }
    // `joinedAt` is half the key, so two spells that land in the same
    // millisecond would collide. Step forward until the moment is free —
    // a millisecond of drift on a rejoin, never a lost row.
    let at = opts.at ?? Date.now();
    const taken = this.db.prepare(
      "SELECT 1 FROM channel_members WHERE channelId=? AND memberId=? AND joinedAt=?",
    );
    while (taken.get(channelId, memberId, at)) at += 1;
    this.db.prepare(
      "INSERT INTO channel_members(channelId,memberId,role,joinedAt,invitedBy) VALUES(?,?,?,?,?)",
    ).run(channelId, memberId, opts.role ?? "member", at, opts.invitedBy ?? null);
    this.mirrorMemberIds(channelId);
  }

  /**
   * Copy the live member list back into the channel JSON.
   *
   * The list in the JSON is a COMPATIBILITY MIRROR kept for one release, so a
   * build that has not caught up still finds members where it expects them. It
   * is never read as the truth — `hydrateChannel` rebuilds it from the rows on
   * every read — so it only has to be refreshed whenever the rows move, and it
   * is refreshed HERE, in the two functions that move them, rather than by
   * every caller remembering to.
   */
  private mirrorMemberIds(channelId: ID): void {
    const row = this.db.prepare("SELECT json FROM channels WHERE id=?").get(channelId) as
      { json: string } | undefined;
    if (!row) return;
    const ch = this.safeParse<Channel>(row.json, "a conversation", channelId);
    if (!ch) return;
    ch.memberIds = this.liveMemberIds(channelId);
    this.db.prepare("UPDATE channels SET json=? WHERE id=?").run(JSON.stringify(ch), channelId);
  }

  /**
   * Take someone out — softly, so the room record still knows they were here.
   * Any explicit restricted-file selections in this room end with that spell;
   * rejoining later must not silently resurrect old file access, for the same
   * reason an old admin role is not inherited across a rejoin.
   */
  removeChannelMember(channelId: ID, memberId: ID, by?: ID): void {
    this.tx(() => {
      this.db.prepare(
        "UPDATE channel_members SET removedAt=?, removedBy=? " +
        "WHERE channelId=? AND memberId=? AND removedAt IS NULL",
      ).run(Date.now(), by ?? null, channelId, memberId);
      this.db.prepare(
        "DELETE FROM artifact_access_users WHERE userId=? " +
        "AND artifactId IN (SELECT id FROM artifacts WHERE channelId=?)",
      ).run(memberId, channelId);
      this.db.prepare("DELETE FROM message_receipts WHERE channelId=? AND recipientId=?")
        .run(channelId, memberId);
      this.mirrorMemberIds(channelId);
    });
  }

  setMemberRole(channelId: ID, memberId: ID, role: ChannelRole): void {
    this.db.prepare(
      "UPDATE channel_members SET role=? WHERE channelId=? AND memberId=? AND removedAt IS NULL",
    ).run(role, channelId, memberId);
  }

  /**
   * A channel as everyone else sees it: whatever was stored, with `memberIds`
   * REPLACED by the live membership rows. One place, so the rows and the wire
   * can never disagree about who is in a room.
   */
  private hydrateChannel(json: string): Channel {
    const ch = JSON.parse(json) as Channel;
    ch.memberIds = this.liveMemberIds(ch.id);
    return ch;
  }

  channels(): Channel[] {
    return (this.db.prepare("SELECT json FROM channels").all() as { json: string }[])
      .map(r => this.hydrateChannel(r.json));
  }
  /**
   * The one-to-one conversation between exactly these two ids, if there is one
   * (his 15). Membership is compared as a SET, so "me and Neha" and "Neha and
   * me" are the same conversation and a second one never gets created.
   */
  dmBetween(a: ID, b: ID): Channel | undefined {
    const wanted = new Set([a, b]);
    return this.channels().find(c =>
      c.kind === "dm"
      && c.memberIds.length === wanted.size
      && c.memberIds.every(m => wanted.has(m)));
  }

  channel(id: ID): Channel | undefined {
    const row = this.db.prepare("SELECT json FROM channels WHERE id=?").get(id) as { json: string } | undefined;
    return row ? this.hydrateChannel(row.json) : undefined;
  }

  // ---- messages ----
  /**
   * Write a message and keep the search index with it.
   *
   * The hydrated fields (`reactions`, `replyCount`) are stripped before the row
   * is written: they are answers built from OTHER tables at read time, and a
   * stale copy of them baked into the row is a lie waiting to be served.
   */
  saveMessage(m: Message): void {
    const row = stripHydrated(m);
    this.db.prepare("INSERT OR REPLACE INTO messages(id,channelId,ts,json) VALUES(?,?,?,?)")
      .run(row.id, row.channelId, row.ts, JSON.stringify(row));
    this.indexMessage(row);
  }

  /** Fingerprint one client's durable send intent, excluding relay-owned ids and timestamps. */
  messageSendHash(channelId: ID, text: string, replyTo: ID | undefined,
    attachmentIds: readonly ID[]): string {
    return createHash("sha256").update(JSON.stringify([
      "send", channelId, text, replyTo ?? null, [...new Set(attachmentIds)],
    ])).digest("hex");
  }

  /** Check a retry before attachment validation can reject its already-claimed ids. */
  sentMessageStatus(userId: ID, clientMessageId: ID, payloadHash: string):
    { status: "replay"; message: Message } | { status: "conflict" } | undefined {
    const prior = this.messageLedger(userId, clientMessageId);
    if (!prior) return undefined;
    if (prior.payloadHash !== payloadHash) return { status: "conflict" };
    const message = this.message(prior.messageId);
    return message ? { status: "replay", message } : { status: "conflict" };
  }

  private sendDraftMatches(draft: ChatDraft | undefined, message: Message,
    threadId: ID | undefined, expectedPayloadHash: string): boolean {
    // The durable key is the authenticated owner + room + canonical thread,
    // but scope alone is not enough: another window may have saved newer text
    // or attachments while this send was in flight. Compare the immutable send
    // intent before deleting so an accepted message cannot erase that newer
    // draft. Relay-derived attachment state/expiry is deliberately excluded.
    if (!draft || draft.channelId !== message.channelId
      || (draft.threadId ?? "") !== (threadId ?? "")) return false;
    const draftHash = this.messageSendHash(
      draft.channelId, draft.text, draft.replyTo,
      draft.attachments.map(attachment => attachment.id),
    );
    return draftHash === expectedPayloadHash;
  }

  /**
   * Persist an accepted human message, claim its attachments, and remove only
   * the draft whose intent still matches — all in one SQLite transaction.
   * A clientMessageId receipt makes a lost acknowledgement safe to replay.
   */
  saveMessageAndRemoveDraft(message: Message, userId: ID, threadId?: ID,
    attachmentIds: readonly ID[] = [], clientMessageId?: ID,
    payloadHash?: string): SavedSendResult {
    let released: ID[] = [];
    const uniqueAttachmentIds = [...new Set(attachmentIds)];
    const result = this.tx(() => {
      const hash = payloadHash ?? this.messagePayloadHash({
        channelId: message.channelId, text: message.text,
        replyTo: message.replyTo, attachmentIds: uniqueAttachmentIds,
      });
      const draftIntentHash = this.messageSendHash(
        message.channelId, message.text, message.replyTo, uniqueAttachmentIds,
      );
      const prior = clientMessageId ? this.messageLedger(userId, clientMessageId) : undefined;
      if (prior) {
        if (prior.payloadHash !== hash || prior.channelId !== message.channelId) {
          throw new Error("that send id was already used for a different message");
        }
        const canonical = this.message(prior.messageId);
        if (canonical) return { message: canonical, replayed: true, draftRemoved: false } satisfies SavedSendResult;
        this.db.prepare("DELETE FROM message_send_ledger WHERE authorId=? AND clientMessageId=?")
          .run(userId, prior.clientMessageId);
      }
      const draft = this.rawDraft(userId, message.channelId, threadId);
      const claimed: Attachment[] = [];
      for (const id of uniqueAttachmentIds) {
        const row = this.attachment(id);
        if (!row || row.attachment.uploadedBy !== userId || row.channelId !== message.channelId || row.messageId) {
          throw new Error("that file is no longer available to send");
        }
        const updated = this.db.prepare("UPDATE attachments SET messageId=? WHERE id=? AND messageId IS NULL")
          .run(message.id, id);
        if (updated.changes !== 1) throw new Error("that file is no longer available to send");
        claimed.push(row.attachment);
      }
      const stored = claimed.length ? { ...message, attachments: claimed } : message;
      this.saveMessage(stored);
      const draftRemoved = this.sendDraftMatches(draft, stored, threadId, draftIntentHash);
      if (draftRemoved) {
        released = draft!.attachments.map(a => a.id);
        this.db.prepare("DELETE FROM chat_drafts WHERE userId=? AND channelId=? AND threadId=?")
          .run(userId, message.channelId, threadId ?? "");
      }
      const now = Date.now();
      if (clientMessageId) {
        this.db.prepare(
          "INSERT INTO message_send_ledger(authorId,clientMessageId,channelId,messageId,payloadHash,createdAt) VALUES(?,?,?,?,?,?)",
        ).run(userId, clientMessageId, message.channelId, stored.id, hash, now);
        this.pruneMessageLedgers(now);
      }
      return { message: stored, replayed: false, draftRemoved } satisfies SavedSendResult;
    });
    if (!result.replayed) this.cleanupUnreferencedParkedAttachments(userId, released);
    return result;
  }

  message(id: ID): Message | undefined {
    const row = this.db.prepare("SELECT json FROM messages WHERE id=?").get(id) as
      { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Message) : undefined;
  }

  /** Canonical payload identity for the author-scoped send ledger. */
  messagePayloadHash(input: {
    channelId: ID; text: string; replyTo?: ID; attachmentIds?: ID[];
  }): string {
    return createHash("sha256").update(JSON.stringify([
      input.channelId, input.text, input.replyTo ?? null, input.attachmentIds ?? [],
    ])).digest("hex");
  }

  private messageLedger(authorId: ID, clientMessageId: ID): MessageSendLedgerRow | undefined {
    return this.db.prepare(
      "SELECT authorId,clientMessageId,channelId,messageId,payloadHash,createdAt "
      + "FROM message_send_ledger WHERE authorId=? AND clientMessageId=?",
    ).get(authorId, clientMessageId) as MessageSendLedgerRow | undefined;
  }

  /**
   * Atomically persist one human message and its retry ledger row. A replay of
   * the same author/client id and canonical payload returns the original row;
   * reusing that id for another payload is a hard refusal.
   */
  saveHumanMessage(
    message: Message,
    clientMessageId: ID,
    payloadHash: string,
  ): { message: Message; replayed: boolean } {
    return this.tx(() => {
      const prior = this.messageLedger(message.authorId, clientMessageId);
      if (prior) {
        if (prior.payloadHash !== payloadHash || prior.channelId !== message.channelId) {
          throw new Error("that client message id was already used for different words");
        }
        const existing = this.message(prior.messageId);
        if (existing) return { message: existing, replayed: true };
        // A torn legacy row is not allowed to make a retry disappear. Retire it
        // and write the canonical message below in this same transaction.
        this.db.prepare("DELETE FROM message_send_ledger WHERE authorId=? AND clientMessageId=?")
          .run(message.authorId, clientMessageId);
      }
      const row = stripHydrated({ ...message, clientMessageId });
      this.db.prepare("INSERT INTO messages(id,channelId,ts,json) VALUES(?,?,?,?)")
        .run(row.id, row.channelId, row.ts, JSON.stringify(row));
      this.indexMessage(row);
      const now = Date.now();
      this.db.prepare(
        "INSERT INTO message_send_ledger(authorId,clientMessageId,channelId,messageId,payloadHash,createdAt) VALUES(?,?,?,?,?,?)",
      ).run(message.authorId, clientMessageId, message.channelId, message.id, payloadHash, now);
      this.pruneMessageLedgers(now);
      return { message: row, replayed: false };
    });
  }

  private pruneMessageLedgers(now: number): void {
    this.db.prepare("DELETE FROM message_send_ledger WHERE createdAt < ?")
      .run(now - MESSAGE_SEND_RETENTION_MS);
    // Prune each author independently so one noisy account cannot evict
    // another account's retry history.
    const authors = this.db.prepare("SELECT DISTINCT authorId FROM message_send_ledger").all() as { authorId: ID }[];
    for (const { authorId } of authors) {
      this.db.prepare(
        "DELETE FROM message_send_ledger WHERE authorId=? AND clientMessageId NOT IN "
        + "(SELECT clientMessageId FROM message_send_ledger WHERE authorId=? "
        + "ORDER BY createdAt DESC,clientMessageId DESC LIMIT ?)",
      ).run(authorId, authorId, MESSAGE_SEND_MAX_ROWS);
    }
  }

  messageSendStatus(authorId: ID, clientMessageId?: ID, messageId?: ID): MessageSendLedgerRow | undefined {
    if (clientMessageId) {
      const row = this.messageLedger(authorId, clientMessageId);
      if (row && row.createdAt < Date.now() - MESSAGE_SEND_RETENTION_MS) {
        this.db.prepare("DELETE FROM message_send_ledger WHERE authorId=? AND clientMessageId=?")
          .run(authorId, clientMessageId);
        return undefined;
      }
      return row;
    }
    if (!messageId) return undefined;
    return this.db.prepare(
      "SELECT authorId,clientMessageId,channelId,messageId,payloadHash,createdAt "
      + "FROM message_send_ledger WHERE authorId=? AND messageId=? AND createdAt>=? "
      + "ORDER BY createdAt DESC LIMIT 1",
    ).get(authorId, messageId, Date.now() - MESSAGE_SEND_RETENTION_MS) as MessageSendLedgerRow | undefined;
  }

  messageReceipt(messageId: ID, recipientId: ID): MessageReceiptRow | undefined {
    const row = this.db.prepare(
      "SELECT messageId,channelId,recipientId,deliveredAt,readAt,cursorTs,cursorId "
      + "FROM message_receipts WHERE messageId=? AND recipientId=?",
    ).get(messageId, recipientId) as {
      messageId: ID; channelId: ID; recipientId: ID; deliveredAt: number | null;
      readAt: number | null; cursorTs: number | null; cursorId: ID | null;
    } | undefined;
    if (!row) return undefined;
    return {
      messageId: row.messageId, channelId: row.channelId, recipientId: row.recipientId,
      ...(row.deliveredAt !== null ? { deliveredAt: row.deliveredAt } : {}),
      ...(row.readAt !== null ? { readAt: row.readAt } : {}),
      ...(row.cursorTs !== null ? { cursorTs: row.cursorTs } : {}),
      ...(row.cursorId ? { cursorId: row.cursorId } : {}),
    };
  }

  messageReceipts(messageId: ID): MessageReceiptRow[] {
    const rows = this.db.prepare(
      "SELECT messageId,channelId,recipientId,deliveredAt,readAt,cursorTs,cursorId "
      + "FROM message_receipts WHERE messageId=?",
    ).all(messageId) as {
      messageId: ID; channelId: ID; recipientId: ID; deliveredAt: number | null;
      readAt: number | null; cursorTs: number | null; cursorId: ID | null;
    }[];
    return rows.map(row => ({
      messageId: row.messageId, channelId: row.channelId, recipientId: row.recipientId,
      ...(row.deliveredAt !== null ? { deliveredAt: row.deliveredAt } : {}),
      ...(row.readAt !== null ? { readAt: row.readAt } : {}),
      ...(row.cursorTs !== null ? { cursorTs: row.cursorTs } : {}),
      ...(row.cursorId ? { cursorId: row.cursorId } : {}),
    }));
  }

  /** Monotonic receipt transition. Returns false for duplicate/out-of-order frames. */
  recordMessageReceipt(
    recipientId: ID, message: Message, status: Exclude<MessageDeliveryStage, "accepted" | "unknown" | "failed">,
    cursor?: { ts?: number; id?: ID },
  ): boolean {
    return this.tx(() => {
      const prior = this.messageReceipt(message.id, recipientId);
      if (status === "delivered" && prior?.deliveredAt !== undefined) return false;
      if (status === "read" && prior?.readAt !== undefined) return false;
      const now = Date.now();
      if (status === "delivered") {
        this.db.prepare(
          "INSERT INTO message_receipts(messageId,channelId,recipientId,deliveredAt) VALUES(?,?,?,?) "
          + "ON CONFLICT(messageId,recipientId) DO UPDATE SET deliveredAt=COALESCE(message_receipts.deliveredAt,excluded.deliveredAt)",
        ).run(message.id, message.channelId, recipientId, now);
        this.db.prepare("DELETE FROM message_receipts WHERE COALESCE(readAt,deliveredAt) < ?")
          .run(now - MESSAGE_SEND_RETENTION_MS);
        return true;
      }
      // A read frame implies delivery. Cursor fields are facts from the relay's
      // authorized message, never a client identity claim.
      this.db.prepare(
        "INSERT INTO message_receipts(messageId,channelId,recipientId,deliveredAt,readAt,cursorTs,cursorId) VALUES(?,?,?,?,?,?,?) "
        + "ON CONFLICT(messageId,recipientId) DO UPDATE SET "
        + "deliveredAt=COALESCE(message_receipts.deliveredAt,excluded.deliveredAt), "
        + "readAt=COALESCE(message_receipts.readAt,excluded.readAt), "
        + "cursorTs=COALESCE(message_receipts.cursorTs,excluded.cursorTs), "
        + "cursorId=COALESCE(message_receipts.cursorId,excluded.cursorId)",
      ).run(message.id, message.channelId, recipientId, now, now, cursor?.ts ?? message.ts, cursor?.id ?? message.id);
      this.db.prepare("DELETE FROM message_receipts WHERE COALESCE(readAt,deliveredAt) < ?")
        .run(now - MESSAGE_SEND_RETENTION_MS);
      return true;
    });
  }

  clearMessageReceipts(messageId: ID): void {
    this.db.prepare("DELETE FROM message_receipts WHERE messageId=?").run(messageId);
  }

  /** Remove all receipt metadata for messages authored by a deleted account. */
  clearMessageReceiptsForAuthor(authorId: ID): void {
    this.db.prepare(
      "DELETE FROM message_receipts WHERE messageId IN "
      + "(SELECT id FROM messages WHERE json_extract(json,'$.authorId')=?)",
    ).run(authorId);
  }

  private addSavedMessagesSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS saved_messages(
        userId TEXT NOT NULL, messageId TEXT NOT NULL, channelId TEXT NOT NULL,
        savedAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        note TEXT, remindAt INTEGER, removedAt INTEGER,
        PRIMARY KEY (userId, messageId)
      );
      CREATE INDEX IF NOT EXISTS saved_user_order
        ON saved_messages(userId, removedAt, savedAt DESC, messageId DESC);
      CREATE TABLE IF NOT EXISTS saved_mutation_receipts(
        userId TEXT NOT NULL, requestId TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('saveMessage','unsaveMessage')),
        payloadHash TEXT NOT NULL, createdAt INTEGER NOT NULL,
        PRIMARY KEY (userId, requestId)
      );
      CREATE INDEX IF NOT EXISTS saved_receipt_order
        ON saved_mutation_receipts(userId, createdAt DESC);
    `);
  }

  private savedMutationHash(kind: SavedMutationKind, messageId: ID, channelId?: ID, note?: string, remindAt?: number): string {
    // A message id has one canonical source channel; excluding the channel
    // lets a legitimate retry still settle after membership is revoked and
    // the source can no longer be read to recover its channel id.
    void channelId;
    return createHash("sha256").update(JSON.stringify([kind, messageId, note ?? null, remindAt ?? null])).digest("hex");
  }

  private savedReceipt(userId: ID, requestId: ID): SavedMutationReceipt | undefined {
    const row = this.db.prepare(
      "SELECT userId,requestId,kind,payloadHash,createdAt FROM saved_mutation_receipts WHERE userId=? AND requestId=?",
    ).get(userId, requestId) as SavedMutationReceipt | undefined;
    if (row && row.createdAt < Date.now() - SAVED_RECEIPT_RETENTION_MS) {
      this.db.prepare("DELETE FROM saved_mutation_receipts WHERE userId=? AND requestId=?").run(userId, requestId);
      return undefined;
    }
    return row;
  }

  /** Check a retry before the caller re-authorises a source message. */
  savedMutationStatus(
    userId: ID, requestId: ID, kind: SavedMutationKind, messageId: ID,
    channelId?: ID, note?: string, remindAt?: number,
  ): "replay" | "conflict" | undefined {
    const prior = this.savedReceipt(userId, requestId);
    if (!prior) return undefined;
    const hash = this.savedMutationHash(kind, messageId, channelId, note, remindAt);
    const metadataOmittedReplay = kind === "saveMessage" && note === undefined && remindAt === undefined;
    return prior.kind === kind && (prior.payloadHash === hash || metadataOmittedReplay) ? "replay" : "conflict";
  }

  private saveReceipt(userId: ID, requestId: ID, kind: SavedMutationKind, payloadHash: string, now: number): void {
    this.db.prepare(
      "INSERT INTO saved_mutation_receipts(userId,requestId,kind,payloadHash,createdAt) VALUES(?,?,?,?,?)",
    ).run(userId, requestId, kind, payloadHash, now);
    // Keep the retry ledger finite without touching durable saved rows. A
    // 30-day window and 512 receipts per account covers reconnects and human
    // retries while making the retention boundary explicit.
    this.db.prepare("DELETE FROM saved_mutation_receipts WHERE createdAt < ?").run(now - SAVED_RECEIPT_RETENTION_MS);
    this.db.prepare(
      "DELETE FROM saved_mutation_receipts WHERE userId=? AND requestId NOT IN "
      + "(SELECT requestId FROM saved_mutation_receipts WHERE userId=? ORDER BY createdAt DESC,requestId DESC LIMIT 512)",
    ).run(userId, userId);
  }

  /** Save or update one message for one account. Repeating it is idempotent. */
  saveSavedMessage(userId: ID, messageId: ID, channelId: ID, note?: string, remindAt?: number, requestId?: ID): SavedMessageRow | undefined {
    return this.tx(() => {
      const hash = this.savedMutationHash("saveMessage", messageId, channelId, note, remindAt);
      const prior = requestId ? this.savedReceipt(userId, requestId) : undefined;
      if (prior) {
        const metadataOmittedReplay = note === undefined && remindAt === undefined;
        if (prior.kind !== "saveMessage" || (prior.payloadHash !== hash && !metadataOmittedReplay)) {
          throw new Error("that saved request id was already used for a different save");
        }
        return this.savedMessage(userId, messageId);
      }
      const now = Date.now();
      this.db.prepare(
        "INSERT INTO saved_messages(userId,messageId,channelId,savedAt,updatedAt,note,remindAt,removedAt) "
        + "VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(userId,messageId) DO UPDATE SET "
        + "channelId=excluded.channelId,savedAt=excluded.savedAt,updatedAt=excluded.updatedAt,"
        + "note=excluded.note,remindAt=excluded.remindAt,removedAt=NULL",
      ).run(userId, messageId, channelId, now, now, note ?? null, remindAt ?? null);
      if (requestId) this.saveReceipt(userId, requestId, "saveMessage", hash, now);
      return this.savedMessage(userId, messageId);
    });
  }

  /** Soft-remove one save; repeated unsaves do not create another row. */
  unsaveMessage(userId: ID, messageId: ID, requestId?: ID): void {
    this.tx(() => {
      const hash = this.savedMutationHash("unsaveMessage", messageId);
      const prior = requestId ? this.savedReceipt(userId, requestId) : undefined;
      if (prior) {
        if (prior.kind !== "unsaveMessage" || prior.payloadHash !== hash) {
          throw new Error("that saved request id was already used for a different removal");
        }
        return;
      }
      const now = Date.now();
      this.db.prepare(
        "UPDATE saved_messages SET removedAt=?,updatedAt=? WHERE userId=? AND messageId=? AND removedAt IS NULL",
      ).run(now, now, userId, messageId);
      if (requestId) this.saveReceipt(userId, requestId, "unsaveMessage", hash, now);
    });
  }

  savedMessage(userId: ID, messageId: ID): SavedMessageRow | undefined {
    const row = this.db.prepare(
      "SELECT userId,messageId,channelId,savedAt,note,remindAt FROM saved_messages "
      + "WHERE userId=? AND messageId=? AND removedAt IS NULL",
    ).get(userId, messageId) as RawSavedMessageRow | undefined;
    return row ? toSavedMessageRow(row) : undefined;
  }

  savedMessages(userId: ID, limit = 500): SavedMessageRow[] {
    return this.savedMessagesPage(userId, limit).entries;
  }

  savedMessagesPage(userId: ID, limit = 100, beforeSavedAt?: number, beforeMessageId?: ID): SavedMessagePage {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));
    const rows = (beforeSavedAt !== undefined && beforeMessageId !== undefined
      ? this.db.prepare(
        "SELECT userId,messageId,channelId,savedAt,note,remindAt FROM saved_messages "
        + "WHERE userId=? AND removedAt IS NULL AND (savedAt < ? OR (savedAt=? AND messageId<?)) "
        + "ORDER BY savedAt DESC,messageId DESC LIMIT ?",
      ).all(userId, beforeSavedAt, beforeSavedAt, beforeMessageId, safeLimit + 1)
      : this.db.prepare(
        "SELECT userId,messageId,channelId,savedAt,note,remindAt FROM saved_messages "
        + "WHERE userId=? AND removedAt IS NULL ORDER BY savedAt DESC,messageId DESC LIMIT ?",
      ).all(userId, safeLimit + 1)) as unknown as RawSavedMessageRow[];
    const hasMore = rows.length > safeLimit;
    const visible = rows.slice(0, safeLimit).map(toSavedMessageRow);
    const last = visible[visible.length - 1];
    return {
      entries: visible, hasMore,
      ...(hasMore && last ? { nextSavedAt: last.savedAt, nextMessageId: last.messageId } : {}),
    };
  }

  /** Monotonic-enough snapshot marker for same-socket uncorrelated pushes. */
  savedMessagesRevision(userId: ID): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(updatedAt),0) AS revision FROM saved_messages WHERE userId=?",
    ).get(userId) as { revision: number };
    return row.revision;
  }

  // ---- shared channel pins -------------------------------------------------
  private channelPinMutationHash(kind: ChannelPinMutationKind, channelId: ID, messageId: ID): string {
    return createHash("sha256").update(JSON.stringify([kind, channelId, messageId])).digest("hex");
  }

  private channelPinReceipt(userId: ID, requestId: ID): ChannelPinMutationReceipt | undefined {
    const row = this.db.prepare(
      "SELECT userId,requestId,kind,payloadHash,channelId,messageId,createdAt "
      + "FROM channel_pin_receipts WHERE userId=? AND requestId=?",
    ).get(userId, requestId) as ChannelPinMutationReceipt | undefined;
    if (row && row.createdAt < Date.now() - CHANNEL_PIN_RECEIPT_RETENTION_MS) {
      this.db.prepare("DELETE FROM channel_pin_receipts WHERE userId=? AND requestId=?").run(userId, requestId);
      return undefined;
    }
    return row;
  }

  channelPinMutationStatus(
    userId: ID, requestId: ID, kind: ChannelPinMutationKind, channelId: ID, messageId: ID,
  ): "replay" | "conflict" | undefined {
    const prior = this.channelPinReceipt(userId, requestId);
    if (!prior) return undefined;
    const hash = this.channelPinMutationHash(kind, channelId, messageId);
    return prior.kind === kind && prior.channelId === channelId && prior.messageId === messageId
      && prior.payloadHash === hash ? "replay" : "conflict";
  }

  private saveChannelPinReceipt(
    userId: ID, requestId: ID, kind: ChannelPinMutationKind,
    channelId: ID, messageId: ID, payloadHash: string, now: number,
  ): void {
    this.db.prepare(
      "INSERT INTO channel_pin_receipts(userId,requestId,kind,payloadHash,channelId,messageId,createdAt) "
      + "VALUES(?,?,?,?,?,?,?)",
    ).run(userId, requestId, kind, payloadHash, channelId, messageId, now);
    this.db.prepare("DELETE FROM channel_pin_receipts WHERE createdAt < ?")
      .run(now - CHANNEL_PIN_RECEIPT_RETENTION_MS);
    this.db.prepare(
      "DELETE FROM channel_pin_receipts WHERE userId=? AND requestId NOT IN "
      + "(SELECT requestId FROM channel_pin_receipts WHERE userId=? ORDER BY createdAt DESC,requestId DESC LIMIT 512)",
    ).run(userId, userId);
  }

  pinChannelMessage(
    userId: ID, channelId: ID, messageId: ID, requestId?: ID,
  ): ChannelPinRow {
    return this.tx(() => {
      const hash = this.channelPinMutationHash("pinMessage", channelId, messageId);
      const prior = requestId ? this.channelPinReceipt(userId, requestId) : undefined;
      if (prior) {
        if (prior.kind !== "pinMessage" || prior.channelId !== channelId
          || prior.messageId !== messageId || prior.payloadHash !== hash) {
          throw new Error("that channel pin request id was already used for a different pin");
        }
        return this.channelPin(channelId, messageId)!;
      }
      const now = Date.now();
      const active = this.channelPin(channelId, messageId);
      if (!active) {
        const count = this.db.prepare(
          "SELECT COUNT(*) AS n FROM channel_pins WHERE channelId=? AND removedAt IS NULL",
        ).get(channelId) as { n: number };
        if (count.n >= 100) throw new Error("this conversation already has 100 pinned messages");
      }
      this.db.prepare(
        "INSERT INTO channel_pins(channelId,messageId,pinnedAt,updatedAt,pinnedById,removedAt) "
        + "VALUES(?,?,?,?,?,NULL) ON CONFLICT(channelId,messageId) DO UPDATE SET "
        + "pinnedAt=CASE WHEN channel_pins.removedAt IS NULL THEN channel_pins.pinnedAt ELSE excluded.pinnedAt END, "
        + "updatedAt=excluded.updatedAt, "
        + "pinnedById=CASE WHEN channel_pins.removedAt IS NULL THEN channel_pins.pinnedById ELSE excluded.pinnedById END, "
        + "removedAt=NULL",
      ).run(channelId, messageId, now, now, userId);
      if (requestId) this.saveChannelPinReceipt(userId, requestId, "pinMessage", channelId, messageId, hash, now);
      return this.channelPin(channelId, messageId)!;
    });
  }

  unpinChannelMessage(
    userId: ID, channelId: ID, messageId: ID, requestId?: ID,
  ): void {
    this.tx(() => {
      const hash = this.channelPinMutationHash("unpinMessage", channelId, messageId);
      const prior = requestId ? this.channelPinReceipt(userId, requestId) : undefined;
      if (prior) {
        if (prior.kind !== "unpinMessage" || prior.channelId !== channelId
          || prior.messageId !== messageId || prior.payloadHash !== hash) {
          throw new Error("that channel pin request id was already used for a different removal");
        }
        return;
      }
      const now = Date.now();
      this.db.prepare(
        "UPDATE channel_pins SET removedAt=?,updatedAt=? WHERE channelId=? AND messageId=? AND removedAt IS NULL",
      ).run(now, now, channelId, messageId);
      if (requestId) this.saveChannelPinReceipt(userId, requestId, "unpinMessage", channelId, messageId, hash, now);
    });
  }

  channelPin(channelId: ID, messageId: ID): ChannelPinRow | undefined {
    const row = this.db.prepare(
      "SELECT channelId,messageId,pinnedAt,pinnedById FROM channel_pins "
      + "WHERE channelId=? AND messageId=? AND removedAt IS NULL",
    ).get(channelId, messageId) as RawChannelPinRow | undefined;
    return row ? toChannelPinRow(row) : undefined;
  }

  channelPinsPage(channelId: ID, limit = 100, beforePinnedAt?: number, beforeMessageId?: ID): ChannelPinPage {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));
    const rows = (beforePinnedAt !== undefined && beforeMessageId !== undefined
      ? this.db.prepare(
        "SELECT channelId,messageId,pinnedAt,pinnedById FROM channel_pins "
        + "WHERE channelId=? AND removedAt IS NULL AND (pinnedAt < ? OR (pinnedAt=? AND messageId<?)) "
        + "ORDER BY pinnedAt DESC,messageId DESC LIMIT ?",
      ).all(channelId, beforePinnedAt, beforePinnedAt, beforeMessageId, safeLimit + 1)
      : this.db.prepare(
        "SELECT channelId,messageId,pinnedAt,pinnedById FROM channel_pins "
        + "WHERE channelId=? AND removedAt IS NULL ORDER BY pinnedAt DESC,messageId DESC LIMIT ?",
      ).all(channelId, safeLimit + 1)) as unknown as RawChannelPinRow[];
    const hasMore = rows.length > safeLimit;
    const visible = rows.slice(0, safeLimit).map(toChannelPinRow);
    const last = visible.at(-1);
    return { entries: visible, hasMore,
      ...(hasMore && last ? { nextPinnedAt: last.pinnedAt, nextMessageId: last.messageId } : {}) };
  }

  channelPinsRevision(channelId: ID): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(updatedAt),0) AS revision FROM channel_pins WHERE channelId=?",
    ).get(channelId) as { revision: number };
    return row.revision;
  }

  forgetChannelPins(channelId: ID): void {
    this.db.prepare("DELETE FROM channel_pin_receipts WHERE channelId=?").run(channelId);
    this.db.prepare("DELETE FROM channel_pins WHERE channelId=?").run(channelId);
  }
  /**
   * The recent backlog for a GIVEN LIST of channels.
   *
   * The channel list is now required (P1 #7). It used to walk every channel in
   * the database, so the opening `welcome` frame handed each person the
   * contents of conversations they were not in. A function that returns
   * everything is one forgotten argument away from being a leak, so there is no
   * "all channels" mode left to forget.
   */
  recentMessages(channels: Channel[], perChannel: number = MESSAGE_LIMITS.defaultPage): Message[] {
    const out: Message[] = [];
    for (const ch of channels) {
      out.push(...this.history(ch.id, {}, perChannel).items);
    }
    return out;
  }

  /**
   * One page of a conversation, oldest first, walking backwards from a cursor.
   *
   * ORDERING. Two messages can share a millisecond — the engine posts a burst
   * of agent replies and they land in the same tick. Ordering by `ts` alone
   * therefore has ties, and a tie at a page boundary means a message is served
   * twice or skipped entirely. So the sort key is the PAIR `(ts, id)`, and the
   * cursor carries both. That is the whole reason `beforeId` exists.
   *
   * "MORE?" is answered by asking for one row more than the page and seeing if
   * it turns up — never by whether the page came back full.
   */
  history(
    channelId: ID,
    cursor: { before?: number; beforeId?: ID },
    limit: number = MESSAGE_LIMITS.defaultPage,
  ): Page<Message> {
    const size = Math.max(1, Math.min(limit, MESSAGE_LIMITS.page));
    const before = cursor.before;
    let rows: { json: string }[];
    if (before === undefined) {
      rows = this.db
        .prepare("SELECT json FROM messages WHERE channelId=? ORDER BY ts DESC, id DESC LIMIT ?")
        .all(channelId, size + 1) as { json: string }[];
    } else {
      // `beforeId` absent means "everything strictly older than this moment" —
      // an honest first page for a caller that only has a timestamp.
      const beforeId = cursor.beforeId ?? AFTER_EVERY_ID;
      rows = this.db
        .prepare(
          "SELECT json FROM messages WHERE channelId=? AND (ts < ? OR (ts = ? AND id < ?)) " +
          "ORDER BY ts DESC, id DESC LIMIT ?",
        )
        .all(channelId, before, before, beforeId, size + 1) as { json: string }[];
    }
    const hasMore = rows.length > size;
    const page = (hasMore ? rows.slice(0, size) : rows)
      .map(r => JSON.parse(r.json) as Message);
    const oldest = page[page.length - 1];
    return {
      items: page.reverse(), // oldest first, the order they are read in
      hasMore,
      nextBefore: hasMore && oldest ? oldest.ts : undefined,
      nextBeforeId: hasMore && oldest ? oldest.id : undefined,
    };
  }

  /**
   * Search words across a GIVEN LIST of channels.
   *
   * Same law as `recentMessages`: the channel list is required, never derived
   * here. A search function that could decide its own scope is one forgotten
   * argument away from reading the whole house.
   */
  search(
    channels: Channel[],
    query: string,
    opts: { authorId?: ID; limit?: number } = {},
  ): Page<{ message: Message; snippet: string }> {
    const size = Math.max(1, Math.min(opts.limit ?? MESSAGE_LIMITS.searchPage, MESSAGE_LIMITS.page));
    const ids = channels.map(c => c.id);
    if (ids.length === 0) return { items: [], hasMore: false };
    const slots = ids.map(() => "?").join(",");
    const terms = searchTerms(query);
    if (terms.length === 0) return { items: [], hasMore: false };

    // EVERY CONDITION IS IN THE QUERY, because `LIMIT` is applied by the
    // database and anything filtered afterwards is filtered out of a page that
    // has already been cut. `from:Priya` used to be applied in JavaScript to
    // the 51 rows SQL had already chosen, so on any conversation with more than
    // one page of matches it threw away all 51 and reported no hits and no more
    // pages — a filter the app advertises in its own placeholder that could
    // only ever work on a small room. Same for the tombstone rule: a page of
    // deleted messages used to come back empty rather than skipping them.
    const authorId = opts.authorId;
    const authorSql = authorId ? " AND json_extract(m.json,'$.authorId') = ?" : "";
    const authorArgs = authorId ? [authorId] : [];
    const aliveSql = " AND json_extract(m.json,'$.deletedAt') IS NULL";

    let hits: { json: string; snippet: string }[];
    if (this.searchIndexed) {
      const match = ftsMatch(terms);
      hits = this.db.prepare(
        `SELECT m.json AS json, snippet(search_docs, 0, '«', '»', '…', 12) AS snippet
         FROM search_docs f JOIN messages m ON m.id = f.docId
         WHERE search_docs MATCH ? AND f.kind='message' AND f.channelId IN (${slots})${aliveSql}${authorSql}
         ORDER BY m.ts DESC LIMIT ?`,
      ).all(match, ...ids, ...authorArgs, size + 1) as { json: string; snippet: string }[];
    } else {
      // No FTS5 on this SQLite: a plain contains-scan over the SAME text the
      // FTS5 index holds (`message.text`), never over the raw JSON row. A LIKE
      // on `m.json` matched every message when you searched for a field name
      // like "text" or "attachment" — the plumbing, not the words people wrote.
      const textSql = terms.map(() =>
        "instr(lower(coalesce(json_extract(m.json,'$.text'),'')), lower(?)) > 0"
      ).join(" AND ");
      hits = (this.db.prepare(
        `SELECT m.json AS json FROM messages m WHERE m.channelId IN (${slots}) AND ${textSql}
         ${aliveSql}${authorSql}
         ORDER BY m.ts DESC LIMIT ?`,
      ).all(...ids, ...terms, ...authorArgs, size + 1) as { json: string }[])
        .map(r => ({ json: r.json, snippet: "" }));
    }

    let items = hits.map(h => ({
      message: JSON.parse(h.json) as Message,
      snippet: h.snippet,
    }));
    const hasMore = items.length > size;
    if (hasMore) items = items.slice(0, size);
    for (const x of items) {
      if (!x.snippet) x.snippet = plainSnippet(x.message.text, terms);
    }
    return { items, hasMore };
  }

  /**
   * SEARCH EVERYTHING THIS PERSON MAY ALREADY READ.
   *
   * Two gates, both in SQL, both before `LIMIT`, and this is the whole security
   * of the feature:
   *
   *   1. THE ROOM. `channels` is passed in, exactly as `search` and
   *      `recentMessages` demand it, and is never derived here. A search that
   *      could choose its own scope is one forgotten argument from reading the
   *      whole house.
   *   2. THE FILE. A restricted file is invisible unless this person is on its
   *      selected list or currently manages the room — the SAME rule, in the
   *      same shape, as `visibleArtifactRows` behind the Files screen. Being in
   *      the room is not enough, and neither is the snippet being short: an
   *      excluded row never reaches the result set, so it cannot leak a name, a
   *      word of content, or even the fact that the file exists.
   *
   * FILTERING AFTER `LIMIT` WOULD BE A BUG, not a smaller version of this. The
   * database would choose fifty rows, JavaScript would drop the forbidden ones,
   * and a person with one visible file among fifty restricted ones would be
   * told there were no results — while every one of those fifty had already
   * been read out of the index.
   */
  searchEverywhere(
    userId: ID,
    channels: Channel[],
    query: string,
    opts: { kind?: SearchKind; limit?: number } = {},
  ): Page<EverywhereHit> {
    const size = Math.max(1, Math.min(opts.limit ?? MESSAGE_LIMITS.searchPage, MESSAGE_LIMITS.page));
    const ids = channels.map(c => c.id);
    if (ids.length === 0) return { items: [], hasMore: false };
    const terms = searchTerms(query);
    if (terms.length === 0) return { items: [], hasMore: false };
    const slots = ids.map(() => "?").join(",");

    // The file gate, written once and used by both the indexed and the
    // fallback query so the two can never drift into different permissions.
    // `artifactId` names the column each query keys it on.
    const fileGate = (artifactId: string, channelId: string) => `(
      NOT EXISTS (
        SELECT 1 FROM artifact_access aa
        WHERE aa.artifactId=${artifactId} AND aa.kind='restricted'
      )
      OR EXISTS (
        SELECT 1 FROM artifact_access_users aau
        JOIN channel_members cm
          ON cm.channelId=${channelId} AND cm.memberId=aau.userId AND cm.removedAt IS NULL
        JOIN users u ON u.id=aau.userId
        WHERE aau.artifactId=${artifactId} AND aau.userId=?
      )
      OR EXISTS (
        SELECT 1 FROM channel_members cm JOIN users u ON u.id=cm.memberId
        WHERE cm.channelId=${channelId} AND cm.memberId=? AND cm.removedAt IS NULL
          AND cm.role IN ('owner','admin')
      )
    )`;

    type Row = {
      kind: string; docId: string; parentId: string; channelId: string;
      ts: number; snippet: string;
    };
    let rows: Row[];

    if (this.searchIndexed) {
      // A reply is a message with a parent, so the two wire kinds are one index
      // kind narrowed by that parent — decided here, never sent by a client.
      const kindSql = opts.kind === "message" ? " AND f.kind='message' AND f.parentId=''"
        : opts.kind === "reply" ? " AND f.kind='message' AND f.parentId<>''"
        : opts.kind === "file" ? " AND f.kind='file'"
        : opts.kind === "fileVersion" ? " AND f.kind='fileVersion'"
        : "";
      rows = this.db.prepare(
        `SELECT f.kind AS kind, f.docId AS docId, f.parentId AS parentId,
                f.channelId AS channelId, CAST(f.ts AS INTEGER) AS ts,
                snippet(search_docs, 0, '«', '»', '…', 12) AS snippet
         FROM search_docs f
         WHERE search_docs MATCH ? AND f.channelId IN (${slots})${kindSql}
           AND (
             (f.kind='message' AND EXISTS (
                SELECT 1 FROM messages m
                WHERE m.id=f.docId AND json_extract(m.json,'$.deletedAt') IS NULL))
             OR (f.kind='file' AND EXISTS (SELECT 1 FROM artifacts a WHERE a.id=f.docId)
                 AND ${fileGate("f.parentId", "f.channelId")})
             OR (f.kind='fileVersion'
                 AND EXISTS (SELECT 1 FROM artifact_versions av WHERE av.id=f.docId)
                 AND ${fileGate("f.parentId", "f.channelId")})
           )
         ORDER BY CAST(f.ts AS INTEGER) DESC, f.docId DESC
         LIMIT ?`,
      ).all(
        ftsMatch(terms), ...ids, userId, userId, userId, userId, size + 1,
      ) as unknown as Row[];
    } else {
      // NO FTS5 ON THIS SQLITE. Messages and file names are still scannable,
      // because their words are in columns; the words INSIDE a file version are
      // not, because the only place they were ever collected is the index this
      // machine cannot build. Saying so plainly beats a second index scheme
      // maintained for a machine nobody has.
      const like = (expr: string) =>
        terms.map(() => `instr(lower(${expr}), lower(?)) > 0`).join(" AND ");
      const wantMessages = opts.kind === undefined || opts.kind === "message" || opts.kind === "reply";
      const wantFiles = opts.kind === undefined || opts.kind === "file";
      const parts: string[] = [];
      const args: unknown[] = [];
      if (wantMessages) {
        const parentSql = opts.kind === "message" ? " AND coalesce(json_extract(m.json,'$.replyTo'),'')=''"
          : opts.kind === "reply" ? " AND coalesce(json_extract(m.json,'$.replyTo'),'')<>''"
          : "";
        parts.push(
          `SELECT 'message' AS kind, m.id AS docId,
                  coalesce(json_extract(m.json,'$.replyTo'),'') AS parentId,
                  m.channelId AS channelId, m.ts AS ts, '' AS snippet
           FROM messages m
           WHERE m.channelId IN (${slots})
             AND ${like("coalesce(json_extract(m.json,'$.text'),'')")}
             AND json_extract(m.json,'$.deletedAt') IS NULL${parentSql}`,
        );
        args.push(...ids, ...terms);
      }
      if (wantFiles) {
        parts.push(
          `SELECT 'file' AS kind, a.id AS docId, a.id AS parentId,
                  a.channelId AS channelId, a.updatedAt AS ts, '' AS snippet
           FROM artifacts a
           WHERE a.channelId IN (${slots}) AND ${like("a.name")}
             AND EXISTS (SELECT 1 FROM artifact_versions av WHERE av.artifactId=a.id)
             AND ${fileGate("a.id", "a.channelId")}`,
        );
        args.push(...ids, ...terms, userId, userId);
      }
      if (parts.length === 0) return { items: [], hasMore: false };
      rows = this.db.prepare(
        `${parts.join(" UNION ALL ")} ORDER BY ts DESC, docId DESC LIMIT ?`,
      ).all(...args as never[], size + 1) as unknown as Row[];
    }

    const hasMore = rows.length > size;
    const page = hasMore ? rows.slice(0, size) : rows;
    const names = new Map(channels.map(c => [c.id, c.name]));
    const items: EverywhereHit[] = [];
    for (const r of page) {
      const hit = this.everywhereHit(r, names.get(r.channelId), terms);
      if (hit) items.push(hit);
    }
    return { items, hasMore };
  }

  /**
   * Turn one index row into the row a person reads — or into nothing.
   *
   * Every field is read from stored state HERE, after the permission gate, so
   * nothing a client sent decides what a result says. A row whose subject has
   * vanished between the query and this line is dropped rather than drawn half
   * empty; it is one result, and a hit that opens nothing is worse than a hit
   * that was never shown.
   */
  private everywhereHit(
    row: { kind: string; docId: string; parentId: string; channelId: string; ts: number; snippet: string },
    channelName: string | undefined,
    terms: string[],
  ): EverywhereHit | undefined {
    if (channelName === undefined) return undefined;
    const base = { channelId: row.channelId, channelName, when: row.ts };
    if (row.kind === "message") {
      const m = this.message(row.docId);
      if (!m || m.deletedAt) return undefined;
      return {
        ...base,
        kind: m.replyTo ? "reply" : "message",
        snippet: row.snippet || plainSnippet(m.text, terms),
        whoName: m.authorName, whoId: m.authorId, when: m.ts,
        messageId: m.id,
        ...(m.replyTo ? { threadParentId: m.replyTo } : {}),
      };
    }
    if (row.kind === "file") {
      const artifact = this.artifactRow(row.docId);
      const newest = this.artifactVersionsOf(row.docId)[0];
      if (!artifact || !newest) return undefined;
      return {
        ...base,
        kind: "file",
        snippet: row.snippet || plainSnippet(artifact.name, terms),
        whoName: newest.agentName, whoId: newest.agentId,
        when: artifact.updatedAt,
        artifactId: artifact.id, name: artifact.name,
      };
    }
    if (row.kind === "fileVersion") {
      const found = this.artifactVersion(row.docId);
      const artifact = this.artifactRow(row.parentId);
      if (!found || !artifact) return undefined;
      const version = found.version;
      return {
        ...base,
        kind: "fileVersion",
        snippet: row.snippet,
        whoName: version.agentName, whoId: version.agentId,
        when: version.producedAt,
        artifactId: artifact.id, name: artifact.name,
        versionId: version.id, versionNumber: version.version,
      };
    }
    return undefined;
  }

  /** Every reply hanging off one message, oldest first. */
  thread(parentId: ID, limit: number = MESSAGE_LIMITS.page): Message[] {
    const rows = this.db
      .prepare("SELECT json FROM messages WHERE json_extract(json,'$.replyTo')=? ORDER BY ts ASC, id ASC LIMIT ?")
      .all(parentId, Math.max(1, Math.min(limit, MESSAGE_LIMITS.page))) as { json: string }[];
    return rows.map(r => JSON.parse(r.json) as Message);
  }

  /**
   * Count one more reply against the message that started the thread.
   *
   * The count is CACHED on the root, not counted at read time, so a channel
   * list can say "12 replies · 3m ago" without walking the conversation
   * (Buzz's `thread_metadata.reply_count` — the reason theirs is cheap).
   * Returns the updated root so the caller can broadcast it.
   */
  bumpReplyCount(rootId: ID, at: number, authorId?: ID, replyId?: ID): Message | undefined {
    const root = this.message(rootId);
    if (!root) return undefined;
    root.replyCount = (root.replyCount ?? 0) + 1;
    root.lastReplyAt = at;
    if (replyId) root.lastReplyId = replyId;
    /* Who is in the thread, newest first, capped at three — the faces beside
       the count. The speaker moves to the front rather than appearing twice. */
    if (authorId) {
      root.replyFaces = [authorId, ...(root.replyFaces ?? []).filter(id => id !== authorId)]
        .slice(0, 3);
    }
    this.saveMessage(root);
    return root;
  }

  // ---- reactions ----
  /**
   * Add or remove one person's emoji on one message.
   * Returns the FULL new list of who reacted with that emoji, so the caller
   * broadcasts a fact rather than a delta anyone could apply twice.
   */
  setReaction(messageId: ID, userId: ID, emoji: string, on: boolean): ID[] {
    const now = Date.now();
    if (on) {
      // re-reacting revives the same row rather than making a second one
      this.db.prepare(
        "INSERT INTO reactions(messageId,userId,emoji,ts,removedAt) VALUES(?,?,?,?,NULL) " +
        "ON CONFLICT(messageId,userId,emoji) DO UPDATE SET removedAt=NULL, ts=excluded.ts",
      ).run(messageId, userId, emoji, now);
    } else {
      // a SOFT delete: "they reacted and then took it back" stays knowable
      this.db.prepare(
        "UPDATE reactions SET removedAt=? WHERE messageId=? AND userId=? AND emoji=? AND removedAt IS NULL",
      ).run(now, messageId, userId, emoji);
    }
    return (this.db.prepare(
      "SELECT userId FROM reactions WHERE messageId=? AND emoji=? AND removedAt IS NULL ORDER BY userId",
    ).all(messageId, emoji) as { userId: string }[]).map(r => r.userId);
  }

  /** Everyone's reactions on these messages, grouped by message then emoji. */
  reactionsFor(messageIds: ID[]): Map<ID, MessageReaction[]> {
    const out = new Map<ID, MessageReaction[]>();
    if (messageIds.length === 0) return out;
    const slots = messageIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT messageId,emoji,userId FROM reactions
       WHERE messageId IN (${slots}) AND removedAt IS NULL
       ORDER BY messageId, emoji, userId`,
    ).all(...messageIds) as { messageId: string; emoji: string; userId: string }[];
    for (const r of rows) {
      const list = out.get(r.messageId) ?? [];
      const existing = list.find(x => x.emoji === r.emoji);
      if (existing) existing.userIds.push(r.userId);
      else list.push({ emoji: r.emoji, userIds: [r.userId] });
      out.set(r.messageId, list);
    }
    return out;
  }

  /**
   * A tombstone keeps no live votes — the words are gone, so the reactions on
   * them go too. Soft, like every other un-react: the rows stay, marked.
   */
  clearReactions(messageId: ID): void {
    this.db.prepare("UPDATE reactions SET removedAt=? WHERE messageId=? AND removedAt IS NULL")
      .run(Date.now(), messageId);
  }

  // ---- attachments ----
  /**
   * Put the bytes on disk and return the file name they were stored under.
   *
   * The stored name is built HERE from an id we minted plus the already-checked
   * display name; it is never the name the client sent, and it is never joined
   * with anything a client controls. `path.basename` is the last belt on top of
   * the braces of `isSafeFileName`.
   */
  /**
   * WHOLE OR NOT AT ALL, and the answer is acted on.
   *
   * The hub writes the bytes and then writes a row saying the file is there. A
   * plain write is not one action — it empties the file and then fills it — so
   * a crash, a sleeping machine or a full disk in between leaves a row that
   * promises a whole file and a file that is half there. He opens his
   * attachment months later and gets a truncated PDF, and nothing anywhere says
   * it is damaged, because the row looks perfectly healthy.
   *
   * This is the same class as the torn run record with one difference that
   * makes it worse: a run record can be re-derived and HIS UPLOADED FILE CANNOT.
   *
   * So it throws when the bytes did not land. Returning the name after a failed
   * write is the "⏰ Scheduled!" bug in another costume: the row would be
   * written, the upload reported as done, and the file would not be there. The
   * throw becomes the hub's ordinary refusal sentence back to whoever uploaded.
   */
  writeAttachmentBytes(id: ID, safeName: string, bytes: Buffer): string {
    fs.mkdirSync(this.attachmentsDir, { recursive: true });
    const storedAs = `${id}-${path.basename(safeName)}`;
    let why = "";
    const ok = writeWholeFile(path.join(this.attachmentsDir, storedAs), bytes, m => { why = m; });
    if (!ok) {
      console.error(`[hub] could not store an attachment: ${why}`);
      throw new Error(
        "that file could not be saved on this computer — check there is free disk space " +
        "and try again");
    }
    return storedAs;
  }

  /**
   * Clear away the part-files of an upload the hub was killed in the middle of.
   *
   * Nothing swept this folder before, so every interrupted upload left bytes
   * behind for ever under a name nothing reads. Once at startup, not once per
   * upload: this folder grows to thousands of files and reading it on every
   * upload would be a cost paid for ever to tidy something that happens almost
   * never. A temporary file another live process is still filling is left alone.
   */
  sweepAttachmentLitter(): number {
    return sweepPending(this.attachmentsDir);
  }

  /** Remove the bytes behind an attachment. Missing is not an error. */
  removeAttachmentBytes(storedAs: string): void {
    try { fs.rmSync(path.join(this.attachmentsDir, path.basename(storedAs))); } catch { /* already gone */ }
  }

  /** Park a file: metadata in the database, bytes already written to disk. */
  saveAttachment(a: Attachment, channelId: ID): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO attachments(id,channelId,uploadedBy,messageId,uploadedAt,json) VALUES(?,?,?,?,?,?)",
    ).run(a.id, channelId, a.uploadedBy, null, a.uploadedAt, JSON.stringify(a));
  }

  attachment(id: ID): { attachment: Attachment; channelId: ID; messageId?: ID } | undefined {
    const row = this.db.prepare("SELECT channelId,messageId,json FROM attachments WHERE id=?")
      .get(id) as { channelId: string; messageId: string | null; json: string } | undefined;
    if (!row) return undefined;
    return {
      attachment: JSON.parse(row.json) as Attachment,
      channelId: row.channelId,
      messageId: row.messageId ?? undefined,
    };
  }

  /** Bind a parked file to the message that finally carried it. */
  claimAttachment(id: ID, messageId: ID): void {
    this.db.prepare("UPDATE attachments SET messageId=? WHERE id=?").run(messageId, id);
  }

  /** Reclaim one unclaimed parked row and its bytes after expiry/corruption. */
  removeParkedAttachment(id: ID, userId: ID): void {
    const row = this.attachment(id);
    if (!row || row.messageId || row.attachment.uploadedBy !== userId) return;
    this.removeAttachmentBytes(row.attachment.storedAs);
    this.db.prepare("DELETE FROM attachments WHERE id=? AND uploadedBy=? AND messageId IS NULL")
      .run(id, userId);
  }

  /**
   * How many bytes this person has PARKED — uploaded but not yet sent.
   *
   * A parked file belongs to nobody but its uploader and is invisible to
   * everyone else, so nothing was ever going to make it go away on its own.
   * This is the number the quota is checked against.
   */
  parkedBytes(userId: ID): number {
    return (this.db.prepare(
      "SELECT COALESCE(SUM(json_extract(json,'$.size')),0) n FROM attachments " +
      "WHERE uploadedBy=? AND messageId IS NULL",
    ).get(userId) as { n: number }).n;
  }

  /** How many files this person parked or sent since a moment — the rate check. */
  uploadsSince(userId: ID, since: number): number {
    return (this.db.prepare(
      "SELECT COUNT(*) n FROM attachments WHERE uploadedBy=? AND uploadedAt >= ?",
    ).get(userId, since) as { n: number }).n;
  }

  /**
   * Throw away parked files nobody ever sent.
   *
   * A file that was uploaded and never attached to a message is a draft that
   * was abandoned. Without this it sat on the owner's disk forever, and since
   * only the uploader could even see it, the owner had no way to find it, let
   * alone delete it. Bytes and row go together, so neither can outlive the
   * other. Returns how many were reclaimed.
   */
  sweepParkedAttachments(olderThan: number): number {
    const rows = this.db.prepare(
      "SELECT id,json FROM attachments WHERE messageId IS NULL AND uploadedAt < ?",
    ).all(olderThan) as { id: string; json: string }[];
    for (const r of rows) {
      const a = this.safeParse<Attachment>(r.json, "a parked file", r.id);
      if (a?.storedAs) this.removeAttachmentBytes(a.storedAs);
      this.db.prepare("DELETE FROM attachments WHERE id=?").run(r.id);
    }
    return rows.length;
  }

  /** Remove parked rows no longer referenced by one of this user's live drafts. */
  private cleanupUnreferencedParkedAttachments(userId: ID, ids: readonly ID[]): number {
    if (ids.length === 0) return 0;
    const live = new Set(this.chatDrafts(userId).flatMap(d => d.attachments.map(a => a.id)));
    let removed = 0;
    for (const id of new Set(ids)) {
      if (live.has(id)) continue;
      const row = this.attachment(id);
      if (!row || row.messageId || row.attachment.uploadedBy !== userId) continue;
      this.removeAttachmentBytes(row.attachment.storedAs);
      this.db.prepare("DELETE FROM attachments WHERE id=? AND uploadedBy=? AND messageId IS NULL")
        .run(id, userId);
      removed++;
    }
    return removed;
  }

  /** Forget a message's files (used by delete) and say which bytes to remove. */
  releaseAttachments(messageId: ID): Attachment[] {
    const rows = this.db.prepare("SELECT json FROM attachments WHERE messageId=?")
      .all(messageId) as { json: string }[];
    this.db.prepare("DELETE FROM attachments WHERE messageId=?").run(messageId);
    return rows.map(r => JSON.parse(r.json) as Attachment);
  }

  private addChatDraftSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_drafts(
        userId TEXT NOT NULL, channelId TEXT NOT NULL, threadId TEXT NOT NULL DEFAULT '',
        updatedAt INTEGER NOT NULL, expiresAt INTEGER NOT NULL,
        state TEXT NOT NULL, json TEXT NOT NULL,
        PRIMARY KEY(userId, channelId, threadId)
      );
      CREATE INDEX IF NOT EXISTS chat_draft_user_order
        ON chat_drafts(userId, updatedAt DESC, channelId, threadId);
      CREATE TABLE IF NOT EXISTS draft_mutation_receipts(
        userId TEXT NOT NULL, requestId TEXT NOT NULL, kind TEXT NOT NULL,
        payloadHash TEXT NOT NULL, resultJson TEXT NOT NULL, createdAt INTEGER NOT NULL,
        PRIMARY KEY(userId, requestId)
      );
      CREATE INDEX IF NOT EXISTS draft_receipt_order
        ON draft_mutation_receipts(userId, createdAt DESC);
    `);
  }

  // ---- durable composer drafts -------------------------------------------
  // Draft bytes never live here. `attachments` is an ordered metadata list,
  // and the relay re-projects each id before returning it to a client.
  private draftThread(threadId?: ID): string { return threadId ?? ""; }

  draftId(userId: ID, channelId: ID, threadId?: ID): ID {
    return `dr_${createHash("sha256").update(JSON.stringify([userId, channelId, this.draftThread(threadId)])).digest("hex").slice(0, 24)}`;
  }

  private draftMutationHash(kind: DraftMutationKind, payload: unknown): string {
    return createHash("sha256").update(JSON.stringify([kind, payload])).digest("hex");
  }

  private draftReceipt(userId: ID, requestId: ID): DraftMutationReceipt | undefined {
    const row = this.db.prepare(
      "SELECT userId,requestId,kind,payloadHash,resultJson,createdAt FROM draft_mutation_receipts WHERE userId=? AND requestId=?",
    ).get(userId, requestId) as DraftMutationReceipt | undefined;
    if (row && row.createdAt < Date.now() - DRAFT_LIMITS.receiptRetentionMs) {
      this.db.prepare("DELETE FROM draft_mutation_receipts WHERE userId=? AND requestId=?").run(userId, requestId);
      return undefined;
    }
    return row;
  }

  private saveDraftReceipt(userId: ID, requestId: ID, kind: DraftMutationKind,
    payloadHash: string, result: unknown, now: number): void {
    this.db.prepare(
      "INSERT INTO draft_mutation_receipts(userId,requestId,kind,payloadHash,resultJson,createdAt) VALUES(?,?,?,?,?,?)",
    ).run(userId, requestId, kind, payloadHash, JSON.stringify(result), now);
    this.db.prepare("DELETE FROM draft_mutation_receipts WHERE createdAt < ?")
      .run(now - DRAFT_LIMITS.receiptRetentionMs);
    this.db.prepare(
      "DELETE FROM draft_mutation_receipts WHERE userId=? AND requestId NOT IN "
      + "(SELECT requestId FROM draft_mutation_receipts WHERE userId=? ORDER BY createdAt DESC,requestId DESC LIMIT ?)",
    ).run(userId, userId, DRAFT_LIMITS.receiptPerUser);
  }

  private rawDraft(userId: ID, channelId: ID, threadId?: ID): ChatDraft | undefined {
    const row = this.db.prepare(
      "SELECT userId,channelId,threadId,updatedAt,expiresAt,state,json FROM chat_drafts WHERE userId=? AND channelId=? AND threadId=?",
    ).get(userId, channelId, this.draftThread(threadId)) as RawChatDraft | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.json) as ChatDraft;
    } catch (e) {
      this.note(`draft ${this.draftId(userId, channelId, threadId)} could not be read (${(e as Error).message}) — it was skipped`);
      return undefined;
    }
  }

  chatDraft(userId: ID, channelId: ID, threadId?: ID): ChatDraft | undefined {
    return this.rawDraft(userId, channelId, threadId);
  }

  /** Remove expired/abandoned draft rows and old mutation receipts. */
  sweepChatDrafts(now = Date.now()): number {
    const staleRows = this.db.prepare(
      "SELECT userId,json FROM chat_drafts WHERE expiresAt <= ? OR updatedAt < ?",
    ).all(now, now - DRAFT_LIMITS.retentionMs) as { userId: ID; json: string }[];
    this.db.prepare("DELETE FROM chat_drafts WHERE expiresAt <= ? OR updatedAt < ?")
      .run(now, now - DRAFT_LIMITS.retentionMs);
    this.db.prepare("DELETE FROM draft_mutation_receipts WHERE createdAt < ?")
      .run(now - DRAFT_LIMITS.receiptRetentionMs);
    const idsByUser = new Map<ID, ID[]>();
    for (const row of staleRows) {
      const draft = this.safeParse<ChatDraft>(row.json, "a durable draft", "expired");
      if (!draft) continue;
      // A mutation receipt is only useful while its durable row exists. Drop
      // receipts for swept scopes so a late retry cannot replay stale text and
      // resurrect an expired draft that the retention sweep just removed.
      const receipts = this.db.prepare(
        "SELECT requestId,kind,resultJson FROM draft_mutation_receipts WHERE userId=?",
      ).all(row.userId) as { requestId: ID; kind: DraftMutationKind; resultJson: string }[];
      for (const receipt of receipts) {
        try {
          const result = JSON.parse(receipt.resultJson) as { channelId?: ID; threadId?: ID };
          if (result.channelId === draft.channelId && (result.threadId ?? "") === (draft.threadId ?? "")) {
            this.db.prepare("DELETE FROM draft_mutation_receipts WHERE userId=? AND requestId=?")
              .run(row.userId, receipt.requestId);
          }
        } catch { /* malformed receipt is harmless and bounded by the sweep */ }
      }
      idsByUser.set(row.userId, [...(idsByUser.get(row.userId) ?? []), ...draft.attachments.map(a => a.id)]);
    }
    for (const [userId, ids] of idsByUser) this.cleanupUnreferencedParkedAttachments(userId, ids);
    return staleRows.length;
  }

  chatDrafts(userId: ID, channelId?: ID, threadId?: ID): ChatDraft[] {
    const rows = (channelId !== undefined
      ? this.db.prepare(
        "SELECT userId,channelId,threadId,updatedAt,expiresAt,state,json FROM chat_drafts WHERE userId=? AND channelId=? "
        + (threadId === undefined ? "ORDER BY updatedAt DESC,channelId,threadId" : "AND threadId=? ORDER BY updatedAt DESC"),
      ).all(...(threadId === undefined ? [userId, channelId] : [userId, channelId, this.draftThread(threadId)]))
      : this.db.prepare(
        "SELECT userId,channelId,threadId,updatedAt,expiresAt,state,json FROM chat_drafts WHERE userId=? ORDER BY updatedAt DESC,channelId,threadId",
      ).all(userId)) as unknown as RawChatDraft[];
    return rows.flatMap(row => {
      try { return [JSON.parse(row.json) as ChatDraft]; }
      catch { this.note(`draft ${this.draftId(row.userId, row.channelId, row.threadId || undefined)} could not be read — it was skipped`); return []; }
    });
  }

  /** Store one draft and record a bounded request receipt for safe retries. */
  saveChatDraft(userId: ID, draft: ChatDraft, requestId?: ID, intentHash?: string): ChatDraft {
    let released: ID[] = [];
    const next = this.tx(() => {
      const payload = {
        channelId: draft.channelId, threadId: draft.threadId ?? null, text: draft.text,
        replyTo: draft.replyTo ?? null, attachments: draft.attachments,
      };
      const hash = intentHash ?? this.draftMutationHash("draftUpdate", payload);
      const prior = requestId ? this.draftReceipt(userId, requestId) : undefined;
      if (prior) {
        if (prior.kind !== "draftUpdate" || prior.payloadHash !== hash) {
          throw new Error("that draft request id was already used for a different update");
        }
        return JSON.parse(prior.resultJson) as ChatDraft;
      }
      const existing = this.rawDraft(userId, draft.channelId, draft.threadId);
      if (!existing && (this.db.prepare("SELECT COUNT(*) n FROM chat_drafts WHERE userId=?").get(userId) as { n: number }).n >= DRAFT_LIMITS.perUser) {
        throw new Error(`you already have ${DRAFT_LIMITS.perUser} drafts — remove one before starting another`);
      }
      const now = Date.now();
      const next: ChatDraft = {
        ...draft, id: existing?.id ?? (draft.id || this.draftId(userId, draft.channelId, draft.threadId)),
        updatedAt: draft.updatedAt || now,
        expiresAt: draft.expiresAt || now,
        state: draft.state || (draft.text || draft.attachments.length ? "active" : "empty"),
        attachments: [...draft.attachments],
      };
      released = (existing?.attachments ?? []).map(a => a.id)
        .filter(id => !next.attachments.some(a => a.id === id));
      this.db.prepare(
        "INSERT INTO chat_drafts(userId,channelId,threadId,updatedAt,expiresAt,state,json) VALUES(?,?,?,?,?,?,?) "
        + "ON CONFLICT(userId,channelId,threadId) DO UPDATE SET updatedAt=excluded.updatedAt,expiresAt=excluded.expiresAt,state=excluded.state,json=excluded.json",
      ).run(userId, next.channelId, this.draftThread(next.threadId), next.updatedAt, next.expiresAt, next.state, JSON.stringify(next));
      if (requestId) this.saveDraftReceipt(userId, requestId, "draftUpdate", hash, next, now);
      return next;
    });
    this.cleanupUnreferencedParkedAttachments(userId, released);
    return next;
  }

  removeChatDraft(userId: ID, channelId: ID, threadId?: ID, requestId?: ID): void {
    let released: ID[] = [];
    this.tx(() => {
      const payload = { channelId, threadId: threadId ?? null };
      const hash = this.draftMutationHash("draftRemove", payload);
      const prior = requestId ? this.draftReceipt(userId, requestId) : undefined;
      if (prior) {
        if (prior.kind !== "draftRemove" || prior.payloadHash !== hash) {
          throw new Error("that draft request id was already used for a different removal");
        }
        return;
      }
      const now = Date.now();
      released = (this.rawDraft(userId, channelId, threadId)?.attachments ?? []).map(a => a.id);
      this.db.prepare("DELETE FROM chat_drafts WHERE userId=? AND channelId=? AND threadId=?")
        .run(userId, channelId, this.draftThread(threadId));
      if (requestId) this.saveDraftReceipt(userId, requestId, "draftRemove", hash, { channelId, threadId }, now);
    });
    this.cleanupUnreferencedParkedAttachments(userId, released);
  }

  /** Update attachment states without touching text or other thread scope. */
  reclaimChatDraftAttachments(userId: ID, draft: ChatDraft, requestId?: ID): ChatDraft {
    let released: ID[] = [];
    const next = this.tx(() => {
      const payload = { channelId: draft.channelId, threadId: draft.threadId ?? null, attachmentIds: draft.attachments.map(a => a.id) };
      const hash = this.draftMutationHash("draftReclaim", payload);
      const prior = requestId ? this.draftReceipt(userId, requestId) : undefined;
      if (prior) {
        if (prior.kind !== "draftReclaim" || prior.payloadHash !== hash) {
          throw new Error("that draft request id was already used for a different reclaim");
        }
        return JSON.parse(prior.resultJson) as ChatDraft;
      }
      const existing = this.rawDraft(userId, draft.channelId, draft.threadId);
      if (!existing) return draft;
      // Reclaim only re-projects attachment truth. It must not refresh the
      // user's draft deadline/retention clock; ordinary draftUpdate is the
      // explicit user activity that extends those fields.
      released = existing.attachments.map(a => a.id)
        .filter(id => !draft.attachments.some(a => a.id === id));
      const next = { ...existing, attachments: draft.attachments, state: draft.state };
      this.db.prepare("UPDATE chat_drafts SET state=?,json=? WHERE userId=? AND channelId=? AND threadId=?")
        .run(next.state, JSON.stringify(next), userId, next.channelId, this.draftThread(next.threadId));
      if (requestId) this.saveDraftReceipt(userId, requestId, "draftReclaim", hash, next, Date.now());
      return next;
    });
    this.cleanupUnreferencedParkedAttachments(userId, released);
    return next;
  }

  // ---- artifacts: files agents made ----
  //
  // The BYTES go through `writeWholeFile`, exactly as an attachment's do and for
  // exactly the same reason: a row that promises a whole file beside a file that
  // is half there is a file he opens next month and finds truncated, with
  // nothing anywhere saying it is damaged. A version's bytes can never be
  // re-derived — the agent's worktree is long gone — so a failed write is a
  // refusal, never a row.

  /**
   * Stage one version's bytes under a name no database row will ever reference.
   * The append transaction promotes this name to `storedAs` while holding the
   * same SQLite write lock startup cleanup takes. A second live hub therefore
   * sees either a publish-only stage (which it must ignore) or a final file plus
   * its committed row — never a final orphan that is merely between writes.
   */
  writeArtifactBytes(versionId: ID, safeName: string, bytes: Buffer): ArtifactByteStage {
    fs.mkdirSync(this.artifactsDir, { recursive: true });
    const storedAs = `${versionId}-${path.basename(safeName)}`;
    const stagedAs =
      `.publishing-v2-${process.pid}-${this.artifactStageNonce}-${secureId("stage")}-${storedAs}`;
    let why = "";
    const ok = writeWholeFile(path.join(this.artifactsDir, stagedAs), bytes, m => { why = m; });
    if (!ok) {
      console.error(`[hub] could not store an artifact: ${why}`);
      throw new Error(
        "that file could not be saved on this computer — check there is free disk space " +
        "and try again");
    }
    return { stagedAs, storedAs };
  }

  /** Remove one final version's bytes. Missing is not an error. */
  removeArtifactBytes(storedAs: string): void {
    try { fs.rmSync(path.join(this.artifactsDir, path.basename(storedAs))); } catch { /* already gone */ }
  }

  private removeArtifactStage(stagedAs: string): void {
    try { fs.rmSync(path.join(this.artifactsDir, path.basename(stagedAs))); } catch { /* already gone */ }
  }

  /**
   * One owner for stage-name meaning. Only the exact v2 shape carries a pid and
   * startup nonce; numeric names from older/unknown protocols are legacy and are
   * NEVER treated as process ownership claims.
   */
  private parseArtifactStageName(stagedAs: string):
    | { kind: "current"; pid: number; nonce: string; finalName: string }
    | { kind: "legacy" }
    | undefined {
    if (!stagedAs.startsWith(".publishing-")) return undefined;
    const match =
      /^\.publishing-v2-(\d+)-(boot_[A-Za-z0-9_-]{22})-stage_[A-Za-z0-9_-]{22}-(.+)$/.exec(stagedAs);
    if (!match) return { kind: "legacy" };
    const pid = Number(match[1]);
    return Number.isSafeInteger(pid) && pid >= 1
      ? { kind: "current", pid, nonce: match[2], finalName: match[3] }
      : { kind: "legacy" };
  }

  private artifactStageProcessAlive(pid: number): boolean {
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // EPERM means a real process exists but this account may not signal it.
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /**
   * Make the stage→final directory entry durable before SQLite may commit the
   * row that promises it. Windows does not support opening directories and its
   * rename durability contract does not require this call; POSIX failures are
   * real publish failures and are allowed to roll the transaction back.
   */
  private flushArtifactDirectory(): void {
    if (process.platform === "win32") return;
    const fd = fs.openSync(this.artifactsDir, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  /**
   * Parse and validate the durable shape before any field becomes a path or a
   * public projection. Valid JSON such as `{}` is still an unreadable version,
   * and follows the store's existing rule: record the problem, skip the row,
   * keep the rest of the database open.
   */
  private storedArtifactVersion(json: string, rowId: ID): StoredArtifactVersion | undefined {
    const value = this.safeParse<unknown>(json, "a version of a shared file", rowId);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      this.note(`a version of a shared file ${rowId} has an invalid stored shape — it was skipped`);
      return undefined;
    }
    const v = value as Record<string, unknown>;
    const linksOkay = v.links === undefined || validateArtifactLinks(v.links) === null;
    const storedAs = v.storedAs;
    const okay = isSafeStoredId(v.id)
      && typeof v.version === "number" && Number.isSafeInteger(v.version) && v.version >= 1
      && typeof v.size === "number" && Number.isFinite(v.size) && v.size >= 0
      && typeof v.sha256 === "string" && v.sha256.length === 64
      && typeof v.text === "boolean"
      && typeof storedAs === "string" && storedAs.length > 0 && path.basename(storedAs) === storedAs
      && isSafeStoredId(v.agentId)
      && typeof v.agentName === "string"
      && isSafeStoredId(v.ownerId)
      && typeof v.producedAt === "number" && Number.isFinite(v.producedAt)
      && linksOkay;
    if (!okay) {
      this.note(`a version of a shared file ${rowId} has an invalid stored shape — it was skipped`);
      return undefined;
    }
    return value as StoredArtifactVersion;
  }

  /**
   * Remove complete final artifact files no valid version row points at.
   *
   * Cleanup owns the SQLite write lock while it compares rows and names. A stage
   * is protected only when its parsed ownership and age say its publisher can
   * still finish; abandoned stages are reclaimed. If one stored row is unreadable,
   * cleanup deletes nothing — an unknown pointer is not permission to delete bytes.
   */
  sweepArtifactOrphans(): number {
    if (!fs.existsSync(this.artifactsDir)) return 0;
    try {
      return this.tx(() => {
        const rows = this.db.prepare("SELECT id,json FROM artifact_versions").all() as
          { id: string; json: string }[];
        const keep = new Set<string>();
        for (const r of rows) {
          const v = this.storedArtifactVersion(r.json, r.id);
          if (!v) return 0;
          keep.add(v.storedAs);
        }
        let removed = 0;
        const now = Date.now();
        for (const entry of fs.readdirSync(this.artifactsDir, { withFileTypes: true })) {
          if (!entry.isFile() || keep.has(entry.name)) continue;
          const fullPath = path.join(this.artifactsDir, entry.name);
          const stage = this.parseArtifactStageName(entry.name);
          if (stage) {
            let recent: boolean;
            try { recent = now - fs.statSync(fullPath).mtimeMs < ARTIFACT_STAGE_GRACE_MS; }
            catch { continue; }
            if (stage.kind === "current") {
              if (stage.pid === process.pid) {
                // A reused pid names this process too. Only this process lifetime's
                // nonce proves the recent stage can still be completed here.
                if (recent && stage.nonce === this.artifactStageNonce) continue;
              } else {
                // Another process keeps the established protection: both recent
                // age and a live pid. Its nonce is not ours to interpret.
                if (recent && this.artifactStageProcessAlive(stage.pid)) continue;
              }
            } else if (recent) {
              // Legacy/unknown names make no pid claim at all. Age is their only
              // safe in-flight signal, including names that happen to start with
              // digits from an older protocol.
              continue;
            }
            // Current dead/old stage, or old legacy stage: interrupted publish.
          }
          try {
            fs.rmSync(fullPath);
            removed += 1;
          } catch { /* another cleanup won the race */ }
        }
        return removed;
      });
    } catch (e) {
      if (String((e as Error)?.message ?? e).includes("SQLITE_BUSY")) {
        this.note("artifact cleanup skipped because another live hub is publishing");
        return 0;
      }
      throw e;
    }
  }

  /**
   * The identity row for one name in one conversation, or nothing.
   *
   * Looked up by `nameKey` — the SAME function that decides two agents are
   * called the same thing — so `Report.md` and `report.md` are one artifact with
   * two versions rather than two files nobody can tell apart in a list.
   */
  artifactRowByName(channelId: ID, name: string): ArtifactRow | undefined {
    const row = this.db.prepare(
      "SELECT id,channelId,name,nameKey,createdAt,updatedAt,nextVersion FROM artifacts " +
      "WHERE channelId=? AND nameKey=?",
    ).get(channelId, nameKey(name)) as ArtifactRow | undefined;
    return row;
  }

  artifactRow(id: ID): ArtifactRow | undefined {
    return this.db.prepare(
      "SELECT id,channelId,name,nameKey,createdAt,updatedAt,nextVersion FROM artifacts WHERE id=?",
    ).get(id) as ArtifactRow | undefined;
  }

  /** The selected people stored for this chain. Missing is the legacy-safe room default. */
  storedArtifactAccess(artifactId: ID): ArtifactAccess {
    const row = this.db.prepare("SELECT kind FROM artifact_access WHERE artifactId=?")
      .get(artifactId) as { kind: string } | undefined;
    if (!row || row.kind !== "restricted") return { kind: "room" };
    const userIds = (this.db.prepare(
      "SELECT userId FROM artifact_access_users WHERE artifactId=? ORDER BY position ASC, userId ASC",
    ).all(artifactId) as { userId: string }[]).map(r => r.userId);
    return { kind: "restricted", userIds };
  }

  /**
   * The access shape handed to a screen: selected current people PLUS every
   * current human owner/admin of the source room. Managers are derived on every
   * read, never frozen into the stored allowlist, so a role change takes effect
   * immediately.
   */
  artifactAccess(artifactId: ID): ArtifactAccess {
    const access = this.storedArtifactAccess(artifactId);
    if (access.kind === "room") return access;
    const artifact = this.artifactRow(artifactId);
    if (!artifact) return access;
    const selected = (this.db.prepare(
      "SELECT aau.userId FROM artifact_access_users aau " +
      "JOIN channel_members cm ON cm.channelId=? AND cm.memberId=aau.userId AND cm.removedAt IS NULL " +
      "JOIN users u ON u.id=aau.userId WHERE aau.artifactId=? " +
      "ORDER BY aau.position ASC, aau.userId ASC",
    ).all(artifact.channelId, artifactId) as { userId: string }[]).map(r => r.userId);
    const managers = (this.db.prepare(
      "SELECT cm.memberId FROM channel_members cm JOIN users u ON u.id=cm.memberId " +
      "WHERE cm.channelId=? AND cm.removedAt IS NULL AND cm.role IN ('owner','admin') " +
      "ORDER BY cm.joinedAt ASC, cm.memberId ASC",
    ).all(artifact.channelId) as { memberId: string }[]).map(r => r.memberId);
    return { kind: "restricted", userIds: [...new Set([...selected, ...managers])] };
  }

  /**
   * Replace the whole-chain access rule as one write. Selected ids are checked
   * again INSIDE the transaction against current human membership; a server-side
   * pre-check is only a friendly early refusal and can never authorize the write.
   */
  setArtifactAccess(artifactId: ID, access: ArtifactAccess): void {
    this.tx(() => {
      const artifact = this.artifactRow(artifactId);
      if (!artifact) throw new Error("no such file");
      if (access.kind === "restricted") {
        const activeHuman = this.db.prepare(
          "SELECT 1 FROM channel_members cm JOIN users u ON u.id=cm.memberId " +
          "WHERE cm.channelId=? AND cm.memberId=? AND cm.removedAt IS NULL",
        );
        for (const userId of access.userIds) {
          if (!activeHuman.get(artifact.channelId, userId)) {
            throw new Error("file access can only include current people in this conversation");
          }
        }
      }
      this.db.prepare("DELETE FROM artifact_access_users WHERE artifactId=?").run(artifactId);
      this.db.prepare("DELETE FROM artifact_access WHERE artifactId=?").run(artifactId);
      if (access.kind === "room") return;
      this.db.prepare("INSERT INTO artifact_access(artifactId,kind) VALUES(?,'restricted')")
        .run(artifactId);
      const insert = this.db.prepare(
        "INSERT INTO artifact_access_users(artifactId,userId,position) VALUES(?,?,?)",
      );
      access.userIds.forEach((userId, position) => insert.run(artifactId, userId, position));
    });
  }

  /** Room visibility has already passed; this is the optional narrower gate. */
  artifactAccessAllows(artifactId: ID, userId: ID): boolean {
    const access = this.storedArtifactAccess(artifactId);
    if (access.kind === "room") return true;
    const artifact = this.artifactRow(artifactId);
    if (!artifact || !this.user(userId)) return false;
    const role = this.memberRole(artifact.channelId, userId);
    if (!role) return false; // selected means a CURRENT human room member
    return role === "owner" || role === "admin" || access.userIds.includes(userId);
  }

  /**
   * Take the next version number for this artifact, making the identity row if
   * this is the first version.
   *
   * ONE STATEMENT DECIDES A VERSION NUMBER, and it is a write. Reading the
   * highest stored version and adding one is the race that gives two publishes
   * the same number; `nextVersion` is claimed and incremented in the same step,
   * so the number a caller gets is theirs alone.
   */
  claimArtifactVersion(input: { channelId: ID; name: string; at: number }): ArtifactRow {
    const existing = this.artifactRowByName(input.channelId, input.name);
    if (existing) {
      this.db.prepare("UPDATE artifacts SET nextVersion=nextVersion+1, updatedAt=? WHERE id=?")
        .run(input.at, existing.id);
      return { ...existing, nextVersion: existing.nextVersion + 1, updatedAt: input.at };
    }
    const row: ArtifactRow = {
      id: newId("af"), channelId: input.channelId, name: input.name,
      nameKey: nameKey(input.name), createdAt: input.at, updatedAt: input.at,
      // 1 is handed out; the NEXT one is 2
      nextVersion: 2,
    };
    this.db.prepare(
      "INSERT INTO artifacts(id,channelId,name,nameKey,createdAt,updatedAt,nextVersion) " +
      "VALUES(?,?,?,?,?,?,?)",
    ).run(row.id, row.channelId, row.name, row.nameKey, row.createdAt, row.updatedAt, row.nextVersion);
    return row;
  }

  /**
   * Append identity metadata, one immutable version and its exact links in one
   * database transaction. The caller has already written the uniquely-named
   * bytes; any refusal removes them before it escapes, so a bad link, duplicate
   * id or failed insert cannot leave either a false `updatedAt` or orphan bytes.
   */
  appendArtifactVersion(input: {
    channelId: ID;
    name: string;
    at: number;
    version: Omit<StoredArtifactVersion, "version">;
    stage: ArtifactByteStage;
  }): StoredArtifact {
    // Compensation may delete only a stage proved to belong to THIS exact append.
    // A syntactically-current stage from another pid/startup, or an owned stage
    // minted for another version/name, is somebody else's in-flight work and is
    // refused before the compensation scope begins so it remains untouched.
    const expectedStoredAs = `${input.version.id}-${path.basename(input.name)}`;
    const parsedStage = this.parseArtifactStageName(input.stage.stagedAs);
    if (path.basename(input.stage.stagedAs) !== input.stage.stagedAs
      || path.basename(input.stage.storedAs) !== input.stage.storedAs
      || input.stage.storedAs !== expectedStoredAs
      || input.version.storedAs !== expectedStoredAs
      || parsedStage?.kind !== "current"
      || parsedStage.pid !== process.pid
      || parsedStage.nonce !== this.artifactStageNonce
      || parsedStage.finalName !== expectedStoredAs) {
      throw new Error("that file's staged bytes do not belong to this append");
    }

    let artifactId: ID | undefined;
    let promoted = false;
    try {
      artifactId = this.tx(() => {
        const existing = this.artifactRowByName(input.channelId, input.name);
        const id = existing?.id ?? newId("af");
        const versionNumber = existing?.nextVersion ?? 1;
        const stored: StoredArtifactVersion = { ...input.version, version: versionNumber };
        if (!existing && this.artifactCountIn(input.channelId) >= ARTIFACT_LIMITS.perChannel) {
          throw new Error(
            `this conversation already holds ${ARTIFACT_LIMITS.perChannel} shared files — ` +
            "the oldest have to be cleared before another can be added",
          );
        }

        // Storage repeats the server's same-room/exact-version check. A wire
        // validator can prove shape; only stored state can prove the target.
        const targetExists = this.db.prepare(
          "SELECT 1 FROM artifact_versions av JOIN artifacts a ON a.id=av.artifactId " +
          "WHERE av.artifactId=? AND av.version=? AND a.channelId=?",
        );
        for (const link of stored.links ?? []) {
          if (!targetExists.get(link.target.artifactId, link.target.version, input.channelId)) {
            throw new Error("a linked file version is not available in this conversation");
          }
        }

        if (existing) {
          this.db.prepare("UPDATE artifacts SET nextVersion=?, updatedAt=? WHERE id=?")
            .run(versionNumber + 1, input.at, existing.id);
        } else {
          this.db.prepare(
            "INSERT INTO artifacts(id,channelId,name,nameKey,createdAt,updatedAt,nextVersion) " +
            "VALUES(?,?,?,?,?,?,?)",
          ).run(id, input.channelId, input.name, nameKey(input.name), input.at, input.at, 2);
        }

        const stagedPath = path.join(this.artifactsDir, input.stage.stagedAs);
        const finalPath = path.join(this.artifactsDir, input.stage.storedAs);
        if (fs.existsSync(finalPath)) {
          throw new Error("that immutable file version already has bytes");
        }
        fs.renameSync(stagedPath, finalPath);
        promoted = true;

        // Plain INSERT plus both unique rules. Nothing here can replace a row.
        this.saveArtifactVersion(id, input.channelId, stored);
        // Findable in the SAME transaction that made it real. Indexing after
        // the commit would leave a window where a file exists and cannot be
        // found, and a crash inside that window would leave it unfindable
        // until the next restart noticed the count was short.
        this.indexArtifactName(id, input.channelId, input.name, input.at);
        this.indexArtifactVersion(id, input.channelId, stored);
        const insertLink = this.db.prepare(
          "INSERT INTO artifact_links" +
          "(sourceArtifactId,sourceVersion,channelId,kind,targetArtifactId,targetVersion) " +
          "VALUES(?,?,?,?,?,?)",
        );
        for (const link of stored.links ?? []) {
          insertLink.run(
            id, versionNumber, input.channelId, link.kind,
            link.target.artifactId, link.target.version,
          );
        }
        // The file name is durable before COMMIT can make its row durable.
        this.flushArtifactDirectory();
        return id;
      });
    } catch (e) {
      if (promoted) this.removeArtifactBytes(input.stage.storedAs);
      else this.removeArtifactStage(input.stage.stagedAs);
      throw e;
    }
    return this.artifact(artifactId)!;
  }

  /**
   * Store one immutable version row. The bytes are already on disk.
   *
   * Plain INSERT is the rule. `OR REPLACE` is a delete followed by an insert,
   * which lets a repeated id overwrite old provenance; without the
   * `(artifactId,version)` unique index, a different id can also sit beside the
   * old row claiming the same version number. Both are edits wearing append's
   * clothes, so the database refuses both.
   */
  saveArtifactVersion(artifactId: ID, channelId: ID, v: StoredArtifactVersion): void {
    this.db.prepare(
      "INSERT INTO artifact_versions" +
      "(id,artifactId,channelId,agentId,version,producedAt,json) VALUES(?,?,?,?,?,?,?)",
    ).run(v.id, artifactId, channelId, v.agentId, v.version, v.producedAt, JSON.stringify(v));
  }

  /**
   * Throw away versions past the cap, bytes and row together.
   *
   * The oldest go first, and the newest is never a candidate however low a cap
   * somebody sets — an artifact with no version would be a row that promises a
   * file and has none. Returns how many were reclaimed.
   */
  pruneArtifactVersions(artifactId: ID, keep: number): number {
    const rows = this.db.prepare(
      "SELECT id,json FROM artifact_versions WHERE artifactId=? ORDER BY version DESC",
    ).all(artifactId) as { id: string; json: string }[];
    const doomed = rows.slice(Math.max(1, keep));
    for (const r of doomed) {
      const v = this.storedArtifactVersion(r.json, r.id);
      if (v?.storedAs) this.removeArtifactBytes(v.storedAs);
      if (v) {
        this.db.prepare(
          "DELETE FROM artifact_links WHERE sourceArtifactId=? AND sourceVersion=?",
        ).run(artifactId, v.version);
      }
      this.db.prepare("DELETE FROM artifact_versions WHERE id=?").run(r.id);
      // The bytes are gone, so the words must go with them. A retained search
      // document pointing at pruned bytes is a hit that opens nothing.
      this.unindexDoc(r.id);
    }
    return doomed.length;
  }

  /** One artifact and its versions, newest first — the wire shape, assembled. */
  artifact(id: ID): StoredArtifact | undefined {
    const row = this.artifactRow(id);
    if (!row) return undefined;
    const versions = this.artifactVersionsOf(id);
    // An identity row with no version left is not something a screen can draw,
    // so it is not something this hands out. It can only happen to a database
    // edited by hand, and saying nothing is better than saying half a file.
    if (versions.length === 0) return undefined;
    const access = this.artifactAccess(row.id);
    return {
      id: row.id, channelId: row.channelId, name: row.name,
      versions,
      ...(access.kind === "restricted" ? { access } : {}),
      createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }

  artifactVersionsOf(artifactId: ID): StoredArtifactVersion[] {
    const rows = this.db.prepare(
      "SELECT id,json FROM artifact_versions WHERE artifactId=? ORDER BY version DESC",
    ).all(artifactId) as { id: string; json: string }[];
    const out: StoredArtifactVersion[] = [];
    for (const r of rows) {
      const v = this.storedArtifactVersion(r.json, r.id);
      if (v) out.push(v);
    }
    return out;
  }

  /**
   * One version by ITS OWN id, with the conversation it belongs to.
   *
   * This is what a download ticket is redeemed against: the ticket names a
   * version, and the permission question is about the CHANNEL, which is read
   * from the artifact's own row and never from the ticket.
   */
  artifactVersion(versionId: ID): { version: StoredArtifactVersion; artifactId: ID; channelId: ID } | undefined {
    const row = this.db.prepare(
      "SELECT artifactId,channelId,json FROM artifact_versions WHERE id=?",
    ).get(versionId) as { artifactId: string; channelId: string; json: string } | undefined;
    if (!row) return undefined;
    const version = this.storedArtifactVersion(row.json, versionId);
    if (!version) return undefined;
    return { version, artifactId: row.artifactId, channelId: row.channelId };
  }

  /** One exact retained version by stable artifact id plus immutable number. */
  artifactVersionNumber(
    artifactId: ID, version: number,
  ): { version: StoredArtifactVersion; artifactId: ID; channelId: ID } | undefined {
    const row = this.db.prepare(
      "SELECT id,artifactId,channelId,json FROM artifact_versions WHERE artifactId=? AND version=?",
    ).get(artifactId, version) as
      { id: string; artifactId: string; channelId: string; json: string } | undefined;
    if (!row) return undefined;
    const parsed = this.storedArtifactVersion(row.json, row.id);
    return parsed ? { version: parsed, artifactId: row.artifactId, channelId: row.channelId } : undefined;
  }

  /** Typed links declared by one exact publishing version. */
  artifactLinksFrom(sourceArtifactId: ID, sourceVersion: number): ArtifactLink[] {
    return (this.db.prepare(
      "SELECT kind,targetArtifactId,targetVersion FROM artifact_links " +
      "WHERE sourceArtifactId=? AND sourceVersion=? " +
      "ORDER BY rowid ASC",
    ).all(sourceArtifactId, sourceVersion) as
      { kind: ArtifactLink["kind"]; targetArtifactId: string; targetVersion: number }[])
      .map(r => ({
        kind: r.kind,
        target: { artifactId: r.targetArtifactId, version: r.targetVersion },
      }));
  }

  /** Every retained source version that points at this exact target version. */
  artifactLinksTo(targetArtifactId: ID, targetVersion: number): ArtifactLinkRow[] {
    return this.db.prepare(
      "SELECT sourceArtifactId,sourceVersion,channelId,kind,targetArtifactId,targetVersion " +
      "FROM artifact_links WHERE targetArtifactId=? AND targetVersion=? ORDER BY rowid ASC",
    ).all(targetArtifactId, targetVersion) as unknown as ArtifactLinkRow[];
  }

  /**
   * One deterministic, permission-aware, bounded relation-detail query.
   *
   * Outgoing rows always qualify: an unavailable target becomes one hidden
   * placeholder. Incoming rows qualify only when their exact source version is
   * retained and this user may read that source chain. Therefore every returned
   * DB row becomes exactly one public relation, and `truncated` means there is a
   * real 101st public row — never merely a hidden incoming row projection drops.
   */
  artifactRelationsForDetail(
    artifactId: ID, userId: ID, limit: number = ARTIFACT_LIMITS.relationDetail,
  ): { items: ArtifactRelationRow[]; truncated: boolean } {
    const size = Math.max(1, Math.min(Math.floor(limit), ARTIFACT_LIMITS.relationDetail));
    const rows = this.db.prepare(`
      SELECT l.sourceArtifactId,l.sourceVersion,l.channelId,l.kind,
             l.targetArtifactId,l.targetVersion,'outgoing' AS direction,0 AS directionOrder
      FROM artifact_links l
      JOIN artifact_versions sv
        ON sv.artifactId=l.sourceArtifactId AND sv.version=l.sourceVersion
      WHERE l.sourceArtifactId=?
      UNION ALL
      SELECT l.sourceArtifactId,l.sourceVersion,l.channelId,l.kind,
             l.targetArtifactId,l.targetVersion,'incoming' AS direction,1 AS directionOrder
      FROM artifact_links l
      JOIN artifact_versions sv
        ON sv.artifactId=l.sourceArtifactId AND sv.version=l.sourceVersion
      JOIN artifact_versions tv
        ON tv.artifactId=l.targetArtifactId AND tv.version=l.targetVersion
      JOIN artifacts source ON source.id=l.sourceArtifactId
      WHERE l.targetArtifactId=? AND (
        NOT EXISTS (
          SELECT 1 FROM artifact_access aa
          WHERE aa.artifactId=source.id AND aa.kind='restricted'
        )
        OR EXISTS (
          SELECT 1 FROM artifact_access_users aau
          JOIN channel_members cm
            ON cm.channelId=source.channelId AND cm.memberId=aau.userId AND cm.removedAt IS NULL
          JOIN users u ON u.id=aau.userId
          WHERE aau.artifactId=source.id AND aau.userId=?
        )
        OR EXISTS (
          SELECT 1 FROM channel_members cm JOIN users u ON u.id=cm.memberId
          WHERE cm.channelId=source.channelId AND cm.memberId=? AND cm.removedAt IS NULL
            AND cm.role IN ('owner','admin')
        )
      )
      ORDER BY directionOrder ASC,sourceVersion DESC,targetVersion DESC,kind ASC,
               sourceArtifactId ASC,targetArtifactId ASC
      LIMIT ?
    `).all(artifactId, artifactId, userId, userId, size + 1) as unknown as ArtifactRelationRow[];
    return { items: rows.slice(0, size), truncated: rows.length > size };
  }

  /** Every chain whose cached relation view can change when this chain changes. */
  artifactRelationNeighbors(artifactId: ID): ID[] {
    const rows = this.db.prepare(`
      SELECT targetArtifactId AS artifactId FROM artifact_links WHERE sourceArtifactId=?
      UNION
      SELECT sourceArtifactId AS artifactId FROM artifact_links WHERE targetArtifactId=?
      ORDER BY artifactId ASC
    `).all(artifactId, artifactId) as { artifactId: string }[];
    return rows.map(r => r.artifactId);
  }

  /**
   * The permission-filtered identity rows behind both Files and a room's old
   * artifact list. Every visibility condition is in SQL BEFORE LIMIT; filtering
   * a cut page in JavaScript would make an allowed older file disappear behind
   * a page of restricted ones and falsely say there is no more.
   */
  private visibleArtifactRows(
    userId: ID,
    channelIds: ID[],
    cursor: { before?: number; beforeId?: ID },
    limit: number,
  ): Page<ArtifactRow> {
    if (channelIds.length === 0) return { items: [], hasMore: false };
    const size = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.floor(limit), ARTIFACT_LIMITS.workspacePage))
      : ARTIFACT_LIMITS.workspaceDefault;
    const slots = channelIds.map(() => "?").join(",");
    const beforeSql = cursor.before === undefined
      ? ""
      : " AND (a.updatedAt < ? OR (a.updatedAt = ? AND a.id < ?))";
    const beforeArgs = cursor.before === undefined
      ? []
      : [cursor.before, cursor.before, cursor.beforeId ?? AFTER_EVERY_ID];
    const rows = this.db.prepare(
      `SELECT a.id,a.channelId,a.name,a.nameKey,a.createdAt,a.updatedAt,a.nextVersion
       FROM artifacts a
       WHERE a.channelId IN (${slots})
         AND EXISTS (SELECT 1 FROM artifact_versions av WHERE av.artifactId=a.id)
         AND (
           NOT EXISTS (
             SELECT 1 FROM artifact_access aa
             WHERE aa.artifactId=a.id AND aa.kind='restricted'
           )
           OR EXISTS (
             SELECT 1 FROM artifact_access_users aau
             JOIN channel_members cm
               ON cm.channelId=a.channelId AND cm.memberId=aau.userId AND cm.removedAt IS NULL
             JOIN users u ON u.id=aau.userId
             WHERE aau.artifactId=a.id AND aau.userId=?
           )
           OR EXISTS (
             SELECT 1 FROM channel_members cm JOIN users u ON u.id=cm.memberId
             WHERE cm.channelId=a.channelId AND cm.memberId=? AND cm.removedAt IS NULL
               AND cm.role IN ('owner','admin')
           )
         )${beforeSql}
       ORDER BY a.updatedAt DESC, a.id DESC LIMIT ?`,
    ).all(...channelIds, userId, userId, ...beforeArgs, size + 1) as unknown as ArtifactRow[];
    const hasMore = rows.length > size;
    const items = hasMore ? rows.slice(0, size) : rows;
    const oldest = items[items.length - 1];
    return {
      items,
      hasMore,
      nextBefore: hasMore && oldest ? oldest.updatedAt : undefined,
      nextBeforeId: hasMore && oldest ? oldest.id : undefined,
    };
  }

  /**
   * One bounded Files page across every currently readable room.
   *
   * The SQL permission filter still runs before every LIMIT. Projection validity
   * is the second gate: unreadable JSON rows are skipped and older SQL pages are
   * scanned until this page is full or valid data is genuinely exhausted. The
   * returned cursor is the last RETURNED row, never a malformed row scanned past
   * it, so the next request neither skips nor duplicates a valid artifact.
   */
  artifactWorkspace(
    userId: ID,
    channels: Channel[],
    cursor: { before?: number; beforeId?: ID } = {},
    limit: number = ARTIFACT_LIMITS.workspaceDefault,
  ): Page<ArtifactWorkspaceEntry> {
    const wanted = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.floor(limit), ARTIFACT_LIMITS.workspacePage))
      : ARTIFACT_LIMITS.workspaceDefault;
    const channelNames = new Map(channels.map(ch => [ch.id, ch.name]));
    const channelIds = channels.map(ch => ch.id);
    const candidates: ArtifactWorkspaceEntry[] = [];
    let scanCursor = { ...cursor };

    while (candidates.length <= wanted) {
      const rows = this.visibleArtifactRows(
        userId, channelIds, scanCursor, ARTIFACT_LIMITS.workspacePage,
      );
      for (const row of rows.items) {
        const latest = this.artifactVersionsOf(row.id)[0];
        const channelName = channelNames.get(row.channelId);
        if (!latest || channelName === undefined) continue;
        candidates.push({
          artifactId: row.id,
          channelId: row.channelId,
          channelName,
          name: row.name,
          latest: artifactVersionForPublic(latest),
          versionCount: row.nextVersion - 1,
          access: this.artifactAccess(row.id),
          updatedAt: row.updatedAt,
        });
        if (candidates.length > wanted) break;
      }
      if (candidates.length > wanted || !rows.hasMore) break;
      scanCursor = { before: rows.nextBefore, beforeId: rows.nextBeforeId };
    }

    const hasMore = candidates.length > wanted;
    const items = hasMore ? candidates.slice(0, wanted) : candidates;
    const oldest = items[items.length - 1];
    return {
      items,
      hasMore,
      nextBefore: hasMore && oldest ? oldest.updatedAt : undefined,
      nextBeforeId: hasMore && oldest ? oldest.artifactId : undefined,
    };
  }

  /** Every permitted artifact in one conversation, most recently changed first. */
  artifactsInFor(userId: ID, channelId: ID, limit: number): StoredArtifact[] {
    return this.visibleArtifactRows(userId, [channelId], {}, limit).items
      .map(row => this.artifact(row.id))
      .filter((artifact): artifact is StoredArtifact => artifact !== undefined);
  }

  /** Every artifact in one conversation, the most recently changed first. */
  artifactsIn(channelId: ID, limit: number): StoredArtifact[] {
    const rows = this.db.prepare(
      "SELECT id FROM artifacts WHERE channelId=? ORDER BY updatedAt DESC, id DESC LIMIT ?",
    ).all(channelId, Math.max(1, Math.floor(limit))) as { id: string }[];
    const out: StoredArtifact[] = [];
    for (const r of rows) {
      const a = this.artifact(r.id);
      if (a) out.push(a);
    }
    return out;
  }

  /** How many artifacts this conversation holds — the per-channel ceiling. */
  artifactCountIn(channelId: ID): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM artifacts WHERE channelId=?")
      .get(channelId) as { n: number }).n;
  }

  /** How many versions this agent has published since a moment — the rate check. */
  artifactPublishesSince(agentId: ID, since: number): number {
    return (this.db.prepare(
      "SELECT COUNT(*) n FROM artifact_versions WHERE agentId=? AND producedAt >= ?",
    ).get(agentId, since) as { n: number }).n;
  }

  // ---- read state (on the account, not the machine) ----
  markRead(userId: ID, channelId: ID, ts: number, messageId?: ID): number {
    const now = Date.now();
    const current = this.lastReadCursor(userId, channelId);
    // Read state only ever moves FORWARD. A client that reconnects and replays
    // an old position must not un-read what another machine already read.
    const next = ts > current.ts || (ts === current.ts && (messageId ?? "") > (current.id ?? ""))
      ? { ts, id: messageId } : current;
    this.db.prepare(
      "INSERT INTO reads(userId,channelId,lastReadTs,lastReadId,updatedAt) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(userId,channelId) DO UPDATE SET lastReadTs=excluded.lastReadTs,lastReadId=excluded.lastReadId,updatedAt=excluded.updatedAt",
    ).run(userId, channelId, next.ts, next.id ?? null, now);
    return next.ts;
  }

  lastReadCursor(userId: ID, channelId: ID): { ts: number; id?: ID } {
    const row = this.db.prepare("SELECT lastReadTs,lastReadId FROM reads WHERE userId=? AND channelId=?")
      .get(userId, channelId) as { lastReadTs: number; lastReadId: ID | null } | undefined;
    return { ts: row?.lastReadTs ?? 0, ...(row?.lastReadId ? { id: row.lastReadId } : {}) };
  }

  lastRead(userId: ID, channelId: ID): number {
    const row = this.db.prepare("SELECT lastReadTs FROM reads WHERE userId=? AND channelId=?")
      .get(userId, channelId) as { lastReadTs: number } | undefined;
    return row?.lastReadTs ?? 0;
  }

  /**
   * What is still unread in one conversation for one person.
   * `mine` is that person's own ids — themselves and their agents — so their
   * own words never count as unread and an @mention of their agent still does.
   */
  unreadFor(userId: ID, channelId: ID, mine: Set<ID>): { unread: number; mentions: number } {
    // THE COUNT IS THE TRUTH. This used to stop at 1000 rows, so a conversation
    // with more unread than that reported exactly 1000 — and the screen then
    // printed "999+" as if it had hit a ceiling. A capped number dressed as an
    // exact one is a lie; if the frame cannot carry "capped" (shared types are
    // closed today), the only honest hub answer is the real total.
    const since = this.lastReadCursor(userId, channelId);
    const rows = this.db
      .prepare("SELECT json FROM messages WHERE channelId=? AND (ts>? OR (ts=? AND id>?)) ORDER BY ts ASC,id ASC")
      .all(channelId, since.ts, since.ts, since.id ?? "") as { json: string }[];
    let unread = 0;
    let mentions = 0;
    for (const r of rows) {
      const m = JSON.parse(r.json) as Message;
      if (m.deletedAt) continue;
      if (mine.has(m.authorId)) continue;
      unread++;
      if (m.mentions?.some(id => mine.has(id))) mentions++;
    }
    return { unread, mentions };
  }

  // ---- durable mention/thread-reply inbox -------------------------------

  /** Insert one relay-derived event exactly once and apply retention. */
  saveNotification(row: NotificationInboxRow): boolean {
    const result = this.db.prepare(
      "INSERT OR IGNORE INTO notification_inbox " +
      "(id,recipientId,kind,channelId,messageId,rootId,actorId,createdAt,state) " +
      "VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      row.id, row.recipientId, row.kind, row.channelId, row.messageId,
      row.rootId ?? null, row.actorId, row.createdAt, row.state,
    ) as unknown as { changes?: number | bigint };
    this.pruneNotificationInbox();
    return Number(result.changes ?? 0) > 0;
  }

  /** Rows for ONE recipient. Dismissed rows are excluded by default. */
  notificationsFor(
    recipientId: ID,
    opts: { includeDismissed?: boolean; limit?: number } = {},
  ): NotificationInboxRow[] {
    const requested = typeof opts.limit === "number" && Number.isFinite(opts.limit)
      ? opts.limit : NOTIFICATION_INBOX_LIMITS.page;
    const limit = Math.max(1, Math.min(
      Math.floor(requested),
      NOTIFICATION_INBOX_LIMITS.page,
    ));
    const rows = opts.includeDismissed === true
      ? this.db.prepare(
        "SELECT id,recipientId,kind,channelId,messageId,rootId,actorId,createdAt,state " +
        "FROM notification_inbox WHERE recipientId=? ORDER BY createdAt DESC,id DESC LIMIT ?",
      ).all(recipientId, limit)
      : this.db.prepare(
        "SELECT id,recipientId,kind,channelId,messageId,rootId,actorId,createdAt,state " +
        "FROM notification_inbox WHERE recipientId=? AND state<>'dismissed' " +
        "ORDER BY createdAt DESC,id DESC LIMIT ?",
      ).all(recipientId, limit);
    return (rows as unknown as RawNotificationInboxRow[]).map(toNotificationRow);
  }

  notificationsForMessage(messageId: ID): NotificationInboxRow[] {
    return (this.db.prepare(
      "SELECT id,recipientId,kind,channelId,messageId,rootId,actorId,createdAt,state " +
      "FROM notification_inbox WHERE messageId=?",
    ).all(messageId) as unknown as RawNotificationInboxRow[]).map(toNotificationRow);
  }

  notificationsForChannel(channelId: ID): NotificationInboxRow[] {
    return (this.db.prepare(
      "SELECT id,recipientId,kind,channelId,messageId,rootId,actorId,createdAt,state " +
      "FROM notification_inbox WHERE channelId=?",
    ).all(channelId) as unknown as RawNotificationInboxRow[]).map(toNotificationRow);
  }

  /** Read/dismiss is recipient-scoped and idempotent. */
  setNotificationState(
    recipientId: ID, id: ID, state: Exclude<NotificationInboxState, "unread">,
  ): NotificationInboxRow | undefined {
    const existing = this.db.prepare(
      "SELECT id,recipientId,kind,channelId,messageId,rootId,actorId,createdAt,state " +
      "FROM notification_inbox WHERE id=? AND recipientId=?",
    ).get(id, recipientId) as RawNotificationInboxRow | undefined;
    if (!existing) return undefined;
    // A dismissed row remains dismissed; a read request must not resurrect it.
    const next = existing.state === "dismissed" ? "dismissed" : state;
    this.db.prepare("UPDATE notification_inbox SET state=? WHERE id=? AND recipientId=?")
      .run(next, id, recipientId);
    return toNotificationRow({ ...existing, state: next });
  }

  /**
   * Retention is explicit and conservative: old read/dismissed rows go first;
   * unread rows are never silently discarded merely to satisfy the cap.
   */
  pruneNotificationInbox(now = Date.now()): number {
    const cutoff = now - NOTIFICATION_INBOX_LIMITS.maxAgeMs;
    const before = (this.db.prepare("SELECT COUNT(*) n FROM notification_inbox")
      .get() as { n: number }).n;
    this.db.prepare(
      "DELETE FROM notification_inbox WHERE createdAt<? AND state<>'unread'",
    ).run(cutoff);
    const recipients = this.db.prepare(
      "SELECT DISTINCT recipientId FROM notification_inbox",
    ).all() as { recipientId: string }[];
    for (const { recipientId } of recipients) {
      const rows = this.db.prepare(
        "SELECT id,state FROM notification_inbox WHERE recipientId=? " +
        "ORDER BY createdAt ASC,id ASC",
      ).all(recipientId) as { id: string; state: string }[];
      let excess = Math.max(0, rows.length - NOTIFICATION_INBOX_LIMITS.maxEntries);
      for (const row of rows) {
        if (excess <= 0) break;
        if (row.state === "unread") continue;
        this.db.prepare("DELETE FROM notification_inbox WHERE id=? AND recipientId=?")
          .run(row.id, recipientId);
        excess--;
      }
    }
    const after = (this.db.prepare("SELECT COUNT(*) n FROM notification_inbox")
      .get() as { n: number }).n;
    return before - after;
  }

  // ---- v2: tasks / approvals / activity ----
  saveTask(t: Task): void {
    this.db.prepare("INSERT OR REPLACE INTO tasks(id,updatedAt,json) VALUES(?,?,?)")
      .run(t.id, t.updatedAt, JSON.stringify(t));
  }
  task(id: ID): Task | undefined {
    const row = this.db.prepare("SELECT json FROM tasks WHERE id=?").get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Task) : undefined;
  }
  tasks(limit = 200): Task[] {
    return (this.db.prepare("SELECT json FROM tasks ORDER BY updatedAt DESC LIMIT ?").all(limit) as { json: string }[])
      .map(r => JSON.parse(r.json) as Task);
  }
  saveWorkflow(w: Workflow): void {
    const bad = validateWorkflow(w);
    if (bad) throw new Error(bad);
    this.db.prepare(
      "INSERT OR REPLACE INTO workflows(id,ownerId,updatedAt,json) VALUES(?,?,?,?)",
    ).run(w.id, w.ownerId, w.updatedAt, JSON.stringify(w));
  }
  workflow(id: ID): Workflow | undefined {
    const row = this.db.prepare("SELECT json FROM workflows WHERE id=?").get(id) as
      { json: string } | undefined;
    return row ? JSON.parse(row.json) as Workflow : undefined;
  }
  workflows(ownerId: ID, limit = 200): Workflow[] {
    return (this.db.prepare(
      "SELECT json FROM workflows WHERE ownerId=? ORDER BY updatedAt DESC, id DESC LIMIT ?",
    ).all(ownerId, limit) as { json: string }[]).map(r => JSON.parse(r.json) as Workflow);
  }
  saveWorkflowRun(run: WorkflowRun): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO workflow_runs(id,workflowId,ownerId,updatedAt,json) VALUES(?,?,?,?,?)",
    ).run(run.id, run.workflowId, run.ownerId, run.updatedAt ?? run.finishedAt ?? run.createdAt, JSON.stringify(run));
  }
  workflowRun(id: ID): WorkflowRun | undefined {
    const row = this.db.prepare("SELECT json,updatedAt FROM workflow_runs WHERE id=?").get(id) as
      { json: string; updatedAt: number } | undefined;
    if (!row) return undefined;
    const run = JSON.parse(row.json) as WorkflowRun;
    if (run.updatedAt === undefined) run.updatedAt = row.updatedAt;
    return run;
  }
  workflowRuns(ownerId: ID, workflowId?: ID, limit = 200): WorkflowRun[] {
    const rows = workflowId
      ? this.db.prepare(
        "SELECT json,updatedAt FROM workflow_runs WHERE ownerId=? AND workflowId=? ORDER BY updatedAt DESC,id DESC LIMIT ?",
      ).all(ownerId, workflowId, limit)
      : this.db.prepare(
        "SELECT json,updatedAt FROM workflow_runs WHERE ownerId=? ORDER BY updatedAt DESC,id DESC LIMIT ?",
      ).all(ownerId, limit);
    return (rows as { json: string; updatedAt: number }[]).map(r => {
      const run = JSON.parse(r.json) as WorkflowRun;
      if (run.updatedAt === undefined) run.updatedAt = r.updatedAt;
      return run;
    });
  }
  /** Active runs cannot resume silently after this relay process restarts. */
  interruptActiveWorkflowRuns(ownerId: ID): WorkflowRun[] {
    const active = new Set(["queued", "running", "waiting_you"]);
    const changed: WorkflowRun[] = [];
    for (const run of this.workflowRuns(ownerId, undefined, 1000)) {
      if (!active.has(run.status)) continue;
      const now = Date.now();
      const message = "Cloud9 restarted before a result was recorded; run it again manually.";
      const current = run.currentStepId ? run.steps.find(step => step.id === run.currentStepId) : undefined;
      if (current) {
        current.status = "interrupted";
        current.error = message;
        const attempt = current.attempts.at(-1);
        if (attempt) {
          attempt.status = "interrupted";
          attempt.error = message;
          attempt.finishedAt = now;
          const task = this.task(attempt.taskId);
          if (task && !["completed", "failed", "cancelled"].includes(task.status)) {
            task.status = "cancelled";
            task.error = message;
            task.updatedAt = now;
            this.saveTask(task);
            for (const approval of this.approvals(1000)) {
              if (approval.taskId !== task.id || approval.status !== "pending") continue;
              approval.status = "expired";
              approval.decidedAt = now;
              this.saveApproval(approval);
              this.interruptedWorkflowApprovals.push(approval);
            }
          }
        }
      }
      run.status = "interrupted";
      run.error = message;
      run.finishedAt = now;
      run.updatedAt = now;
      this.saveWorkflowRun(run);
      changed.push(run);
    }
    return changed;
  }
  /** Consume approvals expired by the most recent startup sweep for broadcast. */
  takeInterruptedWorkflowApprovals(): Approval[] {
    const approvals = this.interruptedWorkflowApprovals;
    this.interruptedWorkflowApprovals = [];
    return approvals;
  }
  saveApproval(a: Approval): void {
    this.db.prepare("INSERT OR REPLACE INTO approvals(id,json) VALUES(?,?)").run(a.id, JSON.stringify(a));
  }
  approval(id: ID): Approval | undefined {
    const row = this.db.prepare("SELECT json FROM approvals WHERE id=?").get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Approval) : undefined;
  }
  approvals(limit = 200): Approval[] {
    return (this.db.prepare("SELECT json FROM approvals").all() as { json: string }[])
      .map(r => JSON.parse(r.json) as Approval).slice(-limit);
  }
  // ---- projects: a GitHub repository connected to Cloud9 (his item 7) ----
  //
  // Storage only. Nothing in this section runs `git` or `gh`, and nothing here
  // decides who may do anything: `ownerId` is a column so the server can ask
  // that question of stored state, exactly as it does for a run.

  saveProject(p: Project): void {
    this.db.prepare(
      "INSERT INTO projects(id,ownerId,repo,createdAt,json) VALUES(?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET repo=excluded.repo, json=excluded.json",
    ).run(p.id, p.ownerId, p.repo, p.createdAt, JSON.stringify(p));
    // Project owner is always a forum member; soft-rejoin if previously removed.
    this.db.prepare(
      "INSERT INTO forum_members(projectId,userId,addedAt,removedAt) VALUES(?,?,?,NULL) " +
      "ON CONFLICT(projectId,userId) DO UPDATE SET removedAt=NULL",
    ).run(p.id, p.ownerId, p.createdAt);
  }

  project(id: ID): Project | undefined {
    const row = this.db.prepare("SELECT json FROM projects WHERE id=?").get(id) as
      { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Project) : undefined;
  }

  /** One person's projects, newest first. Never anybody else's. */
  projectsOf(ownerId: ID): Project[] {
    return (this.db.prepare("SELECT json FROM projects WHERE ownerId=? ORDER BY createdAt DESC")
      .all(ownerId) as { json: string }[]).map(r => JSON.parse(r.json) as Project);
  }
  huddleProjects(userId: ID): Project[] {
    const all = (this.db.prepare("SELECT json FROM projects ORDER BY createdAt DESC,id ASC").all() as { json: string }[]).map(r => JSON.parse(r.json) as Project);
    return all.filter(p => p.ownerId === userId || (!!p.channelId && this.channelMembers(p.channelId).some(m => m.memberId === userId)));
  }

  /** Every connected project — membership gates decide who may see each row. */
  projectsAll(): Project[] {
    return (this.db.prepare("SELECT json FROM projects ORDER BY createdAt DESC").all() as { json: string }[])
      .map(r => JSON.parse(r.json) as Project);
  }

  /** Projects a person may use as a social-feed member, including ownership. */
  socialProjectsOf(userId: ID): Project[] {
    return (this.db.prepare(
      "SELECT DISTINCT p.json FROM projects p LEFT JOIN social_members sm ON sm.projectId=p.id " +
      "WHERE p.ownerId=? OR (sm.userId=? AND sm.removedAt IS NULL) ORDER BY p.createdAt DESC",
    ).all(userId, userId) as { json: string }[]).map(r => JSON.parse(r.json) as Project);
  }

  /** The one this person already has for this repository, if any. */
  projectByRepo(ownerId: ID, repo: string): Project | undefined {
    const row = this.db.prepare("SELECT json FROM projects WHERE ownerId=? AND repo=?")
      .get(ownerId, repo) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Project) : undefined;
  }

  hooksOf(ownerId: ID): StoredHook[] {
    return (this.db.prepare("SELECT json FROM hooks WHERE ownerId=? ORDER BY updatedAt DESC, id DESC").all(ownerId) as { json: string }[])
      .map(r => JSON.parse(r.json) as StoredHook);
  }
  hook(ownerId: ID, hookId: ID): StoredHook | undefined {
    const row = this.db.prepare("SELECT json FROM hooks WHERE ownerId=? AND id=?").get(ownerId, hookId) as { json: string } | undefined;
    return row ? JSON.parse(row.json) as StoredHook : undefined;
  }
  saveHook(hook: StoredHook): void {
    this.db.prepare("INSERT INTO hooks(id,ownerId,updatedAt,json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET updatedAt=excluded.updatedAt,json=excluded.json")
      .run(hook.id, hook.ownerId, hook.updatedAt, JSON.stringify(hook));
  }
  deleteHook(ownerId: ID, hookId: ID): void { this.db.prepare("DELETE FROM hooks WHERE ownerId=? AND id=?").run(ownerId, hookId); }
  hookRequest(ownerId: ID, requestId: ID): { hookId: ID; kind: string; target: string; payload: string } | undefined {
    const row = this.db.prepare("SELECT hookId,kind,target,payload FROM hook_requests WHERE ownerId=? AND requestId=?").get(ownerId, requestId) as { hookId: ID; kind: string; target: string; payload: string } | undefined;
    return row;
  }
  private insertHookRequest(ownerId: ID, requestId: ID, hookId: ID, kind: string, target: string, payload: string, createdAt = Date.now()): void {
    this.db.prepare("INSERT INTO hook_requests(ownerId,requestId,hookId,kind,target,payload,createdAt) VALUES(?,?,?,?,?,?,?)")
      .run(ownerId, requestId, hookId, kind, target, payload, createdAt);
  }
  private pruneHookRequests(ownerId: ID, now = Date.now()): void {
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    this.db.prepare("DELETE FROM hook_requests WHERE ownerId=? AND createdAt < ?").run(ownerId, cutoff);
    this.db.prepare(
      "DELETE FROM hook_requests WHERE ownerId=? AND requestId NOT IN " +
      "(SELECT requestId FROM hook_requests WHERE ownerId=? ORDER BY createdAt DESC,requestId DESC LIMIT 512)",
    ).run(ownerId, ownerId);
  }
  saveHookRequest(ownerId: ID, requestId: ID, hookId: ID, kind: string, target: string, payload: string): void {
    this.tx(() => {
      const now = Date.now();
      this.insertHookRequest(ownerId, requestId, hookId, kind, target, payload, now);
      this.pruneHookRequests(ownerId, now);
    });
  }
  /** Persist a rule and its receipt as one durable operation. */
  saveHookWithRequest(
    hook: StoredHook, ownerId: ID, requestId: ID | undefined,
    kind: string, target: string, payload: string,
  ): void {
    this.tx(() => {
      this.saveHook(hook);
      if (requestId) {
        const now = Date.now();
        this.insertHookRequest(ownerId, requestId, hook.id, kind, target, payload, now);
        this.pruneHookRequests(ownerId, now);
      }
    });
  }
  /** Delete a rule and remember that delete as one durable operation. */
  deleteHookWithRequest(
    ownerId: ID, hookId: ID, requestId: ID | undefined,
    kind: string, target: string, payload: string,
  ): void {
    this.tx(() => {
      this.deleteHook(ownerId, hookId);
      if (requestId) {
        const now = Date.now();
        this.insertHookRequest(ownerId, requestId, hookId, kind, target, payload, now);
        this.pruneHookRequests(ownerId, now);
      }
    });
  }
  private insertHookAudit(
    ownerId: ID, hookId: ID, action: string, ok: boolean, said: string,
    at: number, actorId: ID, client: string, requestId?: ID, target = hookId,
  ): void {
    this.db.prepare("INSERT INTO hook_audit(id,ownerId,hookId,action,ok,said,at,actorId,client,requestId,target) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(newId("hookaudit"), ownerId, hookId, action, ok ? 1 : 0, said, at, actorId, client, requestId ?? null, target);
  }
  private pruneHookAudit(ownerId: ID, now = Date.now()): void {
    const cutoff = now - 30 * 24 * 60 * 60 * 1000;
    this.db.prepare("DELETE FROM hook_audit WHERE ownerId=? AND at < ?").run(ownerId, cutoff);
    this.db.prepare(
      "DELETE FROM hook_audit WHERE ownerId=? AND id NOT IN " +
      "(SELECT id FROM hook_audit WHERE ownerId=? ORDER BY at DESC,id DESC LIMIT 512)",
    ).run(ownerId, ownerId);
  }
  logHookAudit(
    ownerId: ID, hookId: ID, action: string, ok: boolean, said: string,
    at = Date.now(), actorId = ownerId, client = "", requestId?: ID, target = hookId,
  ): void {
    this.tx(() => {
      this.insertHookAudit(ownerId, hookId, action, ok, said, at, actorId, client, requestId, target);
      this.pruneHookAudit(ownerId, at);
    });
  }
  /** Test receipt and its visible audit row are one durable operation. */
  recordHookTest(
    ownerId: ID, hook: StoredHook, requestId: ID | undefined, ok: boolean, said: string,
    at = Date.now(), client = "desktop",
  ): void {
    this.tx(() => {
      if (requestId) {
        this.insertHookRequest(ownerId, requestId, hook.id, "test", hook.id, "{}", at);
        this.pruneHookRequests(ownerId, at);
      }
      this.insertHookAudit(ownerId, hook.id, "tested", ok, said, at, ownerId, client, requestId, hook.id);
      this.pruneHookAudit(ownerId, at);
    });
  }
  /** Whether a hook firing receipt was already written (transport retry safe). */
  hookAuditHasRequest(ownerId: ID, requestId: ID, target?: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM hook_audit WHERE ownerId=? AND requestId=? AND (? IS NULL OR target=?) LIMIT 1",
    ).get(ownerId, requestId, target ?? null, target ?? null));
  }
  hookAuditOf(ownerId: ID): { hookId: ID; action: string; ok: boolean; said: string; at: number; actorId: ID; client: string; requestId?: ID; target: string }[] {
    return (this.db.prepare("SELECT hookId,action,ok,said,at,actorId,client,requestId,target FROM hook_audit WHERE ownerId=? ORDER BY at DESC,id DESC LIMIT 512")
      .all(ownerId) as { hookId: ID; action: string; ok: number; said: string; at: number; actorId: ID; client: string; requestId: ID | null; target: string }[]).reverse()
      .map(row => ({ hookId: row.hookId, action: row.action, ok: row.ok === 1, said: row.said, at: row.at, actorId: row.actorId, client: row.client, ...(row.requestId ? { requestId: row.requestId } : {}), target: row.target }));
  }

  /** Forget our copy. THE REPOSITORY IS NOT TOUCHED — it is not ours to touch. */
  forgetProject(id: ID): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM engineering_canvas_requests WHERE canvasId IN (SELECT id FROM engineering_canvases WHERE projectId=? )").run(id);
      this.db.prepare("DELETE FROM engineering_canvas_reads WHERE canvasId IN (SELECT id FROM engineering_canvases WHERE projectId=? )").run(id);
      this.db.prepare("DELETE FROM engineering_canvas_revisions WHERE canvasId IN (SELECT id FROM engineering_canvases WHERE projectId=? )").run(id);
      this.db.prepare("DELETE FROM engineering_canvases WHERE projectId=?").run(id);
      this.db.prepare("DELETE FROM project_poll_votes WHERE pollId IN (SELECT id FROM project_polls WHERE projectId=?)").run(id);
      this.db.prepare("DELETE FROM project_poll_requests WHERE projectId=?").run(id);
      this.db.prepare("DELETE FROM project_polls WHERE projectId=?").run(id);
      this.deleteHuddleRows(id);
      this.db.prepare("DELETE FROM project_items WHERE projectId=?").run(id);
      this.db.prepare("DELETE FROM social_reactions WHERE projectId=?").run(id);
      this.db.prepare("DELETE FROM social_posts WHERE projectId=?").run(id);
      this.db.prepare("DELETE FROM social_reads WHERE projectId=?").run(id);
      this.db.prepare("DELETE FROM social_members WHERE projectId=?").run(id);
      this.db.prepare("DELETE FROM social_ops WHERE projectId=?").run(id);
      // Receipts are private retry state, but they still name an update. They
      // must disappear with the project so a later request cannot replay a
      // forgotten record (or retain its id after access is revoked).
      this.db.prepare("DELETE FROM pulse_mutation_receipts WHERE projectId=? OR updateId IN (SELECT id FROM pulse_updates WHERE projectId=?)")
        .run(id, id);
      this.db.prepare("DELETE FROM pulse_updates WHERE projectId=?").run(id);
      this.db.prepare("DELETE FROM pulse_reads WHERE projectId=?").run(id);
      // Project forums / decision threads — topics, replies, membership, reads, receipts.
      this.db.prepare("DELETE FROM forum_ops WHERE projectId=?").run(id);
      this.db.prepare("DELETE FROM forum_replies WHERE topicId IN (SELECT id FROM forum_topics WHERE projectId=?)").run(id);
      this.db.prepare("DELETE FROM forum_topics WHERE projectId=?").run(id);
      this.db.prepare("DELETE FROM forum_members WHERE projectId=?").run(id);
      this.db.prepare("DELETE FROM forum_reads WHERE projectId=?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id=?").run(id);
    });
  }


  private backfillForumOwners(): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO forum_members(projectId,userId,addedAt,removedAt) SELECT id,ownerId,createdAt,NULL FROM projects",
    ).run();
  }

  /**
   * v9 (Pulse) → v10 (forums). Idempotent: owner backfill always runs, and
   * forum_ops columns are only added when missing. Hubs already at Pulse v9
   * must still execute this step — forums must never steal the Pulse step number.
   */
  private addForumSchema(): void {
    const cols = this.db.prepare("PRAGMA table_info(forum_ops)").all() as { name: string }[];
    if (!cols.some(c => c.name === "projectId")) {
      this.db.exec("ALTER TABLE forum_ops ADD COLUMN projectId TEXT NOT NULL DEFAULT ''");
    }
    const nextCols = this.db.prepare("PRAGMA table_info(forum_ops)").all() as { name: string }[];
    if (!nextCols.some(c => c.name === "targetId")) {
      this.db.exec("ALTER TABLE forum_ops ADD COLUMN targetId TEXT NOT NULL DEFAULT ''");
    }
    const finalCols = this.db.prepare("PRAGMA table_info(forum_ops)").all() as { name: string }[];
    if (!finalCols.some(c => c.name === "payloadHash")) {
      this.db.exec("ALTER TABLE forum_ops ADD COLUMN payloadHash TEXT NOT NULL DEFAULT ''");
    }
    this.backfillForumOwners();
    // Receipts written by an early forum build may lack project/target binding.
    // Resolve them while the old rows still exist; unresolved receipts stay
    // non-replayable rather than guessing.
    const receipts = this.db.prepare(
      "SELECT userId,requestId,kind,resultId FROM forum_ops WHERE projectId='' OR targetId=''",
    ).all() as { userId: ID; requestId: ID; kind: string; resultId: ID }[];
    const update = this.db.prepare(
      "UPDATE forum_ops SET projectId=?,targetId=? WHERE userId=? AND requestId=?",
    );
    for (const receipt of receipts) {
      let projectId = "";
      let targetId = "";
      if (["topic", "edit-topic", "delete-topic", "status", "accept"].includes(receipt.kind)) {
        const row = this.db.prepare("SELECT projectId FROM forum_topics WHERE id=?")
          .get(receipt.resultId) as { projectId: ID } | undefined;
        projectId = row?.projectId ?? "";
        targetId = receipt.kind === "topic" ? projectId : receipt.resultId;
      } else if (["reply", "edit-reply", "delete-reply"].includes(receipt.kind)) {
        const row = this.db.prepare(
          "SELECT t.projectId,r.topicId FROM forum_replies r JOIN forum_topics t ON t.id=r.topicId WHERE r.id=?",
        ).get(receipt.resultId) as { projectId: ID; topicId: ID } | undefined;
        projectId = row?.projectId ?? "";
        targetId = receipt.kind === "reply" ? row?.topicId ?? "" : receipt.resultId;
      } else if (["read", "list-members", "add-member", "remove-member", "members"].includes(receipt.kind)) {
        projectId = receipt.resultId;
        targetId = receipt.resultId;
      }
      if (projectId && targetId) update.run(projectId, targetId, receipt.userId, receipt.requestId);
    }
  }

  // ---- durable project forums / decision threads ----
  forumIsMember(projectId: ID, userId: ID): boolean {
    return !!this.db.prepare(
      "SELECT 1 FROM forum_members WHERE projectId=? AND userId=? AND removedAt IS NULL",
    ).get(projectId, userId);
  }
  forumMembers(projectId: ID): ID[] {
    return (this.db.prepare(
      "SELECT userId FROM forum_members WHERE projectId=? AND removedAt IS NULL ORDER BY addedAt,userId",
    ).all(projectId) as { userId: string }[]).map(r => r.userId);
  }
  addForumMember(projectId: ID, userId: ID): void {
    this.db.prepare(
      "INSERT INTO forum_members(projectId,userId,addedAt,removedAt) VALUES(?,?,?,NULL) " +
      "ON CONFLICT(projectId,userId) DO UPDATE SET removedAt=NULL, addedAt=excluded.addedAt",
    ).run(projectId, userId, Date.now());
  }
  removeForumMember(projectId: ID, userId: ID): void {
    this.db.prepare("UPDATE forum_members SET removedAt=? WHERE projectId=? AND userId=?")
      .run(Date.now(), projectId, userId);
  }
  forumProjectsOf(userId: ID): Project[] {
    return (this.db.prepare(
      "SELECT p.json FROM projects p JOIN forum_members m ON m.projectId=p.id " +
      "WHERE m.userId=? AND m.removedAt IS NULL ORDER BY p.createdAt DESC,p.id DESC",
    ).all(userId) as { json: string }[]).map(r => JSON.parse(r.json) as Project);
  }
  forumRequestInfo(userId: ID, requestId: ID):
    { projectId: ID; targetId: ID; kind: string; resultId: ID; payloadHash: string } | undefined {
    return this.db.prepare(
      "SELECT projectId,targetId,kind,resultId,payloadHash FROM forum_ops WHERE userId=? AND requestId=?",
    ).get(userId, requestId) as
      { projectId: ID; targetId: ID; kind: string; resultId: ID; payloadHash: string } | undefined;
  }
  rememberForumRequest(
    userId: ID, requestId: ID, projectId: ID, targetId: ID,
    kind: string, resultId: ID, payloadHash = "",
  ): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO forum_ops(userId,requestId,projectId,targetId,kind,resultId,payloadHash,createdAt) " +
      "VALUES(?,?,?,?,?,?,?,?)",
    ).run(userId, requestId, projectId, targetId, kind, resultId, payloadHash, Date.now());
  }
  forumMutation<T>(
    work: () => T,
    receipt?: {
      userId: ID; requestId?: ID; projectId: ID; targetId: ID;
      kind: string; resultId: ID; payloadHash?: string;
    },
  ): T {
    return this.tx(() => {
      const out = work();
      if (receipt?.requestId) {
        this.rememberForumRequest(
          receipt.userId, receipt.requestId, receipt.projectId, receipt.targetId,
          receipt.kind, receipt.resultId, receipt.payloadHash,
        );
      }
      return out;
    });
  }
  saveForumTopic(topic: ForumTopic): void {
    const old = this.forumTopic(topic.id);
    if (old?.deletedAt) topic = old;
    this.db.prepare(
      "INSERT OR REPLACE INTO forum_topics(id,projectId,createdAt,updatedAt,json) VALUES(?,?,?,?,?)",
    ).run(topic.id, topic.projectId, topic.createdAt, topic.updatedAt, JSON.stringify(topic));
  }
  forumTopic(id: ID): ForumTopic | undefined {
    const r = this.db.prepare("SELECT json FROM forum_topics WHERE id=?").get(id) as
      { json: string } | undefined;
    return r ? JSON.parse(r.json) as ForumTopic : undefined;
  }
  forumTopicFor(userId: ID, id: ID): ForumTopic | undefined {
    const r = this.db.prepare(
      "SELECT t.json FROM forum_topics t JOIN forum_members m ON m.projectId=t.projectId " +
      "AND m.userId=? AND m.removedAt IS NULL WHERE t.id=?",
    ).get(userId, id) as { json: string } | undefined;
    return r ? JSON.parse(r.json) as ForumTopic : undefined;
  }
  forumTopics(projectId: ID, before?: number, beforeId?: ID, limit = 50): ForumPage<ForumTopic> {
    const cap = Math.min(Math.max(limit, 1), 100);
    const rows = before === undefined
      ? this.db.prepare(
        "SELECT json FROM forum_topics WHERE projectId=? ORDER BY createdAt DESC,id DESC LIMIT ?",
      ).all(projectId, cap + 1)
      : this.db.prepare(
        "SELECT json FROM forum_topics WHERE projectId=? AND (createdAt<? OR (createdAt=? AND id<?)) " +
        "ORDER BY createdAt DESC,id DESC LIMIT ?",
      ).all(projectId, before, before, beforeId ?? "", cap + 1);
    const items = (rows as { json: string }[]).map(r => JSON.parse(r.json) as ForumTopic);
    const hasMore = items.length > cap;
    if (hasMore) items.pop();
    const last = items[items.length - 1];
    return { items, hasMore, ...(last ? { nextBefore: last.createdAt, nextBeforeId: last.id } : {}) };
  }
  saveForumReply(reply: ForumReply): void {
    const old = this.forumReply(reply.id);
    if (old?.deletedAt) reply = old;
    this.db.prepare(
      "INSERT OR REPLACE INTO forum_replies(id,topicId,createdAt,updatedAt,json) VALUES(?,?,?,?,?)",
    ).run(reply.id, reply.topicId, reply.createdAt, reply.updatedAt, JSON.stringify(reply));
  }
  forumReply(id: ID): ForumReply | undefined {
    const r = this.db.prepare("SELECT json FROM forum_replies WHERE id=?").get(id) as
      { json: string } | undefined;
    return r ? JSON.parse(r.json) as ForumReply : undefined;
  }
  forumReplyFor(userId: ID, id: ID): ForumReply | undefined {
    const r = this.db.prepare(
      "SELECT r.json FROM forum_replies r JOIN forum_topics t ON t.id=r.topicId " +
      "JOIN forum_members m ON m.projectId=t.projectId AND m.userId=? AND m.removedAt IS NULL WHERE r.id=?",
    ).get(userId, id) as { json: string } | undefined;
    return r ? JSON.parse(r.json) as ForumReply : undefined;
  }
  forumReplies(topicId: ID): ForumReply[] {
    return (this.db.prepare(
      "SELECT json FROM forum_replies WHERE topicId=? ORDER BY createdAt ASC,id ASC",
    ).all(topicId) as { json: string }[]).map(r => JSON.parse(r.json) as ForumReply);
  }
  forumRead(userId: ID, projectId: ID): number {
    const r = this.db.prepare(
      "SELECT lastReadAt FROM forum_reads WHERE userId=? AND projectId=?",
    ).get(userId, projectId) as { lastReadAt: number } | undefined;
    return r?.lastReadAt ?? 0;
  }
  markForumRead(userId: ID, projectId: ID, at: number): ForumReadEntry {
    const next = Math.max(this.forumRead(userId, projectId), at);
    this.db.prepare(
      "INSERT INTO forum_reads(userId,projectId,lastReadAt,updatedAt) VALUES(?,?,?,?) " +
      "ON CONFLICT(userId,projectId) DO UPDATE SET lastReadAt=excluded.lastReadAt,updatedAt=excluded.updatedAt",
    ).run(userId, projectId, next, Date.now());
    return { projectId, lastReadAt: next, unread: this.forumUnread(userId, projectId) };
  }
  /**
   * Unread counts topics and replies by their own clocks. A reply on an older
   * topic must still bump the count after mark-read (class fix: do not filter
   * topics by createdAt before inspecting replies).
   */
  forumUnread(userId: ID, projectId: ID): number {
    const since = this.forumRead(userId, projectId);
    let n = 0;
    const topics = this.db.prepare(
      "SELECT json FROM forum_topics WHERE projectId=?",
    ).all(projectId) as { json: string }[];
    for (const row of topics) {
      const t = JSON.parse(row.json) as ForumTopic;
      if (t.deletedAt) continue;
      if (t.createdAt > since && t.authorId !== userId) n++;
      for (const x of this.forumReplies(t.id)) {
        if (x.createdAt > since && !x.deletedAt && x.authorId !== userId) n++;
      }
    }
    return n;
  }

  saveProjectPoll(poll: ProjectPoll): void {
    this.db.prepare(
      "INSERT INTO project_polls(id,projectId,createdAt,status,deadlineAt,json) VALUES(?,?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET status=excluded.status, deadlineAt=excluded.deadlineAt, json=excluded.json",
    ).run(poll.id, poll.projectId, poll.createdAt, poll.status, poll.deadlineAt ?? null, JSON.stringify(poll));
  }
  projectPoll(id: ID): ProjectPoll | undefined {
    const row = this.db.prepare("SELECT json FROM project_polls WHERE id=?").get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as ProjectPoll) : undefined;
  }
  projectPolls(projectId: ID): ProjectPoll[] {
    return (this.db.prepare("SELECT json FROM project_polls WHERE projectId=? ORDER BY createdAt DESC, id DESC")
      .all(projectId) as { json: string }[]).map(r => JSON.parse(r.json) as ProjectPoll);
  }
  projectPollCount(projectId: ID): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM project_polls WHERE projectId=?").get(projectId) as { n: number }).n;
  }
  voteProjectPoll(pollId: ID, voterId: ID, optionId: ID, votedAt = Date.now()): void {
    this.db.prepare(
      "INSERT INTO project_poll_votes(pollId,voterId,optionId,votedAt) VALUES(?,?,?,?) " +
      "ON CONFLICT(pollId,voterId) DO UPDATE SET optionId=excluded.optionId, votedAt=excluded.votedAt",
    ).run(pollId, voterId, optionId, votedAt);
  }
  pollVotes(pollId: ID, options?: readonly ProjectPollOption[]): { optionId: ID; votes: number }[] {
    const rows = (this.db.prepare("SELECT optionId, COUNT(*) votes FROM project_poll_votes WHERE pollId=? GROUP BY optionId")
      .all(pollId) as { optionId: ID; votes: number }[]);
    const order = new Map((options ?? []).map((option, index) => [option.id, index]));
    return rows.sort((a, b) =>
      (order.get(a.optionId) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.optionId) ?? Number.MAX_SAFE_INTEGER)
      || a.optionId.localeCompare(b.optionId));
  }
  /** Full option tallies in option order, including zero-vote options. */
  pollResults(pollId: ID, options: readonly ProjectPollOption[]): { optionId: ID; votes: number }[] {
    const counted = new Map(this.pollVotes(pollId).map(r => [r.optionId, r.votes]));
    return options.map(option => ({ optionId: option.id, votes: counted.get(option.id) ?? 0 }));
  }
  projectPollRequest(ownerId: ID, requestId: ID): { projectId: ID; pollId: ID } | undefined {
    const row = this.db.prepare(
      "SELECT projectId, pollId FROM project_poll_requests WHERE ownerId=? AND requestId=?",
    ).get(ownerId, requestId) as { projectId: ID; pollId: ID } | undefined;
    return row;
  }
  saveProjectPollRequest(ownerId: ID, requestId: ID, projectId: ID, pollId: ID, createdAt = Date.now()): void {
    this.db.prepare(
      "INSERT INTO project_poll_requests(ownerId,requestId,projectId,pollId,createdAt) VALUES(?,?,?,?,?)",
    ).run(ownerId, requestId, projectId, pollId, createdAt);
  }
  pollVote(pollId: ID, voterId: ID): ID | undefined {
    const row = this.db.prepare("SELECT optionId FROM project_poll_votes WHERE pollId=? AND voterId=?")
      .get(pollId, voterId) as { optionId: ID } | undefined;
    return row?.optionId;
  }
  closeProjectPoll(id: ID, decision: ProjectPollDecision): ProjectPoll | undefined {
    const poll = this.projectPoll(id);
    if (!poll || poll.status === "closed") return poll;
    const closed = { ...poll, status: "closed" as const, decision };
    this.saveProjectPoll(closed);
    return closed;
  }
  /** Close every expired open poll and return the changed rows. */
  expireProjectPolls(now = Date.now()): ProjectPoll[] {
    const changed: ProjectPoll[] = [];
    for (const poll of this.projectPollsAllOpen()) {
      if (poll.deadlineAt !== undefined && poll.deadlineAt <= now) {
        const decision: ProjectPollDecision = {
          closedAt: now, closedBy: "system", reason: "deadline",
          results: this.pollResults(poll.id, poll.options),
        };
        const closed = this.closeProjectPoll(poll.id, decision);
        if (closed) changed.push(closed);
      }
    }
    return changed;
  }
  private projectPollsAllOpen(): ProjectPoll[] {
    return (this.db.prepare("SELECT json FROM project_polls WHERE status='open' ORDER BY deadlineAt ASC, id ASC").all() as { json: string }[])
      .map(r => JSON.parse(r.json) as ProjectPoll);
  }
  /** Persist a newly-created poll and its retry receipt atomically. */
  createProjectPoll(poll: ProjectPoll, ownerId: ID, requestId?: ID): void {
    this.tx(() => {
      this.saveProjectPoll(poll);
      if (requestId) this.saveProjectPollRequest(ownerId, requestId, poll.projectId, poll.id);
    });
  }
  /** The next persisted deadline, used to reschedule expiry after a restart. */
  nextProjectPollDeadline(): number | undefined {
    const row = this.db.prepare(
      "SELECT MIN(deadlineAt) deadline FROM project_polls WHERE status='open' AND deadlineAt IS NOT NULL",
    ).get() as { deadline: number | null };
    return row.deadline ?? undefined;
  }

  private deleteHuddleRows(projectId: ID): void {
    this.db.prepare("DELETE FROM huddle_ops WHERE targetId=?").run(projectId);
    const sessions = this.db.prepare("SELECT id FROM huddles WHERE projectId=?").all(projectId) as { id: ID }[];
    for (const { id } of sessions) {
      this.db.prepare("DELETE FROM huddle_notes WHERE sessionId=?").run(id);
      this.db.prepare("DELETE FROM huddle_members WHERE sessionId=?").run(id);
      this.db.prepare("DELETE FROM huddle_reads WHERE sessionId=?").run(id);
      this.db.prepare("DELETE FROM huddle_ops WHERE targetId=?").run(id);
    }
    this.db.prepare("DELETE FROM huddles WHERE projectId=?").run(projectId);
  }

  /**
   * Replace what we hold for one project with what the engine just found, as
   * ALL OF IT OR NONE OF IT.
   *
   * A re-sync is a replacement, not an append: a pull request that was merged
   * and closed on GitHub has to DISAPPEAR from our copy, and a merge that only
   * ever added rows would have left it on the list for ever. The cap is applied
   * here rather than trusted from the caller, and the newest survive.
   */
  syncProjectItems(projectId: ID, items: ProjectItem[]): ProjectItem[] {
    const keep = [...items]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, PROJECT_LIMITS.items);
    this.tx(() => {
      this.db.prepare("DELETE FROM project_items WHERE projectId=?").run(projectId);
      const insert = this.db.prepare(
        "INSERT INTO project_items(projectId,kind,number,updatedAt,json) VALUES(?,?,?,?,?)",
      );
      for (const i of keep) {
        insert.run(projectId, i.kind, i.number, i.updatedAt, JSON.stringify({ ...i, projectId }));
      }
    });
    return this.projectItems(projectId);
  }

  /** What we hold for one project, newest change first. */
  projectItems(projectId: ID): ProjectItem[] {
    return (this.db.prepare(
      "SELECT json FROM project_items WHERE projectId=? ORDER BY updatedAt DESC",
    ).all(projectId) as { json: string }[]).map(r => JSON.parse(r.json) as ProjectItem);
  }

  // ---- public project updates (immutable revisions; token-keyed public read) ----
  savePublicDraft(d: PublicUpdateDraft): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO public_updates(id, projectId, updatedAt, publicToken, json) VALUES(?,?,?,?,?)",
    ).run(d.id, d.projectId, d.updatedAt, d.publicToken ?? null, JSON.stringify(d));
  }
  publicDraft(id: ID): PublicUpdateDraft | undefined {
    const r = this.db.prepare("SELECT json FROM public_updates WHERE id=?").get(id) as { json: string } | undefined;
    return r ? JSON.parse(r.json) as PublicUpdateDraft : undefined;
  }
  publicDrafts(projectId?: ID): PublicUpdateDraft[] {
    const q = projectId
      ? this.db.prepare("SELECT json FROM public_updates WHERE projectId=? ORDER BY updatedAt DESC, id DESC")
      : this.db.prepare("SELECT json FROM public_updates ORDER BY updatedAt DESC, id DESC");
    const rows = (projectId ? q.all(projectId) : q.all()) as { json: string }[];
    return rows.map(r => JSON.parse(r.json) as PublicUpdateDraft);
  }
  savePublicRevision(r: PublicUpdateRevision): void {
    if (this.publicRevision(r.draftId, r.revision)) throw new Error("published revisions are immutable");
    this.db.prepare(
      "INSERT INTO public_revisions(id, draftId, revision, publishedAt, json) VALUES(?,?,?,?,?)",
    ).run(r.id, r.draftId, r.revision, r.publishedAt, JSON.stringify(r));
  }
  publicRevision(draftId: ID, revision: number): PublicUpdateRevision | undefined {
    const r = this.db.prepare(
      "SELECT json FROM public_revisions WHERE draftId=? AND revision=?",
    ).get(draftId, revision) as { json: string } | undefined;
    return r ? JSON.parse(r.json) as PublicUpdateRevision : undefined;
  }
  publicRevisions(draftId: ID): PublicUpdateRevision[] {
    return (this.db.prepare(
      "SELECT json FROM public_revisions WHERE draftId=? ORDER BY revision ASC",
    ).all(draftId) as { json: string }[]).map(r => JSON.parse(r.json) as PublicUpdateRevision);
  }
  savePublicAudit(a: PublicUpdateAudit): void {
    this.db.prepare("INSERT INTO public_audit(id, draftId, at, json) VALUES(?,?,?,?)")
      .run(a.id, a.draftId, a.at, JSON.stringify(a));
  }
  publicAudit(draftId: ID): PublicUpdateAudit[] {
    return (this.db.prepare(
      "SELECT json FROM public_audit WHERE draftId=? ORDER BY at ASC, id ASC",
    ).all(draftId) as { json: string }[]).map(r => JSON.parse(r.json) as PublicUpdateAudit);
  }
  /** Latest published revision for a live public token, or nothing. */
  publicByToken(token: string): PublicUpdateRevision | undefined {
    if (!token || typeof token !== "string") return undefined;
    const row = this.db.prepare(
      "SELECT json FROM public_updates WHERE publicToken=?",
    ).get(token) as { json: string } | undefined;
    if (!row) return undefined;
    const draft = JSON.parse(row.json) as PublicUpdateDraft;
    if (draft.state !== "published" || draft.revokedAt) return undefined;
    const revs = this.publicRevisions(draft.id);
    return revs.length ? revs[revs.length - 1] : undefined;
  }

  // ---- huddles: durable presence and chronological notes ----
  saveHuddle(s: HuddleSession): void { const p=this.project(s.projectId); if(!p||s.channelId!==p.channelId)throw new Error("huddle channel must match project channel"); this.db.prepare("INSERT OR REPLACE INTO huddles(id,projectId,startedAt,json) VALUES(?,?,?,?)").run(s.id,s.projectId,s.startedAt,JSON.stringify(s)); }
  huddle(id: ID): HuddleSession|undefined { const r=this.db.prepare("SELECT json FROM huddles WHERE id=?").get(id) as {json:string}|undefined; return r?JSON.parse(r.json) as HuddleSession:undefined; }
  huddles(projectId?: ID): HuddleSession[] { const q=projectId?this.db.prepare("SELECT json FROM huddles WHERE projectId=? ORDER BY startedAt DESC,id DESC"):this.db.prepare("SELECT json FROM huddles ORDER BY startedAt DESC,id DESC"); const rows=(projectId?q.all(projectId):q.all()) as {json:string}[]; return rows.map(r=>JSON.parse(r.json) as HuddleSession); }
  saveHuddleNote(n: HuddleNote, allowDeleted = false): void { const session=this.huddle(n.sessionId); if(session?.state==="ended" && !(allowDeleted && n.deletedAt))throw new Error("this huddle has ended"); const old=this.huddleNote(n.id); if(old?.deletedAt)n=old; this.db.prepare("INSERT OR REPLACE INTO huddle_notes(id,sessionId,createdAt,json) VALUES(?,?,?,?)").run(n.id,n.sessionId,n.createdAt,JSON.stringify(n)); }
  huddleNote(id: ID): HuddleNote|undefined { const r=this.db.prepare("SELECT json FROM huddle_notes WHERE id=?").get(id) as {json:string}|undefined; return r?JSON.parse(r.json) as HuddleNote:undefined; }
  huddleNotes(sessionId: ID): HuddleNote[] { return (this.db.prepare("SELECT json FROM huddle_notes WHERE sessionId=? ORDER BY createdAt ASC,id ASC").all(sessionId) as {json:string}[]).map(r=>JSON.parse(r.json) as HuddleNote); }
  huddleMembers(sessionId: ID): { userId: ID; joinedAt: number; leftAt?: number }[] { return (this.db.prepare("SELECT userId,joinedAt,leftAt FROM huddle_members WHERE sessionId=? ORDER BY joinedAt ASC,userId ASC").all(sessionId) as { userId: ID; joinedAt: number; leftAt: number | null }[]).map(r => ({ userId: r.userId, joinedAt: r.joinedAt, ...(r.leftAt === null ? {} : { leftAt: r.leftAt }) })); }
  huddleJoin(sessionId: ID,userId: ID,at=Date.now()): void { const active=this.db.prepare("SELECT 1 FROM huddle_members WHERE sessionId=? AND userId=? AND leftAt IS NULL LIMIT 1").get(sessionId,userId); if(active)return; this.db.prepare("INSERT INTO huddle_members(sessionId,userId,joinedAt,leftAt) VALUES(?,?,?,NULL)").run(sessionId,userId,at); }
  huddleLeave(sessionId: ID,userId: ID,at=Date.now()): void { this.db.prepare("UPDATE huddle_members SET leftAt=? WHERE sessionId=? AND userId=? AND leftAt IS NULL").run(at,sessionId,userId); }
  huddleRead(userId: ID,sessionId: ID): number { const r=this.db.prepare("SELECT lastReadAt FROM huddle_reads WHERE userId=? AND sessionId=?").get(userId,sessionId) as {lastReadAt:number}|undefined; return r?.lastReadAt??0; }
  huddleMarkRead(userId: ID,sessionId: ID,at: number): HuddleReadEntry { const next=Math.max(this.huddleRead(userId,sessionId),at); this.db.prepare("INSERT INTO huddle_reads(userId,sessionId,lastReadAt,updatedAt) VALUES(?,?,?,?) ON CONFLICT(userId,sessionId) DO UPDATE SET lastReadAt=excluded.lastReadAt,updatedAt=excluded.updatedAt").run(userId,sessionId,next,Date.now()); return {sessionId,lastReadAt:next,unread:this.huddleUnread(userId,sessionId)}; }
  huddleUnread(userId: ID,sessionId: ID): number { const since=this.huddleRead(userId,sessionId); const mine=new Set([userId,...this.agents().filter(a=>a.ownerId===userId).map(a=>a.id)]); return this.huddleNotes(sessionId).filter(n=>n.createdAt>since&&!n.deletedAt&&!mine.has(n.authorId)).length; }
  huddleRequestInfo(userId: ID, requestId: ID): { kind: string; targetId: ID; payloadHash: string; resultId: ID } | undefined {
    return this.db.prepare("SELECT kind,targetId,payloadHash,resultId FROM huddle_ops WHERE userId=? AND requestId=?")
      .get(userId, requestId) as { kind: string; targetId: ID; payloadHash: string; resultId: ID } | undefined;
  }
  huddleMutation<T>(work: () => T, receipt?: { userId: ID; requestId?: ID; kind: string; targetId: ID; payloadHash: string; resultId: ID }): T {
    return this.tx(() => {
      const out = work();
      if (receipt?.requestId) this.db.prepare("INSERT OR IGNORE INTO huddle_ops(userId,requestId,kind,targetId,payloadHash,resultId,createdAt) VALUES(?,?,?,?,?,?,?)")
        .run(receipt.userId, receipt.requestId, receipt.kind, receipt.targetId, receipt.payloadHash, receipt.resultId, Date.now());
      return out;
    });
  }

  // ---- internal project social feed ----

  /** The owner is always a member; additional members are soft-deleted rows. */
  socialIsMember(projectId: ID, userId: ID, ownerId?: ID): boolean {
    if (ownerId && ownerId === userId) return true;
    const row = this.db.prepare(
      "SELECT 1 FROM social_members WHERE projectId=? AND userId=? AND removedAt IS NULL",
    ).get(projectId, userId);
    return !!row;
  }

  socialMembers(projectId: ID, ownerId: ID): ID[] {
    const rows = this.db.prepare(
      "SELECT userId FROM social_members WHERE projectId=? AND removedAt IS NULL ORDER BY addedAt ASC, userId ASC",
    ).all(projectId) as { userId: string }[];
    const ids = rows.map(r => r.userId);
    if (!ids.includes(ownerId)) ids.unshift(ownerId);
    return ids;
  }

  addSocialMember(projectId: ID, userId: ID, at = Date.now()): void {
    this.db.prepare(
      "INSERT INTO social_members(projectId,userId,addedAt,removedAt) VALUES(?,?,?,NULL) " +
      "ON CONFLICT(projectId,userId) DO UPDATE SET addedAt=excluded.addedAt, removedAt=NULL",
    ).run(projectId, userId, at);
  }

  removeSocialMember(projectId: ID, userId: ID, at = Date.now()): void {
    this.db.prepare("UPDATE social_members SET removedAt=? WHERE projectId=? AND userId=?")
      .run(at, projectId, userId);
  }

  /** Durable receipt for one user's retried social operation. */
  socialOperation(userId: ID, requestId: ID, kind: string): { result: unknown; payloadHash: string; projectId?: ID } | undefined {
    const row = this.db.prepare(
      "SELECT resultJson,payloadHash,projectId FROM social_ops WHERE userId=? AND requestId=? AND kind=?",
    ).get(userId, requestId, kind) as { resultJson: string; payloadHash?: string; projectId?: string | null } | undefined;
    return row ? { result: JSON.parse(row.resultJson) as unknown, payloadHash: row.payloadHash ?? "", ...(row.projectId ? { projectId: row.projectId } : {}) } : undefined;
  }

  saveSocialOperation(userId: ID, requestId: ID, kind: string, result: unknown, payloadHash = "", projectId?: ID): void {
    this.db.prepare(
      "INSERT OR IGNORE INTO social_ops(userId,requestId,kind,projectId,payloadHash,resultJson,createdAt) VALUES(?,?,?,?,?,?,?)",
    ).run(userId, requestId, kind, projectId ?? null, payloadHash, JSON.stringify(result), Date.now());
  }

  /** Effect and its retry receipt commit together; a crash cannot create a ghost success. */
  socialMutation<T>(work: () => T): T { return this.tx(work); }

  saveSocialPost(post: SocialPost): void {
    const { reactions: _reactions, replyCount: _replyCount, ...stored } = post;
    void _reactions; void _replyCount;
    this.db.prepare(
      "INSERT OR REPLACE INTO social_posts(id,projectId,parentId,authorId,ownerId,authorKind,createdAt,deletedAt,json) " +
      "VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      stored.id, stored.projectId, stored.parentId ?? null, stored.authorId, stored.ownerId,
      stored.authorKind, stored.createdAt, stored.deletedAt ?? null, JSON.stringify(stored),
    );
  }

  socialPost(id: ID): SocialPost | undefined {
    const row = this.db.prepare("SELECT json FROM social_posts WHERE id=?").get(id) as
      { json: string } | undefined;
    if (!row) return undefined;
    const post = JSON.parse(row.json) as SocialPost;
    this.hydrateSocial([post]);
    return post;
  }

  socialPosts(
    projectId: ID,
    cursor: { before?: number; beforeId?: ID },
    limit: number = SOCIAL_LIMITS.feedPage,
  ): Page<SocialPost> {
    const size = Math.max(1, Math.min(limit, SOCIAL_LIMITS.feedPage));
    const before = cursor.before;
    let rows: { json: string }[];
    if (before === undefined) {
      rows = this.db.prepare(
        "SELECT json FROM social_posts WHERE projectId=? ORDER BY createdAt DESC, id DESC LIMIT ?",
      ).all(projectId, size + 1) as { json: string }[];
    } else {
      const beforeId = cursor.beforeId ?? AFTER_EVERY_ID;
      rows = this.db.prepare(
        "SELECT json FROM social_posts WHERE projectId=? AND (createdAt < ? OR (createdAt = ? AND id < ?)) " +
        "ORDER BY createdAt DESC, id DESC LIMIT ?",
      ).all(projectId, before, before, beforeId, size + 1) as { json: string }[];
    }
    const hasMore = rows.length > size;
    const page = (hasMore ? rows.slice(0, size) : rows)
      .map(row => JSON.parse(row.json) as SocialPost);
    const oldest = page[page.length - 1];
    const posts = page.reverse();
    this.hydrateSocial(posts);
    return {
      items: posts,
      hasMore,
      nextBefore: hasMore && oldest ? oldest.createdAt : undefined,
      nextBeforeId: hasMore && oldest ? oldest.id : undefined,
    };
  }

  private hydrateSocial(posts: SocialPost[]): SocialPost[] {
    if (posts.length === 0) return posts;
    const ids = posts.map(p => p.id);
    const slots = ids.map(() => "?").join(",");
    const reactions = this.db.prepare(
      `SELECT postId,emoji,actorId FROM social_reactions WHERE postId IN (${slots}) AND removedAt IS NULL ORDER BY postId,emoji,actorId`,
    ).all(...ids) as { postId: string; emoji: string; actorId: string }[];
    const grouped = new Map<ID, SocialReaction[]>();
    for (const row of reactions) {
      const list = grouped.get(row.postId) ?? [];
      const found = list.find(r => r.emoji === row.emoji);
      if (found) found.actorIds.push(row.actorId);
      else list.push({ emoji: row.emoji, actorIds: [row.actorId] });
      grouped.set(row.postId, list);
    }
    const counts = this.db.prepare(
      `SELECT parentId,COUNT(*) AS count FROM social_posts WHERE parentId IN (${slots}) GROUP BY parentId`,
    ).all(...ids) as { parentId: string; count: number }[];
    const replies = new Map(counts.map(row => [row.parentId, Number(row.count)]));
    for (const post of posts) {
      const rs = grouped.get(post.id);
      if (!post.deletedAt && rs?.length) post.reactions = rs;
      else delete post.reactions;
      const count = replies.get(post.id) ?? 0;
      if (count) post.replyCount = count;
      else delete post.replyCount;
    }
    return posts;
  }

  socialUnread(userId: ID, projectId: ID): SocialReadEntry {
    const row = this.db.prepare(
      "SELECT lastReadAt FROM social_reads WHERE userId=? AND projectId=?",
    ).get(userId, projectId) as { lastReadAt: number } | undefined;
    const lastReadAt = row?.lastReadAt ?? 0;
    const count = this.db.prepare(
      "SELECT COUNT(*) AS count FROM social_posts WHERE projectId=? AND createdAt>? AND ownerId<>? AND deletedAt IS NULL",
    ).get(projectId, lastReadAt, userId) as { count: number };
    return { projectId, lastReadAt, unread: Number(count.count) };
  }

  markSocialRead(userId: ID, projectId: ID, at: number): SocialReadEntry {
    const now = Date.now();
    this.db.prepare(
      "INSERT INTO social_reads(userId,projectId,lastReadAt,updatedAt) VALUES(?,?,?,?) " +
      "ON CONFLICT(userId,projectId) DO UPDATE SET lastReadAt=MAX(lastReadAt,excluded.lastReadAt), updatedAt=excluded.updatedAt",
    ).run(userId, projectId, at, now);
    return this.socialUnread(userId, projectId);
  }

  setSocialReaction(projectId: ID, postId: ID, actorId: ID, emoji: string, on: boolean): ID[] {
    const now = Date.now();
    if (on) {
      this.db.prepare(
        "INSERT INTO social_reactions(projectId,postId,actorId,emoji,ts,removedAt) VALUES(?,?,?,?,?,NULL) " +
        "ON CONFLICT(postId,actorId,emoji) DO UPDATE SET projectId=excluded.projectId, ts=excluded.ts, removedAt=NULL",
      ).run(projectId, postId, actorId, emoji, now);
    } else {
      this.db.prepare(
        "UPDATE social_reactions SET removedAt=? WHERE postId=? AND actorId=? AND emoji=? AND removedAt IS NULL",
      ).run(now, postId, actorId, emoji);
    }
    return (this.db.prepare(
      "SELECT actorId FROM social_reactions WHERE postId=? AND emoji=? AND removedAt IS NULL ORDER BY actorId",
    ).all(postId, emoji) as { actorId: string }[]).map(r => r.actorId);
  }

  /** Every connected project, for authorization-filtered features such as Pulse. */
  projects(): Project[] {
    return (this.db.prepare("SELECT json FROM projects ORDER BY createdAt DESC")
      .all() as { json: string }[]).map(r => JSON.parse(r.json) as Project);
  }

  // ---- Engineering Pulse: durable project-scoped daily updates ----

  pulseMutationHash(kind: PulseMutationKind, payload: unknown): string {
    return createHash("sha256").update(JSON.stringify([kind, payload])).digest("hex");
  }

  private pulseReceipt(userId: ID, requestId: ID): PulseMutationReceipt | undefined {
    const row = this.db.prepare(
      "SELECT userId,requestId,kind,payloadHash,updateId,projectId,createdAt FROM pulse_mutation_receipts WHERE userId=? AND requestId=?",
    ).get(userId, requestId) as PulseMutationReceipt | undefined;
    if (row && row.createdAt < Date.now() - 30 * 24 * 60 * 60 * 1000) {
      this.db.prepare("DELETE FROM pulse_mutation_receipts WHERE userId=? AND requestId=?").run(userId, requestId);
      return undefined;
    }
    return row;
  }

  pulseMutationStatus(userId: ID, requestId: ID, kind: PulseMutationKind, payloadHash: string):
    { status: "replay" | "conflict"; updateId: ID } | undefined {
    const prior = this.pulseReceipt(userId, requestId);
    if (!prior) return undefined;
    return prior.kind === kind && prior.payloadHash === payloadHash
      ? { status: "replay", updateId: prior.updateId }
      : { status: "conflict", updateId: prior.updateId };
  }

  /** Save an update and its retry receipt in one transaction. */
  savePulseMutation(userId: ID, requestId: ID, kind: PulseMutationKind,
    payloadHash: string, update: EngineeringPulseUpdate): EngineeringPulseUpdate {
    return this.tx(() => {
      const prior = this.pulseReceipt(userId, requestId);
      if (prior) {
        if (prior.kind !== kind || prior.payloadHash !== payloadHash) {
          throw new Error("that Pulse request id was already used for a different update");
        }
        return this.pulse(prior.updateId) ?? update;
      }
      this.savePulse(update);
      const now = Date.now();
      this.db.prepare(
        "INSERT INTO pulse_mutation_receipts(userId,requestId,kind,payloadHash,updateId,projectId,createdAt) VALUES(?,?,?,?,?,?,?)",
      ).run(userId, requestId, kind, payloadHash, update.id, update.projectId, now);
      this.db.prepare("DELETE FROM pulse_mutation_receipts WHERE createdAt < ?")
        .run(now - 30 * 24 * 60 * 60 * 1000);
      this.db.prepare(
        "DELETE FROM pulse_mutation_receipts WHERE userId=? AND requestId NOT IN "
        + "(SELECT requestId FROM pulse_mutation_receipts WHERE userId=? ORDER BY createdAt DESC,requestId DESC LIMIT 512)",
      ).run(userId, userId);
      return update;
    });
  }

  savePulse(update: EngineeringPulseUpdate): void {
    // Delete is a moderation control: never keep section bodies or related
    // links once deletedAt is set. The tombstone row stays for the feed.
    const stored = redactDeletedPulseUpdate(update);
    this.db.prepare(
      "INSERT INTO pulse_updates(id,projectId,authorId,createdAt,updatedAt,deletedAt,json) " +
      "VALUES(?,?,?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET projectId=excluded.projectId, authorId=excluded.authorId, " +
      "createdAt=excluded.createdAt, updatedAt=excluded.updatedAt, deletedAt=excluded.deletedAt, json=excluded.json",
    ).run(
      stored.id, stored.projectId, stored.authorId, stored.createdAt, stored.updatedAt,
      stored.deletedAt ?? null, JSON.stringify(stored),
    );
    this.prunePulse(stored.projectId);
  }

  pulse(id: ID): EngineeringPulseUpdate | undefined {
    const row = this.db.prepare("SELECT json FROM pulse_updates WHERE id=?").get(id) as
      { json: string } | undefined;
    // Re-redact on read so older pre-fix rows cannot ship deleted content.
    return row ? redactDeletedPulseUpdate(JSON.parse(row.json) as EngineeringPulseUpdate) : undefined;
  }

  /** Newest first; tombstones remain so deletion is visible in the feed. */
  pulses(projectId?: ID, limit = 500): EngineeringPulseUpdate[] {
    const rows = projectId
      ? this.db.prepare("SELECT json FROM pulse_updates WHERE projectId=? ORDER BY createdAt DESC,id DESC LIMIT ?")
        .all(projectId, Math.max(1, Math.min(limit, 500)))
      : this.db.prepare("SELECT json FROM pulse_updates ORDER BY createdAt DESC,id DESC LIMIT ?")
        .all(Math.max(1, Math.min(limit, 500)));
    return (rows as { json: string }[]).map(r =>
      redactDeletedPulseUpdate(JSON.parse(r.json) as EngineeringPulseUpdate));
  }

  private prunePulse(projectId: ID): void {
    this.db.prepare(
      "DELETE FROM pulse_updates WHERE projectId=? AND id NOT IN " +
      "(SELECT id FROM pulse_updates WHERE projectId=? ORDER BY createdAt DESC,id DESC LIMIT ?)",
    ).run(projectId, projectId, 500);
  }

  pulseReadAt(userId: ID, projectId: ID): number {
    const row = this.db.prepare("SELECT lastReadAt FROM pulse_reads WHERE userId=? AND projectId=?")
      .get(userId, projectId) as { lastReadAt: number } | undefined;
    return row?.lastReadAt ?? 0;
  }

  markPulseRead(userId: ID, projectId: ID, at: number): void {
    const now = Date.now();
    this.db.prepare(
      "INSERT INTO pulse_reads(userId,projectId,lastReadAt,updatedAt) VALUES(?,?,?,?) " +
      "ON CONFLICT(userId,projectId) DO UPDATE SET lastReadAt=MAX(lastReadAt,excluded.lastReadAt), updatedAt=excluded.updatedAt",
    ).run(userId, projectId, Math.min(Math.max(0, Math.floor(at)), now), now);
  }

  pulseUnread(userId: ID, projectId: ID): number {
    return (this.db.prepare(
      "SELECT COUNT(*) n FROM pulse_updates WHERE projectId=? AND deletedAt IS NULL " +
      "AND createdAt>? AND authorId<>?",
    ).get(projectId, this.pulseReadAt(userId, projectId), userId) as { n: number }).n;
  }

  pulseUnreadByProject(userId: ID, projectIds: ID[]): Record<ID, number> {
    const out: Record<ID, number> = {};
    for (const projectId of projectIds) out[projectId] = this.pulseUnread(userId, projectId);
    return out;
  }

  /**
   * Append one line to the trail — and to the CHAIN.
   *
   * Every row carries the previous row's hash, so the trail can be checked
   * later (`verifyActivity`) and a removed or rewritten line shows up. Appending
   * is the only operation: nothing in this file updates or deletes an activity
   * row once it is written.
   */
  logActivity(rec: Omit<ActivityRecord, "id" | "ts" | "seq" | "hash" | "prevHash">): ActivityRecord {
    const seq = ((this.db.prepare("SELECT MAX(seq) m FROM activity").get() as { m: number | null }).m ?? 0) + 1;
    const prevHash = seq > 1 ? this.lastActivityHash() : "";
    const full: ActivityRecord = {
      ...rec, id: newId("act"), ts: Date.now(), seq, prevHash, hash: "",
    };
    full.hash = activityHash(full);
    this.db.prepare("INSERT INTO activity(id,ts,json,seq,hash,prevHash) VALUES(?,?,?,?,?,?)")
      .run(full.id, full.ts, JSON.stringify(full), seq, full.hash, prevHash);
    return full;
  }

  /**
   * Walk the whole trail and say whether it still hangs together.
   *
   * Returns the first thing wrong — a gap in the numbering, a row whose hash no
   * longer matches its own contents, or a row whose `prevHash` doesn't match
   * the row before it — or null when the chain is intact.
   */
  verifyActivity(): { seq: number; problem: string } | null {
    const rows = this.db.prepare("SELECT json FROM activity ORDER BY seq ASC").all() as { json: string }[];
    let expected = 1;
    let prevHash = "";
    let prevTs = 0;
    for (const r of rows) {
      const rec = JSON.parse(r.json) as ActivityRecord;
      // TIME MUST NOT RUN BACKWARDS. The chain proved the ORDER of the lines
      // and that none had been edited, but it said nothing about their clocks —
      // so a line dated before the one it follows verified perfectly. That is
      // exactly the shape of a back-dated entry, and it is now the first thing
      // a reader would have asked about.
      if (typeof rec.ts === "number" && rec.ts < prevTs) {
        return { seq: rec.seq ?? expected, problem: "this line is dated before the one before it" };
      }
      if (rec.seq !== expected) {
        return { seq: expected, problem: `the trail jumps from ${expected - 1} to ${rec.seq}` };
      }
      if (rec.prevHash !== prevHash) {
        return { seq: expected, problem: "this line doesn't follow on from the one before it" };
      }
      if (rec.hash !== activityHash(rec)) {
        return { seq: expected, problem: "this line has been changed since it was written" };
      }
      prevHash = rec.hash!;
      prevTs = typeof rec.ts === "number" ? rec.ts : prevTs;
      expected += 1;
    }
    return null;
  }
  activity(before: number, limit: number): ActivityRecord[] {
    return (this.db.prepare("SELECT json FROM activity WHERE ts<? ORDER BY ts DESC LIMIT ?")
      .all(before, limit) as { json: string }[])
      .map(r => JSON.parse(r.json) as ActivityRecord).reverse();
  }

  // ---- runs: what an agent actually did ----

  /**
   * Write one run.
   *
   * `ownerId` and `channelId` are handed in by the caller from what it worked
   * out about the AGENT and the CONVERSATION, not read out of the record — this
   * function will not go looking, so there is no way for a record to nominate
   * who may read it.
   *
   * Storing is followed immediately by pruning, in the same call, so "bounded"
   * is a property of the only way to write a run rather than something a caller
   * has to remember.
   */
  saveRun(row: RunRow): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO runs(id,agentId,ownerId,channelId,taskId,startedAt,json) VALUES(?,?,?,?,?,?,?)",
    ).run(
      row.record.id, row.agentId, row.ownerId,
      row.channelId ?? null, row.taskId ?? null,
      row.record.startedAt, JSON.stringify(row.record),
    );
    this.pruneRuns(row.agentId);
  }

  run(id: ID): RunRow | undefined {
    const raw = this.db.prepare(
      "SELECT id,agentId,ownerId,channelId,taskId,startedAt,json FROM runs WHERE id=?",
    ).get(id) as RawRun | undefined;
    return raw ? toRun(raw) : undefined;
  }

  /** One agent's runs, newest first. */
  runsForAgent(agentId: ID, limit: number = RUN_RETENTION.listDefault): RunRow[] {
    return (this.db.prepare(
      "SELECT id,agentId,ownerId,channelId,taskId,startedAt,json FROM runs " +
      "WHERE agentId=? ORDER BY startedAt DESC, id DESC LIMIT ?",
    ).all(agentId, cap(limit)) as unknown as RawRun[]).map(toRun);
  }

  /** Every run recorded against one delegated job, newest first. */
  runsForTask(taskId: ID, limit: number = RUN_RETENTION.listDefault): RunRow[] {
    return (this.db.prepare(
      "SELECT id,agentId,ownerId,channelId,taskId,startedAt,json FROM runs " +
      "WHERE taskId=? ORDER BY startedAt DESC, id DESC LIMIT ?",
    ).all(taskId, cap(limit)) as unknown as RawRun[]).map(toRun);
  }

  /**
   * Keep only the newest `RUN_RETENTION.perAgent` runs for an agent.
   *
   * The same promise the engine makes on disk, kept here too: a record that is
   * bounded on the machine that wrote it and unbounded on the machine that
   * shares it is not bounded at all. Returns how many were removed.
   */
  pruneRuns(agentId: ID, keep: number = RUN_RETENTION.perAgent): number {
    const overflow = (this.db.prepare(
      "SELECT id, taskId FROM runs WHERE agentId=? ORDER BY startedAt DESC, id DESC LIMIT -1 OFFSET ?",
    ).all(agentId, Math.max(0, keep)) as { id: string; taskId: string | null }[]);
    // A JOB'S OWN RECORD IS NOT THE AGENT'S SPARE CAPACITY. A busy agent used
    // to push every older run out, including the ones that were the whole
    // answer to "what did this delegated job actually do" — so opening a task
    // from last week showed nothing, which is the one thing the feature exists
    // for. A run attached to a task is kept while it is among that TASK's
    // newest, whatever its agent has been doing since.
    const keptForTask = new Set<string>();
    for (const taskId of new Set(overflow.map(r => r.taskId).filter((t): t is string => !!t))) {
      for (const r of this.db.prepare(
        "SELECT id FROM runs WHERE taskId=? ORDER BY startedAt DESC, id DESC LIMIT ?",
      ).all(taskId, RUN_RETENTION.perTask) as { id: string }[]) keptForTask.add(r.id);
    }
    const doomed = overflow.filter(r => !keptForTask.has(r.id)).map(r => r.id);
    for (const id of doomed) this.db.prepare("DELETE FROM runs WHERE id=?").run(id);
    return doomed.length;
  }

  /** Forget everything recorded about one agent — used when the agent is deleted. */
  forgetRuns(agentId: ID): void {
    this.db.prepare("DELETE FROM runs WHERE agentId=?").run(agentId);
  }

  /** Every invite ever minted, newest state — for tests and future admin UI. */
  invites(): InviteRow[] {
    return (this.db.prepare("SELECT code,createdBy,usedBy,usedAt,revoked FROM invites")
      .all() as unknown as RawInvite[]).map(toInvite);
  }

  // ---- push (stub until APNs) ----
  logPush(userId: ID, messageId: ID): void {
    this.db.prepare("INSERT INTO pushlog(id,userId,messageId,ts) VALUES(?,?,?,?)")
      .run(newId("push"), userId, messageId, Date.now());
  }

  // ---- Engineering Canvas ----
  saveCanvas(canvas: EngineeringCanvas): void {
    this.db.prepare(
      "INSERT INTO engineering_canvases(id,projectId,ownerId,title,revision,createdAt,updatedAt,deletedAt,json) VALUES(?,?,?,?,?,?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET title=excluded.title, revision=excluded.revision, updatedAt=excluded.updatedAt, deletedAt=excluded.deletedAt, json=excluded.json",
    ).run(canvas.id, canvas.projectId, canvas.ownerId, canvas.title, canvas.revision,
      canvas.createdAt, canvas.updatedAt, canvas.deletedAt ?? null, JSON.stringify(canvas));
  }
  /** Snapshot and immutable revision are one SQLite transaction. */
  saveCanvasChange(canvas: EngineeringCanvas, revision: EngineeringCanvasRevision,
    request?: { ownerId: ID; requestId: ID; action: string; target: ID; payload: string }): void {
    this.tx(() => {
      this.saveCanvas(canvas);
      this.db.prepare("INSERT INTO engineering_canvas_revisions(canvasId,revision,changedAt,changedBy,summary,json) VALUES(?,?,?,?,?,?)")
        .run(revision.canvasId, revision.revision, revision.changedAt, revision.changedBy, revision.summary, JSON.stringify(revision));
      this.db.prepare(
        "DELETE FROM engineering_canvas_revisions WHERE canvasId=? AND revision NOT IN " +
        "(SELECT revision FROM engineering_canvas_revisions WHERE canvasId=? ORDER BY revision DESC LIMIT ?)",
      ).run(revision.canvasId, revision.canvasId, CANVAS_LIMITS.history);
      if (request) this.saveCanvasRequest(request.ownerId, request.requestId, canvas.id, request.action, request.target, request.payload);
    });
  }
  canvas(id: ID): EngineeringCanvas | undefined {
    const row = this.db.prepare("SELECT json FROM engineering_canvases WHERE id=?").get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as EngineeringCanvas) : undefined;
  }
  canvasesForProject(projectId: ID): EngineeringCanvas[] {
    return (this.db.prepare("SELECT json FROM engineering_canvases WHERE projectId=? AND deletedAt IS NULL ORDER BY updatedAt DESC, id DESC")
      .all(projectId) as { json: string }[]).map(r => JSON.parse(r.json) as EngineeringCanvas);
  }
  canvasCount(projectId: ID): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM engineering_canvases WHERE projectId=? AND deletedAt IS NULL").get(projectId) as { n: number }).n;
  }
  saveCanvasRevision(revision: EngineeringCanvasRevision): void {
    this.tx(() => {
      this.db.prepare("INSERT INTO engineering_canvas_revisions(canvasId,revision,changedAt,changedBy,summary,json) VALUES(?,?,?,?,?,?)")
        .run(revision.canvasId, revision.revision, revision.changedAt, revision.changedBy, revision.summary, JSON.stringify(revision));
      this.db.prepare(
        "DELETE FROM engineering_canvas_revisions WHERE canvasId=? AND revision NOT IN " +
        "(SELECT revision FROM engineering_canvas_revisions WHERE canvasId=? ORDER BY revision DESC LIMIT ?)",
      ).run(revision.canvasId, revision.canvasId, CANVAS_LIMITS.history);
    });
  }
  canvasRequest(ownerId: ID, requestId: ID): { canvasId: ID; action: string; target: ID; payload: string } | undefined {
    const row = this.db.prepare("SELECT canvasId,action,target,payload FROM engineering_canvas_requests WHERE ownerId=? AND requestId=?")
      .get(ownerId, requestId) as { canvasId: ID; action: string; target: ID; payload: string } | undefined;
    return row;
  }
  saveCanvasRequest(ownerId: ID, requestId: ID, canvasId: ID, action: string, target: ID, payload: string): void {
    const now = Date.now();
    this.db.prepare("INSERT INTO engineering_canvas_requests(ownerId,requestId,canvasId,action,target,payload,createdAt) VALUES(?,?,?,?,?,?,?)")
      .run(ownerId, requestId, canvasId, action, target, payload, now);
    this.db.prepare("DELETE FROM engineering_canvas_requests WHERE createdAt < ?").run(now - 30 * 24 * 60 * 60 * 1000);
    this.db.prepare(
      "DELETE FROM engineering_canvas_requests WHERE ownerId=? AND requestId NOT IN "
      + "(SELECT requestId FROM engineering_canvas_requests WHERE ownerId=? ORDER BY createdAt DESC,requestId DESC LIMIT 512)",
    ).run(ownerId, ownerId);
  }
  canvasRevisions(canvasId: ID, limit: number = CANVAS_LIMITS.history): EngineeringCanvasRevision[] {
    return (this.db.prepare("SELECT json FROM engineering_canvas_revisions WHERE canvasId=? ORDER BY revision DESC LIMIT ?")
      .all(canvasId, Math.max(1, Math.min(limit, CANVAS_LIMITS.history))) as { json: string }[])
      .map(r => JSON.parse(r.json) as EngineeringCanvasRevision);
  }
  canvasRead(canvasId: ID, userId: ID): number {
    const row = this.db.prepare("SELECT revision FROM engineering_canvas_reads WHERE canvasId=? AND userId=?")
      .get(canvasId, userId) as { revision: number } | undefined;
    return row?.revision ?? 0;
  }
  markCanvasRead(canvasId: ID, userId: ID, revision: number): void {
    this.db.prepare("INSERT INTO engineering_canvas_reads(canvasId,userId,revision,updatedAt) VALUES(?,?,?,?) " +
      "ON CONFLICT(canvasId,userId) DO UPDATE SET revision=MAX(revision,excluded.revision), updatedAt=excluded.updatedAt")
      .run(canvasId, userId, revision, Date.now());
  }
}

/**
 * Sorts after every message id we mint, so "before this moment, whichever
 * message" and "before this exact message" can share one query.
 */
const AFTER_EVERY_ID = "\uffff";
/** Same wide in-flight margin as wholefile pending writes. */
export const ARTIFACT_STAGE_GRACE_MS = 60_000;

/**
 * The shape this build expects. Bumped whenever the tables change, and read by
 * `migrate()` so the next change is a step and not a hand repair.
 * 1 = before the chat basics. 2 = reactions, attachments, read state, ledger.
 * 3 = membership as rows, and rooms that can carry a topic and be archived.
 * 4 = run records — what an agent actually did, turn by turn.
 * 5 = a membership row per spell in a room, so a rejoin cannot overwrite a
 *     first arrival.
 * 6 = artifact chain access, exact-version links, and immutable version keys.
 * 7 = saved workflow runbooks (owned by the Workflow delivery slice).
 * 8 = Saved/Later durable message queue.
 * 9 = Engineering Pulse project updates.
 * 10 = Project forums / decision threads (membership, topics, replies, receipts).
 * 11 = Engineering Canvas documents and revisions.
 * 12 = shared non-DM channel pins and bounded mutation receipts.
 * 13 = durable channel/thread composer drafts and retry receipts.
 */
export const SCHEMA_VERSION = 14;

/**
 * The fingerprint of one line of the trail.
 *
 * Deliberately NOT `JSON.stringify(record)`: key order in JSON is an accident of
 * how the object was built, so hashing it would make the same row hash
 * differently on two runs. The fields are listed here, in this order, and
 * JSON-encoded as an ARRAY so no value can be run into the next one — glueing
 * them together with a separator that could itself appear in a name or a
 * sentence would let two different rows share a fingerprint.
 */
export function activityHash(rec: ActivityRecord): string {
  const parts = [
    rec.prevHash ?? "", rec.seq ?? 0, rec.id, rec.ts,
    rec.actorKind, rec.actorId, rec.actorName, rec.kind, rec.refId ?? "", rec.detail,
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * The fields the relay ADDS when it hands a message out. They are answers, not
 * data, and they never go back into the row they were computed from.
 */
function stripHydrated(m: Message): Message {
  // `reactions` is the only computed field. `replyCount` and `lastReplyAt` are
  // deliberately NOT stripped: they are a cache kept ON the row so a channel
  // list can say "12 replies" without walking the conversation.
  const { reactions: _r, ...row } = m;
  return row;
}

/**
 * Turn whatever a person typed into search words.
 *
 * A raw query can never reach FTS5: its MATCH syntax has operators (`NEAR`,
 * `*`, `"`, `:`, `-`) and a stray one is either a crash or a query that means
 * something the person did not ask for. So the text is broken into plain words
 * and each is re-quoted by the caller. This is the same law as everywhere else
 * in this codebase: build the safe thing, never sanitise the dangerous one.
 */
export function searchTerms(query: string): string[] {
  if (typeof query !== "string") return [];
  return query
    .slice(0, MESSAGE_LIMITS.queryMax)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(w => w.length > 0)
    .slice(0, 10);
}

/**
 * The ONE place a MATCH string is built, for every search there is.
 *
 * `searchTerms` above has already thrown away everything that is not a letter
 * or a digit, so no operator can survive into here; this function exists so
 * that the second half of the rule — quote every word, prefix-match the last —
 * also has exactly one owner. Two searches building their own MATCH strings is
 * how one of them eventually forgets the quotes and hands a person's typing to
 * FTS5 as syntax.
 */
export function ftsMatch(terms: string[]): string {
  return terms.map(t => `"${t}"`).join(" ") + "*";
}

/** A snippet for the no-FTS5 fallback: the words in their surroundings. */
function plainSnippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = lower.indexOf(t.toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, 140);
  const from = Math.max(0, at - 40);
  return (from > 0 ? "…" : "") + text.slice(from, from + 140) + (from + 140 < text.length ? "…" : "");
}
