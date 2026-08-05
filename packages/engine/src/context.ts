// WHAT THE CONVERSATION LOOKS LIKE TO AN AGENT — one owner, one budget.
//
// THE BUG THIS EXISTS TO MAKE IMPOSSIBLE (docs/qa/gap-audit.md §2.1). An agent's
// whole view of the room was this line, in the middle of engine.ts:
//
//     history.slice(-n).map(m => `${m.authorName}: ${m.text}`).join("\n")
//
// with `n = this.opts.contextMessages ?? 20`, and `contextMessages` set in
// exactly zero places in the repository. Three separate faults in one line:
//
//  1. **Twenty messages, chosen by nobody.** The auditor put "the file is
//     already on disk at report.md — read it, do not rewrite it" as message 1 of
//     32; the prompt that reached the agent began at message 13. Vikas had to
//     say the same thing four times because his agent could no longer see him
//     saying it. Twenty short messages is a keyhole; twenty long ones is not a
//     keyhole at all. Counting MESSAGES is the wrong unit.
//  2. **Everything but the name and the words was thrown away.** A message
//     carrying `budget-q3.xlsx` reached the agent as the words "here is the
//     spreadsheet" and nothing else. Threads — which are the app's own way of
//     saying "this bit is a side conversation" — arrived flattened into the main
//     run of talk.
//  3. **Nowhere to fix it.** The rule was an inline default argument, so there
//     was no name to search for and nothing to write a justification against.
//
// So: the window is a NAMED BUDGET IN CHARACTERS, the rendering is one exported
// function, and the two facts that cost nothing to carry — attachment names and
// thread structure — are carried.
//
// NOT IN SCOPE, deliberately: memory between conversations. This widens the
// window on ONE conversation. It does not remember yesterday's.
import { Message } from "@cloud9/shared";

/**
 * How much conversation an agent is given.
 *
 * **Why characters and not messages.** A model's limit is tokens, and a token is
 * roughly four characters of English chat. Twenty messages can be 200 characters
 * or 200,000 — the old count could not tell the difference, so it was either far
 * too little (the common case, and the bug above) or, on a long paste, enough to
 * push everything else out of the prompt. A character budget is the same size
 * every time, whatever shape the talk is.
 *
 * **Why 24,000.** That is roughly 6,000 tokens. Every model Cloud9 can run an
 * agent on has a window of at least 200,000, so the conversation costs about 3%
 * of the smallest one and leaves the brief, the skills and the agent's own
 * working room untouched. It is also, measured against ordinary chat of about
 * 120 characters a message, something like 200 messages — ten times the old
 * keyhole, which is what "the file's on disk" needed to survive.
 *
 * **Why a message ceiling as well.** A room of one-word messages would spend
 * 24,000 characters on two thousand lines, which is a wall of noise rather than
 * context. 200 messages is where a conversation stops being recent.
 *
 * **Why not bigger.** Cost. Every character here is re-sent on every single turn
 * — Cloud9 keeps no session, so there is no cache to lean on — and it is Vikas's
 * own subscription paying. Widening this further should be a decision somebody
 * makes on purpose, which is why it is a named constant and not a default
 * argument buried in a method.
 */
export const CONVERSATION_BUDGET = {
  /** the most characters of rendered conversation an agent is given */
  characters: 24_000,
  /** the most messages, however short they are */
  messages: 200,
} as const;

export interface ConversationBudget {
  characters: number;
  messages: number;
}

/**
 * The conversation as an agent reads it: oldest first, newest always kept.
 *
 * The budget is spent from the NEWEST end backwards, so the thing just said is
 * never the thing that gets dropped. A single message longer than the whole
 * budget is still included — truncated, and it says so — because dropping it
 * would leave the agent answering a question it cannot see.
 */
export function renderConversation(
  messages: readonly Message[],
  budget: ConversationBudget = CONVERSATION_BUDGET,
): string {
  const byId = new Map(messages.map(m => [m.id, m]));
  const kept: string[] = [];
  let spent = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (kept.length >= budget.messages) break;
    let line = renderMessage(messages[i], byId);
    if (spent > 0 && spent + line.length + 1 > budget.characters) break;
    if (line.length > budget.characters) {
      line = line.slice(0, budget.characters) + " …(this message was too long to show in full)";
    }
    kept.push(line);
    spent += line.length + 1;
  }
  return kept.reverse().join("\n");
}

/**
 * One message, with the two facts that used to be thrown away.
 *
 * A THREAD REPLY IS INDENTED AND NAMES WHAT IT ANSWERS. Cloud9's threads are one
 * level deep by construction, so an indent is the whole of the structure — there
 * is no tree to draw. When the parent is inside the window the reply names it by
 * author, which is what a person reading the room would see.
 *
 * AN ATTACHMENT IS NAMED, AND THE NAME IS NOW A HANDLE. Naming it costs nothing
 * and is the difference between "here is the spreadsheet" meaning nothing and
 * meaning something. Until 2026-08-05 that was the whole of it, and this comment
 * said so: "never opened … Cloud9 supplies no tool to read one yet". The doorway
 * is now built — `open_attachment` in `cloud9tools.ts` takes exactly this name
 * and hands back what is in the file.
 *
 * THE NAME IS STILL ALL THIS FUNCTION SAYS, on purpose. Whether the agent can
 * really open it is a fact about the TURN, not about the message: the doorway is
 * only in an agent's hands when Cloud9's tools were actually supplied for that
 * turn. So the sentence "you can open these" lives on the tool row that owns it
 * and is printed only when the tool is truly there. Printing it here would put
 * the same promise in front of an agent that has no way to keep it — which is
 * precisely the fault `abilities.ts` was written to make impossible.
 */
function renderMessage(m: Message, byId: Map<string, Message>): string {
  const parts: string[] = [];
  if (m.replyTo) {
    const parent = byId.get(m.replyTo);
    parts.push(parent
      ? `  ↳ (in a thread under ${parent.authorName}'s message) `
      : `  ↳ (a reply in a thread that started earlier) `);
  }
  parts.push(`${m.authorName}: ${m.deletedAt ? "(this message was deleted)" : m.text}`);
  if (m.editedAt) parts.push(" (edited)");
  const files = (m.attachments ?? []).map(a => a.name).filter(Boolean);
  if (files.length > 0) parts.push(`  [files attached to this message: ${files.join(", ")}]`);
  if (m.replyCount) {
    parts.push(`  [${m.replyCount} ${m.replyCount === 1 ? "reply" : "replies"} in a thread under this]`);
  }
  return parts.join("");
}
