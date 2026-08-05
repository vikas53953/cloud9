// A SWITCH ON WITH NOTHING BEHIND IT — the half-state, held to.
//
// Vikas, 2026-08-05: he asked an agent to read a file on his PC and was told "I
// can't reach files outside this directory". The switch was ON and no folder had
// ever been chosen. These tests are about the ONE function every screen now asks
// so that state can never again be visible in only one place.
//
// Run it:  npm test -w @cloud9/shared
import test from "node:test";
import assert from "node:assert/strict";
import {
  ALWAYS_ASK_ABILITIES, SUPPLY_SWITCHES, supplyChosen, supplyGapsOf,
} from "./index.js";

const agent = (over: Record<string, unknown> = {}) => ({
  abilities: { webSearch: true, files: true, schedules: false, background: false },
  ...over,
} as Parameters<typeof supplyGapsOf>[0]);

test("no gap when neither supply switch is on", () => {
  assert.deepEqual(supplyGapsOf(agent()), []);
});

test("wholeComputer on with no folder IS the gap he met", () => {
  const gaps = supplyGapsOf(agent({
    abilities: { webSearch: true, files: true, schedules: false, background: false, wholeComputer: true },
  }));
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].ability, "wholeComputer");
  assert.equal(gaps[0].field, "wholeComputerRoots");
});

test("choosing a folder closes it", () => {
  const gaps = supplyGapsOf(agent({
    abilities: { webSearch: true, files: true, schedules: false, background: false, wholeComputer: true },
    wholeComputerRoots: ["C:\\Users\\vikasmit"],
  }));
  assert.deepEqual(gaps, []);
});

test("a list of blanks is not a folder — the gap stays open", () => {
  const gaps = supplyGapsOf(agent({
    abilities: { webSearch: true, files: true, schedules: false, background: false, wholeComputer: true },
    wholeComputerRoots: ["   ", ""],
  }));
  assert.equal(gaps.length, 1);
});

test("connections has the SAME shape and is answered by the same function", () => {
  const gaps = supplyGapsOf(agent({
    abilities: { webSearch: true, files: true, schedules: false, background: false, connections: true },
  }));
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].field, "connectionsFile");
  const closed = supplyGapsOf(agent({
    abilities: { webSearch: true, files: true, schedules: false, background: false, connections: true },
    connectionsFile: "C:\\Users\\vikasmit\\connections.json",
  }));
  assert.deepEqual(closed, []);
});

test("a blank string is not a chosen file", () => {
  assert.equal(supplyChosen({ connectionsFile: "  " }, SUPPLY_SWITCHES[1]), false);
});

test("both supply switches ask the owner first — the gap is never a way round approval", () => {
  for (const s of SUPPLY_SWITCHES) {
    assert.ok(
      (ALWAYS_ASK_ABILITIES as readonly string[]).includes(s.ability),
      `${s.ability} needs something supplied but does not ask the owner first`,
    );
  }
});

test("an agent with no abilities at all has no gaps", () => {
  assert.deepEqual(supplyGapsOf({} as Parameters<typeof supplyGapsOf>[0]), []);
});
