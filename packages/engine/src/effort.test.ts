// GAP B — NO CONTROL OVER HOW HARD AN AGENT THINKS.
//
// WHAT WAS WRONG. Both apps Cloud9 drives expose a thinking-time dial, and
// Cloud9 turned neither. Every agent took whatever its app happened to default
// to. On this machine that means a Codex agent on the newest model was thinking
// at `low` — the CLI's own `codex debug models` says so — with no way for the
// owner to say otherwise.
//
// THE FLAGS, MEASURED AGAINST THE INSTALLED APPS ON 2026-08-05, not remembered:
//
//   claude 2.1.222   `--effort <level>`. Given a bad value the CLI names its own
//                    set: "Warning: Unknown --effort value 'banana' — ignoring it
//                    and using the default effort. Valid values: low, medium,
//                    high, xhigh, max." A WARNING, not a refusal — which is
//                    exactly why Cloud9 checks the value itself: a setting the
//                    CLI silently ignores is worse than no setting, because the
//                    owner sees his choice saved and nothing happens.
//
//   codex 0.146.0    NO `--effort` flag exists — `codex exec --help` was read in
//                    full. The dial is `-c model_reasoning_effort=<level>`.
//                    Proved on live turns: `high` ran normally; a nonsense value
//                    came back as a real refusal from the service,
//                    "[ReasoningEffortParam] [reasoning.effort] [invalid…]".
//
// THE FIX AS A CLASS. One owner — `effort.ts` in @cloud9/shared — holds the four
// words the owner reads AND the translation into each app's own vocabulary. No
// call site maps anything. Adding a rung is a row in one table, and a row that
// forgets a harness will not compile.
//
// THESE TESTS FAIL WITHOUT THE CHANGE: before it there was no `effort` field,
// no `--effort` on any line and no `model_reasoning_effort` anywhere.
import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_EFFORT_CHOICES, AgentAbilities, AgentDef, AgentEffort,
  effortLevelFor, effortSupportedBy, isAgentEffort, validateAgentInput,
} from "@cloud9/shared";
import { CLAUDE_EFFORT_LEVELS, claudeArgs } from "./claude-cli.js";
import { codexArgs } from "./codex.js";

const ALL_OFF: AgentAbilities = {
  webSearch: false, files: false, schedules: false, background: false,
};
/** Codex cannot give up its built-ins, so a Codex agent is built with them on. */
const CODEX_READY = {
  webSearch: true, files: true, schedules: true, background: true,
  commands: true, helpers: true,
} as AgentAbilities;

const agent = (extra: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { ...ALL_OFF, webSearch: true }, createdAt: 0, ...extra,
});

// ---------------------------------------------------------------------------
// The words the owner reads
// ---------------------------------------------------------------------------

test("the four choices are plain words, in his order, with no app jargon", () => {
  assert.deepEqual(
    AGENT_EFFORT_CHOICES.map(c => c.id),
    ["quick", "normal", "hard", "hardest"]);
  assert.deepEqual(
    AGENT_EFFORT_CHOICES.map(c => c.label),
    ["Quick", "Normal", "Hard", "Hardest"]);
  // HE IS A NETWORK ENGINEER, NOT A DEVELOPER. Nothing he reads may say
  // "effort", "reasoning", "tokens", "inference" or the apps' own level names —
  // those are what the table below is for.
  const jargon = /effort|reasoning|token|inference|xhigh|\blow\b|\bmedium\b|\bhigh\b/i;
  for (const choice of AGENT_EFFORT_CHOICES) {
    assert.doesNotMatch(choice.label, jargon, `label "${choice.label}"`);
    assert.doesNotMatch(choice.hint, jargon, `hint "${choice.hint}"`);
  }
});

// ---------------------------------------------------------------------------
// The one table
// ---------------------------------------------------------------------------

test("every rung has an answer for both apps, and every answer is one the app takes", () => {
  // Claude's set is the CLI's own, quoted from its warning. Codex's is the
  // intersection of what `codex debug models` says each model accepts — every
  // model there advertises low/medium/high/xhigh, and only the gpt-5.6 family
  // goes above it, which is why "Hardest" is `xhigh` there and `max` on Claude.
  const CODEX_UNIVERSAL = ["low", "medium", "high", "xhigh"];
  for (const choice of AGENT_EFFORT_CHOICES) {
    const claude = effortLevelFor("claude", choice.id);
    const codex = effortLevelFor("codex", choice.id);
    assert.ok(claude, `${choice.id} has no Claude level`);
    assert.ok(codex, `${choice.id} has no Codex level`);
    assert.ok(CLAUDE_EFFORT_LEVELS.includes(claude!),
      `${claude} is not a value claude 2.1.222 accepts`);
    assert.ok(CODEX_UNIVERSAL.includes(codex!),
      `${codex} is not accepted by every Codex model on this machine`);
  }
  assert.equal(effortLevelFor("claude", "hardest"), "max");
  assert.equal(effortLevelFor("codex", "hardest"), "xhigh");
});

test("never chosen, or nonsense, means say nothing — which is today's behaviour", () => {
  for (const bad of [undefined, "", "banana", "max", "low", 3, null, {}]) {
    assert.equal(effortLevelFor("claude", bad), undefined, String(bad));
    assert.equal(effortLevelFor("codex", bad), undefined, String(bad));
  }
  assert.ok(!isAgentEffort("low"), "the app's own words are not his words");
  assert.ok(isAgentEffort("hardest"));
});

test("the stored-API-key route says out loud that it has no dial", () => {
  // The installed Claude Agent SDK's options were read in full: there is no
  // effort field of any kind. Rather than drop the owner's setting quietly, the
  // one owner of the question answers it, so a screen can tell the truth too.
  assert.ok(effortSupportedBy("claude"));
  assert.ok(effortSupportedBy("codex"));
  assert.ok(!effortSupportedBy("sdk"));
  assert.ok(!effortSupportedBy("mock"));
});

// ---------------------------------------------------------------------------
// The command lines
// ---------------------------------------------------------------------------

test("Claude gets --effort with the level the table chose", () => {
  for (const choice of AGENT_EFFORT_CHOICES) {
    const args = claudeArgs(agent(), [], {
      effortLevel: effortLevelFor("claude", choice.id),
    });
    const at = args.indexOf("--effort");
    assert.ok(at >= 0, `${choice.id} never reached the command line`);
    assert.equal(args[at + 1], effortLevelFor("claude", choice.id));
  }
});

test("Codex gets -c model_reasoning_effort, because it has no flag for it", () => {
  for (const choice of AGENT_EFFORT_CHOICES) {
    const args = codexArgs(
      agent({ abilities: CODEX_READY, effort: choice.id as AgentEffort }), "C:\\data\\a1", []);
    const level = effortLevelFor("codex", choice.id);
    assert.ok(args.includes(`model_reasoning_effort=${level}`),
      `${choice.id} never reached the Codex command line`);
    // it is a `-c` override, which is the CLI's own documented way to set one
    assert.equal(args[args.indexOf(`model_reasoning_effort=${level}`) - 1], "-c");
    // and NOT a flag, because there is no such flag on codex exec 0.146.0
    assert.ok(!args.includes("--effort"));
  }
});

test("an agent that was never given a choice puts no dial on either line", () => {
  // THE LOAD-BEARING TEST FOR EVERY AGENT HE ALREADY OWNS. None of them carries
  // this field, so none of them may start thinking harder, slower or dearer
  // because the setting arrived.
  const untouched = agent();
  assert.equal(untouched.effort, undefined);
  assert.ok(!claudeArgs(untouched, []).includes("--effort"));
  assert.ok(!codexArgs(agent({ abilities: CODEX_READY }), "C:\\data\\a1", [])
    .some(a => a.includes("model_reasoning_effort")));
});

test("a level the CLI would only warn about is dropped, not passed on", () => {
  // The CLI's answer to a value it does not know is a warning nobody will read
  // plus the default. Passing it would let a corrupt setting look like it did
  // something. Dropping it lands on exactly today's behaviour.
  const args = claudeArgs(agent(), [], { effortLevel: "banana" });
  assert.ok(!args.includes("--effort"));
  assert.ok(!args.includes("banana"));
});

// ---------------------------------------------------------------------------
// The gate before storage
// ---------------------------------------------------------------------------

test("only the four words may be stored on an agent", () => {
  // The same gate the model id goes through, for the same reason: this ends up
  // as a real argument on two command lines.
  assert.equal(validateAgentInput({ ...agent(), effort: "hardest" }), null);
  assert.equal(validateAgentInput({ ...agent(), effort: undefined }), null);
  assert.equal(validateAgentInput({ ...agent(), effort: "" }), null);
  for (const bad of ["low", "max", "ULTRA", "hard; rm -rf /", 7, true]) {
    assert.match(
      String(validateAgentInput({ ...agent(), effort: bad } as never)),
      /thinking-time/,
      `"${String(bad)}" should have been refused`);
  }
});
