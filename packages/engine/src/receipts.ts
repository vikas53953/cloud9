// WHAT THE TURN ACTUALLY DID → THE ONE TICK IT LEAVES BEHIND (his §2).
//
// ONE PURE FUNCTION, ONE RULE PER PARAGRAPH, SO IT CAN BE ARGUED WITH. This is
// the whole of the "context-derived emoji" decision. It is deliberately not a
// prompt: nothing here asks the model how it feels about its own answer. A
// model that picked its own tick would be making a claim about itself that
// nobody checked — the same failure as an agent writing its own approval card
// — and the tick would be worth nothing the first time it was flattering.
//
// So every rule below reads a FACT the engine already holds after the turn:
// the outcome it recorded, the steps the CLI reported, and the reply text it
// is about to post. No guessing, no timing heuristics, no sentiment.
//
// AND WHEN THERE IS NOTHING HONEST TO SAY, IT SAYS NOTHING. `undefined` is a
// real answer here and callers must send no receipt for it. A cheerful ✅ on a
// turn that produced no reply is exactly the "never imply a decision was made"
// failure his spec calls out.
import type { RunOutcome, RunStep } from "@cloud9/shared";
import type { ReceiptVerdict } from "@cloud9/shared";

/**
 * Everything the rules are allowed to look at. Nothing else is in scope — if a
 * fact is not on this object, no rule may use it.
 */
export interface TurnFacts {
  /** what the run record says happened */
  outcome: RunOutcome;
  /** the reply the turn is about to post. Absent/empty means it produced none. */
  reply?: string;
  /** what the CLI reported doing, in order. Empty is normal for a plain chat turn. */
  steps?: readonly RunStep[];
  /** a turn-level failure the CLI reported, or the error we recorded */
  error?: string;
}

/** Steps that mean the agent WENT AND LOOKED rather than answered from memory. */
const LOOKING: ReadonlySet<RunStep["kind"]> = new Set(["read", "search", "web"]);

/**
 * THE MAPPING. Read it top to bottom; the first rule that fires wins, and the
 * order is the argument.
 */
export function turnVerdict(facts: TurnFacts): ReceiptVerdict | undefined {
  const reply = (facts.reply ?? "").trim();

  // RULE 1 — CANCELLED IS NOT A VERDICT.
  // The owner pulled the plug. The turn never committed to anything, so there
  // is no honest answer to show and we show none. Silence here is the truth.
  if (facts.outcome === "cancelled") return undefined;

  // RULE 2 — IT REFUSED, IT FELL OVER, OR THE CLI REPORTED A FAILURE ⇒ ⚠️.
  // "conflict found" covers both halves of the same thing a person needs to
  // know: the ask did not go through cleanly. A failed turn that still says
  // something in chat is still a ⚠️ — the words are the apology, the tick is
  // the state.
  if (facts.outcome === "failed" || (facts.error ?? "").trim() !== "") return "conflict";

  // RULE 3 — IT SUCCEEDED BUT SAID NOTHING ⇒ NO VERDICT.
  // An empty reply on an `ok` run is a turn we cannot characterise. There is
  // no rule that could honestly fire, so none does.
  if (reply === "") return undefined;

  // RULE 4 — IT ASKED A QUESTION BACK ⇒ ❓.
  // Checked BEFORE "it investigated", on purpose: a turn that searched three
  // files and then asked which one he meant is WAITING ON A PERSON, and that
  // is the more useful thing to show. `endsWithQuestion` owns what counts.
  if (endsWithQuestion(reply)) return "needsInput";

  // RULE 5 — IT WENT AND LOOKED, AND CAME BACK WITH SOMETHING ⇒ 🔍.
  // Reads, searches and web lookups only. A `command` or a `write` is doing,
  // not investigating, and a `thinking` step is not evidence of anything —
  // every turn thinks.
  if ((facts.steps ?? []).some(s => LOOKING.has(s.kind))) return "investigating";

  // RULE 6 — OTHERWISE ⇒ ✅.
  // A turn that ran clean, answered, asked nothing back and looked nothing up.
  // This is the ONLY default, and it is only reached after every rule above
  // declined — it is never a fallback for "we could not tell".
  return "agreed";
}

/**
 * DID THE TURN END BY ASKING SOMETHING?
 *
 * The LAST non-empty line, ending in a question mark. The last line and not
 * "contains a ?" — a reply that quotes his question back in its first sentence
 * and then answers it is not asking anything, and marking it ❓ would send him
 * back to a message that needs nothing from him.
 *
 * Trailing markdown noise (a bare `**`, a list dash, a closing quote or code
 * fence) is stripped before the check, because CLIs commonly wrap the closing
 * question in emphasis.
 */
export function endsWithQuestion(reply: string): boolean {
  const lines = reply.split("\n").map(l => l.trim()).filter(l => l !== "");
  const last = lines[lines.length - 1];
  if (!last) return false;
  const bare = last.replace(/[*_`~"')\]\s]+$/u, "");
  return bare.endsWith("?");
}
