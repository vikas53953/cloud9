// Relay persistence on node:sqlite (built into Node 22+, no native build).
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ActivityRecord, AgentDef, Approval, Attachment, Channel, ID, Message,
  MessageReaction, MESSAGE_LIMITS, Task, User, newId,
} from "@cloud9/shared";
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

function toInvite(r: RawInvite): InviteRow {
  return {
    code: r.code, createdBy: r.createdBy,
    usedBy: r.usedBy ?? undefined, usedAt: r.usedAt ?? undefined,
    revoked: r.revoked === 1,
  };
}

export class Store {
  db: DatabaseSync;
  /**
   * Where attached files live: a folder beside the database, on the machine
   * running the hub. Nothing else in the app may choose this path — one owner,
   * so a file can never be written anywhere a client asked for.
   */
  attachmentsDir: string;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.attachmentsDir = path.join(path.dirname(path.resolve(dbPath)), "cloud9-attachments");
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
      CREATE UNIQUE INDEX IF NOT EXISTS act_seq ON activity(seq);
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

      -- Read state lives HERE, on the account, so it follows a person between
      -- machines. It used to live in one browser's localStorage.
      CREATE TABLE IF NOT EXISTS reads(
        userId TEXT NOT NULL, channelId TEXT NOT NULL,
        lastReadTs INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        PRIMARY KEY (userId, channelId)
      );
    `);
    this.migrate();
    this.initSearch();
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
    // Backfill a database written before this round, once.
    const indexed = (this.db.prepare("SELECT COUNT(*) n FROM messages_fts").get() as { n: number }).n;
    if (indexed > 0) return;
    const rows = this.db.prepare("SELECT id,channelId,json FROM messages").all() as
      { id: string; channelId: string; json: string }[];
    for (const r of rows) {
      const m = JSON.parse(r.json) as Message;
      if (m.deletedAt) continue;
      this.indexMessage(m);
    }
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

    const from = this.schemaVersion();
    if (from < SCHEMA_VERSION) {
      // v1 → v2: the trail becomes a ledger. Rows written before the chain
      // existed are numbered and hashed in time order, ONCE. This does not make
      // them trustworthy — nothing can, after the fact — it makes everything
      // written from here on detectable if it is altered.
      this.chainExistingActivity();
      this.setSchemaVersion(SCHEMA_VERSION);
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
      const rec = JSON.parse(r.json) as ActivityRecord;
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
    for (const channel of this.channels()) {
      if (!channel.memberIds.includes(id)) continue;
      channel.memberIds = channel.memberIds.filter(m => m !== id);
      this.saveChannel(channel);
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
  }
  agents(): AgentDef[] {
    return (this.db.prepare("SELECT json FROM agents").all() as { json: string }[])
      .map(r => JSON.parse(r.json) as AgentDef);
  }

  // ---- channels ----
  saveChannel(channel: Channel): void {
    this.db.prepare("INSERT OR REPLACE INTO channels(id,json) VALUES(?,?)").run(channel.id, JSON.stringify(channel));
  }
  channels(): Channel[] {
    return (this.db.prepare("SELECT json FROM channels").all() as { json: string }[])
      .map(r => JSON.parse(r.json) as Channel);
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
    return row ? (JSON.parse(row.json) as Channel) : undefined;
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

    let hits: { json: string; snippet: string }[];
    if (this.searchIndexed) {
      const match = terms.map(t => `"${t}"`).join(" ") + "*";
      hits = this.db.prepare(
        `SELECT m.json AS json, snippet(messages_fts, 0, '«', '»', '…', 12) AS snippet
         FROM messages_fts f JOIN messages m ON m.id = f.messageId
         WHERE messages_fts MATCH ? AND f.channelId IN (${slots})
         ORDER BY m.ts DESC LIMIT ?`,
      ).all(match, ...ids, size + 1) as { json: string; snippet: string }[];
    } else {
      // No FTS5 on this SQLite: a plain contains-scan. Slower and it matches
      // inside words, but it never lies about what it found.
      const like = `%${terms.join(" ")}%`;
      hits = (this.db.prepare(
        `SELECT json FROM messages WHERE channelId IN (${slots}) AND json LIKE ?
         ORDER BY ts DESC LIMIT ?`,
      ).all(...ids, like, size + 1) as { json: string }[])
        .map(r => ({ json: r.json, snippet: "" }));
    }

    let items = hits.map(h => ({
      message: JSON.parse(h.json) as Message,
      snippet: h.snippet,
    }));
    // a tombstone has no words left, so it can never be a search result
    items = items.filter(x => !x.message.deletedAt);
    if (opts.authorId) items = items.filter(x => x.message.authorId === opts.authorId);
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
   * the braces of `isSafeSkillFileName`.
   */
  writeAttachmentBytes(id: ID, safeName: string, bytes: Buffer): string {
    fs.mkdirSync(this.attachmentsDir, { recursive: true });
    const storedAs = `${id}-${path.basename(safeName)}`;
    fs.writeFileSync(path.join(this.attachmentsDir, storedAs), bytes);
    return storedAs;
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

  /** Forget a message's files (used by delete) and say which bytes to remove. */
  releaseAttachments(messageId: ID): Attachment[] {
    const rows = this.db.prepare("SELECT json FROM attachments WHERE messageId=?")
      .all(messageId) as { json: string }[];
    this.db.prepare("DELETE FROM attachments WHERE messageId=?").run(messageId);
    return rows.map(r => JSON.parse(r.json) as Attachment);
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
    const since = this.lastRead(userId, channelId);
    const rows = this.db
      .prepare("SELECT json FROM messages WHERE channelId=? AND ts>? ORDER BY ts ASC LIMIT 1000")
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
    for (const r of rows) {
      const rec = JSON.parse(r.json) as ActivityRecord;
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
      expected += 1;
    }
    return null;
  }
  activity(before: number, limit: number): ActivityRecord[] {
    return (this.db.prepare("SELECT json FROM activity WHERE ts<? ORDER BY ts DESC LIMIT ?")
      .all(before, limit) as { json: string }[])
      .map(r => JSON.parse(r.json) as ActivityRecord).reverse();
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
 */
export const SCHEMA_VERSION = 2;

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
