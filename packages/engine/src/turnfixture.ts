// A TurnBrief for tests, so a prompt test says what it is testing and nothing
// else. NOT used by the app: every real caller builds a brief from a real turn,
// which is the whole point of `TurnBrief` existing.
import { TurnBrief } from "./provider.js";

export function aTurn(context: string, over: Partial<TurnBrief> = {}): TurnBrief {
  return {
    context,
    trigger: "what's the going rate for a Goa villa?",
    triggerAuthor: "Vikas",
    kind: "chat",
    ...over,
  };
}
