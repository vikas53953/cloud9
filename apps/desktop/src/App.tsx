import React, {
  useEffect, useMemo, useRef, useState, useSyncExternalStore,
} from "react";
import { AgentDef, Channel, ID, Message } from "@cloud9/shared";
import { client } from "./store.js";

const isQuickWindow = location.hash === "#quick";

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
          <div className="row">
            <button className={mode === "owner" ? "primary" : "ghostbtn"} onClick={() => setMode("owner")}>I run this Cloud9</button>
            <button className={mode === "invite" ? "primary" : "ghostbtn"} onClick={() => setMode("invite")}>I have an invite</button>
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
  const [modal, setModal] = useState<null | "agent" | "invite" | "settings" | "channel">(null);
  const [quick, setQuick] = useState(false);

  const active = world.channels.find(c => c.id === activeId) ?? world.channels[0];

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

  return (
    <div className="app">
      <div className="sidebar">
        <div className="ws-name">☁️ Cloud9</div>
        <div className={`conn ${world.connected ? "ok" : ""}`}>
          {world.connected ? `● connected as ${world.me?.name}` : "○ connecting…"}
        </div>
        <div className="sect">Channels <button title="New channel" onClick={() => setModal("channel")}>＋</button></div>
        {world.channels.filter(c => c.kind === "channel").map(c => (
          <button key={c.id} className={`item ${active?.id === c.id ? "on" : ""}`} onClick={() => setActiveId(c.id)}>
            # {c.name}
          </button>
        ))}
        <div className="sect">Agents <button title="New agent" onClick={() => setModal("agent")}>＋</button></div>
        {world.agents.map(a => (
          <button key={a.id} className="item" onClick={() => dmFor(a.id, a.name)} title={a.persona}>
            <span className={`dot ${world.agentStatus[a.id] ?? "idle"}`}></span>
            {a.emoji} {a.name} <span className="chip">AGENT</span>
          </button>
        ))}
        <div className="sect">People <button title="Invite a friend" onClick={() => { client.send({ type: "createInvite" }); setModal("invite"); }}>＋</button></div>
        {world.users.map(u => (
          <button key={u.id} className="item" onClick={() => u.id !== world.me?.id && dmFor(u.id, u.name)}>
            <span className="dot"></span>{u.name}{u.id === world.me?.id ? " (you)" : ""}
          </button>
        ))}
        <div className="sidebar-foot">
          <button className="ghostbtn" onClick={() => setQuick(true)}>⌘K Quick chat</button>
          <button className="ghostbtn" onClick={() => setModal("settings")}>⚙</button>
        </div>
      </div>

      {active ? <ChatView channel={active} /> : (
        <div className="main"><div className="empty">No channel yet — create one with ＋</div></div>
      )}

      {quick && <QuickChat onClose={() => setQuick(false)} />}
      {modal === "agent" && <AgentModal onClose={() => setModal(null)} />}
      {modal === "invite" && <InviteModal onClose={() => setModal(null)} />}
      {modal === "settings" && <SettingsModal onClose={() => setModal(null)} />}
      {modal === "channel" && <ChannelModal onClose={() => setModal(null)} />}
    </div>
  );
}

/* ================= chat ================= */

function ChatView({ channel }: { channel: Channel }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const messages = world.messages[channel.id] ?? [];
  const streamRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    streamRef.current?.scrollTo({ top: streamRef.current.scrollHeight });
  }, [messages.length, channel.id]);

  const memberNames = channel.memberIds
    .map(id => world.users.find(u => u.id === id)?.name ?? world.agents.find(a => a.id === id)?.name)
    .filter(Boolean).join(", ");

  const title = channel.kind === "dm"
    ? memberNames.split(", ").filter(n => n !== world.me?.name).join(", ") || channel.name
    : `# ${channel.name}`;

  return (
    <div className="main">
      <div className="chathead">
        <b>{title}</b><span>{memberNames}</span>
        <div className="spacer" />
        <AddToChannel channel={channel} />
      </div>
      <div className="stream" ref={streamRef}>
        {messages.length === 0 && <div className="empty">Quiet in here.<br />Say something — or @mention an agent.</div>}
        {messages.map(m => <MessageRow key={m.id} m={m} />)}
      </div>
      <Composer channel={channel} />
    </div>
  );
}

function MessageRow({ m }: { m: Message }): React.JSX.Element {
  const parts = m.text.split(/(@[\w-]+)/g);
  return (
    <div className="msg">
      <div className={`avatar ${m.authorKind}`}>{m.authorEmoji ?? (m.authorKind === "agent" ? "🤖" : "🧑")}</div>
      <div style={{ minWidth: 0 }}>
        <span className="who">{m.authorName}</span>
        {m.authorKind === "agent" && <span className="chip">AGENT</span>}
        <span className="when"> {new Date(m.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
        {m.proactive && <span className="proactive-tag">⏰ proactive</span>}
        <p>{parts.map((p, i) => p.startsWith("@") ? <span key={i} className="mention">{p}</span> : p)}</p>
      </div>
    </div>
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
      className="ghostbtn"
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
      <textarea
        ref={taRef}
        value={text}
        placeholder={`Message ${channel.kind === "dm" ? "" : "#"}${channel.name} — @ to call an agent, "!bg task" for background work`}
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
      {sent && <div className="qc-hint" style={{ color: "var(--good)" }}>{sent}</div>}
      {targets.map((t, i) => (
        <div key={t.id} className={`qc-opt ${i === sel ? "on" : ""}`} onClick={() => setSel(i)}>{t.label}</div>
      ))}
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

  const create = () => {
    if (!name.trim() || !persona.trim()) return;
    client.send({
      type: "createAgent",
      agent: { name: name.trim().replace(/\s+/g, "-"), emoji, persona: persona.trim(), abilities: ab },
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
          <div><label>Abilities</label>
            <div className="checks">
              <label><input type="checkbox" checked={ab.webSearch} onChange={e => setAb({ ...ab, webSearch: e.target.checked })} /> 🔎 Web search</label>
              <label><input type="checkbox" checked={ab.files} onChange={e => setAb({ ...ab, files: e.target.checked })} /> 📁 Files folder</label>
              <label><input type="checkbox" checked={ab.schedules} onChange={e => setAb({ ...ab, schedules: e.target.checked })} /> ⏰ Schedules</label>
              <label><input type="checkbox" checked={ab.background} onChange={e => setAb({ ...ab, background: e.target.checked })} /> 📦 Background tasks</label>
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

function SettingsModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [cred, setCred] = useState(localStorage.getItem("cloud9.claudeCred") ?? "");
  const [kind, setKind] = useState(localStorage.getItem("cloud9.claudeCredKind") ?? "apiKey");
  const save = () => {
    localStorage.setItem("cloud9.claudeCred", cred.trim());
    localStorage.setItem("cloud9.claudeCredKind", kind);
    // the Electron main process (engine host) picks these up via IPC bridge
    (window as unknown as { cloud9?: { setCred?: (k: string, v: string) => void } })
      .cloud9?.setCred?.(kind, cred.trim());
    onClose();
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={e => e.stopPropagation()}>
        <div className="head">Settings — connect Claude</div>
        <div className="body">
          <div><label>Credential type</label>
            <select value={kind} onChange={e => setKind(e.target.value)}>
              <option value="apiKey">Anthropic API key (pay-per-use — fully supported)</option>
              <option value="oauthToken">Claude subscription token (from `claude setup-token`)</option>
            </select></div>
          <div><label>{kind === "apiKey" ? "API key (sk-ant-…)" : "OAuth token"}</label>
            <input type="password" value={cred} onChange={e => setCred(e.target.value)} /></div>
          {kind === "oauthToken" ? (
            <div className="notice"><b>Heads up:</b> Anthropic's docs say third-party apps may not offer
              claude.ai subscription login without approval. Generating a token yourself with
              <code> claude setup-token</code> (needs Claude Pro/Max) and pasting it here is your call —
              the safe, fully-supported option is an API key.</div>
          ) : (
            <div className="notice">Create a key at platform.claude.com — usage bills to your own account.
              Without a credential, agents run in demo mode (canned replies).</div>
          )}
        </div>
        <div className="foot">
          <button className="subtle" onClick={onClose}>Cancel</button>
          <button className="primary" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
