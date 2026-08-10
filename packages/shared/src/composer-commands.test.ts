import test from "node:test";
import assert from "node:assert/strict";
import { parseComposerCommand } from "./composer-commands.js";

test("composer commands parse with an optional leading routing mention", () => {
  assert.deepEqual(parseComposerCommand("@Scout /summarize decisions"), {
    name: "summarize", argument: "decisions",
  });
  assert.deepEqual(parseComposerCommand(" /review src/app.ts "), {
    name: "review", argument: "src/app.ts",
  });
  assert.deepEqual(parseComposerCommand("/plan fix the flaky test"), {
    name: "plan", argument: "fix the flaky test",
  });
});

test("assign keeps the actual room target separate from the work", () => {
  assert.deepEqual(parseComposerCommand("/assign @Builder fix the failing test"), {
    name: "assign", target: "Builder", argument: "fix the failing test",
  });
  assert.deepEqual(parseComposerCommand("@Lead /assign @Builder fix it"), {
    name: "assign", target: "Builder", argument: "fix it",
  });
});

test("room candidates make spaced and emoji names unambiguous", () => {
  const agentNames = ["Data", "Data Scout", "🧭 Reviewer"];
  assert.deepEqual(parseComposerCommand("/assign @Data Scout inspect telemetry", { agentNames }), {
    name: "assign", target: "Data Scout", argument: "inspect telemetry",
  });
  assert.deepEqual(parseComposerCommand("@🧭 Reviewer /review release notes", { agentNames }), {
    name: "review", argument: "release notes", routeTarget: "🧭 Reviewer",
  });
  assert.deepEqual(parseComposerCommand("/assign @Data Scout inspect", {
    agentNames: ["Data Scout", "data scout"],
  }), { name: "assign", target: "Data Scout", argument: "inspect" },
  "ambiguous names stay explicit so the engine can refuse visibly");
  assert.deepEqual(parseComposerCommand("/assign @agent_data inspect", {
    agentIds: ["agent_data"],
  }), { name: "assign", target: "agent_data", argument: "inspect" });
  assert.deepEqual(parseComposerCommand("/assign @Data inspect", {
    agentNames: ["Data Scout"],
  }), { name: "assign", target: "Data", argument: "inspect" },
  "a command-shaped prefix remains explicit for engine-side refusal");
  assert.deepEqual(parseComposerCommand("@agent_data /review release notes", {
    agentNames, agentIds: ["agent_data"],
  }), { name: "review", argument: "release notes", routeTarget: "agent_data" });
});

test("incomplete or unknown commands are not actions", () => {
  for (const value of ["/plan", "/review", "/ship", "/assign @Builder", "/unknown thing", "hello /plan"]) {
    assert.equal(parseComposerCommand(value), undefined, value);
  }
  assert.deepEqual(parseComposerCommand("/summarize"), { name: "summarize" });
});
