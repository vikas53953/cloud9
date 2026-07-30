// THE ONE OWNER OF "NO" ON THE HUB.
//
// THE LEAK THIS CLOSES (docs/qa/gap-audit.md §4.1, and it was photographed —
// `docs/qa/gap-audit-error-prefix.png`). Every request from every screen was
// wrapped in:
//
//     catch (err) { send(ws, { type: "error", error: String(err) }); }
//
// `String(err)` on an exception is `"Error: " + message`. So a hand-written,
// plain-English refusal — *you already have a project called "Audit Box" — give
// this one a different name* — arrived at the screen with the word **Error:**
// stuck on the front. The toast stripped it (`plainError` in App.tsx); the line
// under the form did not. The same refusal appeared twice on one screen in two
// different states of politeness, and one of them showed a non-developer the
// word "Error:" as though it were part of what went wrong.
//
// And that is only the polite half. The catch-all is not limited to sentences
// somebody wrote: any unexpected bug on the hub went out of the same hole, so a
// `TypeError: Cannot read properties of undefined (reading 'name')` was one
// mistake away from being printed under a form in Vikas's app.
//
// THE CLASS RULE, and it is one line: **nothing on the hub turns an exception
// into text except this file.** Two things follow from that, and neither is
// optional:
//
//   1. A prefix like `Error:`, `TypeError:` or a stack trace can never reach a
//      screen, because the only function that could produce one strips them.
//   2. An exception that was NOT a written refusal never has its own words
//      shown at all. It is replaced by a sentence a person can act on. Raw
//      internals do not become "helpful detail" just because they are short.
//
// This is the same law `sanitizeForChat` already enforces on the engine side,
// applied to the other half of the app. The two are deliberately separate
// functions because they answer to different audiences — one writes into a chat
// room everybody can read, this one answers the person who just pressed a
// button — but they agree on the thing that matters: raw error text is never
// shown, and the detail goes to the console for whoever is running the app.

/**
 * A refusal somebody WROTE, for a person to read. Thrown anywhere on the hub,
 * its message reaches the screen unchanged.
 *
 * The ~70 hand-written refusals the hub already has (*"that's too many files
 * (max 4)"*, *"only the owner of this Cloud9 can invite someone"*) are plain
 * English and often excellent — the audit said so explicitly. They are thrown as
 * ordinary `Error`s today, and rewriting all of them was not the fix: the fix is
 * that ALL error text now goes through `refusalText`, which strips the prefix
 * whatever the class. This class exists so that new code can say "this sentence
 * is for a person" out loud, and so a future rule that hides unwritten errors
 * entirely has something to test against.
 */
export class Refusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Refusal";
  }
}

/**
 * What the last resort says when something broke that nobody wrote a sentence
 * for. It names the one thing the person can do, and it does not pretend to
 * know more than it does.
 */
export const UNEXPECTED_REFUSAL =
  "something went wrong inside Cloud9 and that didn't happen — try again, and if it " +
  "keeps happening the details are in the app's log.";

/**
 * TURN A THROWN THING INTO A SENTENCE FOR A SCREEN. The only place on the hub
 * where that conversion happens.
 *
 * `where` is for the console, never for the screen.
 */
export function refusalText(err: unknown, where = "handling a request"): string {
  const said = plainWords(err);
  // The whole detail, for the person running the app. The screen gets the
  // sentence; the console gets the object.
  if (!said) console.error(`[relay] ${where}:`, err);
  return said ?? UNEXPECTED_REFUSAL;
}

/**
 * The sentence inside a thrown thing, if it really is a sentence for a person —
 * otherwise nothing, and the caller says the last-resort line instead.
 *
 * WHAT COUNTS AS COMPUTER-SPEAK, and every one of these has been seen:
 *  - a class name in front of the words: `TypeError: …`, `SqliteError: …`
 *  - a stack trace stapled on the end
 *  - a bare error code: `SQLITE_CORRUPT`, `ENOENT`, `ECONNRESET`
 *  - something that is not an Error at all
 */
function plainWords(err: unknown): string | undefined {
  // WHO THREW IT DECIDES FIRST. The hub's own refusals are thrown as `Error`
  // (the ~70 hand-written ones) or `Refusal` (new code saying so out loud).
  // ANYTHING with a class name of its own — `TypeError`, `SqliteError`,
  // `AssertionError` — is machinery talking, and machinery does not get to
  // write on his screen however readable its sentence happens to look.
  if (err instanceof Error && err.name !== "Error" && err.name !== "Refusal") return undefined;
  const raw = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  // one line only: a stack trace is never part of a sentence
  const first = raw.split(/\r?\n/)[0].trim();
  if (!first) return undefined;
  // `Error:`, `TypeError:`, `SqliteError:` — the prefix that reached his screen
  const stripped = first.replace(/^(?:[A-Za-z_$][\w$]*)?(?:Error|Exception):\s*/, "").trim();
  if (!stripped) return undefined;
  // a bare error code is not English
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(stripped)) return undefined;
  // Nothing shown to a person should carry a path off this machine's disk.
  if (/[A-Za-z]:\\|(^|\s)\/(usr|home|Users|var|tmp)\//.test(stripped)) return undefined;
  return stripped;
}
