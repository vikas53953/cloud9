import React, {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from "react";
import { AgentDef, Channel, HarnessInfo, ID, Message, User } from "@cloud9/shared";
import { client } from "./store.js";

const isQuickWindow = location.hash === "#quick";

/* ============================================================
   CONTRACT SHAPES (docs/plans/feedback-round-1.md)
   Builder A owns packages/shared. Until those fields land there,
   the renderer describes them locally and reads them defensively,
   so an older engine or an older saved agent never crashes the app.
   ============================================================ */

type HarnessAuthKind = "cli-login" | "token" | "apiKey" | "none";

/** HarnessInfo plus the fields the contract adds. Every one is optional here. */
type HarnessInfoPlus = Partial<HarnessInfo> & {
  authKind?: HarnessAuthKind;
  models?: string[];
  defaultModel?: string;
  problem?: string;
};

/** One skill written in plain words, stored on the agent (his #9). */
interface AgentSkill {
  id: string;
  name: string;
  description: string;
  instructions: string;
}

/** Same ceilings the relay enforces — checked here so the error is friendly. */
const SKILL_MAX = { perAgent: 20, name: 64, description: 200, instructions: 8000 } as const;

/** AgentDef plus the skills list Builder A adds. */
type AgentDefPlus = AgentDef & { skills?: AgentSkill[] };

type Provider = "claude" | "codex";

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex" };
const PROVIDER_EMOJI: Record<string, string> = { claude: "🟣", codex: "🟢" };

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

  if (!joined || world.authFailed) {
    return <JoinScreen onJoin={() => setJoined(true)} />;
  }
  if (isQuickWindow) return <QuickChat standalone />;
  return <Workspace />;
}

/* ================= join / invite screen ================= */

function JoinScreen({ onJoin }: { onJoin: () => void }): React.JSX.Element {
  const [mode, setMode] = useState<"owner" | "invite">("owner");
  const [token, setToken] = useState("dev-owner-token");
  const [invite, setInvite] = useState("");
  const [name, setName] = useState("");

  const go = () => {
    const t = mode === "owner" ? token : `invite:${invite.trim()}:${name.trim() || "Friend"}`;
    client.setToken(mode === "owner" ? token : ""); // invite issues a durable token via relay
    client.connect(t);
    onJoin();
  };

  return (
    <div className="join">
      <div className="panel">
        <div className="head">☁️ Welcome to Cloud9</div>
        <div className="body">
          <div className="modeswitch">
            <button className={mode === "owner" ? "on" : ""} onClick={() => setMode("owner")}>I run this Cloud9</button>
            <button className={mode === "invite" ? "on" : ""} onClick={() => setMode("invite")}>I have an invite</button>
          </div>
          {mode === "owner" ? (
            <div>
              <label>Owner token (set when the relay was started)</label>
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
          <div className="notice">Your chats live on your crew's own relay — nothing goes to a big platform.</div>
        </div>
        <div className="foot"><button className="primary" onClick={go}>Enter Cloud9</button></div>
      </div>
    </div>
  );
}

/* ================= main workspace ================= */

type ModalName = "agent" | "invite" | "settings" | "channel" | "tasks" | "activity";

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

  const active = world.channels.find(c => c.id === activeId) ?? world.channels[0];
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

  /* ---- the app menu (Builder A sends menu:<action> from Electron) ---- */
  useEffect(() => {
    const run = (action: string) => {
      if (action === "new-agent") setModal("agent");
      else if (action === "new-channel") setModal("channel");
      else if (action === "settings") setModal("settings");
      else if (action === "quick-chat") setQuick(true);
      else if (action === "toggle-theme") {
        const now = document.documentElement.getAttribute("data-theme");
        prefs.set({ theme: now === "dark" ? "light" : "dark" });
      }
    };
    const onEvent = (e: Event) => {
      const detail = (e as CustomEvent<{ action?: string } | string>).detail;
      run(typeof detail === "string" ? detail : detail?.action ?? "");
    };
    window.addEventListener("cloud9:menu", onEvent as EventListener);
    const bridge = desktop() as (DesktopBridge & { onMenu?: (fn: (a: string) => void) => void }) | undefined;
    bridge?.onMenu?.(run);
    return () => window.removeEventListener("cloud9:menu", onEvent as EventListener);
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
      // an older install can hold a two-person room that was never tagged "dm";
      // it is still the conversation with that person, so use it rather than
      // opening a second one beside it
      ?? world.channels.find(c => has(c) && c.memberIds.length <= 2);
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
      emoji: agent?.emoji,
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

      <div className="app" data-details={details && active ? "on" : "off"} data-compact={p.compact ? "on" : "off"}>
        <nav className="sidebar rail" aria-label="Workspace">
          <div className="rail-head">
            <div className="mark" aria-hidden="true" />
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
              label="Your agents" count={agents.length} open={secAgents.open} onToggle={secAgents.toggle}
              actionTitle="New agent" onAction={() => setModal("agent")}
            />
            {secAgents.open && (agents.length === 0
              ? <RailEmpty text="No agents yet." action="Create your first agent" onAction={() => setModal("agent")} />
              : agents.map(a => {
                const s = agentStatusLine(a, world.agentStatus[a.id]);
                return (
                  <div key={a.id} className="row agent-row agentrow" data-agent={a.name} title={a.persona}>
                    <button className="agentmain" onClick={() => openDm(a.id, a.name)}
                      title={`Open your chat with ${a.name}`}>
                      <span className="av">{a.emoji}<span className={`dot ${s.lamp}`} /></span>
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
                    <span className={`av ${pr.emoji ? "" : "initials"}`}>
                      {pr.emoji ?? initials(pr.name)}
                      <span className={`dot ${pr.lamp}`} />
                    </span>
                    <span className="agent-meta">
                      <span className="agent-name">{pr.name}</span>
                      <span className={`agent-sub ${pr.busy ? "busy" : ""}`}>{pr.sub}</span>
                    </span>
                    {unread > 0 && <span className="badgecount">{unread}</span>}
                  </button>
                </div>
              );
            })}

            <SectionHead
              label="People" count={people.length} open={secPeople.open} onToggle={secPeople.toggle}
              actionTitle="Invite a friend"
              onAction={() => { client.send({ type: "createInvite" }); setModal("invite"); }}
            />
            {secPeople.open && people.map(u => {
              const isMe = u.id === world.me?.id;
              if (isMe) {
                return (
                  <div key={u.id} className="row person-row is-me" data-person={u.name}>
                    <span className="av initials">{initials(u.name)}<span className="dot live" /></span>
                    <span className="name">{u.name}</span>
                    <span className="youtag">you</span>
                  </div>
                );
              }
              return (
                <button key={u.id} className="row person-row" data-person={u.name}
                  title={`Open your chat with ${u.name}`}
                  onClick={() => openDm(u.id, u.name)}>
                  <span className="av initials">{initials(u.name)}<span className="dot idle" /></span>
                  <span className="name">{u.name}</span>
                  <span className="rowhint">Message</span>
                </button>
              );
            })}
            {secPeople.open && people.length <= 1 && (
              <RailEmpty text="Only you so far."
                action="Invite a friend"
                onAction={() => { client.send({ type: "createInvite" }); setModal("invite"); }} />
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
              <button className="railtool" title="Quick chat" onClick={() => setQuick(true)}>⌘K Quick chat</button>
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
            lastRead={lastRead[active.id] ?? 0} />
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

      <Toast />
      {quick && <QuickChat onClose={() => setQuick(false)} />}
      {modal === "agent" && <AgentModal onClose={() => setModal(null)} />}
      {modal === "invite" && <InviteModal onClose={() => setModal(null)} />}
      {modal === "settings" && <SettingsModal onClose={() => setModal(null)} />}
      {modal === "channel" && <ChannelModal onClose={() => setModal(null)} />}
      {modal === "tasks" && <TasksModal onClose={() => setModal(null)} />}
      {modal === "activity" && <ActivityModal onClose={() => setModal(null)} />}
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
      <span className="toast-text">{err.text}</span>
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
        <span className="tb-sub">{connected ? `connected as ${meName ?? "you"}` : "reconnecting…"}</span>
      </div>
      <button className="tb-search" onClick={onQuick}>
        <span className="tb-mag" aria-hidden="true">🔎</span>
        Jump to a channel, person or agent
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
  const model = modelLabel(a.model ?? MODEL_DEFAULT[provider] ?? MODEL_DEFAULT.claude);
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
  { channel, showDetails, onToggleDetails, lastRead }:
  { channel: Channel; showDetails: boolean; onToggleDetails: () => void; lastRead: number },
): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const messages = world.messages[channel.id] ?? [];
  const streamRef = useRef<HTMLDivElement>(null);
  const [openedAt] = useState(lastRead);

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
          {agents.slice(0, 3).map(a => <span key={a.id} className="face agent" title={a.name}>{a.emoji}</span>)}
        </div>
        <AddToChannel channel={channel} />
        <button className="tbtn" onClick={onToggleDetails} aria-pressed={showDetails}>
          {showDetails ? "Hide details" : "Details"}
        </button>
      </header>

      <div className="stream" ref={streamRef}>
        {messages.length === 0 && (
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
            <MessageRow row={r} agent={world.agents.find(a => a.id === r.m.authorId)} />
          </React.Fragment>
        ))}
        {working.map(a => (
          <div className="typing" key={a.id}>
            <span className="av2"><span className="bars" aria-hidden="true"><i /><i /><i /></span></span>
            <span>{a.name} is working</span>
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
              <div className="ic">{agent?.emoji ?? "🤖"}</div>
              <div className="copy">
                <div className="h">{agent?.name ?? "An agent"} needs your go-ahead</div>
                <div className="d">{ap.action}{extra ? <> — <b>{extra}</b></> : null}</div>
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

function MessageRow({ row, agent }: { row: Row; agent?: AgentDef }): React.JSX.Element {
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
        <span key="prov">
          runs on {PROVIDER_LABEL[provider] ?? "Claude"} · {modelLabel(agent.model ?? MODEL_DEFAULT[provider])}
        </span>,
      );
    }
  }

  return (
    <article className={`msg ${isAgent ? "from-agent" : ""} ${m.proactive ? "proactive" : ""}`}>
      <div className="slot">
        <div className={`avatar ${m.authorKind}`}>
          {m.authorEmoji ?? (isAgent ? "🤖" : initials(m.authorName))}
        </div>
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
          <span className="tag">Agents here</span>
          {agents.length === 0 && <div className="d-empty">No agents in this channel yet. Use ＋ Add member above to bring one in.</div>}
          {agents.map(a => {
            const s = agentStatusLine(a, world.agentStatus[a.id]);
            const provider = (a.provider ?? "claude") as Provider;
            return (
              <div className="d-agent" key={a.id}>
                <span className="av">{a.emoji}<span className={`dot ${s.lamp}`} /></span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <div className="n">{a.name}</div>
                  <div className={`s ${s.busy ? "busy" : ""}`}>{s.line}</div>
                  <div className="runs">
                    {PROVIDER_EMOJI[provider]} {PROVIDER_LABEL[provider]} · {modelLabel(a.model ?? MODEL_DEFAULT[provider])}
                  </div>
                  {(a.skills?.length ?? 0) > 0 && (
                    <div className="runs">{a.skills!.length} {a.skills!.length === 1 ? "skill" : "skills"}</div>
                  )}
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
              <span className="av initials">{initials(u.name)}
                <span className={`dot ${u.id === world.me?.id ? "live" : "idle"}`} /></span>
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
      <input
        ref={inputRef} className="qc-input" value={text}
        placeholder="Quick chat — type your message…"
        onChange={e => setText(e.target.value)}
        onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); setSel(i => (i + 1) % targets.length); }
          if (e.key === "ArrowUp") { e.preventDefault(); setSel(i => (i - 1 + targets.length) % targets.length); }
          if (e.key === "Enter") fire();
          if (e.key === "Escape") { onClose?.(); if (standalone) window.close(); }
        }}
      />
      {sent && <div className="qc-hint sent">{sent}</div>}
      {targets.length === 0 && (
        <div className="qc-empty">Nowhere to send yet. Create an agent or a channel first.</div>
      )}
      <div className="qc-list">
        {targets.map((t, i) => (
          <div key={t.id} className={`qc-opt ${i === sel ? "on" : ""}`} onClick={() => setSel(i)}>
            <span className="qc-lbl">{t.label}</span>
            <span className="qc-kind">{t.kind === "agent" ? "agent" : "channel"}</span>
          </div>
        ))}
      </div>
      <div className="qc-hint">↑↓ choose · Enter send · Esc close — works from anywhere with the global hotkey</div>
    </div>
  );

  if (standalone) return <div style={{ paddingTop: 20 }}>{body}</div>;
  return <div className="overlay" onClick={onClose}>{body}</div>;
}

/* ================= model picker (his 5, 6) ================= */

/** The models this harness really offers, or the documented set until it says. */
function useModels(provider: Provider): { ids: string[]; fallback: boolean; preferred: string } {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const info = (world.harness as unknown as Record<string, HarnessInfoPlus> | undefined)?.[provider];
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
    if (name.length > SKILL_MAX.name) { setNote(`That name is too long — keep it under ${SKILL_MAX.name} characters.`); return; }
    if (!instructions) { setNote("Write what the agent should do — a skill without instructions cannot be saved."); return; }
    if (instructions.length > SKILL_MAX.instructions) { setNote("Those instructions are too long. Trim them a little."); return; }
    if (draft.description.trim().length > SKILL_MAX.description) { setNote("Keep the one-line description shorter."); return; }
    if (!skills.some(s => s.id === draft.id) && skills.length >= SKILL_MAX.perAgent) {
      setNote(`One agent can hold ${SKILL_MAX.perAgent} skills. Delete one first.`); return;
    }
    const clean: AgentSkill = {
      id: draft.id || newId(),
      name,
      description: draft.description.trim(),
      instructions,
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

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const added: AgentSkill[] = [];
    for (const file of Array.from(files)) {
      if (!/\.(md|txt)$/i.test(file.name)) { setNote("Only .md and .txt files can be read."); continue; }
      if (skills.length + added.length >= SKILL_MAX.perAgent) {
        setNote(`One agent can hold ${SKILL_MAX.perAgent} skills. Delete one first.`); break;
      }
      const body = (await file.text()).trim();
      if (!body) { setNote(`${file.name} is empty, so there is nothing to teach.`); continue; }
      added.push({
        id: newId(),
        name: file.name.replace(/\.(md|txt)$/i, "").slice(0, SKILL_MAX.name),
        description: "Added from a file",
        instructions: body.slice(0, SKILL_MAX.instructions),
      });
    }
    if (added.length > 0) {
      onChange([...skills, ...added]);
      setNote(`Added ${added.length} ${added.length === 1 ? "skill" : "skills"} from ${added.length === 1 ? "a file" : "files"}.`);
    }
  };

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
    client.send({ type: "createAgent", agent } as unknown as Parameters<typeof client.send>[0]);
    onClose();
  };

  const ready = !!name.trim() && !!persona.trim();

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={e => e.stopPropagation()}>
        <div className="head">Create an agent</div>
        <div className="body">
          <div className="row">
            <div><label>Name (no spaces — used for @mentions)</label>
              <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="Scout" /></div>
            <div style={{ maxWidth: 90 }}><label>Emoji</label>
              <input type="text" value={emoji} onChange={e => setEmoji(e.target.value)} /></div>
          </div>
          <div><label>Personality — who is this agent, how should it behave?</label>
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
  useEffect(() => {
    // the contract's explicit refresh, plus the frame today's engine understands
    client.send({ type: "refreshHarness" } as unknown as Parameters<typeof client.send>[0]);
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

  const claudeInfo = (world.harness as unknown as Record<string, HarnessInfoPlus> | undefined)?.claude;
  const codexInfo = (world.harness as unknown as Record<string, HarnessInfoPlus> | undefined)?.codex;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel settingspanel" onClick={e => e.stopPropagation()}>
        <div className="head">⚙ Settings</div>
        <div className="body settingsbody">
          <nav className="setnav" aria-label="Settings sections">
            <a href="#set-look">Look</a>
            <a href="#set-agents">New agents</a>
            <a href="#set-notify">Notifications</a>
            <a href="#set-files">Files</a>
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
    client.send({ type: "removeUser", userId: confirmPerson } as unknown as Parameters<typeof client.send>[0]);
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
  info?: HarnessInfoPlus;
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
    client.send({ type: "harnessCancel", harness } as unknown as Parameters<typeof client.send>[0]);
    client.send({ type: "harnessStatus" });
  };
  const recheck = () => {
    client.send({ type: "refreshHarness" } as unknown as Parameters<typeof client.send>[0]);
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

function TasksModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const agentName = (id: ID) => world.agents.find(a => a.id === id);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" style={{ width: "min(680px,94vw)" }} onClick={e => e.stopPropagation()}>
        <div className="head">☑ Jobs you handed over</div>
        <div className="body">
          {world.tasks.length === 0 && <div className="notice">Nothing handed over yet. Ask an agent with <code>@Agent !bg your job</code>.</div>}
          {world.tasks.map(t => {
            const approval = t.approvalId ? world.approvals.find(a => a.id === t.approvalId) : undefined;
            const agent = agentName(t.agentId);
            const mine = approval && approval.status === "pending" && approval.ownerId === world.me?.id;
            const cancellable = ["not_started", "working", "waiting_approval", "blocked"].includes(t.status);
            return (
              <div key={t.id} className="taskrow">
                <div className="taskmain">
                  <b>{agent ? `${agent.emoji} ${agent.name}` : "?"}</b> — {t.title}
                  <div className="taskmeta">
                    asked by {t.requesterName} · <span className={`tstatus ${t.status}`}>{STATUS_LABEL[t.status] ?? t.status}</span>
                    {t.error ? ` · ${t.error}` : ""}
                  </div>
                  {t.result && <div className="taskresult">{t.result.slice(0, 240)}</div>}
                </div>
                <div className="taskbtns">
                  {mine && <>
                    <button className="primary" onClick={() => client.send({ type: "decideApproval", approvalId: approval!.id, decision: "approved" })}>Approve</button>
                    <button className="ghostbtn" onClick={() => client.send({ type: "decideApproval", approvalId: approval!.id, decision: "rejected" })}>Reject</button>
                  </>}
                  {cancellable && !mine &&
                    <button className="ghostbtn" onClick={() => client.send({ type: "cancelTask", taskId: t.id })}>Cancel</button>}
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
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" style={{ width: "min(680px,94vw)" }} onClick={e => e.stopPropagation()}>
        <div className="head">🕘 Activity — who did what</div>
        <div className="body">
          {world.activity.length === 0 && <div className="notice">Nothing has happened yet.</div>}
          {[...world.activity].reverse().map(r => (
            <div key={r.id} className="actrow">
              <span className="actwho">{r.actorKind === "agent" ? "🤖" : "🧑"} {r.actorName}</span>
              <span className="actdetail">{r.detail}</span>
              <span className="actwhen">{clock(r.ts)}</span>
            </div>
          ))}
        </div>
        <div className="foot"><button className="primary" onClick={onClose}>Close</button></div>
      </div>
    </div>
  );
}

/* ================= agent edit (FR-AG-007/008) ================= */

function AgentEditModal({ agent, onClose }: { agent: AgentDef; onClose: () => void }): React.JSX.Element {
  const full = agent as AgentDefPlus;
  const [persona, setPersona] = useState(agent.persona);
  const [emoji, setEmoji] = useState(agent.emoji);
  const [ab, setAb] = useState(agent.abilities);
  const [ap, setAp] = useState(agent.approvals ?? { background: false, schedules: false });
  const [life, setLife] = useState(agent.lifecycle ?? "enabled");
  const [provider, setProvider] = useState<Provider>((agent.provider ?? "claude") as Provider);
  const [model, setModel] = useState<string>(agent.model ?? MODEL_DEFAULT[(agent.provider ?? "claude") as Provider]);
  const [skills, setSkills] = useState<AgentSkill[]>(Array.isArray(full.skills) ? full.skills : []);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const save = () => {
    client.send({
      type: "updateAgent",
      agent: {
        ...agent, emoji, persona: persona.trim() || agent.persona, abilities: ab,
        approvals: ap, provider, lifecycle: life as AgentDef["lifecycle"],
        model: model || MODEL_DEFAULT[provider],
        skills,
      },
    } as unknown as Parameters<typeof client.send>[0]);
    onClose();
  };
  const del = () => {
    client.send({ type: "deleteAgent", agentId: agent.id });
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={e => e.stopPropagation()}>
        <div className="head">Edit {agent.emoji} {agent.name}</div>
        <div className="body">
          <div className="row">
            <div><label>Status</label>
              <select value={life} onChange={e => setLife(e.target.value as typeof life)}>
                <option value="enabled">▶ Enabled — responds and works</option>
                <option value="paused">⏸ Paused — silent until you switch it back on</option>
                <option value="disabled">⏹ Switched off — does nothing at all</option>
              </select></div>
            <div style={{ maxWidth: 90 }}><label>Emoji</label>
              <input type="text" value={emoji} onChange={e => setEmoji(e.target.value)} /></div>
          </div>
          <div><label>Personality</label>
            <textarea className="persona-input" rows={4} value={persona} onChange={e => setPersona(e.target.value)} /></div>

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
