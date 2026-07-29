import React, {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from "react";
import {
  AgentDef, AgentSkill, AgentSkillFile, Approval, Channel, DEMO_MODE_BANNER, HarnessInfo, ID,
  isSafeSkillFileName, MENU_ACTIONS, MenuAction, Message, SKILL_LIMITS, Task, User,
} from "@cloud9/shared";
import { client } from "./store.js";

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
});

const usePrefs = (): Prefs => useSyncExternalStore(prefs.subscribe, prefs.get);

/** last time you looked at each conversation — drives the unread marks */
const reads = makeStore<Record<string, number>>("cloud9.lastRead", {});
const useReads = (): Record<string, number> => useSyncExternalStore(reads.subscribe, reads.get);

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

/* a one-line bus so a message row can drop text into the composer */
type Inserter = (text: string) => void;
let composerInsert: Inserter | null = null;

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

type ScreenName = "chat" | "crew" | "editor" | "tasks" | "activity" | "settings";
type ModalName = "invite" | "channel";

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
  const lastRead = useReads();
  const [screen, setScreen] = useState<ScreenName>("chat");
  const [activeId, setActiveId] = useState<ID | null>(null);
  const [modal, setModal] = useState<null | ModalName>(null);
  /** null = not editing. "new" = hiring. An agent = editing that one. */
  const [editorFor, setEditorFor] = useState<AgentDef | "new" | null>(null);
  const [quick, setQuick] = useState(false);
  const [pendingPeer, setPendingPeer] = useState<{ id: ID; since: number } | null>(null);
  const [findOpen, setFindOpen] = useState(false);

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
    "search": () => { setScreen("chat"); setFindOpen(true); },
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
    return () => {
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

  /* ---- unread ---- */
  const unreadFor = useCallback((c: Channel): number => {
    const seen = lastRead[c.id] ?? 0;
    const msgs = world.messages[c.id] ?? [];
    return msgs.filter(m => m.ts > seen && m.authorId !== world.me?.id).length;
  }, [lastRead, world.messages, world.me]);

  // reading a channel marks it read
  useEffect(() => {
    if (!active || screen !== "chat") return;
    const msgs = world.messages[active.id] ?? [];
    const newest = msgs.length ? msgs[msgs.length - 1].ts : Date.now();
    if ((reads.get()[active.id] ?? 0) < newest) reads.set({ [active.id]: newest });
  }, [active, world.messages, screen]);

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
              onNewChannel={() => setModal("channel")} onNewAgent={() => openEditor("new")}
              onInvite={openInvite} onEditAgent={a => openEditor(a)} onOpenDm={openDm}
              lastRead={active ? lastRead[active.id] ?? 0 : 0}
              findOpen={findOpen} onCloseFind={() => setFindOpen(false)}
              onOpenTasks={() => setScreen("tasks")}
            />
          )}
          {screen === "crew" && (
            <CrewScreen onHire={() => openEditor("new")} onEdit={a => openEditor(a)} onOpen={openDm} />
          )}
          {screen === "editor" && (
            <AgentEditor
              agent={editorFor === "new" || editorFor === null ? null : editorFor}
              onDone={() => { setEditorFor(null); setScreen("crew"); }}
            />
          )}
          {screen === "tasks" && <TasksScreen onOpenChannel={id => { setActiveId(id); setScreen("chat"); }} />}
          {screen === "activity" && <ActivityScreen />}
          {screen === "settings" && <SettingsScreen />}
        </main>
      </div>

      {quick && <QuickChat onClose={() => setQuick(false)} />}
      {modal === "invite" && <InviteModal onClose={() => setModal(null)} />}
      {modal === "channel" && <ChannelModal onClose={() => setModal(null)} />}
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

function ChatScreen({
  active, setActiveId, channels, humanDms, agents, people, unreadFor, peerOf, owner,
  onNewChannel, onNewAgent, onInvite, onEditAgent, onOpenDm, lastRead, findOpen, onCloseFind,
  onOpenTasks,
}: {
  active?: Channel; setActiveId: (id: ID) => void;
  channels: Channel[]; humanDms: Channel[]; agents: AgentDefPlus[]; people: User[];
  unreadFor: (c: Channel) => number; peerOf: (c: Channel) => Peer; owner: boolean;
  onNewChannel: () => void; onNewAgent: () => void; onInvite: () => void;
  onEditAgent: (a: AgentDef) => void; onOpenDm: (id: ID, name: string) => void;
  lastRead: number; findOpen: boolean; onCloseFind: () => void; onOpenTasks: () => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const isDm = active?.kind === "dm";

  const agentDmFor = (a: AgentDef) =>
    world.channels.find(c => c.kind === "dm" && c.memberIds.includes(a.id));

  return (
    <div className={`chatgrid${isDm ? " no-aside" : ""}`}>
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
              <button title="New channel" aria-label="New channel" onClick={onNewChannel}>＋</button>
            </div>
            {channels.length === 0
              ? <RailEmpty text="No channels yet." action="Make the first one" onAction={onNewChannel} />
              : channels.map(c => {
                const unread = unreadFor(c);
                return (
                  <button key={c.id} className="side-item" data-channel={c.name}
                    aria-current={active?.id === c.id ? "true" : "false"}
                    onClick={() => setActiveId(c.id)}>
                    <span className="hash">#</span>{" "}
                    <span className="txt">{c.name}</span>
                    {unread > 0 && <span className="cnt hot" aria-label={`${unread} new`}>{unread}</span>}
                  </button>
                );
              })}
          </div>

          <div className="side-group">
            <div className="side-head">
              <span className="eyebrow">Direct</span>
              <button title="New agent" aria-label="New agent" onClick={onNewAgent}>＋</button>
            </div>
            {agents.length === 0 && humanDms.length === 0 &&
              <RailEmpty text="Nobody hired yet." action="Write your first agent" onAction={onNewAgent} />}
            {agents.map(a => {
              const s = agentStatusLine(a, world.agentStatus[a.id]);
              const dm = agentDmFor(a);
              const unread = dm ? unreadFor(dm) : 0;
              return (
                <div key={a.id} className="side-item agentrow agent-row" data-agent={a.name}
                  aria-current={dm && active?.id === dm.id ? "true" : "false"} title={a.persona}>
                  <button className="agentmain" onClick={() => onOpenDm(a.id, a.name)}
                    title={`Open your chat with ${a.name}`}>
                    <AgentFace name={a.name} size={22} lamp={s.lamp} />
                    <span className="txt agent-name">{a.name}</span>
                    {unread > 0 && <span className="cnt hot">{unread}</span>}
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
                  {unread > 0 && <span className="cnt hot">{unread}</span>}
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
        <ChatView channel={active} lastRead={lastRead} findOpen={findOpen} onCloseFind={onCloseFind}
          onEditAgent={onEditAgent} onOpenTasks={onOpenTasks} />
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

      {active && !isDm && <ChannelRail channel={active} onEditAgent={onEditAgent} onOpenDm={onOpenDm} />}
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

function ChatView({ channel, lastRead, findOpen, onCloseFind, onEditAgent, onOpenTasks }: {
  channel: Channel; lastRead: number; findOpen: boolean; onCloseFind: () => void;
  onEditAgent: (a: AgentDef) => void; onOpenTasks: () => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const all = world.messages[channel.id] ?? [];
  const streamRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const [openedAt] = useState(lastRead);

  /* ---- Find in conversation (Ctrl+F / Edit menu) ---- */
  const [find, setFind] = useState("");
  useEffect(() => { if (findOpen) findRef.current?.focus(); }, [findOpen]);
  useEffect(() => { if (!findOpen) setFind(""); }, [findOpen]);
  const needle = findOpen ? find.trim().toLowerCase() : "";
  const messages = needle
    ? all.filter(m => m.text.toLowerCase().includes(needle) || m.authorName.toLowerCase().includes(needle))
    : all;

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [messages.length, channel.id]);

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
    const cont = !dayStart && !!prev && prev.authorKind === "human" && m.authorKind === "human"
      && prev.authorId === m.authorId && m.ts - prev.ts < 5 * 60 * 1000;
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
          <div className="grow" />
          {myApprovals.length > 0 && (
            <button className="chip is-gold approvalpill" onClick={onOpenTasks}>
              <span className="dot wait" />
              {myApprovals.length} approval{myApprovals.length === 1 ? "" : "s"} waiting
            </button>
          )}
          <AddToChannel channel={channel} />
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

      <div className="msgs" ref={streamRef}>
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
              working={world.agentStatus[r.m.authorId] === "working"} />
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

      <Composer channel={channel} />
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

function MessageRow({ row, agent, working }: { row: Row; agent?: AgentDef; working?: boolean }): React.JSX.Element {
  const { m, cont, ask } = row;
  const isAgent = m.authorKind === "agent";
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(m.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => setCopied(false));
  };

  const paragraph = (text: string, key?: React.Key) => (
    <p key={key}>{text.split(/(@[\w-]+)/g).map((part, i) => part.startsWith("@")
      ? <span key={i} className="mention">{part}</span>
      : part)}</p>
  );

  const actions = (
    <div className="msgactions">
      <button className="ma" title={`Write back to ${m.authorName}`}
        onClick={() => composerInsert?.(`@${m.authorName} `)}>↩</button>
      <button className="ma" title="Copy this message" onClick={copy}>{copied ? "✓" : "⧉"}</button>
    </div>
  );

  if (cont) {
    return (
      <article className="msg cont">
        <div className="when-gutter">{clock(m.ts)}</div>
        <div className="body">{paragraph(m.text)}</div>
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
    <article className={`msg ${isAgent ? "from-agent" : ""} ${m.proactive ? "proactive" : ""}`}>
      {isAgent
        ? <AgentFace name={m.authorName} size={34} lamp={working ? "run" : "live"} />
        : <PersonFace name={m.authorName} size={34} />}
      <div className="body">
        <div className="who">
          <b>{m.authorName}</b>
          {isAgent && <span className="badge">Agent</span>}
          <span className="t">{clock(m.ts)}</span>
          {m.proactive && <span className="chip is-ultra selfstart">Nobody asked — I noticed</span>}
        </div>
        {strip.length > 0 && (
          <div className="runstrip">
            {strip.map((node, i) => (
              <React.Fragment key={i}>
                {i > 0 && <span className="sep" />}
                {node}
              </React.Fragment>
            ))}
          </div>
        )}
        {body}
      </div>
      {actions}
    </article>
  );
}

function AddToChannel({ channel }: { channel: Channel }): React.JSX.Element | null {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  if (channel.kind === "dm") return null;
  const candidates = [
    ...world.agents.filter(a => !channel.memberIds.includes(a.id)).map(a => ({ id: a.id, label: `${a.emoji} ${a.name}` })),
    ...onePerPerson(world.users).filter(u => !channel.memberIds.includes(u.id)).map(u => ({ id: u.id, label: u.name })),
  ];
  if (candidates.length === 0) return null;
  return (
    <select
      aria-label="Add someone to this channel"
      value=""
      onChange={e => { if (e.target.value) client.send({ type: "addMembers", channelId: channel.id, memberIds: [e.target.value] }); }}
    >
      <option value="">Add agent…</option>
      {candidates.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
    </select>
  );
}

const QUICK_EMOJI = ["👍", "🙏", "🎉", "🔥", "✅", "❌", "😀", "😅", "🤔", "👀", "🚀", "☁️", "📌", "⏰", "💡", "❤️"];

function Composer({ channel }: { channel: Channel }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [text, setText] = useState("");
  const [acIndex, setAcIndex] = useState(0);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

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

  useEffect(() => {
    composerInsert = insert;
    return () => { composerInsert = null; };
  }, [insert]);

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

  const sendNow = () => {
    const t = text.trim();
    if (!t) return;
    client.send({ type: "send", channelId: channel.id, text: t });
    setText("");
    setEmojiOpen(false);
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
  const placeholder = peerName
    ? `Message ${peerName}`
    : `Message #${channel.name} — type @ to call an agent in`;

  return (
    <div className="composer">
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
          <button className="mini" title="Call an agent by name" onClick={() => insert("@")}>@ agent</button>
          <button className="mini" title="Hand this over as background work"
            onClick={() => insert("!bg ")}>Delegate as a job</button>
          <button className="mini" title="Bold" onClick={() => wrap("**")}><b>B</b></button>
          <button className="mini ital" title="Italic" onClick={() => wrap("_")}>I</button>
          <button className="mini" title="Code" onClick={() => wrap("`")}>{"</>"}</button>
          <button className="mini" title="Emoji" aria-expanded={emojiOpen}
            onClick={() => setEmojiOpen(o => !o)}>🙂</button>
          <div className="grow" />
          <span className="eyebrow">Enter to send</span>
          <button className="primary small" onClick={sendNow} disabled={!text.trim()}>Send</button>
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
            <div className="mini-agent" key={a.id}>
              <AgentFace name={a.name} size={36} lamp={s.lamp} />
              <span style={{ minWidth: 0 }}>
                <span className="nm">{a.name}</span>
                <span className="rl two-lines" title={a.persona}>
                  {PROVIDER_LABEL[provider]} · {s.busy ? "Working now" : roleOf(a.persona)}
                </span>
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

function CrewScreen({ onHire, onEdit, onOpen }: {
  onHire: () => void;
  onEdit: (a: AgentDef) => void;
  onOpen: (id: ID, name: string) => void;
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
        <button className="primary" onClick={onHire}>Hire an agent</button>
      </div>

      {agents.length === 0 ? (
        <div className="crew-empty">
          <StudioScene />
          <h2>The plates are still blank</h2>
          <p>
            Write one agent in plain words — what it does, what it may touch, when it must stop and ask.
            Cloud9 gives it a face and a desk.
          </p>
          <button className="primary" onClick={onHire}>Write your first agent</button>
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
          <button className="cast cast-new" onClick={onHire}>
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="9" r="3.6" /><path d="M5 20a7 7 0 0 1 10.5-6" />
              <path d="M18 15.5v6M15 18.5h6" />
            </svg>
            <h3>Hire someone new</h3>
            <p>Describe the job in plain words. Cloud9 writes the agent for you.</p>
          </button>
        </div>
      )}
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

function AgentEditor({ agent, onDone }: { agent: AgentDef | null; onDone: () => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const p = usePrefs();
  const creating = agent === null;

  const [name, setName] = useState(agent?.name ?? "");
  const [emoji, setEmoji] = useState(agent?.emoji ?? "✨");
  const [persona, setPersona] = useState(agent?.persona ?? "");
  const [ab, setAb] = useState(agent?.abilities ?? { webSearch: true, files: false, schedules: false, background: true });
  const [ap, setAp] = useState(agent?.approvals ?? { background: false, schedules: false });
  const [life, setLife] = useState(agent?.lifecycle ?? "enabled");
  const [provider, setProvider] = useState<Provider>(
    (agent?.provider ?? p.defaultProvider ?? "claude") as Provider);
  const [model, setModel] = useState<string>(
    agent?.model ?? p.defaultModel?.[(agent?.provider ?? p.defaultProvider ?? "claude") as Provider] ?? MODEL_DEFAULT.claude);
  const [skills, setSkills] = useState<AgentSkill[]>(Array.isArray(agent?.skills) ? agent!.skills! : []);
  const [confirmDelete, setConfirmDelete] = useState(false);

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
          skills,
        },
      });
    } else {
      client.send({
        type: "updateAgent",
        agent: {
          ...agent!, emoji, persona: persona.trim() || agent!.persona, abilities: ab,
          approvals: ap, provider, lifecycle: life,
          model: model || MODEL_DEFAULT[provider],
          skills,
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
