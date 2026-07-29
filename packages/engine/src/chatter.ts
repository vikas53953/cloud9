// Reply-decision + runaway brake for free agent-to-agent conversation.
// Gate-1 pick: agents may converse freely. The brake keeps a loop from
// silently draining a subscription: >=25 consecutive agent messages with no
// human, or >=60 agent messages in an hour per channel, pauses agents there
// until a human speaks.
import { AgentDef, Channel, mayDriveAgent, Message } from "@cloud9/shared";

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
 *  - always when @mentioned
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
  if (message.mentions?.includes(agent.id)) return true;
  if (message.authorKind === "agent") return false; // agent→agent needs a mention
  if (message.mentions && message.mentions.length > 0) return false; // directed elsewhere
  // free chatter: best-matching agent replies
  const scores = channelAgents
    .filter(a => channel.memberIds.includes(a.id))
    .map(a => ({ id: a.id, score: relevance(a, message.text) }));
  const best = scores.sort((x, y) => y.score - x.score)[0];
  return !!best && best.id === agent.id && best.score > 0;
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
