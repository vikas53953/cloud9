// SEARCH EVERYWHERE — one question, answered over everything the asker may
// already read: chat, thread replies, shared file names, and the words inside
// every readable text version the hub still holds, older versions included.
//
// These run against the REAL hub over a real socket, because the thing most
// worth proving here cannot be proved anywhere else: the permission gate. A
// store test can show the SQL excludes a row; only the hub can show that the
// row never reaches the wire for the person who must not see it.
//
// EVERY TEST HERE WAS WATCHED TO FAIL with the feature broken on purpose. The
// break is named beside each one.
import test from "node:test";
import assert from "node:assert/strict";
import { EverywhereHit, SearchKind, ServerFrame, nameKey } from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

type Results = Extract<ServerFrame, { type: "searchEverywhereResults" }>;

const BASE_AGENT = {
  emoji: "🔭", persona: "You write things down",
  abilities: { webSearch: false, files: true, schedules: false, background: false },
};

async function stand(name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const hello = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  const general = hello.state.channels.find(c => c.name === "general")!;
  return { relay, url, owner, engine, general, me: hello.state.me };
}

async function makeAgent(client: TestClient, name: string) {
  client.send({ type: "createAgent", agent: { ...BASE_AGENT, name } });
  const frame = await client.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === name);
  return frame.agent;
}

async function guestOf(url: string, owner: TestClient, name: string) {
  /* The frames already in hand are cleared FIRST, because `wait` answers from
     them: asking for a second guest without this handed back the FIRST guest's
     invite, whose code was already spent, and the second guest simply never
     arrived. One invite, one guest. */
  owner.frames.length = 0;
  owner.send({ type: "createInvite" });
  const inv = await owner.wait<Extract<ServerFrame, { type: "invite" }>>(f => f.type === "invite");
  const guest = new TestClient(url, `invite:${inv.code}:${name}`);
  const w = await guest.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { guest, me: w.state.me };
}

async function say(client: TestClient, channelId: string, text: string, replyTo?: string) {
  client.frames.length = 0;
  client.send({ type: "send", channelId, text, ...(replyTo ? { replyTo } : {}) });
  const frame = await client.wait<Extract<ServerFrame, { type: "message" }>>(
    f => f.type === "message" && f.message.text === text);
  return frame.message;
}

async function publish(
  engine: TestClient, watcher: TestClient,
  input: { channelId: string; agentId: string; name: string; body: string },
) {
  watcher.frames.length = 0;
  engine.send({
    type: "publishArtifact", channelId: input.channelId, agentId: input.agentId,
    name: input.name, dataBase64: Buffer.from(input.body).toString("base64"),
  });
  const answer = await watcher.wait<ServerFrame>(
    f => (f.type === "artifact" && nameKey(f.artifact.name) === nameKey(input.name))
      || f.type === "error");
  if (answer.type === "error") throw new Error(`the hub refused the publish: ${answer.error}`);
  return answer as Extract<ServerFrame, { type: "artifact" }>;
}

/** Ask the real question over the real socket and wait for THIS answer. */
async function look(
  client: TestClient, query: string,
  opts: { kind?: SearchKind; limit?: number; requestId?: string } = {},
): Promise<Results> {
  const requestId = opts.requestId ?? `rq_${Math.random().toString(36).slice(2, 10)}`;
  client.frames.length = 0;
  client.send({
    type: "searchEverywhere", query, requestId,
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
  });
  const answer = await client.wait<ServerFrame>(
    f => (f.type === "searchEverywhereResults" || f.type === "error")
      && (f as { requestId?: string }).requestId === requestId);
  if (answer.type === "error") throw new Error(`REFUSED: ${answer.error}`);
  return answer as Results;
}

/** The refusal itself, when the refusal is the thing being proved. */
async function refuses(client: TestClient, query: string, contains: string) {
  const requestId = `rq_${Math.random().toString(36).slice(2, 10)}`;
  client.frames.length = 0;
  client.send({ type: "searchEverywhere", query, requestId });
  const answer = await client.wait<ServerFrame>(
    f => (f.type === "searchEverywhereResults" || f.type === "error")
      && (f as { requestId?: string }).requestId === requestId);
  assert.equal(answer.type, "error", `"${query}" should have been refused, not answered`);
  const error = (answer as Extract<ServerFrame, { type: "error" }>).error;
  assert.ok(error.includes(contains), `refusal said "${error}"`);
  assert.ok(!/^(Error|TypeError|SyntaxError):/.test(error),
    "a refusal never arrives wearing an exception's class name");
}

const kindsOf = (r: Results) => r.results.map(h => h.kind).sort();

test("one search finds all four kinds — message, reply, file name, words inside a version", async () => {
  // BREAK THAT FAILED IT: index only messages (drop the two artifact document
  // writes in `appendArtifactVersion`) and the file/fileVersion halves go blank.
  const { relay, owner, engine, general } = await stand("se-kinds.db");
  const agent = await makeAgent(owner, "Scribe");

  const root = await say(owner, general.id, "the zephyrine plan is agreed");
  const reply = await say(owner, general.id, "quintaline is the open question", root.id);
  await publish(engine, owner, {
    channelId: general.id, agentId: agent.id,
    name: "orbitgram.md", body: "the helioplex reading is steady\n",
  });

  const chat = await look(owner, "zephyrine");
  assert.deepEqual(kindsOf(chat), ["message"], "a root message comes back as a message");
  assert.equal(chat.results[0].messageId, root.id);
  assert.equal(chat.results[0].threadParentId, undefined, "a root message has no thread parent");
  assert.equal(chat.results[0].whoName, "Vikas");
  assert.equal(chat.results[0].channelId, general.id);
  assert.ok(chat.results[0].snippet.includes("zephyrine"), "the row says what matched");

  const inThread = await look(owner, "quintaline");
  assert.deepEqual(kindsOf(inThread), ["reply"], "a reply is its own kind, not a plain message");
  assert.equal(inThread.results[0].messageId, reply.id);
  assert.equal(inThread.results[0].threadParentId, root.id,
    "a reply carries the id needed to open its thread");

  const byName = await look(owner, "orbitgram");
  assert.deepEqual(kindsOf(byName), ["file"], "a file name match is a file, once, not once per version");
  assert.equal(byName.results[0].name, "orbitgram.md");
  assert.ok(byName.results[0].artifactId, "a file row carries the id that opens it");
  assert.equal(byName.results[0].whoName, "Scribe", "the agent that made it is named");

  const inside = await look(owner, "helioplex");
  assert.deepEqual(kindsOf(inside), ["fileVersion"], "words inside a version are their own kind");
  assert.equal(inside.results[0].versionNumber, 1);
  assert.ok(inside.results[0].versionId, "the exact bytes that matched are identified");
  assert.ok(inside.results[0].artifactId, "and the file they belong to");
  assert.ok(inside.results[0].snippet.includes("helioplex"));

  // `kind` narrows and only narrows.
  const only = await look(owner, "the", { kind: "reply" });
  assert.deepEqual(new Set(kindsOf(only)), new Set(["reply"]),
    "asking for replies returns nothing but replies");

  owner.close(); engine.close(); await relay.close();
});

test("a word nobody wrote is answered with nothing at all, plainly", async () => {
  // BREAK THAT FAILED IT: let an unmatched query fall through to no frame; the
  // wait times out instead of receiving an honest empty answer.
  const { relay, owner, general } = await stand("se-empty.db");
  await say(owner, general.id, "nothing unusual here");

  const none = await look(owner, "vermilionwatt");
  assert.deepEqual(none.results, [], "no hits is an empty list, not a silence and not an error");
  assert.equal(none.hasMore, false);
  assert.equal(none.query, "vermilionwatt", "the answer says which question it answers");

  owner.close(); await relay.close();
});

test("a restricted file is invisible to a plain member and visible to a manager", async () => {
  // THIS IS THE SECURITY TEST. BREAK THAT FAILED IT: drop the `fileGate` clause
  // from `Store.searchEverywhere` — the guest immediately gets both the name
  // and a snippet of the contents of a file the Files screen hides from her.
  const { relay, url, owner, engine, me } = await stand("se-access.db");
  const agent = await makeAgent(owner, "Scribe");
  const { guest, me: guestMe } = await guestOf(url, owner, "Priya");

  owner.send({ type: "createChannel", name: "ledger", memberIds: [guestMe.id, agent.id] });
  const made = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "ledger");
  const room = made.channel;
  await guest.wait(f => f.type === "channel" && f.channel.name === "ledger");

  const file = await publish(engine, owner, {
    channelId: room.id, agentId: agent.id,
    name: "cassiopeium.md", body: "the tunbridge figure is wrong\n",
  });
  const artifactId = file.artifact.id;

  // While it is a room file, she can find it both ways — otherwise the test
  // below would prove nothing but that search is broken for her.
  assert.deepEqual(kindsOf(await look(guest, "cassiopeium")), ["file"],
    "a room file is findable by name by everyone in the room");
  assert.deepEqual(kindsOf(await look(guest, "tunbridge")), ["fileVersion"],
    "and by its contents");

  owner.send({ type: "setArtifactAccess", artifactId, access: { kind: "restricted", userIds: [me.id] } });
  await owner.wait(f => f.type === "artifact" && f.artifact.id === artifactId
    && f.artifact.access?.kind === "restricted");

  const hiddenName = await look(guest, "cassiopeium");
  assert.deepEqual(hiddenName.results, [],
    "a restricted file's NAME never reaches someone it is restricted away from");
  const hiddenWords = await look(guest, "tunbridge");
  assert.deepEqual(hiddenWords.results, [],
    "and neither does one word of what is inside it");

  // Not one field of any answer she gets may carry it, by any route.
  const wide = await look(guest, "the");
  const leaked = JSON.stringify(wide.results);
  assert.ok(!leaked.includes(artifactId), "no answer of hers carries the restricted file's id");
  assert.ok(!leaked.includes("cassiopeium"), "nor its name");
  assert.ok(!leaked.includes("tunbridge"), "nor a word of its contents");

  // The room's manager still finds exactly the same file both ways.
  assert.deepEqual(kindsOf(await look(owner, "cassiopeium")), ["file"],
    "the manager who restricted it can still find it by name");
  const managerWords = await look(owner, "tunbridge");
  assert.deepEqual(kindsOf(managerWords), ["fileVersion"], "and by its contents");
  assert.equal(managerWords.results[0].artifactId, artifactId);

  owner.close(); engine.close(); guest.close(); await relay.close();
});

test("a retained OLDER version's words are findable, and name their own version", async () => {
  // BREAK THAT FAILED IT: index only the newest version (index in
  // `pushArtifactProjectionDiff` instead of per-append) — v1's word vanishes
  // the moment v2 lands, though its bytes are still on the hub.
  const { relay, owner, engine, general } = await stand("se-old.db");
  const agent = await makeAgent(owner, "Scribe");

  await publish(engine, owner, {
    channelId: general.id, agentId: agent.id,
    name: "almanac.md", body: "the aldebarine total was 41\n",
  });
  await publish(engine, owner, {
    channelId: general.id, agentId: agent.id,
    name: "almanac.md", body: "the perigordine total was 58\n",
  });

  const old = await look(owner, "aldebarine");
  assert.deepEqual(kindsOf(old), ["fileVersion"], "the older version's words are still findable");
  assert.equal(old.results[0].versionNumber, 1, "and the hit names version 1, not the newest");
  assert.equal(old.results[0].name, "almanac.md");

  const fresh = await look(owner, "perigordine");
  assert.equal(fresh.results[0].versionNumber, 2,
    "the newest version's words point at the newest version");
  assert.notEqual(fresh.results[0].versionId, old.results[0].versionId,
    "two versions of one file are two different sets of bytes");

  owner.close(); engine.close(); await relay.close();
});

test("FTS5 syntax a person typed is words, not operators — and never a crash", async () => {
  // BREAK THAT FAILED IT: hand `frame.query` straight to MATCH instead of
  // through `searchTerms`/`ftsMatch`. The hub throws SQLITE_ERROR on the first
  // stray quote and the socket gets an exception's text.
  const { relay, owner, general } = await stand("se-hostile.db");
  await say(owner, general.id, "the marmalade order is placed");
  await say(owner, general.id, "NEAR the window");

  const hostile = [
    '"', '""', 'marmalade"', '"marmalade', "marmalade OR",
    "NEAR(marmalade window)", "marmalade AND NOT window", "marmalade*",
    "col:marmalade", "-marmalade", "^marmalade", "marmalade )(",
    "{marmalade}", "marmalade window", "'; DROP TABLE messages; --",
  ];
  for (const query of hostile) {
    let answer: Results | undefined;
    try {
      answer = await look(owner, query);
    } catch (e) {
      // A refusal is a fine answer to punctuation. An exception's own words
      // reaching the socket is not, and `refusalText` is what stops it.
      assert.ok(String(e).includes("REFUSED"), `"${query}" produced ${String(e)}`);
    }
    if (answer) {
      assert.ok(Array.isArray(answer.results), `"${query}" answered with a list`);
    }
  }

  // Queries with no word in them at all are refused in plain words.
  for (const empty of ["", "   ", '"""', "***", "()", "-", "?!"]) {
    await refuses(owner, empty, "at least one word");
  }

  // And after all of that the hub is still standing and still correct.
  const after = await look(owner, "marmalade");
  assert.equal(after.results.length, 1, "the hub still answers ordinary questions");
  assert.equal(after.results[0].kind, "message");

  owner.close(); await relay.close();
});

test("the request id comes back on the answer and on the refusal", async () => {
  // BREAK THAT FAILED IT: drop the requestId spread from the
  // `searchEverywhereResults` frame — two searches in flight can no longer be
  // told apart, and the later answer overwrites the earlier screen.
  const { relay, owner, general } = await stand("se-reqid.db");
  await say(owner, general.id, "the calomirtle is ready");

  owner.frames.length = 0;
  owner.send({ type: "searchEverywhere", query: "calomirtle", requestId: "rq_first" });
  owner.send({ type: "searchEverywhere", query: "nothingatallhere", requestId: "rq_second" });
  owner.send({ type: "searchEverywhere", query: "!!!", requestId: "rq_third" });

  const first = await owner.wait<Results>(
    f => f.type === "searchEverywhereResults" && f.requestId === "rq_first");
  assert.equal(first.results.length, 1, "the id belongs to the answer for its own question");
  assert.equal(first.query, "calomirtle");

  const second = await owner.wait<Results>(
    f => f.type === "searchEverywhereResults" && f.requestId === "rq_second");
  assert.deepEqual(second.results, [], "an empty answer is correlated too, not dropped");

  const third = await owner.wait<Extract<ServerFrame, { type: "error" }>>(
    f => f.type === "error" && f.requestId === "rq_third");
  assert.ok(third.error.includes("at least one word"), "and so is the refusal");

  owner.close(); await relay.close();
});

test("search everywhere never reaches a room the asker is not in", async () => {
  // BREAK THAT FAILED IT: pass `this.store.channels()` instead of
  // `this.visibleChannels(conn.userId)` — the guest reads a private room.
  const { relay, url, owner, engine } = await stand("se-scope.db");
  const agent = await makeAgent(owner, "Scribe");
  // An invited guest lands in `general`, so `general` proves nothing here. The
  // room that proves it is one she was never put in.
  const { guest } = await guestOf(url, owner, "Priya");
  owner.send({ type: "createChannel", name: "vault", memberIds: [agent.id] });
  const made = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "vault");
  const vault = made.channel;

  await say(owner, vault.id, "the strontanium note is filed");
  await publish(engine, owner, {
    channelId: vault.id, agentId: agent.id,
    name: "vantablume.md", body: "the ferrocyne count is 12\n",
  });

  for (const token of ["strontanium", "vantablume", "ferrocyne"]) {
    const answer = await look(guest, token);
    assert.deepEqual(answer.results, [],
      `a room she is not in leaks nothing, not even "${token}"`);
  }

  owner.close(); engine.close(); guest.close(); await relay.close();
});

test("a deleted message and a pruned version stop being findable", async () => {
  // BREAK THAT FAILED IT: drop `unindexDoc` from `pruneArtifactVersions` — the
  // words of bytes the hub has thrown away keep coming back as hits that open
  // nothing at all.
  const { relay, owner, engine, general } = await stand("se-gone.db");
  const agent = await makeAgent(owner, "Scribe");

  const doomed = await say(owner, general.id, "the tellurance was miscounted");
  assert.equal((await look(owner, "tellurance")).results.length, 1);
  owner.send({ type: "deleteMessage", messageId: doomed.id });
  await owner.wait(f => f.type === "messageUpdated" && f.message.id === doomed.id
    && f.message.deletedAt !== undefined);
  assert.deepEqual((await look(owner, "tellurance")).results, [],
    "a message taken back takes its words out of search with it");

  // Publish past the retention cap so version 1 is pruned, bytes and row.
  await publish(engine, owner, {
    channelId: general.id, agentId: agent.id,
    name: "rolling.md", body: "the ninhydrine sample is first\n",
  });
  assert.equal((await look(owner, "ninhydrine")).results.length, 1, "v1 is findable while it is kept");
  for (let i = 0; i < 20; i++) {
    await publish(engine, owner, {
      channelId: general.id, agentId: agent.id,
      name: "rolling.md", body: `plain filler line number ${i}\n`,
    });
  }
  assert.deepEqual((await look(owner, "ninhydrine")).results, [],
    "a pruned version's words go with its bytes");

  owner.close(); engine.close(); await relay.close();
});

test("a restart rebuilds the one index over all four kinds, not just messages", async () => {
  // BREAK THAT FAILED IT: count only messages in `searchIndexComplete` — the
  // index is declared complete while every file document is missing, so nothing
  // ever rebuilds them and files are permanently unfindable after a restart.
  const dbPath = tmp("se-restart.db");
  const first = new Relay({ dbPath, ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await first.listen(0);
  const url = `ws://127.0.0.1:${port}`;
  const owner = new TestClient(url, "tok-owner");
  const hello = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  const engine = new TestClient(url, "tok-owner", "engine");
  await engine.wait(f => f.type === "welcome");
  const general = hello.state.channels.find(c => c.name === "general")!;
  const agent = await makeAgent(owner, "Scribe");

  await say(owner, general.id, "the barytone reading holds");
  await publish(engine, owner, {
    channelId: general.id, agentId: agent.id,
    name: "sextantine.md", body: "the wolframite total is 7\n",
  });
  owner.close(); engine.close(); await first.close();

  const second = new Relay({ dbPath, ownerToken: "tok-owner", ownerName: "Vikas" });
  const port2 = await second.listen(0);
  const back = new TestClient(`ws://127.0.0.1:${port2}`, "tok-owner");
  await back.wait(f => f.type === "welcome");

  const found: EverywhereHit[] = [];
  for (const token of ["barytone", "sextantine", "wolframite"]) {
    const answer = await look(back, token);
    assert.equal(answer.results.length, 1, `"${token}" survives a restart`);
    found.push(answer.results[0]);
  }
  assert.deepEqual(found.map(h => h.kind), ["message", "file", "fileVersion"],
    "all three document kinds come back, from the one index");

  back.close(); await second.close();
});

test("without FTS5 the fallback answers the same question — and hides the same restricted file", async () => {
  // THE SECOND SECURITY TEST, and the reason it exists: the no-index branch
  // writes its own SQL and binds its own arguments, so it can drift away from
  // the indexed branch's permissions without a single line of the gate itself
  // changing. Being untested made an argument-order slip a silent leak.
  //
  // BREAK THAT FAILED IT: in the fallback's file arm, bind the reader before
  // the words (`args.push(...ids, userId, userId, ...terms)`). The two `?` of
  // `fileGate` are then fed the search words, the gate matches nobody, and the
  // restricted file disappears for the MANAGER too — watched, then restored.
  const { relay, url, owner, engine, me } = await stand("se-nofts.db");
  const agent = await makeAgent(owner, "Scribe");
  const { guest, me: guestMe } = await guestOf(url, owner, "Priya");

  owner.send({ type: "createChannel", name: "ledger", memberIds: [guestMe.id, agent.id] });
  const made = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "ledger");
  const room = made.channel;
  await guest.wait(f => f.type === "channel" && f.channel.name === "ledger");

  const root = await say(owner, room.id, "the zephyrine plan is agreed");
  const reply = await say(owner, room.id, "quintaline is the open question", root.id);
  const file = await publish(engine, owner, {
    channelId: room.id, agentId: agent.id,
    name: "cassiopeium.md", body: "the tunbridge figure is wrong\n",
  });
  const artifactId = file.artifact.id;

  /* THE MACHINE WITHOUT FTS5. Everything above was written by the ordinary
     hub; from here on the same hub must answer with the index switched off,
     which is exactly the position a person on an SQLite build without FTS5 is
     in from the first minute. */
  relay.store.searchIndexed = false;

  const chat = await look(owner, "zephyrine");
  assert.deepEqual(kindsOf(chat), ["message"], "a message is still found with no index");
  assert.equal(chat.results[0].messageId, root.id);
  assert.ok(chat.results[0].snippet.includes("zephyrine"),
    "and the row still says what matched, from the words themselves");

  const inThread = await look(owner, "quintaline");
  assert.deepEqual(kindsOf(inThread), ["reply"],
    "a reply is still told apart from a message with no index");
  assert.equal(inThread.results[0].messageId, reply.id);
  assert.equal(inThread.results[0].threadParentId, root.id);

  const byName = await look(owner, "cassiopeium");
  assert.deepEqual(kindsOf(byName), ["file"], "a file name is still found with no index");
  assert.equal(byName.results[0].artifactId, artifactId);

  /* And the honest limit, stated as a fact rather than left to be discovered:
     the words INSIDE a version were only ever collected in the index this
     machine cannot build, so they are not findable — but nothing crashes and
     nothing is invented in their place. */
  assert.deepEqual((await look(owner, "tunbridge")).results, [],
    "words inside a version are not findable without the index, and say so by finding nothing");

  // She is in the room, so the file is hers to find while it is a room file —
  // otherwise the check below would prove nothing but that search is broken.
  assert.deepEqual(kindsOf(await look(guest, "cassiopeium")), ["file"],
    "a room file is findable by name by everyone in the room, index or no index");
  assert.deepEqual(kindsOf(await look(guest, "zephyrine")), ["message"],
    "and her ordinary search works, so an empty answer below means the gate and nothing else");

  owner.send({ type: "setArtifactAccess", artifactId, access: { kind: "restricted", userIds: [me.id] } });
  await owner.wait(f => f.type === "artifact" && f.artifact.id === artifactId
    && f.artifact.access?.kind === "restricted");

  assert.deepEqual((await look(guest, "cassiopeium")).results, [],
    "the no-index branch hides a restricted file's NAME from a plain member too");
  const wide = await look(guest, "the");
  const leaked = JSON.stringify(wide.results);
  assert.ok(!leaked.includes(artifactId), "no answer of hers carries the restricted file's id");
  assert.ok(!leaked.includes("cassiopeium"), "nor its name");
  assert.deepEqual(kindsOf(await look(guest, "zephyrine")), ["message"],
    "while the room's messages are still hers to read");

  assert.deepEqual(kindsOf(await look(owner, "cassiopeium")), ["file"],
    "and the manager still finds it — the gate lets the right person through, "
    + "which is the half an argument-order slip would quietly break");

  owner.close(); engine.close(); guest.close(); await relay.close();
});

test("a chosen person finds the restricted file — until she is out of the room", async () => {
  // The gate has THREE arms and the tests had two. This is the third: the
  // selected-user allow, which is the only reason "restricted" is a list of
  // people rather than a lock. And it is checked AGAIN after the membership
  // behind it changes, because a permission answered once and remembered is
  // how someone keeps reading a room they were taken out of.
  //
  // BREAK THAT FAILED IT: drop the `artifact_access_users` arm from `fileGate`
  // (leaving the manager arm) and Priya — named on the list herself — is told
  // the file does not exist.
  const { relay, url, owner, engine, me } = await stand("se-chosen.db");
  const agent = await makeAgent(owner, "Scribe");
  const { guest: priya, me: priyaMe } = await guestOf(url, owner, "Priya");
  const { guest: ravi, me: raviMe } = await guestOf(url, owner, "Ravi");

  owner.send({
    type: "createChannel", name: "ledger",
    memberIds: [priyaMe.id, raviMe.id, agent.id],
  });
  const made = await owner.wait<Extract<ServerFrame, { type: "channel" }>>(
    f => f.type === "channel" && f.channel.name === "ledger");
  const room = made.channel;
  await priya.wait(f => f.type === "channel" && f.channel.name === "ledger");
  await ravi.wait(f => f.type === "channel" && f.channel.name === "ledger");

  await say(owner, room.id, "the zephyrine plan is agreed");
  const file = await publish(engine, owner, {
    channelId: room.id, agentId: agent.id,
    name: "cassiopeium.md", body: "the tunbridge figure is wrong\n",
  });
  const artifactId = file.artifact.id;

  // Restricted to the owner AND Priya. Ravi is in the same room and is not on
  // the list, which is what makes Priya's answer about the list and not about
  // the room.
  owner.send({
    type: "setArtifactAccess", artifactId,
    access: { kind: "restricted", userIds: [me.id, priyaMe.id] },
  });
  await owner.wait(f => f.type === "artifact" && f.artifact.id === artifactId
    && f.artifact.access?.kind === "restricted");

  assert.deepEqual(kindsOf(await look(priya, "cassiopeium")), ["file"],
    "a plain member ON the list finds the restricted file by name");
  const chosenWords = await look(priya, "tunbridge");
  assert.deepEqual(kindsOf(chosenWords), ["fileVersion"], "and the words inside it");
  assert.equal(chosenWords.results[0].artifactId, artifactId);

  assert.deepEqual((await look(ravi, "cassiopeium")).results, [],
    "the same room, not on the list, finds nothing — so it is the list that let her in");
  assert.deepEqual((await look(ravi, "tunbridge")).results, []);
  assert.deepEqual(kindsOf(await look(ravi, "zephyrine")), ["message"],
    "though his ordinary search of that room works perfectly");

  // ---- THE MEMBERSHIP CHANGES, AND THE SAME QUESTION IS ASKED AGAIN ----
  owner.send({ type: "removeMember", channelId: room.id, memberId: priyaMe.id });
  await priya.wait(f => f.type === "channelLeft" && f.channelId === room.id);

  assert.deepEqual((await look(priya, "cassiopeium")).results, [],
    "out of the room, being named on the file's list no longer finds it");
  assert.deepEqual((await look(priya, "tunbridge")).results, [],
    "nor one word of what is inside it");
  assert.deepEqual((await look(priya, "zephyrine")).results, [],
    "and the room's messages go with it — the answer is re-decided, never remembered");

  assert.deepEqual(kindsOf(await look(owner, "cassiopeium")), ["file"],
    "the room's manager is untouched by any of it");

  owner.close(); engine.close(); priya.close(); ravi.close(); await relay.close();
});
