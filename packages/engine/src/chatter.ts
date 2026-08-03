// Reply-decision + runaway brake for free agent-to-agent conversation.
// Gate-1 pick: agents may converse freely. The brake keeps a loop from
// silently draining a subscription: >=25 consecutive agent messages with no
// human, or >=60 agent messages in an hour per channel, pauses agents there
// until a human speaks.
import { AgentDef, Channel, ID, mayDriveAgent, Message } from "@cloud9/shared";

export interface BrakeConfig {
  maxConsecutiveAgent: number; // default 25
  maxAgentPerHour: number;     // default 60
}

export const DEFAULT_BRAKE: BrakeConfig = { maxConsecutiveAgent: 25, maxAgentPerHour: 60 };

/** true when agents must stay silent in this channel until a human speaks */
export function isBraked(history: Message[], cfg: BrakeConfig = DEFAULT_BRAKE): boolean {
  let consecutive = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].authorKind === "agent") consecutive++;
    else break;
  }
  if (consecutive >= cfg.maxConsecutiveAgent) return true;
  const hourAgo = Date.now() - 3600_000;
  const lastHour = history.filter(m => m.authorKind === "agent" && m.ts >= hourAgo).length;
  return lastHour >= cfg.maxAgentPerHour;
}

/**
 * Decide whether `agent` should reply to `message`.
 *  - never to itself
 *  - never for someone who is not allowed to drive this agent
 *  - always in a DM it belongs to (when someone allowed spoke)
 *  - when @mentioned AND it is the one agent that owns this turn: a message
 *    naming several agents is answered by the FIRST one named, the rest stay
 *    quiet (see `mentionOwner`)
 *  - free chatter: for un-mentioned human messages, the single most relevant
 *    agent in the channel chimes in (keyword overlap with persona); agent
 *    messages only draw replies via mention — that plus the brake keeps
 *    "free conversation" from becoming an infinite loop.
 *
 * WHO MAY MAKE THIS AGENT ACT HAS ONE OWNER: `mayDriveAgent` in
 * `@cloud9/shared`, the same function the relay calls on mentions and on
 * `createTask`. It is imported, never re-implemented and never re-derived — a
 * second copy of a permission rule is a rule that goes stale, and this one
 * decides whose subscription gets spent and whose machine starts a program.
 *
 * The hole this closes: a friend invited into Cloud9 could open a DM with the
 * owner's agent — or simply say something on-topic in a shared channel — and
 * get a turn out of it, because neither the DM branch nor the free-chatter
 * branch ever asked who was speaking.
 *
 * A refusal is SILENT. The agent says nothing at all, so a guest cannot use a
 * polite "sorry, you're not allowed" to discover which agents exist, who owns
 * them, or how they are configured. The engine logs it for the owner instead.
 */
export function shouldReply(
  agent: AgentDef,
  message: Message,
  channel: Channel,
  channelAgents: AgentDef[],
): boolean {
  if (agent.lifecycle === "paused" || agent.lifecycle === "disabled") return false;
  if (message.authorId === agent.id) return false;
  if (!channel.memberIds.includes(agent.id)) return false;
  // A person may only make an agent act if the agent's owner said they may.
  // Agent-authored messages are left to the agent→agent rules below: an agent
  // needs a mention, and the relay has already filtered that mention against
  // ITS OWNER's permissions — which is what stops an agent laundering a
  // permission its owner does not have (FR-AA-003).
  if (message.authorKind === "human" && !mayDriveAgent(message.authorId, agent)) return false;
  if (channel.kind === "dm") return true;
  // ONE OWNER PER ANSWER (feature 4, slice A). Being named is no longer enough:
  // when a message names several agents, exactly one of them takes the turn —
  // see `mentionOwner` for the rule and why it needs no coordination.
  if (message.mentions?.includes(agent.id)) {
    return mentionOwner(message, channel, [agent, ...channelAgents]) === agent.id;
  }
  if (message.authorKind === "agent") return false; // agent→agent needs a mention
  if (message.mentions && message.mentions.length > 0) return false; // directed elsewhere
  // free chatter: best-matching agent replies
  const scores = channelAgents
    .filter(a => channel.memberIds.includes(a.id))
    .map(a => ({ id: a.id, score: relevance(a, message.text) }));
  const best = scores.sort((x, y) => y.score - x.score)[0];
  return !!best && best.id === agent.id && best.score > 0;
}

/**
 * WHO OWNS A MESSAGE THAT NAMES SEVERAL AGENTS — the rule: FIRST MENTIONED WINS.
 *
 * "@Scout @Architect look at this" is answered by Scout, and Architect stays
 * quiet. Before this, every named agent answered: three mentions meant three
 * separate turns, three subscriptions spent, and three half-answers to read.
 *
 * Why first-mentioned rather than best-matching:
 *  - A PERSON CAN PREDICT IT. The order you type the names in is the order you
 *    meant them in; the first name is who you were talking to. Relevance
 *    scoring would make the same sentence go to a different agent tomorrow.
 *  - IT NEEDS NO COORDINATION. Each person's agents run on that person's own
 *    computer, and an engine only ever sees its OWN agents act. If the choice
 *    depended on anything an engine holds privately, two engines could both
 *    decide "mine wins" and both answer. This rule reads only facts every
 *    engine already has identical copies of, broadcast by the hub: the message
 *    text, the message's `mentions` list, and the channel's agent roster
 *    (`worldFor` in the relay sends `store.agents()` — the WHOLE roster — to
 *    everyone). So both engines compute the same winner, separately, with no
 *    message passing between them.
 *
 * A paused or switched-off agent cannot own a turn — it would swallow the
 * question in silence — so the next agent named takes it instead.
 *
 * Ties (a name that isn't literally in the text, e.g. mentions supplied by a
 * caller rather than typed) fall back to the order of the `mentions` list and
 * then to agent id: both are the same everywhere, so a tie still resolves the
 * same way on every machine.
 *
 * Returns the id of the agent that owns the turn, or undefined when nobody
 * named is able to take it.
 */
export function mentionOwner(
  message: Message,
  channel: Channel,
  channelAgents: AgentDef[],
): ID | undefined {
  const mentioned = message.mentions ?? [];
  if (mentioned.length === 0) return undefined;
  const seen = new Set<ID>();
  const candidates = channelAgents.filter(a => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return mentioned.includes(a.id)
      && channel.memberIds.includes(a.id)
      && a.lifecycle !== "paused" && a.lifecycle !== "disabled";
  });
  if (candidates.length === 0) return undefined;
  const ranked = candidates
    .map(a => ({
      id: a.id,
      pos: mentionPosition(message.text, a.name),
      order: mentioned.indexOf(a.id),
    }))
    .sort((x, y) => x.pos - y.pos || x.order - y.order || (x.id < y.id ? -1 : 1));
  return ranked[0].id;
}

/**
 * The agents that were named but are staying quiet because someone else owns
 * the turn. Nothing in the engine acts on this yet — it is what the room needs
 * to say "…and Architect was asked too" without re-deriving the rule on screen.
 */
export function passedOverByMention(
  message: Message,
  channel: Channel,
  channelAgents: AgentDef[],
): ID[] {
  const owner = mentionOwner(message, channel, channelAgents);
  if (!owner) return [];
  const mentioned = message.mentions ?? [];
  return channelAgents
    .filter(a => a.id !== owner && mentioned.includes(a.id) && channel.memberIds.includes(a.id))
    .map(a => a.id);
}

/** Where "@Name" appears in the text; Infinity when it was never typed. */
function mentionPosition(text: string, name: string): number {
  const re = new RegExp(`@${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
  const at = text.search(re);
  return at < 0 ? Infinity : at;
}

function relevance(agent: AgentDef, text: string): number {
  const personaWords = new Set(
    agent.persona.toLowerCase().split(/\W+/).filter(w => w.length > 3),
  );
  let score = 0;
  for (const w of text.toLowerCase().split(/\W+/)) {
    if (w.length > 3 && personaWords.has(w)) score++;
  }
  if (text.toLowerCase().includes(agent.name.toLowerCase())) score += 5;
  return score;
}
