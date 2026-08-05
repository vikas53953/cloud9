// GAP 2: A SWITCH THE STORED-API-KEY PATH COULD NEVER KEEP.
//
// `SdkProvider` is what runs an agent when the owner has stored an API key
// instead of using the Claude app he is signed in to. It hardcoded `supply: {}`
// and passed no folders — so "Reach files outside its own folder" was
// permanently inert on that path. The agent editor would still read the switch
// and say "In use". Nothing anywhere said otherwise.
//
// He is on the signed-in-app path today, so nothing is lying to him yet. That is
// exactly what makes it a trap rather than a bug: the day he pastes an API key,
// a switch he set and a folder he chose stop working, silently, and the agent's
// own answer ("I cannot reach outside my folder — ask your owner to switch it
// on") is the most confusing possible reply, because he HAS.
//
// THE ANSWER IS TO REFUSE, NOT TO WIRE IT UP, and the reason is in this file's
// first test: the command-line path does not carry `--add-dir` on its own. It
// carries it alongside the three isolation flags that keep the owner's OWN
// Claude Code setup out of his agents. This path has none of them. Widening an
// un-isolated agent to a folder of his choosing — the whole C: drive is an
// offered choice — is not a thing to do by accident.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentAbilities, AgentDef } from "@cloud9/shared";
import {
  AbilityNotSupportedHereError, SdkProvider, sanitizeForChat,
} from "./provider.js";
import { CAPABILITIES, switchesNeedingSupply } from "./abilities.js";

const ALL_OFF: AgentAbilities = {
  webSearch: false, files: false, schedules: false, background: false,
};

const agent = (abilities: Partial<AgentAbilities> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Fable5", emoji: "🧭",
  persona: "You help with the accounts",
  abilities: { ...ALL_OFF, ...abilities } as AgentAbilities,
  createdAt: 0,
});

const turn = (a: AgentDef) => ({
  agent: a, context: "Vikas: hello", trigger: "read the file", triggerAuthor: "Vikas",
  kind: "chat" as const,
});

function sdk(): SdkProvider {
  return new SdkProvider({ apiKey: "sk-not-a-real-key" }, () => "C:\\agents\\a1");
}

// -------------------------------------------------- the refusal

test("gap 2: the stored-API-key path REFUSES 'reach files outside its own folder'", async () => {
  const reaching = agent({ wholeComputer: true } as Partial<AgentAbilities>);
  await assert.rejects(
    () => sdk().respond(turn(reaching)),
    (err: unknown) => {
      assert.ok(err instanceof AbilityNotSupportedHereError,
        "the turn ran anyway, with the switch silently doing nothing");
      return true;
    });
});

test("gap 2: it refuses BEFORE anything runs — no model is called, nothing is spent", async () => {
  // The SDK is imported lazily inside `respond`. A refusal that happened after
  // the import would still have started a billable turn; this one cannot,
  // because the throw is the first statement in the method. Proven by the fact
  // that a deliberately impossible credential never gets as far as being used.
  const reaching = agent({ wholeComputer: true } as Partial<AgentAbilities>);
  const started = Date.now();
  await assert.rejects(() => sdk().respond(turn(reaching)), AbilityNotSupportedHereError);
  assert.ok(Date.now() - started < 2_000, "the refusal waited on something");
});

test("gap 2: the refusal says which switch, and what to do — never a flag name", () => {
  const said = sanitizeForChat(
    new AbilityNotSupportedHereError(["“Reach files outside its own folder”"]), "test");
  assert.match(said, /Reach files outside its own folder/);
  assert.match(said, /sign in to Claude/);
  assert.match(said, /or switch that off/);
  // plain words: no flag, no path, no class name, no jargon
  assert.doesNotMatch(said, /--add-dir|additionalDirectories|SdkProvider|supply|API key is/i);
});

// -------------------------------------------------- the class, not the case

test("it is derived from the capability table, so it covers every such switch", async () => {
  // The trap was FOUND on `wholeComputer`. `connections` had exactly the same
  // shape — a switch that grants nothing until something is supplied — and would
  // have been fixed separately or not at all. Both are covered because neither
  // is named: the rule reads the table.
  const needSupply = CAPABILITIES.filter(c => c.needsSupply).map(c => c.ability);
  assert.ok(needSupply.length >= 2, "the table no longer has the rows this rule is about");
  for (const ability of needSupply) {
    const a = agent({ [ability]: true } as Partial<AgentAbilities>);
    assert.deepEqual(switchesNeedingSupply(a).map(c => c.ability), [ability]);
    await assert.rejects(() => sdk().respond(turn(a)), AbilityNotSupportedHereError,
      `"${ability}" is switched on and this path would have run anyway`);
  }
});

test("a switch this path CAN keep is not refused", () => {
  // The refusal must not become "the SDK path is broken". Everything that is a
  // declared tool works there exactly as before, so nothing is stopped.
  const ordinary = agent({ webSearch: true, files: true, helpers: true } as Partial<AgentAbilities>);
  assert.deepEqual(switchesNeedingSupply(ordinary), []);
});

test("an agent with nothing switched on is not refused either", () => {
  assert.deepEqual(switchesNeedingSupply(agent()), []);
});

// -------------------------------------------------- the approval gate is untouched

test("refusing here does not weaken the gate — those switches still always ask", () => {
  // `wholeComputer` and `connections` both carry `alwaysAsk`. Refusing a turn on
  // one path must not be mistaken for a reason to relax the other side.
  for (const cap of CAPABILITIES.filter(c => c.needsSupply)) {
    assert.equal(cap.alwaysAsk, true,
      `${cap.ability} needs something supplied but no longer asks the owner first`);
  }
});
