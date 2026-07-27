// The engine's boundary to Claude. Two implementations:
//  - MockProvider: deterministic, credential-free — used for tests/QA and demo mode.
//  - SdkProvider: Claude Agent SDK (query()), billing to the user's own
//    credential (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN).
import { AgentDef } from "@cloud9/shared";

export interface RespondInput {
  agent: AgentDef;
  /** rendered conversation context, oldest first, "Name: text" lines */
  context: string;
  /** the message being answered (already included in context) */
  trigger: string;
  triggerAuthor: string;
}

export interface ClaudeProvider {
  respond(input: RespondInput): Promise<string>;
}

export class MockProvider implements ClaudeProvider {
  async respond({ agent, trigger, triggerAuthor }: RespondInput): Promise<string> {
    const gist = trigger.replace(/@[\w-]+/g, "").trim().slice(0, 80) || "that";
    const flavor: Record<string, string> = {
      webSearch: "I'd search the web for this",
      files: "I can keep notes on this in my folder",
      schedules: "I can also check in on a schedule",
      background: "I can grind on this in the background",
    };
    const on = Object.entries(agent.abilities).filter(([, v]) => v).map(([k]) => flavor[k]);
    const abilityNote = on.length ? ` (${on[0]}.)` : "";
    return `${triggerAuthor}, on "${gist}" — here's my take as ${agent.name}: ${persona3(agent.persona)}${abilityNote}`;
  }
}

function persona3(persona: string): string {
  const words = persona.trim().split(/\s+/).slice(0, 12).join(" ");
  return `acting per my brief (“${words}…”), consider it handled. ✅`;
}

export interface SdkCredentials {
  /** exactly one of these is set per user */
  apiKey?: string;
  oauthToken?: string;
}

export class SdkProvider implements ClaudeProvider {
  constructor(
    private creds: SdkCredentials,
    private agentDataDir: (agentId: string) => string,
  ) {}

  async respond({ agent, context }: RespondInput): Promise<string> {
    // Lazy import so mock mode never loads the SDK.
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const allowedTools: string[] = [];
    if (agent.abilities.webSearch) allowedTools.push("WebSearch", "WebFetch");
    if (agent.abilities.files) allowedTools.push("Read", "Write", "Glob", "Grep");

    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    if (this.creds.apiKey) env.ANTHROPIC_API_KEY = this.creds.apiKey;
    if (this.creds.oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = this.creds.oauthToken;

    const prompt =
      `You are "${agent.name}", an agent in the Cloud9 group chat.\n` +
      `Your persona/brief: ${agent.persona}\n\n` +
      `Recent conversation (oldest first):\n${context}\n\n` +
      `Write your next chat message as ${agent.name}. Stay in persona, be genuinely useful, ` +
      `and keep it chat-length (1-4 sentences unless a list is clearly needed). ` +
      `Mention other participants with @Name only when addressing them. ` +
      `Do not prefix your reply with your own name.`;

    let result = "";
    for await (const message of query({
      prompt,
      options: {
        model: agent.model,
        allowedTools,
        disallowedTools: ["Bash"],
        permissionMode: "dontAsk",
        maxTurns: 6,
        cwd: this.agentDataDir(agent.id),
        env,
      },
    })) {
      if (message.type === "result" && message.subtype === "success") {
        result = message.result;
      }
    }
    return result || "(no response)";
  }
}
