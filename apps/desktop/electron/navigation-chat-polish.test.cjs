const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");

test("the permanent rail stays focused and the full feature set is grouped behind More", () => {
  const app = read("App.tsx");
  const nav = app.slice(app.indexOf('<nav className="rail"'), app.indexOf('<main className="stage">'));

  assert.match(nav, /className="rail-primary"/);
  assert.match(nav, /railBtn\("chat", "Home"/);
  assert.match(nav, /railBtn\("chat", "DMs"/);
  assert.match(nav, /railBtn\("activity", "Activity"/);
  assert.match(nav, /railBtn\("files", "Files"/);
  assert.match(nav, /<IconMore \/>More/);
  assert.match(nav, /railBtn\("settings", "Settings"/);
  assert.doesNotMatch(nav, /railBtn\("chat", "Chat"/);
  assert.doesNotMatch(nav, /railBtn\("settings", "Admin"/);
  assert.match(nav, /toolBtn\("tasks", "Tasks"/);
  assert.match(nav, /toolBtn\("projects", "Projects"/);
  assert.match(nav, /data-open-tools/);
  assert.match(nav, /aria-controls="cloud9-tools-drawer"/);
  assert.match(nav, /id="cloud9-tools-drawer"/);
  assert.match(nav, />Talk</);
  assert.match(nav, />Crew</);
  assert.match(nav, />Build</);
  assert.match(nav, />Automate & govern</);
  assert.match(nav, /toolBtn\("notifications", "Notifications"/);
  assert.match(nav, /toolBtn\("saved", "Saved for later"/);
  assert.match(nav, /toolBtn\("hooks", "Hooks"/);
  assert.match(nav, /toolBtn\("spending", "Spending"/);
  assert.doesNotMatch(nav, /className="rail-group"/);
  assert.match(app, /const openPolls = useCallback\(\(\) => \{\s*attemptLeave\(\(\) => setScreen\("polls"\)\)/);
  assert.match(app, /const openHome = useCallback\(\(\) => \{\s*attemptLeave\(\(\) => \{\s*setScreen\("chat"\);\s*const room = world\.channels\.find\(c => c\.kind !== "dm"\)/,
    "Home must leave a DM by selecting an actual room");
  assert.match(nav, /railBtn\("chat", "Home", <IconHome \/>, undefined, openHome/);
});

test("personal settings are named separately from workspace administration", () => {
  const app = read("App.tsx");
  const sections = app.slice(app.indexOf("const SET_SECTIONS"), app.indexOf("function SettingsScreen"));

  for (const label of [
    "Appearance",
    "Chat and replies",
    "Agents",
    "Notifications",
    "Connected apps",
    "Workspace administration",
    "Danger zone",
  ]) {
    assert.match(sections, new RegExp(`\\[\\"[^\\"]+\\", \\"${label}\\"\\]`));
  }
  assert.doesNotMatch(sections, /\["set-quiet", "Quiet hours"\]/,
    "quiet hours belongs under Notifications rather than acting like a top-level preference area");
  assert.doesNotMatch(sections, /\["set-files", "Agent files"\]/,
    "agent storage belongs under Agents rather than acting like a top-level preference area");
  assert.match(app, /<h3>Workspace administration<\/h3>/);
  assert.match(app, /<WorkspaceAdministration \/>/);
  assert.match(app, /Only the workspace owner can change members and permissions/);
  assert.match(app, /<DangerZone stored=\{stored\}/,
    "destructive personal credential controls remain in Danger zone");
});

test("a channel opens without a persistent rail and opts into room details", () => {
  const app = read("App.tsx");

  assert.doesNotMatch(app, /<ChannelRail\b/, "ChannelRail remains retired from the default chat tree");
  assert.match(app, /const \[detailsOpen, setDetailsOpen\] = useState\(false\)/);
  assert.match(app, /className=\{`chatgrid\$\{studioCollapsed \? " studio-collapsed" : ""\}/);
  assert.match(app, /active && !threadRoot && detailsOpen && \(/,
    "the details panel is rendered only after the explicit opt-in");
});

test("the channel header exposes members and the overflow actions", () => {
  const app = read("App.tsx");

  assert.match(app, /aria-label="Show channel members and details"/);
  assert.match(app, /aria-label="More channel actions"/);
  for (const label of [
    "Room details",
    "Invite people",
    "Open Huddle notes",
    "Copy channel name and ID",
    "Draft a channel summary request",
  ]) {
    assert.match(app, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `header overflow should retain ${label}`);
  }
});

test("actions and emoji popovers close on Escape and click-away", () => {
  const app = read("App.tsx");

  assert.match(app, /useEscapeCloses\(\(\) => \{ setActionsOpen\(false\); setSlashDismissed\(true\); \}, menuOpen\)/);
  assert.match(app, /useClickAwayCloses\(toolsRef, \(\) => \{ setActionsOpen\(false\); setSlashDismissed\(true\); \}, menuOpen\)/);
  assert.match(app, /useEscapeCloses\(\(\) => setEmojiOpen\(false\), emojiOpen\)/);
  assert.match(app, /useClickAwayCloses\(emojiHoldRef, \(\) => setEmojiOpen\(false\), emojiOpen\)/);
  assert.match(app, /aria-label="Tools and slash commands"/);
  assert.match(app, /aria-label="Add an emoji"/);
});

test("room detail click-away cannot unregister unsaved work before navigation asks", () => {
  const app = read("App.tsx");
  assert.match(app, /const requestClose = useCallback\(\(\) => attemptLeave\(onClose\)/);
  assert.match(app, /const leaveAtPointer = leaveAsk/);
  assert.match(app, /if \(leaveAsk !== leaveAtPointer\) return/);
  assert.match(app, /useClickAwayCloses\(panelRef, closeAfterOutsideClick, true\)/);
  assert.match(app, /useEscapeCloses\(requestClose, true\)/);
  assert.match(app, /aria-label="Close room details" onClick=\{requestClose\}/);
  assert.match(app, /roomdesc-input[\s\S]*infoSettled\.current = false/);
  assert.match(app, /if \(detailsOpen\) \{\s*attemptLeave\(\(\) => setDetailsOpen\(false\)\)/);
  assert.match(app, /if \(detailsOpen\) attemptLeave\(go\)/,
    "opening a thread must not unmount dirty room details before asking");
});

test("the emoji picker is searchable and category-based", () => {
  const app = read("App.tsx");
  const categories = app.slice(app.indexOf("const EMOJI_CATEGORIES"), app.indexOf("const EMOJI_KEYWORDS"));

  assert.match(categories, /Quick:/);
  for (const category of ["Smileys", "Gestures", "Work", "Hearts"]) {
    assert.match(categories, new RegExp(`${category}:`));
  }
  assert.match(app, /placeholder="Search emoji"/);
  assert.match(app, /role="tablist" aria-label="Emoji categories"/);
  assert.match(app, /Object\.keys\(EMOJI_CATEGORIES\)\.map\(category =>/);
  assert.match(app, /const emojiRows = useMemo\(\(\) =>/);
});

test("audio messages use the microphone and enter the ordinary attachment lifecycle", () => {
  const app = read("App.tsx");

  assert.match(app, /navigator\.mediaDevices\?\.getUserMedia/);
  assert.match(app, /if \(recordingStartingRef\.current\) return;/,
    "a second click must not orphan a microphone stream while permission is pending");
  assert.match(app, /if \(request !== recordingRequestRef\.current\) \{\s*stream\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/,
    "a permission answer arriving after navigation must release its stream");
  assert.match(app, /new MediaRecorder\(stream/);
  assert.match(app, /voice-message-\$\{stamp\}\.webm/);
  assert.match(app, /attachFiles\(\[new File\(/,
    "a finished recording should use the existing validated attachment path");
  assert.match(app, /aria-label=\{recording \? "Stop audio recording" : "Record an audio message"\}/);
  assert.match(app, /Audio message added\. Review the attachment, then send it\./,
    "recording completion must not pretend the message was already sent");
  assert.match(app, /stream\?\.getTracks\(\)\.forEach\(track => track\.stop\(\)\)/,
    "recorder failures must release the microphone");
  assert.match(app, /<audio controls preload="metadata"/,
    "recorded messages should be playable where they are posted");
});

test("appearance mode, palette, and thread layout are separate durable preferences", () => {
  const app = read("App.tsx");
  assert.match(app, /appearanceMode: AppearanceMode/);
  assert.match(app, /palette: PaletteName/);
  assert.match(app, /threadLayout: ThreadLayout/);
  assert.match(app, /const PALETTES:/);
  assert.match(app, /function paletteMode/);
  assert.match(app, /data-appearance-mode=\{mode\}/);
  assert.match(app, /\["system", "light", "dark"\]/);
  assert.match(app, /System/);
  assert.match(app, /Light/);
  assert.match(app, /Dark/);
  assert.match(app, /Focus/);
  assert.match(app, /Split/);
  assert.match(app, /const effectiveMode = previewMode \?\? p\.appearanceMode/);
  assert.match(app, /data-palette-mode=\{visibleMode\}/);
  assert.match(app, /ACCENT_PRESETS/);
  assert.match(app, /Apply theme/);
  assert.match(app, /Revert preview/);
  assert.match(app, /function migratePrefs/);
  assert.match(app, /legacy === "light"/);
  assert.match(app, /legacy === "dark"/);
  assert.match(app, /threadTakeover \? "focus" : "split"/);
  assert.match(app, /next\.theme = undefined/);
  assert.match(app, /next\.threadTakeover = undefined/);
});

test("the chat thread layout maps Focus to takeover and Split to an adjacent panel", () => {
  const app = read("App.tsx");
  assert.match(app, /p\.threadLayout === "focus"/);
  assert.match(app, /prefs\.set\(\{ threadLayout: "split" \}\)/);
  assert.match(app, /prefs\.set\(\{ threadLayout: "focus" \}\)/);
  assert.match(app, /tooNarrowToSplit/);
});

test("the shell keeps the top drag strip and live progress contract inspectable", () => {
  const app = read("App.tsx");
  const css = read("styles.css");
  assert.match(app, /className="window-drag-strip"/);
  assert.match(css, /\.window-drag-strip/);
  assert.match(css, /-webkit-app-region:drag/);
  assert.match(app, /data-live-progress="true"/);
  assert.doesNotMatch(app, /<WorkingElapsed \/>/,
    "raw agent status must not create an unanchored working card");
  assert.match(app, /provider or a run that cannot stream produces no live view whatsoever/,
    "the room must stay quiet rather than inventing activity for a turn without public steps");
  assert.match(app, /Working elapsed/);
  assert.match(app, /now - row\.startedAt/,
    "streamed elapsed time should use the hub timestamp for the first observed step");
  assert.doesNotMatch(app, /Show"\} what it thought and said/,
    "private model reasoning must never be exposed as a UI disclosure");
  assert.match(app, /data-stop-agent=\{row\.agentId\}/);
  assert.match(css, /\.live-progress-rail/);
});

test("inline agent activity is delayed, expandable, and never renders live private detail", () => {
  const app = read("App.tsx");
  assert.match(app, /setTimeout\(\(\) => setShown\(true\), 650\)/,
    "short turns must not flash a working card");
  assert.match(app, /<details key=\{row\.agentId\} className="liveturn"/,
    "the public activity list is compact until a person expands it");
  assert.match(app, /steps=\{row\.steps\.map\(step => \(\{ \.\.\.step, detail: undefined \}\)\)\}/,
    "live activity must not expose provider reasoning/detail text");
});

test("human typing is an ephemeral, channel-scoped signal rather than a message", () => {
  const app = read("App.tsx");
  const store = read("store.ts");
  const css = read("styles.css");
  assert.match(store, /humanTyping: Record<ID, HumanTyping\[\]>/);
  assert.match(store, /setTyping\(channelId: ID, typing: boolean\)/);
  assert.match(store, /case "typing":\s*this\.noteHumanTyping\(frame\.typing\)/);
  assert.match(store, /this\.clearHumanTyping\(undefined, undefined, false\)/,
    "a reconnect must clear old ephemeral typing rows");
  assert.match(store, /A hub switch is a new live session[\s\S]*?this\.world\.connected = false;/,
    "a hub switch must let a focused composer re-advertise after welcome");
  assert.match(app, /client\.setTyping\(channel\.id,/);
  assert.match(app, /humanTyping\.length > 0/);
  assert.match(app, /is typing/);
  assert.match(css, /\.typing-indicator/);
});

test("the composer restores scoped text drafts without claiming files survive restart", () => {
  const app = read("App.tsx");
  const store = read("store.ts");
  const css = read("styles.css");
  assert.match(app, /from "\.\/chatdrafts\.js"/);
  assert.match(app, /userId: world\.me\.id, channelId: channel\.id/);
  assert.match(app, /Hydrate before this scope may write/);
  assert.match(app, /clearChatDraft\(draftScope\)/,
    "a successful send must remove the matching text draft");
  assert.match(app, /Restoration may fill an empty box[\s\S]*?if \(text\.length === 0\)/,
    "a late durable draft must never overwrite newer text already being typed");
  assert.match(app, /browser cannot\r?\n\s*restore a File safely after restart/,
    "attachment persistence must not be misrepresented");
  assert.match(app, /data-draft-status/);
  assert.match(css, /\.composer-draft-status\{color:var\(--ink-2\);font-size:12px;/,
    "draft recovery state must remain readable on light theme surfaces");
  assert.match(store, /canonicalDraftThreadId\(threadId\)/,
    "reply-child draft requests must resolve to the root thread scope");
  assert.match(store, /const canonicalThreadId = this\.canonicalDraftThreadId\(threadId\)/,
    "list/remove/reconcile requests must use the canonical root id");
  assert.match(store, /listDrafts\([\s\S]*?refused: why => \{ this\.draftRequests\.delete\(requestId\)/,
    "a refused draft list must settle its request so a late frame cannot mutate state");
  assert.match(store, /private uploadThreadId\(threadId\?: ID\)/,
    "upload trays must share the canonical root thread scope");
  assert.match(store, /const scopeThreadId = this\.uploadThreadId\(threadId\)/,
    "attach/send/clear upload paths must normalize reply-child ids");
});

test("the new rail and tools drawer have explicit hierarchy and focus states", () => {
  const css = read("styles.css");
  assert.match(css, /--rail-bg:/);
  assert.match(css, /\.rail-tools-drawer/);
  assert.match(css, /\.tool-drawer-btn:focus-visible/);
  assert.match(css, /\.rail-btn:focus-visible/);
  assert.match(css, /@media \(max-height:/);
});

test("sending a message follows the newest content immediately", () => {
  const app = read("App.tsx");
  const follow = app.slice(app.indexOf("function useFollowToBottom"), app.indexOf("/* ================= the house marks"));
  assert.match(follow, /why === "sent" \? "auto"/);
  assert.match(follow, /el\.scrollTo\(\{ top: el\.scrollHeight, behavior \}\)/);
  assert.match(app, /messages\.at\(-1\)\?\.authorId === meId \? "sent" : "arrived"/);
  assert.match(app, /messages\.at\(-1\)\?\.authorId === world\.me\?\.id \? "sent" : "arrived"/);
  assert.match(follow, /const claimView = \(\): void => \{ following\.current = false; atBottom\.current = false/);
  assert.match(follow, /closest\("button,a,input,textarea,select"\)/);
  assert.match(app, /className="primary small sendbtn"/);
  assert.match(app, /aria-hidden="true">\u2191<\/span>/,
    "the send control should stay compact and arrow-led");
  assert.match(app, /<span className="sr-only">\{busy/,
    "the compact send control still needs an accessible name");
});

test("focus read recheck uses the chat scroll container bounds", () => {
  const app = read("App.tsx");
  const focus = app.slice(app.indexOf("/* Re-check only rows"), app.indexOf("const roomRef"));
  assert.match(focus, /const rootRect = root\?\.getBoundingClientRect\(\)/);
  assert.match(focus, /rect\.top >= rootRect\.top && rect\.bottom <= rootRect\.bottom/,
    "focus must not treat rows clipped by the .msgs container as visible");
  assert.doesNotMatch(focus, /window\.innerHeight/,
    "the viewport check must not use the window when .msgs is scrolled");
});
