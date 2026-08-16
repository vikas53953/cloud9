import {
  extractMentions, mayDriveAgent, parseComposerCommand,
  type AgentDef, type ID,
} from "@cloud9/shared";

/** The composer action is a label, not a second send path. */
export type ComposerIntent = "send" | "run";

/** The smallest room-owned view needed to classify a draft. */
export interface ComposerIntentInput {
  text: string;
  roomAgents: readonly AgentDef[];
  requesterId?: ID;
  /** Agent DMs invoke their sole room agent without requiring @mention. */
  direct?: boolean;
  /** Offline, unauthenticated, or inaccessible rooms cannot run anything. */
  available?: boolean;
}

function usableAgents(input: ComposerIntentInput): readonly AgentDef[] {
  if (!input.requesterId) return [];
  return input.roomAgents.filter(agent =>
    agent.lifecycle !== "paused"
    && agent.lifecycle !== "disabled"
    && mayDriveAgent(input.requesterId!, agent));
}

function exactAgent(token: string | undefined, agents: readonly AgentDef[]): AgentDef | undefined {
  if (!token) return undefined;
  const folded = token.toLocaleLowerCase();
  const byId = agents.filter(agent => agent.id.toLocaleLowerCase() === folded);
  if (byId.length === 1) return byId[0];
  if (byId.length > 1) return undefined;
  const byName = agents.filter(agent => agent.name.toLocaleLowerCase() === folded);
  return byName.length === 1 ? byName[0] : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A visible name is not a route key.  Keep a duplicate display name from
 * looking runnable just because one of its matching agents happens to be
 * live; only an exact stable id may choose one member of that set.
 */
function hasAmbiguousDisplayMention(text: string, agents: readonly AgentDef[]): boolean {
  const matches: Array<{ start: number; end: number }> = [];
  for (const agent of agents) {
    const re = new RegExp(`@${escapeRegExp(agent.name)}(?![\\w-])`, "gi");
    for (const match of text.matchAll(re)) {
      const start = match.index ?? -1;
      if (start >= 0) matches.push({ start, end: start + match[0].length });
    }
  }
  // Overlapping matches represent one visible mention resolving to multiple
  // room agents (including duplicate names and prefix collisions). Distinct
  // mentions, such as `@Scout @Builder`, remain an intentional multi-route
  // message and are not considered ambiguous here.
  for (let i = 0; i < matches.length; i++) {
    for (let j = i + 1; j < matches.length; j++) {
      if (matches[i]!.start < matches[j]!.end && matches[j]!.start < matches[i]!.end) return true;
    }
  }
  return false;
}

/**
 * Decide whether the primary control may truthfully say "Run".
 *
 * The engine's actual explicit invocation boundaries are used here:
 * `extractMentions` is the relay's room-directory matcher, and
 * `parseComposerCommand` is the shared slash-command parser. A command with no
 * explicit in-room route is deliberately treated as Send because the engine
 * then falls back to persona relevance and may choose nobody; the UI cannot
 * honestly promise a run from the command spelling alone.
 */
export function composerIntent(input: ComposerIntentInput): ComposerIntent {
  if (!input.text.trim() || input.available === false) return "send";
  const usable = usableAgents(input);
  if (usable.length === 0) return "send";
  if (input.direct) {
    // DMs invoke their sole room agent for ordinary text, but an ambiguous
    // visible target is still not a truthful route even in a direct form.
    return hasAmbiguousDisplayMention(input.text, input.roomAgents) ? "send" : "run";
  }

  const parsed = parseComposerCommand(input.text, {
    agentNames: input.roomAgents.map(agent => agent.name),
    agentIds: input.roomAgents.map(agent => agent.id),
  });
  if (parsed) {
    const routeToken = parsed.name === "assign" ? parsed.target : parsed.routeTarget;
    const routed = exactAgent(routeToken, input.roomAgents);
    if (routeToken) {
      // An exact id is the only route key allowed to disambiguate duplicate
      // display names.  A duplicate display target must never fall through to
      // ordinary mention extraction, even when one matching agent is paused.
      if (routed) return usable.some(agent => agent.id === routed.id) ? "run" : "send";
      return "send";
    }
    if (parsed.name === "assign") return "send";
    if (hasAmbiguousDisplayMention(input.text, input.roomAgents)) return "send";
    const directory = input.roomAgents.map(agent => ({ id: agent.id, name: agent.name }));
    const mentioned = new Set(extractMentions(input.text, directory));
    return usable.some(agent => mentioned.has(agent.id)) ? "run" : "send";
  }
  // A malformed/unknown slash command is still ordinary text in the engine;
  // do not let an @ name elsewhere in it turn that failed command into Run.
  if (/^\/(?:summarize|plan|review|ship|assign)(?:\s|$)/i.test(input.text.trimStart())) return "send";
  if (hasAmbiguousDisplayMention(input.text, input.roomAgents)) return "send";

  const directory = input.roomAgents.map(agent => ({ id: agent.id, name: agent.name }));
  const mentioned = new Set(extractMentions(input.text, directory));
  return usable.some(agent => mentioned.has(agent.id)) ? "run" : "send";
}
