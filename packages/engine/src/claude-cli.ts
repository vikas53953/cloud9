// ClaudeCliProvider — runs an agent turn on the locally installed Claude app,
// using the app's OWN login (feedback-round-1.md, the primary path).
//
// Cloud9 spawns `claude -p` and nothing else. It does not capture, store or see
// a token: the CLI holds its own credential, exactly as Codex does. Credential
// environment variables are deliberately REMOVED from the child's environment,
// so this path can never quietly bill a stray key that happens to be exported
// in the shell — if it runs, it runs on the app's own sign-in.
//
// Same seam and same hardening as CodexProvider: the prompt goes on STDIN
// (never argv), every argument is allowlist-checked, and there is a wall-clock
// leash with a process-tree kill.
import { AgentDef, MODEL_ID_RE, validateAgentInput } from "@cloud9/shared";
import {
  buildAgentPrompt, ClaudeProvider, HarnessUnavailableError, RespondInput,
} from "./provider.js";
import { claudeToolsFor, NEVER_ALLOWED_TOOLS } from "./abilities.js";
import { EMPTY_ARG, Runner, run, safeArg } from "./run.js";
import { envWithoutCredentials } from "./env.js";
import {
  baseName, EventMapper, ProviderTrace, RunStepKind, RunUsage, traceFromStream,
} from "./runrecord.js";

export interface ClaudeCliProviderOptions {
  /** where the agent's turn runs (its own files folder) */
  agentDataDir: (agentId: string) => string;
  /** command name — overridden by tests with a shim */
  command?: string;
  /** wall-clock leash */
  timeoutMs?: number;
  /** the models this harness offers; a turn is refused for anything else */
  models?: () => string[];
  runner?: Runner;
}

// The credential-stripping rule now lives in one place, shared with the Codex
// provider (finding #9). Re-exported here so existing importers keep working.
export { CREDENTIAL_ENV_VARS, envWithoutCredentials, isCredentialVar } from "./env.js";

export interface ClaudeCliResult {
  text: string;
  error?: string;
}

/**
 * How to read ONE `claude -p --output-format stream-json` event. The shared
 * walker in runrecord.ts does the line splitting, JSON parsing, counting and
 * capping for both providers — this only says what each event MEANS.
 *
 * Shape verified live against CLI 2.1.220 on 2026-07-29:
 *   {"type":"system","subtype":"init","cwd":"…","tools":[…],"session_id":"…"}
 *   {"type":"assistant","message":{"model":"…","content":[
 *      {"type":"tool_use","id":"toolu_…","name":"Read","input":{"file_path":"…"}}]}}
 *   {"type":"user","message":{"content":[
 *      {"type":"tool_result","tool_use_id":"toolu_…","content":"…","is_error":false}]}}
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"…"}]}}
 *   {"type":"result","subtype":"success","is_error":false,"result":"…",
 *      "duration_ms":45345,"num_turns":2,"total_cost_usd":0.758,
 *      "usage":{"input_tokens":4,"output_tokens":289,
 *               "cache_read_input_tokens":35267,"cache_creation_input_tokens":35418},
 *      "modelUsage":{"claude-fable-5":{…}},"permission_denials":[]}
 *
 * A tool call and its result are two events about ONE step, so calls are
 * remembered by `tool_use_id` and finished in place. `permission_denials` is
 * the CLI telling us a tool was REFUSED — the one place Cloud9 can prove a
 * boundary held, so it is recorded as its own step.
 */
export function claudeMapper(): EventMapper {
  const calls = new Map<string, number | undefined>();

  return (ev, t) => {
    const type = String(ev.type ?? "");

    if (type === "system") {
      const id = str(ev.session_id);
      if (id) t.set({ sessionId: id });
      return;
    }

    if (type === "assistant") {
      const message = ev.message as Record<string, unknown> | undefined;
      if (!message) return;
      const model = str(message.model);
      if (model) t.set({ model });
      for (const block of blocks(message.content)) {
        const kind = String(block.type ?? "");
        if (kind === "text") {
          const said = str(block.text);
          if (said) { t.setText(said); t.add({ kind: "message", label: "Said something", detail: said }); }
        } else if (kind === "thinking") {
          const thought = str(block.thinking);
          if (thought) t.add({ kind: "thinking", label: "Thought it through", detail: thought });
        } else if (kind === "tool_use") {
          const step = describeClaudeTool(str(block.name) ?? "a tool", block.input);
          const seq = t.add(step);
          const id = str(block.id);
          if (id) calls.set(id, seq);
        }
      }
      return;
    }

    if (type === "user") {
      const message = ev.message as Record<string, unknown> | undefined;
      if (!message) return;
      for (const block of blocks(message.content)) {
        if (String(block.type ?? "") !== "tool_result") continue;
        const id = str(block.tool_use_id);
        if (!id || !calls.has(id)) continue;
        // is_error is the CLI's own verdict on the tool call; when it is absent
        // we say nothing rather than assuming success.
        const failed = block.is_error;
        if (typeof failed === "boolean") t.update(calls.get(id), { ok: !failed });
      }
      return;
    }

    // The final envelope. Older Claude builds (and `--output-format json`) send
    // it without a `type` at all, so it is recognised by its own fields too —
    // the envelope is what decides a failure, never the text of the reply.
    const isResult = type === "result"
      || (!type && ("result" in ev || "is_error" in ev || "subtype" in ev));
    if (isResult) {
      const said = str(ev.result);
      if (said) t.setText(said);
      t.set({
        ...(typeof ev.duration_ms === "number" ? { cliDurationMs: ev.duration_ms } : {}),
        ...(typeof ev.num_turns === "number" ? { numTurns: ev.num_turns } : {}),
        usage: claudeUsage(ev),
      });
      for (const denial of arr(ev.permission_denials)) {
        const d = denial as Record<string, unknown>;
        t.add({
          kind: "note",
          label: `Refused to use ${str(d.tool_name) ?? "a tool"}`,
          detail: str(d.message) ?? str(d.tool_name),
          ok: false,
        });
      }
      if (ev.is_error === true || ev.subtype === "error_during_execution") {
        t.setError(said || str(ev.api_error_status) || "the Claude turn failed");
      }
      return;
    }
  };
}

/** Claude's tool names → the shared vocabulary. An unknown tool still lands. */
function describeClaudeTool(
  name: string, input: unknown,
): { kind: RunStepKind; label: string; detail?: string } {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const file = str(args.file_path) ?? str(args.path) ?? str(args.notebook_path);
  switch (name) {
    case "Read":
    case "NotebookRead":
      return { kind: "read", label: file ? `Read ${baseName(file)}` : "Read a file", detail: file };
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return {
        kind: "write",
        label: file ? `${name === "Write" ? "Wrote" : "Changed"} ${baseName(file)}` : "Changed a file",
        detail: file,
      };
    case "Glob":
    case "Grep":
      return {
        kind: "search",
        label: "Searched the files on this computer",
        detail: str(args.pattern) ?? str(args.query),
      };
    case "WebSearch":
      return { kind: "web", label: "Searched the web", detail: str(args.query) };
    case "WebFetch":
      return { kind: "web", label: "Read a web page", detail: str(args.url) };
    case "Bash":
    case "BashOutput":
      return { kind: "command", label: "Ran a command", detail: str(args.command) };
    default:
      return { kind: "tool", label: `Used ${name}`, detail: file };
  }
}

/** Tokens and money, each only when Claude reported it. */
function claudeUsage(ev: Record<string, unknown>): RunUsage | undefined {
  const u = ev.usage as Record<string, unknown> | undefined;
  const usage: RunUsage = {};
  if (u) {
    if (typeof u.input_tokens === "number") usage.inputTokens = u.input_tokens;
    if (typeof u.output_tokens === "number") usage.outputTokens = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number") {
      usage.cachedInputTokens = u.cache_read_input_tokens;
    }
  }
  if (typeof ev.total_cost_usd === "number") usage.costUsd = ev.total_cost_usd;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function blocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is Record<string, unknown> => !!b && typeof b === "object");
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** The full trace of a Claude turn: every step, plus tokens and cost. */
export function traceClaude(raw: string): ProviderTrace {
  const trace = traceFromStream(raw, "claude", claudeMapper());
  if (trace.events > 0) return trace;
  // Fallback for the older single-envelope shape (`--output-format json`) and
  // for output with a pretty-printed or truncated envelope: find the outermost
  // object and read it the way we always did. Never guess at the text.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return { ...trace, error: "the Claude app returned nothing" };
  }
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    const one = traceFromStream(JSON.stringify(parsed), "claude", claudeMapper());
    if (one.events > 0 && (one.text || one.error)) return one;
    return { ...trace, error: "the Claude app returned something we couldn't read" };
  } catch {
    return { ...trace, error: "the Claude app returned something we couldn't read" };
  }
}

/**
 * Parse a Claude turn down to the reply text.
 *
 * Kept as the narrow view for callers that only want the sentence; it is built
 * on the SAME walker and mapper the run record uses, so the two can never
 * disagree about what a transcript said.
 */
export function parseClaudeJson(raw: string): ClaudeCliResult {
  const trace = traceClaude(raw);
  if (trace.error) return { text: trace.text, error: trace.error };
  return { text: trace.text };
}

/**
 * A Cloud9 agent must run in a DECLARED environment, not in whatever the owner
 * happens to have configured for himself.
 *
 * What was happening (probed live on CLI 2.1.220, 2026-07-29): an agent whose
 * only ability was "search the web" arrived at the model holding **30 built-in
 * tools** — Task, CronCreate/Delete/List, SendMessage, EnterWorktree,
 * RemoteTrigger — **every MCP server on Vikas's machine** (Telegram, Vercel,
 * Notion, Gmail…), **130 of his slash commands**, and his global CLAUDE.md
 * instructions. Three separate problems in one:
 *   1. the ability toggles were not the permission boundary they claim to be —
 *      an agent could reach accounts nobody granted it;
 *   2. rules written for the owner's own coding sessions were steering his
 *      agents;
 *   3. the same agent would behave differently on a friend's machine, so
 *      nothing was reproducible.
 *
 * The flags below were each chosen by running the CLI and reading the tool list
 * it reported back, not from the help text:
 *  - `--safe-mode`      drops CLAUDE.md, skills, plugins, hooks, MCP servers,
 *                       custom commands, agents and output styles — while
 *                       KEEPING the login, which is the constraint that rules
 *                       out simply pointing CLAUDE_CONFIG_DIR somewhere empty
 *                       (that reports "not logged in").
 *  - `--strict-mcp-config` refuses every MCP server we did not pass in. We pass
 *                       none, so: none.
 *  - `--disable-slash-commands` drops the owner's skills.
 *  - `--tools …`        (added per-agent below) declares the exact built-in set.
 *
 * Measured result, same probe: 34 tools → exactly the agent's own; MCP servers
 * → none; slash commands → none.
 *
 * WHAT STILL LEAKS, stated plainly: `--safe-mode` documents that
 * admin-managed (policy) settings still apply. On a machine with an enterprise
 * managed-settings file, those would still reach the agent. Nothing on this
 * machine has one, so it has not been observed — it is a limit of the CLI, not
 * something Cloud9 can close from here.
 */
export const CLAUDE_ISOLATION_FLAGS = [
  "--safe-mode",
  "--strict-mcp-config",
  "--disable-slash-commands",
] as const;

/**
 * Build the `claude -p` argument list for an agent.
 *
 * The agent definition comes from a client, so it is re-validated HERE, at the
 * moment it would become a command line — the relay's check is the first gate,
 * this is the last one, and neither trusts the other.
 */
export function claudeArgs(agent: AgentDef, models: string[] = []): string[] {
  const problem = validateAgentInput(agent, { models });
  if (problem) throw new Error(`refusing to run this agent: ${problem}`);

  // `stream-json` rather than `json`: it is a strict SUPERSET — the same final
  // result envelope arrives as the last line, preceded by one line per tool
  // call and tool result. That preceding detail is the whole run record; with
  // plain `json` the CLI tells us the answer and nothing about how it got
  // there. `--verbose` is required by the CLI for stream-json under `-p`.
  // Verified live on CLI 2.1.220, 2026-07-29.
  const args = [
    "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "dontAsk",
    // --- the agent runs in a DECLARED environment, not the owner's ---
    ...CLAUDE_ISOLATION_FLAGS,
  ];
  if (agent.model) {
    if (!MODEL_ID_RE.test(agent.model)) throw new Error("refusing to run this agent: bad model id");
    args.push("--model", safeArg(agent.model));
  }
  // abilities → tools, from the ONE table that also writes the sentences the
  // agent reads about itself (abilities.ts). Granting a tool here without the
  // agent being told is no longer possible: it is the same row.
  const allowed = claudeToolsFor(agent);
  // `--tools` DECLARES which built-in tools exist for this run. `--allowed-tools`
  // is only a permission allowlist, and with `--permission-mode dontAsk` it was
  // never a boundary at all: a probe on 2026-07-29 showed an agent with
  // webSearch as its only ability still holding 30 built-in tools — Task, the
  // Cron family, SendMessage, worktrees — plus every MCP server on the owner's
  // machine. Declaring the set is what actually closes that.
  args.push("--tools", ...(allowed.length > 0 ? allowed.map(safeArg) : [EMPTY_ARG]));
  if (allowed.length > 0) args.push("--allowed-tools", ...allowed.map(safeArg));
  args.push("--disallowed-tools", ...NEVER_ALLOWED_TOOLS.map(safeArg));
  return args;
}

export class ClaudeCliProvider implements ClaudeProvider {
  private runner: Runner;
  private command: string;
  private timeoutMs: number;

  constructor(private opts: ClaudeCliProviderOptions) {
    this.runner = opts.runner ?? run;
    this.command = opts.command ?? "claude";
    this.timeoutMs = opts.timeoutMs ?? 180_000;
  }

  async respond({ agent, context, onTrace }: RespondInput): Promise<string> {
    const cwd = this.opts.agentDataDir(agent.id);
    const prompt = buildAgentPrompt(agent, context);
    const result = await this.runner(this.command, claudeArgs(agent, this.opts.models?.() ?? []), {
      cwd,
      timeoutMs: this.timeoutMs,
      stdin: prompt,
      // no credential variables: the local app's own login pays for this turn
      env: envWithoutCredentials(),
    });

    if (result.notFound) {
      throw new HarnessUnavailableError("claude", "the Claude app isn't installed on this machine");
    }
    if (result.timedOut) {
      throw new Error(`Claude took longer than ${Math.round(this.timeoutMs / 1000)}s, so I stopped it`);
    }
    // Only the CLI's OWN complaint counts. Scanning the reply text would let a
    // model that merely *talks about* logging in fake a signed-out harness.
    if (result.code !== 0 && looksSignedOut(result.stderr)) {
      throw new HarnessUnavailableError("claude", "the Claude app is not signed in");
    }

    const trace = traceClaude(result.stdout);
    // Recording must never cost the owner an answer: a broken recorder is a
    // logged problem, not a failed turn.
    try { onTrace?.(trace); } catch (err) {
      console.error("[engine] could not record what Claude did:", err);
    }

    if (result.code !== 0 && !trace.text) {
      throw new Error(`Claude exited with ${result.code}: ${firstLine(result.stderr)}`);
    }
    if (trace.error && !trace.text) throw new Error(trace.error);
    return trace.text || "(no response)";
  }
}

function looksSignedOut(output: string): boolean {
  return /not logged in|please run ["`']?claude \/?login|invalid api key|authentication_error|unauthorized/i
    .test(output);
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find(l => l.trim()) ?? "").slice(0, 160);
}
