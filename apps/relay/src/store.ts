// Relay persistence on node:sqlite (built into Node 22+, no native build).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ActivityRecord, AgentDef, Approval, Artifact, ArtifactVersion, Attachment, Channel, ChannelMember,
  ChannelRole, ID, Message,
  MessageReaction, MESSAGE_LIMITS, Project, ProjectItem, PROJECT_LIMITS,
  RunRecord, RUN_RETENTION, Task, User, nameKey, newId,
} from "@cloud9/shared";
// THE ONE OWNER of "write a file this app will later believe" — write next
// door, flush it down to the disk, rename it into place. It lives in the engine
// because that is where it was first needed; the hub uses the same one rather
// than keeping a second copy, because two copies of a rule is how one of them
// quietly stops being true.
import { sweepPending, writeWholeFile } from "@cloud9/engine";
import { secureId, secureToken } from "./secureid.js";

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

interface RawRun {
  id: string; agentId: string; ownerId: string;
  channelId: string | null; taskId: string | null; startedAt: number; json: string;
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

export class Store {
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

  private readonly ownerToken?: string;

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

  private initSearch(): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          text, messageId UNINDEXED, channelId UNINDEXED
        );
      `);
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
    const want = (this.db.prepare(
      "SELECT COUNT(*) n FROM messages WHERE json_extract(json,'$.deletedAt') IS NULL",
    ).get() as { n: number }).n;
    const have = (this.db.prepare("SELECT COUNT(*) n FROM messages_fts").get() as { n: number }).n;
    if (have === want) return;
    this.tx(() => {
      this.db.exec("DELETE FROM messages_fts");
      const rows = this.db.prepare("SELECT id,channelId,json FROM messages").all() as
        { id: string; channelId: string; json: string }[];
      for (const r of rows) {
        const m = this.safeParse<Message>(r.json, "a message", r.id);
        if (!m || m.deletedAt) continue;
        this.indexMessage(m);
      }
    });
  }

  /** True when every message that should be findable is in the index. */
  searchIndexComplete(): boolean {
    if (!this.searchIndexed) return false;
    const want = (this.db.prepare(
      "SELECT COUNT(*) n FROM messages WHERE json_extract(json,'$.deletedAt') IS NULL",
    ).get() as { n: number }).n;
    const have = (this.db.prepare("SELECT COUNT(*) n FROM messages_fts").get() as { n: number }).n;
    return have === want;
  }

  private indexMessage(m: Message): void {
    if (!this.searchIndexed) return;
    this.db.prepare("DELETE FROM messages_fts WHERE messageId=?").run(m.id);
    if (m.deletedAt) return;
    this.db.prepare("INSERT INTO messages_fts(text,messageId,channelId) VALUES(?,?,?)")
      .run(m.text, m.id, m.channelId);
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
    this.db.prepare(
      "INSERT INTO meta(key,value) VALUES('schemaVersion',?) " +
      "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(String(v));
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

  /** Take someone out — softly, so the record still knows they were here. */
  removeChannelMember(channelId: ID, memberId: ID, by?: ID): void {
    this.db.prepare(
      "UPDATE channel_members SET removedAt=?, removedBy=? WHERE channelId=? AND memberId=? AND removedAt IS NULL",
    ).run(Date.now(), by ?? null, channelId, memberId);
    this.mirrorMemberIds(channelId);
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
      const match = terms.map(t => `"${t}"`).join(" ") + "*";
      hits = this.db.prepare(
        `SELECT m.json AS json, snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet
         FROM messages_fts f JOIN messages m ON m.id = f.messageId
         WHERE messages_fts MATCH ? AND f.channelId IN (${slots})${aliveSql}${authorSql}
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

  /** Put one version's bytes on disk. Throws when they did not land. */
  writeArtifactBytes(versionId: ID, safeName: string, bytes: Buffer): string {
    fs.mkdirSync(this.artifactsDir, { recursive: true });
    const storedAs = `${versionId}-${path.basename(safeName)}`;
    let why = "";
    const ok = writeWholeFile(path.join(this.artifactsDir, storedAs), bytes, m => { why = m; });
    if (!ok) {
      console.error(`[hub] could not store an artifact: ${why}`);
      throw new Error(
        "that file could not be saved on this computer — check there is free disk space " +
        "and try again");
    }
    return storedAs;
  }

  /** Remove one version's bytes. Missing is not an error. */
  removeArtifactBytes(storedAs: string): void {
    try { fs.rmSync(path.join(this.artifactsDir, path.basename(storedAs))); } catch { /* already gone */ }
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

  /** Store one version's row. The bytes are already on disk. */
  saveArtifactVersion(artifactId: ID, channelId: ID, v: ArtifactVersion): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO artifact_versions" +
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
      const v = this.safeParse<ArtifactVersion>(r.json, "a version of a shared file", r.id);
      if (v?.storedAs) this.removeArtifactBytes(v.storedAs);
      this.db.prepare("DELETE FROM artifact_versions WHERE id=?").run(r.id);
    }
    return doomed.length;
  }

  /** One artifact and its versions, newest first — the wire shape, assembled. */
  artifact(id: ID): Artifact | undefined {
    const row = this.artifactRow(id);
    if (!row) return undefined;
    const versions = this.artifactVersionsOf(id);
    // An identity row with no version left is not something a screen can draw,
    // so it is not something this hands out. It can only happen to a database
    // edited by hand, and saying nothing is better than saying half a file.
    if (versions.length === 0) return undefined;
    return {
      id: row.id, channelId: row.channelId, name: row.name,
      versions, createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  }

  artifactVersionsOf(artifactId: ID): ArtifactVersion[] {
    const rows = this.db.prepare(
      "SELECT id,json FROM artifact_versions WHERE artifactId=? ORDER BY version DESC",
    ).all(artifactId) as { id: string; json: string }[];
    const out: ArtifactVersion[] = [];
    for (const r of rows) {
      const v = this.safeParse<ArtifactVersion>(r.json, "a version of a shared file", r.id);
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
  artifactVersion(versionId: ID): { version: ArtifactVersion; artifactId: ID; channelId: ID } | undefined {
    const row = this.db.prepare(
      "SELECT artifactId,channelId,json FROM artifact_versions WHERE id=?",
    ).get(versionId) as { artifactId: string; channelId: string; json: string } | undefined;
    if (!row) return undefined;
    const version = this.safeParse<ArtifactVersion>(row.json, "a version of a shared file", versionId);
    if (!version) return undefined;
    return { version, artifactId: row.artifactId, channelId: row.channelId };
  }

  /** Every artifact in one conversation, the most recently changed first. */
  artifactsIn(channelId: ID, limit: number): Artifact[] {
    const rows = this.db.prepare(
      "SELECT id FROM artifacts WHERE channelId=? ORDER BY updatedAt DESC, id DESC LIMIT ?",
    ).all(channelId, Math.max(1, Math.floor(limit))) as { id: string }[];
    const out: Artifact[] = [];
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

/**
 * The shape this build expects. Bumped whenever the tables change, and read by
 * `migrate()` so the next change is a step and not a hand repair.
 * 1 = before the chat basics. 2 = reactions, attachments, read state, ledger.
 * 3 = membership as rows, and rooms that can carry a topic and be archived.
 * 4 = run records — what an agent actually did, turn by turn.
 * 5 = a membership row per spell in a room, so a rejoin cannot overwrite a
 *     first arrival.
 */
export const SCHEMA_VERSION = 5;

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
