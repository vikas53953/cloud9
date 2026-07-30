// "When a job finishes, say so and summarise it" — his item 3.
//
// HE AGREED THE AGENT SHOULD WRITE IT, so the first half of this sentence is
// the agent's OWN words: the opening sentence of what it reported back. The
// second half is the only thing the agent cannot be trusted to say about
// itself — what it actually did — and that comes from the run record, which is
// measured rather than claimed.
//
// THE HONESTY RULE from `runrecord.ts` applies unchanged and is the reason this
// file is so short:
//  • no number appears here that the record did not measure. The step counts,
//    the duration and the cost all come from `summarizeRun` in shared, which is
//    the one owner of "what did this run do, in words";
//  • when there is nothing honest to say, the answer is UNDEFINED. A job that
//    left no words and did no recorded work gets no summary, and the screen
//    shows nothing rather than a sentence that means nothing;
//  • a cancelled job gets no summary at all. "You stopped it" is already on the
//    task's own status, and anything added to that would be decoration.
import { RunRecord, TASK_LIMITS, countSteps, summarizeRun } from "@cloud9/shared";

/** How much of the agent's own opening sentence survives into the summary. */
export const TLDR_HEADLINE_MAX = 220;

/**
 * The short TLDR for one finished job.
 *
 * `reply` is what the agent actually said when it reported back — the same text
 * that goes into the task's result. Absent, empty, or nothing but code and the
 * summary falls back to the measured half alone; absent AND nothing measured
 * and there is no summary, which is the point.
 */
export function taskTldr(record: RunRecord, reply?: string): string | undefined {
  if (record.outcome === "cancelled") return undefined;

  const headline = headlineOf(reply);
  const didSomething = anyStepsCounted(record);

  if (record.outcome === "failed") {
    // the run sentence carries the reason the CLI gave, already redacted
    const why = summarizeRun(record);
    return clip(headline ? `${headline} ${why}` : why, TASK_LIMITS.summary);
  }

  if (!headline && !didSomething) return undefined;
  const measured = summarizeRun(record);
  return clip(headline ? `${headline} ${measured}` : measured, TASK_LIMITS.summary);
}

/**
 * The agent's own opening sentence, with the markdown taken off.
 *
 * It reads the first line that is actually prose: headings, bullets, numbering
 * and fenced code are stepped over rather than quoted back, because "```" is
 * not a summary of anything.
 */
export function headlineOf(reply: string | undefined): string | undefined {
  if (!reply) return undefined;
  const prose = reply.replace(/```[\s\S]*?```/g, " ");
  for (const raw of prose.split(/\r?\n/)) {
    // a heading is a label for what follows, not a summary of it — "## Result"
    // tells him nothing, so step over it and take the sentence underneath
    if (/^\s*#{1,6}\s/.test(raw)) continue;
    const line = raw
      .replace(/^\s*(?:[>*+-]+|\d+[.)])\s+/, "")    // quote, bullet, numbering
      .replace(/[*_`]/g, "")                        // emphasis marks
      .trim();
    if (!line) continue;
    const stop = /(?<=[.!?])\s/.exec(line);
    const sentence = (stop ? line.slice(0, stop.index) : line).trim();
    if (!sentence) continue;
    return clip(sentence, TLDR_HEADLINE_MAX);
  }
  return undefined;
}

/** Did the record catch the agent doing anything at all we can name? */
function anyStepsCounted(record: RunRecord): boolean {
  const c = countSteps(record.steps);
  return c.web + c.search + c.read + c.write + c.command + c.tool > 0;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
