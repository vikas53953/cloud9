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
//     list. The engine keeps answering messages, running other agents' turns and
//     reconnecting while an agent waits. There is no loop, no poll, no timer and
//     no `await` on the socket.
//  2. SILENCE IS NEVER A YES. Every path out of here that is not an explicit
//     "approved" is a no: the owner saying no, the owner pressing Stop, the hub
//     going away, the engine stopping, a malformed answer. The agent is told
//     WHICH, in plain words, so it can say something true in the conversation.
//
// AND THE CARD NO LONGER DIES OF OLD AGE (2026-08-07). It used to be killed
// after ten minutes, and the agent behind it told "nobody answered in time".
// That was invented here, not asked for, and it is not how the tools this app
// copies behave: Claude Code and Codex ask and then wait. His question survives
// lunch. Property 2 above is what keeps silence from ever becoming a yes; a
// deadline was never part of it, and re-adding one would only mean losing his
// question rather than protecting anything.
//  3. IT IS THE SAME APPROVAL ENTITY. This sends `askApproval` and listens for
//     the ordinary `approval` frame that `decideApproval` already produces. No
//     second decision mechanism, no second place for "did we ask?" to be
//     answered — that split is what let the hub and the engine disagree about
//     `mustAskBeforeActing` the first time.
import {
  AgentDef, Approval, ClientFrame, ID, RemoteAction, RemoteActionFacts,
  SavingProposal, decideAsking, describeRemoteAction, isRemoteAction, tidyPlan, tidySaving,
  trustLevel, trustOf, validateSavingProposal,
} from "@cloud9/shared";


/** What came back, and why. `reason` is written for a person, not a log. */
export interface ApprovalOutcome {
  approved: boolean;
  reason: string;
  approvalId?: ID;
  /**
   * TRUE when this went ahead WITHOUT a card, because the owner had already
   * answered in advance with this agent's trust setting.
   *
   * It is a separate field rather than a shade of `reason` because two things
   * read it and neither may guess: the engine, which must still announce and
   * record what happened when nobody was asked, and any test that has to prove
   * the difference between "he said yes" and "he had said yes in advance". An
   * `approved: true` with no `approvalId` and no `unasked` would be the one
   * shape that could hide a bypass, and it is now unreachable.
   */
  unasked?: boolean;
}

export interface ApprovalDeskOptions {
  /** how the engine puts a frame on the wire */
  send: (frame: ClientFrame) => void;
  /** how many agents may be waiting at once — a leash, not a policy */
  maxWaiting?: number;
  /**
   * THE NUMBER OF AGENTS STANDING HERE JUST CHANGED.
   *
   * Fired on every push and every removal, for EVERY kind of card, with no
   * arguments — the caller reads `pending`. It exists because of a starvation
   * bug the removal of the ten-minute sweep turned from temporary into
   * permanent: a turn parked on a card is holding one of the engine's two
   * concurrency slots while it waits, and the sweep used to be the thing that
   * eventually handed that slot back. See `Engine.drain`.
   *
   * It is a NOTIFICATION, never a decision — like `onWaitStart`, it is told and
   * it does not get to change what this desk does.
   */
  onWaitingChanged?: () => void;
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
  onWaitStart?: (wait: {
    taskId: ID;
    /** the counted facts of a remote action — absent on a plan wait */
    facts?: RemoteActionFacts;
    /** TRUE when what is being waited on is a plan, not an action */
    plan?: true;
  }) => void;
  /**
   * THE WAIT IS OVER — yes, no, stopped, or the hub went away. Always fires if
   * `onWaitStart` fired, exactly once, so nothing can be left standing at the
   * gate for ever on a screen. `outcome` says which of the four it was.
   */
  onWaitEnd?: (end: { taskId: ID; outcome: ApprovalOutcome }) => void;
  /**
   * SOMETHING LEFT THE MACHINE AND NOBODY WAS ASKED — because he had already
   * said, for this agent, that nobody should be.
   *
   * Fired for EVERY action that goes through unasked, before the caller is told
   * it may proceed. The facts handed over are the same counted facts a card
   * would have carried (branch, repository, commit count) — measured by the
   * engine from what it is about to do, never a sentence the agent wrote about
   * itself. `engine.ts` turns them into the line he reads in the room.
   *
   * NOT ASKING IS NOT THE SAME AS NOT TELLING. This hook is the whole difference,
   * and it is why "don't ask me" does not cost him the audit.
   */
  onUnasked?: (what: { agent: AgentDef; taskId?: ID; channelId: ID; facts: RemoteActionFacts }) => void;
}

/**
 * ONE THING THAT WENT THROUGH THIS GATE, OR DID NOT — counted facts and a
 * decision, nothing else.
 *
 * ADDED FOR VERIFICATION (`verify.ts`). When an agent's reply says "I pushed
 * it", the only honest way to check is against the gate every push must pass:
 * the `RemoteActionFacts` here are the branch git generated, the repository gh
 * named and the number `git rev-list` counted — the same facts the card carried,
 * never a sentence the agent wrote about itself.
 *
 * THE HONEST LIMIT, written down because it decides what verification may say:
 * `approved` means the owner said yes (or had said yes in advance), NOT that
 * the action then succeeded. So "he said he pushed and no push was ever
 * approved" is a fact; "he said he pushed and one was approved" is only
 * agreement, never proof that GitHub took it.
 */
export interface SettledRemoteAction {
  facts: RemoteActionFacts;
  approved: boolean;
  /** it went ahead because the owner had already answered, in advance */
  unasked?: boolean;
  at: number;
}

/** How many settled actions the desk remembers. A verification window, not a log. */
export const SETTLED_KEEP = 50;

interface Waiting {
  askId: string;
  /**
   * WHOSE AGENT IS STANDING HERE (2026-08-06).
   *
   * Added so the stop button can reach this queue. `stopAgent` kills the turn's
   * child processes, and until now that was ALL it did — an agent parked on a
   * card is not inside a `run()`, so there was no process to kill and nothing
   * else knew a stop had happened. The room said "🛑 Stopping — pulling the plug"
   * and the job then sat on the jobs screen as "waiting for you" until the card
   * sat there afterwards. The stop was true of the processes and false of the
   * thing the owner could actually see.
   */
  agentId: ID;
  approvalId?: ID;
  /** what is being waited on: a row on the shared table, a plan, or a saving */
  action: RemoteAction | "plan" | "saving";
  /**
   * The counted facts the card carried — kept for the settled ledger.
   *
   * ABSENT ON A PLAN WAIT, and that is the whole reason it is optional. The
   * ledger exists so `verify.ts` can check "I pushed it" against the gate every
   * push must pass; a plan is not a remote action, has no counted facts and
   * never left this computer, so it belongs in that ledger under NO facts at all
   * rather than under borrowed ones that would read as a push nobody made.
   */
  facts?: RemoteActionFacts;
  /** the delegated job this wait belongs to, when there is one */
  taskId?: ID;
  settle: (outcome: ApprovalOutcome) => void;
}

let asks = 0;

export class ApprovalDesk {
  private waiting: Waiting[] = [];
  private maxWaiting: number;
  private log: (message: string) => void;

  constructor(private opts: ApprovalDeskOptions) {
    this.maxWaiting = opts.maxWaiting ?? 20;
    this.log = opts.log ?? ((m: string) => console.log(`[approval] ${m}`));
  }

  /** How many agents are standing here right now. For a status line, and tests. */
  get pending(): number { return this.waiting.length; }

  /**
   * WHAT REALLY WENT THROUGH THIS GATE, oldest first, capped at `SETTLED_KEEP`.
   *
   * READ-ONLY BY CONSTRUCTION and read-only by intent: this is a record for
   * `verify.ts` to check an agent's words against. Nothing here decides
   * anything, and adding it changed no decision the desk makes.
   */
  get settledActions(): readonly SettledRemoteAction[] { return this.ledger; }

  /** Every remote action that settled, in order. See `SettledRemoteAction`. */
  private ledger: SettledRemoteAction[] = [];

  /** Somebody joined or left the queue. Told, never obeyed — see the option. */
  private waitingChanged(): void {
    this.tell(() => this.opts.onWaitingChanged?.());
  }

  private noteSettled(entry: SettledRemoteAction): void {
    this.ledger.push(entry);
    if (this.ledger.length > SETTLED_KEEP) {
      this.ledger.splice(0, this.ledger.length - SETTLED_KEEP);
    }
  }

  /**
   * "May I do this one thing?" — asked while the agent is mid-run.
   *
   * Returns a promise that settles when he answers, when he presses Stop, or
   * when the hub goes away — and NOT until one of those happens. It never
   * settles `approved: true` on anything other than a decision that really said
   * `approved`.
   */
  ask(input: {
    agent: AgentDef;
    channelId: ID;
    taskId?: ID;
    facts: RemoteActionFacts;
  }): Promise<ApprovalOutcome> {
    const { agent, facts } = input;
    // SOMETHING THIS APP HAS NO WORDS FOR NEVER HAPPENS. Asked FIRST, and asked
    // about the action itself rather than about the agent, because "we cannot
    // describe it" must not be answerable by any setting: an action with no row
    // on `REMOTE_ACTIONS` has no sentence, no counted facts and no card, so
    // letting it through on trust would be trusting a blank.
    if (!isRemoteAction(facts.action)) {
      return Promise.resolve({
        approved: false,
        reason: "Cloud9 does not know how to ask about that, so it did not happen",
      });
    }
    // ONE OWNER FOR "MUST ASK", and it is shared's — the same function the hub
    // asks and the same function the agent editor asks. `goAhead` here is NOT
    // the desk deciding: it is the owner's own standing answer for this agent,
    // stored, validated and shown on the agent's card.
    if (decideAsking(agent, { remoteAction: facts.action }) === "goAhead") {
      // TOLD, ALWAYS, EVEN THOUGH HE IS NOT ASKED. Before the caller proceeds,
      // so the record of it exists before the thing does.
      this.tell(() => this.opts.onUnasked?.({
        agent, channelId: input.channelId, facts,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      }));
      this.log(`went ahead unasked: ${describeRemoteAction(facts)}`);
      // ON THE LEDGER EITHER WAY. "Not asked" must not also mean "not written
      // down" — that is the same half of "don't ask me" `onUnasked` protects.
      this.noteSettled({ facts, approved: true, unasked: true, at: Date.now() });
      return Promise.resolve({
        approved: true,
        unasked: true,
        reason: `you chose “${trustLevel(trustOf(agent)).label}” for ${agent.name}, `
          + `so it went ahead without asking`,
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
      this.waiting.push({
        askId, agentId: agent.id, action: facts.action, facts, settle: resolve,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      });
      this.waitingChanged();
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

  /**
   * "HERE IS WHAT I INTEND TO DO — shall I?" — asked BEFORE the work, when the
   * owner has said he wants to see the plan first.
   *
   * IT IS THE SAME DESK, DELIBERATELY. Same waiting list, same `maxWaiting` leash, same `onApproval` settle path, same
   * `giveUpAll` when the hub goes away — so the three properties at the top of
   * this file hold for a plan exactly as they hold for a push, and there is
   * still exactly one place where "did we ask?" is answered.
   *
   * WHAT IT DOES NOT DO IS CONSULT THE TRUST SETTING, and that is not an
   * oversight. `decideAsking` answers "may this agent do things outside this
   * computer without stopping?" — a different question from "does he want to
   * see the plan before it starts". He asked to be shown; he is shown. There is
   * no path through this method that goes ahead without a card, which is why it
   * cannot weaken anything: it can only add a stop that was not there before.
   */
  askPlan(input: {
    agent: AgentDef;
    channelId: ID;
    taskId?: ID;
    /** what the agent said it intends to do, in its own words */
    plan: string;
  }): Promise<ApprovalOutcome> {
    const plan = tidyPlan(input.plan);
    if (!plan) {
      // nothing to show him is not something to approve — and silence would be
      // the one shape that could look like a yes
      return Promise.resolve({
        approved: false,
        reason: "the agent did not say what it intended to do, so nothing was started",
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
      this.waiting.push({
        askId, agentId: input.agent.id, action: "plan", settle: resolve,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      });
      this.waitingChanged();
      this.opts.send({
        type: "askPlan", askId,
        agentId: input.agent.id, channelId: input.channelId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        plan,
      });
      this.log(`asked for a go-ahead on a plan from ${input.agent.name}`);
      // A JOB STANDING AT THIS GATE IS STUCK IN EXACTLY THE SAME SENSE as one
      // standing at the push gate, so it is reported the same way and the jobs
      // screen needs no second idea of "waiting".
      if (input.taskId) {
        this.tell(() => this.opts.onWaitStart?.({
          taskId: input.taskId!,
          // the desk reports FACTS about a wait; a plan has no `REMOTE_ACTIONS`
          // row, so it reports the plan wait as itself rather than borrowing a
          // row that would say something untrue about GitHub
          plan: true,
        }));
      }
    });
  }

  /**
   * "ONE OF YOUR AGENTS IS COSTING MORE THAN IT NEEDS TO — shall I change it?"
   * — asked when an agent has looked at the crew's spending and found waste.
   *
   * IT IS THE SAME DESK AGAIN, for the same reasons `askPlan` is: same waiting
   * list, same `maxWaiting` leash, same `onApproval`
   * settle path, same `giveUpAll` and `giveUpFor`. The three properties at the
   * top of this file hold for a saving exactly as they hold for a push.
   *
   * IT DOES NOT CONSULT THE TRUST SETTING, and here that matters more than
   * anywhere else on this desk. `decideAsking` answers "may this agent do
   * things outside this computer without stopping?" — an entirely different
   * question from "may one agent change another agent's settings", which the
   * owner has never been asked and which no existing setting means. There is no
   * path through this method that goes ahead without a card. Whatever an agent
   * is trusted with, a saving is always asked.
   *
   * AND APPROVING IT CHANGES NOTHING HERE. This desk hands back a yes or a no
   * and never touches an agent. The change is made at the hub, in the same step
   * as the owner's own decision, and only ever out of the closed two-member
   * `SavingChange` — see @cloud9/shared. So the very most this whole path can
   * do, even completely subverted, is put a sentence in front of him.
   */
  askSaving(input: {
    agent: AgentDef;
    channelId: ID;
    taskId?: ID;
    proposal: SavingProposal;
  }): Promise<ApprovalOutcome> {
    // JUDGED HERE AS WELL AS AT THE HUB. Not belt-and-braces: this is the side
    // that can still say something useful to the AGENT, whereas a refusal at
    // the hub is a card that never appears and an agent left wondering.
    const problem = validateSavingProposal(input.proposal);
    if (problem) {
      return Promise.resolve({ approved: false, reason: problem });
    }
    if (this.waiting.length >= this.maxWaiting) {
      return Promise.resolve({
        approved: false,
        reason: "too many agents are already waiting on an answer",
      });
    }
    const proposal: SavingProposal = {
      ...input.proposal,
      because: tidySaving(input.proposal.because),
    };
    const askId = `ask-${(++asks).toString(36)}-${Date.now().toString(36)}`;
    return new Promise<ApprovalOutcome>(resolve => {
      this.waiting.push({
        askId, agentId: input.agent.id, action: "saving", settle: resolve,
        ...(input.taskId ? { taskId: input.taskId } : {}),
      });
      this.waitingChanged();
      this.opts.send({
        type: "askSaving", askId,
        agentId: input.agent.id, channelId: input.channelId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        proposal,
      });
      this.log(`asked whether to save money on ${proposal.aboutName}`);
      // A JOB STANDING AT THIS GATE IS STUCK in the same sense as one standing
      // at the push gate or the plan gate, so it is reported the same way and
      // the jobs screen needs no third idea of "waiting". It reports `plan:
      // true` because that is the desk's existing word for "this wait is about
      // something the agent WROTE, and carries no counted facts about GitHub" —
      // which is exactly true of a saving, and inventing a fourth word here
      // would mean touching every screen that already reads this.
      if (input.taskId) {
        this.tell(() => this.opts.onWaitStart?.({ taskId: input.taskId!, plan: true }));
      }
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
   *
   * RETURNS WHETHER IT REACHED ANYBODY (2026-08-07), and that is not a detail.
   * A card can now outlive the agent that raised it — Cloud9 restarts, and his
   * screen still shows a `pending` card with a live Approve button, because
   * nothing expires one any more. When he presses it, there is no waiter left,
   * and the honest answer is not `void`: it is FALSE, so the caller can tell him
   * his yes arrived after the agent had gone rather than letting the card turn
   * green over work that never happened.
   *
   * `false` also covers "still pending" and "somebody else's card", which are
   * both correctly nothing-happened — the engine only speaks up for a decision
   * that really was his and really found nobody.
   */
  onApproval(approval: Approval): boolean {
    const w = this.waiting.find(x => x.approvalId === approval.id);
    if (!w || approval.status === "pending") return false;
    if (approval.status === "approved") {
      this.finish(w.askId, { approved: true, reason: "approved", approvalId: approval.id });
      return true;
    }
    this.finish(w.askId, {
      approved: false,
      approvalId: approval.id,
      reason: approval.status === "expired"
        ? "nobody answered in time, so it did not happen"
        : "the owner said no, so it did not happen",
    });
    return true;
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

  /**
   * THE OWNER PRESSED STOP ON ONE AGENT (2026-08-06).
   *
   * The same ending as `giveUpAll`, aimed. Two features shipped on 2026-08-05
   * were each right alone and wrong together: the stop button (`run.ts`,
   * `Engine.stopAgent`) reaches into a scope and kills its child processes, and
   * the approval desk parks a turn on a card where there is NO child process to
   * kill. So an agent waiting to be allowed to push, or waiting on its plan, was
   * told nothing by a stop — the room said the plug had been pulled while the
   * jobs screen went on saying "waiting for you" for the rest of the card's life.
   *
   * WHY IT IS A NO AND NEVER A YES. The same reason a dropped socket is a no:
   * the only decision that may ever produce `approved: true` is one the owner
   * really made. He pressed stop; that is not permission.
   *
   * ONE AGENT ONLY. Another agent's card is another piece of work he did not
   * stop, and cancelling it would make one stop button mean "stop everything".
   *
   * Returns how many waits it ended, so the caller can say something true.
   */
  giveUpFor(agentId: ID, reason: string): number {
    const mine = this.waiting.filter(w => w.agentId === agentId);
    for (const w of mine) this.finish(w.askId, { approved: false, reason });
    return mine.length;
  }

  private finish(askId: string, outcome: ApprovalOutcome): void {
    const i = this.waiting.findIndex(x => x.askId === askId);
    if (i < 0) return;
    const [w] = this.waiting.splice(i, 1);
    if (!w) return;
    this.waitingChanged();
    this.log(`${w.action}: ${outcome.reason}`);
    // WRITTEN DOWN BEFORE ANYONE IS TOLD. See `SettledRemoteAction` — and see
    // `Waiting.facts` for why a plan wait writes nothing here.
    if (w.facts) {
      this.noteSettled({ facts: w.facts, approved: outcome.approved, at: Date.now() });
    }
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

