// CodexProvider — runs an agent turn on the locally installed Codex CLI.
//
// Same seam as MockProvider/SdkProvider (harness-signin.md decision 2). The app
// never reads or copies Codex credentials (`~/.codex/auth.json`); it only spawns
// the CLI, which authenticates itself.
import { AgentDef, MODEL_ID_RE, validateAgentInput } from "@cloud9/shared";
import {
  buildAgentPrompt, ClaudeProvider, HarnessUnavailableError, RespondInput,
} from "./provider.js";
import { run, Runner, safeArg, shellQuote } from "./run.js";

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
 * Parse `codex exec --json` output.
 *
 * Shape (harness-signin.md, verified against CLI 0.144.4):
 *   {"type":"thread.started","thread_id":"…"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
 *   {"type":"turn.completed", …}
 * The reply is the LAST completed `agent_message` item. Unknown event types and
 * non-JSON noise (progress spinners, warnings) are ignored on purpose.
 */
export function parseCodexJsonl(raw: string): CodexTranscript {
  let text = "";
  let threadId: string | undefined;
  let error: string | undefined;
  let events = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(trimmed); } catch { continue; }
    events++;

    const type = String(ev.type ?? "");
    if (type === "thread.started") {
      threadId = str(ev.thread_id) ?? str((ev.thread as Record<string, unknown>)?.id);
    } else if (type === "item.completed") {
      const item = ev.item as Record<string, unknown> | undefined;
      if (item && item.type === "agent_message") {
        const t = itemText(item);
        if (t) text = t;
      }
    } else if (type === "turn.failed" || type === "error") {
      error = str(ev.message)
        ?? str((ev.error as Record<string, unknown>)?.message)
        ?? "the Codex turn failed";
    }
  }
  return { text: text.trim(), threadId, events, error };
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
 * Build the `codex exec` argument list for an agent.
 * Abilities map to the sandbox: a files-enabled agent may write inside its own
 * folder, everything else is read-only. Approvals are never interactive.
 *
 * The agent definition comes from a client, so it is re-validated HERE, at the
 * moment it would become a command line — the relay's check is the first gate,
 * this is the last one, and neither trusts the other.
 */
export function codexArgs(agent: AgentDef, cwd: string, models: string[] = []): string[] {
  const problem = validateAgentInput(agent, { models });
  if (problem) throw new Error(`refusing to run this agent: ${problem}`);

  const args = [
    "exec", "--json", "--color", "never", "--skip-git-repo-check",
    "-C", shellQuote(cwd),
    "-s", agent.abilities.files ? "workspace-write" : "read-only",
  ];
  if (agent.model) {
    if (!MODEL_ID_RE.test(agent.model)) throw new Error("refusing to run this agent: bad model id");
    args.push("-m", safeArg(agent.model));
  }
  args.push("-c", "approval_policy=never", "--ephemeral");
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

  async respond({ agent, context }: RespondInput): Promise<string> {
    const cwd = this.opts.agentDataDir(agent.id);
    const prompt = buildAgentPrompt(agent, context);
    const key = this.opts.apiKey?.();
    const result = await this.runner(this.command, codexArgs(agent, cwd, this.opts.models?.() ?? []), {
      cwd,
      timeoutMs: this.timeoutMs,
      stdin: prompt,
      // Codex's own key only. Never ANTHROPIC_* — that's a different account.
      env: key ? { ...process.env, CODEX_API_KEY: key } : undefined,
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

    const transcript = parseCodexJsonl(result.stdout);
    if (result.code !== 0 && !transcript.text) {
      throw new Error(`Codex exited with ${result.code}: ${firstLine(result.stderr)}`);
    }
    if (transcript.error && !transcript.text) throw new Error(transcript.error);
    return transcript.text || "(no response)";
  }
}

function looksSignedOut(output: string): boolean {
  return /not logged in|please run ["`']?codex login|authentication required|unauthorized/i.test(output);
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find(l => l.trim()) ?? "").slice(0, 160);
}
