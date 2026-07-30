// End-to-end over real sockets: relay + engine (mock provider) + two "human"
// clients. Covers: invite flow, agent creation, channel with shared members,
// @mention reply, free chatter, background task, proactive push flagging.
import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import WebSocket from "ws";
import { ClientFrame, ServerFrame } from "@cloud9/shared";
import { Engine, MockProvider } from "@cloud9/engine";
import { Relay } from "./server.js";

function tmp(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c9-"));
  return path.join(dir, name);
}

class TestClient {
  ws: WebSocket;
  frames: ServerFrame[] = [];
  private waiters: { pred: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }[] = [];

  constructor(url: string, token: string, client: "desktop" | "mobile" | "engine" = "desktop") {
    this.ws = new WebSocket(url);
    this.ws.on("open", () => this.send({ type: "hello", token, client }));
    this.ws.on("message", raw => {
      const frame = JSON.parse(String(raw)) as ServerFrame;
      this.frames.push(frame);
      this.waiters = this.waiters.filter(w => {
        if (w.pred(frame)) { w.resolve(frame); return false; }
        return true;
      });
    });
  }
  send(frame: ClientFrame): void {
    const doSend = () => this.ws.send(JSON.stringify(frame));
    if (this.ws.readyState === WebSocket.OPEN) doSend();
    else this.ws.once("open", doSend);
  }
  wait<T extends ServerFrame>(pred: (f: ServerFrame) => boolean, ms = 5000): Promise<T> {
    const hit = this.frames.find(pred);
    if (hit) return Promise.resolve(hit as T);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for frame")), ms);
      this.waiters.push({ pred, resolve: f => { clearTimeout(timer); resolve(f as T); } });
    });
  }
  close(): void { this.ws.close(); }
}

test("cloud9 end-to-end: agents chat with humans across the relay", async () => {
  const relay = new Relay({ dbPath: tmp("relay.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;

  // owner desktop client
  const owner = new TestClient(url, "tok-owner");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  assert.equal(welcome.state.me.name, "Vikas");
  const general = welcome.state.channels.find(c => c.name === "general")!;

  // owner creates an agent
  owner.send({
    type: "createAgent",
    agent: {
      name: "Scout", emoji: "🔭",
      persona: "You research travel, villas, flights and hotels",
      abilities: { webSearch: true, files: false, schedules: true, background: true },
      // This test is about a FRIEND driving the agent, which is only allowed
      // when the owner has opened it up. The default is owner-only — proved
      // separately by "an agent left at the default ignores a friend" below.
      respondTo: "anyone",
    },
  });
  const agentFrame = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent");
  const scout = agentFrame.agent;

  // engine host comes online for the owner (mock provider)
  const engine = new Engine({ relayUrl: url, token: "tok-owner", dataDir: tmp("engine"), provider: new MockProvider() });
  engine.connect();
  await new Promise<void>(resolve => { engine.onReady = resolve; });

  // put the agent in #general and invite a friend
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [scout.id] });
  await owner.wait(f => f.type === "channel" && f.channel.memberIds.includes(scout.id));
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");

  const friend = new TestClient(url, `invite:${invite.code}:Priya`);
  const friendToken = await friend.wait<Extract<ServerFrame, { type: "token" }>>(f => f.type === "token");
  assert.ok(friendToken.token.startsWith("tok"));
  await friend.wait(f => f.type === "welcome");

  // friend @mentions the agent → engine replies via relay
  friend.send({ type: "send", channelId: general.id, text: "@Scout find beach villas in Goa" });
  const reply = await friend.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.authorKind === "agent",
  );
  assert.equal(reply.message.authorName, "Scout");
  assert.match(reply.message.text, /villas/i);

  // free chatter: unmentioned but relevant human message draws the agent in
  owner.send({ type: "send", channelId: general.id, text: "should we book flights and hotels now?" });
  const chime = await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.authorKind === "agent" && /flights/i.test(f.message.text),
  );
  assert.equal(chime.message.authorName, "Scout");

  // background task → immediate ack + proactive completion message
  owner.send({ type: "send", channelId: general.id, text: "@Scout !bg compare 14 villas and shortlist 3" });
  await owner.wait(f => f.type === "message" && f.message.authorKind === "agent" && /background/i.test(f.message.text));
  const done = await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && !!f.message.proactive,
  );
  assert.match(done.message.text, /Task done/);

  // …and the half that actually protects the owner's subscription: a SECOND
  // agent, left at the default, must ignore the same friend entirely. Scout
  // above only answers her because the owner opened it up.
  owner.send({
    type: "createAgent",
    agent: {
      name: "Ledger", emoji: "📊",
      persona: "You research travel, villas, flights and hotels",
      abilities: { webSearch: true, files: false, schedules: true, background: true },
      // no respondTo — the default is owner-only
    },
  });
  const ledgerFrame = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === "Ledger",
  );
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [ledgerFrame.agent.id] });
  await owner.wait(f => f.type === "channel" && f.channel.memberIds.includes(ledgerFrame.agent.id));

  friend.send({ type: "send", channelId: general.id, text: "@Ledger find beach villas in Goa" });
  // The refusal is deliberately SILENT, so the proof is an absence: give the
  // engine the same room it needed to answer Scout, then assert Ledger never
  // spoke.
  const spoke = await Promise.race([
    friend.wait<Extract<ServerFrame, { type: "message" }>>(
      f => f.type === "message" && f.message.authorName === "Ledger",
    ).then(() => true),
    new Promise<false>(r => setTimeout(() => r(false), 2500)),
  ]);
  assert.equal(spoke, false, "an agent left at the default answered a friend — it must not");

  engine.stop();
  owner.close();
  friend.close();
  relay.close();
});

test("schedule commands via chat", async () => {
  const relay = new Relay({ dbPath: tmp("relay2.db"), ownerToken: "tok-o2", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-o2");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const general = welcome.state.channels.find(c => c.name === "general")!;
  owner.send({ type: "createAgent", agent: {
    name: "Coach", emoji: "🏋️", persona: "You are a fitness coach",
    abilities: { webSearch: false, files: false, schedules: true, background: false },
  }});
  const agent = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
  const engine = new Engine({ relayUrl: url, token: "tok-o2", dataDir: tmp("engine2"), provider: new MockProvider() });
  engine.connect();
  await new Promise<void>(resolve => { engine.onReady = resolve; });
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [agent.id] });
  await owner.wait(f => f.type === "channel" && f.channel.memberIds.includes(agent.id));

  owner.send({ type: "send", channelId: general.id, text: "@Coach !schedule daily 06:30 post my workout" });
  const ack = await owner.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.authorKind === "agent" && /Scheduled!/.test(f.message.text));
  assert.match(ack.message.text, /daily 06:30/);
  assert.equal(engine.schedules.length, 1);

  owner.send({ type: "send", channelId: general.id, text: "@Coach !schedules" });
  await owner.wait(f => f.type === "message" && f.message.authorKind === "agent" && /My schedules/.test(f.message.text));

  const id = engine.schedules[0].id;
  owner.send({ type: "send", channelId: general.id, text: `@Coach !unschedule ${id}` });
  await owner.wait(f => f.type === "message" && f.message.authorKind === "agent" && /Cancelled/.test(f.message.text));
  assert.equal(engine.schedules.length, 0);

  engine.stop();
  owner.close();
  relay.close();
});

test("v2: task lifecycle with approvals and audit trail", async () => {
  const relay = new Relay({ dbPath: tmp("relay3.db"), ownerToken: "tok-o3", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-o3");
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const general = welcome.state.channels.find(c => c.name === "general")!;

  owner.send({ type: "createAgent", agent: {
    name: "Guard", emoji: "🛡️", persona: "You handle sensitive research work",
    abilities: { webSearch: true, files: false, schedules: true, background: true },
    approvals: { background: true, schedules: false },
  }});
  const agent = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;
  const engine = new Engine({ relayUrl: url, token: "tok-o3", dataDir: tmp("engine3"), provider: new MockProvider() });
  engine.connect();
  await new Promise<void>(resolve => { engine.onReady = resolve; });
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [agent.id] });
  await owner.wait(f => f.type === "channel" && f.channel.memberIds.includes(agent.id));

  // --- rejected path: FR-AP-003/004 ---
  owner.send({ type: "send", channelId: general.id, text: "@Guard !bg dig into the risky thing" });
  const pend1 = await owner.wait<Extract<ServerFrame, { type: "approval" }>>(
    f => f.type === "approval" && f.approval.status === "pending");
  const t1 = await owner.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.status === "waiting_approval");
  assert.equal(t1.task.approvalId, pend1.approval.id);
  await owner.wait(f => f.type === "message" && /approval/i.test(f.message.text)); // agent said it's waiting

  owner.send({ type: "decideApproval", approvalId: pend1.approval.id, decision: "rejected" });
  const t1done = await owner.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.id === t1.task.id && f.task.status === "cancelled");
  assert.equal(t1done.task.error, "rejected by owner");

  // rejected work must never produce a completed task or a result message
  await new Promise(r => setTimeout(r, 400));
  assert.equal(engine.tasks.get(t1.task.id)?.status, "cancelled");

  // --- approved path ---
  owner.send({ type: "send", channelId: general.id, text: "@Guard !bg summarise the safe thing" });
  const pend2 = await owner.wait<Extract<ServerFrame, { type: "approval" }>>(
    f => f.type === "approval" && f.approval.status === "pending" && f.approval.id !== pend1.approval.id);
  owner.send({ type: "decideApproval", approvalId: pend2.approval.id, decision: "approved" });
  const done = await owner.wait<Extract<ServerFrame, { type: "task" }>>(
    f => f.type === "task" && f.task.approvalId === pend2.approval.id && f.task.status === "completed", 8000);
  assert.ok(done.task.result && done.task.result.length > 0);
  await owner.wait(f => f.type === "message" && !!f.message.proactive && /Task done/.test(f.message.text));

  // --- only the owner may decide (provisional D4 policy) ---
  owner.send({ type: "createInvite" });
  const invite = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = new TestClient(url, `invite:${invite.code}:Priya`);
  await friend.wait(f => f.type === "welcome");
  owner.send({ type: "send", channelId: general.id, text: "@Guard !bg third thing" });
  const pend3 = await friend.wait<Extract<ServerFrame, { type: "approval" }>>(
    f => f.type === "approval" && f.approval.status === "pending" &&
         f.approval.id !== pend1.approval.id && f.approval.id !== pend2.approval.id);
  friend.send({ type: "decideApproval", approvalId: pend3.approval.id, decision: "approved" });
  const err = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /owner/);

  // --- cancel a pending task directly (FR-TS-005) ---
  // `taskId` is optional on an Approval now that an agent can ask mid-run about
  // one specific action with no job behind it. A JOB-shaped approval always has
  // one, and this asserts that rather than assuming it.
  const pend3Task = pend3.approval.taskId;
  assert.ok(pend3Task, "a job-shaped approval always names its job");
  owner.send({ type: "cancelTask", taskId: pend3Task });
  await owner.wait(f => f.type === "task" && f.task.id === pend3Task && f.task.status === "cancelled");

  // --- audit trail (FR-AU-001..004) ---
  owner.send({ type: "activity", limit: 100 });
  const act = await owner.wait<Extract<ServerFrame, { type: "activity" }>>(f => f.type === "activity");
  const kinds = act.records.map(r => r.kind);
  for (const k of ["agent_created", "task_created", "approval_requested", "approval_decided", "task_status", "message"]) {
    assert.ok(kinds.includes(k as never), `missing activity kind ${k}`);
  }
  const decided = act.records.find(r => r.kind === "approval_decided")!;
  assert.equal(decided.actorName, "Vikas"); // attribution (FR-AU-002)

  engine.stop();
  owner.close();
  friend.close();
  relay.close();
});

// --- harness sign-in frames (docs/plans/harness-signin.md decision 5) ---
test("harness status is asked for by clients, answered by the engine, broadcast to the owner", async () => {
  const relay = new Relay({ dbPath: tmp("relay-harness.db"), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;

  const desktop = new TestClient(url, "tok-owner");
  await desktop.wait(f => f.type === "welcome");
  // stand-in for the engine host: it owns the CLIs and answers harness requests
  const host = new TestClient(url, "tok-owner", "engine");
  await host.wait(f => f.type === "welcome");

  const state = {
    claude: {
      name: "claude" as const, installed: true, signedIn: true, authKind: "cli-login" as const,
      account: "vikas@example.com", version: "2.1.220",
      models: ["claude-sonnet-5"], defaultModel: "claude-sonnet-5",
      detail: "Signed in as vikas@example.com",
    },
    codex: {
      name: "codex" as const, installed: true, signedIn: false, authKind: "none" as const,
      models: [], detail: "installed, but not signed in yet",
    },
    updatedAt: Date.now(),
  };

  // 1. the desktop asks; the request lands on the engine, not on other clients
  desktop.send({ type: "harnessStatus" });
  const asked = await host.wait<Extract<ServerFrame, { type: "harnessRequest" }>>(
    f => f.type === "harnessRequest" && f.action === "status");
  assert.equal(asked.harness, undefined);
  assert.ok(!desktop.frames.some(f => f.type === "harnessRequest"), "requests go to the engine only");

  // 2. the engine reports status; the desktop sees it
  host.send({ type: "harnessState", state });
  const broadcast = await desktop.wait<Extract<ServerFrame, { type: "harness" }>>(f => f.type === "harness");
  assert.equal(broadcast.state.claude.signedIn, true);
  assert.equal(broadcast.state.claude.account, "vikas@example.com");
  assert.equal(broadcast.state.codex.signedIn, false);
  // status only — nothing token-shaped may cross the wire
  assert.ok(!JSON.stringify(broadcast).includes("sk-"));

  // 3. "Sign in with Codex" reaches the engine, naming the harness
  desktop.send({ type: "harnessSignIn", harness: "codex" });
  const signIn = await host.wait<Extract<ServerFrame, { type: "harnessRequest" }>>(
    f => f.type === "harnessRequest" && f.action === "signIn");
  assert.equal(signIn.harness, "codex");

  // 4. a later asker gets the cached status straight away
  const second = new TestClient(url, "tok-owner");
  await second.wait(f => f.type === "welcome");
  second.send({ type: "harnessStatus" });
  const cached = await second.wait<Extract<ServerFrame, { type: "harness" }>>(f => f.type === "harness");
  assert.equal(cached.state.claude.version, "2.1.220");

  // 5. a plain client may not fake harness status
  desktop.send({ type: "harnessState", state });
  const err = await desktop.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /only the engine/);

  desktop.close();
  second.close();
  host.close();
  relay.close();
});

// --- harness control is privileged: it starts programs on the owner's computer ---
test("only the owner, on a non-default token, can drive the harnesses", async () => {
  const relay = new Relay({ dbPath: tmp("relay-harness2.db"), ownerToken: "tok-secret", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;

  const owner = new TestClient(url, "tok-secret");
  await owner.wait(f => f.type === "welcome");
  const host = new TestClient(url, "tok-secret", "engine");
  await host.wait(f => f.type === "welcome");

  // an invited friend joins
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const friend = new TestClient(url, `invite:${inv.code}:Priya`);
  await friend.wait(f => f.type === "welcome");

  // the friend may not start a sign-in on the owner's machine
  friend.send({ type: "harnessSignIn", harness: "codex" });
  const denied = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /only the owner/);
  assert.ok(!host.frames.some(f => f.type === "harnessRequest"), "nothing reached the engine host");

  // ...nor read the owner's harness status
  friend.send({ type: "harnessStatus" });
  await friend.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && /only the owner/.test(f.error), 3000);
  assert.ok(!friend.frames.some(f => f.type === "harness"), "no status leaked to the friend");

  // the owner can, and it is rate-limited to one at a time
  owner.send({ type: "harnessSignIn", harness: "codex" });
  await host.wait(f => f.type === "harnessRequest" && f.action === "signIn");
  owner.send({ type: "harnessSignIn", harness: "codex" });
  const busy = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(busy.error, /already running|give the last sign-in/);

  owner.close(); friend.close(); host.close(); relay.close();
});

test("the shipped default owner token cannot drive the harnesses", async () => {
  const relay = new Relay({ dbPath: tmp("relay-harness3.db"), ownerToken: "dev-owner-token", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const owner = new TestClient(`ws://127.0.0.1:${port}`, "dev-owner-token");
  await owner.wait(f => f.type === "welcome");

  owner.send({ type: "harnessSignIn", harness: "claude" });
  const err = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /own owner token/);

  owner.close(); relay.close();
});

test("dev mode allows the default token, and harness status is dropped when the engine leaves", async () => {
  const relay = new Relay({
    dbPath: tmp("relay-harness4.db"), ownerToken: "dev-owner-token", ownerName: "Vikas", devMode: true,
  });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "dev-owner-token");
  await owner.wait(f => f.type === "welcome");
  const host = new TestClient(url, "dev-owner-token", "engine");
  await host.wait(f => f.type === "welcome");

  host.send({
    type: "harnessState",
    state: {
      claude: {
        name: "claude", installed: true, signedIn: true, authKind: "cli-login",
        account: "vikas@example.com", models: ["claude-sonnet-5"], detail: "Signed in",
      },
      codex: {
        name: "codex", installed: true, signedIn: true, authKind: "cli-login",
        models: ["gpt-5.6-sol"], detail: "Signed in",
      },
      updatedAt: Date.now(),
    },
  });
  const live = await owner.wait<Extract<ServerFrame, { type: "harness" }>>(f => f.type === "harness");
  assert.equal(live.state.claude.signedIn, true);

  // the engine host goes away — its status is now a claim about nothing
  host.close();
  const stale = await owner.wait<Extract<ServerFrame, { type: "harness" }>>(
    f => f.type === "harness" && !f.state.claude.signedIn, 5000);
  assert.match(stale.state.claude.detail ?? "", /isn't running/);

  owner.close(); relay.close();
});
