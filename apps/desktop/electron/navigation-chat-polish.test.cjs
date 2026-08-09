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
  assert.match(app, /<WorkingElapsed \/>/,
    "a provider without live steps should still expose truthful elapsed wait time");
  assert.match(app, /Working elapsed/);
  assert.match(app, /now - row\.startedAt/,
    "streamed elapsed time should use the hub timestamp for the first observed step");
  assert.doesNotMatch(app, /Show"\} what it thought and said/,
    "private model reasoning must never be exposed as a UI disclosure");
  assert.match(app, /data-stop-agent=\{row\.agentId\}/);
  assert.match(css, /\.live-progress-rail/);
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
