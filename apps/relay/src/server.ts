// Cloud9 relay — the small always-on hub. All clients (desktop renderer,
// engine host, iPhone app) speak the same WS protocol defined in @cloud9/shared.
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  AgentDef, AgentStatus, Channel, ClientFrame, ID, Message, ServerFrame,
  WorldState, extractMentions, newId,
} from "@cloud9/shared";
import { Store } from "./store.js";

interface Conn {
  ws: WebSocket;
  userId: ID;
  client: "desktop" | "mobile" | "engine";
}

export interface RelayOptions {
  port?: number;
  dbPath?: string;
  ownerToken?: string;
  ownerName?: string;
}

export class Relay {
  store: Store;
  conns = new Set<Conn>();
  agentStatus: Record<ID, AgentStatus> = {};
  server: http.Server;
  wss: WebSocketServer;
  ownerToken: string;
  ownerName: string;

  constructor(opts: RelayOptions = {}) {
    this.store = new Store(opts.dbPath ?? "cloud9-relay.db");
    this.ownerToken = opts.ownerToken ?? process.env.CLOUD9_OWNER_TOKEN ?? "dev-owner-token";
    this.ownerName = opts.ownerName ?? process.env.CLOUD9_OWNER_NAME ?? "Vikas";
    // Owner exists from first boot; a default #general channel too.
    const owner = this.store.ensureOwner(this.ownerName, this.ownerToken);
    if (this.store.channels().length === 0) {
      this.store.saveChannel({
        id: newId("ch"), name: "general", kind: "channel",
        memberIds: [owner.id], createdAt: Date.now(),
      });
    }
    this.server = http.createServer((req, res) => {
      if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
      res.writeHead(404); res.end();
    });
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on("connection", ws => this.onConnection(ws));
  }

  listen(port = 8787): Promise<number> {
    return new Promise(resolve => {
      this.server.listen(port, () => {
        const addr = this.server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  close(): void {
    for (const c of this.conns) c.ws.close();
    this.wss.close();
    this.server.close();
  }

  private onConnection(ws: WebSocket): void {
    let conn: Conn | undefined;
    ws.on("message", raw => {
      let frame: ClientFrame;
      try { frame = JSON.parse(String(raw)); } catch { return; }
      try {
        if (frame.type === "hello") {
          conn = this.handleHello(ws, frame);
          return;
        }
        if (!conn) { send(ws, { type: "error", error: "not authenticated" }); return; }
        this.handleFrame(conn, frame);
      } catch (err) {
        send(ws, { type: "error", error: String(err) });
      }
    });
    ws.on("close", () => { if (conn) this.conns.delete(conn); });
  }

  private handleHello(ws: WebSocket, frame: Extract<ClientFrame, { type: "hello" }>): Conn | undefined {
    let user = this.store.userByToken(frame.token);
    // invite redemption: token form "invite:<code>:<display name>"
    if (!user && frame.token.startsWith("invite:")) {
      const [, code, name] = frame.token.split(":");
      const redeemed = this.store.redeemInvite(code, name || "Friend");
      if (redeemed) {
        user = redeemed.user;
        send(ws, { type: "token", token: redeemed.token });
        // new users join #general automatically
        const general = this.store.channels().find(c => c.name === "general");
        if (general && !general.memberIds.includes(user.id)) {
          general.memberIds.push(user.id);
          this.store.saveChannel(general);
          this.broadcast({ type: "channel", channel: general });
        }
        this.broadcast({ type: "userJoined", user });
      }
    }
    if (!user) { send(ws, { type: "error", error: "bad token" }); ws.close(); return undefined; }
    const conn: Conn = { ws, userId: user.id, client: frame.client };
    this.conns.add(conn);
    send(ws, { type: "welcome", state: this.worldFor(user.id) });
    return conn;
  }

  private worldFor(userId: ID): WorldState {
    const users = this.store.users();
    return {
      me: users.find(u => u.id === userId)!,
      users,
      agents: this.store.agents(),
      channels: this.visibleChannels(userId),
      messages: this.store.recentMessages(),
      agentStatus: this.agentStatus,
    };
  }

  private visibleChannels(userId: ID): Channel[] {
    const myAgentIds = new Set(this.store.agents().filter(a => a.ownerId === userId).map(a => a.id));
    return this.store.channels().filter(
      c => c.memberIds.includes(userId) || c.memberIds.some(m => myAgentIds.has(m)),
    );
  }

  private handleFrame(conn: Conn, frame: ClientFrame): void {
    switch (frame.type) {
      case "send": {
        const user = this.store.users().find(u => u.id === conn.userId)!;
        this.postMessage({
          id: newId("m"), channelId: frame.channelId,
          authorId: user.id, authorName: user.name, authorKind: "human",
          text: frame.text, ts: Date.now(),
          mentions: extractMentions(frame.text, this.directory()),
        }, frame.tempId);
        break;
      }
      case "agentSend": {
        const agent = this.store.agents().find(a => a.id === frame.agentId);
        if (!agent || agent.ownerId !== conn.userId) throw new Error("not your agent");
        this.postMessage({
          id: newId("m"), channelId: frame.channelId,
          authorId: agent.id, authorName: agent.name, authorKind: "agent",
          authorEmoji: agent.emoji, text: frame.text, ts: Date.now(),
          proactive: frame.proactive,
          mentions: extractMentions(frame.text, this.directory()),
        });
        break;
      }
      case "agentStatus": {
        this.agentStatus[frame.agentId] = frame.status;
        this.broadcast({ type: "agentStatus", agentId: frame.agentId, status: frame.status });
        break;
      }
      case "createChannel": {
        const memberIds = Array.from(new Set([conn.userId, ...frame.memberIds]));
        const channel: Channel = {
          id: newId("ch"), name: frame.name,
          kind: frame.kind ?? (frame.memberIds.length === 1 ? "dm" : "channel"),
          memberIds, createdAt: Date.now(),
        };
        this.store.saveChannel(channel);
        this.broadcast({ type: "channel", channel });
        break;
      }
      case "addMembers": {
        const ch = this.store.channel(frame.channelId);
        if (!ch) throw new Error("no such channel");
        ch.memberIds = Array.from(new Set([...ch.memberIds, ...frame.memberIds]));
        this.store.saveChannel(ch);
        this.broadcast({ type: "channel", channel: ch });
        break;
      }
      case "createAgent": {
        const agent: AgentDef = {
          ...frame.agent, id: newId("a"), ownerId: conn.userId, createdAt: Date.now(),
        };
        this.store.saveAgent(agent);
        this.broadcast({ type: "agent", agent });
        break;
      }
      case "updateAgent": {
        const existing = this.store.agents().find(a => a.id === frame.agent.id);
        if (!existing || existing.ownerId !== conn.userId) throw new Error("not your agent");
        this.store.saveAgent({ ...frame.agent, ownerId: existing.ownerId });
        this.broadcast({ type: "agent", agent: frame.agent });
        break;
      }
      case "deleteAgent": {
        const existing = this.store.agents().find(a => a.id === frame.agentId);
        if (!existing || existing.ownerId !== conn.userId) throw new Error("not your agent");
        this.store.deleteAgent(frame.agentId);
        this.broadcast({ type: "agentDeleted", agentId: frame.agentId });
        break;
      }
      case "createInvite": {
        send(conn.ws, { type: "invite", code: this.store.createInvite(conn.userId) });
        break;
      }
      case "history": {
        send(conn.ws, {
          type: "history", channelId: frame.channelId,
          messages: this.store.history(frame.channelId, frame.before ?? Date.now(), frame.limit ?? 50),
        });
        break;
      }
    }
  }

  private directory(): { id: ID; name: string }[] {
    return [...this.store.users(), ...this.store.agents()].map(x => ({ id: x.id, name: x.name }));
  }

  private postMessage(message: Message, tempId?: string): void {
    const ch = this.store.channel(message.channelId);
    if (!ch) throw new Error("no such channel");
    this.store.saveMessage(message);
    const agents = this.store.agents();
    const memberUserIds = new Set<ID>();
    for (const m of ch.memberIds) {
      const agent = agents.find(a => a.id === m);
      memberUserIds.add(agent ? agent.ownerId : m);
    }
    for (const conn of this.conns) {
      if (!memberUserIds.has(conn.userId)) continue;
      send(conn.ws, { type: "message", message, tempId });
      // proactive agent messages become notifications on mobile clients
      if (message.proactive && conn.client === "mobile") {
        send(conn.ws, { type: "push", message });
      }
    }
    // push log for offline members (APNs delivery later)
    if (message.proactive) {
      const online = new Set([...this.conns].map(c => c.userId));
      for (const uid of memberUserIds) {
        if (!online.has(uid)) this.store.logPush(uid, message.id);
      }
    }
  }

  private broadcast(frame: ServerFrame): void {
    for (const conn of this.conns) send(conn.ws, frame);
  }
}

function send(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

// CLI entry
const isMain = process.argv[1] && process.argv[1].endsWith("server.js");
if (isMain) {
  const relay = new Relay({ dbPath: process.env.CLOUD9_DB ?? "cloud9-relay.db" });
  const port = Number(process.env.PORT ?? 8787);
  relay.listen(port).then(p => console.log(`[cloud9-relay] listening on :${p}`));
}
