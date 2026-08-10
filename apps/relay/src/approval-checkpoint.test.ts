import test from "node:test";
import assert from "node:assert/strict";
import { Approval, ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const AGENT = {
  emoji: "🛡️", persona: "Handles bounded work",
  abilities: { webSearch: false, files: true, schedules: false, background: true, commands: true },
};

test("approval edits/questions are durable, epoch-bound, and never execute", async () => {
  const relay = new Relay({ dbPath: tmp("approval-checkpoint.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const owner = new TestClient(`ws://127.0.0.1:${port}`, "tok-owner");
  const hello = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const channel = hello.state.channels[0]!;
  owner.send({ type: "createAgent", agent: { ...AGENT, name: "Checkpoint" } });
  const agent = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Checkpoint")).agent;
  owner.send({ type: "addMembers", channelId: channel.id, memberIds: [agent.id] });
  await owner.wait(f => f.type === "channel" && f.channel.id === channel.id && f.channel.memberIds.includes(agent.id));
  owner.send({ type: "createTask", agentId: agent.id, channelId: channel.id, title: "original instructions", requesterId: hello.state.me.id });
  const pending = await owner.wait<Extract<ServerFrame, { type: "approval" }>>(f => f.type === "approval" && f.approval.status === "pending");
  const original = pending.approval;
  assert.equal(original.revision, 0);
  assert.ok(original.approvalEpoch);
  assert.equal(relay.store.task(original.taskId!)!.status, "waiting_approval");

  for (const requestId of ["", "x".repeat(65), "bad\nrequest"]) {
    owner.frames.length = 0;
    owner.send({ type: "editApproval", approvalId: original.id, instructions: "invalid id", requestId });
    const invalid = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
      f => f.type === "error" && /checkpoint request id/i.test(f.error));
    assert.match(invalid.error, /request id is not valid/);
    assert.equal(relay.store.approval(original.id)!.revision, 0);
  }

  owner.send({ type: "editApproval", approvalId: original.id, instructions: "missing freshness" , requestId: "checkpoint-missing-edit" });
  const missingEdit = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "checkpoint-missing-edit" && /approval changed/i.test(f.error));
  assert.match(missingEdit.error, /refresh/);
  assert.equal(relay.store.approval(original.id)!.revision, 0);

  owner.send({ type: "editApproval", approvalId: original.id, instructions: "revised instructions", expectedRevision: 0, approvalEpoch: original.approvalEpoch, requestId: "checkpoint-edit-1" });
  const edited = await owner.wait<Extract<ServerFrame, { type: "approval" }>>(f => f.type === "approval" && f.approval.id === original.id && (f.approval.revision ?? 0) === 1);
  assert.equal(edited.approval.status, "pending");
  assert.equal(edited.approval.instructions, "revised instructions");
  assert.equal(relay.store.task(original.taskId!)!.title, "revised instructions");

  owner.send({ type: "askApprovalQuestion", approvalId: original.id, question: "missing freshness", requestId: "checkpoint-missing-question" });
  const missingQuestion = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "checkpoint-missing-question" && /approval changed/i.test(f.error));
  assert.match(missingQuestion.error, /refresh/);
  assert.equal(relay.store.approval(original.id)!.revision, 1);

  owner.send({ type: "decideApproval", approvalId: original.id, decision: "approved", expectedRevision: 0, approvalEpoch: original.approvalEpoch, requestId: "checkpoint-stale" });
  const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "checkpoint-stale" && /approval changed/i.test(f.error));
  assert.match(refused.error, /refresh/i);
  assert.equal(relay.store.approval(original.id)!.status, "pending");

  owner.send({ type: "askApprovalQuestion", approvalId: original.id, question: "Which files should I touch?", expectedRevision: 1, approvalEpoch: edited.approval.approvalEpoch, requestId: "checkpoint-question-1" });
  const clarified = await owner.wait<Extract<ServerFrame, { type: "approval" }>>(f => f.type === "approval" && f.approval.id === original.id && (f.approval.revision ?? 0) === 2);
  assert.equal(clarified.approval.status, "pending");
  assert.equal(clarified.approval.clarifications?.at(-1)?.text, "Which files should I touch?");

  // A receipt is checked before freshness. Replaying the exact edit after a
  // later question returns the current canonical card and does not create a
  // third revision; a different payload under the same id is refused.
  owner.send({ type: "editApproval", approvalId: original.id, instructions: "revised instructions", expectedRevision: 0, approvalEpoch: original.approvalEpoch, requestId: "checkpoint-edit-1" });
  const replayedEdit = await owner.wait<Extract<ServerFrame, { type: "approval" }>>(f => f.type === "approval" && f.approval.id === original.id && (f.approval.revision ?? 0) === 2);
  assert.equal(replayedEdit.approval.instructions, "revised instructions");
  owner.send({ type: "editApproval", approvalId: original.id, instructions: "different words", expectedRevision: 0, approvalEpoch: original.approvalEpoch, requestId: "checkpoint-edit-1" });
  const conflict = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && /different work/i.test(f.error));
  assert.match(conflict.error, /different work/);

  owner.send({ type: "askApprovalQuestion", approvalId: original.id, question: "Who owns this replay?", expectedRevision: 2, approvalEpoch: clarified.approval.approvalEpoch, requestId: "checkpoint-actor" });
  const actorQuestion = await owner.wait<Extract<ServerFrame, { type: "approval" }>>(f => f.type === "approval" && f.approval.id === original.id && (f.approval.revision ?? 0) === 3);
  const actorApproval = relay.store.approval(original.id)!;
  const actorReceipt = actorApproval.checkpointReceipts!.find(receipt => receipt.requestId === "checkpoint-actor")!;
  actorReceipt.actorId = "another-person";
  relay.store.saveApproval(actorApproval);
  owner.send({ type: "askApprovalQuestion", approvalId: original.id, question: "Who owns this replay?", expectedRevision: 2, approvalEpoch: clarified.approval.approvalEpoch, requestId: "checkpoint-actor" });
  const actorRefused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && /belongs to another person/i.test(f.error));
  assert.match(actorRefused.error, /another person/);

  // Missing freshness tokens are refused even on revision zero.
  owner.send({ type: "decideApproval", approvalId: original.id, decision: "approved", requestId: "checkpoint-missing-freshness" });
  const missing = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && f.requestId === "checkpoint-missing-freshness" && /approval changed/i.test(f.error));
  assert.match(missing.error, /refresh/);
  assert.equal(relay.store.approval(original.id)!.status, "pending");

  owner.send({ type: "decideApproval", approvalId: original.id, decision: "approved", expectedRevision: 3, approvalEpoch: actorQuestion.approval.approvalEpoch, requestId: "checkpoint-approve-1" });
  const approved = await owner.wait<Extract<ServerFrame, { type: "approval" }>>(f => f.type === "approval" && f.approval.id === original.id && f.approval.status === "approved");
  assert.equal(approved.approval.status, "approved");
  assert.equal(relay.store.task(original.taskId!)!.status, "not_started");
  assert.equal(relay.store.approval(original.id)!.lastCheckpoint?.requestId, "checkpoint-approve-1");

  // Same request id is a replay, not a second execution or a state flip.
  owner.send({ type: "decideApproval", approvalId: original.id, decision: "approved", expectedRevision: 3, approvalEpoch: actorQuestion.approval.approvalEpoch, requestId: "checkpoint-approve-1" });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(relay.store.approval(original.id)!.status, "approved");
  owner.close();
  await relay.close();
});

test("instruction edits fail closed for plan, action, and saving cards", async () => {
  const relay = new Relay({ dbPath: tmp("approval-checkpoint-kinds.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const owner = new TestClient(`ws://127.0.0.1:${port}`, "tok-owner");
  const hello = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const channel = hello.state.channels[0]!;
  owner.send({ type: "createAgent", agent: { ...AGENT, name: "Kind checks" } });
  const agent = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Kind checks")).agent;
  for (const kind of ["plan", "action", "saving"] as const) {
    const approval: Approval = {
      id: `ap-${kind}-edit`, agentId: agent.id, ownerId: hello.state.me.id,
      action: `${kind} action`, status: "pending", createdAt: Date.now(),
      kind, channelId: channel.id, requesterId: hello.state.me.id,
      revision: 0, approvalEpoch: `epoch-${kind}`, instructions: `${kind} action`,
    };
    relay.store.saveApproval(approval);
    owner.send({ type: "editApproval", approvalId: approval.id, instructions: "unsafe rewrite", expectedRevision: 0, approvalEpoch: approval.approvalEpoch, requestId: `kind-${kind}` });
    const refused = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error" && /cannot safely revise/i.test(f.error));
    assert.match(refused.error, /cannot safely revise/);
    assert.equal(relay.store.approval(approval.id)!.revision, 0);
  }
  owner.close();
  await relay.close();
});

test("approval projections keep private instructions inside the room audience", async () => {
  const relay = new Relay({ dbPath: tmp("approval-checkpoint-audience.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const hello = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const general = hello.state.channels[0]!;
  owner.send({ type: "createAgent", agent: { ...AGENT, name: "Private checkpoint" } });
  const agent = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent" && f.agent.name === "Private checkpoint")).agent;
  owner.send({ type: "createChannel", name: "private checkpoint room", memberIds: [agent.id], kind: "channel" });
  const room = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(f => f.type === "channel" && f.channel.name === "private checkpoint room")).channel;
  owner.send({ type: "createTask", agentId: agent.id, channelId: room.id, title: "private instructions", requesterId: hello.state.me.id });
  const card = await owner.wait<Extract<ServerFrame, { type: "approval" }>>(f => f.type === "approval" && f.approval.channelId === room.id && f.approval.status === "pending");

  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const outsider = new TestClient(url, `invite:${invite.code}:Priya`);
  await outsider.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(outsider.frames.some(f => f.type === "approval" && f.approval.id === card.approval.id), false,
    "welcome must not include a private room approval");

  owner.send({ type: "editApproval", approvalId: card.approval.id, instructions: "private revised instructions", expectedRevision: 0, approvalEpoch: card.approval.approvalEpoch, requestId: "private-edit" });
  await owner.wait(f => f.type === "approval" && f.approval.id === card.approval.id && (f.approval.revision ?? 0) === 1);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(outsider.frames.some(f => f.type === "approval" && f.approval.id === card.approval.id), false,
    "live pushes must not leak private instructions to outsiders");
  owner.close();
  outsider.close();
  await relay.close();
});
