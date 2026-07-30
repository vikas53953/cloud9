// Cloud9 shared protocol — types used by relay, engine, desktop and mobile.

export type ID = string;

export interface User {
  id: ID;
  name: string;
  /** invite code that created this user, empty for the owner */
  invitedBy?: ID;
}

/**
 * WHAT AN AGENT MAY DO. The switches, and nothing else, decide it.
 *
 * The four original switches are required, because every stored agent has them.
 * The four added on 2026-07-30 are OPTIONAL, and that is deliberate: absent must
 * mean OFF, so raising the ceiling cannot silently hand an existing agent the
 * power to run programs on the owner's computer. Nobody gains anything without
 * someone typing it in.
 *
 * The plain-words meaning of each switch, the tools it grants and whether it
 * needs the owner's approval all live in ONE table — `CAPABILITIES` in
 * `@cloud9/engine`. This interface is only the field names on the wire.
 */
export interface AgentAbilities {
  webSearch: boolean;
  files: boolean;
  schedules: boolean;
  background: boolean;
  /** get help from its own helper agents and the harness's own working tools */
  helpers?: boolean;
  /** run programs on this computer — ALWAYS asks the owner first */
  commands?: boolean;
  /** reach files outside its own folder — ALWAYS asks the owner first */
  wholeComputer?: boolean;
  /** use connected services (MCP servers) the owner chose FOR THIS AGENT */
  connections?: boolean;
}

/**
 * Which controlled actions need the owner's approval first (FR-AP-001, FR-TL-004).
 *
 * `background` and `schedules` are the owner's choice. The three added on
 * 2026-07-30 are NOT a choice: anything that changes the machine or spends money
 * is forced on by `approvalsFor()` in `@cloud9/engine`, whatever is stored here.
 * They are still fields so the screen can show them and the wire can carry them —
 * but a client that sends `commands: false` does not get a silent machine.
 */
export interface AgentApprovals {
  background: boolean;   // !bg / !task delegated work
  schedules: boolean;    // creating a schedule
  /** forced true whenever the `commands` ability is on */
  commands?: boolean;
  /** forced true whenever the `wholeComputer` ability is on */
  wholeComputer?: boolean;
  /** forced true whenever the `connections` ability is on */
  connections?: boolean;
}

/**
 * The abilities that ALWAYS ask the owner first, whatever anyone stored.
 *
 * This lives in shared because two different processes have to agree about it
 * and they cannot see each other's code: the engine decides what an agent may
 * carry, and the hub decides whether a job needs a yes before it runs. When the
 * rule lived only in the engine, the hub read `agent.approvals` directly and
 * would have let a job from an agent that can run programs through **without
 * asking** — the switch said "always ask" and the hub had never heard of it.
 *
 * One fact, one home. Anything marked here is forced on at every gate; a stored
 * `false` (or a client claiming one) cannot turn it off.
 */
export const ALWAYS_ASK_ABILITIES = ["commands", "wholeComputer", "connections"] as const;

/**
 * THE THINGS AN AGENT CAN DO THAT ARE VISIBLE FROM OUTSIDE THIS COMPUTER.
 *
 * ONE TABLE. It lives in shared rather than in the engine because three
 * programs have to agree about it: the engine performs the action, the hub
 * writes the sentence the owner reads, and the screen draws the card. A second
 * copy of this list is how "everything that leaves the machine asks first"
 * quietly becomes "everything the engine remembered to add".
 *
 * `packages/engine/src/github.ts` re-exports this and a test asserts object
 * IDENTITY, so a fourth remote action cannot be added on one side only.
 */
export const REMOTE_ACTIONS = {
  push: "push a branch to GitHub",
  pullRequest: "open a pull request on GitHub",
  createRepo: "create a new repository on GitHub",
} as const;

export type RemoteAction = keyof typeof REMOTE_ACTIONS;

export function isRemoteAction(value: unknown): value is RemoteAction {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(REMOTE_ACTIONS, value);
}

/**
 * WHAT the agent wants to do, as facts rather than as a sentence.
 *
 * The agent never writes the words the owner reads. It reports the branch it
 * generated, the repository `gh` named and the number `git rev-list` counted;
 * `describeRemoteAction` below turns those into English. That split is the same
 * law `describeApproval` already follows in the hub — a request that gets to
 * describe itself can describe itself as something harmless.
 */
export interface RemoteActionFacts {
  action: RemoteAction;
  /** "vikas53953/cloud9" — read from GitHub, never typed */
  repo?: string;
  /** the branch, always one Cloud9 generated */
  branch?: string;
  /** what a pull request would aim at */
  base?: string;
  /** how many commits are going up */
  commits?: number;
  /** how many files those commits touched */
  files?: number;
  /** the name of a repository about to be created */
  name?: string;
}

/**
 * The sentence a non-developer judges. Plain words, and every noun in it came
 * from the machine rather than from the agent.
 */
export function describeRemoteAction(f: RemoteActionFacts): string {
  const on = f.repo ? ` on ${f.repo}` : "";
  switch (f.action) {
    case "push": {
      if (typeof f.commits === "number" && f.commits > 0 && f.branch) {
        const n = `${f.commits} commit${f.commits === 1 ? "" : "s"}`;
        return `push ${n} to a new branch ${f.branch}${on}`;
      }
      return f.branch ? `push the branch ${f.branch}${on}` : `push a branch${on}`;
    }
    case "pullRequest": {
      const into = f.base ? ` into ${f.base}` : "";
      const from = f.branch ? ` from ${f.branch}` : "";
      return `open a pull request${into}${from}${on}`;
    }
    case "createRepo":
      return `create a new repository${f.name ? ` called ${f.name}` : ""} on GitHub`;
  }
}

/** The smaller line under it: how big this is. Absent when we do not know. */
export function detailRemoteAction(f: RemoteActionFacts): string | undefined {
  const bits: string[] = [];
  if (typeof f.files === "number" && f.files > 0) {
    bits.push(`${f.files} file${f.files === 1 ? "" : "s"} changed`);
  }
  if (f.action === "pullRequest" && typeof f.commits === "number" && f.commits > 0) {
    bits.push(`${f.commits} commit${f.commits === 1 ? "" : "s"}`);
  }
  return bits.length ? bits.join(", ") : undefined;
}

/** How long a mid-run request waits before it is dead. Ten minutes, one owner. */
export const APPROVAL_LIMITS = {
  /** the sentence the owner reads */
  action: 300,
  /** the smaller line under it */
  detail: 300,
  /** the engine's own correlation token */
  askId: 64,
  /** nobody answered — the request expires and the agent is told so */
  waitMs: 10 * 60_000,
} as const;

/**
 * Is this a request the hub can safely turn into a card? Shapes only — WHOSE
 * agent and WHICH room are answered from stored state by the hub, never here.
 */
export function validateRemoteActionFacts(f: unknown): string | null {
  if (!f || typeof f !== "object") return "that isn't a request to do anything";
  const r = f as Partial<RemoteActionFacts>;
  if (!isRemoteAction(r.action)) return "that isn't something Cloud9 knows how to ask about";
  for (const [what, value] of [["repository", r.repo], ["branch", r.branch],
    ["base", r.base], ["name", r.name]] as const) {
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.length > 200) {
      return `that ${what} name can't be shown to anyone`;
    }
    // the sentence goes on a screen, so nothing that could pretend to be
    // another line of it
    if (new RegExp("[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028\\u2029]").test(value) || /\s/.test(value)) {
      return `that ${what} name has hidden characters in it`;
    }
  }
  for (const [what, value] of [["commit count", r.commits], ["file count", r.files]] as const) {
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
      return `that ${what} isn't a number`;
    }
  }
  return null;
}

/**
 * DOES THIS HAVE TO BE ASKED ABOUT FIRST?
 *
 * ONE OWNER FOR "MUST ASK", and this is it. It answers two questions that used
 * to feel separate and are not:
 *
 *  • *may this agent be left to run a job alone?* — decided by the abilities it
 *    holds, exactly as before. No caller changes.
 *  • *may this particular thing happen?* — and if the thing LEAVES THIS
 *    COMPUTER, the answer is always no, whatever the agent holds. A read-only
 *    agent that somehow reached `git push` still has to ask; an agent with every
 *    switch on does not get a free pass either.
 *
 * The second question is a parameter rather than a second function on purpose.
 * A separate `mustAskBeforeRemoteAction` would be a second rule, and two rules
 * about asking is how the hub and the engine came to disagree the first time.
 */
export function mustAskBeforeActing(
  agent: { abilities?: Partial<AgentAbilities> },
  what?: { remoteAction?: RemoteAction },
): boolean {
  // Anything on the REMOTE_ACTIONS table is visible from outside this machine,
  // and his decision — branch + pull request, ALWAYS — means it is never the
  // agent's call. Deliberately BEFORE the ability check so no combination of
  // switches can reach a `false`.
  if (what?.remoteAction !== undefined) return true;
  const a = agent.abilities;
  if (!a) return false;
  return ALWAYS_ASK_ABILITIES.some(k => a[k] === true);
}

/** Which locally-installed AI harness runs this agent's turns (FR-PC-002/003). */
export type HarnessName = "claude" | "codex";

/**
 * WHO MAY MAKE THIS AGENT ACT.
 *
 * An agent's turns are spent on ITS OWNER'S subscription and run on ITS
 * OWNER'S computer. So "can you see the channel" was never the right question:
 * being in a room with someone's agent is not permission to spend their money
 * or start programs on their machine.
 *
 * - `"owner"` — only the person who built it. THE DEFAULT, and the default
 *   when the field is absent, because an agent from before this rule existed
 *   must not be more open than one made after it.
 * - `"allowlist"` — the owner, plus the people named in `respondToAllowlist`.
 * - `"anyone"` — anyone who can see the conversation. A deliberate, typed-out
 *   choice; never something that happens by omission.
 */
export type AgentRespondTo = "owner" | "allowlist" | "anyone";

/**
 * A skill is a plain-words ability the owner writes for one agent: a name, what
 * it does, and the instructions to follow. Optional files are dropped into the
 * agent's own folder so the agent can read them while it works.
 *
 * Groundwork only in this round — the engine injects the instructions and
 * writes the files; the UI for editing them is Builder B's.
 */
export interface AgentSkillFile {
  /** bare file name, no folders — e.g. "checklist.md" */
  name: string;
  /** the file's text content */
  text: string;
}

export interface AgentSkill {
  id: ID;
  name: string;
  /** one line: what this skill is for */
  description: string;
  /** what the agent should actually do — written in plain words */
  instructions: string;
  files?: AgentSkillFile[];
}

export interface AgentDef {
  id: ID;
  ownerId: ID; // the human whose runtime hosts this agent (and whose Claude account pays)
  name: string;
  emoji: string;
  persona: string;
  abilities: AgentAbilities;
  /** FR-AG-005 — absent means "claude" (v1 agents) */
  provider?: HarnessName;
  /** optional — absent means no approvals required (v1 agents) */
  approvals?: AgentApprovals;
  /** FR-AG-007 — absent means "enabled" (v1 agents) */
  lifecycle?: "enabled" | "paused" | "disabled";
  /**
   * Which model of the chosen app runs this agent. USER-VISIBLE from round 2:
   * clients must always set it (falling back to the harness default), and the
   * relay and engine both check it against that harness's real model list.
   */
  model?: string;
  /** FR (feedback round 1, his 9) — plain-words skills, absent means none */
  skills?: AgentSkill[];
  /** who may make this agent act — absent means "owner" (the safe default) */
  respondTo?: AgentRespondTo;
  /** user ids allowed to drive it, only read when respondTo is "allowlist" */
  respondToAllowlist?: ID[];
  createdAt: number;
}

/**
 * May this person make this agent act?
 *
 * ONE OWNER FOR THE RULE. Mentioning an agent, delegating a background job,
 * asking for a schedule — every path that ends in a turn on the owner's
 * machine asks THIS function, so a new path cannot quietly arrive without the
 * check. The relay enforces it; the engine may also ask, and will get the same
 * answer because it is the same code.
 *
 * The answer is computed from what is STORED about the agent, never from what
 * a client said about itself.
 */
export function mayDriveAgent(userId: ID, agent: AgentDef): boolean {
  if (agent.ownerId === userId) return true;
  switch (agent.respondTo ?? "owner") {
    case "anyone": return true;
    case "allowlist": return (agent.respondToAllowlist ?? []).includes(userId);
    default: return false;
  }
}

export interface AgentSchedule {
  id: ID;
  agentId: ID;
  channelId: ID;
  /** "daily HH:MM" (24h, local to the engine host) or "every Nm" */
  when: string;
  prompt: string;
  enabled: boolean;
}

// ---------- v2 (spec.md): tasks, approvals, activity ----------

/** Spec §20 candidate states adopted provisionally (logged in PARKING-LOT D3). */
export type TaskStatus =
  | "not_started" | "working" | "waiting_user" | "waiting_approval"
  | "blocked" | "completed" | "failed" | "cancelled";

export interface Task {
  id: ID;
  title: string;           // the requested outcome (FR-TS-001)
  requesterId: ID;         // human who asked
  requesterName: string;
  agentId: ID;             // assigned agent (FR-TS-007 multi-agent: later)
  channelId: ID;           // conversation context (FR-TS-008)
  status: TaskStatus;
  result?: string;
  error?: string;
  /**
   * WHAT ACTUALLY HAPPENED, IN ONE OR TWO SENTENCES — written by the agent
   * itself (his item 3; he explicitly agreed the agent should write it).
   *
   * It rides on the task rather than becoming a new entity because it IS a
   * property of the job: "the job finished" and "here is what it did" are the
   * same row of the same list.
   *
   * ABSENT IS A REAL ANSWER and the important one. A job that failed before it
   * had anything to say has no summary, and the screen must show nothing rather
   * than a filler sentence — an invented TLDR is worse than none, because it
   * reads exactly like a real one.
   */
  summary?: string;
  approvalId?: ID;
  /**
   * WHAT ACTUALLY HAPPENED when this job ran (FR-TL-003).
   *
   * This one field is what turns "the job finished" into "here is what it did":
   * hand it to `runDetail` and you get the steps, the time and the money behind
   * the result. Written by the hub from the run record's own `taskId` — never
   * from anything a client claimed — and absent until a run has been recorded,
   * which is also the honest answer for every task from before this existed.
   */
  runId?: string;
  createdAt: number;
  updatedAt: number;
}

// ---------- what an agent actually DID: the run record ----------
//
// THESE ARE WIRE TYPES AND THEY LIVE HERE. They were written in the engine
// first (that was the only file its author owned), but the engine writes a run
// record, the relay stores one, and the screen draws one — three programs, one
// shape. A second definition anywhere is how the three quietly stop agreeing.
//
// THE HONESTY RULE travels with them: nothing here is ever invented, estimated
// or inferred. If a CLI did not report a duration, a cost or an exit code, the
// field is ABSENT — never zero, never "about". A row whose value is absent must
// not be drawn at all.

/**
 * The kinds of thing an agent does, in words a non-developer reads. Both CLIs
 * map onto this list; anything we do not recognise becomes "tool" with the
 * tool's own name as the label, so a new tool shows up as a real step rather
 * than disappearing.
 */
export type RunStepKind =
  | "command"   // ran something on this computer
  | "read"      // opened a file
  | "write"     // wrote or changed a file
  | "search"    // searched files on this computer
  | "web"       // searched or fetched something online
  | "tool"      // used some other tool
  | "thinking"  // reasoning the CLI reported
  | "message"   // said something
  | "note";     // the CLI told us something about itself (incl. a REFUSED tool)

export interface RunStep {
  /** order within the run, from 1 */
  seq: number;
  kind: RunStepKind;
  /** short human label — "Read note.txt", "Ran a command" */
  label: string;
  /** the specific thing acted on. Redacted before it is ever shared. */
  detail?: string;
  /** true/false ONLY when the CLI reported an outcome. Absent = it did not. */
  ok?: boolean;
}

/** Token and money figures, each present only if the CLI reported it. */
export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  /** the CLI's own cost figure. Codex does not report one; Claude does. */
  costUsd?: number;
}

export type RunOutcome = "ok" | "failed" | "cancelled";
export type RunKind = "chat" | "task" | "schedule";

/** One agent turn or one delegated job, start to finish. */
export interface RunRecord {
  /** "r-<time>-<noise>" — sorts by time, and is safe as a file name */
  id: string;
  /** chat reply, delegated job, or scheduled check-in */
  kind: RunKind;
  agentId: ID;
  agentName: string;
  /** which app ran it: claude, codex, mock … */
  provider: string;
  /** the model we ASKED for */
  model?: string;
  /** the model the CLI reported using. Claude only. */
  actualModel?: string;
  channelId?: ID;
  taskId?: ID;
  /** who asked — the person's name, not an id, so the record reads on its own */
  requestedBy: string;
  requestedByKind: "human" | "agent" | "schedule";
  /** what they asked for, trimmed */
  ask: string;
  startedAt: number;
  finishedAt: number;
  /** measured by Cloud9 around the call. Always present. */
  durationMs: number;
  /** claimed by the CLI. Claude only. */
  cliDurationMs?: number;
  outcome: RunOutcome;
  /** plain-words failure, already redacted. Absent on a clean run. */
  error?: string;
  steps: RunStep[];
  usage?: RunUsage;
  /** the CLI's own conversation id */
  sessionId?: string;
  /** Claude only */
  numTurns?: number;
  /** how long the reply was — the reply TEXT is not copied into the record */
  replyChars: number;
  /** JSON events we understood in the CLI's stream */
  events: number;
  /** steps were dropped to keep this record small */
  truncated?: boolean;
}

/** A run as it appears in a list, without loading every step. */
export interface RunListEntry {
  id: string;
  kind: RunKind;
  outcome: RunOutcome;
  startedAt: number;
  durationMs: number;
  ask: string;
  /** the plain-words line, rebuilt from the record it came from */
  summary: string;
}

// -------------------------------------------------------------------- limits
//
// A run record must never be able to grow without bound: a runaway agent that
// reads ten thousand files would otherwise fill the owner's disk — and then the
// hub's database — with the proof of it. Caps live here, in one place, and the
// engine, the relay and the screen all read THESE.

export const RUN_LIMITS = {
  /** steps kept per run; the rest are counted and dropped */
  steps: 200,
  label: 120,
  detail: 300,
  ask: 500,
  error: 300,
  /** a single stream line longer than this is skipped, not parsed */
  line: 256 * 1024,
} as const;

/**
 * How many runs the hub keeps, and how big one may be once it is stored.
 *
 * The engine keeps its own copy on disk under the same rules
 * (`RUN_STORE_DEFAULTS`); this is the hub's half of the same promise, because a
 * record that is bounded on the machine that made it and unbounded on the
 * machine that shares it is not bounded at all.
 */
export const RUN_RETENTION = {
  /** runs kept per agent on the hub; the oldest go first */
  perAgent: 50,
  /**
   * Runs kept for a DELEGATED JOB, whatever its agent has done since.
   *
   * A job's record is the answer to "what did this actually do", and pruning it
   * on the agent's budget deleted exactly that: one busy agent pushed last
   * week's job history out and opening the job showed nothing at all. So a run
   * attached to a task survives the agent's cut while it is among that task's
   * newest.
   */
  perTask: 20,
  /** biggest single stored record — steps are dropped to fit */
  bytes: 64 * 1024,
  /** most rows one `runList` may hand back */
  listPage: 50,
  /** the page size used when a client doesn't ask for one */
  listDefault: 20,
} as const;

// ---------- projects: a GitHub repository connected to Cloud9 ----------
//
// HIS ITEM 7. A project IS a repository — not a folder of tasks that happens to
// mention one — holding its pull requests and its issues, the shape he saw in
// Buzz and asked for.
//
// WHAT THIS HALF IS AND IS NOT. Everything below is storage and wire: what a
// project is, what one of its rows is, and how it travels. NOTHING here runs
// `git` or `gh` — the engine owns that, on the owner's own machine, behind the
// approvals that already sit in front of anything that leaves it. That split is
// deliberate and load-bearing: the hub must never become a thing that can reach
// GitHub, because the hub is the part a guest can talk to.
//
// TWO DECISIONS HE ALREADY MADE travel with this and are not re-opened:
//  • branch + pull request, ALWAYS. Nothing lands on the default branch without
//    him, which is why `defaultBranch` is recorded as a thing to protect rather
//    than a thing to push to.
//  • `gh` is signed in over HTTPS as `vikas53953`; there is no SSH key. So a
//    project is identified the way `gh` identifies one — "owner/name" — and
//    never by a URL a client made up.

/**
 * A repository connected to this Cloud9.
 *
 * It belongs to a PERSON, exactly as an agent does, and for the same reason:
 * the work happens on their machine, through their `gh` sign-in, spending their
 * account's permissions. Being able to see a project has never been permission
 * to act on it.
 */
export interface Project {
  id: ID;
  /** whose machine and whose GitHub sign-in this project runs through */
  ownerId: ID;
  /** "vikas53953/cloud9" — exactly as `gh` names a repository */
  repo: string;
  /** the name a person reads. Defaults to the repository's own name. */
  name: string;
  /** what this project is for, in the owner's words */
  description?: string;
  /**
   * The branch NOTHING lands on without him (his decision, item 6). Recorded
   * from what the engine actually found on GitHub — never guessed as "main",
   * because a repository whose trunk is called something else would then have
   * had its protection pointed at a branch that does not exist.
   */
  defaultBranch?: string;
  /** the conversation this project reports into, when he picked one */
  channelId?: ID;
  createdAt: number;
  /** when the engine last looked at GitHub. Absent means it never has. */
  syncedAt?: number;
  /** what went wrong the last time it looked, in plain words. Absent = fine. */
  problem?: string;
  /**
   * TRUE WHILE SOMEBODY IS ACTUALLY LOOKING RIGHT NOW.
   *
   * Not stored — the hub adds it on the way out, because "a look is under way"
   * is true of this hub at this moment and would be a lie the second it
   * restarted. It exists so a button can show a real in-progress state instead
   * of a spinner the screen started on its own and has no way to end.
   */
  looking?: boolean;
}

/** A pull request or an issue — the two lists a project holds. */
export type ProjectItemKind = "pull" | "issue";

/**
 * Where one of those has got to.
 *
 * `merged` is deliberately its own answer rather than a flavour of `closed`: a
 * pull request that was merged and one that was thrown away are the opposite
 * outcome, and a list that draws them the same way is lying about the work.
 */
export type ProjectItemState = "draft" | "open" | "merged" | "closed";

/**
 * One pull request or issue, as it stood the last time the engine looked.
 *
 * A CACHE OF SOMEBODY ELSE'S TRUTH, and it says so: GitHub owns these, we only
 * hold the copy that lets a screen draw a list without a network call. Nothing
 * here is ever the basis of a permission decision.
 */
export interface ProjectItem {
  projectId: ID;
  kind: ProjectItemKind;
  /** the number GitHub gave it — unique per repository, per kind */
  number: number;
  title: string;
  state: ProjectItemState;
  /** the GitHub login that opened it. Display only. */
  author?: string;
  /** the branch the work is on — a pull request only */
  branch?: string;
  /**
   * WHICH OF HIS AGENTS DID THIS, when one did. Our agent id, not a GitHub
   * name — an agent has no GitHub account of its own, it works through his.
   * Absent means a person opened it, which is the ordinary case.
   */
  agentId?: ID;
  /** the address a person clicks. Always GitHub's own. */
  url: string;
  createdAt: number;
  updatedAt: number;
}

export const PROJECT_LIMITS = {
  /** how many repositories one person may connect */
  perUser: 50,
  name: 80,
  description: 500,
  /** pull requests + issues kept per project — the newest survive */
  items: 200,
  itemTitle: 300,
  /** the plain-words failure kept on a project */
  problem: 200,
  /**
   * How long the hub waits for an engine to come back from GitHub before it
   * stops saying "looking".
   *
   * A spinner with no end is the dishonest failure this number exists to
   * prevent: if the engine dies mid-look, the hub says so in words rather than
   * leaving the button spinning for ever.
   */
  lookMs: 90_000,
  /** how many pull requests, and how many issues, one look asks GitHub for */
  lookItems: 100,
} as const;

/**
 * The shape of "owner/name", and nothing else.
 *
 * SAME LAW AS `MODEL_ID_RE`, for the same reason: this string ends up as an
 * argument to `gh`. Each half must START with a letter or a digit, so a value
 * can never be mistaken for an option — `--repo` is not a repository, it is a
 * flag, and that is exactly how round 2's model ids got onto a command line.
 * Exactly one slash, no dots that could climb out of anything, no spaces.
 */
export const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Check a repository name before it is stored or handed to `gh`. */
export function validateRepo(repo: unknown): string | null {
  if (typeof repo !== "string" || repo.trim().length === 0) {
    return "say which repository, as owner/name — for example vikas53953/cloud9";
  }
  if (repo.includes("..")) return "that isn't a repository name";
  if (!REPO_RE.test(repo)) {
    return "that isn't a repository name — use owner/name, like vikas53953/cloud9";
  }
  return null;
}

/**
 * Check the words a person wrote about a project.
 *
 * The NAME goes through `validateName`, the one naming rule every form asks —
 * so a repository called something already taken is refused in the same words a
 * duplicate agent is. An ABSENT name is fine and means "call it what the
 * repository is called"; an empty one means the same thing, which is why both
 * skip the rule rather than being refused for having no letters in them.
 */
export function validateProjectText(
  name: unknown, description: unknown, takenNames?: Iterable<string>,
): string | null {
  if (name !== undefined && name !== null && name !== "") {
    const bad = validateName("project", name, takenNames);
    if (bad) return bad;
  }
  if (description !== undefined && description !== null) {
    if (typeof description !== "string") return "a description is words";
    if (description.length > PROJECT_LIMITS.description) {
      return `that description is too long (max ${PROJECT_LIMITS.description} characters)`;
    }
  }
  return null;
}

/**
 * Is this a branch name, and only a branch name?
 *
 * THE ONE OWNER OF THAT QUESTION for a branch somebody ELSE named — GitHub's
 * trunk, the head branch on a pull request. (A branch Cloud9 makes for itself
 * is a narrower question and `engine/worktree.ts` answers it: it also demands
 * our own `cloud9/` prefix, because nothing we create may land anywhere else.)
 *
 * It lived in the hub until 2026-07-30, when the engine started reading a
 * repository's trunk off `gh` and needed the same answer. Two copies of this
 * rule is exactly how the engine ends up reporting a name the hub then refuses
 * — and a refused frame takes the whole list of work down with it.
 *
 * Same law as every other command-line-bound value here: an allowlist that
 * must START with a letter or a digit, so a value can never be read as an
 * option. `..`, a trailing `.lock`, and the shell's own characters are all out.
 */
export function isBranchName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(name)) return false;
  if (name.includes("..") || name.includes("//")) return false;
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  return true;
}

/**
 * Check one pull request or issue the engine reports back.
 *
 * It arrives over the wire, so it is UNTRUSTED INPUT exactly as a run record
 * is — same law, same shape of answer. GitHub's own reply came through somebody
 * else's network and an engine we did not write could hand us anything.
 */
export function validateProjectItem(item: unknown): string | null {
  if (!item || typeof item !== "object") return "that isn't a pull request or an issue";
  const i = item as Partial<ProjectItem>;
  if (i.kind !== "pull" && i.kind !== "issue") return "that is neither a pull request nor an issue";
  if (typeof i.number !== "number" || !Number.isInteger(i.number) || i.number <= 0) {
    return "that has no number";
  }
  if (typeof i.title !== "string" || i.title.length === 0) return "that has no title";
  if (i.title.length > PROJECT_LIMITS.itemTitle) return "that title is too long";
  if (i.state !== "draft" && i.state !== "open" && i.state !== "merged" && i.state !== "closed") {
    return "that isn't a state we know";
  }
  // the address is a LINK A PERSON CLICKS, so it must be GitHub's own and
  // nothing else — a `javascript:` or a look-alike host is the whole reason
  // this check exists rather than a length check
  if (typeof i.url !== "string" || !/^https:\/\/github\.com\/[^\s"'<>]{1,300}$/.test(i.url)) {
    return "that link isn't a GitHub address";
  }
  for (const [what, value] of [["created", i.createdAt], ["updated", i.updatedAt]] as const) {
    if (typeof value !== "number" || !Number.isFinite(value)) return `that ${what} time isn't a number`;
  }
  return null;
}

/**
 * `expired` is not a decision — it is the honest record that NOBODY MADE ONE.
 * An agent that waited and was never answered must not read that as a yes, and
 * the owner must not come back to a card that has been quietly cancelled or
 * quietly still live. It is its own word for its own reason.
 */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

/**
 * The two shapes an approval comes in:
 *
 *  • `task` — the one that already existed: *may this agent run this job at
 *    all?* Asked BEFORE anything starts, answered once, and the job waits.
 *  • `action` — asked MID-RUN, when the agent is already working and has come
 *    to one specific thing it may not do on its own: *may I push this branch?*
 *    The branch is real by then and the request can name it.
 *
 * ABSENT MEANS `task`. Every approval stored before 2026-07-30 is a job-shaped
 * one, and re-writing history to add a field is how a migration breaks.
 */
export type ApprovalKind = "task" | "action";

export interface Approval {
  id: ID;
  /**
   * Absent on an `action` approval that did not come out of a delegated job —
   * an agent can be asked to push in ordinary conversation, with no job at all.
   */
  taskId?: ID;
  agentId: ID;
  ownerId: ID;             // only the agent's owner may decide (provisional, D4)
  action: string;          // human-readable intended action (FR-AP-002)
  status: ApprovalStatus;
  decidedBy?: ID;
  decidedAt?: number;
  createdAt: number;
  /** absent means `task` — see `ApprovalKind` */
  kind?: ApprovalKind;
  /** which REMOTE_ACTIONS row this is, on an `action` approval */
  remoteAction?: RemoteAction;
  /** the conversation it came out of, so the card can be shown in context */
  channelId?: ID;
  /** the smaller line under the sentence — "3 files changed" */
  detail?: string;
  /**
   * When this stops being answerable. Only an `action` approval has one: an
   * agent is standing there waiting, so a request nobody answers has to die
   * rather than be approved next Tuesday against a branch that has moved on.
   */
  expiresAt?: number;
}

export type ActivityKind =
  | "message" | "task_created" | "task_status" | "approval_requested"
  | "approval_decided" | "agent_created" | "agent_updated" | "agent_deleted"
  | "channel_created" | "member_added" | "invite_created" | "invite_redeemed"
  // §7: a room is a thing that can change, so every change to it is an action
  | "channel_updated" | "channel_archived" | "member_removed" | "member_role_changed"
  // FR-CM-009: changing or withdrawing something already said is an ACTION, and
  // the trail has to keep it — otherwise "delete" quietly means "rewrite history"
  | "message_edited" | "message_deleted"
  // FR-TL-003: an agent took a turn and we wrote down what it did. This is the
  // row the Activity panel was always missing — until now it could say an agent
  // spoke, but never what the agent DID to be able to say it.
  | "run_recorded"
  // his item 7: connecting a repository to Cloud9 is an action on this Cloud9,
  // so it belongs in the trail like every other one. Nothing here touches
  // GitHub — these three lines are about OUR copy.
  | "project_connected" | "project_updated" | "project_forgotten";

/**
 * One line of the trail.
 *
 * A LEDGER, NOT A LIST (FR-AU-003). `seq` counts from 1 with no gaps, and
 * `hash` covers this row's own contents PLUS the previous row's hash — so
 * quietly editing or removing a line breaks every hash after it, and a missing
 * line shows up as a hole in the numbering. Both are cheap to add now and
 * impossible to add honestly later, because a chain can only be built forwards.
 *
 * HONEST LIMIT (the same one Buzz states about theirs): this is tamper-EVIDENT,
 * not tamper-PROOF. Someone who can write to the database file can rebuild the
 * whole chain. It catches corruption and casual editing, not an attacker with
 * the file in their hands.
 */
export interface ActivityRecord {
  id: ID;
  ts: number;
  actorKind: "human" | "agent" | "system";
  actorId: ID;
  actorName: string;
  kind: ActivityKind;
  refId?: ID;              // message/task/approval/agent/channel id
  detail: string;          // plain-language summary (FR-AU-003)
  /** position in the chain, from 1, no gaps (absent on rows written before the ledger) */
  seq?: number;
  /** the previous row's hash — "" for the very first row */
  prevHash?: string;
  /** hex sha256 over this row's fields and `prevHash` */
  hash?: string;
}

// ---------- harness sign-in (docs/plans/harness-signin.md) ----------

/**
 * How this harness's turns get paid for.
 *
 * "cli-login" is the PRIMARY path (feedback-round-1.md): the locally installed
 * app is already signed in and owns its own credential. Cloud9 spawns it and
 * never sees, captures or stores a token. "token"/"apiKey" are the fallbacks
 * for a machine where the app itself isn't signed in.
 */
export type HarnessAuthKind = "cli-login" | "token" | "apiKey" | "none";

/** One selectable model, with the name a person reads and the id we store. */
export interface ModelChoice {
  id: string;
  label: string;
}

/**
 * What the app knows about one locally installed AI harness.
 * STATUS ONLY — booleans and display strings. No token, key or credential
 * material may ever appear in this object (harness-signin.md decision 6).
 */
export interface HarnessInfo {
  name: HarnessName;
  /** the CLI is on this machine */
  installed: boolean;
  /** the CLI reports a logged-in account (or we hold a credential for it) */
  signedIn: boolean;
  /** display label, e.g. an email or "ChatGPT account" — never a secret */
  account?: string;
  /** which credential actually runs this harness's turns */
  authKind: HarnessAuthKind;
  /** CLI version string, for the settings card */
  version?: string;
  /** selectable model ids for this harness, may be empty when unknown */
  models: string[];
  /** the id an agent gets when the owner doesn't pick one */
  defaultModel?: string;
  /**
   * Did that model list come from asking the app itself, or is it the list
   * Cloud9 last proved? The screen says which, because "these are the models
   * you can run" is only true when something actually checked.
   */
  modelsChecked?: boolean;
  /** one plain sentence about where the model list came from */
  modelsDetail?: string;
  /** one plain sentence, user-facing */
  detail: string;
  /** a sign-in is in progress (browser window open, waiting) */
  signingIn?: boolean;
  /** the last sign-in failure, in plain words */
  problem?: string;
}

export interface HarnessState {
  claude: HarnessInfo;
  codex: HarnessInfo;
  /** a detection round is running right now — the UI disables "Re-check" */
  checking?: boolean;
  /**
   * This engine is answering with CANNED replies, not a real AI (demo mode).
   *
   * Demo mode can only be switched on by a human who asks for it, and when it is
   * on the app must SAY SO on screen — a fake answer that looks real is worse
   * than no answer at all. The flag rides on the harness state because that is
   * the one thing every client already listens to.
   */
  demo?: boolean;
  updatedAt: number;
}

/** The plain sentence every client shows while demo mode is on. */
export const DEMO_MODE_BANNER =
  "Demo mode: these answers are made up examples, not real answers from Claude or Codex.";

/** Prefixed to every canned reply so a demo answer can never be mistaken for a real one. */
export const DEMO_REPLY_PREFIX = "[demo — not a real answer] ";

export type ChannelKind = "channel" | "dm";

/**
 * Who may CHANGE a conversation, as opposed to who may talk in it.
 *
 * - `owner` — made it (or was handed it). May do everything, including hand
 *   out roles.
 * - `admin` — may set the topic and description, invite and remove people,
 *   change visibility and archive. May not change roles.
 * - `member` — may read and talk. THE DEFAULT, and the default when a row
 *   predates roles, because a membership from before this rule existed must
 *   not be more powerful than one made after it.
 */
export type ChannelRole = "owner" | "admin" | "member";

/**
 * Can this conversation be found and joined by someone who isn't in it?
 *
 * ABSENT MEANS `private`, which is exactly today's behaviour — every room that
 * existed before this field stays shut. Opening a room is a typed-out choice,
 * never something that happens by omission.
 */
export type ChannelVisibility = "open" | "private";

/**
 * One person's (or one agent's) place in one conversation — A ROW, NOT AN ID
 * IN A LIST.
 *
 * An array of ids can only answer "who is in here right now". It cannot say
 * when someone joined, who let them in, what they may change, or that they
 * left — so "who was in the room when this was said" was an unanswerable
 * question. This row answers all four.
 *
 * `removedAt` is a SOFT delete, like a reaction: the row stays so the record
 * still knows the person was once here. Only rows with no `removedAt` are
 * "in the room".
 */
export interface ChannelMember {
  channelId: ID;
  /** a user id or an agent id — the same union `memberIds` always carried */
  memberId: ID;
  role: ChannelRole;
  joinedAt: number;
  /** who added them; absent when they joined an open room themselves */
  invitedBy?: ID;
  /** when they left or were taken out; absent means they are still in */
  removedAt?: number;
  removedBy?: ID;
}

/** May this role change the conversation itself (topic, people, archive)? */
export function mayAdministerChannel(role: ChannelRole | undefined): boolean {
  return role === "owner" || role === "admin";
}

export interface Channel {
  id: ID;
  name: string; // for dm: derived, e.g. "dm:<a>:<b>" — clients render the peer name
  kind: ChannelKind;
  /**
   * Who is in this conversation right now.
   *
   * DERIVED, not stored: the relay builds it from the membership rows on the
   * way out. It stays on the wire so no existing client breaks, and it is the
   * field to retire once every screen reads `channelMembers` instead.
   */
  memberIds: ID[]; // user ids and agent ids
  createdAt: number;
  /** what this room is for — set once and left alone */
  description?: string;
  /** what it is about TODAY — the line that changes */
  topic?: string;
  topicSetBy?: ID;
  topicSetAt?: number;
  /** absent means "private", i.e. exactly how every room behaved before this */
  visibility?: ChannelVisibility;
  /** retired, not deleted: still readable, nothing new can be said in it */
  archivedAt?: number;
  archivedBy?: ID;
}

/**
 * A room you are NOT in, as seen from outside: enough to decide whether to
 * join, and nothing more. Never carries members or messages — being able to
 * FIND a room is not permission to read it.
 */
export interface ChannelSummary {
  id: ID;
  name: string;
  description?: string;
  topic?: string;
  memberCount: number;
  createdAt: number;
}

export type AuthorKind = "human" | "agent";

/**
 * One file that rode along with a message.
 *
 * The BYTES live on the machine running the hub, never in the database and
 * never on the wire twice. `storedAs` is written by the relay — a client that
 * sends one is ignored, because a path chosen by a client is a path that can
 * point anywhere.
 */
export interface Attachment {
  id: ID;
  /** the name a person sees — validated by `isSafeFileName` */
  name: string;
  /** size of the stored bytes */
  size: number;
  /** what the sender said it is. Display only — never used to decide anything. */
  mime?: string;
  /** file name inside the hub's attachment folder. RELAY-OWNED. */
  storedAs: string;
  uploadedBy: ID;
  uploadedAt: number;
}

// ---------- a file an AGENT made: the shared artifact ----------
//
// THE #1 GAP, in one sentence: an agent that produced a file could only paste a
// Windows path into the chat, and a path on one machine is not a file anybody
// else can open. A person's file already worked — `Attachment`, above, with the
// one-use ticket — so this is deliberately NOT a second file system. It reuses:
//
//  • `isSafeFileName` for the name (the same one owner, not a copy of it),
//  • `validateAttachment`'s size ceiling, through `ARTIFACT_LIMITS.bytes`,
//  • the ONE download endpoint at `ATTACHMENT_TICKET.path`, with the same
//    one-use, thirty-second, permission-checked-twice ticket,
//  • `downloadContentType` / `contentDisposition`, so a type is still computed
//    from the NAME and never from anything the producer claimed.
//
// WHAT IT ADDS is the three things an attachment cannot say:
//  1. WHO MADE IT — the agent, and the run and job its turn was, so the file
//     carries its own provenance instead of a sentence in the chat.
//  2. VERSIONS — the same name produced again is a NEW version and the old
//     bytes are kept, because "the file on disk" changed four times in one
//     evening and nobody could see what it used to say.
//  3. A STABLE REFERENCE — `artifactRef()`, which can sit in a message and be
//     resolved by any client, by another agent, and by the owner.
//
// THE IDENTITY OF AN ARTIFACT IS (channel, name) — decided, and written down in
// `docs/plans/artifact-store-handoff.md`. Not (agent, name): one agent writing
// `report.md` and a second one revising it is a HANDOFF, which is the thing this
// store exists to make possible, and it stays one file with two authors in its
// history rather than two files with the same name. Attribution is therefore
// PER VERSION, never on the artifact itself.

/** One stored version of a shared artifact — one set of bytes, forever. */
export interface ArtifactVersion {
  /** "av-…" — the reference to THESE bytes, which never change */
  id: ID;
  /** 1 upwards, never reused even after older versions are pruned */
  version: number;
  size: number;
  /**
   * sha-256 of the bytes, lower-case hex. It is what lets a client say "this is
   * the same file again" without downloading it, and it is computed by the HUB
   * from the bytes it stored — never copied from what the producer claimed.
   */
  sha256: string;
  /**
   * True when the hub could read these bytes as text (see `looksLikeText`).
   * DECIDED FROM THE BYTES, not from a flag on the frame: a producer that could
   * label a binary "text" would be a producer that could decide how a screen
   * treats it. A screen may preview text; everything else is a download.
   */
  text: boolean;
  /** file name inside the hub's artifacts folder. RELAY-OWNED. */
  storedAs: string;
  /** the agent that produced it, and the person whose agent that is */
  agentId: ID;
  agentName: string;
  ownerId: ID;
  /** the run whose turn produced it — `RunRecord.id`, so the two join up */
  runId?: string;
  /** the delegated job it came out of, when it came out of one */
  taskId?: ID;
  /** the agent's own one line about what changed. Absent means it said nothing. */
  note?: string;
  producedAt: number;
}

/**
 * A file an agent made, with every version of it the hub still holds.
 *
 * `versions` is NEWEST FIRST and is never empty — an artifact with no version is
 * not an artifact, so nothing here can be drawn as "no file yet". Use
 * `latestVersion()` rather than indexing, so the ordering has one owner.
 */
export interface Artifact {
  /** "af-…" — the reference that survives every new version */
  id: ID;
  channelId: ID;
  /** the shared name, checked by `isSafeFileName`. The identity, with the channel. */
  name: string;
  /** newest first, capped at `ARTIFACT_LIMITS.versions`, never empty */
  versions: ArtifactVersion[];
  /** when version 1 landed */
  createdAt: number;
  /** when the newest version landed */
  updatedAt: number;
}


/**
 * Everyone who currently has this one emoji on a message.
 *
 * Taking a reaction back is a SOFT delete in the database (`removedAt`), not a
 * row deletion, so "who reacted and then thought better of it" is still a
 * question the record can answer. What travels on the wire is only the live
 * list, because that is all a client can draw.
 */
export interface MessageReaction {
  /**
   * Who currently has this emoji on the message: user ids AND agent ids,
   * sorted, never duplicated — one reactor, one emoji, one vote.
   *
   * Agent ids appear here because an agent reacting to the message that asked
   * for its work (`agentReact`) uses THIS mechanism rather than a second one,
   * exactly as an agent speaking uses `Message` rather than a second kind of
   * message. A client that draws a name for each id already has agents in the
   * same directory it looks people up in.
   */
  emoji: string;
  userIds: ID[];
}

export interface Message {
  id: ID;
  channelId: ID;
  authorId: ID;
  authorName: string;
  authorKind: AuthorKind;
  authorEmoji?: string;
  text: string;
  ts: number;
  proactive?: boolean; // schedule/background-task originated → push-worthy
  mentions?: ID[];
  /**
   * The message this one answers. Threads are ONE level deep on purpose:
   * replying to a reply joins the same thread rather than starting a new one,
   * so a conversation can never become a tree nobody can read.
   */
  replyTo?: ID;
  /** set the first time the author changes the words — the "edited" marker */
  editedAt?: number;
  /**
   * A tombstone, not a hole. The row stays so the conversation still reads in
   * order and the activity trail is not lying; the words are gone.
   */
  deletedAt?: number;
  attachments?: Attachment[];
  /**
   * How many replies hang off this message. STORED on the root and kept up to
   * date as replies arrive, not counted on the way out — so a channel list can
   * say "12 replies" without walking the conversation. (Buzz's
   * `thread_metadata.reply_count`, and it is why theirs is cheap.)
   */
  replyCount?: number;
  /** when the newest reply landed — the other half of "12 replies · 3m ago" */
  lastReplyAt?: number;
  // ---- filled in by the relay when it hands a message out, never stored ----
  /** who reacted with what */
  reactions?: MessageReaction[];
}

/** One search result, with enough around it to draw a row without asking again. */
export interface SearchHit {
  message: Message;
  channelName: string;
  channelKind: ChannelKind;
  /** the matching words in context, with `«` `»` around each hit */
  snippet: string;
}

/** Where one person has read up to in one conversation, and what is left. */
export interface UnreadEntry {
  channelId: ID;
  /** everything at or before this moment has been seen */
  lastReadTs: number;
  /** messages after it that this person did not write */
  unread: number;
  /** how many of those @mention them (or one of their agents) */
  mentions: number;
}

// ---------- WebSocket frames ----------

export type ClientFrame =
  | { type: "hello"; token: string; client: "desktop" | "mobile" | "engine" }
  | { type: "send"; channelId: ID; text: string; tempId?: string; replyTo?: ID; attachmentIds?: ID[] }
  | { type: "createChannel"; name: string; memberIds: ID[]; kind?: ChannelKind }
  | { type: "addMembers"; channelId: ID; memberIds: ID[] }
  // ---- channels as real things (docs/plans/chat-basics-handoff.md §7) ----
  /** Set what a room is for and what it is about. Absent field = leave alone. */
  | { type: "setChannelInfo"; channelId: ID; description?: string; topic?: string }
  /** Open a room to browse-and-join, or shut it again. */
  | { type: "setChannelVisibility"; channelId: ID; visibility: ChannelVisibility }
  /** Retire a room (or bring it back). Archived is READ-ONLY, never deleted. */
  | { type: "archiveChannel"; channelId: ID; archived: boolean }
  /** The open rooms you are not in — name and description only, never contents. */
  | { type: "browseChannels" }
  /** Let yourself into an open room. */
  | { type: "joinChannel"; channelId: ID }
  /** Take yourself out of a room. */
  | { type: "leaveChannel"; channelId: ID }
  /** Take someone else out of a room. Needs `owner` or `admin`. */
  | { type: "removeMember"; channelId: ID; memberId: ID }
  /** Hand out (or take back) the power to change a room. Needs `owner`. */
  | { type: "setMemberRole"; channelId: ID; memberId: ID; role: ChannelRole }
  /**
   * Who is in this room, with roles and dates — and, with `at`, who was in it
   * at that moment. That last one is the honest answer to "who could see this
   * message when it was said".
   */
  | { type: "channelMembers"; channelId: ID; at?: number }
  | { type: "createAgent"; agent: Omit<AgentDef, "id" | "ownerId" | "createdAt"> }
  | { type: "updateAgent"; agent: AgentDef }
  | { type: "deleteAgent"; agentId: ID }
  | { type: "createInvite" }
  // owner only: take a person out of this Cloud9 (their agents go with them)
  | { type: "removeUser"; userId: ID }
  /**
   * Scroll back. `before`/`beforeId` are the cursor handed back by the last
   * `history` frame — send them exactly as received and never build your own,
   * because two messages can share a millisecond and the id is what breaks
   * the tie.
   */
  | { type: "history"; channelId: ID; before?: number; beforeId?: ID; limit?: number }
  /** Find words across every conversation the asker can see. */
  | { type: "search"; query: string; channelId?: ID; authorId?: ID; limit?: number }
  /** Put an emoji on a message, or take yours off. Saying it twice changes nothing. */
  | { type: "react"; messageId: ID; emoji: string; on?: boolean }
  /** Change the words of a message you wrote. */
  | { type: "editMessage"; messageId: ID; text: string }
  /** Take back a message you wrote — it becomes a tombstone, not a hole. */
  | { type: "deleteMessage"; messageId: ID }
  /** The whole of one thread: the message that started it and every reply. */
  | { type: "thread"; messageId: ID; limit?: number }
  /** Park a file on the hub. Answered with an `attachment` frame carrying its id. */
  | { type: "uploadAttachment"; channelId: ID; name: string; dataBase64: string; mime?: string }
  /**
   * Ask for permission to fetch one attached file's bytes.
   *
   * The answer is a ONE-USE, SHORT-LIVED ticket for that one file. It is asked
   * for over this already-authenticated socket, so there is no second way to
   * sign in and no durable secret ever goes near a URL. See
   * `ATTACHMENT_TICKET` and the `attachmentTicket` server frame.
   */
  | { type: "attachmentTicket"; attachmentId: ID }
  // ---- files an AGENT made (docs/plans/artifact-store-handoff.md) ----
  /**
   * ENGINE-HOST ONLY: share a file one of the owner's agents just produced.
   *
   * The engine sends FACTS and bytes; every derived thing is the hub's —
   * the version number, the sha, whether it is text, the stored file name and
   * the owner. An engine that could set those could publish a version 1 over
   * somebody's version 7, or label a binary as text on somebody else's screen.
   *
   * `name` is the SHARED name, not a path: the engine sends the base name and
   * keeps the machine path to itself (`producedFrom` is the agent's own record
   * of where it came from, already redacted, and may be absent).
   *
   * Publishing the same `name` in the same channel again is an UPDATE — a new
   * version of the same artifact — never a second artifact.
   */
  | {
      type: "publishArtifact"; channelId: ID; agentId: ID; name: string;
      dataBase64: string;
      /** the run whose turn made it, so the file and the record join up */
      runId?: string; taskId?: ID;
      /** the agent's own line about what changed */
      note?: string;
    }
  /** Every artifact in one conversation, newest change first. */
  | { type: "artifacts"; channelId: ID }
  /** One artifact and its whole version history, by id. */
  | { type: "artifact"; artifactId: ID }
  /**
   * Ask for permission to fetch one artifact version's bytes.
   *
   * THE SAME TICKET as an attachment, from the same mint, redeemed at the same
   * path, spent by the first byte, checked again when it is spent. `version`
   * absent means the newest one, which is what a card drawn from a message ref
   * asks for.
   */
  | { type: "artifactTicket"; artifactId: ID; version?: number }
  /** "I have read this conversation up to here" — kept on the account, not the machine. */
  | { type: "markRead"; channelId: ID; ts?: number }
  // engine-host only: post a message authored by one of the owner's agents
  | { type: "agentSend"; agentId: ID; channelId: ID; text: string; proactive?: boolean; replyTo?: ID }
  /**
   * engine-host only in practice: put an emoji on a message AS ONE OF YOUR
   * AGENTS — "picked it up", "working", "done" (his item 5).
   *
   * THE SAME MECHANISM AS `react`, not a second one: it ends in the same
   * reactions table and comes back out in the same `reaction` frame, with the
   * agent's own id in the list. What it adds is the one thing `react` could not
   * express — that the reactor is an agent rather than the person holding the
   * socket — and it is authorised exactly as `agentSend` is, so an engine can
   * never react as an agent it does not own.
   *
   * The emoji is not restricted to `WORK_REACTIONS` here. That set is the
   * VOCABULARY the engine uses; making it a wire rule as well would mean a
   * second owner for the same fact, and would refuse an agent a 🎉 forever.
   */
  | { type: "agentReact"; agentId: ID; messageId: ID; emoji: string; on?: boolean }
  | { type: "agentStatus"; agentId: ID; status: AgentStatus }
  // v2 — tasks / approvals / activity
  // `requesterId` says WHO ASKED for this work. The engine host relays a task on
  // behalf of whoever typed "!bg …", so without it the relay would credit the
  // engine's own account (the owner) for a friend's request. Only an engine
  // connection may set it, and the relay still checks that person is real and
  // can see the channel — it is a claim, not a permission.
  | { type: "createTask"; agentId: ID; channelId: ID; title: string; requesterId?: ID; needsApproval?: boolean; action?: string }
  /**
   * engine (agent owner) only. `summary` follows the same sentence-vs-silence
   * rule as every other optional field in this protocol: ABSENT means "I am not
   * talking about the summary, leave it alone", and `""` means "clear it".
   * Those are two different sentences and the hub treats them differently.
   */
  | { type: "updateTask"; taskId: ID; status: TaskStatus; result?: string; error?: string; summary?: string }
  | { type: "cancelTask"; taskId: ID }
  | { type: "decideApproval"; approvalId: ID; decision: "approved" | "rejected" }
  /**
   * ENGINE-HOST ONLY: an agent is MID-RUN and has reached one specific thing it
   * may not do on its own. "May I push this branch?"
   *
   * This is the same `Approval` entity and the same `decideApproval` answer as
   * a job-shaped approval — deliberately, because a second approval mechanism
   * would be a second place for "did we ask?" to be answered, and this project
   * has already been bitten once by exactly that.
   *
   * WHAT IT DOES NOT CARRY IS THE SENTENCE. The engine sends FACTS —
   * `{ action: "push", repo, branch, commits }` — and the hub writes the words
   * with `describeRemoteAction`. An agent that could write its own approval
   * card could describe a push to somebody else's repository as "tidying up".
   *
   * `askId` is the engine's own correlation token, echoed back on
   * `approvalAsked`, so an engine with several agents waiting at once knows
   * which id belongs to which. It is a label, never a permission.
   */
  | { type: "askApproval"; askId: string; agentId: ID; channelId: ID; taskId?: ID; facts: RemoteActionFacts }
  | { type: "activity"; before?: number; limit?: number }
  // ---- projects: a GitHub repository connected to Cloud9 (his item 7) ----
  /** Connect a repository. Yours: it runs through YOUR machine and YOUR `gh`. */
  | { type: "connectProject"; repo: string; name?: string; description?: string; channelId?: ID }
  /** Rename it, describe it, or point it at a conversation. Absent = leave alone. */
  | { type: "updateProject"; projectId: ID; name?: string; description?: string; channelId?: ID }
  /**
   * Disconnect it. THE REPOSITORY IS NOT TOUCHED — this forgets our copy of the
   * lists and nothing else. Deleting somebody's code is not a thing this hub
   * will ever be able to do.
   */
  | { type: "forgetProject"; projectId: ID }
  /** The repositories you have connected. */
  | { type: "projects" }
  /** One project's pull requests and issues, as of the last time we looked. */
  | { type: "projectItems"; projectId: ID }
  /**
   * "LOOK AT GITHUB NOW." The owner asking for a fresh look at one project.
   *
   * OWNER ONLY, AND CHECKED AT THE HUB — `myProject`, on stored state, exactly
   * like every other project frame. The screen may draw the button however it
   * likes; being able to press it is not the permission.
   *
   * The hub cannot reach GitHub and never will: it forwards this to the
   * OWNER'S OWN engine as `lookAtProject`, and that engine runs `gh` with the
   * sign-in already on the owner's computer. Reading two lists changes nothing
   * outside this machine, so it is not on the `REMOTE_ACTIONS` table and does
   * not go through the approval gate — and there is no frame here that could
   * ever make it write.
   */
  | { type: "syncProject"; projectId: ID }
  /**
   * ENGINE-HOST ONLY: I asked GitHub, and here is what it said.
   *
   * The engine ran `gh` on the owner's machine; this is the report. Like a run
   * record it is a REPORT AND NOT A PERMISSION — the hub reads whose project it
   * is from stored state, never from this frame. `problem` is how the engine
   * says it could not look, so the screen can show why instead of an empty list
   * that reads like "no open work".
   */
  | { type: "projectSynced"; projectId: ID; defaultBranch?: string; items?: ProjectItem[]; problem?: string }
  // ---- what an agent actually did (FR-TL-003) ----
  /**
   * ENGINE-HOST ONLY: one turn finished, here is what it did.
   *
   * The engine sends `shareableRun(record)`, never the raw one. The hub then
   * decides everything that matters about it from STORED state — whose agent
   * this is, and which conversation it happened in — because a record is a
   * report, not a permission. It is scrubbed again on the way out.
   */
  | { type: "runRecorded"; record: RunRecord }
  /**
   * "What has this agent been doing?" (`agentId`, owner only), or "what did
   * this job actually do?" (`taskId`, anyone who can see the conversation).
   * Naming neither is an error — a list with no scope is a list of everything.
   */
  | { type: "runList"; agentId?: ID; taskId?: ID; limit?: number }
  /** One run, in full. The id is enough: who may see it is read from the record. */
  | { type: "runDetail"; runId: string }
  // harness sign-in — asked by any of the owner's clients, answered by the engine host
  //
  // `refreshHarness` is the explicit "go and look again" (it replaced the
  // implicit refresh-on-open). `harnessStatus` is the older name for the same
  // thing and still works, so an older client keeps functioning.
  | { type: "refreshHarness" }
  | { type: "harnessStatus" }
  | { type: "harnessSignIn"; harness: HarnessName }
  // "I'm not finishing that sign-in" — stops the waiting state instead of
  // leaving the user locked out of trying again (finding #10). Owner only, like
  // every other harness frame.
  | { type: "harnessCancel"; harness: HarnessName }
  // engine-host only: report detected harness status (status strings only, never secrets)
  | { type: "harnessState"; state: HarnessState };

export type AgentStatus = "idle" | "working" | "braked";

// ---------- can this agent actually be used right now? ----------
//
// HIS ITEM 2, AND IT IS A BUG: every agent showed offline. The fix is not a
// prettier lamp, it is an honest one — so this is the ONE place that says what
// the four answers mean, and `agentPresence` below is the ONE place that
// decides which of them is true. Two copies of that decision is how a sidebar
// and a conversation header end up disagreeing about the same agent.
//
// It EXTENDS `agentStatus` rather than sitting beside it: the same frame
// carries both, and `status` still says idle/working/braked so nothing that
// already reads it breaks.

/**
 * What a person needs to know before they type at an agent.
 *
 * - `ready`    — its app is signed in and its engine is up. It will answer.
 * - `working`  — mid-turn right now.
 * - `paused`   — its owner paused it. It will not answer until they unpause it.
 * - `offline`  — nobody can run it: the engine is not running, its app is not
 *                signed in, or the owner switched it off.
 *
 * There is deliberately no fifth answer, and no "unknown": when the hub cannot
 * back a claim up, the honest word is `offline`.
 */
export type AgentPresence = "ready" | "working" | "paused" | "offline";

/**
 * Presence, plus WHY — because a grey dot with no explanation is the thing he
 * was actually complaining about. The reason is a plain sentence a
 * non-developer reads ("Codex isn't signed in"), never a code.
 */
export interface AgentPresenceState {
  agentId: ID;
  presence: AgentPresence;
  /** one plain sentence saying why it is what it is. Never empty. */
  reason: string;
  /** the older lamp — the same fact in the older words, so no client breaks */
  status: AgentStatus;
  updatedAt: number;
}

export const PRESENCE_LIMITS = { reason: 200 } as const;

export function isAgentPresence(value: unknown): value is AgentPresence {
  return value === "ready" || value === "working" || value === "paused" || value === "offline";
}

/** "Claude" / "Codex" — the app's name as a person says it. */
export function harnessLabel(name: HarnessName | string | undefined): string {
  return name === "codex" ? "Codex" : "Claude";
}

/**
 * The things the hub GENUINELY KNOWS about one agent. Nothing here is guessed:
 * each field is either an observed fact or absent.
 */
export interface PresenceFacts {
  /** is this agent's owner's engine host connected to the hub RIGHT NOW? */
  engineConnected: boolean;
  /**
   * What that engine last said about the app this agent runs on. ABSENT means
   * it has not said — which is not the same as "not signed in", and must never
   * be reported as if it were.
   */
  harness?: Pick<HarnessInfo, "installed" | "signedIn">;
  /** the last idle/working/braked the engine reported for this agent */
  status?: AgentStatus;
}

/**
 * THE ONE PLACE THAT DECIDES WHETHER AN AGENT IS AVAILABLE.
 *
 * Read the order as a ladder of honesty rather than a list of cases:
 *
 *  1. If no engine is connected, nobody can run this agent — whatever the last
 *     lamp said. This is what stops a "working" left behind by an engine that
 *     died mid-turn from being reported forever, and it is the rule the
 *     contract states first: the hub must NEVER report `ready` for an agent
 *     nobody can run.
 *  2. Switched off by its owner is also "nobody can run it", so it is `offline`
 *     and not a fourth word.
 *  3. Mid-turn beats paused and ready (the contract's tie-break).
 *  4. Then the app itself: not installed, or not signed in, are both `offline`
 *     WITH THE REASON, which is the whole point of the reason existing.
 *  5. `braked` is the loop guard, not a lifecycle state: the agent will still
 *     answer a person, so it stays `ready` and the reason explains the pause.
 *     Inventing a fifth state for it would be inventing a status we cannot
 *     support.
 */
export function agentPresence(
  agent: Pick<AgentDef, "provider" | "lifecycle">,
  facts: PresenceFacts,
): { presence: AgentPresence; reason: string } {
  const app = harnessLabel(agent.provider ?? "claude");
  if (!facts.engineConnected) {
    return { presence: "offline", reason: "its agent engine isn't running" };
  }
  if (agent.lifecycle === "disabled") {
    return { presence: "offline", reason: "switched off by its owner" };
  }
  if (facts.status === "working") {
    return { presence: "working", reason: "working now" };
  }
  if (agent.lifecycle === "paused") {
    return { presence: "paused", reason: "paused by its owner" };
  }
  if (facts.harness && !facts.harness.installed) {
    return { presence: "offline", reason: `${app} isn't installed on that computer` };
  }
  if (facts.harness && !facts.harness.signedIn) {
    return { presence: "offline", reason: `${app} isn't signed in` };
  }
  if (facts.status === "braked") {
    return { presence: "ready", reason: "waiting for a person to speak" };
  }
  if (!facts.harness) {
    return { presence: "ready", reason: `its engine is running — ${app} hasn't reported in yet` };
  }
  return { presence: "ready", reason: `signed in to ${app}` };
}

// ---------- the emoji an agent puts on your message as it works ----------
//
// HIS ITEM 5. Reactions already exist, so agents use THAT mechanism — there is
// no second one. What is new is only the VOCABULARY, and it is fixed and lives
// here so the engine, the hub and the screen cannot each pick their own tick.

export const WORK_REACTIONS = {
  /** picked your message up — the job is queued */
  picked: "👀",
  /** mid-turn right now */
  working: "⚙️",
  /** finished, and it worked */
  done: "✅",
  /** finished, and it didn't */
  failed: "❌",
} as const;

export type WorkReaction = keyof typeof WORK_REACTIONS;

export const WORK_REACTION_EMOJI: readonly string[] = Object.values(WORK_REACTIONS);

/** Is this one of the four work-state emoji? Exported so tests can pin the set. */
export function isWorkReaction(emoji: string): boolean {
  return WORK_REACTION_EMOJI.includes(emoji);
}

export interface WorldState {
  me: User;
  users: User[];
  agents: AgentDef[];
  channels: Channel[];
  /** most recent messages per channel */
  messages: Message[];
  agentStatus: Record<ID, AgentStatus>;
  /**
   * Who can actually be used, and why — computed by the hub from what it really
   * knows (see `agentPresence`). Absent only on a hub older than this round;
   * a client that finds it absent must fall back to `agentStatus` rather than
   * inventing a presence of its own.
   */
  presence?: Record<ID, AgentPresenceState>;
  tasks: Task[];
  approvals: Approval[];
  /**
   * Where this person has read up to, per conversation — from the RELAY, so it
   * follows them between machines (absent on a relay older than this round).
   */
  unread?: UnreadEntry[];
}

export type ServerFrame =
  | { type: "welcome"; state: WorldState }
  | { type: "message"; message: Message; tempId?: string }
  | { type: "channel"; channel: Channel }
  | { type: "agent"; agent: AgentDef }
  | { type: "agentDeleted"; agentId: ID }
  /**
   * ONE FRAME FOR ONE FACT. `status` is the old lamp and still means exactly
   * what it always did; `presence` and `reason` are the same fact said in words
   * a person can act on. Both are REQUIRED here on purpose — the hub computes
   * them in one place, so a new place that sends this frame cannot forget them.
   */
  | { type: "agentStatus"; agentId: ID; status: AgentStatus; presence: AgentPresence; reason: string }
  | { type: "invite"; code: string }
  /**
   * One page of scrollback, oldest first. `hasMore` is the only honest way to
   * know whether to keep scrolling — an empty page is NOT the signal, because a
   * page can be short without being the last one.
   */
  | {
      type: "history"; channelId: ID; messages: Message[]; hasMore: boolean;
      /** feed these straight back as `before`/`beforeId` to get the next page */
      nextBefore?: number; nextBeforeId?: ID;
    }
  | { type: "searchResults"; query: string; results: SearchHit[]; hasMore: boolean }
  /** The full, current list of who reacted with this emoji. Empty means nobody does. */
  | { type: "reaction"; channelId: ID; messageId: ID; emoji: string; userIds: ID[] }
  /** A message changed — edited, deleted, or given its first attachment. */
  | { type: "messageUpdated"; message: Message }
  | { type: "thread"; parentId: ID; messages: Message[] }
  /** A parked file, ready to be named in a `send`. Goes only to the uploader. */
  | { type: "attachment"; attachment: Attachment }
  /**
   * Permission to fetch ONE file, ONCE, for a few seconds. Goes only to the
   * socket that asked. `url` is relative to the hub's own address — join it to
   * the same origin the WebSocket is on and `GET` it; the ticket dies the
   * moment the first byte is served, and again when `expiresAt` passes.
   */
  | {
      type: "attachmentTicket"; attachmentId: ID; ticket: string;
      /** e.g. "/attachment/<ticket>" */
      url: string;
      expiresAt: number;
      /** the file this ticket is for, so a client can draw it without asking again */
      attachment: Attachment;
    }
  /**
   * An artifact was published or updated — pushed to EVERYONE who can see the
   * conversation, because a file an agent made is the conversation's, not the
   * producer's. Also the answer to `artifact`.
   */
  | { type: "artifact"; artifact: Artifact }
  /** Answers `artifacts`. Newest change first. */
  | { type: "artifacts"; channelId: ID; artifacts: Artifact[] }
  /**
   * Permission to fetch ONE version of one artifact, ONCE, for a few seconds.
   * `url` is relative to the hub's own address and is the SAME endpoint an
   * attachment is served from — one download path, one set of headers.
   */
  | {
      type: "artifactTicket"; artifactId: ID; version: number; ticket: string;
      /** e.g. "/attachment/<ticket>" */
      url: string;
      expiresAt: number;
      /** the artifact this ticket is for, so a card can be drawn without asking again */
      artifact: Artifact;
    }
  /** A room you are not in, as seen from outside. Answers `browseChannels`. */
  | { type: "channelDirectory"; channels: ChannelSummary[] }
  /** Who is (or was) in one room. Answers `channelMembers`. */
  | { type: "channelMembers"; channelId: ID; at?: number; members: ChannelMember[] }
  /** You are no longer in this room — drop it, and everything you cached for it. */
  | { type: "channelLeft"; channelId: ID }
  /** Read state for one conversation — sent to EVERY machine this person is on. */
  | { type: "read"; entry: UnreadEntry }
  | { type: "userJoined"; user: User }
  | { type: "userRemoved"; userId: ID }
  | { type: "token"; token: string } // durable token issued after invite redemption
  | { type: "task"; task: Task }
  | { type: "approval"; approval: Approval }
  /**
   * "I heard you, and this is the id of the card he is now looking at."
   *
   * Goes ONLY to the engine connection that asked. It is not the answer — the
   * answer arrives later on an ordinary `approval` frame, exactly like every
   * other decision — it is the receipt that lets the engine match one to the
   * other without guessing.
   */
  | { type: "approvalAsked"; askId: string; approvalId: ID }
  | { type: "activity"; records: ActivityRecord[] }
  /** One project changed — connected, renamed, or freshly looked at. */
  | { type: "project"; project: Project }
  /** Answers `projects`. Only ever the asker's own. */
  | { type: "projects"; projects: Project[] }
  | { type: "projectForgotten"; projectId: ID }
  /** Answers `projectItems`, and pushed again whenever the engine re-syncs. */
  | { type: "projectItems"; projectId: ID; items: ProjectItem[] }
  /**
   * One run — pushed the moment it finishes to everyone who can see the
   * conversation it happened in, and sent back on its own to whoever asked for
   * it by id. Always the redacted version.
   */
  | { type: "run"; record: RunRecord }
  /** Answers `runList`. Echoes back which question it is answering. */
  | { type: "runs"; agentId?: ID; taskId?: ID; runs: RunListEntry[] }
  | { type: "push"; message: Message } // relay → mobile: delivered as notification
  // harness status broadcast to the owner's clients
  | { type: "harness"; state: HarnessState }
  // relay → engine host: do the harness work (the engine owns the CLIs)
  | { type: "harnessRequest"; action: "status" | "signIn" | "cancel"; harness?: HarnessName }
  /**
   * relay → THE OWNER'S ENGINE HOST ONLY: go and ask GitHub about this
   * repository, then answer with `projectSynced`.
   *
   * The `repo` travels with it so the engine never has to hold a copy of the
   * project table — and, more importantly, so the name it hands to `gh` is the
   * one the HUB has stored for a project it has already checked belongs to the
   * person who asked. An engine is told what to look at; it does not choose.
   */
  | { type: "lookAtProject"; projectId: ID; repo: string }
  | { type: "error"; error: string };

// ---------- desktop menu actions ----------
//
// ONE list, owned here, read by both halves: the Electron shell builds its menu
// from it (and refuses to start if it names anything not on this list), and the
// app screen's handler map is typed `Record<MenuAction, () => void>` so a
// missing handler is a BUILD failure, not a dead click a user finds later.
// Adding a menu item and forgetting to handle it is no longer possible.

export const MENU_ACTIONS = [
  "new-agent",
  "new-channel",
  "invite",
  "settings",
  "search",
  "toggle-theme",
  "activity",
  "tasks",
  "quick-chat",
] as const;

export type MenuAction = (typeof MENU_ACTIONS)[number];

export function isMenuAction(value: unknown): value is MenuAction {
  return typeof value === "string" && (MENU_ACTIONS as readonly string[]).includes(value);
}

// ---------- untrusted input validation ----------
//
// Agent fields are written by clients and some of them (model) end up on a
// command line. They are validated at BOTH boundaries: the relay refuses to
// store a bad one, and the engine refuses to run one. Same function, so the two
// checks can never drift apart.

/**
 * Model ids are vendor slugs — letters, digits, dot, dash, underscore.
 *
 * The FIRST character must be a letter or a digit. Round 2's version allowed a
 * leading dash, so `--yolo` was a "valid model id" and went straight onto a
 * command line as a flag (finding #21). An id can never be mistaken for a flag
 * again: a value that starts with `-` is not an id, it is an option.
 */
export const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const AGENT_LIMITS = { name: 64, emoji: 16, persona: 8000 } as const;

// =====================================================================
// THE NAMING RULE — one owner for "what is a name", used by every form
// =====================================================================
//
// WHY THIS EXISTS. Phase 5 found five Majors that were all the same missing
// rule wearing different clothes: four agents could all be called `Scout` (so
// the `@` picker offered four identical rows and he would hand real work to the
// wrong one); two channels could both be `#goa-trip`; a channel name of 3,000
// characters was accepted while an agent name capped at 64 and said so; and six
// spaces became a channel literally named `-`.
//
// So there is now ONE rule and ONE place it lives. Every form that names
// anything asks THIS. Three questions, in this order:
//   1. how long may it be
//   2. is it actually a name (not punctuation, not whitespace, not a control
//      character, not a second line)
//   3. do you already have one of these
//
// ENFORCED AT THE HUB, because the screen is not a boundary. The screen imports
// the same function and asks it first, so the sentence he reads before it goes
// is the same sentence he would read after it came back — but the hub's answer
// is the one that decides.
//
// A NAME IS NEVER REWRITTEN INTO SHAPE. Six spaces are refused with a sentence,
// not quietly turned into `-`. Same law as `validateReactionEmoji` and
// `isSafeFileName`: refuse, never repair.
//
// EXISTING DATA KEEPS WORKING. Nothing here runs over stored rows — it runs
// when somebody types a NEW name or renames something. A rule that locked him
// out of his own crew would be a worse bug than the one it fixed.

/** The things Cloud9 lets a person name, and how long each may be. */
export const NAME_LIMITS = {
  agent: AGENT_LIMITS.name,
  /** the missing rule phase 5 found: a channel had no cap at all */
  channel: 64,
  project: PROJECT_LIMITS.name,
  /**
   * A skill is named too, and two skills on one agent called the same thing is
   * the same confusion in miniature — he opens one and edits the other. It is
   * here because "every form that names anything" means every form, not the
   * three that happened to be in the bug report.
   */
  skill: 64,
} as const;

/** What kind of thing is being named — decides the length and the words. */
export type NameKind = keyof typeof NAME_LIMITS;

/**
 * The words for each kind, exactly as they appear in the sentence he reads.
 *
 * The article travels WITH the word because "a agent" is the kind of sentence
 * that tells him a machine wrote it. `an agent needs a name` is also the exact
 * sentence the agent form printed before this rule existed — kept letter for
 * letter, so nothing he already recognises changes underneath him.
 */
const NAMED: Record<NameKind, string> = {
  agent: "an agent", channel: "a channel", project: "a project", skill: "a skill",
};

/**
 * The key uniqueness is judged on.
 *
 * `Scout`, `scout` and `Scout ` are ONE name for this purpose, because they are
 * one name to a person reading a sidebar and to anyone typing `@Sco`. Folded
 * with `toLowerCase` after Unicode normalisation so two spellings that draw the
 * same glyphs cannot slip past each other.
 */
export function nameKey(name: string): string {
  return name.normalize("NFC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * IS THERE A NAME IN HERE AT ALL?
 *
 * At least one letter, digit or picture character. This is the question that
 * refuses six spaces, `---` and `...` — all of which are things a person can
 * type by accident and none of which he could ever say out loud to point at a
 * room. Emoji count: `🐙🐙🐙` is a name he chose, and phase 5 proved it works.
 */
const NAME_HAS_SUBSTANCE = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/** Characters that are never part of a name a person typed on purpose. */
const NAME_CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * THE ONE NAMING RULE. Returns a plain-words problem, or null when the name is
 * fine.
 *
 * `taken` is the names that already exist in the same place — other agents in
 * his crew, other rooms he can see, other repositories he has connected. Leave
 * it out and the duplicate question simply is not asked (the caller does not
 * know the answer, so it must not pretend to).
 */
export function validateName(
  kind: NameKind, name: unknown, taken?: Iterable<string>,
): string | null {
  const one = NAMED[kind];
  if (typeof name !== "string") return `${one} needs a name`;
  const trimmed = name.trim();
  if (trimmed.length === 0) return `${one} needs a name`;
  if (trimmed.length > NAME_LIMITS[kind]) {
    return `that name is too long (max ${NAME_LIMITS[kind]} characters)`;
  }
  if (NAME_CONTROL.test(trimmed) || /[\r\n]/.test(name)) {
    return "a name is one line of ordinary text";
  }
  if (!NAME_HAS_SUBSTANCE.test(trimmed)) {
    return "that isn't a name — it needs at least one letter or number";
  }
  if (taken) {
    const key = nameKey(trimmed);
    for (const other of taken) {
      if (nameKey(other) === key) {
        return `you already have ${one} called "${other.trim()}" — give this one a different name`;
      }
    }
  }
  return null;
}

/**
 * How big a message, a page of scrollback, and a reaction may be.
 *
 * `text` bounds BOTH sending and editing. Before this round `send` had no
 * bound at all, which meant "edit your message" would have been a way to put
 * an unbounded blob in the database through a path nobody had ever sized.
 */
export const MESSAGE_LIMITS = {
  text: 40_000,
  /** biggest page of scrollback the relay will hand back in one frame */
  page: 200,
  /** the page size used when a client doesn't ask for one */
  defaultPage: 50,
  /** an emoji, not an essay */
  emoji: 32,
  /** search needs at least this many characters to be worth running */
  queryMin: 2,
  queryMax: 200,
  /** results per search page */
  searchPage: 50,
} as const;

/**
 * Attachment rules. The name is checked by `isSafeFileName` — the same
 * one, deliberately: a name that may become a real file in the agents folder
 * and a name that may become a real file in the attachments folder are the
 * SAME question, and asking it in two places is how the two answers drift.
 */
export const ATTACHMENT_LIMITS = {
  perMessage: 10,
  /** biggest single file the hub will accept over the socket */
  bytes: 10_000_000,
  /**
   * WHAT STOPS A GUEST FILLING THE OWNER'S DISK.
   *
   * A per-file cap alone bounds nothing: it bounds one file, and nothing bounded
   * how many. These three do — how much may sit unsent at once, how long an
   * unsent file lives before it is swept, and how fast files may arrive.
   * They are here rather than in the hub because the SCREEN has to be able to
   * say the same numbers back to the person who hit them.
   */
  /** total bytes one person may have parked (uploaded, not yet sent) */
  parkedBytesPerUser: 50_000_000,
  /** how long a parked file lives before it is thrown away — one day */
  parkedTtlMs: 24 * 60 * 60 * 1000,
  /** most uploads one person may start in a minute */
  uploadsPerMinute: 30,
} as const;

/**
 * The biggest thing the hub will read off the socket AT ALL.
 *
 * Every other size rule in this file is checked AFTER a frame has been received
 * and parsed — which is too late to stop somebody sending a gigabyte, because
 * the hub has already held it in memory to find out how big it was. `ws` can
 * refuse an oversized frame before that, and this is the number it uses.
 *
 * It is the attachment cap with room for base64's third-over plus the JSON
 * around it — deliberately derived from `ATTACHMENT_LIMITS.bytes` so the two
 * can never drift into a state where a legal upload is dropped by the socket.
 */
export const WS_LIMITS = {
  maxPayloadBytes: Math.ceil(ATTACHMENT_LIMITS.bytes * 4 / 3) + 64 * 1024,
} as const;

/**
 * How long a ticket to fetch one file is good for, and how many a person may
 * be holding at once.
 *
 * THE WHOLE POINT IS THAT A LEAKED ONE IS WORTHLESS. Thirty seconds is long
 * enough to click a link and short enough that a ticket copied out of a log
 * line, a proxy trace or a screen recording has already expired — and it can
 * only ever have been worth ONE file anyway, because the ticket is consumed by
 * the first byte served.
 */
export const ATTACHMENT_TICKET = {
  /** milliseconds a ticket stays good for */
  ttlMs: 30_000,
  /** most unspent tickets one person may hold — stops a bulk mint */
  perUser: 32,
  /** the path a ticket is redeemed at, relative to the hub's own address */
  path: "/attachment/",
} as const;

/**
 * Ceilings, in one place, read by the engine, the hub and the screen.
 *
 * `bytes` IS the attachment ceiling, on purpose and not by coincidence:
 * `WS_LIMITS.maxPayloadBytes` is derived from that number, so an artifact cap
 * above it would be a cap the socket silently refuses first — a legal file that
 * vanishes with no sentence anywhere. One number, one owner, no drift.
 */
export const ARTIFACT_LIMITS = {
  /** biggest single file an agent may share */
  bytes: ATTACHMENT_LIMITS.bytes,
  /** versions kept per artifact; the oldest bytes go with their row */
  versions: 20,
  /** artifacts one conversation may hold */
  perChannel: 200,
  /** how many versions one agent may publish in a minute */
  publishesPerMinute: 30,
  /** the agent's own note about a version */
  note: 300,
  /** most artifacts one `artifacts` answer carries */
  listPage: 100,
} as const;

/**
 * THE REFUSAL, in plain words, from the one place that knows the numbers.
 *
 * A refused artifact is the honest case, not the broken one: the file really is
 * on the agent's machine, and the sentence has to say so and say what to do
 * instead — never "error" and never silence.
 */
export function artifactTooBigSentence(name: string, size: number): string {
  const mb = (n: number) => `${Math.round(n / 100_000) / 10} MB`;
  return `"${name}" is ${mb(size)}, which is too big to share here ` +
    `(the limit is ${mb(ARTIFACT_LIMITS.bytes)}). It is still on this computer — ` +
    `put it in a repository, or share a smaller part of it.`;
}

/**
 * Check a name and a size before any bytes are stored. Plain words, or null.
 *
 * The name rule is `isSafeFileName` REACHED, not restated — the same function
 * an attachment and a skill file go through.
 */
export function validateArtifact(name: unknown, size: number): string | null {
  if (!isSafeFileName(name)) return FILE_NAME_SENTENCE;
  if (!Number.isFinite(size) || size <= 0) return "there are no bytes in that file";
  if (size > ARTIFACT_LIMITS.bytes) return artifactTooBigSentence(name, size);
  return null;
}

/** The newest version. The one owner of "which end of the list is new". */
export function latestVersion(artifact: Artifact): ArtifactVersion | undefined {
  return artifact.versions[0];
}

/** One version by number, or nothing. */
export function versionOf(artifact: Artifact, version: number): ArtifactVersion | undefined {
  return artifact.versions.find(v => v.version === version);
}

/**
 * Can these bytes be treated as TEXT?
 *
 * Asked of the bytes and nothing else. A NUL byte, or anything that is not
 * valid UTF-8, means no — those are the two ways a "text file" turns into
 * mojibake or a truncated preview on a screen. Being wrong in this direction is
 * safe: a text file mislabelled binary is offered as a download, which always
 * works; a binary mislabelled text is drawn into a chat window.
 */
export function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const look = bytes.subarray(0, Math.min(bytes.length, 8192));
  for (const b of look) if (b === 0) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(look);
  } catch {
    // a multi-byte character cut in half by the 8 KB window is not a binary
    // file, so the whole thing gets one more chance before we say no
    if (bytes.length <= look.length) return false;
    try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return false; }
  }
  return true;
}

/**
 * THE STABLE REFERENCE, and the only shape of it.
 *
 * `cloud9://artifact/af-123` means "the newest version"; `…/af-123@3` means
 * that exact version and will mean the same thing next year. It is written into
 * ordinary message text — no new field on `Message`, so every part of the app
 * that already carries text carries these for free, including a message an
 * agent writes and one the owner types back.
 */
export const ARTIFACT_REF_SCHEME = "cloud9://artifact/";

export function artifactRef(artifactId: string, version?: number): string {
  return version === undefined
    ? `${ARTIFACT_REF_SCHEME}${artifactId}`
    : `${ARTIFACT_REF_SCHEME}${artifactId}@${version}`;
}

export interface ArtifactRef { artifactId: string; version?: number }

/** Read one reference, or nothing when this is not one. */
export function parseArtifactRef(text: unknown): ArtifactRef | undefined {
  if (typeof text !== "string") return undefined;
  if (!text.startsWith(ARTIFACT_REF_SCHEME)) return undefined;
  const rest = text.slice(ARTIFACT_REF_SCHEME.length);
  const at = rest.indexOf("@");
  const id = at < 0 ? rest : rest.slice(0, at);
  if (!isSafeStoredId(id)) return undefined;
  if (at < 0) return { artifactId: id };
  const version = Number(rest.slice(at + 1));
  if (!Number.isInteger(version) || version < 1) return undefined;
  return { artifactId: id, version };
}

/**
 * Every reference in a piece of message text, in the order they appear.
 *
 * This is what a renderer calls to turn words into cards. It is here rather
 * than in the screen because an agent's own message, the owner's typed reply
 * and a job summary are three callers of the same question.
 */
export function findArtifactRefs(text: unknown): ArtifactRef[] {
  if (typeof text !== "string") return [];
  const out: ArtifactRef[] = [];
  const seen = new Set<string>();
  const pattern = /cloud9:\/\/artifact\/[A-Za-z0-9][A-Za-z0-9._-]*(@\d+)?/g;
  for (const hit of text.match(pattern) ?? []) {
    // A REFERENCE AT THE END OF A SENTENCE IS STILL A REFERENCE. An id never
    // ends in a dot or a dash (`newId` cannot make one, and `isSafeStoredId`
    // refuses one), so trailing punctuation belongs to the writing and not to
    // the id — and without this, "the report is at cloud9://artifact/af_1."
    // drew no card at all, which is exactly how someone writes it.
    const ref = parseArtifactRef(hit.replace(/[.\-]+$/, ""));
    if (!ref) continue;
    const key = artifactRef(ref.artifactId, ref.version);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * The one line a screen shows under an artifact's name.
 *
 * Built from the version, so nothing on any screen has to compose provenance
 * itself — and so "version 1" never gets a "(v1)" it does not need. Absent
 * facts are absent: a version with no note gets no dash and no empty quotes.
 */
export function describeArtifactVersion(v: ArtifactVersion): string {
  const bits = [`made by ${v.agentName}`];
  if (v.version > 1) bits.push(`version ${v.version}`);
  if (v.note) bits.push(v.note);
  return bits.join(" · ");
}

/**
 * How long a room's own words may be.
 * Bounded for the same reason a message is: an unbounded field is a way to put
 * a blob in the database through a path nobody sized.
 */
export const CHANNEL_LIMITS = { description: 500, topic: 200 } as const;

/** Check a room's description or topic before it is stored. */
export function validateChannelText(value: unknown, what: "description" | "topic"): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return `that ${what} isn't text`;
  const max = what === "topic" ? CHANNEL_LIMITS.topic : CHANNEL_LIMITS.description;
  if (value.length > max) return `that ${what} is too long (max ${max} characters)`;
  // a topic is one line drawn in a header; a newline in it is someone drawing
  // something else. Refused, never trimmed into shape (same law as an emoji).
  if (what === "topic" && /[\r\n]/.test(value)) return "a topic is one line";
  return null;
}

export const SKILL_LIMITS = {
  perAgent: 20, /** the length lives in NAME_LIMITS.skill — one owner */ name: 64, description: 200, instructions: 8000,
  files: 10, fileName: 128, fileText: 40_000,
} as const;

/**
 * EVERY Claude model name the installed Claude Code CLI knows about.
 *
 * This is the CANDIDATE list, not the offer. The Claude CLI has no command that
 * prints its models (verified on 2026-07-30 against CLI 2.1.220: `claude --help`
 * lists agents/auth/mcp/plugin/project/doctor/… and no `models`; `claude models`
 * is treated as a prompt). What it does carry is its own model registry, and
 * that registry is where these ids and labels come from — read out of the
 * shipped binary, not invented here:
 *
 *   grep -aoE '\{id:"claude-[a-z0-9-]+",family:"[a-z]+",display_name:"[^"]*"' claude.exe
 *
 * Knowing a name is not the same as being allowed to run it: retired models and
 * models outside the account's plan are in there too. So this list is only ever
 * the set of things to ASK about — `detectClaudeModels` in the engine runs the
 * CLI once per model and serves back the ones that actually answered.
 *
 * Ordered best-first, which is the order the picker shows.
 */
export const CLAUDE_MODEL_CATALOGUE: ModelChoice[] = [
  { id: "claude-fable-5", label: "Fable 5" },
  { id: "claude-opus-5", label: "Opus 5" },
  { id: "claude-opus-4-8", label: "Opus 4.8" },
  { id: "claude-opus-4-7", label: "Opus 4.7" },
  { id: "claude-opus-4-6", label: "Opus 4.6" },
  { id: "claude-opus-4-5", label: "Opus 4.5" },
  { id: "claude-opus-4-1", label: "Opus 4.1" },
  { id: "claude-opus-4-0", label: "Opus 4" },
  { id: "claude-sonnet-5", label: "Sonnet 5" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6" },
  { id: "claude-sonnet-4-5", label: "Sonnet 4.5" },
  { id: "claude-sonnet-4-0", label: "Sonnet 4" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5" },
  { id: "claude-3-7-sonnet", label: "Sonnet 3.7" },
  { id: "claude-3-5-sonnet", label: "Sonnet 3.5" },
  { id: "claude-3-5-haiku", label: "Haiku 3.5" },
  { id: "claude-mythos-5", label: "Mythos 5" },
  // Not from the CLI registry: this is the exact dated id Cloud9 offered before
  // today, so agents already saved against it keep working. It still runs
  // (proved 2026-07-30). Dropping it would silently break his crew.
  { id: "claude-haiku-4-5-20251001", label: "Haiku 4.5 (dated build)" },
];

/**
 * The models that were PROVED to run on this machine, by running them.
 *
 * Method, 2026-07-30, Claude Code 2.1.220: every id in the catalogue above was
 * put through `claude -p --model <id> --system-prompt x --tools "" "hi"`. A
 * model that answered is here. A model that came back
 * "There's an issue with the selected model (…)" is not — that covers the
 * retired ones (Sonnet 3.5/3.7, Haiku 3.5, Sonnet 4) and Mythos 5, which the
 * CLI names but this account cannot reach.
 *
 * This is the FALLBACK, used when the live check cannot be run or cannot be
 * trusted. The live check is the real answer; a stale honest list beats a guess.
 */
export const CLAUDE_MODELS: ModelChoice[] = CLAUDE_MODEL_CATALOGUE.filter(
  m => !["claude-3-7-sonnet", "claude-3-5-sonnet", "claude-3-5-haiku",
    "claude-sonnet-4-0", "claude-mythos-5"].includes(m.id),
);

export const CLAUDE_DEFAULT_MODEL = "claude-sonnet-5";

/** Friendly name for a model id — falls back to the id for Codex slugs. */
export function modelLabel(id: string): string {
  return CLAUDE_MODEL_CATALOGUE.find(m => m.id === id)?.label ?? id;
}

export interface AgentInput {
  name?: string;
  emoji?: string;
  persona?: string;
  model?: string;
  provider?: string;
  skills?: unknown;
  respondTo?: unknown;
  respondToAllowlist?: unknown;
}

/** How many people one agent may be opened up to. */
export const RESPOND_TO_LIMITS = { allowlist: 50 } as const;

export interface AgentInputRules {
  /**
   * The names already in his crew, so a second `Scout` is refused in words
   * rather than created in silence. Leave it out and the duplicate question is
   * not asked at all — a caller that does not know the crew must not guess.
   *
   * The agent being EDITED is left out of this list by the caller: renaming
   * something to what it is already called is not a clash.
   */
  takenNames?: string[];
  /**
   * The real model list for this agent's harness. When given, a model id that
   * isn't on it is REJECTED. When the list is unknown (the engine hasn't
   * reported yet) the shape check above is still the floor — it is the
   * injection guard and never depends on knowing the list.
   */
  models?: string[];
}

/**
 * Check an agent's user-supplied fields.
 * Returns a plain-words problem description, or null when the agent is fine.
 */
export function validateAgentInput(agent: AgentInput, rules: AgentInputRules = {}): string | null {
  // THE NAMING RULE, not a second copy of it. Length, "is this actually a
  // name", and "you already have one of these" all come from `validateName`,
  // which is the same function the channel form and the project form ask.
  const badName = validateName("agent", agent.name, rules.takenNames);
  if (badName) return badName;
  if (typeof agent.emoji === "string" && agent.emoji.length > AGENT_LIMITS.emoji) {
    return `that emoji is too long (max ${AGENT_LIMITS.emoji} characters)`;
  }
  if (typeof agent.persona === "string" && agent.persona.length > AGENT_LIMITS.persona) {
    return `that personality is too long (max ${AGENT_LIMITS.persona} characters)`;
  }
  if (agent.provider !== undefined && agent.provider !== "claude" && agent.provider !== "codex") {
    return "an agent must run on either Claude or Codex";
  }
  if (agent.model !== undefined && agent.model !== "") {
    // shape first — this is the injection guard and is never skipped
    if (!MODEL_ID_RE.test(agent.model)) return "that model name isn't a valid model id";
    if (rules.models && rules.models.length > 0 && !rules.models.includes(agent.model)) {
      return "that model isn't one this app offers";
    }
  }
  const openness = validateRespondTo(agent.respondTo, agent.respondToAllowlist);
  if (openness) return openness;
  return validateSkills(agent.skills);
}

/** Check the "who may drive me" setting before it is stored. */
export function validateRespondTo(respondTo: unknown, allowlist: unknown): string | null {
  if (respondTo !== undefined
    && respondTo !== "owner" && respondTo !== "allowlist" && respondTo !== "anyone") {
    return "say who may use this agent: just you, a chosen few, or anyone in the room";
  }
  if (allowlist === undefined || allowlist === null) return null;
  if (!Array.isArray(allowlist)) return "the list of people who may use this agent must be a list";
  if (allowlist.length > RESPOND_TO_LIMITS.allowlist) {
    return `that's too many people (max ${RESPOND_TO_LIMITS.allowlist})`;
  }
  for (const id of allowlist) {
    if (typeof id !== "string" || id.length === 0 || id.length > 64) {
      return "that isn't a person";
    }
  }
  return null;
}

/** Skills are owner-written text; they are bounded so one agent can't eat the DB. */
export function validateSkills(skills: unknown): string | null {
  if (skills === undefined || skills === null) return null;
  if (!Array.isArray(skills)) return "skills must be a list";
  if (skills.length > SKILL_LIMITS.perAgent) {
    return `that's too many skills (max ${SKILL_LIMITS.perAgent})`;
  }
  const seen: string[] = [];
  for (const raw of skills) {
    if (!raw || typeof raw !== "object") return "a skill must have a name and instructions";
    const s = raw as Partial<AgentSkill>;
    // the ONE naming rule again, including "you already have one of these" —
    // `seen` is every skill named so far on this same agent
    const badSkillName = validateName("skill", s.name, seen);
    if (badSkillName) return badSkillName;
    seen.push(s.name as string);
    if (typeof s.description === "string" && s.description.length > SKILL_LIMITS.description) {
      return `a skill description is too long (max ${SKILL_LIMITS.description} characters)`;
    }
    if (typeof s.instructions !== "string" || s.instructions.trim().length === 0) {
      return `skill "${s.name}" needs instructions`;
    }
    if (s.instructions.length > SKILL_LIMITS.instructions) {
      return `skill "${s.name}" is too long (max ${SKILL_LIMITS.instructions} characters)`;
    }
    const problem = validateSkillFiles(s.files, s.name);
    if (problem) return problem;
  }
  return null;
}

// =====================================================================
// IS THIS A SAFE FILE NAME — one owner, and the sentence comes FROM the rule
// =====================================================================
//
// WHY THIS WAS REWRITTEN. Phase 5 (F3) attached ordinary files and watched them
// bounce: `report(1).pdf` — the exact name every browser gives a re-downloaded
// file — plus `café-menu.txt`, `photo#3.png`, `budget,notes.txt`,
// `notes'quote.txt` and `मेरी फ़ाइल.txt`. The old rule was an ASCII allowlist
// (`[A-Za-z0-9._ -]`), which is far tighter than any real desktop.
//
// AND THE SENTENCE WAS WRONG. It said "use plain letters, numbers, dots and
// dashes" while quietly allowing spaces and underscores — so it described a
// STRICTER rule than the one enforced, and doing what it said did not help.
// They drifted because the check and the sentence were written separately and
// nothing tied them together.
//
// THE FIX FOR THAT CLASS: there is now ONE list below. Each entry carries its
// own test AND its own words. `isSafeFileName` runs every test; the sentence is
// those same words joined up. A rule cannot change without its sentence
// changing, because they are the same object.
//
// WHAT IS STILL REFUSED, and why — none of this is about tidiness:
//  • path separators and `..` — the only way a name reaches outside its folder
//  • control characters — invisible, and a NUL truncates a path in some layers
//  • a leading character that is not a letter, a number or a picture — so a
//    name can never be read as an option (`-rf`) or hide as a dotfile
//  • a trailing dot or space — Windows strips them, so two names become one file
//  • Windows device names — `CON.md` writes to the console, not to a file

/** The most characters a file name may have. */
export const FILE_NAME_MAX = 128;

/** Characters that can never be part of a file name on Windows or anywhere else. */
export const FILE_NAME_FORBIDDEN = ["/", "\\", ":", "*", "?", "\"", "<", ">", "|"] as const;

/**
 * Names Windows refuses to treat as ordinary files. `CON`, `NUL`, `COM1` and
 * friends are DEVICES, whatever extension you bolt on: writing "CON.md" writes
 * to the console device, not to a file. A trailing dot or space is stripped by
 * the OS, so "evil.md." and "evil.md " both land on "evil.md" — two different
 * names that become the same file (finding #20).
 *
 * The rule is the same one the whole file follows: REFUSE, never rewrite.
 */
const WINDOWS_DEVICE_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/**
 * THE FILE-NAME RULE. One entry per thing that is checked, each carrying the
 * words a person reads when it is the thing they broke.
 *
 * Order matters only for how the sentence reads; every test is run.
 */
const FILE_NAME_RULES: { says: string; ok: (name: string) => boolean }[] = [
  {
    says: `keep it to ${FILE_NAME_MAX} characters or fewer`,
    ok: n => n.length > 0 && n.length <= FILE_NAME_MAX,
  },
  {
    says: "start it with a letter, a number or a picture",
    ok: n => /^[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(n),
  },
  {
    says: `leave out ${FILE_NAME_FORBIDDEN.join(" ")} and ..`,
    ok: n => !FILE_NAME_FORBIDDEN.some(c => n.includes(c)) && !n.includes(".."),
  },
  {
    says: "don't end it with a dot or a space",
    ok: n => !/[. ]$/.test(n),
  },
  {
    says: "leave out hidden control characters",
    ok: n => ![...n].some(c => {
      const point = c.codePointAt(0) ?? 0;
      return point < 0x20 || point === 0x7f;
    }),
  },
  {
    says: "and don't name it after a Windows device (CON, NUL, COM1 and friends)",
    // device names, with or without an extension: CON, con.md, COM1.txt
    ok: n => !WINDOWS_DEVICE_NAMES.has(n.split(".")[0].trim().toUpperCase()),
  },
];

/**
 * ONE PLACE that decides whether a name may become a real file.
 *
 * The relay (before storing an attachment or a skill file), the engine (before
 * writing one) and the screen (before offering to send one) all call THIS, so
 * the three can never drift apart — that drift is what F3 actually was.
 */
export function isSafeFileName(name: unknown): name is string {
  if (typeof name !== "string") return false;
  return FILE_NAME_RULES.every(rule => rule.ok(name));
}

/**
 * The sentence a person reads when a file name is refused — BUILT FROM THE
 * RULES ABOVE, never typed out beside them. This is the whole point: the old
 * sentence described a rule nobody was enforcing, and following its advice did
 * not help. Now there is nothing to keep in step.
 */
export const FILE_NAME_SENTENCE =
  `that file name isn't allowed — ${FILE_NAME_RULES.map(r => r.says).join(", ")}`;

/**
 * Is this an id we are willing to turn into a file name?
 *
 * A DIFFERENT QUESTION from `isSafeFileName`, deliberately, and much narrower:
 * a run id is not something a person types, it is something Cloud9 generates,
 * so there is no real-world name to accommodate and no reason to accept
 * anything but the plainest possible characters. Loosening file names for `café`
 * must not quietly loosen what may become a record on disk.
 */
export function isSafeStoredId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) return false;
  if (id.includes("..")) return false;
  /* A TRAILING DOT OR SPACE IS REFUSED IN THE ID ITSELF, not only in the file
     it becomes. `trailing.` is a legal-looking id that lands on disk as
     `trailing..json` — the `..` appears when the extension is added, after
     every check. Fixing that in the one place that writes the file would leave
     the hub still willing to STORE the id; fixing it here means the bad id
     never exists. Same class as the sentence that drifted from its rule: a
     rule about a name must hold for what the name becomes. */
  if (/[. ]$/.test(id)) return false;
  return !WINDOWS_DEVICE_NAMES.has(id.split(".")[0].toUpperCase());
}

/**
 * What the hub puts in `Content-Disposition` when it serves this file.
 *
 * IT HAS TO COPE WITH THE NAMES THE RULE NOW ALLOWS. A header is Latin-1 only,
 * so `मेरी फ़ाइल.txt` in a plain `filename=` would make Node throw and the
 * download would fail outright — the ordinary-filenames fix would have moved
 * the breakage rather than removed it. So the real name travels in the RFC 5987
 * `filename*` form, percent-encoded as UTF-8, and a stripped-down ASCII name is
 * left in `filename=` for anything too old to read it.
 */
export function contentDisposition(name: string): string {
  const how = isInlineViewable(name) ? "inline" : "attachment";
  // the fallback is allowed to be ugly; it is never the name a modern browser
  // uses, and it must not contain a quote or a backslash that ends the field
  const plain = [...name]
    .map(c => (c.codePointAt(0) ?? 0) < 0x80 && !/["\\]/.test(c) ? c : "_")
    .join("") || "file";
  return `${how}; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function validateSkillFiles(files: unknown, skillName?: string): string | null {
  if (files === undefined || files === null) return null;
  if (!Array.isArray(files)) return "skill files must be a list";
  if (files.length > SKILL_LIMITS.files) {
    return `that's too many files on skill "${skillName}" (max ${SKILL_LIMITS.files})`;
  }
  for (const raw of files) {
    if (!raw || typeof raw !== "object") return "a skill file needs a name and some text";
    const f = raw as Partial<AgentSkillFile>;
    if (!isSafeFileName(f.name)) return FILE_NAME_SENTENCE;
    if (typeof f.text !== "string") return `file "${f.name}" has no text`;
    if (f.text.length > SKILL_LIMITS.fileText) {
      return `file "${f.name}" is too big (max ${SKILL_LIMITS.fileText} characters)`;
    }
  }
  return null;
}

/**
 * Check the words of a message (sent or edited).
 * Returns a plain-words problem, or null when it is fine.
 */
export function validateMessageText(text: unknown, allowEmpty = false): string | null {
  if (typeof text !== "string") return "a message needs some words";
  if (!allowEmpty && text.trim().length === 0) return "a message needs some words";
  if (text.length > MESSAGE_LIMITS.text) {
    return `that message is too long (max ${MESSAGE_LIMITS.text} characters)`;
  }
  return null;
}

/**
 * How long an agent's own account of a finished job may be.
 *
 * Bounded for the same reason a message is: it arrives over the wire and lands
 * in the database, so an unbounded one is a way to put a blob in through a path
 * nobody sized. A TLDR is a couple of sentences — this is generous, not tight.
 */
export const TASK_LIMITS = { summary: 500 } as const;

/**
 * Check the summary an agent wrote about its own finished job.
 *
 * Absent is FINE and is the honest answer when there is nothing to say, so it
 * returns null — the caller's job is to leave the field alone, not to invent
 * one.
 */
export function validateTaskSummary(summary: unknown): string | null {
  if (summary === undefined || summary === null) return null;
  if (typeof summary !== "string") return "a summary is words";
  if (summary.length > TASK_LIMITS.summary) {
    return `that summary is too long (max ${TASK_LIMITS.summary} characters)`;
  }
  return null;
}

/**
 * Check an emoji before it becomes a reaction.
 *
 * A reaction is a short label drawn next to a message, so anything with a line
 * break or a tab in it is not an emoji — it is someone trying to draw
 * something else. Refused, never trimmed into shape.
 */
export function validateReactionEmoji(emoji: unknown): string | null {
  if (typeof emoji !== "string" || emoji.length === 0) return "pick an emoji";
  if (emoji.length > MESSAGE_LIMITS.emoji) return "that's not an emoji";
  // whitespace and control characters are not emoji — refused, never trimmed into shape
  if (/[\s\u0000-\u001f\u007f]/.test(emoji)) return "that's not an emoji";
  return null;
}

/**
 * Check an attachment's name and size.
 *
 * The name question is delegated to `isSafeFileName` on purpose — see
 * ATTACHMENT_LIMITS. There is no second copy of that rule anywhere.
 */
export function validateAttachment(name: unknown, size: number): string | null {
  if (!isSafeFileName(name)) return FILE_NAME_SENTENCE;
  if (!Number.isFinite(size) || size <= 0) return "that file is empty";
  if (size > ATTACHMENT_LIMITS.bytes) {
    return `that file is too big (max ${Math.floor(ATTACHMENT_LIMITS.bytes / 1_000_000)} MB)`;
  }
  return null;
}

/**
 * The only kinds of file the hub will ever hand back with a type a browser
 * will RENDER. Everything else is served as a download and nothing more.
 *
 * WHY AN ALLOWLIST AND NOT THE UPLOADER'S `mime`: the `mime` on an attachment
 * is what the sender SAID it was — it is display text, and the type comment on
 * `Attachment` already says it is never used to decide anything. If the hub
 * echoed it back as `Content-Type`, anyone who could attach a file could
 * choose how the app treats it, and "here is a picture" would be a way to run
 * a page inside the app. So the type is decided HERE, from the extension of
 * the already-validated name, and anything not on this list is handed over as
 * bytes with a download prompt.
 *
 * There is deliberately no `image/svg+xml`: an SVG is a document that can
 * carry script, not a picture.
 */
const INLINE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  log: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  json: "text/plain; charset=utf-8",
  pdf: "application/pdf",
};

/** The bytes-only type: "I am not telling you this is safe to render." */
export const DOWNLOAD_FALLBACK_TYPE = "application/octet-stream";

/**
 * What `Content-Type` the hub serves this file as — computed from the name it
 * validated, never from anything the sender claimed.
 */
export function downloadContentType(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return DOWNLOAD_FALLBACK_TYPE;
  return INLINE_TYPES[name.slice(dot + 1).toLowerCase()] ?? DOWNLOAD_FALLBACK_TYPE;
}

/** May a client show this file in place, or must it be saved first? */
export function isInlineViewable(name: string): boolean {
  return downloadContentType(name) !== DOWNLOAD_FALLBACK_TYPE;
}

/** A harness we know nothing about yet — used before the first detection run. */
export function unknownHarness(name: HarnessName): HarnessInfo {
  return {
    name, installed: false, signedIn: false, authKind: "none",
    models: [], detail: "checking…",
  };
}

// ---------- what may leave this machine ----------
//
// ONE OWNER FOR THE REDACTION RULE, and it lives here because two different
// programs now need it: the engine, which writes a run record full of Windows
// paths and argv, and the relay, which hands that record to somebody else.
// A copy on each side is a rule with two versions, and the guest gets whichever
// one was forgotten.
//
// `sanitizeForChat` (in the engine) is the other half of the same law: it
// answers "may this raw error text be shown?" with a flat no, because an error
// is an unbounded string from someone else's code. This function answers the
// narrower question — "which PARTS of this may be shown?" — for text we DO want
// to show. Neither is ever bypassed; where more is needed, it is added here.

/**
 * Credential variables we know by name and always remove.
 * Kept explicit as well as pattern-matched: names we have actually seen in the
 * wild are documented here, and the pattern below catches the rest.
 */
export const CREDENTIAL_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
] as const;

/**
 * The shape of a secret's NAME. A deny-list of known variables only ever
 * protects against the secrets we thought of; this catches the class.
 */
const SECRET_NAME_RE = /(API[_-]?KEY|ACCESS[_-]?KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|_TOKEN$|^TOKEN$|AUTH_TOKEN|SESSION_KEY|PRIVATE_KEY)/i;

/** Is this variable name credential-shaped? Exported so tests can pin the rule. */
export function isCredentialVar(name: string): boolean {
  if ((CREDENTIAL_ENV_VARS as readonly string[]).includes(name)) return true;
  return SECRET_NAME_RE.test(name);
}

/**
 * The names that identify THIS computer and the person sitting at it.
 *
 * This file is imported by a browser bundle as well as by two Node programs, so
 * it cannot read `os` itself. Instead every Node process that redacts installs
 * its own machine's names once, at startup — the engine host and the relay both
 * do. A process that never installs any still gets rules 1, 2 and 4; it simply
 * has no personal names to blank, which is the honest behaviour rather than a
 * silent half-redaction.
 */
let machineNames: string[] = [];

/**
 * Tell the redactor what this machine is called. Longest first, so
 * "vikasmit" is blanked before a shorter fragment of it can be.
 * Names under three characters are dropped — blanking "am" would shred prose.
 */
export function setMachineNames(names: (string | undefined)[]): void {
  const out = new Set<string>();
  for (const value of names) {
    if (!value) continue;
    for (const part of value.split(/[\\/]/)) if (part.length >= 3) out.add(part);
  }
  // drive letters and generic folders are not identifying — do not blank them
  for (const generic of ["Users", "home", "AppData", "Local", "Roaming", "var", "tmp"]) {
    out.delete(generic);
  }
  machineNames = [...out].sort((a, b) => b.length - a.length);
}

/** What the redactor is currently blanking. Exported so tests can pin it. */
export function knownMachineNames(): string[] {
  return [...machineNames];
}

/**
 * Given text we DO want to show — a command an agent ran, a file it opened, a
 * failure it hit — return the version that may leave this machine.
 *
 * What is removed, in order:
 *  1. anything that looks like a secret's value (KEY=… , sk-… , long blobs);
 *  2. every absolute path, Windows or POSIX or UNC, cut down to its last
 *     segment — "note.txt", never "C:\Users\vikasmit\…\note.txt";
 *  3. this machine's home folder and account name, wherever they appear;
 *  4. environment-variable assignments of any kind.
 *
 * WEB ADDRESSES ARE KEPT WHOLE — AND STILL SCRUBBED. A URL is the thing the
 * owner most wants to see, so it is set aside before the path rules can chew a
 * legitimate `/Users/` or `/var/` segment out of somebody's website. It used to
 * be set aside UNTOUCHED, and that quietly turned the protection into a hole:
 * a Slack webhook carrying an `xoxb-…` token, an `sk-ant-api03-…` in a query
 * string, and a Windows path sitting in a query parameter all sailed straight
 * through into run records that every member of a room can read. A URL says
 * plenty about this computer. So `redactUrl` runs the same rules over the
 * address itself BEFORE it is set aside, and the shield can no longer cancel
 * anything.
 */
export function redactForSharing(text: string, max = 300): string {
  if (!text) return "";
  const urls: string[] = [];
  let out = text
    // set web addresses aside — SCRUBBED FIRST, see `redactUrl` — so the path
    // rules below cannot chew a real website apart
    .replace(/https?:\/\/[^\s"'<>|]+/g, m => `\u0000${urls.push(redactUrl(m)) - 1}\u0000`);

  // 1. secret VALUES — the name may stay, so the owner can see what was set
  out = out.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("[^"]*"|'[^']*'|\S+)/g,
    (whole, name: string) => (isCredentialVar(name) ? `${name}=***` : whole));
  out = out.replace(SECRET_VALUE_RE, "***");
  out = out.replace(/\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g, "***");

  // 2. absolute paths → their last segment only.
  //
  // ORDER MATTERS, and it cost us a live run to learn it. Codex reports the
  // command it ran with its backslashes doubled, so "C:\\WINDOWS\\…\\foo.exe"
  // arrives with real double separators. With the UNC rule first, the "\\WINDOWS"
  // part was eaten as if it were a network share and the drive letter was left
  // stranded — "C:powershell.exe". Nothing leaked, but it read like a bug
  // because it was one. The drive-letter rule now goes first and takes the whole
  // path, and the UNC rule only fires at the START of a token.
  out = out.replace(/\b[A-Za-z]:[\\/][^\s"'|;&]*/g, m => lastSegment(m));   // C:\… , C:/…
  out = out.replace(/(^|[\s"'(=,])\\\\[^\s"'|;&]+/g,                        // \\server\share\…
    (m, lead: string) => `${lead}${lastSegment(m)}`);
  out = out.replace(/(^|[\s"'(=,])\/(?:home|Users|root|mnt|opt|srv|var|etc|tmp|private)\/[^\s"'|;&]*/g,
    (m, lead: string) => `${lead}${lastSegment(m)}`);

  // 3. this machine's own names, wherever they still appear
  for (const secret of machineNames) {
    if (secret.length < 3) continue;
    out = out.split(secret).join("someone");
    const lower = secret.toLowerCase();
    if (lower !== secret) out = out.split(lower).join("someone");
  }

  // 4. put the web addresses back
  out = out.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => urls[Number(i)] ?? "");

  out = out.replace(/\s+/g, " ").trim();
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

/**
 * The SHAPE of a secret's value, wherever it turns up — in a command line, in a
 * URL path, in a query string.
 *
 * One pattern, used by both the plain-text pass and the URL pass, so a token
 * that is caught in a command cannot be missed in a link. `xox…` is here
 * because the leak that was reproduced was a Slack webhook: their tokens live
 * in the PATH of a URL, which is precisely where nothing was looking.
 */
const SECRET_VALUE_RE = /\b(?:sk|pk|ghp|gho|ghu|ghs|github_pat|xox[abprs]|glpat|AIza|hooks)[-_][A-Za-z0-9_-]{6,}/gi;

/**
 * A web address, with everything that should never leave this machine taken out
 * of it — and everything that makes it a useful link left in.
 *
 * This exists because the old code did the opposite: it took URLs out of harm's
 * way and put them back untouched, which made "it's a URL" a way to smuggle a
 * token or a file path past every rule in `redactForSharing`. Each rule below
 * is the URL-shaped version of a rule up there; none of them can chew an
 * ordinary link apart, because each is anchored to where a secret actually
 * lives in an address.
 */
function redactUrl(u: string): string {
  let out = u;
  // 1. a Windows path sitting inside the address — the taxes.xlsx case
  out = out.replace(/\b[A-Za-z]:[\\/][^\s"'|;&?#]*/g, m => lastSegment(m));
  // 2. a POSIX home path in a PARAMETER VALUE. Anchored to `=` on purpose: a
  //    bare `/home/` segment in a website's own path is somebody's blog, not
  //    this computer, and cutting it would mangle a link for nothing.
  out = out.replace(/([?&#][A-Za-z0-9_.\-[\]]*=)(\/(?:home|Users|root|private)\/[^&#\s]*)/g,
    (_m, lead: string, p: string) => `${lead}${lastSegment(p)}`);
  // 3. a token anywhere in it — path segment or query value alike
  out = out.replace(SECRET_VALUE_RE, "***");
  // 4. a credential-shaped PARAMETER, value only, so `?api_key=…&page=2` keeps
  //    its page number. The value stops at `&` or `#`, unlike the plain-text
  //    rule's `\S+`, which would have swallowed the rest of the query.
  out = out.replace(/([?&#])([A-Za-z_][A-Za-z0-9_.-]*)=([^&#\s]*)/g,
    (whole, sep: string, name: string) => (isCredentialVar(name) ? `${sep}${name}=***` : whole));
  // 5. one long opaque blob, per segment. Per SEGMENT and not across the whole
  //    address, because the greedy version ate `example.com/a/b/c…` whole and
  //    left the owner a link he could not read or click.
  out = out.replace(/([/=?&#])([A-Za-z0-9+_-]{40,}={0,2})(?=[/?&#]|$)/g, "$1***");
  // 6. this machine's own names — they are as identifying in a link as anywhere
  for (const secret of machineNames) {
    if (secret.length < 3) continue;
    out = out.split(secret).join("someone");
    const lower = secret.toLowerCase();
    if (lower !== secret) out = out.split(lower).join("someone");
  }
  return out;
}

function lastSegment(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || "";
}

/**
 * The version of a record that may be shown in chat, sent to a client, or read
 * by a guest. Every free-text field goes through `redactForSharing`.
 *
 * This is deliberately a SEPARATE object rather than a flag on the record: the
 * raw record on disk keeps the owner's own detail, and the only way to get a
 * shareable one is to call this. There is no path that shares the raw record by
 * forgetting to set something — and because it is applied AGAIN on the way out
 * of the hub, a record put there by an older or broken engine is still scrubbed
 * before it reaches anybody.
 */
export function shareableRun(record: RunRecord): RunRecord {
  return {
    ...record,
    ask: redactForSharing(record.ask, RUN_LIMITS.ask),
    ...(record.error ? { error: redactForSharing(record.error, RUN_LIMITS.error) } : {}),
    steps: (record.steps ?? []).map(s => ({
      ...s,
      label: redactForSharing(s.label, RUN_LIMITS.label),
      ...(s.detail ? { detail: redactForSharing(s.detail, RUN_LIMITS.detail) } : {}),
    })),
  };
}

// ---------- reading a run in plain words ----------

export interface RunCounts {
  command: number; read: number; write: number; search: number;
  web: number; tool: number; message: number;
}

/** Count the steps by kind. Nothing is inferred — a kind we did not see is 0. */
export function countSteps(steps: RunStep[]): RunCounts {
  const counts: RunCounts = { command: 0, read: 0, write: 0, search: 0, web: 0, tool: 0, message: 0 };
  for (const s of steps ?? []) {
    if (s.kind in counts) counts[s.kind as keyof RunCounts]++;
  }
  return counts;
}

/**
 * One short line a non-developer can read: "checked 4 sites, wrote 1 file, took
 * 41 seconds". Every clause is derived from a step that was actually recorded —
 * there is no sentence in here that can appear without evidence behind it.
 *
 * It lives in shared because the SCREEN shows it verbatim and the hub puts it
 * in a list row; both must say the same words about the same run.
 */
export function summarizeRun(record: RunRecord): string {
  const c = countSteps(record.steps);
  const parts: string[] = [];
  if (c.web) parts.push(plural(c.web, "checked 1 site", `checked ${c.web} sites`));
  if (c.search) parts.push(plural(c.search, "ran 1 search", `ran ${c.search} searches`));
  if (c.read) parts.push(plural(c.read, "read 1 file", `read ${c.read} files`));
  if (c.write) parts.push(plural(c.write, "wrote 1 file", `wrote ${c.write} files`));
  if (c.command) parts.push(plural(c.command, "ran 1 command", `ran ${c.command} commands`));
  if (c.tool) parts.push(plural(c.tool, "used 1 other tool", `used ${c.tool} other tools`));

  const time = `took ${humanDuration(record.durationMs)}`;
  const money = typeof record.usage?.costUsd === "number"
    ? `, cost ${humanMoney(record.usage.costUsd)}` : "";

  if (record.outcome === "cancelled") {
    return parts.length
      ? `Stopped after ${parts.join(", ")} — ${time}${money}.`
      : `Stopped before it got started — ${time}.`;
  }
  if (record.outcome === "failed") {
    const why = record.error ? ` — ${record.error}` : "";
    return parts.length
      ? `Didn't finish. Got as far as ${parts.join(", ")}, ${time}${money}.${why}`
      : `Didn't finish, ${time}${money}.${why}`;
  }
  if (parts.length === 0) {
    return `Answered straight from what it knew — no tools used, ${time}${money}.`;
  }
  return `${capitalise(parts.join(", "))}, ${time}${money}.`;
}

/** A list row for one record — the same words the card shows, in one line. */
export function runListEntry(record: RunRecord): RunListEntry {
  return {
    id: record.id,
    kind: record.kind,
    outcome: record.outcome,
    startedAt: record.startedAt,
    durationMs: record.durationMs,
    ask: record.ask,
    summary: summarizeRun(record),
  };
}

/** "41 seconds", "2 minutes 5 seconds", "under a second" — no decimals, no jargon. */
export function humanDuration(ms: number): string {
  if (ms < 1000) return "under a second";
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total} second${total === 1 ? "" : "s"}`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  const m = `${mins} minute${mins === 1 ? "" : "s"}`;
  return secs ? `${m} ${secs} second${secs === 1 ? "" : "s"}` : m;
}

/** Money as the owner would say it. Under a dollar reads in cents. */
export function humanMoney(usd: number): string {
  if (usd < 0.01) return "less than a cent";
  if (usd < 1) return `${Math.round(usd * 100)} cents`;
  return `$${usd.toFixed(2)}`;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------- a run record that arrived from somewhere else ----------

/**
 * Check a run record before it is stored.
 *
 * A record arrives over the wire from the engine host, so it is UNTRUSTED
 * INPUT exactly like an agent definition is: same law, same shape of answer —
 * a plain-words problem, or null when it is fine. The relay refuses a bad one
 * rather than putting it in the database and discovering the problem when a
 * screen tries to draw it.
 *
 * The id is checked with `isSafeStoredId`, which is deliberately NARROWER than
 * the rule for a file a person named. A run id is generated, never typed, so
 * there is no real-world name to make room for — and loosening file names so
 * `café-menu.txt` works must not quietly loosen what may land on disk here.
 */
export function validateRunRecord(record: unknown): string | null {
  if (!record || typeof record !== "object") return "that isn't a run record";
  const r = record as Partial<RunRecord>;
  if (!isSafeStoredId(r.id)) {
    return "that run id isn't usable";
  }
  if (r.kind !== "chat" && r.kind !== "task" && r.kind !== "schedule") {
    return "a run is a chat reply, a job or a scheduled check-in";
  }
  if (r.outcome !== "ok" && r.outcome !== "failed" && r.outcome !== "cancelled") {
    return "a run either worked, failed or was stopped";
  }
  if (typeof r.agentId !== "string" || r.agentId.length === 0 || r.agentId.length > 64) {
    return "a run belongs to an agent";
  }
  for (const [what, value, max] of [
    ["agent name", r.agentName, AGENT_LIMITS.name],
    ["app name", r.provider, 64],
    ["ask", r.ask, RUN_LIMITS.ask],
    ["requester", r.requestedBy, AGENT_LIMITS.name],
  ] as const) {
    if (typeof value !== "string") return `a run record needs a ${what}`;
    if (value.length > max) return `that ${what} is too long`;
  }
  for (const [what, value] of [
    ["start time", r.startedAt], ["finish time", r.finishedAt],
    ["duration", r.durationMs], ["reply length", r.replyChars], ["event count", r.events],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value)) return `that ${what} isn't a number`;
  }
  if (!Array.isArray(r.steps)) return "a run record needs a list of steps";
  if (r.steps.length > RUN_LIMITS.steps) return "that run has too many steps";
  for (const s of r.steps) {
    if (!s || typeof s !== "object") return "that isn't a step";
    if (typeof s.label !== "string" || s.label.length > RUN_LIMITS.label) {
      return "a step's label is too long";
    }
    if (s.detail !== undefined
      && (typeof s.detail !== "string" || s.detail.length > RUN_LIMITS.detail)) {
      return "a step's detail is too long";
    }
  }
  return null;
}

/**
 * Bring a record under a size cap by dropping steps from the MIDDLE — the first
 * few steps and the last few are what a person reads. The record then SAYS it
 * was truncated, so nobody mistakes a trimmed run for a short one.
 *
 * One implementation, two callers: the engine measures against the indented
 * JSON it writes to disk, the relay against the compact JSON it puts in a
 * database row — so the serializer is handed in rather than assumed. Measuring
 * one shape and storing another is how a cap quietly stops capping.
 */
export function fitRunRecord(
  record: RunRecord,
  maxBytes: number,
  serialize: (r: RunRecord) => string = r => JSON.stringify(r),
): RunRecord {
  let out = record;
  while (serialize(out).length > maxBytes && out.steps.length > 2) {
    const half = Math.max(1, Math.floor(out.steps.length / 2));
    out = {
      ...out,
      steps: [...out.steps.slice(0, half - 1), ...out.steps.slice(half + 1)],
      truncated: true,
    };
  }
  if (serialize(out).length > maxBytes) {
    out = { ...out, steps: [], truncated: true, ask: out.ask.slice(0, RUN_LIMITS.ask) };
  }
  return out;
}

// ---------- helpers ----------

/** Extract @mentions of the given directory (users+agents) from a message text. */
export function extractMentions(
  text: string,
  directory: { id: ID; name: string }[],
): ID[] {
  const found: ID[] = [];
  for (const entry of directory) {
    const re = new RegExp(`@${escapeRe(entry.name)}(?![\\w-])`, "i");
    if (re.test(text)) found.push(entry.id);
  }
  return found;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * An id for ORDINARY things — messages, channels, agents, activity rows.
 *
 * `Math.random()` is not a random-number generator you can bet a lock on: it is
 * fast and predictable by design. So this function is for names, never for
 * keys. Anything that GRANTS ACCESS (an invite code, a sign-in token) must come
 * from `secureId`/`secureToken` in the relay, which uses the OS's cryptographic
 * randomness. The two are deliberately different functions so the choice is
 * visible at every call site (finding #2).
 */
export function newId(prefix: string): ID {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// The skill library — ready-made skills the app ships with (his item 7).
//
// It lives in its own file because it is CONTENT, not rules: pages of written
// instructions that will grow, next to a table of shelves. Re-exported here so
// every part of the app keeps importing one package, and so the renderer never
// has to know it is a separate module.
export {
  SKILL_CATEGORIES, SKILL_LIBRARY, libraryCategory, librarySkillsFor,
  skillFromLibrary, type LibrarySkill, type SkillCategory,
} from "./skill-library.js";
