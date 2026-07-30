export { Engine, type EngineOptions, type TurnInput } from "./engine.js";
export {
  MockProvider, SdkProvider, HarnessUnavailableError, HARNESS_DISCONNECTED_REPLY,
  buildAgentPrompt, renderSkills, sanitizeForChat, redactForSharing,
  type ClaudeProvider, type SdkCredentials, type RespondInput,
} from "./provider.js";
export {
  ClaudeCliProvider, parseClaudeJson, traceClaude, claudeMapper, claudeArgs,
  CLAUDE_ISOLATION_FLAGS, envWithoutCredentials, CREDENTIAL_ENV_VARS,
  type ClaudeCliProviderOptions,
} from "./claude-cli.js";
export {
  CodexProvider, parseCodexJsonl, traceCodex, codexMapper, codexArgs,
  CODEX_ISOLATION_FLAGS, CODEX_ALWAYS_DISABLED, codexDisabledFeaturesFor,
  type CodexProviderOptions, type CodexTranscript,
} from "./codex.js";
// The honest per-harness answer to "are these toggles the permission boundary?"
// A screen that shows one sentence for both harnesses is telling a lie about one.
export {
  HARNESS_ISOLATION, isolationFor,
  type HarnessName, type HarnessIsolation, type LeakedSurface,
} from "./isolation.js";
// What an agent actually did — the run record (FR-TL-003, FR-AU-003).
// The SHAPES themselves live in `@cloud9/shared` — see runrecord.ts. They are
// re-exported here so `@cloud9/engine` keeps its published surface, but there is
// only one definition of each and it is the one on the wire.
export {
  traceFromStream, buildRunRecord, newRunId, summarizeRun, countSteps,
  humanDuration, humanMoney, shareableRun, runListEntry, fitRunRecord,
  validateRunRecord, baseName, RUN_LIMITS,
  type RunRecord, type RunStep, type RunStepKind, type RunUsage, type RunOutcome,
  type RunKind, type RunSeed, type RunFinish, type RunCounts,
  type ProviderTrace, type EventMapper, type TraceBuilder,
} from "./runrecord.js";
export {
  RunStore, RUN_STORE_DEFAULTS, type RunStoreOptions, type RunListEntry,
} from "./runstore.js";
// The ONE owner of "what this agent can do" — read by the command line, the
// sandbox and the prompt alike, so they cannot disagree.
export {
  CAPABILITIES, CLAUDE_BUILTIN_TOOLS, REACH_LEVELS,
  abilitiesForReach, reachOf, grantedCapabilities,
  claudeToolsFor, deniedClaudeTools, codexSandboxFor, codexWebSearchFor,
  reachesBeyondOwnFolder, allowsConnections,
  alwaysAskAbilities, approvalsFor, needsApprovalToRun, describeApprovalNeeds,
  renderCapabilities, type Capability, type Reach, type ReachLevel,
} from "./abilities.js";
export {
  HarnessManager, detectClaude, detectCodex, type HarnessOptions,
} from "./harness.js";
export {
  claudeModels, detectCodexModels, parseCodexModels, readCodexDefault, type ModelList,
} from "./models.js";
export {
  startEngineHost, type EngineHost, type EngineHostOptions, type StoredCredential,
} from "./host.js";
export {
  run, runVisibleTerminal, shellQuote, safeArg, killTree, EMPTY_ARG, UnsafeArgumentError,
  type RunResult, type RunOptions, type Runner, type VisibleRunner,
} from "./run.js";
export { isBraked, shouldReply, DEFAULT_BRAKE, type BrakeConfig } from "./chatter.js";
// The short TLDR an agent writes about its own finished job (his item 3).
export { taskTldr, headlineOf, TLDR_HEADLINE_MAX } from "./tldr.js";
// The four work emoji and the bookkeeping that puts them on the right message
// (his item 5). The VOCABULARY itself lives in `@cloud9/shared`.
export {
  WORK_REACTIONS, workEmoji, rememberAsk, takeAsk, PENDING_ASK_LIMIT,
  type WorkReaction, type PendingAsk,
} from "./reactions.js";
// Parallel git worktrees — one workspace per agent, so several can work one
// repository at once without colliding (his items 6 and 7).
export {
  GitWorkspace, GitError, branchNameFor, isSafeBranchName, worktreePathFor,
  commitMessage, BRANCH_PREFIX,
  type Worktree, type GitWorkspaceOptions, type WorkingTreeState, type CommitResult,
} from "./worktree.js";
// Everything that leaves this machine — behind the approval gate, always.
export {
  GitHubClient, ApprovalRequiredError, REMOTE_ACTIONS, findPullRequestUrl,
  type RemoteAction, type RemoteApprover, type GitHubOptions, type GitHubAccount,
  type PullRequest,
} from "./github.js";
export { Scheduler } from "./scheduler.js";
