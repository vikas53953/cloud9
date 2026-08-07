// CodexProvider — runs an agent turn on the locally installed Codex CLI.
//
// Same seam as MockProvider/SdkProvider (harness-signin.md decision 2). Each
// turn copies only Codex's auth.json into a disposable home so the CLI remains
// signed in without inheriting the owner's config, rules or two skill roots.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef, effortLevelFor, MODEL_ID_RE, validateAgentInput } from "@cloud9/shared";
import {
  buildAgentPrompt, ClaudeProvider, HarnessAbilityBoundaryError, HarnessUnavailableError,
  RespondInput,
} from "./provider.js";
import {
  CAPABILITIES, codexSandboxFor, codexUnavoidableCapabilities, codexWebSearchFor,
  effectiveAbilities, grantedSupply, reachesBeyondOwnFolder, withEffectiveAbilities,
} from "./abilities.js";
import { envWithoutCredentials } from "./env.js";
// ONE OWNER for "isolated, or the owner's own setup" — read by this file and by
// claude-cli.ts, so the two harnesses can never drift apart on the question.
import {
  codexDisabledBySetup, codexSetupFlags, codexUsesDisposableHome, SetupChoice,
} from "./ownersetup.js";
import { NO_TIME_LIMIT, run, Runner, safeArg } from "./run.js";
import {
  baseName, EventMapper, ProviderTrace, RunStepKind, traceFromStream,
} from "./runrecord.js";
import { liveStepWatcher } from "./livesteps.js";
import { OpenTurn } from "./toolbridge.js";

export interface CodexProviderOptions {
  /** where the agent's turn runs (its own files folder) */
  agentDataDir: (agentId: string) => string;
  /** command name — overridden by tests with a shim */
  command?: string;
  /**
   * Fallback Codex API key, read fresh each turn so a settings change takes
   * effect immediately. It is passed to the CLI as CODEX_API_KEY and MUST NOT
   * touch any ANTHROPIC_* variable — these are separate accounts.
   *
   * Absent (the normal case) means the CLI-login path: the Codex app is signed
   * in and owns its own credential, and we pass nothing.
   */
  apiKey?: () => string | undefined;
  /** the models this harness offers; a turn is refused for anything else */
  models?: () => string[];
  /**
   * Folders an agent with the `wholeComputer` switch may write in, asked fresh
   * per turn. Ignored entirely for an agent without that switch.
   */
  wholeComputerRoots?: (agentId: string) => string[];
  /**
   * OPEN CLOUD9'S OWN DOORWAY FOR ONE TURN — search, opening an attachment,
   * writing one note into this agent's own memory, each already scoped to this
   * conversation and this agent by the engine that opens it.
   *
   * The exact twin of `ClaudeCliProviderOptions.cloud9Tools`, so both harnesses
   * are handed the same doorway by the same engine method. Left out (a test, an
   * older caller) means a turn simply has no Cloud9 tools, and the prompt is
   * built from the same answer so nothing is promised.
   */
  cloud9Tools?: (turn: { channelId: string; agentId?: string }) => OpenTurn | undefined;
  runner?: Runner;
}

export interface CodexTranscript {
  /** the agent's final chat message */
  text: string;
  /** conversation id from the first event, for logs */
  threadId?: string;
  /** how many JSONL events we understood */
  events: number;
  /** a turn-level failure reported by the CLI */
  error?: string;
}

export interface CodexAbilityBoundaryProblem {
  ability: string;
  label: string;
  tools: readonly string[];
}

/**
 * The Codex tools Cloud9 cannot subtract, read against the switches EXACTLY AS
 * GIVEN — no interpretation, on purpose.
 *
 * THE BACKSTOP, AND WHY IT IS NOW ALMOST ALWAYS SILENT. Since
 * `effectiveAbilities()` forces these rows on for any agent whose app is Codex,
 * nothing the app can build reaches this with them off, and `codexArgs` asks it
 * about the EFFECTIVE definition. What is left for it to catch is a definition
 * that came from somewhere else: an agent whose own app is not Codex being put
 * on the Codex command line, or a caller that skipped the helper. That is a real
 * contradiction and it still stops the turn.
 */
export function codexAbilityBoundaryProblems(agent: AgentDef): CodexAbilityBoundaryProblem[] {
  return codexUnavoidableCapabilities()
    .filter(cap => agent.abilities?.[cap.ability] !== true)
    .map(cap => ({
      ability: String(cap.ability), label: cap.label, tools: cap.codexUnavoidableTools ?? [],
    }));
}

function enforceCodexAbilityBoundary(agent: AgentDef): void {
  const problems = codexAbilityBoundaryProblems(agent);
  if (problems.length === 0) return;
  throw new HarnessAbilityBoundaryError("Codex", problems.map(problem => problem.label));
}

export interface CodexIsolatedEnvironment {
  env: NodeJS.ProcessEnv;
  dispose: () => void;
}

export interface CodexIsolatedEnvironmentOptions {
  baseEnv?: NodeJS.ProcessEnv;
  apiKey?: string;
  /**
   * THIS TURN'S TICKET for Cloud9's own tool doorway, in the child's
   * ENVIRONMENT and never on a command line — the same law the Claude path
   * follows (`cloud9tools.ts`): any process on this machine can read another
   * one's command line, and none of them can read its environment. Codex is
   * told only the NAME of this variable and reads the value itself.
   */
  toolSecret?: string;
  /** overridden by tests; defaults to the owner's current CODEX_HOME */
  ownerCodexHome?: string;
  /** overridden by tests; defaults to the real OS user home */
  ownerUserHome?: string;
  /**
   * THE AGENT WHOSE SETUP CHOICE DECIDES THIS (`ownersetup.ts`). Absent — and an
   * agent with the switch off — gets the one-turn home exactly as before. An
   * agent running in his own setup gets his REAL `CODEX_HOME` and home folder,
   * which is what makes his `config.toml`, his AGENTS.md and both skill roots
   * load. The credential stripping below happens either way.
   */
  agent?: SetupChoice;
}

export const CODEX_ISOLATION_PROFILE = "cloud9-isolated";

/**
 * Give Codex a one-turn home containing only its login. Both skill roots are
 * absent there. Codex resolves `~/.agents/skills` through the Windows profile
 * API rather than the child environment, so the one-turn profile also disables
 * every owner skill by its exact path.
 */
export function createCodexIsolatedEnvironment(
  options: CodexIsolatedEnvironmentOptions = {},
): CodexIsolatedEnvironment {
  const baseEnv = options.baseEnv ?? process.env;
  // --- HIS OWN SETUP: no throwaway home at all (ownersetup.ts) ---------------
  // Codex finds his config.toml, his AGENTS.md and his skills through CODEX_HOME
  // and the user profile, so "run in his setup" is exactly "do not move them".
  // THE CREDENTIAL STRIPPING STILL HAPPENS — that is the line that does not move
  // whichever mode this is, and it is the same `envWithoutCredentials` the
  // Claude path calls. Nothing is created, so `dispose` has nothing to delete.
  if (!codexUsesDisposableHome(options.agent)) {
    return {
      env: envWithoutCredentials(baseEnv, {
        ...(options.apiKey ? { CODEX_API_KEY: options.apiKey } : {}),
        ...(options.toolSecret ? { [CODEX_TOOL_SECRET_ENV]: options.toolSecret } : {}),
      }),
      dispose: () => { /* nothing was made, so there is nothing to throw away */ },
    };
  }
  // ---------------------------------------------------------------------------
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud9-codex-"));
  const codexHome = path.join(root, "codex");
  const userHome = path.join(root, "profile");
  const ownerUserHome = options.ownerUserHome
    ?? baseEnv.USERPROFILE
    ?? baseEnv.HOME
    ?? os.homedir();
  const ownerCodexHome = options.ownerCodexHome
    ?? baseEnv.CODEX_HOME
    ?? path.join(ownerUserHome, ".codex");
  try {
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(userHome, { recursive: true, mode: 0o700 });

    if (!options.apiKey) {
      const ownerAuth = path.join(ownerCodexHome, "auth.json");
      if (fs.existsSync(ownerAuth)) {
        const isolatedAuth = path.join(codexHome, "auth.json");
        fs.copyFileSync(ownerAuth, isolatedAuth);
        try { fs.chmodSync(isolatedAuth, 0o600); } catch { /* Windows ACLs own this */ }
      }
    }
    writeSkillIsolationProfile(codexHome, [
      path.join(ownerCodexHome, "skills"),
      path.join(ownerUserHome, ".agents", "skills"),
    ]);

    const env = envWithoutCredentials(baseEnv, {
      ...(options.apiKey ? { CODEX_API_KEY: options.apiKey } : {}),
      ...(options.toolSecret ? { [CODEX_TOOL_SECRET_ENV]: options.toolSecret } : {}),
      CODEX_HOME: codexHome,
      HOME: userHome,
      USERPROFILE: userHome,
    });
    return {
      env,
      dispose: () => fs.rmSync(root, { recursive: true, force: true }),
    };
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

function writeSkillIsolationProfile(codexHome: string, roots: string[]): void {
  const skills = roots.flatMap(skillFilesUnder);
  const entries = skills.map(file =>
    `[[skills.config]]\npath = ${JSON.stringify(path.resolve(file).replace(/\\/g, "/"))}\nenabled = false\n`,
  );
  fs.writeFileSync(
    path.join(codexHome, `${CODEX_ISOLATION_PROFILE}.config.toml`),
    "# Cloud9 one-turn profile: owner skills are deliberately disabled.\n" + entries.join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );
}

function skillFilesUnder(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const found: string[] = [];
  const visited = new Set<string>();
  const visit = (dir: string): void => {
    const real = fs.realpathSync(dir);
    if (visited.has(real)) return;
    visited.add(real);
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const target = entry.isSymbolicLink() ? fs.statSync(full) : entry;
      if (target.isDirectory()) visit(full);
      else if (target.isFile() && entry.name.toLowerCase() === "skill.md") found.push(full);
    }
  };
  visit(root);
  return found;
}

/**
 * How to read ONE `codex exec --json` event. The shared walker in runrecord.ts
 * does the line splitting, JSON parsing, counting and capping for both
 * providers — this only says what each event MEANS.
 *
 * Shape verified live against CLI 0.146.0 on 2026-07-29:
 *   {"type":"thread.started","thread_id":"019fac7b-…"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"…"}}
 *   {"type":"item.started","item":{"id":"item_2","type":"command_execution",
 *      "command":"…","exit_code":null,"status":"in_progress"}}
 *   {"type":"item.completed","item":{"id":"item_2","type":"command_execution",
 *      "command":"…","aggregated_output":"…","exit_code":0,"status":"completed"}}
 *   {"type":"turn.completed","usage":{"input_tokens":50710,"cached_input_tokens":24320,
 *      "cache_write_input_tokens":0,"output_tokens":249,"reasoning_output_tokens":125}}
 *
 * Two events describe one command, so started items are remembered by id and
 * finished in place: a turn we kill half-way still shows what it had started.
 *
 * An `item` of type `error` is an item-level note (Codex uses it for things like
 * "skill descriptions were shortened"), NOT a failed turn. Only `turn.failed`
 * and a top-level `error` end the run.
 */
export function codexMapper(): EventMapper {
  const started = new Map<string, number | undefined>();

  return (ev, t) => {
    const type = String(ev.type ?? "");

    if (type === "thread.started") {
      const id = str(ev.thread_id) ?? str((ev.thread as Record<string, unknown>)?.id);
      if (id) t.set({ sessionId: id });
      return;
    }
    if (type === "turn.completed") {
      const u = ev.usage as Record<string, unknown> | undefined;
      if (u) {
        t.set({
          usage: pick({
            inputTokens: num(u.input_tokens),
            outputTokens: num(u.output_tokens),
            cachedInputTokens: num(u.cached_input_tokens),
            cacheWriteTokens: num(u.cache_write_input_tokens),
            reasoningTokens: num(u.reasoning_output_tokens),
            // WHAT WAS REALLY HANDED OVER, IN CODEX'S OWN ACCOUNTING — and here
            // that is `input_tokens` BY ITSELF. Codex counts the way OpenAI
            // does: `input_tokens` is the TOTAL and `cached_input_tokens` is the
            // part of it that came from the cache. Adding the two would count
            // the cache twice, which is the exact opposite of the mistake the
            // Claude mapper had to fix — and is why this figure is computed in
            // each provider's own file rather than once in shared. See the
            // warning on `RunUsage`.
            handedToIt: num(u.input_tokens),
            // Codex reports no money figure. Absent means absent — we do not
            // multiply tokens by a price we would be guessing at.
          }),
        });
      }
      return;
    }
    if (type === "turn.failed" || type === "error") {
      t.setError(str(ev.message)
        ?? str((ev.error as Record<string, unknown>)?.message)
        ?? "the Codex turn failed");
      return;
    }
    if (type !== "item.started" && type !== "item.completed") return;

    const item = ev.item as Record<string, unknown> | undefined;
    if (!item) return;
    const id = str(item.id);
    const kind = String(item.type ?? "");
    const finished = type === "item.completed";

    if (kind === "agent_message") {
      if (!finished) return;
      const said = itemText(item);
      if (!said) return;
      t.setText(said);
      t.add({ kind: "message", label: "Said something", detail: said });
      return;
    }
    if (kind === "reasoning") {
      if (!finished) return;
      const thought = itemText(item);
      if (thought) t.add({ kind: "thinking", label: "Thought it through", detail: thought });
      return;
    }
    if (kind === "error") {
      // item-level note, not a failed turn
      if (finished) t.add({ kind: "note", label: "Codex reported", detail: str(item.message) });
      return;
    }

    const step = describeCodexItem(item, kind);
    if (!step) return;

    if (id && started.has(id)) {
      if (finished) t.update(started.get(id), { ok: step.ok, detail: step.detail });
      return;
    }
    const seq = t.add(step);
    if (id) started.set(id, seq);
  };
}

/** One Codex item → one step in the shared vocabulary. Unknown types survive. */
function describeCodexItem(
  item: Record<string, unknown>, kind: string,
): { kind: RunStepKind; label: string; detail?: string; ok?: boolean } | undefined {
  const exit = num(item.exit_code);
  const status = str(item.status);
  // "ok" ONLY when the CLI actually said so
  const ok = typeof exit === "number" ? exit === 0
    : status === "failed" ? false
      : status === "completed" ? true : undefined;

  switch (kind) {
    case "command_execution":
      return { kind: "command", label: "Ran a command", detail: str(item.command), ok };
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const names = changes
        .map(c => str((c as Record<string, unknown>)?.path))
        .filter((n): n is string => !!n)
        .map(baseName);
      return {
        kind: "write",
        label: names.length === 1 ? `Changed ${names[0]}` : `Changed ${names.length || ""} files`.trim(),
        detail: names.join(", ") || str(item.path),
        ok,
      };
    }
    case "web_search":
      return { kind: "web", label: "Searched the web", detail: str(item.query), ok };
    case "mcp_tool_call":
      return {
        kind: "tool",
        label: `Used ${str(item.server) ?? "a"} tool ${str(item.tool) ?? ""}`.trim(),
        detail: str(item.tool),
        ok,
      };
    case "todo_list":
      return undefined; // its own plan, not something it did
    default:
      // a Codex item type we have never seen still shows up as a real step
      return { kind: "tool", label: `Used ${kind.replace(/_/g, " ")}`, ok };
  }
}

/**
 * Parse `codex exec --json` output down to the reply text.
 *
 * Kept as the narrow view for callers that only want the sentence; it is built
 * on the SAME walker and mapper the run record uses, so the two can never
 * disagree about what a transcript said.
 */
export function parseCodexJsonl(raw: string): CodexTranscript {
  const trace = traceCodex(raw);
  return {
    text: trace.text,
    threadId: trace.sessionId,
    events: trace.events,
    error: trace.error,
  };
}

/** The full trace of a Codex turn: every step, plus tokens when reported. */
export function traceCodex(raw: string): ProviderTrace {
  return traceFromStream(raw, "codex", codexMapper());
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Drop the keys the CLI did not report, so absent stays absent in the record. */
function pick<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

function itemText(item: Record<string, unknown>): string {
  const direct = str(item.text);
  if (direct) return direct;
  const content = item.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(part => typeof part === "string" ? part : str((part as Record<string, unknown>)?.text) ?? "")
      .join("");
  }
  return "";
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * Codex's half of "an agent runs in a declared environment, not the owner's".
 *
 *  - `--ignore-user-config` does not load `$CODEX_HOME/config.toml` — the file
 *    holding the owner's MCP servers, feature switches, personality and (on
 *    this machine) a very large injected multi-agent orchestration policy.
 *    Crucially it says "auth still uses CODEX_HOME", so the login survives.
 *    That is the constraint that rules out simply pointing CODEX_HOME at an
 *    empty folder, which would sign the agent out.
 *  - `--ignore-rules` does not load the owner's or the project's execpolicy
 *    `.rules` files.
 *
 * These two are NOT enough on their own; see CODEX_ALWAYS_DISABLED below for
 * the owner's surfaces a second pass closes.
 *
 * WHAT THE CLI CANNOT CLOSE, re-measured 2026-07-29 on codex-cli 0.146.0:
 *  - **Codex has no equivalent of Claude's `--tools`.** `codex --help` and
 *    `codex exec --help` were both read at 0.146.0; there is no such flag. The
 *    built-in set cannot be DECLARED, only whittled at.
 *  - `collaboration.*` (6 tools, including `spawn_agent`) survived
 *    `--disable multi_agent` AND `-c agents.max_depth=0` on a live turn.
 *  - `web.run` survived `-c tools.web_search=false` on a live turn.
 *  - `functions.exec` / `shell_command` / `apply_patch` cannot be removed at
 *    all; what holds them back is the sandbox, which is a fence, not an absence.
 *  - the owner's skills still load. `skills.enabled=false`,
 *    `include_skills_usage_instructions=false` and `skills.disabled_skill_names`
 *    were each rendered through `codex debug prompt-input` and each changed
 *    nothing (49 skills before, 49 after). Worse, they come from TWO roots:
 *    `$CODEX_HOME/skills` and `~/.agents/skills`. Pointing CODEX_HOME at a
 *    Cloud9-owned folder drops the first — and signs the agent out: with a
 *    fresh CODEX_HOME, `codex login status` printed "Not logged in" where the
 *    real one printed "Logged in using ChatGPT". Exactly the trap
 *    CLAUDE_CONFIG_DIR set for the Claude path. `~/.agents/skills` is not under
 *    CODEX_HOME at all and stayed loaded even then.
 *
 * Cloud9 therefore does not launch an ability mix the CLI cannot honour.
 * `enforceCodexAbilityBoundary` refuses the whole turn when web, files, helpers
 * or commands are off. It is less flexible than Claude's declared set, but it
 * is a real gate: a denied tool never reaches a running agent. The disposable
 * homes in `createCodexIsolatedEnvironment` separately close both skill roots.
 *
 * ============================================================================
 * …AND ALL OF THAT IS NOW ONE OF TWO CHOICES. (2026-08-05)
 * ============================================================================
 *
 * Everything above describes the DECLARED environment — what a Codex agent gets
 * when the owner has not asked for his own setup. He has asked for the other
 * one, so the lists themselves moved to `ownersetup.ts`, the single owner of
 * "isolated, or his setup", which the Claude path reads too. The constants are
 * re-exported from here so every existing caller and test keeps working against
 * one definition; `codexSetupFlags(agent)` and `codexDisabledBySetup(agent)` are
 * what this file now asks.
 */
export { CODEX_ISOLATION_FLAGS, CODEX_ALWAYS_DISABLED } from "./ownersetup.js";

// ===========================================================================
// CLOUD9'S OWN TOOLS, ON CODEX (gap B, measured 2026-08-05/06 on 0.146.0)
// ===========================================================================
//
// WHAT WAS WRONG. There was no MCP path in this file at all. `search_conversation`
// and `open_attachment` — Cloud9's own doorway back into the conversation the
// agent is already reading — were on every Claude turn and on no Codex turn. A
// Codex agent asked "what does budget-q3.xlsx say?" could see the NAME of the
// file in its context and had no way to open it, and could not search a word
// said further back than its budget. The comment in `respond` below said the
// truthful half ("Codex has no MCP config at all in Cloud9") and left the gap.
//
// WHAT WAS MEASURED, on the installed CLI, with real turns:
//
//  1. **A `$CODEX_HOME/<name>.config.toml` profile is NOT read when
//     `--ignore-user-config` is on.** Proved with `--strict-config` and a
//     nonsense key as a tracer: the same profile errors the turn without
//     `--ignore-user-config` and is silently ignored with it. So Cloud9's
//     existing one-turn profile is inert on an isolated turn, and writing MCP
//     servers into it does nothing — a live turn confirmed it, the tool never
//     appeared.
//  2. **`-c` overrides ARE honoured with `--ignore-user-config` on.** They are
//     therefore the only channel into an isolated turn, and they are enough.
//  3. **`mcp_servers.<name>.url` works — a streamable-HTTP MCP server.** Codex
//     POSTs JSON-RPC to the URL and accepts a plain JSON answer, which is
//     EXACTLY the shape Cloud9's `ToolBridge` already speaks. No second process,
//     no stdio proxy, nothing new listening: the doorway the Claude path opens
//     for the turn is the same doorway Codex is pointed at.
//  4. **`bearer_token_env_var` names an environment variable**, and Codex sends
//     `Authorization: Bearer <that value>`. The ticket therefore stays out of
//     the command line, exactly as it does on the Claude side.
//  5. **`default_tools_approval_mode=approve` is required.** Without it the
//     tool call comes back "user cancelled MCP tool call" — `codex exec` is
//     non-interactive, so an approval request has nobody to ask and is refused.
//     The valid values are `auto`, `prompt`, `writes`, `approve` (the CLI says
//     so itself when handed anything else). This does NOT widen what an agent
//     may do: the tools it approves are Cloud9's own three, each already bound
//     to this one conversation and this one agent by the engine, and each
//     already ungated on the Claude path.
//  6. **`--disable apps` and `--disable plugins` do not touch this.** The whole
//     isolation set was on the command line for every probe above: throwaway
//     CODEX_HOME and user home, `--ignore-user-config`, `--ignore-rules`,
//     `--ephemeral`, and all seven `--disable` switches. The owner's own MCP
//     servers stayed out; Cloud9's arrived.
//
// EVERY VALUE HERE IS ALLOWLIST-CLEAN. `run.ts` refuses quotes, brackets and
// braces in an argument — which is why the owner's connections file cannot come
// this way (see `connections.ts`) and why this one can: a loopback URL, a
// variable NAME and one word are all made of characters `safeArg` accepts.

/**
 * The environment variable Codex is told to read this turn's ticket from. The
 * same name `cloud9McpConfig` puts in the Claude child's environment, so there
 * is one spelling of "the ticket" in the product.
 */
export const CODEX_TOOL_SECRET_ENV = "CLOUD9_TOOL_SECRET";

/** The MCP server name Codex will namespace Cloud9's tools under. */
export const CODEX_CLOUD9_SERVER = "cloud9";

/**
 * The `-c` overrides that put Cloud9's own doorway on a Codex command line.
 *
 * No ticket (the bridge is not listening, or the turn has no conversation) means
 * NO ARGUMENTS AT ALL — and because `respond` builds the prompt from this same
 * answer, an agent is never told about a doorway that is not there.
 */
export function codexCloud9ToolArgs(ticket?: { url: string }): string[] {
  if (!ticket?.url) return [];
  const s = CODEX_CLOUD9_SERVER;
  return [
    "-c", `mcp_servers.${s}.url=${safeArg(ticket.url)}`,
    "-c", `mcp_servers.${s}.bearer_token_env_var=${CODEX_TOOL_SECRET_ENV}`,
    // see measurement 5 above — without this every call is cancelled unasked
    "-c", `mcp_servers.${s}.default_tools_approval_mode=approve`,
  ];
}

/**
 * The features switched off for THIS agent: whatever the setup choice takes
 * away, plus every feature a capability row would have kept on that this agent
 * was not given. Today the second part is exactly one — `multi_agent`, owned by
 * the `helpers` switch — but it is derived from the table rather than listed
 * here, so a second one cannot be added to the table and forgotten on the
 * command line.
 *
 * THE FIRST PART IS NOW A CHOICE, and `ownersetup.ts` owns it. In the declared
 * environment it is the whole of `CODEX_ALWAYS_DISABLED`, exactly as before. In
 * his-setup mode it is only `CODEX_NEVER_ENABLED` — his plugins, his connected
 * apps, his memories and his hooks load, while driving his actual desktop or his
 * signed-in browser stays off at every setting, because that is an agent being
 * HIM rather than an agent using his settings.
 *
 * `multi_agent` did NOT remove `collaboration.*` when measured on 0.146.0, so an
 * agent with helpers off is refused before this list reaches a command line.
 * The mapping remains for the day a newer CLI honours it.
 */
export function codexDisabledFeaturesFor(agent: AgentDef): string[] {
  const off = [...codexDisabledBySetup(agent)] as string[];
  const has = effectiveAbilities(agent);
  for (const cap of CAPABILITIES) {
    if (cap.codexFeature && has[cap.ability] !== true) off.push(cap.codexFeature);
  }
  return off;
}

/**
 * Build the `codex exec` argument list for an agent.
 * Abilities first gate admission; an admitted agent may write inside its own
 * folder. Approvals are never interactive.
 *
 * The agent definition comes from a client, so it is re-validated HERE, at the
 * moment it would become a command line — the relay's check is the first gate,
 * this is the last one, and neither trusts the other.
 *
 * QUOTING HAS EXACTLY ONE OWNER: `run.ts`. This function hands over the plain
 * path and nothing else. Round 2 quoted it here as well, so `run()` saw an
 * argument that already had quotes in it, rejected those quotes as unsafe
 * characters, and every single Codex turn failed for anyone whose Windows user
 * folder has a space in it (finding #4). Two layers both trying to be careful
 * produced something neither of them would accept. The cwd is ALSO passed
 * through `RunOptions.cwd`, exactly as the Claude path does it.
 */
export interface CodexArgExtras {
  /**
   * CLOUD9'S OWN DOORWAY for this turn — the loopback ticket from `ToolBridge`.
   * Deliberately its own slot and NOT the owner's connections file: that one is
   * gated behind the `connections` switch and cannot be carried on a Codex
   * command line at all (`connections.ts` says so in the owner's words), while
   * this is Cloud9 handing an agent a way to search the conversation it is
   * already reading.
   */
  cloud9Tool?: { url: string };
}

export function codexArgs(
  rawAgent: AgentDef, cwd: string, models: string[] = [], wholeComputerRoots: string[] = [],
  extras: CodexArgExtras = {},
): string[] {
  const problem = validateAgentInput(rawAgent, { models });
  if (problem) throw new Error(`refusing to run this agent: ${problem}`);
  // WHAT THIS AGENT REALLY HAS, asked once, at the top. A Codex agent holds the
  // unremovable built-ins whatever its stored switches say, so an agent saved
  // before that rule existed runs instead of being refused forever. Everything
  // below reads THIS definition — sandbox, features, web switch — so no line of
  // this command can be built from a different answer.
  const agent = withEffectiveAbilities(rawAgent);
  enforceCodexAbilityBoundary(agent);

  const args = [
    "exec", "--json", "--color", "never", "--skip-git-repo-check",
    "-C", cwd,
    // the sandbox comes from the same table that writes the sentences the agent
    // reads about itself (abilities.ts) — one rule, two faces
    "-s", codexSandboxFor(agent),
  ];
  // --- WHOSE SETUP DOES THIS AGENT RUN IN? (ownersetup.ts) -------------------
  // The one-turn profile lives in the throwaway CODEX_HOME and exists ONLY in
  // the declared environment; naming a profile that is not there would fail the
  // turn before the model was reached. `codexUsesDisposableHome` is the same
  // answer `createCodexIsolatedEnvironment` uses to decide whether to write it,
  // so the flag and the folder cannot disagree.
  if (codexUsesDisposableHome(agent)) args.push("-p", CODEX_ISOLATION_PROFILE);
  if (agent.model) {
    if (!MODEL_ID_RE.test(agent.model)) throw new Error("refusing to run this agent: bad model id");
    args.push("-m", safeArg(agent.model));
  }
  // …and the isolation flags themselves: all of them, or none of them. EMPTY
  // when he has switched this agent to his own Codex setup, which is the whole
  // of the change — his config.toml, his AGENTS.md, his MCP servers and his
  // rules then load exactly as they do when he runs `codex` himself.
  args.push("-c", "approval_policy=never", "--ephemeral", ...codexSetupFlags(agent));
  // ---------------------------------------------------------------------------
  // Every feature switch this agent's switches say to take away — the owner's
  // own setup unless he asked for it, plus anything a capability row would have
  // kept on.
  for (const feature of codexDisabledFeaturesFor(agent)) args.push("--disable", feature);
  // Beyond its own folder, only when that switch is on. `--add-dir` is the CLI's
  // own flag ("Additional directories that should be writable alongside the
  // primary workspace", `codex exec --help` at 0.146.0). Paths go through RAW:
  // quoting has exactly one owner, see the note above.
  if (reachesBeyondOwnFolder(agent)) {
    for (const root of wholeComputerRoots) args.push("--add-dir", root);
  }
  // The only per-tool switch Codex has (`[tools] web_search`), driven by the
  // same table that writes the sentence the agent reads about itself. It did
  // NOT remove `web.run` when measured — that is recorded in isolation.ts, not
  // papered over — but it is the switch the CLI offers and it follows the toggle
  // in BOTH directions, so an agent that was never allowed the web is at least
  // never handed it on purpose.
  args.push("-c", `tools.web_search=${codexWebSearchFor(agent)}`);
  // ==================================================================
  // HOW HARD THIS AGENT SHOULD THINK (gap B, measured 2026-08-05 on 0.146.0).
  // ==================================================================
  //
  // Codex has NO `--effort` flag — `codex exec --help` was read in full and
  // there is nothing of the kind. The dial it does have is a config value, and
  // this is the CLI's own documented way to set one (`-c key=value`). Proved on
  // live turns rather than read: `model_reasoning_effort=high` ran normally,
  // and a nonsense value came back as a real refusal from the service
  // ("[ReasoningEffortParam] [reasoning.effort] [invalid…]"), which is how we
  // know the key is the right one and is not being quietly ignored.
  //
  // The LEVEL comes from the one owner of that table (@cloud9/shared,
  // effort.ts), never from a mapping written here — and see that file for why
  // "Hardest" is `xhigh` on Codex and `max` on Claude: four of the nine models
  // `codex debug models` lists on this machine refuse anything above `xhigh`,
  // so `max` would have been a setting that worked for some agents and broke
  // others. Undefined for an agent that has never been given a choice, and the
  // line then says nothing at all, exactly as it always did.
  const effort = effortLevelFor("codex", agent.effort);
  if (effort) args.push("-c", `model_reasoning_effort=${safeArg(effort)}`);
  // CLOUD9'S OWN TOOLS. Ungated, for the same reason they are ungated on the
  // Claude path: reading the room you are standing in is not a new power — every
  // agent, on every rung, is already handed the recent messages of it. Absent
  // when no doorway was opened, and the prompt is built from the same answer.
  args.push(...codexCloud9ToolArgs(extras.cloud9Tool));
  // NOT SET, and the reason is worth keeping. `-c agents.max_depth=0` looked
  // like the way to stop an agent spawning further agents. Running it proved
  // two things: it does not remove `collaboration.spawn_agent` (it was still in
  // the tool list on a live probe turn), and the CLI REFUSES the value outright
  // — "Error: agents.max_depth must be at least 1", exit 1, before the model is
  // even reached. Shipping it would have broken every Codex turn on the machine,
  // which is exactly what happened once before with the quoting fix. A flag that
  // does not close the hole is not worth a command line that does not run.
  return args;
}

export class CodexProvider implements ClaudeProvider {
  private runner: Runner;
  private command: string;

  constructor(private opts: CodexProviderOptions) {
    this.runner = opts.runner ?? run;
    this.command = opts.command ?? "codex";
  }

  async respond(input: RespondInput): Promise<string> {
    const { agent, workdir, onTrace, onStep } = input;
    // its own git worktree when it is working in a repository (`repowork.ts`),
    // its own folder otherwise. `codexArgs` puts the same folder in `-C`, so
    // the sandbox root and the working folder cannot drift apart.
    const cwd = workdir ?? this.opts.agentDataDir(agent.id);
    const roots = this.opts.wholeComputerRoots?.(agent.id) ?? [];
    // THE DOORWAY, opened for this turn only and shut in the `finally` below —
    // the same call, on the same engine method, that the Claude path makes.
    const doorway = input.channelId
      ? this.opts.cloud9Tools?.({ channelId: input.channelId, agentId: agent.id })
      : undefined;
    const args = codexArgs(agent, cwd, this.opts.models?.() ?? [], roots,
      doorway ? { cloud9Tool: { url: doorway.url } } : {});
    // THE SAME ONE ANSWER the Claude path uses. The owner's CONNECTIONS FILE is
    // still genuinely never supplied here — `connections.ts` explains, in his
    // words, why a Codex agent cannot be handed one without either breaking its
    // isolation or putting quotes and brackets on a command line `run.ts`
    // rightly refuses — so a Codex agent with the `connections` switch on is
    // told, truthfully, that nothing is connected for it.
    //
    // CLOUD9'S OWN TOOLS ARE A DIFFERENT QUESTION and, since 2026-08-06, a
    // different answer: `cloud9Tools` above is true whenever the doorway really
    // opened, so the agent is told about `search_conversation` and
    // `open_attachment` exactly when it really has them, and never otherwise.
    //
    // ONE MESSAGE, ON PURPOSE — the prompt split (gap A) STOPS HERE, and this is
    // not an oversight to be tidied up later. Codex has no way to send a system
    // prompt alongside a turn: `codex exec --help` was read in full at 0.146.0
    // and there is no `--system-prompt`, no `--append-system-prompt` and no file
    // form of either. The only thing in reach is `base_instructions`, which
    // REPLACES Codex's own base instructions wholesale — it would take the
    // harness's entire operating brief away to make room for ours, which is a far
    // bigger change than "send the standing half separately" and not one anybody
    // asked for. So the Codex path keeps `buildAgentPrompt`, which is still the
    // two halves joined in the same order, byte for byte, exactly as before.
    const prompt = buildAgentPrompt(agent, {
      ...input,
      supply: grantedSupply(agent, { wholeComputerRoots: roots }),
      harness: "codex",
      cloud9Tools: !!doorway,
    });
    const key = this.opts.apiKey?.();
    // WHOSE SETUP THIS TURN RUNS IN, asked with the agent in hand — the same
    // answer `codexArgs` above used for the flags and the profile. The ticket
    // rides in the environment, never in argv.
    const isolated = createCodexIsolatedEnvironment({
      apiKey: key, agent, ...(doorway ? { toolSecret: doorway.secret } : {}),
    });
    // The preview's own reader — see the twin in claude-cli.ts. `codex exec
    // --json` prints one JSON line per item, so the SAME `codexMapper` that
    // builds the record understands them one at a time.
    const watchLine = liveStepWatcher("codex", codexMapper(), onStep);
    let result;
    try {
      result = await this.runner(this.command, args, {
        cwd,
        // NO CLOCK — the same as the Claude path, for the same reason. A turn
        // ends when it finishes, fails, or the owner stops it (`timebudget.ts`).
        timeoutMs: NO_TIME_LIMIT,
        stdin: prompt,
        ...(watchLine ? { onStdoutLine: watchLine } : {}),
        // The child gets a disposable CODEX_HOME and user home. Only Codex's
        // login is copied in; both owner skill roots stay outside the process.
        env: isolated.env,
      });
    } finally {
      isolated.dispose();
      // SHUT THE DOORWAY. The ticket stops working the moment the turn ends, so
      // a copy of it taken from the child's environment is worth nothing after
      // this line — the same law the Claude path lives under.
      try { doorway?.close(); } catch { /* a doorway that will not shut is still shut by the bridge */ }
    }

    if (result.notFound) {
      throw new HarnessUnavailableError("codex", "the Codex app isn't installed on this machine");
    }
    // Only the CLI's OWN complaint counts. Scanning stdout would let a model
    // that merely *talks about* logging in fake a signed-out harness.
    if (result.code !== 0 && looksSignedOut(result.stderr)) {
      throw new HarnessUnavailableError("codex", "Codex is not signed in");
    }

    const trace = traceCodex(result.stdout);
    // Recording must never cost the owner an answer: a broken recorder is a
    // logged problem, not a failed turn.
    // NOTE: no `model` is set. Codex's stream never names the model it used, so
    // the record keeps only the model we ASKED for. Filling `actualModel` in
    // from our own request would be Cloud9 confirming Cloud9.
    try { onTrace?.(trace); } catch (err) {
      console.error("[engine] could not record what Codex did:", err);
    }

    if (result.code !== 0 && !trace.text) {
      throw new Error(`Codex exited with ${result.code}: ${firstLine(result.stderr)}`);
    }
    if (trace.error && !trace.text) throw new Error(trace.error);
    return trace.text || "(no response)";
  }
}

function looksSignedOut(output: string): boolean {
  return /not logged in|please run ["`']?codex login|authentication required|unauthorized/i.test(output);
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find(l => l.trim()) ?? "").slice(0, 160);
}
