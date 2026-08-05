// FULLY CAPABLE THE SECOND IT EXISTS — 2026-08-05.
//
// THE BUG THESE TESTS EXIST TO MAKE IMPOSSIBLE. Vikas asked, for weeks and
// finally in anger, for agents that work "like codex or claude code". He made
// one, asked it what it could do, and was told:
//
//   "What I can't do: run git, npm, or build commands; create branches; push
//    PRs; or delegate the work to other agents. Those need switches you'd have
//    to turn on."
//
// Every word of that was TRUE. `NEW_AGENT_ABILITIES` was a subset — web search,
// background jobs — so the first thing every agent he made did was explain what
// it was not. The default is now the whole working set, and these tests pin the
// three things that make that safe rather than reckless: the approval card is
// still forced on, the agents he already has are only changed when he presses
// something, and his own Claude Code setup is still shut out at full reach.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentAbilities, AgentDef, ALWAYS_ASK_ABILITIES, mayDriveAgent } from "@cloud9/shared";
import {
  CAPABILITIES, NEW_AGENT_ABILITIES, REACH_LEVELS, abilitiesForReach, agentsWithoutFullReach,
  approvalsFor, bringUpToFullReach, capabilitiesForNewAgent, claudeToolsFor,
  hasFullReach, needsApprovalToRun, renderCapabilities,
} from "./abilities.js";
import { CLAUDE_ISOLATION_FLAGS, claudeArgs } from "./claude-cli.js";
import { isolationFor } from "./isolation.js";

const HOME = "C:\\Users\\vikasmit";

/** An agent exactly as the app creates one today. */
const newAgent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You help me build",
  abilities: { ...NEW_AGENT_ABILITIES }, createdAt: 0,
  wholeComputerRoots: [HOME],
  ...over,
});

/** One of the six he already had, made before the defaults moved. */
const oldAgent = (abilities: Partial<AgentAbilities> = {}, over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a2", ownerId: "u1", name: "Architect", emoji: "📐", persona: "You plan things",
  abilities: {
    webSearch: true, files: false, schedules: false, background: true, ...abilities,
  } as AgentAbilities,
  createdAt: 0, ...over,
});

// ------------------------------------------------- 1 · what a new agent gets

test("a brand-new agent starts with every capability this app can actually grant", () => {
  for (const cap of capabilitiesForNewAgent()) {
    assert.equal(NEW_AGENT_ABILITIES[cap.ability], true,
      `a new agent cannot do "${cap.label}" — this is the subset bug coming back`);
  }
  // the three he was refused by name, spelled out so a regression reads plainly
  assert.equal(NEW_AGENT_ABILITIES.commands, true, "still cannot run git, npm or a build");
  assert.equal(NEW_AGENT_ABILITIES.helpers, true, "still cannot hand work to helper agents");
  assert.equal(NEW_AGENT_ABILITIES.wholeComputer, true, "still cannot reach his files");
  assert.equal(NEW_AGENT_ABILITIES.files, true);
  assert.equal(NEW_AGENT_ABILITIES.webSearch, true);
  assert.equal(NEW_AGENT_ABILITIES.schedules, true);
  assert.equal(NEW_AGENT_ABILITIES.background, true);
});

test("the default IS the top rung, minus only rows that must say why they are out", () => {
  const top = abilitiesForReach("computer");
  for (const cap of CAPABILITIES) {
    if (cap.offForNewAgents) {
      assert.equal(NEW_AGENT_ABILITIES[cap.ability], false);
      // A row may only opt out by saying, in his words, why — otherwise "off by
      // default" becomes a quiet place to park a capability nobody argued for.
      assert.equal(typeof cap.whyOffForNewAgents, "string");
      assert.ok((cap.whyOffForNewAgents ?? "").length > 60,
        `${cap.ability} opts out of the default with no reason a person could read`);
      // …and it may only be a row that grants NOTHING until something the app
      // cannot produce is handed over.
      assert.ok(cap.needsSupply, `${cap.ability} is off by default and needs nothing supplied`);
      assert.deepEqual(cap.claudeTools, [],
        `${cap.ability} is off by default but would have granted real tools`);
      continue;
    }
    assert.equal(NEW_AGENT_ABILITIES[cap.ability], top[cap.ability],
      `${cap.ability} differs from the top rung for no stated reason`);
  }
  // exactly one row is held back today, and it is connected services
  assert.deepEqual(CAPABILITIES.filter(c => c.offForNewAgents).map(c => c.ability), ["connections"]);
});

test("what a new agent gets IS a rung, so its file never reads as a mixture", () => {
  // The default has to be describable. A set of switches that is not a rung is
  // drawn as "your own mixture — 7 of 8", and that banner would have been on
  // every agent he ever made. `connections` sits last in the table for exactly
  // this reason, so the working set is a prefix like every other rung.
  assert.deepEqual(abilitiesForReach("mypc"), NEW_AGENT_ABILITIES);
  const rung = REACH_LEVELS.find(r => r.level === "mypc");
  assert.ok(rung, "the rung a new agent is has gone");
  assert.equal(rung!.rows, capabilitiesForNewAgent().length);
  // …and the rungs beneath it still grant exactly what they did before
  assert.deepEqual(
    CAPABILITIES.slice(0, 5).map(c => c.ability),
    ["webSearch", "files", "helpers", "schedules", "background"],
    "reordering the table moved a row out of a rung it was already in");
  assert.equal(REACH_LEVELS[REACH_LEVELS.length - 1].level, "computer",
    "the top of the ladder is still everything this app can do");
});

test("a new agent is handed the real tools, not just the words", () => {
  const tools = claudeToolsFor(newAgent());
  for (const want of ["Bash", "PowerShell", "Read", "Write", "Edit", "Task", "WebSearch"]) {
    assert.ok(tools.includes(want), `${want} was not granted to a brand-new agent`);
  }
  // and it is told so — no agent may answer "I can't" about a switch that is on
  const words = renderCapabilities(newAgent(), { wholeComputerRoots: [HOME] });
  assert.match(words, /You CAN run programs and commands on this computer/);
  assert.match(words, /You CAN hand parts of a job to helper agents/);
  assert.match(words, /You CAN reach files outside your own folder/);
});

// --------------------------------- 2 · the folder: really set, or not claimed

test("a new agent really gets --add-dir, so it can read a file outside its own folder", () => {
  const args = claudeArgs(newAgent(), [], { wholeComputerRoots: [HOME] });
  const at = args.indexOf("--add-dir");
  assert.ok(at > -1, "the home folder never reached the command line");
  assert.equal(args[at + 1], HOME);
});

test("no folder supplied is said plainly — the app never claims one it did not set", () => {
  const noFolder = newAgent({ wholeComputerRoots: undefined });
  const args = claudeArgs(noFolder, [], {});
  assert.ok(!args.includes("--add-dir"));
  const words = renderCapabilities(noFolder, {});
  assert.match(words, /You CANNOT reach anything outside your own folder right now/);
});

// ------------------------------------------- 3 · the approval gate is untouched

test("a fully capable new agent still stops and asks before it acts", () => {
  const fresh = newAgent();
  assert.equal(needsApprovalToRun(fresh), true);
  const asks = approvalsFor(fresh);
  for (const ability of ALWAYS_ASK_ABILITIES) {
    if (fresh.abilities[ability] !== true) continue;
    assert.equal(asks[ability], true, `${ability} is on by default and does NOT ask first`);
  }
  assert.equal(asks.commands, true);
  assert.equal(asks.wholeComputer, true);
});

test("a stored (or forged) 'do not ask me' cannot switch the gate off", () => {
  const lying: AgentDef = {
    ...newAgent(),
    approvals: { background: false, schedules: false, commands: false, wholeComputer: false },
  };
  assert.equal(approvalsFor(lying).commands, true);
  assert.equal(approvalsFor(lying).wholeComputer, true);
  assert.equal(needsApprovalToRun(lying), true);
});

test("full power does not mean anyone may use it — driving is still owner-only", () => {
  const fresh = newAgent();
  assert.equal(mayDriveAgent("u1", fresh), true, "his own agent");
  assert.equal(mayDriveAgent("someone-else", fresh), false,
    "a capable agent became a capable agent for anybody");
});

// ------------------------------------ 4 · the six he already has, in one press

test("nothing about a stored agent changes until the one press happens", () => {
  const stored = oldAgent();
  const before = JSON.stringify(stored);
  const behind = agentsWithoutFullReach([stored], HOME);
  assert.deepEqual(behind.map(a => a.name), ["Architect"], "it is not even offered the upgrade");
  assert.equal(JSON.stringify(stored), before, "asking the question changed the agent");
});

test("the one press grants a stored agent exactly what a new one gets", () => {
  const { agent: after, changed } = bringUpToFullReach(oldAgent(), HOME);
  assert.equal(changed, true);
  for (const cap of capabilitiesForNewAgent()) {
    assert.equal(after.abilities[cap.ability], NEW_AGENT_ABILITIES[cap.ability],
      `${cap.ability} differs from what a brand-new agent gets`);
  }
  assert.deepEqual(after.wholeComputerRoots, [HOME]);
  assert.equal(hasFullReach(after, HOME), true);
  // …and it still asks him first
  assert.equal(approvalsFor(after).commands, true);
});

test("the one press only ever ADDS — no switch and no folder of his is lost", () => {
  const his = oldAgent({ connections: true } as Partial<AgentAbilities>, {
    wholeComputerRoots: ["D:\\work"],
    respondTo: "allowlist", respondToAllowlist: ["u9"],
    skills: [{ id: "s1", name: "Ops", description: "how we deploy", instructions: "check the logs" }],
  });
  const { agent: after } = bringUpToFullReach(his, HOME);
  assert.equal(after.abilities.connections, true, "a switch he turned on was taken away");
  assert.deepEqual(after.wholeComputerRoots, ["D:\\work"], "the folder he chose was replaced");
  assert.equal(after.respondTo, "allowlist");
  assert.deepEqual(after.respondToAllowlist, ["u9"]);
  assert.equal(after.skills?.length, 1);
});

test("an agent that already has everything is not saved again for nothing", () => {
  const already = newAgent();
  assert.equal(hasFullReach(already, HOME), true);
  assert.deepEqual(agentsWithoutFullReach([already], HOME), []);
  assert.equal(bringUpToFullReach(already, HOME).changed, false);
});

test("allowed out of its own folder with nowhere to go is not full reach either", () => {
  const halfway = newAgent({ wholeComputerRoots: [] });
  assert.equal(hasFullReach(halfway, HOME), false);
  const { agent: after, changed } = bringUpToFullReach(halfway, HOME);
  assert.equal(changed, true);
  assert.deepEqual(after.wholeComputerRoots, [HOME]);
});

test("no home folder to offer means no folder is invented", () => {
  const halfway = newAgent({ wholeComputerRoots: [] });
  const { agent: after, changed } = bringUpToFullReach(halfway, undefined);
  assert.deepEqual(after.wholeComputerRoots ?? [], [],
    "a folder was claimed that this computer never vouched for");
  assert.equal(changed, false, "an agent was saved for a change that never happened");
  // and the command line carries no folder either — the honest empty
  assert.ok(!claudeArgs(after, [], {}).includes("--add-dir"));
});

// ------------------------------------------- 5 · his own setup is still shut out

test("at the new default reach the owner's own Claude Code setup is STILL shut out", () => {
  const args = claudeArgs(newAgent(), [], { wholeComputerRoots: [HOME] });
  // asked of the CONSTANT, so a flag dropped from the list is caught too
  assert.ok(CLAUDE_ISOLATION_FLAGS.length >= 4, "the isolation flags were thinned out");
  for (const flag of CLAUDE_ISOLATION_FLAGS) {
    assert.ok(args.includes(flag), `${flag} is gone — his CLAUDE.md, hooks or MCP servers could load`);
  }
  // his own connected services can never arrive, at any reach
  assert.ok(args.includes("--strict-mcp-config"));
  const claude = isolationFor("claude")!;
  assert.equal(claude.togglesAreTheBoundary, true);
});

// ------------------------------------------------ 6 · a refusal is one action

test("every switch's how-to-fix is the ONE press, never a six-step path", () => {
  for (const cap of CAPABILITIES) {
    assert.match(cap.fixItInApp, /Work on my computer, like Claude Code/,
      `${cap.ability} still sends him somewhere other than the one press`);
    assert.ok(cap.fixItInApp.includes(cap.label));
    assert.ok(!/switch on “/.test(cap.fixItInApp.split("That single press")[0]),
      `${cap.ability} still asks him to find a switch himself`);
  }
});

test("a fully capable agent has almost nothing left to refuse", () => {
  const words = renderCapabilities(newAgent(), { wholeComputerRoots: [HOME] });
  const refusals = CAPABILITIES.filter(c => words.includes(c.cannot));
  assert.deepEqual(refusals.map(c => c.ability), ["connections"],
    "a new agent is still telling him what it cannot do");
  // and the one that is left names the single thing he would have to do
  assert.match(words, /Choose the file/);
});
