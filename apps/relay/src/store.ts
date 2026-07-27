// Relay persistence on node:sqlite (built into Node 22+, no native build).
import { DatabaseSync } from "node:sqlite";
import {
  AgentDef, Channel, ID, Message, User, newId,
} from "@cloud9/shared";

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
        code TEXT PRIMARY KEY, createdBy TEXT NOT NULL, usedBy TEXT
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
      CREATE TABLE IF NOT EXISTS pushlog(
        id TEXT PRIMARY KEY, userId TEXT NOT NULL, messageId TEXT NOT NULL,
        ts INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0
      );
    `);
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

  createInvite(createdBy: ID): string {
    const code = newId("inv");
    this.db.prepare("INSERT INTO invites(code,createdBy) VALUES(?,?)").run(code, createdBy);
    return code;
  }

  redeemInvite(code: string, name: string): { user: User; token: string } | undefined {
    const row = this.db.prepare("SELECT code,createdBy,usedBy FROM invites WHERE code=?").get(code) as
      | { code: string; createdBy: string; usedBy: string | null } | undefined;
    if (!row || row.usedBy) return undefined;
    const user: User = { id: newId("u"), name, invitedBy: row.createdBy };
    const token = newId("tok");
    this.db.prepare("INSERT INTO users(id,name,invitedBy) VALUES(?,?,?)").run(user.id, user.name, row.createdBy);
    this.db.prepare("INSERT INTO tokens(token,userId) VALUES(?,?)").run(token, user.id);
    this.db.prepare("UPDATE invites SET usedBy=? WHERE code=?").run(user.id, code);
    return { user, token };
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
  channel(id: ID): Channel | undefined {
    const row = this.db.prepare("SELECT json FROM channels WHERE id=?").get(id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as Channel) : undefined;
  }

  // ---- messages ----
  saveMessage(m: Message): void {
    this.db.prepare("INSERT INTO messages(id,channelId,ts,json) VALUES(?,?,?,?)")
      .run(m.id, m.channelId, m.ts, JSON.stringify(m));
  }
  recentMessages(perChannel = 50): Message[] {
    const out: Message[] = [];
    for (const ch of this.channels()) {
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

  // ---- push (stub until APNs) ----
  logPush(userId: ID, messageId: ID): void {
    this.db.prepare("INSERT INTO pushlog(id,userId,messageId,ts) VALUES(?,?,?,?)")
      .run(newId("push"), userId, messageId, Date.now());
  }
}
