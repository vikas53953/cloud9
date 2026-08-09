import assert from "node:assert/strict";
import test from "node:test";
import type { AgentDef } from "@cloud9/shared";
import { DEMO_REPLY_PREFIX } from "@cloud9/shared";
import { MockProvider } from "./provider.js";

const agent: AgentDef = {
  id: "a1", ownerId: "u1", name: "Scout", emoji: "S",
  persona: "Compare travel options carefully.",
  abilities: { webSearch: false, files: false, schedules: false, background: true },
  createdAt: 0,
};

const ask = (trigger: string, abortController?: AbortController) => ({
  agent, context: "", trigger, triggerAuthor: "Vikas", kind: "task" as const,
  ...(abortController ? { abortController } : {}),
});

test("ordinary demo answers remain immediate and visibly labelled", async () => {
  const provider = new MockProvider();
  const answer = await provider.respond(ask("compare these villas"));
  assert.ok(answer.startsWith(DEMO_REPLY_PREFIX));
});

test("an explicit take-your-time demo turn stays stoppable through the provider boundary", async () => {
  const provider = new MockProvider();
  const abortController = new AbortController();
  const pending = provider.respond(ask("take your time comparing every villa", abortController));
  const early = await Promise.race([
    pending.then(() => "answered", () => "stopped"),
    new Promise<string>(resolve => setTimeout(() => resolve("waiting"), 25)),
  ]);
  assert.equal(early, "waiting", "the deliberate QA turn must still be alive when Stop appears");
  abortController.abort();
  await assert.rejects(pending, /owner stopped this demo turn/i);
});
