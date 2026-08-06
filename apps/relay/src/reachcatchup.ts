// THE CATCH-UP: the agents he already had, brought up to what a new one gets —
// once, by the hub, without him having to find anything.
//
// WHY THIS EXISTS, 2026-08-05, read from his own database minutes before it was
// written. Five of his six agents genuinely could not run a command (`commands`
// was not even a key on them), none of the six had a single folder of his opened
// up, and not one of them had a trust setting — which fails closed, so every job
// would have stopped and asked. When they told him "I can't run git or npm",
// they were telling the truth.
//
// The defaults for a NEW agent were fixed, and a button was added to the crew
// screen that fixes the old ones. He has asked four times for this to just work.
// A button is still something to find. So the hub does it itself, at startup,
// exactly once, and then says so on his screen.
//
// THE FOUR RULES THIS FILE IS, and each of them is a test:
//   1. IT ONLY ADDS. Every switch it writes it writes ON; a switch a new agent
//      does not get (`connections`) is left exactly as he left it; a folder he
//      chose is never replaced. There is no path through here that takes
//      something away.
//   2. IT RUNS ONCE. The marker below goes into the database's own `meta` table
//      the moment it finishes, so a restart never re-grants something he
//      deliberately switched off afterwards. Once means once, on this file.
//   3. IT IS HIS AGENTS ONLY. `ownerId` must equal the id of the person who RUNS
//      this hub. A guest's agent on his hub is not his to widen, and a hub with
//      no owner id does not run this at all.
//   4. IT IS NOT SILENT. It returns the receipt — who changed and what they
//      gained — and the hub carries it to his screen in the welcome frame.
//
// ONE OWNER FOR THE GRANT RULE. It does not know what "the full working set" is:
// `capabilitiesForNewAgent` and `bringUpToFullReach` — the same two functions the
// crew button and a brand-new agent go through — are asked. There is no second
// copy of the rule here to drift from them.
import {
  AgentAbilities, AgentDef, ID, NEW_AGENT_TRUST, ReachCatchup, ReachCatchupAgent,
  isAgentTrust,
} from "@cloud9/shared";
import { bringUpToFullReach, capabilitiesForNewAgent } from "@cloud9/engine";

/**
 * WHERE THE ONCE-ONLY MARKER LIVES: one row in the `meta` table of his own
 * `cloud9-relay.db`, beside `schemaVersion`. Same file as the agents it is about,
 * so a restored backup of his messages restores the answer to "has this run?"
 * along with them — a marker kept anywhere else could say "done" about a
 * database that had never seen it.
 *
 * The value is the receipt itself as JSON, not a bare `"1"`, so the reason the
 * hub will never run this again is legible in his own file.
 */
export const REACH_CATCHUP_KEY = "reachCatchup";

/** The little of a Store this job needs — so a test can hand it a fake. */
export interface CatchupStore {
  agents(): AgentDef[];
  saveAgent(agent: AgentDef): void;
  meta(key: string): string | undefined;
  setMeta(key: string, value: string): void;
}

export interface CatchupOptions {
  /**
   * This computer's home folder, resolved by the SHELL (the same
   * `cloud9:homeFolder` answer the window asks for) and handed in. The hub never
   * works it out for itself: a folder this app cannot vouch for is a folder it
   * must not claim, so absent here means no folder is given to anybody.
   */
  homeFolder?: string;
  /** for tests: the moment it ran */
  now?: number;
}

/**
 * DO IT, ONCE.
 *
 * Returns the receipt when it ran and changed something, and `undefined` when
 * there was nothing to do or it had already run — so the caller has nothing to
 * show him unless something really happened to his agents.
 */
export function runReachCatchup(
  store: CatchupStore, ownerId: ID | undefined, opts: CatchupOptions = {},
): ReachCatchup | undefined {
  // RULE 3, and it is first because it is the one that must never be skipped.
  // No owner means this is not a hub whose agents anyone here may widen.
  if (!ownerId) return undefined;
  // RULE 2. Already done on this file, whatever it found that day.
  if (store.meta(REACH_CATCHUP_KEY) !== undefined) return undefined;

  const home = typeof opts.homeFolder === "string" ? opts.homeFolder.trim() : "";
  const changed: ReachCatchupAgent[] = [];

  for (const agent of store.agents()) {
    if (agent.ownerId !== ownerId) continue; // RULE 3, per agent
    const next = catchUpOne(agent, home || undefined);
    if (!next) continue;
    store.saveAgent(next.agent);
    changed.push(next.row);
  }

  const receipt: ReachCatchup = {
    ranAt: opts.now ?? Date.now(),
    ...(home ? { homeFolder: home } : {}),
    trust: NEW_AGENT_TRUST,
    agents: changed,
  };
  // Written EVEN WHEN NOTHING CHANGED. "Nothing to do" is an answer this job is
  // allowed to give once; asking again every startup is how a migration comes
  // back to life months later and undoes a decision he made in between.
  store.setMeta(REACH_CATCHUP_KEY, JSON.stringify(receipt));
  return changed.length > 0 ? receipt : undefined;
}

/**
 * One agent, or nothing at all.
 *
 * `undefined` when this agent already had everything — never a save that looks
 * like a change and is not.
 */
function catchUpOne(
  agent: AgentDef, homeFolder: string | undefined,
): { agent: AgentDef; row: ReachCatchupAgent } | undefined {
  const stored = (agent.abilities ?? {}) as AgentAbilities;
  // WHAT IT IS ABOUT TO GAIN, read off the SAME table the grant comes from and
  // read BEFORE the grant — the words on the switch, so his notice says
  // "Run programs on this computer", never `commands`.
  const gained = capabilitiesForNewAgent()
    .filter(c => stored[c.ability] !== true)
    .map(c => c.label);

  const { agent: widened } = bringUpToFullReach(agent, homeFolder);
  const rootsBefore = countRoots(agent);
  const folder = rootsBefore === 0 && countRoots(widened) > 0 ? homeFolder : undefined;

  // TRUST. These agents have no `trust` field at all, so `trustOf` fails closed
  // to "ask me every time" — which after this grant would mean a card before
  // every job, i.e. one complaint swapped for another. They get what a NEW agent
  // gets, and nothing else: a setting he really chose (any of the three exact
  // words, including "ask me every time") is HIS, and is left alone. That is the
  // same only-ever-add rule as the switches, applied to the setting beside them.
  const trustSet = !isAgentTrust(agent.trust);
  const next: AgentDef = trustSet ? { ...widened, trust: NEW_AGENT_TRUST } : widened;

  if (gained.length === 0 && !folder && !trustSet) return undefined;
  return {
    agent: next,
    row: {
      id: agent.id, name: agent.name, gained,
      ...(folder ? { folder } : {}), trustSet,
    },
  };
}

function countRoots(agent: Pick<AgentDef, "wholeComputerRoots">): number {
  const said = Array.isArray(agent.wholeComputerRoots) ? agent.wholeComputerRoots : [];
  return said.filter(r => typeof r === "string" && r.trim().length > 0).length;
}
