// Security review 2026-07-29 — the regression net.
//
// Every test in this file failed before its fix landed. The first one is the
// reviewer's proof-of-concept, turned into something that runs on every build:
// a guest walking in and coming out holding the owner's account.
import test from "node:test";
import assert from "node:assert/strict";
import { ServerFrame } from "@cloud9/shared";
import { WebSocket } from "ws";
import { DEFAULT_OWNER_TOKEN, LOOPBACK, Relay, isAllowedWsOrigin, resolveBind } from "./server.js";
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
    relay.store.history(room.id, {}, 50).items.some(m => /from outside/.test(m.text)),
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

// ---------------------------------------------------------------------------
// M4 — a connection is a pipe, not a person.
//
// The engine host holds ONE socket and carries everybody's requests down it, so
// "whoever owns this socket" is the wrong answer for anything it relays. A
// friend's delegated job used to come out reading "asked by Vikas".
// ---------------------------------------------------------------------------

test("a delegated job is credited to the person who asked, not to the engine's owner", async () => {
  const { relay, url, owner } = await stand("attr-task.db");
  const code = await invite(owner);
  const friend = new TestClient(url, `invite:${code}:Priya`, "desktop");
  const hello = await friend.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const friendId = hello.state.me.id;

  // The owner's agent, in a channel the friend is in — and DELIBERATELY opened
  // up to her by name. Since the respond-to rule landed, being in a room with
  // someone's agent is no longer permission to set it working (the refusal is
  // proved in chat.test.ts, "a friend in the room cannot spend the owner's
  // subscription"). This test is about ATTRIBUTION once the work is allowed:
  // the job must be credited to the person who asked, not to the engine's owner.
  owner.send({
    type: "createAgent",
    agent: {
      ...BASE_AGENT, name: "Scout",
      respondTo: "allowlist", respondToAllowlist: [friendId],
    } as never,
  });
  const made = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent");
  const general = hello.state.channels.find(c => c.name === "general")!;
  owner.send({ type: "addMembers", channelId: general.id, memberIds: [made.agent.id] });
  await owner.wait(f => f.type === "channel");

  // the engine relays the friend's "!bg …" on its own socket, naming the friend
  const engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  engine.send({
    type: "createTask", agentId: made.agent.id, channelId: general.id,
    title: "book the villa", requesterId: friendId,
  });

  const task = await owner.wait<Extract<ServerFrame, { type: "task" }>>(f => f.type === "task");
  assert.equal(task.task.requesterId, friendId, "the task belongs to the friend who asked");
  assert.equal(task.task.requesterName, "Priya");

  // and the activity trail says the same thing
  owner.send({ type: "activity" });
  const act = await owner.wait<Extract<ServerFrame, { type: "activity" }>>(f => f.type === "activity");
  const row = act.records.find(r => r.kind === "task_created")!;
  assert.equal(row.actorName, "Priya", "the activity row names the person, not the engine's owner");

  owner.close(); friend.close(); engine.close(); relay.close();
});

test("an ordinary client cannot claim a job was asked for by somebody else", async () => {
  const { relay, url, owner } = await stand("attr-spoof.db");
  const code = await invite(owner);
  const friend = new TestClient(url, `invite:${code}:Priya`, "desktop");
  const hello = await friend.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");

  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
  const made = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent");
  const general = hello.state.channels.find(c => c.name === "general")!;

  // the owner's own desktop tries to file a job "asked by Priya"
  owner.send({
    type: "createTask", agentId: made.agent.id, channelId: general.id,
    title: "blame the friend", requesterId: hello.state.me.id,
  });
  const err = await owner.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /only your own agent engine/);

  owner.close(); friend.close(); relay.close();
});

test("the engine cannot credit a job to somebody who isn't even in the conversation", async () => {
  const { relay, url, owner } = await stand("attr-outsider.db");
  const code = await invite(owner);
  const friend = new TestClient(url, `invite:${code}:Priya`, "desktop");
  const hello = await friend.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const friendId = hello.state.me.id;

  owner.send({ type: "createAgent", agent: { ...BASE_AGENT, name: "Scout" } as never });
  const made = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent");
  // a private channel the friend was never added to
  owner.send({ type: "createChannel", name: "private", memberIds: [made.agent.id], kind: "channel" });
  const priv = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "private");

  const engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  engine.send({
    type: "createTask", agentId: made.agent.id, channelId: priv.channel.id,
    title: "read the private room", requesterId: friendId,
  });
  const err = await engine.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /isn't in this conversation/);

  owner.close(); friend.close(); engine.close(); relay.close();
});

// ---------------------------------------------------------------------------
// M3 — editing a skill must not silently delete its files.
// ---------------------------------------------------------------------------

test("editing a skill's wording keeps the files that skill already had", async () => {
  const { relay, owner } = await stand("skill-files.db");
  owner.send({
    type: "createAgent",
    agent: {
      ...BASE_AGENT, name: "Scout",
      skills: [{
        id: "sk1", name: "Villa shortlist", description: "picks villas",
        instructions: "three options with prices",
        files: [{ name: "checklist.md", text: "1. check the price" }],
      }],
    } as never,
  });
  const made = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent");

  // the screen sends the skill back without mentioning files at all
  owner.send({
    type: "updateAgent",
    agent: {
      ...made.agent,
      skills: [{
        id: "sk1", name: "Villa shortlist v2", description: "picks villas",
        instructions: "three options with prices",
      }],
    } as never,
  });
  const after = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.skills?.[0].name === "Villa shortlist v2");
  // the broadcast echoes the client, but what is STORED must still hold the file
  const stored = relay.store.agents().find(a => a.id === after.agent.id)!;
  assert.equal(stored.skills?.[0].files?.[0].name, "checklist.md",
    "an edit that never mentioned files must not delete them");

  owner.close(); relay.close();
});

test("a skill sent with an empty file list really does clear its files", async () => {
  const { relay, owner } = await stand("skill-files-clear.db");
  owner.send({
    type: "createAgent",
    agent: {
      ...BASE_AGENT, name: "Scout",
      skills: [{
        id: "sk1", name: "Villa shortlist", description: "picks villas",
        instructions: "three options", files: [{ name: "checklist.md", text: "x" }],
      }],
    } as never,
  });
  const made = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(f => f.type === "agent");
  owner.send({
    type: "updateAgent",
    agent: {
      ...made.agent,
      skills: [{ id: "sk1", name: "Villa shortlist", description: "picks villas",
        instructions: "three options", files: [] }],
    } as never,
  });
  await owner.wait(f => f.type === "agent" && f.agent.id === made.agent.id
    && (f.agent.skills?.[0].files?.length ?? -1) === 0);
  const stored = relay.store.agents().find(a => a.id === made.agent.id)!;
  assert.deepEqual(stored.skills?.[0].files, [],
    "\"no files\" and \"I didn't mention files\" are different sentences");

  owner.close(); relay.close();
});

// ---------------------------------------------------------------------------
// M7 — an invited friend on another computer must be able to reach the hub,
// without the hub ever answering the whole internet.
// ---------------------------------------------------------------------------

test("the hub answers this computer only unless it is told an address", () => {
  assert.equal(resolveBind(undefined), LOOPBACK);
  assert.equal(resolveBind(""), LOOPBACK);
  assert.equal(resolveBind("   "), LOOPBACK);
  assert.equal(new Relay({ dbPath: tmp("bind-default.db") }).bind, LOOPBACK);
});

test("a private-network address is accepted, so a friend can reach it", () => {
  assert.equal(resolveBind("100.101.102.103"), "100.101.102.103");
  const relay = new Relay({ dbPath: tmp("bind-tailscale.db"), bind: "100.101.102.103" });
  assert.equal(relay.bind, "100.101.102.103");
});

test("\"every network\" is REFUSED, never quietly narrowed", () => {
  // The hub can start programs on the owner's computer. A wildcard bind puts
  // that on every network the machine is on — so this fails loudly rather than
  // silently doing something safer than what was asked for.
  for (const wildcard of ["0.0.0.0", "::", "[::]", "*", "0", "0.0.0.0 "]) {
    assert.throws(() => resolveBind(wildcard), /will not listen on every network/,
      `${wildcard} must be refused`);
  }
  assert.throws(() => new Relay({ dbPath: tmp("bind-wild.db"), bind: "0.0.0.0" }),
    /will not listen on every network/);
});

test("opening the hub to a private network does not open the harness gate", async () => {
  // The safety rule and the reachability rule are independent: being reachable
  // from a friend's laptop must not make that friend able to start programs on
  // Vikas's machine.
  const relay = new Relay({
    dbPath: tmp("bind-guard.db"), ownerToken: "tok-owner", ownerName: "Vikas",
    bind: LOOPBACK, // bound anywhere, the gate below is the same
  });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  await owner.wait(f => f.type === "welcome");
  const code = await invite(owner);
  const friend = new TestClient(url, `invite:${code}:Priya`);
  await friend.wait(f => f.type === "welcome");

  friend.send({ type: "harnessSignIn", harness: "claude" });
  const err = await friend.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, /only the owner/);

  owner.close(); friend.close(); relay.close();
});

// ---------------------------------------------------------------------------
// Review 2026-08-04 C1 — a web page must not be able to reach this hub
//
// PROOF OF CONCEPT, run for real: this is exactly what a page on evil.com does.
// The browser writes the `Origin` header itself and the page cannot forge or
// remove it. Before the fix this connected, said hello with the token printed
// in the source, was welcomed as Vikas, and minted a working invite.
// ---------------------------------------------------------------------------

test("PoC: a web page cannot open a socket to this hub, even with the right key", async () => {
  const { relay, url, owner } = await stand("sec-origin.db");
  const asPage = (origin: string) => new Promise<string>(resolve => {
    const ws = new WebSocket(url, { headers: { Origin: origin } });
    ws.on("open", () => { ws.close(); resolve("connected"); });
    ws.on("unexpected-response", (_req, res) => { ws.close(); resolve(`refused ${res.statusCode}`); });
    ws.on("error", () => resolve("refused"));
  });

  assert.equal(await asPage("https://evil.com"), "refused 403",
    "a website was allowed to open a socket to the hub");
  assert.equal(await asPage("http://cloud9.example.org"), "refused 403");
  // ...and every real client still gets in. These are not websites:
  assert.equal(await asPage("http://127.0.0.1:5173"), "connected"); // workbench app screen
  assert.equal(await asPage("http://localhost:4173"), "connected"); // the QA browser
  assert.equal(await asPage("null"), "connected");                  // the installed app window
  // a program with no Origin at all — the engine host, the mobile app, a test
  const plain = new WebSocket(url);
  await new Promise<void>(r => plain.on("open", () => r()));
  plain.close();

  owner.close();
  relay.close();
});

test("the hub refuses to start with the starter key anywhere but this computer", async () => {
  // the key is printed in the source, the launcher and the sign-in box, so it
  // is only ever safe behind loopback
  const onNetwork = new Relay({
    dbPath: tmp("sec-default-token-net.db"), ownerToken: DEFAULT_OWNER_TOKEN,
    bind: "100.84.12.9", devMode: true,
  });
  await assert.rejects(() => onNetwork.listen(0), /starter key that everyone has/);
  onNetwork.close();

  const noDev = new Relay({
    dbPath: tmp("sec-default-token-nodev.db"), ownerToken: DEFAULT_OWNER_TOKEN, devMode: false,
  });
  await assert.rejects(() => noDev.listen(0), /starter key that everyone has/);
  noDev.close();

  // the workbench — this computer only, dev mode on — still starts
  const workbench = new Relay({
    dbPath: tmp("sec-default-token-ok.db"), ownerToken: DEFAULT_OWNER_TOKEN, devMode: true,
  });
  const port = await workbench.listen(0);
  assert.ok(port > 0);
  workbench.close();
});

test("the origin rule itself: what counts as a program, this computer, or a website", () => {
  assert.equal(isAllowedWsOrigin(undefined, LOOPBACK), true);      // a program
  assert.equal(isAllowedWsOrigin("null", LOOPBACK), true);         // the installed app
  assert.equal(isAllowedWsOrigin("file://", LOOPBACK), true);
  assert.equal(isAllowedWsOrigin("http://127.0.0.1:5173", LOOPBACK), true);
  assert.equal(isAllowedWsOrigin("http://[::1]:5173", LOOPBACK), true);
  assert.equal(isAllowedWsOrigin("https://evil.com", LOOPBACK), false);
  // a lookalike host must not pass by being a prefix or a suffix of a real one
  assert.equal(isAllowedWsOrigin("https://localhost.evil.com", LOOPBACK), false);
  assert.equal(isAllowedWsOrigin("https://127.0.0.1.evil.com", LOOPBACK), false);
  assert.equal(isAllowedWsOrigin("javascript://localhost", LOOPBACK), false);
  // a friend reaching the private address this hub was told to answer on
  assert.equal(isAllowedWsOrigin("http://100.84.12.9:5173", "100.84.12.9"), true);
  assert.equal(isAllowedWsOrigin("http://100.84.12.9:5173", LOOPBACK), false);
});
