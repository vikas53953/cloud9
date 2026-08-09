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
  assert.match(nav, /railBtn\("settings", "Admin"/);
  assert.doesNotMatch(nav, /railBtn\("chat", "Chat"/);
  assert.doesNotMatch(nav, /railBtn\("settings", "Settings"/);
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

test("a channel opens without a persistent rail and opts into room details", () => {
  const app = read("App.tsx");

  assert.doesNotMatch(app, /<ChannelRail\b/, "ChannelRail remains retired from the default chat tree");
  assert.match(app, /const \[detailsOpen, setDetailsOpen\] = useState\(false\)/);
  assert.match(app, /className=\{`chatgrid\$\{isDm && !threadRoot && !detailsOpen \? " no-aside" : ""\}/);
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

test("the shell shows eight current theme presets and migrates legacy names", () => {
  const app = read("App.tsx");
  const start = app.indexOf("const themes: [Prefs[\"theme\"], string, string][] = [");
  assert.notEqual(start, -1, "settings should define the visible theme presets");
  const end = app.indexOf("  ];", start);
  const themeRows = app.slice(start, end).match(/\[\"([^\"]+)\",/g) ?? [];
  assert.deepEqual(themeRows.map(row => row.match(/\[\"([^\"]+)\",/)?.[1]), [
    "system", "daylight", "cloud9-pine", "midnight", "aubergine",
    "solarized-dark", "rose-pine", "catppuccin",
  ]);
  assert.doesNotMatch(app.slice(start, end), /\[\"(?:light|dark)\",/,
    "legacy light/dark values should not need visible cards");
  assert.match(app, /theme === "light" \? "daylight"/);
  assert.match(app, /theme === "dark" \? "midnight"/);
  assert.match(app, /prefs\.set\(\{ theme: migrated \}\)/);
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
