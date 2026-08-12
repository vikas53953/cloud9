// ============================================================================
// "MY ENGINE ISN'T CONNECTED" — WHAT IT SAYS, AND WHAT IT PROVES ABOUT STOP.
// ============================================================================
//
// 2026-08-12, installed blockers 3 and 4. The installed walk reported two
// things and both diagnoses were wrong:
//
//   · "an agent shown a picture answers from what is inside it" failed with
//     "it never said what is actually in the picture";
//   · "stopping a real running turn really stops it" failed with "no Stop
//     control ever appeared".
//
// The agent had in fact answered "my engine isn't connected". No model had ever
// been shown the bytes, and no child process had ever been started for a Stop
// button to sit over. Two working features looked broken because of one machine
// whose harness was not attached.
//
// This file pins BOTH halves of that so it cannot be re-diagnosed from scratch:
//
//   1. THE REFUSAL TELLS THE TRUTH. One sentence used to cover four different
//      situations — always "open Settings and sign in", including on a computer
//      with no Claude app on it at all, and on one where Claude is installed
//      and signed in but the sign-in probe has not answered yet. `AGENTS.md`
//      requires a refusal to say why AND how to enable the thing; one sentence
//      cannot do that for four situations.
//   2. A REFUSED TURN IS NEVER STOPPABLE. The engine opens the handle a stop
//      kills only AFTER it has a provider, so on a machine with no harness
//      there is genuinely nothing for a Stop control to appear over. That makes
//      "no Stop button" a consequence of the refusal, not a Stop defect — and
//      the paired test below shows the same engine DOES become stoppable the
//      moment a provider exists, so this is a discrimination, not an excuse.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentDef, HarnessInfo, Message, WorldState } from "@cloud9/shared";
import { Engine } from "./engine.js";
import { detectClaude, detectCodex } from "./harness.js";
import { RunResult } from "./run.js";
import {
  ClaudeProvider, HARNESS_DISCONNECTED_REPLY, harnessDisconnectedReply, HarnessReadiness,
  RespondInput,
} from "./provider.js";
import { tempDir } from "./tmp-for-tests.js";

const tmp = (): string => tempDir("cloud9-notconnected-");

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
  createdAt: 0, ...over,
});

const trigger: Message = {
  id: "m1", channelId: "c1", authorId: "u1", authorName: "Vikas",
  authorKind: "human", text: "what colour is this picture", ts: 0,
};

// --------------------------------------------- 1. the refusal tells the truth

test("with nothing known about this computer, the refusal is the old generic one", () => {
  assert.equal(harnessDisconnectedReply("claude"), HARNESS_DISCONNECTED_REPLY);
});

test("before this computer has been looked at, it says so — it does not accuse him of being signed out", () => {
  const said = harnessDisconnectedReply("claude", {
    installed: false, signedIn: false, detected: false,
  });
  assert.match(said, /still looking/i);
  assert.ok(!/sign in/i.test(said),
    "nothing has been checked yet, so telling him to sign in would be a guess");
});

test("with no Claude app on the computer, it says to install it — not to sign in to nothing", () => {
  const said = harnessDisconnectedReply("claude", {
    installed: false, signedIn: false, detected: true,
  });
  assert.match(said, /isn't on this computer/i);
  assert.match(said, /install/i,
    "the way to enable it is to install the app; 'open Settings and sign in' sends him to a " +
    "button for an app he does not have");
});

test("when the app is here but has not said whether it is signed in, it says exactly that", () => {
  const said = harnessDisconnectedReply("claude", {
    installed: true, signedIn: false, unsure: true, detected: true,
  });
  assert.match(said, /on this computer/i);
  assert.match(said, /hasn't said whether it is signed in|asking again/i);
  assert.ok(!/^my engine isn't connected — open Settings/.test(said),
    "THE 2026-08-05 BUG, ONE SURFACE OVER: `claude auth status` took 77 seconds on this " +
    "machine, and answering a slow probe with 'you are signed out' told him to fix something " +
    "that was not broken");
});

test("when the app is here and genuinely signed out, it says so and says where to go", () => {
  const said = harnessDisconnectedReply("claude", {
    installed: true, signedIn: false, detected: true,
  });
  assert.match(said, /isn't signed in/i);
  assert.match(said, /Settings/);
});

test("a Codex agent is told about Codex, never about Claude", () => {
  const said = harnessDisconnectedReply("codex", {
    installed: false, signedIn: false, detected: true,
  });
  assert.match(said, /Codex/);
  assert.ok(!/Claude/.test(said), "the agent's own harness is the one it talks about");
});

test("every refusal is still a refusal, and none of them leaks anything", () => {
  const situations = [
    undefined,
    { installed: false, signedIn: false, detected: false },
    { installed: false, signedIn: false, detected: true },
    { installed: true, signedIn: false, unsure: true, detected: true },
    { installed: true, signedIn: false, detected: true },
    { installed: true, signedIn: true, detected: true },
  ];
  for (const state of situations) {
    for (const harness of ["claude", "codex"]) {
      const said = harnessDisconnectedReply(harness, state);
      assert.match(said, /engine isn't connected/i,
        "it never stops being a refusal — nothing here makes an agent answer anyway");
      assert.match(said, /ask me again|Settings|moment/i, "and it always says what to do next");
      // the same law as `sanitizeForChat`: a chat message is read by everyone in
      // the channel, so no path, no argv, no account, no error code
      for (const leak of ["@", "C:\\", "/Users/", "auth.json", "--", "Error", "code "]) {
        assert.ok(!said.includes(leak), `the refusal leaked ${leak}: ${said}`);
      }
      assert.ok(!/error|exception|stack/i.test(said), `developer jargon in: ${said}`);
    }
  }
});

// ============================================================================
// 1b. THE STATES DETECTION CAN REALLY PRODUCE — not the ones I imagined.
// ============================================================================
//
// The sweep above feeds HAND-WRITTEN readiness objects, and that is exactly how
// the first version of this shipped a lie: `detectClaude` returns
// `installed:false` when `claude --version` runs out of patience — an ABSENCE
// of an answer, not an answer — and no hand-written case in this file had that
// shape, so nothing caught the refusal telling him to install an app he already
// had. A test that invents its own inputs can only ever agree with whoever
// invented them.
//
// So these drive the REAL `detectClaude` / `detectCodex` with a stubbed command
// runner, convert their output the same way `host.ts` does, and ask what the
// room would actually be told.

const TIMED_OUT: RunResult =
  { code: null, stdout: "", stderr: "", timedOut: true, notFound: false };
const NOT_FOUND: RunResult =
  { code: null, stdout: "", stderr: "", timedOut: false, notFound: true };
const VERSION_OK: RunResult =
  { code: 0, stdout: "2.1.226 (Claude Code)", stderr: "", timedOut: false, notFound: false };

/**
 * The SAME conversion `host.ts` performs, kept in one line here so this test
 * cannot quietly disagree with the app about what a detection means.
 */
const readinessOf = (info: HarnessInfo): HarnessReadiness => ({
  installed: info.installed,
  signedIn: info.signedIn,
  unsure: info.unsure === true,
  detected: true,
});

test("A PROBE THAT NEVER ANSWERED IS NOT 'you have not installed it'", async () => {
  // `claude --version` runs out of patience: a process was started and said
  // nothing. Nothing is proved about presence in either direction.
  const info = await detectClaude(async () => TIMED_OUT, "claude", 10);
  assert.equal(info.unsure, true,
    "an unanswered probe is the same fact whichever probe it was — the sign-in probe has " +
    "always flagged it, and the version probe left it unset, which is what let the lie out");

  const said = harnessDisconnectedReply("claude", readinessOf(info));
  assert.ok(!/isn't on this computer/i.test(said),
    `A FALSE CLAIM ABOUT HIS OWN COMPUTER: detection's own words are "${info.detail}", and ` +
    `the room was told "${said}"`);
  assert.ok(!/\bInstall it\b/.test(said),
    "this is the 2026-08-05 report in the agent's voice — being sent to install an app he has");
  assert.match(said, /hasn't answered yet|asking again/i);
});

test("…and Codex behaves identically, because it is the same fact", async () => {
  const info = await detectCodex(async () => TIMED_OUT, "codex", 10);
  assert.equal(info.unsure, true, "the two harnesses must not drift on what a timeout means");
  const said = harnessDisconnectedReply("codex", readinessOf(info));
  assert.ok(!/isn't on this computer/i.test(said), `the room was told "${said}"`);
  assert.match(said, /Codex/);
});

test("a command that genuinely is not there IS reported as not installed", async () => {
  // The discrimination that keeps the fix honest: `notFound` is a real answer,
  // and softening it too would leave a person with no app and no idea why.
  const info = await detectClaude(async () => NOT_FOUND, "claude", 10);
  assert.equal(info.installed, false);
  assert.notEqual(info.unsure, true, "'the shell could not find it' IS an answer");
  const said = harnessDisconnectedReply("claude", readinessOf(info));
  assert.match(said, /isn't on this computer/i);
  assert.match(said, /Install it/);
});

test("installed but the sign-in probe gave up: still not accused of being signed out", async () => {
  const info = await detectClaude(async (_cmd: string, args: string[]) =>
    (args[0] === "--version" ? VERSION_OK : TIMED_OUT), "claude", 10);
  assert.equal(info.installed, true);
  assert.equal(info.unsure, true);
  const said = harnessDisconnectedReply("claude", readinessOf(info));
  assert.match(said, /hasn't said whether it is signed in/i);
  assert.ok(!/isn't signed in/.test(said), "an unanswered probe is not a signed-out account");
});

test("every state real detection can produce is still a refusal, and never a false claim", async () => {
  const runs: [string, (c: string, a: string[]) => Promise<RunResult>][] = [
    ["version timed out", async () => TIMED_OUT],
    ["command not found", async () => NOT_FOUND],
    ["sign-in timed out", async (_c, a) => (a[0] === "--version" ? VERSION_OK : TIMED_OUT)],
    ["signed out", async (_c, a) => (a[0] === "--version" ? VERSION_OK
      : { code: 1, stdout: "{\"loggedIn\":false}", stderr: "", timedOut: false, notFound: false })],
  ];
  for (const [what, runner] of runs) {
    const info = await detectClaude(runner, "claude", 10);
    const said = harnessDisconnectedReply("claude", readinessOf(info));
    assert.match(said, /engine isn't connected/i, `${what}: stopped being a refusal`);
    // THE LAW: a refusal may say less than it knows; it may never say more.
    if (!info.installed && info.unsure) {
      assert.ok(!/isn't on this computer|Install it/.test(said),
        `${what}: claimed the app is absent when nothing had answered — "${said}"`);
    }
    if (info.installed) {
      assert.ok(!/isn't on this computer/.test(said),
        `${what}: claimed the app is absent when it had answered --version — "${said}"`);
    }
  }
});

test("a harness this code has never heard of is never called Claude", () => {
  const said = harnessDisconnectedReply("gemini", {
    installed: false, signedIn: false, detected: true,
  });
  assert.ok(!/Claude/.test(said),
    "telling somebody on a third harness to sign in to Claude is a confident sentence about " +
    "the wrong program");
  assert.match(said, /Gemini/);
  // and nothing odd from an unexpected name can reach a room
  const weird = harnessDisconnectedReply("<img src=x>\n ", {
    installed: false, signedIn: false, detected: true,
  });
  assert.ok(!/[<> \n]/.test(weird), `an unexpected harness name reached a room: ${weird}`);
});

// ------------------------------------- 2. what a refused turn means for Stop

function makeEngine(provider?: ClaudeProvider) {
  const engine = new Engine({
    relayUrl: "ws://127.0.0.1:1", token: "t", dataDir: tmp(),
    ...(provider ? { provider } : {}),
  });
  /* The world this engine believes it is in. `stopAgent` refuses an agent this
     computer does not own, so without this every stop below would answer 0 for
     the wrong reason and prove nothing about running turns. */
  engine.state = {
    me: { id: "u1", name: "Vikas" },
    users: [{ id: "u1", name: "Vikas" }],
    agents: [agent()],
    channels: [{
      id: "c1", name: "ops", kind: "channel",
      memberIds: ["u1", "a1"], createdAt: 0,
    }],
    messages: [], agentStatus: {}, tasks: [], approvals: [],
  } as unknown as WorldState;
  const sent: string[] = [];
  engine.agentSend = (_a, _c, text) => { sent.push(text); };
  return { engine, sent };
}

test("a turn refused for a missing harness says which situation this computer is in", async () => {
  const { engine, sent } = makeEngine();
  engine.harnessReadiness = () => ({
    installed: true, signedIn: false, unsure: true, detected: true,
  });
  await engine.takeTurn(agent(), "c1", trigger);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /hasn't said whether it is signed in|asking again/i,
    "the live facts the host holds reach the sentence the room is shown");
});

test("an older host that supplies no facts still gets the old sentence, unchanged", async () => {
  const { engine, sent } = makeEngine();          // harnessReadiness deliberately unset
  await engine.takeTurn(agent(), "c1", trigger);
  assert.equal(sent[0], HARNESS_DISCONNECTED_REPLY);
});

test("A REFUSED TURN IS NEVER STOPPABLE — which is why no Stop control appears", async () => {
  const { engine, sent } = makeEngine();
  engine.harnessReadiness = () => ({ installed: true, signedIn: false, detected: true });
  await engine.takeTurn(agent(), "c1", trigger);

  assert.match(sent[0], /engine isn't connected/i);
  assert.equal(engine.isWorking("a1"), false,
    "the handle a stop kills is opened only after a provider is found, so a refused turn " +
    "never registers one");
  assert.equal(engine.stopAgent("a1"), 0,
    "and there is genuinely nothing to stop — a missing Stop control on this machine is the " +
    "refusal showing through, not a broken Stop");
});

test("…and the same engine IS stoppable the moment a provider exists", async () => {
  /** A turn that hangs until the test lets it go — a real turn mid-flight. */
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  class Hanging implements ClaudeProvider {
    async respond(_input: RespondInput): Promise<string> {
      await gate;
      throw new Error("the harness exited with no output");
    }
  }
  const { engine } = makeEngine(new Hanging());
  const turn = engine.takeTurn(agent(), "c1", trigger);
  for (let i = 0; i < 400 && !engine.isWorking("a1"); i++) {
    await new Promise(r => setTimeout(r, 5));
  }
  assert.equal(engine.isWorking("a1"), true,
    "THE DISCRIMINATION: the difference between the two tests is a provider and nothing else, " +
    "so 'no Stop control' on the installed machine is about the harness, not about Stop");
  assert.equal(engine.stopAgent("a1"), 1);
  release();
  await turn;
});
