// THE FOUR FINDINGS OF `docs/qa/gap-audit.md`, each pinned by the check that
// would have caught it the day it shipped.
//
// Every test in this file FAILED before the change beside it. The audit did not
// read code and describe it — it ran the engine's own compiled code with a
// stand-in for Claude that wrote down exactly what it was handed, and printed
// the prompt verbatim. These are that probe, turned into checks that run every
// time:
//
//  1. THE TRIGGER IS THROWN AWAY.   `buildAgentPrompt(agent, context)` took the
//     conversation and nothing else, so all three real providers dropped the
//     per-turn instruction. A chat reply, a delegated job and a 6:30am check-in
//     produced prompts that were 3,233 characters and BYTE-FOR-BYTE IDENTICAL.
//  2. THE 20-MESSAGE KEYHOLE.       The window was `slice(-20)`, a default set
//     nowhere, and everything but the name and the words was thrown away.
//  3. NO DOORWAY BACK INTO CLOUD9.  Search exists, is indexed, and the hub
//     answers it today — and no agent could reach it.
//  4. THE TOP RUNG LIES.            `host.ts` never supplied `wholeComputerRoots`
//     or `mcpConfigPath`, while the prompt said "you CAN reach outside files"
//     and "you CAN use connected services".
import test from "node:test";
import assert from "node:assert/strict";
import { AgentAbilities, AgentDef, Message } from "@cloud9/shared";
import { CAPABILITIES, grantedSupply, renderCapabilities } from "./abilities.js";
import { claudeArgs, claudeSupply } from "./claude-cli.js";
import { CONVERSATION_BUDGET, renderConversation } from "./context.js";
import { buildAgentPrompt, promptTurnKind, TurnBrief } from "./provider.js";

const ALL_OFF: AgentAbilities = {
  webSearch: false, files: false, schedules: false, background: false,
};

const agent = (abilities: Partial<AgentAbilities> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Sol", emoji: "🌞", persona: "You research travel",
  abilities: { ...ALL_OFF, ...abilities }, createdAt: 0,
});

const turn = (over: Partial<TurnBrief> = {}): TurnBrief => ({
  context: "Vikas: chit-chat number 32",
  trigger: "chit-chat number 32",
  triggerAuthor: "Vikas",
  kind: "chat",
  ...over,
});

// ===========================================================================
// 1. THE TRIGGER IS THROWN AWAY
// ===========================================================================

test("finding 1: a chat turn, a job and a schedule no longer produce the same prompt", () => {
  // This is the audit's probe, exactly: same agent, same conversation, three
  // kinds of turn. It measured all three prompts as byte-for-byte identical.
  const context = "Vikas: chit-chat number 31\nVikas: chit-chat number 32";
  const chat = buildAgentPrompt(agent(), turn({ context, kind: "chat", trigger: "chit-chat number 32" }));
  const job = buildAgentPrompt(agent(), turn({
    context, kind: "task",
    trigger: "Background task: read report.md and summarise it. Do the work and report the outcome.",
  }));
  const schedule = buildAgentPrompt(agent(), turn({
    context, kind: "schedule",
    trigger: "Scheduled task fired: check the build and post the result",
    triggerAuthor: "schedule",
  }));

  assert.notEqual(chat, job, "a chat reply and a delegated job are the same prompt");
  assert.notEqual(chat, schedule, "a chat reply and a scheduled check-in are the same prompt");
  assert.notEqual(job, schedule, "a delegated job and a scheduled check-in are the same prompt");
});

test("finding 1: every kind of turn carries its own instruction into the prompt", () => {
  // The audit's own three lines. Two of them reached the CLI as "NO".
  const cases: { kind: TurnBrief["kind"]; trigger: string }[] = [
    { kind: "chat", trigger: "chit-chat number 32" },
    { kind: "task", trigger: "Background task: read report.md and summarise it." },
    { kind: "schedule", trigger: "Scheduled task fired: check the build and post the result" },
  ];
  for (const c of cases) {
    // the conversation deliberately does NOT contain the instruction — which is
    // the real case for a job and a schedule, and the whole of the bug
    const prompt = buildAgentPrompt(agent(), turn({
      context: "Vikas: morning\nVikas: any news?", kind: c.kind, trigger: c.trigger,
    }));
    assert.ok(prompt.includes(c.trigger),
      `a ${c.kind} turn reached the harness without its instruction in the prompt`);
  }
});

test("finding 1: a scheduled agent is told the words it was scheduled with", () => {
  // "At 6:30am the agent wakes up, reads the last 20 lines of yesterday's chat
  // and writes a chat message about them." The words "check the build" appeared
  // nowhere in the prompt.
  const prompt = buildAgentPrompt(agent(), turn({
    context: "Vikas: night all", kind: "schedule", triggerAuthor: "schedule",
    trigger: "Scheduled task fired: check the build and post the result",
  }));
  assert.match(prompt, /check the build and post the result/);
  assert.match(prompt, /REPEATING\s+CHECK-IN/i, "it is not told why it woke up");
});

test("finding 1: only a chat turn is told to keep it to 1-4 sentences", () => {
  // "Every turn is told to keep it short… including background jobs and
  // repository work, where that is precisely wrong."
  const short = /1-4 sentences/;
  assert.match(buildAgentPrompt(agent(), turn({ kind: "chat" })), short);
  for (const kind of ["task", "schedule"] as const) {
    assert.doesNotMatch(buildAgentPrompt(agent(), turn({ kind })), short,
      `a ${kind} turn is still being told to keep it to four sentences`);
  }
  assert.doesNotMatch(
    buildAgentPrompt(agent(), turn({ kind: "task", workdir: "C:\\work\\wt" })), short);
});

test("finding 1: a repository turn is told it is standing in a checkout", () => {
  // "A repository turn is never told it is in a worktree, on which branch, or in
  // which repository. The briefing repowork.ts writes for exactly that purpose
  // is dropped on the same line of code."
  const brief = turn({
    kind: "chat", workdir: "C:\\Users\\Vikas\\cloud9-work\\wt",
    trigger: "fix the plural label\n\nYou are on branch agent/sol/plural in vikas53953/cloud9.",
  });
  assert.equal(promptTurnKind(brief), "repo");
  const prompt = buildAgentPrompt(agent(), brief);
  assert.match(prompt, /branch agent\/sol\/plural/);
  assert.match(prompt, /checkout on this computer/);
});

test("finding 1: a prompt cannot be built at all without an instruction", () => {
  // THE CLASS RULE. It is not "remember to pass the trigger" — a turn with no
  // instruction is refused, so a provider added next year cannot drop it.
  for (const trigger of ["", "   "]) {
    assert.throws(() => buildAgentPrompt(agent(), turn({ trigger })), /no instruction/);
  }
});

// ===========================================================================
// 2. THE 20-MESSAGE KEYHOLE
// ===========================================================================

const say = (i: number, text: string, over: Partial<Message> = {}): Message => ({
  id: `m${i}`, channelId: "c1", authorId: "u1", authorName: "Vikas", authorKind: "human",
  text, ts: 1_000 + i, ...over,
});

test("finding 2: 'the file is already on disk' survives thirty-one lines of chit-chat", () => {
  // The audit's reproduction, exactly: the standing instruction as message 1 of
  // 32. The prompt that reached the agent began at message 13.
  const standing = "The file is already on disk at report.md — read it, do not rewrite it";
  const history = [say(1, standing), ...Array.from({ length: 31 }, (_, i) => say(i + 2, `chit-chat number ${i + 2}`))];
  const rendered = renderConversation(history);
  assert.ok(rendered.includes(standing),
    "the standing instruction aged out of the window again");
  assert.ok(rendered.includes("chit-chat number 32"), "the newest message was dropped");
});

test("finding 2: the window is a named budget in characters, not a magic 20", () => {
  assert.equal(typeof CONVERSATION_BUDGET.characters, "number");
  assert.ok(CONVERSATION_BUDGET.characters >= 20_000,
    "the budget is back down to keyhole size");
  // and it is really spent: a conversation past the budget is trimmed from the
  // OLD end, never the new one.
  const long = Array.from({ length: 400 }, (_, i) => say(i, "x".repeat(200)));
  const rendered = renderConversation(long);
  assert.ok(rendered.length <= CONVERSATION_BUDGET.characters + 300,
    `the budget was not enforced (${rendered.length} characters)`);
  assert.ok(rendered.endsWith("x".repeat(200)), "the newest message is not the last line");
});

test("finding 2: a very short room is capped by messages, not by characters", () => {
  const many = Array.from({ length: CONVERSATION_BUDGET.messages + 50 }, (_, i) => say(i, "ok"));
  const lines = renderConversation(many).split("\n");
  assert.equal(lines.length, CONVERSATION_BUDGET.messages);
});

test("finding 2: an attachment is named, where before it vanished entirely", () => {
  // "a message carrying budget-q3.xlsx reached the agent as the words 'here is
  // the spreadsheet' and nothing else."
  const rendered = renderConversation([say(1, "here is the spreadsheet", {
    attachments: [{
      id: "at1", name: "budget-q3.xlsx", size: 4096, storedAs: "x", uploadedBy: "u1", uploadedAt: 0,
    }],
  })]);
  assert.match(rendered, /budget-q3\.xlsx/);
});

test("finding 2: a thread reply reads as a thread reply", () => {
  const rendered = renderConversation([
    say(1, "what should we do about the villa?", { replyCount: 1 }),
    say(2, "book it", { replyTo: "m1", authorName: "Priya" }),
  ]);
  assert.match(rendered, /↳/, "thread structure is still being flattened away");
  assert.match(rendered, /1 reply/);
});

test("finding 2: a single message longer than the whole budget is shown, not dropped", () => {
  const rendered = renderConversation([say(1, "y".repeat(CONVERSATION_BUDGET.characters * 2))]);
  assert.ok(rendered.length > 0, "the only message in the room was dropped");
  assert.match(rendered, /too long to show in full/);
});

// ===========================================================================
// 4. THE TOP RUNG LIES TO THE AGENT
// ===========================================================================
//
// Finding 3 (the search doorway) has its own file — `cloud9tools.test.ts` —
// because the thing being proved there is a boundary, not a sentence.

/** Every row that only means something once the launcher hands something over. */
const SUPPLIED_ROWS = CAPABILITIES.filter(c => c.needsSupply);

test("finding 4: a switch with nothing behind it does NOT tell the agent it can", () => {
  // This is the exact shipped wiring the audit found: `startEngineHost` builds
  // the Claude provider with three settings and no more, so `--add-dir` and
  // `--mcp-config` were never added — and the agent was told, word for word,
  // "You CAN use the connected services your owner set up for you".
  assert.ok(SUPPLIED_ROWS.length >= 2, "the two rows this finding is about have gone missing");
  const topRung = agent({ connections: true, wholeComputer: true, commands: true });
  const prompt = renderCapabilities(topRung, /* the launcher supplied nothing */ {});
  for (const cap of SUPPLIED_ROWS) {
    assert.ok(!prompt.includes(cap.can), `the agent is still told: ${cap.can.slice(0, 40)}…`);
    assert.ok(prompt.includes(cap.onButNothingSupplied!),
      `the agent is not told the truth about "${cap.ability}"`);
  }
});

test("finding 4: the same switch with something behind it DOES tell the agent it can", () => {
  const topRung = agent({ connections: true, wholeComputer: true });
  const prompt = renderCapabilities(topRung, {
    wholeComputerRoots: ["C:\\Users\\Vikas\\Documents"],
    mcpConfigPath: "C:\\Users\\Vikas\\AppData\\cloud9\\mcp.json",
  });
  for (const cap of SUPPLIED_ROWS) assert.ok(prompt.includes(cap.can));
});

test("finding 4: the prompt and the command line are one fact, in both directions", () => {
  // BOTH DIRECTIONS, which is the point. A flag on the line with no sentence in
  // the prompt is the original abilities.ts bug; a sentence with no flag is this
  // one. Neither can happen while they both ask `grantedSupply`.
  const cases: { agent: AgentDef; offered: Parameters<typeof grantedSupply>[1] }[] = [
    { agent: agent({ connections: true, wholeComputer: true }), offered: {} },
    {
      agent: agent({ connections: true, wholeComputer: true }),
      offered: { wholeComputerRoots: ["C:\\work"], mcpConfigPath: "C:\\work\\mcp.json" },
    },
    // offered but NOT switched on: a caller cannot widen an agent with a path
    { agent: agent(), offered: { wholeComputerRoots: ["C:\\work"], mcpConfigPath: "C:\\work\\mcp.json" } },
    // switched on, half supplied
    { agent: agent({ wholeComputer: true, connections: true }), offered: { wholeComputerRoots: ["C:\\work"] } },
  ];
  for (const c of cases) {
    const args = claudeArgs(c.agent, [], c.offered);
    const supply = claudeSupply(c.agent, c.offered);
    const prompt = renderCapabilities(c.agent, supply);
    for (const cap of SUPPLIED_ROWS) {
      const flag = cap.needsSupply === "wholeComputerRoots" ? "--add-dir" : "--mcp-config";
      const onTheLine = args.includes(flag);
      const promised = prompt.includes(cap.can);
      assert.equal(promised, onTheLine,
        `"${cap.ability}": the prompt says ${promised ? "CAN" : "cannot"} and the ` +
        `command line ${onTheLine ? "has" : "has no"} ${flag}`);
    }
  }
});

test("finding 4: a power with nothing behind it is not listed as 'asks first' either", () => {
  const topRung = agent({ connections: true, wholeComputer: true });
  const prompt = renderCapabilities(topRung, {});
  assert.doesNotMatch(prompt, /Some of that asks your owner first/,
    "the agent is told a power asks first when it does not hold that power at all");
});
