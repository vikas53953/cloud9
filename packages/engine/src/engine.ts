// The Cloud9 agent engine host. A plain Node WS client of the relay — no
// Electron imports — so it can be lifted onto an always-on server unchanged
// (Stage-1 decision 5).
import fs from "node:fs";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import WebSocket from "ws";
import {
  AgentDef, AgentSchedule, Approval, ARTIFACT_LIMITS, ATTACHMENT_LIMITS,
  Channel, ClientFrame, HarnessName, HarnessState, ID,
  ChannelMemoryPolicy, ChannelMemoryMode, defaultChannelMemoryMode,
  channelMemoryMaySave, channelMemoryMayUse,
  Message, Project, ReceiptStage, ReceiptVerdict, RemoteActionFacts, RunRecord, ServerFrame,
  Task, TaskStatus, WorkReaction,
  WorldState, describeRemoteAction, isSafeFileName,
  mayDriveAgent, shareableRun, validateAgentInput, validateTaskSummary,
  LIVE_STEPS_PER_BATCH, RUN_LIMITS, RunStep, trustLevel, trustOf,
  // GAP A/B/C (spending limits, show-me-the-plan, stand-in models, 2026-08-05)
  AgentSpendCap, SpendCapWhich, decideSpend, fallbackModelsOf, fellBackTo, fellBackWords,
  providerCanBeCapped, showsPlanFirst, spendCapOf, spendCapStopWords, tidyPlan,
  // SPENDING BLOCK (what the crew costs, 2026-08-07): the arithmetic, the words
  // and the closed list of changes an agent may offer all live in shared, so the
  // engine, the hub and the window cannot end up with three opinions about the
  // same money.
  humanMoney, findWaste, narrowingOnly, renderTokenUseReport, rollUpTokenUse, tidySaving,
  RESPONSE_STREAM_LIMITS, type AgentResponseStreamKind, RecoveryRequest,
} from "@cloud9/shared";
import { approvalsFor, needsApprovalToRun } from "./abilities.js";
// WHOSE SETUP EACH TURN RUNS IN — the same one owner both harnesses read, asked
// here only so the run record can say afterwards which mode a turn was in.
import { usesOwnerSetup } from "./ownersetup.js";
// `Cloud9RememberAnswer` is the gap-A addition (agent-written memory, 2026-08-05).
import {
  Cloud9AttachmentAnswer, Cloud9RememberAnswer, Cloud9SearchAnswer,
  // ===== GAP B BLOCK (skills on demand, 2026-08-05) =====
  Cloud9SkillAnswer,
  // ===== SPENDING BLOCK (what the crew costs, 2026-08-07) =====
  Cloud9SavingAnswer, Cloud9SpendingAnswer,
} from "./cloud9tools.js";
import { openAttachmentInConversation } from "./attachmentreach.js";
import {
  ConversationBudget, CONVERSATION_BUDGET, conversationBudgetFor,
  maxConversationMessages, renderConversation,
} from "./context.js";
import { OpenTurn, ToolBridge } from "./toolbridge.js";
import { ArtifactSweep, describeRefusals, sweepProduced } from "./artifacts.js";
import { ApprovalDesk, ApprovalOutcome, ApprovalWaitChange } from "./approvaldesk.js";
import { GitHubClient, GitHubOptions } from "./github.js";
import { BrakeConfig, DEFAULT_BRAKE, isBraked, shouldReply } from "./chatter.js";
import {
  ClaudeProvider, HarnessUnavailableError, InstructionsNotSavedError, MockProvider,
  PlanNotOfferedError, redactForSharing, sanitizeForChat, SpendCapReachedError, ThreadContinuity,
} from "./provider.js";
import { sessionKeyId } from "./sessionresume.js";
import { PendingAsk, rememberAsk, takeAsk, workEmoji } from "./reactions.js";
import { TurnFacts, turnVerdict } from "./receipts.js";
// ---- HOOKS + VERIFICATION (the two harness pieces Cloud9 did not have) ----
// `hooks.ts` decides WHETHER an owner's rule may act; this file is only ever
// the thing that reports a fact to it and does the four actions. `verify.ts` is
// a pure function over the run record — no model, no second opinion.
import { HookBook, type Hook, type HookFact } from "./hooks.js";
import { verifyTurn } from "./verify.js";
import { describeRepoTurn, repoTurn, RepoTurnResult } from "./repowork.js";
import { GitWorkspace, Worktree } from "./worktree.js";
import { GitHubWriteRequest, GitHubWriteRequestWithoutRepo, runGitHubWrite } from "./githubwrite.js";
import { buildRunRecord, newRunId, ProviderTrace, RunFinish, RunKind, RunSeed } from "./runrecord.js";
import { RunStore } from "./runstore.js";
import {
  MemoryStore, MemoryKind, MemoryNote, MEMORY_NOTES_PER_TURN, newMemoryId,
  retrieveMemory, worthRemembering,
} from "./agent-memory.js";
import { AgentHandoff, buildHandoff, HandoffError } from "./agent-handoff.js";
import { isScheduleWhen, Scheduler } from "./scheduler.js";
import { taskTldr } from "./tldr.js";
import { roomLineForThreadJob, threadOf } from "./threads.js";
import { sweepPendingTree, writeWholeFile } from "./wholefile.js";
// GAP C (stopping a running turn, 2026-08-05). `run.ts` owns the pid and owns
// `killTree`; the engine only ever opens a scope around a turn and asks it to stop.
import { newStopScope, withStopScope } from "./run.js";

/**
 * THE OWNER STOPPED THIS TURN — and it is THROWN, not returned.
 *
 * WHY A THROW (2026-08-06, measured on the installed app). `respondAs` used to
 * hand a stopped turn back as an ordinary string. Every caller then wrote it
 * down as an ordinary answer: a stopped background job was marked `completed`,
 * his own message wore a ✅, and the room said "🧵 Finished in the thread".
 * The run record underneath said `cancelled` all along — but the only place
 * that word appeared was a card inside a thread panel he had not opened. So he
 * pressed Stop and the app told him the work had finished normally, which is
 * the exact confusion the Stop button exists to prevent.
 *
 * A thrown ending cannot be mistaken for an answer. Anything that runs a turn
 * either handles this on purpose or falls into its own "did not finish" path —
 * never into "finished". `said` is the agent's own sentence about the stop, so
 * a caller that just wants words has them without inventing any.
 */
export class TurnStoppedError extends Error {
  readonly said: string;
  constructor(said: string) {
    super("you stopped this run");
    this.name = "TurnStoppedError";
    this.said = said;
  }
}

/**
 * What an agent says when a turn ended badly.
 *
 * ONE PLACE, because there are three endings and only two used to be told
 * apart. A stop is the OWNER'S doing and speaks in the agent's own words; a
 * real failure still goes through the safe-words rule that strips paths, argv
 * and anything secret-shaped.
 */
function saidWhenTurnEnded(err: unknown, where: string): string {
  return err instanceof TurnStoppedError ? err.said : sanitizeForChat(err, where);
}

export interface EngineOptions {
  relayUrl: string;      // ws://host:port
  token: string;         // this user's relay token
  /** runs agents whose provider is "claude" (the default) */
  provider?: ClaudeProvider;
  /** runs agents whose provider is "codex" — absent means Codex isn't connected */
  codexProvider?: ClaudeProvider;
  /**
   * Demo mode: agents answer with canned replies and no harness is needed.
   * Must be asked for explicitly — a signed-out harness must never quietly
   * turn into fake answers that look real.
   */
  demoMode?: boolean;
  dataDir?: string;      // schedules + per-agent working folders
  brake?: BrakeConfig;
  contextMessages?: number;
  maxConcurrentTurns?: number;
  /** how many run records to keep per agent before the oldest are deleted */
  keepRunsPerAgent?: number;
  /** how many memory notes to keep per agent on disk before the oldest are pruned */
  keepMemoryPerAgent?: number;
  /**
   * How the read-only half of GitHub is reached — the `gh` command and the
   * runner. Only ever used WITHOUT an approver, so nothing built from it can
   * change anything on GitHub. Tests point it at a fake runner.
   */
  github?: Omit<GitHubOptions, "approve">;
  /**
   * THE CHECKOUT ON THIS COMPUTER that agents work in when someone says
   * `!code …`. Absent means no agent can work in a repository, and an agent
   * asked to says exactly that rather than inventing a folder.
   *
   * It is a local folder, not `owner/name`: a Cloud9 PROJECT names a repository
   * on GitHub and nothing yet records where its code is on this machine. That
   * gap is written down in `docs/plans/projects-handoff.md`; until it closes,
   * the person launching the engine says which folder, once.
   */
  repoDir?: string;
}

// ===== GAP C BLOCK (stopping a running turn, 2026-08-05) — start =====
/**
 * ONE TURN THAT IS RUNNING RIGHT NOW, and the handle that kills it.
 *
 * It carries the agent's NAME as well as its id because the sentence the room
 * gets is written from this row, and looking the name up again afterwards would
 * mean an agent renamed mid-turn is reported under the wrong one.
 */
export interface LiveTurn {
  agentId: ID;
  agentName: string;
  channelId?: ID;
  startedAt: number;
  /** kills every child process this turn started — `run.ts` owns the killing */
  scope: { stop(): void; readonly stopped: boolean };
  abortController?: AbortController;
}
// ===== GAP C BLOCK — end =====

/** Everything a turn needs, plus who is asking and on whose behalf. */
/**
 * WHICH OF HIS TWO LIMITS THE HARNESS ACTUALLY HIT.
 *
 * Only ONE number goes to the harness — the smaller of "the most one job may
 * cost" and "what is left of the month" — so when it fires, this works back to
 * which of the two that number came from. It matters because the two have
 * different answers: a job limit is raised on the agent, a month that is spent
 * either waits or is raised.
 *
 * The tie is given to the JOB limit, because that is the one he can act on
 * straight away — and when both are the same number, both sentences are true.
 */
function spendCapWhichFired(cap: AgentSpendCap, turnCapUsd: number | undefined): SpendCapWhich {
  if (typeof turnCapUsd !== "number") return "perMonth";
  return cap.perJobUsd === turnCapUsd ? "perJob" : "perMonth";
}

export interface TurnInput {
  context: string;
  trigger: string;
  triggerAuthor: string;
  /** chat reply, delegated job, or scheduled check-in — recorded on the run */
  kind?: RunKind;
  channelId?: ID;
  taskId?: ID;
  requesterKind?: "human" | "agent" | "schedule";
  /**
   * THE THREAD THIS TURN IS ANSWERING IN, or absent for the main room.
   *
   * It rides on the turn rather than on each message the turn happens to send,
   * so everything one turn says — the answer, the honest failure sentence, a
   * refused file — lands in the same place. `threads.ts` owns the rule that
   * fills it in.
   */
  replyTo?: ID;
  /**
   * Where the turn happens. Absent — every ordinary turn — means the agent's
   * own folder. Set only for a turn working inside its own git worktree.
   */
  workdir?: string;
  /**
   * THE MESSAGE THAT TRIGGERED THIS TURN — the one the semantic receipts
   * (👀 / 💭 / a verdict) are drawn on.
   *
   * ABSENT IS A REAL ANSWER AND MUST STAY CHEAP: a scheduled check-in and any
   * other proactive turn is answering nobody, so there is no message to signal
   * on and NO RECEIPTS ARE SENT AT ALL. Inventing one (the last message in the
   * room, say) would put "Scout is reading this" on something Scout was never
   * asked about.
   */
  triggerMessageId?: ID;
  /**
   * THE THREAD THIS TURN CONTINUES, for the harness's own session
   * (`sessionresume.ts`).
   *
   * OFFERED, NOT DECIDED. The engine can say "this turn belongs to thread X and
   * here is how to render only what is new"; whether the session is really
   * continued depends on the folder the turn runs in and on what the command
   * line will really grant, and only the provider knows those. A provider that
   * ignores it runs exactly today's cold turn.
   *
   * Absent for every turn that has no thread of its own — a scheduled check-in,
   * a proactive line, a received handoff.
   */
  thread?: ThreadContinuity;
  /**
   * THIS TURN IS THE AGENT WRITING A PLAN, not doing the work.
   *
   * Set only by `planFirstTurn`, which is the one place a plan is ever asked
   * for. The turn runs read-only, its answer IS the plan, and it is recorded as
   * a plan rather than as the job.
   */
  planOnly?: boolean;
  /** Public link back to a failed/cancelled/refused run being recovered. */
  priorRunId?: ID;
}

export class Engine {
  ws?: WebSocket;
  state?: WorldState;
  /** the Claude-side provider (SdkProvider live, MockProvider in demo mode) */
  provider?: ClaudeProvider;
  /** the Codex-side provider — undefined until Codex is signed in */
  codexProvider?: ClaudeProvider;
  /**
   * True when this engine may answer with canned replies. It is reported to
   * every client on the harness state, so demo mode is always VISIBLE — it can
   * never be a silent property of how the app happened to be launched.
   */
  demoMode: boolean;
  dataDir: string;
  brake: BrakeConfig;
  schedules: AgentSchedule[] = [];
  scheduler: Scheduler;
  /**
   * What each agent actually did, turn by turn. Kept in the agent's own folder
   * so it survives the app closing (FR-AU-003, FR-TL-003).
   */
  runs: RunStore;
  /**
   * WHAT EACH AGENT REMEMBERS BETWEEN CONVERSATIONS. Durable, per-agent,
   * bounded — the same folder-per-agent decision as `runs`. This is the ONE
   * persistence path for memory (docs/plans/agent-memory-handoff.md §7); the hub
   * only ferries the notes to the screen and never keeps its own copy.
   */
  memory: MemoryStore;
  /** the record this engine wrote most recently — the newest run, in memory */
  lastRun?: RunRecord;
  /** told about every run as it finishes, so a host can forward it to clients */
  onRunRecorded?: (record: RunRecord) => void;
  /**
   * THE OWNER'S OWN HOOKS — "when this happens, do that" (`hooks.ts`).
   *
   * ABSENT MEANS NOTHING EVER FIRES, and that is the default: an engine with no
   * book set behaves exactly as it did before hooks existed. Set by whoever
   * launches the engine (`hookwiring.ts` does it in one call).
   */
  hooks?: HookBook;
  /**
   * CHECK WHAT AN AGENT SAID AGAINST WHAT IT DID, after every turn
   * (`verify.ts`). Off unless asked for, and even when on it says nothing
   * unless a claim and the record really disagree.
   */
  verifyClaims = false;
  private history = new Map<ID, Message[]>();
  tasks = new Map<ID, Task>();
  private claimed = new Set<ID>();
  /**
   * Jobs asked for in a message whose task the hub has not minted yet, and then
   * the answer: which message each job's ticks belong on. Both are small,
   * capped, and in memory only — a tick is a nice-to-have, never a record.
   */
  private pendingAsks: PendingAsk[] = [];
  private askMessageFor = new Map<ID, ID>();
  /**
   * And WHERE each job was asked for: the thread it belongs to, for the jobs
   * that were asked for inside one. A job asked for in the room is simply not
   * in here, which is how the room case stays exactly as it was.
   */
  private askThreadFor = new Map<ID, ID>();
  /**
   * AGENTS STANDING AT THE GATE. One per thing an agent has asked to do that
   * would leave this computer, waiting on his answer without holding anything
   * up. See `approvaldesk.ts` — the engine keeps working while they wait, and
   * silence is never a yes.
   */
  approvals: ApprovalDesk;
  /**
   * CLOUD9'S OWN TOOLS, and the turns that currently hold a ticket to them.
   * See `toolbridge.ts` — loopback only, one secret per turn, forgotten when the
   * turn ends.
   */
  tools = new ToolBridge();
  /**
   * THE PROJECTS THIS OWNER HAS CONNECTED, as the hub last told us.
   *
   * Kept only so `repoDirFor` can answer "where does the code for THIS
   * conversation live on this computer". It is a COPY of the hub's truth and
   * never a permission: nothing here decides what an agent may do, only which
   * folder it would work in if it were allowed to.
   */
  projects = new Map<ID, Project>();
  /** whoever is waiting on a `searchResults` frame right now */
  private searchWaiters = new Set<(f: Extract<ServerFrame, { type: "searchResults" }>) => boolean>();
  /**
   * Whoever is waiting on an `attachmentTicket` frame right now — an agent that
   * asked to open a file somebody attached in the room it is standing in.
   * Same shape as the search waiters above, and for the same reason: one frame
   * out, one frame back, never waiting for ever.
   */
  private attachmentWaiters =
    new Set<(f: Extract<ServerFrame, { type: "attachmentTicket" }>) => boolean>();
  private turnsInFlight = 0;
  /** The queue turn currently executing, propagated through provider awaits. */
  private turnContext = new AsyncLocalStorage<string>();
  /** Active queue turns and the approval waits each one owns. */
  private activeTurnTokens = new Set<string>();
  private turnOwners = new Map<string, ID>();
  private parkedWaits = new Map<string, string>();
  private nextTurnToken = 0;
  /** Approval IDs already announced as stale, persisted across reconnects/restarts. */
  private lateWarningIds = new Set<ID>();
  private lateWarningPath: string;
  // ===== GAP C BLOCK (stopping a running turn, 2026-08-05) — start =====
  /**
   * EVERY TURN CURRENTLY RUNNING, and the handle that stops it.
   *
   * One set for the whole engine rather than one per agent, because "stop"
   * arrives naming an agent and has to find whatever that agent has running —
   * a chat turn, a background job, repository work — without each kind of turn
   * having to remember to register itself somewhere different. They all go
   * through `respondAs`, so they all end up here.
   */
  private liveTurns = new Set<LiveTurn>();
  // ===== GAP C BLOCK — end =====
  /** queued work, each tagged with whose turn it is so a stop can drop it */
  private queue: { job: () => Promise<void>; agentId?: ID; onDropped?: () => void }[] = [];
  private opts: EngineOptions;
  private stopped = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  onReady?: () => void;
  /** the engine host answers these — it owns the local CLIs */
  onHarnessRequest?: (
    action: "status" | "signIn" | "cancel" | "githubSignIn", harness?: HarnessName,
  ) => void;
  /**
   * The real model list for a harness, supplied by the host from live detection.
   * Used at the LAST gate: an agent whose model isn't on its harness's list does
   * not get a turn, so an unknown id can never reach a command line.
   */
  harnessModels?: (harness: HarnessName) => string[];

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.demoMode = opts.demoMode === true;
    this.provider = opts.provider ?? (opts.demoMode ? new MockProvider() : undefined);
    this.codexProvider = opts.codexProvider ?? (opts.demoMode ? new MockProvider() : undefined);
    this.dataDir = opts.dataDir ?? path.join(process.cwd(), "cloud9-engine-data");
    this.lateWarningPath = path.join(this.dataDir, "late-approval-warnings.json");
    try {
      const saved = JSON.parse(fs.readFileSync(this.lateWarningPath, "utf8")) as unknown;
      if (Array.isArray(saved)) {
        for (const id of saved) if (typeof id === "string") this.lateWarningIds.add(id);
      }
    } catch { /* no file yet, or an interrupted write: no stale IDs to trust */ }
    this.brake = opts.brake ?? DEFAULT_BRAKE;
    fs.mkdirSync(this.dataDir, { recursive: true });
    // Clear up after the last time this was killed mid-write. A temporary file
    // holds bytes nobody was ever told about, so nothing can want it — but left
    // alone it sits in his data folder for ever, and a big one (a long run
    // record) sits there taking up room.
    //
    // EVERYWHERE, NOT THE TOP FLOOR. This used to sweep `dataDir` itself, which
    // covered the schedules and the model cache and missed the two folders
    // underneath: an agent's runs and — the one that matters — an agent's SKILL
    // files, which are instructions the CLI reads. Litter there is a
    // half-written instruction sitting in a folder an agent is pointed at.
    // Naming the folders is a list someone has to remember to extend, so this
    // walks everything the app writes under one root instead.
    sweepPendingTree(this.dataDir);
    this.runs = new RunStore({
      agentDataDir: this.agentDataDir,
      ...(opts.keepRunsPerAgent ? { keepPerAgent: opts.keepRunsPerAgent } : {}),
    });
    this.memory = new MemoryStore({
      agentDataDir: this.agentDataDir,
      ...(opts.keepMemoryPerAgent ? { keepPerAgent: opts.keepMemoryPerAgent } : {}),
    });
    this.approvals = new ApprovalDesk({
      send: frame => this.sendFrame(frame),
      // A TURN JUST PARKED, OR JUST STOPPED BEING PARKED — so how many turns are
      // really working has changed, and somebody in the queue may be able to go
      // now. Without this line the slot is freed on paper and nothing notices
      // until the next message happens to arrive. See `workingTurns`.
      onWaitingChanged: (change: ApprovalWaitChange) => {
        if (change.turnToken && this.activeTurnTokens.has(change.turnToken)) {
          if (change.type === "added") this.parkedWaits.set(change.askId, change.turnToken);
          else this.parkedWaits.delete(change.askId);
        }
        void this.drain();
      },
      currentTurnToken: agentId => this.currentTurnToken(agentId),
      // THE ONE PLACE A JOB IS REALLY STUCK. See `jobIsStuck` below.
      // AND the one place a hook can hear that somebody is waiting on HIM: the
      // sentence handed over is `describeRemoteAction`'s — counted facts, never
      // the agent's own words about itself.
      onWaitStart: w => {
        // A PLAN WAIT IS A WAIT LIKE ANY OTHER on this screen — the job has
        // stopped and he is the reason it can start again — but the words are
        // not `describeRemoteAction`'s, because nothing is leaving this
        // computer and saying so would be untrue.
        this.jobIsStuck(w.taskId, w.facts);
        this.fireHook({
          event: "approval.waiting", taskId: w.taskId,
          what: w.facts
            ? `waiting for your OK to ${describeRemoteAction(w.facts)}`
            : "waiting for you to look at a plan before any work starts",
        });
      },
      onWaitEnd: e => this.jobIsMovingAgain(e.taskId),
      // NOT ASKED IS NOT UNRECORDED. See `saidWithoutAsking`.
      onUnasked: u => this.saidWithoutAsking(u),
    });
    this.schedules = this.loadSchedules();
    this.scheduler = new Scheduler(
      () => this.schedules,
      fired => void this.fireSchedule(fired.schedule),
    );
  }

  connect(): void {
    this.ws = new WebSocket(this.opts.relayUrl);
    this.ws.on("open", () => {
      this.sendFrame({ type: "hello", token: this.opts.token, client: "engine" });
    });
    this.ws.on("message", raw => this.onFrame(JSON.parse(String(raw)) as ServerFrame));
    this.ws.on("close", () => {
      // THE WAIT SURVIVES A DROPPED SOCKET (2026-08-07). It used to be thrown
      // away here, as a no, on every close — and with the hub's ten-minute
      // sweep gone that turned a wifi blip or a laptop sleep into a ZOMBIE
      // CARD: this side gave up, the hub's card stayed `pending` for ever with
      // a live Approve button on it, and when he pressed it in the morning
      // there was no longer anybody listening. The card went green and the
      // branch was never pushed. Nobody was told.
      //
      // NOTHING HERE IS A YES, which is the rule that mattered and still does:
      // the wait simply stays a wait. This process is still running, the agent
      // is still standing there, and `onFrame`'s `welcome` reconciles every
      // card the moment the hub comes back — including one he answered while
      // we were away. Only a real ending settles it: his decision, his Stop, or
      // Cloud9 shutting down (`stop`, below, which still gives up all).
      if (this.stopped) return;
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    });
    this.ws.on("error", () => { /* close handler reconnects */ });
  }

  /**
   * HIS YES ARRIVED, AND THERE WAS NOBODY LEFT TO ACT ON IT.
   *
   * THE ZOMBIE CARD. No card expires any more, which is right — his question
   * waits for him. But it means a card can outlive the run behind it: he
   * approves a push at 9am against an agent that stopped waiting when Cloud9
   * was last closed. The hub records `approved` and draws the card green, and
   * this side has no waiter to hand it to. Silently doing nothing there is the
   * worst outcome this app can produce: a record that says he agreed to
   * something, and nothing agreed to.
   *
   * So he is told, in the room the card came from, and told what it means: the
   * work did NOT happen and nothing left this computer. Only ever said for a
   * decision that really was his — `onApproval` returns false for a card still
   * pending and for one this engine was never waiting on, so a reconnect
   * replaying old decisions cannot make this speak.
   */
  private sayApprovalArrivedTooLate(approval: Approval): void {
    if (approval.status !== "approved" && approval.status !== "rejected") return;
    const channelId = approval.channelId;
    if (!channelId) return;
    // only about a card of OURS, in a room we know — never somebody else's
    const agent = this.myAgents.find(a => a.id === approval.agentId);
    if (!agent) return;
    if (approval.status === "rejected") return;  // a no changes nothing anyway
    if (this.lateWarningIds.has(approval.id)) return;
    // Mark before sending: duplicate live frames and welcome replays cannot
    // produce a second warning, even when the first send is still in flight.
    this.lateWarningIds.add(approval.id);
    const warningSaved = writeWholeFile(this.lateWarningPath, JSON.stringify([...this.lateWarningIds]),
      message => console.error(`[engine] could not save late approval warning: ${message}`));
    if (!warningSaved) {
      console.error("[engine] late approval warning deduplication will last only until this restart");
    }
    this.agentSend(agent.id, channelId,
      "You've just said yes to this, but I'm no longer waiting on it — Cloud9 was " +
      "restarted after I asked, so nothing was standing by to act on your answer. " +
      "**It did not happen and nothing left this computer.** Ask me again and I'll " +
      "stop and ask you in the same place.");
  }

  stop(): void {
    this.stopped = true;
    this.tools.stop();
    this.approvals.giveUpAll("Cloud9 stopped before anyone answered, so it did not happen");
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.scheduler.stop();
    this.ws?.removeAllListeners("close");
    this.ws?.close();
  }

  private onFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case "welcome":
        this.state = frame.state;
        // WHAT HAPPENED WHILE WE WERE AWAY. A dropped socket no longer throws a
        // waiting agent's question away, so this is the other half of that: any
        // card he ANSWERED while this engine was disconnected is applied now,
        // exactly as if the decision had arrived over the wire. `onApproval`
        // ignores anything still pending and anything it is not waiting on, so
        // this is a replay, never a second decision mechanism.
        for (const a of frame.state.approvals) {
          if (!this.approvals.onApproval(a)) this.sayApprovalArrivedTooLate(a);
        }
        for (const m of frame.state.messages) this.pushHistory(m);
        for (const t of frame.state.tasks) this.tasks.set(t.id, t);
        this.scheduler.start();
        for (const t of frame.state.tasks) this.maybeRunTask(t);
        /* WHERE THE OWNER'S CODE LIVES, asked for the moment we connect.
           The welcome does not carry projects, and `repoDirFor` cannot wait
           until one happens to change — an agent asked to work in code the
           second after the app opens would otherwise be told nobody has said
           where the code is, which would be false. */
        this.sendFrame({ type: "projects" });
        this.onReady?.();
        break;
      case "task":
        this.tasks.set(frame.task.id, frame.task);
        this.maybeRunTask(frame.task);
        break;
      case "message":
        this.pushHistory(frame.message);
        void this.considerReplies(frame.message);
        break;
      case "channel": {
        if (!this.state) break;
        const i = this.state.channels.findIndex(c => c.id === frame.channel.id);
        if (i >= 0) this.state.channels[i] = frame.channel;
        else this.state.channels.push(frame.channel);
        break;
      }
      case "channelMemoryPolicies":
        if (this.state) {
          this.state.channelMemoryPolicies = [
            ...(this.state.channelMemoryPolicies ?? []).filter(policy => policy.channelId !== frame.channelId),
            ...frame.policies,
          ];
        }
        break;
      case "channelMemoryPolicy":
        if (this.state) {
          this.state.channelMemoryPolicies = [
            ...(this.state.channelMemoryPolicies ?? []).filter(policy =>
              policy.channelId !== frame.policy.channelId || policy.agentId !== frame.policy.agentId),
            frame.policy,
          ];
        }
        break;
      case "channelLeft":
        if (this.state) {
          this.state.channels = this.state.channels.filter(channel => channel.id !== frame.channelId);
          this.state.channelMemoryPolicies = (this.state.channelMemoryPolicies ?? [])
            .filter(policy => policy.channelId !== frame.channelId);
        }
        this.history.delete(frame.channelId);
        break;
      case "agent": {
        if (!this.state) break;
        const i = this.state.agents.findIndex(a => a.id === frame.agent.id);
        if (i >= 0) this.state.agents[i] = frame.agent;
        else this.state.agents.push(frame.agent);
        break;
      }
      case "agentDeleted":
        if (this.state) this.state.agents = this.state.agents.filter(a => a.id !== frame.agentId);
        // WHAT IT REMEMBERED GOES WITH IT. A deleted agent's notes are about a
        // colleague that no longer exists; leaving them on disk would keep
        // seeding turns that will never happen and hold the owner's data past
        // the moment they said to forget it.
        this.memory.forget(frame.agentId);
        break;
      case "userJoined":
        this.state?.users.push(frame.user);
        break;
      case "harnessRequest":
        this.onHarnessRequest?.(frame.action, frame.harness);
        break;
      /* THE HUB ASKED US TO LOOK AT A REPOSITORY (his item 7).
         The hub cannot reach GitHub; this machine can, because the GitHub
         sign-in is here. It has already checked that the person who pressed
         the button owns this project — an engine is told what to look at, it
         does not choose. Read only, so there is nothing to approve. */
      case "lookAtProject":
        void this.lookAtProject(frame.projectId, frame.repo);
        break;
      /* THE HUB ASKED US WHICH REPOSITORIES THIS SIGN-IN CAN SEE (the picker).
         Same split as the look: the hub cannot reach GitHub, this machine can.
         Read only, so there is nothing to approve. */
      case "listRepositoriesRequested":
        void this.listRepositories();
        break;
      /* WHICH PROJECTS EXIST, AND WHERE THEIR CODE IS.
         The hub sends these to every one of the owner's connections, this one
         included. We keep them for ONE reason — `repoDirFor` — and they are a
         copy of the hub's truth, never a permission. */
      case "project":
        this.projects.set(frame.project.id, frame.project);
        break;
      case "projects":
        this.projects.clear();
        for (const p of frame.projects) this.projects.set(p.id, p);
        break;
      case "hooksUpdated": {
        if (!this.hooks) break;
        // The relay has already applied the owner/client gate and agent checks.
        // Strip the desktop-only timestamp before handing the same vocabulary
        // to HookBook; the engine still validates ownership when a fact fires.
        const hooks = frame.hooks.map(({ updatedAt: _updatedAt, ...hook }) => hook as Hook);
        this.hooks.replace(hooks);
        break;
      }
      case "projectForgotten":
        this.projects.delete(frame.projectId);
        break;
      // ---- the mid-run approval round trip (his item 6) ----
      // The receipt tells us WHICH card belongs to which waiting agent; the
      // ordinary `approval` frame carries the decision. There is no special
      // decision frame, on purpose: `decideApproval` already produces this one
      // and a second path would be a second answer to "did we ask?".
      case "approvalAsked":
        this.approvals.onAsked(frame.askId, frame.approvalId);
        break;
      case "approval":
        // NEVER SILENT ABOUT A YES NOBODY IS LEFT TO ACT ON. If Cloud9 has been
        // restarted since the agent asked, the card on his screen outlived the
        // agent that was waiting behind it — he presses Approve, the hub records
        // it, and this side has nobody to tell. That used to be a silent no-op:
        // the card went green and the branch was never pushed. Now he is told,
        // in the room the card came from, that his yes arrived too late for the
        // agent and what to do about it.
        if (!this.approvals.onApproval(frame.approval)) {
          this.sayApprovalArrivedTooLate(frame.approval);
        }
        break;
      // an agent asked Cloud9 to search the conversation it is standing in
      case "searchResults":
        for (const waiter of [...this.searchWaiters]) {
          if (waiter(frame)) this.searchWaiters.delete(waiter);
        }
        break;
      // the hub granted a one-use download for a file attached in that room —
      // it says yes only when the owner may read the room the file was posted
      // in, and it says the same thing again when the bytes are served
      case "attachmentTicket":
        for (const waiter of [...this.attachmentWaiters]) {
          if (waiter(frame)) this.attachmentWaiters.delete(waiter);
        }
        break;
      // ---- agent memory: the screen wants to see, or clear, an agent's notes ----
      // The hub has already checked whose agent this is; the engine answers with
      // the notes off ITS OWN store, which is the one durable copy.
      case "memoryListRequested":
        this.reportMemory(frame.agentId);
        break;
      case "forgetMemoryRequested":
        this.forgetMemoryNote(frame.agentId, frame.noteId);
        break;
      // ---- a peer handed one of this owner's agents a piece of work ----
      case "handoffReceived":
        void this.receiveHandoff(frame.handoff);
        break;
      case "runRecoveryRequested":
        void this.handleRecoveryRequest(frame.request);
        break;
      default:
        break;
    }
  }

  /**
   * Recovery is always a new turn. The old approval desk is not consulted and
   * no provider state is reconstructed here: policy, permissions and spending
   * are re-evaluated by respondAs at action time. Resume remains unavailable
   * unless a provider implements a real session continuation contract.
   */
  private async handleRecoveryRequest(request: RecoveryRequest): Promise<void> {
    if (request.payload.mode !== "retry" && request.payload.mode !== "resume" && request.payload.mode !== "restart") {
      console.warn(`[engine] recovery ${request.runId} has an unsupported action; no turn started`);
      return;
    }
    if (request.payload.mode === "resume") {
      console.warn(`[engine] resume requested for ${request.runId}, but provider resume is not implemented; no turn started`);
      return;
    }
    const agent = this.myAgents.find(a => a.id === request.agentId);
    if (!agent) return;
    // Recovery must carry the factual shape of the original turn. A legacy
    // receipt without that context is refused rather than silently becoming a
    // chat turn in an invented room.
    if ((request.kind !== "chat" && request.kind !== "task" && request.kind !== "schedule")
      || (request.requesterKind !== "human" && request.requesterKind !== "agent" && request.requesterKind !== "schedule")
      || request.requestedBy === undefined
      || !request.requestedBy.trim()) {
      console.warn(`[engine] recovery ${request.runId} has no original turn context; no turn started`);
      return;
    }
    if (request.kind === "task" && (!request.taskId || !request.channelId)) {
      console.warn(`[engine] recovery ${request.runId} has no task room/context; no turn started`);
      return;
    }
    const channelId = request.channelId;
    const context = channelId ? this.renderContext(channelId, agent, request.replyTo) : "";
    const trigger = request.payload.mode === "restart"
      ? `${request.payload.ask} (restart with context from run ${request.runId})`
      : request.payload.ask;
    try {
      await this.respondAs(agent, {
        context, trigger, triggerAuthor: request.requestedBy, kind: request.kind,
        ...(channelId ? { channelId } : {}), ...(request.taskId ? { taskId: request.taskId } : {}),
        requesterKind: request.requesterKind,
        ...(request.replyTo ? { replyTo: request.replyTo } : {}),
        priorRunId: request.runId,
      });
    } catch (error) {
      console.error(`[engine] recovery turn ${request.runId} did not finish:`, error);
    }
  }

  /**
   * The room as this engine remembers it, newest at the end.
   *
   * HOW MANY IT KEEPS IS NOT A NUMBER WRITTEN HERE. It used to be a literal 300,
   * chosen when the conversation budget was a flat 200 messages and therefore
   * comfortably above it. Now that the budget follows the model, a big model
   * asks for a thousand — and a 300-message ring would have quietly capped it,
   * which is a second limit, in a second file, that nobody could find. It is
   * asked of the one owner of the rule instead (`context.ts`).
   */
  private pushHistory(m: Message): void {
    const list = this.history.get(m.channelId) ?? [];
    list.push(m);
    const keep = maxConversationMessages();
    if (list.length > keep) list.splice(0, list.length - keep);
    this.history.set(m.channelId, list);
  }

  get myAgents(): AgentDef[] {
    if (!this.state) return [];
    return this.state.agents.filter(a => a.ownerId === this.state!.me.id);
  }

  private channel(id: ID): Channel | undefined {
    return this.state?.channels.find(c => c.id === id);
  }

  /** Effective policy from the relay snapshot; absent rows use the documented default. */
  private channelMemoryPolicy(channelId: ID, agentId: ID): ChannelMemoryPolicy | undefined {
    const found = this.state?.channelMemoryPolicies?.find(policy =>
      policy.channelId === channelId && policy.agentId === agentId);
    if (found) return found;
    const channel = this.channel(channelId);
    // No fabricated default: an unknown channel, or an agent that is not a
    // live member of it, is outside the policy boundary. Callers that are
    // about to persist a channel-scoped note must refuse before touching the
    // memory store.
    if (!channel || !channel.memberIds.includes(agentId)) return undefined;
    return {
      channelId, agentId,
      mode: defaultChannelMemoryMode(channel?.kind ?? "channel"), revision: 0,
      updatedAt: channel?.createdAt ?? 0,
      updatedBy: this.state?.me.id ?? "system", isDefault: true,
    };
  }

  private async considerReplies(message: Message): Promise<void> {
    if (!this.state) return;
    const channel = this.channel(message.channelId);
    if (!channel) return;
    const history = this.history.get(channel.id) ?? [];
    const channelAgents = this.state.agents.filter(a => channel.memberIds.includes(a.id));
    // WHERE EVERY ANSWER TO THIS MESSAGE BELONGS — read once, here, and handed
    // to whichever path takes the turn. Undefined means the main room, which is
    // every message not said inside a thread: nothing changes there.
    const thread = threadOf(message);
    // A HANDOFF TYPED IN THE ROOM: "@From !handoff @To <what to do>". Parsed from
    // the RAW text, because @-mentions are stripped from `bare` and @To is one.
    // Only the agent named before !handoff hands off; the one named after
    // receives it through the delivered handoff, not by replying to the command.
    const handoffCmd = message.authorKind === "human"
      ? parseHandoffCommand(message.text) : undefined;

    if (message.authorKind === "human" && isBrakedReset(history)) {
      // a human spoke — lift any brake status display
      for (const a of this.myAgents) this.setStatus(a.id, "idle");
    }
    if (isBraked(history, this.brake)) {
      for (const a of this.myAgents.filter(a => channel.memberIds.includes(a.id))) {
        this.setStatus(a.id, "braked");
      }
      return;
    }

    for (const agent of this.myAgents) {
      if (!shouldReply(agent, message, channel, channelAgents)) continue;
      // The handoff command is answered by exactly one agent — the sender — and
      // deliberately silences the receiver's ordinary reply, so a "@To" mention
      // in the command does not produce both a handoff AND a chat answer.
      if (handoffCmd) {
        const me = agent.name.toLowerCase();
        if (me === handoffCmd.from.toLowerCase()) {
          this.enqueue(() => this.handOffInRoom(
            agent, channel.id, handoffCmd.to, handoffCmd.task, message.authorName, thread));
          continue;
        }
        if (me === handoffCmd.to.toLowerCase()) continue;
      }
      const bare = message.text.replace(/@[\w-]+\s*/g, "");
      // ===== GAP C BLOCK (stopping a running turn, 2026-08-05) — start =====
      // STOP WHAT IT IS DOING: "@Agent !stop".
      //
      // FIRST in the command list, on purpose, and answered OUTSIDE the turn
      // queue. Every other command here is enqueued behind whatever is already
      // running — which for a stop would be exactly backwards: the one thing he
      // types when a turn is running long must not have to wait for that turn to
      // finish before it is read. `stopAgent` returns immediately.
      //
      // It is a HUMAN-ONLY command, like every command in this list: an agent
      // must not be able to stop another agent's work by saying the right words
      // in a room they share.
      if (message.authorKind === "human" && /^!stop\b/i.test(bare.trim())) {
        const stopped = this.stopAgent(agent.id);
        // SAID OUT LOUD EITHER WAY. Silence after pressing stop is how a person
        // concludes the button does nothing and starts closing the app.
        this.agentSend(agent.id, channel.id, stopped > 0
          // TWO LINES, TWO MOMENTS, and they do not repeat each other: this one
          // is the instant receipt ("I heard you, I'm pulling the plug"), and
          // the turn itself says the second one when the process is really gone.
          // Silence between the two is the thing that makes a person press the
          // button again.
          ? `🛑 Stopping — pulling the plug on what I'm doing now.`
          : `There was nothing running to stop — I'm not working on anything right now.`,
          { ...(thread ? { replyTo: thread } : {}) });
        continue;
      }
      // ===== GAP C BLOCK — end =====
      // REMEMBER SOMETHING BETWEEN CONVERSATIONS: "@Agent !remember <text>". The
      // worth-remembering rule decides whether it lands; a refusal is said out
      // loud in the agent's own voice rather than swallowed.
      if (message.authorKind === "human" && /^!remember\s+/i.test(bare)) {
        const text = bare.replace(/^!remember\s+/i, "").trim();
        this.enqueue(() => this.rememberFromRoom(agent, channel.id, text, thread));
        continue;
      }
      // schedule commands: "@Agent !schedule daily 06:30 do X" / "every 15m do X",
      // "@Agent !schedules", "@Agent !unschedule <id>"
      if (message.authorKind === "human"
        && this.handleScheduleCommand(agent, channel.id, bare, message.authorId, thread)) continue;
      // delegated work: "!bg <task>" or "!task <task>" → tracked Task (spec FR-TS-002)
      const bg = message.authorKind === "human" && /^!(bg|task)\s+/i.test(bare);
      if (bg) {
        const title = bare.replace(/^!(bg|task)\s+/i, "").trim();
        // `approvalsFor` is the ONE owner of "does this need his nod?". Reading
        // `agent.approvals` directly is what let a switch that changes the
        // machine be paired with an approval flag set to false. An agent holding
        // any always-ask power is asked about the whole job, because a
        // background turn is exactly where nobody is watching it.
        const needsApproval = approvalsFor(agent).background || needsApprovalToRun(agent);
        this.sendFrame({
          type: "createTask", agentId: agent.id, channelId: channel.id, title,
          // the person who TYPED it, not the account this engine runs as — a
          // friend's job must stay their job in Tasks and in the activity log
          requesterId: message.authorId,
          needsApproval, action: needsApproval ? `Run background task: ${title}` : undefined,
        });
        // 👀 straight away: the first thing he asked for is being able to SEE
        // that the ask landed, before anything slow starts. The rest of the
        // ticks follow the job, so the message it was asked in has to be
        // remembered until the hub gives that job an id.
        // the ask remembers WHERE it was made as well as which message it was:
        // a job asked for inside a thread reports back into that thread, and
        // the task the hub mints carries no thread of its own to tell us
        this.pendingAsks = rememberAsk(this.pendingAsks, {
          agentId: agent.id, channelId: channel.id, title, messageId: message.id, at: Date.now(),
          ...(thread ? { replyTo: thread } : {}),
        });
        this.reactAs(agent.id, message.id, "picked");
        this.agentSend(agent.id, channel.id, needsApproval
          ? `I can do that — waiting for my owner's approval first. 🔒 (see Tasks panel)`
          : `On it — I'll work on this in the background and post here when done. ⏳`,
          { ...(thread ? { replyTo: thread } : {}) });
        continue;
      }
      // WORK IN THE CODE: "!code <what to do>". The agent gets its own git
      // worktree, does the job in it, and — if IT decides it wants to — asks to
      // push and open a pull request. Everything up to the ask is local, so
      // starting one needs no approval; the only thing that leaves this
      // computer is behind the card, exactly as it was before.
      if (message.authorKind === "human" && /^!code\s+/i.test(bare)) {
        const what = bare.replace(/^!code\s+/i, "").trim();
        void this.enqueueAgentTurn(agent.id, async () => {
          await this.workInRepository(agent, {
            channelId: channel.id, ask: what, triggerAuthor: message.authorName,
            ...(thread ? { replyTo: thread } : {}),
          });
        });
        continue;
      }
      // A GITHUB WRITE, asked for in the room: "!issue <title>",
      // "!comment <pr#> <text>", "!review <pr#> <user> [user…]". Everything up to
      // the yes is local — deriving the repository is a read — and the only thing
      // that leaves this computer is behind the SAME approval card the push uses.
      // The title/text is prose and rides on stdin; it never touches the card.
      if (message.authorKind === "human") {
        const write = this.parseGitHubWriteCommand(bare);
        if (write) {
          void this.enqueueAgentTurn(agent.id,
            () => this.workGitHubWriteInRoom(agent, channel.id, write, thread));
          continue;
        }
      }
      // SHOW ME THE PLAN FOR THIS ONE THING: "@Agent !plan <what to do>".
      //
      // WHY A BANG COMMAND AS WELL AS A SETTING, and it is not belt-and-braces.
      // The setting is a standing rule about an agent — right for the one that
      // touches his repositories, wrong for the one that answers questions. The
      // bang is about ONE ask, which is how the need actually turns up: he
      // trusts an agent generally and wants to see the plan for this particular
      // job before it starts. A setting alone would make him edit an agent and
      // then edit it back; a bang alone would make him remember to type it every
      // single time on the agent he never wants running unwatched.
      //
      // They share one implementation (`planFirstTurn`), so there is still only
      // one plan gate — this line only decides that this message goes through it.
      if (message.authorKind === "human" && /^!plan\s+/i.test(bare)) {
        const what = bare.replace(/^!plan\s+/i, "").trim();
        void this.enqueueAgentTurn(agent.id, () => this.takeTurn(
          agent, channel.id, { ...message, text: what }, { planFirst: true }));
        continue;
      }
      void this.enqueueAgentTurn(agent.id, () => this.takeTurn(agent, channel.id, message));
    }
  }

  /**
   * PUT WORK IN THE QUEUE, SAYING WHOSE IT IS (2026-08-06).
   *
   * The `agentId` is new and it is what makes a stop honest. See `stopAgent`:
   * a turn that is QUEUED has no scope and no child process, so stopping
   * reached nothing — the owner was told "there was nothing running to stop"
   * and then the agent answered anyway, seconds later, as an ordinary `ok` run.
   *
   * Anonymous work (a handoff, a memory note) passes nothing and is never
   * dropped by a stop: those are not the agent taking a turn.
   */
  private enqueue(job: () => Promise<void>, agentId?: ID, onDropped?: () => void): void {
    this.queue.push({ job, ...(agentId ? { agentId } : {}), ...(onDropped ? { onDropped } : {}) });
    void this.drain();
  }

  /**
   * Queue one provider-backed turn with the owner ID that the drain token must
   * carry. Every entrypoint that can reach `respondAs` goes through this seam:
   * room messages, plans, tasks, repository/GitHub work, schedules and
   * handoffs. The promise resolves when the queued job has finished; errors are
   * still handled by the job's existing user-facing boundary and never escape
   * the engine's queue.
   */
  private enqueueAgentTurn(agentId: ID, job: () => Promise<void>): Promise<void> {
    return new Promise(resolve => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      this.enqueue(async () => {
        try { await job(); } finally { finish(); }
      }, agentId, finish);
    });
  }

  /**
   * DROP THIS AGENT'S WORK THAT HAS NOT STARTED YET. Returns how many.
   *
   * Only turns — work tagged with this agent's id. A queued job is dropped
   * rather than started and immediately killed, because starting it would spend
   * money on a turn the owner has already said he does not want.
   */
  private dropQueuedTurns(agentId: ID): number {
    const before = this.queue.length;
    const kept = [] as typeof this.queue;
    for (const q of this.queue) {
      if (q.agentId === agentId) q.onDropped?.();
      else kept.push(q);
    }
    this.queue = kept;
    return before - this.queue.length;
  }

  /**
   * HOW MANY TURNS ARE REALLY WORKING RIGHT NOW.
   *
   * NOT the same as how many are in flight, and the difference is a bug that
   * would have run all night. A turn that has stopped to ask the owner
   * something is sitting on a promise inside its own job, so it still counts as
   * "in flight" — it holds one of the two slots while it waits. That was always
   * true, and it was survivable only because the hub swept an unanswered card
   * away after ten minutes and handed the slot back.
   *
   * There is no sweep any more (2026-08-07, and rightly — his question is not
   * rubbish to be cleared up while he thinks). So without this, two agents
   * parked on cards would freeze EVERY other agent in EVERY room, for ever: he
   * goes to bed, two agents reach a `!publish` gate, and in the morning nothing
   * else has answered a single message all night.
   *
   * A WAIT ON A PERSON IS NOT WORK. It costs no CPU, no money and no harness —
   * it is a promise in a list. So it does not occupy the slot the cap exists to
   * ration, and the cap counts only turns that are actually running something.
   *
   * CLAMPED DELIBERATELY. `pending` counts every open card, and a card can be
   * raised somewhere that is not one of these jobs (a `!issue` typed in a room).
   * Crediting more parked turns than there are turns in flight would let the cap
   * drift upwards, so the credit can never exceed what is actually in flight.
   */
  private workingTurns(): number {
    let parked = 0;
    for (const token of this.parkedWaits.values()) {
      if (this.activeTurnTokens.has(token)) parked++;
    }
    return Math.max(0, this.turnsInFlight - parked);
  }

  private async drain(): Promise<void> {
    const cap = this.opts.maxConcurrentTurns ?? 2;
    while (this.workingTurns() < cap && this.queue.length > 0) {
      const { job, agentId } = this.queue.shift()!;
      const token = `turn-${(++this.nextTurnToken).toString(36)}`;
      this.turnsInFlight++;
      this.activeTurnTokens.add(token);
      if (agentId) this.turnOwners.set(token, agentId);
      this.turnContext.run(token, job).catch(() => { /* logged below */ })
        .finally(() => {
          this.activeTurnTokens.delete(token);
          this.turnOwners.delete(token);
          for (const [askId, owner] of this.parkedWaits) {
            if (owner === token) this.parkedWaits.delete(askId);
          }
          this.turnsInFlight--;
          void this.drain();
        });
    }
  }

  private currentTurnToken(agentId?: ID): string | undefined {
    const token = this.turnContext.getStore();
    return token && agentId && this.turnOwners.get(token) === agentId ? token : undefined;
  }

  /**
   * Which harness runs this agent's turn (FR-AG-005). Absent provider means
   * "claude", the v1 behaviour. Undefined result = that harness isn't connected.
   */
  providerFor(agent: AgentDef): ClaudeProvider | undefined {
    return (agent.provider ?? "claude") === "codex" ? this.codexProvider : this.provider;
  }

  /**
   * Run one turn on the agent's own harness, and write down what it did.
   * Public so tests can drive it.
   *
   * Every path out of this function — a clean answer, a refused agent, a
   * missing harness, a CLI that fell over — leaves a run record behind, because
   * "it did nothing and here is why" is exactly the case the owner most needs
   * to be able to read. Recording is wrapped so it can never be the reason a
   * turn fails.
   */
  async respondAs(agent: AgentDef, input: TurnInput): Promise<string> {
    const harness = agent.provider ?? "claude";
    const seed: RunSeed = {
      kind: input.kind ?? "chat",
      agentId: agent.id,
      agentName: agent.name,
      provider: harness,
      ...(agent.model ? { model: agent.model } : {}),
      ...(input.channelId ? { channelId: input.channelId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      requestedBy: input.triggerAuthor,
      requestedByKind: input.requesterKind ?? "human",
      ask: input.trigger,
      startedAt: Date.now(),
      // UNDER WHICH RULE THIS TURN RAN. Read once, here, at the start — never
      // looked up again when the record is drawn, because he can change the
      // setting and a record that re-describes itself afterwards is not a
      // record. `trustOf` fails closed, so an agent with nothing stored reads as
      // "ask me every time" exactly as it behaves.
      trust: trustOf(agent),
      // …AND WHOSE SETUP IT RAN IN. Read once, here, from the stored agent —
      // exactly like the trust setting above, and for the same reason: he can
      // flip the switch, and a record that re-describes itself afterwards is not
      // a record. This is what lets him look back and see which turns had his
      // CLAUDE.md, his connected services and his hooks loaded (`ownersetup.ts`).
      ownerSetup: usesOwnerSetup(agent),
    };
    // Allocate the turn id before the provider starts. The same id is used by
    // every preview event and by the durable run record, so a late frame can
    // never be mistaken for a newer turn.
    const turnId = newRunId(seed.startedAt);
    let trace: ProviderTrace | undefined;
    // ==================================================================
    // WHAT THIS AGENT MAY SPEND — decided HERE, once, for every kind of turn
    // ==================================================================
    //
    // `respondAs` is the one door every turn goes through: an ordinary chat
    // reply, a delegated job, a scheduled check-in, repository work, a handoff.
    // So it is the one place a spending ceiling can be applied without somebody
    // having to remember to apply it to the next kind of turn somebody invents.
    //
    // TWO THINGS COME OUT OF THIS, AND ONLY ONE OF THEM IS A REFUSAL:
    //
    //  • The month is already spent → the turn does not start at all. It is
    //    recorded as a run that was stopped by a limit, the agent says one
    //    honest sentence naming the limit, and a job carrying it is marked on
    //    the jobs screen by the ordinary failure path. Nothing half-runs.
    //  • There is room left → one number goes to the harness as its own
    //    ceiling, so the turn cannot walk past either limit while it works.
    //
    // OFF BY DEFAULT AND IT COSTS NOTHING WHEN OFF. `spendCapOf` reads an agent
    // with no ceiling as `{}`, `decideSpend` then allows with no number, and
    // the disk is not even read — `spentInMonth` is only asked when there is a
    // monthly ceiling to compare it against.
    const cap = providerCanBeCapped(harness) ? spendCapOf(agent) : {};
    const spent = typeof cap.perMonthUsd === "number"
      ? this.spentThisMonth(agent.id, seed.startedAt) : 0;
    const spendVerdict = decideSpend(cap, spent);
    // CAN ANYBODY BE SHOWN THIS TURN AT ALL? A live signal is drawn on the
    // message that triggered the turn, in the room that message is in, so a turn
    // with neither has nowhere honest to appear. ONE answer, used by the
    // receipts and by the live steps alike — two spellings of "may we signal?"
    // is how a scheduled check-in ends up drawing on somebody else's message.
    const canSignal = !!input.triggerMessageId && !!input.channelId;
    /** did this turn ever actually show a live step? Only then is there a
     *  preview to close — a provider that cannot stream (the mock, the SDK
     *  path, any runner that ignores the option) must cost the room no frames
     *  at all, not one meaningless "it's finished" for a box nobody saw. */
    let streamed = false;
    let responseStarted = false;
    let responseClosed = false;
    let responseSeq = 0;
    let responseChars = 0;
    // ===== GAP C BLOCK (stopping a running turn, 2026-08-05) — start =====
    /** the handle that stops this turn; absent until the harness is actually run */
    let stop: ReturnType<typeof newStopScope> | undefined;
    let providerAbortController: AbortController | undefined;
    /** this turn's row in `liveTurns`, so the `finally` can take it out again */
    let stopRegistration: LiveTurn | undefined;
    // ===== GAP C BLOCK — end =====
    // 👀 — THE SILENCE ENDS HERE. Sent before a single gate is checked, because
    // "we have your message" is true from this line onwards and is exactly the
    // thing his §2 says a person should never have to wait for. A turn that is
    // about to be refused still read the message.
    this.sendReceipt(agent.id, input, "reading");
    try {
      // last-gate validation: this agent definition arrived from a client, and
      // its model is checked against the harness's REAL list, not just its shape
      // THE CEILING IS CHECKED BEFORE ANYTHING SPENDS ANYTHING. Inside the try
      // so the `catch` below writes the run record and the verdict exactly as
      // it does for every other reason a turn does not happen — one path, not a
      // special case that could forget the paperwork.
      if (!spendVerdict.allowed) {
        throw new SpendCapReachedError(
          spendVerdict.which ?? "perMonth", spendVerdict.capUsd ?? 0,
          spendVerdict.reason ?? "this agent has reached its spending limit, so it did not start");
      }
      const problem = validateAgentInput(agent, { models: this.harnessModels?.(harness) });
      if (problem) throw new Error(`refusing to run agent ${agent.id}: ${problem}`);
      const provider = this.providerFor(agent);
      if (!provider) {
        throw new HarnessUnavailableError(harness, `${harness} is not connected on this machine`);
      }
      const responseCapable = canSignal && provider.canStreamResponse?.() === true;
      // ASKED TO SHOW A PLAN BY A HARNESS THAT HAS NO PLAN MODE. Refused out
      // loud rather than quietly doing the work — see `PlanNotOfferedError`.
      // This is the last gate; `planFirstTurn` asks the same question earlier so
      // the owner is never promised a card that cannot come.
      if (input.planOnly && !provider.canPlan?.()) throw new PlanNotOfferedError(harness);
      // An agent whose instructions did not all reach the disk does NOT take
      // the turn. Running it anyway would answer from an incomplete brief and
      // present that answer as an ordinary one; the run is recorded as failed
      // and the sentence says which file is missing.
      const missingSkillFiles = this.writeSkillFiles(agent);
      if (missingSkillFiles.length > 0) {
        throw new InstructionsNotSavedError(agent.name, missingSkillFiles);
      }
      // 💭 — the CLI is about to actually run. Sent HERE and not at the top of
      // the turn so it means what it says: the checks above (a bad model, a
      // missing harness, instructions that would not save) all fail without
      // ever claiming the agent was thinking about the answer.
      this.sendReceipt(agent.id, input, "thinking");
      // ===== GAP C BLOCK (stopping a running turn, 2026-08-05) — start =====
      // FROM HERE THE TURN CAN BE STOPPED. The scope is opened around the
      // provider call and nothing else: everything above is a gate that takes no
      // time and spends no money, and there is nothing there worth killing.
      // Every child process started underneath — this harness, any harness, at
      // any depth — is stoppable because the scope travels with the turn rather
      // than being handed down through each layer (`run.ts`).
      stop = newStopScope();
      providerAbortController = new AbortController();
      const live: LiveTurn = {
        agentId: agent.id, agentName: agent.name, scope: stop, startedAt: seed.startedAt,
        abortController: providerAbortController,
        ...(input.channelId ? { channelId: input.channelId } : {}),
      };
      this.liveTurns.add(live);
      stopRegistration = live;
      // ===== GAP C BLOCK — end =====
      const text = await withStopScope(stop, () => provider.respond({
        agent,
        context: input.context,
        // WHAT THIS AGENT REMEMBERS, seeded into the turn. `retrieveMemory` has
        // already spent the memory budget (newest kept, oldest dropped) so this
        // is a bounded string; an agent that has saved nothing gets "" and the
        // prompt says nothing about memory. Reading its own store must never be
        // the reason a turn fails, so it is wrapped.
        memory: this.rememberedFor(agent.id, input.channelId),
        // THE INSTRUCTION TRAVELS WITH THE TURN, and `buildAgentPrompt` refuses
        // to render without it. This is the line the old `buildAgentPrompt(agent,
        // context)` threw away, which is why a 6:30am check-in was woken up and
        // told nothing at all.
        trigger: input.trigger,
        triggerAuthor: input.triggerAuthor,
        kind: seed.kind,
        ...(input.channelId ? { channelId: input.channelId } : {}),
        ...(input.workdir ? { workdir: input.workdir } : {}),
        // THE THREAD, offered so the harness can continue its own session
        // instead of being re-told the room every turn (`sessionresume.ts`).
        // The provider decides; passing it costs a cold turn nothing.
        ...(input.thread ? { thread: input.thread } : {}),
        // THE CEILING FOR THIS TURN — one number, worked out above from BOTH of
        // the owner's limits. Absent when he set none, which is the default and
        // is the same command line the app built yesterday.
        ...(typeof spendVerdict.turnCapUsd === "number"
          ? { maxBudgetUsd: spendVerdict.turnCapUsd } : {}),
        // SAY WHAT YOU INTEND, AND DO NOTHING. Only ever set by `planFirstTurn`.
        ...(input.planOnly ? { planOnly: true } : {}),
        ...(providerAbortController ? { abortController: providerAbortController } : {}),
        onTrace: t => { trace = t; },
        ...(responseCapable ? {
          onResponseText: (chunk: string) => {
            if (responseClosed || typeof chunk !== "string" || chunk.length === 0) return;
            // A provider callback is trusted only as far as its declared text;
            // split oversized increments and enforce the same total ceiling the
            // relay and desktop apply. No tool labels or reasoning reach here.
            let offset = 0;
            while (offset < chunk.length && !responseClosed) {
              const piece = chunk.slice(offset, offset + RESPONSE_STREAM_LIMITS.deltaChars);
              offset += piece.length;
              if (responseChars + piece.length > RESPONSE_STREAM_LIMITS.totalChars) {
                responseClosed = true;
                if (responseStarted) this.sendResponseStream(agent.id, input, turnId, "response-fail", ++responseSeq, undefined, "response preview reached its size limit");
                return;
              }
              if (!responseStarted) {
                responseStarted = true;
                this.sendResponseStream(agent.id, input, turnId, "response-start", 0);
              }
              responseChars += piece.length;
              this.sendResponseStream(agent.id, input, turnId, "response-delta", ++responseSeq, piece);
            }
          },
        } : {}),
        // WHAT IT IS DOING, AS IT DOES IT. Only offered when there is a message
        // and a room to show it against — the same gate `sendReceipt` uses, in
        // the same one place, so a scheduled or proactive turn cannot stream
        // its steps onto somebody else's message. When it is absent the
        // provider streams nothing at all, and the screen behaves exactly as it
        // did before: the record, at the end.
        ...(canSignal ? {
          onStep: (steps: RunStep[]) => {
            streamed = true;
            this.sendLiveSteps(agent.id, input, steps);
          },
        } : {}),
      }));
      // ===== GAP C BLOCK (stopping a running turn, 2026-08-05) — start =====
      // THE OWNER PULLED THE PLUG AND THE HARNESS STILL ANSWERED — a half-made
      // answer from a process that was killed mid-sentence. It is not reported
      // as a good turn, because it is not one.
      if (stop.stopped) this.turnWasStopped(agent, seed, input, trace, turnId); // throws
      // ===== GAP C BLOCK — end =====
      // DID THIS TURN GET THE MODEL IT ASKED FOR? Worked out once, here, and
      // put on the record, so the screen never has to guess from two ids what
      // the difference between them meant. `fellBackTo` only says yes when the
      // model the app REPORTED is one the owner actually named as a stand-in —
      // an alias the app resolved on its own is not a fallback and is not
      // claimed as one.
      const stoodIn = fellBackTo(agent.model, trace?.model, fallbackModelsOf(agent));
      // THE HARNESS STOPPED ITSELF ON THE CEILING WE HANDED IT. It may well
      // have said something useful first — and that is exactly why this is not
      // allowed to return as an ordinary answer. Half a job reported as a whole
      // one is the failure this whole feature exists to prevent, so it goes
      // down the same path as any other turn that did not finish: one honest
      // sentence naming the limit, a run record marked with it, and a job
      // marked on the jobs screen.
      if (trace?.stoppedByBudget) {
        throw new SpendCapReachedError(
          spendCapWhichFired(cap, spendVerdict.turnCapUsd),
          spendVerdict.turnCapUsd ?? 0,
          spendCapStopWords(
            spendCapWhichFired(cap, spendVerdict.turnCapUsd), spendVerdict.turnCapUsd ?? 0));
      }
      const record = this.recordRun(seed, {
        finishedAt: Date.now(), outcome: "ok", trace, reply: text,
        ...(stoodIn ? { fellBackTo: stoodIn } : {}),
        ...(input.planOnly ? { planOnly: true } : {}),
        ...(input.priorRunId ? { priorRunId: input.priorRunId } : {}),
      }, turnId);
      if (responseStarted && !responseClosed) {
        responseClosed = true;
        this.sendResponseStream(agent.id, input, turnId, "response-final", ++responseSeq);
      }
      // NEVER A SILENT SWAP. He chose a model; he is told, in the room, when he
      // did not get it. The record carries the fact whether or not there is a
      // room to say it in, so a scheduled check-in that fell back is still
      // reviewable afterwards.
      if (stoodIn && input.channelId) {
        this.agentSend(agent.id, input.channelId,
          `(${fellBackWords(agent.model, stoodIn)}.)`,
          { ...(input.replyTo ? { replyTo: input.replyTo } : {}) });
      }
      // THE ONE COMMITTED TICK, derived from what really happened — never from
      // asking the model to describe its own answer. `turnVerdict` may decline,
      // and a declined verdict sends nothing rather than a cheerful default.
      this.sendVerdict(agent.id, input, {
        outcome: "ok", reply: text,
        ...(trace?.steps ? { steps: trace.steps } : {}),
        ...(trace?.error ? { error: trace.error } : {}),
      });
      // THE FILES THIS TURN MADE, offered to the hub before the reply is
      // returned, so the message the agent is about to say and the file it is
      // talking about arrive together rather than minutes apart.
      // A published version must point at the exact run that made it. If the run
      // record itself could not be built, the turn still returns its answer but
      // no unattributed file is invented on the hub.
      if (record) this.shareProduced(agent, input, seed.startedAt, record.id);
      // DID IT DO WHAT IT SAID? Checked against the record it just wrote, and
      // said out loud ONLY where the two disagree. See `checkClaims`.
      if (record) this.checkClaims(agent, input, text, record);
      return text;
    } catch (err) {
      // ===== GAP C BLOCK (stopping a running turn, 2026-08-05) — start =====
      // A KILLED HARNESS THROWS, and what it throws is meaningless — it is the
      // noise of a process that was shot, not a reason. So the stop is checked
      // BEFORE the failure path: a run the owner stopped is never written down
      // as a run that broke, and he is never shown a scary sentence for doing
      // exactly what the button offered.
      // Already recorded and already spoken for by the line above — it must not
      // be written down a second time on its way out.
      if (err instanceof TurnStoppedError) {
        if (responseStarted && !responseClosed) {
          responseClosed = true;
          this.sendResponseStream(agent.id, input, turnId, "response-cancel", ++responseSeq,
            undefined, "you stopped this run");
        }
        throw err;
      }
      if (stop?.stopped) {
        if (responseStarted && !responseClosed) {
          responseClosed = true;
          this.sendResponseStream(agent.id, input, turnId, "response-cancel", ++responseSeq,
            undefined, "you stopped this run");
        }
        this.turnWasStopped(agent, seed, input, trace, turnId); // throws
      }
      // ===== GAP C BLOCK — end =====
      this.recordRun(seed, {
        finishedAt: Date.now(), outcome: "failed", trace,
        // the record keeps WHY, in words that carry no path, no argv and no
        // environment — the same rule sanitizeForChat enforces for chat
        error: redactForSharing(err instanceof Error ? err.message : String(err)),
        // A LIMIT STOPPED IT — the FACT, beside the sentence, so a screen can
        // mark the run without reading English. Both shapes of the event land
        // here: the turn that never started because the month was spent, and the
        // one the harness cut short on the ceiling we handed it.
        ...(err instanceof SpendCapReachedError
          ? { capStop: { which: err.which, capUsd: err.capUsd } } : {}),
        ...(input.planOnly ? { planOnly: true } : {}),
        ...(input.priorRunId ? { priorRunId: input.priorRunId } : {}),
      }, turnId);
      if (responseStarted && !responseClosed) {
        responseClosed = true;
        this.sendResponseStream(agent.id, input, turnId,
          err instanceof TurnStoppedError ? "response-cancel" : "response-fail",
          ++responseSeq, undefined,
          err instanceof TurnStoppedError ? "you stopped this run" : "the response did not finish");
      }
      // ⚠️ — it did not go through. The tick says the STATE; the honest
      // sentence the caller posts says the words.
      this.sendVerdict(agent.id, input, {
        outcome: "failed", ...(trace?.steps ? { steps: trace.steps } : {}),
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      // ===== GAP C BLOCK (stopping a running turn, 2026-08-05) — start =====
      // THIS TURN IS NO LONGER STOPPABLE, whichever way it ended. In the
      // `finally` for the same reason the live preview is: a turn that is over
      // must not sit in the list offering a button that would kill nothing, or
      // worse, a pid the operating system has since given to something else.
      if (stopRegistration) this.liveTurns.delete(stopRegistration);
      // ===== GAP C BLOCK — end =====
      // THE PREVIEW ENDS WHEN THE TURN DOES — worked, failed, refused, threw.
      // In a `finally` because there is no ending that should leave a live box
      // spinning; lifecycle cleanup is the backstop for an engine that dies,
      // not a deadline on the turn. From here on the stored record is
      // the only thing that speaks for this turn.
      if (streamed) this.endLiveSteps(agent.id, input);
    }
  }

  /**
   * SEND ONE SEMANTIC RECEIPT — 👀 / 💭 — for the message that triggered this
   * turn (his §2).
   *
   * NOTHING HAPPENS WITHOUT A TRIGGERING MESSAGE. A scheduled check-in, a
   * proactive line, a handoff with no message behind it: `triggerMessageId` is
   * absent, and this returns having sent nothing. That is the rule, in one
   * place, so a new kind of turn cannot accidentally signal on somebody else's
   * message.
   *
   * Never throws. A live signal is never worth a turn — the same law as
   * `reactAs`.
   */
  private sendReceipt(
    agentId: ID, input: TurnInput, stage: ReceiptStage, verdict?: ReceiptVerdict,
  ): void {
    const messageId = input.triggerMessageId;
    const channelId = input.channelId;
    if (!messageId || !channelId) return;
    try {
      this.sendFrame({
        type: "agentReceipt", agentId, channelId, messageId, stage,
        ...(verdict ? { verdict } : {}),
      });
    } catch (err) {
      console.error("[engine] could not send a receipt:", err);
    }
  }

  /**
   * SEND ONE BATCH OF LIVE STEPS — what this agent just did, while it is still
   * working (`@cloud9/shared/livesteps`).
   *
   * The same gate, the same silence and the same never-throws law as
   * `sendReceipt`: no triggering message means no signal, and a live view is
   * never worth a turn. It is capped here as well as at the hub, because a
   * frame the hub would refuse is a frame worth not sending.
   *
   * NOTHING IS STORED BY THIS. The run record is built at the end of the turn
   * from the whole transcript, exactly as it was before, and `recordRun` is
   * still its only author.
   */
  private sendLiveSteps(agentId: ID, input: TurnInput, steps: readonly RunStep[]): void {
    const messageId = input.triggerMessageId;
    const channelId = input.channelId;
    if (!messageId || !channelId || steps.length === 0) return;
    try {
      // REDACTED ON THE WAY OUT, by the same function and to the same lengths a
      // stored record's steps go through (`shareableRun`). A live step names
      // files and commands; it does not get to leak what the record would not.
      const safe = steps.slice(0, LIVE_STEPS_PER_BATCH).map(s => ({
        ...s,
        label: redactForSharing(s.label, RUN_LIMITS.label),
        ...(s.detail ? { detail: redactForSharing(s.detail, RUN_LIMITS.detail) } : {}),
      }));
      this.sendFrame({ type: "agentSteps", agentId, channelId, messageId, steps: safe });
    } catch (err) {
      console.error("[engine] could not send what an agent is doing:", err);
    }
  }

  /** The turn is over — take the preview down. Carries no steps, by design. */
  private endLiveSteps(agentId: ID, input: TurnInput): void {
    const messageId = input.triggerMessageId;
    const channelId = input.channelId;
    if (!messageId || !channelId) return;
    try {
      this.sendFrame({ type: "agentSteps", agentId, channelId, messageId, done: true });
    } catch (err) {
      console.error("[engine] could not close a live view:", err);
    }
  }

  /** Send a genuine provider response preview; relay supplies the timestamp. */
  private sendResponseStream(
    agentId: ID, input: TurnInput, turnId: string, kind: AgentResponseStreamKind,
    seq: number, text?: string, reason?: string,
  ): void {
    const messageId = input.triggerMessageId;
    const channelId = input.channelId;
    if (!messageId || !channelId) return;
    try {
      this.sendFrame({
        type: "agentResponse",
        event: {
          kind, channelId, triggerMessageId: messageId, agentId, turnId, seq,
          // The relay overwrites this untrusted placeholder with hub time.
          at: 0,
          ...(text !== undefined ? { text } : {}),
          ...(reason ? { reason } : {}),
        },
      });
    } catch (err) {
      console.error("[engine] could not send response preview:", err);
    }
  }

  /**
   * Ask the rules what this turn honestly earned, then send it — or send
   * nothing, which is a real answer (`turnVerdict` returns undefined).
   */
  private sendVerdict(agentId: ID, input: TurnInput, facts: TurnFacts): void {
    const verdict = turnVerdict(facts);
    if (!verdict) return;
    this.sendReceipt(agentId, input, "verdict", verdict);
  }

  // ================= HOOKS: telling the owner's rules what happened ==========
  //
  // THE ENGINE REPORTS; `hooks.ts` DECIDES. Nothing about whether a hook may
  // act — whose agent it is, whether a command needs an approval, whether a
  // hook is setting off another hook — is answered here. This method's whole
  // job is to fill in the facts a rule is matched against and hand them over.

  /**
   * TELL THE HOOKS SOMETHING HAPPENED. Never throws, and never delays anything:
   * the same fire-and-forget shape as `approvaldesk.ts`'s `tell()`, for the same
   * reason — a rule the owner set for his own convenience must never be able to
   * cost him a turn that really worked.
   */
  private fireHook(seed: {
    event: HookFact["event"];
    what: string;
    agentId?: ID;
    channelId?: ID;
    taskId?: ID;
    outcome?: HookFact["outcome"];
    causedByHook?: boolean;
  }): void {
    try {
      if (!this.hooks) return;                       // no book set: nothing fires
      // A JOB KNOWS ITS OWN AGENT AND ROOM, so an event that arrives carrying
      // only a job id is still a complete fact.
      const task = seed.taskId ? this.tasks.get(seed.taskId) : undefined;
      const agentId = seed.agentId ?? task?.agentId;
      if (!agentId) return;
      const agent = this.agentById(agentId);
      // NO OWNER, NO EVENT. `hooks.ts` matches every rule against the owner of
      // the world the thing happened in; a fact with nobody's name on it would
      // be a fact every owner's rules could see.
      if (!agent) return;
      const firings = this.hooks.fire({
        event: seed.event,
        at: Date.now(),
        ownerId: agent.ownerId,
        agentId,
        agentName: agent.name,
        ...(seed.channelId ?? task?.channelId
          ? { channelId: (seed.channelId ?? task?.channelId)! } : {}),
        ...(seed.taskId ? { taskId: seed.taskId } : {}),
        ...(seed.outcome ? { outcome: seed.outcome } : {}),
        // REDACTED LIKE EVERY OTHER FREE-TEXT FIELD this process puts on a
        // screen: a hook's message can end up in a room, so a path, an argument
        // list or an environment value must not be able to ride out on it.
        what: redactForSharing(seed.what, 300),
        ...(seed.causedByHook || task?.causedByHook ? { causedByHook: true } : {}),
      });
      for (const firing of firings) {
        this.sendFrame({
          type: "hookFired", hookId: firing.hookId, event: firing.event,
          ok: firing.ok, said: firing.said, at: firing.at, firingId: firing.firingId,
        });
      }
    } catch (err) {
      console.error("[engine] could not run the owner's hooks:", err);
    }
  }

  // ============ VERIFICATION: did it do what it said? =======================

  /**
   * CHECK THE AGENT'S OWN WORDS AGAINST THE RECORD IT JUST WROTE, and say so in
   * the room when the two disagree (`verify.ts`).
   *
   * WHY IT IS HERE and not in `verify.ts`: the check itself is a pure function
   * over facts, and it stays that way. This method is only the plumbing — which
   * facts to hand it, and where the sentence goes if there is one.
   *
   * THE COUNTED HALF. What "left this computer" is read from the approval
   * desk's own ledger, narrowed to this turn's window, so a claim about a push
   * is checked against the gate every push must pass rather than against
   * anything the agent said. A desk with no ledger yet means every remote claim
   * comes back "I could not check" — never "it did not happen".
   *
   * Never throws, and never says anything when everything checks out. Silence
   * is the normal answer.
   */
  private checkClaims(agent: AgentDef, input: TurnInput, reply: string, record: RunRecord): void {
    try {
      if (!this.verifyClaims) return;
      const channelId = input.channelId;
      const remote = this.approvals.settledActions
        .filter(s => s.approved && s.at >= record.startedAt && s.at <= record.finishedAt + 1000)
        .map(s => s.facts);
      const report = verifyTurn({ reply, record, remote, remoteKnown: true });
      if (!report.line) return;
      // A MISMATCH IS NEWS, so a hook may act on it — before the sentence goes
      // out, so the record of it exists before the room hears it.
      this.fireHook({
        event: "check.mismatch", agentId: agent.id, outcome: record.outcome,
        ...(channelId ? { channelId } : {}),
        ...(record.taskId ? { taskId: record.taskId } : {}),
        what: `what ${agent.name} said does not match what it did`
          + ` (${report.mismatches.length} of ${report.claims.length})`,
      });
      if (!channelId) return;
      // SAID BY CLOUD9, IN THE AGENT'S OWN CONVERSATION, and marked `proactive`
      // because nobody asked for it. It goes in the thread the turn was
      // answering in, so it lands beside the claim it is about.
      this.agentSend(agent.id, channelId, redactForSharing(report.line, 1200), {
        proactive: true, ...(input.replyTo ? { replyTo: input.replyTo } : {}),
      });
    } catch (err) {
      console.error("[engine] could not check what an agent said against what it did:", err);
    }
  }

  /**
   * WHAT THIS AGENT HAS SPENT THIS MONTH, in dollars.
   *
   * One line, because the sum lives where the run records live (`RunStore`).
   * Wrapped because a spending total is paperwork, and paperwork that cannot be
   * read must never be the reason a crew stops: an unreadable folder reads as 0,
   * which applies no ceiling rather than applying one nobody can see.
   */
  private spentThisMonth(agentId: ID, at: number): number {
    try {
      return this.runs.spentInMonth(agentId, at);
    } catch (err) {
      console.error(`[engine] could not add up what agent ${agentId} has spent:`, err);
      return 0;
    }
  }

  /**
   * ASK THE AGENT WHAT IT INTENDS TO DO, SHOW HIM THE CARD, AND ONLY THEN WORK.
   *
   * THE SHAPE, and every part of it is an existing part of Cloud9:
   *
   *  1. ONE READ-ONLY TURN. `planOnly` narrows the harness to plan mode and the
   *     reading half of this agent's own tools (`CLAUDE_PLAN_TOOLS`). It is a
   *     real turn, so it is recorded like one — marked `planOnly` so nobody
   *     mistakes the plan for the job.
   *  2. THE PLAN GOES IN THE ROOM, so he can read it where he asked for it, and
   *     onto the ORDINARY APPROVAL CARD — the same `Approval`, the same
   *     Approve / Not now buttons, the same `decideApproval`.
   *     There is no second approval concept here; there is a third `kind`.
   *  3. NOTHING RUNS UNTIL HE ANSWERS. Every way out of the desk that is not an
   *     explicit yes is a no, and the agent says which in plain words.
   *  4. ON YES, the real turn runs — with the plan it just wrote handed back to
   *     it, so it does the thing he approved rather than starting again.
   *
   * Returns TRUE when the work went ahead, so the caller knows whether it still
   * has a turn to take.
   */
  private async planFirstTurn(agent: AgentDef, input: TurnInput): Promise<boolean> {
    const channelId = input.channelId;
    if (!channelId) {
      // no room means no card, and a promise of a card that cannot be drawn is
      // worse than not offering one — so the work does NOT go ahead silently
      await this.sayAs(agent, undefined, "I was asked to show a plan first, but this isn't "
        + "happening in a conversation where I can show you one, so I've stopped.", input);
      return false;
    }
    const plan = tidyPlan(await this.respondAs(agent, {
      ...input,
      planOnly: true,
      // WHY THIS PARAGRAPH IS SO EXPLICIT, and it is not padding. Measured
      // against CLI 2.1.222 on 2026-08-05 with the exact command line this
      // builds: plan mode's own system prompt tells the model to save a plan
      // FILE and then call `ExitPlanMode`. Cloud9 grants neither — a plan is
      // something the owner reads on a card, not a file an agent leaves in his
      // `~/.claude` folder — so the model spent its whole turn reporting that
      // both tools were missing and asking to be let out of plan mode. Nothing
      // was written, which is the boundary holding, but the owner would have
      // got a complaint on his card instead of a plan. So the turn says up
      // front that the answer IS the plan and that the absent tools are
      // deliberate.
      trigger: `${input.trigger}\n\nDo NOT do any of this yet, and do not try to save a `
        + `plan file or leave plan mode — those tools are deliberately not yours this turn, `
        + `and their absence is not a problem to report. YOUR REPLY IS THE PLAN. Write it `
        + `as a short numbered list someone who is not a programmer can judge: which files `
        + `or places you would touch, what you would change, and anything you would `
        + `deliberately leave alone. You are running read-only, so nothing you describe has `
        + `happened. Your owner will read this and say yes or no; if he says yes you will `
        + `be asked again, with the tools to do it.`,
    }));
    if (!plan) {
      await this.sayAs(agent, channelId, "I was asked to show you a plan first and I could "
        + "not produce one, so I have not started the work.", input);
      return false;
    }
    await this.sayAs(agent, channelId, `Here's what I intend to do — nothing has happened `
      + `yet:\n\n${plan}`, input);
    const outcome = await this.approvals.askPlan({
      agent, channelId, plan,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      ...(this.currentTurnToken(agent.id) ? { turnToken: this.currentTurnToken(agent.id) } : {}),
    });
    if (!outcome.approved) {
      await this.sayAs(agent, channelId,
        `I haven't done any of it — ${outcome.reason}.`, input);
      return false;
    }
    // THE PLAN HE APPROVED IS WHAT GETS DONE, so it travels into the real turn.
    // Starting again from the original ask would let the agent quietly do
    // something other than the thing on the card he said yes to.
    await this.respondAs(agent, {
      ...input,
      trigger: `${input.trigger}\n\nYour owner has approved this plan. Carry out EXACTLY `
        + `this plan and nothing beyond it:\n\n${plan}`,
    }).then(text => this.sayAs(agent, channelId, text, input));
    return true;
  }

  /** One sentence from an agent, in the room and the thread the turn belongs to. */
  private async sayAs(
    agent: AgentDef, channelId: ID | undefined, text: string, input: TurnInput,
  ): Promise<void> {
    if (!channelId) { console.error(`[engine] ${agent.name}: ${text}`); return; }
    // Not `sanitizeForChat`: that turns an ERROR into safe words, and every
    // sentence reaching here is either Cloud9's own or a plan already bounded
    // and stripped by `tidyPlan`.
    this.agentSend(agent.id, channelId, text,
      {
        ...(input.replyTo ? { replyTo: input.replyTo } : {}),
        ...(input.triggerMessageId ? { responseTriggerMessageId: input.triggerMessageId } : {}),
      });
  }

  /**
   * Build and store one run record. Never throws: a turn that worked must not
   * be reported as broken because its paperwork failed.
   */
  private recordRun(seed: RunSeed, finish: RunFinish, id?: string): RunRecord | undefined {
    try {
      const record = buildRunRecord(seed, finish, id);
      this.lastRun = record;
      this.runs.save(record);
      this.publishRun(record);
      this.onRunRecorded?.(record);
      // A TURN ENDED, AND A JOB ENDED WITH IT WHEN THERE WAS ONE. Told after
      // the record is stored, so a hook can never fire on a turn whose account
      // of itself does not yet exist. Fire-and-forget — see `fireHook`.
      this.fireHook({
        event: "turn.finished", agentId: record.agentId, outcome: record.outcome,
        ...(record.channelId ? { channelId: record.channelId } : {}),
        ...(record.taskId ? { taskId: record.taskId } : {}),
        what: `${record.agentName} ${plainOutcome(record.outcome)} — ${record.ask}`,
      });
      if (record.taskId) {
        this.fireHook({
          event: "job.finished", agentId: record.agentId, outcome: record.outcome,
          taskId: record.taskId,
          ...(record.channelId ? { channelId: record.channelId } : {}),
          what: `the job “${record.ask}” ${plainOutcome(record.outcome)}`,
        });
      }
      return record;
    } catch (err) {
      console.error(`[engine] could not record what ${seed.agentName} did:`, err);
      return undefined;
    }
  }

  /**
   * OFFER THE FILES THIS TURN PRODUCED to the hub — the engine's half of the
   * shared artifact store (docs/plans/artifact-store-handoff.md).
   *
   * WHY IT LIVES HERE, in `respondAs`, and nowhere else: every kind of turn ends
   * up in this one function — an ordinary chat reply, a delegated job, a
   * scheduled check-in, and a turn working inside a git worktree. One owner
   * means a new kind of turn cannot be added that quietly shares nothing.
   *
   * WHAT IT SENDS is bytes plus facts: the agent, the run, the job. Everything
   * derived — the version number, the sha, whether it is text, the stored name —
   * is the hub's, so an engine can never publish a version 1 over version 7 or
   * label a binary as text on somebody else's screen.
   *
   * WHERE IT LOOKS is the folder the turn ran in: the agent's own worktree when
   * it had one, its own data folder otherwise. Never the owner's repository and
   * never anywhere else on this machine — an agent shares its own work, not
   * whatever it happened to be able to read.
   *
   * Wrapped, like every other piece of turn paperwork: a hub that is briefly
   * away, or a folder that cannot be read, must never be the reason a turn that
   * really worked is reported as broken.
   */
  private shareProduced(agent: AgentDef, input: TurnInput, since: number, runId: string): void {
    // No conversation means nowhere to put a file. A turn with no channel is
    // not a turn anybody is waiting on a file from.
    const channelId = input.channelId;
    if (!channelId) return;
    try {
      const dir = input.workdir ?? this.agentDataDir(agent.id);
      const sweep = sweepProduced(dir, { since });
      this.publishCaptured(agent, input, runId, sweep);
    } catch (err) {
      console.error(`[engine] could not share the files ${agent.name} made:`, err);
    }
  }

  /**
   * Publish already-captured values. ZERO filesystem operations belong here.
   *
   * A ProducedFile has no path to reopen: its Buffer is the exact value the
   * capture phase accepted, and note/links/run attribution attach to that value.
   * Public for no caller; tests reach it only to prove source paths may be changed
   * or deleted after capture without changing the frame.
   */
  private publishCaptured(
    agent: AgentDef, input: TurnInput, runId: string, sweep: ArtifactSweep,
  ): void {
    const channelId = input.channelId;
    if (!channelId) return;
    for (const file of sweep.offers) {
      if (file.bytes.length === 0 || file.bytes.length > ARTIFACT_LIMITS.bytes) continue;
      this.sendFrame({
        type: "publishArtifact", channelId, agentId: agent.id, name: file.name,
        dataBase64: file.bytes.toString("base64"), runId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        ...(file.note !== undefined ? { note: file.note } : {}),
        ...(file.links !== undefined ? { links: file.links } : {}),
      });
    }
    // A REFUSAL IS SAID OUT LOUD, in the room, in the agent's own voice. The
    // file really is on this computer; silence here is the "the file's on disk"
    // complaint all over again, with the app doing the hiding.
    const said = describeRefusals(sweep.refused);
    // said where the turn is speaking — in the thread when the turn was asked
    // for in one, so a refusal cannot land away from the question it belongs to
    if (said) {
      this.agentSend(agent.id, channelId, said,
        { ...(input.replyTo ? { replyTo: input.replyTo } : {}) });
    }
  }

  /**
   * Send one run to the hub, so it can reach the screens.
   *
   * THE RAW RECORD NEVER LEAVES THIS PROCESS. What goes on the wire is
   * `shareableRun(record)` — the version with the Windows paths, the argv, the
   * account name and anything secret-shaped already taken out. The copy on disk
   * keeps the owner's own detail; this one is what other people may read.
   *
   * Wrapped, like every other piece of run paperwork: a hub that is briefly
   * disconnected must never be the reason a turn is reported as broken.
   */
  private publishRun(record: RunRecord): void {
    try {
      this.sendFrame({ type: "runRecorded", record: shareableRun(record) });
    } catch (err) {
      console.error("[engine] could not send a run record to the hub:", err);
    }
  }

  // ===== GAP C BLOCK (stopping a running turn, 2026-08-05) — start =====

  /**
   * STOP WHAT THIS AGENT IS DOING, NOW. Returns how many running turns were
   * stopped — 0 is a real answer and the caller says so out loud, because
   * "nothing happened" with no explanation is exactly how a person decides a
   * button is broken.
   *
   * Only this engine's own agents: an agent belonging to somebody else is not
   * this computer's to kill, and the check is here rather than only at the
   * caller, the same way `forgetMemoryNote` checks.
   *
   * It never throws. Stopping is what a person reaches for when things have
   * already gone wrong, and it failing loudly on top of that would be the worst
   * possible moment.
   */
  stopAgent(agentId: ID): number {
    if (!this.myAgents.some(a => a.id === agentId)) return 0;
    let count = 0;
    for (const live of [...this.liveTurns]) {
      if (live.agentId !== agentId) continue;
      try {
        live.scope.stop();
        try { live.abortController?.abort(); } catch { /* best effort */ }
        count++;
      } catch (err) {
        console.error(`[engine] could not stop a turn for agent ${agentId}:`, err);
      }
    }
    // ================================================================
    // AND THE WAIT THAT IS NOT A PROCESS (2026-08-06).
    // ================================================================
    //
    // The loop above kills child processes. An agent standing at the approval
    // desk — waiting to be allowed to push a branch, or waiting on its plan —
    // has NO child process running: it is parked on a promise. So a stop
    // reached nothing, the room said "🛑 Stopping — pulling the plug on what
    // I'm doing now", and the jobs screen went on saying "waiting for you" for
    // the rest of the card's life. The button was true about the processes and
    // false about the only thing he could see.
    //
    // Ended as a NO, never as a yes — pressing stop is not permission — and the
    // card's own path then does everything it already does for a refusal: the
    // job comes off "stuck", the room is told nothing left this computer, and
    // nothing is pushed. It is counted, so `!stop` still says something true
    // when the wait was the only thing this agent was doing.
    try {
      count += this.approvals.giveUpFor(agentId,
        "you stopped this run, so it did not happen");
    } catch (err) {
      console.error(`[engine] could not release a waiting card for agent ${agentId}:`, err);
    }
    // ================================================================
    // …AND THE WORK THAT HAS NOT STARTED YET (2026-08-06).
    // ================================================================
    //
    // The engine runs two turns at a time and QUEUES the rest. A turn still in
    // that queue has no scope, no card and no child process, so a stop reached
    // nothing at all: the room said "there was nothing running to stop", and
    // then — seconds later, once a slot came free — the agent went ahead and
    // answered, and the run was written down as an ordinary `ok`. That is the
    // worst version of this bug, because the owner was told his stop had found
    // nothing AND the thing he stopped happened anyway.
    //
    // Dropped rather than started-and-killed: starting it would spend his
    // money and his time on a turn he has already said he does not want.
    try {
      count += this.dropQueuedTurns(agentId);
    } catch (err) {
      console.error(`[engine] could not drop queued work for agent ${agentId}:`, err);
    }
    return count;
  }

  /** Is this agent running anything a stop could reach? Used by the room's answer. */
  isWorking(agentId: ID): boolean {
    for (const live of this.liveTurns) if (live.agentId === agentId) return true;
    return false;
  }

  /**
   * THE ONE PLACE A STOPPED TURN IS WRITTEN DOWN AND SPOKEN ABOUT.
   *
   * WHAT THE RECORD SAYS. `outcome: "cancelled"`, which is a different outcome
   * from `failed` — so a stop can never be mistaken for a crash in the run list,
   * and the summary reads "Stopped after …" instead of "Didn't finish". A
   * A turn has no timeout outcome: it works, fails, or the owner stops it.
   * Those three endings remain distinct on the record rather than blurred.
   *
   * WHAT THE ROOM SAYS is the sentence returned here: the caller posts it as the
   * agent's own reply, so the conversation says plainly that the work stopped
   * and why, rather than going quiet and leaving him wondering whether it is
   * still running and still costing him.
   */
  private turnWasStopped(
    agent: AgentDef, seed: RunSeed, input: TurnInput, trace?: ProviderTrace, id?: string,
  ): never {
    this.recordRun(seed, {
      finishedAt: Date.now(), outcome: "cancelled", trace,
      error: "you stopped this run",
    }, id);
    this.sendVerdict(agent.id, input, {
      outcome: "failed", ...(trace?.steps ? { steps: trace.steps } : {}),
      error: "you stopped this run",
    });
    // THROWN, NOT RETURNED — see `TurnStoppedError`. Returning the sentence is
    // what let every caller file a stopped turn under "finished".
    throw new TurnStoppedError(
      "🛑 Stopped. You stopped me, so I dropped what I was doing — nothing of it is " +
      "still running and nothing more will be spent on it. Tell me what to do differently " +
      "and I'll start again.");
  }

  // ===== GAP C BLOCK — end =====

  /**
   * The owner pulled the plug while the agent was still working. The run really
   * happened, so the record stays — it is re-saved as cancelled rather than
   * deleted, and the result is still discarded by the caller.
   */
  private markRunCancelled(taskId: ID): void {
    try {
      const record = this.lastRun;
      if (!record || record.taskId !== taskId || record.outcome !== "ok") return;
      const cancelled: RunRecord = { ...record, outcome: "cancelled" };
      this.lastRun = cancelled;
      this.runs.save(cancelled);
      this.publishRun(cancelled);
      this.onRunRecorded?.(cancelled);
    } catch (err) {
      console.error("[engine] could not mark a run as cancelled:", err);
    }
  }

  /**
   * Put a skill's files where the agent can read them: its own folder, one flat
   * level, nothing else touched. File names are re-checked here against the
   * same allowlist the relay used — a name that could point outside the folder
   * is SKIPPED, never rewritten into something safe (run.ts's law).
   */
  writeSkillFiles(agent: AgentDef): string[] {
    const failed: string[] = [];
    const skills = agent.skills ?? [];
    if (skills.length === 0) return failed;
    const dir = path.join(this.agentDataDir(agent.id), "skills");
    for (const skill of skills) {
      for (const file of skill.files ?? []) {
        if (!isSafeFileName(file.name)) {
          console.error(`[engine] skipped a skill file with an unusable name on agent ${agent.id}`);
          continue;
        }
        const target = path.join(dir, file.name);
        // belt and braces: the resolved path must still be inside the folder
        if (path.relative(dir, target).startsWith("..")) continue;
        // Whole or not at all. A skill file is read by the CLI, not by us, so a
        // half-written one is not refused anywhere — the agent simply follows
        // instructions that stop mid-sentence. Same owner, same rule.
        //
        // AND A MISSING ONE IS NOT ALLOWED TO PASS QUIETLY EITHER. `writeWholeFile`
        // does not throw, so ignoring its answer meant a disk failure left the
        // instructions incomplete and the turn ran anyway, on whatever files
        // happened to be there from last time. The names of what did not land
        // go back to the caller, which refuses the turn — see `respondAs`.
        const written = writeWholeFile(target, file.text,
          m => console.error(`[engine] could not write skill file for agent ${agent.id}: ${m}`));
        if (!written) failed.push(file.name);
      }
    }
    return failed;
  }

  /**
   * Run one chat turn for an agent on its own harness. Public so tests can drive it.
   *
   * ASKED IN A THREAD, ANSWERED IN THAT THREAD (his complaint). The thread is
   * read ONCE, here, from the message being answered, and then carried by the
   * turn — the answer, the honest failure sentence and anything `respondAs`
   * says afterwards all inherit it.
   */
  async takeTurn(
    agent: AgentDef, channelId: ID, trigger: Message,
    opts: { planFirst?: boolean } = {},
  ): Promise<void> {
    this.setStatus(agent.id, "working");
    const replyTo = threadOf(trigger);
    try {
      const brief: TurnInput = {
        context: this.renderContext(channelId, agent, replyTo),
        trigger: trigger.text,
        triggerAuthor: trigger.authorName,
        kind: "chat",
        channelId,
        requesterKind: trigger.authorKind === "agent" ? "agent" : "human",
        // the message the 👀 / 💭 / verdict are drawn on — the one being answered
        triggerMessageId: trigger.id,
        ...(replyTo ? { replyTo } : {}),
        // THE SAME THREAD, TURN AFTER TURN — offered so the harness can continue
        // its own session rather than being re-told the room. Chat turns only:
        // a delegated job, a scheduled check-in and repository work all reach
        // `respondAs` by other routes and stay cold, which is this slice's
        // deliberate edge (`sessionresume.ts`).
        ...(() => {
          const thread = this.threadContinuity(agent, channelId, trigger);
          return thread ? { thread } : {};
        })(),
      };
      // SHOW ME THE PLAN FIRST. Two ways in and ONE implementation: the owner's
      // standing setting on the agent (`showsPlanFirst`), or this one message
      // asking for it (`!plan …`). Neither is checked anywhere else, so a plan
      // gate cannot be half-applied.
      //
      // A PLAN TURN DOES NOT RESUME THE THREAD, so the continuity offered above
      // is dropped for it — see `planResume` in claude-cli.ts for why a
      // read-only session must not become the one the real turn continues.
      if (opts.planFirst || showsPlanFirst(agent)) {
        const { thread: _dropped, ...cold } = brief;
        await this.planFirstTurn(agent, cold);
        return;
      }
      const text = await this.respondAs(agent, brief);
      this.agentSend(agent.id, channelId, text, {
        ...(replyTo ? { replyTo } : {}),
        ...(trigger.id ? { responseTriggerMessageId: trigger.id } : {}),
      });
    } catch (err) {
      // A STOP IS NOT A BREAKAGE. He pressed the button, so the agent says so
      // in its own words rather than being reported as broken.
      this.agentSend(agent.id, channelId,
        saidWhenTurnEnded(err, `${agent.name} could not take a turn`),
        {
          ...(replyTo ? { replyTo } : {}),
          ...(trigger.id ? { responseTriggerMessageId: trigger.id } : {}),
        });
    } finally {
      this.setStatus(agent.id, "idle");
    }
  }

  /** Claim and execute tasks assigned to my agents (status not_started). */
  private maybeRunTask(task: Task): void {
    if (task.status !== "not_started") return;
    if (this.claimed.has(task.id)) return;
    const agent = this.myAgents.find(a => a.id === task.agentId);
    if (!agent) return;
    // the hub has now given this job an id, so the message it was asked in can
    // be tied to it and wear the rest of its ticks
    if (!this.askMessageFor.has(task.id)) {
      const { messageId, replyTo, rest } = takeAsk(this.pendingAsks, task);
      this.pendingAsks = rest;
      if (messageId) this.askMessageFor.set(task.id, messageId);
      if (replyTo) this.askThreadFor.set(task.id, replyTo);
    }
    if (agent.lifecycle === "paused" || agent.lifecycle === "disabled") return; // FR-AG-007
    // Last gate on "who may make this agent act". The relay checks the same
    // rule when the task is created; this is the check that runs on the machine
    // that would actually spend the money and start the program, and the two
    // deliberately do not trust each other. Same function, no second copy.
    if (!mayDriveAgent(task.requesterId, agent)) {
      console.error(
        `[engine] refused a job for ${agent.name}: ${task.requesterId} may not drive this agent`);
      return;
    }
    this.claimed.add(task.id);
    void this.enqueueAgentTurn(agent.id, () => this.runTask(agent, task));
  }

  private async runTask(agent: AgentDef, task: Task): Promise<void> {
    // A JOB REPORTS BACK WHERE IT WAS ASKED FOR. If the "@Scout !bg …" was typed
    // inside a thread, everything this job says goes in that thread — and the
    // finished result also gets one short line in the room (`reportFinished`).
    // A job made from the Tasks panel, or asked for in the room, has no thread
    // here and behaves exactly as before.
    const thread = this.askThreadFor.get(task.id);
    const inThread = thread ? { replyTo: thread } : {};
    this.setStatus(agent.id, "working");
    this.markWork(task, "picked", false);
    this.markWork(task, "working");
    this.sendFrame({ type: "updateTask", taskId: task.id, status: "working" });
    // OUR OWN COPY KNOWS TOO, without waiting for the hub to say it back. The
    // stuck/unstuck pair below asks "is this job of ours still running?", and a
    // job that has genuinely started must answer yes from the moment it starts —
    // not from whenever the echo happens to land.
    this.noteStatus(task.id, "working");
    try {
      // schedule-creation tasks (approved via the task machine)
      const sched = /^!schedule (daily \d{1,2}:\d{2}|every \d+m):\s*(.+)$/i.exec(task.title);
      if (sched) {
        const s: AgentSchedule = {
          id: `s_${Date.now().toString(36)}`, agentId: agent.id, channelId: task.channelId,
          when: sched[1].toLowerCase(), prompt: sched[2], enabled: true,
        };
        // The approved half of the same lie. This job's whole product is a row
        // in a file; if the file did not take it, the job did not succeed and
        // is not marked completed.
        if (!this.saveSchedule(s)) {
          this.sendFrame({
            type: "updateTask", taskId: task.id, status: "failed",
            error: SCHEDULE_NOT_SAVED,
            summary: "The schedule could not be saved on this computer.",
          });
          this.markWork(task, "working", false);
          this.markWork(task, "failed");
          this.agentSend(agent.id, task.channelId, SCHEDULE_NOT_SAVED, inThread);
          return;
        }
        this.sendFrame({
          type: "updateTask", taskId: task.id, status: "completed",
          result: `schedule ${s.id} created`,
          // this job did not run a turn, so there is no run record and nothing
          // measured. The one true sentence about it is the one it can prove.
          summary: `Scheduled: ${s.when} — ${s.prompt}`.slice(0, 200),
        });
        this.markWork(task, "working", false);
        this.markWork(task, "done");
        this.agentSend(agent.id, task.channelId,
          `⏰ Approved & scheduled: ${s.when} — "${s.prompt}" (id ${s.id})`, inThread);
        return;
      }
      // WORK IN THE CODE, AS A JOB — "!code <what to do>" asked for in the
      // background ("@Scout !bg !code fix the build") or made from the Tasks
      // panel. The SAME function the room uses, so there is one order of events
      // and one set of laws: its own worktree, everything local until the agent
      // itself asks, and the only thing that leaves this computer behind the
      // approval card. Without this line the words "!code" arrived at the CLI as
      // prose and the job talked about the work instead of doing it.
      //
      // The thing that is new is that A JOB IS WATCHING. The task id travels
      // with the ask, so while the card sits unanswered the job says on his
      // screen that it is stuck and on whom — see `jobIsStuck`.
      const code = /^!code\s+([\s\S]+)$/i.exec(task.title.trim());
      if (code) {
        const result = await this.workInRepository(agent, {
          channelId: task.channelId, ask: code[1].trim(),
          triggerAuthor: task.requesterName, taskId: task.id,
          ...inThread,
        });
        // FR-TS-005: stopped while we worked, so the result is discarded
        if (this.tasks.get(task.id)?.status === "cancelled") {
          this.markRunCancelled(task.id);
          this.markWork(task, "working", false);
          return;
        }
        if (!result || result.outcome === "failed") {
          // `problem` is already safe to show (repowork.ts writes it); the
          // fallback is for the turn that never started, which has already said
          // why in the room.
          const problem = result?.problem
            ?? "I could not work in the code for this project — the reason is in the conversation.";
          this.sendFrame({
            type: "updateTask", taskId: task.id, status: "failed",
            error: redactForSharing(problem, 300),
            ...this.summaryFor(undefined),
          });
          this.markWork(task, "working", false);
          this.markWork(task, "failed");
          return;
        }
        // DONE — including when the publish was refused. The agent did the work,
        // asked, and was told no BY HIM; calling his own "no" a failure would
        // read on screen as the app breaking. The sentence says exactly what
        // happened and what did not leave this computer, and it is built by
        // `describeRepoTurn` from git's account, never from the agent's — and it
        // never names a folder.
        this.sendFrame({
          type: "updateTask", taskId: task.id, status: "completed",
          result: describeRepoTurn(result).slice(0, 2000),
          ...this.summaryFor(result.reply),
        });
        this.markWork(task, "working", false);
        this.markWork(task, "done");
        return;
      }
      const text = await this.respondAs(agent, {
        context: this.renderContext(task.channelId, agent, thread),
        trigger: `Background task: ${task.title}. Do the work and report the outcome.`,
        triggerAuthor: task.requesterName,
        kind: "task",
        channelId: task.channelId,
        taskId: task.id,
        // the SAME message the work ticks land on (`askMessageFor`), so a job's
        // receipts and its 👀/⚙️ reactions can never end up on two different
        // messages. A job made from the Tasks panel has no asking message and
        // therefore gets no receipts — the same rule `markWork` follows.
        ...(this.askMessageFor.get(task.id)
          ? { triggerMessageId: this.askMessageFor.get(task.id)! } : {}),
        ...inThread,
      });
      // FR-TS-005: if cancelled while we worked, discard the result
      if (this.tasks.get(task.id)?.status === "cancelled") {
        this.markRunCancelled(task.id);
        this.markWork(task, "working", false);
        return;
      }
      this.sendFrame({
        type: "updateTask", taskId: task.id, status: "completed", result: text.slice(0, 2000),
        ...this.summaryFor(text),
      });
      this.markWork(task, "working", false);
      this.markWork(task, "done");
      this.reportFinished(agent.id, task.channelId, thread,
        `📦 Task done:\n${text}`, roomLineForThreadJob(task.title), true, this.askMessageFor.get(task.id));
    } catch (err) {
      // HE STOPPED IT, so it is not a job that failed and it is certainly not a
      // job that finished. Its own ending, written down and said out loud.
      if (err instanceof TurnStoppedError) { this.jobWasStopped(agent, task, err.said); return; }
      const said = sanitizeForChat(err, `task "${task.title}" failed`);
      this.sendFrame({
        type: "updateTask", taskId: task.id, status: "failed", error: said,
        ...this.summaryFor(undefined),
      });
      this.markWork(task, "working", false);
      this.markWork(task, "failed");
      // a job that fell over is still a finished job: the reason goes where it
      // was asked for, and the room hears that it ended
      this.reportFinished(agent.id, task.channelId, thread, said,
        roomLineForThreadJob(task.title, "failed"), false, this.askMessageFor.get(task.id));
    } finally {
      this.setStatus(agent.id, "idle");
      this.askMessageFor.delete(task.id);
      this.askThreadFor.delete(task.id);
    }
  }

  /**
   * A JOB THE OWNER STOPPED — written down and said out loud as its own thing.
   *
   * THE THIRD ENDING. A job used to have two: it finished, or it fell over.
   * A stop was quietly filed under the first, because `respondAs` handed the
   * stop sentence back like any other answer — so the job read `completed`, his
   * message wore a ✅ and the room said "Finished in the thread". Three
   * different things were being told to him as one.
   *
   * WHERE IT IS SAID, and this is deliberate: THE ROOM, not the thread. He
   * pressed Stop while looking at the room, so the answer to "did that work?"
   * belongs in front of him — not folded into a thread panel he would have to
   * know to open. It is one message, not two, so he is never told the same
   * thing twice in two places (the duplicate-block rule the agent editor
   * learned the hard way). Written in the shape the screen already understands
   * for the end of a job, so the run card — the one that says `cancelled` — is
   * drawn beside it without a second mechanism.
   */
  private jobWasStopped(agent: AgentDef, task: Task, said: string): void {
    this.sendFrame({
      type: "updateTask", taskId: task.id, status: "cancelled",
      result: said.slice(0, 2000),
      ...this.summaryFor(said),
    });
    this.markWork(task, "working", false);
    this.markWork(task, "stopped");
    // NOT "proactive": he asked for this by pressing the button, so the message
    // must not wear the "Nobody asked — I noticed" badge that marks a line the
    // agent volunteered.
    this.agentSend(agent.id, task.channelId, `📦 Task stopped:\n${said}`);
  }

  /**
   * The TLDR the agent writes about its own finished job (his item 3).
   *
   * Built from the run record this turn ALREADY produced — `lastRun` is the one
   * this engine wrote most recently, and it is checked against the task before
   * it is used, so a summary can never be borrowed from somebody else's job.
   * Returns an empty patch when there is nothing honest to say, which is how a
   * `summary` field simply does not appear on the frame.
   */
  private summaryFor(reply: string | undefined): { summary?: string } {
    try {
      const record = this.lastRun;
      if (!record) return {};
      const summary = taskTldr(record, reply);
      // the hub will check this too; checking here as well means an unusable
      // sentence is dropped rather than bouncing off the gate mid-job
      if (!summary || validateTaskSummary(summary)) return {};
      return { summary };
    } catch (err) {
      console.error("[engine] could not summarise a finished job:", err);
      return {};
    }
  }

  // ---- STUCK: the one state a job can be in that is nobody's fault ----
  //
  // "Stuck — waiting on something" has been on his screen since the jobs list
  // was drawn, and until now the engine never produced it: every job was
  // working, done, failed or stopped. A state the product can SHOW but never
  // REACH is a promise the app does not keep, so either it becomes true or it
  // comes off the screen. This makes it true, for the one case where it really
  // is: THE JOB HAS ASKED HIM SOMETHING AND IS STANDING THERE WAITING.
  //
  // Why only that case, and why nothing else here:
  //  * A JOB WAITING ON AN APPROVAL CARD is genuinely not working. Its turn has
  //    stopped, mid-run, at the one thing it may not do alone, and it will not
  //    move again until a person answers or he stops it. Nothing is
  //    wrong with it and nothing is going to change without him. That is the
  //    definition of stuck, and it is the state he most needs to see, because he
  //    is the thing it is stuck on.
  //  * A HANDOFF THAT WAS NEVER PICKED UP is not this. A handoff carries no job
  //    (`handOffInRoom`): it is a message to another agent, and the sender's own
  //    task, if it had one, is finished the moment it is passed on. There is
  //    nothing waiting to un-stick, so calling anything blocked there would be
  //    inventing a state, not reporting one.
  //  * A MISSING OR SIGNED-OUT CLI is not this either. `HarnessUnavailableError`
  //    ends the turn: `runTask` catches it and the job is FAILED, with the
  //    reason the harness gave. It is dead, not waiting — and a dead job painted
  //    as "waiting on something" is the more dishonest of the two, because it
  //    tells him to expect it to carry on.
  //
  // AND IT ALWAYS CLEARS. `onWaitEnd` fires on every way out of the desk — yes,
  // no, stopped, engine shutting down — so the job goes back to working and the ordinary
  // completed/failed ending follows from the turn itself. A stuck state with no
  // way out would be worse than no stuck state at all.

  /** Jobs standing at the approval gate: how many asks deep, and did we say so. */
  private stuckJobs = new Map<ID, { asks: number; said: boolean }>();

  /**
   * A JOB HAS ASKED HIM SOMETHING AND CANNOT MOVE UNTIL HE ANSWERS.
   *
   * The sentence is built from the SAME counted facts the card is written from
   * (`describeRemoteAction`, shared's — one owner for the words), never from
   * anything the agent said, and it goes through `redactForSharing` like every
   * other free-text field this process puts on the wire: a path, an argument
   * list or an environment value can never ride out on a status line.
   */
  private jobIsStuck(taskId: ID, facts?: RemoteActionFacts): void {
    const seen = this.stuckJobs.get(taskId) ?? { asks: 0, said: false };
    seen.asks += 1;
    this.stuckJobs.set(taskId, seen);
    if (seen.asks > 1) return;           // already standing there; one card at a time
    if (!this.runningTask(taskId)) return;
    seen.said = true;
    this.sendFrame({
      type: "updateTask", taskId, status: "blocked",
      // the field the screen already reads for a job in trouble
      error: redactForSharing(facts
        ? `Waiting for you to approve: ${describeRemoteAction(facts)}.`
        : "Waiting for you to look at the plan. Nothing has been done yet.", 300),
    });
    this.noteStatus(taskId, "blocked");
  }

  /**
   * SOMETHING LEFT THIS COMPUTER AND HE WAS NOT ASKED — because he told this
   * agent not to ask. He is told anyway, in the room, at the moment it happens.
   *
   * THIS IS THE HALF OF "DON'T ASK ME" THAT IS NOT NEGOTIABLE. He asked to stop
   * being interrupted; he did not ask to stop being able to find out. So the
   * card goes away and the sentence does not — and the sentence is built from the
   * SAME counted facts the card would have carried (`describeRemoteAction`,
   * shared's one owner for those words: the branch git generated, the repository
   * gh named, the number `git rev-list` counted). Not one word of it is quoted
   * from the agent, for exactly the reason the card never quoted the agent: a
   * thing that describes itself describes itself as harmless.
   *
   * It is `proactive` because he did not ask for it — the room draws it as the
   * agent volunteering something, which is what it is.
   */
  private saidWithoutAsking(
    what: { agent: AgentDef; taskId?: ID; channelId: ID; facts: RemoteActionFacts },
  ): void {
    const line = `Done without asking you first: ${describeRemoteAction(what.facts)}. `
      + `(You chose “${trustLevel(trustOf(what.agent)).label}” for me.)`;
    this.agentSend(what.agent.id, what.channelId, redactForSharing(line, 400),
      { proactive: true });
  }

  /**
   * HE ANSWERED, OR NOBODY DID. Either way the turn has been told and is doing
   * something again — writing the pull request, or writing the sentence that
   * says it did not happen — so the job is working, and the honest ending
   * arrives from `runTask` the ordinary way.
   */
  private jobIsMovingAgain(taskId: ID): void {
    const seen = this.stuckJobs.get(taskId);
    if (!seen) return;
    seen.asks -= 1;
    if (seen.asks > 0) return;           // another card is still open on this job
    this.stuckJobs.delete(taskId);
    if (!seen.said) return;              // we never said it was stuck; say nothing now
    if (!this.runningTask(taskId)) return;
    // "" is "clear it", not "leave it alone" — the wait is over, so the reason
    // for it must not be left sitting on the job like a failure.
    this.sendFrame({ type: "updateTask", taskId, status: "working", error: "" });
    this.noteStatus(taskId, "working");
  }

  /**
   * Keep our copy of a job in step with what we just told the hub.
   *
   * It is a COPY and never a permission: nothing is decided from it. The hub
   * remains the one owner of a job's real state and will say it back; this only
   * stops the engine from being briefly wrong about work it is doing itself.
   */
  private noteStatus(taskId: ID, status: TaskStatus): void {
    const task = this.tasks.get(taskId);
    // a job somebody stopped stays stopped — the same rule the hub enforces
    if (!task || task.status === "cancelled") return;
    // A NEW OBJECT, never a scribble on the caller's. The job arrived from
    // somebody else's hands (the hub's frame, a test's fixture) and writing on
    // it would change what THEY hold — which is how one test's job turned up
    // half-run in the next one.
    this.tasks.set(taskId, { ...task, status });
  }

  /**
   * Is this a job of ours that is still running? A job that was stopped, or has
   * already finished, must never be dragged back onto the board — the hub
   * refuses that for `cancelled` and we do not ask it to.
   */
  private runningTask(taskId: ID): boolean {
    const status: TaskStatus | undefined = this.tasks.get(taskId)?.status;
    return status === "working" || status === "blocked";
  }

  /**
   * Put one of the four work emoji on the message that asked for this job — or
   * take it off again.
   *
   * ONE CALL SITE FOR THE VOCABULARY: every tick in this file goes through here
   * and `workEmoji`, so no call site can invent a fifth emoji or use a different
   * tick for the same moment. A job nobody asked for in a message (one made
   * from the Tasks panel) has no message to mark, and gets no ticks rather than
   * somebody else's.
   */
  private markWork(task: Task, phase: WorkReaction, on = true): void {
    const messageId = this.askMessageFor.get(task.id);
    if (!messageId) return;
    this.reactAs(task.agentId, messageId, phase, on);
  }

  /** Send one reaction as an agent. Never throws — a tick is never worth a turn. */
  private reactAs(agentId: ID, messageId: ID, phase: WorkReaction, on = true): void {
    try {
      this.sendFrame({ type: "agentReact", agentId, messageId, emoji: workEmoji(phase), on });
    } catch (err) {
      console.error("[engine] could not react to a message:", err);
    }
  }

  private async backgroundTask(agent: AgentDef, channelId: ID, trigger: Message): Promise<void> {
    this.setStatus(agent.id, "working");
    // same law as `runTask`: asked in a thread → answered in that thread, with
    // one short line in the room when it is done
    const thread = threadOf(trigger);
    try {
      const text = await this.respondAs(agent, {
        context: this.renderContext(channelId, agent, thread),
        trigger: `Background task: ${trigger.text.replace(/^!bg\s+/i, "")}. Do the work and report the outcome.`,
        triggerAuthor: trigger.authorName,
        kind: "task",
        channelId,
        triggerMessageId: trigger.id,
        ...(thread ? { replyTo: thread } : {}),
      });
      this.reportFinished(agent.id, channelId, thread, `📦 Background task done:\n${text}`,
        roomLineForThreadJob(trigger.text.replace(/^!bg\s+/i, "")), true, trigger.id);
    } catch (err) {
      // Same law as `jobWasStopped`: a stop is said in the room he pressed the
      // button in, and it is never dressed up as a job that finished.
      if (!(err instanceof TurnStoppedError)) throw err;
      this.agentSend(agent.id, channelId, `📦 Background task stopped:\n${err.said}`);
    } finally {
      this.setStatus(agent.id, "idle");
    }
  }

  /**
   * A standing order comes round. THIS ONE STAYS IN THE ROOM, on purpose: at the
   * moment it fires there is no message it is answering, so there is no thread
   * it belongs inside — and a 6:30am check-in dropped into a thread from weeks
   * ago is a line nobody would ever see. The command that CREATED the schedule
   * was answered where it was typed (`handleScheduleCommand`); the schedule
   * itself is proactive, and proactive means the room.
   */
  private async fireSchedule(s: AgentSchedule): Promise<void> {
    const agent = this.myAgents.find(a => a.id === s.agentId);
    if (!agent) return;
    if (agent.lifecycle === "paused" || agent.lifecycle === "disabled") return; // FR-AG-007
    await this.enqueueAgentTurn(agent.id, async () => {
      this.setStatus(agent.id, "working");
      try {
        const text = await this.respondAs(agent, {
        // no thread: a schedule answers nothing, so there is no side
        // conversation to serve first — see `fireSchedule`'s own note.
          context: this.renderContext(s.channelId, agent),
          trigger: `Scheduled task fired: ${s.prompt}`,
          triggerAuthor: "schedule",
          kind: "schedule",
          channelId: s.channelId,
          requesterKind: "schedule",
        });
      this.agentSend(agent.id, s.channelId, `⏰ ${text}`, { proactive: true });
      } catch (err) {
        this.agentSend(agent.id, s.channelId,
          saidWhenTurnEnded(err, `scheduled check-in ${s.id} failed`));
      } finally {
        this.setStatus(agent.id, "idle");
      }
    });
  }

  /**
   * The conversation as the agent reads it. The RULE lives in `context.ts` —
   * this is only "which conversation". It used to be a `slice(-20)` written
   * inline here, with the 20 as a default argument nobody ever set; see the long
   * note in that file for why that was the single most damaging line in the
   * engine.
   */
  private renderContext(
    channelId: ID, agent?: Pick<AgentDef, "model" | "provider">, thread?: ID,
  ): string {
    const history = this.history.get(channelId) ?? [];
    // THE THREAD FIRST, THEN THE REST OF THE ROOM.
    //
    // `thread` is the SAME value that decides where the answer goes — every
    // caller already worked it out through `threadOf` (`threads.ts`) and then
    // used it for nothing but the reply. So a turn taken inside a thread was
    // handed the whole room flat, and the thread's own opening message competed
    // with unrelated room chatter for the same budget: an agent could be dropped
    // into a side conversation without being given the start of it.
    //
    // One value, two uses now. Nothing is dropped that was not already being
    // dropped — it is an ORDERING; see the note on `renderConversation`.
    return renderConversation(history, this.contextBudgetFor(agent),
      thread ? { thread } : {});
  }

  /**
   * ONLY WHAT IS NEW — the conversation SINCE one message (`sessionresume.ts`,
   * law 5).
   *
   * This is the saving, AND IT IS WHAT MAKES A BIGGER BUDGET AFFORDABLE. A
   * resumed turn is handed these few lines instead of the whole room, because
   * the harness's own session already holds everything before them; sending
   * both would charge the owner twice for the same history and show the agent
   * one conversation in two shapes.
   *
   * Measured (2026-08-05, Sonnet 5): the cold first turn of a thread on a
   * 1,000,000-token model now costs about 47,000 tokens of conversation instead
   * of 9,700. Every turn after it in the same thread costs only the handful of
   * lines said since — a few hundred tokens. So widening the budget is paid
   * once per thread, not once per turn. What still pays it every time is the
   * turns that CANNOT resume: a scheduled check-in, a delegated job, a
   * repository turn and any room message that is not in a thread. That is
   * precisely why `conversationBudgetFor` has a ceiling.
   *
   * UNDEFINED IS A REAL ANSWER, and it is the safe one. If the message we were
   * told to start after is no longer in the window — the room moved on, the
   * engine restarted, the history was trimmed — then we do not know what the
   * session has and has not seen. Guessing "everything after the oldest we
   * still hold" would silently drop messages the agent never read. So it says
   * nothing, and the caller runs a cold turn with the whole room.
   */
  private renderContextSince(
    channelId: ID, afterMessageId: string, agent?: Pick<AgentDef, "model" | "provider">,
  ): string | undefined {
    const history = this.history.get(channelId) ?? [];
    const at = history.findIndex(m => m.id === afterMessageId);
    if (at < 0) return undefined;
    const fresh = history.slice(at + 1);
    if (fresh.length === 0) return undefined;
    // NO THREAD SCOPE HERE, on purpose: these are the few lines said since the
    // last turn, and putting some of them before others would reorder a handful
    // of messages for no gain. The budget still follows the model.
    return renderConversation(fresh, this.contextBudgetFor(agent));
  }

  /**
   * WHAT THE PROVIDER NEEDS TO CONTINUE THIS THREAD'S SESSION, or undefined when
   * there is nothing to continue.
   *
   * The key is the thread root, not the channel: two side conversations in one
   * room are two conversations, and one session between them would hand each the
   * other's history. `threads.ts` already owns what a thread root is.
   */
  private threadContinuity(
    agent: Pick<AgentDef, "id" | "model" | "provider">, channelId: ID, trigger: Message,
  ): ThreadContinuity | undefined {
    const root = threadOf(trigger);
    if (!root) return undefined;
    return {
      key: sessionKeyId({ agentId: agent.id, channelId, threadRoot: root }),
      newestMessageId: trigger.id,
      since: (afterMessageId: string) =>
        this.renderContextSince(channelId, afterMessageId, agent),
    };
  }

  /**
   * How much conversation this engine gives an agent — ASKED PER AGENT, because
   * the answer depends on the model that agent runs on (`context.ts` owns the
   * rule; this is only "whose model").
   *
   * An agent we were not given — an older call site, a test — falls back to the
   * floor, which is exactly the number every agent got before 2026-08-05.
   *
   * `contextMessages` is still honoured because tests and QA set it, and it is
   * still a CEILING on top of the real budget rather than the whole rule.
   */
  private contextBudgetFor(agent?: Pick<AgentDef, "model" | "provider">): ConversationBudget {
    const budget = agent
      ? conversationBudgetFor(agent.model, agent.provider)
      : CONVERSATION_BUDGET;
    const n = this.opts.contextMessages;
    return n === undefined ? budget : { characters: budget.characters, messages: n };
  }

  /**
   * SEARCH THIS ONE CONVERSATION, on behalf of an agent taking a turn in it.
   *
   * The channel is not a parameter the model can reach: `openToolTurn` below
   * binds it when the turn opens, and this method is the only thing that binding
   * can call. It is also sent to the hub as `channelId`, which the hub checks
   * against stored membership on its own side — so the scope is enforced twice,
   * by two processes that do not trust each other.
   */
  async searchChannel(channelId: ID, query: string, limit: number): Promise<Cloud9SearchAnswer> {
    const results = await this.askHubToSearch(channelId, query, limit);
    return {
      hits: results.results
        // BELT AND BRACES. Even if the hub ever widened a scope, nothing from
        // another conversation gets past this line.
        .filter(hit => hit.message.channelId === channelId)
        .map(hit => ({
          author: hit.message.authorName,
          when: hit.message.ts,
          text: hit.message.deletedAt ? "(this message was deleted)" : hit.message.text,
        })),
      hasMore: results.hasMore,
    };
  }

  /** One `search` frame out, one `searchResults` frame back. Never waits for ever. */
  private askHubToSearch(
    channelId: ID, query: string, limit: number,
  ): Promise<Extract<ServerFrame, { type: "searchResults" }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.searchWaiters.delete(waiter);
        reject(new Error("the hub did not answer the search in time"));
      }, SEARCH_WAIT_MS);
      const waiter = (frame: Extract<ServerFrame, { type: "searchResults" }>): boolean => {
        if (frame.query !== query) return false;
        clearTimeout(timer);
        resolve(frame);
        return true;
      };
      this.searchWaiters.add(waiter);
      this.sendFrame({ type: "search", channelId, query, limit });
    });
  }

  /**
   * OPEN CLOUD9'S OWN TOOLS FOR ONE TURN. The conversation is closed over here,
   * where it is known, and there is no way to pass a different one in — which is
   * the whole of the "an agent may search only where it may read" law.
   */
  openToolTurn = (turn: { channelId: string; agentId?: string }): OpenTurn | undefined => {
    // ===== GAP A BLOCK (agent-written memory, 2026-08-05) — start =====
    // THIS TURN'S OWN ALLOWANCE. It lives in the closure, so it is per-turn by
    // construction rather than by somebody remembering to reset it: when the
    // turn closes, the counter goes with it.
    let written = 0;
    // ===== GAP A BLOCK — end =====
    return this.tools.openTurn({
      channelId: turn.channelId,
      search: (query, limit) => this.searchChannel(turn.channelId, query, limit),
      // THE SAME BINDING, FOR THE SAME REASON. The conversation is closed over
      // here; `open_attachment` has no parameter through which another one could
      // be named, and the hub asks its own question again before it hands over
      // a single byte.
      openAttachment: name => this.openAttachmentInChannel(turn.channelId, name),
      // ===== GAP A BLOCK (agent-written memory, 2026-08-05) — start =====
      // THE SAME BINDING A THIRD TIME. The AGENT is closed over here, so
      // `remember_this` has no parameter through which another agent's memory
      // could be named — and `rememberFromAgent` asks whose agent it is again
      // on its own side before anything is written.
      //
      // A turn opened without an agent (an older caller, a test) simply has no
      // memory doorway: the tool says so plainly. It is never "write it into
      // whichever agent we happen to have".
      // ===== GAP B BLOCK (skills on demand, 2026-08-05) — start =====
      // THE SAME BINDING AGAIN, FOR SKILLS. The AGENT is closed over here, so
      // `open_skill` has no parameter through which another agent's standing
      // instructions could be named. A turn opened without an agent has no skill
      // doorway at all, and the prompt is built from that same fact — such a turn
      // is given its skills in full instead.
      ...(turn.agentId ? { openSkill: async (name: string) =>
        this.openSkillForAgent(turn.agentId as ID, name) } : {}),
      // ===== GAP B BLOCK — end =====
      ...(turn.agentId ? {
        remember: async (text: string, kind: string) => {
          if (written >= MEMORY_NOTES_PER_TURN) {
            return {
              saved: false as const,
              why: `You have already saved ${MEMORY_NOTES_PER_TURN} notes in this turn, ` +
                `which is as many as one turn may keep. Say what else you learned in your ` +
                `answer instead, and remember it next time if it still matters.`,
            };
          }
          const answer = await this.rememberFromAgent(turn.agentId!, text, kind, turn.channelId as ID);
          if (answer.saved) written++;
          return answer;
        },
      } : {}),
      // ===== GAP A BLOCK — end =====
      // ===== SPENDING BLOCK (what the crew costs, 2026-08-07) — start =====
      // THE ONE DOORWAY IN THIS LIST THAT LOOKS PAST THE AGENT TAKING THE TURN,
      // and it is still bound exactly as tightly as the rest — just around a
      // different thing. The AGENT is closed over here; the OWNER is read off
      // that agent inside; the crew is that owner's agents. `check_token_use`
      // has no parameters at all, so there is nothing for a model to argue
      // with, and a turn opened without an agent has no doorway.
      //
      // Widening what an agent can SEE is what the owner asked for ("so that
      // agents can see and help optimize other agents"). Widening what an agent
      // can DO is what he did not ask for and what the rest of this app is
      // built to prevent — so `propose_saving` writes nothing, ever, and both
      // the engine and the hub check the change is one of the closed two.
      ...(turn.agentId ? {
        spending: async () => this.spendingForOwnerOf(turn.agentId as ID),
        proposeSaving: async (about: string, change: unknown, because: string) =>
          this.proposeSavingFromAgent(
            turn.agentId as ID, turn.channelId as ID, about, change, because),
      } : {}),
      // ===== SPENDING BLOCK — end =====
    });
  };

  /**
   * OPEN A FILE ATTACHED IN ONE CONVERSATION, for the agent taking a turn there.
   *
   * The rules — which file, is it words, what do we say when it is not — live in
   * `attachmentreach.ts` and are testable without any of this. What lives HERE
   * is the only part that needs a live hub: turning an attachment into bytes.
   *
   * THE PERMISSION BOUNDARY, stated once:
   *  • the candidates are the messages of THIS conversation and nothing else —
   *    the channel is bound by `openToolTurn`, not passed by the model;
   *  • the hub refuses a ticket for a file in a room this owner may not read
   *    (`attachmentTicket` → `channelFor`), and asks the same question again on
   *    the way out (`serveAttachment`). Neither check is copied here.
   * Nothing is written to disk at any point, so there is nothing for the
   * whole-computer grant to be needed for. THAT IS STILL TRUE NOW THAT PICTURES
   * AND PDFs TRAVEL (gap 1b): they go to the model as MCP content blocks —
   * base64 in the tool result, in memory the whole way — never as a file on a
   * path. `attachmentreach.test.ts` asserts it structurally, by refusing either
   * of the two files on this path the right to import `node:fs` at all.
   */
  async openAttachmentInChannel(
    channelId: ID, name: string,
  ): Promise<Cloud9AttachmentAnswer> {
    return openAttachmentInConversation(
      this.history.get(channelId) ?? [],
      name,
      attachment => this.downloadAttachment(attachment.id),
    );
  }

  // ===== GAP B BLOCK (skills on demand, 2026-08-05) — start =====
  /**
   * THE FULL WORDS OF ONE OF AN AGENT'S OWN SKILLS.
   *
   * WHY THE ENGINE AND NOT THE TOOL FILE. The skills live on the agent
   * definition the engine already holds; nothing is read off the disk and no
   * path is involved, so there is nothing here for the whole-computer grant to
   * be needed for. And the agent is looked up BY ID from the engine's own list —
   * the id the turn was opened with, never a name the model supplied.
   *
   * A MISS IS A REAL ANSWER, and it names what the agent DOES have. An agent
   * that asks for "code review" when the skill is called "Code review" must not
   * be left guessing; the alternative is a model that decides the tool is broken
   * and invents the steps, which is the failure this whole doorway exists to
   * avoid.
   */
  async openSkillForAgent(agentId: ID, name: string): Promise<Cloud9SkillAnswer> {
    const agent = this.agentById(agentId);
    const skills = agent?.skills ?? [];
    if (skills.length === 0) {
      return { found: false, why: "You have no skills at all, so there is nothing to open." };
    }
    const wanted = name.trim().toLowerCase();
    const hit = skills.find(s => s.name.trim().toLowerCase() === wanted)
      // a forgiving second pass, so a near miss is answered rather than refused
      ?? skills.find(s => s.name.trim().toLowerCase().includes(wanted))
      ?? skills.find(s => wanted.includes(s.name.trim().toLowerCase()));
    if (!hit) {
      return {
        found: false,
        why: `You have no skill called "${name}". These are the skills you have: ` +
          `${skills.map(s => s.name).join(", ")}. Ask for one of those by its exact name.`,
      };
    }
    return { found: true, name: hit.name, instructions: hit.instructions };
  }
  // ===== GAP B BLOCK — end =====

  // ===== SPENDING BLOCK (what the crew costs, 2026-08-07) — start =====

  /**
   * WHAT THE OWNER'S WHOLE CREW HAS COST THIS MONTH, AND WHAT IS WASTEFUL ABOUT
   * IT — the answer behind `check_token_use`.
   *
   * WHOSE CREW, decided here from stored state. The turn is opened with an
   * agent id; the owner is read off THAT agent; the crew is every agent with
   * the same `ownerId`. The model contributes nothing to that chain — there is
   * no argument on the tool at all — so an agent cannot reach a stranger's
   * spending however it phrases the request.
   *
   * WHAT LEAVES THIS METHOD is `renderTokenUseReport`'s words and nothing else:
   * money, sizes and settings. The run records it is built from are reduced to
   * `CountableRun` by `RunStore.countableRuns` before they get here, so there is
   * no path by which an ask, a reply, a step, a file name or an error message
   * could travel to another agent through this doorway. That reduction is the
   * boundary, and it is enforced by the type, not by remembering.
   */
  async spendingForOwnerOf(agentId: ID): Promise<Cloud9SpendingAnswer> {
    const asking = this.agentById(agentId);
    if (!asking) {
      return { found: false, why: "Cloud9 does not know which agent you are, so it " +
        "cannot look up what your owner's crew costs." };
    }
    const crew = (this.state?.agents ?? []).filter(a => a.ownerId === asking.ownerId);
    const rows = crew.map(agent => {
      const use = rollUpTokenUse({
        agentId: agent.id,
        agentName: agent.name,
        provider: agent.provider ?? "claude",
        runs: this.runs.countableRuns(agent.id, agent.provider ?? "claude"),
      });
      // THE FIGURE THE CEILING WILL REALLY BE JUDGED BY, handed in rather than
      // left to be inferred from the roll-up. `spentInMonth` also counts money
      // carried forward from runs since deleted, which the roll-up cannot see —
      // and a limit suggested below what the month has really cost would stop
      // his agent the same afternoon. See `FindWasteInput.spentThisMonthUsd`.
      return {
        use,
        findings: findWaste({
          use, agent, spentThisMonthUsd: this.runs.spentInMonth(agent.id),
        }),
      };
    })
      // AN AGENT THAT HAS NEVER TAKEN A TURN IS NOT A ROW. It has nothing to
      // say and it would push the ones that do off the bottom of the report.
      .filter(row => row.use.runs > 0);
    return { found: true, report: renderTokenUseReport(rows, "thisMonth") };
  }

  /**
   * PUT ONE NARROWING CHANGE IN FRONT OF THE OWNER — the answer behind
   * `propose_saving`.
   *
   * IT CHANGES NOTHING. Not one field of any agent is written here or anywhere
   * downstream of here. This raises the ordinary approval card, the owner
   * answers it on his own screen, and his own screen makes the change through
   * the agent editor's own `updateAgent`. That is the whole reason an agent is
   * allowed to ask about another agent at all — see `SavingChange`.
   *
   * THREE THINGS ARE CHECKED HERE, and all three again at the hub:
   *  1. the agent named is one of THIS owner's (matched by name, on the
   *     engine's own list — a name the model typed is a label, never a lookup
   *     into anything wider);
   *  2. the change is one `narrowingOnly` recognises;
   *  3. the change is not already true, because a card asking him to turn off
   *     something already off is a card that teaches him to click yes without
   *     reading.
   */
  async proposeSavingFromAgent(
    agentId: ID, channelId: ID, aboutName: string, change: unknown, because: string,
  ): Promise<Cloud9SavingAnswer> {
    const asking = this.agentById(agentId);
    if (!asking) {
      return { raised: false, why: "Cloud9 does not know which agent you are, so it " +
        "cannot put a suggestion in front of anybody." };
    }
    if (!narrowingOnly(change)) {
      return { raised: false, why: "There are exactly two changes you may offer: " +
        "\"stopUsingOwnerSetup\" or \"setMonthlyLimit\" with an amount. Nothing else " +
        "can be put on a card." };
    }
    const crew = (this.state?.agents ?? []).filter(a => a.ownerId === asking.ownerId);
    const wanted = aboutName.trim().toLowerCase();
    const about = crew.find(a => a.name.trim().toLowerCase() === wanted);
    if (!about) {
      return {
        raised: false,
        why: `Your owner has no agent called "${aboutName}". These are the agents you ` +
          `can suggest something about: ${crew.map(a => a.name).join(", ")}. Use one of ` +
          `those names exactly.`,
      };
    }
    // ALREADY TRUE IS NOT A SUGGESTION.
    if (change.what === "stopUsingOwnerSetup" && about.useOwnerSetup !== true) {
      return { raised: false, why: `${about.name} already runs in the plain setup Cloud9 ` +
        `builds — it does not load your owner's own Claude Code setup. There is nothing ` +
        `to change, so say that rather than offering it.` };
    }
    if (change.what === "setMonthlyLimit") {
      if (!providerCanBeCapped(about.provider)) {
        return { raised: false, why: `${about.name} runs on Codex, and Codex does not ` +
          `report what a turn costs — so there is no way to hold it to a spending limit. ` +
          `Say that plainly; it is a real answer.` };
      }
      const already = spendCapOf(about).perMonthUsd;
      if (typeof already === "number" && already <= change.perMonthUsd) {
        return { raised: false, why: `${about.name} already has a ${humanMoney(already)} ` +
          `limit for the month, which is tighter than the one you were going to offer. ` +
          `There is nothing to change.` };
      }
      // A CEILING THAT WOULD FIRE THIS AFTERNOON NEVER REACHES HIM.
      //
      // The card promises "this won't get in its way today". If the agent has
      // ALREADY spent more than the number on it, that promise is false, and he
      // finds out by watching his crew stop for no visible reason — which looks
      // exactly like the app breaking, and is the worst thing this feature
      // could do to him.
      //
      // Checked against `spentInMonth`, which is the SAME figure `decideSpend`
      // will judge the ceiling by — and which includes money carried forward
      // from runs since deleted. An agent proposing from the roll-up alone
      // cannot see that carried money, so this is the one place the two can be
      // reconciled, and it is the last gate before a card exists at all.
      const spent = this.runs.spentInMonth(about.id);
      if (change.perMonthUsd <= spent) {
        return { raised: false, why: `${about.name} has already spent `
          + `${humanMoney(spent)} this month, so a ${humanMoney(change.perMonthUsd)} `
          + `ceiling would stop it immediately rather than protect it. Offer a limit with `
          + `real room above what it has actually spent — about twice it — or say plainly `
          + `that it is already spending more than a sensible ceiling would allow.` };
      }
    }
    const outcome = await this.approvals.askSaving({
      agent: asking,
      channelId,
      ...(this.currentTurnToken(asking.id) ? { turnToken: this.currentTurnToken(asking.id) } : {}),
      proposal: {
        about: about.id, aboutName: about.name, change, because: tidySaving(because),
      },
    });
    if (!outcome.approved) {
      return {
        raised: false,
        why: `Your suggestion was put in front of your owner and ${outcome.reason}. ` +
          `Nothing has been changed. Say that plainly.`,
      };
    }
    // HE SAID YES — AND HIS DECISION IS WHAT CHANGED IT, not this engine and not
    // the agent. The change is made where the decision is recorded, in one step,
    // so a card that says "approved" and a setting that did not move cannot
    // exist. The wording matters: an agent that reports "I turned it off" is
    // claiming a power it does not have and never had.
    return {
      raised: true,
      what: `Your owner accepted your suggestion for ${about.name}, so the change is now ` +
        `in place. HE made it by saying yes — you did not change anything and you cannot. ` +
        `Say that he accepted it, not that you did it.`,
    };
  }

  // ===== SPENDING BLOCK — end =====

  /** One `attachmentTicket` frame out, one ticket back, one HTTP read. */
  private async downloadAttachment(attachmentId: ID): Promise<Buffer | undefined> {
    const granted = await new Promise<
      Extract<ServerFrame, { type: "attachmentTicket" }> | undefined
    >(resolve => {
      const timer = setTimeout(() => {
        this.attachmentWaiters.delete(waiter);
        resolve(undefined);
      }, SEARCH_WAIT_MS);
      const waiter = (frame: Extract<ServerFrame, { type: "attachmentTicket" }>): boolean => {
        if (frame.attachmentId !== attachmentId) return false;
        clearTimeout(timer);
        resolve(frame);
        return true;
      };
      this.attachmentWaiters.add(waiter);
      this.sendFrame({ type: "attachmentTicket", attachmentId });
    });
    if (!granted) return undefined;
    const res = await fetch(new URL(granted.url, httpBaseOf(this.opts.relayUrl)));
    if (!res.ok) return undefined;
    const bytes = Buffer.from(await res.arrayBuffer());
    // The hub will not serve more than `ATTACHMENT_LIMITS.bytes`; this is the
    // same ceiling asked again on this side, because a reader that trusts the
    // sender's length is a reader with no ceiling at all.
    if (bytes.length > ATTACHMENT_LIMITS.bytes) return undefined;
    return bytes;
  }

  /** Start listening for tool calls. Until this runs there is simply no doorway. */
  async startTools(): Promise<void> {
    try { await this.tools.start(); }
    catch (err) { console.error("[engine] could not open the tool doorway:", err); }
  }

  /**
   * Tell the relay (and through it, this owner's other clients) what the local
   * harnesses look like. Status only — no credential material (decision 5/6).
   */
  reportHarness(state: HarnessState, looked = true): void {
    // HIS ITEM 2, AND THIS IS THE ENGINE'S HALF OF THE BUG.
    //
    // The hub works out presence from what this engine tells it about the two
    // apps (`agentPresence` in shared: not installed → offline, not signed in →
    // offline, ABSENT → "it hasn't said"). Detection starts by publishing a
    // PLACEHOLDER — both apps `installed: false`, detail "not checked yet" —
    // because the local settings card needs its spinner. Forwarding that
    // placeholder tells the hub "neither app is on this computer" as though it
    // were a finding, and every agent goes grey on a machine where both apps
    // are signed in. It also never corrects itself if detection then hangs.
    //
    // So: we report what we HAVE ESTABLISHED, never what we have assumed.
    // Absent is a state the hub already understands and says out loud; a false
    // "not installed" is one it can only repeat.
    if (!looked) return;
    // demo mode travels WITH the status every client already listens to, so the
    // screen can say "these answers are made up" without anyone having to
    // remember to ask a second question
    // …and so does whether this engine is CHECKING what its agents say against
    // what they did. Same reason, and it is the more important of the two to be
    // able to see: the check is silent when everything matches, so without this
    // there is no difference on screen between "checked, all true" and "nothing
    // is checking". Read live rather than remembered at startup, because
    // `verifyClaims` is a field a host can turn on after the engine exists.
    this.sendFrame({
      type: "harnessState",
      state: { ...state, demo: this.demoMode, verifyClaims: this.verifyClaims },
    });
  }

  /**
   * THE THING THAT WAS MISSING. A `GitHubClient` for one agent, wired to ask
   * HIM at the moment of the push rather than refusing because nobody was set
   * up to be asked.
   *
   * `github.ts` is closed by default and stays closed by default — this does
   * not open it, it supplies the one approver that can answer. Everything on
   * the `REMOTE_ACTIONS` table still goes through the gate, the sentence he
   * reads is still written by the hub from facts, and a refusal is still an
   * error the agent has to report rather than a silent no-op.
   *
   * `lastRefusal` is how the caller turns "it did not happen" into a true
   * sentence in the conversation: the outcome carries the plain-words reason
   * (he said no / nobody answered / the hub went away) and it would otherwise
   * be lost inside the boolean the gate wants.
   */
  githubFor(
    agent: AgentDef,
    where: { channelId: ID; taskId?: ID },
    extra: Omit<GitHubOptions, "approve"> = {},
  ): { client: GitHubClient; lastRefusal: () => string | undefined } {
    let refusal: string | undefined;
    const client = new GitHubClient({
      ...extra,
      approve: async (_action, _detail, facts): Promise<boolean> => {
        const outcome: ApprovalOutcome = await this.approvals.ask({
          agent, channelId: where.channelId,
          ...(where.taskId ? { taskId: where.taskId } : {}),
          ...(this.currentTurnToken(agent.id) ? { turnToken: this.currentTurnToken(agent.id) } : {}),
          facts,
        });
        refusal = outcome.approved ? undefined : outcome.reason;
        return outcome.approved;
      },
    });
    return { client, lastRefusal: () => refusal };
  }

  /**
   * ONE AGENT, WORKING IN THE CODE, ABLE TO ASK FOR ITS WORK TO BE PUBLISHED.
   *
   * This is the caller `githubFor` never had. `repowork.ts` owns the order of
   * events and the four laws; this method owns the wiring — which worktree
   * root, which provider, which conversation the card belongs to — and turns
   * the result into the one sentence the room reads.
   *
   * The worktree root is the AGENT'S OWN data folder, so two agents working the
   * same repository at the same time cannot be handed the same folder, and git
   * itself refuses a second checkout of one branch.
   *
   * It never throws. A repository turn that falls over says so in the room.
   */
  async workInRepository(agent: AgentDef, input: {
    channelId: ID; ask: string; triggerAuthor: string; taskId?: ID; repoDir?: string;
    /** the thread this piece of work was asked for in, if it was asked for in one */
    replyTo?: ID;
  }): Promise<RepoTurnResult | undefined> {
    const inThread = input.replyTo ? { replyTo: input.replyTo } : {};
    /* WHERE THE CODE IS — asked of the one function that answers it, per
       CONVERSATION, so two projects on one computer are two folders. An
       explicit `input.repoDir` (tests, a caller that already knows) still wins;
       everything else goes through `repoDirFor`. */
    let repoDir = input.repoDir;
    if (!repoDir) {
      const found = this.repoDirFor(input.channelId);
      if ("problem" in found) {
        this.agentSend(agent.id, input.channelId, found.problem, inThread);
        return undefined;
      }
      repoDir = found.dir;
    }
    this.setStatus(agent.id, "working");
    try {
      const result = await repoTurn({
        agent, repoDir, channelId: input.channelId, ask: input.ask,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      }, {
        git: new GitWorkspace({ root: this.agentDataDir(agent.id) }),
        respond: ({ workdir, briefing }) => this.respondAs(agent, {
          context: this.renderContext(input.channelId, agent, input.replyTo),
          trigger: `${input.ask}${briefing}`,
          triggerAuthor: input.triggerAuthor,
          kind: input.taskId ? "task" : "chat",
          channelId: input.channelId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
          ...inThread,
          workdir,
        }),
        github: () => this.githubFor(agent, {
          channelId: input.channelId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
        }, this.opts.github ?? {}),
      });
      // what it wrote, then what really happened to it. The second half is
      // never the agent's account of itself — it is built from git's.
      const said = result.reply ? `${result.reply}\n\n` : "";
      // work in the code is the long-running kind: the account of it goes where
      // it was asked for, and the room gets the one short line
      this.reportFinished(agent.id, input.channelId, input.replyTo,
        `${said}${describeRepoTurn(result)}`, roomLineForThreadJob(input.ask), false);
      return result;
    } catch (err) {
      this.agentSend(agent.id, input.channelId,
        saidWhenTurnEnded(err, `${agent.name} could not work in the repository`), inThread);
      return undefined;
    } finally {
      this.setStatus(agent.id, "idle");
    }
  }

  /**
   * Ask GitHub what is open in one repository, and tell the hub.
   *
   * THE ANSWER ALWAYS GOES BACK. A look that failed reports `problem` and no
   * items, so the screen can print why instead of showing an empty list that
   * reads like "no open work" — and so the hub can stop saying "looking". A
   * silent failure here is the one outcome that would leave a button spinning
   * for ever, so there is no path out of this method that sends nothing.
   *
   * `readOnlyGitHub` has NO approver, deliberately: `github.ts` refuses every
   * gated method without one, so this client physically cannot push, open a
   * pull request or create anything. The only thing it can do is read.
   */
  async lookAtProject(projectId: ID, repo: string): Promise<void> {
    try {
      const { items, ...rest } = await this.readOnlyGitHub().lookAtRepository(repo);
      this.sendFrame({
        type: "projectSynced", projectId,
        ...rest,
        // the id the HUB gave us, put on every row. The hub stamps its own
        // verified id over the top regardless — this is the shape, not a claim.
        ...(items ? { items: items.map(i => ({ ...i, projectId })) } : {}),
      });
    } catch (err) {
      console.error(`[engine] could not look at ${repo}:`, err);
      this.sendFrame({
        type: "projectSynced", projectId,
        problem: "Cloud9 could not ask GitHub about this repository. Try again in a moment.",
      });
    }
  }

  /**
   * Ask GitHub which repositories this computer's sign-in can see, and tell the
   * hub. THE ANSWER ALWAYS GOES BACK, exactly like a look: a failure reports
   * `problem` and NO list, so the picker prints why instead of an empty list
   * that reads "you have no repositories".
   */
  async listRepositories(): Promise<void> {
    try {
      const found = await this.readOnlyGitHub().listRepositories();
      this.sendFrame({ type: "repositoriesFound", ...found });
    } catch (err) {
      console.error("[engine] could not list repositories:", err);
      this.sendFrame({
        type: "repositoriesFound",
        problem: "Cloud9 could not ask GitHub for your repositories. Try again in a moment.",
      });
    }
  }

  /* ------------------------------------------------------------------
     WHERE THIS PROJECT'S CODE LIVES ON THIS COMPUTER — the ONE owner.
     ------------------------------------------------------------------ */

  /**
   * The folder an agent should work in for one conversation, or the plain-words
   * reason there isn't one.
   *
   * ONE FUNCTION, ASKED BY EVERYTHING that needs a repository directory —
   * `workInRepository` (`!code`) and `workGitHubWriteInRoom` (`!issue`,
   * `!comment`, `!review`). Before this closed (approval-handoff.md §8) each of
   * them read `EngineOptions.repoDir`, a single folder chosen once at launch by
   * whoever started the engine, and NOTHING on screen could set it — so an
   * owner with two projects had one folder for both, or none at all.
   *
   * The order, and why:
   *  1. A PROJECT LINKED TO THIS CONVERSATION that has a folder. The owner said
   *     this, from the screen, for this project. It beats everything.
   *  2. `EngineOptions.repoDir` — the launch-time fallback, kept deliberately so
   *     nothing that worked yesterday stops working today.
   *  3. Nothing. The existing sentence, unchanged.
   *
   * A FOLDER THAT IS GONE IS NOT SILENTLY SKIPPED. If the owner linked a folder
   * and it is no longer on this computer, that is said out loud — falling
   * through to the launch-time folder would quietly work in the WRONG
   * repository, which is worse than not working at all.
   */
  repoDirFor(channelId?: ID): { dir: string } | { problem: string } {
    const linked = channelId
      ? [...this.projects.values()].find(p => p.channelId === channelId && p.localPath)
      : undefined;
    if (linked?.localPath) {
      if (!isFolderOnDisk(linked.localPath)) {
        return {
          problem: `The folder Cloud9 has for ${linked.name} (${linked.localPath}) is not on this ` +
            "computer any more, so there is nothing to work in. Open Projects and choose the folder " +
            "again — I have not touched any other folder.",
        };
      }
      return { dir: linked.localPath };
    }
    const launch = this.opts.repoDir;
    if (launch) {
      if (!isFolderOnDisk(launch)) {
        return {
          problem: "The folder this copy of Cloud9 was started with is not on this computer any " +
            "more, so there is nothing to work in. Open Projects and choose the folder for this project.",
        };
      }
      return { dir: launch };
    }
    // ABSENT MEANS ABSENT. Nobody has told this computer where the code is, and
    // a folder we invented would be the worst possible guess.
    return {
      problem: "Nobody has told Cloud9 where this project's code lives on this computer yet, " +
        "so I have no repository to work in. Open Projects, pick this repository and choose the " +
        "folder its code is in — then I can work on my own branch and ask before anything goes to GitHub.",
    };
  }

  /** A GitHub client that can only READ — no approver, so every gate refuses. */
  private readOnlyGitHub(): GitHubClient {
    return new GitHubClient(this.opts.github ?? {});
  }

  /**
   * Read a room command into a structured GitHub write, or nothing.
   *
   * The `repo` is filled in later, by ASKING gh what this checkout is called —
   * never from anything typed here. A number that is not a number, or a review
   * with no reviewers, is simply not a command, so it falls through to an
   * ordinary turn rather than becoming a card nobody can act on.
   */
  parseGitHubWriteCommand(text: string): GitHubWriteRequestWithoutRepo | undefined {
    const t = text.trim();
    const issue = /^!issue\s+(.+)$/is.exec(t);
    if (issue) {
      const title = issue[1].trim();
      return title ? { kind: "openIssue", title } : undefined;
    }
    const comment = /^!comment\s+(\d+)\s+([\s\S]+)$/i.exec(t);
    if (comment) {
      const number = Number(comment[1]);
      const body = comment[2].trim();
      return Number.isSafeInteger(number) && number > 0 && body
        ? { kind: "comment", target: "pullRequest", number, body } : undefined;
    }
    const review = /^!review\s+(\d+)\s+(.+)$/i.exec(t);
    if (review) {
      const pullRequest = Number(review[1]);
      const reviewers = review[2].trim().split(/\s+/).map(s => s.replace(/^@/, "")).filter(Boolean);
      return Number.isSafeInteger(pullRequest) && pullRequest > 0 && reviewers.length
        ? { kind: "requestReview", pullRequest, reviewers } : undefined;
    }
    return undefined;
  }

  /**
   * PERFORM A GITHUB WRITE ASKED FOR IN A ROOM — through the SAME approval desk
   * the push uses. It reads the repository name first (a read, no approval),
   * then hands the counted facts to the desk; only a yes builds and runs the
   * `gh` command. A no, or a stop, runs nothing and says which.
   */
  async workGitHubWriteInRoom(
    agent: AgentDef, channelId: ID, partial: GitHubWriteRequestWithoutRepo, replyTo?: ID,
  ): Promise<void> {
    // asked in a thread → every one of the four answers below lands in it
    const inThread = replyTo ? { replyTo } : {};
    // the SAME question, asked of the same function — a second answer here is
    // how `!code` and `!issue` would end up working in different folders
    const found = this.repoDirFor(channelId);
    if ("problem" in found) {
      this.agentSend(agent.id, channelId, found.problem, inThread);
      return;
    }
    const repoDir = found.dir;
    this.setStatus(agent.id, "working");
    try {
      // WHAT IS THIS REPOSITORY CALLED — a read, so no card. A repository gh
      // cannot name is reported honestly rather than guessed at.
      const repo = await this.readOnlyGitHub().repoName({ path: repoDir } as Worktree);
      if (!repo) {
        this.agentSend(agent.id, channelId,
          "I could not work out which GitHub repository this folder belongs to, so I have " +
          "not asked to do anything. Check that this project is a GitHub checkout signed in with gh.",
          inThread);
        return;
      }
      const request = { ...partial, repo } as GitHubWriteRequest;
      const outcome = await runGitHubWrite({
        request,
        ask: async facts => {
          const o: ApprovalOutcome = await this.approvals.ask({ agent, channelId,
            ...(this.currentTurnToken(agent.id) ? { turnToken: this.currentTurnToken(agent.id) } : {}), facts });
          return { approved: o.approved, reason: o.reason };
        },
        ...(this.opts.github?.runner ? { run: this.opts.github.runner } : {}),
      });
      if (!outcome.ran) {
        this.agentSend(agent.id, channelId,
          `I asked to ${outcome.description}, and ${outcome.reason}. Nothing left this computer.`,
          inThread);
        return;
      }
      if (outcome.problem) {
        this.agentSend(agent.id, channelId,
          `You approved it, but GitHub would not take it: ${outcome.problem}`, inThread);
        return;
      }
      this.agentSend(agent.id, channelId,
        `Approved — done. I went ahead to ${outcome.description}.`, inThread);
    } catch (err) {
      this.agentSend(agent.id, channelId,
        sanitizeForChat(err, `${agent.name} could not do that on GitHub`), inThread);
    } finally {
      this.setStatus(agent.id, "idle");
    }
  }

  // ---- agent memory (docs/plans/agent-memory-handoff.md §9.1) ----

  /**
   * What this agent remembers, budgeted for one turn. Reading its own store
   * must never be the reason a turn fails, so it is wrapped: a store that
   * cannot be read seeds nothing rather than throwing.
   */
  private rememberedFor(agentId: ID, channelId?: ID): string {
    try {
      const notes = this.memory.list(agentId);
      if (!channelId) return retrieveMemory(notes);
      const policy = this.channelMemoryPolicy(channelId, agentId);
      // A turn with no live channel/agent membership has no authorized
      // channel-scoped memory context. Do not seed notes from an invented
      // fallback room.
      if (!policy) return "";
      const mode = policy.mode;
      return retrieveMemory(notes.filter(note =>
        (note.channelId === undefined || note.channelId === channelId)
        && channelMemoryMayUse(mode, note)));
    } catch (err) {
      console.error(`[engine] could not seed memory for agent ${agentId}:`, err);
      return "";
    }
  }

  /**
   * Save something an agent should remember, asked for in the room with
   * "@Agent !remember <text>". The worth-remembering RULE decides whether it
   * lands, and a refusal is said out loud in the agent's own voice — a refusal
   * nobody heard is how an agent ends up remembering nothing and nobody knows
   * why. Public so tests can drive it. Never throws.
   */
  async rememberFromRoom(
    agent: AgentDef, channelId: ID, text: string, replyTo?: ID,
  ): Promise<void> {
    const inThread = replyTo ? { replyTo } : {}; // asked in a thread, answered in it
    const policy = this.channelMemoryPolicy(channelId, agent.id);
    if (!policy) return;
    if (!channelMemoryMaySave(policy.mode, "owner", "fact")) {
      this.agentSend(agent.id, channelId,
        `I didn't save that to memory — this channel is set to ${policy.mode === "none" ? "No retention" : "Decision summaries"}. ` +
        `Cloud9 refused the note at its storage boundary; this does not claim the model forgot it.`, inThread);
      return;
    }
    const verdict = worthRemembering(text);
    if (!verdict.keep) {
      this.agentSend(agent.id, channelId,
        `I didn't save that to memory — ${verdict.reason}. Give me a short fact worth ` +
        `keeping, like "my owner ships on Fridays".`, inThread);
      return;
    }
    const note: MemoryNote = {
      id: newMemoryId(), agentId: agent.id, kind: "fact",
      text: text.trim(), createdAt: Date.now(), source: "owner", channelId,
    };
    const saved = this.memory.save(note);
    if (!saved) {
      this.agentSend(agent.id, channelId,
        "I couldn't save that to memory on this computer — check there is room on the " +
        "disk and try again.", inThread);
      return;
    }
    this.agentSend(agent.id, channelId,
      `📝 Saved to memory — I'll remember: "${note.text}"`, inThread);
    // push the fresh list to any screen that has this agent's file open
    this.reportMemory(agent.id);
  }

  // ===== GAP A BLOCK (agent-written memory, 2026-08-05) — start =====
  /**
   * AN AGENT REMEMBERS SOMETHING BY ITSELF — the engine half of the
   * `remember_this` tool. Public so tests can drive it. Never throws.
   *
   * WHOSE MEMORY: only this engine's own agents, checked here against
   * `myAgents` and not merely trusted from the caller. The tool has no argument
   * that names an agent, and this is the second gate behind that — the same
   * two-gates-that-do-not-trust-each-other shape search and attachments use.
   *
   * WHY IT IS NOT AN APPROVAL. The owner is not asked before a note lands, and
   * that is a decision, not an oversight. A confirmation card per note would be
   * approved unread within a day — the appearance of control with none of it.
   * What he gets instead is stronger and cheaper to use: every note the agent
   * wrote is stamped `source: "agent"`, the memory panel says "it chose to
   * remember this" beside it, the panel is pushed the new list the moment it
   * lands, and one click clears it for good. Nothing an agent writes can reach
   * anybody else, cost anything, or change this computer.
   *
   * THE SAME RULE AS THE OWNER'S OWN NOTES: `worthRemembering` decides, the
   * 500-character ceiling refuses rather than truncates, and the store prunes at
   * its own cap. A refusal comes back in words the agent can read out.
   */
  async rememberFromAgent(
    agentId: ID, text: string, kind: string, channelId?: ID,
  ): Promise<Cloud9RememberAnswer> {
    if (!this.myAgents.some(a => a.id === agentId)) {
      return { saved: false, why: "That memory does not belong to you, so nothing was saved." };
    }
    const verdict = worthRemembering(text);
    if (!verdict.keep) {
      return {
        saved: false,
        why: `That was not saved to your memory — ${verdict.reason}. Keep a note to one ` +
          `short sentence that will still be true in a month.`,
      };
    }
    // AN UNKNOWN KIND IS A FACT, not a refusal: the tool's own schema already
    // lists the five, and a model that invents a sixth has still learned
    // something real. The stored kind is only ever one of the five, so nothing
    // a model types can reach `validateNote` as a surprise.
    const known: MemoryKind[] = ["fact", "preference", "decision", "outcome", "correction"];
    const resolvedKind = known.includes(kind as MemoryKind) ? kind as MemoryKind : "fact";
    const policy = channelId ? this.channelMemoryPolicy(channelId, agentId) : undefined;
    if (channelId && !policy) {
      return {
        saved: false,
        why: "That memory was not saved because this agent is not a member of that conversation.",
      };
    }
    if (policy && !channelMemoryMaySave(policy.mode, "agent", resolvedKind)) {
      return {
        saved: false,
        why: `That was not saved — this channel's memory policy is ${policy.mode === "none" ? "No retention" : policy.mode === "summary" ? "Decision summaries" : "Explicit only"}. ` +
          "Cloud9 refused it at its storage boundary; it cannot claim the model forgot the text.",
      };
    }
    const note: MemoryNote = {
      id: newMemoryId(), agentId, kind: resolvedKind,
      text: text.trim(), createdAt: Date.now(),
      // WHO WROTE IT, honestly. This is the whole of the owner's visibility: the
      // panel reads this field to say "it chose to remember this".
      source: "agent", ...(channelId ? { channelId } : {}),
    };
    let saved: string | undefined;
    try {
      saved = this.memory.save(note);
    } catch (err) {
      console.error(`[engine] could not save a memory for agent ${agentId}:`, err);
    }
    if (!saved) {
      return {
        saved: false,
        why: "Cloud9 could not save that to your memory on this computer. Carry on " +
          "without it rather than acting as though you will remember it.",
      };
    }
    // The panel finds out the moment it lands — visibility is the whole design,
    // so it must not wait for the owner to reopen the screen.
    this.reportMemory(agentId);
    return { saved: true, text: note.text };
  }

  /** Hook-owned notes use the same channel policy gate as a human request. */
  saveOwnerMemoryNote(agentId: ID, channelId: ID | undefined, text: string): boolean {
    const policy = channelId ? this.channelMemoryPolicy(channelId, agentId) : undefined;
    if (channelId && !policy) return false;
    if (policy && !channelMemoryMaySave(policy.mode, "owner", "fact")) return false;
    const verdict = worthRemembering(text);
    if (!verdict.keep) return false;
    const note: MemoryNote = {
      id: newMemoryId(), agentId, kind: "fact", text: text.trim(),
      createdAt: Date.now(), source: "owner", ...(channelId ? { channelId } : {}),
    };
    return Boolean(this.memory.save(note));
  }
  // ===== GAP A BLOCK — end =====

  /**
   * Tell the owner's screens what an agent has saved, off THIS computer's own
   * store — the one durable copy. Only ever for the engine's own agents; the
   * hub has already checked ownership, and this checks again. Never throws.
   */
  reportMemory(agentId: ID): void {
    try {
      if (!this.myAgents.some(a => a.id === agentId)) return;
      const notes = this.memory.list(agentId).filter(note => {
        if (!note.channelId) return true; // existing global agent memory UI stays distinct
        const channel = this.channel(note.channelId);
        if (!channel || !channel.memberIds.includes(agentId)) return false;
        const policy = this.channelMemoryPolicy(note.channelId, agentId);
        return Boolean(policy && channelMemoryMayUse(policy.mode, note));
      });
      this.sendFrame({ type: "memoryChanged", agentId, notes });
    } catch (err) {
      console.error(`[engine] could not report memory for agent ${agentId}:`, err);
    }
  }

  /** Forget one saved note, then report what is left. Public so tests can drive it. */
  forgetMemoryNote(agentId: ID, noteId: ID): void {
    if (!this.myAgents.some(a => a.id === agentId)) return;
    this.memory.forgetNote(agentId, noteId);
    this.reportMemory(agentId);
  }

  // ---- agent-to-agent handoff (docs/plans/agent-memory-handoff.md §9.2) ----

  /**
   * One agent hands a piece of work to another, asked for in the room with
   * "@From !handoff @To <task>". The handoff is BUILT here (which validates it)
   * and only then announced — so the "passed to" line on screen never describes
   * a handoff that did not check out. Delivery goes through the hub, which
   * validates again and routes it to the receiver's own engine. Public for
   * tests. Never throws.
   */
  async handOffInRoom(
    agent: AgentDef, channelId: ID, targetName: string, task: string, _triggerAuthor: string,
    replyTo?: ID,
  ): Promise<void> {
    const inThread = replyTo ? { replyTo } : {}; // the pass-over is said where it was asked
    const wanted = targetName.replace(/^@/, "").toLowerCase();
    const target = this.state?.agents.find(a => a.name.toLowerCase() === wanted);
    if (!target) {
      this.agentSend(agent.id, channelId,
        `I couldn't find an agent called @${targetName.replace(/^@/, "")} to hand this to.`,
        inThread);
      return;
    }
    let handoff: AgentHandoff;
    try {
      handoff = buildHandoff({
        fromAgentId: agent.id, toAgentId: target.id, task,
        contextPointer: { kind: "channel", ref: channelId },
      });
    } catch (err) {
      const detail = err instanceof HandoffError ? err.detail : "the handoff wasn't valid";
      this.agentSend(agent.id, channelId, `I couldn't hand that off — ${detail}.`, inThread);
      return;
    }
    // THE LINE ON SCREEN, in plain words, from a real handoff and in the
    // sender's own voice. The receiver's turn arrives separately, when the hub
    // delivers the handoff to its engine.
    this.agentSend(agent.id, channelId, `🤝 Passed to @${target.name} — ${handoff.task}`, inThread);
    this.sendFrame({ type: "sendHandoff", handoff });
  }

  /**
   * A peer handed one of this engine's agents a piece of work. Turn it into a
   * turn for the receiving agent — seeded with the task and pointed at the
   * context the handoff named. The receiving turn is seeded from the receiver's
   * OWN memory too (every turn is), so a handoff arrives on top of what the
   * receiver already remembers. Public for tests. Never throws at its caller.
   */
  async receiveHandoff(handoff: AgentHandoff): Promise<void> {
    const target = this.myAgents.find(a => a.id === handoff.toAgentId);
    if (!target) return; // not one of this engine's agents to run
    if (target.lifecycle === "paused" || target.lifecycle === "disabled") return; // FR-AG-007
    // Today's room handoffs always point at the conversation they happened in,
    // which is also where the receiver speaks. A pointer with no channel is not
    // one this path can answer in a room, so it is left alone rather than guessed.
    //
    // AND IT IS A ROOM ANSWER, not a thread one: a handoff carries a channel
    // pointer and nothing finer, so the receiving engine has no thread to speak
    // into. Guessing one would put the answer under a message this agent never
    // saw. Widening `contextPointer` to name a thread is the follow-up.
    const channelId = handoff.contextPointer.kind === "channel"
      ? handoff.contextPointer.ref : undefined;
    if (!channelId) return;
    const fromName = this.state?.agents.find(a => a.id === handoff.fromAgentId)?.name
      ?? handoff.fromAgentId;
    await this.enqueueAgentTurn(target.id, async () => {
      this.setStatus(target.id, "working");
      try {
        const text = await this.respondAs(target, {
        // no thread: a handoff carries a channel pointer and nothing finer, as
        // the note above says, so there is no side conversation to serve first.
          context: this.renderContext(channelId, target),
          trigger: handoffTrigger(handoff, fromName),
          triggerAuthor: fromName,
          kind: "chat",
          channelId,
          requesterKind: "agent",
        });
        this.agentSend(target.id, channelId, text);
      } catch (err) {
        this.agentSend(target.id, channelId,
          saidWhenTurnEnded(err, `${target.name} could not pick up a handoff`));
      } finally {
        this.setStatus(target.id, "idle");
      }
    });
  }

  /**
   * The ONE place this engine says something in a room.
   *
   * `replyTo` is the thread it belongs in — see `threads.ts` for the rule and
   * why the hub, not this file, owns the one-level part of it. Absent means the
   * main room, which is right for everything nobody asked for inside a thread:
   * proactive lines, presence notes, a schedule firing, and anything the engine
   * says about itself rather than in answer to a message. Those paths pass no
   * `replyTo` on purpose — that is the one comment, not thirty.
   */
  agentSend(
    agentId: ID, channelId: ID, text: string,
    opts: { proactive?: boolean; replyTo?: ID; responseTriggerMessageId?: ID } = {},
  ): void {
    this.sendFrame({
      type: "agentSend", agentId, channelId, text, proactive: opts.proactive ?? false,
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(opts.responseTriggerMessageId ? { responseTriggerMessageId: opts.responseTriggerMessageId } : {}),
    });
  }

  /**
   * ASK THE HUB TO START A JOB FOR AN AGENT — the one door a hook goes through
   * when it wants work started (`hooks.ts`, the `job` action).
   *
   * IT IS NOT A SHORTCUT PAST THE GATE. The `needsApproval` flag is decided by
   * the SAME two functions a person's `!task` goes through — `approvalsFor`
   * (the owner's own background-work setting) and `needsApprovalToRun` (the
   * abilities that always ask). A hook that starts a job for an agent the owner
   * wanted to be asked about produces a card, exactly as he asked; it does not
   * produce a running job with nobody told.
   */
  requestJob(
    agent: AgentDef, channelId: ID, title: string, requesterId?: ID,
    opts: { causedByHook?: boolean } = {},
  ): void {
    const mustAsk = approvalsFor(agent).background || needsApprovalToRun(agent);
    this.sendFrame({
      type: "createTask", agentId: agent.id, channelId,
      title: title.slice(0, 200),
      ...(requesterId ? { requesterId } : {}),
      ...(opts.causedByHook ? { causedByHook: true } : {}),
      ...(mustAsk ? { needsApproval: true, action: `Start a job: ${title.slice(0, 150)}` } : {}),
    });
  }

  /**
   * A LONG JOB HAS FINISHED — say it where it was asked, and keep the room
   * informed.
   *
   * Started inside a thread: the detail goes in the thread and the room gets
   * ONE short line (the recorded decision — `docs/plans/feature-gap.md:300`).
   * Started in the room: nothing changes at all, because the detail is already
   * in the room and a second line would just be noise.
   */
  private reportFinished(
    agentId: ID, channelId: ID, thread: ID | undefined,
    detail: string, roomLine: string, proactive = true, responseTriggerMessageId?: ID,
  ): void {
    this.agentSend(agentId, channelId, detail,
      {
        proactive, ...(thread ? { replyTo: thread } : {}),
        ...(responseTriggerMessageId ? { responseTriggerMessageId } : {}),
      });
    if (thread) this.agentSend(agentId, channelId, roomLine, {
      proactive, ...(responseTriggerMessageId ? { responseTriggerMessageId } : {}),
    });
  }

  private setStatus(agentId: ID, status: "idle" | "working" | "braked"): void {
    this.sendFrame({ type: "agentStatus", agentId, status });
  }

  private sendFrame(frame: ClientFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  /**
   * returns true when the message was a schedule command (handled, no LLM turn)
   *
   * Every answer here is an answer to a message somebody typed, so it goes where
   * they typed it — including inside a thread. The schedule itself firing later
   * is a different thing and stays in the room (see `fireSchedule`).
   */
  handleScheduleCommand(
    agent: AgentDef, channelId: ID, text: string, requesterId?: ID, replyTo?: ID,
  ): boolean {
    const inThread = replyTo ? { replyTo } : {};
    const t = text.trim();
    const create = /^!schedule\s+(daily \d{1,2}:\d{2}|every \d+m)\s*:?\s+(.+)$/i.exec(t);
    // same one owner. A schedule for an agent that can run programs is a
    // standing order to change the machine while nobody is looking, so it is
    // asked about whatever the schedules flag says.
    if (create && (approvalsFor(agent).schedules || needsApprovalToRun(agent))) {
      this.sendFrame({
        type: "createTask", agentId: agent.id, channelId,
        title: `!schedule ${create[1].toLowerCase()}: ${create[2]}`,
        requesterId,
        needsApproval: true, action: `Create schedule (${create[1]}): ${create[2]}`,
      });
      this.agentSend(agent.id, channelId, `Schedule request sent for approval. 🔒`, inThread);
      return true;
    }
    if (create) {
      const s: AgentSchedule = {
        id: `s_${Date.now().toString(36)}`, agentId: agent.id, channelId,
        when: create[1].toLowerCase(), prompt: create[2], enabled: true,
      };
      // NOTHING SAYS "SAVED" UNLESS IT IS SAVED. This said "⏰ Scheduled!" come
      // what may: the write failed, one line went to a console nobody reads,
      // the schedule ran until the app closed and was then gone without a word.
      // A failure he can see is better than one he cannot.
      if (!this.saveSchedule(s)) {
        this.agentSend(agent.id, channelId, SCHEDULE_NOT_SAVED, inThread);
        return true;
      }
      this.agentSend(agent.id, channelId,
        `⏰ Scheduled! I'll do this ${s.when}: "${s.prompt}" (id ${s.id} — "@${agent.name} !unschedule ${s.id}" to cancel)`,
        inThread);
      return true;
    }
    if (/^!schedules$/i.test(t)) {
      const mine = this.schedules.filter(s => s.agentId === agent.id);
      this.agentSend(agent.id, channelId, mine.length
        ? `My schedules:\n${mine.map(s => `• ${s.id}: ${s.when} — ${s.prompt}`).join("\n")}`
        : "I have no schedules yet. Try: `!schedule daily 06:30 post a morning check-in`",
        inThread);
      return true;
    }
    const remove = /^!unschedule\s+(\S+)$/i.exec(t);
    if (remove) {
      const existed = this.schedules.some(s => s.id === remove[1] && s.agentId === agent.id);
      if (!existed) {
        this.agentSend(agent.id, channelId, `I don't have a schedule ${remove[1]}.`, inThread);
        return true;
      }
      // same rule the other way round: a cancellation that did not reach the
      // disk comes BACK at the next restart, so it is not called "cancelled"
      this.agentSend(agent.id, channelId, this.deleteSchedule(remove[1])
        ? `Cancelled ${remove[1]} ✅`
        : `⚠️ I could NOT cancel ${remove[1]} — the change could not be saved on this computer, ` +
          `so it is still set. Check there is room on the disk and try again.`,
        inThread);
      return true;
    }
    if (/^!schedule\b/i.test(t)) {
      this.agentSend(agent.id, channelId,
        'Schedule format: `!schedule daily HH:MM <what to do>` or `!schedule every Nm <what to do>`',
        inThread);
      return true;
    }
    return false;
  }

  // ---- schedules persistence (JSON file in dataDir) ----
  //
  // SAME CLASS AS THE RUN RECORDS, AND WORSE. This one file holds EVERY
  // schedule for every agent, and it was rewritten whole with a plain
  // `writeFileSync`. Interrupt that — the app closing, the machine sleeping, a
  // full disk — and the file is half JSON, `loadSchedules` cannot parse it,
  // and every schedule he ever set is silently gone: the app starts with an
  // empty list and the very next save writes that empty list back over the
  // wreckage. It goes through the one owner of whole writes now.
  private schedulesPath(): string {
    return path.join(this.dataDir, "schedules.json");
  }
  /**
   * The saved schedules — or nothing, said out loud, if the file cannot be
   * believed. A file that parses but is not a LIST used to be handed straight
   * back, and the first `.filter` on it crashed the engine at startup.
   */
  private loadSchedules(): AgentSchedule[] {
    let text: string;
    try { text = fs.readFileSync(this.schedulesPath(), "utf8"); }
    catch { return []; } // no file yet, or we cannot read it — both mean "none"
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch {
      console.error("[engine] the schedules file is damaged (the text stops part-way " +
        "through) — starting with no schedules rather than half of them");
      return [];
    }
    if (!Array.isArray(parsed)) {
      console.error("[engine] the schedules file does not hold a list of schedules — ignoring it");
      return [];
    }
    // PRESENT IS NOT THE SAME AS SENSIBLE. This asked only whether `id` was a
    // string, so `{"id":"s_1","when":12}` came back as a schedule, went into
    // the list, matched no pattern the scheduler knows and therefore never
    // fired — silently, for ever. A row that cannot be acted on is not kept and
    // half-believed; it is dropped, and it is said out loud.
    const usable: AgentSchedule[] = [];
    for (const row of parsed) {
      const problem = scheduleProblem(row);
      if (problem) {
        console.error(`[engine] ignoring a saved schedule that cannot be acted on: ${problem}`);
        continue;
      }
      usable.push(row as AgentSchedule);
    }
    return usable;
  }
  /**
   * Add or replace one schedule. Returns whether it is now ON THE DISK.
   *
   * These three used to return nothing, so a caller had no way to know a save
   * had failed and every caller told the owner it had worked. They report now,
   * and the tests refuse a caller that ignores the answer.
   */
  saveSchedule(s: AgentSchedule): boolean {
    const i = this.schedules.findIndex(x => x.id === s.id);
    const before = this.schedules.slice();
    if (i >= 0) this.schedules[i] = s; else this.schedules.push(s);
    const saved = this.writeSchedules();
    // Memory must not disagree with the disk. Leaving the schedule in the list
    // after a failed save is how it fires all afternoon and is then gone at the
    // next restart with nobody told — the exact silence this round is closing.
    if (!saved) this.schedules = before;
    return saved;
  }
  deleteSchedule(id: string): boolean {
    const before = this.schedules.slice();
    this.schedules = this.schedules.filter(s => s.id !== id);
    const saved = this.writeSchedules();
    if (!saved) this.schedules = before;
    return saved;
  }
  private writeSchedules(): boolean {
    return writeWholeFile(this.schedulesPath(), JSON.stringify(this.schedules, null, 2),
      m => console.error(`[engine] could not save the schedules: ${m}`));
  }
  agentDataDir = (agentId: string): string => {
    const dir = path.join(this.dataDir, "agents", agentId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  /**
   * ONE OF THIS COMPUTER'S AGENTS, AS THE HUB LAST DESCRIBED IT.
   *
   * The launcher's way in: a provider is handed an agent id and sometimes has to
   * ask what the OWNER chose for that agent — which connections file, for
   * instance. It reads the live state rather than a copy taken when the provider
   * was built, so a setting changed in the window takes effect on the very next
   * turn (the same rule `wholeComputerRoots` and `mcpConfigPath` are documented
   * with in `claude-cli.ts`). Undefined means this engine has never been told
   * about that agent — which is a real answer, not an error.
   */
  agentById = (agentId: string): AgentDef | undefined =>
    this.state?.agents.find(a => a.id === agentId);
}

/**
 * Is this row off the disk a schedule this engine could actually run? Returns
 * the problem in plain words, or null when it is fine — the same shape of
 * answer `validateRunRecord` gives, so the two read alike.
 *
 * `when` is checked by `isScheduleWhen`, which is the SCHEDULER'S own grammar
 * rather than a second copy of it here. A `when` this file accepted and the
 * scheduler did not would be a schedule that exists and never happens.
 */
/**
 * IS THIS FOLDER REALLY ON THIS COMPUTER, RIGHT NOW?
 *
 * Asked every time, never remembered: a folder that was there when the owner
 * chose it can be renamed, moved onto a drive that is unplugged, or deleted,
 * and a stale yes means an agent works in the wrong place or falls over with
 * git's own error instead of a sentence. A file that is not a folder is a no,
 * for the same reason.
 */
function isFolderOnDisk(folder: string): boolean {
  try {
    return fs.statSync(folder).isDirectory();
  } catch {
    return false;
  }
}

/** "worked" / "went wrong" / "was stopped" — for the sentence a hook carries. */
function plainOutcome(outcome: RunRecord["outcome"]): string {
  return outcome === "ok" ? "finished" : outcome === "failed" ? "went wrong" : "was stopped";
}

function scheduleProblem(row: unknown): string | null {
  if (!row || typeof row !== "object") return "that isn't a schedule";
  const s = row as Partial<AgentSchedule>;
  for (const [what, value] of [
    ["id", s.id], ["agent", s.agentId], ["conversation", s.channelId], ["instruction", s.prompt],
  ] as const) {
    if (typeof value !== "string" || value.length === 0) return `a schedule needs a ${what}`;
  }
  if (!isScheduleWhen(s.when)) return `"${String(s.when)}" is not a time this can act on`;
  if (typeof s.enabled !== "boolean") return "a schedule is either on or off";
  return null;
}

/**
 * What the owner is told when a schedule could not be written down.
 *
 * ONE sentence, said the same way by the typed command and by the approved
 * job, because they are the same failure. No stack trace, no path, no error
 * code — what happened, and what he can do about it.
 */
export const SCHEDULE_NOT_SAVED =
  "⚠️ I could NOT save that schedule on this computer, so it is NOT set — " +
  "nothing will happen at that time. Check there is room on the disk and try again.";

/**
 * How long an agent's search may wait on the hub before it gives up.
 *
 * Short on purpose. A search that hangs must not hold the agent's turn forever.
 * Giving up says so — the agent is told the search did not run and to carry on
 * without guessing, which is the honest answer and takes four seconds.
 */
const SEARCH_WAIT_MS = 4_000;

/**
 * The hub's ORDINARY address, derived from the one this engine already dials.
 *
 * The socket and the download endpoint are the same hub on the same port; only
 * the scheme differs. Deriving it means there is no second address to configure,
 * get wrong, or point somewhere else — a downloader that took its own host could
 * be aimed off this machine, and this one cannot be.
 */
export function httpBaseOf(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.toString();
}

function isBrakedReset(history: Message[]): boolean {
  return history.length > 0 && history[history.length - 1].authorKind === "human";
}

/**
 * Read "@From !handoff @To <what to do>" out of a message, or nothing when it is
 * not one. From the RAW text, because @-mentions are stripped from `bare` and
 * both names are ones. The `@` before the target is optional, so both
 * "!handoff @Terra …" and "!handoff Terra …" are understood.
 */
function parseHandoffCommand(text: string): { from: string; to: string; task: string } | undefined {
  const m = /@([\w-]+)\s+!handoff\s+@?([\w-]+)\s+([\s\S]+)/i.exec(text);
  if (!m) return undefined;
  const task = m[3].trim();
  if (!task) return undefined;
  return { from: m[1], to: m[2], task };
}

/**
 * The instruction the receiving agent wakes up to. It names who handed the work
 * over, states the task verbatim, and points the receiver at the conversation
 * for context — the "task + the pointer" the contract asks a handoff to carry.
 */
function handoffTrigger(handoff: AgentHandoff, fromName: string): string {
  const note = handoff.note ? ` They added: ${handoff.note}` : "";
  return (
    `@${fromName} has handed this piece of work to you. Here is what they asked you to do: ` +
    `${handoff.task}. For the context you need, catch up on this conversation — that is where ` +
    `they pointed you.${note} Pick it up and carry on.`
  );
}

