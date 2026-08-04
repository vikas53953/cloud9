// WATCHING A HARNESS WORK — the engine half of the live view.
//
// The gap this closes: every provider did `result = await runner(...)`, waited
// for the CLI process to exit, parsed the whole of stdout, and only then said
// what the agent had done. A person watching saw "X is working on it" for
// minutes and then the entire story at once. Sitting in the CLI you see each
// tool call as it lands.
//
// The mappers already knew how to turn ONE line into a step. They were only
// ever fed a whole buffer at the end. This module is the ten lines that feed
// them a line at a time instead — and it is the ONLY place that does, so the
// Claude path and the Codex path stream identically or not at all.
//
// ========================= IT CHANGES NOTHING ELSE =========================
//
// The buffered `RunResult`, the parse at the end, the `ProviderTrace` handed to
// `onTrace`, and the stored `RunRecord` built from it are all untouched. The
// walker here is a SECOND, throwaway instance reading the same lines for the
// preview. That costs one extra JSON parse per line and buys the guarantee that
// a bug in the live view cannot change a single field of the record — which is
// the trade worth making, because the record is the truth and this is not.
//
// AND IT NEVER MAKES ANYTHING UP. Every step it emits came out of the CLI's own
// stream through the CLI's own mapper. A line that is half-written, not JSON,
// or simply not about a step produces nothing at all. If a caller wants no live
// view, or a runner cannot stream, this hands back `undefined` and the provider
// passes no watcher — no empty box, no invented "starting…", no difference from
// how Cloud9 behaved before.
import type { RunStep } from "@cloud9/shared";
import { EventMapper, traceWalker } from "./runrecord.js";

/**
 * Build the per-line watcher a provider hands to `run()`, or `undefined` when
 * nobody is watching.
 *
 * Returning `undefined` is load-bearing: `run()` skips its line-splitting
 * entirely when there is no watcher, so a turn nobody is watching does exactly
 * the work it did before this feature existed.
 *
 * Never throws. `feed` is already fail-safe per line, and the caller's `onStep`
 * is wrapped, because a screen update may never be the reason a turn fails —
 * the same law `onTrace` lives under.
 */
export function liveStepWatcher(
  provider: string,
  mapper: EventMapper,
  onStep: ((steps: RunStep[]) => void) | undefined,
): ((line: string) => void) | undefined {
  if (!onStep) return undefined;
  const walker = traceWalker(provider, mapper);
  return (line: string) => {
    const touched = walker.feed(line);
    if (touched.length === 0) return;
    try { onStep(touched); } catch (err) {
      console.error("[engine] could not show what an agent is doing; the turn is unaffected:", err);
    }
  };
}
