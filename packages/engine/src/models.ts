// The real model list each harness offers (feedback-round-1.md, his 5+6).
//
// A model id ends up on a command line, so "what models exist" is also a
// security question: the list served here is the allowlist the relay and the
// engine both check an agent against. It is discovered from the CLI where the
// CLI can tell us (Codex) and taken from the documented set where it can't
// (Claude has no machine-readable list command — verified on this machine:
// `claude models` is not a command, it is treated as a prompt).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLAUDE_DEFAULT_MODEL, CLAUDE_MODELS, MODEL_ID_RE } from "@cloud9/shared";
import { Runner, run } from "./run.js";

export interface ModelList {
  models: string[];
  defaultModel?: string;
}

/** Claude's selectable models. Fixed, documented, never guessed. */
export function claudeModels(): ModelList {
  return {
    models: CLAUDE_MODELS.map(m => m.id),
    defaultModel: CLAUDE_DEFAULT_MODEL,
  };
}

/**
 * `codex debug models` prints one JSON object with a `models` array. Entries
 * carry `slug`, `visibility` ("list" | "hide") and `priority`; we serve the
 * listed ones in the CLI's own priority order.
 *
 * Anything that isn't a clean model id is dropped rather than sanitised — same
 * law as run.ts. A CLI that answers with junk gets us an empty list, and an
 * empty list means "we don't know", not "everything is allowed".
 */
export function parseCodexModels(raw: string): string[] {
  const start = raw.indexOf("{");
  if (start < 0) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw.slice(start)); } catch { return []; }
  const list = (parsed as { models?: unknown }).models;
  if (!Array.isArray(list)) return [];

  const rows: { slug: string; priority: number }[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const m = raw as Record<string, unknown>;
    const slug = typeof m.slug === "string" ? m.slug : "";
    if (!MODEL_ID_RE.test(slug)) continue;
    if (m.visibility !== undefined && m.visibility !== "list") continue; // hidden internals
    rows.push({ slug, priority: typeof m.priority === "number" ? m.priority : 1e9 });
  }
  rows.sort((a, b) => a.priority - b.priority);
  // dedupe, keeping the first (highest priority) occurrence
  return [...new Set(rows.map(r => r.slug))];
}

/**
 * The model the user already chose in `~/.codex/config.toml`, if it is one of
 * the models the CLI actually offers. Read-only, and nothing else in that file
 * is touched — it holds the user's own settings, not ours.
 */
export function readCodexDefault(configPath?: string): string | undefined {
  const file = configPath ?? path.join(os.homedir(), ".codex", "config.toml");
  let text: string;
  try { text = fs.readFileSync(file, "utf8"); } catch { return undefined; }
  // top-level `model = "…"` only: stop at the first [section] header so a
  // per-project or per-agent override further down can't be mistaken for it
  const head = text.split(/^\s*\[/m)[0];
  const m = /^\s*model\s*=\s*"([^"\n]{1,64})"\s*$/m.exec(head);
  const slug = m?.[1];
  return slug && MODEL_ID_RE.test(slug) ? slug : undefined;
}

/**
 * Ask the local Codex CLI what it can run. `codex debug models` prints a large
 * document (~285 KB on this machine), so it gets its own generous leash but is
 * still killed rather than allowed to hang detection.
 */
export async function detectCodexModels(
  runner: Runner = run, command = "codex", timeoutMs = 30_000, configPath?: string,
): Promise<ModelList> {
  const result = await runner(command, ["debug", "models"], { timeoutMs });
  if (result.notFound || result.timedOut) return { models: [] };
  const models = parseCodexModels(result.stdout);
  if (models.length === 0) return { models: [] };
  const configured = readCodexDefault(configPath);
  return {
    models,
    defaultModel: configured && models.includes(configured) ? configured : models[0],
  };
}
