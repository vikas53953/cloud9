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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentDef, MODEL_ID_RE, validateAgentInput } from "@cloud9/shared";
import {
  buildAgentPrompt, ClaudeProvider, HarnessUnavailableError, promptTurnKind, RespondInput,
} from "./provider.js";
import { TurnTimedOutError, turnTimeBudgetMs } from "./timebudget.js";
import {
  claudeToolsFor, deniedClaudeTools, grantedSupply, Supply,
} from "./abilities.js";
import { cloud9McpConfig, cloud9ToolNames } from "./cloud9tools.js";
import { OpenTurn } from "./toolbridge.js";
import { EMPTY_ARG, Runner, run, safeArg } from "./run.js";
import { envWithoutCredentials } from "./env.js";
import {
  baseName, EventMapper, ProviderTrace, RunStepKind, RunUsage, traceFromStream,
} from "./runrecord.js";
import { liveStepWatcher } from "./livesteps.js";
import {
  abilityFingerprint, decideResume, isUsableSessionId, looksLikeRefusedResume, SessionBook,
} from "./sessionresume.js";

export interface ClaudeCliProviderOptions {
  /** where the agent's turn runs (its own files folder) */
  agentDataDir: (agentId: string) => string;
  /** command name — overridden by tests with a shim */
  command?: string;
  /**
   * FORCE ONE wall-clock leash for every turn, whatever kind of work it is.
   *
   * It used to be the only leash there was, defaulting to 3 minutes, which is
   * why a background job was killed like a late chat message. It is now an
   * OVERRIDE and nothing sets it in the app: leave it out and each turn gets the
   * budget for its own kind of work (`timebudget.ts`). Tests set it to pin a
   * number; the host does not.
   */
  timeoutMs?: number;
  /** the models this harness offers; a turn is refused for anything else */
  models?: () => string[];
  /**
   * Folders an agent with the `wholeComputer` switch may reach, asked fresh per
   * turn so a settings change takes effect immediately. Ignored entirely for an
   * agent without that switch — see `claudeArgs`.
   */
  wholeComputerRoots?: (agentId: string) => string[];
  /** path to the MCP config the owner chose for THIS agent, if any */
  mcpConfigPath?: (agentId: string) => string | undefined;
  /**
   * THE DOORWAY BACK INTO CLOUD9 (`cloud9tools.ts`). Opens Cloud9's own tools —
   * search, today — for ONE turn in ONE conversation. Absent means no doorway,
   * and the prompt then says nothing about one: an agent is never told about a
   * tool it does not have.
   */
  cloud9Tools?: (turn: { channelId: string }) => OpenTurn | undefined;
  /**
   * WHERE THIS AGENT'S REMEMBERED SESSIONS LIVE (`sessionresume.ts`).
   *
   * Absent means this provider never resumes, which is exactly what Cloud9 did
   * before: every turn cold, with the whole transcript. Nothing else changes
   * when it is missing, and that is the point — resume is an optimisation the
   * app can be built entirely without.
   */
  sessions?: SessionBook;
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
 * ============================================================================
 * WHY `--safe-mode` IS NOT ON THIS LINE ANY MORE (measured 2026-08-05, CLI
 * 2.1.222). THIS IS THE IMPORTANT PARAGRAPH IN THIS FILE.
 * ============================================================================
 *
 * `--safe-mode` disables "all customizations … MCP servers …". It turns out it
 * means that ABSOLUTELY — including an MCP server we hand the CLI ourselves on
 * the very same command line with `--mcp-config`. Four runs, identical but for
 * the flags, against a throwaway one-tool MCP server:
 *
 *   --safe-mode --strict-mcp-config --mcp-config X  → mcp_servers: []
 *                                                     server never even spawned
 *                                                     model: "there is no such tool"
 *   --safe-mode                     --mcp-config X  → mcp_servers: []   (same)
 *               --strict-mcp-config --mcp-config X  → mcp_servers: [{probe,connected}]
 *                                                     tool CALLED, right answer back
 *                                       --mcp-config X → probe + all 17 of the
 *                                                     owner's own servers
 *
 * So for as long as `--safe-mode` was on this line, TWO things Cloud9 believes
 * it ships were dead in every real turn:
 *   1. the `connections` switch granted nothing at all; and
 *   2. CLOUD9'S OWN TOOLS — `search_conversation`, `open_attachment`
 *      (`cloud9tools.ts`) — never existed. Every agent that was told in its
 *      prompt that it could search this conversation or open an attached file
 *      was told something false, and answered "I can't do that" because from
 *      where it stood that was true.
 *
 * THE REPLACEMENT, and it was picked by measuring, not by reading:
 * `--setting-sources ""` (an EMPTY list of setting sources). It loads no user,
 * project or local settings — and on this CLI that also stops CLAUDE.md and
 * plugins loading, which is the whole of what we wanted `--safe-mode` for.
 * Measured side by side, same probe, same machine:
 *
 *                                   --safe-mode      --setting-sources ""
 *   our own --mcp-config server      DEAD             connected + callable
 *   owner's 17 MCP servers           none             none
 *   owner's plugins named in init    SEVEN            none          ← better
 *   owner's skills / slash commands  none             none
 *   owner's global CLAUDE.md         not loaded       not loaded
 *   a project CLAUDE.md in cwd       not loaded       not loaded
 *   owner's hooks                    did not run      did not run
 *   auto-memory folder               off              off (see env below)
 *   the app's own login              works            works
 *
 * It is therefore not a trade: on every axis we can measure, the new line is
 * as isolated as `--safe-mode` or MORE isolated, and Cloud9's own doorway is
 * alive. The one deliberate difference is that `--setting-sources ""` also
 * drops the owner's `permissions` block, which `--safe-mode` kept. Cloud9 never
 * leaned on it — the boundary is `--tools` / `--disallowed-tools`, right here —
 * and a per-machine allowlist is exactly the kind of thing an agent is supposed
 * not to inherit.
 *
 * The rest of the line is unchanged and was chosen the same way:
 *  - `--strict-mcp-config` refuses every MCP server we did not pass in, so the
 *                       only servers that can exist are the ones below.
 *  - `--disable-slash-commands` drops the owner's skills.
 *  - `--tools …`        (added per-agent below) declares the exact built-in set.
 *
 * WHAT STILL LEAKS, stated plainly: admin-managed (policy) settings. Nothing on
 * this machine has one, so it has not been observed — it is a limit of the CLI,
 * not something Cloud9 can close from here.
 */
export const CLAUDE_ISOLATION_FLAGS = [
  "--strict-mcp-config",
  "--disable-slash-commands",
  // an EMPTY list — "load settings from nowhere". EMPTY_ARG is the one way to
  // put a real `""` on a command line through `run.ts` (see its comment); a
  // bare empty string would vanish in the shell and let `--setting-sources`
  // swallow the next flag instead.
  "--setting-sources", EMPTY_ARG,
] as const;

/**
 * THE ISOLATION THAT IS NOT A FLAG.
 *
 * `--setting-sources ""` leaves ONE thing on that `--safe-mode` switched off:
 * the CLI's auto-memory folder, which showed up as `memory_paths` in the init
 * event. There is no command-line flag for it — the CLI reads an environment
 * variable (`CLAUDE_CODE_DISABLE_AUTO_MEMORY`, found in the shipped bundle and
 * verified: with it set, `memory_paths` is gone from init and the doorway still
 * works). Cloud9 already owns the child's environment (`envWithoutCredentials`),
 * so this rides there rather than becoming a reason to keep `--safe-mode`.
 */
export const CLAUDE_ISOLATION_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
};

/**
 * Build the `claude -p` argument list for an agent.
 *
 * The agent definition comes from a client, so it is re-validated HERE, at the
 * moment it would become a command line — the relay's check is the first gate,
 * this is the last one, and neither trusts the other.
 */
export interface ClaudeArgExtras {
  /**
   * Folders outside the agent's own one that it may reach, when — and ONLY when
   * — the `wholeComputer` switch is on. Passing roots for an agent without that
   * switch is ignored, so a caller cannot widen an agent by handing it a path.
   */
  wholeComputerRoots?: string[];
  /**
   * PATH to an MCP config chosen FOR THIS AGENT by its owner, honoured only
   * when the `connections` switch is on. `--strict-mcp-config` stays on
   * regardless, so this is the only way a server can exist for the run — the
   * owner's own servers are never among them.
   *
   * A path, never inline JSON, even though the CLI accepts both. Inline JSON
   * would put `{`, `"` and whatever a server name contains onto a command line,
   * and `run.ts` rightly refuses those characters. A file keeps the argument
   * boring and the content out of argv entirely.
   */
  mcpConfigPath?: string;
  /**
   * CLOUD9'S OWN MCP CONFIG — the search doorway. Deliberately NOT the same slot
   * as `mcpConfigPath` above: that one is the owner's connected services and is
   * gated behind the `connections` switch, while this one is Cloud9 handing an
   * agent a way to search the conversation it is already reading. Sharing a slot
   * would have made "search the room you are in" require the top rung.
   *
   * `--strict-mcp-config` stays on either way, so these are the only servers
   * that can exist for the run.
   */
  cloud9McpConfigPath?: string;
  /**
   * CONTINUE THE CLI'S OWN CONVERSATION instead of starting a new one.
   *
   * `--resume <id>` is the CLI's own flag (`claude --help`, 2.1.220: "Resume a
   * conversation by session ID"). It is added FIRST, right after `-p`, so it
   * reads as what it is — and everything below it still runs: the isolation
   * flags, the declared tool set, the denied set, the folders. That ordering is
   * not cosmetic. A resumed session is re-gated by this command line on every
   * turn (measured 2026-08-05: a session that had used Bash, resumed without
   * Bash in `--tools`, was told "No such tool available: Bash. Bash is disabled
   * for this session"), so the flags below are still the boundary and must
   * still be built from the agent's switches, exactly as for a cold turn.
   *
   * Refused unless it is a real session id — a corrupt stored value must cost a
   * resume, never put something odd on a command line.
   */
  resumeSessionId?: string;
}

export function claudeArgs(
  agent: AgentDef, models: string[] = [], extras: ClaudeArgExtras = {},
): string[] {
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
  ];
  // CONTINUE THE SAME CONVERSATION — before the isolation flags, never instead
  // of them. A bad id is dropped rather than passed on: the turn then runs cold,
  // which is the whole fallback law of `sessionresume.ts` in one line.
  if (extras.resumeSessionId && isUsableSessionId(extras.resumeSessionId)) {
    args.push("--resume", safeArg(extras.resumeSessionId));
  }
  // --- the agent runs in a DECLARED environment, not the owner's ---
  args.push(...CLAUDE_ISOLATION_FLAGS);
  if (agent.model) {
    if (!MODEL_ID_RE.test(agent.model)) throw new Error("refusing to run this agent: bad model id");
    args.push("--model", safeArg(agent.model));
  }
  // abilities → tools, from the ONE table that also writes the sentences the
  // agent reads about itself (abilities.ts). Granting a tool here without the
  // agent being told is no longer possible: it is the same row.
  // WHAT IS TRULY GRANTED, from the same function the prompt asks. A flag on
  // this line and a sentence in the prompt can no longer disagree, because
  // neither of them decides on its own — see `grantedSupply` in abilities.ts.
  const granted = grantedSupply(agent, extras);
  // Cloud9's own tools ride alongside the harness's built-ins. They are only in
  // the list when the doorway is really open for this turn.
  const cloud9 = extras.cloud9McpConfigPath ? cloud9ToolNames() : [];
  const allowed = [...claudeToolsFor(agent), ...cloud9];
  // `--tools` DECLARES which built-in tools exist for this run. `--allowed-tools`
  // is only a permission allowlist, and with `--permission-mode dontAsk` it was
  // never a boundary at all: a probe on 2026-07-29 showed an agent with
  // webSearch as its only ability still holding 30 built-in tools — Task, the
  // Cron family, SendMessage, worktrees — plus every MCP server on the owner's
  // machine. Declaring the set is what actually closes that.
  args.push("--tools", ...(allowed.length > 0 ? allowed.map(safeArg) : [EMPTY_ARG]));
  if (allowed.length > 0) args.push("--allowed-tools", ...allowed.map(safeArg));
  // Belt and braces, and it is now DERIVED rather than a hand-written list.
  // It used to be the constant `["Bash"]`, which had two faults: it promised no
  // agent could ever run a command (the ceiling Vikas asked us to lift), and it
  // missed `PowerShell`, which the 2026-07-30 probe proved is its own separate
  // tool on this machine. Deriving it from the measured built-in set means a
  // tool the CLI grows next month is denied by default rather than by luck.
  const denied = deniedClaudeTools(agent);
  if (denied.length > 0) args.push("--disallowed-tools", ...denied.map(safeArg));
  // Beyond its own folder — only for an agent whose owner switched that on, and
  // only to the folders he named. `--add-dir` is the CLI's own flag for it
  // (`claude --help`, 2.1.220): "Additional directories to allow tool access to".
  //
  // Paths go through RAW. Quoting has exactly one owner — `run.ts` — and this
  // file learned that lesson the expensive way on the Codex side, where quoting
  // a path here as well made `run()` reject its own quotes and broke every turn
  // for anyone with a space in their user folder.
  for (const root of granted.wholeComputerRoots ?? []) args.push("--add-dir", root);
  // Connected services the owner chose for THIS agent. `--strict-mcp-config` is
  // already on the line above and stays there, so this config is the only one
  // that can exist for the run — his own servers cannot arrive through it.
  if (granted.mcpConfigPath) args.push("--mcp-config", granted.mcpConfigPath);
  // Cloud9's own doorway. Ungated, because reading the room you are standing in
  // is not a new power — every agent, on every rung, is already handed the
  // recent messages of this conversation.
  if (extras.cloud9McpConfigPath) args.push("--mcp-config", extras.cloud9McpConfigPath);
  return args;
}

/**
 * The Supply this argument list will really deliver — the same answer the prompt
 * is built from. Exported so a test can hold the two against each other in BOTH
 * directions rather than trusting that they were written from the same variable.
 */
export function claudeSupply(agent: AgentDef, extras: ClaudeArgExtras = {}): Supply {
  return grantedSupply(agent, extras);
}

/**
 * WHAT THIS COMMAND LINE WILL REALLY ALLOW, as one comparable string — the
 * thing a remembered session is bound to (`sessionresume.ts`, law 2).
 *
 * Built from `claudeToolsFor`, `deniedClaudeTools` and `grantedSupply`: the
 * SAME three answers `claudeArgs` above is built from, so a change that alters
 * the command line alters the fingerprint and drops the session. Reading
 * `agent.abilities` instead would have been wrong in both directions — a switch
 * that is on but unsupplied changes nothing on the line, and a supply that
 * arrives without a switch changes nothing either.
 */
export function claudeAbilityFingerprint(
  agent: AgentDef, extras: ClaudeArgExtras = {},
): string {
  const granted = grantedSupply(agent, extras);
  return abilityFingerprint({
    ...(agent.model ? { model: agent.model } : {}),
    tools: claudeToolsFor(agent),
    denied: deniedClaudeTools(agent),
    ...(granted.wholeComputerRoots ? { wholeComputerRoots: granted.wholeComputerRoots } : {}),
    connections: !!granted.mcpConfigPath,
    cloud9Tools: !!extras.cloud9McpConfigPath,
  });
}

export class ClaudeCliProvider implements ClaudeProvider {
  private runner: Runner;
  private command: string;
  /** set only when a caller pinned one leash for every kind — normally undefined */
  private fixedTimeoutMs: number | undefined;

  constructor(private opts: ClaudeCliProviderOptions) {
    this.runner = opts.runner ?? run;
    this.command = opts.command ?? "claude";
    this.fixedTimeoutMs = opts.timeoutMs;
  }

  /**
   * HOW LONG THIS TURN GETS. Per turn, not per provider — the provider is built
   * once at sign-in (`host.ts`) and then answers chat messages, background jobs
   * and repository work through the same object, so a constructor is the one
   * place this decision could NOT be made correctly.
   *
   * `promptTurnKind` is the same answer the prompt is built from, so the clock
   * and the sentence the agent reads about its turn cannot drift apart.
   */
  private budgetFor(input: RespondInput): number {
    return this.fixedTimeoutMs ?? turnTimeBudgetMs(promptTurnKind(input));
  }

  /**
   * MAY THIS TURN CONTINUE THE SESSION IT ALREADY HAS? (`sessionresume.ts`)
   *
   * Decided HERE and not in the engine, because two of the four facts it turns
   * on are known only at this point: the folder the turn will really run in
   * (`cwd`, which is a fresh worktree for repository work), and what this
   * command line will really grant (`claudeAbilityFingerprint`, which depends on
   * the roots and the MCP config this provider was constructed with).
   *
   * Every "no" is silent and lands on today's behaviour. Returns undefined for:
   * no session book, no thread, a worktree turn, and every refusal
   * `decideResume` makes.
   */
  private planResume(
    input: RespondInput, cwd: string, extras: ClaudeArgExtras,
  ): { key: string; sessionId: string; context: string } | undefined {
    const book = this.opts.sessions;
    const thread = input.thread;
    if (!book || !thread) return undefined;
    // NOT REPOSITORY WORK. A `!code` job stands in its own git worktree, made
    // fresh for the job, so there is nothing to continue — and the folder guard
    // below would refuse it anyway. Saying so here keeps the reason readable.
    if (input.workdir) return undefined;
    try {
      const verdict = decideResume(
        book.find(input.agent.id, thread.key),
        {
          key: thread.key,
          provider: "claude",
          cwd,
          abilities: claudeAbilityFingerprint(input.agent, extras),
        },
        Date.now(),
      );
      if (!verdict.resume) return undefined;
      // LAW 5: ONLY WHAT IS NEW. If the room has nothing new since that session
      // last spoke there is nothing to resume WITH, so the turn runs cold and
      // the agent reads the room — that is the honest answer, not an empty
      // prompt.
      const since = thread.since(verdict.session.lastMessageId ?? "");
      if (!since || !since.trim()) return undefined;
      return { key: thread.key, sessionId: verdict.session.sessionId, context: since };
    } catch (err) {
      // Deciding must never cost a turn. A corrupt file, a folder that cannot be
      // read: run cold, say so in the log, answer the owner.
      console.error("[engine] could not decide whether to continue a session:", err);
      return undefined;
    }
  }

  /** Remember the session this turn ran on, so the next turn in the thread continues it. */
  private rememberSession(
    input: RespondInput, key: string, cwd: string, extras: ClaudeArgExtras,
    sessionId: string | undefined,
  ): void {
    const book = this.opts.sessions;
    if (!book || !input.thread || !sessionId) return;
    try {
      book.remember(input.agent.id, {
        key,
        provider: "claude",
        sessionId,
        cwd,
        abilities: claudeAbilityFingerprint(input.agent, extras),
        lastTurnAt: Date.now(),
        lastMessageId: input.thread.newestMessageId,
      });
    } catch (err) {
      console.error("[engine] could not remember this conversation's session:", err);
    }
  }

  async respond(input: RespondInput): Promise<string> {
    const { agent, workdir, onTrace, onStep } = input;
    const timeoutMs = this.budgetFor(input);
    // its own git worktree when it is working in a repository (`repowork.ts`),
    // its own folder otherwise. One line, and it is the only way a turn can
    // happen anywhere but the agent's folder.
    const cwd = workdir ?? this.opts.agentDataDir(agent.id);
    // THE DOORWAY, opened for this turn only and shut in the `finally` below.
    const doorway = input.channelId
      ? this.opts.cloud9Tools?.({ channelId: input.channelId })
      : undefined;
    const cloud9McpConfigPath = doorway
      ? this.writeCloud9Config(agent.id, doorway) : undefined;
    const extras: ClaudeArgExtras = {
      wholeComputerRoots: this.opts.wholeComputerRoots?.(agent.id) ?? [],
      mcpConfigPath: this.opts.mcpConfigPath?.(agent.id),
      ...(cloud9McpConfigPath ? { cloud9McpConfigPath } : {}),
    };
    /**
     * ONE GO AT THE TURN. Cold when `resumeSessionId` is absent, continuing the
     * agent's own session when it is present — and in the second case `context`
     * is ONLY what is new (law 5: never double-feed).
     *
     * It deliberately does NOT decide anything or call `onTrace`: a resumed
     * attempt that the CLI refuses is not a turn that happened, and must not
     * reach the run record. `respond` below decides which attempt speaks.
     */
    const attempt = async (
      resume?: { sessionId: string; context: string },
    ) => {
      // ONE ANSWER, TWO USES. The prompt is built from what this very argument
      // list will deliver — not from the agent's switches, which is what let an
      // agent be told "you CAN use connected services" while `--mcp-config` was
      // never on the line at all.
      const prompt = buildAgentPrompt(agent, {
        ...input,
        supply: claudeSupply(agent, extras),
        cloud9Tools: !!cloud9McpConfigPath,
        ...(resume ? { context: resume.context, resumedContext: true } : {}),
      });
      const args = claudeArgs(agent, this.opts.models?.() ?? [], {
        ...extras,
        ...(resume ? { resumeSessionId: resume.sessionId } : {}),
      });
      // A SECOND, THROWAWAY READER for the preview — the record below is still
      // built from the whole buffered stdout, unchanged. `undefined` when nobody
      // is watching, which is what keeps an unwatched turn identical to before.
      const watchLine = liveStepWatcher("claude", claudeMapper(), onStep);
      const ran = await this.runner(this.command, args, {
        cwd,
        timeoutMs,
        stdin: prompt,
        // no credential variables: the local app's own login pays for this turn.
        // CLAUDE_ISOLATION_ENV rides alongside — it is part of the same boundary
        // as the flags above, just the part the CLI has no flag for.
        env: envWithoutCredentials(process.env, { ...CLAUDE_ISOLATION_ENV }),
        // THE LIVE VIEW. `claude -p --output-format stream-json` already prints
        // one JSON line per tool call and per result; this feeds each line to
        // the SAME `claudeMapper` the record is built from, as it arrives.
        // Absent when nobody is watching, and ignored by a runner that does not
        // offer it — in both cases the turn is exactly as it was.
        ...(watchLine ? { onStdoutLine: watchLine } : {}),
      });
      return { ran, promptChars: prompt.length };
    };

    let result;
    /** which path the answer we keep came from — goes on the run record */
    let resumed = false;
    /** the thread whose session should be refreshed once this turn lands */
    let rememberKey: string | undefined;
    try {
      const plan = this.planResume(input, cwd, extras);
      rememberKey = plan?.key ?? input.thread?.key;
      let first: Awaited<ReturnType<typeof attempt>> | undefined;
      if (plan) {
        first = await attempt({ sessionId: plan.sessionId, context: plan.context });
        // DID THE CLI REFUSE THE SESSION? Measured shape (2026-08-05): exit 1,
        // `No conversation found with session ID: …` on stderr, an envelope with
        // `num_turns: 0` and no text at all.
        const peek = traceClaude(first.ran.stdout);
        const refused = !first.ran.notFound && !first.ran.timedOut
          && looksLikeRefusedResume(first.ran.stderr, !!peek.text, peek.steps.length);
        if (refused) {
          // THE FALLBACK, AND IT IS TOTAL. Forget the id so the next turn does
          // not walk into the same wall, then run EXACTLY today's cold turn with
          // the whole transcript. A resume failure is never a failed turn.
          try { this.opts.sessions?.forgetThread(agent.id, plan.key); } catch { /* best effort */ }
          console.error("[engine] could not continue this conversation's session — " +
            "starting a fresh one and re-reading the room");
          first = undefined;
        } else {
          resumed = true;
        }
      }
      result = (first ?? await attempt()).ran;
    } finally {
      // The ticket dies with the turn. A copy of the config file left on disk is
      // then worth nothing — but it goes too, because a stale one would point a
      // later run at a doorway that has moved.
      doorway?.close();
      if (cloud9McpConfigPath) {
        try { fs.rmSync(cloud9McpConfigPath, { force: true }); } catch { /* best effort */ }
      }
    }

    if (result.notFound) {
      throw new HarnessUnavailableError("claude", "the Claude app isn't installed on this machine");
    }
    // THE LEASH FIRED. `run()` has already killed the whole process tree by the
    // time this returns (see `killTree`), so nothing is still running — and the
    // error carries the budget so the person is told a CLOCK ran out, in
    // minutes, rather than reading "something went wrong on my side".
    if (result.timedOut) {
      throw new TurnTimedOutError("claude", promptTurnKind(input), timeoutMs);
    }
    // Only the CLI's OWN complaint counts. Scanning the reply text would let a
    // model that merely *talks about* logging in fake a signed-out harness.
    if (result.code !== 0 && looksSignedOut(result.stderr)) {
      throw new HarnessUnavailableError("claude", "the Claude app is not signed in");
    }

    // WHICH PATH THIS ANSWER CAME FROM, on the record, always — `false` as
    // loudly as `true`. "Did it continue the conversation or start over?" is the
    // one question this whole feature is about, and a field that is only present
    // on the good path cannot answer it.
    const trace = { ...traceClaude(result.stdout), resumed };
    // REMEMBER THE SESSION FOR NEXT TIME. Done before `onTrace` so a recorder
    // that falls over cannot cost the thread its continuity — and only when the
    // CLI actually gave us an id.
    if (rememberKey) this.rememberSession(input, rememberKey, cwd, extras, trace.sessionId);
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

  /**
   * Write the one-turn MCP config the CLI is pointed at.
   *
   * A DOT-FILE, in the agent's own folder. Dot-files are the one thing the
   * artifact sweep skips (`artifacts.ts`), so this cannot be mistaken for
   * something the agent made and published into the room. It is never written
   * into a worktree, because a worktree belongs to a git branch.
   *
   * Returns undefined if it could not be written: an agent then takes its turn
   * without Cloud9's tools, and — because the prompt is built from this same
   * answer — is not told it has them.
   */
  private writeCloud9Config(agentId: string, doorway: OpenTurn): string | undefined {
    try {
      // THE TURN'S OWN ID IS IN THE NAME. One fixed name here meant two turns
      // for one agent — which the engine allows — wrote over each other's
      // ticket, so a turn in #general could be answered with #ops history and
      // whichever turn finished first deleted the other's file. See `OpenTurn.id`.
      const target = path.join(
        this.opts.agentDataDir(agentId), `.cloud9-mcp-${doorway.id}.json`);
      fs.writeFileSync(target, cloud9McpConfig(cloud9McpEntry(), doorway), { mode: 0o600 });
      return target;
    } catch (err) {
      console.error("[engine] could not open Cloud9's tool doorway for this turn:", err);
      return undefined;
    }
  }
}

/** Where Cloud9's MCP server lives on disk — beside this compiled file. */
export function cloud9McpEntry(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "cloud9mcp.js");
}

function looksSignedOut(output: string): boolean {
  return /not logged in|please run ["`']?claude \/?login|invalid api key|authentication_error|unauthorized/i
    .test(output);
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find(l => l.trim()) ?? "").slice(0, 160);
}
