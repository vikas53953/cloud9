import test from "node:test";
import assert from "node:assert/strict";
import { validateTaskTitle } from "./index.js";

test("task titles are bounded before durable routing", () => {
  assert.match(validateTaskTitle("Research this") ?? "", /^$/);
  assert.match(validateTaskTitle("   ") ?? "", /needs some words/);
  assert.match(validateTaskTitle("x".repeat(4001)) ?? "", /too long/);
});
