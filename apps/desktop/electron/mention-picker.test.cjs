const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");

test("mention candidates are derived from the current room roster, not the global directory", () => {
  const app = read("App.tsx");
  const helper = app.slice(app.indexOf("interface MentionCandidate"), app.indexOf("/** What the hub said"));

  assert.match(helper, /new Set\(channel\.memberIds\)/);
  assert.match(helper, /world\.agents\.filter\(agent => memberIds\.has\(agent\.id\)\)/);
  assert.match(helper, /const ownerIds = new Set\(agents\.map\(agent => agent\.ownerId\)\)/);
  assert.match(helper, /memberIds\.has\(user\.id\) \|\| ownerIds\.has\(user\.id\)/);
  assert.match(app, /mentionCandidatesFor\(channel, world\)/);
  const directory = app.slice(app.indexOf("const directory"), app.indexOf("const suggestions"));
  assert.doesNotMatch(directory, /world\.agents\.map\(a => \(\{ id: a\.id/,
    "the picker must not offer every agent in the Cloud9");
});

test("agent mention rows expose only stored capability, trust, presence, and status facts", () => {
  const app = read("App.tsx");
  const helper = app.slice(app.indexOf("interface MentionCandidate"), app.indexOf("/** What the hub said"));

  assert.match(helper, /effectiveAbilities\(agent\)/);
  assert.match(helper, /CAPABILITIES\s*\.filter\(capability => effective\[capability\.ability\] === true\)/);
  assert.match(helper, /trustWords\(agent\)/);
  assert.match(helper, /PRESENCE_WORDS\[presence\.presence\]/);
  assert.match(helper, /STATUS_WORDS\[presence\.status\]/);
  assert.match(helper, /Availability: not reported/);
  assert.doesNotMatch(helper, /typing/i, "typing is not an availability claim");
});

test("mention popup is an accessible, responsive listbox with keyboard and access cleanup", () => {
  const app = read("App.tsx");
  const css = read("styles.css");
  const composerStart = app.indexOf("function Composer");
  const composer = app.slice(composerStart, app.indexOf("function RoomVisibility", composerStart));

  assert.match(composer, /mentionRosterKey/);
  assert.match(composer, /setMentionDismissed\(false\)/);
  assert.match(composer, /useEscapeCloses\(\(\) => \{ setMentionDismissed\(true\)/);
  assert.match(composer, /useClickAwayCloses\(mentionRef/);
  assert.match(composer, /role="listbox"/);
  assert.match(composer, /role="option" aria-selected/);
  assert.match(composer, /aria-activedescendant/);
  assert.match(composer, /e\.key === "ArrowDown"/);
  assert.match(composer, /e\.key === "ArrowUp"/);
  assert.match(composer, /e\.key === "Tab" \|\| e\.key === "Enter"/);
  assert.match(composer, /applyMention\(suggestions\[acIndex\]\.name\)/);
  assert.match(css, /\.autocomplete\{[\s\S]*?width:min\(460px/);
  assert.match(css, /@media \(max-width:520px\)/);
});
