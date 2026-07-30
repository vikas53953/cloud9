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
import {
  CLAUDE_DEFAULT_MODEL, CLAUDE_MODEL_CATALOGUE, CLAUDE_MODELS, MODEL_ID_RE,
} from "@cloud9/shared";
import { Runner, run } from "./run.js";
import { writeWholeFile } from "./wholefile.js";

export interface ModelList {
  models: string[];
  defaultModel?: string;
  /** true when this list came from asking the CLI, false when it's the fallback */
  checked?: boolean;
  /** plain words for the screen: where this list came from */
  detail?: string;
}

/**
 * The last-known-good Claude list — every model PROVED to run on this machine.
 * Used when the live check can't be run or can't be trusted. Never a guess.
 */
export function claudeModels(): ModelList {
  return {
    models: CLAUDE_MODELS.map(m => m.id),
    defaultModel: CLAUDE_DEFAULT_MODEL,
    checked: false,
    detail: "the list Cloud9 last proved by running it, not checked just now",
  };
}

// ---------------------------------------------------------------------------
// Asking the Claude CLI what it can really run
// ---------------------------------------------------------------------------
//
// Codex answers `codex debug models` and hands over a list. Claude has no such
// command — verified on 2026-07-30 against CLI 2.1.220: `claude --help` has no
// `models` subcommand and `claude models` is read as a prompt. So we ask the
// only question the CLI will answer: we try the model.
//
// A tiny one-word turn is run per candidate with the default system prompt
// REPLACED by one character and every tool switched off, which is what keeps it
// cheap (measured: ~$0.001 on Opus 4.8, ~$0.0007 on Haiku, versus ~$0.03 for a
// normal turn). A model this account cannot reach never leaves the door: the
// API answers 404 and the CLI prints "There's an issue with the selected model",
// costing nothing.
//
// Same law as everywhere else in this file: an answer we can't read means "we
// don't know", and "we don't know" is never allowed to become "offer it".

/** How the CLI is asked about ONE model. One place, so the two rules can't drift. */
export function claudeProbeArgs(model: string): string[] {
  return [
    "-p",
    "--safe-mode",              // his own hooks, skills and MCP servers stay out
    "--no-session-persistence", // a probe must not litter his session history
    "--tools", "",              // nothing to run, so nothing can be run
    "--system-prompt", "x",     // the default prompt is what a turn actually costs
    "--output-format", "json",
    "--model", model,
    "hi",
  ];
}

export type ProbeVerdict = "runnable" | "unavailable" | "unknown";

/**
 * Read one probe's answer.
 *
 * "unavailable" is only ever returned when the CLI SAID the model is the
 * problem. Anything else it could not do — no network, rate limited, signed
 * out, timed out — is "unknown", because dropping a model he can run is exactly
 * as wrong as offering one he can't.
 */
export function parseClaudeProbe(raw: string): ProbeVerdict {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return "unknown";
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>; }
  catch { return "unknown"; }

  const result = typeof parsed.result === "string" ? parsed.result : "";
  // the CLI's own words for "that model isn't yours to run" (both deployments)
  if (/issue with the selected model|is not available on your/i.test(result)) {
    return "unavailable";
  }
  if (parsed.is_error === false) return "runnable";
  // it got far enough to be stopped by a spend cap, so the model was accepted
  if (parsed.subtype === "error_max_budget_usd") return "runnable";
  if (typeof parsed.total_cost_usd === "number" && parsed.total_cost_usd > 0) return "runnable";
  return "unknown";
}

export interface ClaudeModelProbeOptions {
  /** the ids to ask about — defaults to every name the CLI knows */
  candidates?: string[];
  /** leash per model; a probe that hangs must not hang detection */
  timeoutMs?: number;
  /** how many to ask at once */
  concurrency?: number;
}

/**
 * Ask the local Claude CLI which models it can actually run.
 *
 * ONE rule decides the whole answer: a model is served only when the CLI ran
 * it, and the list is served only when EVERY candidate got a clear answer. A
 * single unreadable probe means the machine is having a bad minute, not that
 * half his models vanished — so the whole result is thrown away and the proved
 * fallback is served instead, saying so in plain words.
 */
export async function detectClaudeModels(
  runner: Runner = run, command = "claude", opts: ClaudeModelProbeOptions = {},
): Promise<ModelList> {
  const candidates = opts.candidates ?? CLAUDE_MODEL_CATALOGUE.map(m => m.id);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const concurrency = Math.max(1, opts.concurrency ?? 4);

  const verdicts = new Map<string, ProbeVerdict>();
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < candidates.length; i = next++) {
      const model = candidates[i];
      if (!MODEL_ID_RE.test(model)) { verdicts.set(model, "unavailable"); continue; }
      const r = await runner(command, claudeProbeArgs(model), { timeoutMs });
      if (r.notFound || r.timedOut) { verdicts.set(model, "unknown"); continue; }
      verdicts.set(model, parseClaudeProbe(`${r.stdout}\n${r.stderr}`));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, worker));

  const unclear = candidates.filter(m => verdicts.get(m) === "unknown");
  if (unclear.length > 0) {
    const fallback = claudeModels();
    return {
      ...fallback,
      detail: `couldn't get an answer for ${unclear.length} of ${candidates.length} models` +
        ` — showing the list Cloud9 last proved instead`,
    };
  }

  const models = candidates.filter(m => verdicts.get(m) === "runnable");
  if (models.length === 0) return claudeModels();
  return {
    models,
    defaultModel: models.includes(CLAUDE_DEFAULT_MODEL) ? CLAUDE_DEFAULT_MODEL : models[0],
    checked: true,
    detail: `${models.length} models answered when Cloud9 tried them`,
  };
}

// ---------------------------------------------------------------------------
// Remembering the answer
// ---------------------------------------------------------------------------
//
// Trying every model costs a fraction of a penny and about half a minute, which
// is fine once and silly every time the app starts. The answer only changes
// when the CLI changes, so the CLI's own version string IS the cache key: he
// updates Claude Code, the remembered list stops matching, and Cloud9 asks
// again by itself. Nothing to press, nothing to remember.

export interface ClaudeModelCache {
  /** the `claude --version` line the list was proved against */
  version: string;
  models: string[];
  checkedAt: number;
}

/** The remembered list, but only if it was proved against THIS CLI build. */
export function readClaudeModelCache(file: string, version: string): ModelList | undefined {
  let parsed: ClaudeModelCache;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")) as ClaudeModelCache; }
  catch { return undefined; }
  if (!parsed || parsed.version !== version) return undefined;
  if (!Array.isArray(parsed.models) || parsed.models.length === 0) return undefined;
  const models = parsed.models.filter(m => typeof m === "string" && MODEL_ID_RE.test(m));
  if (models.length === 0) return undefined;
  return {
    models,
    defaultModel: models.includes(CLAUDE_DEFAULT_MODEL) ? CLAUDE_DEFAULT_MODEL : models[0],
    checked: true,
    detail: `${models.length} models, proved by running them on this Claude build`,
  };
}

/**
 * Remember a proved list. A cache we can't write is not worth crashing over.
 *
 * Whole or not at all, through the one owner of that rule. Two Cloud9 windows
 * opening at the same moment both prove the list and both write this file; with
 * a plain `writeFileSync` one could be filling the file while the other is
 * reading it, and the reader would see a version line with half a model list
 * under it. Writing next door and renaming into place means a reader sees the
 * old cache or the new one and never a mixture of the two.
 */
export function writeClaudeModelCache(file: string, version: string, models: string[]): void {
  const record: ClaudeModelCache = { version, models, checkedAt: Date.now() };
  // WRITE OUTCOME IGNORED: this is the only write in the engine where a failure
  // genuinely costs nothing and nobody needs telling. It is a REMEMBERED copy
  // of an answer we can always get again — the caller already holds the proved
  // list and uses it either way, and the next start simply asks the CLI again
  // and takes a second or two longer. Nothing is ever told it was saved, and no
  // decision anywhere depends on the file being there. Every OTHER caller in
  // this package acts on the answer; `writeoutcome.test.ts` enforces that.
  writeWholeFile(file, JSON.stringify(record, null, 2));
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
