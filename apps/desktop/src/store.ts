// Renderer-side relay client: one WebSocket, one mutable world, subscribers.
import {
  ActivityRecord, AgentDef, AgentStatus, Approval, Attachment, ATTACHMENT_LIMITS, Channel,
  ChannelMember, ChannelSummary, ClientFrame, HarnessState, ID, isInlineViewable, Message,
  RunListEntry, RunRecord, SearchHit, ServerFrame, Task, UnreadEntry, User, validateAttachment,
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

/**
 * One file on its way from this machine to the hub.
 *
 * It is held per CONVERSATION, because that is where the person can see it:
 * a file picked in #trip must not turn up attached to a message in #general
 * just because the reader changed rooms while it was going up.
 */
export interface Upload {
  /** ours, for the life of this screen — the hub's id only exists once it lands */
  localId: string;
  name: string;
  size: number;
  state: "sending" | "done" | "failed";
  /** the hub's own sentence when it refused, never a paraphrase */
  error?: string;
  /** what to name in `send` once it is up */
  attachmentId?: ID;
}

/**
 * An attached file this screen has opened.
 *
 * `url` is a `blob:` we made and therefore must revoke (see `closeFile`),
 * unless `direct` is set — which only SAVING does, because a download is a
 * navigation to a one-use hub URL rather than a copy this app is holding, and
 * there is nothing of ours to free.
 */
export interface OpenFile {
  state: "opening" | "ready" | "failed";
  url?: string;
  direct?: boolean;
  error?: string;
}

/**
 * One answer to "what has this agent — or this job — been doing".
 *
 * `asked` is what tells an empty history from an unanswered one. Without it a
 * rail would say "nothing yet" the instant it opened, which is a claim nobody
 * has checked. Same law as the room directory above.
 */
export interface RunList {
  asked: boolean;
  loading: boolean;
  entries: RunListEntry[];
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
  /** files being sent up from this machine, by conversation */
  uploads: Record<ID, Upload[]>;
  /** attached files this screen has opened, by attachment id */
  files: Record<ID, OpenFile>;
  /**
   * The open rooms you are NOT in — the answer to "Browse rooms".
   *
   * `asked` is what tells an empty list from an unanswered one: without it the
   * browser would say "no open rooms" the instant it opened, which is a claim
   * nobody has checked yet.
   */
  directory: { asked: boolean; channels: ChannelSummary[] };
  /** who is in one room, with roles and dates, by conversation */
  members: Record<ID, ChannelMember[]>;
  /**
   * WHAT AN AGENT ACTUALLY DID, by run id.
   *
   * Keyed by the record's own id and nothing else, because a `run` frame
   * arrives UNASKED the moment any turn finishes — in a conversation this
   * screen has open, or one it does not. Anything that wants to find a run by
   * job or by agent looks it up through the indexes below, which are built off
   * what arrived rather than off what we happened to request.
   */
  runs: Record<string, RunRecord>;
  /** histories, keyed by `runKey` — "agent:<id>" or "task:<id>" */
  runLists: Record<string, RunList>;
  /**
   * Runs the hub has said are not there.
   *
   * A run you may not read and a run that never existed get the SAME sentence,
   * deliberately, so an id cannot be probed. Both mean one thing to a screen —
   * it is not there — and saying so is better than a disclosure that spins for
   * ever waiting for an answer that already came.
   */
  runsGone: Record<string, true>;
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
    uploads: {}, files: {}, directory: { asked: false, channels: [] }, members: {},
    runs: {}, runLists: {}, runsGone: {},
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

  /* ---------------- what an agent actually did ---------------- */

  /** The one spelling of a history's key. Two spellings is two caches. */
  private runKey(scope: "agent" | "task", id: ID): string {
    return `${scope}:${id}`;
  }

  /** run ids already asked for, so a render cannot ask for the same one twice */
  private runAsked = new Set<string>();

  /** One run in full, if this screen is holding it. */
  run(runId: string): RunRecord | undefined {
    return this.world.runs[runId];
  }

  /** One history, answered or not. Never undefined — an unasked list says so. */
  runsFor(scope: "agent" | "task", id: ID): RunList {
    return this.world.runLists[this.runKey(scope, id)] ?? { asked: false, loading: false, entries: [] };
  }

  /**
   * Ask for one run in full — the steps, the time, the money.
   *
   * Asked ONCE per run for the life of this screen: a record does not change
   * after it is written, and a disclosure that re-asked on every open would put
   * a frame on the wire for every click. A run already pushed here unasked is
   * never asked for at all.
   *
   * A run this person may not read is answered "no such run" — the same
   * sentence an invented id gets, deliberately, so an id cannot be probed. Both
   * mean the same thing to this screen: it is not there.
   */
  askRun(runId: string): void {
    if (this.world.runs[runId] || this.runAsked.has(runId)) return;
    this.runAsked.add(runId);
    this.pendingRunDetail.push(runId);
    this.send({ type: "runDetail", runId });
  }

  /** runs asked for and not yet answered, oldest first — see the `error` frame */
  private pendingRunDetail: string[] = [];

  /**
   * Ask what an agent, or one job, has been doing.
   *
   * By AGENT this is owner-only at the hub, by design — sharing a room with
   * someone's agent shows you the turns it takes there, and is not a licence to
   * read everything it has ever done. Callers must not ask about an agent that
   * is not this person's; the rail simply does not offer it.
   */
  askRuns(scope: "agent" | "task", id: ID, limit?: number): void {
    const key = this.runKey(scope, id);
    const held = this.runsFor(scope, id);
    /* ASKED EVERY TIME THE RAIL OPENS, and only the one already in flight is
       skipped. A history is not a record: it grows with every turn the agent
       takes, so an answer from the last time this screen was opened is out of
       date the moment anything happens. Caching it the way a single record is
       cached showed the owner an agent's work as it stood an hour ago, with the
       job they just watched finish missing from it. */
    if (held.loading) return;
    this.world.runLists = { ...this.world.runLists, [key]: { ...held, loading: true } };
    this.emit();
    this.send(scope === "agent"
      ? { type: "runList", agentId: id, ...(limit ? { limit } : {}) }
      : { type: "runList", taskId: id, ...(limit ? { limit } : {}) });
  }

  /**
   * An agent is gone, so what it did goes with it.
   *
   * The hub forgets an agent's runs when the agent goes. A screen that carried
   * on drawing them would be showing something that no longer exists anywhere
   * else — which is the same class of lie as showing a cost nobody reported.
   */
  private forgetRunsOf(agentId: ID): void {
    const w = this.world;
    const kept: Record<string, RunRecord> = {};
    for (const [id, record] of Object.entries(w.runs)) {
      if (record.agentId !== agentId) kept[id] = record;
    }
    w.runs = kept;
    const { [this.runKey("agent", agentId)]: gone, ...rest } = w.runLists;
    void gone;
    w.runLists = rest;
  }

  /* ---------------- rooms ---------------- */

  /** Ask for the open rooms this person could join. */
  browseChannels(): void {
    this.send({ type: "browseChannels" });
  }

  /** Ask who is in one room. Answered with roles, join dates and who let them in. */
  askMembers(channelId: ID): void {
    this.send({ type: "channelMembers", channelId });
  }

  /* ---------------- attaching a file ---------------- */

  private uploadQueue: Array<{ channelId: ID; localId: string; frame: ClientFrame }> = [];
  /** the one upload the hub is working on — see `attach` for why there is only one */
  private uploading: { channelId: ID; localId: string } | null = null;

  private setUploads(channelId: ID, next: Upload[]): void {
    this.world.uploads = { ...this.world.uploads, [channelId]: next };
  }

  private patchUpload(channelId: ID, localId: string, patch: Partial<Upload>): void {
    const list = this.world.uploads[channelId] ?? [];
    this.setUploads(channelId, list.map(u => (u.localId === localId ? { ...u, ...patch } : u)));
  }

  /**
   * Put one picked file on the hub, ready to be named in a `send`.
   *
   * ONE AT A TIME, deliberately. The `attachment` frame that answers an upload
   * carries no echo of what was asked, and neither does the `error` frame that
   * refuses one — so two uploads in the air at once could not be told apart,
   * and a refusal would be pinned on the wrong file. A queue costs a moment on
   * a second file and buys an answer that is always about the right one.
   */
  attach(channelId: ID, file: File): void {
    const localId = `up_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
    const list = this.world.uploads[channelId] ?? [];
    // The same ceilings the hub holds, asked here first so a 10 MB file is
    // refused in the moment it is picked rather than after it has been read,
    // encoded and sent. `validateAttachment` is the hub's own function — there
    // is no second copy of the rule in this app.
    const already = list.filter(u => u.state !== "failed").length;
    if (already >= ATTACHMENT_LIMITS.perMessage) {
      this.notify(`that's the most files one message can carry (${ATTACHMENT_LIMITS.perMessage})`);
      return;
    }
    const refusal = validateAttachment(file.name, file.size);
    if (refusal) {
      this.setUploads(channelId,
        [...list, { localId, name: file.name, size: file.size, state: "failed", error: refusal }]);
      this.emit();
      return;
    }
    this.setUploads(channelId,
      [...list, { localId, name: file.name, size: file.size, state: "sending" }]);
    this.emit();

    const reader = new FileReader();
    reader.onerror = () => {
      this.patchUpload(channelId, localId, { state: "failed", error: "that file could not be read" });
      this.emit();
    };
    reader.onload = () => {
      const asUrl = String(reader.result ?? "");
      const comma = asUrl.indexOf(",");
      if (comma < 0) {
        this.patchUpload(channelId, localId, { state: "failed", error: "that file could not be read" });
        this.emit();
        return;
      }
      this.uploadQueue.push({
        channelId, localId,
        frame: {
          type: "uploadAttachment", channelId, name: file.name,
          dataBase64: asUrl.slice(comma + 1), mime: file.type || undefined,
        },
      });
      this.pumpUploads();
    };
    reader.readAsDataURL(file);
  }

  private pumpUploads(): void {
    if (this.uploading) return;
    const next = this.uploadQueue.shift();
    if (!next) return;
    this.uploading = { channelId: next.channelId, localId: next.localId };
    this.send(next.frame);
  }

  /** Take one picked file back out before the message is sent. */
  dropUpload(channelId: ID, localId: string): void {
    this.uploadQueue = this.uploadQueue.filter(q => q.localId !== localId);
    this.setUploads(channelId, (this.world.uploads[channelId] ?? []).filter(u => u.localId !== localId));
    this.emit();
  }

  /** The ids to name in `send` — only the files that really landed. */
  uploadIds(channelId: ID): ID[] {
    return (this.world.uploads[channelId] ?? [])
      .filter(u => u.state === "done" && u.attachmentId)
      .map(u => u.attachmentId!);
  }

  /** The tray is emptied once its files have gone out with a message. */
  clearUploads(channelId: ID): void {
    if (!this.world.uploads[channelId]) return;
    const { [channelId]: gone, ...rest } = this.world.uploads;
    void gone;
    this.world.uploads = rest;
    this.emit();
  }

  /* ---------------- getting an attached file back ---------------- */

  /** where the hub's own HTTP lives — derived from the socket, never stored twice */
  private hubHttp(): string {
    return RELAY_URL.replace(/^ws/, "http");
  }

  private ticketWaiters: Array<{
    attachmentId: ID;
    resolve: (v: { url: string; expiresAt: number }) => void;
    reject: (e: Error) => void;
  }> = [];

  /**
   * Ask for permission to fetch ONE file, ONCE.
   *
   * Asked at the moment of the click and never at render: a ticket minted when
   * a message scrolls into view is dead thirty seconds later, and a screenful
   * of messages would mint more of them than the hub will hold.
   */
  private mintTicket(attachmentId: ID): Promise<{ url: string; expiresAt: number }> {
    return new Promise((resolve, reject) => {
      const waiter = { attachmentId, resolve, reject };
      this.ticketWaiters.push(waiter);
      this.send({ type: "attachmentTicket", attachmentId });
      setTimeout(() => {
        const i = this.ticketWaiters.indexOf(waiter);
        if (i < 0) return;
        this.ticketWaiters.splice(i, 1);
        reject(new Error("the hub didn't answer — try again"));
      }, 15000);
    });
  }

  /**
   * One ticket to one file, as a whole URL.
   *
   * The same mint the buttons use, exposed so the QA suite can fetch a file
   * back over the real HTTP path and check the bytes against what it sent —
   * "a link appeared" is not evidence that a file came back.
   */
  async ticketFor(attachmentId: ID): Promise<{ url: string; expiresAt: number }> {
    const t = await this.mintTicket(attachmentId);
    return { url: this.hubHttp() + t.url, expiresAt: t.expiresAt };
  }

  /** The attachment ids whose bytes this screen is currently holding. */
  openFileIds(): ID[] {
    return Object.keys(this.world.files);
  }

  private setFile(id: ID, next: OpenFile): void {
    this.world.files = { ...this.world.files, [id]: next };
    this.emit();
  }

  /**
   * Get one attached file's bytes and keep them for the life of this screen.
   *
   * The rules that are not negotiable (§9.3):
   *  - ONE fetch per ticket. The first request spends it.
   *  - A `404` is the ONLY failure the hub reports, and it means "spent, expired
   *    or no longer yours". The recovery is a NEW ticket, not an error message —
   *    so that is what happens here, once, before anything is said to anyone.
   *  - Because the hub answers `no-store`, this cache IS the cache. A second
   *    click on the same file must not re-ticket.
   */
  async openFile(a: Attachment): Promise<void> {
    const held = this.world.files[a.id];
    if (held && (held.state === "ready" || held.state === "opening")) return;
    this.setFile(a.id, { state: "opening" });

    const fetchOnce = async (): Promise<Response> => {
      const t = await this.mintTicket(a.id);
      return fetch(this.hubHttp() + t.url);
    };

    try {
      /**
       * ONE ROUTE, whatever address the hub is on.
       *
       * There used to be a second one here: when the hub answered from its own
       * origin, the page could not READ a cross-origin response, so the ticket
       * was handed to an `<img>` instead of fetched. The hub now sends the
       * cross-origin headers on the download (`chat-basics-handoff.md` §9.9),
       * so that branch was a workaround for a problem that no longer exists —
       * and a second route is a second set of behaviour to get right. Every
       * file now takes the intended path: fetch, blob, revoke on close.
       */
      let res = await fetchOnce();
      // 404 means the ticket was spent or has expired. Ask for another and
      // try once more — showing a person an error here would be showing them
      // a problem the app can fix by itself.
      if (res.status === 404) res = await fetchOnce();
      if (!res.ok) {
        this.setFile(a.id, { state: "failed", error: "that link has expired — open the file again" });
        return;
      }
      this.setFile(a.id, { state: "ready", url: URL.createObjectURL(await res.blob()) });
    } catch (err) {
      this.setFile(a.id, {
        state: "failed",
        error: (err as Error).message || "that file could not be opened",
      });
    }
  }

  /**
   * Save an attached file — the browser's (or Electron's) own download path.
   *
   * A download is a navigation, not a read, so it needs no blob and nothing to
   * free afterwards. The ticket is minted here, at the click.
   */
  async saveFile(a: Attachment): Promise<void> {
    this.setFile(a.id, { state: "opening" });
    try {
      const t = await this.mintTicket(a.id);
      const link = document.createElement("a");
      link.href = this.hubHttp() + t.url;
      link.download = a.name;
      link.rel = "noopener";
      document.body.appendChild(link);
      link.click();
      link.remove();
      this.setFile(a.id, { state: "ready", url: link.href, direct: true });
    } catch (err) {
      this.setFile(a.id, { state: "failed", error: (err as Error).message });
    }
  }

  /** May this file be drawn where it sits, or must it be saved first? */
  canShowInline(a: Attachment): boolean {
    return isInlineViewable(a.name);
  }

  /**
   * Let one opened file go.
   *
   * A `blob:` URL is a reference the page holds until it is revoked, so a
   * screen that opened a hundred pictures and never called this would be
   * holding a hundred pictures. Called when the message unmounts.
   */
  closeFile(id: ID): void {
    const held = this.world.files[id];
    if (!held) return;
    if (held.url && !held.direct) URL.revokeObjectURL(held.url);
    const { [id]: gone, ...rest } = this.world.files;
    void gone;
    this.world.files = rest;
    this.emit();
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
        // Everything derived from the last connection goes with it. Blob URLs
        // are freed rather than dropped, or a reconnect would leak every
        // picture the last session opened.
        for (const id of Object.keys(w.files)) {
          const f = w.files[id];
          if (f.url && !f.direct) URL.revokeObjectURL(f.url);
        }
        w.files = {};
        w.members = {};
        w.directory = { asked: false, channels: [] };
        // Records belonged to the last connection too. Keeping them would mean
        // drawing an agent's work from a world this screen is no longer in.
        w.runs = {};
        w.runLists = {};
        w.runsGone = {};
        this.runAsked.clear();
        this.pendingRunDetail = [];
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
        // A room arriving for the FIRST time is a room we just joined, so the
        // browse list — which only ever shows rooms you are not in — has gone
        // stale. Only on arrival: a topic change must not reset it.
        if (i < 0) w.directory = { asked: false, channels: [] };
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
        this.forgetRunsOf(frame.agentId);
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
        /* A refusal is not correlated to what was asked, so the two things
           WAITING for an answer have to be told: the one upload in the air and
           the oldest unanswered ticket. Both are held one-at-a-time for exactly
           this reason, so neither can be pinned on the wrong file. Nothing else
           changes — the toast still says the hub's own sentence. */
        if (this.uploading) {
          this.patchUpload(this.uploading.channelId, this.uploading.localId,
            { state: "failed", error: frame.error });
          this.uploading = null;
          this.pumpUploads();
        }
        if (this.ticketWaiters.length > 0) {
          this.ticketWaiters.shift()!.reject(new Error(frame.error));
        }
        // Same discipline for a run that was asked for and refused: the oldest
        // unanswered one is told, so a disclosure says "it isn't there" instead
        // of waiting for ever on an answer that has already been given.
        if (frame.error === "no such run" && this.pendingRunDetail.length > 0) {
          w.runsGone = { ...w.runsGone, [this.pendingRunDetail.shift()!]: true };
        }
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
      case "run":
        // Unasked or asked, new or already held — keyed by the record's OWN id,
        // so a run from a conversation this screen never opened still lands
        // somewhere findable rather than being dropped for not being expected.
        w.runs = { ...w.runs, [frame.record.id]: frame.record };
        this.pendingRunDetail = this.pendingRunDetail.filter(id => id !== frame.record.id);
        break;
      case "runs": {
        // The frame echoes back WHICH question it answers, so two lists in
        // flight cannot be mistaken for each other. One with neither is an
        // answer to nothing and is left alone.
        const key = frame.agentId ? `agent:${frame.agentId}`
          : frame.taskId ? `task:${frame.taskId}` : undefined;
        if (key) {
          w.runLists = { ...w.runLists, [key]: { asked: true, loading: false, entries: frame.runs } };
        }
        break;
      }
      case "attachment": {
        // The answer to the ONE upload in the air (see `attach`). It carries no
        // echo of what was asked, which is exactly why only one is ever asked.
        const up = this.uploading;
        if (up) {
          this.patchUpload(up.channelId, up.localId,
            { state: "done", attachmentId: frame.attachment.id });
          this.uploading = null;
          this.pumpUploads();
        }
        break;
      }
      case "attachmentTicket": {
        const i = this.ticketWaiters.findIndex(w => w.attachmentId === frame.attachmentId);
        if (i >= 0) {
          const [waiter] = this.ticketWaiters.splice(i, 1);
          waiter.resolve({ url: frame.url, expiresAt: frame.expiresAt });
        }
        break;
      }
      case "channelDirectory":
        w.directory = { asked: true, channels: frame.channels };
        break;
      case "channelMembers":
        // Only the list of who is in the room NOW is kept here. An `at` list is
        // an answer to one question about one message, and holding it under the
        // room's id would quietly overwrite the room's real membership.
        if (frame.at === undefined) {
          w.members = { ...w.members, [frame.channelId]: frame.members };
        }
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
        const { [frame.channelId]: goneMembers, ...restMembers } = w.members;
        void goneMembers;
        w.members = restMembers;
        const { [frame.channelId]: goneUploads, ...restUploads } = w.uploads;
        void goneUploads;
        w.uploads = restUploads;
        // A room you just left may now be one you could join, so the browser's
        // list is no longer an answer to anything.
        w.directory = { asked: false, channels: [] };
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
