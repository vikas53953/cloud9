// Reply-decision + runaway brake for free agent-to-agent conversation.
// Gate-1 pick: agents may converse freely. The brake keeps a loop from
// silently draining a subscription: >=25 consecutive agent messages with no
// human, or >=60 agent messages in an hour per channel, pauses agents there
// until a human speaks.
import { AgentDef, Channel, Message } from "@cloud9/shared";

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
 *  - always in a DM it belongs to (when someone else spoke)
 *  - always when @mentioned
 *  - free chatter: for un-mentioned human messages, the single most relevant
 *    agent in the channel chimes in (keyword overlap with persona); agent
 *    messages only draw replies via mention — that plus the brake keeps
 *    "free conversation" from becoming an infinite loop.
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
