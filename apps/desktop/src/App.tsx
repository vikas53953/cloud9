import React, {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from "react";
import {
  AgentDef, AgentSkill, AgentSkillFile, Channel, DEMO_MODE_BANNER, HarnessInfo, ID,
  isSafeSkillFileName, MENU_ACTIONS, MenuAction, Message, SKILL_LIMITS, User,
} from "@cloud9/shared";
import { client } from "./store.js";

const isQuickWindow = location.hash === "#quick";

/* ============================================================
   CONTRACT SHAPES (docs/plans/feedback-round-1.md)
   Builder A owns packages/shared. Until those fields land there,
   the renderer describes them locally and reads them defensively,
   so an older engine or an older saved agent never crashes the app.
   ============================================================ */

/**
 * Skills come from `@cloud9/shared` — the SAME type the relay stores and the
 * engine reads. The renderer used to describe its own narrower copy without
 * `files`, which is exactly how an uploaded file could be dropped on save.
 * One shape, one owner: if a field exists on the agent, this editor carries it.
 */
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
 * What to SAY about the model an agent runs on.
 *
 * The engine only passes `--model` when the agent actually stores one
 * (`claude-cli.ts`, `codex.ts`), so an older agent with no stored model runs on
 * whatever its app picks. Showing "Sonnet 5" there was the app stating a fact
 * the run does not honour. When we don't know, we say we don't know.
 */
const modelWords = (model?: string): string =>
  model ? modelLabel(model) : "app's default";

/** The tooltip that explains the honest answer above. */
const MODEL_UNSET_HINT =
  "No model was saved for this agent, so it runs on whatever its app picks. " +
  "Open the agent and press Save to pin one.";

/** Only the owner of this Cloud9 can invite or remove people (the relay gates both). */
const isOwner = (me?: User): boolean => !!me && !me.invitedBy;

/**
 * Relay refusals, in Vikas's words. The relay speaks a short machine phrase;
 * the person reading it deserves a sentence that says what to do next.
 */
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

/* ================= small formatters (Workbench vernacular) ================= */

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

/* ================= cast plates =================
   Every agent gets a portrait drawn from its own name, so the same
   agent wears the same face on every machine and after every restart.
   The plate's paint is the six `--plate-N-*` token sets in styles.css, so
   the portraits use the SAME colour layer as the rest of the interface and
   no colour value is written twice. Nothing here is a raw colour.
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
  const stroke = { stroke: f.c1, strokeWidth: 3, strokeLinecap: "round" as const, fill: "none" };
  if (f.crest === "antenna") {
    return <g><path d="M50 30v-9" {...stroke} /><circle cx="50" cy="18" r="4" fill={f.c1} /></g>;
  }
  if (f.crest === "halo") return <ellipse cx="50" cy="21" rx="17" ry="5" {...stroke} />;
  if (f.crest === "bars") return <path d="M40 30v-8M50 30v-12M60 30v-8" {...stroke} />;
  if (f.crest === "wedge") return <path d="M50 19l9.5 10.5h-19Z" fill={f.c1} />;
  return <path d="M34 26q8-9 16 0t16 0" {...stroke} />;
}

/**
 * The plate itself. `working` makes it blink and breathe, as in the mock.
 * `fill` lets it take the whole frame it is put in — that is how the big
 * call-sheet plate on the crew screen is drawn.
 */
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

/** rail lamp names → the plate's own four states */
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

/** Is the app showing its dark look right now, whatever the setting says? */
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
 * (his 15); the app shows each of them exactly once, everywhere a list of
 * people appears.
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
   *
   * The relay only answers this when asked, and the ONLY place that asked used
   * to be the Settings screen — so opening Cloud9 and going straight to "Hire an
   * agent" offered the shipped fallback model list, with a hint saying so, even
   * when the engine had already reported the real one.
   *
   * It lives HERE rather than in `Workspace` because `Workspace` remounts every
   * time you cross to the crew screen and back, and "go and look again" makes
   * the engine re-run `claude auth status` — once per connection, not once per
   * screen. Owner-only for the same reason the invite button is: these frames
   * are owner-gated in the relay, so a guest asking would only ever be handed
   * "only the owner of this Cloud9 can connect the AI apps" — an error about
   * something they never did.
   */
  const meId = world.me?.id;
  const canAskHarness = world.connected && isOwner(world.me);
  useEffect(() => {
    if (!canAskHarness) return;
    client.send({ type: "refreshHarness" });
    client.send({ type: "harnessStatus" }); // the frame today's engine understands
  }, [canAskHarness, meId]);

  /**
   * The Toast lives HERE, at the root, not inside the workspace.
   *
   * B1: an error that explains a failure has to be visible on every screen. It
   * used to be mounted inside `Workspace` — a screen a refused joiner never
   * reaches — so a guest with a spent invite watched the app do nothing at all.
   */
  const onJoinScreen = !joined || world.authFailed;
  const screen = onJoinScreen
    ? <JoinScreen onJoin={() => setJoined(true)} />
    : isQuickWindow ? <QuickChat standalone />
    : <Workspace />;

  // exactly one owner per screen: the join screen prints the reason beside the
  // code box, every other screen gets the toast. Neither can be reached without
  // one of them being mounted.
  return <>{screen}{!onJoinScreen && <Toast />}</>;
}

/* ================= join / invite screen ================= */

function JoinScreen({ onJoin }: { onJoin: () => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [mode, setMode] = useState<"owner" | "invite">("owner");
  const [token, setToken] = useState("dev-owner-token");
  const [invite, setInvite] = useState("");
  const [name, setName] = useState("");
  const [trying, setTrying] = useState(false);

  /**
   * B1 — the refusal is shown HERE, next to the box the code was typed into.
   * The relay answers a spent or wrong invite with an `error` frame and then
   * closes the socket; before this, the only thing that rendered `lastError`
   * lived inside the workspace, so a refused guest saw nothing at all.
   */
  const refusal = plainError(world.lastError?.text);

  // we're in only when the relay says welcome — not the moment the button is
  // pressed, or a refusal would be hidden behind an empty workspace
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
    <div className="join">
      <div className="join-left">
        <div className="join-brand">
          <div className="mark" aria-hidden="true"><CloudMark /></div>
          <span className="wordmark">Cloud9</span>
          <span className="chip">First run</span>
        </div>

        <h1>Welcome to Cloud9</h1>
        <p className="lede">
          Hire a crew, give them a desk. Your agents sit in your channels, take jobs,
          and stop to ask before they change anything.
        </p>

        <div className="panel">
          <div className="body">
            <div className="modeswitch">
              <button className={mode === "owner" ? "on" : ""} onClick={() => setMode("owner")}>I run this Cloud9</button>
              <button className={mode === "invite" ? "on" : ""} onClick={() => setMode("invite")}>I have an invite</button>
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

        <div className="join-foot">
          <span className="eyebrow">Two ways in · owner or invited</span>
        </div>
      </div>

      <div className="join-right">
        <StudioScene />
      </div>
    </div>
  );
}

/** The house mark: a cloud with a nine-shaped bloom under it. */
function CloudMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.5 17.5a4 4 0 0 1-.4-8A5.4 5.4 0 0 1 16.4 8.2a3.6 3.6 0 0 1 1 7.1" />
      <circle cx="12" cy="15.6" r="2.6" />
    </svg>
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

/* ================= main workspace ================= */

type ModalName = "agent" | "invite" | "settings" | "channel" | "tasks" | "activity" | "crew";

function Workspace(): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const p = usePrefs();
  const lastRead = useReads();
  const [activeId, setActiveId] = useState<ID | null>(null);
  const [modal, setModal] = useState<null | ModalName>(null);
  const [editAgent, setEditAgent] = useState<AgentDef | null>(null);
  const [quick, setQuick] = useState(false);
  const [details, setDetails] = useState(true);
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
   * The handler map is typed `Record<MenuAction, …>` against the ONE list in
   * @cloud9/shared that the Electron shell builds its menu from. Add an item to
   * that list without handling it here and this file stops compiling — a dead
   * menu click cannot be shipped any more (it used to handle 5 of 9). */
  const openActivity = useCallback(() => {
    client.send({ type: "activity", limit: 100 });
    setModal("activity");
  }, []);

  const menuHandlers = useMemo<Record<MenuAction, () => void>>(() => ({
    "new-agent": () => setModal("agent"),
    "new-channel": () => setModal("channel"),
    // The shell's menu is the same for everyone, so a guest CAN reach this.
    // Doing nothing would be a dead click; the relay's own wording is reused so
    // the menu and a refused button say the identical sentence.
    "invite": () => owner
      ? openInvite()
      : client.notify("only the owner of this Cloud9 can invite someone"),
    "settings": () => setModal("settings"),
    "search": () => setFindOpen(true),
    "toggle-theme": () => {
      const now = document.documentElement.getAttribute("data-theme");
      prefs.set({ theme: now === "dark" ? "light" : "dark" });
    },
    "activity": openActivity,
    "tasks": () => setModal("tasks"),
    "quick-chat": () => setQuick(true),
  }), [owner, openInvite, openActivity]);

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
      // the bridge hands back an unsubscribe; not calling it leaked one IPC
      // listener per mount (m8)
      if (typeof offMenu === "function") offMenu();
    };
  }, []);

  /* ---- one person per row, however many times the relay lists them (his 15) ---- */
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
      // count alone: a named channel like #general is also two people the
      // moment a second person joins, and matching it here sent every click on
      // a person straight back to the room already on screen.
      ?? world.channels.find(c =>
        c.name.startsWith("dm:") && has(c) && (!mine || c.memberIds.includes(mine)));
  }, [world.channels, world.me]);

  const openDm = (peerId: ID, peerName: string) => {
    if (!world.me || peerId === world.me.id) return;
    const existing = findDm(peerId);
    if (existing) { setActiveId(existing.id); setPendingPeer(null); return; }
    setPendingPeer({ id: peerId, since: Date.now() });
    client.send({ type: "createChannel", name: `dm-${slug(peerName)}`, memberIds: [peerId], kind: "dm" });
  };

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
    // and never wait forever: if the relay says nothing, stop expecting it
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
    if (!active) return;
    const msgs = world.messages[active.id] ?? [];
    const newest = msgs.length ? msgs[msgs.length - 1].ts : Date.now();
    if ((reads.get()[active.id] ?? 0) < newest) reads.set({ [active.id]: newest });
  }, [active, world.messages]);

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
  const dms = world.channels.filter(c => c.kind === "dm");
  const agents = world.agents as AgentDefPlus[];

  const peerOf = (c: Channel) => {
    const id = c.memberIds.find(i => i !== world.me?.id);
    const user = world.users.find(u => u.id === id);
    const agent = world.agents.find(a => a.id === id);
    const status = agent ? agentStatusLine(agent, world.agentStatus[agent.id]) : null;
    return {
      name: user?.name ?? agent?.name ?? c.name,
      isAgent: !!agent,
      sub: status ? status.line : "just the two of you",
      lamp: status ? status.lamp : "idle",
      busy: status?.busy ?? false,
    };
  };

  const section = (id: string) => ({
    open: !p.collapsed[id],
    toggle: () => prefs.set({ collapsed: { ...p.collapsed, [id]: !p.collapsed[id] } }),
  });
  const secChannels = section("channels");
  const secAgents = section("agents");
  const secDms = section("dms");
  const secPeople = section("people");

  return (
    <div className="shell">
      <TopBar
        connected={world.connected}
        meName={world.me?.name}
        pendingApprovals={pendingApprovals}
        onQuick={() => setQuick(true)}
        onTasks={() => setModal("tasks")}
        onActivity={() => { client.send({ type: "activity", limit: 100 }); setModal("activity"); }}
        onSettings={() => setModal("settings")}
      />

      {/* Demo answers are made up. If the engine is handing them out, the app
          says so across the top — a canned reply must never be able to pass
          for a real one just because nobody looked at the launcher. */}
      {world.harness?.demo && (
        <div className="demobanner" role="status">{DEMO_MODE_BANNER}</div>
      )}

      <div className="app" data-details={details && active ? "on" : "off"} data-compact={p.compact ? "on" : "off"}>
        <nav className="sidebar rail" aria-label="Workspace">
          <div className="rail-head">
            <div className="mark" aria-hidden="true"><CloudMark /></div>
            <div className="wordmark">
              Cloud9
              <span className={`conn ${world.connected ? "ok" : ""}`}>
                {world.connected ? `connected as ${world.me?.name}` : "connecting…"}
              </span>
            </div>
            <button className="kbd" title="Quick chat (Ctrl K)" onClick={() => setQuick(true)}>Ctrl K</button>
          </div>

          <div className="rail-scroll">
            <SectionHead
              label="Channels" count={channels.length} open={secChannels.open} onToggle={secChannels.toggle}
              actionTitle="New channel" onAction={() => setModal("channel")}
            />
            {secChannels.open && (channels.length === 0
              ? <RailEmpty text="No channels yet." action="Make the first one" onAction={() => setModal("channel")} />
              : channels.map(c => {
                const unread = unreadFor(c);
                return (
                  <button key={c.id} data-channel={c.name}
                    className={`row ${active?.id === c.id ? "on" : ""} ${unread ? "unread" : ""}`}
                    onClick={() => setActiveId(c.id)}>
                    <span className="hash">#</span>{" "}
                    <span className="name">{c.name}</span>
                    {unread > 0 && <span className="badgecount" aria-label={`${unread} new`}>{unread}</span>}
                  </button>
                );
              }))}

            <SectionHead
              label="Your crew" count={agents.length} open={secAgents.open} onToggle={secAgents.toggle}
              actionTitle="New agent" onAction={() => setModal("agent")}
            />
            {secAgents.open && (agents.length === 0
              ? <RailEmpty text="Nobody hired yet." action="Write your first agent" onAction={() => setModal("agent")} />
              : agents.map(a => {
                const s = agentStatusLine(a, world.agentStatus[a.id]);
                return (
                  <div key={a.id} className="row agent-row agentrow" data-agent={a.name} title={a.persona}>
                    <button className="agentmain" onClick={() => openDm(a.id, a.name)}
                      title={`Open your chat with ${a.name}`}>
                      <AgentFace name={a.name} size={26} lamp={s.lamp} />
                      <span className="agent-meta">
                        <span className="agent-name">{a.name}</span>
                        <span className={`agent-sub ${s.busy ? "busy" : ""}`}>{s.line}</span>
                      </span>
                    </button>
                    {a.ownerId === world.me?.id &&
                      <button className="editbtn" title="Edit agent" aria-label={`Edit ${a.name}`}
                        onClick={() => setEditAgent(a)}>✎</button>}
                  </div>
                );
              }))}

            {dms.length > 0 && (
              <SectionHead label="Direct messages" count={dms.length} open={secDms.open} onToggle={secDms.toggle} />
            )}
            {secDms.open && dms.map(c => {
              const pr = peerOf(c);
              const unread = unreadFor(c);
              return (
                <div key={c.id} className={`row agent-row ${active?.id === c.id ? "on" : ""} ${unread ? "unread" : ""}`}>
                  <button className="agentmain" onClick={() => setActiveId(c.id)}>
                    {pr.isAgent
                      ? <AgentFace name={pr.name} size={26} lamp={pr.lamp} />
                      : <PersonFace name={pr.name} size={26} lamp={pr.lamp} />}
                    <span className="agent-meta">
                      <span className="agent-name">{pr.name}</span>
                      <span className={`agent-sub ${pr.busy ? "busy" : ""}`}>{pr.sub}</span>
                    </span>
                    {unread > 0 && <span className="badgecount">{unread}</span>}
                  </button>
                </div>
              );
            })}

            {/* Only the owner can mint an invite (the relay refuses everyone
                else), so only the owner is offered one. A button whose only
                possible outcome is an error is not a feature. */}
            <SectionHead
              label="People" count={people.length} open={secPeople.open} onToggle={secPeople.toggle}
              actionTitle={owner ? "Invite a friend" : undefined}
              onAction={owner ? openInvite : undefined}
            />
            {secPeople.open && people.map(u => {
              const isMe = u.id === world.me?.id;
              if (isMe) {
                return (
                  <div key={u.id} className="row person-row is-me" data-person={u.name}>
                    <PersonFace name={u.name} size={26} lamp="live" />
                    <span className="name">{u.name}</span>
                    <span className="youtag">you</span>
                  </div>
                );
              }
              return (
                <button key={u.id} className="row person-row" data-person={u.name}
                  title={`Open your chat with ${u.name}`}
                  onClick={() => openDm(u.id, u.name)}>
                  <PersonFace name={u.name} size={26} lamp="idle" />
                  <span className="name">{u.name}</span>
                  <span className="rowhint">Message</span>
                </button>
              );
            })}
            {secPeople.open && people.length <= 1 && (owner
              ? <RailEmpty text="Only you so far." action="Invite a friend" onAction={openInvite} />
              : <div className="railempty"><span>Only you so far. Vikas adds people to this Cloud9.</span></div>
            )}
          </div>

          <div className="sidebar-foot rail-foot">
            <div className="me-line">
              <div className="me">{initials(world.me?.name ?? "?")}</div>
              <div style={{ minWidth: 0 }}>
                <div className="me-name">{world.me?.name ?? "—"}</div>
                <div className="me-sub">
                  {agents.length} {agents.length === 1 ? "agent" : "agents"}
                  {pendingApprovals > 0 ? ` · ${pendingApprovals} waiting` : ""}
                </div>
              </div>
            </div>
            <div className="railtools">
              <button className="railtool" title="The whole crew" onClick={() => setModal("crew")}>◲ Crew</button>
              <button className={`railtool ${pendingApprovals > 0 ? "alert" : ""}`} onClick={() => setModal("tasks")}>
                ☑ Tasks{pendingApprovals > 0 ? ` (${pendingApprovals})` : ""}
              </button>
              <button className="railtool" title="Activity"
                onClick={() => { client.send({ type: "activity", limit: 100 }); setModal("activity"); }}>🕘 Activity</button>
              <button className="railtool" title="Settings" onClick={() => setModal("settings")}>⚙ Settings</button>
            </div>
          </div>
        </nav>

        {active ? (
          <ChatView channel={active} showDetails={details} onToggleDetails={() => setDetails(d => !d)}
            lastRead={lastRead[active.id] ?? 0}
            findOpen={findOpen} onCloseFind={() => setFindOpen(false)} />
        ) : (
          <div className="main">
            <div className="empty">
              <div className="empty-mark" aria-hidden="true">#</div>
              <h2>No channel yet</h2>
              <p>Channels are rooms where you, your friends and your agents talk together.</p>
              <button className="primary" onClick={() => setModal("channel")}>Make your first channel</button>
            </div>
          </div>
        )}

        {active && details && <DetailsRail channel={active} onClose={() => setDetails(false)}
          onEditAgent={a => setEditAgent(a)} onOpenDm={openDm} />}
      </div>

      {/* the Toast is mounted at the app root now (B1) — it must be reachable
          from the welcome screen too, not only from in here */}
      {quick && <QuickChat onClose={() => setQuick(false)} />}
      {modal === "agent" && <AgentModal onClose={() => setModal(null)} />}
      {modal === "invite" && <InviteModal onClose={() => setModal(null)} />}
      {modal === "settings" && <SettingsModal onClose={() => setModal(null)} />}
      {modal === "channel" && <ChannelModal onClose={() => setModal(null)} />}
      {modal === "tasks" && <TasksModal onClose={() => setModal(null)} />}
      {modal === "activity" && <ActivityModal onClose={() => setModal(null)} />}
      {modal === "crew" && <CrewScreen
        onClose={() => setModal(null)}
        onHire={() => setModal("agent")}
        onEdit={a => { setModal(null); setEditAgent(a); }}
        onOpen={(id, name) => { setModal(null); openDm(id, name); }} />}
      {editAgent && <AgentEditModal agent={editAgent} onClose={() => setEditAgent(null)} />}
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

/* ---- the strip along the top, where a desktop app keeps its menu ---- */

function TopBar({
  connected, meName, pendingApprovals, onQuick, onTasks, onActivity, onSettings,
}: {
  connected: boolean; meName?: string; pendingApprovals: number;
  onQuick: () => void; onTasks: () => void; onActivity: () => void; onSettings: () => void;
}): React.JSX.Element {
  const p = usePrefs();
  // the toggle must answer what you are LOOKING at, not what the setting says:
  // "match this computer" can already be showing you the dark look
  const [darkNow, setDarkNow] = useState(isDarkNow);
  useEffect(() => { setDarkNow(isDarkNow()); }, [p.theme]);
  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = () => setDarkNow(isDarkNow());
    mq?.addEventListener?.("change", onChange);
    return () => mq?.removeEventListener?.("change", onChange);
  }, []);
  const nextTheme = darkNow ? "light" : "dark";
  return (
    <header className="topbar">
      <div className="tb-left">
        <span className={`tb-lamp ${connected ? "ok" : ""}`} aria-hidden="true" />
        <span className="tb-work">Cloud9</span>
        <span className="tb-sub">{connected ? `on the floor as ${meName ?? "you"}` : "reconnecting…"}</span>
      </div>
      <button className="tb-search" onClick={onQuick}>
        <span className="tb-mag" aria-hidden="true">⌁</span>
        Ask anyone, or jump to a room
        <span className="tb-kbd">Ctrl K</span>
      </button>
      <div className="tb-right">
        <button className="tb-btn" title={`Switch to the ${nextTheme} look`}
          aria-label={`Switch to the ${nextTheme} look`}
          onClick={() => prefs.set({ theme: nextTheme })}>{darkNow ? "☀" : "☾"}</button>
        <button className={`tb-btn ${pendingApprovals > 0 ? "alert" : ""}`} title="Jobs you handed over" onClick={onTasks}>
          ☑{pendingApprovals > 0 && <span className="tb-dot" />}
        </button>
        <button className="tb-btn" title="Activity" onClick={onActivity}>🕘</button>
        <button className="tb-btn" title="Settings" onClick={onSettings}>⚙</button>
        <span className="tb-me" title={meName}>{initials(meName ?? "?")}</span>
      </div>
    </header>
  );
}

function SectionHead({
  label, count, open, onToggle, actionTitle, onAction,
}: {
  label: string; count?: number; open: boolean; onToggle: () => void;
  actionTitle?: string; onAction?: () => void;
}): React.JSX.Element {
  return (
    <div className="sect">
      <button className="secttoggle" aria-expanded={open} onClick={onToggle}>
        <span className={`caret ${open ? "open" : ""}`} aria-hidden="true">▸</span>
        <span>{label}</span>
      </button>
      <span className="rule" />
      {count !== undefined && <span className="count">{count}</span>}
      {onAction && (
        <button title={actionTitle} aria-label={actionTitle} onClick={onAction}>＋</button>
      )}
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

/** Presence line for the rail — built only from what the app really knows. */
function agentStatusLine(a: AgentDef, status?: string): { line: string; lamp: string; busy: boolean } {
  const provider = (a.provider ?? "claude") as Provider;
  const runsOn = PROVIDER_LABEL[provider] ?? "Claude";
  // never claim a model the run will not use — the engine only passes --model
  // when the agent actually stores one
  const model = modelWords(a.model);
  if (a.lifecycle === "paused") return { line: "paused", lamp: "off", busy: false };
  if (a.lifecycle === "disabled") return { line: "switched off", lamp: "off", busy: false };
  if (status === "working") return { line: "working now", lamp: "run", busy: true };
  if (status === "braked") return { line: "taking a break", lamp: "off", busy: false };
  return { line: `${runsOn} · ${model}`, lamp: "live", busy: false };
}

/* ================= chat ================= */

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
 * agent's own previous post — that ask was already answered, so claiming it
 * again would be inventing a link the app does not have.
 */
function findAsk(messages: Message[], i: number, agent: Message): Message | undefined {
  const at = new RegExp(`@${agent.authorName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
  for (let j = i - 1; j >= 0 && j >= i - 15; j--) {
    const p = messages[j];
    if (p.authorKind === "agent" && p.authorId === agent.authorId) return undefined;
    if (p.authorKind === "human" && at.test(p.text)) return p;
  }
  return undefined;
}

function ChatView(
  { channel, showDetails, onToggleDetails, lastRead, findOpen, onCloseFind }:
  {
    channel: Channel; showDetails: boolean; onToggleDetails: () => void; lastRead: number;
    findOpen: boolean; onCloseFind: () => void;
  },
): React.JSX.Element {
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

  const peer = channel.kind === "dm"
    ? people.find(u => u.id !== world.me?.id)?.name ?? agents.find(a => a.id !== world.me?.id)?.name ?? channel.name
    : null;

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

  return (
    <div className="main">
      <header className="chathead">
        <div className="ch-title">
          {channel.kind === "dm"
            ? <span className="n">{peer}</span>
            : <><span className="h">#</span><span className="n">{channel.name}</span></>}
        </div>
        <div className="meta">
          {people.length} {people.length === 1 ? "person" : "people"} · {agents.length} {agents.length === 1 ? "agent" : "agents"}
        </div>
        <div className="spacer" />
        <div className="face-stack" aria-label="Who is here">
          {people.slice(0, 3).map(u => <span key={u.id} className="face" title={u.name}>{initials(u.name)}</span>)}
          {agents.slice(0, 3).map(a => (
            <span key={a.id} className="face agent" title={a.name}>
              <Portrait identity={a.name} size={22} />
            </span>
          ))}
        </div>
        <AddToChannel channel={channel} />
        <button className="tbtn" onClick={onToggleDetails} aria-pressed={showDetails}>
          {showDetails ? "Hide details" : "Details"}
        </button>
      </header>

      {findOpen && (
        <div className="findbar" role="search">
          <span className="find-mark" aria-hidden="true">⌕</span>
          <input ref={findRef} className="find-input" type="text" value={find}
            placeholder={`Find in ${channel.kind === "dm" ? "this conversation" : `#${channel.name}`}…`}
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

      <div className="stream" ref={streamRef}>
        {needle && messages.length === 0 && (
          <div className="empty">
            <div className="empty-mark" aria-hidden="true">⌕</div>
            <h2>Nothing here says “{find.trim()}”</h2>
            <p>Try a shorter word, or close the find bar to see everything again.</p>
          </div>
        )}
        {!needle && messages.length === 0 && (
          <div className="empty">
            <div className="empty-mark" aria-hidden="true">{channel.kind === "dm" ? "✉" : "#"}</div>
            <h2>{channel.kind === "dm" ? `This is the start of your chat with ${peer}` : `Nothing said in #${channel.name} yet`}</h2>
            <p>Type below to start it. Put <code>@</code> in front of an agent's name to hand it a job,
              and add <code>!bg</code> when it should work in the background.</p>
          </div>
        )}
        {rows.map(r => (
          <React.Fragment key={r.m.id}>
            {r.dayStart && (
              <div className="day"><span className="rule" /><span className="tag">{dayLabel(r.m.ts)}</span><span className="rule" /></div>
            )}
            {r.firstUnread && (
              <div className="newline" role="separator"><span className="rule" /><span className="tag">New</span></div>
            )}
            <MessageRow row={r} agent={world.agents.find(a => a.id === r.m.authorId)}
              working={world.agentStatus[r.m.authorId] === "working"} />
          </React.Fragment>
        ))}
        {working.map(a => (
          <div className="typing" key={a.id}>
            <span className="av2"><span className="bars" aria-hidden="true"><i /><i /><i /><i /><i /></span></span>
            <span>{a.name} is working on it</span>
          </div>
        ))}
      </div>

      <div className="dock">
        {myApprovals.length > 0 && <div className="approvals">
        {myApprovals.map(ap => {
          const agent = world.agents.find(a => a.id === ap.agentId);
          const task = world.tasks.find(t => t.id === ap.taskId);
          const extra = task && !ap.action.includes(task.title) ? task.title : null;
          return (
            <div className="approve" key={ap.id} role="status">
              <div className="ic">
                {agent ? <Portrait identity={agent.name} size={34} /> : <span aria-hidden="true">?</span>}
              </div>
              <div className="copy">
                <div className="h">{agent?.name ?? "An agent"} is waiting on you</div>
                <div className="d">{ap.action}{extra ? <> — <b>{extra}</b></> : null}</div>
                <div className="approve-note">Nothing has been spent or changed yet.</div>
              </div>
              <button className="btn"
                onClick={() => client.send({ type: "decideApproval", approvalId: ap.id, decision: "rejected" })}>
                Not now
              </button>
              <button className="btn go"
                onClick={() => client.send({ type: "decideApproval", approvalId: ap.id, decision: "approved" })}>
                Go ahead
              </button>
            </div>
          );
        })}
        </div>}
        <Composer channel={channel} />
      </div>
    </div>
  );
}

function MessageRow({ row, agent, working }: { row: Row; agent?: AgentDef; working?: boolean }): React.JSX.Element {
  const { m, cont, ask } = row;
  const parts = m.text.split(/(@[\w-]+)/g);
  const isAgent = m.authorKind === "agent";
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(m.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => setCopied(false));
  };

  const actions = (
    <div className="msgactions">
      <button className="ma" title={`Write back to ${m.authorName}`}
        onClick={() => composerInsert?.(`@${m.authorName} `)}>↩</button>
      <button className="ma" title="Copy this message" onClick={copy}>{copied ? "✓" : "⧉"}</button>
    </div>
  );

  const text = (
    <p>{parts.map((p, i) => p.startsWith("@")
      ? <span key={i} className="mention">{p}</span>
      : p)}</p>
  );

  if (cont) {
    return (
      <article className="msg cont">
        <div className="when-gutter">{clock(m.ts)}</div>
        <div className="body">{text}</div>
        {actions}
      </article>
    );
  }

  /* RUN STRIP — only the facts the app actually holds. */
  const strip: React.ReactNode[] = [];
  if (isAgent) {
    if (m.proactive) strip.push(<span className="selfstart" key="self">Started on its own</span>);
    else if (ask) strip.push(<span key="ask">asked by <b>@{ask.authorName}</b></span>);
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

  return (
    <article className={`msg ${isAgent ? "from-agent" : ""} ${m.proactive ? "proactive" : ""}`}>
      <div className="slot">
        {isAgent
          ? <AgentFace name={m.authorName} size={36} lamp={working ? "run" : "live"} />
          : <PersonFace name={m.authorName} size={36} />}
      </div>
      <div className="body">
        <div className="hdr">
          <span className="who">{m.authorName}</span>
          {isAgent && <span className="badge">Agent</span>}
          <span className="when">{clock(m.ts)}</span>
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
        {text}
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
      className="tbtn"
      aria-label="Add someone to this channel"
      value=""
      onChange={e => { if (e.target.value) client.send({ type: "addMembers", channelId: channel.id, memberIds: [e.target.value] }); }}
    >
      <option value="">＋ Add member…</option>
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

  // let a message row write into this composer
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

  const target = channel.kind === "dm" ? channel.name : `#${channel.name}`;

  return (
    <div className="composer">
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
      <div className="ctools">
        <button className="ct" title="Bold" onClick={() => wrap("**")}><b>B</b></button>
        <button className="ct ital" title="Italic" onClick={() => wrap("_")}><i>I</i></button>
        <button className="ct mono" title="Code" onClick={() => wrap("`")}>{"</>"}</button>
        <span className="ctsep" />
        <button className="ct mono" title="Call an agent by name" onClick={() => insert("@")}>@</button>
        <button className="ct mono" title="Hand this over as background work" onClick={() => insert("!bg ")}>!bg</button>
        <span className="ctsep" />
        <button className="ct" title="Emoji" aria-expanded={emojiOpen}
          onClick={() => setEmojiOpen(o => !o)}>🙂</button>
        <span className="chint">@ an agent to hand it a job</span>
        {emojiOpen && (
          <div className="emojipop">
            {QUICK_EMOJI.map(e => (
              <button key={e} onClick={() => { insert(e); setEmojiOpen(false); }}>{e}</button>
            ))}
          </div>
        )}
      </div>
      <textarea
        ref={taRef}
        value={text}
        placeholder={`Message ${target}`}
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
      <div className="cbar">
        <span className="who-as">posting as {world.me?.name ?? "you"}</span>
        <span className="cbar-hint">Enter sends · Shift + Enter starts a new line</span>
        <span className="spacer" />
        <button className="send" onClick={sendNow} disabled={!text.trim()}>Send <span className="k">↵</span></button>
      </div>
    </div>
  );
}

/* ================= details rail ================= */

function DetailsRail({ channel, onClose, onEditAgent, onOpenDm }: {
  channel: Channel; onClose: () => void;
  onEditAgent: (a: AgentDef) => void;
  onOpenDm: (id: ID, name: string) => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const agents = channel.memberIds.map(id => world.agents.find(a => a.id === id)).filter(Boolean) as AgentDefPlus[];
  // one row per person, however many times the relay lists them (his 15)
  const people = onePerPerson(
    channel.memberIds.map(id => world.users.find(u => u.id === id)).filter(Boolean) as User[]);
  const tasks = world.tasks.filter(t => t.channelId === channel.id);

  return (
    <aside className="details" aria-label="Channel details">
      <div className="d-head">
        <span className="t">{channel.kind === "dm" ? channel.name : `#${channel.name}`}</span>
        <button className="x" title="Hide details" aria-label="Hide details" onClick={onClose}>✕</button>
      </div>
      <div className="d-scroll">
        <div className="d-sect">
          <span className="tag">The crew in here</span>
          {agents.length === 0 && <div className="d-empty">No agents in this room yet. Use ＋ Add member above to bring one in.</div>}
          {agents.map(a => {
            const s = agentStatusLine(a, world.agentStatus[a.id]);
            const provider = (a.provider ?? "claude") as Provider;
            return (
              <div className="d-agent" key={a.id}>
                <AgentFace name={a.name} size={36} lamp={s.lamp} />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <div className="n">{a.name}</div>
                  <div className={`s ${s.busy ? "busy" : ""}`}>
                    {s.busy ? "Working now" : roleOf(a.persona)}
                  </div>
                  <div className="runs" title={a.model ? undefined : MODEL_UNSET_HINT}>
                    {PROVIDER_LABEL[provider]} · {modelWords(a.model)}
                    {(a.skills?.length ?? 0) > 0 &&
                      ` · ${a.skills!.length} ${a.skills!.length === 1 ? "skill" : "skills"}`}
                  </div>
                </span>
                <span className="d-agent-tools">
                  <button className="iconbtn" title={`Open your chat with ${a.name}`}
                    onClick={() => onOpenDm(a.id, a.name)}>✉</button>
                  {a.ownerId === world.me?.id &&
                    <button className="iconbtn" title={`Edit ${a.name}`} onClick={() => onEditAgent(a)}>✎</button>}
                </span>
              </div>
            );
          })}
        </div>

        <div className="d-sect">
          <span className="tag">People</span>
          {people.length === 0 && <div className="d-empty">Nobody else here yet.</div>}
          {people.map(u => (
            <div className="member" key={u.id}>
              <PersonFace name={u.name} size={30} lamp={u.id === world.me?.id ? "live" : "idle"} />
              <span className="n">{u.name}</span>
              <span className="r">{u.invitedBy ? "member" : "owner"}</span>
              {u.id !== world.me?.id &&
                <button className="iconbtn" title={`Open your chat with ${u.name}`}
                  onClick={() => onOpenDm(u.id, u.name)}>✉</button>}
            </div>
          ))}
        </div>

        <div className="d-sect">
          <span className="tag">Jobs from this channel</span>
          {tasks.length === 0 && <div className="d-empty">Nothing handed over yet. Ask an agent with @name !bg.</div>}
          {tasks.map(t => {
            const agent = world.agents.find(a => a.id === t.agentId);
            return (
              <div className="d-task" key={t.id}>
                <span style={{ minWidth: 0 }}>
                  <div className="n">{t.title}</div>
                  <div className="s">
                    {agent?.name ?? "agent"} · <span className={`tstatus ${t.status}`}>{STATUS_LABEL[t.status] ?? t.status}</span>
                  </div>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

/* ================= the crew (call sheet) ================= */

/** The first plain sentence of what you wrote them — their job title. */
const roleOf = (persona: string): string => {
  const first = persona.trim().split(/(?<=[.!?])\s+/)[0] ?? "";
  return first.length > 90 ? `${first.slice(0, 88).trim()}…` : first || "No job written yet";
};

function CrewScreen({ onClose, onHire, onEdit, onOpen }: {
  onClose: () => void;
  onHire: () => void;
  onEdit: (a: AgentDef) => void;
  onOpen: (id: ID, name: string) => void;
}): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [filter, setFilter] = useState<"all" | "working" | "off">("all");
  const agents = world.agents as AgentDefPlus[];

  const waitingOn = (id: ID) =>
    world.approvals.some(a => a.status === "pending" && a.agentId === id && a.ownerId === world.me?.id);

  const workingCount = agents.filter(a => world.agentStatus[a.id] === "working").length;
  const waitingCount = agents.filter(a => waitingOn(a.id)).length;

  const shown = agents.filter(a => {
    if (filter === "working") return world.agentStatus[a.id] === "working";
    if (filter === "off") return a.lifecycle === "paused" || a.lifecycle === "disabled";
    return true;
  });

  const byProvider = (p: Provider) => agents.filter(a => (a.provider ?? "claude") === p).length;

  return (
    <div className="overlay crewoverlay" onClick={onClose}>
      <div className="crew" onClick={e => e.stopPropagation()}>
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
            <div className="stat"><div className="n">{agents.length}</div><div className="l">On the books</div></div>
          </div>
        </header>

        <div className="crew-bar">
          <div className="segmented" role="group" aria-label="Who to show">
            <button className={filter === "all" ? "on" : ""} aria-pressed={filter === "all"}
              onClick={() => setFilter("all")}>Everyone</button>
            <button className={filter === "working" ? "on" : ""} aria-pressed={filter === "working"}
              onClick={() => setFilter("working")}>Working</button>
            <button className={filter === "off" ? "on" : ""} aria-pressed={filter === "off"}
              onClick={() => setFilter("off")}>Off duty</button>
          </div>
          {byProvider("claude") > 0 && <span className="chip is-gold">Claude · {byProvider("claude")}</span>}
          {byProvider("codex") > 0 && <span className="chip is-ultra">Codex · {byProvider("codex")}</span>}
          <span className="grow" />
          <button className="primary" onClick={onHire}>Hire an agent</button>
          <button className="ghostbtn crew-close" onClick={onClose}>Back to chat</button>
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
              const s = agentStatusLine(a, world.agentStatus[a.id]);
              const provider = (a.provider ?? "claude") as Provider;
              const waiting = waitingOn(a.id);
              const flag = waiting
                ? <span className="chip is-gold">Waiting on you</span>
                : world.agentStatus[a.id] === "working"
                  ? <span className="chip is-pine">Working</span>
                  : a.lifecycle && a.lifecycle !== "enabled"
                    ? <span className="chip">Off duty</span>
                    : <span className="chip">Free</span>;
              return (
                <article className="cast" key={a.id} data-crew={a.name}>
                  <div className="plate">
                    <Portrait identity={a.name} fill
                      working={world.agentStatus[a.id] === "working"} />
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
                    <div className="now"><span>
                      {waiting ? "Waiting on your word before it carries on"
                        : world.agentStatus[a.id] === "working" ? "On a job right now"
                        : a.lifecycle === "paused" ? "Paused — it will not answer until you switch it back on"
                        : a.lifecycle === "disabled" ? "Switched off"
                        : "Free — nothing running"}
                    </span></div>
                  </div>
                  <div className="castbtns">
                    <button className="btn" onClick={() => onOpen(a.id, a.name)}>Talk to {a.name}</button>
                    {a.ownerId === world.me?.id &&
                      <button className="btn" onClick={() => onEdit(a)}>Edit</button>}
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
    </div>
  );
}

/* ================= quick chat (⌘K) ================= */

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
        // channel frame will arrive; send after a beat
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

  const body = (
    <div className="panel qc-panel" onClick={e => e.stopPropagation()}>
      <div className="qc-top">
      <svg className="qc-bolt" width="19" height="19" viewBox="0 0 24 24" fill="none"
        stroke="var(--marigold)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
        aria-hidden="true"><path d="M13.5 3 5 13.5h5.6L9.8 21l8.7-10.6h-5.7Z" /></svg>
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
      <span className="kbd qc-esc">Esc</span>
      </div>
      {sent && <div className="qc-hint sent">{sent}</div>}
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
          </div>
        ))}
      </div>
      <div className="qc-hint">↑↓ choose · Enter sends · Esc closes — nothing is posted to a channel unless you pick one</div>
    </div>
  );

  if (standalone) return <div style={{ paddingTop: 20 }}>{body}</div>;
  return <div className="overlay" onClick={onClose}>{body}</div>;
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

function RunsOn({
  provider, model, onProvider, onModel,
}: {
  provider: Provider; model: string;
  onProvider: (p: Provider) => void; onModel: (m: string) => void;
}): React.JSX.Element {
  const { ids, fallback, preferred } = useModels(provider);

  // an agent must never end up without a model
  useEffect(() => {
    if (!model || !ids.includes(model)) onModel(preferred);
  }, [provider, ids.join(","), model]);

  return (
    <div className="runsonbox">
      <div className="runsongrid">
        <div>
          <label>App it runs on</label>
          <select className="providerpick" value={provider}
            onChange={e => onProvider(e.target.value as Provider)}>
            <option value="claude">🟣 Claude — your Claude app</option>
            <option value="codex">🟢 Codex — your Codex app</option>
          </select>
        </div>
        <div>
          <label>Model</label>
          <select className="modelpick" value={ids.includes(model) ? model : preferred}
            onChange={e => onModel(e.target.value)}>
            {ids.map(id => <option key={id} value={id}>{modelLabel(id)}</option>)}
          </select>
        </div>
      </div>
      <div className="hint">
        {fallback
          ? "This is the list Cloud9 ships with. Once the app is signed in under ⚙ Settings, its own list is used."
          : `${ids.length} models offered by your ${PROVIDER_LABEL[provider]} app.`}
      </div>
    </div>
  );
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
      // them is how editing a skill used to silently delete its uploaded
      // documents — the one thing an edit must never do.
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
   * Read one uploaded file into a skill.
   *
   * The old version poured the text into `instructions` and stopped there, so
   * `AgentSkill.files` was never populated and the engine's skill-file writer
   * could never fire. Now the file goes BOTH places, and each place does its own
   * job: `instructions` is what the agent is told in the prompt, `files[]` is
   * what actually lands in the agent's folder — which is the only way a document
   * longer than the instructions ceiling survives at all.
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
        <label>Skills — things you have taught this agent</label>
        <div className="skillheadbtns">
          <button className="ghostbtn small skill-add" onClick={startAdd}>＋ Write a skill</button>
          <label className="ghostbtn small skill-uploadlabel">
            ⬆ Upload a file
            <input className="skill-upload" type="file" accept=".md,.txt" multiple
              onChange={e => { void upload(e.target.files); e.target.value = ""; }} />
          </label>
        </div>
      </div>

      {skills.length === 0 && !adding && (
        <div className="skillempty">
          No skills yet. A skill is a short note telling this agent how to do one job —
          for example "Weekly report: pull the week's notes and write five bullet points."
        </div>
      )}

      <div className="skilllist">
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
      </div>

      {(adding || openId) && (
        <div className="skillform">
          <div>
            <label>Skill name</label>
            <input className="skill-name-input" type="text" value={draft.name}
              placeholder="Weekly report"
              onChange={e => setDraft(d => ({ ...d, name: e.target.value }))} />
          </div>
          <div>
            <label>What does it do?</label>
            <input className="skill-desc-input" type="text" value={draft.description}
              placeholder="Writes the Monday summary of last week"
              onChange={e => setDraft(d => ({ ...d, description: e.target.value }))} />
          </div>
          <div>
            <label>How should it do it?</label>
            <textarea className="skill-instructions-input" rows={4} value={draft.instructions}
              placeholder="Read the notes from the last seven days. Write five bullet points: what moved, what stalled, what needs me."
              onChange={e => setDraft(d => ({ ...d, instructions: e.target.value }))} />
          </div>
          <div>
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
              <label className="ghostbtn small skill-attachlabel">
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

/* ================= modals ================= */

function AgentModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const p = usePrefs();
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("✨");
  const [persona, setPersona] = useState("");
  const [ab, setAb] = useState({ webSearch: true, files: false, schedules: false, background: true });
  const [ap, setAp] = useState({ background: false, schedules: false });
  const [provider, setProvider] = useState<Provider>(p.defaultProvider ?? "claude");
  const [model, setModel] = useState<string>(p.defaultModel?.[p.defaultProvider ?? "claude"] ?? MODEL_DEFAULT.claude);
  const [skills, setSkills] = useState<AgentSkill[]>([]);

  const create = () => {
    if (!name.trim() || !persona.trim()) return;
    const agent = {
      name: name.trim().replace(/\s+/g, "-"), emoji, persona: persona.trim(),
      abilities: ab, approvals: ap, provider,
      model: model || MODEL_DEFAULT[provider],
      skills,
    };
    client.send({ type: "createAgent", agent });
    onClose();
  };

  const ready = !!name.trim() && !!persona.trim();

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel agentpanel" onClick={e => e.stopPropagation()}>
        <div className="head">Hire an agent<span className="eyebrow">Plain words only</span></div>
        <div className="castpreview">
          <Portrait identity={name || "new agent"} size={96} />
          <div style={{ minWidth: 0 }}>
            <div className="cp-name">{name.trim() || "Unnamed"}</div>
            <div className="cp-role">{persona.trim() ? roleOf(persona) : "No job written yet"}</div>
            <div className="cp-chips">
              <span className={`chip ${provider === "claude" ? "is-gold" : "is-ultra"}`}>{PROVIDER_LABEL[provider]}</span>
              <span className="chip">{modelLabel(model)}</span>
            </div>
          </div>
        </div>
        <div className="body">
          <div className="row">
            <div><label>Name <span className="hint">no spaces — this is what you type after @</span></label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Scout" /></div>
            <div style={{ maxWidth: 96 }}><label>Emoji <span className="hint">for lists</span></label>
              <input type="text" value={emoji} onChange={e => setEmoji(e.target.value)} /></div>
          </div>
          <div><label>What they do, in your words</label>
            <textarea className="persona-input" rows={4} value={persona} onChange={e => setPersona(e.target.value)}
              placeholder="You're my travel researcher. You find flights, villas and hidden gems, always with prices and links, always under budget." /></div>

          <RunsOn provider={provider} model={model} onProvider={setProvider} onModel={setModel} />

          <div><label>Abilities</label>
            <div className="checks">
              <label><input type="checkbox" checked={ab.webSearch} onChange={e => setAb({ ...ab, webSearch: e.target.checked })} /> 🔎 Web search</label>
              <label><input type="checkbox" checked={ab.files} onChange={e => setAb({ ...ab, files: e.target.checked })} /> 📁 Files folder</label>
              <label><input type="checkbox" checked={ab.schedules} onChange={e => setAb({ ...ab, schedules: e.target.checked })} /> ⏰ Schedules</label>
              <label><input type="checkbox" checked={ab.background} onChange={e => setAb({ ...ab, background: e.target.checked })} /> 📦 Background jobs</label>
            </div></div>

          <SkillsEditor skills={skills} onChange={setSkills} />

          <div><label>Ask me first before…</label>
            <div className="checks">
              <label><input type="checkbox" checked={ap.background} onChange={e => setAp({ ...ap, background: e.target.checked })} /> 🔒 Background work</label>
              <label><input type="checkbox" checked={ap.schedules} onChange={e => setAp({ ...ap, schedules: e.target.checked })} /> 🔒 Making a schedule</label>
            </div></div>
        </div>
        <div className="foot">
          {!ready && <span className="footnote">Give it a name and a personality to finish.</span>}
          <button className="subtle" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={create} disabled={!ready}>Create agent</button>
        </div>
      </div>
    </div>
  );
}

function InviteModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [copied, setCopied] = useState(false);
  const code = world.inviteCode;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={e => e.stopPropagation()}>
        <div className="head">Invite a friend</div>
        <div className="body">
          <div className="notice">Send them this one-time code. They pick "I have an invite" on the welcome screen. They'll land in #general.</div>
          <div className="code">{code ?? "generating…"}</div>
          <div>
            <button className="ghostbtn" disabled={!code}
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
          <div><label>Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value.replace(/\s+/g, "-").toLowerCase())} placeholder="trip-goa" /></div>
          <div><label>Members</label>
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

/* ---- Settings ----
 * No credential ever lives in the browser. The buttons ask the engine host to
 * run the provider's own sign-in; the app only ever displays status, and any
 * fallback key is handed straight to the desktop shell for encrypted storage
 * (docs/plans/harness-signin.md decision 4). */

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
  /** Builder A may add these; the renderer only ever asks politely. */
  openAgentFolder?: () => Promise<IpcResult>;
  agentFolder?: () => Promise<string>;
}
const desktop = (): DesktopBridge | undefined =>
  (window as unknown as { cloud9?: DesktopBridge }).cloud9;

function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const p = usePrefs();
  const [stored, setStored] = useState<CredentialStatus | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [folderNote, setFolderNote] = useState<string | null>(null);

  const refreshStored = () => {
    void desktop()?.credentialStatus?.().then(setStored).catch(() => setStored(null));
  };
  // Every harness frame is owner-only in the relay, and so is the whole "Your
  // AI apps" section below. Asking as a guest earned an error toast about
  // something they never did — the same rule as the invite button, applied to
  // the whole category: don't ask for, and don't offer, what can only be refused.
  const owner = isOwner(world.me);

  useEffect(() => {
    if (!owner) { refreshStored(); return; }
    // the contract's explicit refresh, plus the frame today's engine understands
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

  const claudeInfo = world.harness?.claude;
  const codexInfo = world.harness?.codex;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel settingspanel" onClick={e => e.stopPropagation()}>
        <div className="head">Setup<span className="eyebrow">Saved as you change it</span></div>
        <div className="body settingsbody">
          <nav className="setnav" aria-label="Settings sections">
            <a href="#set-look">Look</a>
            <a href="#set-agents">New agents</a>
            <a href="#set-notify">Notifications</a>
            <a href="#set-files">Files</a>
            {/* the section exists for everyone — it just says something different
                to a guest, who has nothing here to sign in to */}
            <a href="#set-apps">Your AI apps</a>
            <a href="#set-danger">Danger zone</a>
          </nav>

          <div className="setmain">
            <section id="set-look" className="setsect">
              <h3>Look</h3>
              <p className="setwhy">How Cloud9 looks on this computer.</p>
              <div className="segmented" role="group" aria-label="Appearance">
                {(["light", "dark", "system"] as const).map(t => (
                  <button key={t} className={p.theme === t ? "on" : ""}
                    aria-pressed={p.theme === t}
                    onClick={() => prefs.set({ theme: t })}>
                    {t === "light" ? "☀ Light" : t === "dark" ? "☾ Dark" : "🖥 Match this computer"}
                  </button>
                ))}
              </div>
              <label className="switchrow">
                <input type="checkbox" checked={p.compact} onChange={e => prefs.set({ compact: e.target.checked })} />
                <span><b>Tighter message spacing</b><em>Fits more of the conversation on screen.</em></span>
              </label>
            </section>

            <section id="set-agents" className="setsect">
              <h3>New agents</h3>
              <p className="setwhy">What a brand new agent starts with. You can change it per agent afterwards.</p>
              <div className="runsongrid">
                <div>
                  <label>App</label>
                  <select className="defaultproviderpick" value={p.defaultProvider}
                    onChange={e => prefs.set({ defaultProvider: e.target.value as Provider })}>
                    <option value="claude">🟣 Claude</option>
                    <option value="codex">🟢 Codex</option>
                  </select>
                </div>
                <div>
                  <label>Model</label>
                  <DefaultModelPick provider={p.defaultProvider} />
                </div>
              </div>
            </section>

            <section id="set-notify" className="setsect">
              <h3>Notifications</h3>
              <p className="setwhy">Pop-ups on this computer when someone or an agent writes while Cloud9 is in the background.</p>
              <label className="switchrow">
                <input type="checkbox" checked={p.notify} onChange={e => askNotify(e.target.checked)} />
                <span><b>Tell me about new messages</b>
                  <em>{typeof Notification !== "undefined" && Notification.permission === "denied"
                    ? "This computer is blocking Cloud9's pop-ups — allow them in your system settings."
                    : "Your computer will ask permission the first time."}</em></span>
              </label>
              <label className="switchrow">
                <input type="checkbox" checked={p.quietOn} onChange={e => prefs.set({ quietOn: e.target.checked })} />
                <span><b>Quiet hours</b><em>No pop-ups between these times.</em></span>
              </label>
              <div className="quietrow">
                <div><label>From</label>
                  <input type="time" value={p.quietFrom} disabled={!p.quietOn}
                    onChange={e => prefs.set({ quietFrom: e.target.value })} /></div>
                <div><label>Until</label>
                  <input type="time" value={p.quietTo} disabled={!p.quietOn}
                    onChange={e => prefs.set({ quietTo: e.target.value })} /></div>
              </div>
            </section>

            <section id="set-files" className="setsect">
              <h3>Files</h3>
              <p className="setwhy">Where your agents keep the files they make and read.</p>
              <div className="pathbox">{folder ?? "cloud9-engine-data — inside the Cloud9 folder on this computer"}</div>
              <div className="harnessbtns">
                <button className="ghostbtn" disabled={!desktop()?.openAgentFolder}
                  onClick={() => {
                    void desktop()?.openAgentFolder?.()
                      .then(r => setFolderNote(r?.ok ? "Opened the folder." : r?.error ?? "That folder could not be opened."))
                      .catch(() => setFolderNote("That folder could not be opened."));
                  }}>Open the folder</button>
                <button className="ghostbtn"
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
              <h3>Your AI apps</h3>
              <p className="setwhy">
                Cloud9 runs your agents through apps already installed on this computer.
                Sign in once here and your agents can work. Connect your AI apps below.
              </p>
              <HarnessCard
                harness="claude" title="Claude" emoji="🟣"
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
                harness="codex" title="Codex" emoji="🟢"
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
                <h3>Your AI apps</h3>
                <p className="setwhy">
                  The agents here run on Vikas's Claude and Codex apps, on his computer.
                  There is nothing for you to sign in to.
                </p>
              </section>
            )}

            <section id="set-danger" className="setsect danger">
              <h3>Danger zone</h3>
              <p className="setwhy">These cannot be undone from here.</p>
              <DangerZone stored={stored} onStoredChanged={refreshStored} />
            </section>
          </div>
        </div>
        <div className="foot">
          <button className="primary" onClick={onClose}>Done</button>
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
    <select className="defaultmodelpick" value={value}
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
    <div className="dangerbox">
      <div className="dangerrow">
        <span><b>Saved API keys</b><em>Only the fallback keys — your app logins are untouched.</em></span>
        <span className="dangerbtns">
          <button className="ghostbtn danger" disabled={!stored?.claude?.hasCredential}
            onClick={() => void removeKey("claude")}>Remove Claude key</button>
          <button className="ghostbtn danger" disabled={!stored?.codex?.hasCredential}
            onClick={() => void removeKey("codex")}>Remove Codex key</button>
        </span>
      </div>
      {/* Removing a person is owner-only in the relay. Same rule as the invite
          button: don't offer what can only come back as a refusal. */}
      {isOwner(world.me) && (
        <div className="dangerrow">
          <span><b>Remove a person</b><em>They can no longer read or write in your Cloud9.</em></span>
          <span className="dangerbtns">
            <select className="removepersonpick" value={confirmPerson}
              onChange={e => setConfirmPerson(e.target.value)}>
              <option value="">Choose someone…</option>
              {uniqueOthers.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <button className="ghostbtn danger" disabled={!confirmPerson} onClick={removePerson}>Remove</button>
          </span>
        </div>
      )}
      {note && <div className="notice">{note}</div>}
    </div>
  );
}

/** The sign-in card. What the button says is decided by the state — never "again". */
function HarnessCard({
  harness, title, emoji, info, checking, savedKey, onStoredChanged,
  signInLabel, fallbackLabel, fallbackHelp, disclosure,
}: {
  harness: Harness;
  title: string;
  emoji: string;
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
        <span className="harnessname">{emoji} {title}</span>
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
          <label>{title} API key</label>
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

/* ================= tasks & activity ================= */

const STATUS_LABEL: Record<string, string> = {
  not_started: "queued", working: "working", waiting_user: "waiting for you",
  waiting_approval: "needs your go-ahead", blocked: "blocked",
  completed: "done", failed: "failed", cancelled: "cancelled",
};

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

function TasksModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const agentName = (id: ID) => world.agents.find(a => a.id === id);
  const waiting = world.tasks.filter(t => {
    const ap = t.approvalId ? world.approvals.find(a => a.id === t.approvalId) : undefined;
    return ap && ap.status === "pending" && ap.ownerId === world.me?.id;
  }).length;
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" style={{ width: "min(760px,94vw)" }} onClick={e => e.stopPropagation()}>
        <div className="head">
          Tasks
          <span className="eyebrow">
            {waiting > 0 ? `${waiting} waiting on you` : "Jobs you handed out"}
          </span>
        </div>
        <div className="body">
          {world.tasks.length === 0 && (
            <EmptyTray title="Nothing handed over yet"
              line={<>Ask an agent with <code>@Agent !bg your job</code> and the result lands here.</>} />
          )}
          {world.tasks.map(t => {
            const approval = t.approvalId ? world.approvals.find(a => a.id === t.approvalId) : undefined;
            const agent = agentName(t.agentId);
            const mine = approval && approval.status === "pending" && approval.ownerId === world.me?.id;
            const cancellable = ["not_started", "working", "waiting_approval", "blocked"].includes(t.status);
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
                    <span>{agent?.name ?? "An agent"} · asked by {t.requesterName}</span>
                    <span className={`tstatus ${t.status}`}>{STATUS_LABEL[t.status] ?? t.status}</span>
                  </div>
                  {t.error && (t.status === "failed" || t.status === "cancelled") && (
                    <div className="taskresult"><b>What went wrong</b>{t.error}</div>
                  )}
                  {t.result && (
                    <div className="taskresult"><b>Result</b>{t.result.slice(0, 240)}</div>
                  )}
                </div>
                <div className="taskbtns">
                  {mine && <>
                    <button className="btn go" onClick={() => client.send({ type: "decideApproval", approvalId: approval!.id, decision: "approved" })}>Approve</button>
                    <button className="ghostbtn danger small" onClick={() => client.send({ type: "decideApproval", approvalId: approval!.id, decision: "rejected" })}>Reject</button>
                  </>}
                  {cancellable && !mine &&
                    <button className="ghostbtn small" onClick={() => client.send({ type: "cancelTask", taskId: t.id })}>Stop</button>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="foot"><button className="primary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

function ActivityModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const rows = [...world.activity].reverse();
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" style={{ width: "min(760px,94vw)" }} onClick={e => e.stopPropagation()}>
        <div className="head">Activity<span className="eyebrow">Everything that happened, and who did it</span></div>
        <div className="body">
          {rows.length === 0 && (
            <EmptyTray title="Nothing has happened yet"
              line="Every message, job and go-ahead shows up here, newest first." />
          )}
          {rows.length > 0 && (
            <div className="timeline">
              {rows.map(r => (
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
          )}
        </div>
        <div className="foot"><button className="primary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/* ================= agent edit (FR-AG-007/008) ================= */

function AgentEditModal({ agent, onClose }: { agent: AgentDef; onClose: () => void }): React.JSX.Element {
  const [persona, setPersona] = useState(agent.persona);
  const [emoji, setEmoji] = useState(agent.emoji);
  const [ab, setAb] = useState(agent.abilities);
  const [ap, setAp] = useState(agent.approvals ?? { background: false, schedules: false });
  const [life, setLife] = useState(agent.lifecycle ?? "enabled");
  const [provider, setProvider] = useState<Provider>((agent.provider ?? "claude") as Provider);
  const [model, setModel] = useState<string>(agent.model ?? MODEL_DEFAULT[(agent.provider ?? "claude") as Provider]);
  const [skills, setSkills] = useState<AgentSkill[]>(Array.isArray(agent.skills) ? agent.skills : []);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = () => {
    client.send({
      type: "updateAgent",
      agent: {
        ...agent, emoji, persona: persona.trim() || agent.persona, abilities: ab,
        approvals: ap, provider, lifecycle: life,
        model: model || MODEL_DEFAULT[provider],
        skills,
      },
    });
    onClose();
  };
  const del = () => {
    client.send({ type: "deleteAgent", agentId: agent.id });
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel agentpanel" onClick={e => e.stopPropagation()}>
        <div className="head">{agent.name}<span className="eyebrow">Editing</span></div>
        <div className="castpreview">
          <Portrait identity={agent.name} size={96} />
          <div style={{ minWidth: 0 }}>
            <div className="cp-name">{agent.name}</div>
            <div className="cp-role">{persona.trim() ? roleOf(persona) : "No job written yet"}</div>
            <div className="cp-chips">
              <span className={`chip ${provider === "claude" ? "is-gold" : "is-ultra"}`}>{PROVIDER_LABEL[provider]}</span>
              <span className="chip">{modelLabel(model)}</span>
              {life !== "enabled" && <span className="chip">Off duty</span>}
            </div>
          </div>
        </div>
        <div className="body">
          <div className="row">
            <div><label>Status</label>
              <select value={life} onChange={e => setLife(e.target.value as typeof life)}>
                <option value="enabled">▶ Enabled — responds and works</option>
                <option value="paused">⏸ Paused — silent until you switch it back on</option>
                <option value="disabled">⏹ Switched off — does nothing at all</option>
              </select></div>
            <div style={{ maxWidth: 96 }}><label>Emoji <span className="hint">for lists</span></label>
              <input type="text" value={emoji} onChange={e => setEmoji(e.target.value)} /></div>
          </div>
          <div><label>What they do, in your words</label>
            <textarea className="persona-input" rows={4} value={persona} onChange={e => setPersona(e.target.value)} /></div>

          <RunsOn provider={provider} model={model} onProvider={setProvider} onModel={setModel} />
          {!agent.model && (
            <div className="notice modelunset">
              No model is saved for {agent.name} yet, so its turns run on whatever
              its app picks. Press <b>Save</b> to pin the one shown above.
            </div>
          )}

          <div><label>Abilities</label>
            <div className="checks">
              <label><input type="checkbox" checked={ab.webSearch} onChange={e => setAb({ ...ab, webSearch: e.target.checked })} /> 🔎 Web search</label>
              <label><input type="checkbox" checked={ab.files} onChange={e => setAb({ ...ab, files: e.target.checked })} /> 📁 Files folder</label>
              <label><input type="checkbox" checked={ab.schedules} onChange={e => setAb({ ...ab, schedules: e.target.checked })} /> ⏰ Schedules</label>
              <label><input type="checkbox" checked={ab.background} onChange={e => setAb({ ...ab, background: e.target.checked })} /> 📦 Background jobs</label>
            </div></div>

          <SkillsEditor skills={skills} onChange={setSkills} />

          <div><label>Ask me first before…</label>
            <div className="checks">
              <label><input type="checkbox" checked={ap.background} onChange={e => setAp({ ...ap, background: e.target.checked })} /> 🔒 Background work</label>
              <label><input type="checkbox" checked={ap.schedules} onChange={e => setAp({ ...ap, schedules: e.target.checked })} /> 🔒 Making a schedule</label>
            </div></div>
        </div>
        <div className="foot">
          {confirmDelete ? (
            <span className="confirmdel">
              Delete {agent.name} for good?
              <button className="subtle" onClick={() => setConfirmDelete(false)}>Keep it</button>
              <button className="ghostbtn danger" onClick={del}>Yes, delete</button>
            </span>
          ) : (
            <button className="subtle danger" onClick={() => setConfirmDelete(true)}>Delete agent</button>
          )}
          <button className="subtle" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
