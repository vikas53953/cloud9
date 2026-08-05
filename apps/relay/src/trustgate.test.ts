// THE HUB'S HALF OF "HOW MUCH MAY THIS AGENT DO ON ITS OWN".
//
// `alwaysask.test.ts` next door pins the old law: an agent that can run programs
// ALWAYS asks before an unattended job starts. That law was right and it was
// also, by 2026-08-05, the thing making Vikas angry — because every new agent
// now gets those powers, so every job he handed to any agent stopped at a card
// before it began.
//
// The freedom is now a SETTING HE CHOOSES per agent, and the hub is where it
// decides whether a delegated job may start. Two processes have to agree about
// one rule and cannot see each other's code, which is exactly how the hub and
// the engine came to disagree the first time — so this file pins the hub's half
// of the new rule the same way that one pinned the old.
//
// VERIFIED FAILING BEFORE THE CHANGE: with the old body of `mustAskBeforeActing`
// (no trust setting), "a trusted agent's job starts without a card" returns true
// and the first two tests below fail.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentDef, NEW_AGENT_TRUST, TRUST_LEVELS } from "@cloud9/shared";
import { requiresApproval } from "./server.js";

/** A fully capable agent — what every agent he makes now is. */
function agent(over: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭",
    persona: "you build things",
    abilities: {
      webSearch: true, files: true, schedules: true, background: true,
      helpers: true, commands: true, wholeComputer: true,
    },
    approvals: { background: false, schedules: false },
    createdAt: 1,
    ...over,
  } as AgentDef;
}

test("a trusted agent's job starts without a card — this is the whole complaint, fixed", () => {
  const trusted = agent({ trust: "localFree" });
  assert.equal(requiresApproval(trusted, "go build the thing"), false);
  assert.equal(requiresApproval(trusted, "clean up the downloads folder"), false);
});

test("“don't ask me” means the job starts too, including a schedule", () => {
  const free = agent({ trust: "neverAsk" });
  assert.equal(requiresApproval(free, "go build the thing"), false);
  assert.equal(requiresApproval(free, "!schedule every 10m check the disk"), false);
});

test("an agent he already owns is UNCHANGED — it still asks before every job", () => {
  // no `trust` field at all: his six existing agents, exactly as stored
  const existing = agent();
  assert.equal("trust" in existing, false);
  assert.equal(requiresApproval(existing, "go build the thing"), true);
  assert.equal(requiresApproval(existing, "!schedule daily 09:00 stand-up"), true);
  // and saying so explicitly is the same answer
  assert.equal(requiresApproval(agent({ trust: "askEveryTime" }), "go build the thing"), true);
});

test("a connected service still stops the job, even on the middle setting", () => {
  const withService = agent({
    abilities: {
      webSearch: true, files: true, schedules: true, background: true,
      helpers: true, commands: true, wholeComputer: true, connections: true,
    },
    trust: "localFree",
  } as Partial<AgentDef>);
  assert.equal(requiresApproval(withService, "post the update"), true);
});

test("a forged trust value cannot start a job unattended", () => {
  // the hub reads the STORED agent, and a value that is not one of the three
  // exact words is not a setting — it is noise, and noise means "ask me".
  for (const forged of ["neverask", "bypass-permissions", "", 1, true, null, {}, ["neverAsk"]]) {
    const lying = agent({ trust: forged } as Partial<AgentDef>);
    assert.equal(requiresApproval(lying, "go build the thing"), true,
      `forged: ${JSON.stringify(forged)}`);
  }
});

test("the settings he can be given are exactly three, and the default is the middle one", () => {
  assert.equal(TRUST_LEVELS.length, 3);
  assert.equal(NEW_AGENT_TRUST, "localFree");
  // the ordinary approval rules still work for an agent with no powers that ask
  const plain = agent({
    abilities: { webSearch: true, files: false, schedules: false, background: true },
    approvals: { background: true, schedules: false },
  });
  assert.equal(requiresApproval(plain, "do the thing"), true);
  assert.equal(requiresApproval(plain, "!schedule daily 09:00 stand-up"), false);
});
