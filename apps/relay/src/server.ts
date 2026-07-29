// Cloud9 relay — the small always-on hub. All clients (desktop renderer,
// engine host, iPhone app) speak the same WS protocol defined in @cloud9/shared.
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import {
  AgentDef, AgentStatus, Approval, Attachment, Channel, ClientFrame, HarnessState, ID, Message,
  MESSAGE_LIMITS, ATTACHMENT_LIMITS, SearchHit, ServerFrame, Task, UnreadEntry, User, WorldState,
  mayDriveAgent,
  extractMentions, newId, validateAgentInput, validateAttachment, validateMessageText,
  validateReactionEmoji,
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

/** This computer only — the address the hub uses unless it is told otherwise. */
export const LOOPBACK = "127.0.0.1";

/**
 * Addresses that mean "answer on EVERY network this computer is on", including
 * the café wifi and, behind a careless router, the open internet. The hub can
 * start programs on the owner's machine, so it must never be reachable that
 * widely — not by a typo, not by an environment variable, not by a settings
 * file someone copied off a forum. (docs/plans/backend-decision.md #2:
 * "bind the private-network interface instead, never 0.0.0.0".)
 */
const EVERY_INTERFACE = new Set(["0.0.0.0", "::", "[::]", "*", "0", "::0", "0.0.0.0.0"]);

/**
 * Which address the hub answers on. Loopback unless a real, specific address is
 * named — and a wildcard is REFUSED, never quietly narrowed, so a
 * misconfiguration is loud instead of a silent hole.
 *
 * The intended use is a Tailscale address (100.x.y.z): friends' enrolled
 * devices can reach it and nothing else on any network can.
 */
export function resolveBind(requested?: string): string {
  const want = (requested ?? "").trim();
  if (!want) return LOOPBACK;
  if (EVERY_INTERFACE.has(want.toLowerCase())) {
    throw new Error(
      "Cloud9's hub will not listen on every network (" + want + "). " +
      "Give it one address — your private-network (Tailscale) address, e.g. 100.x.y.z — " +
      "or leave it unset to stay on this computer only.");
  }
  return want;
}

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
    this.bind = resolveBind(opts.bind ?? process.env.CLOUD9_BIND);
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
            claude: {
              name: "claude", installed: false, signedIn: false, authKind: "none",
              models: [], detail: "your agent engine isn't running",
            },
            codex: {
              name: "codex", installed: false, signedIn: false, authKind: "none",
              models: [], detail: "your agent engine isn't running",
            },
            updatedAt: Date.now(),
          },
        });
      }
    });
  }

  private handleHello(ws: WebSocket, frame: Extract<ClientFrame, { type: "hello" }>): Conn | undefined {
    let user = this.store.userByToken(frame.token);
    // invite redemption: token form "invite:<code>:<display name>"
    //
    // The name in this string is a LABEL — what to call this person on screen.
    // It has never been, and must never become, a claim about who they are:
    // the account that comes out of this is created fresh, or the redemption
    // fails. (P0 #1)
    if (!user && frame.token.startsWith("invite:")) {
      const [, code, name] = frame.token.split(":");
      const redeemed = this.store.redeemInvite(code, name || "Friend");
      if (!redeemed) {
        const known = this.store.invite(code);
        send(ws, {
          type: "error",
          error: known
            ? "that invite has already been used — ask for a new one"
            : "that invite code isn't valid",
        });
        ws.close();
        return undefined;
      }
      user = redeemed.user;
      send(ws, { type: "token", token: redeemed.token });
      // new users join #general automatically
      const general = this.store.channels().find(c => c.name === "general");
      if (general && !general.memberIds.includes(user.id)) {
        general.memberIds.push(user.id);
        this.store.saveChannel(general);
        this.broadcastChannel(general);
      }
      this.broadcast({ type: "userJoined", user });
    }
    if (!user) { send(ws, { type: "error", error: "bad token" }); ws.close(); return undefined; }
    const conn: Conn = { ws, userId: user.id, client: frame.client };
    this.conns.add(conn);
    send(ws, { type: "welcome", state: this.worldFor(user.id) });
    return conn;
  }

  private worldFor(userId: ID): WorldState {
    const users = this.store.users();
    const channels = this.visibleChannels(userId);
    return {
      me: users.find(u => u.id === userId)!,
      users,
      agents: this.store.agents(),
      channels,
      // only the conversations this person is actually in (P1 #7). The opening
      // frame used to carry the backlog of EVERY channel in the database.
      messages: this.hydrate(this.store.recentMessages(channels)),
      agentStatus: this.agentStatus,
      tasks: this.store.tasks(),
      approvals: this.store.approvals(),
      // read state comes from the RELAY now, not from one browser's storage, so
      // reading on the laptop is read on the phone too
      unread: this.unreadFor(userId, channels),
    };
  }

  private visibleChannels(userId: ID): Channel[] {
    const myAgentIds = new Set(this.store.agents().filter(a => a.ownerId === userId).map(a => a.id));
    return this.store.channels().filter(
      c => c.memberIds.includes(userId) || c.memberIds.some(m => myAgentIds.has(m)),
    );
  }

  /**
   * The one gate every channel-scoped frame goes through.
   *
   * A channel id arrives from a client, so it is a REQUEST, not a permission.
   * Reading history, posting a message and adding members all ask this same
   * question — "is this conversation yours?" — so none of them can drift apart
   * or be forgotten (P1 #7).
   */
  private channelFor(userId: ID, channelId: ID): Channel {
    const channel = this.visibleChannels(userId).find(c => c.id === channelId);
    if (!channel) throw new Error("no such channel");
    return channel;
  }

  /**
   * The agent this connection is allowed to act on, or an error.
   * Ownership is read from what is STORED, never from the frame (P1 #6).
   */
  private myAgent(userId: ID, agentId: ID): AgentDef {
    const agent = this.store.agents().find(a => a.id === agentId);
    if (!agent || agent.ownerId !== userId) throw new Error("not your agent");
    return agent;
  }

  /**
   * The one gate every MESSAGE-scoped frame goes through.
   *
   * A message id arrives from a client, so — exactly like a channel id — it is
   * a request, not a permission. Reacting, editing, deleting, replying and
   * opening a thread all ask the same question first: does this message live in
   * a conversation that is yours? Asking it here means none of them can drift
   * apart or be forgotten. Same law as `channelFor` (P1 #7).
   */
  private messageFor(userId: ID, messageId: ID): Message {
    const message = this.store.message(messageId);
    if (!message) throw new Error("no such message");
    this.channelFor(userId, message.channelId);
    return message;
  }

  /**
   * May this person change this message?
   *
   * Only the author. An agent's messages belong to THE AGENT'S OWNER, and that
   * is decided by `myAgent` — the same function that decides every other
   * question about an agent — so ownership is read from stored state and never
   * from what arrived on the wire.
   */
  private assertAuthor(userId: ID, message: Message): void {
    if (message.authorKind === "agent") {
      this.myAgent(userId, message.authorId); // throws "not your agent"
      return;
    }
    if (message.authorId !== userId) throw new Error("you can only change your own messages");
  }

  /** This person plus every agent they own — the ids that count as "me". */
  private myIds(userId: ID): Set<ID> {
    const ids = new Set<ID>([userId]);
    for (const a of this.store.agents()) if (a.ownerId === userId) ids.add(a.id);
    return ids;
  }

  /**
   * Fill in the parts of a message that are computed, not stored: who reacted,
   * and how many replies hang off it. One place, so history, search, threads
   * and the opening frame can never disagree about what a message looks like.
   */
  private hydrate(messages: Message[]): Message[] {
    if (messages.length === 0) return messages;
    const reactions = this.store.reactionsFor(messages.map(m => m.id));
    return messages.map(m => {
      const r = reactions.get(m.id);
      return r ? { ...m, reactions: r } : m;
    });
  }

  /**
   * WHO MAY MAKE AN AGENT ACT — asked here, on the way in, for every path.
   *
   * An agent's turns run on its owner's computer and are paid for by its
   * owner's subscription, so sharing a room with someone's agent has never been
   * permission to drive it. Three things can start a turn: an @mention, a
   * delegated job (`createTask`), and a schedule (a kind of task). All three ask
   * `mayDriveAgent`, which reads the agent's own stored setting.
   *
   * A MENTION IS FILTERED, NOT REFUSED. The message still goes through with the
   * words the person typed — it is their message — but the id of an agent they
   * may not drive never reaches the published `mentions` list, which is what the
   * engine acts on. Refusing the whole message would mean one badly-aimed
   * @ silences a conversation.
   */
  private mentionsFor(userId: ID, text: string): ID[] {
    const agents = new Map(this.store.agents().map(a => [a.id, a]));
    return extractMentions(text, this.directory()).filter(id => {
      const agent = agents.get(id);
      return !agent || mayDriveAgent(userId, agent);
    });
  }

  /**
   * Where a reply belongs.
   *
   * Threads are ONE level deep on purpose. Replying to a reply joins the same
   * thread rather than starting a nested one, so a busy channel can never grow
   * a tree nobody can follow — and the parent must be in the same conversation,
   * or "reply" would be a way to hang your words off a message somewhere else.
   */
  private resolveReplyTo(channel: Channel, replyTo: ID | undefined): ID | undefined {
    if (!replyTo) return undefined;
    const parent = this.store.message(replyTo);
    if (!parent || parent.channelId !== channel.id) {
      throw new Error("that message isn't in this conversation");
    }
    return parent.replyTo ?? parent.id;
  }

  /** Where this person has read up to, in every conversation they can see. */
  private unreadFor(userId: ID, channels: Channel[]): UnreadEntry[] {
    const mine = this.myIds(userId);
    return channels.map(c => ({
      channelId: c.id,
      lastReadTs: this.store.lastRead(userId, c.id),
      ...this.store.unreadFor(userId, c.id, mine),
    }));
  }

  /**
   * Hand the files a `send` named to the message that is carrying them.
   *
   * Each one has to be YOURS, parked in THIS conversation, and not already on
   * another message — a parked file id is a claim, so all three are checked
   * against what is stored rather than trusted.
   */
  private claimAttachments(userId: ID, channel: Channel, ids: ID[] | undefined, messageId: ID): Attachment[] {
    if (!ids || ids.length === 0) return [];
    if (ids.length > ATTACHMENT_LIMITS.perMessage) {
      throw new Error(`that's too many files (max ${ATTACHMENT_LIMITS.perMessage})`);
    }
    const out: Attachment[] = [];
    for (const id of new Set(ids)) {
      const row = this.store.attachment(id);
      if (!row) throw new Error("that file isn't ready to send");
      if (row.attachment.uploadedBy !== userId) throw new Error("that file isn't yours to send");
      if (row.channelId !== channel.id) throw new Error("that file was uploaded to another conversation");
      if (row.messageId) throw new Error("that file has already been sent");
      this.store.claimAttachment(id, messageId);
      out.push(row.attachment);
    }
    return out;
  }

  /** Tell every client of every member that a stored message changed. */
  private broadcastMessageUpdate(message: Message): void {
    const ch = this.store.channel(message.channelId);
    if (!ch) return;
    const [hydrated] = this.hydrate([message]);
    for (const conn of this.conns) {
      if (this.audienceFor(ch).has(conn.userId)) {
        send(conn.ws, { type: "messageUpdated", message: hydrated });
      }
    }
  }

  /** The human accounts that can see this conversation (an agent counts as its owner). */
  private audienceFor(channel: Channel): Set<ID> {
    const agents = this.store.agents();
    const out = new Set<ID>();
    for (const m of channel.memberIds) {
      const agent = agents.find(a => a.id === m);
      out.add(agent ? agent.ownerId : m);
    }
    return out;
  }

  private handleFrame(conn: Conn, frame: ClientFrame): void {
    switch (frame.type) {
      case "send": {
        const user = this.store.users().find(u => u.id === conn.userId)!;
        const channel = this.channelFor(conn.userId, frame.channelId); // you may only post where you are
        const hasFiles = (frame.attachmentIds?.length ?? 0) > 0;
        // words are optional only when a file is carrying the message
        const bad = validateMessageText(frame.text, hasFiles);
        if (bad) throw new Error(bad);
        const replyTo = this.resolveReplyTo(channel, frame.replyTo);
        const id = newId("m");
        const attachments = this.claimAttachments(conn.userId, channel, frame.attachmentIds, id);
        this.postMessage({
          id, channelId: frame.channelId,
          authorId: user.id, authorName: user.name, authorKind: "human",
          text: frame.text, ts: Date.now(),
          mentions: this.mentionsFor(conn.userId, frame.text),
          ...(replyTo ? { replyTo } : {}),
          ...(attachments.length ? { attachments } : {}),
        }, frame.tempId);
        break;
      }
      case "agentSend": {
        const agent = this.myAgent(conn.userId, frame.agentId);
        // an agent speaks where it (or its owner) belongs, nowhere else
        const channel = this.channelFor(conn.userId, frame.channelId);
        const bad = validateMessageText(frame.text);
        if (bad) throw new Error(bad);
        const replyTo = this.resolveReplyTo(channel, frame.replyTo);
        this.postMessage({
          id: newId("m"), channelId: frame.channelId,
          authorId: agent.id, authorName: agent.name, authorKind: "agent",
          authorEmoji: agent.emoji, text: frame.text, ts: Date.now(),
          proactive: frame.proactive,
          mentions: this.mentionsFor(conn.userId, frame.text),
          ...(replyTo ? { replyTo } : {}),
        });
        break;
      }
      case "agentStatus": {
        this.myAgent(conn.userId, frame.agentId); // nobody sets someone else's lamp
        this.agentStatus[frame.agentId] = frame.status;
        this.broadcast({ type: "agentStatus", agentId: frame.agentId, status: frame.status });
        break;
      }
      case "createChannel": {
        const memberIds = Array.from(new Set([conn.userId, ...frame.memberIds]));
        const kind = frame.kind ?? (frame.memberIds.length === 1 ? "dm" : "channel");
        // A direct conversation is FOUND or created, never duplicated (his 15).
        // Clicking a person twice must land in the same place both times.
        if (kind === "dm" && memberIds.length === 2) {
          const existing = this.store.dmBetween(memberIds[0], memberIds[1]);
          if (existing) { send(conn.ws, { type: "channel", channel: existing }); break; }
        }
        const channel: Channel = {
          id: newId("ch"), name: frame.name, kind, memberIds, createdAt: Date.now(),
        };
        this.store.saveChannel(channel);
        this.audit(conn, "channel_created", channel.id, `created ${channel.kind} ${channel.name}`);
        this.broadcastChannel(channel);
        break;
      }
      case "addMembers": {
        // you can only add people to a conversation you are in yourself
        const ch = this.channelFor(conn.userId, frame.channelId);
        ch.memberIds = Array.from(new Set([...ch.memberIds, ...frame.memberIds]));
        this.store.saveChannel(ch);
        this.audit(conn, "member_added", ch.id, `added ${frame.memberIds.length} member(s) to ${ch.name}`);
        this.broadcastChannel(ch);
        break;
      }
      case "createAgent": {
        // first gate on untrusted input: some of these fields end up on a
        // command line in the engine host (the engine re-checks too)
        const bad = validateAgentInput(frame.agent, this.agentRules(conn, frame.agent.provider));
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
        const bad = validateAgentInput(frame.agent, this.agentRules(conn, frame.agent.provider));
        if (bad) throw new Error(bad);
        const existing = this.myAgent(conn.userId, frame.agent.id);
        // An edit that never mentions a skill's files must not delete them
        // (M3). One rule, here, for every client — see `keepSkillFiles`.
        const saved: AgentDef = {
          ...frame.agent,
          ownerId: existing.ownerId,
          skills: keepSkillFiles(existing.skills, frame.agent.skills),
        };
        this.store.saveAgent(saved);
        this.audit(conn, "agent_updated", frame.agent.id, `updated agent ${frame.agent.name}`);
        // broadcast what was STORED, not what was sent — otherwise every other
        // client would be told the files are gone even though they are not
        this.broadcast({ type: "agent", agent: saved });
        break;
      }
      case "deleteAgent": {
        const existing = this.myAgent(conn.userId, frame.agentId);
        this.store.deleteAgent(frame.agentId);
        this.audit(conn, "agent_deleted", frame.agentId, `deleted agent ${existing.name}`);
        this.broadcast({ type: "agentDeleted", agentId: frame.agentId });
        break;
      }
      case "createInvite": {
        // An invite is the front door key of this Cloud9, so only the person
        // who runs it may cut one (P0 #1). Without this gate a guest could mint
        // the very code they needed to attack the redemption path.
        if (conn.userId !== this.ownerId) {
          throw new Error("only the owner of this Cloud9 can invite someone");
        }
        const code = this.store.createInvite(conn.userId);
        this.audit(conn, "invite_created", code, "created an invite");
        send(conn.ws, { type: "invite", code });
        break;
      }
      case "removeUser": {
        // removing a person deletes their agents, so this is owner-only and the
        // owner can't remove themselves out of their own Cloud9
        if (conn.userId !== this.ownerId) {
          throw new Error("only the owner of this Cloud9 can remove someone");
        }
        if (frame.userId === this.ownerId) throw new Error("you can't remove yourself");
        const target = this.store.user(frame.userId);
        if (!target) throw new Error("no such person");
        const theirAgents = this.store.agents().filter(a => a.ownerId === target.id);
        this.store.removeUser(target.id);
        this.audit(conn, "agent_deleted", target.id, `removed ${target.name} from this Cloud9`);
        for (const a of theirAgents) this.broadcast({ type: "agentDeleted", agentId: a.id });
        for (const c of this.store.channels()) this.broadcastChannel(c);
        this.broadcast({ type: "userRemoved", userId: target.id });
        // and close whatever they still have open — their tokens are gone
        for (const c of [...this.conns]) {
          if (c.userId === target.id) { c.ws.close(); this.conns.delete(c); }
        }
        break;
      }
      case "createTask": {
        // Two questions, both answered from STORED state, never from the frame
        // (P1 #6): is this your agent, and is this your conversation? Without
        // them a guest could run background work on the owner's paid
        // subscription, in a channel they had never been invited to.
        const agent = this.myAgent(conn.userId, frame.agentId);
        const channel = this.channelFor(conn.userId, frame.channelId);
        // WHO ASKED — not whichever socket carried the request. The engine host
        // relays everybody's "!bg …" down its own connection, so reading the
        // person off the connection credited every delegated job to the owner
        // (M4). `requesterFor` is the one place that answers this question.
        const requester = this.requesterFor(conn, frame.requesterId, channel);
        // AND THE THIRD QUESTION: may THEY drive this agent? `myAgent` above
        // only proves the agent belongs to whoever owns this socket — and the
        // engine host's socket belongs to the owner while it relays everybody
        // else's "!bg …". Without this line, any friend in the room could spend
        // the owner's subscription and start work on the owner's computer.
        if (!mayDriveAgent(requester.id, agent)) {
          throw new Error(`${agent.name} isn't set up to take work from ${requester.name}`);
        }
        const now = Date.now();
        // Whether this needs the owner's blessing is the AGENT's setting. The
        // client used to be asked, which meant "does this need approval?" was
        // answered by the thing being approved — sending needsApproval:false
        // walked straight past the gate.
        const needsApproval = requiresApproval(agent, frame.title);
        const task: Task = {
          id: newId("t"), title: frame.title,
          requesterId: requester.id, requesterName: requester.name,
          agentId: agent.id, channelId: frame.channelId,
          status: needsApproval ? "waiting_approval" : "not_started",
          createdAt: now, updatedAt: now,
        };
        if (needsApproval) {
          const approval: Approval = {
            id: newId("ap"), taskId: task.id, agentId: agent.id, ownerId: agent.ownerId,
            // the sentence the owner reads is written HERE, from the stored
            // task — a client-supplied one could describe the work as
            // something harmless
            action: describeApproval(task.title),
            status: "pending", createdAt: now,
          };
          task.approvalId = approval.id;
          this.store.saveApproval(approval);
          this.audit(conn, "approval_requested", approval.id,
            `${agent.name} requests approval: ${approval.action}`, { asUser: requester });
          this.broadcast({ type: "approval", approval });
        }
        this.store.saveTask(task);
        // credited to WHO ASKED, not to whichever socket carried the request
        this.audit(conn, "task_created", task.id, `task for ${agent.name}: ${task.title}`,
          { asUser: requester });
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
        this.audit(conn, "task_status", task.id, `task "${task.title}" → ${task.status}`, { asAgent: agent });
        this.broadcast({ type: "task", task });
        break;
      }
      case "cancelTask": {
        const task = this.store.task(frame.taskId);
        if (!task) throw new Error("no such task");
        // Stopping someone else's work is an action on their agent, so the same
        // rule applies (P1 #6): you asked for it, or it runs on your agent.
        const owner = this.store.agents().find(a => a.id === task.agentId)?.ownerId;
        if (task.requesterId !== conn.userId && owner !== conn.userId) {
          throw new Error("that task isn't yours to stop");
        }
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
      case "refreshHarness":
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
      case "harnessCancel": {
        // The renderer's Cancel button had nowhere to send this, so pressing it
        // only hid the spinner locally: the relay kept the "a sign-in is
        // running" lock for six minutes and every retry was refused
        // (finding #10). Releasing the lock is the whole job.
        this.assertHarnessAllowed(conn);
        if (frame.harness !== "claude" && frame.harness !== "codex") {
          throw new Error("unknown harness");
        }
        delete this.signInFlight[conn.userId];
        delete this.signInAt[conn.userId];
        this.toEngines(conn.userId, {
          type: "harnessRequest", action: "cancel", harness: frame.harness,
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
        // scrolling back is reading — same gate as posting (P1 #7)
        this.channelFor(conn.userId, frame.channelId);
        const page = this.store.history(
          frame.channelId,
          { before: frame.before, beforeId: frame.beforeId },
          frame.limit ?? MESSAGE_LIMITS.defaultPage,
        );
        send(conn.ws, {
          type: "history", channelId: frame.channelId,
          messages: this.hydrate(page.items),
          hasMore: page.hasMore,
          nextBefore: page.nextBefore, nextBeforeId: page.nextBeforeId,
        });
        break;
      }
      case "search": {
        // The scope is computed from STORED membership, exactly as `welcome` is
        // — a search can never reach a conversation the asker isn't in, and a
        // `channelId` in the frame can only NARROW that list, never widen it.
        const mine = this.visibleChannels(conn.userId);
        const scope = frame.channelId
          ? [this.channelFor(conn.userId, frame.channelId)]
          : mine;
        const page = this.store.search(scope, frame.query ?? "", {
          authorId: frame.authorId, limit: frame.limit,
        });
        const byId = new Map(scope.map(c => [c.id, c]));
        const results: SearchHit[] = this.hydrate(page.items.map(x => x.message))
          .map((message, i) => {
            const ch = byId.get(message.channelId)!;
            return {
              message, channelName: ch.name, channelKind: ch.kind,
              snippet: page.items[i].snippet,
            };
          });
        send(conn.ws, {
          type: "searchResults", query: frame.query ?? "", results, hasMore: page.hasMore,
        });
        break;
      }
      case "react": {
        const message = this.messageFor(conn.userId, frame.messageId);
        // a tombstone has nothing left to react to
        if (message.deletedAt) throw new Error("that message was deleted");
        const bad = validateReactionEmoji(frame.emoji);
        if (bad) throw new Error(bad);
        const on = frame.on !== false;
        // idempotent by the reactions table's primary key, not by hoping the
        // client only pressed once
        const userIds = this.store.setReaction(message.id, conn.userId, frame.emoji, on);
        const ch = this.store.channel(message.channelId)!;
        const audience = this.audienceFor(ch);
        for (const c of this.conns) {
          if (audience.has(c.userId)) {
            send(c.ws, {
              type: "reaction", channelId: ch.id, messageId: message.id,
              emoji: frame.emoji, userIds,
            });
          }
        }
        break;
      }
      case "editMessage": {
        const message = this.messageFor(conn.userId, frame.messageId);
        this.assertAuthor(conn.userId, message);
        if (message.deletedAt) throw new Error("that message was deleted");
        const bad = validateMessageText(frame.text, (message.attachments?.length ?? 0) > 0);
        if (bad) throw new Error(bad);
        message.text = frame.text;
        message.editedAt = Date.now();
        // an edit re-decides who was named, so an @mention can be added or taken
        // back — otherwise editing would leave the old names notifying forever
        message.mentions = this.mentionsFor(conn.userId, frame.text);
        this.store.saveMessage(message);
        this.auditMessage(conn, message, "message_edited", "edited a message");
        this.broadcastMessageUpdate(message);
        break;
      }
      case "deleteMessage": {
        const message = this.messageFor(conn.userId, frame.messageId);
        this.assertAuthor(conn.userId, message);
        if (message.deletedAt) break; // already gone; saying it twice changes nothing
        // A TOMBSTONE, NOT A HOLE. The row stays where it was, so replies still
        // hang off something, scrollback still counts, and the activity trail is
        // not made to lie about a conversation that really happened. What goes
        // is the content: the words, the files, the @mentions and the reactions.
        for (const a of this.store.releaseAttachments(message.id)) {
          this.store.removeAttachmentBytes(a.storedAs);
        }
        this.store.clearReactions(message.id);
        message.text = "";
        message.mentions = [];
        message.attachments = undefined;
        message.deletedAt = Date.now();
        this.store.saveMessage(message);
        this.auditMessage(conn, message, "message_deleted", "deleted a message");
        this.broadcastMessageUpdate(message);
        break;
      }
      case "thread": {
        const parent = this.messageFor(conn.userId, frame.messageId);
        // asking about a reply gives you the thread it belongs to
        const rootId = parent.replyTo ?? parent.id;
        const root = this.store.message(rootId)!;
        send(conn.ws, {
          type: "thread", parentId: rootId,
          messages: this.hydrate([root, ...this.store.thread(rootId, frame.limit)]),
        });
        break;
      }
      case "uploadAttachment": {
        const channel = this.channelFor(conn.userId, frame.channelId);
        let bytes: Buffer;
        try { bytes = Buffer.from(String(frame.dataBase64 ?? ""), "base64"); }
        catch { throw new Error("that file didn't arrive properly"); }
        // The name rule is `isSafeSkillFileName`, reached through
        // `validateAttachment` — the SAME rule that guards skill files, on
        // purpose. There is no second copy of it to drift.
        const bad = validateAttachment(frame.name, bytes.length);
        if (bad) throw new Error(bad);
        const id = newId("at");
        const storedAs = this.store.writeAttachmentBytes(id, frame.name, bytes);
        const attachment: Attachment = {
          id, name: frame.name, size: bytes.length,
          ...(typeof frame.mime === "string" ? { mime: frame.mime.slice(0, 128) } : {}),
          storedAs, uploadedBy: conn.userId, uploadedAt: Date.now(),
        };
        this.store.saveAttachment(attachment, channel.id);
        // only the uploader is told — nobody else can name this id anyway
        send(conn.ws, { type: "attachment", attachment });
        break;
      }
      case "markRead": {
        const channel = this.channelFor(conn.userId, frame.channelId);
        const ts = typeof frame.ts === "number" ? frame.ts : Date.now();
        const lastReadTs = this.store.markRead(conn.userId, channel.id, ts);
        const entry: UnreadEntry = {
          channelId: channel.id, lastReadTs,
          ...this.store.unreadFor(conn.userId, channel.id, this.myIds(conn.userId)),
        };
        // EVERY machine this person is signed in on, which is the whole point
        this.toUser(conn.userId, { type: "read", entry });
        break;
      }
    }
  }

  /**
   * Audit a change to something already said.
   *
   * Editing and deleting are actions on the record, so they go in the trail
   * (FR-AU-003). An agent's message is credited to the agent, with the person
   * who pressed the button named in the sentence — "the owner deleted it"
   * and "the agent said it" are two different facts and both are kept.
   */
  private auditMessage(
    conn: Conn, message: Message,
    kind: "message_edited" | "message_deleted", what: string,
  ): void {
    const who = this.store.users().find(u => u.id === conn.userId);
    const detail = message.authorKind === "agent"
      ? `${who?.name ?? "someone"} ${what} from ${message.authorName} in channel ${message.channelId}`
      : `${what} in channel ${message.channelId}`;
    this.store.logActivity({
      actorKind: "human", actorId: conn.userId, actorName: who?.name ?? "?",
      kind, refId: message.id, detail,
    });
  }

  /**
   * Who asked for this work.
   *
   * A connection is a PIPE, not a person. The engine host holds one socket and
   * carries the requests of everybody in the house, so "whoever owns this
   * socket" is the wrong answer for anything it relays — that is how a friend's
   * job came out reading "asked by Vikas" (M4).
   *
   * So: only an engine connection may name someone else, the named person must
   * really exist, and they must be able to see the conversation the work happens
   * in. Every other client speaks for itself and cannot name anyone at all.
   */
  private requesterFor(conn: Conn, claimedId: ID | undefined, channel: Channel): User {
    const self = this.store.users().find(u => u.id === conn.userId)!;
    if (!claimedId || claimedId === conn.userId) return self;
    if (conn.client !== "engine") {
      throw new Error("only your own agent engine can ask for work on someone else's behalf");
    }
    const claimed = this.store.user(claimedId);
    if (!claimed) throw new Error("no such person");
    // the same question channelFor asks, asked about THEM: is this their conversation?
    const theirAgents = new Set(
      this.store.agents().filter(a => a.ownerId === claimed.id).map(a => a.id),
    );
    const inChannel = channel.memberIds.includes(claimed.id)
      || channel.memberIds.some(m => theirAgents.has(m));
    if (!inChannel) throw new Error("that person isn't in this conversation");
    return claimed;
  }

  private audit(
    conn: Conn,
    kind: Parameters<Store["logActivity"]>[0]["kind"],
    refId: string,
    detail: string,
    as: { asAgent?: AgentDef; asUser?: User } = {},
  ): void {
    const { asAgent, asUser } = as;
    const user = asUser ?? this.store.users().find(u => u.id === conn.userId);
    this.store.logActivity({
      actorKind: asAgent ? "agent" : "human",
      actorId: asAgent ? asAgent.id : user?.id ?? conn.userId,
      actorName: asAgent ? asAgent.name : user?.name ?? "?",
      kind, refId, detail,
    });
  }

  /**
   * The rules an agent from this connection is checked against.
   *
   * The model list comes from what this user's OWN engine host last reported,
   * so an agent can only be pointed at a model that machine can really run
   * (his 5+6). When no engine has reported yet the list is unknown, and
   * validateAgentInput falls back to the shape check — that check is the
   * injection guard and applies either way, so an unknown list can never widen
   * what is allowed onto a command line.
   */
  private agentRules(conn: Conn, provider?: string): { models?: string[] } {
    const harness = provider === "codex" ? "codex" : "claude";
    return { models: this.harness[conn.userId]?.[harness].models };
  }

  private directory(): { id: ID; name: string }[] {
    return [...this.store.users(), ...this.store.agents()].map(x => ({ id: x.id, name: x.name }));
  }

  private postMessage(message: Message, tempId?: string): void {
    const ch = this.store.channel(message.channelId);
    if (!ch) throw new Error("no such channel");
    this.store.saveMessage(message);
    // A reply bumps the CACHED count on the message that started the thread, and
    // everyone watching is told the root changed — otherwise "12 replies" would
    // only appear after a reload.
    if (message.replyTo) {
      const root = this.store.bumpReplyCount(message.replyTo, message.ts);
      if (root) this.broadcastMessageUpdate(root);
    }
    if (message.authorKind === "agent") {
      this.store.logActivity({
        actorKind: "agent", actorId: message.authorId, actorName: message.authorName,
        kind: "message", refId: message.id,
        detail: `posted in channel ${message.channelId}${message.proactive ? " (proactive)" : ""}`,
      });
    }
    const memberUserIds = this.audienceFor(ch);
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
   * A conversation is announced only to the people in it (P1 #7). Broadcasting
   * every channel to everyone told the whole house who was talking to whom —
   * the member list of a private DM is itself private.
   */
  private broadcastChannel(channel: Channel): void {
    const agents = this.store.agents();
    const audience = new Set<ID>();
    for (const m of channel.memberIds) {
      const agent = agents.find(a => a.id === m);
      audience.add(agent ? agent.ownerId : m);
    }
    for (const conn of this.conns) {
      if (audience.has(conn.userId)) send(conn.ws, { type: "channel", channel });
    }
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

/**
 * Does this task need the owner to say yes first?
 *
 * Answered from the agent's own stored `approvals` setting, plus what KIND of
 * task this is (a schedule request names itself in its title). The client's
 * opinion is not consulted — that was the hole in P1 #6.
 */
export function requiresApproval(agent: AgentDef, title: string): boolean {
  const isSchedule = /^!schedule\b/i.test(title.trim());
  return isSchedule
    ? agent.approvals?.schedules === true
    : agent.approvals?.background === true;
}

/**
 * Keep a skill's files when an edit doesn't mention them.
 *
 * A client that edits a skill's wording sends back name/description/
 * instructions and says nothing about `files` — so a plain overwrite would
 * DELETE the agent's files on every rename. That is silent data loss, and it
 * would be the renderer's bug to make in four places.
 *
 * So the rule lives here instead, once, for every client: `files` absent means
 * "I am not talking about files, leave them alone"; `files: []` means "remove
 * them". Absent and empty are different sentences and are treated differently.
 */
export function keepSkillFiles(
  before: AgentDef["skills"], after: AgentDef["skills"],
): AgentDef["skills"] {
  if (!after) return after;
  const old = new Map((before ?? []).map(s => [s.id, s]));
  return after.map(skill => {
    if (skill.files !== undefined) return skill;
    const previous = old.get(skill.id);
    return previous?.files ? { ...skill, files: previous.files } : skill;
  });
}

/** The plain sentence the owner is shown, built from the stored task title. */
export function describeApproval(title: string): string {
  const t = title.trim();
  const sched = /^!schedule\s+(.+?):\s*(.+)$/i.exec(t);
  if (sched) return `Create schedule (${sched[1]}): ${sched[2]}`;
  return `Run background task: ${t}`;
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
