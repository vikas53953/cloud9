import test from "node:test";
import assert from "node:assert/strict";
import {
  RESPONSE_STREAM_LIMITS, validateAgentResponseStream,
  type AgentResponseStreamEvent,
} from "./responsestream.js";

const event = (patch: Partial<AgentResponseStreamEvent> = {}): AgentResponseStreamEvent => ({
  kind: "response-delta", channelId: "ch", triggerMessageId: "m", agentId: "a",
  turnId: "r-1", seq: 1, at: 0, text: "hello", ...patch,
});

test("response stream protocol accepts only text deltas and bounded terminals", () => {
  assert.equal(validateAgentResponseStream(event()), null);
  assert.match(validateAgentResponseStream(event({ text: "x".repeat(RESPONSE_STREAM_LIMITS.deltaChars + 1) }))!, /too large/);
  assert.match(validateAgentResponseStream(event({ kind: "response-start", seq: 1, text: undefined }))!, /sequence zero/);
  assert.match(validateAgentResponseStream(event({ kind: "response-final", text: "no" }))!, /only response deltas/);
  assert.match(validateAgentResponseStream(event({ kind: "response-delta", seq: -1 }))!, /ordered sequence/);
});

test("private reasoning-shaped fields are not accepted as response text", () => {
  assert.match(validateAgentResponseStream(event({ text: undefined }))!, /needs text/);
  assert.equal(validateAgentResponseStream(event({ kind: "response-start", seq: 0, text: undefined })), null);
});

test("only terminal response frames may carry a reason", () => {
  assert.match(validateAgentResponseStream(event({ reason: "not yet" }))!, /only allowed when it ends/);
  assert.equal(validateAgentResponseStream(event({ kind: "response-final", text: undefined, reason: "saved" })), null);
});
