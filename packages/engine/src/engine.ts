// The Cloud9 agent engine host. A plain Node WS client of the relay — no
// Electron imports — so it can be lifted onto an always-on server unchanged
// (Stage-1 decision 5).
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import {
  AgentDef, AgentSchedule, Channel, ClientFrame, HarnessName, HarnessState, ID,
  Message, RunRecord, ServerFrame, Task, WorkReaction, WorldState, isSafeSkillFileName,
  mayDriveAgent, shareableRun, validateAgentInput, validateTaskSummary,
} from "@cloud9/shared";
import { approvalsFor, needsApprovalToRun } from "./abilities.js";
import { ApprovalDesk, ApprovalOutcome } from "./approvaldesk.js";
import { GitHubClient, GitHubOptions } from "./github.js";
import { BrakeConfig, DEFAULT_BRAKE, isBraked, shouldReply } from "./chatter.js";
import {
  ClaudeProvider, HarnessUnavailableError, MockProvider, redactForSharing, sanitizeForChat,
} from "./provider.js";
import { PendingAsk, rememberAsk, takeAsk, workEmoji } from "./reactions.js";
import { describeRepoTurn, repoTurn, RepoTurnResult } from "./repowork.js";
import { GitWorkspace } from "./worktree.js";
import { buildRunRecord, ProviderTrace, RunFinish, RunKind, RunSeed } from "./runrecord.js";
import { RunStore } from "./runstore.js";
import { Scheduler } from "./scheduler.js";
import { taskTldr } from "./tldr.js";

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
    this.runs = new RunStore({
      agentDataDir: this.agentDataDir,
      ...(opts.keepRunsPerAgent ? { keepPerAgent: opts.keepRunsPerAgent } : {}),
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
      const bare = message.text.replace(/@[\w-]+\s*/g, "");
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
      this.writeSkillFiles(agent);
      const text = await provider.respond({
        agent,
        context: input.context,
        trigger: input.trigger,
        triggerAuthor: input.triggerAuthor,
        ...(input.workdir ? { workdir: input.workdir } : {}),
        onTrace: t => { trace = t; },
      });
      this.recordRun(seed, { finishedAt: Date.now(), outcome: "ok", trace, reply: text });
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
  writeSkillFiles(agent: AgentDef): void {
    const skills = agent.skills ?? [];
    if (skills.length === 0) return;
    const dir = path.join(this.agentDataDir(agent.id), "skills");
    for (const skill of skills) {
      for (const file of skill.files ?? []) {
        if (!isSafeSkillFileName(file.name)) {
          console.error(`[engine] skipped a skill file with an unusable name on agent ${agent.id}`);
          continue;
        }
        const target = path.join(dir, file.name);
        // belt and braces: the resolved path must still be inside the folder
        if (path.relative(dir, target).startsWith("..")) continue;
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(target, file.text, "utf8");
        } catch (err) {
          console.error(`[engine] could not write skill file for agent ${agent.id}:`, err);
        }
      }
    }
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
        this.saveSchedule(s);
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

  private renderContext(channelId: ID, n = this.opts.contextMessages ?? 20): string {
    const history = this.history.get(channelId) ?? [];
    return history.slice(-n).map(m => `${m.authorName}: ${m.text}`).join("\n");
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
      this.saveSchedule(s);
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
      if (existed) this.deleteSchedule(remove[1]);
      this.agentSend(agent.id, channelId, existed ? `Cancelled ${remove[1]} ✅` : `I don't have a schedule ${remove[1]}.`);
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
  private schedulesPath(): string {
    return path.join(this.dataDir, "schedules.json");
  }
  private loadSchedules(): AgentSchedule[] {
    try { return JSON.parse(fs.readFileSync(this.schedulesPath(), "utf8")); }
    catch { return []; }
  }
  saveSchedule(s: AgentSchedule): void {
    const i = this.schedules.findIndex(x => x.id === s.id);
    if (i >= 0) this.schedules[i] = s; else this.schedules.push(s);
    fs.writeFileSync(this.schedulesPath(), JSON.stringify(this.schedules, null, 2));
  }
  deleteSchedule(id: string): void {
    this.schedules = this.schedules.filter(s => s.id !== id);
    fs.writeFileSync(this.schedulesPath(), JSON.stringify(this.schedules, null, 2));
  }
  agentDataDir = (agentId: string): string => {
    const dir = path.join(this.dataDir, "agents", agentId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
}

function isBrakedReset(history: Message[]): boolean {
  return history.length > 0 && history[history.length - 1].authorKind === "human";
}

