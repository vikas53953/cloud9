// CodexProvider: JSONL transcript parsing and argument building.
import test from "node:test";
import assert from "node:assert/strict";
import { AgentDef } from "@cloud9/shared";
import { CodexProvider, codexArgs, parseCodexJsonl } from "./codex.js";
import { HarnessUnavailableError } from "./provider.js";
import { RunOptions, RunResult } from "./run.js";

const agent = (over: Partial<AgentDef> = {}): AgentDef => ({
  id: "a1", ownerId: "u1", name: "Scout", emoji: "🔭", persona: "You research travel",
  abilities: { webSearch: true, files: false, schedules: false, background: false },
  provider: "codex", createdAt: 0, ...over,
});

/** A real-shaped `codex exec --json` transcript (harness-signin.md §Codex). */
const TRANSCRIPT = [
  `{"type":"thread.started","thread_id":"th_01H9XYZ"}`,
  `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"id":"item_0","type":"reasoning","text":"thinking about villas"}}`,
  `{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls"}}`,
  `{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Found 3 villas in Goa under 8k."}}`,
  `{"type":"turn.completed","usage":{"input_tokens":812,"output_tokens":64}}`,
].join("\n");

function fakeRunner(result: Partial<RunResult>, capture?: (a: string[], o: RunOptions) => void) {
  return async (_cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> => {
    capture?.(args, opts);
    return { code: 0, stdout: "", stderr: "", timedOut: false, notFound: false, ...result };
  };
}

test("parses the final agent_message out of a codex transcript", () => {
  const t = parseCodexJsonl(TRANSCRIPT);
  assert.equal(t.text, "Found 3 villas in Goa under 8k.");
  assert.equal(t.threadId, "th_01H9XYZ");
  assert.equal(t.events, 6);
  assert.equal(t.error, undefined);
});

test("the LAST agent_message wins", () => {
  const t = parseCodexJsonl([
    `{"type":"item.completed","item":{"type":"agent_message","text":"first draft"}}`,
    `{"type":"item.completed","item":{"type":"agent_message","text":"final answer"}}`,
  ].join("\n"));
  assert.equal(t.text, "final answer");
});

test("agent_message content blocks are joined", () => {
  const t = parseCodexJsonl(
    `{"type":"item.completed","item":{"type":"agent_message","content":[{"type":"text","text":"a "},{"type":"text","text":"b"}]}}`,
  );
  assert.equal(t.text, "a b");
});

test("non-JSON noise and unknown events are ignored", () => {
  const t = parseCodexJsonl([
    "warming up…",
    "",
    `{"type":"thread.started","thread_id":"th_2"}`,
    "not json {",
    `{"type":"some.future.event","whatever":1}`,
    `{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}`,
  ].join("\r\n"));
  assert.equal(t.text, "ok");
  assert.equal(t.threadId, "th_2");
});

test("turn.failed is surfaced as an error", () => {
  const t = parseCodexJsonl(`{"type":"turn.failed","message":"model refused"}`);
  assert.equal(t.error, "model refused");
  assert.equal(t.text, "");
});

test("abilities map to the codex sandbox flag", () => {
  const readOnly = codexArgs(agent(), "C:/data/a1");
  assert.ok(readOnly.includes("read-only"));
  assert.ok(!readOnly.includes("workspace-write"));
  const writable = codexArgs(
    agent({ abilities: { webSearch: true, files: true, schedules: false, background: false } }),
    "C:/data/a1",
  );
  assert.ok(writable.includes("workspace-write"));
  // note-mandated flags
  for (const flag of ["exec", "--json", "--skip-git-repo-check", "--ephemeral"]) {
    assert.ok(readOnly.includes(flag), `missing ${flag}`);
  }
  assert.ok(readOnly.join(" ").includes("approval_policy=never"));
});

test("paths with spaces are quoted for the shell", () => {
  const args = codexArgs(agent(), "C:/Users/Vik As/data");
  assert.ok(args.includes('"C:/Users/Vik As/data"'));
});

test("provider sends the prompt on stdin and returns the reply", async () => {
  let seenStdin = "";
  const provider = new CodexProvider({
    agentDataDir: () => "C:/data/a1",
    runner: fakeRunner({ stdout: TRANSCRIPT }, (_a, o) => { seenStdin = o.stdin ?? ""; }),
  });
  const text = await provider.respond({
    agent: agent(), context: "Vikas: find villas", trigger: "find villas", triggerAuthor: "Vikas",
  });
  assert.equal(text, "Found 3 villas in Goa under 8k.");
  assert.ok(seenStdin.includes("Scout"), "prompt goes on stdin, not argv");
  assert.ok(seenStdin.includes("find villas"));
});

test("a missing codex CLI is a harness problem, not a crash", async () => {
  const provider = new CodexProvider({
    agentDataDir: () => "C:/data/a1",
    runner: fakeRunner({ code: 1, notFound: true, stderr: "'codex' is not recognized" }),
  });
  await assert.rejects(
    () => provider.respond({ agent: agent(), context: "", trigger: "hi", triggerAuthor: "V" }),
    (err: unknown) => err instanceof HarnessUnavailableError && err.harness === "codex",
  );
});

test("a signed-out codex is a harness problem", async () => {
  const provider = new CodexProvider({
    agentDataDir: () => "C:/data/a1",
    runner: fakeRunner({ code: 1, stderr: "Not logged in. Please run `codex login`." }),
  });
  await assert.rejects(
    () => provider.respond({ agent: agent(), context: "", trigger: "hi", triggerAuthor: "V" }),
    (err: unknown) => err instanceof HarnessUnavailableError,
  );
});

test("a timeout is reported in plain words", async () => {
  const provider = new CodexProvider({
    agentDataDir: () => "C:/data/a1",
    timeoutMs: 120_000,
    runner: fakeRunner({ code: null, timedOut: true }),
  });
  await assert.rejects(
    () => provider.respond({ agent: agent(), context: "", trigger: "hi", triggerAuthor: "V" }),
    /longer than 120s/,
  );
});
