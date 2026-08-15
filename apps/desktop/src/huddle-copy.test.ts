import test from "node:test";
import assert from "node:assert/strict";
import { huddleLinkWords, huddleNoteKindWords, huddleStateWords } from "./huddle-copy.ts";

test("huddle copy never shows raw state or kind words", () => {
  assert.equal(huddleStateWords("active"), "In session");
  assert.equal(huddleStateWords("ended"), "Ended");
  assert.equal(huddleNoteKindWords("note"), "Note");
  assert.equal(huddleNoteKindWords("decision"), "Decision");
  assert.equal(huddleNoteKindWords("action"), "Action item");
  assert.equal(huddleLinkWords({ kind: "task", id: "t1" }), "Task");
  assert.equal(huddleLinkWords({ kind: "run", id: "r1" }), "Run");
  assert.equal(huddleLinkWords({ kind: "artifact", artifactId: "a1" }), "File");
  assert.equal(huddleLinkWords({ kind: "task", id: "t1", available: false }), "Task (unavailable)");
  assert.equal(huddleLinkWords({
    kind: "projectItem",
    projectItemKind: "pull",
    projectItemNumber: 12,
    available: false,
  }), "PR #12 (unavailable)");
});
