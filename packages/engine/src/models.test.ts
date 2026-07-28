// The real model list each harness serves (feedback round 1, his 5+6).
// The list is also the allowlist a model id is checked against, so "what does
// this parser accept" is a security question, not just a UI one.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_MODELS } from "@cloud9/shared";
import {
  claudeModels, detectCodexModels, parseCodexModels, readCodexDefault,
} from "./models.js";

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

test("Claude's list is the documented set, defaulting to Sonnet 5", () => {
  const list = claudeModels();
  assert.deepEqual(list.models, CLAUDE_MODELS.map(m => m.id));
  assert.equal(list.defaultModel, "claude-sonnet-5");
  assert.ok(list.models.includes("claude-fable-5"));
  assert.ok(list.models.includes("claude-opus-5"));
  assert.ok(list.models.includes("claude-haiku-4-5-20251001"));
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
