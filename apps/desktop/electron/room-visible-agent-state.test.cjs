/**
 * THE ASYMMETRY THAT LET BLOCKER 8.2 LIVE FOR SIX DAYS.
 *
 * `navigation-chat-polish.test.cjs` pinned that `ChannelRail` was REMOVED from
 * the default chat tree. Nothing pinned that the things it used to carry kept a
 * live call site somewhere else — so when the room rail was retired, the reach
 * line went out of the app with it and every test stayed green.
 *
 * These tests pin the other half. They assert that the two surfaces a person
 * needs in order to see agent state in a room are actually CALLED, and that
 * each one still reads the single owner it is a projection of. A future panel
 * swap that drops either one fails here instead of six days later on an
 * installed walk.
 *
 * Source assertions, in this directory's own style: they read `App.tsx` as text
 * rather than rendering it, so they hold for the shipped source without needing
 * a DOM. They deliberately do NOT test what the words say — `presenceSays`,
 * `agentTrouble` and `reachLineInRoom` own that, and `neversilent.test.ts` in
 * the engine already walks every reach state.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");

/** The body of one top-level `function <name>(` declaration in App.tsx. */
const bodyOf = (app, name) => {
  const from = app.indexOf(`\nfunction ${name}(`);
  assert.notEqual(from, -1, `${name} should still exist in App.tsx`);
  const next = app.indexOf("\nfunction ", from + 1);
  return app.slice(from, next === -1 ? app.length : next);
};

test("a stuck agent is said on a surface every workspace layout draws", () => {
  const app = read("App.tsx");
  const css = read("styles.css");

  // (a) it has a LIVE call site, and it is in the room header — the one part of
  // a room that Focus does not take off screen.
  assert.match(app, /<AgentTroubleChip agents=\{agents\} world=\{world\} onOpenTasks=\{onOpenTasks\} \/>/,
    "AgentTroubleChip must stay called from the channel header");
  const header = app.slice(app.indexOf('<header className="topbar chathead">'),
    app.indexOf("{findOpen && ("));
  assert.match(header, /<AgentTroubleChip /,
    "the chip belongs in the room header, not somewhere Focus can hide");
  assert.match(css, /\.chatgrid\.focus-workspace>\.sidebar[^}]*display:none/,
    "this test only means something while Focus really does hide the Studio sidebar");

  // (b) it is a projection of the one owner, never a second status system.
  const chip = bodyOf(app, "AgentTroubleChip");
  assert.match(chip, /presenceSays\(world, agent\.id, presenceOf\(world, agent\.id\)\)/,
    "the chip must read presenceSays/presenceOf rather than working trouble out again");
  assert.match(chip, /if \(rows\.length === 0\) return null;/,
    "no agent in trouble must draw nothing at all — a chip that can only mean 'fine' is furniture");
  assert.doesNotMatch(chip, /Stuck|Failed|Ready/,
    "the state words belong to TROUBLE_WORD, not to this component");
});

test("a room says what each agent in it can reach, and offers the door only where the hub would say yes", () => {
  const app = read("App.tsx");
  const panel = bodyOf(app, "RoomPanel");

  // (a) the live call site the retired ChannelRail used to be the only holder of.
  assert.match(panel, /<ReachGap agent=\{who\.agent\}/,
    "RoomPanel must keep drawing the reach line on its agent member rows");
  assert.match(panel, /onEdit=\{who\.agent\.ownerId === world\.me\?\.id\s*\?\s*\(\) => onEditAgent\(who\.agent!\)\s*:\s*undefined\}/,
    "the reach door must be offered only for an agent the viewer owns — the hub refuses the rest");
  assert.match(panel, /presenceSays\(world, m\.memberId, pres\)/,
    "the member row must read the same presence owner every other surface reads");

  // (b) the words and the door still come from the total engine owner.
  const gap = bodyOf(app, "ReachGap");
  assert.match(gap, /reachLineInRoom\(agent, agent\.name\)/,
    "the sentence must stay the engine's total answer, not one written on the screen");
  assert.match(gap, /supplyGapsOf\(agent\)\.length > 0/,
    "a switch on with nothing behind it still speaks first");
  assert.match(gap, /onEdit\s*\?\s*<button className="linkbtn" data-reach-fix/,
    "the fix control is a real door only when there is one to offer");
  assert.match(gap, /:\s*<NotYoursToChange \/>/,
    "and never silence when there is not");

  // (c) the rail this came from stays retired — the two halves are one decision.
  assert.doesNotMatch(app, /<ChannelRail\b/,
    "ChannelRail stays out of the tree; RoomPanel is where this lives now");
});

test("the crew card projects presenceSays once and does not invent a second status system", () => {
  const app = read("App.tsx");
  const crew = bodyOf(app, "CrewScreen");

  assert.match(crew, /presenceSays\(world, a\.id, pres\)/,
    "the crew card must read the same presence owner every other surface reads");
  assert.match(crew, /\{says\.word\}/,
    "the primary flag uses presenceSays.word rather than a hand-typed Ready/Failed");
  assert.doesNotMatch(crew, /\$\{says\.word\} — \$\{says\.reason\}/,
    "the status word must not be repeated on a second line");
  assert.doesNotMatch(crew, /Needs approval/,
    "Needs approval is not a second vocabulary; waitingOn already owns that state");
  assert.match(crew, /Waiting on you/,
    "an unanswered go-ahead still uses the existing Waiting on you phrase");
  assert.match(crew, /cast-runtime/,
    "provider/model stay available as a secondary runtime line");
  assert.match(crew, /className="cast crewcast"/,
    "crew cards use the compact face-beside-facts layout");
  assert.match(crew, /Waiting on your word before it carries on/,
    "an unanswered go-ahead still says the existing why, not a new Needs approval line");
});
