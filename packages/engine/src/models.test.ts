// The real model list each harness serves (feedback round 1, his 5+6).
// The list is also the allowlist a model id is checked against, so "what does
// this parser accept" is a security question, not just a UI one.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_MODELS, CLAUDE_MODEL_CATALOGUE } from "@cloud9/shared";
import {
  claudeModels, claudeProbeArgs, detectClaudeModels, detectCodexModels,
  parseClaudeProbe, parseCodexModels, readClaudeModelCache, readCodexDefault,
  writeClaudeModelCache,
} from "./models.js";
import { isPendingName } from "./wholefile.js";

/** A trimmed copy of the real `codex debug models` shape (CLI 0.144.4). */
const CODEX_JSON = JSON.stringify({
  models: [
    { slug: "gpt-5.6-luna", display_name: "GPT-5.6-Luna", visibility: "list", priority: 3 },
    { slug: "gpt-5.6-sol", display_name: "GPT-5.6-Sol", visibility: "list", priority: 1 },
    { slug: "gpt-5.6-terra", display_name: "GPT-5.6-Terra", visibility: "list", priority: 2 },
    { slug: "gpt-5.4-mini", display_name: "GPT-5.4-Mini", visibility: "list", priority: 23 },
    { slug: "codex-auto-review", display_name: "Codex Auto Review", visibility: "hide", priority: 43 },
  ],
});

/** What the real CLI prints for a model it will run (fields we read, verbatim shape). */
const RAN = JSON.stringify({
  is_error: false, subtype: "success", terminal_reason: "completed",
  total_cost_usd: 0.00124, result: "Hi there!",
});
/** What it prints for a model this account cannot reach (captured 2026-07-30). */
const REFUSED = JSON.stringify({
  is_error: true, subtype: "success", terminal_reason: "api_error", total_cost_usd: 0,
  result: "There's an issue with the selected model (claude-mythos-5). It may not exist " +
    "or you may not have access to it. Run --model to pick a different model.",
});

test("Claude's fallback list is the set proved by running it, defaulting to Sonnet 5", () => {
  const list = claudeModels();
  assert.deepEqual(list.models, CLAUDE_MODELS.map(m => m.id));
  assert.equal(list.defaultModel, "claude-sonnet-5");
  assert.equal(list.checked, false, "the fallback must never claim it was checked");
  // the four he was offered before, plus the ones he said were missing
  for (const id of ["claude-fable-5", "claude-opus-5", "claude-sonnet-5",
    "claude-haiku-4-5", "claude-sonnet-4-5", "claude-opus-4-8"]) {
    assert.ok(list.models.includes(id), `${id} should be offered`);
  }
  // retired names the CLI still knows about must never be offered
  for (const id of ["claude-3-7-sonnet", "claude-3-5-sonnet", "claude-mythos-5"]) {
    assert.ok(!list.models.includes(id), `${id} cannot run and must not be offered`);
  }
  // the id agents were saved against before today still works, so it stays valid
  assert.ok(CLAUDE_MODEL_CATALOGUE.some(m => m.id === "claude-haiku-4-5-20251001"));
});

test("a probe never spends a normal turn's worth, and carries none of his setup", () => {
  const args = claudeProbeArgs("claude-opus-5");
  assert.deepEqual(args.slice(-2), ["claude-opus-5", "hi"]);
  for (const flag of ["--safe-mode", "--no-session-persistence", "--tools",
    "--system-prompt", "--output-format"]) {
    assert.ok(args.includes(flag), `${flag} missing from the probe`);
  }
});

test("a probe answer is read as ran / refused / don't know", () => {
  assert.equal(parseClaudeProbe(RAN), "runnable");
  assert.equal(parseClaudeProbe(REFUSED), "unavailable");
  assert.equal(parseClaudeProbe(JSON.stringify({
    is_error: true, subtype: "error_max_budget_usd", total_cost_usd: 0.01,
  })), "runnable", "stopped by a spend cap means the model was accepted");
  // everything that is not the CLI naming the model is 'we don't know'
  assert.equal(parseClaudeProbe("Credit balance too low"), "unknown");
  assert.equal(parseClaudeProbe(""), "unknown");
  assert.equal(parseClaudeProbe(JSON.stringify({
    is_error: true, subtype: "success", total_cost_usd: 0,
    result: "Please run /login",
  })), "unknown", "being signed out must not look like a missing model");
});

test("detectClaudeModels serves exactly the models that answered", async () => {
  const asked: string[] = [];
  const runner = async (_c: string, args: string[]) => {
    const model = args[args.indexOf("--model") + 1];
    asked.push(model);
    return {
      code: 0, timedOut: false, notFound: false, stderr: "",
      stdout: model === "claude-mythos-5" ? REFUSED : RAN,
    };
  };
  const list = await detectClaudeModels(runner, "claude", {
    candidates: ["claude-sonnet-5", "claude-mythos-5", "claude-opus-5"], concurrency: 1,
  });
  assert.deepEqual(asked, ["claude-sonnet-5", "claude-mythos-5", "claude-opus-5"]);
  assert.deepEqual(list.models, ["claude-sonnet-5", "claude-opus-5"]);
  assert.equal(list.checked, true);
  assert.equal(list.defaultModel, "claude-sonnet-5");
});

test("one unreadable probe throws the whole round away rather than dropping a model", async () => {
  const runner = async (_c: string, args: string[]) => {
    const model = args[args.indexOf("--model") + 1];
    return model === "claude-opus-5"
      ? { code: null, stdout: "", stderr: "", timedOut: true, notFound: false }
      : { code: 0, stdout: RAN, stderr: "", timedOut: false, notFound: false };
  };
  const list = await detectClaudeModels(runner, "claude", {
    candidates: ["claude-sonnet-5", "claude-opus-5"], concurrency: 1,
  });
  assert.deepEqual(list.models, CLAUDE_MODELS.map(m => m.id),
    "a bad minute is not a reason to take his models away");
  assert.equal(list.checked, false);
  assert.match(list.detail ?? "", /couldn't get an answer for 1 of 2/);
});

test("the proved list is remembered per CLI build and thrown away when it changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-models-"));
  const file = path.join(dir, "sub", "claude-models.json");
  writeClaudeModelCache(file, "2.1.220 (Claude Code)", ["claude-sonnet-5", "claude-opus-5"]);

  const hit = readClaudeModelCache(file, "2.1.220 (Claude Code)");
  assert.deepEqual(hit?.models, ["claude-sonnet-5", "claude-opus-5"]);
  assert.equal(hit?.checked, true);
  assert.equal(readClaudeModelCache(file, "2.2.0 (Claude Code)"), undefined,
    "a newer Claude Code means the answer has to be proved again");

  // a cache someone has scribbled in is ignored, never trusted through
  fs.writeFileSync(file, JSON.stringify({
    version: "2.1.220 (Claude Code)", models: ["claude-sonnet-5 && calc.exe"],
  }));
  assert.equal(readClaudeModelCache(file, "2.1.220 (Claude Code)"), undefined);
  fs.writeFileSync(file, "not json");
  assert.equal(readClaudeModelCache(file, "2.1.220 (Claude Code)"), undefined);
});

test("the remembered model list is written whole or not at all", () => {
  // Same class as the run records and the schedules: this file is written now
  // and believed later, so it must never be catchable half-written. Two windows
  // opening at once both write it, and the reader has no way to tell a torn file
  // from a short one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-modelcache-"));
  const file = path.join(dir, "claude-models.json");
  const written: string[] = [];

  const realWrite = fs.writeFileSync;
  (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync =
    ((p: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, o?: unknown) => {
      if (typeof p === "string") written.push(path.basename(p));
      return realWrite(p as string, data as string, o as never);
    }) as typeof fs.writeFileSync;
  try {
    writeClaudeModelCache(file, "2.1.220 (Claude Code)", ["claude-sonnet-5"]);
  } finally {
    (fs as { writeFileSync: typeof fs.writeFileSync }).writeFileSync = realWrite;
  }

  assert.equal(written.length, 1);
  assert.notEqual(written[0], "claude-models.json",
    "the bytes went straight to the real name — a reader can catch that half-written");
  assert.ok(isPendingName(written[0]), `and the temporary name says so: ${written[0]}`);
  assert.deepEqual(fs.readdirSync(dir), ["claude-models.json"], "no litter left behind");
  assert.deepEqual(readClaudeModelCache(file, "2.1.220 (Claude Code)")?.models, ["claude-sonnet-5"]);
});

test("Codex models come back in the CLI's own priority order, hidden ones dropped", () => {
  assert.deepEqual(parseCodexModels(CODEX_JSON), [
    "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini",
  ]);
});

test("a model id that isn't a clean slug is dropped, never sanitised", () => {
  const hostile = JSON.stringify({
    models: [
      { slug: "gpt-5.6-sol && calc.exe", visibility: "list", priority: 1 },
      { slug: "../../etc/passwd", visibility: "list", priority: 2 },
      { slug: "gpt-5.5", visibility: "list", priority: 3 },
      { slug: 42, visibility: "list", priority: 4 },
    ],
  });
  assert.deepEqual(parseCodexModels(hostile), ["gpt-5.5"]);
});

test("junk from the CLI means 'we don't know', not 'anything goes'", () => {
  assert.deepEqual(parseCodexModels("not json at all"), []);
  assert.deepEqual(parseCodexModels('{"models": "nope"}'), []);
  assert.deepEqual(parseCodexModels(""), []);
});

test("the user's own default model is read from their Codex config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-codexcfg-"));
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(file, [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "medium"',
    "",
    "[projects.'c:\\\\somewhere']",
    'model = "gpt-5.4-mini"',
    "",
  ].join("\n"));
  assert.equal(readCodexDefault(file), "gpt-5.6-sol",
    "a per-project override further down is not the top-level default");
  assert.equal(readCodexDefault(path.join(dir, "missing.toml")), undefined);
});

test("detectCodexModels prefers the configured default when the CLI offers it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-codexcfg2-"));
  const file = path.join(dir, "config.toml");
  fs.writeFileSync(file, 'model = "gpt-5.4-mini"\n');
  const runner = async () => ({
    code: 0, stdout: CODEX_JSON, stderr: "", timedOut: false, notFound: false,
  });
  const list = await detectCodexModels(runner, "codex", 5_000, file);
  assert.deepEqual(list.models, ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"]);
  assert.equal(list.defaultModel, "gpt-5.4-mini");

  // a configured model the CLI no longer offers falls back to the top one
  fs.writeFileSync(file, 'model = "gpt-4-retired"\n');
  const fallback = await detectCodexModels(runner, "codex", 5_000, file);
  assert.equal(fallback.defaultModel, "gpt-5.6-sol");
});

test("a Codex CLI that isn't there offers no models", async () => {
  const list = await detectCodexModels(
    async () => ({ code: null, stdout: "", stderr: "", timedOut: false, notFound: true }),
  );
  assert.deepEqual(list.models, []);
  assert.equal(list.defaultModel, undefined);
});
