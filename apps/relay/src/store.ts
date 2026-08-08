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
  MessageReaction, MESSAGE_LIMITS, ARTIFACT_LIMITS, Project, ProjectItem, PROJECT_LIMITS,
  RunRecord, RUN_RETENTION, Task, User, StoredHook, isSafeStoredId, nameKey, newId,
  NOTIFICATION_INBOX_LIMITS,
  type NotificationInboxKind, type NotificationInboxState,
  Workflow, WorkflowRun, validateArtifactLinks, validateWorkflow,
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

export type SavedMutationKind = "saveMessage" | "unsaveMessage";

const SAVED_RECEIPT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
        lastReadTs INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
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
    `);
      this.migrate();
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

    // The one thing that still says a person can only be in a room once at a
    // time, now that the primary key no longer does. It lives here, below the
    // step that reshapes the table, for the same reason act_seq does.
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS cm_live ON channel_members(channelId,memberId) WHERE removedAt IS NULL",
    );
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
    this.tx(() => {
      this.db.prepare("DELETE FROM saved_mutation_receipts WHERE userId=?").run(id);
      this.db.prepare("DELETE FROM saved_messages WHERE userId=?").run(id);
      this.db.prepare("DELETE FROM hook_requests WHERE ownerId=?").run(id);
      this.db.prepare("DELETE FROM hook_audit WHERE ownerId=?").run(id);
      this.db.prepare("DELETE FROM hooks WHERE ownerId=?").run(id);
    });
    this.db.prepare("DELETE FROM tokens WHERE userId=?").run(id);
    this.db.prepare("UPDATE invites SET revoked=1 WHERE usedBy=? OR createdBy=?").run(id, id);
    this.db.prepare("DELETE FROM users WHERE id=?").run(id);
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

  message(id: ID): Message | undefined {
    const row = this.db.prepare("SELECT json FROM messages WHERE id=?").get(id) as
      { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Message) : undefined;
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
  bumpReplyCount(rootId: ID, at: number): Message | undefined {
    const root = this.message(rootId);
    if (!root) return undefined;
    root.replyCount = (root.replyCount ?? 0) + 1;
    root.lastReplyAt = at;
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

  /** Forget a message's files (used by delete) and say which bytes to remove. */
  releaseAttachments(messageId: ID): Attachment[] {
    const rows = this.db.prepare("SELECT json FROM attachments WHERE messageId=?")
      .all(messageId) as { json: string }[];
    this.db.prepare("DELETE FROM attachments WHERE messageId=?").run(messageId);
    return rows.map(r => JSON.parse(r.json) as Attachment);
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
  markRead(userId: ID, channelId: ID, ts: number): number {
    const now = Date.now();
    const current = this.lastRead(userId, channelId);
    // Read state only ever moves FORWARD. A client that reconnects and replays
    // an old position must not un-read what another machine already read.
    const next = Math.max(current, ts);
    this.db.prepare(
      "INSERT INTO reads(userId,channelId,lastReadTs,updatedAt) VALUES(?,?,?,?) " +
      "ON CONFLICT(userId,channelId) DO UPDATE SET lastReadTs=excluded.lastReadTs, updatedAt=excluded.updatedAt",
    ).run(userId, channelId, next, now);
    return next;
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
    const since = this.lastRead(userId, channelId);
    const rows = this.db
      .prepare("SELECT json FROM messages WHERE channelId=? AND ts>? ORDER BY ts ASC")
      .all(channelId, since) as { json: string }[];
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
    this.db.prepare("DELETE FROM project_items WHERE projectId=?").run(id);
    this.db.prepare("DELETE FROM projects WHERE id=?").run(id);
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
 * 7 = Workflow definitions and durable workflow runs (owned by the Workflow
 *     migration on the coordinated master).
 * 8 = per-user saved-message rows, with source access rechecked on read.
 */
export const SCHEMA_VERSION = 8;

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
