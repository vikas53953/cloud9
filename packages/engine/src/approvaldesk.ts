// WAITING FOR A YES, MID-RUN, WITHOUT STOPPING THE ENGINE.
//
// The gap this closes: `github.ts` refuses everything unless somebody is set up
// to approve it, and until now nobody was. The only approval Cloud9 had was
// job-shaped — asked before a background job starts — so an agent that had
// already worked, already committed on its own branch, and had arrived at the
// one thing it may not do alone had no way to ask. The worktree flow stopped at
// "committed locally" and his GitHub feature could not work.
//
// THE THREE PROPERTIES THAT MATTER, and each one is a test in
// `approvaldesk.test.ts`:
//
//  1. IT DOES NOT BLOCK AND IT DOES NOT SPIN. A wait is a promise sitting in a
//     map with one timer against it. The engine keeps answering messages,
//     running other agents' turns and reconnecting while an agent waits. There
//     is no loop, no poll and no `await` on the socket.
//  2. SILENCE IS NEVER A YES. Every path out of here that is not an explicit
//     "approved" is a no: the deadline passing, the hub going away, the engine
//     stopping, a malformed answer. The agent is told WHICH, in plain words, so
//     it can say something true in the conversation.
//  3. IT IS THE SAME APPROVAL ENTITY. This sends `askApproval` and listens for
//     the ordinary `approval` frame that `decideApproval` already produces. No
//     second decision mechanism, no second place for "did we ask?" to be
//     answered — that split is what let the hub and the engine disagree about
//     `mustAskBeforeActing` the first time.
import {
  AgentDef, APPROVAL_LIMITS, Approval, ClientFrame, ID, RemoteAction, RemoteActionFacts,
  describeRemoteAction, mustAskBeforeActing,
} from "@cloud9/shared";


/** What came back, and why. `reason` is written for a person, not a log. */
export interface ApprovalOutcome {
  approved: boolean;
  reason: string;
  approvalId?: ID;
}

export interface ApprovalDeskOptions {
  /** how the engine puts a frame on the wire */
  send: (frame: ClientFrame) => void;
  /** overridden in tests; the real one is the shared ten minutes */
  waitMs?: number;
  /** how many agents may be waiting at once — a leash, not a policy */
  maxWaiting?: number;
  log?: (message: string) => void;
  /**
   * A JOB HAS STOPPED MOVING AND IS STANDING HERE.
   *
   * Called ONCE, when a wait that belongs to a delegated job really begins —
   * after the card has gone on the wire, so the moment reported is the moment
   * the owner could first have answered. Only for waits that carry a `taskId`:
   * a wait with no job behind it stops nothing anyone is watching, and the
   * refusals above (an action nobody can be asked about, too many already
   * waiting) never wait at all, so they never fire this.
   *
   * The desk does not know what a task is and does not touch one — it reports.
   * `engine.ts` owns what that means on screen.
   */
  onWaitStart?: (wait: { taskId: ID; facts: RemoteActionFacts }) => void;
  /**
   * THE WAIT IS OVER — yes, no, expired, or the hub went away. Always fires if
   * `onWaitStart` fired, exactly once, so nothing can be left standing at the
   * gate for ever on a screen. `outcome` says which of the four it was.
   */
  onWaitEnd?: (end: { taskId: ID; outcome: ApprovalOutcome }) => void;
}

interface Waiting {
  askId: string;
  approvalId?: ID;
  action: RemoteAction;
  /** the delegated job this wait belongs to, when there is one */
  taskId?: ID;
  settle: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

let asks = 0;

export class ApprovalDesk {
  private waiting: Waiting[] = [];
  private waitMs: number;
  private maxWaiting: number;
  private log: (message: string) => void;

  constructor(private opts: ApprovalDeskOptions) {
    this.waitMs = opts.waitMs ?? APPROVAL_LIMITS.waitMs;
    this.maxWaiting = opts.maxWaiting ?? 20;
    this.log = opts.log ?? ((m: string) => console.log(`[approval] ${m}`));
  }

  /** How many agents are standing here right now. For a status line, and tests. */
  get pending(): number { return this.waiting.length; }

  /**
   * "May I do this one thing?" — asked while the agent is mid-run.
   *
   * Returns a promise that settles when he answers, when the deadline passes,
   * or when the hub goes away. It never settles `approved: true` on anything
   * other than a decision that really said `approved`.
   */
  ask(input: {
    agent: AgentDef;
    channelId: ID;
    taskId?: ID;
    facts: RemoteActionFacts;
  }): Promise<ApprovalOutcome> {
    const { agent, facts } = input;
    // ONE OWNER FOR "MUST ASK", and it is shared's. Asked here rather than
    // assumed, so that if this function is ever reached for something that does
    // NOT have to be asked about, that is a bug we see rather than a silent
    // extra prompt — and so the rule has exactly one definition on this side of
    // the wire too.
    if (!mustAskBeforeActing(agent, { remoteAction: facts.action })) {
      return Promise.resolve({
        approved: false,
        reason: "Cloud9 does not know how to ask about that, so it did not happen",
      });
    }
    if (this.waiting.length >= this.maxWaiting) {
      return Promise.resolve({
        approved: false,
        reason: "too many agents are already waiting on an answer",
      });
    }

    const askId = `ask-${(++asks).toString(36)}-${Date.now().toString(36)}`;
    return new Promise<ApprovalOutcome>(resolve => {
      const timer = setTimeout(() => {
        // NOBODY ANSWERED. This is the honest end, and it is a no.
        this.finish(askId, {
          approved: false,
          reason: `nobody answered in ${howLong(this.waitMs)}, so it did not happen`,
        });
      }, this.waitMs);
      // a waiting approval must never be the reason this process stays alive
      timer.unref?.();
      this.waiting.push({
        askId, action: facts.action, settle: resolve, timer,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      });
      this.opts.send({
        type: "askApproval", askId,
        agentId: agent.id, channelId: input.channelId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        facts,
      });
      this.log(`asked: ${describeRemoteAction(facts)}`);
      // AFTER the card is on the wire, so "stuck since" is never earlier than
      // the moment he could have answered. Told, not obeyed: a listener that
      // throws must not take the wait down with it, because the wait is the
      // thing that actually protects GitHub.
      if (input.taskId) this.tell(() => this.opts.onWaitStart?.({ taskId: input.taskId!, facts }));
    });
  }

  /** The hub's receipt: this is the card he is now looking at. */
  onAsked(askId: string, approvalId: ID): void {
    const w = this.waiting.find(x => x.askId === askId);
    if (w) w.approvalId = approvalId;
  }

  /**
   * A decision arrived. `approved` is the ONLY value that lets anything happen;
   * `rejected` and `expired` are told apart because they are different events
   * and he deserves to hear which one it was.
   */
  onApproval(approval: Approval): void {
    const w = this.waiting.find(x => x.approvalId === approval.id);
    if (!w || approval.status === "pending") return;
    if (approval.status === "approved") {
      this.finish(w.askId, { approved: true, reason: "approved", approvalId: approval.id });
      return;
    }
    this.finish(w.askId, {
      approved: false,
      approvalId: approval.id,
      reason: approval.status === "expired"
        ? "nobody answered in time, so it did not happen"
        : "the owner said no, so it did not happen",
    });
  }

  /**
   * The hub went away, or the engine is stopping.
   *
   * Everyone waiting is told NO. A dropped socket is the one moment where
   * "carry on and assume it was fine" would be most tempting and most wrong:
   * we would be pushing to GitHub on the strength of a connection that is not
   * there to have answered us.
   */
  giveUpAll(reason: string): void {
    for (const w of [...this.waiting]) {
      this.finish(w.askId, { approved: false, reason });
    }
  }

  private finish(askId: string, outcome: ApprovalOutcome): void {
    const i = this.waiting.findIndex(x => x.askId === askId);
    if (i < 0) return;
    const [w] = this.waiting.splice(i, 1);
    if (!w) return;
    clearTimeout(w.timer);
    this.log(`${w.action}: ${outcome.reason}`);
    // THE JOB IS MOVING AGAIN — whatever the answer was. Said before the
    // promise settles so the screen is never behind the work: the turn carries
    // on the instant it is told, and it is no longer stuck the instant before.
    if (w.taskId) this.tell(() => this.opts.onWaitEnd?.({ taskId: w.taskId!, outcome }));
    w.settle(outcome);
  }

  /** A listener is told; it never gets to decide. */
  private tell(what: () => void): void {
    try { what(); } catch (err) { this.log(`a waiting listener threw: ${String(err)}`); }
  }
}

/**
 * "10 minutes" / "20 seconds", never "0 minutes".
 *
 * Caught by the real end-to-end run, not by a unit test: with a 20-second
 * leash the agent told the owner "nobody answered in 0 minutes", which reads
 * like a bug in the very sentence whose whole job is to be believable.
 */
function howLong(ms: number): string {
  if (ms < 90_000) {
    const s = Math.max(1, Math.round(ms / 1000));
    return `${s} second${s === 1 ? "" : "s"}`;
  }
  const m = Math.round(ms / 60_000);
  return `${m} minute${m === 1 ? "" : "s"}`;
}
