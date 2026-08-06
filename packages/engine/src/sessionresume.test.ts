// REMEMBERING A CONVERSATION BETWEEN TURNS — the policy, and the whole turn
// through the provider with a fake CLI.
//
// The cases here are the risk list, one test each: a second turn in a thread
// resumes and sends only what is new; a first turn does not; a different thread
// does not; a changed ability set does not; an expired session does not; a
// different working folder does not; and a resume the CLI refuses falls all the
// way back to a cold turn and still answers.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef } from "@cloud9/shared";
import {
  SessionBook, SESSION_IDLE_MS, abilityFingerprint, decideResume, isUsableSessionId,
  looksLikeRefusedResume, sessionKeyId, StoredSession,
} from "./sessionresume.js";
import { ClaudeCliProvider, claudeAbilityFingerprint, claudeArgs } from "./claude-cli.js";
import { RunOptions, RunResult } from "./run.js";
import { ThreadContinuity } from "./provider.js";

const CLAUDE_MODELS = ["claude-sonnet-5", "claude-opus-5"];
const SESSION_A = "7aba15f4-5dd0-4769-925c-527943765f45";
const SESSION_B = "860ead64-b990-44fb-8c8b-6dce1152b133";

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: false, files: false, schedules: false, background: false },
  model: "claude-sonnet-5", createdAt: 0, ...over,
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-sessions-"));
}

// ------------------------------------------------------------------- the key

test("the key is the THREAD, so two side conversations in one room stay apart", () => {
  const a = sessionKeyId({ agentId: "a1", channelId: "c1", threadRoot: "m1" });
  const b = sessionKeyId({ agentId: "a1", channelId: "c1", threadRoot: "m2" });
  assert.notEqual(a, b);
  // and the same thread is always the same key
  assert.equal(a, sessionKeyId({ agentId: "a1", channelId: "c1", threadRoot: "m1" }));
  // a different agent in the same thread is a different session
  assert.notEqual(a, sessionKeyId({ agentId: "a2", channelId: "c1", threadRoot: "m1" }));
});

test("only a real session id is ever put on a command line", () => {
  assert.equal(isUsableSessionId(SESSION_A), true);
  for (const junk of ["", "abc", "--resume", "7aba15f4 5dd0", 42, null, undefined,
    "7aba15f4-5dd0-4769-925c-527943765f45 && rm -rf /"]) {
    assert.equal(isUsableSessionId(junk), false, `should refuse ${String(junk)}`);
  }
});

// ------------------------------------------------------- the fingerprint (law 2)

test("the fingerprint changes when what the agent may do changes, and not otherwise", () => {
  const base = { tools: ["Read", "Glob"], denied: ["Bash"], connections: false, cloud9Tools: false };
  const same = abilityFingerprint({ ...base, tools: ["Glob", "Read"] }); // order must not matter
  assert.equal(abilityFingerprint(base), same);
  assert.notEqual(abilityFingerprint(base), abilityFingerprint({ ...base, tools: ["Read"] }));
  assert.notEqual(abilityFingerprint(base), abilityFingerprint({ ...base, connections: true }));
  assert.notEqual(abilityFingerprint(base), abilityFingerprint({ ...base, cloud9Tools: true }));
  assert.notEqual(abilityFingerprint(base), abilityFingerprint({ ...base, model: "claude-opus-5" }));
  assert.notEqual(abilityFingerprint(base),
    abilityFingerprint({ ...base, wholeComputerRoots: ["C:/work"] }));
});

test("the fingerprint is built from the same answers the command line is", () => {
  // A switch that is ON but has nothing supplied changes nothing on the command
  // line, so it must change nothing here either — otherwise every turn would
  // look like an ability change and nothing would ever resume.
  const withSwitch = agent({ abilities: {
    webSearch: false, files: false, schedules: false, background: false, wholeComputer: true } });
  assert.equal(
    claudeAbilityFingerprint(withSwitch, { wholeComputerRoots: [] }),
    claudeAbilityFingerprint(withSwitch, {}),
  );
  // supplying a folder to that agent DOES change the line, and does change this
  assert.notEqual(
    claudeAbilityFingerprint(withSwitch, { wholeComputerRoots: ["C:/work"] }),
    claudeAbilityFingerprint(withSwitch, {}),
  );
});

// --------------------------------------------------------------- the decision

const want = {
  key: "a1 c1 m1", provider: "claude", cwd: "C:/agents/a1", abilities: "tools=Read",
};
const stored = (over: Partial<StoredSession> = {}): StoredSession => ({
  key: want.key, provider: "claude", sessionId: SESSION_A, cwd: want.cwd,
  abilities: want.abilities, lastTurnAt: 1_000_000, ...over,
});

test("a second turn in the same thread resumes", () => {
  const v = decideResume(stored(), want, 1_000_000 + 60_000);
  assert.equal(v.resume, true);
});

test("a FIRST turn does not resume — there is nothing stored yet", () => {
  const v = decideResume(undefined, want, 1_000_000);
  assert.equal(v.resume, false);
  assert.match((v as { why: string }).why, /no session is stored/);
});

test("a DIFFERENT THREAD does not resume", () => {
  const v = decideResume(stored({ key: "a1 c1 m2" }), want, 1_000_000);
  assert.equal(v.resume, false);
  assert.match((v as { why: string }).why, /another thread/);
});

test("a CHANGED ABILITY SET does not resume", () => {
  const v = decideResume(stored({ abilities: "tools=Read,Bash" }), want, 1_000_000);
  assert.equal(v.resume, false);
  assert.match((v as { why: string }).why, /allowed to do has changed/);
});

test("an EXPIRED session does not resume", () => {
  const v = decideResume(stored(), want, 1_000_000 + SESSION_IDLE_MS + 1);
  assert.equal(v.resume, false);
  assert.match((v as { why: string }).why, /idle too long/);
  // and one second inside the window still does
  assert.equal(decideResume(stored(), want, 1_000_000 + SESSION_IDLE_MS - 1).resume, true);
});

test("a DIFFERENT WORKING FOLDER does not resume", () => {
  const v = decideResume(stored({ cwd: "C:/agents/a1/worktrees/job-7" }), want, 1_000_000);
  assert.equal(v.resume, false);
  assert.match((v as { why: string }).why, /different folder/);
  // the same folder written differently is still the same folder (Windows)
  assert.equal(decideResume(stored({ cwd: "c:\\agents\\a1" }), want, 1_000_000).resume, true);
});

test("a different app does not resume, and neither does a corrupt id", () => {
  assert.equal(decideResume(stored({ provider: "codex" }), want, 1_000_000).resume, false);
  assert.equal(
    decideResume({ ...stored(), sessionId: "not-a-uuid" }, want, 1_000_000).resume, false);
});

// ---------------------------------------------------------- refused resume

test("the CLI's own refusal is recognised, and a real failure is not", () => {
  assert.equal(looksLikeRefusedResume(
    "No conversation found with session ID: 7aba15f4-5dd0-4769-925c-527943765f45", false, 0), true);
  // nothing at all came back — the general backstop for a stale or expired id
  assert.equal(looksLikeRefusedResume("", false, 0), true);
  // a turn that genuinely ran and genuinely failed is NOT a refused resume: it
  // must be reported, not silently paid for a second time
  assert.equal(looksLikeRefusedResume("Error: the model is overloaded", true, 3), false);
  assert.equal(looksLikeRefusedResume("Error: rate limited", false, 4), false);
});

// -------------------------------------------------------------- the book

test("a session survives being written and read back, and a damaged file costs nothing", () => {
  const dir = tempDir();
  const book = new SessionBook({ agentDataDir: () => dir, log: () => {} });
  assert.equal(book.find("a1", want.key), undefined);
  book.remember("a1", stored({ lastMessageId: "m9" }));
  assert.equal(book.find("a1", want.key)?.sessionId, SESSION_A);
  assert.equal(book.find("a1", want.key)?.lastMessageId, "m9");
  // a refused resume drops it, so the next turn does not hit the same wall
  book.forgetThread("a1", want.key);
  assert.equal(book.find("a1", want.key), undefined);
  // NOTHING IN HERE THROWS AT ITS CALLER: garbage on disk is "no session"
  fs.writeFileSync(path.join(dir, "sessions.json"), "{ this is not json");
  assert.equal(book.find("a1", want.key), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a stored id that is not a session id is refused on the way in and on the way out", () => {
  const dir = tempDir();
  const book = new SessionBook({ agentDataDir: () => dir, log: () => {} });
  book.remember("a1", stored({ sessionId: "--resume" }));
  assert.equal(book.find("a1", want.key), undefined);
  // and a hand-edited file carrying one is ignored when read
  fs.writeFileSync(path.join(dir, "sessions.json"),
    JSON.stringify([{ ...stored(), sessionId: "; rm -rf /" }]));
  assert.equal(book.find("a1", want.key), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------- the command line

test("--resume goes on the line, and never instead of the isolation flags", () => {
  const args = claudeArgs(agent(), CLAUDE_MODELS, { resumeSessionId: SESSION_A });
  assert.ok(args.includes("--resume"));
  assert.equal(args[args.indexOf("--resume") + 1], SESSION_A);
  // THE GATE IS STILL THE GATE. Measured 2026-08-05: a resumed session is
  // re-gated by this very command line, so these must still be here.
  for (const flag of ["--strict-mcp-config", "--disable-slash-commands", "--setting-sources", "--tools"]) {
    assert.ok(args.includes(flag), `${flag} must survive a resume`);
  }
  // a corrupt stored id is dropped rather than passed on
  assert.ok(!claudeArgs(agent(), CLAUDE_MODELS, { resumeSessionId: "nope" }).includes("--resume"));
  assert.ok(!claudeArgs(agent(), CLAUDE_MODELS).includes("--resume"));
});

// ------------------------------------------------- the whole turn, end to end

/** A fake CLI. Each call answers from the queue, or with a plain success. */
function fakeCli(queue: Partial<RunResult>[] = []) {
  const calls: { args: string[]; stdin: string }[] = [];
  const runner = async (_cmd: string, args: string[], opts: RunOptions = {}) => {
    calls.push({ args, stdin: String(opts.stdin ?? "") });
    const next = queue.shift() ?? {};
    return {
      code: 0,
      stdout: `{"type":"system","session_id":"${SESSION_A}"}\n`
        + `{"type":"result","subtype":"success","is_error":false,"result":"ready"}`,
      stderr: "", timedOut: false, notFound: false, ...next,
    };
  };
  return { calls, runner };
}

function turn(book: SessionBook, dir: string, thread?: ThreadContinuity) {
  return {
    provider: (runner: ReturnType<typeof fakeCli>["runner"]) => new ClaudeCliProvider({
      agentDataDir: () => dir, runner, models: () => CLAUDE_MODELS, sessions: book,
    }),
    input: {
      agent: agent(), context: "Vikas: the whole room, all 24,000 characters of it",
      trigger: "and what about the flights?", triggerAuthor: "Vikas",
      kind: "chat" as const, channelId: "c1",
      ...(thread ? { thread } : {}),
    },
  };
}

const aThread = (newest: string, since?: string): ThreadContinuity => ({
  key: "a1 c1 m1",
  newestMessageId: newest,
  since: () => since,
});

test("the FIRST turn in a thread is cold, and remembers the session for next time", async () => {
  const dir = tempDir();
  const book = new SessionBook({ agentDataDir: () => dir, log: () => {} });
  const cli = fakeCli();
  const t = turn(book, dir, aThread("m1", "Vikas: and what about the flights?"));
  const said = await t.provider(cli.runner).respond(t.input);

  assert.equal(said, "ready");
  assert.equal(cli.calls.length, 1);
  assert.ok(!cli.calls[0].args.includes("--resume"), "a first turn must not resume");
  // the WHOLE room went, exactly as it always has
  assert.ok(cli.calls[0].stdin.includes("all 24,000 characters"));
  // and the session is now remembered against this thread
  assert.equal(book.find("a1", "a1 c1 m1")?.sessionId, SESSION_A);
  assert.equal(book.find("a1", "a1 c1 m1")?.lastMessageId, "m1");
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A ROOM OF THE SIZE THE BUDGET ACTUALLY ALLOWS (`context.ts`: 24,000
 * characters). The saving is only visible against a real one — a three-line
 * fixture would prove nothing, because the resumed heading is itself longer
 * than the cold one.
 */
const bigRoom = Array.from({ length: 200 },
  (_, i) => `Vikas: message ${i} — all 24,000 characters of it, ${"x".repeat(100)}`).join("\n");

test("the SECOND turn resumes and sends ONLY what is new — never both", async () => {
  const dir = tempDir();
  const book = new SessionBook({ agentDataDir: () => dir, log: () => {} });
  const t1 = turn(book, dir, aThread("m1", "x"));
  await t1.provider(fakeCli().runner).respond({ ...t1.input, context: bigRoom });

  const cli = fakeCli();
  const t2 = turn(book, dir, aThread("m2", "Vikas: and the flights?"));
  const said = await t2.provider(cli.runner).respond({ ...t2.input, context: bigRoom });

  assert.equal(said, "ready");
  assert.equal(cli.calls.length, 1, "a resumed turn is one run, not two");
  assert.ok(cli.calls[0].args.includes("--resume"));
  assert.equal(cli.calls[0].args[cli.calls[0].args.indexOf("--resume") + 1], SESSION_A);
  // LAW 5, THE POINT OF THE WHOLE THING: only what is new.
  const sent = cli.calls[0].stdin;
  assert.ok(sent.includes("Vikas: and the flights?"), "the new message must be there");
  assert.ok(!sent.includes("all 24,000 characters"),
    "the room must NOT be pasted in as well — that is paying twice");
  assert.ok(sent.includes("ONLY what has been said since your last reply"));

  // AND IT REALLY IS SMALLER — measured, not asserted by hand. The SAME turn,
  // same agent, same room, run cold: the difference is the transcript.
  fs.rmSync(path.join(dir, "sessions.json"), { force: true }); // no session ⇒ cold
  const coldCli = fakeCli();
  const cold = turn(coldBook(dir), dir, aThread("m2", "Vikas: and the flights?"));
  await cold.provider(coldCli.runner).respond({ ...cold.input, context: bigRoom });
  const coldChars = coldCli.calls[0].stdin.length;
  assert.ok(sent.length < coldChars / 2,
    `a resumed prompt (${sent.length}) should be a fraction of a cold one (${coldChars})`);
  fs.rmSync(dir, { recursive: true, force: true });
});

const coldBook = (dir: string) => new SessionBook({ agentDataDir: () => dir, log: () => {} });

test("a turn with NO THREAD never resumes, however many sessions are stored", async () => {
  const dir = tempDir();
  const book = new SessionBook({ agentDataDir: () => dir, log: () => {} });
  book.remember("a1", stored({ cwd: dir }));
  const cli = fakeCli();
  const t = turn(book, dir); // no thread at all — a scheduled check-in, say
  await t.provider(cli.runner).respond(t.input);
  assert.ok(!cli.calls[0].args.includes("--resume"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a DIFFERENT thread in the same room does not pick up the other one's session", async () => {
  const dir = tempDir();
  const book = new SessionBook({ agentDataDir: () => dir, log: () => {} });
  const t1 = turn(book, dir, aThread("m1", "x"));
  await t1.provider(fakeCli().runner).respond(t1.input);

  const cli = fakeCli();
  const other = turn(book, dir, { ...aThread("m5", "new talk"), key: "a1 c1 m4" });
  await other.provider(cli.runner).respond(other.input);
  assert.ok(!cli.calls[0].args.includes("--resume"), "another thread must start cold");
  assert.ok(cli.calls[0].stdin.includes("all 24,000 characters"), "and read the room");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a CHANGED ABILITY SET does not resume — the agent starts clean", async () => {
  const dir = tempDir();
  const book = new SessionBook({ agentDataDir: () => dir, log: () => {} });
  const t1 = turn(book, dir, aThread("m1", "x"));
  await t1.provider(fakeCli().runner).respond(t1.input);

  const cli = fakeCli();
  const t2 = turn(book, dir, aThread("m2", "more"));
  // the owner switched the web on between the two turns
  t2.input.agent = agent({ abilities: {
    webSearch: true, files: false, schedules: false, background: false } });
  await t2.provider(cli.runner).respond(t2.input);
  assert.ok(!cli.calls[0].args.includes("--resume"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("an EXPIRED session does not resume", async () => {
  const dir = tempDir();
  const book = new SessionBook({ agentDataDir: () => dir, log: () => {} });
  book.remember("a1", {
    key: "a1 c1 m1", provider: "claude", sessionId: SESSION_B, cwd: dir,
    abilities: claudeAbilityFingerprint(agent(), { wholeComputerRoots: [] }),
    lastTurnAt: Date.now() - SESSION_IDLE_MS - 1, lastMessageId: "m1",
  });
  const cli = fakeCli();
  const t = turn(book, dir, aThread("m2", "still there?"));
  await t.provider(cli.runner).respond(t.input);
  assert.ok(!cli.calls[0].args.includes("--resume"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a DIFFERENT WORKING FOLDER does not resume — worktree work always starts cold", async () => {
  const dir = tempDir();
  const worktree = tempDir();
  const book = new SessionBook({ agentDataDir: () => dir, log: () => {} });
  const t1 = turn(book, dir, aThread("m1", "x"));
  await t1.provider(fakeCli().runner).respond(t1.input);

  const cli = fakeCli();
  const t2 = turn(book, dir, aThread("m2", "carry on"));
  const said = await t2.provider(cli.runner).respond({ ...t2.input, workdir: worktree });
  assert.equal(said, "ready");
  assert.ok(!cli.calls[0].args.includes("--resume"));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(worktree, { recursive: true, force: true });
});

test("nothing new to say means no resume — an empty prompt is not a turn", async () => {
  const dir = tempDir();
  const book = new SessionBook({ agentDataDir: () => dir, log: () => {} });
  const t1 = turn(book, dir, aThread("m1", "x"));
  await t1.provider(fakeCli().runner).respond(t1.input);

  const cli = fakeCli();
  // `since` cannot find the message it was told to start after — the room moved
  // on, so we do not know what the session has seen
  const t2 = turn(book, dir, aThread("m2", undefined));
  await t2.provider(cli.runner).respond(t2.input);
  assert.ok(!cli.calls[0].args.includes("--resume"));
  assert.ok(cli.calls[0].stdin.includes("all 24,000 characters"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("A REFUSED RESUME FALLS BACK TO A COLD TURN AND STILL ANSWERS", async () => {
  const dir = tempDir();
  const book = new SessionBook({ agentDataDir: () => dir, log: () => {} });
  const t1 = turn(book, dir, aThread("m1", "x"));
  await t1.provider(fakeCli().runner).respond(t1.input);

  // the exact shape the real CLI produced on 2026-08-05 for a dead session id
  const refusal: Partial<RunResult> = {
    code: 1,
    stdout: `{"type":"result","subtype":"error_during_execution","is_error":true,`
      + `"num_turns":0,"session_id":"${SESSION_A}"}`,
    stderr: `No conversation found with session ID: ${SESSION_A}`,
  };
  const cli = fakeCli([refusal]);
  const t2 = turn(book, dir, aThread("m2", "and the flights?"));
  const said = await t2.provider(cli.runner).respond(t2.input);

  // THE OWNER STILL GETS HIS ANSWER. That is the whole law.
  assert.equal(said, "ready");
  assert.equal(cli.calls.length, 2, "it tried the resume, then ran cold");
  assert.ok(cli.calls[0].args.includes("--resume"));
  assert.ok(!cli.calls[1].args.includes("--resume"), "the fallback is a plain cold turn");
  // and the cold turn carries the WHOLE room, exactly as it did before any of this
  assert.ok(cli.calls[1].stdin.includes("all 24,000 characters"));
  // the dead id is forgotten, so the next turn does not walk into the same wall
  assert.equal(book.find("a1", "a1 c1 m1")?.sessionId, SESSION_A,
    "the cold turn's own new session is remembered in its place");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the run record says which path the answer came from", async () => {
  const dir = tempDir();
  const book = new SessionBook({ agentDataDir: () => dir, log: () => {} });
  const seen: (boolean | undefined)[] = [];
  const t1 = turn(book, dir, aThread("m1", "x"));
  await t1.provider(fakeCli().runner).respond(
    { ...t1.input, onTrace: t => { seen.push(t.resumed); } });
  const t2 = turn(book, dir, aThread("m2", "more"));
  await t2.provider(fakeCli().runner).respond(
    { ...t2.input, onTrace: t => { seen.push(t.resumed); } });
  // FALSE IS SAID AS LOUDLY AS TRUE — a field only present on the good path
  // could not answer "did it continue the conversation or start over?"
  assert.deepEqual(seen, [false, true]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// THE THINGS THAT WERE BUILT BESIDE THIS ONE, THE SAME NIGHT (2026-08-06)
// ===========================================================================
//
// `abilityFingerprint` grew three new parts on 2026-08-05 — the thinking dial
// (`effort.ts`), whether a real system prompt is sent (`systemprompt`), and
// whose setup the turn runs in (`ownersetup.ts`) — and each was added by a
// different pair of hands. The unit tests above only ever exercised the raw
// helper with hand-written parts, so a part could be declared on the interface
// and never actually passed by `claudeAbilityFingerprint`, and every one of
// those tests would still be green while the real thing quietly resumed a
// session opened at a different setting.
//
// These hold the REAL function — the one the provider calls — against the real
// command line. A part that stops being passed fails here, by name.

test("the thinking dial is really in the fingerprint the provider uses", () => {
  // NOTE THE `extras` — this is the honest shape and it is worth saying out
  // loud. The dial does not reach the command line from `agent.effort`: the
  // provider translates it once (`effortLevelFor`) and puts the app's own word
  // in `extras.effortLevel`, and the fingerprint reads THAT, so the fingerprint
  // and the flag can only ever come from one answer. A caller that built a
  // fingerprint from the agent alone would get `effort=` for every agent.
  const quick = { effortLevel: "low" };
  const hardest = { effortLevel: "max" };
  const a = agent();
  assert.notEqual(claudeAbilityFingerprint(a, quick), claudeAbilityFingerprint(a, hardest),
    "a session opened at one thinking level must not be silently continued at another — " +
    "the whole point of the dial is that it changes how the model works");
  assert.notEqual(claudeAbilityFingerprint(a, quick), claudeAbilityFingerprint(a, {}),
    "and 'the app decides' is its own setting, not the same as any rung");
  // …and it really is the flag on the line that moved, not a coincidence. Same
  // `extras`, same one answer, which is the whole point of the arrangement.
  assert.ok(claudeArgs(a, CLAUDE_MODELS, quick).includes("--effort"));
  assert.ok(!claudeArgs(a, CLAUDE_MODELS, {}).includes("--effort"));
});

test("sending a real system prompt is really in the fingerprint", () => {
  // With a brief file the agent's identity, switches and skills travel in the
  // harness's system prompt and stdin carries only the turn; without one they
  // are joined back together on stdin. Those are two different conversations,
  // so a session must not be carried across the change.
  const a = agent();
  assert.notEqual(
    claudeAbilityFingerprint(a, { standingBriefPath: "C:/agents/a1/.cloud9-brief-x.txt" }),
    claudeAbilityFingerprint(a, {}),
  );
});

test("A REAL SECOND TURN AT A NEW THINKING LEVEL STARTS COLD", async () => {
  // The end-to-end version of the two above: not the fingerprint function, the
  // actual provider deciding about an actual stored session.
  const dir = tempDir();
  const book = new SessionBook({ agentDataDir: () => dir, log: () => {} });
  const t1 = turn(book, dir, aThread("m1", "x"));
  await t1.provider(fakeCli().runner).respond({ ...t1.input, agent: agent({ effort: "quick" }) });
  assert.equal(book.find("a1", "a1 c1 m1")?.sessionId, SESSION_A, "turn one was remembered");

  const cli = fakeCli();
  const t2 = turn(book, dir, aThread("m2", "Vikas: and the flights?"));
  await t2.provider(cli.runner).respond({ ...t2.input, agent: agent({ effort: "hardest" }) });
  assert.ok(!cli.calls[0].args.includes("--resume"),
    "the dial moved, so the session must be dropped and the room re-read");
  assert.ok(cli.calls[0].stdin.includes("all 24,000 characters"),
    "and a cold turn is a WHOLE turn — never an empty one");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("A REAL SECOND TURN AFTER THE OWNER-SETUP SWITCH FLIPS STARTS COLD", async () => {
  const dir = tempDir();
  const book = new SessionBook({ agentDataDir: () => dir, log: () => {} });
  const t1 = turn(book, dir, aThread("m1", "x"));
  await t1.provider(fakeCli().runner).respond(t1.input);

  const cli = fakeCli();
  const t2 = turn(book, dir, aThread("m2", "Vikas: and the flights?"));
  await t2.provider(cli.runner).respond({
    ...t2.input, agent: agent({ useOwnerSetup: true }),
  });
  assert.ok(!cli.calls[0].args.includes("--resume"),
    "a session started without his CLAUDE.md, his commands and his servers is not " +
    "the conversation the agent is in after the switch flips");
  // and the line really did change too, so this is not a fingerprint that moved on its own
  assert.ok(!cli.calls[0].args.includes("--disable-slash-commands"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("A RESUMED TURN STILL CARRIES THE SYSTEM PROMPT AND THE DIAL", async () => {
  // The failure this rules out: the standing brief and the `--effort` flag are
  // built once, before the resume decision, and the resumed attempt rebuilds the
  // argument list. If either were dropped on that second path, a resumed turn
  // would run without the agent's own brief — the agent would lose its persona,
  // its switches and its skills on every turn after the first, and nothing else
  // would look wrong.
  const dir = tempDir();
  const book = new SessionBook({ agentDataDir: () => dir, log: () => {} });
  const scout = agent({ effort: "hardest" });
  const t1 = turn(book, dir, aThread("m1", "x"));
  await t1.provider(fakeCli().runner).respond({ ...t1.input, agent: scout });

  const cli = fakeCli();
  const t2 = turn(book, dir, aThread("m2", "Vikas: and the flights?"));
  await t2.provider(cli.runner).respond({ ...t2.input, agent: scout });

  const args = cli.calls[0].args;
  assert.ok(args.includes("--resume"), "this turn really did continue the session");
  assert.ok(args.includes("--effort"), "a resumed turn must still be told how hard to think");
  const at = args.indexOf("--append-system-prompt-file");
  assert.ok(at >= 0, "a resumed turn must still carry the agent's standing brief");
  // and it is not a stale path from the first turn — the file existed when the
  // command line was built, and its contents really are this agent's brief
  assert.ok(args.includes("--exclude-dynamic-system-prompt-sections"),
    "the flag that makes the split worth doing must ride with it on the resumed path too");
  fs.rmSync(dir, { recursive: true, force: true });
});
