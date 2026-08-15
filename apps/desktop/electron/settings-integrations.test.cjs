const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");

const screen = app.slice(app.indexOf("function SettingsScreen"), app.indexOf("function DefaultModelPick"));
const diag = app.slice(app.indexOf("function SettingsDiagnostics"), app.indexOf("function DefaultModelPick"));
const card = app.slice(app.indexOf("function HarnessCard"), app.indexOf("const GH_LOGIN_COMMAND"));
const ghStart = app.indexOf("function GitHubCard");
const github = app.slice(ghStart, app.indexOf("/* ================= FILES · ONE WORKSPACE", ghStart));

test("settings splits everyday connection from Advanced / Diagnostics", () => {
  const sections = app.slice(app.indexOf("const SET_SECTIONS"), app.indexOf("function SettingsScreen"));
  assert.match(sections, /\["set-apps", "Connected apps"\]/);
  assert.match(sections, /\["set-agents", "Agents"\]/);
  assert.match(sections, /\["set-workspace", "Workspace administration"\]/);
  assert.match(sections, /\["set-diag", "Advanced \/ Diagnostics"\]/);
  assert.match(screen, /id="set-diag"/);
  assert.match(screen, /data-settings-layer="diagnostics"/);
  assert.match(screen, /data-settings-layer="normal"/);
  assert.match(screen, /<SettingsDiagnostics/);
  assert.match(diag, /data-settings-diagnostics="true"/);
  assert.match(diag, /data-diag="runtime"/);
  assert.match(diag, /data-diag="cli"/);
  assert.match(diag, /data-diag="models"/);
  assert.match(diag, /data-diag="connection"/);
});

test("developer diagnostics stay in the DOM — they are moved, not deleted", () => {
  assert.match(card, /className="harnessfacts"/);
  assert.match(card, /✓ app found/);
  assert.match(card, /className="modelsource"/);
  assert.match(card, /info\.modelsDetail/);
  assert.match(card, /<details className="harness-diag">/);
  assert.match(github, /className="checkedline"/);
  assert.match(github, /Cloud9 asked this computer at/);
  assert.match(diag, /CLI versions/);
  assert.match(diag, /Model discovery/);
  assert.match(diag, /Connection diagnostics/);
  assert.match(css, /\.diag-panel\{/);
  assert.match(css, /\.harness-diag>/);
});

test("Claude and Codex cards still print the harness's own words, never a screen-authored not-installed", () => {
  assert.match(card, /NEVER THE SCREEN'S OWN "not installed"/);
  const state = card.slice(card.indexOf("const state ="), card.indexOf("const authWords"));
  assert.match(state, /info\.detail \|\| "not confirmed on this computer"/);
  assert.doesNotMatch(state, /not installed on this computer/);
  assert.match(card, /signed in\$\{info\.account/);
  assert.match(card, /· sign-in not confirmed/);
  assert.doesNotMatch(screen, /<HarnessHonesty/);
  assert.match(diag, /info\.detail \|\| "not confirmed on this computer"/);
  assert.doesNotMatch(diag, /className="harnesscard"/);
  assert.doesNotMatch(diag, /className="githubcard"/);
});

test("normal settings still own account, model defaults and permissions", () => {
  assert.match(screen, /id="set-apps"/);
  assert.match(screen, /<DefaultModelPick provider=\{p\.defaultProvider\} \/>/);
  assert.match(screen, /<WorkspaceAdministration \/>/);
  assert.match(screen, /className="set-conn"/);
  assert.match(card, /Signed in\{info\?\.account/);
  assert.match(github, /Signed in as \{info\?\.login/);
});
