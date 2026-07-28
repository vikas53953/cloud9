// Security review 2026-07-29 — the regression net.
//
// Every test in this file failed before its fix landed. The first one is the
// reviewer's proof-of-concept, turned into something that runs on every build:
// a guest walking in and coming out holding the owner's account.
import test from "node:test";
import assert from "node:assert/strict";
import { ServerFrame } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

const BASE_AGENT = {
  emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
};

/** Stand up a relay with the owner already signed in. */
async function stand(name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  await owner.wait(f => f.type === "welcome");
  return { relay, url, owner };
}

async function invite(owner: TestClient, notCode?: string): Promise<string> {
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(
    f => f.type === "invite" && f.code !== notCode);
  return inv.code;
}

// ---------------------------------------------------------------------------
// P0 #1 — a display name is not an identity
// ---------------------------------------------------------------------------

test("PoC: a guest cannot become the owner by typing the owner's name", async () => {
  const { relay, url, owner } = await stand("sec-poc.db");

  // 1. Priya is invited in the normal way.
  const code = await invite(owner);
  const priya = new TestClient(url, `invite:${code}:Priya`);
  const hers = await priya.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  assert.notEqual(hers.state.me.id, relay.ownerId);

  // 2. The attack's first move: mint the code you need. A guest may not.
  priya.send({ type: "createInvite" });
  const denied = await priya.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /only the owner/);
  assert.equal(relay.store.invites().filter(i => i.createdBy === hers.state.me.id).length, 0);

  // 3. And the move it enabled: redeem a code while claiming the owner's exact
  //    display name. That used to hand back the owner's account and a durable
  //    token for it. It must now be an ordinary new guest called "Vikas".
  const second = await invite(owner, code);
  const impostor = new TestClient(url, `invite:${second}:${relay.ownerName}`);
  const got = await impostor.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  assert.notEqual(got.state.me.id, relay.ownerId, "a typed name must never yield the owner's account");

  // 4. ...with none of the owner's powers.
  impostor.send({ type: "harnessSignIn", harness: "claude" });
  const noHarness = await impostor.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(noHarness.error, /only the owner/);
  impostor.send({ type: "removeUser", userId: relay.ownerId });
  const noRemove = await impostor.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && /only the owner/.test(f.error));
  assert.ok(noRemove);
  assert.equal(relay.store.user(relay.ownerId)?.name, "Vikas", "the owner is still here");

  // 5. and the token minted for the impostor belongs to the impostor, not to
  //    the owner — the durable credential follows the same rule
  const token = impostor.frames.find(f => f.type === "token") as Extract<ServerFrame, { type: "token" }>;
  assert.equal(relay.store.userByToken(token.token)?.id, got.state.me.id);

  priya.close(); impostor.close(); owner.close(); relay.close();
});

test("case and spacing games on a name buy nothing either", async () => {
  const { relay, url, owner } = await stand("sec-namegames.db");
  const code = await invite(owner);
  const sneak = new TestClient(url, `invite:${code}:  vIkAs `);
  const got = await sneak.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  assert.notEqual(got.state.me.id, relay.ownerId);
  sneak.close(); owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// P1 #2 — an invite is a single-use ticket made of real randomness
// ---------------------------------------------------------------------------

test("a spent invite code is dead — it never mints another sign-in", async () => {
  const { relay, url, owner } = await stand("sec-singleuse.db");
  const code = await invite(owner);

  const first = new TestClient(url, `invite:${code}:Priya`);
  const w1 = await first.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");

  // the same code again: refused, in plain words, with no token and no account
  const again = new TestClient(url, `invite:${code}:Priya`);
  const err = await again.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /already been used/);
  assert.ok(!again.frames.some(f => f.type === "token"), "no fresh token came out of a spent code");
  assert.ok(!again.frames.some(f => f.type === "welcome"), "and nobody got in");
  assert.equal(relay.store.users().filter(u => u.name === "Priya").length, 1);

  // her own durable token still works — that is how she comes back
  const back = new TestClient(url, tokenOf(first));
  const w2 = await back.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  assert.equal(w2.state.me.id, w1.state.me.id);

  first.close(); again.close(); back.close(); owner.close(); relay.close();
});

test("invite codes and tokens come from real randomness, not Math.random", async () => {
  const { relay, owner } = await stand("sec-entropy.db");
  const codes = new Set<string>();
  for (let i = 0; i < 200; i++) codes.add(relay.store.createInvite(relay.ownerId));
  assert.equal(codes.size, 200, "200 codes, 200 different codes");
  for (const code of codes) {
    // 16 bytes of OS randomness, url-safe: no timestamp, nothing to predict
    assert.match(code, /^inv_[A-Za-z0-9_-]{22}$/);
  }
  // the old shape was `inv_<base36 timestamp><6 random chars>` — codes made in
  // the same millisecond shared a visible prefix. These share nothing.
  const list = [...codes];
  assert.notEqual(list[0].slice(4, 12), list[1].slice(4, 12));
  owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// P1 #3 — removing someone revokes, it never recycles
// ---------------------------------------------------------------------------

test("a removed person's invite code does not let them back in", async () => {
  const { relay, url, owner } = await stand("sec-remove.db");
  const code = await invite(owner);
  const priya = new TestClient(url, `invite:${code}:Priya`);
  const hers = await priya.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const herToken = tokenOf(priya);

  owner.send({ type: "removeUser", userId: hers.state.me.id });
  await owner.wait(f => f.type === "userRemoved");

  // the code she came in on is retired, not handed back
  assert.equal(relay.store.invite(code)?.revoked, true);
  const retry = new TestClient(url, `invite:${code}:Priya`);
  const err = await retry.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(!retry.frames.some(f => f.type === "welcome"), `a removed person walked back in (${err.error})`);
  assert.equal(relay.store.users().some(u => u.name === "Priya"), false);

  // and her old sign-in token is gone too
  const oldToken = new TestClient(url, herToken);
  await oldToken.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.ok(!oldToken.frames.some(f => f.type === "welcome"));

  priya.close(); retry.close(); oldToken.close(); owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// P1 #6 — authorisation comes from stored state, never from the frame
// ---------------------------------------------------------------------------

test("a guest cannot drive the owner's agents", async () => {
  const { relay, url, owner } = await stand("sec-tasks.db");
  const welcome = owner.frames.find(f => f.type === "welcome") as Extract<ServerFrame, { type: "welcome" }>;
  const general = welcome.state.channels.find(c => c.name === "general")!;

  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } });
  const scout = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;

  const code = await invite(owner);
  const priya = new TestClient(url, `invite:${code}:Priya`);
  await priya.wait(f => f.type === "welcome");

  // background work on someone else's subscription
  priya.send({ type: "createTask", agentId: scout.id, channelId: general.id, title: "spend his money" });
  const denied = await priya.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /not your agent/);
  assert.equal(relay.store.tasks().length, 0, "no task was created");

  // ...and the same rule on the agent's status lamp
  priya.send({ type: "agentStatus", agentId: scout.id, status: "braked" });
  await priya.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && /not your agent/.test(f.error));
  assert.equal(relay.agentStatus[scout.id], undefined);

  priya.close(); owner.close(); relay.close();
});

test("the approval gate is the agent's setting, not the client's claim", async () => {
  const { relay, url, owner } = await stand("sec-approvals.db");
  const welcome = owner.frames.find(f => f.type === "welcome") as Extract<ServerFrame, { type: "welcome" }>;
  const general = welcome.state.channels.find(c => c.name === "general")!;

  owner.send({
    type: "createAgent",
    agent: { ...BASE_AGENT, name: "Guard", approvals: { background: true, schedules: false } },
  });
  const guard = (await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent")).agent;

  // a client that simply says "no approval needed" used to be believed
  owner.send({
    type: "createTask", agentId: guard.id, channelId: general.id,
    title: "do the risky thing", needsApproval: false,
    action: "Read a harmless file",
  });
  const task = await owner.wait<Extract<ServerFrame, { type: "task" }>>(f => f.type === "task");
  assert.equal(task.task.status, "waiting_approval", "the agent's own setting decides");
  assert.ok(task.task.approvalId, "an approval was raised anyway");

  // and the sentence the owner reads describes the real work, not the client's
  // flattering version of it
  const approval = relay.store.approval(task.task.approvalId!)!;
  assert.match(approval.action, /do the risky thing/);
  assert.ok(!/harmless/.test(approval.action));

  owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// P1 #7 — you only ever see the conversations you are in
// ---------------------------------------------------------------------------

test("a guest is never handed another channel's messages", async () => {
  const { relay, url, owner } = await stand("sec-scope.db");

  const codeA = await invite(owner);
  const priya = new TestClient(url, `invite:${codeA}:Priya`);
  const pw = await priya.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");

  // a private room for the owner and Priya only
  owner.send({ type: "createChannel", name: "money", memberIds: [pw.state.me.id], kind: "channel" });
  const room = (await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "money")).channel;
  owner.send({ type: "send", channelId: room.id, text: "the bank password is hunter2" });
  await owner.wait(f => f.type === "message" && /hunter2/.test(f.message.text));

  // a third person joins later
  const codeB = await invite(owner, codeA);
  const raj = new TestClient(url, `invite:${codeB}:Raj`);
  const rw = await raj.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");

  // 1. the opening frame carries nothing from a room he is not in
  assert.ok(!JSON.stringify(rw.state.messages).includes("hunter2"), "the backlog leaked");
  assert.equal(rw.state.channels.some(c => c.id === room.id), false, "the room itself leaked");

  // 2. nor can he ask for it by id
  raj.send({ type: "history", channelId: room.id });
  const noHistory = await raj.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(noHistory.error, /no such channel/);
  assert.ok(!raj.frames.some(f => f.type === "history"), "no history frame came back");

  // 3. nor post into it
  raj.send({ type: "send", channelId: room.id, text: "hello from outside" });
  await raj.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && /no such channel/.test(f.error));
  assert.equal(
    relay.store.history(room.id, Date.now() + 1, 50).some(m => /from outside/.test(m.text)),
    false, "an outsider's message reached a private room");

  // 4. and the people who ARE in it still work normally
  priya.send({ type: "history", channelId: room.id });
  const mine = await priya.wait<Extract<ServerFrame, { type: "history" }>>(f => f.type === "history");
  assert.ok(mine.messages.some(m => /hunter2/.test(m.text)));

  priya.close(); raj.close(); owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// #10 — the Cancel button now has somewhere to send its frame
// ---------------------------------------------------------------------------

test("cancelling a sign-in releases the lock instead of blocking every retry", async () => {
  const relay = new Relay({
    dbPath: tmp("sec-cancel.db"), ownerToken: "tok-secret", ownerName: "Vikas",
  });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-secret");
  await owner.wait(f => f.type === "welcome");
  const host = new TestClient(url, "tok-secret", "engine");
  await host.wait(f => f.type === "welcome");

  owner.send({ type: "harnessSignIn", harness: "codex" });
  await host.wait(f => f.type === "harnessRequest" && f.action === "signIn");

  // a second attempt while one is running is refused — that is the rate limit
  owner.send({ type: "harnessSignIn", harness: "codex" });
  const busy = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(busy.error, /already running/);

  // Cancel, and the engine is told to stop waiting
  owner.send({ type: "harnessCancel", harness: "codex" });
  const told = await host.wait<Extract<ServerFrame, { type: "harnessRequest" }>>(
    f => f.type === "harnessRequest" && f.action === "cancel");
  assert.equal(told.harness, "codex");

  // ...and trying again works straight away instead of being locked out
  owner.send({ type: "harnessSignIn", harness: "codex" });
  await host.wait<Extract<ServerFrame, { type: "harnessRequest" }>>(
    f => f.type === "harnessRequest" && f.action === "signIn", 3000);

  owner.close(); host.close(); relay.close();
});

test("a guest cannot cancel the owner's sign-in", async () => {
  const relay = new Relay({
    dbPath: tmp("sec-cancel2.db"), ownerToken: "tok-secret", ownerName: "Vikas",
  });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-secret");
  await owner.wait(f => f.type === "welcome");
  const code = await invite(owner);
  const priya = new TestClient(url, `invite:${code}:Priya`);
  await priya.wait(f => f.type === "welcome");

  priya.send({ type: "harnessCancel", harness: "codex" });
  const denied = await priya.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(denied.error, /only the owner/);

  priya.close(); owner.close(); relay.close();
});

/** The durable token the relay issued to this client when it redeemed an invite. */
function tokenOf(client: TestClient): string {
  const frame = client.frames.find(f => f.type === "token") as
    Extract<ServerFrame, { type: "token" }> | undefined;
  assert.ok(frame, "expected a durable token");
  return frame.token;
}
