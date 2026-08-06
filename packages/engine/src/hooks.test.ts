// CLOUD9'S OWN HOOKS, held to the five laws in `hooks.ts`.
//
// Every test below is named for the law it defends. If somebody later makes a
// hook able to run a program on an agent the owner set to "ask me first", or
// lets a hook's own message set off another hook, or lets a failing action take
// the turn down with it, this suite goes red on that line and no other.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentDef } from "@cloud9/shared";
import {
  HOOK_ACTIONS, HOOK_EVENTS, HookBook, describeHook, fill, hookProblem, hooksPath,
  isHookEvent, loadHooks, newHookId, saveHooks,
  type Hook, type HookActions, type HookFact,
} from "./hooks.js";

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-hooks-"));

const OWNER = "u_vikas";
const OTHER = "u_someone-else";

function agent(over: Partial<AgentDef> = {}): AgentDef {
  return {
    id: "a_scout", ownerId: OWNER, name: "Scout", emoji: "🔭",
    persona: "helps out",
    // it can run programs, and the owner chose "anything on this computer" —
    // so `needsApprovalToRun` is FALSE and a command hook is allowed
    abilities: { webSearch: false, files: true, schedules: false, background: false, commands: true },
    trust: "localFree",
    approvals: { background: false, schedules: false },
    createdAt: 0,
    ...over,
  } as AgentDef;
}

function hook(over: Partial<Hook> = {}): Hook {
  return {
    id: "h1", name: "Tell me when Scout is done", ownerId: OWNER,
    event: "turn.finished", enabled: true,
    action: { do: "say", agentId: "a_scout", text: "{agent}: {what}" },
    ...over,
  };
}

function fact(over: Partial<HookFact> = {}): HookFact {
  return {
    event: "turn.finished", at: 1_000, ownerId: OWNER,
    agentId: "a_scout", agentName: "Scout", channelId: "c1",
    outcome: "ok", what: "Scout finished answering",
    ...over,
  };
}

/** A book wired to spies, so a test can see exactly what was done. */
function book(opts: {
  hooks?: Hook[];
  agents?: Record<string, AgentDef>;
  actions?: Partial<HookActions>;
  now?: () => number;
} = {}) {
  const said: { agentId: string; channelId: string; text: string }[] = [];
  const noted: { agentId: string; text: string }[] = [];
  const jobs: { agentId: string; channelId: string; title: string }[] = [];
  const commands: { agentId: string; command: string }[] = [];
  const agents = opts.agents ?? { a_scout: agent() };
  const b = new HookBook({
    hooks: () => opts.hooks ?? [hook()],
    agent: id => agents[id],
    log: () => { /* quiet in tests */ },
    ...(opts.now ? { now: opts.now } : {}),
    actions: opts.actions ?? {
      say: a => { said.push(a); },
      note: a => { noted.push(a); },
      job: a => { jobs.push(a); },
      command: a => { commands.push(a); },
    },
  });
  return { b, said, noted, jobs, commands };
}

// ===================================================================
// The events and actions are small, named, and closed
// ===================================================================

test("there are four events and four actions, and nothing else is one", () => {
  assert.deepEqual(Object.keys(HOOK_EVENTS).sort(),
    ["approval.waiting", "check.mismatch", "job.finished", "turn.finished"]);
  assert.deepEqual(Object.keys(HOOK_ACTIONS).sort(), ["command", "job", "note", "say"]);
  assert.equal(isHookEvent("turn.finished"), true);
  assert.equal(isHookEvent("turn.started"), false);
  assert.equal(isHookEvent("__proto__"), false);
});

test("a hook fires its action when its event happens", () => {
  const { b, said } = book();
  const firings = b.fire(fact());
  assert.equal(firings.length, 1);
  assert.equal(firings[0]?.ok, true);
  assert.deepEqual(said, [{ agentId: "a_scout", channelId: "c1", text: "Scout: Scout finished answering" }]);
});

test("a hook waiting for a different event hears nothing", () => {
  const { b, said } = book({ hooks: [hook({ event: "job.finished" })] });
  assert.deepEqual(b.fire(fact({ event: "turn.finished" })), []);
  assert.deepEqual(said, []);
});

test("a hook that is turned off never fires", () => {
  const { b, said } = book({ hooks: [hook({ enabled: false })] });
  assert.deepEqual(b.fire(fact()), []);
  assert.deepEqual(said, []);
});

test("the narrowing filters really narrow — one agent, one outcome", () => {
  const only = book({ hooks: [hook({ when: { agentId: "a_other" } })] });
  assert.deepEqual(only.b.fire(fact()), []);
  const failed = book({ hooks: [hook({ when: { outcome: "failed" } })] });
  assert.deepEqual(failed.b.fire(fact({ outcome: "ok" })), []);
  assert.equal(failed.b.fire(fact({ outcome: "failed" })).length, 1);
});

test("a hook speaks where the thing happened when it names no conversation", () => {
  const { b, said } = book();
  b.fire(fact({ channelId: "c-somewhere-else" }));
  assert.equal(said[0]?.channelId, "c-somewhere-else");
});

test("a hook with nowhere to speak is refused rather than guessing at a room", () => {
  const { b, said } = book();
  const [firing] = b.fire(fact({ channelId: undefined }));
  assert.equal(firing?.ok, false);
  assert.match(String(firing?.said), /nowhere to say/);
  assert.deepEqual(said, []);
});

// ===================================================================
// LAW 1 — A HOOK IS NEVER A WAY ROUND AN APPROVAL
// ===================================================================

test("LAW 1 — a command hook on an agent set to ask first is REFUSED, not asked", () => {
  // the owner left this one on "ask me every time", and it can run programs
  const asks = agent({ trust: "askEveryTime" });
  const { b, commands } = book({
    agents: { a_scout: asks },
    hooks: [hook({ action: { do: "command", agentId: "a_scout", command: "npm test" } })],
  });
  const [firing] = b.fire(fact());
  assert.equal(firing?.ok, false, "a hook must not run a program an agent would be asked about");
  assert.match(String(firing?.said), /ask you first/);
  assert.deepEqual(commands, [], "nothing may reach the runner");
});

test("LAW 1 — the same command hook DOES run for an agent the owner set to go ahead", () => {
  const { b, commands } = book({
    hooks: [hook({ action: { do: "command", agentId: "a_scout", command: "npm test" } })],
  });
  const [firing] = b.fire(fact());
  assert.equal(firing?.ok, true);
  assert.deepEqual(commands, [{ agentId: "a_scout", command: "npm test" }]);
});

// ===================================================================
// LAW 2 — A HOOK NEVER ACTS AS SOMEBODY ELSE
// ===================================================================

test("LAW 2 — a hook never hears about another owner's world", () => {
  const { b, said } = book({ hooks: [hook({ ownerId: OWNER })] });
  assert.deepEqual(b.fire(fact({ ownerId: OTHER })), []);
  assert.deepEqual(said, []);
});

test("LAW 2 — a hook pointing at an agent its owner does not own is refused", () => {
  const theirs = agent({ id: "a_theirs", ownerId: OTHER, name: "Someone else's agent" });
  const { b, said } = book({
    agents: { a_theirs: theirs },
    hooks: [hook({ action: { do: "say", agentId: "a_theirs", text: "hello" } })],
  });
  const [firing] = b.fire(fact());
  assert.equal(firing?.ok, false);
  assert.match(String(firing?.said), /you do not own/);
  assert.deepEqual(said, []);
});

test("LAW 2 — a hook pointing at a deleted agent is refused, in plain words", () => {
  const { b } = book({ agents: {}, hooks: [hook()] });
  const [firing] = b.fire(fact());
  assert.equal(firing?.ok, false);
  assert.match(String(firing?.said), /no longer exists/);
});

// ===================================================================
// LAW 3 — A HOOK NEVER BREAKS THE TURN THAT SET IT OFF
// ===================================================================

test("LAW 3 — an action that throws is recorded as failed and `fire` returns normally", () => {
  const { b } = book({
    actions: { say: () => { throw new Error("the hub went away"); } },
  });
  const firings = b.fire(fact());       // must not throw
  assert.equal(firings.length, 1);
  assert.equal(firings[0]?.ok, false);
  assert.match(String(firings[0]?.said), /could not finish/);
});

test("LAW 3 — a hook list that throws costs nothing at all", () => {
  const b = new HookBook({
    hooks: () => { throw new Error("the hooks file is on fire"); },
    agent: () => agent(),
    actions: {},
    log: () => { /* quiet */ },
  });
  assert.deepEqual(b.fire(fact()), []);
});

test("LAW 3 — an action this copy of Cloud9 cannot do is refused out loud, never skipped", () => {
  const { b } = book({ actions: { note: () => { /* only note is wired */ } } });
  const [firing] = b.fire(fact());       // the hook asks for `say`
  assert.equal(firing?.ok, false);
  assert.match(String(firing?.said), /cannot do/);
});

// ===================================================================
// LAW 4 — A HOOK NEVER SETS OFF ANOTHER HOOK
// ===================================================================

test("LAW 4 — a fact caused by a hook fires nothing", () => {
  const { b, said } = book();
  assert.deepEqual(b.fire(fact({ causedByHook: true })), []);
  assert.deepEqual(said, [], "this is the whole of the loop protection");
});

test("a hook is leashed to six firings a minute", () => {
  let clock = 1_000;
  const { b, said } = book({ now: () => clock });
  for (let i = 0; i < 8; i++) b.fire(fact());
  assert.equal(said.length, 6, "the seventh and eighth were held back");
  clock += 61_000;
  b.fire(fact());
  assert.equal(said.length, 7, "a minute later it may fire again");
});

// ===================================================================
// LAW 5 — VISIBLE AND REMOVABLE
// ===================================================================

test("LAW 5 — every firing is kept, done or refused, with plain words", () => {
  const { b } = book();
  b.fire(fact());
  b.fire(fact({ channelId: undefined }));
  assert.equal(b.recent.length, 2);
  assert.equal(b.recent[0]?.ok, true);
  assert.equal(b.recent[1]?.ok, false);
  for (const f of b.recent) assert.ok(f.said.length > 0);
});

test("LAW 5 — a hook describes itself in words a non-developer reads", () => {
  assert.equal(describeHook(hook()),
    "when an agent finishes answering, post a message in the conversation");
  assert.equal(describeHook(hook({ enabled: false })),
    "when an agent finishes answering, post a message in the conversation — turned off");
  assert.match(describeHook(hook({ when: { outcome: "failed" } })), /only when it went wrong/);
});

test("the placeholders put the FACT into his sentence, and nothing else", () => {
  assert.equal(fill("{agent} → {what} ({outcome})", fact()),
    "Scout → Scout finished answering (ok)");
  // no expression language: an unknown placeholder is left exactly as typed
  assert.equal(fill("{whatever} {agent}", fact()), "{whatever} Scout");
});

// ===================================================================
// STORAGE — the same discipline as schedules.json
// ===================================================================

test("hooks survive a restart", () => {
  const dir = tmp();
  const one = hook({ id: newHookId() });
  assert.equal(saveHooks(dir, [one]), true);
  assert.deepEqual(loadHooks(dir, () => {}), [one]);
});

test("no hooks file at all means no hooks, not a crash", () => {
  assert.deepEqual(loadHooks(tmp(), () => {}), []);
});

test("a damaged hooks file starts with NO hooks rather than half of them", () => {
  const dir = tmp();
  fs.writeFileSync(hooksPath(dir), '[{"id":"h1","name":"hal');
  const heard: string[] = [];
  assert.deepEqual(loadHooks(dir, m => heard.push(m)), []);
  assert.match(heard.join(" "), /damaged/);
});

test("a saved hook that cannot be acted on is DROPPED and said out loud", () => {
  const dir = tmp();
  const good = hook({ id: "h-good" });
  fs.writeFileSync(hooksPath(dir), JSON.stringify([
    good,
    { ...hook({ id: "h-bad" }), event: "turn.started" },   // an event we cannot report
    { ...hook({ id: "h-worse" }), action: { do: "email", agentId: "a_scout", text: "hi" } },
  ]));
  const heard: string[] = [];
  const loaded = loadHooks(dir, m => heard.push(m));
  assert.deepEqual(loaded.map(h => h.id), ["h-good"]);
  assert.equal(heard.length, 2, "both drops were said out loud");
});

test("hookProblem names the problem in plain words", () => {
  assert.equal(hookProblem(hook()), null);
  assert.match(String(hookProblem({ ...hook(), ownerId: "" })), /whose it is/);
  assert.match(String(hookProblem({ ...hook(), event: "nope" })), /cannot tell it about/);
  assert.match(String(hookProblem({ ...hook(), enabled: "yes" })), /whether it is on/);
  assert.match(String(hookProblem({ ...hook(), action: { do: "say", agentId: "a", text: "" } })),
    /what to do exactly/);
  assert.match(
    String(hookProblem({ ...hook(), action: { do: "command", agentId: "a", command: "x".repeat(600) } })),
    /too long/);
  assert.equal(hookProblem(null), "that isn't a rule");
});
