// WHERE AN AGENT'S ANSWER BELONGS — the thread, or the room.
//
// HIS COMPLAINT, IN HIS WORDS: "an agent does not have a conversation inside
// the threads. they do discuss within channels only and that is where the
// thread is not working... similar to Slack, within Slack it automatically
// replies inside the thread, and Buzz is the same."
//
// The wire was never the problem: `agentSend` has carried `replyTo` all along
// and the hub already files it. The engine simply never filled it in, so every
// answer — including an answer to a question asked INSIDE a thread — landed
// back in the main room and broke the thread in half.
//
// THIS FILE IS THE ONLY PLACE THAT DECIDES. One rule, read by every kind of
// turn (chat, delegated job, `!bg`, `!code`, GitHub write, memory, handoff),
// so a new kind of turn cannot quietly invent a different answer to the same
// question. The rule is deliberately tiny; what matters is that there is one.
//
// THE ONE-LEVEL RULE IS NOT OURS. Threads are one level deep and the HUB owns
// that: `resolveReplyTo` in `apps/relay/src/server.ts` re-parents a reply to a
// reply onto the root, and refuses a parent from another conversation. We do
// not re-implement it and we do not second-guess it. We only carry the value
// the hub has already normalised — a stored `replyTo` is always a ROOT — so
// passing it straight back is idempotent: the hub resolves it to itself.
import { ID, Message } from "@cloud9/shared";

/**
 * The thread a turn triggered by this message must answer in.
 *
 * A message with a `replyTo` was said inside a thread, and `replyTo` is that
 * thread's root (the hub guarantees it). A message with none was said in the
 * main room, and the answer belongs in the main room — that is the ordinary
 * case and it is unchanged.
 *
 * No trigger at all (a schedule firing, a proactive line, a presence note)
 * means there is nothing to answer inside, so it is a room message.
 */
export function threadOf(trigger: Pick<Message, "replyTo"> | undefined): ID | undefined {
  return trigger?.replyTo;
}

/**
 * The one short line the ROOM gets when a long job that was started inside a
 * thread finishes.
 *
 * The recorded decision (`docs/plans/feature-gap.md:300` — "Recommend thread,
 * with the final result also posted to the channel"; Buzz does the same thing
 * with a broadcast flag, `docs/plans/buzz-teardown.md:321`) is BOTH: the work
 * and its detail stay in the thread where it was asked for, and the room gets
 * one plain sentence so nobody is blind to work that happened.
 *
 * Short on purpose. The detail lives in the thread; this line only says how the
 * job ended and where to look. A job that fell over says so here too — a room
 * that only ever hears about successes is a room being managed, not informed.
 */
export function roomLineForThreadJob(what: string, outcome: "done" | "failed" = "done"): string {
  const trimmed = what.trim().replace(/\s+/g, " ");
  const short = trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
  const verb = outcome === "failed" ? "Could not finish" : "Finished";
  return short
    ? `🧵 ${verb} in the thread: ${short}`
    : `🧵 ${verb} the job asked for in the thread — the details are up there.`;
}
