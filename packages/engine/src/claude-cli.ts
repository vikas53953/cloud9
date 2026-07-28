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
import { Runner, run, safeArg } from "./run.js";

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

/** Credential variables that must NOT reach a CLI-login turn. */
export const CREDENTIAL_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

/**
 * A copy of the environment with every credential variable stripped out.
 * Exported so the test can assert on it directly — this is the whole promise of
 * the CLI-login path.
 */
export function envWithoutCredentials(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of CREDENTIAL_ENV_VARS) delete env[key];
  return env;
}

export interface ClaudeCliResult {
  text: string;
  error?: string;
}

/**
 * Parse `claude -p --output-format json`. Verified shape on CLI 2.1.220:
 *   {"type":"result","subtype":"success","is_error":false,"result":"…", …}
 * A failed turn keeps the same envelope with `is_error: true`, so the envelope
 * is what we read — never the text of the reply.
 */
export function parseClaudeJson(raw: string): ClaudeCliResult {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return { text: "", error: "the Claude app returned nothing" };
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw.slice(start, end + 1)); } catch {
    return { text: "", error: "the Claude app returned something we couldn't read" };
  }
  const text = typeof parsed.result === "string" ? parsed.result.trim() : "";
  if (parsed.is_error === true || parsed.subtype === "error_during_execution") {
    return { text, error: text || "the Claude turn failed" };
  }
  return { text };
}

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

  const args = ["-p", "--output-format", "json", "--permission-mode", "dontAsk"];
  if (agent.model) {
    if (!MODEL_ID_RE.test(agent.model)) throw new Error("refusing to run this agent: bad model id");
    args.push("--model", safeArg(agent.model));
  }
  // abilities → tools. Bash is refused for every agent, on every path.
  const allowed: string[] = [];
  if (agent.abilities.webSearch) allowed.push("WebSearch", "WebFetch");
  if (agent.abilities.files) allowed.push("Read", "Write", "Glob", "Grep");
  if (allowed.length > 0) args.push("--allowed-tools", ...allowed.map(safeArg));
  args.push("--disallowed-tools", "Bash");
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

  async respond({ agent, context }: RespondInput): Promise<string> {
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

    const parsed = parseClaudeJson(result.stdout);
    if (result.code !== 0 && !parsed.text) {
      throw new Error(`Claude exited with ${result.code}: ${firstLine(result.stderr)}`);
    }
    if (parsed.error && !parsed.text) throw new Error(parsed.error);
    return parsed.text || "(no response)";
  }
}

function looksSignedOut(output: string): boolean {
  return /not logged in|please run ["`']?claude \/?login|invalid api key|authentication_error|unauthorized/i
    .test(output);
}

function firstLine(s: string): string {
  return (s.split(/\r?\n/).find(l => l.trim()) ?? "").slice(0, 160);
}
