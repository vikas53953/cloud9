// Parallel QA runs must not delete each other's workspaces.
// Run directly: node --test scripts/qa-stack.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  QA_WORKSPACE_MAX_AGE_MS,
  shouldDeleteQaWorkspace,
} from "./qa-stack.mjs";

const HOUR = 60 * 60 * 1000;

test("own workspace is always deleted", () => {
  assert.equal(shouldDeleteQaWorkspace({
    name: "cloud9-qa-abc123", isOwn: true, ageMs: 0,
  }), true);
  assert.equal(shouldDeleteQaWorkspace({
    name: "cloud9-qa-abc123", isOwn: true, ageMs: 10 * HOUR,
  }), true);
});

test("a younger sibling is kept — another run is using it", () => {
  assert.equal(shouldDeleteQaWorkspace({
    name: "cloud9-qa-other", isOwn: false, ageMs: 30 * 60 * 1000,
  }), false);
  assert.equal(shouldDeleteQaWorkspace({
    name: "cloud9-qa-other", isOwn: false, ageMs: QA_WORKSPACE_MAX_AGE_MS - 1,
  }), false);
});

test("an abandoned workspace older than 3 hours is deleted", () => {
  assert.equal(shouldDeleteQaWorkspace({
    name: "cloud9-qa-stale", isOwn: false, ageMs: QA_WORKSPACE_MAX_AGE_MS + 1,
  }), true);
  assert.equal(shouldDeleteQaWorkspace({
    name: "cloud9-qa-stale", isOwn: false, ageMs: 10 * HOUR,
  }), true);
});

test("non-QA temp folders are never touched", () => {
  assert.equal(shouldDeleteQaWorkspace({
    name: "something-else", isOwn: false, ageMs: 99 * HOUR,
  }), false);
});

test("the max-age constant is three hours", () => {
  assert.equal(QA_WORKSPACE_MAX_AGE_MS, 3 * HOUR);
});
