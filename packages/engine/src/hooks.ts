// CLOUD9'S OWN HOOKS — the owner's events setting off the owner's actions.
//
// THE GAP THIS CLOSES. A harness has seven pieces and Cloud9 had six of them:
// prompt, skills, tools, memory, permissions, agent loop — and nothing at all
// for "when THIS happens, do THAT". Every hook in the repository before this
// file was a React hook. So the only automation the owner had was a schedule
// ("every ten minutes"), which answers a clock and never answers his workspace.
//
// THIS IS NOT THE CLAUDE CODE HOOK SYSTEM AND IT IS NOT THE CODEX ONE. Those
// fire inside a CLI, on that CLI's own tool calls, for a person who can write a
// shell script. These fire on things Cloud9 itself already knows have happened
// — a turn ended, a job ended, an agent is standing at the approval gate, a
// claim did not match the record — and they do things Cloud9 itself already
// knows how to do. A person who has never opened a terminal can set one up.
//
// THE FIVE LAWS, each one a test in `hooks.test.ts`:
//
//  1. A HOOK IS NEVER A WAY ROUND AN APPROVAL. A hook that runs a program on an
//     agent that must be asked before it runs programs is REFUSED — not queued,
//     not asked, refused — because a hook fires when nobody is looking and there
//     is nobody there to answer a card. `needsApprovalToRun` is the same
//     function the command line and the agent editor ask; there is no second
//     opinion here.
//  2. A HOOK NEVER ACTS AS SOMEBODY ELSE. The hook's owner, the agent it points
//     at and the fact it fired on must all belong to the same person. A hook
//     that names an agent its owner does not own is refused every single time.
//  3. A HOOK NEVER BREAKS THE TURN THAT SET IT OFF. `fire` does not throw, ever.
//     An action that falls over is recorded as failed and the turn carries on —
//     the same fire-and-forget shape `approvaldesk.ts`'s `tell()` already uses,
//     for the same reason: the work matters more than the paperwork.
//  4. A HOOK NEVER SETS OFF ANOTHER HOOK. A fact that was itself produced by a
//     hook's action fires nothing. Not a depth counter, not a loop breaker: an
//     absolute stop, because "post a message" → "an agent replies" → "a turn
//     finished" → "post a message" is one line of config away and would never
//     stop on its own.
//  5. A HOOK IS VISIBLE AND REMOVABLE. Every hook has plain words describing it
//     (`describeHook`), lives in one file the owner can be shown, and every
//     firing — done, refused, failed — is kept where it can be listed.
import { newId, type AgentDef, type ID, type RunOutcome } from "@cloud9/shared";
import path from "node:path";
import fs from "node:fs";
import { needsApprovalToRun } from "./abilities.js";
import { writeWholeFile } from "./wholefile.js";

// ------------------------------------------------------------- the events

/**
 * WHAT CLOUD9 CAN TELL YOU HAPPENED. Four, and every one of them is a seam that
 * already existed and already fired before this file was written — nothing here
 * invents an event so that there would be more of them.
 */
export const HOOK_EVENTS = {
  /** an agent finished a turn — worked, failed, or was stopped (`Engine.recordRun`) */
  "turn.finished": "when an agent finishes answering",
  /** a delegated job's turn ended (a run record carrying a job) */
  "job.finished": "when a job finishes",
  /** an agent is standing at the approval gate waiting on you (`ApprovalDesk`) */
  "approval.waiting": "when an agent is waiting for your OK",
  /** verification found a claim the record does not support (`verify.ts`) */
  "check.mismatch": "when what an agent said doesn't match what it did",
} as const;

export type HookEvent = keyof typeof HOOK_EVENTS;

export function isHookEvent(value: unknown): value is HookEvent {
  return typeof value === "string"
    && Object.prototype.hasOwnProperty.call(HOOK_EVENTS, value);
}

/**
 * ONE THING THAT HAPPENED, in the shape a hook is matched against.
 *
 * `what` is ONE PLAIN SENTENCE built by whoever reports the fact, from counted
 * facts — the same discipline as the approval card: an agent never writes the
 * words that describe an agent.
 */
export interface HookFact {
  event: HookEvent;
  at: number;
  /** whose world this happened in — law 2 checks every hook against it */
  ownerId: ID;
  agentId?: ID;
  agentName?: string;
  channelId?: ID;
  taskId?: ID;
  outcome?: RunOutcome;
  /** one plain sentence a person reads */
  what: string;
  /**
   * TRUE when this fact is the consequence of a hook's own action. Law 4: a
   * fact carrying this fires nothing at all.
   */
  causedByHook?: boolean;
}

// ------------------------------------------------------------ the actions

/** WHAT CLOUD9 CAN DO FOR YOU when one of those happens. Four. */
export const HOOK_ACTIONS = {
  say: "post a message in the conversation",
  note: "write a note into an agent's memory",
  job: "start a job",
  command: "run a program on this computer",
} as const;

export type HookActionKind = keyof typeof HOOK_ACTIONS;

export type HookAction =
  | { do: "say"; agentId: ID; channelId?: ID; text: string }
  | { do: "note"; agentId: ID; text: string }
  | { do: "job"; agentId: ID; channelId?: ID; title: string }
  | { do: "command"; agentId: ID; command: string };

/** One rule the owner set: when THIS happens, do THAT. */
export interface Hook {
  id: string;
  /** the owner's own words for it, shown in the list */
  name: string;
  /** the person this hook belongs to. Law 2 leans on it. */
  ownerId: ID;
  event: HookEvent;
  enabled: boolean;
  /** narrow it: only this agent, only this outcome. Absent means "any". */
  when?: { agentId?: ID; outcome?: RunOutcome };
  action: HookAction;
}

/**
 * HOW CLOUD9 ACTUALLY DOES THE FOUR THINGS. Supplied by whoever wires the book
 * up, never implemented here: this module decides WHETHER, the engine does.
 *
 * An action left out is not silently skipped — it is REFUSED, out loud, with a
 * reason. A hook that quietly does nothing is worse than one that says it
 * cannot, because the owner goes on believing his workspace is automated.
 */
export interface HookActions {
  say(a: { agentId: ID; channelId: ID; text: string }): void;
  note(a: { agentId: ID; channelId?: ID; text: string }): void;
  job(a: { agentId: ID; channelId: ID; title: string }): void;
  command(a: { agentId: ID; command: string }): void;
}

/** What happened when one hook met one fact. Kept, so it can be shown. */
export interface HookFiring {
  /** Stable per-fire receipt used by the relay to bind and deduplicate reports. */
  firingId: ID;
  hookId: string;
  hookName: string;
  event: HookEvent;
  at: number;
  /** did the action really run */
  ok: boolean;
  /** plain words: what was done, or why it was not */
  said: string;
}

export interface HookBookOptions {
  /** the owner's hooks, read fresh every time so an edit takes effect at once */
  hooks: () => readonly Hook[];
  /** how Cloud9 does things. A missing member means "this app cannot, here". */
  actions: Partial<HookActions>;
  /** replace the live rules when the relay owner edits them in the window */
  replace?: (hooks: readonly Hook[]) => boolean;
  /** who an agent id belongs to — law 2 cannot be checked without it */
  agent: (id: ID) => AgentDef | undefined;
  /** most times ONE hook may fire in a minute. A leash, not a policy. */
  perMinute?: number;
  /** how many firings are kept for the owner to look at */
  keepRecent?: number;
  log?: (message: string) => void;
  now?: () => number;
}

export const HOOK_DEFAULTS = {
  /** six firings a minute per hook: enough for real work, far short of a storm */
  perMinute: 6,
  keepRecent: 50,
  /** most hooks one owner may keep */
  maxHooks: 50,
  name: 80,
  text: 500,
  command: 500,
} as const;

// -------------------------------------------------------------- the book

export class HookBook {
  private firings: HookFiring[] = [];
  private log: (message: string) => void;
  private now: () => number;
  private perMinute: number;
  private keepRecent: number;

  constructor(private opts: HookBookOptions) {
    this.log = opts.log ?? ((m: string) => console.error(`[hooks] ${m}`));
    this.now = opts.now ?? (() => Date.now());
    this.perMinute = Math.max(1, opts.perMinute ?? HOOK_DEFAULTS.perMinute);
    this.keepRecent = Math.max(1, opts.keepRecent ?? HOOK_DEFAULTS.keepRecent);
  }

  /** Every firing we still remember, newest last. For a screen, and for tests. */
  get recent(): readonly HookFiring[] { return this.firings; }

  /** Apply a relay-sourced owner edit without rebuilding the engine. */
  replace(hooks: readonly Hook[]): boolean {
    if (!this.opts.replace) return false;
    try { return this.opts.replace(hooks); } catch (err) {
      this.log(`could not replace the owner's hooks: ${String(err)}`);
      return false;
    }
  }

  /**
   * SOMETHING HAPPENED. Tell every hook that was waiting for it.
   *
   * NEVER THROWS — law 3. Every way this can go wrong (a hook pointing at a
   * deleted agent, an action that is not wired up here, an action that falls
   * over mid-way) becomes a recorded firing and nothing else. The caller may
   * ignore the return value entirely and lose only the record, never the turn.
   */
  fire(fact: HookFact): HookFiring[] {
    try {
      return this.fireInner(fact);
    } catch (err) {
      // the guard on the guard: a bug in this file must not be able to reach
      // the turn that called it
      this.log(`could not run hooks for ${fact.event}: ${String(err)}`);
      return [];
    }
  }

  private fireInner(fact: HookFact): HookFiring[] {
    if (!isHookEvent(fact.event)) return [];
    // LAW 4 — a hook never sets off another hook. Checked before anything else,
    // and without recording a refusal per hook: a loop that is stopped quietly
    // is stopped; a loop that writes a line per lap is still a loop.
    if (fact.causedByHook) return [];

    const out: HookFiring[] = [];
    for (const hook of this.opts.hooks()) {
      if (!hook || hook.enabled !== true) continue;
      if (hook.event !== fact.event) continue;
      // LAW 2, first half — a hook only ever hears about its own owner's world.
      if (hook.ownerId !== fact.ownerId) continue;
      if (hook.when?.agentId && hook.when.agentId !== fact.agentId) continue;
      if (hook.when?.outcome && hook.when.outcome !== fact.outcome) continue;
      out.push(this.runOne(hook, fact));
    }
    return out;
  }

  private runOne(hook: Hook, fact: HookFact): HookFiring {
    const refuse = (why: string): HookFiring => this.remember({
      firingId: newId("hookfiring"),
      hookId: hook.id, hookName: hook.name, event: hook.event,
      at: this.now(), ok: false, said: why,
    });

    // A LEASH. Six a minute per hook: a hook wired to an event that suddenly
    // fires in a tight loop stops itself rather than filling his room.
    if (this.firedRecently(hook.id) >= this.perMinute) {
      return refuse(`“${hook.name}” has already run ${this.perMinute} times this minute, `
        + `so Cloud9 held it back`);
    }

    const action = hook.action;
    if (!action || !Object.prototype.hasOwnProperty.call(HOOK_ACTIONS, action.do)) {
      return refuse(`“${hook.name}” asks for something Cloud9 does not know how to do`);
    }

    // LAW 2, second half — the agent it points at must be one this owner owns.
    // Checked from the live agent list, never from what the hook file claims:
    // a stored hook is just text, and text does not get to assert ownership.
    const agent = this.opts.agent(action.agentId);
    if (!agent) {
      return refuse(`“${hook.name}” points at an agent that no longer exists`);
    }
    if (agent.ownerId !== hook.ownerId) {
      return refuse(`“${hook.name}” points at an agent you do not own, so it did not run`);
    }

    // LAW 1 — no way round an approval. A hook fires when nobody is looking, so
    // there is nobody there to answer a card: an agent that must be asked before
    // it runs programs cannot be made to run one by a hook. The hook is refused
    // in plain words rather than silently downgraded.
    if (action.do === "command" && needsApprovalToRun(agent)) {
      return refuse(`“${hook.name}” wanted to run a program as ${agent.name}, but you have `
        + `${agent.name} set to ask you first — and a hook runs when you are not there to be `
        + `asked, so it did not run`);
    }

    const doIt = this.opts.actions[action.do];
    if (!doIt) {
      return refuse(`“${hook.name}” wanted to ${HOOK_ACTIONS[action.do]}, `
        + `which this copy of Cloud9 cannot do`);
    }

    // WHERE IT LANDS. A hook that names no conversation speaks where the thing
    // happened. Neither known means there is nowhere to put it, and inventing a
    // room is how an agent ends up talking in a conversation nobody asked in.
    const channelId = ("channelId" in action ? action.channelId : undefined) ?? fact.channelId;

    try {
      switch (action.do) {
        case "say": {
          if (!channelId) return refuse(`“${hook.name}” had nowhere to say that`);
          this.opts.actions.say?.({
            agentId: action.agentId, channelId, text: fill(action.text, fact),
          });
          return this.done(hook, `said something in the conversation`);
        }
        case "note": {
          this.opts.actions.note?.({ agentId: action.agentId, ...(channelId ? { channelId } : {}), text: fill(action.text, fact) });
          return this.done(hook, `wrote a note into ${agent.name}'s memory`);
        }
        case "job": {
          if (!channelId) return refuse(`“${hook.name}” had nowhere to start that job`);
          this.opts.actions.job?.({
            agentId: action.agentId, channelId, title: fill(action.title, fact),
          });
          return this.done(hook, `started a job for ${agent.name}`);
        }
        case "command": {
          this.opts.actions.command?.({ agentId: action.agentId, command: action.command });
          return this.done(hook, `ran a program as ${agent.name}`);
        }
      }
    } catch (err) {
      // LAW 3 — the turn that set this off does not hear about it.
      this.log(`hook ${hook.id} fell over: ${String(err)}`);
      return refuse(`“${hook.name}” could not finish — Cloud9 wrote down why`);
    }
  }

  private done(hook: Hook, said: string): HookFiring {
    return this.remember({
      firingId: newId("hookfiring"),
      hookId: hook.id, hookName: hook.name, event: hook.event,
      at: this.now(), ok: true, said: `“${hook.name}” ${said}`,
    });
  }

  private remember(firing: HookFiring): HookFiring {
    this.firings.push(firing);
    if (this.firings.length > this.keepRecent) {
      this.firings.splice(0, this.firings.length - this.keepRecent);
    }
    return firing;
  }

  /** How many times this hook has ACTUALLY fired in the last minute. */
  private firedRecently(hookId: string): number {
    const since = this.now() - 60_000;
    return this.firings.filter(f => f.hookId === hookId && f.ok && f.at >= since).length;
  }
}

/**
 * PUT THE FACT INTO THE OWNER'S SENTENCE. Three placeholders, no expressions,
 * no code: `{what}`, `{agent}`, `{outcome}`. A template language here would be
 * a second place an agent's words could reach a screen unchecked.
 */
export function fill(text: string, fact: HookFact): string {
  return text
    .replace(/\{what\}/g, fact.what)
    .replace(/\{agent\}/g, fact.agentName ?? "an agent")
    .replace(/\{outcome\}/g, fact.outcome ?? "finished");
}

// -------------------------------------------------------- plain words

/** The one sentence the owner reads in his list of hooks. */
export function describeHook(hook: Hook): string {
  const when = HOOK_EVENTS[hook.event] ?? hook.event;
  const only = hook.when?.agentId ? " (one agent only)" : "";
  const outcome = hook.when?.outcome ? ` (only when it ${plainOutcome(hook.when.outcome)})` : "";
  const then = HOOK_ACTIONS[hook.action?.do] ?? "do something";
  const off = hook.enabled ? "" : " — turned off";
  return `${when}${only}${outcome}, ${then}${off}`;
}

function plainOutcome(outcome: RunOutcome): string {
  return outcome === "ok" ? "worked" : outcome === "failed" ? "went wrong" : "was stopped";
}

// ------------------------------------------------------------- storage
//
// SAME SHAPE, SAME OWNER, SAME FAILURE MODE AS `schedules.json`. One file, in
// the engine's data folder, written whole through `wholefile.ts` so a machine
// that dies mid-write cannot leave half a rule behind. And read the same way:
// a row that cannot be acted on is DROPPED AND SAID OUT LOUD rather than kept
// and half-believed, because a hook that silently never fires is exactly the
// automation failure a person cannot debug.

export const HOOKS_FILE = "hooks.json";
/** Marker written once the hub has successfully owned this machine's hook book. */
export const HOOKS_HUB_OWNED_FILE = "hooks.hub-owned";

export function hooksPath(dataDir: string): string {
  return path.join(dataDir, HOOKS_FILE);
}

export function hooksHubOwnedPath(dataDir: string): string {
  return path.join(dataDir, HOOKS_HUB_OWNED_FILE);
}

/** Has the hub cut over as the owner of truth for this data dir? */
export function loadHooksHubOwned(dataDir: string): boolean {
  try { return fs.existsSync(hooksHubOwnedPath(dataDir)); }
  catch { return false; }
}

/** Record that the hub now owns this book's truth. Failures are said, not thrown. */
export function markHooksHubOwned(
  dataDir: string, log: (m: string) => void = m => console.error(`[hooks] ${m}`),
): boolean {
  try {
    fs.writeFileSync(hooksHubOwnedPath(dataDir), "1\n", "utf8");
    return true;
  } catch (err) {
    log(`could not mark the hub as owner of the hooks book: ${String(err)}`);
    return false;
  }
}

/**
 * CLASS RULE: empty hub must not silently destroy durable local hooks until
 * the hub has claimed this book. After cutover, empty is a real owner delete.
 *
 * Pure decision — the wiring applies it, the tests hold it.
 */
export function mayReplaceHooksFromHub(args: {
  incoming: readonly Hook[];
  current: readonly Hook[];
  hubOwned: boolean;
}): { allow: true; markOwned: true } | { allow: false; markOwned: false; reason: string } {
  if (args.incoming.length === 0 && args.current.length > 0 && !args.hubOwned) {
    return {
      allow: false,
      markOwned: false,
      reason: "keeping local hooks — the hub has none and has never owned this book",
    };
  }
  return { allow: true, markOwned: true };
}

export function newHookId(now = Date.now(), rand = Math.random): string {
  return `h-${now.toString(36)}-${Math.floor(rand() * 36 ** 3).toString(36).padStart(3, "0")}`;
}

/**
 * WHY THIS ROW CANNOT BE ACTED ON, or null when it can. Plain words, because
 * this sentence is what the owner is shown when a hook is dropped.
 */
export function hookProblem(row: unknown): string | null {
  if (!row || typeof row !== "object") return "that isn't a rule";
  const h = row as Partial<Hook>;
  if (typeof h.id !== "string" || !h.id.trim()) return "it has no id";
  if (typeof h.ownerId !== "string" || !h.ownerId.trim()) return "it does not say whose it is";
  if (typeof h.name !== "string" || !h.name.trim() || h.name.length > HOOK_DEFAULTS.name) {
    return "it has no usable name";
  }
  if (!isHookEvent(h.event)) return "it waits for something Cloud9 cannot tell it about";
  if (typeof h.enabled !== "boolean") return "it does not say whether it is on";
  const a = h.action as Partial<HookAction> | undefined;
  if (!a || typeof a !== "object") return "it does not say what to do";
  if (typeof a.do !== "string" || !Object.prototype.hasOwnProperty.call(HOOK_ACTIONS, a.do)) {
    return "it asks for something Cloud9 does not know how to do";
  }
  if (typeof a.agentId !== "string" || !a.agentId.trim()) return "it does not say which agent";
  const words = a.do === "job" ? (a as { title?: unknown }).title
    : a.do === "command" ? (a as { command?: unknown }).command
      : (a as { text?: unknown }).text;
  const max = a.do === "command" ? HOOK_DEFAULTS.command : HOOK_DEFAULTS.text;
  if (typeof words !== "string" || !words.trim()) return "it does not say what to do exactly";
  if (words.length > max) return "what it says to do is too long";
  if (h.when !== undefined && (typeof h.when !== "object" || h.when === null)) {
    return "the part that narrows it down cannot be read";
  }
  return null;
}

/**
 * The saved hooks — or none, said out loud, when the file cannot be believed.
 * Never throws: no hooks is a working Cloud9; a crash at startup is not.
 */
export function loadHooks(
  dataDir: string, log: (m: string) => void = m => console.error(`[hooks] ${m}`),
): Hook[] {
  let text: string;
  try { text = fs.readFileSync(hooksPath(dataDir), "utf8"); }
  catch { return []; }                    // no file yet, or unreadable — both mean none
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch {
    log("the hooks file is damaged (the text stops part-way through) — "
      + "starting with no hooks rather than half of them");
    return [];
  }
  if (!Array.isArray(parsed)) {
    log("the hooks file does not hold a list of rules — ignoring it");
    return [];
  }
  const usable: Hook[] = [];
  for (const row of parsed.slice(0, HOOK_DEFAULTS.maxHooks)) {
    const problem = hookProblem(row);
    if (problem) { log(`ignoring a saved hook that cannot be acted on: ${problem}`); continue; }
    usable.push(row as Hook);
  }
  return usable;
}

/** Write the whole list. Returns whether it is now ON THE DISK — never guesses. */
export function saveHooks(
  dataDir: string, hooks: readonly Hook[],
  log: (m: string) => void = m => console.error(`[hooks] ${m}`),
): boolean {
  return writeWholeFile(
    hooksPath(dataDir), JSON.stringify(hooks.slice(0, HOOK_DEFAULTS.maxHooks), null, 2),
    m => log(`could not save the hooks: ${m}`),
  );
}
