import test from "node:test";
import assert from "node:assert/strict";
import {
  APPROVAL_CHECKPOINT_LIMITS, tidyApprovalText,
  validateApprovalInstructions, validateApprovalQuestion, validateApprovalCheckpointRequestId,
} from "./index.js";

test("approval checkpoint text is plain, bounded, and rejects empty input", () => {
  assert.equal(validateApprovalInstructions("\u0000\n  do the work  "), null);
  assert.equal(validateApprovalQuestion("\u0001\n  why?  "), null);
  assert.equal(validateApprovalInstructions(" \n\t"), "instructions cannot be empty");
  assert.equal(validateApprovalQuestion("\n"), "question cannot be empty");
  assert.equal(tidyApprovalText("x".repeat(APPROVAL_CHECKPOINT_LIMITS.question + 20), APPROVAL_CHECKPOINT_LIMITS.question).length, APPROVAL_CHECKPOINT_LIMITS.question);
  assert.equal(tidyApprovalText("line 1\r\nline 2\rline 3", 100), "line 1\nline 2\nline 3");
});

test("checkpoint request ids are safe, non-empty, and bounded", () => {
  assert.equal(validateApprovalCheckpointRequestId("checkpoint-1"), null);
  assert.match(validateApprovalCheckpointRequestId("" )!, /not valid/);
  assert.match(validateApprovalCheckpointRequestId("a".repeat(APPROVAL_CHECKPOINT_LIMITS.requestId + 1))!, /not valid/);
  assert.match(validateApprovalCheckpointRequestId("bad\nrequest")!, /not valid/);
  assert.match(validateApprovalCheckpointRequestId("../request")!, /not valid/);
});
