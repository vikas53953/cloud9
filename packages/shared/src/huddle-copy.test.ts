import test from "node:test";
import assert from "node:assert/strict";
import { huddleLinkWords, huddleNoteKindWords, huddleStateWords } from "./huddle-copy.js";

test("huddle copy never shows raw state or kind words", () => {
  assert.equal(huddleStateWords("active"), "In session");
  assert.equal(huddleStateWords("ended"), "Ended");
  assert.equal(huddleNoteKindWords("note"), "Note");
  assert.equal(huddleNoteKindWords("decision"), "Decision");
  assert.equal(huddleNoteKindWords("action"), "Action item");
  assert.equal(huddleLinkWords({ kind: "task" }), "Task");
  assert.equal(huddleLinkWords({ kind: "run" }), "Run");
  assert.equal(huddleLinkWords({ kind: "artifact" }), "File");
  assert.equal(huddleLinkWords({ kind: "task", available: false }), "Task (unavailable)");
  assert.equal(huddleLinkWords({ kind: "projectItem", projectItemKind: "pull", projectItemNumber: 12, available: false }), "PR #12 (unavailable)");
});
