// Renderer-side relay client: one WebSocket, one mutable world, subscribers.
import {
  ActivityRecord, AgentDef, AgentPresenceState, AgentStatus, Approval, Attachment, ATTACHMENT_LIMITS, Channel,
  ChannelMember, ChannelSummary, ClientFrame, HarnessState, ID, isInlineViewable, Message,
  Project, ProjectItem, RunListEntry, RunRecord, SearchHit, ServerFrame, Task, UnreadEntry, User,
  validateAttachment, validateProjectText, validateRepo,
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
  /**
   * CAN THIS AGENT ACTUALLY BE USED RIGHT NOW — the hub's answer, never ours.
   *
   * ABSENT IS A REAL ANSWER AND IT IS NOT "FINE". A missing entry means nobody
   * has reported on that agent yet, which is why this is a sparse map rather
   * than a map with a cheerful default: the screen has to be able to tell "we
   * have not looked" apart from "it is ready", and a default would erase the
   * difference at the only place it matters.
   */
  presence: Record<ID, AgentPresenceState>;
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
  /**
   * THE REPOSITORIES THIS PERSON HAS CONNECTED, and what is open in each.
   *
   * `asked` is the same law the room directory and the run histories already
   * follow: an empty list nobody has requested is not "you have no projects",
   * it is "we have not looked". Without it the Projects screen would greet a
   * person with "connect your first repository" for the moment between opening
   * and the hub answering — a claim nobody had checked, about the one screen
   * whose whole job is to say what GitHub holds.
   */
  projects: { asked: boolean; list: Project[] };
  /**
   * One project's pull requests and issues, by project id.
   *
   * A CACHE OF SOMEBODY ELSE'S TRUTH twice over: the hub holds GitHub's answer
   * as of the last time the engine looked, and this holds the hub's. So the
   * screen never says "no open pull requests" off the back of an unanswered
   * question — `asked` is what tells the two apart, and `Project.syncedAt` is
   * what says how old the answer is.
   */
  projectItems: Record<ID, { asked: boolean; items: ProjectItem[] }>;
}

type Listener = () => void;

/**
 * ONE QUESTION THIS APP ASKED THE HUB, AND WHAT BECOMES OF THE ANSWER.
 *
 * `answers` recognises the reply. `answered` is what to do with it — a reply is
 * applied BY THE REQUEST THAT ASKED FOR IT, never by a handler that assumes
 * somebody must still want it. `refused` is what to do with the hub's "no".
 * `lost` is the same question with no answer at all.
 */
interface Asked {
  /** what was asked — for reading a queue in a debugger, and for the tests */
  kind: ClientFrame["type"];
  /** does this frame from the hub answer THIS question? */
  answers?: (frame: ServerFrame) => boolean;
  answered?: (frame: ServerFrame) => void;
  /** the hub said no, in the hub's own words */
  refused?: (why: string) => void;
  /** nothing came back — the net under the whole thing, so a queue cannot jam */
  lost?: () => void;
}

/**
 * How long the hub gets before a question stops waiting for it.
 *
 * The hub is on this machine, over loopback, and answers a frame the moment it
 * reads it. Twenty seconds is not a guess at how long an answer takes — it is
 * long enough that anything arriving after it is certainly about something
 * else. A question that times out is TOLD (`lost`), never quietly dropped.
 */
const ANSWER_WINDOW_MS = 20_000;

/**
 * The most unread messages the hub will ever count in one conversation.
 *
 * `apps/relay/src/store.ts` — `unreadFor` reads at most this many rows, so a
 * count that reaches it means "this many or more" and NOT "exactly this many".
 * Printed as an exact number it was a claim nobody had checked; `unreadLabel`
 * below is the one place that decides how such a number is said.
 */
export const UNREAD_CEILING = 1000;

/**
 * Say a count that has a ceiling, honestly.
 *
 * Below the ceiling the number is the truth. At it, the only true thing that
 * can be said is "more than the ones we could count".
 */
export function unreadLabel(n: number): string {
  return n >= UNREAD_CEILING ? `${UNREAD_CEILING - 1}+` : String(n);
}

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
    messages: {}, agentStatus: {}, presence: {}, tasks: [], approvals: [], activity: [],
    pages: {}, threads: {}, unread: {}, prepended: 0,
    uploads: {}, files: {}, directory: { asked: false, channels: [] }, members: {},
    runs: {}, runLists: {}, runsGone: {},
    projects: { asked: false, list: [] }, projectItems: {},
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
    // Questions asked of the LAST connection will never be answered by this
    // one. They are told so, rather than left on a list where a refusal
    // belonging to this connection could be handed to one of them.
    const orphaned = this.asked;
    this.asked = [];
    for (const a of orphaned) a.lost?.();
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

  /**
   * WHAT WE ASKED, IN THE ORDER WE ASKED IT.
   *
   * An `error` frame carries no echo of the question it refuses, so the only
   * way to know whose refusal it is, is to know what is still outstanding. The
   * hub makes that knowable: it reads one frame at a time and finishes
   * answering it before it reads the next (`apps/relay/src/server.ts` —
   * `handleFrame` is synchronous from top to bottom, and an `error` is only
   * ever sent back down the connection whose own frame caused it). So answers
   * come back in the order the questions went out, and a refusal belongs to the
   * OLDEST question still waiting.
   *
   * THAT IS ONLY TRUE IF EVERY REFUSABLE QUESTION IS IN HERE. It used to be
   * uploads and tickets and nothing else, so a refusal that belonged to
   * something else in the app — editing a message you did not write — was
   * pinned on the one upload in the air: the upload flipped to failed with a
   * sentence about someone else's message, and a file that had reached the hub
   * perfectly well could never be attached to anything. The list is complete
   * now, and stays complete, because `send` is the only door out of this app
   * and `send` is this.
   *
   * The same list is what stops a LATE answer being applied to a question
   * nobody is asking any more: an answer is handed to the request that asked
   * for it, and if that request has been called off the answer goes nowhere.
   */
  private asked: Asked[] = [];

  /**
   * Ask the hub something and remember that we asked.
   *
   * Returns whether it actually went. A frame written to a socket that is not
   * open was never asked, so it must never be waited on.
   */
  private ask(frame: ClientFrame, waiting: Omit<Asked, "kind"> = {}): boolean {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    // `hello` is the one frame asked before there is a conversation to have.
    // Its refusals are about the connection itself and are handled as such.
    if (frame.type === "hello") return true;
    const entry: Asked = { kind: frame.type, ...waiting };
    this.asked.push(entry);
    setTimeout(() => {
      const i = this.asked.indexOf(entry);
      if (i < 0) return;
      this.asked.splice(i, 1);
      entry.lost?.();
    }, ANSWER_WINDOW_MS);
    return true;
  }

  /**
   * Hand one answer to the question that asked for it.
   *
   * Everything asked BEFORE the question this answers has been answered too —
   * the hub cannot answer a later question first — so those stop waiting here,
   * without refusal and without complaint. A frame that answers nothing on the
   * list is unasked news (a message, a reaction, somebody joining) and settles
   * nothing.
   */
  private settle(frame: ServerFrame): void {
    const i = this.asked.findIndex(a => a.answers !== undefined && a.answers(frame));
    if (i < 0) return;
    const settled = this.asked.splice(0, i + 1);
    settled[settled.length - 1].answered?.(frame);
  }

  send(frame: ClientFrame): void {
    this.ask(frame);
  }

  /**
   * THE ONE ANSWER TO "WHAT HAPPENS TO WHAT HE TYPED WHEN A FORM REFUSES IT".
   *
   * WHY THIS EXISTS. Phase 5 (A3) typed 100,000 characters into the composer
   * and pressed Enter. The box emptied, and only THEN did the hub answer "that
   * message is too long (max 40000 characters)". Every word was gone and he
   * could not shorten what he had written. Two screens away the agent-name box
   * and the personality box get it exactly right — they say why and keep the
   * text — so the app already knew how, in one place and not the other. Three
   * boxes were each deciding for themselves.
   *
   * THE RULE, and there is only one: nothing is ever cleared before it is known
   * to have been ACCEPTED. So the check runs FIRST, here, using the hub's own
   * validator imported rather than re-spelled; a refusal is said out loud and
   * `false` comes back, and the caller's box is untouched because the caller
   * only ever clears on `true`.
   *
   * The hub is still the boundary and still checks everything again — this does
   * not replace it, it just means the ordinary refusals happen before his words
   * can be thrown away.
   *
   * @param problem the plain-words refusal, or null when there is nothing wrong
   * @param say     where to print it; the toast unless the form has its own line
   * @returns true only if the frame really went
   */
  submit(problem: string | null, frame: ClientFrame, say?: (why: string) => void): boolean {
    if (this.refused(problem, say)) return false;
    this.send(frame);
    return true;
  }

  /**
   * The judgement half of `submit`, on its own.
   *
   * A form that needs `ask` (because it wants the HUB'S refusal routed back to
   * its own line rather than to the toast) cannot call `submit`, and without
   * this it would have to re-decide what a refusal means — which is exactly how
   * three boxes ended up with three different answers. So the decision lives
   * here, once, and both routes ask it.
   *
   * @returns true when this was refused and the caller must change NOTHING
   */
  refused(problem: string | null, say?: (why: string) => void): boolean {
    if (!problem) return false;
    (say ?? ((why: string) => this.notify(why)))(problem);
    return true;
  }

  /**
   * What has been asked and not yet answered, oldest first.
   *
   * Exposed because the one thing that matters about the ledger cannot be seen
   * on screen: that a refusal arrived WHILE something else was still waiting.
   * A test that only checked the outcome would pass just as happily when the
   * two never overlapped at all.
   */
  outstanding(): string[] {
    return this.asked.map(a => a.kind);
  }

  /** how many frames of each kind the hub has sent — evidence that an answer really arrived */
  private seen: Record<string, number> = {};

  framesSeen(): Record<string, number> {
    return { ...this.seen };
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

  /**
   * WHICH SEARCH THIS SCREEN IS WAITING FOR.
   *
   * Bumped when a new one is asked and again when one is called off, so an
   * answer can tell whether the question that produced it is still being asked.
   * A search cleared while its results were still coming back used to be
   * brought back to life by them, hits and all, and the ghost hits were
   * clickable. An answer to a question nobody is asking any more goes nowhere.
   */
  private searchEpoch = 0;

  search(query: string, filters: { channelId?: ID; authorId?: ID } = {}): void {
    const epoch = ++this.searchEpoch;
    this.world.search = {
      query, running: true,
      results: this.world.search?.results ?? [],
      hasMore: false,
      answered: this.world.search?.answered ?? "",
    };
    this.emit();
    /** the answer only lands if this is still the search on screen */
    const stale = (): boolean => this.searchEpoch !== epoch;
    const stopRunning = (): void => {
      if (stale() || !this.world.search) return;
      this.world.search = { ...this.world.search, running: false };
      this.emit();
    };
    this.ask({ type: "search", query, ...filters, limit: 50 }, {
      answers: f => f.type === "searchResults",
      answered: f => {
        if (stale() || f.type !== "searchResults") return;
        this.world.search = {
          query, answered: f.query, running: false,
          results: f.results, hasMore: f.hasMore,
        };
      },
      // A refused search stops spinning. The hub's own sentence is already on
      // screen through `lastError` — saying it twice would not make it truer.
      refused: stopRunning,
      lost: stopRunning,
    });
  }

  clearSearch(): void {
    this.searchEpoch++;
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
    /* "It isn't there" used to be recognised by reading the hub's sentence and
       matching the words "no such run". That was a patch: it worked only while
       the hub kept spelling it that way, and only for refusals it had been
       taught. A refusal is now recognised by WHOSE it is (see `asked`), so any
       reason this run cannot be shown ends the disclosure's wait. */
    const gone = (): void => {
      this.world.runsGone = { ...this.world.runsGone, [runId]: true };
      this.emit();
    };
    this.ask({ type: "runDetail", runId }, {
      answers: f => f.type === "run" && f.record.id === runId,
      refused: gone,
      lost: gone,
    });
  }

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

  /* ---------------- projects: a repository, its pull requests, its issues ----------------
   *
   * ONE OWNER FOR "WHAT IS IN THIS REPOSITORY", and it is the hub. Nothing in
   * this app reaches GitHub, guesses a default branch, or invents a state for a
   * pull request; every value drawn on the Projects screen arrived on a frame.
   * That is the same split the hub keeps for the same reason — the part a guest
   * can talk to must never be the part that can reach out of the machine.
   */

  /** One project's lists, answered or not. Never undefined — an unasked list says so. */
  itemsFor(projectId: ID): { asked: boolean; items: ProjectItem[] } {
    return this.world.projectItems[projectId] ?? { asked: false, items: [] };
  }

  /**
   * Ask for the repositories this person has connected.
   *
   * Asked EVERY time the screen opens, not once: a project gains a
   * `defaultBranch`, a `syncedAt` and sometimes a `problem` the moment the
   * engine looks at GitHub, so a list cached from the last visit would show a
   * repository as never-looked-at long after it had been.
   */
  askProjects(): void {
    this.ask({ type: "projects" }, {
      answers: f => f.type === "projects",
      answered: f => {
        if (f.type !== "projects") return;
        this.world.projects = { asked: true, list: f.projects };
      },
      /* A refusal and a silence both mean the same thing here: we asked and got
         no list. The screen must not be left spinning on either, and the hub's
         own sentence is already on screen through `lastError`. */
      refused: () => { this.world.projects = { ...this.world.projects, asked: true }; this.emit(); },
      lost: () => { this.world.projects = { ...this.world.projects, asked: true }; this.emit(); },
    });
  }

  /** Ask for one project's pull requests and issues, as of the last look. */
  askProjectItems(projectId: ID): void {
    const settled = (): void => {
      this.world.projectItems = {
        ...this.world.projectItems,
        [projectId]: { ...this.itemsFor(projectId), asked: true },
      };
      this.emit();
    };
    this.ask({ type: "projectItems", projectId }, {
      answers: f => f.type === "projectItems" && f.projectId === projectId,
      answered: f => {
        if (f.type !== "projectItems") return;
        this.world.projectItems = {
          ...this.world.projectItems,
          [f.projectId]: { asked: true, items: f.items },
        };
      },
      refused: settled,
      lost: settled,
    });
  }

  /**
   * "LOOK AT GITHUB NOW" for one project.
   *
   * This app still never reaches GitHub. It asks the hub, the hub asks the
   * engine on this computer, and the engine runs `gh` with the sign-in that is
   * already here. Everything that comes back arrives on the ordinary `project`
   * and `projectItems` frames, so there is nothing to apply here.
   *
   * The BUTTON'S STATE is not invented either: the hub marks the project
   * `looking` while a look is in flight and clears it when the engine answers
   * or stops answering. A spinner this app started itself would have no way to
   * end. The refusal is handed back so the screen can print the hub's own
   * sentence — "nothing is running on this computer to ask GitHub" is the one a
   * person can actually act on.
   */
  lookAtProject(projectId: ID, onRefused?: (why: string) => void): void {
    const sent = this.ask({ type: "syncProject", projectId }, {
      answers: f => f.type === "project" && f.project.id === projectId,
      refused: why => onRefused?.(why),
      lost: () => onRefused?.("the hub did not answer — is it still running?"),
    });
    if (!sent) onRefused?.("not connected to the hub yet");
  }

  /**
   * Connect a repository, named the way `gh` names one.
   *
   * The refusal is the hub's own sentence, handed back to the caller so the
   * form can print it where the person is looking instead of only in the toast
   * that floats above every screen.
   */
  connectProject(
    repo: string,
    extra: { name?: string; description?: string; channelId?: ID } = {},
    onRefused?: (why: string) => void,
  ): void {
    /* Checked HERE, in the store, so no form can forget to — and through the
       same `refused` the composer and every other box goes through, so there is
       one answer to "what happens to what he typed when it is refused". */
    if (this.refused(validateRepo(repo) ?? validateProjectText(extra.name, extra.description),
      onRefused)) return;
    const sent = this.ask({ type: "connectProject", repo, ...extra }, {
      answers: f => f.type === "project",
      refused: why => onRefused?.(why),
      lost: () => onRefused?.("the hub did not answer — is it still running?"),
    });
    if (!sent) onRefused?.("not connected to the hub yet");
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
    const up = { channelId: next.channelId, localId: next.localId };
    this.uploading = up;
    /* Only ever about THIS file. Both of these are reached from the request
       ledger, so they are called for this upload's own answer and for nothing
       else — an unrelated refusal cannot get in here at all. */
    const failed = (why: string): void => {
      if (this.uploading !== up) return;
      this.uploading = null;
      this.patchUpload(up.channelId, up.localId, { state: "failed", error: why });
      this.emit();
      this.pumpUploads();
    };
    const sent = this.ask(next.frame, {
      answers: f => f.type === "attachment",
      answered: f => {
        if (this.uploading !== up || f.type !== "attachment") return;
        this.uploading = null;
        this.patchUpload(up.channelId, up.localId,
          { state: "done", attachmentId: f.attachment.id });
        this.pumpUploads();
      },
      refused: failed,
      lost: () => failed("the hub never answered about this file — take it off and try again"),
    });
    if (!sent) failed("there's no connection to the hub — take the file off and try again");
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

  /**
   * How many files have been READ and are waiting their turn on the wire.
   *
   * Not the same as "a file is in the tray": a tray tile appears the moment a
   * file is picked, long before it has been read. Only a file that is already
   * queued will be put on the wire the instant the one ahead of it is answered
   * — which is the exact moment a refusal meant for something else used to land
   * on it — so this is what a test of that has to wait for.
   */
  queuedUploads(): number {
    return this.uploadQueue.length;
  }

  /** How many files in this conversation's tray are still on their way up. */
  uploadsInFlight(channelId: ID): number {
    return (this.world.uploads[channelId] ?? []).filter(u => u.state === "sending").length;
  }

  /**
   * MAY THIS MESSAGE GO YET, AND WITH WHICH FILES?
   *
   * The one owner of that question, so every way of sending — the button, the
   * Enter key, a thread's own box — gets the same answer. Pressing Enter used
   * to take the files that had landed, empty the tray, and send: a file still
   * going up was thrown away without a word, and it finished uploading into
   * nothing. Nothing is ever discarded in silence; a message that cannot go yet
   * is refused in a sentence, and the file stays exactly where it is.
   */
  readyToSend(channelId: ID, hasWords: boolean): { ok: boolean; ids: ID[]; why?: string } {
    const waiting = this.uploadsInFlight(channelId);
    if (waiting > 0) {
      return {
        ok: false, ids: [],
        why: waiting === 1
          ? "that file is still going up — give it a moment, or take it off"
          : `those ${waiting} files are still going up — give them a moment, or take them off`,
      };
    }
    const ids = this.uploadIds(channelId);
    if (!hasWords && ids.length === 0) return { ok: false, ids: [] };
    return { ok: true, ids };
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

  /**
   * Ask for permission to fetch ONE file, ONCE.
   *
   * Asked at the moment of the click and never at render: a ticket minted when
   * a message scrolls into view is dead thirty seconds later, and a screenful
   * of messages would mint more of them than the hub will hold.
   *
   * There used to be a separate queue of waiters here, and an `error` frame
   * rejected the OLDEST of them whatever the error was actually about. It goes
   * through the one request ledger now (see `asked`), which knows whose refusal
   * a refusal is — and matches the ticket that comes back to the file it is for.
   */
  private mintTicket(attachmentId: ID): Promise<{ url: string; expiresAt: number }> {
    return new Promise((resolve, reject) => {
      let done = false;
      const once = (fn: () => void): void => { if (!done) { done = true; fn(); } };
      const sent = this.ask({ type: "attachmentTicket", attachmentId }, {
        answers: f => f.type === "attachmentTicket" && f.attachmentId === attachmentId,
        answered: f => once(() => {
          if (f.type === "attachmentTicket") resolve({ url: f.url, expiresAt: f.expiresAt });
        }),
        refused: why => once(() => reject(new Error(why))),
        lost: () => once(() => reject(new Error("the hub didn't answer — try again"))),
      });
      if (!sent) once(() => reject(new Error("there's no connection to the hub — try again in a moment")));
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
   * HOW MANY PLACES ON SCREEN ARE SHOWING EACH OPENED FILE.
   *
   * The same message is drawn in more than one place at once — in the
   * conversation and again in an open thread — and each copy showed the same
   * picture from the same `blob:` URL. Whichever copy went away first used to
   * revoke it, and the picture still on screen in the other one turned into a
   * broken image: closing a thread panel wiped a picture out of the room
   * behind it.
   *
   * Ownership of a held thing cannot be "whoever let go of it first". Every
   * copy that shows a file takes a hold; the bytes are freed when the LAST one
   * lets go, and not before.
   */
  private fileHolders = new Map<ID, number>();

  /** "I am showing this file, so keep its bytes alive." Paired with `releaseFile`. */
  holdFile(id: ID): void {
    this.fileHolders.set(id, (this.fileHolders.get(id) ?? 0) + 1);
  }

  /** "I have stopped showing it." The bytes go only when nobody is left holding them. */
  releaseFile(id: ID): void {
    const left = (this.fileHolders.get(id) ?? 0) - 1;
    if (left > 0) { this.fileHolders.set(id, left); return; }
    this.fileHolders.delete(id);
    this.closeFile(id);
  }

  /** how many places are showing one file — the QA suite asks, so the count is provable */
  holdersOf(id: ID): number {
    return this.fileHolders.get(id) ?? 0;
  }

  /**
   * Let one opened file go, everywhere, now.
   *
   * This is what "Hide" means, and it is a DELIBERATE act: the picture goes
   * from every place it was showing, because the file itself is dropped from
   * the world and no copy has anything left to draw. A copy merely going off
   * screen is not this — that is `releaseFile`, which waits for the last one.
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
    this.seen[frame.type] = (this.seen[frame.type] ?? 0) + 1;
    /* Hand this to whatever asked for it, FIRST — a reply is applied by the
       request that wanted it, and one nobody is waiting for any more is not
       applied at all. Refusals are the exception and are matched below, where
       the sentence they carry can also be put on screen. */
    if (frame.type !== "error") this.settle(frame);
    switch (frame.type) {
      case "welcome": {
        w.connected = true;
        w.authFailed = false;
        w.me = frame.state.me;
        w.users = frame.state.users;
        w.agents = frame.state.agents;
        w.channels = frame.state.channels;
        w.agentStatus = frame.state.agentStatus;
        // A hub from before presence existed sends nothing here. Empty is the
        // honest landing place: every row then says "we have not looked yet"
        // rather than a green dot nobody stood behind.
        w.presence = frame.state.presence ?? {};
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
        // Projects belonged to the last connection too, and `asked` goes back
        // to false with them: this world has not asked anything yet, so the
        // screen must say "looking" rather than "you have none".
        w.projects = { asked: false, list: [] };
        w.projectItems = {};
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
      case "agentDeleted": {
        w.agents = w.agents.filter(a => a.id !== frame.agentId);
        // a deleted agent's presence is not a fact about anything any more
        const { [frame.agentId]: _gone, ...rest } = w.presence;
        w.presence = rest;
        this.forgetRunsOf(frame.agentId);
        break;
      }
      case "agentStatus":
        w.agentStatus = { ...w.agentStatus, [frame.agentId]: frame.status };
        // The SAME frame carries both halves, so the lamp and the words on the
        // row can never drift apart the way two frames would let them.
        w.presence = {
          ...w.presence,
          [frame.agentId]: {
            agentId: frame.agentId, status: frame.status,
            presence: frame.presence, reason: frame.reason, updatedAt: Date.now(),
          },
        };
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
        /* Applied by the search that asked for it (see `search`), and by
           nothing else. A results frame for a search that has been cleared has
           nobody to give it to, so it is dropped here — which is the whole
           point: it used to land unconditionally and bring a search the reader
           had already closed back onto the screen, hits and all. */
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
      case "error": {
        w.lastError = { text: frame.error, ts: Date.now() };
        /* WHOSE REFUSAL IS THIS? The oldest question still waiting, and only
           that one — see `asked`. Everything asked before it has already been
           answered, and everything asked after it has not been read yet. An
           unrelated refusal therefore cannot reach an upload, a ticket or a
           disclosure that had nothing to do with it. The toast above still says
           the hub's own sentence, whoever the refusal turns out to belong to. */
        this.asked.shift()?.refused?.(frame.error);
        // A refusal that arrives before we were ever let in is a FAILED JOIN:
        // send the person back to the welcome screen, where the reason is
        // visible, instead of leaving them staring at an empty workspace.
        if (frame.error === "bad token" || !w.me) w.authFailed = true;
        break;
      }
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
      // Both of these are the answer to one particular question and are applied
      // by the question that asked (see `pumpUploads` and `mintTicket`). One
      // that answers nothing outstanding is not ours to act on.
      case "attachment":
      case "attachmentTicket":
        break;
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
      /* Projects. These four used to be dropped with a comment saying the
         Projects screen would claim them one day. It has. */
      case "project": {
        /* A `project` frame arrives UNASKED as well as in answer: connecting a
           repository, renaming it, and the engine reporting back what it found
           on GitHub all send the same frame to every window this person has
           open. So it is applied here rather than by whoever asked — and the
           list is marked `asked`, because a project we are holding is proof the
           hub has talked to us about projects. */
        const list = w.projects.list;
        const i = list.findIndex(p => p.id === frame.project.id);
        const next = i >= 0
          ? list.map(p => (p.id === frame.project.id ? frame.project : p))
          : [...list, frame.project];
        w.projects = { asked: true, list: next };
        break;
      }
      case "projects":
        // Applied by `askProjects`, which is the only thing that asks. A list
        // arriving for a question nobody is asking any more goes nowhere.
        break;
      case "projectForgotten": {
        w.projects = {
          ...w.projects,
          list: w.projects.list.filter(p => p.id !== frame.projectId),
        };
        // Its lists go with it, exactly as they do in the hub. Keeping them
        // would leave this screen able to draw pull requests for a repository
        // it is no longer connected to.
        const { [frame.projectId]: goneItems, ...restItems } = w.projectItems;
        void goneItems;
        w.projectItems = restItems;
        break;
      }
      case "projectItems":
        /* Pushed UNASKED every time the engine re-syncs a project, as well as
           in answer to `askProjectItems`. Applied unconditionally for the same
           reason `read` is: this frame is how a window finds out that GitHub
           moved underneath it. */
        w.projectItems = {
          ...w.projectItems,
          [frame.projectId]: { asked: true, items: frame.items },
        };
        break;
      // ENGINE-ONLY RECEIPT, and it is right that the screen drops it. When an
      // agent asks mid-run "may I push this branch?", the hub answers the
      // ENGINE with the id of the card it just minted, so the engine knows
      // which decision belongs to which waiting agent. The card itself arrives
      // on the ordinary `approval` frame the screen already handles — this is
      // the plumbing behind it, and nothing on screen needs it.
      case "approvalAsked":
        break;
      // ENGINE-ONLY ORDER, and the screen is right to drop it: "go and ask
      // GitHub about this repository" is addressed to the copy of Cloud9 that
      // has the GitHub sign-in, not to a window. What comes back arrives as an
      // ordinary `project` and `projectItems` frame, handled above.
      case "lookAtProject":
        break;
      // FILES AGENTS MADE — the server half of the shared artifact store landed
      // first, and the screen half is deliberately a separate round. These three
      // frames are DROPPED ON PURPOSE, and that is a stated gap and not a
      // silence: nothing on this screen draws an artifact yet, so pretending to
      // keep one in the world state would be a card nobody can see.
      //
      // The exhaustive `never` below is what forced these lines to exist, which
      // is exactly what it is for. What to draw, and the field names to draw it
      // from, are written down in `docs/plans/artifact-store-handoff.md` — the
      // follow-up round replaces these three lines with real handling.
      case "artifact":
      case "artifacts":
      case "artifactTicket":
        break;
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
