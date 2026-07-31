// The Cloud9 agent engine host. A plain Node WS client of the relay — no
// Electron imports — so it can be lifted onto an always-on server unchanged
// (Stage-1 decision 5).
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import {
  AgentDef, AgentSchedule, ARTIFACT_LIMITS, Channel, ClientFrame, HarnessName, HarnessState, ID,
  Message, RunRecord, ServerFrame, Task, WorkReaction, WorldState, isSafeFileName,
  mayDriveAgent, shareableRun, validateAgentInput, validateTaskSummary,
} from "@cloud9/shared";
import { approvalsFor, needsApprovalToRun } from "./abilities.js";
import { Cloud9SearchAnswer } from "./cloud9tools.js";
import { ConversationBudget, CONVERSATION_BUDGET, renderConversation } from "./context.js";
import { OpenTurn, ToolBridge } from "./toolbridge.js";
import { describeRefusals, sweepProduced } from "./artifacts.js";
import { ApprovalDesk, ApprovalOutcome } from "./approvaldesk.js";
import { GitHubClient, GitHubOptions } from "./github.js";
import { BrakeConfig, DEFAULT_BRAKE, isBraked, shouldReply } from "./chatter.js";
import {
  ClaudeProvider, HarnessUnavailableError, InstructionsNotSavedError, MockProvider,
  redactForSharing, sanitizeForChat,
} from "./provider.js";
import { PendingAsk, rememberAsk, takeAsk, workEmoji } from "./reactions.js";
import { describeRepoTurn, repoTurn, RepoTurnResult } from "./repowork.js";
import { GitWorkspace, Worktree } from "./worktree.js";
import { GitHubWriteRequest, GitHubWriteRequestWithoutRepo, runGitHubWrite } from "./githubwrite.js";
import { buildRunRecord, ProviderTrace, RunFinish, RunKind, RunSeed } from "./runrecord.js";
import { RunStore } from "./runstore.js";
import {
  MemoryStore, MemoryNote, newMemoryId, retrieveMemory, worthRemembering,
} from "./agent-memory.js";
import { AgentHandoff, buildHandoff, HandoffError } from "./agent-handoff.js";
import { isScheduleWhen, Scheduler } from "./scheduler.js";
import { taskTldr } from "./tldr.js";
import { sweepPendingTree, writeWholeFile } from "./wholefile.js";

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
   * How long an agent waits for a mid-run "may I push this?" before giving up.
   * Defaults to the shared ten minutes; tests shorten it. Shortening it can
   * only ever produce MORE refusals, never a yes nobody gave.
   */
  approvalWaitMs?: number;
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

/** Everything a turn needs, plus who is asking and on whose behalf. */
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
   * Where the turn happens. Absent — every ordinary turn — means the agent's
   * own folder. Set only for a turn working inside its own git worktree.
   */
  workdir?: string;
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
  /** whoever is waiting on a `searchResults` frame right now */
  private searchWaiters = new Set<(f: Extract<ServerFrame, { type: "searchResults" }>) => boolean>();
  private turnsInFlight = 0;
  private queue: (() => Promise<void>)[] = [];
  private opts: EngineOptions;
  private stopped = false;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  onReady?: () => void;
  /** the engine host answers these — it owns the local CLIs */
  onHarnessRequest?: (action: "status" | "signIn" | "cancel", harness?: HarnessName) => void;
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
      ...(opts.approvalWaitMs ? { waitMs: opts.approvalWaitMs } : {}),
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
      // NOBODY IS THERE TO ANSWER, so nothing leaves this machine. A dropped
      // socket is the one moment where carrying on and assuming it was fine
      // would be most tempting and most wrong.
      this.approvals.giveUpAll("the hub went away before anyone answered, so it did not happen");
      if (this.stopped) return;
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    });
    this.ws.on("error", () => { /* close handler reconnects */ });
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
        for (const m of frame.state.messages) this.pushHistory(m);
        for (const t of frame.state.tasks) this.tasks.set(t.id, t);
        this.scheduler.start();
        for (const t of frame.state.tasks) this.maybeRunTask(t);
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
      // ---- the mid-run approval round trip (his item 6) ----
      // The receipt tells us WHICH card belongs to which waiting agent; the
      // ordinary `approval` frame carries the decision. There is no special
      // decision frame, on purpose: `decideApproval` already produces this one
      // and a second path would be a second answer to "did we ask?".
      case "approvalAsked":
        this.approvals.onAsked(frame.askId, frame.approvalId);
        break;
      case "approval":
        this.approvals.onApproval(frame.approval);
        break;
      // an agent asked Cloud9 to search the conversation it is standing in
      case "searchResults":
        for (const waiter of [...this.searchWaiters]) {
          if (waiter(frame)) this.searchWaiters.delete(waiter);
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
      default:
        break;
    }
  }

  private pushHistory(m: Message): void {
    const list = this.history.get(m.channelId) ?? [];
    list.push(m);
    if (list.length > 300) list.splice(0, list.length - 300);
    this.history.set(m.channelId, list);
  }

  get myAgents(): AgentDef[] {
    if (!this.state) return [];
    return this.state.agents.filter(a => a.ownerId === this.state!.me.id);
  }

  private channel(id: ID): Channel | undefined {
    return this.state?.channels.find(c => c.id === id);
  }

  private async considerReplies(message: Message): Promise<void> {
    if (!this.state) return;
    const channel = this.channel(message.channelId);
    if (!channel) return;
    const history = this.history.get(channel.id) ?? [];
    const channelAgents = this.state.agents.filter(a => channel.memberIds.includes(a.id));
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
            agent, channel.id, handoffCmd.to, handoffCmd.task, message.authorName));
          continue;
        }
        if (me === handoffCmd.to.toLowerCase()) continue;
      }
      const bare = message.text.replace(/@[\w-]+\s*/g, "");
      // REMEMBER SOMETHING BETWEEN CONVERSATIONS: "@Agent !remember <text>". The
      // worth-remembering rule decides whether it lands; a refusal is said out
      // loud in the agent's own voice rather than swallowed.
      if (message.authorKind === "human" && /^!remember\s+/i.test(bare)) {
        const text = bare.replace(/^!remember\s+/i, "").trim();
        this.enqueue(() => this.rememberFromRoom(agent, channel.id, text));
        continue;
      }
      // schedule commands: "@Agent !schedule daily 06:30 do X" / "every 15m do X",
      // "@Agent !schedules", "@Agent !unschedule <id>"
      if (message.authorKind === "human"
        && this.handleScheduleCommand(agent, channel.id, bare, message.authorId)) continue;
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
        this.pendingAsks = rememberAsk(this.pendingAsks, {
          agentId: agent.id, channelId: channel.id, title, messageId: message.id, at: Date.now(),
        });
        this.reactAs(agent.id, message.id, "picked");
        this.agentSend(agent.id, channel.id, needsApproval
          ? `I can do that — waiting for my owner's approval first. 🔒 (see Tasks panel)`
          : `On it — I'll work on this in the background and post here when done. ⏳`);
        continue;
      }
      // WORK IN THE CODE: "!code <what to do>". The agent gets its own git
      // worktree, does the job in it, and — if IT decides it wants to — asks to
      // push and open a pull request. Everything up to the ask is local, so
      // starting one needs no approval; the only thing that leaves this
      // computer is behind the card, exactly as it was before.
      if (message.authorKind === "human" && /^!code\s+/i.test(bare)) {
        const what = bare.replace(/^!code\s+/i, "").trim();
        this.enqueue(async () => {
          await this.workInRepository(agent, {
            channelId: channel.id, ask: what, triggerAuthor: message.authorName,
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
          this.enqueue(() => this.workGitHubWriteInRoom(agent, channel.id, write));
          continue;
        }
      }
      this.enqueue(() => this.takeTurn(agent, channel.id, message));
    }
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue.push(job);
    void this.drain();
  }

  private async drain(): Promise<void> {
    const cap = this.opts.maxConcurrentTurns ?? 2;
    while (this.turnsInFlight < cap && this.queue.length > 0) {
      const job = this.queue.shift()!;
      this.turnsInFlight++;
      job().catch(() => { /* logged below */ })
        .finally(() => { this.turnsInFlight--; void this.drain(); });
    }
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
      requestedBy: input.triggerAuthor,
      requestedByKind: input.requesterKind ?? "human",
      ask: input.trigger,
      startedAt: Date.now(),
    };
    let trace: ProviderTrace | undefined;
    try {
      // last-gate validation: this agent definition arrived from a client, and
      // its model is checked against the harness's REAL list, not just its shape
      const problem = validateAgentInput(agent, { models: this.harnessModels?.(harness) });
      if (problem) throw new Error(`refusing to run agent ${agent.id}: ${problem}`);
      const provider = this.providerFor(agent);
      if (!provider) {
        throw new HarnessUnavailableError(harness, `${harness} is not connected on this machine`);
      }
      // An agent whose instructions did not all reach the disk does NOT take
      // the turn. Running it anyway would answer from an incomplete brief and
      // present that answer as an ordinary one; the run is recorded as failed
      // and the sentence says which file is missing.
      const missingSkillFiles = this.writeSkillFiles(agent);
      if (missingSkillFiles.length > 0) {
        throw new InstructionsNotSavedError(agent.name, missingSkillFiles);
      }
      const text = await provider.respond({
        agent,
        context: input.context,
        // WHAT THIS AGENT REMEMBERS, seeded into the turn. `retrieveMemory` has
        // already spent the memory budget (oldest kept, newest dropped) so this
        // is a bounded string; an agent that has saved nothing gets "" and the
        // prompt says nothing about memory. Reading its own store must never be
        // the reason a turn fails, so it is wrapped.
        memory: this.rememberedFor(agent.id),
        // THE INSTRUCTION TRAVELS WITH THE TURN, and `buildAgentPrompt` refuses
        // to render without it. This is the line the old `buildAgentPrompt(agent,
        // context)` threw away, which is why a 6:30am check-in was woken up and
        // told nothing at all.
        trigger: input.trigger,
        triggerAuthor: input.triggerAuthor,
        kind: seed.kind,
        ...(input.channelId ? { channelId: input.channelId } : {}),
        ...(input.workdir ? { workdir: input.workdir } : {}),
        onTrace: t => { trace = t; },
      });
      const record = this.recordRun(seed, { finishedAt: Date.now(), outcome: "ok", trace, reply: text });
      // THE FILES THIS TURN MADE, offered to the hub before the reply is
      // returned, so the message the agent is about to say and the file it is
      // talking about arrive together rather than minutes apart.
      this.shareProduced(agent, input, seed.startedAt, record?.id);
      return text;
    } catch (err) {
      this.recordRun(seed, {
        finishedAt: Date.now(), outcome: "failed", trace,
        // the record keeps WHY, in words that carry no path, no argv and no
        // environment — the same rule sanitizeForChat enforces for chat
        error: redactForSharing(err instanceof Error ? err.message : String(err)),
      });
      throw err;
    }
  }

  /**
   * Build and store one run record. Never throws: a turn that worked must not
   * be reported as broken because its paperwork failed.
   */
  private recordRun(seed: RunSeed, finish: RunFinish): RunRecord | undefined {
    try {
      const record = buildRunRecord(seed, finish);
      this.lastRun = record;
      this.runs.save(record);
      this.publishRun(record);
      this.onRunRecorded?.(record);
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
  private shareProduced(agent: AgentDef, input: TurnInput, since: number, runId?: string): void {
    // No conversation means nowhere to put a file. A turn with no channel is
    // not a turn anybody is waiting on a file from.
    const channelId = input.channelId;
    if (!channelId) return;
    try {
      const dir = input.workdir ?? this.agentDataDir(agent.id);
      const sweep = sweepProduced(dir, { since });
      for (const file of sweep.offers) {
        let bytes: Buffer;
        try { bytes = fs.readFileSync(file.path); }
        catch (err) {
          console.error(`[engine] could not read a file ${agent.name} made:`, err);
          continue;
        }
        // A file that changed between the sweep and the read is not a file we
        // agreed to share — the cap is checked against the BYTES WE HOLD.
        if (bytes.length === 0 || bytes.length > ARTIFACT_LIMITS.bytes) continue;
        this.sendFrame({
          type: "publishArtifact", channelId, agentId: agent.id, name: file.name,
          dataBase64: bytes.toString("base64"),
          ...(runId ? { runId } : {}),
          ...(input.taskId ? { taskId: input.taskId } : {}),
        });
      }
      // A REFUSAL IS SAID OUT LOUD, in the room, in the agent's own voice. The
      // file really is on this computer; silence here is the "the file's on
      // disk" complaint all over again, with the app doing the hiding.
      const said = describeRefusals(sweep.refused);
      if (said) this.agentSend(agent.id, channelId, said);
    } catch (err) {
      console.error(`[engine] could not share the files ${agent.name} made:`, err);
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

  /** Run one chat turn for an agent on its own harness. Public so tests can drive it. */
  async takeTurn(agent: AgentDef, channelId: ID, trigger: Message): Promise<void> {
    this.setStatus(agent.id, "working");
    try {
      const text = await this.respondAs(agent, {
        context: this.renderContext(channelId),
        trigger: trigger.text,
        triggerAuthor: trigger.authorName,
        kind: "chat",
        channelId,
        requesterKind: trigger.authorKind === "agent" ? "agent" : "human",
      });
      this.agentSend(agent.id, channelId, text);
    } catch (err) {
      this.agentSend(agent.id, channelId, sanitizeForChat(err, `${agent.name} could not take a turn`));
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
      const { messageId, rest } = takeAsk(this.pendingAsks, task);
      this.pendingAsks = rest;
      if (messageId) this.askMessageFor.set(task.id, messageId);
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
    this.enqueue(() => this.runTask(agent, task));
  }

  private async runTask(agent: AgentDef, task: Task): Promise<void> {
    this.setStatus(agent.id, "working");
    this.markWork(task, "picked", false);
    this.markWork(task, "working");
    this.sendFrame({ type: "updateTask", taskId: task.id, status: "working" });
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
          this.agentSend(agent.id, task.channelId, SCHEDULE_NOT_SAVED);
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
        this.agentSend(agent.id, task.channelId, `⏰ Approved & scheduled: ${s.when} — "${s.prompt}" (id ${s.id})`);
        return;
      }
      const text = await this.respondAs(agent, {
        context: this.renderContext(task.channelId),
        trigger: `Background task: ${task.title}. Do the work and report the outcome.`,
        triggerAuthor: task.requesterName,
        kind: "task",
        channelId: task.channelId,
        taskId: task.id,
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
      this.agentSend(agent.id, task.channelId, `📦 Task done:\n${text}`, true);
    } catch (err) {
      const said = sanitizeForChat(err, `task "${task.title}" failed`);
      this.sendFrame({
        type: "updateTask", taskId: task.id, status: "failed", error: said,
        ...this.summaryFor(undefined),
      });
      this.markWork(task, "working", false);
      this.markWork(task, "failed");
      this.agentSend(agent.id, task.channelId, said);
    } finally {
      this.setStatus(agent.id, "idle");
      this.askMessageFor.delete(task.id);
    }
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
    try {
      const text = await this.respondAs(agent, {
        context: this.renderContext(channelId),
        trigger: `Background task: ${trigger.text.replace(/^!bg\s+/i, "")}. Do the work and report the outcome.`,
        triggerAuthor: trigger.authorName,
        kind: "task",
        channelId,
      });
      this.agentSend(agent.id, channelId, `📦 Background task done:\n${text}`, true);
    } finally {
      this.setStatus(agent.id, "idle");
    }
  }

  private async fireSchedule(s: AgentSchedule): Promise<void> {
    const agent = this.myAgents.find(a => a.id === s.agentId);
    if (!agent) return;
    if (agent.lifecycle === "paused" || agent.lifecycle === "disabled") return; // FR-AG-007
    this.setStatus(agent.id, "working");
    try {
      const text = await this.respondAs(agent, {
        context: this.renderContext(s.channelId),
        trigger: `Scheduled task fired: ${s.prompt}`,
        triggerAuthor: "schedule",
        kind: "schedule",
        channelId: s.channelId,
        requesterKind: "schedule",
      });
      this.agentSend(agent.id, s.channelId, `⏰ ${text}`, true);
    } catch (err) {
      this.agentSend(agent.id, s.channelId, sanitizeForChat(err, `scheduled check-in ${s.id} failed`));
    } finally {
      this.setStatus(agent.id, "idle");
    }
  }

  /**
   * The conversation as the agent reads it. The RULE lives in `context.ts` —
   * this is only "which conversation". It used to be a `slice(-20)` written
   * inline here, with the 20 as a default argument nobody ever set; see the long
   * note in that file for why that was the single most damaging line in the
   * engine.
   */
  private renderContext(channelId: ID): string {
    const history = this.history.get(channelId) ?? [];
    return renderConversation(history, this.contextBudget);
  }

  /**
   * How much conversation this engine gives an agent. `contextMessages` is still
   * honoured because tests and QA set it, but it is now a CEILING on top of the
   * real budget rather than the whole rule.
   */
  private get contextBudget(): ConversationBudget {
    const n = this.opts.contextMessages;
    return n === undefined
      ? CONVERSATION_BUDGET
      : { characters: CONVERSATION_BUDGET.characters, messages: n };
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
  openToolTurn = (turn: { channelId: string }): OpenTurn | undefined => {
    return this.tools.openTurn({
      channelId: turn.channelId,
      search: (query, limit) => this.searchChannel(turn.channelId, query, limit),
    });
  };

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
    this.sendFrame({ type: "harnessState", state: { ...state, demo: this.demoMode } });
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
  }): Promise<RepoTurnResult | undefined> {
    const repoDir = input.repoDir ?? this.opts.repoDir;
    if (!repoDir) {
      // ABSENT MEANS ABSENT. Nobody has told this computer where the code is,
      // and a folder we invented would be the worst possible guess.
      this.agentSend(agent.id, input.channelId,
        "Nobody has told Cloud9 where this project's code lives on this computer yet, " +
        "so I have no repository to work in. Once it does, I can work on my own branch " +
        "and ask before anything goes to GitHub.");
      return undefined;
    }
    this.setStatus(agent.id, "working");
    try {
      const result = await repoTurn({
        agent, repoDir, channelId: input.channelId, ask: input.ask,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      }, {
        git: new GitWorkspace({ root: this.agentDataDir(agent.id) }),
        respond: ({ workdir, briefing }) => this.respondAs(agent, {
          context: this.renderContext(input.channelId),
          trigger: `${input.ask}${briefing}`,
          triggerAuthor: input.triggerAuthor,
          kind: input.taskId ? "task" : "chat",
          channelId: input.channelId,
          ...(input.taskId ? { taskId: input.taskId } : {}),
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
      this.agentSend(agent.id, input.channelId, `${said}${describeRepoTurn(result)}`);
      return result;
    } catch (err) {
      this.agentSend(agent.id, input.channelId,
        sanitizeForChat(err, `${agent.name} could not work in the repository`));
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
   * `gh` command. A no, an expiry or a dropped hub runs nothing and says which.
   */
  async workGitHubWriteInRoom(
    agent: AgentDef, channelId: ID, partial: GitHubWriteRequestWithoutRepo,
  ): Promise<void> {
    const repoDir = this.opts.repoDir;
    if (!repoDir) {
      this.agentSend(agent.id, channelId,
        "Nobody has told Cloud9 where this project's code lives on this computer yet, " +
        "so I have no repository to act on. Once it does, I can ask before anything goes to GitHub.");
      return;
    }
    this.setStatus(agent.id, "working");
    try {
      // WHAT IS THIS REPOSITORY CALLED — a read, so no card. A repository gh
      // cannot name is reported honestly rather than guessed at.
      const repo = await this.readOnlyGitHub().repoName({ path: repoDir } as Worktree);
      if (!repo) {
        this.agentSend(agent.id, channelId,
          "I could not work out which GitHub repository this folder belongs to, so I have " +
          "not asked to do anything. Check that this project is a GitHub checkout signed in with gh.");
        return;
      }
      const request = { ...partial, repo } as GitHubWriteRequest;
      const outcome = await runGitHubWrite({
        request,
        ask: async facts => {
          const o: ApprovalOutcome = await this.approvals.ask({ agent, channelId, facts });
          return { approved: o.approved, reason: o.reason };
        },
        ...(this.opts.github?.runner ? { run: this.opts.github.runner } : {}),
      });
      if (!outcome.ran) {
        this.agentSend(agent.id, channelId,
          `I asked to ${outcome.description}, and ${outcome.reason}. Nothing left this computer.`);
        return;
      }
      if (outcome.problem) {
        this.agentSend(agent.id, channelId,
          `You approved it, but GitHub would not take it: ${outcome.problem}`);
        return;
      }
      this.agentSend(agent.id, channelId, `Approved — done. I went ahead to ${outcome.description}.`);
    } catch (err) {
      this.agentSend(agent.id, channelId,
        sanitizeForChat(err, `${agent.name} could not do that on GitHub`));
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
  private rememberedFor(agentId: ID): string {
    try {
      return retrieveMemory(this.memory.list(agentId));
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
  async rememberFromRoom(agent: AgentDef, channelId: ID, text: string): Promise<void> {
    const verdict = worthRemembering(text);
    if (!verdict.keep) {
      this.agentSend(agent.id, channelId,
        `I didn't save that to memory — ${verdict.reason}. Give me a short fact worth ` +
        `keeping, like "my owner ships on Fridays".`);
      return;
    }
    const note: MemoryNote = {
      id: newMemoryId(), agentId: agent.id, kind: "fact",
      text: text.trim(), createdAt: Date.now(), source: "owner",
    };
    const saved = this.memory.save(note);
    if (!saved) {
      this.agentSend(agent.id, channelId,
        "I couldn't save that to memory on this computer — check there is room on the " +
        "disk and try again.");
      return;
    }
    this.agentSend(agent.id, channelId, `📝 Saved to memory — I'll remember: "${note.text}"`);
    // push the fresh list to any screen that has this agent's file open
    this.reportMemory(agent.id);
  }

  /**
   * Tell the owner's screens what an agent has saved, off THIS computer's own
   * store — the one durable copy. Only ever for the engine's own agents; the
   * hub has already checked ownership, and this checks again. Never throws.
   */
  reportMemory(agentId: ID): void {
    try {
      if (!this.myAgents.some(a => a.id === agentId)) return;
      const notes = this.memory.list(agentId);
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
  ): Promise<void> {
    const wanted = targetName.replace(/^@/, "").toLowerCase();
    const target = this.state?.agents.find(a => a.name.toLowerCase() === wanted);
    if (!target) {
      this.agentSend(agent.id, channelId,
        `I couldn't find an agent called @${targetName.replace(/^@/, "")} to hand this to.`);
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
      this.agentSend(agent.id, channelId, `I couldn't hand that off — ${detail}.`);
      return;
    }
    // THE LINE ON SCREEN, in plain words, from a real handoff and in the
    // sender's own voice. The receiver's turn arrives separately, when the hub
    // delivers the handoff to its engine.
    this.agentSend(agent.id, channelId, `🤝 Passed to @${target.name} — ${handoff.task}`);
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
    const channelId = handoff.contextPointer.kind === "channel"
      ? handoff.contextPointer.ref : undefined;
    if (!channelId) return;
    const fromName = this.state?.agents.find(a => a.id === handoff.fromAgentId)?.name
      ?? handoff.fromAgentId;
    this.setStatus(target.id, "working");
    try {
      const text = await this.respondAs(target, {
        context: this.renderContext(channelId),
        trigger: handoffTrigger(handoff, fromName),
        triggerAuthor: fromName,
        kind: "chat",
        channelId,
        requesterKind: "agent",
      });
      this.agentSend(target.id, channelId, text);
    } catch (err) {
      this.agentSend(target.id, channelId,
        sanitizeForChat(err, `${target.name} could not pick up a handoff`));
    } finally {
      this.setStatus(target.id, "idle");
    }
  }

  agentSend(agentId: ID, channelId: ID, text: string, proactive = false): void {
    this.sendFrame({ type: "agentSend", agentId, channelId, text, proactive });
  }

  private setStatus(agentId: ID, status: "idle" | "working" | "braked"): void {
    this.sendFrame({ type: "agentStatus", agentId, status });
  }

  private sendFrame(frame: ClientFrame): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  /** returns true when the message was a schedule command (handled, no LLM turn) */
  handleScheduleCommand(agent: AgentDef, channelId: ID, text: string, requesterId?: ID): boolean {
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
      this.agentSend(agent.id, channelId, `Schedule request sent for approval. 🔒`);
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
        this.agentSend(agent.id, channelId, SCHEDULE_NOT_SAVED);
        return true;
      }
      this.agentSend(agent.id, channelId,
        `⏰ Scheduled! I'll do this ${s.when}: "${s.prompt}" (id ${s.id} — "@${agent.name} !unschedule ${s.id}" to cancel)`);
      return true;
    }
    if (/^!schedules$/i.test(t)) {
      const mine = this.schedules.filter(s => s.agentId === agent.id);
      this.agentSend(agent.id, channelId, mine.length
        ? `My schedules:\n${mine.map(s => `• ${s.id}: ${s.when} — ${s.prompt}`).join("\n")}`
        : "I have no schedules yet. Try: `!schedule daily 06:30 post a morning check-in`");
      return true;
    }
    const remove = /^!unschedule\s+(\S+)$/i.exec(t);
    if (remove) {
      const existed = this.schedules.some(s => s.id === remove[1] && s.agentId === agent.id);
      if (!existed) {
        this.agentSend(agent.id, channelId, `I don't have a schedule ${remove[1]}.`);
        return true;
      }
      // same rule the other way round: a cancellation that did not reach the
      // disk comes BACK at the next restart, so it is not called "cancelled"
      this.agentSend(agent.id, channelId, this.deleteSchedule(remove[1])
        ? `Cancelled ${remove[1]} ✅`
        : `⚠️ I could NOT cancel ${remove[1]} — the change could not be saved on this computer, ` +
          `so it is still set. Check there is room on the disk and try again.`);
      return true;
    }
    if (/^!schedule\b/i.test(t)) {
      this.agentSend(agent.id, channelId,
        'Schedule format: `!schedule daily HH:MM <what to do>` or `!schedule every Nm <what to do>`');
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
 * Short on purpose. The agent is mid-turn on a wall-clock leash of its own, and
 * a search that hangs would spend that leash on nothing. Giving up says so — the
 * agent is told the search did not run and to carry on without guessing, which
 * is the honest answer and takes four seconds rather than three minutes.
 */
const SEARCH_WAIT_MS = 4_000;

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

