/**
 * The small, product-owned command language that lives in the chat composer.
 *
 * These are deliberately not the harness's own slash commands.  They are
 * Cloud9 messages which the engine translates into an existing, permissioned
 * turn path.  Keeping the grammar here gives the desktop and engine one
 * answer about what a slash command is; the relay continues to carry ordinary
 * message text and therefore does not need a second command protocol.
 */

export const COMPOSER_COMMAND_NAMES = [
  "summarize", "plan", "review", "ship", "assign",
] as const;

export type ComposerCommandName = typeof COMPOSER_COMMAND_NAMES[number];

export interface ParsedComposerCommand {
  name: ComposerCommandName;
  /** text after the command, without a leading target mention */
  argument?: string;
  /** `/assign @Agent work` only; absent for every other command */
  target?: string;
  /** exact leading room-agent name/id used to route non-assign commands */
  routeTarget?: string;
}

/** Room names are user data, not identifier-shaped tokens. Supplying the
 * current room directory lets the parser match a complete name (including
 * spaces, punctuation, and emoji) before it falls back to the stable-id form.
 */
export interface ComposerCommandParseOptions {
  agentNames?: readonly string[];
  agentIds?: readonly string[];
}

const COMMAND_RE = /^\/(summarize|plan|review|ship|assign)(?:\s+([\s\S]*?))?$/i;
const SIMPLE_TARGET_RE = /^@([\w-]+)\s+([\s\S]+)$/;

function exactTarget(
  tail: string,
  candidates: readonly string[],
): { target: string; argument: string } | undefined {
  // Longest-first prevents a valid `Data` member from stealing the prefix of
  // the equally valid `Data Scout` member. Duplicate names are ambiguous and
  // therefore fail closed rather than assigning to an arbitrary agent.
  const matches = candidates.filter(name => name.trim())
    .sort((a, b) => b.length - a.length)
    .filter(name => {
      if (tail.length <= name.length + 1 || tail[0] !== "@") return false;
      const rest = tail.slice(name.length + 1);
      return tail.slice(1, name.length + 1).toLocaleLowerCase() === name.toLocaleLowerCase()
        && /^\s/.test(rest) && rest.trim().length > 0;
    });
  if (matches.length === 0) return undefined;
  const chosen = matches[0]!;
  const argument = tail.slice(chosen.length + 1).trim();
  // Two candidates differing only by case are still the same visible target.
  return { target: chosen, argument };
}

function stripLeadingMention(text: string, candidates: readonly string[]): { text: string; target?: string } {
  if (candidates.length === 0) return { text: text.replace(/^(?:@[\w-]+\s+)+/, "") };
  let out = text;
  let target: string | undefined;
  // A composer-selected agent can precede the slash command. Repeated exact
  // matches are accepted for compatibility with the existing mention router.
  while (true) {
    // For a leading mention there is no work argument. Match the candidate
    // directly and require the slash to follow it, preserving all other text.
    const match = [...candidates]
      .filter(name => name.trim())
      .sort((a, b) => b.length - a.length)
      .find(name => out.length > name.length + 2
        && out[0] === "@"
        && out.slice(1, name.length + 1).toLocaleLowerCase() === name.toLocaleLowerCase()
        && /^\s+\//.test(out.slice(name.length + 1)));
    if (!match) {
      // Keep an unknown simple token as an explicit route target. The engine
      // can then issue one visible refusal; dropping it here would let the
      // message fall through to persona relevance and look like ordinary chat.
      const unknown = /^@([\w-]+)\s+\//.exec(out);
      if (unknown) return { text: out.slice(unknown[0].indexOf("/")).trimStart(), target: target ?? unknown[1] };
      return target ? { text: out, target } : { text: out };
    }
    target ??= match;
    out = out.slice(match.length + 1).trimStart();
  }
}

/**
 * Parse one Cloud9 composer command.  A leading `@Agent` is allowed because
 * the composer writes the room's selected agent before the command.  This is
 * still an exact command: the slash word is preserved and the engine decides
 * whether that room member may drive it.
 *
 * Invalid or incomplete commands return `undefined`; callers must leave the
 * message as ordinary chat rather than inventing a partial action.
 */
export function parseComposerCommand(
  value: unknown,
  options: ComposerCommandParseOptions = {},
): ParsedComposerCommand | undefined {
  if (typeof value !== "string") return undefined;
  let text = value.trim();
  // The mention is routing metadata, not part of the command.  Strip only
  // leading mentions so an @ in the command's prose remains untouched.
  const routed = stripLeadingMention(text, [...(options.agentNames ?? []), ...(options.agentIds ?? [])]);
  text = routed.text;
  const match = COMMAND_RE.exec(text);
  if (!match) return undefined;

  const name = match[1].toLowerCase() as ComposerCommandName;
  const tail = (match[2] ?? "").trim();
  if (name === "assign") {
    const target = exactTarget(tail, options.agentNames ?? []);
    if (target) return {
      name, target: target.target, argument: target.argument,
      ...(routed.target ? { routeTarget: routed.target } : {}),
    };
    const stableTarget = SIMPLE_TARGET_RE.exec(tail);
    if (!stableTarget || !stableTarget[2].trim()) return undefined;
    const token = stableTarget[1]!;
    // Preserve the explicit target token even when it is only a prefix of a
    // spaced room name. The engine resolves the complete token against the
    // room roster and refuses it visibly; dropping it here would reinterpret a
    // command-shaped message as ordinary chat.
    const canonicalId = options.agentIds?.find(id => id.toLocaleLowerCase() === token.toLocaleLowerCase());
    return {
      name, target: canonicalId ?? token, argument: stableTarget[2].trim(),
      ...(routed.target ? { routeTarget: routed.target } : {}),
    };
  }
  if ((name === "plan" || name === "review" || name === "ship") && !tail) {
    return undefined;
  }
  return {
    name, ...(tail ? { argument: tail } : {}),
    ...(routed.target ? { routeTarget: routed.target } : {}),
  };
}

/** Command names as slash spellings, for menus and drift checks. */
export const COMPOSER_COMMAND_SPELLINGS = COMPOSER_COMMAND_NAMES.map(name => `/${name}` as const);
