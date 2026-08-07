// Cloud9 relay — the small always-on hub. All clients (desktop renderer,
// engine host, iPhone app) speak the same WS protocol defined in @cloud9/shared.
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  AgentDef, AgentPresenceState, AgentStatus, Approval,
  ArtifactLink, ArtifactRelationView, Attachment,
  StoredArtifact, StoredArtifactVersion, artifactForPublic,
  Channel, ChannelMember,
  ChannelRole, ChannelSummary, ClientFrame, HarnessState, ID, Message,
  MESSAGE_LIMITS, ARTIFACT_LIMITS, ATTACHMENT_LIMITS, ATTACHMENT_TICKET, Project, PROJECT_LIMITS,
  ReachCatchup,
  RepoChoice, REPO_LIST_LIMITS, validateRepoChoice, validateLocalFolder,
  RunRecord, RUN_RETENTION, APPROVAL_LIMITS,
  // "show me the plan first" (2026-08-05) — the hub still writes the line the
  // owner reads and still bounds what the agent wrote
  planHeadline, tidyPlan, validatePlanAsk,
  SavingProposal, applySaving, findWaste, rollUpTokenUse, savingDetail, savingHeadline,
  tidySaving, validateSavingProposal,
  SearchHit, ServerFrame, Task, UnreadEntry, User, WorldState,
  NotificationInboxEntry, NotificationInboxKind, notificationEventId,
  Workflow, WorkflowRun, WorkflowRunStep, WorkflowStepStatus,
  agentPresence, describeRemoteAction, detailRemoteAction, validateRemoteActionFacts,
  isReceiptStage, isReceiptVerdict,
  RUN_LIMITS, redactForSharing, validateLiveSteps,
  contentDisposition, downloadContentType, fitRunRecord, isBranchName, isSafeFileName,
  isSafeStoredId, latestVersion, looksLikeText, normaliseArtifactAccess,
  normaliseArtifactLinks, validateArtifactAccessMutation, validateArtifactLinks,
  versionOf, validateArtifact,
  isRemoteAction, mayAdministerChannel, mayDriveAgent, mustAskBeforeActing, runListEntry,
  setMachineNames, shareableRun,
  extractMentions, nameKey, newId, validateAgentDefinition, validateAttachment, validateChannelText,
  validateMessageText, validateProjectItem, validateProjectText, validateReactionEmoji,
  validateName, validateRepo, validateRunRecord, validateTaskSummary, validateWorkflow,
  WS_LIMITS,
} from "@cloud9/shared";
import os from "node:os";
// THE SAME VALIDATOR THE BUILDER USES, not a second copy — a handoff arriving
// over the wire is asked the same question `buildHandoff` asked, by the same
// rule (docs/plans/agent-memory-handoff.md §9.2). The relay already depends on
// `@cloud9/engine`, so there is one owner of "is this a real handoff".
import { validateHandoff } from "@cloud9/engine";
import { mentionEvent, type NotifyViewer } from "@cloud9/engine/dist/notify-feed.js";
import { threadReplyEvent, type ThreadReplyFacts } from "@cloud9/shared/dist/notify.js";
import { RunRow, Store, searchTerms } from "./store.js";
import { runReachCatchup } from "./reachcatchup.js";

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
import { Refusal, refusalText } from "./refusal.js";
import {
  mintJoinToken, checkJoinToken, redeemJoinToken, resolveJoinBind,
  revokeJoinToken as retireJoinToken, JOIN_TOKEN_TTL_MS,
} from "./joinhub.js";

/**
 * WHAT ONE DOWNLOAD TICKET IS FOR.
 *
 * Two kinds, one mint, one endpoint. `attachment` names an `Attachment` (a file
 * a PERSON sent); `artifact` names an `ArtifactVersion` — the exact bytes, not
 * the artifact — so a ticket minted for version 2 can never serve version 3
 * because somebody published in between.
 */
type TicketTarget =
  | { kind: "attachment"; id: ID }
  | { kind: "artifact"; id: ID; artifactId: ID };

interface Conn {
  ws: WebSocket;
  userId: ID;
  client: "desktop" | "mobile" | "engine";
}

type ArtifactFrame = Extract<ServerFrame, { type: "artifact" }>;
interface ArtifactProjection {
  frame: ArtifactFrame;
  fingerprint: string;
}
type ArtifactProjectionSnapshot = Map<ID, Map<ID, ArtifactProjection | null>>;

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
   * This computer's home folder, as the SHELL resolved it (`cloud9:homeFolder`).
   * Handed in, never worked out here: it is the folder the one-time catch-up
   * opens up for an agent that has none, and a folder this app cannot vouch for
   * is one it must not claim. Absent means the catch-up gives nobody a folder.
   */
  homeFolder?: string;
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

/* ================= WHO MAY EVEN OPEN A SOCKET TO THIS HUB =================
 *
 * THE HOLE THIS CLOSES, in plain words: while Cloud9 is running, any website
 * open in any browser could talk to this hub. Browsers do NOT apply the
 * same-origin rule to WebSockets — a page on `evil.com` may open
 * `ws://127.0.0.1:8787` and it will connect. CORS is no help either: it governs
 * who may READ an HTTP response, and a WebSocket is not one. The only control
 * that exists at this layer is to read the `Origin` header on the upgrade and
 * refuse. A browser writes that header itself and a page cannot forge or remove
 * it, which is exactly what makes it worth reading.
 *
 * WHAT IS ALLOWED, and why each one is a real client and not a website:
 *   - NO Origin at all — a program, not a page: the engine host, the mobile
 *     app, a test, `curl`. A website cannot produce this.
 *   - `null` or a `file:` origin — the installed Cloud9 window, whose page is
 *     loaded off the disk. Chromium sends the literal `null` for those.
 *   - loopback (`localhost`, `127.0.0.1`, `[::1]`) on any port — the workbench
 *     app screen (vite on 5173), the QA browser (4173). These are this computer.
 *   - the address this hub was told to answer on — a friend's Cloud9 reaching
 *     the owner's private (Tailscale) address.
 *
 * WHAT IS REFUSED: every other website, before a single frame is read, before
 * any token is looked at.
 *
 * HONEST LIMIT, written down rather than implied: this stops a WEBSITE. It does
 * not stop a program already running on this computer as him — that program can
 * send no Origin at all and look exactly like the engine host. Nothing at this
 * layer can tell those apart, and a program running as him has his files
 * anyway. The control for that one is the token, not this.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function isAllowedWsOrigin(origin: string | undefined, bind: string): boolean {
  // a program, not a page — a website cannot get here
  if (origin === undefined || origin === "") return true;
  // the installed app's own window: a page loaded from the disk
  if (origin === "null" || origin.startsWith("file:")) return true;
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  // the private-network address this hub was actually told to answer on
  return bind !== LOOPBACK && host === bind.replace(/^\[|\]$/g, "").toLowerCase();
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
  // Approval cards stay live until the owner answers or stops the agent.
  // (A mid-run card used to stay answerable for ten minutes and then be swept
  // away by one-shot timers kept here. Removed 2026-08-07: a question put to the
  // owner is not rubbish to be cleared up while he thinks about it. It stays on
  // his screen, live, until he answers it or stops the agent.)
  /** Startup-expired workflow approvals are re-broadcast once the owner arrives. */
  private restartExpiredWorkflowApprovals: Approval[] = [];
  /** last sign-in request per user, and whether one is still running */
  private signInAt: Record<ID, number> = {};
  private signInFlight: Record<ID, number> = {};
  /** last GitHub sign-in request per user — its own cooldown, its own key */
  private githubSignInAt: Record<ID, number> = {};

  /**
   * Unspent tickets to fetch one file. IN MEMORY ON PURPOSE, never in the
   * database: this is a credential, and a credential that survives a restart is
   * a credential somebody has to remember to expire. These die with the process,
   * with the clock, and with their first use — whichever comes first.
   */
  private tickets = new Map<string, { target: TicketTarget; userId: ID; expiresAt: number }>();

  /**
   * The receipt for the one-time catch-up, when this start is the one that ran
   * it and it really changed something. It goes to the OWNER only, in his
   * welcome frame, and it is deliberately not stored on the hub beyond this
   * process: the marker in the database is what makes it never happen again,
   * this is only the sentence telling him it did.
   */
  reachCatchup?: ReachCatchup;

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
    // Owner exists from first boot; a default #general channel too.
    const owner = this.store.ensureOwner(this.ownerName, this.ownerToken);
    this.ownerId = owner.id;
    const interrupted = this.store.interruptActiveWorkflowRuns(this.ownerId);
    this.restartExpiredWorkflowApprovals = this.store.takeInterruptedWorkflowApprovals();
    if (interrupted.length) {
      console.warn(`[cloud9] marked ${interrupted.length} workflow run(s) interrupted after restart`);
    }
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
    this.wss = new WebSocketServer({
      server: this.server,
      maxPayload: WS_LIMITS.maxPayloadBytes,
      // THE DOOR, before the frame. See `isAllowedWsOrigin`: a website's upgrade
      // is refused here, so no token it guessed or read in a source file is ever
      // looked at. `verifyClient` runs before the handshake completes, which is
      // the only moment this header is still available.
      verifyClient: ({ origin, req }, done) => {
        if (isAllowedWsOrigin(origin ?? req.headers.origin as string | undefined, this.bind)) {
          done(true);
          return;
        }
        console.warn(
          `[cloud9] refused a connection from a web page (${String(origin).slice(0, 100)}). ` +
          "Cloud9 only answers its own app on this computer.");
        done(false, 403, "Cloud9 does not answer web pages");
      },
    });
    this.wss.on("connection", ws => this.onConnection(ws));
    // Files that were uploaded and never sent are nobody's but their
    // uploader's, so nothing was ever going to reclaim them. Swept at every
    // start, and again on each upload, so the disk cannot fill with drafts.
    this.store.sweepParkedAttachments(Date.now() - ATTACHMENT_LIMITS.parkedTtlMs);
    // THE AGENTS HE ALREADY HAD, CAUGHT UP — once, here, before anybody is let
    // in, so the first world he is handed is already the true one and no client
    // ever sees the old state and then a change arriving behind it. It only
    // adds, only to HIS agents, and only ever once on this file: see
    // `reachcatchup.ts`. The receipt goes to his screen in `worldFor`.
    try {
      // NO ENVIRONMENT FALLBACK for the folder, on purpose. The one thing
      // allowed to say where his home folder is, is the shell that checked it
      // really is a whole folder on this computer (`cloud9:homeFolder`). A hub
      // started without that answer grants the switches and claims no folder —
      // the honest empty, and the crew-screen button still opens one.
      this.reachCatchup = runReachCatchup(this.store, this.ownerId, {
        homeFolder: opts.homeFolder,
      });
    } catch (err) {
      // His messages open either way. A catch-up that could not run is a crew
      // still on the old switches — the crew-screen button still fixes them —
      // and never a hub that will not start.
      console.warn("[cloud9] could not bring existing agents up to full reach:", err);
    }
  }

  /**
   * Loopback only unless told otherwise. Harness frames can start processes on
   * this computer, so the hub does not answer the network by default.
   */
  listen(port = 8787): Promise<number> {
    // THE PASSWORD THAT IS PRINTED IN THE SOURCE CODE never goes on a street.
    // `dev-owner-token` is public — it is in this file, in the launcher and in
    // the sign-in box — so a hub using it is only as private as the door it is
    // behind. On this computer only, in the workbench, that door is loopback and
    // the origin check above. Anywhere else it is nothing at all, so the hub
    // refuses to start rather than come up looking fine.
    if (this.ownerToken === DEFAULT_OWNER_TOKEN) {
      if (this.bind !== LOOPBACK) {
        return Promise.reject(new Error(
          `Cloud9 will not open its hub to the network (${this.bind}) while it is still using ` +
          "the starter key that everyone has. Set your own key first (CLOUD9_OWNER_TOKEN), or " +
          "leave the network box empty to stay on this computer only."));
      }
      if (!this.devMode) {
        return Promise.reject(new Error(
          "Cloud9 will not start with the starter key that everyone has. " +
          "Set your own key (CLOUD9_OWNER_TOKEN) and start it again."));
      }
    }
    return new Promise(resolve => {
      this.server.listen(port, this.bind, () => {
        const addr = this.server.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  close(): void {
    for (const t of this.looking.values()) clearTimeout(t);
    this.looking.clear();
    for (const c of this.conns) c.ws.close();
    this.wss.close();
    this.server.close();
  }

  private onConnection(ws: WebSocket): void {
    let conn: Conn | undefined;
    ws.on("message", raw => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(raw)); } catch { return; }
      // JSON.parse returning a value does not make it a frame. Validate the
      // envelope before ANY `.type` access, including the refusal context below:
      // `null` used to throw once here and then throw again in the catch itself.
      if (!hasOwnStringType(parsed)) {
        sendFrameError(ws, "not authenticated", parsed);
        return;
      }
      const frame = parsed as ClientFrame;
      try {
        if (frame.type === "hello") {
          conn = this.handleHello(ws, frame);
          return;
        }
        // A join arrives INSTEAD of `hello`, because whether to admit it depends
        // on the address this hub is bound to — which `handleHello` never looks
        // at. (docs/plans/join-hub-handoff.md §4)
        if (frame.type === "joinWithToken") {
          conn = this.handleJoinWithToken(ws, frame);
          return;
        }
        if (!conn) { sendFrameError(ws, "not authenticated", frame); return; }
        this.handleFrame(conn, frame);
      } catch (err) {
        // ONE OWNER FOR "NO" (refusal.ts). This used to be `String(err)`, which
        // put the word "Error:" in front of every hand-written refusal and would
        // have shown a raw `TypeError` under a form in his app. `sendFrameError`
        // also owns safe request correlation before and after authentication.
        sendFrameError(ws, refusalText(err, `frame "${frame.type}"`), frame);
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
        sendFrameError(
          ws,
          known
            ? "that invite has already been used — ask for a new one"
            : "that invite code isn't valid",
          frame,
        );
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
    if (!user) { sendFrameError(ws, "bad token", frame); ws.close(); return undefined; }
    const conn: Conn = { ws, userId: user.id, client: frame.client };
    this.conns.add(conn);
    send(ws, { type: "welcome", state: this.worldFor(user.id) });
    if (conn.userId === this.ownerId && this.restartExpiredWorkflowApprovals.length) {
      const expired = this.restartExpiredWorkflowApprovals;
      this.restartExpiredWorkflowApprovals = [];
      for (const approval of expired) this.sendApproval(approval);
    }
    // An engine arriving changes the answer for every agent it can run, and
    // everyone in a room with those agents needs to hear it — not only the
    // owner. This is the other half of the disconnect rule above.
    if (conn.client === "engine") this.announcePresenceForOwner(user.id);
    return conn;
  }

  /**
   * Admit a friend on another computer who redeemed a join link.
   *
   * Two gates, in order:
   *   1. `resolveJoinBind(this.bind)` — is the address THIS PROCESS is bound to
   *      one where admitting a stranger even makes sense? A loopback hub answers
   *      only this computer, which is exactly the local two-hub proof; a
   *      private-network (Tailscale) or LAN bind is allowed; a public or
   *      wildcard bind is refused in plain words. The wildcard was already
   *      refused at startup (`resolveBind`); this is the join-specific tier.
   *   2. `checkJoinToken` — is the code alive (known, unspent, unrevoked, not
   *      expired)?
   *
   * Only then is a fresh account minted (never derived from the token's text —
   * P0 #1) and the token spent on that new id, once.
   */
  private handleJoinWithToken(
    ws: WebSocket,
    frame: Extract<ClientFrame, { type: "joinWithToken" }>,
  ): Conn | undefined {
    const bind = resolveJoinBind(this.bind === LOOPBACK ? undefined : this.bind);
    if (!bind.ok) {
      sendFrameError(ws, bind.reason, frame);
      ws.close();
      return undefined;
    }
    const check = checkJoinToken(this.store, frame.token);
    if (!check.ok) {
      sendFrameError(ws, check.reason, frame);
      ws.close();
      return undefined;
    }
    const { user, token } = this.store.admitJoinedUser(
      (frame.displayName || "Friend").slice(0, 60), check.token.createdBy);
    // Spend the token on the id we just created, never on anything the token's
    // own text carried — the same law `redeemInvite` follows.
    redeemJoinToken(this.store, frame.token, user.id);

    const conn: Conn = { ws, userId: user.id, client: "desktop" };
    this.conns.add(conn);
    send(ws, { type: "token", token });
    // new members land in #general, exactly like an invite redemption
    const general = this.store.channels().find(c => c.name === "general");
    if (general && !general.memberIds.includes(user.id)) {
      this.store.addChannelMember(general.id, user.id, { role: "member" });
      this.broadcastChannel(this.store.channel(general.id)!);
    }
    this.broadcast({ type: "userJoined", user });
    send(ws, { type: "welcome", state: this.worldFor(user.id) });
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
      tasks: this.store.tasks().filter(task => {
        if (!task.workflowRunId) return true;
        const agent = this.store.agents().find(a => a.id === task.agentId);
        return agent?.ownerId === userId || this.visibleChannels(userId).some(channel => channel.id === task.channelId);
      }),
      ...(userId === this.ownerId
        ? {
            workflows: this.store.workflows(userId),
            workflowRuns: this.store.workflowRuns(userId),
          }
        : { workflows: [], workflowRuns: [] }),
      // Swept FIRST, so nobody is ever handed a card that is already dead and
      // invited to click Approve on it.
      approvals: this.visibleApprovals(userId),
      notifications: this.notificationInboxFor(userId),
      // read state comes from the RELAY now, not from one browser's storage, so
      // reading on the laptop is read on the phone too
      unread: this.unreadFor(userId, channels),
      // WHAT THE HUB CHANGED ABOUT HIS AGENTS BEFORE HE ARRIVED, to the person
      // whose agents they are and to nobody else. A guest is not shown a list of
      // somebody else's crew, and it is absent entirely when nothing happened.
      ...(userId === this.ownerId && this.reachCatchup
        ? { reachCatchup: this.reachCatchup }
        : {}),
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
   * ONLY THE OWNER, FROM A WINDOW, MAY POINT AN AGENT AT A PLACE ON THIS DISK.
   *
   * The same law as `setProjectFolder`, applied to BOTH of the fields that name
   * somewhere on this computer, for the same reason: an agent able to name a
   * file could name any file, an agent able to name a folder could name the
   * whole drive, and the whole safety of the `connections` and `wholeComputer`
   * switches is that the person who owns the machine chose what is behind them.
   *
   * ONE GUARD, NOT TWO. `wholeComputerRoots` was added here rather than beside
   * here on purpose: a second copy of this rule is a second thing to forget when
   * a third path-shaped field arrives.
   */
  private refuseAgentPathsFromEngine(
    conn: Conn,
    agent: {
      connectionsFile?: unknown; wholeComputerRoots?: unknown; useOwnerSetup?: unknown;
    },
  ): void {
    if (conn.client !== "engine") return;
    // …AND THE SAME LAW FOR "USE MY OWN SETUP" (2026-08-06). It belongs in this
    // guard and not beside it, for the reason written above: a second copy is a
    // second thing to forget. Turning it ON loads his instructions, his
    // connected services and his hook scripts into an agent — which is a bigger
    // grant than either of the path fields, so an agent must not be able to make
    // it for itself. Only he can, from a window. Turning it OFF is refused too:
    // this guard is about who may WRITE the field, not which way is safer.
    if (agent.useOwnerSetup !== undefined) {
      throw new Error("only you can decide whether an agent uses your own setup — an agent cannot");
    }
    if (typeof agent.connectionsFile === "string" && agent.connectionsFile.trim()) {
      throw new Error("only you can choose an agent's connections file — an agent cannot");
    }
    const roots = agent.wholeComputerRoots;
    if (Array.isArray(roots) && roots.some(r => typeof r === "string" && r.trim())) {
      throw new Error("only you can choose the folders an agent may reach — an agent cannot");
    }
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

  /** Project one durable row against the recipient's CURRENT access/message. */
  private notificationProjection(userId: ID, row: import("./store.js").NotificationInboxRow): NotificationInboxEntry {
    const base = {
      id: row.id, recipientId: row.recipientId, kind: row.kind,
      state: row.state, createdAt: row.createdAt, actorId: "unknown",
      actorName: "Cloud9", title: row.kind === "mention" ? "You were mentioned" : "A thread moved",
      body: "The source message is no longer available.",
    } as NotificationInboxEntry;
    const channel = this.visibleChannels(userId).find(c => c.id === row.channelId);
    const message = this.store.message(row.messageId);
    if (!channel || !message || message.channelId !== row.channelId) {
      return { ...base, sourceState: "inaccessible" };
    }
    if (message.deletedAt) {
      return {
        ...base,
        actorName: message.authorName,
        actorId: row.actorId,
        title: message.authorName + (row.kind === "mention" ? " mentioned you" : " replied in a thread"),
        body: "This message was deleted.",
        sourceState: "deleted",
      };
    }
    return {
      ...base,
      actorName: message.authorName,
      actorId: row.actorId,
      title: message.authorName + (row.kind === "mention" ? " mentioned you" : " replied in a thread"),
      body: message.text.trim() || "(no message)",
      sourceState: "active",
      channelId: row.channelId,
      messageId: row.messageId,
      ...(row.rootId ? { rootId: row.rootId } : {}),
    };
  }

  private notificationInboxFor(
    userId: ID,
    opts: { includeDismissed?: boolean; limit?: number } = {},
  ): NotificationInboxEntry[] {
    return this.store.notificationsFor(userId, opts).map(row => this.notificationProjection(userId, row));
  }

  /** Re-project rows after an edit/delete or membership change. */
  private refreshNotificationRows(rows: import("./store.js").NotificationInboxRow[]): void {
    for (const row of rows) {
      this.toUser(row.recipientId, {
        type: "notificationUpdated",
        entry: this.notificationProjection(row.recipientId, row),
      });
    }
  }

  /** Rebuild authoritative recipients from relay facts, never client claims. */
  private recordMessageNotifications(channel: Channel, message: Message, priorReplies: Message[]): void {
    const ownerId = message.authorKind === "agent"
      ? this.store.agents().find(a => a.id === message.authorId)?.ownerId
      : message.authorId;
    if (!ownerId) return;
    const authoritative: Message = {
      ...message,
      mentions: this.mentionsFor(ownerId, message.text),
    };
    const root = authoritative.replyTo ? this.store.message(authoritative.replyTo) : undefined;
    for (const userId of this.audienceFor(channel)) {
      const viewer: NotifyViewer = {
        id: userId,
        agentIds: this.store.agents().filter(a => a.ownerId === userId).map(a => a.id),
      };
      const mention = mentionEvent(authoritative, viewer);
      let event = mention;
      if (!event && root) {
        const facts: ThreadReplyFacts = {
          replyId: authoritative.id, channelId: authoritative.channelId,
          authorId: authoritative.authorId, authorName: authoritative.authorName,
          text: authoritative.text, at: authoritative.ts, rootId: root.id,
          rootAuthorId: root.authorId,
          threadAuthorIds: priorReplies.map(reply => reply.authorId),
          mentions: authoritative.mentions,
        };
        event = threadReplyEvent(facts, viewer);
      }
      if (!event || (event.kind !== "mention" && event.kind !== "thread_reply")) continue;
      const id = notificationEventId(event.kind, authoritative.id, userId);
      const inserted = this.store.saveNotification({
        id, recipientId: userId, kind: event.kind as NotificationInboxKind,
        channelId: authoritative.channelId, messageId: authoritative.id,
        ...(root ? { rootId: root.id } : {}), actorId: authoritative.authorId,
        createdAt: authoritative.ts, state: "unread",
      });
      if (inserted) {
        const row = this.store.notificationsForMessage(authoritative.id).find(r => r.id === id);
        if (row) this.toUser(userId, { type: "notificationUpdated", entry: this.notificationProjection(userId, row) });
      }
    }
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

  /** One frame to everyone who can see this conversation, and nobody else. */
  private toChannel(channel: Channel, frame: ServerFrame): void {
    const audience = this.audienceFor(channel);
    for (const conn of this.conns) {
      if (audience.has(conn.userId)) send(conn.ws, frame);
    }
  }

  /**
   * The artifact this person may read, or "no such file".
   *
   * The same shape as `myAgent` and `myProject`, and the same law: the gate is
   * the CONVERSATION the artifact lives in, asked with `channelFor` on stored
   * state, because reading a file an agent shared in a room is reading that
   * room. `channelFor` and not `writableChannel` — an archived room is still
   * readable, and the file he asked an agent for last month is exactly the thing
   * archiving must not take away.
   *
   * "no such file" is the answer for an artifact in somebody else's room as well
   * as for an invented id, so an id cannot be probed.
   */
  private artifactFor(userId: ID, artifactId: ID): StoredArtifact {
    const artifact = this.store.artifact(artifactId);
    if (!artifact) throw new Error("no such file");
    try {
      this.channelFor(userId, artifact.channelId);
      if (!this.store.artifactAccessAllows(artifact.id, userId)) throw new Error("hidden");
    } catch { throw new Error("no such file"); }
    return artifact;
  }

  /**
   * Typed links as this person may safely draw them.
   *
   * Outgoing links stay visible when their exact target is gone or hidden, but
   * carry no target id and no name — only `hidden:true`, which becomes the plain
   * "A linked file isn't available" sentence. Incoming links are omitted unless
   * their source exact version and chain are both readable, so a hidden source
   * cannot be probed by opening its target.
   */
  private artifactRelations(
    userId: ID, artifact: StoredArtifact,
  ): { relations: ArtifactRelationView[]; truncated: boolean } {
    const page = this.store.artifactRelationsForDetail(
      artifact.id, userId, ARTIFACT_LIMITS.relationDetail,
    );
    const out: ArtifactRelationView[] = [];
    const cache = new Map<ID, StoredArtifact | null>();
    const readable = (artifactId: ID): StoredArtifact | undefined => {
      if (cache.has(artifactId)) return cache.get(artifactId) ?? undefined;
      try {
        const found = this.artifactFor(userId, artifactId);
        cache.set(artifactId, found);
        return found;
      } catch {
        cache.set(artifactId, null);
        return undefined;
      }
    };

    for (const link of page.items) {
      const from = { artifactId: link.sourceArtifactId, version: link.sourceVersion };
      if (link.direction === "outgoing") {
        const exact = this.store.artifactVersionNumber(link.targetArtifactId, link.targetVersion);
        const target = exact ? readable(link.targetArtifactId) : undefined;
        if (!exact || !target) {
          out.push({ kind: link.kind, direction: "outgoing", from, hidden: true });
        } else {
          out.push({
            kind: link.kind, direction: "outgoing", from,
            to: { artifactId: link.targetArtifactId, version: link.targetVersion },
            linkedName: target.name, hidden: false,
          });
        }
        continue;
      }

      // The store query already filtered hidden/unretained incoming sources.
      // Re-check through the ordinary gate before naming it on the wire.
      const source = readable(link.sourceArtifactId);
      if (!source) continue;
      out.push({
        kind: link.kind, direction: "incoming", from,
        to: { artifactId: link.targetArtifactId, version: link.targetVersion },
        linkedName: source.name, hidden: false,
      });
    }
    return { relations: out, truncated: page.truncated };
  }

  private artifactFrame(
    userId: ID, artifactId: ID, requestId?: ID,
  ): Extract<ServerFrame, { type: "artifact" }> {
    const stored = this.artifactFor(userId, artifactId);
    const { relations, truncated } = this.artifactRelations(userId, stored);
    return {
      type: "artifact", artifact: artifactForPublic(stored), relations,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(truncated ? { relationsTruncated: true as const } : {}),
    };
  }

  /** One viewer's complete public value, or null when the chain is invisible. */
  private artifactProjection(userId: ID, artifactId: ID): ArtifactProjection | null {
    try {
      const frame = this.artifactFrame(userId, artifactId);
      return { frame, fingerprint: JSON.stringify(frame) };
    } catch { return null; }
  }

  /**
   * Capture every current room viewer, including null for restricted chains.
   * Null is essential: null→null means an invisible event and MUST emit nothing.
   */
  private snapshotArtifactProjections(artifactIds: Iterable<ID>): ArtifactProjectionSnapshot {
    const snapshot: ArtifactProjectionSnapshot = new Map();
    for (const artifactId of new Set(artifactIds)) {
      const row = this.store.artifactRow(artifactId);
      const channel = row ? this.store.channel(row.channelId) : undefined;
      if (!row || !channel) continue;
      const byUser = new Map<ID, ArtifactProjection | null>();
      for (const userId of this.audienceFor(channel)) {
        byUser.set(userId, this.artifactProjection(userId, artifactId));
      }
      snapshot.set(artifactId, byUser);
    }
    return snapshot;
  }

  /**
   * THE ONE OWNER OF UNSOLICITED ARTIFACT PUSHES.
   *
   * Compare complete public values before and after. Equal fingerprints send
   * nothing — no unchanged frame and no timing hint. A visible change sends the
   * fresh frame (including explicit empty relations); visible→hidden sends one
   * unavailable frame; hidden→hidden is silent.
   */
  private pushArtifactProjectionDiff(
    before: ArtifactProjectionSnapshot, artifactIds: Iterable<ID>, omit?: Conn,
  ): void {
    const ids = new Set<ID>([...before.keys(), ...artifactIds]);
    const after = this.snapshotArtifactProjections(ids);
    for (const artifactId of ids) {
      const beforeUsers = before.get(artifactId) ?? new Map<ID, ArtifactProjection | null>();
      const afterUsers = after.get(artifactId) ?? new Map<ID, ArtifactProjection | null>();
      const users = new Set<ID>([...beforeUsers.keys(), ...afterUsers.keys()]);
      for (const userId of users) {
        const was = beforeUsers.get(userId) ?? null;
        const now = afterUsers.get(userId) ?? null;
        if (was?.fingerprint === now?.fingerprint) continue;
        const frame: ServerFrame | undefined = now
          ? now.frame
          : was ? { type: "artifactUnavailable", artifactId } : undefined;
        if (!frame) continue;
        for (const target of this.conns) {
          if (target.userId === userId && target !== omit) send(target.ws, frame);
        }
      }
    }
  }

  private artifactIdsInChannel(channelId: ID): ID[] {
    return this.store.artifactsIn(channelId, ARTIFACT_LIMITS.perChannel).map(a => a.id);
  }

  /** A run may be named on a version only when agent and source room both match. */
  private runOf(agentId: ID, channelId: ID, runId: unknown): RunRow | undefined {
    if (typeof runId !== "string" || !isSafeStoredId(runId)) return undefined;
    const run = this.store.run(runId);
    return run && run.agentId === agentId && run.channelId === channelId ? run : undefined;
  }

  /**
   * The job this claim is really about, or nothing.
   *
   * A `taskId` on a published artifact is a CLAIM, exactly as it is on a run
   * record, and it is checked the same way: the job has to exist and it has to
   * be this agent's, or the field is dropped rather than stored as a link to
   * somebody else's work.
   */
  private taskOf(agentId: ID, taskId: ID | undefined): Task | undefined {
    if (!taskId) return undefined;
    const task = this.store.task(taskId);
    return task && task.agentId === agentId ? task : undefined;
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
  private mintTicket(userId: ID, target: TicketTarget): { ticket: string; expiresAt: number } {
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
    this.tickets.set(ticket, { target, userId, expiresAt });
    return { ticket, expiresAt };
  }

  /**
   * WHAT A TICKET IS FOR, resolved to bytes on disk, at redeem time.
   *
   * A person's attachment and an agent's artifact are two DIFFERENT things in
   * the database and the SAME thing on the way out: a name, a folder, and the
   * conversation whose membership decides who may read it. This is the one
   * place that turns one into the other, which is why there is one download
   * endpoint and one set of headers rather than a second copy of both.
   *
   * Nothing here trusts the ticket for permission — it returns the channel, and
   * the caller asks `channelFor` about it, now, on stored state.
   */
  private ticketFile(target: TicketTarget): {
    channelId: ID; name: string; storedAs: string; dir: string; artifactId?: ID;
  } | undefined {
    if (target.kind === "attachment") {
      const row = this.store.attachment(target.id);
      if (!row) return undefined;
      return {
        channelId: row.channelId, name: row.attachment.name,
        storedAs: row.attachment.storedAs, dir: this.store.attachmentsDir,
      };
    }
    const row = this.store.artifactVersion(target.id);
    if (!row) return undefined;
    // The NAME comes from the artifact's identity row, not from the version:
    // the shared name is the thing every version of one file has in common, and
    // it is what a browser should save it as.
    const artifact = this.store.artifactRow(row.artifactId);
    if (!artifact) return undefined;
    return {
      channelId: row.channelId, name: artifact.name, artifactId: target.artifactId,
      storedAs: row.version.storedAs, dir: this.store.artifactsDir,
    };
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

    const file = this.ticketFile(held.target);
    if (!file) { nope(); return; }
    // THE SAME GATE, ASKED AGAIN, NOW. Artifact tickets re-check both current
    // room membership AND the chain's narrower permission; attachment tickets
    // keep the room gate they have always used.
    try {
      if (file.artifactId) this.artifactFor(held.userId, file.artifactId);
      else this.channelFor(held.userId, file.channelId);
    } catch { nope(); return; }

    // The name was checked by `isSafeFileName` before it was stored. It is
    // checked again on the way out, because a row could have been written by an
    // older build, and because it is about to become a header and a file name on
    // somebody's disk. Same rule, one owner, no second copy of it anywhere.
    if (!isSafeFileName(file.name)) { nope(); return; }
    const stored = path.join(file.dir, path.basename(file.storedAs));
    const root = path.resolve(file.dir);
    if (path.resolve(stored) !== path.join(root, path.basename(file.storedAs))) { nope(); return; }

    let size: number;
    try {
      const stat = fs.statSync(stored);
      if (!stat.isFile()) { nope(); return; }
      size = stat.size;
    } catch { nope(); return; }
    // the same ceiling the upload was held to — a file that grew on disk since
    // is not a file this hub agreed to serve. An agent's artifact is held to the
    // SAME number, by construction (`ARTIFACT_LIMITS.bytes` IS this one), so one
    // check covers both and there is nothing here to drift.
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

  /** The owner-only definition gate used by every workflow frame. */
  private myWorkflow(userId: ID, workflowId: ID): Workflow {
    const workflow = this.store.workflow(workflowId);
    if (!workflow || workflow.ownerId !== userId) throw new Error("no such workflow");
    return workflow;
  }

  private tellWorkflow(userId: ID, workflow: Workflow, requestId?: ID): void {
    this.toUser(userId, { type: "workflow", workflow, ...(requestId ? { requestId } : {}) });
  }

  private tellWorkflowRun(userId: ID, run: WorkflowRun, requestId?: ID): void {
    this.toUser(userId, { type: "workflowRun", run, ...(requestId ? { requestId } : {}) });
  }

  /**
   * The one task minting path. A workflow calls this same method as a normal
   * task, so agent ownership, channel visibility and approval policy cannot
   * drift between the two entry points.
   */
  private createTaskFor(
    conn: Conn,
    input: {
      agentId: ID; channelId: ID; title: string; requesterId?: ID;
      workflowId?: ID; workflowRunId?: ID; workflowStepId?: ID;
    },
  ): Task {
    const agent = this.myAgent(conn.userId, input.agentId);
    const channel = this.channelFor(conn.userId, input.channelId);
    const requester = this.requesterFor(conn, input.requesterId, channel);
    if (!mayDriveAgent(requester.id, agent)) {
      throw new Error(agent.name + " isn't set up to take work from " + requester.name);
    }
    const now = Date.now();
    const needsApproval = requiresApproval(agent, input.title);
    const task: Task = {
      id: newId("t"), title: input.title,
      requesterId: requester.id, requesterName: requester.name,
      agentId: agent.id, channelId: channel.id,
      status: needsApproval ? "waiting_approval" : "not_started",
      createdAt: now, updatedAt: now,
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.workflowRunId ? { workflowRunId: input.workflowRunId } : {}),
      ...(input.workflowStepId ? { workflowStepId: input.workflowStepId } : {}),
    };
    let approval: Approval | undefined;
    if (needsApproval) {
      approval = {
        id: newId("ap"), taskId: task.id, agentId: agent.id, ownerId: agent.ownerId,
        action: describeApproval(task.title), status: "pending", createdAt: now,
        ...(input.workflowRunId ? { channelId: channel.id } : {}),
      };
      task.approvalId = approval.id;
      this.store.saveApproval(approval);
      this.audit(conn, "approval_requested", approval.id,
        agent.name + " requests approval: " + approval.action, { asUser: requester });
    }
    this.store.saveTask(task);
    if (approval) this.sendApproval(approval);
    this.audit(conn, "task_created", task.id, "task for " + agent.name + ": " + task.title,
      { asUser: requester });
    this.publishTask(task);
    return task;
  }

  private persistWorkflowRun(run: WorkflowRun, requestId?: ID): void {
    run.updatedAt = Date.now();
    this.store.saveWorkflowRun(run);
    this.tellWorkflowRun(run.ownerId, run, requestId);
  }

  private runStep(run: WorkflowRun, stepId: ID): WorkflowRunStep {
    const step = run.steps.find(s => s.id === stepId);
    if (!step) throw new Error("that workflow step is no longer here");
    return step;
  }

  /** A saved runbook cannot point at an agent that was removed or moved. */
  private workflowAgents(userId: ID, workflow: Workflow): void {
    for (const step of workflow.steps) {
      const agent = this.store.agents().find(a => a.id === step.agentId);
      if (!agent || agent.ownerId !== userId) {
        throw new Error("workflow step agent is missing; choose an agent you own");
      }
    }
  }

  private startWorkflowStep(conn: Conn, run: WorkflowRun, workflow: Workflow, stepId: ID): void {
    const step = this.runStep(run, stepId);
    let task: Task;
    try {
      task = this.createTaskFor(conn, {
        agentId: step.agentId, channelId: run.channelId, title: step.instruction,
        workflowId: workflow.id, workflowRunId: run.id, workflowStepId: step.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "this workflow step could not start";
      step.status = "failed";
      step.error = message;
      run.status = "failed";
      run.error = message;
      run.currentStepId = step.id;
      run.finishedAt = Date.now();
      this.persistWorkflowRun(run);
      throw error;
    }
    const attempt = {
      taskId: task.id,
      status: task.status === "waiting_approval" ? "waiting_you" as const : "queued" as const,
      createdAt: task.createdAt,
    };
    step.attempts = [...step.attempts, attempt];
    step.status = attempt.status;
    run.currentStepId = step.id;
    run.status = attempt.status === "waiting_you" ? "waiting_you" : "queued";
    this.persistWorkflowRun(run);
  }

  private workflowTaskChanged(conn: Conn, task: Task): void {
    if (!task.workflowRunId || !task.workflowStepId) return;
    const run = this.store.workflowRun(task.workflowRunId);
    if (!run || run.ownerId !== conn.userId) return;
    const workflow = this.store.workflow(run.workflowId);
    if (!workflow) return;
    const step = run.steps.find(s => s.id === task.workflowStepId);
    if (!step) return;
    const attempt = step.attempts.at(-1);
    if (!attempt || attempt.taskId !== task.id) return;
    // Task updates can be replayed by a reconnecting engine. Once this
    // attempt has an ending, its result is immutable: a second "completed"
    // must not start the next step twice, and a late "working" must not make
    // a finished run look alive again.
    if (attempt.status === "succeeded" || attempt.status === "failed" || attempt.status === "stopped" || attempt.status === "interrupted") return;
    const now = task.updatedAt;
    const status: WorkflowStepStatus =
      task.status === "working" ? "running"
      : task.status === "waiting_approval" || task.status === "waiting_user" || task.status === "blocked" ? "waiting_you"
      : task.status === "completed" ? "succeeded"
      : task.status === "failed" ? "failed"
      : task.status === "cancelled" ? "stopped"
      : "queued";
    // A reconnect may replay an older queued/working frame. Keep the attempt
    // moving forward; the one intentional exception is the approved
    // waiting-for-you task becoming queued again for the engine.
    if (attempt.status === "running" && status === "queued") return;
    // A mid-run approval is recorded against the in-flight task. Only the
    // engine's working receipt after that exact card is approved may release
    // a waiting step; a replayed blocked receipt must not regress it.
    if (attempt.status === "running" && status === "waiting_you") {
      const approval = task.approvalId ? this.store.approval(task.approvalId) : undefined;
      if (task.approvalId && approval?.status !== "pending") return;
    }
    // Waiting-for-you is a held state. A late working receipt from the same
    // engine cannot claim the step resumed; only the explicit approval release
    // below is allowed to move it through queued first.
    if (attempt.status === "waiting_you" && status === "running") {
      const approval = task.approvalId ? this.store.approval(task.approvalId) : undefined;
      if (approval?.status !== "approved") return;
    }
    if (attempt.status === "waiting_you" && status === "queued") {
      const approval = task.approvalId ? this.store.approval(task.approvalId) : undefined;
      if (approval?.status !== "approved") return;
    }
    attempt.status = status;
    attempt.result = task.result;
    attempt.error = task.error;
    if (status === "running" && !attempt.startedAt) attempt.startedAt = now;
    if ((status === "succeeded" || status === "failed" || status === "stopped") && !attempt.finishedAt) {
      attempt.finishedAt = now;
    }
    step.status = status;
    step.result = task.result;
    step.error = task.error;
    if (status === "running" && !step.startedAt) step.startedAt = now;
    if ((status === "succeeded" || status === "failed" || status === "stopped") && !step.finishedAt) {
      step.finishedAt = now;
    }
    if (status === "waiting_you") {
      run.status = "waiting_you";
      run.error = task.error;
      this.audit(conn, "workflow_run_state", run.id, "workflow waiting for you at " + step.id);
      this.persistWorkflowRun(run);
      return;
    }
    if (status === "queued" || status === "running") {
      run.status = status === "running" ? "running" : "queued";
      if (status === "running" && !run.startedAt) run.startedAt = now;
      this.audit(conn, "workflow_run_state", run.id, "workflow " + run.status + " at " + step.id);
      this.persistWorkflowRun(run);
      return;
    }
    if (status === "failed" || status === "stopped") {
      run.status = status;
      run.error = task.error || (status === "stopped" ? "This workflow was stopped." : "This step failed.");
      run.finishedAt = now;
      this.audit(conn, "workflow_run_state", run.id, "workflow " + run.status + " at " + step.id);
      this.persistWorkflowRun(run);
      return;
    }
    // One completed step unlocks exactly one next step. There is no parallel
    // branch and no hidden retry.
    const next = run.steps[run.steps.findIndex(s => s.id === step.id) + 1];
    if (!next) {
      run.status = "succeeded";
      run.finishedAt = now;
      run.currentStepId = undefined;
      this.audit(conn, "workflow_run_state", run.id, "workflow succeeded");
      this.persistWorkflowRun(run);
      return;
    }
    run.status = "queued";
    run.currentStepId = next.id;
    this.audit(conn, "workflow_run_state", run.id, "workflow advanced to " + next.id);
    this.persistWorkflowRun(run);
    this.startWorkflowStep(conn, run, workflow, next.id);
  }

  private stopWorkflowRun(conn: Conn, run: WorkflowRun, requestId?: ID): void {
    const task = run.currentStepId
      ? run.steps.find(s => s.id === run.currentStepId)?.attempts.at(-1)?.taskId
      : undefined;
    if (task) {
      const current = this.store.task(task);
      if (current && !["completed", "failed", "cancelled"].includes(current.status)) {
        current.status = "cancelled";
        current.updatedAt = Date.now();
        this.store.saveTask(current);
        this.publishTask(current);
        if (current.approvalId) {
          const approval = this.store.approval(current.approvalId);
          if (approval?.status === "pending") {
            approval.status = "expired";
            approval.decidedAt = current.updatedAt;
            this.store.saveApproval(approval);
            this.sendApproval(approval);
          }
        }
      }
    }
    run.status = "stopped";
    run.error = "This workflow was stopped.";
    run.finishedAt = Date.now();
    if (run.currentStepId) {
      const step = run.steps.find(s => s.id === run.currentStepId);
      if (step) step.status = "stopped";
      const attempt = step?.attempts.at(-1);
      if (attempt) { attempt.status = "stopped"; attempt.finishedAt = run.finishedAt; }
    }
    this.persistWorkflowRun(run, requestId);
    this.audit(conn, "workflow_run_state", run.id, "workflow stopped");
  }

  private stopRunsForDeletedAgent(conn: Conn, agentId: ID): void {
    for (const run of this.store.workflowRuns(conn.userId, undefined, 1000)) {
      if (!["queued", "running", "waiting_you"].includes(run.status)) continue;
      if (!run.steps.some(step => step.agentId === agentId)) continue;
      run.status = "stopped";
      run.error = "The agent for this workflow was removed; the workflow was stopped.";
      run.finishedAt = Date.now();
      run.updatedAt = run.finishedAt;
      const current = run.currentStepId ? run.steps.find(step => step.id === run.currentStepId) : undefined;
      if (current) {
        current.status = "stopped";
        current.error = run.error;
        const attempt = current.attempts.at(-1);
        if (attempt) {
          attempt.status = "stopped";
          attempt.error = run.error;
          attempt.finishedAt = run.finishedAt;
          const task = this.store.task(attempt.taskId);
          if (task && !["completed", "failed", "cancelled"].includes(task.status)) {
            task.status = "cancelled";
            task.error = run.error;
            task.updatedAt = run.finishedAt;
            this.store.saveTask(task);
            this.publishTask(task);
          }
          if (task?.approvalId) {
            const approval = this.store.approval(task.approvalId);
            if (approval?.status === "pending") {
              approval.status = "expired";
              approval.decidedAt = run.finishedAt;
              this.store.saveApproval(approval);
              this.sendApproval(approval);
            }
          }
        }
      }
      this.store.saveWorkflowRun(run);
      this.tellWorkflowRun(run.ownerId, run);
      this.audit(conn, "workflow_run_state", run.id, "workflow stopped because its agent was removed");
    }
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
      case "listWorkflows": {
        if (conn.userId !== this.ownerId) {
          send(conn.ws, { type: "workflows", workflows: [], runs: [], requestId: frame.requestId });
          break;
        }
        send(conn.ws, {
          type: "workflows",
          workflows: this.store.workflows(conn.userId),
          runs: this.store.workflowRuns(conn.userId),
          requestId: frame.requestId,
        });
        break;
      }
      case "createWorkflow": {
        if (conn.userId !== this.ownerId) throw new Error("only the owner can create workflows");
        const now = Date.now();
        const workflow: Workflow = {
          ...frame.workflow,
          id: newId("wf"), ownerId: conn.userId, version: 1,
          createdAt: now, updatedAt: now,
        };
        const bad = validateWorkflow(workflow);
        if (bad) throw new Error(bad);
        this.channelFor(conn.userId, workflow.channelId);
        this.workflowAgents(conn.userId, workflow);
        this.store.saveWorkflow(workflow);
        this.audit(conn, "workflow_created", workflow.id, "created workflow " + workflow.name);
        this.tellWorkflow(conn.userId, workflow, frame.requestId);
        break;
      }
      case "updateWorkflow": {
        if (conn.userId !== this.ownerId) throw new Error("only the owner can edit workflows");
        const current = this.myWorkflow(conn.userId, frame.workflowId);
        const next: Workflow = {
          ...current, ...frame.patch, version: current.version + 1,
          updatedAt: Date.now(),
        };
        const bad = validateWorkflow(next);
        if (bad) throw new Error(bad);
        this.channelFor(conn.userId, next.channelId);
        this.workflowAgents(conn.userId, next);
        this.store.saveWorkflow(next);
        this.audit(conn, "workflow_updated", next.id, "updated workflow " + next.name);
        this.tellWorkflow(conn.userId, next, frame.requestId);
        break;
      }
      case "archiveWorkflow": {
        if (conn.userId !== this.ownerId) throw new Error("only the owner can archive workflows");
        const current = this.myWorkflow(conn.userId, frame.workflowId);
        const runs = this.store.workflowRuns(conn.userId, current.id);
        if (frame.archived && runs.some(run => ["queued", "running", "waiting_you"].includes(run.status))) {
          throw new Error("stop active runs before archiving this workflow");
        }
        const next: Workflow = { ...current, archivedAt: frame.archived ? Date.now() : undefined, updatedAt: Date.now(), version: current.version + 1 };
        this.store.saveWorkflow(next);
        this.audit(conn, "workflow_archived", next.id, frame.archived ? "archived workflow " + next.name : "restored workflow " + next.name);
        this.tellWorkflow(conn.userId, next, frame.requestId);
        break;
      }
      case "runWorkflow": {
        if (conn.userId !== this.ownerId) throw new Error("only the owner can run workflows");
        const workflow = this.myWorkflow(conn.userId, frame.workflowId);
        if (workflow.archivedAt) throw new Error("this workflow is archived; restore it before running");
        if (!workflow.enabled) throw new Error("this workflow is switched off; enable it before running");
        if (!workflow.steps.length) throw new Error("add a step before running this workflow");
        this.channelFor(conn.userId, workflow.channelId);
        this.workflowAgents(conn.userId, workflow);
        const now = Date.now();
        const run: WorkflowRun = {
          id: newId("wfr"), workflowId: workflow.id, workflowVersion: workflow.version,
          ownerId: conn.userId, requestedBy: conn.userId, channelId: workflow.channelId,
          status: "queued",
          steps: workflow.steps.map(step => ({
            ...step, status: "queued" as const, attempts: [],
          })),
          createdAt: now, updatedAt: now,
        };
        this.store.saveWorkflowRun(run);
        this.audit(conn, "workflow_run_started", run.id, "started workflow " + workflow.name);
        this.tellWorkflowRun(conn.userId, run, frame.requestId);
        this.startWorkflowStep(conn, run, workflow, run.steps[0].id);
        break;
      }
      case "stopWorkflow": {
        if (conn.userId !== this.ownerId) throw new Error("only the owner can stop workflows");
        const run = this.store.workflowRun(frame.workflowRunId);
        if (!run || run.ownerId !== conn.userId) throw new Error("no such workflow run");
        if (["succeeded", "failed", "stopped", "interrupted"].includes(run.status)) {
          this.tellWorkflowRun(conn.userId, run, frame.requestId);
          break;
        }
        this.stopWorkflowRun(conn, run, frame.requestId);
        break;
      }
      case "retryWorkflow": {
        if (conn.userId !== this.ownerId) throw new Error("only the owner can retry workflows");
        const run = this.store.workflowRun(frame.workflowRunId);
        if (!run || run.ownerId !== conn.userId) throw new Error("no such workflow run");
        if (run.status !== "failed" && run.status !== "stopped" && run.status !== "interrupted") {
          throw new Error("retry is available after a step fails or is stopped");
        }
        const workflow = this.myWorkflow(conn.userId, run.workflowId);
        if (workflow.archivedAt) throw new Error("this workflow is archived; restore it before retrying");
        this.workflowAgents(conn.userId, workflow);
        const index = run.steps.findIndex(s => s.id === frame.stepId);
        const failed = run.steps[index];
        if (!failed || (failed.status !== "failed" && failed.status !== "stopped" && failed.status !== "interrupted")) {
          throw new Error("choose the failed or stopped step to retry");
        }
        for (let i = index; i < run.steps.length; i++) {
          run.steps[i].status = "queued";
          run.steps[i].error = undefined;
          run.steps[i].result = undefined;
          run.steps[i].finishedAt = undefined;
        }
        run.status = "queued";
        run.error = undefined;
        run.finishedAt = undefined;
        run.currentStepId = failed.id;
        this.audit(conn, "workflow_run_state", run.id, "retrying workflow at " + failed.id);
        this.persistWorkflowRun(run, frame.requestId);
        this.startWorkflowStep(conn, run, workflow, failed.id);
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

        const artifactIds = this.artifactIdsInChannel(ch.id);
        const beforeArtifacts = this.snapshotArtifactProjections(artifactIds);
        const live = new Set(this.store.channel(ch.id)!.memberIds);
        for (const memberId of new Set(frame.memberIds)) {
          // AN AGENT CARRIES ITS OWNER IN WITH IT — the same rule creating a
          // room asks, asked here by the same function.
          this.assertMayAdd(conn.userId, [memberId], live);
          this.store.addChannelMember(ch.id, memberId, { role: "member", invitedBy: conn.userId });
          live.add(memberId);
        }
        this.pushArtifactProjectionDiff(beforeArtifacts, artifactIds);
        this.audit(conn, "member_added", ch.id, `added ${frame.memberIds.length} member(s) to ${ch.name}`);
        this.broadcastChannel(this.store.channel(ch.id)!);
        this.refreshNotificationRows(this.store.notificationsForChannel(ch.id));
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
        const artifactIds = this.artifactIdsInChannel(ch.id);
        const beforeArtifacts = this.snapshotArtifactProjections(artifactIds);
        this.store.addChannelMember(ch.id, conn.userId, { role: "member" });
        this.pushArtifactProjectionDiff(beforeArtifacts, artifactIds);
        this.audit(conn, "member_added", ch.id, `joined ${ch.name}`);
        // everyone in the room, including the new arrival, learns the new
        // member list; the newcomer then asks for scrollback the ordinary way
        this.broadcastChannel(this.store.channel(ch.id)!);
        this.refreshNotificationRows(this.store.notificationsForChannel(ch.id));
        break;
      }
      case "leaveChannel": {
        const ch = this.channelFor(conn.userId, frame.channelId);
        if (ch.kind === "dm") throw new Error("you can't leave a direct conversation");
        if (!this.store.memberRole(ch.id, conn.userId)) throw new Error("you're not in that conversation");
        const artifactIds = this.artifactIdsInChannel(ch.id);
        const beforeArtifacts = this.snapshotArtifactProjections(artifactIds);
        this.store.removeChannelMember(ch.id, conn.userId, conn.userId);
        this.audit(conn, "member_removed", ch.id, `left ${ch.name}`);
        this.tellLeft(conn.userId, ch.id);
        this.pushArtifactProjectionDiff(beforeArtifacts, artifactIds);
        this.broadcastChannel(this.store.channel(ch.id)!);
        this.refreshNotificationRows(this.store.notificationsForChannel(ch.id));
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
        const artifactIds = this.artifactIdsInChannel(ch.id);
        const beforeArtifacts = this.snapshotArtifactProjections(artifactIds);
        this.store.removeChannelMember(ch.id, frame.memberId, conn.userId);
        this.audit(conn, "member_removed", ch.id, `removed someone from ${ch.name}`);
        // an agent's place in a room belongs to its owner's screen
        const agent = this.store.agents().find(a => a.id === frame.memberId);
        this.tellLeft(agent ? agent.ownerId : frame.memberId, ch.id);
        this.pushArtifactProjectionDiff(beforeArtifacts, artifactIds);
        this.broadcastChannel(this.store.channel(ch.id)!);
        this.refreshNotificationRows(this.store.notificationsForChannel(ch.id));
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
        const artifactIds = this.artifactIdsInChannel(ch.id);
        const beforeArtifacts = this.snapshotArtifactProjections(artifactIds);
        this.store.setMemberRole(ch.id, frame.memberId, frame.role as ChannelRole);
        this.pushArtifactProjectionDiff(beforeArtifacts, artifactIds);
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
        this.refuseAgentPathsFromEngine(conn, frame.agent);
        const agent: AgentDef = {
          ...frame.agent, id: newId("a"), ownerId: conn.userId, createdAt: Date.now(),
        };
        // first gate on untrusted input: some of these fields end up on a
        // command line in the engine host (the engine re-checks too). It is
        // asked about the RECORD, not the frame — see `updateAgent` below for
        // why that distinction is the whole fix.
        const bad = validateAgentDefinition(agent, this.agentRules(conn, frame.agent.provider));
        if (bad) throw new Error(bad);
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
        this.refuseAgentPathsFromEngine(conn, frame.agent);
        // AN AGENT KEEPING ITS OWN NAME IS NOT A DUPLICATE, and this is the
        // line that protects his EXISTING data. Two agents already called
        // `Scout` are in his database right now; asked the uniqueness question
        // afresh, saving either of them would fail for ever and he could never
        // edit his way out of it. So the question is only asked when the name
        // is actually being CHANGED — a rename must not collide, a save must
        // not be refused for a clash that was already there.
        const renaming = typeof frame.agent.name === "string"
          && nameKey(frame.agent.name) !== nameKey(existing.name);
        // WHAT WOULD BE STORED IS WHAT IS JUDGED. This used to check the frame
        // and then store something else, and that gap is where an agent could
        // be destroyed: `{ id, name, ownerId }` — a stale screen, a half-built
        // client — passed the field-by-field checks, because every one of those
        // fields is optional, and the stub was then written straight over a
        // complete agent. Its job, its emoji and its abilities were gone, and
        // the next screen to draw it went white on `persona.trim()`.
        //
        // So the record is BUILT first and asked about second, and it is asked
        // "are you a whole agent" rather than "is what you mention alright".
        // Nothing is written until that answer is yes.
        const saved: AgentDef = {
          ...frame.agent,
          // these three are facts the hub owns, never things a client restates
          id: existing.id,
          ownerId: existing.ownerId,
          createdAt: existing.createdAt,
          // An edit that never mentions a skill's files must not delete them
          // (M3). One rule, here, for every client — see `keepSkillFiles`.
          skills: keepSkillFiles(existing.skills, frame.agent.skills),
          // …and the same sentence-vs-silence rule for the abilities. There is
          // no "no abilities" state for a person to choose, so an edit that
          // never mentions them means "leave them alone" — it can never be a
          // request to strip an agent of what it may do.
          abilities: frame.agent.abilities ?? existing.abilities,
          // …and the same sentence-vs-silence rule for how much this agent may
          // do on its own. An older client, or a screen that has never heard of
          // the setting, says nothing about it — and silence must mean "leave it
          // as he set it", never "reset it". It cannot be used to widen an
          // agent: silence PRESERVES, and saying one of the three words is a
          // write only the owner's own editor can make (`myAgent` above proved
          // whose agent this is) and only if `validateAgentDefinition` below
          // recognises the word.
          trust: frame.agent.trust ?? existing.trust,
          // …and the same sentence-vs-silence rule for whose setup it runs in.
          // An older client, or any screen that has never heard of the switch,
          // says nothing — and silence must mean "leave it as he set it". It
          // cannot be used to widen an agent either: silence PRESERVES, and
          // saying yes is a write only his own editor can make (`myAgent` proved
          // whose agent this is, and `refuseAgentPathsFromEngine` above proved
          // it did not come from an agent).
          useOwnerSetup: frame.agent.useOwnerSetup ?? existing.useOwnerSetup,
          // …AND THE SAME RULE AGAIN for the three settings added 2026-08-05.
          // Silence PRESERVES. It matters most for the spending limit, where the
          // two readings point in opposite directions: an older client, or any
          // screen that has never heard of the setting, saying nothing about it
          // must not be able to REMOVE a ceiling the owner deliberately set —
          // "your spending limit quietly disappeared" is the one outcome a limit
          // may never have. It cannot be used to widen anything either: silence
          // keeps what is stored, and setting a value is a write only his own
          // editor can make, and only if `validateAgentDefinition` accepts it.
          spendCap: frame.agent.spendCap ?? existing.spendCap,
          planFirst: frame.agent.planFirst ?? existing.planFirst,
          fallbackModels: frame.agent.fallbackModels ?? existing.fallbackModels,
        };
        const bad = validateAgentDefinition(saved, renaming
          ? this.agentRules(conn, frame.agent.provider, frame.agent.id)
          : { ...this.agentRules(conn, frame.agent.provider), takenNames: undefined });
        if (bad) throw new Error(bad);
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
        this.stopRunsForDeletedAgent(conn, frame.agentId);
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
      case "createJoinToken": {
        // A join link admits a NEW PERSON over the network, so — like an invite —
        // only the owner may cut one.
        if (conn.userId !== this.ownerId) {
          throw new Error("only the owner of this Cloud9 can create a join link");
        }
        const code = mintJoinToken(this.store, conn.userId);
        this.audit(conn, "invite_created", code, "created a join link");
        send(conn.ws, { type: "joinToken", code, expiresInMs: JOIN_TOKEN_TTL_MS });
        break;
      }
      case "revokeJoinToken": {
        if (conn.userId !== this.ownerId) {
          throw new Error("only the owner of this Cloud9 can cancel a join link");
        }
        retireJoinToken(this.store, frame.code);
        this.audit(conn, "invite_created", frame.code, "cancelled a join link");
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
        const affectedArtifacts = this.store.channels()
          .filter(ch => ch.memberIds.includes(target.id))
          .map(ch => {
            const ids = this.artifactIdsInChannel(ch.id);
            return { ids, before: this.snapshotArtifactProjections(ids) };
          });
        this.store.removeUser(target.id);
        this.audit(conn, "agent_deleted", target.id, `removed ${target.name} from this Cloud9`);
        for (const a of theirAgents) {
          delete this.agentStatus[a.id];
          this.broadcast({ type: "agentDeleted", agentId: a.id });
        }
        for (const affected of affectedArtifacts) {
          this.pushArtifactProjectionDiff(affected.before, affected.ids);
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
        this.createTaskFor(conn, {
          agentId: frame.agentId, channelId: frame.channelId, title: frame.title,
          requesterId: frame.requesterId,
        });
        break;
        /*
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
        this.publishTask(task);
        */
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
        if (task.workflowRunId && (task.status === "completed" || task.status === "failed")) break;
        if (task.workflowRunId) {
          const run = this.store.workflowRun(task.workflowRunId);
          const step = run?.steps.find(candidate => candidate.id === task.workflowStepId);
          const attempt = step?.attempts.at(-1);
          const incoming: WorkflowStepStatus =
            frame.status === "working" ? "running"
            : frame.status === "waiting_approval" || frame.status === "waiting_user" || frame.status === "blocked" ? "waiting_you"
            : frame.status === "completed" ? "succeeded"
            : frame.status === "failed" ? "failed"
            : (frame.status as string) === "cancelled" ? "stopped"
            : "queued";
          if (attempt && (attempt.status === "succeeded" || attempt.status === "failed" || attempt.status === "stopped" || attempt.status === "interrupted")) break;
          if (attempt && (attempt.status === "running" || attempt.status === "waiting_you") && incoming === "queued") break;
          if (attempt?.status === "running" && incoming === "waiting_you") {
            const approval = task.approvalId ? this.store.approval(task.approvalId) : undefined;
            if (task.approvalId && approval?.status !== "pending") break;
          }
          if (attempt?.status === "waiting_you" && incoming === "running") {
            const approval = task.approvalId ? this.store.approval(task.approvalId) : undefined;
            if (approval?.status !== "approved") break;
          }
          if (attempt?.status === "waiting_you" && task.approvalId
            && this.store.approval(task.approvalId)?.status === "pending" && incoming !== "waiting_you") break;
        }
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
        this.publishTask(task);
        this.workflowTaskChanged(conn, task);
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
        this.publishTask(task);
        if (task.workflowRunId && task.approvalId) {
          const approval = this.store.approval(task.approvalId);
          if (approval?.status === "pending") {
            approval.status = "expired";
            approval.decidedAt = task.updatedAt;
            this.store.saveApproval(approval);
            this.sendApproval(approval);
          }
        }
        this.workflowTaskChanged(conn, task);
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
        // IS THIS A THING CLOUD9 CAN PUT WORDS TO? That is the hub's question,
        // and `validateRemoteActionFacts` above has already answered it — the
        // action is on the shared `REMOTE_ACTIONS` table or the frame was
        // refused. So an extra card is always drawable and always safe.
        //
        // IT USED TO ASK `mustAskBeforeActing` HERE INSTEAD, and that became
        // wrong the moment the owner could say "don't ask me about this agent".
        // The engine and the hub read the same rule off the same stored agent,
        // but not in the same instant: he can change the setting while a turn is
        // already in flight. With the old line, the engine's slightly older copy
        // saying "ask" met the hub's newer copy saying "go ahead" and the hub
        // threw — turning HIS decision to be interrupted LESS into an error in
        // the room. An extra question is never the unsafe direction; refusing to
        // ask one is. The rule that decides whether anything HAPPENS is
        // unchanged and still lives in exactly one place (`decideAsking`), read
        // by the engine before it ever sends this frame and by `requiresApproval`
        // before a job may start.
        if (!isRemoteAction(frame.facts.action)) {
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
          ...(taskId ? { taskId } : {}),
          ...(detail ? { detail: detail.slice(0, APPROVAL_LIMITS.detail) } : {}),
        };
        // Keep an in-flight workflow task tied to the exact card that parked
        // it. The ordinary job gate already does this at creation time; a
        // mid-run ask must establish the same correlation before the engine's
        // blocked/working receipts arrive.
        if (taskId) {
          const task = this.store.task(taskId);
          if (task) {
            task.approvalId = approval.id;
            task.updatedAt = now;
            this.store.saveTask(task);
          }
        }
        this.store.saveApproval(approval);
        this.audit(conn, "approval_requested", approval.id,
          `${agent.name} asks to ${approval.action}`, { asAgent: agent });
        // the receipt goes to the asking socket only; the CARD goes to the
        // owner's screens (and to that same engine, which is one of them)
        send(conn.ws, { type: "approvalAsked", askId, approvalId: approval.id });
        this.sendApproval(approval);
        // and it remains pending until the owner decides or stops the agent
        break;
      }
      case "askPlan": {
        // ENGINE ONLY, for exactly the reason the case above is: a desktop
        // client able to mint approval cards could manufacture a harmless one
        // and then approve it with its own second frame.
        if (conn.client !== "engine") {
          throw new Error("only the engine can ask you to look at a plan");
        }
        // WHOSE AGENT and WHICH ROOM, both from stored state, never the frame.
        const agent = this.myAgent(conn.userId, frame.agentId);
        const channel = this.channelFor(conn.userId, frame.channelId);
        const badPlan = validatePlanAsk(frame.plan);
        if (badPlan) throw new Error(badPlan);
        const askId = typeof frame.askId === "string"
          ? frame.askId.slice(0, APPROVAL_LIMITS.askId).trim() : "";
        if (!askId) throw new Error("that request has no label to answer against");
        const namedTask = frame.taskId ? this.store.task(frame.taskId) : undefined;
        const taskId = namedTask && namedTask.agentId === agent.id ? namedTask.id : undefined;
        const now = Date.now();
        // THE AGENT WROTE THE PLAN, SO THE PLAN IS CONTAINED — bounded and
        // stripped by `tidyPlan` here, at the hub, on the way in. The line the
        // owner reads FIRST is still Cloud9's (`planHeadline`), taken from the
        // plan rather than composed by the agent, exactly as the sentence on an
        // `action` card is Cloud9's rather than the agent's.
        const plan = tidyPlan(frame.plan);
        const approval: Approval = {
          id: newId("ap"), agentId: agent.id, ownerId: agent.ownerId,
          action: planHeadline(plan).slice(0, APPROVAL_LIMITS.action),
          status: "pending", createdAt: now,
          kind: "plan", channelId: channel.id,
          plan,
          ...(taskId ? { taskId } : {}),
        };
        this.store.saveApproval(approval);
        this.audit(conn, "approval_requested", approval.id,
          `${agent.name} is waiting for you to look at a plan`, { asAgent: agent });
        send(conn.ws, { type: "approvalAsked", askId, approvalId: approval.id });
        this.sendApproval(approval);
        break;
      }
      case "askSaving": {
        // ENGINE ONLY, for exactly the reason the two cases above are: a client
        // able to mint approval cards could manufacture one and then approve it
        // with its own second frame.
        if (conn.client !== "engine") {
          throw new Error("only the engine can ask you about a saving");
        }
        // WHOSE AGENT IS ASKING, from stored state, never the frame.
        const agent = this.myAgent(conn.userId, frame.agentId);
        const channel = this.channelFor(conn.userId, frame.channelId);
        // AND WHOSE AGENT IT IS ABOUT — asked separately, through the SAME
        // `myAgent` gate. This is the line that keeps one person's agent from
        // ever putting a card in front of somebody else about an agent they do
        // not own. `myAgent` throws if the id is not this owner's, so a
        // proposal about a stranger's agent never becomes a card at all.
        // SHAPE FIRST, THEN OWNERSHIP. The other order works but answers the
        // wrong question out loud: a proposal with no `about` at all would come
        // back as "not your agent", which sends whoever is reading the log
        // hunting for a permission problem that is not there.
        const badSaving = validateSavingProposal(frame.proposal);
        if (badSaving) throw new Error(badSaving);
        const about = this.myAgent(conn.userId, frame.proposal.about);
        const askId = typeof frame.askId === "string"
          ? frame.askId.slice(0, APPROVAL_LIMITS.askId).trim() : "";
        if (!askId) throw new Error("that request has no label to answer against");
        const namedTask = frame.taskId ? this.store.task(frame.taskId) : undefined;
        const taskId = namedTask && namedTask.agentId === agent.id ? namedTask.id : undefined;
        const now = Date.now();
        // THE AGENT WROTE THE REASON, SO THE REASON IS CONTAINED — bounded and
        // stripped by `tidySaving` here, at the hub, on the way in. Everything
        // the owner reads FIRST is Cloud9's own: the headline, the detail line
        // and the name of the agent are all built from the CHANGE, which comes
        // out of a closed vocabulary, never from anything the agent phrased.
        const proposal: SavingProposal = {
          about: about.id,
          // the stored name, not the one the agent typed — a card that names an
          // agent has to name the one it would really change
          aboutName: about.name,
          change: frame.proposal.change,
          because: tidySaving(frame.proposal.because),
        };
        const approval: Approval = {
          id: newId("ap"), agentId: agent.id, ownerId: agent.ownerId,
          action: savingHeadline(proposal).slice(0, APPROVAL_LIMITS.action),
          status: "pending", createdAt: now,
          kind: "saving", channelId: channel.id,
          detail: savingDetail(proposal).slice(0, APPROVAL_LIMITS.detail),
          saving: proposal,
          ...(taskId ? { taskId } : {}),
        };
        this.store.saveApproval(approval);
        this.audit(conn, "approval_requested", approval.id,
          `${agent.name} suggested a way to spend less on ${about.name}`, { asAgent: agent });
        send(conn.ws, { type: "approvalAsked", askId, approvalId: approval.id });
        this.sendApproval(approval);
        break;
      }
      case "decideApproval": {
        // a card he has already answered is not answerable twice
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
        // ===== SPENDING BLOCK (what the crew costs, 2026-08-07) — start =====
        //
        // A YES ON A SAVING CARD IS THE MOMENT THE SETTING CHANGES, and this is
        // the only line in Cloud9 that makes that change.
        //
        // IT IS DONE HERE, IN THE DECISION, ON PURPOSE. The obvious alternative
        // was for his window to send an ordinary `updateAgent` after clicking
        // Approve. That is two frames with a gap between them, and the gap is
        // where it goes wrong: if the second one is refused, the card already
        // says "approved" and nothing has actually changed. A record that says
        // he agreed to something that did not happen is exactly the shape of
        // lie this app spends the rest of its comments avoiding. One frame, one
        // decision, one write.
        //
        // NOBODY GAINS A POWER FROM THIS. The write is caused by the OWNER's own
        // decision frame — `approval.ownerId !== conn.userId` two lines above is
        // the same gate every other decision passes — and what may be written is
        // `SavingChange`, a closed union of two settings that can only ever make
        // an agent cost LESS or do LESS. The agent that suggested it cannot
        // reach this line, cannot widen it, and is never told anything more than
        // "he accepted it".
        //
        // AND IT NEVER FAILS SILENTLY. If the agent it is about has since been
        // deleted, or the stored change is one this version does not recognise,
        // nothing is written and it is said out loud in the trail — the decision
        // still stands as his, because it was.
        if (approval.kind === "saving" && frame.decision === "approved") {
          const target = approval.saving
            ? this.store.agents().find(a => a.id === approval.saving!.about)
            : undefined;
          const changed = target && target.ownerId === conn.userId && approval.saving
            ? applySaving(target, approval.saving.change)
            : undefined;
          if (changed) {
            this.store.saveAgent(changed);
            this.audit(conn, "agent_updated", changed.id,
              `${changed.name}: ${approval.action}`);
            this.broadcast({ type: "agent", agent: changed });
          } else {
            this.audit(conn, "approval_decided", approval.id,
              `nothing was changed — the agent this was about is no longer here`);
          }
        }
        // ===== SPENDING BLOCK — end =====
        const task = approval.taskId ? this.store.task(approval.taskId) : undefined;
        if (task && task.status === "waiting_approval") {
          task.status = frame.decision === "approved" ? "not_started" : "cancelled";
          if (frame.decision === "rejected") task.error = "rejected by owner";
          task.updatedAt = Date.now();
          this.store.saveTask(task);
          this.audit(conn, "task_status", task.id, `task "${task.title}" → ${task.status}`);
          this.publishTask(task);
          this.workflowTaskChanged(conn, task);
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
      /* "THE CODE FOR THIS PROJECT IS IN THIS FOLDER."
         THE OWNER, FROM A WINDOW — never an agent. An engine connection is
         refused here rather than anywhere else, because this is the one place
         the folder can be set: an agent able to point Cloud9 at a folder could
         point `!code` at any folder on the machine, and the owner saying where
         their own code is is the whole safety of the worktree design.
         `""` clears it — the same absent-vs-empty rule as every other field. */
      case "setProjectFolder": {
        if (conn.client === "engine") {
          throw new Error("only you can say where your code lives — an agent cannot");
        }
        const project = this.myProject(conn.userId, frame.projectId);
        const said = typeof frame.path === "string" ? frame.path.trim() : "";
        if (said) {
          const bad = validateLocalFolder(said);
          if (bad) throw new Error(bad);
          project.localPath = said;
        } else {
          delete project.localPath;
        }
        this.store.saveProject(project);
        this.audit(conn, "project_updated", project.id,
          said ? `linked ${project.repo} to a folder on this computer` : `unlinked ${project.repo}`);
        // EVERY connection of this owner's, the ENGINE included — that is how
        // the copy of Cloud9 that runs the agents finds out where to work.
        this.toUser(conn.userId, { type: "project", project: this.viewProject(project) });
        break;
      }
      /* "SHOW ME MY REPOSITORIES." The hub cannot ask GitHub, so it asks the
         owner's own engine — the same split as `syncProject`. With no engine
         running there is nothing to ask, and that is ANSWERED in words rather
         than thrown: the picker must say why instead of showing an empty list
         that reads like "you have no repositories". */
      case "listRepositories": {
        if (!this.hasEngine(conn.userId)) {
          send(conn.ws, {
            type: "repositories", fetchedAt: Date.now(),
            problem: "Cloud9 isn't running on the computer your GitHub sign-in is on, so nothing could ask GitHub for your repositories. Open Cloud9 there, or type the repository below.",
          });
          break;
        }
        this.toEngines(conn.userId, { type: "listRepositoriesRequested" });
        // AND ANSWER THE ASKER NOW, with a receipt. Every other frame this hub
        // reads is answered before it reads the next one, and the screen counts
        // on that to know whose refusal a later `error` is. This one is handed
        // to the engine, so without a receipt it would sit in that queue and
        // catch somebody else's refusal — which is exactly what it did.
        send(conn.ws, { type: "repositories", asking: true, fetchedAt: Date.now() });
        break;
      }
      case "repositoriesFound": {
        if (conn.client !== "engine") throw new Error("only the engine asks GitHub");
        let repos: RepoChoice[] | undefined;
        if (frame.repos !== undefined) {
          if (!Array.isArray(frame.repos)) throw new Error("that isn't a list of repositories");
          if (frame.repos.length > REPO_LIST_LIMITS.rows) {
            throw new Error("that's more repositories than Cloud9 will hold");
          }
          for (const row of frame.repos) {
            const bad = validateRepoChoice(row);
            if (bad) throw new Error(bad);
          }
          repos = frame.repos;
        }
        const problem = frame.problem === undefined
          ? undefined
          : String(frame.problem).slice(0, REPO_LIST_LIMITS.problem).trim();
        this.toUser(conn.userId, {
          type: "repositories",
          ...(repos ? { repos } : {}),
          ...(problem ? { problem } : {}),
          // WHEN IT WAS REALLY ASKED IS DECIDED HERE, exactly like `syncedAt`:
          // an engine could report any clock it liked, and the screen says
          // "fetched at" out loud.
          fetchedAt: Date.now(),
        });
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
      // ===== SPENDING BLOCK (what the crew costs, 2026-08-07) — start =====
      //
      // WHAT HIS CREW IS COSTING HIM, added up here because here is where the
      // records are. The window would otherwise need every stored run of every
      // agent to see the figure on each one, which is hundreds of round trips to
      // draw one screen.
      //
      // WHOSE CREW: `agentsOf(conn.userId)`. There is nothing on the frame to
      // name anybody, so there is nothing to check against and nothing to get
      // wrong. Being in a room with someone's agent has never been a licence to
      // read what they spend, and this changes none of that.
      //
      // THE SAME ARITHMETIC THE AGENT'S OWN TOOL USES — `rollUpTokenUse` and
      // `findWaste` out of @cloud9/shared, not a hub-flavoured version of them.
      // A screen and an agent that disagree about the same money would be worse
      // than neither existing.
      case "spending": {
        const at = Date.now();
        const rows = this.store.agents().filter(a => a.ownerId === conn.userId).map(agent => {
          const provider = agent.provider ?? "claude";
          const use = rollUpTokenUse({
            agentId: agent.id, agentName: agent.name, provider, now: at,
            runs: this.store.runsForAgent(agent.id, RUN_RETENTION.perAgent).map(row => ({
              startedAt: row.record.startedAt,
              // the RUN's provider, not the agent's as it is set up today — see
              // `RunStore.countableRuns` for why a record must not re-describe
              // itself when he changes a setting
              provider: row.record.provider || provider,
              outcome: row.record.outcome,
              ...(typeof row.record.ownerSetup === "boolean"
                ? { ownerSetup: row.record.ownerSetup } : {}),
              ...(row.record.usage ? { usage: row.record.usage } : {}),
            })),
          });
          return { use, findings: findWaste({ use, agent }) };
        }).filter(row => row.use.runs > 0);
        send(conn.ws, { type: "spending", period: "thisMonth", at, rows });
        break;
      }
      // ===== SPENDING BLOCK — end =====
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
      // ---- agent memory: read and clear an agent's saved notes ----
      //
      // The hub keeps NO copy of memory — the engine's own store is the one
      // durable copy (docs/plans/agent-memory-handoff.md §7). The hub only
      // routes: it checks the agent is the asker's, then asks that owner's
      // engine to report or forget, and forwards what the engine sends back.
      case "memoryList": {
        this.myAgent(conn.userId, frame.agentId); // your agent, or it throws
        this.toEngines(conn.userId, { type: "memoryListRequested", agentId: frame.agentId });
        break;
      }
      case "forgetMemoryNote": {
        this.myAgent(conn.userId, frame.agentId);
        if (!isSafeStoredId(frame.noteId)) throw new Error("no such note");
        this.toEngines(conn.userId,
          { type: "forgetMemoryRequested", agentId: frame.agentId, noteId: frame.noteId });
        break;
      }
      // ENGINE-HOST ONLY: the agent's saved notes, read off this computer's own
      // store. A REPORT, not a permission — the hub checks whose agent it is
      // from stored state, then hands the notes only to that owner's own screens.
      case "memoryChanged": {
        if (conn.client !== "engine") {
          throw new Error("only the engine reports what an agent remembers");
        }
        const agent = this.myAgent(conn.userId, frame.agentId);
        this.toUser(agent.ownerId, { type: "memory", agentId: agent.id, notes: frame.notes });
        break;
      }
      // ENGINE-HOST ONLY: one of the owner's agents is handing work to another.
      // The hub validates it with the SAME rule the builder used, checks the
      // sender owns the from-agent, then delivers it to the receiving agent's
      // own engine. It runs nothing itself.
      case "sendHandoff": {
        if (conn.client !== "engine") {
          throw new Error("only the engine can hand work between agents");
        }
        const problem = validateHandoff(frame.handoff);
        if (problem) throw new Error(problem);
        this.myAgent(conn.userId, frame.handoff.fromAgentId); // your agent is the sender
        const to = this.store.agents().find(a => a.id === frame.handoff.toAgentId);
        if (!to) throw new Error("no such agent to hand off to");
        this.toEngines(to.ownerId, { type: "handoffReceived", handoff: frame.handoff });
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
      /**
       * "Let me in to GitHub." Same privilege class as the harness sign-ins —
       * it makes a program start on the owner's computer — so it goes through
       * the same gate and gets its own cooldown.
       *
       * It does NOT take the shared `signInFlight` lock. That lock is released
       * by a `harnessState` frame in which neither AI app is signing in, so a
       * GitHub sign-in holding it would be released the moment the next
       * detection round landed — a lock that lies is worse than no lock. The
       * engine host refuses a second GitHub window on its own, which is where
       * that knowledge actually lives.
       */
      case "githubSignIn": {
        this.assertHarnessAllowed(conn);
        const now = Date.now();
        if (now - (this.githubSignInAt[conn.userId] ?? 0) < SIGNIN_COOLDOWN_MS) {
          throw new Error("give the last sign-in a moment before trying again");
        }
        this.githubSignInAt[conn.userId] = now;
        // only this user's own engine host may be told to sign in
        this.toEngines(conn.userId, { type: "harnessRequest", action: "githubSignIn" });
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
      case "searchEverywhere": {
        // THE SCOPE IS COMPUTED HERE, from stored membership, exactly as
        // `search` and `welcome` compute it. Nothing in this frame can widen
        // it: `kind` narrows which sort of row comes back and that is all it
        // does. The narrower file-permission rule is applied inside the store,
        // in SQL, before any limit — see `Store.searchEverywhere`.
        const query = typeof frame.query === "string" ? frame.query : "";
        if (searchTerms(query).length === 0) {
          // An empty or punctuation-only query is refused in words, not
          // answered with every message in the house and not met with silence.
          throw new Refusal("type at least one word to search for");
        }
        const page = this.store.searchEverywhere(
          conn.userId, this.visibleChannels(conn.userId), query,
          { kind: frame.kind, limit: frame.limit },
        );
        send(conn.ws, {
          type: "searchEverywhereResults", query,
          ...(frame.kind !== undefined ? { kind: frame.kind } : {}),
          results: page.items, hasMore: page.hasMore,
          ...(frame.requestId !== undefined ? { requestId: frame.requestId } : {}),
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
      case "agentReceipt": {
        // A SEMANTIC RECEIPT (his §2) — "reading" / "thinking" / one committed
        // verdict, forwarded live to the room and then forgotten.
        //
        // IT DELIBERATELY DOES NOT TOUCH `this.store`. Not a message, not a
        // reaction, not an activity row: nothing here is written, so nothing
        // here can be searched, re-read after a reload, or counted as unread.
        // A machine saying "I am reading this" is not something anyone should
        // have to catch up on, and storing it would fill his history with the
        // clutter §2 exists to replace.
        //
        // Every gate an agent's reaction passes, it passes too, and by the same
        // functions: `myAgent` proves the engine owns the agent from STORED
        // state, `messageFor` proves the message exists and this account can
        // see the room it is in, and `audienceFor` (via `toChannel`) decides
        // who hears it. One owner for visibility, reused — a broadcast with a
        // second rule about who may see it is a leak waiting to be written.
        const agent = this.myAgent(conn.userId, frame.agentId);
        const message = this.messageFor(conn.userId, frame.messageId);
        // the frame's own channel must be the message's real one. A receipt is
        // drawn on a message, so a mismatched channel is not a routing hint, it
        // is a signal aimed at a room it does not belong to.
        if (message.channelId !== frame.channelId) throw new Error("no such message");
        if (!isReceiptStage(frame.stage)) throw new Error("that isn't a receipt");
        // `verdict` is required for a verdict and refused for anything else —
        // checked here rather than trusted, so no client can send a committed
        // answer with nothing in it or a "reading" that carries a ✅.
        if (frame.stage === "verdict") {
          if (!isReceiptVerdict(frame.verdict)) throw new Error("that isn't a verdict");
        } else if (frame.verdict !== undefined) {
          throw new Error("only a committed receipt carries a verdict");
        }
        const ch = this.store.channel(message.channelId)!;
        // `at` is OURS. An engine could report any clock it liked, and a screen
        // decides when a signal is stale from this number.
        this.toChannel(ch, {
          type: "receipt",
          receipt: {
            channelId: ch.id, messageId: message.id, agentId: agent.id,
            stage: frame.stage,
            ...(frame.verdict ? { verdict: frame.verdict } : {}),
            at: Date.now(),
          },
        });
        break;
      }
      case "agentSteps": {
        // WHAT THIS AGENT IS DOING RIGHT NOW — forwarded to the room, and then
        // forgotten. The twin of `agentReceipt` above in every way that matters:
        //
        //   IT DOES NOT TOUCH `this.store`. Not a message, not an activity row,
        //   not a run record. The STORED record still arrives separately through
        //   `runRecorded`, at the end of the turn, and THAT is the one that is
        //   written, searched and served later. Storing the preview as well
        //   would be the same facts kept twice, and two copies of a fact is one
        //   copy that can be wrong.
        //
        //   SAME GATES, SAME FUNCTIONS. `myAgent` proves ownership from stored
        //   state, `messageFor` proves the message exists and this account can
        //   see the room, `audienceFor` (via `toChannel`) decides who hears it.
        //   No second rule about who may see a room.
        const agent = this.myAgent(conn.userId, frame.agentId);
        const message = this.messageFor(conn.userId, frame.messageId);
        if (message.channelId !== frame.channelId) throw new Error("no such message");
        // shape checked, never trusted — the same limits a stored step lives
        // under, so the live path cannot become a way around them
        const bad = validateLiveSteps(frame.steps, frame.done);
        if (bad) throw new Error(bad);
        const ch = this.store.channel(message.channelId)!;
        // REDACTED ON THE WAY OUT, exactly as a stored record is. A live step
        // carries a file name and a command; the engine already scrubbed it, and
        // this is the second pass that means a record from an older or broken
        // engine is still scrubbed before it reaches anybody.
        const steps = (frame.steps ?? []).map(s => ({
          ...s,
          label: redactForSharing(s.label, RUN_LIMITS.label),
          ...(s.detail ? { detail: redactForSharing(s.detail, RUN_LIMITS.detail) } : {}),
        }));
        this.toChannel(ch, {
          type: "liveSteps",
          live: {
            channelId: ch.id, messageId: message.id, agentId: agent.id,
            steps,
            ...(frame.done ? { done: true } : {}),
            // OURS, like a receipt's. An engine could report any clock it liked,
            // and the screen decides when a preview is stale from this number.
            at: Date.now(),
          },
        });
        break;
      }
      case "editMessage": {
        const message = this.messageFor(conn.userId, frame.messageId);
        this.writableChannel(conn.userId, message.channelId);
        this.assertAuthor(conn.userId, message);
        if (message.deletedAt) throw new Error("that message was deleted");
        const priorReplies = message.replyTo
          ? this.store.thread(message.replyTo).filter(m => m.id !== message.id)
          : [];
        const bad = validateMessageText(frame.text, (message.attachments?.length ?? 0) > 0);
        if (bad) throw new Error(bad);
        message.text = frame.text;
        message.editedAt = Date.now();
        // an edit re-decides who was named, so an @mention can be added or taken
        // back — otherwise editing would leave the old names notifying forever
        message.mentions = this.mentionsFor(conn.userId, frame.text);
        this.store.saveMessage(message);
        // An edit can add a new @mention. The relay recomputes recipients from
        // stored facts and the same deterministic event id keeps repeats
        // idempotent while still creating a row for a newly named person.
        const ch = this.store.channel(message.channelId);
        if (ch) this.recordMessageNotifications(ch, message, priorReplies);
        this.auditMessage(conn, message, "message_edited", "edited a message");
        this.broadcastMessageUpdate(message);
        this.refreshNotificationRows(this.store.notificationsForMessage(message.id));
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
        this.refreshNotificationRows(this.store.notificationsForMessage(message.id));
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
        const { ticket, expiresAt } = this.mintTicket(
          conn.userId, { kind: "attachment", id: row.attachment.id });
        send(conn.ws, {
          type: "attachmentTicket", attachmentId: row.attachment.id,
          ticket, url: ATTACHMENT_TICKET.path + ticket, expiresAt,
          attachment: row.attachment,
        });
        break;
      }
      // ---- files an AGENT made (docs/plans/artifact-store-handoff.md) ----
      case "publishArtifact": {
        // ENGINE ONLY: a screen cannot put bytes into a room wearing an agent's
        // name. Agent and room are both read from stored state.
        if (conn.client !== "engine") {
          throw new Error("only your own agent engine can share a file an agent made");
        }
        const agent = this.myAgent(conn.userId, frame.agentId);
        const channel = this.writableChannel(conn.userId, frame.channelId);
        let bytes: Buffer;
        try { bytes = Buffer.from(String(frame.dataBase64 ?? ""), "base64"); }
        catch { throw new Error("that file didn't arrive properly"); }
        const bad = validateArtifact(frame.name, bytes.length);
        if (bad) throw new Error(bad);
        if (this.store.artifactPublishesSince(agent.id, Date.now() - 60_000)
          >= ARTIFACT_LIMITS.publishesPerMinute) {
          throw new Error(
            `${agent.name} is sharing files faster than anyone can read them — ` +
            "it has to wait a minute");
        }

        let links: ArtifactLink[] = [];
        if (frame.links !== undefined) {
          const linksBad = validateArtifactLinks(frame.links);
          if (linksBad) throw new Error(linksBad);
          links = normaliseArtifactLinks(frame.links);
        }
        // Shape came from shared's validator; stored state proves every target is
        // the exact retained version, in this same source room, and readable to
        // the publisher. Missing and hidden get the same refusal.
        for (const link of links) {
          let target: StoredArtifact;
          try { target = this.artifactFor(conn.userId, link.target.artifactId); }
          catch { throw new Error("a linked file version is not available in this conversation"); }
          if (target.channelId !== channel.id || !versionOf(target, link.target.version)) {
            throw new Error("a linked file version is not available in this conversation");
          }
        }

        const already = this.store.artifactRowByName(channel.id, frame.name);
        if (already) this.artifactFor(conn.userId, already.id);
        if (!already && this.store.artifactCountIn(channel.id) >= ARTIFACT_LIMITS.perChannel) {
          throw new Error(
            `this conversation already holds ${ARTIFACT_LIMITS.perChannel} shared files — ` +
            "the oldest have to be cleared before another can be added");
        }

        const beforeRelations = already
          ? this.store.artifactRelationNeighbors(already.id)
          : [];
        const beforeArtifactIds = [
          ...(already ? [already.id] : []),
          ...beforeRelations,
          ...links.map(link => link.target.artifactId),
        ];
        const beforeArtifacts = this.snapshotArtifactProjections(beforeArtifactIds);
        const now = Date.now();
        const versionId = newId("av");
        // Bytes land under a publish-only stage. The append transaction promotes
        // them while owning the same DB lock startup cleanup needs.
        const stage = this.store.writeArtifactBytes(versionId, frame.name, bytes);
        const run = this.runOf(agent.id, channel.id, frame.runId);
        const stored: Omit<StoredArtifactVersion, "version"> = {
          id: versionId, size: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          text: looksLikeText(bytes), storedAs: stage.storedAs,
          agentId: agent.id, agentName: agent.name, ownerId: agent.ownerId,
          ...(run ? { runId: run.record.id } : {}),
          ...(this.taskOf(agent.id, frame.taskId) ? { taskId: frame.taskId as ID } : {}),
          ...(typeof frame.note === "string" && frame.note.trim()
            ? { note: frame.note.trim().slice(0, ARTIFACT_LIMITS.note) } : {}),
          ...(links.length > 0 ? { links } : {}),
          producedAt: now,
        };
        let artifact = this.store.appendArtifactVersion({
          channelId: channel.id, name: frame.name, at: now, version: stored, stage,
        });
        const afterAppendRelations = this.store.artifactRelationNeighbors(artifact.id);
        this.store.pruneArtifactVersions(artifact.id, ARTIFACT_LIMITS.versions);
        artifact = this.store.artifact(artifact.id)!;
        const version = latestVersion(artifact)!.version;
        this.store.logActivity({
          actorKind: "agent", actorId: agent.id, actorName: agent.name,
          kind: "message", refId: artifact.id,
          detail: `shared ${artifact.name} (version ${version}) in channel ${channel.id}`,
        });
        this.pushArtifactProjectionDiff(beforeArtifacts, [
          artifact.id, ...beforeRelations, ...afterAppendRelations,
        ]);
        break;
      }
      case "artifacts": {
        const channel = this.channelFor(conn.userId, frame.channelId);
        send(conn.ws, {
          type: "artifacts", channelId: channel.id,
          artifacts: this.store.artifactsInFor(conn.userId, channel.id, ARTIFACT_LIMITS.listPage)
            .map(artifactForPublic),
        });
        break;
      }
      case "artifactWorkspace": {
        const page = this.store.artifactWorkspace(
          conn.userId,
          this.visibleChannels(conn.userId),
          { before: frame.before, beforeId: frame.beforeId },
          frame.limit ?? ARTIFACT_LIMITS.workspaceDefault,
        );
        send(conn.ws, {
          type: "artifactWorkspace", artifacts: page.items, hasMore: page.hasMore,
          ...(frame.requestId !== undefined ? { requestId: frame.requestId } : {}),
          ...(page.nextBefore !== undefined ? { nextBefore: page.nextBefore } : {}),
          ...(page.nextBeforeId !== undefined ? { nextBeforeId: page.nextBeforeId } : {}),
        });
        break;
      }
      case "artifact": {
        send(conn.ws, this.artifactFrame(conn.userId, frame.artifactId, frame.requestId));
        break;
      }
      case "setArtifactAccess": {
        const artifact = this.artifactFor(conn.userId, frame.artifactId);
        const visible = this.channelFor(conn.userId, artifact.channelId);
        if (visible.kind === "dm") {
          throw new Error("files in a direct conversation always inherit that conversation's access");
        }
        const channel = this.adminChannel(conn.userId, artifact.channelId);
        const badAccess = validateArtifactAccessMutation(frame.access);
        if (badAccess) throw new Error(badAccess);
        const access = normaliseArtifactAccess(frame.access);
        if (access.kind === "restricted") {
          for (const userId of access.userIds) {
            if (!this.store.user(userId) || !channel.memberIds.includes(userId)) {
              throw new Error("file access can only include current people in this conversation");
            }
          }
        }

        const relatedArtifacts = this.store.artifactRelationNeighbors(artifact.id);
        const affectedArtifacts = [artifact.id, ...relatedArtifacts];
        const beforeArtifacts = this.snapshotArtifactProjections(affectedArtifacts);
        this.store.setArtifactAccess(artifact.id, access);
        // One direct success receipt for this socket. Other machines and related
        // caches travel through the no-request-id projection diff below.
        send(conn.ws, this.artifactFrame(conn.userId, artifact.id, frame.requestId));
        this.pushArtifactProjectionDiff(beforeArtifacts, affectedArtifacts, conn);
        break;
      }
      case "artifactTicket": {
        const artifact = this.artifactFor(conn.userId, frame.artifactId);
        // Absent version means the newest. A named version that retention has
        // removed is never swapped for a newer set of bytes.
        const wanted = frame.version === undefined
          ? latestVersion(artifact)
          : versionOf(artifact, frame.version);
        if (!wanted) {
          throw new Error(frame.version === undefined
            ? "no such file"
            : `version ${frame.version} of ${artifact.name} is no longer kept — ` +
              `the newest is version ${latestVersion(artifact)!.version}`);
        }
        const { ticket, expiresAt } = this.mintTicket(
          conn.userId, { kind: "artifact", id: wanted.id, artifactId: artifact.id });
        send(conn.ws, {
          type: "artifactTicket", artifactId: artifact.id, version: wanted.version,
          ticket, url: ATTACHMENT_TICKET.path + ticket, expiresAt,
          artifact: artifactForPublic(artifact),
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
      case "notifications": {
        send(conn.ws, {
          type: "notificationInbox",
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
          entries: this.notificationInboxFor(conn.userId, {
            includeDismissed: frame.includeDismissed,
            limit: frame.limit,
          }),
        });
        break;
      }
      case "markNotificationRead": {
        const row = this.store.setNotificationState(
          conn.userId, frame.notificationId, "read",
        );
        if (row) {
          this.toUser(conn.userId, {
            type: "notificationUpdated",
            entry: this.notificationProjection(conn.userId, row),
          });
        }
        break;
      }
      case "dismissNotification": {
        const row = this.store.setNotificationState(
          conn.userId, frame.notificationId, "dismissed",
        );
        if (row) {
          this.toUser(conn.userId, {
            type: "notificationUpdated",
            entry: this.notificationProjection(conn.userId, row),
          });
        }
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
      this.publishTask(task);
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
    // Capture the thread as it stood BEFORE this reply landed. That timing is
    // part of the recipient rule: a newly participating reply must not notify
    // every older message retroactively.
    const priorReplies = message.replyTo
      ? this.store.thread(message.replyTo).filter(m => m.id !== message.id)
      : [];
    this.store.saveMessage(message);
    this.recordMessageNotifications(ch, message, priorReplies);
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

  private publishTask(task: Task): void {
    if (!task.workflowRunId) {
      this.broadcast({ type: "task", task });
      return;
    }
    const channel = this.store.channel(task.channelId);
    const agents = this.store.agents();
    const audience = new Set<ID>();
    for (const memberId of channel?.memberIds ?? []) {
      const memberAgent = agents.find(agent => agent.id === memberId);
      audience.add(memberAgent?.ownerId ?? memberId);
    }
    const taskAgent = agents.find(agent => agent.id === task.agentId);
    if (taskAgent) audience.add(taskAgent.ownerId);
    for (const conn of this.conns) {
      if (audience.has(conn.userId)) send(conn.ws, { type: "task", task });
    }
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
    if (this.isWorkflowApproval(approval)) {
      const audience = this.workflowApprovalAudience(approval);
      for (const conn of this.conns) {
        if (audience.has(conn.userId)) send(conn.ws, { type: "approval", approval });
      }
      return;
    }
    if (approval.kind === "action") this.toUser(approval.ownerId, { type: "approval", approval });
    else this.broadcast({ type: "approval", approval });
  }

  // NOTHING KILLS A CARD ANY MORE (2026-08-07). There used to be a sweep here
  // that turned an unanswered card into `expired` after ten minutes, plus the
  // timers that fired it. Both are gone: his question waits for him. The word
  // `expired` still exists so cards swept before that date read back correctly
  // (@cloud9/shared, `ApprovalStatus`), but nothing produces a new one, and a
  // card only stops being pending because HE decided or he pressed Stop.

  /** Saved runbook approvals follow the task's room, plus the owner who decides. */
  private isWorkflowApproval(approval: Approval): boolean {
    const task = approval.taskId ? this.store.task(approval.taskId) : undefined;
    return Boolean(task?.workflowRunId);
  }

  private workflowApprovalAudience(approval: Approval): Set<ID> {
    const audience = new Set<ID>([approval.ownerId]);
    const channel = approval.channelId ? this.store.channel(approval.channelId) : undefined;
    const agents = this.store.agents();
    for (const memberId of channel?.memberIds ?? []) {
      const memberAgent = agents.find(agent => agent.id === memberId);
      audience.add(memberAgent?.ownerId ?? memberId);
    }
    return audience;
  }

  /** The approvals this person may be shown. */
  private visibleApprovals(userId: ID): Approval[] {
    return this.store.approvals().filter(a => this.isWorkflowApproval(a)
      ? this.workflowApprovalAudience(a).has(userId)
      : a.kind !== "action" || a.ownerId === userId);
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
  // MAY THIS JOB START WITHOUT HIM? Decided in one place (`mustAskBeforeActing`
  // → `decideAsking`, in shared) because the hub and the engine cannot see each
  // other's code, and reading `agent.approvals` here alone was exactly how a job
  // from a shell-capable agent could have run unattended without the owner ever
  // being asked.
  //
  // WHAT CHANGED ON 2026-08-05, and it is the whole of his complaint: that rule
  // now reads his per-agent trust setting. An agent he has marked "just get on
  // with it" starts its job here without a card — while everything on the
  // `REMOTE_ACTIONS` table still stops mid-run and asks, because that gate is a
  // different question asked in a different place and this line does not touch
  // it. The agent is read from THIS hub's store (`myAgent`), so the setting a
  // client claims about itself is never the one consulted.
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

/** A parsed JSON value is only a frame envelope when `type` is its own string field. */
function hasOwnStringType(value: unknown): value is Record<string, unknown> & { type: string } {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, "type")
    && typeof (value as Record<string, unknown>).type === "string";
}

/** Read correlation only from a validated own field; prototypes and primitives carry none. */
function safeFrameRequestId(value: unknown): ID | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || !Object.prototype.hasOwnProperty.call(value, "requestId")) return undefined;
  const requestId = (value as Record<string, unknown>).requestId;
  return typeof requestId === "string" && isSafeStoredId(requestId) ? requestId : undefined;
}

/**
 * One request-correlation rule for every direct refusal, including frames that
 * fail before authentication. No safely inspected field means no id is echoed.
 */
function sendFrameError(ws: WebSocket, error: string, frame?: unknown): void {
  const requestId = safeFrameRequestId(frame);
  send(ws, {
    type: "error", error,
    ...(requestId !== undefined ? { requestId } : {}),
  });
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
