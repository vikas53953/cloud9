// Renderer-side relay client: one WebSocket, one mutable world, subscribers.
import {
  ActivityRecord, AgentDef, AgentStatus, Approval, Channel, ClientFrame,
  HarnessState, ID, Message, ServerFrame, Task, User,
} from "@cloud9/shared";

export interface World {
  connected: boolean;
  authFailed: boolean;
  me?: User;
  users: User[];
  agents: AgentDef[];
  channels: Channel[];
  messages: Record<ID, Message[]>; // by channel
  agentStatus: Record<ID, AgentStatus>;
  inviteCode?: string;
  tasks: Task[];
  approvals: Approval[];
  activity: ActivityRecord[];
  /** status of the local Claude/Codex apps — booleans and labels, never secrets */
  harness?: HarnessState;
  /** the last thing the relay refused, so a failed save is never silent */
  lastError?: { text: string; ts: number };
  /**
   * The last channel the relay handed us. Asking for a direct conversation is
   * answered with one of these — whether it made a new one or found the old
   * one — so the UI can open exactly what it was given instead of guessing.
   */
  lastChannel?: { id: ID; ts: number };
}

type Listener = () => void;

const params = new URLSearchParams(location.search);
export const RELAY_URL =
  params.get("relay") ?? localStorage.getItem("cloud9.relay") ?? "ws://127.0.0.1:8787";

/**
 * v1 kept the Claude credential in localStorage. That was wrong, and simply
 * removing the code that writes it does not remove the copy already sitting in
 * an existing install's browser storage — so wipe it, unconditionally, on every
 * start. Listed by name (not by pattern) so the session token survives.
 */
const LEGACY_SECRET_KEYS = ["cloud9.claudeCred", "cloud9.claudeCredKind"];

export function purgeLegacySecrets(): void {
  try {
    for (const key of LEGACY_SECRET_KEYS) {
      if (localStorage.getItem(key) !== null) {
        localStorage.removeItem(key);
        console.warn(`[cloud9] removed an old credential (${key}) from browser storage`);
      }
    }
  } catch { /* storage unavailable — nothing to purge */ }
}

export class RelayClient {
  world: World = {
    connected: false, authFailed: false, users: [], agents: [], channels: [],
    messages: {}, agentStatus: {}, tasks: [], approvals: [], activity: [],
  };
  private ws?: WebSocket;
  private listeners = new Set<Listener>();
  private snapshotCache: World = { ...this.world };

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSnapshot = (): World => this.snapshotCache;

  private emit(): void {
    this.snapshotCache = { ...this.world };
    for (const fn of this.listeners) fn();
  }

  connect(token: string): void {
    this.ws?.close();
    const ws = new WebSocket(RELAY_URL);
    this.ws = ws;
    ws.onopen = () => this.send({ type: "hello", token, client: "desktop" });
    ws.onclose = () => {
      this.world.connected = false;
      this.emit();
      if (!this.world.authFailed) setTimeout(() => this.connect(this.token()), 2500);
    };
    ws.onmessage = ev => this.onFrame(JSON.parse(ev.data) as ServerFrame);
  }

  token(): string {
    return localStorage.getItem("cloud9.token") ?? "";
  }
  setToken(token: string): void {
    localStorage.setItem("cloud9.token", token);
  }

  send(frame: ClientFrame): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private onFrame(frame: ServerFrame): void {
    const w = this.world;
    switch (frame.type) {
      case "welcome": {
        w.connected = true;
        w.authFailed = false;
        w.me = frame.state.me;
        w.users = frame.state.users;
        w.agents = frame.state.agents;
        w.channels = frame.state.channels;
        w.agentStatus = frame.state.agentStatus;
        w.tasks = frame.state.tasks;
        w.approvals = frame.state.approvals;
        w.messages = {};
        for (const m of frame.state.messages) {
          (w.messages[m.channelId] ??= []).push(m);
        }
        break;
      }
      case "token":
        this.setToken(frame.token);
        break;
      case "message": {
        // new arrays, not in-place pushes: the UI compares references to decide
        // what to recompute, so a mutated-in-place list looks like "no change"
        const cid = frame.message.channelId;
        w.messages = { ...w.messages, [cid]: [...(w.messages[cid] ?? []), frame.message] };
        break;
      }
      case "channel": {
        const i = w.channels.findIndex(c => c.id === frame.channel.id);
        if (i >= 0) w.channels[i] = frame.channel; else w.channels.push(frame.channel);
        w.channels = [...w.channels];
        w.lastChannel = { id: frame.channel.id, ts: Date.now() };
        break;
      }
      case "agent": {
        const i = w.agents.findIndex(a => a.id === frame.agent.id);
        if (i >= 0) w.agents[i] = frame.agent; else w.agents.push(frame.agent);
        w.agents = [...w.agents];
        break;
      }
      case "agentDeleted":
        w.agents = w.agents.filter(a => a.id !== frame.agentId);
        break;
      case "agentStatus":
        w.agentStatus = { ...w.agentStatus, [frame.agentId]: frame.status };
        break;
      case "invite":
        w.inviteCode = frame.code;
        break;
      case "task": {
        const i = w.tasks.findIndex(t => t.id === frame.task.id);
        if (i >= 0) w.tasks[i] = frame.task; else w.tasks.unshift(frame.task);
        w.tasks = [...w.tasks];
        break;
      }
      case "approval": {
        const i = w.approvals.findIndex(a => a.id === frame.approval.id);
        if (i >= 0) w.approvals[i] = frame.approval; else w.approvals.push(frame.approval);
        w.approvals = [...w.approvals];
        break;
      }
      case "activity":
        w.activity = frame.records;
        break;
      case "harness":
        w.harness = frame.state;
        break;
      case "history": {
        const existing = w.messages[frame.channelId] ?? [];
        const known = new Set(existing.map(m => m.id));
        w.messages = {
          ...w.messages,
          [frame.channelId]: [...frame.messages.filter(m => !known.has(m.id)), ...existing],
        };
        break;
      }
      case "userJoined":
        w.users = [...w.users, frame.user];
        break;
      case "error":
        if (frame.error === "bad token") w.authFailed = true;
        else w.lastError = { text: frame.error, ts: Date.now() };
        break;
      default:
        break;
    }
    this.emit();
  }
}

export const client = new RelayClient();
