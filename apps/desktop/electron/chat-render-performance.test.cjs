const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const ts = require("typescript");

function renderComparator() {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  const start = source.indexOf("type MessageRowProps =");
  const end = source.indexOf("const MessageRow = React.memo", start);
  assert.ok(start >= 0 && end > start, "MessageRow comparator block must stay inspectable");
  const snippet = source.slice(start, end)
    + "\nthis.sameMessageRowPresence = sameMessageRowPresence;"
    + "\nthis.areMessageRowPropsEqual = areMessageRowPropsEqual;";
  const js = ts.transpileModule(snippet, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const context = {};
  vm.runInNewContext(js, context, { filename: "App.tsx:MessageRow comparator" });
  return context;
}

function row(overrides = {}) {
  return {
    m: { id: "m1" }, agents: [], users: [],
    ...overrides,
  };
}

test("MessageRow ignores presence ticks for agents outside the room", () => {
  const { sameMessageRowPresence, areMessageRowPropsEqual } = renderComparator();
  const message = { id: "m1" };
  const agents = [];
  const users = [];
  const before = row({ m: message, agents, users, presence: { outside: { agentId: "outside", status: "idle", presence: "ready", reason: "" } } });
  const after = row({ m: message, agents, users, presence: { outside: { agentId: "outside", status: "working", presence: "working", reason: "busy" } } });

  assert.equal(sameMessageRowPresence(before, after), true);
  assert.equal(areMessageRowPropsEqual(before, after), true);
});

test("MessageRow still redraws when a room agent's availability changes", () => {
  const { sameMessageRowPresence, areMessageRowPropsEqual } = renderComparator();
  const agent = { id: "room-agent" };
  const message = { id: "m1" };
  const users = [];
  const agents = [agent];
  const before = row({ m: message, agents, users, presence: { "room-agent": {
    agentId: "room-agent", status: "idle", presence: "ready", reason: "",
  } } });
  const after = row({ m: message, agents, users, presence: { "room-agent": {
    agentId: "room-agent", status: "working", presence: "working", reason: "busy",
  } } });

  assert.equal(sameMessageRowPresence(before, after), false);
  assert.equal(areMessageRowPropsEqual(before, after), false);
});
