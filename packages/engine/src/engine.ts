// The Cloud9 agent engine host. A plain Node WS client of the relay — no
// Electron imports — so it can be lifted onto an always-on server unchanged
// (Stage-1 decision 5).
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import {
  AgentDef, AgentSchedule, Channel, ClientFrame, HarnessName, HarnessState, ID,
  Message, ServerFrame, Task, WorldState, isSafeSkillFileName, validateAgentInput,
} from "@cloud9/shared";
import { BrakeConfig, DEFAULT_BRAKE, isBraked, shouldReply } from "./chatter.js";
import {
  ClaudeProvider, HarnessUnavailableError, MockProvider, sanitizeForChat,
} from "./provider.js";
import { Scheduler } from "./scheduler.js";

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
  private history = new Map<ID, Message[]>();
  tasks = new Map<ID, Task>();
  private claimed = new Set<ID>();
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
      if (this.stopped) return;
      this.reconnectTimer = setTimeout(() => this.connect(), 2000);
    });
    this.ws.on("error", () => { /* close handler reconnects */ });
  }

  stop(): void {
    this.stopped = true;
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
        const needsApproval = agent.approvals?.background === true;
        this.sendFrame({
          type: "createTask", agentId: agent.id, channelId: channel.id, title,
          // the person who TYPED it, not the account this engine runs as — a
          // friend's job must stay their job in Tasks and in the activity log
          requesterId: message.authorId,
          needsApproval, action: needsApproval ? `Run background task: ${title}` : undefined,
        });
        this.agentSend(agent.id, channel.id, needsApproval
          ? `I can do that — waiting for my owner's approval first. 🔒 (see Tasks panel)`
          : `On it — I'll work on this in the background and post here when done. ⏳`);
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

  /** Run one turn on the agent's own harness. Public so tests can drive it. */
  async respondAs(
    agent: AgentDef, input: { context: string; trigger: string; triggerAuthor: string },
  ): Promise<string> {
    const harness = agent.provider ?? "claude";
    // last-gate validation: this agent definition arrived from a client, and
    // its model is checked against the harness's REAL list, not just its shape
    const problem = validateAgentInput(agent, { models: this.harnessModels?.(harness) });
    if (problem) throw new Error(`refusing to run agent ${agent.id}: ${problem}`);
    const provider = this.providerFor(agent);
    if (!provider) {
      throw new HarnessUnavailableError(harness, `${harness} is not connected on this machine`);
    }
    this.writeSkillFiles(agent);
    return provider.respond({ agent, ...input });
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
    if (agent.lifecycle === "paused" || agent.lifecycle === "disabled") return; // FR-AG-007
    this.claimed.add(task.id);
    this.enqueue(() => this.runTask(agent, task));
  }

  private async runTask(agent: AgentDef, task: Task): Promise<void> {
    this.setStatus(agent.id, "working");
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
        this.sendFrame({ type: "updateTask", taskId: task.id, status: "completed", result: `schedule ${s.id} created` });
        this.agentSend(agent.id, task.channelId, `⏰ Approved & scheduled: ${s.when} — "${s.prompt}" (id ${s.id})`);
        return;
      }
      const text = await this.respondAs(agent, {
        context: this.renderContext(task.channelId),
        trigger: `Background task: ${task.title}. Do the work and report the outcome.`,
        triggerAuthor: task.requesterName,
      });
      // FR-TS-005: if cancelled while we worked, discard the result
      if (this.tasks.get(task.id)?.status === "cancelled") return;
      this.sendFrame({ type: "updateTask", taskId: task.id, status: "completed", result: text.slice(0, 2000) });
      this.agentSend(agent.id, task.channelId, `📦 Task done:\n${text}`, true);
    } catch (err) {
      const said = sanitizeForChat(err, `task "${task.title}" failed`);
      this.sendFrame({ type: "updateTask", taskId: task.id, status: "failed", error: said });
      this.agentSend(agent.id, task.channelId, said);
    } finally {
      this.setStatus(agent.id, "idle");
    }
  }

  private async backgroundTask(agent: AgentDef, channelId: ID, trigger: Message): Promise<void> {
    this.setStatus(agent.id, "working");
    try {
      const text = await this.respondAs(agent, {
        context: this.renderContext(channelId),
        trigger: `Background task: ${trigger.text.replace(/^!bg\s+/i, "")}. Do the work and report the outcome.`,
        triggerAuthor: trigger.authorName,
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
  reportHarness(state: HarnessState): void {
    // demo mode travels WITH the status every client already listens to, so the
    // screen can say "these answers are made up" without anyone having to
    // remember to ask a second question
    this.sendFrame({ type: "harnessState", state: { ...state, demo: this.demoMode } });
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
    if (create && agent.approvals?.schedules === true) {
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

