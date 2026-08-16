const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("thread summary is a user-triggered, bounded, accessible card", () => {
  const root = path.join(__dirname, "..");
  const app = fs.readFileSync(path.join(root, "src", "App.tsx"), "utf8");
  const store = fs.readFileSync(path.join(root, "src", "store.ts"), "utf8");
  const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");

  assert.match(app, /function ThreadSummaryCard/);
  assert.match(app, /onClick=\{request\}/);
  assert.match(app, /aria-live="polite"/);
  assert.match(app, /Summary refused|Summary unavailable/);
  assert.match(app, /retryThreadSummary\(summary\.requestId\)/);
  assert.match(app, /#message-\$\{source\.messageId\}/);
  assert.match(app, /id=\{`message-\$\{m\.id\}`\}/);
  assert.doesNotMatch(app.slice(app.indexOf("function ThreadSummaryCard"), app.indexOf("function SummaryFacts")), /useEffect/,
    "opening a thread must not auto-request a summary");
  assert.match(store, /threadSummaryPending: Record<ID, true>/);
  assert.match(store, /requestThreadSummary\(/);
  assert.match(store, /case "threadSummary"/);
  assert.match(store, /case "channelLeft"[\s\S]*?threadSummaries/);
  assert.match(styles, /\.thread-summary-card/);
  assert.match(styles, /@media \(max-width:560px\)[\s\S]*?thread-summary-card/);
});
