import React, {
  useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from "react";
import { AgentDef, Channel, HarnessInfo, ID, Message } from "@cloud9/shared";
import { client } from "./store.js";

const isQuickWindow = location.hash === "#quick";

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

const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex" };

export function App(): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [joined, setJoined] = useState(!!client.token());

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

function Workspace(): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [activeId, setActiveId] = useState<ID | null>(null);
  const [modal, setModal] = useState<null | "agent" | "invite" | "settings" | "channel" | "tasks" | "activity">(null);
  const [editAgent, setEditAgent] = useState<AgentDef | null>(null);
  const [quick, setQuick] = useState(false);
  const [details, setDetails] = useState(true);

  const active = world.channels.find(c => c.id === activeId) ?? world.channels[0];
  const pendingApprovals = world.approvals.filter(
    a => a.status === "pending" && a.ownerId === world.me?.id,
  ).length;

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

  const dmFor = (peerId: ID, peerName: string) => {
    const existing = world.channels.find(
      c => c.kind === "dm" && c.memberIds.includes(peerId) && c.memberIds.includes(world.me!.id),
    );
    if (existing) { setActiveId(existing.id); return; }
    client.send({ type: "createChannel", name: `dm-${peerName.toLowerCase()}`, memberIds: [peerId], kind: "dm" });
  };

  const channels = world.channels.filter(c => c.kind === "channel");
  const dms = world.channels.filter(c => c.kind === "dm");
  const peerOf = (c: Channel) => {
    const id = c.memberIds.find(i => i !== world.me?.id);
    const user = world.users.find(u => u.id === id);
    const agent = world.agents.find(a => a.id === id);
    const status = agent ? agentStatusLine(agent, world.agentStatus[agent.id]) : null;
    return {
      name: user?.name ?? agent?.name ?? c.name,
      emoji: agent?.emoji,
      sub: status ? status.line : "just the two of you",
      lamp: status ? status.lamp : "live",
      busy: status?.busy ?? false,
    };
  };

  return (
    <div className="app" data-details={details && active ? "on" : "off"}>
      <nav className="sidebar rail" aria-label="Workspace">
        <div className="rail-head">
          <div className="mark" aria-hidden="true" />
          <div className="wordmark">
            Cloud9
            <span className={`conn ${world.connected ? "ok" : ""}`}>
              {world.connected ? `connected as ${world.me?.name}` : "connecting…"}
            </span>
          </div>
          <div className="kbd" aria-hidden="true">Ctrl K</div>
        </div>

        <div className="rail-scroll">
          <div className="sect">
            <span>Channels</span><span className="rule" /><span className="count">{channels.length}</span>
            <button title="New channel" aria-label="New channel" onClick={() => setModal("channel")}>＋</button>
          </div>
          {channels.map(c => (
            <button key={c.id} className={`row ${active?.id === c.id ? "on" : ""}`} onClick={() => setActiveId(c.id)}>
              <span className="hash">#</span>{" "}
              <span className="name">{c.name}</span>
            </button>
          ))}

          <div className="sect">
            <span>Your agents</span><span className="rule" /><span className="count">{world.agents.length}</span>
            <button title="New agent" aria-label="New agent" onClick={() => setModal("agent")}>＋</button>
          </div>
          {world.agents.map(a => {
            const s = agentStatusLine(a, world.agentStatus[a.id]);
            return (
              <div key={a.id} className={`row agent-row agentrow`} title={a.persona}>
                <button className="agentmain" onClick={() => dmFor(a.id, a.name)}>
                  <span className="av">{a.emoji}<span className={`dot ${s.lamp}`} /></span>
                  <span className="agent-meta">
                    <span className="agent-name">{a.name}</span>
                    <span className={`agent-sub ${s.busy ? "busy" : ""}`}>{s.line}</span>
                  </span>
                </button>
                {a.ownerId === world.me?.id &&
                  <button className="editbtn" title="Edit agent" onClick={() => setEditAgent(a)}>✎</button>}
              </div>
            );
          })}

          {dms.length > 0 && <div className="sect"><span>Direct messages</span><span className="rule" /></div>}
          {dms.map(c => {
            const p = peerOf(c);
            return (
              <div key={c.id} className={`row agent-row ${active?.id === c.id ? "on" : ""}`}>
                <button className="agentmain" onClick={() => setActiveId(c.id)}>
                  <span className={`av ${p.emoji ? "" : "initials"}`}>
                    {p.emoji ?? initials(p.name)}
                    <span className={`dot ${p.lamp}`} />
                  </span>
                  <span className="agent-meta">
                    <span className="agent-name">{p.name}</span>
                    <span className={`agent-sub ${p.busy ? "busy" : ""}`}>{p.sub}</span>
                  </span>
                </button>
              </div>
            );
          })}

          <div className="sect">
            <span>People</span><span className="rule" /><span className="count">{world.users.length}</span>
            <button title="Invite a friend" aria-label="Invite a friend"
              onClick={() => { client.send({ type: "createInvite" }); setModal("invite"); }}>＋</button>
          </div>
          {world.users.map(u => (
            <button key={u.id} className="row" onClick={() => u.id !== world.me?.id && dmFor(u.id, u.name)}>
              <span className="av initials">{initials(u.name)}<span className="dot live" /></span>
              <span className="name">{u.name}{u.id === world.me?.id ? " (you)" : ""}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-foot rail-foot">
          <div className="me-line">
            <div className="me">{initials(world.me?.name ?? "?")}</div>
            <div style={{ minWidth: 0 }}>
              <div className="me-name">{world.me?.name ?? "—"}</div>
              <div className="me-sub">
                {world.agents.length} {world.agents.length === 1 ? "agent" : "agents"}
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
        <ChatView channel={active} showDetails={details} onToggleDetails={() => setDetails(d => !d)} />
      ) : (
        <div className="main"><div className="empty">No channel yet.<br />Make one with ＋ next to Channels.</div></div>
      )}

      {active && details && <DetailsRail channel={active} onClose={() => setDetails(false)} />}

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

/** Presence line for the rail — built only from what the app really knows. */
function agentStatusLine(a: AgentDef, status?: string): { line: string; lamp: string; busy: boolean } {
  const runsOn = PROVIDER_LABEL[a.provider ?? "claude"] ?? "Claude";
  if (a.lifecycle === "paused") return { line: "paused", lamp: "off", busy: false };
  if (a.lifecycle === "disabled") return { line: "switched off", lamp: "off", busy: false };
  if (status === "working") return { line: "working now", lamp: "run", busy: true };
  if (status === "braked") return { line: "taking a break", lamp: "off", busy: false };
  return { line: `ready · ${runsOn}`, lamp: "live", busy: false };
}

/* ================= chat ================= */

interface Row {
  m: Message;
  cont: boolean;
  dayStart: boolean;
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
  { channel, showDetails, onToggleDetails }:
  { channel: Channel; showDetails: boolean; onToggleDetails: () => void },
): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const messages = world.messages[channel.id] ?? [];
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [messages.length, channel.id]);

  const people = channel.memberIds.map(id => world.users.find(u => u.id === id)).filter(Boolean);
  const agents = channel.memberIds.map(id => world.agents.find(a => a.id === id)).filter(Boolean) as AgentDef[];

  const peer = channel.kind === "dm"
    ? people.find(u => u!.id !== world.me?.id)?.name ?? agents.find(a => a.id !== world.me?.id)?.name ?? channel.name
    : null;

  const rows: Row[] = messages.map((m, i) => {
    const prev = messages[i - 1];
    const dayStart = i === 0 || !sameDay(prev.ts, m.ts);
    const cont = !dayStart && !!prev && prev.authorKind === "human" && m.authorKind === "human"
      && prev.authorId === m.authorId && m.ts - prev.ts < 5 * 60 * 1000;
    const ask = m.authorKind === "agent" && !m.proactive ? findAsk(messages, i, m) : undefined;
    return { m, cont, dayStart, ask };
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
          {people.slice(0, 3).map(u => <span key={u!.id} className="face">{initials(u!.name)}</span>)}
          {agents.slice(0, 3).map(a => <span key={a.id} className="face agent">{a.emoji}</span>)}
        </div>
        <AddToChannel channel={channel} />
        <button className="tbtn" onClick={onToggleDetails} aria-pressed={showDetails}>
          {showDetails ? "Hide details" : "Details"}
        </button>
      </header>

      <div className="stream" ref={streamRef}>
        {messages.length === 0 && <div className="empty">Quiet in here.<br />Say something — or @mention an agent.</div>}
        {rows.map(r => (
          <React.Fragment key={r.m.id}>
            {r.dayStart && (
              <div className="day"><span className="rule" /><span className="tag">{dayLabel(r.m.ts)}</span><span className="rule" /></div>
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
      </article>
    );
  }

  /* RUN STRIP — only the facts the app actually holds. */
  const strip: React.ReactNode[] = [];
  if (isAgent) {
    if (m.proactive) strip.push(<span className="selfstart" key="self">Started on its own</span>);
    else if (ask) strip.push(<span key="ask">asked by <b>@{ask.authorName}</b></span>);
    if (ask && m.ts >= ask.ts) strip.push(<span key="took">{elapsed(m.ts - ask.ts)} to answer</span>);
    if (agent) strip.push(<span key="prov">runs on {PROVIDER_LABEL[agent.provider ?? "claude"] ?? "Claude"}</span>);
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
    </article>
  );
}

function AddToChannel({ channel }: { channel: Channel }): React.JSX.Element | null {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  if (channel.kind === "dm") return null;
  const candidates = [
    ...world.agents.filter(a => !channel.memberIds.includes(a.id)).map(a => ({ id: a.id, label: `${a.emoji} ${a.name}` })),
    ...world.users.filter(u => !channel.memberIds.includes(u.id)).map(u => ({ id: u.id, label: u.name })),
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

function Composer({ channel }: { channel: Channel }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [text, setText] = useState("");
  const [acIndex, setAcIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const mentionQuery = useMemo(() => {
    const m = /(?:^|\s)@([\w-]*)$/.exec(text);
    return m ? m[1].toLowerCase() : null;
  }, [text]);

  const directory = useMemo(() => [
    ...world.agents.map(a => ({ id: a.id, name: a.name, label: `${a.emoji} ${a.name}` })),
    ...world.users.filter(u => u.id !== world.me?.id).map(u => ({ id: u.id, name: u.name, label: u.name })),
  ], [world.agents, world.users, world.me]);

  const suggestions = mentionQuery === null ? [] :
    directory.filter(d => d.name.toLowerCase().startsWith(mentionQuery)).slice(0, 6);

  const applyMention = (name: string) => {
    setText(t => t.replace(/@[\w-]*$/, `@${name} `));
    taRef.current?.focus();
  };

  const insert = (snippet: string) => {
    setText(t => (t && !t.endsWith(" ") ? `${t} ${snippet}` : `${t}${snippet}`));
    taRef.current?.focus();
  };

  const sendNow = () => {
    const t = text.trim();
    if (!t) return;
    client.send({ type: "send", channelId: channel.id, text: t });
    setText("");
  };

  return (
    <div className="composer">
      {suggestions.length > 0 && (
        <div className="autocomplete">
          {suggestions.map((s, i) => (
            <div key={s.id} className={`opt ${i === acIndex ? "on" : ""}`}
              onMouseDown={e => { e.preventDefault(); applyMention(s.name); }}>
              {s.label}
            </div>
          ))}
        </div>
      )}
      <div className="ctools">
        <button className="ct mono" title="Call an agent by name" onClick={() => insert("@")}>@</button>
        <button className="ct mono" title="Hand this over as background work" onClick={() => insert("!bg ")}>!bg</button>
        <span className="chint">@ an agent to hand it a job</span>
      </div>
      <textarea
        ref={taRef}
        value={text}
        placeholder={`Message ${channel.kind === "dm" ? "" : "#"}${channel.name}`}
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
        <span className="spacer" />
        <button className="send" onClick={sendNow}>Send <span className="k">↵</span></button>
      </div>
    </div>
  );
}

/* ================= details rail ================= */

function DetailsRail({ channel, onClose }: { channel: Channel; onClose: () => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const agents = channel.memberIds.map(id => world.agents.find(a => a.id === id)).filter(Boolean) as AgentDef[];
  const people = channel.memberIds.map(id => world.users.find(u => u.id === id)).filter(Boolean);
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
          {agents.length === 0 && <div className="d-empty">No agents in this channel yet.</div>}
          {agents.map(a => {
            const s = agentStatusLine(a, world.agentStatus[a.id]);
            return (
              <div className="d-agent" key={a.id}>
                <span className="av">{a.emoji}<span className={`dot ${s.lamp}`} /></span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <div className="n">{a.name}</div>
                  <div className={`s ${s.busy ? "busy" : ""}`}>{s.line}</div>
                </span>
              </div>
            );
          })}
        </div>

        <div className="d-sect">
          <span className="tag">People</span>
          {people.map(u => (
            <div className="member" key={u!.id}>
              <span className="av initials">{initials(u!.name)}<span className="dot live" /></span>
              <span className="n">{u!.name}</span>
              <span className="r">{u!.invitedBy ? "member" : "owner"}</span>
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
        client.send({ type: "createChannel", name: `dm-${t.name.toLowerCase()}`, memberIds: [t.id], kind: "dm" });
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
    <div className="panel" onClick={e => e.stopPropagation()}>
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
      <div className="qc-list">
        {targets.map((t, i) => (
          <div key={t.id} className={`qc-opt ${i === sel ? "on" : ""}`} onClick={() => setSel(i)}>{t.label}</div>
        ))}
      </div>
      <div className="qc-hint">↑↓ choose · Enter send · Esc close — works from anywhere with the global hotkey</div>
    </div>
  );

  if (standalone) return <div style={{ paddingTop: 20 }}>{body}</div>;
  return <div className="overlay" onClick={onClose}>{body}</div>;
}

/* ================= modals ================= */

function AgentModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("✨");
  const [persona, setPersona] = useState("");
  const [ab, setAb] = useState({ webSearch: true, files: false, schedules: false, background: true });
  const [ap, setAp] = useState({ background: false, schedules: false });
  const [provider, setProvider] = useState<"claude" | "codex">("claude");

  const create = () => {
    if (!name.trim() || !persona.trim()) return;
    client.send({
      type: "createAgent",
      agent: {
        name: name.trim().replace(/\s+/g, "-"), emoji, persona: persona.trim(),
        abilities: ab, approvals: ap, provider,
      },
    });
    onClose();
  };

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
            <textarea rows={4} value={persona} onChange={e => setPersona(e.target.value)}
              placeholder="You're my travel researcher. You find flights, villas and hidden gems, always with prices and links, always under budget." /></div>
          <div><label>Runs on</label>
            <select className="providerpick" value={provider} onChange={e => setProvider(e.target.value as "claude" | "codex")}>
              <option value="claude">🟣 Claude — your Claude app</option>
              <option value="codex">🟢 Codex — your Codex app</option>
            </select>
            <div className="hint">Connect these under ⚙ Settings. An agent whose app isn't signed in will say so when you ask it something.</div>
          </div>
          <div><label>Abilities</label>
            <div className="checks">
              <label><input type="checkbox" checked={ab.webSearch} onChange={e => setAb({ ...ab, webSearch: e.target.checked })} /> 🔎 Web search</label>
              <label><input type="checkbox" checked={ab.files} onChange={e => setAb({ ...ab, files: e.target.checked })} /> 📁 Files folder</label>
              <label><input type="checkbox" checked={ab.schedules} onChange={e => setAb({ ...ab, schedules: e.target.checked })} /> ⏰ Schedules</label>
              <label><input type="checkbox" checked={ab.background} onChange={e => setAb({ ...ab, background: e.target.checked })} /> 📦 Background jobs</label>
            </div></div>
          <div><label>Ask me first before…</label>
            <div className="checks">
              <label><input type="checkbox" checked={ap.background} onChange={e => setAp({ ...ap, background: e.target.checked })} /> 🔒 Background work</label>
              <label><input type="checkbox" checked={ap.schedules} onChange={e => setAp({ ...ap, schedules: e.target.checked })} /> 🔒 Making a schedule</label>
            </div></div>
        </div>
        <div className="foot">
          <button className="subtle" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={create}>Create agent</button>
        </div>
      </div>
    </div>
  );
}

function InviteModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={e => e.stopPropagation()}>
        <div className="head">Invite a friend</div>
        <div className="body">
          <div className="notice">Send them this one-time code. They pick "I have an invite" on the welcome screen. They'll land in #general.</div>
          <div className="code">{world.inviteCode ?? "generating…"}</div>
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
    ...world.users.filter(u => u.id !== world.me?.id).map(u => ({ id: u.id, label: u.name })),
  ];
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={e => e.stopPropagation()}>
        <div className="head">New channel</div>
        <div className="body">
          <div><label>Name</label>
            <input type="text" value={name} onChange={e => setName(e.target.value.replace(/\s+/g, "-").toLowerCase())} placeholder="trip-goa" /></div>
          <div><label>Members</label>
            <div className="checks">
              {candidates.map(c => (
                <label key={c.id}>
                  <input type="checkbox" checked={members.includes(c.id)}
                    onChange={e => setMembers(m => e.target.checked ? [...m, c.id] : m.filter(x => x !== c.id))} />
                  {c.label}
                </label>
              ))}
            </div></div>
        </div>
        <div className="foot">
          <button className="subtle" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => { if (name.trim()) { client.send({ type: "createChannel", name: name.trim(), memberIds: members, kind: "channel" }); onClose(); } }}>Create</button>
        </div>
      </div>
    </div>
  );
}

/* ---- Settings: connect the Claude and Codex apps ----
 * No credential ever lives in the browser. The buttons ask the engine host to
 * run the provider's own sign-in; the app only ever displays status, and any
 * fallback key is handed straight to the desktop shell for encrypted storage
 * (docs/plans/harness-signin.md decision 4). */

type Harness = "claude" | "codex";

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
}
const desktop = (): DesktopBridge | undefined =>
  (window as unknown as { cloud9?: DesktopBridge }).cloud9;

function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [stored, setStored] = useState<CredentialStatus | null>(null);

  const refreshStored = () => {
    void desktop()?.credentialStatus?.().then(setStored).catch(() => setStored(null));
  };
  useEffect(() => {
    client.send({ type: "harnessStatus" });
    refreshStored();
  }, []);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" style={{ width: "min(640px,94vw)" }} onClick={e => e.stopPropagation()}>
        <div className="head">Settings — connect your AI apps</div>
        <div className="body">
          <div className="notice">
            Cloud9 runs your agents through apps already installed on this computer.
            Sign in once here and your agents can work.
          </div>
          <HarnessCard
            harness="claude" title="Claude" emoji="🟣"
            info={world.harness?.claude}
            checking={world.harness?.checking}
            savedKey={stored?.claude?.hasCredential ?? false}
            onStoredChanged={refreshStored}
            signInLabel="Sign in with Claude"
            fallbackLabel="Use an API key instead"
            fallbackHelp="Create a key at platform.claude.com — usage bills to your own account."
            disclosure={
              <>
                <b>Heads up:</b> Anthropic's docs say apps may not offer claude.ai
                subscription login on your behalf. The button above runs Claude's own
                approved sign-in on this computer (<code>claude setup-token</code>, needs
                Claude Pro/Max) — nothing is shared with anyone else.
              </>
            }
          />
          <HarnessCard
            harness="codex" title="Codex" emoji="🟢"
            info={world.harness?.codex}
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
        </div>
        <div className="foot">
          <button className="primary" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

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

  const installed = info?.installed ?? false;
  const signedIn = info?.signedIn ?? false;
  const state = !info ? "checking…"
    : info.signingIn ? "waiting for you in the browser…"
    : !installed ? "not installed on this computer"
    : signedIn ? `signed in${info.account ? ` as ${info.account}` : ""}`
    : info.detail ?? "installed, not signed in";

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
    <div className="harnesscard" data-harness={harness}>
      <div className="harnesshead">
        <span className="harnessname">{emoji} {title}</span>
        <span className={`harnessdot ${signedIn ? "ok" : installed ? "warn" : "off"}`}></span>
        <span className="harnessstate">{state}</span>
      </div>
      <div className="harnessfacts">
        <span>{installed ? `✓ app found${info?.version ? ` (${info.version})` : ""}` : "✗ app not found"}</span>
        <span>{signedIn ? "✓ signed in" : "✗ not signed in"}</span>
        {savedKey && <span>✓ key saved on this computer</span>}
      </div>
      <div className="harnessbtns">
        <button
          className="primary"
          disabled={!installed || info?.signingIn}
          onClick={() => client.send({ type: "harnessSignIn", harness })}
        >
          {signedIn ? `Sign in again with ${title}` : signInLabel}
        </button>
        <button
          className="ghostbtn"
          disabled={checking}
          onClick={() => client.send({ type: "harnessStatus" })}
        >
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
  const [persona, setPersona] = useState(agent.persona);
  const [emoji, setEmoji] = useState(agent.emoji);
  const [ab, setAb] = useState(agent.abilities);
  const [ap, setAp] = useState(agent.approvals ?? { background: false, schedules: false });
  const [life, setLife] = useState(agent.lifecycle ?? "enabled");
  const [provider, setProvider] = useState<"claude" | "codex">(agent.provider ?? "claude");

  const save = () => {
    client.send({
      type: "updateAgent",
      agent: {
        ...agent, emoji, persona: persona.trim() || agent.persona, abilities: ab,
        approvals: ap, provider, lifecycle: life as AgentDef["lifecycle"],
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
            <textarea rows={4} value={persona} onChange={e => setPersona(e.target.value)} /></div>
          <div><label>Runs on</label>
            <select className="providerpick" value={provider} onChange={e => setProvider(e.target.value as "claude" | "codex")}>
              <option value="claude">🟣 Claude — your Claude app</option>
              <option value="codex">🟢 Codex — your Codex app</option>
            </select></div>
          <div><label>Abilities</label>
            <div className="checks">
              <label><input type="checkbox" checked={ab.webSearch} onChange={e => setAb({ ...ab, webSearch: e.target.checked })} /> 🔎 Web search</label>
              <label><input type="checkbox" checked={ab.files} onChange={e => setAb({ ...ab, files: e.target.checked })} /> 📁 Files folder</label>
              <label><input type="checkbox" checked={ab.schedules} onChange={e => setAb({ ...ab, schedules: e.target.checked })} /> ⏰ Schedules</label>
              <label><input type="checkbox" checked={ab.background} onChange={e => setAb({ ...ab, background: e.target.checked })} /> 📦 Background jobs</label>
            </div></div>
          <div><label>Ask me first before…</label>
            <div className="checks">
              <label><input type="checkbox" checked={ap.background} onChange={e => setAp({ ...ap, background: e.target.checked })} /> 🔒 Background work</label>
              <label><input type="checkbox" checked={ap.schedules} onChange={e => setAp({ ...ap, schedules: e.target.checked })} /> 🔒 Making a schedule</label>
            </div></div>
        </div>
        <div className="foot">
          <button className="subtle danger" onClick={del}>Delete agent</button>
          <button className="subtle" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
