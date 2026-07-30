// The lifecycle of being connected to a hub — the ONE owner of "what do we do
// when the hub we are dialing goes up, or goes down, or will not answer".
//
// Where this sits: `hubaddress.ts` says whether an address is dialable;
// `hubbook.ts` remembers the hubs and which is active. This file is the next
// brick: the client dials the active hub and the connection lives, drops,
// retries, and — the important part — FALLS BACK TO THIS COMPUTER'S OWN HUB when
// a friend's hub will not answer, so a friend being offline never locks the
// person out of their own Cloud9. That is the same "self is the floor" law
// hubbook.ts encodes, carried into what happens over time.
//
// It is a pure reducer: no sockets, no timers, no clock. The caller owns the
// socket and the timer; it feeds this module events (`dialed`, `opened`,
// `dropped`, `failed`, `timerFired`, `switched`) and gets back the next state
// PLUS a described effect to carry out (open a socket to this url, wait this
// many ms then send `timerFired`, or nothing). Because the delays are returned
// rather than slept, every backoff and every fallback is unit-testable without
// waiting a single millisecond.

/** How many times a friend's hub may refuse before we fall back to self. */
export const MAX_ATTEMPTS_BEFORE_FALLBACK = 5;
/** Backoff floor and ceiling, in milliseconds. */
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

export type ConnPhase =
  | "idle" // nothing dialed yet
  | "connecting" // a socket is being opened
  | "connected" // live
  | "waiting" // dropped/failed; a backoff timer is running before the next try
  | "fellBack"; // gave up on the target hub and switched to this computer's own

export interface ConnState {
  phase: ConnPhase;
  /** The hub id we are trying to reach (from the book). */
  targetId: string;
  /** Whether the target is this computer's own hub — self never falls back. */
  targetIsSelf: boolean;
  /** How many opens have failed in a row for this target. Resets on a live open. */
  attempts: number;
}

/** What the caller must actually DO after a transition. The reducer never acts itself. */
export type ConnEffect =
  | { do: "openSocket"; url: string } // dial this url now
  | { do: "waitThenRetry"; ms: number } // start a timer; send `timerFired` when it elapses
  | { do: "fallBackToSelf" } // switch the active hub to self, then dial self
  | { do: "nothing" };

export type ConnEvent =
  | { t: "dialed"; url: string } // caller began a connection to the target
  | { t: "opened" } // the socket is live
  | { t: "dropped" } // a live socket closed
  | { t: "failed" } // a dial never opened
  | { t: "timerFired" } // the backoff timer elapsed
  | { t: "switched"; targetId: string; targetIsSelf: boolean }; // active hub changed

/** The state a client starts in, before anything is dialed. */
export function initialConn(targetId: string, targetIsSelf: boolean): ConnState {
  return { phase: "idle", targetId, targetIsSelf, attempts: 0 };
}

/**
 * The backoff delay for the Nth failed attempt (1-based): exponential from
 * `BACKOFF_MIN_MS`, doubling each time, capped at `BACKOFF_MAX_MS`. Deterministic
 * — no jitter — so tests can assert it exactly. Exposed for the screen ("retrying
 * in 8s…") and for tests.
 */
export function backoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  const raw = BACKOFF_MIN_MS * 2 ** (n - 1);
  return Math.min(raw, BACKOFF_MAX_MS);
}

/**
 * The one transition function. Given where we are and what happened, return the
 * next state and the single effect the caller should perform. Pure and total —
 * every event is handled from every phase, so a stray event can never wedge it.
 */
export function reduceConn(state: ConnState, event: ConnEvent): { state: ConnState; effect: ConnEffect } {
  switch (event.t) {
    case "switched": {
      // The person chose a different hub (or a fallback did). Start clean and dial it.
      const next: ConnState = {
        phase: "connecting",
        targetId: event.targetId,
        targetIsSelf: event.targetIsSelf,
        attempts: 0,
      };
      return { state: next, effect: { do: "nothing" } };
      // Note: the caller asks for the url from the book and sends `dialed`.
    }

    case "dialed":
      return {
        state: { ...state, phase: "connecting" },
        effect: { do: "openSocket", url: event.url },
      };

    case "opened":
      // Live. Forget past failures.
      return { state: { ...state, phase: "connected", attempts: 0 }, effect: { do: "nothing" } };

    case "dropped":
    case "failed": {
      const attempts = state.attempts + 1;
      // A friend's hub that will not answer, past the limit → fall back to self so
      // the person is never locked out. This computer's own hub never falls back;
      // it just keeps retrying, because there is nowhere lower to go.
      if (!state.targetIsSelf && attempts >= MAX_ATTEMPTS_BEFORE_FALLBACK) {
        return {
          state: { ...state, phase: "fellBack", attempts },
          effect: { do: "fallBackToSelf" },
        };
      }
      return {
        state: { ...state, phase: "waiting", attempts },
        effect: { do: "waitThenRetry", ms: backoffMs(attempts) },
      };
    }

    case "timerFired":
      // Only a waiting connection retries; a stray timer in any other phase is ignored.
      if (state.phase !== "waiting") return { state, effect: { do: "nothing" } };
      return { state: { ...state, phase: "connecting" }, effect: { do: "nothing" } };
    // The caller reads the url from the book and sends `dialed` next.

    default: {
      // Exhaustiveness: if a new event type is added, TypeScript flags this.
      const _never: never = event;
      return { state, effect: { do: "nothing" } };
    }
  }
}

/** One plain line for the screen about where a connection stands. */
export function connInWords(state: ConnState, hubLabel: string): string {
  switch (state.phase) {
    case "idle":
      return `Not connected to ${hubLabel} yet`;
    case "connecting":
      return `Connecting to ${hubLabel}…`;
    case "connected":
      return `Connected to ${hubLabel}`;
    case "waiting":
      return `${hubLabel} isn't answering — trying again in ${Math.round(backoffMs(state.attempts) / 1000)}s`;
    case "fellBack":
      return `${hubLabel} couldn't be reached — you're back on this computer's Cloud9`;
  }
}
