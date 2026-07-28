// Cloud9 relay — the small always-on hub. All clients (desktop renderer,
// engine host, iPhone app) speak the same WS protocol defined in @cloud9/shared.
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  AgentDef, AgentStatus, Approval, Channel, ClientFrame, HarnessState, ID, Message,
  ServerFrame, Task, WorldState, extractMentions, newId, validateAgentInput,
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
  /** interface to bind — defaults to loopback only */
  bind?: string;
  /** allow harness control with the well-known default token (dev/QA only) */
  devMode?: boolean;
}

/**
 * The token every fresh checkout starts with. Harness frames can spawn
 * processes on the owner's computer, so this token alone must never be enough
 * to trigger them outside dev mode.
 */
export const DEFAULT_OWNER_TOKEN = "dev-owner-token";

/** A sign-in may be asked for once every 30s per user, one at a time. */
const SIGNIN_COOLDOWN_MS = 30_000;
/** If an engine never reports back, stop blocking the user after this long. */
const SIGNIN_STUCK_MS = 6 * 60_000;

export class Relay {
  store: Store;
  conns = new Set<Conn>();
  agentStatus: Record<ID, AgentStatus> = {};
  /**
   * Last harness status reported by each user's engine host. Status only —
   * booleans and display labels; credentials never cross the wire
   * (docs/plans/harness-signin.md decision 5).
   */
  harness: Record<ID, HarnessState> = {};
  server: http.Server;
  wss: WebSocketServer;
  ownerToken: string;
  ownerName: string;
  ownerId: ID;
  bind: string;
  devMode: boolean;
  /** last sign-in request per user, and whether one is still running */
  private signInAt: Record<ID, number> = {};
  private signInFlight: Record<ID, number> = {};

  constructor(opts: RelayOptions = {}) {
    this.store = new Store(opts.dbPath ?? "cloud9-relay.db");
    this.ownerToken = opts.ownerToken ?? process.env.CLOUD9_OWNER_TOKEN ?? "dev-owner-token";
    this.ownerName = opts.ownerName ?? process.env.CLOUD9_OWNER_NAME ?? "Vikas";
    this.bind = opts.bind ?? process.env.CLOUD9_BIND ?? "127.0.0.1";
    this.devMode = opts.devMode ?? process.env.CLOUD9_DEV === "1";
    // Owner exists from first boot; a default #general channel too.
    const owner = this.store.ensureOwner(this.ownerName, this.ownerToken);
    this.ownerId = owner.id;
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

  /**
   * Loopback only unless told otherwise. Harness frames can start processes on
   * this computer, so the hub does not answer the network by default.
   */
  listen(port = 8787): Promise<number> {
    return new Promise(resolve => {
      this.server.listen(port, this.bind, () => {
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
    ws.on("close", () => {
      if (!conn) return;
      this.conns.delete(conn);
      // The engine host owns the CLIs. Once it's gone, its last status report is
      // a stale claim about a machine nobody is watching — drop it and say so.
      if (conn.client === "engine" && !this.hasEngine(conn.userId)) {
        delete this.harness[conn.userId];
        delete this.signInFlight[conn.userId];
        this.toUser(conn.userId, {
          type: "harness",
          state: {
            claude: { name: "claude", installed: false, signedIn: false, detail: "your agent engine isn't running" },
            codex: { name: "codex", installed: false, signedIn: false, detail: "your agent engine isn't running" },
            updatedAt: Date.now(),
          },
        });
      }
    });
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
      tasks: this.store.tasks(),
      approvals: this.store.approvals(),
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
        this.audit(conn, "channel_created", channel.id, `created ${channel.kind} ${channel.name}`);
        this.broadcast({ type: "channel", channel });
        break;
      }
      case "addMembers": {
        const ch = this.store.channel(frame.channelId);
        if (!ch) throw new Error("no such channel");
        ch.memberIds = Array.from(new Set([...ch.memberIds, ...frame.memberIds]));
        this.store.saveChannel(ch);
        this.audit(conn, "member_added", ch.id, `added ${frame.memberIds.length} member(s) to ${ch.name}`);
        this.broadcast({ type: "channel", channel: ch });
        break;
      }
      case "createAgent": {
        // first gate on untrusted input: some of these fields end up on a
        // command line in the engine host (the engine re-checks too)
        const bad = validateAgentInput(frame.agent);
        if (bad) throw new Error(bad);
        const agent: AgentDef = {
          ...frame.agent, id: newId("a"), ownerId: conn.userId, createdAt: Date.now(),
        };
        this.store.saveAgent(agent);
        this.audit(conn, "agent_created", agent.id, `created agent ${agent.name}`);
        this.broadcast({ type: "agent", agent });
        break;
      }
      case "updateAgent": {
        const bad = validateAgentInput(frame.agent);
        if (bad) throw new Error(bad);
        const existing = this.store.agents().find(a => a.id === frame.agent.id);
        if (!existing || existing.ownerId !== conn.userId) throw new Error("not your agent");
        this.store.saveAgent({ ...frame.agent, ownerId: existing.ownerId });
        this.audit(conn, "agent_updated", frame.agent.id, `updated agent ${frame.agent.name}`);
        this.broadcast({ type: "agent", agent: frame.agent });
        break;
      }
      case "deleteAgent": {
        const existing = this.store.agents().find(a => a.id === frame.agentId);
        if (!existing || existing.ownerId !== conn.userId) throw new Error("not your agent");
        this.store.deleteAgent(frame.agentId);
        this.audit(conn, "agent_deleted", frame.agentId, `deleted agent ${existing.name}`);
        this.broadcast({ type: "agentDeleted", agentId: frame.agentId });
        break;
      }
      case "createInvite": {
        const code = this.store.createInvite(conn.userId);
        this.audit(conn, "invite_created", code, "created an invite");
        send(conn.ws, { type: "invite", code });
        break;
      }
      case "createTask": {
        const agent = this.store.agents().find(a => a.id === frame.agentId);
        if (!agent) throw new Error("no such agent");
        const requester = this.store.users().find(u => u.id === conn.userId)!;
        const now = Date.now();
        const task: Task = {
          id: newId("t"), title: frame.title,
          requesterId: requester.id, requesterName: requester.name,
          agentId: agent.id, channelId: frame.channelId,
          status: frame.needsApproval ? "waiting_approval" : "not_started",
          createdAt: now, updatedAt: now,
        };
        if (frame.needsApproval) {
          const approval: Approval = {
            id: newId("ap"), taskId: task.id, agentId: agent.id, ownerId: agent.ownerId,
            action: frame.action ?? `Run task: ${frame.title}`,
            status: "pending", createdAt: now,
          };
          task.approvalId = approval.id;
          this.store.saveApproval(approval);
          this.audit(conn, "approval_requested", approval.id,
            `${agent.name} requests approval: ${approval.action}`);
          this.broadcast({ type: "approval", approval });
        }
        this.store.saveTask(task);
        this.audit(conn, "task_created", task.id, `task for ${agent.name}: ${task.title}`);
        this.broadcast({ type: "task", task });
        break;
      }
      case "updateTask": {
        const task = this.store.task(frame.taskId);
        if (!task) throw new Error("no such task");
        const agent = this.store.agents().find(a => a.id === task.agentId);
        if (!agent || agent.ownerId !== conn.userId) throw new Error("not your agent's task");
        if (task.status === "cancelled") break; // FR-TS-005: cancelled stays cancelled
        task.status = frame.status;
        if (frame.result !== undefined) task.result = frame.result;
        if (frame.error !== undefined) task.error = frame.error;
        task.updatedAt = Date.now();
        this.store.saveTask(task);
        this.audit(conn, "task_status", task.id, `task "${task.title}" → ${task.status}`, agent);
        this.broadcast({ type: "task", task });
        break;
      }
      case "cancelTask": {
        const task = this.store.task(frame.taskId);
        if (!task) throw new Error("no such task");
        if (task.status === "completed" || task.status === "failed") break;
        task.status = "cancelled";
        task.updatedAt = Date.now();
        this.store.saveTask(task);
        this.audit(conn, "task_status", task.id, `task "${task.title}" cancelled`);
        this.broadcast({ type: "task", task });
        break;
      }
      case "decideApproval": {
        const approval = this.store.approval(frame.approvalId);
        if (!approval) throw new Error("no such approval");
        // Provisional policy (PARKING-LOT D4): only the agent's owner decides.
        if (approval.ownerId !== conn.userId) throw new Error("only the agent's owner can decide this");
        if (approval.status !== "pending") break; // FR-AP-004: no re-execution through decided approvals
        approval.status = frame.decision;
        approval.decidedBy = conn.userId;
        approval.decidedAt = Date.now();
        this.store.saveApproval(approval);
        this.audit(conn, "approval_decided", approval.id, `${frame.decision}: ${approval.action}`);
        const task = this.store.task(approval.taskId);
        if (task && task.status === "waiting_approval") {
          task.status = frame.decision === "approved" ? "not_started" : "cancelled";
          if (frame.decision === "rejected") task.error = "rejected by owner";
          task.updatedAt = Date.now();
          this.store.saveTask(task);
          this.audit(conn, "task_status", task.id, `task "${task.title}" → ${task.status}`);
          this.broadcast({ type: "task", task });
        }
        this.broadcast({ type: "approval", approval });
        break;
      }
      case "activity": {
        send(conn.ws, {
          type: "activity",
          records: this.store.activity(frame.before ?? Date.now() + 1, frame.limit ?? 100),
        });
        break;
      }
      // ---- harness sign-in (docs/plans/harness-signin.md) ----
      // These frames make the engine host start programs on the owner's
      // computer, so they are the most privileged in the protocol: owner only,
      // never on the shipped default token, and rate-limited.
      case "harnessStatus": {
        this.assertHarnessAllowed(conn);
        // answer immediately from cache, and ask this user's engine to re-check
        const cached = this.harness[conn.userId];
        if (cached) send(conn.ws, { type: "harness", state: cached });
        this.toEngines(conn.userId, { type: "harnessRequest", action: "status" });
        break;
      }
      case "harnessSignIn": {
        this.assertHarnessAllowed(conn);
        if (frame.harness !== "claude" && frame.harness !== "codex") {
          throw new Error("unknown harness");
        }
        const now = Date.now();
        const flight = this.signInFlight[conn.userId];
        if (flight && now - flight < SIGNIN_STUCK_MS) {
          throw new Error("a sign-in is already running — finish it in your browser first");
        }
        if (now - (this.signInAt[conn.userId] ?? 0) < SIGNIN_COOLDOWN_MS) {
          throw new Error("give the last sign-in a moment before trying again");
        }
        this.signInAt[conn.userId] = now;
        this.signInFlight[conn.userId] = now;
        // only this user's own engine host may be told to sign in
        this.toEngines(conn.userId, {
          type: "harnessRequest", action: "signIn", harness: frame.harness,
        });
        break;
      }
      case "harnessState": {
        if (conn.client !== "engine") throw new Error("only the engine reports harness state");
        this.assertHarnessAllowed(conn);
        this.harness[conn.userId] = frame.state;
        // the engine says nothing is signing in any more → release the lock
        if (!frame.state.claude.signingIn && !frame.state.codex.signingIn) {
          delete this.signInFlight[conn.userId];
        }
        this.toUser(conn.userId, { type: "harness", state: frame.state });
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

  private audit(conn: Conn, kind: Parameters<Store["logActivity"]>[0]["kind"], refId: string, detail: string, asAgent?: AgentDef): void {
    const user = this.store.users().find(u => u.id === conn.userId);
    this.store.logActivity({
      actorKind: asAgent ? "agent" : "human",
      actorId: asAgent ? asAgent.id : conn.userId,
      actorName: asAgent ? asAgent.name : user?.name ?? "?",
      kind, refId, detail,
    });
  }

  private directory(): { id: ID; name: string }[] {
    return [...this.store.users(), ...this.store.agents()].map(x => ({ id: x.id, name: x.name }));
  }

  private postMessage(message: Message, tempId?: string): void {
    const ch = this.store.channel(message.channelId);
    if (!ch) throw new Error("no such channel");
    this.store.saveMessage(message);
    if (message.authorKind === "agent") {
      this.store.logActivity({
        actorKind: "agent", actorId: message.authorId, actorName: message.authorName,
        kind: "message", refId: message.id,
        detail: `posted in channel ${message.channelId}${message.proactive ? " (proactive)" : ""}`,
      });
    }
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

  /**
   * Harness control is limited to the person who runs this Cloud9, on a relay
   * that isn't using the token every checkout ships with. Invited friends can
   * chat; they cannot start programs on the owner's machine.
   */
  private assertHarnessAllowed(conn: Conn): void {
    if (conn.userId !== this.ownerId) {
      throw new Error("only the owner of this Cloud9 can connect the AI apps");
    }
    if (this.ownerToken === DEFAULT_OWNER_TOKEN && !this.devMode) {
      throw new Error(
        "set your own owner token before connecting the AI apps (the default one isn't private)",
      );
    }
  }

  /** Send to one user's engine host connection(s) only. */
  private toEngines(userId: ID, frame: ServerFrame): void {
    for (const conn of this.conns) {
      if (conn.userId === userId && conn.client === "engine") send(conn.ws, frame);
    }
  }

  private hasEngine(userId: ID): boolean {
    for (const c of this.conns) if (c.userId === userId && c.client === "engine") return true;
    return false;
  }

  /** Send to every client (desktop/mobile/engine) belonging to one user. */
  private toUser(userId: ID, frame: ServerFrame): void {
    for (const conn of this.conns) {
      if (conn.userId === userId) send(conn.ws, frame);
    }
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
