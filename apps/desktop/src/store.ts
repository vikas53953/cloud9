// Renderer-side relay client: one WebSocket, one mutable world, subscribers.
import {
  ActivityRecord, AgentDef, AgentStatus, Approval, Channel, ClientFrame,
  HarnessState, ID, Message, SearchHit, ServerFrame, Task, UnreadEntry, User,
} from "@cloud9/shared";

/**
 * Where scrollback has got to in ONE conversation.
 *
 * The cursor is a PAIR and it is the relay's, never ours: two messages can land
 * in the same millisecond, and the id is what breaks the tie. `hasMore` is the
 * only honest end-of-history signal — a short page is not the end.
 */
export interface Page {
  hasMore: boolean;
  nextBefore?: number;
  nextBeforeId?: ID;
  /** a page is in flight — stops the scroll handler asking for it twice */
  loading: boolean;
  /** we have asked for this conversation at least once, so `hasMore` means something */
  asked: boolean;
}

export interface SearchState {
  query: string;
  running: boolean;
  results: SearchHit[];
  hasMore: boolean;
  /** the query the results on screen actually belong to */
  answered: string;
}

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
  /** how far back each conversation has been read, by channel */
  pages: Record<ID, Page>;
  /** one thread's messages, keyed by the id of the message that started it */
  threads: Record<ID, Message[]>;
  /**
   * Where this person has read up to, per conversation — from the RELAY, so it
   * follows them between machines. There is no browser copy of this any more.
   */
  unread: Record<ID, UnreadEntry>;
  /** the one search running or last answered */
  search?: SearchState;
  /**
   * Bumped every time a page of OLDER messages was put on the front of a
   * conversation. The message list watches this to keep the reader's place:
   * prepending changes `scrollHeight`, and without this the view would jump.
   */
  prepended: number;
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

/**
 * State that used to live in this browser and now lives on the account.
 *
 * `cloud9.lastRead` was read state kept per MACHINE: read a room on the laptop
 * and the phone still showed it bold. The relay owns it now, so the old copy is
 * not just unused — it is a second, disagreeing answer, and it goes.
 */
const LEGACY_LOCAL_STATE_KEYS = ["cloud9.lastRead"];

export function purgeLegacySecrets(): void {
  try {
    for (const key of LEGACY_LOCAL_STATE_KEYS) {
      if (localStorage.getItem(key) !== null) {
        localStorage.removeItem(key);
        console.warn(`[cloud9] removed machine-only read state (${key}) — the relay keeps it now`);
      }
    }
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
    pages: {}, threads: {}, unread: {}, prepended: 0,
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
    // a fresh attempt starts with a clean slate: the last refusal belonged to the
    // last attempt, and leaving it up would explain the wrong thing
    this.world.authFailed = false;
    this.world.lastError = undefined;
    this.emit();
    const ws = new WebSocket(RELAY_URL);
    this.ws = ws;
    ws.onopen = () => this.send({ type: "hello", token, client: "desktop" });
    ws.onclose = () => {
      this.world.connected = false;
      // Retrying on an EMPTY token is not a retry — it is a guaranteed "bad
      // token", and that second refusal used to overwrite the real reason the
      // first one gave (a spent invite). No token, no reconnect.
      if (!this.world.authFailed && this.token()) {
        setTimeout(() => this.connect(this.token()), 2500);
      } else if (!this.token()) {
        this.world.authFailed = true;
      }
      this.emit();
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

  /**
   * Say something the app itself decided, in the one place refusals are said.
   *
   * When the app declines to do something (a guest asking for an invite the
   * relay would refuse anyway), it must not just do nothing — silence is the
   * dead click this round exists to kill. It goes through `lastError` so there
   * is still exactly ONE owner of "here is why that didn't happen": the toast
   * on every workspace screen, the notice on the join screen. Pass the relay's
   * own wording where one exists, so both routes print the same sentence.
   */
  notify(text: string): void {
    this.world.lastError = { text, ts: Date.now() };
    this.emit();
  }

  /* ---------------- scrollback ---------------- */

  page(channelId: ID): Page {
    return this.world.pages[channelId] ?? { hasMore: true, loading: false, asked: false };
  }

  private setPage(channelId: ID, patch: Partial<Page>): void {
    this.world.pages = {
      ...this.world.pages,
      [channelId]: { ...this.page(channelId), ...patch },
    };
  }

  /**
   * Ask for one page of a conversation.
   *
   * With no cursor this is the newest page — the first thing a conversation
   * needs, because `welcome` hands over recent messages without ever saying
   * whether there are older ones. With the cursor from the last `history`
   * frame it is the page before that. The cursor is sent back EXACTLY as it
   * arrived; a hand-built one skips or repeats a message at the boundary.
   */
  loadOlder(channelId: ID): void {
    const page = this.page(channelId);
    if (page.loading) return;
    if (page.asked && !page.hasMore) return;
    this.setPage(channelId, { loading: true });
    this.emit();
    this.send({
      type: "history", channelId, limit: 50,
      before: page.asked ? page.nextBefore : undefined,
      beforeId: page.asked ? page.nextBeforeId : undefined,
    });
  }

  /* ---------------- read state ---------------- */

  /** "I have read this conversation up to here." Kept on the account, not here. */
  markRead(channelId: ID, ts?: number): void {
    this.send({ type: "markRead", channelId, ts });
  }

  /* ---------------- search ---------------- */

  search(query: string, filters: { channelId?: ID; authorId?: ID } = {}): void {
    this.world.search = {
      query, running: true,
      results: this.world.search?.results ?? [],
      hasMore: false,
      answered: this.world.search?.answered ?? "",
    };
    this.emit();
    this.send({ type: "search", query, ...filters, limit: 50 });
  }

  clearSearch(): void {
    this.world.search = undefined;
    this.emit();
  }

  /**
   * Put one changed message everywhere it is being held.
   *
   * ONE OWNER for "a message changed": the conversation, the open thread and
   * the search results all read from here, so an edit cannot be applied to two
   * of the three and quietly missed by the last.
   */
  private replaceMessage(next: Message): void {
    const w = this.world;
    const list = w.messages[next.channelId];
    if (list) {
      const i = list.findIndex(m => m.id === next.id);
      if (i >= 0) {
        const copy = [...list];
        copy[i] = next;
        w.messages = { ...w.messages, [next.channelId]: copy };
      }
    }
    for (const [root, msgs] of Object.entries(w.threads)) {
      const i = msgs.findIndex(m => m.id === next.id);
      if (i >= 0) {
        const copy = [...msgs];
        copy[i] = next;
        w.threads = { ...w.threads, [root]: copy };
      }
    }
    if (w.search) {
      const hits = w.search.results;
      if (hits.some(h => h.message.id === next.id)) {
        w.search = {
          ...w.search,
          results: hits.map(h => (h.message.id === next.id ? { ...h, message: next } : h)),
        };
      }
    }
  }

  /** Apply the full, current list of who reacted with one emoji to one message. */
  private applyReaction(messageId: ID, emoji: string, userIds: ID[]): void {
    const w = this.world;
    const rewrite = (m: Message): Message => {
      const others = (m.reactions ?? []).filter(r => r.emoji !== emoji);
      // an empty list is not "no change" — it means nobody reacts with this any
      // more, so the pill goes away entirely
      const reactions = userIds.length > 0 ? [...others, { emoji, userIds }] : others;
      return { ...m, reactions };
    };
    for (const [cid, list] of Object.entries(w.messages)) {
      const i = list.findIndex(m => m.id === messageId);
      if (i < 0) continue;
      const copy = [...list];
      copy[i] = rewrite(copy[i]);
      w.messages = { ...w.messages, [cid]: copy };
    }
    for (const [root, msgs] of Object.entries(w.threads)) {
      const i = msgs.findIndex(m => m.id === messageId);
      if (i < 0) continue;
      const copy = [...msgs];
      copy[i] = rewrite(copy[i]);
      w.threads = { ...w.threads, [root]: copy };
    }
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
        // a fresh world means fresh cursors: the pages we walked back through
        // belonged to the last connection
        w.pages = {};
        w.threads = {};
        w.unread = {};
        for (const entry of frame.state.unread ?? []) w.unread[entry.channelId] = entry;
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
        // A reply belongs to its thread as well as to the room. Without this
        // the open thread panel would sit there missing the very reply that was
        // just typed into it, until somebody closed and reopened it.
        const root = frame.message.replyTo;
        if (root && w.threads[root] && !w.threads[root].some(m => m.id === frame.message.id)) {
          w.threads = { ...w.threads, [root]: [...w.threads[root], frame.message] };
        }
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
        const older = frame.messages.filter(m => !known.has(m.id));
        w.messages = {
          ...w.messages,
          // oldest first, prepended as-is — the relay already sorted them
          [frame.channelId]: [...older, ...existing],
        };
        this.setPage(frame.channelId, {
          hasMore: frame.hasMore,
          nextBefore: frame.nextBefore,
          nextBeforeId: frame.nextBeforeId,
          loading: false,
          asked: true,
        });
        // only a page that actually put messages ON THE FRONT moves the reader
        if (older.length > 0 && existing.length > 0) w.prepended += 1;
        break;
      }
      case "searchResults":
        w.search = {
          query: w.search?.query ?? frame.query,
          answered: frame.query,
          running: false,
          results: frame.results,
          hasMore: frame.hasMore,
        };
        break;
      case "reaction":
        // A reaction frame is a FACT, not a delta: replace the list, never add
        this.applyReaction(frame.messageId, frame.emoji, frame.userIds);
        break;
      case "messageUpdated":
        this.replaceMessage(frame.message);
        break;
      case "thread":
        w.threads = { ...w.threads, [frame.parentId]: frame.messages };
        break;
      case "read":
        // Apply unconditionally — this frame is how the other machine finds out
        w.unread = { ...w.unread, [frame.entry.channelId]: frame.entry };
        break;
      case "userJoined":
        w.users = [...w.users, frame.user];
        break;
      case "userRemoved": {
        // Removed means removed EVERYWHERE, now — not after a reload. The
        // sidebar, the @-mention list and the "Remove a person" dropdown all
        // read these two arrays, so dropping them here fixes every list at once.
        if (w.me && frame.userId === w.me.id) {
          // it was us: the relay has already closed the socket, so show the
          // welcome screen with a reason rather than an empty app
          w.authFailed = true;
          w.lastError = { text: "you were removed from this Cloud9", ts: Date.now() };
          break;
        }
        w.users = w.users.filter(u => u.id !== frame.userId);
        w.channels = w.channels.filter(
          c => !(c.kind === "dm" && c.memberIds.includes(frame.userId)));
        break;
      }
      case "error":
        w.lastError = { text: frame.error, ts: Date.now() };
        // A refusal that arrives before we were ever let in is a FAILED JOIN:
        // send the person back to the welcome screen, where the reason is
        // visible, instead of leaving them staring at an empty workspace.
        if (frame.error === "bad token" || !w.me) w.authFailed = true;
        break;
      // Frames that are not ours to act on. Named, not defaulted, so the
      // exhaustiveness check below still holds.
      case "push":        // relay → mobile only
      case "harnessRequest": // relay → engine host only
        break;
      // The one chat-basics frame with no screen yet. Attachments are held back
      // deliberately: there is no way to get a file back OFF the hub (see
      // `docs/plans/chat-basics-handoff.md` §6), so an upload button would park
      // files nobody could ever open. Named, not defaulted, so the
      // exhaustiveness check below keeps its teeth.
      case "attachment":
      // Landing right now in the relay half, and named here rather than
      // defaulted so the exhaustiveness check below keeps its teeth. Browsing
      // rooms you are not in is its own screen and is not this round's.
      case "attachmentTicket":
      case "channelDirectory":
      case "channelMembers":
        break;
      case "channelLeft": {
        // Out of the room means out of it NOW — not after a reload. Everything
        // cached for it goes with it, or the app would keep drawing a
        // conversation the relay will no longer answer about.
        w.channels = w.channels.filter(c => c.id !== frame.channelId);
        const { [frame.channelId]: goneMessages, ...restMessages } = w.messages;
        void goneMessages;
        w.messages = restMessages;
        const { [frame.channelId]: gonePage, ...restPages } = w.pages;
        void gonePage;
        w.pages = restPages;
        const { [frame.channelId]: goneUnread, ...restUnread } = w.unread;
        void goneUnread;
        w.unread = restUnread;
        break;
      }
      default: {
        /**
         * If a new frame is added to `ServerFrame` and not handled above, this
         * line stops being assignable and `tsc` fails the build. An unhandled
         * frame can no longer ship silently the way `userRemoved` did.
         */
        const unhandled: never = frame;
        void unhandled;
        break;
      }
    }
    this.emit();
  }
}

export const client = new RelayClient();
