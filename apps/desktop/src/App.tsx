import React, {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from "react";
import {
  AgentAbilities, AgentApprovals, AgentDef, AgentPresence, AgentPresenceState,
  AgentRespondTo, AgentSkill, AgentSkillFile,
  Approval, ARTIFACT_LIMITS, Artifact, ArtifactAccess, artifactRef, ArtifactRelationView,
  ArtifactVersion, ArtifactVersionRef, ArtifactWorkspaceEntry, Attachment, ATTACHMENT_LIMITS,
  describeArtifactVersion, effectiveArtifactAccess, findArtifactRefs, isArtifactRestricted, latestVersion,
  normaliseArtifactAccess, validateArtifactAccess, versionOf,
  Channel, ChannelMember, ChannelRole, DEMO_MODE_BANNER, downloadContentType,
  GitHubAccountInfo, HarnessInfo, ID, isInlineViewable, isSafeFileName, mayAdministerChannel, mayDriveAgent,
  MENU_ACTIONS, MenuAction, Message, Project, ProjectItem, ProjectItemKind, ProjectItemState,
  REMOTE_ACTIONS, isGitHubWriteKind, RunListEntry, RunRecord, RunStep, RunStepKind,
  EverywhereHit, SearchKind,
  SearchHit, ServerFrame, SKILL_LIMITS, summarizeRun, Task, User, humanDuration, humanMoney,
  NotificationInboxEntry,
  validateMessageText, validateName,
  /* spending limits, "show me the plan first", stand-in models (2026-08-05) —
     the words and the rules come from shared, so the screen and the engine
     cannot describe the same limit differently */
  AgentSpendCap, SPEND_CAP_LIMITS, FALLBACK_MODEL_LIMITS,
  fellBackWords, providerCanBeCapped, spendCapOf, validateSpendCap,
  /* SPENDING BLOCK (2026-08-07) — what the crew costs and what is wasted. The
     screen owns NO arithmetic and writes NO sentence about money of its own:
     every figure and every word below comes out of these, which is what makes
     the screen, the hub and an agent's own `check_token_use` say the same
     thing about the same agent. */
  AgentTokenUse, WasteFinding, dearestFirst, humanTextSize, moneyWords, sentVsWrote,
  /* THE SKILL LIBRARY — the same two lists the relay and the engine can read.
     The screen owns NO copy of a shelf or a skill: the filter bar, the group
     headings and the ordering are all computed from these, so adding a skill
     is a row in `skill-library.ts` and nothing here. */
  SKILL_CATEGORIES, SKILL_LIBRARY, librarySkillsFor, skillFromLibrary, LibrarySkill,
  CLAUDE_DEFAULT_MODEL, CLAUDE_MODELS, modelLabel as sharedModelLabel,
  // joining a friend's Cloud9 — the address book type and the reach words
  KnownHub, reachInWords,
  // how many folders one agent may be opened up to — the hub's own number, so
  // the screen refuses at exactly the count the hub would refuse at
  WHOLE_COMPUTER_LIMITS,
  /* THE HALF-STATE, OWNED IN ONE PLACE — a switch that is on with nothing
     behind it. The crew card, the room rail and the agent editor all ask this
     same function, which is what stops the gap being visible in only one of
     them (which is how Vikas met it: on, empty, and only sayable three screens
     from where he was standing). */
  SUPPLY_SWITCHES, supplyChosen, supplyGapsOf, type SupplySwitch,
  /* HOW MUCH THIS AGENT MAY DO WITHOUT STOPPING TO ASK — his choice, per agent,
     in his own words. The three settings and the words on them live in shared
     (the hub validates them, the engine obeys them, this screen draws them), so
     there is no copy here that could describe a setting as something milder than
     it is. `NEW_AGENT_TRUST` is the middle one; see the note beside it. */
  AgentTrust, NEW_AGENT_TRUST, TRUST_LEVELS, trustLevel, trustOf, trustWords,
  NEW_AGENT_USE_OWNER_SETUP,
  /* HOW HARD AN AGENT SHOULD THINK — the four words and the sentence under each
     one, from the same file the two command lines read. The screen owns no copy:
     it never says "low", "xhigh" or "reasoning effort", because those are the
     apps' words and the translating happens in one place. */
  AGENT_EFFORT_CHOICES, AGENT_EFFORT_UNSET_HINT, AGENT_EFFORT_UNSET_LABEL, type AgentEffort,
  /* WHAT EACH AGENT IS DOING RIGHT NOW, in his words. The join of presence +
     lamp + unanswered go-ahead + last finished job happens in shared, where a
     test can read it — the screen below only draws what comes back. */
  activityRank, agentActivityLine, crewActivitySummary, workingCount,
  type AgentActivityLine, type AgentStatus,
  /* HOW WIDE THE THREAD IS — he asked three times to be able to drag its edge
     and make it big and have it stay. The floors, the default, the point where
     the window is too narrow to split, the conditional tooltip and the rule
     that HIS width is never edited by the window all live in shared, where a
     test reads them. This screen owns no thread arithmetic of its own — that
     is exactly where the last three attempts went wrong. */
  BESIDE_LABEL, EXPAND_LABEL, THREAD_DEFAULT, THREAD_FLOOR, THREAD_STEP,
  cannotSplit, dividerSpokenWords, dividerWords, widestThread, widthHeChose, widthToDraw,
} from "@cloud9/shared";
import { client, RELAY_URL, UNREAD_CEILING, unreadLabel, useWorld, World } from "./store.js";
import { Markdown } from "./markdown.js";
// The live 👀 / 💭 / verdict signals — ephemeral, and drawn so they can never
// be mistaken for a person's reaction. All of it is in that one file.
import { AgentReceipts } from "./receipts.js";
// the live-steps store is ephemeral and lives beside the receipts one, for the
// same reasons — see its header. Only the HOOK comes from there; the steps are
// drawn by `RunSteps` below, the same renderer the stored record uses.
import { useLiveSteps, useLiveWorkByAgent } from "./livesteps.js";
import {
  abilitiesOn, abilityWords, MARKET_CATEGORIES, MARKET_TEMPLATES, MarketTemplate,
} from "./market.js";
/* THE ONE TABLE THAT OWNS WHAT AN AGENT MAY DO — the same rows the casting room
   already reads, the same rows the command line and the agent's own prompt read.
   The editor used to keep its OWN four labels beside it, which is exactly why a
   role hired from the catalogue looked like a different kind of animal from one
   he wrote himself: two vocabularies for one fact. There is now one.
   (Imported by path, like `market.ts` does: the package index also exports the
   half of the engine that spawns processes, and none of that belongs in a
   browser bundle. These two modules read `@cloud9/shared` and nothing else.) */
import {
  abilitiesForReach, CAPABILITIES, describeApprovalNeeds, describeRemoteAsks, effectiveAbilities,
  forcedOnCapabilities, FORCED_ON_NOTE, REACH_LEVELS, Reach, Capability,
  /* FULLY CAPABLE THE SECOND IT EXISTS. What a new agent starts with is the
     capability TABLE's own answer now, not a literal typed into this file — and
     the one press that brings the agents he already has up to the same set is
     the same code, so the two can never mean different things. */
  NEW_AGENT_ABILITIES, capabilitiesForNewAgent,
  agentsWithoutFullReach, bringUpToFullReach,
} from "@cloud9/engine/dist/abilities.js";
import { isolationFor } from "@cloud9/engine/dist/isolation.js";
/* WHOSE SETUP AN AGENT RUNS IN. The ONE owner of that decision lives in the
   engine (`ownersetup.ts`) and is read by both harnesses; this screen reads the
   same file for the WORDS, so the sentence he is shown and the behaviour he gets
   can never come from two different places. */
import { OWNER_SETUP_WORDS } from "@cloud9/engine/dist/ownersetup.js";
/* THE ONE OWNER of "does this agent really have connected services?" — the same
   function the engine host asks when it builds the command line, so the sentence
   on this screen and the flag on that line are one decision. Imported by path
   for the same reason the two lines above are; it reads `@cloud9/shared` only. */
import {
  connectionsFileFor, connectionsWords, type ConnectionsFile,
} from "@cloud9/engine/dist/connections.js";
/* THE ONE OWNER of "which folders outside its own can this agent really reach?"
   — the same function the engine host asks when it builds `--add-dir`, imported
   by path for the same reason, and reading `@cloud9/shared` only. */
import {
  wholeComputerRootsFor, wholeComputerWords, reachLineInRoom,
  type WholeComputerRoots,
} from "@cloud9/engine/dist/wholecomputer.js";
/* THE NOTIFICATION RULES AND THE FIVE EVENTS THAT FEED THEM.
   `decideNotification` is the ONE gate (quiet hours, de-dupe, self-suppression,
   the master switch) — the same one the phone will read. The `notify-feed`
   builders are the ONE place a hub fact (a finished job, a pending approval, a
   mention, a published file) becomes the plain-words event that gate reads.
   The fifth, `threadReplyEvent`, lives in shared rather than the engine because
   it is a RULE about who is in a conversation, not a mapping of a hub object —
   see the block comment above it. The screen never re-decides any of that; it
   draws what the gate raises.
   Imported by path for the same reason the two lines above are: these are the
   halves of shared/engine the browser is allowed to see. */
import {
  chooseDelivery, decideNotification, dedupeKey, isNotifyKind, isRoomMuted, notifyTarget,
  threadReplyEvent, withRoomMuted,
  type Cloud9Notification, type DeliveryChoice, type NotifyEvent, type NotifyTarget,
} from "@cloud9/shared/dist/notify.js";
import {
  approvalEvent, artifactEvent, jobFinishedEvent, mentionEvent, type NotifyViewer,
} from "@cloud9/engine/dist/notify-feed.js";

const isQuickWindow = location.hash === "#quick";

/* ================= HOW OFTEN THE CHAT REDRAWS — the QA hook =================
 *
 * "The chat is not smooth" is a claim about work done per keystroke, and the
 * only honest way to hold it is to COUNT. These two integers per component are
 * what a QA walk (or the console) reads to say "one message arriving redrew N
 * bubbles" — before a change and after it — instead of guessing from the feel.
 *
 * Deliberately kept, not a leftover: it costs one integer add per render, it is
 * the only instrument that can catch this regressing again, and a page that
 * cannot be measured is a page that quietly gets slower. Nothing on screen
 * reads it; nothing decides anything from it.
 */
const renderCounts: Record<string, number> = Object.create(null) as Record<string, number>;
function countRender(name: string): void {
  renderCounts[name] = (renderCounts[name] ?? 0) + 1;
}
if (typeof window !== "undefined") {
  (window as unknown as { __cloud9Renders?: unknown }).__cloud9Renders = {
    counts: renderCounts,
    read: (): Record<string, number> => ({ ...renderCounts }),
    reset: (): void => { for (const k of Object.keys(renderCounts)) delete renderCounts[k]; },
  };
}

/* ============================================================
   CONTRACT SHAPES (docs/plans/feedback-round-1.md)
   Skills come from `@cloud9/shared` — the SAME type the relay stores and the
   engine reads, so if a field exists on the agent, this editor carries it.
   ============================================================ */

type AgentDefPlus = AgentDef;

type Provider = "claude" | "codex";

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex" };

/**
 * WHAT TO CALL A MODEL, AND WHICH MODELS EXIST — from `@cloud9/shared`, never
 * from a list kept here.
 *
 * This file used to hold its own four-name map and its own four-id fallback
 * beside the contract's. The moment the catalogue grew, the screen went on
 * printing `claude-opus-4-8` at him while the hub knew perfectly well it was
 * called Opus 4.8, and offered four models where the app could run a dozen.
 * A second list is not a convenience; it is a slow lie with a delay fuse.
 */
const MODEL_FALLBACK: Record<Provider, string[]> = {
  claude: CLAUDE_MODELS.map(m => m.id),
  codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
};
const MODEL_DEFAULT: Record<Provider, string> = {
  claude: CLAUDE_DEFAULT_MODEL,
  codex: "gpt-5.6-sol",
};

/** The contract's own name for a model, and an em dash when there isn't one saved. */
const modelLabel = (id?: string): string => (id ? sharedModelLabel(id) : "—");

/**
 * What to SAY about the model an agent runs on. The engine only passes
 * `--model` when the agent actually stores one, so an older agent with no
 * stored model runs on whatever its app picks. When we don't know, we say so.
 */
const modelWords = (model?: string): string => (model ? modelLabel(model) : "app's default");

const MODEL_UNSET_HINT =
  "No model was saved for this agent, so it runs on whatever its app picks. " +
  "Open the agent and press Save to pin one.";

/** Only the owner of this Cloud9 can invite or remove people (the relay gates both). */
const isOwner = (me?: User): boolean => !!me && !me.invitedBy;

/** Relay refusals, in Vikas's words. */
const PLAIN_ERROR: Record<string, string> = {
  "that invite has already been used — ask for a new one":
    "That invite has already been used — ask Vikas for a new one.",
  "that invite code isn't valid":
    "That invite code isn't valid. Check it for typos, or ask Vikas for a new one.",
  "bad token":
    "This computer's key isn't recognised any more. Ask Vikas for a fresh invite.",
  "you were removed from this Cloud9":
    "You were removed from this Cloud9. Ask Vikas for a new invite if that was a mistake.",
  "only the owner of this Cloud9 can invite someone":
    "Only Vikas can invite people to this Cloud9.",
};

/* ================= WHAT A FAILURE SAYS ON SCREEN — ONE OWNER =============
 *
 * WHY THIS EXISTS. The gap audit found six places where computer-speak reached
 * his eyes, and the worst of them was the same refusal drawn TWICE on one
 * screen in two different states of politeness: the toast said *you already
 * have a project called "Audit Box" — give this one a different name*, and the
 * line under the form said the identical sentence with **`Error:`** stuck on
 * the front. Two owners for one sentence, and one of them showed him a word
 * that was never part of what went wrong.
 *
 * So there is one owner now, and it answers two questions:
 *
 *  1. WHAT DOES THIS SAY? `sayable` strips the transport's own decoration
 *     (`Error:`, `TypeError:`, `Uncaught …`) — which is the wrapper the hub's
 *     catch-all puts on with `String(err)`, not something anybody wrote for
 *     him. If what is left is still computer-speak (a property read off
 *     nothing, a SQLite code, a stack frame, a Windows path) it is not shown at
 *     all: he gets a sentence a person can act on, and the computer's own words
 *     stay reachable for whoever looks after the machine.
 *
 *  2. IS IT ALREADY ON THIS SCREEN? Every place that draws a failure claims its
 *     sentence while it is visible (`useSaid`), and the toast — the one thing
 *     that floats above every screen — refuses to say a sentence that is
 *     already written somewhere the person is looking.
 *
 * THIS IS SAFE WHETHER OR NOT THE HUB IS FIXED. The hub's catch-all is another
 * agent's work; this owner assumes nothing about it, because it strips what
 * arrives rather than trusting what was sent.
 */

/** The transport's own decoration, never part of what went wrong. */
const TRANSPORT_PREFIX = /^\s*(?:Uncaught\s+)?(?:[A-Za-z_$][\w$]*)?Error(?:\s*\[[^\]]*\])?:\s*/;

/**
 * Shapes that mean "this sentence was written by a computer for a computer".
 *
 * Deliberately narrow: a hub refusal in plain English must pass through
 * untouched, because ~70 of them are already better than anything this file
 * could say instead. Only the things a person can do nothing with are caught.
 */
const COMPUTER_TALK: RegExp[] = [
  /cannot read propert/i,
  /is not a function\b/i,
  /is not defined\b/i,
  /\bundefined\b|\bnull\b/,
  /SQLITE_[A-Z]+/,
  /\b(?:ENOENT|EACCES|EPERM|EBUSY|ECONNREFUSED|ECONNRESET|ETIMEDOUT)\b/,
];

/** A stack frame is never anybody's writing, wherever in the text it turns up. */
const STACK_FRAME = /^\s*at\s+\S+\s*\(/m;

/**
 * HOW FAR INTO A SENTENCE IS STILL ITS BEGINNING.
 *
 * Computer-speak is judged on the OPENING of what arrived, and that is not a
 * detail — it is what tells `String(err)` apart from somebody's writing. A
 * thrown error leads with its jargon ("Cannot read properties of undefined…");
 * a sentence written for a person leads with words and may QUOTE a code further
 * in, the way the hub's unreadable-database sentence names the file and then
 * says what SQLite said about it. Replacing that one wholesale would throw away
 * the half he can act on — worse than the leak it was meant to fix — so it is
 * shown as written, and the hub owns whether it should quote a code at all.
 */
const SENTENCE_OPENING = 48;

/**
 * The sentence a person gets when the computer's own words are no use to them.
 * It says what is true (it did not happen), what is not at risk (nothing was
 * changed), and what to do — and nothing else.
 */
const COMPUTER_TALK_SENTENCE =
  "Something inside Cloud9 went wrong, so that didn't happen — nothing was changed. " +
  "Try it once more, and if it happens again say what you were doing when it did.";

export interface Said {
  /** what to put on screen */
  text: string;
  /** the computer's own words, ONLY when they were too raw to show as the sentence */
  detail?: string;
}

/**
 * Turn anything that failed into something a person can read. One owner.
 *
 * @param raw whatever arrived — a hub refusal, a browser exception's message,
 *            a line of `git` output. Never assumed to be any of them.
 */
function sayable(raw?: string): Said | undefined {
  if (!raw) return undefined;
  const known = PLAIN_ERROR[raw.trim()];
  if (known) return { text: known };
  const stripped = raw.replace(TRANSPORT_PREFIX, "").trim();
  if (!stripped) return { text: COMPUTER_TALK_SENTENCE, detail: raw.trim() };
  const known2 = PLAIN_ERROR[stripped];
  if (known2) return { text: known2 };
  const opening = stripped.slice(0, SENTENCE_OPENING);
  if (STACK_FRAME.test(stripped) || COMPUTER_TALK.some(p => p.test(opening))) {
    return { text: COMPUTER_TALK_SENTENCE, detail: stripped };
  }
  return { text: stripped };
}

/** The old name, kept for the places that only ever want the words. */
const plainError = (text?: string): string | undefined => sayable(text)?.text;

/* ---- IS THIS SENTENCE ALREADY ON THE SCREEN? ----
 *
 * A count per sentence rather than a flag, because the same refusal can
 * legitimately be claimed by two surfaces at once (a form and the panel it sits
 * in) and the last one to go must be the one that releases it. */
const saidOnScreen = new Map<string, number>();
const saidListeners = new Set<() => void>();
let saidVersion = 0;
const saidChanged = (): void => { saidVersion++; for (const fn of saidListeners) fn(); };
const subscribeSaid = (fn: () => void): (() => void) => {
  saidListeners.add(fn);
  return () => { saidListeners.delete(fn); };
};
/** how many places are showing one sentence — the QA suite asks, so it is provable */
function saidCount(text: string): number {
  return saidOnScreen.get(text) ?? 0;
}

/**
 * "This failure is written HERE, where he is looking."
 *
 * Returns the words to draw, and while they are drawn claims the sentence so
 * the toast will not say it a second time. Every place that shows a failure
 * goes through this — that is what makes the claim complete enough to trust.
 */
function useSaid(raw?: string): Said | null {
  const said = useMemo(() => sayable(raw), [raw]);
  const text = said?.text;
  useEffect(() => {
    if (!text) return;
    saidOnScreen.set(text, saidCount(text) + 1);
    saidChanged();
    return () => {
      const left = saidCount(text) - 1;
      if (left > 0) saidOnScreen.set(text, left);
      else saidOnScreen.delete(text);
      saidChanged();
    };
  }, [text]);
  return said ?? null;
}

/**
 * The computer's own words, folded away.
 *
 * Shown only when `sayable` decided the raw text was no use to him — so this is
 * never a second copy of a sentence he has already read. It exists because the
 * one person who CAN act on `SQLITE_CORRUPT` is whoever looks after the
 * machine, and hiding it from them entirely would be a different kind of lie.
 */
function ComputerWords({ detail }: { detail?: string }): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (!detail) return null;
  return (
    <span className="rawsay">
      <button className="linkish rawsay-open" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        {open ? "Hide what the computer said" : "What the computer said"}
      </button>
      {open && <code className="rawsay-text">{detail}</code>}
    </span>
  );
}

/**
 * One failure, drawn where he is looking, in the app's own two shapes.
 *
 * Every inline refusal in this file goes through this component rather than
 * printing a string of its own, which is what makes "one owner" a property of
 * the code and not a promise in a comment.
 */
function Problem({ text, tone = "line", attrs, className, mark = true }: {
  text?: string;
  /** "line" is the line under a form; "notice" is the boxed one on a whole screen */
  tone?: "line" | "notice";
  /** the marks a QA check finds this by — the call site's own, not invented here */
  attrs?: Record<string, string>;
  className?: string;
  /** the exclamation beside it. Off where the whole screen is already the alarm. */
  mark?: boolean;
}): React.JSX.Element | null {
  const said = useSaid(text);
  if (!said) return null;
  return tone === "notice" ? (
    <div className={`notice refused${className ? " " + className : ""}`} role="alert" {...attrs}>
      {mark && <span className="refused-mark" aria-hidden="true">!</span>}
      <span className="problemtext">{said.text}</span>
      <ComputerWords detail={said.detail} />
    </div>
  ) : (
    <p className={`problemline${className ? " " + className : ""}`} role="alert" {...attrs}>
      <span className="problemtext">{said.text}</span>
      <ComputerWords detail={said.detail} />
    </p>
  );
}

/* ================= small formatters ================= */

/**
 * WHERE A COUNT MEETS A WORD — one owner, and there is nowhere else to decide it.
 *
 * The bug this exists to make impossible: the casting room printed
 * "1 CATEGORIES" because the number came from a list and the word was typed by
 * hand beside it. Every such pair in this file used to answer the question its
 * own way — some with a `n === 1 ? "" : "s"`, some with two spelled-out words,
 * and some (this one, "N models", "N Jobs this month") not at all. A rule kept
 * in thirty places is a rule that is wrong in one of them.
 *
 * `plural` answers "the word for this many", and `countOf` answers "the number
 * and its word". True irregulars are passed in — English is not derivable — but
 * the regular rules ("-s", and consonant-y → "-ies", which "abilitys" proved is
 * also a rule and not a spelling) live here, and the DECISION is made here and
 * only here.
 */
const plural = (n: number, one: string, many?: string): string =>
  n === 1 ? one
  : many !== undefined ? many
  : /[^aeiou]y$/i.test(one) ? `${one.slice(0, -1)}ies`
  : `${one}s`;

/** "1 category" · "3 categories" — a number and the right word for it, together. */
const countOf = (n: number, one: string, many?: string): string =>
  `${n} ${plural(n, one, many)}`;

const initials = (name: string): string =>
  name.trim().split(/[\s._-]+/).slice(0, 2).map(p => p[0] ?? "").join("").toUpperCase() || "?";

const clock = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * How often the Activity trail asks the hub for anything new.
 *
 * THE TRAIL IS PULLED, NOT PUSHED, and that is the hub's design: there is one
 * `activity` frame in the whole hub and it is a REPLY. So a trail nobody
 * re-asks for is frozen at the second it was opened.
 *
 * Four seconds is chosen to be slower than a person notices and far slower than
 * anything the app does per keystroke, and the timer only runs while the screen
 * is actually open.
 *
 * THE RIGHT NOW BOARD USES IT TOO, for one half of itself. What each agent is
 * DOING is pushed as it changes; what it LAST DID is not — a finished job only
 * becomes a fact this app holds when the hub is asked again. See
 * `useRunHistoryWhileWatching`, and the six-minute stale row that proved it.
 */
const ACTIVITY_REFRESH_MS = 4000;

/**
 * HOW MANY PAST JOBS AN AGENT'S HISTORY HOLDS — ONE number, for every asker.
 *
 * A history is stored under one key per agent, so the last answer wins. The
 * Activity board asked for 1 and an agent's own Recent work panel asked for 10,
 * which meant visiting Activity and then opening an agent showed ONE job where
 * there should have been ten — the board had overwritten the list. Everything
 * asks for the same number now and reads as much of it as it needs.
 */
const RUN_HISTORY_LIMIT = 10;

/**
 * A message shrunk to one line, for the "answering…" line above a reply.
 *
 * Plain text only: this is a quotation of somebody's words in a place too
 * small for their formatting, and a half-rendered heading or a broken link
 * would be worse than the sentence itself. Line breaks become spaces so a
 * quotation can never push the row it sits in taller.
 */
const quoteOf = (text: string, max = 90): string => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

const sameDay = (a: number, b: number): boolean => {
  const x = new Date(a), y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
};

const dayLabel = (ts: number): string => {
  const now = Date.now();
  if (sameDay(ts, now)) return "Today";
  if (sameDay(ts, now - 86400000)) return "Yesterday";
  const d = new Date(ts);
  return `${d.toLocaleDateString([], { weekday: "long" })} · ${d.getDate()} ${d.toLocaleDateString([], { month: "long" })}`;
};

/** how long the agent took, from the ask to the answer */
const elapsed = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 1) return "under 1s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

const slug = (s: string): string => s.trim().toLowerCase().replace(/[^\w-]+/g, "-").replace(/^-|-$/g, "") || "chat";

/** A file's size in the words a person uses, not in bytes. */
const fileSize = (bytes: number): string => {
  if (bytes < 1000) return `${bytes} bytes`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 100) / 10} KB`;
  return `${Math.round(bytes / 100_000) / 10} MB`;
};

/** The bit after the last dot, upper-cased — what goes on a file's tile. */
const fileKind = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toUpperCase().slice(0, 4) : "FILE";
};

/** "joined 3 Jun" — the date a membership row carries, said the short way. */
const dayStamp = (ts: number): string =>
  new Date(ts).toLocaleDateString([], { day: "numeric", month: "short" });

/**
 * What a room's visibility means, in one word where space is tight and in a
 * full sentence where there is room for one. Both are said out of the same
 * pair, so the chip in the header and the chip in the panel can never drift
 * into meaning different things.
 */
const ROOM_OPEN_WORDS = "Open to anyone here";
const ROOM_OPEN_SHORT = "Open";
const ROOM_PRIVATE_WORDS = "Private";
const ROOM_ARCHIVED_WORDS = "Archived";
/** The relay's own sentence, said back verbatim wherever writing is refused. */
const ARCHIVED_SENTENCE = "that conversation is archived — nothing new can be said in it";

const newId = (): string => `sk_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/* ================= ESCAPE CLOSES WHAT IT OPENED =================
 *
 * ONE OWNER for the whole app. Phase 6 found Escape closing the Ctrl-K palette
 * and doing nothing on the casting room's "Read the brief" — and the reason is
 * the shape of the old code, not one forgotten line: the palette's Escape lived
 * in the window listener at the top of `App`, the search panel's lived in an
 * `onKeyDown` on the panel (so it only worked while the focus was inside it),
 * and four other overlays had no Escape at all. Six overlays, five different
 * answers to one question.
 *
 * There is now one answer. Every overlay calls `useEscapeCloses(onClose)`, which
 * puts its close on a STACK. One window listener serves them all and calls the
 * TOP of the stack only, so a brief opened over a palette closes the brief and
 * leaves the palette — the newest thing closes first, which is what a person
 * means by Escape. Nothing depends on where the focus is, because Escape is
 * about the overlay, not about the box inside it.
 *
 * Adding an overlay without Escape is now a thing you have to leave out on
 * purpose, not something you can forget to add.
 *
 * WHERE THIS DELIBERATELY STOPS. An overlay is a thing with a backdrop that
 * stands in front of the app: the quick-chat palette, the casting-room brief,
 * the skill library, search, invite, browse rooms, new channel — all seven are
 * on the stack and a QA check counts them. The find bar and the thread/room side
 * panels are NOT: they sit beside the conversation rather than over it, and a
 * message being edited underneath them has its own Escape ("put my words back")
 * which stealing would be a worse bug than the one this fixes. When the stack is
 * empty this handler does nothing at all, so those keep working exactly as they
 * did.
 */
const escapeStack: (() => void)[] = [];

if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    const top = escapeStack[escapeStack.length - 1];
    if (!top) return;
    /* Stop the same press being read a second time by anything below — including
       the app's own Ctrl-K handler, which used to close the palette from under a
       modal opened on top of it. */
    e.preventDefault();
    e.stopPropagation();
    top();
  }, true);
}

/**
 * "Escape closes this." Give it the same close the backdrop and the button use,
 * so the three ways out can never mean different things.
 *
 * @param onClose what closing means — the overlay's own close, never a copy
 * @param enabled false while the overlay is not on screen
 */
function useEscapeCloses(onClose: () => void, enabled = true): void {
  /* The latest close, without re-stacking on every render: a handler that is
     replaced mid-press is how the stack would get out of order. */
  const latest = useRef(onClose);
  latest.current = onClose;
  useEffect(() => {
    if (!enabled) return;
    const entry = (): void => latest.current();
    escapeStack.push(entry);
    return () => {
      const at = escapeStack.lastIndexOf(entry);
      if (at >= 0) escapeStack.splice(at, 1);
    };
  }, [enabled]);
}

/* ============ MAY THIS SCREEN BE LEFT WHILE IT HOLDS UNSAVED WORK? ========
 *
 * ONE OWNER for the whole app, and the reason is the audit's worst finding:
 * type a sentence into an agent's brief, click any icon in the left rail, and
 * the editor closes with **no warning, no question, no toast and nothing
 * saved**. The words are simply gone. The editor has a Cancel and a Save, so
 * the app plainly knows there is such a thing as unsaved work — the rail just
 * never asked.
 *
 * The class fix is not a guard bolted onto the rail. It is this: a screen that
 * holds unsaved words SAYS SO (`useUnsavedWork`), every way out of a screen goes
 * through `attemptLeave`, and the question is asked once, in one dialog, in
 * plain words. A new editor-like surface inherits it by declaring itself, and a
 * new way to navigate inherits it by being routed — there is no third place
 * where the rule could be forgotten differently.
 *
 * WHAT COUNTS AS LEAVING: changing the screen, and changing which conversation
 * is open — both of them throw away what an editor-like surface is holding.
 * Opening an overlay (the palette, a modal) does NOT: nothing unmounts, so
 * nothing is lost, and asking would be a question about nothing.
 *
 * WHAT DOES NOT GO THROUGH IT: Save and Delete. Those are his decision ABOUT
 * the work, not a way out of it — asking "are you sure you want to lose this?"
 * the moment he pressed Save would be the app failing to listen. Escape is not
 * touched either; it belongs to the escape stack above, and this dialog is on
 * that stack like every other overlay.
 */

interface UnsavedGuard {
  /** what he is in the middle of, in his words — used in the question */
  what: string;
  /** is there anything unsaved right now? asked at the moment of leaving */
  dirty: () => boolean;
}

const unsavedGuards: UnsavedGuard[] = [];

/** What is holding unsaved work right now, or nothing. Newest surface first. */
function unsavedNow(): string | null {
  for (let i = unsavedGuards.length - 1; i >= 0; i--) {
    if (unsavedGuards[i].dirty()) return unsavedGuards[i].what;
  }
  return null;
}

let leaveAsk: { what: string; go: () => void } | null = null;
const leaveListeners = new Set<() => void>();
const leaveChanged = (): void => { for (const fn of leaveListeners) fn(); };
const subscribeLeave = (fn: () => void): (() => void) => {
  leaveListeners.add(fn);
  return () => { leaveListeners.delete(fn); };
};
const leaveSnapshot = (): { what: string; go: () => void } | null => leaveAsk;

/**
 * Go somewhere — unless something on this screen would lose his words.
 *
 * The ONE door every navigation in the app goes through. When nothing is
 * unsaved this is exactly what it always was: it just goes.
 */
function attemptLeave(go: () => void): void {
  const what = unsavedNow();
  if (!what) { go(); return; }
  leaveAsk = { what, go };
  leaveChanged();
}

/** His answer to the question. "Keep editing" simply puts the screen back. */
function answerLeave(discard: boolean): void {
  const asked = leaveAsk;
  leaveAsk = null;
  leaveChanged();
  if (asked && discard) asked.go();
}

/**
 * "This surface is holding unsaved words." One line per editor-like screen.
 *
 * `dirty` is read at the MOMENT of leaving, through a ref, so a surface can
 * never register a stale answer: what matters is whether there are unsaved
 * words when he clicks away, not whether there were when React last rendered.
 */
function useUnsavedWork(what: string, dirty: boolean): void {
  const latest = useRef(dirty);
  latest.current = dirty;
  useEffect(() => {
    const entry: UnsavedGuard = { what, dirty: () => latest.current };
    unsavedGuards.push(entry);
    return () => {
      const at = unsavedGuards.lastIndexOf(entry);
      if (at >= 0) unsavedGuards.splice(at, 1);
    };
  }, [what]);
}

/**
 * The question itself — asked once, in one place, in plain words.
 *
 * Two ways out and both are named: keep editing (the safe one, and the one
 * Escape and the backdrop mean) or throw the words away deliberately. There is
 * no third button, and no "OK".
 */
function LeaveGuardDialog(): React.JSX.Element | null {
  const asked = useSyncExternalStore(subscribeLeave, leaveSnapshot);
  useEscapeCloses(() => answerLeave(false), !!asked);
  if (!asked) return null;
  return (
    <div className="overlay leaveask" onClick={() => answerLeave(false)}>
      <div className="panel" onClick={e => e.stopPropagation()}>
        <div className="head">You haven't saved what you wrote</div>
        <div className="body">
          <div className="notice">
            {asked.what} still has words in it that have not been saved. If you leave
            now they are thrown away, and there is no way to get them back.
          </div>
        </div>
        <div className="foot">
          <button className="primary keepediting" autoFocus onClick={() => answerLeave(false)}>
            Keep editing
          </button>
          <button className="subtle discardwork" onClick={() => answerLeave(true)}>
            Leave and throw them away
          </button>
        </div>
      </div>
    </div>
  );
}

/* ================= HOW THE VIEW MOVES, AND WHEN ==========================
 *
 * Two rules that used to be spread across the app, and both of them are here.
 */

/**
 * ONE OWNER OF "MAY THE VIEW ANIMATE ON THIS MACHINE".
 *
 * Asked at the moment of every move rather than read once at start-up, because
 * the answer can change while the app is open — this is a setting on the
 * computer, and somebody who turns motion off mid-session means it now.
 *
 * There were two spellings of a moving view before this: the settings screen
 * asked for `behavior: "smooth"` unconditionally, and the message list asked for
 * no behaviour at all (so it jumped). Neither respected the setting. One
 * function answers for both.
 */
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
}

/**
 * Why a message list followed to its bottom.
 *
 * `caughtUp` is him pressing the "↓ new messages" pill: not an arrival and not a
 * send, but a third act of his own — "take me to the newest" — and it is named
 * separately so a check can hold the pill to its own promise rather than reading
 * it as an arrival that happened to land at the right moment.
 */
type FollowReason = "opened" | "arrived" | "sent" | "resized" | "caughtUp";

/**
 * EVERY TIME A MESSAGE LIST FOLLOWED TO ITS BOTTOM, AND WHY.
 *
 * Module-level for exactly the reason `escapeStack` is: the QA suite has to be
 * able to ask the RULE what it did, rather than infer it from a pixel
 * measurement that a slow paint or a smooth animation can make a liar of.
 *
 * A TRAIL AND NOT JUST THE LAST ONE, because one act of his can honestly move
 * the view twice: he sends a message ("sent"), and a moment later that very
 * message comes back from the hub and lands while he is now at the bottom
 * ("arrived"). Reading only the last reason said his send had been an arrival,
 * which is a true fact about the wrong event.
 */
let followed: { n: number; why: FollowReason | null; recent: FollowReason[] } =
  { n: 0, why: null, recent: [] };

/**
 * WHAT THE "↓ NEW MESSAGES" PILL IS SAYING RIGHT NOW.
 *
 * Module-level for the same reason as the trail above: a check must be able to
 * ask the rule, not photograph a pill that may be mid-fade. Written by the one
 * conversation on screen and by nothing else.
 */
let newBelowNow = 0;

/**
 * HOW MANY MESSAGES ARRIVED BELOW HIM SINCE THE LAST ONE HE WAS SHOWN.
 *
 * Counted from the END, so the ordinary answer costs as many steps as there are
 * new messages and not as many as there are messages. His own are never counted:
 * a message he sent is one he has seen by definition, and a pill that offered to
 * take him to his own words would be counting the wrong thing.
 *
 * A `seen` message that is no longer in the list (deleted, or scrolled out of the
 * loaded page) answers 0 rather than guessing. The pill only ever appears for a
 * number this function is sure of — an honest nothing beats a confident wrong
 * number sitting on top of the conversation.
 */
function newBelowCount(messages: readonly Message[], seen: ID, meId: ID | undefined): number {
  if (!seen) return 0;
  let n = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].id === seen) return n;
    if (messages[i].authorId !== meId) n += 1;
  }
  return 0;
}

/** How far off the bottom still counts as "he is down there, reading the newest". */
const AT_BOTTOM_SLACK = 80;

/**
 * How long a follow of ours may go WITHOUT MOVING before it is declared over.
 *
 * NOT how long a follow lasts, and the difference is a bug Vikas reported in his
 * own words: "the chat window doesn't auto-scroll to the newest message on
 * Enter". This used to be read as the whole length of a follow — but a smooth
 * scroll does NOT take a few hundred milliseconds however far it has to go, it
 * takes longer the further it goes. Measured in this app: 13,000px takes about
 * 1,530ms. So the timer fired with 2,197px still to run, the rule stopped
 * recognising its own animation, and read its own scroll events as the reader
 * walking away (`atBottom.current = false`). His message came back from the hub
 * 300ms later, and BOTH the things that would have chased it were switched off
 * by that one false belief — the arrival rule (`if (atBottom.current) follow`)
 * and the resize watcher (`if (!atBottom.current) return`). The animation
 * finished at the bottom the list had BEFORE his message existed, so it stopped
 * exactly one message short of it: 267px, with his own words below the fold and
 * no pill to say so (his own message never counts toward the pill).
 *
 * So this is now measured from the last time the follow MOVED, and re-armed on
 * every step of it (see `noteScrolled`). The guarantee it was written for is
 * unchanged and now actually holds: a follow that has stopped moving for this
 * long is over, whether it landed or not, so the rule can never be left
 * permanently believing the view is moving when it is not.
 */
const FOLLOW_SETTLES_MS = 700;

/** Where `scrollTop` would have to be for this list to be at its bottom. */
function bottomOf(el: HTMLElement): number {
  return el.scrollHeight - el.clientHeight;
}

/**
 * ONE OWNER OF "WHEN DOES A MESSAGE LIST FOLLOW TO ITS BOTTOM".
 *
 * WHY THIS EXISTS. Vikas reported it in his own words: he types in a
 * conversation and the view does not move to what he just said. Reproduced three
 * ways before a line was changed, and it was never one bug — it was one MISSING
 * RULE with three faces:
 *
 *  1. He had read back a little way, so the app had decided he was "not at the
 *     bottom" — and then he SENT a message and the app left him where he was.
 *     His own message landed 1461px below the foot of a 591px list: he typed,
 *     pressed Enter, and nothing on screen changed at all. Sending is not a
 *     message arriving. Nobody sends a message they do not want to see, so a
 *     send follows ALWAYS, wherever he had scrolled to.
 *  2. Everything that moves the bottom without adding a message was ignored: the
 *     file tray opening pushed the newest message 154px out of sight, a row
 *     growing taller as its picture finished loading pushed it 150px out, and
 *     the box growing as he types a second line does the same. The rule was
 *     watching for new messages when what it should watch for is THE BOTTOM
 *     MOVING, whatever moved it.
 *  3. When it did follow, it jumped. He asked for smooth — and smooth has to
 *     mean "unless this computer has asked for no movement".
 *
 * This is also the other half of finding #19. That finding was a walk back
 * through pages being yanked to the newest message; the cure was one owner for
 * the view. Widening the rule without widening that owner would have put the
 * yank straight back, so the two are the same function: `claimed` is how
 * anything that owns the view — an older page going on the front, a jump to one
 * particular message — says so, and it is asked on EVERY path in here.
 *
 * @param ref     the scrolling list
 * @param claimed something other than "follow the newest" owns the view now
 */
function useFollowToBottom(
  ref: React.RefObject<HTMLDivElement | null>,
  claimed: () => boolean,
): {
  follow: (why: FollowReason) => void;
  atBottom: React.MutableRefObject<boolean>;
  noteScrolled: () => void;
} {
  const atBottom = useRef(true);
  /** the first placement is an arrangement, not a movement, so it never animates */
  const placed = useRef(false);
  /** where the bottom was the last time this rule put the view on it */
  const lastBottom = useRef(-1);
  /** a follow this rule started is still running — the view is moving on its own */
  const following = useRef(false);
  /** how far down the last scroll event found the view */
  const lastTop = useRef(-1);
  const settle = useRef<ReturnType<typeof setTimeout>>(undefined);
  const claimedRef = useRef(claimed);
  claimedRef.current = claimed;

  /**
   * THIS FOLLOW IS STILL RUNNING — start the clock again from now.
   *
   * Called when a follow begins and on every step of it that we recognise as
   * ours. The clock therefore measures STILLNESS, not the length of the
   * animation: a long scroll keeps re-arming it as it goes and stays ours the
   * whole way down, while one that has genuinely stopped moving runs out and is
   * let go. See `FOLLOW_SETTLES_MS`.
   */
  const keepFollowing = useCallback((): void => {
    following.current = true;
    clearTimeout(settle.current);
    settle.current = setTimeout(() => { following.current = false; }, FOLLOW_SETTLES_MS);
  }, []);

  const follow = useCallback((why: FollowReason): void => {
    const el = ref.current;
    if (!el) return;
    /* He is at the bottom BY DEFINITION from here on, said rather than measured.
       A smooth scroll reports its progress over several frames, so anything that
       measured the position in the middle of one would decide he was not down
       there and stop following — the animation would fight the rule that started
       it. */
    atBottom.current = true;
    lastBottom.current = bottomOf(el);
    following.current = true;
    /* WHERE THIS FOLLOW STARTS FROM, and not a sentinel below every real
       position. It was `-1`, which made the FIRST event after a follow began
       always look like ours — so a reader who jumped to the very top of the
       scrollback inside that first frame was ignored, the app went on believing
       he was at the bottom, and the next page put on the front yanked him down
       902px. An existing check caught it; the follow now knows the one thing that
       makes its own movement recognisable, which is that it only ever goes down
       from here. */
    lastTop.current = el.scrollTop;
    keepFollowing();
    const behavior: ScrollBehavior = placed.current ? scrollBehavior() : "auto";
    placed.current = true;
    followed = {
      n: followed.n + 1, why,
      // bounded: a trail is evidence, not a log
      recent: [...followed.recent, why].slice(-12),
    };
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, [ref, keepFollowing]);

  const noteScrolled = useCallback((): void => {
    const el = ref.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    const down = dist < AT_BOTTOM_SLACK;
    /**
     * THE APP MUST NOT MISTAKE ITS OWN MOVEMENT FOR THE READER'S.
     *
     * Found by the very check written for the rule above, which is the only
     * reason it is known: a smooth follow reports its progress as ordinary
     * scroll events, and reading those as "where he is" is how the app talked
     * itself out of its own follow. Halfway down a long list it wrote down "he
     * is not at the bottom" — so when the picture in that message finished
     * loading a moment later and pushed the bottom further, the rule declined to
     * follow it and left 115px of the newest message off screen.
     *
     * HOW OURS IS TOLD FROM HIS, and it is not a timer: a follow only ever moves
     * the view FURTHER DOWN the list. So an event that arrives while one is in
     * flight and reports the view further down is ours, and one that reports it
     * further UP cannot be — that is him, and it is believed at once. (A timer
     * alone got this wrong and an existing check caught it: a jump back through
     * the scrollback that began within the same moment as a follow was swallowed
     * whole, and the reader lost their place by 903px.)
     *
     * MEASURED AS A POSITION AND NOT AS A DISTANCE FROM THE BOTTOM, which is a
     * mistake this rule made once and a check caught: the distance from the
     * bottom GROWS during a perfectly good follow whenever the content grows
     * under it — a picture finishing loading does exactly that, and reading it as
     * "he scrolled away" abandoned the follow 115px short of the newest message,
     * which is the very bug all this exists to fix.
     *
     * On top of that his own wheel, drag or key ends a follow immediately
     * (below), and one that has STOPPED MOVING for `FOLLOW_SETTLES_MS` is over
     * regardless — so the rule can never be left believing the view is moving
     * when it is still.
     *
     * AND A STEP OF OUR OWN ANIMATION SAYS IT IS STILL RUNNING (`keepFollowing`).
     * That is the fix for the bug he reported as "the chat window doesn't
     * auto-scroll to the newest message on Enter": the clock used to be started
     * once at the top of the follow, so a scroll long enough to outlast it —
     * 13,000px takes about 1,530ms, and 700ms is the clock — handed the rest of
     * its own animation to the branch below, which wrote down "he is not at the
     * bottom". His own message then arrived into a rule that had talked itself
     * out of following anything, and the view stopped 267px short of it. Every
     * step down re-arms the clock, so the follow is ours for as long as it is
     * really moving and no longer.
     */
    if (following.current) {
      if (down) {
        clearTimeout(settle.current);
        following.current = false; atBottom.current = true; lastTop.current = el.scrollTop; return;
      }
      /* still going down: this step is ours, and it says the follow is alive */
      if (el.scrollTop >= lastTop.current) { lastTop.current = el.scrollTop; keepFollowing(); return; }
      following.current = false;
    }
    lastTop.current = el.scrollTop;
    atBottom.current = down;
  }, [ref, keepFollowing]);

  /* HE CAN ALWAYS INTERRUPT. A wheel, a drag or a key is the reader taking the
     view back, and it ends our follow there and then — otherwise scrolling away
     during an animation would be read as part of the animation and undone. */
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const his = (): void => { following.current = false; };
    const opts = { passive: true } as const;
    el.addEventListener("wheel", his, opts);
    el.addEventListener("touchstart", his, opts);
    el.addEventListener("mousedown", his, opts);
    el.addEventListener("keydown", his);
    return () => {
      el.removeEventListener("wheel", his);
      el.removeEventListener("touchstart", his);
      el.removeEventListener("mousedown", his);
      el.removeEventListener("keydown", his);
    };
  }, [ref]);

  useEffect(() => () => clearTimeout(settle.current), []);

  /**
   * THE BOTTOM MOVING IS THE TRIGGER, not a message arriving.
   *
   * The list itself is watched (it shrinks when the box below it grows — a
   * second line typed, the file tray opening, the "answering…" bar appearing)
   * and so is every row in it (a row grows when its picture finishes loading, or
   * when a reaction wraps onto a second line). Between them there is nothing
   * that can move the bottom without this being told.
   *
   * Deliberately re-run on every render with no dependency list: a row that
   * appeared in this render has to be watched too, and a list of dependencies
   * that tried to describe "every row" is a list that would be wrong the first
   * time anything new was drawn.
   */
  React.useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (claimedRef.current()) return;
      if (!atBottom.current) return;
      /* Only a bottom that really MOVED. A row starts reporting its size the
         moment it is watched, and that first report is news about nothing. */
      if (bottomOf(el) === lastBottom.current) return;
      follow("resized");
    });
    ro.observe(el);
    for (const row of Array.from(el.children)) ro.observe(row);
    return () => ro.disconnect();
  });

  return { follow, atBottom, noteScrolled };
}

/* ================= the house marks ================= */

const stroke = {
  fill: "none", stroke: "currentColor", strokeWidth: 1.7,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
};

function CloudMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" {...stroke} aria-hidden="true">
      <path d="M6.5 17.5a4 4 0 0 1-.4-8A5.4 5.4 0 0 1 16.4 8.2a3.6 3.6 0 0 1 1 7.1" />
      <circle cx="12" cy="15.6" r="2.6" />
    </svg>
  );
}
const IconChat = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M20 14.5a2.5 2.5 0 0 1-2.5 2.5H8l-4 3.5V6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5Z" />
    <path d="M8.5 9.5h7M8.5 12.5h4" />
  </svg>
);
const IconCrew = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="9" cy="8.5" r="3.2" /><path d="M3.5 19.5a5.5 5.5 0 0 1 11 0" />
    <circle cx="17.5" cy="9.8" r="2.4" /><path d="M15 19.5a5 5 0 0 1 5.5-4.4" />
  </svg>
);
const IconTasks = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="4" y="4.5" width="16" height="15" rx="2.4" /><path d="M8 10l2.2 2.2L15.5 7" /><path d="M8 15.5h8" />
  </svg>
);
/** FILES — three immutable sheets held together as one version chain. */
const IconFiles = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M7 4.5h8l3 3v12H7Z" /><path d="M15 4.5v3h3" />
    <path d="M4 7.5v12h10" /><path d="M10 12h5M10 15h5" />
  </svg>
);
/**
 * PROJECTS — a branch leaving the trunk and coming back.
 *
 * Not a folder and not a box: the one decision he has already made about how
 * agents touch his code is "branch and pull request, always", and that shape is
 * what the rail should say this section is about.
 */
const IconProjects = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="7" cy="5.6" r="2.1" /><circle cx="7" cy="18.4" r="2.1" /><circle cx="17.5" cy="9.2" r="2.1" />
    <path d="M7 7.7v8.6" /><path d="M17.5 11.3v.8a3.2 3.2 0 0 1-3.2 3.2h-2.1a3.2 3.2 0 0 0-3.2 3.1" />
  </svg>
);
const IconLog = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12.5h4l2.2-6 3.4 12 2.5-7.5 1.6 3.5H21" /></svg>
);
const IconBell = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M6.5 16.5h11l-1.5-2v-4a4 4 0 0 0-8 0v4Z" />
    <path d="M10 19a2.2 2.2 0 0 0 4 0" />
  </svg>
);
/* Three bars of different heights — "what things cost, compared". Deliberately
   NOT a coin or a dollar sign: this screen is about where the money went as
   much as how much it was, and half the agents on it may report no money at
   all. Drawn in the same one-stroke line style as every other rail icon. */
const IconSpending = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 20h16" /><path d="M7.5 20v-6" /><path d="M12 20V6" /><path d="M16.5 20v-9" />
  </svg>
);
const IconBolt = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13.5 3 5 13.5h5.6L9.8 21l8.7-10.6h-5.7Z" /></svg>
);
const IconGear = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="3.1" />
    <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M17.9 6.1l-1.6 1.6M7.7 16.3l-1.6 1.6M17.9 17.9l-1.6-1.6M7.7 7.7 6.1 6.1" />
  </svg>
);
const MarkClaude = (): React.JSX.Element => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} strokeWidth={1.8} aria-hidden="true">
    <path d="M7 18 12 5l5 13" /><path d="M9 14h6" />
  </svg>
);
const MarkCodex = (): React.JSX.Element => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} strokeWidth={1.8} aria-hidden="true">
    <path d="m9 9-3.5 3L9 15" /><path d="m15 9 3.5 3L15 15" />
  </svg>
);
/* The GitHub cat, drawn in the same one-weight line as the two marks above so
   the third card in Settings reads as one of the set, not a pasted-in logo. */
const MarkGitHub = (): React.JSX.Element => (
  <svg width="18" height="18" viewBox="0 0 24 24" {...stroke} strokeWidth={1.7} aria-hidden="true">
    <path d="M9 19.5c-4 1.2-4-2.2-5.5-2.7M14.5 21.5v-3.3c0-1 .1-1.6-.5-2.2 2.6-.3 4.9-1.3 4.9-5.4a4.2 4.2 0 0 0-1.1-2.9 3.9 3.9 0 0 0-.1-2.9s-.9-.3-3 1.1a10.3 10.3 0 0 0-5.4 0C7.2 4.5 6.3 4.8 6.3 4.8a3.9 3.9 0 0 0-.1 2.9 4.2 4.2 0 0 0-1.1 3c0 4 2.3 5 4.9 5.3-.4.4-.5.9-.5 1.5v4" />
  </svg>
);
const MarkFolder = (): React.JSX.Element => (
  <svg width="15" height="15" viewBox="0 0 24 24" {...stroke} aria-hidden="true">
    <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2l2 2.5h7.8A2.5 2.5 0 0 1 21 10v7.5A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z" />
  </svg>
);
const MarkIdea = (): React.JSX.Element => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--ultra)"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 3v2M5.6 5.6l1.4 1.4M3 12h2M19 12h2M18.4 5.6 17 7" />
    <path d="M9.5 18h5M10 21h4" /><path d="M12 8a4.5 4.5 0 0 1 2.6 8.2H9.4A4.5 4.5 0 0 1 12 8Z" />
  </svg>
);
const MarkGate = (): React.JSX.Element => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--marigold)"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="6" width="18" height="12" rx="2.4" /><path d="M3 10h18M6.5 14.5h3" />
  </svg>
);
const MarkAnswer = (): React.JSX.Element => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--pine)"
    strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 5.5h16M4 10h16M4 14.5h11M4 19h7" />
  </svg>
);
const MarkClock = (): React.JSX.Element => (
  <svg width="13" height="13" viewBox="0 0 24 24" {...stroke} strokeWidth={1.8} aria-hidden="true">
    <circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />
  </svg>
);

/* ================= cast plates =================
   Every agent gets a portrait drawn from its own name, so the same agent
   wears the same face on every machine and after every restart. The paint is
   the six `--plate-N-*` token sets in styles.css — no raw colour here.
   ================================================================= */

interface Face { c1: string; c2: string; ground: string; head: string; eyes: string; crest: string }

const PIGMENTS = [1, 2, 3, 4, 5, 6].map(n => ({
  c1: `var(--plate-${n}-a)`,
  c2: `var(--plate-${n}-b)`,
  ground: `var(--plate-${n}-c)`,
}));
const HEADS = ["arch", "orb", "block", "lozenge"] as const;
const EYES = ["visor", "dots", "arcs", "ring"] as const;
const CRESTS = ["antenna", "halo", "bars", "wedge", "braid"] as const;

/** one number from a name — same name in, same number out, always */
function seedOf(s: string): number {
  let h = 2166136261;
  const t = s.trim().toLowerCase() || "cloud9";
  for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function faceFor(identity: string): Face {
  const h = seedOf(identity);
  const p = PIGMENTS[h % PIGMENTS.length];
  return {
    c1: p.c1, c2: p.c2, ground: p.ground,
    head: HEADS[(h >>> 4) % HEADS.length],
    eyes: EYES[(h >>> 9) % EYES.length],
    crest: CRESTS[(h >>> 14) % CRESTS.length],
  };
}

function HeadShape({ f }: { f: Face }): React.JSX.Element {
  if (f.head === "orb") return <circle className="p-head" cx="50" cy="54" r="25" fill={f.c1} />;
  if (f.head === "block") return <rect className="p-head" x="27" y="30" width="46" height="48" rx="11" fill={f.c1} />;
  if (f.head === "lozenge") return <ellipse className="p-head" cx="50" cy="54" rx="22" ry="27" fill={f.c1} />;
  return <path className="p-head" d="M27 78V52a23 23 0 0 1 46 0v26Z" fill={f.c1} />;
}

function EyeShape({ f }: { f: Face }): React.JSX.Element {
  if (f.eyes === "visor") {
    return (
      <g className="p-eyes">
        <rect x="34" y="48" width="32" height="11" rx="5.5" fill={f.c2} />
        <circle cx="42" cy="53.5" r="2.4" fill={f.ground} />
        <circle cx="58" cy="53.5" r="2.4" fill={f.ground} />
      </g>
    );
  }
  if (f.eyes === "arcs") {
    return (
      <g className="p-eyes" fill="none" stroke={f.c2} strokeWidth="3.4" strokeLinecap="round">
        <path d="M38 55a5 5 0 0 1 9 0" /><path d="M53 55a5 5 0 0 1 9 0" />
      </g>
    );
  }
  if (f.eyes === "ring") {
    return (
      <g className="p-eyes">
        <circle cx="50" cy="53" r="10" fill="none" stroke={f.c2} strokeWidth="3.4" />
        <circle cx="50" cy="53" r="3.4" fill={f.c2} />
      </g>
    );
  }
  return (
    <g className="p-eyes">
      <circle cx="42" cy="53" r="3.6" fill={f.c2} /><circle cx="58" cy="53" r="3.6" fill={f.c2} />
    </g>
  );
}

function CrestShape({ f }: { f: Face }): React.JSX.Element {
  const s = { stroke: f.c1, strokeWidth: 3, strokeLinecap: "round" as const, fill: "none" };
  if (f.crest === "antenna") {
    return <g><path d="M50 30v-9" {...s} /><circle cx="50" cy="18" r="4" fill={f.c1} /></g>;
  }
  if (f.crest === "halo") return <ellipse cx="50" cy="21" rx="17" ry="5" {...s} />;
  if (f.crest === "bars") return <path d="M40 30v-8M50 30v-12M60 30v-8" {...s} />;
  if (f.crest === "wedge") return <path d="M50 19l9.5 10.5h-19Z" fill={f.c1} />;
  return <path d="M34 26q8-9 16 0t16 0" {...s} />;
}

function Portrait({ identity, size, working, className, fill }: {
  identity: string; size?: number; working?: boolean; className?: string; fill?: boolean;
}): React.JSX.Element {
  const f = faceFor(identity);
  const gid = `plate-${React.useId().replace(/:/g, "")}`;
  return (
    <span className={`portrait${working ? " is-thinking" : ""}${className ? ` ${className}` : ""}`}
      style={fill ? undefined : { width: size, height: size }}>
      <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" role="img"
        aria-label={`Portrait of ${identity}`}>
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={f.c2} />
            <stop offset="100%" stopColor={f.c2} stopOpacity=".55" />
          </linearGradient>
        </defs>
        <rect width="100" height="100" fill={`url(#${gid})`} />
        <circle cx="50" cy="44" r="34" fill="var(--plate-sheen)" opacity=".45" />
        <path d="M0 82h100v18H0Z" fill={f.ground} opacity=".18" />
        <CrestShape f={f} /><HeadShape f={f} /><EyeShape f={f} />
        <path d="M22 100c0-13 12.5-20 28-20s28 7 28 20Z" fill={f.ground} />
      </svg>
    </span>
  );
}

type Lamp = "working" | "waiting" | "idle" | "asleep";

const lampToPlate = (lamp: string): Lamp =>
  lamp === "run" ? "working" : lamp === "off" ? "asleep" : lamp === "wait" ? "waiting" : "idle";

/* ================= is this agent actually usable right now? =================
 *
 * HIS BUG: every agent showed offline, forever. The hub now works the answer
 * out from what it genuinely observes — is the owner's engine connected, is
 * Claude or Codex signed in on that machine, did the owner pause it — and sends
 * it down with a plain sentence saying WHY. None of that reached the screen.
 *
 * Nothing on this side decides anything. These are only the words for the four
 * answers, and the rule for the fifth case that is not an answer:
 *
 *   AN ABSENT ENTRY IS NOT "READY". It means nobody has reported on that agent
 *   yet, and it is drawn as an empty ring, never a green dot. Defaulting the
 *   other way is precisely the lie he caught — a screen saying all is well
 *   because it had not looked.
 */
const PRESENCE_WORDS: Record<AgentPresence, string> = {
  ready: "Ready", working: "Working", paused: "Paused", offline: "Offline",
};

/** What the hub said about this agent, or undefined for "nobody has said". */
/* Takes only the part of the world it reads (`Pick<World, …>`), so a screen
   holding a selected SLICE can ask it too — see `useWorld` in store.ts. A full
   world still satisfies it, so every older call site is unchanged. */
function presenceOf(world: Pick<World, "presence">, agentId: ID): AgentPresenceState | undefined {
  return world.presence[agentId];
}

const NOT_YET_LOOKED = "Nobody has reported on this agent yet.";

/** The one sentence a hover shows: the state, and why it is that state. */
function presenceTitle(p: AgentPresenceState | undefined): string {
  return p ? `${PRESENCE_WORDS[p.presence]} — ${p.reason}` : NOT_YET_LOOKED;
}

/* ================= A JOB IN TROUBLE, IN THE WORDS HE READS =================
 *
 * HIS BUG: a job that is stuck or that fell over looked exactly like one that
 * is working. The state was stored and the reason was stored, and neither of
 * them said anything on the screen he actually looks at.
 *
 * ONE OWNER. Everything on any screen that says "this job is in trouble" — the
 * job card, the room's job list, the agent's presence line — asks these three
 * functions. Nothing works the answer out a second time, so two panels can
 * never disagree about whether an agent is fine.
 *
 * AND NO INVENTED REASON. The reason is whatever the engine really recorded
 * (`error`, else the agent's own `summary`). A job that fell over before it had
 * anything to say has neither, and then the screen SAYS it has neither — a made
 * up sentence there reads exactly like a real one, which is worse than silence.
 */
const NO_REASON_RECORDED = "no reason was recorded";

type TroubleKind = "failed" | "blocked" | "cancelled";

/** The state word itself, in plain language — never the stored code word. */
const TROUBLE_WORD: Record<TroubleKind, string> = {
  failed: "Failed",
  blocked: "Stuck — waiting on something",
  cancelled: "Stopped",
};

interface TaskTrouble { kind: TroubleKind; word: string; reason: string }

/** Is this job in trouble, and what does it say? `null` for every other state. */
function taskTrouble(t: Task): TaskTrouble | null {
  if (t.status !== "failed" && t.status !== "blocked" && t.status !== "cancelled") return null;
  const kind: TroubleKind = t.status;
  const said = (t.error ?? t.summary ?? "").trim();
  return { kind, word: TROUBLE_WORD[kind], reason: said || NO_REASON_RECORDED };
}

/**
 * THE JOB THIS AGENT IS IN TROUBLE ON, if there is one.
 *
 * Derived from the stored jobs and nothing else — there is no second status
 * system beside the hub's presence. A job still stuck beats an older one that
 * fell over, because the stuck one is the one that is still not moving; and a
 * job somebody deliberately stopped is not trouble, so it is not counted here.
 */
function agentTrouble(world: Pick<World, "tasks">, agentId: ID): { task: Task; trouble: TaskTrouble } | null {
  const mine = world.tasks.filter(t => t.agentId === agentId);
  const newest = (list: Task[]): Task | undefined =>
    [...list].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const stuck = newest(mine.filter(t => t.status === "blocked"));
  const hit = stuck ?? (newest(mine)?.status === "failed" ? newest(mine) : undefined);
  const trouble = hit ? taskTrouble(hit) : null;
  return hit && trouble ? { task: hit, trouble } : null;
}

/**
 * WHAT A PRESENCE ROW SAYS. The hub's own word and reason — unless the agent's
 * job is stuck or fell over, and then that, said on the line that already
 * exists rather than on a second badge nobody would think to read.
 */
function presenceSays(world: Pick<World, "tasks">, agentId: ID, pres: AgentPresenceState | undefined): {
  word: string; reason: string; trouble: TroubleKind | null; title: string;
} {
  const bad = agentTrouble(world, agentId);
  if (bad) {
    const reason = `${bad.task.title} — ${bad.trouble.reason}`;
    return {
      word: bad.trouble.word, reason, trouble: bad.trouble.kind,
      title: `${bad.trouble.word} — ${reason}`,
    };
  }
  return {
    word: pres ? PRESENCE_WORDS[pres.presence] : "Not looked yet",
    reason: pres ? pres.reason : "",
    trouble: null,
    title: presenceTitle(pres),
  };
}

/** The one plain-words line a job in trouble prints: the state, then why. */
function TroubleLine({ task }: { task: Task }): React.JSX.Element | null {
  const tr = taskTrouble(task);
  if (!tr) return null;
  return (
    <div className={`taskresult trouble is-${tr.kind}`} data-trouble={tr.kind}>
      <b>{tr.word}</b>{tr.reason}
    </div>
  );
}

/**
 * @param presence pass it and the dot tells the truth about availability, with
 * `undefined` drawn as "we have not looked". Leave it off entirely and the face
 * falls back to the older `lamp`, which is about a job rather than an agent.
 */
function AgentFace({ name, size, lamp, presence, hasPresence }: {
  name: string; size: number; lamp?: string;
  presence?: AgentPresenceState;
  /** true when `presence` is the field being shown, even if it is undefined */
  hasPresence?: boolean;
}): React.JSX.Element {
  const state = lampToPlate(lamp ?? "live");
  const working = hasPresence ? presence?.presence === "working" : state === "working";
  return (
    <span className="avatar">
      <Portrait identity={name} size={size} working={working} />
      {hasPresence
        ? <span className={`status pdot p-${presence?.presence ?? "unknown"}`}
          title={presenceTitle(presence)} />
        : <span className={`status st-${state}`} />}
    </span>
  );
}

/** People keep their initials — a portrait would be a face they never chose. */
function PersonFace({ name, size, lamp }: { name: string; size: number; lamp?: string }): React.JSX.Element {
  const tone = seedOf(name) % 6;
  return (
    <span className="avatar">
      <span className={`initialplate tone-${tone}`}
        style={{ width: size, height: size, fontSize: Math.max(10, Math.round(size * 0.42)) }}>
        {initials(name)}
      </span>
      {lamp && <span className={`status st-${lampToPlate(lamp)}`} />}
    </span>
  );
}

/** The empty studio, waiting: a lamp, a stool and three blank plates. */
function StudioScene(): React.JSX.Element {
  return (
    <svg className="stage-scene" viewBox="0 0 460 400" role="img"
      aria-label="An empty studio with a lamp, a stool and three blank plates on the wall">
      <defs>
        <radialGradient id="c9lamp" cx="50%" cy="16%" r="52%">
          <stop offset="0%" stopColor="var(--marigold-hi)" stopOpacity=".38" />
          <stop offset="100%" stopColor="var(--marigold-hi)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="0" y="0" width="460" height="400" rx="18" fill="var(--surface)" stroke="var(--line)" />
      <path d="M0 300h460v82a18 18 0 0 1-18 18H18A18 18 0 0 1 0 382Z" fill="var(--surface-2)" />
      <path d="M0 300h460" stroke="var(--line)" />
      <circle cx="230" cy="120" r="150" fill="url(#c9lamp)" />
      <path d="M230 0v56" stroke="var(--ink-3)" strokeWidth="2" />
      <path d="M198 92c0-18 14-33 32-33s32 15 32 33Z" fill="var(--ink)" opacity=".9" />
      <ellipse cx="230" cy="92" rx="32" ry="6" fill="var(--marigold-hi)" />
      <circle cx="230" cy="96" r="4.5" fill="var(--marigold-hi)" />
      <g stroke="var(--line)" fill="var(--surface-2)">
        <rect x="72" y="150" width="86" height="112" rx="10" />
        <rect x="187" y="136" width="86" height="112" rx="10" />
        <rect x="302" y="150" width="86" height="112" rx="10" />
      </g>
      <g fill="var(--line)">
        <circle cx="115" cy="198" r="17" /><rect x="96" y="226" width="38" height="20" rx="10" />
        <circle cx="230" cy="184" r="17" /><rect x="211" y="212" width="38" height="20" rx="10" />
        <circle cx="345" cy="198" r="17" /><rect x="326" y="226" width="38" height="20" rx="10" />
      </g>
      <g stroke="var(--ink-3)" strokeWidth="2.4" fill="none" strokeLinecap="round">
        <ellipse cx="230" cy="316" rx="34" ry="9" fill="var(--pine-soft)" />
        <path d="M204 320l-10 44M256 320l10 44M230 322v42M200 348h60" />
      </g>
      <g fill="var(--marigold-hi)" opacity=".5">
        <circle cx="140" cy="106" r="2.4" /><circle cx="318" cy="128" r="1.8" />
        <circle cx="292" cy="74" r="2" /><circle cx="176" cy="60" r="1.6" />
      </g>
    </svg>
  );
}

/** The signed-off in-tray: an empty screen is an invitation, not a blank. */
function EmptyTray({ title, line }: { title: string; line: React.ReactNode }): React.JSX.Element {
  return (
    <div className="emptyplate">
      <svg width="164" height="124" viewBox="0 0 164 124" role="img"
        aria-label="An empty in-tray, everything signed off">
        <g fill="none" stroke="var(--ink-3)" strokeWidth="1.8" strokeLinejoin="round">
          <path d="M22 66v34a6 6 0 0 0 6 6h108a6 6 0 0 0 6-6V66" fill="var(--surface)" />
          <path d="M22 66h30l7 11h46l7-11h30" fill="var(--surface-2)" />
          <path d="M40 60V32a7 7 0 0 1 7-7h70a7 7 0 0 1 7 7v28" opacity=".55" />
          <path d="M56 52V22a6 6 0 0 1 6-6h40a6 6 0 0 1 6 6v30" opacity=".28" />
        </g>
        <circle cx="82" cy="88" r="11" fill="var(--pine-soft)" stroke="var(--pine)" strokeWidth="2" />
        <path d="m77 88 3.6 3.8L88 84" fill="none" stroke="var(--pine)" strokeWidth="2.4"
          strokeLinecap="round" strokeLinejoin="round" />
        <g stroke="var(--marigold-hi)" strokeWidth="2.2" strokeLinecap="round">
          <path d="M143 20v7M156 33h-7M153 11l-5 5" />
        </g>
      </svg>
      <h4>{title}</h4>
      <p>{line}</p>
    </div>
  );
}

/* ================= tiny local stores (this computer only) ================= */

function makeStore<T>(name: string, fallback: T) {
  let value: T = fallback;
  try {
    const raw = localStorage.getItem(name);
    if (raw) value = { ...fallback, ...(JSON.parse(raw) as T) };
  } catch { /* unreadable storage — carry on with the defaults */ }
  const listeners = new Set<() => void>();
  return {
    get: (): T => value,
    set(next: Partial<T>): void {
      value = { ...value, ...next };
      try { localStorage.setItem(name, JSON.stringify(value)); } catch { /* ignore */ }
      for (const fn of listeners) fn();
    },
    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
  };
}

export interface Prefs {
  theme: "light" | "dark" | "system";
  defaultProvider: Provider;
  defaultModel: Record<Provider, string>;
  notify: boolean;
  quietOn: boolean;
  quietFrom: string;
  quietTo: string;
  compact: boolean;
  collapsed: Record<string, boolean>;
  /**
   * WHAT A REPLY DOES. His choice, and it changes the behaviour, not the words.
   *
   * "thread"  — a reply is kept on the message it answers. The conversation
   *             shows that message with a reply count and NOTHING else moves.
   * "inline"  — a reply is posted straight into the conversation, under a line
   *             saying which message it answers. No thread panel ever opens.
   *
   * Default "thread", because that is the Slack behaviour he is comparing this
   * against. Absent (an install from before this setting) also means "thread".
   */
  replies: "thread" | "inline";
  /**
   * ROOMS HE HAS TURNED DOWN — the same field the shared notification gate
   * reads (`NotifyPrefs.mutedChannelIds`), so muting is not a second rule kept
   * on this screen. Empty means nothing is muted, which is how every install
   * from before this setting behaves.
   */
  mutedChannelIds: string[];
  /**
   * HOW WIDE HE PULLED THE THREAD, and which way he is looking at it.
   *
   * Both live here, in the same little store as his theme, because Buzz loses
   * the width the moment you quit and that is a weakness rather than a feature.
   * Cloud9 remembers BOTH across a restart.
   *
   * `threadWidth` is HIS number, not the drawn one. A window too narrow to
   * honour it borrows a smaller number for as long as it has to and gives this
   * one straight back — only his own drag, arrow key or double-click ever
   * writes here. Absent (an install from before this) means the default.
   */
  threadWidth: number;
  threadTakeover: boolean;
}

const prefs = makeStore<Prefs>("cloud9.prefs", {
  theme: "system",
  defaultProvider: "claude",
  defaultModel: { claude: MODEL_DEFAULT.claude, codex: MODEL_DEFAULT.codex },
  notify: false,
  quietOn: false,
  quietFrom: "22:00",
  quietTo: "08:00",
  compact: false,
  collapsed: {},
  replies: "thread",
  mutedChannelIds: [],
  threadWidth: THREAD_DEFAULT,
  threadTakeover: false,
});

const usePrefs = (): Prefs => useSyncExternalStore(prefs.subscribe, prefs.get);

/* Read state used to live in `localStorage` here. It does not any more: the
   relay keeps it on the ACCOUNT, so reading a room on this computer marks it
   read on every other one too. `purgeLegacySecrets` deletes the old key. */

function applyTheme(theme: Prefs["theme"]): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}
applyTheme(prefs.get().theme);

function isDarkNow(): boolean {
  const pinned = document.documentElement.getAttribute("data-theme");
  if (pinned === "dark") return true;
  if (pinned === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/* Quiet-hours math no longer lives here: it is `inQuietHours` inside the shared
   `decideNotification` gate (packages/shared/src/notify.ts), which every toast
   now passes through. One owner for "is it quiet", read by the screen and the
   phone alike — a second copy here is exactly how the two drifted before. */

/**
 * One row per person. The relay can hand back the same person more than once
 * (his 15); the app shows each of them exactly once, everywhere.
 */
/** One shared empty list, so "this room has no messages" keeps ONE identity —
    a fresh `[]` per call would defeat every "has this changed?" check. */
const NO_MESSAGES: Message[] = [];

function onePerPerson(users: User[]): User[] {
  const byId = new Map<ID, User>();
  for (const u of users) if (!byId.has(u.id)) byId.set(u.id, u);
  const seenName = new Set<string>();
  const out: User[] = [];
  for (const u of byId.values()) {
    const key = u.name.trim().toLowerCase();
    if (seenName.has(key)) continue;
    seenName.add(key);
    out.push(u);
  }
  return out;
}

/* ---- an agent in a room is a PERSON in the room ---- */

/**
 * WHOSE AGENT THIS IS, AND THEREFORE WHO CAN READ THIS ROOM.
 *
 * An agent counts as its owner for visibility: the hub calls a room yours when
 * an agent of yours is in it. So admitting somebody's agent admits that person
 * to every word said here, including everything said before they arrived — and
 * a row that said only "🔭 Scout" hid that person completely. That is exactly
 * how a private room was widened with nothing on screen to show for it.
 *
 * One owner for these words, so the member list, the right rail, the add
 * picker and a direct conversation can never drift into saying different
 * things about the same relationship.
 */
interface AgentOwnership {
  /** the owner's name, or "You" when it is this person's own agent */
  name: string;
  mine: boolean;
  /** "Priya's agent" / "Your agent" */
  whose: string;
  /** the sentence that must never be missing: who gains sight of this place */
  reads: string;
}

function ownershipOf(
  agent: AgentDef, world: World, place: "room" | "conversation" = "room",
): AgentOwnership {
  const mine = !!world.me && agent.ownerId === world.me.id;
  /* An owner who is no longer in this Cloud9 is still named as a stranger
     rather than quietly left blank — "somebody" is a worse answer than a
     missing name, but a blank line is the worst of the three. */
  const name = mine
    ? "You"
    : world.users.find(u => u.id === agent.ownerId)?.name ?? "Someone who has left";
  return {
    name, mine,
    whose: mine ? "Your agent" : `${name}'s agent`,
    reads: `${name} can read this ${place}`,
  };
}

/**
 * The two lines every agent carries wherever it sits in a room: whose it is,
 * and what that means for who can read the place.
 */
function AgentOwnerTag({ agent, place = "room" }: {
  agent: AgentDef;
  place?: "room" | "conversation";
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const own = ownershipOf(agent, world, place);
  return (
    <span className="agentowner" data-owner={own.name} data-mine={own.mine ? "yes" : "no"}>
      <span className="whose">{own.whose}</span>
      {/* The readership line is for the answer the reader does NOT already
          have. "You can read this room" told somebody standing in the room
          nothing, and a line that says nothing beside a line that matters
          teaches people to skip both. */}
      {own.mine ? null : (
        <span className="readsroom"><span className="rm" aria-hidden="true">◉</span>{own.reads}</span>
      )}
    </span>
  );
}

/* a one-line bus so a message row can drop text into the composer */
type Inserter = (text: string) => void;
let composerInsert: Inserter | null = null;

/* ---- the hub could not open its messages ---- */

/**
 * The hub's own sentence when it cannot open the database, or nothing.
 *
 * `StoreOpenError` already writes the sentence for a person rather than for a
 * developer: it names the file, says what was wrong with it, and says that
 * nothing was changed. It is shown WORD FOR WORD. Rewording it here would be a
 * second, quieter answer to "what happened to my messages", and the two would
 * drift the first time either was edited.
 *
 * Read from wherever the shell can put it — the desktop bridge, or the address
 * the window was opened with — because the hub that failed is a different
 * process from this screen and has no socket left to say it on.
 */
function hubCannotOpen(): string | null {
  const bridged = (window as unknown as { cloud9?: { hubError?: unknown } }).cloud9?.hubError;
  const fromShell = typeof bridged === "string" ? bridged : "";
  const fromUrl = new URLSearchParams(location.search).get("hubError") ?? "";
  const said = (fromShell || fromUrl).trim();
  return said ? said : null;
}

const HUB_PROBLEM = hubCannotOpen();

/**
 * A plain screen, never a stack trace.
 *
 * There is nothing to sign into and nothing to retry from here: the file is
 * where it was and the reason is in the sentence. So this offers no button
 * that would pretend otherwise.
 */
function HubUnreadable({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="welcome hubdown">
      <div className="welcome-left">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="brand" aria-hidden="true"><CloudMark /></div>
          <span className="wordmark">Cloud9</span>
        </div>
        <h1>Cloud9 could not open your <em>messages</em>.</h1>
        {/* No mark: this whole screen is the alarm, and the check that the
            hub's own sentence arrives WORD FOR WORD reads this element. */}
        <Problem text={text} tone="notice" className="hubsay" mark={false} />
        <p className="sec-note">
          Nothing on this screen can change that file. Close Cloud9, put the file back
          where it was, or hand this sentence to whoever looks after this machine.
        </p>
      </div>
    </div>
  );
}

/* ================= app ================= */

export function App(): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [joined, setJoined] = useState(!!client.token());
  const p = usePrefs();

  useEffect(() => { applyTheme(p.theme); }, [p.theme]);

  useEffect(() => {
    if (client.token()) client.connect(client.token());
  }, []);

  useEffect(() => { if (world.authFailed) setJoined(false); }, [world.authFailed]);

  /* A LIVE SESSION IS A LIVE SESSION, however we got here. The sign-in box hands
     this flag over when the person types their way in, but a refused attempt can
     also drop back onto the credential that still worked (store.ts
     `recoverPreviousCredential`) — and without this the app would leave someone
     staring at a sign-in box while they were already back inside. */
  useEffect(() => {
    if (world.connected && world.me && !world.authFailed) setJoined(true);
  }, [world.connected, world.me?.id, world.authFailed]);

  /**
   * Ask what the Claude/Codex apps really offer as soon as we are let in.
   * Owner-only: these frames are owner-gated in the relay, so a guest asking
   * would only ever be handed an error about something they never did.
   */
  const meId = world.me?.id;
  const canAskHarness = world.connected && isOwner(world.me);
  useEffect(() => {
    if (!canAskHarness) return;
    client.send({ type: "refreshHarness" });
    client.send({ type: "harnessStatus" });
  }, [canAskHarness, meId]);

  /* Before anything else: if the hub could not read the database there is no
     world to draw, and a sign-in box would be an invitation to a door that
     cannot open. */
  if (HUB_PROBLEM) return <HubUnreadable text={HUB_PROBLEM} />;

  const onJoinScreen = !joined || world.authFailed;
  const screen = onJoinScreen
    ? <JoinScreen onJoin={() => setJoined(true)} />
    : isQuickWindow ? <QuickChat standalone />
    : <Workspace />;

  /* ONE WINDOW RAISES NOTIFICATIONS, and it is the main one. The quick-chat
     popup runs this same app, so leaving it mounted there meant two windows
     both deciding — and, now that one of the doors is Windows' own, the same
     news arriving twice. The popup is a transient box that closes the moment it
     loses focus; the main window is where his news belongs. */
  const raisesNotifications = !onJoinScreen && !isQuickWindow;
  return <>{screen}{!onJoinScreen && <Toast />}{raisesNotifications && <NotifyToasts />}</>;
}

/* ================= 1 · WELCOME / JOIN ================= */

function JoinScreen({ onJoin }: { onJoin: () => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [mode, setMode] = useState<"owner" | "invite">("owner");
  const [token, setToken] = useState("dev-owner-token");
  const [invite, setInvite] = useState("");
  const [name, setName] = useState("");
  const [trying, setTrying] = useState(false);

  /** B1 — the refusal is shown HERE, next to the box the code was typed into. */
  const refusal = plainError(world.lastError?.text);

  useEffect(() => {
    if (trying && world.connected && world.me) { setTrying(false); onJoin(); }
  }, [trying, world.connected, world.me]);
  useEffect(() => {
    if (trying && world.lastError) setTrying(false);
  }, [trying, world.lastError]);

  const go = () => {
    const t = mode === "owner" ? token : `invite:${invite.trim()}:${name.trim() || "Friend"}`;
    /* NOTHING IS WRITTEN HERE. This used to blank the stored credential first
       ("an invite issues a durable one via the relay") — so a spent, mistyped
       or expired code destroyed the sign-in the person already had, and an
       invited friend, who has no owner key, was locked out of their own Cloud9
       for good. The store adopts a credential only once the hub answers
       `welcome`; see `adoptCredential` in store.ts, the one owner. */
    setTrying(true);
    client.connect(t);
  };

  return (
    <div className="welcome join">
      <div className="welcome-left">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="brand" aria-hidden="true"><CloudMark /></div>
          <span className="wordmark">Cloud9</span>
          <span className="chip" style={{ marginLeft: 6 }}>First run</span>
        </div>

        <h1>Hire a crew.<br />Give them a <em>desk</em>.</h1>
        <p className="lede">
          Cloud9 turns the AI apps already on this machine into named experts who sit in
          your channels, take jobs, and stop to ask before they change anything.
        </p>

        <span className="eyebrow" style={{ display: "block", marginBottom: 12 }}>
          Welcome to Cloud9 · step 1 of 1 · say who you are
        </span>

        <div className="panel">
          <div className="body">
            <div className="seg" role="group" aria-label="How you are getting in">
              <button aria-pressed={mode === "owner"} onClick={() => setMode("owner")}>I run this Cloud9</button>
              <button aria-pressed={mode === "invite"} onClick={() => setMode("invite")}>I have an invite</button>
            </div>
            {mode === "owner" ? (
              <div>
                <label>Owner key <span className="hint">the one you set when Cloud9 started</span></label>
                <input type="password" value={token} onChange={e => setToken(e.target.value)} />
              </div>
            ) : (
              <>
                <div>
                  <label>Invite code</label>
                  <input type="text" value={invite} onChange={e => setInvite(e.target.value)} placeholder="inv_…" />
                </div>
                <div>
                  <label>Your name</label>
                  <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Priya" />
                </div>
              </>
            )}
            <Problem text={world.lastError?.text} tone="notice" className="joinerror" />
            {/* No "you are still signed in" line here on purpose: when a refused
                code DOES have a working credential behind it, the app is back
                inside before this screen can be read, so the sentence belongs
                where the person actually ends up — the toast. */}
            <div className="notice">Your chats stay on your crew's own machine. Nothing goes to a big platform.</div>
          </div>
          <div className="foot">
            <button className="primary" onClick={go} disabled={trying}>
              {trying ? "Letting you in…" : "Enter Cloud9"}
            </button>
          </div>
        </div>

        <div className="welcome-foot">
          <span className="eyebrow">Two ways in · owner or invited</span>
        </div>
      </div>

      <div className="welcome-right">
        <StudioScene />
      </div>
    </div>
  );
}

/* ================= the workspace shell ================= */

type ScreenName = "chat" | "crew" | "market" | "editor" | "tasks" | "files" | "projects" | "spending" | "activity" | "notifications" | "settings";
type ModalName = "invite" | "channel" | "browse" | "friends";

/** Presence line for a rail row — built only from what the app really knows. */
function agentStatusLine(a: AgentDef, status?: string): { line: string; lamp: string; busy: boolean } {
  const provider = (a.provider ?? "claude") as Provider;
  const runsOn = PROVIDER_LABEL[provider] ?? "Claude";
  const model = modelWords(a.model);
  if (a.lifecycle === "paused") return { line: "paused", lamp: "off", busy: false };
  if (a.lifecycle === "disabled") return { line: "switched off", lamp: "off", busy: false };
  if (status === "working") return { line: "working now", lamp: "run", busy: true };
  if (status === "braked") return { line: "taking a break", lamp: "off", busy: false };
  return { line: `${runsOn} · ${model}`, lamp: "live", busy: false };
}

/** The first plain sentence of what you wrote them — their job title. */
const roleOf = (persona: string): string => {
  const first = persona.trim().split(/(?<=[.!?])\s+/)[0] ?? "";
  return first.length > 90 ? `${first.slice(0, 88).trim()}…` : first || "No job written yet";
};

/**
 * Who may set this agent working, in plain words. Read off the agent, and an
 * agent that says nothing is owner-only — the same default the relay enforces.
 */
function respondWords(a: AgentDef, ownerName: string): string {
  switch (a.respondTo ?? "owner") {
    case "anyone": return "Anyone in the room can use it";
    case "allowlist": {
      const n = (a.respondToAllowlist ?? []).length;
      return n === 0
        ? `Only ${ownerName} — nobody has been named yet`
        : `${ownerName} and ${countOf(n, "other person", "others")} can use it`;
    }
    default: return `Only ${ownerName} can use it`;
  }
}

/** One owner for the person/agent on the other side of a direct conversation. */
function channelPeer(channel: Channel, world: World): { name: string; agent?: AgentDef; user?: User } {
  const id = channel.memberIds.find(memberId => memberId !== world.me?.id);
  const user = world.users.find(u => u.id === id);
  const agent = world.agents.find(a => a.id === id);
  return { name: user?.name ?? agent?.name ?? channel.name, user, agent };
}

/** Which rule made this agent stop and ask. Read off the agent, never guessed. */
function ruleWords(agent?: AgentDef): string | null {
  if (!agent?.approvals) return null;
  const hits: string[] = [];
  if (agent.approvals.background) hits.push("background jobs need your go-ahead");
  if (agent.approvals.schedules) hits.push("new schedules need your go-ahead");
  if (hits.length === 0) return null;
  return hits.join(" · ");
}

function Workspace(): React.JSX.Element {
  countRender("Workspace");
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const p = usePrefs();
  const [screen, setScreen] = useState<ScreenName>("chat");
  const [activeId, setActiveId] = useState<ID | null>(null);
  const [modal, setModal] = useState<null | ModalName>(null);
  /** null = not editing. "new" = hiring. An agent = editing that one. */
  const [editorFor, setEditorFor] = useState<AgentDef | "new" | null>(null);
  /** the @name of the role just hired from the casting room, so the crew says so */
  const [justHired, setJustHired] = useState<string | null>(null);
  /**
   * A hire we have asked the hub for and are waiting to see come back.
   *
   * WHY IT IS WORTH A PIECE OF STATE. Hiring used to drop him on the crew screen
   * with a note telling him to press Edit, and he never did — so he decided a
   * hired role had no tool permissions, no files switch and no skills, when in
   * truth all three were one click away and he had no reason to look. A role he
   * has just taken on goes STRAIGHT to its own file, open, with everything a
   * hand-written agent has on the same screen.
   */
  const [awaitingHire, setAwaitingHire] = useState<string | null>(null);
  const [quick, setQuick] = useState(false);
  const [pendingPeer, setPendingPeer] = useState<{ id: ID; since: number } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  /** a message the app is on its way to, from a search result */
  const [jumpTo, setJumpTo] = useState<{ id: ID; at: number } | null>(null);
  /** a thread a search result wants unrolled once the room is on screen */
  const [openThreadFor, setOpenThreadFor] = useState<{ id: ID; at: number } | null>(null);
  /** a file — and, for an old-version hit, the exact version — Files must open */
  const [fileOpenAt, setFileOpenAt] =
    useState<{ artifactId: ID; version?: number; at: number } | null>(null);
  /* ...and the one owner that puts it back down again. A request like this is
     an ERRAND, not a setting: `jumpTo` and `openThreadFor` are both handed back
     the moment the screen has done as it was asked, and this is the same. Left
     standing, it made every later visit to Files re-open the last search hit —
     the newest-first list the screen is for became unreachable. */
  const clearFileOpen = useCallback(() => setFileOpenAt(null), []);

  const active = world.channels.find(c => c.id === activeId) ?? world.channels[0];
  const owner = isOwner(world.me);
  const openInvite = useCallback(() => {
    client.send({ type: "createInvite" });
    setModal("invite");
  }, []);

  /* ---- ONE DOOR OUT OF SEARCH ----
   *
   * Closing the panel and following a result are the same act as far as the two
   * searches behind it are concerned: both are called off, so neither can be
   * revived by an answer still on its way (see `clearSearch`/`clearEverywhere`).
   * Every exit below goes through this, which is why there is nowhere left for
   * one of the two to be forgotten. */
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    client.clearSearch();
    client.clearEverywhere();
  }, []);

  /**
   * FOLLOW ONE "SEARCH EVERYWHERE" RESULT TO THE THING ITSELF.
   *
   * Each kind has one owner already and this calls it — the room jump the room
   * search uses (`jumpTo`), the thread the reply lives in, and the Files
   * workspace with the exact artifact (and, for an old-version hit, the exact
   * version) chosen. Nothing here draws anything; it only points the screens
   * that already know how.
   */
  const openEverywhereHit = useCallback((hit: EverywhereHit) => {
    const now = Date.now();
    if ((hit.kind === "message" || hit.kind === "reply") && hit.messageId) {
      setScreen("chat");
      setActiveId(hit.channelId);
      setJumpTo({ id: hit.messageId, at: now });
      /* A reply is only readable in its thread, so the thread its parent
         started is opened too. The parent is the hub's answer, never guessed
         from the reply — see `EverywhereHit.threadParentId`. */
      if (hit.kind === "reply" && hit.threadParentId) {
        setOpenThreadFor({ id: hit.threadParentId, at: now });
      }
      closeSearch();
      return;
    }
    if (hit.artifactId) {
      setFileOpenAt({
        artifactId: hit.artifactId,
        ...(hit.kind === "fileVersion" && hit.versionNumber !== undefined
          ? { version: hit.versionNumber } : {}),
        at: now,
      });
      setScreen("files");
      closeSearch();
    }
  }, [closeSearch]);
  // One owner for "how many are waiting" — see `useMyApprovals`. A request past
  // its deadline is not waiting on him, whatever the database still says.
  const pendingApprovals = useMyApprovals(world.approvals, world.me?.id).waiting.length;

  /* HOW MANY OF HIS OWN AGENTS ARE WORKING THIS SECOND — the number on the
     Activity button, taken from THE SAME LINES THE BOARD DRAWS.
     This used to count `agentStatus === "working"` on its own, which is a
     different question from the one the board answers: the engine keeps that
     lamp lit while an agent stands waiting for a go-ahead, so the button said
     "1" and the board said "Nothing is being worked on" — both visible at once,
     one of them lying. `workingCount` is now the only answer either can give. */
  const workingNow = workingCount(useAgentActivity().map(r => r.line));
  const unreadNotifications = world.notifications.filter(n => n.state === "unread").length;

  /* ---- EVERY WAY OUT OF A SCREEN GOES THROUGH ONE DOOR ----
   *
   * `go` is that door. Changing the screen and changing which conversation is
   * open both throw away whatever an editor-like surface is holding, so both
   * are routed through the one owner of "may this be left" — see
   * `attemptLeave`. Nothing below calls `setScreen` or `setActiveId` directly;
   * that is the whole rule, and it is why the rail cannot forget it the way it
   * did before.
   */
  const leaveThen = useCallback((then: () => void) => attemptLeave(then), []);
  const goScreen = useCallback((s: ScreenName) => attemptLeave(() => setScreen(s)), []);
  const goChannel = useCallback((id: ID) => attemptLeave(() => {
    setActiveId(id);
    setScreen("chat");
  }), []);

  const openEditor = useCallback((a: AgentDef | "new") => {
    attemptLeave(() => {
      setEditorFor(a);
      setScreen("editor");
    });
  }, []);
  /* The agent only exists once the hub says so, so this waits for it to arrive
     rather than guessing an id. If it never arrives, nothing happens and the
     crew screen is still there — a hire is not lost by this. */
  useEffect(() => {
    if (!awaitingHire) return;
    const made = world.agents.find(
      a => a.name === awaitingHire && a.ownerId === world.me?.id);
    if (!made) return;
    setAwaitingHire(null);
    setEditorFor(made);
    setScreen("editor");
  }, [awaitingHire, world.agents, world.me?.id]);

  const openActivity = useCallback(() => {
    attemptLeave(() => {
      client.send({ type: "activity", limit: 100 });
      setScreen("activity");
    });
  }, []);

  const openNotifications = useCallback(() => {
    attemptLeave(() => {
      setScreen("notifications");
    });
  }, []);

  const openInboxEntry = useCallback((entry: NotificationInboxEntry) => {
    // Deleted/inaccessible sources are intentionally not navigable. Their
    // explicit Mark read action remains available, but clicking the disabled
    // source control must not mutate read state.
    if (entry.sourceState !== "active" || !entry.channelId || !entry.messageId) return;
    // A source jump is one atomic exit from the inbox. If an editor blocks the
    // leave, neither the room, jump cursor, nor read state changes underneath it.
    attemptLeave(() => {
      client.markNotificationRead(entry.id);
      setActiveId(entry.channelId!);
      setScreen("chat");
      setJumpTo({ id: entry.messageId!, at: Date.now() });
      if (entry.rootId) setOpenThreadFor({ id: entry.rootId, at: Date.now() });
    });
  }, []);

  /* ASKED ON THE WAY IN, the same way the Log and Projects are — and here the
     reason is the sharpest of the three: this is a running total, not a record.
     It moves with every turn any agent takes, so a figure held over from the
     last visit is out of date the moment anything happens, and a spending
     number that is quietly an hour old is the one kind of stale figure that
     could cost him money. `askSpending` skips only a request already in flight. */
  const openSpending = useCallback(() => {
    attemptLeave(() => {
      client.askSpending();
      setScreen("spending");
    });
  }, []);

  /* Asked on the way in, the same way the Log is: a project gains a default
     branch, a "last looked at" and sometimes a problem the moment the engine
     talks to GitHub, so a list held over from the last visit would be showing
     yesterday's answer to today's question. */
  const openProjects = useCallback(() => {
    attemptLeave(() => {
      client.askProjects();
      setScreen("projects");
    });
  }, []);

  /* ---- keyboard ---- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setQuick(q => !q);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        /* Through the one door as well: Ctrl+F is a way to the chat screen, and
           a way to a screen is a way OFF the one he is on. */
        attemptLeave(() => { setScreen("chat"); setFindOpen(true); });
      }
      /* Escape is NOT handled here. `useEscapeCloses` owns it for every overlay,
         including this palette — one handler per overlay is exactly how the
         palette and the casting-room brief got out of step. */
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* ---- clicking a Windows notification lands on the thing it is about ----
   *
   * WHERE it lands is `notifyTarget`'s rule (packages/shared/src/notify.ts); HOW
   * it gets there is the navigation owners this screen already has — the very
   * ones a "search everywhere" result uses (`goChannel` + `jumpTo`, `goScreen`).
   * Nothing new navigates; a notification is just another way to ask.
   */
  const openNotification = useCallback((note: {
    kind?: string | null; channelId?: string | null; subjectId?: string | null;
  }) => {
    const kind = typeof note?.kind === "string" && isNotifyKind(note.kind) ? note.kind : null;
    if (!kind) return;
    const target: NotifyTarget | null = notifyTarget({
      kind,
      channelId: note.channelId ?? undefined,
      subjectId: note.subjectId ?? "",
    });
    if (!target) return;
    if (target.go === "tasks") { goScreen("tasks"); return; }
    if (target.go === "room") {
      /* An artifact notification names the room where its card is visible.
         Keep the whole destination behind the same leave guard as message
         jumps: a dirty editor must not be left half-navigated. */
      attemptLeave(() => {
        setActiveId(target.channelId);
        setScreen("chat");
      });
      return;
    }
    if (target.go === "message") {
      /* A REPLY IS ONLY HALF A PLACE. `notifyTarget` points at the message,
         because a message id is all a notification carries. A reply's real home
         is the thread it is in, and this screen already has ONE owner for
         unrolling that — the same errand a search result on a reply uses. So
         the thread is asked for too, from the reply's own `replyTo`. With
         threads turned off there is no panel to open and the jump alone is the
         whole answer; `openThreadFor` already knows that. */
      const reply = (world.messages[target.channelId] ?? []).find(m => m.id === target.messageId);
      attemptLeave(() => {
        setActiveId(target.channelId);
        setScreen("chat");
        setJumpTo({ id: target.messageId, at: Date.now() });
        if (reply?.replyTo) setOpenThreadFor({ id: reply.replyTo, at: Date.now() });
      });
    }
  }, [goScreen, world.messages]);

  useEffect(() => {
    const bridge = desktop();
    const off = bridge?.onNotificationClick?.(openNotification);
    /* QA hook, same shape as `cloud9Menu`: the suite follows a notification the
       way Windows does, through the app's own handler, so a click that lands
       nowhere fails a check instead of being noticed months later. */
    (window as unknown as { cloud9NotifyOpen?: unknown }).cloud9NotifyOpen = openNotification;
    return () => {
      if (typeof off === "function") off();
      delete (window as unknown as { cloud9NotifyOpen?: unknown }).cloud9NotifyOpen;
    };
  }, [openNotification]);

  /* ---- the app menu ----
   * Typed `Record<MenuAction, …>` against the ONE list in @cloud9/shared that
   * the Electron shell builds its menu from: add an item there without handling
   * it here and this file stops compiling. */
  const menuHandlers = useMemo<Record<MenuAction, () => void>>(() => ({
    "new-agent": () => openEditor("new"),
    "new-channel": () => setModal("channel"),
    // The shell's menu is the same for everyone, so a guest CAN reach this.
    // The relay's own wording is reused so the menu and a refused button say
    // the identical sentence.
    "invite": () => owner
      ? openInvite()
      : client.notify("only the owner of this Cloud9 can invite someone"),
    "settings": () => goScreen("settings"),
    // Search looks EVERYWHERE you are allowed to see. Finding words in the one
    // conversation on screen is a different job and keeps its own bar (Ctrl+F).
    "search": () => leaveThen(() => { setScreen("chat"); setSearchOpen(true); }),
    "toggle-theme": () => {
      const now = document.documentElement.getAttribute("data-theme");
      prefs.set({ theme: now === "dark" ? "light" : "dark" });
    },
    "activity": openActivity,
    "tasks": () => goScreen("tasks"),
    "quick-chat": () => setQuick(true),
  }), [owner, openInvite, openActivity, openEditor, leaveThen, goScreen]);

  const menuRef = useRef(menuHandlers);
  menuRef.current = menuHandlers;

  useEffect(() => {
    const run = (action: string) => {
      const handler = (menuRef.current as Record<string, (() => void) | undefined>)[action];
      if (handler) handler();
      else console.warn(`[cloud9] the shell asked for a menu action this app does not know: ${action}`);
    };
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ action?: string } | string>).detail;
      run(typeof detail === "string" ? detail : detail?.action ?? "");
    };
    window.addEventListener("cloud9:menu", onEvent as EventListener);
    const bridge = desktop() as (DesktopBridge & { onMenu?: (fn: (a: string) => void) => (() => void) | void }) | undefined;
    const offMenu = bridge?.onMenu?.(run);
    // QA hook: the browser suite drives every action on the SHARED list through
    // the same path the Electron menu uses, so a dead item fails a test.
    (window as unknown as { cloud9Menu?: unknown }).cloud9Menu = { actions: MENU_ACTIONS, run };
    // QA hook, the same shape and for the same reason as the one above: the
    // suite mints a ticket through the app's OWN path and fetches the file back
    // over real HTTP, so "the bytes came back unchanged" is something proved
    // rather than inferred from a link being on screen.
    (window as unknown as { cloud9Files?: unknown }).cloud9Files = {
      ticket: (attachmentId: ID) => client.ticketFor(attachmentId),
      opened: () => client.openFileIds(),
      /* How many places on screen are showing one file. The whole point of
         counting holders is that the LAST one frees the bytes, and a count is
         the only way a test can prove that rather than infer it. */
      holders: (attachmentId: ID) => client.holdersOf(attachmentId),
      /* What is still on its way up in one conversation, and what the app would
         do if Enter were pressed right now — so "a file is never dropped in
         silence" is checked at the decision, not guessed at from the screen. */
      inFlight: (channelId: ID) => client.uploadsInFlight(channelId),
      queued: () => client.queuedUploads(),
      wouldSend: (channelId: ID, hasWords: boolean) => client.readyToSend(channelId, hasWords),
    };
    /* QA hook: the wire itself. Two findings can only be PROVED by reproducing
       them — a refusal that belonged to something else reaching an upload, and
       an answer to a search that was already called off. Neither is visible on
       screen at the moment it matters, so the suite needs to see what is
       outstanding and what has come back. `ask`, `search` and `clearSearch` are
       the app's own methods, unwrapped: the composer, the room panel and the
       search overlay call exactly these. Nothing here is a stand-in. */
    (window as unknown as { cloud9Wire?: unknown }).cloud9Wire = {
      outstanding: () => client.outstanding(),
      questions: () => client.outstandingQuestions(),
      seen: () => client.framesSeen(),
      /* Returns the exact id assigned at the real send boundary, including for a
         fire-and-forget frame that deliberately creates no ledger row. */
      ask: (frame: Parameters<typeof client.send>[0]) => client.send(frame),
      lastError: () => client.world.lastError ? { ...client.world.lastError } : null,
      /* Deterministic request-ledger seam. It feeds a typed hub frame through the
         same dispatcher as the live socket, so QA can interleave an older pending
         lifecycle, a refused later fire-and-forget send and exact replies. */
      receive: (frame: ServerFrame) => client.receiveForQa(frame),
      /* The app's own "say this went wrong" door — the very method a refused
         button calls. The hub's catch-all is another agent's to fix; this is how
         a check proves the SCREEN is safe whether or not it was, by handing the
         screen the exact wrapper text a raw failure arrives in. */
      notify: (text: string) => client.notify(text),
      /* IS THE ENGINE CHECKING WHAT ITS AGENTS SAY? (`verify.ts`.)
         Null when this engine has never said either way — an older host, or a
         screen that has not had a harness update yet. It matters that this is
         askable at all: the check is SILENT when a turn's claims all hold, so
         "no complaint in the room" means either "checked and true" or "nothing
         is checking", and only this can tell the two apart. It reads the engine's
         own published fact, never a guess from the screen. */
      verifyClaims: () => client.world.harness?.verifyClaims ?? null,
      search: (q: string) => client.search(q),
      clearSearch: () => client.clearSearch(),
      searching: () => client.world.search ?? null,
      /* The same seam for "search everywhere": the overlay's own methods,
         unwrapped, so a check can prove that a search called off cannot be
         brought back by its own late answer. */
      everywhere: () => client.world.everywhere ?? null,
      clearEverywhere: () => client.clearEverywhere(),
      /* The conversations this screen knows, by name. The suite needs an id to
         seed a conversation long enough to prove the scroll rules against; the
         alternative was typing a hundred and sixty messages one key at a time. */
      channels: () => client.world.channels.map(c => ({ id: c.id, name: c.name })),
      /* The agents this screen knows, by name. A file an agent made can only be
         published BY an agent, so a suite that proves the store end to end has
         to be able to name one — the same way it names a conversation. */
      agents: () => client.world.agents.map(a => ({ id: a.id, name: a.name, ownerId: a.ownerId })),
      /** who this window is signed in as — so "his own agent" is a fact, not a guess */
      me: () => client.world.me?.id ?? null,
      /* The very function the unread badge calls. A conversation with more
         than a thousand unread messages cannot be built in a QA run, so the
         RULE is checked here and the badge is checked on screen; between them
         nothing prints a capped number as though it were exact. */
      unreadSays: (n: number) => unreadLabel(n),
      unreadCeiling: () => UNREAD_CEILING,
    };
    /* QA hook: HOW MANY OVERLAYS ARE ON THE ONE ESCAPE OWNER'S STACK. Pressing
       Escape proves the behaviour, and this proves the MECHANISM — that an
       overlay on screen really did register with the one owner rather than
       answering the key its own way. A per-overlay handler is what got the
       palette and the brief out of step, so the suite checks the stack itself. */
    (window as unknown as { cloud9Escape?: unknown }).cloud9Escape = {
      stacked: () => escapeStack.length,
    };
    /* QA hook: A FILE AN AGENT MADE, through the app's own path. `ticket` is the
       very method the card's buttons call, so the suite can fetch the bytes back
       over real HTTP and compare them with what was published — a card on screen
       is not evidence that a file came back. `held` reports what the world is
       holding, so "the card is missing" can be told apart from "the frame never
       arrived". */
    (window as unknown as { cloud9Artifacts?: unknown }).cloud9Artifacts = {
      ticket: (artifactId: ID, version?: number) => client.artifactTicketFor(artifactId, version),
      held: () => Object.values(client.world.artifacts).map(a => ({
        id: a.id, name: a.name, channelId: a.channelId,
        versions: a.versions.map(v => ({ version: v.version, agent: v.agentName, size: v.size, text: v.text })),
      })),
      inRoom: (channelId: ID) => client.artifactsIn(channelId).list.map(a => a.id),
      workspace: () => ({
        asked: client.artifactWorkspace().asked,
        loading: client.artifactWorkspace().loading,
        hasMore: client.artifactWorkspace().hasMore,
        capacity: client.artifactWorkspace().capacity,
        problem: client.artifactWorkspace().problem ?? null,
        ids: client.artifactWorkspace().entries.map(a => a.artifactId),
      }),
      detail: (artifactId: ID) => client.artifact(artifactId) ?? null,
      relations: (artifactId: ID) => client.relationsFor(artifactId),
      relationsTruncated: (artifactId: ID) => client.relationsTruncated(artifactId),
      detailProblem: (artifactId: ID) => client.artifactDetailProblem(artifactId) ?? null,
      setAccess: (artifactId: ID, access: ArtifactAccess) => client.setArtifactAccess(artifactId, access),
      accessSave: () => client.artifactAccessSaveState() ?? null,
    };
    /* QA hook: THE UNSAVED-WORK OWNER ITSELF. Pressing a rail icon proves the
       behaviour; this proves the MECHANISM — that the surface he is typing into
       really registered with the one owner, and that the question on screen is
       that owner's and not a dialog somebody bolted onto one screen. */
    (window as unknown as { cloud9Leave?: unknown }).cloud9Leave = {
      unsaved: () => unsavedNow(),
      guards: () => unsavedGuards.length,
      asking: () => leaveSnapshot()?.what ?? null,
    };
    /* QA hook: WHAT A FAILURE WOULD SAY, and how many places are saying it. The
       duplicate the audit photographed is only visible as a COUNT — two surfaces
       drawing one sentence — so the suite asks the owner, and checks the screen. */
    (window as unknown as { cloud9Say?: unknown }).cloud9Say = {
      says: (raw: string) => sayable(raw) ?? null,
      showing: (text: string) => saidCount(text),
    };
    /* QA hook: ASK THE FOLLOW RULE WHAT IT DID, rather than measure pixels and
       hope. A smooth scroll takes several frames and a picture can finish
       loading in the middle of one, so a reading of `scrollTop` alone cannot say
       whether the rule fired, how often, or for which of the four reasons. The
       reasons are the rule's own words, so a check can name the case it is
       holding — "he sent it" is a different claim from "it arrived". */
    (window as unknown as { cloud9View?: unknown }).cloud9View = {
      followed: () => ({ ...followed }),
      /* Whether this machine has asked for no movement, answered by the one
         function every moving view in the app asks. */
      motion: () => scrollBehavior(),
      /* WHAT THE PILL IS SAYING, from the rule rather than from the pixels: a
         check can hold "he was not yanked, he was TOLD" to a number, and tell a
         pill that is absent apart from a pill that is present saying nothing. */
      newBelow: () => newBelowNow,
    };
    // QA hook, same shape again: what the screen is HOLDING about runs, so a
    // missing card can be told apart from a record that never arrived. It
    // reports only ids and outcomes — never the record's words.
    (window as unknown as { cloud9Runs?: unknown }).cloud9Runs = {
      held: () => Object.entries(client.world.runs)
        .map(([id, r]) => ({ id, outcome: r.outcome, taskId: r.taskId ?? null, steps: r.steps.length })),
      jobs: () => client.world.tasks
        .map(t => ({ id: t.id, status: t.status, runId: t.runId ?? null })),
      /* THE HISTORY ENTRIES EXACTLY AS THE HUB SENT THEM, so a test can be
         built from real records instead of hand-written ones. A fixture written
         by the same person as the code agrees with the code by construction —
         which is how a row that timed a job from its START instead of its END
         passed every test it had. A real entry has no field to put that mistake
         in. Ids and words are the owner's own and stay on his machine; this
         hook only makes them readable to a harness he is running himself. */
      history: () => Object.values(client.world.runLists)
        .flatMap(l => l.entries),
    };
    return () => {
      delete (window as unknown as { cloud9Wire?: unknown }).cloud9Wire;
      delete (window as unknown as { cloud9Runs?: unknown }).cloud9Runs;
      delete (window as unknown as { cloud9View?: unknown }).cloud9View;
      delete (window as unknown as { cloud9Say?: unknown }).cloud9Say;
      delete (window as unknown as { cloud9Leave?: unknown }).cloud9Leave;
      delete (window as unknown as { cloud9Artifacts?: unknown }).cloud9Artifacts;
      delete (window as unknown as { cloud9Escape?: unknown }).cloud9Escape;
      delete (window as unknown as { cloud9Files?: unknown }).cloud9Files;
      delete (window as unknown as { cloud9Menu?: unknown }).cloud9Menu;
      window.removeEventListener("cloud9:menu", onEvent as EventListener);
      if (typeof offMenu === "function") offMenu();
    };
  }, []);

  /* ---- one person per row, however many times the relay lists them ---- */
  const people = useMemo(() => {
    return onePerPerson(world.users).sort((a, b) =>
      a.id === world.me?.id ? -1 : b.id === world.me?.id ? 1 : a.name.localeCompare(b.name));
  }, [world.users, world.me]);

  /* ---- clicking a person or an agent always lands in a real conversation ---- */
  const findDm = useCallback((peerId: ID): Channel | undefined => {
    const mine = world.me?.id;
    const has = (c: Channel) => c.memberIds.includes(peerId);
    return world.channels.find(c => c.kind === "dm" && has(c) && (!mine || c.memberIds.includes(mine)))
      ?? world.channels.find(c => c.kind === "dm" && has(c))
      // An older install can hold a two-person room that was never tagged "dm".
      // It must still be recognised by its NAME ("dm:<a>:<b>"), never by member
      // count alone — a named channel is also two people the moment a second
      // person joins.
      ?? world.channels.find(c =>
        c.name.startsWith("dm:") && has(c) && (!mine || c.memberIds.includes(mine)));
  }, [world.channels, world.me]);

  const openDm = useCallback((peerId: ID, peerName: string) => {
    if (!world.me || peerId === world.me.id) return;
    attemptLeave(() => {
      setScreen("chat");
      const existing = findDm(peerId);
      if (existing) { setActiveId(existing.id); setPendingPeer(null); return; }
      setPendingPeer({ id: peerId, since: Date.now() });
      client.send({ type: "createChannel", name: `dm-${slug(peerName)}`, memberIds: [peerId], kind: "dm" });
    });
  }, [world.me, findDm]);

  // the relay answers a beat later — open exactly what it hands back
  useEffect(() => {
    if (!pendingPeer) return;
    const made = findDm(pendingPeer.id);
    if (made) { setActiveId(made.id); setPendingPeer(null); return; }
    const handed = world.lastChannel;
    if (handed && handed.ts >= pendingPeer.since) {
      const c = world.channels.find(ch => ch.id === handed.id);
      if (c && c.memberIds.includes(pendingPeer.id)) { setActiveId(c.id); setPendingPeer(null); return; }
    }
    const giveUp = setTimeout(() => setPendingPeer(null), 15000);
    return () => clearTimeout(giveUp);
  }, [pendingPeer, findDm, world.lastChannel, world.channels]);

  /* ---- unread, from the account ----
   *
   * The relay owns "up to when has this person read" (`lastReadTs`) and counts
   * what is after it. This computes the same count from the messages on hand,
   * and takes whichever is BIGGER: the relay's number covers messages this
   * client never loaded, and the local one covers messages that arrived since
   * the relay last counted. Neither alone is right on its own. */
  /**
   * ONE ROOM'S COUNT, WORKED OUT ONCE PER ROOM.
   *
   * This walks a room's whole message list, and the sidebar calls it for every
   * channel, every agent and every direct conversation on EVERY redraw — so a
   * presence tick used to re-scan every room in the Cloud9. The answer can only
   * change when one of five things changes (that room's messages, its read
   * marker, who I am, my agents, or the replies setting), so the answer is kept
   * per room against exactly those five and re-worked only when one moves.
   *
   * The cache lives in a ref rather than in the memo, deliberately: `messages`
   * is a new object whenever ANY room gets a message, so a memo keyed on it
   * would throw away all the other rooms' answers for a message in one of them.
   */
  const unreadCache = useRef(new Map<ID, {
    msgs: unknown; entry: unknown; me: unknown; agents: unknown; replies: string; value: Unread;
  }>());
  const unreadFor = useCallback((c: Channel): Unread => {
    const entry = world.unread[c.id];
    const seen = entry?.lastReadTs ?? 0;
    const msgs = world.messages[c.id] ?? NO_MESSAGES;
    const held = unreadCache.current.get(c.id);
    if (held && Object.is(held.msgs, msgs) && Object.is(held.entry, entry)
      && Object.is(held.me, world.me) && Object.is(held.agents, world.agents)
      && held.replies === p.replies) {
      return held.value;
    }
    const mine = world.me?.id;
    const myAgentIds = world.agents.filter(a => a.ownerId === mine).map(a => a.id);
    const fresh = msgs.filter(m => m.ts > seen && m.authorId !== mine);
    const mentionsMe = (m: Message) =>
      (m.mentions ?? []).some(id => id === mine || myAgentIds.includes(id));
    const unread = Math.max(fresh.length, entry?.unread ?? 0);

    /* ---- WHAT'S NEW IS INSIDE A THREAD ----
     *
     * The complaint: with replies kept in threads, "1 new" sends him into a
     * room whose scroll shows nothing new — the reply is off-scroll, hanging on
     * the message it answers — and he has to hunt for it.
     *
     * A reply is a message with `replyTo`, and this client already holds both
     * the messages and the read marker, so the room row can say WHERE the new
     * thing is without the hub learning a new field.
     *
     * Two honesty guards, because a half-truth on a badge is worse than silence:
     *  - only when his setting actually hides replies from the scroll
     *    ("keep it in the conversation" hides nothing, so there is nothing to
     *    explain);
     *  - only when the messages on hand ACCOUNT for the whole count. The hub's
     *    number covers messages this client never loaded, and we cannot know
     *    what those are. When it is bigger, this says nothing rather than
     *    claiming the new thing is in a thread on a guess. */
    const threading = p.replies !== "inline";
    const accounted = threading && fresh.length >= (entry?.unread ?? 0);
    const inThreads = accounted ? fresh.filter(m => !!m.replyTo).length : 0;
    const value: Unread = {
      unread,
      mentions: Math.max(fresh.filter(mentionsMe).length, entry?.mentions ?? 0),
      inThreads,
      /* "everything new here is in a thread" — the case that used to send him
         hunting, and the only one worth changing the row's words for. */
      onlyThreads: accounted && inThreads > 0 && inThreads === fresh.length,
    };
    unreadCache.current.set(c.id, {
      msgs, entry, me: world.me, agents: world.agents, replies: p.replies, value,
    });
    return value;
  }, [world.unread, world.messages, world.me, world.agents, p.replies]);

  /* Reading a conversation marks it read — on the account, so the phone finds
     out too. Debounced, because a burst of arriving messages is one read. */
  const newestTs = active
    ? (world.messages[active.id] ?? []).reduce((n, m) => Math.max(n, m.ts), 0)
    : 0;
  useEffect(() => {
    if (!active || screen !== "chat" || !world.connected) return;
    const seen = world.unread[active.id]?.lastReadTs ?? 0;
    const upTo = newestTs || Date.now();
    if (seen >= upTo) return;
    const t = setTimeout(() => client.markRead(active.id, upTo), 350);
    return () => clearTimeout(t);
  }, [active?.id, newestTs, screen, world.connected, world.unread]);

  /* Coming back to the window is also "I have read this". */
  useEffect(() => {
    const onFocus = () => {
      if (!active || screen !== "chat") return;
      client.markRead(active.id);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active?.id, screen]);

  /* Opening a conversation asks the relay for its newest page, which is the
     only way to learn whether there is anything OLDER — `welcome` hands over
     recent messages without ever saying. */
  useEffect(() => {
    if (!active || !world.connected) return;
    if (!client.page(active.id).asked) client.loadOlder(active.id);
  }, [active?.id, world.connected]);

  /* ---- notifications ---- The five events that interrupt him are drawn by
     `<NotifyToasts />` (mounted once at the top of the app), each fed through
     the one `decideNotification` gate. The old effect here fired a raw
     `new Notification(...)` for EVERY new message — a second, half-right rules
     path that knew nothing of the four kinds, of self-suppression, or of
     de-dupe. It has been removed in favour of the shared gate. An OS/tray toast
     is a later, honest add-on on top of the same decision; tonight the
     deliverable is the in-app toast. */

  const channels = world.channels.filter(c => c.kind === "channel");
  const agents = world.agents as AgentDefPlus[];
  /* Direct conversations with PEOPLE only: every agent already has its own row
     below, so listing its DM too would show the same agent twice — and the
     count of rows named after it would change every time one was opened. */
  const humanDms = world.channels.filter(c =>
    c.kind === "dm" && !c.memberIds.some(id => world.agents.some(a => a.id === id)));

  const peerOf = (c: Channel) => {
    const { name, agent } = channelPeer(c, world);
    const status = agent ? agentStatusLine(agent, world.agentStatus[agent.id]) : null;
    return {
      name,
      agent,
      isAgent: !!agent,
      sub: status ? status.line : "just the two of you",
      lamp: status ? status.lamp : "idle",
      busy: status?.busy ?? false,
    };
  };

  const railBtn = (
    go: ScreenName, label: string, icon: React.ReactNode, badge?: number, onClick?: () => void,
  ) => (
    <button className={`rail-btn${badge ? " rail-badge" : ""}`} data-go={go}
      aria-current={screen === go ? "true" : "false"} title={label}
      onClick={onClick ?? (() => goScreen(go))}>
      {icon}{label}
      {badge ? <b className="rail-count">{badge}</b> : null}
    </button>
  );

  return (
    <div className="shell">
      {/* Demo answers are made up. If the engine is handing them out, the app
          says so across the top — a canned reply must never pass for a real
          one just because nobody looked at the launcher. */}
      {world.harness?.demo && (
        <div className="demobanner" role="status">{DEMO_MODE_BANNER}</div>
      )}

      <div className="app" data-compact={p.compact ? "on" : "off"}>
        <nav className="rail" aria-label="Cloud9 sections">
          <div className="brand" title="Cloud9" aria-hidden="true"><CloudMark /></div>
          {railBtn("chat", "Chat", <IconChat />)}
          {railBtn("crew", "Crew", <IconCrew />)}
          {railBtn("tasks", "Tasks", <IconTasks />, pendingApprovals)}
          {railBtn("files", "Files", <IconFiles />)}
          {/* ADDED beside the four he approved — the Studio navigation is
              otherwise unchanged. Everything the hub and the engine already
              hold about his repositories arrives through this one door. */}
          {railBtn("projects", "Projects", <IconProjects />, undefined, openProjects)}
          {/* ADDED 2026-08-07. It sits beside the Activity button because it
              answers the same shape of question — "what has been going on?" —
              about money rather than about actions. */}
          {railBtn("spending", "Spending", <IconSpending />, undefined, openSpending)}
          {/* CALLED WHAT IT IS. The button said "Log" while the screen behind
              it said "Activity", so the one place that answers "what are my
              agents doing" was named after the driest thing on it. The count is
              how many are working this second, and it is the only reason he
              needs to look — a rail that stays quiet while an agent works is
              the version of this feature that does not get used. */}
          {railBtn("activity", "Activity", <IconLog />, workingNow, openActivity)}
          {railBtn("notifications", "Notifications", <IconBell />, unreadNotifications, openNotifications)}
          <div className="rail-spacer" />
          <button className="rail-btn" title="Quick chat (Ctrl K)" onClick={() => setQuick(true)}>
            <IconBolt />Ctrl K
          </button>
          {railBtn("settings", "Settings", <IconGear />)}
          {/* Which Cloud9 am I on, and a door to join a friend's. The active
              hub's name rides on the button so it is glanceable, and the
              connection sentence is its tooltip — both from `hubConn`, never a
              hopeful label. */}
          <button className="rail-btn hubswitch" title={world.hubConn.line || "Connect to a friend's Cloud9"}
            onClick={() => setModal("friends")}>
            <CloudMark />{activeHubName(world)}
          </button>
          <span className={`rail-lamp ${world.connected ? "ok" : ""}`}
            title={world.connected ? `On the floor as ${world.me?.name ?? "you"}` : "Reconnecting…"} />
        </nav>

        <main className="stage">
          {/* THE ONE THING THE HUB CHANGED WITHOUT ASKING, said where he cannot
              walk past it. Not on the crew screen only: he would have had to go
              and find it, which is the whole complaint this answers. It draws
              nothing at all unless a catch-up really happened and he has not
              said "Got it" to it. */}
          <CaughtThemUp />
          {screen === "chat" && (
            <ChatScreen
              active={active} setActiveId={id => goChannel(id)}
              channels={channels} humanDms={humanDms} agents={agents} people={people}
              unreadFor={unreadFor} peerOf={peerOf} owner={owner}
              onNewChannel={() => setModal("channel")} onBrowseRooms={() => setModal("browse")}
              onNewAgent={() => openEditor("new")} onBrowseMarket={() => goScreen("market")}
              onInvite={openInvite} onEditAgent={a => openEditor(a)} onOpenDm={openDm}
              lastRead={active ? world.unread[active.id]?.lastReadTs ?? 0 : 0}
              findOpen={findOpen} onCloseFind={() => setFindOpen(false)}
              onOpenTasks={() => goScreen("tasks")}
              jumpTo={jumpTo} onJumped={() => setJumpTo(null)}
              openThreadFor={openThreadFor} onThreadOpened={() => setOpenThreadFor(null)}
            />
          )}
          {screen === "crew" && (
            <CrewScreen onHire={() => openEditor("new")} onEdit={a => openEditor(a)} onOpen={openDm}
              onMarket={() => goScreen("market")} justHired={justHired} />
          )}
          {screen === "market" && (
            <MarketScreen
              onBack={() => goScreen("crew")}
              onWriteMyOwn={() => openEditor("new")}
              /* Hiring lands him IN the new agent's own file — the same editor,
                 with the same reach ladder, files switch, skills and approval
                 rules a hand-written agent has. Nothing about it is locked, and
                 nothing about it is a click away. */
              onHired={name => { setJustHired(name); setAwaitingHire(name); setScreen("crew"); }}
            />
          )}
          {screen === "editor" && (
            <AgentEditor
              justHired={justHired}
              agent={editorFor === "new" || editorFor === null ? null : editorFor}
              onDone={() => { setEditorFor(null); setScreen("crew"); }}
              onLeave={() => leaveThen(() => { setEditorFor(null); setScreen("crew"); })}
              onMarket={() => leaveThen(() => { setEditorFor(null); setScreen("market"); })}
            />
          )}
          {screen === "tasks" && <TasksScreen onOpenChannel={id => goChannel(id)} />}
          {screen === "files" && (
            <FilesScreen onOpenChannel={id => goChannel(id)} openAt={fileOpenAt}
              onOpened={clearFileOpen} />
          )}
          {screen === "projects" && (
            <ProjectsScreen onOpenChannel={id => goChannel(id)} />
          )}
          {screen === "spending" && <SpendingScreen />}
          {screen === "activity" && <ActivityScreen />}
          {screen === "notifications" && <NotificationsScreen onOpen={openInboxEntry} />}
          {screen === "settings" && <SettingsScreen />}
        </main>
      </div>

      {searchOpen && (
        <SearchOverlay
          onClose={closeSearch}
          onGo={(channelId, messageId) => {
            setScreen("chat");
            setActiveId(channelId);
            setJumpTo({ id: messageId, at: Date.now() });
            closeSearch();
          }}
          onOpenHit={openEverywhereHit}
        />
      )}
      {/* The one question about unsaved words, for every screen in the app. */}
      <LeaveGuardDialog />
      {quick && <QuickChat onClose={() => setQuick(false)} />}
      {modal === "invite" && <InviteModal onClose={() => setModal(null)} />}
      {modal === "channel" && <ChannelModal onClose={() => setModal(null)} />}
      {modal === "browse" && (
        <BrowseRoomsModal onClose={() => setModal(null)}
          onJoined={id => { setScreen("chat"); setActiveId(id); setModal(null); }} />
      )}
      {modal === "friends" && <FriendsModal onClose={() => setModal(null)} />}
    </div>
  );
}

/** The short name of the hub the client is on right now. */
function activeHubName(world: World): string {
  return world.hubs.find(h => h.id === world.activeHubId)?.label ?? "This computer";
}

/** When the relay refuses something, say so — a save must never fail in silence. */
function Toast(): React.JSX.Element | null {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const err = world.lastError;
  const [dismissed, setDismissed] = useState(0);
  /* Re-read when what is written on the screen changes, not only when a new
     refusal arrives: a form that puts the same sentence under its own box a
     moment later must take this one down. */
  useSyncExternalStore(subscribeSaid, () => saidVersion);
  useEffect(() => {
    if (!err) return;
    const t = setTimeout(() => setDismissed(err.ts), 7000);
    return () => clearTimeout(t);
  }, [err?.ts]);
  if (!err || dismissed === err.ts) return null;
  const said = sayable(err.text);
  if (!said) return null;
  /* THE SAME SENTENCE IS NEVER SAID TWICE ON ONE SCREEN. The audit photographed
     exactly that — the refusal about a duplicate project name in a toast AND
     under the form, one of them wearing the word "Error:". The form is the
     right place for it, because that is where the box he has to change is, so
     the floating one stands down. */
  if (saidCount(said.text) > 0) return null;
  return (
    <div className="toast" role="status">
      <span className="toast-mark" aria-hidden="true">!</span>
      {/* A refused sign-in that cost the person NOTHING has to say so. Without
          the second half, "that invite has already been used" reads like being
          thrown out of your own Cloud9 — which is exactly what it used to be. */}
      <span className="toast-text" data-kept-signed-in={err.keptSignedIn ? "yes" : undefined}>
        {said.text}{err.keptSignedIn ? " You are still signed in as before." : ""}
      </span>
      <ComputerWords detail={said.detail} />
      <button className="toast-x" aria-label="Dismiss" onClick={() => setDismissed(err.ts)}>✕</button>
    </div>
  );
}

/**
 * THE FOUR EVENTS THAT INTERRUPT HIM — each as one on-screen toast.
 *
 * A finished job, an agent asking for a yes, a mention of him, a file an agent
 * published. Each hub fact is turned into a `NotifyEvent` by the engine's
 * `notify-feed` builders — the ONE place that maps a fact to plain words — and
 * then handed to `decideNotification`, the SAME shared gate the rules module
 * owns. Quiet hours, de-dupe, the master switch and never toasting his OWN
 * action are all that gate's job; this component only draws what it raises, and
 * forgets a toast when he dismisses it or after a short while.
 *
 * PRIMING: the first pass after we know who he is folds everything already on
 * screen into `seen` WITHOUT drawing anything. Reconnecting to a full backlog
 * must not fire a toast for every job that finished while he was away — only
 * what arrives AFTER that first pass is allowed to interrupt him.
 *
 * The toast wears its OWN class (`.notify-toast`), never the error `.toast`:
 * they are different news, live in different corners, and a check that counts
 * one must never accidentally count the other.
 */
function NotifyToasts(): React.JSX.Element | null {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const p = usePrefs();
  const seen = useRef<Set<string>>(new Set());
  const primed = useRef(false);
  const [live, setLive] = useState<Cloud9Notification[]>([]);
  const meId = world.me?.id;

  /* ---- WHICH DOOR, once the gate has said yes ----
   *
   * What the app knows about the OS door right now. `supported` is asked of the
   * shell once; `permitted` starts true and is only ever turned OFF by a real
   * refusal — a machine that says no once is not asked to say no every time.
   * Neither of these can raise or silence anything: `decideNotification` above
   * already decided that. They only choose the door. */
  const osDoor = useRef({ supported: false, permitted: true });
  /* Every delivery, with the reason it went where it went. A notification that
     could not reach the operating system is RECORDED and shown as an in-app
     toast instead — "it went nowhere" is never an outcome here. */
  const deliveries = useRef<
    { id: string; via: string; reason: string; fellBack: boolean; error?: string; at: number }[]>([]);

  useEffect(() => {
    const bridge = desktop();
    if (!bridge?.osNotify) return; // a browser has no OS door — toasts, as today
    let alive = true;
    const ask = bridge.notificationsSupported?.() ?? Promise.resolve(true);
    ask.then(
      ok => { if (alive) osDoor.current.supported = ok === true; },
      () => { if (alive) osDoor.current.supported = false; },
    );
    return () => { alive = false; };
  }, []);

  const record = useCallback((
    note: Cloud9Notification, choice: DeliveryChoice, error?: string,
  ): void => {
    deliveries.current.push({
      id: note.id, via: choice.via, reason: choice.reason, fellBack: choice.fellBack,
      ...(error ? { error } : {}), at: Date.now(),
    });
    if (deliveries.current.length > 200) deliveries.current.splice(0, deliveries.current.length - 200);
    if (choice.fellBack) {
      console.warn(
        `[cloud9] this computer would not show a notification (${choice.reason}) — ` +
        `showing it inside Cloud9 instead${error ? `: ${error}` : ""}`);
    }
  }, []);

  const showToast = useCallback((note: Cloud9Notification): void => {
    setLive(cur => (cur.some(n => n.id === note.id) ? cur : [...cur, note]));
  }, []);

  /**
   * Deliver ONE notification the gate has already raised.
   *
   * `chooseDelivery` (packages/shared/src/notify.ts) is the rule; this is the
   * errand. When the OS was the chosen door and refuses, the in-app toast
   * stands in and the refusal is recorded — never dropped.
   */
  const deliver = useCallback((note: Cloud9Notification): void => {
    const bridge = desktop();
    const choice = chooseDelivery({
      windowFocused: typeof document !== "undefined" && document.hasFocus(),
      osSupported: !!bridge?.osNotify && osDoor.current.supported,
      osPermitted: osDoor.current.permitted,
    });
    if (choice.via === "in_app_toast" || !bridge?.osNotify) {
      record(note, choice);
      showToast(note);
      return;
    }
    record(note, choice);
    const refused = (error?: string, unsupported?: boolean): void => {
      if (unsupported) osDoor.current.supported = false;
      else osDoor.current.permitted = false;
      const fallback: DeliveryChoice = {
        via: "in_app_toast",
        reason: unsupported ? "os_unsupported" : "os_refused",
        fellBack: true,
      };
      record(note, fallback, error);
      showToast(note);
    };
    bridge.osNotify(note).then(
      res => { if (!res?.ok) refused(res?.error, res?.supported === false); },
      err => refused(String(err instanceof Error ? err.message : err)),
    );
  }, [record, showToast]);

  /* QA hook, the same shape as the others: what the delivery rule DID, so a
     check can prove "unfocused went to Windows" and "a refusal still reached
     him" rather than photograph a corner of the screen. */
  useEffect(() => {
    (window as unknown as { cloud9Notify?: unknown }).cloud9Notify = {
      delivered: () => deliveries.current.map(d => ({ ...d })),
      door: () => ({ ...osDoor.current, bridge: !!desktop()?.osNotify }),
      choose: chooseDelivery,
      target: notifyTarget,
      muted: () => [...(prefs.get().mutedChannelIds ?? [])],
      /* The thread rule itself, so a check can ask "would a bystander be told?"
         without staging four people in a room — the same shape as `choose` and
         `target` above. It is the SAME function the effect below calls; there is
         no second copy for the suite to agree with. */
      threadRule: threadReplyEvent,
    };
    return () => { delete (window as unknown as { cloud9Notify?: unknown }).cloud9Notify; };
  }, []);

  useEffect(() => {
    if (!meId) return;
    const viewer: NotifyViewer = {
      id: meId,
      agentIds: world.agents.filter(a => a.ownerId === meId).map(a => a.id),
    };
    const nameOf = (agentId: ID): string | undefined =>
      world.agents.find(a => a.id === agentId)?.name;

    /* Every candidate the world currently holds. The builders return null for
       anything that is not this person's news, so the list is already his. */
    const events: NotifyEvent[] = [];
    for (const [channelId, list] of Object.entries(world.messages)) {
      /* THE THREAD AS IT STOOD WHEN EACH REPLY LANDED.
       *
       * `threadReplyEvent` asks who was already in the thread, and it means
       * ALREADY — the authors of the root and of the replies BEFORE this one.
       * Handing it the thread as it stands today would mean that the moment he
       * replies to an old thread, every earlier reply in it becomes news he was
       * "in the thread" for, and he would be handed a burst of toasts about
       * messages he has just read. So this walks the list once, oldest first,
       * and remembers who had spoken in each thread up to that point.
       *
       * Only messages this client has loaded are considered. A reply that
       * arrived in a room he has never opened raises nothing — the room's own
       * unread mark is what tells him about that, and inventing a toast for a
       * message we do not hold would be a guess. */
      const byId = new Map(list.map(m => [m.id, m]));
      const spokenSoFar = new Map<ID, string[]>();
      const ordered = [...list].sort((a, b) => a.ts - b.ts);
      for (const m of ordered) {
        const e = mentionEvent(m, viewer);
        if (e) events.push(e);

        if (!m.replyTo || m.deletedAt) continue;
        const root = byId.get(m.replyTo);
        const before = spokenSoFar.get(m.replyTo) ?? [];
        /* Recorded whether or not it raises: being in the thread is about
           having spoken in it, not about having been notified. */
        spokenSoFar.set(m.replyTo, [...before, m.authorId]);
        if (!root || root.deletedAt) continue;
        const t = threadReplyEvent({
          replyId: m.id,
          channelId: m.channelId || channelId,
          authorId: m.authorId,
          authorName: m.authorName,
          text: m.text,
          at: m.ts,
          rootId: root.id,
          rootAuthorId: root.authorId,
          threadAuthorIds: before,
          mentions: m.mentions ?? [],
        }, viewer);
        if (t) events.push(t);
      }
    }
    for (const t of world.tasks) {
      const e = jobFinishedEvent(t, viewer, nameOf(t.agentId));
      if (e) events.push(e);
    }
    for (const a of world.approvals) {
      const e = approvalEvent(a, viewer, nameOf(a.agentId));
      if (e) events.push(e);
    }
    for (const art of Object.values(world.artifacts)) {
      const v = latestVersion(art);
      if (!v) continue;
      const e = artifactEvent(v, art.channelId, art.name, viewer);
      if (e) events.push(e);
    }

    if (!primed.current) {
      for (const e of events) seen.current.add(dedupeKey(e));
      primed.current = true;
      return;
    }

    const fresh: Cloud9Notification[] = [];
    for (const e of events) {
      const d = decideNotification(e, p, seen.current, new Date());
      /* Once an event has been CONSIDERED it is never reconsidered — whether it
         raised or was suppressed. That is deliberate: a toast is a moment. If it
         was silenced because notifications were off, because it was quiet hours,
         or because it was his own doing, it must not pop later when he flips a
         switch or when the clock leaves the quiet window. (Settings already
         promises the other half: anything urgent still waits for him in Tasks.) */
      seen.current.add(d.key);
      if (d.raise) fresh.push(d.notification);
    }
    /* The gate has spoken; each raised one now goes through its door — the
       operating system when he is not looking at Cloud9, this window's own
       toast when he is (and when the OS will not take it). */
    for (const note of fresh) deliver(note);
  }, [world.messages, world.tasks, world.approvals, world.artifacts, world.agents, meId, p, deliver]);

  const dismiss = useCallback((id: string) => {
    setLive(cur => cur.filter(n => n.id !== id));
  }, []);

  if (!live.length) return null;
  return (
    <div className="notify-stack" role="region" aria-label="Notifications">
      {live.map(n => <NotifyToast key={n.id} note={n} onDismiss={() => dismiss(n.id)} />)}
    </div>
  );
}

/** The little mark on each kind of toast — plain glyphs, no new icon set. */
const NOTIFY_ICON: Record<NotifyEvent["kind"], string> = {
  job_finished: "✓",
  approval_asked: "?",
  mention: "@",
  artifact_published: "⇪",
  thread_reply: "↳",
};

function NotifyToast(
  { note, onDismiss }: { note: Cloud9Notification; onDismiss: () => void },
): React.JSX.Element {
  /* A toast stands down on its own after a while, so a stack cannot grow without
     end. He can always take it down sooner with the ✕. */
  useEffect(() => {
    const t = setTimeout(onDismiss, 9000);
    return () => clearTimeout(t);
  }, [onDismiss]);
  return (
    <div className="notify-toast" role="status" data-kind={note.kind} data-subject={note.subjectId}>
      <span className="notify-mark" aria-hidden="true">{NOTIFY_ICON[note.kind] ?? "•"}</span>
      <div className="notify-copy">
        <b className="notify-title">{note.title}</b>
        <span className="notify-text">{note.body}</span>
      </div>
      <button className="notify-x" aria-label="Dismiss" onClick={onDismiss}>✕</button>
    </div>
  );
}

/* ================= 2 + 3 · CHAT AND DIRECT MESSAGE ================= */

interface Peer {
  name: string; agent?: AgentDef; isAgent: boolean; sub: string; lamp: string; busy: boolean;
}

/**
 * What is waiting in one conversation. `mentions` is its OWN count, not a
 * subset drawn the same way: "someone said something" and "someone asked me
 * something" are different news and are shown differently.
 */
interface Unread {
  unread: number;
  mentions: number;
  /** how many of those are replies living inside a thread, not in the scroll */
  inThreads: number;
  /** true when EVERYTHING new here is inside a thread — the hunt case */
  onlyThreads: boolean;
}

/**
 * The unread marks on a rail row — nothing at all when there is nothing new.
 *
 * The hub counts at most `UNREAD_CEILING` messages in one conversation, so a
 * count that reaches it is "this many or more" and not an exact tally. It used
 * to be printed as though it were exact, which is a number nobody had counted.
 * `unreadLabel` is the one place that decides how a capped number is said, and
 * the title says the same thing in words.
 */
function UnreadMarks({ n }: { n: Unread }): React.JSX.Element | null {
  if (n.unread <= 0 && n.mentions <= 0) return null;
  const capped = (v: number): boolean => v >= UNREAD_CEILING;
  const say = (v: number, what: string): string =>
    capped(v) ? `more than ${UNREAD_CEILING - 1} ${what}` : `${v} ${what}`;
  return (
    <>
      {n.mentions > 0 && (
        <span className="cnt at" data-capped={capped(n.mentions) || undefined}
          title={say(n.mentions, "that ask for you")}
          aria-label={say(n.mentions, "mentioning you")}>@{unreadLabel(n.mentions)}</span>
      )}
      {/* WHERE the new thing is, when it is somewhere the scroll will not show
          it. A thread reply is not in the conversation — it hangs on the
          message it answers — so a bare "1 new" sent him into a room that
          looked unchanged. This says "↳ 1" beside the count, or replaces the
          count's words entirely when EVERYTHING new is in a thread. It never
          adds to the total; it only says where the total is. */}
      {n.inThreads > 0 && (
        <span className="cnt inthread" data-inthread={n.inThreads}
          data-only-threads={n.onlyThreads ? "yes" : undefined}
          title={n.onlyThreads
            ? `${say(n.inThreads, "new")} — all of it inside a thread. Open the message it answers.`
            : `${say(n.inThreads, "of them")} inside a thread`}
          aria-label={`${say(n.inThreads, "new")} inside a thread`}>
          <span aria-hidden="true">↳</span>{unreadLabel(n.inThreads)}
        </span>
      )}
      {n.unread > 0 && (
        <span className="cnt hot" data-capped={capped(n.unread) || undefined}
          data-in-threads={n.inThreads > 0 ? n.inThreads : undefined}
          title={n.onlyThreads
            ? `${say(n.unread, "new")}, inside a thread rather than in the conversation`
            : say(n.unread, "new")}
          aria-label={n.onlyThreads
            ? `${say(n.unread, "new")}, inside a thread`
            : say(n.unread, "new")}>{unreadLabel(n.unread)}</span>
      )}
    </>
  );
}

/**
 * A ROOM HE HAS TURNED DOWN, said on the row itself.
 *
 * Without this, a muted room is simply a room that stopped interrupting him and
 * there is nothing anywhere to say why. It reads the same one list the shared
 * gate reads, so it can never disagree with the room's own panel.
 */
function MutedMark({ channelId }: { channelId?: ID }): React.JSX.Element | null {
  const p = usePrefs();
  if (!channelId || !isRoomMuted(p, channelId)) return null;
  return (
    <span className="mutedmark" data-muted="yes"
      title="Muted — only somebody mentioning you by name gets through"
      aria-label="Muted">🔕</span>
  );
}

/* ==================== THE THREAD'S EDGE, WHICH HE OWNS ====================
   His words, three times over three failed attempts: "in slack there is a kind
   of choice or a free form where i can move the threads to the left-hand side
   according to my preferences... that window should not be looking like a very
   small window for me". `docs/threads-like-slack.html` is the design, measured
   out of the real Slack and the real Buzz rather than remembered.

   Everything that can be got WRONG about it — the floors, the default, the
   point where the window is too narrow to split, the conditional tooltip, and
   the rule that a small window borrows his width rather than editing it — is in
   `packages/shared/threadwidth.ts` under test. What is below is only the
   pointer, the keyboard and the drawing. */

/**
 * HOW MUCH SPACE THE ROOM AND THE THREAD HAVE TO SHARE, watched live.
 *
 * Measured off the grid ITSELF rather than computed from `window.innerWidth`.
 * An earlier attempt at this feature did the arithmetic by hand, got the icon
 * rail wrong, and the number quietly meant something else — so here the element
 * that is actually being divided is asked how wide it is, and only the channel
 * list is subtracted, read from the very custom property that draws it.
 */
function useSpaceToShare(gridRef: React.RefObject<HTMLDivElement | null>): number {
  const [space, setSpace] = useState(0);
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const read = (): void => {
      const side = parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue("--side-w")) || 0;
      setSpace(Math.max(0, Math.round(grid.clientWidth - side)));
    };
    read();
    const watch = new ResizeObserver(read);
    watch.observe(grid);
    /* The channel list steps 250 -> 216 at 1330px, which changes the answer
       without changing the grid's width at all. */
    window.addEventListener("resize", read);
    return () => { watch.disconnect(); window.removeEventListener("resize", read); };
  }, [gridRef]);
  return space;
}

/**
 * THE STRIP HE GRABS. A real button, so it takes keyboard focus and says what
 * it is — Slack ships arrow-key resizing (accessibility changelog, June 2026)
 * and a control only a mouse can reach is not something to hand him.
 */
function ThreadDivider({ stored, drawn, space, onChoose, onReset }: {
  stored: number; drawn: number; space: number;
  onChoose: (px: number) => void; onReset: () => void;
}): React.JSX.Element {
  const [dragging, setDragging] = useState(false);
  const grip = useRef<HTMLButtonElement>(null);

  /* His hand travels out over the room while he drags, so the "do not select
     text, and keep showing the resize pointer" rule has to be on the page, not
     on the strip. Taken off again the moment he lets go, and on unmount, so a
     thread closed mid-drag cannot leave the whole app stuck in that state. */
  useEffect(() => {
    document.body.classList.toggle("dragging-thread", dragging);
    return () => document.body.classList.remove("dragging-thread");
  }, [dragging]);

  /* The thread follows the pointer live — measured from the grid's own right
     edge, so it is the distance from the edge of the window to his cursor and
     nothing has to be guessed about what is outside the grid. */
  const widthAt = useCallback((clientX: number): number => {
    const box = grip.current?.parentElement?.getBoundingClientRect();
    if (!box) return drawn;
    return widthHeChose(box.right - clientX, space);
  }, [drawn, space]);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.current?.setPointerCapture(e.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return;
    onChoose(widthAt(e.clientX));
  }, [dragging, onChoose, widthAt]);

  const stopDragging = useCallback((e: React.PointerEvent<HTMLButtonElement>) => {
    if (!dragging) return;
    setDragging(false);
    try { grip.current?.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  }, [dragging]);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    /* Left widens the thread because left is the direction the edge moves. */
    if (e.key === "ArrowLeft") { e.preventDefault(); onChoose(widthHeChose(drawn + THREAD_STEP, space)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); onChoose(widthHeChose(drawn - THREAD_STEP, space)); }
    /* A keyboard has no double-click, so it gets Home — and only when there is
       something to put back, exactly like the tooltip. */
    else if (e.key === "Home" && stored !== THREAD_DEFAULT) { e.preventDefault(); onReset(); }
  }, [drawn, space, stored, onChoose, onReset]);

  return (
    <button type="button"
      ref={grip}
      className={`threadgrip${dragging ? " dragging" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={dividerSpokenWords(stored)}
      aria-valuenow={drawn} aria-valuemin={THREAD_FLOOR}
      aria-valuemax={Math.max(THREAD_FLOOR, widestThread(space))}
      title={dividerWords(stored)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onLostPointerCapture={() => setDragging(false)}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown} />
  );
}

/**
 * THE WAY BACK TO THE THING THAT OPENED THE THREAD.
 *
 * A takeover moves focus into its own controls. When he leaves it, the
 * keyboard must not fall through to the document body: the reply control that
 * opened the thread is the natural place to continue. The opener can vanish
 * while a room changes or a narrow window forces the panel closed, so every
 * candidate is checked again after the new layout has landed.
 */
function isVisibleFocusTarget(el: HTMLElement | null): el is HTMLElement {
  if (!el || !el.isConnected || el.matches(":disabled,[aria-disabled='true']")) return false;
  if (el.closest("[inert],[aria-hidden='true']")) return false;
  const css = getComputedStyle(el);
  if (css.display === "none" || css.visibility === "hidden") return false;
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

function focusThreadTarget(root: HTMLElement | null, opener: HTMLElement | null): boolean {
  const fallback = root?.querySelector<HTMLElement>(
    ".composer textarea:not(:disabled), .threadgrip:not(:disabled), "
    + ".chathead button:not(:disabled), .sidebar [aria-current='true'], "
    + ".msgs button:not(:disabled)") ?? null;
  const target = isVisibleFocusTarget(opener) ? opener
    : (isVisibleFocusTarget(fallback) ? fallback : null);
  if (!target) return false;
  target.focus({ preventScroll: true });
  return document.activeElement === target;
}

function ChatScreen({
  active, setActiveId, channels, humanDms, agents, people, unreadFor, peerOf, owner,
  onNewChannel, onBrowseRooms, onNewAgent, onBrowseMarket, onInvite, onEditAgent, onOpenDm,
  lastRead, findOpen, onCloseFind,
  onOpenTasks, jumpTo, onJumped, openThreadFor, onThreadOpened,
}: {
  active?: Channel; setActiveId: (id: ID) => void;
  channels: Channel[]; humanDms: Channel[]; agents: AgentDefPlus[]; people: User[];
  unreadFor: (c: Channel) => Unread; peerOf: (c: Channel) => Peer; owner: boolean;
  onNewChannel: () => void; onBrowseRooms: () => void; onNewAgent: () => void;
  onBrowseMarket: () => void; onInvite: () => void;
  onEditAgent: (a: AgentDef) => void; onOpenDm: (id: ID, name: string) => void;
  lastRead: number; findOpen: boolean; onCloseFind: () => void; onOpenTasks: () => void;
  jumpTo: { id: ID; at: number } | null; onJumped: () => void;
  /**
   * The message that STARTED a thread another screen wants opened — a reply
   * found by "search everywhere" is only findable in its own thread, so landing
   * in the room with the thread shut would hide the very row that was found.
   * `at` is the moment it was asked for, so the same thread twice still opens.
   */
  openThreadFor: { id: ID; at: number } | null; onThreadOpened: () => void;
}): React.JSX.Element {
  countRender("ChatScreen");
  /* The rail reads four things and nothing else. Taking the whole world here
     meant every message in every room, every file that landed and every search
     answer redrew the whole floor list. */
  const world = useWorld(w => ({
    channels: w.channels,
    presence: w.presence,
    tasks: w.tasks,
    me: w.me,
  }));
  const isDm = active?.kind === "dm";
  /** the message whose thread is open on the right, if any */
  const [threadRoot, setThreadRoot] = useState<ID | null>(null);
  /** the room-details panel, which shares the right-hand slot with a thread */
  const [detailsOpen, setDetailsOpen] = useState(false);
  /* THREADS OR NOT — his setting, read in the one place that opens them. */
  const p = usePrefs();
  const threading = p.replies !== "inline";

  /* ---- how wide the thread is, and which way he is looking at it ---------
     `p.threadWidth` is HIS number and nothing here ever writes it except his
     own drag, arrow key or double-click. `widthToDraw` gives back what the
     window can actually honour, which on a smaller window is a smaller number
     — borrowed, not saved. Widen the window and his own is back untouched. */
  const gridRef = useRef<HTMLDivElement>(null);
  const threadOpener = useRef<HTMLElement | null>(null);
  const restoreFocusPending = useRef(false);
  const space = useSpaceToShare(gridRef);
  const tooNarrowToSplit = space > 0 && cannotSplit(space);
  const takeover = !!threadRoot && (tooNarrowToSplit || p.threadTakeover);
  const previousTakeover = useRef(takeover);
  const drawnWidth = widthToDraw(p.threadWidth, space);
  const chooseWidth = useCallback((px: number) => { prefs.set({ threadWidth: px }); }, []);
  const resetWidth = useCallback(() => { prefs.set({ threadWidth: THREAD_DEFAULT }); }, []);
  const requestThreadFocusRestore = useCallback(() => {
    restoreFocusPending.current = true;
  }, []);
  const restoreThreadFocus = useCallback(() => {
    /* Keep the opener for the rest of this thread session. A responsive
       force/unforce can cross the same boundary more than once; opening a new
       thread or changing rooms will replace or invalidate this ref naturally. */
    focusThreadTarget(gridRef.current, threadOpener.current);
  }, []);
  /* Focus is restored on the frame AFTER the room has stopped being inert and
     the panel has either changed mode or gone away. This also handles a
     responsive 800px forced takeover becoming a split again without leaving a
     stale opener focused inside a hidden room. */
  useEffect(() => {
    const leftTakeover = previousTakeover.current && !takeover;
    previousTakeover.current = takeover;
    if (!restoreFocusPending.current && !leftTakeover) return;
    restoreFocusPending.current = false;
    const frame = requestAnimationFrame(restoreThreadFocus);
    return () => cancelAnimationFrame(frame);
  }, [takeover, threadRoot, restoreThreadFocus]);
  /* The way back out of the take-over. When the WINDOW forced it there is no
     "beside" to go back to, so the way back is the room itself — which is what
     Buzz's back arrow does at that size. */
  const leaveTakeover = useCallback(() => {
    requestThreadFocusRestore();
    if (tooNarrowToSplit) setThreadRoot(null);
    else prefs.set({ threadTakeover: false });
  }, [requestThreadFocusRestore, tooNarrowToSplit]);

  // a thread — and a details panel — belong to the conversation they were
  // opened from, and go when it changes
  useEffect(() => { setThreadRoot(null); setDetailsOpen(false); }, [active?.id]);

  /* Switching to "keep it in the conversation" closes whatever thread was
     open. Leaving a panel behind that the setting says cannot exist is how a
     setting ends up being only a change of wording. */
  useEffect(() => { if (!threading) setThreadRoot(null); }, [threading]);

  const openThread = useCallback((rootId: ID) => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) {
      threadOpener.current = active;
    }
    setThreadRoot(rootId);
    setDetailsOpen(false);
    client.send({ type: "thread", messageId: rootId });
  }, []);

  /* A reply found by search. Declared AFTER the "a thread belongs to the
     conversation it was opened from" effect above, so when both fire in the
     same render — search moved the room AND asked for a thread — the reset
     runs first and this one wins, which is the order a person expects.
     Threads turned off ("keep it in the conversation") means there is no
     thread to open: the jump to the reply itself is the whole answer, and this
     says so by doing nothing rather than by opening a panel the setting forbids. */
  useEffect(() => {
    if (!openThreadFor) return;
    if (threading) openThread(openThreadFor.id);
    onThreadOpened();
  }, [openThreadFor?.at, openThreadFor?.id, threading, openThread, onThreadOpened]);

  const toggleDetails = useCallback(() => {
    setDetailsOpen(o => !o);
    setThreadRoot(null);
  }, []);

  const agentDmFor = (a: AgentDef) =>
    world.channels.find(c => c.kind === "dm" && c.memberIds.includes(a.id));

  return (
    <div ref={gridRef}
      className={`chatgrid${isDm && !threadRoot && !detailsOpen ? " no-aside" : ""}${
        threadRoot ? " withthread" : ""}${takeover ? " takeover" : ""}`}
      style={{ "--thread-w": `${drawnWidth}px` } as React.CSSProperties}>
      <aside className="sidebar" aria-label="Studio floor">
        <div className="sidebar-head">
          <h2>Studio floor</h2>
          {/* The relay does not report who is at their desk, so this counts who
              is IN this Cloud9 — never "online", which we cannot know. */}
          <span className="chip"
            title={`${countOf(agents.length, "agent")} and ` +
              `${countOf(people.length, "person", "people")} in this Cloud9`}>
            {people.length + agents.length} here
          </span>
        </div>
        <div className="side-scroll">
          <div className="side-group">
            <div className="side-head">
              <span className="eyebrow">Channels</span>
              <button className="browsebtn" title="Browse rooms you could join"
                aria-label="Browse rooms" onClick={onBrowseRooms}>⌕</button>
              <button title="New channel" aria-label="New channel" onClick={onNewChannel}>＋</button>
            </div>
            {channels.length === 0
              ? <RailEmpty text="No channels yet." action="Make the first one" onAction={onNewChannel} />
              : channels.map(c => {
                const unread = unreadFor(c);
                return (
                  <button key={c.id} className={`side-item${c.archivedAt ? " is-archived" : ""}`}
                    data-channel={c.name} data-vis={c.archivedAt ? "archived" : c.visibility ?? "private"}
                    aria-current={active?.id === c.id ? "true" : "false"}
                    onClick={() => setActiveId(c.id)}>
                    <span className="hash">#</span>{" "}
                    <span className="txt">{c.name}</span>
                    {/* Open, shut or retired, on every row — a room anyone can
                        walk into must not look like one you were put in. */}
                    <RoomVisibility channel={c} size="mark" />
                    <MutedMark channelId={c.id} />
                    <UnreadMarks n={unread} />
                  </button>
                );
              })}
            <button className="browserooms" onClick={onBrowseRooms}>Browse rooms to join</button>
          </div>

          <div className="side-group">
            <div className="side-head">
              <span className="eyebrow">Direct</span>
              {/* The same pair as Channels above: browse what exists, or make
                  one. This is where he already comes to add an agent, so this
                  is where the casting room has to be. */}
              <button className="browsebtn tomarket" title="Browse the casting room"
                aria-label="Browse the casting room" onClick={onBrowseMarket}>⌕</button>
              <button title="New agent" aria-label="New agent" onClick={onNewAgent}>＋</button>
            </div>
            {agents.length === 0 && humanDms.length === 0 &&
              <RailEmpty text="Nobody hired yet." action="Browse the casting room" onAction={onBrowseMarket} />}
            {agents.map(a => {
              const dm = agentDmFor(a);
              const unread = dm
                ? unreadFor(dm)
                : { unread: 0, mentions: 0, inThreads: 0, onlyThreads: false };
              /* WHETHER IT CAN BE USED, ON THE ROW ITSELF — the hub's answer and
                 its reason, so he never has to open a conversation to find out
                 that nothing there is going to answer him. */
              const pres = presenceOf(world, a.id);
              const says = presenceSays(world, a.id, pres);
              return (
                <div key={a.id} className="side-item agentrow agent-row" data-agent={a.name}
                  data-presence={pres?.presence ?? "unknown"}
                  data-trouble={says.trouble ?? ""}
                  aria-current={dm && active?.id === dm.id ? "true" : "false"} title={a.persona}>
                  <button className="agentmain" onClick={() => onOpenDm(a.id, a.name)}
                    title={`${says.title}
Open your chat with ${a.name}`}>
                    <AgentFace name={a.name} size={22} presence={pres} hasPresence />
                    <span className="txt agent-name">
                      <span className="an-name">{a.name}</span>
                      <span className={`an-state${says.trouble ? " introuble" : ""}`}>
                        <b>{says.word}</b>
                        {says.reason && <> · {says.reason}</>}
                      </span>
                    </span>
                    <MutedMark channelId={dm?.id} />
                    <UnreadMarks n={unread} />
                  </button>
                  {a.ownerId === world.me?.id &&
                    <button className="editbtn" title="Edit agent" aria-label={`Edit ${a.name}`}
                      onClick={() => onEditAgent(a)}>✎</button>}
                </div>
              );
            })}
            {humanDms.map(c => {
              const pr = peerOf(c);
              const unread = unreadFor(c);
              return (
                <button key={c.id} className="side-item agent-row"
                  aria-current={active?.id === c.id ? "true" : "false"}
                  onClick={() => setActiveId(c.id)}>
                  <PersonFace name={pr.name} size={22} />
                  <span className="txt agent-name">{pr.name}</span>
                  <MutedMark channelId={c.id} />
                  <UnreadMarks n={unread} />
                </button>
              );
            })}
          </div>

          <div className="side-group">
            <div className="side-head">
              <span className="eyebrow">People</span>
              {/* Only the owner can mint an invite (the relay refuses everyone
                  else), so only the owner is offered one. */}
              {owner && <button title="Invite a friend" aria-label="Invite a friend" onClick={onInvite}>＋</button>}
            </div>
            {people.map(u => {
              const isMe = u.id === world.me?.id;
              if (isMe) {
                return (
                  <div key={u.id} className="side-item person-row is-me" data-person={u.name}>
                    <span className="dot live" /><span className="txt">{u.name}</span>
                    <span className="youtag">you</span>
                  </div>
                );
              }
              return (
                <button key={u.id} className="side-item person-row" data-person={u.name}
                  title={`Open your chat with ${u.name}`} onClick={() => onOpenDm(u.id, u.name)}>
                  <span className="dot off" /><span className="txt">{u.name}</span>
                </button>
              );
            })}
            {people.length <= 1 && (owner
              ? <RailEmpty text="Only you so far." action="Invite a friend" onAction={onInvite} />
              : <div className="railempty"><span>Only you so far. Vikas adds people to this Cloud9.</span></div>
            )}
          </div>
        </div>
      </aside>

      {active ? (
        <ChatView key={active.id} channel={active} lastRead={lastRead} findOpen={findOpen}
          onCloseFind={onCloseFind} onEditAgent={onEditAgent} onOpenTasks={onOpenTasks}
          jumpTo={jumpTo} onJumped={onJumped}
          onOpenThread={threading ? openThread : undefined} threadRoot={threadRoot}
          onToggleDetails={toggleDetails} detailsOpen={detailsOpen} takeover={takeover} />
      ) : (
        <div className="thread">
          <div className="msgs">
            <div className="empty">
              <div className="empty-mark" aria-hidden="true">#</div>
              <h2>No channel yet</h2>
              <p>Channels are rooms where you, your friends and your agents talk together.</p>
              <button className="primary" onClick={onNewChannel}>Make your first channel</button>
            </div>
          </div>
        </div>
      )}

      {/* THE ROOM, DIMMED BEHIND THE THREAD — Buzz's own manners: it dims
          rather than vanishing, so he can still see where he is, and clicking
          it is the same as saying "show thread beside channel". Not offered
          when the WINDOW forced the take-over, because then the thread covers
          the lot and there is nothing behind it to click. */}
      {active && threading && threadRoot && takeover && !tooNarrowToSplit && (
        <button type="button" className="threadscrim" tabIndex={-1} aria-hidden="true"
          onClick={leaveTakeover} />
      )}
      {active && threading && threadRoot && (
        <ThreadPanel key={threadRoot} channel={active} rootId={threadRoot}
          takeover={takeover} forced={tooNarrowToSplit}
          onToggleTakeover={takeover
            ? leaveTakeover
            : () => prefs.set({ threadTakeover: true })}
          onClose={() => { requestThreadFocusRestore(); setThreadRoot(null); }} />
      )}
      {/* THE STRIP HE GRABS. There is deliberately no handle at all when the
          window cannot split — a handle that refuses him in silence is the
          thing he likes least, and the take-over above is the real answer at
          that size rather than a dead control with an explanation bolted on. */}
      {active && threading && threadRoot && !takeover && space > 0 && (
        <ThreadDivider stored={p.threadWidth} drawn={drawnWidth} space={space}
          onChoose={chooseWidth} onReset={resetWidth} />
      )}
      {active && !threadRoot && detailsOpen && (
        <RoomPanel key={`details-${active.id}`} channel={active}
          onClose={() => setDetailsOpen(false)} onOpenDm={onOpenDm}
          onLeft={() => setDetailsOpen(false)} />
      )}
      {active && !isDm && !threadRoot && !detailsOpen &&
        <ChannelRail channel={active} onEditAgent={onEditAgent} onOpenDm={onOpenDm} />}
    </div>
  );
}

function RailEmpty({ text, action, onAction }: { text: string; action: string; onAction: () => void }): React.JSX.Element {
  return (
    <div className="railempty">
      <span>{text}</span>
      <button onClick={onAction}>{action}</button>
    </div>
  );
}

interface Row {
  m: Message;
  cont: boolean;
  dayStart: boolean;
  firstUnread: boolean;
  /** the human message that asked for this agent run, when one is on record */
  ask?: Message;
}

/**
 * Walk back for the human message that put this agent to work. Stops at the
 * agent's own previous post — that ask was already answered.
 */
/**
 * THE JOB EACH "📦 Task …" MESSAGE IS THE RESULT OF — for a whole list.
 *
 * A message carries no job id, so the only honest link is the RESULT ITSELF:
 * the hub stores a finished job's result, and the agent posts exactly that text
 * under the 📦 line. Matching on the words is exact, not a guess about timing —
 * and if two jobs somehow match, or none does, no card is drawn at all. A run
 * card under the wrong job would be worse than no run card.
 *
 * (A very long result is stored clipped at 2,000 characters, so that one case
 * matches on the stored prefix — still exact about which job it was.)
 *
 * It is done for the LIST rather than inside each bubble because it was the
 * last thing making a bubble read the store: `tasks` changes every time any
 * agent moves, and that redrew every message on screen for a card almost none
 * of them have.
 */
function doneRunIdsFor(messages: Message[], tasks: Task[]): Map<ID, string> {
  const map = new Map<ID, string>();
  for (const m of messages) {
    if (m.authorKind !== "agent" || m.deletedAt) continue;
    /* EVERY WAY A JOB ENDS, not only the happy one (2026-08-06). This read
       "done" alone, so a job the owner STOPPED got no card — and the card is
       the only thing on the screen that says `cancelled` rather than
       "finished". He pressed Stop and nothing in front of him disagreed with
       the word "done". One expression, all the endings: whatever a job's last
       message is called, it is matched to its job the same way. */
    const head = /^📦 (?:Background t|T)ask (?:done|stopped):\n/.exec(m.text);
    if (!head) continue;
    const body = m.text.slice(head[0].length);
    const hits = tasks.filter(t =>
      t.channelId === m.channelId && t.agentId === m.authorId && t.runId && t.result
      && (t.result === body || (t.result.length === 2000 && body.startsWith(t.result))));
    if (hits.length === 1 && hits[0].runId) map.set(m.id, hits[0].runId);
  }
  return map;
}

function findAsk(messages: Message[], i: number, agent: Message): Message | undefined {
  const at = new RegExp(`@${agent.authorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  for (let j = i - 1; j >= 0 && j >= i - 15; j--) {
    const prev = messages[j];
    if (prev.authorKind === "agent" && prev.authorId === agent.authorId) return undefined;
    if (prev.authorKind === "human" && at.test(prev.text)) return prev;
  }
  return undefined;
}

/* ---- the structured answer card ----
 * An agent's answer is text. When that text really does carry a run of
 * labelled facts — "Device: FRN-SW-01" and friends — the app sets them as a
 * card with a title, labelled rows and the actions you can take. Nothing is
 * invented: every row is a line the agent actually wrote, and a message with
 * no such run stays plain paragraphs.
 */
const LABEL_LINE = /^\s{0,3}\**([A-Za-z][A-Za-z0-9 /&'()-]{1,28})\**\s*:\s+(\S.*?)\s*$/;

interface AnswerShape {
  lead: string[];
  card?: { title?: string; rows: [string, string][] };
  tail: string[];
}

export function parseAnswer(text: string): AnswerShape {
  const lines = text.split("\n");
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!LABEL_LINE.test(lines[i])) continue;
    let j = i;
    while (j + 1 < lines.length && LABEL_LINE.test(lines[j + 1])) j++;
    if (j - i >= 1) { start = i; end = j; break; }
  }
  if (start < 0) return { lead: [], tail: [], card: undefined };

  const rows = lines.slice(start, end + 1).map(l => {
    const m = LABEL_LINE.exec(l)!;
    return [m[1].trim(), m[2].trim()] as [string, string];
  });
  const before = lines.slice(0, start).map(l => l.trim()).filter(Boolean);
  const title = before.length > 0 ? before[before.length - 1].replace(/^\**|\**$/g, "").replace(/:$/, "") : undefined;
  return {
    lead: before.slice(0, Math.max(0, before.length - 1)),
    card: { title, rows },
    tail: lines.slice(end + 1).map(l => l.trim()).filter(Boolean),
  };
}

/** Title, labelled rows and the actions underneath — the prototype's answer block. */
function AnswerCard({ title, rows, tone, lead, actions }: {
  title?: string; rows: [string, string][]; tone?: "answer" | "proactive" | "approval";
  lead?: React.ReactNode; actions?: React.ReactNode;
}): React.JSX.Element {
  const mark = tone === "proactive" ? <MarkIdea /> : tone === "approval" ? <MarkGate /> : <MarkAnswer />;
  return (
    <div className={`callout ${tone ?? "answer"}`}>
      {title && <div className="hd">{mark}<h4>{title}</h4></div>}
      {lead}
      {rows.length > 0 && (
        <dl className="kv">
          {rows.map(([k, v], i) => (
            <React.Fragment key={`${k}-${i}`}><dt>{k}</dt><dd>{v}</dd></React.Fragment>
          ))}
        </dl>
      )}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

/* ================= WHAT AN AGENT ACTUALLY DID (FR-TL-003) =================

   An agent can say it did something. Until now the screen could not show what
   it ACTUALLY did. The engine writes a record of every turn, the hub stores and
   serves it with the permission checks and the redaction already applied, and
   everything below draws it — in the prototype's own shape: a titled card, a
   plain-words line, labelled rows, and a disclosure.

   THE ONE LAW HERE: a row whose value is absent is not rendered at all. No
   "—", no "0", no "about". Claude reports money and refused tools; Codex
   reports neither, so a Codex run simply has no COST row. Showing a zero where
   the CLI said nothing is the exact lie this feature was built to stop.

   The words come from `@cloud9/shared` — `summarizeRun`, `humanDuration`,
   `humanMoney` — never from a second spelling written here. The hub puts the
   same sentence in the activity trail, and two spellings of "76 cents" is a bug
   the owner would see before we did.                                        */

/** One line-drawn mark per kind of thing an agent did (§4.2 of the handoff). */
function StepMark({ kind }: { kind: RunStepKind }): React.JSX.Element {
  const path = ((): React.ReactNode => {
    switch (kind) {
      case "command": return <><rect x="3" y="4.5" width="18" height="15" rx="2.2" /><path d="M7 10l2.6 2.2L7 14.4M12.4 15h4" /></>;
      case "read": return <><path d="M6 3.5h8l4 4v13H6z" /><path d="M14 3.5v4h4M9 12h6M9 15.5h6" /></>;
      case "write": return <><path d="M4 20l.9-3.6L15.2 6.1a1.8 1.8 0 0 1 2.6 0l1.1 1.1a1.8 1.8 0 0 1 0 2.6L8.6 20.1z" /><path d="M14 7.5l2.5 2.5" /></>;
      case "search": return <><circle cx="10.5" cy="10.5" r="6" /><path d="M15 15l4.5 4.5" /></>;
      case "web": return <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.4 2.4 14.6 0 17M12 3.5c-2.4 2.4-2.4 14.6 0 17" /></>;
      case "tool": return <><path d="M14.6 5.4a4.2 4.2 0 0 0 5.3 5.4l-9 9a2.1 2.1 0 0 1-3-3l9-9a4.2 4.2 0 0 0-2.3-2.4z" /></>;
      case "thinking": return <><circle cx="12" cy="12" r="8.5" strokeDasharray="2.6 2.6" /><path d="M9.5 12h.01M12 12h.01M14.5 12h.01" /></>;
      case "message": return <><path d="M4 5.5h16v11H9l-5 3.5z" /><path d="M8 9.5h8M8 12.5h5" /></>;
      case "note": return <><path d="M12 3.2l7 2.6v6c0 4.4-3 7.6-7 9-4-1.4-7-4.6-7-9v-6z" /><path d="M9 12l2.2 2.2L15.2 10" /></>;
    }
  })();
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {path}
    </svg>
  );
}

/** A `web` step's detail is a real URL, deliberately protected from redaction. */
const isLink = (s: string): boolean => /^https?:\/\//i.test(s);

/**
 * Every step, in the order it happened.
 *
 * Thinking and talking are collapsed to start with — they are the steps a
 * person scrolls past to find the four that matter. A refusal (`note`) is the
 * opposite: it is the first evidence Cloud9 has ever had that a permission
 * boundary actually held, so it is drawn as a good thing, not an error.
 */
function RunSteps({ steps, truncated }: {
  steps: readonly RunStep[]; truncated?: boolean;
}): React.JSX.Element {
  const [showQuiet, setShowQuiet] = useState(false);
  const isQuiet = (s: RunStep): boolean => s.kind === "thinking" || s.kind === "message";
  const quiet = steps.filter(isQuiet);
  // already in `seq` order, and a filter keeps it that way
  const shown = showQuiet ? steps : steps.filter(s => !isQuiet(s));
  return (
    <div className="runsteps">
      <ol>
        {shown.map(s => (
          <li key={s.seq} className={`runstep${s.ok === false ? " bad" : ""}${s.kind === "note" ? " held" : ""}`}
            data-kind={s.kind} data-seq={s.seq} data-ok={s.ok === undefined ? "unsaid" : String(s.ok)}>
            <span className="sq">{s.seq}</span>
            <span className="ic"><StepMark kind={s.kind} /></span>
            <span className="tx">
              <span className="lb">{s.label}</span>
              {/* The text arrived redacted TWICE — by the engine on the way out
                  and by the hub on the way in. What survived is what the owner
                  is meant to see, so it is drawn as it came: no tidying, no
                  rebuilding a path, and never through the markdown renderer. */}
              {s.detail && (isLink(s.detail) && s.kind === "web"
                ? <a className="dt lnk" href={s.detail} target="_blank" rel="noreferrer noopener">{s.detail}</a>
                : <span className="dt">{s.detail}</span>)}
            </span>
            {/* Absent means the app never said. No tick AND no cross. */}
            {s.ok === true && <span className="mk yes" title="the app said this worked">✓</span>}
            {s.ok === false && <span className="mk no" title="the app said this failed">✕</span>}
          </li>
        ))}
      </ol>
      {quiet.length > 0 && (
        <button className="runquiet" aria-expanded={showQuiet} onClick={() => setShowQuiet(v => !v)}>
          {showQuiet ? "Hide" : "Show"} what it thought and said · {quiet.length}
        </button>
      )}
      {truncated && (
        <p className="runtrunc">Some steps were left out to keep this small.</p>
      )}
    </div>
  );
}

/* ============ WHAT IT IS DOING RIGHT NOW (the live half of the above) ========

   THE GAP THIS CLOSES. The record above is honest and complete, and it arrives
   at the END. Until it did, a person watching an agent work saw one line — "X
   is working on it" — for minutes, and then the whole story at once. Sitting in
   the CLI you watch each tool call as it lands. This is that, in the room.

   FOUR PROMISES, and the code below is only these:

   1. THE SAME RENDERER. `RunSteps` draws these, exactly as it draws a stored
      record's. There is no second vocabulary and no second list — a live "Read
      note.txt" and a recorded one are the same words in the same shape,
      because they came from the same mapper reading the same line.
   2. NOTHING INVENTED. Every row came out of the CLI's own output. There is no
      "starting…", no guess at what is next, and no spinner pretending to be a
      step.
   3. NO EMPTY BOX. It draws nothing at all until a real step has arrived. A
      provider or a run that cannot stream produces no live view whatsoever —
      the person simply sees what they always saw, the record at the end. An
      empty box that never fills would be a worse lie than no box.
   4. IT GIVES WAY. The engine ends the preview when the turn ends and this
      disappears; the stored record then appears under the agent's reply and is
      the lasting answer. Reload mid-turn and the preview is gone — nothing is
      lost, because it was never the record.                                  */

/**
 * The live steps for one message's turn, one block per agent working on it.
 *
 * `agents` is passed IN rather than read from the client, for the same reason
 * `AgentReceipts` does it: one direction of import, and no cycle.
 */
function LiveWork({ messageId, agents }: {
  messageId: ID; agents: readonly AgentDef[];
}): React.JSX.Element | null {
  const rows = useLiveSteps(messageId);
  if (rows.length === 0) return null;
  return (
    <div className="livework" data-machine="yes" data-msg={messageId}>
      {rows.map(row => {
        if (row.steps.length === 0) return null;
        const name = agents.find(a => a.id === row.agentId)?.name ?? "An agent";
        return (
          <div key={row.agentId} className="liveturn" data-agent={row.agentId}
            data-live-steps={row.steps.length}>
            <p className="livehd">
              <span className="pulse" aria-hidden="true" />
              {name} is working — here's what it's done so far
            </p>
            <RunSteps steps={row.steps} />
            {/* SAID OUT LOUD on the thing itself, the same courtesy a receipt
                pays: this is live, and it is not the record. The record lands
                under the reply when the turn ends. */}
            <p className="livenote">
              Live from the app as it works. The full record appears when it finishes.
            </p>
          </div>
        );
      })}
    </div>
  );
}

/** ✓ / ✕ / ⏸ for the three ways a turn can end. */
function RunMark({ outcome }: { outcome: RunRecord["outcome"] }): React.JSX.Element {
  if (outcome === "failed") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--madder)"
        strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="8.6" /><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" />
      </svg>
    );
  }
  if (outcome === "cancelled") return <MarkClock />;
  return <MarkAnswer />;
}

/**
 * One run, drawn as the prototype's callout: a titled head, the plain-words
 * line, labelled rows, and the steps behind a disclosure.
 */
function RunCard({ record }: { record: RunRecord }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const provider = PROVIDER_LABEL[record.provider] ?? record.provider;
  // what the app SAID it used, or failing that what we asked for — and if
  // neither was reported, the app's name alone rather than an invented model
  const model = record.actualModel ?? record.model;

  const rows: [string, string, React.ReactNode][] = [
    ["asked-by", "Asked by", `${record.requestedBy} · ${clock(record.startedAt)}`],
    ["ran-on", "Ran on", model ? `${provider} · ${modelLabel(model)}` : provider],
    ["took", "Took", humanDuration(record.durationMs)],
  ];
  // THE ROW THAT MUST BE ABSENT WHEN THE VALUE IS. Codex never reports money,
  // so a Codex run has no COST row at all — not a zero, not an estimate.
  if (typeof record.usage?.costUsd === "number") {
    rows.push(["cost", "Cost", humanMoney(record.usage.costUsd)]);
  }
  /* HE CHOSE A MODEL AND DID NOT GET IT. Its own row, above everything else
     about what happened, because "why does this run look different from the
     last one" is unanswerable without it. It is only ever present when the app
     reported a model the owner had NAMED as a stand-in — a swap we cannot
     prove is never claimed here (see `fellBackTo` in @cloud9/shared). */
  if (record.fellBackTo) {
    rows.push(["fell-back", "Model", fellBackWords(record.model, record.fellBackTo)]);
  }
  /* A SPENDING LIMIT STOPPED IT. The row exists for the same reason the failure
     row does: an agent that stops has to say why, and "your limit" is a reason
     he can act on, unlike "something went wrong". Absent on every run that was
     not stopped by one, which — until he sets one — is all of them. */
  if (record.capStop) {
    rows.push(["cap-stop", "Stopped by", record.capStop.which === "perJob"
      ? `your ${humanMoney(record.capStop.capUsd)} limit for one job`
      : `your ${humanMoney(record.capStop.capUsd)} limit for this month`]);
  }
  /* A PLAN IS NOT THE JOB. Said out loud so a person reading a list of runs
     does not read the plan turn as the work having been done. */
  if (record.planOnly) {
    rows.push(["plan-only", "This run", "was the plan only — no work was done"]);
  }
  /* HOW MUCH OF THIS HE WAS ASKED ABOUT — recorded on the run at the moment it
     started, so it says what was true THEN even if he has changed his mind
     since. It is the row that makes "don't ask me" survivable: he stops being
     interrupted, and he does not stop being able to find out afterwards which
     turns were allowed to work while he was not looking. Absent on runs from
     before the setting existed, and absent reads as the strictest one. */
  rows.push(["trust", "Your rule then", trustLevel(trustOf(record)).cardWords]);
  /* THE ONE OWNER OF WHAT A FAILURE SAYS, applied to the row a person is most
     likely to meet one in. `redactForSharing` on the engine side took the
     secrets and the paths out; it does not turn computer-speak into English,
     which is why this row could read `Claude exited with 1: fatal: …`. */
  /* WHY IT ENDED, IN THE WORDS THAT FIT HOW IT ENDED (2026-08-06). This row was
     always headed "What went wrong", whatever the outcome — so a run the OWNER
     stopped told him, on the receipt, that his own decision had gone wrong. It
     is the same lie the ✅ on a stopped job was telling, one screen further on:
     a stop is neither a success nor a fault, and it must not be filed under
     either. The sentence is unchanged; only the question it is answering is. */
  if (record.error) {
    rows.push(record.outcome === "cancelled"
      ? ["stopped-by-you", "Why it stopped", plainError(record.error)]
      : ["went-wrong", "What went wrong", plainError(record.error)]);
  }

  const title = record.outcome === "failed"
    ? `${record.agentName} didn't finish “${record.ask}”`
    : record.outcome === "cancelled"
      ? `${record.agentName} was stopped on “${record.ask}”`
      : `${record.agentName} finished “${record.ask}”`;

  return (
    <div className={`callout run out-${record.outcome}`} data-run={record.id}
      data-outcome={record.outcome} data-provider={record.provider}>
      <div className="hd"><RunMark outcome={record.outcome} /><h4>{title}</h4></div>
      {/* verbatim from shared — the one line a non-developer reads, and the
          reason this whole feature exists */}
      <p className="runsum">{summarizeRun(record)}</p>
      <dl className="kv">
        {rows.map(([key, label, value]) => (
          <React.Fragment key={key}>
            <dt data-row={key}>{label}</dt><dd data-row={key}>{value}</dd>
          </React.Fragment>
        ))}
      </dl>
      {record.steps.length > 0 && (
        <button className="runmore" aria-expanded={open} data-steps={record.steps.length}
          onClick={() => setOpen(v => !v)}>
          <span className="tri" aria-hidden="true">{open ? "▾" : "▸"}</span>
          What it did<span className="n">{countOf(record.steps.length, "step")}</span>
        </button>
      )}
      {open && record.steps.length > 0 &&
        <RunSteps steps={record.steps} truncated={record.truncated} />}
    </div>
  );
}

/**
 * The record behind one finished job, wherever that job is shown.
 *
 * A `run` frame arrives unasked for every turn in a conversation this person
 * can see, so most of the time the record is already here and the card is drawn
 * without a word going over the wire. When it is not — an older job, a run that
 * happened before this screen connected — the card is one click away, and the
 * click is what asks. Nothing is drawn from a `runId` alone.
 */
function TaskRun({ runId }: { runId: string }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [asked, setAsked] = useState(false);
  const record = world.runs[runId];
  if (record) return <RunCard record={record} />;
  if (world.runsGone[runId]) {
    return <div className="runmissing" data-run={runId}>That record isn't there any more.</div>;
  }
  if (asked) return <div className="runwait" data-run={runId}>Fetching what it did…</div>;
  return (
    <button className="btn small runopen" data-run={runId}
      onClick={() => { setAsked(true); client.askRun(runId); }}>
      What it did
    </button>
  );
}

/**
 * What this agent has been doing lately — FR-ME-003, with evidence behind it.
 *
 * OWNER ONLY, and that is the hub's rule, not a courtesy: being in a room with
 * someone's agent shows you the turns it takes THERE; it is not a licence to
 * read everything it has ever done. Callers must not render this for an agent
 * that is not this person's.
 */
function RecentWork({ agentId }: { agentId: ID }): React.JSX.Element {
  // subscribed for the re-render: the list itself is read through the client,
  // so there is one spelling of a history's key and not two
  useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [open, setOpen] = useState<string | null>(null);
  const list = client.runsFor("agent", agentId);
  useEffect(() => { client.askRuns("agent", agentId, RUN_HISTORY_LIMIT); }, [agentId]);

  return (
    <div className="recentwork" data-agent={agentId}>
      {!list.asked && <div className="d-empty">Looking up what it has been doing…</div>}
      {list.asked && list.entries.length === 0 && (
        <div className="d-empty">Nothing yet. Every turn it takes from now on is written down here.</div>
      )}
      {list.entries.map((e: RunListEntry) => (
        <div className="workrow" key={e.id} data-run={e.id} data-outcome={e.outcome}>
          <button className="wr-head" aria-expanded={open === e.id}
            onClick={() => {
              const next = open === e.id ? null : e.id;
              setOpen(next);
              if (next) client.askRun(e.id);
            }}>
            <span className="wr-when">{clock(e.startedAt)}</span>
            <span className="wr-tx">
              <b>{e.ask}</b>
              <span className="wr-sum">{e.summary}</span>
            </span>
            <span className={`chip ${e.outcome === "ok" ? "is-pine" : e.outcome === "failed" ? "is-madder" : ""}`}>
              {e.outcome === "ok" ? "Done" : e.outcome === "failed" ? "Didn't finish" : "Stopped"}
            </span>
          </button>
          {open === e.id && <TaskRun runId={e.id} />}
        </div>
      ))}
    </div>
  );
}

/**
 * WHAT THIS AGENT REMEMBERS between conversations — its own saved notes, newest
 * first, each with when it was saved and a way to clear it.
 *
 * Every note here is real: the list arrives from the engine's own store on this
 * computer (see `store.askMemory`), nothing is invented, and the honest empty
 * state waits for the engine's answer before it says the agent has saved
 * nothing. Clearing a note asks the engine to delete it and report back, so the
 * panel never shows one the store no longer holds.
 */
function RememberedNotes({ agentId }: { agentId: ID }): React.JSX.Element {
  useSyncExternalStore(client.subscribe, client.getSnapshot);
  const held = client.memoryFor(agentId);
  useEffect(() => { client.askMemory(agentId); }, [agentId]);
  // the store keeps notes oldest-first; the panel shows the newest at the top
  const notes = [...held.notes].reverse();
  return (
    <div className="remembers" data-memory-panel={agentId} data-notes={notes.length}>
      {!held.asked && <div className="d-empty">Looking up what it remembers…</div>}
      {held.asked && notes.length === 0 && (
        <div className="d-empty" data-memory-empty="yes">
          This agent hasn't saved anything to remember yet.
        </div>
      )}
      {/* GAP A (2026-08-05): a note the AGENT wrote itself is marked, because an
          agent may now write its own memory and the owner must be able to see
          which notes are his and which are its. `data-source` says it in the
          markup as well as in the words, so a QA sweep can prove it. */}
      {notes.map(n => (
        <div className={`memrow${n.source === "agent" ? " by-agent" : ""}`}
          key={n.id} data-note={n.id} data-source={n.source}>
          <span className="mem-tx">
            <b>{n.text}</b>
            <span className="mem-when">
              {dayLabel(n.createdAt)} at {clock(n.createdAt)}
              {n.source === "owner" ? " · you asked it to remember this"
                : n.source === "agent" ? " · it chose to remember this"
                : " · saved by Cloud9"}
            </span>
          </span>
          <button className="btn small ghost mem-clear" data-clear={n.id}
            title="Forget this note"
            onClick={() => client.forgetMemoryNote(agentId, n.id)}>Clear</button>
        </div>
      ))}
    </div>
  );
}

function ChatView({
  channel, lastRead, findOpen, onCloseFind, onEditAgent, onOpenTasks,
  jumpTo, onJumped, onOpenThread, threadRoot, onToggleDetails, detailsOpen,
  takeover,
}: {
  channel: Channel; lastRead: number; findOpen: boolean; onCloseFind: () => void;
  onEditAgent: (a: AgentDef) => void; onOpenTasks: () => void;
  jumpTo: { id: ID; at: number } | null; onJumped: () => void;
  /** absent when his setting says replies stay in the conversation */
  onOpenThread?: (rootId: ID) => void; threadRoot: ID | null;
  onToggleDetails: () => void; detailsOpen: boolean;
  /** The room is covered by a take-over thread and must leave the tab order. */
  takeover: boolean;
}): React.JSX.Element {
  countRender("ChatView");
  /* WHAT THIS SCREEN ACTUALLY READS — nothing else can redraw it.
     It used to take the whole world, so a message in ANOTHER room, an artifact
     landing, a project answer or a search result all redrew the conversation
     and (before the row below was memoised) every bubble in it. `messages` and
     `page` are narrowed to THIS channel for the same reason. */
  const world = useWorld(w => ({
    messages: w.messages[channel.id],
    page: w.pages[channel.id],
    prepended: w.prepended,
    users: w.users,
    agents: w.agents,
    me: w.me,
    agentStatus: w.agentStatus,
    presence: w.presence,
    tasks: w.tasks,
    approvals: w.approvals,
  }));
  const all = useMemo(() => world.messages ?? [], [world.messages]);
  const threading = !!onOpenThread;
  /** the message this conversation's own box is answering, in inline mode */
  const [replyingTo, setReplyingTo] = useState<ID | null>(null);
  useEffect(() => { setReplyingTo(null); }, [channel.id]);
  useEffect(() => { if (threading) setReplyingTo(null); }, [threading]);
  const streamRef = useRef<HTMLDivElement>(null);
  const roomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const room = roomRef.current;
    if (!room) return;
    room.inert = takeover;
    return () => { room.inert = false; };
  }, [takeover]);
  const findRef = useRef<HTMLInputElement>(null);
  const [openedAt] = useState(lastRead);
  /**
   * THE THREADS HE HAS ALREADY LOOKED AT, this visit.
   *
   * A thread whose "N replies" line says New must stop saying it once he has
   * opened it — otherwise the mark is on for as long as he stays in the room
   * and means nothing. Opening one is the only thing that puts it in here, and
   * changing conversation empties it, because "already looked at" is about this
   * room, this visit.
   */
  const [openedThreads, setOpenedThreads] = useState<ReadonlySet<ID>>(() => new Set<ID>());
  useEffect(() => { setOpenedThreads(new Set<ID>()); }, [channel.id]);
  useEffect(() => {
    if (!threadRoot) return;
    setOpenedThreads(s => (s.has(threadRoot) ? s : new Set([...s, threadRoot])));
  }, [threadRoot]);
  const page = world.page ?? { hasMore: true, loading: false, asked: false };
  /** the message a search result sent us to, lit up for a moment */
  const [litUp, setLitUp] = useState<ID | null>(null);

  /* ---- Find in conversation (Ctrl+F / Edit menu) ---- */
  const [find, setFind] = useState("");
  useEffect(() => { if (findOpen) findRef.current?.focus(); }, [findOpen]);
  useEffect(() => { if (!findOpen) setFind(""); }, [findOpen]);
  const needle = findOpen ? find.trim().toLowerCase() : "";

  /**
   * WHAT THE CONVERSATION ITSELF SHOWS — and this is the whole of "threads".
   *
   * With threads on, a reply lives on the message it answers and is NOT a row
   * in the conversation. That one rule is what he could not find: every reply
   * used to be posted into the room as well, so a thread never visually
   * existed — the room simply got longer and carried a small "said in a
   * thread" label. The message it answers still shows its reply count, and
   * that is how you get to it.
   *
   * Two deliberate exceptions, both so nothing becomes unreachable:
   *  - Find in conversation searches everything, replies included. A reply you
   *    cannot find is a reply that is lost.
   *  - A message the app is being sent to (a search result) is shown wherever
   *    it is, so the jump lands rather than walking off the end of the room.
   *
   * With his setting on "keep it in the conversation" nothing is hidden at
   * all, and no thread is ever opened.
   */
  /* Memoised on the four things that can change the answer, so an unrelated
     redraw (a job update, a presence tick) does not re-filter the whole
     conversation. The dependency list is the honest one: drop `litUp` or
     `jumpTo` from it and a search jump would land on a message the list had
     decided not to show. */
  const shown = useMemo(() => ((threading && !needle)
    ? all.filter(m => !m.replyTo || m.id === jumpTo?.id || m.id === litUp)
    : all), [threading, needle, all, jumpTo?.id, litUp]);
  const messages = useMemo(() => (needle
    ? all.filter(m => m.text.toLowerCase().includes(needle) || m.authorName.toLowerCase().includes(needle))
    : shown), [needle, all, shown]);

  /* ---- scrollback ----
   *
   * Three rules, and they must not fight each other:
   *  1. a NEW message at the bottom follows the reader down, but only if the
   *     reader was already down there;
   *  2. an OLDER page put on the front must not move the words under the
   *     reader's eyes — the view is nailed to what it was looking at;
   *  3. reaching the top asks for the page before, and stops when the relay
   *     says there is nothing older. */
  /**
   * The message the reader is looking at, and where it sat on screen.
   *
   * Anchored to a ROW, not to `scrollHeight`: the height of the list changes
   * for reasons other than the new page — the "fetching…" line appears and is
   * then replaced by "that's the beginning" — and a restore computed from the
   * total height carries every one of those differences into the reader's eye.
   * A row cannot lie about where it is.
   */
  const anchor = useRef<{ id: ID; top: number } | null>(null);
  /** the walk asked for by a search result, read from inside the rules below */
  const jumpRef = useRef(jumpTo);
  jumpRef.current = jumpTo;

  /**
   * SOMETHING OTHER THAN "FOLLOW THE NEWEST" OWNS THE VIEW.
   *
   * Said ONCE, and asked by both halves of the rule — the effect below and the
   * resize watcher inside `useFollowToBottom`. This one expression is what stops
   * a wider follow rule from putting finding #19 back: an older page going on the
   * front, and a walk to one particular message, both still win.
   */
  const viewIsClaimed = useCallback(
    () => anchor.current !== null || jumpRef.current !== null, []);

  const { follow, atBottom, noteScrolled } = useFollowToBottom(streamRef, viewIsClaimed);

  const askForOlder = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    const p = client.page(channel.id);
    if (p.loading || (p.asked && !p.hasMore)) return;
    const first = el.querySelector<HTMLElement>(".msg[data-msg]");
    anchor.current = first?.dataset.msg
      ? { id: first.dataset.msg, top: first.getBoundingClientRect().top }
      : null;
    client.loadOlder(channel.id);
  }, [channel.id]);

  /**
   * ONE OWNER OF WHERE THIS LIST IS SCROLLED TO.
   *
   * The three rules above used to live in two effects, and the split WAS the
   * bug. A layout effect runs before a plain one, so the anchor restore had
   * already cleared `anchor.current` by the time the follow-to-bottom effect
   * read it — its guard could never see an anchor, and it followed anyway. A
   * search jump that had to walk back through pages flashed to the newest
   * message on every single page it loaded.
   *
   * Two effects cannot guard against each other; whichever runs first wins by
   * accident. So there is one, it is a layout effect (the reader must never see
   * the intermediate position), and the priority is stated once, here.
   *
   * How and WHEN the third rule moves the view is `useFollowToBottom`'s — the one
   * owner of that question, shared with the thread panel and asked again by every
   * other thing that moves the bottom (a growing box, a picture that finished
   * loading, the file tray opening).
   */
  const newest = messages.length ? messages[messages.length - 1].id : "";
  /* Read by the scroll handler, which must not be rebuilt every time a message
     lands — a new handler on every arrival is a new listener on every arrival. */
  const newestRef = useRef(newest);
  newestRef.current = newest;

  /**
   * THE NEWEST MESSAGE HE HAS ACTUALLY BEEN SHOWN.
   *
   * Everything after it is what the pill counts. Written in exactly two places
   * and both mean the same thing — the view is at the bottom, so what is at the
   * bottom has been seen: the rule taking him there, and him arriving there
   * under his own steam.
   */
  const seenNewest = useRef<ID>("");
  /** how many have landed below him since; 0 means the pill is not there at all */
  const [newBelow, setNewBelow] = useState(0);
  const meId = world.me?.id;
  const caughtUp = useCallback(() => {
    seenNewest.current = newestRef.current;
    setNewBelow(n => (n === 0 ? n : 0));
  }, []);
  /* The QA hook reads the rule, not the pill's pixels — see `newBelowNow`. */
  useEffect(() => {
    newBelowNow = newBelow;
    return () => { newBelowNow = 0; };
  }, [newBelow]);

  /* THE PAGE WE ASKED FOR IS STILL COMING. Read as a plain boolean rather than
     off `page`, whose object identity changes for reasons the rule below does
     not care about. */
  const pageLoading = page.loading;

  React.useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    // 1. an older page went on the front: nail the view to the row the reader
    //    was actually looking at, whatever else is going on.
    const held = anchor.current;
    if (held) {
      /**
       * AN ANCHOR IS HELD ONLY WHILE THE PAGE IT IS WAITING FOR IS IN FLIGHT.
       *
       * WHAT THIS IS FOR, said honestly. It ties the anchor's life to the load's
       * life: asking for an older page sets the anchor, and it is spent the
       * moment that load FINISHES — whether the page moved a single pixel or
       * not. Without it, any unrelated re-render between the ask and the answer
       * (somebody else's message landing, say) would reach this branch first,
       * restore nothing, drop the anchor, and leave the real page to land with
       * nobody holding the reader's place — a whole page's jump under his eyes.
       *
       * WHAT IT IS NOT. This was once written up as the cause of the bug Vikas
       * reported in his own words — "the chat window doesn't auto-scroll to the
       * newest message on Enter" — with a story about the first `loadOlder` of a
       * room prepending nothing and stranding the anchor forever. That story was
       * put to the test and is FALSE, three times over: this effect's
       * dependencies include `messages`, and the store hands back a NEW array on
       * every `history` frame (`[...older, ...existing]`, store.ts) even when
       * `older` is empty, so the effect re-runs and the anchor is dropped either
       * way; `askForOlder` returns early once `hasMore` is false; and the first
       * `loadOlder` of a room is fired by the channel-open effect, not by
       * `askForOlder`, so it sets no anchor at all.
       *
       * The real cause of his complaint was in `useFollowToBottom` and is fixed
       * there — see `FOLLOW_SETTLES_MS`. This guard stays because it is right on
       * its own terms, not because it fixed that.
       */
      if (pageLoading) return;
      const still = el.querySelector<HTMLElement>(`.msg[data-msg="${CSS.escape(held.id)}"]`);
      if (still) el.scrollTop += still.getBoundingClientRect().top - held.top;
      anchor.current = null;
      return;
    }
    // 2. somebody asked to be taken to one particular message. That walk owns
    //    the view until it lands — following the newest message would be
    //    yanking the reader away from the thing they asked for.
    if (viewIsClaimed()) return;
    // 3. otherwise a new arrival follows a reader who is already at the bottom.
    if (atBottom.current) { follow("arrived"); caughtUp(); return; }
    /* 4. …and one that arrives while he has read back does NOT move him. That
       is the whole of the pill: instead of taking the view, the app says how
       many are down there and leaves the decision to him. Counted here rather
       than at the moment of arrival because this is the one place that already
       knows both facts — what the list holds, and where he is. */
    setNewBelow(n => {
      const next = newBelowCount(messages, seenNewest.current, meId);
      return n === next ? n : next;
    });
  }, [world.prepended, newest, messages.length, jumpTo, pageLoading,
    viewIsClaimed, atBottom, follow, caughtUp, messages, meId]);

  /**
   * "TAKE ME TO THE NEWEST" — the pill, and the only thing it does.
   *
   * His own act, so it owns the view outright: an older page still on its way,
   * or a walk to a search result, must not hold him away from the thing he just
   * asked for. It goes through the same one follow owner as every other move, so
   * it animates by the same rule and cannot fight it.
   */
  const goToNewest = useCallback(() => {
    anchor.current = null;
    atBottom.current = true;
    follow("caughtUp");
    caughtUp();
  }, [follow, caughtUp, atBottom]);

  /** he pressed Enter — see the note beside the box at the foot of this screen */
  const onSent = useCallback(() => {
    anchor.current = null;
    follow("sent");
    caughtUp();
  }, [follow, caughtUp]);

  /**
   * Take the reader to one message already on screen, and mark it.
   *
   * Used by the "answering…" line above an inline reply: the message it
   * answers is a few rows up in the same conversation, so this walks there
   * rather than opening anything. If it is further back than the loaded page,
   * nothing is claimed — a line that says it took you somewhere and did not
   * is worse than a line that does nothing.
   */
  const goToMessage = useCallback((id: ID) => {
    const el = streamRef.current?.querySelector(`[data-msg="${CSS.escape(id)}"]`);
    if (!el) { client.notify("that message is further back than this conversation goes"); return; }
    atBottom.current = false;
    el.scrollIntoView({ block: "center" });
    setLitUp(id);
    setTimeout(() => setLitUp(now => (now === id ? null : now)), 2600);
  }, [atBottom]);

  const onStreamScroll = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    noteScrolled();
    /* WALKING DOWN THERE HIMSELF IS THE SAME FACT as being taken there, and the
       pill has to know it: a count that survived him scrolling to the bottom
       would be a badge offering to take him where he already is. */
    if (atBottom.current) caughtUp();
    if (el.scrollTop < 160) askForOlder();
  }, [askForOlder, noteScrolled, atBottom, caughtUp]);

  /* ---- a search result asked for one particular message ----
   * If it is already loaded, go to it. If it is further back than we have
   * read, keep asking for older pages until it turns up or the relay says
   * there is nothing older. Bounded, so a message that cannot be found (it was
   * deleted between the search and the click) ends the walk instead of
   * spinning. */
  const walked = useRef(0);
  useEffect(() => {
    if (!jumpTo) { walked.current = 0; return; }
    const el = streamRef.current;
    if (!el) return;
    const target = el.querySelector(`[data-msg="${CSS.escape(jumpTo.id)}"]`);
    if (target) {
      anchor.current = null;
      atBottom.current = false;
      target.scrollIntoView({ block: "center" });
      setLitUp(jumpTo.id);
      walked.current = 0;
      onJumped();
      const t = setTimeout(() => setLitUp(null), 2600);
      return () => clearTimeout(t);
    }
    const p = client.page(channel.id);
    if (walked.current >= 12 || (p.asked && !p.hasMore)) {
      client.notify("that message is further back than this conversation goes");
      walked.current = 0;
      onJumped();
      return;
    }
    if (!p.loading) { walked.current += 1; askForOlder(); }
  }, [jumpTo, messages.length, page.loading, page.hasMore, channel.id, askForOlder, onJumped,
    atBottom]);

  const people = useMemo(() => onePerPerson(
    channel.memberIds.map(id => world.users.find(u => u.id === id)).filter(Boolean) as User[]),
    [channel.memberIds, world.users]);
  const agents = useMemo(() =>
    channel.memberIds.map(id => world.agents.find(a => a.id === id)).filter(Boolean) as AgentDef[],
    [channel.memberIds, world.agents]);

  const isDm = channel.kind === "dm";
  const peerUser = people.find(u => u.id !== world.me?.id);
  const peerAgent = world.agents.find(a => channel.memberIds.includes(a.id));
  const peerName = isDm ? peerUser?.name ?? peerAgent?.name ?? channel.name : null;

  const rows: Row[] = useMemo(() => {
    let markedUnread = false;
    return messages.map((m, i) => {
      const prev = messages[i - 1];
      const dayStart = i === 0 || !sameDay(prev.ts, m.ts);
      /* A continuation row means "the same person, still talking". A reply that
         belongs to a thread is not that — it is an answer to something further
         up — so it always keeps its own head and its "said in a thread" line. */
      const cont = !dayStart && !!prev && prev.authorKind === "human" && m.authorKind === "human"
        && prev.authorId === m.authorId && m.ts - prev.ts < 5 * 60 * 1000
        && !m.replyTo && !prev.replyTo;
      const ask = m.authorKind === "agent" && !m.proactive ? findAsk(messages, i, m) : undefined;
      const firstUnread = !markedUnread && openedAt > 0 && m.ts > openedAt && m.authorId !== world.me?.id;
      if (firstUnread) markedUnread = true;
      return { m, cont, dayStart, firstUnread, ask };
    });
  }, [messages, openedAt, world.me?.id]);

  /* ---- the three things every bubble needs, worked out ONCE for the list ----
   *
   * Each of these used to be worked out inside every bubble, off the whole
   * world, which is what made a bubble subscribe to the world in the first
   * place. They are here now, memoised, and handed down as values that stay
   * the same object between renders — which is the only reason `React.memo` on
   * the row does anything at all. */

  /** the message a reply is answering, looked up in the WHOLE conversation */
  const byId = useMemo(() => {
    const map = new Map<ID, Message>();
    for (const m of all) map.set(m.id, m);
    return map;
  }, [all]);

  /** who wrote it, when an agent did */
  const agentOf = useMemo(() => {
    const map = new Map<ID, AgentDef>();
    for (const a of world.agents) map.set(a.id, a);
    return map;
  }, [world.agents]);

  /** the finished job behind a "📦 Task done" message — see `doneRunIdsFor` */
  const doneRunIds = useMemo(
    () => doneRunIdsFor(messages, world.tasks), [messages, world.tasks]);

  /* Held still between renders, or every bubble redraws on every frame — see
     the contract on `MessageRow`. */
  const onInlineReply = useCallback((id: ID) => setReplyingTo(id), []);

  const working = useMemo(
    () => agents.filter(a => world.agentStatus[a.id] === "working"),
    [agents, world.agentStatus]);

  /**
   * The approvals that belong in THIS conversation.
   *
   * TWO WAYS AN APPROVAL KNOWS WHERE IT LIVES, and it used to only understand
   * one. A job-shaped approval is placed by its job's channel. A mid-run one
   * carries `channelId` itself, because an agent can be asked to push in
   * ordinary conversation with no job at all — matching only through the job
   * would have left every push request with nowhere to be drawn.
   *
   * `expired` is drawn as well as `pending`, deliberately. A request that ran
   * out while he was away must be something he FINDS, not something that
   * vanished: "he never saw it" is the outcome this card exists to make
   * visible. It is not counted below — nothing is waiting on him any more.
   */
  const { mine: myApprovalsAll, waiting: waitingAll } =
    useMyApprovals(world.approvals, world.me?.id);
  const inThisRoom = (ap: Approval): boolean => {
    if (ap.channelId) return ap.channelId === channel.id;
    const task = world.tasks.find(t => t.id === ap.taskId);
    return task?.channelId === channel.id;
  };
  const myApprovals = myApprovalsAll.filter(
    ap => (ap.status === "pending" || ap.status === "expired") && inThisRoom(ap));
  const waitingHere = waitingAll.filter(inThisRoom);

  /* The same fact as the sidebar row, from the same one place, so the rail and
     the conversation can never disagree about whether anyone is home. */
  const dmPresence = peerAgent ? presenceOf(world, peerAgent.id) : undefined;
  /* …and the same one owner decides whether what it should say instead is that
     this agent's job is stuck or fell over. */
  const dmSays = peerAgent ? presenceSays(world, peerAgent.id, dmPresence) : undefined;

  return (
    <div ref={roomRef} className="thread" aria-hidden={takeover ? "true" : undefined}>
      {isDm ? (
        <header className="topbar dm-head chathead">
          {peerAgent
            ? <AgentFace name={peerAgent.name} size={48} presence={dmPresence} hasPresence />
            : <PersonFace name={peerName ?? "?"} size={48} />}
          <div style={{ minWidth: 0 }}>
            <h2 className="ch-title"><span className="n">{peerName}</span></h2>
            <div className="role">
              {peerAgent ? roleOf(peerAgent.persona) : "Just the two of you — nothing here is posted to a channel"}
            </div>
            {/* A direct conversation with somebody else's agent is a direct
                conversation with that somebody: they can read it. */}
            {peerAgent && <AgentOwnerTag agent={peerAgent} place="conversation" />}
          </div>
          <div className="grow" />
          {peerAgent && (
            <span className="presencehere" data-presence={dmPresence?.presence ?? "unknown"}
              data-trouble={dmSays?.trouble ?? ""}>
              <span className={`pdot p-${dmPresence?.presence ?? "unknown"}`} aria-hidden="true" />
              <b>{dmSays!.word}</b>
              <span className="ph-why">{dmSays!.reason || NOT_YET_LOOKED}</span>
            </span>
          )}
          {peerAgent && (
            <span className="chip runchip" title={peerAgent.model ? undefined : MODEL_UNSET_HINT}>
              {PROVIDER_LABEL[(peerAgent.provider ?? "claude") as Provider]} · {modelWords(peerAgent.model)}
            </span>
          )}
          {peerAgent && peerAgent.ownerId === world.me?.id &&
            <button className="btn small" onClick={() => onEditAgent(peerAgent)}>Edit</button>}
        </header>
      ) : (
        <header className="topbar chathead">
          <h2 className="ch-title"><span className="h">#</span><span className="n">{channel.name}</span></h2>
          <span className="sub">
            {countOf(people.length, "person", "people")} ·{" "}
            {countOf(agents.length, "agent")}
          </span>
          {/* Open or shut, said where the room is named. A room that anyone in
              this Cloud9 can find and let themselves into is a different thing
              from one you were put in, and that must never be a guess. */}
          <RoomVisibility channel={channel} />
          {channel.topic && (
            <span className="ch-topic" title={`Topic: ${channel.topic}`}>{channel.topic}</span>
          )}
          <div className="grow" />
          {/* Counts what is genuinely WAITING. An expired card is still drawn
              below, but nothing is waiting on him for it any more. */}
          {waitingHere.length > 0 && (
            <button className="chip is-gold approvalpill" onClick={onOpenTasks}>
              <span className="dot wait" />
              {countOf(waitingHere.length, "approval")} waiting
            </button>
          )}
          {!channel.archivedAt && <AddToChannel channel={channel} />}
          <button className="btn small roomdetailsbtn" aria-expanded={detailsOpen}
            title="What this room is for, who is in it, and how it is run"
            onClick={onToggleDetails}>Room details</button>
        </header>
      )}

      {findOpen && (
        <div className="findbar" role="search">
          <span className="find-mark" aria-hidden="true">⌕</span>
          <input ref={findRef} className="find-input" type="text" value={find}
            placeholder={`Find in ${isDm ? "this conversation" : `#${channel.name}`}…`}
            aria-label="Find in conversation"
            onChange={e => setFind(e.target.value)}
            onKeyDown={e => { if (e.key === "Escape") onCloseFind(); }} />
          <span className="find-count">
            {needle
              ? countOf(messages.length, "message")
              : `${all.length} in this conversation`}
          </span>
          <button className="find-x" aria-label="Close find" onClick={onCloseFind}>✕</button>
        </div>
      )}

      <div className="msgs" ref={streamRef} onScroll={onStreamScroll}>
        {/* The top of the scrollback. `hasMore` is the ONLY honest end signal —
            a short page is not the end — so nothing here is said until the
            relay has answered at least once. */}
        {!needle && page.loading && (
          <div className="backtop" role="status">
            <span className="bars" aria-hidden="true"><i /><i /><i /><i /><i /></span>
            Fetching what was said before…
          </div>
        )}
        {!needle && page.asked && !page.hasMore && !page.loading && all.length > 0 && (
          <div className="backtop startofhistory">
            <span className="rule" aria-hidden="true" />
            That's the beginning of this conversation
            <span className="rule" aria-hidden="true" />
          </div>
        )}
        {needle && messages.length === 0 && (
          <div className="empty">
            <div className="empty-mark" aria-hidden="true">⌕</div>
            <h2>Nothing here says “{find.trim()}”</h2>
            <p>Try a shorter word, or close the find bar to see everything again.</p>
          </div>
        )}
        {!needle && messages.length === 0 && (
          <div className="empty">
            <div className="empty-mark" aria-hidden="true">{isDm ? "✉" : "#"}</div>
            <h2>{isDm ? `This is the start of your chat with ${peerName}` : `Nothing said in #${channel.name} yet`}</h2>
            <p>Type below to start it. Put <code>@</code> in front of an agent's name to hand it a job,
              add <code>!bg</code> when it should work in the background, and type <code>/</code> to
              see everything an agent can be asked to do.</p>
          </div>
        )}
        {rows.map(r => (
          <React.Fragment key={r.m.id}>
            {r.dayStart && (
              <div className="daymark"><span className="tag">{dayLabel(r.m.ts)}</span></div>
            )}
            {r.firstUnread && (
              <div className="newline" role="separator"><span className="rule" /><span className="tag">New</span></div>
            )}
            <MessageRow m={r.m} cont={r.cont} ask={r.ask}
              me={world.me} agents={world.agents} users={world.users}
              answered={r.m.replyTo ? byId.get(r.m.replyTo) : undefined}
              doneRunId={doneRunIds.get(r.m.id)}
              agent={agentOf.get(r.m.authorId)}
              working={world.agentStatus[r.m.authorId] === "working"}
              /* Reading an archived room still works all the way down: the
                 replies are still there to open, only writing is refused. */
              onOpenThread={onOpenThread}
              /* Inline mode: the reply button arms THIS conversation's box
                 instead of opening a panel that the setting says cannot exist. */
              onInlineReply={threading ? undefined : onInlineReply}
              onGoToMessage={goToMessage}
              archived={!!channel.archivedAt}
              inOpenThread={threadRoot === r.m.id || threadRoot === r.m.replyTo}
              /* WHICH THREADS HAVE MOVED, and which he has already looked at.
                 The same read marker the "New" separator above uses, so the
                 conversation and its threads answer "new since when" the same
                 way rather than each keeping its own idea of it. */
              newSince={openedAt}
              threadSeen={openedThreads.has(r.m.id)}
              litUp={litUp === r.m.id} />
          </React.Fragment>
        ))}

        {myApprovals.map(ap => (
          <ApprovalMoment key={ap.id} approval={ap}
            agent={world.agents.find(a => a.id === ap.agentId)}
            task={world.tasks.find(t => t.id === ap.taskId)}
            onOpenTasks={onOpenTasks} />
        ))}

        {working.map(a => (
          <div className="msg" key={a.id}>
            <AgentFace name={a.name} size={34} lamp="run" />
            <div className="body">
              <div className="who"><b>{a.name}</b><span className="badge">Agent</span><span className="t">now</span></div>
              <div className="thinking">
                <span className="bars" aria-hidden="true"><i /><i /><i /><i /><i /></span>
                {a.name} is working on it
                {/* ===== GAP C BLOCK (stopping a running turn, 2026-08-05) — start =====
                    THE STOP BUTTON, and it is here because this is the only place
                    on the screen that says something is running. A control for
                    stopping work that lives in a settings panel is a control
                    nobody finds while the thing is running.

                    IT TYPES THE SAME COMMAND HE COULD TYPE. "!stop" is the one
                    owner of stopping in the engine, and this button sends exactly
                    that message rather than inventing a second private route —
                    so the button and the typed command can never mean different
                    things, and stopping works identically from the phone. */}
                <button className="btn small ghost stopnow" data-stop-agent={a.id}
                  title={`Stop ${a.name} and spend nothing more on this`}
                  onClick={() => client.send({
                    type: "send", channelId: channel.id, text: `@${a.name} !stop`,
                  })}>Stop</button>
                {/* ===== GAP C BLOCK — end ===== */}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/**
        * "↓ N NEW MESSAGES" — what the app says INSTEAD of taking the view.
        *
        * A zero-height slot so this can never move the conversation as it comes
        * and goes: the pill floats over the foot of the list, and the list's own
        * height is untouched (which matters — a slot that grew would move the
        * bottom, and the follow rule watches for exactly that).
        *
        * It is only ever drawn for a number we are sure of (see
        * `newBelowCount`), and it says the number because a bare arrow makes him
        * guess whether it is worth the click.
        */}
      <div className="newpillslot">
        {newBelow > 0 && (
          <button className="newpill" data-new-messages={newBelow}
            title="Go to the newest message"
            onClick={goToNewest}>
            <span className="np-arrow" aria-hidden="true">↓</span>
            {countOf(newBelow, "new message")}
          </button>
        )}
      </div>

      {/* In inline mode the conversation's own box is what carries a reply, so
          it says which message it is answering and offers a way out of it. */}
      {/* SENDING IS NOT A MESSAGE ARRIVING. Nobody sends a message they do not
          want to see, so this takes the view down whatever the reader had
          scrolled back to — the one thing Vikas named, and the case the old rule
          had no branch for at all. It goes through the same owner as every other
          follow, so it animates by the same rule and cannot fight it.

          A SEND ALSO DROPS ANY CLAIM ON THE VIEW. An older page he asked for on
          the way down, or a walk to a search result, would otherwise put him
          back where he was a moment after his own message landed — which is the
          bug branch 1 above describes, arriving by a second road. */}
      <Composer channel={channel}
        onSent={onSent}
        replyTo={!threading && replyingTo ? replyingTo : undefined}
        answering={!threading && replyingTo
          ? all.find(m => m.id === replyingTo)
          : undefined}
        onStopAnswering={() => setReplyingTo(null)} />
    </div>
  );
}

/* ---- an approval NOBODY takes away from him --------------------------------
 *
 * A card used to run out of time: ten minutes after an agent asked, the hub
 * swept it away, and this screen counted down to it in seconds. All of that went
 * on 2026-08-07. A question put to the owner is not rubbish to be cleared up
 * while he thinks about it — the tools this app is a front end for ask and then
 * wait, and so does this. There is no countdown here any more because there is
 * nothing to count down to.
 *
 * A card stops being answerable for exactly two reasons now, and both have a
 * person behind them: he decided, or he pressed Stop.
 */

/**
 * Can this request still be answered?
 *
 * The one case left is a card written down BEFORE the sweep was removed, which
 * really was killed by the old clock and still says so on his disk. Nothing
 * creates a new one — see `ApprovalStatus` in @cloud9/shared.
 */
function approvalIsDead(approval: Approval): boolean {
  return approval.status === "expired";
}

/**
 * The sentence on an action card, in OWNER WORDS. The nouns still come only from
 * the hub's `approval.action` (counted facts, never the agent). The screen adds
 * nothing but the pending framing: a GitHub write is a request, so it reads
 * "wants to open an issue in …". The git push keeps its established wording.
 *
 * ONE OWNER for that framing, so the conversation card and the tray card cannot
 * drift apart.
 */
function actionHeadline(approval: Approval): string {
  if (approval.kind === "action" && isGitHubWriteKind(approval.remoteAction)) {
    return `wants to ${approval.action}`;
  }
  return approval.action;
}

/**
 * WHAT IS GENUINELY STILL WAITING ON THIS PERSON — one owner for the count.
 *
 * Three places count approvals: the badge on the rail, the gold pill above a
 * conversation, and the Tasks in-tray. They used to count `status === "pending"`
 * each in their own words, which was right until a card could run out of time:
 * a request past its deadline is still `pending` in the hub's database for the
 * moment before the hub's own timer fires, so the pill said "2 waiting" over two
 * cards that both read "nobody answered". A number that argues with the thing
 * underneath it is worse than no number.
 *
 * `mine` is everything of his the screen is holding; `waiting` is the subset
 * that can still be answered. Everything that counts, counts this.
 */
/* Takes the two facts it reads rather than the whole world, so a screen that
   has selected only a slice of the world can still ask it. */
function useMyApprovals(
  approvals: Approval[], meId: ID | undefined,
): { mine: Approval[]; waiting: Approval[] } {
  const mine = approvals.filter(a => a.ownerId === meId);
  return { mine, waiting: mine.filter(a => a.status === "pending" && !approvalIsDead(a)) };
}

/** The moment an agent stops and asks — the prototype's permission card. */
function ApprovalMoment({ approval, agent, task, onOpenTasks }: {
  approval: Approval; agent?: AgentDef; task?: Task; onOpenTasks: () => void;
}): React.JSX.Element {
  /* ABSENT MEANS `task` — every approval stored before mid-run asking existed
     is a job-shaped one, and treating a missing field as "action" would draw a
     branch-and-repository card for a job that has neither. */
  const action = approval.kind === "action";
  /* THE THIRD KIND OF THE SAME CARD (2026-08-05). "Show me the plan first"
     stops an agent one step EARLIER than an action card does: nothing has been
     done and nothing will be until he answers. It ticks down like an action
     card, because an agent is standing there waiting either way. */
  const plan = approval.kind === "plan";
  /* THE FOURTH KIND OF THE SAME CARD (2026-08-07). One agent looked at what
     the crew costs and wants to change ANOTHER agent's settings to spend less.
     It behaves like the other two because an agent is standing there waiting,
     and it is the same Approve/Not now — the difference is only what he is
     being asked about, and which agent it would touch. */
  const saving = approval.kind === "saving";
  const midRun = action || plan || saving;
  const dead = approvalIsDead(approval);

  const rows: [string, string][] = [];
  /* WHICH AGENT WOULD ACTUALLY CHANGE — the fact he most needs and the one the
     rest of the card cannot carry, because on every other kind the agent asking
     and the agent affected are the same one. On this kind they are usually not. */
  if (saving && approval.saving) rows.push(["Would change", approval.saving.aboutName]);
  if (agent) {
    rows.push(["Agent", `${agent.name} · ${PROVIDER_LABEL[(agent.provider ?? "claude") as Provider]} · ${modelWords(agent.model)}`]);
  }
  const rule = midRun ? null : ruleWords(agent);
  if (rule) rows.push(["Rule hit", rule]);
  rows.push(["Asked", clock(approval.createdAt)]);

  /* THE SENTENCE HE JUDGES, VERBATIM. On an action card every noun in
     `approval.action` — the branch, the repository, the number of commits —
     came from `git` and `gh` rather than from the agent, and that is the entire
     reason it can be trusted. It is not reworded, not shortened, and never
     swapped for a job title the agent chose. A job-shaped approval keeps the
     old behaviour: its title if it has one, its sentence if it does not. */
  /* A PLAN CARD LEADS WITH CLOUD9'S OWN LINE, not the agent's — `planHeadline`
     at the hub took it from the plan and bounded it, exactly as
     `describeRemoteAction` writes the line on an action card. The agent's own
     words appear below, as plain text, never as the sentence he judges by. */
  /* A SAVING CARD LEADS WITH CLOUD9'S OWN QUESTION, for the same reason a plan
     card does: `savingHeadline` at the hub built it from the CHANGE, which comes
     out of a closed vocabulary of two, so nothing the agent phrased can become
     the sentence he judges by. Its reasoning appears below, as plain text. */
  const headline = action ? actionHeadline(approval)
    : (plan || saving ? approval.action : (task?.title ?? approval.action));

  return (
    <div className="msg from-agent" data-approval={approval.id}
      data-kind={approval.kind ?? "task"} data-state={dead ? "expired" : approval.status}>
      {agent ? <AgentFace name={agent.name} size={34} lamp={dead ? "idle" : "wait"} /> : <PersonFace name="?" size={34} />}
      <div className="body">
        <div className="who">
          <b>{agent?.name ?? "An agent"}</b>
          <span className="badge">Agent</span>
          <span className="t">{clock(approval.createdAt)}</span>
          {dead
            ? <span className="chip"><span className="dot idle" />Nobody answered</span>
            : <span className="chip is-gold"><span className="dot wait" />Waiting on you</span>}
        </div>
        <p>
          {action
            ? "I've stopped before doing something outside this computer. Nothing has left it."
            : plan
              ? "Here's what I intend to do. I haven't started — nothing has been changed."
              : saving
                ? "I've been looking at what your agents cost you, and I think one of them "
                  + "is wasting money. I can't change it — only you can."
                : "I've stopped before doing this — it needs your go-ahead."}
        </p>
        <AnswerCard
          tone="approval"
          title={action
            ? "Permission to act outside this computer"
            : plan ? "What it intends to do"
              : saving ? "A way to spend less" : "Permission to act"}
          rows={rows}
          lead={
            <div className="spend">
              {/* The category comes from the shared REMOTE_ACTIONS table — the
                  same three rows the engine and the hub read — so the screen
                  cannot name a fourth kind of thing that does not exist. */}
              {action && approval.remoteAction && (
                <span className="eyebrow remoteact">{REMOTE_ACTIONS[approval.remoteAction]}</span>
              )}
              <span className="amt">{headline}</span>
              {/* Absent when we do not know. No "0 files". */}
              {approval.detail && <span className="apdetail">{approval.detail}</span>}
              {/* THE AGENT'S OWN WORDS, and the only place on any card where the
                  agent writes what he reads — see `Approval.plan`. The hub has
                  already bounded and stripped it (`tidyPlan`); it is rendered as
                  plain text inside its own block, so it can look like the plan
                  it is and never like another line of the card. */}
              {plan && approval.plan && (
                <pre className="planbody" data-plan={approval.id}>{approval.plan}</pre>
              )}
              {/* THE AGENT'S REASON, and the second place on any card where the
                  agent writes what he reads — see `Approval.saving`. The hub has
                  already bounded and stripped it (`tidySaving`); it is rendered
                  as plain text in the same block a plan uses, so it looks like
                  something an agent said and never like another line of the
                  card. His decision rests on the headline above it, which is
                  Cloud9's. */}
              {saving && approval.saving?.because && (
                <pre className="planbody" data-saving={approval.id}>{approval.saving.because}</pre>
              )}
              <span className="per">
                {dead ? "nothing happened"
                  : saving ? "nothing changes until you say so — and you can undo it any time"
                    : "nothing runs until you say so"}
              </span>
            </div>
          }
          actions={dead ? (
            <>
              <span className="expiredline" data-expired={approval.id}>
                Nobody answered in time — it didn't happen. Ask again and the agent will
                stop here once more.
              </span>
              {!midRun && <button className="btn ghost small" onClick={onOpenTasks}>See the job</button>}
            </>
          ) : (
            <>
              <button className="gold"
                onClick={() => client.send({ type: "decideApproval", approvalId: approval.id, decision: "approved" })}>
                Approve
              </button>
              <button className={midRun ? "btn" : "btn danger"}
                onClick={() => client.send({ type: "decideApproval", approvalId: approval.id, decision: "rejected" })}>
                {midRun ? "Not now" : "Reject"}
              </button>
              {/* Only a job-shaped approval HAS a job to look at. */}
              {approval.taskId && <button className="btn ghost small" onClick={onOpenTasks}>See the job</button>}
              <span className="eyebrow">Nothing has been changed yet</span>
            </>
          )}
        />
      </div>
    </div>
  );
}

/**
 * The same request, in the Tasks in-tray — smaller, and held to the same laws.
 *
 * ONE COMPONENT for "an approval in the side panel", so the sentence, the
 * detail line, the deadline and the expired wording cannot drift between the
 * conversation and the tray. The tray used to keep its own copy and it showed
 * neither the branch card's detail nor its deadline at all.
 */
function ApprovalTray({ approval, agent, task }: {
  approval: Approval; agent?: AgentDef; task?: Task;
}): React.JSX.Element {
  const action = approval.kind === "action";
  /* the same third and fourth kinds as in `ApprovalMoment` — one card, four shapes */
  const plan = approval.kind === "plan";
  const saving = approval.kind === "saving";
  const midRun = action || plan || saving;
  const dead = approvalIsDead(approval);
  const rule = midRun ? null : ruleWords(agent);
  const headline = action
    ? actionHeadline(approval)
    : (plan || saving ? approval.action : (task?.title ?? approval.action));

  return (
    <div className="approval" key={approval.id} data-appr={approval.id}
      data-kind={approval.kind ?? "task"} data-state={dead ? "expired" : approval.status}>
      <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 8 }}>
        {agent ? <AgentFace name={agent.name} size={30} lamp={dead ? "idle" : "wait"} /> : <PersonFace name="?" size={30} />}
        <div style={{ minWidth: 0 }}>
          {action && approval.remoteAction && (
            <span className="eyebrow remoteact">{REMOTE_ACTIONS[approval.remoteAction]}</span>
          )}
          <h4>{headline}</h4>
          <div className="meta">{agent?.name ?? "An agent"} · {clock(approval.createdAt)}</div>
        </div>
      </div>
      {/* On an action card the headline IS the sentence, so repeating it below
          would be the same words twice. A job-shaped one still needs it. */}
      {!midRun && <p className="ap-say">{approval.action}</p>}
      {/* WHICH AGENT WOULD ACTUALLY CHANGE. On every other kind of card the
          agent asking and the agent affected are the same one; on this kind they
          are usually not, and a card that does not say which would be asking him
          to agree to something about an agent he has not been told the name of. */}
      {saving && approval.saving && (
        <p className="meta" style={{ margin: "0 0 6px" }}>Would change: {approval.saving.aboutName}</p>
      )}
      {approval.detail && <p className="apdetail">{approval.detail}</p>}
      {/* the agent's own words, bounded at the hub — see `Approval.plan` */}
      {plan && approval.plan && (
        <pre className="planbody" data-plan={approval.id}>{approval.plan}</pre>
      )}
      {/* …and the same for a saving's reason — see `Approval.saving` */}
      {saving && approval.saving?.because && (
        <pre className="planbody" data-saving={approval.id}>{approval.saving.because}</pre>
      )}
      {rule && <p className="meta" style={{ margin: "0 0 10px" }}>Rule hit: {rule}</p>}
      {dead ? (
        <p className="expiredline" data-expired={approval.id}>
          Nobody answered in time — it didn't happen.
        </p>
      ) : (
        <div className="actions">
          <button className="gold small"
            onClick={() => client.send({ type: "decideApproval", approvalId: approval.id, decision: "approved" })}>Approve</button>
          <button className={midRun ? "btn small" : "btn small danger"}
            onClick={() => client.send({ type: "decideApproval", approvalId: approval.id, decision: "rejected" })}>
            {midRun ? "Not now" : "Reject"}
          </button>
        </div>
      )}
    </div>
  );
}

/** The six emoji offered on hover. The full set is still in the composer. */
const REACT_EMOJI = ["👍", "🎉", "🙏", "👀", "✅", "❤️"];

/* ---- the files that rode along with a message ----
 *
 * A ticket to fetch a file is minted AT THE CLICK and nowhere else: it is good
 * for thirty seconds and for one request, so one minted when a message scrolled
 * into view would be dead by the time anybody pressed it — and a screenful of
 * messages would mint more than the hub will hold. (§9.3.)
 *
 * A picture is shown where it sits; anything else is a named file to save.
 * Which is which is decided by `isInlineViewable` and `downloadContentType`,
 * the hub's OWN functions, so the app can never offer to draw something the hub
 * will not serve as a picture.
 */
function MessageFiles({ attachments }: { attachments: Attachment[] }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);

  /* THIS COPY IS SHOWING THESE FILES — one hold each, given back when it goes.
     The same message is drawn in more than one place at once (the conversation
     and an open thread), and this used to free the bytes on unmount: closing
     the thread panel revoked the `blob:` the room behind it was still drawing,
     and the picture broke. The store counts holders and frees only when the
     last copy lets go, so "who owns it" is no longer "who unmounted first". */
  const shownHere = useRef<ID[]>([]);
  shownHere.current = attachments.map(a => a.id);
  useEffect(() => {
    const mine = shownHere.current;
    for (const id of mine) client.holdFile(id);
    return () => { for (const id of mine) client.releaseFile(id); };
  }, []);

  return (
    <div className="attachments">
      {attachments.map(a => {
        const held = world.files[a.id];
        const picture = isInlineViewable(a.name) && downloadContentType(a.name).startsWith("image/");
        const showing = picture && held?.state === "ready" && !!held.url;
        return (
          <div className="fileblock" key={a.id} data-file={a.name} data-attachment={a.id}>
            <div className="filecard">
              <span className="glyph" aria-hidden="true">{fileKind(a.name)}</span>
              <span className="filenames">
                <span className="nm">{a.name}</span>
                <span className="meta">
                  {fileSize(a.size)} · {picture ? "picture" : "file"}
                </span>
              </span>
              <span className="act">
                {held?.state === "opening" ? (
                  <span className="eyebrow">Opening…</span>
                ) : showing ? (
                  <button className="btn small ghost filehide"
                    onClick={() => client.closeFile(a.id)}>Hide</button>
                ) : (
                  <button className="btn small fileopen"
                    onClick={() => { void (picture ? client.openFile(a) : client.saveFile(a)); }}>
                    {picture ? "Show" : "Save"}
                  </button>
                )}
              </span>
            </div>
            {/* A refusal here is almost always a ticket that was spent or timed
                out, and the whole recovery is asking for another one — so the
                person is offered the retry, never just told off. (§9.3.) */}
            {held?.state === "failed" && (
              <div className="filefail" role="status">
                <span className="problemtext">{plainError(held.error)}</span>
                <button className="linkish fileretry"
                  onClick={() => { client.closeFile(a.id); void (picture ? client.openFile(a) : client.saveFile(a)); }}>
                  Open it again
                </button>
              </div>
            )}
            {showing && (
              <div className="fileshot">
                <img src={held.url} alt={a.name} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ================= FILES AN AGENT MADE ================= */

/**
 * HOW MUCH OF A TEXT FILE IS DRAWN WHERE IT SITS.
 *
 * A shared file may be 10 MB, and 10 MB of words pasted into a conversation is
 * not a preview — it is the conversation gone. So a peek is a peek, it says
 * exactly how much of the file it is showing, and the whole thing is one click
 * away as a download.
 */
const PEEK_CHARS = 4000;

/**
 * ONE FILE AN AGENT MADE, drawn as a card — never as a path.
 *
 * This is the whole point of the artifact store on the screen side. Before it,
 * an agent that produced a file could only paste a Windows path into the chat,
 * and a path on this machine is not a file anybody else can open.
 *
 * WHAT IT DRAWS, and every one of them comes off the frame (`Artifact`,
 * `ArtifactVersion` in `@cloud9/shared`) rather than out of this file:
 *   • the name — the thing he clicks;
 *   • `describeArtifactVersion` — who made it, which version, its own note. The
 *     one owner of that line, so nothing here composes provenance itself;
 *   • the size, and whether it can be read as words at all — which is the HUB'S
 *     answer about the bytes, never a guess from the name;
 *   • the history, when there is more than one version: each one's number, who
 *     made it, when, and its own way in;
 *   • the run that produced it, when the version names one — that join is the
 *     entire reason attribution is stored per version.
 *
 * ABSENT MEANS ABSENT throughout: no note draws no note, version 1 draws no
 * "v1", no run draws no button.
 */
function ArtifactCard({ artifactId, version, place = "chat", historyOpen = false }: {
  artifactId: ID;
  /** the exact version a reference asked for; absent means the newest */
  version?: number;
  /** chat card, room list card, or the Files workspace detail — one behavior */
  place?: "chat" | "room" | "workspace";
  /**
   * Start with the retained history already unrolled.
   *
   * Only "search everywhere" asks for this, and only when the words it found
   * were inside an OLD version: landing on the card with the list rolled up
   * would put the reader one unexplained click away from the very row they
   * searched for. Every other caller leaves it shut, which is the default.
   */
  historyOpen?: boolean;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [showHistory, setShowHistory] = useState(historyOpen);
  const [showRun, setShowRun] = useState(false);
  /** which version's bytes are being looked at — a number, never a boolean */
  const [peeking, setPeeking] = useState<number | null>(null);

  /* Asked once, by id. A newer version arrives here by itself on an `artifact`
     frame, so there is nothing to poll and nothing to refresh. */
  useEffect(() => {
    if (place !== "workspace") client.askArtifact(artifactId);
  }, [artifactId, place]);

  const artifact = world.artifacts[artifactId];
  if (!artifact) {
    /* THE TWO HONEST STATES OF A CARD WITH NOTHING BEHIND IT YET. "It is not
       there" and "we have not looked" are different, and neither of them is an
       empty box. A file that is not yours to see gets the SAME sentence as one
       that never existed — the hub gives one answer to both on purpose, so an
       id cannot be probed by watching the screen. */
    return world.artifactsGone[artifactId] ? (
      <div className="artcard is-gone" data-artifact={artifactId} data-state="gone">
        <div className="artmain">
          <span className="glyph" aria-hidden="true">?</span>
          <span className="filenames">
            <span className="nm">That file isn't here</span>
            <span className="meta">
              It has been taken off this Cloud9, or it is in a conversation you are not in.
            </span>
          </span>
        </div>
      </div>
    ) : (
      <div className="artcard is-waiting" data-artifact={artifactId} data-state="looking">
        <div className="artmain">
          <span className="glyph" aria-hidden="true">…</span>
          <span className="filenames">
            <span className="nm">Looking for that file…</span>
            <span className="meta">Asking the hub what an agent shared here</span>
          </span>
        </div>
      </div>
    );
  }

  const newest = latestVersion(artifact)!;
  const asked = version === undefined ? newest : versionOf(artifact, version);
  /* A VERSION THAT IS NO LONGER KEPT IS NOT QUIETLY SWAPPED FOR THE NEWEST.
     Twenty versions are kept and the oldest bytes are deleted with their row,
     so a reference written last month can name bytes that are genuinely gone.
     He is told which one he asked for and which one is here — and the card then
     shows the newest, labelled as the newest, rather than nothing at all. */
  const pruned = version !== undefined && !asked;
  const shown = asked ?? newest;
  const held = world.files[shown.id];
  const peekingThis = peeking === shown.version;
  const otherVersions = artifact.versions.filter(v => v.version !== shown.version);
  const historyLabel = shown.version === newest.version ? "Earlier versions" : "Other retained versions";

  const open = (v: ArtifactVersion): void => {
    if (v.text) { setPeeking(v.version); void client.openArtifact(artifact, v); }
    else void client.saveArtifact(artifact, v);
  };

  return (
    <div className={`artcard place-${place}`} data-artifact={artifact.id}
      data-name={artifact.name} data-version={shown.version} data-state="here"
      data-versions={artifact.versions.length}>
      <div className="artmain">
        <span className="glyph" aria-hidden="true">{fileKind(artifact.name)}</span>
        <span className="filenames">
          <span className="nm artname">{artifact.name}</span>
          {/* THE ONE LINE, from the one owner of it. */}
          <span className="meta artby">{describeArtifactVersion(shown)}</span>
          <span className="meta artfacts">
            {fileSize(shown.size)} · {shown.text ? "text" : "a file to save"}
            {" · "}{dayStamp(shown.producedAt)} {clock(shown.producedAt)}
          </span>
        </span>
        <span className="act">
          {held?.state === "opening" ? (
            <span className="eyebrow">Opening…</span>
          ) : shown.text && peekingThis && held?.state === "ready" ? (
            <button className="btn small ghost arthide" onClick={() => {
              setPeeking(null); client.closeFile(shown.id);
            }}>Hide</button>
          ) : (
            <button className="btn small artopen" onClick={() => open(shown)}>
              {shown.text ? "Show it" : "Save it"}
            </button>
          )}
        </span>
      </div>

      {pruned && (
        <p className="artpruned" role="status">
          Version {version} isn't kept any more — Cloud9 keeps the last{" "}
          {countOf(ARTIFACT_LIMITS.versions, "version")} of a file. This is version{" "}
          {newest.version}, the newest one.
        </p>
      )}

      {/* A refusal is the HUB'S own sentence — "version 9 of notes.txt is no
          longer kept", "that link has expired" — and it comes with the way out
          rather than just the bad news. */}
      {held?.state === "failed" && (
        <div className="filefail" role="status">
          <span className="problemtext">{plainError(held.error)}</span>
          <button className="linkish artretry"
            onClick={() => { client.closeFile(shown.id); open(shown); }}>Try again</button>
        </div>
      )}

      {shown.text && peekingThis && held?.state === "ready" && held.text !== undefined && (
        <div className="artpeek">
          <pre>{held.text.slice(0, PEEK_CHARS)}</pre>
          {held.text.length > PEEK_CHARS && (
            <p className="hint artpeekmore">
              This is the first {PEEK_CHARS.toLocaleString()} characters of {fileSize(shown.size)}.
              {" "}
              <button className="linkish artsave"
                onClick={() => void client.saveArtifact(artifact, shown)}>Save the whole file</button>
            </p>
          )}
        </div>
      )}

      {/* THE HISTORY. One file with two authors in it is the entire reason this
          store exists — so who made each version, and when, is on the screen. */}
      {otherVersions.length > 0 && (
        <>
          <button className="runmore arthistory" aria-expanded={showHistory}
            data-older={otherVersions.length} onClick={() => setShowHistory(o => !o)}>
            <span className="tri" aria-hidden="true">{showHistory ? "▾" : "▸"}</span>
            {historyLabel}<span className="n">{countOf(otherVersions.length, "version")}</span>
          </button>
          {showHistory && (
            <ol className="artversions">
              {otherVersions.map(v => (
                <li key={v.id} className="artversion" data-version={v.version}>
                  <span className="vnum">v{v.version}</span>
                  <span className="vwho">
                    <b>{v.agentName}</b>
                    <span className="vwhen">{dayStamp(v.producedAt)} {clock(v.producedAt)}</span>
                    {v.note && <span className="vnote">{v.note}</span>}
                    <span className="vsize">{fileSize(v.size)}</span>
                  </span>
                  <span className="act">
                    {world.files[v.id]?.state === "opening"
                      ? <span className="eyebrow">Opening…</span>
                      : <button className="btn small artopen-old" onClick={() => {
                        if (v.text) { setPeeking(v.version); void client.openArtifact(artifact, v); }
                        else void client.saveArtifact(artifact, v);
                      }}>{v.text ? "Show it" : "Save it"}</button>}
                  </span>
                  {world.files[v.id]?.state === "failed" && (
                    <span className="filefail vfail" role="status">
                      <span className="problemtext">{plainError(world.files[v.id].error)}</span>
                    </span>
                  )}
                  {v.text && peeking === v.version && world.files[v.id]?.state === "ready"
                    && world.files[v.id].text !== undefined && (
                    <div className="artpeek">
                      <pre>{world.files[v.id].text!.slice(0, PEEK_CHARS)}</pre>
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </>
      )}

      {/* THE JOIN THE ATTRIBUTION EXISTS FOR: the turn that produced these bytes.
          Drawn only when the version names one — never a button that would ask
          about a run nobody recorded. */}
      {shown.runId && (
        <>
          <button className="runmore artrun" aria-expanded={showRun} data-run={shown.runId}
            onClick={() => setShowRun(o => !o)}>
            <span className="tri" aria-hidden="true">{showRun ? "▾" : "▸"}</span>
            The turn that made this
          </button>
          {showRun && <TaskRun runId={shown.runId} />}
        </>
      )}
    </div>
  );
}

/**
 * Every file named in one message, drawn as cards.
 *
 * The reference lives in the ORDINARY TEXT of a message — there is no new field
 * on `Message`, on purpose — so every place that already carries words carries
 * these for free: an agent's own answer, a job summary, and a sentence he types
 * back himself. `findArtifactRefs` is the one reader of that text.
 */
function MessageArtifacts({ text }: { text: string }): React.JSX.Element | null {
  const refs = useMemo(() => findArtifactRefs(text), [text]);
  if (refs.length === 0) return null;
  return (
    <div className="artifacts" data-artifacts={refs.length}>
      {refs.map(r => (
        <ArtifactCard key={artifactRef(r.artifactId, r.version)}
          artifactId={r.artifactId} version={r.version} />
      ))}
    </div>
  );
}

/**
 * THE WORDS WITHOUT THE REFERENCE.
 *
 * The card IS the file, so leaving `cloud9://artifact/af_…` in the sentence
 * beside it would be the pasted path this whole feature exists to kill — twice
 * over, once as machine text and once as a card. The reference stays in the
 * real message (copying it, editing it and searching it all see it); only the
 * drawing drops it.
 */
const withoutArtifactRefs = (text: string): string =>
  text.replace(/cloud9:\/\/artifact\/[A-Za-z0-9][A-Za-z0-9._-]*(@\d+)?/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * TURNING ONE ROOM DOWN — the per-room half of notifications.
 *
 * Cloud9's notification settings used to be all-or-nothing for the whole app,
 * so the one busy room was the reason to switch every notification off. This
 * mutes a single conversation, and it lives in that conversation's own details
 * panel because that is where a person looks for "this room" — Settings keeps
 * the switches that are true everywhere (the master switch and quiet hours).
 *
 * IT IS NOT A SECOND GATE. The mute list is a prefs field the shared
 * `decideNotification` reads (`isRoomMuted`, packages/shared/src/notify.ts);
 * this panel only writes it, through `withRoomMuted`, so a room can never end
 * up in the list twice and this screen never re-decides anything.
 *
 * What it says on screen is the whole truth: muting silences this room EXCEPT
 * somebody mentioning him by name, and if notifications are off everywhere it
 * says that too rather than implying this switch is doing anything.
 */
function RoomMute({ channel, isRoom }: { channel: Channel; isRoom: boolean }): React.JSX.Element {
  const p = usePrefs();
  const muted = isRoomMuted(p, channel.id);
  const what = isRoom ? "room" : "conversation";
  const toggle = (): void => {
    prefs.set({
      mutedChannelIds: withRoomMuted(prefs.get(), channel.id, !muted).mutedChannelIds,
    });
  };
  return (
    <div className="aside-sec roommute" data-muted={muted ? "yes" : "no"}>
      <span className="eyebrow">Notifications</span>
      <p className="roommute-state">
        {muted
          ? `Muted. Nothing from this ${what} interrupts you — except somebody mentioning you by name.`
          : `On. This ${what} can interrupt you, as your notification settings allow.`}
      </p>
      {!p.notify && (
        /* Honesty first: with the master switch off, this button changes nothing
           he would ever see. Saying so beats a switch that looks like it works. */
        <p className="roommute-note">
          Notifications are switched off everywhere in Settings, so nothing from any {what}
          {" "}interrupts you at the moment.
        </p>
      )}
      <button className="btn small roommute-btn" aria-pressed={muted} onClick={toggle}>
        {muted ? `Unmute this ${what}` : `Mute this ${what}`}
      </button>
    </div>
  );
}

/**
 * EVERY FILE AGENTS HAVE MADE IN ONE CONVERSATION.
 *
 * The card in a message is how he meets a file; this is how he finds one again
 * a week later without scrolling for it. Asked when the panel opens, and every
 * `artifact` frame that lands afterwards replaces the row with the same id.
 */
function RoomFiles({ channel }: { channel: Channel }): React.JSX.Element {
  useSyncExternalStore(client.subscribe, client.getSnapshot);
  useEffect(() => { client.askArtifacts(channel.id); }, [channel.id]);
  const { asked, list } = client.artifactsIn(channel.id);

  return (
    <div className="aside-sec roomfiles" data-files={list.length}>
      <span className="eyebrow">Files agents made</span>
      {!asked && list.length === 0 ? (
        <p className="sec-note" data-files-state="looking">Looking…</p>
      ) : list.length === 0 ? (
        /* ABSENT MEANS ABSENT: this only appears once the hub has answered, so
           it is never "there are none" said about a question nobody asked. */
        <p className="sec-note" data-files-state="empty">
          No agent has shared a file here yet. When one does, it appears in the
          conversation as a card — and again in this list.
        </p>
      ) : (
        <div className="roomfilelist" data-files-state="some">
          {list.map(a => <ArtifactCard key={a.id} artifactId={a.id} place="room" />)}
        </div>
      )}
      {list.length > 0 && (
        /* SAID RATHER THAN DRAWN. Nothing removes a shared file yet — there is no
           frame for it — so there is no bin here that could only ever fail.
           (`artifact-store-handoff.md` §8.3.) */
        <p className="sec-note filesnote">
          A file an agent shared stays in this room. Nothing can take one back yet.
        </p>
      )}
    </div>
  );
}

/**
 * ONE BUBBLE — and it reads NOTHING from the store.
 *
 * It used to subscribe to the whole world, which is why one arriving message
 * redrew every bubble on screen (151 of them with 150 loaded), and why an
 * agent's status tick — a fact no bubble draws — redrew them all as well.
 *
 * Everything it needs is now handed down by the one parent that already
 * computed it for the whole list, and the row is `React.memo`'d, so a redraw
 * happens only when one of THESE values really changed. Which makes the props
 * a contract worth keeping: each one must be a value the parent holds STILL
 * between renders (a message object out of the store, a boolean, a string) —
 * hand it a fresh object or a fresh arrow function per render and every bubble
 * is back to redrawing on every frame, silently.
 */
const MessageRow = React.memo(function MessageRow({
  m, cont, ask, me, agents, users, answered, doneRunId,
  agent, working, onOpenThread, onInlineReply, onGoToMessage,
  inOpenThread, litUp, variant, archived, newSince, threadSeen,
}: {
  /** the message itself, straight out of the store — never a copy */
  m: Message;
  /** the same person, still talking: drawn without a fresh head */
  cont?: boolean;
  /** what this agent answer was asked by, for the run strip */
  ask?: Message;
  /** who is reading — for "is this mine", and which reactions are mine */
  me?: User;
  agents: AgentDef[];
  users: User[];
  /**
   * The message this one answers, already looked up by the parent out of the
   * WHOLE conversation (a thread reply's parent is often not on screen).
   */
  answered?: Message;
  /** the finished job behind a "📦 Task done" message, matched by the parent */
  doneRunId?: string;
  agent?: AgentDef; working?: boolean;
  /** the read marker this conversation was opened on — 0/absent means "unknown,
   *  so claim nothing". Only used to say whether a thread has moved since. */
  newSince?: number;
  /** he has already opened this message's thread in this visit */
  threadSeen?: boolean;
  /** threads are on: replying opens one, and the reply count opens it again */
  onOpenThread?: (rootId: ID) => void;
  /** threads are off: replying arms the conversation's own box instead */
  onInlineReply?: (messageId: ID) => void;
  /** walk to another message in this same conversation */
  onGoToMessage?: (messageId: ID) => void;
  inOpenThread?: boolean;
  litUp?: boolean;
  /** "thread" drops the affordances that would open a thread inside a thread */
  variant?: "channel" | "thread";
  /** an archived room is readable and nothing more — no reacting, no editing */
  archived?: boolean;
}): React.JSX.Element {
  countRender("MessageRow");
  const isAgent = m.authorKind === "agent";
  const [copied, setCopied] = useState(false);
  const [pickEmoji, setPickEmoji] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.text);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleted = !!m.deletedAt;
  const inThread = variant === "thread";

  const copy = () => {
    void navigator.clipboard?.writeText(m.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => setCopied(false));
  };

  /**
   * May I change these words?
   *
   * My own message, or one written by an agent I own — an agent's words are
   * its owner's words, spent on the owner's account. The relay refuses either
   * way; this only decides whether to draw a button, never what is allowed.
   */
  const mine = !!me && (isAgent
    ? agents.find(a => a.id === m.authorId)?.ownerId === me.id
    : m.authorId === me.id);

  const nameFor = (id: ID): string =>
    id === me?.id ? "You"
      : users.find(u => u.id === id)?.name
      ?? agents.find(a => a.id === id)?.name
      ?? "Someone";

  const react = (emoji: string, on: boolean) => {
    client.send({ type: "react", messageId: m.id, emoji, on });
    setPickEmoji(false);
  };

  const saveEdit = () => {
    const next = draft.trim();
    setEditing(false);
    if (!next || next === m.text) return;
    client.send({ type: "editMessage", messageId: m.id, text: next });
  };

  /**
   * Someone @-named an agent that will not answer them.
   *
   * The relay filters that agent's id out of `mentions` and stays silent, which
   * from the outside looks exactly like a broken app. So: if the words hold an
   * @name, the agent exists, and its id is NOT in the published mentions, say
   * plainly why nothing happened.
   */
  const refusedMentions = useMemo(() => {
    if (isAgent || deleted || !me) return [];
    const named = agents.filter(a =>
      new RegExp(`@${a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(m.text));
    return named
      .filter(a => !(m.mentions ?? []).includes(a.id) && !mayDriveAgent(m.authorId, a))
      .map(a => ({
        agent: a,
        owner: users.find(u => u.id === a.ownerId)?.name ?? "its owner",
      }));
  }, [m.text, m.mentions, m.authorId, agents, users, isAgent, deleted, me]);

  /* Rendered under EVERY shape of a message. A second message from the same
     person a minute later is drawn as a continuation row, and a hint that
     disappeared because you happened to speak twice in a row would be worse
     than no hint at all. */
  const refusedNotes = refusedMentions.map(({ agent: a, owner }) => (
    <div className="mentionrefused" key={a.id} data-agent={a.name}>
      {a.name} only answers {owner}, so it hasn't been asked.
    </div>
  ));

  const reactions = (m.reactions ?? []).filter(r => r.userIds.length > 0);
  const reactionRow = (!deleted && reactions.length > 0) && (
    <div className="reactions">
      {reactions.map(r => {
        const isMine = !!me && r.userIds.includes(me.id);
        return (
          <button key={r.emoji} className={`reactpill${isMine ? " on" : ""}`}
            data-emoji={r.emoji} aria-pressed={isMine} disabled={archived}
            title={archived
              ? ARCHIVED_SENTENCE
              : `${r.userIds.map(nameFor).join(", ")} reacted with ${r.emoji}`}
            onClick={() => react(r.emoji, !isMine)}>
            <span className="e">{r.emoji}</span><span className="n">{r.userIds.length}</span>
          </button>
        );
      })}
    </div>
  );

  /**
   * WHAT THIS MESSAGE IS ANSWERING — drawn above it, both ways round.
   *
   * With threads on, a reply is normally not in the conversation at all; the
   * only ones that are, are the one a search jumped to, and this line takes
   * the reader to the thread it belongs to.
   *
   * With threads off, every reply is in the conversation and needs to say what
   * it is answering, or "keep it in the conversation" is just an unreadable
   * pile. So it quotes the message above it and walks there when clicked.
   */
  const answeringLine = (!inThread && m.replyTo && !deleted) && (
    onOpenThread
      ? (
        <button className="inthreadmark" onClick={() => onOpenThread(m.replyTo!)}>
          ↳ said in a thread — open it
        </button>
      )
      : onGoToMessage
        ? (
          <button className="answeringmark" onClick={() => onGoToMessage(m.replyTo!)}
            title="Go to the message this answers">
            <span className="arrow" aria-hidden="true">↳</span>
            <span className="who2">
              {answered ? `Answering ${answered.authorName}` : "Answering a message above"}
            </span>
            {answered && !answered.deletedAt && (
              <span className="quoted">{quoteOf(answered.text)}</span>
            )}
          </button>
        )
        : null
  );

  const replyCount = m.replyCount ?? 0;
  /**
   * HAS THIS THREAD MOVED SINCE HE LAST READ THIS ROOM?
   *
   * The room row can say "something new is in a thread"; this is the other half
   * — WHICH thread — so he is not left opening every reply count in the room to
   * find the one that changed. Both halves are computed from what this client
   * already holds: the root's cached `lastReplyAt` against the read marker the
   * conversation was opened on. No new hub field.
   *
   * It stands down the moment he opens the thread (`threadSeen`), because at
   * that point he HAS seen it and a mark that will not go away is a mark he
   * learns to ignore.
   *
   * Honest limit, worth knowing before believing this mark: reading the room
   * marks everything in it read, replies included, so the mark lasts the VISIT.
   * A thread that moved while he was away and that he never opened is new again
   * next time only until the room is marked read. Making it survive that would
   * need a per-thread read marker on the hub, which is the hub's to own — see
   * the report; this deliberately stops at what the client can know.
   */
  const threadMoved = !inThread && !deleted && replyCount > 0
    && !threadSeen && !!newSince && (m.lastReplyAt ?? 0) > newSince;
  const threadLine = (!inThread && !deleted && replyCount > 0 && onOpenThread) && (
    <button className={`threadline${threadMoved ? " has-new" : ""}`} data-replies={replyCount}
      data-thread-new={threadMoved ? "yes" : undefined}
      title={threadMoved
        ? "This thread has moved since you last read this conversation"
        : "Open this thread"}
      onClick={() => onOpenThread(m.id)}>
      <span className="arrow" aria-hidden="true">↳</span>
      {countOf(replyCount, "reply", "replies")}
      {threadMoved && <span className="newtag">New</span>}
      {m.lastReplyAt ? <span className="ago">· last at {clock(m.lastReplyAt)}</span> : null}
    </button>
  );

  // Every message body goes through here, so formatting is a property of "a
  // message" rather than something each call site remembers. Markdown renders
  // to React elements only — never to HTML — so a `<script>` in a message is
  // the word "<script>". @mentions are still highlighted, inside the markdown.
  const paragraph = (text: string, key?: React.Key) => (
    <Markdown key={key} text={text} />
  );

  /* THE FILE, NOT THE PATH. A reference in the words is drawn as a card below,
     so the reference itself comes OUT of the sentence — otherwise he would be
     shown the machine text this whole feature exists to replace, sitting right
     beside the card that replaces it. Nothing else reads `drawn`: copying,
     editing and searching all still see the real message. */
  const artifactRefs = useMemo(() => findArtifactRefs(m.text), [m.text]);
  const drawn = artifactRefs.length > 0 ? withoutArtifactRefs(m.text) : m.text;

  /* A tombstone has no actions: there is nothing left to react to, copy, edit
     or reply to, and a button that always errors is a dead click. */
  /* Nothing new can be put into an archived room — reacting, editing, deleting
     and replying all answer the same refusal — so none of those buttons are
     drawn. The relay is still the gate; this only stops a dead click. */
  const actions = deleted || archived ? null : confirmDelete ? (
    <div className="msgactions confirming">
      <span className="ma-say">Take this back?</span>
      <button className="ma yes" title="Yes, take it back"
        onClick={() => { setConfirmDelete(false); client.send({ type: "deleteMessage", messageId: m.id }); }}>
        Yes
      </button>
      <button className="ma" title="Keep it" onClick={() => setConfirmDelete(false)}>Keep</button>
    </div>
  ) : (
    <div className="msgactions">
      <button className="ma react" title="React to this" aria-expanded={pickEmoji}
        onClick={() => setPickEmoji(o => !o)}>☺</button>
      {/* THE WAY IN. It used to be a bare ↳ among five other glyphs, so the
          only door to a thread was an unlabelled icon that appears on hover —
          which is a fair description of a feature nobody can find. It carries
          the word now, and it says which of the two things it will do. */}
      {!inThread && (onOpenThread || onInlineReply) && (
        <button className="ma reply"
          title={onOpenThread ? "Reply in a thread on this message" : "Reply to this, here in the conversation"}
          onClick={() => onOpenThread
            ? onOpenThread(m.replyTo ?? m.id)
            : onInlineReply!(m.id)}>
          <span className="arrow" aria-hidden="true">↳</span>Reply
        </button>
      )}
      <button className="ma" title={`Write back to ${m.authorName}`}
        onClick={() => composerInsert?.(`@${m.authorName} `)}>↩</button>
      <button className="ma" title="Copy this message" onClick={copy}>{copied ? "✓" : "⧉"}</button>
      {mine && (
        <button className="ma edit" title="Change what this says"
          onClick={() => { setDraft(m.text); setEditing(true); }}>✎</button>
      )}
      {mine && (
        <button className="ma del" title="Take this message back"
          onClick={() => setConfirmDelete(true)}>🗑</button>
      )}
      {pickEmoji && (
        <div className="reactpop" role="menu">
          {REACT_EMOJI.map(e => {
            const isMine = !!me
              && (m.reactions ?? []).some(r => r.emoji === e && r.userIds.includes(me.id));
            return (
              <button key={e} aria-pressed={isMine} onClick={() => react(e, !isMine)}>{e}</button>
            );
          })}
        </div>
      )}
    </div>
  );

  const editor = (
    <div className="editmsg">
      <textarea className="editmsg-input" value={draft} autoFocus rows={2}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={e => {
          if (e.key === "Escape") { setEditing(false); setDraft(m.text); }
          if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); }
        }} />
      <div className="editmsg-btns">
        <button className="primary small editmsg-save" onClick={saveEdit}>Save the change</button>
        <button className="btn small ghost" onClick={() => { setEditing(false); setDraft(m.text); }}>
          Cancel
        </button>
        <span className="eyebrow">Everyone sees it was changed</span>
      </div>
    </div>
  );

  /** What is left of a message that was taken back. A row, never a hole. */
  const tombstone = (
    <p className="tombstone">
      <span className="mark" aria-hidden="true">⌀</span>
      {m.authorName} took this message back
    </p>
  );

  if (cont) {
    return (
      <article className={`msg cont${deleted ? " deleted" : ""}${litUp ? " litup" : ""}`}
        data-msg={m.id}>
        <div className="when-gutter">{clock(m.ts)}</div>
        <div className="body">
          {deleted ? tombstone : editing ? editor : drawn ? paragraph(drawn) : null}
          {!deleted && !editing && <MessageArtifacts text={m.text} />}
          {!deleted && doneRunId && <TaskRun runId={doneRunId} />}
          {!deleted && m.attachments && m.attachments.length > 0 &&
            <MessageFiles attachments={m.attachments} />}
          {!deleted && m.editedAt && <span className="editedmark">edited</span>}
          {refusedNotes}
          {reactionRow}
          {!deleted && <AgentReceipts messageId={m.id} agents={agents} />}
          {/* the steps arriving while the turn runs — drawn on the message that
              ASKED, which is where the 👀 already is, and gone when it ends */}
          {!deleted && <LiveWork messageId={m.id} agents={agents} />}
          {threadLine}
        </div>
        {actions}
      </article>
    );
  }

  /* RUN STRIP — only the facts the app actually holds. */
  const strip: React.ReactNode[] = [];
  if (isAgent) {
    if (ask) strip.push(<span key="ask">asked by <b>@{ask.authorName}</b></span>);
    if (ask && m.ts >= ask.ts) strip.push(<span key="took">{elapsed(m.ts - ask.ts)} to answer</span>);
    if (agent) {
      const provider = (agent.provider ?? "claude") as Provider;
      strip.push(
        <span key="prov" title={agent.model ? undefined : MODEL_UNSET_HINT}>
          runs on {PROVIDER_LABEL[provider] ?? "Claude"} · {modelWords(agent.model)}
        </span>,
      );
    }
  }

  const shape = isAgent ? parseAnswer(drawn) : { lead: [], tail: [], card: undefined };

  const body = shape.card
    ? (
      <div className="answer">
        {shape.lead.map((l, i) => paragraph(l, `lead-${i}`))}
        <AnswerCard
          title={shape.card.title}
          rows={shape.card.rows}
          tone={m.proactive ? "proactive" : "answer"}
          actions={<>
            <button className="btn small" onClick={() => composerInsert?.(`@${m.authorName} `)}>
              Write back to {m.authorName}
            </button>
            <button className="btn small" onClick={copy}>{copied ? "Copied" : "Copy the answer"}</button>
          </>}
        />
        {shape.tail.map((l, i) => paragraph(l, `tail-${i}`))}
      </div>
    )
    : isAgent
      ? <div className="answer">{drawn ? paragraph(drawn) : null}</div>
      : drawn ? paragraph(drawn) : null;

  return (
    <article data-msg={m.id}
      className={`msg ${isAgent ? "from-agent" : ""} ${m.proactive ? "proactive" : ""}`
        + `${deleted ? " deleted" : ""}${litUp ? " litup" : ""}${inOpenThread ? " inthread" : ""}`}>
      {isAgent
        ? <AgentFace name={m.authorName} size={34} lamp={working ? "run" : "live"} />
        : <PersonFace name={m.authorName} size={34} />}
      <div className="body">
        <div className="who">
          <b>{m.authorName}</b>
          {isAgent && <span className="badge">Agent</span>}
          <span className="t">{clock(m.ts)}</span>
          {!deleted && m.editedAt && <span className="editedmark">edited</span>}
          {m.proactive && <span className="chip is-ultra selfstart">Nobody asked — I noticed</span>}
        </div>
        {answeringLine}
        {strip.length > 0 && !deleted && (
          <div className="runstrip">
            {strip.map((node, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="sep" />}
                {node}
              </React.Fragment>
            ))}
          </div>
        )}
        {deleted ? tombstone : editing ? editor : body}
        {!deleted && !editing && <MessageArtifacts text={m.text} />}
        {!deleted && doneRunId && <TaskRun runId={doneRunId} />}
        {!deleted && m.attachments && m.attachments.length > 0 &&
          <MessageFiles attachments={m.attachments} />}
        {refusedNotes}
        {reactionRow}
        {!deleted && <AgentReceipts messageId={m.id} agents={agents} />}
        {/* same, on a full message — see the note on the continuation above */}
        {!deleted && <LiveWork messageId={m.id} agents={agents} />}
        {threadLine}
      </div>
      {actions}
    </article>
  );
});

/* ---- one thread, in the right-hand rail ---- */

function ThreadPanel({ channel, rootId, onClose, takeover, forced, onToggleTakeover }: {
  channel: Channel; rootId: ID; onClose: () => void;
  /** the thread is over the room rather than beside it */
  takeover: boolean;
  /** ...and it is there because the WINDOW is too narrow to split, not because
      he asked. At that size the way back is drawn as a back arrow, which is
      what Buzz draws, and the ✕ goes — two controls doing the same thing on a
      small screen is how a way out gets missed. */
  forced: boolean;
  onToggleTakeover: () => void;
}): React.JSX.Element {
  const panelRef = useRef<HTMLElement>(null);
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const held = world.threads[rootId];
  // the root may also be on screen in the conversation behind this panel
  const fromChannel = (world.messages[channel.id] ?? []).find(m => m.id === rootId);
  const messages = held ?? (fromChannel ? [fromChannel] : []);
  const root = messages[0];
  const replies = messages.slice(1);

  /* One lookup for the panel instead of one per reply — the same reason the
     conversation's own list builds these maps once (see `agentOf` there). */
  const agentOf = useMemo(() => {
    const map = new Map<ID, AgentDef>();
    for (const a of world.agents) map.set(a.id, a);
    return map;
  }, [world.agents]);
  /* A "📦 Task done" reply shows its run card inside a thread too — the same
     match the conversation makes, made here, so moving the work out of the
     bubble did not quietly take the card away from this panel. */
  const doneRunIds = useMemo(
    () => doneRunIdsFor(messages, world.tasks), [messages, world.tasks]);

  /* THE SAME OWNER AS THE ROOM'S OWN LIST, not a second answer to the same
     question. A thread is a conversation too: a reply typed here, and a reply
     arriving here while he is at the foot of it, both follow. Nothing else ever
     claims this view — there is no walking back through pages in a thread — so
     the claim is honestly `false` rather than a guard copied from next door. */
  const bodyRef = useRef<HTMLDivElement>(null);
  const neverClaimed = useCallback(() => false, []);
  const { follow, atBottom, noteScrolled } = useFollowToBottom(bodyRef, neverClaimed);
  React.useLayoutEffect(() => {
    if (atBottom.current) follow("arrived");
  }, [messages.length, follow, atBottom]);
  useEffect(() => {
    if (!takeover) return;
    const first = panelRef.current?.querySelector<HTMLElement>(
      "button, textarea, input, select, [tabindex]:not([tabindex='-1'])");
    first?.focus();
  }, [takeover]);

  return (
    <aside ref={panelRef} className={`aside threadpanel${takeover ? " takeover" : ""}${forced ? " forced" : ""}`}
      aria-label="Thread">
      <div className="threadhead">
        {/* THE WAY BACK, when the thread is over the room. At a narrow window
            it is a back arrow — Buzz's own drawing — and it says Buzz's own
            words for anyone who cannot see it. */}
        {takeover && (
          <button className="iconbtn threadmode" aria-label={BESIDE_LABEL}
            title={forced ? "Back to the room" : "Show thread beside channel"}
            onClick={onToggleTakeover}>{forced ? "←" : "⇥"}</button>
        )}
        <span className="eyebrow">Thread</span>
        <div className="grow" />
        {!takeover && (
          <button className="iconbtn threadmode" aria-label={EXPAND_LABEL}
            title="Expand thread — let it take over the room"
            onClick={onToggleTakeover}>⤢</button>
        )}
        {!forced && (
          <button className="iconbtn threadclose" aria-label="Close the thread" onClick={onClose}>✕</button>
        )}
      </div>
      <div className="threadbody" ref={bodyRef} onScroll={noteScrolled}>
        {!root && <div className="d-empty">Fetching this thread…</div>}
        {root && (
          <MessageRow m={root} variant="thread" archived={!!channel.archivedAt}
            me={world.me} agents={world.agents} users={world.users}
            doneRunId={doneRunIds.get(root.id)}
            agent={agentOf.get(root.authorId)} />
        )}
        {root && (
          <div className="threadcount">
            {replies.length === 0
              ? "No replies yet — yours would be the first."
              : countOf(replies.length, "reply", "replies")}
          </div>
        )}
        {replies.map(m => (
          <MessageRow key={m.id} m={m} variant="thread" archived={!!channel.archivedAt}
            me={world.me} agents={world.agents} users={world.users}
            doneRunId={doneRunIds.get(m.id)}
            agent={agentOf.get(m.authorId)}
            working={world.agentStatus[m.authorId] === "working"} />
        ))}
      </div>
      <Composer channel={channel} replyTo={rootId} onSent={() => follow("sent")} />
    </aside>
  );
}

/**
 * LETTING SOMEBODY IN — offered only to the people who can actually do it.
 *
 * `addMembers` used to be on the any-member gate, and a plain member could hand
 * a private room's whole scrollback to anybody. It is admin-or-owner now, so
 * the control follows the same rule: a button whose only possible outcome is a
 * refusal is worse than no button at all. The relay is still the gate (§8) —
 * nothing here widens anything, it only stops a click that would be refused.
 *
 * A DIRECT CONVERSATION HAS NO CONTROL AT ALL, for anybody, including the
 * owner. Two people is what a direct conversation IS; the way to include a
 * third is to start a room.
 */
function AddToChannel({ channel }: { channel: Channel }): React.JSX.Element | null {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const isRoom = channel.kind !== "dm";
  /* The rows are what carry the role — `memberIds` answers "who is in here"
     and nothing else. Asked here as well as in the panel, because the header
     is drawn whether or not the panel is open. */
  /* Re-asked whenever the room's membership changes, not only when it opens:
     the rows are what decide whether this control is drawn at all, and a stale
     copy would offer — or withhold — the control on last week's answer. */
  const roster = channel.memberIds.join(",");
  useEffect(() => { if (isRoom) client.askMembers(channel.id); }, [channel.id, isRoom, roster]);

  if (!isRoom || channel.archivedAt) return null;
  const rows = (world.members[channel.id] ?? []).filter(m => !m.removedAt);
  const myRole = rows.find(m => m.memberId === world.me?.id)?.role;
  /* Until the rows have arrived the answer is "we don't know yet", and an
     unknown must not be drawn as a yes. */
  if (!mayAdministerChannel(myRole)) return null;

  const inRoom = (id: ID): boolean => rows.some(m => m.memberId === id);
  /* An agent whose owner is not in the room WILL be refused by the hub, and
     being refused after clicking is a worse way to learn it. It is still shown,
     greyed and with the reason, because hiding it invites the same click again
     tomorrow. */
  const agents = world.agents
    .filter(a => !inRoom(a.id))
    .map(a => {
      const own = ownershipOf(a, world);
      const ownerHere = a.ownerId === world.me?.id || inRoom(a.ownerId);
      return {
        id: a.id,
        label: ownerHere
          ? `${a.emoji} ${a.name} — ${own.whose}, so ${own.mine ? "you" : own.name} can read it`
          : `${a.emoji} ${a.name} — ${own.name} isn't in this room`,
        why: ownerHere ? "" : `${own.name} isn't in this room`,
        blocked: !ownerHere,
      };
    });
  const people = onePerPerson(world.users)
    .filter(u => !inRoom(u.id))
    .map(u => ({ id: u.id, label: u.name, why: "", blocked: false }));
  if (agents.length === 0 && people.length === 0) return null;

  const option = (c: { id: ID; label: string; why: string; blocked: boolean }) => (
    <option key={c.id} value={c.id} disabled={c.blocked}
      data-add={c.id} data-blocked={c.blocked ? "yes" : "no"} data-why={c.why || undefined}>
      {c.label}
    </option>
  );

  return (
    <select className="addmember"
      aria-label="Add someone to this room"
      value=""
      onChange={e => { if (e.target.value) client.send({ type: "addMembers", channelId: channel.id, memberIds: [e.target.value] }); }}
    >
      <option value="">Add someone…</option>
      {people.length > 0 && <optgroup label="People">{people.map(option)}</optgroup>}
      {agents.length > 0 && (
        <optgroup label="Agents — their owner reads this room">{agents.map(option)}</optgroup>
      )}
    </select>
  );
}

const QUICK_EMOJI = ["👍", "🙏", "🎉", "🔥", "✅", "❌", "😀", "😅", "🤔", "👀", "🚀", "☁️", "📌", "⏰", "💡", "❤️"];

/* ============== ONE WAY IN FOR EVERY TYPED COMMAND ==============
 *
 * THE BUG THIS FIXES. Everything an agent can be TOLD to do — open a GitHub
 * issue, ask for a review, comment on a pull request, take a coding job, keep a
 * note, hand work to another agent, set a repeating job — was already built and
 * already worked. None of it was on the screen. The only way to reach any of it
 * was to already know the words, so the honest report from the owner was
 * "GitHub integration is not there". Invisible is the same as absent.
 *
 * THE CLASS FIX, not a button per command. There is ONE table below and ONE
 * control beside the box. A command added to the engine tomorrow is ONE ROW
 * here — never a new menu, a new popover, or a new send path.
 *
 * IT WRITES INTO THE BOX HE ALREADY USES. Picking a row does not send anything
 * and does not talk to the hub. It puts the line in the composer with the parts
 * he has to fill in selected, and he reads it, edits it and presses Send like
 * any other message. A second way to send is a second set of rules about what
 * gets sent, and that is exactly the kind of split this app keeps out.
 *
 * SOURCE OF TRUTH: `packages/engine/src/engine.ts`. The engine's own regular
 * expressions decide what a command IS — `considerReplies`,
 * `parseGitHubWriteCommand` and `handleScheduleCommand`. This table cannot be
 * derived from them without rewriting the engine's parser, and the engine is a
 * Node package the browser bundle must not import. So the two lists are kept
 * honest by a TEST instead of by hope:
 * `apps/desktop/electron/roomcommands.test.cjs` reads both files and fails if
 * the engine parses a command this menu does not offer, or the other way round.
 *
 * WHAT A ROW MAY NOT DO IS PRETEND. A command that cannot work in this room —
 * no agent in it, only one agent when two are needed, no repository connected —
 * says so on the row, in plain words, and cannot be picked. Silently offering a
 * line that will come back with a refusal is the invisibility bug again with
 * extra steps.
 */

/** What a command needs before it can do anything in THIS room. */
type CommandNeed = "agent" | "twoAgents" | "repo";

interface RoomCommand {
  /** the word the engine parses, exactly — see engine.ts */
  cmd: string;
  /** other spellings the engine accepts for the same thing */
  aliases?: string[];
  /** what it does, in his words, never the command's */
  label: string;
  /** ONE line: what will happen, and who is asked first */
  say: string;
  /** the line written into the box; `<…>` marks the part he fills in */
  line: (who: { first: string; second: string }) => string;
  needs: CommandNeed[];
}

/**
 * EVERY typed command the engine understands, in the order he is likeliest to
 * want them. Adding one is one row. Removing one from the engine and leaving it
 * here fails the drift test above.
 */
const ROOM_COMMANDS: RoomCommand[] = [
  {
    cmd: "!issue",
    label: "Open a GitHub issue",
    say: "Writes a new issue on the connected repository. An approval card comes first — nothing leaves this computer until you say yes.",
    line: w => `@${w.first} !issue <what the issue is about>`,
    needs: ["agent", "repo"],
  },
  {
    cmd: "!review",
    label: "Ask for a code review",
    say: "Asks the people you name to review a pull request. An approval card comes first — nothing leaves this computer until you say yes.",
    line: w => `@${w.first} !review <pull request number> <github-username>`,
    needs: ["agent", "repo"],
  },
  {
    cmd: "!comment",
    label: "Comment on a pull request",
    say: "Posts your words on a pull request. An approval card comes first — nothing leaves this computer until you say yes.",
    line: w => `@${w.first} !comment <pull request number> <what to say>`,
    needs: ["agent", "repo"],
  },
  {
    cmd: "!code",
    label: "Give a coding job",
    say: "The agent works on its own copy of the code on this computer. If it wants to push anything to GitHub, an approval card comes first.",
    line: w => `@${w.first} !code <what to change>`,
    needs: ["agent", "repo"],
  },
  {
    cmd: "!bg",
    aliases: ["!task"],
    label: "Give a job to work on in the background",
    say: "The agent takes the job away and posts here when it is done. If that agent needs your nod, an approval card comes first.",
    line: w => `@${w.first} !bg <what to do>`,
    needs: ["agent"],
  },
  {
    cmd: "!stop",
    label: "Stop what this agent is doing now",
    say: "Pulls the plug on the turn it is running right now. It tells you straight away, and again when it has really stopped. Anything it had already finished stays done.",
    line: w => `@${w.first} !stop`,
    needs: ["agent"],
  },
  {
    cmd: "!plan",
    label: "Ask to see the plan before it works",
    say: "The agent reads what it needs to, tells you what it intends to do, and waits. Nothing is changed until you press Approve — and if you say nothing, nothing happens.",
    line: w => `@${w.first} !plan <what to do>`,
    needs: ["agent"],
  },
  {
    cmd: "!remember",
    label: "Make this agent remember something",
    say: "The agent keeps this note between conversations. It stays on this computer.",
    line: w => `@${w.first} !remember <what it should remember>`,
    needs: ["agent"],
  },
  {
    cmd: "!handoff",
    label: "Pass this work to another agent",
    say: "The first agent hands the job to the second and says so in the room. It stays on this computer.",
    line: w => `@${w.first} !handoff @${w.second} <what they should do>`,
    needs: ["agent", "twoAgents"],
  },
  {
    cmd: "!schedule",
    label: "Set this agent a repeating job",
    say: "The agent does this again and again at the time you set. If that agent can run programs, an approval card comes first.",
    line: w => `@${w.first} !schedule daily 09:00 <what to do>`,
    needs: ["agent"],
  },
  {
    cmd: "!schedules",
    label: "List this agent's repeating jobs",
    say: "The agent lists what it is set to do and when. Nothing leaves this computer.",
    line: w => `@${w.first} !schedules`,
    needs: ["agent"],
  },
  {
    cmd: "!unschedule",
    label: "Cancel a repeating job",
    say: "Stops one repeating job. Use the id the agent showed you when it listed them.",
    line: w => `@${w.first} !unschedule <the job's id>`,
    needs: ["agent"],
  },
];

/**
 * The one line under the list. Said once, above every row, because the promise
 * is the same for all of them: picking a row is not sending anything.
 */
const ACTIONS_PROMISE =
  "Nothing is sent yet. This writes the line into your box — read it, change it, then press Send.";

/**
 * DOES WHAT HE HAS TYPED AFTER THE SLASH POINT AT THIS COMMAND?
 *
 * Pure, and the only thing that decides what `/` offers. Matched on the command
 * word WITHOUT its `!` (he typed `/`, so making him type `/!issue` would be
 * absurd), on its other spellings, and on the words of its plain-English label —
 * because the whole point of the menu is that he does not have to know the
 * command's name. An empty query matches everything: `/` alone is "show me
 * what there is", which is the same question the ＋ button asks.
 */
function commandMatches(c: RoomCommand, typed: string): boolean {
  if (!typed) return true;
  const words = [c.cmd, ...(c.aliases ?? [])].map(w => w.replace(/^!/, "").toLowerCase());
  return words.some(w => w.startsWith(typed)) || c.label.toLowerCase().includes(typed);
}

/** Files being dragged over something, as opposed to text or a link. */
function draggingFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes("Files");
}

function Composer({ channel, replyTo, answering, onStopAnswering, onSent }: {
  channel: Channel;
  /** set in a thread panel, and in the conversation's own box when threads are
      off and he has pressed Reply: everything typed here answers that message */
  replyTo?: ID;
  /** inline mode only — the message being answered, so the box can say so */
  answering?: Message;
  onStopAnswering?: () => void;
  /** a message really went — the list above takes the view down to it */
  onSent?: () => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [text, setText] = useState("");
  const [acIndex, setAcIndex] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  /**
   * THE AFFORDANCES APPEAR ON INTENT (his draft, §3.2).
   *
   * A tool row that is there all the time is furniture: seven controls sitting
   * under every conversation whether or not he is writing anything. So the row
   * that is only useful WHILE WRITING recedes until he is writing — which is
   * either the cursor being in the box (`focused`) or there being words in it.
   * The two things that must never hide are the ＋ (the one always-visible way
   * in to everything an agent can be told to do — see the note above
   * `ROOM_COMMANDS`; invisible is the same as absent) and Send.
   */
  const [focused, setFocused] = useState(false);
  /** files are being dragged over the box right now */
  const [dragging, setDragging] = useState(false);
  /** he pressed Escape on the `/` list, or picked from it — do not re-open it for this word */
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [cmdIndex, setCmdIndex] = useState(0);
  /* A thread's box is a narrow rail and drops the wide affordances. The
     conversation's own box keeps every one of them even while it is answering
     something — it is the same box it always was, only aimed. */
  const inThreadPanel = !!replyTo && !onStopAnswering;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const uploads = world.uploads[channel.id] ?? [];
  const ready = uploads.filter(u => u.state === "done").length;
  const busy = uploads.some(u => u.state === "sending");

  /**
   * HOW MUCH IS SITTING UNSENT, against the ceiling the hub actually enforces.
   *
   * Counted across every conversation, because the ceiling is per PERSON: files
   * picked in one room and never sent are what fills it, and a tray that only
   * counted this room would explain nothing when the refusal arrived. Both
   * numbers come from `@cloud9/shared` — the hub's own constants — so the
   * screen cannot say a limit the hub does not hold.
   */
  const parked = useMemo(
    () => Object.values(world.uploads).flat()
      .filter(u => u.state !== "failed")
      .reduce((n, u) => n + u.size, 0),
    [world.uploads]);
  const parkedHours = Math.round(ATTACHMENT_LIMITS.parkedTtlMs / 3_600_000);

  /**
   * THE BOX GROWS WITH WHAT IS IN IT.
   *
   * It was `rows={1}` and nothing else, so a five-line message was typed into a
   * one-line slot with its own hidden scrollbar: he could see the line he was on
   * and none of the ones above it. Measured (`scrollHeight`) rather than counted
   * in newlines, because a long line that wraps takes the same room as two.
   * The ceiling is the stylesheet's `max-height`, so the box stops growing and
   * scrolls instead of swallowing the conversation.
   *
   * The list above shrinks as this grows, which is one of the three ways the
   * bottom used to run away from him — `useFollowToBottom` is watching for
   * exactly that, so the newest message stays in sight while he types.
   */
  React.useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${ta.scrollHeight}px`;
  }, [text]);

  const mentionQuery = useMemo(() => {
    const m = /(?:^|\s)@([\w-]*)$/.exec(text);
    return m ? m[1].toLowerCase() : null;
  }, [text]);

  /**
   * `/` IS THE FAST PATH TO THE SAME LIST THE ＋ OPENS — never a second one.
   *
   * Only at the very start of the box and only while no space has been typed,
   * because that is exactly where a command can work at all (the engine reads
   * `!issue` only as the FIRST thing in a message — see `prefill`). So a
   * sentence that happens to contain a slash, a path, or a date is never
   * mistaken for a command, and "/" followed by a space is just a message that
   * starts with a slash.
   */
  const slashQuery = useMemo(() => {
    const m = /^\/([\w-]*)$/.exec(text);
    return m ? m[1].toLowerCase() : null;
  }, [text]);
  /* A new word is a new question: whatever he dismissed was about the old one. */
  useEffect(() => { setSlashDismissed(false); setCmdIndex(0); }, [slashQuery]);

  /* ONE WAY TO PUT A FILE ON A MESSAGE, whichever gesture asked for it — the
     paperclip, a paste, or a drag. `client.attach` is the one owner of what
     happens next (the tray, the ceiling, the hub's refusal in its own words). */
  const attachFiles = useCallback((files: readonly File[]): void => {
    for (const f of files) client.attach(channel.id, f);
  }, [channel.id]);

  const directory = useMemo(() => [
    ...world.agents.map(a => ({ id: a.id, name: a.name, label: `${a.emoji} ${a.name}`, sub: "agent" })),
    ...onePerPerson(world.users).filter(u => u.id !== world.me?.id).map(u => ({ id: u.id, name: u.name, label: u.name, sub: "person" })),
  ], [world.agents, world.users, world.me]);

  const suggestions = mentionQuery === null ? [] :
    directory.filter(d => d.name.toLowerCase().startsWith(mentionQuery)).slice(0, 6);

  const applyMention = (name: string) => {
    setText(t => t.replace(/@[\w-]*$/, `@${name} `));
    taRef.current?.focus();
  };

  const insert = useCallback((snippet: string) => {
    setText(t => (t && !t.endsWith(" ") ? `${t} ${snippet}` : `${t}${snippet}`));
    taRef.current?.focus();
  }, []);

  /* The "write back to…" buttons drop text into the CONVERSATION's box, never
     into a thread's — a thread panel opens and closes under the reader, and
     text that landed in a box that then vanished is text they lost. */
  useEffect(() => {
    if (inThreadPanel) return;
    composerInsert = insert;
    return () => { composerInsert = null; };
  }, [insert, inThreadPanel]);

  /* ---- the actions menu: one way in for every typed command ---- */

  /**
   * TWO DOORS, ONE ROOM. The ＋ opens the whole list; `/` opens the same list
   * narrowed to what he has typed. They are the same rows, the same reasons a
   * row cannot be used, and the same one thing a row does — so there is one
   * `open` question here, not two menus that can drift apart.
   */
  const slashRows = useMemo(
    () => (slashQuery === null ? [] : ROOM_COMMANDS.filter(c => commandMatches(c, slashQuery))),
    [slashQuery]);
  const slashShowing = slashQuery !== null && !slashDismissed && slashRows.length > 0;
  const menuOpen = actionsOpen || slashShowing;
  const menuRows = actionsOpen ? ROOM_COMMANDS : slashRows;
  const openedBy = actionsOpen ? "button" : "slash";

  /** he is writing — the row of tools is worth its space; see `focused` above */
  const armed = focused || text.length > 0 || uploads.length > 0 || menuOpen || emojiOpen;

  /* THE ONE OWNER OF "ESCAPE CLOSES WHAT IT OPENED" (see `useEscapeCloses`).
     Registered only while the menu is on screen, so a closed menu adds nothing
     to the stack and the counts the QA suite takes of it are untouched. It is
     one registration for both doors: whichever opened the list, Escape shuts
     THAT list and nothing underneath it. Dismissing the `/` list leaves his
     words alone — a menu closing must never take the line he was typing. */
  useEscapeCloses(() => { setActionsOpen(false); setSlashDismissed(true); }, menuOpen);

  /* WHICH REPOSITORIES ARE CONNECTED, asked the moment the menu opens — the
     same way the Projects screen asks, and for the same reason: a list cached
     from an earlier visit would let this menu offer a GitHub command against a
     repository that has since gone, or refuse one that has since been added. */
  useEffect(() => {
    if (menuOpen) client.askProjects();
  }, [menuOpen]);

  /** the agents actually IN this room — an agent elsewhere cannot be told anything here */
  const roomAgents = useMemo(
    () => world.agents.filter(a => channel.memberIds.includes(a.id)),
    [world.agents, channel.memberIds]);

  /**
   * WHY THIS COMMAND CANNOT BE USED IN THIS ROOM RIGHT NOW — in plain words, or
   * null when it can. Said on the row rather than discovered after sending: a
   * line that comes straight back with a refusal is the same dead end as no
   * button at all.
   *
   * The repository answer is the honest one we can actually reach from here.
   * A Cloud9 project names a repository ON GITHUB; where that code sits on THIS
   * computer is told to the engine separately (`EngineOptions.repoDir`, and the
   * gap is written down in engine.ts). So the sentence names both halves rather
   * than promising that connecting a project is enough.
   */
  const blockedBecause = (c: RoomCommand): string | null => {
    if (c.needs.includes("agent") && roomAgents.length === 0) {
      return "No agent is in this room yet — add one from the room panel first.";
    }
    if (c.needs.includes("twoAgents") && roomAgents.length < 2) {
      return "This needs two agents in the room — one to hand the work over, one to take it.";
    }
    if (c.needs.includes("repo") && world.projects.asked && world.projects.list.length === 0) {
      return "No repository is connected yet — open Projects and connect one, and Cloud9 has to be told where that code lives on this computer.";
    }
    return null;
  };

  /**
   * WRITE THE LINE INTO THE BOX HE ALREADY USES — and nothing else.
   *
   * It replaces what is in the box on purpose: every one of these commands is
   * only read when it is the FIRST thing in the message (see the `/^!…/` tests
   * in engine.ts), so appending it to half a sentence would produce a line that
   * looks like a command and is treated as ordinary chat. The promise above the
   * list says so before he picks anything.
   *
   * The first `<…>` is left SELECTED, so the next thing he types replaces the
   * part he was always going to have to fill in.
   */
  const prefill = (c: RoomCommand): void => {
    const first = roomAgents[0]?.name ?? "Agent";
    const second = roomAgents[1]?.name ?? "OtherAgent";
    const written = c.line({ first, second });
    setText(written);
    setActionsOpen(false);
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      const open = written.indexOf("<");
      const shut = open >= 0 ? written.indexOf(">", open) : -1;
      if (open >= 0 && shut > open) ta.setSelectionRange(open, shut + 1);
      else ta.setSelectionRange(written.length, written.length);
    });
  };

  /** wrap whatever is selected, the way a formatting button should */
  const wrap = (left: string, right = left) => {
    const ta = taRef.current;
    if (!ta) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const chosen = text.slice(s, e) || "text";
    const next = `${text.slice(0, s)}${left}${chosen}${right}${text.slice(e)}`;
    setText(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s + left.length, s + left.length + chosen.length);
    });
  };

  /* Words are optional when a file is carrying the message — the hub says so
     too, so the button and the hub agree about what an empty box means. */
  const sendNow = () => {
    const t = text.trim();
    /* A FILE STILL GOING UP IS NEVER THROWN AWAY IN SILENCE. Pressing Enter
       used to take whichever files had landed, empty the tray and send — so a
       file still on its way was dropped without a word and finished uploading
       into nothing. The store owns that judgement, so the button, the Enter key
       and a thread's own box all give the same answer. */
    const ready = client.readyToSend(channel.id, t.length > 0);
    if (!ready.ok) {
      if (ready.why) client.notify(ready.why);
      return;
    }
    /* HIS WORDS ARE NOT THROWN AWAY UNTIL THEY ARE ACCEPTED (A3). `client.submit`
       is the one owner of that rule — it asks the HUB'S OWN `validateMessageText`
       first, says the refusal in the hub's own words, and answers false with the
       box untouched. Nothing below it runs unless the message really went. */
    const went = client.submit(
      validateMessageText(t, ready.ids.length > 0),
      {
        type: "send", channelId: channel.id, text: t, replyTo,
        ...(ready.ids.length ? { attachmentIds: ready.ids } : {}),
      });
    if (!went) return;
    setText("");
    setEmojiOpen(false);
    setActionsOpen(false);
    client.clearUploads(channel.id);
    /* THE CURSOR STAYS WHERE HE IS TYPING. Pressing Enter always left it there;
       clicking Send moved the focus onto the button, so the next thing he typed
       went nowhere at all and he had to click back into the box. Both ways of
       sending now end in the same place. */
    taRef.current?.focus();
    /* The list above takes the view down to what he just said. Told rather than
       worked out from the message arriving: a send is his own act and follows
       wherever he had scrolled back to. */
    onSent?.();
    /* The box stops being aimed the moment the reply is away, so the next
       thing typed goes to the conversation unless he aims it again. */
    onStopAnswering?.();
  };

  /* A direct conversation is stored under a machine name ("dm-mercer"), so the
     box has to be addressed to the PERSON, not to the row in the database. */
  const peerName = channel.kind === "dm"
    ? (() => {
      const id = channel.memberIds.find(i => i !== world.me?.id);
      return world.users.find(u => u.id === id)?.name
        ?? world.agents.find(a => a.id === id)?.name
        ?? channel.name;
    })()
    : null;
  const placeholder = inThreadPanel
    ? "Reply in this thread"
    : answering
      ? `Answering ${answering.authorName}`
      : peerName
      ? `Message ${peerName} — / for things to ask`
      /* THE TWO TRIGGERS, SAID WHERE HE IS ABOUT TO TYPE THEM. This line is the
         only place a person is looking when the affordances have receded, so it
         is where they have to be named — an inline trigger nobody is told about
         is the invisibility bug with better manners. */
      : `Message #${channel.name} — @ for an agent, / for things to ask`;

  /**
   * An archived room is READ-ONLY, and the box says so in the hub's own words.
   *
   * Placed after every hook above, deliberately: a return that jumped the
   * hooks would change how many React sees between renders. Un-archiving is one
   * frame and works, so the sentence is a state and not an epitaph — the panel
   * beside it carries "Reopen".
   */
  if (channel.archivedAt) {
    return (
      <div className={`composer archivedcomposer${inThreadPanel ? " threadcomposer" : ""}`}>
        <div className="composer-box readonly" role="status">
          <span className="ro-mark" aria-hidden="true">⌾</span>
          <span className="ro-say">{ARCHIVED_SENTENCE}</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`composer${inThreadPanel ? " threadcomposer" : ""}${dragging ? " isdrop" : ""}`}
      /* A FILE DRAGGED ONTO THE BOX IS A FILE ON THE MESSAGE (his draft, §3.2).
         The whole box is the target, not a small strip, because a drop that
         lands two pixels outside and opens the file in the window instead is
         worse than no drop at all. `dragover` must be refused for the drop to
         be offered at all — that is the browser's rule, not ours. */
      data-dragover={dragging ? "yes" : "no"}
      onDragOver={e => {
        if (!draggingFiles(e.dataTransfer)) return;
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={e => {
        /* Moving between the box's own children is not leaving it. */
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={e => {
        if (!draggingFiles(e.dataTransfer)) { setDragging(false); return; }
        e.preventDefault();
        setDragging(false);
        attachFiles(Array.from(e.dataTransfer.files));
        taRef.current?.focus();
      }}>
      {/* AIMED AT ONE MESSAGE. Only in the conversation's own box, only when
          his setting keeps replies in the conversation — the way out is right
          here, because a box that is quietly still answering something from
          five minutes ago sends the next message to the wrong place. */}
      {answering && (
        <div className="answeringbar" data-answering={answering.id}>
          <span className="arrow" aria-hidden="true">↳</span>
          <span className="ab-who">Answering {answering.authorName}</span>
          <span className="ab-quote">{quoteOf(answering.text, 70)}</span>
          <button className="ab-x" aria-label="Stop answering this message"
            title="Send to the conversation instead"
            onClick={() => onStopAnswering?.()}>✕</button>
        </div>
      )}
      <div className="composer-box" title={`Posting as ${world.me?.name ?? "you"}`}
        /* WHAT "HE IS WRITING" MEANS, in one place, so the row that recedes and
           the attribute a check reads can never disagree. Focus is tracked on
           the whole box rather than the textarea alone: pressing a tool button
           moves the focus onto that button, and a row that vanished under the
           finger reaching for it would be unusable. */
        onFocus={() => setFocused(true)}
        onBlur={e => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setFocused(false);
        }}
        data-writing={armed ? "yes" : "no"}>
        {suggestions.length > 0 && (
          <div className="autocomplete" data-mentions-open="yes" data-mentions={suggestions.length}>
            <div className="ac-head tag">Send this to</div>
            {suggestions.map((s, i) => (
              <div key={s.id} className={`opt ${i === acIndex ? "on" : ""}`}
                onMouseDown={e => { e.preventDefault(); applyMention(s.name); }}>
                <span className="opt-label">{s.label}</span>
                <span className="opt-sub">{s.sub}</span>
              </div>
            ))}
          </div>
        )}
        {/* Picked files wait here, above the words, until the message goes.
            Each one says what is happening to it — going up, up, or refused in
            the hub's own sentence — because an upload that fails in silence is
            a message somebody thinks they sent. */}
        {parked > 0 && (
          <div className="parked" role="status"
            data-parked={parked} data-parked-max={ATTACHMENT_LIMITS.parkedBytesPerUser}>
            <span className="pk">Files waiting to be sent</span>
            <span className="pv">
              {fileSize(parked)} of {fileSize(ATTACHMENT_LIMITS.parkedBytesPerUser)}
            </span>
            <span className="pw">
              Kept for {parkedHours} hours — send them or take them off before then.
            </span>
          </div>
        )}
        {uploads.length > 0 && (
          <div className="uploadtray" aria-label="Files going with this message">
            {uploads.map(u => (
              <div className={`uptile ${u.state}`} key={u.localId} data-upload={u.name}>
                <span className="glyph" aria-hidden="true">{fileKind(u.name)}</span>
                <span className="filenames">
                  <span className="nm">{u.name}</span>
                  <span className="meta">
                    {u.state === "sending" ? "Going up…"
                      : u.state === "done" ? `${fileSize(u.size)} · ready to send`
                        : plainError(u.error)}
                  </span>
                </span>
                {u.state === "sending" && <span className="upbar" aria-hidden="true"><i /></span>}
                <button className="upx" aria-label={`Take ${u.name} back off this message`}
                  title="Take this file off" onClick={() => client.dropUpload(channel.id, u.localId)}>✕</button>
              </div>
            ))}
          </div>
        )}
        <textarea
          ref={taRef}
          rows={1}
          value={text}
          placeholder={placeholder}
          onChange={e => { setText(e.target.value); setAcIndex(0); }}
          onKeyDown={e => {
            if (suggestions.length > 0) {
              if (e.key === "ArrowDown") { e.preventDefault(); setAcIndex(i => (i + 1) % suggestions.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setAcIndex(i => (i - 1 + suggestions.length) % suggestions.length); return; }
              if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); applyMention(suggestions[acIndex].name); return; }
            }
            /* THE `/` LIST IS DRIVEN FROM THE KEYBOARD, exactly like the `@`
               list above it, because both are answers to something he is in the
               middle of typing and reaching for the mouse loses the thread. The
               two can never be open at once: `/` only exists while the box holds
               nothing but a slash and a word, and `@` needs an `@` at the end. */
            if (slashShowing) {
              if (e.key === "ArrowDown") { e.preventDefault(); setCmdIndex(i => (i + 1) % slashRows.length); return; }
              if (e.key === "ArrowUp") { e.preventDefault(); setCmdIndex(i => (i - 1 + slashRows.length) % slashRows.length); return; }
              if (e.key === "Tab" || e.key === "Enter") {
                e.preventDefault();
                const pick = slashRows[Math.min(cmdIndex, slashRows.length - 1)];
                /* A row that cannot work here says why rather than quietly
                   writing a line that will come back refused — the same promise
                   the list itself makes, kept on the keyboard road too. */
                const why = pick ? blockedBecause(pick) : null;
                if (why) client.notify(why);
                else if (pick) prefill(pick);
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendNow(); }
          }}
          /* CTRL+V PUTS A FILE ON THE MESSAGE (his draft, §3.2). Only when the
             clipboard is actually carrying files — pasting ordinary text, which
             is what a paste nearly always is, is left completely alone. */
          onPaste={e => {
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length === 0) return;
            e.preventDefault();
            attachFiles(files);
          }}
        />
        <div className="tools">
          {/* The one composer affordance he asked for in round 1 that was never
              built. The input itself is hidden because a bare file input cannot
              be made to look like anything; the button in front of it is the
              real control and carries the label. */}
          <input ref={fileRef} className="filepick" type="file" multiple
            aria-label="Choose files to attach"
            onChange={e => {
              attachFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }} />
          {/* THE ONE WAY IN to everything an agent can be TOLD to do, AND THE
              ONE CONTROL THAT NEVER RECEDES.
              It is in the thread box as well as the room's own, deliberately
              breaking the "wide affordances stay out of a thread" rule below:
              the commands work the same in a thread, and hiding the only door in
              half the places he types would be the invisibility bug again,
              smaller. That is also why the de-clutter below does not touch it —
              `/` is the fast road for somebody who already knows what he wants,
              and this is the road for somebody who does not. Invisible is the
              same as absent. */}
          <button className="mini actionsbtn" title="Things you can ask an agent to do — or type / in the box"
            aria-expanded={actionsOpen} aria-haspopup="menu"
            onClick={() => { setActionsOpen(o => !o); setEmojiOpen(false); }}>
            ＋ Actions
          </button>
          {/**
            * THE ROW THAT ONLY MATTERS WHILE HE IS WRITING, and is only there
            * while he is (his draft, §3.2: "affordances appear on intent, not
            * permanently"). Held in the DOM either way and hidden by the
            * stylesheet, so nothing here changes what the box can DO — the
            * hidden file input above, and every one of these, still answer.
            *
            * WHAT WENT, and why it is not an ability lost:
            *  - "@ agent" was a button whose whole job was to type one
            *    character. Typing `@` opens the same list of people and agents
            *    it did, and the box's own placeholder says so.
            *  - the wide labels went to icons; the paperclip is now also a
            *    paste (Ctrl+V) and a drop, which is how a file usually arrives.
            *
            * THE SAME BOX, NARROWER — not a lesser one. These used to be dropped
            * in the thread rail on the grounds that "a thread is a narrow column
            * and a reply is a sentence". That was the panel deciding what he is
            * allowed to say in it: a thread is where the actual work gets
            * discussed, so writing code in one, or handing the job over from
            * inside it, are exactly the things he wants there.
            */}
          <span className="toolset">
            <button className="mini attach" title={`Attach a file — or paste one, or drop one on the box (up to ${ATTACHMENT_LIMITS.perMessage}, ${Math.floor(ATTACHMENT_LIMITS.bytes / 1_000_000)} MB each)`}
              onClick={() => fileRef.current?.click()}>📎</button>
            <button className="mini" title="Hand this over as background work"
              onClick={() => insert("!bg ")}>{inThreadPanel ? "Delegate" : "Delegate as a job"}</button>
            <button className="mini" title="Bold" onClick={() => wrap("**")}><b>B</b></button>
            <button className="mini ital" title="Italic" onClick={() => wrap("_")}>I</button>
            <button className="mini" title="Code" onClick={() => wrap("`")}>{"</>"}</button>
            <button className="mini" title="Emoji" aria-expanded={emojiOpen}
              onClick={() => setEmojiOpen(o => !o)}>🙂</button>
          </span>
          <div className="grow" />
          {!inThreadPanel && <span className="eyebrow">{busy ? "Sending a file up…" : "Enter to send"}</span>}
          {/* While a file is on its way the button SAYS so rather than sending
              without it. Enter says the same thing out loud (see `sendNow`), so
              neither route can quietly leave a file behind. */}
          <button className="primary small sendbtn" onClick={sendNow}
            data-waiting={busy ? "file" : undefined}
            title={busy ? "A file is still going up. It goes with this message once it lands." : undefined}
            disabled={busy || (!text.trim() && ready === 0)}>
            {busy
              ? "Waiting for a file…"
              : `Send${ready > 0 ? ` with ${countOf(ready, "file")}` : ""}`}
          </button>
          {emojiOpen && (
            <div className="emojipop">
              {QUICK_EMOJI.map(e => (
                <button key={e} onClick={() => { insert(e); setEmojiOpen(false); }}>{e}</button>
              ))}
            </div>
          )}
          {/* One list, built from ONE table (`ROOM_COMMANDS`), whichever door
              opened it — the ＋ beside the box or a `/` typed into it. A row that
              cannot work here is drawn as it really is — off, with the reason on
              it. `data-open-by` says which door, because "he found it by typing"
              and "he found it by looking" are different claims about the same
              list and a check should be able to hold either one. */}
          {menuOpen && (
            <div className={`actionspop${openedBy === "slash" ? " slashpop" : ""}`}
              role="menu" aria-label="Things you can ask an agent to do"
              data-actions-open="yes" data-open-by={openedBy} data-rows={menuRows.length}>
              <div className="ap-head tag">
                {openedBy === "slash" ? `Ask an agent to… (${countOf(menuRows.length, "match", "matches")})` : "Ask an agent to…"}
              </div>
              <div className="ap-promise">{ACTIONS_PROMISE}</div>
              {menuRows.map((c, i) => {
                const why = blockedBecause(c);
                /* Only the typed road has a highlighted row: the ＋ list is
                   pointed at with a mouse, and a lit row nobody can move with
                   the arrow keys would be a promise the list does not keep. */
                const on = openedBy === "slash" && i === Math.min(cmdIndex, menuRows.length - 1);
                return (
                  <button key={c.cmd} className={`ap-row${why ? " is-blocked" : ""}${on ? " on" : ""}`}
                    role="menuitem" data-command={c.cmd} data-blocked={why ? "yes" : "no"}
                    data-on={on ? "yes" : "no"}
                    disabled={!!why}
                    /* The cursor comes back to the box by itself — `prefill`
                       puts it on the part he has to fill in. */
                    onClick={() => prefill(c)}>
                    <span className="ap-label">{c.label}</span>
                    <span className="ap-say">{why ?? c.say}</span>
                    <span className="ap-cmd">{c.cmd}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- open, shut, or retired — said wherever a room is named ---- */

/**
 * A room that anyone in this Cloud9 can find and let themselves into is a
 * different thing from one you were put in. It is drawn everywhere the room is
 * named, because "who else could be reading this" must never be a guess.
 *
 * Absent `visibility` means private: every room that existed before this field
 * stays shut, and the chip says so rather than saying nothing.
 */
function RoomVisibility({ channel, size = "short" }: {
  channel: Channel;
  /** "mark" = the glyph alone, for a sidebar row; "long" = the whole sentence */
  size?: "mark" | "short" | "long";
}): React.JSX.Element | null {
  if (channel.kind === "dm") return null;
  const mark = size === "mark";
  if (channel.archivedAt) {
    return (
      <span className={`roomvis is-archived${mark ? " tiny" : ""}`} data-vis="archived"
        title="Retired — still readable, nothing new can be said in it">
        <span className="vm" aria-hidden="true">⌾</span>{mark ? "" : ROOM_ARCHIVED_WORDS}
      </span>
    );
  }
  const open = channel.visibility === "open";
  const words = open ? (size === "long" ? ROOM_OPEN_WORDS : ROOM_OPEN_SHORT) : ROOM_PRIVATE_WORDS;
  return (
    <span className={`roomvis ${open ? "is-open" : "is-shut"}${mark ? " tiny" : ""}`}
      data-vis={open ? "open" : "private"}
      title={open ? ROOM_OPEN_WORDS : "Only the people already in this room can see it"}>
      <span className="vm" aria-hidden="true">{open ? "◇" : "◆"}</span>
      {mark ? "" : words}
    </span>
  );
}

/* ---- what this room is, who is in it, and how it is run ---- */

/**
 * The room-details panel (§10.8).
 *
 * The controls are drawn from YOUR OWN membership row's role, and that is the
 * only thing they decide: whether a button is worth showing. The relay is still
 * the gate on every one of them (§8), so nothing here can widen what is
 * allowed — it can only stop a click that would always be refused.
 */
function RoomPanel({ channel, onClose, onOpenDm, onLeft }: {
  channel: Channel;
  onClose: () => void;
  onOpenDm: (id: ID, name: string) => void;
  onLeft: () => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [editInfo, setEditInfo] = useState(false);
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [description, setDescription] = useState(channel.description ?? "");
  const [confirmLeave, setConfirmLeave] = useState(false);

  // The panel asks for the membership rows itself. `memberIds` would answer
  // "who is in here" and nothing else — not the role, not the date, not who
  // let them in — and those three are what this panel is for.
  /* Asked again whenever the room's membership changes — somebody joining an
     open room, or an agent being let in, must appear in this list without the
     panel having to be closed and opened again. */
  const roster = channel.memberIds.join(",");
  useEffect(() => { client.askMembers(channel.id); }, [channel.id, roster]);
  useEffect(() => {
    setTopic(channel.topic ?? "");
    setDescription(channel.description ?? "");
    setEditInfo(false);
    setConfirmLeave(false);
  }, [channel.id, channel.topic, channel.description]);

  const rows = (world.members[channel.id] ?? []).filter(m => !m.removedAt);
  const myRole: ChannelRole | undefined =
    rows.find(m => m.memberId === world.me?.id)?.role;
  const mayRun = mayAdministerChannel(myRole);
  const archived = !!channel.archivedAt;
  const open = channel.visibility === "open";
  /* Who is being taken out, or given a different job. Held by row key, so the
     question is always about the membership on screen. */
  const [managing, setManaging] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  useEffect(() => { setManaging(null); setConfirmRemove(null); }, [channel.id]);

  /**
   * MAY I TAKE THIS PERSON OUT, AND MAY I CHANGE WHAT THEY DO HERE?
   *
   * The hub's rules, read here so a button whose only possible outcome is a
   * refusal is never drawn at all (§8 — the hub is still the gate; this can
   * only ever offer LESS than the hub allows, never more):
   *  - taking someone out needs owner or admin, and only the owner may take out
   *    the person who runs the room;
   *  - changing a role is the owner's alone, and the owner cannot stand
   *    themselves down — a room always has somebody running it, so that is done
   *    by handing it to someone else;
   *  - a role is a job on a screen, and an agent has no screen. Agents can be
   *    taken out of a room; they are never offered one.
   */
  /**
   * CHANGE THE ROOM'S MEMBERSHIP, AND ASK WHAT IT IS NOW.
   *
   * The room's own `channel` frame carries `memberIds`, so taking somebody out
   * refreshes this list by itself — but giving somebody a different job changes
   * NOTHING in that list, and the panel sat there showing the role it had
   * before. Rather than wait for a broadcast that says nothing about roles, the
   * question is asked again straight away: the hub reads one frame at a time
   * and answers it before it reads the next, so the answer to this one is bound
   * to have the change in it.
   */
  const changeMembership = (frame: Parameters<typeof client.send>[0]): void => {
    client.send(frame);
    client.askMembers(channel.id);
  };

  const isRoom = channel.kind !== "dm";
  const mayRemove = (m: ChannelMember): boolean =>
    isRoom && mayRun && m.memberId !== world.me?.id
    && (m.role !== "owner" || myRole === "owner");
  const mayRerole = (m: ChannelMember, isAgent: boolean): boolean =>
    isRoom && myRole === "owner" && !isAgent && m.memberId !== world.me?.id;

  const nameOf = (id: ID): { name: string; agent?: AgentDef; user?: User } => {
    const agent = world.agents.find(a => a.id === id);
    const user = world.users.find(u => u.id === id);
    return { name: agent?.name ?? user?.name ?? "Someone who has left", agent, user };
  };

  /* THE SAME OWNER, A DIFFERENT SURFACE. Room details is an editor too — it has
     a Save and a Cancel and it holds typed words — and switching conversation
     used to throw them away exactly as the rail threw away an agent's brief.
     It says so here and the one owner does the rest. */
  const infoChanged = editInfo
    && (topic !== (channel.topic ?? "") || description !== (channel.description ?? ""));
  const infoSettled = useRef(false);
  useUnsavedWork(`The details of #${channel.name}`, infoChanged && !infoSettled.current);

  /* Absent means "leave alone", "" means "clear it" — the same rule skill files
     follow. So only the field that actually changed is ever sent. */
  const saveInfo = () => {
    const patch: { description?: string; topic?: string } = {};
    if (description !== (channel.description ?? "")) patch.description = description;
    if (topic !== (channel.topic ?? "")) patch.topic = topic;
    infoSettled.current = true;
    setEditInfo(false);
    if (Object.keys(patch).length === 0) return;
    client.send({ type: "setChannelInfo", channelId: channel.id, ...patch });
  };

  return (
    <aside className="aside roompanel" aria-label="Room details">
      <div className="threadhead">
        <span className="eyebrow">Room details</span>
        <div className="grow" />
        <button className="iconbtn roomclose" aria-label="Close room details" onClick={onClose}>✕</button>
      </div>

      <div className="roombody">
        <div className="aside-sec roomhead">
          <h3 className="roomname"><span className="h">#</span>{channel.name}</h3>
          <RoomVisibility channel={channel} size="long" />
        </div>

        <div className="aside-sec">
          <span className="eyebrow">What it's for</span>
          {editInfo ? (
            <div className="roomedit">
              <label className="roomfield">
                <span className="lb">Description</span>
                <textarea className="roomdesc-input" rows={3} value={description}
                  maxLength={500} placeholder="What this room is for"
                  onChange={e => setDescription(e.target.value)} />
              </label>
              <label className="roomfield">
                <span className="lb">Topic — one line</span>
                <input className="input roomtopic-input" type="text" value={topic}
                  maxLength={200} placeholder="What it's about today"
                  onChange={e => {
                    infoSettled.current = false;
                    setTopic(e.target.value.replace(/[\r\n]/g, " "));
                  }} />
              </label>
              <div className="roomeditbtns">
                <button className="primary small roominfo-save" onClick={saveInfo}>Save</button>
                <button className="btn small ghost" onClick={() => {
                  setTopic(channel.topic ?? ""); setDescription(channel.description ?? ""); setEditInfo(false);
                }}>Cancel</button>
              </div>
            </div>
          ) : (
            <dl className="kv roominfo">
              <dt>Description</dt>
              <dd className="roomdesc">{channel.description || "Not written yet"}</dd>
              <dt>Topic</dt>
              <dd className="roomtopic">{channel.topic || "Nothing set"}</dd>
            </dl>
          )}
          {mayRun && !archived && !editInfo && (
            <button className="btn small roominfo-edit" onClick={() => setEditInfo(true)}>
              Change these
            </button>
          )}
        </div>

        {/* TURNING THIS ONE ROOM DOWN. It lives here, with the room's own
            details, because that is where a person looks for "this room" —
            Settings owns the switches that are true everywhere. */}
        <RoomMute channel={channel} isRoom={isRoom} />

        {/* WHAT THE AGENTS IN HERE HAVE MADE. A file is the room's, not the
            agent's — which is why it is listed with the room's own details. */}
        <RoomFiles channel={channel} />

        <div className="aside-sec roommembers">
          <span className="eyebrow">Who's here ({rows.length})</span>
          {rows.length === 0 && <div className="d-empty">Fetching who is in this room…</div>}
          {rows.map(m => {
            const who = nameOf(m.memberId);
            const key = `${m.memberId}:${m.joinedAt}`;
            const canRemove = mayRemove(m);
            const canRerole = mayRerole(m, !!who.agent);
            /* "added by" answers "how did they get here". Said about the
               person themselves it answers nothing — the room's creator is
               recorded as their own inviter — so it is left off. */
            const invitedBy = m.invitedBy && m.invitedBy !== m.memberId
              ? nameOf(m.invitedBy).name : null;
            return (
              /* KEYED BY THE ROW, NOT BY THE PERSON. Leaving a room and being
                 let back in writes a SECOND membership row and leaves the first
                 exactly as it was, so `memberId` alone is no longer unique —
                 React would fold a real history into one row and go on drawing
                 the membership that ended. */
              <React.Fragment key={key}>
              <div className="mini-agent memberrow"
                data-member={who.name} data-memberkey={key}
                data-joined={m.joinedAt}>
                {who.agent
                  ? <AgentFace name={who.name} size={36} lamp={world.agentStatus[m.memberId] === "working" ? "run" : "live"} />
                  : <PersonFace name={who.name} size={36} lamp={m.memberId === world.me?.id ? "live" : "idle"} />}
                <span style={{ minWidth: 0 }}>
                  <span className="nm">
                    {who.name}{m.memberId === world.me?.id ? " · you" : ""}
                    {who.agent ? <span className="badge">Agent</span> : null}
                  </span>
                  <span className="rl">
                    <b className="rolename" data-role={m.role}>{ROLE_WORDS[m.role]}</b>
                    {" · joined "}{dayStamp(m.joinedAt)}
                    {invitedBy ? ` · added by ${invitedBy}` : ""}
                  </span>
                  {/* An agent's owner reads everything said here. Said on the
                      row itself, because this list is where a person decides
                      whether the room is still private. */}
                  {who.agent ? <AgentOwnerTag agent={who.agent} /> : null}
                </span>
                {(canRemove || canRerole || (who.user && m.memberId !== world.me?.id)) && (
                  <span className="tools">
                    {who.user && m.memberId !== world.me?.id && (
                      <button className="iconbtn" title={`Open your chat with ${who.name}`}
                        onClick={() => onOpenDm(m.memberId, who.name)}>✉</button>
                    )}
                    {/* Offered only where the hub would say yes, so this is
                        never a button whose one outcome is a refusal. */}
                    {(canRemove || canRerole) && (
                      <button className="iconbtn memberopen" aria-expanded={managing === key}
                        aria-label={`Change what ${who.name} can do here`}
                        title={`Change what ${who.name} can do here`}
                        onClick={() => {
                          setManaging(k => (k === key ? null : key));
                          setConfirmRemove(null);
                        }}>⋯</button>
                    )}
                  </span>
                )}
              </div>
              {managing === key && (
                <div className="memberask" data-manage={who.name}>
                  {canRerole && (
                    <div className="rolepick">
                      <span className="lb">What {who.name} can do here</span>
                      {ROLE_ORDER.map(r => (
                        <button key={r} className={`roleopt${m.role === r ? " on" : ""}`}
                          data-role={r} data-setrole={r} aria-pressed={m.role === r}
                          disabled={m.role === r}
                          onClick={() => {
                            changeMembership({
                              type: "setMemberRole", channelId: channel.id,
                              memberId: m.memberId, role: r,
                            });
                            setManaging(null);
                          }}>
                          <b>{ROLE_WORDS[r]}</b>
                          <span>{ROLE_MEANS[r]}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {canRemove && (confirmRemove === key ? (
                    <div className="roomleaveask memberoutask">
                      <span>
                        Take {who.name} out of #{channel.name}?
                        {who.agent
                          ? " It stops answering here, and whoever owns it stops seeing this room."
                          : " They stop seeing it."}
                        {" Everything already said stays exactly where it is."}
                      </span>
                      <button className="btn small danger memberout-yes"
                        onClick={() => {
                          changeMembership({
                            type: "removeMember", channelId: channel.id, memberId: m.memberId,
                          });
                          setConfirmRemove(null);
                          setManaging(null);
                        }}>
                        Yes, take {who.name} out
                      </button>
                      <button className="btn small ghost"
                        onClick={() => setConfirmRemove(null)}>Keep them here</button>
                    </div>
                  ) : (
                    <button className="btn small memberout"
                      onClick={() => setConfirmRemove(key)}>
                      Take {who.name} out of this room
                    </button>
                  ))}
                </div>
              )}
              </React.Fragment>
            );
          })}
        </div>

        <div className="aside-sec roomcontrols">
          <span className="eyebrow">How this room is run</span>
          {mayRun ? (
            <>
              <div className="roomctl">
                <span className="lb">Who can find it</span>
                <div className="segbtns">
                  <button className={`segbtn${open ? " on" : ""}`} data-vis="open"
                    aria-pressed={open} disabled={archived}
                    title={ROOM_OPEN_WORDS}
                    onClick={() => client.send({ type: "setChannelVisibility", channelId: channel.id, visibility: "open" })}>
                    Anyone here
                  </button>
                  <button className={`segbtn${open ? "" : " on"}`} data-vis="private"
                    aria-pressed={!open} disabled={archived}
                    onClick={() => client.send({ type: "setChannelVisibility", channelId: channel.id, visibility: "private" })}>
                    {ROOM_PRIVATE_WORDS}
                  </button>
                </div>
              </div>
              <button className="btn small roomarchive"
                onClick={() => client.send({ type: "archiveChannel", channelId: channel.id, archived: !archived })}>
                {archived ? "Reopen this room" : "Archive this room"}
              </button>
              <div className="roomhint">
                {archived
                  ? "Reopening puts it back the way it was — nothing was deleted."
                  : "Archiving keeps every word and stops anything new being said."}
              </div>
            </>
          ) : (
            <div className="d-empty roomnotyours">
              You can read and talk here. Changing the room — its topic, who can
              find it, whether it stays open — is for whoever runs it.
            </div>
          )}

          {confirmLeave ? (
            <div className="roomleaveask">
              <span>Leave #{channel.name}? You'd stop seeing it.</span>
              <button className="btn small danger roomleave-yes"
                onClick={() => { client.send({ type: "leaveChannel", channelId: channel.id }); onLeft(); }}>
                Yes, leave
              </button>
              <button className="btn small ghost" onClick={() => setConfirmLeave(false)}>Stay</button>
            </div>
          ) : (
            <button className="btn small roomleave" onClick={() => setConfirmLeave(true)}>
              Leave this room
            </button>
          )}
        </div>
      </div>
    </aside>
  );
}

/** The three roles, in the words the UI uses for them. */
const ROLE_WORDS: Record<ChannelRole, string> = {
  owner: "Runs this room",
  admin: "Helps run it",
  member: "Member",
};

/** Most power first, so the list reads as a ladder rather than an arbitrary set. */
const ROLE_ORDER: ChannelRole[] = ["owner", "admin", "member"];

/**
 * WHAT PICKING EACH ONE ACTUALLY DOES.
 *
 * Said on the control itself, because a role is only a word until somebody
 * knows what it costs them — and handing a room over is not undoable by the
 * person doing it.
 */
const ROLE_MEANS: Record<ChannelRole, string> = {
  owner: "Hands this room over. They run it and you drop to helping run it — only they can hand it back.",
  admin: "Can change the description and topic, open or close the room, and take people out.",
  member: "Can read and talk here, and nothing about the room itself.",
};

/* ---- the right rail ---- */

/**
 * "IT SAYS IT CANNOT REACH MY PC" — the one click that ends that, 2026-08-05.
 *
 * His report: he asks an agent in chat to open a file on his computer and it
 * answers "I do not have access to this folder". Nothing was broken. The agent
 * he was talking to simply had no folder opened up for it — either the switch
 * was off, or (on his newest agent) the switch was on and no folder had ever
 * been chosen. The agent now SAYS the exact steps, because a refusal with no
 * door is the fault; this is the other half — the door itself, next to the
 * agent's name in the room he is already looking at, one press away.
 *
 * NEVER SILENT, SINCE 2026-08-06 — and this is the third report of the same
 * feeling. This line used to speak in two of the five states and say NOTHING in
 * the other three, because they are disk questions and this window cannot see
 * the disk. The result was that the room went quiet in exactly the states where
 * he is most likely to be staring at "I cannot reach that folder": the folder he
 * needs was never on the list, or one that was has moved. A blank space and no
 * door, which from where he sits is a broken app.
 *
 * So the words come from `reachLineInRoom` in @cloud9/engine, which is TOTAL —
 * one sentence and one door for every provider, every switch and every folder
 * list, held by `neversilent.test.ts`. This component chooses nothing and can no
 * longer forget a state; it only draws what that one owner returns.
 */
function ReachGap({ agent, onEdit }: {
  agent: AgentDef; onEdit: () => void;
}): React.JSX.Element {
  /* A GAP FIRST, because a gap is a promise the app has made and cannot keep —
     and that badge covers connected services too, which this line never
     mentions. Everything else falls through to the total answer below. */
  if (supplyGapsOf(agent).length > 0) {
    return <SupplyGapBadge agent={agent} onEdit={onEdit} where="rail" />;
  }
  const line = reachLineInRoom(agent, agent.name);
  return (
    <span className="an-fix" data-reach-gap={line.state}>
      {line.words}{" "}
      <button className="linkbtn" data-reach-fix onClick={onEdit}>{line.fix}</button>
    </span>
  );
}

/**
 * A SWITCH THAT IS ON WITH NOTHING BEHIND IT, SAID WHERE HE IS STANDING.
 *
 * THE FAULT, 2026-08-05, in his words: "cloud9 is not able to access my pc". The
 * `wholeComputer` switch was on for that agent and no folder had ever been
 * chosen, so the honest answer really was "I cannot" — and the ONLY place that
 * fact was written down was inside that agent's own editor, which he had no
 * reason to open because as far as he knew he had already switched it on.
 *
 * A GAP IS NOW LOUD EVERYWHERE THE AGENT IS. This one component is drawn on the
 * crew card and in the room rail, and both read `supplyGapsOf` in
 * `@cloud9/shared` — the same function the editor reads. There is no way to add
 * a switch of this shape that shows up in one of those places and not the
 * others, because none of them computes its own answer.
 *
 * NOT A DISK QUESTION. "Is that folder still there?" belongs to the engine,
 * which can see the disk; a gone folder is said in the editor by
 * `WholeComputerPick`. This says only the thing that needs no disk and is
 * therefore true in any window: nothing has been chosen at all.
 */
function SupplyGapBadge({ agent, onEdit, where }: {
  agent: AgentDef; onEdit: () => void; where: "card" | "rail";
}): React.JSX.Element | null {
  const gaps = supplyGapsOf(agent);
  if (gaps.length === 0) return null;
  const first = gaps[0];
  return (
    <span className={where === "card" ? "gapline" : "an-fix gapline"}
      data-supply-gap={gaps.map(g => g.ability).join(",")} data-reach-gap="none">
      <span className="chip is-gold" data-supply-gap-chip>Half set up</span>{" "}
      {agent.name} {first.missing}
      {gaps.length > 1
        ? `, and ${countOf(gaps.length - 1, "other switch", "other switches")} like it`
        : ""}.{" "}
      <button className="linkbtn" data-reach-fix data-supply-gap-fix={first.ability}
        onClick={onEdit}>
        {first.fix}
      </button>
    </span>
  );
}

function ChannelRail({ channel, onEditAgent, onOpenDm }: {
  channel: Channel;
  onEditAgent: (a: AgentDef) => void;
  onOpenDm: (id: ID, name: string) => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const agents = channel.memberIds.map(id => world.agents.find(a => a.id === id)).filter(Boolean) as AgentDefPlus[];
  const people = onePerPerson(
    channel.memberIds.map(id => world.users.find(u => u.id === id)).filter(Boolean) as User[]);
  const tasks = world.tasks.filter(t => t.channelId === channel.id);
  /* STUCK IS NOT RUNNING. A blocked job used to be counted in with the ones
     genuinely moving and printed under "Running now", which is the whole bug:
     the job that most needs him read as the one that needed him least. It is
     listed FIRST, and the heading says so. */
  const live = tasks.filter(t => ["working", "not_started", "waiting_approval", "waiting_user"].includes(t.status));
  const stuck = tasks.filter(t => t.status === "blocked");
  const openJobs = [...stuck, ...live];
  const shownJobs = openJobs.length > 0 ? openJobs : tasks.slice(0, 4);

  return (
    <aside className="aside" aria-label="Channel details">
      <div className="aside-sec">
        <span className="eyebrow">In this channel</span>
        {agents.length === 0 && people.length === 0 &&
          <div className="d-empty">Nobody in this room yet. Use “Add agent” above to bring someone in.</div>}
        {agents.map(a => {
          const pres = presenceOf(world, a.id);
          const says = presenceSays(world, a.id, pres);
          const provider = (a.provider ?? "claude") as Provider;
          return (
            <div className="mini-agent" key={a.id} data-agent={a.name}
              data-presence={pres?.presence ?? "unknown"} data-trouble={says.trouble ?? ""}>
              <AgentFace name={a.name} size={36} presence={pres} hasPresence />
              <span style={{ minWidth: 0 }}>
                <span className="nm">{a.name}</span>
                <span className="rl two-lines" title={a.persona}>
                  {PROVIDER_LABEL[provider]} · {roleOf(a.persona)}
                </span>
                <span className={`an-state${says.trouble ? " introuble" : ""}`} title={says.title}>
                  <b>{says.word}</b>
                  {says.reason && <> · {says.reason}</>}
                </span>
                {/* who is in this room BECAUSE this agent is */}
                <AgentOwnerTag agent={a} />
                <ReachGap agent={a} onEdit={() => onEditAgent(a)} />
              </span>
              <span className="tools">
                <button className="iconbtn" title={`Open your chat with ${a.name}`}
                  onClick={() => onOpenDm(a.id, a.name)}>✉</button>
                {a.ownerId === world.me?.id &&
                  <button className="iconbtn" title={`Edit ${a.name}`} onClick={() => onEditAgent(a)}>✎</button>}
              </span>
            </div>
          );
        })}
        {people.map(u => (
          <div className="mini-agent member" key={u.id}>
            <PersonFace name={u.name} size={36} lamp={u.id === world.me?.id ? "live" : "idle"} />
            <span style={{ minWidth: 0 }}>
              <span className="nm">{u.name}</span>
              <span className="rl">{u.invitedBy ? "Member" : "Owner"}{u.id === world.me?.id ? " · you" : ""}</span>
            </span>
            {u.id !== world.me?.id && (
              <span className="tools">
                <button className="iconbtn" title={`Open your chat with ${u.name}`}
                  onClick={() => onOpenDm(u.id, u.name)}>✉</button>
              </span>
            )}
          </div>
        ))}
      </div>

      <div className="aside-sec">
        <span className="eyebrow">
          {stuck.length > 0
            ? `Stuck — needs a look · ${stuck.length}`
            : live.length > 0 ? "Running now" : "Jobs from this channel"}
        </span>
        {shownJobs.length === 0 && (
          <div className="d-empty">Nothing handed over yet. Ask an agent with <code>@name !bg</code>.</div>
        )}
        {shownJobs.map(t => {
          const agent = world.agents.find(a => a.id === t.agentId);
          const tr = taskTrouble(t);
          return (
            <div className="job" key={t.id} data-trouble={tr?.kind ?? ""}>
              <b>{t.title}</b>
              {agent?.name ?? "An agent"} · {tr ? tr.word : STATUS_LABEL[t.status] ?? t.status} · started {clock(t.createdAt)}
              {tr && <span className="jobwhy">{tr.reason}</span>}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/* ================= 4 · THE CREW (call sheet) ================= */

/**
 * "I ALREADY DID IT" — the receipt for the one-time catch-up, on his screen.
 *
 * THE CHANGE THIS ANNOUNCES. Cloud9 changed what a new agent gets; the six he
 * already had were made before that and were stuck below it. The hub now brings
 * them up by itself, once, at startup (`reachcatchup.ts`) — and a change to
 * things he owns that he cannot see is exactly the kind that costs trust. So it
 * is said in plain words, on every screen, until he has read it: which agents
 * changed, what each one gained, the trust setting they were given, and where
 * to undo any of it.
 *
 * IT IS NOT A BUTTON HE HAS TO FIND. The work is already done by the time this
 * appears; the only thing to press is "Got it".
 *
 * DISMISSED PER CATCH-UP, not per session, and remembered in this window's own
 * storage — so it survives a reload (which would otherwise show it again from
 * the same welcome frame) and a second, different catch-up would still be told.
 */
const CAUGHT_UP_SEEN = "cloud9.reachCatchup.seen";

function CaughtThemUp(): React.JSX.Element | null {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const said = world.reachCatchup;
  const [seen, setSeen] = useState<string>(() => {
    try { return localStorage.getItem(CAUGHT_UP_SEEN) ?? ""; } catch { return ""; }
  });

  if (!said || said.agents.length === 0) return null;
  const stamp = String(said.ranAt);
  if (seen === stamp) return null;

  const got = (): void => {
    try { localStorage.setItem(CAUGHT_UP_SEEN, stamp); } catch { /* no storage — say it again */ }
    setSeen(stamp);
  };

  // THE WORDS ON THE SWITCHES, not a summary of them — read from the rows the
  // hub actually granted, so this list cannot say something the grant did not.
  const gained = [...new Set(said.agents.flatMap(a => a.gained))];
  const names = said.agents.map(a => a.name);
  const folderNames = said.agents.filter(a => a.folder).map(a => a.name);
  const trusted = said.agents.filter(a => a.trustSet).map(a => a.name);

  return (
    <div className="crewupgrade caughtup" data-caught-up={stamp}
      data-caught-up-names={names.join(",")}
      data-caught-up-gained={gained.join(",")}>
      <div className="cu-head">
        <span className="cu-mark" aria-hidden="true">✓</span>
        <span className="cu-tx">
          <b>Your agents can now work on this computer.</b>
          <span>
            {countOf(names.length, "agent")} you already had{" "}
            {names.length === 1 ? "was" : "were"} made before Cloud9 gave every new agent the
            full working set, so Cloud9 brought {names.length === 1 ? "it" : "them"} up to the
            same reach when it started — once, by itself. {names.join(", ")}.
          </span>
        </span>
        <button className="primary small" data-caught-up-ok onClick={got}>Got it</button>
      </div>
      {gained.length > 0 && (
        <ul className="cu-grants">
          {gained.map(label => <li key={label}>{label}</li>)}
        </ul>
      )}
      {folderNames.length > 0 && said.homeFolder && (
        <p className="cu-folder">
          {folderNames.join(", ")} had no folder of yours opened up, so{" "}
          {folderNames.length === 1 ? "it now starts" : "they now start"} in{" "}
          <code className="folderpath">{said.homeFolder}</code>. A folder you chose yourself
          was never replaced.
        </p>
      )}
      {trusted.length > 0 && (
        <p className="cu-ask">
          <b>They were also given a setting they never had.</b> {trusted.join(", ")} had no
          answer stored for “how much may this agent do on its own”, which means{" "}
          <b>{trustLevel("askEveryTime").label.toLowerCase()}</b> — a card before every single
          job, which would have replaced one complaint with another. They now have what a new
          agent gets: <b>{trustLevel(said.trust).label.toLowerCase()}</b>.{" "}
          {trustLevel(said.trust).plainWords}
        </p>
      )}
      <p className="cu-keep">
        Nothing was taken away: no switch was turned off, no folder of yours was replaced, and
        this happens once — it will not run again. To change any of it, open the agent
        (the <b>✎</b> on its card in the crew list) and set the switches, the folder and the
        trust setting to whatever you want.
      </p>
    </div>
  );
}

/**
 * ONE STAT TILE — a number over the word for that many.
 *
 * The casting room printed **"1 CATEGORIES"** because the number came from a
 * list and the word was typed by hand beside it (Phase 6). This component takes
 * BOTH forms of the word, so a tile cannot be added without answering "what does
 * this say when there is one of them" — and where the answer is genuinely the
 * same phrase either way ("Waiting on you"), saying it twice is the author
 * stating that on purpose rather than forgetting to think about it.
 *
 * `plural` is still the one owner of the decision; this is where a tile asks it.
 */
function Stat({ n, one, many }: { n: number; one: string; many: string }): React.JSX.Element {
  return (
    <div className="stat" data-stat={one}>
      <div className="n">{n}</div>
      <div className="l">{plural(n, one, many)}</div>
    </div>
  );
}

/**
 * "LET ALL MY AGENTS WORK ON THIS COMPUTER" — ONE PRESS FOR THE WHOLE CREW.
 *
 * THE PROBLEM THIS IS, 2026-08-05. New agents are fully capable from the second
 * they exist. The six he already has — Architect, sonnet, Opus, Sol, terra,
 * Fable5 — were made before that and are stuck: they cannot run a command, reach
 * a file of his, or hand work to a helper. Fixing them by hand is six trips
 * through six editors, and he has said what he thinks of that.
 *
 * NOTHING IS CHANGED UNTIL HE PRESSES IT. A stored agent is his; the app does
 * not quietly rewrite one because a default moved. So this counts them, names
 * them, says exactly what it grants and that approvals still apply, and then
 * does all of them in one action.
 *
 * IT ONLY EVER ADDS. `bringUpToFullReach` cannot take a switch away or replace a
 * folder he chose, and it is the SAME function a new agent's defaults come from,
 * so "as capable as a new one" cannot come to mean two different things.
 *
 * IT DISAPPEARS WHEN IT IS DONE, because a button with nothing to do is a
 * question he has to answer every time he looks at this screen.
 */
function LetThemAllWork(): React.JSX.Element | null {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const home = useHomeFolder();
  const [done, setDone] = useState<number | null>(null);
  const mine = world.agents.filter(a => a.ownerId === world.me?.id) as AgentDef[];
  const behind = agentsWithoutFullReach(mine, home ?? undefined);

  if (done !== null) {
    return (
      <div className="crewupgrade is-done" data-crew-upgrade="done" data-crew-upgraded={done}>
        <span className="cu-mark" aria-hidden="true">✓</span>
        <span>
          <b>{countOf(done, "agent")} brought up to full reach.</b> They can run programs,
          reach your files and hand work to helper agents — and every one of those still
          stops and asks you first.
        </span>
      </div>
    );
  }
  if (mine.length === 0 || behind.length === 0) return null;

  const grant = (): void => {
    let changedCount = 0;
    for (const a of behind) {
      const next = bringUpToFullReach(a, home ?? undefined);
      if (!next.changed) continue;
      client.send({ type: "updateAgent", agent: next.agent });
      changedCount++;
    }
    setDone(changedCount);
  };

  return (
    <div className="crewupgrade" data-crew-upgrade="offer"
      data-crew-upgrade-count={behind.length}
      data-crew-upgrade-names={behind.map(a => a.name).join(",")}>
      <div className="cu-head">
        <span className="cu-mark" aria-hidden="true">▣</span>
        <span className="cu-tx">
          <b>Let all my agents work on this computer</b>
          <span>
            {countOf(behind.length, "agent")} you already have{" "}
            {behind.length === 1 ? "was" : "were"} made before Cloud9 gave every new agent
            the full working set — {behind.map(a => a.name).join(", ")}. One press brings{" "}
            {behind.length === 1 ? "it" : "them"} up to the same reach a new agent has.
          </span>
        </span>
        <button className="primary small" data-crew-upgrade-grant onClick={grant}>
          Let them all work
        </button>
      </div>
      {/* WHAT IT GRANTS, IN THE TABLE'S OWN WORDS — the same rows a new agent
          gets, read from the same place, so this list cannot drift from it. */}
      <ul className="cu-grants" data-crew-upgrade-grants={capabilitiesForNewAgent().map(c => c.ability).join(",")}>
        {capabilitiesForNewAgent().map(c => <li key={c.ability}>{c.label}</li>)}
      </ul>
      <p className="cu-ask">
        <b>You are still asked first.</b> Anything that changes this computer, spends your
        money or reaches an outside account stops and waits for you —{" "}
        {CAPABILITIES.filter(c => c.alwaysAsk).map(c => c.label.toLowerCase()).join("; ")}.
        This does not switch that off, and nothing can.
      </p>
      <p className="cu-folder" data-crew-upgrade-folder={home ?? ""}>
        {home
          ? <>Any of them with no folder of yours opened up starts in <code className="folderpath">{home}</code>.
            You can change or forget that on each agent's own page, any time.</>
          : <>Folders are left exactly as they are: this window cannot ask this computer
            where your home folder is, so it will not claim one.</>}
      </p>
      <p className="cu-keep">
        Nothing is taken away. A switch you turned off on purpose that a new agent does not
        get either — connected services — stays exactly as you left it.
      </p>
    </div>
  );
}

function CrewScreen({ onHire, onEdit, onOpen, onMarket, justHired }: {
  onHire: () => void;
  onEdit: (a: AgentDef) => void;
  onOpen: (id: ID, name: string) => void;
  onMarket: () => void;
  /** just hired from the casting room — say so, and say it is editable */
  justHired?: string | null;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [filter, setFilter] = useState<"all" | "working" | "waiting" | "off">("all");
  const agents = world.agents as AgentDefPlus[];

  /* THE SAME TWO ANSWERS THE ACTIVITY BOARD GIVES, not this screen's own.
     ================================================================
     Both numbers in the banner above were worked out here, separately, and both
     were wrong in the ways the Activity review had already named — one screen
     over, where nobody looked:

       · "Waiting on you" counted `status === "pending"` and nothing else, so a
         go-ahead that had already run out was still counted as waiting on him.
         `useMyApprovals` is the one owner of that question — the rail badge,
         the pill over a conversation, the jobs tray and the board all ask it.

       · "Working now" counted the presence word by itself. An agent that has
         stopped mid-job to ask him something still reads `working` there, so
         this screen said "1 working" while the Activity button and the board
         said nobody was. `agentActivityLine` is the one ladder that decides
         what "working" means, and now this screen climbs it too rather than
         keeping a shortcut of its own.

     No new rule is written here. Both numbers are read off the same functions
     the rest of the app reads them off, which is the whole point. */
  const { waiting: liveApprovals } = useMyApprovals(world.approvals, world.me?.id);
  const waitingOn = (id: ID) => liveApprovals.some(a => a.agentId === id);

  /* One line per agent, from the shared ladder. No run history is asked for —
     this screen only needs to know what each agent is DOING, and asking the hub
     about another person's agent's past jobs would be refused anyway. */
  const activityOf = (a: AgentDefPlus) => agentActivityLine({
    presence: presenceOf(world, a.id)?.presence,
    status: world.agentStatus[a.id],
    lifecycle: a.lifecycle,
    awaitingOwner: waitingOn(a.id),
  });
  const workingNow = workingCount(agents.map(activityOf));
  const waitingCount = agents.filter(a => waitingOn(a.id)).length;

  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const jobsThisMonth = world.tasks.filter(t => t.createdAt >= monthStart.getTime()).length;

  const shown = agents.filter(a => {
    /* THE FILTER AND THE NUMBER ABOVE IT MUST MEAN THE SAME THING. Pressing
       "Working" and getting more rows than the "Working now" figure said is the
       same contradiction, one click later. */
    if (filter === "working") return activityOf(a).state === "working";
    if (filter === "waiting") return waitingOn(a.id);
    if (filter === "off") {
      const p = presenceOf(world, a.id)?.presence;
      return p === "paused" || p === "offline";
    }
    return true;
  });

  const byProvider = (p: Provider) => agents.filter(a => (a.provider ?? "claude") === p).length;

  return (
    <div className="crew">
      <header className="crew-hero">
        <div>
          <span className="eyebrow">Cloud9 · the crew</span>
          {agents.length === 0
            ? <h1>Nobody on the<br />floor <em>yet</em>.</h1>
            : <h1>{countOf(agents.length, "hire")},<br />no <em>payroll</em>.</h1>}
          <p>
            Everyone here was written by you in plain words. They keep their own skills,
            run on the app you gave them, and stop at the line you drew.
          </p>
        </div>
        <div className="crew-stats">
          <Stat n={workingNow} one="Working now" many="Working now" />
          <Stat n={waitingCount} one="Waiting on you" many="Waiting on you" />
          <Stat n={jobsThisMonth} one="Job this month" many="Jobs this month" />
        </div>
      </header>

      <div className="crew-bar">
        <div className="seg" role="group" aria-label="Who to show">
          {([["all", "Everyone"], ["working", "Working"], ["waiting", "Waiting"], ["off", "Off duty"]] as const)
            .map(([key, label]) => (
              <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
            ))}
        </div>
        {byProvider("claude") > 0 && <span className="chip is-gold">Claude · {byProvider("claude")}</span>}
        {byProvider("codex") > 0 && <span className="chip is-ultra">Codex · {byProvider("codex")}</span>}
        <div className="grow" />
        <button className="btn tomarket" onClick={onMarket}>Browse the casting room</button>
        <button className="primary" onClick={onHire}>Write an agent</button>
      </div>

      {/* THE AGENTS HE ALREADY HAS, BROUGHT UP TO WHAT A NEW ONE GETS — one
          press for all of them, and nothing changes until he presses it. */}
      <LetThemAllWork />

      {/* The one thing he has to know after hiring: it is his now. */}
      {justHired && (
        <div className="hirednote" data-hired={justHired}>
          <span className="hn-mark" aria-hidden="true">✓</span>
          <span>
            <b>@{justHired}</b> is on the floor. Everything about them — the brief, the app,
            how far they can go, what you teach them — is yours to change, any time,
            from <b>Edit</b> on their card.
          </span>
        </div>
      )}

      {agents.length === 0 ? (
        <div className="crew-empty">
          <StudioScene />
          <h2>The plates are still blank</h2>
          <p>
            Write one agent in plain words — what it does, what it may touch, when it must stop and ask.
            Or hire one that is already written and change it afterwards.
          </p>
          <div className="crew-emptybtns">
            <button className="primary" onClick={onMarket}>Browse the casting room</button>
            <button className="btn" onClick={onHire}>Write your first agent</button>
          </div>
        </div>
      ) : (
        <div className="crew-grid">
          {shown.map((a, i) => {
            const provider = (a.provider ?? "claude") as Provider;
            const waiting = waitingOn(a.id);
            const pres = presenceOf(world, a.id);
            const busy = pres?.presence === "working";
            const says = presenceSays(world, a.id, pres);
            /* Waiting on him beats everything, because it is the only one he can
               do something about. Then a job that is stuck or fell over — the
               same one owner every other presence line asks. Otherwise the hub's
               own word, never ours. */
            const flag = waiting
              ? <span className="chip is-gold"><span className="dot wait" />Waiting on you</span>
              : says.trouble
                ? <span className={`chip presencepill introuble is-${says.trouble}`}>{says.word}</span>
                : <span className={`chip presencepill p-${pres?.presence ?? "unknown"}`}>
                  <span className={`pdot p-${pres?.presence ?? "unknown"}`} />
                  {pres ? PRESENCE_WORDS[pres.presence] : "Not looked yet"}
                </span>;
            return (
              <article className="cast" key={a.id} data-crew={a.name}
                data-presence={pres?.presence ?? "unknown"} data-trouble={says.trouble ?? ""}>
                <div className="plate">
                  <Portrait identity={a.name} fill working={busy} />
                  <span className="no">No. {String(i + 1).padStart(2, "0")}</span>
                  <span className="flag">{flag}</span>
                </div>
                <div className="info">
                  <h3>{a.name}</h3>
                  <div className="role">{roleOf(a.persona)}</div>
                  <div className="runs">
                    <span className={`chip ${provider === "claude" ? "is-gold" : "is-ultra"}`}>
                      {PROVIDER_LABEL[provider]}
                    </span>
                    <span className="chip" title={a.model ? undefined : MODEL_UNSET_HINT}>{modelWords(a.model)}</span>
                    {(a.skills?.length ?? 0) > 0 &&
                      <span className="chip">{countOf(a.skills!.length, "skill")}</span>}
                  </div>
                  <div className="now whocan" data-respond={a.respondTo ?? "owner"}>
                    <MarkGate />
                    <span>
                      {respondWords(a, a.ownerId === world.me?.id
                        ? "you"
                        : world.users.find(u => u.id === a.ownerId)?.name ?? "its owner")}
                    </span>
                  </div>
                  {/* HOW MUCH THIS ONE MAY DO UNATTENDED, ON THE CARD ITSELF.
                      A setting that only exists inside an editor is a setting he
                      has to remember he made — and this is the one setting where
                      forgetting means being surprised by what an agent did while
                      he was not looking. Only for HIS agents, like the supply
                      gap below: somebody else's trust setting is not his to
                      read or to change. One press on it opens the file at the
                      choice. */}
                  {a.ownerId === world.me?.id && (
                    <button className="now trustline" data-trust={trustOf(a)}
                      onClick={() => onEdit(a)} title="Change how much this agent does on its own">
                      <MarkGate />
                      <span>{trustWords(a)}</span>
                    </button>
                  )}
                  <div className="now nowpresence">
                    <MarkClock />
                    <span>
                      {waiting
                        ? "Waiting on your word before it carries on"
                        : says.trouble || pres
                          ? says.reason ? `${says.word} — ${says.reason}` : says.word
                          : NOT_YET_LOOKED}
                    </span>
                  </div>
                  {/* A SWITCH ON WITH NOTHING BEHIND IT, ON THE CARD ITSELF.
                      He should never have to open an agent's file to find out
                      that a power he switched on is handing it nothing — that
                      is exactly how he ended up believing the app was broken.
                      Only for HIS agents: nobody else can fix somebody's
                      settings, so telling them about it is noise. */}
                  {a.ownerId === world.me?.id &&
                    <SupplyGapBadge agent={a} onEdit={() => onEdit(a)} where="card" />}
                </div>
                <div className="castbtns">
                  <button className="btn small" onClick={() => onOpen(a.id, a.name)}>Talk to {a.name}</button>
                  {a.ownerId === world.me?.id &&
                    <button className="btn small" onClick={() => onEdit(a)}>Edit</button>}
                </div>
              </article>
            );
          })}
          <button className="cast cast-new castmarket" onClick={onMarket}>
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              {/* a headshot card, not a shopping bag: this is a place where you
                  look at people, not a checkout */}
              <rect x="3.5" y="4" width="12" height="16" rx="2" />
              <circle cx="9.5" cy="10" r="2.4" /><path d="M6 17a3.5 3.5 0 0 1 7 0" />
              <path d="M18.5 7.5v11.5a1.5 1.5 0 0 1-1.5 1.5" />
            </svg>
            <h3>The casting room</h3>
            <p>{countOf(MARKET_TEMPLATES.length, "role")} already written. Read the brief, pick the app, hire.</p>
          </button>
          <button className="cast cast-new" onClick={onHire}>
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="9" r="3.6" /><path d="M5 20a7 7 0 0 1 10.5-6" />
              <path d="M18 15.5v6M15 18.5h6" />
            </svg>
            <h3>Write your own</h3>
            <p>Describe the job in plain words. Cloud9 writes the agent for you.</p>
          </button>
        </div>
      )}
    </div>
  );
}

/* ================= 5b · THE CASTING ROOM (the marketplace) ================= */

/**
 * READY-WRITTEN AGENTS, SHIPPED INSIDE THE APP.
 *
 * No server, no download, no account: the catalogue is `market.ts`, compiled
 * into the app, so this screen works with the network unplugged. Hiring COPIES
 * a role into his crew as an ordinary agent — from that second it is his, and
 * every word of it is editable in the same editor as anything he wrote himself.
 *
 * Growing it takes no change here. The filter bar is built from
 * `MARKET_CATEGORIES` and the grid from `MARKET_TEMPLATES`, so a second
 * category is two pieces of data, not a redesign.
 */
function MarketScreen({ onHired, onBack, onWriteMyOwn }: {
  /** hand back the name we hired under, so the crew can point at it */
  onHired: (name: string) => void;
  onBack: () => void;
  onWriteMyOwn: () => void;
}): React.JSX.Element {
  const [category, setCategory] = useState<string>("all");
  const [open, setOpen] = useState<MarketTemplate | null>(null);

  const shown = MARKET_TEMPLATES.filter(t => category === "all" || t.category === category);
  const groups = MARKET_CATEGORIES.filter(c => shown.some(t => t.category === c.id));

  return (
    <div className="crew market">
      <header className="crew-hero">
        <div>
          <span className="eyebrow">Cloud9 · the casting room</span>
          <h1>Hire someone<br />already <em>written</em>.</h1>
          <p>
            {countOf(MARKET_TEMPLATES.length, "role")} that ship inside Cloud9 — no download, no account,
            and they work with the internet off. Hiring one copies it onto your floor,
            where you can change every word of it.
          </p>
        </div>
        <div className="crew-stats">
          <Stat n={MARKET_TEMPLATES.length} one="Role ready" many="Roles ready" />
          <Stat n={MARKET_CATEGORIES.length} one="Category" many="Categories" />
        </div>
      </header>

      <div className="crew-bar">
        <div className="seg" role="group" aria-label="Which roles to show">
          <button aria-pressed={category === "all"} onClick={() => setCategory("all")}>All roles</button>
          {MARKET_CATEGORIES.map(c => (
            <button key={c.id} data-cat={c.id} aria-pressed={category === c.id}
              onClick={() => setCategory(c.id)}>{c.label}</button>
          ))}
        </div>
        <div className="grow" />
        <button className="btn small ghost marketback" onClick={onBack}>← Crew</button>
        <button className="btn small" onClick={onWriteMyOwn}>Write my own instead</button>
      </div>

      {groups.map(group => (
        <section className="marketgroup" key={group.id} data-group={group.id}>
          <div className="mg-head">
            <h2>{group.label}</h2>
            <p>{group.blurb}</p>
          </div>
          <div className="crew-grid">
            {shown.filter(t => t.category === group.id).map(t => (
              <article className="cast role" key={t.id} data-role={t.id}>
                {/* THE SAME FACE IT WILL WEAR ON THE FLOOR. A portrait is drawn
                    from the name, and hiring keeps the name — so the picture he
                    picks a role by is the picture his crew shows afterwards. An
                    emoji was a placeholder that never became the person. */}
                <div className="plate roleplate"><Portrait identity={t.name} fill /></div>
                <div className="info">
                  <h3>{t.title}</h3>
                  <div className="role">{t.tagline}</div>
                  <div className="runs">
                    <span className={`chip ${t.suggestedApp === "claude" ? "is-gold" : "is-ultra"}`}>
                      Suggested: {PROVIDER_LABEL[t.suggestedApp]}
                    </span>
                    <span className="chip">@{t.name}</span>
                  </div>
                  <ul className="roleasks">
                    {t.askItFor.map(a => <li key={a}>{a}</li>)}
                  </ul>
                </div>
                <div className="castbtns">
                  <button className="primary small rolesee" onClick={() => setOpen(t)}>
                    Read the brief
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ))}

      {open && (
        <HireModal template={open} onClose={() => setOpen(null)}
          onHired={name => { setOpen(null); onHired(name); }} />
      )}
    </div>
  );
}

/**
 * THE BRIEF, IN FULL, AND THE ONE DECISION HE MAKES BEFORE HIRING.
 *
 * He reads the words the agent will actually be given — no summary stands in
 * for them — and picks which app runs it. The model list is the REAL one from
 * his signed-in app (the same hook the editor uses), so this screen can never
 * offer a model that does not exist.
 *
 * `respondTo` is fixed at "owner", the same default a hand-written agent gets.
 * An agent hired in two clicks must not be more open than one typed out.
 */
function HireModal({ template, onClose, onHired }: {
  template: MarketTemplate;
  onClose: () => void;
  onHired: (name: string) => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [provider, setProvider] = useState<Provider>(template.suggestedApp as Provider);
  const { ids, fallback, preferred } = useModels(provider);
  const [model, setModel] = useState<string>(preferred);
  useEffect(() => { if (!ids.includes(model)) setModel(preferred); }, [provider, ids.join(","), model]);
  /* Finding UI-2 was exactly this line being missing. It is not a line to
     remember any more — it is the one owner every overlay calls. */
  useEscapeCloses(onClose);

  /* Two hires of the same role are two agents, and an @name is how everyone
     points at one — so the second gets its own. The relay is still the judge
     of a name it will accept; this only stops the obvious collision. */
  const takenNames = world.agents.map(a => a.name.toLowerCase());
  const hireName = (() => {
    if (!takenNames.includes(template.name.toLowerCase())) return template.name;
    for (let n = 2; n < 50; n++) {
      if (!takenNames.includes(`${template.name}-${n}`.toLowerCase())) return `${template.name}-${n}`;
    }
    return `${template.name}-${Date.now().toString().slice(-4)}`;
  })();

  const on = abilitiesOn(template);

  const hire = () => {
    client.send({
      type: "createAgent",
      agent: agentFromTemplate(template, { name: hireName, provider, model }),
    });
    onHired(hireName);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel hirepanel" onClick={e => e.stopPropagation()}>
        <div className="head">
          {/* seeded on the name it will really be hired under, so a second
              Architect shows the second Architect's face, not the first's */}
          <span className="hireface"><Portrait identity={hireName} size={34} /></span>
          <span className="hiretitle">{template.title}</span>
          <span className="eyebrow">hired as @{hireName}</span>
        </div>
        <div className="body">
          <p className="hiretag">{template.tagline}</p>

          <div className="field-row">
            <label>What they are told to do</label>
            <div className="briefbox" data-brief={template.id}>{template.persona}</div>
          </div>

          <div className="field-row">
            <label>What they can touch</label>
            <div className="abilitywords">
              {on.length === 0
                ? <span className="ab-none">Nothing beyond talking to you.</span>
                : on.map(key => <span className="chip" key={key} data-ability={key}>{abilityWords(key)}</span>)}
              <span className="ab-note">
                Anything that changes this computer or spends money stops and asks you first.
                You can change every switch afterwards.
              </span>
            </div>
          </div>

          <div className="field-row">
            <label>Who can set them working</label>
            <div className="abilitywords">
              <span className="chip">Just you</span>
              <span className="ab-note">
                They run on your computer and your account pays, so nobody else can start them
                until you say so.
              </span>
            </div>
          </div>

          <div className="two">
            <div className="field-row">
              <label>App</label>
              <select className="select hireapp" value={provider}
                onChange={e => setProvider(e.target.value as Provider)}>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </div>
            <div className="field-row">
              <label>Model</label>
              <select className="select hiremodel" value={ids.includes(model) ? model : preferred}
                onChange={e => setModel(e.target.value)}>
                {ids.map(id => <option key={id} value={id}>{modelLabel(id)}</option>)}
              </select>
            </div>
          </div>
          <p className="sec-note">
            {template.whyThatApp} {fallback
              ? "This is the list Cloud9 ships with — sign the app in under Settings for its own."
              : ""}
          </p>
        </div>
        <div className="foot">
          <button className="subtle" onClick={onClose}>Not now</button>
          <button className="primary hirebtn" onClick={hire}>Hire {hireName}</button>
        </div>
      </div>
    </div>
  );
}

/* ================= 9 · QUICK CHAT (Ctrl K) ================= */

function QuickChat({ onClose, standalone }: { onClose?: () => void; standalone?: boolean }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [sel, setSel] = useState(0);
  const [text, setText] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  /* The one owner of "Escape closes what it opened". In its own window there is
     no overlay to close, so Escape closes the window — the same intent. */
  const leave = useCallback(() => {
    onClose?.();
    if (standalone) window.close();
  }, [onClose, standalone]);
  useEscapeCloses(leave);

  const targets = [
    ...world.agents.map(a => ({ id: a.id, label: `${a.emoji} ${a.name}`, name: a.name, kind: "agent" as const })),
    ...world.channels.filter(c => c.kind === "channel").map(c => ({ id: c.id, label: `# ${c.name}`, name: c.name, kind: "channel" as const })),
  ];

  const fire = () => {
    const t = targets[sel];
    if (!t || !text.trim()) return;
    /* THE SAME ONE RULE the composer follows (A3): quick chat is a box he types
       into too, and a refusal must not cost him the words. Asked once, here,
       before anything is sent or cleared. */
    const bad = validateMessageText(text.trim());
    if (bad) { client.notify(bad); return; }
    if (t.kind === "channel") {
      client.send({ type: "send", channelId: t.id, text: text.trim() });
    } else {
      const dm = world.channels.find(c => c.kind === "dm" && c.memberIds.includes(t.id));
      if (dm) client.send({ type: "send", channelId: dm.id, text: text.trim() });
      else {
        client.send({ type: "createChannel", name: `dm-${slug(t.name)}`, memberIds: [t.id], kind: "dm" });
        setTimeout(() => {
          const w = client.getSnapshot();
          const created = w.channels.find(c => c.kind === "dm" && c.memberIds.includes(t.id));
          if (created) client.send({ type: "send", channelId: created.id, text: text.trim() });
        }, 300);
      }
    }
    setSent(`Sent to ${t.label} ✓`);
    setText("");
    setTimeout(() => { setSent(null); onClose?.(); if (standalone) window.close(); }, 900);
  };

  const chosen = targets[sel];

  const body = (
    <div className="qc" onClick={e => e.stopPropagation()}>
      <div className="qc-top">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="var(--marigold)"
          strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M13.5 3 5 13.5h5.6L9.8 21l8.7-10.6h-5.7Z" />
        </svg>
        <input
          ref={inputRef} className="qc-input" value={text}
          placeholder="Ask anyone, or start a job…"
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSel(i => (i + 1) % targets.length); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel(i => (i - 1 + targets.length) % targets.length); }
            if (e.key === "Enter") fire();
            /* Escape is NOT handled here — `useEscapeCloses` above owns it for
               every overlay in the app, so this box cannot answer it its own way. */
          }}
        />
        <span className="kbd">Esc</span>
      </div>
      {targets.length === 0 && (
        <div className="qc-empty">Nowhere to send yet. Write an agent or make a channel first.</div>
      )}
      <div className="qc-list">
        {targets.length > 0 && <span className="eyebrow" style={{ display: "block", padding: "8px 11px 5px" }}>Send to</span>}
        {targets.map((t, i) => (
          <div key={t.id} className={`qc-opt ${i === sel ? "on" : ""}`} onClick={() => setSel(i)}>
            {t.kind === "agent"
              ? <AgentFace name={t.name} size={30} />
              : <span className="hash qc-mark">#</span>}
            <span className="qc-lbl">{t.name}</span>
            <span className="qc-kind">{t.kind === "agent" ? "agent" : "channel"}</span>
            {i === sel && <span className="kbd">Enter</span>}
          </div>
        ))}
      </div>
      <div className={`qc-foot ${sent ? "sent" : ""}`}>
        <span className="eyebrow">
          {sent ?? (chosen
            ? chosen.kind === "agent"
              ? `${chosen.name} will answer in your direct chat — nothing is posted to a channel`
              : `This goes to #${chosen.name}, where everyone sees it`
            : "Nothing is posted until you pick somewhere to send it")}
        </span>
        <span className="grow" />
        <span className="kbd">↑↓</span><span className="kbd">↵ send</span>
      </div>
    </div>
  );

  if (standalone) return <div style={{ paddingTop: 20 }}>{body}</div>;
  return <div className="qc-veil" role="dialog" aria-modal="true" aria-label="Quick chat" onClick={onClose}>{body}</div>;
}

/* ================= model picker (his 5, 6) ================= */

/** The models this harness really offers, or the documented set until it says. */
/* WHAT A BRAND NEW AGENT STARTS WITH is `NEW_AGENT_ABILITIES`, imported at the
   top of this file from the engine's capability table.
 *
 * IT USED TO BE TYPED HERE, and it was a SUBSET — web search and background jobs
 * and nothing else. That is why every agent he made opened by explaining what it
 * was not: "I can't run git, npm, or build commands; create branches; push PRs;
 * or delegate the work to other agents. Those need switches you'd have to turn
 * on." He does not want to turn on switches. So the default is now the top rung,
 * it is DERIVED from the table (a capability written tomorrow is granted the day
 * it is written), and the reason that is safe rather than reckless — the
 * approval card, owner-only driving, per-turn tool declaration, his own Claude
 * Code setup shut out — is written where the table is.
 *
 * A hired role still only ever says which switches it wants ON, and it is laid
 * on top of this. Nothing about hiring can take a power away. */

/** The same answer, for approvals. A hire is no more permissive than a hand-written agent. */
const NEW_AGENT_APPROVALS: AgentApprovals = { background: false, schedules: false };

/**
 * THE FIELDS A HIRE IS MADE OF — and the reason this is a function rather than
 * an object literal inside the hire panel.
 *
 * Hiring used to hand-assemble its own `createAgent` frame, field by field,
 * beside the editor's. Two independent answers to "what is an agent made of",
 * and nothing holding them together: anything the editor grew, the catalogue
 * quietly did not, and a role hired in two clicks was a slightly different
 * animal from one typed out — which is exactly what Vikas found. There is one
 * answer now, and both paths spell it the same way because they call it.
 *
 * It starts from `NEW_AGENT_ABILITIES` and lays only the switches the role asks
 * for on top, so an ability added to the model tomorrow is absent here too, and
 * absent means off (`@cloud9/shared`). Nobody is handed the power to run
 * programs by a catalogue entry arriving.
 */
function agentFromTemplate(
  template: MarketTemplate,
  chosen: { name: string; provider: Provider; model: string },
): Omit<AgentDef, "id" | "ownerId" | "createdAt"> {
  return {
    name: chosen.name,
    emoji: template.emoji,
    persona: template.persona,
    abilities: { ...NEW_AGENT_ABILITIES, ...template.abilities },
    approvals: NEW_AGENT_APPROVALS,
    provider: chosen.provider,
    model: chosen.model,
    skills: [],
    lifecycle: "enabled",
    // the same default a hand-written agent gets: nobody but him sets it working
    respondTo: "owner",
    respondToAllowlist: [],
    // …and the same default for how much it may do on its own. A role hired in
    // two clicks must not be a quieter or a louder animal than one typed out —
    // that split is the whole reason this function exists. It is written down as
    // a real stored value, never left to the field's absence.
    trust: NEW_AGENT_TRUST,
    // …and the same for whose setup it runs in: a role hired in two clicks gets
    // exactly what a hand-written agent gets, written down rather than inferred.
    useOwnerSetup: NEW_AGENT_USE_OWNER_SETUP,
  };
}

function useModels(provider: Provider): { ids: string[]; fallback: boolean; preferred: string } {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const info = world.harness?.[provider];
  const live = Array.isArray(info?.models) ? info!.models!.filter(m => typeof m === "string" && m) : [];
  const ids = live.length > 0 ? live : MODEL_FALLBACK[provider];
  const wanted = info?.defaultModel ?? prefs.get().defaultModel?.[provider] ?? MODEL_DEFAULT[provider];
  return { ids, fallback: live.length === 0, preferred: ids.includes(wanted) ? wanted : ids[0] };
}

/* ================= skills (his 9) ================= */

function SkillsEditor({ skills, onChange, agentName, roleId }: {
  skills: AgentSkill[];
  onChange: (next: AgentSkill[]) => void;
  /** whose list this is, so the library can say where a skill is going */
  agentName?: string;
  /**
   * The casting-room role this agent was hired as, if we know it THIS SECOND.
   * Only ever known at the hiring moment — an agent does not remember which
   * template it came from — so it is optional and its absence changes nothing
   * but the order. Never guessed.
   */
  roleId?: string | null;
}): React.JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<AgentSkill>({ id: "", name: "", description: "", instructions: "" });
  const [note, setNote] = useState<string | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);

  const startAdd = () => {
    setDraft({ id: newId(), name: "", description: "", instructions: "" });
    setOpenId(null);
    setAdding(true);
  };
  const startEdit = (s: AgentSkill) => {
    setDraft({ ...s });
    setAdding(false);
    setOpenId(s.id);
  };
  const cancel = () => { setAdding(false); setOpenId(null); };

  const save = () => {
    const name = draft.name.trim();
    const instructions = draft.instructions.trim();
    if (!name) { setNote("Give the skill a name first."); return; }
    if (name.length > SKILL_LIMITS.name) { setNote(`That name is too long — keep it under ${SKILL_LIMITS.name} characters.`); return; }
    if (!instructions) { setNote("Write what the agent should do — a skill without instructions cannot be saved."); return; }
    if (instructions.length > SKILL_LIMITS.instructions) { setNote("Those instructions are too long. Trim them a little."); return; }
    if (draft.description.trim().length > SKILL_LIMITS.description) { setNote("Keep the one-line description shorter."); return; }
    if (!skills.some(s => s.id === draft.id) && skills.length >= SKILL_LIMITS.perAgent) {
      setNote(`One agent can hold ${countOf(SKILL_LIMITS.perAgent, "skill")}. Delete one first.`); return;
    }
    const clean: AgentSkill = {
      id: draft.id || newId(),
      name,
      description: draft.description.trim(),
      instructions,
      // The files ride along. Rebuilding this object field-by-field WITHOUT
      // them is how editing a skill used to silently delete its documents.
      ...(draft.files && draft.files.length > 0 ? { files: draft.files } : {}),
    };
    const i = skills.findIndex(s => s.id === clean.id);
    onChange(i >= 0 ? skills.map(s => (s.id === clean.id ? clean : s)) : [...skills, clean]);
    setNote(null);
    cancel();
  };

  const remove = (id: string) => {
    onChange(skills.filter(s => s.id !== id));
    if (openId === id) cancel();
  };

  /**
   * Read one uploaded file into a skill. The text goes BOTH places, and each
   * does its own job: `instructions` is what the agent is told in the prompt,
   * `files[]` is what actually lands in the agent's folder.
   */
  const readSkillFile = async (file: File): Promise<{ skill?: AgentSkill; problem?: string }> => {
    if (!/\.(md|txt)$/i.test(file.name)) {
      return { problem: "Only .md and .txt files can be read." };
    }
    const body = (await file.text()).trim();
    if (!body) return { problem: `${file.name} is empty, so there is nothing to teach.` };
    if (body.length > SKILL_LIMITS.fileText) {
      return { problem: `${file.name} is too big — keep a skill file under ${Math.round(SKILL_LIMITS.fileText / 1000)}k characters.` };
    }
    // Same rule the relay and the engine use, so a name this app accepts is a
    // name that really becomes a file — refuse, never rewrite.
    const keepFile = isSafeFileName(file.name);
    const trimmed = body.length > SKILL_LIMITS.instructions;
    const attached: AgentSkillFile[] = keepFile ? [{ name: file.name, text: body }] : [];
    const instructions = trimmed
      ? `${body.slice(0, SKILL_LIMITS.instructions - 160).trim()}\n\n` +
        (keepFile
          ? `(The rest is in your folder as ${file.name} — read it before you start.)`
          : "(This note was shortened to fit.)")
      : body;
    return {
      skill: {
        id: newId(),
        name: file.name.replace(/\.(md|txt)$/i, "").slice(0, SKILL_LIMITS.name),
        description: `From ${file.name}`.slice(0, SKILL_LIMITS.description),
        instructions,
        ...(attached.length > 0 ? { files: attached } : {}),
      },
      problem: keepFile ? undefined
        : `${file.name} was read, but that file name can't become a real file — the text was kept as instructions only.`,
    };
  };

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const added: AgentSkill[] = [];
    let problem: string | null = null;
    for (const file of Array.from(files)) {
      if (skills.length + added.length >= SKILL_LIMITS.perAgent) {
        problem = `One agent can hold ${countOf(SKILL_LIMITS.perAgent, "skill")}. Delete one first.`; break;
      }
      const r = await readSkillFile(file);
      if (r.problem) problem = r.problem;
      if (r.skill) added.push(r.skill);
    }
    if (added.length > 0) {
      onChange([...skills, ...added]);
      const withFiles = added.filter(s => (s.files?.length ?? 0) > 0).length;
      setNote(
        `Added ${countOf(added.length, "skill")}` +
        (withFiles > 0 ? `, and ${withFiles === 1 ? "its file goes" : "their files go"} into the agent's folder.` : ".") +
        (problem ? ` ${problem}` : ""));
    } else if (problem) {
      setNote(problem);
    }
  };

  /** Attach a document to the skill being edited, without leaving the form. */
  const attachToDraft = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const kept: AgentSkillFile[] = [...(draft.files ?? [])];
    let problem: string | null = null;
    for (const file of Array.from(files)) {
      if (kept.length >= SKILL_LIMITS.files) {
        problem = `One skill can carry ${countOf(SKILL_LIMITS.files, "file")}.`; break;
      }
      const r = await readSkillFile(file);
      const attached = r.skill?.files?.[0];
      if (!attached) { problem = r.problem ?? "That file could not be read."; continue; }
      if (kept.some(f => f.name === attached.name)) {
        kept[kept.findIndex(f => f.name === attached.name)] = attached; // replace, don't duplicate
      } else {
        kept.push(attached);
      }
    }
    setDraft(d => ({ ...d, files: kept }));
    setNote(problem ?? `${countOf(kept.length, "file")} will go into the agent's folder when you save.`);
  };

  const detach = (fileName: string) =>
    setDraft(d => ({ ...d, files: (d.files ?? []).filter(f => f.name !== fileName) }));

  /**
   * TAKE ONE OFF THE SHELF — and this is the whole of it.
   *
   * `skillFromLibrary` hands back a plain `AgentSkill` with nothing pointing
   * back at the library, and it goes into the very same array every skill he
   * typed goes into. There is deliberately NO second list, no flag, no badge
   * and no branch anywhere below this line: the row it draws, the pencil that
   * edits it and the bin that deletes it are the ones that were already there.
   * A hired agent that felt second-class is the mistake this avoids repeating.
   */
  const takeFromLibrary = (lib: LibrarySkill, replaceId?: string) => {
    const made = skillFromLibrary(lib, newId());
    if (replaceId) {
      onChange(skills.map(s => (s.id === replaceId
        // his files stay: the words are being replaced, not the documents.
        ? { ...made, id: s.id, ...(s.files && s.files.length > 0 ? { files: s.files } : {}) }
        : s)));
      setNote(`“${lib.name}” was rewritten from the library. Any files you attached are still on it.`);
    } else {
      onChange([...skills, made]);
      setNote(`“${lib.name}” is now one of ${agentName ? `${agentName}'s` : "this agent's"} skills — change any word of it with the pencil.`);
    }
  };

  return (
    <div className="skills">
      <div className="skillhead">
        <span className="eyebrow">
          {skills.length} taught{skills.filter(s => (s.files?.length ?? 0) > 0).length > 0
            ? ` · ${skills.filter(s => (s.files?.length ?? 0) > 0).length} with files` : ""}
        </span>
        <div className="skillheadbtns">
          <button className="btn small skill-add" onClick={startAdd}>＋ Write a skill</button>
          <button className="btn small skill-library-open" onClick={() => setLibraryOpen(true)}>
            ◆ Take one from the library
          </button>
          <label className="skill-uploadlabel">
            ⬆ Upload a file
            <input className="skill-upload" type="file" accept=".md,.txt" multiple
              onChange={e => { void upload(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
      </div>

      {skills.length === 0 && !adding && (
        <div className="skillempty">
          No skills yet. A skill is a short note telling this agent how to do one job —
          for example “Weekly report: pull the week's notes and write five bullet points.”
          Write your own, or take one of the {SKILL_LIBRARY.length} ready-written ones
          from the library.
        </div>
      )}

      {skills.map(s => (
        <div className="skillrow" key={s.id} data-skill={s.name}>
          <span className="skillmark" aria-hidden="true">◆</span>
          <span className="skillmain">
            <span className="skill-name">{s.name}</span>
            <span className="skill-desc">{s.description || "No description yet."}</span>
            {(s.files?.length ?? 0) > 0 && (
              <span className="skill-files" title={s.files!.map(f => f.name).join(", ")}>
                📎 {countOf(s.files!.length, "file")} in the agent's folder
              </span>
            )}
          </span>
          <button className="iconbtn skill-edit" title={`Edit ${s.name}`} onClick={() => startEdit(s)}>✎</button>
          <button className="iconbtn skill-delete" title={`Delete ${s.name}`} onClick={() => remove(s.id)}>🗑</button>
        </div>
      ))}

      {(adding || openId) && (
        <div className="skillform">
          <div className="field-row">
            <label>Skill name</label>
            <input className="input skill-name-input" type="text" value={draft.name}
              placeholder="Weekly report"
              onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
          </div>
          <div className="field-row">
            <label>What does it do?</label>
            <input className="input skill-desc-input" type="text" value={draft.description}
              placeholder="Writes the Monday summary of last week"
              onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} />
          </div>
          <div className="field-row">
            <label>How should it do it?</label>
            <textarea className="textarea skill-instructions-input" rows={4} value={draft.instructions}
              placeholder="Read the notes from the last seven days. Write five bullet points: what moved, what stalled, what needs me."
              onChange={e => setDraft(d => ({ ...d, instructions: e.target.value }))} />
          </div>
          <div className="field-row">
            <label>Files this skill needs <span className="hint">dropped into the agent's own folder</span></label>
            <div className="skillfiles">
              {(draft.files ?? []).map(f => (
                <span className="skillfile" key={f.name} data-skillfile={f.name}>
                  📎 {f.name}
                  <button className="skillfile-x" aria-label={`Remove ${f.name}`}
                    onClick={() => detach(f.name)}>✕</button>
                </span>
              ))}
              {(draft.files ?? []).length === 0 && <span className="skillfile-none">No files attached.</span>}
              <label className="skill-attachlabel">
                ⬆ Attach a file
                <input className="skill-attach" type="file" accept=".md,.txt" multiple
                  onChange={e => { void attachToDraft(e.target.files); e.target.value = ""; }} />
              </label>
            </div>
          </div>
          <div className="skillformbtns">
            <button className="subtle" onClick={cancel}>Cancel</button>
            <button className="primary skill-save" onClick={save}>Save skill</button>
          </div>
        </div>
      )}

      {note && <div className="notice skillnote">{note}</div>}

      {libraryOpen && (
        <SkillLibraryPanel
          have={skills} agentName={agentName} roleId={roleId ?? null}
          onClose={() => setLibraryOpen(false)}
          onTake={takeFromLibrary}
        />
      )}
    </div>
  );
}

/* ================= 5c · THE SKILL LIBRARY ==================================
 *
 * READY-WRITTEN SKILLS, SHIPPED INSIDE THE APP — the same idea as the casting
 * room, one floor down. No server, no download, no account: the catalogue is
 * `skill-library.ts` in `@cloud9/shared`, compiled into the app, so it works
 * with the network unplugged.
 *
 * THE PROMISE THIS SCREEN KEEPS. Taking a skill produces an ORDINARY skill.
 * It lands in the same list, wears no badge, carries no mark saying where it
 * came from, and is edited and deleted by the same two buttons as one he typed
 * out himself. He hired a role once and found it was second-class; a skill
 * taken from a shelf must never be.
 *
 * Nothing here is hard-coded. The filter bar and the group headings are built
 * from `SKILL_CATEGORIES`, the cards from `SKILL_LIBRARY`, and the ordering
 * from `librarySkillsFor` — so a sixth shelf or a sixteenth skill is two pieces
 * of data and no change to this file.
 */
function SkillLibraryPanel({ have, agentName, roleId, onClose, onTake }: {
  /** what the agent already holds — for the room left, and for "already there" */
  have: AgentSkill[];
  agentName?: string;
  /** the casting-room role, when it is known this second; null otherwise */
  roleId: string | null;
  onClose: () => void;
  onTake: (lib: LibrarySkill, replaceId?: string) => void;
}): React.JSX.Element {
  const [shelf, setShelf] = useState<string>("all");
  const [reading, setReading] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  useEscapeCloses(onClose);

  /* THE ORDER, AND THE ONE PLACE IT IS DECIDED. With a role known this second
     the ones written for that role come first; with no role it is the natural
     order, which the library itself calls a sensible default rather than an
     error. Never guessed from a name or a persona. */
  const ordered = librarySkillsFor(roleId ?? "");
  const suggested = roleId ? ordered.filter(s => s.recommendedFor.includes(roleId)) : [];

  const room = SKILL_LIMITS.perAgent - have.length;
  const full = room <= 0;

  /** the skill already on the agent with this name, if there is one */
  const clash = (lib: LibrarySkill): AgentSkill | undefined =>
    have.find(s => s.name.trim().toLowerCase() === lib.name.trim().toLowerCase());

  const shown = shelf === "all" ? ordered
    : shelf === "suggested" ? suggested
      : ordered.filter(s => s.category === shelf);

  /* Groups are drawn only when there is more than one shelf in view, so a
     filtered list is a list rather than a list under a heading of itself. */
  const groups = shelf === "all"
    ? SKILL_CATEGORIES.filter(c => shown.some(s => s.category === c.id))
    : [];

  const card = (s: LibrarySkill): React.JSX.Element => {
    const already = clash(s);
    const open = reading === s.id;
    return (
      <article className="libskill" key={s.id} data-libskill={s.id}
        data-taken={already ? "yes" : "no"}>
        <div className="ls-head">
          <span className="ls-mark" aria-hidden="true">{s.emoji}</span>
          <h4>{s.name}</h4>
          {roleId && s.recommendedFor.includes(roleId) && (
            <span className="chip is-gold ls-forrole">Written for this role</span>
          )}
        </div>
        <p className="ls-desc">{s.description}</p>

        <button className="linkbtn ls-read" aria-expanded={open}
          onClick={() => setReading(open ? null : s.id)}>
          {open ? "Hide what it tells the agent to do" : "Read what it tells the agent to do"}
        </button>
        {open && <div className="ls-instructions" data-libinstructions={s.id}>{s.instructions}</div>}

        <div className="ls-foot">
          {/* WHERE IT CAME FROM. Small, at the bottom, and always there — he can
              go and read the original rather than take our word for it. */}
          <span className="ls-source">Taken from: {s.source}</span>
          {already ? (
            confirming === s.id ? (
              <span className="ls-confirm">
                <span className="ls-confirmtx">
                  Replace the words in your “{already.name}”?
                </span>
                <button className="subtle small" onClick={() => setConfirming(null)}>Keep mine</button>
                <button className="primary small ls-replace"
                  onClick={() => { onTake(s, already.id); setConfirming(null); }}>Replace</button>
              </span>
            ) : (
              <span className="ls-confirm">
                <span className="ls-already">Already on this agent.</span>
                <button className="btn small ls-replaceask" onClick={() => setConfirming(s.id)}>
                  Replace it with this
                </button>
              </span>
            )
          ) : (
            <button className="primary small ls-take" disabled={full}
              onClick={() => onTake(s)}>
              {agentName ? `Give it to ${agentName}` : "Add to this agent"}
            </button>
          )}
        </div>
      </article>
    );
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel librarypanel" onClick={e => e.stopPropagation()}>
        <div className="head">
          <span className="ls-headmark" aria-hidden="true">◆</span>
          <span className="hiretitle">The skill library</span>
          <span className="eyebrow">{agentName ? `for @${agentName}` : "ready-written"}</span>
        </div>
        <div className="body">
          <p className="hiretag">
            {countOf(SKILL_LIBRARY.length, "ready-written skill")} that ship inside Cloud9 — no download,
            no account, and they work with the internet off. Taking one copies its words onto
            this agent, where you can change or delete every one of them.
          </p>

          {/* SAY IT BEFORE HE PICKS, not after he is refused. */}
          <div className="libroom" data-full={full ? "yes" : "no"}>
            {full
              ? `This agent already holds ${countOf(SKILL_LIMITS.perAgent, "skill")}, which is as many as one can hold. Delete one before taking another.`
              : `${have.length} of ${SKILL_LIMITS.perAgent} taught · room for ${room} more`}
          </div>

          <div className="seg libseg" role="group" aria-label="Which skills to show">
            <button data-shelf="all" aria-pressed={shelf === "all"}
              onClick={() => setShelf("all")}>All skills</button>
            {/* only offered when a role is actually known — absent means absent */}
            {suggested.length > 0 && (
              <button data-shelf="suggested" aria-pressed={shelf === "suggested"}
                onClick={() => setShelf("suggested")}>Written for this role</button>
            )}
            {SKILL_CATEGORIES.map(c => (
              <button key={c.id} data-shelf={c.id} aria-pressed={shelf === c.id}
                onClick={() => setShelf(c.id)}>{c.label}</button>
            ))}
          </div>

          {shelf === "all"
            ? groups.map(g => (
              <section className="libgroup" key={g.id} data-libgroup={g.id}>
                <div className="lg-head">
                  <h5>{g.label}</h5>
                  <p>{g.blurb}</p>
                </div>
                <div className="libgrid">
                  {shown.filter(s => s.category === g.id).map(card)}
                </div>
              </section>
            ))
            : <div className="libgrid">{shown.map(card)}</div>}

          {shown.length === 0 && (
            <div className="skillempty">Nothing on that shelf yet.</div>
          )}
        </div>
        <div className="foot">
          <span className="ls-footnote">
            A skill you take is yours — the same pencil and the same bin as one you wrote.
          </span>
          <button className="primary librarydone" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

/* ================= what the switches really are, per app =================
 *
 * TWO LIES ARE POSSIBLE HERE AND THIS SHOWS BOTH SIDES SO NEITHER CAN BE TOLD.
 *
 * The first is the one we already knew about: a Claude agent's switches really
 * are the whole boundary, and a Codex agent's are not — Codex holds shell and
 * file tools at every setting and the switches only decide WHERE it may write.
 * Showing one reassuring sentence for both apps tells him something false about
 * one of them.
 *
 * The second is the same lie in reverse, and it appeared the day the ceiling was
 * raised: a screen that says only "nothing else reaches it" now UNDERSTATES what
 * he has switched on. So `ceiling` is shown beside `headline`, always.
 *
 * Everything here is read from `isolationFor()` — measured by running the real
 * command lines, with the version and date it was measured on printed at the
 * bottom so a stale claim is visible rather than invisible. Nothing on this card
 * is written here. An app we have never measured gets NO sentence at all, because
 * falling back to the comforting one is how this goes wrong.
 */
function HarnessHonesty({ provider, forcedOn, mode = "declared" }: {
  provider: Provider;
  /**
   * WHOSE SETUP THE AGENT BEING EDITED RUNS IN. The card's whole answer turns on
   * it: with his own setup loaded, his connected services bring tools the
   * switches never granted, his instructions steer the agent and his hooks run —
   * measured 2026-08-05, an agent limited to three built-in tools arrived at the
   * model holding 127. `isolationFor` owns that difference so this screen cannot
   * describe it a second, drifting way.
   */
  mode?: "declared" | "owner";
  /**
   * The switches this app keeps on whatever the owner set — handed in from the
   * editor so this card, the switch list and the ladder are reading ONE answer
   * (`effectiveAbilities`). A card that worked it out for itself is how two
   * views of one fact start disagreeing.
   */
  forcedOn: Capability[];
}): React.JSX.Element {
  const iso = isolationFor(provider, mode);
  if (!iso) {
    return (
      <div className="notice harnessunknown">
        Nobody has measured what a {PROVIDER_LABEL[provider] ?? provider} agent really carries,
        so nothing on this screen is a promise about it.
      </div>
    );
  }
  return (
    <div className="harnesshonest" data-harness={iso.harness}
      data-boundary={iso.togglesAreTheBoundary ? "yes" : "no"}>
      <p className="hh-line" data-field="headline">{iso.headline}</p>
      <p className="hh-line hh-ceiling" data-field="ceiling">{iso.ceiling}</p>
      {forcedOn.length > 0 && (
        <p className="hh-line hh-forced" data-field="forced"
          data-forced={forcedOn.map(c => c.ability).join(",")}>
          Always on here, and shown on above: {forcedOn.map(c => c.label.toLowerCase()).join(", ")}.
          Its program keeps those tools whatever you set, so this app never pretends
          otherwise.
        </p>
      )}
      {!iso.togglesAreTheBoundary && (
        <p className="hh-line" data-field="controls">
          What the switches <em>do</em> control: {iso.togglesControl}.
        </p>
      )}
      {(iso.stillLoaded.length > 0 || iso.unknowns.length > 0) && (
        <details className="hh-more">
          <summary>
            {/* built as one sentence rather than two fragments glued together:
                with no leaks at all, the glued version read "…hands?, 2 we
                couldn't tell" */}
            {`What else is in its hands? ${[
              iso.stillLoaded.length > 0 ? `${iso.stillLoaded.length} known` : "",
              iso.unknowns.length > 0 ? `${iso.unknowns.length} we couldn't tell` : "",
            ].filter(Boolean).join(", ")}`}
          </summary>
          {iso.stillLoaded.length > 0 && (
            <>
              <span className="eyebrow">There whatever you switch off</span>
              <ul className="honestleaks">
                {iso.stillLoaded.map(leak => (
                  <li key={leak.name} data-leak={leak.name}>
                    <b>{leak.plainWords}</b>
                    <span>{leak.why}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {iso.unknowns.length > 0 && (
            <>
              <span className="eyebrow">We looked and could not tell either way</span>
              <ul className="honestunknowns">
                {iso.unknowns.map(u => <li key={u.slice(0, 40)}>{u}</li>)}
              </ul>
            </>
          )}
        </details>
      )}
      <p className="hh-measured">Measured on {iso.measuredOn}.</p>
    </div>
  );
}

/* ================= THE LADDER AND THE SWITCHES ARE ONE FACT =================
 *
 * WHAT WAS WRONG (Phase 6, finding UI-1 — and it is on the feature Vikas asked
 * for by name). Switching on "Look things up on the web" and "Work on jobs in
 * the background" left the ladder's dot sitting on **"Just talk — No tools at
 * all"**, forty pixels above two switches saying the opposite. The whole point
 * of a ladder is that a glance tells him what an agent can do; a glance told him
 * the reverse of the truth.
 *
 * WHY IT HAPPENED, AND WHY IT IS A CLASS OF BUG. The screen asked the engine's
 * `reachOf()` — "the HIGHEST rung whose every switch is on" — and drew its
 * answer as the chosen rung. That function is right about what it answers, and
 * it is the wrong question for a picker: `{web, background}` fully covers only
 * the empty rung, so it truthfully answers "talk". The ladder then presented
 * that as HIS CHOICE. Two views of one fact, each computing its own answer, are
 * always free to disagree.
 *
 * THE FIX. **The switches are the truth.** They are what the engine reads to
 * build a command line, so they are the only thing that can be. The ladder is
 * DERIVED from them, by exact match and nothing else:
 *
 *   • a rung is drawn as chosen only when the switches are EXACTLY that rung;
 *   • no combination can therefore produce a rung that contradicts them;
 *   • and a set that matches no rung is said out loud as HIS OWN MIXTURE —
 *     never rounded to the nearest rung, because an invented answer is worse
 *     than "this is your own mixture".
 *
 * `rungOfExactly` is the whole derivation and the only one. `reachOf` is no
 * longer asked in this file at all.
 */

/**
 * The rung these switches ARE, or null when they are his own mixture.
 *
 * Exact match in both directions, over every row of the engine's table — so a
 * capability added to that table lands here with no change, and a mixture can
 * never be reported as a rung it merely covers.
 */
function rungOfExactly(ab: AgentAbilities): Reach | null {
  const found = REACH_LEVELS.find(level => {
    const rung = abilitiesForReach(level.level);
    return CAPABILITIES.every(c => (ab[c.ability] === true) === (rung[c.ability] === true));
  });
  return found?.level ?? null;
}

/* ================= ASKING THE COMPUTER FOR THE THING A SWITCH NEEDS =========
 *
 * ONE PLACE THAT OPENS A PICKER, because there are now THREE callers of each
 * one: the per-switch block below it, the switch itself (turning it on opens the
 * picker in the same breath — see `AgentEditor`), and the one-press
 * "Work on my computer" choice. Three copies of "ask the shell, treat cancel as
 * not-now, print the refusal" is three chances for one of them to leave the
 * owner with a switch on and nothing behind it, which is the exact half-state
 * this round exists to kill.
 *
 * THREE ANSWERS AND NO FOURTH. `picked` is the only one that changes anything.
 * `cancelled` means "not now" and is never an error. `refused` carries a
 * sentence to print — including the honest one for a window with no shell to ask
 * (dev, QA in a browser), which must never be silently treated as a cancel.
 */
type PickAnswer =
  | { kind: "picked"; paths: string[] }
  | { kind: "cancelled" }
  | { kind: "refused"; why: string };

const NO_FOLDER_PICKER = "This window cannot open the computer's folder picker, so the "
  + "folders have to be chosen in the installed Cloud9 app.";
const NO_FILE_PICKER = "This window cannot open the computer's file picker, so the file has "
  + "to be chosen in the installed Cloud9 app.";

/** The operating system's own folder picker, several at once. */
async function askForFolders(): Promise<PickAnswer> {
  const picker = desktop()?.chooseWholeComputerFolders;
  if (!picker) return { kind: "refused", why: NO_FOLDER_PICKER };
  const picked = await picker().catch(() => ({
    ok: false, error: "This computer could not open the folder picker.",
  } as { ok: boolean; paths?: string[]; cancelled?: boolean; error?: string }));
  if (picked.cancelled) return { kind: "cancelled" };
  if (!picked.ok || !picked.paths?.length) {
    return picked.error ? { kind: "refused", why: picked.error } : { kind: "cancelled" };
  }
  return { kind: "picked", paths: picked.paths };
}

/** The operating system's own file picker, for one connections file. */
async function askForConnectionsFile(current?: string): Promise<PickAnswer> {
  const picker = desktop()?.chooseConnectionsFile;
  if (!picker) return { kind: "refused", why: NO_FILE_PICKER };
  const picked = await picker(current || undefined).catch(() => ({
    ok: false, error: "This computer could not open the file picker.",
  } as { ok: boolean; path?: string; cancelled?: boolean; error?: string }));
  if (picked.ok && picked.path) return { kind: "picked", paths: [picked.path] };
  if (picked.cancelled) return { kind: "cancelled" };
  return picked.error ? { kind: "refused", why: picked.error } : { kind: "cancelled" };
}

/**
 * ADDED, NEVER REPLACED, and never twice: opening the picker again is how a
 * person adds a second folder, so it must not be a way to silently lose the
 * first. The count is his to see — the refusal names the folder that did not
 * fit rather than quietly dropping it.
 */
function mergeRoots(roots: string[], picked: string[]): { next: string[]; refusal: string | null } {
  const next = [...roots];
  let refusal: string | null = null;
  for (const path of picked) {
    const said = path.trim();
    if (!said || next.includes(said)) continue;
    if (next.length >= WHOLE_COMPUTER_LIMITS.roots) {
      refusal = `One agent can be given ${WHOLE_COMPUTER_LIMITS.roots} folders at most. `
        + "Take one off the list before adding another.";
      break;
    }
    next.push(said);
  }
  return { next, refusal };
}

/**
 * WHICH CONNECTIONS FILE THIS ONE AGENT USES — and honestly when it has none.
 *
 * PLAIN WORDS FIRST. "Connections" are extra tools an agent can reach that
 * Cloud9 did not write — a calendar, a ticket system, a company search box.
 * Whoever makes the tool hands you a small config file. You pick that file here,
 * for this agent only, and no other agent ever sees it. Your own connected
 * accounts are never used, at any setting.
 *
 * THIS WINDOW NEVER TOUCHES THE FILESYSTEM. Choosing asks the desktop shell to
 * draw the operating system's own file picker, and the only thing that comes
 * back is the one file chosen. "Is it still there?" is the same kind of
 * question, asked the same way, and the answer is a yes/no and a clock reading —
 * nothing inside the file is ever read here.
 *
 * FOUR HONEST ANSWERS AND NO FIFTH. The switch on with no file chosen says so.
 * A file that has vanished says so and is NOT used. A file that is there says
 * so, and says when it was checked. A window with no shell to ask (dev, QA in a
 * browser) says it cannot check rather than pretending either way. All four come
 * from `connectionsFileFor` — the SAME function the engine host calls when it
 * builds the command line, so this screen cannot promise a connection that the
 * command line will not carry.
 */
function ConnectionsFilePick({ agentName, agentDraft, file, onChoose }: {
  agentName: string;
  /** the agent as the switches stand right now, unsaved edits included */
  agentDraft: AgentDef;
  file: string;
  onChoose: (path: string) => void;
}): React.JSX.Element | null {
  const [here, setHere] = useState<{ here: boolean; checkedAt: number } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const said = file.trim();

  /* ASKED FRESH, NEVER REMEMBERED — a file that was there when he chose it can
     be moved, renamed or sit on a drive that is unplugged. The engine asks the
     same question again at the top of every turn; this is the screen's copy of
     the question, not a cached answer to it. */
  useEffect(() => {
    setHere(null);
    if (!said) return;
    const ask = desktop()?.connectionsFileHere;
    if (!ask) return; // no shell to ask — the "cannot check" wording below
    let alive = true;
    void ask(said)
      .then(answer => { if (alive) setHere(answer); })
      .catch(() => { if (alive) setHere(null); });
    return () => { alive = false; };
  }, [said]);

  const checked = here !== null;
  const state: ConnectionsFile = connectionsFileFor(
    { ...agentDraft, connectionsFile: said }, () => here?.here === true);
  // A file is stored and this window cannot say whether it is still there. That
  // is its own answer — reporting "gone" would be a guess, and reporting "in
  // use" would be the lie this whole feature exists to prevent.
  // "unsupported" joins "off" here: whether the file is still on the disk is
  // beside the point for an agent that could never have been handed it, and
  // "cannot check that file" would bury the sentence that actually matters.
  const unaskable = state.state === "off" || state.state === "unsupported";
  const shown = said && !checked && !unaskable ? "unchecked" : state.state;
  const words = connectionsWords(state, agentName);

  // Switched off and nothing remembered: there is nothing honest to say here.
  if (shown === "off" && !state.path) return null;

  const pick = async (): Promise<void> => {
    setRefusal(null);
    const answer = await askForConnectionsFile(said);
    if (answer.kind === "picked") { onChoose(answer.paths[0]); return; }
    if (answer.kind === "refused") setRefusal(answer.why);
    // `cancelled` — closing the picker means "not now", and says nothing.
  };

  return (
    <div className="notice connfile" data-conn-state={shown} data-conn-file={said}>
      <b>
        {shown === "unchecked"
          ? "This window cannot check that file."
          : words.headline}
      </b>
      <span>
        {shown === "unchecked"
          ? `The file is remembered for ${agentName}, but only the computer that runs it can `
            + "say whether it is still there. It checks every turn, and will not use a file "
            + "that has gone."
          : words.detail}
      </span>
      {said && <code className="folderpath" data-conn-path>{said}</code>}
      {shown === "ready" && here && (
        <span className="eyebrow" data-conn-checked={String(here.checkedAt)}>
          Checked {fileDate(here.checkedAt)}
        </span>
      )}
      <div className="actions">
        <button className="btn small" data-conn-choose onClick={() => void pick()}>
          {said ? "Choose a different file" : "Choose the connections file"}
        </button>
        {said && (
          <button className="btn small" data-conn-clear onClick={() => { setRefusal(null); onChoose(""); }}>
            Forget this file
          </button>
        )}
      </div>
      <Problem text={refusal ?? undefined} attrs={{ "data-conn-refusal": "" }} />
    </div>
  );
}

/**
 * WHICH FOLDERS THIS AGENT MAY REACH OUTSIDE ITS OWN — the last switch that was
 * on the ceiling with nothing behind it, and the block that takes it down.
 *
 * PLAIN WORDS FIRST. This is "folders on this computer this agent may read and
 * change, besides its own". Its own folder it always has. Everything else on
 * this computer is closed to it unless you name it here — and because that
 * changes your machine, it stops and asks you before it acts in any of them.
 *
 * THIS WINDOW NEVER TOUCHES THE FILESYSTEM. Choosing asks the desktop shell to
 * draw the operating system's own folder picker (several at once), and the only
 * thing that comes back is the folders chosen. "Are they still there?" is the
 * same kind of question, asked the same way, and the answer is which ones and
 * when it was asked — nothing inside any folder is ever listed or read here.
 *
 * FIVE HONEST ANSWERS AND NO SIXTH. Switched on with nothing chosen says so, and
 * says plainly that the agent has NO extra reach. Folders that have vanished are
 * named and are NOT used. A part-there list says which part. All of them come
 * from `wholeComputerRootsFor` — the SAME function the engine host calls when it
 * builds `--add-dir` — so this screen cannot promise reach the command line will
 * not carry. A window with no shell to ask (dev, QA in a browser) says it cannot
 * check rather than pretending either way.
 */
function WholeComputerPick({ agentName, agentDraft, roots, onChange }: {
  agentName: string;
  /** the agent as the switches stand right now, unsaved edits included */
  agentDraft: AgentDef;
  roots: string[];
  onChange: (next: string[]) => void;
}): React.JSX.Element | null {
  const [here, setHere] = useState<{ here: string[]; checkedAt: number } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const key = roots.join(" ");

  /* ASKED FRESH, NEVER REMEMBERED — a folder that was there when he chose it can
     be moved, renamed or sit on a drive that is unplugged. The engine asks the
     same question again at the top of every turn; this is the screen's copy of
     the question, not a cached answer to it. */
  useEffect(() => {
    setHere(null);
    if (roots.length === 0) return;
    const ask = desktop()?.wholeComputerFoldersHere;
    if (!ask) return; // no shell to ask — the "cannot check" wording below
    let alive = true;
    void ask(roots)
      .then(answer => { if (alive) setHere(answer); })
      .catch(() => { if (alive) setHere(null); });
    return () => { alive = false; };
  }, [key]);

  const checked = here !== null;
  const state: WholeComputerRoots = wholeComputerRootsFor(
    { ...agentDraft, wholeComputerRoots: roots },
    folder => here?.here.includes(folder) === true);
  // Folders are stored and this window cannot say whether they are still there.
  // That is its own answer — reporting "gone" would be a guess, and reporting
  // "in use" would be the lie this whole block exists to prevent.
  const shown = roots.length > 0 && !checked && state.state !== "off"
    ? "unchecked" : state.state;
  const words = wholeComputerWords(state, agentName);

  // Switched off and nothing remembered: there is nothing honest to say here.
  if (shown === "off" && state.chosen.length === 0) return null;

  const add = async (): Promise<void> => {
    setRefusal(null);
    const answer = await askForFolders();
    if (answer.kind === "refused") { setRefusal(answer.why); return; }
    if (answer.kind === "cancelled") return; // closing the picker means "not now"
    const { next, refusal: tooMany } = mergeRoots(roots, answer.paths);
    if (tooMany) setRefusal(tooMany);
    if (next.length !== roots.length) onChange(next);
  };

  return (
    <div className="notice wholecomputer" data-roots-state={shown}
      data-roots-count={String(state.chosen.length)}>
      <b>
        {shown === "unchecked"
          ? "This window cannot check those folders."
          : words.headline}
      </b>
      <span>
        {shown === "unchecked"
          ? `The folders are remembered for ${agentName}, but only the computer that runs it `
            + "can say whether they are still there. It checks every turn, and will not use a "
            + "folder that has gone."
          : words.detail}
      </span>
      {state.chosen.length > 0 && (
        <ul className="rootlist" data-roots-list>
          {state.chosen.map(root => {
            const missing = shown !== "unchecked" && shown !== "off"
              && state.missing.includes(root);
            return (
              <li key={root} data-root={root} data-root-missing={missing ? "yes" : "no"}>
                <code className="folderpath">{root}</code>
                {missing && <span className="chip is-gold">not on this computer</span>}
                <button className="btn small" data-root-forget={root}
                  onClick={() => { setRefusal(null); onChange(roots.filter(r => r !== root)); }}>
                  Forget
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {(shown === "ready" || shown === "partly") && here && (
        <span className="eyebrow" data-roots-checked={String(here.checkedAt)}>
          Checked {fileDate(here.checkedAt)}
        </span>
      )}
      <div className="actions">
        <button className="btn small" data-roots-choose onClick={() => void add()}>
          {state.chosen.length > 0 ? "Add another folder" : "Choose a folder"}
        </button>
        {state.chosen.length > 0 && (
          <button className="btn small" data-roots-clear
            onClick={() => { setRefusal(null); onChange([]); }}>
            Forget them all
          </button>
        )}
      </div>
      <Problem text={refusal ?? undefined} attrs={{ "data-roots-refusal": "" }} />
    </div>
  );
}

/**
 * THIS COMPUTER'S HOME FOLDER — the folder a brand-new agent starts with.
 *
 * THE CHOICE, 2026-08-05, and why it went this way. `wholeComputer` is on for
 * every new agent now, and a switch that is on with nowhere to go is a lying
 * switch. There were two honest ways to close that: ask him for a folder the
 * moment an agent is created, or START it somewhere real. Asking is one more
 * dialog between "I want an agent" and having one, and it is exactly the kind of
 * step he has told us, repeatedly, that he does not want. So a new agent starts
 * with his home folder — the same place Claude Code lands when he opens a
 * terminal there — and the folder is PLAINLY SHOWN in the editor with a Forget
 * button beside it, so it is a starting point and never a thing done behind his
 * back.
 *
 * IT IS THE REAL ONE, ASKED OF THE MACHINE. `os.homedir()` in the desktop shell,
 * checked to be a whole path and to really be a folder this second. This window
 * cannot build the value and there is no guessed fallback: in a browser (dev,
 * QA) or on a machine that cannot vouch for it the answer is null and NO folder
 * is claimed — the agent then shows the ordinary "no folder chosen yet" state,
 * which is true. The app never says it opened up a folder it did not open up.
 */
function useHomeFolder(): string | null {
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    const ask = desktop()?.homeFolder;
    if (!ask) return;               // no shell to ask — nothing is claimed
    let alive = true;
    void ask()
      .then(answer => {
        const said = typeof answer?.path === "string" ? answer.path.trim() : "";
        if (alive && answer?.ok === true && said) setHome(said);
      })
      .catch(() => { /* no answer is the same as no folder: claim nothing */ });
    return () => { alive = false; };
  }, []);
  return home;
}

/* ================= "WORK ON MY COMPUTER, LIKE CLAUDE CODE" =================
 *
 * HIS ASK, SAID THE SAME WAY FOR WEEKS: "make cloud9 fully agentic… an agent can
 * perform any task like codex or claude code… access any app, access any folder,
 * run any command on my pc."
 *
 * WHAT HE ACTUALLY HAD TO DO TO GET IT, before this block existed. Find the crew
 * list. Find the agent. Find Edit. Find the reach section. Understand that a
 * ladder rung and a row of switches are the same fact. Turn on "Run programs on
 * this computer". Turn on "Reach files outside its own folder". Notice that the
 * second one, on its own, gives the agent NOTHING. Scroll to a box that only
 * appears once that switch is on, and press "Choose a folder". Six discoveries,
 * two of them invisible, and the fifth one is a trap: he did the first four,
 * stopped, and his agent told him it could not reach his PC. He read that as the
 * product being broken, which from where he was standing is the only reasonable
 * reading.
 *
 * CLAUDE CODE NEEDS NONE OF THAT — because HE launched it, in the folder he
 * wanted, and it just works. So this is one press with that shape: it says what
 * it grants in his words, grants it, and OPENS THE FOLDER PICKER IN THE SAME
 * BREATH, so there is no moment where a switch is on and nothing is behind it.
 *
 * IT IS NOT A NEW IDEA — IT IS THE TOP RUNG. Every ability comes from
 * `abilitiesForReach("computer")` and the one-line summary is the rung's own
 * `plainWords`, so the ladder below still draws itself as chosen and this can
 * never drift from what that rung means. There is no second definition of "full
 * reach" anywhere in Cloud9.
 *
 * IT DOES NOT TOUCH THE APPROVALS, ON PURPOSE. Every row that changes the
 * machine or spends money carries `alwaysAsk`, `approvalsFor()` forces those on
 * whatever is stored, and the approval CARD is what makes full reach safe to
 * hand over at all. This grants power and nothing else; the hand on the door
 * stays exactly where it was, and the card below says so in one line so he is
 * never surprised by being asked.
 */
function WorkOnMyComputer({
  shownName, creating, provider, ab, roots, connFile, onGrant, onRoots, onConnFile,
}: {
  shownName: string;
  /** a brand new agent — the choice is offered up front, with a recommendation */
  creating: boolean;
  provider: Provider;
  /** the switches as they stand right now, unsaved edits included */
  ab: AgentAbilities;
  roots: string[];
  connFile: string;
  onGrant: (next: AgentAbilities) => void;
  onRoots: (next: string[]) => void;
  onConnFile: (path: string) => void;
}): React.JSX.Element {
  const [refusal, setRefusal] = useState<string | null>(null);

  const effAb = effectiveAbilities({ provider, abilities: ab });
  /* THE RUNG THIS BUTTON REALLY GRANTS — the one every new agent is, not the
     one above it. They differ by connected services alone, which nobody but he
     can supply, and saying "everything" while handing over one row less is the
     shape of lie this whole screen exists to stop. */
  const topRung = REACH_LEVELS.find(r => r.level === "mypc") ?? REACH_LEVELS[REACH_LEVELS.length - 1];
  /* THE SAME QUESTION THE HALF-STATE OWNER ASKS, asked of the unsaved draft —
     so the prompt below appears the instant a switch goes on, not after a save. */
  const gaps = supplyGapsOf({
    abilities: effAb, wholeComputerRoots: roots, connectionsFile: connFile,
  });
  const gapOf = (ability: string): SupplySwitch | undefined =>
    gaps.find(g => g.ability === ability);
  /* "FULL" MEANS THE SAME THING HERE AS IT DOES FOR A NEW AGENT, and it is the
     same code that answers it (`capabilitiesForNewAgent`). Everything this app
     can really hand over is in; the one row that grants nothing until somebody
     outside Cloud9 writes him a file is not, and is said out loud below rather
     than sitting here as a permanent unfinished tick. */
  const workingSet = capabilitiesForNewAgent();
  const heldBack = CAPABILITIES.filter(c => c.offForNewAgents);
  const fullReach = workingSet.every(c => effAb[c.ability] === true);
  const on = fullReach && gaps.length === 0;

  const chooseFolder = async (): Promise<void> => {
    setRefusal(null);
    const answer = await askForFolders();
    if (answer.kind === "refused") { setRefusal(answer.why); return; }
    if (answer.kind === "cancelled") return; // "not now" — the prompt below stays
    const { next, refusal: tooMany } = mergeRoots(roots, answer.paths);
    if (tooMany) setRefusal(tooMany);
    if (next.length !== roots.length) onRoots(next);
  };

  const chooseFile = async (): Promise<void> => {
    setRefusal(null);
    const answer = await askForConnectionsFile(connFile);
    if (answer.kind === "refused") { setRefusal(answer.why); return; }
    if (answer.kind === "picked") onConnFile(answer.paths[0]);
  };

  /* ONE PRESS = THE WHOLE WORKING SET, AND THE FOLDER IN THE SAME FLOW.
     The picker opens as part of this action rather than after it, because the
     state this exists to kill is "switch on, nothing chosen" — and the only way
     to make that state impossible to arrive at by accident is never to leave the
     flow in it. If he closes the picker, the prompt below is loud and stays. */
  const turnOn = async (): Promise<void> => {
    setRefusal(null);
    /* ONLY EVER ADDS. Laid on top of what he already set, so a switch he turned
       on that the working set does not include (connected services) is not
       quietly turned off by a button whose whole promise is MORE. */
    const next = { ...ab } as AgentAbilities;
    for (const cap of workingSet) {
      (next as unknown as Record<string, boolean>)[cap.ability] = true;
    }
    onGrant(effectiveAbilities({ provider, abilities: next }));
    if (roots.length === 0) await chooseFolder();
  };

  return (
    <div className="oneclick" data-oneclick={on ? "on" : fullReach ? "half" : "off"}>
      <div className="oc-head">
        <span className="oc-mark" aria-hidden="true">▣</span>
        <span className="oc-tx">
          <b>
            Work on my computer, like Claude Code
            {creating && <span className="chip">Recommended</span>}
          </b>
          {/* THE RUNG'S OWN WORDS. Written here once it would be a second
              description of the same thing, free to drift from what the rung
              actually grants. */}
          <span>{topRung.plainWords}</span>
        </span>
        {on
          ? <span className="chip is-gold" data-oneclick-on="yes">On</span>
          : <button className="primary small" data-oneclick-grant onClick={() => void turnOn()}>
            Turn this on
          </button>}
      </div>

      {/* WHAT IT GRANTS, IN THE TABLE'S OWN WORDS — read from the same rows the
          command line reads, so a capability added to that table appears here
          with no change and none can be quietly left out of this sentence. */}
      <ul className="oc-grants" data-oneclick-grants={CAPABILITIES.map(c => c.ability).join(",")}>
        {CAPABILITIES.map(c => (
          <li key={c.ability} data-oneclick-grant-row={c.ability}
            data-on={effAb[c.ability] === true ? "yes" : "no"}>
            {c.label}
          </li>
        ))}
      </ul>

      {/* THE ONE ROW THIS PRESS DOES NOT GIVE, AND WHY — read from the table, so
          it cannot be a row this screen forgot to mention. */}
      {heldBack.map(c => (
        <p className="oc-held" key={c.ability} data-oneclick-heldback={c.ability}>
          <b>The one thing this does not give: “{c.label}”.</b> {c.whyOffForNewAgents}
        </p>
      ))}

      <p className="oc-ask" data-oneclick-asks={CAPABILITIES.filter(c => c.alwaysAsk).length}>
        <b>You are still asked first.</b> Anything that changes this computer, spends your
        money or reaches an outside account stops and waits for you —{" "}
        {CAPABILITIES.filter(c => c.alwaysAsk).map(c => c.label.toLowerCase()).join("; ")}.
        That cannot be switched off, and this button does not switch it off.
      </p>

      {/* THE LAST STEP, SAID OUT LOUD. Pressing this button changes the FILE in
          front of him, not the agent — and an agent that still cannot reach his
          PC because nobody pressed Save is the same dead end in a new place. */}
      <p className="oc-save" data-oneclick-save={creating ? "create" : "save"}>
        Nothing here reaches {shownName} until you press{" "}
        <b>{creating ? "Create agent" : "Save"}</b> at the top of this page.
      </p>

      {/* THE HALF-STATE, CAUGHT IN THE FLOW THAT CAUSES IT. Both switches that
          need something supplied are answered here, the same way, from the same
          list — so the next one of this shape lands here on its own. */}
      {gapOf("wholeComputer") && (
        <div className="notice oc-gap" data-oneclick-pending="wholeComputer">
          <b>One thing left — pick the folder.</b>
          <span>
            {shownName} is allowed out of its own folder, but no folder has been chosen,
            so it has been sent nowhere and stays in its own folder. Point it at the folder
            you want it working in — the whole drive is fine (C:\) if that is what you
            mean. That folder is where it is aimed and told to stay; the hard limit is
            which tools it holds, not a wall around the folder.
          </span>
          <div className="actions">
            <button className="primary small" data-oneclick-folder
              onClick={() => void chooseFolder()}>Choose a folder</button>
            <button className="btn small" data-oneclick-folder-off
              onClick={() => { setRefusal(null); onGrant({ ...ab, wholeComputer: false }); }}>
              Not now — keep it to its own folder
            </button>
          </div>
        </div>
      )}
      {gapOf("connections") && (
        <div className="notice oc-gap" data-oneclick-pending="connections">
          <b>Connected services are on, and nothing is connected.</b>
          <span>
            Those are outside accounts — a calendar, a ticket system — and whoever makes one
            hands you a small file. Most people never need one. Point {shownName} at the
            file, or leave connected services off; either way it changes nothing else above.
          </span>
          <div className="actions">
            <button className="btn small" data-oneclick-connfile
              onClick={() => void chooseFile()}>Choose the file</button>
            <button className="btn small" data-oneclick-conn-off
              onClick={() => { setRefusal(null); onGrant({ ...ab, connections: false }); }}>
              Leave connected services off
            </button>
          </div>
        </div>
      )}
      <Problem text={refusal ?? undefined} attrs={{ "data-oneclick-refusal": "" }} />
    </div>
  );
}

/* ================= 5 · CREATE / EDIT AN AGENT ================= */

function AgentEditor({ agent, onDone, onLeave, onMarket, justHired }: {
  agent: AgentDef | null;
  /**
   * Leaving BECAUSE he decided what happens to the words — Save, Create,
   * Delete, and Cancel, which is a labelled discard and not navigation. None of
   * them asks, because he has just answered the question. (Asking after a Save
   * is the bug this guard would otherwise introduce, and this split is the fix
   * for the whole class of it.)
   */
  onDone: () => void;
  /**
   * Walking out of the file without saying anything about the words — the back
   * arrow. This is navigation, so it goes through the unsaved-work owner.
   */
  onLeave: () => void;
  onMarket: () => void;
  /** the @name he has this second hired, so the file says why he is looking at it */
  justHired?: string | null;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const p = usePrefs();
  const creating = agent === null;

  const [name, setName] = useState(agent?.name ?? "");
  const [emoji, setEmoji] = useState(agent?.emoji ?? "✨");
  const [persona, setPersona] = useState(agent?.persona ?? "");
  const [ab, setAb] = useState(agent?.abilities ?? NEW_AGENT_ABILITIES);
  const [ap, setAp] = useState(agent?.approvals ?? NEW_AGENT_APPROVALS);
  const [life, setLife] = useState(agent?.lifecycle ?? "enabled");
  const [provider, setProvider] = useState<Provider>(
    (agent?.provider ?? p.defaultProvider ?? "claude") as Provider);
  const [model, setModel] = useState<string>(
    agent?.model ?? p.defaultModel?.[(agent?.provider ?? p.defaultProvider ?? "claude") as Provider] ?? MODEL_DEFAULT.claude);
  /* HOW HARD SHOULD IT THINK? — his choice, per agent, and `""` means he has
     never made one. That empty string is NOT the same as "Normal": empty means
     Cloud9 says nothing at all and the app uses whatever it normally would,
     which is exactly what every agent he already owns does today. Nothing about
     an existing agent changes until he picks one of the four. */
  const [effort, setEffort] = useState<AgentEffort | "">(agent?.effort ?? "");
  const [skills, setSkills] = useState<AgentSkill[]>(Array.isArray(agent?.skills) ? agent!.skills! : []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /* WHO MAY SET THIS AGENT WORKING. Absent means "owner" — an agent made
     before this setting existed must never be more open than one made after. */
  const [respondTo, setRespondTo] = useState<AgentRespondTo>(agent?.respondTo ?? "owner");
  const [allowlist, setAllowlist] = useState<ID[]>(agent?.respondToAllowlist ?? []);
  /* HOW MUCH THIS AGENT MAY DO WITHOUT STOPPING TO ASK.
     TWO DIFFERENT STARTING POINTS, AND THE DIFFERENCE IS THE POINT. A NEW agent
     starts on `NEW_AGENT_TRUST` — the middle setting, written down at creation
     so the value is his, in the database, rather than a default that could drift
     under his existing agents later. An EXISTING agent starts on whatever it has
     stored, and `trustOf` answers "ask me every time" for the six he made before
     this setting existed. Nothing here ever widens an agent he already owns; the
     only thing that can is him pressing one of the three below and saving. */
  const [trust, setTrust] = useState<AgentTrust>(
    creating ? NEW_AGENT_TRUST : trustOf(agent ?? {}));
  /* DOES THIS AGENT USE HIS OWN CLAUDE CODE / CODEX SETUP?
     THE SAME TWO STARTING POINTS AS TRUST ABOVE, AND FOR THE SAME REASON. A NEW
     agent starts ON — he has asked for this repeatedly, and it is his machine —
     and the value is WRITTEN DOWN at creation. An EXISTING agent starts on
     whatever it has stored, and an agent saved before this switch existed reads
     as OFF: nothing he already owns starts obeying his personal instructions,
     running his hooks or paying for a much bigger prompt because an update
     shipped. Only him pressing this and saving can do that. */
  const [ownerSetup, setOwnerSetup] = useState<boolean>(
    creating ? NEW_AGENT_USE_OWNER_SETUP : agent?.useOwnerSetup === true);
  /* THE CONNECTIONS FILE THIS AGENT USES — the config the maker of a tool hands
     you, chosen for this one agent. Blank means none has been chosen, which is
     the honest default and never the same as "" stored on the agent. */
  const [connFile, setConnFile] = useState<string>(agent?.connectionsFile ?? "");
  /* THE FOLDERS THIS AGENT MAY REACH OUTSIDE ITS OWN. Empty means none has been
     chosen, which is the honest default and never the same as a list of blanks
     stored on the agent. */
  const [roots, setRoots] = useState<string[]>(
    Array.isArray(agent?.wholeComputerRoots) ? agent!.wholeComputerRoots! : []);
  /* THE MOST THIS AGENT MAY SPEND — two boxes, both blank by default and blank
     for every agent he already has. Held as TEXT, not numbers, because a number
     input that has been emptied is neither 0 nor a limit and a person clearing a
     box means "no limit", not "spend nothing". `spendCapOf` reads what is stored;
     what is typed only becomes a stored amount at save. */
  const startCap = spendCapOf(agent ?? {});
  const [perJob, setPerJob] = useState<string>(
    typeof startCap.perJobUsd === "number" ? String(startCap.perJobUsd) : "");
  const [perMonth, setPerMonth] = useState<string>(
    typeof startCap.perMonthUsd === "number" ? String(startCap.perMonthUsd) : "");
  /* SHOW ME THE PLAN FIRST. OFF for a new agent and OFF for every agent saved
     before this existed — an update must never start making his crew stop and
     wait for him. */
  const [planFirst, setPlanFirst] = useState<boolean>(agent?.planFirst === true);
  /* IF THAT MODEL IS BUSY, USE THIS ONE. One stand-in from the same list the
     model picker draws, because one is what the need actually is — and blank,
     which is today's behaviour: a busy model is a failed turn. */
  const [standIn, setStandIn] = useState<string>(
    Array.isArray(agent?.fallbackModels) && agent!.fallbackModels!.length > 0
      ? agent!.fallbackModels![0]! : "");

  /* A NEW AGENT STARTS IN HIS HOME FOLDER — the other half of "fully capable the
     second it exists". `wholeComputer` is on by default, so without this the
     very first agent he makes would be allowed out of its own folder with
     nowhere to go: the exact half-state that made him say the app was broken.
     The folder is drawn below by `WholeComputerPick`, with Forget beside it.

     IT IS ONLY EVER A STARTING POINT. It waits for the real answer from the
     machine (a browser has none, and then nothing is claimed), it never touches
     an agent that already exists, and it never overwrites a folder he has
     chosen — including choosing to have none, because by then the picker has
     been through his hands. */
  const home = useHomeFolder();
  const startingRoots = creating && home ? [home] : [];
  const homeOffered = useRef(false);
  useEffect(() => {
    if (!creating || !home || homeOffered.current) return;
    homeOffered.current = true;
    setRoots(prev => (prev.length > 0 ? prev : [home]));
  }, [creating, home]);

  const { ids, fallback, preferred } = useModels(provider);
  // an agent must never end up without a model
  useEffect(() => {
    if (!model || !ids.includes(model)) setModel(preferred);
  }, [provider, ids.join(","), model]);

  const ready = !!name.trim() && !!persona.trim();

  /* ---- HAS HE WRITTEN ANYTHING THAT IS NOT SAVED? ----
   *
   * Compared against what this file was OPENED with, field by field — a new
   * agent against an empty page, an existing one against itself. That is what
   * makes "I typed a sentence into the brief" different from "I opened the
   * editor and looked at it", which is the difference between a question worth
   * asking and one that would train him to click through it.
   */
  const changed =
    name !== (agent?.name ?? "")
    || emoji !== (agent?.emoji ?? "✨")
    || persona !== (agent?.persona ?? "")
    || JSON.stringify(ab) !== JSON.stringify(agent?.abilities ?? NEW_AGENT_ABILITIES)
    || JSON.stringify(ap) !== JSON.stringify(agent?.approvals ?? NEW_AGENT_APPROVALS)
    || life !== (agent?.lifecycle ?? "enabled")
    || provider !== ((agent?.provider ?? p.defaultProvider ?? "claude") as Provider)
    /* Unlike the model, this one IS counted: nothing picks it for him on the way
       in, so a difference here is always something he chose. */
    || effort !== (agent?.effort ?? "")
    || JSON.stringify(skills) !== JSON.stringify(Array.isArray(agent?.skills) ? agent!.skills! : [])
    || respondTo !== (agent?.respondTo ?? "owner")
    || trust !== (creating ? NEW_AGENT_TRUST : trustOf(agent ?? {}))
    || ownerSetup !== (creating ? NEW_AGENT_USE_OWNER_SETUP : agent?.useOwnerSetup === true)
    || connFile.trim() !== (agent?.connectionsFile ?? "").trim()
    /* Against what the file OPENED with, which for a new agent now includes the
       home folder it starts in — otherwise merely opening "write an agent" and
       walking away would be reported as unsaved work he never typed. */
    || JSON.stringify(roots) !== JSON.stringify(agent?.wholeComputerRoots ?? startingRoots)
    || JSON.stringify(allowlist) !== JSON.stringify(agent?.respondToAllowlist ?? []);
  /* THE MODEL IS DELIBERATELY NOT IN THAT LIST. An agent saved before a model
     list changed has one picked FOR it on the way in (see the effect above), so
     counting it would mark a file he has only looked at as unsaved — and a
     question asked when nothing was typed is how a person learns to click
     through the question that matters. */
  /* Save and Delete settle the question of what happens to these words, so from
     that instant there is nothing unsaved to warn about — even though this
     component is still mounted while the screen changes underneath it. A ref
     rather than state: the guard is asked in the same tick as the click. */
  const settled = useRef(false);
  useUnsavedWork(
    creating ? "The new agent you are writing" : `${agent!.name}'s file`,
    changed && !settled.current);

  /* Said in the form rather than only in a toast, because the name box is right
     here and the toast is at the other end of the window. */
  const [refusal, setRefusal] = useState<string | null>(null);

  /* THE TWO BOXES, TURNED INTO ONE STORED CEILING — or into no field at all.
     A BLANK BOX IS NOT A ZERO. Clearing a box means "no limit on this", so it
     produces no key; and when both are blank there is no `spendCap` on the
     agent at all, which is exactly the shape every agent he already has has.
     There is one way to say "no limit", so nothing downstream can disagree
     about what the absence of a number means. */
  const capFromBoxes = (): AgentSpendCap | undefined => {
    const cap: AgentSpendCap = {};
    const job = Number(perJob.trim());
    const month = Number(perMonth.trim());
    if (perJob.trim() && Number.isFinite(job)) cap.perJobUsd = job;
    if (perMonth.trim() && Number.isFinite(month)) cap.perMonthUsd = month;
    return cap.perJobUsd === undefined && cap.perMonthUsd === undefined ? undefined : cap;
  };

  const save = () => {
    /* REFUSED HERE, BY THE HUB'S OWN RULE, before anything is sent. The hub
       would refuse it anyway — this is the second gate, not the only one — but
       a refusal that arrives as a toast after the form has closed is a refusal
       he has to remember; one in the form is one he can act on. */
    const badCap = validateSpendCap(capFromBoxes());
    if (badCap) { setRefusal(badCap); return; }
    if (creating) {
      if (!ready) return;
      const wanted = name.trim().replace(/\s+/g, "-");
      /* THE HUB'S OWN NAMING RULE, asked early so the sentence he reads before
         it goes is the sentence the hub would send back — including "you
         already have an agent called Scout", which is the whole of B6/B6b.
         `client.submit` is the one owner of what happens when it says no: the
         file stays open and every word he typed is still in it. */
      const went = client.submit(
        validateName("agent", wanted, world.agents.map(a => a.name)),
        {
          type: "createAgent",
          agent: {
            name: wanted, emoji, persona: persona.trim(),
            abilities: ab, approvals: ap, provider,
            model: model || MODEL_DEFAULT[provider],
            /* Absent means absent — "the app decides" is NO field, never `""`,
               so there is one way to say it and nothing downstream to disagree
               about. Same rule as the connections file below. */
            ...(effort ? { effort } : {}),
            skills, respondTo, respondToAllowlist: respondTo === "allowlist" ? allowlist : [],
            /* WRITTEN DOWN, NOT LEFT TO A DEFAULT. A new agent carries the
               middle setting as a real stored value from its first second, so
               "what does absent mean" only ever has to answer for agents made
               before the setting existed — and for those the answer is, and
               stays, "ask me every time". */
            trust,
            /* WRITTEN DOWN AT CREATION, exactly like the trust setting above, so
               "absent" only ever has to answer for agents made before this
               switch existed — and for those the answer is, and stays, no. */
            useOwnerSetup: ownerSetup,
            /* Absent means absent — a blank box is not `""` on the agent, it is
               no connections file at all (the same rule the project folder
               follows). `undefined` never reaches the wire. */
            ...(connFile.trim() ? { connectionsFile: connFile.trim() } : {}),
            /* The same rule for the folders: an empty list is not a field at
               all, so there is one way to say "nothing opened up". */
            ...(roots.length > 0 ? { wholeComputerRoots: roots } : {}),
            /* The same absent-means-absent rule for the three settings added
               2026-08-05: no limit is NO field, "show me the plan" off is NO
               field, no stand-in model is NO field. */
            ...(capFromBoxes() ? { spendCap: capFromBoxes() } : {}),
            ...(planFirst ? { planFirst: true } : {}),
            ...(standIn ? { fallbackModels: [standIn] } : {}),
          },
        }, setRefusal);
      if (!went) return;
    } else {
      client.send({
        type: "updateAgent",
        agent: {
          ...agent!, emoji, persona: persona.trim() || agent!.persona, abilities: ab,
          approvals: ap, provider, lifecycle: life,
          model: model || MODEL_DEFAULT[provider],
          /* Said explicitly rather than left to the spread, because going BACK
             to "the app decides" has to travel too. `undefined` is dropped on
             the way onto the wire, so the agent comes back with no thinking-time
             setting at all — never with `""`, which would be a second way of
             saying the same thing. */
          effort: effort || undefined,
          skills, respondTo, respondToAllowlist: respondTo === "allowlist" ? allowlist : [],
          /* Said explicitly, always — the hub treats silence as "leave it as he
             set it", so an edit that meant to CHANGE the setting has to say so
             out loud. It is one of the three exact words or the hub refuses the
             whole save. */
          trust,
          /* Said explicitly, always — the hub treats silence as "leave it as he
             set it", so an edit that meant to turn his own setup OFF has to say
             so out loud rather than hoping a missing field is read as a no. */
          useOwnerSetup: ownerSetup,
          /* Said explicitly rather than left to the spread above, because
             FORGETTING the file has to travel too. `undefined` is dropped on the
             way onto the wire, so the agent comes back with no connections file
             at all — never with `""`, which would be a second way of saying
             "none" for anything downstream to disagree about. */
          connectionsFile: connFile.trim() || undefined,
          /* Said explicitly for the same reason the line above is: FORGETTING a
             folder has to travel too. `undefined` is dropped on the way onto
             the wire, so the agent comes back with no folders at all — never
             with `[]`, which would be a second way of saying "none". */
          wholeComputerRoots: roots.length > 0 ? roots : undefined,
          /* Said explicitly for the same reason every line above is: REMOVING a
             spending limit, turning the plan gate back off and dropping a
             stand-in model all have to travel. `undefined` is dropped on the
             way onto the wire, so the agent comes back with no such field at
             all — and the hub reads a field that never arrived as "leave it as
             he set it", which is why saying so out loud is the only way to
             change it. */
          spendCap: capFromBoxes(),
          planFirst,
          fallbackModels: standIn ? [standIn] : undefined,
        },
      });
    }
    settled.current = true;
    onDone();
  };

  const del = () => {
    if (agent) client.send({ type: "deleteAgent", agentId: agent.id });
    settled.current = true;
    onDone();
  };

  const shownName = creating ? (name.trim() || "Unnamed") : agent!.name;

  /* WHICH CASTING-ROOM ROLE THIS IS — known only in the second after hiring.
     An agent does not remember the template it came from (there is no field on
     `AgentDef` for it, and inventing one in the renderer would be a lie that
     survives a rename), so this is read from the hire that is happening RIGHT
     NOW and is null every other time. All it changes is the ORDER the library
     offers, and an unknown role gets the natural order — never an error, never
     a guess about an agent whose history we do not have. */
  const hiredRoleId = justHired && !creating && agent!.name === justHired
    ? MARKET_TEMPLATES.find(t => justHired === t.name || justHired.startsWith(`${t.name}-`))?.id ?? null
    : null;
  const jobsRun = agent ? world.tasks.filter(t => t.agentId === agent.id).length : 0;

  /* THE LADDER, DERIVED FROM THE SWITCHES AND NOTHING ELSE (see the note above
     this component). `chosenRung` is null when his switches are a mixture of his
     own, and every part of the drawing below reads that one value — the dot, the
     inked spine, the words. There is no second derivation to disagree with it. */
  /* `trust` is in the draft for the same reason `abilities` is: everything below
     that says "you will be asked before …" reads THIS object, so the list must
     reflect the setting he is looking at, not the one still in the database. */
  const draft = { ...(agent ?? {}), abilities: ab, provider, trust } as AgentDef;
  /* WHAT THIS AGENT WOULD REALLY HAVE, from the engine's one owner of that
     question. `ab` is what gets SAVED — his switches, kept exactly as he set
     them so moving the agent back to Claude gives them back. `effAb` is what is
     TRUE once its app is taken into account: Codex cannot give up its web, file,
     helper-agent and command tools, so for a Codex agent those read as on. Every
     view below — the ladder, the switch list, the approvals line, the honesty
     card — reads THIS, so none of them can contradict another. */
  const forcedOn = forcedOnCapabilities({ provider });
  const isForcedOn = (ability: string): boolean => forcedOn.some(c => c.ability === ability);
  const effAb = effectiveAbilities({ provider, abilities: ab });
  const chosenRung = rungOfExactly(effAb);
  const chosenIndex = chosenRung ? REACH_LEVELS.findIndex(r => r.level === chosenRung) : -1;
  /* What is actually switched on, in the table's own words — the honest answer
     when no rung fits, and the only thing said in that case. */
  const abilitiesOnNow = CAPABILITIES.filter(c => effAb[c.ability] === true);
  /* The powers that will stop and ask. NOT checkboxes: the switch being on IS
     the ask being on, so rendering them as something he could clear would be
     showing him a control that does nothing. */
  const willAsk = describeApprovalNeeds(draft);
  /* Open the switch list only if the agent WALKED IN with a mixture of its own —
     after that it is his to open and close, and nothing re-decides it. The same
     one owner answers "is this a mixture", here too. */
  const [showSwitches, setShowSwitches] = useState(
    () => rungOfExactly(effectiveAbilities({
      provider: agent?.provider, abilities: agent?.abilities ?? NEW_AGENT_ABILITIES,
    })) === null);
  const switchesOpen = showSwitches;
  /* THE POWERS THAT ARE SWITCHED ON AND STILL HAND THE AGENT NOTHING, because
     the thing they need has nowhere to be chosen yet. THIS LIST IS NOW EMPTY,
     and that is the whole point of it (`capability-handoff.md` §4.4).

     `connections` left it on 2026-08-03 and `wholeComputer` left it on
     2026-08-04: there is now somewhere to choose a connections file AND
     somewhere to choose folders, so neither switch is inert BY DESIGN any more.
     Whether either is inert TODAY is a question about THIS agent, and it is
     answered right below by `ConnectionsFilePick` and `WholeComputerPick` —
     each reading the very function the engine reads when it builds the command
     line, so a switch with nothing behind it still says so, in that agent's own
     terms rather than as a standing apology from the app.

     The mechanism is deliberately kept rather than deleted: the day a new
     capability row lands that needs something the app cannot yet ask for, it
     goes in this list and the honest notice appears again. Empty means there is
     no switch in Cloud9 today that lies. */
  const inertSwitches = ([] as (keyof AgentAbilities)[])
    .filter(key => ab[key] === true);

  /* ---- A SWITCH THAT NEEDS SOMETHING ASKS FOR IT THE MOMENT IT GOES ON ----
   *
   * THE TRAP, KILLED AS A CLASS. Switching on "Reach files outside its own
   * folder" and stopping there is what left Vikas with an agent that truthfully
   * said "I can't reach files outside this directory". The old screen answered
   * that with a box further down the page telling him what he had not done yet —
   * which is only ever read by someone who already suspects something is wrong.
   *
   * So the switch itself opens the picker. It is driven by `SUPPLY_SWITCHES`
   * rather than by two `if`s, so the day a third switch of this shape is added
   * it behaves this way without anybody remembering to make it. A picker he
   * closes is "not now" and changes nothing — the gap is then loud on the card,
   * in the room rail and in the block below, all reading the one owner.
   */
  const flipSwitch = (ability: keyof AgentAbilities, next: boolean): void => {
    setAb({ ...ab, [ability]: next });
    if (!next) return;
    const supply = SUPPLY_SWITCHES.find(s => s.ability === ability);
    if (!supply) return;
    // Already has what it needs — never re-ask for something he has chosen.
    if (supplyChosen({ wholeComputerRoots: roots, connectionsFile: connFile }, supply)) return;
    void (async () => {
      const answer = supply.field === "wholeComputerRoots"
        ? await askForFolders()
        : await askForConnectionsFile(connFile);
      /* A refusal is NOT swallowed — it is said by the block for that switch
         further down, which draws the same honest state ("no folder chosen yet")
         and carries its own picker button and its own refusal line. */
      if (answer.kind !== "picked") return;
      if (supply.field === "wholeComputerRoots") setRoots(mergeRoots(roots, answer.paths).next);
      else setConnFile(answer.paths[0]);
    })();
  };

  /* A RUNG THAT REACHES OUTSIDE THE AGENT'S OWN FOLDER ASKS FOR THE FOLDER TOO.
     The same law as `flipSwitch`, applied to the other way of turning that
     switch on — otherwise the trap simply moves from the switch list to the
     ladder, which is the more likely place for him to press. */
  const pickRung = (level: Reach): void => {
    const next = effectiveAbilities({ provider, abilities: abilitiesForReach(level) });
    setAb(next);
    if (next.wholeComputer !== true || roots.length > 0) return;
    void (async () => {
      const answer = await askForFolders();
      if (answer.kind === "picked") setRoots(mergeRoots(roots, answer.paths).next);
    })();
  };

  const toggle = (
    title: string, why: string, on: boolean, set: (v: boolean) => void,
  ) => (
    <label className="toggle-row" key={title}>
      <span className="tx"><b>{title}</b><span>{why}</span></span>
      <input className="sw" type="checkbox" checked={on} aria-label={title}
        onChange={e => set(e.target.checked)} />
    </label>
  );

  return (
    <div className="editor">
      <header className="topbar">
        <button className="btn small ghost" onClick={onLeave}>← Crew</button>
        <h2>{shownName}</h2>
        <span className="sub">
          {creating ? "New hire · nothing is saved until you press create"
            : `${countOf(jobsRun, "job")} run · ${countOf(skills.length, "skill")}`}
        </span>
        <div className="grow" />
        {!creating && (confirmDelete
          ? <>
            <span className="eyebrow">Delete {agent!.name} for good?</span>
            <button className="btn small" onClick={() => setConfirmDelete(false)}>Keep it</button>
            <button className="btn small danger" onClick={del}>Yes, delete</button>
          </>
          : <button className="btn small danger" onClick={() => setConfirmDelete(true)}>Delete agent</button>)}
        <button className="btn small" onClick={onDone}>Cancel</button>
        <button className="primary small" onClick={save} disabled={creating && !ready}>
          {creating ? "Create agent" : "Save"}
        </button>
      </header>

      <div className="editor-body">
        <div className="form-col">
          {!creating && justHired === agent!.name && (
            <div className="hirednote" data-hired={agent!.name}>
              <span className="hn-mark" aria-hidden="true">✓</span>
              <span>
                <b>@{agent!.name}</b> is on the floor, and this is their file. Everything below is
                yours — how far they can go, what they may touch, what you teach them, when they
                have to stop and ask. A hired role is an ordinary agent in every respect.
              </span>
            </div>
          )}
          {/* The blank page is the hardest part of writing an agent, so the
              way out of it is offered on the blank page itself. */}
          {creating && (
            <div className="fromhall">
              <span className="fh-mark" aria-hidden="true">⌕</span>
              <span className="fh-tx">
                <b>Not sure what to write?</b>
                <span>
                  {countOf(MARKET_TEMPLATES.length, "role")} {plural(MARKET_TEMPLATES.length, "is", "are")} already written — architect, backend,
                  QA and more. Hire one and change it here afterwards.
                </span>
              </span>
              <button className="btn small tomarket" onClick={onMarket}>Browse the casting room</button>
            </div>
          )}
          <section className="fieldset">
            <div className="sec-head"><h3>Who they are</h3><span className="eyebrow">The basics</span></div>
            <p className="sec-note">Names matter — you'll be typing this one a lot, after an @.</p>
            {/* The refusal sits beside the box he has to change, and nothing he
                typed is cleared to make room for it. */}
            <Problem text={refusal ?? undefined} attrs={{ "data-namerefusal": "agent" }} />
            <div className="two">
              <div className="field-row">
                <label htmlFor="f-name">Name <span className="hint">no spaces</span></label>
                {creating
                  ? <input className="input" id="f-name" type="text" value={name} placeholder="Scout"
                    onChange={e => { setName(e.target.value); setRefusal(null); }} />
                  : <input className="input" id="f-name" type="text" value={agent!.name} disabled
                    title="An agent keeps the name it was hired under — everyone's @ mentions point at it" />}
              </div>
              <div className="field-row">
                <label htmlFor="f-emoji">Emoji <span className="hint">shown in lists and pickers</span></label>
                <input className="input" id="f-emoji" type="text" value={emoji}
                  onChange={e => setEmoji(e.target.value)} />
              </div>
            </div>
            <div className="field-row">
              <label htmlFor="f-does">What they do, in your words</label>
              <textarea className="textarea persona-input" id="f-does" rows={5} value={persona}
                placeholder="You're my travel researcher. You find flights, villas and hidden gems, always with prices and links, always under budget."
                onChange={e => setPersona(e.target.value)} />
            </div>
            {!creating && (
              <div className="field-row">
                <label htmlFor="f-life">Status</label>
                <select className="select lifecyclepick" id="f-life" value={life}
                  onChange={e => setLife(e.target.value as typeof life)}>
                  <option value="enabled">Enabled — responds and works</option>
                  <option value="paused">Paused — silent until you switch it back on</option>
                  <option value="disabled">Switched off — does nothing at all</option>
                </select>
              </div>
            )}
          </section>

          <section className="fieldset">
            <div className="sec-head"><h3>Where they run</h3><span className="eyebrow">App and model</span></div>
            <p className="sec-note">
              Cloud9 runs this agent through an app already signed in on this computer.
              Bigger models think longer.
            </p>
            <div className="pick-apps">
              {(["claude", "codex"] as const).map(id => {
                const info = world.harness?.[id];
                return (
                  <button key={id} className="app-pick" data-app={id}
                    aria-pressed={provider === id} onClick={() => setProvider(id)}>
                    <span className="mark" style={{ color: id === "claude" ? "var(--marigold)" : "var(--ultra)" }}>
                      {id === "claude" ? <MarkClaude /> : <MarkCodex />}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span className="nm">{PROVIDER_LABEL[id]}</span>
                      <span className="ms">
                        {info?.signedIn ? "Signed in" : info?.installed ? "Not signed in" : "Not found"}
                        {(info?.models?.length ?? 0) > 0 ? ` · ${countOf(info!.models!.length, "model")}` : ""}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="two" style={{ marginTop: 14 }}>
              <div className="field-row">
                <label htmlFor="f-model">Model</label>
                <select className="select modelpick" id="f-model" value={ids.includes(model) ? model : preferred}
                  onChange={e => setModel(e.target.value)}>
                  {ids.map(id => <option key={id} value={id}>{modelLabel(id)}</option>)}
                </select>
              </div>
              {/* HOW HARD SHOULD IT THINK? — the second dial both apps offer and
                  Cloud9 never turned. Deliberately in HIS words, not the apps':
                  Claude calls these low/medium/high/max and Codex calls them
                  low/medium/high/xhigh, and he should never have to know that.
                  The one table in @cloud9/shared does the translating.
                  The first option is not one of the four on purpose. Leaving it
                  alone is a real answer — it means Cloud9 says nothing and the
                  app uses whatever it normally would, which is what every agent
                  he already owns does. */}
              <div className="field-row">
                <label htmlFor="f-effort">How hard should it think?</label>
                <select className="select" id="f-effort" value={effort}
                  onChange={e => setEffort(e.target.value as AgentEffort | "")}>
                  <option value="">{AGENT_EFFORT_UNSET_LABEL}</option>
                  {AGENT_EFFORT_CHOICES.map(c => (
                    <option key={c.id} value={c.id}>{c.label}</option>
                  ))}
                </select>
              </div>
              {/* IF THAT MODEL IS BUSY — the stand-in. Drawn from the SAME list
                  the model picker above draws, so it can only ever be a model
                  this app really offers. Leaving it alone is a real answer and
                  is what every agent he already owns does: a busy model is
                  then a turn that failed, and he is told so. */}
              <div className="field-row">
                <label htmlFor="f-standin">If that model is busy</label>
                <select className="select" id="f-standin" value={standIn}
                  onChange={e => setStandIn(e.target.value)}>
                  <option value="">Don't try another one — tell me it failed</option>
                  {ids.filter(id => id !== (ids.includes(model) ? model : preferred))
                    .slice(0, FALLBACK_MODEL_LIMITS.count + 6)
                    .map(id => (
                      <option key={id} value={id}>Use {modelLabel(id)} instead</option>
                    ))}
                </select>
              </div>
              {/* SHOW ME THE PLAN FIRST. Off for every agent he already has, and
                  off for a new one — this can only ever be switched on by hand.
                  Only the Claude app has a plan mode, so a Codex agent is told
                  that here rather than being offered a switch that does nothing
                  (`canPlan` in the engine refuses such a turn out loud too). */}
              <label className="toggle-row" key="planfirst">
                <span className="tx">
                  <b>Show me the plan first</b>
                  <span>
                    {provider === "codex"
                      ? "Only agents on Claude can do this — Codex has no plan mode."
                      : "It says what it intends to do and waits for your go-ahead. "
                        + "Nothing runs until you say so."}
                  </span>
                </span>
                <input className="sw" type="checkbox" aria-label="Show me the plan first"
                  disabled={provider === "codex"}
                  checked={planFirst && provider !== "codex"}
                  onChange={e => setPlanFirst(e.target.checked)} />
              </label>
              {/* THE MOST THIS AGENT MAY SPEND. Both boxes blank by default and
                  blank on every agent he already has, so nothing changes for
                  them. Only the Claude app reports what a turn cost — one owner
                  for that fact, `providerCanBeCapped` — so a Codex agent is told
                  plainly rather than shown boxes that would do nothing. */}
              <div className="field-row">
                <label htmlFor="f-perjob">Most it may spend on one job</label>
                {providerCanBeCapped(provider)
                  ? <input className="input" id="f-perjob" type="text" inputMode="decimal"
                    value={perJob} placeholder="no limit"
                    onChange={e => { setPerJob(e.target.value); setRefusal(null); }} />
                  : <input className="input" id="f-perjob" type="text" disabled
                    value="" placeholder="Codex doesn't report what a turn costs"
                    title="Only agents on Claude can be given a spending limit" />}
              </div>
              <div className="field-row">
                <label htmlFor="f-permonth">Most it may spend in a month</label>
                {providerCanBeCapped(provider)
                  ? <input className="input" id="f-permonth" type="text" inputMode="decimal"
                    value={perMonth} placeholder="no limit"
                    onChange={e => { setPerMonth(e.target.value); setRefusal(null); }} />
                  : <input className="input" id="f-permonth" type="text" disabled
                    value="" placeholder="Codex doesn't report what a turn costs"
                    title="Only agents on Claude can be given a spending limit" />}
              </div>
              {/* SAID BEFORE HE PRESSES SAVE, in the form, by the SAME function
                  the hub will judge it with — so the sentence he reads here is
                  the sentence he would have got back. */}
              {validateSpendCap(capFromBoxes()) && (
                <p className="refusal" data-refuse="spendcap">
                  {validateSpendCap(capFromBoxes())}
                </p>
              )}
              {providerCanBeCapped(provider) && (perJob.trim() || perMonth.trim()) && (
                <p className="meta" data-hint="spendcap">
                  Amounts are in dollars, smallest {SPEND_CAP_LIMITS.minUsd.toFixed(2)}.
                  Leave a box empty for no limit. When a limit is reached the agent stops
                  and says so — it never half-finishes in silence.
                </p>
              )}
            </div>
            <p className="sec-note" style={{ marginTop: 8 }}>
              {effort
                ? AGENT_EFFORT_CHOICES.find(c => c.id === effort)!.hint
                : AGENT_EFFORT_UNSET_HINT}
            </p>
            <p className="sec-note" style={{ marginTop: 8 }}>
              {fallback
                ? "This is the list Cloud9 ships with. Once the app is signed in under Settings, its own list is used."
                : `${countOf(ids.length, "model")} offered by your ${PROVIDER_LABEL[provider]} app.`}
            </p>
            {!creating && !agent!.model && (
              <div className="notice modelunset">
                No model is saved for {agent!.name} yet, so its turns run on whatever
                its app picks. Press <b>Save</b> to pin the one shown above.
              </div>
            )}
          </section>

          <section className="fieldset reachsec">
            <div className="sec-head"><h3>How far they can go</h3><span className="eyebrow">Reach</span></div>
            <p className="sec-note">
              One choice, {countOf(REACH_LEVELS.length, "rung")}. Each rung is everything below it and more — and anything
              that changes this computer or spends money stops and asks you first.
            </p>

            {/* THE ONE PRESS THAT MEANS "WORK ON MY COMPUTER", ABOVE THE LADDER.
                It is the top rung and nothing else (see the block comment on the
                component), offered first because it is the thing he keeps asking
                for by name — and it opens the folder picker in the same action,
                so it cannot leave a switch on with nothing behind it. */}
            <WorkOnMyComputer shownName={shownName} creating={creating} provider={provider}
              ab={ab} roots={roots} connFile={connFile}
              onGrant={setAb} onRoots={setRoots} onConnFile={setConnFile} />
            {/* SOME SWITCHES ARE NOT HIS TO TURN OFF, AND THAT IS SAID FIRST.
                Codex keeps its web, file, helper-agent and command tools at
                every setting, so an agent on Codex holds them whatever the
                switches said. Agents saved before this was known simply refused
                to run. Now the app shows what is true, says why, and lets him
                move the agent to Claude if he wants those doors shut. */}
            {forcedOn.length > 0 && (
              <div className="notice reachforced" data-forced={forcedOn.map(c => c.ability).join(",")}>
                <b>{PROVIDER_LABEL[provider]} always brings {forcedOn.length} of these with it.</b>
                <span>
                  {forcedOn.map(c => c.label).join(", ")} — {FORCED_ON_NOTE} They are shown
                  switched on below because they really are on. Only the top rung matches
                  that, so any other rung reads as your own mixture. Move this agent to
                  Claude if you want those doors shut.
                </span>
              </div>
            )}

            {/* THE MIXTURE, SAID BEFORE THE LADDER AND NOT UNDER IT. A glance at
                a ladder is the whole point of a ladder, so the one case where no
                rung is his answer has to be inside that glance — above the rungs,
                not in a footnote below them. It names what is really on, because
                that is the truth the switches hold; it names no rung at all,
                because naming one would be inventing an answer. */}
            {!chosenRung && (
              <div className="notice reachmixed" data-mixture="yes"
                data-on={abilitiesOnNow.map(c => c.ability).join(",")}>
                <b>
                  Your own mixture — {countOf(abilitiesOnNow.length, "ability")} of{" "}
                  {CAPABILITIES.length} switched on.
                </b>
                <span>
                  {abilitiesOnNow.length === 0
                    ? "Nothing is switched on."
                    : `On right now: ${abilitiesOnNow.map(c => c.label).join(", ")}.`}
                  {" "}This is not one of the {REACH_LEVELS.length} rungs, so none of them is picked below.
                  Pick a rung to replace your mixture, or leave it as it is — the switches
                  are what the agent actually gets.
                </span>
              </div>
            )}

            <div className="reachladder" role="group" aria-label="How far this agent can go"
              data-reach={chosenRung ?? "mixture"}>
              {REACH_LEVELS.map((rung, i) => (
                <button key={rung.level} className="reachrung" data-reach={rung.level}
                  data-within={chosenIndex >= 0 && i <= chosenIndex ? "yes" : "no"}
                  aria-pressed={rung.level === chosenRung}
                  onClick={() => pickRung(rung.level)}>
                  <span className="rr-spine" aria-hidden="true"><span className="rr-node" /></span>
                  <span className="rr-tx">
                    <b>{rung.label}</b>
                    <span>{rung.plainWords}</span>
                  </span>
                  <span className="rr-count">
                    {rung.rows === 0 ? "nothing" : `${rung.rows} of ${CAPABILITIES.length}`}
                  </span>
                </button>
              ))}
            </div>

            {/* A DISCLOSURE HE OWNS, not one the ladder keeps re-deciding for him.
                Written as a button and a conditional rather than <details open>,
                because a controlled `open` fights the browser: he opens it, a
                rung click re-renders, and it shuts under his hand. It starts
                open only when the agent arrived with a mix of its own. */}
            <div className="abilitypick" data-open={switchesOpen ? "yes" : "no"}>
              <button className="abilityshow" aria-expanded={switchesOpen}
                onClick={() => setShowSwitches(v => !v)}>
                Or pick them one by one
              </button>
              <div className="panelbox" hidden={!switchesOpen}>
                {/* A LOCKED SWITCH IS DRAWN AS ON BECAUSE IT IS ON. The honesty
                    law here is "never show a tick for something that isn't
                    true" — and for a Codex agent these tools really are in its
                    hands, so ON is the truthful face and OFF was the lie. It is
                    disabled rather than hidden: he can see the power, see that
                    it is not his to switch off, and read why in one line. */}
                {CAPABILITIES.map(cap => {
                  const locked = isForcedOn(cap.ability);
                  return (
                    <label className="toggle-row" key={cap.ability} data-ability={cap.ability}
                      data-locked={locked ? "yes" : "no"}>
                      <span className="tx">
                        <b>
                          {cap.label}
                          {cap.alwaysAsk && <span className="chip is-gold">asks you first</span>}
                          {locked && <span className="chip">always on</span>}
                        </b>
                        {locked && <span>{FORCED_ON_NOTE}</span>}
                      </span>
                      <input className="sw" type="checkbox" aria-label={cap.label}
                        checked={effAb[cap.ability] === true}
                        disabled={locked}
                        title={locked ? FORCED_ON_NOTE : undefined}
                        onChange={e => flipSwitch(cap.ability, e.target.checked)} />
                    </label>
                  );
                })}
              </div>
              {switchesOpen && (
                <p className="sec-note" style={{ marginTop: 10 }}>
                  {forcedOn.length > 0
                    ? "Off means the ability doesn't exist for this agent — except for the "
                      + "greyed-out ones above, which its app cannot give up."
                    : "Off means the ability doesn't exist for this agent — not even with permission."}
                </p>
              )}
            </div>

            {/* THE ONE SWITCH THAT NOW HAS SOMEWHERE TO POINT. "Use connected
                services" is allowed by the switch and DELIVERED by a file — so
                the file is chosen right here, under the switch that allows it,
                and the block says plainly what this agent really has. It reads
                the same function the engine host reads, so it cannot promise
                something the command line will not carry. */}
            <ConnectionsFilePick agentName={shownName} agentDraft={draft}
              file={connFile} onChoose={setConnFile} />

            {/* THE LAST SWITCH THAT HAD NOWHERE TO POINT. "Reach files outside
                its own folder" is allowed by the switch and DELIVERED by a list
                of folders — so the folders are chosen right here, under the
                switch that allows it, in his words: folders on this computer
                this agent may read and change, besides its own. It reads the
                same function the engine host reads, so it cannot promise reach
                the command line will not carry. */}
            <WholeComputerPick agentName={shownName} agentDraft={draft}
              roots={roots} onChange={setRoots} />

            {/* A SWITCH THAT IS ON AND STILL GRANTS NOTHING MUST SAY SO — and
                as of 2026-08-04 there is no such switch left in Cloud9, so this
                never draws. It is kept, not deleted: the next capability that
                needs something the app cannot yet ask for goes in the list
                above and this notice comes back on its own. Saying it costs a
                sentence; letting him believe he opened a door that is still
                shut costs his trust in every other switch. */}
            {inertSwitches.length > 0 && (
              <div className="notice inertswitch" data-inert={inertSwitches.join(",")}>
                <b>On, but not doing anything yet.</b>
                <ul>
                  {inertSwitches.map(key => (
                    <li key={key} data-inert-row={key}>
                      <b>{CAPABILITIES.find(c => c.ability === key)?.label ?? key}</b> is switched
                      on, but this app has nowhere yet for you to give it what it needs. Until
                      there is, {shownName} gets nothing from it.
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* WHOSE SETUP THIS AGENT RUNS IN — his choice, on this agent, with
                one honest line about what changes and one about what it costs.
                It sits directly above the honesty card because the card's answer
                DEPENDS on it: with his setup loaded, "nothing else reaches it"
                stops being true, and the card says so instead of reassuring him. */}
            <div className="panelbox ownersetup" data-owner-setup={ownerSetup ? "on" : "off"}>
              <button className="choice-row ownersetuppick" aria-pressed={ownerSetup}
                onClick={() => setOwnerSetup(!ownerSetup)}>
                <b>{OWNER_SETUP_WORDS.label}{ownerSetup ? "" : " — off"}</b>
                <span>{ownerSetup ? OWNER_SETUP_WORDS.oneLine : OWNER_SETUP_WORDS.whenOff}</span>
              </button>
              {/* The cost is said ONCE, and only when it applies — a warning he
                  reads under a switch he has turned off is a warning he learns
                  to skip past on the day it matters. */}
              {ownerSetup && (
                <p className="sec-note ownersetupcost">{OWNER_SETUP_WORDS.cost}</p>
              )}
              <p className="sec-note ownersetupkept">{OWNER_SETUP_WORDS.keptBack}</p>
            </div>

            <HarnessHonesty provider={provider} forcedOn={forcedOn}
              mode={ownerSetup ? "owner" : "declared"} />
          </section>

          <section className="fieldset whocanuse">
            <div className="sec-head"><h3>Who can use this agent?</h3><span className="eyebrow">Permission</span></div>
            <p className="sec-note">
              This agent runs on your computer and its answers are paid for by your account,
              so nobody else can set it working unless you say so.
            </p>
            <div className="panelbox">
              {([
                ["owner", "Just me", "Nobody else can @mention it or hand it a job.", true],
                ["allowlist", "Me and these people", "Choose exactly who below.", false],
                ["anyone", "Anyone in the room", "Everyone who can see the conversation can set it working.", false],
              ] as const).map(([value, title, why, recommended]) => (
                <button key={value} className="choice-row respondpick" data-respond={value}
                  aria-pressed={respondTo === value} onClick={() => setRespondTo(value)}>
                  <span className="tick" aria-hidden="true">{respondTo === value ? "●" : "○"}</span>
                  <span className="tx">
                    <b>{title}{recommended && <span className="chip">Recommended</span>}</b>
                    <span>{why}</span>
                  </span>
                </button>
              ))}
            </div>
            {respondTo === "allowlist" && (
              <div className="allowpick">
                {world.users.filter(u => u.id !== world.me?.id).length === 0
                  ? <div className="d-empty">Nobody else is in this Cloud9 yet — invite someone first.</div>
                  : onePerPerson(world.users).filter(u => u.id !== world.me?.id).map(u => {
                    const on = allowlist.includes(u.id);
                    return (
                      <label className="allowrow" key={u.id} data-person={u.name}>
                        <input type="checkbox" checked={on} aria-label={u.name}
                          onChange={e => setAllowlist(list =>
                            e.target.checked ? [...list, u.id] : list.filter(id => id !== u.id))} />
                        <PersonFace name={u.name} size={24} />
                        <span className="nm">{u.name}</span>
                      </label>
                    );
                  })}
              </div>
            )}
          </section>

          {/* HOW MUCH HE WANTS TO BE INTERRUPTED — HIS CHOICE, ABOVE THE RULES.
              It sits before "when to stop and ask" because it decides how much
              of that section is even true: an agent on "just get on with it"
              does not stop for the first two rules below at all. Drawn with the
              same `choice-row` as "who can use this agent", because it is the
              same shape of decision — one of three, his, changeable in one
              press, and readable off the card afterwards. */}
          <section className="fieldset trustsec">
            <div className="sec-head">
              {/* A SECTION IS NAMED FOR WHAT IT CONTROLS, NEVER FOR WHOSE IT IS
                  (2026-08-06). This heading read "How much can {name} do on its
                  own?" — the only one of the editor's nine that changed with the
                  agent. Two consequences, and neither is cosmetic. The obvious
                  one: the same control is called something different on every
                  agent, so it cannot be looked for by name. The one that cost a
                  day: it made "does a hired agent offer what a hand-made one
                  does?" unanswerable — compare the two editors and this section
                  looks MISSING from both, because "…can Drivecheck do…" and
                  "…can Architect do…" are not the same words. The agent's name
                  still appears immediately below, in the sentence that is
                  actually about that agent. */}
              <h3>How much they can do on their own</h3>
              <span className="eyebrow">Trust</span>
            </div>
            <p className="sec-note">
              {shownName} can run programs, change your files and work on your computer.
              This is how often it has to stop and wait for you while it does.
            </p>
            <div className="panelbox">
              {TRUST_LEVELS.map(t => (
                <button key={t.level} className="choice-row trustpick" data-trust={t.level}
                  aria-pressed={trust === t.level} onClick={() => setTrust(t.level)}>
                  <span className="tick" aria-hidden="true">{trust === t.level ? "●" : "○"}</span>
                  <span className="tx">
                    <b>
                      {t.label}
                      {t.level === NEW_AGENT_TRUST && <span className="chip">Recommended</span>}
                      {t.warning && <span className="chip is-gold">Read this first</span>}
                    </b>
                    <span>{t.plainWords}</span>
                  </span>
                </button>
              ))}
            </div>
            {/* THE ONE SENTENCE HE IS ACCEPTING, and only when he has actually
                picked the setting that needs it. It is the setting's OWN
                sentence, carried on the same row in shared as the setting — so
                the most permissive choice cannot be given a gentler description
                here than the one the rule was written with. */}
            {trustLevel(trust).warning && (
              <div className="notice trustwarn" data-trust-warning={trust}>
                <b>You are choosing to be told afterwards, not asked first.</b>
                <span>{trustLevel(trust).warning}</span>
              </div>
            )}
            {/* WHAT STILL ASKS, LISTED RATHER THAN PROMISED. Under the middle
                setting this is the whole point of the setting, so it is spelled
                out from the same rule the engine obeys — never a reassuring
                sentence written by hand beside it. */}
            {/* ITS OWN CLASS, AND THIS IS THE FIX RATHER THAN A RENAME
                (2026-08-06). This box and the one in "When to stop and ask"
                below both wore `.willask`, so the editor drew two identical
                amber boxes with DIFFERENT lists and Vikas was told the same
                thing twice, disagreeing with itself. They are not the same
                thing: this one answers "given the trust setting you just
                picked, what still asks?", and the other answers "which of the
                powers you gave it raise a card?". One owner per question, one
                class per question — and the heading now says which question it
                is answering, so the two are told apart by reading and not only
                by CSS. */}
            {trust === "localFree" && (
              <div className="trustasks" data-remote-asks={describeRemoteAsks({ trust }).length}>
                <span className="wa-head">
                  Because of the setting above, it will still stop and ask you before it can:
                </span>
                <ul>
                  {describeRemoteAsks({ trust }).map(w => <li key={w} data-ask={w}>{w}</li>)}
                </ul>
                <span className="wa-note">
                  Everything else — running programs, reading and changing your files, git
                  on this computer — {shownName} does without stopping.
                </span>
              </div>
            )}
            {!creating && trustOf(agent ?? {}) !== trust && (
              <p className="sec-note" data-trust-unsaved="yes">
                Not saved yet — {shownName} still {trustWords(agent ?? {}).toLowerCase()} until
                you press <b>Save</b>.
              </p>
            )}
          </section>

          <section className="fieldset asksec">
            <div className="sec-head"><h3>When to stop and ask</h3><span className="eyebrow">Approval rules</span></div>
            <p className="sec-note">Anything matching a rule pauses the job and lands in Tasks with your name on it.</p>
            {/* THE SETTING ABOVE CAN SWITCH THESE RULES OFF, AND IT SAYS SO HERE
                RATHER THAN LETTING THEM LOOK LIVE. A row of toggles that cannot
                fire is the same lie as a capability switch with nothing behind
                it — and this screen has already been through that once. */}
            {trust !== "askEveryTime" && (
              <div className="notice trustquiet" data-quiet={trust}
                data-still-asks={ap.background || ap.schedules ? "yes" : "no"}>
                <b>
                  {ap.background || ap.schedules
                    ? "Your choice above has quietened this, but these two rules still fire."
                    : "Nothing below is stopping this agent any more."}
                </b>
                <span>
                  You chose “{trustLevel(trust).label}” for {shownName}, so having powerful
                  abilities no longer stops a job on its own.{" "}
                  {ap.background || ap.schedules
                    ? "The two switches below are rules YOU set by hand, so they still stop it. "
                      + "Turn them off here if you meant to stop being asked altogether."
                    : "Neither switch below is on, so nothing stops it."}
                  {" "}
                  {trust === "localFree"
                    ? "Anything that leaves this computer still asks you, wherever it happens."
                    : "Nothing that leaves this computer asks you either."}
                </span>
              </div>
            )}
            {willAsk.length > 0 && (
              <div className="willask" data-asks={willAsk.length}>
                <span className="wa-head">Because of the powers you gave it, you'll be asked before it:</span>
                <ul>
                  {willAsk.map(w => (
                    <li key={w} data-ask={w}>{w.charAt(0).toLowerCase() + w.slice(1)}</li>
                  ))}
                </ul>
                <span className="wa-note">
                  These are not switches. Handing {shownName} one of those powers IS turning the
                  asking on — the only way to stop being asked is to take the power back above.
                </span>
              </div>
            )}
            <div className="panelbox">
              {toggle("Background work", "Ask before it takes a job away to work on", ap.background, v => setAp({ ...ap, background: v }))}
              {toggle("Making a schedule", "Ask before it sets itself a repeating job", ap.schedules, v => setAp({ ...ap, schedules: v }))}
            </div>
          </section>

          <section className="fieldset">
            <div className="sec-head"><h3>Skills</h3><span className="eyebrow">Things you have taught them</span></div>
            <p className="sec-note">
              A skill is a named routine with your instructions. {shownName} picks the right one when a job matches it.
              Write your own, upload one, or take one of the {SKILL_LIBRARY.length} ready-written
              skills Cloud9 ships with — whichever way it arrives, it is an ordinary skill you can change.
            </p>
            <SkillsEditor skills={skills} onChange={setSkills}
              agentName={shownName} roleId={hiredRoleId} />
          </section>

          {/* WHAT THEY HAVE ACTUALLY BEEN DOING. Only for an agent that is
              yours: the hub answers this question for the owner and nobody
              else, so an agent you merely share a room with is not asked
              about at all rather than asked and refused. */}
          {!creating && agent!.ownerId === world.me?.id && (
            <section className="fieldset recentsec">
              <div className="sec-head"><h3>What they've been doing</h3><span className="eyebrow">Recent work</span></div>
              <p className="sec-note">
                Every turn {shownName} takes is written down — what it did, how long it took,
                and what it cost when the app says so. Only you can see this.
              </p>
              <RecentWork agentId={agent!.id} />
            </section>
          )}

          {/* WHAT THIS AGENT REMEMBERS. Owner-only, like its work above: the
              engine on this computer answers this for the owner and nobody else,
              and the notes are read off its own store — nothing here is
              invented, and an empty memory says exactly that. */}
          {!creating && agent!.ownerId === world.me?.id && (
            <section className="fieldset rememberssec">
              <div className="sec-head"><h3>What this agent remembers</h3><span className="eyebrow">Memory</span></div>
              <p className="sec-note">
                {shownName} keeps a few durable notes between conversations and reads them
                back at the start of every turn. Tell it to keep one in chat with{" "}
                <b>@{shownName} !remember …</b> — and to hand a job to another agent, type{" "}
                <b>@{shownName} !handoff @OtherAgent …</b>. Only you can see these.
              </p>
              <RememberedNotes agentId={agent!.id} />
            </section>
          )}
        </div>

        <aside className="preview-col">
          <div className="preview-sticky">
            <span className="eyebrow" style={{ display: "block", marginBottom: 12 }}>How they'll appear</span>
            <div className="preview-card">
              <div className="plate"><Portrait identity={shownName} fill /></div>
              <div className="info">
                <h3>{shownName}</h3>
                <div className="role">{persona.trim() ? roleOf(persona) : "No job written yet"}</div>
                <div className="runs">
                  <span className={`chip ${provider === "claude" ? "is-gold" : "is-ultra"}`}>{PROVIDER_LABEL[provider]}</span>
                  <span className="chip">{modelLabel(model)}</span>
                  {!creating && life !== "enabled" && <span className="chip">Off duty</span>}
                </div>
              </div>
            </div>
            <p className="preview-note">
              The face is drawn from the name, so {shownName} wears the same plate on
              every computer and after every restart.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ================= search across everything you can see ================= */

/**
 * The relay marks what it matched with « », because a snippet is text and
 * markup in it would be a way to draw anything. This turns those marks into
 * highlights — and NOTHING else in the snippet is ever treated as markup.
 *
 * Two ways a plain split got that wrong, and both showed on screen:
 *
 *  - THE MARKS ARE NOT ESCAPED. A message that itself contains « or » was cut
 *    up by its own words and given a highlight it never earned — the app
 *    claiming a match the hub never found. Nothing in the snippet distinguishes
 *    the hub's marks from the writer's, so when the message body carries either
 *    character this draws the snippet plainly. No highlight is honest; an
 *    invented one is not.
 *  - A SNIPPET IS CUT SHORT, and the cut can fall between « and ». A « with no
 *    » after it is a highlight that runs to the end of what we were given, and
 *    a » with no « before it started before the piece we were given. Either
 *    way what it is NOT is a stray bracket printed at the reader.
 */
function Snippet({ text, body }: { text: string; body?: string }): React.JSX.Element {
  const ambiguous = body !== undefined && (body.includes("«") || body.includes("»"));
  // When the marks cannot be trusted, show what the person actually WROTE,
  // unmarked. Passing the marked-up snippet through instead would print the
  // hub's brackets at the reader on top of their own.
  const parts = ambiguous ? [clip(body ?? text, 180)] : splitOnMarks(text);
  return (
    <span className="snippet" data-marked={ambiguous ? "plain" : "marks"}>
      {parts.map((part, i) => (
        i % 2 === 1 ? <mark key={i}>{part}</mark> : <React.Fragment key={i}>{part}</React.Fragment>
      ))}
    </span>
  );
}

/** As much of a message as a result line has room for, cut on a word. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}…`;
}

/**
 * A snippet split into plain/highlighted/plain/highlighted… pieces.
 *
 * Walked rather than split by regex, so a mark left open by the cut is closed
 * at the end of the text instead of being left on screen as a `«`.
 */
function splitOnMarks(text: string): string[] {
  // pieces alternate plain, highlighted, plain, highlighted… so it starts plain
  const parts: string[] = [];
  let plain = "";
  let i = 0;
  // a closing mark before any opening one closes a highlight that began BEFORE
  // the piece we were handed: everything up to it is part of that match
  const firstOpen = text.indexOf("«");
  const firstClose = text.indexOf("»");
  if (firstClose >= 0 && (firstOpen < 0 || firstClose < firstOpen)) {
    parts.push("", text.slice(0, firstClose));
    i = firstClose + 1;
  }
  while (i < text.length) {
    const open = text.indexOf("«", i);
    if (open < 0) break;
    plain += text.slice(i, open);
    const close = text.indexOf("»", open + 1);
    // no closing mark: the cut fell inside a highlight, so it runs to the end
    const end = close < 0 ? text.length : close;
    parts.push(plain, text.slice(open + 1, end));
    plain = "";
    i = close < 0 ? text.length : close + 1;
  }
  parts.push(plain + text.slice(i));
  return parts;
}

/**
 * THE FIVE DOORS OF ONE SEARCH — and there is only one search panel.
 *
 * `everywhere` is the whole net and it is what opens by default, because the
 * question a person actually has is "where did I see that", not "was it a
 * message or a file". The three narrow doors are the hub's own `kind`, in the
 * hub's own words, so nobody keeps two vocabularies.
 *
 * `messages` is the older message-only question, kept because it is the ONLY
 * one that understands `in:` and `from:` — a room and a person are filters the
 * wide search deliberately does not take. It is a different question with a
 * different answer shape, so it has its own renderer below and the two never
 * run at once.
 */
type SearchScope = "everywhere" | "messages" | "reply" | "file" | "fileVersion";

const SEARCH_SCOPES: { id: SearchScope; label: string }[] = [
  { id: "everywhere", label: "Everything" },
  { id: "messages", label: "Messages" },
  { id: "reply", label: "Replies in threads" },
  { id: "file", label: "Files" },
  { id: "fileVersion", label: "Old versions" },
];

/** The hub's four kinds, said the way a person would say them. */
const KIND_WORDS: Record<SearchKind, string> = {
  message: "Message",
  reply: "Reply in a thread",
  file: "File",
  fileVersion: "Old version of a file",
};

/** The `kind` a scope narrows to — `everywhere` narrows to nothing, on purpose. */
function kindOfScope(scope: SearchScope): SearchKind | undefined {
  return scope === "everywhere" || scope === "messages" ? undefined : scope;
}

/** One row's identity — a version is a different row from the file it belongs to. */
function everywhereKey(hit: EverywhereHit): string {
  return `${hit.kind}:${hit.messageId ?? hit.artifactId ?? "?"}:${hit.versionId ?? ""}`;
}

function SearchOverlay({ onClose, onGo, onOpenHit }: {
  onClose: () => void;
  onGo: (channelId: ID, messageId: ID) => void;
  /** follow one wide-search result to the thing itself — see `openEverywhereHit` */
  onOpenHit: (hit: EverywhereHit) => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<SearchScope>("everywhere");
  const boxRef = useRef<HTMLInputElement>(null);
  const state = world.search;
  const wide = world.everywhere;

  useEffect(() => { boxRef.current?.focus(); }, []);
  /* Was an `onKeyDown` on the panel, which meant Escape worked only while the
     focus was still inside it. One owner now, focus or no focus. */
  useEscapeCloses(onClose);

  /**
   * `in:` and `from:` are resolved to ids HERE, because the relay does not take
   * names — a display name is not an identity, and two people may share one.
   * An unknown name is left in the words rather than silently dropped.
   */
  const parsed = useMemo(() => {
    let words = q;
    let channelId: ID | undefined;
    let authorId: ID | undefined;
    const takeChannel = /(?:^|\s)in:([\w-]+)/i.exec(words);
    if (takeChannel) {
      const found = world.channels.find(c =>
        c.kind === "channel" && c.name.toLowerCase() === takeChannel[1].toLowerCase());
      if (found) { channelId = found.id; words = words.replace(takeChannel[0], " "); }
    }
    const takeAuthor = /(?:^|\s)from:([\w-]+)/i.exec(words);
    if (takeAuthor) {
      const person = world.users.find(u => u.name.toLowerCase() === takeAuthor[1].toLowerCase());
      const bot = world.agents.find(a => a.name.toLowerCase() === takeAuthor[1].toLowerCase());
      const who = person ?? bot;
      if (who) { authorId = who.id; words = words.replace(takeAuthor[0], " "); }
    }
    return { words: words.trim(), channelId, authorId };
  }, [q, world.channels, world.users, world.agents]);

  /* THE WIDE SEARCH TAKES THE WORDS AS TYPED. `in:` and `from:` are the
     message-only question's own grammar, and pretending to honour them here
     would mean searching every room for the literal word "in:general". */
  const wideWords = q.trim();

  /* ONE QUESTION AT A TIME. Changing door calls BOTH searches off rather than
     leaving an answer sitting under the new heading, which is exactly how a
     stale list gets read as an answer to a question nobody asked.
     Calling off only the OTHER one was not enough: every scope but "messages"
     is the same wide search asked a narrower way, so stepping from "everything"
     to "files" left the whole wide answer — messages, replies and all — sitting
     under the Files heading until the narrower answer landed. The pill said
     files; the list said everything. Both go, every time. */
  useEffect(() => {
    client.clearSearch();
    client.clearEverywhere();
  }, [scope]);

  // debounced, so typing a word is one search and not six
  useEffect(() => {
    if (scope !== "messages") return;
    if (parsed.words.length < 2) { client.clearSearch(); return; }
    const t = setTimeout(() => {
      client.search(parsed.words, { channelId: parsed.channelId, authorId: parsed.authorId });
    }, 200);
    return () => clearTimeout(t);
  }, [scope, parsed.words, parsed.channelId, parsed.authorId]);

  /* The same debounce for the wide search — and the same rule about an empty
     box: under two letters NOTHING is asked. A request per keystroke would put
     the hub's "type at least one word" on screen while he was still typing it. */
  useEffect(() => {
    if (scope === "messages") return;
    if (wideWords.length < 2) { client.clearEverywhere(); return; }
    const kind = kindOfScope(scope);
    const t = setTimeout(() => client.searchEverywhere(wideWords, kind), 200);
    return () => clearTimeout(t);
  }, [scope, wideWords]);

  /** Wide results in the hub's order, gathered under the kind each one is. */
  const wideGroups = useMemo(() => {
    const out = new Map<SearchKind, EverywhereHit[]>();
    for (const hit of wide?.results ?? []) {
      const held = out.get(hit.kind);
      if (held) held.push(hit);
      else out.set(hit.kind, [hit]);
    }
    return [...out.entries()];
  }, [wide?.results]);

  const wideTotal = wide?.results.length ?? 0;
  /* "Nothing found" is only sayable about an answer that ARRIVED, and only
     about the words that answer belongs to. Anything else is a guess printed
     while the hub is still thinking. */
  const wideAnswered = !!wide && !wide.running && wide.answered === wideWords;

  /** Results grouped by the conversation they were said in, newest group first. */
  const groups = useMemo(() => {
    const out = new Map<ID, { name: string; kind: string; hits: SearchHit[] }>();
    for (const hit of state?.results ?? []) {
      const cid = hit.message.channelId;
      const existing = out.get(cid);
      if (existing) existing.hits.push(hit);
      else out.set(cid, { name: hit.channelName, kind: hit.channelKind, hits: [hit] });
    }
    return [...out.entries()];
  }, [state?.results]);

  const total = state?.results.length ?? 0;

  return (
    <div className="overlay searchveil" onClick={onClose}>
      <div className="panel searchpanel" onClick={e => e.stopPropagation()}>
        <div className="head">
          Search everything you can see
          <span className="eyebrow">Esc to close</span>
        </div>
        {/* THE FIVE DOORS, on the one panel. Which one is open is the only
            piece of state that decides what is asked and what is drawn, so the
            heading, the box and the list can never disagree about it. */}
        <div className="searchscopes" role="group" aria-label="What to search"
          data-search-scope={scope}>
          {SEARCH_SCOPES.map(s => (
            <button key={s.id} className="chip scopepill" data-scope={s.id}
              aria-pressed={scope === s.id} onClick={() => setScope(s.id)}>
              {s.label}
            </button>
          ))}
        </div>

        <div className="searchbar">
          <span className="find-mark" aria-hidden="true">⌕</span>
          <input ref={boxRef} className="search-input" type="text" value={q}
            aria-label="Search every conversation"
            placeholder={scope === "messages"
              ? "villas in Goa · in:general · from:Priya"
              : "villas in Goa"}
            onChange={e => setQ(e.target.value)} />
          {(scope === "messages" ? state?.running : wide?.running) &&
            <span className="eyebrow" data-search-running>Looking…</span>}
        </div>

        {scope !== "messages" ? (
          <div className="searchbody" data-every-body={
            wideWords.length < 2 ? "waiting"
              : wide?.problem ? "refused"
              : wide?.running ? "running"
              : wideAnswered && wideTotal === 0 ? "nothing"
              : wideAnswered ? "some" : "running"}>
            {wideWords.length < 2 && (
              <div className="searchhint" data-every-empty>
                <p>
                  Type at least two letters. Cloud9 looks through every message,
                  every reply in a thread, every shared file name and the words
                  inside every version of those files you are allowed to read —
                  older versions included.
                </p>
                <p className="sec-note">
                  Nothing is asked for until you type, so an empty box searches nothing.
                  Rooms you are not in and files you have not been given are never looked at.
                  Use <b>Messages</b> above when you want <code>in:general</code> or{" "}
                  <code>from:Priya</code>.
                </p>
              </div>
            )}
            {/* The hub's own sentence, word for word. Re-spelling a refusal is
                how two different reasons end up reading the same. */}
            {wideWords.length >= 2 && wide?.problem && (
              <div className="searchhint" data-every-refused>
                <p>{wide.problem}</p>
              </div>
            )}
            {wideWords.length >= 2 && !wide?.problem && wide?.running && wideTotal === 0 && (
              <div className="searchhint" data-every-running>
                <p>Looking everywhere you can see…</p>
              </div>
            )}
            {wideWords.length >= 2 && !wide?.problem && wideAnswered && wideTotal === 0 && (
              <div className="searchhint" data-every-nothing>
                <p>Nothing you can see says “{wide.answered}”.</p>
                <p className="sec-note">
                  Try one word on its own, or a different door above.
                </p>
              </div>
            )}
            {wideGroups.map(([kind, hits]) => (
              <section className="searchgroup everygroup" key={kind} data-every-group={kind}>
                <div className="searchgrouphead">
                  <span className="eyebrow">{KIND_WORDS[kind]}</span>
                  <span className="chip">{hits.length}</span>
                </div>
                {hits.map(hit => (
                  <button className="everyhit" key={everywhereKey(hit)}
                    data-every-kind={hit.kind}
                    data-every-hit={hit.messageId ?? hit.artifactId ?? ""}
                    data-every-room={hit.channelId}
                    {...(hit.versionNumber !== undefined
                      ? { "data-every-version": String(hit.versionNumber) } : {})}
                    onClick={() => onOpenHit(hit)}>
                    <span className="hitbody">
                      <span className="hitwho">
                        <b>{hit.whoName}</b>
                        {hit.name && <span className="everyname">{hit.name}</span>}
                        {hit.kind === "fileVersion" && hit.versionNumber !== undefined &&
                          <span className="chip everyv">v{hit.versionNumber}</span>}
                        <span className="t">
                          {hit.channelName} · {dayLabel(hit.when)} · {clock(hit.when)}
                        </span>
                      </span>
                      <Snippet text={hit.snippet} />
                    </span>
                  </button>
                ))}
              </section>
            ))}
            {/* HONEST, AND NOT A PAGE BUTTON. There is no second page to ask
                for, so the line says what to do instead of offering a control
                that does not exist. */}
            {wide?.hasMore && wideTotal > 0 && (
              <p className="sec-note searchmore" data-every-more>
                Showing the first {wideTotal}. More exist — narrow your words.
              </p>
            )}
          </div>
        ) : (
        <div className="searchbody">
          {parsed.words.length < 2 && (
            <div className="searchhint">
              <p>
                Type at least two letters. <code>in:general</code> looks in one channel and{" "}
                <code>from:Priya</code> looks for one person.
              </p>
              {/* The honest limits, in the UI rather than in a document nobody reads */}
              <p className="sec-note">
                It matches whole words in any order, and completes the last word as you type.
                It will not find a word inside another word — “port” does not find “airport” —
                and it does not know that “running” and “run” are the same word.
                Messages that were taken back are never found.
              </p>
            </div>
          )}
          {parsed.words.length >= 2 && !state?.running && state?.answered && total === 0 && (
            <div className="searchhint">
              <p>Nothing you can see says “{state.answered}”.</p>
              <p className="sec-note">Try one word on its own, or drop the <code>in:</code> filter.</p>
            </div>
          )}
          {groups.map(([cid, group]) => (
            <section className="searchgroup" key={cid} data-channel={group.name}>
              <div className="searchgrouphead">
                <span className="eyebrow">
                  {group.kind === "dm" ? "Direct" : "#"}{group.kind === "dm" ? "" : group.name}
                </span>
                <span className="chip">{group.hits.length}</span>
              </div>
              {group.hits.map(hit => (
                <button className="searchhit" key={hit.message.id}
                  data-hit={hit.message.id}
                  onClick={() => onGo(hit.message.channelId, hit.message.id)}>
                  {hit.message.authorKind === "agent"
                    ? <AgentFace name={hit.message.authorName} size={26} />
                    : <PersonFace name={hit.message.authorName} size={26} />}
                  <span className="hitbody">
                    <span className="hitwho">
                      <b>{hit.message.authorName}</b>
                      <span className="t">{dayLabel(hit.message.ts)} · {clock(hit.message.ts)}</span>
                    </span>
                    {/* the real words are handed over too, so the marks can be
                        disbelieved when the message itself contains one */}
                    <Snippet text={hit.snippet} body={hit.message.text} />
                  </span>
                </button>
              ))}
            </section>
          ))}
          {state?.hasMore && total > 0 && (
            <p className="sec-note searchmore">
              Showing the first {total}. Add a word to narrow it down.
            </p>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

/* ================= modals that stay modals ================= */

function InviteModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [copied, setCopied] = useState(false);
  const code = world.inviteCode;
  useEscapeCloses(onClose);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={e => e.stopPropagation()}>
        <div className="head">Invite a friend</div>
        <div className="body">
          <div className="notice">Send them this one-time code. They pick “I have an invite” on the welcome screen. They'll land in #general.</div>
          <div className="code">{code ?? "generating…"}</div>
          <div>
            <button className="btn" disabled={!code}
              onClick={() => { if (code) void navigator.clipboard?.writeText(code).then(() => setCopied(true)); }}>
              {copied ? "Copied ✓" : "Copy the code"}
            </button>
          </div>
        </div>
        <div className="foot"><button className="primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}

/* ================= joining a friend's Cloud9 ================= */

/** The port this computer's own hub answers on, read off the app's own URL. */
function hubPort(): number {
  const m = RELAY_URL.match(/:(\d+)(?:\/|$)/);
  return m ? Number(m[1]) : 8787;
}

/**
 * Every Cloud9 this person can reach — their own and any friends' — with the
 * one that is live, an honest reachability line for each, and the ways to add,
 * switch and forget. Plus, for the owner, minting a link a friend can join with.
 *
 * Nothing here draws a green "connected" for a hub nobody reached: the one
 * connection sentence comes from `connInWords` (via `world.hubConn`), and each
 * hub's reach line comes from `reachInWords` — never a hopeful label.
 */
function FriendsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const owner = isOwner(world.me);
  useEscapeCloses(onClose);
  // A minted join link is dropped when this panel closes — it opens a door, so
  // it should not linger.
  useEffect(() => () => client.clearJoinToken(), []);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel friendspanel" onClick={e => e.stopPropagation()}>
        <div className="head">Cloud9s you can reach</div>
        <div className="body">
          <div className={`notice hubconn phase-${world.hubConn.phase}`} data-phase={world.hubConn.phase}>
            {world.hubConn.line || `On this computer's Cloud9`}
          </div>

          <div className="hublist">
            {world.hubs.map(h => (
              <KnownHubRow key={h.id} hub={h} active={h.id === world.activeHubId} />
            ))}
          </div>

          <AddFriendHub myName={world.me?.name ?? ""} />

          {owner && <InviteFriendLink joinToken={world.joinToken} />}

          <div className="notice honesttailscale">
            Reaching a friend on <b>another</b> computer needs Tailscale — a private network you both
            sign into. That sign-in is yours to do and is <b>not wired up tonight</b>. Everything on
            this screen works today between Cloud9s reachable from here, and over Tailscale once it is
            set up. Cloud9 will never connect to a plain public-internet address.
          </div>
        </div>
        <div className="foot"><button className="primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}

function KnownHubRow({ hub, active }: { hub: KnownHub; active: boolean }): React.JSX.Element {
  return (
    <div className={`hubrow${active ? " is-active" : ""}`} data-hub={hub.id} data-self={hub.isSelf ? "1" : "0"}>
      <div className="hubrow-main">
        <b className="hubname">{hub.label}{active && <span className="chip onnow">On now</span>}</b>
        <span className="hubreach">
          {hub.isSelf ? "only this computer — your own Cloud9" : reachInWords(hub.address.reach)}
        </span>
        <span className="hubaddr">{hub.address.host}:{hub.address.port}</span>
      </div>
      <div className="hubrow-act">
        {!active && (
          <button className="btn small hubswitchbtn" onClick={() => client.switchHub(hub.id)}>Switch to this</button>
        )}
        {!hub.isSelf && (
          <button className="btn small hubforget" onClick={() => client.removeHub(hub.id)}>Forget</button>
        )}
      </div>
    </div>
  );
}

function AddFriendHub({ myName }: { myName: string }): React.JSX.Element {
  const [link, setLink] = useState("");
  const [label, setLabel] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const preview = link.trim() ? client.previewLink(link) : null;

  const add = (): void => {
    const res = client.addHub(label, link, myName);
    if (!res.ok) { setRefusal(res.reason ?? "That link could not be added."); return; }
    setLink(""); setLabel(""); setRefusal(null);
    if (res.id) client.switchHub(res.id); // added — go there now
  };

  return (
    <div className="addfriend">
      <h4>Connect to a friend's Cloud9</h4>
      <div className="field-row">
        <label>Their link</label>
        <input className="input joinlink" type="text" value={link} placeholder="cloud9://100.x.y.z:8787#join_…"
          onChange={e => { setLink(e.target.value); setRefusal(null); }} />
      </div>
      {preview && (preview.ok ? (
        <div className="notice joinpreview ok" data-reach={preview.reach}>
          <b>{preview.host}:{preview.port}</b> — {preview.reachWords}
          {preview.hasToken
            ? " · carries a join link, so you'll be let straight in"
            : " · no join link on it — you'll need one from your friend to be let in"}
        </div>
      ) : (
        <div className="notice joinpreview bad">{preview.reason}</div>
      ))}
      <div className="field-row">
        <label>Call it</label>
        <input className="input joinlabel" type="text" value={label} placeholder="Priya's Cloud9"
          onChange={e => { setLabel(e.target.value); setRefusal(null); }} />
      </div>
      <Problem text={refusal ?? undefined} />
      <button className="primary small addhubbtn" disabled={!preview?.ok || !label.trim()} onClick={add}>
        Add and connect
      </button>
    </div>
  );
}

function InviteFriendLink({ joinToken }: {
  joinToken?: { code: string; expiresInMs: number; ts: number };
}): React.JSX.Element {
  const [net, setNet] = useState<{ address: string; loopbackOnly: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { void desktop()?.hubNetwork?.().then(setNet).catch(() => setNet(null)); }, []);

  // Built honestly from where the hub actually answers: its private-network
  // address if one is set, otherwise loopback — and we SAY which it is.
  const host = net && !net.loopbackOnly ? net.address : "127.0.0.1";
  const link = joinToken ? `cloud9://${host}:${hubPort()}#${joinToken.code}` : "";
  const loopbackOnly = !net || net.loopbackOnly;

  return (
    <div className="invitefriend">
      <h4>Invite a friend to your Cloud9</h4>
      {!joinToken ? (
        <button className="btn small mintjoin" onClick={() => client.requestJoinLink()}>Make a join link</button>
      ) : (
        <>
          <div className="code joincode">{link}</div>
          <button className="btn small copyjoin"
            onClick={() => { void navigator.clipboard?.writeText(link).then(() => setCopied(true)); }}>
            {copied ? "Copied ✓" : "Copy the link"}
          </button>
          <div className="notice">Good for {Math.max(1, Math.round(joinToken.expiresInMs / 60000))} minutes, and only once.</div>
        </>
      )}
      {loopbackOnly && (
        <div className="notice loopbackwarn">
          Right now this link points at <b>this computer only</b> — a friend on another computer can't
          reach it yet. To let them in, put your private-network (Tailscale) address in Settings and make a
          fresh link. That step is yours; it isn't wired up tonight.
        </div>
      )}
    </div>
  );
}

/**
 * The open rooms you are not in (§10.5).
 *
 * Being able to FIND a room is not permission to read it: this list carries a
 * name, what the room is for and how many people are in it, and nothing else —
 * no members, no messages. The hub decides what appears here, and it only ever
 * lists rooms you could actually join.
 */
function BrowseRoomsModal({ onClose, onJoined }: {
  onClose: () => void;
  onJoined: (id: ID) => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [joining, setJoining] = useState<ID | null>(null);
  const dir = world.directory;
  useEscapeCloses(onClose);

  // Asked every time this opens: a list from the last time it was open is not
  // an answer about now, and rooms are opened and shut while it is closed.
  useEffect(() => { client.browseChannels(); }, []);
  // And asked again whenever the answer stops meaning anything — joining a room
  // takes it out of this list, so the list on screen has become wrong.
  useEffect(() => { if (!dir.asked) client.browseChannels(); }, [dir.asked]);

  // The hub answers a join with the ordinary `channel` frame. When the room we
  // asked for turns up in the world, we are in it — open it.
  useEffect(() => {
    if (!joining) return;
    if (world.channels.some(c => c.id === joining)) { onJoined(joining); setJoining(null); }
  }, [joining, world.channels, onJoined]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel browsepanel" onClick={e => e.stopPropagation()}>
        <div className="head">Browse rooms</div>
        <div className="body">
          {!dir.asked && <div className="d-empty">Looking for rooms you can join…</div>}
          {dir.asked && dir.channels.length === 0 && (
            <div className="notice browseempty">
              No open rooms to join. Rooms are private unless someone opens them.
            </div>
          )}
          {dir.channels.length > 0 && (
            <div className="roomcards">
              {dir.channels.map(c => (
                <div className="roomcard" key={c.id} data-room={c.name}>
                  <div className="rc-head">
                    <h4><span className="h">#</span>{c.name}</h4>
                    <span className="roomvis is-open" data-vis="open">
                      <span className="vm" aria-hidden="true">◇</span>{ROOM_OPEN_WORDS}
                    </span>
                  </div>
                  <p className="rc-desc">{c.description || "Nobody has written what this room is for."}</p>
                  {c.topic && <p className="rc-topic">Topic: {c.topic}</p>}
                  <div className="rc-foot">
                    <span className="rc-count">
                      {countOf(c.memberCount, "person", "people")} · started {dayStamp(c.createdAt)}
                    </span>
                    <button className="primary small roomjoin" disabled={joining === c.id}
                      onClick={() => { setJoining(c.id); client.send({ type: "joinChannel", channelId: c.id }); }}>
                      {joining === c.id ? "Joining…" : "Join"}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="foot"><button className="primary" onClick={onClose}>Done</button></div>
      </div>
    </div>
  );
}

function ChannelModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [name, setName] = useState("");
  const [members, setMembers] = useState<ID[]>([]);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEscapeCloses(onClose);

  /* THE HUB'S OWN NAMING RULE, asked here first so he reads the sentence before
     the room fails to appear — the same function `createChannel` runs, never a
     second copy of it. The hub is still the boundary; this is the early word. */
  const create = (): void => {
    const taken = world.channels.filter(c => c.kind !== "dm").map(c => c.name);
    const went = client.submit(
      validateName("channel", name, taken),
      { type: "createChannel", name: name.trim(), memberIds: members, kind: "channel" },
      setRefusal);
    /* CLOSED ONLY ON ACCEPTED. A refused name leaves the box, the name and the
       ticked members exactly where they were, so he can fix the one word that
       was wrong (A3's rule, applied to every form and not just the composer). */
    if (went) onClose();
  };
  const candidates = [
    ...world.agents.map(a => ({ id: a.id, label: `${a.emoji} ${a.name}` })),
    ...onePerPerson(world.users).filter(u => u.id !== world.me?.id).map(u => ({ id: u.id, label: u.name })),
  ];
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={e => e.stopPropagation()}>
        <div className="head">New channel</div>
        <div className="body">
          <div className="field-row"><label>Name</label>
            <input className="input" type="text" value={name}
              onChange={e => { setName(e.target.value.replace(/\s+/g, "-").toLowerCase()); setRefusal(null); }}
              onKeyDown={e => { if (e.key === "Enter") create(); }}
              placeholder="trip-goa" /></div>
          <Problem text={refusal ?? undefined} />
          <div className="field-row"><label>Members</label>
            {candidates.length === 0
              ? <div className="skillempty">Nobody to add yet — you can make the channel now and add people later.</div>
              : <div className="checks">
                {candidates.map(c => (
                  <label key={c.id}>
                    <input type="checkbox" checked={members.includes(c.id)}
                      onChange={e => setMembers(m => e.target.checked ? [...m, c.id] : m.filter(x => x !== c.id))} />
                    {c.label}
                  </label>
                ))}
              </div>}
          </div>
        </div>
        <div className="foot">
          <button className="subtle" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!name.trim()} onClick={create}>Create</button>
        </div>
      </div>
    </div>
  );
}

/* ================= 8 · SETTINGS ================= */
/* No credential ever lives in the browser. The buttons ask the engine host to
 * run the provider's own sign-in; the app only ever displays status, and any
 * fallback key is handed straight to the desktop shell for encrypted storage. */

type Harness = Provider;

interface IpcResult { ok: boolean; error?: string }
interface CredentialStatus {
  canEncrypt: boolean;
  claude?: { hasCredential: boolean; kind: string | null };
  codex?: { hasCredential: boolean; kind: string | null };
}
interface DesktopBridge {
  isDesktop?: boolean;
  setApiKey?: (harness: Harness, kind: string, value: string) => Promise<IpcResult>;
  clearCredential?: (harness: Harness) => Promise<IpcResult>;
  credentialStatus?: () => Promise<CredentialStatus>;
  openAgentFolder?: () => Promise<IpcResult>;
  agentFolder?: () => Promise<string>;
  /**
   * Ask the OWNER, through the operating system's own picker, which folder a
   * project's code is in. The window never touches the filesystem itself.
   * `cancelled` is a normal answer and is not a failure.
   */
  chooseFolder?: (current?: string) => Promise<
    { ok: boolean; path?: string; cancelled?: boolean; error?: string }>;
  /**
   * Ask the OWNER, through the operating system's own picker, which connections
   * file one agent should use — the config the maker of a tool hands you. Same
   * shape and same law as `chooseFolder`: the window never touches the
   * filesystem, and `cancelled` is a normal answer.
   */
  chooseConnectionsFile?: (current?: string) => Promise<
    { ok: boolean; path?: string; cancelled?: boolean; error?: string }>;
  /**
   * "Is the file I was given still on this computer?" — a yes/no and the moment
   * it was asked, and nothing else. Nothing inside the file ever comes back.
   */
  connectionsFileHere?: (file: string) => Promise<{ here: boolean; checkedAt: number }>;
  /**
   * Ask the OWNER, through the operating system's own picker, which folders one
   * agent may reach outside its own — several at once. Same law as the two
   * above: the window never touches the filesystem, and `cancelled` is a normal
   * answer, not a failure.
   */
  chooseWholeComputerFolders?: () => Promise<
    { ok: boolean; paths?: string[]; cancelled?: boolean; error?: string }>;
  /**
   * "Which of the folders I was given are still on this computer?" — the subset
   * that is really there and the moment it was asked, and nothing else. Nothing
   * inside any folder is ever listed or read.
   */
  wholeComputerFoldersHere?: (folders: string[]) => Promise<
    { here: string[]; checkedAt: number }>;
  /**
   * THIS COMPUTER'S HOME FOLDER, as the computer itself says it — what a brand
   * new agent is given so it can reach his PC from its first message. Absent in
   * a browser (dev, QA), and `{ ok: false }` when the machine cannot vouch for
   * it; both mean the same thing here, and it is the only honest one: no folder
   * is claimed. The window never invents a path.
   */
  homeFolder?: () => Promise<{ ok: boolean; path?: string }>;
  /**
   * WINDOWS' OWN NOTIFICATION — the door that reaches him with Cloud9 minimised.
   * Absent in a browser (dev), which is exactly the `osSupported: false` case
   * `chooseDelivery` falls back to the in-app toast for.
   */
  notificationsSupported?: () => Promise<boolean>;
  osNotify?: (note: Cloud9Notification) => Promise<
    { ok: boolean; supported?: boolean; error?: string }>;
  /** He clicked one — the note's ids come back, and the app lands on the thing. */
  onNotificationClick?: (
    handler: (note: { kind?: string | null; channelId?: string | null; subjectId?: string | null }) => void,
  ) => (() => void) | void;
  /** Which address this computer's hub answers on, so a friend can reach it. */
  hubNetwork?: () => Promise<{
    address: string; loopbackOnly: boolean;
    candidates: { name: string; address: string; likelyTailscale: boolean }[];
  }>;
}
const desktop = (): DesktopBridge | undefined =>
  (window as unknown as { cloud9?: DesktopBridge }).cloud9;

const SET_SECTIONS = [
  ["set-look", "Appearance"],
  ["set-replies", "Replies"],
  ["set-agents", "New agents"],
  ["set-notify", "Notifications"],
  ["set-quiet", "Quiet hours"],
  ["set-files", "Agent files"],
  ["set-apps", "Connected apps"],
  ["set-danger", "Danger zone"],
] as const;

function SettingsScreen(): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const p = usePrefs();
  const [stored, setStored] = useState<CredentialStatus | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [folderNote, setFolderNote] = useState<string | null>(null);
  const [here, setHere] = useState<string>("set-look");

  const refreshStored = () => {
    void desktop()?.credentialStatus?.().then(setStored).catch(() => setStored(null));
  };
  // Every harness frame is owner-only in the relay: don't ask for, and don't
  // offer, what can only be refused.
  const owner = isOwner(world.me);

  useEffect(() => {
    if (!owner) { refreshStored(); return; }
    client.send({ type: "refreshHarness" });
    client.send({ type: "harnessStatus" });
    refreshStored();
    void desktop()?.agentFolder?.().then(setFolder).catch(() => setFolder(null));
  }, []);

  const askNotify = (on: boolean) => {
    prefs.set({ notify: on });
    if (on && typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  };

  const goTo = (id: string) => {
    setHere(id);
    /* The same one owner of "may the view animate on this machine" the message
       list uses. This used to ask for a smooth scroll whatever the computer had
       been told about motion. */
    document.getElementById(id)?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  };

  const claudeInfo = world.harness?.claude;
  const codexInfo = world.harness?.codex;

  const themes: [Prefs["theme"], string, string][] = [
    ["light", "Daylight", "prev-light"],
    ["dark", "Studio dark", "prev-dark"],
    ["system", "Follow this computer", "prev-system"],
  ];

  return (
    <div className="settings settingspanel">
      <header className="topbar">
        <h2>Settings</h2>
        <span className="sub">How Cloud9 behaves on this computer</span>
        <div className="grow" />
        <span className="eyebrow">Saved as you change it</span>
      </header>
      <div className="set-body">
        <nav className="set-nav" aria-label="Settings sections">
          {SET_SECTIONS.map(([id, label]) => (
            <button key={id} aria-current={here === id ? "true" : "false"} onClick={() => goTo(id)}>{label}</button>
          ))}
        </nav>
        <div className="set-main">
          <section id="set-look" className="setsect">
            <h3>Appearance</h3>
            <p className="sec-note">Cloud9 follows this computer unless you pick a side.</p>
            <div className="theme-picks">
              {themes.map(([value, label, prev]) => (
                <button key={value} className="theme-pick" data-theme-set={value}
                  aria-pressed={p.theme === value} onClick={() => prefs.set({ theme: value })}>
                  <span className={`prev ${prev}`} aria-hidden="true">
                    <span className="rail-s" />
                    <span className="lines"><i className="l1" /><i className="l2" /><i className="l3" /></span>
                  </span>
                  <span className="nm">{label}</span>
                </button>
              ))}
            </div>
            <div className="panelbox">
              <label className="toggle-row">
                <span className="tx"><b>Tighter message spacing</b><span>Fits more of the conversation on screen.</span></span>
                <input className="sw" type="checkbox" checked={p.compact} aria-label="Tighter message spacing"
                  onChange={e => prefs.set({ compact: e.target.checked })} />
              </label>
            </div>
          </section>

          {/* HIS CHOICE, AND IT CHANGES THE BEHAVIOUR. Each line says what
              actually happens on screen, not which one sounds tidier. */}
          <section id="set-replies" className="setsect">
            <h3>Replies</h3>
            <p className="sec-note">
              What happens when you press <b>Reply</b> on a message. Either way the reply is
              still linked to the message it answers — this is about where you read it.
            </p>
            <div className="panelbox">
              {([
                ["thread", "Open a thread",
                  "The reply is kept on the message it answers. The conversation shows that message with " +
                  "a reply count you can open, and the reply itself does not appear in the conversation.",
                  true],
                ["inline", "Keep it in the conversation",
                  "The reply is posted straight into the conversation, under a line saying which message " +
                  "it answers. No thread opens, ever.",
                  false],
              ] as const).map(([value, title, why, recommended]) => (
                <button key={value} className="choice-row repliespick" data-replies={value}
                  aria-pressed={p.replies === value} onClick={() => prefs.set({ replies: value })}>
                  <span className="tick" aria-hidden="true">{p.replies === value ? "●" : "○"}</span>
                  <span className="tx">
                    <b>{title}{recommended && <span className="chip">Like Slack</span>}</b>
                    <span>{why}</span>
                  </span>
                </button>
              ))}
            </div>
            {/* SAID WHERE THE SETTING IS, because this is the half of "threads"
                that is invisible: a reply kept on its message is not in the
                conversation, so the app has to say out loud how you find out it
                happened. Both halves are true whichever choice is picked — the
                mute list still silences the pop-up, and the room row still says
                where the new thing is. */}
            <p className="sec-note">
              You are told when a thread you started — or have replied in — moves,
              and the conversation's row says when what is new is inside a thread
              rather than in the conversation itself. A room you have turned down
              stays quiet either way; only somebody naming you gets through that.
            </p>
          </section>

          <section id="set-agents" className="setsect">
            <h3>New agents start here</h3>
            <p className="sec-note">What a brand new agent starts with. You can change it per agent afterwards.</p>
            <div className="two">
              <div className="field-row">
                <label>App</label>
                <select className="select defaultproviderpick" value={p.defaultProvider}
                  onChange={e => prefs.set({ defaultProvider: e.target.value as Provider })}>
                  <option value="claude">Claude</option>
                  <option value="codex">Codex</option>
                </select>
              </div>
              <div className="field-row">
                <label>Model</label>
                <DefaultModelPick provider={p.defaultProvider} />
              </div>
            </div>
          </section>

          <section id="set-notify" className="setsect">
            <h3>Notifications</h3>
            <p className="sec-note">Cloud9 interrupts you as little as it can get away with.</p>
            <div className="panelbox">
              <label className="toggle-row">
                <span className="tx">
                  <b>Tell me about new messages</b>
                  <span>{typeof Notification !== "undefined" && Notification.permission === "denied"
                    ? "This computer is blocking Cloud9's pop-ups — allow them in your system settings."
                    : "Your computer will ask permission the first time."}</span>
                </span>
                <input className="sw" type="checkbox" checked={p.notify} aria-label="Tell me about new messages"
                  onChange={e => askNotify(e.target.checked)} />
              </label>
            </div>
          </section>

          <section id="set-quiet" className="setsect">
            <h3>Quiet hours</h3>
            <p className="sec-note">No pop-ups between these times. Anything urgent still lands in Tasks for the morning.</p>
            <div className="panelbox">
              <label className="toggle-row">
                <span className="tx"><b>Quiet hours</b><span>Switch the window on, then set it below.</span></span>
                <input className="sw" type="checkbox" checked={p.quietOn} aria-label="Quiet hours"
                  onChange={e => prefs.set({ quietOn: e.target.checked })} />
              </label>
            </div>
            <div className="quietrow">
              <div className="field-row"><label>From</label>
                <input className="input" type="time" value={p.quietFrom} disabled={!p.quietOn}
                  onChange={e => prefs.set({ quietFrom: e.target.value })} /></div>
              <div className="field-row"><label>Until</label>
                <input className="input" type="time" value={p.quietTo} disabled={!p.quietOn}
                  onChange={e => prefs.set({ quietTo: e.target.value })} /></div>
            </div>
          </section>

          <section id="set-files" className="setsect">
            <h3>Where agents live</h3>
            <p className="sec-note">Where your agents keep the files they make and read.</p>
            <div className="path pathbox">
              <MarkFolder />
              <span>{folder ?? "cloud9-engine-data — inside the Cloud9 folder on this computer"}</span>
              <button className="btn small" disabled={!desktop()?.openAgentFolder}
                onClick={() => {
                  void desktop()?.openAgentFolder?.()
                    .then(r => setFolderNote(r?.ok ? "Opened the folder." : r?.error ?? "That folder could not be opened."))
                    .catch(() => setFolderNote("That folder could not be opened."));
                }}>Open</button>
              <button className="btn small"
                onClick={() => { void navigator.clipboard?.writeText(folder ?? "cloud9-engine-data"); setFolderNote("Path copied."); }}>
                Copy the path
              </button>
            </div>
            {!desktop()?.openAgentFolder &&
              <div className="notice">Opening a folder needs the desktop app. In a browser you can still copy the path.</div>}
            {folderNote && <div className="notice">{folderNote}</div>}
          </section>

          {owner ? (
            <section id="set-apps" className="setsect">
              <h3>Connected apps</h3>
              <p className="sec-note">
                Cloud9 runs your agents through apps already installed on this computer.
                Sign in once here and your agents can work. Connect your AI apps below.
              </p>
              <HarnessCard
                harness="claude" title="Claude" mark={<MarkClaude />}
                info={claudeInfo}
                checking={world.harness?.checking}
                savedKey={stored?.claude?.hasCredential ?? false}
                onStoredChanged={refreshStored}
                signInLabel="Sign in with Claude"
                fallbackLabel="Use an API key instead"
                fallbackHelp="Create a key at platform.claude.com — usage bills to your own account."
                disclosure={
                  <>
                    <b>Heads up:</b> Anthropic's docs say apps may not offer claude.ai
                    subscription login on your behalf. When Claude is already signed in on
                    this computer, Cloud9 simply uses that — no token is ever copied. The
                    fallback runs Claude's own approved sign-in in a visible terminal
                    (<code>claude setup-token</code>, needs Claude Pro/Max).
                  </>
                }
              />
              <HarnessCard
                harness="codex" title="Codex" mark={<MarkCodex />}
                info={codexInfo}
                checking={world.harness?.checking}
                savedKey={stored?.codex?.hasCredential ?? false}
                onStoredChanged={refreshStored}
                signInLabel="Sign in with Codex"
                fallbackLabel="Use an API key instead"
                fallbackHelp="Codex signs in with your ChatGPT account. A key is only for accounts without one."
                disclosure={
                  <>The button above runs Codex's own sign-in on this computer. Your Codex
                    login stays in Codex — Cloud9 never reads or copies it.</>
                }
              />
              {/* GITHUB SITS BESIDE THE TWO AI APPS, not on the Projects
                  screen. It answers the same question they do — "what is signed
                  in on the computer that runs my agents?" — and the one place
                  it used to be mentioned was a single sentence inside the
                  connect-a-repository box, which nobody finds. */}
              <GitHubCard info={world.harness?.github} checking={world.harness?.checking} />
              {!desktop()?.isDesktop && (
                <div className="notice">
                  You're using Cloud9 in a browser. Sign-in buttons work here and run on the
                  computer hosting your agents. Saving a key needs the desktop app, which can
                  lock it away safely.
                </div>
              )}
            </section>
          ) : (
            <section id="set-apps" className="setsect">
              <h3>Connected apps</h3>
              <p className="sec-note">
                The agents here run on Vikas's Claude and Codex apps, on his computer.
                There is nothing for you to sign in to.
              </p>
            </section>
          )}

          <section id="set-danger" className="setsect danger">
            <h3>Danger zone</h3>
            <p className="sec-note">These cannot be undone from here.</p>
            <DangerZone stored={stored} onStoredChanged={refreshStored} />
          </section>
        </div>
      </div>
    </div>
  );
}

function DefaultModelPick({ provider }: { provider: Provider }): React.JSX.Element {
  const p = usePrefs();
  const { ids, preferred } = useModels(provider);
  const current = p.defaultModel?.[provider];
  const value = current && ids.includes(current) ? current : preferred;
  return (
    <select className="select defaultmodelpick" value={value}
      onChange={e => prefs.set({ defaultModel: { ...p.defaultModel, [provider]: e.target.value } })}>
      {ids.map(id => <option key={id} value={id}>{modelLabel(id)}</option>)}
    </select>
  );
}

function DangerZone({ stored, onStoredChanged }: {
  stored: CredentialStatus | null; onStoredChanged: () => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [confirmPerson, setConfirmPerson] = useState<ID | "">("");
  const [note, setNote] = useState<string | null>(null);

  const uniqueOthers = onePerPerson(world.users).filter(u => u.id !== world.me?.id);

  const removeKey = async (h: Harness) => {
    const r = await desktop()?.clearCredential?.(h);
    setNote(r?.ok ? `Removed the saved ${PROVIDER_LABEL[h]} key from this computer.`
      : r?.error ?? "Nothing to remove, or the app could not remove it.");
    onStoredChanged();
  };

  const removePerson = () => {
    if (!confirmPerson) return;
    const person = uniqueOthers.find(u => u.id === confirmPerson);
    client.send({ type: "removeUser", userId: confirmPerson });
    setNote(`Asked to remove ${person?.name ?? "that person"}. They lose access the next time they connect.`);
    setConfirmPerson("");
  };

  return (
    <>
      <div className="dangerbox">
        <div className="toggle-row">
          <span className="tx"><b>Saved API keys</b><span>Only the fallback keys — your app logins are untouched.</span></span>
          <span className="dangerbtns">
            <button className="btn small danger" disabled={!stored?.claude?.hasCredential}
              onClick={() => void removeKey("claude")}>Remove Claude key</button>
            <button className="btn small danger" disabled={!stored?.codex?.hasCredential}
              onClick={() => void removeKey("codex")}>Remove Codex key</button>
          </span>
        </div>
        {/* Removing a person is owner-only in the relay. Same rule as the invite
            button: don't offer what can only come back as a refusal. */}
        {isOwner(world.me) && (
          <div className="toggle-row">
            <span className="tx"><b>Remove a person</b><span>They can no longer read or write in your Cloud9.</span></span>
            <span className="dangerbtns">
              <select className="removepersonpick" value={confirmPerson} aria-label="Choose someone to remove"
                onChange={e => setConfirmPerson(e.target.value)}>
                <option value="">Choose someone…</option>
                {uniqueOthers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <button className="btn small danger" disabled={!confirmPerson} onClick={removePerson}>Remove</button>
            </span>
          </div>
        )}
      </div>
      {note && <div className="notice">{note}</div>}
    </>
  );
}

/** The sign-in card. What the button says is decided by the state — never "again". */
function HarnessCard({
  harness, title, mark, info, checking, savedKey, onStoredChanged,
  signInLabel, fallbackLabel, fallbackHelp, disclosure,
}: {
  harness: Harness;
  title: string;
  mark: React.ReactNode;
  info?: HarnessInfo;
  checking?: boolean;
  /** a fallback key for THIS app is stored on this computer */
  savedKey: boolean;
  onStoredChanged: () => void;
  signInLabel: string;
  fallbackLabel: string;
  fallbackHelp: string;
  disclosure: React.ReactNode;
}): React.JSX.Element {
  const [showKey, setShowKey] = useState(false);
  const [key, setKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  /** the user pressed Cancel — stop showing "waiting" even if the engine is slow */
  const [cancelled, setCancelled] = useState(false);

  useEffect(() => { if (!info?.signingIn) setCancelled(false); }, [info?.signingIn]);

  const installed = info?.installed ?? false;
  const signedIn = info?.signedIn ?? false;
  const waiting = (info?.signingIn ?? false) && !cancelled;
  const problem = info?.problem;
  const authKind = info?.authKind;

  const state = !info ? "checking…"
    : waiting ? "waiting for you in the browser…"
    : !installed ? "not installed on this computer"
    : signedIn ? `signed in${info.account ? ` as ${info.account}` : ""}`
    : problem ? problem
    : info.detail ?? "installed, not signed in";

  const authWords = authKind === "cli-login" ? `using the ${title} app's own login`
    : authKind === "token" ? "using a saved sign-in token"
    : authKind === "apiKey" ? "using a saved API key"
    : null;

  const signIn = () => { setCancelled(false); client.send({ type: "harnessSignIn", harness }); };
  const cancel = () => {
    setCancelled(true);
    client.send({ type: "harnessCancel", harness });
    client.send({ type: "harnessStatus" });
  };
  const recheck = () => {
    client.send({ type: "refreshHarness" });
    client.send({ type: "harnessStatus" });
  };

  const saveKey = async () => {
    const result = await desktop()?.setApiKey?.(harness, "apiKey", key.trim());
    setKey("");
    if (result?.ok) {
      setShowKey(false);
      setMessage(`Saved. Your ${title} key is locked in this computer's secure storage.`);
    } else {
      setMessage(result?.error ?? "That key could not be saved.");
    }
    onStoredChanged();
  };

  const clearKey = async () => {
    const result = await desktop()?.clearCredential?.(harness);
    setMessage(result?.ok ? `Removed the saved ${title} key from this computer.`
      : result?.error ?? "That key could not be removed.");
    onStoredChanged();
  };

  return (
    <div className={`harnesscard ${signedIn ? "isok" : ""}`} data-harness={harness}>
      <div className="harnesshead">
        <span className="harnessname">{mark} {title}</span>
        <span className={`harnessdot ${waiting ? "warn" : signedIn ? "ok" : installed ? "warn" : "off"}`}></span>
        <span className="harnessstate">{state}</span>
      </div>

      <div className="harnessfacts">
        <span className={installed ? "yes" : "no"}>
          {installed ? `✓ app found${info?.version ? ` (${info.version})` : ""}` : "✗ app not found"}
        </span>
        <span className={signedIn ? "yes" : "no"}>{signedIn ? "✓ signed in" : "✗ not signed in"}</span>
        {authWords && <span>{authWords}</span>}
        {(info?.models?.length ?? 0) > 0 && <span>{countOf(info!.models!.length, "model")} available</span>}
        {savedKey && <span>✓ key saved on this computer</span>}
      </div>

      {/* WHERE THAT MODEL LIST CAME FROM, in the engine's own sentence.
          A list proved by running each model and a list we are falling back on
          are not the same thing, and a chip reading "13 models" cannot tell him
          which he is looking at. The words are `modelsDetail` verbatim — this
          screen never writes its own, so the sentence can never disagree with
          what actually happened. Absent means absent: nothing is drawn until
          the harness has something to say. */}
      {info?.modelsDetail && (
        <div className="modelsource" data-checked={info.modelsChecked ? "yes" : "no"}>
          <span className="ms-mark" aria-hidden="true">{info.modelsChecked ? "✓" : "·"}</span>
          <span className="ms-tx">{info.modelsDetail}</span>
        </div>
      )}

      {signedIn && !waiting && (
        <div className="signedinline" data-state="signed-in">
          <span className="tick" aria-hidden="true">✓</span>
          <span className="signedintext">Signed in{info?.account ? ` as ${info.account}` : ""}</span>
          <button className="linkbtn switchacct" onClick={signIn}>Switch account</button>
        </div>
      )}

      {waiting && (
        <div className="waitingline" data-state="waiting">
          <span className="spinner" aria-hidden="true" />
          <span>Waiting for you in the browser</span>
          <button className="ghostbtn small" onClick={cancel}>Cancel</button>
        </div>
      )}

      {!signedIn && !waiting && problem && (
        <div className="problemline" data-state="failed">
          <span className="problemtext">{plainError(problem)}</span>
          <button className="primary" disabled={!installed} onClick={signIn}>Try again</button>
        </div>
      )}

      <div className="harnessbtns">
        {!signedIn && !waiting && !problem && (
          <button className="primary" disabled={!installed} onClick={signIn}>{signInLabel}</button>
        )}
        <button className="ghostbtn" disabled={checking} onClick={recheck}>
          {checking ? "Checking…" : "Re-check"}
        </button>
      </div>

      {!installed && <div className="notice">Install the {title} app on this computer first, then press Re-check.</div>}
      <button className="linkbtn" onClick={() => setShowKey(s => !s)}>
        {showKey ? "▾" : "▸"} {fallbackLabel}
      </button>
      {showKey && (
        <div className="harnessfallback">
          <label className="formlabel">{title} API key</label>
          <input type="password" value={key} onChange={e => setKey(e.target.value)} placeholder="sk-…" />
          <div className="harnessbtns">
            <button className="primary" disabled={!key.trim() || !desktop()?.isDesktop} onClick={() => void saveKey()}>
              Save key
            </button>
            {savedKey && (
              <button className="ghostbtn" onClick={() => void clearKey()}>Remove saved key</button>
            )}
          </div>
          <div className="notice">{fallbackHelp}</div>
        </div>
      )}
      {message && <div className="notice">{message}</div>}
      <div className="notice">{disclosure}</div>
    </div>
  );
}

/** GitHub's own sign-in command, spelled once. The card prints it verbatim. */
const GH_LOGIN_COMMAND = "gh auth login --web --git-protocol https";

/**
 * THE GITHUB CARD — the screen that did not exist.
 *
 * The bug it fixes: Cloud9 rides the GitHub sign-in already on the computer and
 * never holds a token, which is the right design and was completely invisible.
 * Nothing anywhere said "you are connected as vikas53953", and nothing offered
 * a way in when you were not, so the honest answer to "can I connect my GitHub
 * account?" was "there is no screen for that". Invisible is the same as absent.
 *
 * THREE STATES, AND EVERY ONE OF THEM COMES FROM ASKING THE COMPUTER. The
 * engine host runs `gh auth status` in the same detection round as the two AI
 * apps and stamps `checkedAt`. Nothing here is inferred, remembered or assumed:
 * with no `checkedAt` the card says it hasn't looked yet rather than showing a
 * comforting grey "not signed in".
 *
 * IT NEVER HOLDS A SECRET, and it has nothing to hold one in. `gh auth status`
 * prints a masked token and a scope list; neither is carried on the frame, so
 * neither can be drawn here.
 */
function GitHubCard({ info, checking }: {
  info?: GitHubAccountInfo; checking?: boolean;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);

  // "we have not looked" and "we looked and found nothing" are different
  // answers, and only the second one may be printed as a finding
  const looked = (info?.checkedAt ?? 0) > 0;
  const installed = looked && (info?.installed ?? false);
  const signedIn = looked && (info?.signedIn ?? false);
  const waiting = info?.signingIn ?? false;
  const problem = info?.problem;

  const state = !looked ? "checking…"
    : waiting ? "a sign-in window is open on this computer"
    : !installed ? "not found on this computer"
    : signedIn ? `signed in as ${info?.login ?? "your GitHub account"}`
    : problem ? problem
    : "not signed in";

  const signIn = (): void => { client.send({ type: "githubSignIn" }); };
  const recheck = (): void => {
    client.send({ type: "refreshHarness" });
    client.send({ type: "harnessStatus" });
  };
  const copyCommand = (): void => {
    void navigator.clipboard?.writeText(GH_LOGIN_COMMAND);
    setCopied(true);
  };

  return (
    <div className={`githubcard harnessish ${signedIn ? "isok" : ""}`} data-service="github"
      data-state={!looked ? "checking" : waiting ? "waiting"
        : !installed ? "not-installed" : signedIn ? "signed-in" : "not-signed-in"}>
      <div className="harnesshead">
        <span className="harnessname"><MarkGitHub /> GitHub</span>
        <span className={`harnessdot ${waiting ? "warn" : signedIn ? "ok" : installed ? "warn" : "off"}`}></span>
        <span className="harnessstate">{state}</span>
      </div>

      <div className="harnessfacts">
        <span className={installed ? "yes" : "no"}>
          {installed ? "✓ GitHub's program found" : "✗ GitHub's program not found"}
        </span>
        <span className={signedIn ? "yes" : "no"}>{signedIn ? "✓ signed in" : "✗ not signed in"}</span>
        {signedIn && info?.protocol && <span>connects over {info.protocol}</span>}
      </div>

      {/* WHEN THIS WAS ACTUALLY ASKED. A card that says "signed in" without
          saying when it looked is telling you about the past in the present
          tense. The engine stamps the time; this prints it. */}
      <div className="checkedline" data-checked={looked ? "yes" : "no"}>
        <span className="ms-mark" aria-hidden="true">{looked ? "✓" : "·"}</span>
        <span className="ms-tx">
          {looked
            ? `Cloud9 asked this computer at ${new Date(info!.checkedAt).toLocaleTimeString()}.`
            : "Cloud9 hasn't asked this computer yet."}
        </span>
      </div>

      {signedIn && !waiting && (
        <div className="signedinline" data-state="signed-in">
          <span className="tick" aria-hidden="true">✓</span>
          <span className="signedintext">
            Signed in as {info?.login ?? "your GitHub account"}
          </span>
        </div>
      )}

      {waiting && (
        <div className="waitingline" data-state="waiting">
          <span className="spinner" aria-hidden="true" />
          <span>A GitHub sign-in window is open on this computer — finish it there.</span>
        </div>
      )}

      {looked && !signedIn && !waiting && problem && (
        <div className="problemline" data-state="failed">
          <span className="problemtext">{plainError(problem) ?? problem}</span>
          <button className="btn primary ghsignin" disabled={!installed} onClick={signIn}>Try again</button>
        </div>
      )}

      {/* THE WAY IN. Only when the computer really has GitHub's program and
          really is signed out — offering a sign-in button on a computer with no
          `gh` on it would just fail in a way the owner cannot fix. */}
      {looked && installed && !signedIn && !waiting && !problem && (
        <div className="ghsigninbox">
          <button className="btn primary ghsignin" onClick={signIn}>Sign in now</button>
          <div className="notice">
            <b>What happens:</b> a black terminal window opens on this computer and
            GitHub's own program takes over. It shows you a short code, then opens
            github.com in your browser. Type the code there and the window finishes
            by itself. Cloud9 never sees your password.
          </div>
        </div>
      )}

      <div className="harnessbtns">
        <button className="btn ghostbtn ghrecheck" disabled={checking} onClick={recheck}>
          {checking ? "Checking…" : "Check again"}
        </button>
      </div>

      {looked && !installed && (
        <div className="notice ghmissing">
          GitHub's own program isn't on this computer. Get it from{" "}
          <code>cli.github.com</code> — it's GitHub's, not ours — then press Check again.
        </div>
      )}

      {/* The honest fallback, always available: a machine with no terminal to
          pop (or an owner who would rather do it themselves) can run the exact
          same command by hand. Same words as the button starts. */}
      {looked && installed && !signedIn && (
        <div className="ghmanual">
          <span className="ghmanual-lead">Rather do it yourself? Run this:</span>
          <code className="ghcommand">{GH_LOGIN_COMMAND}</code>
          <button className="btn small ghcopy" onClick={copyCommand}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      )}

      <div className="notice">
        Cloud9 never holds your password or token — GitHub's own program keeps it
        in Windows' vault. Your agents borrow that sign-in when they read a
        repository or open a pull request, and every one of those still asks you first.
      </div>
    </div>
  );
}

/* ================= FILES · ONE WORKSPACE ACROSS ROOMS ================= */

/** A workspace date always includes the year: a file from last August must not look recent. */
const FILE_DATE = new Intl.DateTimeFormat([], {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
});
const fileDate = (ts: number): string => FILE_DATE.format(new Date(ts));

const accessOf = (artifact: Artifact): ArtifactAccess => effectiveArtifactAccess(artifact.access);

const sameIds = (a: ID[], b: ID[]): boolean => {
  const x = [...new Set(a)].sort(), y = [...new Set(b)].sort();
  return x.length === y.length && x.every((id, i) => id === y[i]);
};

/** Object identity is not a permission change; sorted meaning is. */
const accessKey = (access: ArtifactAccess): string => access.kind === "room"
  ? "room"
  : `restricted:${[...new Set(access.userIds)].sort().join(",")}`;

function workspaceRoomName(entry: ArtifactWorkspaceEntry, world: World): string {
  const channel = world.channels.find(c => c.id === entry.channelId);
  if (!channel || channel.kind !== "dm") return `#${entry.channelName}`;
  return `Direct · ${channelPeer(channel, world).name}`;
}

type FileSelection = { artifactId: ID; version?: number };

function CopyFileRef({ value, kind }: { value: string; kind: "newest" | "exact" }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button className="btn small ghost filerefcopy" data-copy-ref={kind}
      title={value} onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        });
      }}>
      {copied ? "Copied" : kind === "newest" ? "Copy newest reference" : "Copy exact version"}
    </button>
  );
}

function relationLabel(relation: ArtifactRelationView): string {
  if (relation.kind === "goes-with") return "Goes with";
  return relation.direction === "incoming" ? "Used to make" : "Made from";
}

function relationOther(relation: ArtifactRelationView): ArtifactVersionRef | undefined {
  if (relation.hidden) return undefined;
  return relation.direction === "incoming" ? relation.from : relation.to;
}

function FileRelations({ artifactId, loaded, relations, truncated, problem, onRetry, onOpen }: {
  artifactId: ID;
  loaded: boolean;
  relations: ArtifactRelationView[];
  truncated: boolean;
  problem?: string;
  onRetry: () => void;
  onOpen: (ref: ArtifactVersionRef) => void;
}): React.JSX.Element {
  const state = problem ? "error" : loaded ? (relations.length === 0 ? "empty" : "some") : "loading";
  return (
    <section className="callout filedetail-sec filerelations" data-relation-artifact={artifactId}
      data-file-relations={loaded ? relations.length : state}>
      <span className="eyebrow">How this file connects</span>
      {problem ? (
        <div className="relationproblem" data-relations-state="error" role="status">
          <span>{plainError(problem) ?? problem}</span>
          <button className="btn small" data-relations-retry onClick={onRetry}>Try again</button>
        </div>
      ) : !loaded ? (
        <p className="filedetail-wait" data-relations-state="loading">Looking for file links…</p>
      ) : relations.length === 0 ? (
        <p className="filedetail-empty" data-relations-state="empty">
          No Made from or Goes with links were declared for the versions kept here.
        </p>
      ) : (
        <>
          <div className="relationlist" data-relations-state="some">
            {relations.map((relation, i) => {
              const other = relationOther(relation);
              return (
                <div className="relationrow" key={`${relation.kind}-${relation.direction}-${i}`}
                  data-relation-kind={relation.kind} data-relation-direction={relation.direction}
                  data-relation-hidden={relation.hidden ? "yes" : "no"}>
                  <span className="relationlead">
                    <span className="relationkind">{relationLabel(relation)}</span>
                    <span className="relationhere">
                      this file v{relation.direction === "incoming" ? relation.to.version : relation.from.version}
                    </span>
                  </span>
                  {relation.hidden ? (
                    <span className="relationhidden">A linked file isn’t available to you.</span>
                  ) : (
                    <button className="relationtarget" onClick={() => onOpen(other!)}
                      data-linked-artifact={other!.artifactId} data-linked-version={other!.version}>
                      <span className="relationname">{relation.linkedName}</span>
                      <span className="relationversion">v{other!.version}</span>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
          {truncated && (
            <p className="relationtruncated" data-relations-truncated="true">
              Showing {ARTIFACT_LIMITS.relationDetail} links; more exist.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function FileAccessEditor({ artifact, channel, world, onDirtyChange }: {
  artifact: Artifact;
  channel?: Channel;
  world: World;
  onDirtyChange: (draft: { what: string; dirty: boolean }) => void;
}): React.JSX.Element {
  const stored = accessOf(artifact);
  const allRows = channel?.kind === "channel" ? (world.members[channel.id] ?? []) : [];
  const rows = allRows.filter(m => !m.removedAt);
  const membershipKey = allRows
    .map(m => `${m.memberId}:${m.role}:${m.removedAt ?? "here"}`)
    .sort().join("|");
  const roster = channel?.memberIds.join(",") ?? "";
  useEffect(() => {
    if (channel?.kind === "channel") client.askMembers(channel.id);
  }, [artifact.id, channel, roster, membershipKey]);

  const myRole = rows.find(m => m.memberId === world.me?.id)?.role;
  const canEdit = channel?.kind === "channel" && mayAdministerChannel(myRole);
  const humanRows = rows
    .map(row => ({ row, user: world.users.find(u => u.id === row.memberId) }))
    .filter((x): x is { row: ChannelMember; user: User } => !!x.user)
    .sort((a, b) => ROLE_ORDER.indexOf(a.row.role) - ROLE_ORDER.indexOf(b.row.role)
      || a.user.name.localeCompare(b.user.name));
  const managerIds = humanRows.filter(x => mayAdministerChannel(x.row.role)).map(x => x.user.id);
  const managerKey = managerIds.join(",");
  const selectedFrom = (access: ArtifactAccess): ID[] => access.kind === "restricted"
    ? access.userIds.filter(id => !managerIds.includes(id))
    : [];
  const storedKey = accessKey(stored);
  const [mode, setMode] = useState<ArtifactAccess["kind"]>(stored.kind);
  const [selected, setSelected] = useState<ID[]>(() => selectedFrom(stored));
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<{
    artifactId: ID; storedKey: string; kind: ArtifactAccess["kind"]; selectedIds: ID[];
  }>(() => ({
    artifactId: artifact.id, storedKey, kind: stored.kind, selectedIds: selectedFrom(stored),
  }));
  const pendingSavedAccess = useRef<string | null>(null);

  /* Managers are required on screen but DERIVED by the relay on every read. Do
     not store them as selected people: if an admin is demoted tomorrow, a frozen
     selected row would incorrectly keep their access. */
  const baselineSelectedIds = baseline.kind === "restricted"
    ? baseline.selectedIds.filter(id => !managerIds.includes(id)
      && humanRows.some(x => x.user.id === id))
    : [];
  const chosenIds = mode === "restricted"
    ? [...new Set(selected)].filter(id => !managerIds.includes(id)
      && humanRows.some(x => x.user.id === id))
    : [];
  /* DIRTY IS AGAINST THE BASELINE THE DRAFT CAME FROM — never against a newer
     server value. Otherwise an external clean update makes the OLD clean draft
     look dirty and lets it overwrite the update. */
  const dirty = mode !== baseline.kind
    || (mode === "restricted"
      && (baseline.kind !== "restricted" || !sameIds(chosenIds, baselineSelectedIds)));
  const incomingChanged = baseline.artifactId !== artifact.id || baseline.storedKey !== storedKey;

  /* A pushed version brings a fresh access OBJECT with the same meaning. It must
     not erase a draft. A semantic incoming change replaces draft+baseline only
     when that draft is clean; a genuinely dirty draft remains guarded. */
  useEffect(() => {
    const fileChanged = baseline.artifactId !== artifact.id;
    const saveLanded = pendingSavedAccess.current === storedKey;
    if (!fileChanged && (!incomingChanged || (dirty && !saveLanded))) return;
    const nextSelected = selectedFrom(stored);
    setMode(stored.kind);
    setSelected(nextSelected);
    setSaving(false);
    setProblem(null);
    setBaseline({
      artifactId: artifact.id, storedKey, kind: stored.kind, selectedIds: nextSelected,
    });
    pendingSavedAccess.current = null;
  }, [artifact.id, storedKey, incomingChanged, dirty, managerKey, baseline.artifactId]);

  const previousManagers = useRef<{ artifactId: ID; ids: ID[] }>({ artifactId: artifact.id, ids: [] });
  useEffect(() => {
    const prior = previousManagers.current.artifactId === artifact.id
      ? previousManagers.current.ids
      : [];
    const derived = new Set([...prior, ...managerIds]);
    setSelected(now => now.filter(id => !derived.has(id)));
    previousManagers.current = { artifactId: artifact.id, ids: managerIds };
  }, [artifact.id, managerKey]);

  useEffect(() => {
    onDirtyChange({
      what: `Access to ${artifact.name}`,
      dirty: !!canEdit && dirty && !saving,
    });
  }, [artifact.id, artifact.name, canEdit, dirty, saving, onDirtyChange]);

  if (!channel) {
    return (
      <section className="callout filedetail-sec fileaccess" data-file-access="unavailable">
        <span className="eyebrow">Who can read it</span>
        <p className="filedetail-wait">Looking for the source room…</p>
      </section>
    );
  }

  if (channel.kind === "dm") {
    return (
      <section className="callout filedetail-sec fileaccess" data-file-access="inherited" data-access-editor="no">
        <span className="eyebrow">Who can read it</span>
        <div className="accesssummary">
          <b>Inherited from this direct conversation</b>
          <span>Only the people who can currently read this conversation can read any version of the file.</span>
        </div>
        <p className="filedetail-note">Direct conversations have no separate file access editor in this release.</p>
      </section>
    );
  }

  if (rows.length === 0) {
    return (
      <section className="callout filedetail-sec fileaccess" data-file-access={stored.kind} data-access-editor="loading">
        <span className="eyebrow">Who can read every version</span>
        <p className="filedetail-wait">Looking up the current room members and managers…</p>
      </section>
    );
  }

  const choose = (id: ID, on: boolean): void => {
    setProblem(null);
    setSelected(now => on ? [...new Set([...now, id])] : now.filter(x => x !== id));
  };
  const save = (): void => {
    const next = normaliseArtifactAccess(mode === "room"
      ? { kind: "room" }
      : { kind: "restricted", userIds: chosenIds });
    const refusal = validateArtifactAccess(next);
    if (refusal) { setProblem(refusal); return; }
    const expected = next.kind === "room" ? next : normaliseArtifactAccess({
      kind: "restricted", userIds: [...next.userIds, ...managerIds],
    });
    pendingSavedAccess.current = accessKey(expected);
    setSaving(true);
    setProblem(null);
    client.setArtifactAccess(artifact.id, next,
      () => setSaving(false),
      why => {
        pendingSavedAccess.current = null;
        setSaving(false);
        setProblem(why);
      });
  };

  const restrictedCount = stored.kind === "restricted"
    ? stored.userIds.filter(id => !managerIds.includes(id)).length
    : 0;
  return (
    <section className="callout filedetail-sec fileaccess" data-file-access={stored.kind}
      data-access-editor={canEdit ? "yes" : "read-only"}
      data-access-dirty={dirty ? "yes" : "no"}
      data-access-incoming={incomingChanged ? "changed" : "same"}
      data-access-saving={saving ? "yes" : "no"}
      data-access-baseline={baseline.kind}>
      <span className="eyebrow">Who can read every version</span>
      {!canEdit ? (
        <div className="accesssummary">
          <b>{stored.kind === "room" ? "Everyone currently in the room" : "Restricted inside the room"}</b>
          <span>{stored.kind === "room"
            ? `Everyone who can currently read #${channel.name} can read this file.`
            : `${countOf(restrictedCount, "selected person", "selected people")} plus all current room managers can read it.`}</span>
          <span>Only this room’s owner or an admin can change that.</span>
        </div>
      ) : (
        <div className="accesseditor">
          <div className="accesschoices" role="group" aria-label="File access">
            <button className="accesschoice" aria-pressed={mode === "room"}
              data-access-choice="room" onClick={() => { setMode("room"); setProblem(null); }}>
              <span className="tick" aria-hidden="true">{mode === "room" ? "●" : "○"}</span>
              <span><b>Everyone currently in the room</b><em>Default. Membership changes apply immediately.</em></span>
            </button>
            <button className="accesschoice" aria-pressed={mode === "restricted"}
              data-access-choice="restricted" onClick={() => { setMode("restricted"); setProblem(null); }}>
              <span className="tick" aria-hidden="true">{mode === "restricted" ? "●" : "○"}</span>
              <span><b>Selected people in the room</b><em>Narrows access. It can never add somebody from outside this room.</em></span>
            </button>
          </div>

          {mode === "restricted" && (
            <div className="accesspeople" data-access-members={humanRows.length}>
              <p className="filedetail-note">Room managers are required and cannot be unchecked.</p>
              {humanRows.map(({ row, user }) => {
                const manager = mayAdministerChannel(row.role);
                const checked = manager || selected.includes(user.id);
                return (
                  <label className={`accessperson${manager ? " required" : ""}`} key={user.id}
                    data-access-user={user.id} data-required={manager ? "yes" : "no"}>
                    <input type="checkbox" checked={checked} disabled={manager}
                      onChange={e => choose(user.id, e.target.checked)} />
                    <span className="accessperson-name">{user.name}</span>
                    {manager && <span className="chip is-ultra">{row.role} · required</span>}
                  </label>
                );
              })}
            </div>
          )}

          <Problem text={problem ?? undefined} className="fileaccess-problem" />
          <div className="accessactions">
            <button className="primary small" disabled={!dirty || saving} onClick={save}
              data-access-save>{saving ? "Saving…" : "Save access"}</button>
            {dirty && !saving && <span className="hint">Not saved yet</span>}
          </div>
        </div>
      )}
    </section>
  );
}

function FilesScreen({ onOpenChannel, openAt, onOpened }: {
  onOpenChannel: (id: ID) => void;
  /**
   * A file (and, for an old-version hit, the exact version) another screen has
   * sent this one to. `at` is the moment the request was made, so asking for
   * the SAME file twice still moves the screen — a bare id would compare equal
   * and the second click would do nothing.
   *
   * Selecting is still `selectFile`, the one owner: it goes through the unsaved
   * -work guard, so arriving from search cannot throw away a half-edited access
   * list the way a direct `setSelected` would.
   */
  openAt?: { artifactId: ID; version?: number; at: number } | null;
  /**
   * "Done — you can put that errand down." Called once the file asked for has
   * actually been chosen, which is why it is handed to `selectFile` rather than
   * fired beside it: the choice can wait behind the unsaved-work question, and
   * an errand reported finished before it was done would clear itself while a
   * dialog was still up, leaving the screen on the newest file instead.
   */
  onOpened?: () => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const page = client.artifactWorkspace();
  const [selected, setSelected] = useState<FileSelection | null>(null);
  /**
   * What a search actually SENT this screen to, remembered here because the
   * request itself is handed back the moment it is carried out (`onOpened`).
   * The card below is built from this and not from the prop: the prop is an
   * errand, gone as soon as it is done, and reading a finished errand at render
   * time is what would collapse the version history a search had just unrolled.
   */
  const [arrivedAt, setArrivedAt] = useState<FileSelection | null>(null);
  const [accessDraft, setAccessDraft] = useState<{ what: string; dirty: boolean } | null>(null);
  useUnsavedWork(accessDraft?.what ?? "File access", !!accessDraft?.dirty);
  const entry = selected ? page.entries.find(a => a.artifactId === selected.artifactId) : undefined;
  const artifact = selected ? world.artifacts[selected.artifactId] : undefined;
  const relations = selected ? client.relationsFor(selected.artifactId) : undefined;
  const relationsTruncated = selected ? client.relationsTruncated(selected.artifactId) : false;
  const detailProblem = selected ? client.artifactDetailProblem(selected.artifactId) : undefined;
  const unavailable = selected ? !!world.artifactsGone[selected.artifactId] : false;
  const noteAccessDraft = useCallback((draft: { what: string; dirty: boolean }) => {
    setAccessDraft(draft);
  }, []);
  const selectFile = useCallback((next: FileSelection, andThen?: () => void) => {
    attemptLeave(() => {
      setAccessDraft(null);
      setSelected(next);
      andThen?.();
    });
  }, []);

  useEffect(() => { client.askArtifactWorkspace(true); }, []);
  /* A file search sent us here. It runs BEFORE the "choose the first one"
     effect below is able to matter, because it sets `selected` — and that
     effect deliberately does nothing once anything is selected. */
  useEffect(() => {
    if (!openAt) return;
    const asked: FileSelection = {
      artifactId: openAt.artifactId,
      ...(openAt.version !== undefined ? { version: openAt.version } : {}),
    };
    selectFile(asked, () => { setArrivedAt(asked); onOpened?.(); });
  }, [openAt?.at, openAt?.artifactId, openAt?.version, selectFile, onOpened]);
  /* "Nothing chosen yet? Show the newest." — and `openAt` is what tells it that
     something HAS been chosen even though `selected` in this closure is still
     the value from the render that mounted the screen. Without that word here,
     arriving from a search for words inside version 1 landed on the newest
     version instead: this effect ran a beat later with a stale `null` and
     re-chose the top row, quietly dropping the exact version that was asked
     for. It is the same fact, read at two different moments. */
  useEffect(() => {
    if (selected || openAt || page.entries.length === 0) return;
    selectFile({ artifactId: page.entries[0].artifactId });
  }, [selected, openAt, page.entries, selectFile]);
  useEffect(() => {
    if (selected && !unavailable && !detailProblem && relations === undefined) {
      client.askArtifactDetail(selected.artifactId);
    }
  }, [selected?.artifactId, artifact?.updatedAt, unavailable, detailProblem, relations === undefined]);
  const channelId = artifact?.channelId ?? entry?.channelId;
  const channel = world.channels.find(c => c.id === channelId);
  const newest = artifact ? latestVersion(artifact) : entry?.latest;
  const exactVersion = selected?.version ?? newest?.version;
  const state = page.problem ? "error"
    : !page.asked && page.loading ? "loading"
    : page.asked && page.entries.length === 0 && page.hasMore ? "backfill"
    : page.asked && page.entries.length === 0 ? "empty" : "some";
  const detailState = !selected ? "none" : unavailable ? "unavailable"
    : detailProblem ? "error" : (!artifact || relations === undefined) ? "loading" : "here";

  return (
    <section className="filescreen screen" data-files-screen data-files-state={state}>
      <header className="topbar files-topbar">
        <h2>Files</h2>
        <span className="sub">Across every room you can read · newest change first</span>
        <div className="grow" />
        {page.checkedAt && <span className="files-checked">Checked {fileDate(page.checkedAt)}</span>}
        <button className="btn small ghost files-refresh" disabled={page.loading}
          onClick={() => client.askArtifactWorkspace(true)}>
          {page.loading && page.entries.length === 0 ? "Looking…" : "Refresh"}
        </button>
      </header>

      <div className="files-body">
        <aside className="files-index" aria-label="Files you can read">
          <div className="files-index-head">
            <span className="eyebrow">Newest changes</span>
            {page.entries.length > 0 && <span className="chip">{countOf(page.entries.length, "file")}</span>}
          </div>

          <div className="files-list" data-files-list-state={state}>
            {!page.asked && page.loading && page.entries.length === 0 && (
              <div className="files-state" data-files-loading>
                <span className="spinner" aria-hidden="true" />
                <b>Looking across your rooms…</b>
                <span>The hub is checking what you can read now.</span>
              </div>
            )}
            {page.problem && (
              <div className="files-state is-error" data-files-error>
                <b>The file list could not be loaded.</b>
                <span>{plainError(page.problem) ?? page.problem}</span>
                {page.checkedAt && <span>Last attempt: {fileDate(page.checkedAt)}</span>}
                <button className="btn small" onClick={() => client.askArtifactWorkspace(true)}>Try again</button>
              </div>
            )}
            {page.asked && !page.problem && page.entries.length === 0 && page.hasMore && (
              <div className="files-state" data-files-backfill>
                <span className="files-empty-mark" aria-hidden="true">MORE</span>
                <b>Older readable files remain.</b>
                <span>The loaded rows changed. Open the next page to fill this list again.</span>
              </div>
            )}
            {page.asked && !page.problem && page.entries.length === 0 && !page.hasMore && (
              <div className="files-state" data-files-empty>
                <span className="files-empty-mark" aria-hidden="true">FILE</span>
                <b>No agent-made files are available yet.</b>
                <span>When an agent shares one in a room you can read, it appears here.</span>
                {page.checkedAt && <span>Checked {fileDate(page.checkedAt)}</span>}
              </div>
            )}
            {page.entries.map(item => {
              const on = selected?.artifactId === item.artifactId;
              const restricted = isArtifactRestricted(item.access);
              return (
                <button className="file-index-row" key={item.artifactId} aria-current={on}
                  data-file-row={item.artifactId} data-room={item.channelId}
                  data-maker={item.latest.agentName} data-turn={item.latest.runId}
                  data-access={item.access.kind} data-version-count={item.versionCount}
                  onClick={() => selectFile({ artifactId: item.artifactId })}>
                  <span className="file-index-glyph" aria-hidden="true">{fileKind(item.name)}</span>
                  <span className="file-index-copy">
                    <span className="file-index-name">{item.name}</span>
                    <span className="file-index-room">{workspaceRoomName(item, world)}</span>
                    <span className="file-index-maker">
                      {item.latest.agentName}
                      {item.latest.runId && <code title={item.latest.runId}>turn {item.latest.runId}</code>}
                    </span>
                    <span className="file-index-date">{fileDate(item.updatedAt)}</span>
                  </span>
                  <span className="file-index-facts">
                    <span className="versionstack" title={countOf(item.versionCount, "version")}>
                      <i /><i />v{item.latest.version}
                    </span>
                    <span className={`accessmark ${restricted ? "restricted" : "room"}`}>
                      {restricted ? "Restricted" : "Room"}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {page.asked && !page.problem && (page.entries.length > 0 || page.hasMore) && (
            <div className="files-page-foot" data-files-page-state={page.entries.length === 0 ? "backfill" : "rows"}>
              {page.hasMore ? (
                <button className="btn small files-more" data-files-more disabled={page.loading}
                  onClick={() => client.askArtifactWorkspace(false)}>
                  {page.loading ? "Loading older files…" : "Older files"}
                </button>
              ) : <span className="files-end" data-files-end>That is every file you can currently read.</span>}
            </div>
          )}
        </aside>

        <main className="files-detail" data-file-detail={unavailable ? "unavailable" : selected?.artifactId ?? "none"}
          data-file-detail-state={detailState}>
          {!selected ? (
            <div className="files-detail-empty">
              <span className="files-detail-mark" aria-hidden="true">↗</span>
              <h3>Choose a file</h3>
              <p>Its full immutable history, preview, links and room access appear here.</p>
            </div>
          ) : unavailable ? (
            <div className="files-detail-empty files-detail-unavailable" data-file-unavailable>
              <span className="files-detail-mark" aria-hidden="true">?</span>
              <h3>That file isn’t available</h3>
              <p>It has been taken off this Cloud9, or it is in a conversation you cannot read.</p>
              {page.entries.length > 0 && (
                <button className="btn small" onClick={() => selectFile({ artifactId: page.entries[0].artifactId })}>
                  Choose another file
                </button>
              )}
            </div>
          ) : (
            <div className="files-detail-inner">
              <div className="filedetail-head">
                <div className="filedetail-title">
                  <span className="eyebrow">{channel ? (channel.kind === "dm" ? "Direct conversation" : `Room · #${channel.name}`) : "Source room"}</span>
                  <h3>{artifact?.name ?? entry?.name ?? "Looking for that file…"}</h3>
                  {newest && (
                    <p>{describeArtifactVersion(newest)} · {fileDate(newest.producedAt)} · {countOf(entry?.versionCount ?? newest.version, "version")}</p>
                  )}
                </div>
                <div className="filedetail-actions">
                  {channelId && <button className="btn small ghost" data-open-file-room
                    onClick={() => onOpenChannel(channelId)}>Open room</button>}
                  {selected && <CopyFileRef kind="newest" value={artifactRef(selected.artifactId)} />}
                  {selected && exactVersion !== undefined && (
                    <CopyFileRef kind="exact" value={artifactRef(selected.artifactId, exactVersion)} />
                  )}
                </div>
              </div>

              {(!detailProblem || artifact) && (
                /* Keyed by WHICH EXACT THING is being shown, so choosing a
                   different file — or a different retained version of one —
                   builds a fresh card rather than handing the new file the old
                   card's open/peeked state. It is also what lets a search for
                   words inside an old version arrive with the history already
                   unrolled on a screen that was already showing something else. */
                <ArtifactCard key={`${selected.artifactId}:${selected.version ?? "newest"}`}
                  artifactId={selected.artifactId} version={selected.version} place="workspace"
                  historyOpen={arrivedAt?.artifactId === selected.artifactId
                    && arrivedAt?.version !== undefined} />
              )}
              <FileRelations artifactId={selected.artifactId}
                loaded={relations !== undefined} relations={relations ?? []}
                truncated={relationsTruncated} problem={detailProblem}
                onRetry={() => client.askArtifactDetail(selected.artifactId)}
                onOpen={ref => selectFile(ref)} />
              {artifact && <FileAccessEditor artifact={artifact} channel={channel} world={world}
                onDirtyChange={noteAccessDraft} />}
            </div>
          )}
        </main>
      </div>
    </section>
  );
}

/* ================= 6 · TASKS & APPROVALS ================= */

/* The state word he reads. "blocked", "failed" and "cancelled" are the stored
   code words; the three he would have to guess at are said by `TROUBLE_WORD`,
   the one owner of how trouble is worded, so a chip and a reason line can never
   call the same job two different things. */
const STATUS_LABEL: Record<string, string> = {
  not_started: "queued", working: "working", waiting_user: "waiting for you",
  waiting_approval: "needs your go-ahead", blocked: TROUBLE_WORD.blocked,
  completed: "done", failed: TROUBLE_WORD.failed, cancelled: TROUBLE_WORD.cancelled,
};

const RUNNING_STATES = ["not_started", "working", "waiting_approval", "waiting_user", "blocked"];

/** The chip a job's state is printed on — pine while it lives, madder when it didn't. */
const TASK_TONE: Record<string, string> = {
  working: "is-pine", not_started: "is-pine", completed: "is-pine",
  waiting_approval: "is-gold", waiting_user: "is-gold", blocked: "is-gold",
  failed: "is-madder", cancelled: "is-madder",
};

function TasksScreen({ onOpenChannel }: { onOpenChannel: (id: ID) => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [filter, setFilter] = useState<"all" | "running" | "done" | "failed">("all");

  /* Waiting, and — separately — the ones that ran out under the old ten-minute
     sweep, before it was removed on 2026-08-07. Nothing new can land in the
     second list; the ones already on his disk stay findable, because the only
     other record of them is a job that quietly did less than he thinks it did.
     Both off `useMyApprovals`, so this panel, the pill above a conversation and
     the badge on the rail can never disagree about what is still waiting. */
  const { mine: mineAll, waiting: mineWaiting } =
    useMyApprovals(world.approvals, world.me?.id);
  const mineExpired = mineAll.filter(a => approvalIsDead(a));

  const shown = world.tasks.filter(t => {
    if (filter === "running") return RUNNING_STATES.includes(t.status);
    if (filter === "done") return t.status === "completed";
    if (filter === "failed") return t.status === "failed" || t.status === "cancelled";
    return true;
  });
  /* A STUCK JOB IS NOT A RUNNING JOB. It used to be printed under "Running"
     with everything genuinely moving, which is how a job waiting on something
     could sit there for an hour looking healthy. It gets its own group, above
     the ones that are actually running, because it is the one he can unblock. */
  const stuck = shown.filter(t => t.status === "blocked");
  const running = shown.filter(t => RUNNING_STATES.includes(t.status) && t.status !== "blocked");
  const finished = shown.filter(t => !RUNNING_STATES.includes(t.status));

  const taskCard = (t: Task) => {
    const approval = t.approvalId ? world.approvals.find(a => a.id === t.approvalId) : undefined;
    const agent = world.agents.find(a => a.id === t.agentId);
    const mine = approval && approval.status === "pending" && approval.ownerId === world.me?.id;
    const cancellable = RUNNING_STATES.includes(t.status);
    const provider = agent ? PROVIDER_LABEL[(agent.provider ?? "claude") as Provider] : null;
    return (
      <div key={t.id} className="taskrow" data-task={t.id} data-status={t.status}>
        <span className="taskportrait">
          {agent
            ? <AgentFace name={agent.name} size={40} lamp={t.status === "working" ? "run" : "live"} />
            : <PersonFace name="?" size={40} />}
        </span>
        <div className="taskmain">
          <h4>{t.title}</h4>
          <div className="taskmeta">
            <span>{agent?.name ?? "An agent"}{provider ? ` · ${provider} · ${modelWords(agent?.model)}` : ""}</span>
            <span>·</span>
            <span>Started {clock(t.createdAt)} by {t.requesterName}</span>
            <span className={`chip tstatus ${t.status} ${TASK_TONE[t.status] ?? ""}`}>
              {RUNNING_STATES.includes(t.status) && <span className="dot wait" />}
              {t.status === "completed" && <span className="dot live" />}
              {STATUS_LABEL[t.status] ?? t.status}
            </span>
          </div>
          {/* WHY IT IS NOT MOVING, on the card, never behind a click. The one
              owner writes both halves — the state in plain words and the reason
              the engine really recorded, or the honest fact that it recorded
              none. */}
          <TroubleLine task={t} />
          {t.result && (
            <div className="taskresult"><b>Result</b>{t.result.slice(0, 240)}</div>
          )}
          {/* WHAT IT ACTUALLY DID. Drawn only when the hub has attached a run
              to this job — absent on every job from before records existed, and
              a placeholder there would be a claim nobody can check. This is
              what turns approving a job into a decision rather than a guess. */}
          {t.runId && <TaskRun runId={t.runId} />}
        </div>
        <div className="taskbtns">
          <span className="chip">{elapsed(t.updatedAt - t.createdAt)}</span>
          {mine && <>
            <button className="gold small"
              onClick={() => client.send({ type: "decideApproval", approvalId: approval!.id, decision: "approved" })}>Approve</button>
            <button className="btn small danger"
              onClick={() => client.send({ type: "decideApproval", approvalId: approval!.id, decision: "rejected" })}>Reject</button>
          </>}
          {cancellable && !mine &&
            <button className="btn small" onClick={() => client.send({ type: "cancelTask", taskId: t.id })}>Stop</button>}
          {t.channelId && <button className="btn small" onClick={() => onOpenChannel(t.channelId)}>Read it</button>}
        </div>
      </div>
    );
  };

  return (
    <div className="tasks">
      <header className="topbar">
        <h2>Tasks</h2>
        <span className="sub">Jobs you handed out, and the ones waiting on your word</span>
        <div className="grow" />
        <div className="seg" role="group" aria-label="Which jobs to show">
          {([["all", "All"], ["running", "Running"], ["done", "Done"], ["failed", "Failed"]] as const).map(([k, l]) => (
            <button key={k} aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
      </header>

      <div className="tasks-body">
        <div className="tasks-main">
          {world.tasks.length === 0 && (
            <EmptyTray title="Nothing handed over yet"
              line={<>Ask an agent with <code>@Agent !bg your job</code> and the result lands here.</>} />
          )}
          {/* There ARE jobs, just none of this kind — said plainly, because an
              empty panel on its own reads as "nothing ever happened". */}
          {world.tasks.length > 0 && shown.length === 0 && (
            <EmptyTray title="No jobs of that kind"
              line={<>Nothing here is {filter === "running" ? "running or stuck" : filter === "done" ? "finished" : "failed or stopped"} right now. Pick “All” to see every job.</>} />
          )}
          {stuck.length > 0 && (
            <span className="eyebrow stucklabel" style={{ display: "block", marginBottom: 12 }}>
              Stuck — waiting on something · {stuck.length}
            </span>
          )}
          {stuck.map(taskCard)}
          {running.length > 0 && (
            <span className="eyebrow" style={{ display: "block", margin: stuck.length > 0 ? "26px 0 12px" : "0 0 12px" }}>Running · {running.length}</span>
          )}
          {running.map(taskCard)}
          {finished.length > 0 && (
            <span className="eyebrow" style={{ display: "block", margin: "26px 0 12px" }}>Finished · {finished.length}</span>
          )}
          {finished.map(taskCard)}
        </div>

        <aside className="tasks-side">
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
            <span className="eyebrow">Waiting on you</span>
            <span className={`chip ${mineWaiting.length > 0 ? "is-gold" : ""}`}>{mineWaiting.length}</span>
          </div>

          {mineWaiting.map(ap => (
            <ApprovalTray key={ap.id} approval={ap}
              agent={world.agents.find(a => a.id === ap.agentId)}
              task={world.tasks.find(t => t.id === ap.taskId)} />
          ))}

          {mineWaiting.length === 0 && (
            <EmptyTray title="Nothing waiting" line="Every request has an answer. The crew carries on." />
          )}

          {mineExpired.length > 0 && (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "26px 0 14px" }}>
                <span className="eyebrow">Ran out before you saw them</span>
                <span className="chip">{mineExpired.length}</span>
              </div>
              {mineExpired.map(ap => (
                <ApprovalTray key={ap.id} approval={ap}
                  agent={world.agents.find(a => a.id === ap.agentId)}
                  task={world.tasks.find(t => t.id === ap.taskId)} />
              ))}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

/* ================= 10 · PROJECTS ==============================================

   A PROJECT IS A REPOSITORY — his item 7, and the screen that makes everything
   already built underneath reachable: the hub has stored projects, pull
   requests and issues for a day, the engine can prepare a worktree, branch and
   commit, and an agent can now stop mid-job and ask before it pushes. None of
   it had a door. This is the door.

   THE LAWS THIS SCREEN IS HELD TO, all of them learned the hard way:

   • Nothing here reaches GitHub. Every value drawn below arrived on a frame
     from the hub, which got it from the engine, which ran `gh` on his machine
     behind the approvals. The screen does not guess a default branch, does not
     infer that a pull request must be open because it has no end date, and does
     not turn a repository name into a link it made up.
   • ABSENT MEANS ABSENT. A project nobody has looked at yet says so; it does
     not show a green "in sync". An empty list that was never asked for says
     "looking", never "you have none". `merged` and `closed` are drawn as the
     opposite outcomes they are, in words as well as colour, because a list that
     paints them the same is lying about the work.
   • A pull request is traceable to the turn that made it, or it says it is not.
     Nothing here invents a link between an agent and a branch.               */

/** What state a pull request or an issue is in, in words a non-developer reads. */
const ITEM_STATE_WORDS: Record<ProjectItemState, string> = {
  draft: "Draft",
  open: "Open",
  /* MERGED AND CLOSED ARE THE OPPOSITE OUTCOMES and the words say so before the
     colour does. "Closed" on its own reads like a job finished; this one means
     the work was thrown away, and he is the person who would have to notice. */
  merged: "Merged in",
  closed: "Closed, not merged",
};

/* Colour SUPPORTS the words; it never carries the meaning on its own. Closed is
   deliberately plain rather than red — throwing a pull request away is a normal
   outcome and not a fault, and he said himself a bad run should cost one click
   to close. The distinction he must not miss is merged-versus-not, and that is
   in the words above. */
const ITEM_STATE_TONE: Record<ProjectItemState, string> = {
  draft: "", open: "is-pine", merged: "is-ultra", closed: "",
};

/** "vikas53953/cloud9" drawn as the printed label it is — owner quiet, name loud. */
function RepoName({ repo }: { repo: string }): React.JSX.Element {
  const cut = repo.indexOf("/");
  const owner = cut > 0 ? repo.slice(0, cut) : "";
  const name = cut > 0 ? repo.slice(cut + 1) : repo;
  return (
    <span className="reponame" title={repo}>
      {owner && <><span className="ro">{owner}</span><span className="rs">/</span></>}
      <span className="rn">{name}</span>
    </span>
  );
}

/** GitHub's own address and nothing else — `validateProjectItem` already proved it. */
function GitHubLink({ url, children }: { url: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <a className="btn small projlink" href={url} target="_blank" rel="noreferrer noopener">
      {children}
      <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M14 4.5h5.5V10M19 5l-8 8M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10" />
      </svg>
    </a>
  );
}

/**
 * THE SIGNATURE OF THIS SCREEN: a branch, and who is standing on it.
 *
 * His whole decision about how agents touch his code is "branch and pull
 * request, always, one worktree each". So the object this screen is built
 * around is not a row in a table — it is a named branch with a face attached to
 * it. Drawn only when there IS a branch; a pull request without one gets
 * nothing rather than an empty rail.
 */
function BranchRibbon({ branch, base, agent }: {
  branch: string; base?: string; agent?: AgentDef;
}): React.JSX.Element {
  return (
    <span className="branchribbon" data-branch={branch}>
      {agent && <AgentFace name={agent.name} size={20} lamp="live" />}
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
        strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="6.5" cy="5.5" r="2" /><circle cx="6.5" cy="18.5" r="2" /><circle cx="17.5" cy="9" r="2" />
        <path d="M6.5 7.5v9M17.5 11v.6a3 3 0 0 1-3 3h-2a3 3 0 0 0-3 3" />
      </svg>
      <code className="bname">{branch}</code>
      {/* The trunk is only named when the hub told us what it is. Guessing
          "main" would point his one protected branch at something that may not
          exist — the exact thing `defaultBranch` was recorded to prevent. */}
      {base && <><span className="barrow">→</span><code className="bbase">{base}</code></>}
    </span>
  );
}

/**
 * WHICH TURN MADE THIS BRANCH — traced, or honestly not traced.
 *
 * The run records the engine writes carry every command an agent ran, so a turn
 * that created or pushed a branch NAMES it. This looks for that name among the
 * records this screen is already holding and shows the turn it belongs to. It
 * never invents the link: when no held record mentions the branch it says so,
 * and offers the agent's full history instead of a guess.
 *
 * It matches against records ALREADY HELD rather than fetching every run of
 * every agent: a `run` frame arrives unasked the moment any turn finishes, so
 * the trace fills in for work done while he is watching, which is the case that
 * matters — and no click of his puts a hundred frames on the wire.
 */
function TracedRun({ agentId, branch }: { agentId: ID; branch: string }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const needle = branch.toLowerCase();
  const traced = Object.values(world.runs)
    .filter(r => r.agentId === agentId)
    .filter(r => r.steps.some(s =>
      s.label.toLowerCase().includes(needle) || (s.detail ?? "").toLowerCase().includes(needle)))
    .sort((a, b) => b.startedAt - a.startedAt);

  if (traced.length === 0) {
    return (
      <div className="tracenone" data-branch={branch}>
        No turn we are holding names <code>{branch}</code>. Its history is below.
      </div>
    );
  }
  return (
    <div className="traced" data-branch={branch}>
      <span className="eyebrow">The turn that made this branch</span>
      {traced.slice(0, 2).map(r => <RunCard key={r.id} record={r} />)}
    </div>
  );
}

/**
 * Connect a repository — the only form on this screen that changes anything.
 *
 * HIS ASK, 2026-08-01: every app he uses shows him HIS things and lets him
 * click one; this made him type `owner/name` from memory. So the panel opens by
 * asking the computer that holds his GitHub sign-in which repositories it can
 * see, and each one is a row he clicks.
 *
 * THE TYPED FIELD STAYS, and it is not a leftover: somebody else's repository
 * he has been given access to may not be in `gh repo list` at all, and a
 * signed-out computer has no list to show. Both routes go through ONE
 * `connect()` below — the picker is a way of filling that field in, never a
 * second way of connecting.
 *
 * NOTHING HERE PRETENDS. A list we could not fetch is never drawn as "you have
 * no repositories": the reason is printed in the hub's own words, the typed
 * field keeps working, and the list says when it was really asked for.
 */
function ConnectProject({ onConnected }: { onConnected: (repo: string) => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [repo, setRepo] = useState("");
  const [name, setName] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const choices = world.repoChoices;

  /* Asked every time the panel opens, never cached: a repository made this
     morning would otherwise be missing from a list held since yesterday. */
  useEffect(() => { client.askRepositories(); }, []);

  /* THE THIRD SURFACE ON THE SAME OWNER. A half-typed repository name is unsaved
     work like any other, and leaving Projects used to lose it without a word. */
  const settled = useRef(false);
  useUnsavedWork(
    "The repository you are connecting",
    (!!repo.trim() || !!name.trim()) && !settled.current);

  /**
   * ONE CONNECT PATH, whether he clicked a row or typed a name.
   *
   * THE CHECK LIVES IN THE STORE, not here (`connectProject` → `refused`), so
   * every box in the app gives the same answer to "it was refused — what
   * happens to what he typed": say why, in the HUB'S OWN words, right where he
   * is looking, and change nothing else.
   */
  const connect = (which: string, called?: string): void => {
    setRefusal(null);
    setSending(true);
    let stopped = false;
    client.connectProject(which, called?.trim() ? { name: called.trim() } : {}, why => {
      stopped = true;
      setSending(false);
      setRefusal(why);
    });
    /* only leave the form when it was actually accepted */
    if (!stopped) { settled.current = true; onConnected(which); }
  };

  const submit = (): void => connect(repo.trim(), name);

  return (
    <div className="connectproj panelbox">
      <span className="eyebrow">Connect a repository</span>
      <p className="hint">
        These are the repositories the GitHub sign-in on this computer can see. Click one
        to connect it — Cloud9 never asks for a token.
      </p>

      {/* HIS OWN REPOSITORIES, really asked for. Four states, four sentences —
          and "we could not ask" never wears the clothes of "you have none". */}
      <div className="repopick" data-repolist={
        choices.asking ? "asking"
          : choices.problem ? "problem"
            : choices.repos ? (choices.repos.length > 0 ? "list" : "none")
              : "unasked"}>
        <div className="rp-head">
          <span className="eyebrow">Your repositories</span>
          <div className="grow" />
          {choices.fetchedAt !== undefined && !choices.asking && (
            <span className="rp-when" data-repolist-when
              title={new Date(choices.fetchedAt).toLocaleString()}>
              Asked GitHub {dayStamp(choices.fetchedAt)}
            </span>
          )}
          <button className="btn small" data-repolist-again disabled={choices.asking}
            onClick={() => client.askRepositories()}>
            {choices.asking ? "Asking…" : "Ask again"}
          </button>
        </div>

        {choices.asking && (
          <div className="runwait">Asking the GitHub sign-in on this computer…</div>
        )}

        {/* WHY there is no list, in the hub's own words — never an empty list
            reading like "you have no repositories". The typed field below still
            works, and this says so. */}
        {!choices.asking && choices.problem && (
          <div className="rp-problem" role="status">
            <b>Cloud9 could not ask GitHub for your repositories</b>
            <span className="problemtext">{plainError(choices.problem)}</span>
            <span className="rp-fallback">You can still connect one by typing its name below.</span>
          </div>
        )}

        {!choices.asking && !choices.problem && choices.repos?.length === 0 && (
          <div className="rp-none">
            GitHub answered, and this sign-in can see no repositories of its own. If the one
            you want belongs to somebody else, type its name below.
          </div>
        )}

        {!choices.asking && (choices.repos?.length ?? 0) > 0 && (
          <div className="rp-list">
            {choices.repos?.map(choice => (
              <button className="repochoice" key={choice.nameWithOwner}
                data-repo-choice={choice.nameWithOwner} disabled={sending}
                onClick={() => connect(choice.nameWithOwner)}>
                <span className="rc-tx">
                  <b>{choice.nameWithOwner}</b>
                  {choice.description && <span className="rc-sub">{choice.description}</span>}
                </span>
                {/* drawn only when GitHub said — a repository whose visibility
                    we were not told is not labelled as public */}
                {choice.visibility && (
                  <span className={`chip ${choice.visibility === "public" ? "" : "is-gold"}`}>
                    {choice.visibility === "public" ? "Public"
                      : choice.visibility === "private" ? "Private" : "Internal"}
                  </span>
                )}
                {choice.updatedAt !== undefined && (
                  <span className="rc-when">Changed {dayStamp(choice.updatedAt)}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <p className="hint">
        Not in the list — somebody else's repository? Name it the way GitHub does,
        as <code>owner/name</code>.
      </p>
      <div className="cp-row">
        <input className="input" id="f-repo" placeholder="vikas53953/cloud9" value={repo}
          autoComplete="off" spellCheck={false}
          onChange={e => { setRepo(e.target.value); setRefusal(null); }}
          onKeyDown={e => { if (e.key === "Enter") submit(); }} />
        <input className="input" id="f-repo-name" placeholder="Call it something (optional)" value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") submit(); }} />
        <button className="btn primary" disabled={sending} onClick={submit}>Connect</button>
      </div>
      <Problem text={refusal ?? undefined} />
    </div>
  );
}

/**
 * WHERE THIS PROJECT'S CODE LIVES ON THIS COMPUTER — and honestly when it does
 * not live anywhere yet.
 *
 * This closes `docs/plans/approval-handoff.md` §8. A project named a repository
 * on GitHub and nothing on screen could say where its code was on the machine,
 * so `!code` in a room answered "nobody has told Cloud9 where this project's
 * code lives" for every project, for ever.
 *
 * THE WINDOW NEVER TOUCHES THE FILESYSTEM. "Choose folder" asks the desktop
 * shell to draw the operating system's own picker (`dialog.showOpenDialog`),
 * and the only thing that comes back is the one folder the owner picked. In a
 * plain browser — dev, QA — there is no picker at all, so it says so and offers
 * to take the folder typed, which is the same frame by another route.
 */
function ProjectFolder({ project }: { project: Project }): React.JSX.Element {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState(project.localPath ?? "");
  useEffect(() => {
    setDraft(project.localPath ?? "");
    setTyping(false);
    setRefusal(null);
  }, [project.id, project.localPath]);

  const save = (folder: string): void => {
    setRefusal(null);
    client.setProjectFolder(project.id, folder, why => setRefusal(why));
  };

  const pick = async (): Promise<void> => {
    setRefusal(null);
    const picker = desktop()?.chooseFolder;
    if (!picker) {
      // NOT A DEAD BUTTON, and not a lie either: this window has no picker, so
      // it says which and takes the folder typed instead.
      setTyping(true);
      return;
    }
    const picked: { ok: boolean; path?: string; cancelled?: boolean; error?: string } =
      await picker(project.localPath).catch(() => ({
        ok: false, error: "This computer could not open the folder picker.",
      }));
    if (picked.ok && picked.path) { save(picked.path); return; }
    // closing the picker means "not now" — nothing changes and nothing is said
    if (picked.cancelled) return;
    if (picked.error) setRefusal(picked.error);
  };

  return (
    <div className="pd-folder" data-folder={project.localPath ?? ""}
      data-folder-state={project.localPath ? "linked" : "none"}>
      <span className="eyebrow">Where the code lives on this computer</span>
      {project.localPath
        ? <code className="folderpath">{project.localPath}</code>
        : (
          <span className="pd-nofolder">
            No folder linked yet. Until you choose one, an agent asked to work in this
            project's code says so rather than guessing a folder.
          </span>
        )}

      {typing && (
        <div className="cp-row">
          <input className="input" id="f-folder" autoFocus value={draft}
            placeholder="C:\Users\you\code\cloud9"
            autoComplete="off" spellCheck={false}
            onChange={e => { setDraft(e.target.value); setRefusal(null); }}
            onKeyDown={e => { if (e.key === "Enter") save(draft); }} />
          <button className="btn primary small" data-folder-save
            onClick={() => save(draft)}>Save the folder</button>
          <button className="btn small" onClick={() => setTyping(false)}>Cancel</button>
        </div>
      )}

      <div className="actions">
        <button className="btn small" data-folder-choose onClick={() => void pick()}>
          {project.localPath ? "Choose a different folder" : "Choose folder"}
        </button>
        {project.localPath && (
          <button className="btn small" data-folder-clear onClick={() => save("")}>
            Forget this folder
          </button>
        )}
        {typing && !desktop()?.chooseFolder && (
          <span className="hint">
            This window cannot open the computer's folder picker, so type the whole
            folder — starting from the drive.
          </span>
        )}
      </div>

      <Problem text={refusal ?? undefined} attrs={{ "data-folder-refusal": "" }} />
    </div>
  );
}

/** One project's pull requests and issues, and the crew standing on its branches. */
function ProjectDetail({ project, onOpenChannel }: {
  project: Project; onOpenChannel: (id: ID) => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [tab, setTab] = useState<ProjectItemKind>("pull");
  const [open, setOpen] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(project.name);
  const [forgetAsked, setForgetAsked] = useState(false);
  /* Pressed, and the hub has not said anything back yet. It covers the moment
     between the click and the hub's answer, and NOTHING ELSE — once the hub is
     talking, `project.looking` is the truth, because only the hub knows whether
     the engine is still out there looking. */
  const [justAsked, setJustAsked] = useState(false);
  const [lookRefusal, setLookRefusal] = useState<string | null>(null);
  const looking = project.looking === true || justAsked;

  const held = client.itemsFor(project.id);
  useEffect(() => {
    client.askProjectItems(project.id);
    setOpen(null);
    setForgetAsked(false);
    setRenaming(false);
    setJustAsked(false);
    setLookRefusal(null);
  }, [project.id]);
  /* The hub has spoken about this project — it is either looking, or it has
     finished. Either way this app is no longer the one holding the spinner. */
  useEffect(() => {
    setJustAsked(false);
  }, [project.looking, project.syncedAt, project.problem]);
  useEffect(() => { setDraftName(project.name); }, [project.name, renaming]);

  const pulls = held.items.filter(i => i.kind === "pull");
  const issues = held.items.filter(i => i.kind === "issue");
  const shown = tab === "pull" ? pulls : issues;
  const reportsInto = project.channelId
    ? world.channels.find(c => c.id === project.channelId)
    : undefined;

  /* WHO OF HIS CREW IS WORKING IN THIS REPOSITORY. Built from the pull requests
     the engine reported, and from nothing else: an agent appears here because
     it opened something, not because somebody said it might. */
  const crewAtWork = world.agents
    .map(a => ({ agent: a, items: pulls.filter(i => i.agentId === a.id) }))
    .filter(x => x.items.length > 0);

  const itemRow = (item: ProjectItem): React.JSX.Element => {
    const key = `${item.kind}-${item.number}`;
    const agent = item.agentId ? world.agents.find(a => a.id === item.agentId) : undefined;
    const isOpen = open === key;
    return (
      <div className="projitem" key={key} data-item={key} data-state={item.state}
        data-agent={item.agentId ?? ""}>
        <button className="pi-head" aria-expanded={isOpen}
          onClick={() => setOpen(isOpen ? null : key)}>
          <span className="pi-no">#{item.number}</span>
          <span className="pi-tx">
            <b>{item.title}</b>
            <span className="pi-sub">
              {item.author ? `${item.author} · ` : ""}opened {dayStamp(item.createdAt)}
            </span>
          </span>
          {item.branch && <BranchRibbon branch={item.branch} base={project.defaultBranch} agent={agent} />}
          <span className={`chip ${ITEM_STATE_TONE[item.state]}`}>{ITEM_STATE_WORDS[item.state]}</span>
        </button>

        {isOpen && (
          <div className="pi-body">
            <dl className="kv">
              <dt>Number</dt><dd>#{item.number}</dd>
              {item.author && <><dt>Opened by</dt><dd>{item.author}</dd></>}
              {agent && <><dt>Your agent</dt><dd>{agent.name}</dd></>}
              {item.branch && <><dt>Branch</dt><dd><code>{item.branch}</code></dd></>}
              {item.kind === "pull" && project.defaultBranch && (
                <><dt>Aimed at</dt><dd><code>{project.defaultBranch}</code></dd></>
              )}
              <dt>Opened</dt><dd>{dayStamp(item.createdAt)}</dd>
              <dt>Last change</dt><dd>{dayStamp(item.updatedAt)}</dd>
              <dt>State</dt><dd>{ITEM_STATE_WORDS[item.state]}</dd>
            </dl>

            {/* WHAT WE DO NOT HAVE, said plainly rather than left as a blank
                space he would read as "there is nothing written here". Cloud9
                keeps the title and where to find it; the conversation lives on
                GitHub and that is where it is read. */}
            <p className="pi-note">
              Cloud9 keeps the title, the state and where to find it. The description and
              the conversation stay on GitHub.
            </p>

            <div className="actions">
              <GitHubLink url={item.url}>
                {item.kind === "pull" ? "Read the pull request" : "Read the issue"}
              </GitHubLink>
            </div>

            {/* Traceable to the job that made it — his point 3. Only for a pull
                request one of HIS agents opened, and only from records already
                held; an untraced branch says so. */}
            {agent && item.branch && agent.ownerId === world.me?.id && (
              <div className="pi-work">
                <TracedRun agentId={agent.id} branch={item.branch} />
                <span className="eyebrow">Everything {agent.name} has done</span>
                <RecentWork agentId={agent.id} />
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="projdetail" data-project={project.id} data-repo={project.repo}>
      <div className="pd-head">
        <div className="pd-title">
          {renaming ? (
            <div className="cp-row">
              <input className="input" value={draftName} autoFocus
                onChange={e => setDraftName(e.target.value)}
                onKeyDown={e => { if (e.key === "Escape") setRenaming(false); }} />
              <button className="btn primary small" onClick={() => {
                client.send({ type: "updateProject", projectId: project.id, name: draftName });
                setRenaming(false);
              }}>Save the name</button>
              <button className="btn small" onClick={() => setRenaming(false)}>Cancel</button>
            </div>
          ) : (
            <>
              <h3>{project.name}</h3>
              <RepoName repo={project.repo} />
            </>
          )}
        </div>
        {!renaming && (
          <div className="pd-btns">
            {/* THE WAY IN. Cloud9 does not reach GitHub — this asks the hub,
                which asks the copy of Cloud9 running on this computer, which
                uses the GitHub sign-in already here. Reading two lists changes
                nothing on GitHub, so nothing is approved and nothing can be
                written. While a look is under way the button says so and
                cannot be pressed again; that state comes from the hub, which
                is the only party that knows whether anyone is still looking. */}
            <button className="btn small primary" data-look={looking ? "busy" : "ready"}
              disabled={looking}
              onClick={() => {
                setLookRefusal(null);
                setJustAsked(true);
                client.lookAtProject(project.id, why => { setJustAsked(false); setLookRefusal(why); });
              }}>
              {looking ? "Looking at GitHub…" : "Look at GitHub now"}
            </button>
            <button className="btn small" onClick={() => setRenaming(true)}>Rename</button>
            {!forgetAsked
              ? <button className="btn small" onClick={() => setForgetAsked(true)}>Disconnect</button>
              : <>
                <button className="btn small danger" onClick={() => {
                  client.send({ type: "forgetProject", projectId: project.id });
                }}>Yes, forget it</button>
                <button className="btn small" onClick={() => setForgetAsked(false)}>Keep it</button>
              </>}
          </div>
        )}
      </div>

      {forgetAsked && (
        <p className="pd-reassure">
          Disconnecting forgets Cloud9's copy of these lists. <b>Your repository is not
          touched</b> — Cloud9 has no way to delete anything on GitHub.
        </p>
      )}

      <div className="pd-facts">
        {/* Each of these is drawn ONLY when the hub told us. A repository nobody
            has looked at has no branch chip and no "last looked" chip, and says
            that in words instead. */}
        {project.defaultBranch && (
          <span className="chip" title="Nothing lands here without you">
            Trunk <code>{project.defaultBranch}</code>
          </span>
        )}
        {/* WHEN IT WAS LAST LOOKED AT, and the hub is the only thing that
            decides that — it stamps `syncedAt` when the engine reports back.
            No stamp means nobody has looked, and it says exactly that. */}
        {looking
          ? <span className="chip is-gold" data-look-state="busy">Looking at GitHub now…</span>
          : project.syncedAt
            ? <span className="chip" data-look-state="looked"
              title={new Date(project.syncedAt).toLocaleString()}>
              Looked at GitHub {dayStamp(project.syncedAt)}
            </span>
            : <span className="chip is-gold" data-look-state="never">Not looked at GitHub yet</span>}
        {reportsInto && (
          <button className="chip is-ultra" onClick={() => onOpenChannel(reportsInto.id)}>
            Reports into #{reportsInto.name}
          </button>
        )}
      </div>

      {project.description && <p className="pd-desc">{project.description}</p>}

      {/* The folder on THIS computer — the other half of a project. The name
          above says which repository it is on GitHub; this says where its code
          is here, which is what an agent asked to work in code actually needs. */}
      <ProjectFolder project={project} />

      {/* The hub's refusal, where the button he pressed is — not only in the
          toast that floats above every screen. Its own words, never a
          paraphrase. */}
      <Problem text={lookRefusal ?? undefined} attrs={{ "data-look-refusal": "" }} />

      {/* The hub's own sentence for why the last look failed, never a paraphrase
          and never an empty list pretending to be "no open work". */}
      {project.problem && (
        <div className="pd-problem" role="status">
          <b>The last look at GitHub did not work</b>
          <span className="problemtext">{plainError(project.problem)}</span>
        </div>
      )}

      {!project.syncedAt && (
        <div className="pd-never">
          <b>Nobody has asked GitHub about this repository yet.</b>
          {/* THE SENTENCE CHANGED ON 2026-07-30, because the thing it was
              apologising for now exists. It used to say nothing in Cloud9 could
              ask GitHub at all — true then, a lie now that "Look at GitHub now"
              runs `gh` on this computer. What it still refuses to say is that
              there is no open work: nobody has looked, and an empty list below
              is our copy, not GitHub's. */}
          <span>
            Cloud9 never calls GitHub itself — it uses the GitHub sign-in already on this
            computer. Press <b>Look at GitHub now</b> and it will fetch the open pull
            requests and issues. Nothing looks on a schedule yet, so until you do, the
            lists below are Cloud9's copy and not what GitHub has.
          </span>
        </div>
      )}

      {crewAtWork.length > 0 && (
        <div className="pd-crew">
          <span className="eyebrow">Your crew in this repository</span>
          <div className="crewbranches">
            {crewAtWork.map(({ agent, items }) => (
              <div className="crewbranch" key={agent.id} data-agent={agent.id}>
                <AgentFace name={agent.name} size={32} presence={presenceOf(world, agent.id)} hasPresence />
                <div className="cb-tx">
                  <b>{agent.name}</b>
                  <span className="cb-sub">
                    {countOf(items.length, "pull request")} here
                  </span>
                </div>
                <div className="cb-branches">
                  {items.map(i => (
                    <span className="cb-one" key={i.number}>
                      {i.branch
                        ? <BranchRibbon branch={i.branch} base={project.defaultBranch} />
                        : <code className="bname">#{i.number}</code>}
                      <span className={`chip ${ITEM_STATE_TONE[i.state]}`}>{ITEM_STATE_WORDS[i.state]}</span>
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {/* The worktree an agent is standing in is the engine's own business
              and never crosses the wire, so this screen does not claim to know
              it. Written down in docs/plans/projects-handoff.md rather than
              filled in with a plausible-looking path. */}
          <p className="pd-note">
            The folder each agent works in stays on this computer and is not reported to
            Cloud9 yet — the branch above is what travels.
          </p>
        </div>
      )}

      <div className="pd-tabs">
        <div className="seg" role="group" aria-label="Pull requests or issues">
          <button aria-pressed={tab === "pull"} data-tab="pull" onClick={() => setTab("pull")}>
            Pull requests{held.asked ? ` · ${pulls.length}` : ""}
          </button>
          <button aria-pressed={tab === "issue"} data-tab="issue" onClick={() => setTab("issue")}>
            Issues{held.asked ? ` · ${issues.length}` : ""}
          </button>
        </div>
      </div>

      <div className="pd-items">
        {!held.asked && <div className="runwait">Asking the hub what it is holding…</div>}
        {held.asked && shown.length === 0 && (
          <EmptyTray
            title={tab === "pull" ? "No pull requests recorded" : "No issues recorded"}
            line={project.syncedAt
              ? <>This is what GitHub said when it was last looked at, {dayStamp(project.syncedAt)}.</>
              : <>Nobody has looked at GitHub yet, so this is what Cloud9 holds — not what
                GitHub has. Press <b>Look at GitHub now</b> above.</>} />
        )}
        {shown.map(itemRow)}
      </div>
    </div>
  );
}

function ProjectsScreen({ onOpenChannel }: { onOpenChannel: (id: ID) => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [pickedId, setPickedId] = useState<ID | null>(null);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => { client.askProjects(); }, []);

  const projects = world.projects.list;
  const picked = projects.find(p => p.id === pickedId) ?? projects[0];

  /* A repository just connected is the one he wants to look at. Matched on the
     repository name because the id only exists once the hub has answered. */
  const connectedRepo = useRef<string | null>(null);
  useEffect(() => {
    if (!connectedRepo.current) return;
    const made = projects.find(p => p.repo === connectedRepo.current);
    if (!made) return;
    connectedRepo.current = null;
    setPickedId(made.id);
    setConnecting(false);
  }, [projects]);

  return (
    <div className="projects">
      <header className="topbar">
        <h2>Projects</h2>
        <span className="sub">The repositories your crew works in — branches, pull requests, issues</span>
        <div className="grow" />
        <button className="btn primary" data-connect
          onClick={() => setConnecting(v => !v)}>
          {connecting ? "Not now" : "Connect a repository"}
        </button>
      </header>

      <div className="proj-body">
        <aside className="proj-list">
          <span className="eyebrow">Connected</span>
          {!world.projects.asked && <div className="railempty">Looking…</div>}
          {world.projects.asked && projects.length === 0 && (
            <div className="railempty">
              Nothing connected yet. Connect <code>owner/name</code> and this fills in.
            </div>
          )}
          {projects.map(p => (
            <button key={p.id} className="side-item" data-project={p.id} data-repo={p.repo}
              aria-current={picked?.id === p.id ? "true" : "false"}
              onClick={() => setPickedId(p.id)}>
              <span className="txt">{p.name}</span>
              {p.problem && <span className="cnt hot" title={p.problem}>!</span>}
            </button>
          ))}
        </aside>

        <div className="proj-main">
          {connecting && (
            <ConnectProject onConnected={repo => { connectedRepo.current = repo; }} />
          )}

          {!connecting && projects.length === 0 && world.projects.asked && (
            <EmptyTray title="No repository connected yet"
              line={<>
                A project is a repository — its pull requests and its issues, together.
                Press <b>Connect a repository</b> and name it the way GitHub does,
                like <code>vikas53953/cloud9</code>.
              </>} />
          )}

          {picked && <ProjectDetail project={picked} onOpenChannel={onOpenChannel} />}
        </div>
      </div>
    </div>
  );
}

/* ================= 6b · SPENDING =================
 *
 * WHAT HIS CREW COSTS HIM, AND WHICH PART OF IT IS WASTE.
 *
 * THE WALL THIS CLOSES. Cloud9 has written down what every Claude turn cost
 * since run records existed. Until today the only place any of it appeared was
 * one line inside one run card — so answering "which of my agents is the
 * expensive one" meant opening every agent, then every run, and adding it up by
 * hand. He never did that, and nobody would.
 *
 * THE THREE RULES THIS SCREEN IS HELD TO, and each one is a way it could
 * quietly start lying:
 *
 *  1. NO INVENTED ZERO. Codex reports no cost at all. This screen says so in
 *     words where the money would go; it must never draw $0.00, because $0.00
 *     reads as "this one is free" and he would move all his work onto it.
 *  2. NO NUMBER WITHOUT ITS COUNT. A total is drawn beside how many turns
 *     actually reported a figure, because "$12 over 40 turns" and "$12 over 3
 *     of 40 turns" are different facts and only one of them is a bill.
 *  3. NO JARGON, ANYWHERE. He is a network engineer. "Token", "context window"
 *     and "prompt cache" do not appear. What appears is: what he was charged
 *     for, how much of it was material handed to the agent rather than work it
 *     did, and what stops if he does nothing.
 *
 * Every sentence and every figure comes out of `@cloud9/shared/tokenuse` — the
 * same functions the hub used to answer, and the same ones an agent reads
 * through `check_token_use`. A screen with its own arithmetic would be a second
 * answer to the same question.
 */

/**
 * The narrowest share of the bar that can still hold its own words.
 *
 * A fifth of the width fits "1% written back" at this font; below that the text
 * is cut mid-word. Measured against the real case rather than guessed at — his
 * dearest agent splits 99/1, so the clipped end is the normal case here, not an
 * edge of it.
 */
const SPLIT_LABEL_FITS = 0.2;

/** One agent's row: what it cost, how it splits, and what is wrong with it. */
function SpendingRow({ row }: {
  row: { use: AgentTokenUse; findings: WasteFinding[] };
}): React.JSX.Element {
  const { use, findings } = row;
  const split = sentVsWrote(use);
  return (
    <section className="spendrow" data-spend-agent={use.agentId}>
      <header>
        <AgentFace name={use.agentName} size={30} lamp="idle" />
        <div className="who">
          <b>{use.agentName}</b>
          <span className="meta">{PROVIDER_LABEL[(use.provider ?? "claude") as Provider]}</span>
        </div>
        <div className="grow" />
        {/* RULE 1 AND RULE 2 IN ONE PLACE. `moneyWords` is the only thing on
            this screen allowed to say an amount, so there is exactly one
            function that decides what an agent nobody costed looks like. */}
        <span className={use.reportsCost && use.costUsd !== undefined ? "amt" : "amt unknown"}>
          {moneyWords(use)}
        </span>
      </header>

      {/* WHERE THE MONEY WENT — the half of this screen he cannot get anywhere
          else. A bill that is mostly what it WROTE is money buying work; a bill
          that is mostly what it was SENT is money buying nothing. Drawn only
          when the app reported both halves; there is no honest bar otherwise. */}
      {split && (
        <div className="splitbar" data-split={use.agentId}
          title={`${Math.round(split.sentShare * 100)}% sent to it, `
            + `${Math.round(split.wroteShare * 100)}% written back`}>
          {/* A LABEL THAT DOES NOT FIT IS WORSE THAN NO LABEL. Caught on his
              real data: the agent this feature exists to catch is 99%/1%, and
              at 1% the segment drew the word "written" clipped to "ritten" —
              which reads as a rendering fault and makes a person distrust the
              number beside it. Below a width that can hold the words, the
              segment carries none; the figure is in the sentence underneath and
              in the bar's own hover text either way, so nothing is lost. */}
          <div className="sent" style={{ width: `${Math.round(split.sentShare * 100)}%` }}>
            {split.sentShare >= SPLIT_LABEL_FITS && (
              <span>{Math.round(split.sentShare * 100)}% handed to it</span>
            )}
          </div>
          <div className="wrote" style={{ width: `${Math.round(split.wroteShare * 100)}%` }}>
            {split.wroteShare >= SPLIT_LABEL_FITS && (
              <span>{Math.round(split.wroteShare * 100)}% written back</span>
            )}
          </div>
        </div>
      )}
      {split && (
        <p className="meta perturn">
          Per turn: {humanTextSize((use.sentToIt ?? 0) / Math.max(1, use.runsWithSize))} handed
          to it, {humanTextSize((use.wroteBack ?? 0) / Math.max(1, use.runsWithSize))} written back.
          {/* WHERE THE FIGURE CAME FROM, when some of it had to be rebuilt from
              records made before the app wrote this number down. Saying so is
              cheap; letting him think every figure was reported at the time is
              the kind of quiet overclaim that costs an app its credibility the
              first time somebody checks. */}
          {use.runsWithRebuiltSize > 0 && (
            <span className="rebuilt">
              {use.runsWithRebuiltSize === use.runsWithSize
                ? " None of these turns"
                : ` ${use.runsWithRebuiltSize} of these ${use.runsWithSize} turns`} recorded
              a single total at the time, so the size above is added up from the separate
              amounts the app did report. Nothing is estimated — but it is worked out
              rather than read off.
            </span>
          )}
        </p>
      )}

      {/* THE WASTE, NAMED. A number he cannot act on is not worth his time —
          this is the part that tells him WHAT is wrong and shows the counting
          behind it, so he never has to take Cloud9's word for anything. */}
      {findings.map(f => (
        <div className={f.change ? "finding fixable" : "finding"} key={f.id} data-finding={f.id}>
          <b>{f.headline}</b>
          <ul>
            {f.evidence.map((e, i) => <li key={i}>{e}</li>)}
            {f.worth && <li className="worth">{f.worth}</li>}
          </ul>
          {/* A MEASUREMENT FROM SOMEWHERE ELSE, drawn apart from the counted
              facts above and saying whose it is. It used to sit in the list
              with them, which made a figure from a different agent on a
              different day read as something measured about THIS one. */}
          {f.reference && <p className="meta borrowed">{f.reference}</p>}
          {/* NO BUTTON HERE, AND THAT IS DELIBERATE. Everything on this screen
              is a thing to READ. The change itself is made where every other
              change to an agent is made — on the agent's own page — or by
              accepting the card an agent raises. Putting a second "apply"
              button here would be a second path to the same write, and this app
              has spent a great deal of effort making sure there is only one of
              anything that changes something. */}
          {f.change && (
            <p className="meta">
              You can change this on {f.agentName}&rsquo;s own page. Your agents can also
              offer it to you as a card — they can never change it themselves.
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

function SpendingScreen(): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const { asked, loading, at, rows } = world.spending;
  /* DEAREST FIRST, and the ones nobody costed at the bottom rather than looking
     like the cheap ones — `dearestFirst` owns that ordering, not this screen. */
  const ordered = dearestFirst(rows.map(r => r.use))
    .map(u => rows.find(r => r.use.agentId === u.agentId)!)
    .filter(Boolean);
  const fixable = rows.reduce((n, r) => n + r.findings.filter(f => f.change).length, 0);

  return (
    <div className="spending">
      <header className="topbar">
        <h2>Spending</h2>
        <span className="sub">What your agents cost you this month, and what is wasted</span>
        <div className="grow" />
        <button className="btn ghost small" data-spend-refresh
          onClick={() => client.askSpending()} disabled={loading}>
          {loading ? "Working it out…" : "Check again"}
        </button>
      </header>

      <div className="act-body">
        {!asked && <div className="railempty">Working out what everything has cost…</div>}

        {asked && rows.length === 0 && (
          <EmptyTray title="Nothing has been recorded yet this month"
            line={<>
              Once your agents start answering, this fills in on its own — what each one
              cost you, how much of that was material handed to it rather than work it
              did, and anything wasteful about the way it is set up.
            </>} />
        )}

        {asked && rows.length > 0 && (
          <>
            <p className="spendlead" data-spend-lead>
              {fixable > 0
                ? <>There {fixable === 1 ? "is" : "are"} <b>{fixable}</b> thing{fixable === 1 ? "" : "s"} here
                  you could change to spend less. Each one shows the counting behind it.</>
                : <>Nothing here looks wasteful. Every figure below was reported by the app
                  that ran the turn — none of it is estimated.</>}
            </p>
            {ordered.map(row => <SpendingRow key={row.use.agentId} row={row} />)}
            {/* THE HONEST FOOTNOTE, and it belongs on the screen rather than in
                a comment: he is entitled to know what this page CANNOT tell him
                before he makes a decision on it. */}
            <p className="meta spendfoot">
              Only the Claude app tells Cloud9 what a turn cost — Codex reports nothing, so
              an agent running on Codex shows no money here rather than showing zero.
              Older turns drop off after a while, so a very busy month may show less than
              it really spent.
              {at ? ` Worked out ${clock(at)}.` : ""}
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/* ================= 7 · ACTIVITY ================= */

/**
 * WHAT MY CREW IS DOING RIGHT NOW — one row per agent, above the trail.
 *
 * ================= WHY THIS SITS ON THE SCREEN THAT ALREADY EXISTED =========
 *
 * The Activity screen could already answer "what happened" and it could not
 * answer "what is happening". Those are the same question one tense apart, and
 * a SECOND screen for the second tense would have been the worse outcome: two
 * rail buttons, both called something like Activity, and a person guessing
 * which one to press. So the board goes at the top of this screen and the trail
 * stays underneath it — now, then before.
 *
 * NOTHING HERE IS POLLED FOR THE LIVE HALF. Every fact on a row is already
 * pushed to this app as it changes — `agentStatus` frames carry the lamp and
 * the reason, `approval` frames carry what is waiting on him, and the live
 * steps arrive on their own channel. The board is a render of state that was
 * already arriving, which is why it moves while he watches it.
 */
/**
 * ONE OWNER OF "WHAT IS EACH OF MY AGENTS DOING" — read by the board AND by the
 * count on the rail button.
 *
 * ======================= WHY THIS IS A HOOK ================================
 *
 * It used to be a block inside the board, and the rail counted the working
 * lamps itself. Two computations of one fact is two chances to be right, and
 * they disagreed in a way he could SEE AT ONCE: an agent that stops mid-job to
 * ask him something still has the engine's working lamp lit, so the button said
 * "1" and the board said "Nothing is being worked on".
 *
 * Now there is one list of lines and everything on the screen is derived from
 * it. A second way to count agents is, from here on, a bug.
 */
function useAgentActivity(): { agent: AgentDef; line: AgentActivityLine }[] {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const liveWork = useLiveWorkByAgent();

  /* HIS OWN AGENTS ONLY, and that is the hub's rule and not a tidy-up: what an
     agent has been doing is owner-only there, so asking about somebody else's
     would be refused and drawing a row for it would promise an answer this app
     is never going to get. */
  const mine = useMemo(
    () => world.agents.filter(a => a.ownerId === world.me?.id),
    [world.agents, world.me?.id]);

  /* THE ONE OWNER OF "IS THIS STILL WAITING ON HIM" — the same function the
     tasks tray and the rail's approval badge use, and NOT a second reading of
     `status === "pending"`.
     Re-implementing it here is how the board came to raise "Waiting for you"
     over go-aheads that had already run out. That is worse than a wrong row:
     it is rank-0, so it HID the agent's real state behind a button he no longer
     has. `useMyApprovals` applies `approvalIsDead` and ticks the clock. */
  const { waiting: liveApprovals } = useMyApprovals(world.approvals, world.me?.id);

  /* THE LAST THING EACH ONE DID IS FETCHED BY THE SCREEN THAT SHOWS IT, NOT
     HERE. Making the rail button read from these same lines put this hook
     inside the always-on part of the app, so a fetch living here would have
     gone out for every agent every time any lamp moved, all day, whether or not
     he was looking at the board. Nothing but the board reads the past-jobs part
     of a line — see `useRunHistoryWhileWatching` below. */

  /* WHAT HE WAS ASKED, for an agent that is mid-job. The live steps know which
     MESSAGE they answer; the message text is the ask. Looked up here rather
     than sent again, so the board can never disagree with the room. */
  const askOf = useCallback((messageId: ID): string | undefined => {
    for (const list of Object.values(world.messages)) {
      const found = list.find(m => m.id === messageId);
      if (found?.text) return quoteOf(found.text, 90);
    }
    return undefined;
  }, [world.messages]);

  return useMemo(() => mine.map(agent => {
    const presence = world.presence[agent.id];
    const work = liveWork[agent.id];
    const asking = liveApprovals.find(ap => ap.agentId === agent.id);
    /* A HANDED-OVER JOB IT IS HOLDING BUT HAS NOT STARTED. `not_started` is the
       hub's own word for a job in the tray that has not begun, and without this
       an agent sitting on one was drawn as idle, still wearing the tick from the
       job before it.
       THIS IS THE JOB QUEUE, NOT THE ENGINE'S TURN QUEUE. An ordinary
       `@Agent do X` in a room makes no job, so a chat turn waiting behind the
       engine's two-at-a-time limit is not covered by this and its row still
       shows the last thing that agent finished. Open item on the board; it needs
       the engine to report its queue, which nothing on the wire does today. */
    const queued = world.tasks.find(t => t.agentId === agent.id && t.status === "not_started");
    const last = client.runsFor("agent", agent.id).entries[0];
    const line = agentActivityLine({
      presence: presence?.presence,
      presenceReason: presence?.reason,
      status: world.agentStatus[agent.id],
      lifecycle: agent.lifecycle,
      doingNow: work?.doing,
      askedTo: work ? askOf(work.messageId) : undefined,
      awaitingOwner: !!asking,
      awaitingWhat: asking?.action,
      queuedWork: queued?.title,
      /* THE RECORD, PASSED STRAIGHT THROUGH. This screen used to do a small sum
         here — "when did it end" — and got it wrong, reading a three-hour job
         that ended seconds ago as three hours old. `agentActivityLine` now takes
         the stored fields and does the arithmetic itself, so there is nothing
         left here to get wrong. */
      last,
    });
    return { agent, line };
    /* `world.runLists` IS IN THIS LIST BECAUSE THE ANSWER ARRIVES LATER.
       The run history is read through `client` (one spelling of a history's
       key, rather than two), but it is WORLD state — so leaving it out of the
       dependencies meant the answer to "what did it just do" could land and the
       board would never redraw to show it. The row would sit on "Ready" for
       ever with the record already in memory. */
  }), [mine, world.presence, world.agentStatus, world.tasks, world.runLists,
    liveApprovals, liveWork, askOf]);
}

/**
 * KEEP "what it just did" FRESH, FOR AS LONG AS HE IS WATCHING.
 *
 * A finished job only becomes a fact this app holds once the hub is asked
 * again, so asking once on mount was the stale-by-design version of this row:
 * he would watch an agent finish in front of him and the board would still be
 * showing the job before it. Keying the ask on the lamps means the moment one
 * goes from working to idle, the board fetches what it just did. `askRuns`
 * refuses to stack requests, so this cannot pile up.
 *
 * TEN, NOT ONE, and that number is load-bearing. A history is stored under one
 * key per agent, so the board asking for 1 and an agent's own Recent work panel
 * asking for 10 overwrote each other: open an agent after visiting this screen
 * and nine of its ten jobs had vanished. The board reads only the newest, so
 * asking for the same 10 costs nothing and leaves one list that suits both.
 *
 * It lives on the BOARD and not in `useAgentActivity` because that hook is now
 * read by the rail button too, which is on screen always — a fetch in there
 * would go out for every agent every time any lamp moved, for ever.
 *
 * ============ AND IT KEEPS ASKING, BECAUSE THE LAMP GOES OUT FIRST ==========
 *
 * Asking ONLY when a lamp moves was still not enough, and the walk of the
 * packaged app on 2026-08-07 caught it: he stopped Ledger mid-job, and the row
 * read "Ready · it hasn't been asked to do anything yet" for SIX MINUTES before
 * it turned into "🛑 You stopped it". The lamp clears the instant the turn ends
 * and the record of what happened is written a moment later, so the one ask the
 * lamp triggered went out too early and came back empty — and nothing asked
 * again until some OTHER agent happened to start or stop.
 *
 * A row that is wrong for six minutes about a thing he did himself is the
 * failure this whole screen exists to prevent. So it asks on the lamp AND on
 * the same slow beat the trail below already uses, for as long as he is
 * standing here. The timer stops when he leaves the screen.
 */
function useRunHistoryWhileWatching(agentIds: readonly ID[], statuses: Record<ID, AgentStatus>): void {
  const lampKey = agentIds.map(id => `${id}:${statuses[id] ?? "idle"}`).join(" ");
  /* The ids alone, so the repeating timer is not rebuilt every time a lamp
     moves — only when the crew itself changes. */
  const idKey = agentIds.join(" ");
  useEffect(() => {
    const ask = (): void => {
      for (const id of idKey ? idKey.split(" ") : []) {
        client.askRuns("agent", id, RUN_HISTORY_LIMIT);
      }
    };
    ask();
    const t = setInterval(ask, ACTIVITY_REFRESH_MS);
    return () => clearInterval(t);
  }, [idKey]);
  /* Still asked the moment a lamp moves as well — the beat above is the
     backstop, not the mechanism. Waiting up to four seconds to notice a job
     that finished in front of him would be the stale row all over again, just
     shorter. */
  useEffect(() => {
    for (const pair of lampKey ? lampKey.split(" ") : []) {
      client.askRuns("agent", pair.slice(0, pair.lastIndexOf(":")), RUN_HISTORY_LIMIT);
    }
  }, [lampKey]);
}

function RightNowBoard(): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const rows = useAgentActivity();
  useRunHistoryWhileWatching(rows.map(r => r.agent.id), world.agentStatus);

  /* Stable inside a state, so a lamp changing somewhere else never reshuffles
     the rows he is reading. */
  const ordered = useMemo(
    () => rows.map((r, i) => ({ ...r, i }))
      .sort((a, b) => activityRank(a.line.state) - activityRank(b.line.state) || a.i - b.i),
    [rows]);

  const summary = crewActivitySummary(rows.map(r => r.line));

  return (
    <section className="rightnow" aria-label="What your agents are doing right now">
      <div className="rn-head">
        <h3>Right now</h3>
        {/* NEVER A SILENT BOARD. "Nothing is happening" is an answer he came
            for, so it is written out — an empty panel is the app refusing to
            speak. `crewActivitySummary` has no branch that returns "". */}
        <p className="rn-sum" data-testid="rightnow-summary">{summary}</p>
      </div>
      {ordered.length > 0 && (
        <div className="rn-rows">
          {ordered.map(({ agent, line }) => (
            <div className="rn-row" key={agent.id}
              data-agent={agent.id} data-state={line.state}>
              <span className="rn-face"><AgentFace name={agent.name} size={30} /></span>
              <span className="rn-tx">
                <b>{agent.name}</b>
                <span className="rn-detail">{line.detail}</span>
              </span>
              {/* THE TICK IS ONLY DRAWN WHEN THERE IS ONE. A quiet state has no
                  tick in the chat either, and printing a dash in its place put
                  a mark on the row that means nothing — "— Ready" reads as a
                  missing icon, not as calm. */}
              <span className={`rn-state is-${line.state}`}>
                {line.mark !== "—" &&
                  <span className="rn-mark" aria-hidden="true">{line.mark}</span>}
                {line.headline}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function NotificationsScreen({ onOpen }: {
  onOpen: (entry: NotificationInboxEntry) => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    client.askNotifications(false);
  }, []);

  useEffect(() => {
    listRef.current?.focus();
  }, []);

  const problem = world.notificationsProblem;
  const unread = world.notifications.filter(entry => entry.state === "unread").length;
  const loading = !world.notificationsAsked || world.notificationsLoading;

  return (
    <div className="notifications" data-testid="notification-inbox">
      <header className="topbar">
        <h2>Notifications</h2>
        <span className="sub">Mentions and thread replies that belong to you</span>
        <div className="grow" />
        <span className="eyebrow" aria-live="polite">{unread} unread</span>
      </header>
      <div className="notifications-body" ref={listRef} tabIndex={-1}
        aria-live="polite" aria-label="Mentions and thread replies">
        {!world.connected && <Problem tone="notice" text="Cloud9 is reconnecting. Notifications will return when the relay answers." />}
        {problem && <Problem tone="notice" text={problem} />}
        {loading && world.connected && <div className="notification-loading" role="status">Loading notifications…</div>}
        {!loading && !problem && world.connected && world.notifications.length === 0 && (
          <EmptyTray title="Nothing needs your attention" line="Mentions and replies will stay here until you read or dismiss them." />
        )}
        {!loading && world.notifications.length > 0 && (
          <div className="notification-list">
            {world.notifications.map(entry => (
              <article key={entry.id} className={`notification-row is-${entry.state} source-${entry.sourceState}`}>
                <button className="notification-main" type="button"
                  disabled={entry.sourceState !== "active"}
                  aria-label={entry.sourceState === "active" ? `Open ${entry.title}` : `${entry.title}: source unavailable`}
                  onClick={() => onOpen(entry)}>
                  <span className="notification-copy">
                    <strong>{entry.title}</strong>
                    <span>{entry.body}</span>
                    <small>{clock(entry.createdAt)} · {entry.sourceState === "active" ? "Open source" : entry.sourceState === "deleted" ? "Source deleted" : "Source unavailable"}</small>
                  </span>
                  {entry.state === "unread" && <span className="notification-dot" aria-label="Unread" />}
                </button>
                <div className="notification-actions">
                  {entry.state === "unread" && <button type="button" className="linkish" onClick={() => client.markNotificationRead(entry.id)}>Mark read</button>}
                  {entry.state !== "dismissed" && <button type="button" className="linkish" onClick={() => client.dismissNotification(entry.id)}>Dismiss</button>}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ActivityScreen(): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [showAgents, setShowAgents] = useState(true);
  const [showPeople, setShowPeople] = useState(true);

  /* THE TRAIL USED TO FREEZE THE MOMENT IT WAS OPENED.
     The hub only ever sends the trail when it is ASKED for it — there is one
     `activity` frame in the whole hub and it is a reply, never a push. So the
     list below was a photograph taken when the Log button was pressed: he could
     watch an agent work in a room, come here, and see nothing about it.
     Re-asking while this screen is open is the honest fix and costs one small
     frame every few seconds, only while he is actually looking at it. */
  useEffect(() => {
    const again = () => client.send({ type: "activity", limit: 100 });
    const timer = setInterval(again, ACTIVITY_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const rows = [...world.activity].reverse().filter(r =>
    r.actorKind === "agent" ? showAgents : showPeople);

  const days: { label: string; rows: typeof rows }[] = [];
  for (const r of rows) {
    const label = dayLabel(r.ts);
    const last = days[days.length - 1];
    if (last && last.label === label) last.rows.push(r);
    else days.push({ label, rows: [r] });
  }

  return (
    <div className="activity">
      <header className="topbar">
        <h2>Activity</h2>
        <span className="sub">What your agents are doing now, and everything they did before</span>
        <div className="grow" />
        <div className="filters">
          <button className="chip is-pine" aria-pressed={showAgents}
            onClick={() => setShowAgents(v => !v)}>Agents</button>
          <button className="chip is-ultra" aria-pressed={showPeople}
            onClick={() => setShowPeople(v => !v)}>People</button>
        </div>
      </header>

      <div className="act-body">
        <RightNowBoard />

        <div className="act-day"><span className="eyebrow">Before now</span></div>
        {rows.length === 0 && (
          <EmptyTray title="Nothing has happened yet"
            line="Every message, job and go-ahead shows up here, newest first." />
        )}
        {days.map(day => (
          <React.Fragment key={day.label}>
            <div className="act-day"><span className="eyebrow">{day.label}</span></div>
            <div className="timeline">
              {day.rows.map(r => (
                <div key={r.id} className={`actrow ${r.actorKind === "agent" ? "by-agent" : "by-human"}`}>
                  <span className="actwho">
                    {r.actorKind === "agent"
                      ? <AgentFace name={r.actorName} size={28} />
                      : <PersonFace name={r.actorName} size={28} />}
                  </span>
                  <span className="actdetail"><b>{r.actorName}</b>{r.detail}</span>
                  <span className="actwhen">{clock(r.ts)}</span>
                </div>
              ))}
            </div>
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}
