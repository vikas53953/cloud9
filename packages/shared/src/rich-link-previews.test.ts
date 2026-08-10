import test from "node:test";
import assert from "node:assert/strict";
import {
  findRichLinkRefs, richLinkKey, richLinkToken,
} from "./index.js";

test("findRichLinkRefs recognizes bounded internal refs and deduplicates them", () => {
  const refs = findRichLinkRefs(
    "cloud9://task/tsk-1 and cloud9://task/tsk-1 cloud9://run/run-1 "
      + "cloud9://artifact/af-1@2 cloud9://decision/topic-1 "
      + "cloud9://project/prj-1/pull/42",
  );
  assert.deepEqual(refs, [
    { kind: "task", id: "tsk-1" },
    { kind: "run", id: "run-1" },
    { kind: "artifact", id: "af-1", version: 2 },
    { kind: "decision", id: "topic-1" },
    { kind: "projectItem", projectId: "prj-1", itemKind: "pull", number: 42 },
  ]);
  assert.equal(richLinkToken(refs[0]), "cloud9://task/tsk-1");
  assert.equal(richLinkKey(refs[4]), "projectItem:prj-1:pull:42");
});

test("ordinary external links stay url refs and malformed/internal lookalikes are ignored", () => {
  const refs = findRichLinkRefs(
    "Read https://example.test/docs. cloud9://task/../secret "
      + "cloud9://project/prj-1/pull/0 cloud9://run/run-1.",
  );
  assert.deepEqual(refs, [
    { kind: "url", url: "https://example.test/docs" },
    { kind: "run", id: "run-1" },
  ]);
});

test("external URL refs are bounded", () => {
  const huge = `https://example.test/${"x".repeat(1100)}`;
  assert.deepEqual(findRichLinkRefs(huge), []);
});
