export { Engine, type EngineOptions, type TurnInput } from "./engine.js";
export {
  MockProvider, SdkProvider, HarnessUnavailableError, InstructionsNotSavedError,
  AbilityNotSupportedHereError,
  HARNESS_DISCONNECTED_REPLY,
  buildAgentPrompt, promptTurnKind, renderSkills, sanitizeForChat, redactForSharing,
  // THE PROMPT, CUT IN TWO (gap A) — the standing half a harness can send as a
  // real system prompt, and the half that is only about this turn.
  splitAgentPrompt, type AgentPromptParts,
  type ClaudeProvider, type SdkCredentials, type RespondInput,
  type TurnBrief, type PromptTurnKind,
} from "./provider.js";
// (HOW LONG A TURN MAY TAKE used to be exported from here. There is no such
// thing any more — a turn runs until it finishes, fails, or the owner stops it.
// `timebudget.ts` is the note explaining why, and it exports nothing.)
// HOW MUCH CONVERSATION AN AGENT SEES — one budget, in characters, DERIVED FROM
// THE MODEL, with its justification and its measurements written down. It
// replaced a `slice(-20)` nobody had chosen, and then a flat 24,000 that could
// not tell a 200,000-token model from a million-token one.
export {
  renderConversation, conversationBudgetFor, maxConversationMessages,
  CONVERSATION_BUDGET, CONVERSATION_BUDGET_RULE,
  type ConversationBudget, type ConversationScope,
} from "./context.js";
// THE DOORWAY BACK INTO CLOUD9 — the tools Cloud9 itself supplies to an agent,
// and the law that an agent may search only where it may read.
export {
  CLOUD9_TOOLS, CLOUD9_MCP_SERVER, CLOUD9_SEARCH_LIMIT, CLOUD9_ATTACHMENT_TEXT_LIMIT,
  // the two ceilings on what an agent can be SHOWN, as opposed to told about
  CLOUD9_IMAGE_BYTES_LIMIT, CLOUD9_PDF_BYTES_LIMIT,
  cloud9ToolNames,
  renderCloud9Tools, answerCloud9Rpc, callCloud9Tool, cloud9McpConfig,
  type Cloud9Tool, type Cloud9ToolTurn, type Cloud9SearchAnswer, type Cloud9McpTicket,
  type Cloud9AttachmentAnswer, type Cloud9ToolContent, type Cloud9ToolResult,
  // ===== GAP B BLOCK (skills on demand, 2026-08-05) =====
  type Cloud9SkillAnswer,
} from "./cloud9tools.js";
// OPENING A FILE SOMEBODY ATTACHED IN THE ROOM — which file, is it words, and
// what the agent says when the answer is no. No hub, no socket, no disk.
export {
  filesInConversation, findAttachment, asWords, openAttachmentInConversation,
  noSuchFileHere, notWordsSentence, couldNotFetchSentence,
  // WHAT KIND OF THING IS THIS — asked of the bytes, so a picture is a picture
  // whatever the name says, and a PDF never decodes into fake "words".
  sniffKind, describeOpaque, tooBigSentence,
  type RoomFile, type FileKind,
} from "./attachmentreach.js";
export { ToolBridge, type OpenTurn } from "./toolbridge.js";
export {
  ClaudeCliProvider, parseClaudeJson, traceClaude, claudeMapper, claudeArgs,
  claudeSupply, cloud9McpEntry,
  // the isolation is TWO things now: the flags, and the one part of it the CLI
  // has no flag for (auto-memory). Exported together so nobody can carry one
  // half of the boundary somewhere and leave the other behind.
  CLAUDE_ISOLATION_FLAGS, CLAUDE_ISOLATION_ENV,
  envWithoutCredentials, CREDENTIAL_ENV_VARS,
  type ClaudeCliProviderOptions, type ClaudeArgExtras,
} from "./claude-cli.js";
export {
  CodexProvider, parseCodexJsonl, traceCodex, codexMapper, codexArgs,
  CODEX_ISOLATION_FLAGS, CODEX_ALWAYS_DISABLED, codexDisabledFeaturesFor,
  // CLOUD9'S OWN DOORWAY ON CODEX — an HTTP MCP server named by `-c`, which is
  // the only channel that survives `--ignore-user-config`. Measured, not assumed.
  codexCloud9ToolArgs, CODEX_CLOUD9_SERVER, CODEX_TOOL_SECRET_ENV,
  type CodexProviderOptions, type CodexTranscript, type CodexArgExtras,
} from "./codex.js";
// WHOSE SETUP AN AGENT RUNS IN — the ONE owner of "isolated, or his own Claude
// Code / Codex setup", read by both harnesses so they can never drift apart.
export {
  usesOwnerSetup, setupModeFor, claudeSetupFlags, claudeSetupEnv,
  codexSetupFlags, codexDisabledBySetup, codexUsesDisposableHome,
  CODEX_OWNER_SETUP_FEATURES, CODEX_NEVER_ENABLED,
  OWNER_SETUP_WORDS, NEVER_INHERITED,
  type SetupMode, type SetupChoice,
} from "./ownersetup.js";
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
// THE ONE OWNER of "write a file this app will later believe" — write next
// door, flush it to the disk, rename it into place. Everything the engine
// stores and reads back goes through here, so a power cut can never leave half
// a file under a name something trusts.
export {
  writeWholeFile, sweepPending, sweepPendingTree, isPendingName, pendingNameFor,
  PENDING_MARK, IN_FLIGHT_GRACE_MS, RENAME_TRIES, RENAME_WAIT_MS,
} from "./wholefile.js";
// The ONE owner of "what this agent can do" — read by the command line, the
// sandbox and the prompt alike, so they cannot disagree.
export {
  CAPABILITIES, CLAUDE_BUILTIN_TOOLS, REACH_LEVELS,
  abilitiesForReach, reachOf, grantedCapabilities,
  // "what this agent can actually do" — the one owner, read by every view
  effectiveAbilities, withEffectiveAbilities, forcedOnCapabilities,
  codexUnavoidableCapabilities, FORCED_ON_NOTE,
  claudeToolsFor, deniedClaudeTools, codexSandboxFor, codexWebSearchFor,
  reachesBeyondOwnFolder, allowsConnections,
  alwaysAskAbilities, approvalsFor, needsApprovalToRun, describeApprovalNeeds,
  renderCapabilities, grantedSupply, switchesNeedingSupply,
  // FULLY CAPABLE THE SECOND IT EXISTS — what a new agent starts with, and the
  // one press that brings the agents he already has up to the same set.
  NEW_AGENT_ABILITIES, capabilitiesForNewAgent,
  hasFullReach, agentsWithoutFullReach, bringUpToFullReach,
  type Capability, type Reach, type ReachLevel, type Supply,
} from "./abilities.js";
// THE ONE OWNER of "does this agent really have connected services?" — read by
// the engine host when it builds the command line AND by the agent editor when
// it writes the sentence, so a screen can never promise a connection the command
// line will not carry.
export {
  connectionsFileFor, mcpConfigPathFor, connectionsWords,
  type ConnectionsFile, type FileOnDisk,
} from "./connections.js";
// THE FOLDERS OUTSIDE ITS OWN — the same law, one rung up, and the same reason
// it is exported: the agent editor reads the very function the engine host reads
// when it builds `--add-dir`, so the screen cannot promise reach the command
// line will not carry.
export {
  wholeComputerRootsFor, addDirRootsFor, wholeComputerWords,
  // NEVER SILENT ABOUT REACH — the room's line, total over every state
  reachLineInRoom,
  type WholeComputerRoots, type FolderOnDisk, type ReachLine,
} from "./wholecomputer.js";
// GAP C (2026-08-05): WHAT KIND OF BOUNDARY A FOLDER REALLY IS, in one place, so
// every screen that talks about reach reads the same measured answer rather than
// writing its own. See the long note in abilities.ts.
export { FILE_FENCE_WORDS, fileFenceFor, type FileFence } from "./abilities.js";
export {
  HarnessManager, detectClaude, detectCodex, type HarnessOptions,
} from "./harness.js";
export {
  claudeModels, claudeProbeArgs, detectClaudeModels, detectCodexModels,
  parseClaudeProbe, parseCodexModels, readClaudeModelCache, readCodexDefault,
  writeClaudeModelCache,
  type ClaudeModelCache, type ModelList, type ProbeVerdict,
} from "./models.js";
export {
  startEngineHost, type EngineHost, type EngineHostOptions, type StoredCredential,
} from "./host.js";
export {
  run, runVisibleTerminal, shellQuote, safeArg, killTree, EMPTY_ARG, UnsafeArgumentError,
  type RunResult, type RunOptions, type Runner, type VisibleRunner,
} from "./run.js";
export {
  isBraked, shouldReply, mentionOwner, passedOverByMention, DEFAULT_BRAKE, type BrakeConfig,
} from "./chatter.js";
// The short TLDR an agent writes about its own finished job (his item 3).
export { taskTldr, headlineOf, TLDR_HEADLINE_MAX } from "./tldr.js";
// The four work emoji and the bookkeeping that puts them on the right message
// (his item 5). The VOCABULARY itself lives in `@cloud9/shared`.
export {
  WORK_REACTIONS, workEmoji, rememberAsk, takeAsk, PENDING_ASK_LIMIT,
  type WorkReaction, type PendingAsk,
} from "./reactions.js";
// WHERE AN AGENT'S ANSWER BELONGS — the thread it was asked in, or the room.
// One rule for every kind of turn; the one-level part stays the hub's.
export { threadOf, roomLineForThreadJob } from "./threads.js";
export {
  SessionBook, SESSION_IDLE_MS, SESSIONS_PER_AGENT, abilityFingerprint, decideResume,
  isUsableSessionId, looksLikeRefusedResume, sessionKeyId,
  type SessionKey, type StoredSession, type ResumeVerdict, type ResumeWant,
} from "./sessionresume.js";
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
// GitHub work as DATA, not side effects — the pure builders that make a guarded
// `gh` argv, its stdin, the counted facts and one plain sentence, and execute
// nothing. Their caller (githubwrite.ts) is the only thing that runs them.
export {
  buildOpenIssue, buildComment, buildRequestReview,
  buildCheckoutOrUpdatePullRequestBranch, buildResolveReviewThread,
  buildListReviewComments, buildReadReviewComment, buildReadCiStatus,
  GitHubOperationApprovalError,
  type GitHubOperation, type GitHubOperationTool, type GitHubOperationFacts,
} from "./github-ops.js";
// PERFORMING one of those operations — writes only after a yes, reads never
// asking, and raw gh JSON parsed into the capped shared views before it leaves.
export {
  runGitHubWrite, runGitHubRead, writeFactsFor, buildGitHubWrite, parseRead,
  type GitHubWriteRequest, type GitHubReadRequest, type GitHubWriteOutcome,
  type AskForApproval,
} from "./githubwrite.js";
// Asking him MID-RUN, and waiting for the answer without stopping the engine.
// This is what makes the gate in github.ts answerable rather than just closed.
export {
  ApprovalDesk, SETTLED_KEEP,
  type ApprovalOutcome, type ApprovalDeskOptions, type SettledRemoteAction,
} from "./approvaldesk.js";
// An agent working in a repository, and deciding BY ITSELF that it wants its
// branch published. This is the caller `Engine.githubFor` never had.
export {
  repoTurn, describeRepoTurn, repoBriefing, wantsToPublish, withoutPublishMarker,
  type RepoTurnInput, type RepoTurnDeps, type RepoTurnResult, type RepoOutcome,
} from "./repowork.js";
export { Scheduler, isScheduleWhen, SCHEDULE_WHEN } from "./scheduler.js";
// NOTICING that an agent's turn produced a file, so the hub can hold it and
// anybody can open it — instead of a Windows path pasted into the chat.
// (docs/plans/artifact-store-handoff.md)
export {
  sweepProduced, describeRefusals, SKIP_FOLDERS, SWEEP_DEFAULTS,
  type ProducedFile, type RefusedFile, type ArtifactSweep, type SweepOptions,
} from "./artifacts.js";
// WHAT AN AGENT REMEMBERS BETWEEN CONVERSATIONS, and WHAT ONE AGENT HANDS TO
// ANOTHER — now that there is a caller (the engine seeds turns from memory and
// delivers handoffs). The SHAPES themselves live in `@cloud9/shared`; the store,
// the rules and the builder are here. See docs/plans/agent-memory-handoff.md.
export {
  MemoryStore, MEMORY_BUDGET, MEMORY_NOTE_LIMIT, MEMORY_STORE_KEEP,
  MEMORY_STORE_DEFAULTS, worthRemembering, newMemoryId, retrieveMemory, validateNote,
  type MemoryBudget, type MemoryKind, type MemoryNote, type RememberInput,
  type MemoryStoreOptions,
} from "./agent-memory.js";
// CLOUD9'S OWN HOOKS — the owner's events setting off the owner's actions.
// Four events Cloud9 already knew about, four things Cloud9 already knew how to
// do, and five laws that stop a hook being a way round anything. See hooks.ts.
export {
  HOOK_EVENTS, HOOK_ACTIONS, HOOK_DEFAULTS, HOOKS_FILE, HookBook,
  describeHook, fill, hookProblem, hooksPath, isHookEvent, loadHooks, newHookId, saveHooks,
  type Hook, type HookAction, type HookActionKind, type HookActions,
  type HookBookOptions, type HookEvent, type HookFact, type HookFiring,
} from "./hooks.js";
export {
  attachHooks, engineActions, HOOK_COMMAND_TIMEOUT_MS, type HookWiring,
} from "./hookwiring.js";
// DID IT REALLY DO WHAT IT SAID? — the harness's verification pass. A pure
// function over the run record and the counted approval facts; no model grades
// itself anywhere in it.
export {
  verifyTurn, readClaims, CLAIM_QUOTE_MAX, CLAIM_LINES_MAX,
  type Claim, type ClaimKind, type ClaimVerdict, type VerifyInput, type VerificationReport,
} from "./verify.js";
export {
  buildHandoff, validateHandoff, newHandoffId, HandoffError,
  HANDOFF_TASK_LIMIT, HANDOFF_NOTE_LIMIT,
  type AgentHandoff, type ContextPointer, type HandoffInput,
} from "./agent-handoff.js";
