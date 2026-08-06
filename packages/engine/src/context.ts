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
import { contextWindowTokens, ID, Message } from "@cloud9/shared";

/**
 * How much conversation an agent is given, WHEN NOBODY KNOWS WHAT MODEL IT IS
 * RUNNING ON. The floor, in other words — not the rule any more.
 *
 * **Why characters and not messages.** A model's limit is tokens, and a token is
 * a couple of characters of chat. Twenty messages can be 200 characters
 * or 200,000 — the old count could not tell the difference, so it was either far
 * too little (the common case, and the bug above) or, on a long paste, enough to
 * push everything else out of the prompt. A character budget is the same size
 * every time, whatever shape the talk is.
 *
 * **Why 24,000 is now the floor and not the answer.** It was a constant, and a
 * constant cannot follow the model. `conversationBudgetFor` below is the rule;
 * this is what it falls back to when the model is one nobody has measured, which
 * is exactly today's behaviour and therefore cannot be a regression.
 *
 * **Why a message ceiling as well.** A room of one-word messages would spend
 * the whole character budget on thousands of lines, which is a wall of noise
 * rather than context. The ceiling scales with the characters, see below.
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
 * THE RULE FOR THE NUMBER, and it has one owner: this function.
 *
 * ------------------------------------------------------------------ THE FACTS
 * Everything below was measured on this machine on 2026-08-05. Nothing here is
 * a rule of thumb somebody remembered.
 *
 *  1. **A character of Cloud9 chat is about 0.4 of a token, not 0.25.** The old
 *     comment in this file said "a token is roughly four characters of English
 *     chat" and used it to call 24,000 characters "about 6,000 tokens, roughly
 *     3% of the smallest window". Put through the real CLI on the owner's real
 *     room, 24,000 characters of it is 9,730 tokens — 2.47 characters per
 *     token. Names, ids, punctuation and short lines tokenise far worse than
 *     prose. So the old figure understated its own cost by 60%.
 *
 *  2. **What a turn actually costs**, `claude -p --output-format json` on
 *     Sonnet 5, same prompt, only the amount of conversation changed:
 *
 *         none      →     510 tokens   $0.0022
 *         24,000 ch →   9,730 tokens   $0.066     ← what Cloud9 charges today
 *         60,000 ch →  23,891 tokens   $0.162
 *        120,000 ch →  47,265 tokens   $0.284
 *        200,000 ch →  78,383 tokens   $0.530
 *
 *  3. **The keyhole is already closing on real rooms.** The owner's busiest
 *     room holds 175 messages. Rendered whole it is 21,034 characters — 88% of
 *     today's budget — at an average of 120 characters a message. Its next
 *     twenty-five messages hit the 200-message ceiling and the character
 *     ceiling within a few messages of each other. Nothing of his has been cut
 *     yet; everything of his is about to be.
 *
 * ------------------------------------------------------------------- THE RULE
 * **An eighth of whatever the model can hold**, converted at 2.5 characters per
 * token, with a floor and a ceiling.
 *
 *   characters = clamp( window × 0.125 × 2.5 , 24,000 , 120,000 )
 *
 *   a 200,000-token model  →  62,500 characters  (~25,000 tokens, ~$0.17)
 *   a 272,000-token model  →  85,000 characters  (~34,000 tokens)
 *   a 1,000,000-token model → 120,000 at the ceiling (~47,000 tokens, ~$0.28)
 *
 * **Why an eighth.** The conversation is one of four things sharing the window:
 * the agent's brief and its skills, the room, the files and command output it
 * reads during the turn, and its own answer. A share means the biggest of those
 * — what it reads while working — keeps seven eighths whatever model it is on,
 * so a wider window buys the agent more room to work AND more room to remember,
 * in the same proportion, instead of the room silently eating the work.
 *
 * **Why a floor of 24,000.** It is exactly today's number. A model nobody has
 * measured, or an agent with no model at all, gets precisely what it gets now.
 * This change can widen an agent's view; it cannot narrow one.
 *
 * **Why a ceiling of 120,000.** Cost, and it is the owner's own subscription.
 * A million-token model would otherwise be handed 312,500 characters — around
 * $0.80 a turn on today's prices for a room that has never been longer than
 * 21,034 characters. The ceiling is five times the largest real room on this
 * machine, so it is the ROOM that runs out first and not the budget, which is
 * the whole point; and it caps the damage of an agent parked in a very long
 * conversation at about $0.28 a turn.
 *
 * **What softens the cost.** `sessionresume.ts` — the second and later turns in
 * a thread send only what is new, because the harness's own session already
 * holds the rest. So a bigger budget is paid on the FIRST turn of a thread and
 * then largely not again. Cold turns (a scheduled check-in, a delegated job, a
 * repository turn, a room message that is not in a thread) still pay it every
 * time, which is why there is a ceiling at all.
 *
 * **Why a function and not a bigger constant.** The number has to follow the
 * model — that is the actual fix. A 200,000-token model and a 1,000,000-token
 * model should not be fed the same 24,000 characters because a constant says
 * so. One function, one rule, one place to argue with it.
 */
export const CONVERSATION_BUDGET_RULE = {
  /** the share of the model's window the conversation may have */
  shareOfWindow: 0.125,
  /** measured on this owner's own chat: 24,000 characters = 9,730 tokens */
  charactersPerToken: 2.5,
  /** never smaller than this — exactly today's behaviour */
  floorCharacters: 24_000,
  /** never larger than this — the owner's subscription pays for every character */
  ceilingCharacters: 120_000,
  /** the measured average rendered length of one message in his busiest room */
  charactersPerMessage: 120,
} as const;

/**
 * THE MOST MESSAGES ANY BUDGET CAN EVER ASK FOR, and therefore the fewest the
 * engine has to keep in memory for a room.
 *
 * It is derived, not chosen. The engine kept the last 300 messages of each room
 * — a number picked when the budget was a flat 200, so it comfortably covered
 * it. With the budget following the model, a million-token model asks for 1,000
 * messages, and a 300-message ring would have silently capped it at 300: a new
 * limit nobody wrote down, in a different file from the rule. Deriving it here
 * means the ring can never again be quietly smaller than the budget.
 */
export function maxConversationMessages(): number {
  const r = CONVERSATION_BUDGET_RULE;
  return Math.max(
    CONVERSATION_BUDGET.messages,
    Math.round(r.ceilingCharacters / r.charactersPerMessage),
  );
}

/**
 * The budget for an agent running on this model. See the rule above.
 *
 * `harness` is only consulted when the agent named no model at all: it is still
 * running on SOMETHING, and the smallest model that harness offers is the
 * honest guess for it (`contextWindowTokens` in shared owns that decision).
 */
export function conversationBudgetFor(
  model?: string, harness?: string,
): ConversationBudget {
  const r = CONVERSATION_BUDGET_RULE;
  const window = contextWindowTokens(model, harness);
  if (!window) return CONVERSATION_BUDGET;
  const wanted = Math.round(window * r.shareOfWindow * r.charactersPerToken);
  const characters = Math.min(Math.max(wanted, r.floorCharacters), r.ceilingCharacters);
  return {
    characters,
    // The message ceiling is not a second opinion — it is the character budget
    // read in messages, so the two can never disagree about how big "recent" is.
    messages: Math.max(
      CONVERSATION_BUDGET.messages,
      Math.round(characters / r.charactersPerMessage),
    ),
  };
}

/**
 * WHICH THREAD THIS TURN IS ANSWERING IN, when it is answering in one.
 *
 * The engine already knows this — `threads.ts` reads it off the message being
 * answered so it can decide where the ANSWER goes. Until 2026-08-05 that was
 * the only thing it was used for: the answer went into the thread and the
 * context handed to the agent was the whole room, flat, newest-first, with the
 * thread's own earlier messages competing against room chatter for the same
 * budget. An agent could be dropped into a thread and not be given the start of
 * the thread it was standing in.
 */
export interface ConversationScope {
  /** the thread root the turn is answering under, from `threadOf` */
  thread?: ID;
}

/**
 * The conversation as an agent reads it: oldest first, newest always kept.
 *
 * The budget is spent from the NEWEST end backwards, so the thing just said is
 * never the thing that gets dropped. A single message longer than the whole
 * budget is still included — truncated, and it says so — because dropping it
 * would leave the agent answering a question it cannot see.
 *
 * THE THREAD IS SERVED FIRST, when there is one (`scope.thread`). The budget is
 * spent in two passes over the same room: the thread being answered, newest
 * first, and then everything else, newest first, into whatever is left. The
 * result is still printed in the order it was said, so nothing about the shape
 * of the conversation changes — the ONLY thing that changes is which messages
 * survive a budget too small to hold all of them.
 *
 * NOTHING IS DROPPED THAT WAS NOT ALREADY BEING DROPPED. A room that fits
 * inside the budget renders character-for-character as it did before, thread or
 * no thread; both passes simply keep everything. It is an ORDERING, not a
 * filter.
 *
 * AND THE MESSAGE BEING ANSWERED IS ALWAYS IN THE FIRST PASS. `threadOf` returns
 * the trigger's own thread root — which is the trigger itself when it was said
 * in the room — so the question an agent is answering can never be the thing the
 * budget throws away, whichever pass is spending it.
 */
export function renderConversation(
  messages: readonly Message[],
  budget: ConversationBudget = CONVERSATION_BUDGET,
  scope: ConversationScope = {},
): string {
  const byId = new Map(messages.map(m => [m.id, m]));
  const lines = messages.map(m => renderMessage(m, byId));
  const keep = new Set<number>();
  let spent = 0;
  let kept = 0;

  /** Spend what is left on these messages, newest first. Stops at the first miss. */
  const pass = (wanted: (index: number) => boolean): void => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (kept >= budget.messages) return;
      if (keep.has(i) || !wanted(i)) continue;
      const line = lines[i];
      if (spent > 0 && spent + line.length + 1 > budget.characters) return;
      keep.add(i);
      kept += 1;
      spent += line.length + 1;
    }
  };

  const root = scope.thread;
  if (root) pass(i => inThread(messages[i], root));
  pass(() => true);

  const out: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!keep.has(i)) continue;
    const line = lines[i];
    out.push(line.length > budget.characters
      ? line.slice(0, budget.characters) + " …(this message was too long to show in full)"
      : line);
  }
  return out.join("\n");
}

/**
 * Is this message part of that thread? The same one-level rule `threads.ts`
 * owns, read from the other side: a thread is its root message plus every
 * message stored as a reply to that root.
 */
function inThread(m: Message, root: ID): boolean {
  return m.id === root || m.replyTo === root;
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
