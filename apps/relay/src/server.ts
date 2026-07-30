// Cloud9 relay — the small always-on hub. All clients (desktop renderer,
// engine host, iPhone app) speak the same WS protocol defined in @cloud9/shared.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  AgentDef, AgentPresenceState, AgentStatus, Approval, Attachment, Channel, ChannelMember,
  ChannelRole, ChannelSummary, ClientFrame, HarnessState, ID, Message,
  MESSAGE_LIMITS, ATTACHMENT_LIMITS, ATTACHMENT_TICKET, Project, PROJECT_LIMITS,
  RunRecord, RUN_RETENTION, APPROVAL_LIMITS,
  SearchHit, ServerFrame, Task, UnreadEntry, User, WorldState,
  agentPresence, describeRemoteAction, detailRemoteAction, validateRemoteActionFacts,
  contentDisposition, downloadContentType, fitRunRecord, isBranchName, isSafeFileName,
  mayAdministerChannel, mayDriveAgent, mustAskBeforeActing, runListEntry,
  setMachineNames, shareableRun,
  extractMentions, nameKey, newId, validateAgentInput, validateAttachment, validateChannelText,
  validateMessageText, validateProjectItem, validateProjectText, validateReactionEmoji,
  validateName, validateRepo, validateRunRecord, validateTaskSummary,
  WS_LIMITS,
} from "@cloud9/shared";
import os from "node:os";
import { RunRow, Store } from "./store.js";

/**
 * The hub runs on somebody's own computer, so its own home folder and account
 * name are exactly the things a run record must not leak. Installing them here
 * means the redactor the hub applies on the way out is a REAL one and not a
 * half-disabled copy — see `redactForSharing` in @cloud9/shared.
 */
try {
  setMachineNames([os.homedir(), os.userInfo().username, os.hostname()]);
} catch { /* best effort — a locked-down machine still gets the path rules */ }
import { secureId } from "./secureid.js";

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
  /**
   * How long a mid-run "may I push this?" card stays answerable. Defaults to
   * the shared ten minutes; tests shorten it. Shortening it can only ever
   * produce MORE expiries, never a yes nobody gave.
   */
  approvalWaitMs?: number;
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
  /**
   * How long a mid-run approval stays answerable, and the one-shot timers that
   * make it die ON TIME rather than the next time somebody happens to read it.
   * Without these a card sits on his screen looking live for as long as nobody
   * opens anything — which is exactly the moment he would click it.
   */
  private approvalWaitMs: number;
  private expiryTimers = new Set<ReturnType<typeof setTimeout>>();
  /** last sign-in request per user, and whether one is still running */
  private signInAt: Record<ID, number> = {};
  private signInFlight: Record<ID, number> = {};

  /**
   * Unspent tickets to fetch one file. IN MEMORY ON PURPOSE, never in the
   * database: this is a credential, and a credential that survives a restart is
   * a credential somebody has to remember to expire. These die with the process,
   * with the clock, and with their first use — whichever comes first.
   */
  private tickets = new Map<string, { attachmentId: ID; userId: ID; expiresAt: number }>();

  constructor(opts: RelayOptions = {}) {
    this.ownerToken = opts.ownerToken ?? process.env.CLOUD9_OWNER_TOKEN ?? "dev-owner-token";
    // The store is opened with the owner's token IN HAND. The membership
    // backfill has to decide who runs each existing room, and it used to guess
    // from the first row of `tokens` — which on a differently-ordered file made
    // a guest the owner of every room and demoted Vikas in his own Cloud9.
    // Opening comes first now, and if the file cannot be read the error says
    // which file and why rather than a bare SQLite message.
    this.store = new Store(opts.dbPath ?? "cloud9-relay.db", { ownerToken: this.ownerToken });
    for (const problem of this.store.problems) {
      console.warn(`[cloud9] ${problem}`);
    }
    this.ownerName = opts.ownerName ?? process.env.CLOUD9_OWNER_NAME ?? "Vikas";
    this.bind = resolveBind(opts.bind ?? process.env.CLOUD9_BIND);
    this.devMode = opts.devMode ?? process.env.CLOUD9_DEV === "1";
    this.approvalWaitMs = opts.approvalWaitMs ?? APPROVAL_LIMITS.waitMs;
    // Owner exists from first boot; a default #general channel too.
    const owner = this.store.ensureOwner(this.ownerName, this.ownerToken);
    this.ownerId = owner.id;
    if (this.store.channels().length === 0) {
      const general: Channel = {
        id: newId("ch"), name: "general", kind: "channel",
        memberIds: [owner.id], createdAt: Date.now(),
      };
      this.store.createChannel(general);
      // whoever runs this Cloud9 runs its first room
      this.store.setMemberRole(general.id, owner.id, "owner");
    }
    this.server = http.createServer((req, res) => {
      if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
      const at = attachmentTicketFrom(req);
      if (at !== undefined) { this.serveAttachment(at, req, res); return; }
      res.writeHead(404); res.end();
    });
    // A SIZE LIMIT THE SOCKET ITSELF ENFORCES. Every other rule in this app
    // checks a size AFTER the frame has been received and parsed, which is too
    // late — by then the hub has already held whatever was sent in memory to
    // find out how big it was. `maxPayload` refuses an oversized frame before
    // that, so a guest cannot make the hub read a gigabyte to be told no.
    this.wss = new WebSocketServer({ server: this.server, maxPayload: WS_LIMITS.maxPayloadBytes });
    this.wss.on("connection", ws => this.onConnection(ws));
    // Files that were uploaded and never sent are nobody's but their
    // uploader's, so nothing was ever going to reclaim them. Swept at every
    // start, and again on each upload, so the disk cannot fill with drafts.
    this.store.sweepParkedAttachments(Date.now() - ATTACHMENT_LIMITS.parkedTtlMs);
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
    for (const t of this.expiryTimers) clearTimeout(t);
    this.expiryTimers.clear();
    for (const t of this.looking.values()) clearTimeout(t);
    this.looking.clear();
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
        // THE SAME REASONING, APPLIED TO THE LAMP. The last idle/working/braked
        // an engine reported is a claim about a machine nobody is watching any
        // more, and keeping it meant an engine that died mid-turn left its agent
        // "working" for ever. Dropped, and everyone is told what is true now:
        // nobody can run these agents.
        for (const agent of this.store.agents()) {
          if (agent.ownerId === conn.userId) delete this.agentStatus[agent.id];
        }
        this.announcePresenceForOwner(conn.userId);
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
        // one person added, by name. Handing a lengthened member list to
        // `saveChannel` used to do this, and it reconciled the WHOLE room
        // against that snapshot on the way through.
        this.store.addChannelMember(general.id, user.id, { role: "member" });
        this.broadcastChannel(this.store.channel(general.id)!);
      }
      this.broadcast({ type: "userJoined", user });
    }
    if (!user) { send(ws, { type: "error", error: "bad token" }); ws.close(); return undefined; }
    const conn: Conn = { ws, userId: user.id, client: frame.client };
    this.conns.add(conn);
    send(ws, { type: "welcome", state: this.worldFor(user.id) });
    // An engine arriving changes the answer for every agent it can run, and
    // everyone in a room with those agents needs to hear it — not only the
    // owner. This is the other half of the disconnect rule above.
    if (conn.client === "engine") this.announcePresenceForOwner(user.id);
    return conn;
  }

  // -------------------------------------------------------------------------
  // CAN THIS AGENT ACTUALLY BE USED RIGHT NOW? (his item 2 — a BUG)
  //
  // WHAT THE HUB REALLY KNEW BEFORE THIS, verified by reading every write to
  // `agentStatus`:
  //   * `this.agentStatus` was written in exactly ONE place — an engine sending
  //     an `agentStatus` frame — and was never seeded and never cleared. So a
  //     hub that had just started knew NOTHING about any agent, and a client
  //     asking "is this agent available?" got `undefined`.
  //   * It was never cleared when the engine went away either, so a "working"
  //     left behind by an engine that died mid-turn was reported forever, about
  //     a machine nobody was watching.
  //   * `this.harness[ownerId]` (installed / signedIn, per app) WAS known and
  //     nothing ever consulted it when answering "is this agent available".
  //   * Whether the owner's engine host is connected at all WAS known
  //     (`hasEngine`) and nothing consulted that either.
  //
  // So the hub had the facts and no rule. The rule now lives in ONE function in
  // shared (`agentPresence`); everything here is fact-gathering and telling
  // people. Nothing below invents a status: every field handed to that function
  // is an observed fact or is absent.
  // -------------------------------------------------------------------------

  /** Everything the hub genuinely knows about one agent, turned into presence. */
  private presenceFor(agent: AgentDef): AgentPresenceState {
    const reported = this.harness[agent.ownerId];
    const info = reported?.[agent.provider === "codex" ? "codex" : "claude"];
    const status = this.agentStatus[agent.id] ?? "idle";
    const { presence, reason } = agentPresence(agent, {
      engineConnected: this.hasEngine(agent.ownerId),
      ...(info ? { harness: info } : {}),
      status,
    });
    return { agentId: agent.id, presence, reason, status, updatedAt: Date.now() };
  }

  /** Presence for every agent in this Cloud9 — what the opening frame carries. */
  private presenceMap(): Record<ID, AgentPresenceState> {
    const out: Record<ID, AgentPresenceState> = {};
    for (const agent of this.store.agents()) out[agent.id] = this.presenceFor(agent);
    return out;
  }

  /**
   * Tell everyone that the answer changed for these agents.
   *
   * ONE broadcaster, called from every event that can change the answer — an
   * engine arriving or leaving, a harness report, a lamp, an agent being made
   * or edited. A second place that broadcast this frame would be a second place
   * that could compute presence differently.
   */
  private announcePresence(agents: AgentDef[]): void {
    for (const agent of agents) {
      const p = this.presenceFor(agent);
      this.broadcast({
        type: "agentStatus", agentId: agent.id,
        status: p.status, presence: p.presence, reason: p.reason,
      });
    }
  }

  /** The same, for everything one person owns — used when their engine moves. */
  private announcePresenceForOwner(userId: ID): void {
    this.announcePresence(this.store.agents().filter(a => a.ownerId === userId));
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
      // …and the same fact in words a person can act on, for every agent —
      // including the ones nobody has ever reported a lamp for, which used to
      // be every agent on a hub that had just started.
      presence: this.presenceMap(),
      tasks: this.store.tasks(),
      // Swept FIRST, so nobody is ever handed a card that is already dead and
      // invited to click Approve on it.
      approvals: this.visibleApprovals(userId),
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
   * The room names this person would see clashing — the answer the naming rule
   * needs for "you already have one of these".
   *
   * It is what he CAN SEE, not every room in the database: two rooms with the
   * same name in two groups that never meet are not a confusion he can suffer,
   * and refusing the second would be telling him about a room he is not allowed
   * to know exists. Direct conversations are left out because their names are
   * machine-made, never typed.
   *
   * A room ARCHIVED is deliberately still counted. It is still in his sidebar,
   * it can still be reopened, and two rooms called `#goa-trip` would still be
   * two rows he cannot tell apart.
   */
  private namedChannels(userId: ID): string[] {
    return this.visibleChannels(userId).filter(c => c.kind !== "dm").map(c => c.name);
  }

  /**
   * The rooms you could join — open, not archived, and not already yours.
   *
   * DELIBERATELY NOT PART OF `visibleChannels` (§7 suggested folding it in
   * there; this does not). `visibleChannels` is what `channelFor` is built on,
   * so widening it would have quietly made every open room readable and
   * postable by everyone in this Cloud9 without anybody joining anything — one
   * edit, seven authorisation paths changed. Browsing is a different question
   * from membership and gets its own, smaller answer: a name, a description,
   * and a count. Never a member list, never a message. Joining is what turns a
   * listing into membership, and from then on the ordinary gate applies.
   */
  private browsableChannels(userId: ID): ChannelSummary[] {
    const mine = new Set(this.visibleChannels(userId).map(c => c.id));
    return this.store.channels()
      .filter(c => c.kind === "channel" && c.visibility === "open" && !c.archivedAt && !mine.has(c.id))
      .map(c => ({
        id: c.id, name: c.name,
        ...(c.description ? { description: c.description } : {}),
        ...(c.topic ? { topic: c.topic } : {}),
        memberCount: c.memberIds.length, createdAt: c.createdAt,
      }));
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
   * The project this connection is allowed to act on, or an error.
   *
   * The same law as `myAgent`, deliberately shaped the same way: a project runs
   * through its owner's machine and their GitHub sign-in, so ownership is read
   * from what is STORED and never from the frame. "no such project" is the
   * answer for somebody else's project as well as an invented id, so an id
   * cannot be probed.
   */
  private myProject(userId: ID, projectId: ID): Project {
    const project = this.store.project(projectId);
    if (!project || project.ownerId !== userId) throw new Error("no such project");
    return project;
  }

  /* ---------------- looking at GitHub, and knowing when we are ----------------
   *
   * ONE OWNER FOR "IS SOMEBODY LOOKING RIGHT NOW", and it is these three
   * methods. The hub cannot reach GitHub — it asks the owner's own engine and
   * waits — so it is the only party that knows a look is in flight, and it is
   * the only one that should be saying so. A screen that started its own
   * spinner would have no way to end it when the engine died.
   *
   * It is deliberately NOT stored. "A look is under way" is true of this hub at
   * this moment; written to the database it would come back a lie after a
   * restart, and law 8 says absent means absent.
   */

  /** the projects an engine has been asked about and has not answered for yet */
  private looking = new Map<ID, ReturnType<typeof setTimeout>>();

  /** Every project leaves the hub through here, so "looking" cannot be forgotten. */
  private viewProject(project: Project): Project {
    return this.looking.has(project.id) ? { ...project, looking: true } : project;
  }

  /**
   * Ask this owner's engine to go and look. Refuses rather than pretending in
   * the two cases where nothing can actually happen.
   */
  private startLook(userId: ID, project: Project): void {
    if (this.looking.has(project.id)) {
      throw new Error("Cloud9 is already looking at that repository — give it a moment");
    }
    if (!this.hasEngine(userId)) {
      // NOT A SILENT NO-OP, and not a spinner either. The failure is written on
      // the project in words, exactly like a failure gh reported, so the screen
      // has something true to print. `syncedAt` is deliberately NOT touched:
      // nobody looked, so nothing was looked at.
      project.problem = "Cloud9 isn't running on the computer this repository lives on, so nothing could ask GitHub. Open Cloud9 there and try again.";
      this.store.saveProject(project);
      this.toUser(userId, { type: "project", project: this.viewProject(project) });
      throw new Error(project.problem);
    }
    const timer = setTimeout(
      () => this.lookRanOut(userId, project.id), PROJECT_LIMITS.lookMs);
    // a pending look must never be the reason this process refuses to exit
    (timer as unknown as { unref?: () => void }).unref?.();
    this.looking.set(project.id, timer);
    this.toEngines(userId, { type: "lookAtProject", projectId: project.id, repo: project.repo });
    this.toUser(userId, { type: "project", project: this.viewProject(project) });
  }

  /**
   * LOOK AT A REPOSITORY THE MOMENT IT IS CONNECTED — and never let that look
   * be the reason connecting failed.
   *
   * Phase 5 (C12) connected `definitely-not-a-real-owner-xyz987/nope` and the
   * form closed happily; the row then said "Not looked at GitHub yet" for ever,
   * which is word for word what a correctly-typed repository says. A typo and a
   * real repository were indistinguishable, permanently.
   *
   * TWO ANSWERS THAT MUST NOT BE CONFUSED, and this is why the throw is
   * swallowed rather than passed on:
   *  • "GitHub has no repository called that" — the engine's own sentence, on
   *    the project, after a real look. He should fix the name.
   *  • "we could not check" — no engine on this machine, gh missing, network
   *    down. `startLook` has already written that sentence on the project, and
   *    it reads completely differently. He should NOT be stopped from
   *    connecting: not being able to ask is not the same as the answer being no.
   */
  private lookOnConnect(userId: ID, project: Project): void {
    try {
      this.startLook(userId, project);
    } catch {
      // `startLook` already said why, in words, on the project itself. The
      // connect stands.
    }
  }

  /** The engine answered (or the project went away). Stop saying "looking". */
  private endLook(projectId: ID): void {
    const timer = this.looking.get(projectId);
    if (timer) clearTimeout(timer);
    this.looking.delete(projectId);
  }

  /** Nobody came back. Say so in words rather than spinning for ever. */
  private lookRanOut(userId: ID, projectId: ID): void {
    this.endLook(projectId);
    const project = this.store.project(projectId);
    if (!project || project.ownerId !== userId) return;
    project.problem = "the look at GitHub never finished — Cloud9 on this computer stopped answering. Try again.";
    this.store.saveProject(project);
    this.toUser(userId, { type: "project", project: this.viewProject(project) });
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

  /**
   * Put one emoji on one message, or take it off — for a person OR an agent.
   *
   * ONE BODY, TWO CALLERS. `react` passes the person on the socket; `agentReact`
   * passes an agent that `myAgent` has already proved belongs to them. Every
   * gate below is asked once, here, so "an agent reacts" can never become a
   * cheaper path than "a person reacts": the conversation must be one THIS
   * connection can post in, an archived room is still read-only, and a
   * tombstone still has nothing left to react to.
   */
  private setReaction(
    conn: Conn, messageId: ID, reactorId: ID, emoji: string, on: boolean | undefined,
  ): void {
    const message = this.messageFor(conn.userId, messageId);
    this.writableChannel(conn.userId, message.channelId); // an archived room is read-only
    if (message.deletedAt) throw new Error("that message was deleted");
    const bad = validateReactionEmoji(emoji);
    if (bad) throw new Error(bad);
    // idempotent by the reactions table's primary key, not by hoping the client
    // only pressed once
    const userIds = this.store.setReaction(message.id, reactorId, emoji, on !== false);
    const ch = this.store.channel(message.channelId)!;
    const audience = this.audienceFor(ch);
    for (const c of this.conns) {
      if (audience.has(c.userId)) {
        send(c.ws, {
          type: "reaction", channelId: ch.id, messageId: message.id, emoji, userIds,
        });
      }
    }
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

  // -------------------------------------------------------------------------
  // Handing a file's bytes back — the one thing this relay does over plain
  // HTTP rather than over the socket.
  //
  // THE DECISION, WRITTEN DOWN (docs/plans/chat-basics-handoff.md §6 left this
  // open, and it was right to: "a token in a URL is a credential in a log
  // line"). The rule we are keeping is that a connection is authorised ONCE,
  // as a person, and everything else is decided from what is stored about that
  // person. So:
  //
  //   1. There is NO second way to sign in. The `attachmentTicket` frame is
  //      asked for on the socket that already said `hello`, and the answer is
  //      authorised by `channelFor` — the same gate that decides whether you
  //      may read the conversation the file was posted in. No header, no query
  //      parameter and no cookie carries a durable token, ever.
  //   2. What travels in the URL is not a credential to this Cloud9. It is a
  //      ticket to ONE file, good for thirty seconds, and it is spent by the
  //      first request that presents it. Copied out of a log line, a proxy
  //      trace or a screen recording it is already worthless — that is what
  //      "safe by construction" means here, rather than "we promise not to log
  //      it", which is a promise about somebody else's software.
  //   3. Permission is checked TWICE, and the second time is the one that
  //      counts: at mint AND at redeem, both times through `channelFor` on
  //      stored state. Being thrown out of a room in those thirty seconds
  //      stops the download.
  //
  // This is also why it does not become a hole the moment the hub binds a
  // private-network address (backend-decision.md #2): reaching the port still
  // buys nothing without a ticket, and a ticket cannot be obtained without an
  // authenticated socket that is already a member.
  // -------------------------------------------------------------------------

  /** Mint the one-use ticket. Only ever called after `channelFor` has passed. */
  private mintTicket(userId: ID, attachmentId: ID): { ticket: string; expiresAt: number } {
    const now = Date.now();
    for (const [key, t] of this.tickets) if (t.expiresAt <= now) this.tickets.delete(key);
    let mine = 0;
    for (const t of this.tickets.values()) if (t.userId === userId) mine++;
    if (mine >= ATTACHMENT_TICKET.perUser) {
      throw new Error("too many files being opened at once — try again in a moment");
    }
    // Secret-grade randomness: this string is the only thing between a request
    // and somebody's file, so it comes from the same place invite codes do —
    // `secureId`, never `newId`, which is `Math.random()` and a clock.
    const ticket = secureId("tk");
    const expiresAt = now + ATTACHMENT_TICKET.ttlMs;
    this.tickets.set(ticket, { attachmentId, userId, expiresAt });
    return { ticket, expiresAt };
  }

  /**
   * Redeem a ticket and hand over the bytes.
   *
   * Every refusal answers 404 with the same sentence. A 403 here would tell an
   * unauthenticated stranger the difference between "no such file" and "a file
   * you may not have", which is itself something they did not know.
   */
  private serveAttachment(ticket: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    // The one response in this hub that a browser page on another origin may
    // read. See `attachmentCors` for why that is safe here and nowhere else.
    // It goes on the REFUSAL too: the app re-tickets when a link has expired,
    // and it can only do that if it is allowed to see the 404 it got.
    const cors = attachmentCors(req);
    const nope = () => {
      res.writeHead(404, {
        "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...cors,
      });
      res.end("that link has expired — open the file again");
    };
    // SPENT FIRST, before anything can go wrong and leave it alive. One use is
    // a property of this line, not of the checks below it.
    const held = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    if (!held || held.expiresAt <= Date.now()) { nope(); return; }

    const row = this.store.attachment(held.attachmentId);
    if (!row) { nope(); return; }
    // THE SAME GATE, ASKED AGAIN, NOW. Not a copy of it — the function itself.
    try { this.channelFor(held.userId, row.channelId); } catch { nope(); return; }

    const file = row.attachment;
    // The name was checked by `isSafeFileName` before it was stored. It is
    // checked again on the way out, because a row could have been written by an
    // older build, and because it is about to become a header and a file name on
    // somebody's disk. Same rule, one owner, no second copy of it anywhere.
    if (!isSafeFileName(file.name)) { nope(); return; }
    const stored = path.join(this.store.attachmentsDir, path.basename(file.storedAs));
    const root = path.resolve(this.store.attachmentsDir);
    if (path.resolve(stored) !== path.join(root, path.basename(file.storedAs))) { nope(); return; }

    let size: number;
    try {
      const stat = fs.statSync(stored);
      if (!stat.isFile()) { nope(); return; }
      size = stat.size;
    } catch { nope(); return; }
    // the same ceiling the upload was held to — a file that grew on disk since
    // is not a file this hub agreed to serve
    if (size > ATTACHMENT_LIMITS.bytes) { nope(); return; }

    // The type is computed from the NAME, never from the `mime` the sender
    // claimed (see `downloadContentType`). `nosniff` stops a browser deciding
    // it knows better, and the sandbox/CSP pair means that even the types we do
    // serve inline cannot become a running page inside the app.
    res.writeHead(200, {
      "content-type": downloadContentType(file.name),
      "content-length": String(size),
      // ONE OWNER for how a name becomes a header. It has to survive the
      // non-English names the file rule now (correctly) allows — a header is
      // Latin-1, so a Devanagari name in a plain `filename=` would throw.
      "content-disposition": contentDisposition(file.name),
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "no-store",
      ...cors,
    });
    fs.createReadStream(stored).pipe(res);
  }

  // -------------------------------------------------------------------------
  // Channels as real things (§7)
  // -------------------------------------------------------------------------

  /**
   * A conversation you may WRITE in.
   *
   * `channelFor` answers "is this yours to read". Archiving adds a second
   * question — "is it still open for business" — and it is asked HERE, once,
   * so every path that puts something new into a room asks it and no future
   * one can forget to. Reading an archived room is still allowed; that is the
   * whole point of archiving rather than deleting.
   */
  private writableChannel(userId: ID, channelId: ID): Channel {
    const channel = this.channelFor(userId, channelId);
    if (channel.archivedAt) throw new Error("that conversation is archived — nothing new can be said in it");
    return channel;
  }

  /**
   * A conversation you may ADMINISTER — set the topic, invite, remove, archive.
   *
   * Read from the stored membership row's role, never from anything a client
   * said about itself. A direct conversation has nothing to administer, so it
   * refuses outright rather than inventing a role for it.
   */
  private adminChannel(userId: ID, channelId: ID, need: "admin" | "owner" = "admin"): Channel {
    const channel = this.channelFor(userId, channelId);
    if (channel.kind === "dm") throw new Error("a direct conversation has no settings to change");
    const role = this.store.memberRole(channel.id, userId);
    const ok = need === "owner" ? role === "owner" : mayAdministerChannel(role);
    if (!ok) {
      throw new Error(need === "owner"
        ? "only the person who runs this conversation can do that"
        : "you don't run this conversation");
    }
    return channel;
  }

  /**
   * May these ids be put in a room whose people are `present`?
   *
   * THE ONE PLACE THAT ASKS IT, for creating a room and for adding to one
   * alike. An agent carries its owner's SIGHT of the room in with it —
   * `visibleChannels` counts a room as yours when an agent of yours is in it —
   * so putting a stranger's agent somewhere quietly puts the stranger there,
   * with nothing on screen saying a person arrived. Two copies of this rule
   * would be one copy away from drifting, so there is one.
   */
  private assertMayAdd(byUserId: ID, memberIds: ID[], present: Set<ID>): void {
    const agents = this.store.agents();
    for (const memberId of memberIds) {
      const agent = agents.find(a => a.id === memberId);
      if (!agent) continue; // a person is a person; that is the ordinary case
      if (agent.ownerId === byUserId) continue;
      if (present.has(agent.ownerId)) continue;
      throw new Error("that agent's owner isn't in this conversation — invite them first");
    }
  }

  /** Tell one person's machines they are out of a room, so they stop drawing it. */
  private tellLeft(userId: ID, channelId: ID): void {
    this.toUser(userId, { type: "channelLeft", channelId });
  }

  private handleFrame(conn: Conn, frame: ClientFrame): void {
    switch (frame.type) {
      case "send": {
        const user = this.store.users().find(u => u.id === conn.userId)!;
        const channel = this.writableChannel(conn.userId, frame.channelId); // you may only post where you are
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
        const channel = this.writableChannel(conn.userId, frame.channelId);
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
        const agent = this.myAgent(conn.userId, frame.agentId); // nobody sets someone else's lamp
        if (frame.status !== "idle" && frame.status !== "working" && frame.status !== "braked") {
          throw new Error("that isn't a status");
        }
        this.agentStatus[frame.agentId] = frame.status;
        // The lamp is what the engine SAID; presence is what the hub can back
        // up. One frame carries both, so nothing has to ask twice.
        this.announcePresence([agent]);
        break;
      }
      case "createChannel": {
        const memberIds = Array.from(new Set([conn.userId, ...frame.memberIds]));
        const kind = frame.kind ?? (frame.memberIds.length === 1 ? "dm" : "channel");
        // A DIRECT CONVERSATION IS BETWEEN TWO PEOPLE, at the moment it is made
        // as much as ever after. `addMembers` refuses to make a third; a room
        // that was BORN with three and calls itself a DM would be a room with
        // no settings, no owner and nobody able to change any of it.
        if (kind === "dm" && memberIds.length !== 2) {
          throw new Error("a direct conversation is between two people — make a room instead");
        }
        // THE NAMING RULE, at the hub, because the screen is not a boundary.
        // Before this the channel box had no length cap, no uniqueness rule and
        // no "is this actually a name" rule at all — six spaces became a room
        // literally called `-`, and a second `#goa-trip` sat beside the first.
        // A DIRECT CONVERSATION IS EXEMPT FROM THE DUPLICATE QUESTION only:
        // its name is machine-made ("dm-priya") and two people may legitimately
        // produce the same one, which `dmBetween` above already resolves to a
        // single room. Its shape is still checked, like everything else.
        const badName = validateName("channel", frame.name,
          kind === "dm" ? undefined : this.namedChannels(conn.userId));
        if (badName) throw new Error(badName);
        // the same rule adding uses: an agent may not drag its owner in behind it
        this.assertMayAdd(conn.userId, memberIds, new Set(memberIds.filter(id =>
          this.store.users().some(u => u.id === id))));
        // A direct conversation is FOUND or created, never duplicated (his 15).
        // Clicking a person twice must land in the same place both times.
        if (kind === "dm" && memberIds.length === 2) {
          const existing = this.store.dmBetween(memberIds[0], memberIds[1]);
          if (existing) { send(conn.ws, { type: "channel", channel: existing }); break; }
        }
        const channel: Channel = {
          id: newId("ch"), name: frame.name, kind, memberIds, createdAt: Date.now(),
        };
        // `by` records who let each of these people in — the `invitedBy` an id
        // array could never hold. Everyone else is a plain member. This is the
        // ONE call that turns a member list into rows, and it only applies to a
        // room that did not exist a moment ago.
        this.store.createChannel(channel, conn.userId);
        // whoever made a room runs it; a direct conversation has no owner
        if (kind !== "dm") this.store.setMemberRole(channel.id, conn.userId, "owner");
        this.audit(conn, "channel_created", channel.id, `created ${channel.kind} ${channel.name}`);
        this.broadcastChannel(this.store.channel(channel.id)!);
        break;
      }
      case "addMembers": {
        // LETTING SOMEBODY INTO A ROOM IS ADMINISTERING IT. This was the one
        // channel-administration frame still on `writableChannel` — the gate
        // that only asks "are you in here" — while setting a topic, changing
        // who may find the room, archiving it and removing people had all moved
        // to `adminChannel`. So any member could hand a private room's entire
        // scrollback to anyone: a guest in a direct conversation added a third
        // person and they read it, and a plain member added somebody else's
        // agent to a private board, which let that agent's OWNER read the room
        // too, with nothing on screen saying a person had been let in.
        //
        // `adminChannel` also refuses a direct conversation outright, which is
        // the right answer and not a special case: a DM is between two people
        // by definition. There is no second gate here — it is the same one
        // every other administration frame goes through.
        const ch = this.adminChannel(conn.userId, frame.channelId);
        if (ch.archivedAt) throw new Error("that conversation is archived — nobody new can be added to it");

        const live = new Set(this.store.channel(ch.id)!.memberIds);
        for (const memberId of new Set(frame.memberIds)) {
          // AN AGENT CARRIES ITS OWNER IN WITH IT — the same rule creating a
          // room asks, asked here by the same function.
          this.assertMayAdd(conn.userId, [memberId], live);
          this.store.addChannelMember(ch.id, memberId, { role: "member", invitedBy: conn.userId });
          live.add(memberId);
        }
        this.audit(conn, "member_added", ch.id, `added ${frame.memberIds.length} member(s) to ${ch.name}`);
        this.broadcastChannel(this.store.channel(ch.id)!);
        break;
      }
      // ---- §7: a room is a thing that can be described, opened and retired ----
      case "setChannelInfo": {
        const ch = this.adminChannel(conn.userId, frame.channelId);
        for (const [what, value] of [["description", frame.description], ["topic", frame.topic]] as const) {
          const bad = validateChannelText(value, what);
          if (bad) throw new Error(bad);
        }
        // ABSENT means "I am not talking about this field", empty string means
        // "clear it" — the same sentence-vs-silence rule as `keepSkillFiles`.
        if (frame.description !== undefined) {
          ch.description = frame.description === "" ? undefined : frame.description;
        }
        if (frame.topic !== undefined) {
          ch.topic = frame.topic === "" ? undefined : frame.topic;
          ch.topicSetBy = conn.userId;
          ch.topicSetAt = Date.now();
        }
        this.store.saveChannel(ch);
        this.audit(conn, "channel_updated", ch.id,
          frame.topic !== undefined ? `set the topic of ${ch.name}` : `described ${ch.name}`);
        this.broadcastChannel(this.store.channel(ch.id)!);
        break;
      }
      case "setChannelVisibility": {
        if (frame.visibility !== "open" && frame.visibility !== "private") {
          throw new Error("a conversation is either open or private");
        }
        const ch = this.adminChannel(conn.userId, frame.channelId);
        ch.visibility = frame.visibility;
        this.store.saveChannel(ch);
        this.audit(conn, "channel_updated", ch.id,
          `made ${ch.name} ${frame.visibility === "open" ? "open to anyone here" : "private"}`);
        this.broadcastChannel(this.store.channel(ch.id)!);
        break;
      }
      case "archiveChannel": {
        const ch = this.adminChannel(conn.userId, frame.channelId);
        if (frame.archived) {
          ch.archivedAt = Date.now();
          ch.archivedBy = conn.userId;
        } else {
          ch.archivedAt = undefined;
          ch.archivedBy = undefined;
        }
        this.store.saveChannel(ch);
        this.audit(conn, "channel_archived", ch.id,
          `${frame.archived ? "archived" : "reopened"} ${ch.name}`);
        this.broadcastChannel(this.store.channel(ch.id)!);
        break;
      }
      case "browseChannels": {
        send(conn.ws, { type: "channelDirectory", channels: this.browsableChannels(conn.userId) });
        break;
      }
      case "joinChannel": {
        // NOT `channelFor` — the whole point is that you are not in it yet. So
        // the question this asks is the narrow one: is this room one of the
        // ones you were allowed to FIND? Anything else is refused with the same
        // sentence a made-up id gets, so browsing cannot become a way to learn
        // which private rooms exist.
        const listed = this.browsableChannels(conn.userId).some(c => c.id === frame.channelId);
        if (!listed) throw new Error("no such channel");
        const ch = this.store.channel(frame.channelId)!;
        this.store.addChannelMember(ch.id, conn.userId, { role: "member" });
        this.audit(conn, "member_added", ch.id, `joined ${ch.name}`);
        // everyone in the room, including the new arrival, learns the new
        // member list; the newcomer then asks for scrollback the ordinary way
        this.broadcastChannel(this.store.channel(ch.id)!);
        break;
      }
      case "leaveChannel": {
        const ch = this.channelFor(conn.userId, frame.channelId);
        if (ch.kind === "dm") throw new Error("you can't leave a direct conversation");
        if (!this.store.memberRole(ch.id, conn.userId)) throw new Error("you're not in that conversation");
        this.store.removeChannelMember(ch.id, conn.userId, conn.userId);
        this.audit(conn, "member_removed", ch.id, `left ${ch.name}`);
        this.tellLeft(conn.userId, ch.id);
        this.broadcastChannel(this.store.channel(ch.id)!);
        break;
      }
      case "removeMember": {
        const ch = this.adminChannel(conn.userId, frame.channelId);
        const role = this.store.memberRole(ch.id, frame.memberId);
        if (!role) throw new Error("they're not in that conversation");
        // an admin cannot throw out the person who runs the room
        if (role === "owner" && this.store.memberRole(ch.id, conn.userId) !== "owner") {
          throw new Error("only the person who runs this conversation can do that");
        }
        this.store.removeChannelMember(ch.id, frame.memberId, conn.userId);
        this.audit(conn, "member_removed", ch.id, `removed someone from ${ch.name}`);
        // an agent's place in a room belongs to its owner's screen
        const agent = this.store.agents().find(a => a.id === frame.memberId);
        this.tellLeft(agent ? agent.ownerId : frame.memberId, ch.id);
        this.broadcastChannel(this.store.channel(ch.id)!);
        break;
      }
      case "setMemberRole": {
        if (frame.role !== "owner" && frame.role !== "admin" && frame.role !== "member") {
          throw new Error("that isn't a role");
        }
        const ch = this.adminChannel(conn.userId, frame.channelId, "owner");
        if (!this.store.memberRole(ch.id, frame.memberId)) {
          throw new Error("they're not in that conversation");
        }
        // A room always has someone who runs it. Standing down is done by
        // handing the room to somebody else, never by leaving it ownerless.
        if (frame.memberId === conn.userId && frame.role !== "owner") {
          throw new Error("give this conversation to someone else before standing down");
        }
        this.store.setMemberRole(ch.id, frame.memberId, frame.role as ChannelRole);
        this.audit(conn, "member_role_changed", ch.id, `changed a role in ${ch.name}`);
        this.broadcastChannel(this.store.channel(ch.id)!);
        break;
      }
      case "channelMembers": {
        // same gate as reading the conversation: knowing who is in a room is
        // knowing something about the room
        const ch = this.channelFor(conn.userId, frame.channelId);
        const members: ChannelMember[] = frame.at !== undefined
          ? this.store.channelMembers(ch.id, { at: frame.at })
          : this.store.channelMembers(ch.id);
        send(conn.ws, {
          type: "channelMembers", channelId: ch.id,
          ...(frame.at !== undefined ? { at: frame.at } : {}),
          members,
        });
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
        // a brand-new agent has a presence from its first second, so the rail
        // never has to draw a row it knows nothing about
        this.announcePresence([agent]);
        break;
      }
      case "updateAgent": {
        const existing = this.myAgent(conn.userId, frame.agent.id);
        // AN AGENT KEEPING ITS OWN NAME IS NOT A DUPLICATE, and this is the
        // line that protects his EXISTING data. Two agents already called
        // `Scout` are in his database right now; asked the uniqueness question
        // afresh, saving either of them would fail for ever and he could never
        // edit his way out of it. So the question is only asked when the name
        // is actually being CHANGED — a rename must not collide, a save must
        // not be refused for a clash that was already there.
        const renaming = typeof frame.agent.name === "string"
          && nameKey(frame.agent.name) !== nameKey(existing.name);
        const bad = validateAgentInput(frame.agent, renaming
          ? this.agentRules(conn, frame.agent.provider, frame.agent.id)
          : { ...this.agentRules(conn, frame.agent.provider), takenNames: undefined });
        if (bad) throw new Error(bad);
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
        // pausing an agent IS a presence change — this is the path his "paused"
        // state actually travels down
        this.announcePresence([saved]);
        break;
      }
      case "deleteAgent": {
        const existing = this.myAgent(conn.userId, frame.agentId);
        this.store.deleteAgent(frame.agentId);
        // a deleted agent's lamp is not a fact about anything any more
        delete this.agentStatus[frame.agentId];
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
        for (const a of theirAgents) {
          delete this.agentStatus[a.id];
          this.broadcast({ type: "agentDeleted", agentId: a.id });
        }
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
          this.sendApproval(approval);
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
        // WHAT ACTUALLY HAPPENED, in the agent's own words (his item 3). It is
        // stored and broadcast like any other task field and goes through the
        // gate that already exists two lines up — an engine may only write a
        // summary onto a job belonging to an agent it owns. There is no second
        // authorisation path and no new frame.
        const badSummary = validateTaskSummary(frame.summary);
        if (badSummary) throw new Error(badSummary);
        if (task.status === "cancelled") break; // FR-TS-005: cancelled stays cancelled
        task.status = frame.status;
        if (frame.result !== undefined) task.result = frame.result;
        if (frame.error !== undefined) task.error = frame.error;
        // ABSENT means "leave it alone"; "" means "clear it" — the same
        // sentence-vs-silence rule `setChannelInfo` and `keepSkillFiles` use.
        // Nothing here ever writes a summary of its own: a job with nothing
        // honest to say keeps none, and the screen shows nothing.
        if (frame.summary !== undefined) {
          const said = frame.summary.trim();
          if (said) task.summary = said; else delete task.summary;
        }
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
      // ---- an agent is MID-RUN and has reached something that leaves this PC ----
      //
      // ONE ENTITY, ONE ANSWER. This mints the same `Approval` a delegated job
      // mints and it is answered by the same `decideApproval` below. The only
      // thing that is new is WHEN it is asked: while the agent is standing
      // there, with a real branch and a real diff to describe.
      case "askApproval": {
        // ENGINE ONLY — the same law as `recordRun`. A desktop client able to
        // mint approval cards could manufacture a harmless-looking one and then
        // approve it with its own second frame.
        if (conn.client !== "engine") {
          throw new Error("only the engine can ask to do something outside this computer");
        }
        // WHOSE AGENT and WHICH ROOM, both from stored state, never the frame.
        const agent = this.myAgent(conn.userId, frame.agentId);
        const channel = this.channelFor(conn.userId, frame.channelId);
        const bad = validateRemoteActionFacts(frame.facts);
        if (bad) throw new Error(bad);
        const askId = typeof frame.askId === "string"
          ? frame.askId.slice(0, APPROVAL_LIMITS.askId).trim() : "";
        if (!askId) throw new Error("that request has no label to answer against");
        // ONE OWNER FOR "MUST ASK", and it is shared's. Reading it here rather
        // than assuming makes this frame obey the same rule the engine obeys —
        // and it is the line that fails loudly if anyone ever teaches
        // `mustAskBeforeActing` to say no to something on the REMOTE_ACTIONS
        // table.
        if (!mustAskBeforeActing(agent, { remoteAction: frame.facts.action })) {
          throw new Error("that isn't something Cloud9 asks about");
        }
        // a job may only be NAMED if it really is this agent's job — the same
        // check `recordRun` makes, for the same reason
        const namedTask = frame.taskId ? this.store.task(frame.taskId) : undefined;
        const taskId = namedTask && namedTask.agentId === agent.id ? namedTask.id : undefined;
        const now = Date.now();
        // THE SENTENCE IS WRITTEN HERE, from the facts, exactly as
        // `describeApproval` writes the job-shaped one. The agent supplied a
        // branch name and a count; it did not supply a single word he reads.
        const detail = detailRemoteAction(frame.facts);
        const approval: Approval = {
          id: newId("ap"), agentId: agent.id, ownerId: agent.ownerId,
          action: describeRemoteAction(frame.facts).slice(0, APPROVAL_LIMITS.action),
          status: "pending", createdAt: now,
          kind: "action", remoteAction: frame.facts.action, channelId: channel.id,
          // it dies if nobody answers — see `sweepExpiredApprovals`
          expiresAt: now + this.approvalWaitMs,
          ...(taskId ? { taskId } : {}),
          ...(detail ? { detail: detail.slice(0, APPROVAL_LIMITS.detail) } : {}),
        };
        this.store.saveApproval(approval);
        this.audit(conn, "approval_requested", approval.id,
          `${agent.name} asks to ${approval.action}`, { asAgent: agent });
        // the receipt goes to the asking socket only; the CARD goes to the
        // owner's screens (and to that same engine, which is one of them)
        send(conn.ws, { type: "approvalAsked", askId, approvalId: approval.id });
        this.sendApproval(approval);
        // and it dies on the clock, not on the next person to look
        this.scheduleExpiry(approval.expiresAt!);
        break;
      }
      case "decideApproval": {
        // a card that ran out of time is not answerable, and saying so is the
        // whole point of `expired` — silence must never read as a yes
        const approval = this.freshApproval(frame.approvalId);
        if (!approval) throw new Error("no such approval");
        // Provisional policy (PARKING-LOT D4): only the agent's owner decides.
        if (approval.ownerId !== conn.userId) throw new Error("only the agent's owner can decide this");
        if (approval.status !== "pending") break; // FR-AP-004: no re-execution through decided approvals
        approval.status = frame.decision;
        approval.decidedBy = conn.userId;
        approval.decidedAt = Date.now();
        this.store.saveApproval(approval);
        this.audit(conn, "approval_decided", approval.id, `${frame.decision}: ${approval.action}`);
        const task = approval.taskId ? this.store.task(approval.taskId) : undefined;
        if (task && task.status === "waiting_approval") {
          task.status = frame.decision === "approved" ? "not_started" : "cancelled";
          if (frame.decision === "rejected") task.error = "rejected by owner";
          task.updatedAt = Date.now();
          this.store.saveTask(task);
          this.audit(conn, "task_status", task.id, `task "${task.title}" → ${task.status}`);
          this.broadcast({ type: "task", task });
        }
        this.sendApproval(approval);
        break;
      }
      case "activity": {
        send(conn.ws, {
          type: "activity",
          records: this.store.activity(frame.before ?? Date.now() + 1, frame.limit ?? 100),
        });
        break;
      }
      // ---- projects: a GitHub repository connected to Cloud9 (his item 7) ----
      //
      // ONE GATE, `myProject`, on stored state — the same law `myAgent` follows
      // and for the same reason: a project runs through its owner's machine and
      // their `gh` sign-in, so being able to see one is not permission to act on
      // it. Nothing in this section reaches GitHub; the engine owns that.
      case "connectProject": {
        const bad = validateRepo(frame.repo);
        if (bad) throw new Error(bad);
        // the same naming rule the crew and the rooms are held to
        const badText = validateProjectText(frame.name, frame.description,
          this.store.projectsOf(conn.userId).map(p => p.name));
        if (badText) throw new Error(badText);
        // CONNECTING THE SAME REPOSITORY TWICE FINDS THE ONE YOU HAVE, exactly
        // as clicking a person twice finds the same direct conversation. Two
        // projects over one repository would be two lists of the same pull
        // requests, disagreeing.
        const already = this.store.projectByRepo(conn.userId, frame.repo);
        if (already) { send(conn.ws, { type: "project", project: this.viewProject(already) }); break; }
        if (this.store.projectsOf(conn.userId).length >= PROJECT_LIMITS.perUser) {
          throw new Error(`that's too many projects (max ${PROJECT_LIMITS.perUser})`);
        }
        // a project may only report into a conversation you are actually in
        if (frame.channelId) this.channelFor(conn.userId, frame.channelId);
        const project: Project = {
          id: newId("pr"), ownerId: conn.userId, repo: frame.repo,
          name: frame.name?.trim() || frame.repo.split("/")[1],
          ...(frame.description ? { description: frame.description } : {}),
          ...(frame.channelId ? { channelId: frame.channelId } : {}),
          createdAt: Date.now(),
        };
        this.store.saveProject(project);
        this.audit(conn, "project_connected", project.id, `connected ${project.repo}`);
        this.toUser(conn.userId, { type: "project", project: this.viewProject(project) });
        // AND LOOK AT IT NOW, so a mistyped repository is not indistinguishable
        // from a good one for ever. Before this, `definitely-not-a-real-owner/
        // nope` joined the list and sat there saying "Not looked at GitHub yet"
        // — the exact words a perfectly good repository says.
        this.lookOnConnect(conn.userId, project);
        break;
      }
      case "updateProject": {
        const project = this.myProject(conn.userId, frame.projectId);
        // renaming a project to what it is already called is not a clash, and a
        // name that clashed before this rule existed must not become unsavable
        const renamingIt = typeof frame.name === "string" && frame.name.trim()
          && nameKey(frame.name) !== nameKey(project.name);
        const badText = validateProjectText(frame.name, frame.description,
          renamingIt
            ? this.store.projectsOf(conn.userId).filter(p => p.id !== project.id).map(p => p.name)
            : undefined);
        if (badText) throw new Error(badText);
        if (frame.channelId) this.channelFor(conn.userId, frame.channelId);
        // absent = leave alone, "" = clear — the same sentence-vs-silence rule
        if (frame.name !== undefined && frame.name.trim()) project.name = frame.name.trim();
        if (frame.description !== undefined) {
          if (frame.description) project.description = frame.description;
          else delete project.description;
        }
        if (frame.channelId !== undefined) {
          if (frame.channelId) project.channelId = frame.channelId;
          else delete project.channelId;
        }
        this.store.saveProject(project);
        this.audit(conn, "project_updated", project.id, `updated ${project.repo}`);
        this.toUser(conn.userId, { type: "project", project: this.viewProject(project) });
        break;
      }
      case "forgetProject": {
        const project = this.myProject(conn.userId, frame.projectId);
        // FORGETS OUR COPY. The repository is untouched — the hub has no way to
        // reach GitHub at all, and that is the design, not an omission.
        // a look still in flight has nothing left to report into
        this.endLook(project.id);
        this.store.forgetProject(project.id);
        this.audit(conn, "project_forgotten", project.id, `disconnected ${project.repo}`);
        this.toUser(conn.userId, { type: "projectForgotten", projectId: project.id });
        break;
      }
      case "projects": {
        send(conn.ws, {
          type: "projects",
          projects: this.store.projectsOf(conn.userId).map(p => this.viewProject(p)),
        });
        break;
      }
      case "projectItems": {
        const project = this.myProject(conn.userId, frame.projectId);
        send(conn.ws, {
          type: "projectItems", projectId: project.id,
          items: this.store.projectItems(project.id),
        });
        break;
      }
      /* "LOOK AT GITHUB NOW."
         OWNER ONLY, AND CHECKED HERE rather than on the screen: `myProject`
         reads ownership from stored state, so a friend's client pressing a
         button it drew itself gets "no such project" — the same answer an
         invented id gets, so an id cannot be probed either. */
      case "syncProject": {
        const project = this.myProject(conn.userId, frame.projectId);
        this.startLook(conn.userId, project);
        break;
      }
      case "projectSynced": {
        if (conn.client !== "engine") throw new Error("only the engine looks at GitHub");
        const project = this.myProject(conn.userId, frame.projectId);
        // the look is over, whatever it found — before anything else, so a
        // refused frame below still ends the "looking" state rather than
        // leaving a button spinning until the timer runs out
        this.endLook(project.id);
        if (frame.items !== undefined) {
          if (!Array.isArray(frame.items)) throw new Error("that isn't a list of work");
          if (frame.items.length > PROJECT_LIMITS.items) {
            throw new Error("that's too much work to hold — the newest are kept");
          }
          for (const item of frame.items) {
            const bad = validateProjectItem(item);
            if (bad) throw new Error(bad);
          }
          // stamped with the project WE verified, never the one the item claimed
          const items = frame.items.map(i => ({ ...i, projectId: project.id }));
          const stored = this.store.syncProjectItems(project.id, items);
          this.toUser(conn.userId, { type: "projectItems", projectId: project.id, items: stored });
        }
        if (frame.defaultBranch !== undefined) {
          // it becomes part of "nothing lands here without him", so it is
          // checked as a name and not taken on trust
          if (!isBranchName(frame.defaultBranch)) throw new Error("that isn't a branch name");
          project.defaultBranch = frame.defaultBranch;
        }
        // WHEN IT WAS LAST LOOKED AT IS DECIDED HERE AND NOWHERE ELSE. Not by
        // the engine, which could report any clock it liked, and not by the
        // screen, which would then have a second answer. Somebody looked, and
        // this is when — even if what they found was a problem, because
        // "we tried at 14:02 and GitHub refused" is still a look.
        project.syncedAt = Date.now();
        if (frame.problem !== undefined) {
          const said = String(frame.problem).slice(0, PROJECT_LIMITS.problem).trim();
          if (said) project.problem = said; else delete project.problem;
        } else {
          delete project.problem;
        }
        this.store.saveProject(project);
        this.toUser(conn.userId, { type: "project", project: this.viewProject(project) });
        break;
      }
      // ---- what an agent actually did (FR-TL-003) ----
      case "runRecorded": {
        this.recordRun(conn, frame.record);
        break;
      }
      case "runList": {
        const limit = typeof frame.limit === "number" ? frame.limit : RUN_RETENTION.listDefault;
        if (frame.taskId) {
          // A JOB'S runs are readable by whoever can read the conversation the
          // job was asked for in — the same gate as reading the message that
          // announced it. `channelFor` is asked first so an invented task id
          // and a task in somebody else's room fail the same way.
          const task = this.store.task(frame.taskId);
          if (!task) throw new Error("no such task");
          this.channelFor(conn.userId, task.channelId);
          send(conn.ws, {
            type: "runs", taskId: frame.taskId,
            runs: this.store.runsForTask(frame.taskId, limit)
              // belt and braces: the room gate said yes, each row is asked again
              .filter(row => this.canSeeRun(conn.userId, row))
              .map(row => runListEntry(shareableRun(row.record))),
          });
          break;
        }
        // AN AGENT'S history is its owner's business and nobody else's. Being in
        // a room with someone's agent shows you the turns it took THERE (ask by
        // task, or watch them arrive); it is not a licence to read everything
        // that agent has ever done, in every conversation, for everyone.
        if (!frame.agentId) throw new Error("say whose work you want to see");
        const agent = this.myAgent(conn.userId, frame.agentId);
        send(conn.ws, {
          type: "runs", agentId: agent.id,
          runs: this.store.runsForAgent(agent.id, limit)
            .map(row => runListEntry(shareableRun(row.record))),
        });
        break;
      }
      case "runDetail": {
        const row = typeof frame.runId === "string" ? this.store.run(frame.runId) : undefined;
        // "no such run" for a run you may not see, so an id cannot be probed —
        // the same sentence an invented id gets, exactly as attachments do.
        if (!row || !this.canSeeRun(conn.userId, row)) throw new Error("no such run");
        send(conn.ws, { type: "run", record: shareableRun(row.record) });
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
        // "Codex isn't signed in" is a presence fact, not just a settings card:
        // it is the difference between an agent that will answer and one that
        // cannot. Everyone in a room with these agents hears it.
        this.announcePresenceForOwner(conn.userId);
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
        // reacting as YOURSELF — the reactor is the person on this socket
        this.setReaction(conn, frame.messageId, conn.userId, frame.emoji, frame.on);
        break;
      }
      case "agentReact": {
        // REACTING AS ONE OF YOUR AGENTS (his item 5). Authorised exactly as
        // `agentSend` is, and by the same function: ownership is read from
        // stored state, never from the frame, so an engine cannot react as an
        // agent it does not own. Everything after that is the same code path a
        // person's reaction takes — same table, same gates, same frame out.
        const agent = this.myAgent(conn.userId, frame.agentId);
        this.setReaction(conn, frame.messageId, agent.id, frame.emoji, frame.on);
        break;
      }
      case "editMessage": {
        const message = this.messageFor(conn.userId, frame.messageId);
        this.writableChannel(conn.userId, message.channelId);
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
        this.writableChannel(conn.userId, message.channelId);
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
        const channel = this.writableChannel(conn.userId, frame.channelId);
        let bytes: Buffer;
        try { bytes = Buffer.from(String(frame.dataBase64 ?? ""), "base64"); }
        catch { throw new Error("that file didn't arrive properly"); }
        // The name rule is `isSafeFileName`, reached through
        // `validateAttachment` — the SAME rule that guards skill files, on
        // purpose. There is no second copy of it to drift.
        const bad = validateAttachment(frame.name, bytes.length);
        if (bad) throw new Error(bad);
        // A CAP ON ONE FILE BOUNDS ONE FILE, AND NOTHING ELSE. Nothing limited
        // how many, how fast, or how long they stayed, so anybody who could
        // sign in could fill the owner's hard disk ten megabytes at a time.
        // Three bounds, checked here because this is the only way in:
        // stale drafts go first, then how fast, then how much is sitting unsent.
        this.store.sweepParkedAttachments(Date.now() - ATTACHMENT_LIMITS.parkedTtlMs);
        const recent = this.store.uploadsSince(conn.userId, Date.now() - 60_000);
        if (recent >= ATTACHMENT_LIMITS.uploadsPerMinute) {
          throw new Error("that's a lot of files at once — wait a minute and try again");
        }
        const parked = this.store.parkedBytes(conn.userId);
        if (parked + bytes.length > ATTACHMENT_LIMITS.parkedBytesPerUser) {
          throw new Error(
            `you have too many files waiting to be sent (max ` +
            `${Math.floor(ATTACHMENT_LIMITS.parkedBytesPerUser / 1_000_000)} MB) — send or discard some first`,
          );
        }
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
      case "attachmentTicket": {
        const row = this.store.attachment(frame.attachmentId);
        // "no such file" for a file you may not see, so an id cannot be probed
        if (!row) throw new Error("no such file");
        // THE GATE, not a copy of it. Reading an attached file is reading the
        // conversation it was posted in, so it asks exactly that question — and
        // an archived room is still readable, which is why this is
        // `channelFor` and not `writableChannel`.
        try { this.channelFor(conn.userId, row.channelId); }
        catch { throw new Error("no such file"); }
        // A file nobody has sent yet is still only its uploader's business.
        if (!row.messageId && row.attachment.uploadedBy !== conn.userId) {
          throw new Error("no such file");
        }
        const { ticket, expiresAt } = this.mintTicket(conn.userId, row.attachment.id);
        send(conn.ws, {
          type: "attachmentTicket", attachmentId: row.attachment.id,
          ticket, url: ATTACHMENT_TICKET.path + ticket, expiresAt,
          attachment: row.attachment,
        });
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

  // -------------------------------------------------------------------------
  // What an agent actually did (FR-TL-003, FR-AU-003)
  //
  // A run record is the most detailed thing this hub has ever been asked to
  // hand round: it names the files an agent opened, the commands it ran and the
  // web pages it fetched, on somebody's own computer. So it goes through the
  // gates that already exist rather than a new set of its own —
  //
  //   WHOSE AGENT      `myAgent`, on stored state. An engine may only report
  //                    runs for agents its own user owns.
  //   WHICH ROOM       `channelFor`, on stored state. A run is visible to
  //                    exactly the people who could see the conversation it
  //                    happened in — plus the agent's owner, always.
  //   WHAT LEAVES      `shareableRun` (which is `redactForSharing`), applied
  //                    AGAIN here even though the engine already applied it.
  //                    The engine is a program on the same machine and this is
  //                    the last door; a record written by an older or broken
  //                    engine must not be the way a guest learns the owner's
  //                    folder layout.
  //
  // There is deliberately no second authorisation path. Nothing below reads a
  // permission out of the record itself.
  // -------------------------------------------------------------------------

  /**
   * Store one run the engine has just finished, and tell the room about it.
   *
   * Everything the record CLAIMS about where it belongs is verified, and a
   * claim that does not check out is DROPPED rather than obeyed: an unverifiable
   * `channelId` leaves the run visible to its owner alone, which is the narrow
   * answer, and a `taskId` for somebody else's job is simply not recorded. The
   * turn already happened, so refusing the whole record would lose the evidence
   * over a field nobody needed.
   */
  private recordRun(conn: Conn, record: RunRecord): void {
    if (conn.client !== "engine") throw new Error("only the engine reports what an agent did");
    const bad = validateRunRecord(record);
    if (bad) throw new Error(bad);
    // WHOSE AGENT — stored state, never the record. This one line is what stops
    // an engine host reporting runs against another person's agent and, through
    // that, planting a readable record in a room it was never in.
    const agent = this.myAgent(conn.userId, record.agentId);

    let channelId: ID | undefined;
    if (record.channelId) {
      // the agent's owner can see every room the agent is in, so this is the
      // right person to ask — and a room neither of them is in fails here
      try { channelId = this.channelFor(conn.userId, record.channelId).id; }
      catch { channelId = undefined; }
    }
    // a job's run belongs to THAT job, and only if the job is really this
    // agent's — otherwise `runList` by task would be a way to attach a record
    // to somebody else's work
    const task = record.taskId ? this.store.task(record.taskId) : undefined;
    const taskId = task && task.agentId === agent.id ? task.id : undefined;

    // Redact FIRST, then fit: the cap is measured against the bytes that are
    // actually stored, and what is stored is the version that may be read.
    const safe = fitRunRecord(shareableRun(record), RUN_RETENTION.bytes);
    // The record's OWN `channelId` and `taskId` are overwritten with what was
    // verified — including with "nothing". Spreading only the values that
    // checked out would leave the unverified claim sitting inside the record,
    // where a screen would read it and say the run happened in a room it never
    // touched. The columns beside it would have been right and the object
    // itself would have been lying; a test caught exactly that.
    const cleaned: RunRecord = { ...safe, channelId, taskId };
    if (!channelId) delete cleaned.channelId;
    if (!taskId) delete cleaned.taskId;
    const row: RunRow = {
      record: cleaned,
      agentId: agent.id,
      ownerId: agent.ownerId,
      ...(channelId ? { channelId } : {}),
      ...(taskId ? { taskId } : {}),
    };
    // saveRun prunes in the same call, so "bounded" isn't something a caller
    // has to remember
    this.store.saveRun(row);

    // THE ROW THE ACTIVITY PANEL WAS ALWAYS MISSING. Until now the trail could
    // say an agent spoke; it could not say what the agent did to be able to.
    this.store.logActivity({
      actorKind: "agent", actorId: agent.id, actorName: agent.name,
      kind: "run_recorded", refId: row.record.id,
      // the plain-words line, from the record — never a sentence of our own
      detail: runListEntry(row.record).summary,
    });

    // "The job finished" becomes "here is what it did".
    if (task && taskId) {
      task.runId = row.record.id;
      task.updatedAt = Date.now();
      this.store.saveTask(task);
      this.broadcast({ type: "task", task });
    }

    this.tellAboutRun(row);
  }

  /**
   * May this person read this run?
   *
   * Two ways in, and no third: it is your own agent's, or it happened in a
   * conversation you can see. A run with no room — a scheduled check-in that
   * posted nowhere — is its owner's alone, which is the narrow answer and
   * therefore the right default.
   */
  private canSeeRun(userId: ID, row: RunRow): boolean {
    if (row.ownerId === userId) return true;
    if (!row.channelId) return false;
    try { this.channelFor(userId, row.channelId); return true; } catch { return false; }
  }

  /** Push a finished run to everyone who could see the conversation it was in. */
  private tellAboutRun(row: RunRow): void {
    const frame: ServerFrame = { type: "run", record: row.record };
    const channel = row.channelId ? this.store.channel(row.channelId) : undefined;
    if (!channel) { this.toUser(row.ownerId, frame); return; }
    const audience = this.audienceFor(channel);
    // the owner hears about their own agent's work even if they have since
    // left the room it happened in
    audience.add(row.ownerId);
    for (const conn of this.conns) {
      if (audience.has(conn.userId)) send(conn.ws, frame);
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
  private agentRules(
    conn: Conn, provider?: string, except?: ID,
  ): { models?: string[]; takenNames?: string[] } {
    const harness = provider === "codex" ? "codex" : "claude";
    return {
      models: this.harness[conn.userId]?.[harness].models,
      // WHAT MAKES A SECOND `Scout` A REFUSAL RATHER THAN A SILENT COPY.
      // Every agent in this Cloud9 counts, not only his own: the `@` picker
      // offers all of them side by side, and four identical rows is the whole
      // bug. `except` is the agent being EDITED — renaming something to what it
      // is already called is not a clash.
      takenNames: this.store.agents().filter(a => a.id !== except).map(a => a.name),
    };
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

  // ------------------------------------------------------------- approvals
  //
  // ONE PLACE decides who sees an approval, when it dies, and how it is sent.
  // Three call sites used to be `this.broadcast({type:"approval"...})` copied
  // three times, which is how a card that names a private branch on a private
  // repository ends up on an invited friend's screen.

  /**
   * Who is shown this card.
   *
   * A JOB-SHAPED approval keeps the audience it has always had — the whole
   * house — because that is existing behaviour and narrowing it is somebody
   * else's decision, not this round's.
   *
   * An ACTION-SHAPED one goes to the agent's OWNER only. It names a branch, a
   * repository and a diff size, and he is the only person who may answer it, so
   * there is nobody else it could usefully reach. `toUser` covers his desktop,
   * his phone and the engine that asked, all at once.
   */
  private sendApproval(approval: Approval): void {
    if (approval.kind === "action") this.toUser(approval.ownerId, { type: "approval", approval });
    else this.broadcast({ type: "approval", approval });
  }

  /**
   * NOBODY ANSWERED, so the request is dead — and it says so.
   *
   * `expired` is a fourth word rather than a quiet `rejected` because they are
   * not the same event: he said no, versus he never saw it. The agent is told
   * the difference and so is the activity trail.
   */
  private sweepExpiredApprovals(now = Date.now()): void {
    for (const a of this.store.approvals(1000)) {
      if (a.status !== "pending" || typeof a.expiresAt !== "number" || a.expiresAt > now) continue;
      a.status = "expired";
      this.store.saveApproval(a);
      this.store.logActivity({
        actorKind: "system", actorId: a.agentId, actorName: "Cloud9",
        kind: "approval_decided", refId: a.id,
        detail: `expired with nobody answering: ${a.action}`,
      });
      this.sendApproval(a);
    }
  }

  /**
   * Come back at the deadline and sweep. One shot per card, unref'd so a
   * waiting approval is never the reason this process stays alive, and cleared
   * on close so a test does not leave one behind.
   */
  private scheduleExpiry(at: number): void {
    const t = setTimeout(() => {
      this.expiryTimers.delete(t);
      this.sweepExpiredApprovals();
    }, Math.max(0, at - Date.now()) + 25);
    t.unref?.();
    this.expiryTimers.add(t);
  }

  /** The stored approval, after the clock has been allowed to catch up with it. */
  private freshApproval(id: ID): Approval | undefined {
    this.sweepExpiredApprovals();
    return this.store.approval(id);
  }

  /** The approvals this person may be shown, swept first. */
  private visibleApprovals(userId: ID): Approval[] {
    this.sweepExpiredApprovals();
    return this.store.approvals().filter(a => a.kind !== "action" || a.ownerId === userId);
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
 * Is this a branch name, and only a branch name?
 *
 * IT MOVED TO `@cloud9/shared` on 2026-07-30 and this is the same function, not
 * a copy. The engine now reads a repository's trunk off `gh` and has to know
 * whether it may report it; if it used a slightly different rule from this one,
 * a name the engine reported would be refused here and the whole list of pull
 * requests would go down with it. One rule, one place.
 */
export { isBranchName as isSafeBranchName } from "@cloud9/shared";

/**
 * Does this task need the owner to say yes first?
 *
 * Answered from the agent's own stored `approvals` setting, plus what KIND of
 * task this is (a schedule request names itself in its title). The client's
 * opinion is not consulted — that was the hole in P1 #6.
 */
export function requiresApproval(agent: AgentDef, title: string): boolean {
  // An agent that can run programs, reach the whole computer, or use connected
  // services ALWAYS asks first — whatever its stored approvals say. That rule
  // is decided in one place (`mustAskBeforeActing`, in shared) because the hub
  // and the engine cannot see each other's code, and reading `agent.approvals`
  // here alone was exactly how a job from a shell-capable agent could have run
  // unattended without the owner ever being asked.
  if (mustAskBeforeActing(agent)) return true;
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

/**
 * Pull the ticket out of a request, or undefined when this isn't one.
 *
 * GET only, exact path shape only, and the ticket is read from the PATH — not
 * from a query string, a header or a cookie, because there being exactly one
 * place it can be is what stops a second, sloppier way of asking growing next
 * to this one. A query string is refused rather than ignored: a request that
 * carries something we do not understand is not a request we should answer.
 */
export function attachmentTicketFrom(req: http.IncomingMessage): string | undefined {
  if (req.method !== "GET") return undefined;
  const url = req.url ?? "";
  if (!url.startsWith(ATTACHMENT_TICKET.path)) return undefined;
  const rest = url.slice(ATTACHMENT_TICKET.path.length);
  // one segment, no query, no fragment, no traversal — the ticket is an opaque
  // string we minted, so anything that isn't one of those characters is not it
  if (!/^[A-Za-z0-9._-]{16,256}$/.test(rest)) return "";
  return rest;
}

/**
 * The ONE response in this hub that a page on another origin may read.
 *
 * WHY IT IS NEEDED. The app's origin is never the hub's — `127.0.0.1:4173` in
 * dev and QA, and `file://` (so `Origin: null`) in the packaged app. Without
 * this header the browser ran the request, let the hub SPEND the one-use
 * ticket, and then hid the answer from the page: the worst of both worlds. The
 * renderer had grown a second, worse code path because of it.
 *
 * WHY REFLECTING THE ORIGIN IS SAFE HERE. CORS protects endpoints that carry
 * AMBIENT AUTHORITY — a cookie or an HTTP-auth header the browser attaches by
 * itself, so that merely being able to make the request is enough to act as the
 * signed-in person. This endpoint has none. The only thing that authorises it is
 * the one-use ticket in the path, which is minted on an already-authenticated
 * socket, checked against membership again at redeem, dies on first use and dies
 * again after thirty seconds. A stranger's page can already MAKE this request
 * today; what it cannot do is obtain a ticket. Letting it read a response it
 * could only have got by holding a ticket hands it nothing it did not have.
 *
 * `Access-Control-Allow-Credentials` is deliberately absent, and that is the
 * load-bearing half of this decision, not an omission. Without it a browser
 * will not attach cookies or HTTP auth to the request at all, and will refuse
 * to expose the response if any were sent — so this can never become the
 * "reflected origin plus credentials" hole, which is a real and serious one.
 * IF ANYONE EVER ADDS COOKIE OR HEADER AUTH TO THIS ROUTE, THIS FUNCTION MUST
 * GO BACK TO AN EXACT ALLOW-LIST FIRST.
 *
 * An exact list of origins was tried on paper and rejected: the packaged app
 * sends the literal `null`, which no allow-list can distinguish from any other
 * sandboxed page, so listing origins would have bought nothing real while
 * breaking the moment a dev port changed.
 *
 * A request with no `Origin` at all — a direct GET, a download manager — gets
 * no header, because none is needed and a header nobody asked for is noise.
 * There is no preflight to answer: a plain `GET` with no custom request headers
 * is a simple request. Adding one to the fetch would need an `OPTIONS` route,
 * and that would be a second reason on a second response — do not.
 */
export function attachmentCors(req: http.IncomingMessage): Record<string, string> {
  const origin = req.headers.origin;
  if (typeof origin !== "string" || origin.length === 0 || origin.length > 2048) return {};
  return {
    "access-control-allow-origin": origin,
    // caches must not hand one origin's copy to another. Belt on top of the
    // braces of `cache-control: no-store`.
    "vary": "Origin",
  };
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
