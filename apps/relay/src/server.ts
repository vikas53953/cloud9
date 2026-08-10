// Cloud9 relay — the small always-on hub. All clients (desktop renderer,
// engine host, iPhone app) speak the same WS protocol defined in @cloud9/shared.
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  AgentDef, AgentPresenceState, AgentStatus, Approval, StoredHook, HOOK_ACTIONS,
  HOOK_EVENTS,
  ArtifactLink, ArtifactRelationView, Attachment,
  StoredArtifact, StoredArtifactVersion, artifactForPublic,
  Channel, ChannelMember,
  ChannelRole, ChannelSummary, ClientFrame, HarnessState, ID, Message,
  isChannelMemoryMode,
  MESSAGE_LIMITS, ARTIFACT_LIMITS, ATTACHMENT_LIMITS, ATTACHMENT_TICKET, Project, PROJECT_LIMITS,
  PublicUpdateDraft, PublicUpdateRevision, PublicUpdateAudit, PublicUpdateLink,
  validatePublicUpdateText, validatePublicUpdateLinks,
  ProjectPoll, ProjectPollView, POLL_LIMITS, validatePollQuestion, validatePollOptions,
  EngineeringCanvas, EngineeringCanvasView, EngineeringCanvasRevision, CanvasBlock, CanvasLink,
  CANVAS_LIMITS, validateCanvasTitle, validateCanvasBlock, validateCanvasLink,
  ActivityRecord,
  ReachCatchup,
  EngineeringPulseUpdate, EngineeringPulseDraft, EngineeringPulseProject,
  redactDeletedPulseUpdate, validateEngineeringPulseDraft,
  RepoChoice, REPO_LIST_LIMITS, validateRepoChoice, validateLocalFolder,
  RunRecord, RUN_RETENTION, APPROVAL_LIMITS,
  RunCheckpoint, RecoveryRequest, RecoveryReceipt, recoveryDecision,
  compareRecoveryRequest, compareRuns, recoveryRequestFingerprint,
  buildRunCheckpoint, sanitizeRecoveryAsk,
  // "show me the plan first" (2026-08-05) — the hub still writes the line the
  // owner reads and still bounds what the agent wrote
  planHeadline, tidyPlan, validatePlanAsk,
  SavingProposal, applySaving, findWaste, rollUpTokenUse, savingDetail, savingHeadline,
  tidySaving, validateSavingProposal,
  SearchHit, SavedMessageEntry, ChannelPinEntry, ServerFrame, Task, UnreadEntry, User, WorldState,
  MessageStatus,
  ChatDraft, DraftAttachment, DraftAttachmentState, DRAFT_LIMITS,
  HumanTyping,
  NotificationInboxEntry, NotificationInboxKind, notificationEventId,
  Workflow, WorkflowRun, WorkflowRunStep, WorkflowStepStatus,
  SocialLink, SocialPost, SOCIAL_LIMITS, validateSocialText,
  agentPresence, describeRemoteAction, detailRemoteAction, validateRemoteActionFacts,
  isReceiptStage, isReceiptVerdict,
  RUN_LIMITS, redactForSharing, validateLiveSteps,
  RESPONSE_STREAM_LIMITS, validateAgentResponseStream,
  type AgentResponseStreamEvent,
  contentDisposition, downloadContentType, fitRunRecord, isBranchName, isSafeFileName,
  isSafeStoredId, latestVersion, looksLikeText, normaliseArtifactAccess,
  normaliseArtifactLinks, validateArtifactAccessMutation, validateArtifactLinks,
  versionOf, validateArtifact,
  isRemoteAction, mayAdministerChannel, mayDriveAgent, mustAskBeforeActing, runListEntry,
  setMachineNames, shareableRun,
  extractMentions, nameKey, newId, validateAgentDefinition, validateAttachment, validateChannelText,
  validateMessageText, validateProjectItem, validateProjectText, validateReactionEmoji, validateHookInput,
  validateSocialLinks,
  validateName, validateRepo, validateRunRecord, validateTaskSummary, validateWorkflow,
  HuddleSession, HuddleNote, HuddleParticipant, HuddleLink, HuddleNoteKind, validateHuddleText, validateHuddleLinks,
  ForumTopic, ForumReply, ForumLink, ForumStatus,
  validateForumText, validateForumTags, validateForumLinks,
  WS_LIMITS,
} from "@cloud9/shared";
import os from "node:os";
// THE SAME VALIDATOR THE BUILDER USES, not a second copy — a handoff arriving
// over the wire is asked the same question `buildHandoff` asked, by the same
// rule (docs/plans/agent-memory-handoff.md §9.2). The relay already depends on
// `@cloud9/engine`, so there is one owner of "is this a real handoff".
import { HOOK_DEFAULTS, validateHandoff } from "@cloud9/engine";
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
import { secureId, secureToken } from "./secureid.js";
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

interface RecoveryChallenge {
  token: string;
  requesterId: ID;
  requestId: ID;
  payloadFingerprint: string;
  createdAt: number;
}

const RECOVERY_CHALLENGE_TTL_MS = 10 * 60_000;
const RECOVERY_CHALLENGE_LIMIT = 512;

interface LiveTyping extends HumanTyping {
  expiresAt: number;
  /** Last time this signal was broadcast, used to debounce noisy clients. */
  lastBroadcastAt: number;
  /** One account may type in the same room from more than one live window. */
  sources: Set<WebSocket>;
  timer?: ReturnType<typeof setTimeout>;
}

interface ActiveResponseStream {
  /** The engine socket that started this turn; a second host must not keep it alive. */
  source: WebSocket;
  ownerId: ID;
  channelId: ID;
  triggerMessageId: ID;
  agentId: ID;
  turnId: string;
  lastSeq: number;
  /** Sequence ids already projected; frames may arrive out of order. */
  seenSeq: Set<number>;
  totalChars: number;
  eventTimes: number[];
  timer?: ReturnType<typeof setTimeout>;
}

const responseStreamKey = (ownerId: ID, channelId: ID, triggerMessageId: ID, agentId: ID, turnId: string): string =>
  `${ownerId}\u0000${channelId}\u0000${triggerMessageId}\u0000${agentId}\u0000${turnId}`;
const responseStreamSlot = (ownerId: ID, channelId: ID, triggerMessageId: ID, agentId: ID): string =>
  `${ownerId}\u0000${channelId}\u0000${triggerMessageId}\u0000${agentId}`;

/** Human typing is deliberately short-lived and in-memory only. */
const HUMAN_TYPING_TTL_MS = 4_000;
const HUMAN_TYPING_DEBOUNCE_MS = 250;

/** Reminder dates are metadata only: no scheduler or notification exists in v1. */
const SAVED_REMINDER_HORIZON_MS = 5 * 365 * 24 * 60 * 60 * 1000;

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
  /** Recovery approvals cannot survive only in a Map: settle them durably on restart. */
  private restartSettledRecoveryApprovals: Approval[] = [];
  /** One persisted poll deadline is enough to wake the relay; the next one is rescheduled after each sweep. */
  private pollExpiryTimer?: ReturnType<typeof setTimeout>;
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
  /** Short-lived server-minted recovery capabilities; never durable or client-chosen. */
  private recoveryChallenges = new Map<string, RecoveryChallenge>();
  /** Recovery requests held by the existing approval desk until owner approval. */
  private pendingRecovery = new Map<string, RecoveryRequest>();
  /** Live human typing by account/channel. Never written to SQLite or history. */
  private liveTyping = new Map<string, LiveTyping>();
  /** Agent ids currently represented by each engine socket for huddle presence cleanup. */
  private huddleEngineAgents = new Map<WebSocket, Set<ID>>();
  /** Genuine response previews; process memory only and swept on inactivity. */
  private responseStreams = new Map<string, ActiveResponseStream>();
  private responseStreamSlots = new Map<string, string>();
  /**
   * Recently ended turn keys. A terminal/source-close frame must not free the
   * same public turn id for another engine socket to resurrect immediately.
   * These are process-local, bounded, and expire with the same lease as a live
   * preview; they are not history or durable response content.
   */
  private responseStreamTombstones = new Map<string, number>();
  private closing = false;

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
    this.restartSettledRecoveryApprovals = this.settleInterruptedRecoveryApprovals();
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
      // Cloud9-owned public read surface for published project updates.
      // No sign-in: the secret is the token in the path. Revoked/missing → gone.
      if (this.servePublicUpdate(req, res)) return;
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
    this.store.sweepChatDrafts(Date.now());
    // Poll deadlines survive a relay restart in SQLite. Schedule the earliest
    // one now so closure is pushed to every currently connected window rather
    // than waiting for somebody to request the poll list.
    this.scheduleProjectPollExpiry();
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
    this.closing = true;
    if (this.pollExpiryTimer) clearTimeout(this.pollExpiryTimer);
    this.pollExpiryTimer = undefined;
    for (const state of [...this.liveTyping.values()]) this.removeLiveTyping(state.channelId, state.userId, false);
    for (const t of this.looking.values()) clearTimeout(t);
    this.looking.clear();
    this.clearResponseStreams();
    for (const c of this.conns) c.ws.close();
    this.wss.close();
    this.server.close();
    this.store.close();
  }

  private onConnection(ws: WebSocket): void {
    let conn: Conn | undefined;
    ws.on("message", raw => {
      if (this.closing) return;
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
        const said = refusalText(err, `frame "${frame.type}"`);
        if (conn && ["createHook", "updateHook", "setHookEnabled", "deleteHook", "testHook"].includes(frame.type)) {
          const hookId = typeof (frame as unknown as { hookId?: unknown }).hookId === "string"
            ? (frame as unknown as { hookId: string }).hookId : "new";
          this.store.logHookAudit(conn.userId, hookId, `${frame.type}:refused`, false, said,
            Date.now(), conn.userId, conn.client, frame.requestId, hookId);
        }
        sendFrameError(ws, said, frame);
      }
    });
    ws.on("close", () => {
      if (this.closing) { if (conn) this.conns.delete(conn); return; }
      if (!conn) return;
      const closed = conn;
      this.conns.delete(conn);
      // A person may have the same room open on another desktop or mobile
      // client. Remove only this socket's signal; the shared row ends once its
      // final live source leaves.
      this.clearTypingForConnection(closed.ws);
      // A dropped socket is a leave, not a still-present participant. Persist
      // it and tell only the remaining authorized audience.
      const stillConnected = [...this.conns].some(c => c.userId === closed.userId && c.client === "desktop");
      for (const session of stillConnected ? [] : this.store.huddles()) {
        if (session.state !== "active" || !session.participants.some(p => p.id === closed.userId && p.present)) continue;
        const at = Date.now();
        const updated = { ...session, participants: session.participants.map(p => p.id === closed.userId && p.present ? { ...p, present: false, leftAt: at } : p) };
        this.store.huddleLeave(session.id, closed.userId, at); this.store.saveHuddle(updated);
        this.broadcastHuddle(updated, { type: "huddleChanged", session: updated });
      }
      const disconnectedAgents = this.huddleEngineAgents.get(closed.ws) ?? new Set<ID>();
      this.huddleEngineAgents.delete(closed.ws);
      for (const session of this.store.huddles()) {
        if (session.state !== "active" || !session.participants.some(p => disconnectedAgents.has(p.id) && p.present)) continue;
        const affected = [...disconnectedAgents].filter(agentId => ![...this.huddleEngineAgents.values()].some(ids => ids.has(agentId)));
        if (!affected.length) continue;
        const at = Date.now();
        const updated = { ...session, participants: session.participants.map(p => affected.includes(p.id) && p.present ? { ...p, present: false, leftAt: at } : p) };
        for (const agentId of affected) if (session.participants.some(p => p.id === agentId && p.present)) this.store.huddleLeave(session.id, agentId, at);
        this.store.saveHuddle(updated);
        this.broadcastHuddle(updated, { type: "huddleChanged", session: updated });
        const project = this.store.project(updated.projectId);
        if (project) this.toUser(project.ownerId, { type: "huddleChanged", session: this.huddleSessionView(project.ownerId, updated, project) });
      }
      // The engine host owns the CLIs. Once it's gone, its last status report is
      // a stale claim about a machine nobody is watching — drop it and say so.
      if (closed.client === "engine") {
        // Each preview is bound to the socket that started it. A second engine
        // for the same owner is a separate host, not permission to continue a
        // turn whose source process has disappeared.
        this.clearResponseStreams(stream => stream.source === closed.ws);
      }
      if (closed.client === "engine" && !this.hasEngine(closed.userId)) {
        delete this.harness[closed.userId];
        delete this.signInFlight[closed.userId];
        // THE SAME REASONING, APPLIED TO THE LAMP. The last idle/working/braked
        // an engine reported is a claim about a machine nobody is watching any
        // more, and keeping it meant an engine that died mid-turn left its agent
        // "working" for ever. Dropped, and everyone is told what is true now:
        // nobody can run these agents.
        for (const agent of this.store.agents()) {
          if (agent.ownerId === closed.userId) delete this.agentStatus[agent.id];
        }
        this.announcePresenceForOwner(closed.userId);
        this.toUser(closed.userId, {
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
    send(ws, { type: "welcome", state: this.worldFor(user.id, conn.client) });
    if (conn.userId === this.ownerId && this.restartExpiredWorkflowApprovals.length) {
      const expired = this.restartExpiredWorkflowApprovals;
      this.restartExpiredWorkflowApprovals = [];
      for (const approval of expired) this.sendApproval(approval);
    }
    if (conn.userId === this.ownerId && this.restartSettledRecoveryApprovals.length) {
      const settled = this.restartSettledRecoveryApprovals;
      this.restartSettledRecoveryApprovals = [];
      for (const approval of settled) this.sendApproval(approval);
    }
    if (conn.client === "engine") this.syncHooksToEngine(user.id);
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
    send(ws, { type: "welcome", state: this.worldFor(user.id, conn.client) });
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

  private worldFor(userId: ID, client: Conn["client"] = "desktop"): WorldState {
    const users = this.store.users();
    const channels = this.visibleChannels(userId);
    return {
      me: users.find(u => u.id === userId)!,
      users,
      agents: this.store.agents(),
      channels,
      channelMemoryPolicies: this.store.channelMemoryPoliciesFor(userId),
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
      pulse: {
        updates: this.pulseProjectIdsFor(userId).flatMap(projectId => this.store.pulses(projectId))
          .map(update => this.pulseProjection(userId, update)),
        unreadByProject: this.pulseUnreadFrame(userId),
        projects: this.pulseProjectsFor(userId),
      },
      // Swept FIRST, so nobody is ever handed a card that is already dead and
      // invited to click Approve on it.
      approvals: this.visibleApprovals(userId),
      notifications: this.notificationInboxFor(userId),
      savedMessages: this.savedMessageProjection(userId),
      // read state comes from the RELAY now, not from one browser's storage, so
      // reading on the laptop is read on the phone too
      unread: this.unreadFor(userId, channels),
      // Engines are not human windows/readers.  Keep the author delivery
      // projection out of their bootstrap state; desktop/mobile windows get
      // the author-only projection and subsequent status pushes.
      messageStatuses: client === "engine" ? [] : this.messageStatusesFor(userId),
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
  private myHook(userId: ID, hookId: ID): StoredHook {
    const hook = this.store.hook(userId, hookId);
    if (!hook) throw new Error("no such hook");
    return hook;
  }
  private assertHookClient(conn: Conn): void {
    if (conn.userId !== this.ownerId || conn.client !== "desktop") throw new Error("only the Cloud9 owner desktop can edit hooks");
  }
  private validateHookOwner(userId: ID, hook: StoredHook): void {
    const bad = validateHookInput(hook); if (bad) throw new Error(bad);
    if (hook.when?.agentId) this.myAgent(userId, hook.when.agentId);
    this.myAgent(userId, hook.action.agentId);
    if (hook.action.do === "say" || hook.action.do === "job") {
      if (!hook.action.channelId) throw new Error("choose a conversation for this hook action");
      this.channelFor(userId, hook.action.channelId);
    }
  }
  private validateHookPatch(value: unknown): asserts value is Partial<Pick<StoredHook, "name" | "event" | "when" | "action">> {
    if (!value || typeof value !== "object") throw new Error("a hook update is required");
    const allowed = new Set(["name", "event", "when", "action"]);
    if (Object.keys(value).some(key => !allowed.has(key))) throw new Error("that hook update contains an unsupported field");
  }
  private validateHookCreate(value: unknown): void {
    if (!value || typeof value !== "object") throw new Error("a hook rule is required");
    const allowed = new Set(["name", "event", "enabled", "when", "action"]);
    if (Object.keys(value).some(key => !allowed.has(key))) throw new Error("that hook contains an unsupported field");
  }
  private hookReceipt(conn: Conn, requestId: string | undefined, kind: string, target: string, payload: unknown) {
    if (!requestId) return undefined;
    const prior = this.store.hookRequest(conn.userId, requestId);
    if (!prior) return undefined;
    const encoded = JSON.stringify(payload);
    if (prior.kind !== kind || prior.target !== target || prior.payload !== encoded) throw new Error("that request id was already used for a different hook operation");
    return prior;
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

  /** Public-update mutate path: human desktop only. Agents may only draft. */
  private requirePublicHumanDesktop(conn: Conn, action: string): void {
    if (conn.client === "engine") {
      throw new Error(`only you can ${action} — an agent cannot`);
    }
    if (conn.client !== "desktop") {
      throw new Error(`only the desktop app can ${action}`);
    }
  }

  private forumProject(userId: ID, projectId: ID): Project {
    const project = this.store.project(projectId);
    if (!project || !this.store.forumIsMember(projectId, userId)) throw new Error("no such forum project");
    return project;
  }
  private forumProjectView(project: Project): Project {
    const { localPath, ...safe } = project;
    void localPath;
    return safe;
  }
  /**
   * Write-time link binding. Same class as social feed: when the project has no
   * room, task/run/artifact links are refused rather than skipping the check.
   */
  private validateForumLinks(userId: ID, project: Project, links: ForumLink[]): void {
    for (const link of links) {
      if (link.kind === "projectItem") {
        const item = this.store.projectItems(project.id).find(
          i => i.kind === link.projectItemKind && i.number === link.projectItemNumber,
        );
        if (!item) throw new Error("that project item is unavailable");
        continue;
      }
      if (!project.channelId) {
        throw new Error("this project has no room, so that kind of link cannot be attached");
      }
      if (link.kind === "task") {
        const task = this.store.task(link.id!);
        if (!task) throw new Error("that task is unavailable");
        try { this.channelFor(userId, task.channelId); } catch { throw new Error("that task is unavailable"); }
        if (task.channelId !== project.channelId) throw new Error("that task is outside this project");
      } else if (link.kind === "run") {
        const run = this.store.run(link.id!);
        if (!run) throw new Error("that run is unavailable");
        if (!run.channelId) throw new Error("that run is outside this project");
        try { this.channelFor(userId, run.channelId); } catch { throw new Error("that run is unavailable"); }
        if (run.channelId !== project.channelId) throw new Error("that run is outside this project");
      } else if (link.kind === "artifact") {
        const artifact = this.artifactFor(userId, link.artifactId ?? link.id!);
        if (artifact.channelId !== project.channelId) throw new Error("that file is outside this project");
      }
    }
  }
  private forumTopicView(userId: ID, topic: ForumTopic): ForumTopic {
    const project = this.store.project(topic.projectId);
    if (!project) return { ...topic, links: [] };
    return {
      ...topic,
      links: (topic.links ?? []).filter(l => {
        try { this.validateForumLinks(userId, project, [l]); return true; } catch { return false; }
      }),
    };
  }
  private forumReplyView(userId: ID, reply: ForumReply): ForumReply {
    const topic = this.store.forumTopic(reply.topicId);
    const project = topic ? this.store.project(topic.projectId) : undefined;
    if (!project) return { ...reply, links: [] };
    return {
      ...reply,
      links: (reply.links ?? []).filter(l => {
        try { this.validateForumLinks(userId, project, [l]); return true; } catch { return false; }
      }),
    };
  }
  private forumSnapshot(conn: Conn, topic: ForumTopic, requestId?: ID): void {
    this.forumProject(conn.userId, topic.projectId);
    send(conn.ws, {
      type: "forumTopic",
      topic: this.forumTopicView(conn.userId, topic),
      replies: this.store.forumReplies(topic.id).map(r => this.forumReplyView(conn.userId, r)),
      unread: this.store.forumUnread(conn.userId, topic.projectId),
      ...(requestId ? { requestId } : {}),
    });
  }
  private forumPayloadHash(frame: ClientFrame): string {
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === "object") {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([key]) => key !== "requestId")
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        );
      }
      return value;
    };
    return createHash("sha256").update(JSON.stringify(canonical(frame))).digest("hex");
  }
  private forumReceipt(
    conn: Conn,
    frame: ClientFrame,
    receipt: { projectId: ID; targetId: ID; kind: string; resultId: ID },
  ): {
    userId: ID; requestId?: ID; projectId: ID; targetId: ID;
    kind: string; resultId: ID; payloadHash?: string;
  } | undefined {
    return frame.requestId
      ? { userId: conn.userId, requestId: frame.requestId, ...receipt, payloadHash: this.forumPayloadHash(frame) }
      : undefined;
  }
  /**
   * Replay is not an authorization token. Every path re-checks current forum
   * membership first, then the operation's owner/author gate. A removed member
   * cannot re-read a decision thread by replaying a prior requestId.
   */
  private forumReplay(
    conn: Conn, requestId: ID | undefined, kind: string,
    projectId: ID, targetId: ID, payloadHash: string,
  ): boolean {
    if (!requestId) return false;
    const info = this.store.forumRequestInfo(conn.userId, requestId);
    if (!info) return false;
    if (
      info.projectId !== projectId || info.kind !== kind || info.targetId !== targetId
      || !info.payloadHash || info.payloadHash !== payloadHash
    ) {
      throw new Error("that request id was already used for another forum operation");
    }
    // Membership first — fail closed for every kind, including edit/delete/status/accept.
    if (!this.store.forumIsMember(projectId, conn.userId)) {
      throw new Error("no such forum project");
    }
    const project = this.store.project(projectId);
    if (!project) throw new Error("no such forum project");
    if (["edit-topic", "delete-topic", "status", "accept"].includes(info.kind)) {
      const topic = this.store.forumTopic(info.resultId);
      if (!topic) throw new Error("no such forum topic");
      if (
        ["edit-topic", "delete-topic"].includes(info.kind)
        && topic.authorId !== conn.userId && project.ownerId !== conn.userId
      ) {
        throw new Error("only the author or project owner can edit this");
      }
      if (["status", "accept"].includes(info.kind) && project.ownerId !== conn.userId) {
        throw new Error("only the project owner can change this forum decision");
      }
    } else if (["edit-reply", "delete-reply"].includes(info.kind)) {
      const reply = this.store.forumReply(info.resultId);
      if (!reply) throw new Error("no such forum reply");
      if (reply.authorId !== conn.userId && project.ownerId !== conn.userId) {
        throw new Error("only the author or project owner can edit this");
      }
    } else if (["add-member", "remove-member"].includes(info.kind) && project.ownerId !== conn.userId) {
      throw new Error("only the project owner can manage forum members");
    } else if (info.kind === "list-members") {
      // Any current member may re-list; owner-only gate does not apply.
    } else if (info.kind === "members" && project.ownerId !== conn.userId) {
      // Legacy receipts stamped before list/manage split — treat as manage.
      throw new Error("only the project owner can manage forum members");
    }
    if (info.kind === "topic" || info.kind === "reply") {
      const topic = info.kind === "topic"
        ? this.store.forumTopic(info.resultId)
        : (() => {
          const reply = this.store.forumReply(info.resultId);
          return reply ? this.store.forumTopic(reply.topicId) : undefined;
        })();
      if (topic) this.forumSnapshot(conn, topic, requestId);
    } else if (["edit-topic", "delete-topic", "status", "accept"].includes(info.kind)) {
      const topic = this.store.forumTopic(info.resultId);
      if (topic) {
        send(conn.ws, {
          type: "forumChanged", projectId: topic.projectId,
          topic: this.forumTopicView(conn.userId, topic), requestId,
        });
      }
    } else if (["edit-reply", "delete-reply"].includes(info.kind)) {
      const reply = this.store.forumReply(info.resultId);
      const topic = reply && this.store.forumTopic(reply.topicId);
      if (reply && topic) {
        send(conn.ws, {
          type: "forumChanged", projectId: topic.projectId,
          reply: this.forumReplyView(conn.userId, reply), requestId,
        });
      }
    } else if (info.kind === "read") {
      const p = this.forumProject(conn.userId, info.resultId);
      send(conn.ws, {
        type: "forumRead",
        entry: {
          projectId: p.id,
          lastReadAt: this.store.forumRead(conn.userId, p.id),
          unread: this.store.forumUnread(conn.userId, p.id),
        },
        requestId,
      });
    } else if (["list-members", "add-member", "remove-member", "members"].includes(info.kind)) {
      const p = this.forumProject(conn.userId, info.resultId);
      send(conn.ws, {
        type: "forumMembers", projectId: p.id,
        userIds: this.store.forumMembers(p.id), requestId,
      });
    }
    return true;
  }

  private validForumStatus(value: unknown): value is ForumStatus {
    return value === "open" || value === "resolved" || value === "archived";
  }
  private broadcastForum(projectId: ID, frame: ServerFrame): void {
    for (const member of this.store.forumMembers(projectId)) {
      const view = frame.type === "forumChanged"
        ? {
          ...frame,
          ...(frame.topic ? { topic: this.forumTopicView(member, frame.topic) } : {}),
          ...(frame.reply ? { reply: this.forumReplyView(member, frame.reply) } : {}),
        }
        : frame;
      this.toUser(member, view);
    }
  }

  private publicDraft(userId: ID, draftId: ID): { draft: PublicUpdateDraft; project: Project } {
    const d = this.store.publicDraft(draftId);
    const p = d ? this.store.project(d.projectId) : undefined;
    if (!d || !p || p.ownerId !== userId) throw new Error("no such public update");
    return { draft: d, project: p };
  }

  private publicLinks(userId: ID, project: Project, links: PublicUpdateLink[]): void {
    for (const l of links) {
      if (l.kind === "changelog") {
        if (!/^https:\/\/(github\.com|gitlab\.com|bitbucket\.org)\//.test(l.url ?? "")) {
          throw new Error("changelog link must be a trusted repository address");
        }
      } else if (l.kind === "task") {
        const t = this.store.task(l.id!);
        if (!t) throw new Error("that task is unavailable");
        this.channelFor(userId, t.channelId);
      } else if (l.kind === "run") {
        const r = this.store.run(l.id!);
        if (!r) throw new Error("that run is unavailable");
        if (r.channelId) this.channelFor(userId, r.channelId);
      } else if (l.kind === "artifact") {
        this.artifactFor(userId, l.artifactId ?? l.id!);
      } else if (!this.store.projectItems(project.id).some(i => i.number === Number(l.id))) {
        throw new Error("that project item is unavailable");
      }
    }
  }

  /** Unauthenticated HTTP read for a published update. Returns true if handled. */
  private servePublicUpdate(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const raw = req.url ?? "";
    const pathOnly = raw.split("?")[0] ?? "";
    const m = pathOnly.match(/^\/public\/update\/([^/]+)$/);
    if (!m) return false;
    if (req.method && req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
      res.end("only GET");
      return true;
    }
    let token = m[1];
    try { token = decodeURIComponent(token); } catch { /* keep raw */ }
    const revision = this.store.publicByToken(token);
    if (!revision) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end("that public update is unavailable");
      return true;
    }
    const body = JSON.stringify({
      title: revision.title,
      summary: revision.summary,
      body: revision.body,
      changelogLinks: revision.changelogLinks,
      revision: revision.revision,
      publishedAt: revision.publishedAt,
    });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    if (req.method === "HEAD") res.end();
    else res.end(body);
    return true;
  }

  private huddleFor(userId: ID, sessionId: ID): { session: HuddleSession; project: Project } {
    const session = this.store.huddle(sessionId);
    const project = session ? this.store.project(session.projectId) : undefined;
    if (!session || !project) throw new Error("no such huddle");
    if (project.ownerId !== userId && (!project.channelId || !this.store.channelMembers(project.channelId).some(m => m.memberId === userId))) throw new Error("no such huddle");
    if (session.channelId && project.channelId !== session.channelId) throw new Error("no such huddle");
    return { session, project };
  }
  private huddleProject(userId: ID, projectId: ID): Project {
    const p = this.store.project(projectId);
    if (!p) throw new Error("no such project");
    if (p.ownerId !== userId && (!p.channelId || !this.visibleChannels(userId).some(c => c.id === p.channelId))) throw new Error("no such project");
    return p;
  }
  private huddleLinks(userId: ID, project: Project, links: HuddleLink[]): void {
    for (const l of links) {
      if (l.kind === "task") {
        const t = this.store.task(l.id!); if (!t) throw new Error("that task is unavailable");
        this.channelFor(userId, t.channelId); if (project.channelId && t.channelId !== project.channelId) throw new Error("that task is outside this project");
      } else if (l.kind === "run") {
        const r = this.store.run(l.id!); if (!r) throw new Error("that run is unavailable");
        if (r.channelId) this.channelFor(userId, r.channelId); else if (r.ownerId !== userId) throw new Error("that run is unavailable");
        if (project.channelId && r.channelId && r.channelId !== project.channelId) throw new Error("that run is outside this project");
      } else if (l.kind === "artifact") {
        const a = this.artifactFor(userId, l.artifactId ?? l.id!); if (project.channelId && a.channelId !== project.channelId) throw new Error("that file is outside this project");
      } else if (!this.store.projectItems(project.id).some(i => i.kind === l.projectItemKind && i.number === l.projectItemNumber)) throw new Error("that project item is unavailable");
    }
  }
  private huddleLinkView(userId: ID, project: Project, links: HuddleLink[]): HuddleLink[] {
    return links.map(link => {
      try { this.huddleLinks(userId, project, [link]); return { ...link, available: true }; }
      catch { return { kind: link.kind, label: link.label ?? "Unavailable", available: false }; }
    });
  }
  private huddleSessionView(userId: ID, session: HuddleSession, project: Project): HuddleSession {
    return { ...session, participants: [...session.participants].sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id)), unread: this.store.huddleUnread(userId, session.id) };
  }
  private huddleNoteView(userId: ID, project: Project, note: HuddleNote): HuddleNote {
    return { ...note, links: this.huddleLinkView(userId, project, note.links ?? []) };
  }
  private huddlePayloadHash(frame: ClientFrame): string {
    const clean = (value: unknown): unknown => Array.isArray(value) ? value.map(clean) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([key]) => key !== "requestId").sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, clean(v)])) : value;
    return createHash("sha256").update(JSON.stringify(clean(frame))).digest("hex");
  }
  private huddleReceipt(conn: Conn, frame: ClientFrame, kind: string, targetId: ID, resultId: ID): { userId: ID; requestId: ID; kind: string; targetId: ID; payloadHash: string; resultId: ID } | undefined {
    return frame.requestId ? { userId: conn.userId, requestId: frame.requestId, kind, targetId, payloadHash: this.huddlePayloadHash(frame), resultId } : undefined;
  }
  private huddleReplay(conn: Conn, frame: ClientFrame, kind: string, targetId: ID): boolean {
    if (!frame.requestId) return false;
    const info = this.store.huddleRequestInfo(conn.userId, frame.requestId);
    if (!info) return false;
    if (info.kind !== kind || info.targetId !== targetId || info.payloadHash !== this.huddlePayloadHash(frame)) throw new Error("that huddle request id was already used for different work");
    if (kind === "read") {
      send(conn.ws, { type: "huddleRead", entry: { sessionId: targetId, lastReadAt: this.store.huddleRead(conn.userId, targetId), unread: this.store.huddleUnread(conn.userId, targetId) }, requestId: frame.requestId });
      return true;
    }
    const note = this.store.huddleNote(info.resultId);
    const session = note ? this.store.huddle(note.sessionId) : this.store.huddle(info.resultId);
    if (session) {
      const project = this.store.project(session.projectId);
      if (project) {
        if (kind === "members") {
          send(conn.ws, { type: "huddleMembers", sessionId: session.id, participants: session.participants, requestId: frame.requestId });
          return true;
        }
        const changed = note ? { type: "huddleChanged" as const, session: this.huddleSessionView(conn.userId, session, project), note: this.huddleNoteView(conn.userId, project, note), requestId: frame.requestId } : { type: "huddleSession" as const, session: this.huddleSessionView(conn.userId, session, project), notes: this.store.huddleNotes(session.id).map(n => this.huddleNoteView(conn.userId, project, n)), requestId: frame.requestId };
        send(conn.ws, changed);
      }
    }
    return true;
  }
  private broadcastHuddle(session: HuddleSession, frame: ServerFrame, includeProjectMembers = false, origin?: Conn): void {
    const ended = frame.type === "huddleChanged" && frame.session.state === "ended";
    const ids = new Set(session.participants.filter(p => p.present || ended).map(p => p.id));
    if (origin) ids.add(origin.userId);
    const project = this.store.project(session.projectId);
    if (!project) return;
    if (includeProjectMembers) {
      ids.add(project.ownerId);
      if (project.channelId) for (const member of this.store.channelMembers(project.channelId)) ids.add(member.memberId);
    }
    for (const id of ids) {
      const agent = this.store.agents().find(a => a.id === id);
      const allowed = id === project.ownerId || (project.channelId && this.store.channelMembers(project.channelId).some(m => m.memberId === id)) || agent?.ownerId === project.ownerId;
      if (!allowed) continue;
      const viewSession = this.huddleSessionView(id, frame.type === "huddleChanged" ? frame.session : session, project);
      const view = frame.type === "huddleChanged" ? { ...frame, session: viewSession, ...(frame.note ? { note: this.huddleNoteView(id, project, frame.note) } : {}) } : frame;
      if (origin && id === origin.userId) {
        send(origin.ws, view);
        const mirror = "requestId" in view ? (() => { const { requestId: _requestId, ...rest } = view; void _requestId; return rest as ServerFrame; })() : view;
        for (const c of this.conns) if (c.userId === id && c !== origin) send(c.ws, mirror);
      } else if (origin && "requestId" in view) { const { requestId: _requestId, ...mirror } = view; void _requestId; this.toUser(id, mirror as ServerFrame); }
      else this.toUser(id, view);
    }
  }
  /** Who could have held notes for this project/session (owner, channel members, participants). */
  private huddleAudience(project: Project, sessions: HuddleSession[] = []): Set<ID> {
    const ids = new Set<ID>([project.ownerId]);
    if (project.channelId) for (const member of this.store.channelMembers(project.channelId)) ids.add(member.memberId);
    for (const session of sessions) {
      for (const p of session.participants) {
        const agent = this.store.agents().find(a => a.id === p.id);
        ids.add(agent ? agent.ownerId : p.id);
      }
    }
    return ids;
  }
  /** Access revoked for a person in a room: drop every project huddle they could have opened there. */
  private invalidateHuddlesForMember(userId: ID, channelId: ID): void {
    for (const session of this.store.huddles()) {
      const project = this.store.project(session.projectId);
      // Project owners keep access without channel membership (huddleFor).
      if (!project || project.channelId !== channelId || project.ownerId === userId) continue;
      if (session.state === "active" && session.participants.some(p => p.id === userId && p.present)) {
        const at = Date.now();
        const updated = { ...session, participants: session.participants.map(p => p.id === userId && p.present ? { ...p, present: false, leftAt: at } : p) };
        this.store.huddleLeave(session.id, userId, at);
        this.store.saveHuddle(updated);
        this.broadcastHuddle(updated, { type: "huddleChanged", session: updated });
      }
      this.toUser(userId, { type: "huddleUnavailable", sessionId: session.id, problem: "This huddle is no longer available to you." });
    }
  }

  /** Project feed visibility is membership, not repository ownership. */
  private socialProject(userId: ID, projectId: ID): Project {
    const project = this.store.project(projectId);
    if (!project || !this.store.socialIsMember(project.id, userId, project.ownerId)) {
      throw new Error("no such project");
    }
    return project;
  }

  /** A feed member can know the repository label, never the owner's disk path. */
  private socialProjectView(project: Project): Project {
    const { localPath: _localPath, ...safe } = project;
    void _localPath;
    return safe;
  }

  private socialLinks(userId: ID, project: Project, links: SocialLink[] | undefined): SocialLink[] | undefined {
    const bad = validateSocialLinks(links);
    if (bad) throw new Error(bad);
    if (!links?.length) return undefined;
    const checked: SocialLink[] = [];
    for (const link of links) {
      if (link.kind === "projectItem") {
        if (link.projectId && link.projectId !== project.id) throw new Error("that work item is not in this project");
        const item = this.store.projectItems(project.id).find(i =>
          i.kind === link.itemKind && i.number === link.number);
        if (!item) throw new Error("that work item is not available in this project");
        checked.push({ ...link, projectId: project.id, available: true });
        continue;
      }
      // Task/run/artifact links bind through the project's room. A project with
      // no room has no hard project binding for those records — refusing here
      // (instead of skipping the check) keeps private-room work out of a feed.
      if (!project.channelId) {
        throw new Error("this project has no room, so that kind of link cannot be attached");
      }
      if (link.kind === "task") {
        const task = this.store.task(link.id);
        if (!task) throw new Error("that task is not available");
        this.channelFor(userId, task.channelId);
        if (task.channelId !== project.channelId) {
          throw new Error("that task is outside this project");
        }
        checked.push({ ...link, channelId: task.channelId, available: true });
        continue;
      } else if (link.kind === "run") {
        const run = this.store.run(link.id);
        if (!run) throw new Error("that run is not available");
        if (!run.channelId) throw new Error("that run is outside this project");
        this.channelFor(userId, run.channelId);
        if (run.channelId !== project.channelId) {
          throw new Error("that run is outside this project");
        }
        checked.push({ ...link, channelId: run.channelId, available: true });
        continue;
      } else {
        const artifact = this.artifactFor(userId, link.id);
        if (artifact.channelId !== project.channelId) {
          throw new Error("that artifact is outside this project");
        }
        checked.push({ ...link, channelId: artifact.channelId, available: true });
        continue;
      }
    }
    return checked;
  }

  /** Project posts are durable, but each reader gets only links they may open. */
  private socialPostView(userId: ID, project: Project, post: SocialPost): SocialPost {
    const links = post.links?.flatMap(link => {
      try { return this.socialLinks(userId, project, [link]) ?? []; } catch {
        // Keep a non-clickable placeholder so a reader can tell a link was
        // deliberately redacted without learning its identifier.
        return [{ kind: link.kind, id: "unavailable", available: false } as SocialLink];
      }
    });
    return {
      ...post,
      ...(links?.length ? { links } : { links: undefined }),
    };
  }

  private broadcastSocial(projectId: ID, frame: ServerFrame): void {
    const project = this.store.project(projectId);
    if (!project) return;
    for (const conn of this.conns) {
      if (this.store.socialIsMember(projectId, conn.userId, project.ownerId)) send(conn.ws, frame);
    }
  }

  private broadcastSocialView(projectId: ID, makeFrame: (userId: ID) => ServerFrame): void {
    const project = this.store.project(projectId);
    if (!project) return;
    for (const conn of this.conns) {
      if (this.store.socialIsMember(projectId, conn.userId, project.ownerId)) {
        send(conn.ws, makeFrame(conn.userId));
      }
    }
  }

  private broadcastSocialUnread(projectId: ID): void {
    const project = this.store.project(projectId);
    if (!project) return;
    for (const conn of this.conns) {
      if (this.store.socialIsMember(projectId, conn.userId, project.ownerId)) {
        send(conn.ws, { type: "socialUnread", projectId, unread: this.store.socialUnread(conn.userId, projectId).unread });
      }
    }
  }

  private socialPayloadHash(frame: ClientFrame): string {
    const stable = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(stable);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "requestId")
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, stable(item)]));
    };
    return createHash("sha256").update(JSON.stringify(stable(frame))).digest("hex");
  }

  private priorSocialOperation<T extends ServerFrame>(conn: Conn, kind: string, requestId?: ID, payloadHash?: string, projectId?: ID): T | undefined {
    if (!requestId) return undefined;
    const prior = this.store.socialOperation(conn.userId, requestId, kind);
    if (!prior) return undefined;
    if (projectId && prior.projectId && prior.projectId !== projectId) {
      throw new Error("that request id belongs to another project");
    }
    if (payloadHash && prior.payloadHash !== payloadHash) {
      throw new Error("that request id was already used for different work");
    }
    return prior.result as T;
  }

  private rememberSocialOperation(conn: Conn, kind: string, requestId: ID | undefined, frame: ServerFrame, payloadHash = ""): void {
    if (!requestId) return;
    const projectId = frame.type === "socialPost" || frame.type === "socialUpdated"
      ? frame.post.projectId
      : frame.type === "socialReaction" || frame.type === "socialUnread"
        ? frame.projectId
        : frame.type === "socialRead" ? frame.entry.projectId
          : frame.type === "socialMembers" ? frame.projectId : undefined;
    this.store.saveSocialOperation(conn.userId, requestId, kind, frame, payloadHash, projectId);
  }

  /**
   * One refusal for a missing post and for a post the caller may not see.
   * Same class as `artifactFor` / `myProject`: an id must not be probeable
   * across a membership boundary ("no such project" would confirm the post).
   */
  private socialPostFor(userId: ID, postId: ID): { project: Project; post: SocialPost } {
    const post = this.store.socialPost(postId);
    if (!post) throw new Error("no such post");
    try {
      const project = this.socialProject(userId, post.projectId);
      return { project, post };
    } catch {
      throw new Error("no such post");
    }
  }

  /** A Pulse project may be read by its owner or a member of its linked room. */
  private pulseProject(userId: ID, projectId: ID): Project {
    const project = this.store.project(projectId);
    if (!project) throw new Error("no such project");
    if (project.ownerId === userId) return project;
    if (project.channelId && this.visibleChannels(userId).some(c => c.id === project.channelId)) {
      return project;
    }
    // Do not reveal whether an unshared project exists to an outsider.
    throw new Error("no such project");
  }

  /** Resolve an update and its project without letting an outsider probe ids. */
  private pulseUpdateFor(userId: ID, updateId: ID): { update: EngineeringPulseUpdate; project: Project } {
    const update = this.store.pulse(updateId);
    if (!update) throw new Error("no such update");
    try {
      return { update, project: this.pulseProject(userId, update.projectId) };
    } catch {
      // An existing id in somebody else's project is indistinguishable from a
      // made-up id. Keep this sentence identical for edit and delete probes.
      throw new Error("no such update");
    }
  }

  private pulseProjectIdsFor(userId: ID): ID[] {
    return this.store.projects().filter(project => {
      if (project.ownerId === userId) return true;
      return !!project.channelId && this.visibleChannels(userId).some(c => c.id === project.channelId);
    }).map(project => project.id);
  }

  private pulseProjectsFor(userId: ID): EngineeringPulseProject[] {
    return this.store.projects().filter(project => this.pulseProjectIdsFor(userId).includes(project.id))
      .map(project => ({ id: project.id, name: project.name, ...(project.description ? { description: project.description } : {}) }));
  }

  private pulseAudience(project: Project): Set<ID> {
    const audience = new Set<ID>([project.ownerId]);
    if (project.channelId) {
      const channel = this.store.channel(project.channelId);
      if (channel) for (const userId of this.audienceFor(channel)) audience.add(userId);
    }
    return audience;
  }

  /** Remove related identifiers the reader can no longer open; purge deleted bodies. */
  private pulseProjection(userId: ID, update: EngineeringPulseUpdate): EngineeringPulseUpdate {
    // Soft-delete is content moderation: list, welcome, and replay must never
    // re-ship the deleted section text (storage also purges; this is the wire).
    const redacted = redactDeletedPulseUpdate(update);
    if (redacted.deletedAt) return redacted;
    const project = this.store.project(redacted.projectId);
    const task = redacted.relatedTaskId ? this.store.task(redacted.relatedTaskId) : undefined;
    const run = redacted.relatedRunId ? this.store.run(redacted.relatedRunId) : undefined;
    const canTask = !!task && this.canSeeTask(userId, task)
      && (!project?.channelId || task.channelId === project.channelId);
    const canRun = !!run && this.canSeeRun(userId, run)
      && (!project?.channelId || run.channelId === project.channelId);
    const canItem = !!project && !!redacted.relatedProjectItem
      && this.store.projectItems(project.id).some(item =>
        item.kind === redacted.relatedProjectItem!.kind && item.number === redacted.relatedProjectItem!.number);
    const { relatedTaskId, relatedRunId, relatedProjectItem, ...base } = redacted;
    return {
      ...base,
      ...(canTask ? { relatedTaskId } : {}),
      ...(canRun ? { relatedRunId } : {}),
      ...(canItem ? { relatedProjectItem } : {}),
    };
  }

  private pulseAuthor(conn: Conn, agentId?: ID): { id: ID; kind: "human" | "agent"; name: string; agent?: AgentDef } {
    if (agentId) {
      if (conn.client !== "engine") throw new Error("only your agent engine can post as an agent");
      const agent = this.myAgent(conn.userId, agentId);
      return { id: agent.id, kind: "agent", name: agent.name, agent };
    }
    if (conn.client === "engine") throw new Error("an engine must name the agent posting this update");
    const user = this.store.user(conn.userId);
    if (!user) throw new Error("no such person");
    return { id: user.id, kind: "human", name: user.name };
  }

  /** Related links are references, not free-form labels: prove they exist and are readable. */
  private validatePulseLinks(userId: ID, project: Project, draft: EngineeringPulseDraft): void {
    // null means "clear this link" and needs no existence check.
    if (draft.relatedTaskId) {
      const task = this.store.task(draft.relatedTaskId);
      if (!task || !this.canSeeTask(userId, task)) throw new Error("that related task is not available");
      if (project.channelId && task.channelId !== project.channelId) {
        throw new Error("that related task is in a different project room");
      }
    }
    if (draft.relatedRunId) {
      const run = this.store.run(draft.relatedRunId);
      if (!run || !this.canSeeRun(userId, run)) throw new Error("that related run is not available");
      if (project.channelId && run.channelId !== project.channelId) {
        throw new Error("that related run is in a different project room");
      }
    }
    if (draft.relatedProjectItem) {
      const item = this.store.projectItems(project.id).find(i =>
        i.kind === draft.relatedProjectItem!.kind && i.number === draft.relatedProjectItem!.number);
      if (!item) throw new Error("that pull request or issue is not in this project");
    }
  }

  /** Task links use the same owner-or-room rule as the task tray. */
  private canSeeTask(userId: ID, task: Task): boolean {
    if (task.requesterId === userId) return true;
    const agent = this.store.agents().find(candidate => candidate.id === task.agentId);
    if (agent?.ownerId === userId) return true;
    try { this.channelFor(userId, task.channelId); return true; } catch { return false; }
  }

  private sendPulseToAudience(project: Project, frame: ServerFrame): void {
    const audience = this.pulseAudience(project);
    for (const conn of this.conns) if (audience.has(conn.userId)) send(conn.ws, frame);
  }

  private sendPulseChanged(projectId: ID, update: EngineeringPulseUpdate,
    origin?: Conn, requestId?: ID): void {
    const project = this.store.project(projectId);
    if (!project) return;
    const audience = this.pulseAudience(project);
    for (const recipient of this.conns) {
      if (!audience.has(recipient.userId)) continue;
      send(recipient.ws, {
        type: "pulseChanged", update: this.pulseProjection(recipient.userId, update),
        unreadByProject: this.pulseUnreadFrame(recipient.userId),
        projects: this.pulseProjectsFor(recipient.userId),
        ...(recipient === origin && requestId ? { requestId } : {}),
      });
    }
  }

  /** Re-send the complete authorized Pulse snapshot after an access change or read. */
  private sendPulseSnapshot(userId: ID, origin?: Conn, requestId?: ID, projectId?: ID): void {
    const projectIds = projectId ? [this.pulseProject(userId, projectId).id] : this.pulseProjectIdsFor(userId);
    const base = {
      type: "pulse" as const,
      ...(projectId ? { projectId } : {}),
        updates: projectIds.flatMap(id => this.store.pulses(id))
          .map(update => this.pulseProjection(userId, update)),
      unreadByProject: this.pulseUnreadFrame(userId), projects: this.pulseProjectsFor(userId),
    };
    for (const recipient of this.conns) {
      if (recipient.userId !== userId) continue;
      send(recipient.ws, {
        ...base,
        ...(recipient === origin && requestId ? { requestId } : {}),
      });
    }
  }

  private sendPulseSnapshotTo(users: Iterable<ID>): void {
    for (const userId of new Set(users)) this.sendPulseSnapshot(userId);
  }

  private pulseUnreadFrame(userId: ID): Record<ID, number> {
    return this.store.pulseUnreadByProject(userId, this.pulseProjectIdsFor(userId));
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

  /**
   * Project membership for polls and member-facing project lists.
   * Owner always; channel members when the project is linked to a room they can see.
   */
  private projectForMember(userId: ID, projectId: ID): Project {
    const project = this.store.project(projectId);
    if (!project) throw new Error("no such project");
    if (project.ownerId === userId) return project;
    if (project.channelId) { this.channelFor(userId, project.channelId); return project; }
    throw new Error("no such project");
  }

  private projectsForMember(userId: ID): Project[] {
    return this.store.projectsAll().filter(project => {
      if (project.ownerId === userId) return true;
      if (!project.channelId) return false;
      try { this.channelFor(userId, project.channelId); return true; } catch { return false; }
    });
  }

  private pollView(userId: ID, poll: ProjectPoll): ProjectPollView {
    const results = this.store.pollResults(poll.id, poll.options);
    return {
      ...poll,
      totalVotes: results.reduce((n, v) => n + v.votes, 0),
      results,
      ...(this.store.pollVote(poll.id, userId) ? { myOptionId: this.store.pollVote(poll.id, userId) } : {}),
      canClose: this.store.project(poll.projectId)?.ownerId === userId,
    };
  }

  private pollAudience(project: Project): Set<ID> {
    const out = new Set<ID>([project.ownerId]);
    if (project.channelId) {
      const channel = this.store.channel(project.channelId);
      if (channel) for (const id of this.audienceFor(channel)) out.add(id);
    }
    return out;
  }

  /** Every window that could currently see a shared project projection. */
  private projectAudience(project: Project): Set<ID> {
    return this.pollAudience(project);
  }

  private pushPoll(poll: ProjectPoll, requestId?: ID, requesterId?: ID): void {
    const project = this.store.project(poll.projectId);
    if (!project) return;
    for (const userId of this.projectAudience(project)) {
      this.toUser(userId, {
        type: "poll", poll: this.pollView(userId, poll),
        ...(requestId && requesterId === userId ? { requestId } : {}),
      });
    }
  }

  /** Close due polls and publish the changed projection to every project member. */
  private sweepExpiredProjectPolls(now = Date.now()): void {
    for (const poll of this.store.expireProjectPolls(now)) {
      // No private repo string — activity is hub-wide and membership-scoped below.
      this.store.logActivity({
        actorKind: "system", actorId: "system", actorName: "Cloud9",
        kind: "project_poll_closed", refId: poll.id,
        detail: "closed when its deadline was reached",
      });
      this.pushPoll(poll);
    }
    this.scheduleProjectPollExpiry();
  }

  /** Schedule the earliest stored deadline, including deadlines restored on restart. */
  private scheduleProjectPollExpiry(): void {
    if (this.pollExpiryTimer) clearTimeout(this.pollExpiryTimer);
    this.pollExpiryTimer = undefined;
    const at = this.store.nextProjectPollDeadline();
    if (at === undefined) return;
    // Node clamps delays above 2^31-1ms to 1ms. Keep the durable deadline
    // intact and wake in bounded chunks for far-future polls instead of
    // accidentally closing them immediately after creation/restart.
    const delay = Math.max(0, at - Date.now()) + 10;
    const boundedDelay = Math.min(delay, 24 * 60 * 60 * 1000);
    const timer = setTimeout(() => {
      if (this.pollExpiryTimer === timer) this.pollExpiryTimer = undefined;
      if (Date.now() < at) this.scheduleProjectPollExpiry();
      else this.sweepExpiredProjectPolls();
    }, boundedDelay);
    timer.unref?.();
    this.pollExpiryTimer = timer;
  }

  /**
   * Poll activity rows are membership-scoped. A hub guest who cannot open the
   * project must not learn that a poll was created, voted, or closed.
   */
  private canSeeActivity(userId: ID, record: ActivityRecord): boolean {
    if (record.kind !== "project_poll_created"
      && record.kind !== "project_poll_voted"
      && record.kind !== "project_poll_closed") {
      return true;
    }
    const poll = record.refId ? this.store.projectPoll(record.refId) : undefined;
    if (!poll) return false;
    try { this.projectForMember(userId, poll.projectId); return true; }
    catch { return false; }
  }

  /**
   * Every project leaves the hub through here, so "looking" cannot be forgotten.
   *
   * CLASS: member-facing projections never carry the owner's disk path or
   * private repo string. Polls only need id + name for the picker; owners still
   * get the full row (including looking/localPath/repo).
   */
  
  private projectForCanvas(userId: ID, projectId: ID): Project {
    return this.projectForMember(userId, projectId);
  }
  private canvasForMember(userId: ID, canvasId: ID): { project: Project; canvas: EngineeringCanvas } {
    const canvas = this.store.canvas(canvasId);
    if (!canvas) throw new Error("no such canvas");
    return { canvas, project: this.projectForCanvas(userId, canvas.projectId) };
  }
  /**
   * Canvas authorship is explicit at the engine boundary. An engine socket is
   * authenticated as the owner account, but it is not a human keyboard: an
   * omitted agent id must never silently turn an engine mutation into a human
   * edit. Desktop sockets may write as the signed-in human only; engine
   * sockets must name one of the owner's stored agents for every mutation.
   */
  private canvasAuthor(conn: Conn, project: Project, authorAgentId: ID | undefined): { id: ID; kind: CanvasBlock["authorKind"] } {
    if (conn.client === "engine") {
      if (!authorAgentId) throw new Error("engine Canvas mutations must name an agent");
      const agent = this.myAgent(conn.userId, authorAgentId);
      if (agent.ownerId !== project.ownerId) throw new Error("that agent does not own this project");
      return { id: agent.id, kind: "agent" };
    }
    if (authorAgentId !== undefined) throw new Error("only the engine can author a Canvas for an agent");
    return { id: conn.userId, kind: "human" };
  }
  /** A request id is a receipt for one exact Canvas operation, not a reusable nonce. */
  private canvasReceipt(conn: Conn, requestId: ID | undefined, action: string, target: ID, payload: unknown) {
    if (!requestId) return undefined;
    const prior = this.store.canvasRequest(conn.userId, requestId);
    if (!prior) return undefined;
    const encoded = JSON.stringify(payload);
    const fingerprint = this.canvasPayloadFingerprint(payload);
    if (prior.action !== action || prior.target !== target || (prior.payload !== encoded && prior.payload !== fingerprint)) {
      throw new Error("that Canvas request id was already used for a different operation");
    }
    return prior;
  }
  private canvasPayloadFingerprint(payload: unknown): string {
    const canonical = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonical);
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value as object).sort().map(k => [k, canonical((value as Record<string, unknown>)[k])]));
      }
      return value;
    };
    return createHash("sha256").update(JSON.stringify(canonical(payload))).digest("hex");
  }
  private canvasView(userId: ID, canvas: EngineeringCanvas): EngineeringCanvasView {
    const project = this.store.project(canvas.projectId);
    const displayName = (id: ID, kind: CanvasBlock["authorKind"] = "human"): string | undefined => {
      if (kind === "agent") return this.store.agents().find(a => a.id === id)?.name;
      return this.store.users().find(u => u.id === id)?.name
        ?? this.store.agents().find(a => a.id === id)?.name;
    };
    const blocks = canvas.blocks.map(block => {
      const link = block.link;
      const visible = !link || (!!project && this.canvasLinkAllowed(userId, project, link));
      return {
        ...block,
        ...(block.authorName ? {} : (displayName(block.authorId, block.authorKind) ? { authorName: displayName(block.authorId, block.authorKind) } : {})),
        ...(block.deletedBy && !block.deletedByName && displayName(block.deletedBy)
          ? { deletedByName: displayName(block.deletedBy) } : {}),
        ...(link && !visible ? { link: undefined, linkUnavailable: true } : {}),
      };
    });
    return {
      ...canvas, blocks,
      unread: this.store.canvasRead(canvas.id, userId) < canvas.revision,
      canEdit: !!project && (project.ownerId === userId || (!!project.channelId && (() => { try { this.channelFor(userId, project.channelId!); return true; } catch { return false; } })())),
      canModerate: !!project && project.ownerId === userId,
    };
  }
  private canvasAudience(project: Project): Set<ID> {
    return this.projectAudience(project);
  }
  private pushCanvas(canvas: EngineeringCanvas, origin?: Conn, requestId?: ID): void {
    const project = this.store.project(canvas.projectId);
    if (!project) return;
    const audience = this.canvasAudience(project);
    for (const userId of audience) {
      const view = this.canvasView(userId, canvas);
      const frame: ServerFrame = {
        type: "canvas", canvas: view,
        ...(requestId && origin && origin.userId === userId ? { requestId } : {}),
      };
      this.toUser(userId, frame);
    }
  }
  /** Re-project a project's Canvas list whenever membership/access changes. */
  private pushCanvasProject(project: Project): void {
    const canvases = this.store.canvasesForProject(project.id);
    for (const userId of this.canvasAudience(project)) {
      // B2: every member-facing project projection is redacted per viewer.
      this.toUser(userId, { type: "project", project: this.viewProject(project, userId) });
      this.toUser(userId, { type: "canvases", projectId: project.id,
        canvases: canvases.map(canvas => this.canvasView(userId, canvas)) });
    }
  }
  private canvasLinkAllowed(userId: ID, project: Project, link: CanvasLink): boolean {
    if (link.kind === "task") {
      const task = this.store.task(link.id);
      if (!task) return false;
      try { this.channelFor(userId, task.channelId); return true; } catch { return false; }
    }
    if (link.kind === "run") {
      const row = this.store.run(link.id);
      if (!row) return false;
      if (row.ownerId !== project.ownerId) return false;
      if (row.channelId) { try { this.channelFor(userId, row.channelId); return true; } catch { return false; } }
      return userId === project.ownerId;
    }
    if (link.kind === "artifact") {
      try { this.artifactFor(userId, link.id); return true; } catch { return false; }
    }
    if (link.kind === "pullRequest") {
      return this.store.projectItems(project.id).some(item => item.kind === "pull" && String(item.number) === link.id);
    }
    return false;
  }

private viewProject(project: Project, viewerId?: ID): Project {
    const base = this.looking.has(project.id) ? { ...project, looking: true } : { ...project };
    if (viewerId === undefined || project.ownerId === viewerId) return base;
    // Member-safe: id + name (+ room linkage). Never localPath or repo.
    return {
      id: base.id,
      ownerId: base.ownerId,
      name: base.name,
      repo: "",
      createdAt: base.createdAt,
      ...(base.channelId ? { channelId: base.channelId } : {}),
      ...(base.description ? { description: base.description } : {}),
    };
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
    return channels.map(c => {
      const cursor = this.store.lastReadCursor(userId, c.id);
      return {
        channelId: c.id, lastReadTs: cursor.ts,
        ...(cursor.id ? { lastReadId: cursor.id } : {}),
        ...this.store.unreadFor(userId, c.id, mine),
      };
    });
  }

  /** Build the author-only delivery projection; group rows never contain recipient ids. */
  private messageStatusFor(authorId: ID, message: Message): MessageStatus {
    const channel = this.store.channel(message.channelId);
    const ledger = this.store.messageSendStatus(authorId, message.clientMessageId, message.id);
    // Receipt audience is frozen at message creation.  Current membership is
    // only an access gate; a late joiner must not inflate an old message's
    // recipient count, and a former member must remain part of the historical
    // denominator even after their receipt metadata is cleaned up.
    const humans = this.store.channelMembers(message.channelId, { at: message.ts })
      .map(member => member.memberId)
      .filter(id => !!this.store.user(id) && id !== authorId);
    const receipts = this.store.messageReceipts(message.id).filter(r => humans.includes(r.recipientId));
    const deliveredCount = receipts.filter(r => r.deliveredAt !== undefined || r.readAt !== undefined).length;
    const readCount = receipts.filter(r => r.readAt !== undefined).length;
    const stage: MessageStatus["stage"] = readCount > 0 && readCount >= humans.length && humans.length > 0
      ? "read" : deliveredCount > 0 ? "delivered" : "accepted";
    const directHuman = channel?.kind === "dm" && humans.length === 1;
    return {
      messageId: message.id, ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}),
      channelId: message.channelId, stage,
      acceptedAt: ledger?.createdAt ?? message.ts,
      ...(receipts.find(r => r.deliveredAt !== undefined)?.deliveredAt !== undefined
        ? { deliveredAt: receipts.find(r => r.deliveredAt !== undefined)!.deliveredAt } : {}),
      ...(receipts.find(r => r.readAt !== undefined)?.readAt !== undefined
        ? { readAt: receipts.find(r => r.readAt !== undefined)!.readAt } : {}),
      deliveredCount, readCount, recipientCount: humans.length,
      ...(directHuman ? {
        recipients: receipts.filter(r => r.deliveredAt !== undefined || r.readAt !== undefined).map(r => ({
          recipientId: r.recipientId,
          stage: r.readAt !== undefined ? "read" as const : "delivered" as const,
          at: r.readAt ?? r.deliveredAt!,
        })),
      } : {}),
    };
  }

  private messageStatusesFor(authorId: ID): MessageStatus[] {
    const channels = this.visibleChannels(authorId);
    // `recentMessages(channels, 512)` is intentionally per-channel.  Do not
    // slice the flattened result: channel ordering would let one busy room
    // evict every other room's status from the bootstrap projection.
    return channels.flatMap(channel => this.store.history(channel.id, {}, 512).items)
      .filter(message => message.authorId === authorId)
      .map(message => this.messageStatusFor(authorId, message));
  }

  private pushMessageStatus(authorId: ID, message: Message): void {
    const channel = this.store.channel(message.channelId);
    if (!channel || !this.audienceFor(channel).has(authorId)) return;
    const frame: ServerFrame = { type: "messageStatus", status: this.messageStatusFor(authorId, message) };
    // Delivery is a human author's window concern.  In particular, do not
    // stream this projection to an engine connection, and never room-broadcast
    // it: an engine is not a human reader and other members must not learn a
    // sender's per-message state.
    for (const conn of this.conns) {
      if (conn.userId === authorId && conn.client !== "engine") send(conn.ws, frame);
    }
  }

  /** Authenticate and apply one human delivered/read receipt. */
  private handleHumanReceipt(conn: Conn, frame: Extract<ClientFrame, { type: "messageReceipt" | "humanReceipt" }>): void {
    if (conn.client === "engine") throw new Error("agent engines cannot send human receipts");
    // The TypeScript union is not a runtime boundary: a reconnecting or
    // hand-written client can still put an arbitrary string on the wire.
    // Refuse it before the store's read branch could interpret it as `read`.
    if (frame.status !== "delivered" && frame.status !== "read") {
      throw new Error("that receipt stage is not supported");
    }
    const channel = this.channelFor(conn.userId, frame.channelId);
    // `channelFor` also permits a person's own agent to make the conversation
    // visible.  A human receipt is narrower: the authenticated human account
    // itself must be a current member, not merely the owner of an agent in the
    // room.
    if (!channel.memberIds.includes(conn.userId)) {
      throw new Error("only a direct human member can acknowledge this message");
    }
    const message = this.store.message(frame.messageId);
    if (!message || message.channelId !== channel.id) throw new Error("that message is not in this channel");
    if (!this.store.channelMembers(channel.id, { at: message.ts }).some(member => member.memberId === conn.userId)) {
      throw new Error("you were not a human member when that message was sent");
    }
    if (message.authorKind !== "human" || message.authorId === conn.userId) {
      throw new Error("only another human recipient can acknowledge this message");
    }
    const cursorTs = frame.ts;
    const cursorId = frame.messageIdCursor;
    if (frame.status === "read" && cursorTs !== undefined) {
      const latest = this.store.history(channel.id, {}, MESSAGE_LIMITS.page).items.at(-1);
      if (latest && (cursorTs > latest.ts || (cursorTs === latest.ts && cursorId !== undefined && cursorId > latest.id))) {
        throw new Error("that read cursor is ahead of this conversation");
      }
    }
    const changed = this.store.recordMessageReceipt(conn.userId, message, frame.status, {
      ts: cursorTs, id: cursorId,
    });
    if (changed) this.pushMessageStatus(message.authorId, message);
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

  /** Project saves against current membership and current message tombstones. */
  private savedMessageProjection(userId: ID, opts: { limit?: number; beforeSavedAt?: number; beforeMessageId?: ID } = {}): SavedMessageEntry[] {
    return this.store.savedMessagesPage(userId, opts.limit, opts.beforeSavedAt, opts.beforeMessageId).entries.map(row => {
      const base: SavedMessageEntry = {
        id: row.id, messageId: row.messageId, channelId: row.channelId,
        savedAt: row.savedAt, state: "inaccessible",
        ...(row.note ? { note: row.note } : {}),
        ...(row.remindAt !== undefined ? { remindAt: row.remindAt } : {}),
      };
      let channel: Channel | undefined;
      try { channel = this.channelFor(userId, row.channelId); } catch { return base; }
      const message = this.store.message(row.messageId);
      if (!message || message.channelId !== channel.id) return base;
      if (message.deletedAt) {
        return { ...base, state: "deleted" };
      }
      return {
        ...base, state: "active", message: this.hydrate([message])[0],
        ...(message.replyTo ? { threadParentId: message.replyTo } : {}),
      };
    });
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
  private validateAttachments(userId: ID, channel: Channel, ids: ID[] | undefined): Attachment[] {
    if (!ids || ids.length === 0) return [];
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length > ATTACHMENT_LIMITS.perMessage) {
      throw new Error(`that's too many files (max ${ATTACHMENT_LIMITS.perMessage})`);
    }
    const out: Attachment[] = [];
    const now = Date.now();
    for (const id of uniqueIds) {
      const row = this.store.attachment(id);
      if (!row) throw new Error("that file isn't ready to send");
      if (row.attachment.uploadedBy !== userId) throw new Error("that file isn't yours to send");
      if (row.channelId !== channel.id) throw new Error("that file was uploaded to another conversation");
      if (row.messageId) throw new Error("that file has already been sent");
      const expiresAt = row.attachment.uploadedAt + ATTACHMENT_LIMITS.parkedTtlMs;
      const bytesPath = path.join(this.store.attachmentsDir, path.basename(row.attachment.storedAs));
      if (row.attachment.uploadedAt > now || now >= expiresAt || !fs.existsSync(bytesPath)) {
        this.store.removeParkedAttachment(id, userId);
        throw new Error(row.attachment.uploadedAt > now
          ? "that file is not available yet — attach it again"
          : now >= expiresAt ? "that file expired — attach it again"
            : "that file is no longer available — attach it again");
      }
      out.push(row.attachment);
    }
    return out;
  }

  /**
   * Re-project a draft attachment from relay-owned rows and bytes. A browser's
   * metadata can name what it used to have, but it cannot make a reclaimed or
   * inaccessible id available again.
   */
  private draftAttachment(userId: ID, channel: Channel, input: DraftAttachment): DraftAttachment {
    const expiresAt = Number.isFinite(input.expiresAt) && input.expiresAt > 0
      ? Math.floor(input.expiresAt) : input.uploadedAt + ATTACHMENT_LIMITS.parkedTtlMs;
    const fallback = (state: DraftAttachmentState, error: string): DraftAttachment => ({
      id: input.id, name: input.name, size: input.size,
      ...(input.mime ? { mime: input.mime.slice(0, 128) } : {}),
      uploadedAt: input.uploadedAt, expiresAt, state, error,
    });
    if (input.state === "removed") return fallback("removed", "removed from this draft");
    const row = this.store.attachment(input.id);
    if (!row) return fallback(Date.now() >= expiresAt ? "expired" : "unavailable",
      Date.now() >= expiresAt ? "that file expired — attach it again" : "that file is no longer available — attach it again");
    if (row.attachment.uploadedBy !== userId || row.channelId !== channel.id) {
      return fallback("unavailable", "that file is no longer available in this conversation — attach it again");
    }
    if (row.messageId) return fallback("deleted", "that file was already sent or deleted");
    const actualExpiresAt = row.attachment.uploadedAt + ATTACHMENT_LIMITS.parkedTtlMs;
    // A client cannot make a future-dated upload available by projecting its
    // metadata. Clock-skewed or tampered rows stay visibly unavailable until
    // a fresh upload lands; send applies the same refusal at claim time.
    if (row.attachment.uploadedAt > Date.now()) return {
      id: row.attachment.id, name: row.attachment.name, size: row.attachment.size,
      ...(row.attachment.mime ? { mime: row.attachment.mime } : {}),
      uploadedAt: row.attachment.uploadedAt, expiresAt: actualExpiresAt,
      state: "unavailable", error: "that file is not available yet — attach it again",
    };
    if (Date.now() >= actualExpiresAt) return {
      id: row.attachment.id, name: row.attachment.name, size: row.attachment.size,
      ...(row.attachment.mime ? { mime: row.attachment.mime } : {}),
      uploadedAt: row.attachment.uploadedAt, expiresAt: actualExpiresAt,
      state: "expired", error: "that file expired — attach it again",
    };
    const bytesPath = path.join(this.store.attachmentsDir, path.basename(row.attachment.storedAs));
    if (!fs.existsSync(bytesPath)) return fallback("unavailable", "that file is no longer on the relay — attach it again");
    return {
      id: row.attachment.id, name: row.attachment.name, size: row.attachment.size,
      ...(row.attachment.mime ? { mime: row.attachment.mime } : {}),
      uploadedAt: row.attachment.uploadedAt, expiresAt: actualExpiresAt, state: "available",
    };
  }

  private draftProjection(userId: ID, channel: Channel, draft: ChatDraft): ChatDraft {
    const attachments = draft.attachments.slice(0, DRAFT_LIMITS.attachmentCount)
      .map(a => this.draftAttachment(userId, channel, a));
    const hasUnavailable = attachments.some(a => a.state === "unavailable" || a.state === "deleted");
    const hasExpired = attachments.some(a => a.state === "expired");
    const state = draft.text || attachments.some(a => a.state === "available")
      ? (hasUnavailable ? "unavailable" : hasExpired ? "expired" : "active")
      : (hasUnavailable ? "unavailable" : hasExpired ? "expired" : "empty");
    return {
      ...draft, channelId: channel.id, attachments, state,
      // Projection reports the relay's current attachment truth but never
      // moves the durable draft deadline forward. Reconcile must not become a
      // keep-alive for an abandoned draft or a parked file.
      expiresAt: Math.max(draft.expiresAt, ...attachments.map(a => a.expiresAt)),
    };
  }

  private draftScope(conn: Conn, channelId: ID, threadId?: ID): { channel: Channel; threadId?: ID } {
    const channel = this.channelFor(conn.userId, channelId);
    if (threadId) {
      const thread = this.store.message(threadId);
      if (!thread || thread.channelId !== channel.id) throw new Error("that thread is no longer available");
      return { channel, threadId: thread.replyTo ?? thread.id };
    }
    return { channel };
  }

  private draftInput(conn: Conn, frame: Extract<ClientFrame, { type: "draftUpdate" }>): ChatDraft {
    const { channel, threadId } = this.draftScope(conn, frame.channelId, frame.threadId);
    if (typeof frame.text !== "string" || frame.text.length > MESSAGE_LIMITS.text) {
      throw new Error(`that draft is too long (max ${MESSAGE_LIMITS.text} characters)`);
    }
    if (!Array.isArray(frame.attachments) || frame.attachments.length > DRAFT_LIMITS.attachmentCount) {
      throw new Error(`that draft has too many files (max ${DRAFT_LIMITS.attachmentCount})`);
    }
    const seen = new Set<ID>();
    const attachments = frame.attachments.map(input => {
      if (!input || typeof input.id !== "string" || !isSafeStoredId(input.id) || seen.has(input.id)) {
        throw new Error("that draft has an invalid attachment");
      }
      seen.add(input.id);
      if (typeof input.name !== "string" || !input.name || !Number.isFinite(input.size) || input.size < 0
        || !Number.isFinite(input.uploadedAt) || !Number.isFinite(input.expiresAt)) {
        throw new Error("that draft has invalid attachment details");
      }
      return this.draftAttachment(conn.userId, channel, input);
    });
    const now = Date.now();
    return this.draftProjection(conn.userId, channel, {
      id: this.store.draftId(conn.userId, channel.id, threadId), channelId: channel.id,
      ...(threadId ? { threadId, replyTo: threadId } : {}), text: frame.text,
      attachments, updatedAt: now,
      expiresAt: Math.max(now + ATTACHMENT_LIMITS.parkedTtlMs, ...attachments.map(a => a.expiresAt)),
      state: frame.text || attachments.length ? "active" : "empty",
    });
  }

  /** Fingerprint the client's durable intent, excluding relay-derived state/expiry. */
  private draftIntentHash(frame: Extract<ClientFrame, { type: "draftUpdate" }>, threadId?: ID): string {
    const attachments = frame.attachments.map(input => ({
      id: input.id, name: input.name, size: input.size,
      mime: input.mime ?? null, uploadedAt: input.uploadedAt,
    }));
    return createHash("sha256").update(JSON.stringify([
      "draftUpdate", frame.channelId, threadId ?? null, frame.text,
      frame.replyTo ?? null, attachments,
    ])).digest("hex");
  }

  private sendDraft(conn: Conn, draft: ChatDraft, requestId?: ID): void {
    send(conn.ws, { type: "draftChanged", draft, ...(requestId ? { requestId } : {}) });
  }

  private inaccessibleDraft(draft: ChatDraft): ChatDraft {
    return {
      ...draft, state: "unavailable",
      attachments: draft.attachments.map(a => a.state === "removed" ? a : {
        ...a, state: "unavailable", error: "this conversation is no longer available",
      }),
    };
  }

  private projectDraftForUser(userId: ID, draft: ChatDraft): ChatDraft {
    try {
      const channel = this.channelFor(userId, draft.channelId);
      return this.draftProjection(userId, channel, draft);
    } catch {
      return this.inaccessibleDraft(draft);
    }
  }

  /** List only drafts whose room/thread is currently readable by this user. */
  private visibleDrafts(conn: Conn, channelId?: ID, threadId?: ID): ChatDraft[] {
    if (threadId && !channelId) throw new Error("a thread draft needs its channel");
    const scope = channelId ? this.draftScope(conn, channelId, threadId) : undefined;
    return this.store.chatDrafts(conn.userId, channelId, scope?.threadId)
      .filter(draft => {
        try { this.draftScope(conn, draft.channelId, draft.threadId); return true; }
        catch { return false; }
      })
      .map(draft => this.projectDraftForUser(conn.userId, draft));
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

  private typingKey(channelId: ID, userId: ID): string {
    return `${channelId}\u0000${userId}`;
  }

  /** Stamp and schedule one live signal; the timer is the only expiry owner. */
  private scheduleTypingExpiry(state: LiveTyping): void {
    if (state.timer) clearTimeout(state.timer);
    const delay = Math.max(0, state.expiresAt! - Date.now());
    state.timer = setTimeout(() => {
      const current = this.liveTyping.get(this.typingKey(state.channelId, state.userId));
      if (current !== state) return;
      if (Date.now() < state.expiresAt!) {
        this.scheduleTypingExpiry(state);
        return;
      }
      this.removeLiveTyping(state.channelId, state.userId);
    }, delay);
  }

  /** Remove one signal and tell the channel's CURRENT authorized audience. */
  private removeLiveTyping(channelId: ID, userId: ID, notify = true): void {
    const key = this.typingKey(channelId, userId);
    const state = this.liveTyping.get(key);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    this.liveTyping.delete(key);
    if (!notify) return;
    const channel = this.store.channel(channelId);
    if (!channel) return;
    this.toChannel(channel, {
      type: "typing",
      typing: { channelId, userId, userName: state.userName, typing: false },
    });
  }

  /** Project shared pins against the viewer's CURRENT channel access/source. */
  private channelPinProjection(userId: ID, row: import("./store.js").ChannelPinRow): ChannelPinEntry {
    const pinnedBy = this.store.user(row.pinnedById);
    const base: ChannelPinEntry = {
      id: row.id, channelId: row.channelId, messageId: row.messageId, pinnedAt: row.pinnedAt,
      ...(pinnedBy ? { pinnedById: pinnedBy.id, pinnedByName: pinnedBy.name } : {}),
      state: "inaccessible",
    };
    let channel: Channel;
    try { channel = this.channelFor(userId, row.channelId); } catch { return base; }
    const message = this.store.message(row.messageId);
    if (!message || message.channelId !== channel.id) return base;
    if (message.deletedAt) return { ...base, state: "deleted" };
    return {
      ...base, state: "active", message: this.hydrate([message])[0],
      ...(message.replyTo ? { threadParentId: message.replyTo } : {}),
    };
  }

  private channelPinsProjection(
    userId: ID,
    opts: { channelId: ID; limit?: number; beforePinnedAt?: number; beforeMessageId?: ID },
  ): ChannelPinEntry[] {
    return this.store.channelPinsPage(opts.channelId, opts.limit, opts.beforePinnedAt, opts.beforeMessageId)
      .entries.map(row => this.channelPinProjection(userId, row));
  }

  /** Clear every live signal authored by one human (disconnect/removal path). */
  private clearTypingForUser(userId: ID): void {
    for (const state of [...this.liveTyping.values()]) {
      if (state.userId === userId) this.removeLiveTyping(state.channelId, userId);
    }
  }

  /** A blur/close only removes the signal from the window that sent it. */
  private clearTypingForConnection(ws: WebSocket): void {
    for (const state of [...this.liveTyping.values()]) {
      if (!state.sources.delete(ws)) continue;
      if (state.sources.size === 0) this.removeLiveTyping(state.channelId, state.userId);
    }
  }

  /** Clear a room's signal once the person is no longer allowed to see it. */
  private clearTypingForChannelUser(channelId: ID, userId: ID): void {
    this.removeLiveTyping(channelId, userId);
  }

  /**
   * Human typing is authenticated against stored membership and is never a
   * request/response. The relay owns the displayed name, debounce and expiry.
   */
  private handleTyping(conn: Conn, frame: Extract<ClientFrame, { type: "typing" }>): void {
    if (conn.client === "engine") throw new Error("agents cannot send human typing");
    const channel = frame.typing
      ? this.writableChannel(conn.userId, frame.channelId)
      : this.channelFor(conn.userId, frame.channelId);
    const user = this.store.user(conn.userId);
    if (!user) throw new Error("no such person");
    const key = this.typingKey(channel.id, user.id);
    const current = this.liveTyping.get(key);
    if (!frame.typing) {
      // Repeated stops are intentionally silent. One person's other open
      // window may still be typing in this room, so only its own source ends.
      if (!current || !current.sources.delete(conn.ws)) return;
      if (current.sources.size === 0) this.removeLiveTyping(channel.id, user.id);
      return;
    }

    const now = Date.now();
    const expiresAt = now + HUMAN_TYPING_TTL_MS;
    if (current) {
      current.sources.add(conn.ws);
      current.expiresAt = expiresAt;
      this.scheduleTypingExpiry(current);
      // Keep a noisy keydown stream in memory, but broadcast at most 4/sec.
      if (now - current.lastBroadcastAt < HUMAN_TYPING_DEBOUNCE_MS) return;
      current.lastBroadcastAt = now;
      this.toChannel(channel, {
        type: "typing",
        typing: { channelId: channel.id, userId: user.id, userName: user.name, typing: true, expiresAt },
      });
      return;
    }

    const state: LiveTyping = {
      channelId: channel.id, userId: user.id, userName: user.name,
      typing: true, expiresAt, lastBroadcastAt: now, sources: new Set([conn.ws]),
    };
    this.liveTyping.set(key, state);
    this.scheduleTypingExpiry(state);
    this.toChannel(channel, {
      type: "typing",
      typing: { channelId: channel.id, userId: user.id, userName: user.name, typing: true, expiresAt },
    });
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
    // A person's sight of a room survives removing/leaving one membership when
    // one of their owned agents is still in it. Do not evict the human's
    // channel/project cache in that case; visibleChannels is the single
    // membership rule used everywhere else in the relay.
    const stillVisible = this.visibleChannels(userId).some(c => c.id === channelId);
    if (stillVisible) return;
    this.clearResponseStreams(stream => stream.ownerId === userId && stream.channelId === channelId);
    this.clearTypingForChannelUser(channelId, userId);
    this.toUser(userId, { type: "channelLeft", channelId });
    // Leaving a project room also changes Pulse visibility. Refresh the scoped
    // feed immediately so a removed member cannot keep a cached update alive.
    this.sendPulseSnapshot(userId);
    // Projects linked to this room derive membership from the room. A real
    // leave/remove must therefore revoke their cached projections immediately;
    // waiting for a later updateProject or reconnect leaves poll data visible
    // in another window after the member has lost access.
    for (const project of this.store.projectsAll()) {
      if (project.channelId === channelId && project.ownerId !== userId) {
        this.toUser(userId, { type: "projectAccessRevoked", projectId: project.id });
      }
    }
  }

  /** Drop ephemeral response previews when their owner or access boundary goes away. */
  private clearResponseStreams(
    predicate: (stream: ActiveResponseStream) => boolean = () => true,
    reason = "response preview ended because access changed",
  ): void {
    for (const [key, stream] of this.responseStreams) {
      if (!predicate(stream)) continue;
      const channel = this.store.channel(stream.channelId);
      if (channel) {
        this.toChannel(channel, {
          type: "agentResponse",
          stream: {
            kind: "response-cancel", channelId: stream.channelId,
            triggerMessageId: stream.triggerMessageId, agentId: stream.agentId,
            turnId: stream.turnId, seq: stream.lastSeq + 1, at: Date.now(), reason,
          },
        });
      }
      if (stream.timer) clearTimeout(stream.timer);
      this.tombstoneResponseStream(key);
      this.responseStreams.delete(key);
      const slot = responseStreamSlot(stream.ownerId, stream.channelId, stream.triggerMessageId, stream.agentId);
      if (this.responseStreamSlots.get(slot) === key) this.responseStreamSlots.delete(slot);
    }
  }

  /** Remember a recently ended public turn without retaining any response text. */
  private tombstoneResponseStream(key: string, now = Date.now()): void {
    this.responseStreamTombstones.set(key, now + RESPONSE_STREAM_LIMITS.staleMs);
    const max = RESPONSE_STREAM_LIMITS.maxActiveStreams * 4;
    if (this.responseStreamTombstones.size <= max) return;
    for (const [candidate, expiresAt] of this.responseStreamTombstones) {
      if (expiresAt <= now || this.responseStreamTombstones.size > max) {
        this.responseStreamTombstones.delete(candidate);
      }
      if (this.responseStreamTombstones.size <= max) break;
    }
  }

  private responseStreamRecentlyEnded(key: string, now = Date.now()): boolean {
    const expiresAt = this.responseStreamTombstones.get(key);
    if (expiresAt === undefined) return false;
    if (expiresAt <= now) {
      this.responseStreamTombstones.delete(key);
      return false;
    }
    return true;
  }

  /** Project a safe terminal event and forget its in-memory stream state. */
  private failResponseStream(
    channel: Channel, event: AgentResponseStreamEvent, reason: string, key?: string,
  ): void {
    const now = Date.now();
    const projected: AgentResponseStreamEvent = {
      ...event, kind: "response-fail", seq: Math.max(0, event.seq), at: now,
      text: undefined, reason: reason.slice(0, RESPONSE_STREAM_LIMITS.reasonChars), channelId: channel.id,
    };
    this.toChannel(channel, { type: "agentResponse", stream: projected });
    if (key) {
      const active = this.responseStreams.get(key);
      if (active?.timer) clearTimeout(active.timer);
      this.tombstoneResponseStream(key, now);
      this.responseStreams.delete(key);
      if (active) {
        const slot = responseStreamSlot(active.ownerId, active.channelId, active.triggerMessageId, active.agentId);
        if (this.responseStreamSlots.get(slot) === key) this.responseStreamSlots.delete(slot);
      }
    }
  }

  /** The owner-only definition gate used by every workflow frame. */
  private myWorkflow(userId: ID, workflowId: ID): Workflow {
    const workflow = this.store.workflow(workflowId);
    if (!workflow || workflow.ownerId !== userId) throw new Error("no such workflow");
    return workflow;
  }

  /**
   * Publish workflow changes to every owner window, while keeping a request
   * correlation id on the originating socket only. A second desktop window
   * has no ledger entry for the first window's request id; broadcasting that
   * id made it drop the update entirely.
   */
  private tellWorkflow(userId: ID, workflow: Workflow, requestId?: ID, origin?: Conn): void {
    const base: ServerFrame = { type: "workflow", workflow };

    const correlated = Boolean(origin && requestId);
    for (const conn of this.conns) {
      if (conn.userId === userId && (!correlated || conn !== origin)) send(conn.ws, base);
    }
    if (correlated) send(origin!.ws, { ...base, requestId: requestId! });
  }

  /** Hook mutations mirror to every owner desktop while keeping the request
   * receipt on the originating socket only. An engine receives the durable
   * projection separately through `syncHooksToEngine` above. */
  private tellHook(userId: ID, hook: StoredHook, requestId?: ID, origin?: Conn): void {
    const base: ServerFrame = { type: "hook", hook };
    const correlated = Boolean(origin && requestId);
    for (const conn of this.conns) {
      if (conn.userId === userId && conn.client === "desktop"
        && (!correlated || conn !== origin)) send(conn.ws, base);
    }
    if (correlated) send(origin!.ws, { ...base, requestId: requestId! });
  }

  private tellHooks(userId: ID, requestId?: ID, origin?: Conn): void {
    const base: ServerFrame = { type: "hooks", hooks: this.store.hooksOf(userId) };
    const correlated = Boolean(origin && requestId);
    for (const conn of this.conns) {
      if (conn.userId === userId && conn.client === "desktop"
        && (!correlated || conn !== origin)) send(conn.ws, base);
    }
    if (correlated) send(origin!.ws, { ...base, requestId: requestId! });
  }

  /** Saved queue updates are private to the account, but mirror to its windows. */
  private tellSaved(userId: ID, requestId?: ID, origin?: Conn, opts: { limit?: number; beforeSavedAt?: number; beforeMessageId?: ID } = {}): void {
    const page = this.store.savedMessagesPage(userId, opts.limit, opts.beforeSavedAt, opts.beforeMessageId);
    const base: ServerFrame = {
      type: "savedMessages", entries: this.savedMessageProjection(userId, opts),
      revision: this.store.savedMessagesRevision(userId),
      hasMore: page.hasMore,
      ...(page.nextSavedAt !== undefined ? { nextSavedAt: page.nextSavedAt } : {}),
      ...(page.nextMessageId !== undefined ? { nextMessageId: page.nextMessageId } : {}),
    };
    const correlated = Boolean(origin && requestId);
    for (const conn of this.conns) {
      if (conn.userId === userId && (!correlated || conn !== origin)) send(conn.ws, base);
    }
    if (correlated) send(origin!.ws, { ...base, requestId: requestId! });
  }

  /** Shared pins mirror to every authorized window; only the origin gets the receipt id. */
  private tellChannelPins(
    channel: Channel, requestId?: ID, origin?: Conn,
    opts: { limit?: number; beforePinnedAt?: number; beforeMessageId?: ID } = {},
  ): void {
    const page = this.store.channelPinsPage(channel.id, opts.limit, opts.beforePinnedAt, opts.beforeMessageId);
    const correlated = Boolean(origin && requestId);
    for (const conn of this.conns) {
      if (!this.audienceFor(channel).has(conn.userId)) continue;
      if (correlated && conn === origin) continue;
      send(conn.ws, {
        type: "channelPins", channelId: channel.id,
        entries: this.channelPinsProjection(conn.userId, { ...opts, channelId: channel.id }),
        revision: this.store.channelPinsRevision(channel.id), hasMore: page.hasMore,
        ...(page.nextPinnedAt !== undefined ? { nextPinnedAt: page.nextPinnedAt } : {}),
        ...(page.nextMessageId !== undefined ? { nextMessageId: page.nextMessageId } : {}),
      });
    }
    if (correlated) {
      send(origin!.ws, {
        type: "channelPins", channelId: channel.id,
        entries: this.channelPinsProjection(origin!.userId, { ...opts, channelId: channel.id }),
        revision: this.store.channelPinsRevision(channel.id), hasMore: page.hasMore,
        ...(page.nextPinnedAt !== undefined ? { nextPinnedAt: page.nextPinnedAt } : {}),
        ...(page.nextMessageId !== undefined ? { nextMessageId: page.nextMessageId } : {}),
        requestId: requestId!,
      });
    }
  }

  private tellWorkflowRun(userId: ID, run: WorkflowRun, requestId?: ID, origin?: Conn): void {
    const base: ServerFrame = { type: "workflowRun", run };
    const correlated = Boolean(origin && requestId);
    for (const conn of this.conns) {
      if (conn.userId === userId && (!correlated || conn !== origin)) send(conn.ws, base);
    }
    if (correlated) send(origin!.ws, { ...base, requestId: requestId! });
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
      causedByHook?: boolean;
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
      ...(input.causedByHook ? { causedByHook: true } : {}),
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

  private persistWorkflowRun(run: WorkflowRun, requestId?: ID, origin?: Conn): void {
    run.updatedAt = Date.now();
    this.store.saveWorkflowRun(run);
    this.tellWorkflowRun(run.ownerId, run, requestId, origin);
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
    this.persistWorkflowRun(run, requestId, conn);
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
      case "typing":
        this.handleTyping(conn, frame);
        break;
      case "draftList": {
        this.store.sweepChatDrafts(Date.now());
        const drafts = this.visibleDrafts(conn, frame.channelId, frame.threadId);
        send(conn.ws, { type: "drafts", drafts, ...(frame.requestId ? { requestId: frame.requestId } : {}) });
        break;
      }
      case "draftReconcile": {
        this.store.sweepChatDrafts(Date.now());
        const drafts = this.visibleDrafts(conn, frame.channelId, frame.threadId);
        // Reconcile is deliberately a projection/reclaim pass, not a TTL
        // extension. Valid parked ids remain owned by the attachment store;
        // expired/missing rows are marked so the UI can remove/reselect them.
        for (const draft of drafts) {
          try { this.store.reclaimChatDraftAttachments(conn.userId, draft); } catch { /* projection remains honest */ }
        }
        send(conn.ws, { type: "drafts", drafts, ...(frame.requestId ? { requestId: frame.requestId } : {}) });
        break;
      }
      case "draftReclaim": {
        const { threadId } = this.draftScope(conn, frame.channelId, frame.threadId);
        const existing = this.store.chatDraft(conn.userId, frame.channelId, threadId);
        if (!existing) {
          send(conn.ws, { type: "draftRemoved", channelId: frame.channelId, ...(threadId ? { threadId } : {}), ...(frame.requestId ? { requestId: frame.requestId } : {}) });
          break;
        }
        const projected = this.projectDraftForUser(conn.userId, existing);
        const keptIds = frame.attachmentIds ? new Set(frame.attachmentIds) : undefined;
        const next = keptIds ? { ...projected, attachments: projected.attachments.filter(a => keptIds.has(a.id)) } : projected;
        const saved = this.store.reclaimChatDraftAttachments(conn.userId, next, frame.requestId);
        this.sendDraft(conn, this.projectDraftForUser(conn.userId, saved), frame.requestId);
        this.toUserExcept(conn.userId, conn, { type: "draftChanged", draft: this.projectDraftForUser(conn.userId, saved) });
        break;
      }
      case "draftUpdate": {
        const { threadId } = this.draftScope(conn, frame.channelId, frame.threadId);
        const input = this.draftInput(conn, frame);
        const saved = this.store.saveChatDraft(conn.userId, input, frame.requestId, this.draftIntentHash(frame, threadId));
        const projected = this.projectDraftForUser(conn.userId, saved);
        this.sendDraft(conn, projected, frame.requestId);
        this.toUserExcept(conn.userId, conn, { type: "draftChanged", draft: projected });
        break;
      }
      case "draftRemove": {
        const { threadId } = this.draftScope(conn, frame.channelId, frame.threadId);
        this.store.removeChatDraft(conn.userId, frame.channelId, threadId, frame.requestId);
        const out: ServerFrame = {
          type: "draftRemoved", channelId: frame.channelId,
          ...(threadId ? { threadId } : {}),
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        };
        send(conn.ws, out);
        this.toUserExcept(conn.userId, conn, {
          type: "draftRemoved", channelId: frame.channelId,
          ...(threadId ? { threadId } : {}),
        });
        break;
      }
      case "send": {
        const user = this.store.users().find(u => u.id === conn.userId)!;
        const clientMessageId = frame.clientMessageId ?? frame.tempId ?? newId("cm");
        const existing = this.store.messageSendStatus(conn.userId, clientMessageId);
        // A retry is an acknowledgement recovery operation, not a new write.
        // Authorise the original channel first (so removal still refuses), but
        // do not re-run mutable write/reply gates such as archive status.
        if (existing) {
          this.channelFor(conn.userId, existing.channelId);
          const payloadHash = this.store.messagePayloadHash({
            channelId: frame.channelId, text: frame.text, replyTo: frame.replyTo,
            attachmentIds: frame.attachmentIds,
          });
          if (existing.channelId !== frame.channelId || existing.payloadHash !== payloadHash) {
            throw new Error("that client message id was already used for different words");
          }
          const priorMessage = this.store.message(existing.messageId);
          if (!priorMessage) throw new Error("that accepted message is no longer available");
          send(conn.ws, { type: "message", message: this.hydrate([priorMessage])[0], tempId: frame.tempId, requestId: frame.requestId });
          this.pushMessageStatus(conn.userId, priorMessage);
          break;
        }
        const channel = this.writableChannel(conn.userId, frame.channelId); // you may only post where you are
        const attachmentIds = [...new Set(frame.attachmentIds ?? [])];
        const hasFiles = attachmentIds.length > 0;
        // words are optional only when a file is carrying the message
        const bad = validateMessageText(frame.text, hasFiles);
        if (bad) throw new Error(bad);
        const replyTo = this.resolveReplyTo(channel, frame.replyTo);
        const payloadHash = this.store.messagePayloadHash({
          channelId: frame.channelId, text: frame.text, replyTo: frame.replyTo, attachmentIds: frame.attachmentIds,
        });
        // The same 24-hour parked TTL applies at send time, not just at relay
        // startup/upload. A stale draft id must be refused rather than claimed.
        this.store.sweepParkedAttachments(Date.now() - ATTACHMENT_LIMITS.parkedTtlMs);
        const id = newId("m");
        const attachments = this.validateAttachments(conn.userId, channel, attachmentIds);
        const saved = this.postMessage({
          id, channelId: frame.channelId,
          authorId: user.id, authorName: user.name, authorKind: "human",
          clientMessageId,
          text: frame.text, ts: Date.now(),
          mentions: this.mentionsFor(conn.userId, frame.text),
          ...(replyTo ? { replyTo } : {}),
          ...(attachments.length ? { attachments } : {}),
        }, frame.tempId, frame.requestId, conn.userId, replyTo, attachmentIds,
          clientMessageId, payloadHash);
        // A concurrent first attempt may have committed between the status
        // check and the transaction. Return its canonical row to this socket;
        // do not broadcast or notify it a second time.
        if (saved.replayed) {
          send(conn.ws, { type: "message", message: saved.message,
            ...(frame.tempId ? { tempId: frame.tempId } : {}),
            ...(frame.requestId ? { requestId: frame.requestId } : {}) });
        }
        // A draft is cleared only after postMessage has accepted and stored the
        // message. The Store method commits both rows together; postMessage
        // broadcasts the resulting correlated removal to other devices.
        break;
      }
      case "messageStatus": {
        if (conn.client === "engine") throw new Error("message status is only available to human windows");
        const row = this.store.messageSendStatus(conn.userId, frame.clientMessageId, frame.messageId);
        if (!row) throw new Error("that accepted message is not available");
        const message = this.store.message(row.messageId);
        if (!message || message.authorId !== conn.userId) throw new Error("that accepted message is not available");
        // The send ledger is intentionally durable across reconnects, but it
        // is not a channel-access grant.  An author who has since left (or was
        // removed from) the conversation must not use a lost-ack query to
        // recover old DM recipient identities or any other status projection.
        const channel = this.store.channel(message.channelId);
        if (!channel || !channel.memberIds.includes(conn.userId)) {
          throw new Error("that accepted message is not available");
        }
        send(conn.ws, { type: "messageStatus", status: this.messageStatusFor(conn.userId, message), requestId: frame.requestId });
        break;
      }
      case "messageReceipt":
      case "humanReceipt":
        this.handleHumanReceipt(conn, frame);
        break;
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
          ...(frame.responseTriggerMessageId ? { responseTriggerMessageId: frame.responseTriggerMessageId } : {}),
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
        this.tellWorkflow(conn.userId, workflow, frame.requestId, conn);
        break;
      }
      case "updateWorkflow": {
        if (conn.userId !== this.ownerId) throw new Error("only the owner can edit workflows");
        const current = this.myWorkflow(conn.userId, frame.workflowId);
        // The wire patch is hostile input. Only builder-owned fields may change;
        // identity, archive state, version, and timestamps always come from the
        // stored row and this relay.
        const patch = frame.patch as Partial<Workflow>;
        const next: Workflow = {
          ...current,
          ...(typeof patch.name === "string" ? { name: patch.name } : {}),
          ...(Object.prototype.hasOwnProperty.call(patch, "description")
            ? { description: typeof patch.description === "string" ? patch.description : undefined }
            : {}),
          ...(typeof patch.channelId === "string" ? { channelId: patch.channelId } : {}),
          ...(typeof patch.enabled === "boolean" ? { enabled: patch.enabled } : {}),
          ...(Array.isArray(patch.steps) ? { steps: patch.steps } : {}),
          id: current.id,
          ownerId: current.ownerId,
          archivedAt: current.archivedAt,
          createdAt: current.createdAt,
          version: current.version + 1,
          updatedAt: Date.now(),
        };
        const bad = validateWorkflow(next);
        if (bad) throw new Error(bad);
        this.channelFor(conn.userId, next.channelId);
        this.workflowAgents(conn.userId, next);
        this.store.saveWorkflow(next);
        this.audit(conn, "workflow_updated", next.id, "updated workflow " + next.name);
        this.tellWorkflow(conn.userId, next, frame.requestId, conn);
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
        this.tellWorkflow(conn.userId, next, frame.requestId, conn);
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
        this.tellWorkflowRun(conn.userId, run, frame.requestId, conn);
        this.startWorkflowStep(conn, run, workflow, run.steps[0].id);
        break;
      }
      case "stopWorkflow": {
        if (conn.userId !== this.ownerId) throw new Error("only the owner can stop workflows");
        const run = this.store.workflowRun(frame.workflowRunId);
        if (!run || run.ownerId !== conn.userId) throw new Error("no such workflow run");
        if (["succeeded", "failed", "stopped", "interrupted"].includes(run.status)) {
          this.tellWorkflowRun(conn.userId, run, frame.requestId, conn);
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
        this.persistWorkflowRun(run, frame.requestId, conn);
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
        const pulseUsers = new Set<ID>();
        const live = new Set(this.store.channel(ch.id)!.memberIds);
        for (const memberId of new Set(frame.memberIds)) {
          // AN AGENT CARRIES ITS OWNER IN WITH IT — the same rule creating a
          // room asks, asked here by the same function.
          this.assertMayAdd(conn.userId, [memberId], live);
          this.store.addChannelMember(ch.id, memberId, { role: "member", invitedBy: conn.userId });
          live.add(memberId);
          const agent = this.store.agents().find(candidate => candidate.id === memberId);
          pulseUsers.add(agent?.ownerId ?? memberId);
        }
        this.pushArtifactProjectionDiff(beforeArtifacts, artifactIds);
        this.audit(conn, "member_added", ch.id, `added ${frame.memberIds.length} member(s) to ${ch.name}`);
        this.broadcastChannel(this.store.channel(ch.id)!);
        this.refreshNotificationRows(this.store.notificationsForChannel(ch.id));
        for (const memberId of frame.memberIds) {
          const agent = this.store.agents().find(a => a.id === memberId);
          this.tellSaved(agent?.ownerId ?? memberId);
        }
        this.sendPulseSnapshotTo(pulseUsers);
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
      case "channelMemoryPolicies": {
        const ch = this.channelFor(conn.userId, frame.channelId);
        send(conn.ws, {
          type: "channelMemoryPolicies", channelId: ch.id,
          policies: this.store.channelMemoryPolicies(ch.id), requestId: frame.requestId,
        });
        break;
      }
      case "setChannelMemoryPolicy": {
        if (conn.client === "engine") throw new Error("an agent engine cannot change channel memory policy");
        const ch = this.adminChannel(conn.userId, frame.channelId);
        if (!isChannelMemoryMode(frame.mode)) throw new Error("that memory policy is not supported");
        const agent = this.store.agents().find(candidate => candidate.id === frame.agentId);
        if (!agent || !ch.memberIds.includes(agent.id)) throw new Error("that agent is not in this conversation");
        // A room manager can only govern an agent they own. This prevents an
        // admin from changing another person's agent's durable memory merely
        // because both agents happen to share a room.
        if (agent.ownerId !== conn.userId) throw new Error("you can only change memory policy for your own agent");
        const result = this.store.setChannelMemoryPolicy({
          ownerId: conn.userId, actorId: conn.userId, channelId: ch.id, agentId: agent.id,
          mode: frame.mode, expectedRevision: frame.expectedRevision, requestId: frame.requestId,
        });
        const base: ServerFrame = { type: "channelMemoryPolicy", policy: result.policy };
        // Broadcast projections without the originating request id. A second
        // window must converge from the policy itself, never inherit a request
        // id it did not mint.
        this.toChannel(ch, base);
        if (frame.requestId) send(conn.ws, { ...base, requestId: frame.requestId });
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
          // An archived conversation is read-only. End any in-flight preview
          // rather than letting an engine continue projecting into a room that
          // no longer accepts durable agent messages.
          this.clearResponseStreams(stream => stream.channelId === ch.id);
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
        this.tellSaved(conn.userId);
        this.sendPulseSnapshot(conn.userId);
        break;
      }
      case "leaveChannel": {
        const ch = this.channelFor(conn.userId, frame.channelId);
        if (ch.kind === "dm") throw new Error("you can't leave a direct conversation");
        if (!this.store.memberRole(ch.id, conn.userId)) throw new Error("you're not in that conversation");
        const artifactIds = this.artifactIdsInChannel(ch.id);
        const beforeArtifacts = this.snapshotArtifactProjections(artifactIds);
        this.store.removeChannelMember(ch.id, conn.userId, conn.userId);
        this.clearResponseStreams(stream => stream.ownerId === conn.userId && stream.channelId === ch.id);
        this.invalidateHuddlesForMember(conn.userId, ch.id);
        this.audit(conn, "member_removed", ch.id, `left ${ch.name}`);
        this.tellLeft(conn.userId, ch.id);
        this.tellSaved(conn.userId);
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
        const removedAgent = this.store.agents().find(a => a.id === frame.memberId);
        this.clearResponseStreams(stream => stream.channelId === ch.id
          && (stream.agentId === frame.memberId || (!!removedAgent && stream.ownerId === removedAgent.ownerId)));
        this.invalidateHuddlesForMember(frame.memberId, ch.id);
        this.audit(conn, "member_removed", ch.id, `removed someone from ${ch.name}`);
        // an agent's place in a room belongs to its owner's screen
        const agent = removedAgent;
        this.tellLeft(agent ? agent.ownerId : frame.memberId, ch.id);
        this.tellSaved(agent ? agent.ownerId : frame.memberId);
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
        this.broadcastChannelMembers(ch.id);
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
        // Deleting an agent also forgets its run rows. Re-project any durable
        // Canvas blocks that linked those runs so readers see the honest
        // unavailable state instead of a stale owner-only id forever.
        const deletedRunIds = new Set(this.store.runsForAgent(frame.agentId, RUN_RETENTION.perAgent).map(row => row.record.id));
        const affectedCanvasProjects = this.store.projectsAll().filter(project =>
          this.store.canvasesForProject(project.id).some(canvas => canvas.blocks.some(block =>
            block.link?.kind === "run" && deletedRunIds.has(block.link.id))));
        const affectedHuddles = this.store.huddles().filter(h => h.participants.some(p => p.id === frame.agentId));
        this.stopRunsForDeletedAgent(conn, frame.agentId);
        this.clearResponseStreams(stream => stream.agentId === frame.agentId);
        this.store.deleteAgent(frame.agentId);
        for (const before of affectedHuddles) {
          const updated = this.store.huddle(before.id);
          if (!updated) continue;
          this.broadcastHuddle(updated, { type: "huddleChanged", session: updated });
          const project = this.store.project(updated.projectId);
          if (project) this.toUser(existing.ownerId, { type: "huddleChanged", session: this.huddleSessionView(existing.ownerId, updated, project) });
        }
        this.syncHooksToEngine(conn.userId);
        // a deleted agent's lamp is not a fact about anything any more
        delete this.agentStatus[frame.agentId];
        this.audit(conn, "agent_deleted", frame.agentId, `deleted agent ${existing.name}`);
        this.broadcast({ type: "agentDeleted", agentId: frame.agentId });
        for (const project of affectedCanvasProjects) {
          for (const canvas of this.store.canvasesForProject(project.id)) this.pushCanvas(canvas);
        }
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
        this.clearResponseStreams(stream => stream.ownerId === target.id
          || theirAgents.some(agent => agent.id === stream.agentId));
        const affectedArtifacts = this.store.channels()
          .filter(ch => ch.memberIds.includes(target.id))
          .map(ch => {
            const ids = this.artifactIdsInChannel(ch.id);
            return { ids, before: this.snapshotArtifactProjections(ids) };
          });
        const invalidatedHuddles = this.store.huddles().filter(h => {
          const project = this.store.project(h.projectId);
          return project?.ownerId === target.id || h.participants.some(p => p.id === target.id);
        });
        const invalidationAudience = new Map<ID, Set<ID>>();
        for (const huddle of invalidatedHuddles) {
          const project = this.store.project(huddle.projectId);
          const audience = new Set<ID>(project?.ownerId === target.id ? huddle.participants.map(p => p.id) : [target.id]);
          invalidationAudience.set(huddle.id, audience);
          if (project?.ownerId !== target.id && huddle.participants.some(p => p.id === target.id && p.present)) {
            const at = Date.now();
            const updated = { ...huddle, participants: huddle.participants.map(p => p.id === target.id && p.present ? { ...p, present: false, leftAt: at } : p) };
            this.store.huddleLeave(huddle.id, target.id, at);
            this.store.saveHuddle(updated);
            this.broadcastHuddle(updated, { type: "huddleChanged", session: updated });
          }
        }
        this.clearTypingForUser(target.id);
        // Tombstone their project posts BEFORE the account row goes, and push
        // each tombstone to remaining members — same live-feed discipline as
        // socialUnavailable on project leave. Hard-delete would leave open
        // Team feed windows showing words by a person who is already gone.
        const socialTombstones = this.store.tombstoneSocialForRemovedUser(target.id);
        this.store.removeUser(target.id);
        for (const huddle of invalidatedHuddles) for (const userId of invalidationAudience.get(huddle.id) ?? []) this.toUser(userId, { type: "huddleUnavailable", sessionId: huddle.id, problem: "This person is no longer on Cloud9, so their huddle is no longer available." });
        this.toEngines(target.id, { type: "hooksUpdated", hooks: [] });
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
        for (const post of socialTombstones) {
          const project = this.store.project(post.projectId);
          if (!project) continue;
          this.broadcastSocialView(project.id, userId => ({
            type: "socialUpdated", post: this.socialPostView(userId, project, post),
          }));
          this.broadcastSocialUnread(project.id);
        }
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
          ...(frame.causedByHook ? { causedByHook: true } : {}),
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
        if (approval.recoveryRequestId) {
          const key = this.recoveryChallengeKey(approval.ownerId, approval.recoveryRequestId);
          const pending = this.pendingRecovery.get(key);
          if (pending) {
            this.pendingRecovery.delete(key);
            const target = this.store.run(pending.runId);
            const currentAgent = target && target.ownerId === approval.ownerId
              ? this.store.agents().find(a => a.id === pending.agentId) : undefined;
            const currentDecision = target && currentAgent
              ? recoveryDecision(target.record, this.store.checkpointForRun(target.record.id, target.agentId, target.ownerId)) : undefined;
            const currentAction = currentDecision?.actions.find(a => a.mode === pending.payload.mode);
            // Approval is a second boundary: read the current policy/trust and
            // availability again immediately before crossing the engine wire.
            const currentPolicyRequiresApproval = currentAgent ? mustAskBeforeActing(currentAgent) : undefined;
            const policyAllowsApprovedAction = currentPolicyRequiresApproval !== undefined;
            const canExecute = frame.decision === "approved" && !!target && !!currentAgent
              && currentAgent.lifecycle !== "paused" && currentAgent.lifecycle !== "disabled"
              && !!currentAction?.available && policyAllowsApprovedAction && this.hasEngine(approval.ownerId);
            const receipt = this.store.recoveryReceipt(approval.ownerId, pending.requestId);
            this.store.saveRecoveryReceipt({
              request: pending, payloadFingerprint: recoveryRequestFingerprint(pending),
              status: canExecute ? "accepted" : "refused",
              ...(canExecute ? {} : { reason: frame.decision === "rejected" ? "rejected by owner" : !this.hasEngine(approval.ownerId) ? "the agent engine is not connected" : "the recovery action is no longer available" }),
              createdAt: receipt?.createdAt ?? Date.now(),
            });
            if (currentDecision) {
              this.toUser(approval.ownerId, {
                type: "runRecovery", runId: pending.runId, decision: currentDecision,
                requestId: pending.requestId, pending: false,
                ...(!canExecute ? { problem: frame.decision === "rejected" ? "Recovery approval was rejected." : !this.hasEngine(approval.ownerId) ? "The agent engine is not connected. Recovery did not start." : "Recovery is no longer available." } : {}),
              });
            }
            if (canExecute && target && currentAgent) {
              // The approval is fresh, and the current action/policy is checked
              // again immediately before the side effect crosses the engine wire.
              this.toEngines(target.ownerId, {
                type: "runRecoveryRequested",
                request: { ...pending, payload: { ...pending.payload, approvalEpoch: "" } },
              });
            }
          }
        }
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
        const records = this.store.activity(frame.before ?? Date.now() + 1, frame.limit ?? 100)
          .filter(r => this.canSeeActivity(conn.userId, r));
        send(conn.ws, { type: "activity", records });
        break;
      }
      // ---- huddles: presence/shared notes only; no audio/video/calls ----
      case "huddleProjects": {
        send(conn.ws, { type: "huddleProjects", projects: this.store.huddleProjects(conn.userId), ...(frame.requestId ? { requestId: frame.requestId } : {}) }); break;
      }
      case "huddleList": {
        const sessions = this.store.huddles(frame.projectId).filter(s => { try { this.huddleFor(conn.userId, s.id); return true; } catch { return false; } }).map(s => {
          const project = this.store.project(s.projectId)!; return this.huddleSessionView(conn.userId, s, project);
        });
        send(conn.ws, { type: "huddleList", sessions, ...(frame.requestId ? { requestId: frame.requestId } : {}) }); break;
      }
      case "huddleOpen": {
        const { session, project } = this.huddleFor(conn.userId, frame.sessionId);
        if (this.huddleReplay(conn, frame, "open", session.id)) break;
        send(conn.ws, { type: "huddleSession", session: this.huddleSessionView(conn.userId, session, project), notes: this.store.huddleNotes(session.id).map(n => this.huddleNoteView(conn.userId, project, n)), ...(frame.requestId ? { requestId: frame.requestId } : {}) }); break;
      }
      case "huddleStart": {
        const project = this.huddleProject(conn.userId, frame.projectId);
        if (this.huddleReplay(conn, frame, "start", project.id)) break;
        const bad = validateHuddleText(frame.title, "title") || validateHuddleText(frame.agenda, "agenda"); if (bad) throw new Error(bad);
        if (frame.channelId && frame.channelId !== project.channelId) throw new Error("huddle channel must match project channel");
        const user = this.store.users().find(u => u.id === conn.userId)!; const now = Date.now();
        const participant: HuddleParticipant = { id: user.id, name: user.name, kind: "human", joinedAt: now, present: true };
        const session: HuddleSession = { id: newId("huddle"), projectId: project.id, channelId: project.channelId, title: frame.title.trim(), agenda: frame.agenda.trim(), ownerId: user.id, state: "active", startedAt: now, participants: [participant], unread: 0 };
        this.store.huddleMutation(() => { this.store.saveHuddle(session); this.store.huddleJoin(session.id, user.id, now); }, this.huddleReceipt(conn, frame, "start", project.id, session.id));
        this.broadcastHuddle(session, { type: "huddleChanged", session }, true, conn);
        send(conn.ws, { type: "huddleSession", session: this.huddleSessionView(conn.userId, session, project), notes: [], ...(frame.requestId ? { requestId: frame.requestId } : {}) }); break;
      }
      case "huddleJoin": {
        const { session } = this.huddleFor(conn.userId, frame.sessionId); if (this.huddleReplay(conn, frame, "join", session.id)) break;
        if (session.state !== "active") throw new Error("this huddle has ended"); const user = this.store.users().find(u => u.id === conn.userId)!; const now = Date.now();
        const participants = session.participants.filter(p => p.id !== user.id); participants.push({ id: user.id, name: user.name, kind: "human", joinedAt: now, present: true });
        const updated = { ...session, participants: participants.sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id)) };
        this.store.huddleMutation(() => { this.store.huddleJoin(session.id, user.id, now); this.store.saveHuddle(updated); }, this.huddleReceipt(conn, frame, "join", session.id, session.id));
        this.broadcastHuddle(updated, { type: "huddleChanged", session: updated, ...(frame.requestId ? { requestId: frame.requestId } : {}) }, false, conn); break;
      }
      case "huddleLeave": {
        const { session } = this.huddleFor(conn.userId, frame.sessionId); if (this.huddleReplay(conn, frame, "leave", session.id)) break;
        if (session.state !== "active") throw new Error("this huddle has ended");
        const now = Date.now(); const participants = session.participants.map(p => p.id === conn.userId && p.present ? { ...p, leftAt: now, present: false } : p); const updated = { ...session, participants };
        this.store.huddleMutation(() => { this.store.huddleLeave(session.id, conn.userId, now); this.store.saveHuddle(updated); }, this.huddleReceipt(conn, frame, "leave", session.id, session.id));
        this.broadcastHuddle(updated, { type: "huddleChanged", session: updated, ...(frame.requestId ? { requestId: frame.requestId } : {}) }, false, conn); break;
      }
      case "huddleEnd": {
        const { session } = this.huddleFor(conn.userId, frame.sessionId); if (this.huddleReplay(conn, frame, "end", session.id)) break;
        if (session.ownerId !== conn.userId) throw new Error("only the huddle owner can end it");
        if (session.state === "ended") { const project = this.store.project(session.projectId); this.store.huddleMutation(() => undefined, this.huddleReceipt(conn, frame, "end", session.id, session.id)); if (project) send(conn.ws, { type: "huddleSession", session: this.huddleSessionView(conn.userId, session, project), notes: this.store.huddleNotes(session.id).map(n => this.huddleNoteView(conn.userId, project, n)), ...(frame.requestId ? { requestId: frame.requestId } : {}) }); break; }
        const endedAt = Date.now(); const updated = { ...session, state: "ended" as const, endedAt, participants: session.participants.map(p => p.present ? { ...p, present: false, leftAt: endedAt } : p) };
        this.store.huddleMutation(() => { for (const participant of session.participants) if (participant.present) this.store.huddleLeave(session.id, participant.id, endedAt); this.store.saveHuddle(updated); }, this.huddleReceipt(conn, frame, "end", session.id, session.id));
        this.broadcastHuddle(updated, { type: "huddleChanged", session: updated, ...(frame.requestId ? { requestId: frame.requestId } : {}) }, false, conn); break;
      }
      case "huddleNote": {
        const { session, project } = this.huddleFor(conn.userId, frame.sessionId); if (this.huddleReplay(conn, frame, "note", session.id)) break;
        if (!["note", "decision", "action"].includes(frame.kind)) throw new Error("invalid huddle note kind");
        const bad = validateHuddleText(frame.body, "note") || validateHuddleLinks(frame.links ?? []); if (bad) throw new Error(bad); this.huddleLinks(conn.userId, project, frame.links ?? []);
        const user = this.store.users().find(u => u.id === conn.userId)!; const note: HuddleNote = { id: newId("hnote"), sessionId: session.id, kind: frame.kind, body: frame.body.trim(), authorId: user.id, authorName: user.name, authorKind: "human", createdAt: Date.now(), links: frame.links ?? [] };
        this.store.huddleMutation(() => this.store.saveHuddleNote(note), this.huddleReceipt(conn, frame, "note", session.id, note.id));
        this.broadcastHuddle(session, { type: "huddleChanged", session, note, ...(frame.requestId ? { requestId: frame.requestId } : {}) }, false, conn); break;
      }
      case "agentHuddleNote": {
        if (conn.client !== "engine") throw new Error("only an agent host can write as an agent"); const agent = this.myAgent(conn.userId, frame.agentId); const knownAgents = this.huddleEngineAgents.get(conn.ws) ?? new Set<ID>(); knownAgents.add(agent.id); this.huddleEngineAgents.set(conn.ws, knownAgents); const { session, project } = this.huddleFor(conn.userId, frame.sessionId); if (this.huddleReplay(conn, frame, "agent-note", session.id)) break;
        if (!["note", "decision", "action"].includes(frame.kind)) throw new Error("invalid huddle note kind");
        const bad = validateHuddleText(frame.body, "note") || validateHuddleLinks(frame.links ?? []); if (bad) throw new Error(bad); this.huddleLinks(conn.userId, project, frame.links ?? []);
        const now = Date.now(); const participants = session.participants.some(p => p.id === agent.id) ? session.participants.map(p => p.id === agent.id ? { ...p, name: agent.name, present: true, joinedAt: now, leftAt: undefined } : p) : [...session.participants, { id: agent.id, name: agent.name, kind: "agent" as const, joinedAt: now, present: true }]; const updated = { ...session, participants: participants.sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id)) };
        const note: HuddleNote = { id: newId("hnote"), sessionId: session.id, kind: frame.kind, body: frame.body.trim(), authorId: agent.id, authorName: agent.name, authorKind: "agent", createdAt: now, links: frame.links ?? [] };
        this.store.huddleMutation(() => { this.store.saveHuddle(updated); this.store.huddleJoin(session.id, agent.id, now); this.store.saveHuddleNote(note); }, this.huddleReceipt(conn, frame, "agent-note", session.id, note.id));
        this.broadcastHuddle(updated, { type: "huddleChanged", session: updated, note, ...(frame.requestId ? { requestId: frame.requestId } : {}) }, false, conn); break;
      }
      case "huddleDeleteNote": {
        const note = this.store.huddleNote(frame.noteId); if (!note) throw new Error("no such huddle note"); const { session } = this.huddleFor(conn.userId, note.sessionId); if (this.huddleReplay(conn, frame, "delete-note", note.id)) break;
        if (note.authorId !== conn.userId && session.ownerId !== conn.userId) throw new Error("only the note author or huddle owner can delete this");
        const deleted = note.deletedAt ? note : { ...note, body: "This note was deleted.", deletedAt: Date.now() };
        this.store.huddleMutation(() => this.store.saveHuddleNote(deleted, true), this.huddleReceipt(conn, frame, "delete-note", note.id, note.id));
        this.broadcastHuddle(session, { type: "huddleChanged", session, note: deleted, ...(frame.requestId ? { requestId: frame.requestId } : {}) }, false, conn); break;
      }
      case "huddleMarkRead": {
        const { session } = this.huddleFor(conn.userId, frame.sessionId); if (this.huddleReplay(conn, frame, "read", session.id)) break;
        const at = typeof frame.ts === "number" && Number.isFinite(frame.ts) ? Math.min(Math.max(0, frame.ts), Date.now()) : Date.now(); const entry = this.store.huddleMutation(() => this.store.huddleMarkRead(conn.userId, session.id, at), this.huddleReceipt(conn, frame, "read", session.id, session.id));
        send(conn.ws, { type: "huddleRead", entry, ...(frame.requestId ? { requestId: frame.requestId } : {}) });
        for (const c of this.conns) if (c.userId === conn.userId && c !== conn) send(c.ws, { type: "huddleRead", entry });
        break;
      }
      case "huddleMembers": {
        const { session } = this.huddleFor(conn.userId, frame.sessionId); if (this.huddleReplay(conn, frame, "members", session.id)) break;
        const entry = this.store.huddleMutation(() => undefined, this.huddleReceipt(conn, frame, "members", session.id, session.id));
        void entry; send(conn.ws, { type: "huddleMembers", sessionId: session.id, participants: session.participants, ...(frame.requestId ? { requestId: frame.requestId } : {}) }); break;
      }

      // ---- public project updates: Cloud9-owned route only, explicit owner publish ----
      // Law: humans on desktop approve/publish/create/edit/revoke. Agents may only draft.
      // Actor is gated (engine refused), not content authorKind — agent drafts need human approval.
      case "publicUpdates": {
        const drafts = this.store.publicDrafts(frame.projectId).filter(d => {
          try { this.myProject(conn.userId, d.projectId); return true; } catch { return false; }
        });
        send(conn.ws, { type: "publicUpdates", drafts });
        break;
      }
      case "publicUpdate": {
        const { draft } = this.publicDraft(conn.userId, frame.draftId);
        send(conn.ws, {
          type: "publicUpdate", draft,
          revisions: this.store.publicRevisions(draft.id),
          audit: this.store.publicAudit(draft.id),
        });
        break;
      }
      case "publicCreate": {
        this.requirePublicHumanDesktop(conn, "create a public update");
        const project = this.myProject(conn.userId, frame.projectId);
        const bad = validatePublicUpdateText(frame.title, "title")
          || validatePublicUpdateText(frame.summary, "summary")
          || validatePublicUpdateText(frame.body, "body")
          || validatePublicUpdateLinks(frame.changelogLinks ?? []);
        if (bad) throw new Error(bad);
        this.publicLinks(conn.userId, project, frame.changelogLinks ?? []);
        const user = this.store.users().find(u => u.id === conn.userId)!;
        const now = Date.now();
        const draft: PublicUpdateDraft = {
          id: newId("pub"), projectId: project.id,
          title: frame.title.trim(), summary: frame.summary.trim(), body: frame.body.trim(),
          changelogLinks: frame.changelogLinks ?? [],
          authorId: user.id, authorName: user.name, authorKind: "human",
          state: "draft", createdAt: now, updatedAt: now,
        };
        this.store.savePublicDraft(draft);
        this.store.savePublicAudit({ id: newId("paudit"), draftId: draft.id, action: "created", actorId: conn.userId, at: now });
        send(conn.ws, { type: "publicUpdate", draft, revisions: [], audit: this.store.publicAudit(draft.id) });
        break;
      }
      case "agentPublicDraft": {
        if (conn.client !== "engine") throw new Error("only an agent host can draft");
        const agent = this.myAgent(conn.userId, frame.agentId);
        const project = this.myProject(conn.userId, frame.projectId);
        const bad = validatePublicUpdateText(frame.title, "title")
          || validatePublicUpdateText(frame.summary, "summary")
          || validatePublicUpdateText(frame.body, "body")
          || validatePublicUpdateLinks(frame.changelogLinks ?? []);
        if (bad) throw new Error(bad);
        this.publicLinks(conn.userId, project, frame.changelogLinks ?? []);
        const now = Date.now();
        const draft: PublicUpdateDraft = {
          id: newId("pub"), projectId: project.id,
          title: frame.title.trim(), summary: frame.summary.trim(), body: frame.body.trim(),
          changelogLinks: frame.changelogLinks ?? [],
          authorId: agent.id, authorName: agent.name, authorKind: "agent",
          state: "draft", createdAt: now, updatedAt: now,
        };
        this.store.savePublicDraft(draft);
        this.store.savePublicAudit({ id: newId("paudit"), draftId: draft.id, action: "created", actorId: agent.id, at: now });
        this.toUser(conn.userId, { type: "publicUpdate", draft, revisions: [], audit: this.store.publicAudit(draft.id) });
        break;
      }
      case "publicEdit": {
        this.requirePublicHumanDesktop(conn, "edit a public update");
        const { draft, project } = this.publicDraft(conn.userId, frame.draftId);
        if (draft.state === "published" || draft.state === "revoked") {
          throw new Error("published updates cannot be edited");
        }
        const bad = validatePublicUpdateText(frame.title, "title")
          || validatePublicUpdateText(frame.summary, "summary")
          || validatePublicUpdateText(frame.body, "body")
          || validatePublicUpdateLinks(frame.changelogLinks ?? []);
        if (bad) throw new Error(bad);
        this.publicLinks(conn.userId, project, frame.changelogLinks ?? []);
        // Edit always returns to draft and clears approval — re-approve required.
        const updated: PublicUpdateDraft = {
          ...draft,
          title: frame.title.trim(), summary: frame.summary.trim(), body: frame.body.trim(),
          changelogLinks: frame.changelogLinks ?? [],
          state: "draft",
          updatedAt: Date.now(),
          approvedAt: undefined,
          approvedBy: undefined,
        };
        this.store.savePublicDraft(updated);
        this.store.savePublicAudit({ id: newId("paudit"), draftId: updated.id, action: "edited", actorId: conn.userId, at: updated.updatedAt });
        send(conn.ws, {
          type: "publicUpdate", draft: updated,
          revisions: this.store.publicRevisions(updated.id),
          audit: this.store.publicAudit(updated.id),
        });
        break;
      }
      case "publicApprove": {
        this.requirePublicHumanDesktop(conn, "approve a public update");
        const { draft } = this.publicDraft(conn.userId, frame.draftId);
        // Gate the ACTOR (engine refused above), not authorKind — agent drafts are human-approvable.
        if (draft.state !== "draft") throw new Error("only a draft can be approved");
        const now = Date.now();
        const updated: PublicUpdateDraft = {
          ...draft, state: "approved", approvedAt: now, approvedBy: conn.userId, updatedAt: now,
        };
        this.store.savePublicDraft(updated);
        this.store.savePublicAudit({ id: newId("paudit"), draftId: updated.id, action: "approved", actorId: conn.userId, at: now });
        send(conn.ws, {
          type: "publicUpdate", draft: updated,
          revisions: this.store.publicRevisions(updated.id),
          audit: this.store.publicAudit(updated.id),
        });
        break;
      }
      case "publicPublish": {
        this.requirePublicHumanDesktop(conn, "publish a public update");
        const { draft } = this.publicDraft(conn.userId, frame.draftId);
        if (draft.state !== "approved" || draft.approvedBy !== conn.userId) {
          throw new Error("owner approval is required before publish");
        }
        const now = Date.now();
        const revision = (draft.revision ?? 0) + 1;
        const rev: PublicUpdateRevision = {
          id: newId("pubrev"), draftId: draft.id, revision,
          title: draft.title, summary: draft.summary, body: draft.body,
          changelogLinks: draft.changelogLinks,
          publishedAt: now, publishedBy: conn.userId, immutable: true,
        };
        this.store.savePublicRevision(rev);
        const token = draft.publicToken ?? secureToken();
        const updated: PublicUpdateDraft = {
          ...draft, state: "published", publishedAt: now, publicToken: token,
          revision, updatedAt: now,
        };
        this.store.savePublicDraft(updated);
        this.store.savePublicAudit({
          id: newId("paudit"), draftId: draft.id, action: "published",
          actorId: conn.userId, at: now, revision,
        });
        const publicPath = `/public/update/${encodeURIComponent(token)}`;
        send(conn.ws, { type: "publicPublished", revision: rev, token, publicPath });
        send(conn.ws, {
          type: "publicUpdate", draft: updated,
          revisions: this.store.publicRevisions(updated.id),
          audit: this.store.publicAudit(updated.id),
        });
        break;
      }
      case "publicRevoke": {
        this.requirePublicHumanDesktop(conn, "revoke a public update");
        const { draft } = this.publicDraft(conn.userId, frame.draftId);
        if (draft.state !== "published") throw new Error("only a published update can be revoked");
        const now = Date.now();
        const updated: PublicUpdateDraft = {
          ...draft, state: "revoked", revokedAt: now, updatedAt: now,
        };
        this.store.savePublicDraft(updated);
        this.store.savePublicAudit({ id: newId("paudit"), draftId: draft.id, action: "revoked", actorId: conn.userId, at: now });
        send(conn.ws, {
          type: "publicUpdate", draft: updated,
          revisions: this.store.publicRevisions(updated.id),
          audit: this.store.publicAudit(updated.id),
        });
        break;
      }
      case "publicRoute": {
        // Authenticated echo of the public surface (for internal checks).
        // Real public readers use GET /public/update/:token — no sign-in.
        const revision = this.store.publicByToken(frame.token);
        send(conn.ws, revision
          ? { type: "publicRoute", revision }
          : { type: "publicRoute", problem: "that public update is unavailable" });
        break;
      }

      // ---- project forums / decision threads ----
      case "forumProjects": {
        send(conn.ws, {
          type: "forumProjects",
          projects: this.store.forumProjectsOf(conn.userId).map(p => this.forumProjectView(p)),
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        break;
      }
      case "forumList": {
        const project = this.forumProject(conn.userId, frame.projectId);
        const page = this.store.forumTopics(project.id, frame.before, frame.beforeId, frame.limit ?? 50);
        send(conn.ws, {
          type: "forumFeed", projectId: project.id,
          topics: page.items.map(t => this.forumTopicView(conn.userId, t)),
          hasMore: page.hasMore, nextBefore: page.nextBefore, nextBeforeId: page.nextBeforeId,
          unread: this.store.forumUnread(conn.userId, project.id),
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        break;
      }
      case "forumOpen": {
        const topic = this.store.forumTopicFor(conn.userId, frame.topicId);
        if (!topic) throw new Error("no such forum topic");
        this.forumSnapshot(conn, topic, frame.requestId);
        break;
      }
      case "forumTopic": {
        const project = this.forumProject(conn.userId, frame.projectId);
        if (this.forumReplay(conn, frame.requestId, "topic", project.id, project.id, this.forumPayloadHash(frame))) break;
        const badT = validateForumText(frame.title, "title") || validateForumText(frame.body, "body")
          || validateForumTags(frame.tags ?? []) || validateForumLinks(frame.links ?? []);
        if (badT) throw new Error(badT);
        this.validateForumLinks(conn.userId, project, frame.links ?? []);
        const user = this.store.users().find(u => u.id === conn.userId)!;
        const now = Date.now();
        const topic: ForumTopic = {
          id: newId("forum"), projectId: project.id, title: frame.title.trim(), body: frame.body.trim(),
          authorId: user.id, authorName: user.name, authorKind: "human",
          createdAt: now, updatedAt: now, status: "open",
          tags: (frame.tags ?? []).map(t => t.trim()), links: frame.links ?? [], replyCount: 0,
        };
        this.store.forumMutation(
          () => { this.store.saveForumTopic(topic); },
          this.forumReceipt(conn, frame, { projectId: project.id, targetId: project.id, kind: "topic", resultId: topic.id }),
        );
        this.broadcastForum(project.id, {
          type: "forumChanged", projectId: project.id, topic,
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        this.forumSnapshot(conn, topic, frame.requestId);
        break;
      }
      case "agentForumTopic": {
        if (conn.client !== "engine") throw new Error("only an agent host can write as an agent");
        const agent = this.myAgent(conn.userId, frame.agentId);
        const project = this.forumProject(conn.userId, frame.projectId);
        if (this.forumReplay(conn, frame.requestId, "topic", project.id, project.id, this.forumPayloadHash(frame))) break;
        const badT = validateForumText(frame.title, "title") || validateForumText(frame.body, "body")
          || validateForumTags(frame.tags ?? []) || validateForumLinks(frame.links ?? []);
        if (badT) throw new Error(badT);
        this.validateForumLinks(conn.userId, project, frame.links ?? []);
        const now = Date.now();
        const topic: ForumTopic = {
          id: newId("forum"), projectId: project.id, title: frame.title.trim(), body: frame.body.trim(),
          authorId: agent.id, authorName: agent.name, authorKind: "agent",
          createdAt: now, updatedAt: now, status: "open",
          tags: (frame.tags ?? []).map(t => t.trim()), links: frame.links ?? [], replyCount: 0,
        };
        this.store.forumMutation(
          () => { this.store.saveForumTopic(topic); },
          this.forumReceipt(conn, frame, { projectId: project.id, targetId: project.id, kind: "topic", resultId: topic.id }),
        );
        this.broadcastForum(project.id, {
          type: "forumChanged", projectId: project.id, topic,
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        this.forumSnapshot(conn, topic, frame.requestId);
        break;
      }
      case "forumReply": {
        const topic = this.store.forumTopicFor(conn.userId, frame.topicId);
        if (!topic) throw new Error("no such forum topic");
        if (topic.deletedAt) throw new Error("that forum topic was deleted");
        const project = this.forumProject(conn.userId, topic.projectId);
        if (this.forumReplay(conn, frame.requestId, "reply", project.id, topic.id, this.forumPayloadHash(frame))) break;
        const badT = validateForumText(frame.body, "body") || validateForumLinks(frame.links ?? []);
        if (badT) throw new Error(badT);
        this.validateForumLinks(conn.userId, project, frame.links ?? []);
        if (frame.parentId) {
          const parent = this.store.forumReply(frame.parentId);
          if (!parent || parent.topicId !== topic.id || parent.deletedAt) throw new Error("that reply is outside this topic");
        }
        const user = this.store.users().find(u => u.id === conn.userId)!;
        const now = Date.now();
        const reply: ForumReply = {
          id: newId("freply"), topicId: topic.id, ...(frame.parentId ? { parentId: frame.parentId } : {}),
          body: frame.body.trim(), authorId: user.id, authorName: user.name, authorKind: "human",
          createdAt: now, updatedAt: now, links: frame.links ?? [],
        };
        const updatedTopic: ForumTopic = {
          ...topic, replyCount: topic.replyCount + 1, updatedAt: now,
        };
        this.store.forumMutation(() => {
          this.store.saveForumReply(reply);
          this.store.saveForumTopic(updatedTopic);
        }, this.forumReceipt(conn, frame, { projectId: project.id, targetId: topic.id, kind: "reply", resultId: reply.id }));
        this.broadcastForum(project.id, {
          type: "forumChanged", projectId: project.id, topic: updatedTopic, reply,
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        this.forumSnapshot(conn, updatedTopic, frame.requestId);
        break;
      }
      case "agentForumReply": {
        if (conn.client !== "engine") throw new Error("only an agent host can write as an agent");
        const agent = this.myAgent(conn.userId, frame.agentId);
        const topic = this.store.forumTopicFor(conn.userId, frame.topicId);
        if (!topic) throw new Error("no such forum topic");
        if (topic.deletedAt) throw new Error("that forum topic was deleted");
        const project = this.forumProject(conn.userId, topic.projectId);
        if (this.forumReplay(conn, frame.requestId, "reply", project.id, topic.id, this.forumPayloadHash(frame))) break;
        const badT = validateForumText(frame.body, "body") || validateForumLinks(frame.links ?? []);
        if (badT) throw new Error(badT);
        this.validateForumLinks(conn.userId, project, frame.links ?? []);
        if (frame.parentId) {
          const parent = this.store.forumReply(frame.parentId);
          if (!parent || parent.topicId !== topic.id || parent.deletedAt) throw new Error("that reply is outside this topic");
        }
        const now = Date.now();
        const reply: ForumReply = {
          id: newId("freply"), topicId: topic.id, ...(frame.parentId ? { parentId: frame.parentId } : {}),
          body: frame.body.trim(), authorId: agent.id, authorName: agent.name, authorKind: "agent",
          createdAt: now, updatedAt: now, links: frame.links ?? [],
        };
        const updatedTopic: ForumTopic = { ...topic, replyCount: topic.replyCount + 1, updatedAt: now };
        this.store.forumMutation(() => {
          this.store.saveForumReply(reply);
          this.store.saveForumTopic(updatedTopic);
        }, this.forumReceipt(conn, frame, { projectId: project.id, targetId: topic.id, kind: "reply", resultId: reply.id }));
        this.broadcastForum(project.id, {
          type: "forumChanged", projectId: project.id, topic: updatedTopic, reply,
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        this.forumSnapshot(conn, updatedTopic, frame.requestId);
        break;
      }
      case "forumEditTopic": {
        const topic = this.store.forumTopicFor(conn.userId, frame.topicId);
        if (!topic) throw new Error("no such forum topic");
        if (topic.deletedAt) throw new Error("that forum topic was deleted");
        const project = this.forumProject(conn.userId, topic.projectId);
        if (this.forumReplay(conn, frame.requestId, "edit-topic", project.id, topic.id, this.forumPayloadHash(frame))) break;
        if (topic.authorId !== conn.userId && project.ownerId !== conn.userId) {
          throw new Error("only the author or project owner can edit this");
        }
        const badT = (frame.title !== undefined ? validateForumText(frame.title, "title") : null)
          || (frame.body !== undefined ? validateForumText(frame.body, "body") : null)
          || (frame.tags !== undefined ? validateForumTags(frame.tags) : null)
          || (frame.links !== undefined ? validateForumLinks(frame.links) : null);
        if (badT) throw new Error(badT);
        if (frame.links) this.validateForumLinks(conn.userId, project, frame.links);
        const updated: ForumTopic = {
          ...topic,
          ...(frame.title !== undefined ? { title: frame.title.trim() } : {}),
          ...(frame.body !== undefined ? { body: frame.body.trim() } : {}),
          ...(frame.tags !== undefined ? { tags: frame.tags.map(t => t.trim()) } : {}),
          ...(frame.links !== undefined ? { links: frame.links } : {}),
          updatedAt: Date.now(),
        };
        this.store.forumMutation(
          () => { this.store.saveForumTopic(updated); },
          this.forumReceipt(conn, frame, { projectId: project.id, targetId: topic.id, kind: "edit-topic", resultId: topic.id }),
        );
        this.broadcastForum(project.id, {
          type: "forumChanged", projectId: project.id, topic: updated,
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        break;
      }
      case "forumEditReply": {
        const reply = this.store.forumReplyFor(conn.userId, frame.replyId);
        if (!reply) throw new Error("no such forum reply");
        if (reply.deletedAt) throw new Error("that forum reply was deleted");
        const topic = this.store.forumTopicFor(conn.userId, reply.topicId);
        if (!topic) throw new Error("no such forum topic");
        if (topic.deletedAt) throw new Error("that forum topic was deleted");
        const project = this.forumProject(conn.userId, topic.projectId);
        if (this.forumReplay(conn, frame.requestId, "edit-reply", project.id, reply.id, this.forumPayloadHash(frame))) break;
        if (reply.authorId !== conn.userId && project.ownerId !== conn.userId) {
          throw new Error("only the author or project owner can edit this");
        }
        const badT = validateForumText(frame.body, "body") || validateForumLinks(frame.links ?? []);
        if (badT) throw new Error(badT);
        if (frame.links) this.validateForumLinks(conn.userId, project, frame.links);
        const updated = {
          ...reply, body: frame.body.trim(),
          links: frame.links ?? reply.links, updatedAt: Date.now(),
        };
        this.store.forumMutation(
          () => { this.store.saveForumReply(updated); },
          this.forumReceipt(conn, frame, { projectId: project.id, targetId: reply.id, kind: "edit-reply", resultId: reply.id }),
        );
        this.broadcastForum(project.id, {
          type: "forumChanged", projectId: project.id, reply: updated,
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        break;
      }
      case "forumDeleteTopic": {
        const topic = this.store.forumTopicFor(conn.userId, frame.topicId);
        if (!topic) throw new Error("no such forum topic");
        const project = this.forumProject(conn.userId, topic.projectId);
        if (this.forumReplay(conn, frame.requestId, "delete-topic", project.id, topic.id, this.forumPayloadHash(frame))) break;
        if (topic.deletedAt) {
          if (frame.requestId) {
            this.store.forumMutation(
              () => undefined,
              this.forumReceipt(conn, frame, { projectId: project.id, targetId: topic.id, kind: "delete-topic", resultId: topic.id }),
            );
          }
          break;
        }
        if (topic.authorId !== conn.userId && project.ownerId !== conn.userId) {
          throw new Error("only the author or project owner can delete this");
        }
        // Soft-delete redacts the decision residue too: summary, tags, links.
        const deleted: ForumTopic = {
          ...topic,
          title: "Deleted topic",
          body: "This topic was deleted.",
          tags: [],
          links: [],
          decisionSummary: undefined,
          acceptedReplyId: undefined,
          deletedAt: Date.now(),
          updatedAt: Date.now(),
        };
        this.store.forumMutation(
          () => { this.store.saveForumTopic(deleted); },
          this.forumReceipt(conn, frame, { projectId: project.id, targetId: topic.id, kind: "delete-topic", resultId: topic.id }),
        );
        this.audit(conn, "forum_topic_deleted", topic.id, `deleted forum topic in ${project.name}`);
        this.broadcastForum(project.id, {
          type: "forumChanged", projectId: project.id, topic: deleted,
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        break;
      }
      case "forumDeleteReply": {
        const reply = this.store.forumReplyFor(conn.userId, frame.replyId);
        if (!reply) throw new Error("no such forum reply");
        const topic = this.store.forumTopicFor(conn.userId, reply.topicId);
        if (!topic) throw new Error("no such forum topic");
        if (topic.deletedAt) throw new Error("that forum topic was deleted");
        const project = this.forumProject(conn.userId, topic.projectId);
        if (this.forumReplay(conn, frame.requestId, "delete-reply", project.id, reply.id, this.forumPayloadHash(frame))) break;
        if (reply.deletedAt) {
          if (frame.requestId) {
            this.store.forumMutation(
              () => undefined,
              this.forumReceipt(conn, frame, { projectId: project.id, targetId: reply.id, kind: "delete-reply", resultId: reply.id }),
            );
          }
          break;
        }
        if (reply.authorId !== conn.userId && project.ownerId !== conn.userId) {
          throw new Error("only the author or project owner can delete this");
        }
        const deleted = {
          ...reply, body: "This reply was deleted.", links: [],
          deletedAt: Date.now(), updatedAt: Date.now(),
        };
        this.store.forumMutation(
          () => { this.store.saveForumReply(deleted); },
          this.forumReceipt(conn, frame, { projectId: project.id, targetId: reply.id, kind: "delete-reply", resultId: reply.id }),
        );
        this.audit(conn, "forum_reply_deleted", reply.id, `deleted forum reply in ${project.name}`);
        this.broadcastForum(project.id, {
          type: "forumChanged", projectId: project.id, reply: deleted,
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        break;
      }
      case "forumSetStatus": {
        const topic = this.store.forumTopicFor(conn.userId, frame.topicId);
        if (!topic) throw new Error("no such forum topic");
        const project = this.forumProject(conn.userId, topic.projectId);
        if (this.forumReplay(conn, frame.requestId, "status", project.id, topic.id, this.forumPayloadHash(frame))) break;
        if (topic.deletedAt) throw new Error("that forum topic was deleted");
        if (!this.validForumStatus(frame.status)) throw new Error("that forum status is invalid");
        if (project.ownerId !== conn.userId) throw new Error("only the project owner can change status");
        const updated = { ...topic, status: frame.status, updatedAt: Date.now() };
        this.store.forumMutation(
          () => { this.store.saveForumTopic(updated); },
          this.forumReceipt(conn, frame, { projectId: project.id, targetId: topic.id, kind: "status", resultId: topic.id }),
        );
        this.audit(conn, "forum_status_changed", topic.id, `forum topic status → ${frame.status} in ${project.name}`);
        this.broadcastForum(project.id, {
          type: "forumChanged", projectId: project.id, topic: updated,
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        break;
      }
      case "forumAcceptReply": {
        const topic = this.store.forumTopicFor(conn.userId, frame.topicId);
        const reply = this.store.forumReplyFor(conn.userId, frame.replyId);
        if (!topic || !reply || reply.topicId !== topic.id || reply.deletedAt) {
          throw new Error("that reply cannot be accepted");
        }
        const project = this.forumProject(conn.userId, topic.projectId);
        if (this.forumReplay(conn, frame.requestId, "accept", project.id, topic.id, this.forumPayloadHash(frame))) break;
        if (topic.deletedAt) throw new Error("that forum topic was deleted");
        if (project.ownerId !== conn.userId) throw new Error("only the project owner can accept an answer");
        const bad = validateForumText(frame.summary, "summary");
        if (bad) throw new Error(bad);
        const updated = {
          ...topic, acceptedReplyId: reply.id, decisionSummary: frame.summary.trim(),
          status: "resolved" as const, updatedAt: Date.now(),
        };
        this.store.forumMutation(
          () => { this.store.saveForumTopic(updated); },
          this.forumReceipt(conn, frame, { projectId: project.id, targetId: topic.id, kind: "accept", resultId: topic.id }),
        );
        this.audit(
          conn, "forum_decision_accepted", topic.id,
          `accepted forum decision in ${project.name}: ${frame.summary.trim().slice(0, 120)}`,
        );
        this.broadcastForum(project.id, {
          type: "forumChanged", projectId: project.id, topic: updated,
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        break;
      }
      case "forumMarkRead": {
        const project = this.forumProject(conn.userId, frame.projectId);
        if (this.forumReplay(conn, frame.requestId, "read", project.id, project.id, this.forumPayloadHash(frame))) break;
        const requested = typeof frame.ts === "number" && Number.isFinite(frame.ts)
          ? Math.min(Math.max(0, frame.ts), Date.now())
          : Date.now();
        const entry = this.store.forumMutation(
          () => this.store.markForumRead(conn.userId, project.id, requested),
          this.forumReceipt(conn, frame, { projectId: project.id, targetId: project.id, kind: "read", resultId: project.id }),
        );
        this.toUser(conn.userId, {
          type: "forumRead", entry,
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        break;
      }
      case "forumMembers": {
        // Any current member may list; receipt kind is list-members (not manage).
        const project = this.forumProject(conn.userId, frame.projectId);
        if (this.forumReplay(conn, frame.requestId, "list-members", project.id, project.id, this.forumPayloadHash(frame))) break;
        if (frame.requestId) {
          this.store.forumMutation(
            () => undefined,
            this.forumReceipt(conn, frame, {
              projectId: project.id, targetId: project.id, kind: "list-members", resultId: project.id,
            }),
          );
        }
        send(conn.ws, {
          type: "forumMembers", projectId: project.id,
          userIds: this.store.forumMembers(project.id),
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        break;
      }
      case "forumAddMember": {
        const project = this.myProject(conn.userId, frame.projectId);
        if (this.forumReplay(conn, frame.requestId, "add-member", project.id, project.id, this.forumPayloadHash(frame))) break;
        if (project.ownerId !== conn.userId) throw new Error("only the project owner can manage forum members");
        if (!this.store.users().some(u => u.id === frame.userId)) throw new Error("no such user");
        this.store.forumMutation(
          () => { this.store.addForumMember(project.id, frame.userId); },
          this.forumReceipt(conn, frame, {
            projectId: project.id, targetId: project.id, kind: "add-member", resultId: project.id,
          }),
        );
        this.audit(conn, "forum_member_added", project.id, `added a member to the forum for ${project.name}`);
        this.toUser(frame.userId, {
          type: "forumProjects",
          projects: this.store.forumProjectsOf(frame.userId).map(p => this.forumProjectView(p)),
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        send(conn.ws, {
          type: "forumMembers", projectId: project.id,
          userIds: this.store.forumMembers(project.id),
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        break;
      }
      case "forumRemoveMember": {
        const project = this.myProject(conn.userId, frame.projectId);
        if (this.forumReplay(conn, frame.requestId, "remove-member", project.id, project.id, this.forumPayloadHash(frame))) break;
        if (project.ownerId !== conn.userId) throw new Error("only the project owner can manage forum members");
        if (frame.userId === project.ownerId) throw new Error("the project owner must remain a member");
        this.store.forumMutation(
          () => { this.store.removeForumMember(project.id, frame.userId); },
          this.forumReceipt(conn, frame, {
            projectId: project.id, targetId: project.id, kind: "remove-member", resultId: project.id,
          }),
        );
        this.audit(conn, "forum_member_removed", project.id, `removed a member from the forum for ${project.name}`);
        this.toUser(frame.userId, {
          type: "forumUnavailable", projectId: project.id,
          problem: "you are no longer a member of this project forum",
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        send(conn.ws, {
          type: "forumMembers", projectId: project.id,
          userIds: this.store.forumMembers(project.id),
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
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
        if (already) {
          send(conn.ws, { type: "project", project: this.viewProject(already) });
          this.sendPulseSnapshotTo(this.pulseAudience(already));
          break;
        }
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
        // A second owner window may already be on Pulse. The project picker in
        // that window is a durable access projection, so refresh it now rather
        // than waiting for the screen to be reopened or manually re-asked.
        this.sendPulseSnapshotTo(this.pulseAudience(project));
        // AND LOOK AT IT NOW, so a mistyped repository is not indistinguishable
        // from a good one for ever. Before this, `definitely-not-a-real-owner/
        // nope` joined the list and sat there saying "Not looked at GitHub yet"
        // — the exact words a perfectly good repository says.
        this.lookOnConnect(conn.userId, project);
        break;
      }
      case "updateProject": {
        const project = this.myProject(conn.userId, frame.projectId);
        const beforePulseAudience = this.pulseAudience(project);
        const beforeAudience = this.projectAudience(project);
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
          const nextChannel = frame.channelId || undefined;
          if (nextChannel !== project.channelId) {
            if (this.store.huddles(project.id).length > 0) {
              throw new Error("this project has huddles, so its room cannot be changed");
            }
          }
          if (nextChannel) project.channelId = nextChannel;
          else delete project.channelId;
        }
        this.store.saveProject(project);
        this.audit(conn, "project_updated", project.id, `updated ${project.repo}`);
        const afterAudience = this.projectAudience(project);
        for (const userId of beforeAudience) {
          if (!afterAudience.has(userId)) {
            this.toUser(userId, { type: "projectAccessRevoked", projectId: project.id });
          }
        }
        // Member windows get a redacted projection (id+name); owners get full.
        for (const userId of afterAudience) {
          this.toUser(userId, { type: "project", project: this.viewProject(project, userId) });
        }
        this.sendPulseSnapshotTo(new Set([...beforePulseAudience, ...this.pulseAudience(project)]));
        this.pushCanvasProject(project);
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
        const projectAudience = this.projectAudience(project);
        for (const userId of this.store.socialMembers(project.id, project.ownerId)) {
          this.toUser(userId, { type: "socialUnavailable", projectId: project.id });
        }
        const pulseAudience = this.pulseAudience(project);
        // FORGETS OUR COPY. The repository is untouched — the hub has no way to
        // reach GitHub at all, and that is the design, not an omission.
        // a look still in flight has nothing left to report into
        this.endLook(project.id);
        const forgottenHuddles = this.store.huddles(project.id);
        // Full prior audience: owner + channel members + anyone who joined presence (and agent owners).
        const huddleAudience = this.huddleAudience(project, forgottenHuddles);
        this.store.forgetProject(project.id);
        for (const huddle of forgottenHuddles) {
          for (const userId of huddleAudience) this.toUser(userId, { type: "huddleUnavailable", sessionId: huddle.id, problem: "This project was forgotten, so its huddle is no longer available." });
        }
        this.audit(conn, "project_forgotten", project.id, `disconnected ${project.repo}`);
        for (const userId of projectAudience) {
          this.toUser(userId, { type: "projectForgotten", projectId: project.id });
        }
        this.sendPulseSnapshotTo(pulseAudience);
        break;
      }
      case "projects": {
        // Member-facing list: owners get full rows; channel members get id+name only.
        send(conn.ws, {
          type: "projects",
          projects: this.projectsForMember(conn.userId).map(p => this.viewProject(p, conn.userId)),
        });
        break;
      }

      case "canvases": {
        const project = this.projectForCanvas(conn.userId, frame.projectId);
        send(conn.ws, { type: "canvases", projectId: project.id,
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
          canvases: this.store.canvasesForProject(project.id).map(c => this.canvasView(conn.userId, c)) });
        break;
      }
      case "createCanvas": {
        const project = this.projectForCanvas(conn.userId, frame.projectId);
        const requestId = frame.requestId;
        const payload = { projectId: project.id, title: frame.title, authorAgentId: frame.authorAgentId ?? null };
        const prior = this.canvasReceipt(conn, requestId, "create", project.id, payload);
        if (prior) { const existing = this.store.canvas(prior.canvasId); if (existing) this.pushCanvas(existing, conn, requestId); break; }
        const bad = validateCanvasTitle(frame.title);
        if (bad) throw new Error(bad);
        if (this.store.canvasCount(project.id) >= CANVAS_LIMITS.perProject) throw new Error(`that's too many canvases for this project (max ${CANVAS_LIMITS.perProject})`);
        const author = this.canvasAuthor(conn, project, frame.authorAgentId);
        const now = Date.now();
        const canvas: EngineeringCanvas = { id: newId("canvas"), projectId: project.id, ownerId: project.ownerId,
          title: frame.title.trim(), blocks: [], revision: 1, createdAt: now, updatedAt: now };
        this.store.saveCanvasChange(canvas, { canvasId: canvas.id, revision: 1, changedAt: now, changedBy: author.id, summary: "created canvas", canvas },
          requestId ? { ownerId: conn.userId, requestId, action: "create", target: project.id, payload: this.canvasPayloadFingerprint(payload) } : undefined);
        this.audit(conn, "canvas_created", canvas.id, `created canvas in ${project.repo}`);
        this.pushCanvas(canvas, conn, requestId);
        break;
      }
      case "updateCanvas": {
        const { project, canvas } = this.canvasForMember(conn.userId, frame.canvasId);
        if (project.ownerId !== conn.userId) throw new Error("only the project owner can rename a canvas");
        const author = this.canvasAuthor(conn, project, frame.authorAgentId);
        const requestId = frame.requestId;
        const payload = { canvasId: canvas.id, title: frame.title ?? null, authorAgentId: frame.authorAgentId ?? null, expectedRevision: frame.expectedRevision ?? null };
        const prior = this.canvasReceipt(conn, requestId, "update", canvas.id, payload);
        if (prior) { this.pushCanvas(canvas, conn, requestId); break; }
        if (frame.expectedRevision !== undefined && frame.expectedRevision !== canvas.revision) throw new Error("that canvas changed — reload before saving");
        if (frame.title !== undefined) { const bad = validateCanvasTitle(frame.title); if (bad) throw new Error(bad); canvas.title = frame.title.trim(); }
        canvas.revision++; canvas.updatedAt = Date.now();
        this.store.saveCanvasChange(canvas, { canvasId: canvas.id, revision: canvas.revision, changedAt: canvas.updatedAt, changedBy: author.id, summary: "renamed canvas", canvas },
          requestId ? { ownerId: conn.userId, requestId, action: "update", target: canvas.id, payload: this.canvasPayloadFingerprint(payload) } : undefined);
        this.pushCanvas(canvas, conn, requestId);
        break;
      }
      case "addCanvasBlock": {
        const { project, canvas } = this.canvasForMember(conn.userId, frame.canvasId);
        const requestId = frame.requestId;
        const payload = { canvasId: canvas.id, kind: frame.kind, text: frame.text, link: frame.link ?? null, authorAgentId: frame.authorAgentId ?? null, expectedRevision: frame.expectedRevision ?? null };
        const prior = this.canvasReceipt(conn, requestId, "add", canvas.id, payload);
        if (prior) { this.pushCanvas(canvas, conn, requestId); break; }
        if (frame.expectedRevision !== undefined && frame.expectedRevision !== canvas.revision) throw new Error("that canvas changed — reload before saving");
        const bad = validateCanvasBlock(frame.kind, frame.text); if (bad) throw new Error(bad);
        if (canvas.blocks.length >= CANVAS_LIMITS.blocks) throw new Error(`that's too many blocks (max ${CANVAS_LIMITS.blocks})`);
        const badLink = validateCanvasLink(frame.link); if (badLink) throw new Error(badLink);
        if (frame.link && !this.canvasLinkAllowed(conn.userId, project, frame.link)) throw new Error("that linked item is not accessible from this project");
        const author = this.canvasAuthor(conn, project, frame.authorAgentId);
        const now = Date.now();
        canvas.blocks.push({ id: newId("block"), canvasId: canvas.id, kind: frame.kind, text: frame.text.trim(), authorId: author.id, authorKind: author.kind,
          createdAt: now, updatedAt: now, order: canvas.blocks.length, ...(frame.link ? { link: frame.link } : {}) });
        canvas.revision++; canvas.updatedAt = now;
        this.store.saveCanvasChange(canvas, { canvasId: canvas.id, revision: canvas.revision, changedAt: now, changedBy: author.id, summary: `added ${frame.kind} block`, canvas },
          requestId ? { ownerId: conn.userId, requestId, action: "add", target: canvas.id, payload: this.canvasPayloadFingerprint(payload) } : undefined);
        this.audit(conn, "canvas_block_added", canvas.id, `added a ${frame.kind} block`); this.pushCanvas(canvas, conn, requestId); break;
      }
      case "editCanvasBlock": {
        const { project, canvas } = this.canvasForMember(conn.userId, frame.canvasId);
        const requestId = frame.requestId;
        const author = this.canvasAuthor(conn, project, frame.authorAgentId);
        const payload = { canvasId: canvas.id, blockId: frame.blockId, kind: frame.kind ?? null, text: frame.text ?? null, link: frame.link ?? null, authorAgentId: frame.authorAgentId ?? null, expectedRevision: frame.expectedRevision ?? null };
        const prior = this.canvasReceipt(conn, requestId, "edit", canvas.id, payload);
        if (prior) { this.pushCanvas(canvas, conn, requestId); break; }
        if (frame.expectedRevision !== undefined && frame.expectedRevision !== canvas.revision) throw new Error("that canvas changed — reload before saving");
        const block = canvas.blocks.find(b => b.id === frame.blockId); if (!block || block.deletedAt) throw new Error("no such canvas block");
        if (block.authorId !== author.id && project.ownerId !== conn.userId) throw new Error("you may only edit your own canvas block");
        if (frame.kind !== undefined || frame.text !== undefined) { const bad = validateCanvasBlock(frame.kind ?? block.kind, frame.text ?? block.text); if (bad) throw new Error(bad); }
        const badLink = validateCanvasLink(frame.link); if (badLink) throw new Error(badLink);
        if (frame.link !== undefined && !this.canvasLinkAllowed(conn.userId, project, frame.link)) throw new Error("that linked item is not accessible from this project");
        if (frame.kind !== undefined) block.kind = frame.kind; if (frame.text !== undefined) block.text = frame.text.trim(); if (frame.link !== undefined) block.link = frame.link;
        block.updatedAt = Date.now(); canvas.revision++; canvas.updatedAt = block.updatedAt;
        this.store.saveCanvasChange(canvas, { canvasId: canvas.id, revision: canvas.revision, changedAt: canvas.updatedAt, changedBy: author.id, summary: "edited canvas block", canvas },
          requestId ? { ownerId: conn.userId, requestId, action: "edit", target: canvas.id, payload: this.canvasPayloadFingerprint(payload) } : undefined); this.pushCanvas(canvas, conn, requestId); break;
      }
      case "tombstoneCanvasBlock": {
        const { project, canvas } = this.canvasForMember(conn.userId, frame.canvasId);
        const requestId = frame.requestId;
        const author = this.canvasAuthor(conn, project, frame.authorAgentId);
        const payload = { canvasId: canvas.id, blockId: frame.blockId, authorAgentId: frame.authorAgentId ?? null, expectedRevision: frame.expectedRevision ?? null };
        const prior = this.canvasReceipt(conn, requestId, "tombstone", canvas.id, payload);
        if (prior) { this.pushCanvas(canvas, conn, requestId); break; }
        if (frame.expectedRevision !== undefined && frame.expectedRevision !== canvas.revision) throw new Error("that canvas changed — reload before saving");
        const block = canvas.blocks.find(b => b.id === frame.blockId); if (!block || block.deletedAt) throw new Error("no such canvas block");
        if (block.authorId !== author.id && project.ownerId !== conn.userId) throw new Error("you may only remove your own canvas block");
        const now = Date.now(); block.deletedAt = now; block.deletedBy = author.id; block.updatedAt = now; canvas.revision++; canvas.updatedAt = now;
        this.store.saveCanvasChange(canvas, { canvasId: canvas.id, revision: canvas.revision, changedAt: now, changedBy: author.id, summary: "tombstoned canvas block", canvas },
          requestId ? { ownerId: conn.userId, requestId, action: "tombstone", target: canvas.id, payload: this.canvasPayloadFingerprint(payload) } : undefined); this.pushCanvas(canvas, conn, requestId); break;
      }
      case "canvasHistory": {
        const { canvas } = this.canvasForMember(conn.userId, frame.canvasId);
        send(conn.ws, { type: "canvasHistory", canvasId: canvas.id, ...(frame.requestId ? { requestId: frame.requestId } : {}), revisions: this.store.canvasRevisions(canvas.id, frame.limit).map(revision => ({
          ...revision, changedByName: this.store.users().find(u => u.id === revision.changedBy)?.name
            ?? this.store.agents().find(a => a.id === revision.changedBy)?.name,
          canvas: this.canvasView(conn.userId, revision.canvas),
        })) }); break;
      }
      case "markCanvasRead": {
        const { canvas } = this.canvasForMember(conn.userId, frame.canvasId);
        if (!Number.isSafeInteger(frame.revision) || frame.revision < 0) {
          throw new Error("a canvas read revision must be a finite integer");
        }
        this.store.markCanvasRead(canvas.id, conn.userId, Math.min(frame.revision, canvas.revision));
        this.toUser(conn.userId, { type: "canvas", canvas: this.canvasView(conn.userId, canvas) }); break;
      }
      case "polls": {
        const project = this.projectForMember(conn.userId, frame.projectId);
        this.sweepExpiredProjectPolls();
        send(conn.ws, {
          type: "polls", projectId: project.id,
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
          polls: this.store.projectPolls(project.id).map(p => this.pollView(conn.userId, p)),
        });
        break;
      }
      case "createPoll": {
        const project = this.projectForMember(conn.userId, frame.projectId);
        const requestId = typeof frame.requestId === "string" && frame.requestId.trim()
          ? frame.requestId.trim() : undefined;
        if (requestId) {
          const prior = this.store.projectPollRequest(conn.userId, requestId);
          if (prior && prior.projectId !== project.id) {
            throw new Error("that poll request id was already used for another project");
          }
          if (prior) {
            const existing = this.store.projectPoll(prior.pollId);
            if (existing) this.pushPoll(existing, requestId, conn.userId);
            break;
          }
        }
        const badQuestion = validatePollQuestion(frame.question);
        if (badQuestion) throw new Error(badQuestion);
        const badOptions = validatePollOptions(frame.options);
        if (badOptions) throw new Error(badOptions);
        if (this.store.projectPollCount(project.id) >= POLL_LIMITS.perProject) {
          throw new Error(`that's too many polls for this project (max ${POLL_LIMITS.perProject})`);
        }
        if (frame.deadlineAt !== undefined && (!Number.isFinite(frame.deadlineAt) || frame.deadlineAt <= Date.now())) {
          throw new Error("a poll deadline must be in the future");
        }
        if (conn.client === "engine" && frame.authorAgentId === undefined) {
          throw new Error("engine-created polls must name the author agent");
        }
        let authorId = conn.userId;
        let authorKind: ProjectPoll["authorKind"] = "human";
        if (frame.authorAgentId !== undefined) {
          if (conn.client !== "engine") throw new Error("only the engine can author a poll for an agent");
          const agent = this.myAgent(conn.userId, frame.authorAgentId);
          if (agent.ownerId !== project.ownerId) throw new Error("that agent does not own this project");
          authorId = agent.id; authorKind = "agent";
        }
        const poll: ProjectPoll = {
          id: newId("poll"), projectId: project.id, authorId, authorKind,
          question: frame.question.trim(),
          options: frame.options.map(label => ({ id: newId("opt"), label: label.trim() })),
          ...(frame.deadlineAt !== undefined ? { deadlineAt: frame.deadlineAt } : {}),
          createdAt: Date.now(), status: "open",
        };
        this.store.createProjectPoll(poll, conn.userId, requestId);
        this.scheduleProjectPollExpiry();
        // Detail never names the private repo — activity is filtered by membership.
        this.audit(conn, "project_poll_created", poll.id, "created a project poll");
        this.pushPoll(poll, requestId, conn.userId);
        break;
      }
      case "votePoll": {
        this.sweepExpiredProjectPolls();
        const poll = this.store.projectPoll(frame.pollId);
        if (!poll) throw new Error("no such poll");
        this.projectForMember(conn.userId, poll.projectId);
        if (poll.status !== "open") throw new Error("that poll is closed");
        if (!poll.options.some(option => option.id === frame.optionId)) throw new Error("that is not a poll option");
        this.store.voteProjectPoll(poll.id, conn.userId, frame.optionId);
        this.audit(conn, "project_poll_voted", poll.id, "voted in a project poll");
        this.pushPoll(poll);
        break;
      }
      case "closePoll": {
        this.sweepExpiredProjectPolls();
        const poll = this.store.projectPoll(frame.pollId);
        if (!poll) throw new Error("no such poll");
        // Owner-only: myProject, not projectForMember.
        this.myProject(conn.userId, poll.projectId);
        if (poll.status === "closed") { this.pushPoll(poll); break; }
        const summary = frame.summary?.trim();
        if (summary && summary.length > POLL_LIMITS.summary) throw new Error(`that decision is too long (max ${POLL_LIMITS.summary} characters)`);
        const decision = {
          closedAt: Date.now(), closedBy: conn.userId, reason: "manual" as const,
          ...(summary ? { summary } : {}), results: this.store.pollResults(poll.id, poll.options),
        };
        const closed = this.store.closeProjectPoll(poll.id, decision);
        if (!closed) throw new Error("that poll is closed");
        this.audit(conn, "project_poll_closed", poll.id, "closed a project poll");
        this.pushPoll(closed);
        this.scheduleProjectPollExpiry();
        break;
      }
      case "hooks": {
        this.assertHookClient(conn);
        send(conn.ws, { type: "hooks", hooks: this.store.hooksOf(conn.userId), ...(frame.requestId ? { requestId: frame.requestId } : {}) });
        break;
      }
      case "hooksAudit": {
        this.assertHookClient(conn);
        send(conn.ws, { type: "hookAudit", entries: this.store.hookAuditOf(conn.userId), ...(frame.requestId ? { requestId: frame.requestId } : {}) });
        break;
      }
      case "createHook": {
        this.assertHookClient(conn);
        this.validateHookCreate(frame.hook);
        const requestId = frame.requestId;
        const priorReceipt = this.hookReceipt(conn, requestId, "create", "new", frame.hook);
        if (priorReceipt) {
          const prior = this.store.hook(conn.userId, priorReceipt.hookId);
          if (prior) this.tellHook(conn.userId, prior, requestId, conn);
          else this.tellHooks(conn.userId, requestId, conn);
          break;
        }
        if (this.store.hooksOf(conn.userId).length >= HOOK_DEFAULTS.maxHooks) {
          throw new Error(`Cloud9 keeps at most ${HOOK_DEFAULTS.maxHooks} hooks`);
        }
        const now = Date.now();
        const hook = { ...frame.hook, id: newId("hook"), ownerId: conn.userId, updatedAt: now } as StoredHook;
        this.validateHookOwner(conn.userId, hook);
        this.store.saveHookWithRequest(hook, conn.userId, requestId, "create", "new", JSON.stringify(frame.hook));
        this.store.logHookAudit(conn.userId, hook.id, "created", true, "hook created", Date.now(), conn.userId, conn.client, requestId, "new");
        this.syncHooksToEngine(conn.userId);
        this.tellHook(conn.userId, hook, requestId, conn);
        break;
      }
      case "updateHook": {
        this.assertHookClient(conn);
        this.validateHookPatch(frame.hook);
        const requestId = frame.requestId;
        const priorReceipt = this.hookReceipt(conn, requestId, "update", frame.hookId, frame.hook);
        if (priorReceipt) {
          const prior = this.store.hook(conn.userId, priorReceipt.hookId);
          if (prior) this.tellHook(conn.userId, prior, requestId, conn);
          else this.tellHooks(conn.userId, requestId, conn);
          break;
        }
        const old = this.myHook(conn.userId, frame.hookId);
        // An action is a discriminated union, not a patchable bag. Replacing it
        // wholesale prevents stale text/title fields surviving an action-kind change.
        const hook = { ...old, ...frame.hook, action: frame.hook.action ?? old.action, updatedAt: Date.now() } as StoredHook;
        this.validateHookOwner(conn.userId, hook);
        this.store.saveHookWithRequest(hook, conn.userId, requestId, "update", frame.hookId, JSON.stringify(frame.hook));
        this.store.logHookAudit(conn.userId, hook.id, "updated", true, "hook updated", Date.now(), conn.userId, conn.client, requestId, frame.hookId);
        this.syncHooksToEngine(conn.userId);
        this.tellHook(conn.userId, hook, requestId, conn);
        break;
      }
      case "setHookEnabled": {
        this.assertHookClient(conn);
        if (typeof frame.enabled !== "boolean") throw new Error("a hook enabled value must be true or false");
        const priorReceipt = this.hookReceipt(conn, frame.requestId, "enabled", frame.hookId, { enabled: frame.enabled });
        if (priorReceipt) {
          const prior = this.store.hook(conn.userId, priorReceipt.hookId);
          if (prior) this.tellHook(conn.userId, prior, frame.requestId, conn);
          else this.tellHooks(conn.userId, frame.requestId, conn);
          break;
        }
        const hook = this.myHook(conn.userId, frame.hookId); hook.enabled = frame.enabled; hook.updatedAt = Date.now();
        this.validateHookOwner(conn.userId, hook);
        this.store.saveHookWithRequest(hook, conn.userId, frame.requestId, "enabled", frame.hookId, JSON.stringify({ enabled: frame.enabled }));
        this.store.logHookAudit(conn.userId, hook.id, frame.enabled ? "enabled" : "disabled", true, frame.enabled ? "hook enabled" : "hook disabled", Date.now(), conn.userId, conn.client, frame.requestId, frame.hookId);
        this.syncHooksToEngine(conn.userId);
        this.tellHook(conn.userId, hook, frame.requestId, conn);
        break;
      }
      case "deleteHook": {
        this.assertHookClient(conn);
        const requestId = frame.requestId;
        const priorReceipt = this.hookReceipt(conn, requestId, "delete", frame.hookId, {});
        if (priorReceipt) {
          this.tellHooks(conn.userId, requestId, conn);
          break;
        }
        const hook = this.myHook(conn.userId, frame.hookId);
        this.store.deleteHookWithRequest(conn.userId, hook.id, requestId, "delete", frame.hookId, "{}");
        this.store.logHookAudit(conn.userId, hook.id, "deleted", true, "hook deleted", Date.now(), conn.userId, conn.client, requestId, frame.hookId);
        this.syncHooksToEngine(conn.userId);
        this.tellHooks(conn.userId, frame.requestId, conn);
        break;
      }
      case "testHook": {
        this.assertHookClient(conn);
        const requestId = frame.requestId;
        const priorReceipt = this.hookReceipt(conn, requestId, "test", frame.hookId, {});
        if (priorReceipt) {
          const prior = this.store.hook(conn.userId, priorReceipt.hookId);
          if (!prior) throw new Error("that hook no longer exists");
          if (prior) {
            this.validateHookOwner(conn.userId, prior);
            const said = prior.enabled ? `“${prior.name}” is valid and ready for ${HOOK_ACTIONS[prior.action.do]}` : `“${prior.name}” is disabled; enable it before it can run`;
            send(conn.ws, { type: "hookTest", hookId: prior.id, ok: prior.enabled, said, ...(requestId ? { requestId } : {}) });
          }
          break;
        }
        const hook = this.myHook(conn.userId, frame.hookId);
        this.validateHookOwner(conn.userId, hook);
        const said = hook.enabled ? `“${hook.name}” is valid and ready for ${HOOK_ACTIONS[hook.action.do]}` : `“${hook.name}” is disabled; enable it before it can run`;
        this.store.recordHookTest(conn.userId, hook, requestId, hook.enabled, said, Date.now(), conn.client);
        send(conn.ws, { type: "hookTest", hookId: hook.id, ok: hook.enabled, said, ...(frame.requestId ? { requestId: frame.requestId } : {}) });
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
      // ---- internal team social feed ----
      //
      // The project membership gate is separate from channel membership. A
      // project owner may add invited users, and every read/write below asks
      // the stored membership table again so a stale client cannot widen scope.
      case "socialProjects": {
        const projects = this.store.socialProjectsOf(conn.userId);
        send(conn.ws, {
          type: "socialProjects", projects: projects.map(project => this.socialProjectView(project)),
          unread: projects.map(project => this.store.socialUnread(conn.userId, project.id)),
          ...(frame.requestId !== undefined ? { requestId: frame.requestId } : {}),
        });
        break;
      }
      case "socialList": {
        const project = this.socialProject(conn.userId, frame.projectId);
        const page = this.store.socialPosts(project.id,
          { before: frame.before, beforeId: frame.beforeId },
          frame.limit ?? SOCIAL_LIMITS.feedPage);
        const read = this.store.socialUnread(conn.userId, project.id);
        send(conn.ws, {
          type: "socialFeed", projectId: project.id,
          posts: page.items.map(post => this.socialPostView(conn.userId, project, post)),
          hasMore: page.hasMore, unread: read.unread,
          ...(page.nextBefore !== undefined ? { nextBefore: page.nextBefore } : {}),
          ...(page.nextBeforeId !== undefined ? { nextBeforeId: page.nextBeforeId } : {}),
          ...(frame.requestId !== undefined ? { requestId: frame.requestId } : {}),
        });
        break;
      }
      case "socialCreate": {
        const project = this.socialProject(conn.userId, frame.projectId);
        const prior = this.priorSocialOperation<Extract<ServerFrame, { type: "socialPost" }>>(
          conn, "socialCreate", frame.requestId, this.socialPayloadHash(frame), project.id,
        );
        if (prior) { send(conn.ws, prior); break; }
        const bad = validateSocialText(frame.text);
        if (bad) throw new Error(bad);
        const links = this.socialLinks(conn.userId, project, frame.links);
        let parentId: ID | undefined;
        if (frame.parentId) {
          const parent = this.store.socialPost(frame.parentId);
          if (!parent || parent.projectId !== project.id || parent.parentId || parent.deletedAt) {
            throw new Error("that comment belongs to another project or thread");
          }
          parentId = parent.id;
        }
        const user = this.store.user(conn.userId)!;
        const post: SocialPost = {
          id: newId("sp"), projectId: project.id, ...(parentId ? { parentId } : {}),
          authorId: user.id, authorName: user.name, authorKind: "human", ownerId: user.id,
          text: frame.text, createdAt: Date.now(),
          ...(links ? { links } : {}),
        };
        const { stored, result } = this.store.socialMutation(() => {
          this.store.saveSocialPost(post);
          const saved = this.store.socialPost(post.id)!;
          const response: Extract<ServerFrame, { type: "socialPost" }> = {
            type: "socialPost", post: this.socialPostView(conn.userId, project, saved),
            ...(frame.requestId ? { requestId: frame.requestId } : {}),
          };
          this.rememberSocialOperation(conn, "socialCreate", frame.requestId, response, this.socialPayloadHash(frame));
          return { stored: saved, result: response };
        });
        this.broadcastSocialView(project.id, userId => ({
          type: "socialPost", post: this.socialPostView(userId, project, stored),
        }));
        this.broadcastSocialUnread(project.id);
        send(conn.ws, result);
        break;
      }
      case "socialAgentCreate": {
        if (conn.client !== "engine") throw new Error("only an agent engine can post as an agent");
        const agent = this.myAgent(conn.userId, frame.agentId);
        const project = this.socialProject(conn.userId, frame.projectId);
        const prior = this.priorSocialOperation<Extract<ServerFrame, { type: "socialPost" }>>(
          conn, "socialAgentCreate", frame.requestId, this.socialPayloadHash(frame), project.id,
        );
        if (prior) { send(conn.ws, prior); break; }
        const bad = validateSocialText(frame.text);
        if (bad) throw new Error(bad);
        const links = this.socialLinks(conn.userId, project, frame.links);
        let parentId: ID | undefined;
        if (frame.parentId) {
          const parent = this.store.socialPost(frame.parentId);
          if (!parent || parent.projectId !== project.id || parent.parentId || parent.deletedAt) {
            throw new Error("that comment belongs to another project or thread");
          }
          parentId = parent.id;
        }
        const post: SocialPost = {
          id: newId("sp"), projectId: project.id, ...(parentId ? { parentId } : {}),
          authorId: agent.id, authorName: agent.name, authorKind: "agent", ownerId: agent.ownerId,
          text: frame.text, createdAt: Date.now(),
          ...(links ? { links } : {}),
        };
        const { stored, result } = this.store.socialMutation(() => {
          this.store.saveSocialPost(post);
          const saved = this.store.socialPost(post.id)!;
          const response: Extract<ServerFrame, { type: "socialPost" }> = {
            type: "socialPost", post: this.socialPostView(conn.userId, project, saved),
            ...(frame.requestId ? { requestId: frame.requestId } : {}),
          };
          this.rememberSocialOperation(conn, "socialAgentCreate", frame.requestId, response, this.socialPayloadHash(frame));
          return { stored: saved, result: response };
        });
        this.broadcastSocialView(project.id, userId => ({
          type: "socialPost", post: this.socialPostView(userId, project, stored),
        }));
        this.broadcastSocialUnread(project.id);
        send(conn.ws, result);
        break;
      }
      case "socialEdit": {
        const { project, post } = this.socialPostFor(conn.userId, frame.postId);
        const canEdit = post.ownerId === conn.userId && (
          (post.authorKind === "human" && conn.client !== "engine" && post.authorId === conn.userId)
          || (post.authorKind === "agent" && conn.client === "engine" && frame.agentId === post.authorId
            && this.myAgent(conn.userId, frame.agentId).id === post.authorId)
        );
        if (!canEdit) throw new Error("you can only edit your own live post");
        const prior = this.priorSocialOperation<Extract<ServerFrame, { type: "socialUpdated" }>>(
          conn, "socialEdit", frame.requestId, this.socialPayloadHash(frame), project.id,
        );
        if (prior) { send(conn.ws, prior); break; }
        if (post.deletedAt) throw new Error("you can only edit your own live post");
        const bad = validateSocialText(frame.text);
        if (bad) throw new Error(bad);
        const updated: SocialPost = {
          ...post, text: frame.text, editedAt: Date.now(),
          ...(post.reactions ? { reactions: post.reactions } : {}),
        };
        const { stored, result } = this.store.socialMutation(() => {
          this.store.saveSocialPost(updated);
          const saved = this.store.socialPost(post.id)!;
          const response: Extract<ServerFrame, { type: "socialUpdated" }> = {
            type: "socialUpdated", post: this.socialPostView(conn.userId, project, saved),
            ...(frame.requestId ? { requestId: frame.requestId } : {}),
          };
          this.rememberSocialOperation(conn, "socialEdit", frame.requestId, response, this.socialPayloadHash(frame));
          return { stored: saved, result: response };
        });
        this.broadcastSocialView(project.id, userId => ({
          type: "socialUpdated", post: this.socialPostView(userId, project, stored),
        }));
        this.broadcastSocialUnread(project.id);
        send(conn.ws, result);
        break;
      }
      case "socialDelete": {
        const { project, post } = this.socialPostFor(conn.userId, frame.postId);
        const canDelete = post.ownerId === conn.userId && (
          (post.authorKind === "human" && conn.client !== "engine" && post.authorId === conn.userId)
          || (post.authorKind === "agent" && conn.client === "engine" && frame.agentId === post.authorId
            && this.myAgent(conn.userId, frame.agentId).id === post.authorId)
        );
        if (!canDelete) throw new Error("you can only delete your own live post");
        const prior = this.priorSocialOperation<Extract<ServerFrame, { type: "socialUpdated" }>>(
          conn, "socialDelete", frame.requestId, this.socialPayloadHash(frame), project.id,
        );
        if (prior) { send(conn.ws, prior); break; }
        if (post.deletedAt) throw new Error("you can only delete your own live post");
        const tombstone: SocialPost = {
          ...post, text: "", deletedAt: Date.now(), links: undefined,
          reactions: undefined,
        };
        const { stored, result } = this.store.socialMutation(() => {
          this.store.saveSocialPost(tombstone);
          const saved = this.store.socialPost(post.id)!;
          const response: Extract<ServerFrame, { type: "socialUpdated" }> = {
            type: "socialUpdated", post: this.socialPostView(conn.userId, project, saved),
            ...(frame.requestId ? { requestId: frame.requestId } : {}),
          };
          this.rememberSocialOperation(conn, "socialDelete", frame.requestId, response, this.socialPayloadHash(frame));
          return { stored: saved, result: response };
        });
        this.broadcastSocialView(project.id, userId => ({
          type: "socialUpdated", post: this.socialPostView(userId, project, stored),
        }));
        this.broadcastSocialUnread(project.id);
        send(conn.ws, result);
        break;
      }
      case "socialReact": {
        const { project, post } = this.socialPostFor(conn.userId, frame.postId);
        const prior = this.priorSocialOperation<Extract<ServerFrame, { type: "socialReaction" }>>(
          conn, "socialReact", frame.requestId, this.socialPayloadHash(frame), project.id,
        );
        if (prior) { send(conn.ws, prior); break; }
        if (post.deletedAt) throw new Error("deleted posts cannot receive reactions");
        const bad = validateReactionEmoji(frame.emoji);
        if (bad) throw new Error(bad);
        const { actorIds, result } = this.store.socialMutation(() => {
          const ids = this.store.setSocialReaction(project.id, post.id, conn.userId, frame.emoji, frame.on !== false);
          const response: Extract<ServerFrame, { type: "socialReaction" }> = {
            type: "socialReaction", projectId: project.id, postId: post.id,
            emoji: frame.emoji, actorIds: ids,
            ...(frame.requestId ? { requestId: frame.requestId } : {}),
          };
          this.rememberSocialOperation(conn, "socialReact", frame.requestId, response, this.socialPayloadHash(frame));
          return { actorIds: ids, result: response };
        });
        this.broadcastSocial(project.id, {
          type: "socialReaction", projectId: project.id, postId: post.id,
          emoji: frame.emoji, actorIds,
        });
        this.broadcastSocialUnread(project.id);
        send(conn.ws, result);
        break;
      }
      case "socialMarkRead": {
        const project = this.socialProject(conn.userId, frame.projectId);
        const prior = this.priorSocialOperation<Extract<ServerFrame, { type: "socialRead" }>>(
          conn, "socialMarkRead", frame.requestId, this.socialPayloadHash(frame), project.id,
        );
        if (prior) { send(conn.ws, prior); break; }
        const requestedAt = Number.isFinite(frame.at) ? Math.floor(frame.at ?? Date.now()) : Date.now();
        const result = this.store.socialMutation(() => {
          const read = this.store.markSocialRead(conn.userId, project.id, Math.min(Date.now(), Math.max(0, requestedAt)));
          const response: Extract<ServerFrame, { type: "socialRead" }> = {
            type: "socialRead", entry: read, ...(frame.requestId ? { requestId: frame.requestId } : {}),
          };
          this.rememberSocialOperation(conn, "socialMarkRead", frame.requestId, response, this.socialPayloadHash(frame));
          return response;
        });
        this.toUserExcept(conn.userId, conn, { ...result, requestId: undefined });
        send(conn.ws, result);
        this.broadcastSocialUnread(project.id);
        break;
      }
      case "socialMembers": {
        const project = this.myProject(conn.userId, frame.projectId);
        send(conn.ws, {
          type: "socialMembers", projectId: project.id,
          userIds: this.store.socialMembers(project.id, project.ownerId),
          ...(frame.requestId !== undefined ? { requestId: frame.requestId } : {}),
        });
        break;
      }
      case "socialAddMember": {
        const project = this.myProject(conn.userId, frame.projectId);
        const prior = this.priorSocialOperation<Extract<ServerFrame, { type: "socialMembers" }>>(
          conn, "socialAddMember", frame.requestId, this.socialPayloadHash(frame), project.id,
        );
        if (prior) { send(conn.ws, prior); break; }
        if (!this.store.user(frame.userId)) throw new Error("that person is not in this Cloud9");
        const result = this.store.socialMutation(() => {
          this.store.addSocialMember(project.id, frame.userId);
          const response: Extract<ServerFrame, { type: "socialMembers" }> = {
            type: "socialMembers", projectId: project.id,
            userIds: this.store.socialMembers(project.id, project.ownerId),
            ...(frame.requestId ? { requestId: frame.requestId } : {}),
          };
          this.rememberSocialOperation(conn, "socialAddMember", frame.requestId, response, this.socialPayloadHash(frame));
          return response;
        });
        this.broadcastSocial(project.id, {
          type: "socialMembers", projectId: project.id,
          userIds: result.userIds,
        });
        send(conn.ws, result);
        break;
      }
      case "socialRemoveMember": {
        const project = this.myProject(conn.userId, frame.projectId);
        const prior = this.priorSocialOperation<Extract<ServerFrame, { type: "socialMembers" }>>(
          conn, "socialRemoveMember", frame.requestId, this.socialPayloadHash(frame), project.id,
        );
        if (prior) { send(conn.ws, prior); break; }
        if (frame.userId === project.ownerId) throw new Error("the project owner must remain a member");
        this.toUser(frame.userId, { type: "socialUnavailable", projectId: project.id });
        const result = this.store.socialMutation(() => {
          this.store.removeSocialMember(project.id, frame.userId);
          const response: Extract<ServerFrame, { type: "socialMembers" }> = {
            type: "socialMembers", projectId: project.id,
            userIds: this.store.socialMembers(project.id, project.ownerId),
            ...(frame.requestId ? { requestId: frame.requestId } : {}),
          };
          this.rememberSocialOperation(conn, "socialRemoveMember", frame.requestId, response, this.socialPayloadHash(frame));
          return response;
        });
        this.broadcastSocial(project.id, {
          type: "socialMembers", projectId: project.id, userIds: result.userIds,
        });
        send(conn.ws, result);
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
        // Canvas viewers must see the completed project row. Broadcasting from
        // the item block above exposed an intermediate frame after `looking`
        // ended but before defaultBranch/syncedAt were applied.
        if (frame.items !== undefined) this.pushCanvasProject(project);
        break;
      }
      // ---- Engineering Pulse: project-scoped daily updates ----
      case "pulseList": {
        if (frame.projectId) this.pulseProject(conn.userId, frame.projectId);
        this.sendPulseSnapshot(conn.userId, conn, frame.requestId, frame.projectId);
        break;
      }
      case "pulseCreate": {
        const project = this.pulseProject(conn.userId, frame.projectId);
        const pulseHash = frame.requestId
          ? this.store.pulseMutationHash("pulseCreate", {
              projectId: frame.projectId, draft: frame.draft, agentId: frame.agentId ?? null,
            }) : undefined;
        if (frame.requestId && pulseHash) {
          const prior = this.store.pulseMutationStatus(conn.userId, frame.requestId, "pulseCreate", pulseHash);
          if (prior?.status === "conflict") throw new Error("that Pulse request id was already used for a different update");
          if (prior?.status === "replay") {
            const replay = this.store.pulse(prior.updateId);
            if (!replay) throw new Error("that Pulse update is no longer available");
            this.sendPulseChanged(replay.projectId, replay, conn, frame.requestId);
            break;
          }
        }
        const bad = validateEngineeringPulseDraft(frame.draft);
        if (bad) throw new Error(bad);
        this.validatePulseLinks(conn.userId, project, frame.draft);
        const author = this.pulseAuthor(conn, frame.agentId);
        const now = Date.now();
        const update: EngineeringPulseUpdate = {
          id: newId("pulse"), projectId: project.id,
          authorId: author.id, authorKind: author.kind, authorName: author.name,
          createdAt: now, updatedAt: now,
          done: frame.draft.done.trim(), doing: frame.draft.doing.trim(),
          blocked: frame.draft.blocked.trim(), decisions: frame.draft.decisions.trim(),
          helpNeeded: frame.draft.helpNeeded.trim(),
          ...(frame.draft.relatedTaskId ? { relatedTaskId: frame.draft.relatedTaskId } : {}),
          ...(frame.draft.relatedRunId ? { relatedRunId: frame.draft.relatedRunId } : {}),
          ...(frame.draft.relatedProjectItem ? { relatedProjectItem: frame.draft.relatedProjectItem } : {}),
        };
        if (frame.requestId && pulseHash) this.store.savePulseMutation(conn.userId, frame.requestId, "pulseCreate", pulseHash, update);
        else this.store.savePulse(update);
        this.audit(conn, "pulse_created", update.id, `posted an Engineering Pulse update for ${project.name}`,
          author.agent ? { asAgent: author.agent } : {});
        for (const recipient of this.conns) {
          if (!this.pulseAudience(project).has(recipient.userId)) continue;
          send(recipient.ws, {
            type: "pulseChanged", update: this.pulseProjection(recipient.userId, update),
            unreadByProject: this.pulseUnreadFrame(recipient.userId), projects: this.pulseProjectsFor(recipient.userId),
            ...(recipient === conn && frame.requestId ? { requestId: frame.requestId } : {}),
          });
        }
        break;
      }
      case "pulseUpdate": {
        const { update: existing, project } = this.pulseUpdateFor(conn.userId, frame.updateId);
        const pulseHash = frame.requestId
          ? this.store.pulseMutationHash("pulseUpdate", {
              updateId: frame.updateId, patch: frame.patch, agentId: frame.agentId ?? null,
            }) : undefined;
        if (frame.requestId && pulseHash) {
          const prior = this.store.pulseMutationStatus(conn.userId, frame.requestId, "pulseUpdate", pulseHash);
          if (prior?.status === "conflict") throw new Error("that Pulse request id was already used for a different update");
          if (prior?.status === "replay") {
            const replay = this.store.pulse(prior.updateId);
            if (!replay) throw new Error("that Pulse update is no longer available");
            this.sendPulseChanged(replay.projectId, replay, conn, frame.requestId);
            break;
          }
        }
        if (existing.deletedAt) throw new Error("that update was deleted and cannot be edited");
        const author = this.pulseAuthor(conn, frame.agentId);
        if (existing.authorId !== author.id || existing.authorKind !== author.kind) {
          throw new Error("you may only edit your own update");
        }
        const patch = { ...frame.patch };
        // Related links: undefined = keep existing, null = clear, value = set.
        // JSON.stringify drops undefined, so clients must send null to clear.
        const relatedTaskId = patch.relatedTaskId !== undefined
          ? (patch.relatedTaskId || undefined)
          : existing.relatedTaskId;
        const relatedRunId = patch.relatedRunId !== undefined
          ? (patch.relatedRunId || undefined)
          : existing.relatedRunId;
        const relatedProjectItem = patch.relatedProjectItem !== undefined
          ? (patch.relatedProjectItem || undefined)
          : existing.relatedProjectItem;
        const merged: EngineeringPulseDraft = {
          done: patch.done ?? existing.done, doing: patch.doing ?? existing.doing,
          blocked: patch.blocked ?? existing.blocked, decisions: patch.decisions ?? existing.decisions,
          helpNeeded: patch.helpNeeded ?? existing.helpNeeded,
          ...(relatedTaskId ? { relatedTaskId } : {}),
          ...(relatedRunId ? { relatedRunId } : {}),
          ...(relatedProjectItem ? { relatedProjectItem } : {}),
        };
        const bad = validateEngineeringPulseDraft(merged);
        if (bad) throw new Error(bad);
        this.validatePulseLinks(conn.userId, project, merged);
        // Do not spread existing related* fields - merged is the sole source.
        const {
          relatedTaskId: _oldTask, relatedRunId: _oldRun, relatedProjectItem: _oldItem,
          ...baseExisting
        } = existing;
        const update: EngineeringPulseUpdate = {
          ...baseExisting,
          done: merged.done.trim(), doing: merged.doing.trim(), blocked: merged.blocked.trim(),
          decisions: merged.decisions.trim(), helpNeeded: merged.helpNeeded.trim(),
          updatedAt: Date.now(),
          ...(merged.relatedTaskId ? { relatedTaskId: merged.relatedTaskId } : {}),
          ...(merged.relatedRunId ? { relatedRunId: merged.relatedRunId } : {}),
          ...(merged.relatedProjectItem ? { relatedProjectItem: merged.relatedProjectItem } : {}),
        };
        if (frame.requestId && pulseHash) this.store.savePulseMutation(conn.userId, frame.requestId, "pulseUpdate", pulseHash, update);
        else this.store.savePulse(update);
        this.audit(conn, "pulse_updated", update.id, `edited an Engineering Pulse update for ${project.name}`,
          author.agent ? { asAgent: author.agent } : {});
        for (const recipient of this.conns) {
          if (!this.pulseAudience(project).has(recipient.userId)) continue;
          send(recipient.ws, {
            type: "pulseChanged", update: this.pulseProjection(recipient.userId, update),
            unreadByProject: this.pulseUnreadFrame(recipient.userId), projects: this.pulseProjectsFor(recipient.userId),
            ...(recipient === conn && frame.requestId ? { requestId: frame.requestId } : {}),
          });
        }
        break;
      }
      case "pulseDelete": {
        const { update: existing, project } = this.pulseUpdateFor(conn.userId, frame.updateId);
        const pulseHash = frame.requestId
          ? this.store.pulseMutationHash("pulseDelete", {
              updateId: frame.updateId, agentId: frame.agentId ?? null,
            }) : undefined;
        if (frame.requestId && pulseHash) {
          const prior = this.store.pulseMutationStatus(conn.userId, frame.requestId, "pulseDelete", pulseHash);
          if (prior?.status === "conflict") throw new Error("that Pulse request id was already used for a different update");
          if (prior?.status === "replay") {
            const replay = this.store.pulse(prior.updateId);
            if (!replay) throw new Error("that Pulse update is no longer available");
            this.sendPulseChanged(replay.projectId, replay, conn, frame.requestId);
            break;
          }
        }
        const author = this.pulseAuthor(conn, frame.agentId);
        if (existing.authorId !== author.id || existing.authorKind !== author.kind) {
          throw new Error("you may only delete your own update");
        }
        let tombstone = existing;
        if (!existing.deletedAt) {
          // Purge bodies at the moment of delete so storage and every wire
          // projection lose the secret text (author-only delete for v1).
          tombstone = redactDeletedPulseUpdate({
            ...existing,
            deletedAt: Date.now(),
            updatedAt: Date.now(),
          });
          if (frame.requestId && pulseHash) this.store.savePulseMutation(conn.userId, frame.requestId, "pulseDelete", pulseHash, tombstone);
          else this.store.savePulse(tombstone);
          this.audit(conn, "pulse_deleted", tombstone.id, `deleted an Engineering Pulse update for ${project.name}`,
          author.agent ? { asAgent: author.agent } : {});
        } else if (frame.requestId && pulseHash) {
          // A first delete of an already-deleted tombstone is still an
          // idempotent mutation and gets its durable receipt.
          tombstone = redactDeletedPulseUpdate(existing);
          this.store.savePulseMutation(conn.userId, frame.requestId, "pulseDelete", pulseHash, tombstone);
        } else {
          tombstone = redactDeletedPulseUpdate(existing);
        }
        for (const recipient of this.conns) {
          if (!this.pulseAudience(project).has(recipient.userId)) continue;
          send(recipient.ws, {
            type: "pulseChanged", update: this.pulseProjection(recipient.userId, tombstone),
            unreadByProject: this.pulseUnreadFrame(recipient.userId), projects: this.pulseProjectsFor(recipient.userId),
            ...(recipient === conn && frame.requestId ? { requestId: frame.requestId } : {}),
          });
        }
        break;
      }
      case "pulseRead": {
        const project = this.pulseProject(conn.userId, frame.projectId);
        const rawAt = typeof frame.at === "number" && Number.isFinite(frame.at) ? frame.at : Date.now();
        const at = Math.min(Math.max(0, Math.floor(rawAt)), Date.now());
        this.store.markPulseRead(conn.userId, project.id, at);
        this.sendPulseSnapshot(conn.userId, conn, frame.requestId, project.id);
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
      case "runRecovery": {
        if (frame.mode !== "retry" && frame.mode !== "resume" && frame.mode !== "restart") {
          throw new Error("that recovery action is not supported");
        }
        if (frame.requestId !== undefined && !isSafeStoredId(frame.requestId)) {
          throw new Error("that recovery request id is not usable");
        }
        if (typeof frame.approvalEpoch !== "string" || frame.approvalEpoch.length > 512
          || /[\u0000-\u001f\u007f]/.test(frame.approvalEpoch)) {
          throw new Error("that recovery authorization is not usable");
        }
        const row = this.store.run(frame.runId);
        // Recovery can create new side effects. Only the run owner may ask;
        // room visibility alone is deliberately not enough.
        if (!row || row.ownerId !== conn.userId || !this.canSeeRun(conn.userId, row)) {
          throw new Error("no such run");
        }
        const agent = this.myAgent(conn.userId, row.agentId);
        const checkpoint = this.store.checkpointForRun(
          row.record.id, row.agentId, row.ownerId, frame.checkpointId);
        const decision = recoveryDecision(row.record, checkpoint);
        const requestId = frame.requestId ?? newId("recover");
        // Retry/restart must retain the factual requester from the original
        // run. A legacy or forged record without one is explicitly refused;
        // never fill it with a synthetic chat/requester identity.
        if (!row.record.requestedBy.trim()) {
          throw new Error("the original recovery requester is unavailable");
        }
        const request: RecoveryRequest = {
          requestId, requesterId: conn.userId, agentId: row.agentId,
          ...(row.channelId ? { channelId: row.channelId } : {}), runId: row.record.id,
          kind: row.record.kind,
          ...(row.record.taskId ? { taskId: row.record.taskId } : {}),
          ...(row.record.replyTo ? { replyTo: row.record.replyTo } : {}),
          requesterKind: row.record.requestedByKind,
          requestedBy: sanitizeRecoveryAsk(row.record.requestedBy),
          payload: { mode: frame.mode, ask: sanitizeRecoveryAsk(row.record.ask), ...(checkpoint ? { checkpointId: checkpoint.id } : {}), approvalEpoch: frame.approvalEpoch },
        };
        const previous = this.store.recoveryReceipt(conn.userId, requestId);
        const replay = compareRecoveryRequest(previous, request);
        if (replay === "conflict") throw new Error("that recovery request id was already used for a different action");
        if (replay === "replay" && previous) {
          send(conn.ws, { type: "runRecovery", runId: row.record.id, decision, requestId, pending: previous.status === "pending" });
          break;
        }
        const challengeKey = this.recoveryChallengeKey(conn.userId, requestId);
        const challenge = this.recoveryChallenges.get(challengeKey);
        if (challenge && challenge.payloadFingerprint !== this.recoveryChallengeFingerprint(request)) {
          throw new Error("that recovery request id was already used for a different action");
        }
        // A challenge proves only integrity of this exact bounded request. It
        // never carries policy, trust or availability forward.
        if (!frame.approvalEpoch) {
          const challenged = { ...decision, authorizationToken: this.issueRecoveryChallenge(request) };
          send(conn.ws, { type: "runRecovery", runId: row.record.id, decision: challenged, requestId });
          break;
        }
        if (!this.consumeRecoveryChallenge(request)) throw new Error("that recovery authorization is invalid or expired");
        // The token is integrity-only. Re-read ownership, trust/policy and
        // action availability after the challenge is consumed.
        const currentAgent = this.myAgent(conn.userId, row.agentId);
        const currentCheckpoint = this.store.checkpointForRun(row.record.id, row.agentId, row.ownerId, frame.checkpointId);
        const currentDecision = recoveryDecision(row.record, currentCheckpoint);
        const currentAction = currentDecision.actions.find(a => a.mode === frame.mode);
        const accepted = currentAgent.lifecycle !== "paused" && currentAgent.lifecycle !== "disabled"
          && !!currentAction?.available;
        const approvalRequired = accepted && frame.mode !== "resume" && mustAskBeforeActing(currentAgent);
        if (!accepted) {
          this.store.saveRecoveryReceipt({
            request, payloadFingerprint: recoveryRequestFingerprint(request), status: "refused",
            reason: currentAction?.reason ?? "this recovery action is unavailable", createdAt: Date.now(),
          });
          send(conn.ws, { type: "runRecovery", runId: row.record.id, decision: currentDecision, requestId });
          break;
        }
        if (!this.hasEngine(row.ownerId)) {
          this.store.saveRecoveryReceipt({
            request, payloadFingerprint: recoveryRequestFingerprint(request), status: "refused",
            reason: "the agent engine is not connected", createdAt: Date.now(),
          });
          send(conn.ws, { type: "runRecovery", runId: row.record.id, decision: currentDecision, requestId,
            problem: "The agent engine is not connected. Recovery did not start." });
          break;
        }
        if (approvalRequired) {
          this.pendingRecovery.set(this.recoveryChallengeKey(conn.userId, requestId), request);
          const approval: Approval = {
            id: newId("ap"), agentId: currentAgent.id, ownerId: currentAgent.ownerId,
            action: `${frame.mode === "retry" ? "Retry" : "Restart"} ${currentAgent.name}'s run`.slice(0, APPROVAL_LIMITS.action),
            status: "pending", createdAt: Date.now(), kind: "action",
            ...(row.channelId ? { channelId: row.channelId } : {}), recoveryRequestId: requestId,
          };
          this.store.saveApproval(approval);
          this.store.saveRecoveryReceipt({
            request, payloadFingerprint: recoveryRequestFingerprint(request), status: "pending", createdAt: Date.now(),
          });
          this.audit(conn, "approval_requested", approval.id,
            `${currentAgent.name} asks to recover a run`, { asAgent: currentAgent });
          this.sendApproval(approval);
          send(conn.ws, { type: "runRecovery", runId: row.record.id, decision, requestId, pending: true });
          break;
        }
        const receipt: RecoveryReceipt = {
          request, payloadFingerprint: recoveryRequestFingerprint(request), status: "accepted", createdAt: Date.now(),
        };
        this.store.saveRecoveryReceipt(receipt);
        if (accepted) this.toEngines(row.ownerId, {
          type: "runRecoveryRequested",
          request: { ...request, payload: { ...request.payload, approvalEpoch: "" } },
        });
        send(conn.ws, { type: "runRecovery", runId: row.record.id, decision: currentDecision, requestId });
        break;
      }
      case "runCompare": {
        const left = this.store.run(frame.leftRunId);
        const right = this.store.run(frame.rightRunId);
        const allowed = (candidate: RunRow | undefined): candidate is RunRow => !!candidate && this.canSeeRun(conn.userId, candidate);
        const exact = compareRuns(left?.record, right?.record, record => {
          const row = this.store.run(record.id); return allowed(row);
        }, { left: left ? this.store.checkpointForRun(left.record.id, left.agentId, left.ownerId) : undefined,
          right: right ? this.store.checkpointForRun(right.record.id, right.agentId, right.ownerId) : undefined });
        send(conn.ws, { type: "runComparison", comparison: exact, requestId: frame.requestId });
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
      case "hookFired": {
        if (conn.client !== "engine") throw new Error("only the engine reports hook firings");
        if (!Object.prototype.hasOwnProperty.call(HOOK_EVENTS, frame.event)) throw new Error("that hook event is not supported");
        if (!isSafeStoredId(frame.firingId)) throw new Error("that hook firing has no valid receipt id");
        if (typeof frame.ok !== "boolean") throw new Error("that hook firing has no valid result");
        if (typeof frame.said !== "string" || frame.said.length > 2_000) throw new Error("that hook firing has no valid explanation");
        if (!Number.isFinite(frame.at)) throw new Error("that hook firing has no valid time");
        const hook = this.myHook(conn.userId, frame.hookId);
        if (hook.event !== frame.event) throw new Error("that hook firing does not match the stored event");
        // A reconnect or engine retry may report the same fire again. The
        // firing id is the receipt boundary, so the audit trail stays one row
        // per real action rather than counting transport retries as work.
        const firingTarget = `firing:${hook.id}:${frame.event}`;
        if (this.store.hookAuditHasRequest(conn.userId, frame.firingId, firingTarget)) break;
        this.store.logHookAudit(
          conn.userId, hook.id, frame.ok ? "dispatched" : "refused", false, frame.said,
          Date.now(), conn.userId, conn.client, frame.firingId, firingTarget,
        );
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
      case "agentResponse": {
        // Response previews are a separate semantic protocol. They never share
        // live tool-step frames, receipts, history, search, unread or storage.
        if (conn.client !== "engine") throw new Error("only the engine can stream an agent response");
        const event = frame.event;
        // A size violation can arrive after a valid start.  Refuse it with a
        // terminal projection before rejecting the frame so clients cannot be
        // left showing an immortal spinner.  Build the lookup only from the
        // active relay state; malformed caller fields are never projected.
        const candidate = event as Partial<AgentResponseStreamEvent>;
        if (candidate.kind === "response-delta" && typeof candidate.text === "string"
          && typeof candidate.channelId === "string" && typeof candidate.triggerMessageId === "string"
          && typeof candidate.agentId === "string" && typeof candidate.turnId === "string") {
          const violationKey = responseStreamKey(
            conn.userId, candidate.channelId, candidate.triggerMessageId, candidate.agentId, candidate.turnId,
          );
          const violationActive = this.responseStreams.get(violationKey);
          const violationChannel = violationActive ? this.store.channel(violationActive.channelId) : undefined;
          const tooLarge = candidate.text.length > RESPONSE_STREAM_LIMITS.deltaChars
            || Boolean(violationActive && violationActive.totalChars + candidate.text.length > RESPONSE_STREAM_LIMITS.totalChars);
          if (tooLarge && violationActive && violationActive.source === conn.ws && violationChannel) {
            this.failResponseStream(violationChannel, {
              kind: "response-delta", channelId: violationActive.channelId,
              triggerMessageId: violationActive.triggerMessageId, agentId: violationActive.agentId,
              turnId: violationActive.turnId, seq: violationActive.lastSeq + 1, at: Date.now(),
            }, "response preview reached its size limit", violationKey);
            break;
          }
        }
        const bad = validateAgentResponseStream(event);
        if (bad) throw new Error(bad);
        const agent = this.myAgent(conn.userId, event.agentId);
        const message = this.messageFor(conn.userId, event.triggerMessageId);
        if (message.channelId !== event.channelId) throw new Error("no such message");
        const ch = this.store.channel(message.channelId);
        if (ch?.archivedAt) throw new Error("that conversation is archived — response previews are closed");
        if (!ch || !ch.memberIds.includes(agent.id)) throw new Error("that agent is not in this conversation");
        const slot = responseStreamSlot(conn.userId, message.channelId, message.id, agent.id);
        const key = responseStreamKey(conn.userId, message.channelId, message.id, agent.id, event.turnId);
        const now = Date.now();
        let active = this.responseStreams.get(key);
        // A second turn for the same trigger is not allowed to overwrite the
        // first. Stale/cross-turn frames are dropped without projection.
        const priorKey = this.responseStreamSlots.get(slot);
        if (event.kind === "response-start") {
          if (event.seq !== 0) throw new Error("a response stream must start at sequence zero");
          if (this.responseStreamRecentlyEnded(key, now)) break;
          if (priorKey && priorKey !== key) break;
          if (active) break; // idempotent duplicate start
          if (this.responseStreams.size >= RESPONSE_STREAM_LIMITS.maxActiveStreams) {
            this.failResponseStream(ch, event, "too many live response previews");
            break;
          }
          active = {
            source: conn.ws,
            ownerId: conn.userId, channelId: message.channelId,
            triggerMessageId: message.id, agentId: agent.id, turnId: event.turnId,
            lastSeq: 0, seenSeq: new Set([0]), totalChars: 0, eventTimes: [now],
          };
          active.timer = setTimeout(() => {
            if (this.responseStreams.get(key) !== active) return;
            this.tombstoneResponseStream(key);
            this.responseStreams.delete(key);
            if (this.responseStreamSlots.get(slot) === key) this.responseStreamSlots.delete(slot);
          }, RESPONSE_STREAM_LIMITS.staleMs);
          (active.timer as unknown as { unref?: () => void }).unref?.();
          this.responseStreams.set(key, active);
          this.responseStreamSlots.set(slot, key);
        } else {
          // A second engine socket may know the same owner/turn ids, but it is
          // not the process that opened this preview. Never let it inject a
          // delta or terminal frame into the source-bound stream.
          if (!active || priorKey !== key || active.source !== conn.ws) break;
          active.eventTimes = active.eventTimes.filter(at => now - at < 1_000);
          if (active.eventTimes.length >= RESPONSE_STREAM_LIMITS.eventsPerSecond) {
            this.failResponseStream(ch, event, "response preview was rate-limited", key);
            break;
          }
          active.eventTimes.push(now);
          if (active.seenSeq.has(event.seq)) break; // duplicate; out-of-order is safe
          if (event.kind === "response-delta") {
            const chars = event.text?.length ?? 0;
            if (chars > RESPONSE_STREAM_LIMITS.deltaChars
              || active.totalChars + chars > RESPONSE_STREAM_LIMITS.totalChars) {
              this.failResponseStream(ch, event, "response preview reached its size limit", key);
              break;
            }
            active.totalChars += chars;
          }
          active.seenSeq.add(event.seq);
          active.lastSeq = Math.max(active.lastSeq, event.seq);
          // Activity extends the lease; a long but live answer must not be
          // mistaken for a stale preview. The timer is still a hard backstop
          // when the engine/socket dies silently.
          if (active.timer) clearTimeout(active.timer);
          active.timer = setTimeout(() => {
            if (this.responseStreams.get(key) !== active) return;
            this.tombstoneResponseStream(key);
            this.responseStreams.delete(key);
            if (this.responseStreamSlots.get(slot) === key) this.responseStreamSlots.delete(slot);
          }, RESPONSE_STREAM_LIMITS.staleMs);
          (active.timer as unknown as { unref?: () => void }).unref?.();
        }
        const projected: AgentResponseStreamEvent = {
          ...event,
          channelId: ch.id, triggerMessageId: message.id, agentId: agent.id,
          at: now,
        };
        this.toChannel(ch, { type: "agentResponse", stream: projected });
        if (event.kind === "response-final" || event.kind === "response-cancel" || event.kind === "response-fail") {
          if (active?.timer) clearTimeout(active.timer);
          this.tombstoneResponseStream(key, now);
          this.responseStreams.delete(key);
          if (this.responseStreamSlots.get(slot) === key) this.responseStreamSlots.delete(slot);
        }
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
        this.store.clearMessageReceipts(message.id);
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
        // Echo the desktop's request identity when present. Older clients do
        // not send one, so the optional field keeps the wire compatible while
        // modern clients can never settle a later queued upload with a late
        // answer from this one.
        send(conn.ws, {
          type: "attachment", attachment,
          ...(frame.requestId !== undefined ? { requestId: frame.requestId } : {}),
        });
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
        // Canvas artifact links use the same per-reader ACL. Re-project every
        // affected project after the access decision changes.
        for (const project of this.store.projectsAll()) this.pushCanvasProject(project);
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
        let ts = typeof frame.ts === "number" ? frame.ts : Date.now();
        let messageId = frame.messageId;
        const latest = this.store.history(channel.id, {}, MESSAGE_LIMITS.page).items.at(-1);
        if (latest && (ts > latest.ts || (ts === latest.ts && messageId !== undefined && messageId > latest.id))) {
          // A stale/future viewport cannot mark an unseen future message read;
          // clamp to the newest authorized message instead of trusting a clock.
          ts = latest.ts; messageId = latest.id;
        }
        const lastReadTs = this.store.markRead(conn.userId, channel.id, ts, messageId);
        const cursor = this.store.lastReadCursor(conn.userId, channel.id);
        const entry: UnreadEntry = {
          channelId: channel.id, lastReadTs, ...(cursor.id ? { lastReadId: cursor.id } : {}),
          ...this.store.unreadFor(conn.userId, channel.id, this.myIds(conn.userId)),
        };
        // EVERY machine this person is signed in on, which is the whole point
        this.toUser(conn.userId, { type: "read", entry });
        break;
      }
      case "listSaved": {
        this.tellSaved(conn.userId, frame.requestId, conn, frame);
        break;
      }
      case "listChannelPins": {
        const channel = this.channelFor(conn.userId, frame.channelId);
        if (channel.kind === "dm") throw new Error("direct conversations do not have shared pins");
        const page = this.store.channelPinsPage(channel.id, frame.limit, frame.beforePinnedAt, frame.beforeMessageId);
        send(conn.ws, {
          type: "channelPins", channelId: channel.id,
          entries: page.entries.map(row => this.channelPinProjection(conn.userId, row)),
          revision: this.store.channelPinsRevision(channel.id), hasMore: page.hasMore,
          ...(page.nextPinnedAt !== undefined ? { nextPinnedAt: page.nextPinnedAt } : {}),
          ...(page.nextMessageId !== undefined ? { nextMessageId: page.nextMessageId } : {}),
          ...(frame.requestId ? { requestId: frame.requestId } : {}),
        });
        break;
      }
      case "pinMessage": {
        // Authenticate the room and source BEFORE consulting the retry ledger.
        // A stale receipt must never become a side channel after membership or
        // channel kind changes.
        const channel = this.adminChannel(conn.userId, frame.channelId);
        if (channel.kind === "dm") throw new Error("direct conversations do not have shared pins");
        const message = this.messageFor(conn.userId, frame.messageId);
        if (message.channelId !== channel.id) throw new Error("that message is not in this channel");
        const status = frame.requestId
          ? this.store.channelPinMutationStatus(conn.userId, frame.requestId, "pinMessage", channel.id, message.id)
          : undefined;
        if (status === "conflict") throw new Error("that channel pin request id was already used for a different pin");
        if (status === "replay") {
          this.tellChannelPins(channel, frame.requestId, conn);
          break;
        }
        if (channel.archivedAt) throw new Error("that conversation is archived");
        if (message.deletedAt) throw new Error("that message was deleted");
        this.store.pinChannelMessage(conn.userId, channel.id, message.id, frame.requestId);
        this.tellChannelPins(channel, frame.requestId, conn);
        break;
      }
      case "unpinMessage": {
        const channel = this.adminChannel(conn.userId, frame.channelId);
        if (channel.kind === "dm") throw new Error("direct conversations do not have shared pins");
        const message = this.messageFor(conn.userId, frame.messageId);
        if (message.channelId !== channel.id) throw new Error("that message is not in this channel");
        const status = frame.requestId
          ? this.store.channelPinMutationStatus(conn.userId, frame.requestId, "unpinMessage", channel.id, message.id)
          : undefined;
        if (status === "conflict") throw new Error("that channel pin request id was already used for a different removal");
        if (status === "replay") {
          this.tellChannelPins(channel, frame.requestId, conn);
          break;
        }
        this.store.unpinChannelMessage(conn.userId, channel.id, message.id, frame.requestId);
        this.tellChannelPins(channel, frame.requestId, conn);
        break;
      }
      case "saveMessage": {
        const note = frame.note === undefined ? undefined : String(frame.note).trim();
        if (note !== undefined && note.length > 2000) throw new Error("that note is too long (max 2000 characters)");
        if (frame.requestId) {
          const status = this.store.savedMutationStatus(conn.userId, frame.requestId, "saveMessage", frame.messageId, undefined, note, frame.remindAt);
          if (status === "conflict") throw new Error("that saved request id was already used for a different save");
          if (status === "replay") {
            this.tellSaved(conn.userId, frame.requestId, conn);
            break;
          }
        }
        // Validate only a new mutation. A canonical replay must remain a
        // replay even after time moves past its reminder horizon.
        if (frame.remindAt !== undefined && (!Number.isSafeInteger(frame.remindAt) || frame.remindAt < 0
          || frame.remindAt > Date.now() + SAVED_REMINDER_HORIZON_MS)) {
          throw new Error("that reminder date is not valid or is more than five years away");
        }
        const message = this.messageFor(conn.userId, frame.messageId);
        if (message.deletedAt) throw new Error("that message was deleted");
        this.store.saveSavedMessage(conn.userId, message.id, message.channelId, note, frame.remindAt, frame.requestId);
        this.tellSaved(conn.userId, frame.requestId, conn);
        break;
      }
      case "unsaveMessage": {
        if (frame.requestId) {
          const status = this.store.savedMutationStatus(conn.userId, frame.requestId, "unsaveMessage", frame.messageId);
          if (status === "conflict") throw new Error("that saved request id was already used for a different removal");
          if (status === "replay") {
            this.tellSaved(conn.userId, frame.requestId, conn);
            break;
          }
        }
        this.store.unsaveMessage(conn.userId, frame.messageId, frame.requestId);
        this.tellSaved(conn.userId, frame.requestId, conn);
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
    // Checkpoint only the public facts we observed. Session ids are retained
    // as capability metadata, never as an assertion that arbitrary provider
    // state can be resumed.
    this.store.saveCheckpoint(buildRunCheckpoint(cleaned, {
      branch: cleaned.branch, commit: cleaned.commit, files: cleaned.files,
      artifacts: cleaned.artifacts,
      priorRunId: cleaned.priorRunId,
      providerSession: cleaned.sessionId ? {
        provider: cleaned.provider, sessionId: cleaned.sessionId, canResume: false,
        actionSemantics: "unknown", reason: "the provider did not report a safe recovery capability",
      } : undefined,
    }), { agentId: agent.id, ownerId: agent.ownerId, ...(channelId ? { channelId } : {}) });

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
    const recovery: ServerFrame = {
      type: "runRecovery", runId: row.record.id,
      decision: recoveryDecision(row.record,
        this.store.checkpointForRun(row.record.id, row.agentId, row.ownerId)),
    };
    const channel = row.channelId ? this.store.channel(row.channelId) : undefined;
    if (!channel) {
      this.toUser(row.ownerId, frame);
      this.toUser(row.ownerId, recovery);
      return;
    }
    const audience = this.audienceFor(channel);
    // the owner hears about their own agent's work even if they have since
    // left the room it happened in
    audience.add(row.ownerId);
    for (const conn of this.conns) {
      if (!audience.has(conn.userId)) continue;
      send(conn.ws, frame);
      // Recovery mutates the owner's agent and is never offered to room guests.
      if (conn.userId === row.ownerId) send(conn.ws, recovery);
    }
  }

  private recoveryChallengeKey(requesterId: ID, requestId: ID): string {
    return `${requesterId}:${requestId}`;
  }

  /**
   * The approval card is durable, but the in-memory execution handoff is not.
   * On a relay restart, never leave an approved card suggesting that a retry
   * ran. Settle every recovery card and its receipt as a durable refusal; the
   * owner can explicitly start a fresh challenge afterwards.
   */
  private settleInterruptedRecoveryApprovals(): Approval[] {
    const settled: Approval[] = [];
    const now = Date.now();
    for (const approval of this.store.approvals(1000)) {
      if (!approval.recoveryRequestId || (approval.status !== "pending" && approval.status !== "approved")) continue;
      const receipt = this.store.recoveryReceipt(approval.ownerId, approval.recoveryRequestId);
      // Approval rows and receipts are written separately. If the process
      // stopped between those writes, there is no request payload from which
      // to reconstruct an engine frame; still settle the approval durably so
      // it cannot remain an apparently actionable card forever.
      approval.status = "expired";
      approval.decidedAt = now;
      if (!receipt) approval.detail = "Cloud9 restarted before recovery could be reconstructed";
      this.store.saveApproval(approval);
      if (receipt && (receipt.status === "pending" || receipt.status === "accepted")) {
        this.store.saveRecoveryReceipt({
          request: receipt.request, payloadFingerprint: recoveryRequestFingerprint(receipt.request),
          status: "refused", reason: "Cloud9 restarted before recovery could be executed", createdAt: receipt.createdAt,
        });
      }
      settled.push(approval);
    }
    return settled;
  }

  private recoveryChallengeFingerprint(request: RecoveryRequest): string {
    return recoveryRequestFingerprint({
      ...request, payload: { ...request.payload, approvalEpoch: "" },
    });
  }

  private pruneRecoveryChallenges(now = Date.now()): void {
    for (const [key, challenge] of this.recoveryChallenges) {
      if (challenge.createdAt < now - RECOVERY_CHALLENGE_TTL_MS) this.recoveryChallenges.delete(key);
    }
    const overflow = [...this.recoveryChallenges.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(RECOVERY_CHALLENGE_LIMIT);
    for (const challenge of overflow) {
      this.recoveryChallenges.delete(this.recoveryChallengeKey(challenge.requesterId, challenge.requestId));
    }
  }

  private issueRecoveryChallenge(request: RecoveryRequest): string {
    const now = Date.now();
    this.pruneRecoveryChallenges(now);
    const key = this.recoveryChallengeKey(request.requesterId, request.requestId);
    const prior = this.recoveryChallenges.get(key);
    if (prior && prior.payloadFingerprint === this.recoveryChallengeFingerprint(request)) return prior.token;
    const token = secureId("recovery");
    this.recoveryChallenges.set(key, {
      token, requesterId: request.requesterId, requestId: request.requestId,
      payloadFingerprint: this.recoveryChallengeFingerprint(request), createdAt: now,
    });
    this.pruneRecoveryChallenges(now);
    return token;
  }

  private consumeRecoveryChallenge(request: RecoveryRequest): boolean {
    const key = this.recoveryChallengeKey(request.requesterId, request.requestId);
    const challenge = this.recoveryChallenges.get(key);
    if (!challenge || challenge.createdAt < Date.now() - RECOVERY_CHALLENGE_TTL_MS) return false;
    if (challenge.payloadFingerprint !== this.recoveryChallengeFingerprint(request)
      || challenge.token !== request.payload.approvalEpoch) return false;
    this.recoveryChallenges.delete(key);
    return true;
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

  private postMessage(message: Message, tempId?: string, requestId?: ID, draftOwnerId?: ID,
    draftThreadId?: ID, attachmentIds?: readonly ID[], clientMessageId?: ID,
    payloadHash?: string): { message: Message; replayed: boolean; draftRemoved: boolean } {
    const ch = this.store.channel(message.channelId);
    if (!ch) throw new Error("no such channel");
    // Capture the thread as it stood BEFORE this reply landed. That timing is
    // part of the recipient rule: a newly participating reply must not notify
    // every older message retroactively.
    const priorReplies = message.replyTo
      ? this.store.thread(message.replyTo).filter(m => m.id !== message.id)
      : [];
    const saved = draftOwnerId
      ? this.store.saveMessageAndRemoveDraft(message, draftOwnerId, draftThreadId,
        attachmentIds, clientMessageId, payloadHash)
      : (this.store.saveMessage(message), { message, replayed: false, draftRemoved: false });
    if (saved.replayed) return saved;
    message = saved.message;
    this.recordMessageNotifications(ch, message, priorReplies);
    // A reply bumps the CACHED count on the message that started the thread, and
    // everyone watching is told the root changed — otherwise "12 replies" would
    // only appear after a reload.
    if (message.replyTo) {
      const root = this.store.bumpReplyCount(message.replyTo, message.ts, message.authorId, message.id);
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
      send(conn.ws, { type: "message", message, tempId, ...(conn.userId === message.authorId && requestId ? { requestId } : {}) });
      // proactive agent messages become notifications on mobile clients
      if (message.proactive && conn.client === "mobile") {
        send(conn.ws, { type: "push", message });
      }
    }
    if (message.authorKind === "human") this.pushMessageStatus(message.authorId, message);
    if (draftOwnerId && saved.draftRemoved) {
      this.toUser(draftOwnerId, {
        type: "draftRemoved", channelId: message.channelId,
        ...(draftThreadId ? { threadId: draftThreadId } : {}),
      });
    }
    // push log for offline members (APNs delivery later)
    if (message.proactive) {
      const online = new Set([...this.conns].map(c => c.userId));
      for (const uid of memberUserIds) {
        if (!online.has(uid)) this.store.logPush(uid, message.id);
      }
    }
    return saved;
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
    this.broadcastChannelMemoryPolicies(channel);
    // Channel membership is also the access boundary for linked Canvases.
    // Re-project them after every add/join/remove/leave broadcast so a window
    // never keeps an old list after its room visibility changes.
    for (const project of this.store.projectsAll()) {
      if (project.channelId === channel.id) this.pushCanvasProject(project);
    }
  }

  private broadcastChannelMemoryPolicies(channel: Channel): void {
    const policies = this.store.channelMemoryPolicies(channel.id);
    this.toChannel(channel, { type: "channelMemoryPolicies", channelId: channel.id, policies });
  }

  /** Membership roles are UI permissions too, so every open member view must
   * receive the authoritative rows when an owner changes somebody's role. */
  private broadcastChannelMembers(channelId: ID): void {
    const channel = this.store.channel(channelId);
    if (!channel) return;
    const members = this.store.channelMembers(channelId);
    const audience = this.audienceFor(channel);
    for (const conn of this.conns) {
      if (audience.has(conn.userId)) send(conn.ws, { type: "channelMembers", channelId, members });
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

  /** The engine's HookBook is a live projection of this durable owner list. */
  private syncHooksToEngine(userId: ID): void {
    this.toEngines(userId, { type: "hooksUpdated", hooks: this.store.hooksOf(userId) });
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

  private toUserExcept(userId: ID, except: Conn, frame: ServerFrame): void {
    for (const conn of this.conns) {
      if (conn !== except && conn.userId === userId) send(conn.ws, frame);
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
