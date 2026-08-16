import test from "node:test";
import assert from "node:assert/strict";
import {
  agentForInvocation, invocationTargetFor, validateAgentInvocation, validateAgentInvocationReceipt,
  validateRunRecord,
  type AgentAbilities, type AgentDef,
} from "./index.js";

const abilities: AgentAbilities = {
  webSearch: true, files: true, schedules: false, background: false,
  commands: true, wholeComputer: true, connections: false,
};
const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔎", persona: "helper",
  abilities, provider: "claude", trust: "localFree", model: "claude-sonnet-4-5", createdAt: 0,
  ...over,
});

test("invocation validation accepts a catalog-backed request and rejects unknown model", () => {
  const a = agent();
  assert.equal(validateAgentInvocation(a, {
    agentId: "a1", model: "claude-sonnet-4-5", effort: "hard", permissionScope: "readOnly",
  }, ["claude-sonnet-4-5"]), null);
  assert.match(validateAgentInvocation(a, { agentId: "a1", model: "not-a-model" }, ["claude-sonnet-4-5"])!, /model/);
  assert.match(validateAgentInvocation(a, { agentId: "other" })!, /does not name/);
  assert.match(validateAgentInvocation(a, { agentId: "a1", model: "claude-sonnet-4-5" })!, /catalog/);
});

test("invocation target is exactly one ordered, unambiguous text or stable-id mention", () => {
  const agents = [{ id: "a1", name: "Scout" }, { id: "a2", name: "Architect" }];
  assert.equal(invocationTargetFor("@Architect then @Scout", agents), undefined);
  assert.equal(invocationTargetFor("@Scout @Scout", agents), undefined);
  assert.equal(invocationTargetFor("@a1 inspect", agents), "a1");
  assert.equal(invocationTargetFor("@Scout inspect", [{ id: "a1", name: "Scout" }, { id: "a2", name: "Scout" }]), undefined);
});

test("invocation receipts are bounded public metadata", () => {
  const receipt = agentForInvocation(agent(), { agentId: "a1", permissionScope: "readOnly" }).receipt!;
  assert.equal(validateAgentInvocationReceipt(receipt), null);
  assert.match(validateAgentInvocationReceipt({ ...receipt, secret: "nope" })!, /unknown fields/);
  assert.match(validateAgentInvocationReceipt({ ...receipt, abilities: { ...receipt.abilities, files: "yes" } })!, /abilities/);
  assert.match(validateAgentInvocationReceipt({ ...receipt, agentId: "other" }, "a1")!, /different agent/);
  assert.match(validateAgentInvocationReceipt({ ...receipt, trust: "neverAsk" })!, /read-only/);
  assert.match(validateAgentInvocationReceipt({ ...receipt, abilities: { ...receipt.abilities, webSearch: true } })!, /cannot carry abilities/);
  assert.match(validateAgentInvocationReceipt({ ...receipt, effort: "quick", requestedEffort: "hard", fallback: "provider-default" })!, /effort fallback/);
  assert.match(validateAgentInvocationReceipt({ ...receipt, effort: "hard", requestedEffort: "hard", fallback: "provider-default" })!, /fallback/);

  const run = {
    id: "r-000000000-0000", kind: "chat", agentId: "a1", agentName: "Scout", provider: "claude",
    requestedBy: "Vikas", requestedByKind: "human", ask: "inspect", startedAt: 0, finishedAt: 1,
    durationMs: 1, outcome: "ok", steps: [], replyChars: 0, events: 0, trust: "askEveryTime",
    invocation: { ...receipt, agentId: "other" },
  } as const;
  assert.match(validateRunRecord(run)!, /different agent/);
});

test("read-only invocation narrows trust and every stored ability", () => {
  const result = agentForInvocation(agent(), {
    agentId: "a1", model: "claude-sonnet-4-5", effort: "hard", permissionScope: "readOnly",
  });
  assert.equal(result.agent.model, "claude-sonnet-4-5");
  assert.equal(result.agent.effort, "hard");
  assert.equal(result.agent.trust, "askEveryTime");
  assert.ok(Object.values(result.agent.abilities).every(value => value === false));
  assert.equal(result.receipt?.permissionScope, "readOnly");
  assert.equal(result.receipt?.trust, "askEveryTime");
});

test("unsupported effort is explicit provider-default fallback", () => {
  const result = agentForInvocation(agent(), { agentId: "a1", effort: "hard" }, { effortSupported: false });
  assert.equal(result.agent.effort, undefined);
  assert.equal(result.receipt?.effort, undefined);
  assert.equal(result.receipt?.fallback, "provider-default");
});
