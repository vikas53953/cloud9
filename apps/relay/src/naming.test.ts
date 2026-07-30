// ONE NAMING RULE, ONE FILE-NAME RULE — the class fixes behind five of the
// seven Majors phase 5 found (`docs/qa/phase5-negative.md`).
//
// What was wrong, in his words rather than in code:
//  • four agents could all be called `Scout`, and `@Sco` then offered four
//    identical rows, so he would hand real work to the wrong one (B6, B6b)
//  • two rooms could both be `#goa-trip` (D3)
//  • a room name of 3,000 characters was accepted while an agent name capped at
//    64 and said so — two forms, two answers (D4)
//  • six spaces became a room literally named `-` (D2)
//  • `report(1).pdf`, `café-menu.txt`, `photo#3.png` and `budget,notes.txt` were
//    all refused, and the sentence describing the rule was stricter than the
//    rule itself, so following its advice did not help (F3)
//
// Every test here FAILED before the fix. The point of the file is that the
// answers come from ONE function each — `validateName` and `isSafeFileName` —
// and that the hub, not the screen, is where they are enforced.
import test, { TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  AgentDef, contentDisposition, FILE_NAME_MAX, FILE_NAME_SENTENCE, isSafeFileName,
  NAME_LIMITS, nameKey, ServerFrame, validateAgentInput, validateName, validateProjectText,
  validateSkills,
} from "@cloud9/shared";
import { Relay } from "./server.js";
import { TestClient, tmp } from "./testclient.js";

async function stand(t: TestContext, name: string) {
  const relay = new Relay({ dbPath: tmp(name), ownerToken: "tok-owner", ownerName: "Vikas" });
  const port = await relay.listen(0);
  const owner = new TestClient(`ws://127.0.0.1:${port}`, "tok-owner");
  t.after(() => { owner.close(); relay.close(); });
  const welcome = await owner.wait<Extract<ServerFrame, { type: "welcome" }>>(f => f.type === "welcome");
  return { relay, owner, general: welcome.state.channels.find(c => c.name === "general")! };
}

async function refuses(client: TestClient, frame: Parameters<TestClient["send"]>[0], like: RegExp) {
  client.frames.length = 0;
  client.send(frame);
  const err = await client.wait<Extract<ServerFrame, { type: "error" }>>(f => f.type === "error");
  assert.match(err.error, like);
}

function agent(over: Partial<AgentDef> = {}): Omit<AgentDef, "id" | "ownerId" | "createdAt"> {
  return {
    name: "Scout", emoji: "✨", persona: "finds villas", provider: "claude",
    model: "claude-sonnet-5",
    abilities: { webSearch: false, files: false, schedules: false, background: false },
    approvals: {},
    ...over,
  } as Omit<AgentDef, "id" | "ownerId" | "createdAt">;
}

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

test("every kind of name is judged by ONE rule, and it answers in plain words", () => {
  for (const kind of ["agent", "channel", "project"] as const) {
    assert.equal(validateName(kind, "Scout"), null, kind);
    // nothing typed at all
    assert.match(validateName(kind, "") ?? "", /needs a name/);
    assert.match(validateName(kind, "   ") ?? "", /needs a name/);
    // D2: six spaces is not a name, and it is REFUSED rather than rewritten
    assert.match(validateName(kind, "      ") ?? "", /needs a name/);
    assert.match(validateName(kind, "---") ?? "", /at least one letter or number/);
    assert.match(validateName(kind, "...") ?? "", /at least one letter or number/);
    // D4: every kind has a cap, and every kind says what it is
    assert.match(validateName(kind, "x".repeat(NAME_LIMITS[kind] + 1)) ?? "",
      new RegExp(`too long \\(max ${NAME_LIMITS[kind]} characters\\)`));
    assert.equal(validateName(kind, "x".repeat(NAME_LIMITS[kind])), null, "the cap itself is allowed");
    // one line, and nothing invisible in it
    assert.match(validateName(kind, "two\nlines") ?? "", /one line/);
    assert.match(validateName(kind, `bel${String.fromCharCode(7)}`) ?? "", /one line/);
  }
  // names a person really chose are still names
  assert.equal(validateName("agent", "🐙🐙🐙"), null, "emoji is a name he picked (B3)");
  assert.equal(validateName("channel", "goa-trip"), null);
  assert.equal(validateName("project", "Cloud9 itself"), null);
});

test("two spellings of one name are one name", () => {
  assert.equal(nameKey("Scout"), nameKey("  scout  "));
  assert.equal(nameKey("goa  trip"), nameKey("Goa Trip"));
  assert.match(validateName("agent", "scout", ["Scout"]) ?? "",
    /you already have an agent called "Scout"/);
  assert.match(validateName("channel", "goa-trip", ["goa-trip"]) ?? "",
    /you already have a channel called "goa-trip"/);
  assert.match(validateName("project", "Cloud9", ["cloud9"]) ?? "",
    /you already have a project called "cloud9"/);
  // and a name nobody has is fine
  assert.equal(validateName("agent", "Scout", ["Runner", "Villa-finder"]), null);
});

test("the agent form and the project form ask that same rule, not copies of it", () => {
  assert.match(validateAgentInput(agent({ name: "Scout" }), { takenNames: ["scout"] }) ?? "",
    /you already have an agent called/);
  assert.match(validateAgentInput(agent({ name: "  " })) ?? "", /an agent needs a name/);
  assert.match(validateProjectText("Cloud9", undefined, ["cloud9"]) ?? "",
    /you already have a project called/);
  // an absent project name means "call it what the repository is called", and
  // that must not be mistaken for a name with no letters in it
  assert.equal(validateProjectText(undefined, undefined, ["cloud9"]), null);
  assert.equal(validateProjectText("", undefined, ["cloud9"]), null);
});

test("a SKILL is named too, and it goes through the same rule as everything else", () => {
  const skill = (name: string) => ({ name, instructions: "do the thing" });
  assert.equal(validateSkills([skill("Fare watch")]), null);
  assert.match(validateSkills([skill("   ")]) ?? "", /a skill needs a name/);
  assert.match(validateSkills([skill("...")]) ?? "", /at least one letter or number/);
  assert.equal(validateSkills([skill("x".repeat(NAME_LIMITS.skill + 1))]),
    `that name is too long (max ${NAME_LIMITS.skill} characters)`);
  // two skills on one agent with one name is the same confusion in miniature:
  // he opens one and edits the other
  assert.match(validateSkills([skill("Fare watch"), skill("fare  watch")]) ?? "",
    /you already have a skill called "Fare watch"/);
});

// ---------------------------------------------------------------------------
// Enforced at the HUB, because the screen is not a boundary
// ---------------------------------------------------------------------------

test("B6: the hub refuses a second agent called Scout, in words", async t => {
  const { owner } = await stand(t, "name-agent-dupe.db");
  owner.send({ type: "createAgent", agent: agent() });
  await owner.wait(f => f.type === "agent" && f.agent.name === "Scout");

  await refuses(owner, { type: "createAgent", agent: agent({ name: "scout" }) },
    /you already have an agent called "Scout"/);
  await refuses(owner, { type: "createAgent", agent: agent({ name: "  Scout  " }) },
    /you already have an agent called "Scout"/);
  // a different name still works, so the rule refuses the clash and nothing else
  owner.send({ type: "createAgent", agent: agent({ name: "Runner" }) });
  await owner.wait(f => f.type === "agent" && f.agent.name === "Runner");
});

test("D3/D4/D2: a room name is held to the same rule the agent name always was", async t => {
  const { owner } = await stand(t, "name-channel.db");
  owner.send({ type: "createChannel", name: "goa-trip", memberIds: [], kind: "channel" });
  await owner.wait(f => f.type === "channel" && f.channel.name === "goa-trip");

  // D3 — a second room with the same name
  await refuses(owner, { type: "createChannel", name: "goa-trip", memberIds: [], kind: "channel" },
    /you already have a channel called "goa-trip"/);
  // D4 — 3,000 characters, which used to be accepted in full
  await refuses(owner, { type: "createChannel", name: "x".repeat(3000), memberIds: [], kind: "channel" },
    /too long \(max 64 characters\)/);
  // D2 — six spaces, and the hyphen the screen used to make out of them
  await refuses(owner, { type: "createChannel", name: "      ", memberIds: [], kind: "channel" },
    /a channel needs a name/);
  await refuses(owner, { type: "createChannel", name: "-", memberIds: [], kind: "channel" },
    /at least one letter or number/);
});

test("HIS EXISTING DATA STILL WORKS: two agents already called Scout can both still be saved", async t => {
  const { relay, owner } = await stand(t, "name-legacy.db");
  // written straight into the store, exactly as a database made before the rule
  // existed holds them. This is the case that a careless uniqueness rule would
  // lock him out of for ever.
  const made: AgentDef[] = ["Scout", "Scout"].map((name, i) => ({
    id: `a_legacy${i}`, ownerId: relay.ownerId, name, emoji: "✨",
    persona: "finds villas", provider: "claude", model: "claude-sonnet-5",
    createdAt: Date.now(),
  } as AgentDef));
  for (const a of made) relay.store.saveAgent(a);

  for (const a of made) {
    owner.frames.length = 0;
    owner.send({ type: "updateAgent", agent: { ...a, persona: "finds villas and flights" } });
    const back = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
      f => f.type === "agent" && f.agent.id === a.id);
    assert.equal(back.agent.persona, "finds villas and flights",
      "an agent named before the rule must still be editable");
  }
});

test("renaming an agent onto a name that is taken is refused; onto a free one is not", async t => {
  const { owner } = await stand(t, "name-rename.db");
  owner.send({ type: "createAgent", agent: agent({ name: "Scout" }) });
  const scout = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === "Scout");
  owner.send({ type: "createAgent", agent: agent({ name: "Runner" }) });
  const runner = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.name === "Runner");

  await refuses(owner, { type: "updateAgent", agent: { ...runner.agent, name: "Scout" } },
    /you already have an agent called "Scout"/);
  owner.frames.length = 0;
  owner.send({ type: "updateAgent", agent: { ...runner.agent, name: "Villa-finder" } });
  const renamed = await owner.wait<Extract<ServerFrame, { type: "agent" }>>(
    f => f.type === "agent" && f.agent.id === runner.agent.id);
  assert.equal(renamed.agent.name, "Villa-finder");
  assert.equal(scout.agent.name, "Scout");
});

// ---------------------------------------------------------------------------
// F3 — ordinary file names, and a sentence that describes the real rule
// ---------------------------------------------------------------------------

test("F3: the file names a real person has on their desktop are accepted", () => {
  for (const name of [
    "report(1).pdf",            // what every browser calls a re-downloaded file
    "café-menu.txt",            // an ordinary word
    "photo#3.png",
    "budget,notes.txt",
    "notes'quote.txt",
    "मेरी फ़ाइल.txt",              // his own languages are not "unsafe"
    "site plan.pdf", "Site Plan Final.pdf", "invoice_2026-07.pdf",
    "README", "2026-report.md", "🐙.png",
  ]) {
    assert.equal(isSafeFileName(name), true, `${name} must be accepted`);
  }
});

test("F3: what is genuinely dangerous is still refused", () => {
  for (const name of [
    "../escape.txt", "..\\escape.txt", "a/b.txt", "C:\\evil.txt", "/etc/passwd",
    "CON", "con.md", "NUL", "com9.md", "LPT1", "AUX.txt",
    "evil.md.", "evil.md ", ".hidden", "-rf.txt",
    `nul${String.fromCharCode(0)}.txt`, `bell${String.fromCharCode(7)}.txt`,
    "", "x".repeat(FILE_NAME_MAX + 1),
    'quote".txt', "star*.txt", "pipe|.txt", "why?.txt", "lt<.txt", "gt>.txt", "colon:.txt",
  ]) {
    assert.equal(isSafeFileName(name), false, `${name} must be refused`);
  }
});

test("F3: the sentence describes the rule, because it is BUILT from the rule", () => {
  // the drift that made F3 half a bug: the old sentence said "plain letters,
  // numbers, dots and dashes" while quietly allowing spaces and underscores.
  // Every clause below must correspond to something really enforced.
  assert.match(FILE_NAME_SENTENCE, new RegExp(`${FILE_NAME_MAX} characters`));
  assert.match(FILE_NAME_SENTENCE, /start it with a letter/);
  assert.match(FILE_NAME_SENTENCE, /Windows device/);
  for (const forbidden of ["/", "\\", ":", "*", "?", "\"", "<", ">", "|"]) {
    assert.ok(FILE_NAME_SENTENCE.includes(forbidden),
      `the sentence must name ${forbidden}, because the rule refuses it`);
  }
  // and it must NOT claim a restriction that is not enforced
  assert.doesNotMatch(FILE_NAME_SENTENCE, /plain letters, numbers, dots and dashes/);
});

test("F3: the hub takes an everyday file, and its name survives the download header", async t => {
  const { owner, general } = await stand(t, "name-file.db");
  const data = Buffer.from("hello").toString("base64");
  for (const name of ["report(1).pdf", "café-menu.txt", "मेरी फ़ाइल.txt"]) {
    owner.frames.length = 0;
    owner.send({ type: "uploadAttachment", channelId: general.id, name, dataBase64: data });
    const up = await owner.wait<Extract<ServerFrame, { type: "attachment" }>>(
      f => f.type === "attachment");
    assert.equal(up.attachment.name, name, "stored under the name he gave it");
    // a header is Latin-1: the real name has to travel percent-encoded or the
    // download would throw on the way out, which is the same bug moved
    const header = contentDisposition(name);
    assert.match(header, /filename\*=UTF-8''/);
    assert.equal(decodeURIComponent(header.split("filename*=UTF-8''")[1]), name);
    assert.ok([...header].every(c => (c.codePointAt(0) ?? 0) < 0x100),
      `a header must be Latin-1, got ${header}`);
  }
  // and a dangerous one is still refused, with the sentence the rule generated
  await refuses(owner,
    { type: "uploadAttachment", channelId: general.id, name: "../escape.txt", dataBase64: data },
    /file name isn't allowed/);
});
