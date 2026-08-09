// ---------------------------------------------------------------------------
// HOW WIDE THE THREAD IS, AND WHO DECIDES.
//
// Vikas asked, three times, to be able to drag the thread's edge and make it
// big and have it stay. Three attempts failed because nobody opened Slack or
// Buzz and looked; the third one shipped a HARD CEILING of 280px, which is the
// opposite of what he asked for. `docs/threads-like-slack.html` is the looking:
// Buzz was driven on his own machine and every number here was READ OFF THE
// REAL ELEMENTS over a debug port, never measured off a screenshot.
//
// The rule this file exists to make impossible to get wrong:
//
//   • there is a FLOOR ON THE ROOM. There is NO CAP ON THE THREAD. The room
//     never goes below 300px, and that is the ONLY limit. If a maximum thread
//     width ever appears in this file as a constant, someone has re-run the
//     mistake this whole task was raised to undo.
//
//   • the width HE CHOSE is never edited by the window. A small window is
//     borrowing his number for as long as it has to; only his own drag, his own
//     arrow key, or his own double-click ever rewrites it. `widthToDraw` takes
//     his stored number and gives back what fits — and gives back a NEW number
//     rather than changing his. That separation is the whole of point 9 and the
//     likeliest way this feature would have quietly disappointed him.
//
// Kept out of the screen so a test can read it, for the same reason
// `agentactivity.ts` is out of the screen: the arithmetic is the part that can
// be wrong, and arithmetic buried in a React component cannot be checked
// without a browser.
// ---------------------------------------------------------------------------

/** Buzz's measured default, on his own maximised window. Cloud9's today is 280. */
export const THREAD_DEFAULT = 460;

/** The thread never goes below this. Buzz's own floor measured at 308. */
export const THREAD_FLOOR = 300;

/** The room never goes below this. Buzz's own floor measured at 301. */
export const ROOM_FLOOR = 520;

/** The rail of buttons down the left (`styles.css` `--rail-w`). */
export const RAIL_W = 78;

/** The channel list. It narrows at 1330px — `styles.css:82` and `:1576`. */
export const SIDEBAR_W_WIDE = 250;
export const SIDEBAR_W_NARROW = 216;
export const SIDEBAR_BREAKPOINT = 1330;

/** How far one arrow key press moves the divider. */
export const THREAD_STEP = 16;

/**
 * The narrowest window that can still show both at their floors:
 * 78 rail + 216 sidebar + 300 thread + 300 room. Below it the app stops
 * splitting and the thread takes over the whole area — the SAME mechanism he
 * asks for by hand, not a second thing.
 */
export const SPLIT_NEEDS = THREAD_FLOOR + ROOM_FLOOR;
export const SPLIT_NEEDS_WINDOW = RAIL_W + SIDEBAR_W_NARROW + SPLIT_NEEDS; // 894

/** What a screen reader says. Buzz's own words, copied rather than invented. */
export const EXPAND_LABEL = "expand thread";
export const BESIDE_LABEL = "show thread beside channel";

/** How wide the channel list is at a given window width. */
export function sidebarWidth(viewport: number): number {
  return viewport <= SIDEBAR_BREAKPOINT ? SIDEBAR_W_NARROW : SIDEBAR_W_WIDE;
}

/** The room and the thread share this much. Everything else is furniture. */
export function spaceToShare(viewport: number): number {
  return Math.max(0, viewport - RAIL_W - sidebarWidth(viewport));
}

/**
 * The widest the thread may be drawn — a consequence of the ROOM's floor, not a
 * cap of its own. Widen the window and this grows with no ceiling above it.
 */
export function widestThread(space: number): number {
  return space - ROOM_FLOOR;
}

/**
 * Is there room for both? When there is not, the answer is the take-over mode,
 * never a divider that refuses in silence.
 */
export function cannotSplit(space: number): boolean {
  return space < SPLIT_NEEDS;
}

/**
 * What to actually draw, given the width he chose and the space there is.
 * HIS NUMBER IS NOT TOUCHED — this returns a different one when it has to.
 */
export function widthToDraw(stored: number, space: number): number {
  /* NOTHING KNOWN YET. On the very first frame the screen has not measured
     itself, and `space` is 0. Answering "0" there would draw his thread as a
     hairline for one frame before it snapped open, which looks like a bug and
     is not one. Not knowing is a reason to give him his own number back, never
     a reason to invent a small one. */
  if (space <= 0) {
    /* Preferences are JSON and may be edited or corrupted. Never put a zero,
       negative, or non-finite value into CSS while the grid is still measuring.
       A valid large choice remains exactly that choice (apart from the same
       integer rounding used once the grid is measured). */
    if (!Number.isFinite(stored) || stored <= 0) return THREAD_DEFAULT;
    return Math.max(1, Math.round(stored));
  }
  if (cannotSplit(space)) return space;         // take-over: the whole area
  const widest = widestThread(space);
  if (!Number.isFinite(stored)) return THREAD_DEFAULT;
  return Math.max(THREAD_FLOOR, Math.min(Math.round(stored), widest));
}

/**
 * Where an arrow key or a drag leaves the divider. This one IS his own doing,
 * so the answer is meant to be stored.
 */
export function widthHeChose(wanted: number, space: number): number {
  if (!Number.isFinite(wanted)) return THREAD_DEFAULT;
  const widest = Math.max(THREAD_FLOOR, widestThread(space));
  return Math.max(THREAD_FLOOR, Math.min(Math.round(wanted), widest));
}

/**
 * The tooltip, and the detail worth copying exactly: it is CONDITIONAL. Buzz
 * offers the reset only once there is something to reset, and so do we.
 */
export function dividerWords(stored: number): string {
  return Math.round(stored) === THREAD_DEFAULT
    ? "Drag to resize."
    : "Drag to resize. Double-click to reset width.";
}

/**
 * What the divider says about itself when it takes focus — Slack ships keyboard
 * resizing (accessibility changelog, June 2026) and a control only a mouse can
 * reach is not acceptable. Conditional in the same way and for the same reason
 * as the tooltip: a keyboard has no double-click, so the way back is Home, and
 * it is only offered once there is something to put back.
 */
export function dividerSpokenWords(stored: number): string {
  return Math.round(stored) === THREAD_DEFAULT
    ? "Thread width. Use the left and right arrow keys to resize."
    : "Thread width. Use the left and right arrow keys to resize, "
      + "or Home to put it back to normal.";
}
