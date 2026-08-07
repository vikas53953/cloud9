import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BESIDE_LABEL, EXPAND_LABEL, ROOM_FLOOR, SPLIT_NEEDS_WINDOW, THREAD_DEFAULT,
  THREAD_FLOOR, THREAD_STEP, cannotSplit, dividerSpokenWords, dividerWords,
  sidebarWidth, spaceToShare, widestThread, widthHeChose, widthToDraw,
} from "./threadwidth.js";

/* ------------------------------------------------------------------ the sums
   The four window sizes named in the design page, worked out from the app's own
   furniture rather than from a screenshot. The 1330 breakpoint is why 800 and
   1920 do not divide the same way. */

test("the space to share, at the four sizes that were photographed", () => {
  assert.equal(sidebarWidth(1920), 250);
  assert.equal(sidebarWidth(1330), 216, "the sidebar narrows AT 1330, not below it");
  assert.equal(sidebarWidth(1331), 250);
  assert.equal(spaceToShare(1920), 1592);   // 1920 - 78 - 250
  assert.equal(spaceToShare(1330), 1036);   // 1330 - 78 - 216
  assert.equal(spaceToShare(894), 600);     // 894  - 78 - 216
  assert.equal(spaceToShare(800), 506);     // 800  - 78 - 216
});

test("894 is where the app can just barely still split", () => {
  assert.equal(SPLIT_NEEDS_WINDOW, 894);
  assert.equal(cannotSplit(spaceToShare(894)), false, "at 894 both floors fit exactly");
  assert.equal(cannotSplit(spaceToShare(893)), true);
  assert.equal(cannotSplit(spaceToShare(800)), true);
  /* And at 894 the handle has nowhere to travel — that is arithmetic, not a
     fault, and the page says so out loud. */
  assert.equal(widestThread(spaceToShare(894)), THREAD_FLOOR);
});

/* ------------------------------------------------------- no cap on the thread
   The single thing three earlier attempts got wrong. */

test("there is a floor on the room and NO ceiling on the thread", () => {
  for (const viewport of [1000, 1330, 1440, 1920, 2560, 3840]) {
    const space = spaceToShare(viewport);
    assert.equal(widestThread(space), space - ROOM_FLOOR,
      "the only limit is the room's floor");
    assert.equal(widthToDraw(999999, space), space - ROOM_FLOOR,
      "asking for a huge thread gives back everything except the room's floor");
  }
  /* Concretely: on his own maximised window it is 1292px, against 280 today. */
  assert.equal(widthToDraw(999999, spaceToShare(1920)), 1292);
  /* Wider window => wider thread, every time. A ceiling would flatten this. */
  assert.ok(widthToDraw(9e9, spaceToShare(2560)) > widthToDraw(9e9, spaceToShare(1920)));
});

test("the invented 380px room floor is gone and must not come back", () => {
  assert.equal(ROOM_FLOOR, 300);
  assert.equal(THREAD_FLOOR, 300);
  assert.equal(widthToDraw(9e9, spaceToShare(1920)), 1292,
    "a 380 room floor would give 1212 here — that is the rejected number");
});

/* ------------------------------------------------------ his number is his own
   Point 9: the likeliest way this would have quietly disappointed him. */

test("a narrow window BORROWS his width, it never rewrites it", () => {
  const his = 1200;
  const wide = spaceToShare(1920);
  const narrow = spaceToShare(1330);
  assert.equal(widthToDraw(his, wide), 1200, "his own screen gives him what he chose");
  assert.equal(widthToDraw(his, narrow), 736, "1036 - 300; drawn smaller because it must be");
  /* The stored number is untouched — same input, same answer, on the way back up */
  assert.equal(widthToDraw(his, wide), 1200, "widen again and his 1200 is back");
});

test("even in take-over territory his width survives", () => {
  const his = 1200;
  assert.equal(widthToDraw(his, spaceToShare(800)), 506, "drawn as the whole area");
  assert.equal(widthToDraw(his, spaceToShare(1920)), 1200, "and still his when there is room");
});

test("only his own doing produces a number meant to be stored", () => {
  const space = spaceToShare(1920);
  assert.equal(widthHeChose(1200, space), 1200);
  assert.equal(widthHeChose(50, space), THREAD_FLOOR, "a drag past the floor stops at it");
  assert.equal(widthHeChose(9e9, space), 1292, "and past the room's floor stops there");
  assert.equal(widthHeChose(NaN, space), THREAD_DEFAULT);
});

test("a keyboard nudge in a window too small to split still lands somewhere sane", () => {
  const tiny = spaceToShare(800);              // 506 — cannot split at all
  assert.equal(widthHeChose(400, tiny), THREAD_FLOOR,
    "never below the thread's own floor, even when the room's floor cannot be met");
});

/* --------------------------------------------------------------- the defaults */

test("it opens at Buzz's measured default, not at today's 280", () => {
  assert.equal(THREAD_DEFAULT, 388);
  assert.equal(widthToDraw(THREAD_DEFAULT, spaceToShare(1920)), 388);
  assert.notEqual(THREAD_DEFAULT, 280);
});

test("arrow keys move it by a step that is visible but not wild", () => {
  const space = spaceToShare(1920);
  assert.equal(widthHeChose(THREAD_DEFAULT + THREAD_STEP, space), 404);
  assert.equal(widthHeChose(THREAD_DEFAULT - THREAD_STEP, space), 372);
});

/* --------------------------------------------------- the conditional tooltip
   Copied exactly from Buzz, including WHEN it says each thing. */

test("the tooltip never offers a reset when there is nothing to reset", () => {
  assert.equal(dividerWords(THREAD_DEFAULT), "Drag to resize.");
  assert.equal(dividerWords(700), "Drag to resize. Double-click to reset width.");
  assert.equal(dividerWords(THREAD_FLOOR), "Drag to resize. Double-click to reset width.");
  /* Double-clicking puts it back, and the offer goes away again with it. */
  assert.equal(dividerWords(THREAD_DEFAULT), "Drag to resize.");
});

test("the divider says what it is, and a keyboard is offered the way back too", () => {
  const plain = dividerSpokenWords(THREAD_DEFAULT);
  const custom = dividerSpokenWords(700);
  assert.match(plain, /arrow keys/i, "a mouse-only control is not acceptable");
  assert.doesNotMatch(plain, /Home/,
    "no way back is offered when there is nothing to put back");
  assert.match(custom, /Home/, "a keyboard has no double-click, so it gets Home");
  assert.match(custom, /arrow keys/i);
});

test("the spoken labels are Buzz's own words", () => {
  assert.equal(EXPAND_LABEL, "expand thread");
  assert.equal(BESIDE_LABEL, "show thread beside channel");
});
