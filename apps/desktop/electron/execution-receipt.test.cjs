const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = name => fs.readFileSync(path.join(__dirname, "..", "src", name), "utf8");

test("run cards keep execution facts behind an accessible compact disclosure", () => {
  const app = read("App.tsx");
  const card = app.slice(app.indexOf("function RunCard"), app.indexOf("function RunRecoveryCard"));
  const css = read("styles.css");
  for (const fact of ["files", "tests", "pullRequest", "branch", "commit", "artifacts"]) {
    assert.match(card, new RegExp(`record\\.${fact}`), `${fact} must come from the durable run record`);
  }
  assert.match(card, /const tests = record\.tests \?\? testFactsFromSteps\(record\.steps\)/);
  assert.match(card, /typeof record\.usage\?\.costUsd === "number"/, "cost remains provider-reported only");
  assert.match(card, /className="runreceipt-toggle"/);
  assert.match(card, /aria-expanded=\{receiptOpen\}/);
  assert.match(card, /aria-controls=\{`run-receipt-\$\{record\.id\}`\}/);
  assert.match(card, /aria-label="Execution receipt details"/);
  assert.match(card, /record\.invocation\.permissionScope/);
  assert.match(card, /record\.steps/);
  assert.doesNotMatch(card, /thinking.*detail|detail.*thinking/i, "private reasoning must stay out of receipt facts");
  assert.match(css, /\.runreceipt-toggle/);
  assert.match(css, /@media \(max-width:560px\)[\s\S]*?\.runreceipt \.kv/,
    "receipt facts stack safely at narrow widths");
});

