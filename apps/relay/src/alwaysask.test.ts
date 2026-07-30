// AN AGENT THAT CAN RUN PROGRAMS ALWAYS ASKS FIRST.
//
// The ability ladder now goes all the way up to "everything this app can do on
// this computer" — shells, editing files anywhere, connected services. The
// engine forces those to ask before acting. The HUB decides whether a delegated
// job needs a yes before it runs, and it was reading `agent.approvals` on its
// own: a shell-capable agent with `background: false` stored would have had its
// unattended job start with nobody ever asked.
//
// Two processes had to agree about one rule and could not see each other's
// code. The rule now lives in shared (`mustAskBeforeActing`), and this file
// pins the hub's half of it.
//
// Verified failing before the fix: with the old body of `requiresApproval`,
// every "must ask" case below returns false.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentDef } from "@cloud9/shared";
import { requiresApproval } from "./server.js";

function agent(over: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭",
    persona: "you look things up",
    abilities: { webSearch: true, files: false, schedules: false, background: true },
    createdAt: 1,
    ...over,
  } as AgentDef;
}

test("an agent that can run programs is asked about, even when nothing was stored", () => {
  const a = agent({
    abilities: { webSearch: true, files: true, schedules: false, background: true, commands: true },
    // deliberately the shape a client would send to get a silent machine
    approvals: { background: false, schedules: false },
  });
  assert.equal(requiresApproval(a, "tidy up the downloads folder"), true);
  assert.equal(requiresApproval(a, "!schedule every 10m check the disk"), true);
});

test("reaching the whole computer, or connected services, asks too", () => {
  for (const ability of ["wholeComputer", "connections"] as const) {
    const a = agent({
      abilities: {
        webSearch: false, files: false, schedules: false, background: true,
        [ability]: true,
      } as AgentDef["abilities"],
      approvals: { background: false, schedules: false },
    });
    assert.equal(requiresApproval(a, "do the thing"), true, `${ability} must ask`);
  }
});

test("an ordinary agent is unchanged — the old rules still decide", () => {
  const plain = agent({ approvals: { background: false, schedules: false } });
  assert.equal(requiresApproval(plain, "do the thing"), false);
  assert.equal(requiresApproval(plain, "!schedule daily 09:00 stand-up"), false);

  const asks = agent({ approvals: { background: true, schedules: false } });
  assert.equal(requiresApproval(asks, "do the thing"), true);
  assert.equal(requiresApproval(asks, "!schedule daily 09:00 stand-up"), false);

  const asksSchedules = agent({ approvals: { background: false, schedules: true } });
  assert.equal(requiresApproval(asksSchedules, "!schedule daily 09:00 stand-up"), true);
  assert.equal(requiresApproval(asksSchedules, "do the thing"), false);
});

test("an agent with no approvals stored at all is still asked about, if it can run programs", () => {
  const a = agent({
    abilities: { webSearch: false, files: false, schedules: false, background: true, commands: true },
    approvals: undefined,
  });
  assert.equal(requiresApproval(a, "anything"), true);
});
