// CodexProvider — runs an agent turn on the locally installed Codex CLI.
//
// Same seam as MockProvider/SdkProvider (harness-signin.md decision 2). Each
// turn copies only Codex's auth.json into a disposable home so the CLI remains
// signed in without inheriting the owner's config, rules or two skill roots.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentDef, MODEL_ID_RE, validateAgentInput } from "@cloud9/shared";
import {
  buildAgentPrompt, ClaudeProvider, HarnessAbilityBoundaryError, HarnessUnavailableError, RespondInput,
} from "./provider.js";
import {
  CAPABILITIES, codexSandboxFor, codexUnavoidableCapabilities, codexWebSearchFor,
  grantedSupply, reachesBeyondOwnFolder,
} from "./abilities.js";
import { envWithoutCredentials } from "./env.js";
import { run, Runner, safeArg } from "./run.js";
import {
  baseName, EventMapper, ProviderTrace, RunStepKind, traceFromStream,
} from "./runrecord.js";

export interface CodexProviderOptions {
  /** where the agent's turn runs (its own files folder) */
  agentDataDir: (agentId: string) => string;
  /** command name — overridden by tests with a shim */
  command?: string;
  /** wall-clock leash: the CLI has no turn-limit flag, so we kill it */
  timeoutMs?: number;
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
 * The Codex tools Cloud9 cannot subtract. An OFF switch gates the whole turn:
 * this is deliberately stricter than launching a tool the owner denied and
 * hoping the model obeys a sentence.
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
  /** overridden by tests; defaults to the owner's current CODEX_HOME */
  ownerCodexHome?: string;
  /** overridden by tests; defaults to the real OS user home */
  ownerUserHome?: string;
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
            reasoningTokens: num(u.reasoning_output_tokens),
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
 */
export const CODEX_ISOLATION_FLAGS = ["--ignore-user-config", "--ignore-rules"] as const;

/**
 * Features that are OFF for every agent at every reach, because every one of
 * them is a door into VIKAS'S OWN setup — his plugins, his connected apps, his
 * memories, his hook scripts, his desktop and his browser. Raising the ceiling
 * on 2026-07-30 did not touch this list: "an agent may do everything Codex can
 * do" was never "an agent may be me".
 *
 * Each name came from `codex features list` on this machine (re-read at
 * 0.146.0 on 2026-07-30), so none of them can be a typo the CLI silently
 * ignores. `--disable X` is the CLI's documented shorthand for
 * `-c features.X=false`.
 *
 * MEASURED, not hoped for. Two real `codex exec` turns on codex-cli 0.146.0,
 * 2026-07-29, differing only in these switches, asked the model to name its own
 * tools. Six tools stopped arriving:
 *
 *   tool_search_tool, functions.list_mcp_resources,
 *   functions.list_mcp_resource_templates, functions.read_mcp_resource,
 *   functions.request_plugin_install, image_gen.imagegen
 *
 * and the CLI's own "Skill descriptions were shortened" note stopped appearing.
 * `codex debug prompt-input` (which renders exactly what reaches the model,
 * offline and for free) confirms the matching text goes too: the owner's
 * `<plugins_instructions>`, `<apps_instructions>` and `<recommended_plugins>`
 * blocks — 4,641 characters of his setup that every turn used to pay for.
 */
export const CODEX_ALWAYS_DISABLED = [
  "plugins",          // functions.request_plugin_install + the owner's installed plugins
  "apps",             // the owner's connected apps and their MCP tools
  "image_generation", // image_gen.imagegen — confirmed gone
  "computer_use",     // driving the owner's actual desktop
  "browser_use",      // driving the owner's actual browser
  "memories",         // the owner's own memories, written by his own sessions
  "hooks",            // the owner's hook scripts
] as const;

/**
 * The features switched off for THIS agent: the always-off list above, plus
 * every feature a capability row would have kept on that this agent was not
 * given. Today that is exactly one — `multi_agent`, owned by the `helpers`
 * switch — but it is derived from the table rather than listed here, so a
 * second one cannot be added to the table and forgotten on the command line.
 *
 * `multi_agent` did NOT remove `collaboration.*` when measured on 0.146.0, so an
 * agent with helpers off is refused before this list reaches a command line.
 * The mapping remains for the day a newer CLI honours it.
 */
export function codexDisabledFeaturesFor(agent: AgentDef): string[] {
  const off = [...CODEX_ALWAYS_DISABLED] as string[];
  for (const cap of CAPABILITIES) {
    if (cap.codexFeature && agent.abilities?.[cap.ability] !== true) off.push(cap.codexFeature);
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
export function codexArgs(
  agent: AgentDef, cwd: string, models: string[] = [], wholeComputerRoots: string[] = [],
): string[] {
  const problem = validateAgentInput(agent, { models });
  if (problem) throw new Error(`refusing to run this agent: ${problem}`);
  enforceCodexAbilityBoundary(agent);

  const args = [
    "exec", "--json", "--color", "never", "--skip-git-repo-check",
    "-C", cwd,
    // the sandbox comes from the same table that writes the sentences the agent
    // reads about itself (abilities.ts) — one rule, two faces
    "-s", codexSandboxFor(agent),
    "-p", CODEX_ISOLATION_PROFILE,
  ];
  if (agent.model) {
    if (!MODEL_ID_RE.test(agent.model)) throw new Error("refusing to run this agent: bad model id");
    args.push("-m", safeArg(agent.model));
  }
  args.push("-c", "approval_policy=never", "--ephemeral", ...CODEX_ISOLATION_FLAGS);
  // Every feature switch this agent's switches say to take away — the owner's
  // own setup always, plus anything a capability row would have kept on.
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
  private timeoutMs: number;

  constructor(private opts: CodexProviderOptions) {
    this.runner = opts.runner ?? run;
    this.command = opts.command ?? "codex";
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  async respond(input: RespondInput): Promise<string> {
    const { agent, workdir, onTrace } = input;
    // its own git worktree when it is working in a repository (`repowork.ts`),
    // its own folder otherwise. `codexArgs` puts the same folder in `-C`, so
    // the sandbox root and the working folder cannot drift apart.
    const cwd = workdir ?? this.opts.agentDataDir(agent.id);
    const roots = this.opts.wholeComputerRoots?.(agent.id) ?? [];
    const args = codexArgs(agent, cwd, this.opts.models?.() ?? [], roots);
    // THE SAME ONE ANSWER the Claude path uses. Codex has no MCP config at all
    // in Cloud9, so `mcpConfigPath` is genuinely never supplied here — and a
    // Codex agent with the `connections` switch on is therefore told, truthfully,
    // that nothing is connected for it, instead of being told it can.
    const prompt = buildAgentPrompt(agent, {
      ...input,
      supply: grantedSupply(agent, { wholeComputerRoots: roots }),
      harness: "codex",
    });
    const key = this.opts.apiKey?.();
    const isolated = createCodexIsolatedEnvironment({ apiKey: key });
    let result;
    try {
      result = await this.runner(this.command, args, {
        cwd,
        timeoutMs: this.timeoutMs,
        stdin: prompt,
        // The child gets a disposable CODEX_HOME and user home. Only Codex's
        // login is copied in; both owner skill roots stay outside the process.
        env: isolated.env,
      });
    } finally {
      isolated.dispose();
    }

    if (result.notFound) {
      throw new HarnessUnavailableError("codex", "the Codex app isn't installed on this machine");
    }
    if (result.timedOut) {
      throw new Error(`Codex took longer than ${Math.round(this.timeoutMs / 1000)}s, so I stopped it`);
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
