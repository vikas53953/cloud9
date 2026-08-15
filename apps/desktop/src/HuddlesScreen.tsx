import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ID, HuddleNoteKind, HuddleLink } from "@cloud9/shared";
import { client } from "./store.js";
import { huddleLinkWords, huddleNoteKindWords, huddleStateWords } from "./huddle-copy.js";
import "./huddles.css";

export function HuddlesScreen({ onLink }: { onLink: (link: HuddleLink, projectId?: ID) => void }): React.JSX.Element {
  const world = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const [projectId, setProjectId] = useState<ID>("");
  const [sessionId, setSessionId] = useState<ID>();
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [agenda, setAgenda] = useState("");
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<HuddleNoteKind>("note");
  const startRequest = useRef<ID | undefined>(undefined);
  const noteRequest = useRef<ID | undefined>(undefined);
  const noteDraft = useRef("");
  const sessions = world.huddles.sessions.filter(s => !projectId || s.projectId === projectId);
  const active = sessions.find(s => s.id === sessionId);
  const notes = active ? world.huddleNotes[active.id] ?? [] : [];
  const latest = Object.values(world.huddleMutations).sort((a, b) => a.state === "pending" ? -1 : b.state === "pending" ? 1 : 0)[0];
  const loaded = world.huddleProjects.asked && world.huddles.asked;
  const noProjects = loaded && world.huddleProjects.list.length === 0;
  const mePresent = !!(active && world.me && active.participants.some(p => p.id === world.me.id && p.present));
  const live = active?.state === "active";
  const showStartForm = !!projectId && (creating || (!sessionId && !active));
  const showUnavailable = !!sessionId && !active && !creating;

  useEffect(() => { client.askHuddleProjects(); client.askHuddles(); }, []);
  useEffect(() => {
    if (!projectId && world.huddleProjects.list[0]) setProjectId(world.huddleProjects.list[0].id);
    if (projectId) client.askHuddles(projectId);
    if (!creating && !sessionId) {
      const first = world.huddles.sessions.find(s => !projectId || s.projectId === projectId);
      if (first) setSessionId(first.id);
    }
  }, [creating, projectId, sessionId, world.huddleProjects.list, world.huddles.sessions]);
  // Open durable history + clear unread when a session is selected (reconnect/reopen path).
  useEffect(() => {
    if (!sessionId) return;
    client.askHuddle(sessionId);
    client.huddleSend({ type: "huddleMarkRead", sessionId });
  }, [sessionId]);
  useEffect(() => {
    const id = startRequest.current;
    if (id && world.huddleMutations[id]?.state === "succeeded") {
      setTitle("");
      setAgenda("");
      setCreating(false);
      startRequest.current = undefined;
    }
  }, [world.huddleMutations]);
  useEffect(() => {
    const id = noteRequest.current;
    if (id && world.huddleMutations[id]?.state === "succeeded") {
      setBody(current => current === noteDraft.current ? "" : current);
      noteRequest.current = undefined;
    }
  }, [world.huddleMutations]);
  const start = (e: React.FormEvent) => {
    e.preventDefault();
    if (projectId && title.trim() && agenda.trim()) {
      startRequest.current = client.huddleSend({ type: "huddleStart", projectId, title, agenda });
    }
  };
  // Notes are project-scoped: any project member may write without joining presence.
  const addNote = (e: React.FormEvent) => {
    e.preventDefault();
    if (active && active.state === "active" && body.trim()) {
      noteDraft.current = body;
      noteRequest.current = client.huddleSend({ type: "huddleNote", sessionId: active.id, kind, body });
    }
  };
  const pickProject = (id: ID) => {
    setProjectId(id);
    setSessionId(undefined);
    setCreating(false);
  };

  return (
    <section className="screen huddle-screen" aria-labelledby="huddles-heading">
      <header className="huddle-bar">
        <div>
          <span className="eyebrow">Project presence</span>
          <h1 id="huddles-heading">Huddles</h1>
          <p className="screen-note">Shared notes for the project team. Join only marks you present — there is no audio or video.</p>
        </div>
        <div className="huddle-bar-tools">
          <label className="huddle-project-picker" htmlFor="huddle-project">
            Project
            <select id="huddle-project" className="input" value={projectId} onChange={e => pickProject(e.target.value)} aria-label="Choose huddle project">
              <option value="">Choose a project</option>
              {world.huddleProjects.list.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {projectId && (
            <button className="primary" type="button" onClick={() => { setCreating(true); setSessionId(undefined); }}>
              Start huddle
            </button>
          )}
        </div>
      </header>
      {world.lastError && <p className="huddle-banner is-alert" role="alert" aria-live="polite">{world.lastError.text}</p>}
      {latest?.state === "pending" && <p className="huddle-banner" role="status" aria-live="polite">Saving huddle action…</p>}
      {latest?.state === "lost" && <p className="huddle-banner is-alert" role="alert">{latest.problem}</p>}
      {latest?.state === "refused" && <p className="huddle-banner is-alert" role="alert">{latest.problem}</p>}
      {!loaded ? (
        <div className="huddle-empty" role="status">Loading huddles…</div>
      ) : noProjects ? (
        <div className="huddle-empty" role="status">
          <span className="huddle-empty-mark" aria-hidden="true">◎</span>
          <h2>No projects yet</h2>
          <p>Huddles belong to a project. Connect a repository or ask the owner to add you.</p>
        </div>
      ) : (
        <div className="huddle-layout">
          <aside className="huddle-list" aria-label="Huddle sessions">
            <div className="huddle-list-head"><span className="eyebrow">Sessions</span></div>
            <div className="huddle-list-rows">
            {sessions.length === 0 ? (
              <div className="huddle-empty huddle-empty-list">
                <h2>No huddles yet</h2>
                <p>Start one for this project. Notes are shared with the team; joining only marks you present.</p>
              </div>
            ) : sessions.map(s => (
              <button
                className={"huddle-row" + (s.id === sessionId && !creating ? " selected" : "")}
                key={s.id}
                type="button"
                aria-current={s.id === sessionId && !creating ? "true" : undefined}
                onClick={() => { setCreating(false); setSessionId(s.id); }}
              >
                <span className="huddle-row-top">
                  <strong>{s.title}</strong>
                  <span className={"chip" + (s.state === "active" ? " is-pine" : "")}>{huddleStateWords(s.state)}</span>
                </span>
                <span>{s.unread ? `${s.unread} new ${s.unread === 1 ? "note" : "notes"}` : "Caught up"}</span>
                <small>{new Date(s.startedAt).toLocaleString()}</small>
              </button>
            ))}
            </div>
          </aside>
          <div className="huddle-detail" aria-live="polite">
            {active ? (
              <div className="huddle-detail-inner">
                <div className="huddle-head">
                  <div>
                    <span className={"chip" + (live ? " is-pine" : "")}>{huddleStateWords(active.state)}</span>
                    <h2>{active.title}</h2>
                    <p className="screen-note">{active.agenda}</p>
                  </div>
                  {live && (
                    <div className="huddle-actions">
                      {!mePresent && (
                        <button className="primary" type="button" onClick={() => client.huddleSend({ type: "huddleJoin", sessionId: active.id })}>Join</button>
                      )}
                      {mePresent && (
                        <button className="btn" type="button" onClick={() => client.huddleSend({ type: "huddleLeave", sessionId: active.id })}>Leave</button>
                      )}
                      {active.ownerId === world.me?.id && (
                        <button className="btn danger" type="button" onClick={() => client.huddleSend({ type: "huddleEnd", sessionId: active.id })}>End huddle</button>
                      )}
                    </div>
                  )}
                </div>
                <div className="huddle-presence" aria-label="Participants">
                  {active.participants.length === 0 ? (
                    <span className="huddle-presence-empty">Nobody has joined yet. Notes can still be written.</span>
                  ) : active.participants.map(p => (
                    <span className={p.present ? "present" : "left"} key={`${p.id}-${p.joinedAt}`}>
                      {p.name} · {p.kind === "agent" ? "Agent" : "Person"} · {p.present ? "here" : "left"}
                    </span>
                  ))}
                </div>
                <div className="huddle-notes" role="feed" aria-label="Shared notes">
                  {notes.length === 0 ? (
                    <div className="huddle-empty huddle-empty-notes">
                      <h2>No notes yet</h2>
                      <p>{live ? "Write a note, decision, or action item for the team." : "This huddle ended before anyone wrote a note."}</p>
                    </div>
                  ) : notes.map(n => (
                    <article className={"huddle-note" + (n.deletedAt ? " is-deleted" : "")} data-kind={n.kind} key={n.id}>
                      <strong>{n.deletedAt ? "This note was deleted" : huddleNoteKindWords(n.kind)}</strong>
                      <span className="huddle-note-meta">{n.authorName} ({n.authorKind === "agent" ? "Agent" : "Person"}) · {new Date(n.createdAt).toLocaleString()}</span>
                      {n.deletedAt ? (
                        <p className="huddle-tombstone">The original words were removed. This place in the thread stays so history is honest.</p>
                      ) : <p>{n.body}</p>}
                      {!n.deletedAt && n.links?.length > 0 && (
                        <div className="huddle-links" aria-label="Related links">
                          {n.links.map((link, i) => (
                            <button
                              key={`${n.id}-link-${i}`}
                              className={"huddle-link" + (link.available === false ? " is-unavailable" : "")}
                              type="button"
                              disabled={link.available === false}
                              title={link.available === false ? "Unavailable" : "Open related item"}
                              onClick={() => onLink(link, active.projectId)}
                            >
                              {huddleLinkWords(link)}
                            </button>
                          ))}
                        </div>
                      )}
                      {!n.deletedAt && (n.authorId === world.me?.id || active.ownerId === world.me?.id) && (
                        <button className="linkish" type="button" onClick={() => client.huddleSend({ type: "huddleDeleteNote", noteId: n.id })}>Delete note</button>
                      )}
                    </article>
                  ))}
                </div>
                {live ? (
                  <form className="huddle-composer" onSubmit={addNote}>
                    <label className="huddle-field" htmlFor="huddle-kind">
                      Type
                      <select id="huddle-kind" className="input" value={kind} onChange={e => setKind(e.target.value as HuddleNoteKind)}>
                        <option value="note">Note</option>
                        <option value="decision">Decision</option>
                        <option value="action">Action item</option>
                      </select>
                    </label>
                    <label className="huddle-field huddle-field-grow" htmlFor="huddle-note">
                      Shared note
                      <textarea id="huddle-note" className="input" value={body} onChange={e => setBody(e.target.value)} placeholder="Write a note for the team" required />
                    </label>
                    <button className="primary" type="submit">Add note</button>
                  </form>
                ) : (
                  <p className="huddle-ended-note" role="status">This huddle has ended. Shared notes stay here for the team.</p>
                )}
              </div>
            ) : showUnavailable ? (
              <div className="huddle-detail-inner">
                <div className="huddle-empty" role="status">
                  <span className="huddle-empty-mark" aria-hidden="true">◎</span>
                  <h2>This huddle is no longer available</h2>
                  <p>It was deleted, or you no longer have access. Choose another from the list, or start a new one.</p>
                </div>
              </div>
            ) : showStartForm ? (
              <div className="huddle-detail-inner">
                <form className="huddle-start" onSubmit={start}>
                  <span className="eyebrow">New session</span>
                  <h2>Start a huddle</h2>
                  <p className="screen-note">A shared notes thread for this project. Join only marks you present — there is no audio or video.</p>
                  <label className="huddle-field" htmlFor="huddle-title">
                    Title
                    <input id="huddle-title" className="input" value={title} onChange={e => setTitle(e.target.value)} required />
                  </label>
                  <label className="huddle-field" htmlFor="huddle-agenda">
                    Agenda
                    <textarea id="huddle-agenda" className="input" value={agenda} onChange={e => setAgenda(e.target.value)} required />
                  </label>
                  <button className="primary" type="submit">Start huddle</button>
                </form>
              </div>
            ) : (
              <div className="huddle-detail-inner">
                <div className="huddle-empty" role="status">
                  <h2>Choose a huddle</h2>
                  <p>Pick a session from the list, or start a new one.</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
