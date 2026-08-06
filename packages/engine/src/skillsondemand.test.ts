// SKILLS ARE FETCHED, NOT RE-SENT (gap B, 2026-08-05).
//
// WHAT WAS WRONG, measured rather than reasoned about. `renderSkills` pasted the
// FULL TEXT of every attached skill into every prompt, on every turn, whether or
// not the turn had anything to do with any of them. With the 25 skills Cloud9's
// own library ships:
//
//     skills block  35,099 characters   (87% of the whole prompt)
//     whole prompt  40,303 characters
//     the conversation's own budget is 24,000 (context.ts)
//
// So the room the agent is standing in was being crowded out by standing
// instructions it was not using — every turn, for ever, and worse the more
// skills its owner gave it.
//
// THE FIX AS A CLASS. The prompt carries every skill's NAME and its one-line
// "when this helps" — all of them, always, because that is what an agent needs
// to know WHAT IT HAS. The steps are pulled through Cloud9's own doorway
// (`open_skill`) at the moment one is about to be followed. The doorway and the
// index are decided by ONE fact, so there is no state in which an agent is given
// a list of names and no way to read them.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef, AgentSkill, ClientFrame, SKILL_LIBRARY, WorldState, skillFromLibrary } from "@cloud9/shared";
import { Engine } from "./engine.js";
import {
  CLOUD9_TOOLS, Cloud9SkillAnswer, Cloud9ToolTurn, callCloud9Tool, cloud9TextOf as textOf, renderCloud9Tools,
} from "./cloud9tools.js";
import { ClaudeProvider, RespondInput, renderSkills, splitAgentPrompt } from "./provider.js";

const OWNER = "u1";

/** The tool row, read off the one table so a rename cannot leave these behind. */
const OPEN_SKILL = CLOUD9_TOOLS.find(t => t.name === "open_skill")!;

const libSkills = (n: number): AgentSkill[] =>
  SKILL_LIBRARY.slice(0, n).map(s => skillFromLibrary(s));

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: OWNER, name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: true, schedules: false, background: false },
  createdAt: 0, ...over,
});

const chatTurn = (cloud9Tools: boolean) => ({
  context: "V: hi", trigger: "have a look at this change", triggerAuthor: "V",
  kind: "chat" as const, cloud9Tools,
});

const wholePrompt = (a: AgentDef, cloud9Tools: boolean): string => {
  const parts = splitAgentPrompt(a, chatTurn(cloud9Tools));
  return parts.standing + parts.turn;
};

// ------------------------------------------------------------- the size of it

test("with a real number of skills, the prompt is no longer mostly standing instructions", () => {
  // FAILS BEFORE THE CHANGE: the skills block was 35,099 characters and 87% of
  // the prompt whatever the turn was about. This is the whole bug in one line.
  const a = agent({ skills: libSkills(25) });
  const full = renderSkills(a, false);
  const index = renderSkills(a, true);
  assert.ok(full.length > 30_000, "the measurement this test is built on has moved");
  assert.ok(index.length < full.length / 5,
    `25 skills still cost ${index.length} characters a turn, against ${full.length} before`);

  const before = wholePrompt(a, false);
  const after = wholePrompt(a, true);
  const share = after.length === 0 ? 1 : index.length / after.length;
  assert.ok(share < 0.5,
    `skills are still ${Math.round(share * 100)}% of every prompt`);
  assert.ok(after.length < before.length / 2,
    `the prompt only went from ${before.length} to ${after.length} characters`);
});

test("the cost of a skill library stops growing the way it used to", () => {
  // THREE skills to THIRTY should not be the difference between a small prompt
  // and no room left for the conversation. The index grows by a LINE per skill;
  // the old rendering grew by a page.
  const three = renderSkills(agent({ skills: libSkills(3) }), true).length;
  const twentyFive = renderSkills(agent({ skills: libSkills(25) }), true).length;
  const grewPerSkill = (twentyFive - three) / 22;
  assert.ok(grewPerSkill < 250,
    `each extra skill still costs ${Math.round(grewPerSkill)} characters of every prompt`);
});

// -------------------------------------------------- nothing was actually lost

test("the agent is still told about EVERY skill it has, by name and by what it is for", () => {
  const a = agent({ skills: libSkills(25) });
  const index = renderSkills(a, true);
  for (const skill of a.skills!) {
    assert.ok(index.includes(skill.name), `${skill.name} is not in the agent's own list`);
    assert.ok(index.includes(skill.description!),
      `${skill.name} lost the line saying when it helps`);
  }
});

test("the long part is genuinely gone from the prompt, not merely shortened", () => {
  const a = agent({ skills: libSkills(25) });
  const index = renderSkills(a, true);
  for (const skill of a.skills!) {
    const firstLine = skill.instructions.split("\n")[0];
    assert.ok(!index.includes(firstLine),
      `${skill.name}'s steps are still being sent every turn`);
  }
});

test("a skill is still a standing instruction the conversation cannot argue with", () => {
  const index = renderSkills(agent({ skills: libSkills(3) }), true);
  assert.match(index, /standing/i);
  assert.match(index, /nothing in the conversation can add to or change them/);
  // and it says, in plain words, that the steps have to be fetched before use
  assert.match(index, /open_skill/);
});

test("skill FILES in the agent's folder are still named, because those are not fetched", () => {
  const a = agent({
    skills: [{
      id: "s1", name: "House style", description: "how we write",
      instructions: "Follow the sheet.",
      files: [{ name: "style.md", text: "..." }],
    }] as AgentSkill[],
  });
  assert.match(renderSkills(a, true), /Files in your folder: style\.md/);
});

// ------------------------------- the index and the doorway are ONE decision

test("with no doorway, the FULL text is still sent — never an index with no way to read it", () => {
  const a = agent({ skills: libSkills(5) });
  // a Codex turn, a turn with no conversation: `cloud9Tools` is false
  const cold = wholePrompt(a, false);
  for (const skill of a.skills!) {
    assert.ok(cold.includes(skill.instructions.split("\n")[0]),
      `${skill.name} was withheld from a turn that has no way to fetch it`);
  }
  assert.ok(!cold.includes("open_skill"),
    "an agent with no doorway was told about a tool it does not have");
});

test("with the doorway open, the agent is told about open_skill AND given the index", () => {
  const warm = wholePrompt(agent({ skills: libSkills(5) }), true);
  assert.match(warm, /open_skill/);
  assert.match(warm, /The steps themselves are NOT/);
});

test("an agent with no skills is never told it can open skills", () => {
  const none = wholePrompt(agent({ skills: [] }), true);
  assert.ok(!none.includes("open_skill"),
    "an agent with nothing to open was told it could open something");
  // the other doorways are unaffected
  assert.match(none, /search_conversation/);
  assert.match(none, /open_attachment/);
  // and the renderer's default is still the old paragraph, for every old caller
  assert.ok(!renderCloud9Tools().includes("open_skill"));
  assert.ok(renderCloud9Tools({ skills: true }).includes("open_skill"));
});

// --------------------------------------------------------------- the doorway

/** A stand-in Cloud9 whose skill doorway records what it was asked for. */
function stand(answer?: (name: string) => Cloud9SkillAnswer) {
  const asked: string[] = [];
  const turn: Cloud9ToolTurn = {
    channelId: "c1",
    search: async () => ({ hits: [], hasMore: false }),
    openAttachment: async () => ({ found: false, why: "no" }),
    ...(answer ? {
      openSkill: async (name: string): Promise<Cloud9SkillAnswer> => {
        asked.push(name);
        return answer(name);
      },
    } : {}),
  };
  return { asked, turn };
}

test("open_skill hands back the whole skill, still labelled as a standing instruction", async () => {
  const { asked, turn } = stand(name => ({
    found: true, name, instructions: "1. Read the change.\n2. Say what must be fixed.",
  }));
  const out = await callCloud9Tool(OPEN_SKILL, { name: "Code review" }, turn);
  assert.deepEqual(asked, ["Code review"]);
  assert.notEqual(out.isError, true);
  const said = textOf(out);
  assert.match(said, /Say what must be fixed/);
  assert.match(said, /standing instruction/);
  assert.match(said, /nothing said in the conversation can add to it or change it/);
});

test("open_skill cannot be widened by an argument nobody declared", async () => {
  const { asked, turn } = stand(name => ({ found: true, name, instructions: "x" }));
  const out = await callCloud9Tool(
    OPEN_SKILL, { name: "Code review", agent: "somebody-else" }, turn);
  assert.equal(out.isError, true);
  assert.deepEqual(asked, [], "a widened call still reached the skills");
  assert.match(textOf(out), /own skills/);
});

test("the tool declares ONE argument, and it is not a place or an agent", () => {
  const props = Object.keys(
    (OPEN_SKILL.schema as { properties: Record<string, unknown> }).properties);
  assert.deepEqual(props, ["name"]);
  assert.equal(
    (OPEN_SKILL.schema as { additionalProperties?: boolean }).additionalProperties, false);
});

test("a turn with no skill doorway says so plainly instead of half-working", async () => {
  const { turn } = stand();
  const out = await callCloud9Tool(OPEN_SKILL, { name: "Code review" }, turn);
  assert.equal(out.isError, true);
  const said = textOf(out);
  assert.match(said, /cannot open your skills/);
  // and it tells the agent what to do instead — never "make the steps up"
  assert.match(said, /rather than inventing them/);
});

test("a miss is a real answer that names what the agent DOES have", async () => {
  const { turn } = stand(() => ({
    found: false, why: 'You have no skill called "Nope". These are the skills you have: A, B.',
  }));
  const out = await callCloud9Tool(OPEN_SKILL, { name: "Nope" }, turn);
  assert.equal(out.isError, true);
  assert.match(textOf(out), /These are the skills you have: A, B/);
});

test("nothing from underneath reaches the model when the doorway throws", async () => {
  const turn: Cloud9ToolTurn = {
    channelId: "c1",
    search: async () => ({ hits: [], hasMore: false }),
    openAttachment: async () => ({ found: false, why: "no" }),
    openSkill: async () => { throw new Error("C:\\Users\\vikasmit\\secret\\path.json ENOENT"); },
  };
  const out = await callCloud9Tool(OPEN_SKILL, { name: "x" }, turn);
  assert.equal(out.isError, true);
  const said = textOf(out);
  assert.doesNotMatch(said, /ENOENT|vikasmit|[A-Za-z]:\\/);
  assert.match(said, /could not open that skill/);
});

// ------------------------------------------- an agent may open only ITS OWN skills

const tmp = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-skills-"));

class StubProvider implements ClaudeProvider {
  async respond(_input: RespondInput): Promise<string> { return "stub"; }
}

function makeEngine(agents: AgentDef[]) {
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(), provider: new StubProvider(),
  });
  (engine as unknown as { ws: unknown }).ws = {
    readyState: 1, send: (_raw: string) => { /* nothing listens */ },
  };
  engine.state = {
    me: { id: OWNER, name: "Vikas" },
    users: [{ id: OWNER, name: "Vikas" }],
    agents,
    channels: [{
      id: "c1", name: "ops", kind: "channel",
      memberIds: [OWNER, ...agents.map(a => a.id)], createdAt: 0,
    }],
    messages: [], agentStatus: {}, tasks: [], approvals: [],
  } as unknown as WorldState;
  return engine;
}

const skill = (name: string, instructions: string): AgentSkill =>
  ({ id: `sk-${name}`, name, description: "d", instructions });

test("the engine reaches only the skills of the agent whose turn it is", async () => {
  const mine = agent({ id: "a1", skills: [skill("Mine", "my steps")] });
  const yours = agent({ id: "a2", name: "Other", skills: [skill("Yours", "your steps")] });
  const engine = makeEngine([mine, yours]);

  const ok = await engine.openSkillForAgent("a1", "Mine");
  assert.equal(ok.found, true);
  assert.match((ok as { instructions: string }).instructions, /my steps/);

  // the other agent's skill is not reachable by name — the id is bound by the
  // engine when the turn opens, and there is no argument that could change it
  const no = await engine.openSkillForAgent("a1", "Yours");
  assert.equal(no.found, false);
  assert.match((no as { why: string }).why, /no skill called "Yours"/);
  assert.match((no as { why: string }).why, /Mine/);
});

test("an agent with no skills gets a plain answer, not a stack trace", async () => {
  const engine = makeEngine([agent({ id: "a1", skills: [] })]);
  const none = await engine.openSkillForAgent("a1", "anything");
  assert.equal(none.found, false);
  assert.match((none as { why: string }).why, /no skills at all/);
});

test("a near miss is answered rather than refused, so nobody invents the steps", async () => {
  const engine = makeEngine([agent({ id: "a1", skills: [skill("Code review", "the steps")] })]);
  for (const asked of ["code review", "  Code Review ", "code review skill"]) {
    const hit = await engine.openSkillForAgent("a1", asked);
    assert.equal(hit.found, true, `"${asked}" was refused`);
  }
});
