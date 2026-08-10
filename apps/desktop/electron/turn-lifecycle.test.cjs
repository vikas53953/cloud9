const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("turn lifecycle only speaks from accepted public evidence", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import {
      TURN_LIFECYCLE_WORDS, taskForSourceMessage, turnLifecycleSentence, turnLifecycleState,
      turnLifecycleStoppable,
    } from "./apps/desktop/src/turnlifecycle.ts";

    assert.equal(turnLifecycleState({}), undefined,
      "an agent lamp or an empty render must not create a card");
    assert.equal(turnLifecycleState({ accepted: true }), "accepted");
    assert.equal(turnLifecycleState({ receipt: { stage: "reading" } }), "accepted");
    assert.equal(turnLifecycleState({ taskStatus: "not_started" }), "queued");
    assert.equal(turnLifecycleState({ receipt: { stage: "thinking" } }), "working");
    assert.equal(turnLifecycleState({ steps: [{ seq: 1, kind: "read", label: "Read note" }] }), "working");
    assert.equal(turnLifecycleState({ receipt: { stage: "verdict", verdict: "needsInput" } }), "waiting-user");
    assert.equal(turnLifecycleState({ receipt: { stage: "verdict", verdict: "agreed" } }), "completed");
    assert.equal(turnLifecycleState({ outcome: "ok" }), "completed");
    assert.equal(turnLifecycleState({ outcome: "failed" }), "failed");
    assert.equal(turnLifecycleState({ outcome: "cancelled" }), "cancelled");
    assert.equal(turnLifecycleState({ taskStatus: "cancelled", receipt: { stage: "thinking" } }), "cancelled");
    assert.equal(turnLifecycleState({ taskStatus: "failed", receipt: { stage: "thinking" } }), "failed");
    assert.equal(turnLifecycleState({ taskStatus: "completed", receipt: { stage: "thinking" } }), "completed");
    assert.equal(turnLifecycleState({ taskStatus: "working", receipt: { stage: "verdict", verdict: "conflict" } }), "failed",
      "a terminal receipt outranks a delayed task echo");
    assert.equal(turnLifecycleStoppable({ steps: [] }), false,
      "receipt/task-only evidence has no proven provider stop scope");
    assert.equal(turnLifecycleStoppable({ steps: [{ seq: 1, kind: "read", label: "Read note" }] }), true,
      "a public live step proves the turn crossed into stoppable provider work");
    assert.equal(turnLifecycleSentence("Scout", "waiting-user"), "Scout: Waiting for user");
    assert.deepEqual(Object.keys(TURN_LIFECYCLE_WORDS).sort(),
      ["accepted", "cancelled", "completed", "failed", "queued", "waiting-user", "working"]);

    const message = { id: "m1", channelId: "c1", authorId: "u1", authorKind: "human" };
    const task = { id: "t1", sourceMessageId: "m1", channelId: "c1", requesterId: "u1", agentId: "a1", title: "same", status: "working" };
    assert.strictEqual(taskForSourceMessage(message, [task], new Set(["a1"])), task);
    assert.equal(taskForSourceMessage(message, [task, { ...task, id: "t2" }], new Set(["a1"])), undefined,
      "duplicate source rows fail closed instead of choosing the first task");
    assert.equal(taskForSourceMessage(message, [task], new Set(["a2"])), undefined,
      "a task for an agent outside this channel must not render");
    assert.equal(taskForSourceMessage({ ...message, id: "other" }, [task], new Set(["a1"])), undefined);
  `;
  execFileSync(process.execPath, [
    "--experimental-strip-types", "--input-type=module", "-e", script,
  ], { cwd: path.join(__dirname, "..", "..", ".."), stdio: "pipe" });
});

test("ephemeral turn evidence is cleared when its access or session ends", () => {
  const root = path.join(__dirname, "..");
  const receipts = fs.readFileSync(path.join(root, "src", "receipts.tsx"), "utf8");
  const liveSteps = fs.readFileSync(path.join(root, "src", "livesteps.ts"), "utf8");
  const store = fs.readFileSync(path.join(root, "src", "store.ts"), "utf8");

  assert.match(receipts, /export function clearReceipts\(predicate\?:/);
  assert.match(liveSteps, /export function clearLiveSteps\(predicate\?:/);
  assert.match(store, /import \{ clearReceipts, noteReceipt \} from "\.\/receipts\.js"/);
  assert.match(store, /if \(!stillVisible\) \{[\s\S]*?clearAgentResponses\(row => row\.channelId === frame\.channel\.id\)/);
  assert.match(store, /case "userRemoved"[\s\S]*?clearAgentResponses\(row => removedAgentIds\.has\(row\.agentId\)\)/);
  assert.match(store, /clearLiveSteps\(row => row\.channelId === frame\.channel\.id\)/);
  assert.match(store, /clearLiveSteps\(row => row\.agentId === frame\.agentId\)/);
  assert.match(store, /case "channelLeft"[\s\S]*?clearReceipts\(row => row\.channelId === frame\.channelId\)/);
  assert.match(store, /case "agentDeleted"[\s\S]*?clearReceipts\(row => row\.agentId === frame\.agentId\)/);
  assert.match(store, /case "userRemoved"[\s\S]*?clearReceipts\(row => removedAgentIds\.has\(row\.agentId\)\)/);
  assert.match(store, /ws\.onclose = \(\) => \{[\s\S]*?clearReceipts\(\)/);
  assert.match(store, /case "welcome"[\s\S]*?clearReceipts\(\)/);
});

test("lifecycle cards fail closed to channel members, including agent removal while user stays", () => {
  const app = fs.readFileSync(path.join(__dirname, "..", "src", "App.tsx"), "utf8");
  const receipts = fs.readFileSync(path.join(__dirname, "..", "src", "receipts.tsx"), "utf8");
  const live = app.slice(app.indexOf("function LiveWork"), app.indexOf("function ResponsePreview"));
  const response = app.slice(app.indexOf("function ResponsePreview"), app.indexOf("function RunMark"));
  const store = fs.readFileSync(path.join(__dirname, "..", "src", "store.ts"), "utf8");
  const shared = fs.readFileSync(path.join(__dirname, "..", "..", "..", "packages", "shared", "src", "index.ts"), "utf8");
  const engine = fs.readFileSync(path.join(__dirname, "..", "..", "..", "packages", "engine", "src", "engine.ts"), "utf8");
  const relay = fs.readFileSync(path.join(__dirname, "..", "..", "..", "apps", "relay", "src", "server.ts"), "utf8");

  assert.match(live, /if \(!agents\.some\(agent => agent\.id === agentId\)\) return \[\]/);
  assert.match(live, /stoppable: turnLifecycleStoppable\(\{ steps: evidence\.steps \}\)/,
    "Stop capability must be derived from live-step evidence only");
  assert.match(live, /row\.stoppable/);
  assert.match(live, /text: `!stop \$\{row\.agentId\}`/,
    "Stop must route with the stable agent id, not a display name");
  assert.doesNotMatch(live, /text: `@\$\{name\} !stop`/,
    "spaces/emoji in display names must not change the command target");
  assert.doesNotMatch(live, /receipt\.stage === "thinking"/,
    "the early thinking receipt races stop-scope registration");
  assert.match(app, /agents=\{channelAgents\}/);
  assert.doesNotMatch(app, /me=\{world\.me\} agents=\{world\.agents\}/,
    "conversation MessageRow must not hand all workspace agents to inline activity surfaces");
  assert.doesNotMatch(live, /\?\.name \?\? "An agent"/);
  assert.match(receipts, /const visibleRows = rows\.filter\(row => agents\.some\(agent => agent\.id === row\.agentId\)\)/);
  assert.doesNotMatch(receipts, /\?\.name \?\? "An agent"/);
  assert.match(response, /\.filter\(preview => agents\.some\(agent => agent\.id === preview\.agentId\)\)/);
  assert.doesNotMatch(response, /\?\.name \?\? "An agent"/);
  assert.match(store, /const previousChannel = i >= 0 \? w\.channels\[i\] : undefined/);
  assert.match(store, /const removedAgentIds = new Set<ID>/);
  assert.match(store, /clearLiveSteps\(row => row\.channelId === frame\.channel\.id && removedAgentIds\.has\(row\.agentId\)\)/);
  assert.match(store, /clearReceipts\(row => row\.channelId === frame\.channel\.id && removedAgentIds\.has\(row\.agentId\)\)/);
  assert.match(store, /clearAgentResponses\(row => row\.channelId === frame\.channel\.id && removedAgentIds\.has\(row\.agentId\)\)/);
  assert.match(app, /const TURN_LIFECYCLE_LINGER_MS = 8_000/);
  assert.match(app, /setTimeout\(\(\) => setShown\(true\), 650\)/);
  assert.match(app, /aria-label="Agent turn activity"/);
  assert.match(app, /data-turn-state-label=\{row\.state\}/);
  assert.match(shared, /sourceMessageId\?: ID/);
  assert.match(engine, /type: "createTask"[\s\S]*?sourceMessageId: message\.id/);
  assert.match(relay, /sourceMessageId\?: ID/);
  assert.match(relay, /sourceMessageId: input\.sourceMessageId/);
});
