const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
const css = fs.readFileSync(path.join(__dirname, "..", "src", "styles.css"), "utf8");

test("invocation controls only render for a real @agent target and send canonical metadata", () => {
  assert.match(app, /invocationTargetFor\(text, roomAgents/);
  assert.match(app, /data-invocation-agent=\{invocationAgent\.id\}/);
  assert.match(app, /invocation:\s*\{/);
  assert.match(app, /agentId:\s*invocationAgent\.id/);
});

test("invocation controls are collapsed by default and keyboard accessible", () => {
  assert.match(app, /const \[invocationOpen, setInvocationOpen\] = useState\(false\)/);
  assert.match(app, /aria-expanded=\{invocationOpen\}/);
  assert.match(app, /aria-controls=\{`invocation-panel-/);
  assert.match(app, /useEscapeCloses\(\(\) => setInvocationOpen\(false\)/);
  assert.match(app, /useClickAwayCloses\(invocationRef/);
  assert.match(app, /aria-label="Invocation model"/);
  assert.match(app, /aria-label="Invocation effort"/);
  assert.match(app, /aria-label="Invocation permission scope"/);
});

test("model overrides fail closed when the provider catalog is unavailable", () => {
  assert.match(app, /disabled=\{invocationModels\.length === 0\}/);
  assert.match(app, /model overrides are disabled/);
});

test("small windows stack the controls instead of overflowing", () => {
  assert.match(css, /\.invocation-panel\{[^}]*grid-template-columns:repeat\(3/);
  assert.match(css, /@media \(max-width:560px\)\{[^}]*\.invocation-panel\{[^}]*grid-template-columns:1fr/);
});
