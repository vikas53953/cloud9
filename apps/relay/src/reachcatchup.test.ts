// THE ONE-TIME CATCH-UP, held to the four promises it makes.
//
// Read from his real database on 2026-08-05: five of his six agents had no
// `commands` key at all, none of the six had a folder of his opened up, and not
// one had a trust setting — so every one of them was telling him the truth when
// it said it could not run git. The hub now fixes that by itself, once. These
// tests are the reasons that is safe:
//
//   1. it ADDS the missing switches, the folder and the trust setting;
//   2. it never REMOVES anything — a switch he set, a folder he chose and a
//      trust setting he picked all survive it;
//   3. it runs ONCE, across restarts, on the same file — so something he
//      narrows afterwards stays narrow;
//   4. it touches only agents whose owner is the person running this hub, and
//      does not run at all on a hub with no owner;
//   5. the notice names the right agents and the right switches.
//
// It drives the REAL Store, not a fake, because promise 3 is entirely about what
// survives in his file and a fake would prove nothing about that.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentDef, NEW_AGENT_TRUST } from "@cloud9/shared";
import { capabilitiesForNewAgent } from "@cloud9/engine";
import { Store } from "./store.js";
import { REACH_CATCHUP_KEY, runReachCatchup } from "./reachcatchup.js";
import { tmp } from "./testclient.js";

const OWNER = "u-vikas";
const HOME = "C:\\Users\\vikasmit";

/** One of the six he already has: made before the defaults moved. */
function oldAgent(over: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "a-sonnet", name: "sonnet", ownerId: OWNER, model: "sonnet",
    brief: "help", emoji: "🤖", createdAt: 1,
    // exactly what his database holds: no `commands`, no `helpers`, no roots,
    // no trust field at all
    abilities: { webSearch: true, files: true, schedules: false, background: true },
    ...over,
  } as AgentDef;
}

/** A fresh file, and the same file opened again — his hub restarting. */
function fileFor(name: string): { open: () => Store; path: string } {
  const p = tmp(name);
  return { path: p, open: () => new Store(p, { ownerToken: "tok-owner" }) };
}

// ---------------------------------------------------------------- 1 · it adds

test("the catch-up gives an old agent every switch a new one gets", () => {
  const store = fileFor("catchup-adds.db").open();
  store.saveAgent(oldAgent());

  const said = runReachCatchup(store, OWNER, { homeFolder: HOME, now: 100 });

  const after = store.agents()[0]!;
  for (const cap of capabilitiesForNewAgent()) {
    assert.equal(after.abilities[cap.ability], true, `${cap.ability} was left off`);
  }
  assert.deepEqual(after.wholeComputerRoots, [HOME], "it was left with nowhere to go");
  assert.equal(after.trust, NEW_AGENT_TRUST, "it would still stop and ask before every job");
  assert.ok(said, "it changed his agents and said nothing");
  assert.equal(said.ranAt, 100);
  assert.equal(said.trust, NEW_AGENT_TRUST);
});

test("a switch that is nothing without a file he supplies is still not switched on", () => {
  const store = fileFor("catchup-connections.db").open();
  store.saveAgent(oldAgent());
  runReachCatchup(store, OWNER, { homeFolder: HOME });
  assert.notEqual(store.agents()[0]!.abilities.connections, true,
    "the app promised a connected service it cannot produce");
});

// ------------------------------------------------------------ 2 · it only adds

test("nothing he set is taken away — his switch, his folder, his trust setting", () => {
  const store = fileFor("catchup-onlyadds.db").open();
  store.saveAgent(oldAgent({
    abilities: { webSearch: true, files: true, schedules: false, background: true, connections: true },
    wholeComputerRoots: ["D:\\work"],
    trust: "askEveryTime",
    skills: [{ id: "s1", name: "Ops", description: "how we deploy", instructions: "read the logs" }],
  } as Partial<AgentDef>));

  runReachCatchup(store, OWNER, { homeFolder: HOME });

  const after = store.agents()[0]!;
  assert.equal(after.abilities.connections, true, "a switch he turned on was turned off");
  assert.deepEqual(after.wholeComputerRoots, ["D:\\work"], "the folder he chose was replaced");
  assert.equal(after.trust, "askEveryTime", "a setting he really picked was overwritten");
  assert.equal(after.skills?.length, 1, "the rest of his agent did not survive the write");
  // …and it still gained the ones it was missing
  assert.equal(after.abilities.commands, true);
});

test("no home folder to offer means no folder is invented", () => {
  const store = fileFor("catchup-nohome.db").open();
  store.saveAgent(oldAgent());
  runReachCatchup(store, OWNER, {});
  const after = store.agents()[0]!;
  assert.deepEqual(after.wholeComputerRoots ?? [], [],
    "a folder was claimed that this computer never vouched for");
  assert.equal(after.abilities.commands, true, "the switches were held hostage to the folder");
});

// -------------------------------------------------------------- 3 · exactly once

test("it runs once, and a restart does not undo what he changed afterwards", () => {
  const file = fileFor("catchup-once.db");
  const first = file.open();
  first.saveAgent(oldAgent());
  assert.ok(runReachCatchup(first, OWNER, { homeFolder: HOME }), "the first start did nothing");
  assert.ok(first.meta(REACH_CATCHUP_KEY) !== undefined, "nothing was written down");

  // he goes into the editor and deliberately narrows that agent right back
  const narrowed = { ...first.agents()[0]!, abilities: { ...first.agents()[0]!.abilities, commands: false } };
  first.saveAgent(narrowed as AgentDef);

  // …and restarts Cloud9. Same file, new hub.
  const second = file.open();
  assert.equal(runReachCatchup(second, OWNER, { homeFolder: HOME }), undefined,
    "it ran a second time");
  assert.equal(second.agents()[0]!.abilities.commands, false,
    "his own decision was overwritten by a migration that came back");
});

test("nothing to do is still an answer it only gives once", () => {
  const file = fileFor("catchup-nothing.db");
  const first = file.open();
  assert.equal(runReachCatchup(first, OWNER, { homeFolder: HOME }), undefined,
    "an empty crew produced a notice about nobody");
  assert.ok(first.meta(REACH_CATCHUP_KEY) !== undefined,
    "it will wake up again months later and run on agents made since");

  const second = file.open();
  second.saveAgent(oldAgent());
  assert.equal(runReachCatchup(second, OWNER, { homeFolder: HOME }), undefined);
  assert.notEqual(second.agents()[0]!.abilities.commands, true,
    "an agent made after the catch-up was rewritten by it");
});

// ------------------------------------------------------------ 4 · his agents only

test("an agent somebody else owns is not touched", () => {
  const store = fileFor("catchup-guest.db").open();
  store.saveAgent(oldAgent({ id: "a-guest", name: "priya-bot", ownerId: "u-priya" }));
  store.saveAgent(oldAgent());

  const said = runReachCatchup(store, OWNER, { homeFolder: HOME });

  const guest = store.agents().find(a => a.id === "a-guest")!;
  assert.notEqual(guest.abilities.commands, true, "a guest's agent was widened on his hub");
  assert.equal(guest.trust, undefined, "a guest's agent had its trust setting changed");
  assert.deepEqual(said?.agents.map(a => a.name), ["sonnet"]);
});

test("a hub with no owner does not run this at all", () => {
  const store = fileFor("catchup-noowner.db").open();
  store.saveAgent(oldAgent());
  assert.equal(runReachCatchup(store, undefined, { homeFolder: HOME }), undefined);
  assert.notEqual(store.agents()[0]!.abilities.commands, true);
  assert.equal(store.meta(REACH_CATCHUP_KEY), undefined,
    "it marked itself done on a hub it must not run on");
});

// --------------------------------------------------------------- 5 · the notice

test("the notice names the agents that changed, in the words on the switches", () => {
  const store = fileFor("catchup-notice.db").open();
  store.saveAgent(oldAgent());
  store.saveAgent(oldAgent({ id: "a-fable", name: "Fable5", trust: "neverAsk" }));

  const said = runReachCatchup(store, OWNER, { homeFolder: HOME, now: 7 })!;

  assert.deepEqual(said.agents.map(a => a.name).sort(), ["Fable5", "sonnet"]);
  const sonnet = said.agents.find(a => a.name === "sonnet")!;
  assert.ok(sonnet.gained.includes("Run programs on this computer"),
    `the switch he was missing is not named: ${sonnet.gained.join(" / ")}`);
  assert.ok(!sonnet.gained.includes("Look things up on the web"),
    "it claimed to have given something the agent already had");
  assert.equal(sonnet.folder, HOME);
  assert.equal(sonnet.trustSet, true);
  assert.equal(said.agents.find(a => a.name === "Fable5")!.trustSet, false,
    "a setting he really picked was reported as one this gave it");
  assert.equal(said.homeFolder, HOME);
});

test("an agent that already had everything is not named and not saved again", () => {
  const store = fileFor("catchup-already.db").open();
  const full: AgentDef = oldAgent({
    id: "a-new", name: "brandnew", trust: NEW_AGENT_TRUST, wholeComputerRoots: [HOME],
    abilities: Object.fromEntries(
      capabilitiesForNewAgent().map(c => [c.ability, true]),
    ) as unknown as AgentDef["abilities"],
  });
  store.saveAgent(full);
  const before = JSON.stringify(store.agents()[0]);

  assert.equal(runReachCatchup(store, OWNER, { homeFolder: HOME }), undefined,
    "he was told about a change that never happened");
  assert.equal(JSON.stringify(store.agents()[0]), before);
});
