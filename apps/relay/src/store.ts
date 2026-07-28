// Relay persistence on node:sqlite (built into Node 22+, no native build).
import { DatabaseSync } from "node:sqlite";
import {
  ActivityRecord, AgentDef, Approval, Channel, ID, Message, Task, User, newId,
} from "@cloud9/shared";
import { secureId, secureToken } from "./secureid.js";

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

  constructor(path: string) {
    this.db = new DatabaseSync(path);
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
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS act_ts ON activity(ts);
      CREATE TABLE IF NOT EXISTS pushlog(
        id TEXT PRIMARY KEY, userId TEXT NOT NULL, messageId TEXT NOT NULL,
        ts INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.migrate();
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
  saveMessage(m: Message): void {
    this.db.prepare("INSERT INTO messages(id,channelId,ts,json) VALUES(?,?,?,?)")
      .run(m.id, m.channelId, m.ts, JSON.stringify(m));
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
  recentMessages(channels: Channel[], perChannel = 50): Message[] {
    const out: Message[] = [];
    for (const ch of channels) {
      const rows = this.db
        .prepare("SELECT json FROM messages WHERE channelId=? ORDER BY ts DESC LIMIT ?")
        .all(ch.id, perChannel) as { json: string }[];
      out.push(...rows.map(r => JSON.parse(r.json) as Message).reverse());
    }
    return out;
  }
  history(channelId: ID, before: number, limit: number): Message[] {
    const rows = this.db
      .prepare("SELECT json FROM messages WHERE channelId=? AND ts<? ORDER BY ts DESC LIMIT ?")
      .all(channelId, before, limit) as { json: string }[];
    return rows.map(r => JSON.parse(r.json) as Message).reverse();
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
  logActivity(rec: Omit<ActivityRecord, "id" | "ts">): ActivityRecord {
    const full: ActivityRecord = { ...rec, id: newId("act"), ts: Date.now() };
    this.db.prepare("INSERT INTO activity(id,ts,json) VALUES(?,?,?)").run(full.id, full.ts, JSON.stringify(full));
    return full;
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
