// An agent must not be able to lie to its owner about itself.
//
// The bug: Vikas asked a Sonnet agent what it could do and it answered "Can't
// do: browse the internet, check live prices/availability…" — while webSearch
// was ON and the CLI had genuinely been handed WebSearch and WebFetch. The
// prompt never mentioned abilities, so the agent answered from the model's idea
// of a chatbot rather than from its actual permissions.
//
// These tests do not check for a sentence. They check the INVARIANT that makes
// the sentence impossible to forget: the tool list and the words come from one
// table, so switching an ability changes both or neither.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentAbilities, AgentDef } from "@cloud9/shared";
import {
  CAPABILITIES, claudeToolsFor, codexSandboxFor, NEVER_ALLOWED_TOOLS, renderCapabilities,
} from "./abilities.js";
import { claudeArgs, ClaudeCliProvider, traceClaude } from "./claude-cli.js";
import { codexArgs } from "./codex.js";
import { buildAgentPrompt } from "./provider.js";
import { RunOptions, RunResult } from "./run.js";
import { buildRunRecord, summarizeRun } from "./runrecord.js";

const ALL_OFF: AgentAbilities = {
  webSearch: false, files: false, schedules: false, background: false,
};

const agent = (abilities: Partial<AgentAbilities> = {}, over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { ...ALL_OFF, ...abilities }, createdAt: 0, ...over,
});

// ------------------------------------------- the invariant: one source, two faces

test("switching an ability changes BOTH the tools and the words, or neither", () => {
  for (const cap of CAPABILITIES) {
    const on = agent({ [cap.ability]: true });
    const off = agent();

    const promptOn = buildAgentPrompt(on, "");
    const promptOff = buildAgentPrompt(off, "");
    assert.ok(promptOn.includes(cap.can), `"${cap.ability}" on: the agent is not told it CAN`);
    assert.ok(!promptOn.includes(cap.cannot), `"${cap.ability}" on: the agent is still told it CANNOT`);
    assert.ok(promptOff.includes(cap.cannot), `"${cap.ability}" off: the agent is not told it CANNOT`);
    assert.ok(!promptOff.includes(cap.can), `"${cap.ability}" off: the agent is told it CAN anyway`);

    const argsOn = claudeArgs(on).join(" ");
    const argsOff = claudeArgs(off).join(" ");
    for (const tool of cap.claudeTools) {
      assert.ok(argsOn.includes(tool), `"${cap.ability}" on: ${tool} was not granted`);
      assert.ok(!argsOff.includes(tool),
        `"${cap.ability}" off: ${tool} was granted to an agent that is not told it has it`);
    }
  }
});

test("no tool can reach a command line that the prompt does not account for", () => {
  const everything = agent({ webSearch: true, files: true, schedules: true, background: true });
  const granted = claudeToolsFor(everything);
  const fromTable = CAPABILITIES.flatMap(c => c.claudeTools);
  assert.deepEqual(granted, fromTable, "the granted list IS the table, not a copy of it");
  // and the args carry exactly those, plus the always-refused list
  const args = claudeArgs(everything);
  for (const tool of granted) assert.ok(args.includes(tool));
  for (const never of NEVER_ALLOWED_TOOLS) {
    assert.ok(args.includes(never), "the refused list is spelled out on the command line");
    assert.ok(!granted.includes(never), "and is never in the granted list");
  }
});

test("the Codex sandbox comes from the same table as the words", () => {
  assert.equal(codexSandboxFor(agent()), "read-only");
  assert.equal(codexSandboxFor(agent({ files: true })), "workspace-write");
  assert.ok(codexArgs(agent(), "C:/data/a1").includes("read-only"));
  assert.ok(codexArgs(agent({ files: true }), "C:/data/a1").includes("workspace-write"));
  // and the same switch is what changed the sentence
  assert.ok(buildAgentPrompt(agent({ files: true }), "").includes("read, write and search files"));
  assert.ok(!buildAgentPrompt(agent(), "").includes("read, write and search files"));
});

// ------------------------------------------------------------- the actual bug

test("an agent with web search on is never told it cannot browse the internet", () => {
  const prompt = buildAgentPrompt(agent({ webSearch: true }), "");
  assert.match(prompt, /You CAN search the web and open web pages/);
  assert.ok(!prompt.includes("You CANNOT search the web"),
    "the exact answer Vikas was given must not be derivable from this prompt");
});

test("an ability that is off is stated as off, never left to guess", () => {
  const prompt = buildAgentPrompt(agent(), "");
  for (const cap of CAPABILITIES) assert.ok(prompt.includes(cap.cannot), `${cap.ability} is silent`);
});

test("the limits every agent has are always stated, whatever the switches say", () => {
  for (const abilities of [ALL_OFF, { webSearch: true, files: true, schedules: true, background: true }]) {
    const prompt = buildAgentPrompt(agent(abilities), "");
    assert.match(prompt, /CANNOT run commands, shell scripts or terminal programs/);
    assert.match(prompt, /no tools at all beyond the ones listed above/);
    assert.match(prompt, /do not remember past conversations/i);
  }
});

test("memory is described honestly, and differently, depending on the files switch", () => {
  assert.match(renderCapabilities(agent({ files: true })), /plus whatever you have written into your own folder/);
  assert.match(renderCapabilities(agent()), /Do not claim to remember things you cannot/);
});

test("skills are named as the owner's standing instructions, only when there are any", () => {
  const withSkill = agent({}, {
    skills: [{
      id: "sk1", name: "Villa hunting", description: "finding places to stay",
      instructions: "always check the cancellation policy",
    }],
  });
  assert.match(renderCapabilities(withSkill), /standing instructions your owner wrote for you/);
  assert.ok(!renderCapabilities(agent()).includes("standing instructions"));
});

// --------------------------------------------- the loop closes, end to end

test("told it can search → searches → the record shows it searched", async () => {
  const scout = agent({ webSearch: true });

  // 1. it is told
  const prompt = buildAgentPrompt(scout, "Vikas: what's the going rate for a Goa villa?");
  assert.match(prompt, /You CAN search the web/);

  // 2. it is given the tools to do it
  assert.deepEqual(claudeToolsFor(scout), ["WebSearch", "WebFetch"]);

  // 3. it searches, and the CLI's own stream says so
  const stream = [
    `{"type":"system","subtype":"init","session_id":"s1"}`,
    `{"type":"assistant","message":{"model":"claude-sonnet-5","content":[{"type":"tool_use","id":"t1","name":"WebSearch","input":{"query":"goa villa nightly rate"}}]}}`,
    `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"…","is_error":false}]}}`,
    `{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t2","name":"WebFetch","input":{"url":"https://example.com/goa"}}]}}`,
    `{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t2","content":"…","is_error":false}]}}`,
    `{"type":"assistant","message":{"content":[{"type":"text","text":"About 6–8k a night in season."}]}}`,
    `{"type":"result","subtype":"success","is_error":false,"result":"About 6–8k a night in season.","duration_ms":9000,"num_turns":3,"total_cost_usd":0.12}`,
  ].join("\n");

  let seenPrompt = "";
  const runner = async (_cmd: string, _args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    seenPrompt = opts.stdin ?? "";
    return { code: 0, stdout: stream, stderr: "", timedOut: false, notFound: false };
  };
  let trace;
  const text = await new ClaudeCliProvider({ agentDataDir: () => process.cwd(), runner })
    .respond({
      agent: scout, context: "Vikas: what's the going rate for a Goa villa?",
      trigger: "what's the going rate?", triggerAuthor: "Vikas",
      onTrace: t => { trace = t; },
    });

  assert.equal(text, "About 6–8k a night in season.");
  assert.match(seenPrompt, /You CAN search the web/, "the prompt that actually ran carried the truth");

  // 4. the record proves it
  const record = buildRunRecord({
    kind: "chat", agentId: scout.id, agentName: scout.name, provider: "claude",
    requestedBy: "Vikas", requestedByKind: "human", ask: "what's the going rate?",
    startedAt: 0,
  }, { finishedAt: 9_000, outcome: "ok", trace, reply: text });

  assert.deepEqual(record.steps.filter(s => s.kind === "web").map(s => s.label),
    ["Searched the web", "Read a web page"]);
  assert.equal(summarizeRun(record), "Checked 2 sites, took 9 seconds, cost 12 cents.");
});

test("an agent NOT given web search cannot produce a web step, and is told so", () => {
  const homebody = agent();
  assert.deepEqual(claudeToolsFor(homebody), []);
  assert.match(buildAgentPrompt(homebody, ""), /You CANNOT search the web or open web pages/);
  const args = claudeArgs(homebody);
  assert.ok(!args.includes("--allowed-tools"), "an agent with no abilities is granted no tools at all");
  assert.ok(!traceClaude(`{"type":"result","result":"done"}`).steps.some(s => s.kind === "web"));
});
