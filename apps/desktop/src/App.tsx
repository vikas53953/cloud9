import React, {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from "react";
import {
  AgentAbilities, AgentApprovals, AgentDef, AgentRespondTo, AgentSkill, AgentSkillFile,
  Approval, Attachment, ATTACHMENT_LIMITS,
  Channel, ChannelMember, ChannelRole, DEMO_MODE_BANNER, downloadContentType,
  HarnessInfo, ID, isInlineViewable, isSafeSkillFileName, mayAdministerChannel, mayDriveAgent,
  MENU_ACTIONS, MenuAction, Message, RunListEntry, RunRecord, RunStep, RunStepKind,
  SearchHit, SKILL_LIMITS, summarizeRun, Task, User, humanDuration, humanMoney,
} from "@cloud9/shared";
import { client, UNREAD_CEILING, unreadLabel, World } from "./store.js";
import { Markdown } from "./markdown.js";
import {
  abilitiesOn, abilityWords, MARKET_CATEGORIES, MARKET_TEMPLATES, MarketTemplate,
} from "./market.js";

const isQuickWindow = location.hash === "#quick";

/* ============================================================
   CONTRACT SHAPES (docs/plans/feedback-round-1.md)
   Skills come from `@cloud9/shared` — the SAME type the relay stores and the
   engine reads, so if a field exists on the agent, this editor carries it.
   ============================================================ */

type AgentDefPlus = AgentDef;

type Provider = "claude" | "codex";

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex" };

/** Friendly names for the model ids in the contract. Unknown ids show as-is. */
const MODEL_LABEL: Record<string, string> = {
  "claude-fable-5": "Fable 5",
  "claude-opus-5": "Opus 5",
  "claude-sonnet-5": "Sonnet 5",
  "claude-haiku-4-5-20251001": "Haiku 4.5",
};

/** Used only until the engine sends a real list for a harness. */
const MODEL_FALLBACK: Record<Provider, string[]> = {
  claude: ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
  codex: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4", "gpt-5.4-mini"],
};
const MODEL_DEFAULT: Record<Provider, string> = {
  claude: "claude-sonnet-5",
  codex: "gpt-5.6-sol",
};

const modelLabel = (id?: string): string => (id ? MODEL_LABEL[id] ?? id : "—");

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

const plainError = (text?: string): string | undefined => {
  if (!text) return undefined;
  return PLAIN_ERROR[text] ?? text.replace(/^Error:\s*/i, "");
};

/* ================= small formatters ================= */

const initials = (name: string): string =>
  name.trim().split(/[\s._-]+/).slice(0, 2).map(p => p[0] ?? "").join("").toUpperCase() || "?";

const clock = (ts: number): string =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

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
const IconLog = (): React.JSX.Element => (
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12.5h4l2.2-6 3.4 12 2.5-7.5 1.6 3.5H21" /></svg>
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

function AgentFace({ name, size, lamp }: { name: string; size: number; lamp?: string }): React.JSX.Element {
  const state = lampToPlate(lamp ?? "live");
  return (
    <span className="avatar">
      <Portrait identity={name} size={size} working={state === "working"} />
      <span className={`status st-${state}`} />
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

function inQuietHours(p: Prefs, now = new Date()): boolean {
  if (!p.quietOn) return false;
  const mins = (s: string) => {
    const [h, m] = s.split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
  };
  const t = now.getHours() * 60 + now.getMinutes();
  const from = mins(p.quietFrom), to = mins(p.quietTo);
  return from <= to ? t >= from && t < to : t >= from || t < to;
}

/**
 * One row per person. The relay can hand back the same person more than once
 * (his 15); the app shows each of them exactly once, everywhere.
 */
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
        <div className="notice refused hubsay" role="alert">{text}</div>
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

  return <>{screen}{!onJoinScreen && <Toast />}</>;
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
    client.setToken(mode === "owner" ? token : ""); // invite issues a durable token via relay
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
            {refusal && (
              <div className="notice refused joinerror" role="alert">
                <span className="refused-mark" aria-hidden="true">!</span>
                <span>{refusal}</span>
              </div>
            )}
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

type ScreenName = "chat" | "crew" | "market" | "editor" | "tasks" | "activity" | "settings";
type ModalName = "invite" | "channel" | "browse";

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
        : `${ownerName} and ${n} ${n === 1 ? "other person" : "others"} can use it`;
    }
    default: return `Only ${ownerName} can use it`;
  }
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
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const p = usePrefs();
  const [screen, setScreen] = useState<ScreenName>("chat");
  const [activeId, setActiveId] = useState<ID | null>(null);
  const [modal, setModal] = useState<null | ModalName>(null);
  /** null = not editing. "new" = hiring. An agent = editing that one. */
  const [editorFor, setEditorFor] = useState<AgentDef | "new" | null>(null);
  /** the @name of the role just hired from the hiring hall, so the crew says so */
  const [justHired, setJustHired] = useState<string | null>(null);
  const [quick, setQuick] = useState(false);
  const [pendingPeer, setPendingPeer] = useState<{ id: ID; since: number } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  /** a message the app is on its way to, from a search result */
  const [jumpTo, setJumpTo] = useState<{ id: ID; at: number } | null>(null);

  const active = world.channels.find(c => c.id === activeId) ?? world.channels[0];
  const owner = isOwner(world.me);
  const openInvite = useCallback(() => {
    client.send({ type: "createInvite" });
    setModal("invite");
  }, []);
  const pendingApprovals = world.approvals.filter(
    a => a.status === "pending" && a.ownerId === world.me?.id,
  ).length;

  const openEditor = useCallback((a: AgentDef | "new") => {
    setEditorFor(a);
    setScreen("editor");
  }, []);
  const openActivity = useCallback(() => {
    client.send({ type: "activity", limit: 100 });
    setScreen("activity");
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
        setScreen("chat");
        setFindOpen(true);
      }
      if (e.key === "Escape") setQuick(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    "settings": () => setScreen("settings"),
    // Search looks EVERYWHERE you are allowed to see. Finding words in the one
    // conversation on screen is a different job and keeps its own bar (Ctrl+F).
    "search": () => { setScreen("chat"); setSearchOpen(true); },
    "toggle-theme": () => {
      const now = document.documentElement.getAttribute("data-theme");
      prefs.set({ theme: now === "dark" ? "light" : "dark" });
    },
    "activity": openActivity,
    "tasks": () => setScreen("tasks"),
    "quick-chat": () => setQuick(true),
  }), [owner, openInvite, openActivity, openEditor]);

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
      seen: () => client.framesSeen(),
      ask: (frame: Parameters<typeof client.send>[0]) => client.send(frame),
      search: (q: string) => client.search(q),
      clearSearch: () => client.clearSearch(),
      searching: () => client.world.search ?? null,
      /* The conversations this screen knows, by name. The suite needs an id to
         seed a conversation long enough to prove the scroll rules against; the
         alternative was typing a hundred and sixty messages one key at a time. */
      channels: () => client.world.channels.map(c => ({ id: c.id, name: c.name })),
      /* The very function the unread badge calls. A conversation with more
         than a thousand unread messages cannot be built in a QA run, so the
         RULE is checked here and the badge is checked on screen; between them
         nothing prints a capped number as though it were exact. */
      unreadSays: (n: number) => unreadLabel(n),
      unreadCeiling: () => UNREAD_CEILING,
    };
    // QA hook, same shape again: what the screen is HOLDING about runs, so a
    // missing card can be told apart from a record that never arrived. It
    // reports only ids and outcomes — never the record's words.
    (window as unknown as { cloud9Runs?: unknown }).cloud9Runs = {
      held: () => Object.entries(client.world.runs)
        .map(([id, r]) => ({ id, outcome: r.outcome, taskId: r.taskId ?? null, steps: r.steps.length })),
      jobs: () => client.world.tasks
        .map(t => ({ id: t.id, status: t.status, runId: t.runId ?? null })),
    };
    return () => {
      delete (window as unknown as { cloud9Wire?: unknown }).cloud9Wire;
      delete (window as unknown as { cloud9Runs?: unknown }).cloud9Runs;
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
    setScreen("chat");
    const existing = findDm(peerId);
    if (existing) { setActiveId(existing.id); setPendingPeer(null); return; }
    setPendingPeer({ id: peerId, since: Date.now() });
    client.send({ type: "createChannel", name: `dm-${slug(peerName)}`, memberIds: [peerId], kind: "dm" });
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
  const unreadFor = useCallback((c: Channel): { unread: number; mentions: number } => {
    const entry = world.unread[c.id];
    const seen = entry?.lastReadTs ?? 0;
    const msgs = world.messages[c.id] ?? [];
    const mine = world.me?.id;
    const myAgentIds = world.agents.filter(a => a.ownerId === mine).map(a => a.id);
    const fresh = msgs.filter(m => m.ts > seen && m.authorId !== mine);
    const mentionsMe = (m: Message) =>
      (m.mentions ?? []).some(id => id === mine || myAgentIds.includes(id));
    return {
      unread: Math.max(fresh.length, entry?.unread ?? 0),
      mentions: Math.max(fresh.filter(mentionsMe).length, entry?.mentions ?? 0),
    };
  }, [world.unread, world.messages, world.me, world.agents]);

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

  /* ---- notifications you asked for, silent in quiet hours ---- */
  const knownCount = useRef<number>(-1);
  useEffect(() => {
    const all = Object.values(world.messages).reduce((n, m) => n + m.length, 0);
    const previous = knownCount.current;
    knownCount.current = all;
    if (previous < 0 || all <= previous) return;
    if (!p.notify || inQuietHours(p)) return;
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    const newest = Object.values(world.messages).flat().sort((a, b) => b.ts - a.ts)[0];
    if (!newest || newest.authorId === world.me?.id) return;
    if (!document.hidden && newest.channelId === active?.id) return;
    try {
      new Notification(`${newest.authorName} in Cloud9`, { body: newest.text.slice(0, 140) });
    } catch { /* the system said no — nothing to do */ }
  }, [world.messages, p, world.me, active]);

  const channels = world.channels.filter(c => c.kind === "channel");
  const agents = world.agents as AgentDefPlus[];
  /* Direct conversations with PEOPLE only: every agent already has its own row
     below, so listing its DM too would show the same agent twice — and the
     count of rows named after it would change every time one was opened. */
  const humanDms = world.channels.filter(c =>
    c.kind === "dm" && !c.memberIds.some(id => world.agents.some(a => a.id === id)));

  const peerOf = (c: Channel) => {
    const id = c.memberIds.find(i => i !== world.me?.id);
    const user = world.users.find(u => u.id === id);
    const agent = world.agents.find(a => a.id === id);
    const status = agent ? agentStatusLine(agent, world.agentStatus[agent.id]) : null;
    return {
      name: user?.name ?? agent?.name ?? c.name,
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
      onClick={onClick ?? (() => setScreen(go))}>
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
          {railBtn("activity", "Log", <IconLog />, undefined, openActivity)}
          <div className="rail-spacer" />
          <button className="rail-btn" title="Quick chat (Ctrl K)" onClick={() => setQuick(true)}>
            <IconBolt />Ctrl K
          </button>
          {railBtn("settings", "Setup", <IconGear />)}
          <span className={`rail-lamp ${world.connected ? "ok" : ""}`}
            title={world.connected ? `On the floor as ${world.me?.name ?? "you"}` : "Reconnecting…"} />
        </nav>

        <main className="stage">
          {screen === "chat" && (
            <ChatScreen
              active={active} setActiveId={id => setActiveId(id)}
              channels={channels} humanDms={humanDms} agents={agents} people={people}
              unreadFor={unreadFor} peerOf={peerOf} owner={owner}
              onNewChannel={() => setModal("channel")} onBrowseRooms={() => setModal("browse")}
              onNewAgent={() => openEditor("new")} onBrowseMarket={() => setScreen("market")}
              onInvite={openInvite} onEditAgent={a => openEditor(a)} onOpenDm={openDm}
              lastRead={active ? world.unread[active.id]?.lastReadTs ?? 0 : 0}
              findOpen={findOpen} onCloseFind={() => setFindOpen(false)}
              onOpenTasks={() => setScreen("tasks")}
              jumpTo={jumpTo} onJumped={() => setJumpTo(null)}
            />
          )}
          {screen === "crew" && (
            <CrewScreen onHire={() => openEditor("new")} onEdit={a => openEditor(a)} onOpen={openDm}
              onMarket={() => setScreen("market")} justHired={justHired} />
          )}
          {screen === "market" && (
            <MarketScreen
              onBack={() => setScreen("crew")}
              onWriteMyOwn={() => openEditor("new")}
              /* Hiring lands him where the new agent is: on the floor, with an
                 Edit button on it. Nothing about it is locked. */
              onHired={name => { setJustHired(name); setScreen("crew"); }}
            />
          )}
          {screen === "editor" && (
            <AgentEditor
              agent={editorFor === "new" || editorFor === null ? null : editorFor}
              onDone={() => { setEditorFor(null); setScreen("crew"); }}
              onMarket={() => { setEditorFor(null); setScreen("market"); }}
            />
          )}
          {screen === "tasks" && <TasksScreen onOpenChannel={id => { setActiveId(id); setScreen("chat"); }} />}
          {screen === "activity" && <ActivityScreen />}
          {screen === "settings" && <SettingsScreen />}
        </main>
      </div>

      {searchOpen && (
        <SearchOverlay
          onClose={() => { setSearchOpen(false); client.clearSearch(); }}
          onGo={(channelId, messageId) => {
            setScreen("chat");
            setActiveId(channelId);
            setJumpTo({ id: messageId, at: Date.now() });
            setSearchOpen(false);
            client.clearSearch();
          }}
        />
      )}
      {quick && <QuickChat onClose={() => setQuick(false)} />}
      {modal === "invite" && <InviteModal onClose={() => setModal(null)} />}
      {modal === "channel" && <ChannelModal onClose={() => setModal(null)} />}
      {modal === "browse" && (
        <BrowseRoomsModal onClose={() => setModal(null)}
          onJoined={id => { setScreen("chat"); setActiveId(id); setModal(null); }} />
      )}
    </div>
  );
}

/** When the relay refuses something, say so — a save must never fail in silence. */
function Toast(): React.JSX.Element | null {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const err = world.lastError;
  const [dismissed, setDismissed] = useState(0);
  useEffect(() => {
    if (!err) return;
    const t = setTimeout(() => setDismissed(err.ts), 7000);
    return () => clearTimeout(t);
  }, [err?.ts]);
  if (!err || dismissed === err.ts) return null;
  return (
    <div className="toast" role="status">
      <span className="toast-mark" aria-hidden="true">!</span>
      <span className="toast-text">{plainError(err.text)}</span>
      <button className="toast-x" aria-label="Dismiss" onClick={() => setDismissed(err.ts)}>✕</button>
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
interface Unread { unread: number; mentions: number }

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
      {n.unread > 0 && (
        <span className="cnt hot" data-capped={capped(n.unread) || undefined}
          title={say(n.unread, "new")}
          aria-label={say(n.unread, "new")}>{unreadLabel(n.unread)}</span>
      )}
    </>
  );
}

function ChatScreen({
  active, setActiveId, channels, humanDms, agents, people, unreadFor, peerOf, owner,
  onNewChannel, onBrowseRooms, onNewAgent, onBrowseMarket, onInvite, onEditAgent, onOpenDm,
  lastRead, findOpen, onCloseFind,
  onOpenTasks, jumpTo, onJumped,
}: {
  active?: Channel; setActiveId: (id: ID) => void;
  channels: Channel[]; humanDms: Channel[]; agents: AgentDefPlus[]; people: User[];
  unreadFor: (c: Channel) => Unread; peerOf: (c: Channel) => Peer; owner: boolean;
  onNewChannel: () => void; onBrowseRooms: () => void; onNewAgent: () => void;
  onBrowseMarket: () => void; onInvite: () => void;
  onEditAgent: (a: AgentDef) => void; onOpenDm: (id: ID, name: string) => void;
  lastRead: number; findOpen: boolean; onCloseFind: () => void; onOpenTasks: () => void;
  jumpTo: { id: ID; at: number } | null; onJumped: () => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const isDm = active?.kind === "dm";
  /** the message whose thread is open on the right, if any */
  const [threadRoot, setThreadRoot] = useState<ID | null>(null);
  /** the room-details panel, which shares the right-hand slot with a thread */
  const [detailsOpen, setDetailsOpen] = useState(false);
  /* THREADS OR NOT — his setting, read in the one place that opens them. */
  const threading = usePrefs().replies !== "inline";

  // a thread — and a details panel — belong to the conversation they were
  // opened from, and go when it changes
  useEffect(() => { setThreadRoot(null); setDetailsOpen(false); }, [active?.id]);

  /* Switching to "keep it in the conversation" closes whatever thread was
     open. Leaving a panel behind that the setting says cannot exist is how a
     setting ends up being only a change of wording. */
  useEffect(() => { if (!threading) setThreadRoot(null); }, [threading]);

  const openThread = useCallback((rootId: ID) => {
    setThreadRoot(rootId);
    setDetailsOpen(false);
    client.send({ type: "thread", messageId: rootId });
  }, []);

  const toggleDetails = useCallback(() => {
    setDetailsOpen(o => !o);
    setThreadRoot(null);
  }, []);

  const agentDmFor = (a: AgentDef) =>
    world.channels.find(c => c.kind === "dm" && c.memberIds.includes(a.id));

  return (
    <div className={`chatgrid${isDm && !threadRoot && !detailsOpen ? " no-aside" : ""}`}>
      <aside className="sidebar" aria-label="Studio floor">
        <div className="sidebar-head">
          <h2>Studio floor</h2>
          {/* The relay does not report who is at their desk, so this counts who
              is IN this Cloud9 — never "online", which we cannot know. */}
          <span className="chip"
            title={`${agents.length} ${agents.length === 1 ? "agent" : "agents"} and ` +
              `${people.length} ${people.length === 1 ? "person" : "people"} in this Cloud9`}>
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
                  is where the hiring hall has to be. */}
              <button className="browsebtn tomarket" title="Browse the hiring hall"
                aria-label="Browse the hiring hall" onClick={onBrowseMarket}>⌕</button>
              <button title="New agent" aria-label="New agent" onClick={onNewAgent}>＋</button>
            </div>
            {agents.length === 0 && humanDms.length === 0 &&
              <RailEmpty text="Nobody hired yet." action="Browse the hiring hall" onAction={onBrowseMarket} />}
            {agents.map(a => {
              const s = agentStatusLine(a, world.agentStatus[a.id]);
              const dm = agentDmFor(a);
              const unread = dm ? unreadFor(dm) : { unread: 0, mentions: 0 };
              return (
                <div key={a.id} className="side-item agentrow agent-row" data-agent={a.name}
                  aria-current={dm && active?.id === dm.id ? "true" : "false"} title={a.persona}>
                  <button className="agentmain" onClick={() => onOpenDm(a.id, a.name)}
                    title={`Open your chat with ${a.name}`}>
                    <AgentFace name={a.name} size={22} lamp={s.lamp} />
                    <span className="txt agent-name">{a.name}</span>
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
          onToggleDetails={toggleDetails} detailsOpen={detailsOpen} />
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

      {active && threading && threadRoot && (
        <ThreadPanel key={threadRoot} channel={active} rootId={threadRoot}
          onClose={() => setThreadRoot(null)} />
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
function RunSteps({ record }: { record: RunRecord }): React.JSX.Element {
  const [showQuiet, setShowQuiet] = useState(false);
  const isQuiet = (s: RunStep): boolean => s.kind === "thinking" || s.kind === "message";
  const quiet = record.steps.filter(isQuiet);
  // already in `seq` order, and a filter keeps it that way
  const shown = showQuiet ? record.steps : record.steps.filter(s => !isQuiet(s));
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
      {record.truncated && (
        <p className="runtrunc">Some steps were left out to keep this small.</p>
      )}
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
  if (record.error) rows.push(["went-wrong", "What went wrong", record.error]);

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
          What it did<span className="n">{record.steps.length} {record.steps.length === 1 ? "step" : "steps"}</span>
        </button>
      )}
      {open && record.steps.length > 0 && <RunSteps record={record} />}
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
  useEffect(() => { client.askRuns("agent", agentId, 10); }, [agentId]);

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

function ChatView({
  channel, lastRead, findOpen, onCloseFind, onEditAgent, onOpenTasks,
  jumpTo, onJumped, onOpenThread, threadRoot, onToggleDetails, detailsOpen,
}: {
  channel: Channel; lastRead: number; findOpen: boolean; onCloseFind: () => void;
  onEditAgent: (a: AgentDef) => void; onOpenTasks: () => void;
  jumpTo: { id: ID; at: number } | null; onJumped: () => void;
  /** absent when his setting says replies stay in the conversation */
  onOpenThread?: (rootId: ID) => void; threadRoot: ID | null;
  onToggleDetails: () => void; detailsOpen: boolean;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const all = world.messages[channel.id] ?? [];
  const threading = !!onOpenThread;
  /** the message this conversation's own box is answering, in inline mode */
  const [replyingTo, setReplyingTo] = useState<ID | null>(null);
  useEffect(() => { setReplyingTo(null); }, [channel.id]);
  useEffect(() => { if (threading) setReplyingTo(null); }, [threading]);
  const streamRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [openedAt] = useState(lastRead);
  const page = world.pages[channel.id] ?? { hasMore: true, loading: false, asked: false };
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
  const shown = (threading && !needle)
    ? all.filter(m => !m.replyTo || m.id === jumpTo?.id || m.id === litUp)
    : all;
  const messages = needle
    ? all.filter(m => m.text.toLowerCase().includes(needle) || m.authorName.toLowerCase().includes(needle))
    : shown;

  /* ---- scrollback ----
   *
   * Three rules, and they must not fight each other:
   *  1. a NEW message at the bottom follows the reader down, but only if the
   *     reader was already down there;
   *  2. an OLDER page put on the front must not move the words under the
   *     reader's eyes — the view is nailed to what it was looking at;
   *  3. reaching the top asks for the page before, and stops when the relay
   *     says there is nothing older. */
  const atBottom = useRef(true);
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
   */
  const newest = messages.length ? messages[messages.length - 1].id : "";
  React.useLayoutEffect(() => {
    const el = streamRef.current;
    if (!el) return;
    // 1. an older page went on the front: nail the view to the row the reader
    //    was actually looking at, whatever else is going on.
    const held = anchor.current;
    if (held) {
      const still = el.querySelector<HTMLElement>(`.msg[data-msg="${CSS.escape(held.id)}"]`);
      if (still) el.scrollTop += still.getBoundingClientRect().top - held.top;
      anchor.current = null;
      return;
    }
    // 2. somebody asked to be taken to one particular message. That walk owns
    //    the view until it lands — following the newest message would be
    //    yanking the reader away from the thing they asked for.
    if (jumpTo) return;
    // 3. otherwise a new arrival follows a reader who is already at the bottom.
    if (atBottom.current) el.scrollTo({ top: el.scrollHeight });
  }, [world.prepended, newest, messages.length, jumpTo]);

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
  }, []);

  const onStreamScroll = useCallback(() => {
    const el = streamRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 160) askForOlder();
  }, [askForOlder]);

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
  }, [jumpTo, messages.length, page.loading, page.hasMore, channel.id, askForOlder, onJumped]);

  const people = onePerPerson(
    channel.memberIds.map(id => world.users.find(u => u.id === id)).filter(Boolean) as User[]);
  const agents = channel.memberIds.map(id => world.agents.find(a => a.id === id)).filter(Boolean) as AgentDef[];

  const isDm = channel.kind === "dm";
  const peerUser = people.find(u => u.id !== world.me?.id);
  const peerAgent = world.agents.find(a => channel.memberIds.includes(a.id));
  const peerName = isDm ? peerUser?.name ?? peerAgent?.name ?? channel.name : null;

  let markedUnread = false;
  const rows: Row[] = messages.map((m, i) => {
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

  const working = agents.filter(a => world.agentStatus[a.id] === "working");

  const myApprovals = world.approvals.filter(ap => {
    if (ap.status !== "pending" || ap.ownerId !== world.me?.id) return false;
    const task = world.tasks.find(t => t.id === ap.taskId);
    return task?.channelId === channel.id;
  });

  const dmAgentStatus = peerAgent ? agentStatusLine(peerAgent, world.agentStatus[peerAgent.id]) : null;

  return (
    <div className="thread">
      {isDm ? (
        <header className="topbar dm-head chathead">
          {peerAgent
            ? <AgentFace name={peerAgent.name} size={48} lamp={dmAgentStatus?.lamp} />
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
          {peerAgent && dmAgentStatus && (
            <span className={`chip ${dmAgentStatus.busy ? "is-pine" : ""}`}>
              <span className={`dot ${dmAgentStatus.busy ? "live" : "off"}`} />
              {dmAgentStatus.busy ? "Working" : dmAgentStatus.lamp === "off" ? "Off duty" : "Free"}
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
            {people.length} {people.length === 1 ? "person" : "people"} ·{" "}
            {agents.length} {agents.length === 1 ? "agent" : "agents"}
          </span>
          {/* Open or shut, said where the room is named. A room that anyone in
              this Cloud9 can find and let themselves into is a different thing
              from one you were put in, and that must never be a guess. */}
          <RoomVisibility channel={channel} />
          {channel.topic && (
            <span className="ch-topic" title={`Topic: ${channel.topic}`}>{channel.topic}</span>
          )}
          <div className="grow" />
          {myApprovals.length > 0 && (
            <button className="chip is-gold approvalpill" onClick={onOpenTasks}>
              <span className="dot wait" />
              {myApprovals.length} approval{myApprovals.length === 1 ? "" : "s"} waiting
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
              ? `${messages.length} ${messages.length === 1 ? "message" : "messages"}`
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
              and add <code>!bg</code> when it should work in the background.</p>
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
            <MessageRow row={r} agent={world.agents.find(a => a.id === r.m.authorId)}
              working={world.agentStatus[r.m.authorId] === "working"}
              /* Reading an archived room still works all the way down: the
                 replies are still there to open, only writing is refused. */
              onOpenThread={onOpenThread}
              /* Inline mode: the reply button arms THIS conversation's box
                 instead of opening a panel that the setting says cannot exist. */
              onInlineReply={threading ? undefined : (id: ID) => setReplyingTo(id)}
              onGoToMessage={goToMessage}
              archived={!!channel.archivedAt}
              inOpenThread={threadRoot === r.m.id || threadRoot === r.m.replyTo}
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
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* In inline mode the conversation's own box is what carries a reply, so
          it says which message it is answering and offers a way out of it. */}
      <Composer channel={channel}
        replyTo={!threading && replyingTo ? replyingTo : undefined}
        answering={!threading && replyingTo
          ? all.find(m => m.id === replyingTo)
          : undefined}
        onStopAnswering={() => setReplyingTo(null)} />
    </div>
  );
}

/** The moment an agent stops and asks — the prototype's permission card. */
function ApprovalMoment({ approval, agent, task, onOpenTasks }: {
  approval: Approval; agent?: AgentDef; task?: Task; onOpenTasks: () => void;
}): React.JSX.Element {
  const rows: [string, string][] = [];
  if (agent) {
    rows.push(["Agent", `${agent.name} · ${PROVIDER_LABEL[(agent.provider ?? "claude") as Provider]} · ${modelWords(agent.model)}`]);
  }
  const rule = ruleWords(agent);
  if (rule) rows.push(["Rule hit", rule]);
  rows.push(["Asked", clock(approval.createdAt)]);
  /* The prototype sets a money amount huge, in the display serif. Cloud9 holds
     no amounts — nothing here spends — so the same slot carries the one thing
     it does hold: what the agent is asking to do. Nothing is invented to fill
     the shape. */
  const headline = task?.title ?? approval.action;

  return (
    <div className="msg from-agent" data-approval={approval.id}>
      {agent ? <AgentFace name={agent.name} size={34} lamp="wait" /> : <PersonFace name="?" size={34} />}
      <div className="body">
        <div className="who">
          <b>{agent?.name ?? "An agent"}</b>
          <span className="badge">Agent</span>
          <span className="t">{clock(approval.createdAt)}</span>
          <span className="chip is-gold"><span className="dot wait" />Waiting on you</span>
        </div>
        <p>I've stopped before doing this — it needs your go-ahead.</p>
        <AnswerCard
          tone="approval"
          title="Permission to act"
          rows={rows}
          lead={
            <div className="spend">
              <span className="amt">{headline}</span>
              <span className="per">nothing runs until you say so</span>
            </div>
          }
          actions={<>
            <button className="gold"
              onClick={() => client.send({ type: "decideApproval", approvalId: approval.id, decision: "approved" })}>
              Approve
            </button>
            <button className="btn danger"
              onClick={() => client.send({ type: "decideApproval", approvalId: approval.id, decision: "rejected" })}>
              Reject
            </button>
            <button className="btn ghost small" onClick={onOpenTasks}>See the job</button>
            <span className="eyebrow">Nothing has been changed yet</span>
          </>}
        />
      </div>
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
                <span>{held.error}</span>
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

function MessageRow({
  row, agent, working, onOpenThread, onInlineReply, onGoToMessage,
  inOpenThread, litUp, variant, archived,
}: {
  row: Row; agent?: AgentDef; working?: boolean;
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
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const { m, cont, ask } = row;
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
  const mine = !!world.me && (isAgent
    ? world.agents.find(a => a.id === m.authorId)?.ownerId === world.me.id
    : m.authorId === world.me.id);

  const nameFor = (id: ID): string =>
    id === world.me?.id ? "You"
      : world.users.find(u => u.id === id)?.name
      ?? world.agents.find(a => a.id === id)?.name
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
    if (isAgent || deleted || !world.me) return [];
    const named = world.agents.filter(a =>
      new RegExp(`@${a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i").test(m.text));
    return named
      .filter(a => !(m.mentions ?? []).includes(a.id) && !mayDriveAgent(m.authorId, a))
      .map(a => ({
        agent: a,
        owner: world.users.find(u => u.id === a.ownerId)?.name ?? "its owner",
      }));
  }, [m.text, m.mentions, m.authorId, world.agents, world.users, isAgent, deleted, world.me]);

  /* Rendered under EVERY shape of a message. A second message from the same
     person a minute later is drawn as a continuation row, and a hint that
     disappeared because you happened to speak twice in a row would be worse
     than no hint at all. */
  const refusedNotes = refusedMentions.map(({ agent: a, owner }) => (
    <div className="mentionrefused" key={a.id} data-agent={a.name}>
      {a.name} only answers {owner}, so it hasn't been asked.
    </div>
  ));

  /**
   * The job this "📦 Task done" message is the result of — or nothing.
   *
   * A message carries no job id, so the only honest link is the RESULT ITSELF:
   * the hub stores a finished job's result, and the agent posts exactly that
   * text under the 📦 line. Matching on the words is exact, not a guess about
   * timing — and if two jobs somehow match, or none does, no card is drawn at
   * all. A run card under the wrong job would be worse than no run card.
   *
   * (A very long result is stored clipped at 2,000 characters, so that one case
   * matches on the stored prefix — still exact about which job it was.)
   */
  const doneRunId = useMemo(() => {
    if (!isAgent || deleted) return undefined;
    const head = /^📦 (?:Background t|T)ask done:\n/.exec(m.text);
    if (!head) return undefined;
    const body = m.text.slice(head[0].length);
    const hits = world.tasks.filter(t =>
      t.channelId === m.channelId && t.agentId === m.authorId && t.runId && t.result
      && (t.result === body || (t.result.length === 2000 && body.startsWith(t.result))));
    return hits.length === 1 ? hits[0].runId : undefined;
  }, [m.text, m.channelId, m.authorId, world.tasks, isAgent, deleted]);

  const reactions = (m.reactions ?? []).filter(r => r.userIds.length > 0);
  const reactionRow = (!deleted && reactions.length > 0) && (
    <div className="reactions">
      {reactions.map(r => {
        const isMine = !!world.me && r.userIds.includes(world.me.id);
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
  const answered = useMemo(() => {
    if (inThread || deleted || !m.replyTo) return undefined;
    return (world.messages[m.channelId] ?? []).find(x => x.id === m.replyTo);
  }, [m.replyTo, m.channelId, world.messages, inThread, deleted]);

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
  const threadLine = (!inThread && !deleted && replyCount > 0 && onOpenThread) && (
    <button className="threadline" data-replies={replyCount}
      onClick={() => onOpenThread(m.id)}>
      <span className="arrow" aria-hidden="true">↳</span>
      {replyCount} {replyCount === 1 ? "reply" : "replies"}
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
            const isMine = !!world.me
              && (m.reactions ?? []).some(r => r.emoji === e && r.userIds.includes(world.me!.id));
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
          {deleted ? tombstone : editing ? editor : paragraph(m.text)}
          {!deleted && doneRunId && <TaskRun runId={doneRunId} />}
          {!deleted && m.attachments && m.attachments.length > 0 &&
            <MessageFiles attachments={m.attachments} />}
          {!deleted && m.editedAt && <span className="editedmark">edited</span>}
          {refusedNotes}
          {reactionRow}
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

  const shape = isAgent ? parseAnswer(m.text) : { lead: [], tail: [], card: undefined };

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
      ? <div className="answer">{paragraph(m.text)}</div>
      : paragraph(m.text);

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
        {!deleted && doneRunId && <TaskRun runId={doneRunId} />}
        {!deleted && m.attachments && m.attachments.length > 0 &&
          <MessageFiles attachments={m.attachments} />}
        {refusedNotes}
        {reactionRow}
        {threadLine}
      </div>
      {actions}
    </article>
  );
}

/* ---- one thread, in the right-hand rail ---- */

function ThreadPanel({ channel, rootId, onClose }: {
  channel: Channel; rootId: ID; onClose: () => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const held = world.threads[rootId];
  // the root may also be on screen in the conversation behind this panel
  const fromChannel = (world.messages[channel.id] ?? []).find(m => m.id === rootId);
  const messages = held ?? (fromChannel ? [fromChannel] : []);
  const root = messages[0];
  const replies = messages.slice(1);

  const rowFor = (m: Message): Row => ({ m, cont: false, dayStart: false, firstUnread: false });

  return (
    <aside className="aside threadpanel" aria-label="Thread">
      <div className="threadhead">
        <span className="eyebrow">Thread</span>
        <div className="grow" />
        <button className="iconbtn threadclose" aria-label="Close the thread" onClick={onClose}>✕</button>
      </div>
      <div className="threadbody">
        {!root && <div className="d-empty">Fetching this thread…</div>}
        {root && (
          <MessageRow row={rowFor(root)} variant="thread" archived={!!channel.archivedAt}
            agent={world.agents.find(a => a.id === root.authorId)} />
        )}
        {root && (
          <div className="threadcount">
            {replies.length === 0
              ? "No replies yet — yours would be the first."
              : `${replies.length} ${replies.length === 1 ? "reply" : "replies"}`}
          </div>
        )}
        {replies.map(m => (
          <MessageRow key={m.id} row={rowFor(m)} variant="thread" archived={!!channel.archivedAt}
            agent={world.agents.find(a => a.id === m.authorId)}
            working={world.agentStatus[m.authorId] === "working"} />
        ))}
      </div>
      <Composer channel={channel} replyTo={rootId} />
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

function Composer({ channel, replyTo, answering, onStopAnswering }: {
  channel: Channel;
  /** set in a thread panel, and in the conversation's own box when threads are
      off and he has pressed Reply: everything typed here answers that message */
  replyTo?: ID;
  /** inline mode only — the message being answered, so the box can say so */
  answering?: Message;
  onStopAnswering?: () => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [text, setText] = useState("");
  const [acIndex, setAcIndex] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
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

  const mentionQuery = useMemo(() => {
    const m = /(?:^|\s)@([\w-]*)$/.exec(text);
    return m ? m[1].toLowerCase() : null;
  }, [text]);

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
    client.send({
      type: "send", channelId: channel.id, text: t, replyTo,
      ...(ready.ids.length ? { attachmentIds: ready.ids } : {}),
    });
    setText("");
    setEmojiOpen(false);
    client.clearUploads(channel.id);
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
      ? `Message ${peerName}`
      : `Message #${channel.name} — type @ to call an agent in`;

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
    <div className={`composer${inThreadPanel ? " threadcomposer" : ""}`}>
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
      <div className="composer-box" title={`Posting as ${world.me?.name ?? "you"}`}>
        {suggestions.length > 0 && (
          <div className="autocomplete">
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
                        : u.error}
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
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendNow(); }
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
              for (const f of Array.from(e.target.files ?? [])) client.attach(channel.id, f);
              e.target.value = "";
            }} />
          <button className="mini attach" title={`Attach a file (up to ${ATTACHMENT_LIMITS.perMessage}, ${Math.floor(ATTACHMENT_LIMITS.bytes / 1_000_000)} MB each)`}
            onClick={() => fileRef.current?.click()}>📎 Attach</button>
          <button className="mini" title="Call an agent by name" onClick={() => insert("@")}>@ agent</button>
          {/* A thread is a narrow column and a reply is a sentence, so the
              wide affordances stay in the room's own box rather than being
              squeezed into a rail they do not fit. */}
          {!inThreadPanel && <>
            <button className="mini" title="Hand this over as background work"
              onClick={() => insert("!bg ")}>Delegate as a job</button>
            <button className="mini" title="Bold" onClick={() => wrap("**")}><b>B</b></button>
            <button className="mini ital" title="Italic" onClick={() => wrap("_")}>I</button>
            <button className="mini" title="Code" onClick={() => wrap("`")}>{"</>"}</button>
          </>}
          <button className="mini" title="Emoji" aria-expanded={emojiOpen}
            onClick={() => setEmojiOpen(o => !o)}>🙂</button>
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
              : `Send${ready > 0 ? ` with ${ready} ${ready === 1 ? "file" : "files"}` : ""}`}
          </button>
          {emojiOpen && (
            <div className="emojipop">
              {QUICK_EMOJI.map(e => (
                <button key={e} onClick={() => { insert(e); setEmojiOpen(false); }}>{e}</button>
              ))}
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

  /* Absent means "leave alone", "" means "clear it" — the same rule skill files
     follow. So only the field that actually changed is ever sent. */
  const saveInfo = () => {
    const patch: { description?: string; topic?: string } = {};
    if (description !== (channel.description ?? "")) patch.description = description;
    if (topic !== (channel.topic ?? "")) patch.topic = topic;
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
                  onChange={e => setTopic(e.target.value.replace(/[\r\n]/g, " "))} />
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
  const running = tasks.filter(t => ["working", "not_started", "waiting_approval", "waiting_user", "blocked"].includes(t.status));
  const shownJobs = running.length > 0 ? running : tasks.slice(0, 4);

  return (
    <aside className="aside" aria-label="Channel details">
      <div className="aside-sec">
        <span className="eyebrow">In this channel</span>
        {agents.length === 0 && people.length === 0 &&
          <div className="d-empty">Nobody in this room yet. Use “Add agent” above to bring someone in.</div>}
        {agents.map(a => {
          const s = agentStatusLine(a, world.agentStatus[a.id]);
          const provider = (a.provider ?? "claude") as Provider;
          return (
            <div className="mini-agent" key={a.id} data-agent={a.name}>
              <AgentFace name={a.name} size={36} lamp={s.lamp} />
              <span style={{ minWidth: 0 }}>
                <span className="nm">{a.name}</span>
                <span className="rl two-lines" title={a.persona}>
                  {PROVIDER_LABEL[provider]} · {s.busy ? "Working now" : roleOf(a.persona)}
                </span>
                {/* who is in this room BECAUSE this agent is */}
                <AgentOwnerTag agent={a} />
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
        <span className="eyebrow">{running.length > 0 ? "Running now" : "Jobs from this channel"}</span>
        {shownJobs.length === 0 && (
          <div className="d-empty">Nothing handed over yet. Ask an agent with <code>@name !bg</code>.</div>
        )}
        {shownJobs.map(t => {
          const agent = world.agents.find(a => a.id === t.agentId);
          return (
            <div className="job" key={t.id}>
              <b>{t.title}</b>
              {agent?.name ?? "An agent"} · {STATUS_LABEL[t.status] ?? t.status} · started {clock(t.createdAt)}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/* ================= 4 · THE CREW (call sheet) ================= */

function CrewScreen({ onHire, onEdit, onOpen, onMarket, justHired }: {
  onHire: () => void;
  onEdit: (a: AgentDef) => void;
  onOpen: (id: ID, name: string) => void;
  onMarket: () => void;
  /** just hired from the hiring hall — say so, and say it is editable */
  justHired?: string | null;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [filter, setFilter] = useState<"all" | "working" | "waiting" | "off">("all");
  const agents = world.agents as AgentDefPlus[];

  const waitingOn = (id: ID) =>
    world.approvals.some(a => a.status === "pending" && a.agentId === id && a.ownerId === world.me?.id);

  const workingCount = agents.filter(a => world.agentStatus[a.id] === "working").length;
  const waitingCount = agents.filter(a => waitingOn(a.id)).length;

  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const jobsThisMonth = world.tasks.filter(t => t.createdAt >= monthStart.getTime()).length;

  const shown = agents.filter(a => {
    if (filter === "working") return world.agentStatus[a.id] === "working";
    if (filter === "waiting") return waitingOn(a.id);
    if (filter === "off") return a.lifecycle === "paused" || a.lifecycle === "disabled";
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
            : <h1>{agents.length} {agents.length === 1 ? "hire" : "hires"},<br />no <em>payroll</em>.</h1>}
          <p>
            Everyone here was written by you in plain words. They keep their own skills,
            run on the app you gave them, and stop at the line you drew.
          </p>
        </div>
        <div className="crew-stats">
          <div className="stat"><div className="n">{workingCount}</div><div className="l">Working now</div></div>
          <div className="stat"><div className="n">{waitingCount}</div><div className="l">Waiting on you</div></div>
          <div className="stat"><div className="n">{jobsThisMonth}</div><div className="l">Jobs this month</div></div>
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
        <button className="btn tomarket" onClick={onMarket}>Browse the hiring hall</button>
        <button className="primary" onClick={onHire}>Write an agent</button>
      </div>

      {/* The one thing he has to know after hiring: it is his now. */}
      {justHired && (
        <div className="hirednote" data-hired={justHired}>
          <span className="hn-mark" aria-hidden="true">✓</span>
          <span>
            <b>@{justHired}</b> is on the floor. Everything about them — the brief, the app,
            what they can touch — is yours to change. Press <b>Edit</b> on their card.
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
            <button className="primary" onClick={onMarket}>Browse the hiring hall</button>
            <button className="btn" onClick={onHire}>Write your first agent</button>
          </div>
        </div>
      ) : (
        <div className="crew-grid">
          {shown.map((a, i) => {
            const provider = (a.provider ?? "claude") as Provider;
            const waiting = waitingOn(a.id);
            const busy = world.agentStatus[a.id] === "working";
            const flag = waiting
              ? <span className="chip is-gold"><span className="dot wait" />Waiting on you</span>
              : busy
                ? <span className="chip is-pine"><span className="dot live" />Working</span>
                : a.lifecycle && a.lifecycle !== "enabled"
                  ? <span className="chip"><span className="dot off" />Off duty</span>
                  : <span className="chip"><span className="dot off" />Free</span>;
            return (
              <article className="cast" key={a.id} data-crew={a.name}>
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
                      <span className="chip">{a.skills!.length} {a.skills!.length === 1 ? "skill" : "skills"}</span>}
                  </div>
                  <div className="now whocan" data-respond={a.respondTo ?? "owner"}>
                    <MarkGate />
                    <span>
                      {respondWords(a, a.ownerId === world.me?.id
                        ? "you"
                        : world.users.find(u => u.id === a.ownerId)?.name ?? "its owner")}
                    </span>
                  </div>
                  <div className="now">
                    <MarkClock />
                    <span>
                      {waiting ? "Waiting on your word before it carries on"
                        : busy ? "On a job right now"
                        : a.lifecycle === "paused" ? "Paused — it will not answer until you switch it back on"
                        : a.lifecycle === "disabled" ? "Switched off"
                        : "Free — nothing running"}
                    </span>
                  </div>
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
              <path d="M4 8h16l-1 11.5a1.5 1.5 0 0 1-1.5 1.4h-11A1.5 1.5 0 0 1 5 19.5Z" />
              <path d="M8.5 8V6a3.5 3.5 0 0 1 7 0v2" />
            </svg>
            <h3>The hiring hall</h3>
            <p>{MARKET_TEMPLATES.length} roles already written. Read the brief, pick the app, hire.</p>
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

/* ================= 5b · THE HIRING HALL (the marketplace) ================= */

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
          <span className="eyebrow">Cloud9 · the marketplace</span>
          <h1>Hire someone<br />already <em>written</em>.</h1>
          <p>
            {MARKET_TEMPLATES.length} roles that ship inside Cloud9 — no download, no account,
            and they work with the internet off. Hiring one copies it onto your floor,
            where you can change every word of it.
          </p>
        </div>
        <div className="crew-stats">
          <div className="stat"><div className="n">{MARKET_TEMPLATES.length}</div><div className="l">Roles ready</div></div>
          <div className="stat"><div className="n">{MARKET_CATEGORIES.length}</div><div className="l">Categories</div></div>
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
                <div className="roleface" aria-hidden="true"><span>{t.emoji}</span></div>
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
      agent: {
        name: hireName,
        emoji: template.emoji,
        persona: template.persona,
        // start from what any new agent starts with, then only what this role asks for
        abilities: { ...NEW_AGENT_ABILITIES, ...template.abilities },
        approvals: NEW_AGENT_APPROVALS,
        provider,
        model,
        skills: [],
        // the same default a hand-written agent gets: nobody but him can set it working
        respondTo: "owner",
        respondToAllowlist: [],
      },
    });
    onHired(hireName);
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel hirepanel" onClick={e => e.stopPropagation()}>
        <div className="head">
          <span className="hireface" aria-hidden="true">{template.emoji}</span>
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
              ? "This is the list Cloud9 ships with — sign the app in under Setup for its own."
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

  const targets = [
    ...world.agents.map(a => ({ id: a.id, label: `${a.emoji} ${a.name}`, name: a.name, kind: "agent" as const })),
    ...world.channels.filter(c => c.kind === "channel").map(c => ({ id: c.id, label: `# ${c.name}`, name: c.name, kind: "channel" as const })),
  ];

  const fire = () => {
    const t = targets[sel];
    if (!t || !text.trim()) return;
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
            if (e.key === "Escape") { onClose?.(); if (standalone) window.close(); }
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
/**
 * WHAT A BRAND NEW AGENT STARTS WITH — one owner for the answer.
 *
 * The editor starts here and so does a hire from the hiring hall, which is why
 * it is a constant rather than a literal typed into two places. A hired role
 * only ever says which switches it wants ON; everything it does not name keeps
 * whatever this says, and any switch added to the abilities model later is
 * absent here too — absent means off (`@cloud9/shared`), so nothing can be
 * granted to a hire by an ability arriving rather than by someone choosing it.
 */
const NEW_AGENT_ABILITIES: AgentAbilities = {
  webSearch: true, files: false, schedules: false, background: true,
};

/** The same answer, for approvals. A hire is no more permissive than a hand-written agent. */
const NEW_AGENT_APPROVALS: AgentApprovals = { background: false, schedules: false };

function useModels(provider: Provider): { ids: string[]; fallback: boolean; preferred: string } {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const info = world.harness?.[provider];
  const live = Array.isArray(info?.models) ? info!.models!.filter(m => typeof m === "string" && m) : [];
  const ids = live.length > 0 ? live : MODEL_FALLBACK[provider];
  const wanted = info?.defaultModel ?? prefs.get().defaultModel?.[provider] ?? MODEL_DEFAULT[provider];
  return { ids, fallback: live.length === 0, preferred: ids.includes(wanted) ? wanted : ids[0] };
}

/* ================= skills (his 9) ================= */

function SkillsEditor({ skills, onChange }: {
  skills: AgentSkill[];
  onChange: (next: AgentSkill[]) => void;
}): React.JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<AgentSkill>({ id: "", name: "", description: "", instructions: "" });
  const [note, setNote] = useState<string | null>(null);

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
      setNote(`One agent can hold ${SKILL_LIMITS.perAgent} skills. Delete one first.`); return;
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
    const keepFile = isSafeSkillFileName(file.name);
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
        problem = `One agent can hold ${SKILL_LIMITS.perAgent} skills. Delete one first.`; break;
      }
      const r = await readSkillFile(file);
      if (r.problem) problem = r.problem;
      if (r.skill) added.push(r.skill);
    }
    if (added.length > 0) {
      onChange([...skills, ...added]);
      const withFiles = added.filter(s => (s.files?.length ?? 0) > 0).length;
      setNote(
        `Added ${added.length} ${added.length === 1 ? "skill" : "skills"}` +
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
        problem = `One skill can carry ${SKILL_LIMITS.files} files.`; break;
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
    setNote(problem ?? `${kept.length} ${kept.length === 1 ? "file" : "files"} will go into the agent's folder when you save.`);
  };

  const detach = (fileName: string) =>
    setDraft(d => ({ ...d, files: (d.files ?? []).filter(f => f.name !== fileName) }));

  return (
    <div className="skills">
      <div className="skillhead">
        <span className="eyebrow">
          {skills.length} taught{skills.filter(s => (s.files?.length ?? 0) > 0).length > 0
            ? ` · ${skills.filter(s => (s.files?.length ?? 0) > 0).length} with files` : ""}
        </span>
        <div className="skillheadbtns">
          <button className="btn small skill-add" onClick={startAdd}>＋ Write a skill</button>
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
                📎 {s.files!.length} {s.files!.length === 1 ? "file" : "files"} in the agent's folder
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
    </div>
  );
}

/* ================= 5 · CREATE / EDIT AN AGENT ================= */

function AgentEditor({ agent, onDone, onMarket }: {
  agent: AgentDef | null; onDone: () => void; onMarket: () => void;
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
  const [skills, setSkills] = useState<AgentSkill[]>(Array.isArray(agent?.skills) ? agent!.skills! : []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /* WHO MAY SET THIS AGENT WORKING. Absent means "owner" — an agent made
     before this setting existed must never be more open than one made after. */
  const [respondTo, setRespondTo] = useState<AgentRespondTo>(agent?.respondTo ?? "owner");
  const [allowlist, setAllowlist] = useState<ID[]>(agent?.respondToAllowlist ?? []);

  const { ids, fallback, preferred } = useModels(provider);
  // an agent must never end up without a model
  useEffect(() => {
    if (!model || !ids.includes(model)) setModel(preferred);
  }, [provider, ids.join(","), model]);

  const ready = !!name.trim() && !!persona.trim();

  const save = () => {
    if (creating) {
      if (!ready) return;
      client.send({
        type: "createAgent",
        agent: {
          name: name.trim().replace(/\s+/g, "-"), emoji, persona: persona.trim(),
          abilities: ab, approvals: ap, provider,
          model: model || MODEL_DEFAULT[provider],
          skills, respondTo, respondToAllowlist: respondTo === "allowlist" ? allowlist : [],
        },
      });
    } else {
      client.send({
        type: "updateAgent",
        agent: {
          ...agent!, emoji, persona: persona.trim() || agent!.persona, abilities: ab,
          approvals: ap, provider, lifecycle: life,
          model: model || MODEL_DEFAULT[provider],
          skills, respondTo, respondToAllowlist: respondTo === "allowlist" ? allowlist : [],
        },
      });
    }
    onDone();
  };

  const del = () => {
    if (agent) client.send({ type: "deleteAgent", agentId: agent.id });
    onDone();
  };

  const shownName = creating ? (name.trim() || "Unnamed") : agent!.name;
  const jobsRun = agent ? world.tasks.filter(t => t.agentId === agent.id).length : 0;

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
        <button className="btn small ghost" onClick={onDone}>← Crew</button>
        <h2>{shownName}</h2>
        <span className="sub">
          {creating ? "New hire · nothing is saved until you press create"
            : `${jobsRun} ${jobsRun === 1 ? "job" : "jobs"} run · ${skills.length} ${skills.length === 1 ? "skill" : "skills"}`}
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
          {/* The blank page is the hardest part of writing an agent, so the
              way out of it is offered on the blank page itself. */}
          {creating && (
            <div className="fromhall">
              <span className="fh-mark" aria-hidden="true">⌕</span>
              <span className="fh-tx">
                <b>Not sure what to write?</b>
                <span>
                  {MARKET_TEMPLATES.length} roles are already written — architect, backend,
                  QA and more. Hire one and change it here afterwards.
                </span>
              </span>
              <button className="btn small tomarket" onClick={onMarket}>Browse the hiring hall</button>
            </div>
          )}
          <section className="fieldset">
            <div className="sec-head"><h3>Who they are</h3><span className="eyebrow">The basics</span></div>
            <p className="sec-note">Names matter — you'll be typing this one a lot, after an @.</p>
            <div className="two">
              <div className="field-row">
                <label htmlFor="f-name">Name <span className="hint">no spaces</span></label>
                {creating
                  ? <input className="input" id="f-name" type="text" value={name} placeholder="Scout"
                    onChange={e => setName(e.target.value)} />
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
                        {(info?.models?.length ?? 0) > 0 ? ` · ${info!.models!.length} models` : ""}
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
            </div>
            <p className="sec-note" style={{ marginTop: 8 }}>
              {fallback
                ? "This is the list Cloud9 ships with. Once the app is signed in under Setup, its own list is used."
                : `${ids.length} models offered by your ${PROVIDER_LABEL[provider]} app.`}
            </p>
            {!creating && !agent!.model && (
              <div className="notice modelunset">
                No model is saved for {agent!.name} yet, so its turns run on whatever
                its app picks. Press <b>Save</b> to pin the one shown above.
              </div>
            )}
          </section>

          <section className="fieldset">
            <div className="sec-head"><h3>What they're allowed to do</h3><span className="eyebrow">Abilities</span></div>
            <p className="sec-note">Off means the ability doesn't exist for this agent — not even with permission.</p>
            <div className="panelbox">
              {toggle("Web search", "Vendor docs, status pages, prices", ab.webSearch, v => setAb({ ...ab, webSearch: v }))}
              {toggle("Files folder", "Reads and writes in its own folder on this computer", ab.files, v => setAb({ ...ab, files: v }))}
              {toggle("Schedules", "Can set itself a repeating job", ab.schedules, v => setAb({ ...ab, schedules: v }))}
              {toggle("Background jobs", "Can carry on working after you walk away", ab.background, v => setAb({ ...ab, background: v }))}
            </div>
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

          <section className="fieldset">
            <div className="sec-head"><h3>When to stop and ask</h3><span className="eyebrow">Approval rules</span></div>
            <p className="sec-note">Anything matching a rule pauses the job and lands in Tasks with your name on it.</p>
            <div className="panelbox">
              {toggle("Background work", "Ask before it takes a job away to work on", ap.background, v => setAp({ ...ap, background: v }))}
              {toggle("Making a schedule", "Ask before it sets itself a repeating job", ap.schedules, v => setAp({ ...ap, schedules: v }))}
            </div>
          </section>

          <section className="fieldset">
            <div className="sec-head"><h3>Skills</h3><span className="eyebrow">Things you have taught them</span></div>
            <p className="sec-note">
              A skill is a named routine with your instructions. {shownName} picks the right one when a job matches it.
            </p>
            <SkillsEditor skills={skills} onChange={setSkills} />
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

function SearchOverlay({ onClose, onGo }: {
  onClose: () => void;
  onGo: (channelId: ID, messageId: ID) => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [q, setQ] = useState("");
  const boxRef = useRef<HTMLInputElement>(null);
  const state = world.search;

  useEffect(() => { boxRef.current?.focus(); }, []);

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

  // debounced, so typing a word is one search and not six
  useEffect(() => {
    if (parsed.words.length < 2) { client.clearSearch(); return; }
    const t = setTimeout(() => {
      client.search(parsed.words, { channelId: parsed.channelId, authorId: parsed.authorId });
    }, 200);
    return () => clearTimeout(t);
  }, [parsed.words, parsed.channelId, parsed.authorId]);

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
      <div className="panel searchpanel" onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === "Escape") onClose(); }}>
        <div className="head">
          Search everything you can see
          <span className="eyebrow">Esc to close</span>
        </div>
        <div className="searchbar">
          <span className="find-mark" aria-hidden="true">⌕</span>
          <input ref={boxRef} className="search-input" type="text" value={q}
            aria-label="Search every conversation"
            placeholder="villas in Goa · in:general · from:Priya"
            onChange={e => setQ(e.target.value)} />
          {state?.running && <span className="eyebrow">Looking…</span>}
        </div>

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
      </div>
    </div>
  );
}

/* ================= modals that stay modals ================= */

function InviteModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [copied, setCopied] = useState(false);
  const code = world.inviteCode;
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
                      {c.memberCount} {c.memberCount === 1 ? "person" : "people"} · started {dayStamp(c.createdAt)}
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
              onChange={e => setName(e.target.value.replace(/\s+/g, "-").toLowerCase())} placeholder="trip-goa" /></div>
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
          <button className="primary" disabled={!name.trim()}
            onClick={() => { if (name.trim()) { client.send({ type: "createChannel", name: name.trim(), memberIds: members, kind: "channel" }); onClose(); } }}>Create</button>
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
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
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
        <h2>Setup</h2>
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
        {(info?.models?.length ?? 0) > 0 && <span>{info!.models!.length} models available</span>}
        {savedKey && <span>✓ key saved on this computer</span>}
      </div>

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
          <span className="problemtext">{problem}</span>
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

/* ================= 6 · TASKS & APPROVALS ================= */

const STATUS_LABEL: Record<string, string> = {
  not_started: "queued", working: "working", waiting_user: "waiting for you",
  waiting_approval: "needs your go-ahead", blocked: "blocked",
  completed: "done", failed: "failed", cancelled: "cancelled",
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

  const mineWaiting = world.approvals.filter(
    a => a.status === "pending" && a.ownerId === world.me?.id);

  const shown = world.tasks.filter(t => {
    if (filter === "running") return RUNNING_STATES.includes(t.status);
    if (filter === "done") return t.status === "completed";
    if (filter === "failed") return t.status === "failed" || t.status === "cancelled";
    return true;
  });
  const running = shown.filter(t => RUNNING_STATES.includes(t.status));
  const finished = shown.filter(t => !RUNNING_STATES.includes(t.status));

  const taskCard = (t: Task) => {
    const approval = t.approvalId ? world.approvals.find(a => a.id === t.approvalId) : undefined;
    const agent = world.agents.find(a => a.id === t.agentId);
    const mine = approval && approval.status === "pending" && approval.ownerId === world.me?.id;
    const cancellable = RUNNING_STATES.includes(t.status);
    const provider = agent ? PROVIDER_LABEL[(agent.provider ?? "claude") as Provider] : null;
    return (
      <div key={t.id} className="taskrow">
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
          {t.error && (t.status === "failed" || t.status === "cancelled") && (
            <div className="taskresult"><b>What went wrong</b>{t.error}</div>
          )}
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
          {running.length > 0 && (
            <span className="eyebrow" style={{ display: "block", marginBottom: 12 }}>Running · {running.length}</span>
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

          {mineWaiting.map(ap => {
            const agent = world.agents.find(a => a.id === ap.agentId);
            const task = world.tasks.find(t => t.id === ap.taskId);
            const rule = ruleWords(agent);
            return (
              <div className="approval" key={ap.id} data-appr={ap.id}>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 8 }}>
                  {agent ? <AgentFace name={agent.name} size={30} lamp="wait" /> : <PersonFace name="?" size={30} />}
                  <div style={{ minWidth: 0 }}>
                    <h4>{task?.title ?? ap.action}</h4>
                    <div className="meta">{agent?.name ?? "An agent"} · {clock(ap.createdAt)}</div>
                  </div>
                </div>
                <p style={{ fontSize: 12.5, margin: "0 0 10px", color: "var(--ink-2)" }}>{ap.action}</p>
                {rule && <p className="meta" style={{ margin: "0 0 10px" }}>Rule hit: {rule}</p>}
                <div className="actions">
                  <button className="gold small"
                    onClick={() => client.send({ type: "decideApproval", approvalId: ap.id, decision: "approved" })}>Approve</button>
                  <button className="btn small danger"
                    onClick={() => client.send({ type: "decideApproval", approvalId: ap.id, decision: "rejected" })}>Reject</button>
                </div>
              </div>
            );
          })}

          {mineWaiting.length === 0 && (
            <EmptyTray title="Nothing waiting" line="Every request has an answer. The crew carries on." />
          )}
        </aside>
      </div>
    </div>
  );
}

/* ================= 7 · ACTIVITY ================= */

function ActivityScreen(): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [showAgents, setShowAgents] = useState(true);
  const [showPeople, setShowPeople] = useState(true);

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
        <span className="sub">Everything that happened, and who did it</span>
        <div className="grow" />
        <div className="filters">
          <button className="chip is-pine" aria-pressed={showAgents}
            onClick={() => setShowAgents(v => !v)}>Agents</button>
          <button className="chip is-ultra" aria-pressed={showPeople}
            onClick={() => setShowPeople(v => !v)}>People</button>
        </div>
      </header>

      <div className="act-body">
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
