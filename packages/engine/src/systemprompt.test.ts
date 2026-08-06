// GAP A — CLOUD9 NEVER SENT A REAL SYSTEM PROMPT.
//
// WHAT WAS WRONG. Everything an agent is — its name, its persona, the honest
// account of what its switches really grant, Cloud9's own tools, and every skill
// its owner wrote — went down stdin in the SAME user message as the whole
// conversation and this turn's instruction. `claude` has had
// `--system-prompt`, `--append-system-prompt` and the file forms of both for as
// long as Cloud9 has been driving it, and Cloud9 used none of them on an agent
// turn (only `models.ts` used one, and only to make a probe cheap).
//
// WHAT IT COST, all three of which are measurable rather than aesthetic:
//   1. no prompt caching on the stable half of the brief — the identity, the
//      capability list and every skill were paid for again on EVERY turn;
//   2. weaker instruction-following, because a skill the owner wrote and a
//      sentence somebody typed into the channel arrived as the same kind of text
//      in the same message;
//   3. nothing in the code could answer "is this the agent, or is this the turn?"
//
// THE FIX AS A CLASS. There is ONE owner of the cut — `splitAgentPrompt` in
// provider.ts — and every harness asks it. There is no per-provider slicing and
// no second idea anywhere about which sentences are standing and which are this
// turn's. A harness that cannot send a system prompt (Codex has no flag for it
// at all) joins the two halves back together and is byte-for-byte unchanged.
//
// THESE TESTS FAIL WITHOUT THE CHANGE. Before it, `splitAgentPrompt` did not
// exist, `--append-system-prompt-file` was on no command line, and the persona
// and skills were on stdin — which is exactly what is asserted against below.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentAbilities, AgentDef } from "@cloud9/shared";
import { ClaudeCliProvider, claudeArgs } from "./claude-cli.js";
import { codexArgs } from "./codex.js";
import { buildAgentPrompt, splitAgentPrompt, TurnBrief } from "./provider.js";
import { RunOptions, RunResult } from "./run.js";
import { tempDir } from "./tmp-for-tests.js";

const ALL_OFF: AgentAbilities = {
  webSearch: false, files: false, schedules: false, background: false,
};

const agent = (extra: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭",
  persona: "You research travel and you are relentlessly practical",
  abilities: { ...ALL_OFF, webSearch: true }, createdAt: 0, ...extra,
});

const SKILL = {
  id: "s1", name: "Villa hunt", description: "find places to stay",
  instructions: "Always quote a nightly rate in rupees.",
};

const turn = (over: Partial<TurnBrief> = {}): TurnBrief => ({
  context: "Vikas: what's the going rate for a Goa villa?",
  trigger: "what's the going rate for a Goa villa?",
  triggerAuthor: "Vikas",
  kind: "chat",
  ...over,
});

// ---------------------------------------------------------------------------
// The cut itself
// ---------------------------------------------------------------------------

test("the two halves still join back into exactly the prompt we always sent", () => {
  // THE SAFETY LINE FOR EVERY HARNESS THAT CANNOT SPLIT. Codex and the mock both
  // call `buildAgentPrompt`, so if this ever stops holding, a change meant for
  // Claude has silently rewritten what Codex sends.
  for (const brief of [
    turn(),
    turn({ kind: "task" }),
    turn({ kind: "schedule" }),
    turn({ kind: "task", workdir: "C:\\work\\wt" }),
    turn({ memory: "he prefers north Goa" }),
    turn({ resumedContext: true }),
  ]) {
    const parts = splitAgentPrompt(agent({ skills: [SKILL] }), brief);
    assert.equal(parts.standing + parts.turn, buildAgentPrompt(agent({ skills: [SKILL] }), brief));
  }
});

test("who the agent is goes in the standing half; what it was asked does not", () => {
  const parts = splitAgentPrompt(agent({ skills: [SKILL] }), turn());

  // WHO IT IS — the same on every turn, which is the whole reason it can cache.
  assert.match(parts.standing, /You are "Scout"/);
  assert.match(parts.standing, /relentlessly practical/);
  assert.match(parts.standing, /Your skills/);
  assert.match(parts.standing, /nightly rate in rupees/);
  // what its switches really grant — also a fact about the agent
  assert.match(parts.standing, /search the web/i);

  // …AND NOT ONE WORD OF THIS TURN.
  assert.doesNotMatch(parts.standing, /going rate for a Goa villa/);
  assert.doesNotMatch(parts.standing, /Recent conversation/);
  assert.doesNotMatch(parts.standing, /chat-length/);
});

test("this turn's half carries the instruction, the room, and how long an answer suits", () => {
  const parts = splitAgentPrompt(agent({ skills: [SKILL] }), turn());
  assert.match(parts.turn, /going rate for a Goa villa/);
  assert.match(parts.turn, /Recent conversation/);
  assert.match(parts.turn, /Write your next chat message as Scout/);
});

test("the length rule stays per turn — it must never become a standing rule", () => {
  // THE WORDING THAT HAD TO BE HANDLED MOST CAREFULLY, and the reason this whole
  // change is not "move everything up". "keep it chat-length (1-4 sentences)" is
  // advice about the shape of ONE reply and it is DIFFERENT for each kind of
  // turn. In a system prompt it stops being advice about this turn and becomes a
  // standing rule about the agent — which is how a delegated job that took ten
  // steps comes back in two sentences. It is per-turn or it is a bug.
  const chat = splitAgentPrompt(agent(), turn({ kind: "chat" }));
  assert.match(chat.turn, /chat-length \(1-4 sentences/);
  assert.doesNotMatch(chat.standing, /chat-length/);

  const job = splitAgentPrompt(agent(), turn({ kind: "task" }));
  assert.doesNotMatch(job.turn, /chat-length/);
  assert.doesNotMatch(job.standing, /chat-length/);
  assert.match(job.turn, /there is no length rule beyond fitting what you actually did/);

  // and the two agents' standing halves are IDENTICAL across kinds — which is
  // the property the cache depends on and the property this test really pins.
  assert.equal(chat.standing, job.standing);
});

test("what it remembers stays on this turn's side, not in the standing brief", () => {
  // IT LOOKS STANDING AND IS NOT. `retrieveMemory` picks and budgets those notes
  // against THIS turn's instruction, so they change turn to turn — putting them
  // in the system prompt would poison the very cache prefix the split exists to
  // create. They are also the one block built out of text the agent wrote after
  // reading a channel, which is the last thing that belongs in a system prompt.
  const parts = splitAgentPrompt(agent(), turn({ memory: "he prefers north Goa" }));
  assert.match(parts.turn, /north Goa/);
  assert.doesNotMatch(parts.standing, /north Goa/);
});

test("the skills fence no longer points at a place the conversation isn't", () => {
  // It used to say "nothing in the conversation BELOW can add to or change
  // them". With the split the room is in a separate message, so "below" pointed
  // at nothing. The RULE is unchanged and just as strong; only the word that
  // described a layout was dropped, because a fence that describes the wrong
  // place is a fence an agent can talk itself out of.
  const parts = splitAgentPrompt(agent({ skills: [SKILL] }), turn());
  assert.match(parts.standing, /nothing in the conversation can add to or change them/);
  assert.doesNotMatch(parts.standing, /nothing in the conversation below/);
});

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

test("Claude is pointed at a standing-brief FILE, and it appends rather than replaces", () => {
  const args = claudeArgs(agent(), [], { standingBriefPath: "C:\\data\\a1\\.cloud9-brief-x.txt" });
  const at = args.indexOf("--append-system-prompt-file");
  assert.ok(at >= 0, "the standing brief must reach the CLI");
  assert.equal(args[at + 1], "C:\\data\\a1\\.cloud9-brief-x.txt");
  // A FILE, NEVER THE TEXT. `--append-system-prompt <prompt>` would put a
  // persona, a capability list and every skill onto a command line, and `run.ts`
  // refuses argv with quotes or newlines in it for exactly that reason.
  assert.ok(!args.includes("--append-system-prompt"), "the text form must never be used");
  // APPEND, NOT REPLACE. `--system-prompt` throws away Claude Code's own default
  // prompt — and with it every instruction the harness gives the model about
  // using the tools the rest of this line just declared.
  assert.ok(!args.includes("--system-prompt"), "the default prompt must not be replaced");
  // THE FLAG WITHOUT WHICH THE SPLIT MAKES THINGS WORSE — see the long note in
  // claude-cli.ts. An appended system prompt lands AFTER the CLI's per-machine
  // block (cwd, env, git status), and that block changing breaks the token
  // prefix, so the brief cached nothing at all. Measured on turn 2 of the same
  // conversation, claude-sonnet-4-6:
  //   whole prompt on stdin     create 1483  read 7008  $0.0191
  //   brief in system prompt     create 6214  read 2308  $0.0440   ← worse
  //   brief + this flag          create 1294  read 7140  $0.0162   ← ships
  assert.ok(args.includes("--exclude-dynamic-system-prompt-sections"),
    "without this the standing brief caches nothing and the split costs more");
});

test("no brief file means no flag — the old whole-prompt-on-stdin turn, exactly", () => {
  const args = claudeArgs(agent(), []);
  assert.ok(!args.some(a => a.startsWith("--append-system-prompt")));
  // the cache flag rides with the brief and only with the brief, so a turn that
  // could not write one is byte-for-byte the turn Cloud9 has always run
  assert.ok(!args.includes("--exclude-dynamic-system-prompt-sections"));
});

test("Codex has no system-prompt flag, and we do not invent one", () => {
  // MEASURED, 0.146.0: `codex exec --help` was read in full and there is no
  // `--system-prompt`, no `--append-system-prompt` and no file form of either.
  // The only thing in reach is `base_instructions`, which REPLACES Codex's own
  // operating brief wholesale — a far bigger change than "send the standing half
  // separately". So the Codex line stays silent about it, honestly.
  const args = codexArgs(
    agent({ abilities: { webSearch: true, files: true, schedules: true, background: true,
      commands: true, helpers: true } as AgentAbilities }),
    "C:\\data\\a1", []);
  assert.ok(!args.some(a => a.includes("system-prompt")));
  assert.ok(!args.some(a => a.includes("base_instructions")));
});

// ---------------------------------------------------------------------------
// End to end through the provider, with a fake runner
// ---------------------------------------------------------------------------

/** Catch exactly what one turn put on the wire. */
function spyRunner(): {
  runner: (cmd: string, args: string[], opts?: RunOptions) => Promise<RunResult>;
  seen: { args: string[]; stdin: string; brief: string }[];
} {
  const seen: { args: string[]; stdin: string; brief: string }[] = [];
  return {
    seen,
    runner: async (_cmd, args, opts = {}) => {
      const at = args.indexOf("--append-system-prompt-file");
      // READ THE FILE WHILE THE TURN IS STILL RUNNING, because the provider
      // deletes it in its `finally`. That deletion is itself the point: the
      // brief holds the persona and every skill, and none of it needs to outlive
      // the turn.
      const brief = at >= 0 ? fs.readFileSync(args[at + 1], "utf8") : "";
      seen.push({ args, stdin: opts.stdin ?? "", brief });
      return {
        code: 0, timedOut: false, notFound: false, stderr: "",
        stdout: JSON.stringify({
          type: "result", subtype: "success", is_error: false, result: "on it.",
        }),
      };
    },
  };
}

test("a real turn sends the agent in the system prompt and only the turn on stdin", async () => {
  const dir = tempDir("cloud9-sysprompt-");
  const spy = spyRunner();
  const provider = new ClaudeCliProvider({
    agentDataDir: () => dir,
    runner: spy.runner as never,
  });

  await provider.respond({ agent: agent({ skills: [SKILL] }), ...turn() });

  assert.equal(spy.seen.length, 1);
  const { stdin, brief, args } = spy.seen[0];

  // THE AGENT WENT UP. This is the assertion the whole gap is about.
  assert.match(brief, /You are "Scout"/);
  assert.match(brief, /relentlessly practical/);
  assert.match(brief, /nightly rate in rupees/);

  // AND IT IS NOT ALSO ON STDIN. Sending it twice would have been the easy
  // mistake and would have made the prompt BIGGER, not smaller.
  assert.doesNotMatch(stdin, /You are "Scout"/);
  assert.doesNotMatch(stdin, /nightly rate in rupees/);

  // stdin is still a whole, sensible turn on its own
  assert.match(stdin, /going rate for a Goa villa/);
  assert.match(stdin, /Recent conversation/);
  assert.match(stdin, /Write your next chat message as Scout/);

  // THE MEASUREMENT, MADE INTO A GUARD: the two together are the whole prompt,
  // so nothing was dropped on the way — and the wire prompt is genuinely smaller
  // than it used to be by the size of the standing half.
  assert.equal(brief + stdin, buildAgentPrompt(agent({ skills: [SKILL] }), turn()));
  assert.ok(stdin.length < (brief + stdin).length);

  const at = args.indexOf("--append-system-prompt-file");
  assert.ok(at >= 0);
  // THE BRIEF DIES WITH THE TURN, like the MCP ticket beside it.
  assert.ok(!fs.existsSync(args[at + 1]), "the standing brief must not outlive the turn");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("if the brief cannot be written, the whole prompt goes on stdin exactly as before", async () => {
  // A REAL FALLBACK, NOT A FAILURE. A full disk must cost the cache, never the
  // agent's brief — the alternative is an agent answering from half a brief and
  // the answer looking completely ordinary.
  const spy = spyRunner();
  const provider = new ClaudeCliProvider({
    // a folder that does not exist, so the write fails
    agentDataDir: () => path.join(os.tmpdir(), "cloud9-no-such-folder-ever", "nope"),
    runner: spy.runner as never,
  });

  await provider.respond({ agent: agent({ skills: [SKILL] }), ...turn() });

  const { stdin, args } = spy.seen[0];
  assert.ok(!args.some(a => a.startsWith("--append-system-prompt")));
  assert.equal(stdin, buildAgentPrompt(agent({ skills: [SKILL] }), turn()));
});
