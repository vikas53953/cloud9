// CodexProvider — runs an agent turn on the locally installed Codex CLI.
//
// Same seam as MockProvider/SdkProvider (harness-signin.md decision 2). The app
// never reads or copies Codex credentials (`~/.codex/auth.json`); it only spawns
// the CLI, which authenticates itself.
import { AgentDef, MODEL_ID_RE, validateAgentInput } from "@cloud9/shared";
import {
  buildAgentPrompt, ClaudeProvider, HarnessUnavailableError, RespondInput,
} from "./provider.js";
import { codexSandboxFor } from "./abilities.js";
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
 * WHAT STILL LEAKS, and this one is worse than Claude's. Probed live on
 * codex-cli 0.146.0, 2026-07-29, with both flags set:
 *  - the model still reported holding `collaboration.spawn_agent`,
 *    `collaboration.send_message`, `list_mcp_resources`, `read_mcp_resource`,
 *    `web.run` and `image_gen.imagegen`. **Codex has no equivalent of Claude's
 *    `--tools`**, so Cloud9 cannot declare the exact built-in set for a Codex
 *    agent the way it can for a Claude one.
 *  - a full Cloud9 turn still produced the CLI's own note "Skill descriptions
 *    were shortened to fit the 2% skills context budget", which means the
 *    owner's `$CODEX_HOME/skills` are STILL being loaded. `--ignore-user-config`
 *    covers config.toml and nothing else. That note now lands in the run record
 *    as a visible step rather than disappearing, which is the only good part.
 *
 * The honest consequence, which belongs in front of the owner rather than
 * buried here: a Codex agent's ability toggles control its SANDBOX (what it may
 * write) but not its full tool surface. A Claude agent's toggles now control
 * both. Until Codex grows a `--tools`, "the agent used only what it was allowed
 * to" is evidenced for Claude and only requested for Codex.
 */
export const CODEX_ISOLATION_FLAGS = ["--ignore-user-config", "--ignore-rules"] as const;

/**
 * Build the `codex exec` argument list for an agent.
 * Abilities map to the sandbox: a files-enabled agent may write inside its own
 * folder, everything else is read-only. Approvals are never interactive.
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
export function codexArgs(agent: AgentDef, cwd: string, models: string[] = []): string[] {
  const problem = validateAgentInput(agent, { models });
  if (problem) throw new Error(`refusing to run this agent: ${problem}`);

  const args = [
    "exec", "--json", "--color", "never", "--skip-git-repo-check",
    "-C", cwd,
    // the sandbox comes from the same table that writes the sentences the agent
    // reads about itself (abilities.ts) — one rule, two faces
    "-s", codexSandboxFor(agent),
  ];
  if (agent.model) {
    if (!MODEL_ID_RE.test(agent.model)) throw new Error("refusing to run this agent: bad model id");
    args.push("-m", safeArg(agent.model));
  }
  args.push("-c", "approval_policy=never", "--ephemeral", ...CODEX_ISOLATION_FLAGS);
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

  async respond({ agent, context, onTrace }: RespondInput): Promise<string> {
    const cwd = this.opts.agentDataDir(agent.id);
    const prompt = buildAgentPrompt(agent, context);
    const key = this.opts.apiKey?.();
    const result = await this.runner(this.command, codexArgs(agent, cwd, this.opts.models?.() ?? []), {
      cwd,
      timeoutMs: this.timeoutMs,
      stdin: prompt,
      // Codex's own key only, and nothing else that looks like a secret. This
      // used to be `undefined`, which handed the CLI the entire ambient
      // environment — including any ANTHROPIC_* key lying around, an account
      // that has nothing to do with Codex (finding #9).
      env: envWithoutCredentials(process.env, key ? { CODEX_API_KEY: key } : {}),
    });

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
