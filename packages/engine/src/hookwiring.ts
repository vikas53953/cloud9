// PLUGGING THE OWNER'S HOOKS INTO A LIVE ENGINE — one call, and the four
// things Cloud9 can really do.
//
// WHY THIS IS ITS OWN FILE. `hooks.ts` must stay a decision module: it can be
// read, argued with and tested without an engine, a socket or a disk anywhere
// near it. Everything on the other side of that line — where a message actually
// goes, how a note is actually stored, which folder a program actually runs in —
// is here, and it is all a handful of calls into things `Engine` already does.
//
// THE ONE RULE THIS FILE ADDS. An action does what an agent doing the same
// thing would do, through the same door, with the same gate. A hook posting a
// message goes through `agentSend`. A hook starting a job goes through
// `requestJob`, which asks the owner exactly when a person's `!task` would have.
// A hook running a program goes through `run()`, which refuses every shell
// metacharacter rather than trying to escape it — and `hooks.ts` has already
// refused the whole action if the agent is one the owner wanted asked about.
// There is no path here that does something an agent could not have done.
import type { AgentDef, ID } from "@cloud9/shared";
import type { Engine } from "./engine.js";
import {
  HookBook, loadHooks, loadHooksHubOwned, markHooksHubOwned, mayReplaceHooksFromHub,
  saveHooks, type Hook, type HookActions,
} from "./hooks.js";
import { MemoryNote, newMemoryId } from "./agent-memory.js";
import { run, safeArg, shellQuote } from "./run.js";

/** How long a hook's program may run before it is killed. One minute, flat. */
export const HOOK_COMMAND_TIMEOUT_MS = 60_000;

export interface HookWiring {
  /** the book the engine now fires into */
  book: HookBook;
  /** the owner's rules as they stand */
  hooks: () => readonly Hook[];
  /** add or replace one rule. Returns whether it is now ON THE DISK. */
  save: (hook: Hook) => boolean;
  /** take one away. Returns whether the change reached the disk. */
  remove: (id: string) => boolean;
  /** replace the whole book from the owner's relay editor */
  replace: (hooks: readonly Hook[]) => boolean;
}

/**
 * Give this engine the owner's hooks, and (optionally) the verification pass.
 *
 * `verify` is opt-in and separate because they are two different promises: a
 * hook does something the owner asked for, and verification says something the
 * owner did not ask for. Turning one on must not quietly turn on the other.
 */
export function attachHooks(engine: Engine, opts: {
  /** turn on the "did it do what it said" check as well */
  verify?: boolean;
  log?: (message: string) => void;
} = {}): HookWiring {
  const log = opts.log ?? ((m: string) => console.error(`[hooks] ${m}`));
  let hooks: Hook[] = loadHooks(engine.dataDir, log);
  // Explicit cutover: until the hub has owned this book, an empty push must not
  // silently destroy durable local rules that pre-date the relay editor.
  let hubOwned = loadHooksHubOwned(engine.dataDir);

  const applyReplace = (next: readonly Hook[]): boolean => {
    const decision = mayReplaceHooksFromHub({ incoming: next, current: hooks, hubOwned });
    if (!decision.allow) {
      log(decision.reason);
      return false;
    }
    if (!saveHooks(engine.dataDir, [...next], log)) return false;
    hooks = [...next];
    if (decision.markOwned && !hubOwned) {
      hubOwned = true;
      markHooksHubOwned(engine.dataDir, log);
    }
    return true;
  };

  const book = new HookBook({
    hooks: () => hooks,
    agent: (id: ID) => engine.agentById(id),
    replace: applyReplace,
    log,
    actions: engineActions(engine, log),
  });

  engine.hooks = book;
  if (opts.verify) engine.verifyClaims = true;

  return {
    book,
    hooks: () => hooks,
    save(hook) {
      const next = hooks.filter(h => h.id !== hook.id).concat(hook);
      if (!saveHooks(engine.dataDir, next, log)) return false;
      hooks = next;
      return true;
    },
    remove(id) {
      const next = hooks.filter(h => h.id !== id);
      if (next.length === hooks.length) return true;      // nothing to do
      if (!saveHooks(engine.dataDir, next, log)) return false;
      hooks = next;
      return true;
    },
    replace: applyReplace,
  };
}

/**
 * THE FOUR ACTIONS, each one a call into something the engine already does.
 *
 * Exported so a test can hold this file to its promise — that a hook goes
 * through the same doors an agent does — without standing up a socket.
 */
export function engineActions(
  engine: Engine, log: (m: string) => void = () => { /* quiet */ },
): HookActions {
  return {
    // SAY IT AS THE AGENT, IN THE ROOM, MARKED AS NOT ASKED FOR. `proactive`
    // because nobody typed anything to prompt it — the room draws it as the
    // agent volunteering something, which is exactly what it is.
    say({ agentId, channelId, text }) {
      engine.agentSend(agentId, channelId, text, { proactive: true });
    },

    // A NOTE IN THE AGENT'S OWN MEMORY, through the one store that owns them,
    // marked `source: "owner"` — because it IS the owner's words: he typed the
    // rule. An agent's own note about itself would be `source: "agent"`, and
    // conflating the two is how a hook's text could later read as something the
    // agent worked out for itself.
    note({ agentId, text }) {
      const note: MemoryNote = {
        id: newMemoryId(), agentId, kind: "fact",
        text: text.trim().slice(0, 500), createdAt: Date.now(), source: "owner",
      };
      // A local memory failure is a failed action, not a successful dispatch.
      // Throw so HookBook records a refusal and the relay never presents this
      // hook as having completed work it could not persist.
      if (!engine.memory.save(note)) {
        throw new Error(`could not store a hook's note for agent ${agentId}`);
      }
    },

    // START A JOB THE WAY A PERSON DOES. `requestJob` puts a card in front of
    // the owner in exactly the cases his own `!task` would have.
    job({ agentId, channelId, title }) {
      const agent: AgentDef | undefined = engine.agentById(agentId);
      if (!agent) throw new Error("that agent is gone");
      engine.requestJob(agent, channelId, title, undefined, { causedByHook: true });
    },

    // RUN A PROGRAM — in the agent's OWN folder, on a one-minute leash, through
    // `run.ts`'s allowlist.
    //
    // ANYTHING WITH A SHELL METACHARACTER IN IT IS REFUSED, NOT ESCAPED. That
    // is `run.ts`'s law and this is why a hook may carry a command at all: the
    // refusal throws, `HookBook` catches it, and the owner is told the hook
    // could not finish. Quoting rules get outsmarted; refusing does not.
    //
    // NOT AWAITED, ON PURPOSE. A hook fires inside a turn that has finished its
    // work; making that turn wait a minute on the owner's automation would be
    // the paperwork costing the work again. The result is logged, not returned.
    command({ agentId, command }) {
      const parts = command.trim().split(/\s+/).filter(p => p !== "");
      const [cmd, ...args] = parts;
      if (!cmd) throw new Error("that hook has no command in it");
      // checked HERE so an unusable command is refused before anything spawns
      const safeCmd = shellQuote(cmd);
      const safeArgs = args.map(a => safeArg(a));
      void run(safeCmd, safeArgs, {
        cwd: engine.agentDataDir(agentId),
        timeoutMs: HOOK_COMMAND_TIMEOUT_MS,
      }).then(result => {
        if (result.notFound) log(`a hook's program was not found: ${safeCmd}`);
        else if (result.timedOut) log(`a hook's program ran too long and was stopped: ${safeCmd}`);
      }).catch(err => log(`a hook's program fell over: ${String(err)}`));
    },
  };
}
